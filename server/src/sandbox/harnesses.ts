import {
	MODEL_PROVIDERS,
	isModelProvider,
	type CredentialRef,
	type ModelProvider,
	type ModelProviderStatus,
	type PlanProvider,
} from "../contract.js";
import type {
	HarnessOptions,
	HarnessId,
	ModelList,
	PlatformToolName,
	SandboxProfileId,
	SessionCapabilities,
} from "../contract.js";

/**
 * What an agent can do: one record per agent (Windlass's below, each ACP agent's on its `AcpProfile`). The
 * platform and the screens decide by these flags, never by the agent's id or name, so one shared path serves
 * every agent and an agent added later is one record more.
 */
export interface HarnessCapabilities {
	/** What the timeline stores for its turns. */
	events: "windlass" | "acp";
	/** How the next turn continues the conversation: Windlass's resolve and resume, ACP's resume, ACP's load, or not at all. */
	resume: "windlass" | "resume" | "load" | "none";
	/** A message sent into a running turn. */
	steer: boolean;
	/** Stopping one tool call of a running turn. */
	cancelCall: boolean;
	/** Questions to whoever has the session open. */
	questions: boolean;
	/**
	 * Which of the platform's tools this harness can be given (platform-tools.ts), by whichever transport it
	 * takes them: Windlass's host tools, or MCP over ACP for those that may be served from the sandbox.
	 * Without `publish`, the person publishes from the side panel.
	 */
	platformTools: readonly PlatformToolName[];
	/** Screenshots with a builder's report (`RunTurnInput.reportScreenshots`, `wlp-shot`). */
	reportScreenshots: boolean;
	/** The reviewer's restricted session: no subagents, an agent profile of the platform's, required checks, host tools. */
	restrictedReview: boolean;
	/** How the user's own MCP servers reach it. */
	userServers: "config-file" | "session-new" | "none";
	/** Whether a project's own MCP servers wait for the person's approval before they start. */
	projectServerApproval: boolean;
	/** The user's saved checks, run before the turn is called done: by Windlass as required checks, by the platform between the agent's prompts (platform-checks.ts), or not at all. */
	checks: "required" | "platform" | "none";
	/** Named variables withheld from commands, and credential-looking ones passed to them (`withholdEnv`, `passEnv`). */
	envLists: boolean;
	/** A home of the session's own for its commands. */
	sessionHome: boolean;
	/**
	 * What a turn reports of its use: token counts per model call, with the cache's share ("tokens"); how full
	 * the context is, and the turn's tokens where the agent answers its prompt with them ("context"); or nothing.
	 */
	usage: "tokens" | "context" | "none";
	/** Where the models a prompt may name come from: the account's plan, or the harness's own list. */
	models: "account" | "harness";
	/** Which credential sources can supply this harness. */
	signIn: readonly ("chatgpt" | "machine" | "platform-key")[];
	/**
	 * Whether its session is copied out of a sandbox that may be lost (`SandboxLayer.backups`), as its
	 * description of its session files says (session-files.ts). A machine's sandboxes have no copies.
	 */
	backups: boolean;
	/**
	 * Who holds a turn to a step limit (`RunTurnInput.maxSteps`): the engine itself (Windlass's model steps), the
	 * platform counting the turn's tool calls (platform-steps.ts), or nobody.
	 */
	steps: "engine" | "platform" | "none";
	/**
	 * How the agent is told which text of a turn is not the person's (factory/untrusted.ts): "taint", Windlass's
	 * marker with the prompt (`_meta["windlass/untrusted"]`), after which the session asks again before what could
	 * send data out; "none", the labelled prompt only.
	 */
	untrustedMarker: "taint" | "none";
	/** A plan mode of the agent's own, chosen per prompt (`RunTurnInput.planMode`): Codex's collaboration plan mode. */
	planMode: boolean;
	/** A scripted model for a demo session (`Windlass.demoScript`). */
	demo: boolean;
	/**
	 * Who decides the modes a session may be put in: the sandbox profile ("profile": Windlass's approval, Codex's
	 * sandbox in codex-modes.ts), so a chosen mode is checked against that list before launch; a fixed list it is
	 * launched with until it reports its own ("launch", Claude's `CLAUDE_LAUNCH_MODES`); or only its own report ("agent").
	 */
	modes: "profile" | "launch" | "agent";
}

/** The platform's tools by name (platform-tools.ts); literal here so that this file imports nothing of the server's. */
const tools = (...names: PlatformToolName[]): readonly PlatformToolName[] => Object.freeze(names);
/** What an ACP agent takes over MCP: every tool platform-tools.ts's `TOOL_REACH` does not keep to Windlass's host tools (harness-check holds them equal). */
const MCP_PLATFORM_TOOLS = tools(
	"report",
	"ask_person",
	"request_secret",
	"publish",
	"push",
	"fetch_base",
	"file_review",
);

export const WINDLASS_CAPABILITIES: HarnessCapabilities = Object.freeze({
	events: "windlass",
	resume: "windlass",
	steer: true,
	cancelCall: true,
	questions: true,
	platformTools: tools(
		"publish",
		"report",
		"ask_person",
		"request_secret",
		"push",
		"fetch_base",
		"file_review",
		"file_plan_review",
		"file_repo_setup",
		"file_repo_setup_review",
	),
	reportScreenshots: true,
	restrictedReview: true,
	userServers: "config-file",
	projectServerApproval: true,
	checks: "required",
	envLists: true,
	sessionHome: true,
	usage: "tokens",
	models: "account",
	signIn: ["chatgpt", "platform-key"] as const,
	backups: true,
	steps: "engine",
	untrustedMarker: "taint",
	planMode: false,
	demo: true,
	modes: "profile",
});

/**
 * What every ACP agent shares; each profile below names its own record from it. Over MCP: only the tools that
 * may be served from inside the sandbox (platform-tools.ts, `TOOL_REACH`). The ACP harness refuses a turn that
 * asks for what its record lacks (acp-harness.ts, `unsupported`).
 */
const ACP_BASE: HarnessCapabilities = Object.freeze({
	events: "acp",
	resume: "resume",
	steer: true,
	cancelCall: false,
	questions: true,
	platformTools: tools(),
	reportScreenshots: false,
	restrictedReview: false,
	userServers: "none",
	projectServerApproval: false,
	checks: "platform",
	envLists: false,
	sessionHome: false,
	usage: "context",
	models: "harness",
	signIn: ["machine", "platform-key"] as const,
	backups: false,
	steps: "platform",
	untrustedMarker: "none",
	planMode: false,
	demo: false,
	modes: "agent",
});

const acpCapabilities = (own: Partial<HarnessCapabilities>): HarnessCapabilities =>
	Object.freeze({ ...ACP_BASE, ...own });

export interface AcpProfile {
	id: Exclude<HarnessId, "windlass">;
	name: string;
	command: string[];
	leftovers: string;
	profiles: SandboxProfileId[];
	steering: string;
	signedOutCodes: number[];
	/**
	 * The profiles a work item may run this agent in, each with the mode its session starts in, every turn:
	 * one that never asks, since nobody answers an item's questions. The first is the one an item takes when
	 * its filing names none (`itemProfileOf`).
	 */
	itemModes: Partial<Record<SandboxProfileId, string>>;
	/**
	 * The profiles where the agent's commands run in its own sandbox and every request to leave it is refused
	 * (Codex on the Windlass sandbox profile). An item there does not "work without asking": a request ends
	 * the step (acp-harness.ts).
	 */
	sandboxedOn: SandboxProfileId[];
	/**
	 * How a work item counts the tokens this agent reports. "budget": against the item's token budget (an
	 * API key, billed by token). "subscription": shown, never counted, since a subscription is not billed by
	 * token; the item's turns and active time bound it instead. "sign-in": by the machine's sign-in method,
	 * kept on the item when it is filed (`itemTokensOf`).
	 */
	itemTokens: "budget" | "subscription" | "sign-in";
	/** With `itemTokens` "sign-in": the methods a work item may be filed with. The machine reports which it has. */
	itemSignIns?: readonly SignInMethod[];
	/**
	 * Whether a work item may run this agent. When false, filing one is refused (`itemHarnessProblem`), and
	 * an unattended turn is refused before the agent starts, so no permission is ever allowed in its name.
	 */
	items: boolean;
	/** Whether a Plan-first subtask may run this agent (`subtaskHarnessProblem`). Only where `items` is. */
	subtasks: boolean;
	/** What it can do (`HarnessCapabilities`), its own record. */
	capabilities: HarnessCapabilities;
	/** The providers whose Settings keys it can run on (`keyProviders`). */
	keyProviders: readonly ModelProvider[];
	/** The providers whose subscription plan it can run on, hosted, through the relay: Claude Code on a Claude plan, Codex on a ChatGPT plan. */
	planProviders: readonly PlanProvider[];
	/**
	 * Whether a machine's owner can keep a login of its own on that machine in place of the plan (Claude Code's
	 * `windlass-runner login claude`, made with `connect claude --this-machine`). Kept there, it wins on that machine.
	 */
	ownMachineLogin?: true;
	/**
	 * What the cost in its `usage_update` covers, where the platform takes it as a turn's dollars (factory/cost.ts).
	 * "turn": a running total for the agent's session (Claude Code's `total_cost_usd`, which a resumed session carries
	 * on); a turn counts what it grew by (`turnCost`). Absent: its reported cost is not used, and its tokens are
	 * priced from the catalog instead.
	 */
	reportedCost?: "turn";
	/**
	 * A line of the agent's own error log (stderr) saying it gave up on the provider's usage or rate limit, where
	 * the agent then answers nothing more: the turn is ended at once as a usage limit (acp-harness.ts).
	 */
	limitGiveUp?: RegExp;
}

/** The credential used by a machine agent for a turn. */
export type SignInMethod = "api-key" | "chatgpt" | "subscription";

export const CLAUDE: AcpProfile = {
	id: "claude",
	name: "Claude Code",
	command: ["wlp-claude-acp"],
	leftovers: "claude-agent-acp",
	profiles: ["docker-hardened"],
	steering: "_session/steering",
	signedOutCodes: [-32000],
	// Offered where the adapter is not root (the container's agent user is uid 1000) and the managed settings do not disable it.
	itemModes: { "docker-hardened": "bypassPermissions" },
	sandboxedOn: [],
	itemTokens: "sign-in",
	itemSignIns: ["subscription", "api-key"],
	items: true,
	subtasks: true,
	// Its adapter takes the platform's MCP server itself (platform-tools.ts).
	capabilities: acpCapabilities({ platformTools: MCP_PLATFORM_TOOLS, modes: "launch", backups: true }),
	keyProviders: ["anthropic"],
	planProviders: ["anthropic"],
	ownMachineLogin: true,
	reportedCost: "turn",
};

export const OPENCODE: AcpProfile = {
	id: "opencode",
	name: "OpenCode",
	command: ["wlp-opencode-acp"],
	leftovers: "opencode",
	profiles: ["docker-hardened"],
	steering: "_session/steering",
	signedOutCodes: [-32000],
	// Its permission config asks before edits and commands; an item's turn answers those itself (acp-harness.ts, `unattended`).
	itemModes: { "docker-hardened": "build" },
	sandboxedOn: [],
	itemTokens: "budget",
	items: true,
	subtasks: true,
	// Its image's wlp-acp-mcp serves it the platform's MCP server.
	capabilities: acpCapabilities({ platformTools: MCP_PLATFORM_TOOLS, backups: true }),
	keyProviders: MODEL_PROVIDERS,
	planProviders: [],
	// OpenCode 1.19.6 retries a 429 three times, logs this, and never answers the prompt (wlp-opencode-acp prints its errors).
	limitGiveUp:
		/AI_RetryError: Failed after \d+ attempts\. Last error: The provider's usage or rate limit was reached\./,
};

export const CODEX: AcpProfile = {
	id: "codex",
	name: "Codex",
	command: ["wlp-codex-acp"],
	leftovers: "codex",
	profiles: ["docker-hardened", "docker-windlass-sandbox"],
	steering: "_session/steering",
	signedOutCodes: [-32000],
	// Workspace access asks before anything outside Codex's sandbox, and on this profile every such request is
	// refused (codex-modes.ts); Container access asks nothing, the container being the boundary.
	itemModes: { "docker-windlass-sandbox": "workspace-write", "docker-hardened": "agent-full-access" },
	sandboxedOn: ["docker-windlass-sandbox"],
	itemTokens: "sign-in",
	itemSignIns: ["chatgpt", "api-key"],
	items: true,
	subtasks: false,
	// Its image's wlp-acp-mcp serves the platform's MCP server on the one URL its requirements.toml allows; an older
	// image without it says so, and the turn runs without the tools (acp-harness.ts). Its collaboration plan mode is
	// chosen per prompt. Its modes are the profile's (codex-modes.ts).
	capabilities: acpCapabilities({ platformTools: MCP_PLATFORM_TOOLS, planMode: true, modes: "profile", backups: true }),
	keyProviders: ["openai"],
	planProviders: ["openai"],
};

/** Windlass's counterpart of `AcpProfile.keyProviders`. */
export const WINDLASS_KEY_PROVIDERS: readonly ModelProvider[] = MODEL_PROVIDERS;

/** The providers whose Settings keys a harness can run on; none without a harness. */
export function keyProviders(harness: HarnessId | undefined): readonly ModelProvider[] {
	return harness === "windlass" ? WINDLASS_KEY_PROVIDERS : (machineHarness(harness)?.keyProviders ?? []);
}

/** Windlass's counterpart of `AcpProfile.planProviders`: hosted, its unqualified models run on the ChatGPT plan. */
export const WINDLASS_PLAN_PROVIDERS: readonly PlanProvider[] = ["openai"];

/** The providers whose subscription plan a hosted harness runs on; none without a harness. */
export function planProviders(harness: HarnessId | undefined): readonly PlanProvider[] {
	return harness === "windlass" ? WINDLASS_PLAN_PROVIDERS : (machineHarness(harness)?.planProviders ?? []);
}

/** Whether its models come from the account (Windlass's), not from the agent itself. */
export const usesAccountModels = (harness: HarnessId | undefined): boolean =>
	capabilitiesOf(harness).models === "account";

export function selectedKey(harness: HarnessId | undefined, model: string | undefined, keys: readonly ModelProvider[]) {
	return keyProviders(harness).find(
		provider =>
			keys.includes(provider) &&
			((harness !== "opencode" && harness !== "windlass") || model?.startsWith(provider + "/")),
	);
}

/** A qualified picker id selects one Settings key. Unqualified Windlass ids use ChatGPT. */
export function windlassProvider(model?: string) {
	return typeof model === "string" ? selectedKey("windlass", model, MODEL_PROVIDERS) : undefined;
}

/**
 * The OpenAI key's version of one of Windlass's ChatGPT plan models (`openai/<model>`), where a checked OpenAI key
 * offers it: what "use my key" runs for one turn while the plan is limited. Null where no key offers it.
 */
export function windlassKeyModel(model: string, keys: readonly CheckedProvider[]): string | null {
	if (windlassProvider(model)) return null;
	const keyModel = `openai/${model}`;
	return hostedCatalog("windlass", keys)?.models.some(m => m.id === keyModel) ? keyModel : null;
}

export function windlassModels(account: ModelList, keys: readonly CheckedProvider[]): ModelList {
	const checked = hostedCatalog("windlass", keys)?.models.filter(m => m.id !== "default") ?? [];
	return { ...account, models: [...account.models, ...checked] };
}

type KeyHarness = { id: AcpProfile["id"]; keyRelay?: true };

/** OpenCode probes its pinned catalog offline. Offer only the providers available to this owner. */
export function availableCatalog(
	options: HarnessOptions | undefined,
	entry?: { keyRelay?: true; machineProviders?: string[]; platformKeys?: ModelProvider[] },
) {
	if (!options || !entry?.keyRelay || !entry.machineProviders) return options;
	const providers = new Set([
		...entry.machineProviders.map(p => (p === "free" ? "opencode" : p === "chatgpt" ? "openai" : p)),
		...(entry.platformKeys ?? []),
	]);
	const models = options.models.filter(m => providers.has(m.id.split("/")[0]!));
	if (!models.length) return undefined;
	if (models.some(m => m.id === options.defaultModel)) return { ...options, models };
	return {
		...options,
		defaultModel: "default",
		models: [{ id: "default", name: "Agent default", efforts: [] }, ...models],
	};
}

type ReportedSignIn = { id: AcpProfile["id"]; signIn: "token" | "none" | "unknown"; machineProviders?: string[] };

/** The providers a machine agent's own sign-in serves: Claude's subscription, Codex's login, OpenCode's provider logins. */
function machineSignIns(entry: ReportedSignIn): ModelProvider[] {
	if (entry.signIn !== "token") return [];
	if (entry.id !== "opencode") return [...keyProviders(entry.id)];
	return (entry.machineProviders ?? []).map(p => (p === "chatgpt" ? "openai" : p)).filter(isModelProvider);
}

/**
 * Why nothing on the machine can pay for this agent's turns with `model`, from its listing (`listedHarness`): its
 * `keys` are the Settings keys it can use there. Null where something can.
 */
export function machinePayerProblem(
	entry: ReportedSignIn & { keyRelay?: true; paysWith?: true },
	model: string | undefined,
	keys: readonly ModelProvider[],
	itemMachine?: string,
) {
	const profile = machineHarnesses[entry.id];
	if (entry.signIn !== "token")
		return itemMachine
			? itemSignInMessage(profile, itemMachine, entry.signIn)
			: entry.paysWith
				? `Nothing can pay for ${profile.name} yet. ${PAY_WITH_HINT}`
				: `Sign in to ${profile.name} on the machine or add a Settings key.`;
	if (
		entry.id === "opencode" &&
		model &&
		model !== "default" &&
		!keys.some(provider => model.startsWith(provider + "/")) &&
		!(entry.machineProviders ?? []).some(p =>
			model.startsWith((p === "free" ? "opencode" : p === "chatgpt" ? "openai" : p) + "/"),
		)
	)
		return `The machine sign-in cannot run ${model}. Sign in to its provider or add a Settings key.`;
	return null;
}

/** Where a person makes a plan or a key pay for an agent that has no login of its own on the machine. */
export const PAY_WITH_HINT = "Connect a plan or add a key on Connections.";

/** Combine a runner report with the owner's Settings keys its turns may use. */
export function withSettingsKeys<
	T extends KeyHarness & { signIn: "token" | "none" | "unknown"; method?: SignInMethod },
>(
	entry: T,
	saved: readonly ModelProvider[],
	model?: string,
): T & { signIn: "token" | "none" | "unknown"; method?: SignInMethod; platformKeys?: ModelProvider[] } {
	const keys = keyProviders(entry.id).filter(
		provider =>
			entry.keyRelay &&
			saved.includes(provider) &&
			(entry.id !== "opencode" || !model || model === "default" || model.startsWith(provider + "/")),
	);
	if (keys.length) return { ...entry, signIn: "token" as const, method: "api-key" as const, platformKeys: keys };
	return entry.id === "claude" && entry.signIn === "token" ? { ...entry, method: "subscription" as const } : entry;
}

/**
 * A machine's agent as the Machines page lists it, with what pays for its turns there. Claude Code with its own login
 * kept on the machine (`windlass-runner login claude`) pays with that login. Any other agent a plan can pay for (Claude
 * Code, Codex) pays as hosted, through Connections → Pay with (`paysWith`): its `signIn` is "token" when one of the
 * account's plans usable on a machine (`plans`) or a saved key can pay, with the plan's method first. OpenCode pays with
 * its own logins on the machine, and a saved key for each provider it has no login for.
 */
export function listedHarness<T extends KeyHarness & ReportedSignIn>(
	entry: T,
	saved: readonly ModelProvider[],
	plans: readonly PlanProvider[] = [],
): T & { method?: SignInMethod; platformKeys?: ModelProvider[]; machineSignIns?: ModelProvider[]; paysWith?: true } {
	const own = machineSignIns(entry);
	const planned = machineHarnesses[entry.id].planProviders;
	if (planned.length && entry.signIn !== "token") {
		const keyed = withSettingsKeys({ ...entry, signIn: "none" }, saved);
		const plan = planned.find(provider => plans.includes(provider));
		if (plan)
			return {
				...keyed,
				signIn: "token",
				method: plan === "openai" ? "chatgpt" : "subscription",
				paysWith: true,
			};
		return keyed.platformKeys ? { ...keyed, paysWith: true } : { ...entry, paysWith: true };
	}
	const effective = withSettingsKeys(
		entry,
		saved.filter(provider => !own.includes(provider)),
	);
	return {
		...effective,
		...(entry.machineProviders && entry.signIn !== "token" && { machineProviders: [] }),
		...(own.length && { machineSignIns: own }),
	};
}

export const machineHarnesses = { claude: CLAUDE, opencode: OPENCODE, codex: CODEX };

export const hostedProfiles: SandboxProfileId[] = ["docker-hardened", "e2b-open", "daytona"];

export function hostedHarness(id: AcpProfile["id"]): AcpProfile {
	const agent = machineHarnesses[id];
	return {
		...agent,
		profiles: hostedProfiles,
		sandboxedOn: [],
		capabilities: { ...agent.capabilities, signIn: ["platform-key"] },
	};
}

/** A fresh OpenCode session has no model catalog yet. Limit its adapter to one saved provider. */
export function hostedProvider(id: AcpProfile["id"], model: string | undefined, keys: readonly ModelProvider[]) {
	if (id === "opencode" && (!model || model === "default")) return keyProviders(id).find(p => keys.includes(p));
	return selectedKey(id, model, keys);
}

export function hostedKeyMessage(id: HarnessId, model?: string): string {
	const provider = selectedKey(id, model, MODEL_PROVIDERS);
	const key = provider
		? { openai: "an OpenAI", anthropic: "an Anthropic", google: "a Google", openrouter: "an OpenRouter" }[provider]
		: "an OpenAI, Anthropic, Google or OpenRouter";
	return `Add ${key} key on the Connections page to run ${harnessName(id)} here.`;
}

export type CheckedProvider = Pick<ModelProviderStatus, "provider" | "checkedAt" | "models" | "windlassModels">;

/** What a hosted turn can pay with, as pickers and the resolver see it: checked Settings keys and, with `plan`, connected plans. */
export type HostedCredential = CheckedProvider & { plan?: true };

/** Any agent runs on a key of its providers; only a plan agent runs on a plan. */
function canPayWith(harness: HarnessId, credential: HostedCredential): boolean {
	if (!credential.plan) return keyProviders(harness).includes(credential.provider);
	return (
		(machineHarness(harness)?.planProviders as readonly ModelProvider[] | undefined)?.includes(credential.provider) ??
		false
	);
}

/** The providers a hosted agent can pay for: its keys' and its plans'. */
export function hostedProviders(harness: HarnessId, credentials: readonly HostedCredential[]): ModelProvider[] {
	return [...new Set(credentials.filter(c => canPayWith(harness, c)).map(c => c.provider))];
}

/** What pays for a hosted turn of this model: the plan where one is connected, else the key. Null when neither can. */
export function hostedPayer(
	harness: AcpProfile["id"],
	model: string | undefined,
	credentials: readonly HostedCredential[],
): Omit<CredentialRef, "generation"> | null {
	const provider = hostedProvider(harness, model, hostedProviders(harness, credentials));
	if (!provider) return null;
	const plan = credentials.some(c => c.plan && c.provider === provider && canPayWith(harness, c));
	return plan ? { provider, plan: true } : { provider };
}

// Windlass's public OpenAI catalog hides non-chat models and snapshots whose alias is listed.
function codexModels(ids: string[]) {
	const snapshot = /-\d{4}-\d{2}-\d{2}$/;
	return ids.filter(
		id =>
			/^(?:ft:)?(?:gpt-|chatgpt-|codex-|o\d+(?:-|$))/.test(id) &&
			!/embedding|audio|realtime|search|transcrib|tts|image|moderation|instruct|^gpt-live|-healthcare(?:-|$)/i.test(
				id,
			) &&
			!(snapshot.test(id) && ids.includes(id.replace(snapshot, ""))),
	);
}

/** Map the saved key checks and connected plans to the model ids each hosted ACP adapter takes at launch. */
export function hostedCatalog(
	harness: HarnessId,
	credentials: readonly HostedCredential[],
): HarnessOptions | undefined {
	const ids = new Set(["default"]);
	let checkedAt: number | null = null;
	for (const credential of credentials) {
		const { provider, models: offered, windlassModels, checkedAt: at } = credential;
		if (!canPayWith(harness, credential) || at === null) continue;
		// A plan offers what its provider or agent reported (credentials/plans.ts); before that, the agent's default.
		if (credential.plan) {
			checkedAt = Math.max(checkedAt ?? at, at);
			for (const model of offered ?? []) ids.add(model);
			continue;
		}
		if (!offered?.length) continue;
		checkedAt = Math.max(checkedAt ?? at, at);
		if (harness === "claude") {
			for (const family of ["sonnet", "opus", "haiku", "fable"]) {
				if (offered.some(id => id.startsWith("claude-") && id.split("-").includes(family))) ids.add(family);
			}
		} else if (harness === "codex") {
			for (const model of codexModels(offered)) ids.add(model);
		} else {
			let models = offered;
			if (harness === "windlass" && provider === "openai") models = codexModels(offered);
			if (harness === "windlass" && (provider === "google" || provider === "openrouter")) models = windlassModels ?? [];
			for (const model of models) ids.add(provider + "/" + model);
		}
	}
	if (checkedAt === null) return undefined;
	return {
		defaultModel: "default",
		models: [...ids].map(id => ({ id, name: id === "default" ? "Agent default" : null, efforts: [] })),
		modes: [],
		checkedAt,
	};
}

/** The reason a hosted agent is disabled in a picker. */
export function hostedAgentProblem(
	id: AcpProfile["id"],
	credentials: readonly HostedCredential[] | null,
	keyProfile: boolean,
	model?: string,
) {
	if (!credentials) return "Reading your Settings keys…";
	if (!hostedPayer(id, model, credentials)) return hostedKeyMessage(id, model);
	return keyProfile ? null : "This deployment has no supported hosted profile.";
}

/** A machine harness by its id, whatever harnesses this build has; null for Windlass and for an id it does not know. */
export function machineHarness(id: unknown): AcpProfile | null {
	return typeof id === "string" && Object.hasOwn(machineHarnesses, id)
		? machineHarnesses[id as keyof typeof machineHarnesses]
		: null;
}

/** Names joined for a sentence: "Windlass, Claude Code or OpenCode". */
export const anyOf = (names: string[]) =>
	names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : (names[0] ?? "");

/** Why a work item cannot run this agent, or null when it can. Windlass always can. */
export function itemHarnessProblem(id: HarnessId): string | null {
	const machine = machineHarness(id);
	if (!machine || machine.items) return null;
	return `Work items run ${anyOf([
		"Windlass",
		...Object.values(machineHarnesses)
			.filter(h => h.items)
			.map(h => h.name),
	])} for now. Start a ${machine.name} session instead.`;
}

/** Why a Plan-first subtask cannot run this agent, or null when it can. */
export function subtaskHarnessProblem(id: HarnessId): string | null {
	const machine = machineHarness(id);
	if (!machine || machine.subtasks) return itemHarnessProblem(id);
	return `Plan-first subtasks run ${anyOf([
		"Windlass",
		...Object.values(machineHarnesses)
			.filter(h => h.subtasks)
			.map(h => h.name),
	])} for now. ${machine.name} runs Quick items only.`;
}

/** The profiles a work item may run a machine harness in; the first is its default. */
export function itemProfiles(id: HarnessId): SandboxProfileId[] {
	return Object.keys(machineHarness(id)?.itemModes ?? {}) as SandboxProfileId[];
}

/** The mode an item's session of a machine harness runs in on a profile; undefined for Windlass or a profile it has none for. */
export function itemModeOf(id: HarnessId | undefined, profile: SandboxProfileId): string | undefined {
	return machineHarness(id)?.itemModes[profile === "e2b-open" || profile === "daytona" ? "docker-hardened" : profile];
}

/** Why a work item cannot run this agent in this profile, or null when it can. Windlass is the profile's to judge. */
export function itemProfileProblem(id: HarnessId, profile: SandboxProfileId): string | null {
	const machine = machineHarness(id);
	if (!machine || itemModeOf(id, profile) !== undefined) return null;
	const names: Record<string, string> = { "docker-hardened": "“Open”", "docker-windlass-sandbox": "“Strict”" };
	return `A work item runs ${machine.name} only on ${anyOf(itemProfiles(id).map(p => names[p] ?? p)).replace(/ or /, " or on ")}.`;
}

/** A sign-in method in words. */
export const signInWords = (method: SignInMethod | undefined) =>
	method === "api-key"
		? "an API key"
		: method === "chatgpt"
			? "ChatGPT"
			: method === "subscription"
				? "a Claude subscription"
				: "a method it did not report";

/**
 * Why a work item cannot be filed with the machine's sign-in method: only where its tokens are counted by
 * sign-in (`itemTokens` "sign-in"), and the method is not one of `itemSignIns`. Null where it can.
 */
export function itemSignInMethodProblem(
	profile: AcpProfile,
	machine: string,
	method: SignInMethod | undefined,
): string | null {
	if (profile.itemTokens !== "sign-in" || (method && profile.itemSignIns?.includes(method))) return null;
	const allowed = (profile.itemSignIns ?? []).map(signInWords);
	return `${profile.name} on “${machine}” pays with ${signInWords(method)}, and its work items run only on ${anyOf(allowed)} for now. ${PAY_WITH_HINT}`;
}

/**
 * Why an item's turn cannot run on the machine's sign-in method now: the item was filed with another, and
 * its tokens would be counted differently from then on. Never switched silently. Null where it is the same.
 */
export function itemSignInChanged(
	profile: AcpProfile,
	machine: string,
	filed: SignInMethod | undefined,
	now: SignInMethod | undefined,
): string | null {
	if (profile.id === "claude") {
		filed ??= "subscription";
		now ??= "subscription";
	}
	if (profile.itemTokens !== "sign-in" || filed === undefined || filed === now) return null;
	return `${profile.name} on “${machine}” now pays with ${signInWords(now)}, not ${signInWords(filed)} as when this item was filed. File the work again.`;
}

/** How an item counts its agent's tokens, by the sign-in method it was filed with where that decides. */
export function itemTokensOf(profile: AcpProfile, signIn: SignInMethod | undefined): "budget" | "subscription" {
	if (profile.itemTokens !== "sign-in") return profile.itemTokens;
	return signIn === "subscription" || signIn === "chatgpt" || (profile.id === "claude" && !signIn)
		? "subscription"
		: "budget";
}

/** "windlass" or an id of `machineHarnesses`; null for anything else. */
export function knownHarness(id: unknown): HarnessId | null {
	return id === "windlass" ? "windlass" : (machineHarness(id)?.id ?? null);
}

/** What a harness is called: "Windlass", "Claude Code". The one place an agent's name comes from (`AcpProfile.name`). */
export function harnessName(id: HarnessId | undefined): string {
	return machineHarness(id)?.name ?? "Windlass";
}

/** What an agent can do, by its id; Windlass's for none. Launch and admission decisions precede the sandbox: no capability probe runs. */
export function capabilitiesOf(id: HarnessId | undefined = "windlass"): HarnessCapabilities {
	return machineHarness(id)?.capabilities ?? WINDLASS_CAPABILITIES;
}

/** The part of an agent's record the screens read (`SessionSummary.capabilities`). */
export function sessionCapabilities(id: HarnessId | undefined): SessionCapabilities {
	const caps = capabilitiesOf(id);
	return {
		cancelCall: caps.cancelCall,
		usage: caps.usage,
		checks: caps.checks,
		envLists: caps.envLists,
		platformTools: caps.platformTools,
		reportScreenshots: caps.reportScreenshots,
		models: caps.models,
		planMode: caps.planMode,
		projectServerApproval: caps.projectServerApproval,
	};
}

/**
 * Whether the agent takes Windlass's marker for outside text (`_meta["windlass/untrusted"]`, factory/untrusted.ts),
 * by its record (`HarnessCapabilities.untrustedMarker`). An agent without one gets the labelled prompt only.
 */
export function takesUntrustedMarker(id: HarnessId | undefined): boolean {
	return capabilitiesOf(id).untrustedMarker === "taint";
}

export function initialHarnessModels(options?: HarnessOptions): ModelList {
	if (options)
		return {
			source: "harness",
			defaultModel: options.defaultModel,
			models: options.models,
			fetchedAt: options.checkedAt,
		};
	return {
		source: "harness",
		defaultModel: "default",
		models: [{ id: "default", name: null, efforts: [] }],
		fetchedAt: null,
	};
}

/** Why an agent cannot run a turn on the machine: nothing pays for it. A plan's agent pays through Pay with; OpenCode signs in there. */
export function machineLoginMessage(profile: AcpProfile, machine: string): string {
	if (profile.planProviders.length) return `Nothing can pay for ${profile.name} on “${machine}” yet. ${PAY_WITH_HINT}`;
	return `${profile.name} on “${machine}” is not signed in. Run windlass-runner login ${profile.id} there.`;
}

/** Why a work item cannot run this agent, by the machine's reported sign-in: only "token" is known to be signed in. */
export function itemSignInMessage(
	profile: AcpProfile,
	machine: string,
	signIn: "token" | "none" | "unknown",
): string | null {
	if (signIn === "token") return null;
	if (signIn === "none") return machineLoginMessage(profile, machine);
	if (profile.planProviders.length)
		return `“${machine}” could not say whether ${profile.name} has a login of its own there, and nothing else can pay for it. ${PAY_WITH_HINT}`;
	return `“${machine}” could not say whether ${profile.name} is signed in there, and a work item runs only where it is. Check that Docker runs there, or run windlass-runner login ${profile.id} there.`;
}

/**
 * Whether a work item's agent works without asking: every machine harness a work item may run does, since
 * nobody answers an item's questions (`itemModes`), except where its commands run in its own sandbox and
 * a request to leave it ends the step (`sandboxedOn`). Windlass asks before what its sandbox cannot contain.
 * A subtask runs on "Docker, hardened", the default here.
 */
export function worksWithoutAsking(id: HarnessId | undefined, profile: SandboxProfileId = "docker-hardened"): boolean {
	const machine = machineHarness(id);
	return machine?.items === true && itemModeOf(id, profile) !== undefined && !machine.sandboxedOn.includes(profile);
}

/**
 * What the platform does with the repository's saved checks for this agent, in one sentence after a line about
 * it (`HarnessCapabilities.checks`); "" where its engine runs them. `sandboxed`: its commands run in its own
 * sandbox on this profile (`sandboxedOn`), where the platform does not run them either (platform-checks.ts).
 */
export function checksSentence(id: HarnessId, sandboxed = false): string {
	const checks = capabilitiesOf(id).checks;
	if (checks === "none" || (checks === "platform" && sandboxed))
		return "It does not run your repository's checks: CI decides.";
	return checks === "platform"
		? "The platform runs your repository's saved checks when it ends a turn, and sends it back with what fails."
		: "";
}
