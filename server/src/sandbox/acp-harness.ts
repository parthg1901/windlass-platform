import { claudeLimit, type LimitEvent } from "../provider-usage.js";
import type { AcpContent, AcpUpdate, SandboxProfileId, SessionMode, TurnUsage } from "../contract.js";
import { NO_REDACTION, RedactingStream, type Redactor } from "../repo-secrets.js";
import { configChoices, modeSelection, object, objects, optionsOf, text, type Fields } from "./acp-options.js";
import { AcpConnection, AcpError, LineSplitter, MethodNotFound } from "./acp.js";
import { SandboxUserError, type RunTurnInput, type RunTurnResult, type SandboxHandle, type StartMark } from "./api.js";
import type { Harness } from "./harness.js";
import { type AcpProfile, hostedKeyMessage, itemHarnessProblem, machineLoginMessage } from "./harnesses.js";
import { isTurnSandbox, type KeyTurnRelay, type SandboxProcess } from "./provider.js";
import { hostedKeyEnv, redactKeyLease } from "./hosted-keys.js";
import { openModelKeyRelay } from "./token-file.js";
import {
	PLATFORM_MCP_SERVER,
	PlatformMcpServer,
	platformToolDeclarations,
	turnPlatformTools,
} from "../platform-tools.js";
import { PlatformChecks } from "./platform-checks.js";
import { StepCounter } from "./platform-steps.js";

import {
	allCodexModes,
	codexDefaultMode,
	codexModes,
	innerModesReason,
	refusesSandboxEscape,
	SANDBOX_ESCAPE_REFUSED,
	sandboxEscapeNote,
} from "./codex-modes.js";
import { errorText } from "../util.js";

function unsupported(input: RunTurnInput): string | undefined {
	if (input.servers?.length) return "servers";
	if (input.secrets && (input.secrets.withholdEnv.length || input.secrets.passEnv.length))
		return "saved environment variables";
	if (input.reportScreenshots) return "report screenshots";
	// A tool that must not be served from inside the sandbox is refused, not left out: the turn would run without what its caller counts on.
	return (
		[
			"script",
			"onEvent",
			"onUnasked",
			"onServerQuestion",
			"onServerApproved",
			"onServers",
			"onPlan",
			"onPlanReview",
		] as const
	).find(key => input[key] !== undefined);
}

/**
 * Refuses without asking. codex-acp 2.9.0 offers "decline" (go on without it) for some commands and only
 * "cancel" (end the turn) for others and for edits; either is a refusal.
 */
function refuse(params: Fields) {
	const options = objects(params.options);
	const chosen = (
		options.find(o => o.optionId === "decline" && o.kind === "reject_once") ??
		options.find(o => o.kind === "reject_once")
	)?.optionId;
	return { outcome: typeof chosen === "string" ? { outcome: "selected", optionId: chosen } : { outcome: "cancelled" } };
}

/** The answer to an agent's permission request outside the Codex sandbox-escape refusal; exported for scripts/harness-check.ts. */
export async function permission(params: Fields, input: RunTurnInput, signal: AbortSignal, profile: AcpProfile) {
	const name = profile.name;
	const tool = object(params.toolCall);
	const options = objects(params.options);
	const fallback = options.find(o => o.kind === "reject_once");
	let chosen = fallback?.optionId;
	// Nobody answers a work item's turn: allow it once, as Windlass's approval "full" would run it in this container.
	// Only for an agent work items may run (`items`); for any other, an unattended request is rejected.
	if (input.unattended && profile.items)
		chosen =
			(options.find(o => o.kind === "allow_once") ?? options.find(o => o.kind === "allow_always"))?.optionId ?? chosen;
	else if (!input.unattended && input.onQuestion && !signal.aborted) {
		const title = text(tool.title);
		const content = objects(tool.content)
			.map(block => object(block.content ?? block))
			.find(block => block.type === "text");
		const answer = await input
			.onQuestion(
				{
					messageId: "acp",
					callId: text(tool.toolCallId),
					title,
					subject: text(content?.text) || title,
					details: [],
					subagent: null,
					choices: options.map(o => ({
						id: text(o.optionId),
						label: text(o.name),
						approve: text(o.kind).startsWith("allow"),
						remembers: o.kind === "allow_always" ? `for this conversation, as ${name} keeps it` : null,
					})),
				},
				signal,
			)
			.catch(() => null);
		chosen = answer?.note
			? fallback?.optionId
			: (options.find(o => o.optionId === answer?.choice)?.optionId ?? fallback?.optionId);
	}
	return {
		outcome:
			!signal.aborted && typeof chosen === "string"
				? { outcome: "selected", optionId: chosen }
				: { outcome: "cancelled" },
	};
}

/** Keep unrecognized payloads without promising the typed fields of a known update. */
function isKnownUpdate(raw: Fields): raw is Exclude<AcpUpdate, { sessionUpdate: "unknown" }> {
	const content = (value: unknown) => typeof object(value).type === "string";
	const strings = (value: unknown, ...keys: string[]) => keys.every(key => typeof object(value)[key] === "string");
	const optionalStrings = (...keys: string[]) =>
		keys.every(key => raw[key] === undefined || typeof raw[key] === "string");
	switch (raw.sessionUpdate) {
		case "agent_message_chunk":
		case "agent_thought_chunk":
		case "user_message_chunk":
			return content(raw.content);
		case "tool_call":
		case "tool_call_update":
			return (
				typeof raw.toolCallId === "string" &&
				optionalStrings("title", "kind", "status") &&
				(raw.content === undefined || (Array.isArray(raw.content) && raw.content.every(content)))
			);
		case "plan":
			return Array.isArray(raw.entries) && raw.entries.every(entry => strings(entry, "content", "priority", "status"));
		case "available_commands_update":
			return (
				Array.isArray(raw.availableCommands) &&
				raw.availableCommands.every(command => strings(command, "name", "description"))
			);
		case "current_mode_update":
			return typeof raw.currentModeId === "string";
		case "config_option_update":
			return Array.isArray(raw.configOptions);
		case "session_info_update":
			return optionalStrings("title", "updatedAt");
		case "usage_update":
			return (
				typeof raw.used === "number" &&
				typeof raw.size === "number" &&
				(raw.cost == null || (typeof object(raw.cost).amount === "number" && strings(raw.cost, "currency")))
			);
		case "notice":
		case "compaction_update":
			return true;
		default:
			return false;
	}
}

/**
 * The turn's tokens from a `session/prompt` answer's `usage` (ACP: input, output, thought, cached read and
 * write). As Windlass counts them, cached input is part of the input and reasoning part of the output.
 */
export function promptUsage(raw: unknown): TurnUsage | null {
	const usage = object(raw);
	const count = (key: string) =>
		typeof usage[key] === "number" && Number.isFinite(usage[key]) && (usage[key] as number) >= 0
			? (usage[key] as number)
			: 0;
	if (typeof usage.inputTokens !== "number" || typeof usage.outputTokens !== "number") return null;
	const cachedInputTokens = count("cachedReadTokens");
	const reasoningTokens = count("thoughtTokens");
	return {
		inputTokens: count("inputTokens") + cachedInputTokens + count("cachedWriteTokens"),
		cachedInputTokens,
		outputTokens: count("outputTokens") + reasoningTokens,
		reasoningTokens,
	};
}

/** Two prompts' tokens as one turn's: the platform's follow-ups after its checks are part of the turn. */
function addUsage(a: TurnUsage | null | undefined, b: TurnUsage | null): TurnUsage | null {
	if (!a || !b) return b ?? a ?? null;
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		reasoningTokens: a.reasoningTokens + b.reasoningTokens,
	};
}

/** Only a definite refusal to inject can safely be submitted again as a normal prompt. */
export class AcpPromptRequired extends SandboxUserError {
	constructor() {
		super("The turn ended just as the message arrived.");
	}
}

/** Redact text even when one saved value arrives split across ACP chunks. */
function updateStream(redactor: Redactor, emit: (update: AcpUpdate) => void) {
	const stream = new RedactingStream(redactor);
	let previous: Extract<AcpUpdate, { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" }> | null = null;
	const tools = new Map<string, { display: RedactingStream; raw: RedactingStream }>();
	function flushMessage() {
		const rest = stream.flush();
		if (previous && rest) emit({ ...previous, content: { type: "text", text: rest } });
		previous = null;
	}
	function redactBlock(block: AcpContent, tail: RedactingStream): AcpContent {
		const nested = block.type === "content";
		const body = nested ? object(block.content) : block;
		if (body.type !== "text" || typeof body.text !== "string") return block;
		const safe = { ...body, type: "text", text: tail.push(body.text) };
		return nested ? { ...block, content: safe } : safe;
	}
	// Claude can repeat its display text in rawOutput. Keep each copy continuous across updates.
	function toolOutput(update: Extract<AcpUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>) {
		const id = update.toolCallId;
		const tails = tools.get(id) ?? { display: new RedactingStream(redactor), raw: new RedactingStream(redactor) };
		const clean = { ...update };
		if (update.content) clean.content = update.content.map(block => redactBlock(block, tails.display));
		if (typeof update.rawOutput === "string") clean.rawOutput = tails.raw.push(update.rawOutput);
		if (Array.isArray(update.rawOutput))
			clean.rawOutput = update.rawOutput.map(block =>
				typeof object(block).type === "string" ? redactBlock(block, tails.raw) : block,
			);
		emit(clean);
		if (tails.display.hasTail || tails.raw.hasTail) tools.set(id, tails);
		else tools.delete(id);
	}
	return {
		flush() {
			flushMessage();
			for (const [toolCallId, { display, raw }] of tools) {
				emit({
					sessionUpdate: "tool_call_update",
					toolCallId,
					...(display.hasTail && { content: [{ type: "content", content: { type: "text", text: display.flush() } }] }),
					...(raw.hasTail && { rawOutput: raw.flush() }),
				});
			}
			tools.clear();
		},
		push(update: AcpUpdate) {
			const content = object(update.content);
			if (previous?.sessionUpdate !== update.sessionUpdate) flushMessage();
			if (
				(update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") &&
				content.type === "text" &&
				typeof content.text === "string"
			) {
				previous = update;
				const safe = stream.push(content.text);
				if (safe) emit({ ...update, content: { ...content, type: "text", text: safe } });
			} else {
				flushMessage();
				if (redactor.active && (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update"))
					toolOutput(update);
				else emit(update);
			}
		},
	};
}

/**
 * The agent process's environment for a turn. Codex resumes a session on the model its config names, not the
 * session's (sandbox/harness/codex/wlp-codex-acp): the turn's model goes in before the process starts.
 */
export function turnEnv(profile: Pick<AcpProfile, "id">, input: Pick<RunTurnInput, "model">): Record<string, string> {
	const variable = QUIRKS[profile.id].modelEnv;
	return variable && input.model && input.model !== "default" ? { [variable]: input.model } : {};
}

/** How long an ACP agent may send nothing, with no call of its own running and nobody asked, before its turn ends. */
export const ACP_IDLE_MS =
	(Number(process.env.WLP_ACP_IDLE_MINUTES) > 0 ? Number(process.env.WLP_ACP_IDLE_MINUTES) : 10) * 60_000;
/** The relay's own sentences (sandbox/relay/server.cjs `reject`) as an agent passes them on, by the refusal each is. */
const RELAY_SENTENCES: Record<string, string> = {
	"The provider rejected the request.": "provider_rejected",
	"The provider failed or couldn't be reached.": "provider_unavailable",
	"The provider's usage or rate limit was reached.": "usage_limit",
};
/**
 * A Codex model error that ended its turn: codex-acp shows it only as the agent's text and answers the prompt
 * with `end_turn`. Codex reports each try's error on `_meta.codex.error` and then the thread's `systemError`.
 */
function codexModelError(update: Fields): { status?: number; final: boolean } | null {
	const codex = object(object(update._meta).codex);
	if (object(codex.threadStatus).type === "systemError") return { final: true };
	const error = object(codex.error);
	if (typeof error.message !== "string") return null;
	const status = Object.values(object(error.codexErrorInfo))
		.map(v => object(v).httpStatusCode)
		.find(Number.isInteger) as number | undefined;
	return { ...(status !== undefined && { status }), final: error.willRetry === false };
}

/** Modes the sandbox profile decides (Codex): a mode the agent did not take, or one the profile does not allow, ends the turn. */
interface ProfileModes {
	/** The modes this profile allows, in the order shown. */
	allowed: (profile: SandboxProfileId) => SessionMode[];
	/** The mode a turn asks for when none was chosen. */
	initial: (profile: SandboxProfileId) => string;
	/** Every mode by its name, for the note when the agent switches to one the profile does not allow. */
	all: readonly SessionMode[];
	/** Why the turn cannot run when the agent did not open in or switch to the requested mode. */
	refusal: string;
}

/** One agent's departures from plain ACP, so that the turn below reads what each does instead of comparing ids. */
interface AcpQuirks {
	/** The variable naming the turn's model before the process starts (`turnEnv`). */
	modelEnv?: string;
	/** Added to `initialize`'s client capabilities. */
	clientCapabilities?: Fields;
	/** A request sent right after `initialize`. */
	setup?: { method: string; params: Fields };
	/**
	 * Whether the platform's MCP server is served only where `initialize`'s `_meta` says the image's wlp-acp-mcp
	 * fronts the adapter. codex-acp takes an `acp` server itself, on a random port Codex's requirements.toml cannot allow.
	 */
	mcpNeedsBridge: boolean;
	profileModes?: ProfileModes;
	/** Permission requests refused without asking where each would leave the agent's own sandbox, with the timeline's note. */
	escape?: { refuses: (profile: SandboxProfileId) => boolean; note: (kind: unknown) => string };
	/** A model error that ended the prompt, read from a `session_info_update`: the agent shows it only as text and answers `end_turn`. */
	modelError?: (update: Fields) => { status?: number; final: boolean } | null;
	/** The provider's rate-limit window, read from a `usage_update`'s `_meta`. */
	rateLimit?: (meta: Fields, at: number) => LimitEvent | undefined;
	/** Whether its JSON-RPC errors carry `codexErrorInfo` (a named kind, or the provider's HTTP status). */
	errorInfo: boolean;
	/** Whether it wraps provider messages as JSON-RPC internal errors ("Internal error: ...") without the HTTP status: shown without the prefix. */
	wrapsProviderErrors: boolean;
	/**
	 * How long a turn that ended well waits, before the process is closed, for the title the adapter generates
	 * (`RunTurnInput.wantsTitle`). codex-acp names the thread only after the turn, with a model call of its own
	 * (`TitleGenerator.onTurnCompleted`, fire and forget); claude-agent-acp asks at the prompt when it is ten
	 * characters or more, and at the turn's end otherwise. Closing at once loses either. OpenCode sends no title.
	 */
	titleWaitMs?: number;
}

const QUIRKS: Record<AcpProfile["id"], AcpQuirks> = {
	claude: {
		mcpNeedsBridge: false,
		errorInfo: false,
		wrapsProviderErrors: false,
		rateLimit: (meta, at) => claudeLimit(meta["_claude/rateLimit"], at),
		titleWaitMs: 15_000,
	},
	opencode: { mcpNeedsBridge: false, errorInfo: false, wrapsProviderErrors: true },
	codex: {
		// Codex resumes a session on the model its config names, not the session's (sandbox/harness/codex/wlp-codex-acp).
		modelEnv: "WLP_CODEX_MODEL",
		clientCapabilities: { auth: { _meta: { gateway: true } } },
		setup: {
			method: "providers/set",
			params: { providerId: "openai", apiType: "openai", baseUrl: "http://127.0.0.1:17892/codex/v1", headers: {} },
		},
		mcpNeedsBridge: true,
		profileModes: {
			allowed: profile => codexModes(profile),
			initial: codexDefaultMode,
			all: allCodexModes,
			refusal: innerModesReason,
		},
		escape: { refuses: refusesSandboxEscape, note: sandboxEscapeNote },
		modelError: codexModelError,
		errorInfo: true,
		wrapsProviderErrors: false,
		titleWaitMs: 25_000,
	},
};

async function waitForExit(run: SandboxProcess, ms: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			run.ended,
			new Promise<null>(resolve => {
				timer = setTimeout(() => resolve(null), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export class AcpHarness implements Harness {
	readonly id;
	constructor(
		private readonly profile: AcpProfile,
		private readonly machine?: string,
	) {
		this.id = profile.id;
	}

	async capabilities() {
		return this.profile.capabilities;
	}

	async runTurn(handle: SandboxHandle, input: RunTurnInput): Promise<RunTurnResult> {
		const ref = input.modelKey;
		if (!ref) {
			if (!this.machine) throw new Error(hostedKeyMessage(this.id, input.model));
			return this.run(handle, input);
		}
		if (!isTurnSandbox(handle)) throw new Error("A Settings key requires a turn sandbox.");
		input.signal?.throwIfAborted();
		const release = await handle.holdForTurn();
		let lease: KeyTurnRelay | undefined;
		try {
			input.signal?.throwIfAborted();
			lease = await openModelKeyRelay(
				handle,
				ref.sessionId,
				{ ...ref.key, harness: this.id },
				input.signal,
				ref.takeRequest,
				ref.openSecret,
				ref.onSeen,
			);
			input.signal?.throwIfAborted();
			const env = this.machine ? { WLP_TURN_KEY_LEASES: lease.placeholder } : hostedKeyEnv(this.id, ref.key, lease);
			const secrets = input.secrets?.redactor ?? NO_REDACTION;
			return await this.run(handle, input, env, redactKeyLease(secrets, lease.placeholder));
		} finally {
			try {
				await lease?.close();
			} finally {
				await release();
			}
		}
	}

	private async run(
		handle: SandboxHandle,
		input: RunTurnInput,
		relayEnv?: Record<string, string>,
		redactor = input.secrets?.redactor ?? NO_REDACTION,
	): Promise<RunTurnResult> {
		const profile = this.profile;
		const quirks = QUIRKS[profile.id];
		const acp: NonNullable<RunTurnResult["acp"]> = { stopReason: null, usage: null, models: null };
		const result: RunTurnResult = {
			exitCode: null,
			aborted: false,
			timedOut: false,
			windlassSessionId: null,
			summary: null,
			stderrTail: "",
			failure: null,
			acp,
		};
		const refused = unsupported(input);
		if (refused) {
			result.failure = {
				reason: "engine",
				message: `This turn asked ${profile.name} for ${refused}, which it does not take here.`,
			};
			return result;
		}
		const questions = new AbortController();
		// The platform's tools this turn is given, served over this connection (MCP over ACP), and only while its prompt runs.
		const tools = turnPlatformTools(input, "sandbox");
		const mcp = tools.size
			? new PlatformMcpServer(
					tools,
					platformToolDeclarations(tools, { screenshots: false, mcp: true }),
					() => phase === "running",
					said => input.onAcpNote?.(said),
				)
			: null;
		// The adapter's generated title, which a turn that wants one waits for at its end (`AcpQuirks.titleWaitMs`).
		let titled = false;
		let noTitles = false;
		let resolveTitled = () => {};
		const titleSeen = new Promise<void>(resolve => {
			resolveTitled = resolve;
		});
		const stream = updateStream(redactor, update => {
			if (update.sessionUpdate === "session_info_update" && typeof update.title === "string" && update.title.trim()) {
				titled = true;
				resolveTitled();
			}
			input.onAcpUpdate?.(update);
		});
		const stderr = new RedactingStream(redactor);
		let errorLines = "";
		const keepError = (piece: string) => {
			result.stderrTail = (result.stderrTail + piece).slice(-4096);
			if (!profile.limitGiveUp || phase !== "running") return;
			errorLines = (errorLines + piece).slice(-8192);
			if (profile.limitGiveUp.test(errorLines))
				endFor("usage_limit", "The provider's usage or rate limit was reached.");
		};
		const mark = (point: StartMark) => {
			try {
				input.onStartMark?.(point);
			} catch {
				/* A listener's failure must not stop the turn. */
			}
		};
		let outputSeen = false;
		// Bounds of a turn whose agent went quiet: the last line it sent, its calls still running, the questions put to a person.
		let lastHeard = Date.now();
		const openCalls = new Set<string>();
		let asking = 0;
		// The turn was ended by the platform for the agent: its failure replaces whatever the agent's stop said.
		let ended = null as { reason: string; message: string } | null;
		// The model's errors in this prompt (`AcpQuirks.modelError`), and the agent's text since the last of them.
		let modelError = null as { status?: number; final: boolean } | null;
		let modelErrorText = "";
		let run: SandboxProcess | undefined;
		let cancelDeadline: ReturnType<typeof setTimeout> | undefined;
		// "checking": a prompt was answered with `end_turn` and the platform runs the repository's checks (platform-checks.ts), maybe to prompt again.
		let phase: "setup" | "running" | "checking" | "titling" | "ended" = "setup";
		const steps = new StepCounter(input.maxSteps);
		const gate = new PlatformChecks(handle, input.checks ?? [], (event, note) => input.onChecks?.(event, note), {
			agent: profile.name,
			redactor,
			signal: input.signal,
			force: input.forceChecks,
			unavailable: profile.sandboxedOn.includes(handle.profile)
				? `${profile.name} runs its commands in its own sandbox without network here, and the platform does not run what the agent changed outside it. CI decides.`
				: undefined,
		});
		let configs = optionsOf([]);
		let modes = modeSelection(null, []);
		// A mode the profile does not allow (`AcpQuirks.profileModes`), reported by the agent: the turn ends and the process is stopped.
		let forbidden: string | null = null;
		const forbid = (mode: string) => {
			if (forbidden !== null) return;
			const named = quirks.profileModes?.all.find(m => m.id === mode)?.name ?? mode;
			forbidden = `${profile.name} switched to the mode “${named}”, which this sandbox profile does not allow. The turn was stopped.`;
			rpc.end(forbidden);
		};
		const allowedMode = (mode: unknown) =>
			!quirks.profileModes || quirks.profileModes.allowed(handle.profile).some(m => m.id === mode);
		// The mode the agent last reported in a current_mode_update, for the session/set_mode path below.
		let reportedMode: string | undefined;
		const readConfigs = (raw: unknown, freshSession = false) => {
			configs = optionsOf(raw, acp.models ?? input.harnessModels, freshSession);
			acp.models = configs.list;
		};
		const rpc = new AcpConnection(
			line => run?.write(line + "\n") ?? false,
			{
				notification: (method, params) => {
					if (
						phase === "ended" ||
						phase === "checking" ||
						method !== "session/update" ||
						!result.windlassSessionId ||
						params.sessionId !== result.windlassSessionId
					)
						return;
					const update = object(params.update);
					if (typeof update.sessionUpdate !== "string") return;
					// After the turn, only the title it is waited for.
					if (phase === "titling" && update.sessionUpdate !== "session_info_update") return;
					if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
						const id = text(update.toolCallId);
						if (update.status === "completed" || update.status === "failed") openCalls.delete(id);
						else if (
							update.sessionUpdate === "tool_call" ||
							update.status === "in_progress" ||
							update.status === "pending"
						)
							openCalls.add(id);
					}
					if (quirks.modelError && phase === "running") {
						const error = update.sessionUpdate === "session_info_update" ? quirks.modelError(update) : null;
						if (error) {
							if (modelError === null) modelErrorText = "";
							modelError = {
								status: error.status ?? modelError?.status,
								final: error.final || modelError?.final === true,
							};
						} else if (modelError && update.sessionUpdate === "agent_message_chunk")
							modelErrorText = (modelErrorText + text(object(update.content).text)).slice(-2000);
						else if (update.sessionUpdate !== "session_info_update" && update.sessionUpdate !== "usage_update")
							modelError = null;
					}
					// The agent's first output after the prompt: text, thinking, or a tool call.
					if (
						phase === "running" &&
						!outputSeen &&
						["agent_message_chunk", "agent_thought_chunk", "tool_call"].includes(update.sessionUpdate)
					) {
						outputSeen = true;
						mark("output");
					}
					if (update.sessionUpdate === "usage_update") {
						if (typeof update.used !== "number" || typeof update.size !== "number") return;
						const cost = object(update.cost);
						const rateLimit = quirks.rateLimit?.(object(update._meta), Date.now());
						const fiveHourUsedPct =
							rateLimit?.window.kind === "5h" ? rateLimit.window.usedPct : acp.usage?.fiveHourUsedPct;
						if (fiveHourUsedPct != null) acp.fiveHourAtStart ??= fiveHourUsedPct;
						acp.usage = {
							used: update.used,
							size: update.size,
							cost:
								typeof cost.amount === "number" && typeof cost.currency === "string" && /^[A-Z]{3}$/.test(cost.currency)
									? { amount: cost.amount, currency: cost.currency }
									: null,
							...(fiveHourUsedPct != null && { fiveHourUsedPct }),
						};
						stream.push({ sessionUpdate: "usage_update", ...acp.usage, ...(rateLimit && { rateLimit }) });
						return;
					}
					if (update.sessionUpdate === "current_mode_update") {
						if (!allowedMode(update.currentModeId)) return forbid(text(update.currentModeId));
						reportedMode = text(update.currentModeId);
					}
					if (update.sessionUpdate === "config_option_update") {
						const reported = objects(update.configOptions).find(option => option.category === "mode")?.currentValue;
						if (reported !== undefined && !allowedMode(reported)) return forbid(text(reported));
						const profileModes = quirks.profileModes;
						if (profileModes)
							update.configOptions = objects(update.configOptions).map(option =>
								option.category !== "mode"
									? option
									: {
											...option,
											options: profileModes
												.allowed(handle.profile)
												.filter(mode => configChoices(option).some(choice => choice.id === mode.id))
												.map(mode => ({ value: mode.id, name: mode.name, description: mode.description })),
										},
							);
						readConfigs(update.configOptions);
						if (modes.select) {
							modes = modeSelection(null, update.configOptions);
							if (modes.current) input.onAcpModes?.(modes.current, modes.modes);
						}
					}
					stream.push(
						isKnownUpdate(update)
							? update
							: { ...update, sessionUpdate: "unknown", originalSessionUpdate: update.sessionUpdate },
					);
					// The platform's step limit (platform-steps.ts): the call past it is shown, and the turn is stopped.
					if (phase === "running" && steps.count(update)) stopAtLimit();
				},
				request: async (method, params, withdrawn) => {
					if (method === "mcp/message" && mcp && phase !== "ended" && phase !== "checking" && phase !== "titling")
						return mcp.handle(params, AbortSignal.any([questions.signal, withdrawn]));
					if (method !== "session/request_permission") throw new MethodNotFound(method);
					if (phase !== "running" || params.sessionId !== result.windlassSessionId)
						return { outcome: { outcome: "cancelled" } };
					if (quirks.escape?.refuses(handle.profile)) {
						const note = quirks.escape.note(object(params.toolCall).kind);
						input.onAcpNote?.(note);
						// A work item's turn ends at the first one: the step fails with the platform's note, never the agent's words.
						if (input.unattended) endForEscape(note);
						return refuse(params);
					}
					asking++;
					try {
						return await permission(params, input, AbortSignal.any([questions.signal, withdrawn]), profile);
					} finally {
						asking--;
						lastHeard = Date.now();
					}
				},
			},
			"",
			value => redactor.deep(value),
		);
		const sendCancel = () => {
			rpc.notify("session/cancel", { sessionId: result.windlassSessionId });
			cancelDeadline = setTimeout(() => rpc.end("The agent did not answer the stop request."), 10_000);
		};
		// The agent asked to leave its sandbox during a work item's turn (above): the turn is stopped, and fails with the platform's note.
		let escaped: string | null = null;
		const endForEscape = (note: string) => {
			if (escaped !== null) return;
			escaped = note;
			questions.abort();
			sendCancel();
		};
		// The agent went past the turn's step limit (above): the turn is stopped, and ends unresolved.
		const stopAtLimit = () => {
			if (acp.stepLimit !== undefined || escaped !== null) return;
			acp.stepLimit = input.maxSteps;
			questions.abort();
			sendCancel();
		};
		// The platform ends the turn for the agent (`ended`): it went quiet, or said it gave up on the provider.
		const endFor = (reason: string, message: string) => {
			if (ended !== null || escaped !== null || phase !== "running") return;
			ended = { reason, message };
			questions.abort();
			sendCancel();
		};
		const idleMs = input.idleMs ?? ACP_IDLE_MS;
		const idleMinutes = Math.round(idleMs / 60_000);
		const idle = setInterval(
			() => {
				if (phase === "running" && openCalls.size === 0 && asking === 0 && Date.now() - lastHeard >= idleMs)
					endFor(
						"agent_idle",
						`${profile.name} sent nothing for ${idleMinutes >= 1 ? `${idleMinutes} minute${idleMinutes === 1 ? "" : "s"}` : "a while"} with no call of its own running, so the platform ended the turn. Its provider may be refusing or not answering.`,
					);
			},
			Math.min(30_000, Math.max(50, idleMs / 4)),
		);
		const cancel = () => {
			questions.abort();
			if (phase === "running") {
				sendCancel();
			} else rpc.end("The turn was stopped.");
		};
		const loginHint = () =>
			this.machine && !input.modelKey
				? machineLoginMessage(profile, this.machine)
				: "Check the provider key in Settings.";
		try {
			if (!isTurnSandbox(handle) || !profile.profiles.includes(handle.profile))
				throw new Error(`${profile.name} requires a supported sandbox.`);
			if (input.unattended && !profile.items)
				throw new Error(itemHarnessProblem(profile.id) ?? `${profile.name} does not run work items.`);
			if (input.signal?.aborted) return { ...result, aborted: true };
			input.signal?.addEventListener("abort", cancel, { once: true });
			await handle.stopLeftovers(profile.leftovers);
			if (input.signal?.aborted) return { ...result, aborted: true };
			const lines = new LineSplitter(line => {
				lastHeard = Date.now();
				rpc.receive(line);
			});
			mark("process");
			const secretEnv = { ...input.secrets?.env, ...relayEnv };
			run = handle.start(profile.command, {
				cwd: input.reviewDirectory ?? handle.cwd,
				env: turnEnv(profile, input),
				...(Object.keys(secretEnv).length > 0 && { secretEnv }),
				onStdout: chunk => lines.push(chunk),
				onStderr: chunk => keepError(stderr.push(chunk)),
			});
			void run.ended.then(end => {
				lines.flush();
				rpc.end(end.error?.message || `${profile.name} exited before answering (exit ${end.code ?? end.signal}).`);
			});
			const request = (method: string, params: Fields, onResult?: (value: Fields) => void) =>
				rpc.request<Fields>(method, params, { timeoutMs: 60_000, onResult });
			const init = await request("initialize", {
				protocolVersion: 1,
				clientCapabilities: {
					...quirks.clientCapabilities,
					fs: { readTextFile: false, writeTextFile: false },
					terminal: false,
				},
				clientInfo: { name: "windlass-platform", version: "0" },
			});
			if (init.protocolVersion !== 1) throw new Error(`${profile.name} does not speak ACP v1.`);
			mark("initialized");
			if (quirks.setup) await request(quirks.setup.method, quirks.setup.params);
			const caps = object(init.agentCapabilities);
			const canSteer = object(object(init._meta).steering).supported === true;
			// An agent that says it titles nothing after a turn is not waited for (the test fixture).
			noTitles = object(init._meta)["windlass-platform/noTitles"] === true;
			// An adapter that takes no `acp` server gets none: the turn runs without the tools, and says so (`AcpQuirks.mcpNeedsBridge`).
			const bridged = !quirks.mcpNeedsBridge || object(init._meta)["windlass-platform/acpMcp"] === 1;
			const served = mcp !== null && bridged && object(caps.mcpCapabilities).acp === true;
			if (input.onReview && !served)
				throw new Error(`${profile.name} needs a harness image with MCP support to file a review.`);
			if (mcp && !served)
				input.onAcpNote?.(
					`${profile.name} here cannot take the platform's tools, so this turn has no ${[...tools.keys()].join(" or ")}. A newer harness image on the machine has them.`,
				);
			const settings = { cwd: input.reviewDirectory ?? handle.cwd, mcpServers: served ? [PLATFORM_MCP_SERVER] : [] };
			const prior = input.windlassSessionId;
			// Enable updates synchronously at the open reply. Replay preceding a load reply is
			// ignored, while updates in the very same stdout read after that reply are live.
			const accept = (previous?: string) => (opened: Fields) => {
				result.windlassSessionId = previous ?? text(opened.sessionId);
				modes = modeSelection(opened.modes, opened.configOptions);
				readConfigs(opened.configOptions, !previous);
			};
			if (prior) {
				const method =
					object(caps.sessionCapabilities).resume != null
						? "session/resume"
						: caps.loadSession === true
							? "session/load"
							: null;
				result.resumed = false;
				if (method) {
					try {
						await request(method, { ...settings, sessionId: prior }, accept(prior));
						result.resumed = true;
					} catch (error) {
						if (!(error instanceof AcpError) || error.code === 0 || profile.signedOutCodes.includes(error.code))
							throw error;
					}
				}
			}
			if (!result.windlassSessionId) await request("session/new", settings, accept());
			// The saved session could not be continued: a turn that resumes is given its whole task instead of a "carry on".
			const fresh = prior && result.resumed === false ? input.fresh : undefined;
			const sessionId = result.windlassSessionId;
			if (!sessionId) throw new Error(`${profile.name} returned no session id.`);
			const strict = quirks.profileModes;
			const requested = input.mode ?? (strict ? strict.initial(handle.profile) : modes.select ? modes.current : "auto");
			if (strict) {
				modes.modes = strict.allowed(handle.profile).filter(m => modes.modes.some(raw => raw.id === m.id));
				if (!modes.modes.some(m => m.id === requested)) throw new Error(strict.refusal);
			}
			if (input.unattended && !modes.modes.some(m => m.id === requested))
				throw new Error(
					`${profile.name} does not offer the mode “${requested}” here, and a work item runs only in a mode that never asks.`,
				);
			const chosen = modes.modes.some(m => m.id === requested) ? requested : modes.current;
			if (!chosen) throw new Error(`${profile.name} did not report its current mode.`);
			if (modes.select) {
				const reply = await request("session/set_config_option", {
					sessionId,
					configId: modes.select.id,
					value: chosen,
				});
				readConfigs(reply.configOptions);
				modes = modeSelection(null, reply.configOptions);
				if (strict) {
					if (modes.current !== requested) throw new Error(strict.refusal);
					modes.modes = strict.allowed(handle.profile).filter(m => modes.modes.some(raw => raw.id === m.id));
				}
				if (!modes.current || !modes.modes.some(m => m.id === modes.current))
					throw new Error(`${profile.name} did not acknowledge its mode.`);
				if (input.unattended && modes.current !== requested)
					throw new Error(`${profile.name} did not switch to the mode “${requested}”, which a work item needs.`);
				input.onAcpModes?.(modes.current, modes.modes, modes.current === requested ? undefined : requested);
			} else if (strict) {
				// No reply reports the mode here: the agent must have opened in it or reported switching to it.
				const opened = modes.current;
				reportedMode = undefined;
				await request("session/set_mode", { sessionId, modeId: chosen });
				if ((reportedMode ?? opened) !== requested) throw new Error(strict.refusal);
				input.onAcpModes?.(requested, modes.modes);
			} else {
				input.onAcpModes?.(chosen, modes.modes, chosen === requested ? undefined : requested);
				await request("session/set_mode", { sessionId, modeId: chosen });
			}
			// The agent's own plan mode (`capabilities.planMode`): Codex's collaboration mode, set for every turn.
			if (profile.capabilities.planMode) {
				const collaboration = input.planMode ? "plan" : "default";
				await request("session/set_config_option", { sessionId, configId: "collaboration_mode", value: collaboration });
			}
			const priorModel = text(configs.model?.currentValue);
			const priorEffort = text(configs.effort?.currentValue);
			const select = (option: Fields, value: string) =>
				request("session/set_config_option", { sessionId, configId: option.id, value }, set => {
					readConfigs(set.configOptions);
				});
			if (input.model) {
				if (configs.model && configChoices(configs.model).some(choice => choice.id === input.model))
					await select(configs.model, input.model);
				else if (input.model !== "default")
					throw new Error(`${profile.name} does not offer model “${input.model}” here.`);
			}
			// Model selection can change or remove the effort select altogether.
			const changed = priorModel !== text(configs.model?.currentValue);
			const effort = input.effort ?? (changed ? priorEffort : undefined);
			if (effort) {
				if (configs.effort && configChoices(configs.effort).some(choice => choice.id === effort)) {
					if (input.effort) await select(configs.effort, effort);
				} else if (input.unattended && input.effort) {
					throw new Error(`${profile.name} does not offer the selected effort “${effort}” for this model.`);
				} else if (changed || input.model) {
					const option = configs.effort;
					if (
						option &&
						option.currentValue !== "default" &&
						configChoices(option).some(choice => choice.id === "default")
					)
						await select(option, "default");
					input.onEffortFallback?.(text(configs.effort?.currentValue) || null);
				} else {
					throw new Error(`${profile.name} does not offer effort “${effort}” here.`);
				}
			}
			const prompt = (value: string) => ({ sessionId, prompt: [{ type: "text", text: value }] });
			// The state the turn's changes are measured from, for the repository's checks; nothing runs where there are none.
			await gate.begin();
			phase = "running";
			lastHeard = Date.now();
			mark("prompted");
			const answer = rpc.request<Fields>("session/prompt", prompt(fresh?.prompt ?? input.prompt), {
				onResult: () => {
					phase = "checking";
				},
			});
			input.onControl?.({
				steer: async value => {
					if (phase !== "running" || !canSteer || input.signal?.aborted) throw new AcpPromptRequired();
					const reply = await request(profile.steering, {
						...prompt(value),
						_meta: { steering: { idleBehavior: "promptRequired" } },
					});
					if (reply?.outcome !== "injected") throw new AcpPromptRequired();
				},
				cancelCall: async () => ({
					stopped: false,
					message: `${profile.name} cannot stop one call; stop the turn instead.`,
				}),
			});
			let answered = await answer;
			for (;;) {
				acp.stopReason = text(answered.stopReason) || null;
				acp.tokens = addUsage(acp.tokens, promptUsage(answered.usage));
				// The agent answered `end_turn` after its model's requests failed, having done nothing: the provider's failure is the turn's.
				const failedModel =
					modelError?.final &&
					steps.steps === 0 &&
					!(acp.tokens && acp.tokens.inputTokens + acp.tokens.outputTokens > 0)
						? modelError
						: null;
				if (acp.stopReason === "end_turn" && failedModel) {
					const said = redactor.text(modelErrorText.trim()).slice(0, 500);
					const status = failedModel.status;
					const reason =
						status === 429
							? "usage_limit"
							: status === 401
								? "harness_signed_out"
								: status !== undefined && status >= 400 && status < 500
									? "provider_rejected"
									: "provider_unavailable";
					result.failure = {
						reason,
						message:
							reason === "usage_limit"
								? "The provider's usage or rate limit was reached."
								: reason === "harness_signed_out"
									? `${said || `${profile.name}'s sign-in was refused.`} ${loginHint()}`
									: `${profile.name}'s model requests failed${status ? ` (HTTP ${status})` : ""}, so it did nothing this turn.${said ? ` It said: ${said}` : ""}`,
					};
					break;
				}
				// The agent called its work done: the platform runs the checks, and may send it back in this turn (platform-checks.ts).
				if (
					acp.stopReason !== "end_turn" ||
					steps.reached ||
					escaped !== null ||
					ended !== null ||
					input.signal?.aborted
				)
					break;
				const again = await gate.settle();
				if (again === null || input.signal?.aborted) break;
				phase = "running";
				gate.sent();
				answered = await rpc.request<Fields>("session/prompt", prompt(again), {
					onResult: () => {
						phase = "checking";
					},
				});
			}
			acp.checks = gate.ended;
			if (gate.ended === null) await gate.close();
			// The process lives on a little for the title it is still generating, then is closed as usual.
			if (
				input.wantsTitle &&
				quirks.titleWaitMs &&
				!noTitles &&
				!titled &&
				acp.stopReason === "end_turn" &&
				result.failure === null &&
				!input.signal?.aborted
			) {
				phase = "titling";
				let timer: ReturnType<typeof setTimeout> | undefined;
				const stop = new Promise<void>(resolve => {
					timer = setTimeout(resolve, quirks.titleWaitMs);
					input.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				await Promise.race([titleSeen, stop, run?.ended]);
				clearTimeout(timer);
			}
		} catch (error) {
			if (!input.signal?.aborted) {
				const info = quirks.errorInfo && error instanceof AcpError ? error.codexErrorInfo : undefined;
				const status = Object.values(object(info))
					.map(v => object(v).httpStatusCode)
					.find(Number.isInteger);
				const signedOut =
					error instanceof AcpError &&
					(profile.signedOutCodes.includes(error.code) || info === "unauthorized" || status === 401);
				const said = errorText(error);
				const invalid = phase === "running" && error instanceof AcpError && error.code === -32602;
				const wrappedPromptError =
					quirks.wrapsProviderErrors && phase === "running" && error instanceof AcpError && error.code === -32603;
				const message = wrappedPromptError ? said.replace(/^Internal error: /, "") : said;
				const promptError = phase === "running" && error instanceof AcpError && error.code === -32603;
				const usageLimit =
					status === 429 ||
					info === "usageLimitExceeded" ||
					(promptError && said.replace(/^Internal error: /, "") === "The provider's usage or rate limit was reached.");
				const limit = promptError ? error.limit : undefined;
				// The relay's own refusal, passed on by the agent: the provider's, not the agent's or the platform's.
				const relayed = promptError ? RELAY_SENTENCES[said.replace(/^Internal error: /, "")] : undefined;
				const reason = signedOut
					? "harness_signed_out"
					: invalid
						? "invalid_request"
						: usageLimit
							? "usage_limit"
							: (limit?.reason ?? relayed ?? "engine");
				result.failure = {
					...limit,
					reason,
					message: limit
						? "The provider's usage or rate limit was reached."
						: redactor.text(signedOut ? `${said} ${loginHint()}` : message),
				};
				result.timedOut = error instanceof AcpError && error.reason === "timeout";
			}
		} finally {
			clearTimeout(cancelDeadline);
			input.signal?.removeEventListener("abort", cancel);
			phase = "ended";
			acp.steps = steps.steps;
			clearInterval(idle);
			if (escaped !== null && !input.signal?.aborted)
				result.failure = { reason: SANDBOX_ESCAPE_REFUSED, message: escaped };
			else if (ended !== null && !input.signal?.aborted) result.failure = ended;
			questions.abort();
			stream.flush();
			if (run && isTurnSandbox(handle)) {
				run.closeStdin();
				let end =
					forbidden === null && (run.hasEnded || !input.signal?.aborted || acp.stopReason)
						? await waitForExit(run, 2000)
						: null;
				for (const sig of ["TERM", "KILL"] as const) {
					if (end) break;
					await run.signal(sig, "all");
					end = await waitForExit(run, 2000);
				}
				if (!end) run.killClient();
				result.exitCode = end?.code ?? null;
				if (!result.failure && !input.signal?.aborted && (!end || end.code !== 0))
					result.failure = {
						reason: "engine",
						message: redactor.text(end?.error?.message || `${profile.name} ended unexpectedly.`),
					};
				try {
					await handle.sweep(run.tag);
				} catch (error) {
					if (!result.failure && !input.signal?.aborted)
						result.failure = { reason: "engine", message: redactor.text(errorText(error)) };
				}
			}
			rpc.end("The turn has ended.");
			keepError(stderr.flush());
			result.aborted = input.signal?.aborted ?? false;
		}
		return result;
	}
}
