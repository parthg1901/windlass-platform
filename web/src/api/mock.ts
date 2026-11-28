/**
 * One in-memory world per user per mock client, rebuilt on reload. Sessions keep durable events in their
 * timeline and broadcast transient deltas until the next durable event. This client owns the
 * timers for replay, pending questions and cancellation.
 */
import { modelRefusal, turnEffort } from "../../../server/src/account-models.js";
import { cleanDefaults, DefaultsProblem } from "../../../server/src/repository-defaults";
import { changedPlace, changesPlace, placeProblem, savedPlace } from "../../../server/src/factory/default-place";
import { PAY_WITH_HARNESSES, payWithPatchOf, PayWithProblem } from "../../../server/src/pay-with.js";
import { withoutUnofferedModels } from "../../../server/src/factory/resolve-run.js";
import type { AccountDefaultsPatch, RepositoryDefaultsPatch } from "@contract";
import { shiftMonths } from "../../../server/src/billing/meter.js";
import { machineDetails } from "../../../server/src/machines/details.js";
import {
	listedHarness,
	windlassModels,
	windlassProvider,
	hostedCatalog,
	hostedKeyMessage,
	hostedProfiles,
	hostedPayer,
	type HostedCredential,
	initialHarnessModels,
	sessionCapabilities,
} from "../../../server/src/sandbox/harnesses.js";
import { workspaceNetwork } from "../lib/machines";
import { codexModes } from "../../../server/src/sandbox/codex-modes.js";
import { applyOffers, offered, type OfferRow } from "../../../server/src/factory/readiness-track";
import { setupReport } from "../../../server/src/factory/readiness";
import { mockEnvironments, mockRebuild, mockSchedule } from "./mock-environments";
import { PROFILES, initialSessionModes, offeredProfiles, profilesFor } from "../../../server/src/sandbox/profiles.js";
import { githubId } from "../../../server/src/github/ids.js";
import { publishAsksEveryTime } from "../../../server/src/agent-publish.js";
import {
	NetworkProblem,
	cleanEntries,
	expandEntries,
	networkLimit,
	networkPresets,
} from "../../../server/src/repository-network.js";
import {
	HOSTED_SIZE_SPECS,
	ISOLATION_LINES,
	ISOLATION_NAMES,
	openLine,
	isHostedSize,
	type HostedSize,
	type HostedSizeOption,
	MAX_IDEMPOTENCY_KEY_CHARS,
	MAX_PROMPT_CHARS,
	MAX_SECRET_NAME_CHARS,
	MAX_ACCOUNT_SECRETS,
	MAX_PERSONAL_SERVERS,
	MAX_SECRET_VALUE_BYTES,
	MAX_SECRETS_PER_REPOSITORY,
	MAX_SERVER_DEFINITION_BYTES,
	MAX_SETUP_COMMAND_CHARS,
	MAX_CHECKS_PER_REPOSITORY,
	MAX_CHECK_NAME_CHARS,
	MAX_CHECK_TIMEOUT_SECONDS,
	MIN_SECRET_VALUE_CHARS,
	MAX_TITLE_CHARS,
	isolationName,
	generatedSessionTitle,
	promptTitle,
	sessionTitle,
	MAX_MACHINES,
	CLAUDE_LAUNCH_MODES,
	type RepositoryCheck,
	type RepositoryChecks,
	type RepositoryEnvironments,
	type EnvironmentSchedule,
	type Verified,
	type AccountDefaults,
	MODEL_CHECKS_PER_MINUTE,
	isModelProvider,
	MODEL_PROVIDERS,
	PLAN_ASK,
	PLAN_LIMITED,
	validModelKey,
	type ModelProvider,
	type ModelProviderStatus,
	type ModelPlanStatus,
	type PayWithChoice,
	type PayWithPatch,
	type StarterIssue,
	type PlanProvider,
	type AccountSecrets,
	type AccountSettings,
	type AuthResult,
	type ChatgptStatus,
	type ContinueSessionInput,
	type CreateSessionInput,
	type GithubId,
	type GithubAccount,
	type GithubBranchList,
	type GithubConnection,
	type GithubRepository,
	type GithubRepositoryList,
	type GithubStatus,
	type WindlassDelta,
	type AcpContext,
	type AcpUpdate,
	type HarnessId,
	type LiveDelta,
	type LoginProvider,
	type LoginStart,
	type ItemView,
	type MachineSummary,
	type ModelChoice,
	type ModelList,
	type PendingQuestion,
	type PersonalServer,
	type PersonalServerReach,
	type PlatformInfo,
	type PromptInput,
	type PublishMessage,
	type PublishResult,
	type PublishState,
	type PullRequestInfo,
	type RepositoryApproval,
	type RepositoryDefaults,
	type RepositoryAutonomy,
	type RepositorySecrets,
	type RepositorySetup,
	type RepositoryView,
	type SandboxProfile,
	type SandboxProfileId,
	type SavedRepository,
	type SecretReach,
	type SecretScope,
	type SessionRepository,
	type SessionServer,
	type SessionServers,
	type SessionSnapshot,
	type SecretRequest,
	type SetRequestedSecretInput,
	type SessionSummary,
	type TimelineItem,
	type TurnOutcome,
	type TurnUsage,
	type UsageNumbers,
	listedSessions,
	type UsageView,
	type CostRates,
	type UserProfile,
	type WindlassEvent,
	type WorkspaceFile,
	MAX_NOTE_CHARS,
	type BlockedNetwork,
	type HostAllowed,
	type NetworkRequest,
	type NetworkScan,
	type RepositoryNetwork,
	type BillingPeriod,
	type BillingView,
	type HostedMonth,
	type PlanId,
	type PlanInfo,
	type JiraConnection,
	type JiraMapping,
	type JiraProjectList,
	type LinearConnection,
	type LinearStatus,
	type GitlabStatus,
	type SlackSettingsActions,
	type LinkedAccount,
	type LinkedAccountsActions,
	type LinkSurface,
	type SlackStatus,
	type SlackMapping,
	type LinearTeamList,
} from "@contract";
import {
	PlatformError,
	type PlatformClient,
	type SessionApi,
	type SessionFeed,
	type UserApi,
	type UserFeed,
} from "./client";
import {
	acpOutcome,
	acpRecorder,
	isDurable,
	isLive,
	isPermission,
	schedule,
	turnEnded,
	type AcpPermission,
} from "./feed";
import { contextOf, HARNESS_NAMES, unifiedDiff } from "../lib/acp";
import { acpFixture } from "./acp-fixtures";
import {
	SCRIPTS,
	ROTATION,
	MOCK_HOST_CALL,
	chooseScript,
	chooseServer,
	isHostEvent,
	type MockServer,
	type Script,
	type ScriptName,
	type QuestionScript,
	type WorkspaceChange,
} from "./mock-scenarios";
import {
	cleanServerName,
	cleanServerDefinition,
	definitionReads,
	ServerProblem,
} from "../../../server/src/personal-server-definition.js";
import { sandboxTime } from "../lib/format";
import { dayOf, reportedModelUsage, usesPlatformModel } from "../../../server/src/usage";
import { createMockItems, MOCK_FACTORY_LIMITS, MOCK_MODEL_PRICES, type MockItemsState } from "./mock-items";
import { HOUR, MINUTE } from "./mock-time";
import { addTurn, noUsage, turnMeter } from "../../../server/src/factory/cost.js";

/** Work items' model turns today: a few on a Settings key, more on the ChatGPT plan. */
const MOCK_MODELS_TODAY = (() => {
	const usage = noUsage();
	const turn = (model: string, plan: boolean, inputTokens: number) =>
		addTurn(
			usage,
			turnMeter({
				harness: "windlass",
				model,
				key: { provider: plan ? "openai" : "anthropic", generation: "mock", ...(plan && { plan: true }) },
				usage: {
					inputTokens,
					cachedInputTokens: Math.round(inputTokens * 0.85),
					outputTokens: 9_000,
					reasoningTokens: 0,
				},
				size: "standard",
			}),
		);
	for (const tokens of [180_000, 240_000, 95_000]) turn("anthropic/claude-sonnet-4-5", false, tokens);
	for (const tokens of [310_000, 120_000]) turn("gpt-5.3-codex", true, tokens);
	return usage;
})();

/** The mock GitHub picture: drawn here, so nothing leaves the page. */
const MOCK_AVATAR =
	"data:image/svg+xml," +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#2f6f5e"/><circle cx="20" cy="16" r="7" fill="#f3d9b1"/><path d="M6 40c2-9 8-13 14-13s12 4 14 13z" fill="#f3d9b1"/><path d="M12 15c0-7 5-10 8-10s9 2 9 10c-2-3-6-5-9-5s-6 2-8 5z" fill="#3b2a20"/></svg>',
	);

export interface MockOptions {
	/** "one": a deployment whose hosted sandboxes have one size (Docker, or E2B with only small built): no sizes are shown. */
	sizes?: "one";
	/** Multiplies every wait: 1 is real time, 0 makes everything happen at once (still asynchronously). */
	pace?: number;
	now?: () => number;
	/** The address of the app, for the mock sign-in page. */
	origin?: string;
	/** How long a question waits before the platform declines it. Shorter than the real one by default. */
	questionTimeoutMs?: number;
	/** False plays a deployment with no GitHub App: nothing of GitHub is offered. */
	github?: boolean;
	gitlab?: boolean;
	/** Whether the deployment has a Linear OAuth client and signing secret. On unless false. */
	linear?: boolean;
	/** False plays a deployment with Jira disabled. */
	jira?: boolean;
	slack?: boolean;
	/** "e2b" plays a deployment on E2B that offers both of its profiles (`MOCK_E2B_PROFILES`). */
	sandbox?: "docker" | "e2b";
	/** How the user's day stands when the page loads (`MockUsageState`). Default "plenty". */
	usage?: MockUsageState;
	/** Plans and billing (`MockBillingState`). Default "off": no billing, the deployment's daily allowance. */
	billing?: MockBillingState;
	/** "seeded": the user has MCP servers of their own and secrets for them saved. Default "empty": nothing is saved for the account. */
	account?: "empty" | "seeded";
	/** "unavailable" plays a signed-in user whose plan's models could not be read: the stand-in list, which says so. Default "account": the plan's own. */
	models?: "account" | "unavailable";
	/** How the user's machines stand when the page loads (`MockMachineState`). Default "online". */
	machine?: MockMachineState;
	/** True starts the user with a checked Settings key for each model provider (`?keys=1`). */
	keys?: boolean;
	/**
	 * How the relays last saw the user's connected plans (`?plans=limited|invalid`): "limited" at their limit for the
	 * next hour, "invalid" refused twice. Default "ok".
	 */
	plans?: "ok" | "limited" | "invalid";
	/** How the agent on the user's machine finds that machine when its page opens (`MockMachineSession`). Default "answering". */
	machineSession?: MockMachineSession;
	/** How the user's work items and API tokens stand when the page loads (mock-items.ts, `MockItemsState`). Default "all". */
	items?: MockItemsState;
	/** True writes the seeded features' texts as long as planners and agents write them (`?long=1`): long briefs, paths and questions, six subtasks, three of them at once. */
	long?: boolean;
	/** False plays a deployment without the second review (WLP_FACTORY_REVIEWER unset): platform info says so. Default true. */
	reviewer?: boolean;
	/** True seeds blocked network requests (`?blocked=1`): in both turns of "Fix the failing add test", and on the item that has a report. */
	blocked?: boolean;
	/** True seeds a turn paused by a server restart, with a message held for it, and one that resumed after a restart (`?resume=1`). */
	resume?: boolean;
	/** False plays a deployment with screenshots turned off (WLP_FACTORY_SCREENSHOTS=off): platform info says so. Default true. */
	screenshots?: boolean;
	/**
	 * True plays a new account (`?fresh=1`): GitHub not connected, no agent, key or plan, no sessions. With
	 * `items: "none"` and `machine: "none"` (main.tsx sets both) it is the account the first-run setup opens for.
	 */
	fresh?: boolean;
}

/**
 * A day of sandbox time, for looking at each state by hand: "plenty" left, "low" (under a fifth of
 * the allowance is left, which a session says), "used" (nothing is left, and a prompt is refused), and
 * "full" (the user keeps as many sandboxes as they may, and an agent without one is refused its first prompt).
 */
export type MockUsageState = "plenty" | "low" | "used" | "full";

/**
 * Plans and billing (`?billing=`): "off" (the default) a deployment without billing, "exempt" an exempt account, "free" a Free account
 * early in the month, "free-low" one near its 120 hosted minutes, "free-used" one that used them all; "pro" a Pro
 * subscriber, "pro-capped" one at the overage spend cap, "pro-past-due" one in the grace period after a failed payment.
 */
export type MockBillingState =
	| "off"
	| "exempt"
	| "free"
	| "free-low"
	| "free-used"
	| "pro"
	| "pro-capped"
	| "pro-past-due";
export const MOCK_BILLING_STATES: readonly MockBillingState[] = [
	"off",
	"exempt",
	"free",
	"free-low",
	"free-used",
	"pro",
	"pro-capped",
	"pro-past-due",
];

/** The plans as the server has them (server/src/billing/plans.ts). */
export const MOCK_PLANS: PlanInfo[] = [
	{
		id: "free",
		name: "Free",
		monthlyCents: 0,
		yearlyCents: null,
		machines: 3,
		hostedMinutes: 120,
		hostedRunning: 1,
		keptSandboxes: 2,
		sizes: ["small", "standard"],
		crossRepo: false,
		githubItemsPerDay: 20,
		overageCentsPer1000: null,
	},
	{
		id: "pro",
		name: "Pro",
		monthlyCents: 1500,
		yearlyCents: 14_400,
		machines: 10,
		hostedMinutes: 1800,
		hostedRunning: 5,
		keptSandboxes: 10,
		sizes: ["small", "standard", "large"],
		crossRepo: true,
		githubItemsPerDay: 100,
		overageCentsPer1000: 600,
	},
];

/**
 * The user's own machines, for looking at each state of the Machines page by hand (`?machine=`):
 * "none" (no machine yet), "online", "offline", "pairing" (confirmed, its runner not connected yet),
 * "outdated" (its runner is older than the platform serves), "docker" (its runner cannot reach Docker),
 * "clock" (its clock is minutes off), "key" (its key was used from a second place), "full" (as many
 * machines as an account may have), "unpublished" (no runner image is published yet, and no machine),
 * "stale" (the list is read once, then reading it again fails), "failed" (it cannot be read at all),
 * "loading" (it is never answered), "off" (the deployment offers no machines), and "unnamed" (beside "nas",
 * a machine whose runner runs in a container and reported the container's id for its host name), and "sources" (a Mac
 * whose Claude Code, Codex and OpenCode are signed in there, beside "nas"; with `?keys=1` each could also use a Settings key). In the add dialog any
 * well-formed code is found, except ZZZZ-ZZZZ.
 */
export const MOCK_MACHINE_STATES = [
	"none",
	"online",
	"sources",
	"fresh",
	"claude-signed-out",
	"claude-unchecked",
	"offline",
	"pairing",
	"outdated",
	"docker",
	"clock",
	"key",
	"full",
	"unpublished",
	"stale",
	"failed",
	"loading",
	"off",
	"unnamed",
	"placement",
] as const;
export type MockMachineState = (typeof MOCK_MACHINE_STATES)[number];

/**
 * How the agent seeded on the machine "nas" finds it (`?machineSession=`), for looking at each banner of
 * a session on a machine by hand: "answering"; "not_answering" (a turn is under way, and while its page
 * is open the machine stops answering after a few seconds and is back half a minute later, as the
 * session's `machine` event tells the page); "offline" (the machine went offline after the agent last used
 * it); "removed" (the agent's machine was removed, so it is not in the list). A prompt to an agent whose
 * machine is offline or removed fails at once with the server's sentence, as a turn that could not run.
 * Seeded where the user's machines are listed with "nas" as reported, and for "removed" wherever machines are offered.
 */
export const MOCK_MACHINE_SESSIONS = ["answering", "not_answering", "offline", "removed", "paused"] as const;
export type MockMachineSession = (typeof MOCK_MACHINE_SESSIONS)[number];

/** Claude Code as a runner started with `--harness claude` reports it (server/src/runner/control.ts, `report.harnesses`). */
const MOCK_CLAUDE = {
	keyRelay: true as const,
	id: "claude" as const,
	adapter: "claude-agent-acp 0.109.0",
	image: "sha256:3f9a1c0e7b5d2a8c6e4f1b9d7a5c3e1f0b8d6a4c2e0f9b7d5a3c1e8f6b4d2a0c",
	signIn: "token" as const,
};

/** Model and effort choices reported by the fixture machine. */
const MOCK_CLAUDE_MODELS: ModelList = {
	source: "harness",
	defaultModel: "default",
	fetchedAt: null,
	models: [
		{ id: "default", name: "Default (recommended)", efforts: [] },
		{ id: "opus", name: "Opus", efforts: ["low", "high", "max"] },
		{ id: "haiku", name: "Haiku", efforts: [] },
	],
};

const MOCK_OPENCODE_MODELS: ModelList = {
	source: "harness",
	defaultModel: "openai/gpt-5.4",
	fetchedAt: null,
	models: [
		{ id: "openai/gpt-5.4", name: "OpenAI/GPT-5.4", efforts: ["low", "medium", "high", "xhigh", "default"] },
		{ id: "openai/gpt-5.4-mini", name: "OpenAI/GPT-5.4 mini", efforts: ["low", "medium", "high", "default"] },
	],
};
/** OpenCode on a machine signed in to Anthropic there, offering every provider's models (`?machine=sources`). */
const MOCK_OPENCODE_SOURCES: ModelList = {
	source: "harness",
	defaultModel: "anthropic/claude-sonnet-5-5",
	fetchedAt: null,
	models: [
		{ id: "anthropic/claude-sonnet-5-5", name: "Anthropic/Claude Sonnet 5.5", efforts: ["low", "medium", "high"] },
		{ id: "anthropic/claude-haiku-5-5", name: "Anthropic/Claude Haiku 5.5", efforts: [] },
		{ id: "openai/gpt-6.1-sol", name: "OpenAI/GPT-6.1 Sol", efforts: ["low", "medium", "high", "xhigh"] },
		{ id: "google/gemini-3-pro", name: "Google/Gemini 3 Pro", efforts: ["low", "high"] },
		{ id: "google/gemini-3-flash", name: "Google/Gemini 3 Flash", efforts: [] },
		{ id: "openrouter/qwen/qwen3-coder", name: "OpenRouter/Qwen3 Coder", efforts: [] },
		{ id: "opencode/grok-code", name: "OpenCode Zen/Grok Code Fast", efforts: [] },
	],
};
const MOCK_CODEX_MODELS: ModelList = {
	source: "harness",
	defaultModel: "gpt-6.2-sol",
	models: [{ id: "gpt-6.2-sol", name: "6.2 Sol", efforts: ["low", "high"] }],
	fetchedAt: null,
};
const MOCK_OPENCODE_MODES = [
	{ id: "build", name: "build", description: "The default agent. Executes tools based on configured permissions." },
	{ id: "plan", name: "plan", description: "Plan mode. Disallows all edit tools." },
];

/** What the mock's runners say they are, and what its platform asks of them. */
const MOCK_RUNNER_VERSION = "0.3.13";
const MOCK_MIN_RUNNER_VERSION = "0.3.13";
const MOCK_RUNNER_IMAGE =
	"registry.example.com/windlass-runner@sha256:6b1f0c2d9e4a8b7c3f5e1d0a9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b";

/** A machine's sandbox profiles as the server words them from its runner's report (server/src/runner/machine-profiles.ts): `docker` and `commandSandbox` are what failed, if anything. */
function mockMachineProfiles(
	name: string,
	failed: { docker?: string; commandSandbox?: string } = {},
	egress: MachineSummary["egress"] = "open",
): SandboxProfile[] {
	const machine = `your machine "${name}"`;
	const layers = [
		`Your machine "${name}" (yours; the platform does not control it)`,
		"Docker container made by the runner (non-root, no capabilities, limits)",
	];
	const sandbox = failed.docker ?? failed.commandSandbox;
	const trust =
		"The platform does not control this machine. It receives the repository, the saved secrets you allow and a ChatGPT token for the turn. Setup finishes before the token arrives. Approved local MCP servers can read it and its replacements. Each token lasts about an hour from issue. The checks and changes shown are what your machine reports.";
	return [
		{
			id: "docker-windlass-sandbox",
			name: ISOLATION_NAMES.strict,
			summary: ISOLATION_LINES.strict,
			details: `The agent runs in a container on ${machine}. As far as its runner reports, Windlass sandboxes each command, so commands have no network and cannot read the session's access token. ${trust}`,
			layers: [...layers, "Windlass's bubblewrap sandbox around each command (as the runner reports)"],
			approval: "auto",
			commandNetwork: false,
			commandsCanReadAccessToken: false,
			available: sandbox === undefined,
			...(sandbox !== undefined ? { unavailableReason: sandbox } : {}),
		},
		{
			id: "docker-hardened",
			name: ISOLATION_NAMES.open,
			summary: openLine(egress ?? "open"),
			details: `Commands run directly in a container on ${machine} and can read the session's access token and its replacements during the turn. The session has a data directory of its own, so they cannot read your other sessions' conversations. ${workspaceNetwork(egress)} ${trust}`,
			layers: [layers[0]!, layers[1]!.replace(/\)$/, ", a data directory of the session's own)")],
			approval: "full",
			commandNetwork: egress !== "none",
			commandNetworkText: workspaceNetwork(egress),
			commandsCanReadAccessToken: true,
			available: failed.docker === undefined,
			...(failed.docker !== undefined ? { unavailableReason: failed.docker } : {}),
		},
	];
}

/** What the next call about GitHub fails with, for looking at each failure by hand. */
export type MockGithubFailure =
	/** The repositories cannot be listed. */
	| "list"
	/** The browser comes back from GitHub with a refusal. */
	| "connect"
	/** A push that GitHub refuses: no write access, a protected branch, a repository that is gone. */
	| "denied"
	| "protected"
	| "gone";

export interface MockClient extends PlatformClient {
	/** Drops every live feed for `ms`, then reconnects them, as a network interruption would. */
	simulateDrop(ms: number): void;
	/**
	 * Makes the next `answer()` go wrong, for looking at the error by hand: "elsewhere" answers the
	 * question as another tab would have, then refuses with `no_question`; "error" fails as a request
	 * that never reached the server would, and leaves the question waiting.
	 */
	mockNextAnswer(kind: "elsewhere" | "error"): void;
	/** Makes the next call about GitHub of that kind fail (`__wlpMock.mockNextGithub("protected")`, then push). */
	mockNextGithub(kind: MockGithubFailure): void;
	/**
	 * Every integration in Settings connected and mapped, for looking at them together: GitLab on a project (or,
	 * with "gitlab-reconnect", GitLab having refused the saved grant), Linear and Jira with a mapping each, and Slack
	 * with two channels and the member's account linked. Reload Settings after.
	 */
	mockIntegrations(state?: "connected" | "gitlab-reconnect", uid?: string): void;
	/**
	 * Makes the next call about a project's MCP servers fail, for looking at the panel's errors by hand:
	 * "list" the reading of the list, "approve" and "forget" the action (`__wlpMock.mockNextServers("forget")`,
	 * then Forget). "slow" makes every one of these calls take ten seconds, for the next ten seconds.
	 */
	mockNextServers(kind: "list" | "approve" | "forget" | "slow"): void;
	/** Sets how the user's day of sandbox time stands (`__wlpMock.mockUsage("used")`, then send a prompt). */
	mockUsage(state: MockUsageState): void;
}

/** The mock deployment's limits: the allowance is the real default, the cap is above it so that the seeded sessions fit. */
export const MOCK_ALLOWANCE_SECONDS = 2 * 60 * 60;
export const MOCK_MAX_KEPT = 20;
const MOCK_HOLD_SECONDS = 5 * 60;
const MOCK_START_SECONDS = 30;
/** E2B's published price for the size the platform's template has. */
const MOCK_PRICE = { usdPerSecond: 0.0000185, basis: "1 CPU and 1,024 MiB of memory" };
/** The hosted sizes, as an E2B deployment with all three templates built offers them (pricing.ts's rates). */
const MOCK_SIZES: HostedSizeOption[] = (["small", "standard", "large"] as const).map(id => {
	const spec = HOSTED_SIZE_SPECS[id];
	return {
		id,
		cpus: spec.cpus,
		memoryMiB: spec.memoryMiB,
		usdPerHour: 3600 * (spec.cpus * 0.000014 + (spec.memoryMiB / 1024) * 0.0000045),
	};
});
/** A hosted session's size, where none was recorded: a work item's standard, a person's own small. */
const sizeOfSession = (summary: SessionSummary): HostedSize | undefined =>
	summary.place.kind !== "hosted" ? undefined : (summary.hostedSize ?? (summary.item ? "standard" : "small"));
/** The thirteen days before today, the oldest first, in seconds: one of them at the limit. */
const MOCK_HISTORY = [0, 3_120, 5_460, 1_890, 0, 0, 4_410, 7_200, 2_280, 6_630, 960, 0, 3_870];
/** What the seeded sessions' sandboxes ran today, by session id; "probe" lost five minutes to a server that stopped under it. */
const MOCK_SPENT: Record<string, number> = {
	"add-test": 1_140,
	headers: 420,
	"harbor-build": 240,
	probe: 480,
	unattended: 360,
};
const MOCK_UNREPORTED: Record<string, number> = { probe: 300 };

const resetWords = (numbers: UsageNumbers) =>
	`The allowance is whole again at 00:00 UTC, in ${sandboxTime(Math.max(60, Math.ceil((numbers.resetsAt - numbers.at) / 60_000) * 60))}.`;

/** server/src/usage.ts, `allowanceRefusal`. */
export function mockAllowanceRefusal(numbers: UsageNumbers): string {
	const allowance = sandboxTime(numbers.allowanceSeconds ?? 0);
	const used = sandboxTime(numbers.usedSeconds);
	const held = numbers.heldSeconds > 0 ? sandboxTime(numbers.heldSeconds) : null;
	const left = numbers.leftSeconds ?? 0;
	let said: string;
	if (left > 0)
		said = `Only ${sandboxTime(left)} of today's ${allowance} of sandbox time is left (${used} used${held === null ? "" : `, ${held} held for sandboxes that are running now`}), which is too little to start with, so nothing was started.`;
	else if (held === null) said = `Today's ${allowance} of sandbox time is used up, so nothing was started.`;
	else
		said = `Today's ${allowance} of sandbox time is all used or held: ${used} used, and ${held} held for sandboxes that are running now. Nothing was started.`;
	if (held !== null) said += " What a running sandbox does not use of its hold is free again when it stops.";
	return `${said} ${resetWords(numbers)}`;
}

/** server/src/usage.ts, `sandboxRefusal`. */
export function mockSandboxRefusal(numbers: UsageNumbers): string {
	const limit = numbers.sandboxes.limit ?? numbers.sandboxes.kept;
	return `You keep ${limit} hosted ${limit === 1 ? "sandbox" : "sandboxes"}, the most an account may have, and this agent needs one of its own. Sandboxes on your own machines are not counted. Free one on the Usage page, which says what goes with it, or delete an agent you no longer need. Then send this again.`;
}

/** server/src/usage.ts, `freedNote`, for a deployment that keeps a copy of the agent's memory. */
export const MOCK_FREED_NOTE =
	"You freed this agent's sandbox on the Usage page. The files in its workspace are gone. The conversation stays, and the next prompt starts a new sandbox. The agent keeps its memory of the conversation, and is told that the workspace is a new one.";

/** The mock's question timeout: long enough to answer, short enough to watch the platform decline. */
export const MOCK_QUESTION_TIMEOUT_MS = 3 * 60_000;

// ---------------------------------------------------------------------------------------------
// What the mock serves
// ---------------------------------------------------------------------------------------------

/** The profiles as server/src/sandbox/profiles.ts has them: the server's own, so the words cannot drift. */
export const MOCK_PROFILES: SandboxProfile[] = PROFILES.map(profile => ({ ...profile, layers: [...profile.layers] }));

/** The profiles as a server on E2B lists them with WLP_E2B_WINDLASS_SANDBOX=1 and WLP_E2B_OPEN_PROFILE=1 (`?sandbox=e2b`). */
export const MOCK_E2B_PROFILES: SandboxProfile[] = profilesFor("e2b", { windlassSandbox: true, openProfile: true });

// ---- GitHub ---------------------------------------------------------------------------------

const GITHUB = { slug: "windlass-mock", url: "https://github.com" };
const GITHUB_NOT_CONNECTED = "GitHub is not connected any more. Connect GitHub again in Settings, then try once more.";

const GITHUB_ACCOUNTS: GithubAccount[] = [
	{ installationId: 61001, login: "ada", kind: "user", manageUrl: "https://github.com/settings/installations/61001" },
	{
		installationId: 61002,
		login: "acme",
		kind: "organization",
		manageUrl: "https://github.com/organizations/acme/settings/installations/61002",
	},
];

interface MockRepository extends Omit<GithubRepository, "pushedAt"> {
	/** How long ago it was pushed to, in hours. */
	pushedHoursAgo: number;
	branches: string[];
}

const mockRepository = (
	id: number,
	owner: string,
	name: string,
	visibility: "private" | "public",
	pushedHoursAgo: number,
	branches: string[] = [],
	canPush = true,
): MockRepository => ({
	id,
	owner,
	name,
	private: visibility === "private",
	defaultBranch: "main",
	canPush,
	pushedHoursAgo,
	branches: ["main", ...branches],
});

const GITHUB_REPOSITORIES: MockRepository[] = [
	mockRepository(7101, "acme", "harbor", "private", 2, ["fix/tide-tables", "release/2.4", "release/2.3"]),
	mockRepository(7102, "ada", "tide-tables", "public", 5, ["gh-pages"]),
	mockRepository(7103, "acme", "lighthouse-docs", "public", 26, ["next"]),
	mockRepository(7104, "ada", "dotfiles", "private", 70),
	mockRepository(7105, "acme", "quay", "private", 96, ["develop"], false),
	mockRepository(7106, "acme", "signal-flags", "private", 150, ["v2"]),
	mockRepository(7107, "ada", "windlass-notes", "private", 200),
	mockRepository(7108, "acme", "charts", "private", 340, ["soundings"]),
	mockRepository(7109, "acme", "harbor-infrastructure", "private", 500, ["staging", "production"]),
	mockRepository(7110, "ada", "knots", "public", 900),
	mockRepository(7111, "acme", "ballast", "private", 1400, [], false),
	mockRepository(7112, "acme", "a-repository-with-a-rather-long-name-for-testing-how-it-clips", "private", 2600),
];

const sessionRepository = (owner: string, name: string, branch = "main"): SessionRepository => {
	const found = GITHUB_REPOSITORIES.find(repository => repository.owner === owner && repository.name === name);
	return {
		provider: "github",
		id: found?.id ?? 0,
		owner,
		name,
		branch,
		private: found?.private ?? true,
		url: `${GITHUB.url}/${owner}/${name}`,
	};
};

const MODELS = ["gpt-6.1-sol", "gpt-6-luna"];
/** What the signed-in user's ChatGPT plan offers: each model with its own efforts, and one that takes none. */
const MOCK_PLAN: ModelChoice[] = [
	{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: ["low", "medium", "high", "xhigh"] },
	{ id: "gpt-6-luna", name: null, efforts: ["low", "medium"] },
	{ id: "gpt-6-brisk", name: "GPT-6 Brisk", efforts: [] },
];
/** The platform's stand-in for a plan's models, as the server has it (`standInModels`, server/src/account-models.ts). */
export function mockStandInModels(source: Exclude<ModelList["source"], "account">): ModelList {
	const models = ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"].map(id => ({
		id,
		name: null,
		efforts: ["low", "medium", "high", "xhigh", "max"],
	}));
	return { source, models, defaultModel: "gpt-6.1-sol", fetchedAt: null };
}

/** The server's refusal of a prompt to a work item's agent (`prompt` in agent-session.ts), word for word. */
export const ITEM_SESSION_PROMPT =
	"This agent works for a work item, whose steps send its prompts. Answer the item, or send its work back with a note.";

const SERVER_FILE = "/workspace/.windlass/config.json";

/** What an approval is remembered for, as server/src/server-approvals.ts names it: the session's repository, or the session itself. */
export interface MockProject {
	key: string;
	kind: SessionServers["project"]["kind"];
	label: string;
}

export function mockProject(summary: Pick<SessionSummary, "id" | "repoUrl" | "repository">): MockProject {
	if (summary.repository)
		return {
			key: `github:${summary.repository.id}`,
			kind: "github",
			label: `${summary.repository.owner}/${summary.repository.name}`,
		};
	if (summary.repoUrl)
		return {
			key: `address:${summary.repoUrl}`,
			kind: "address",
			label: summary.repoUrl.replace(/^https:\/\//, "").replace(/\/$/, ""),
		};
	return { key: `session:${summary.id}`, kind: "session", label: "this session" };
}

/** Where the server runs and what it can reach, for the two Docker profiles and a demo session or not. */
function mockReach(profile: SandboxProfile, demo: boolean): string {
	const data = demo
		? "Windlass's own data. A demo session has no access token there."
		: "Windlass's own data, including the session's access token and any replacement during the turn. Each token lasts about an hour from issue.";
	return profile.approval === "full"
		? `It runs in this session's container, as the agent's commands do here: like them, it has the network and can read ${data}`
		: `It runs in this session's container, but outside Windlass's sandbox around commands: unlike the agent's commands, it has the network and can read ${data}`;
}

/** What approving does and how far it is remembered, where Windlass's own record stays in the sandbox. */
function mockApproving(project: MockProject, when: "now" | "next", remote = false): string {
	const does =
		when === "next"
			? remote
				? "Approving lets Windlass connect to it from this session's next turn"
				: "Approving starts it with this session's next turn"
			: remote
				? "Approving lets Windlass connect to it now"
				: "Approving starts it now";
	return project.kind === "session"
		? `${does} and is remembered for 30 days for exactly this definition, for this session, which has no repository: a sandbox that replaces this one ${remote ? "connects" : "starts it"} without asking, until you forget the approval in the session's panel.`
		: `${does} and is remembered for 30 days for exactly this definition: your sessions on ${project.label} then ${remote ? "connect" : "start it"} without asking, until you forget the approval in a session's panel.`;
}

const MOCK_COVERS =
	"It is an approval of this command, not of the files it runs: a later commit can change those without a new question.";

const commandLine = (argv: readonly string[]) =>
	argv
		.map(argument => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(argument) ? argument : `'${argument.replace(/'/g, `'\\''`)}'`))
		.join(" ");

/** What would set a variable a definition reads, as server/src/server-question.ts says it of a variable no secret is saved for. */
function mockUnsetRemedy(unset: readonly string[], project: MockProject, profile: SandboxProfile): string {
	// One of the account's secrets sets the variable too: any, where this sandbox gives them all to MCP servers.
	if (project.kind !== "github")
		return `A variable is set by saving a secret for a repository of your GitHub connection, and this session is not on one. ${mockAccountSecretsNote(profile) === null ? "A secret of your account under that name, saved in your settings, sets it for MCP servers too." : "A secret of your account under that name, saved in your settings, sets it for MCP servers in this sandbox if it is also for the agent's commands."}`;
	const names = unset.length <= 1 ? unset.join("") : `${unset.slice(0, -1).join(", ")} and ${unset[unset.length - 1]}`;
	return unset.length === 1
		? `Save a secret named ${names} for ${project.label}, under Secrets in this session's panel: it is handed over from the next turn.`
		: `Save secrets named ${names} for ${project.label}, under Secrets in this session's panel: they are handed over from the next turn.`;
}

/** The names the server refuses for a secret (server/src/repo-secrets.ts, `isReservedName`). */
const MOCK_RESERVED =
	/^(?:(?:WLP|WINDLASS|LD|XDG|BUN|NODE|DOCKER|E2B|LC|BASH)_.*|PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|TMPDIR|TMP|TEMP|LANG|LANGUAGE|TZ|TERM|HOSTNAME|IFS|ENV|SHLVL|_|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|PAGER|GIT_PAGER|GIT_TERMINAL_PROMPT)$/i;

/** What the selected profile allows each secret scope to reach. */
export function mockSecretReach(
	scope: SecretScope,
	profile: Pick<SandboxProfile, "approval" | "commandNetwork" | "commandsCanReadAccessToken">,
	owner: "repository" | "account" = "repository",
): SecretReach {
	// What is left of a secret that MCP servers are not given: a repository's goes to its setup command, an account's has none.
	const left = owner === "repository" ? "Only the setup command gets it." : "So nothing is given it there.";
	const sandbox =
		profile.approval === "full"
			? "none"
			: !profile.commandNetwork && !profile.commandsCanReadAccessToken
				? "windlass"
				: "unknown";
	if (scope === "agent") return { servers: true, commands: "yes", note: null };
	if (sandbox === "windlass") return { servers: true, commands: "no", note: null };
	return {
		servers: false,
		commands: "no",
		note:
			sandbox === "none"
				? `MCP servers are not given it in this sandbox: the agent's commands run there without Windlass's sandbox, where a command can read whatever Windlass was handed for an MCP server from Windlass's own process. ${left}`
				: `MCP servers are not given it in this sandbox: it has not been established that Windlass can sandbox the agent's commands there, and a command it cannot sandbox can read whatever Windlass was handed for an MCP server from Windlass's own process. ${left}`,
	};
}

/**
 * The question about a project's server as server/src/server-question.ts words it where Windlass's
 * data is the sandbox's own, so that what is remembered beyond it is the platform's record: for the
 * two Docker profiles, a demo session or not, a definition that reads variables which are not set,
 * and a project that is a repository or the session itself.
 */
export function mockServerQuestion(
	server: Pick<MockServer, "name" | "argv" | "unset">,
	profile: SandboxProfile,
	demo: boolean,
	project: MockProject,
): Pick<PendingQuestion, "title" | "subject" | "details" | "choices"> {
	const names =
		server.unset.length <= 1
			? server.unset.join("")
			: `${server.unset.slice(0, -1).join(", ")} and ${server.unset[server.unset.length - 1]}`;
	const missing =
		server.unset.length === 0
			? []
			: [
					server.unset.length === 1
						? `It will not start yet: its definition reads the variable ${names}, which is not set where Windlass runs. ${mockUnsetRemedy(server.unset, project, profile)}`
						: `It will not start yet: its definition reads the variables ${names}, which are not set where Windlass runs. ${mockUnsetRemedy(server.unset, project, profile)}`,
				];
	return {
		title: `Start this project's MCP server "${server.name}"?`,
		subject: commandLine(server.argv),
		details: [mockReach(profile, demo), mockApproving(project, "now"), MOCK_COVERS, ...missing],
		choices: [
			{
				id: "start",
				label: "Start it for this project",
				approve: true,
				remembers:
					project.kind === "session"
						? "exactly this definition, for this session, for 30 days"
						: `exactly this definition, for your sessions on ${project.label}, for 30 days`,
			},
			{ id: "not_now", label: "Not now", approve: false, remembers: null },
		],
	};
}

/** The same question as the panel puts it before an approval between turns (the server's `serverPanelWords`). */
export function mockPanelWords(
	server: Pick<SessionServer, "name" | "remote">,
	profile: SandboxProfile,
	demo: boolean,
	project: MockProject,
): NonNullable<SessionServer["asks"]> {
	if (server.remote) {
		return {
			title: `Connect to this project's MCP server "${server.name}"?`,
			details: [
				"Nothing is started: Windlass reaches it at that address from this session's container, outside its sandbox around commands, and what the agent sends it leaves the container.",
				mockApproving(project, "next", true),
				"It is an approval of this address, not of what answers there.",
			],
		};
	}
	return {
		title: `Start this project's MCP server "${server.name}"?`,
		details: [mockReach(profile, demo), mockApproving(project, "next"), MOCK_COVERS],
	};
}

/** Why a sandbox hands MCP servers only some of the account's secrets, as server/src/account-secrets.ts says it (`accountSecretsNote`). */
function mockAccountSecretsNote(
	profile: Pick<SandboxProfile, "approval" | "commandNetwork" | "commandsCanReadAccessToken">,
): string | null {
	const only =
		"Of your account's secrets, MCP servers are given only those that are also for the agent's commands in this sandbox";
	if (profile.approval === "full")
		return `${only}: the agent's commands run here without Windlass's sandbox, where a command can read whatever Windlass was handed for an MCP server from Windlass's own process. A server that reads another one does not start.`;
	if (profile.commandNetwork || profile.commandsCanReadAccessToken)
		return `${only}: it has not been established that Windlass can sandbox the agent's commands here, and a command it cannot sandbox can read whatever Windlass was handed for an MCP server from Windlass's own process. A server that reads another one does not start.`;
	return null;
}

/** What a server of the user's own can reach where it runs, as server/src/server-question.ts says it (`personalServerReach`). */
export function mockPersonalReach(profile: SandboxProfile): PersonalServerReach {
	const machine = profile.id.startsWith("e2b") ? "microVM" : profile.id.startsWith("docker") ? "container" : "sandbox";
	const data =
		"Windlass's own data, including the session's access token and any replacement during the turn. Each token lasts about an hour from issue";
	const command =
		profile.approval === "full"
			? `It runs in a session's ${machine}, as the agent's commands do here: like them, it has the network and can read ${data}.`
			: !profile.commandNetwork && !profile.commandsCanReadAccessToken
				? `It runs in a session's ${machine}, but outside Windlass's sandbox around commands: unlike the agent's commands, it has the network and can read ${data}.`
				: `It runs in a session's ${machine} and is never inside Windlass's sandbox around commands, whether or not that sandbox works here: it has the network and can read ${data}.`;
	return {
		profile: profile.id,
		name: profile.name,
		command,
		address: `Nothing is started: Windlass reaches it at that address from a session's ${machine}, outside its sandbox around commands, and what the agent sends it leaves the ${machine}.`,
	};
}

export function mockCleanServer(rawName: unknown, raw: unknown): { name: string; definition: Record<string, unknown> } {
	try {
		return { name: cleanServerName(rawName), definition: cleanServerDefinition(raw) };
	} catch (error) {
		if (error instanceof ServerProblem) throw new PlatformError("user", error.message, { reason: error.code });
		throw error;
	}
}

/** The demo repository whose items show example screenshots has opted in. */
export const MOCK_SCREENSHOTS = [7101];

export const MOCK_FORGETTING =
	"Forgetting holds for the next session or sandbox. Where the server already started, Windlass's own record still starts it, and a running one is not stopped.";

/** How long ago, as the server's lines say it: "a moment ago", "5 minutes ago", "3 days ago". */
function agoWords(ms: number): string {
	if (ms < 60_000) return "a moment ago";
	const plural = (value: number, unit: string) => (value === 1 ? `1 ${unit}` : `${value} ${unit}s`);
	if (ms >= 2 * 24 * HOUR || (ms >= 24 * HOUR && ms % (24 * HOUR) === 0))
		return `${plural(Math.round(ms / (24 * HOUR)), "day")} ago`;
	if (ms >= 2 * HOUR || (ms >= HOUR && ms % HOUR === 0)) return `${plural(Math.round(ms / HOUR), "hour")} ago`;
	return `${plural(Math.round(ms / MINUTE), "minute")} ago`;
}

/** A server of a session's project as the session last heard of it: `SessionServer` without what the user's record adds. */
type MockKnown = Omit<SessionServer, "approval" | "earlier" | "asks">;

interface MockApproval {
	project: string;
	name: string;
	fingerprint: string;
	approvedAt: number;
	expiresAt: number;
}

const APPROVAL_MS = 30 * 24 * 60 * 60 * 1000;
/** How long the mock says a repository's setup command may run. */
const MOCK_SETUP_LIMIT_MS = 10 * MINUTE;

/** One thing a Claude Code turn does, after `wait` ms: an ACP update (and what the mock changes with it), or a permission it asks, with what follows each kind of answer. */
type AcpEntry =
	| { wait: number; update: AcpUpdate; then?: () => void }
	| { wait: number; ask: AcpPermission["permission"]; allowed: AcpEntry[]; declined: AcpEntry[] };

interface AcpScript {
	entries: AcpEntry[];
	stopReason: string;
}

/** The fake ACP agent's scenarios that a prompt to a Claude Code agent can name, to see each played as it was recorded. */
const ACP_SCENARIOS = ["plain", "tools", "plan", "ask", "usage", "leaveplan"] as const;

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

interface RunningCall {
	messageId: string;
	callId: string;
	startedAt: number | null;
	progress: string;
}

interface Run {
	turn: number;
	startedAt: number;
	timer: ReturnType<typeof setTimeout> | null;
	stopping: boolean;
	executionId: string | null;
	openStep: string | null;
	steps: number;
	usage: TurnUsage | null;
	text: Map<string, string>;
	calls: Map<string, RunningCall>;
	/** The steps being played and the index of the next one, so that playing can skip ahead. */
	plan: Step[];
	next: number;
	/** Steers enqueued and not yet delivered: their Windlass message IDs. */
	steers: string[];
	/** Calls the user stopped: what the recording still has of them is not played. */
	cancelled: Set<string>;
	/** Set after a call was stopped: what the model says next instead of what the recording says. */
	replaceText: string | null;
	/** A Claude Code turn's: the platform's record of its ACP updates, and the context's fill it last said. */
	/** `modeQueued`: a mode was chosen during the turn, so the agent's own mode changes no longer move the session's (server/src/actors/agent-session.ts). */
	acp?: { recorder: ReturnType<typeof acpRecorder>; context: AcpContext | null; modeQueued?: boolean };
}

interface MockSession {
	summary: SessionSummary;
	/** A seeded work item's turn, played when its page is first opened rather than with every user's seeds (`seedItemSession`). */
	seededTurn?: () => void;
	/** The title was given by hand, so the first prompt does not replace it. */
	titled: boolean;
	windlassSessionId: string | null;
	windlassSeq: number;
	timeline: TimelineItem[];
	pending: LiveDelta[];
	seq: number;
	feeds: Set<SessionFeed>;
	run: Run | null;
	files: Map<string, WorkspaceChange>;
	pauseTimer: ReturnType<typeof setTimeout> | null;
	question: PendingQuestion | null;
	/** The agent's open `request_secret` (`SessionSnapshot.secretRequest`): a person's own session only; an item's asks on the item. Closed when a turn starts. */
	secretRequest?: SecretRequest & { id: string };
	/** Declines the question when nobody answers it. */
	questionTimer: ReturnType<typeof setTimeout> | null;
	/** Carries the turn on once the question is answered. */
	resume: ((choice: string, note: string | null) => void) | null;
	/** A server's question that stepped aside for a tool call's, with what carries on once it is answered. */
	aside: { question: PendingQuestion; resume: (choice: string, note: string | null) => void } | null;
	/** The definitions of project servers started in this session's sandbox: Windlass keeps its own record there, so it starts them again unasked. */
	startedServers: Set<string>;
	/** The project's servers as the session last heard of them, for its panel. */
	servers: MockKnown[];
	/** True once the platform pushed the session's branch. */
	pushed: boolean;
	/** The commit the branch is at on GitHub after the platform's last push, for the panel or for the agent (`PublishState.pushed`); null before any. */
	pushedHead: string | null;
	/** What the session's work rests on since its last turn ended, as the server keeps it (`Verified`). */
	verified: Verified | null;
	/** The messages that were taken with a key, by that key: the text, and what the prompt was answered. */
	submissions: Map<string, Taken<{ turn: number; steered: boolean }>>;
	/** For an agent on one of the user's machines: its sandbox profile as that machine offered it, and what the session last found of the machine (`SessionSnapshot.machine`). */
	machine?: { profile: SandboxProfile; reach: NonNullable<SessionSnapshot["machine"]> | null };
}

/** What was taken under a submission's key: what it came with, and what its first attempt was answered. */
interface Taken<Answer> {
	content: string;
	answer: Answer;
}

/** A submission's key as the server reads it (`IdempotencyKey`): null for none, a refusal for what is no key. */
function keyOf(raw: unknown): string | null {
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== "string" || raw === "" || [...raw].length > MAX_IDEMPOTENCY_KEY_CHARS) {
		throw new PlatformError(
			"user",
			`The key of a submission must be a text of 1 to ${MAX_IDEMPOTENCY_KEY_CHARS} characters. Leave it out to send without one.`,
			{ reason: "bad_idempotency_key" },
		);
	}
	return raw;
}

/** What the first attempt under `key` was answered, when this is that submission again; a refusal when the key came with something else. */
function takenUnder<Answer>(
	kept: Map<string, Taken<Answer>>,
	key: string | null,
	content: string,
	what: string,
): Answer | undefined {
	const first = key === null ? undefined : kept.get(key);
	if (first === undefined) return undefined;
	if (first.content !== content)
		throw new PlatformError(
			"user",
			`The key this was sent with was already used for another ${what}, so this one was not taken. A new submission needs a key of its own.`,
			{ reason: "idempotency_key_reused" },
		);
	return first.answer;
}

/** The mock checks a connect code's shape only: any well-formed code stands for a terminal waiting on it. */
function mockConnectCode(userCode: string): void {
	if (!/^[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}$/i.test(userCode.trim()))
		throw new PlatformError("user", "That is not a connect code. It looks like KQ2M-8XF4.", { reason: "bad_input" });
}

type SavedDefaults = AccountDefaults & { updatedAt: number };

interface World {
	offers: Map<GithubId, OfferRow[]>;
	planConnected: boolean;
	/** When the ChatGPT plan was last connected by code (0 for one remembered from an earlier visit). */
	planAddedAt: number;
	guideChecks: Map<GithubId, RepositoryView["guideCheck"]>;
	knowledge: Map<GithubId, RepositoryView["knowledge"]>;
	readiness: Map<GithubId, { at: number; finished: boolean; weekly: boolean }>;
	profile: UserProfile;
	sessions: Map<string, MockSession>;
	feeds: Set<UserFeed>;
	rotation: number;
	github: GithubConnection | null;
	/** The number the next pull request gets. */
	nextPull: number;
	/** The user's remembered approvals of projects' servers. */
	approvals: MockApproval[];
	/** The setup commands the user saved, by GitHub's id for the repository. */
	setups: Map<GithubId, { command: string; updatedAt: number }>;
	/** The checks the user saved for a repository, by GitHub's id for it. */
	checks: Map<GithubId, { checks: RepositoryCheck[]; updatedAt: number }>;
	/** The network lists the user saved, and the hosts the repository's sessions could not reach, by GitHub's id for it. */
	network: Map<GithubId, { entries: string[]; updatedAt: number | null; requests: NetworkRequest[] }>;
	/** The secrets the user saved, by repository and name. A value is not kept at all: nothing here could show one. */
	secrets: Map<GithubId, Map<string, { scope: SecretScope; updatedAt: number }>>;
	/** What new agents on a repository start with, where the user said so, by GitHub's id for it. */
	defaults: Map<GithubId, SavedDefaults>;
	/** The repositories whose work items' agents can take screenshots, with when that was saved (`RepositoryDefaults.screenshots`). */
	autonomy: Map<GithubId, RepositoryAutonomy & { updatedAt: number }>;
	screenshotsEnabled: Map<GithubId, number>;
	/** What a repository was called when something was last saved for it or GitHub was last asked: what names one that has no session. */
	names: Map<GithubId, string>;
	/** What the user keeps for their account, whatever the repository. A secret's value is not kept at all. */
	account: {
		providers: Map<ModelProvider, ModelProviderStatus>;
		plans: Map<PlanProvider, ModelPlanStatus>;
		checks: { minute: number; used: number };
		defaults: SavedDefaults | null;
		servers: Map<string, { definition: Record<string, unknown>; unasked: boolean; updatedAt: number }>;
		secrets: Map<string, { scope: SecretScope; updatedAt: number }>;
	};
	/** The seconds of sandbox time counted today, by session: the seeded ones, and what the turns played here ran. */
	spent: Map<string, number>;
	modelTokens: Map<number, number>;
	/** The agents that were created with a key, by that key: what was asked for, and the agent's id. */
	created: Map<string, Taken<string>>;
	/** The Pay-with choices saved on the Connections page, by agent (server/src/pay-with.ts). */
	payWith: Map<HarnessId, PayWithChoice>;
}

interface Step {
	/** Milliseconds after the previous step. */
	wait: number;
	run: () => void;
	/** The call this step settles (`messageId/callId`), for skipping ahead when it is stopped. */
	settles?: string;
}

export function createMockClient(options: MockOptions = {}): MockClient {
	const pace = options.pace ?? 1;
	const questionTimeout = options.questionTimeoutMs ?? MOCK_QUESTION_TIMEOUT_MS;
	let nextAnswer: "elsewhere" | "error" | null = null;
	let nextGithub: MockGithubFailure | null = null;
	let nextServers: "list" | "approve" | "forget" | null = null;
	/** Until when the calls about a project's servers are slow. */
	let slowServersUntil = 0;
	const serversLatency = (ms: number) => latency(realNow() < slowServersUntil ? 10_000 : ms);
	const githubOn = options.github !== false;
	let usageState: MockUsageState = options.usage ?? "plenty";
	const billingState: MockBillingState = options.billing ?? "off";
	/** The account's subscription in the mock: what Settings and the upgrade page show, and what Upgrade changes. */
	const realNow = options.now ?? (() => Date.now());
	const billing = {
		period: "month" as BillingPeriod,
		start: realNow(),
		plan: (billingState.startsWith("pro") ? "pro" : "free") as PlanId,
		status: (billingState === "pro-past-due" ? "past_due" : billingState.startsWith("pro") ? "active" : "none") as
			| "none"
			| "active"
			| "past_due"
			| "ended",
		capCents: 2000,
		/** Weighted hosted minutes used this month. */
		usedMinutes: (
			{
				off: 0,
				exempt: 0,
				free: 34,
				"free-low": 97,
				"free-used": 120,
				pro: 642,
				"pro-capped": 1800 + 3333,
				"pro-past-due": 1210,
			} as Record<MockBillingState, number>
		)[billingState],
	};
	const billingPlan = () => MOCK_PLANS.find(plan => plan.id === billing.plan)!;
	function hostedMonth(at: number): HostedMonth {
		const plan = billingPlan();
		const date = new Date(at);
		const included = plan.hostedMinutes * 60;
		const extra =
			billing.period === "year" || plan.overageCentsPer1000 === null
				? 0
				: Math.floor((billing.capCents * 1000) / plan.overageCentsPer1000) * 60;
		const used = billing.usedMinutes * 60;
		return {
			month: date.toISOString().slice(0, 7),
			resetsAt:
				plan.id === "pro" ? shiftMonths(billing.start, 1) : Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
			...(plan.id === "pro" && { period: billing.period }),
			includedSeconds: included,
			limitSeconds: included + extra,
			usedSeconds: used,
			heldSeconds: 0,
			leftSeconds: Math.max(0, included + extra - used),
			plan: plan.id,
		};
	}
	function billingView(at: number): BillingView {
		if (billingState === "exempt") return { enabled: false, exempt: true };
		if (billingState === "off") return { enabled: false };
		const month = hostedMonth(at);
		const plan = billingPlan();
		const overage =
			billing.period === "year" || plan.overageCentsPer1000 === null
				? 0
				: Math.min(
						Math.floor(Math.max(0, month.usedSeconds - month.includedSeconds) / 60),
						Math.floor((billing.capCents * 1000) / plan.overageCentsPer1000),
					);
		return {
			enabled: true,
			plan: billing.plan,
			status: billing.status,
			period: billing.plan === "pro" ? billing.period : null,
			periodEnd: billing.plan === "pro" ? shiftMonths(billing.start, billing.period === "year" ? 12 : 1) : null,
			cancelAtPeriodEnd: false,
			graceUntil: billing.status === "past_due" ? at + 5 * 86_400_000 : null,
			capCents: billing.capCents,
			maxCapCents: 2000,
			overageMinutes: overage,
			reportedMinutes: overage,
			portal: billing.plan === "pro",
			plans: MOCK_PLANS,
			month,
		};
	}
	const profiles = (options.sandbox === "e2b" ? MOCK_E2B_PROFILES : MOCK_PROFILES).map(p =>
		p.available && hostedProfiles.includes(p.id) ? { ...p, platformKeys: true as const } : p,
	);
	const origin = options.origin ?? (typeof location === "undefined" ? "http://localhost:5173" : location.origin);
	/** Set while history is being written in the past (the seeded sessions). */
	let clock: number | null = null;
	const now = () => clock ?? realNow();

	const worlds = new Map<string, World>();
	let attempt: { owner?: string; provider: LoginProvider; state: string; expiresAt: number } | null = null;
	let disposed = false;
	const timers = new Set<ReturnType<typeof setTimeout>>();

	const later = (ms: number, action: () => void): ReturnType<typeof setTimeout> => {
		const timer = setTimeout(() => {
			timers.delete(timer);
			if (!disposed) action();
		}, ms * pace);
		timers.add(timer);
		return timer;
	};
	const cancel = (timer: ReturnType<typeof setTimeout> | null) => {
		if (timer === null) return;
		clearTimeout(timer);
		timers.delete(timer);
	};
	/** The time a request takes. */
	const latency = (ms = 140) => new Promise<void>(resolve => later(ms, resolve));
	/** What `createSession` is asked for an item's agent. */
	const itemStarts = new WeakSet<object>();
	// Work items, API tokens and the factory's limits live in mock-items.ts; an item's agent is made here, as `createSession` makes one.
	// On one of the user's machines, it takes the machines as they are listed now, and is told of every change of them.
	const items = createMockItems({
		hosted: auth => ({
			hostedSizes: options.sizes === "one" ? undefined : MOCK_SIZES.map(s => s.id),
			hostedRates: Object.fromEntries(MOCK_SIZES.map(s => [s.id, s.usdPerHour])),
			hostedCredentials: hostedCredentialsOf(worldOf(auth)),
			hostedProfiles: profiles.filter(p => p.available).map(p => p.id),
			keyProfiles: profiles.filter(p => p.available && p.platformKeys).map(p => p.id),
		}),
		state: options.items,
		long: options.long,
		reviewer: options.reviewer,
		blocked: options.blocked,
		plans: options.plans,
		now: () => realNow(),
		latency,
		later,
		feeds: auth => worldOf(auth).feeds,
		session: (auth, { profile, ...input }) => {
			const asked = {
				...input,
				profile:
					profile ?? (profiles.find(candidate => candidate.available) ?? profiles[0])?.id ?? "docker-windlass-sandbox",
			};
			// An item's agent is not one the user started: it is not where their next agent starts.
			itemStarts.add(asked);
			return userApi(auth).createSession(asked);
		},
		models: (auth, harness, machineId) => {
			if (harness === "windlass") return modelsFor(worldOf(auth).profile);
			const options = machineId
				? machinesOf(auth)
						.list.find(one => one.machineId === machineId)
						?.harnesses?.find(entry => entry.id === harness)?.options
				: hostedCatalog(harness, hostedCredentialsOf(worldOf(auth)));
			return initialHarnessModels(options);
		},
		discardSession: (auth, id) => userApi(auth).deleteSession(id),
		seededSession: (auth, item) => seedItemSession(auth, item),
		itemChanged: (auth, item) => {
			const world = worldOf(auth);
			const session = world.sessions.get(item.sessionId);
			if (!session) return;
			// A turn of the item runs while it works; its prompts are the item's, so nothing else starts one here.
			const status = item.state === "working" && item.run?.step.kind !== "review" ? "running" : "idle";
			if (session.summary.item?.id === item.id && session.summary.status === status) return;
			setSummary(world, session, {
				availableModes: [],
				item: { id: item.id, role: "builder" },
				status,
				...(status === "running" && session.summary.sandbox === "none" ? { sandbox: "running" as const } : {}),
			});
		},
		waitingRepository: async (auth, input) => {
			const { id, owner, name, private: privateRepo, defaultBranch } = await userApi(auth).githubRepository(input.id);
			return {
				provider: "github",
				id,
				owner,
				name,
				private: privateRepo,
				branch: input.branch ?? defaultBranch,
				url: `https://github.com/${owner}/${name}`,
			};
		},
		defaultPlace: (auth, repositoryId) =>
			savedPlace(defaultsOf(worldOf(auth), repositoryId), accountDefaultsOf(worldOf(auth))),
		runContext: (auth, repositoryId) => {
			// A saved model the account no longer offers is left out, as user-items.ts `savedContext` does.
			const models = modelsFor(auth.profile);
			return {
				deployment: { hostedSize: "standard" },
				account: withoutUnofferedModels(accountDefaultsOf(worldOf(auth)), models),
				repository: withoutUnofferedModels(defaultsOf(worldOf(auth), repositoryId), models),
			};
		},
		checks: (auth, repositoryId) => checksOf(worldOf(auth), repositoryId).checks.length,
		machines: auth =>
			machineState === "off" ? null : { list: machinesView(auth), minRunnerVersion: MOCK_MIN_RUNNER_VERSION },
	});

	// ---- identity -------------------------------------------------------------------------------

	const revoked = new Map<string, string>();
	const generation = (uid: string) => recall("wlp.mock.tokenGen." + uid) ?? revoked.get(uid) ?? "";
	const tokenFor = (profile: UserProfile) =>
		`mock:${profile.demo ? "demo" : "user"}:${profile.uid}:${profile.email ?? ""}${generation(profile.uid) ? ":" + generation(profile.uid) : ""}`;

	/** A checked key for each provider, with the models its check read (`?keys=1`). */
	function seedKeys(world: World): void {
		const at = realNow() - 40 * MINUTE;
		const models: Record<ModelProvider, string[]> = {
			openai: ["gpt-6.1-sol", "gpt-6-luna"],
			anthropic: ["claude-fable-5-2", "claude-opus-5-5", "claude-haiku-5-5"],
			google: ["gemini-3-pro", "gemini-3-flash"],
			openrouter: ["qwen/qwen3-coder", "deepseek/deepseek-v4"],
		};
		for (const provider of MODEL_PROVIDERS) {
			world.account.providers.set(provider, {
				provider,
				last4: "k3y" + provider.length,
				addedAt: at,
				checkedAt: at,
				ok: true,
				models: models[provider],
				windlassModels: models[provider],
			});
		}
	}

	/** Each plan agent's Pay-with choice, the defaults where none was saved, as the server's `readPayWith`. */
	function payWithOf(world: World): PayWithChoice[] {
		return PAY_WITH_HARNESSES.map(
			harness =>
				structuredClone(world.payWith.get(harness)) ?? {
					harness,
					payWith: "plan-then-key",
					whenLimited: null,
					updatedAt: null,
				},
		);
	}

	/** A plan's health as the relays saw it, by `options.plans`: usable, at its limit for the next hour, or refused twice. */
	function planHealth(): Pick<ModelPlanStatus, "health" | "limitedUntil" | "resetKnown" | "windows" | "healthAt"> {
		const at = realNow();
		if (options.plans === "invalid")
			return { health: "invalid", limitedUntil: null, resetKnown: false, windows: [], healthAt: at - MINUTE };
		if (options.plans === "limited") {
			const reset = at + 60 * MINUTE;
			return {
				health: "limited",
				limitedUntil: reset,
				resetKnown: true,
				windows: [{ kind: "5h", usedPct: 100, resetsAt: reset, observedAt: at - MINUTE, source: "header" }],
				healthAt: at - MINUTE,
			};
		}
		return { health: "ok", limitedUntil: null, resetKnown: false, windows: [], healthAt: null };
	}

	/** The account's plans: those connected by code, and its ChatGPT sign-in as the ChatGPT plan. */
	function plansOf(world: World): ModelPlanStatus[] {
		const plans = [...world.account.plans.values()].map(plan => ({ ...plan, ...planHealth() }));
		if (!world.planConnected || world.profile.demo) return plans;
		return [
			...plans,
			{
				provider: "openai",
				account: `${world.profile.email ?? "you@example.com"} · Plus`,
				addedAt: world.planAddedAt,
				checkedAt: realNow() - 5 * MINUTE,
				ok: true,
				models: ["gpt-5.5-codex", "gpt-5.5-codex-mini"],
				...planHealth(),
			},
		];
	}

	/** What hosted agents can pay with: the saved keys and the connected plans, as the server's `hostedCredentials`. */
	function hostedCredentialsOf(world: World): HostedCredential[] {
		return [
			...world.account.providers.values(),
			...plansOf(world).map(p => ({
				provider: p.provider,
				plan: true as const,
				checkedAt: p.checkedAt,
				models: p.models,
			})),
		];
	}

	function worldOf(auth: AuthResult): World {
		const [scheme, kind, uid, email, gen = ""] = auth.token.split(":");
		if (
			scheme !== "mock" ||
			!uid ||
			gen !== generation(uid) ||
			uid !== auth.profile.uid ||
			(kind !== "demo" && kind !== "user")
		) {
			throw new PlatformError("unauthorized", "This sign-in is no longer accepted. Sign in again.");
		}
		let world = worlds.get(uid);
		if (!world) {
			world = {
				offers: new Map(),
				guideChecks: new Map(),
				knowledge: new Map(),
				readiness: new Map(),
				planConnected: recall("wlp.mock.plan." + uid) === "1",
				planAddedAt: 0,
				profile: { uid, email: email || null, demo: kind === "demo" },
				sessions: new Map(),
				feeds: new Set(),
				rotation: 0,
				github: null,
				nextPull: 41,
				approvals: [],
				setups: new Map(),
				checks: new Map(),
				network: new Map(),
				secrets: new Map(),
				defaults: new Map(),
				autonomy: new Map(),
				screenshotsEnabled: new Map(options.fresh ? [] : MOCK_SCREENSHOTS.map(id => [id, realNow() - 3 * 24 * HOUR])),
				names: new Map(),
				account: {
					providers: new Map(),
					plans: new Map(),
					checks: { minute: 0, used: 0 },
					defaults: null,
					servers: new Map(),
					secrets: new Map(),
				},
				spent: new Map(Object.entries(MOCK_SPENT)),
				modelTokens: new Map(),
				created: new Map(),
				payWith: new Map(),
			};
			// The seeded user starts connected; the demo user and a new account connect by hand. A choice made since is kept.
			const kept = recall(`wlp.mock.github.${uid}`);
			if (githubOn && (kept === "1" || (kept === null && kind === "user" && !options.fresh)))
				world.github = connectionFor(world.profile);
			worlds.set(uid, world);
			if (options.keys && kind === "user") seedKeys(world);
			if (!options.fresh) seed(world);
			// The items, each with its agent session, are there with the agents (`seedItemSession`).
			items.prepare(auth);
		}
		return world;
	}

	// ---- GitHub ---------------------------------------------------------------------------------

	/** What survives the reload of going to GitHub and back: nothing else of the mock does. */
	function recall(key: string): string | null {
		try {
			return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
		} catch {
			return null;
		}
	}
	function keep(key: string, value: string): void {
		try {
			if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
		} catch {
			// Storage is unavailable: the connection lasts until the page is reloaded.
		}
	}

	const gitlabUrl = "https://gitlab.example.com";
	const gitlabProjects: SessionRepository[] = [
		{ id: "90071992547409931", owner: "acme/tools", name: "harbor" },
		{ id: "7202", owner: "acme", name: "website" },
	].map(project => ({
		...project,
		provider: "gitlab",
		branch: "main",
		private: true,
		url: `${gitlabUrl}/${project.owner}/${project.name}`,
	}));
	function gitlabStatus(uid: string): GitlabStatus {
		if (options.gitlab === false) return { state: "off" };
		const stored = recall(`wlp.mock.gitlab.${uid}`);
		if (stored === "reconnect") return { state: "disconnected", reconnect: true };
		return stored
			? { state: "connected", baseUrl: gitlabUrl, project: gitlabProjects.find(p => p.id === stored) ?? null }
			: { state: "disconnected" };
	}

	// ---- Linear ---------------------------------------------------------------------------------

	const LINEAR_TEAMS = [
		{ id: "team-eng", key: "ENG", name: "Engineering" },
		{ id: "team-des", key: "DES", name: "Design" },
		{ id: "team-ops", key: "OPS", name: "Operations" },
	];
	interface LinearKept {
		connectedAt: number;
		mappings: Record<string, { repositoryId: GithubId; savedAt: number }>;
	}
	const linearMemory = new Map<string, LinearKept>();
	function linearKept(uid: string): LinearKept | null {
		const held = linearMemory.get(uid);
		if (held) return held;
		const stored = recall(`wlp.mock.linear.${uid}`);
		if (!stored) return null;
		try {
			const parsed = JSON.parse(stored) as LinearKept;
			linearMemory.set(uid, parsed);
			return parsed;
		} catch {
			return null;
		}
	}
	function keepLinear(uid: string, value: LinearKept): void {
		linearMemory.set(uid, value);
		keep(`wlp.mock.linear.${uid}`, JSON.stringify(value));
	}
	const linearConnection = (connectedAt: number): LinearConnection => ({
		workspace: { id: "ws-acme", name: "Acme", urlKey: "acme" },
		user: { id: "lin-user", name: "Ada Lovelace" },
		appUser: { id: "lin-app", name: "Windlass" },
		connectedAt,
	});
	function linearTeams(uid: string): LinearTeamList {
		const kept = linearKept(uid);
		return {
			teams: LINEAR_TEAMS.map(team => {
				const mapped = kept?.mappings[team.id];
				const repository = mapped
					? GITHUB_REPOSITORIES.find(candidate => candidate.id === mapped.repositoryId)
					: undefined;
				return {
					...team,
					mapping:
						mapped && repository
							? {
									teamId: team.id,
									repository: { id: repository.id, owner: repository.owner, name: repository.name },
									savedAt: mapped.savedAt,
								}
							: null,
				};
			}),
		};
	}

	// ---- Jira -----------------------------------------------------------------------------------

	const jiraSites = [
		{ id: "site-acme", name: "Acme", url: "https://acme.atlassian.net" },
		{ id: "site-harbor", name: "Harbor", url: "https://harbor.atlassian.net" },
	];
	const projectsBySite: Record<string, { id: string; key: string; name: string }[]> = {
		"site-acme": [
			{ id: "10001", key: "ENG", name: "Engineering" },
			{ id: "10002", key: "OPS", name: "Operations" },
		],
		"site-harbor": [{ id: "10001", key: "DOC", name: "Documentation" }],
	};
	interface JiraKept {
		connection: JiraConnection;
		mappings: Record<string, JiraMapping>;
	}
	const jiraMemory = new Map<string, string>();

	// ---- Slack ----------------------------------------------------------------------------------

	const slackWorkspace = { id: "T08ACME01", name: "Acme Engineering" };
	const slackChannels = [
		{ id: "C08HARB01", name: "harbor-engineering" },
		{ id: "C08DOCS01", name: "docs-triage" },
	];
	const slackKey = (key: string) => "wlp.mock.slack." + key;
	function slackTicket(key: string) {
		const ticket = crypto.randomUUID();
		keep(slackKey(key), ticket);
		return ticket;
	}
	function claimSlack(key: string, ticket: string) {
		if (!ticket || recall(slackKey(key)) !== ticket) throw new Error("This Slack link is invalid or expired.");
		keep(slackKey(key), "");
	}
	function slackActions(world: () => World): SlackSettingsActions {
		const uid = () => world().profile.uid;
		const mappings = (): SlackMapping[] => JSON.parse(recall(slackKey("mappings")) || "[]");
		const status = (): SlackStatus => {
			if (options.slack === false) return { state: "off" };
			return recall(slackKey("owner")) === uid()
				? { state: "connected", workspaceName: slackWorkspace.name, mappings: mappings() }
				: { state: "disconnected" };
		};
		const owner = () => {
			if (status().state !== "connected") throw new Error("Connect a Slack workspace first.");
		};
		return {
			async slack() {
				return status();
			},
			async slackConnect({ origin }) {
				return { url: `${origin}/settings${location.search}#slack=${slackTicket(uid())}` };
			},
			async slackComplete(ticket) {
				claimSlack(uid(), ticket);
				if (recall(slackKey("owner")) && recall(slackKey("owner")) !== uid())
					throw new Error("This workspace already has an owner.");
				keep(slackKey("owner"), uid());
				return status();
			},
			async slackChannels() {
				owner();
				return slackChannels;
			},
			async saveSlackMapping({ channelId, repositoryId }) {
				owner();
				requireGithub(world());
				const channel = slackChannels.find(ch => ch.id === channelId);
				const repository = GITHUB_REPOSITORIES.find(repo => repo.id === repositoryId);
				if (!channel || !repository?.canPush) throw new Error("Choose a channel and a repository with write access.");
				const { id, owner: login, name } = repository;
				keep(
					slackKey("mappings"),
					JSON.stringify([
						...mappings().filter(m => m.channel.id !== channelId),
						{ channel, repository: { id, owner: login, name }, details: !repository.private },
					]),
				);
				return status();
			},
			async setSlackDetails({ channelId, details }) {
				owner();
				keep(
					slackKey("mappings"),
					JSON.stringify(mappings().map(m => (m.channel.id === channelId ? { ...m, details } : m))),
				);
				return status();
			},
			async removeSlackMapping(id) {
				owner();
				keep(slackKey("mappings"), JSON.stringify(mappings().filter(m => m.channel.id !== id)));
				return status();
			},
			async disconnectSlack() {
				owner();
				for (const key of ["owner", "mappings", uid()]) keep(slackKey(key), "");
				return status();
			},
		};
	}

	// ---- Linked accounts ------------------------------------------------------------------------

	const LINKED_TENANT_NAMES: Record<LinkSurface, string> = {
		slack: slackWorkspace.name,
		linear: "Harbor Labs",
		jira: "Atlassian",
	};
	function linkedAccountsActions(world: () => World): LinkedAccountsActions {
		const key = () => `wlp.mock.linked.${world().profile.uid}`;
		const list = (): LinkedAccount[] => JSON.parse(recall(key()) || "[]");
		const store = (next: LinkedAccount[]) => {
			keep(key(), JSON.stringify(next));
			return next;
		};
		return {
			async linkedAccounts() {
				return list();
			},
			async linkAccount(ticket) {
				const [surface, tenant, proof] = ticket.split(".");
				let account: LinkedAccount | null = null;
				if (surface === "slack" && tenant && proof)
					account = { surface, tenant, tenantName: LINKED_TENANT_NAMES.slack, name: "" };
				else if (surface === "linear" && tenant)
					account = { surface, tenant: "mock-linear", tenantName: LINKED_TENANT_NAMES.linear, name: "Ada" };
				if (!account)
					throw new PlatformError("user", "This link is not valid for this account any more. Start again.", {
						reason: "link_ticket",
					});
				const linked = account;
				return store([...list().filter(a => a.surface !== linked.surface || a.tenant !== linked.tenant), linked]);
			},
			async linkAccountStart({ origin }) {
				const search = typeof location === "undefined" ? "" : location.search;
				return { url: `${origin.replace(/\/$/, "")}/settings${search}#link=linear.${crypto.randomUUID()}` };
			},
			async unlinkAccount({ surface, tenant }) {
				return store(list().filter(a => a.surface !== surface || a.tenant !== tenant));
			},
		};
	}

	function connectionFor(profile: UserProfile): GithubConnection {
		const login = profile.email?.split("@")[0] || "ada";
		return {
			login,
			accounts: GITHUB_ACCOUNTS.map(account => (account.kind === "user" ? { ...account, login } : account)),
			connectedAt: now() - 9 * 24 * HOUR,
		};
	}

	function requireGithub(world: World): GithubConnection {
		if (!githubOn)
			throw new PlatformError("user", "This deployment has no GitHub App, so GitHub cannot be connected here.", {
				reason: "github_off",
			});
		if (!world.github)
			throw new PlatformError("user", "GitHub is not connected. Connect GitHub first.", {
				reason: "github_not_connected",
			});
		return world.github;
	}

	const describeRepository = ({
		pushedHoursAgo,
		branches: _branches,
		...repository
	}: MockRepository): GithubRepository => ({ ...repository, pushedAt: now() - pushedHoursAgo * HOUR });

	const branchFor = (session: MockSession) => {
		const words = session.summary.title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40)
			.replace(/-+$/g, "");
		return `windlass/${words || "agent"}-${session.summary.id.replace(/[^A-Za-z0-9]/g, "").slice(-6)}`;
	};

	function publishStateOf(session: MockSession): PublishState {
		const repository = session.summary.repository ?? null;
		if (!repository)
			return {
				repository: null,
				pullRequest: null,
				branch: "",
				changes: null,
				draft: { title: "", body: "" },
				blocked: null,
				pushed: null,
			};
		const status = session.summary.status;
		const answer = [...session.timeline]
			.reverse()
			.find(item => item.kind === "windlass" && item.event.type === "text.ended");
		const said = answer?.kind === "windlass" ? String((answer.event.data ?? {}).text ?? "").trim() : "";
		const prompt = [...session.timeline].reverse().find(item => item.kind === "user" && !item.steer);
		const files = [...session.files.keys()].sort();
		const body =
			said !== ""
				? said.length > 600
					? `${said.slice(0, 600).trim()}…`
					: said
				: files.length > 0
					? `Changed files:\n${files.map(path => `- ${path}`).join("\n")}`
					: "";
		const title = session.pushed && prompt?.kind === "user" ? promptTitle(prompt.text) : session.summary.title;
		return {
			repository,
			pullRequest: session.summary.pullRequest ?? null,
			branch: session.summary.pullRequest?.branch ?? branchFor(session),
			changes: status !== "idle" || session.summary.sandbox === "none" ? null : session.files.size > 0,
			draft: { title: title.replace(/…$/, ""), body },
			pushed: session.pushedHead,
			blocked: !githubOn
				? "This deployment has no GitHub App any more, so the platform cannot push."
				: status !== "idle"
					? "Wait for the turn to end: the platform does not push while the agent is working."
					: session.summary.sandbox === "none"
						? "The sandbox is created on the first prompt. Until then there is nothing to push."
						: null,
		};
	}

	// ---- sessions -------------------------------------------------------------------------------

	const profileOf = (session: MockSession): SandboxProfile =>
		session.machine?.profile ??
		profiles.find(profile => profile.id === session.summary.profile) ??
		(MOCK_PROFILES[0] as SandboxProfile);
	/** The platform's note as a sandbox is made, as server/src/actors/agent-session.ts words it. */
	const startNote = (session: MockSession): string =>
		session.summary.place.kind === "hosted"
			? `Starting a hosted sandbox (${profileOf(session).name})`
			: `Starting on your machine (${profileOf(session).name})`;

	const listOf = (world: World): SessionSummary[] =>
		listedSessions([...world.sessions.values()].map(session => session.summary)).sort(
			(a, b) => b.createdAt - a.createdAt,
		);

	function setSummary(world: World, session: MockSession, patch: Partial<SessionSummary>): void {
		session.summary = { ...session.summary, ...patch };
		for (const feed of session.feeds) feed.onSummary(session.summary);
		const list = listOf(world);
		for (const feed of world.feeds) feed.onSessions(list);
		// A sandbox that starts or stops changes what is held and kept.
		if (clock === null && (patch.sandbox !== undefined || patch.status !== undefined))
			for (const feed of world.feeds) feed.onUsage?.(usageNumbers(world));
	}

	// ---- sandbox time and kept sandboxes --------------------------------------------------------

	/** What the day's state adds to the seeded time, so that "low" leaves fourteen minutes and "used" nothing. */
	function usageOffset(world: World, held: number): number {
		if (usageState !== "low" && usageState !== "used") return 0;
		let spent = 0;
		for (const seconds of world.spent.values()) spent += seconds;
		return Math.max(0, MOCK_ALLOWANCE_SECONDS - held - spent - (usageState === "low" ? 14 * 60 : 0));
	}

	// The day's time and the cap on kept sandboxes are the platform's own sandboxes': one on the user's machine is in neither.
	const runningSandboxes = (world: World) =>
		[...world.sessions.values()].filter(
			session => session.summary.place.kind === "hosted" && session.summary.sandbox === "running",
		);
	const keptSandboxes = (world: World) =>
		[...world.sessions.values()].filter(
			session => session.summary.place.kind === "hosted" && session.summary.sandbox !== "none",
		);

	function usageNumbers(world: World): UsageNumbers {
		const at = realNow();
		const held = runningSandboxes(world).length * MOCK_HOLD_SECONDS;
		let used = usageOffset(world, held);
		for (const seconds of world.spent.values()) used += seconds;
		const day = Math.floor(at / 86_400_000);
		// With billing, the month's hosted minutes take the place of the day's allowance, as on the server (user-limits.ts).
		if (billingState !== "off" && billingState !== "exempt") {
			const plan = billingPlan();
			return {
				at,
				day: new Date(day * 86_400_000).toISOString().slice(0, 10),
				resetsAt: (day + 1) * 86_400_000,
				allowanceSeconds: null,
				usedSeconds: used,
				heldSeconds: held,
				leftSeconds: null,
				startSeconds: MOCK_START_SECONDS,
				sandboxes: { kept: keptSandboxes(world).length, limit: plan.keptSandboxes },
				hosted: hostedMonth(at),
			};
		}
		return {
			at,
			day: new Date(day * 86_400_000).toISOString().slice(0, 10),
			resetsAt: (day + 1) * 86_400_000,
			allowanceSeconds: MOCK_ALLOWANCE_SECONDS,
			usedSeconds: used,
			heldSeconds: held,
			leftSeconds: Math.max(0, MOCK_ALLOWANCE_SECONDS - used - held),
			startSeconds: MOCK_START_SECONDS,
			sandboxes: {
				kept: keptSandboxes(world).length,
				limit: usageState === "full" ? Math.min(MOCK_MAX_KEPT, keptSandboxes(world).length) : MOCK_MAX_KEPT,
			},
		};
	}

	function usageView(world: World): UsageView {
		const numbers = usageNumbers(world);
		const offset = usageOffset(world, numbers.heldSeconds);
		const today = [...world.sessions.values()]
			.map(session => ({
				sessionId: session.summary.id,
				title: sessionTitle(session.summary),
				// What the day's state adds is the busiest agent's.
				seconds: (world.spent.get(session.summary.id) ?? 0) + (session.summary.id === "add-test" ? offset : 0),
				unreportedSeconds: MOCK_UNREPORTED[session.summary.id] ?? 0,
				heldSeconds:
					session.summary.place.kind === "hosted" && session.summary.sandbox === "running" ? MOCK_HOLD_SECONDS : 0,
				...(sizeOfSession(session.summary) && { hostedSize: sizeOfSession(session.summary) }),
			}))
			.filter(row => row.seconds > 0 || row.heldSeconds > 0)
			.sort((a, b) => b.seconds + b.heldSeconds - (a.seconds + a.heldSeconds));
		const firstDay = Math.floor(numbers.at / 86_400_000) - MOCK_HISTORY.length;
		return {
			...numbers,
			factoryLimits: MOCK_FACTORY_LIMITS,
			usedModelTokens: world.modelTokens.get(dayOf(numbers.at)) ?? 0,
			modelsToday: MOCK_MODELS_TODAY,
			today,
			days: [
				...MOCK_HISTORY.map((seconds, index) => ({
					day: new Date((firstDay + index) * 86_400_000).toISOString().slice(0, 10),
					seconds,
				})),
				{ day: numbers.day, seconds: numbers.usedSeconds },
			],
			kept: keptSandboxes(world)
				.map(session => ({
					sessionId: session.summary.id,
					title: sessionTitle(session.summary),
					state: session.summary.sandbox === "running" ? ("running" as const) : ("paused" as const),
					usedAt: session.summary.updatedAt,
					busy: session.summary.status !== "idle",
					repository: session.summary.repository
						? `${session.summary.repository.owner}/${session.summary.repository.name}`
						: null,
					pushed: session.pushed,
					...(sizeOfSession(session.summary) && { hostedSize: sizeOfSession(session.summary) }),
				}))
				.sort((a, b) => b.usedAt - a.usedAt),
			price: MOCK_PRICE,
			hostedSizes: MOCK_SIZES,
			memory: "copied",
		};
	}

	/**
	 * A seeded work item's own agent session, as the server makes one for every item
	 * (`SessionSummary.item`): titled as the item, on its repository and its place, with one turn
	 * played for an item that has run. Only the sandbox of an item at work is kept, and only those
	 * counted sandbox time today, so that the agents' own figures stay as they were seeded.
	 */
	function seedItemSession(auth: AuthResult, item: ItemView): string {
		const world = worldOf(auth);
		const id = `item-${item.id.replace(/^it?_/, "")}`;
		clock = item.createdAt;
		const session = addSession(world, {
			id,
			title: item.title,
			titled: true,
			profile: "docker-windlass-sandbox",
			model: MODELS[0] as string,
			repoUrl: null,
			repository: githubOn ? item.repository : undefined,
		});
		if (item.place.kind === "machine") {
			const { machineId } = item.place;
			const machine = machinesOf(auth).list.find(one => one.machineId === machineId);
			const profile = machine?.profiles.find(one => one.available) ?? (profiles[0] as SandboxProfile);
			session.summary = { ...session.summary, place: { kind: "machine", machineId } };
			session.machine = { profile, reach: machine ? null : { state: "removed", since: item.updatedAt } };
		}
		clock = null;
		const working = item.run?.step.turn === "started" && item.run.step.kind !== "review";
		if (item.reviewerSessionId) {
			const reviewer = addSession(world, {
				id: item.reviewerSessionId,
				title: item.title,
				titled: true,
				profile: session.summary.profile,
				model: session.summary.model,
				repoUrl: null,
				repository: session.summary.repository,
			});
			const running = item.review?.state === "running";
			reviewer.summary = {
				...reviewer.summary,
				availableModes: [],
				item: { id: item.id, role: "reviewer" },
				status: running ? "running" : "idle",
				sandbox: running ? "running" : "none",
			};
			const last = item.reviews.at(-1);
			if (last) {
				reviewer.seededTurn = () => {
					// As the server's: the item sends its reviewer no text, and the brief is built in the sandbox, so the first prompt has none.
					playInstantly(plan(world, reviewer, { text: "" }, SCRIPTS.parallel), last.at);
					if (reviewer.pauseTimer !== null) cancel(reviewer.pauseTimer);
					reviewer.pauseTimer = null;
					reviewer.summary = { ...reviewer.summary, sandbox: "none" };
				};
			}
		}
		// The pull request the item's publish step opened is its session's, as the server's session keeps it; it is merged once the item is done.
		const pull: PullRequestInfo | null =
			item.pullRequest && session.summary.repository && item.state !== "cancelled" && item.state !== "failed"
				? {
						number: item.pullRequest.number,
						url: item.pullRequest.url,
						state: item.state === "done" ? "merged" : "open",
						title: item.title,
						branch: branchFor(session),
						base: item.repository.branch,
						pushedAt: item.updatedAt,
						verified: verifiedWords(session.verified),
					}
				: null;
		const settle = () => {
			if (session.pauseTimer !== null) cancel(session.pauseTimer);
			session.pauseTimer = null;
			session.summary = {
				...session.summary,
				availableModes: [],
				item: { id: item.id, role: "builder" },
				status: working ? "running" : "idle",
				sandbox: working ? "running" : "none",
				updatedAt: Math.max(session.summary.updatedAt, item.updatedAt),
				...(pull ? { pullRequest: pull } : {}),
			};
		};
		settle();
		const run = item.run;
		if (run !== null && item.spent.turns > 0) {
			// What the list says of it is there at once; the turn itself is played when its page is opened.
			session.summary = { ...session.summary, turns: 1, lastOutcome: "succeeded" };
			session.seededTurn = () => {
				session.summary = { ...session.summary, turns: 0, lastOutcome: null };
				playInstantly(plan(world, session, { text: item.task.body || item.title }, SCRIPTS.answer), run.startedAt);
				settle();
			};
		}
		if (working && item.place.kind === "hosted") world.spent.set(id, Math.min(item.spent.hostedSeconds, 4 * 60));
		return id;
	}

	function addSession(
		world: World,
		input: {
			id: string;
			title: string;
			titled: boolean;
			profile: SessionSummary["profile"];
			harness?: SessionSummary["harness"];
			modes?: Pick<SessionSummary, "mode" | "availableModes">;
			model: string;
			repoUrl: string | null;
			repository?: SessionRepository | null;
			publishUnasked?: boolean;
		},
	): MockSession {
		const at = now();
		const repository = input.repository ?? null;
		const session: MockSession = {
			summary: {
				id: input.id,
				title: input.title,
				place: { kind: "hosted" },
				profile: input.profile,
				harness: input.harness ?? "windlass",
				capabilities: sessionCapabilities(input.harness),
				...(input.modes ?? initialSessionModes(input.profile, input.harness)),
				model: input.model,
				repoUrl: repository ? `${repository.url}.git` : input.repoUrl,
				...(repository ? { repository, pullRequest: null, publishUnasked: input.publishUnasked === true } : {}),
				createdAt: at,
				updatedAt: at,
				status: "idle",
				turns: 0,
				lastOutcome: null,
				sandbox: "none",
			},
			titled: input.titled,
			windlassSessionId: null,
			windlassSeq: 0,
			timeline: [],
			pending: [],
			seq: 0,
			feeds: new Set(),
			run: null,
			files: new Map(),
			pauseTimer: null,
			question: null,
			questionTimer: null,
			resume: null,
			aside: null,
			startedServers: new Set(),
			submissions: new Map(),
			servers: [],
			pushed: false,
			pushedHead: null,
			verified: null,
		};
		world.sessions.set(input.id, session);
		return session;
	}

	function store(session: MockSession, item: DistributiveOmit<TimelineItem, "seq" | "at">): void {
		const stored = { ...item, seq: ++session.seq, at: now() } as TimelineItem;
		session.timeline.push(stored);
		for (const feed of session.feeds) feed.onItem(stored);
	}

	/** One event of `windlass --json`, stored or broadcast as contract.ts says. */
	function emit(session: MockSession, turn: number, event: WindlassEvent): void {
		track(session, event);
		if (isLive(event)) {
			const delta: WindlassDelta = { turn, event };
			session.pending.push(delta);
			for (const feed of session.feeds) feed.onDelta(delta);
			return;
		}
		// `pending` is the streaming output since the last durable event.
		if (isDurable(event)) session.pending = [];
		store(session, { turn, kind: "windlass", event });
	}

	function track(session: MockSession, event: WindlassEvent): void {
		const state = session.run;
		if (!state) return;
		const data = (event.data ?? event) as Record<string, unknown>;
		const messageId = typeof data.messageId === "string" ? data.messageId : "";
		const key = `${messageId}/${typeof data.callId === "string" ? data.callId : ""}`;
		switch (event.type) {
			case "execution.started":
				state.executionId = String(data.executionId);
				break;
			case "step.started":
				state.openStep = messageId;
				state.steps += 1;
				break;
			case "step.ended":
			case "step.failed": {
				state.openStep = null;
				const usage = data.usage as TurnUsage | null;
				if (usage) state.usage = addUsage(state.usage, usage);
				break;
			}
			case "text.delta":
				state.text.set(messageId, (state.text.get(messageId) ?? "") + String(data.text));
				break;
			case "text.ended":
				state.text.delete(messageId);
				break;
			case "tool.called":
				state.calls.set(key, { messageId, callId: String(data.callId), startedAt: null, progress: "" });
				break;
			case "tool.started": {
				const call = state.calls.get(key);
				if (call) call.startedAt = now();
				break;
			}
			case "tool.progress": {
				const call = state.calls.get(key);
				if (call) call.progress = String(data.text);
				break;
			}
			case "tool.settled":
				state.calls.delete(key);
				break;
		}
	}

	/** A recorded event as this session's Windlass would have written it now. */
	function restamp(session: MockSession, turn: number, event: WindlassEvent, prompt: string): WindlassEvent {
		const copy = structuredClone(event);
		copy.sessionId = session.windlassSessionId ?? undefined;
		const data = (copy.data ?? copy) as Record<string, unknown>;
		if (typeof data.messageId === "string") data.messageId = stampId(turn, data.messageId);
		if (isDurable(copy)) {
			copy.seq = ++session.windlassSeq;
			copy.time = now();
		}
		if (copy.type === "inbox.enqueued" && data.origin === null) data.content = [{ type: "text", text: prompt }];
		if (copy.type === "step.started") data.model = session.summary.model;
		// A subagent's event is its own session's, written now too.
		if (copy.type === "child.event" && typeof copy.event === "object" && copy.event !== null)
			(copy.event as WindlassEvent).time = now();
		return copy;
	}

	/**
	 * The repository's setup command in the new sandbox: its starting item, what it prints, its ending
	 * item. A command with the word "fail" in it ends with exit code 1, so both endings can be looked at.
	 */
	function setupSteps(session: MockSession, turn: number, command: string): Step[] {
		const id = `su_${hex(6)}`;
		const fails = /\bfail/.test(command);
		const lines = fails
			? [
					"npm warn deprecated glob@7.2.3",
					"npm error code E404",
					"npm error 404 Not Found - GET https://registry.npmjs.org/@acme%2fcharts",
					"npm error A complete log of this run can be found in: /tmp/.cache/npm/_logs/debug-0.log",
				]
			: ["added 412 packages in 9s", "", "61 packages are looking for funding", "  run `npm fund` for details"];
		const item = { turn, kind: "setup" as const, id, command, limitMs: MOCK_SETUP_LIMIT_MS };
		let startedAt = 0;
		const steps: Step[] = [
			{
				wait: 500,
				run: () => {
					startedAt = now();
					store(session, { ...item, state: "started", exitCode: null, durationMs: null, output: "", truncated: false });
				},
			},
		];
		for (const line of lines) {
			steps.push({
				wait: 700,
				run: () => {
					const delta: WindlassDelta = { turn, event: { type: "setup.output", id, text: `${line}\n` } };
					session.pending.push(delta);
					for (const feed of session.feeds) feed.onDelta(delta);
				},
			});
		}
		steps.push({
			wait: 600,
			run: () => {
				session.pending = session.pending.filter(
					delta => !("event" in delta && delta.event.type === "setup.output" && delta.event.id === id),
				);
				store(session, {
					...item,
					state: fails ? "failed" : "succeeded",
					exitCode: fails ? 1 : 0,
					durationMs: Math.max(0, now() - startedAt),
					output: `${lines.join("\n")}\n`,
					truncated: false,
				});
			},
		});
		return steps;
	}

	/** Everything a turn does, as timed steps. The same plan is run at once for history and on timers for a live turn. */
	function plan(world: World, session: MockSession, input: PromptInput, script: Script): Step[] {
		const turn = session.summary.turns + 1;
		const steps: Step[] = [];
		const first = session.windlassSessionId === null;

		steps.push({
			wait: 0,
			run: () => {
				const model = input.model ?? session.summary.model;
				session.run = {
					turn,
					startedAt: now(),
					timer: null,
					stopping: false,
					executionId: null,
					openStep: null,
					steps: 0,
					usage: null,
					text: new Map(),
					calls: new Map(),
					plan: [],
					next: 0,
					steers: [],
					cancelled: new Set(),
					replaceText: null,
				};
				cancel(session.pauseTimer);
				session.pauseTimer = null;
				const effort = input.effort ?? null;
				store(session, { turn, kind: "user", text: input.text, model, effort });
				const title = !session.titled && session.summary.turns === 0 ? promptTitle(input.text) : session.summary.title;
				setSummary(world, session, { status: "starting", model, effort, title, updatedAt: now() });
			},
		});
		if (script.unreachable && script.platformFailure !== undefined) {
			const message = script.platformFailure;
			steps.push({
				wait: 400,
				run: () =>
					finish(world, session, {
						outcome: "error",
						exitCode: null,
						steps: null,
						usage: null,
						cachedShare: null,
						message,
					}),
			});
			return steps;
		}
		if (session.summary.sandbox === "none") {
			steps.push({
				wait: 350,
				run: () => store(session, { turn, kind: "platform", level: "info", text: startNote(session) }),
			});
			if (session.summary.repoUrl !== null) {
				const repoUrl = session.summary.repoUrl;
				const picked = session.summary.repository;
				const what = picked ? `${picked.owner}/${picked.name} at ${picked.branch}` : repoUrl;
				steps.push({
					wait: 900,
					run: () => store(session, { turn, kind: "platform", level: "info", text: `Cloning ${what}` }),
				});
				const setup = picked ? world.setups.get(picked.id) : undefined;
				if (setup) steps.push(...setupSteps(session, turn, setup.command));
			}
		} else if (session.summary.sandbox === "paused") {
			steps.push({
				wait: 350,
				run: () => store(session, { turn, kind: "platform", level: "info", text: "Resuming the paused sandbox" }),
			});
		}
		steps.push({
			wait: 700,
			run: () => {
				if (first && script.platformFailure === undefined) session.windlassSessionId = `ses_${hex(24)}`;
				setSummary(world, session, { status: "running", sandbox: "running" });
				// Windlass starts the user's own MCP servers with the turn, as they are saved now.
				if (script.platformFailure === undefined) knowPersonal(world, session);
			},
		});

		if (script.platformFailure !== undefined) {
			const message = script.platformFailure;
			steps.push({
				wait: 2600,
				run: () => store(session, { turn, kind: "platform", level: "error", text: "The sandbox stopped answering." }),
			});
			steps.push({
				wait: 400,
				run: () =>
					finish(world, session, {
						outcome: "error",
						exitCode: null,
						steps: null,
						usage: null,
						cachedShare: null,
						message,
					}),
			});
			return steps;
		}

		// Windlass writes `session.created` and freezes its prompt once per session, not once per run.
		// The platform's own tools are offered only on a repository of the GitHub connection.
		const events = script.events.filter(
			event =>
				(first || (event.type !== "session.created" && event.type !== "baseline.set")) &&
				(session.summary.repository || !isHostEvent(event)),
		);
		const server = script.server;
		if (server && !server.late) {
			// What waits is asked about before Windlass gets the prompt: the turn's events follow the answer.
			steps.push({
				wait: 500,
				run: () =>
					askServer(world, session, turn, server, true, () =>
						play(session, eventSteps(world, session, turn, events, input, script)),
					),
			});
			return steps;
		}
		steps.push(...eventSteps(world, session, turn, events, input, script));
		return steps;
	}

	/**
	 * The platform answers a call of its `push` or `fetch_base`, as agent-session.ts `agentPush` and
	 * `agentFetchBase` do: its line in the timeline, then the call settles with what the agent is told.
	 * The push goes to the session's own branch, or is refused when the call names another; nobody is
	 * asked. It commits what the turn changed, so nothing differs from the last commit afterwards.
	 */
	function hostCall(world: World, session: MockSession, turn: number, event: WindlassEvent, prompt: string): void {
		const data = event.data ?? {};
		const repository = session.summary.repository;
		const say = (level: "info" | "warn", text: string) => store(session, { turn, kind: "platform", level, text });
		let output: string;
		if (!repository) {
			output =
				data.tool === "push"
					? "Not pushed. This session has no repository of the user's GitHub connection to push to."
					: "Not fetched. This session has no repository of the user's GitHub connection.";
		} else if (data.tool === "fetch_base") {
			const base = repository.branch;
			say("info", `Fetched ${base} from GitHub into the workspace as origin/${base}, as the agent asked.`);
			output = `Fetched ${base} from GitHub into the workspace as origin/${base}. Rebase onto it (git rebase origin/${base}) or merge it, then call push.`;
		} else {
			const branch = session.summary.pullRequest?.branch ?? branchFor(session);
			const named = typeof data.branch === "string" ? data.branch.trim() : "";
			const changed = new Set([
				...session.files.keys(),
				...(Array.isArray(data.changed) ? data.changed.map(String) : []),
			]);
			if (named !== "" && named !== branch) {
				say(
					"warn",
					`The agent asked to push to ${JSON.stringify(named)}, which is not this session's branch (${branch}), so nothing was pushed.`,
				);
				output = `Not pushed. This session's work can only go to the session's own branch, ${branch}; a request that names another branch is refused. Call the tool again without a branch.`;
			} else if (changed.size === 0 && session.pushedHead !== null) {
				say("info", `The agent asked to push; ${branch} at GitHub already had everything in the workspace.`);
				output = `Nothing to push: ${branch} at GitHub already has everything in the workspace.`;
			} else {
				const head = hex(40);
				session.files.clear();
				session.pushed = true;
				session.pushedHead = head;
				const current = session.summary.pullRequest ?? null;
				const open =
					current !== null && (current.state === "open" || current.state === "draft")
						? { ...current, pushedAt: now(), verified: verifiedWords(session.verified) }
						: null;
				if (open) setSummary(world, session, { pullRequest: open, updatedAt: now() });
				say(
					"info",
					`The agent pushed its work to ${branch} (${head.slice(0, 7)}).${open ? ` Pull request #${open.number} shows it; its description reports: ${open.verified}.` : ""}`,
				);
				const files =
					changed.size === 0
						? " Nothing was uncommitted: your own commits went as they were."
						: ` The platform's commit holds ${changed.size === 1 ? "1 file" : `${changed.size} files`}.`;
				output = `Pushed to ${branch} (${head.slice(0, 7)}).${files}${open ? ` Pull request #${open.number} shows it: ${open.url}` : " No pull request was opened."}`;
			}
		}
		const settled: WindlassEvent = {
			type: "tool.settled",
			v: 1,
			seq: 0,
			data: {
				messageId: data.messageId,
				callId: data.callId,
				outcome: "success",
				output,
				truncation: null,
				attachments: [],
				display: null,
			},
		};
		emit(session, turn, restamp(session, turn, settled, prompt));
	}

	/** Recorded events as timed steps: emitted as they are, with the turn's end and its question. */
	function eventSteps(
		world: World,
		session: MockSession,
		turn: number,
		events: WindlassEvent[],
		input: PromptInput,
		script: Script,
	): Step[] {
		const stretch = script.stretch ?? 1;
		const offsets = schedule(events);
		return events.map((event, index): Step => {
			const wait = ((offsets[index] ?? 0) - (offsets[index - 1] ?? 0)) * stretch;
			const data = (event.data ?? event) as Record<string, unknown>;
			const key = `${stampId(turn, String(data.messageId))}/${String(data.callId)}`;
			if (event.type === "cli.summary") {
				return {
					wait,
					run: () => {
						emit(session, turn, restamp(session, turn, event, input.text));
						const ended = turnEnded(event, { seq: 0, at: 0, turn });
						for (const [path, change] of Object.entries(script.workspace ?? {})) session.files.set(path, change);
						finish(world, session, {
							outcome: ended.outcome,
							exitCode: ended.exitCode,
							steps: ended.steps,
							usage: ended.usage,
							cachedShare: ended.cachedShare,
							message: null,
							durationMs: clock === null ? undefined : ended.durationMs,
						});
					},
				};
			}
			if (event.type === MOCK_HOST_CALL)
				return { wait, settles: key, run: () => hostCall(world, session, turn, event, input.text) };
			if (event.type === "approval.requested" && script.question) {
				const rest = script.question;
				return {
					wait,
					run: () => {
						const stamped = restamp(session, turn, event, input.text);
						emit(session, turn, stamped);
						ask(world, session, turn, stamped, input, script, rest);
					},
				};
			}
			return {
				wait,
				settles: event.type === "tool.settled" ? key : undefined,
				run: () => {
					const state = session.run;
					// What the recording still has of a call the user stopped did not happen.
					if (state?.cancelled.has(key) && (event.type === "tool.progress" || event.type === "tool.settled")) return;
					// Steered messages reach the model where a step begins.
					if (event.type === "step.started") deliverSteers(session, turn);
					// A server Windlass reports while the turn runs: its question does not hold the turn.
					if (event.type === "step.started" && script.server?.late && state?.steps === 0)
						askServer(world, session, turn, script.server, false, null);
					if (state?.replaceText != null && event.type === "text.delta") return;
					const stamped = restamp(session, turn, event, input.text);
					if (state?.replaceText != null && event.type === "text.ended") {
						(stamped.data as Record<string, unknown>).text = state.replaceText;
						state.replaceText = null;
					}
					emit(session, turn, stamped);
					const usage = reportedModelUsage(stamped);
					if (usage && usesPlatformModel(session.summary.harness, session.summary.model)) {
						const day = dayOf(now());
						world.modelTokens.set(day, (world.modelTokens.get(day) ?? 0) + usage.inputTokens + usage.outputTokens);
					}
				},
			};
		});
	}

	/** A Windlass event written now, by this session's Windlass. */
	function windlassEvent(
		session: MockSession,
		type: string,
		data: Record<string, unknown>,
	): WindlassEvent & { seq: number } {
		return {
			type,
			v: 1,
			data,
			sessionId: session.windlassSessionId ?? undefined,
			seq: ++session.windlassSeq,
			time: now(),
		};
	}

	function deliverSteers(session: MockSession, turn: number): void {
		const state = session.run;
		if (!state) return;
		for (const messageId of state.steers.splice(0))
			emit(session, turn, windlassEvent(session, "inbox.delivered", { messageId }));
	}

	function broadcastQuestion(session: MockSession): void {
		for (const feed of session.feeds) feed.onQuestion(session.question);
	}

	// ---- a project's MCP servers ------------------------------------------------------------------

	/** The user's approval of exactly this definition for the session's project, when one is remembered and has not run out. */
	function approvalOf(
		world: World,
		session: MockSession,
		name: string,
		fingerprint: string | null,
	): MockApproval | null {
		const project = mockProject(session.summary).key;
		return (
			world.approvals.find(
				approval =>
					approval.project === project &&
					approval.name === name &&
					approval.fingerprint === fingerprint &&
					approval.expiresAt > now(),
			) ?? null
		);
	}

	/** Tells the session's clients that what it knows of its project's servers, or of their approvals, changed. */
	function serversChanged(world: World, session: MockSession): void {
		const changedAt = Math.max(now(), (session.summary.servers?.changedAt ?? 0) + 1);
		setSummary(world, session, {
			servers: session.servers.length === 0 ? undefined : { count: session.servers.length, changedAt },
		});
	}

	/** Keeps what Windlass says of one server of the project. */
	function know(world: World, session: MockSession, server: MockKnown): void {
		const at = session.servers.findIndex(known => known.name === server.name);
		if (at >= 0) session.servers[at] = server;
		else session.servers.push(server);
		serversChanged(world, session);
	}

	/** What Windlass makes of a definition it may start. */
	function startedAs(server: MockServer): MockKnown {
		const failed = server.unset.length > 0;
		return {
			name: server.name,
			subject: commandLine(server.argv),
			remote: false,
			file: SERVER_FILE,
			state: failed ? "failed" : "running",
			tools: failed ? null : 2,
			reason: failed ? `the environment variable ${server.unset[0]} named in its env is not set` : null,
			fingerprint: server.fingerprint,
			at: now(),
		};
	}

	function remember(world: World, session: MockSession, name: string, fingerprint: string): void {
		const project = mockProject(session.summary).key;
		world.approvals = world.approvals.filter(
			approval => !(approval.project === project && approval.name === name && approval.fingerprint === fingerprint),
		);
		world.approvals.push({ project, name, fingerprint, approvedAt: now(), expiresAt: now() + APPROVAL_MS });
	}

	/** The session's servers as its panel shows them (the server's `serversView`). */
	function serversOf(world: World, session: MockSession): SessionServers {
		const project = mockProject(session.summary);
		const mine = world.approvals
			.filter(approval => approval.project === project.key && approval.expiresAt > now())
			.sort((a, b) => b.approvedAt - a.approvedAt);
		const times = (approval: MockApproval | null) =>
			approval === null ? null : { approvedAt: approval.approvedAt, expiresAt: approval.expiresAt };
		return {
			project: { kind: project.kind, label: project.label },
			servers: session.servers.map(server => {
				// One of the user's own is in their settings: nothing was approved, and nothing is asked.
				if (server.origin === "user") return { ...server, approval: null };
				const named = mine.filter(approval => approval.name === server.name);
				const approval =
					(server.fingerprint === null ? named[0] : named.find(one => one.fingerprint === server.fingerprint)) ?? null;
				const earlier = approval === null ? (named[0] ?? null) : null;
				const waits = server.state === "waiting" && server.fingerprint !== null && approval === null;
				return {
					...server,
					approval: times(approval),
					...(earlier === null ? {} : { earlier: times(earlier) }),
					...(waits ? { asks: mockPanelWords(server, profileOf(session), world.profile.demo, project) } : {}),
				};
			}),
			forgetting: MOCK_FORGETTING,
			...(session.servers.some(server => server.origin === "user")
				? { accountSecrets: mockAccountSecretsNote(profileOf(session)) }
				: {}),
		};
	}

	/**
	 * Puts the question about a project's server, unless Windlass's own record in this session's sandbox
	 * starts it, or the user's approval of exactly this definition is remembered for the project: then
	 * it starts without the question, and the line says why. `carryOn` plays the turn once it is settled,
	 * for a question put before the turn's events; a question put while the turn runs has none.
	 */
	function askServer(
		world: World,
		session: MockSession,
		turn: number,
		server: MockServer,
		holdsTurn: boolean,
		carryOn: (() => void) | null,
	): void {
		const named = `the MCP server "${server.name}"`;
		const agentHas = holdsTurn
			? "The agent has them from this turn on."
			: "The turn was already running: the agent is told of them at its next step.";
		if (session.startedServers.has(server.fingerprint)) {
			know(world, session, startedAs(server));
			carryOn?.();
			return;
		}
		const remembered = approvalOf(world, session, server.name, server.fingerprint);
		if (remembered) {
			session.startedServers.add(server.fingerprint);
			const ago = agoWords(now() - remembered.approvedAt);
			if (server.unset.length > 0) {
				store(session, {
					turn,
					kind: "platform",
					level: "warn",
					text: `You approved ${named} for this project ${ago}, but it did not start: the environment variable ${server.unset[0]} named in its env is not set. ${mockUnsetRemedy(server.unset, mockProject(session.summary), profileOf(session))}`,
				});
			} else {
				store(session, {
					turn,
					kind: "platform",
					level: "info",
					text: `Started ${named} because you approved it for this project ${ago}: 2 tools. ${agentHas}`,
				});
			}
			know(world, session, startedAs(server));
			carryOn?.();
			return;
		}
		know(world, session, { ...startedAs(server), state: "waiting", tools: null, reason: null });
		const askedAt = now();
		const question: PendingQuestion = {
			id: `q_${hex(16)}`,
			turn,
			messageId: "",
			callId: "",
			...mockServerQuestion(server, profileOf(session), world.profile.demo, mockProject(session.summary)),
			subagent: null,
			askedAt,
			expiresAt: askedAt + questionTimeout,
			server: { name: server.name, file: SERVER_FILE, remote: false, unset: server.unset, holdsTurn },
		};
		const resume = (choice: string): void => {
			if (choice === "start") {
				session.startedServers.add(server.fingerprint);
				remember(world, session, server.name, server.fingerprint);
				if (server.unset.length > 0) {
					store(session, {
						turn,
						kind: "platform",
						level: "warn",
						text: `Approved ${named} for this project, but it did not start: the environment variable ${server.unset[0]} named in its env is not set. ${mockUnsetRemedy(server.unset, mockProject(session.summary), profileOf(session))}`,
					});
				} else {
					store(session, {
						turn,
						kind: "platform",
						level: "info",
						text: `Started ${named} for this project: 2 tools. ${agentHas}`,
					});
				}
				know(world, session, startedAs(server));
			} else if (choice === "not_now") {
				store(session, {
					turn,
					kind: "platform",
					level: "info",
					text: `Left ${named} stopped. If the agent tries to use it, it is told that the server waits for you; your next message asks again.`,
				});
			}
			carryOn?.();
		};
		putServer(world, session, question, resume);
	}

	/** Shows a server's question, the first time and again after it stood aside, with a new time to answer in. */
	function putServer(
		world: World,
		session: MockSession,
		question: PendingQuestion,
		resume: (choice: string, note: string | null) => void,
	): void {
		const shownAt = now();
		session.question = { ...question, expiresAt: shownAt + questionTimeout };
		session.resume = resume;
		broadcastQuestion(session);
		if (question.server?.holdsTurn) setSummary(world, session, { status: "waiting", updatedAt: now() });
		session.questionTimer = later(Math.max(0, shownAt + questionTimeout - realNow()), () => {
			if (session.question?.id !== question.id) return;
			store(session, {
				turn: question.turn,
				kind: "platform",
				level: "warn",
				text: `Nobody answered about the MCP server "${question.server?.name ?? ""}" within ${minutes(questionTimeout)}, so it stays stopped. Your next message asks again.`,
			});
			settle(world, session, "expired", null);
		});
	}

	/** The turn reached its question: it waits for an answer, or for the platform to decline. */
	function ask(
		world: World,
		session: MockSession,
		turn: number,
		requested: WindlassEvent,
		input: PromptInput,
		script: Script,
		rest: QuestionScript,
	): void {
		// A tool call's question comes first: a server's steps aside and is put again after it.
		if (session.question?.server && session.resume) {
			session.aside = { question: session.question, resume: session.resume };
			cancel(session.questionTimer);
			session.questionTimer = null;
			session.question = null;
			session.resume = null;
		}
		const data = (requested.data ?? {}) as Record<string, unknown>;
		const asked = (data.question ?? {}) as {
			title?: string;
			subject?: string;
			details?: string[];
			choices?: Array<{ id: string; label: string; approve: boolean; remembers: string | null; grants?: unknown[] }>;
		};
		const choices = asked.choices ?? [];
		const askedAt = now();
		session.question = {
			id: `q_${hex(16)}`,
			turn,
			messageId: String(data.messageId),
			callId: String(data.callId),
			title: asked.title ?? "",
			subject: asked.subject ?? "",
			details: asked.details ?? [],
			choices: choices.map(({ id, label, approve, remembers }) => ({ id, label, approve, remembers })),
			subagent: rest.subagent ?? null,
			askedAt,
			expiresAt: askedAt + questionTimeout,
		};
		broadcastQuestion(session);
		setSummary(world, session, { status: "waiting", updatedAt: now() });

		session.resume = (choiceId, note) => {
			const choice = choices.find(candidate => candidate.id === choiceId);
			const approve = choice?.approve === true;
			const events = (approve ? rest.approved : rest.declined).map(event => {
				if (event.type === "approval.answered")
					return {
						...event,
						data: {
							...event.data,
							choice: choiceId,
							approve,
							note,
							grants: (choice?.grants ?? []).map(grant => ({ ...(grant as object), seq: session.windlassSeq + 1 })),
						},
					};
				if (
					event.type === "tool.settled" &&
					!approve &&
					event.data?.messageId === data.messageId &&
					event.data?.callId === data.callId
				) {
					const output =
						note === null
							? "Not run: the user declined this call."
							: `Not run: the user declined this call. Their note: ${note}`;
					return { ...event, data: { ...event.data, output } };
				}
				return event;
			});
			play(session, eventSteps(world, session, turn, events, input, script));
		};
		// History is written in the past; the timer is real time from now.
		session.questionTimer = later(Math.max(0, askedAt + questionTimeout - realNow()), () => {
			const question = session.question;
			if (!question) return;
			store(session, {
				turn,
				kind: "platform",
				level: "warn",
				text: `Nobody answered within ${minutes(questionTimeout)}, so the platform declined the call.`,
				code: "question_expired",
				call: { messageId: question.messageId, callId: question.callId },
			});
			settle(world, session, question.choices.find(choice => !choice.approve)?.id ?? "deny", null);
		});
	}

	/** The question is answered: it goes, and the turn carries on. */
	function settle(world: World, session: MockSession, choice: string, note: string | null): void {
		const resume = session.resume;
		withdraw(session);
		if (!resume || !session.run) return;
		setSummary(world, session, { status: "running", updatedAt: now() });
		resume(choice, note);
		const aside = session.aside;
		if (aside && session.run && session.question === null) {
			session.aside = null;
			putServer(world, session, aside.question, aside.resume);
		}
	}

	/** The question goes without an answer (or before its answer is played). */
	function withdraw(session: MockSession): void {
		cancel(session.questionTimer);
		session.questionTimer = null;
		session.resume = null;
		if (session.question === null) return;
		session.question = null;
		broadcastQuestion(session);
	}

	/**
	 * What the session's work rests on after a turn, as the server would say it of a turn like the
	 * mock's: the checks saved for the session's repository that have no file patterns ran and passed
	 * when the turn ended as done; the ones with patterns did not apply; a turn that was stopped or
	 * failed ran none, and what an earlier turn’s checks came to stands.
	 */
	function verifiedAfter(world: World, session: MockSession, turn: number, outcome: TurnOutcome): Verified {
		const saved = world.checks.get(session.summary.repository?.id ?? -1)?.checks ?? [];
		const before = session.verified;
		const ran = saved.filter(check => check.when === undefined);
		const none = { unrun: saved.map(({ name, command }) => ({ name, command })), changedAfter: before?.run != null };
		if (outcome !== "succeeded" && outcome !== "unresolved")
			return {
				turn,
				state: outcome === "interrupted" || outcome === "stopped" ? "stopped" : "failed",
				run: before?.run ?? null,
				...none,
			};
		if (saved.length === 0) return { turn, state: "none_set", run: before?.run ?? null, ...none };
		// Windlass reports why no check was needed: the turn changed files, and none that a check covers. Without a run so far, the state they are measured from is the session's start.
		if (ran.length === 0)
			return {
				turn,
				state: "not_needed",
				unneeded: { reason: "not_covered", on: before?.run == null ? "start" : null },
				run: before?.run ?? null,
				...none,
				changedAfter: before?.changedAfter ?? false,
			};
		const failing = outcome === "unresolved";
		// A turn whose script shows the agent being sent back with a failing check says how often, as the server counts it: by the harness's own messages, each of which a model call follows in these recordings.
		const reports = session.timeline.filter(
			item =>
				item.kind === "windlass" &&
				item.turn === turn &&
				item.event.type === "synthetic.appended" &&
				item.event.data?.origin === "check_report",
		).length;
		const checks = ran.map((check, index) => ({
			name: check.name,
			command: check.command,
			whose: "user" as const,
			required: true,
			status: failing && index === 0 ? ("failed" as const) : ("passed" as const),
			exitCode: failing && index === 0 ? 1 : 0,
			durationMs: 4200 + index * 1900,
			sentBack: index === 0 ? (failing ? Math.max(reports, 3) : reports) : 0,
		}));
		const finished = session.timeline.findLast(
			item => item.turn === turn && item.kind === "windlass" && item.event.type === "checks.finished",
		);
		let seq = finished?.kind === "windlass" ? finished.event.seq : undefined;
		if (seq === undefined) {
			const event = windlassEvent(session, "checks.finished", {
				evidence: { checks: checks.map(check => ({ ...check, origin: "session" })) },
			});
			emit(session, turn, event);
			seq = event.seq;
		}
		return {
			turn,
			state: failing ? "unresolved" : "passed",
			...(failing ? { unresolved: { reason: "max_rounds" as const, said: null } } : {}),
			run: { turn, seq, at: now(), checks },
			unrun: saved.filter(check => check.when !== undefined).map(({ name, command }) => ({ name, command })),
			changedAfter: false,
		};
	}

	/** What a pull request's description says was verified, in the server's few words (server/src/verified.ts, `verifiedWords`). */
	function verifiedWords(verified: Verified | null): string {
		const here =
			verified !== null && verified.run !== null && verified.run.turn === verified.turn ? verified.run.checks : [];
		const count = `${here.length} ${here.length === 1 ? "check" : "checks"}`;
		const base =
			verified === null
				? "nothing verified"
				: verified.state === "passed"
					? `${count} passed`
					: verified.state === "unresolved"
						? `${here.filter(check => check.status !== "passed").length} of ${count} failing`
						: verified.state === "not_needed"
							? verified.unneeded.reason === "not_covered"
								? "no check covers what changed"
								: "no check was needed"
							: verified.state === "stopped" || verified.state === "failed"
								? "checks did not run"
								: "nothing verified";
		return verified?.changedAfter ? `${base}, 1 thing to look at` : base;
	}

	function finish(
		world: World,
		session: MockSession,
		end: {
			outcome: TurnOutcome;
			exitCode: number | null;
			steps: number | null;
			usage: TurnUsage | null;
			cachedShare: number | null;
			message: string | null;
			durationMs?: number;
		},
	): void {
		const state = session.run;
		if (!state) return;
		// A server's question put while the turn ran goes with the turn; a turn that was stopped took it away without a word.
		const unanswered = session.question?.server ?? session.aside?.question.server;
		if (unanswered)
			store(session, {
				turn: state.turn,
				kind: "platform",
				level: "info",
				text: `The turn ended before anyone answered about the MCP server "${unanswered.name}". Your next message asks again.`,
			});
		session.aside = null;
		withdraw(session);
		session.run = null;
		session.pending = [];
		store(session, {
			turn: state.turn,
			kind: "turn.ended",
			outcome: end.outcome,
			exitCode: end.exitCode,
			steps: end.steps,
			durationMs: end.durationMs ?? now() - state.startedAt,
			usage: end.usage,
			cachedShare: end.cachedShare,
			message: end.message,
			verified: (session.verified = verifiedAfter(world, session, state.turn, end.outcome)),
		});
		// What the turn's sandbox ran is counted for the day.
		if (clock === null && session.summary.place.kind === "hosted")
			world.spent.set(
				session.summary.id,
				(world.spent.get(session.summary.id) ?? 0) + Math.max(1, Math.round((now() - state.startedAt) / 1000)),
			);
		setSummary(world, session, {
			status: "idle",
			turns: state.turn,
			lastOutcome: end.outcome,
			updatedAt: now(),
			startTimes: mockStartTimes(session.summary, state.turn, state.startedAt),
		});
		// An idle sandbox is suspended after a while, and the timeline says so as the server's does; its files stay.
		if (clock === null) {
			session.pauseTimer = later(2 * MINUTE, () => {
				if (session.run !== null || session.summary.sandbox !== "running") return;
				store(session, {
					turn: state.turn,
					kind: "platform",
					level: "info",
					text: "Suspended the sandbox after 2 minutes without use; the next prompt resumes it.",
				});
				setSummary(world, session, { sandbox: "paused" });
			});
		}
	}

	function play(session: MockSession, steps: Step[], index = 0): void {
		const state = session.run;
		const step = steps[index];
		if (!step || (index > 0 && (!state || state.stopping))) return;
		const proceed = () => {
			step.run();
			if (session.run) {
				session.run.plan = steps;
				session.run.next = index + 1;
			}
			play(session, steps, index + 1);
		};
		if (index === 0) proceed();
		else if (session.run) session.run.timer = later(step.wait, proceed);
	}

	/** Runs a whole turn at once, as history that began at `at`. */
	function playInstantly(steps: Step[], at: number): void {
		let time = at;
		for (const step of steps) {
			time += step.wait;
			clock = time;
			step.run();
		}
		clock = null;
	}

	/** Winds a running turn down the way Windlass does when the user stops it. */
	function interrupt(world: World, session: MockSession): void {
		const state = session.run;
		if (!state || state.stopping) return;
		state.stopping = true;
		cancel(state.timer);
		// A question still waiting is withdrawn: nobody can answer it any more.
		session.aside = null;
		withdraw(session);
		setSummary(world, session, { status: "stopping" });
		const turn = state.turn;
		const windlass = (type: string, data: Record<string, unknown>): WindlassEvent => windlassEvent(session, type, data);

		if (state.executionId === null) {
			// Windlass had not started: there is nothing of its own to wind down.
			state.timer = later(300, () => {
				store(session, { turn, kind: "platform", level: "info", text: "Stopped before Windlass started." });
				finish(world, session, {
					outcome: "interrupted",
					exitCode: null,
					steps: null,
					usage: null,
					cachedShare: null,
					message: null,
				});
			});
			return;
		}

		const executionId = state.executionId;
		const steps: Step[] = [
			{
				wait: 120,
				run: () => emit(session, turn, windlass("execution.interrupt_requested", { executionId, reason: "user" })),
			},
		];
		// The visible part of an unfinished answer is kept.
		for (const [messageId, text] of state.text)
			steps.push({
				wait: 40,
				run: () => emit(session, turn, windlass("text.ended", { messageId, text, providerData: null })),
			});
		for (const call of state.calls.values()) {
			steps.push({
				wait: 380,
				run: () => {
					const seconds = call.startedAt === null ? 0 : Math.max(1, Math.round((now() - call.startedAt) / 1000));
					const output =
						call.startedAt === null
							? "Not run: the user stopped the response before this call started."
							: `Stopped by the user after ${seconds} s. Output so far:\n${call.progress}`;
					emit(
						session,
						turn,
						windlass("tool.settled", {
							messageId: call.messageId,
							callId: call.callId,
							outcome: call.startedAt === null ? "not_started" : "error",
							output,
							truncation: null,
							attachments: [],
							display: null,
						}),
					);
				},
			});
		}
		if (state.openStep !== null) {
			const messageId = state.openStep;
			steps.push({
				wait: 40,
				run: () =>
					emit(
						session,
						turn,
						windlass("step.failed", { messageId, error: { kind: "interrupted", reason: "user" }, usage: null }),
					),
			});
		}
		steps.push({
			wait: 40,
			run: () =>
				emit(
					session,
					turn,
					windlass("synthetic.appended", {
						messageId: `msg_t${turn}_s1`,
						origin: "interrupt",
						content: [{ type: "text", text: "The user stopped the previous response before it finished." }],
					}),
				),
		});
		steps.push({
			wait: 40,
			run: () => emit(session, turn, windlass("execution.interrupted", { executionId, reason: "user" })),
		});
		steps.push({
			wait: 60,
			run: () => {
				const usage = state.usage;
				const cachedShare =
					usage && usage.inputTokens > 0
						? Math.round((usage.cachedInputTokens / usage.inputTokens) * 1000) / 1000
						: null;
				emit(session, turn, {
					type: "cli.summary",
					sessionId: session.windlassSessionId ?? undefined,
					executionId,
					outcome: "interrupted",
					steps: state.steps,
					summaryCalls: 0,
					requests: state.steps,
					durationMs: now() - state.startedAt,
					usage,
					cachedShare,
				});
				finish(world, session, {
					outcome: "interrupted",
					exitCode: 130,
					steps: state.steps,
					usage,
					cachedShare,
					message: null,
				});
			},
		});
		const runNext = (index: number) => {
			const step = steps[index];
			if (!step) return;
			state.timer = later(step.wait, () => {
				step.run();
				runNext(index + 1);
			});
		};
		runNext(0);
	}

	/** Stops one running call the way Windlass does: the request, then the call settles, and the turn goes on. */
	function stopOneCall(
		session: MockSession,
		messageId: string,
		callId: string,
	): { stopped: boolean; message: string | null } {
		const state = session.run;
		if (!state || state.stopping) throw new PlatformError("user", "No turn is running.");
		const key = `${messageId}/${callId}`;
		const call = state.calls.get(key);
		if (!call) return { stopped: false, message: "That call is no longer running." };
		if (call.startedAt === null)
			return { stopped: false, message: "That call has not started, so there is nothing to stop yet." };
		if (state.cancelled.has(key)) return { stopped: false, message: "This call is already being stopped." };
		state.cancelled.add(key);
		const turn = state.turn;
		cancel(state.timer);
		emit(session, turn, windlassEvent(session, "tool.cancel_requested", { messageId, callId }));
		const startedAt = call.startedAt;
		state.timer = later(450, () => {
			if (session.run !== state || state.stopping) return;
			const seconds = Math.max(1, Math.round((now() - startedAt) / 1000));
			const output = `${call.progress === "" ? "" : `${call.progress}\n`}[Stopped by the user after ${seconds} s]`;
			emit(
				session,
				turn,
				windlassEvent(session, "tool.settled", {
					messageId,
					callId,
					outcome: "error",
					output,
					truncation: null,
					attachments: [],
					display: {
						exitCode: null,
						signal: "SIGTERM",
						timedOut: false,
						interrupted: "user",
						durationMs: now() - startedAt,
					},
				}),
			);
			state.replaceText =
				"You stopped that command before it finished, so I don't have its result. Tell me if you want me to run it again or try something else.";
			// Skip what the recording still had of the call.
			const settledAt = state.plan.findIndex((step, index) => index >= state.next && step.settles === key);
			play(session, state.plan, settledAt >= 0 ? settledAt + 1 : state.next);
		});
		return { stopped: true, message: null };
	}

	// ---- a Claude Code agent's turns (ACP) --------------------------------------------------------

	/**
	 * Plays a Claude Code agent's turn as the server records one (`acpRecorder`): the user's prompt, the
	 * sandbox, then each ACP update after its wait, a question where the harness asks permission, and
	 * the turn's ending with the context's fill. `answered`: the answer a seeded turn's question had,
	 * which is then not asked.
	 */
	function acpTurn(
		world: World,
		session: MockSession,
		input: PromptInput,
		script: AcpScript,
		answered?: string,
	): Step[] {
		const turn = session.summary.turns + 1;
		const model = input.model ?? session.summary.model;
		const fallback =
			typeof input.effort === "string" &&
			model !== session.summary.model &&
			!MOCK_CLAUDE_MODELS.models.find(m => m.id === model)?.efforts.includes(input.effort);
		const steps: Step[] = [
			{
				wait: 0,
				run: () => {
					session.run = {
						turn,
						startedAt: now(),
						timer: null,
						stopping: false,
						executionId: null,
						openStep: null,
						steps: 0,
						usage: null,
						text: new Map(),
						calls: new Map(),
						plan: [],
						next: 0,
						steers: [],
						cancelled: new Set(),
						replaceText: null,
					};
					const run = session.run;
					run.acp = {
						context: null,
						recorder: acpRecorder(turn, {
							key: () => `acp-${turn}-${session.seq + 1}`,
							store: item => store(session, item),
							live: (delta, sofar) => {
								const at = session.pending.findIndex(one => "acp" in one && one.messageKey === sofar.messageKey);
								if (at >= 0) session.pending[at] = sofar;
								else session.pending.push(sofar);
								for (const feed of session.feeds) feed.onDelta(delta);
							},
							ended: key => {
								session.pending = session.pending.filter(one => !("acp" in one && one.messageKey === key));
							},
						}),
					};
					cancel(session.pauseTimer);
					session.pauseTimer = null;
					const effort = fallback ? null : (input.effort ?? null);
					store(session, { turn, kind: "user", text: input.text, model, effort });
					if (fallback)
						store(session, {
							turn,
							kind: "platform",
							level: "info",
							text: "The selected model uses its default effort.",
						});
					const title =
						!session.titled && session.summary.turns === 0 ? promptTitle(input.text) : session.summary.title;
					setSummary(world, session, { status: "starting", model, effort, title, updatedAt: now() });
				},
			},
		];
		if (session.summary.sandbox === "none")
			steps.push({
				wait: 350,
				run: () => store(session, { turn, kind: "platform", level: "info", text: startNote(session) }),
			});
		else if (session.summary.sandbox === "paused")
			steps.push({
				wait: 350,
				run: () => store(session, { turn, kind: "platform", level: "info", text: "Resuming the paused sandbox" }),
			});
		steps.push({
			wait: 700,
			run: () => {
				session.windlassSessionId ??= `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
				setSummary(world, session, { status: "running", sandbox: "running" });
			},
		});
		steps.push(...acpSteps(world, session, turn, script.entries, script.stopReason, answered));
		return steps;
	}

	/** The steps of a run of ACP entries; at a question the rest waits for its answer, unless the turn was seeded with one. */
	function acpSteps(
		world: World,
		session: MockSession,
		turn: number,
		entries: AcpEntry[],
		stopReason: string,
		answered?: string,
	): Step[] {
		const steps: Step[] = [];
		for (const [index, entry] of entries.entries()) {
			if ("update" in entry) {
				const update = entry.update;
				steps.push({
					wait: entry.wait,
					run: () => {
						const state = session.run?.acp;
						if (!state) return;
						const title = generatedSessionTitle(update, { typed: session.titled, item: session.summary.item });
						if (title && title !== session.summary.title) setSummary(world, session, { title });
						if (update.sessionUpdate === "usage_update") state.context = contextOf(update);
						// Claude Code changed its own mode (leaving Plan, say): the session's follows, unless its user chose one during the turn.
						if (
							update.sessionUpdate === "current_mode_update" &&
							typeof update.currentModeId === "string" &&
							!state.modeQueued &&
							session.summary.mode !== update.currentModeId
						)
							setSummary(world, session, { mode: update.currentModeId });
						state.recorder.update(update);
						entry.then?.();
					},
				});
				continue;
			}
			const rest = entries.slice(index + 1);
			const allowed = (choice: string | undefined) =>
				entry.ask.options.find(option => option.optionId === choice)?.kind.startsWith("allow") === true;
			if (answered !== undefined) {
				steps.push(
					...acpSteps(
						world,
						session,
						turn,
						[...(allowed(answered) ? entry.allowed : entry.declined), ...rest],
						stopReason,
						answered,
					),
				);
				return steps;
			}
			steps.push({
				wait: entry.wait,
				run: () => {
					session.run?.acp?.recorder.flush();
					askAcp(world, session, turn, entry.ask, choice =>
						play(session, [
							{ wait: 0, run: () => undefined },
							...acpSteps(
								world,
								session,
								turn,
								[...(allowed(choice) ? entry.allowed : entry.declined), ...rest],
								stopReason,
							),
						]),
					);
				},
			});
			return steps;
		}
		steps.push({ wait: 400, run: () => finishAcp(world, session, stopReason) });
		return steps;
	}

	/** Claude Code asks permission for a call (`session/request_permission`), as the server puts it to the user (server/src/sandbox/acp-harness.ts, `permission`). */
	function askAcp(
		world: World,
		session: MockSession,
		turn: number,
		ask: AcpPermission["permission"],
		onAnswer: (choice: string) => void,
	): void {
		const askedAt = now();
		const title = typeof ask.toolCall.title === "string" ? ask.toolCall.title : "";
		const choices = ask.options.map(option => ({
			id: option.optionId,
			label: option.name,
			approve: option.kind.startsWith("allow"),
			remembers: option.kind === "allow_always" ? "for this conversation, as Claude Code keeps it" : null,
		}));
		session.question = {
			id: `q_${hex(16)}`,
			turn,
			messageId: "acp",
			callId: ask.toolCall.toolCallId,
			title,
			subject: title,
			details: [],
			choices,
			subagent: null,
			askedAt,
			expiresAt: askedAt + questionTimeout,
		};
		broadcastQuestion(session);
		setSummary(world, session, { status: "waiting", updatedAt: now() });
		session.resume = choice => onAnswer(choice);
		session.questionTimer = later(Math.max(0, askedAt + questionTimeout - realNow()), () => {
			const question = session.question;
			if (!question) return;
			store(session, {
				turn,
				kind: "platform",
				level: "warn",
				text: `Nobody answered within ${minutes(questionTimeout)}, so the platform declined the call.`,
				code: "question_expired",
				call: { messageId: question.messageId, callId: question.callId },
			});
			settle(world, session, ask.options.find(option => option.kind === "reject_once")?.optionId ?? "reject", null);
		});
	}

	/** What a mock agent answers a prompt that ran to its end with (server/src/sandbox/acp-harness.ts, `promptUsage`): the turn's tokens. */
	const MOCK_ACP_TOKENS: TurnUsage = {
		inputTokens: 24_300,
		cachedInputTokens: 18_900,
		outputTokens: 1_240,
		reasoningTokens: 310,
	};

	/** The turn's ending, as the server writes it for an ACP turn: the outcome from the stop reason, no gate, the context's fill, and the tokens the agent answered with. */
	function finishAcp(world: World, session: MockSession, stopReason: string): void {
		const state = session.run;
		if (!state) return;
		state.acp?.recorder.flush();
		withdraw(session);
		session.run = null;
		session.pending = [];
		const outcome = acpOutcome(stopReason);
		// The agent's own session id (`session/new`) comes with the turn's end, as the server sends it.
		store(session, {
			turn: state.turn,
			kind: "turn.ended",
			outcome,
			exitCode: null,
			steps: null,
			durationMs: now() - state.startedAt,
			usage: stopReason === "end_turn" ? MOCK_ACP_TOKENS : null,
			cachedShare: null,
			message: null,
			verified: null,
			context: state.acp?.context ?? null,
			...(session.windlassSessionId && { sessionId: session.windlassSessionId }),
		});
		// Once it has run, the session has the models Claude Code listed.
		setSummary(world, session, {
			status: "idle",
			turns: state.turn,
			lastOutcome: outcome,
			updatedAt: now(),
			startTimes: mockStartTimes(session.summary, state.turn, state.startedAt),
			harnessModels: {
				...(session.summary.harness === "codex"
					? MOCK_CODEX_MODELS
					: session.summary.harness === "opencode"
						? MOCK_OPENCODE_MODELS
						: MOCK_CLAUDE_MODELS),
				fetchedAt: now(),
			},
		});
		if (clock === null) {
			session.pauseTimer = later(2 * MINUTE, () => {
				if (session.run !== null || session.summary.sandbox !== "running") return;
				store(session, {
					turn: state.turn,
					kind: "platform",
					level: "info",
					text: "Suspended the sandbox after 2 minutes without use; the next prompt resumes it.",
				});
				setSummary(world, session, { sandbox: "paused" });
			});
		}
	}

	/** Stop: Claude Code is cancelled (`session/cancel`), and the turn ends as stopped. */
	function interruptAcp(world: World, session: MockSession): void {
		const state = session.run;
		if (!state || state.stopping) return;
		state.stopping = true;
		cancel(state.timer);
		withdraw(session);
		setSummary(world, session, { status: "stopping" });
		state.timer = later(500, () => {
			// The answer so far is kept, as the recorder stores it.
			state.stopping = false;
			finishAcp(world, session, "cancelled");
		});
	}

	/** What a Claude Code agent does for a prompt: a recorded scenario when the prompt names one, otherwise a small piece of work on the README. */
	function claudeScript(session: MockSession, text: string): AcpScript {
		const named = ACP_SCENARIOS.find(name => new RegExp(`\\b${name}\\b`, "i").test(text));
		return named ? fixtureScript(acpFixture(`acp-claude-${named}`)) : workScript(session);
	}

	/**
	 * The README piece of work, from the recorded scenarios' parts: the plan scenario's plan, the plain
	 * scenario's thinking, the permission the ask scenario asks, around a read, an edit with its diff,
	 * and the tests. The edit changes the workspace, as the side panel then lists.
	 */
	function workScript(session: MockSession): AcpScript {
		const plain = acpFixture("acp-claude-plain").updates.filter(
			(entry): entry is AcpUpdate => !isPermission(entry) && entry.sessionUpdate === "agent_thought_chunk",
		);
		const plans = acpFixture("acp-claude-plan").updates.filter((entry): entry is AcpUpdate => !isPermission(entry));
		const ask = acpFixture("acp-claude-ask").updates.find(isPermission)?.permission.options ?? [];
		const ids = { read: `toolu_${hex(12)}`, edit: `toolu_${hex(12)}`, test: `toolu_${hex(12)}` };
		const chunks = (kind: "agent_message_chunk" | "agent_thought_chunk", text: string): AcpEntry[] =>
			text
				.split(/(?<= )/)
				.map(part => ({ wait: 70, update: { sessionUpdate: kind, content: { type: "text", text: part } } }));
		const tool = (wait: number, update: Record<string, unknown>): AcpEntry => ({ wait, update: update as AcpUpdate });
		const readme = "# tide-tables\n\nTide tables for the harbour, as JSON.\n\n## Use\n\nnpm install\nnpm start\n";
		const changed = readme.replace("npm start\n", "npm start\n\n## Tests\n\nRun them with `npm test`.\n");
		const diff = unifiedDiff("/workspace/README.md", readme, changed);
		return {
			stopReason: "end_turn",
			entries: [
				...plain.map(update => ({ wait: 90, update })),
				tool(200, { sessionUpdate: "session_info_update", title: "Document the README test command" }),
				{ wait: 400, update: plans[0] as AcpUpdate },
				tool(500, {
					sessionUpdate: "tool_call",
					toolCallId: ids.read,
					title: "Read README.md",
					kind: "read",
					status: "pending",
					rawInput: { file_path: "/workspace/README.md" },
				}),
				tool(300, { sessionUpdate: "tool_call_update", toolCallId: ids.read, status: "in_progress" }),
				tool(700, {
					sessionUpdate: "tool_call_update",
					toolCallId: ids.read,
					status: "completed",
					content: [{ type: "content", content: { type: "text", text: readme } }],
				}),
				{ wait: 300, update: plans[1] as AcpUpdate },
				tool(600, {
					sessionUpdate: "tool_call",
					toolCallId: ids.edit,
					title: "Edit README.md",
					kind: "edit",
					status: "pending",
					rawInput: {
						file_path: "/workspace/README.md",
						old_string: "npm start\n",
						new_string: "npm start\n\n## Tests\n\nRun them with `npm test`.\n",
					},
					content: [{ type: "diff", path: "/workspace/README.md", oldText: readme, newText: changed }],
				}),
				tool(400, { sessionUpdate: "tool_call_update", toolCallId: ids.edit, status: "in_progress" }),
				{
					...tool(500, { sessionUpdate: "tool_call_update", toolCallId: ids.edit, status: "completed" }),
					then: () => session.files.set("README.md", { status: "M", diff }),
				},
				{ wait: 300, update: plans[2] as AcpUpdate },
				tool(500, {
					sessionUpdate: "tool_call",
					toolCallId: ids.test,
					title: "npm test",
					kind: "execute",
					status: "pending",
					rawInput: { command: "npm test", description: "Run the tests" },
				}),
				{
					wait: 300,
					ask: { toolCall: { toolCallId: ids.test, title: "npm test", kind: "execute" }, options: ask },
					allowed: [
						tool(300, {
							sessionUpdate: "tool_call_update",
							toolCallId: ids.test,
							status: "in_progress",
							content: [
								{ type: "content", content: { type: "text", text: "> tide-tables@1.4.0 test\n> node --test\n" } },
							],
						}),
						tool(2600, {
							sessionUpdate: "tool_call_update",
							toolCallId: ids.test,
							status: "in_progress",
							content: [
								{
									type: "content",
									content: {
										type: "text",
										text: "> tide-tables@1.4.0 test\n> node --test\n\n✔ reads a day of tides (4ms)\n✔ rounds heights to the centimetre (1ms)\nℹ tests 12\nℹ pass 12\nℹ fail 0\n",
									},
								},
							],
						}),
						tool(400, { sessionUpdate: "tool_call_update", toolCallId: ids.test, status: "completed" }),
						{ wait: 300, update: plans[3] as AcpUpdate },
						{
							wait: 200,
							update: {
								sessionUpdate: "usage_update",
								used: 82_000,
								size: 200_000,
								cost: { amount: 0.38, currency: "USD" },
							},
						},
						...chunks(
							"agent_message_chunk",
							"I added a Tests section to the README saying the tests run with `npm test`, and ran them: all 12 pass.",
						),
					],
					declined: [
						tool(300, {
							sessionUpdate: "tool_call_update",
							toolCallId: ids.test,
							status: "failed",
							content: [{ type: "content", content: { type: "text", text: "The user declined this command." } }],
						}),
						{
							wait: 200,
							update: {
								sessionUpdate: "usage_update",
								used: 64_000,
								size: 200_000,
								cost: { amount: 0.29, currency: "USD" },
							},
						},
						...chunks(
							"agent_message_chunk",
							"I added a Tests section to the README saying the tests run with `npm test`. I did not run them, since you declined the command.",
						),
					],
				},
			],
		};
	}

	/** A recorded scenario as it was sent, a little slower than the fake agent sends it. */
	function fixtureScript(recorded: ReturnType<typeof acpFixture>): AcpScript {
		const entries: AcpEntry[] = recorded.updates.map(entry =>
			isPermission(entry)
				? { wait: 300, ask: entry.permission, allowed: [], declined: [] }
				: { wait: entry.sessionUpdate.endsWith("_chunk") ? 90 : 500, update: entry },
		);
		return { entries, stopReason: recorded.stopReason };
	}

	// ---- the seeded sessions --------------------------------------------------------------------

	/**
	 * `?blocked=1`: what a sandbox's egress refused, in each turn of a session. The first turn's row is
	 * one hosted lookup; the second's has every kind (allowed by the repository's list, by a machine's
	 * settings, never), a lookup with no port, a malformed destination, and requests past the 50 kept.
	 * The hosted lookups are named by their platform line too, as the server writes both.
	 */
	function seedBlocked(session: MockSession): void {
		const repository = session.summary.repository;
		const at = (turn: number) =>
			session.timeline.findLast(item => item.turn === turn && item.kind === "turn.ended")?.at ?? realNow();
		const hostLine = (turn: number, host: string) => {
			session.timeline.push({
				seq: ++session.seq,
				at: at(turn) - 4_000,
				turn,
				kind: "platform",
				level: "warn",
				code: "host_blocked",
				host,
				...(repository ? { repository: true } : {}),
				text: `A command in this sandbox could not reach ${host}: its network reaches only the hosts it is allowed.${repository ? ` Allow it for ${repository.owner}/${repository.name} to let its agents reach it.` : ""}`,
			});
		};
		const row = (turn: number, revision: number, network: BlockedNetwork) =>
			session.timeline.push({
				seq: ++session.seq,
				at: at(turn) - 3_000,
				turn,
				kind: "network.blocked",
				revision,
				...network,
			});
		const first = at(1);
		hostLine(1, "registry.yarnpkg.com");
		row(1, 1, {
			overflow: 0,
			hosts: [
				{
					host: "registry.yarnpkg.com",
					port: null,
					reason: "unlisted",
					allow: "repository",
					firstAt: first - 60_000,
					lastAt: first - 20_000,
					count: 2,
				},
			],
		});
		const second = at(2);
		hostLine(2, "registry.yarnpkg.com");
		hostLine(2, "objects.githubusercontent.com");
		row(2, 3, {
			overflow: 17,
			hosts: [
				{
					host: "registry.yarnpkg.com",
					port: null,
					reason: "unlisted",
					allow: "repository",
					firstAt: second - 90_000,
					lastAt: second - 8_000,
					count: 6,
				},
				{
					host: "objects.githubusercontent.com",
					port: null,
					reason: "unlisted",
					allow: "repository",
					firstAt: second - 80_000,
					lastAt: second - 30_000,
					count: 3,
				},
				{
					host: "api.segment.io",
					port: 443,
					reason: "machine_policy",
					allow: "machine",
					machineNames: ["studio-mac"],
					firstAt: second - 70_000,
					lastAt: second - 12_000,
					count: 4,
				},
				{
					host: "169.254.169.254",
					port: 80,
					reason: "private",
					allow: "never",
					firstAt: second - 60_000,
					lastAt: second - 50_000,
					count: 2,
				},
				{
					host: "10.0.3.7",
					port: 5432,
					reason: "private",
					allow: "never",
					firstAt: second - 55_000,
					lastAt: second - 54_000,
					count: 1,
				},
				{
					host: "smtp.mailgun.org",
					port: 25,
					reason: "provider",
					allow: "never",
					firstAt: second - 40_000,
					lastAt: second - 40_000,
					count: 1,
				},
				{
					host: null,
					port: null,
					reason: "malformed",
					allow: "never",
					firstAt: second - 30_000,
					lastAt: second - 30_000,
					count: 1,
				},
			],
		});
	}

	function seed(world: World): void {
		const start = realNow();
		const history = (
			id: string,
			title: string,
			profile: SessionSummary["profile"],
			ago: number,
			turns: Array<{ text: string; script: ScriptName; effort?: string }>,
			extra: {
				repoUrl?: string;
				sandbox?: SessionSummary["sandbox"];
				model?: string;
				repository?: SessionRepository;
				pull?: Pick<PullRequestInfo, "number" | "state"> & { hoursAgo: number; clean?: boolean; branch?: string };
				machine?: NonNullable<MockSession["machine"]> & { machineId: string };
			} = {},
		): MockSession => {
			clock = start - ago;
			const session = addSession(world, {
				id,
				title,
				titled: true,
				profile,
				model: extra.model ?? (MODELS[0] as string),
				repoUrl: extra.repoUrl ?? null,
				repository: githubOn ? extra.repository : undefined,
			});
			if (extra.machine) {
				// Before its turns play: they say which sandbox they ran in.
				session.summary = { ...session.summary, place: { kind: "machine", machineId: extra.machine.machineId } };
				session.machine = { profile: extra.machine.profile, reach: extra.machine.reach };
			}
			let at = start - ago;
			for (const turn of turns) {
				const steps = plan(world, session, { text: turn.text, effort: turn.effort }, SCRIPTS[turn.script]);
				playInstantly(steps, at);
				at = (session.timeline.at(-1)?.at ?? at) + 40_000;
			}
			clock = null;
			if (session.pauseTimer !== null) cancel(session.pauseTimer);
			const sandbox = extra.sandbox ?? (turns.length === 0 ? "none" : "paused");
			session.summary = { ...session.summary, sandbox };
			const repository = session.summary.repository;
			if (repository && extra.pull) {
				// Pushed earlier: the pull request is there, and what was pushed then no longer differs from the last commit.
				const branch = extra.pull.branch ?? branchFor(session);
				const pushedAt = start - extra.pull.hoursAgo * HOUR;
				session.pushed = true;
				session.pushedHead = hex(40);
				const verified = verifiedWords(session.verified);
				session.summary = {
					...session.summary,
					pullRequest: {
						number: extra.pull.number,
						url: `${repository.url}/pull/${extra.pull.number}`,
						state: extra.pull.state,
						title,
						branch,
						base: repository.branch,
						pushedAt,
						verified,
					},
				};
				if (extra.pull.clean) session.files.clear();
				session.timeline.push({
					seq: ++session.seq,
					at: pushedAt,
					turn: session.summary.turns,
					kind: "platform",
					level: "info",
					text: `Opened pull request #${extra.pull.number} in ${repository.owner}/${repository.name} from ${branch}, with 1 file. Its description reports: ${verified}.`,
				});
			}
			return session;
		};

		// Checks are saved for acme/harbor, before its agents' turns are played: each turn's closing item says what they came to. One of them
		// has file patterns, and so does not apply to what the mock's turns change.
		world.checks.set(7101, {
			checks: [
				{ name: "test", command: "npm test" },
				{ name: "types", command: "npm run typecheck", when: ["src/**/*.ts"], timeoutSeconds: 300 },
			],
			updatedAt: start - 3 * 24 * HOUR - 40 * MINUTE,
		});
		history("scratch", "New agent", "docker-windlass-sandbox", 5 * 24 * HOUR, []).titled = false;
		history(
			"deps",
			"Upgrade the dependencies",
			"docker-hardened",
			3 * 24 * HOUR,
			[
				{
					text: "Upgrade the dependencies to their latest minor versions and crash if anything breaks.",
					script: "crash",
				},
			],
			{ sandbox: "none", repoUrl: "https://github.com/acme/harbor.git" },
		);
		history("suite", "Run the whole test suite", "docker-windlass-sandbox", 2 * 24 * HOUR, [
			{ text: "Run the whole test suite and fix the failing test.", script: "cancelled", effort: "medium" },
		]);
		history(
			"changelog",
			"Tidy the changelog",
			"docker-windlass-sandbox",
			26 * HOUR,
			[{ text: "Tidy the changelog for the release.", script: "usageLimit" }],
			{
				model: MODELS[1],
				repository: sessionRepository("acme", "lighthouse-docs"),
				pull: { number: 7, state: "merged", hoursAgo: 25, clean: true },
			},
		);
		history(
			"checks",
			"Make add() pass its checks",
			"docker-windlass-sandbox",
			21 * HOUR,
			[{ text: "Fix the failing test.", script: "checks", effort: "high" }],
			{
				repository: sessionRepository("acme", "harbor", "release/2.4"),
				pull: { number: 38, state: "open", hoursAgo: 20 },
			},
		);
		// A planned feature's pull request and one of its parts', on the branches the platform names by item id
		// (server/src/github/feature.ts): the panel and the pull request list say them in words (lib/branch.ts).
		const FEATURE_BRANCH = "windlass/feature-i_be50000068103000";
		history(
			"feature-pr",
			"Dark mode for the settings pages",
			"docker-windlass-sandbox",
			13 * HOUR,
			[{ text: "Hand the dark mode feature over.", script: "checks" }],
			{
				sandbox: "none",
				repository: sessionRepository("acme", "harbor"),
				pull: { number: 81, state: "draft", hoursAgo: 12, branch: FEATURE_BRANCH },
			},
		);
		history(
			"feature-part",
			"Theme tokens for dark mode",
			"docker-windlass-sandbox",
			15 * HOUR,
			[{ text: "Add the dark theme's tokens.", script: "checks" }],
			{
				sandbox: "none",
				repository: sessionRepository("acme", "harbor", FEATURE_BRANCH),
				pull: {
					number: 79,
					state: "open",
					hoursAgo: 14,
					branch: `${FEATURE_BRANCH}-theme-tokens-i_12ea000059a23040`,
				},
			},
		);
		// Recorded in Auto, where Windlass asks before a command runs outside its sandbox: on the profile that has Auto, so the panel says what the run did.
		history("unattended", "Run a command with nobody to approve it", "docker-windlass-sandbox", 3 * HOUR, [
			{ text: "check the sandbox", script: "refused" },
		]);
		history("probe", "Check what the sandbox allows", "docker-windlass-sandbox", 2 * HOUR, [
			{ text: "check the sandbox", script: "sandboxed" },
		]);
		const tide = history(
			"add-test",
			"Fix the failing add test",
			"docker-windlass-sandbox",
			38 * MINUTE,
			[
				{ text: "The add test is failing. Find out why and fix it.", script: "fix", effort: "low" },
				{ text: "What is 1 + 1, to be sure?", script: "answer" },
			],
			{ sandbox: "running", repository: sessionRepository("ada", "tide-tables") },
		);
		if (options.blocked) seedBlocked(tide);

		// Three agents that pushed their own branch, or asked to, on acme/signal-flags: one pushed with no pull request open,
		// so "Open pull request" opens one from what is there; one pushed and then changed more; one named main, and was refused.
		history(
			"agent-pushed",
			"Fix add() and push the branch",
			"docker-windlass-sandbox",
			50 * MINUTE,
			[
				{
					text: "The add test is failing. Fix it, bring in what changed on main, and push.",
					script: "agentPush",
					effort: "low",
				},
			],
			{ repository: sessionRepository("acme", "signal-flags") },
		);
		const fromEnvironment = history(
			"agent-pushed-more",
			"Push the fix, then add a test",
			"docker-windlass-sandbox",
			75 * MINUTE,
			[
				{ text: "The add test is failing. Fix it and push.", script: "agentPush", effort: "low" },
				{ text: "Add a test for adding zero.", script: "steps" },
			],
			{ repository: sessionRepository("acme", "signal-flags") },
		);
		// Its sandbox started from acme/signal-flags's validated environment here (mock-environments.ts).
		fromEnvironment.summary = {
			...fromEnvironment.summary,
			environment: {
				commit: "4f1c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39",
				validatedAt: start - 9 * HOUR + 4 * MINUTE,
				checks: 2,
			},
		};
		history(
			"push-refused",
			"Fix add() and push it to main",
			"docker-windlass-sandbox",
			90 * MINUTE,
			[{ text: "The add test is failing. Fix it and push it to main.", script: "agentPushRefused", effort: "low" }],
			{ repository: sessionRepository("acme", "signal-flags") },
		);

		// `?resume=1`: a turn paused by a server restart, with a message held for it, and one that resumed after a restart and finished.
		if (options.resume) {
			const resumed = history(
				"resumed",
				"Bump the parser and fix the tests",
				"docker-windlass-sandbox",
				30 * MINUTE,
				[{ text: "Fix the failing test.", script: "fix", effort: "low" }],
				{ sandbox: "running" },
			);
			const ended = resumed.timeline.findLastIndex(item => item.kind === "turn.ended");
			if (ended > 0) {
				const turn = resumed.timeline[ended]!.turn;
				const at = resumed.timeline[ended - 1]!.at;
				const rows: TimelineItem[] = [
					{
						seq: 0,
						at,
						turn,
						kind: "platform",
						level: "info",
						code: "turn_paused",
						text: "The server is restarting; this turn will resume by itself.",
					},
					{
						seq: 0,
						at: at + 42_000,
						turn,
						kind: "platform",
						level: "info",
						code: "turn_resumed",
						text: "Resumed after a server restart (the turn was paused 42 seconds).",
					},
				];
				resumed.timeline.splice(ended - 1, 0, ...rows);
				resumed.timeline.forEach((item, index) => {
					item.seq = index + 1;
				});
				resumed.seq = resumed.timeline.length;
			}
			const restarting = history("restarting", "Upgrade the test runner", "docker-windlass-sandbox", 8 * MINUTE, [], {
				sandbox: "running",
			});
			const turn = 1;
			const pausedAt = start - 20_000;
			const push = (at: number, item: DistributiveOmit<TimelineItem, "seq" | "at" | "turn">) =>
				restarting.timeline.push({ ...item, seq: ++restarting.seq, at, turn } as TimelineItem);
			push(start - 3 * MINUTE, {
				kind: "user",
				text: "Upgrade the test runner to its next major version and fix what breaks.",
				model: restarting.summary.model,
				effort: "medium",
			});
			push(start - 3 * MINUTE + 3_000, { kind: "platform", level: "info", text: startNote(restarting) });
			push(pausedAt, {
				kind: "platform",
				level: "info",
				code: "turn_paused",
				text: "The server is restarting; this turn will resume by itself.",
			});
			push(start - 5_000, {
				kind: "user",
				text: "Keep the old config file as a backup.",
				model: restarting.summary.model,
				effort: "medium",
				steer: true,
				held: true,
			});
			restarting.summary = {
				...restarting.summary,
				turns: turn,
				status: "paused",
				paused: { reason: "restart", since: pausedAt, held: 1 },
				updatedAt: start - 5_000,
			};
		}

		// One agent waits on a question when the user arrives: it asked half a minute ago.
		const asking = history(
			"headers",
			"Check the site's response headers",
			"docker-windlass-sandbox",
			14 * MINUTE,
			[{ text: "What is 1 + 1, to be sure?", script: "answer" }],
			{ sandbox: "running" },
		);
		playInstantly(
			plan(
				world,
				asking,
				{ text: "Fetch the response headers of example.com and tell me what server it runs.", effort: "low" },
				SCRIPTS.network,
			),
			start - 30_000,
		);
		clock = null;

		// One agent asked for a secret it lacks (`request_secret`) before its turn ended: the request stays open until it is answered or a turn starts.
		const mailing = history(
			"release-mail",
			"Email the release notes",
			"docker-windlass-sandbox",
			9 * MINUTE,
			[
				{
					text: "After a release is published, email its notes to the subscribers list. Test it against Resend.",
					script: "steps",
					effort: "low",
				},
			],
			{ sandbox: "paused", repository: sessionRepository("acme", "harbor") },
		);
		const mailEnd = mailing.timeline.findLastIndex(item => item.kind === "turn.ended");
		if (mailEnd > 0) {
			const ended = mailing.timeline[mailEnd]!;
			const secretRequest = {
				id: String(ended.turn),
				name: "RESEND_API_KEY",
				why: "The release script sends the notes through Resend, and its integration test calls the API. Without the key the test is skipped, so the email step would ship unverified.",
				notice:
					"This request came through the agent's host tool connection.\nIf supplied, this will be saved for this repository with agent scope.",
			};
			mailing.timeline.splice(mailEnd, 0, {
				seq: 0,
				at: ended.at - 2_000,
				turn: ended.turn,
				kind: "platform",
				level: "info",
				text: `A secret was requested for ${secretRequest.name}.\n${secretRequest.notice}`,
				secretRequest,
			});
			mailing.timeline.forEach((item, index) => {
				item.seq = index + 1;
			});
			mailing.seq = mailing.timeline.length;
			mailing.secretRequest = secretRequest;
		}
		// And one with no repository: what it is given is saved for the account, so every agent of the person would have it.
		const pinging = history(
			"build-ping",
			"Post the nightly build result",
			"docker-windlass-sandbox",
			7 * MINUTE,
			[
				{
					text: "Write a script that posts the nightly build's result to our Slack channel, and try it once.",
					script: "steps",
					effort: "low",
				},
			],
			{ sandbox: "paused" },
		);
		const pingEnd = pinging.timeline.findLastIndex(item => item.kind === "turn.ended");
		if (pingEnd > 0) {
			const ended = pinging.timeline[pingEnd]!;
			const secretRequest = {
				id: String(ended.turn),
				name: "SLACK_WEBHOOK_URL",
				why: "The script posts to the channel's incoming webhook. I need its URL to try the post once.",
				notice:
					"This request came through the agent's host tool connection.\nIf supplied, this will be saved for your account: every agent of yours will have it.",
			};
			pinging.timeline.splice(pingEnd, 0, {
				seq: 0,
				at: ended.at - 2_000,
				turn: ended.turn,
				kind: "platform",
				level: "info",
				text: `A secret was requested for ${secretRequest.name}.\n${secretRequest.notice}`,
				secretRequest,
			});
			pinging.timeline.forEach((item, index) => {
				item.seq = index + 1;
			});
			pinging.seq = pinging.timeline.length;
			pinging.secretRequest = secretRequest;
		}

		// One agent is at work when the user arrives: a second turn, a long build, played slowly.
		const building = history(
			"harbor-build",
			"Check the release build",
			"docker-windlass-sandbox",
			6 * MINUTE,
			[{ text: "Fix the failing test.", script: "steps" }],
			{
				sandbox: "running",
				repoUrl: "https://github.com/acme/harbor.git",
				repository: sessionRepository("acme", "harbor"),
			},
		);
		play(
			building,
			plan(
				world,
				building,
				{ text: "Run the full build and the tests, and tell me if they pass.", effort: "medium" },
				{ ...SCRIPTS.build, stretch: 7 },
			),
		);

		// One agent on the user's machine "nas", which finds it as `?machineSession=` says; when its machine was removed, it was another one.
		if (machineSessionSeeded) {
			const removed = machineSession === "removed";
			const reach: NonNullable<MockSession["machine"]>["reach"] = removed
				? { state: "removed", since: start - 2 * HOUR }
				: { state: "answering", since: start - 25 * MINUTE };
			const machine = {
				machineId: removed ? "m_old" : "m_nas",
				profile: mockMachineProfiles(removed ? "old-laptop" : "nas")[0] as SandboxProfile,
				reach,
			};
			const onNas = history(
				"nas-tests",
				"Run the tests on my machine",
				"docker-windlass-sandbox",
				25 * MINUTE,
				[{ text: "The add test is failing. Find out why and fix it.", script: "fix", effort: "low" }],
				{ sandbox: machineSession === "answering" ? "running" : "paused", machine },
			);
			// A second turn, paused when the machine went away mid-turn, with a message held for it (WLP_TURN_RESUME).
			if (machineSession === "paused") {
				const turn = onNas.summary.turns + 1;
				const pausedAt = start - 9 * MINUTE;
				const push = (at: number, item: DistributiveOmit<TimelineItem, "seq" | "at" | "turn">) =>
					onNas.timeline.push({ ...item, seq: ++onNas.seq, at, turn } as TimelineItem);
				push(start - 14 * MINUTE, {
					kind: "user",
					text: "Run the full build and the tests, and tell me if they pass.",
					model: onNas.summary.model,
					effort: "medium",
				});
				push(start - 14 * MINUTE + 4_000, { kind: "platform", level: "info", text: "Resuming the paused sandbox" });
				push(pausedAt, {
					kind: "platform",
					level: "info",
					code: "turn_paused",
					text: "Your machine “nas” went offline, so this turn is paused. It resumes by itself when the machine is back.",
				});
				push(start - 2 * MINUTE, {
					kind: "user",
					text: "When it is back, also run the lint step.",
					model: onNas.summary.model,
					effort: "medium",
					steer: true,
					held: true,
				});
				onNas.summary = {
					...onNas.summary,
					turns: turn,
					status: "paused",
					paused: { reason: "machine", since: pausedAt, held: 1 },
					updatedAt: start - 2 * MINUTE,
				};
			}
			// A turn under way, which waits for the machine while it does not answer (`blipMachine`).
			if (machineSession === "not_answering") {
				onNas.summary = { ...onNas.summary, sandbox: "running" };
				play(
					onNas,
					plan(
						world,
						onNas,
						{ text: "Run the full build and the tests, and tell me if they pass.", effort: "medium" },
						{ ...SCRIPTS.build, stretch: 40 },
					),
				);
			}
		}

		// A Claude Code agent on "nas", which offers it: one turn that read, edited and tested, with a plan, and asked before the tests.
		if (machineSessionSeeded && machineSession !== "removed") {
			clock = start - 12 * MINUTE;
			const claude = addSession(world, {
				id: "nas-claude",
				title: "Add the test command to the README",
				titled: true,
				profile: "docker-hardened",
				harness: "claude",
				modes: { mode: "auto", availableModes: [...CLAUDE_LAUNCH_MODES] },
				model: "default",
				repoUrl: null,
			});
			claude.summary = { ...claude.summary, place: { kind: "machine", machineId: "m_nas" }, harnessModels: null };
			claude.machine = {
				profile: mockMachineProfiles("nas")[1] as SandboxProfile,
				reach: { state: "answering", since: start - 12 * MINUTE },
			};
			playInstantly(
				acpTurn(
					world,
					claude,
					{ text: "Read the README and add a line to it saying what the tests command is; run the tests." },
					workScript(claude),
					"allow-once",
				),
				start - 12 * MINUTE,
			);
			clock = null;
			if (claude.pauseTimer !== null) cancel(claude.pauseTimer);
			claude.summary = { ...claude.summary, sandbox: "paused" };
		}

		// The user saved a setup command for acme/harbor some days ago: the launch form and the panel show it.
		world.setups.set(7101, { command: "npm ci", updatedAt: start - 3 * 24 * HOUR - 50 * MINUTE });
		// acme/signal-flags has a setup command and no secrets: its prepared environments are the mock's (mock-environments.ts).
		world.setups.set(7106, { command: "corepack pnpm install --frozen-lockfile", updatedAt: start - 5 * 24 * HOUR });
		// And four secrets: each scope under a name that looks like a credential and under one that does not, covering both kinds of names.
		world.secrets.set(
			7101,
			new Map([
				["NPM_TOKEN", { scope: "setup" as const, updatedAt: start - 3 * 24 * HOUR - 48 * MINUTE }],
				["SENTRY_DSN", { scope: "setup" as const, updatedAt: start - 26 * HOUR }],
				["DEPLOY_KEY", { scope: "agent" as const, updatedAt: start - 5 * HOUR }],
				["PREVIEW_HOST", { scope: "agent" as const, updatedAt: start - 40 * MINUTE }],
			]),
		);

		if (githubOn) {
			// New agents on acme/harbor start in the hardened container, on the second model: the launch form shows both once it is picked.
			world.defaults.set(7101, {
				profile: "docker-hardened",
				model: MODELS[1] as string,
				updatedAt: start - 2 * 24 * HOUR,
			});
			// ada/tide-tables has a default model this deployment stopped offering: its page says so, and the launch form leaves it out.
			world.defaults.set(7102, { profile: null, model: "gpt-5.5-terra", updatedAt: start - 40 * 24 * HOUR });
			// acme/quay has a secret and no agent: the list of agents names it under the groups.
			world.secrets.set(7105, new Map([["QUAY_TOKEN", { scope: "setup" as const, updatedAt: start - 6 * 24 * HOUR }]]));
			world.names.set(7105, "acme/quay");
			// acme/old-pier is no longer among the repositories the connection covers. What was saved for it is still there.
			world.setups.set(7190, { command: "make deps", updatedAt: start - 60 * 24 * HOUR });
			world.secrets.set(7190, new Map([["PIER_KEY", { scope: "agent" as const, updatedAt: start - 60 * 24 * HOUR }]]));
			world.approvals.push({
				project: "github:7190",
				name: "tides",
				fingerprint: "5b0c6a19d2e7f384",
				approvedAt: start - 12 * 24 * HOUR,
				expiresAt: start - 12 * 24 * HOUR + APPROVAL_MS,
			});
			world.names.set(7190, "acme/old-pier");
		}

		// What the user keeps for their account: two MCP servers of their own, and two secrets. One server reads a secret
		// that is saved and runs; the other reads one that is not, and does not start. DEPLOY_KEY is a name acme/harbor has
		// a secret of its own for, so there the repository's is used.
		if (options.account === "seeded") {
			world.account.servers.set("issues", {
				definition: {
					command: "npx",
					args: ["-y", "@acme/issues-mcp", "--stdio"],
					env: { ISSUES_TOKEN: "${ISSUES_TOKEN}" },
				},
				unasked: true,
				updatedAt: start - 9 * 24 * HOUR,
			});
			world.account.servers.set("wiki", {
				definition: { url: "https://wiki.acme.example/mcp", headers: { Authorization: "Bearer ${WIKI_TOKEN}" } },
				unasked: false,
				updatedAt: start - 2 * 24 * HOUR,
			});
			world.account.secrets.set("ISSUES_TOKEN", { scope: "agent", updatedAt: start - 9 * 24 * HOUR });
			world.account.secrets.set("DEPLOY_KEY", { scope: "setup", updatedAt: start - 30 * 24 * HOUR });
			// The sessions that have a sandbox had a turn since: their panels list the servers as that turn found them.
			for (const session of world.sessions.values())
				if (session.summary.sandbox !== "none" && session.summary.turns > 0) knowPersonal(world, session);
		}

		// acme/harbor names MCP servers. The user approved "harbor" three days ago in one session, so the other
		// started it unasked; "docs" was left for later, and "tracker" was approved and could not start.
		const checks = world.sessions.get("checks");
		/** The user's own servers a session already knows of: they stand after its project's. */
		const own = (session: MockSession) => session.servers.filter(server => server.origin === "user");
		if (checks) {
			const project = mockProject(checks.summary).key;
			const approvedAt = start - 3 * 24 * HOUR - 40 * MINUTE;
			const harbor: MockKnown = {
				name: "harbor",
				subject: "python3 tools/harbor_mcp.py",
				remote: false,
				file: SERVER_FILE,
				state: "running",
				tools: 2,
				reason: null,
				fingerprint: "81498df752b8ef7d",
				at: start - 21 * HOUR,
			};
			world.approvals.push({
				project,
				name: "harbor",
				fingerprint: "81498df752b8ef7d",
				approvedAt,
				expiresAt: approvedAt + APPROVAL_MS,
			});
			world.approvals.push({
				project,
				name: "tracker",
				fingerprint: "c07b1e5a94d3f268",
				approvedAt: start - 21 * HOUR,
				expiresAt: start - 21 * HOUR + APPROVAL_MS,
			});
			checks.startedServers.add("81498df752b8ef7d");
			const mine = own(checks);
			checks.servers = [
				harbor,
				{
					name: "docs",
					subject: "https://docs.acme.example/mcp",
					remote: true,
					file: SERVER_FILE,
					state: "waiting",
					tools: null,
					reason: null,
					fingerprint: "e4d1a80c93f6b275",
					at: start - 21 * HOUR,
				},
				{
					name: "tracker",
					subject: "npx -y @acme/tracker-mcp --stdio --project 'Harbor 2.4'",
					remote: false,
					file: SERVER_FILE,
					state: "failed",
					tools: null,
					reason: "the environment variable TRACKER_TOKEN named in its env is not set",
					fingerprint: "c07b1e5a94d3f268",
					at: start - 21 * HOUR,
				},
			];
			checks.servers.push(...mine);
			checks.summary = { ...checks.summary, servers: { count: checks.servers.length, changedAt: start - 21 * HOUR } };
			// Launched on the same repository through the connection: the same project, and so the same approval.
			if (mockProject(building.summary).key === project) {
				building.startedServers.add("81498df752b8ef7d");
				building.servers = [{ ...harbor, at: start - 6 * MINUTE }, ...own(building)];
				building.summary = {
					...building.summary,
					servers: { count: building.servers.length, changedAt: start - 6 * MINUTE },
				};
			}
		}
	}

	// ---- setup commands of repositories -----------------------------------------------------------

	/** Why a repository can have no prepared environment, by the server's rules (user-environments.ts); null when it can. */
	function environmentInputs(world: World, repositoryId: GithubId): string | null {
		if (!world.setups.get(repositoryId)?.command)
			return "Save a setup command first: an environment is what it prepares.";
		if ((world.secrets.get(repositoryId)?.size ?? 0) > 0) return "Not available for repositories with saved secrets.";
		return null;
	}
	function setupOf(world: World, repositoryId: GithubId): RepositorySetup {
		const saved = world.setups.get(repositoryId);
		return { command: saved?.command ?? "", updatedAt: saved?.updatedAt ?? null, timeoutMs: MOCK_SETUP_LIMIT_MS };
	}

	function saveSetup(world: World, repositoryId: GithubId, raw: string): RepositorySetup {
		const command = raw.replace(/\r\n?/g, "\n").trim();
		if (command.length > MAX_SETUP_COMMAND_CHARS)
			throw new PlatformError(
				"user",
				`The setup command is ${command.length} characters long; the limit is ${MAX_SETUP_COMMAND_CHARS}. Put a longer one in a script in the repository and run that.`,
				{ reason: "bad_setup_command" },
			);
		if (command === "") world.setups.delete(repositoryId);
		else world.setups.set(repositoryId, { command, updatedAt: now() });
		return setupOf(world, repositoryId);
	}

	// ---- checks of repositories -------------------------------------------------------------------

	function checksOf(world: World, repositoryId: GithubId): RepositoryChecks {
		const saved = world.checks.get(repositoryId);
		return { checks: saved?.checks ?? [], updatedAt: saved?.updatedAt ?? null };
	}

	/** Saves as the server does (server/src/repository-checks.ts): the same refusals in the same words, and the list whole. */
	function saveChecks(world: World, repositoryId: GithubId, raw: RepositoryCheck[]): RepositoryChecks {
		const refuse = (message: string): never => {
			throw new PlatformError("user", message, { reason: "bad_checks" });
		};
		if (raw.length > MAX_CHECKS_PER_REPOSITORY)
			refuse(`A repository can have ${MAX_CHECKS_PER_REPOSITORY} checks; this list has ${raw.length}.`);
		const checks: RepositoryCheck[] = [];
		for (const [index, input] of raw.entries()) {
			const name = input.name.trim();
			const which = name === "" ? `Check ${index + 1}` : `The check "${name.slice(0, MAX_CHECK_NAME_CHARS)}"`;
			if (name === "") refuse(`${which} needs a name.`);
			if (name.length > MAX_CHECK_NAME_CHARS || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))
				refuse(
					`${which} needs a name of letters, digits, "_", "." and "-" that starts with a letter or a digit, at most ${MAX_CHECK_NAME_CHARS} characters.`,
				);
			if (checks.some(check => check.name === name)) refuse(`Two checks are named "${name}". Give each its own name.`);
			const command = input.command.replace(/\r\n?/g, "\n").trim();
			if (command === "") refuse(`${which} needs a command.`);
			if (command.length > MAX_SETUP_COMMAND_CHARS)
				refuse(
					`${which} has a command of ${command.length} characters; the limit is ${MAX_SETUP_COMMAND_CHARS}. Put a longer one in a script in the repository and run that.`,
				);
			const seconds = input.timeoutSeconds;
			if (seconds !== undefined && (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_CHECK_TIMEOUT_SECONDS))
				refuse(`${which} may run for 1 to ${MAX_CHECK_TIMEOUT_SECONDS} seconds.`);
			const when = (input.when ?? []).map(pattern => pattern.trim()).filter(pattern => pattern !== "");
			const negated = when.find(pattern => pattern.startsWith("!"));
			if (negated !== undefined) refuse(`${which} has the file pattern "${negated}": a pattern cannot start with "!".`);
			checks.push({
				name,
				command,
				...(seconds === undefined ? {} : { timeoutSeconds: seconds }),
				...(when.length === 0 ? {} : { when }),
				...(input.showOutput === true ? { showOutput: true } : {}),
			});
		}
		if (checks.length === 0) world.checks.delete(repositoryId);
		else world.checks.set(repositoryId, { checks, updatedAt: now() });
		return checksOf(world, repositoryId);
	}

	// ---- secrets of repositories ------------------------------------------------------------------

	/** A name the agent asked for that is saved now, for the repository or the account, in the server's words (user.ts `requestedSecretConflict`). */
	function requestedSecretConflict(
		world: World,
		repositoryId: GithubId | null,
		name: string,
		reader: "agent" | "person" = "agent",
	): string | null {
		const source =
			repositoryId !== null && world.secrets.get(repositoryId)?.has(name)
				? "repository"
				: world.account.secrets.has(name)
					? "account"
					: null;
		if (!source) return null;
		return reader === "agent"
			? `${name} already exists for this ${source}; it is not offered to agents in this scope. Ask your person to change it under Secrets if you need it.`
			: `${name} already exists for this ${source}, so nothing was saved. To let agents use it, change its scope under Secrets.`;
	}

	function secretsOf(world: World, repositoryId: GithubId, profileId: SandboxProfileId): RepositorySecrets {
		const profile = profiles.find(item => item.id === profileId);
		if (!profile) throw new PlatformError("user", "Choose one of the listed sandboxes.", { reason: "bad_input" });
		const saved = [
			...(world.secrets.get(repositoryId) ?? new Map<string, { scope: SecretScope; updatedAt: number }>()).entries(),
		].sort(([a], [b]) => (a < b ? -1 : 1));
		return {
			profile: profile.id,
			secrets: saved.map(([name, secret]) => ({
				name,
				scope: secret.scope,
				updatedAt: secret.updatedAt,
				reach: mockSecretReach(secret.scope, profile),
				...(world.account.secrets.has(name) ? { account: true } : {}),
			})),
		};
	}

	/** Saves as the server does (server/src/repo-secrets.ts): the same refusals in the same words. The value is looked at and dropped. */
	function saveSecret(
		world: World,
		repositoryId: GithubId,
		secret: { name: string; value?: string; scope: SecretScope },
	): void {
		const { name, scope } = secret;
		checkSecretName(name);
		if (scope !== "setup" && scope !== "agent")
			throw badSecret("A secret is for the setup command and MCP servers, or for the agent's commands as well.");
		const saved = world.secrets.get(repositoryId) ?? new Map<string, { scope: SecretScope; updatedAt: number }>();
		if (secret.value === undefined) {
			if (!saved.has(name))
				throw new PlatformError("user", `No secret named ${name} is saved for this repository.`, {
					reason: "secret_not_found",
				});
		} else {
			checkSecretValue(secret.value);
			if (!saved.has(name) && saved.size >= MAX_SECRETS_PER_REPOSITORY)
				throw new PlatformError(
					"user",
					`A repository can have at most ${MAX_SECRETS_PER_REPOSITORY} secrets. Delete one first.`,
					{ reason: "too_many_secrets" },
				);
		}
		saved.set(name, { scope, updatedAt: now() });
		world.secrets.set(repositoryId, saved);
	}

	const badSecret = (message: string) => new PlatformError("user", message, { reason: "bad_secret" });

	/** A secret's name, a repository's or the account's, as the server takes it (`cleanSecretName`). */
	function checkSecretName(name: unknown): asserts name is string {
		if (typeof name !== "string" || name === "") throw badSecret("A secret needs a name.");
		if (name.length > MAX_SECRET_NAME_CHARS)
			throw badSecret(`A secret's name can be at most ${MAX_SECRET_NAME_CHARS} characters long.`);
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
			throw badSecret(
				"A secret's name is an environment variable's: letters, digits and underscores, not starting with a digit.",
			);
		if (MOCK_RESERVED.test(name))
			throw badSecret(`${name} cannot be a secret's name: the sandbox or Windlass relies on a variable of that name.`);
	}

	/** A secret's value as the server takes it (`cleanSecretValue`). It is looked at and dropped. */
	function checkSecretValue(raw: unknown): void {
		if (typeof raw !== "string") throw badSecret("A secret's value must be text.");
		const value = raw.replace(/\r\n?/g, "\n");
		if (value.trim().length < MIN_SECRET_VALUE_CHARS)
			throw badSecret(
				`A secret's value must be at least ${MIN_SECRET_VALUE_CHARS} characters long: a shorter one could not be taken out of what the platform shows.`,
			);
		const bytes = new TextEncoder().encode(value).length;
		if (bytes > MAX_SECRET_VALUE_BYTES)
			throw badSecret(
				`A secret's value can be at most ${MAX_SECRET_VALUE_BYTES.toLocaleString("en-US")} bytes long; this one is ${bytes.toLocaleString("en-US")}.`,
			);
	}

	// ---- a repository's page ---------------------------------------------------------------------

	/** As the server names a repository without asking GitHub: by the newest session on it, then by what was noted when something was saved. */
	function repositoryNameOf(world: World, repositoryId: GithubId): string | null {
		const newest = listOf(world).find(summary => summary.repository?.id === repositoryId)?.repository;
		return newest ? `${newest.owner}/${newest.name}` : (world.names.get(repositoryId) ?? null);
	}

	/** As the server does when something is saved for a repository nothing names yet: GitHub is asked what it is called, where the connection covers it. */
	function nameAtSave(world: World, repositoryId: GithubId): void {
		if (repositoryNameOf(world, repositoryId) !== null || !githubOn || !world.github) return;
		const found = GITHUB_REPOSITORIES.find(repository => repository.id === repositoryId);
		if (found) world.names.set(repositoryId, `${found.owner}/${found.name}`);
	}

	function defaultsOf(world: World, repositoryId: GithubId): RepositoryDefaults {
		const saved = world.defaults.get(repositoryId);
		const enabled = world.screenshotsEnabled.get(repositoryId);
		const updatedAt = saved || enabled !== undefined ? Math.max(saved?.updatedAt ?? 0, enabled ?? 0) : null;
		const size = hostedSizes.get(repositoryId) ?? null;
		return {
			place: null,
			harness: null,
			machineProfile: null,
			placeFallback: null,
			...saved,
			...world.autonomy.get(repositoryId),
			screenshots: enabled !== undefined,
			profile: saved?.profile ?? null,
			model: saved?.model ?? null,
			hostedSize: size,
			updatedAt: Math.max(updatedAt ?? 0, world.autonomy.get(repositoryId)?.updatedAt ?? 0) || (size ? now() : null),
		};
	}

	function repositoryViewOf(world: World, repositoryId: GithubId): RepositoryView {
		const approvals = new Map<string, RepositoryApproval>();
		const mine = world.approvals
			.filter(approval => approval.project === `github:${repositoryId}` && approval.expiresAt > now())
			.sort((a, b) => b.approvedAt - a.approvedAt);
		for (const approval of mine) {
			const listed = approvals.get(approval.name);
			if (listed) listed.definitions += 1;
			else
				approvals.set(approval.name, {
					name: approval.name,
					approvedAt: approval.approvedAt,
					expiresAt: approval.expiresAt,
					definitions: 1,
				});
		}
		let assessment = world.readiness.get(repositoryId);
		if (!assessment && world.github && GITHUB_REPOSITORIES.some(r => r.id === repositoryId)) {
			assessment = { at: now(), finished: false, weekly: false };
			world.readiness.set(repositoryId, assessment);
		}
		const hasSetup = world.setups.has(repositoryId);
		const hasChecks = !!world.checks.get(repositoryId)?.checks.length;
		const finished = assessment?.finished;
		const latest = assessment
			? setupReport(
					[
						{
							id: "setup",
							pass: hasSetup ? finished || null : false,
							reason: !hasSetup
								? "No setup command is saved."
								: finished
									? "The latest build installed the project with one command."
									: "Setup command saved. Finish setup to check that it works.",
						},
						{
							id: "checks",
							pass: hasChecks ? finished || null : false,
							reason: !hasChecks
								? "No checks are saved."
								: finished
									? "Both saved checks passed in 43 seconds."
									: "Checks saved. Finish setup to check their results and time.",
						},
						{
							id: "guide",
							pass: finished || null,
							reason: finished
								? "The root guide names the working setup and check commands."
								: "AGENTS.md found. Finish setup to check its instructions.",
						},
						{ id: "areas", pass: false, reason: "src/services has 78 source files and no guide." },
						{ id: "templates", pass: true, reason: "Both templates are present." },
						{ id: "size", pass: true, reason: "The largest source file has 680 lines." },
						{ id: "ci", pass: true, reason: "The test workflow runs on pull requests." },
						{ id: "secrets", pass: false, reason: "Environment files are ignored. No secret scan was found." },
					],
					assessment.at,
					{
						at: assessment.at,
						branch: "main",
						checked: 50,
						green: 47,
						flaky: [{ name: "e2e (macos)", count: 2 }],
						reverts: 0,
						redMerges: 1,
						hasCi: true,
					},
					items.records(world.profile.uid, repositoryId),
				)
			: null;
		const rows = world.offers.get(repositoryId) ?? [];
		const policy = applyOffers(defaultsOf(world, repositoryId), latest?.record, rows);
		for (const r of rows) if (policy.expired.includes(r.offer)) r.off = 1;
		return {
			id: repositoryId,
			name: repositoryNameOf(world, repositoryId),
			guideCheck: world.guideChecks.get(repositoryId) ?? { enabled: true, result: null },
			knowledge: world.knowledge.get(repositoryId) ?? { notes: [], publication: null },
			readiness: {
				latest,
				switchNote: policy.switchNote,
				weekly: assessment?.weekly ?? false,
				run: finished ? "finished" : "new",
				error: null,
			},
			defaults: policy.defaults,
			approvals: [...approvals.values()],
			forgetting: MOCK_FORGETTING,
			saved: {
				setup: world.setups.has(repositoryId),
				secrets: world.secrets.get(repositoryId)?.size ?? 0,
				checks: world.checks.get(repositoryId)?.checks.length ?? 0,
				network: world.network.get(repositoryId)?.entries.length ?? 0,
			},
		};
	}

	/** What the demo's hosted sandboxes reach anyway: a deployment with WLP_E2B_NETWORK=restricted and the default presets. */
	// Model calls go through the platform's model relay, so the model provider is not among them.
	const MOCK_HOSTED = {
		mode: "restricted" as const,
		hosts: [
			"codeload.github.com",
			"files.pythonhosted.org",
			"github.com",
			"objects.githubusercontent.com",
			"pypi.org",
			"raw.githubusercontent.com",
			"registry.npmjs.org",
			"registry.yarnpkg.com",
			"release-assets.githubusercontent.com",
		],
	};

	/** A repository's network list as the server answers it (server/src/repository-network.ts). */
	function networkOf(world: World, repositoryId: GithubId): RepositoryNetwork {
		const kept = world.network.get(repositoryId);
		const entries = kept?.entries ?? [];
		const hosts = expandEntries(entries);
		const allowed = new Set([...hosts, ...MOCK_HOSTED.hosts]);
		return {
			entries: [...entries],
			hosts,
			updatedAt: kept?.updatedAt ?? null,
			requests: (kept?.requests ?? []).filter(request => !allowed.has(request.host)),
			presets: networkPresets(),
			hosted: { mode: MOCK_HOSTED.mode, hosts: [...MOCK_HOSTED.hosts] },
			limit: networkLimit(MOCK_HOSTED.hosts),
		};
	}

	function saveNetworkList(world: World, repositoryId: GithubId, raw: string[]): RepositoryNetwork {
		let entries: string[];
		try {
			entries = cleanEntries(raw, MOCK_HOSTED.hosts);
		} catch (error) {
			if (error instanceof NetworkProblem) throw new PlatformError("user", error.message, { reason: "bad_network" });
			throw error;
		}
		const kept = world.network.get(repositoryId) ?? { entries: [], updatedAt: null, requests: [] };
		const hosts = new Set(expandEntries(entries));
		world.network.set(repositoryId, {
			entries,
			updatedAt: now(),
			requests: kept.requests.filter(request => !hosts.has(request.host)),
		});
		return networkOf(world, repositoryId);
	}

	/** Saves as the server does (server/src/repository-defaults.ts): the same refusals in the same words, and only the fields that are named. */
	/** Each repository's saved hosted size. */
	const hostedSizes = new Map<GithubId, HostedSize>();
	function saveDefaults(
		world: World,
		machines: MachineSummary[],
		repositoryId: GithubId,
		{
			offer,
			screenshots,
			hostedSize,
			autoApprovePlans,
			autoMergeSingles,
			waitForCiOnEachPart,
			...change
		}: RepositoryDefaultsPatch,
	): RepositoryDefaults {
		const rows = world.offers.get(repositoryId) ?? [];
		if (offer !== undefined) {
			const { readiness, defaults } = repositoryViewOf(world, repositoryId);
			const record = readiness.latest?.record;
			if (!record || !offered(record, defaults).includes(offer)) throw Error("This offer is no longer available.");
			world.offers.set(repositoryId, [
				...rows.filter(r => r.offer !== offer),
				{ offer, earned: record.earned[offer]!, off: 0 },
			]);
			return repositoryViewOf(world, repositoryId).defaults;
		}
		world.offers.set(
			repositoryId,
			rows.filter(r => (r.offer === "Small plans" ? autoApprovePlans : autoMergeSingles) === undefined),
		);
		if (screenshots !== undefined && typeof screenshots !== "boolean")
			throw new PlatformError("user", "Screenshots must be true or false.", { reason: "bad_input" });
		if (hostedSize !== undefined && hostedSize !== null && !isHostedSize(hostedSize))
			throw new PlatformError("user", "Choose one of the hosted sizes: Small, Medium, Large.", { reason: "bad_input" });
		const next = changedDefaults(world.defaults.get(repositoryId) ?? null, change, modelsFor(world.profile), machines);
		if (hostedSize === null) hostedSizes.delete(repositoryId);
		else if (hostedSize !== undefined) hostedSizes.set(repositoryId, hostedSize);
		if (next === null) world.defaults.delete(repositoryId);
		else world.defaults.set(repositoryId, next);
		const flags = { ...world.autonomy.get(repositoryId), updatedAt: now() };
		for (const [key, value] of Object.entries({ autoApprovePlans, autoMergeSingles, waitForCiOnEachPart }) as Array<
			[keyof Omit<RepositoryAutonomy, "mergeKinds">, boolean | undefined]
		>) {
			if (value === true) flags[key] = true;
			else if (value === false) delete flags[key];
		}
		if (flags.autoApprovePlans || flags.autoMergeSingles || flags.waitForCiOnEachPart)
			world.autonomy.set(repositoryId, flags);
		else world.autonomy.delete(repositoryId);
		if (screenshots === false) world.screenshotsEnabled.delete(repositoryId);
		if (screenshots === true) world.screenshotsEnabled.set(repositoryId, now());
		return repositoryViewOf(world, repositoryId).defaults;
	}

	/** What is saved after a change, for a repository or for the account: null when nothing is left. */
	/** The models the signed-in user may choose: the plan's as it was read when the page loaded, or the stand-in for the demo and where the address says the plan could not be read. */
	const listedAt = realNow();
	function modelsFor(profile: UserProfile): ModelList {
		if (profile.demo) return mockStandInModels("demo");
		const account: ModelList = !worlds.get(profile.uid)?.planConnected
			? mockStandInModels("signed-out")
			: options.models === "unavailable"
				? mockStandInModels("unavailable")
				: {
						source: "account",
						models: MOCK_PLAN.map(model => ({ ...model, efforts: [...model.efforts] })),
						defaultModel: MODELS[0] as string,
						fetchedAt: listedAt - 12 * MINUTE,
					};
		return windlassModels(account, [...(worlds.get(profile.uid)?.account.providers.values() ?? [])]);
	}
	/** A model a client named, held against the user's list as the server holds it. */
	function checkModel(models: ModelList, model: string): void {
		const reason = modelRefusal(models, model);
		if (reason) throw new PlatformError("user", reason, { reason: "bad_model" });
	}

	function changedDefaults(
		before: SavedDefaults | null,
		change: AccountDefaultsPatch,
		models: ModelList,
		machines: MachineSummary[],
	): SavedDefaults | null {
		const saved = before ?? { profile: null, model: null, updatedAt: 0 };
		const next = { ...saved };
		try {
			const patch = cleanDefaults(
				change,
				profiles,
				models,
				MOCK_SIZES.map(size => size.id),
				machines,
			);
			for (const key of ["model", "effort", "reviewModel", "reviewEffort"] as const) {
				if (patch[key] !== undefined) next[key] = patch[key];
			}
			if (patch.profile !== undefined) next.profile = patch.profile;
			if (patch.hostedSize !== undefined) next.hostedSize = patch.hostedSize;
			if (patch.item_place) Object.assign(next, patch.item_place);
		} catch (error) {
			if (error instanceof DefaultsProblem) throw new PlatformError("user", error.message, { reason: error.code });
			throw error;
		}
		if (changesPlace(change)) {
			const policy = changedPlace(saved, change);
			const problem = placeProblem(policy, machines);
			if (problem) throw new PlatformError("user", problem, { reason: "bad_input" });
			Object.assign(next, policy);
		}
		if (
			change.startPlace === undefined &&
			!changesPlace(change) &&
			change.profile === undefined &&
			change.model === undefined &&
			change.effort === undefined &&
			change.reviewModel === undefined &&
			change.reviewEffort === undefined &&
			change.hostedSize === undefined
		)
			return before;
		// As the server reads it back (repository-defaults.ts): interactive launches start at the saved place.
		const place = next.place;
		next.startPlace =
			place === "hosted"
				? { kind: "hosted" }
				: place && typeof place === "object" && next.machineProfile
					? { kind: "machine", machineId: place.machine, profile: next.machineProfile }
					: undefined;
		const { updatedAt: _, startPlace: __, ...fields } = next;
		return Object.values(fields).every(value => value == null) ? null : { ...next, updatedAt: now() };
	}

	// ---- the account's settings -------------------------------------------------------------------

	function accountDefaultsOf(world: World): AccountDefaults {
		const saved = world.account.defaults;
		return saved ?? { profile: null, model: null, updatedAt: null };
	}

	function accountOf(world: World): AccountSettings {
		const servers = [...world.account.servers.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
		return {
			defaults: accountDefaultsOf(world),
			servers: servers.map(([name, server]): PersonalServer => {
				const remote = typeof server.definition.url === "string";
				const argv = remote
					? []
					: [
							String(server.definition.command ?? ""),
							...(Array.isArray(server.definition.args) ? server.definition.args.map(String) : []),
						];
				return {
					name,
					definition: server.definition,
					remote,
					subject: remote ? String(server.definition.url) : commandLine(argv),
					enabled: server.definition.enabled !== false,
					unasked: server.unasked,
					reads: definitionReads(server.definition).map(read => ({
						name: read,
						saved: world.account.secrets.has(read),
					})),
					updatedAt: server.updatedAt,
				};
			}),
			serverReach: profiles.filter(profile => profile.available).map(mockPersonalReach),
			limits: {
				servers: MAX_PERSONAL_SERVERS,
				definitionBytes: MAX_SERVER_DEFINITION_BYTES,
				secrets: MAX_ACCOUNT_SECRETS,
			},
		};
	}

	/** The account's secrets as the server lists them (server/src/account-secrets.ts): no value, what each reaches, and the repositories that have one of the name. */
	function accountSecretsOf(world: World, profileId: SandboxProfileId): AccountSecrets {
		const profile = profiles.find(candidate => candidate.id === profileId);
		if (!profile) throw new PlatformError("user", "Choose one of the listed sandboxes.", { reason: "bad_input" });
		const saved = [...world.account.secrets.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
		return {
			profile: profile.id,
			secrets: saved.map(([name, secret]) => ({
				name,
				scope: secret.scope,
				updatedAt: secret.updatedAt,
				reach: mockSecretReach(secret.scope, profile, "account"),
				repositories: [...world.secrets.entries()]
					.filter(([, secrets]) => secrets.has(name))
					.map(([id]) => repositoryNameOf(world, id) ?? `repository ${id}`)
					.sort((a, b) => a.localeCompare(b)),
			})),
		};
	}

	/**
	 * The user's own servers as a turn's Windlass starts them, kept with what the session knows of its
	 * servers: running, or failed where the definition reads a variable the turn is not handed. A
	 * variable is handed where a secret of the repository or of the account sets it and this sandbox
	 * gives that secret to MCP servers. A server the project names too is the project's.
	 */
	function knowPersonal(world: World, session: MockSession): void {
		const profile = profileOf(session);
		const repository = session.summary.repository ? world.secrets.get(session.summary.repository.id) : undefined;
		const handed = (name: string) => {
			const theirs = repository?.get(name);
			if (theirs) return mockSecretReach(theirs.scope, profile).servers;
			const mine = world.account.secrets.get(name);
			return mine !== undefined && mockSecretReach(mine.scope, profile, "account").servers;
		};
		const before = session.servers;
		const projects = before.filter(server => server.origin !== "user");
		const own: MockKnown[] = [];
		for (const [name, server] of [...world.account.servers.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
			if (server.definition.enabled === false || projects.some(known => known.name === name)) continue;
			const remote = typeof server.definition.url === "string";
			const unset = definitionReads(server.definition).find(read => !handed(read));
			const argv = remote
				? []
				: [
						String(server.definition.command ?? ""),
						...(Array.isArray(server.definition.args) ? server.definition.args.map(String) : []),
					];
			const known: MockKnown = {
				name,
				origin: "user",
				subject: remote ? String(server.definition.url) : commandLine(argv),
				remote,
				file: null,
				state: unset === undefined ? "running" : "failed",
				tools: unset === undefined ? 3 : null,
				reason:
					unset === undefined
						? null
						: `the environment variable ${unset} named in its ${remote ? "headers" : "env"} is not set`,
				fingerprint: null,
				at: now(),
			};
			const same = before.find(
				one =>
					one.origin === "user" &&
					one.name === name &&
					one.subject === known.subject &&
					one.state === known.state &&
					one.reason === known.reason,
			);
			own.push(same ?? known);
		}
		const next = [...projects, ...own];
		if (next.length === before.length && next.every((server, index) => server === before[index])) return;
		session.servers = next;
		serversChanged(world, session);
	}

	// ---- the user's own machines ------------------------------------------------------------------

	/** One user's machines and the codes they looked up, made the first time either is asked about. */
	interface MockMachines {
		list: MachineSummary[];
		/** The codes this user looked up, normalised, with the machine confirming one made. */
		claims: Map<string, string | null>;
		/** The codes this user denied: their pairings ended, so no one can look them up again. */
		denied: Set<string>;
		/** When this user looked a code up, for the limit of five in ten minutes. */
		lookups: number[];
		/** For `stale`: whether the user's connection dropped yet, after which the list can no longer be read. */
		dropped: "no" | "soon" | "yes";
	}

	// The features of `?items=features` name the machines of "placement".
	const machineState: MockMachineState = options.machine ?? (options.items === "features" ? "placement" : "online");
	const machineSession: MockMachineSession = options.machineSession ?? "answering";
	// The agent on "nas" is seeded where "nas" is listed as its runner reported it, and, when its machine was removed, wherever machines are offered.
	const machineSessionSeeded =
		machineState !== "fresh" &&
		(machineSession === "removed"
			? machineState !== "off"
			: !["none", "unpublished", "off", "pairing"].includes(machineState));
	const machineSets = new Map<string, MockMachines>();

	function machinesOf(auth: AuthResult): MockMachines {
		const world = worldOf(auth);
		let set = machineSets.get(world.profile.uid);
		if (!set) {
			set = { list: seedMachines(machineState), claims: new Map(), denied: new Set(), lookups: [], dropped: "no" };
			machineSets.set(world.profile.uid, set);
		}
		return set;
	}

	/** The list as the server answers it: each sandbox named by its agent's title now, none for an agent that was deleted. */
	function machinesView(auth: AuthResult): MachineSummary[] {
		const world = worldOf(auth);
		return machinesOf(auth).list.map(machine => ({
			...machine,
			harnesses: machine.harnesses?.map(({ options, ...entry }) =>
				listedHarness(options ? { ...entry, optionsDigest: String(options.checkedAt) } : entry, [
					...world.account.providers.keys(),
				]),
			),
			warnings: machine.warnings.map(warning => ({ ...warning })),
			sandboxes: machine.sandboxes.map(sandbox => {
				const session = world.sessions.get(sandbox.sessionId);
				return { ...sandbox, title: session ? sessionTitle(session.summary) : null };
			}),
		}));
	}

	function machinesChanged(auth: AuthResult): void {
		const list = machinesView(auth);
		for (const feed of worldOf(auth).feeds) feed.onMachines?.(list);
		items.machinesChanged(auth);
	}

	function machineOf(auth: AuthResult, machineId: string): MachineSummary {
		const machine = machinesOf(auth).list.find(one => one.machineId === machineId);
		if (!machine)
			throw new PlatformError("user", "That machine is not one of yours. It may have been removed in another tab.", {
				reason: "machine_not_found",
			});
		return machine;
	}

	/**
	 * For an agent on one of the user's machines: the sentence its turn fails with when the machine cannot
	 * be reached, as server/src/sandbox/runner-layer.ts words it, and null when it can. What it found is
	 * kept for the session's snapshot, as the server's link notes it.
	 */
	function machineUnreachable(auth: AuthResult, session: MockSession): string | null {
		const { place } = session.summary;
		if (place.kind !== "machine") return null;
		const machine = machinesOf(auth).list.find(one => one.machineId === place.machineId);
		const state = machine === undefined ? "removed" : machine.status === "online" ? "answering" : "offline";
		if (state !== "offline" || session.machine?.reach?.state !== "not_answering") noteReach(session, state);
		if (machine === undefined)
			return "This agent's machine was removed. Its files were there. Start a new agent to go on.";
		if (state === "offline")
			return `Your machine "${machine.name}" is offline. The agent's files are there; send the prompt again when it is back.`;
		return null;
	}

	/** What the session finds of its machine, kept for its snapshot and told to its open pages when it changes, as the server's link does. */
	function noteReach(session: MockSession, state: NonNullable<SessionSnapshot["machine"]>["state"]): void {
		if (!session.machine || session.machine.reach?.state === state) return;
		const reach = { state, since: realNow() };
		session.machine.reach = reach;
		for (const feed of session.feeds) feed.onMachine?.(reach);
	}

	/** Sessions whose machine is stopping answering or coming back (`blipMachine`). */
	const blipping = new Set<MockSession>();

	/**
	 * With `?machineSession=not_answering`, once the agent's page is open: its machine stops answering in
	 * the middle of the turn, and comes back half a minute later. The machine's status changes with it.
	 */
	function blipMachine(auth: AuthResult, session: MockSession): void {
		const { place } = session.summary;
		if (machineSession !== "not_answering" || place.kind !== "machine" || blipping.has(session)) return;
		blipping.add(session);
		const status = (to: MachineSummary["status"]) => {
			const machine = machinesOf(auth).list.find(one => one.machineId === place.machineId);
			if (!machine) return;
			Object.assign(machine, { status: to, since: realNow() });
			machinesChanged(auth);
		};
		later(4_000, () => {
			noteReach(session, "not_answering");
			status("offline");
			later(30_000, () => {
				status("online");
				noteReach(session, "answering");
				blipping.delete(session);
			});
		});
	}

	/** The user's live feeds drop and come back, as `simulateDrop` does for everything. */
	function dropUserFeeds(auth: AuthResult): void {
		const world = worldOf(auth);
		for (const feed of world.feeds) feed.onConnection?.("reconnecting");
		later(600, () => {
			for (const feed of world.feeds) {
				feed.onConnection?.("connected");
				feed.onSessions(listOf(world));
			}
		});
	}

	function machinesOn(): void {
		if (machineState === "off")
			throw new PlatformError("user", "This deployment does not run agents on machines of your own.", {
				reason: "machines_off",
			});
	}

	const WORKSHOP_NO_BUBBLEWRAP =
		"Unprivileged user namespaces are turned off on this kernel (kernel.apparmor_restrict_unprivileged_userns=1), so bubblewrap cannot start.";

	/** The machines a state starts with. Their sandboxes name the seeded agents; titles are looked up when the list is read. */
	function seedMachines(state: MockMachineState): MachineSummary[] {
		const at = realNow();
		const claude = {
			...MOCK_CLAUDE,
			options: {
				models: MOCK_CLAUDE_MODELS.models,
				defaultModel: MOCK_CLAUDE_MODELS.defaultModel,
				modes: [...CLAUDE_LAUNCH_MODES],
				checkedAt: at,
			},
		};
		const externalHarnesses: MachineSummary["harnesses"] = [
			{ ...claude, signIn: "none" },
			{
				...MOCK_CLAUDE,
				id: "opencode",
				adapter: "OpenCode 1.19.6",
				signIn: "token",
				machineProviders: ["openai"],
				options: {
					models: MOCK_OPENCODE_MODELS.models,
					defaultModel: MOCK_OPENCODE_MODELS.defaultModel,
					modes: MOCK_OPENCODE_MODES,
					checkedAt: at,
				},
			},
		];
		externalHarnesses.push({
			keyRelay: true,
			id: "codex",
			image: MOCK_CLAUDE.image,
			adapter: "codex-acp 2.9.0",
			// No login of its own: the account's key pays (Connections → Pay with).
			signIn: "none",
			modes: ["agent-full-access"],
			options: {
				defaultModel: MOCK_CODEX_MODELS.defaultModel,
				models: MOCK_CODEX_MODELS.models,
				modes: codexModes("docker-hardened"),
				checkedAt: at,
			},
		});
		const slots = (max: number, busy: number) => ({
			max,
			busy,
			queued: 0,
			unit: { cpus: 2, memoryBytes: 4 * 2 ** 30, pids: 1024 },
			reserve: { cpus: 1, memoryBytes: Math.ceil(2.1 * 2 ** 30) },
		});
		const nas = (patch: Partial<MachineSummary>): MachineSummary => ({
			machineId: "m_nas",
			name: "nas",
			os: "Linux",
			arch: "arm64",
			runnerVersion: MOCK_RUNNER_VERSION,
			status: "online",
			since: at - 3 * HOUR,
			agents: 3,
			sandboxes: [
				...(machineSessionSeeded && machineSession !== "removed"
					? [
							{
								sessionId: "nas-tests",
								title: null,
								state:
									machineSession === "offline" || machineSession === "paused"
										? ("paused" as const)
										: ("running" as const),
								usedAt: at - 3 * MINUTE,
							},
						]
					: []),
				{ sessionId: "gone", title: null, state: "paused", usedAt: at - 4 * 24 * HOUR },
			],
			commandSandbox: { ok: true },
			freeDiskBytes: 61.4e9,
			storeLimits: { machine: 10e9, user: 2e9, free: 40e9 },
			egress: "open",
			profiles: mockMachineProfiles(patch.name ?? "nas", {}, patch.egress),
			slots: slots(2, 0),
			sendSecrets: true,
			orchestrator: "yes",
			whenToUse: "Build and test",
			tags: ["big-build"],
			host: { cpus: 8, sandboxCpus: 2, memoryBytes: 16 * 2 ** 30, memoryFreeBytes: 8 * 2 ** 30, load1: 1 },
			turns: { running: 0, queued: 0, max: 2 },
			warnings: [],
			harnesses: [claude],
			...patch,
		});
		switch (state) {
			case "none":
			case "unpublished":
			case "off":
				return [];
			case "offline":
				// A sandbox that was running when the machine went offline: shown as its last reported state.
				return [
					nas({
						status: "offline",
						since: at - 47 * MINUTE,
						sandboxes: [
							{
								sessionId: "nas-spare",
								title: "Warm spare for the docs site",
								state: "running",
								usedAt: at - 50 * MINUTE,
							},
							{ sessionId: "gone", title: null, state: "paused", usedAt: at - 4 * 24 * HOUR },
						],
					}),
				];
			// The agent on "nas" finds it offline: the machine went offline after the agent last used it.
			case "online":
				return [
					nas({
						...((machineSession === "offline" || machineSession === "paused") && {
							status: "offline",
							since: at - 12 * MINUTE,
						}),
					}),
				];
			case "sources": {
				const options = (list: ModelList) => ({
					models: list.models,
					defaultModel: list.defaultModel,
					modes: [],
					checkedAt: at,
				});
				const mac = [
					{ ...MOCK_CLAUDE, options: { ...options(MOCK_CLAUDE_MODELS), modes: [...CLAUDE_LAUNCH_MODES] } },
					{
						...MOCK_CLAUDE,
						id: "codex" as const,
						adapter: "codex-acp 2.9.0",
						signIn: "none" as const,
						modes: ["agent-full-access"],
						options: { ...options(MOCK_CODEX_MODELS), modes: codexModes("docker-hardened") },
					},
					{
						...MOCK_CLAUDE,
						id: "opencode" as const,
						adapter: "OpenCode 1.19.6",
						machineProviders: ["anthropic", "free"],
						options: { ...options(MOCK_OPENCODE_SOURCES), modes: MOCK_OPENCODE_MODES },
					},
				];
				return [
					nas({
						machineId: "m_mac",
						name: "mac-mini",
						os: "macOS",
						arch: "arm64",
						agents: 0,
						sandboxes: [],
						harnesses: mac,
					}),
					nas({}),
				];
			}
			case "fresh":
				return [
					nas({
						machineId: "m_workshop",
						name: "workshop",
						egress: "restricted",
						agents: 0,
						sandboxes: [],
						harnesses: externalHarnesses,
					}),
				];
			case "claude-signed-out":
				return [nas({ harnesses: [{ ...claude, signIn: "none" }] })];
			// The runner could not check Claude Code's sign-in: it may well run.
			case "claude-unchecked":
				return [nas({ harnesses: [{ ...claude, signIn: "unknown" }] })];
			case "pairing":
				return [
					nas({
						status: "waiting",
						slots: undefined,
						since: at - 4 * MINUTE,
						agents: 0,
						sandboxes: [],
						commandSandbox: null,
						freeDiskBytes: null,
						storeLimits: undefined,
						profiles: [],
						harnesses: undefined,
					}),
				];
			case "outdated":
				return [
					nas({
						status: "offline",
						since: at - 12 * MINUTE,
						runnerVersion: "0.3.12",
						slots: undefined,
						warnings: [{ kind: "outdated" }],
					}),
				];
			case "docker":
				return [
					nas({
						warnings: [
							{
								kind: "docker",
								reason:
									"Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
							},
						],
						profiles: mockMachineProfiles("nas", {
							docker:
								"Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
						}),
					}),
				];
			case "clock":
				return [nas({ warnings: [{ kind: "clock", offsetSeconds: 7 * 60 + 12 }] })];
			case "key":
				return [nas({ warnings: [{ kind: "key", at: at - 25 * MINUTE }] })];
			case "full":
				return [
					nas({}),
					nas({
						machineId: "m_workshop",
						name: "workshop",
						arch: "x64",
						status: "offline",
						since: at - 2 * 24 * HOUR,
						agents: 1,
						sandboxes: [{ sessionId: "workshop-gone", title: null, state: "paused", usedAt: at - 2 * 24 * HOUR }],
						commandSandbox: { ok: false, reason: WORKSHOP_NO_BUBBLEWRAP },
						egress: "restricted",
						profiles: mockMachineProfiles("workshop", { commandSandbox: WORKSHOP_NO_BUBBLEWRAP }, "restricted"),
						freeDiskBytes: 3.2e9,
						sendSecrets: false,
						// Its runner was started with --harness claude, and nobody signed Claude Code in there.
						harnesses: externalHarnesses,
					}),
					// Its owner started its runner with --max-running 2 --max-sandboxes 6; the others have no limit.
					nas({
						machineId: "m_build",
						name: "build-box",
						arch: "x64",
						since: at - 20 * MINUTE,
						agents: 0,
						sandboxes: [],
						freeDiskBytes: 402e9,
						storeLimits: { machine: 50e9, user: 10e9, free: 40e9 },
						maxRunning: 2,
						maxSandboxes: 6,
						harnesses: undefined,
					}),
				];
			// Feature placement (`?items=features` lists these by default): one machine of each policy. "studio" is
			// the only one with screenshots, and both its slots are taken; "ci-box" takes no subtask of a feature.
			case "placement": {
				const allowed: MachineSummary["allowedProfiles"] = ["docker-windlass-sandbox", "docker-hardened"];
				return [
					nas({ allowedProfiles: allowed, slots: slots(2, 0) }),
					nas({
						machineId: "m_studio",
						name: "studio",
						arch: "x64",
						since: at - 5 * HOUR,
						agents: 2,
						sandboxes: [],
						freeDiskBytes: 240e9,
						orchestrator: "named",
						screenshots: true,
						whenToUse: "Browser tests and screenshots",
						tags: ["browser"],
						allowedProfiles: allowed,
						slots: slots(2, 2),
						turns: { running: 2, queued: 0, max: 2 },
						harnesses: undefined,
					}),
					nas({
						machineId: "m_ci",
						name: "ci-box",
						arch: "x64",
						since: at - 26 * HOUR,
						agents: 0,
						sandboxes: [],
						freeDiskBytes: 88e9,
						storeLimits: { machine: 10e9, user: 2e9, free: 15e9, builtIn: true },
						orchestrator: "never",
						sendSecrets: false,
						whenToUse: "Release builds only",
						tags: ["release"],
						allowedProfiles: allowed,
						slots: slots(4, 0),
						harnesses: undefined,
					}),
				];
			}
			case "unnamed":
				return [
					nas({}),
					// Its runner runs in a container, so the host name it reported is the container's id.
					nas({
						machineId: "m_container",
						name: "f892b469d6c5",
						arch: "x64",
						since: at - 2 * HOUR,
						agents: 0,
						sandboxes: [],
						freeDiskBytes: 118e9,
						harnesses: undefined,
					}),
				];
			default:
				return [nas({})];
		}
	}

	/** A code as the server reads it: case, spaces and dashes do not matter, O reads as 0 and I and L as 1. */
	const pairingCode = (code: string) =>
		code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");

	function lookUp(auth: AuthResult, code: string): string {
		const set = machinesOf(auth);
		const clean = pairingCode(code);
		// Asked again for a code that made a machine, the answer is that machine.
		if (set.claims.get(clean)) return clean;
		if (set.list.length >= MAX_MACHINES)
			throw new PlatformError(
				"user",
				`An account can connect up to ${MAX_MACHINES} machines. Remove one to add another.`,
				{ reason: "too_many_machines" },
			);
		if (set.claims.has(clean)) return clean;
		const at = realNow();
		set.lookups = set.lookups.filter(when => when > at - 10 * MINUTE);
		if (set.lookups.length >= 5)
			throw new PlatformError(
				"user",
				"Five codes were tried in the last ten minutes. Wait a few minutes, then try again.",
				{ reason: "too_many_claims" },
			);
		set.lookups.push(at);
		if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(clean) || clean === "ZZZZZZZZ" || set.denied.has(clean)) throw noPairing();
		set.claims.set(clean, null);
		return clean;
	}

	const noPairing = () =>
		new PlatformError(
			"user",
			"No machine is waiting with that code. A code lasts ten minutes: check the one the runner printed last.",
			{ reason: "pairing_not_found" },
		);

	/** The calls of the Machines page. A machine paired here waits for its runner, which connects a few seconds later. */
	function machineCalls(
		auth: AuthResult,
	): Pick<
		UserApi,
		| "machines"
		| "machineCatalog"
		| "claimMachine"
		| "confirmMachine"
		| "denyMachine"
		| "removeMachine"
		| "removeMachineClaudeLogin"
		| "setMachineDetails"
		| "setMachineSecrets"
	> {
		return {
			async machineCatalog({ machineId, id, digest }) {
				const entry = machineOf(auth, machineId).harnesses?.find(h => h.id === id);
				return entry?.options && digest === String(entry.options.checkedAt) ? entry.options : null;
			},
			async machines() {
				machinesOn();
				const set = machinesOf(auth);
				if (machineState === "loading") await new Promise<never>(() => undefined);
				await latency(260);
				if (machineState === "failed" || set.dropped === "yes")
					throw new PlatformError("network", "The platform could not be reached. Check your connection.");
				// The list is read; then the user's connection drops for a moment, and reading it again after that fails.
				if (machineState === "stale" && set.dropped === "no") {
					set.dropped = "soon";
					later(1500, () => {
						set.dropped = "yes";
						dropUserFeeds(auth);
					});
				}
				return machinesView(auth);
			},
			async claimMachine({ code }) {
				machinesOn();
				await latency(420);
				lookUp(auth, code);
				return {
					name: "workstation",
					os: "Linux",
					arch: "x64",
					runnerVersion: MOCK_RUNNER_VERSION,
					keyFingerprint: "K7Q2M-XR4TD",
					keyPrinted: true,
				};
			},
			async confirmMachine({ code, keyConfirmed }) {
				machinesOn();
				if (keyConfirmed !== true)
					throw new PlatformError(
						"user",
						"Check that the machine's terminal shows the same machine key, then connect it.",
						{ reason: "key_not_confirmed" },
					);
				await latency(520);
				const set = machinesOf(auth);
				const clean = lookUp(auth, code);
				const made = set.claims.get(clean);
				if (made) return machinesView(auth).find(one => one.machineId === made) ?? machineOf(auth, made);
				const machineId = `m_${hex(12)}`;
				set.claims.set(clean, machineId);
				set.list.push({
					machineId,
					name: "workstation",
					os: "Linux",
					arch: "x64",
					runnerVersion: MOCK_RUNNER_VERSION,
					status: "waiting",
					since: realNow(),
					agents: 0,
					sandboxes: [],
					commandSandbox: null,
					freeDiskBytes: null,
					profiles: [],
					sendSecrets: true,
					warnings: [],
				});
				machinesChanged(auth);
				later(4000, () => {
					const machine = machinesOf(auth).list.find(one => one.machineId === machineId);
					if (!machine || machine.status !== "waiting") return;
					Object.assign(machine, {
						status: "online",
						since: realNow(),
						commandSandbox: { ok: true },
						freeDiskBytes: 212e9,
					});
					machinesChanged(auth);
				});
				return machinesView(auth).find(one => one.machineId === machineId) as MachineSummary;
			},
			async denyMachine({ code }) {
				machinesOn();
				await latency(320);
				const set = machinesOf(auth);
				const clean = pairingCode(code);
				if (!set.claims.has(clean)) throw noPairing();
				// Once its machine is paired, denying it changes nothing.
				if (set.claims.get(clean)) return;
				set.claims.delete(clean);
				set.denied.add(clean);
			},
			async removeMachine({ machineId }) {
				machinesOn();
				await latency(380);
				machineOf(auth, machineId);
				const set = machinesOf(auth);
				set.list = set.list.filter(one => one.machineId !== machineId);
				machinesChanged(auth);
				return machinesView(auth);
			},
			async removeMachineClaudeLogin({ machineId }) {
				machinesOn();
				await latency(600);
				const machine = machineOf(auth, machineId);
				if (machine.status !== "online")
					throw new PlatformError("user", "The machine is offline. Start its runner, then switch back.", {
						reason: "machine_not_connected",
					});
				machine.harnesses = machine.harnesses?.map(entry =>
					entry.id === "claude" ? { ...entry, signIn: "none" as const } : entry,
				);
				machinesChanged(auth);
				return machinesView(auth);
			},
			async setMachineDetails(input) {
				machinesOn();
				const machine = machineOf(auth, input.machineId);
				try {
					Object.assign(machine, machineDetails({ ...machine, ...input }));
				} catch (error) {
					throw new PlatformError("user", (error as Error).message, { reason: "bad_input" });
				}
				machinesChanged(auth);
				return machinesView(auth);
			},
			async setMachineSecrets({ machineId, send }) {
				machinesOn();
				await latency(240);
				machineOf(auth, machineId).sendSecrets = send;
				machinesChanged(auth);
				return machinesView(auth);
			},
		};
	}

	// ---- the interface --------------------------------------------------------------------------

	function takeModelCheck(account: World["account"]) {
		const minute = Math.floor(now() / 60_000);
		if (account.checks.minute !== minute) account.checks = { minute, used: 0 };
		if (account.checks.used >= MODEL_CHECKS_PER_MINUTE)
			throw new PlatformError("user", "Too many model provider checks. Try again next minute.", {
				reason: "rate_limited",
			});
		account.checks.used++;
	}

	function userApi(auth: AuthResult): UserApi {
		const world = () => worldOf(auth);
		const jiraKey = (suffix = "") => `wlp.mock.jira.${world().profile.uid}${suffix}`;
		function readJira<T>(suffix = ""): T | null {
			if (options.jira === false)
				throw new PlatformError("user", "This deployment has no Jira client.", { reason: "jira_off" });
			const key = jiraKey(suffix);
			return JSON.parse(recall(key) ?? jiraMemory.get(key) ?? "null");
		}
		function storeJira(value: unknown, suffix = "") {
			const key = jiraKey(suffix),
				data = JSON.stringify(value);
			jiraMemory.set(key, data);
			keep(key, data);
		}
		function connectedJira() {
			const kept = readJira<JiraKept>();
			if (!kept) throw new PlatformError("user", "Connect Jira first.", { reason: "jira_not_connected" });
			return kept;
		}
		function projectList(kept: JiraKept, expectedSite?: string): JiraProjectList {
			const site = kept.connection.site;
			if (!site || (expectedSite !== undefined && site.id !== expectedSite))
				throw new PlatformError("user", "Choose the Jira site first.", { reason: "jira_site" });
			return { projects: projectsBySite[site.id]!.map(p => ({ ...p, mapping: kept.mappings[p.id] ?? null })) };
		}
		return {
			async linkedLogins() {
				return (["github", "google"] as const)
					.filter(provider => recall("wlp.mock.identity." + provider) === world().profile.uid)
					.map(provider =>
						provider === "github"
							? { provider, display: "ada", name: "Ada Lovelace", avatar: MOCK_AVATAR }
							: { provider, display: "ada@example.com", name: "Ada Lovelace", avatar: null },
					);
			},
			async unlinkLogin(provider) {
				const methods = await this.linkedLogins();
				if (!methods.some(method => method.provider === provider)) return;
				if (methods.length < 2) throw new PlatformError("user", "Link another login method first.");
				keep("wlp.mock.identity." + provider, "");
			},
			...machineCalls(auth),
			...items.calls(auth),
			async signOutEverywhere(options) {
				const { uid } = world().profile;
				if (options?.revokeApiTokens) items.revokeAllApiTokens(auth);
				const next = crypto.randomUUID();
				revoked.set(uid, next);
				keep("wlp.mock.tokenGen." + uid, next);
			},
			async me() {
				await latency();
				return world().profile;
			},
			async chatgpt(): Promise<ChatgptStatus> {
				await latency(220);
				const { profile } = world();
				return profile.demo || !world().planConnected
					? { connected: false, email: null, accessExpiresAt: null }
					: { connected: true, email: profile.email, accessExpiresAt: now() + 52 * MINUTE };
			},
			async forgetChatgpt() {
				const { uid } = world().profile;
				world().planConnected = false;
				keep("wlp.mock.plan." + uid, "0");
			},
			async models(): Promise<ModelList> {
				await latency(200);
				return modelsFor(world().profile);
			},
			async listSessions() {
				await latency();
				return listOf(world());
			},
			async createSession(asked: CreateSessionInput) {
				const { idempotencyKey, ...input } = asked;
				await latency(260);
				// With a key, the agent its first attempt made, for as long as that agent exists.
				const key = keyOf(idempotencyKey);
				const made = world().sessions.get(takenUnder(world().created, key, JSON.stringify(input), "agent") ?? "");
				if (made) return made.summary;
				// On one of the user's machines, the sandboxes are the ones its runner last reported.
				const machine = input.place?.kind === "machine" ? machineOf(auth, input.place.machineId) : null;
				if (input.size !== undefined && ![1, 2, 4].includes(input.size))
					throw new PlatformError("user", "Choose a sandbox size of 1, 2 or 4 slots.", { reason: "bad_input" });
				if ((input.size ?? 1) > 1 && !machine?.slots)
					throw new PlatformError("user", "Choose a machine reporting slots for a large sandbox.", {
						reason: "bad_input",
					});
				const profile = (machine ? machine.profiles : profiles).find(candidate => candidate.id === input.profile);
				if (!profile) throw new PlatformError("user", "There is no such sandbox.");
				if (!profile.available)
					throw new PlatformError("user", "That sandbox isn't available here: choose Strict or Open.");
				const harness: HarnessId = input.harness ?? "windlass";
				const options =
					!machine && harness !== "windlass"
						? hostedCatalog(harness, hostedCredentialsOf(world()))
						: machine?.harnesses?.find(entry => entry.id === harness)?.options;
				if (harness !== "windlass") {
					if (!machine && !hostedPayer(harness, input.model, hostedCredentialsOf(world())))
						throw new PlatformError("user", hostedKeyMessage(harness), { reason: "harness_signed_out" });
					if (machine ? input.profile !== "docker-hardened" : !profile.platformKeys)
						throw new PlatformError(
							"user",
							`${HARNESS_NAMES[harness]} requires the ${isolationName("docker-hardened")} profile.`,
							{ reason: "bad_input" },
						);
					if (input.publishUnasked)
						throw new PlatformError("user", publishAsksEveryTime(HARNESS_NAMES[harness]), { reason: "bad_input" });
					if (machine && !machine.harnesses?.some(offered => offered.id === harness))
						throw new PlatformError("user", `This machine does not offer ${HARNESS_NAMES[harness]}.`, {
							reason: "bad_input",
						});
				}
				const models = harness !== "windlass" ? initialHarnessModels(options) : modelsFor(world().profile);
				if (input.model) {
					if (machine && harness !== "windlass" && options && !models.models.some(m => m.id === input.model))
						throw new PlatformError("user", "Choose a model offered by this machine.", { reason: "bad_input" });
					checkModel(models, input.model);
				}
				const modes = initialSessionModes(
					profile.id,
					harness,
					false,
					(machine ? options?.modes : undefined) ??
						(harness === "claude"
							? [...CLAUDE_LAUNCH_MODES]
							: harness === "codex"
								? codexModes(profile.id)
								: harness === "opencode"
									? [
											{ id: "build", name: "Build", description: null },
											{ id: "plan", name: "Plan", description: null },
										]
									: undefined),
				);
				if (input.mode !== undefined) {
					if (!modes.availableModes.some(m => m.id === input.mode))
						throw new PlatformError("user", "Choose a mode offered by this agent.", { reason: "bad_input" });
					modes.mode = input.mode;
				}
				const repoUrl = input.repoUrl?.trim() || null;
				if (repoUrl !== null && !/^https:\/\/\S+$/.test(repoUrl))
					throw new PlatformError("user", "The repository must be an https address.");
				let repository: SessionRepository | null = null;
				if (input.repository) {
					requireGithub(world());
					const found = GITHUB_REPOSITORIES.find(candidate => candidate.id === input.repository?.id);
					if (!found)
						throw new PlatformError(
							"user",
							"That repository is not among the ones your GitHub connection covers. Add it to the GitHub App's installation at GitHub, then choose it again.",
						);
					repository = sessionRepository(found.owner, found.name, input.repository.branch ?? found.defaultBranch);
				}
				const title = input.title?.trim() ? input.title : "";
				if (title.length > MAX_TITLE_CHARS)
					throw new PlatformError("user", `A title can be at most ${MAX_TITLE_CHARS} characters.`);
				if (repository && input.setupCommand !== undefined) saveSetup(world(), repository.id, input.setupCommand);
				const session = addSession(world(), {
					id: hex(10),
					title: title || "New agent",
					titled: title !== "",
					profile: profile.id,
					harness,
					modes,
					model: input.model || models.defaultModel,
					repoUrl,
					repository,
					publishUnasked: repository !== null && input.publishUnasked === true,
				});
				if (harness !== "windlass" && options) session.summary = { ...session.summary, harnessModels: models };
				if (!machine) {
					if (input.hostedSize !== undefined && !isHostedSize(input.hostedSize))
						throw new PlatformError("user", "Choose a hosted size: Small, Medium, Large.", { reason: "bad_input" });
					const saved = repository ? hostedSizes.get(repository.id) : undefined;
					session.summary = {
						...session.summary,
						hostedSize: input.hostedSize ?? saved ?? (itemStarts.has(asked) ? "standard" : "small"),
					};
				}
				if (machine) {
					session.summary = { ...session.summary, place: { kind: "machine", machineId: machine.machineId } };
					session.machine = { profile, reach: null };
					machine.agents += 1;
					machinesChanged(auth);
				}
				setSummary(world(), session, {});
				if (key !== null) world().created.set(key, { content: JSON.stringify(input), answer: session.summary.id });
				return session.summary;
			},
			async continueSession({ id, stack, idempotencyKey }: ContinueSessionInput) {
				await latency(260);
				const key = keyOf(idempotencyKey);
				const content = JSON.stringify({ continue: id, stack: stack === true });
				const made = world().sessions.get(takenUnder(world().created, key, content, "agent") ?? "");
				if (made) return made.summary;
				const parent = world().sessions.get(id);
				if (!parent)
					throw new PlatformError("not_found", "That agent no longer exists.", { reason: "session_not_found" });
				const was = parent.summary;
				if (was.item || was.readiness || was.environmentBuild)
					throw new PlatformError("user", "Only your own agents can be continued in a new pull request.", {
						reason: "item_session",
					});
				if (!was.repository)
					throw new PlatformError(
						"user",
						"This agent has no repository from your GitHub connection, so there is no pull request to continue.",
						{ reason: "no_repository" },
					);
				if (parent.run || was.status !== "idle")
					throw new PlatformError(
						"user",
						"The agent is working. Continue it in a new pull request once its turn has ended.",
						{
							reason: "turn_running",
						},
					);
				if (stack && !parent.pushed)
					throw new PlatformError("user", "This agent has not pushed a branch yet, so there is nothing to stack on.", {
						reason: "not_pushed",
					});
				const found = GITHUB_REPOSITORIES.find(candidate => candidate.id === was.repository?.id);
				const base = stack
					? (was.pullRequest?.branch ?? branchFor(parent))
					: (found?.defaultBranch ?? was.repository.branch);
				const session = addSession(world(), {
					id: hex(10),
					title: "New agent",
					titled: false,
					profile: was.profile,
					harness: was.harness,
					modes: { mode: was.mode, availableModes: was.availableModes },
					model: was.model,
					repoUrl: was.repoUrl,
					repository: { ...was.repository, branch: base },
				});
				session.summary = {
					...session.summary,
					place: was.place,
					effort: was.effort ?? null,
					...(was.hostedSize && { hostedSize: was.hostedSize }),
					...(was.harnessModels !== undefined && { harnessModels: was.harnessModels }),
					continuedFrom: { id: was.id, title: was.title },
				};
				setSummary(world(), session, {});
				if (key !== null) world().created.set(key, { content, answer: session.summary.id });
				return session.summary;
			},
			async renameSession(id: string, title: string) {
				await latency();
				const session = world().sessions.get(id);
				if (!session) throw new PlatformError("not_found", "That agent no longer exists.");
				if (!title.trim()) throw new PlatformError("user", "A title cannot be empty.");
				if (title.length > MAX_TITLE_CHARS)
					throw new PlatformError("user", `A title can be at most ${MAX_TITLE_CHARS} characters.`);
				session.titled = true;
				setSummary(world(), session, { title });
				return session.summary;
			},
			async deleteSession(id: string) {
				await latency(300);
				const session = world().sessions.get(id);
				if (!session) return;
				cancel(session.run?.timer ?? null);
				cancel(session.pauseTimer);
				withdraw(session);
				session.run = null;
				world().sessions.delete(id);
				for (const feed of session.feeds)
					feed.onConnection("failed", new PlatformError("not_found", "This agent was deleted."));
				session.feeds.clear();
				const list = listOf(world());
				for (const feed of world().feeds) feed.onSessions(list);
			},
			async gitlab() {
				return gitlabStatus(world().profile.uid);
			},
			async gitlabConnect({ origin }) {
				const uid = world().profile.uid;
				if (options.gitlab === false) throw new PlatformError("user", "GitLab is unavailable.");
				const ticket = `mock.${now() + 5 * MINUTE}.${crypto.randomUUID()}`;
				keep(`wlp.mock.gitlab.ticket.${uid}`, ticket);
				const url = new URL("/settings", origin);
				url.search = typeof location === "undefined" ? "" : location.search;
				url.hash = `gitlab=${ticket}`;
				return { url: url.href };
			},
			async gitlabComplete(ticket) {
				const uid = world().profile.uid;
				const key = `wlp.mock.gitlab.ticket.${uid}`;
				if (options.gitlab === false || !ticket || recall(key) !== ticket || !(Number(ticket.split(".")[1]) > now()))
					throw new PlatformError("user", "This link is no longer valid. Connect GitLab again.");
				keep(key, "");
				keep(`wlp.mock.gitlab.${uid}`, "connected");
				return gitlabStatus(uid);
			},
			async gitlabProjects(query) {
				if (gitlabStatus(world().profile.uid).state !== "connected")
					throw new PlatformError("user", "Connect GitLab first.");
				return {
					projects: gitlabProjects.filter(p => `${p.owner}/${p.name}`.includes(query.trim().toLowerCase())),
					more: false,
				};
			},
			async gitlabPickProject(id) {
				const uid = world().profile.uid;
				if (gitlabStatus(uid).state !== "connected" || !gitlabProjects.some(p => p.id === id))
					throw new PlatformError("user", "That GitLab project is not available.");
				keep(`wlp.mock.gitlab.${uid}`, id);
				return gitlabStatus(uid);
			},
			async gitlabDisconnect() {
				const uid = world().profile.uid;
				keep(`wlp.mock.gitlab.ticket.${uid}`, "");
				keep(`wlp.mock.gitlab.${uid}`, "");
				return gitlabStatus(uid);
			},
			async jira() {
				if (options.jira === false) return { state: "off" };
				const kept = readJira<JiraKept>();
				return kept ? { state: "connected", connection: kept.connection } : { state: "disconnected" };
			},
			async jiraConnect({ origin }) {
				readJira();
				const ticket = crypto.randomUUID();
				storeJira({ ticket, expires: now() + 300_000 }, ".ticket");
				return { url: `${origin}/settings${typeof location === "undefined" ? "" : location.search}#jira=${ticket}` };
			},
			async jiraComplete(ticket) {
				const pending = readJira<{ ticket: string; expires: number }>(".ticket");
				if (!pending || pending.ticket !== ticket || pending.expires <= now())
					throw new PlatformError("user", "Invalid Jira return. Connect Jira again.", { reason: "jira_ticket" });
				storeJira(null, ".ticket");
				const connection = {
					user: { id: "jira-ada", name: "Ada Lovelace" },
					sites: jiraSites,
					site: null,
					connectedAt: now(),
				};
				storeJira({ connection, mappings: {} });
				return { state: "connected", connection };
			},
			async jiraSelectSite(siteId) {
				const kept = connectedJira(),
					site = jiraSites.find(s => s.id === siteId);
				if (!site) throw new PlatformError("user", "That site is not authorized.", { reason: "jira_site" });
				if (kept.connection.site?.id !== siteId) kept.mappings = {};
				kept.connection.site = site;
				storeJira(kept);
				return { state: "connected", connection: kept.connection };
			},
			async jiraProjects() {
				return projectList(connectedJira());
			},
			async saveJiraMapping({ siteId, projectId, repositoryId }) {
				const kept = connectedJira();
				if (!projectList(kept, siteId).projects.some(p => p.id === projectId))
					throw new PlatformError("user", "Choose a listed project.", { reason: "jira_project" });
				requireGithub(world());
				const repo = GITHUB_REPOSITORIES.find(r => r.id === repositoryId);
				if (!repo?.canPush) throw new PlatformError("user", "Choose a writable repository.", { reason: "bad_input" });
				kept.mappings[projectId] = {
					siteId,
					projectId,
					repository: { id: repo.id, owner: repo.owner, name: repo.name },
					savedAt: now(),
				};
				storeJira(kept);
				return projectList(kept);
			},
			async removeJiraMapping({ siteId, projectId }) {
				const kept = connectedJira();
				delete kept.mappings[projectId];
				const list = projectList(kept, siteId);
				storeJira(kept);
				return list;
			},
			async disconnectJira() {
				readJira();
				storeJira(null);
				storeJira(null, ".ticket");
				return { state: "disconnected" };
			},
			...slackActions(world),
			...linkedAccountsActions(world),
			async linear(): Promise<LinearStatus> {
				await latency(200);
				if (options.linear === false) return { state: "off" };
				const kept = linearKept(world().profile.uid);
				return kept
					? { state: "connected", connection: linearConnection(kept.connectedAt) }
					: { state: "disconnected" };
			},
			async linearConnect({ origin }) {
				await latency(260);
				if (options.linear === false)
					throw new PlatformError("user", "This deployment has no Linear client, so Linear cannot be connected here.", {
						reason: "linear_off",
					});
				// The mock's Linear approves at once and sends the browser straight back.
				const ticket = `mock.${now() + 5 * 60_000}.${crypto.randomUUID()}`;
				keep(`wlp.mock.linear.ticket.${world().profile.uid}`, ticket);
				const search = typeof location === "undefined" ? "" : location.search;
				return { url: `${origin.replace(/\/$/, "")}/settings${search}#linear=${ticket}` };
			},
			async linearComplete(ticket) {
				await latency(240);
				const uid = world().profile.uid;
				const key = `wlp.mock.linear.ticket.${uid}`;
				if (recall(key) !== ticket || !(Number(ticket.split(".")[1]) > now()))
					throw new PlatformError(
						"user",
						"This link to connect Linear is not valid for this account any more. Connect Linear again.",
						{ reason: "linear_ticket" },
					);
				keep(key, "");
				const connectedAt = now();
				keepLinear(uid, { connectedAt, mappings: linearKept(uid)?.mappings ?? {} });
				return { state: "connected", connection: linearConnection(connectedAt) };
			},
			async linearTeams() {
				await latency(240);
				return linearTeams(world().profile.uid);
			},
			async saveLinearMapping({ teamId, repositoryId }) {
				await latency(300);
				const uid = world().profile.uid;
				const kept = linearKept(uid);
				if (!kept) throw new PlatformError("user", "Connect Linear first.", { reason: "linear_not_connected" });
				if (!LINEAR_TEAMS.some(team => team.id === teamId))
					throw new PlatformError("user", "That team is not in the connected workspace.", { reason: "linear_team" });
				requireGithub(world());
				if (!GITHUB_REPOSITORIES.some(repository => repository.id === repositoryId))
					throw new PlatformError("user", "That repository is not among the ones your GitHub connection covers.", {
						reason: "bad_input",
					});
				keepLinear(uid, { ...kept, mappings: { ...kept.mappings, [teamId]: { repositoryId, savedAt: now() } } });
				return linearTeams(uid);
			},
			async removeLinearMapping(teamId) {
				await latency(260);
				const uid = world().profile.uid;
				const kept = linearKept(uid);
				if (!kept) throw new PlatformError("user", "Connect Linear first.", { reason: "linear_not_connected" });
				const { [teamId]: _gone, ...mappings } = kept.mappings;
				keepLinear(uid, { ...kept, mappings });
				return linearTeams(uid);
			},
			async disconnectLinear() {
				await latency(260);
				const uid = world().profile.uid;
				linearMemory.delete(uid);
				keep(`wlp.mock.linear.ticket.${uid}`, "");
				try {
					localStorage.removeItem(`wlp.mock.linear.${uid}`);
				} catch {
					// Private windows may refuse storage; the memory copy is gone either way.
				}
				return { state: "disconnected" };
			},
			async github(): Promise<GithubStatus> {
				await latency(200);
				if (!githubOn)
					throw new PlatformError("user", "This deployment has no GitHub App, so GitHub cannot be connected here.", {
						reason: "github_off",
					});
				return { connection: world().github };
			},
			async repositorySetup(repositoryId: GithubId): Promise<RepositorySetup> {
				await latency(180);
				return setupOf(world(), repositoryId);
			},
			async saveRepositorySetup(repositoryId: GithubId, command: string): Promise<RepositorySetup> {
				await latency(320);
				nameAtSave(world(), repositoryId);
				return saveSetup(world(), repositoryId, command);
			},
			async repositoryChecks(repositoryId: GithubId): Promise<RepositoryChecks> {
				await latency(180);
				return checksOf(world(), repositoryId);
			},
			async saveRepositoryChecks(repositoryId: GithubId, checks: RepositoryCheck[]): Promise<RepositoryChecks> {
				await latency(320);
				nameAtSave(world(), repositoryId);
				return saveChecks(world(), repositoryId, checks);
			},
			async repositoryEnvironments(repositoryId: GithubId): Promise<RepositoryEnvironments> {
				await latency(180);
				return mockEnvironments(repositoryId, realNow(), environmentInputs(world(), repositoryId));
			},
			async rebuildEnvironment(repositoryId: GithubId, place?: string): Promise<RepositoryEnvironments> {
				await latency(260);
				const refused = environmentInputs(world(), repositoryId);
				if (refused) throw new PlatformError("user", refused, { reason: "environment_refused" });
				return mockRebuild(repositoryId, place, realNow(), later, () => undefined);
			},
			async saveEnvironmentSchedule(
				repositoryId: GithubId,
				schedule: EnvironmentSchedule,
			): Promise<RepositoryEnvironments> {
				await latency(220);
				return mockSchedule(repositoryId, schedule, realNow(), environmentInputs(world(), repositoryId));
			},
			async repositoryNetwork(repositoryId: GithubId): Promise<RepositoryNetwork> {
				await latency(180);
				return networkOf(world(), repositoryId);
			},
			async saveRepositoryNetwork(repositoryId: GithubId, entries: string[]): Promise<RepositoryNetwork> {
				await latency(300);
				nameAtSave(world(), repositoryId);
				return saveNetworkList(world(), repositoryId, entries);
			},
			async dismissNetworkRequest(repositoryId: GithubId, host: string): Promise<RepositoryNetwork> {
				await latency(200);
				const kept = world().network.get(repositoryId);
				if (kept) kept.requests = kept.requests.filter(request => request.host !== host);
				return networkOf(world(), repositoryId);
			},
			async scanRepositoryNetwork(repositoryId: GithubId): Promise<NetworkScan> {
				await latency(900);
				const allowed = new Set([...networkOf(world(), repositoryId).hosts, ...MOCK_HOSTED.hosts]);
				const proposals = [
					{
						entry: "@gcs",
						hosts: ["storage.googleapis.com"],
						sources: ["package.json devDependencies.@playwright/test (Playwright's Chromium redirects there)"],
					},
					{
						entry: "@playwright",
						hosts: ["cdn.playwright.dev", "playwright.download.prss.microsoft.com"],
						sources: ["package.json devDependencies.@playwright/test", ".github/workflows/ci.yml line 24"],
					},
					{ entry: "@prisma", hosts: ["binaries.prisma.sh"], sources: ["package.json dependencies.@prisma/client"] },
					{ entry: "npm.pkg.github.com", hosts: ["npm.pkg.github.com"], sources: [".npmrc line 1"] },
					{
						entry: "sentry-cli.example-cdn.net",
						hosts: ["sentry-cli.example-cdn.net"],
						sources: ["package.json scripts.postinstall"],
					},
				].filter(proposal => !proposal.hosts.every(host => allowed.has(host)));
				return {
					proposals,
					commit: "4f1c2a9d0b7e3c5a8f6d2e1b0c9a8f7e6d5c4b3a",
					branch: "main",
					files: 9,
					incomplete: false,
				};
			},
			async repositorySecrets(repositoryId: GithubId, profile: SandboxProfileId): Promise<RepositorySecrets> {
				await latency(200);
				return secretsOf(world(), repositoryId, profile);
			},
			async saveRepositorySecret(
				repositoryId: GithubId,
				profile: SandboxProfileId,
				secret: { name: string; value?: string; scope: SecretScope },
			): Promise<RepositorySecrets> {
				await latency(340);
				nameAtSave(world(), repositoryId);
				saveSecret(world(), repositoryId, secret);
				return secretsOf(world(), repositoryId, profile);
			},
			async deleteRepositorySecret(
				repositoryId: GithubId,
				profile: SandboxProfileId,
				name: string,
			): Promise<RepositorySecrets> {
				await latency(280);
				world().secrets.get(repositoryId)?.delete(name);
				if (world().secrets.get(repositoryId)?.size === 0) world().secrets.delete(repositoryId);
				return secretsOf(world(), repositoryId, profile);
			},
			async setGuideCheck(id, enabled) {
				const { guideCheck } = repositoryViewOf(world(), id);
				world().guideChecks.set(id, { ...guideCheck, enabled });
				return repositoryViewOf(world(), id);
			},
			async setSetupWeekly(repositoryId, enabled) {
				if (enabled) await this.githubRepository(repositoryId);
				const current = world().readiness.get(repositoryId) ?? { at: now(), finished: false };
				world().readiness.set(repositoryId, { ...current, weekly: enabled });
			},
			async addSetupNotes(id, files) {
				const k = repositoryViewOf(world(), id).knowledge;
				const added = files.flatMap(f =>
					f.text
						.split(/\n(?=#{1,2} )/)
						.filter(Boolean)
						.map(text => ({ id: crypto.randomUUID(), label: f.label, text })),
				);
				world().knowledge.set(id, { ...k, notes: [...k.notes, ...added] });
				return repositoryViewOf(world(), id);
			},
			async deleteSetupNote(id, note) {
				const k = repositoryViewOf(world(), id).knowledge;
				world().knowledge.set(id, { ...k, notes: k.notes.filter(n => n.id !== note) });
				return repositoryViewOf(world(), id);
			},
			async runReadiness(repositoryId, selected = [], answers): Promise<RepositoryView> {
				const repo = await this.githubRepository(repositoryId);
				const k = repositoryViewOf(world(), repositoryId).knowledge;
				const pull = k.publication?.pull ?? {
					number: 42,
					url: `https://github.com/${repo.owner}/${repo.name}/pull/42`,
					state: "open" as const,
					title: "Add repository guides",
					branch: "windlass/repo-setup-" + new Date(now()).toISOString().slice(0, 10).replaceAll("-", ""),
					base: "main",
					pushedAt: now(),
					verified: "",
				};
				const { guideCheck } = repositoryViewOf(world(), repositoryId);
				if (guideCheck.enabled)
					world().guideChecks.set(repositoryId, {
						enabled: true,
						result: { conclusion: "success", title: "No new broken guide references", url: pull.url + "/checks" },
					});
				world().knowledge.set(repositoryId, {
					publication: { pull, files: ["AGENTS.md", "src/services/AGENTS.md"] },
					notes: k.notes.map(n =>
						!selected.includes(n.id)
							? n
							: {
									...n,
									decision: answers?.[n.id]
										? { noteId: n.id, verdict: "stale", reason: "No matching build record.", uses: [] }
										: {
												noteId: n.id,
												verdict: "question",
												question: "Does this note still apply to the current build?",
												reason: "The saved build does not confirm this note.",
												uses: [],
											},
								},
					),
				});
				world().readiness.set(repositoryId, {
					at: now(),
					finished: true,
					weekly: world().readiness.get(repositoryId)?.weekly ?? false,
				});
				return repositoryViewOf(world(), repositoryId);
			},
			async repository(repositoryId: GithubId): Promise<RepositoryView> {
				await latency(180);
				return repositoryViewOf(world(), repositoryId);
			},
			async githubRepository(repositoryId: GithubId): Promise<GithubRepository> {
				await latency(380);
				requireGithub(world());
				if (nextGithub === "list") {
					nextGithub = null;
					throw new PlatformError("user", "GitHub could not be reached. Try again in a moment.", {
						reason: "github_unreachable",
					});
				}
				const found =
					nextGithub === "gone" ? undefined : GITHUB_REPOSITORIES.find(repository => repository.id === repositoryId);
				if (nextGithub === "gone") nextGithub = null;
				if (!found)
					throw new PlatformError(
						"user",
						"That repository is not among the ones your GitHub connection covers. Add it to the GitHub App's installation at GitHub, then choose it again.",
						{ reason: "github_gone" },
					);
				// GitHub said what it is called now: what is saved for it goes by that name.
				world().names.set(repositoryId, `${found.owner}/${found.name}`);
				return describeRepository(found);
			},
			async saveRepositoryDefaults(
				repositoryId: GithubId,
				change: RepositoryDefaultsPatch,
			): Promise<RepositoryDefaults> {
				await latency(300);
				nameAtSave(world(), repositoryId);
				return saveDefaults(world(), machinesView(auth), repositoryId, change);
			},
			async forgetRepositoryApproval(repositoryId: GithubId, name: string): Promise<RepositoryView> {
				await serversLatency(360);
				if (nextServers === "forget") {
					nextServers = null;
					throw new PlatformError("user", "The approval could not be forgotten. Try again.");
				}
				const current = world();
				current.approvals = current.approvals.filter(
					approval => !(approval.project === `github:${repositoryId}` && approval.name === name),
				);
				return repositoryViewOf(current, repositoryId);
			},
			async forgetRepository(repositoryId: GithubId): Promise<RepositoryView> {
				await latency(420);
				const current = world();
				current.secrets.delete(repositoryId);
				current.setups.delete(repositoryId);
				current.checks.delete(repositoryId);
				current.readiness.delete(repositoryId);
				current.knowledge.delete(repositoryId);
				current.network.delete(repositoryId);
				current.defaults.delete(repositoryId);
				current.autonomy.delete(repositoryId);
				current.offers.delete(repositoryId);
				current.screenshotsEnabled.delete(repositoryId);
				current.approvals = current.approvals.filter(approval => approval.project !== `github:${repositoryId}`);
				current.names.delete(repositoryId);
				return repositoryViewOf(current, repositoryId);
			},
			async account(): Promise<AccountSettings> {
				await latency(180);
				return accountOf(world());
			},
			async saveAccountDefaults(change: AccountDefaultsPatch): Promise<AccountDefaults> {
				await latency(300);
				const current = world();
				// The same rules as a repository's defaults.
				current.account.defaults = changedDefaults(
					current.account.defaults,
					change,
					modelsFor(current.profile),
					machinesView(auth),
				);
				return accountDefaultsOf(current);
			},
			async savePersonalServer(server: {
				name: string;
				definition: unknown;
				unasked?: boolean;
				existing?: boolean;
			}): Promise<AccountSettings> {
				await latency(320);
				const current = world();
				const { name, definition } = mockCleanServer(server.name, server.definition);
				if (server.unasked !== undefined && typeof server.unasked !== "boolean")
					throw new PlatformError("user", "Whether a server's tools run without asking is true or false.", {
						reason: "bad_server",
					});
				const saved = current.account.servers.has(name);
				if (server.existing === true) {
					if (!saved)
						throw new PlatformError("user", `No server named ${name} is saved any more. Add it again.`, {
							reason: "server_not_found",
						});
				} else {
					if (saved)
						throw new PlatformError(
							"user",
							`A server named ${name} is saved already. Change that one, or give this one another name.`,
							{ reason: "server_exists" },
						);
					if (current.account.servers.size >= MAX_PERSONAL_SERVERS)
						throw new PlatformError(
							"user",
							`An account can keep ${MAX_PERSONAL_SERVERS} MCP servers, and yours has that many. Delete one first.`,
							{ reason: "too_many_servers" },
						);
				}
				current.account.servers.set(name, { definition, unasked: server.unasked === true, updatedAt: now() });
				return accountOf(current);
			},
			async deletePersonalServer(name: string): Promise<AccountSettings> {
				await latency(280);
				world().account.servers.delete(name);
				return accountOf(world());
			},
			async modelProviders() {
				return structuredClone(
					[...world().account.providers.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
				);
			},
			async saveModelProvider({ provider, key }) {
				const account = world().account;
				if (!isModelProvider(provider))
					throw new PlatformError("user", "Unknown model provider.", { reason: "bad_provider" });
				if (!validModelKey(provider, key))
					throw new PlatformError("user", "The key format does not match the provider.", { reason: "bad_model_key" });
				takeModelCheck(account);
				const model = {
					openai: "gpt-4.1",
					anthropic: "claude-sonnet-4",
					google: "gemini-2.5-flash",
					openrouter: "openai/gpt-4.1",
				}[provider];
				const at = now();
				const status = {
					provider,
					last4: key.slice(-4),
					addedAt: at,
					checkedAt: at,
					ok: true,
					models: [model],
					windlassModels: [model],
				};
				account.providers.set(provider, status);
				machinesChanged(auth);
				return structuredClone(status);
			},
			async checkModelProvider(provider) {
				const account = world().account;
				takeModelCheck(account);
				const status = account.providers.get(provider);
				if (!status)
					throw new PlatformError("user", "No key is saved for this provider.", { reason: "model_key_missing" });
				status.checkedAt = now();
				return structuredClone(status);
			},
			async removeModelProvider(provider) {
				world().account.providers.delete(provider);
				machinesChanged(auth);
			},
			async modelPlans() {
				return { allowed: true, plans: structuredClone(plansOf(world())) };
			},
			// The mock has no terminal: approving a code connects the named plan a few seconds later, as the command would.
			async approvePlanConnect(userCode, provider) {
				await latency(200);
				mockConnectCode(userCode);
				const mine = world();
				setTimeout(() => {
					const at = now();
					if (provider === "openai") {
						mine.planConnected = true;
						mine.planAddedAt = at;
						keep("wlp.mock.plan." + mine.profile.uid, "1");
					} else {
						mine.account.plans.set("anthropic", {
							provider: "anthropic",
							account: "you@example.com · Max",
							addedAt: at,
							checkedAt: at,
							ok: true,
							health: "ok",
							limitedUntil: null,
							resetKnown: false,
							windows: [],
							healthAt: null,
						});
					}
					machinesChanged(auth);
				}, 3_000);
			},
			async denyPlanConnect(userCode) {
				await latency(200);
				mockConnectCode(userCode);
			},
			async removeModelPlan(provider) {
				if (provider === "openai") await userApi(auth).forgetChatgpt();
				else world().account.plans.delete(provider);
				machinesChanged(auth);
			},
			async recheckModelPlan(provider) {
				await latency(400);
				return structuredClone(plansOf(world()).find(p => p.provider === provider) ?? null);
			},
			async payWith() {
				await latency(160);
				return payWithOf(world());
			},
			async savePayWith(input) {
				await latency(240);
				let patch: PayWithPatch;
				try {
					patch = payWithPatchOf(input);
				} catch (problem) {
					if (problem instanceof PayWithProblem)
						throw new PlatformError("user", problem.message, { reason: "bad_input" });
					throw problem;
				}
				world().payWith.set(patch.harness, { ...patch, updatedAt: now() });
				return payWithOf(world());
			},
			async accountSecrets(profile: SandboxProfileId): Promise<AccountSecrets> {
				await latency(200);
				return accountSecretsOf(world(), profile);
			},
			async saveAccountSecret(
				profile: SandboxProfileId,
				secret: { name: string; value?: string; scope: SecretScope },
			): Promise<AccountSecrets> {
				await latency(340);
				const current = world();
				// The rules of a repository's secret for the name, the scope and the value; without a value, only the scope changes.
				checkSecretName(secret.name);
				if (secret.scope !== "setup" && secret.scope !== "agent")
					throw new PlatformError(
						"user",
						"A secret is for the setup command and MCP servers, or for the agent's commands as well.",
						{ reason: "bad_secret" },
					);
				if (secret.value === undefined) {
					if (!current.account.secrets.has(secret.name))
						throw new PlatformError("user", `No secret named ${secret.name} is saved for your account.`, {
							reason: "secret_not_found",
						});
				} else {
					checkSecretValue(secret.value);
					if (!current.account.secrets.has(secret.name) && current.account.secrets.size >= MAX_ACCOUNT_SECRETS) {
						throw new PlatformError(
							"user",
							`An account can keep ${MAX_ACCOUNT_SECRETS} secrets, and yours has that many. Delete one first.`,
							{ reason: "too_many_secrets" },
						);
					}
				}
				current.account.secrets.set(secret.name, { scope: secret.scope, updatedAt: now() });
				return accountSecretsOf(current, profile);
			},
			async deleteAccountSecret(profile: SandboxProfileId, name: string): Promise<AccountSecrets> {
				await latency(280);
				world().account.secrets.delete(name);
				return accountSecretsOf(world(), profile);
			},
			async savedRepositories(): Promise<SavedRepository[]> {
				await latency(200);
				const current = world();
				// A deployment that never had a GitHub App has nothing saved for a repository.
				if (!githubOn) return [];
				const ids = new Set<GithubId>([
					...current.setups.keys(),
					...current.checks.keys(),
					...current.network.keys(),
					...current.secrets.keys(),
					...current.defaults.keys(),
					...current.screenshotsEnabled.keys(),
				]);
				for (const approval of current.approvals) {
					const id = githubId(/^github:([1-9][0-9]*)$/.exec(approval.project)?.[1]);
					if (id !== null && approval.expiresAt > now()) ids.add(id);
				}
				return [...ids]
					.map(id => ({ id, name: repositoryNameOf(current, id) }))
					.sort(
						(a, b) =>
							Number(a.name === null) - Number(b.name === null) ||
							(a.name ?? "").localeCompare(b.name ?? "") ||
							String(a.id).localeCompare(String(b.id), "en", { numeric: true }),
					);
			},
			async githubConnect(page: string): Promise<{ url: string }> {
				await latency(420);
				const { profile } = world();
				if (!githubOn)
					throw new PlatformError("user", "This deployment has no GitHub App, so GitHub cannot be connected here.", {
						reason: "github_off",
					});
				const failing = nextGithub === "connect";
				if (failing) nextGithub = null;
				// Where the real server sends the browser back to once GitHub has answered: the web app, with a ticket.
				const mock = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("mock");
				return {
					url: `${page}/${mock !== null ? `?mock=${encodeURIComponent(mock)}` : ""}#${failing ? "github-error=denied" : `github=mock.${profile.uid}`}`,
				};
			},
			async githubComplete(ticket: string): Promise<GithubStatus> {
				await latency(380);
				const current = world();
				if (!ticket.startsWith("mock."))
					throw new PlatformError("user", "This link to connect GitHub is not valid any more. Connect GitHub again.", {
						reason: "github_ticket",
					});
				if (ticket !== `mock.${current.profile.uid}`)
					throw new PlatformError(
						"user",
						"This GitHub connection was started from another Windlass account, so it was not added to yours. Connect GitHub again from here.",
						{ reason: "github_ticket" },
					);
				current.github = { ...connectionFor(current.profile), connectedAt: now() };
				keep(`wlp.mock.github.${current.profile.uid}`, "1");
				return { connection: current.github };
			},
			async githubDisconnect(): Promise<GithubStatus> {
				await latency(260);
				const current = world();
				current.github = null;
				keep(`wlp.mock.github.${current.profile.uid}`, "0");
				return { connection: null };
			},
			async githubRepositories(query: string): Promise<GithubRepositoryList> {
				await latency(query === "" ? 420 : 260);
				requireGithub(world());
				if (nextGithub === "list") {
					nextGithub = null;
					throw new PlatformError("user", "GitHub could not be reached. Try again in a moment.", {
						reason: "github_unreachable",
					});
				}
				const wanted = query.trim().toLowerCase();
				// As the server orders them: a name that begins with what was typed first, then the most recently pushed.
				const rank = (repository: MockRepository) =>
					wanted === "" ||
					repository.name.toLowerCase().startsWith(wanted) ||
					`${repository.owner}/${repository.name}`.toLowerCase().startsWith(wanted)
						? 0
						: 1;
				const matching = GITHUB_REPOSITORIES.filter(repository =>
					`${repository.owner}/${repository.name}`.toLowerCase().includes(wanted),
				).sort((a, b) => rank(a) - rank(b) || a.pushedHoursAgo - b.pushedHoursAgo);
				return { repositories: matching.map(describeRepository), more: false, incomplete: false };
			},
			async githubStarterIssues(repositoryId: GithubId): Promise<StarterIssue[]> {
				await latency(380);
				requireGithub(world());
				const found = GITHUB_REPOSITORIES.find(repository => repository.id === repositoryId);
				if (!found) return [];
				const url = `${GITHUB.url}/${found.owner}/${found.name}/issues/`;
				// Only the first repository has open bugs, so the generic starter tasks show for the others.
				return found.id === GITHUB_REPOSITORIES[0]!.id
					? [
							{ number: 142, title: "Tide table shows yesterday after midnight UTC", url: `${url}142` },
							{ number: 157, title: "Harbor map pins overlap on small screens", url: `${url}157` },
						]
					: [];
			},
			async githubBranches(repositoryId: GithubId): Promise<GithubBranchList> {
				await latency(320);
				requireGithub(world());
				const found = GITHUB_REPOSITORIES.find(repository => repository.id === repositoryId);
				if (!found)
					throw new PlatformError(
						"user",
						"That repository is not among the ones your GitHub connection covers. Add it to the GitHub App's installation at GitHub, then choose it again.",
					);
				return { branches: found.branches, defaultBranch: found.defaultBranch, more: false };
			},
			async allowance(): Promise<UsageNumbers> {
				await latency(160);
				return usageNumbers(world());
			},
			async usage(): Promise<UsageView> {
				await latency(320);
				return usageView(world());
			},
			async costRates(): Promise<CostRates> {
				await latency(200);
				return {
					...structuredClone(MOCK_MODEL_PRICES),
					sandbox: Object.fromEntries(MOCK_SIZES.map(size => [size.id, size.usdPerHour])),
				};
			},
			async billing(): Promise<BillingView> {
				await latency(200);
				return billingView(realNow());
			},
			async billingCheckout(input: { period: BillingPeriod; origin: string }): Promise<{ url: string }> {
				await latency(500);
				if (billingState === "exempt")
					throw new PlatformError("user", "Billing doesn't apply to this account.", { reason: "billing_off" });
				if (billingState === "off")
					throw new PlatformError("user", "This deployment has no plans or billing.", { reason: "billing_off" });
				if (billing.plan === "pro")
					throw new PlatformError("user", "You already have Pro. Manage it from Settings.", {
						reason: "already_subscribed",
					});
				// The mock has no checkout page: it plays one that was paid at once and comes back to Settings.
				billing.plan = "pro";
				billing.status = "active";
				billing.period = input.period;
				billing.start = realNow();
				billing.usedMinutes = 0;
				return { url: `${input.origin}/settings?mock=1&billing=pro&checkout=${input.period}#plan` };
			},
			async billingPortal(input: { origin: string }): Promise<{ url: string }> {
				await latency(400);
				if (billingState === "exempt")
					throw new PlatformError("user", "Billing doesn't apply to this account.", { reason: "billing_off" });
				if (billing.plan !== "pro")
					throw new PlatformError("user", "There is no subscription to manage yet.", { reason: "no_customer" });
				return { url: `${input.origin}/settings?mock=1&billing=${billingState}#plan` };
			},
			async setOverageCap(input: { cents: number }): Promise<BillingView> {
				await latency(300);
				if (billingState === "exempt")
					throw new PlatformError("user", "Billing doesn't apply to this account.", { reason: "billing_off" });
				if (billing.period === "year")
					throw new PlatformError("user", "Yearly Pro has no overage spend cap.", { reason: "bad_input" });
				if (!Number.isSafeInteger(input.cents) || input.cents < 0 || input.cents > 2000)
					throw new PlatformError("user", "Set the cap in whole cents from 0 to 2000.", { reason: "bad_input" });
				billing.capCents = input.cents;
				return billingView(realNow());
			},
			async freeSandbox(sessionId: string): Promise<UsageView> {
				await latency(700);
				const session = world().sessions.get(sessionId);
				if (!session || session.summary.sandbox === "none") return usageView(world());
				if (session.summary.status !== "idle")
					throw new PlatformError(
						"user",
						`${session.summary.title} is working. Stop its turn first, then free its sandbox.`,
						{ reason: "sandbox_busy" },
					);
				cancel(session.pauseTimer);
				session.pauseTimer = null;
				session.files.clear();
				store(session, { turn: session.summary.turns, kind: "platform", level: "info", text: MOCK_FREED_NOTE });
				setSummary(world(), session, { sandbox: "none" });
				return usageView(world());
			},
			watch(feed: UserFeed) {
				let closed = false;
				feed.onConnection?.("connecting");
				later(120, () => {
					if (closed) return;
					try {
						const current = world();
						current.feeds.add(feed);
						feed.onConnection?.("connected");
						feed.onSessions(listOf(current));
					} catch (error) {
						feed.onConnection?.("failed", asPlatformError(error));
					}
				});
				return () => {
					closed = true;
					worlds.get(auth.profile.uid)?.feeds.delete(feed);
				};
			},
		};
	}

	const snapshotOf = (session: MockSession): SessionSnapshot => ({
		summary: session.summary,
		profile: profileOf(session),
		windlassSessionId: session.windlassSessionId,
		timeline: [...session.timeline],
		pending: [...session.pending],
		question: session.question,
		...(!session.summary.item && session.secretRequest && { secretRequest: session.secretRequest }),
		...(session.summary.place.kind === "machine" ? { machine: session.machine?.reach ?? null } : {}),
	});

	function sessionApi(auth: AuthResult, id: string): SessionApi {
		const find = (): { world: World; session: MockSession } => {
			const world = worldOf(auth);
			const session = world.sessions.get(id);
			if (!session) throw new PlatformError("not_found", "There is no agent at this address.");
			const turn = session.seededTurn;
			if (turn) {
				delete session.seededTurn;
				turn();
			}
			return { world, session };
		};
		const api: SessionApi = {
			open(feed: SessionFeed) {
				let closed = false;
				feed.onConnection("connecting");
				later(160, () => {
					if (closed) return;
					try {
						const { session } = find();
						session.feeds.add(feed);
						feed.onConnection("connected");
						feed.onSnapshot(snapshotOf(session));
						blipMachine(auth, session);
					} catch (error) {
						feed.onConnection("failed", asPlatformError(error));
					}
				});
				return () => {
					closed = true;
					worlds.get(auth.profile.uid)?.sessions.get(id)?.feeds.delete(feed);
				};
			},
			resync() {
				later(60, () => {
					const session = worlds.get(auth.profile.uid)?.sessions.get(id);
					if (session) for (const feed of session.feeds) feed.onSnapshot(snapshotOf(session));
				});
			},
			async prompt(input: PromptInput) {
				await latency(180);
				const { world, session } = find();
				// As the server: a work item's agent takes its prompts from the item's steps only, and this is asked before anything else.
				if (session.summary.item) throw new PlatformError("user", ITEM_SESSION_PROMPT, { reason: "item_session" });
				const text = input.text.trim();
				if (text === "") throw new PlatformError("user", "Write something for the agent to do.");
				if (text.length > MAX_PROMPT_CHARS)
					throw new PlatformError(
						"user",
						`A prompt can be at most ${MAX_PROMPT_CHARS.toLocaleString("en")} characters.`,
					);
				// With a key, a message that was taken before is answered as it was then, and nothing is added.
				const key = keyOf(input.idempotencyKey);
				const taken = takenUnder(session.submissions, key, text, "message to this agent");
				if (taken) return taken;
				const take = (answer: { turn: number; steered: boolean }) => {
					if (key !== null) session.submissions.set(key, { content: text, answer });
					// As the server: a turn that starts closes the open secret request.
					if (!answer.steered) delete session.secretRequest;
					return answer;
				};
				const status = session.summary.status;
				// As the server: a paused turn takes no new turn; the message is held, and given to the agent when the turn resumes.
				if (status === "paused") {
					const turn = session.summary.turns;
					store(session, {
						turn,
						kind: "user",
						text,
						model: session.summary.model,
						effort: session.summary.effort ?? null,
						steer: true,
						held: true,
					});
					const paused = session.summary.paused;
					setSummary(world, session, {
						updatedAt: now(),
						...(paused && { paused: { ...paused, held: paused.held + 1 } }),
					});
					return take({ turn, steered: true });
				}
				if (status === "starting")
					throw new PlatformError("user", "The agent is still starting. Send this again once it is working.", {
						reason: "steer_unavailable",
					});
				if (status === "stopping")
					throw new PlatformError("user", "The turn is stopping. Send this again once it has stopped.", {
						reason: "steer_unavailable",
					});
				if ((status === "running" || status === "waiting") && session.run && session.summary.harness === "opencode")
					throw new PlatformError("user", "OpenCode cannot steer this turn.", { reason: "steer_unavailable" });
				if ((status === "running" || status === "waiting") && session.run && session.summary.harness === "claude") {
					// Claude Code takes it through its steering extension: the server stores it as a steer.
					if (input.model || input.effort)
						throw new PlatformError("user", "Choose the model and effort when starting a turn.", {
							reason: "bad_input",
						});
					const turn = session.run.turn;
					store(session, {
						turn,
						kind: "user",
						text,
						model: session.summary.model,
						effort: session.summary.effort ?? null,
						steer: true,
					});
					setSummary(world, session, { updatedAt: now() });
					return take({ turn, steered: true });
				}
				if ((status === "running" || status === "waiting") && session.run) {
					// A message to a running turn steers it: stored as a steer, delivered at the next step.
					const turn = session.run.turn;
					store(session, {
						turn,
						kind: "user",
						text,
						model: session.summary.model,
						effort: session.summary.effort ?? null,
						steer: true,
					});
					const messageId = `msg_${hex(24)}`;
					emit(
						session,
						turn,
						windlassEvent(session, "inbox.enqueued", {
							messageId,
							origin: null,
							delivery: "steer",
							content: [{ type: "text", text }],
						}),
					);
					session.run.steers.push(messageId);
					setSummary(world, session, { updatedAt: now() });
					return take({ turn, steered: true });
				}
				// As the server's Pay with (`?plans=limited`): hosted Claude Code on a limited plan asks, where a key could pay instead.
				if (
					session.summary.place.kind === "hosted" &&
					session.summary.harness === "claude" &&
					options.plans === "limited" &&
					input.payWith !== "key" &&
					world.account.plans.has("anthropic")
				) {
					const until = planHealth().limitedUntil!;
					const time = new Date(until).toISOString().slice(11, 16);
					if (world.account.providers.get("anthropic")?.ok)
						throw new PlatformError(
							"user",
							`Your Claude plan is limited until ${time} UTC. Wait for it, or pay for this turn with your Anthropic key.`,
							{ reason: PLAN_ASK },
						);
					throw new PlatformError("user", `Your Claude plan is limited until ${time} UTC. Send this again then.`, {
						reason: PLAN_LIMITED,
					});
				}
				// The ceiling is on hosted sandboxes (`FactoryLimits.hostedRunning`): the person's own and their items' on the platform's sandboxes; nothing on the user's machines is counted or refused.
				const hosted = session.summary.place.kind === "hosted";
				const running = [...world.sessions.values()].filter(
					other => other.summary.status !== "idle" && other.summary.place.kind === "hosted",
				).length;
				if (hosted && running >= MOCK_FACTORY_LIMITS.hostedRunning)
					throw new PlatformError(
						"user",
						`You already have ${running} ${running === 1 ? "agent" : "agents"} working on this platform, the most it runs for you at once. Agents on your machines don't count. Wait for one to finish, or stop one.`,
						{ reason: "too_many_running" },
					);
				// A Claude Code agent's turn: the models are the ones it listed, and the machine's report says whether it is signed in.
				const harness = session.summary.harness;
				if (harness && harness !== "windlass") {
					const name = HARNESS_NAMES[harness];
					const unreachable = machineUnreachable(auth, session);
					const place = session.summary.place;
					const machine =
						place.kind === "machine" ? machinesView(auth).find(one => one.machineId === place.machineId) : undefined;
					const offered = machine?.harnesses?.find(one => one.id === harness);
					if (hosted && !hostedPayer(harness, input.model ?? session.summary.model, hostedCredentialsOf(world)))
						throw new PlatformError("user", hostedKeyMessage(harness), { reason: "harness_signed_out" });
					if (!hosted && unreachable === null && !offered)
						throw new PlatformError("user", `This machine does not offer ${name}.`, { reason: "bad_input" });
					if (unreachable === null && offered?.signIn === "none")
						throw new PlatformError(
							"user",
							offered.paysWith
								? `Nothing can pay for ${name} on “${machine?.name ?? "your machine"}” yet. Connect a plan or add a key on Connections.`
								: `${name} on “${machine?.name ?? "your machine"}” is not signed in. Run windlass-runner login ${harness} there.`,
							{ reason: "harness_signed_out" },
						);
					const listed = session.summary.harnessModels ?? null;
					if (input.model !== undefined && !(listed?.models ?? [{ id: "default" }]).some(one => one.id === input.model))
						throw new PlatformError("user", `${name} offers no model "${input.model}".`, { reason: "bad_model" });
					// As the server: absent keeps the session's effort, null or "" is the default. A new model's efforts are known once it is selected.
					let effort = input.effort === undefined ? (session.summary.effort ?? null) : input.effort || null;
					const offeredEfforts =
						listed?.models.find(one => one.id === (input.model ?? session.summary.model))?.efforts ?? [];
					if (
						(!input.model || input.model === session.summary.model) &&
						effort !== null &&
						!offeredEfforts.includes(effort)
					) {
						if (input.effort !== undefined)
							throw new PlatformError("user", `${name} offered no such effort.`, { reason: "bad_effort" });
						effort = null;
					}
					const turn = session.summary.turns + 1;
					if (unreachable !== null) {
						play(
							session,
							plan(
								world,
								session,
								{ ...input, text, effort },
								{ events: [], platformFailure: unreachable, unreachable: true },
							),
						);
						return take({ turn, steered: false });
					}
					play(
						session,
						acpTurn(
							world,
							session,
							{ ...input, text, effort },
							harness === "claude"
								? claudeScript(session, text)
								: {
										entries: [
											{
												wait: 200,
												update: {
													sessionUpdate: "agent_message_chunk",
													content: { type: "text", text: `${HARNESS_NAMES[harness]} completed the mock turn.` },
												},
											},
										],
										stopReason: "end_turn",
									},
						),
					);
					return take({ turn, steered: false });
				}
				const requested = input.model || session.summary.model;
				const provider = windlassProvider(requested);
				if (provider && !world.account.providers.has(provider))
					throw new PlatformError("user", hostedKeyMessage("windlass", requested), { reason: "harness_signed_out" });
				if (session.windlassSessionId && provider !== windlassProvider(session.summary.model))
					throw new PlatformError("user", "Start a new Windlass session to change providers.", { reason: "bad_model" });
				const models = modelsFor(world.profile);
				if (input.model !== undefined) checkModel(models, input.model);
				// The effort as the server holds it (`turnEffort`): absent keeps the session's, which gives way to the default where the turn's model does not take it.
				let effort: string | null;
				try {
					effort = turnEffort(
						input.effort,
						session.summary.effort ?? null,
						input.model ?? session.summary.model,
						models,
					);
				} catch (problem) {
					throw new PlatformError("user", (problem as Error).message, { reason: "bad_effort" });
				}
				// The user's two limits, as the server holds a prompt to them: time for the sandbox to run on, and a place for one the agent does not have. Not on the user's own machine.
				const numbers = usageNumbers(world);
				if (hosted && (numbers.leftSeconds ?? 0) < numbers.startSeconds)
					throw new PlatformError("user", mockAllowanceRefusal(numbers), { reason: "allowance_used" });
				if (
					hosted &&
					session.summary.sandbox === "none" &&
					numbers.sandboxes.limit !== null &&
					numbers.sandboxes.kept >= numbers.sandboxes.limit
				)
					throw new PlatformError("user", mockSandboxRefusal(numbers), { reason: "too_many_sandboxes" });
				// A machine that cannot be reached fails the turn at once, with the server's sentence, as the server's turn does when its sandbox cannot be opened.
				const unreachable = machineUnreachable(auth, session);
				if (unreachable !== null) {
					const turn = session.summary.turns + 1;
					play(
						session,
						plan(
							world,
							session,
							{ ...input, text, effort },
							{ events: [], platformFailure: unreachable, unreachable: true },
						),
					);
					return take({ turn, steered: false });
				}
				const name = chooseScript(text, world.rotation);
				if (ROTATION[world.rotation % ROTATION.length] === name) world.rotation += 1;
				// A second plain answer in one session uses the recording's second run.
				const recording: Script =
					name === "answer" && session.windlassSessionId !== null ? SCRIPTS.answerAgain : SCRIPTS[name];
				const server = chooseServer(text);
				const script: Script = server ? { ...recording, server } : recording;
				const turn = session.summary.turns + 1;
				play(session, plan(world, session, { ...input, text, effort }, script));
				return take({ turn, steered: false });
			},
			async answer(input: { questionId: string; choice: string; note?: string }) {
				await latency(220);
				const { world, session } = find();
				const forced = nextAnswer;
				nextAnswer = null;
				if (forced === "error")
					throw new PlatformError("network", "The server did not answer, so your answer was not sent. Try again.");
				const question = session.question;
				if (forced === "elsewhere" && question)
					settle(world, session, question.choices.find(choice => choice.approve)?.id ?? "once", null);
				// A server's question that stands aside for a tool call's can still be answered.
				const aside = session.aside;
				if (
					aside &&
					aside.question.id === input.questionId &&
					aside.question.choices.some(choice => choice.id === input.choice)
				) {
					session.aside = null;
					aside.resume(input.choice, null);
					return;
				}
				if (!session.question || session.question.id !== input.questionId) {
					throw new PlatformError(
						"user",
						forced === "elsewhere"
							? "This question was already answered in another tab."
							: "This question is no longer waiting for an answer: it was answered elsewhere, it expired, or the turn was stopped.",
						{ reason: "no_question" },
					);
				}
				if (!session.question.choices.some(choice => choice.id === input.choice))
					throw new PlatformError("user", "That is not one of the question's answers.");
				const note = input.note?.trim() ?? "";
				if (session.question.messageId === "acp" && note !== "")
					throw new PlatformError(
						"user",
						`${HARNESS_NAMES[session.summary.harness ?? "windlass"]} takes a choice without a note.`,
						{ reason: "bad_input" },
					);
				if (note.length > MAX_NOTE_CHARS)
					throw new PlatformError("user", `A note can be at most ${MAX_NOTE_CHARS} characters.`);
				settle(world, session, input.choice, note === "" ? null : note);
			},
			async stopCall(input: { messageId: string; callId: string }) {
				await latency(120);
				const { session } = find();
				if (!session.summary.capabilities.cancelCall)
					return {
						stopped: false,
						message: `${HARNESS_NAMES[session.summary.harness ?? "windlass"]} cannot stop one call. Stop the turn instead.`,
					};
				return stopOneCall(session, input.messageId, input.callId);
			},
			async stop() {
				await latency(90);
				const { world, session } = find();
				// A paused turn has nothing running: it ends now, and does not resume.
				if (session.summary.status === "paused" && !session.run) {
					const turn = session.summary.turns;
					store(session, {
						turn,
						kind: "platform",
						level: "info",
						text: "You stopped the paused turn, so it will not resume.",
					});
					store(session, {
						turn,
						kind: "turn.ended",
						outcome: "stopped",
						exitCode: null,
						steps: null,
						durationMs: 0,
						usage: null,
						cachedShare: null,
						message: null,
						verified: null,
					});
					setSummary(world, session, { status: "idle", paused: undefined, lastOutcome: "stopped", updatedAt: now() });
					return;
				}
				if (session.run?.acp) interruptAcp(world, session);
				else interrupt(world, session);
			},
			async changes(): Promise<WorkspaceFile[]> {
				await latency(200);
				const { session } = find();
				return [...session.files.entries()]
					.map(([path, change]) => ({ path, status: change.status }))
					.sort((a, b) => a.path.localeCompare(b.path));
			},
			async diff() {
				await latency(320);
				const { session } = find();
				return [...session.files.entries()]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, change]) => change.diff)
					.join("");
			},
			async publishState(): Promise<PublishState> {
				await latency(240);
				return publishStateOf(find().session);
			},
			async servers(): Promise<SessionServers> {
				const forced = nextServers === "list";
				if (forced) nextServers = null;
				await serversLatency(180);
				if (forced)
					throw new PlatformError(
						"network",
						"The server did not answer, so the project's MCP servers could not be read. Try again.",
					);
				const { world, session } = find();
				return serversOf(world, session);
			},
			async approveServer(name: string, fingerprint: string): Promise<SessionServers> {
				const forced = nextServers === "approve";
				if (forced) nextServers = null;
				await serversLatency(260);
				if (forced) throw new PlatformError("user", "The approval could not be remembered. Try again.");
				const { world, session } = find();
				const server = session.servers.find(known => known.name === name);
				if (!server)
					throw new PlatformError("user", "This session's project no longer names an MCP server of that name.", {
						reason: "server_gone",
					});
				if (server.state !== "waiting" || server.fingerprint !== fingerprint) {
					throw new PlatformError(
						"user",
						`The MCP server "${name}" no longer waits with the definition shown here. Read the list again and look at it once more.`,
						{ reason: "server_changed" },
					);
				}
				// A question about it is open: this answers it, and the server starts now.
				const aside = session.aside;
				if (session.question?.server?.name === name) settle(world, session, "start", null);
				else if (aside?.question.server?.name === name) {
					session.aside = null;
					aside.resume("start", null);
				} else {
					remember(world, session, name, fingerprint);
					store(session, {
						turn: session.summary.turns,
						kind: "platform",
						level: "info",
						text: `Approved the MCP server "${name}" for this project in the session's panel. ${server.remote ? "Windlass connects to it" : "It starts"} with the next turn.`,
					});
					serversChanged(world, session);
				}
				return serversOf(world, session);
			},
			async allowHost(host: string): Promise<HostAllowed> {
				await latency(400);
				const { world, session } = find();
				const repository = session.summary.repository;
				if (!repository)
					throw new PlatformError(
						"user",
						"This agent has no repository of your GitHub connection, so there is no list to allow a host in. The deployment's operator can allow it for every sandbox, in WLP_E2B_NETWORK_ALLOW.",
						{ reason: "bad_network" },
					);
				const kept = world.network.get(repository.id)?.entries ?? [];
				const network = kept.includes(host)
					? networkOf(world, repository.id)
					: saveNetworkList(world, repository.id, [...kept, host]);
				// As the server: at once only while a turn holds the sandbox.
				const applied = session.summary.sandbox === "running" && session.summary.status === "running";
				const label = `${repository.owner}/${repository.name}`;
				store(session, {
					turn: session.summary.turns,
					kind: "platform",
					level: "info",
					text: `${host} is allowed for ${label}. ${applied ? "This sandbox reaches it now; for the repository's other hosted agents it applies from the next turn." : "It applies from the next turn, in this agent's sandbox and the repository's other hosted agents'."}`,
				});
				return { network, applied };
			},
			async setRequestedSecret(input: SetRequestedSecretInput): Promise<void> {
				await latency(320);
				const { world, session } = find();
				const tooShort = () => typeof input.value !== "string" || input.value.trim().length < MIN_SECRET_VALUE_CHARS;
				const shortWords = `A secret's value must be at least ${MIN_SECRET_VALUE_CHARS} characters long: a shorter one could not be taken out of what the platform shows.`;
				// Saved for the repository with agent scope, or for the account without one. The value is not kept: nothing in the mock would read it.
				const save = (repositoryId: GithubId | null, name: string) =>
					(repositoryId === null
						? world.account.secrets
						: (world.secrets.get(repositoryId) ?? world.secrets.set(repositoryId, new Map()).get(repositoryId)!)
					).set(name, { scope: "agent", updatedAt: now() });
				// An item's builder: the item's question is answered, as work-item.ts does, or asked again under a new id when the save is refused.
				if (session.summary.item) {
					if (tooShort()) throw new PlatformError("user", shortWords, { reason: "bad_secret" });
					const saved = items.setRequestedSecret(auth, id, input.requestId, input.name, repositoryId =>
						requestedSecretConflict(world, repositoryId, input.name, "person"),
					);
					if (!saved)
						throw new PlatformError("user", "That secret request is no longer open.", { reason: "item_conflict" });
					save(saved.id, input.name);
					return;
				}
				const request = session.secretRequest;
				if (!request || request.id !== input.requestId || request.name !== input.name)
					throw new PlatformError("user", "That secret request is no longer open.", { reason: "no_question" });
				if (tooShort()) throw new PlatformError("user", shortWords, { reason: "bad_secret" });
				if (session.summary.status !== "idle")
					throw new PlatformError("user", "The session is busy. Try again when the turn has ended.", {
						reason: "turn_running",
					});
				// A name saved under Secrets since it was asked: refused, and the request stays open, as agent-session.ts does.
				const repositoryId = session.summary.repository?.id ?? null;
				const conflict = requestedSecretConflict(world, repositoryId, request.name);
				if (conflict) throw new PlatformError("user", conflict, { reason: "secret_exists" });
				save(repositoryId, request.name);
				const text = `${request.name} is now set in your environment.`;
				await api.prompt({ text });
			},
			async forgetServer(name: string): Promise<SessionServers> {
				const forced = nextServers === "forget";
				if (forced) nextServers = null;
				await serversLatency(220);
				if (forced) throw new PlatformError("user", "The approval could not be forgotten. Try again.");
				const { world, session } = find();
				const project = mockProject(session.summary).key;
				const kept = world.approvals.filter(approval => !(approval.project === project && approval.name === name));
				if (kept.length < world.approvals.length) {
					world.approvals = kept;
					store(session, {
						turn: session.summary.turns,
						kind: "platform",
						level: "info",
						text: `Forgot your approval of the MCP server "${name}" for this project. The next session or sandbox asks again; where it already started, Windlass's own record still starts it.`,
					});
					serversChanged(world, session);
				}
				return serversOf(world, session);
			},
			async publish(message: PublishMessage): Promise<PublishResult> {
				// A commit, a push and a call to GitHub: it takes a moment.
				await latency(1700);
				const { world, session } = find();
				const repository = session.summary.repository;
				if (!repository)
					throw new PlatformError(
						"user",
						"This agent does not work on a repository of your GitHub connection, so there is nowhere to push.",
						{ reason: "publish_blocked" },
					);
				const blocked = publishStateOf(session).blocked;
				if (blocked) throw new PlatformError("user", blocked, { reason: "publish_blocked" });
				if (message.title.trim() === "")
					throw new PlatformError("user", "Give the commit a title.", { reason: "bad_message" });
				if (!world.github) throw new PlatformError("user", GITHUB_NOT_CONNECTED, { reason: "github_gone" });
				const name = `${repository.owner}/${repository.name}`;
				const current = session.summary.pullRequest ?? null;
				const open = current !== null && (current.state === "open" || current.state === "draft") ? current : null;
				const branch = current?.branch ?? branchFor(session);
				const failure = nextGithub;
				if (failure === "denied" || failure === "protected" || failure === "gone") {
					nextGithub = null;
					const sentence = {
						denied: `${world.github.login} can read ${name} on GitHub but not write to it, so the platform cannot push there for you. Ask an owner of ${repository.owner} for write access, then push again.`,
						protected: `GitHub refused the push: a rule of ${name} protects branches named like ${branch}. Let the GitHub App create such branches in the repository's branch rules, then push again.`,
						gone: `${name} is no longer on GitHub, or the GitHub App can no longer see it. Check that the repository exists and that the app's installation on ${repository.owner} still includes it.`,
					}[failure];
					throw new PlatformError("user", sentence, { reason: failure === "gone" ? "github_gone" : "github_denied" });
				}
				const files = session.files.size;
				// Nothing new: refused, unless the branch is pushed and no pull request was opened from it, which is then opened from what is there (github/publish.ts `publishWork`).
				const fromPushed = files === 0 && current === null && session.pushedHead !== null;
				if (files === 0 && !fromPushed) {
					throw new PlatformError(
						"user",
						open
							? `There is nothing to push: ${branch} at GitHub already has everything in the workspace.`
							: `There is nothing to open a pull request with: the workspace has no changes and no commit that ${repository.branch} does not have.`,
						{ reason: "publish_failed" },
					);
				}
				const what = fromPushed ? "the agent's commits" : files === 1 ? "1 file" : `${files} files`;
				let pull: PullRequestInfo;
				// The description's section is written with every push: what it says in a few words is kept with the pull request.
				const verified = verifiedWords(session.verified);
				if (open) {
					pull = { ...open, pushedAt: now(), verified };
					store(session, {
						turn: session.summary.turns,
						kind: "platform",
						level: "info",
						text: `Pushed ${what} to ${branch}; pull request #${open.number} is updated. Its description reports: ${verified}.`,
					});
				} else {
					const number = world.nextPull++;
					pull = {
						number,
						url: `${repository.url}/pull/${number}`,
						state: "open",
						title: message.title.trim(),
						branch,
						base: repository.branch,
						pushedAt: now(),
						verified,
					};
					store(session, {
						turn: session.summary.turns,
						kind: "platform",
						level: "info",
						text: `Opened pull request #${number} in ${name} from ${branch}, with ${what}. Its description reports: ${verified}.`,
					});
				}
				// Committed: nothing differs from the last commit any more.
				session.files.clear();
				session.pushed = true;
				if (!fromPushed) session.pushedHead = hex(40);
				setSummary(world, session, { pullRequest: pull, updatedAt: now() });
				return { state: publishStateOf(session), opened: !open };
			},
			async setMode(mode: string): Promise<SessionSummary> {
				await latency();
				const { world, session } = find();
				if (session.summary.item || !session.summary.availableModes.some(m => m.id === mode))
					throw new PlatformError("user", "Choose a mode offered by this agent.", { reason: "bad_input" });
				if (session.run?.acp) session.run.acp.modeQueued = true;
				setSummary(world, session, { mode });
				return session.summary;
			},
			async setPublishUnasked(unasked: boolean): Promise<SessionSummary> {
				await latency();
				const { world, session } = find();
				if (!session.summary.repository)
					throw new PlatformError(
						"user",
						"This agent does not work on a repository of your GitHub connection, so it has nowhere to publish to.",
						{ reason: "publish_blocked" },
					);
				if ((session.summary.publishUnasked === true) !== unasked) {
					store(session, {
						turn: session.summary.turns,
						kind: "platform",
						level: "info",
						text: unasked
							? "You let the agent publish this session's work without asking, in the session's panel."
							: "You turned off publishing without asking in the session's panel: the agent's next request to publish is put to you.",
					});
					setSummary(world, session, { publishUnasked: unasked });
				}
				return session.summary;
			},
		};
		return api;
	}

	return {
		kind: "mock",
		endpoint: null,
		async info(): Promise<PlatformInfo> {
			await latency(120);
			const machines =
				machineState === "off"
					? {}
					: {
							machines: {
								minRunnerVersion: MOCK_MIN_RUNNER_VERSION,
								runnerImage: machineState === "unpublished" ? null : MOCK_RUNNER_IMAGE,
								runnerHarnesses: ["claude", "opencode", "codex"] as Array<"claude" | "opencode" | "codex">,
								platformUrl: origin,
							},
						};
			return {
				demoEnabled: true,
				googleLogin: true,
				windlassVersion: "0.4.0",
				profiles: offeredProfiles(profiles),
				...(options.sizes === "one" ? {} : { hostedSizes: MOCK_SIZES }),
				...(githubOn ? { github: GITHUB } : {}),
				...machines,
				...(billingState === "off" ? {} : { billing: { plans: MOCK_PLANS } }),
				...(options.items === "off"
					? {}
					: {
							items: {
								reviewer: options.reviewer !== false,
								orchestrate: true,
								screenshots: options.screenshots !== false,
							},
						}),
			};
		},
		login: {
			async start(provider = "github", auth): Promise<LoginStart> {
				await latency(400);
				if (provider === "github" && !githubOn)
					throw new PlatformError("user", "This sign-in provider is unavailable.", { reason: "provider_off" });
				attempt = {
					owner: auth && worldOf(auth).profile.uid,
					provider,
					state: hex(16),
					expiresAt: now() + 10 * MINUTE,
				};
				if (typeof sessionStorage !== "undefined") sessionStorage.setItem("wlp.mock.login", JSON.stringify(attempt));
				const redirectPrefix = origin + "/signin";
				return {
					url: redirectPrefix + "?" + new URLSearchParams({ code: "mock_login", state: attempt.state }),
					redirectPrefix,
					expiresAt: attempt.expiresAt,
				};
			},
			async finish(callback: string, auth): Promise<AuthResult> {
				await latency(500);
				attempt ??=
					typeof sessionStorage === "undefined" ? null : JSON.parse(sessionStorage.getItem("wlp.mock.login") ?? "null");
				if (!attempt || now() > attempt.expiresAt)
					throw new PlatformError("user", "This sign-in attempt has expired. Start again.");
				if (attempt.provider === "github" && !githubOn)
					throw new PlatformError("user", "This sign-in could not be verified. Start again.", {
						reason: "invalid_callback",
					});
				const url = new URL(callback);
				if (url.origin + url.pathname !== origin + "/signin")
					throw new PlatformError("user", "That is not the address the sign-in ends on.");
				if (url.searchParams.has("error"))
					throw new PlatformError("user", "Sign-in refused: " + url.searchParams.get("error"));
				if (!url.searchParams.get("code")) throw new PlatformError("user", "There is no sign-in code.");
				if (url.searchParams.get("state") !== attempt.state)
					throw new PlatformError("user", "Start sign-in in this tab.");
				if (attempt.owner !== auth?.profile.uid)
					throw new PlatformError("user", "Return to the account that started this link.");
				const key = "wlp.mock.identity." + attempt.provider;
				const existing = recall(key);
				if (auth && existing && existing !== auth.profile.uid)
					throw new PlatformError("user", "This identity is already linked.");
				const uid = auth
					? worldOf(auth).profile.uid
					: existing || (existing === "" ? "u_" + hex(8) : attempt.provider === "github" ? "u_ada" : "u_google_ada");
				keep(key, uid);
				attempt = null;
				if (typeof sessionStorage !== "undefined") sessionStorage.removeItem("wlp.mock.login");
				const profile: UserProfile = { uid, email: "ada@example.com", demo: false };
				return { token: tokenFor(profile), profile };
			},
			async demo(): Promise<AuthResult> {
				await latency(500);
				const profile: UserProfile = { uid: `demo_${hex(8)}`, email: null, demo: true };
				return { token: tokenFor(profile), profile };
			},
		},
		user: userApi,
		session: sessionApi,
		dispose() {
			disposed = true;
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
		},
		mockNextAnswer(kind) {
			nextAnswer = kind;
		},
		mockIntegrations(state = "connected", uid = "u_ada") {
			const at = realNow();
			keep(`wlp.mock.gitlab.${uid}`, state === "gitlab-reconnect" ? "reconnect" : String(gitlabProjects[0]!.id));
			keepLinear(uid, { connectedAt: at, mappings: { "team-eng": { repositoryId: 7101, savedAt: at } } });
			const site = jiraSites[0]!;
			keep(
				`wlp.mock.jira.${uid}`,
				JSON.stringify({
					connection: { user: { id: "jira-ada", name: "Ada Lovelace" }, sites: jiraSites, site, connectedAt: at },
					mappings: {
						"10001": {
							siteId: site.id,
							projectId: "10001",
							repository: { id: 7101, owner: "acme", name: "harbor" },
							savedAt: at,
						},
					},
				}),
			);
			keep(slackKey("owner"), uid);
			keep(
				`wlp.mock.linked.${uid}`,
				JSON.stringify([
					{ surface: "slack", tenant: slackWorkspace.id, tenantName: slackWorkspace.name, name: "" },
				] satisfies LinkedAccount[]),
			);
			keep(
				slackKey("mappings"),
				JSON.stringify([
					{ channel: slackChannels[0], repository: { id: 7101, owner: "acme", name: "harbor" }, details: false },
					{
						channel: slackChannels[1],
						repository: { id: 7103, owner: "acme", name: "lighthouse-docs" },
						details: true,
					},
				]),
			);
		},
		mockNextGithub(kind) {
			nextGithub = kind;
		},
		mockNextServers(kind) {
			if (kind === "slow") slowServersUntil = realNow() + 10_000;
			else nextServers = kind;
		},
		mockUsage(state) {
			usageState = state;
			for (const world of worlds.values()) for (const feed of world.feeds) feed.onUsage?.(usageNumbers(world));
		},
		simulateDrop(ms: number) {
			for (const world of worlds.values()) {
				for (const feed of world.feeds) feed.onConnection?.("reconnecting");
				for (const session of world.sessions.values())
					for (const feed of session.feeds) feed.onConnection("reconnecting");
			}
			setTimeout(() => {
				for (const world of worlds.values()) {
					for (const feed of world.feeds) {
						feed.onConnection?.("connected");
						feed.onSessions(listOf(world));
					}
					for (const session of world.sessions.values()) {
						for (const feed of session.feeds) {
							feed.onConnection("connected");
							feed.onSnapshot(snapshotOf(session));
						}
					}
				}
			}, ms);
		},
	};
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function asPlatformError(error: unknown): PlatformError {
	return error instanceof PlatformError
		? error
		: new PlatformError("internal", "Something went wrong.", { cause: error });
}

function addUsage(a: TurnUsage | null, b: TurnUsage): TurnUsage {
	if (!a) return { ...b };
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		reasoningTokens: a.reasoningTokens + b.reasoningTokens,
	};
}

function hex(length: number): string {
	const bytes = new Uint8Array(Math.ceil(length / 2));
	crypto.getRandomValues(bytes);
	return Array.from(bytes, byte => byte.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, length);
}

/** The demo recordings reuse "a1", "u1" in every run; real message IDs are unique in a session. */
function stampId(turn: number, messageId: string): string {
	return messageId.startsWith("msg_") ? messageId : `msg_t${turn}_${messageId}`;
}

/** 180000 → "3 minutes". */
function minutes(ms: number): string {
	const value = Math.round(ms / 60_000);
	if (value >= 1) return `${value} ${value === 1 ? "minute" : "minutes"}`;
	const seconds = Math.round(ms / 1000);
	return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/** Start times like those measured on a 2-CPU host (docs/architecture.md, "Start times"): a new sandbox on the first turn, a connected one after. */
function mockStartTimes(summary: SessionSummary, turn: number, at: number): NonNullable<SessionSummary["startTimes"]> {
	const harness = summary.harness ?? "windlass";
	const fresh = turn === 1;
	const agent = { windlass: 730, claude: 1260, opencode: 3470, codex: 1720 }[harness];
	const session = { windlass: 20, claude: 1760, opencode: 2260, codex: 70 }[harness];
	const machine = summary.place.kind === "machine";
	const parts = {
		sandbox: fresh ? 820 : 140,
		setup: fresh ? 1900 : undefined,
		prepare: harness === "windlass" ? 1700 : 400,
		relay: harness === "windlass" ? 1250 : undefined,
		agent,
		session,
		firstOutput: 2100,
	};
	const total =
		Object.values(parts).reduce<number>((sum, ms) => sum + (ms ?? 0), 0) -
		(parts.relay ?? 0) +
		(fresh && machine ? 60 : 0);
	const times = {
		turn,
		at,
		harness,
		place: machine ? ("machine" as const) : ("hosted" as const),
		newSandbox: fresh,
		...(fresh && machine ? { image: 60, runnerCreate: 620 } : {}),
		...Object.fromEntries(Object.entries(parts).filter(([, ms]) => ms !== undefined)),
		total,
	};
	return [...(summary.startTimes ?? []), times].slice(-5);
}
