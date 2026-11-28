/** An agent session's Windlass and ACP events, usage windows, timeline and live deltas. */

import type { HarnessId, TurnOutcome } from "../contract.js";
import type { ModelProvider } from "./account.js";
import type { BlockedNetwork, SecretRequest } from "./items.js";
import { MAX_TITLE_CHARS } from "./limits.js";
import type { Verified } from "./repository.js";

/**
 * One of Windlass's own events, passed through untouched: the same JSON `windlass --json` prints. Durable events carry `v`, `data`, `seq`
 * and `time`; ephemeral ones (`text.delta`, `reasoning.delta`, `tool.input.delta`, `tool.progress`,
 * `notice`, `workspace.changes`, `cli.summary`) carry their fields at the top level and no `seq`.
 * See fixtures/windlass-events/ and Windlass's docs/event-log.md.
 */
export interface WindlassEvent {
	type: string;
	sessionId?: string;
	v?: number;
	seq?: number;
	time?: number;
	data?: Record<string, unknown>;
	[field: string]: unknown;
}

/** `cli.summary`: the line Windlass prints after each turn. */
export interface TurnUsage {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
}

export interface UsageWindow {
	kind: "5h" | "7d" | "model" | "rpm" | "other";
	usedPct: number | null;
	resetsAt: number | null;
	observedAt: number;
	source: "refusal" | "event" | "header";
}
export interface ProviderAccount {
	provider?: ModelProvider;
	key: string;
	harness: HarnessId;
	state: "ok" | "warning" | "limited";
	limitedUntil: number | null;
	windows: UsageWindow[];
}
export interface AcpContext {
	fiveHourUsedPct?: number;
	used: number;
	size: number;
	cost: { amount: number; currency: string } | null;
}

export type AcpContent = { type: "text"; text: string } | { type: string; [key: string]: unknown };
type AcpChunk = { content: AcpContent };
type AcpTool = { toolCallId: string; title?: string; kind?: string; status?: string; content?: AcpContent[] };

export type AcpUpdate = (
	| ({ sessionUpdate: "agent_message_chunk" } & AcpChunk)
	| ({ sessionUpdate: "agent_thought_chunk" } & AcpChunk)
	| ({ sessionUpdate: "user_message_chunk" } & AcpChunk)
	| ({ sessionUpdate: "tool_call" } & AcpTool)
	| ({ sessionUpdate: "tool_call_update" } & AcpTool)
	| { sessionUpdate: "plan"; entries: Array<{ content: string; priority: string; status: string }> }
	| { sessionUpdate: "available_commands_update"; availableCommands: Array<{ name: string; description: string }> }
	| { sessionUpdate: "current_mode_update"; currentModeId: string }
	| { sessionUpdate: "config_option_update"; configOptions: unknown[] }
	| { sessionUpdate: "session_info_update"; title?: string; updatedAt?: string }
	| {
			sessionUpdate: "usage_update";
			rateLimit?: { status: "allowed" | "allowed_warning" | "rejected"; window: UsageWindow };
			fiveHourUsedPct?: number;
			used: number;
			size: number;
			cost?: AcpContext["cost"];
	  }
	| { sessionUpdate: "notice" }
	| { sessionUpdate: "compaction_update" }
	| { sessionUpdate: "unknown"; originalSessionUpdate: string }
) &
	Record<string, unknown>;

/** Name an untitled agent from a complete opening sentence or clause. */
export function promptTitle(prompt: string): string {
	// A short one-line prompt is its own title; a longer one gives its first sentence or clause.
	const whole = prompt.replace(/\s+/g, " ").trim();
	if (whole && !prompt.trim().includes("\n") && whole.length <= 60) return whole;
	const line = prompt
		.trim()
		.split(/\n|(?<=[.!?])\s+/, 1)[0]!
		.replace(/\s+/g, " ")
		.trim();
	if (line && line.length <= MAX_TITLE_CHARS) return line;
	const clause = line
		.split(/;\s*|,?\s+(?:and then|then|and|so that|in order to|using|without|which|because)\s+/i, 1)[0]!
		.trim();
	return clause && clause.length <= MAX_TITLE_CHARS ? clause : "Work on the requested task";
}

/** The title an ACP update may give a personal session whose owner has not named it. */
export function generatedSessionTitle(
	update: AcpUpdate,
	owner: { typed?: boolean; item?: { role?: "builder" | "reviewer" } },
	redactor?: { text(value: string): string },
): string | undefined {
	if (update.sessionUpdate !== "session_info_update" || typeof update.title !== "string" || owner.typed || owner.item)
		return;
	const line = update.title
		.replace(/[\s\u0085]/gu, " ")
		.replace(/\p{Cc}/gu, "")
		.replace(/ +/g, " ")
		.trim();
	// Removing controls can join fragments of a secret. Redact the whole line before cutting it.
	const safe = redactor?.text(line) ?? line;
	const chars = [...safe];
	if (chars.length <= MAX_TITLE_CHARS) return safe || undefined;
	// Too long for a title: cut at the last word that fits, as the start composer does (`titleOf`).
	const cut = chars.slice(0, MAX_TITLE_CHARS - 1).join("");
	const space = cut.lastIndexOf(" ");
	return `${(space > MAX_TITLE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Session sequence numbers are dense and independent of Windlass event sequence numbers. */
export type NetworkBlockedItem = {
	seq: number;
	at: number;
	turn: number;
	kind: "network.blocked";
	revision: number;
} & BlockedNetwork;

export interface ModelKeySpend {
	provider: ModelProvider;
	generation: string;
	tokens: number;
	/** The connected plan paid, not a Settings key. */
	plan?: true;
}

export type TimelineItem =
	/** One row per turn. Its first snapshot arrives on item, replacements on networkBlocked with the same seq. */
	| NetworkBlockedItem
	| {
			seq: number;
			at: number;
			turn: number;
			kind: "user";
			text: string;
			model: string;
			effort: string | null;
			/** A steering message joins the running turn at its next step. */
			steer?: boolean;
			/** Sources of quoted GitHub feedback, also used when rebuilding the prompt after a pause. */
			untrusted?: string[];
			/** A message sent while the turn was paused: held, and given to the agent when the turn resumes. */
			held?: boolean;
	  }
	/** Something the platform did around a turn: "Starting a hosted sandbox (Strict)", "Cloning repository". */
	| {
			seq: number;
			at: number;
			turn: number;
			kind: "platform";
			modelKey?: ModelKeySpend;
			/** The agent’s request, with its reason as quoted plain text. */
			secretRequest?: SecretRequest & { id: string };
			level: "info" | "warn" | "error";
			text: string;
			/**
			 * Set on the line that says the platform declined a question because nobody answered in time
			 * ("question_expired"), with the call the question was about. Windlass's own `approval.answered`
			 * for that call follows, with choice "deny": this is how a client tells it from the user's choice.
			 * "question_allowed" is the same for a question the platform allowed itself: Windlass's question
			 * about the tool that hands the agent's request to publish to the platform, and its question
			 * about a tool of one of the user's own MCP servers whose tools run without asking
			 * (`PersonalServer.unasked`). The `approval.answered` that follows has choice "once", and nobody was asked.
			 */
			code?: "question_expired" | "question_allowed" | "host_blocked" | "turn_paused" | "turn_resumed";
			call?: { messageId: string; callId: string };
			/**
			 * With `code` "host_blocked": the host a command in the session's sandbox asked for and could
			 * not reach, which the line names. `repository` is set when the session's repository's network
			 * list can allow it (`allowHost`); without it only the deployment's operator can.
			 */
			host?: string;
			repository?: boolean;
	  }
	/** A durable Windlass event, or one of the stored ephemeral ones (`notice`, `workspace.changes`, `cli.summary`). */
	| { seq: number; at: number; turn: number; kind: "windlass"; event: WindlassEvent; modelKey?: ModelKeySpend }
	| { seq: number; at: number; turn: number; kind: "acp"; update: AcpUpdate; messageKey?: string; truncated?: boolean }
	/** Setup emits start and finish items with the same ID. Intervening output streams live; only the ending tail persists. */
	| {
			seq: number;
			at: number;
			turn: number;
			kind: "setup";
			id: string;
			/** The command as it was run. */
			command: string;
			/**
			 * "started", or how it ended: "succeeded" (exit code 0), "failed" (another exit code, or it could
			 * not be run), "timed_out" (stopped by the platform at `limitMs`), "stopped" (the turn was stopped).
			 */
			state: "started" | "succeeded" | "failed" | "timed_out" | "stopped";
			/** Null while it runs, and when it was killed. */
			exitCode: number | null;
			/** Null while it runs. */
			durationMs: number | null;
			/** How long it may run. */
			limitMs: number;
			/** On the ending item: the end of what it printed, standard output and standard error as they came, at most SETUP_OUTPUT_CHARS. */
			output: string;
			/** True when it printed more than `output` holds. */
			truncated: boolean;
	  }
	| {
			seq: number;
			at: number;
			turn: number;
			kind: "turn.ended";
			modelKey?: ModelKeySpend;
			outcome: TurnOutcome;
			/** Windlass's exit code, null when it never ran or was killed. */
			exitCode: number | null;
			steps: number | null;
			durationMs: number;
			usage: TurnUsage | null;
			/** Share of input tokens read from the prompt cache, 0..1. */
			cachedShare: number | null;
			/** What went wrong, including a provider refusal on a failed turn, fit to show. */
			message: string | null;
			/** What the session's work rests on after this turn. */
			verified: Verified | null;
			context?: AcpContext | null;
			/** Another agent's own session id, which it names only once a turn has opened it (ACP `session/new`); the panel shows it at once. */
			sessionId?: string;
	  };

/** Streaming deltas, including setup.output, are broadcast and never stored. */
export interface WindlassDelta {
	turn: number;
	event: WindlassEvent;
}

export type LiveDelta = WindlassDelta | { turn: number; acp: AcpUpdate; messageKey: string };
