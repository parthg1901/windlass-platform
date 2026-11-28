import type { RawAccess } from "rivetkit/db";
import { describeError } from "../../auth.js";
import type { AcpUpdate, LiveDelta, TimelineItem, WindlassEvent } from "../../contract.js";
import type { ModelKeySpend } from "../../contract.js";
import { OutgoingJournal, saveCheckpoint, saveReceived } from "../../runner/journal.js";
import { turnTokens } from "../../factory/budget.js";
import { reportedModelUsage, usesPlatformModel } from "../../usage.js";
import { ACP_ITEM_LIMIT, boundedAcpItem, jsonPrefix } from "../acp-item.js";
import { flushOutbox, queueMessage, sendOutbox } from "../session-inbox.js";
import type { Ctx, SessionMeta, NewItem, SessionVars } from "./state.js";

/** Timeline rows per INSERT statement. */
const WRITE_BATCH = 100;
/** Items wait at most this long before they are written, or until this many have gathered. */
const FLUSH_DELAY_MS = 400;
const FLUSH_AT = 200;
/** The most streaming deltas kept for late joiners; the oldest go first. */
const MAX_PENDING = 5_000;

const DELTA_TYPES = new Set(["text.delta", "reasoning.delta", "tool.input.delta", "tool.progress"]);

/** How often a turn that can be taken up after a crash re-arms the wake that would take it up. */
const TAKE_UP_ARM_MS = 60_000;

/** The runner conversation has something to store: frames to write ahead, or more received than committed. */
export function conversationDirty(c: Ctx): void {
	const journal = (c.vars.journal ??= new OutgoingJournal(
		c.db,
		() => c.vars.runner?.channel ?? null,
		() => {
			// What was received is committed with the timeline it produced: a write comes soon, items or not.
			const channel = c.vars.runner?.channel;
			if (channel && channel.receivedCount > 0) scheduleWrite(c);
		},
	));
	journal.dirty();
}

// Re-arm during a durable turn because a crash skips onSleep.
function armTakeUp(c: Ctx): void {
	const now = Date.now();
	if (c.vars.stopping || now - c.vars.takeUpArmedAt < TAKE_UP_ARM_MS / 2) return;
	c.vars.takeUpArmedAt = now;
	void c.schedule.at(now + TAKE_UP_ARM_MS, "internalTakeUp").catch((error: unknown) =>
		c.log.warn({
			msg: "could not schedule the wake that takes a machine turn up after a crash",
			error: describeError(error),
		}),
	);
}

// Session actions interleave at await. A failed write must not block the next queued job.
export function serial<T>(c: Ctx, job: () => Promise<T>): Promise<T> {
	const run = c.vars.serial.then(job, job);
	c.vars.serial = run.catch(() => undefined);
	return run;
}

export function writeMeta(c: Ctx, meta: SessionMeta) {
	return serial(c, () => c.db.execute("UPDATE meta SET data = ? WHERE id = 1", JSON.stringify(meta)));
}

export async function insertItems(db: Pick<RawAccess, "execute">, batch: TimelineItem[]): Promise<void> {
	await db.execute(
		`INSERT OR REPLACE INTO timeline (seq, turn, kind, at, item) VALUES ${batch.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
		...batch.flatMap(item => [item.seq, item.turn, item.kind, item.at, JSON.stringify(item)]),
	);
}

function turnReceipts(meta: SessionMeta | null, batch: TimelineItem[]) {
	return batch.flatMap(item => {
		const key =
			item.kind === "turn.ended" || item.kind === "platform" || item.kind === "windlass" ? item.modelKey : undefined;
		const tokens =
			key?.tokens ??
			(meta && item.kind === "windlass" && usesPlatformModel(meta.harness)
				? turnTokens(reportedModelUsage(item.event))
				: 0);
		return Number.isSafeInteger(tokens) && tokens > 0 ? [{ seq: item.seq, at: item.at, tokens, key }] : [];
	});
}

// Timeline rows and their outbox receipts must commit together, including on replay.
async function writeBatch(
	tx: RawAccess,
	batch: TimelineItem[],
	meta: SessionMeta | null,
	receipts: ReturnType<typeof turnReceipts>,
	network: SessionMeta["blocked"],
) {
	await insertItems(tx, batch);
	for (const receipt of receipts) await queueMessage(tx, { to: "tokens", receipt });
	if (network && meta) {
		await tx.execute("UPDATE meta SET data = ? WHERE id = 1", JSON.stringify(meta));
		if (meta.origin) await queueMessage(tx, { to: "network", itemId: meta.origin.itemId, ...network });
	}
}

/** Writes the waiting items, a batch per statement. Only ever called from inside the queue. */
export async function writeItems(c: Ctx): Promise<void> {
	if (c.vars.runner?.durable) return writeDurably(c);
	const waiting = c.vars.unwritten;
	while (waiting.length > 0) {
		const batch = waiting.slice(0, WRITE_BATCH);
		const meta = c.vars.meta;
		const receipts = turnReceipts(meta, batch);
		const network = batch.some(item => item.kind === "network.blocked") ? meta?.blocked : undefined;
		if (receipts.length || network) {
			// Queue usage with its original UTC day and sequence for idempotent retries.
			await c.db.transaction(tx => writeBatch(tx, batch, meta, receipts, network), { name: "timeline.usage" });
			if (!c.vars.stopping && (receipts.length || meta?.origin))
				await flushOutbox(c, meta!.uid).catch(() => sendOutbox(c, meta!.uid));
		} else await insertItems(c.db, batch);
		// Items made meanwhile were added behind the batch.
		waiting.splice(0, batch.length);
	}
}

// Commit the timeline, received count and checkpoint together before acknowledging the runner.
async function writeDurably(c: Ctx): Promise<void> {
	const channel = c.vars.runner!.channel;
	const waiting = c.vars.unwritten;
	// From here to the transaction nothing is awaited: the count, the items and the checkpoint say the same moment.
	const conversation = channel.conversationId;
	const received = channel.receivedCount;
	const turn = c.vars.turn;
	const checkpoint = turn?.checkpoint?.() ?? null;
	const items = waiting.slice();
	const meta = c.vars.meta;
	let flush = false;
	let stored = false;
	await c.db.transaction(
		async tx => {
			for (let at = 0; at < items.length; at += WRITE_BATCH) {
				const batch = items.slice(at, at + WRITE_BATCH);
				const receipts = turnReceipts(meta, batch);
				const network = batch.some(item => item.kind === "network.blocked") ? meta?.blocked : undefined;
				await writeBatch(tx, batch, meta, receipts, network);
				if (receipts.length || (network && meta?.origin)) flush = true;
			}
			// While a process waits to be taken up, the output kept for it is in no item yet: nothing of it counts as stored.
			if (c.vars.runner?.holding) return;
			stored = await saveReceived(tx, conversation, received);
			// A checkpoint goes with the timeline of its moment; none (the turn is not one to take up) takes the old one out.
			await saveCheckpoint(tx, turn?.number ?? 0, checkpoint);
		},
		{ name: "timeline.durable" },
	);
	waiting.splice(0, items.length);
	if (stored) channel.committed(conversation, received);
	if (checkpoint) armTakeUp(c);
	if (flush && !c.vars.stopping) await flushOutbox(c, meta!.uid).catch(() => sendOutbox(c, meta!.uid));
}

/** Brings SQLite up to date with memory: the waiting items and the meta row. Never throws. */
export function persist(c: Ctx): Promise<void> {
	if (c.vars.flushTimer) {
		clearTimeout(c.vars.flushTimer);
		c.vars.flushTimer = null;
	}
	return serial(c, async () => {
		await writeItems(c);
		// A shutdown checkpoint occupies the next seq provisionally. The next real item replaces it.
		const partial = c.vars.turn?.stopping && c.vars.turn.openAcp?.();
		if (partial) await insertItems(c.db, [numberItem(c, partial)]);
		if (c.vars.meta) await c.db.execute("UPDATE meta SET data = ? WHERE id = 1", JSON.stringify(c.vars.meta));
	}).catch(error => {
		// The items stay in `unwritten`, so the next write tries again and snapshots still show them.
		c.log.error({ msg: "could not write the session to SQLite", error: describeError(error) });
	});
}

function queueWrite(c: Ctx): void {
	if (c.vars.flushQueued) return;
	c.vars.flushQueued = true;
	void serial(c, async () => {
		c.vars.flushQueued = false;
		await writeItems(c);
	}).catch(error => {
		c.log.error({ msg: "could not write the timeline to SQLite", error: describeError(error) });
	});
}

// An empty batch can still carry the durable runner checkpoint.
function scheduleWrite(c: Ctx): void {
	if (c.vars.flushQueued) return;
	if (c.vars.unwritten.length >= FLUSH_AT) {
		queueWrite(c);
		return;
	}
	if (c.vars.flushTimer) return;
	c.vars.flushTimer = setTimeout(() => {
		c.vars.flushTimer = null;
		queueWrite(c);
	}, FLUSH_DELAY_MS);
}

function numberItem(c: Ctx, item: NewItem, at = Date.now()): TimelineItem {
	// Network observations scrub their free text before aggregation. Keep protocol enum values intact.
	const redactor = c.vars.turn?.secrets?.redactor;
	const numbered = {
		...(redactor && item.kind !== "network.blocked" ? redactor.deep(item) : item),
		seq: c.vars.nextSeq,
		at,
	} as TimelineItem;
	return numbered.kind === "acp" ? boundedAcpItem(numbered) : numbered;
}

// Assign seq and redact before broadcasting or queuing a write. No await may split these steps.
export function append(c: Ctx, item: NewItem, at?: number): TimelineItem {
	const full = numberItem(c, item, at);
	c.vars.nextSeq += 1;
	c.vars.unwritten.push(full);
	c.broadcast("item", full);
	scheduleWrite(c);
	return full;
}

export function note(
	c: Ctx,
	turn: number,
	level: "info" | "warn" | "error",
	text: string,
	mark:
		| { code: "question_expired" | "question_allowed"; call: { messageId: string; callId: string } }
		| { code: "turn_paused" | "turn_resumed"; modelKey?: ModelKeySpend }
		| null = null,
): void {
	append(c, { turn, kind: "platform", level, text, ...(mark ?? {}) });
}

export function keepDelta(vars: SessionVars, delta: LiveDelta): void {
	vars.pending.push(delta);
	if (vars.pending.length > MAX_PENDING) vars.pending.splice(0, vars.pending.length - MAX_PENDING + 500);
}

// Drop buffered deltas once their durable event supersedes them.
function settleDeltas(vars: SessionVars, durable: WindlassEvent): void {
	if (vars.pending.length === 0) return;
	const data = durable.data ?? {};
	const messageId = data.messageId;
	const callId = data.callId;
	let redundant: (event: WindlassEvent) => boolean;
	switch (durable.type) {
		case "text.ended":
			redundant = event => event.type === "text.delta" && event.messageId === messageId;
			break;
		case "reasoning.ended":
			redundant = event => event.type === "reasoning.delta" && event.messageId === messageId;
			break;
		case "tool.called":
			redundant = event =>
				event.type === "tool.input.delta" && event.messageId === messageId && event.callId === callId;
			break;
		case "tool.settled":
			redundant = event =>
				(event.type === "tool.progress" || event.type === "tool.input.delta") &&
				event.messageId === messageId &&
				event.callId === callId;
			break;
		case "step.ended":
		case "step.failed":
			redundant = event => event.messageId === messageId;
			break;
		case "execution.succeeded":
		case "execution.failed":
		case "execution.interrupted":
			redundant = () => true;
			break;
		default:
			return;
	}
	vars.pending = vars.pending.filter(delta => !("event" in delta && redundant(delta.event)));
}

/** One durable item per contiguous run of text; a reconnect sees the same prefix as live clients. */
export function acpRecorder(c: Ctx, turn: number) {
	type TextKind = "agent_message_chunk" | "agent_thought_chunk";
	let run: { kind: TextKind; key: string; text: string; remaining: number; truncated: boolean } | null = null;
	let items = 0;
	let warned = false;
	function admit(): boolean {
		if (items < MAX_PENDING) {
			items++;
			return true;
		}
		if (!warned)
			note(
				c,
				turn,
				"warn",
				`Further ACP updates were omitted after ${MAX_PENDING.toLocaleString("en-US")} timeline items in this turn.`,
			);
		warned = true;
		return false;
	}
	function textUpdate(kind: TextKind, text: string): AcpUpdate {
		return { sessionUpdate: kind, content: { type: "text", text } };
	}
	function current(): NewItem | null {
		if (!run) return null;
		return {
			turn,
			kind: "acp",
			messageKey: run.key,
			update: textUpdate(run.kind, run.text),
			...(run.truncated && { truncated: true }),
		};
	}
	if (c.vars.turn) c.vars.turn.openAcp = current;
	function flush() {
		const item = current();
		if (!run || !item) return;
		const { key } = run;
		run = null;
		c.vars.pending = c.vars.pending.filter(delta => !("acp" in delta && delta.messageKey === key));
		append(c, item);
	}
	return {
		flush,
		update(update: AcpUpdate) {
			const kind = update.sessionUpdate;
			if (
				(kind === "agent_message_chunk" || kind === "agent_thought_chunk") &&
				update.content?.type === "text" &&
				typeof update.content.text === "string"
			) {
				if (run?.kind !== kind) {
					flush();
					if (!admit()) return;
					const key = `acp-${turn}-${c.vars.nextSeq}`;
					// Other timeline events can advance seq before flush. Reserve both numbers and the marker now.
					const envelope = {
						turn,
						kind: "acp",
						messageKey: key,
						update: textUpdate(kind, ""),
						seq: Number.MAX_SAFE_INTEGER,
						at: Number.MAX_SAFE_INTEGER,
						truncated: true,
					};
					run = { kind, key, text: "", remaining: ACP_ITEM_LIMIT - JSON.stringify(envelope).length, truncated: false };
				}
				if (run.truncated) return;
				const piece = jsonPrefix(update.content.text, run.remaining);
				run.truncated = piece.text.length < update.content.text.length;
				if (!piece.text) return;
				run.remaining -= piece.size;
				run.text += piece.text;
				c.broadcast("delta", { turn, acp: textUpdate(kind, piece.text), messageKey: run.key });
				const pending = { turn, messageKey: run.key, acp: textUpdate(kind, run.text) };
				const last = c.vars.pending.at(-1);
				if (last && "acp" in last && last.messageKey === run.key) c.vars.pending[c.vars.pending.length - 1] = pending;
				else keepDelta(c.vars, pending);
				return;
			}
			flush();
			if (admit()) append(c, { turn, kind: "acp", update });
		},
	};
}

export function onWindlassEvent(
	c: Ctx,
	meta: SessionMeta,
	turn: number,
	event: WindlassEvent,
	key?: import("../../contract.js").CredentialRef,
): void {
	if (typeof event !== "object" || event === null || typeof event.type !== "string") return;
	if (typeof event.sessionId === "string" && event.sessionId !== "" && meta.windlassSessionId !== event.sessionId) {
		// Remembered at once: if this turn is lost, the next one can still continue Windlass's session.
		meta.windlassSessionId = event.sessionId;
		// Another session of Windlass's: nothing is recorded in it yet.
	}
	if (DELTA_TYPES.has(event.type)) {
		const delta: LiveDelta = { turn, event };
		keepDelta(c.vars, delta);
		c.broadcast("delta", delta);
		return;
	}
	settleDeltas(c.vars, event);
	const tokens = key && turnTokens(reportedModelUsage(event, true));
	append(c, { turn, kind: "windlass", event, ...(key && tokens && { modelKey: { ...key, tokens } }) });
}
