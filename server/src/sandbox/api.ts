/** Actors acquire sandboxes through this interface. Providers own isolation and resource lifetime; turns receive only their scoped credentials. */
import type { SnapshotSelection, SnapshotSource } from "./snapshot-key.js";

import type {
	AcpContext,
	AcpUpdate,
	EgressMode,
	HostedSize,
	HostedSizeOption,
	SessionMode,
	ModelList,
	RepositoryCheck,
	SandboxProfile,
	SandboxProfileId,
	TurnUsage,
	WindlassEvent,
} from "../contract.js";
import type { Redactor } from "../repo-secrets.js";
import type { HarnessId } from "./harness.js";
import type { ProjectChecks } from "../windlass-config.js";

// ---------------------------------------------------------------------------------------------
// Sandboxes
// ---------------------------------------------------------------------------------------------

export interface ExecOptions {
	/** Run as the unprivileged transport user, outside the workspace. */
	gitUser?: true;
	/** Defaults to the sandbox's workspace. */
	cwd?: string;
	env?: Record<string, string>;
	/** Secret values reach the process without appearing on a command line. */
	secretEnv?: Record<string, string>;
	/** Written before closing stdin. Omitted means empty input. */
	stdin?: string;
	timeoutMs?: number;
	/** Abort signals the tagged processes inside the sandbox and waits for them to stop. */
	signal?: AbortSignal;
	/** Streamed chunks can split lines but preserve multibyte characters. */
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
}

export interface ExecResult {
	/** Null when the command was killed. */
	exitCode: number | null;
	timedOut: boolean;
	aborted: boolean;
	/** Capped output. The stream callback receives all chunks. */
	stdout: string;
	stderr: string;
}

/** Runner-measured start durations in milliseconds. */
export interface RunnerStartTimes {
	spare?: true;
	image: number;
	pulled?: true;
	create: number;
}

/** Start marks in order. Relay duration is available before the process starts. */
export type StartMark = "relay" | "process" | "initialized" | "prompted" | "output";

export type ProxyBlockedHost = Pick<
	import("../contract.js").BlockedHost,
	"host" | "port" | "firstAt" | "lastAt" | "count"
> & {
	reason: Exclude<import("../contract.js").BlockedHost["reason"], "unlisted">;
};

export interface SandboxHandle {
	readonly id: string;
	readonly cwd: string;
	/** On a personal machine, the connected runner's permission to use its browser. */
	readonly runnerScreenshots?: boolean;
	readonly snapshot?: SnapshotSource;
	/** Provider image ID or template build, when the provider reports it. */
	readonly image?: string;
	readonly profile: SandboxProfileId;
	/** True for a private Docker data volume. E2B disk ownership is reported by sessionsLiveInSandbox. */
	readonly ownData?: boolean;
	/** Recovery notice for this connect, shown in the timeline. */
	readonly notice?: string;
	/** Evidence of memory exhaustion when the provider recovered an unresponsive sandbox. */
	readonly outOfMemory?: OutOfMemory;
	/** OOM kills and memory limit (MiB) at turn start and end. Null when unavailable. */
	memoryEvents?(): Promise<{ oomKills: number; totalMiB: number } | null>;
	/** Peak sampled since sinceMs, reported only near the memory limit. */
	memoryPeak?(sinceMs: number): Promise<OutOfMemory | null>;
	/** Reported on the first connect after a create by runners supporting start-times. */
	readonly runnerStart?: RunnerStartTimes;
	/** Recipe this workspace was prepared for, until the session records its clone. */
	readonly readyKey?: string;
	readonly readySetup?: import("../runner/spare-recipe.js").SpareSetup;
	run(command: string, options?: ExecOptions): Promise<ExecResult>;
	readTextFile(path: string): Promise<string>;
	writeTextFile(path: string, content: string): Promise<void>;
	/** Unreachable hosts in first-lookup order. Apply skip before the limit so old entries cannot hide new ones. */
	blockedHosts?(skip?: Iterable<string>): Promise<string[]>;
	/** A restricted runner proxy. The first read opens the turn, subsequent reads repeat its cumulative counts. */
	blockedNetwork?(
		turn: number,
		retained: Pick<ProxyBlockedHost, "host" | "port">[],
	): Promise<{ broker: string; hosts: ProxyBlockedHost[]; overflow: number }>;
	/** Install a staged Docker mirror from outside the sandbox and remove the stage. Partial mirrors only seed empty slots. */
	saveMirror?(stage: string, partial: boolean): Promise<boolean>;
}

export interface ConnectOptions {
	/** On turn resume, a restarted runner may ask for a fresh recipe for the next new session. */
	spareSeed?: () => Promise<import("../runner/spare-recipe.js").SpareRecipe | undefined>;
	screenshots?: boolean;
	/** Additional repository hosts, reapplied at each connect on restricted E2B. */
	network?: readonly string[];
	/** Whether this Docker sandbox has a private data volume (runner session-volumes capability). */
	ownData?: boolean;
}

export const ENVIRONMENT_SLOT_WAIT = "Waiting for a free slot alongside the machine’s warm spare.";

export interface CreateSandboxInput {
	environmentBuild?: true;
	/** Evaluated only for a machine advertising ready sandboxes. */
	spareRecipe?: (ready: number) => Promise<import("../runner/spare-recipe.js").SpareRecipe | undefined>;
	/** As `ConnectOptions.network`, from the first command in the sandbox. */
	network?: readonly string[];
	/** Machine slot units requested by an approved subtask. Omitted for a standard sandbox. */
	size?: number;
	/** Hosted size, defaulting to the smallest offered. */
	hostedSize?: HostedSize;
	fromSnapshot?: SnapshotSelection;
	/** Immutable GitHub repository ID for a transport-owned Docker mirror. */
	mirrorRepo?: string;
	/** Machine-only. The default harness uses the ordinary Windlass image. */
	harness?: Exclude<HarnessId, "windlass">;
	/** An item's reviewer keeps Windlass data inside its own sandbox, including approval records. */
	privateData?: boolean;
	screenshots?: boolean;
	uid: string;
	sessionId: string;
	profile: SandboxProfileId;
}

/** Provider memory observations in MiB. */
export interface OutOfMemory {
	usedMiB: number;
	totalMiB: number;
	size?: HostedSize;
	/** Next offered size, supplied by the session when available. */
	larger?: HostedSize;
}

export interface ListedSandbox {
	id: string;
	/** A disposable environment build, with its provider start time in milliseconds. */
	buildStartedAt?: number;
	sessionId: string;
	state: "running" | "paused";
}

export interface SandboxPrice {
	/** US dollars per second. */
	usdPerSecond: number;
	/** Display description of the resources included in the price. */
	basis: string;
}

export interface SandboxObservation {
	state: "none" | "running" | "paused";
	/** Provider timestamp of the last pause, in ms since the epoch. */
	pausedAt?: number;
}

export async function observeSandbox(sandboxes: Sandboxes, id: string): Promise<SandboxObservation> {
	return sandboxes.observe ? sandboxes.observe(id) : { state: await sandboxes.state(id) };
}

export interface Sandboxes {
	/** Idle timeout since last connect, excluding active turns and long commands. Null for manual suspension. Used for stopped-time accounting. */
	readonly idleStopMs: number | null;
	/** Estimated USD per second, or null for providers without per-second billing. */
	price(): SandboxPrice | null;
	/** Available sizes, smallest first. Absent for fixed-size providers. */
	sizes?(): HostedSizeOption[];
	/** Running and paused sandboxes across all servers, for reconciling the user's kept count. */
	list(uid: string): Promise<ListedSandbox[]>;
	/** Owners with hosted resources in this deployment, for orphan cleanup. */
	owners?(): Promise<string[]>;
	/** When true, replacing a lost sandbox requires restoring a backup or opening a new Windlass session. */
	readonly sessionsLiveInSandbox: boolean;
	/** Predict private data for a new sandbox. For an existing one, use its handle's ownData. Absent means false. */
	privateSessionData?(profile: SandboxProfileId): Promise<boolean>;
	/** Delete orphaned private volumes older than minAgeMs (default ten minutes) to avoid racing a create. */
	sweepDataVolumes?(minAgeMs?: number): Promise<number>;
	/** Prepare hosted Docker relay support and remove stale forwarders and token files at server start. */
	prepareModelRelay?(): Promise<string>;
	/** Deployment network policy, where supported. */
	egress?(): EgressMode;
	/** Deployment-wide allowed hosts. Empty for open E2B networking. */
	allowedHosts?(): readonly string[];
	/** Apply hosts only to a sandbox this server holds, without starting it or extending its lease. False defers the change to connect. */
	setNetwork?(id: string, hosts: readonly string[]): Promise<boolean>;
	/** Every profile, available or not, in the order the picker shows them. */
	profiles(): SandboxProfile[];
	profile(id: SandboxProfileId): SandboxProfile;
	/** Start an empty workspace or matching snapshot. An unavailable profile or the E2B running cap raises SandboxUserError. */
	create(input: CreateSandboxInput): Promise<string>;
	hasSnapshot?(uid: string, repo: string): Promise<boolean>;
	saveSnapshot?(id: string, source: SnapshotSource): Promise<boolean>;
	dropSnapshots?(uid: string, repo?: string): Promise<void>;
	sweepSnapshots?(retained: (uid: string) => Promise<ReadonlySet<string> | null>): Promise<void>;
	/** Resume if paused, returning undefined if gone. E2B resumes count against the create limit and may auto-pause after idle. */
	connect(id: string, options?: ConnectOptions): Promise<SandboxHandle | undefined>;
	/** "none" when it does not exist. */
	state(id: string): Promise<"none" | "running" | "paused">;
	/** State and pause time from one provider observation, where available. This never starts the sandbox. */
	observe?(id: string): Promise<SandboxObservation>;
	/** Stop active turns first. Suspension removes their token file, preserves files, and tolerates a missing sandbox. Exceptions on E2B: an environment builder is destroyed, and with WLP_E2B_PAUSE=0 every sandbox is killed. */
	suspend(id: string): Promise<void>;
	/** Idempotently remove the sandbox and its private data, including orphaned session volumes. Shared user volumes survive. */
	destroy(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Running Windlass in a sandbox
// ---------------------------------------------------------------------------------------------

export interface TurnQuestion {
	messageId: string;
	callId: string;
	title: string;
	/** The command, path or tool, verbatim. */
	subject: string;
	details: string[];
	choices: Array<{ id: string; label: string; approve: boolean; remembers: string | null }>;
	/** Set when a subagent asked: the first line of its task. */
	subagent: string | null;
}

export interface TurnAnswer {
	choice: string;
	/** Goes to the model with the result. */
	note?: string;
}

/** Repository-controlled MCP commands require approval for the exact definition before launch. */
export interface TurnServerQuestion {
	name: string;
	/** A changed definition invalidates the approval. */
	fingerprint: string;
	/** Command and argv, or null for a remote server. */
	argv: string[] | null;
	/** Remote server address, or null for a command. */
	url: string | null;
	/** The file that defines it, as a path in the sandbox; null when Windlass named none. */
	file: string | null;
	/** Unset variables referenced by env or headers prevent startup. Empty also covers unreadable definitions. */
	unset: string[];
	/** Referenced turn secrets disclosed to the server if approved. */
	secrets?: string[];
	/** Pre-prompt approval blocks the turn. Later questions are withdrawn when the turn ends. */
	holdsTurn: boolean;
}

/** Project servers and personal servers supplied by this turn. Excludes disabled and unrelated sandbox-user entries. */
export interface TurnServer {
	name: string;
	/** A project override makes a personal server project-owned. */
	origin: "project" | "user";
	/** Waiting servers require approval. Unrecognized states map to stopped. */
	state: "running" | "starting" | "waiting" | "failed" | "stopped";
	/** The command and each of its arguments; null for a server reached at an address. */
	argv: string[] | null;
	/** The address of a server that is reached and not started; null for a command. */
	url: string | null;
	/** The file that defines it, as a path in the sandbox; null when Windlass named none. */
	file: string | null;
	tools: number | null;
	error: string | null;
	/** Windlass's mark for the definition, which it gives only while the server waits; null otherwise. */
	fingerprint: string | null;
}

export type TurnServerOutcome =
	| { state: "running"; tools: number }
	/** Approval accepted, startup still pending. */
	| { state: "starting" }
	/** Startup failed after approval. Windlass may retry. */
	| { state: "failed"; reason: string }
	/** A changed definition requires a new approval. */
	| { state: "changed" }
	/** Approval request failed or was refused. */
	| { state: "refused"; reason: string };

export interface TurnPersonalServer {
	name: string;
	definition: Record<string, unknown>;
	/** Calls may receive one-time approvals through onUnasked. */
	unasked?: boolean;
}

export interface TurnUnaskedCall {
	/** The call, as `tool.called` and `approval.requested` name it. */
	messageId: string;
	callId: string;
	/** The server, by its name in `RunTurnInput.servers`, and the tool as that server names it. */
	server: string;
	tool: string;
}

export interface TurnSecrets {
	env: Record<string, string>;
	/** Names in `env` that no command the agent runs is to be given (Windlass's `withholdEnv`). */
	withholdEnv: string[];
	/** Names in `env` that look like credentials and that sandboxed commands are to be given all the same (Windlass's `passEnv`). */
	passEnv: string[];
	redactor: Redactor;
}

export interface TurnPublishRequest {
	/** Windlass identifies the call as messageId/callId. */
	messageId: string;
	callId: string;
	/** Model-supplied arguments remain untrusted after schema validation and secret redaction. */
	arguments: Record<string, unknown>;
	/** An MCP call may originate from any sandbox process. Absent for Windlass host calls. */
	via?: "mcp";
}

/** A handle on a turn in progress. Its methods reject once the turn has ended. */
export interface TurnControl {
	/** Sends a message into the running turn; the model reads it at its next step. Resolves once Windlass admitted it. */
	steer(text: string): Promise<void>;
	/** Stops one running tool call; the turn goes on. `stopped: false` with Windlass's reason when it could not be asked to stop. */
	cancelCall(messageId: string, callId: string): Promise<{ stopped: boolean; message: string | null }>;
}

/** Secret-free JSON stored with the timeline. Only the same harness may reattach to it. */
export interface TurnCheckpoint {
	harness: string;
	process: string;
	tag: string;
	state: Record<string, unknown>;
}

/** Abort reason for a hosted turn winding down for restart. An ordinary Stop interrupts as the user. */
export const PLATFORM_RESTART = Symbol("platform restart");

export interface RunTurnInput {
	modelKey?: {
		sessionId: string;
		key: import("./provider.js").ModelKeyLease;
		takeRequest?: import("./provider.js").TakeRelayRequest;
	};
	/** A requested PR review starts in this transport-owned, read-only checkout. */
	reviewDirectory?: string;
	/** Read synchronously to checkpoint. Null until prompted, once stopping, or on providers without durable processes. */
	onCheckpoint?: (read: () => TurnCheckpoint | null) => void;
	/** Take up the process this checkpoint names instead of starting one: the turn goes on where it was. */
	reattach?: TurnCheckpoint;
	/** Turn deadline, ms since epoch. The shell timeout hook enforces it. */
	endsAt?: number;
	/** Callback failures do not stop the turn. Relay marks include elapsed ms. */
	onStartMark?: (mark: StartMark, ms?: number) => void;
	/** Selection captured when the prompt was accepted. Absent uses the harness or profile default. */
	mode?: string;
	planMode?: boolean;
	/** Efforts already observed on other models in this session. */
	harnessModels?: ModelList | null;
	onEffortFallback?: (fallback: string | null) => void;
	/** The effective ACP mode and choices on open. fallbackFrom names a requested mode the agent no longer offers. */
	onAcpModes?: (mode: string, offered: SessionMode[], fallbackFrom?: string) => void;
	onAcpNote?: (text: string) => void;
	/** Unattended turns require the requested mode and grant individual permissions once. Machine harnesses require hardened isolation. */
	unattended?: boolean;
	prompt: string;
	/** Outside sources taint the session before the first step. Engines without marker support receive the prompt and trigger onUntrustedUnmarked. */
	untrusted?: string[];
	onUntrustedUnmarked?: () => void;
	/** Full replacement task and its own outside sources if the saved conversation cannot resume. Then resumed is false. */
	fresh?: { prompt: string; untrusted?: string[] };
	/** Stop automatic personal-server tool approvals as soon as the session reports taint. */
	unaskedUntilTainted?: boolean;
	/** Windlass's own session to continue (`session/resume`); omitted for the first turn. */
	windlassSessionId?: string;
	model?: string;
	effort?: string;
	/** Scripted responses bypass sign-in and the model. Tool calls still run in the sandbox. */
	script?: ScriptedModel;
	signal?: AbortSignal;
	/** Inject scoped values via secretEnv. Redact all saved values, including setup-only secrets and values split across streamed chunks, before returning any output. */
	secrets?: TurnSecrets;
	/** Replace previously managed servers before opening the session and remove them at turn end. Preserve unrelated config; leave an unreadable file alone. */
	servers?: TurnPersonalServer[];
	/** Required repository checks for this session. The platform runs them at prompt end for agents using platform checks. */
	checks?: RepositoryCheck[];
	/** A checks-only builder turn runs all saved platform checks, even on an unchanged tree. */
	forceChecks?: boolean;
	/** Platform check results in verification-log event order. */
	onChecks?: (event: WindlassEvent, note?: import("./platform-checks.js").ChecksNote) => void;
	/** One-time approval between approval.requested and approval.answered. Requires an engine-matched tool on a turn-supplied, user-owned server and a session request, never a subagent. */
	onUnasked?: (call: TurnUnaskedCall) => void;
	/** Ordered Windlass events followed by one cli.summary aggregating all executions, including late steered messages. */
	onEvent?: (event: WindlassEvent) => void;
	onAcpUpdate?: (update: AcpUpdate) => void;
	/** The session has no title of its own or generated yet: an ACP turn that ended well waits briefly for the agent's (`AcpQuirks.titleWaitMs`). */
	wantsTitle?: boolean;
	/** The turn waits for an answer. Withdrawal ignores late answers; rejection or a missing handler declines the call. */
	onQuestion?: (question: TurnQuestion, signal: AbortSignal) => Promise<TurnAnswer>;
	/** Ask once per waiting definition per turn, serially. Pre-prompt questions hold the turn. Rejecting or omitting the callback leaves the server stopped. */
	onServerQuestion?: (question: TurnServerQuestion, signal: AbortSignal) => Promise<boolean>;
	/** Called after `onServerQuestion` resolved with true, once it is known what became of the server. */
	onServerApproved?: (question: TurnServerQuestion, outcome: TurnServerOutcome) => void;
	/** Full server list before approval questions and on changes. The list expires with the turn. */
	onServers?: (servers: TurnServer[]) => void;
	onControl?: (control: TurnControl) => void;
	/** Platform tool callbacks own authorization. The call waits for the result; settlement or turn end aborts the signal and discards late results. */
	onPublish?: (request: TurnPublishRequest, signal: AbortSignal) => Promise<string>;
	/** Host declarations accepted when Windlass opened this session. */
	onHostTools?: (names: string[]) => void;
	onSetup?: RunTurnInput["onReport"];
	onSetupReview?: RunTurnInput["onReport"];
	onPlanReview?: RunTurnInput["onReport"];
	onPlan?: RunTurnInput["onReport"];
	/** With `onPlan`: a cross-repo feature's planning turn, whose `file_plan` takes the plan's repositories too. */
	crossRepoPlan?: boolean;
	planner?: boolean;
	repoSetup?: boolean;
	/** Resume an item's conversation as a builder after it ran with the planner agent. */
	clearPlanner?: boolean;
	onReport?: (request: TurnPublishRequest, signal: AbortSignal) => string | Promise<string>;
	/** A work item's builder asks its person a question (`ask_person`); returns what the agent is told, at once. Given only with `onReport`. */
	onAsk?: (request: TurnPublishRequest, signal: AbortSignal) => string | Promise<string>;
	/** Ask the owner for a missing environment variable. The agent only receives the receipt. */
	onRequestSecret?: (request: TurnPublishRequest, signal: AbortSignal) => string | Promise<string>;
	onReview?: (request: TurnPublishRequest, signal: AbortSignal) => Promise<string>;
	reportScreenshots?: boolean;
	/** The agent pushes the session's branch (`push`). Given with `onFetchBase`. */
	onPush?: (request: TurnPublishRequest, signal: AbortSignal) => Promise<string>;
	/** The agent has the session's base branch fetched into the workspace (`fetch_base`). Given with `onPush`. */
	onFetchBase?: (request: TurnPublishRequest, signal: AbortSignal) => Promise<string>;
	/** Model step limit, or platform-counted tool calls for platform steps. Omitted uses the engine default. */
	maxSteps?: number;
	/** ACP idle limit while there is no active tool or question. Defaults to ACP_IDLE_MS. */
	idleMs?: number;
}

export interface TurnChecks {
	/** What the repository's own configuration file said about checks then (windlass-config.ts, `projectChecks`); null when it is not there or says nothing. */
	project: ProjectChecks | null;
}

export interface RunTurnResult {
	/** Windlass ACP session/prompt stop reason, when the request was answered. */
	stopReason?: string;
	acp?: {
		stopReason: string | null;
		usage: AcpContext | null;
		models: ModelList | null;
		/** The turn's tokens from the `session/prompt` answer; null where the agent reported none. */
		tokens?: TurnUsage | null;
		/** The Claude 5h window at the turn's first usage update; `usage.fiveHourUsedPct` is its last. */
		fiveHourAtStart?: number;
		steps?: number;
		/** Set when the platform stopped the turn at this many tool calls (`maxSteps`). */
		stepLimit?: number;
		/** How the platform's checks ended the turn (platform-checks.ts): "unresolved" when checks did not pass. */
		checks?: string | null;
	};
	/** Whether the ACP session could be continued when a previous id was supplied. */
	resumed?: boolean;
	/** Zero after orderly engine exit regardless of turn outcome; null when killed. */
	exitCode: number | null;
	aborted: boolean;
	timedOut: boolean;
	windlassSessionId: string | null;
	/** The summary event the layer made (see `onEvent`); null when the turn ended before Windlass reported how. */
	summary: WindlassEvent | null;
	stderrTail: string;
	/** Null on abort. Distinguish sign-in refusal (auth_required) from temporary handoff failure (token_unavailable) using stable codes. Preserve other engine reasons. */
	failure: { reason: string; message: string; resetsAt?: number; window?: import("../contract.js").UsageWindow } | null;
	/** What Windlass had for checks in this turn. Absent when the turn ended before its configuration was dealt with. */
	checks?: TurnChecks;
}

/** `{ "responses": [[item, ...], ...] }`: one list per model call. */
export interface ScriptedModel {
	responses: Array<Array<Record<string, unknown>>>;
}

export interface Windlass {
	/** Image or template Windlass version. May be null until the first E2B create: looking it up must not start a sandbox. */
	version(): Promise<string | null>;
	problem(): Promise<string | null>;
	/** Run one ACP process per turn. Cancel over ACP first. Redact credentials from outputs and remove the token file at turn end. Lifetimes: the token file belongs to the session, a relay placeholder to the turn; a real ChatGPT bearer stays valid across the user's sessions until it expires, so removing a file does not revoke a disclosed one. */
	runTurn(sandbox: SandboxHandle, input: RunTurnInput): Promise<RunTurnResult>;
	/** Scripted model with real tool calls. Turn numbering starts at one. */
	demoScript(prompt: string, turn: number): ScriptedModel;
}

// ---------------------------------------------------------------------------------------------
// Sign in with ChatGPT, done by Windlass itself (`windlass login start|finish|status|token`)
// ---------------------------------------------------------------------------------------------

export interface ChatgptAccount {
	/** OpenAI's subject for the account within this OAuth app. */
	sub: string;
	email: string | null;
	/** When the saved access token expires, ms since the epoch. */
	accessExpiresAt: number | null;
}

/** Thrown for a failure the user can act on; `message` is fit to show. */
export class SandboxUserError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxUserError";
	}
}

/** The machine cannot be reached; `message` is the sentence a person reads. */
export class MachineUnreachable extends SandboxUserError {
	constructor(
		readonly reason: "offline" | "removed",
		message: string,
	) {
		super(message);
	}
}

/** The connection ended without returning the sandbox operation's result. */
export class SandboxConnectionLost extends Error {}

export function sandboxConnectionLost(error: unknown): boolean {
	return error instanceof SandboxConnectionLost || (error instanceof MachineUnreachable && error.reason === "offline");
}

/** A deployment capacity refusal makes factory work wait. Callers distinguish the class, not the message. */
export class DeploymentFull extends SandboxUserError {
	constructor(
		readonly limit: number,
		message: string,
	) {
		super(message);
		this.name = "DeploymentFull";
	}
}

/** The login actor holds a sealed attempt bound to its ID. The user actor owns the adopted sign-in, so any server can serve the next step. */
export interface ChatgptLogins {
	/** Begins a sign-in and returns the address to open, and the pending attempt, sealed, to hand to `finish`. */
	start(attemptId: string): Promise<{ url: string; redirectPrefix: string; attempt: string }>;
	/** The same callback can retry a completed attempt without a second exchange. Refuse a different callback or a mismatched sealed attempt. */
	finish(attemptId: string, attempt: string, pastedUrl: string): Promise<{ account: ChatgptAccount; attempt: string }>;
	/** Requires a finished attempt. Seal it for this user, invalidate earlier cached tokens and prepare the user's storage. */
	adopt(attemptId: string, attempt: string, uid: string, pendingId?: string): Promise<void>;
	/** The sign-in the user's actor holds: who signed in and when the saved access token expires. Null when there is none. */
	status(uid: string): Promise<ChatgptAccount | null>;
	/** Invalidate cached tokens and remove active token files. Previously disclosed access tokens last until expiry. */
	logout(uid: string): Promise<void>;
	/** Ensure user session storage exists even for demo users. It never holds a sign-in. */
	ensureUserVolume(uid: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Access tokens: the one place that reads a sign-in and refreshes it
// ---------------------------------------------------------------------------------------------

export interface AccessToken {
	/** A secret: never logged, never part of an error message or an event. */
	accessToken: string;
	/** When it expires, ms since the epoch. */
	expiresAt: number;
}

export interface AccessTokens {
	/** The user actor serializes refreshes, persists rotations before replying and seals each reply for its request. Request 20 minutes of validity; reuse shorter tokens for half their remaining life. SandboxUserError requires sign-in. */
	current(uid: string): Promise<AccessToken>;
}

// ---------------------------------------------------------------------------------------------
// A copy of an agent's session data, kept outside the sandbox
// ---------------------------------------------------------------------------------------------

export interface BackupOwner {
	uid: string;
	sessionId: string;
}

/** The agent's own session a copy is of: whose files are packed (session-files.ts), and the id they are named by. */
export interface BackupAgentSession {
	/** Windlass's for none, as `capabilitiesOf`. */
	harness?: HarnessId;
	/** The agent's session id (`SessionMeta.windlassSessionId`). */
	sessionId: string;
}

export interface SavedBackup {
	size: number;
	/** The archive's SHA-256, in hex. */
	sha256: string;
	/** When it was saved, ms since the epoch. */
	at: number;
}

export type BackupSaveResult =
	| { outcome: "saved"; backup: SavedBackup; ms: number }
	/** The agent has no session in this sandbox yet: there is nothing to copy. */
	| { outcome: "empty" }
	/** Oversize archives leave the previous copy intact. */
	| { outcome: "too_large"; size: number; limit: number }
	/** Safe to log. Failure may or may not preserve the previous copy. */
	| { outcome: "failed"; reason: string };

export type BackupRestoreResult =
	| { outcome: "restored"; ms: number }
	| { outcome: "missing" }
	/** The copy could not be fetched, is not the one that was saved, or does not hold the agent's session. `reason` is for a log. */
	| { outcome: "failed"; reason: string };

/**
 * Only copy between turns, with session files closed. In the bucket (backup.ts), signed URLs move
 * archives directly between the sandbox and the bucket; on a machine (machine-backups.ts), its runner
 * moves them between the sandbox and a volume on that machine, and they never leave it.
 */
export interface SessionBackups {
	/** The largest archive that is kept, in bytes. */
	readonly maxBytes: number;
	/**
	 * Whether copies can be saved and restored now; absent means always. A machine's are only while its
	 * runner offers them (the `session-backups` capability), which an older runner does not: nothing is
	 * then saved or restored, and nothing is said of it. Never throws.
	 */
	available?(): Promise<boolean>;
	/** Packs the agent's session data in the sandbox and has it moved to where copies are kept, replacing the session's earlier copy. Never throws. */
	save(sandbox: SandboxHandle, owner: BackupOwner, session: BackupAgentSession): Promise<BackupSaveResult>;
	/** Verify size, hash, what the archive holds and the expected agent session before restoring. Returns failure as a result. */
	restore(
		sandbox: SandboxHandle,
		owner: BackupOwner,
		saved: SavedBackup,
		session: BackupAgentSession,
	): Promise<BackupRestoreResult>;
	/**
	 * Removes the session's copy. A no-op when there is none. Throws when the store could not be told. A
	 * machine's is recorded with the machine's actor, which has the runner remove it when it is next
	 * connected.
	 */
	remove(owner: BackupOwner): Promise<void>;
	/**
	 * Copies one session's copy to another's name inside the store, replacing what was there; the archive
	 * passes through neither the server nor a sandbox. False when `from` has no copy. Throws when the
	 * store could not be told. A machine's is asked over `to`'s own socket, so it is called from the
	 * layer of the session `to` (its runner refuses any other).
	 */
	copy(from: BackupOwner, to: BackupOwner): Promise<boolean>;
	/** The name of the session's copy where it is kept, for a log. */
	keyOf(owner: BackupOwner): string;
}

export interface SandboxLayer {
	/** Present only on the layer backed by this machine's runner. */
	machine?: { name: string };
	sandboxes: Sandboxes;
	windlass: Windlass;
	logins: ChatgptLogins;
	tokens: AccessTokens;
	/**
	 * Absent without a configured copy source and destination (hosted: no bucket). Losing session-local
	 * data then requires a fresh session. A machine's layer has the machine's own (`available` says
	 * whether its runner keeps them).
	 */
	backups?: SessionBackups | null;
}
