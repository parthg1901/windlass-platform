/** The account's settings, secrets, model providers and API tokens. */

import type { HarnessId, SandboxProfileId } from "../contract.js";
import type { PlanProvider } from "./connect.js";
import type { RepositoryAutonomy, RepositoryDefaults, SecretReach, SecretScope } from "./repository.js";
import type { UsageWindow } from "./timeline.js";

/** Account defaults apply after explicit launch and repository choices. Ignore unavailable profiles and models. */
export type AccountDefaults = Omit<RepositoryDefaults, keyof RepositoryAutonomy | "screenshots">;

export type AccountDefaultsPatch = Partial<Omit<AccountDefaults, "updatedAt" | "previousStartPlace">>;
export type RepositoryDefaultsPatch = Partial<
	Omit<RepositoryDefaults, "updatedAt" | "mergeKinds" | "previousStartPlace">
> & { offer?: import("../factory/readiness-track.js").Offer };

/** User-owned MCP definition supplied to every session independent of repository configuration. */
export interface PersonalServer {
	/** Its key in Windlass's configuration: what the model calls it by. */
	name: string;
	definition: Record<string, unknown>;
	/** True when it is reached at an address and nothing is started. */
	remote: boolean;
	/** What starts it, or where it is reached, in one line: the command with its arguments, or the address. */
	subject: string;
	/** False when its definition says `enabled: false`: Windlass then leaves it out. */
	enabled: boolean;
	/** Allows tools to run without asking. Trust in their output is controlled separately by the definition. */
	unasked: boolean;
	/** Variables referenced by env or headers, in order. An unset variable prevents startup. */
	reads: Array<{ name: string; saved: boolean }>;
	/** When it was last saved, ms since the epoch. */
	updatedAt: number;
}

/** Show the server's reach before saving because user-owned MCP servers start without project approval. */
export interface PersonalServerReach {
	profile: SandboxProfileId;
	/** The profile's display name. */
	name: string;
	/** For a server that is started by a command. */
	command: string;
	/** For a server that is reached at an address. */
	address: string;
}

/** The account's settings, as their page shows them. No value of a secret is among them: `accountSecrets` lists those. */
export interface AccountSettings {
	defaults: AccountDefaults;
	/** By name. */
	servers: PersonalServer[];
	/** One entry for each sandbox this deployment can run. */
	serverReach: PersonalServerReach[];
	/** How many servers and account secrets a user may keep, and how long a server's definition may be as JSON, in bytes. */
	limits: { servers: number; definitionBytes: number; secrets: number };
}

/** Account secrets expose only metadata here and never go to repository setup. */
export interface AccountSecret {
	/** The environment variable a server's definition reads it as. */
	name: string;
	/** A repository's secret's scopes, without the setup command: "setup" is MCP servers only, "agent" the agent's commands as well. */
	scope: SecretScope;
	/** When its value or scope was last changed, ms since the epoch. */
	updatedAt: number;
	/** What it reaches in the sandbox the list was asked for. */
	reach: SecretReach;
	/** Repository-specific value and scope override the account secret in these repositories. */
	repositories: string[];
}

export const MODEL_CHECKS_PER_MINUTE = 12;
export const MODEL_PROVIDERS = ["openai", "anthropic", "google", "openrouter"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export function isModelProvider(value: unknown): value is ModelProvider {
	return (MODEL_PROVIDERS as readonly unknown[]).includes(value);
}

const MODEL_KEY_SHAPES: Record<ModelProvider, RegExp> = {
	openai: /^sk-(?:(?:proj|svcacct)-[A-Za-z0-9_-]{16,512}|[A-Za-z0-9]{16,512})$/,
	anthropic: /^sk-ant-(?!oat)[A-Za-z0-9_-]{16,600}$/,
	google: /^(?:AIza[A-Za-z0-9_-]{35}|AQ\.[A-Za-z0-9_.-]{16,1024})$/,
	openrouter: /^sk-or-v1-[A-Za-z0-9]{16,512}$/,
};

export function validModelKey(provider: ModelProvider, key: unknown): key is string {
	return typeof key === "string" && MODEL_KEY_SHAPES[provider].test(key);
}

export interface ModelProviderStatus {
	provider: ModelProvider;
	last4: string;
	addedAt: number;
	checkedAt: number | null;
	ok: boolean;
	models?: string[];
	windlassModels?: string[];
	needsWindlassCheck?: boolean;
}

/** A failed check leaves the key saved and returns a message safe to display. */
export type ModelProviderCheck = ModelProviderStatus & { message?: string };

export interface ModelPlanStatus {
	provider: PlanProvider;
	/** The account the plan belongs to, as the provider names it ("a@b.com · Plus"); null when the provider does not say (a Claude setup token cannot read its account). Never the token. */
	account: string | null;
	addedAt: number;
	/** When `models` was last learned; a plan without a check offers only the agent's default. */
	checkedAt: number | null;
	ok: boolean;
	/** The models the plan offers, as its provider or agent reported them: none until one did. */
	models?: string[];
	/** What the relays last saw of it (credentials/plan-health.ts): usable, at its limit, or refused twice in a row. */
	health: PlanHealth;
	/** While `limited`: when it is tried again, the provider's reset or, where it named none, a backoff probe. */
	limitedUntil: number | null;
	/** Whether `limitedUntil` is the provider's own reset time rather than a probe. */
	resetKnown: boolean;
	/** The plan's usage windows as last seen (5-hour and weekly: % used and reset), one per kind. */
	windows: UsageWindow[];
	/** When the relays last saw a request of it; null before any. */
	healthAt: number | null;
}

/** A plan as the relays see it: `invalid` after two refusals of its token in a row, until it is connected again. */
export type PlanHealth = "ok" | "limited" | "invalid";

/**
 * What a relay saw of one answer from a plan's provider, for its health: the upstream status, the rate-limit headers
 * (`limitHeaders`: numbers and status words only), and from an error body only its code and, for a limit that names
 * one, its reset (unix ms).
 */
export interface RelaySeen {
	status: number;
	headers: Record<string, string>;
	code?: string | null;
	resetsAt?: number | null;
}

export interface ModelPlans {
	/** Whether this account may connect plans (WLP_PLAN_USERS). */
	allowed: boolean;
	plans: ModelPlanStatus[];
}

/**
 * What pays for a turn's model requests: the saved key of `provider`, or with `plan` the user's connected
 * plan there. `generation` pins the saved one, so replacing or removing it ends every lease of the old one.
 */
export interface CredentialRef {
	provider: ModelProvider;
	generation: string;
	plan?: true;
}

/**
 * What pays for an agent's hosted turns where a connected plan and a saved key both could (Connections → Pay with):
 * the plan, then the key once the plan cannot; only the plan; or only the key.
 */
export const PAY_WITH = ["plan-then-key", "plan", "key"] as const;
export type PayWith = (typeof PAY_WITH)[number];

/** What a turn does when the plan paying for it is limited: wait for the reset, switch to the saved key, or ask. */
export const WHEN_LIMITED = ["wait", "key", "ask"] as const;
export type WhenLimited = (typeof WHEN_LIMITED)[number];

/** Where a turn comes from, which decides `WhenLimited` when the user chose none. */
export type TurnOrigin = "item" | "interactive";

/** The owner's defaults: a work item waits for the reset, an interactive session asks. */
export const WHEN_LIMITED_DEFAULTS: Record<TurnOrigin, WhenLimited> = { item: "wait", interactive: "ask" };

/** One agent's Pay-with choice, for each agent that can pay with a plan. */
export interface PayWithChoice {
	harness: HarnessId;
	payWith: PayWith;
	/** Null keeps the defaults by origin (`WHEN_LIMITED_DEFAULTS`). */
	whenLimited: WhenLimited | null;
	/** When it was saved, ms since the epoch; null for an agent still on the defaults. */
	updatedAt: number | null;
}

export type PayWithPatch = Pick<PayWithChoice, "harness" | "payWith" | "whenLimited">;

/**
 * UserError codes of a hosted turn Pay with held back (pay-with.ts `decidePayer`): `plan_ask`, the plan is limited or
 * at its parallel-turn cap and the person may wait or pay with the key this time (send again with `payWith: "key"`);
 * `plan_limited`, it is and the rule is to wait. The message says until when.
 */
export const PLAN_ASK = "plan_ask";
export const PLAN_LIMITED = "plan_limited";

export interface AccountSecrets {
	secrets: AccountSecret[];
	/** The profile `reach` is said for. */
	profile: SandboxProfileId;
}

/** What an API token may do. */
export type ApiTokenScope = "items:create" | "items:read";

/** The bearer value is shown once. Only its digest is retained until revocation. */
export interface ApiToken {
	id: string;
	name: string;
	scopes: ApiTokenScope[];
	createdAt: number;
	/** When it was last used, to the minute; null before. */
	usedAt: number | null;
}
