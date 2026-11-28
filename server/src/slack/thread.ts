import type { RawAccess } from "rivetkit/db";
import { config } from "../config.js";
import type { ChoiceId, ItemQuestion, ItemView } from "../contract.js";
import type { SlackBinding } from "../factory/intake.js";
import { sourceCaps } from "../sources/registry.js";
import { resolution, type Resolution } from "../sources/updates.js";
import { escapeText, planPost, questionPost, resolvedMessage, type SlackMessage, type SlackPost } from "./blocks.js";

const messages = {
	started: "Work item filed",
	plan: "Plan ready for approval",
	question: "Question ready",
	pr: "Pull request opened",
	done: "Work item finished",
	failed: "Work item failed",
	cancelled: "Work item cancelled",
};
type Event = keyof typeof messages | "resolved";
export type SlackEffect = { kind: "slack_write"; key: string; event: Event; question?: string; line?: string };

// Answers said as what was done, like an approval: "Approved as one implementer by …".
const DONE: Partial<Record<ChoiceId, string>> = {
	run_single: "Approved as one implementer",
	orchestrate_anyway: "Asked to split into parts",
};

/** How a question closed, as mrkdwn. */
export function resolvedText(how: Resolution): string {
	if (how === "closed") return "This question is no longer open.";
	const done = how.approved ? "Approved" : how.picked && DONE[how.picked];
	const label = escapeText(how.choice ?? "");
	if (how.by !== "web") {
		const by = `<@${how.by.person}> in ${sourceCaps(how.by.source).displayName}`;
		return done ? `${done} by ${by}` : `Answered by ${by}: ${label}`;
	}
	return done ? `${done} on the web` : `Answered on the web: ${label}`;
}

/** How `question` closed by `fact`, as mrkdwn. A Slack press passes the presser's Slack user id, which the signature covers. */
export const resolvedLine = (question: ItemQuestion, fact: { kind: string }, slackUser?: string): string =>
	resolvedText(resolution(question, fact, slackUser ? { source: "slack", person: slackUser } : undefined));

// Separate from the versioned item snapshot: a concurrent blueprint commit cannot overwrite the root.
export const SLACK_RECEIPTS =
	"CREATE TABLE IF NOT EXISTS slack_receipts (key TEXT PRIMARY KEY, event TEXT NOT NULL, thread_ts TEXT)";
/** The message posted for each question, so that closing it can replace its buttons. */
export const SLACK_QUESTIONS =
	"CREATE TABLE IF NOT EXISTS slack_questions (question TEXT PRIMARY KEY, ts TEXT NOT NULL)";

type Page = Pick<ItemView, "question" | "plan">;
export interface SlackIo {
	post(message: SlackPost, thread: string | null): Promise<string>;
	update(ts: string, message: SlackMessage): Promise<void>;
	/** The item's page: its question with the choices the web offers now. */
	read(): Promise<Page>;
}

/** What to post for an event. A question that closed before its turn in the queue gets only the link line. */
export function postFor(itemId: string, page: Page | null, effect: SlackEffect, url: string): SlackPost {
	const line = { brief: { text: `${messages[effect.event as keyof typeof messages]}: ${url}` } };
	const question = page?.question;
	if (!question || question.id !== effect.question) return line;
	if (effect.event === "plan" && page.plan) return planPost(itemId, question, page.plan, url);
	if (effect.event === "question") return questionPost(itemId, question, url, page.plan);
	return line;
}

export async function performSlackWrite(
	db: Pick<RawAccess, "execute">,
	destination: Pick<SlackBinding, "threadTs">,
	itemId: string,
	effect: SlackEffect,
	io: SlackIo,
): Promise<void> {
	if ((await db.execute("SELECT 1 FROM slack_receipts WHERE key=?", effect.key)).length) return;
	let threadTs = destination.threadTs;
	if (effect.event !== "started") {
		const [receipt] = await db.execute<{ thread_ts: string | null }>(
			"SELECT thread_ts FROM slack_receipts WHERE event='started'",
		);
		if (!receipt) throw new Error("Slack acknowledgement pending");
		if (!receipt.thread_ts) return; // The original mapping was already unavailable at acknowledgement.
		threadTs = receipt.thread_ts;
	}
	const url = `${config.origins[0]}/items/${itemId}`;
	try {
		if (effect.event === "resolved") {
			const [posted] = await db.execute<{ ts: string }>(
				"SELECT ts FROM slack_questions WHERE question=?",
				effect.question,
			);
			if (posted) await io.update(posted.ts, resolvedMessage(effect.line!, url));
		} else {
			const post = postFor(itemId, effect.question ? await io.read() : null, effect, url);
			const ts = await io.post(post, threadTs);
			if (effect.question) await db.execute("INSERT OR IGNORE INTO slack_questions VALUES(?,?)", effect.question, ts);
			threadTs ??= ts;
		}
	} catch (error) {
		if ((error as { code?: string } | null)?.code !== "slack_unavailable") throw error;
		if (effect.event === "started") threadTs = null;
	}
	await db.execute("INSERT OR IGNORE INTO slack_receipts VALUES(?,?,?)", effect.key, effect.event, threadTs);
}
