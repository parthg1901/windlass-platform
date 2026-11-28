/**
 * Shared wire types and runtime constants for the actors, runner and web app. Keep all runtime imports browser-safe.
 * This file holds sandboxes, platform info, login and session basics (HarnessId, SessionSummary) and re-exports:
 * contract/github.ts (GitHub, GitLab, Linear, publishing), repository.ts (setup, checks, environments, network, secrets),
 * account.ts (settings, model providers, API tokens), machines.ts, items.ts (work items), reviews.ts,
 * timeline.ts (Windlass/ACP events, timeline), questions.ts (questions, MCP servers), actors.ts (actor
 * actions/events, snapshot), limits.ts (endpoints, paths, size limits), slack.ts (Slack settings), identity.ts
 * (linked accounts on other surfaces), usage.ts,
 * hosted-sizes.ts, isolation.ts.
 */

import type { GithubId, PullRequestInfo, SessionRepository } from "./contract/github.js";
import type { PlanInfo } from "./contract/usage.js";
export type {
	UsageNumbers,
	HostedMonth,
	PlanId,
	BillingPeriod,
	PlanInfo,
	BillingView,
	UsageSession,
	UsageDay,
	KeptSandbox,
	UsagePrice,
	UsageView,
} from "./contract/usage.js";
import type { HostedSize, HostedSizeOption } from "./contract/hosted-sizes.js";
export type { HostedSize, HostedSizeOption } from "./contract/hosted-sizes.js";
export type { Isolation } from "./contract/isolation.js";
export { ISOLATION_LINES, ISOLATION_NAMES, PROFILE_ISOLATION, isolationName, openLine } from "./contract/isolation.js";
export {
	HOSTED_SIZES,
	HOSTED_SIZE_NAMES,
	HOSTED_SIZE_SPECS,
	ITEM_HOSTED_SIZE,
	SESSION_HOSTED_SIZE,
	isHostedSize,
	hostedSizeWords,
	hostedSizeFor,
	largerHostedSize,
	outOfMemoryWords,
} from "./contract/hosted-sizes.js";
export * from "./contract/github.js";
export * from "./contract/repository.js";
export * from "./contract/account.js";
export * from "./contract/machines.js";
export * from "./contract/items.js";
export * from "./contract/reviews.js";
export * from "./contract/timeline.js";
export * from "./contract/questions.js";
export * from "./contract/actors.js";
export * from "./contract/limits.js";
export * from "./contract/slack.js";
export * from "./contract/identity.js";

// Sandboxes

/** Whose machine runs the sandbox. A session keeps its place for its whole life. */
export type SandboxPlace = { kind: "hosted" } | { kind: "machine"; machineId: string };

/** The kind of sandbox a session uses. Each place says which profiles it offers. */
export type SandboxProfileId =
	| "docker-windlass-sandbox"
	| "docker-hardened"
	| "e2b"
	| "e2b-open"
	| "daytona"
	| "firecracker"
	| "agentos";

export type EgressMode = "open" | "restricted" | "none";

export interface SandboxProfile {
	id: SandboxProfileId;
	/** The user's word for it: "Strict" or "Open" (contract/isolation.ts). Where it runs is said beside it, never in it. */
	name: string;
	/** One outcome line, free of provider and technology names: "Commands sandboxed, no internet. For untrusted code." */
	summary: string;
	/** How it is isolated, in full: shown only behind "How it's isolated", where provider and technology names belong. */
	details?: string;
	/** What isolates the agent, outermost layer first. Short phrases; technical, so only behind "How it's isolated". */
	layers: string[];
	/** The `--approval` mode Windlass runs with in this profile. */
	approval: "auto" | "full";
	/** Whether commands the agent runs can reach the network. */
	commandNetwork: boolean;
	commandNetworkText?: string;
	/** Runner-confirmed credential isolation for Claude sessions using this profile. */
	claudeRelay?: true;
	/** Hosted ACP agents can reach the Settings-key relay from this profile. */
	platformKeys?: true;
	/** Commands can read the turn's token file, including a usable relay placeholder. The renewing sign-in stays outside the sandbox. */
	commandsCanReadAccessToken: boolean;
	/** Can commands read the real access token? Defaults to commandsCanReadAccessToken when absent. */
	accessTokenReadable?: boolean;
	/** A relayed turn keeps only a per-turn placeholder in the sandbox. Without the relay the file holds the access token. */
	modelRelay?: true;
	available: boolean;
	/** Why it cannot be chosen yet. Set when `available` is false. */
	unavailableReason?: string;
}

// Platform information (GET PLATFORM_INFO_PATH)

export interface PlatformInfo {
	googleLogin?: true;
	/** True when the server runs with WLP_DEMO=1: the demo sign-in is offered and its model is scripted. */
	demoEnabled: boolean;
	/** The Windlass version inside the sandbox image, e.g. "0.4.0". */
	windlassVersion: string | null;
	profiles: SandboxProfile[];
	/** Restricted allows the model API, GitHub and approved hosts. None allows only the model API. Absent when no restriction is reported. */
	hostedEgress?: "restricted" | "none";
	/** Smallest first. Omitted when the deployment offers a single fixed size. */
	hostedSizes?: HostedSizeOption[];
	/** Absent or null disables GitHub integration. */
	github?: GithubInfo | null;
	/** Absent disables the machines route. */
	machines?: MachinesInfo;
	/** Absent disables items and API token actions. A deployment-wide screenshot refusal overrides repository settings. */
	items?: { reviewer: boolean; orchestrate?: boolean; screenshots?: boolean };
	/** Set when the deployment takes payment for plans (WLP_BILLING_PROVIDER). Absent: no plans, the deployment's own limits, and nothing of billing shown. */
	billing?: { plans: PlanInfo[] };
}

/** Published runner capabilities and connection details for pairing. The runner volume preserves the pairing key across updates within a protocol. */
export interface MachinesInfo {
	platformFingerprint?: string;
	/** Oldest compatible runner release for this deployment's protocol. */
	minRunnerVersion: string;
	/** The runner image to install, pinned by digest; null while none is published, and the page says it cannot be installed yet. */
	runnerImage: string | null;
	/** Harnesses built into this exact published image, from its capabilities command. */
	runnerHarnesses?: Array<Exclude<HarnessId, "windlass">>;
	/** The platform's address as a runner on another machine reaches it: `--platform` in the install command. */
	platformUrl: string;
}

// The models a user may choose (`UserActions.models`)

/** One model, and the reasoning efforts it accepts: none for a model that takes no effort. */
export interface ModelChoice {
	id: string;
	/** What the provider calls it, where that is not its id. */
	name: string | null;
	efforts: string[];
}

/** Account-specific model and effort choices, cached by the user actor. */
export interface ModelList {
	/** An unavailable list has neither a fresh answer nor a cached account list. */
	source: "account" | "harness" | "demo" | "signed-out" | "unavailable";
	models: ModelChoice[];
	/** The model a session starts on where nothing else says: one of `models`. */
	defaultModel: string;
	/** When the plan's list was read, ms since the epoch; null for the stand-in. */
	fetchedAt: number | null;
}

/** What the web app needs to know of the deployment's GitHub App. */
export interface GithubInfo {
	/** The app's name on GitHub, as its address has it: `https://github.com/apps/<slug>`. */
	slug: string;
	/** Where GitHub is: "https://github.com". */
	url: string;
}

/** @deprecated The `platform` actor is gone: the information is served over HTTP (PLATFORM_INFO_PATH). */
export interface PlatformActions {
	info(): Promise<PlatformInfo>;
}

// The browser's connection to the actors (HTTP, `GET PLATFORM_CONNECTION_PATH`)

/** A token of the Rivet engine's for browsers: good for a while, and for reaching this deployment's actors only. */
export interface ConnectionToken {
	token: string;
	/** When the engine stops accepting it, ms since the epoch, by the engine's clock. */
	expiresAt: number;
	/** Count from receipt. The browser clock can differ from the server by more than a token lifetime. */
	validForMs: number;
}

/** What a browser needs to reach the actors. */
export interface PlatformConnection {
	/** Null uses the endpoint built into the web app, falling back to DEFAULT_ENDPOINT. */
	endpoint: string | null;
	/** The namespace the actors live in. */
	namespace: string;
	/** Null when the engine asks for no token: the local engine of a development server. */
	token: ConnectionToken | null;
}

// Login

/** Opaque to the web app: stored and sent back as the `token` connection parameter. */
export type AuthToken = string;

export interface UserProfile {
	uid: string;
	/** The verified address supplied by the login provider, when available. */
	email: string | null;
	/** A demo user has no ChatGPT sign-in: its sessions run a scripted model. */
	demo: boolean;
}

export interface AuthResult {
	token: AuthToken;
	profile: UserProfile;
}

export type LoginProvider = "github" | "google";

export interface LinkedLogin {
	provider: LoginProvider;
	/** Provider login or email for display. Older links may have no label until the next sign-in. */
	display: string | null;
	/** The provider's name for the person, and an https picture address, captured at the last sign-in. */
	name: string | null;
	avatar: string | null;
}

export interface LoginStart {
	url: string;
	redirectPrefix: string;
	/** When this attempt stops being accepted, ms since the epoch. */
	expiresAt: number;
}

// Sessions and harnesses

export type SessionStatus =
	/** Nothing running; ready for a prompt. */
	| "idle"
	/** A prompt was accepted; the sandbox is being created or started. */
	| "starting"
	/** Windlass is working on a prompt. */
	| "running"
	/** A turn is running and Windlass waits for the user's answer to a question (`SessionSnapshot.question`). */
	| "waiting"
	/** A stop was asked for and Windlass is winding down. */
	| "stopping"
	/** An unfinished turn resumes when its server or machine returns. Messages wait meanwhile. */
	| "paused";

/** How a turn ended. The first five are Windlass's own outcomes (`cli.summary.outcome`). */
export type TurnOutcome =
	| "succeeded"
	| "unresolved"
	| "failed"
	| "stopped"
	| "interrupted"
	/** The platform could not run the turn at all (sandbox failure, Windlass crashed). */
	| "error";

/** Every agent the platform runs; the canonical list (`HarnessId`). Per-agent facts live in sandbox/harnesses.ts. */
export const HARNESS_IDS = ["windlass", "claude", "opencode", "codex"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];
/** The agents a machine (or a hosted ACP sandbox) runs: every harness but Windlass. */
export const MACHINE_HARNESS_IDS = ["claude", "opencode", "codex"] as const satisfies readonly HarnessId[];
export type MachineHarnessId = (typeof MACHINE_HARNESS_IDS)[number];

export function isHarnessId(value: unknown): value is HarnessId {
	return (HARNESS_IDS as readonly unknown[]).includes(value);
}

/** One of the platform's tools, by the name the agent calls it (server/src/platform-tools.ts, `PlatformTool`). */
export type PlatformToolName =
	| "publish"
	| "report"
	| "request_secret"
	| "ask_person"
	| "push"
	| "fetch_base"
	| "file_review"
	| "file_plan"
	| "file_plan_review"
	| "file_repo_setup"
	| "file_repo_setup_review";

/** Screens choose behavior by capability, so a new harness needs no agent-name checks. */
export interface SessionCapabilities {
	/** Stopping one tool call of a running turn; without it, only the turn. */
	cancelCall: boolean;
	/** What its turns report of their use: token counts per model call ("tokens"), or how full the context is and each turn's tokens where it reports them ("context"). */
	usage: "tokens" | "context" | "none";
	/** Whether the user's saved checks run before a turn is called done: by the agent's engine ("required"), by the platform between the agent's prompts ("platform"), or not ("none": CI decides). */
	checks: "required" | "platform" | "none";
	/** Whether saved secrets are handed to the agent, with named variables withheld from commands or passed to them. */
	envLists: boolean;
	/** The platform's tools it can be given. Without "publish", the person publishes from the side panel. */
	platformTools: readonly PlatformToolName[];
	/** Screenshots with a builder's report. */
	reportScreenshots: boolean;
	/** Where the models a prompt may name come from: the account's plan, or the agent's own list (pickers drawn only where it offers a choice). */
	models: "account" | "harness";
	/** A plan mode of the agent's own, chosen per prompt (`PromptInput.planMode`). */
	planMode: boolean;
	/** Whether a project's own MCP servers wait for the person's approval in the side panel. */
	projectServerApproval: boolean;
}

export interface SessionMode {
	id: string;
	name: string;
	/** ACP agents may omit the description. */
	description: string | null;
}

/** A machine's prompt-free ACP options. Efforts are the choices available for each model. */
export interface HarnessOptions {
	models: ModelChoice[];
	defaultModel: string;
	modes: SessionMode[];
	checkedAt: number;
}

/** Launch choices for the pinned Claude adapter. Once opened, the session reports its actual list. */
export const CLAUDE_LAUNCH_MODES: readonly SessionMode[] = [
	{ id: "default", name: "Manual", description: "Ask before using tools." },
	{ id: "acceptEdits", name: "Accept edits", description: "Allow file edits." },
	{ id: "plan", name: "Plan", description: "Plan the work before editing." },
	{ id: "auto", name: "Auto", description: "Automatically assess tool permissions." },
	{ id: "bypassPermissions", name: "Bypass permissions", description: "Run tools without permission prompts." },
];

/** Milliseconds from slot admission to first output. Phases that did not run are omitted. */
export interface StartTimes {
	turn: number;
	/** When the turn started. */
	at: number;
	harness: HarnessId;
	place: "hosted" | "machine" | "e2b";
	/** A sandbox was made for this turn (false: an existing one was connected or resumed). */
	newSandbox: boolean;
	/** Waiting for a free slot on the machine, before the start. */
	waited?: number;
	/** The runner's image check, and pull when `pulled`. */
	image?: number;
	pulled?: boolean;
	/** Making and starting the container, or resuming it, as the server saw it (on a machine: with the runner's round trips and image check). */
	sandbox?: number;
	/** The part of `sandbox` the runner spent creating the container itself. */
	runnerCreate?: number;
	spare?: true;
	/** Cloning, the repository's setup command, a restored memory or prepared image. */
	setup?: number;
	/** The platform's own work between the sandbox being ready and the agent's process starting: leftover processes, the token file. */
	prepare?: number;
	/** Windlass's model relay for this turn: the relay container when it was not running, and the turn's forwarder. Part of `prepare`. */
	relay?: number;
	/** From starting the agent's process until it answered ACP `initialize`. */
	agent?: number;
	/** session/new or resume, and the mode and model choices, until the prompt was sent. */
	session?: number;
	/** From the prompt being sent to the agent's first output (text, thinking or a tool call). */
	firstOutput?: number;
	/** From the turn's start to the first output. */
	total?: number;
}

export interface SessionSummary {
	/** The mode selected for the next prompt. */
	mode: string;
	/** For Claude, the machine's reported choices until the session reports its own. Empty for item sessions. */
	availableModes: SessionMode[];
	harness?: HarnessId;
	/** What its agent can do (`SessionCapabilities`): the screens draw by these, not by `harness`. */
	capabilities: SessionCapabilities;
	harnessModels?: ModelList | null;
	id: string;
	title: string;
	place: SandboxPlace;
	profile: SandboxProfileId;
	/** Hosted, where the deployment offers sizes: the size of its sandboxes. */
	hostedSize?: HostedSize;
	model: string;
	/** The effort the next turn runs at unless its prompt names another; null (or absent, on older summaries) is the model's default. */
	effort?: string | null;
	/** A git repository cloned into the workspace when the sandbox was created, if any. */
	repoUrl: string | null;
	/** Absent or null for pasted URLs and sessions without a repository. */
	repository?: SessionRepository | null;
	/** The pull request the platform opened for the session's work, once there is one. */
	pullRequest?: PullRequestInfo | null;
	/** May bypass publish confirmation only where isolated commands have neither network nor token-file access. Else ask on every request. */
	publishUnasked?: boolean;
	createdAt: number;
	/** Last session activity, including turns, questions and pull request changes. */
	updatedAt: number;
	/** Start of the current turn, for its elapsed clock. */
	turnStartedAt?: number;
	status: SessionStatus;
	/** Machine-paused turns resume on reconnect and deliver any held messages. */
	paused?: { reason: "restart" | "machine"; since: number; held: number };
	turns: number;
	lastOutcome: TurnOutcome | null;
	/** The last few turns' start times, oldest first (StartTimes). */
	startTimes?: StartTimes[];
	/** Whether the sandbox exists and whether it is running or paused. */
	sandbox: "none" | "running" | "paused";
	/** Reload servers() when changedAt advances. Absent when the session has no known MCP servers. */
	servers?: { count: number; changedAt: number };
	/** Item sessions receive prompts from the factory. The recorded sign-in determines token accounting for machine agents. */
	item?: {
		id: string;
		role?: "builder" | "reviewer";
		subtaskScreenshots?: boolean;
		planCritic?: true;
		reviewer?: { id: string; status: SessionStatus };
		signIn?: "api-key" | "chatgpt" | "subscription";
	};
	/** Set for a session that only builds a prepared environment (environments.ts): it is not listed, and is deleted when done. */
	environmentBuild?: true;
	readiness?: true;
	/** Set when the session's sandbox started from a validated environment: the commit setup and the checks ran at, and when they passed. */
	environment?: { commit: string; validatedAt: number; checks: number };
	/** Set for a session made by `continueSession`: the session it continues, as it was named then. */
	continuedFrom?: { id: string; title: string };
}

export function itemSessionRole(item: NonNullable<SessionSummary["item"]>): string {
	return item.planCritic ? "Plan review" : item.role === "reviewer" ? "Code review" : "Builder";
}

export function sessionTitle(session: Pick<SessionSummary, "title" | "item">): string {
	return session.item ? `${session.title} · ${itemSessionRole(session.item)}` : session.title;
}

/** The user index keeps one builder per item. Its reviewer is reachable from the item and counts toward its usage. */
export function listedSessions(sessions: SessionSummary[]): SessionSummary[] {
	const reviewers = new Map(
		sessions.flatMap(s =>
			s.item?.role === "reviewer" && !s.item.planCritic ? [[s.item.id, { id: s.id, status: s.status }] as const] : [],
		),
	);
	return sessions
		.filter(s => s.item?.role !== "reviewer" && !s.environmentBuild && !s.readiness)
		.map(session => {
			const reviewer = session.item && reviewers.get(session.item.id);
			return session.item && reviewer ? { ...session, item: { ...session.item, reviewer } } : session;
		});
}

export interface CreateSessionInput {
	/** Machine sandbox size in slots. A personal session defaults to one. */
	size?: 1 | 2 | 4;
	/** Hosted only, where `PlatformInfo.hostedSizes` offers it: the sandbox's size. Left out: the repository's saved size, else small. */
	hostedSize?: HostedSize;
	/** Windlass defaults to the profile approval. Claude prefers auto when offered. */
	mode?: string;
	harness?: HarnessId;
	/** Defaults to "New agent"; replaced by the first prompt’s opening phrase when left unset. */
	title?: string;
	/** Left out: run on the hosted layer. */
	place?: SandboxPlace;
	profile: SandboxProfileId;
	/** An account model or a model offered by the machine's harness. Omit to use its default. */
	model?: string;
	/** An https git address to clone into the workspace. */
	repoUrl?: string;
	/** A connected repository is exclusive with repoUrl. Omit branch to use the repository default. */
	repository?: { id: GithubId; branch?: string };
	/** Omission preserves the saved command. An empty string clears it before session creation. */
	setupCommand?: string;
	/** With `repository`: `SessionSummary.publishUnasked` to start with. Left out: the agent's requests to publish are asked about. Refused (`bad_input`) for a profile it cannot be on in. */
	publishUnasked?: boolean;
	/** The key of this submission (`IdempotencyKey`): the same key again answers with the session the first attempt made, for as long as that session exists. */
	idempotencyKey?: IdempotencyKey;
}

/** What `continueSession` takes: the session to continue in a new one with a new workspace, branch and pull request. */
export interface ContinueSessionInput {
	id: string;
	/** Start from the session's pushed branch, so the new pull request is based on its pull request's branch. Left out: the repository's default branch. */
	stack?: boolean;
	idempotencyKey?: IdempotencyKey;
}

/** Replay the first accepted answer for the same key and payload. A refused submission leaves the key unused.
 * Missing or null disables deduplication. Invalid keys fail with bad_idempotency_key; changed payloads with idempotency_key_reused. */
export type IdempotencyKey = string;

export interface ChatgptStatus {
	connected: boolean;
	email: string | null;
	/** When the saved sign-in's access token expires, ms since the epoch. The platform refreshes it when a turn needs a token within twenty minutes of that, or after. */
	accessExpiresAt: number | null;
}
