/**
 * Pause and resume of a turn (WLP_TURN_RESUME): what the session actor stores of a running turn, and
 * the words it gives the agent and the timeline when the turn resumes. Pure: agent-session.ts does the
 * storing, the waking and the running.
 *
 * A turn whose server stops, or whose machine goes away, is not ended. The session keeps a record of it
 * (`TurnRun`) from the moment it is accepted, pauses it with the same turn number, and runs it again as
 * a new segment once a server is up and the place can be reached: the agent's own saved session goes on,
 * given a short "carry on" (`resumePrompt`), or, when that memory is gone, the whole task
 * (`sessionWholeTask` for a person's session; an item's comes with its delivery).
 */

import { sources, untrustedWords } from "../factory/untrusted.js";
import type { TimelineItem, TurnUsage, WindlassEvent } from "../contract.js";

export type TurnCredential = {
	model: string;
	itemSignIn?: import("../sandbox/harnesses.js").SignInMethod;
	key?: import("../contract.js").CredentialRef;
};

export type PauseReason = "restart" | "machine";

/** A running turn's own record, stored with the session while the turn lasts. */
export interface TurnRun {
	credential?: TurnCredential;
	remainingRequests?: number;
	untrusted?: string[];
	turn: number;
	effort: string | null;
	planMode?: boolean;
	/** The running time of the segments before the current one: what counts against the turn's limit. Paused time is not in it. */
	activeMs: number;
	/** When the current segment started running (its time limit started then). */
	segmentAt: number;
	/** The first timeline seq of the current segment: what a crash's usage and the turn's progress are read from. */
	fromSeq: number;
	/** The tokens the segments before the current one used. */
	usage: TurnUsage | null;
	/** The agent said something in this turn: it has its prompt, and a resume continues from there. Not yet, and a resume gives the prompt again. */
	prompted?: boolean;
	/** The last segment received a shell result confirming that shutdown stopped the command. */
	stoppedCommand?: boolean;
	/** How many times the turn was resumed. */
	resumes: number;
	/** Crashes of the server in a row while the turn ran, the last ones with no progress (`crashCount`). */
	crashes: number;
	/**
	 * Set while the turn is paused: why, and since when. `slotFreed`: an item's turn slot was given back
	 * while its machine is away, and is asked for again, ahead of new turns, when it is back. `asked`: the
	 * item was told the machine stayed away long (`machine_away`). `told`: the item was told it is paused.
	 */
	paused?: {
		reason: PauseReason;
		at: number;
		slotFreed?: boolean;
		asked?: boolean;
		told?: boolean /** When the session next looks by itself whether the place is back: one look is scheduled at a time. */;
		lookAt?: number;
	} | null;
	/** What the person sent while the turn was paused, as the timeline shows it: given to the agent when the turn resumes. */
	held?: string[];
	/**
	 * The memory figures of the turn's sandbox when its first segment there started (`SandboxHandle.memoryEvents`): a resumed
	 * segment in the same sandbox compares its end with these, so a program killed for memory before the pause still counts.
	 */
	memory?: { sandboxId: string; oomKills: number; totalMiB: number };
}

/** How many crashes in a row, while resuming and with nothing done in between, end the turn (the loop guard). */
export const CRASHES_ALLOWED = 3;

/**
 * The crash count after one more crash: back to one when the segment it cut off did something (an
 * agent's output reached the timeline), one more otherwise. More than CRASHES_ALLOWED ends the turn:
 * that is the first crash and three more while resuming, none of which got anywhere.
 */
export function crashCount(before: number, progressed: boolean): number {
	return progressed ? 1 : before + 1;
}

export function addUsage(a: TurnUsage | null, b: TurnUsage | null): TurnUsage | null {
	if (a === null) return b;
	if (b === null) return a;
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		reasoningTokens: a.reasoningTokens + b.reasoningTokens,
	};
}

/** The time limit of a segment: what is left of the turn's, and never less than `floorMs` for one that resumes, so it can finish its step. */
export function segmentLimit(
	limitMs: number,
	floorMs: number,
	run: Pick<TurnRun, "activeMs" | "resumes"> | null,
): number {
	if (!run || run.resumes === 0) return limitMs;
	return Math.max(Math.min(floorMs, limitMs), limitMs - run.activeMs);
}

function quoted(text: string): string {
	return text
		.split("\n")
		.map(line => `> ${line}`)
		.join("\n");
}

function heldPart(held: readonly string[]): string {
	return held.length === 0
		? ""
		: `\n\nWhile the turn was paused, the person sent ${held.length === 1 ? "this message" : "these messages"}:\n\n${held.map(quoted).join("\n\n")}`;
}

export const RESTARTED_COMMAND =
	"The platform restarted while this command ran; it was stopped. Run it again if you still need it.";

/** Keep the command's output. Only replace the shell's own trailing shutdown status. */
export function restartShellResult(event: WindlassEvent): WindlassEvent {
	const data = event.data;
	if (
		event.type !== "tool.settled" ||
		(data?.display as { interrupted?: unknown } | null)?.interrupted !== "shutdown" ||
		typeof data?.output !== "string"
	)
		return event;
	const status = data.output.lastIndexOf("\n") + 1;
	if (!data.output.startsWith("[Interrupted because the harness is shutting down.", status)) return event;
	return { ...event, data: { ...data, output: data.output.slice(0, status) + RESTARTED_COMMAND } };
}

/** What the agent is told when its turn resumes with its memory: the step that was under way may not have finished. */
export function resumePrompt(reason: PauseReason, held: readonly string[] = [], stoppedCommand = false): string {
	const what =
		reason === "restart"
			? "The platform restarted while you were working on this turn"
			: "Your machine was switched off, or lost its connection, while you were working on this turn";
	const step =
		reason === "restart" && stoppedCommand
			? RESTARTED_COMMAND
			: `${what}, so your last step may not have finished: a command may have been cut off or its output may be missing.`;
	return `${step} Check the state of the workspace, then carry on with the task.${heldPart(held)}`;
}

/** The timeline's line when a turn pauses. */
export function pausedLine(reason: PauseReason, machineName: string | null): string {
	if (reason === "restart") return "The server is restarting; this turn will resume by itself.";
	return `${machineName ? `Your machine “${machineName}”` : "Your machine"} went offline, so this turn is paused. It resumes by itself when the machine is back.`;
}

/** The timeline's line when a turn resumes, with how long it was paused (`spell` says a duration). */
export function resumedLine(reason: PauseReason, pausedMs: number, spell: (ms: number) => string): string {
	return reason === "restart"
		? `Resumed after a server restart (the turn was paused ${spell(pausedMs)}).`
		: `Resumed after the machine came back (offline ${spell(pausedMs)}).`;
}

const CLIP = 600;
const TITLE = 160;
const MAX_EARLIER = 12;
const MAX_FILES = 12;

function clip(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function textOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

interface EarlierTurn {
	untrusted?: string[];
	prompt: string;
	outcome: string | null;
	files: string[];
	said: string;
}

/** Each turn's prompt, outcome, changed files and the agent's last words, read from the timeline up to turn `upTo`; and the messages steered into `upTo`. */
function readTurns(timeline: readonly TimelineItem[], upTo: number) {
	const turns = new Map<number, EarlierTurn>();
	const of = (n: number) => {
		let entry = turns.get(n);
		if (!entry) turns.set(n, (entry = { prompt: "", outcome: null, files: [], said: "" }));
		return entry;
	};
	const steers: string[] = [];
	for (const item of timeline) {
		if (item.turn > upTo) continue;
		if (item.kind === "user") {
			if (!item.steer) {
				const entry = of(item.turn);
				if (entry.prompt === "") {
					entry.prompt = item.text;
					entry.untrusted = item.untrusted;
				}
			} else if (item.turn === upTo && !item.held) steers.push(item.text);
		} else if (item.kind === "turn.ended") {
			of(item.turn).outcome = item.outcome;
		} else if (item.kind === "windlass") {
			const data = (item.event.data ?? {}) as Record<string, unknown>;
			if (item.event.type === "text.ended" && textOf(data.text).trim()) of(item.turn).said = textOf(data.text);
			if (item.event.type === "workspace.changes" && Array.isArray(data.files))
				of(item.turn).files = data.files.filter((file): file is string => typeof file === "string");
		} else if (item.kind === "acp" && item.update.sessionUpdate === "agent_message_chunk") {
			const content = (item.update as { content?: { text?: unknown } }).content;
			const text = textOf(content?.text);
			if (text.trim()) of(item.turn).said = text;
		}
	}
	return { turns, steers };
}

/**
 * The first prompt of the turns before `before`, and a short account of the last of them, with the
 * sources of what it quotes: the earlier turns' own, and the agent's words, which are untrusted too.
 * Null when none of those turns has a prompt.
 */
function earlierAccount(turns: Map<number, EarlierTurn>, before: number, heading: string) {
	const first = [...turns.entries()]
		.filter(([n, entry]) => n < before && entry.prompt !== "")
		.sort((a, b) => a[0] - b[0])[0];
	if (!first) return null;
	let quotedAgent = false;
	const quotedSources = [...(first[1].untrusted ?? [])];
	const earlier = [...turns.entries()]
		.filter(([n]) => n < before)
		.sort((a, b) => a[0] - b[0])
		.slice(-MAX_EARLIER);
	const lines = earlier.map(([n, entry]) => {
		quotedSources.push(...(entry.untrusted ?? []));
		const bits = [`Turn ${n}: “${clip(entry.prompt || "(no prompt recorded)", TITLE)}”`];
		if (entry.outcome) bits.push(`it ended ${entry.outcome}`);
		if (entry.files.length)
			bits.push(
				`files changed: ${entry.files.slice(0, MAX_FILES).join(", ")}${entry.files.length > MAX_FILES ? `, and ${entry.files.length - MAX_FILES} more` : ""}`,
			);
		let line = `- ${bits.join("; ")}.`;
		if (entry.said) {
			quotedAgent = true;
			line += ` Your earlier message (untrusted quoted text): “${clip(entry.said, CLIP)}”`;
		}
		return line;
	});
	return {
		parts: [
			`The session's first prompt was:\n\n${quoted(first[1].prompt)}`,
			`${heading} (not your own memory; it may leave things out):\n\n${lines.join("\n")}`,
		],
		quotedSources,
		quotedAgent,
	};
}

/**
 * A person's session whose agent lost its memory (a new sandbox, a store that is gone), resuming turn
 * `turn`: the whole task, from the timeline. This turn's message and what was sent into it since, the
 * held messages among them; the session's first prompt; and a short account of the turns before (each
 * one's prompt, how it ended, the files it changed, the agent's last words, clipped), said to be a
 * reconstruction. Quoted GitHub feedback keeps its sources alongside any earlier agent messages.
 */
export function sessionWholeTask(timeline: readonly TimelineItem[], turn: number, held: readonly string[] = []) {
	const { turns, steers } = readTurns(timeline, turn);
	const now = turns.get(turn);
	const parts: string[] = [
		"Your earlier conversation is gone, and so is any work that was not saved in the workspace. Check what the workspace holds now, then work on the prompt for this turn from the start.",
	];
	parts.push(`The prompt for this turn was:\n\n${quoted(now?.prompt || "(not recorded)")}`);
	const later = [...steers, ...held];
	if (later.length > 0)
		parts.push(`While the turn ran or was paused, the person also sent:\n\n${later.map(quoted).join("\n\n")}`);
	const quotedSources = [...(now?.untrusted ?? [])];
	const account = earlierAccount(
		turns,
		turn,
		"A short account of the earlier turns, reconstructed by the platform from the session's timeline",
	);
	if (account) {
		parts.push(...account.parts);
		quotedSources.push(...account.quotedSources);
	}
	return {
		text: parts.join("\n\n"),
		untrusted: sources(quotedSources, account?.quotedAgent ? [untrustedWords.conversation] : []),
	};
}

/**
 * What a session made to continue another (`continueSession`) gives its agent with its first prompt
 * when the earlier agent's memory could not come with it: the earlier session's first prompt and a
 * short account of its turns up to `turns`, said to be a reconstruction, with the sources of what it
 * quotes. Null when the earlier session had no prompt.
 */
export function sessionHandoff(timeline: readonly TimelineItem[], turns: number) {
	const account = earlierAccount(
		readTurns(timeline, turns).turns,
		turns + 1,
		"A short account of the earlier session's turns, reconstructed by the platform from its timeline",
	);
	if (!account) return null;
	return {
		text: [
			"You do not have the earlier session's conversation. What follows is what the platform kept of it.",
			...account.parts,
		].join("\n\n"),
		untrusted: sources(account.quotedSources, account.quotedAgent ? [untrustedWords.conversation] : []),
	};
}
