/**
 * The ACP folder: what a harness spoken to through the Agent Client Protocol (Claude Code) sent, folded
 * into the blocks the platform already draws for Windlass. The timeline reducer calls it for each
 * `acp` item and each live ACP delta (timeline.ts, `applyItem` and `applyDelta`).
 *
 * - Text and reasoning arrive as chunks, broadcast live under a `messageKey`, and then once more as one
 *   stored item per run of chunks, with the whole text and the same key. The stored item replaces what
 *   the chunks built, so nothing is shown twice. A snapshot's pending delta holds the run so far.
 * - A tool call (`tool_call`, then `tool_call_update`s that each say only what changed) is one tool
 *   block, keyed by its `toolCallId` under the message id `ACP_MESSAGE`, which is also what the platform
 *   puts on a question about that call. A diff it carries is shown as the diff of the call.
 * - A plan is one checklist per turn, replaced in place by each `plan` update; an empty one removes it.
 * - `usage_update` says how full the context is, and the cost so far when the harness knows it.
 * - Anything else (the commands and modes it offers, its config options, a title, an update kind this
 *   folder has never heard of) changes nothing that is shown.
 *
 * Pure: nothing here touches the DOM, the clock or the network.
 */
import {
	HARNESS_IDS,
	type AcpContext,
	type AcpUpdate,
	type HarnessId,
	type MachineSummary,
	type ModelList,
	type SessionSummary,
} from "@contract";
import type {
	Block,
	PlanEntry,
	ReasoningBlock,
	SessionView,
	TextBlock,
	ToolBlock,
	ToolState,
	TurnView,
} from "./timeline";
import { cleanModelName } from "./models";
import { harnessName } from "../../../server/src/sandbox/harnesses.js";

/** The message id of every ACP tool call: the platform names an ACP question's call this way too. */
export const ACP_MESSAGE = "acp";

/** Each harness by the name the screens give it: the server's, from its record (`harnessName`). */
export const HARNESS_NAMES: Record<HarnessId, string> = Object.fromEntries(
	HARNESS_IDS.map(id => [id, harnessName(id)]),
) as Record<HarnessId, string>;

/** The order the screens list the harnesses in. */
export const HARNESS_DISPLAY_ORDER: readonly HarnessId[] = ["windlass", "claude", "codex", "opencode"];

/** The same order without Windlass: the agents a place has to offer before they can be chosen. */
export const MACHINE_HARNESS_ORDER = HARNESS_DISPLAY_ORDER.filter(
	(id): id is Exclude<HarnessId, "windlass"> => id !== "windlass",
);

/** The name of the harness a session runs when it is not Windlass, which it is when the summary names none; null for Windlass. */
export function acpHarnessName(summary: Pick<SessionSummary, "harness">): string | null {
	return summary.harness === undefined || summary.harness === "windlass" ? null : HARNESS_NAMES[summary.harness];
}

/** The models an ACP harness offered the session, or before its first turn its own default only (server/src/sandbox/harnesses.ts). */
export function harnessModelsOf(summary: Pick<SessionSummary, "harnessModels">): ModelList {
	return (
		summary.harnessModels ?? {
			source: "harness",
			defaultModel: "default",
			models: [{ id: "default", name: null, efforts: [] }],
			fetchedAt: null,
		}
	);
}

/** The session's model in a few words for its panel: an ACP harness's model by the name the harness gave it ("Fable 5.2", not "fable"), its unnamed default as "Claude Code's default"; Windlass's by its readable model name. */
export function sessionModelWords(summary: Pick<SessionSummary, "harness" | "harnessModels" | "model">): string {
	const harness = acpHarnessName(summary);
	if (!harness) return cleanModelName(summary.model);
	const name = summary.harnessModels?.models.find(model => model.id === summary.model)?.name;
	return !name && summary.model === "default" ? `${harness}'s default` : cleanModelName(summary.model, name);
}

/** A harness a machine's runner reported, as `MachineSummary.harnesses` lists it. */
export type ReportedHarness = NonNullable<MachineSummary["harnesses"]>[number];

// The same words on every page. "unknown" is a runner that could not check: the agent may well run, so it is never said to be unable to.
/** Its sign-in in a few words: "signed in", "sign in needed", "couldn't check the sign-in"; for an agent the account pays for (`paysWith`), what pays. */
export function signInWords(harness: ReportedHarness): string {
	if (harness.paysWith && harness.signIn !== "unknown") {
		if (harness.signIn === "none") return "no plan or key connected";
		return harness.method === "api-key" ? "your API key" : "your plan";
	}
	// Signed in there, it uses its own sign-in first; a key only where that is all it has.
	if (harness.platformKeys?.length && !harness.machineSignIns?.length) return "your API key";
	return harness.signIn === "token"
		? "signed in"
		: harness.signIn === "none"
			? "sign in needed"
			: "couldn't check the sign-in";
}

/**
 * The command that signs a harness in on its machine, run inside the runner's container: only OpenCode keeps logins of
 * its own there. Claude Code and Codex pay with the account's plans and keys (Connections → Pay with).
 */
export const loginCommand = (harness: ReportedHarness): string | null =>
	harness.id === "opencode" ? `docker exec -it windlass-runner windlass-runner login ${harness.id}` : null;

type NewBlock<B extends Block = Block> = B extends Block ? Omit<B, "id"> : never;

/** The part of the reducer's draft the folder uses. */
export interface AcpDraft {
	view: SessionView;
	set(patch: Partial<SessionView>): void;
	turn(number: number): TurnView;
	push(number: number, block: NewBlock): void;
	find<B extends Block>(number: number, match: (block: Block) => block is B): B | undefined;
	replace<B extends Block>(number: number, block: B, patch: Partial<B>): void;
	remove(number: number, block: Block): void;
}

/** A new tool block, as the reducer makes one (`newTool` in timeline.ts). */
export type ToolMaker = (messageId: string, callId: string, name: string, at: number | null) => NewBlock<ToolBlock>;

/**
 * Folds one update. `messageKey` is the run of text it belongs to (a delta's, or a stored text item's);
 * `live` is true for a delta, whose text is added to what is there rather than replacing it.
 */
export function foldAcp(
	draft: AcpDraft,
	turn: number,
	given: AcpUpdate,
	at: number | null,
	messageKey: string | null,
	live: boolean,
	newTool: ToolMaker,
): void {
	const update = fieldsOf(given);
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
		case "agent_thought_chunk": {
			const text = chunkText(update.content);
			if (text === null) return;
			const kind = update.sessionUpdate === "agent_message_chunk" ? "text" : "reasoning";
			const messageId = messageKey ?? `acp-${draft.view.lastSeq}`;
			const block = draft.find(
				turn,
				(candidate): candidate is TextBlock | ReasoningBlock =>
					candidate.kind === kind && candidate.messageId === messageId,
			);
			if (live) {
				// A chunk after the run's stored item has nothing left to add.
				if (block && !block.streaming) return;
				if (block) draft.replace<TextBlock | ReasoningBlock>(turn, block, { text: block.text + text });
				else draft.push(turn, { kind, at, messageId, text, streaming: true });
				return;
			}
			if (block) draft.replace<TextBlock | ReasoningBlock>(turn, block, { text, streaming: false });
			else draft.push(turn, { kind, at, messageId, text, streaming: false });
			return;
		}
		case "tool_call":
		case "tool_call_update": {
			const callId = typeof update.toolCallId === "string" ? update.toolCallId : "";
			if (callId === "") return;
			const call = draft.find(
				turn,
				(candidate): candidate is ToolBlock =>
					candidate.kind === "tool" && candidate.messageId === ACP_MESSAGE && candidate.callId === callId,
			);
			const base = call ?? { ...newTool(ACP_MESSAGE, callId, toolName(update.kind), at), id: "" };
			const patch = toolPatch(base, update, at);
			if (call) draft.replace(turn, call, patch);
			else draft.push(turn, { ...newTool(ACP_MESSAGE, callId, toolName(update.kind), at), ...patch });
			return;
		}
		case "plan": {
			// One without its entries says nothing of the plan.
			if (!Array.isArray(update.entries)) return;
			const entries = planEntries(update.entries);
			const plan = draft.find(
				turn,
				(candidate): candidate is Extract<Block, { kind: "plan" }> => candidate.kind === "plan",
			);
			// An empty plan clears it (ACP): no checklist of nothing. Claude Code sends one after /clear, and
			// in a turn after the one that made its task list, whose tasks a new process does not know.
			if (entries.length === 0) {
				if (plan) draft.remove(turn, plan);
				return;
			}
			if (plan) draft.replace(turn, plan, { entries });
			else draft.push(turn, { kind: "plan", at, entries });
			return;
		}
		case "usage_update": {
			const context = contextOf(update);
			if (context) draft.set({ context });
			return;
		}
		// The prompt is the platform's own user item; the rest is the harness's housekeeping.
		default:
			return;
	}
}

/**
 * An update's fields, read as untrusted: the one place the folder looks into `AcpUpdate`, so that a
 * stricter type of it changes this only. Each field is checked where it is used.
 */
type AcpFields = Record<string, unknown> & { sessionUpdate: string };

function fieldsOf(update: AcpUpdate): AcpFields {
	const fields: Record<string, unknown> = isRecord(update) ? update : {};
	return { ...fields, sessionUpdate: typeof fields.sessionUpdate === "string" ? fields.sessionUpdate : "" };
}

/** The context's fill from a `usage_update` (or a turn's ending), or null when it does not say. */
export function contextOf(value: unknown): AcpContext | null {
	if (!isRecord(value) || !finite(value.used) || !finite(value.size) || value.size <= 0) return null;
	const cost =
		isRecord(value.cost) && finite(value.cost.amount) && typeof value.cost.currency === "string"
			? { amount: value.cost.amount, currency: value.cost.currency }
			: null;
	const pct = value.fiveHourUsedPct;
	return {
		used: value.used,
		size: value.size,
		cost,
		...(finite(pct) && pct >= 0 && pct <= 100 && { fiveHourUsedPct: pct }),
	};
}

/** "41% used", of a context's fill. */
export function contextWords(context: AcpContext): string {
	return `${Math.min(100, Math.round((context.used / context.size) * 100))}% used`;
}

/** "$0.38 so far", or the amount and its currency's code where it is not dollars. */
export function costWords(cost: NonNullable<AcpContext["cost"]>): string {
	const amount = cost.amount.toFixed(2);
	return `${cost.currency === "USD" ? `$${amount}` : `${amount} ${cost.currency}`} so far`;
}

// ---------------------------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------------------------

/** ACP's kinds of tool, in the words the platform's tool rows use. */
const TOOL_NAMES: Record<string, string> = {
	read: "read",
	edit: "edit",
	delete: "delete",
	move: "move",
	search: "search",
	execute: "shell",
	think: "think",
	fetch: "fetch",
	switch_mode: "mode",
};

function toolName(kind: unknown): string {
	return (typeof kind === "string" && TOOL_NAMES[kind]) || "tool";
}

const STATES: Record<string, ToolState> = {
	pending: "input",
	in_progress: "running",
	completed: "done",
	failed: "failed",
};

/** What the harness's title says the call acts on: the title without the verb the tool's name already says, and without code quotes. */
function targetOf(title: string, name: string): string {
	const words = title.trim().replace(/^`([^`]*)`$/, "$1");
	const verb = new RegExp(`^(?:${name}|run|find|write|grep)\\s+`, "i");
	return words
		.replace(verb, "")
		.replace(/^`([^`]*)`$/, "$1")
		.replace(/\s*\n\s*/g, " ↵ ");
}

/** What an update changes of its call. Fields it leaves out stay as they were; `content`, when given, replaces the call's. */
function toolPatch(call: ToolBlock, update: AcpFields, at: number | null): Partial<ToolBlock> {
	const patch: Partial<ToolBlock> = {};
	const name = typeof update.kind === "string" ? toolName(update.kind) : call.name;
	if (name !== call.name) patch.name = name;
	if (typeof update.title === "string") patch.target = targetOf(update.title, name);
	if (isRecord(update.rawInput)) patch.inputText = JSON.stringify(update.rawInput);

	let text = call.output ?? call.progress;
	let display = call.display;
	if (Array.isArray(update.content)) {
		const parts = update.content.filter(isRecord);
		const texts = parts
			.map(part => (part.type === "content" ? chunkText(part.content) : null))
			.filter((part): part is string => part !== null);
		text = texts.length > 0 ? texts.join("\n") : null;
		const diffs = parts
			.filter(part => part.type === "diff" && typeof part.path === "string")
			.map(part =>
				unifiedDiff(
					String(part.path),
					typeof part.oldText === "string" ? part.oldText : null,
					typeof part.newText === "string" ? part.newText : "",
				),
			);
		display = diffs.length > 0 ? { diff: diffs.join("") } : null;
	}
	patch.display = display;

	const state = typeof update.status === "string" ? STATES[update.status] : undefined;
	const next = state ?? call.state;
	if (next !== call.state) patch.state = next;
	if (next === "running" && call.startedAt === null) patch.startedAt = at;
	if (next === "done" || next === "failed") {
		patch.outcome = next === "done" ? "success" : "error";
		patch.output = text ?? "";
		patch.progress = null;
		const started = patch.startedAt ?? call.startedAt;
		if (state && at !== null && started !== null) patch.durationMs = Math.max(0, at - started);
	} else {
		patch.progress = text;
		patch.output = null;
	}
	return patch;
}

// ---------------------------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------------------------

/** The sandbox's workspace (server/src/sandbox/provider.ts): paths under it are shown from there. */
const WORKSPACE = "/workspace/";
/** Lines of context around each change, as `git diff` gives. */
const CONTEXT = 3;
/** Beyond this many lines on a side, the whole old text is shown removed and the new one added. */
const DIFF_LINES = 2000;

/**
 * A unified diff of one file from its old and new text, as `git diff` writes one, for the diff view.
 * `oldText` null: the file is new.
 */
export function unifiedDiff(path: string, oldText: string | null, newText: string): string {
	const shown = path.startsWith(WORKSPACE) ? path.slice(WORKSPACE.length) : path;
	const before = oldText === null || oldText === "" ? [] : oldText.replace(/\n$/, "").split("\n");
	const after = newText === "" ? [] : newText.replace(/\n$/, "").split("\n");
	const head = `diff --git a/${shown} b/${shown}\n${oldText === null ? "new file mode 100644\n--- /dev/null" : `--- a/${shown}`}\n+++ b/${shown}\n`;
	const ops = lineOps(before, after);
	const hunks: string[] = [];
	let index = 0;
	while (index < ops.length) {
		// The next change, with its context, and every change whose context touches it.
		while (index < ops.length && ops[index]?.kind === " ") index++;
		if (index >= ops.length) break;
		const start = Math.max(0, index - CONTEXT);
		let end = index;
		for (let at = index; at < ops.length; at++) {
			if (ops[at]?.kind !== " ") end = at;
			else if (at - end > CONTEXT * 2) break;
		}
		const stop = Math.min(ops.length, end + CONTEXT + 1);
		const slice = ops.slice(start, stop);
		// Within a change the removals were put first, so where the hunk starts is the least of its positions.
		const oldStart = Math.min(...slice.map(op => op.old));
		const newStart = Math.min(...slice.map(op => op.new));
		const oldCount = slice.filter(op => op.kind !== "+").length;
		const newCount = slice.filter(op => op.kind !== "-").length;
		hunks.push(
			`@@ -${oldCount === 0 ? oldStart : oldStart + 1},${oldCount} +${newCount === 0 ? newStart : newStart + 1},${newCount} @@\n${slice.map(op => `${op.kind}${op.text}`).join("\n")}\n`,
		);
		index = stop;
	}
	return head + hunks.join("");
}

interface LineOp {
	kind: " " | "-" | "+";
	text: string;
	/** Lines of the old and new text before this one. */
	old: number;
	new: number;
}

/** The lines of two texts as kept, removed and added, by their longest common subsequence. */
function lineOps(before: string[], after: string[]): LineOp[] {
	const ops: LineOp[] = [];
	if (before.length > DIFF_LINES || after.length > DIFF_LINES) {
		before.forEach((text, index) => ops.push({ kind: "-", text, old: index, new: 0 }));
		after.forEach((text, index) => ops.push({ kind: "+", text, old: before.length, new: index }));
		return ops;
	}
	const width = after.length + 1;
	const common = new Uint16Array((before.length + 1) * width);
	for (let i = before.length - 1; i >= 0; i--) {
		for (let j = after.length - 1; j >= 0; j--) {
			common[i * width + j] =
				before[i] === after[j]
					? (common[(i + 1) * width + j + 1] ?? 0) + 1
					: Math.max(common[(i + 1) * width + j] ?? 0, common[i * width + j + 1] ?? 0);
		}
	}
	let i = 0;
	let j = 0;
	while (i < before.length || j < after.length) {
		if (i < before.length && j < after.length && before[i] === after[j]) {
			ops.push({ kind: " ", text: before[i] ?? "", old: i++, new: j++ });
		} else if (
			j < after.length &&
			(i >= before.length || (common[i * width + j + 1] ?? 0) >= (common[(i + 1) * width + j] ?? 0))
		) {
			ops.push({ kind: "+", text: after[j] ?? "", old: i, new: j++ });
		} else {
			ops.push({ kind: "-", text: before[i] ?? "", old: i++, new: j });
		}
	}
	// Removals before additions within each change, as `git diff` writes them.
	const sorted: LineOp[] = [];
	let run: LineOp[] = [];
	const flush = () => {
		sorted.push(...run.filter(op => op.kind === "-"), ...run.filter(op => op.kind === "+"));
		run = [];
	};
	for (const op of ops) {
		if (op.kind === " ") {
			flush();
			sorted.push(op);
		} else run.push(op);
	}
	flush();
	return sorted;
}

// ---------------------------------------------------------------------------------------------
// Reading untyped fields
// ---------------------------------------------------------------------------------------------

function planEntries(value: unknown): PlanEntry[] {
	if (!Array.isArray(value)) return [];
	return value.filter(isRecord).map(entry => ({
		content: typeof entry.content === "string" ? entry.content : "",
		status: entry.status === "completed" || entry.status === "in_progress" ? entry.status : "pending",
	}));
}

/** The text of a content block, when it is text. */
function chunkText(content: unknown): string | null {
	return isRecord(content) && content.type === "text" && typeof content.text === "string" ? content.text : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
