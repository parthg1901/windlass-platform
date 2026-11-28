/**
 * Each source's rendering of the item-update stream (updates.ts) as the item's effects: the rows the item's outbox
 * performs, with the same kinds, keys and row ids each source has always had.
 */

import { randomUUID } from "node:crypto";
import type { JiraCommentAction } from "../factory/intake.js";
import type { FactoryItem } from "../factory/types.js";
import type { LinearWrite } from "../linear/app.js";
import { resolvedText, type SlackEffect } from "../slack/thread.js";
import { bindingsOf, type StoredBindings } from "./bindings.js";
import type { BindingOf, SourceId } from "./types.js";
import { isEndedState, type ItemUpdate } from "./updates.js";

export type LinearEffect = { kind: "linear_write" } & LinearWrite;
export type JiraEffect = { kind: "jira_comment" } & JiraCommentAction;
/** A code-host issue: the 👀 on the trigger, the one marked comment, and registering an issue again when its failed item runs again. */
export type IssueEffect =
	| { kind: "feedback_ack"; key: string }
	| { kind: "issue_comment"; key: string; revision: number }
	| { kind: "register_issue"; key: string };
export type SourceEffect = LinearEffect | JiraEffect | SlackEffect | IssueEffect;

/** What every renderer reads besides the updates: the item after them and its page. */
interface Rendering {
	updates: readonly ItemUpdate[];
	next: FactoryItem;
	url: string;
}

/** Upserts the one comment on the issue whenever the pull request or whether the item has ended changes. */
function issueEffects({ updates, next }: Rendering, reactionTarget: string | undefined, issueGone: boolean) {
	const effects: IssueEffect[] = [];
	const filed = updates.some(update => update.kind === "filed");
	if (filed && reactionTarget) effects.push({ kind: "feedback_ack", key: reactionTarget });
	const changed = updates.some(
		update =>
			update.kind === "pr" ||
			update.kind === "reopened" ||
			((update.kind === "done" || update.kind === "failed" || update.kind === "cancelled") &&
				!isEndedState(update.from ?? undefined)),
	);
	if (filed || (changed && !issueGone)) effects.push({ kind: "issue_comment", key: "link", revision: next.revision });
	if (updates.some(update => update.kind === "reopened" && update.from === "failed"))
		effects.push({ kind: "register_issue", key: String(next.revision) });
	return effects;
}

/** Comments, the pull request's attachment and status moves (performed in linear/app.ts, never backwards). */
function linearEffects({ updates, next, url }: Rendering): LinearEffect[] {
	const writes: LinearWrite[] = [];
	const pr = next.pr?.url ?? null;
	const comment = (key: Extract<LinearWrite, { pr: string | null; commentId: string }>["key"]) =>
		writes.push({ key, commentId: randomUUID(), pr });
	for (const update of updates) {
		if (update.kind === "started") writes.push({ key: "start" });
		else if (update.kind === "question" || update.kind === "plan")
			writes.push({
				key: "owner_needed",
				questionId: update.question,
				commentId: randomUUID(),
				itemUrl: url,
				plan: update.kind === "plan",
			});
		else if (update.kind === "pr" && update.first && pr) {
			comment("opened");
			writes.push({ key: "attachment", pr }, { key: "review_opened" });
		} else if (update.kind === "handed_over") {
			comment("handed over");
			writes.push({ key: "review_handover" });
		} else if (update.kind === "done") {
			comment("merged");
			writes.push({ key: "complete" });
		} else if (update.kind === "failed" || update.kind === "cancelled") comment(update.kind);
	}
	return writes.map(write => ({ kind: "linear_write", ...write }));
}

/** One comment for filing, the first pull request and the end. */
function jiraEffects({ updates, next, url }: Rendering): JiraEffect[] {
	const pr = next.pr?.url;
	const effects: JiraEffect[] = [];
	for (const update of updates) {
		if (update.kind === "filed") effects.push({ kind: "jira_comment", key: "filed", itemUrl: url });
		else if (update.kind === "pr" && update.first && pr)
			effects.push({ kind: "jira_comment", key: "opened", itemUrl: url, pr });
		else if (update.kind === "done" || update.kind === "failed" || update.kind === "cancelled")
			effects.push({ kind: "jira_comment", key: update.kind, itemUrl: url, pr });
	}
	return effects;
}

/** Posts in the item's thread: its root, plans and questions (edited once they close), the pull request and the end. */
function slackEffects({ updates, next }: Rendering): SlackEffect[] {
	const effects: SlackEffect[] = [];
	const add = (event: SlackEffect["event"], identity = "", extra: Partial<SlackEffect> = {}) =>
		effects.push({ kind: "slack_write", event, key: [next.id, event, identity].join(":"), ...extra });
	for (const update of updates) {
		if (update.kind === "filed") add("started");
		else if (update.kind === "question_resolved")
			add("resolved", update.question, { question: update.question, line: resolvedText(update.how) });
		else if (update.kind === "question" || update.kind === "plan")
			add(update.kind, update.question, { question: update.question });
		else if (update.kind === "pr" && update.pr) add("pr", String(update.pr.number));
		else if (update.kind === "done" || update.kind === "failed" || update.kind === "cancelled")
			add(update.kind, String(next.revision));
	}
	return effects;
}

/**
 * The effects of `updates` for the sources an item is bound to. `url` is the item's page; `issueGone` that the
 * code-host issue was deleted, so its comment is not upserted again.
 */
export function sourceEffects(
	meta: StoredBindings,
	updates: readonly ItemUpdate[],
	next: FactoryItem,
	{ url, issueGone = false }: { url: string; issueGone?: boolean },
): SourceEffect[] {
	const rendering = { updates, next, url };
	return bindingsOf(meta).flatMap(binding => render(binding.ref.source, rendering, binding, issueGone));
}

const render = <S extends SourceId>(source: S, rendering: Rendering, binding: BindingOf<S>, issueGone: boolean) =>
	RENDERERS[source](rendering, binding, issueGone);

const RENDERERS: {
	[S in SourceId]: (rendering: Rendering, binding: BindingOf<S>, issueGone: boolean) => SourceEffect[];
} = {
	github: (rendering, binding, issueGone) => issueEffects(rendering, binding.extra.reactionTarget, issueGone),
	/** GitLab items post nothing back yet. */
	gitlab: () => [],
	linear: linearEffects,
	jira: jiraEffects,
	slack: slackEffects,
};
