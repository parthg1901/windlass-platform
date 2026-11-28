/** Each turn owns an ACP process and a provider hold. Scope prompts, tools and approvals to that session; redact events before forwarding them. On exit revoke turn credentials and sweep the tagged process. */

import { within } from "./command.js";
import { untrustedSource } from "../factory/untrusted.js";
import { callArguments } from "../agent-publish.js";
import {
	CALL_AFTER_TURN,
	CALL_UNKNOWN,
	platformToolDeclarations,
	runPlatformTool,
	turnPlatformTools,
	type PlatformToolHandler,
} from "../platform-tools.js";
import { reportedModelUsage } from "../usage.js";
import type { TurnUsage, WindlassEvent } from "../contract.js";
import { isReservedServerName } from "../personal-servers.js";
import { NO_REDACTION, type Redactor } from "../repo-secrets.js";
import { windlassChecks } from "../repository-checks.js";
import {
	type ConfigServer,
	type PlatformConfig,
	PLATFORM_SERVERS_FILE,
	TURN_DEADLINE_FILE,
	WINDLASS_CONFIG_FILE,
	platformConfig,
	projectChecks,
} from "../windlass-config.js";
import type {
	RunTurnInput,
	RunTurnResult,
	SandboxHandle,
	ScriptedModel,
	StartMark,
	TurnAnswer,
	TurnCheckpoint,
	TurnChecks,
	TurnControl,
	TurnPublishRequest,
	TurnQuestion,
	TurnServer,
	TurnServerOutcome,
	TurnServerQuestion,
	TurnUnaskedCall,
	Windlass,
} from "./api.js";
import { PLATFORM_RESTART } from "./api.js";
import { AcpConnection, AcpError, LineSplitter, MethodNotFound } from "./acp.js";
import { demoScript } from "./demo.js";
import { type Failure, RELAY_REFUSED, handedInFailure, handedInProblem, relayRefused } from "./handoff.js";
import {
	sweepSessionProcesses,
	type ProcessEnd,
	type SandboxProcess,
	type TurnSandbox,
	isTurnSandbox,
	randomId,
} from "./provider.js";
import { hostedKeyEnv, redactKeyLease, windlassPlanEnv } from "./hosted-keys.js";
import { hostedKeyMessage, windlassProvider } from "./harnesses.js";
import { openModelKeyRelay, rotatePlanToken, turnTokenFilePath, writePlanPlaceholder } from "./token-file.js";
import { config } from "../config.js";
import { errorText, sleep } from "../util.js";

export const turnHostTools = (input: RunTurnInput) => turnPlatformTools(input);

/**
 * The provider a turn's session names (`_meta.windlass.provider`): a Settings key's own, and for the ChatGPT plan
 * Windlass's `chatgpt` profile, which reads the handed-in token file the plan's env names (`windlassPlanEnv`).
 * Windlass refuses a handed-in token under any other ("a handed-in token requires the chatgpt profile").
 */
export function sessionProvider(key: { provider: string; plan?: true }): string {
	return key.plan ? "chatgpt" : key.provider;
}

export function sessionOpenParams(cwd: string, meta: Record<string, unknown>) {
	return { cwd, mcpServers: [], _meta: { windlass: meta } };
}

export function turnAgentMeta(
	restrictedAgent: string | null,
	clearPlanner?: boolean,
): { agent?: string; children?: false } {
	// The agent definition refuses delegation. children controls only questions from a child.
	if (restrictedAgent) return { agent: restrictedAgent, children: false };
	return clearPlanner ? { agent: "none" } : {};
}

export function hostToolsMeta(tools: ReadonlyMap<string, unknown>, screenshots?: boolean, crossRepo?: boolean) {
	return { hostTools: platformToolDeclarations(tools, { screenshots, crossRepo }) };
}

/** The key of Windlass's extensions in `_meta` and in an error's `data`, and the prefix of its methods. */
const NS = "windlass";
const EXT = {
	event: `_${NS}/event`,
	steer: `_${NS}/steer`,
	cancelCall: `_${NS}/cancel_call`,
	resolve: `_${NS}/resolve`,
	mcp: `_${NS}/mcp`,
	mcpChanged: `_${NS}/mcp_changed`,
	mcpApprove: `_${NS}/mcp_approve`,
	hostCall: `_${NS}/host_call`,
};
const PROTOCOL_VERSION = 1;
const INITIALIZE = {
	protocolVersion: PROTOCOL_VERSION,
	clientInfo: { name: "windlass-platform", title: "Windlass Platform", version: "0" },
	clientCapabilities: { _meta: { [NS]: { events: true, updates: false } } },
};

/**
 * What a session's sandboxed commands find at the home directory's path: a home of the session's own
 * (Windlass's docs/safety.md, "The session's home"), in which the home's entries are read-only and
 * what a command makes beside them is kept for the session. Tools that write under the home without
 * being told to (a build tool's settings, a package manager's cache) then work in Windlass's
 * sandbox. The home in a sandbox is nobody's to keep, which is what the setting is for.
 *
 * It is said in every profile, since it applies to the commands Windlass sandboxes and to no other:
 *
 *   approval "auto"   every command is sandboxed where bubblewrap works (the profiles that promise
 *                     Windlass's sandbox, and E2B before its check where the probe passes)
 *   approval "full"   commands run directly in the sandbox machine, with its real home, until content
 *                     from the web or an MCP server is in the conversation. From then on Windlass
 *                     sandboxes them again where it can (`e2b-open`), and a tool that wrote under
 *                     the home until then would fail on a read-only one
 *   no bubblewrap     (`docker-hardened`, and E2B where the probe fails) Windlass sandboxes nothing,
 *                     so no command gets the home, and the model and the user are told nothing of it
 */
const SANDBOX_HOME = "session";

const SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/;
const STDERR_TAIL = 4000;
const STDERR_KEPT = 64 * 1024;

export const START_TIMEOUT_MS = 20_000;
/** How long opening a session may take: with a real model the account's models are read first. */
const OPEN_TIMEOUT_MS = 90_000;
/** How long an engine whose client went away may hold its sessions: its shutdown limit (5 s) and a margin. */
const WINDING_DOWN_MS = 6000;
/** After a cancel, how long a pending question waits for the engine's interrupt before it is answered `cancelled` anyway. */
const CANCEL_ANSWER_MS = 1000;
/** After a cancel, how long the turn may take to end (a command gets 3 s between SIGTERM and SIGKILL) before signals are sent. */
const CANCEL_WAIT_MS = 6000;
const CLOSE_TIMEOUT_MS = 5000;
const EXIT_WAIT_MS = 3000;
/** What `session/close` and the exit get instead, once a cancel has gone unanswered. */
const FORCED_WAIT_MS = 1500;
/** After the turn's end, how long a message admitted too late to be part of it may take to start its own execution. */
const FOLLOW_UP_MS = 3000;
const SERVERS_TIMEOUT_MS = 20_000;
/** Report startup as pending when an approved server takes longer than this to start. */
const SERVER_START_WAIT_MS = 5000;
const DEFINITION_TIMEOUT_MS = 10_000;

const STREAMED = new Set(["text.delta", "reasoning.delta", "tool.input.delta", "tool.progress"]);

export interface TurnOptions {
	/** Command serving ACP on stdio. Defaults to windlass acp. */
	engineCommand?: string[];
	startTimeoutMs?: number;
}

export interface WindlassHost {
	version(): Promise<string | null>;
	problem(): Promise<string | null>;
}

export class SandboxWindlass implements Windlass {
	constructor(
		private readonly host: WindlassHost,
		private readonly options: TurnOptions = {},
	) {}

	version(): Promise<string | null> {
		return this.host.version();
	}

	problem(): Promise<string | null> {
		return this.host.problem();
	}

	demoScript(prompt: string, turn: number): ScriptedModel {
		return demoScript(prompt, turn);
	}

	async runTurn(sandbox: SandboxHandle, input: RunTurnInput): Promise<RunTurnResult> {
		if (!isTurnSandbox(sandbox)) throw new Error("runTurn needs a sandbox from this layer's connect()");
		if (input.windlassSessionId !== undefined && !SESSION_ID.test(input.windlassSessionId))
			throw new Error(`invalid Windlass session id: ${input.windlassSessionId}`);
		if (input.signal?.aborted)
			return {
				exitCode: null,
				aborted: true,
				timedOut: false,
				windlassSessionId: null,
				summary: null,
				stderrTail: "",
				failure: null,
			};
		const provider = windlassProvider(input.model);
		// A qualified model runs on its provider's Settings key; an unqualified one on the ChatGPT plan. Only a scripted turn calls no model.
		const key = input.modelKey?.key;
		if (
			(!key && input.script === undefined) ||
			provider !== (key?.plan ? undefined : key?.provider) ||
			(key?.plan && key.provider !== "openai")
		)
			throw new Error(hostedKeyMessage("windlass", input.model));
		if (provider) input = { ...input, model: input.model!.slice(provider.length + 1) };
		return new Turn(sandbox, input, this.options).run();
	}
}

/** Windlass's events that are the model's output: what the first of them in a turn marks (`output`). */
const OUTPUT_EVENTS = new Set(["text.delta", "reasoning.delta", "tool.input.delta", "tool.called"]);

type Outcome = "succeeded" | "unresolved" | "failed" | "stopped" | "interrupted";

const callKey = (messageId: unknown, callId: unknown) => `${String(messageId)}\n${String(callId)}`;

/** Trust the engine's mcp_call fields to identify the server and tool. */
function mcpCall(name: unknown, input: unknown): { server: string; tool: string } | null {
	if (name !== "mcp_call") return null;
	let call: unknown = input;
	if (typeof input === "string") {
		try {
			call = JSON.parse(input);
		} catch {
			return null;
		}
	}
	if (typeof call !== "object" || call === null || Array.isArray(call)) return null;
	const { server, tool } = call as { server?: unknown; tool?: unknown };
	if (typeof server !== "string" || typeof tool !== "string") return null;
	return { server, tool: tool.startsWith(`${server}/`) ? tool.slice(server.length + 1) : tool };
}

/** Fold Windlass events using CLI summary semantics across all executions in this turn. */
class Tally {
	private startedAt: number | null = null;
	private steps = 0;
	private summaryCalls = 0;
	private usage: TurnUsage | null = null;
	running: string | null = null;
	/** The execution that ended last, and how its event says it ended. */
	last: { executionId: string; sessionId: string; outcome: Outcome; message: string | null; time: number } | null =
		null;

	note(event: WindlassEvent): void {
		const data = (event.data ?? {}) as Record<string, unknown>;
		const time = typeof event.time === "number" ? event.time : Date.now();
		const usage = reportedModelUsage(event);
		if (usage) {
			const total = (this.usage ??= { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 });
			total.inputTokens += usage.inputTokens;
			total.outputTokens += usage.outputTokens;
			total.cachedInputTokens += usage.cachedInputTokens;
			total.reasoningTokens += usage.reasoningTokens;
		}
		switch (event.type) {
			case "execution.started":
			case "execution.resumed":
				this.startedAt ??= time;
				this.running = typeof data.executionId === "string" ? data.executionId : "";
				return;
			case "step.started":
				this.steps += 1;
				return;
			case "compaction.failed":
			case "compaction.ended":
				this.summaryCalls += typeof data.calls === "number" ? data.calls : 0;
				return;
			case "execution.succeeded":
			case "execution.failed":
			case "execution.interrupted": {
				const verification = data.verification as { status?: unknown } | undefined;
				const outcome: Outcome =
					event.type === "execution.succeeded"
						? verification?.status === "unresolved"
							? "unresolved"
							: "succeeded"
						: event.type === "execution.failed"
							? data.cause === "approval"
								? "stopped"
								: "failed"
							: "interrupted";
				this.running = null;
				this.last = {
					executionId: typeof data.executionId === "string" ? data.executionId : "",
					sessionId: typeof event.sessionId === "string" ? event.sessionId : "",
					outcome,
					message: typeof data.message === "string" ? data.message : null,
					time,
				};
				return;
			}
		}
	}

	save(): Record<string, unknown> {
		return {
			startedAt: this.startedAt,
			steps: this.steps,
			summaryCalls: this.summaryCalls,
			usage: this.usage,
			running: this.running,
			last: this.last,
		};
	}

	load(saved: Record<string, unknown>): void {
		Object.assign(this, saved);
	}

	/** The summary event, with `outcome` in place of the event's own when the prompt's answer gave one. */
	summary(outcome: Outcome | null): WindlassEvent | null {
		const last = this.last;
		if (last === null) return null;
		const usage = this.usage;
		return {
			type: "cli.summary",
			sessionId: last.sessionId,
			executionId: last.executionId,
			outcome: outcome ?? last.outcome,
			steps: this.steps,
			summaryCalls: this.summaryCalls,
			requests: this.steps + this.summaryCalls,
			durationMs: this.startedAt === null ? 0 : Math.max(0, last.time - this.startedAt),
			usage,
			cachedShare:
				usage === null || usage.inputTokens === 0
					? null
					: Math.round((usage.cachedInputTokens / usage.inputTokens) * 1000) / 1000,
		};
	}
}

class Turn {
	private readonly approval: "ask" | "auto" | "full";
	private readonly reviewerAgent: string | null;
	private process: SandboxProcess | null = null;
	private readonly peer: AcpConnection;
	private readonly lines: LineSplitter;
	private promptId: number | null = null;
	/** A turn a restarted server takes up (`RunTurnInput.reattach`) has its process again. */
	private takenUp = false;
	/** The turn's key or plan relay lease, closed when the turn ends. */
	private keyLease: import("./provider.js").KeyTurnRelay | undefined;
	/** A plan relay on a machine that a restarted server can take up (`TurnSandbox.resumePlanRelay`); null otherwise. */
	private planLease: import("./provider.js").PlanRelayLease | null = null;
	private processEnd: ProcessEnd | null = null;
	private stderr = "";
	private readonly notes: string[] = [];

	/** The session this turn works in, once it is known: events of any other are not this turn's. */
	private session: string | null = null;
	/** The session to resume was gone, and a new one was opened for `RunTurnInput.fresh` (`open`). */
	private freshened = false;
	/** Events that arrived before `session/new` named the session. */
	private early: Array<{ sessionId: string; event: WindlassEvent }> = [];
	private sessionSeen: string | null = null;
	private readonly tally = new Tally();
	private summary: WindlassEvent | null = null;
	/** Nothing more is passed to `onEvent`: the summary was the last. */
	private sealed = false;
	// Windlass looks up a title model for up to 5s and makes at most two 15s attempts.
	private titleDeadline = 0;
	private resolveTitle: () => void = () => {};
	private readonly titled = new Promise<void>(resolve => {
		this.resolveTitle = resolve;
	});

	private failure: Failure | null = null;
	private promptSent = false;
	private promptSettled = false;
	private stopReason?: string;
	private promptEnding: { executionId: string | null; outcome: Outcome | null; stepLimit: boolean } | null = null;
	/** The `_meta` keys the engine takes on `session/prompt` (`promptMeta` in its answer to `initialize`). */
	private promptKeys: string[] = [];
	private steersInFlight = 0;
	/** Messages steered in that Windlass admitted and has not delivered to the model yet. */
	private readonly undelivered = new Set<string>();
	private readonly delivered = new Set<string>();
	private followUpTimer: ReturnType<typeof setTimeout> | undefined;

	/** The turn's work is over, or was cut off: `control` rejects from here on. */
	private over = false;
	private resolveOver: () => void = () => {};
	private readonly whenOver = new Promise<void>(resolve => (this.resolveOver = resolve));

	private abortRequested = false;
	private resolveAborted: () => void = () => {};
	private readonly whenAborted = new Promise<"aborted">(resolve => (this.resolveAborted = () => resolve("aborted")));
	private cancelSent = false;
	private cancelTimer: ReturnType<typeof setTimeout> | undefined;
	/** The cancel did not end the turn in time: it is cut off. */
	private forced = false;
	/** The process had to be signalled: it has no exit code of its own. */
	private signalled = false;
	/** Delay answers to withdrawn questions until the engine records the interrupt or its grace period expires. */
	private resolveInterrupted: () => void = () => {};
	private readonly whenInterrupted = new Promise<void>(resolve => (this.resolveInterrupted = resolve));
	private readonly questions = new Set<AbortController>();
	private questionLine: Promise<void> = Promise.resolve();

	private servers: ServerState[] = [];
	/** Ask at most once per name and definition fingerprint in this turn. */
	private readonly serversAsked = new Set<string>();
	/** The questions about servers that are open: one at a time, and each withdrawn when the turn is stopped or ends. */
	private readonly serverQuestions = new Set<AbortController>();
	private serverLine: Promise<void> = Promise.resolve();
	private readonly serverWaiters = new Set<() => void>();
	/** What the engine was started with, for asking the sandbox what the engine can see. */
	private engineEnv: Record<string, string> = {};
	/** Remember only names of injected secrets after start. */
	private engineSecrets = new Set<string>();
	private redactor: Redactor;
	private hostTools: ReadonlyMap<string, PlatformToolHandler> = new Map();
	/** True while this turn has servers of its own in that file: they are taken out when it ends. */
	private configWritten = false;
	private checks: TurnChecks | null = null;
	private personal = new Set<string>();
	private unasked = new Set<string>();
	/** Stop automatic approvals after taint when the caller requested that policy. */
	private taintSeen = false;
	/** The calls of the platform's tools that are being answered, by `<messageId>\n<callId>`: aborted when the engine settles one, or the turn ends. */
	private readonly hostCalls = new Map<string, AbortController>();
	/** The calls of a tool of a server in `unasked` the engine reported and has not settled. */
	private readonly unaskedCalls = new Map<string, TurnUnaskedCall>();
	/** Hold a possible secret prefix across chunks separately for each stream. */
	private readonly heldBack = new Map<string, string>();

	/** Windlass's code for `failure`, when the error it came from carried one (`data.windlass.code`). */
	private failureCode: string | null = null;
	private stepFailureCode: string | null = null;
	/** The message of the provider error of the model call that failed: with the model relay, it says whether the relay refused the lease (`relayRefused`). */
	private stepFailureMessage: string | null = null;
	private outputSeen = false;

	constructor(
		private readonly sandbox: TurnSandbox,
		private readonly input: RunTurnInput,
		private readonly options: TurnOptions,
	) {
		const mode = input.mode ?? sandbox.approval;
		if (mode !== "ask" && mode !== sandbox.approval)
			throw new Error("This sandbox profile does not offer that approval mode.");
		this.approval = mode;
		// A project definition takes precedence over a named user agent. Choose the name after checkout, on every open.
		const saved = input.reattach?.harness === "windlass" ? input.reattach.state : null;
		this.reviewerAgent = saved
			? (saved.reviewerAgent as string | null)
			: input.onReview || input.planner
				? `wlp-review-${randomId(16)}`
				: null;
		this.redactor = input.secrets?.redactor ?? NO_REDACTION;
		this.peer = new AcpConnection(
			line => this.process?.write(`${line}\n`) ?? false,
			{
				notification: (method, params) => this.notification(method, params),
				request: (method, params) => this.request(method, params),
			},
			NS,
			value => this.redactor.deep(value),
		);
		this.lines = new LineSplitter(line => this.peer.receive(line));
		if (input.onCheckpoint !== undefined) {
			try {
				input.onCheckpoint(() => this.checkpoint());
			} catch {
				// A listener's failure must not stop the turn.
			}
		}
	}

	private mark(mark: StartMark, ms?: number): void {
		try {
			this.input.onStartMark?.(mark, ms);
		} catch {
			// A listener's failure must not stop the turn.
		}
	}

	async run(): Promise<RunTurnResult> {
		const { sandbox, input } = this;
		const saved = input.reattach?.harness === "windlass" ? input.reattach.state : null;
		const scriptPath = saved
			? (saved.scriptPath as string | null)
			: input.script === undefined
				? null
				: `/tmp/.wlp-script-${randomId(6)}.json`;
		const configHome = this.reviewerAgent && `/tmp/${this.reviewerAgent}`;
		const agentFile = configHome && `${configHome}/windlass/agents/${this.reviewerAgent}.md`;
		// A ChatGPT plan turn's file holds only its relay's placeholder.
		const planFile = input.modelKey?.key.plan ? turnTokenFilePath(sandbox) : null;
		// What the turn leaves in the sandbox besides its processes.
		const files = [
			...(scriptPath === null ? [] : [scriptPath]),
			...(planFile === null ? [] : [planFile, `${planFile}.tmp`]),
			...(agentFile ? [agentFile] : []),
		];
		const onAbort = () => this.abort();
		let release: (() => Promise<void>) | null = null;
		try {
			// From the start: opening the plan's token can take a while (a refresh), and a stop must not wait for it.
			input.signal?.addEventListener("abort", onAbort, { once: true });
			if (input.signal?.aborted) this.abort();
			// Before anything is started in it: from here to the end of `finally` the provider keeps the sandbox running.
			release = await sandbox.holdForTurn().catch((error: unknown) => {
				this.failure = {
					reason: "engine",
					message: `the sandbox could not be kept running for the turn: ${errorText(error)}`,
				};
				return null;
			});
			if (release !== null && input.reattach !== undefined) {
				if (await this.takeUp(input.reattach)) {
					await this.whenOver;
					await this.end();
				}
			} else if (release !== null && (await this.prepare(scriptPath, agentFile)) && !this.abortRequested) {
				if (input.repoSetup && configHome) {
					// Relative paths keep reads inside the symlink-free checkout, including on an open machine.
					const filter =
						'.tool.arguments | type == "object" and ((.path // ".") | type == "string" and (startswith("/") or startswith("~") | not) and (split("/") | all(. != "..")))';
					await sandbox.writeTextFile(
						configHome + "/windlass/config.json",
						JSON.stringify({
							hooks: {
								beforeTool: [
									{
										name: "setup-files",
										tools: ["read", "ls"],
										sandbox: false,
										onError: "refuse",
										command: `/usr/bin/jq -e '${filter}' >/dev/null || { echo "Read a relative path inside the repository."; exit 2; }`,
									},
								],
							},
						}),
					);
				}
				const ref = input.modelKey;
				let keyEnv: Record<string, string> = {};
				if (ref) {
					const keyLease = (this.keyLease = await openModelKeyRelay(
						sandbox,
						ref.sessionId,
						{ ...ref.key, harness: "windlass" },
						input.signal,
						ref.takeRequest,
						ref.openSecret,
						ref.onSeen,
					));
					// A plan relay the runner keeps through a server's restart: the checkpoint names it.
					if (ref.key.plan && keyLease.lease !== undefined && sandbox.resumePlanRelay !== undefined)
						this.planLease = { lease: keyLease.lease, placeholder: keyLease.placeholder, env: keyLease.env };
					input.signal?.throwIfAborted();
					this.redactor = redactKeyLease(this.redactor, keyLease.placeholder);
					if (planFile !== null) {
						// Past the turn's end: the relay ends the placeholder with the turn, whatever the file says.
						const expiresAt = Date.now() + config.turnTimeoutMs + 15 * 60_000;
						await writePlanPlaceholder(sandbox, planFile, keyLease.placeholder, expiresAt);
						input.signal?.throwIfAborted();
						keyEnv = windlassPlanEnv(keyLease, planFile);
					} else keyEnv = hostedKeyEnv("windlass", ref.key, keyLease);
				}
				const lines = this.lines;
				const env = {
					// A server that lives for one turn must not start other sessions' wake-up turns, as the command line's one-prompt runs do not.
					WINDLASS_WAKE: "off",
					...(!ref && { WINDLASS_PROVIDER: "chatgpt" }),
					// A base setup may have written a user config with auto-start MCP servers.
					...(configHome ? { XDG_CONFIG_HOME: configHome } : {}),
					// Only warnings and errors on stderr: that is what `stderrTail` is for.
					WINDLASS_ACP_LOG: "warn",
					...(scriptPath === null ? {} : { WINDLASS_ACP_SCRIPT: scriptPath }),
				};
				// The repository's secrets that Windlass may have, for the MCP servers that name them: never one of the turn's own variables.
				const secretEnv = {
					...Object.fromEntries(Object.entries(input.secrets?.env ?? {}).filter(([name]) => !(name in env))),
					...keyEnv,
				};
				this.mark("process");
				const run = sandbox.start(this.options.engineCommand ?? ["windlass", "acp"], {
					env,
					secretEnv,
					onStdout: chunk => lines.push(chunk),
					onStderr: chunk => (this.stderr = (this.stderr + chunk).slice(-STDERR_KEPT)),
				});
				this.process = run;
				this.engineEnv = { ...env, WLP_RUN_TAG: run.tag };
				this.engineSecrets = new Set(Object.keys(secretEnv));
				this.follow(run);

				await this.converse();
				await this.end();
			}
		} finally {
			input.signal?.removeEventListener("abort", onAbort);
			clearTimeout(this.cancelTimer);
			clearTimeout(this.followUpTimer);
			const run = this.process;
			if (run !== null && !run.hasEnded) await this.stopProcess(true);
			// No more token replacements, and none in the middle of being written, before the placeholder file is removed.
			await this.keyLease?.close().catch(() => this.notes.push("[platform] could not close the model key relay"));
			if (run !== null) {
				// Whatever happened above, nothing of the turn stays behind in the sandbox. A process that ended on its own
				// after an orderly close has nothing left to wait for; one whose client was cut off may still be shutting down inside.
				const left = await sandbox
					.sweep(run.tag, { waitMs: this.orderly() ? 0 : WINDING_DOWN_MS, files })
					.catch(() => 0);
				if (left > 0) this.notes.push(`[platform] ${left} process(es) of the turn could not be stopped`);
			} else {
				await sandbox.removeFiles(files);
			}
			// With the engine gone: the servers it was handed for this turn are not left for the next, nor its deadline.
			await this.withdrawServers();
			if (this.input.endsAt !== undefined) await sandbox.removeFiles([TURN_DEADLINE_FILE]).catch(() => undefined);
			await release?.().catch(() => undefined);
		}

		const end = this.processEnd;
		// The turn counts as aborted when the abort is what ended it, not when it came after the turn's own end.
		const ownEnding = this.summary !== null && this.summary.outcome !== "interrupted";
		const aborted = this.abortRequested && !(ownEnding && !this.forced);
		const said = [...this.notes, this.stderr.trimEnd()];
		if (this.peer.notJson.length > 0) said.push(`[stdout, not protocol messages]\n${this.peer.notJson.join("\n")}`);
		const scrub = (text: string) => this.redactor.text(text);
		const stderrTail = said.filter(part => part !== "").join("\n");
		// A failure's sentence may quote the engine's last words: what the engine printed is scrubbed there as it is in the tail.
		const failure = aborted ? null : await this.told(this.failure);
		return {
			exitCode: end === null || end.signal !== null || this.signalled ? null : end.code,
			aborted,
			timedOut: false,
			windlassSessionId: this.sessionSeen,
			...(this.freshened && { resumed: false }),
			summary: this.summary,
			...(this.stopReason && { stopReason: this.stopReason }),
			stderrTail: scrub(stderrTail).slice(-STDERR_TAIL),
			failure: failure === null ? failure : { reason: failure.reason, message: scrub(failure.message) },
			...(this.checks === null ? {} : { checks: this.checks }),
		};
	}

	/** Classify a provider refusal by Windlass's stable error code. */
	private async told(failure: Failure | null): Promise<Failure | null> {
		if (failure === null) return failure;
		const code = this.failureCode ?? this.stepFailureCode;
		// The relay's own refusal of the turn's placeholder: never the user's sign-in.
		if (this.input.modelKey && relayRefused(code, failure.message, this.stepFailureMessage))
			return { ...RELAY_REFUSED };
		// On the ChatGPT plan the file holds a placeholder that outlasts the turn: a handed-in failure is the file's,
		// or the provider turning down the plan's token.
		const planProblem = this.input.modelKey?.key.plan && code !== null ? handedInProblem(code) : null;
		if (planProblem === null) return failure;
		return handedInFailure(planProblem, { expiresAt: Number.POSITIVE_INFINITY, problem: null, lapsed: false });
	}

	private async prepare(scriptPath: string | null, agentFile: string | null): Promise<boolean> {
		// One turn at a time per sandbox: a Windlass still running here is left over from a turn whose server or
		// client went away, and it would hold the session ("in use by another windlass process").
		const stopping = this.sandbox.stopLeftovers("windlass").then(count => {
			if (count > 0)
				this.notes.push(
					`[platform] stopped ${count} Windlass run(s) left over in this sandbox before starting the turn`,
				);
		});
		if (this.input.modelKey) {
			// Finish both cleanup steps before starting any file writer or opening a lease.
			try {
				await stopping;
				const tokenPath = this.input.modelKey.key.plan ? turnTokenFilePath(this.sandbox) : undefined;
				await sweepSessionProcesses(this.sandbox, tokenPath);
				if (this.abortRequested) return false;
			} catch (error) {
				this.failure = {
					reason: "engine",
					message: `the engine could not be started in the sandbox: ${errorText(error)}`,
				};
				return false;
			}
		}
		// A scripted turn can prepare its files while the previous Windlass is stopping.
		const [stopped, script, agent] = await Promise.allSettled([
			stopping,
			scriptPath === null ? undefined : this.sandbox.writeTextFile(scriptPath, JSON.stringify(this.input.script)),
			agentFile === null
				? undefined
				: this.sandbox.writeTextFile(
						agentFile,
						[
							"---",
							`name: ${this.reviewerAgent}`,
							this.input.planner
								? "description: Read the repository and plan the feature."
								: "description: Reviews this pull request independently.",
							this.input.onSetupReview
								? "tools: ls, read, file_repo_setup_review"
								: this.input.onSetup
									? "tools: ls, read, file_repo_setup"
									: this.input.repoSetup
										? "tools: ls, read, report"
										: this.input.planner
											? "disallowed-tools: write, edit, shell, subagent"
											: this.input.reviewDirectory
												? "disallowed-tools: write, edit, subagent"
												: "disallowed-tools: subagent",
							"---",
							this.input.planner
								? "Read the repository and file the requested artifact."
								: "Review the change yourself.",
							"",
						].join("\n"),
					),
		]);
		// The sandbox itself does not work (it is not running, a file cannot be written): that is not about anyone's sign-in.
		const setupError = [stopped, script, agent].find(result => result.status === "rejected");
		if (setupError?.status === "rejected") {
			this.failure = {
				reason: "engine",
				message: `the engine could not be started in the sandbox: ${errorText(setupError.reason)}`,
			};
			return false;
		}
		return true;
	}

	private get startTimeoutMs(): number {
		return this.options.startTimeoutMs ?? START_TIMEOUT_MS;
	}

	/** Whether the process ended on its own after an orderly close: then nothing of it can still be shutting down inside the sandbox. */
	private orderly(): boolean {
		return (
			this.processEnd !== null && this.processEnd.signal === null && this.processEnd.error === null && !this.signalled
		);
	}

	// ---- the conversation ----

	/** From `initialize` to the turn's end. Sets `failure` instead of throwing. */
	private async converse(): Promise<void> {
		const { input, peer } = this;
		try {
			const init = await this.unlessAborted(
				peer.request<Initialized>("initialize", INITIALIZE, { timeoutMs: this.startTimeoutMs }),
			);
			if (init === "aborted") return;
			this.mark("initialized");
			const offered = init.agentCapabilities?._meta?.[NS] as { notifications?: unknown } | undefined;
			if (!Array.isArray(offered?.notifications) || !offered.notifications.includes(EXT.event)) {
				this.failure = {
					reason: "engine",
					message: `the engine process does not send Windlass's events (${EXT.event}); it may be another version`,
				};
				return;
			}
			const openKeys = openKeysIn(init);
			this.promptKeys = promptKeysIn(init);
			if (input.repoSetup && input.untrusted?.length && !this.promptKeys.includes(UNTRUSTED_KEY)) {
				this.failure = {
					reason: "engine",
					message: "Update Windlass to a version that can mark imported notes as untrusted.",
				};
				return;
			}
			if (!openKeys.includes("hostTools")) {
				this.failure = {
					reason: "host_tools_required",
					message: "The sandbox needs Windlass 0.4.0 or later for host tools.",
				};
				return;
			}
			if (
				(input.onReview || input.planner) &&
				["agent", "children", "requiredChecks"].some(key => !openKeys.includes(key))
			) {
				this.failure = {
					reason: "engine",
					message: "This Windlass cannot open a restricted reviewer session with file_review.",
				};
				return;
			}
			this.hostTools = turnHostTools(input);
		} catch (error) {
			this.failure = { reason: "engine", message: await this.startFailure(error) };
			return;
		}

		// Before a session is opened: the engine reads its configuration then, and starts what its user's own file names.
		if ((await this.unlessAborted(this.writeDeadline())) === "aborted" || this.abortRequested) return;
		if ((await this.unlessAborted(this.writeServers())) === "aborted" || this.abortRequested) return;

		try {
			const opened = await this.unlessAborted(this.open());
			if (opened === "aborted" || this.abortRequested) return;
		} catch (error) {
			this.refused(error, "engine");
			return;
		}

		// The project's servers that wait for the user's approval, before the prompt goes: the turn starts with what was allowed.
		const asked = await this.unlessAborted(this.askAboutServers());
		if (asked === "aborted" || this.abortRequested || this.peer.closed) return;

		this.promptSent = true;
		this.mark("prompted");
		// The whole task, with its own sources, when the session this turn resumes was gone (`open`).
		const given =
			this.freshened && input.fresh
				? { ...input, prompt: input.fresh.prompt, untrusted: input.fresh.untrusted }
				: input;
		const prompt = {
			sessionId: this.session,
			prompt: [{ type: "text", text: given.prompt }],
			...promptMeta(given, this.promptKeys),
		};
		if (untrustedSource(given.untrusted) !== null && !this.promptKeys.includes(UNTRUSTED_KEY)) {
			try {
				input.onUntrustedUnmarked?.();
			} catch {
				// A listener's failure must not stop the turn.
			}
		}
		this.answered(peer.request<PromptResult>("session/prompt", prompt));
		this.promptId = peer.lastId;
		this.controlled();
		await this.whenOver;
	}

	private follow(run: SandboxProcess): void {
		void run.ended.then(end => {
			this.lines.flush();
			this.processEnd = end;
			this.peer.end(end.error !== null ? end.error.message : `the engine process ${describeEnd(end)}`);
			this.resolveInterrupted();
			this.finish();
		});
	}

	private controlled(): void {
		if (this.input.onControl === undefined) return;
		try {
			this.input.onControl(this.control());
		} catch {
			// A listener's failure must not stop the turn.
		}
	}

	/** Checkpoint a live, prompted, durable process synchronously before its prompt settles. */
	private checkpoint(): TurnCheckpoint | null {
		// A platform key lease ends with its owning process: start a fresh segment after a restart. A plan relay the runner
		// keeps on the machine is taken up with the process.
		if (this.input.modelKey && this.planLease === null) return null;
		// Until the process is taken up, what was stored stands: the output kept for it is not in the timeline yet.
		if (this.input.reattach !== undefined && !this.takenUp) return this.input.reattach;
		const run = this.process;
		const process = run?.runnerProcess;
		if (
			!run ||
			!process ||
			!this.promptSent ||
			this.promptSettled ||
			this.promptId === null ||
			this.over ||
			this.abortRequested ||
			this.cancelSent ||
			this.session === null
		)
			return null;
		return {
			harness: "windlass",
			process,
			tag: run.tag,
			state: {
				v: 1,
				acp: this.peer.state(),
				prompt: this.promptId,
				rest: this.lines.pending,
				session: this.session,
				sessionSeen: this.sessionSeen,
				promptKeys: this.promptKeys,
				undelivered: [...this.undelivered],
				delivered: [...this.delivered],
				tally: this.tally.save(),
				servers: this.servers,
				serversAsked: [...this.serversAsked],
				personal: [...this.personal],
				unasked: [...this.unasked],
				taintSeen: this.taintSeen,
				unaskedCalls: [...this.unaskedCalls],
				heldBack: [...this.heldBack],
				configWritten: this.configWritten,
				checks: this.checks,
				engineEnv: this.engineEnv,
				engineSecrets: [...this.engineSecrets],
				outputSeen: this.outputSeen,
				notes: this.notes,
				reviewerAgent: this.reviewerAgent,
				scriptPath: (this.engineEnv.WINDLASS_ACP_SCRIPT as string | undefined) ?? null,
				planRelay: this.planLease,
			},
		};
	}

	/** Adopt the runner's process and reconnect the pending prompt using its original request IDs. */
	private async takeUp(checkpoint: TurnCheckpoint): Promise<boolean> {
		const saved = checkpoint.state;
		const planLease = (saved.planRelay as import("./provider.js").PlanRelayLease | null | undefined) ?? null;
		if (
			checkpoint.harness !== "windlass" ||
			saved.v !== 1 ||
			this.sandbox.adopt === undefined ||
			(this.input.modelKey !== undefined &&
				(planLease === null || !this.input.modelKey.key.plan || this.sandbox.resumePlanRelay === undefined))
		) {
			this.failure = { reason: "engine", message: TAKE_UP_FAILED };
			return false;
		}
		// Everything the connection had before its output flows again: what the runner kept may hold the prompt's answer.
		this.lines.resume(String(saved.rest ?? ""));
		this.session = saved.session as string;
		this.sessionSeen = (saved.sessionSeen as string | null) ?? null;
		this.promptKeys = saved.promptKeys as string[];
		for (const id of saved.undelivered as string[]) this.undelivered.add(id);
		for (const id of saved.delivered as string[]) this.delivered.add(id);
		this.tally.load(saved.tally as Record<string, unknown>);
		this.servers = saved.servers as ServerState[];
		for (const key of saved.serversAsked as string[]) this.serversAsked.add(key);
		for (const name of saved.personal as string[]) this.personal.add(name);
		for (const name of saved.unasked as string[]) this.unasked.add(name);
		this.taintSeen = saved.taintSeen === true;
		for (const [key, call] of saved.unaskedCalls as Array<[string, TurnUnaskedCall]>) this.unaskedCalls.set(key, call);
		for (const [key, held] of saved.heldBack as Array<[string, string]>) this.heldBack.set(key, held);
		this.configWritten = saved.configWritten === true;
		this.checks = (saved.checks as TurnChecks | null) ?? null;
		this.engineEnv = saved.engineEnv as Record<string, string>;
		this.engineSecrets = new Set(saved.engineSecrets as string[]);
		this.outputSeen = saved.outputSeen === true;
		this.notes.push(...(saved.notes as string[]));
		this.hostTools = turnHostTools(this.input);
		const acp = saved.acp as ReturnType<AcpConnection["state"]>;
		this.peer.restore(acp.nextId);
		this.promptSent = true;
		this.promptId = saved.prompt as number;
		this.answered(this.peer.expect<PromptResult>(this.promptId, "session/prompt"));
		const run = this.sandbox.adopt(checkpoint.process, checkpoint.tag, {
			onStdout: chunk => this.lines.push(chunk),
			onStderr: chunk => (this.stderr = (this.stderr + chunk).slice(-STDERR_KEPT)),
		});
		if (!run) {
			this.failure = { reason: "engine", message: TAKE_UP_FAILED };
			this.peer.end(TAKE_UP_FAILED);
			return false;
		}
		this.process = run;
		this.takenUp = true;
		this.follow(run);
		if (planLease !== null && this.input.modelKey) {
			try {
				await this.resumePlan(planLease);
			} catch (error) {
				this.failure = {
					reason: "engine",
					message: `the engine's plan relay could not be handed its token again: ${errorText(error)}`,
				};
				this.abort();
				return true;
			}
		}
		for (const [id, method, params] of acp.incoming) this.peer.answerAgain(id, method, params);
		this.controlled();
		return true;
	}

	/**
	 * Takes up the plan relay the runner kept on the machine (`resumePlanRelay`) and hands it the plan's current token
	 * again, which moves its end on for the turn's new window, then keeps it on the plan (`rotatePlanToken`). Closed
	 * with the turn, as when it was opened; a plan reconnected or removed meanwhile closes it now and fails the turn.
	 */
	private async resumePlan(planLease: import("./provider.js").PlanRelayLease): Promise<void> {
		const ref = this.input.modelKey!;
		const relay = this.sandbox.resumePlanRelay!(planLease, ref.onSeen);
		this.keyLease = relay;
		this.planLease = planLease;
		this.redactor = redactKeyLease(this.redactor, relay.placeholder);
		if (!ref.openSecret) throw new Error("A plan turn on this sandbox needs its secret opened for the turn.");
		const opened = await ref.openSecret();
		if (!opened) {
			await relay.close();
			throw new Error("the plan for this turn changed or was removed");
		}
		await relay.hand(opened.secret);
		this.keyLease = rotatePlanToken(relay, opened.expiresAt, ref.openSecret);
	}

	private answered(request: Promise<PromptResult>): void {
		void request.then(
			result => {
				const turn = result?._meta?.[NS] as { executionId?: unknown; outcome?: unknown } | undefined;
				const outcome =
					typeof turn?.outcome === "string" &&
					["succeeded", "unresolved", "failed", "interrupted"].includes(turn.outcome)
						? (turn.outcome as Outcome)
						: result?.stopReason === "cancelled"
							? "interrupted"
							: null;
				this.stopReason = typeof result?.stopReason === "string" ? result.stopReason : undefined;
				this.promptEnding = {
					executionId: typeof turn?.executionId === "string" ? turn.executionId : null,
					outcome,
					stepLimit: result?.stopReason === "max_turn_requests",
				};
				this.promptSettled = true;
				this.check();
			},
			(error: unknown) => {
				// A connection that ended is told by the process's end; a session closed under the prompt is this turn's own doing.
				if (!(error instanceof AcpError && (error.reason === "closed" || error.code === -32800)))
					this.refused(error, "execution_failed");
				this.promptSettled = true;
				this.check();
			},
		);
	}

	/** `session/new`, or the session to continue: named with `_windlass/resolve`, opened with `session/resume`. */
	private async open(): Promise<void> {
		const { input, peer } = this;
		const meta = {
			...(input.modelKey && { provider: sessionProvider(input.modelKey.key) }),
			...(input.model === undefined ? {} : { model: input.model }),
			...(input.effort === undefined ? {} : { effort: input.effort }),
			approval: this.approval,
			...turnAgentMeta(this.reviewerAgent, input.clearPlanner),
			// Whether anyone can answer a question. Without someone, a call that would ask is refused at once and the model is told.
			attended: input.onQuestion !== undefined,
			unattended: "deny",
			sandboxHome: SANDBOX_HOME,
			// Reviewer commands use the image's read-only ~/.config/pnpm, while the engine uses its private config.
			withholdEnv: [
				"WINDLASS_PROVIDER",
				...(input.secrets?.withholdEnv ?? []),
				...(this.reviewerAgent ? ["XDG_CONFIG_HOME"] : []),
			],
			passEnv: input.secrets?.passEnv ?? [],
			requiredChecks: windlassChecks(input.checks ?? []),
			...hostToolsMeta(this.hostTools, input.reportScreenshots, input.crossRepoPlan),
		};
		if (input.windlassSessionId !== undefined) {
			try {
				await this.resumeSession(input.windlassSessionId, meta);
				input.onHostTools?.(meta.hostTools.map(tool => tool.name));
				return;
			} catch (error) {
				// Either the lookup or the open can discover that the saved conversation is gone.
				if (!input.fresh || !(error instanceof AcpError) || this.failureOf(error).reason !== "session_not_found")
					throw error;
			}
		}
		const made = await peer.request<{ sessionId?: unknown }>(
			"session/new",
			sessionOpenParams(input.reviewDirectory ?? this.sandbox.cwd, meta),
			{ timeoutMs: OPEN_TIMEOUT_MS },
		);
		if (typeof made?.sessionId !== "string")
			throw new AcpError("the engine opened a session without naming it", 0, null);
		if (input.windlassSessionId !== undefined) {
			this.freshened = true;
			this.notes.push(
				"[platform] the engine no longer had the session this turn resumes; a new one was opened with the whole task",
			);
		}
		this.adopt(made.sessionId);
		input.onHostTools?.(meta.hostTools.map(tool => tool.name));
	}

	private async resumeSession(prior: string, meta: Record<string, unknown>): Promise<void> {
		const peer = this.peer;
		const named = await peer.request<{ sessionId?: unknown; cwd?: unknown }>(
			EXT.resolve,
			{ cwd: this.sandbox.cwd, session: prior },
			{ timeoutMs: OPEN_TIMEOUT_MS },
		);
		const sessionId = typeof named?.sessionId === "string" ? named.sessionId : prior;
		const cwd = typeof named?.cwd === "string" ? named.cwd : this.sandbox.cwd;
		// Before the answer: what the open itself appends (a crashed turn's recovery) arrives ahead of it.
		this.adopt(sessionId);
		const deadline = Date.now() + WINDING_DOWN_MS;
		let told = false;
		for (;;) {
			try {
				// `archived: true` as the command line's --session: a session is opened whether or not it was archived.
				await peer.request(
					"session/resume",
					{ sessionId, cwd, mcpServers: [], _meta: { [NS]: { ...meta, archived: true } } },
					{ timeoutMs: OPEN_TIMEOUT_MS },
				);
				return;
			} catch (error) {
				// Right after a turn was cut off, its engine may still be letting go of the session: that is waited for, as
				// the command line does. A session held by anything else is refused at once.
				if (
					!(error instanceof AcpError) ||
					error.reason !== "session_in_use" ||
					error.holderPid === null ||
					this.abortRequested
				)
					throw error;
				if (Date.now() > deadline || !(await this.windingDown(error.holderPid))) throw error;
				if (!told)
					this.notes.push(
						`[platform] the session was still held by the engine of an earlier turn (pid ${error.holderPid}); waited for it to shut down`,
					);
				told = true;
				await sleep(200);
			}
		}
	}

	/** Whether `pid` in the sandbox is an engine (`windlass acp`): one that is not this turn's can only be an earlier turn's, on its way out. */
	private async windingDown(pid: number): Promise<boolean> {
		const result = await this.sandbox.ask(
			["sh", "-c", 'tr "\\0" "\\n" < "/proc/$1/cmdline" | tail -n 1', "sh", String(pid)],
			{ timeoutMs: 10_000 },
		);
		return result !== null && result.code === 0 && result.stdout.trim() === "acp";
	}

	private adopt(sessionId: string): void {
		this.session = sessionId;
		const early = this.early;
		this.early = [];
		for (const item of early) if (item.sessionId === sessionId) this.event(item.event);
	}

	private control(): TurnControl {
		const ended = () => new Error("the turn has ended");
		return {
			steer: async text => {
				if (this.over) throw ended();
				if (this.cancelSent) throw new Error("the turn is being stopped");
				this.steersInFlight += 1;
				try {
					const admitted = await this.peer.request<{ messageId?: unknown }>(EXT.steer, {
						sessionId: this.session,
						prompt: [{ type: "text", text }],
					});
					if (typeof admitted?.messageId === "string" && !this.delivered.has(admitted.messageId))
						this.undelivered.add(admitted.messageId);
				} catch (error) {
					throw this.over ? ended() : new Error(errorText(error));
				} finally {
					this.steersInFlight -= 1;
					this.check();
				}
			},
			cancelCall: async (messageId, callId) => {
				if (this.over) throw ended();
				try {
					const result = await this.peer.request<{ stopped?: unknown; message?: unknown }>(EXT.cancelCall, {
						sessionId: this.session,
						callId,
						messageId,
					});
					return {
						stopped: result?.stopped === true,
						message: typeof result?.message === "string" ? result.message : null,
					};
				} catch (error) {
					throw this.over ? ended() : new Error(errorText(error));
				}
			},
		};
	}

	// ---- what the engine sends ----

	private notification(method: string, params: Record<string, unknown>): void {
		// Windlass's ACP titles include its first-line fallback; the generated title comes as `session.renamed` (`event`).
		if (method === "session/update") return;
		if (method === EXT.mcpChanged) {
			if (params.sessionId === this.session) this.serversSaid(params);
			return;
		}
		if (method !== EXT.event) return;
		const event = params.event as WindlassEvent | undefined;
		if (
			typeof params.sessionId !== "string" ||
			typeof event !== "object" ||
			event === null ||
			typeof event.type !== "string"
		)
			return;
		// History a load would replay: never part of this turn.
		if (params.replay === true) return;
		if (this.session === null) this.early.push({ sessionId: params.sessionId, event });
		else if (params.sessionId === this.session) this.event(event);
	}

	private event(event: WindlassEvent): void {
		if (this.sealed) return;
		// The model's first output of the turn: text, thinking, or a tool call it began.
		if (this.promptSent && !this.outputSeen && OUTPUT_EVENTS.has(event.type)) {
			this.outputSeen = true;
			this.mark("output");
		}
		if (this.sessionSeen === null && typeof event.sessionId === "string") this.sessionSeen = event.sessionId;
		this.tally.note(event);
		const data = (event.data ?? {}) as Record<string, unknown>;
		if (
			this.input.modelKey &&
			event.type === "inbox.enqueued" &&
			typeof data.titlePrompt === "string" &&
			data.titlePrompt.trim()
		)
			this.titleDeadline = Date.now() + 35_000;
		if (event.type === "session.renamed") {
			if (data.generated === true && typeof data.title === "string")
				this.input.onAcpUpdate?.({ sessionUpdate: "session_info_update", title: data.title });
			this.resolveTitle();
		}
		if ((event.type === "inbox.delivered" || event.type === "inbox.cancelled") && typeof data.messageId === "string") {
			this.delivered.add(data.messageId);
			this.undelivered.delete(data.messageId);
		}
		// Why the model call the turn is at failed, as Windlass names it: a code, when it has one.
		if (event.type === "step.started") {
			this.stepFailureCode = null;
			this.stepFailureMessage = null;
		}
		if (event.type === "step.failed") {
			const provider = (data.error as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
			this.stepFailureCode = typeof provider?.code === "string" && provider.code !== "" ? provider.code : null;
			this.stepFailureMessage = typeof provider?.message === "string" ? provider.message.slice(0, 4096) : null;
		}
		// The engine has withdrawn what was pending: a question may be answered `cancelled` now.
		if (event.type === "execution.interrupt_requested") this.resolveInterrupted();
		const out = this.streamed(event);
		try {
			if (out !== null) this.input.onEvent?.(out);
		} catch {
			// A listener's failure must not stop the turn.
		}
		// Windlass gave up on a call of the platform's (stopped, or out of time): nobody waits for its answer.
		if (event.type === "tool.settled") this.hostCalls.get(callKey(data.messageId, data.callId))?.abort();
		this.callingUnasked(event);
		this.check();
	}

	// ---- the servers the platform hands the engine: the user's own ----

	/** Read managed and project configuration together. Treat missing files as null. */
	private async readConfiguration(): Promise<{
		config: string | null;
		written: string | null;
		project: string | null;
	} | null> {
		const mark = `wlp-${randomId(12)}`;
		const script =
			'mark=$1; shift; for file in "$@"; do if [ ! -e "$file" ]; then echo absent; elif [ -f "$file" ] && [ -r "$file" ]; then echo file; cat -- "$file"; else echo other; fi; printf "\\n%s\\n" "$mark"; done';
		// The session's directory is the workspace, which is where Windlass looks for a project's file first.
		const said = await this.sandbox.ask(
			[
				"sh",
				"-c",
				script,
				"sh",
				mark,
				WINDLASS_CONFIG_FILE,
				PLATFORM_SERVERS_FILE,
				`${this.sandbox.cwd}/.windlass/config.json`,
			],
			{ timeoutMs: DEFINITION_TIMEOUT_MS },
		);
		if (said === null || said.code !== 0) return null;
		const parts = said.stdout.split(`\n${mark}\n`);
		if (parts.length < 4) return null;
		const read = (part: string): string | null | undefined => {
			const end = part.indexOf("\n");
			const kind = end === -1 ? part : part.slice(0, end);
			return kind === "absent" ? null : kind === "file" ? part.slice(end + 1) : undefined;
		};
		const config = read(parts[0] as string);
		if (config === undefined) return null;
		// A list that is not a file counts as none: only what it names is ever taken out. So does a project's file that is not one.
		return { config, written: read(parts[1] as string) ?? null, project: read(parts[2] as string) ?? null };
	}

	/** Write the managed-name list first: over-reporting names is recoverable, missing one can leave a stale server installed. */
	private async storeConfiguration(next: PlatformConfig, had: { written: string | null }): Promise<void> {
		if (next.written !== null) await this.sandbox.writeTextFile(PLATFORM_SERVERS_FILE, next.written);
		if (next.changed) await this.sandbox.writeTextFile(WINDLASS_CONFIG_FILE, next.config);
		if (next.written === null && had.written !== null) await this.sandbox.removeFiles([PLATFORM_SERVERS_FILE]);
	}

	/** Use the sandbox clock for its shell deadline; a failed write must not leave an earlier deadline in force. */
	private async writeDeadline(): Promise<void> {
		const endsAt = this.input.endsAt;
		if (endsAt === undefined) return;
		const left = Math.max(0, Math.floor((endsAt - Date.now()) / 1000));
		const script = 'mkdir -p "$(dirname "$2")" && echo $(( $(date +%s) + $1 )) > "$2.tmp" && mv -f "$2.tmp" "$2"';
		const said = await this.sandbox
			.ask(["sh", "-c", script, "sh", String(left), TURN_DEADLINE_FILE], { timeoutMs: DEFINITION_TIMEOUT_MS })
			.catch(() => null);
		if (said === null || said.code !== 0) await this.sandbox.removeFiles([TURN_DEADLINE_FILE]).catch(() => undefined);
	}

	private async writeServers(): Promise<void> {
		// The platform's own name is not a user's to have, whatever was saved.
		const personal: ConfigServer[] = (this.input.servers ?? [])
			.filter(server => !isReservedServerName(server.name))
			.map(({ name, definition }) => ({ name, definition }));
		const missed = personal.length > 0 ? "your own MCP servers were not started" : "";
		this.checks = { project: null };
		try {
			const had = await this.readConfiguration();
			if (had === null) {
				if (missed !== "")
					this.notes.push(`[platform] Windlass's configuration file in the sandbox could not be read, so ${missed}`);
				return;
			}
			this.checks = { project: projectChecks(had.project) };
			const next = platformConfig(had.config, had.written, personal);
			if (next === null) {
				if (missed !== "")
					this.notes.push(
						`[platform] Windlass's configuration file in the sandbox could not be read as one, so ${missed}`,
					);
				return;
			}
			await this.storeConfiguration(next, had);
			this.configWritten = next.written !== null;
			this.personal = new Set(personal.map(server => server.name));
			this.unasked = this.taintSeen
				? new Set()
				: new Set(
						(this.input.servers ?? [])
							.filter(server => server.unasked === true && this.personal.has(server.name))
							.map(server => server.name),
					);
		} catch (error) {
			if (missed !== "")
				this.notes.push(
					`[platform] Windlass's configuration file in the sandbox could not be written (${errorText(error)}), so ${missed}`,
				);
		}
	}

	private async withdrawServers(): Promise<void> {
		if (!this.configWritten) return;
		this.configWritten = false;
		try {
			const had = await this.readConfiguration();
			const next = had === null ? null : platformConfig(had.config, had.written, []);
			if (had !== null && next !== null) await this.storeConfiguration(next, had);
		} catch {
			// The sandbox is gone, or stopped: the next turn takes out what this one left.
		}
	}

	/** Only a session-owned tool call on a user-owned server may bypass an approval question. */
	private callingUnasked(event: WindlassEvent): void {
		if (event.type === "taint.noticed" && this.input.unaskedUntilTainted === true) {
			this.taintSeen = true;
			this.unasked.clear();
			this.unaskedCalls.clear();
		}
		if (this.unasked.size === 0 || (event.type !== "tool.called" && event.type !== "tool.settled")) return;
		const data = (event.data ?? {}) as Record<string, unknown>;
		if (typeof data.messageId !== "string" || typeof data.callId !== "string") return;
		const key = callKey(data.messageId, data.callId);
		if (event.type === "tool.settled") {
			this.unaskedCalls.delete(key);
			return;
		}
		const call = mcpCall(data.name, data.input);
		if (
			call === null ||
			!this.unasked.has(call.server) ||
			!this.servers.some(server => server.name === call.server && server.origin === "user")
		)
			return;
		this.unaskedCalls.set(key, {
			messageId: data.messageId,
			callId: data.callId,
			server: call.server,
			tool: call.tool,
		});
	}

	/** Hold incomplete secret prefixes between stream chunks and flush them when the stream ends. */
	private streamed(event: WindlassEvent): WindlassEvent | null {
		const redactor = this.redactor;
		if (!redactor.active) return event;
		const field = event.type === "tool.input.delta" ? "input" : "text";
		const piece = STREAMED.has(event.type) ? event[field] : undefined;
		if (typeof piece === "string") {
			const key = `${typeof event.messageId === "string" ? event.messageId : ""}\n${typeof event.callId === "string" ? event.callId : ""}\n${event.type}`;
			const whole = redactor.text((this.heldBack.get(key) ?? "") + piece);
			const held = redactor.held(whole);
			if (held === 0) this.heldBack.delete(key);
			else this.heldBack.set(key, whole.slice(whole.length - held));
			if (held === whole.length) return null;
			return { ...event, [field]: held === 0 ? whole : whole.slice(0, whole.length - held) };
		}
		const data = (typeof event.data === "object" && event.data !== null ? event.data : {}) as {
			messageId?: unknown;
			callId?: unknown;
		};
		if (typeof data.messageId === "string" && this.heldBack.size > 0) {
			const streams = `${data.messageId}\n${typeof data.callId === "string" ? data.callId : ""}\n`;
			for (const key of [...this.heldBack.keys()]) if (key.startsWith(streams)) this.heldBack.delete(key);
		}
		return event;
	}

	private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
		if (method === "session/request_permission") return this.permission(params);
		if (method === EXT.hostCall) return this.hostCall(params);
		// The client's file system and terminal: Windlass's tools run inside the agent and never ask for them.
		throw new MethodNotFound(method);
	}

	/** Deliver only to this turn's declared tool while the session is active; abort the callback on settlement or turn end. */
	private async hostCall(params: Record<string, unknown>): Promise<unknown> {
		const refused = (output: string) => ({ status: "error", output });
		const run = typeof params.name === "string" ? this.hostTools.get(params.name) : undefined;
		if (params.sessionId !== this.session || this.over || this.cancelSent) return refused(CALL_AFTER_TURN);
		if (run === undefined) return refused(CALL_UNKNOWN);
		// Windlass names a call `<messageId>/<callId>`, as the turn's events name it apart.
		const id = typeof params.toolCallId === "string" ? params.toolCallId : "";
		const at = id.indexOf("/");
		const call: TurnPublishRequest = {
			messageId: at > 0 ? id.slice(0, at) : "",
			callId: at > 0 ? id.slice(at + 1) : id,
			arguments: callArguments(params.input),
		};
		const key = callKey(call.messageId, call.callId);
		const controller = new AbortController();
		this.hostCalls.get(key)?.abort();
		this.hostCalls.set(key, controller);
		try {
			const done = await runPlatformTool(run, call, controller.signal);
			return done.ok ? { status: "success", output: done.output } : refused(done.output);
		} finally {
			if (this.hostCalls.get(key) === controller) this.hostCalls.delete(key);
		}
	}

	/**
	 * A tool call's approval question. Anything else the engine asks this way (the hand-edit question of
	 * an undo, which this layer never starts) is declined.
	 */
	private async permission(params: Record<string, unknown>): Promise<unknown> {
		const cancelled = { outcome: { outcome: "cancelled" } };
		const question = questionOf(params);
		const ask = this.input.onQuestion;
		if (question !== null && params.sessionId === this.session && !this.cancelSent && !this.over) {
			const key = callKey(question.messageId, question.callId);
			// A call of a tool of one of the user's own servers whose tools run without asking: answered for the user
			// where the question is the session's own and about using exactly that tool, and whoever keeps a record is told.
			const unasked = this.unaskedCalls.get(key);
			const allowed =
				unasked !== undefined &&
				question.subagent === null &&
				toolAsked(params) === `${unasked.server}/${unasked.tool}`;
			if (allowed) {
				const allow =
					question.choices.find(choice => choice.approve && choice.remembers === null) ??
					question.choices.find(choice => choice.approve);
				if (allow !== undefined) {
					try {
						this.input.onUnasked?.(unasked);
					} catch {
						// A listener's failure must not stop the turn.
					}
					return { outcome: { outcome: "selected", optionId: allow.id } };
				}
			}
		}
		if (question === null || ask === undefined || params.sessionId !== this.session) return cancelled;
		const controller = new AbortController();
		const withdrawn = new Promise<null>(resolve =>
			controller.signal.addEventListener("abort", () => resolve(null), { once: true }),
		);
		this.questions.add(controller);
		const before = this.questionLine;
		let done = () => {};
		this.questionLine = new Promise<void>(resolve => (done = resolve));
		try {
			if (this.cancelSent || this.over) controller.abort();
			await Promise.race([before, withdrawn]);
			let answer: TurnAnswer | null = null;
			if (!controller.signal.aborted) {
				answer = await Promise.race([
					Promise.resolve()
						.then(() => ask(question, controller.signal))
						.catch(() => null),
					withdrawn,
				]);
			}
			if (controller.signal.aborted) {
				// Answered once the engine has withdrawn the question: sooner, the answer could overtake the cancel
				// inside the engine and be recorded as the user's refusal.
				await this.whenInterrupted;
				return cancelled;
			}
			// A rejection, or a choice the question does not offer: declined, which is what a cancelled request means to Windlass.
			if (
				answer === null ||
				typeof answer !== "object" ||
				!question.choices.some(choice => choice.id === answer.choice)
			)
				return cancelled;
			const note = typeof answer.note === "string" ? answer.note.trim() : "";
			return {
				outcome: { outcome: "selected", optionId: answer.choice },
				...(note === "" ? {} : { _meta: { [NS]: { note } } }),
			};
		} finally {
			this.questions.delete(controller);
			done();
		}
	}

	// ---- the project's MCP servers ----

	/** Resolve waiting definitions before sending the first prompt. Approval may expose another waiting definition. */
	private async askAboutServers(): Promise<void> {
		// Also asked for the servers whose tools run without asking: whose a server is, by the engine's word, decides whether a call is acted on.
		if (this.input.onServerQuestion === undefined && this.input.onServers === undefined && this.unasked.size === 0)
			return;
		try {
			await this.peer.request(
				EXT.mcp,
				{ sessionId: this.session },
				{ timeoutMs: SERVERS_TIMEOUT_MS, onResult: list => this.serversSaid(list) },
			);
		} catch (error) {
			if (!(error instanceof AcpError && error.reason === "closed")) {
				this.notes.push(
					`[platform] Windlass did not say which MCP servers of the project wait for approval (${errorText(error)}); none was asked about`,
				);
			}
			return;
		}
		for (let line: Promise<void> | null = null; line !== this.serverLine; ) {
			line = this.serverLine;
			await line;
		}
	}

	/** Publish the full list before asking about new definitions. */
	private serversSaid(raw: unknown): void {
		const servers = serversOf(raw);
		if (servers === null) return;
		this.servers = servers;
		for (const wake of [...this.serverWaiters]) wake();
		if (this.over) return;
		try {
			this.input.onServers?.(servers.flatMap(server => describeServer(server, this.personal)));
		} catch {
			// A listener's failure must not stop the turn.
		}
		if (this.input.onServerQuestion === undefined) return;
		for (const server of servers) {
			if (server.state !== "awaiting_approval" || server.fingerprint === null) continue;
			const key = `${server.name}:${server.fingerprint}`;
			if (this.serversAsked.has(key)) continue;
			this.serversAsked.add(key);
			this.serverLine = this.serverLine.then(() => this.askServer(server)).catch(() => undefined);
		}
	}

	private async askServer(server: ServerState): Promise<void> {
		const ask = this.input.onServerQuestion;
		const gone = () => this.over || this.abortRequested || this.cancelSent || this.peer.closed;
		if (ask === undefined || gone() || !this.stillWaits(server)) return;
		const controller = new AbortController();
		const withdrawn = new Promise<null>(resolve =>
			controller.signal.addEventListener("abort", () => resolve(null), { once: true }),
		);
		this.serverQuestions.add(controller);
		try {
			const reads = await Promise.race([this.variablesOf(server), withdrawn]);
			// Meanwhile the turn may have ended, or the definition changed: then this one is no longer the question.
			if (reads === null || gone() || !this.stillWaits(server)) return;
			const question: TurnServerQuestion = {
				name: server.name,
				fingerprint: server.fingerprint ?? "",
				argv: server.argv,
				url: server.argv === null ? server.target : null,
				file: server.file,
				unset: reads.unset,
				secrets: reads.secrets,
				holdsTurn: !this.promptSent,
			};
			const start = await Promise.race([
				Promise.resolve()
					.then(() => ask(question, controller.signal))
					.catch(() => false),
				withdrawn,
			]);
			if (controller.signal.aborted || start !== true) return;
			const outcome = await this.approveServer(question);
			try {
				this.input.onServerApproved?.(question, outcome);
			} catch {
				// A listener's failure must not stop the turn.
			}
		} finally {
			this.serverQuestions.delete(controller);
		}
	}

	private stillWaits(server: ServerState): boolean {
		return this.servers.some(
			now => now.name === server.name && now.state === "awaiting_approval" && now.fingerprint === server.fingerprint,
		);
	}

	/** `_windlass/mcp_approve`, and what became of the server: Windlass starts it at once and says so (`_windlass/mcp_changed` comes before the answer). */
	private async approveServer(question: TurnServerQuestion): Promise<TurnServerOutcome> {
		let answer: { approved?: unknown } | null;
		try {
			answer = await this.peer.request<{ approved?: unknown } | null>(
				EXT.mcpApprove,
				{ sessionId: this.session, name: question.name, fingerprint: question.fingerprint },
				{ timeoutMs: SERVERS_TIMEOUT_MS, onResult: list => this.serversSaid(list) },
			);
		} catch (error) {
			return { state: "refused", reason: errorText(error) };
		}
		// No such server waited: the definition changed after the question was put.
		if (answer?.approved !== true) return { state: "changed" };
		const deadline = Date.now() + SERVER_START_WAIT_MS;
		for (;;) {
			const now = this.servers.find(server => server.name === question.name);
			if (now?.state === "running") return { state: "running", tools: now.tools ?? 0 };
			if (now?.state === "failed" || now?.state === "stopped")
				return { state: "failed", reason: now.error ?? "Windlass gave no reason" };
			const left = deadline - Date.now();
			if (left <= 0 || this.over || this.peer.closed) return { state: "starting" };
			await this.serversChange(left);
		}
	}

	/** Resolves when Windlass next says its servers changed, the turn is over, or `ms` have passed. */
	private serversChange(ms: number): Promise<void> {
		return new Promise<void>(resolve => {
			const done = () => {
				clearTimeout(timer);
				this.serverWaiters.delete(done);
				resolve();
			};
			const timer = setTimeout(done, ms);
			this.serverWaiters.add(done);
			void this.whenOver.then(done);
		});
	}

	/** Report names of missing variables and supplied secrets, never their values. */
	private async variablesOf(server: ServerState): Promise<{ unset: string[]; secrets: string[] }> {
		const none = { unset: [], secrets: [] };
		try {
			if (server.file === null || !server.file.startsWith("/")) return none;
			const file = await this.sandbox.ask(["cat", "--", server.file], { timeoutMs: DEFINITION_TIMEOUT_MS });
			if (file === null || file.code !== 0) return none;
			const names = variablesRead(file.stdout, server.name);
			const secrets = names.filter(name => this.engineSecrets.has(name));
			const others = names.filter(name => !this.engineSecrets.has(name) && !(name in this.engineEnv));
			if (others.length === 0) return { unset: [], secrets };
			const said = await this.sandbox.ask(
				["sh", "-c", 'for name in "$@"; do printenv "$name" >/dev/null || echo "$name"; done', "sh", ...others],
				{ timeoutMs: DEFINITION_TIMEOUT_MS },
			);
			if (said === null || said.code !== 0) return { unset: [], secrets };
			const unset = new Set(said.stdout.split("\n").map(line => line.trim()));
			return { unset: others.filter(name => unset.has(name)), secrets };
		} catch {
			return none;
		}
	}

	// ---- how the turn ends ----

	/**
	 * The turn is over when its prompt was answered, nothing steered in is still on its way, and no
	 * execution runs. A message Windlass admitted a moment after the execution ended starts another one
	 * (it is the same to Windlass as a prompt sent while idle): that one is this turn's too, and is
	 * waited for, so no message the user was told had been taken is cut off.
	 */
	private check(): void {
		if (this.over || !this.promptSettled || this.steersInFlight > 0 || this.tally.running !== null) return;
		const endedWell =
			this.tally.last !== null && (this.tally.last.outcome === "succeeded" || this.tally.last.outcome === "unresolved");
		if (this.undelivered.size > 0 && endedWell && !this.cancelSent) {
			// Its `execution.started` is on its way. Should it not come, the message stays in Windlass's inbox for the next turn.
			this.followUpTimer ??= setTimeout(() => {
				this.followUpTimer = undefined;
				if (this.tally.running === null && this.steersInFlight === 0) this.finish();
			}, FOLLOW_UP_MS);
			return;
		}
		this.finish();
	}

	private finish(): void {
		if (this.over) return;
		this.over = true;
		clearTimeout(this.cancelTimer);
		clearTimeout(this.followUpTimer);
		for (const question of this.questions) question.abort();
		for (const question of this.serverQuestions) question.abort();
		for (const call of this.hostCalls.values()) call.abort();
		// Without a cancel there is no interrupt to wait for before a question left open is answered.
		if (!this.cancelSent) this.resolveInterrupted();
		this.resolveOver();
	}

	private abort(): void {
		// Once the turn's work is over there is nothing left to stop: it ended as it ended.
		this.resolveTitle();
		if (this.abortRequested || this.over) return;
		this.abortRequested = true;
		this.resolveAborted();
		// A question about a server is the platform's own to withdraw: Windlass waits for nothing there.
		for (const question of this.serverQuestions) question.abort();
		if (this.input.signal?.reason === PLATFORM_RESTART) {
			// Windlass records a shutdown in the shell result and suspends its execution until the next prompt.
			// Wait for its final events even if the pending prompt is answered before session/close.
			void this.closeSession().then(() => this.finish());
		} else if (this.promptSent) this.cancel();
	}

	/** `session/cancel`: the turn is interrupted, a pending question is withdrawn, and the prompt is answered `cancelled`. */
	private cancel(): void {
		if (this.cancelSent || this.over) return;
		this.cancelSent = true;
		this.peer.notify("session/cancel", { sessionId: this.session });
		// The question's signal aborts at once, so whoever shows it can close it; its answer follows the engine's interrupt.
		for (const question of this.questions) question.abort();
		setTimeout(() => this.resolveInterrupted(), CANCEL_ANSWER_MS).unref();
		this.cancelTimer = setTimeout(() => {
			this.forced = true;
			this.finish();
		}, CANCEL_WAIT_MS);
		this.check();
	}

	private unlessAborted<T>(work: Promise<T>): Promise<T | "aborted"> {
		// The work is not waited for after an abort; its failure then is nobody's.
		work.catch(() => undefined);
		return Promise.race([work, this.whenAborted]);
	}

	private async end(): Promise<void> {
		this.finish();
		// An approval on its way to Windlass is reported before the turn is: its question was withdrawn above, so this is short.
		await within(this.serverLine, SERVERS_TIMEOUT_MS);
		const titleMs = this.titleDeadline - Date.now();
		if (titleMs > 0 && !this.abortRequested && this.tally.running === null && !this.failure && this.process)
			await within(Promise.race([this.titled, this.process.ended]), titleMs);
		await this.closeSession();
		this.seal();
		await this.stopProcess(false);
	}

	private seal(): void {
		if (this.sealed) return;
		const last = this.tally.last;
		// With an execution still at work the turn was cut off before Windlass said how it ended: no summary then.
		if (last !== null && this.tally.running === null) {
			// How the prompt's answer says its execution ended; an execution a late message started has only its own event.
			const answered =
				this.promptEnding !== null &&
				(this.promptEnding.executionId === null || this.promptEnding.executionId === last.executionId)
					? this.promptEnding
					: null;
			const summary = this.tally.summary(answered?.outcome ?? null);
			if (summary !== null) {
				if (answered?.stepLimit && this.input.maxSteps !== undefined) summary.stepLimit = this.input.maxSteps;
				this.summary = summary;
				try {
					this.input.onEvent?.(summary);
				} catch {
					// A listener's failure must not stop the turn.
				}
			}
			// A failed execution the prompt's answer did not report (the one a late message started).
			if (last.outcome === "failed" && this.failure === null)
				this.failure = { reason: "execution_failed", message: last.message ?? "the turn failed" };
		}
		this.sealed = true;
		if (this.failure === null && this.processEnd !== null && !this.abortRequested && this.summary === null) {
			// A process the sandbox layer ended itself carries its sentence (a machine removed, its runner restarted): that is what a person can act on.
			const end = this.processEnd;
			this.failure = {
				reason: "engine",
				message:
					end.error !== null
						? end.error.message
						: `the engine process ${describeEnd(end)} in the middle of the turn${this.lastWords()}`,
			};
		}
	}

	private closingSession?: Promise<void>;
	private async closeSession(): Promise<void> {
		if (this.closingSession) return this.closingSession;
		if (this.session === null || this.peer.closed || this.process === null || this.process.hasEnded) return;
		const shutdown =
			this.input.signal?.reason === PLATFORM_RESTART || (!!this.input.modelKey && this.tally.running === null);
		this.closingSession = this.peer
			.request<void>(
				"session/close",
				{
					sessionId: this.session,
					...(shutdown && { _meta: { [NS]: { shutdown: true } } }),
				},
				{ timeoutMs: this.forced ? FORCED_WAIT_MS : CLOSE_TIMEOUT_MS },
			)
			.catch(() => undefined);
		return this.closingSession;
	}

	/** Close stdin first, then interrupt the leader and escalate to TERM and KILL for all tagged processes. */
	private async stopProcess(now: boolean): Promise<void> {
		const run = this.process;
		if (run === null || run.hasEnded) return;
		run.closeStdin();
		if (!now && (await within(run.ended, this.forced ? FORCED_WAIT_MS : EXIT_WAIT_MS))) return;
		this.signalled = true;
		await run.signal("INT", "leader");
		if (await within(run.ended, 3000)) return;
		await run.signal("TERM", "all");
		if (await within(run.ended, 2000)) return;
		await run.signal("KILL", "all");
		if (await within(run.ended, 3000)) return;
		run.killClient();
		await within(run.ended, 2000);
	}

	// ---- failures ----

	/** Makes a refusal of the engine the turn's failure, unless it has one, and keeps Windlass's code for it when the error carries one. */
	private refused(error: unknown, fallback = "engine"): void {
		if (this.failure !== null) return;
		this.failure = this.failureOf(error, fallback);
		this.failureCode = error instanceof AcpError ? error.failureCode : null;
	}

	private failureOf(error: unknown, fallback = "engine"): Failure {
		if (!(error instanceof AcpError)) return { reason: "engine", message: errorText(error) };
		// The engine is gone, or did not answer: its last words say more than "closed".
		if (error.reason === "closed" || error.reason === "timeout")
			return { reason: "engine", message: `${error.message}${this.lastWords()}` };
		// ACP's own codes carry no reason of Windlass's.
		const reason =
			error.reason ??
			(error.code === -32002
				? "session_not_found"
				: error.code === -32000
					? "auth_required"
					: error.code === -32602
						? "invalid_request"
						: fallback);
		return { reason, message: error.message };
	}

	/** Why the engine did not get as far as answering `initialize`, in the command line's words. */
	private async startFailure(error: unknown): Promise<string> {
		// The connection closes a moment before the process is reaped: an exit is the better explanation.
		if (this.processEnd === null && this.process !== null) await within(this.process.ended, 1000);
		const end = this.processEnd;
		if (end !== null) {
			if (end.error !== null) return end.error.message;
			const said = lastWords(this.stderr);
			return said === null
				? `the engine process ${describeEnd(end)} before it was ready`
				: `the engine could not start: ${said} (its process ${describeEnd(end)})`;
		}
		if (error instanceof AcpError && error.reason === "timeout") {
			const ms = this.startTimeoutMs;
			return `the engine process did not start within ${ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000))} s; giving up`;
		}
		return `the engine process did not answer as expected: ${errorText(error)}`;
	}

	private lastWords(): string {
		const said = lastWords(this.stderr);
		return said === null ? "" : ` (${said})`;
	}
}

type Initialized = { agentCapabilities?: { _meta?: Record<string, unknown> } };
const TAKE_UP_FAILED = "the engine process of this turn could not be taken up again after the server restarted";
type PromptResult = { stopReason?: unknown; _meta?: Record<string, unknown> };

const UNTRUSTED_KEY = "windlass/untrusted";

/** The `_meta` keys an engine takes on `session/prompt`, from its answer to `initialize`; none when it lists none. */
function promptKeysIn(init: Initialized): string[] {
	const listed = (init.agentCapabilities?._meta?.[NS] as { promptMeta?: unknown } | undefined)?.promptMeta;
	return Array.isArray(listed) ? listed.filter((key): key is string => typeof key === "string") : [];
}

/** Send prompt metadata only for keys the engine advertised. */
export function promptMeta(
	input: Pick<RunTurnInput, "maxSteps" | "untrusted">,
	promptKeys: readonly string[],
): { _meta?: Record<string, unknown> } {
	const source = promptKeys.includes(UNTRUSTED_KEY) ? untrustedSource(input.untrusted) : null;
	const meta = {
		...(input.maxSteps === undefined ? {} : { "windlass/maxSteps": input.maxSteps }),
		...(source === null ? {} : { [UNTRUSTED_KEY]: { source } }),
	};
	return Object.keys(meta).length === 0 ? {} : { _meta: meta };
}

/** The keys of `_meta.windlass` an engine reads when a session is opened, from its answer to `initialize`; none when it lists none. */
function openKeysIn(init: Initialized): string[] {
	const listed = (init.agentCapabilities?._meta?.[NS] as { openMeta?: unknown } | undefined)?.openMeta;
	return Array.isArray(listed) ? listed.filter((key): key is string => typeof key === "string") : [];
}

/** The approval question of a permission request (`_meta.windlass.approval`), or null when it is not one. */
function questionOf(params: Record<string, unknown>): TurnQuestion | null {
	const meta = (params._meta as Record<string, unknown> | undefined)?.[NS] as Record<string, unknown> | undefined;
	const approval = meta?.approval as Record<string, unknown> | undefined;
	if (typeof approval !== "object" || approval === null) return null;
	const question = approval.question as
		| { title?: unknown; subject?: unknown; details?: unknown; choices?: unknown }
		| undefined;
	if (
		typeof approval.messageId !== "string" ||
		typeof approval.callId !== "string" ||
		typeof question?.title !== "string" ||
		!Array.isArray(question.choices)
	)
		return null;
	const choices = question.choices.flatMap((raw: unknown) => {
		const choice = raw as { id?: unknown; label?: unknown; approve?: unknown; remembers?: unknown };
		if (typeof choice?.id !== "string") return [];
		return [
			{
				id: choice.id,
				label: typeof choice.label === "string" ? choice.label : choice.id,
				approve: choice.approve === true,
				remembers: typeof choice.remembers === "string" ? choice.remembers : null,
			},
		];
	});
	// A subagent's question names it: `{ sessionId, title, spawnId, toolCallId }`, the title being the first line of its task.
	const subagent = approval.subagent as { title?: unknown; sessionId?: unknown } | string | undefined;
	const label =
		typeof subagent === "string"
			? subagent
			: typeof subagent?.title === "string"
				? subagent.title
				: typeof subagent?.sessionId === "string"
					? subagent.sessionId
					: null;
	return {
		messageId: approval.messageId,
		callId: approval.callId,
		title: question.title,
		subject: typeof question.subject === "string" ? question.subject : "",
		details: Array.isArray(question.details)
			? question.details.filter((detail): detail is string => typeof detail === "string")
			: [],
		choices,
		subagent: label === null || label.trim() === "" ? null : label.trim(),
	};
}

/**
 * The tool a permission request asks about, when using it is all the question is about: the one
 * need of `_meta.windlass.approval.needs`, `{ kind: "tool", tool }`, which for an MCP server's tool
 * is `<server>/<tool>`. Null for a question about anything else, or about more.
 */
function toolAsked(params: Record<string, unknown>): string | null {
	const meta = (params._meta as Record<string, unknown> | undefined)?.[NS] as
		| { approval?: { needs?: unknown } }
		| undefined;
	const needs = meta?.approval?.needs;
	if (!Array.isArray(needs) || needs.length !== 1) return null;
	const need = needs[0] as { kind?: unknown; tool?: unknown } | null;
	return need?.kind === "tool" && typeof need.tool === "string" ? need.tool : null;
}

interface ServerState {
	name: string;
	state: string;
	argv: string[] | null;
	target: string | null;
	tools: number | null;
	error: string | null;
	file: string | null;
	fingerprint: string | null;
	/** "user": only the user's own configuration defines it. "project": the project's file names or changes it. Null when Windlass did not say. */
	origin: string | null;
}

/**
 * A server as the layer's callers are told of it (`RunTurnInput.onServers`): the project's own, and
 * the user's own that this turn wrote into the configuration (`personal`, by name). One a file
 * switches off is left out, as Windlass leaves it out. Anything else that only the configuration file
 * of the sandbox's user defines is neither: the platform's own server, or one something in the
 * sandbox wrote there.
 */
function describeServer(server: ServerState, personal: ReadonlySet<string>): TurnServer[] {
	if (server.state === "disabled" || (server.origin === "user" && !personal.has(server.name))) return [];
	const state =
		server.state === "awaiting_approval"
			? "waiting"
			: server.state === "running" || server.state === "starting" || server.state === "failed"
				? server.state
				: "stopped";
	return [
		{
			name: server.name,
			origin: server.origin === "user" ? "user" : "project",
			state,
			argv: server.argv,
			url: server.argv === null ? server.target : null,
			file: server.file,
			tools: server.tools,
			error: server.error,
			fingerprint: server.fingerprint,
		},
	];
}

/** The servers in an answer to `_windlass/mcp` or `_windlass/mcp_approve`, or in `_windlass/mcp_changed`; null when it has none. */
function serversOf(raw: unknown): ServerState[] | null {
	const servers = (raw as { servers?: unknown } | null | undefined)?.servers;
	if (!Array.isArray(servers)) return null;
	return servers.flatMap((item: unknown) => {
		const server = item as {
			name?: unknown;
			state?: unknown;
			argv?: unknown;
			target?: unknown;
			tools?: unknown;
			error?: unknown;
			file?: unknown;
			origin?: unknown;
			question?: { fingerprint?: unknown } | null;
		};
		if (typeof server?.name !== "string" || typeof server.state !== "string") return [];
		return [
			{
				name: server.name,
				state: server.state,
				argv:
					Array.isArray(server.argv) &&
					server.argv.every((argument): argument is string => typeof argument === "string")
						? server.argv
						: null,
				target: typeof server.target === "string" ? server.target : null,
				tools: typeof server.tools === "number" ? server.tools : null,
				error: typeof server.error === "string" && server.error !== "" ? server.error : null,
				file: typeof server.file === "string" && server.file !== "" ? server.file : null,
				fingerprint:
					typeof server.question?.fingerprint === "string" && server.question.fingerprint !== ""
						? server.question.fingerprint
						: null,
				origin: typeof server.origin === "string" ? server.origin : null,
			},
		];
	});
}

/** `${NAME}` in a value of a server's definition: Windlass's own pattern (its packages/core/src/mcp/config.ts). */
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * The variables the definition of `name` in a configuration file reads: every `${NAME}` in the values
 * of its `env` and `headers`, in order of first appearance. The file is the repository's own, so
 * nothing is assumed of it: anything that is not the shape Windlass reads gives no names.
 */
export function variablesRead(text: string, name: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	const object = (value: unknown): Record<string, unknown> | null =>
		typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	const servers = object(object(object(parsed)?.mcp)?.servers);
	const definition = servers !== null && Object.hasOwn(servers, name) ? object(servers[name]) : null;
	if (definition === null) return [];
	const names: string[] = [];
	for (const key of ["env", "headers"]) {
		for (const value of Object.values(object(definition[key]) ?? {})) {
			if (typeof value !== "string") continue;
			for (const match of value.matchAll(VARIABLE)) if (!names.includes(match[1])) names.push(match[1]);
		}
	}
	return names;
}

function describeEnd(end: ProcessEnd): string {
	return end.signal !== null ? `was killed (${end.signal})` : `exited with code ${end.code}`;
}

/**
 * Why an engine process died, from the end of what it wrote to stderr: its own last warning or error,
 * or the message of an uncaught error, never a stack frame or a source excerpt (the command line's rule).
 */
function lastWords(stderr: string): string | null {
	const lines = stderr
		.split("\n")
		.map(line => line.trimEnd())
		.filter(line => line.trim() !== "");
	const findLast = (test: (line: string) => boolean) => [...lines].reverse().find(test);
	const own = findLast(line => /^\S+ acp (error|warn): /.test(line));
	if (own !== undefined) return own.replace(/^\S+ acp \w+: /, "");
	const thrown = findLast(line => /^(error|[A-Z]\w*Error|[A-Z]\w*Exception)(\[\w+\])?: \S/.test(line));
	if (thrown !== undefined) return thrown.replace(/^error: /, "");
	const plain = findLast(
		line => !/^Bun v\d/.test(line) && !/^\s*\d+ \| /.test(line) && !/^\s+at /.test(line) && !/^\s*\^\s*$/.test(line),
	);
	return plain === undefined ? null : plain.trim().slice(0, 500);
}
