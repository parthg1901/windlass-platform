/**
 * The inbox and the outbox of an item's agent session (Plans "software factory" §1.2, §2.2): how the
 * work item reaches its session, and how the session's turns reach the item. The session actor
 * (agent-session.ts) calls these; they own two tables of its SQLite.
 *
 * Inbox. A delivery (`deliver`, the item's `deliver` effect) is one row, keyed by the effect's key,
 * written in one statement before the item is answered: the same delivery sent again finds its row
 * and starts nothing. The row then waits for the user's turn queue (user-items.ts) to grant a running
 * slot; the grant names its slot, and the row keeps it. When the turn is taken, the row says so, with
 * the turn's number and the slot, in the same transaction as the session's meta and the turn's first
 * item in the timeline: an acknowledged message is never lost or taken twice by a stop.
 *
 * Outbox. What the item, or the user's actor, must hear of a turn is a row: that the turn started,
 * how it ended, and that its slot is free again. The row is written in the same transaction as what
 * it reports, and is sent until it is acknowledged, then removed: by the session as soon as it is
 * written, again on a schedule while the other side does not answer, and on every wake. The item
 * takes a fact once (its key), and the user's actor frees a slot once (its id), so a row sent twice
 * is harmless.
 */

import type { AgentAsk } from "../agent-publish.js";
import { ownsPath } from "../factory/feature-plan.js";
import { sources, UNTRUSTED_SOURCE_MAX } from "../factory/untrusted.js";
import type { TokenReceipt } from "../usage.js";
import type { RawAccess } from "rivetkit/db";
import type { RepositoryCheck, TurnOutcome, TurnUsage, Verified } from "../contract.js";
import { TURN_FIGURES, turnSpend, type TurnBudget, type TurnFigure } from "../factory/budget.js";
import type { AgentTurn } from "../factory/types.js";
import type { ItemReview } from "../contract.js";
import type { ReviewerTaskReport } from "../factory/reviewer-task.js";
import type { Fact, ReviewerInput } from "../factory/types.js";
import { readWork } from "../github/git.js";
import type { SandboxHandle } from "../sandbox/api.js";
import { workFlags } from "../verified.js";
import { itemActor, userActor, type ActorClient } from "./internal.js";
import { taskKind } from "../factory/readiness-track.js";
import { workType } from "../factory/usage-summary.js";
import type { ItemPublishAnswer } from "./work-item.js";

export const INBOX_TABLES = [
	// `state`: waiting (for a slot), started (its turn was taken), ended, withdrawn. `ended`: the fact the item was sent.
	`CREATE TABLE IF NOT EXISTS inbox (
		key TEXT PRIMARY KEY,
		item TEXT NOT NULL,
		title TEXT NOT NULL,
		text TEXT NOT NULL,
		agent TEXT,
		max_steps INTEGER NOT NULL,
		fetch_base TEXT,
		checkout TEXT,
		asks_left INTEGER,
		untrusted TEXT NOT NULL DEFAULT '[]',
		unsandboxed INTEGER NOT NULL DEFAULT 0,
		fresh TEXT,
		budget TEXT,
		starts_run INTEGER NOT NULL,
		state TEXT NOT NULL,
		turn INTEGER,
		slot TEXT,
		ended TEXT,
		at INTEGER NOT NULL
	)`,
	"CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL)",
	// What a push for the item answered, by the item's effect key: the same push asked again (its answer was lost) is answered from here.
	"CREATE TABLE IF NOT EXISTS publish_receipt (key TEXT PRIMARY KEY, answer TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS base_test (key TEXT PRIMARY KEY, result TEXT NOT NULL)",
	// The one schedule that sends the outbox again: replaced, never added to.
	"CREATE TABLE IF NOT EXISTS outbox_schedule (id INTEGER PRIMARY KEY CHECK (id = 1), schedule TEXT NOT NULL, at INTEGER NOT NULL)",
];

/** The action the outbox's schedule fires, which the session registers under this name (factory-e2e.ts checks it is). */
export const OUTBOX_ACTION = "internalOutbox";

/** What the item's `deliver` effect hands the session. */
export interface ReviewDelivery extends ReviewerInput {
	requested?: Pick<import("../contract.js").FeatureRepository, "repositoryId" | "installationId">;
	baseSha: string;
	report: ReviewerTaskReport | null;
}

export interface Delivery {
	checkout?: ReviewDelivery | null;
	key: string;
	itemId: string;
	/** The item's title, for the sentence of a wait ("… running (“Fix the light”)"). */
	title: string;
	text: string;
	agent: string | null;
	maxSteps: number;
	fetchBase: string | null;
	/** The first turn of a run: the review cap holds those back (factory/budget.ts `admit`). */
	startsRun: boolean;
	/**
	 * A builder's turn: how many questions its run may still ask the person (`ask_person`). Absent (null
	 * in the row) for every other turn, and for rows stored before the tool: those are not offered it.
	 */
	asksLeft?: number | null;
	/**
	 * Where the outside text in `text` came from (factory/untrusted.ts), each source in the person's words.
	 * Sent with the prompt so that Windlass taints the session from this turn on. Empty for a turn of the
	 * platform's and the person's own words, and for rows stored before it.
	 */
	untrusted?: string[];
	/**
	 * The person chose to run the text from someone else in `untrusted` anyway (`FactoryItem.unsandboxed`):
	 * on "Docker, hardened" the turn then goes labelled only instead of being refused.
	 */
	unsandboxed?: boolean;
	/**
	 * A builder's turn that goes on with its step: the prompt for when its agent no longer has the step's
	 * conversation (a new sandbox, a memory that was lost), which `text` assumes it has: the step's whole task, with
	 * the outside sources of that text and whether the person let them run (as `untrusted` and `unsandboxed` are
	 * for `text`). Absent (null in the row) for a step's first turn, which carries the task already, and for rows stored before it.
	 */
	fresh?: FreshPrompt | null;
	/**
	 * Where the turn is stopped while it runs, should it use up what its item has left (factory/budget.ts `turnBudget`,
	 * decided by the blueprint). Absent (null in the row) where nothing measurable holds the item, and for an interactive turn.
	 */
	budget?: TurnBudget | null;
}

export interface FreshPrompt {
	text: string;
	untrusted: string[];
	unsandboxed?: boolean;
}

export interface InboxRow extends Delivery {
	untrusted: string[];
	state: "waiting" | "started" | "ended" | "withdrawn";
	turn: number | null;
	slot: string | null;
}

/** An unanswered runner attach releases the slot and returns its delivery to the queue in the same transaction. */
export interface TurnRelease {
	sessionId: string;
	slot: string;
	key: string;
	machineWait?: { at: number; startsRun: boolean };
}

/** What the outbox sends: a fact to the item, or a slot given back to the user's turn queue. */
export type OutboxMessage =
	| { to: "network"; itemId: string; revision: number; network: import("../contract.js").BlockedNetwork }
	| { to: "tokens"; receipt: TokenReceipt }
	| { to: "item"; itemId: string; fact: Fact }
	| { to: "user"; done: Omit<TurnRelease, "sessionId"> };

/** What a slot request hands the user's turn queue (user-items.ts `internalRequestTurn`). */
export interface TurnRequest {
	sessionId: string;
	itemId: string;
	key: string;
	title: string;
	startsRun: boolean;
	/** Set when the sandbox layer refused the last try because the deployment runs as many as it may: that number (factory/budget.ts `PlaceNow`). */
	deploymentFull?: number | null;
	/** A paused turn that gave its slot back while its machine was away asks for one again: queued as of when it first started, ahead of the turns that came since. */
	resumeAt?: number;
}

/** The queue's answer: a slot, named, or why the turn waits (it is granted later, by `internalGrant`). */
export type TurnAnswer = { granted: true; slot: string } | { granted: false };

interface InboxCtx {
	db: RawAccess;
	key: string[];
	log: { warn(entry: unknown): void };
	client(): ActorClient;
	schedule: {
		at(timestamp: number, action: string, ...args: unknown[]): Promise<string>;
		cancel(id: string): Promise<boolean>;
	};
}

type Row = {
	key: string;
	item: string;
	title: string;
	text: string;
	agent: string | null;
	max_steps: number;
	fetch_base: string | null;
	checkout: string | null;
	asks_left: number | null;
	untrusted: string | null;
	unsandboxed: number | null;
	fresh: string | null;
	budget: string | null;
	starts_run: number;
	state: InboxRow["state"];
	turn: number | null;
	slot: string | null;
	ended: string | null;
};

function rowOf(row: Row): InboxRow {
	return {
		key: row.key,
		itemId: row.item,
		title: row.title,
		text: row.text,
		agent: row.agent,
		maxSteps: row.max_steps,
		fetchBase: row.fetch_base,
		checkout: row.checkout ? (JSON.parse(row.checkout) as ReviewDelivery) : null,
		asksLeft: row.asks_left,
		untrusted: untrustedOf(row.untrusted ? JSON.parse(row.untrusted) : []),
		unsandboxed: row.unsandboxed === 1,
		fresh: row.fresh ? freshOf(JSON.parse(row.fresh)) : null,
		budget: row.budget ? budgetOf(JSON.parse(row.budget)) : null,
		startsRun: row.starts_run === 1,
		state: row.state,
		turn: row.turn,
		slot: row.slot,
	};
}

const SELECT =
	"SELECT key, item, title, text, agent, max_steps, fetch_base, checkout, asks_left, untrusted, unsandboxed, fresh, budget, starts_run, state, turn, slot, ended FROM inbox";

/** The sources of a delivery or a row: strings, each kept to Windlass's length, at most a handful; anything else is none. */
export function untrustedOf(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return sources(
		value
			.filter((source): source is string => typeof source === "string")
			.map(source => source.slice(0, UNTRUSTED_SOURCE_MAX)),
	).slice(0, 8);
}

export async function inboxRow(db: RawAccess, key: string): Promise<InboxRow | null> {
	const [row] = await db.execute<Row>(`${SELECT} WHERE key = ?`, key);
	return row ? rowOf(row) : null;
}

/** The fact the item was sent when the turn of `key` ended; null while it has not. */
export async function endedFact(db: RawAccess, key: string): Promise<Fact | null> {
	const [row] = await db.execute<{ ended: string | null }>("SELECT ended FROM inbox WHERE key = ?", key);
	return row?.ended ? (JSON.parse(row.ended) as Fact) : null;
}

/** A delivery, checked; null for one that cannot be taken. */
export function deliveryOf(input: unknown): Delivery | null {
	const given = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
	const text = (value: unknown) => (typeof value === "string" ? value : null);
	const key = text(given.key);
	const itemId = text(given.itemId);
	const body = text(given.text);
	if (
		!key ||
		!itemId ||
		body === null ||
		(body.trim() === "" && !given.checkout) ||
		typeof given.maxSteps !== "number" ||
		!Number.isInteger(given.maxSteps) ||
		given.maxSteps < 1
	)
		return null;
	const checkout = given.checkout as ReviewDelivery | undefined;
	if (
		checkout &&
		(!/^[0-9a-f]{40}$/.test(checkout.head) ||
			!/^[0-9a-f]{40}$/.test(checkout.baseSha) ||
			!Number.isSafeInteger(checkout.pr) ||
			checkout.pr < 1)
	)
		return null;
	const asksLeft =
		typeof given.asksLeft === "number" && Number.isSafeInteger(given.asksLeft) && given.asksLeft >= 0
			? given.asksLeft
			: null;
	return {
		key,
		itemId,
		checkout,
		title: text(given.title) ?? "",
		text: body,
		agent: text(given.agent),
		maxSteps: given.maxSteps,
		fetchBase: text(given.fetchBase),
		startsRun: given.startsRun === true,
		asksLeft,
		untrusted: untrustedOf(given.untrusted),
		unsandboxed: given.unsandboxed === true,
		fresh: freshOf(given.fresh),
		budget: budgetOf(given.budget),
	};
}

/** A turn's budget of a delivery or a row, checked; null for none or one that cannot be taken. */
function budgetOf(value: unknown): TurnBudget | null {
	if (typeof value !== "object" || value === null) return null;
	const { figure, stopAt } = value as Record<string, unknown>;
	if (!TURN_FIGURES.includes(figure as TurnFigure)) return null;
	if (typeof stopAt !== "number" || !Number.isFinite(stopAt) || stopAt < 0) return null;
	return { figure: figure as TurnFigure, stopAt };
}

/** A whole-task prompt of a delivery or a row, checked; null for none or one that cannot be taken. */
function freshOf(value: unknown): FreshPrompt | null {
	if (typeof value !== "object" || value === null) return null;
	const given = value as Record<string, unknown>;
	if (typeof given.text !== "string" || given.text.trim() === "") return null;
	return {
		text: given.text,
		untrusted: untrustedOf(given.untrusted),
		...(given.unsandboxed === true && { unsandboxed: true }),
	};
}

/**
 * What an item's turn gives its agent: the row's text and its sources, or its whole-task prompt (`fresh`) when the
 * agent has no conversation to go on with (no session id to resume: a new sandbox, a memory that was lost).
 */
export function itemTurnText(
	row: Pick<InboxRow, "untrusted" | "unsandboxed" | "fresh">,
	text: string,
	resumed: string | null | undefined,
): { text: string; untrusted: string[]; unsandboxed?: boolean; fresh: boolean } {
	if (row.fresh && !resumed) return { ...row.fresh, fresh: true };
	return { text, untrusted: row.untrusted, unsandboxed: row.unsandboxed, fresh: false };
}

/** Writes the delivery's row, in one statement. False when a row of that key was there: the delivery came before. */
export async function receive(db: RawAccess, delivery: Delivery, now: number): Promise<boolean> {
	const before = await inboxRow(db, delivery.key);
	if (before) return false;
	await db.execute(
		"INSERT OR IGNORE INTO inbox (key, item, title, text, agent, max_steps, fetch_base, checkout, asks_left, untrusted, unsandboxed, fresh, budget, starts_run, state, turn, slot, ended, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', NULL, NULL, NULL, ?)",
		delivery.key,
		delivery.itemId,
		delivery.title,
		delivery.text,
		delivery.agent,
		delivery.maxSteps,
		delivery.fetchBase,
		delivery.checkout ? JSON.stringify(delivery.checkout) : null,
		delivery.asksLeft ?? null,
		JSON.stringify(delivery.untrusted ?? []),
		delivery.unsandboxed ? 1 : 0,
		delivery.fresh ? JSON.stringify(delivery.fresh) : null,
		delivery.budget ? JSON.stringify(delivery.budget) : null,
		delivery.startsRun ? 1 : 0,
		now,
	);
	return true;
}

/** Asks the user's turn queue for a slot for the row. A queue that does not answer leaves the request to be sent again (the item's check, or the next wake). */
export function requestTurn(
	c: InboxCtx,
	uid: string,
	row: InboxRow,
	deploymentFull: number | null = null,
	resumeAt?: number,
): Promise<TurnAnswer> {
	const request: TurnRequest = {
		sessionId: c.key[1] as string,
		itemId: row.itemId,
		key: row.key,
		title: row.title,
		startsRun: row.startsRun,
		deploymentFull,
		...(resumeAt !== undefined && { resumeAt }),
	};
	return userActor(c, uid).internalRequestTurn(request);
}

/** Puts a row back to waiting for a slot: its turn could not start (the deployment's sandboxes are all in use), and its slot is given back. */
export async function requeue(tx: RawAccess, key: string, slot: string): Promise<void> {
	await tx.execute(
		"UPDATE inbox SET state = 'waiting', turn = NULL, slot = NULL WHERE key = ? AND state = 'started'",
		key,
	);
	await queueMessage(tx, { to: "user", done: { slot, key } });
}

/** The session could not reach the runner before work began. Retrying or withdrawing the delivery and
 * returning its slot are one durable operation, including when removal raced the runner's attach. */
export async function machineUnavailable(
	tx: RawAccess,
	row: InboxRow,
	slot: string,
	reason: "offline" | "removed",
): Promise<void> {
	const state = reason === "removed" ? "withdrawn" : "waiting";
	const changed = await tx.execute(
		"UPDATE inbox SET state = ?, turn = NULL, slot = NULL WHERE key = ? AND (state = 'waiting' OR (state = 'started' AND slot = ?)) RETURNING key",
		state,
		row.key,
		slot,
	);
	const at = Date.now();
	if (reason === "removed" && changed.length)
		await queueMessage(tx, { to: "item", itemId: row.itemId, fact: { kind: "machine_removed", at } });
	const machineWait = reason === "offline" && changed.length ? { startsRun: row.startsRun, at } : undefined;
	await queueMessage(tx, { to: "user", done: { slot, key: row.key, machineWait } });
}

/**
 * The statements that take the row's turn, for the caller's transaction with the session's meta and
 * the turn's first timeline item: the row says which turn and which slot.
 */
export async function markTaken(tx: RawAccess, key: string, turn: number, slot: string): Promise<void> {
	await tx.execute(
		"UPDATE inbox SET state = 'started', turn = ?, slot = ? WHERE key = ? AND state = 'waiting'",
		turn,
		slot,
		key,
	);
}

/** The statements that end the row's turn, for the caller's transaction with the session's meta: the fact for the item, and the slot back to the queue. */
export async function markEnded(tx: RawAccess, row: InboxRow, fact: EndedFact): Promise<void> {
	await tx.execute("UPDATE inbox SET state = 'ended', ended = ? WHERE key = ?", JSON.stringify(fact), row.key);
	await queueMessage(tx, { to: "item", itemId: row.itemId, fact });
	if (row.slot) await queueMessage(tx, { to: "user", done: { slot: row.slot, key: row.key } });
}

/** A waiting row is withdrawn: true when it was waiting, so the queue's request goes too. */
export async function withdrawWaiting(db: RawAccess, key: string): Promise<boolean> {
	// Reserve an absent key first so a delivery arriving between the two statements cannot start it.
	await db.execute(
		"INSERT OR IGNORE INTO inbox (key, item, title, text, agent, max_steps, fetch_base, starts_run, state, turn, slot, ended, at) VALUES (?, '', '', '', NULL, 1, NULL, 0, 'withdrawn', NULL, NULL, NULL, ?)",
		key,
		Date.now(),
	);
	const rows = await db.execute(
		"UPDATE inbox SET state = 'withdrawn' WHERE key = ? AND state = 'waiting' RETURNING key",
		key,
	);
	return rows.length > 0;
}

/**
 * The answer a push for the item's effect `key` already had. A push that went through and whose answer
 * did not reach the item is asked for again under the same key: it is answered as it was then, and not
 * pushed again (which would find nothing new and be taken for a refusal).
 */
export async function publishReceipt(db: RawAccess, key: string): Promise<ItemPublishAnswer | null> {
	const [row] = await db.execute<{ answer: string }>("SELECT answer FROM publish_receipt WHERE key = ?", key);
	return row ? (JSON.parse(row.answer) as ItemPublishAnswer) : null;
}

/** Keeps the answer of a push that went through, under its effect's key. */
export async function rememberPublish(
	db: RawAccess,
	key: string,
	answer: Extract<ItemPublishAnswer, { kind: "published" }>,
): Promise<void> {
	await db.execute("INSERT OR REPLACE INTO publish_receipt (key, answer) VALUES (?, ?)", key, JSON.stringify(answer));
}

/** The deliveries that wait for a slot: asked for again when the session wakes, since a grant may have been lost with a server. */
export async function waitingRows(db: RawAccess): Promise<InboxRow[]> {
	return (await db.execute<Row>(`${SELECT} WHERE state = 'waiting' ORDER BY at`)).map(rowOf);
}

/** The row whose turn has this number, if one was taken from the inbox. */
export async function rowOfTurn(db: RawAccess, turn: number): Promise<InboxRow | null> {
	const [row] = await db.execute<Row>(`${SELECT} WHERE turn = ? AND state = 'started'`, turn);
	return row ? rowOf(row) : null;
}

export function queueMessage(tx: RawAccess, message: OutboxMessage): Promise<unknown> {
	return tx.execute("INSERT INTO outbox (message, attempts, next_at) VALUES (?, 0, 0)", JSON.stringify(message));
}

/** How soon a session wakes to send what it wrote to its outbox, should it be stopped before it could: the sending itself starts at once. */
const SAFETY_MS = 5_000;

/** After rows were written to the outbox: a durable schedule first, so that a session stopped by a deploy sends them when it is back; then the sending. */
export async function flushOutbox(
	c: InboxCtx & { keepAwake<T>(promise: Promise<T>): Promise<T> },
	uid: string,
): Promise<void> {
	await armOutbox(c, Date.now() + SAFETY_MS);
	void c.keepAwake(sendOutbox(c, uid));
}

/**
 * The outbox's one schedule, at `at` unless one is armed sooner: the one it replaces is cancelled. A
 * stored schedule whose time has passed is not armed: its firing may have been cut off after RivetKit
 * took it.
 */
async function armOutbox(c: InboxCtx, at: number): Promise<void> {
	const now = Date.now();
	const [held] = await c.db.execute<{ schedule: string; at: number }>(
		"SELECT schedule, at FROM outbox_schedule WHERE id = 1",
	);
	if (held && held.at > now && held.at <= at) return;
	const id = await c.schedule.at(Math.max(at, now), OUTBOX_ACTION);
	await c.db.execute(
		"INSERT OR REPLACE INTO outbox_schedule (id, schedule, at) VALUES (1, ?, ?)",
		id,
		Math.max(at, now),
	);
	if (held) await c.schedule.cancel(held.schedule).catch(() => false);
}

/** Settle prior spending before a new personal turn or session deletion, including receipts awaiting retry. */
export async function settleTokenReceipts(c: InboxCtx, uid: string): Promise<void> {
	const rows = await c.db.execute<{ id: number; message: string }>(
		"SELECT id, message FROM outbox WHERE json_extract(message, '$.to') = 'tokens' ORDER BY id",
	);
	for (const row of rows) {
		const { receipt } = JSON.parse(row.message) as { receipt: TokenReceipt };
		await userActor(c, uid).internalRecordTurnTokens({ sessionId: c.key[1]!, receipt });
		await c.db.execute("DELETE FROM outbox WHERE id = ?", row.id);
	}
}

const OUTBOX_RETRY_FIRST_MS = 10_000;
const OUTBOX_RETRY_MOST_MS = 5 * 60_000;

// Spending must settle before slot release. A turn end must also follow its network receipt,
// so an item publishing immediately can include the final counts even after a retry.
const sendable = `(json_extract(message, '$.to') = 'tokens' OR NOT EXISTS (
	SELECT 1 FROM outbox earlier WHERE earlier.id < outbox.id AND json_extract(earlier.message, '$.to') = 'tokens'))
	AND (json_extract(message, '$.to') <> 'item' OR NOT EXISTS (
	SELECT 1 FROM outbox earlier WHERE earlier.id < outbox.id AND json_extract(earlier.message, '$.to') = 'network'))`;

/**
 * Sends what is due in the outbox, oldest first; removes each once it was acknowledged, and sets the
 * session's one schedule (`armOutbox`) for what could not be sent. Never throws.
 */
export async function sendOutbox(c: InboxCtx, uid: string): Promise<void> {
	try {
		const now = Date.now();
		const rows = await c.db.execute<{ id: number; message: string; attempts: number }>(
			`SELECT id, message, attempts FROM outbox WHERE next_at <= ? AND ${sendable} ORDER BY id`,
			now,
		);
		for (const row of rows) {
			const message = JSON.parse(row.message) as OutboxMessage;
			try {
				if (message.to === "network")
					await itemActor(c, uid, message.itemId).internalBlockedNetwork({
						sessionId: c.key[1]!,
						revision: message.revision,
						network: message.network,
					});
				else if (message.to === "item") await itemActor(c, uid, message.itemId).internalFact(message.fact);
				else if (message.to === "tokens")
					await userActor(c, uid).internalRecordTurnTokens({ sessionId: c.key[1]!, receipt: message.receipt });
				else await userActor(c, uid).internalTurnDone({ sessionId: c.key[1] as string, ...message.done });
				await c.db.execute("DELETE FROM outbox WHERE id = ?", row.id);
			} catch (error) {
				const at = Date.now() + Math.min(OUTBOX_RETRY_MOST_MS, OUTBOX_RETRY_FIRST_MS * 2 ** Math.min(row.attempts, 10));
				await c.db.execute("UPDATE outbox SET attempts = attempts + 1, next_at = ? WHERE id = ?", at, row.id);
				c.log.warn({
					msg: "could not send a message of the outbox; it is sent again",
					to: message.to,
					error: String(error),
				});
			}
		}
		// After every drain, an empty one too: the schedule that fired, or the safety one, may be earlier than
		// any row still to send, and nothing else would set one for them.
		const [next] = await c.db.execute<{ at: number | null }>(`SELECT MIN(next_at) AS at FROM outbox WHERE ${sendable}`);
		if (next?.at !== null && next?.at !== undefined) await armOutbox(c, next.at);
	} catch (error) {
		c.log.warn({ msg: "could not send the outbox", error: String(error) });
	}
}

/** The observations on the turn's changes that a reviewer would want to look at (verified.ts), from git in the sandbox; none when git says nothing. */
export async function turnChanges(
	sandbox: SandboxHandle,
	baseSha: string | null,
	checks: ReadonlyArray<RepositoryCheck>,
	verified: Verified | null,
	owns?: string[],
) {
	const work = await readWork(sandbox, baseSha);
	if (!work) return { flags: [] };
	const paths = work.files.flatMap(f => (f.to ? [f.path, f.to] : [f.path]));
	return {
		taskKind: paths.length ? taskKind(paths) : undefined,
		workType: paths.length ? workType(paths) : undefined,
		flags: workFlags(
			work,
			[...checks, ...(verified?.run?.checks ?? [])],
			owns?.length ? path => ownsPath(owns, path) : undefined,
		),
	};
}

/** The fact of a turn's end, for the item. `hostedSeconds` is the ledger's, which the item reads from the user's actor. */
export function endedFactOf(
	key: string,
	at: number,
	outcome: TurnOutcome,
	verified: Verified | null,
	flags: Extract<Fact, { kind: "turn_ended" }>["flags"],
	changes: boolean,
	report: Extract<Fact, { kind: "turn_ended" }>["report"],
	usage: TurnUsage | null,
	agent?: AgentTurn,
	asked?: AgentAsk | null,
): Extract<Fact, { kind: "turn_ended" }> {
	return {
		kind: "turn_ended",
		at,
		key,
		outcome,
		verified,
		flags,
		changes,
		report,
		...(asked ? { asked } : {}),
		spend: turnSpend(usage, agent),
	};
}

export type EndedFact = Extract<Fact, { kind: "turn_ended" | "review_ended" }>;

export function reviewEndedFactOf(
	key: string,
	outcome: TurnOutcome,
	review: ItemReview | undefined,
	said: string | null,
	refused: string | null,
	usage: TurnUsage | null,
	agent?: AgentTurn,
): Extract<Fact, { kind: "review_ended" }> {
	return {
		kind: "review_ended",
		key,
		at: Date.now(),
		outcome,
		review: review?.id === key ? review : null,
		said,
		refused,
		spend: turnSpend(usage, agent),
	};
}
