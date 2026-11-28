import type { ModelProvider } from "./account.js";
import type { SpendUsage } from "./cost.js";
import type { FactoryLimits } from "./items.js";
import type { HostedSize, HostedSizeOption } from "./hosted-sizes.js";

/** Hosted running time by UTC day. Paused sandboxes consume none. Unused held seconds return on stop. */
export interface UsageNumbers {
	/** The server's clock when this was read, ms since the epoch. */
	at: number;
	/** The UTC day the numbers are for, "2026-11-17". */
	day: string;
	/** When that day ends and the allowance is whole again: the next midnight UTC, ms since the epoch. */
	resetsAt: number;
	/** The sandbox time a user may use in one day, in seconds; null when the deployment sets no limit. */
	allowanceSeconds: number | null;
	/** Seconds counted today: what sandboxes that have stopped ran. */
	usedSeconds: number;
	/** Seconds held by sandboxes that run now. They count as used until each sandbox stops and its real time is counted. */
	heldSeconds: number;
	/** What is left of today's allowance for a turn that starts now, never below 0; null without a limit. */
	leftSeconds: number | null;
	/** The least that must be left for a turn to start, or for a paused sandbox to be started to read its workspace. */
	startSeconds: number;
	/** How many sandboxes the user keeps, running or paused, and the most they may keep; `limit` is null without one. */
	sandboxes: { kept: number; limit: number | null };
	/** The calendar month's hosted minutes, where the account has a monthly allowance (a plan, or the operator's `hostedMinutes`). Absent: only the day counts. */
	hosted?: HostedMonth;
}

/** Weighted seconds per UTC calendar month. Small, standard and large cost 0.5×, 1× and 2× respectively; machine time is excluded. */
export interface HostedMonth {
	/** "2026-11". */
	month: string;
	/** End of the hosted allowance period, ms since the epoch. */
	resetsAt: number;
	/** What the plan includes. */
	includedSeconds: number;
	/** The most that may be used: the included minutes, and on a plan with overage the minutes the spend cap pays for. */
	limitSeconds: number;
	/** Counted this month, weighted. */
	usedSeconds: number;
	/** Held by sandboxes that run now, weighted. */
	heldSeconds: number;
	/** What is left of `limitSeconds`, never below 0. */
	leftSeconds: number;
	/** Subscription cadence for Pro. */
	period?: BillingPeriod;
	/** The plan these are of, where the deployment has billing; absent where the operator set the allowance. */
	plan?: PlanId;
}

/** A plan of the deployment's billing (billing/plans.ts). Team and Enterprise are planned, not offered. */
export type PlanId = "free" | "pro";
export type BillingPeriod = "month" | "year";

/** What a plan gives, as the upgrade page compares them. Prices in US cents. */
export interface PlanInfo {
	id: PlanId;
	name: string;
	/** Per month, billed monthly; and per year, billed yearly (null where the plan has no yearly price). */
	monthlyCents: number;
	yearlyCents: number | null;
	machines: number;
	hostedMinutes: number;
	hostedRunning: number;
	keptSandboxes: number;
	sizes: Array<"small" | "standard" | "large">;
	crossRepo: boolean;
	githubItemsPerDay: number;
	/** US cents per 1,000 hosted minutes past the included ones; null: a hard stop at the included minutes. */
	overageCentsPer1000: number | null;
}

/** The Plan section of Settings and the upgrade page. `exempt` identifies an account using deployment limits where billing is enabled. */
export type BillingView =
	| { enabled: false; exempt?: true }
	| {
			enabled: true;
			/** The plan whose limits apply now: Pro while its subscription is active or in its grace period, otherwise Free. */
			plan: PlanId;
			/** The subscription's state: "none" without one; "past_due" after a failed payment, until `graceUntil`; "ended" after it ended. */
			status: "none" | "active" | "past_due" | "paused" | "ended";
			period: BillingPeriod | null;
			/** When the subscription renews, or ends where `cancelAtPeriodEnd`. */
			periodEnd: number | null;
			cancelAtPeriodEnd: boolean;
			/** After a failed payment: when the account falls back to Free unless a payment succeeds. Nothing is deleted then. */
			graceUntil: number | null;
			/** The most overage may cost in a month, in US cents; `maxCapCents` is the highest it may be set to. */
			capCents: number;
			maxCapCents: number;
			/** Overage minutes counted this month, and what the provider has been told of them. */
			overageMinutes: number;
			reportedMinutes: number;
			/** Whether a customer portal can be opened: there is a customer at the provider. */
			portal: boolean;
			plans: PlanInfo[];
			month: HostedMonth | null;
	  };

/** One agent's sandbox time today. */
export interface UsageSession {
	sessionId: string;
	/** Null for an agent that was deleted since. */
	title: string | null;
	/** Seconds counted today for this agent's sandbox. */
	seconds: number;
	/** Upper bound charged when a stopped server could not report actual runtime. */
	unreportedSeconds: number;
	/** Seconds its sandbox holds now; 0 when it does not run. */
	heldSeconds: number;
	/** The size of its sandbox, where the deployment offers sizes: what its seconds are priced at. */
	hostedSize?: HostedSize;
}

/** One UTC day of the history. */
export interface UsageDay {
	/** "2026-11-17". */
	day: string;
	seconds: number;
}

/** A sandbox the user keeps: it exists for one of their agents, running or paused. */
export interface KeptSandbox {
	/** The agent it was made for: what `freeSandbox` takes. */
	sessionId: string;
	/** Null when that agent no longer exists and its sandbox was left behind. Work-item sessions include their role. */
	title: string | null;
	/** The work item whose builder or reviewer it is. */
	item?: { id: string; role: "builder" | "reviewer" };
	/** A reviewer's sandbox, which shares its item builder's place: it takes none of the cap of its own. */
	sharesPlace?: true;
	/** "starting": the agent was given the place and its sandbox is being made. */
	state: "running" | "paused" | "starting";
	/** When the agent was last prompted or its last turn ended, ms since the epoch; null without the agent. */
	usedAt: number | null;
	/** True while the agent works: its sandbox cannot be freed until the turn has ended or is stopped. */
	busy: boolean;
	/** "owner/name" of the repository the agent was launched on through the GitHub connection, when it was. */
	repository: string | null;
	/** Whether the platform has pushed work of this agent to GitHub: that much is cloned again into a new sandbox. */
	pushed: boolean;
	/** Its size, where the deployment offers sizes. */
	hostedSize?: HostedSize;
}

/** What a second of a running sandbox is estimated to cost. */
export interface UsagePrice {
	/** US dollars per second. */
	usdPerSecond: number;
	/** What that price is of, for a sentence: "1 CPU and 1,024 MiB of memory". The provider is never named: it is an estimate either way. */
	basis: string;
}

/** What the usage page shows. */
export interface UsageView extends UsageNumbers {
	providerTokens?: { provider: ModelProvider; tokens: number }[];
	/** Model usage reported by requests using the platform credential on this UTC day. */
	usedModelTokens: number;
	/** Work items' model turns on this UTC day, by model and payer: priced in the browser like an item's cost (factory/cost.ts). */
	modelsToday?: SpendUsage;
	factoryLimits: FactoryLimits;
	/** Today's sandbox time by agent, the most first; an agent whose sandbox runs now is among them. */
	today: UsageSession[];
	/** The last USAGE_HISTORY_DAYS days, the oldest first and today last. */
	days: UsageDay[];
	/** The sandboxes the user keeps, as the provider lists them, the most recently used first. */
	kept: KeptSandbox[];
	/** Null where running a sandbox is not billed by the second (local Docker): no cost is estimated then. The smallest size's, where there are sizes. */
	price: UsagePrice | null;
	/** The hosted sizes and what an hour of each costs, as `PlatformInfo.hostedSizes`. The allowance is in seconds whatever the size. */
	hostedSizes?: HostedSizeOption[];
	/** Freeing the sandbox keeps external memory, restores a per-turn copy, or loses sandbox-only memory. */
	memory: "kept" | "copied" | "lost";
}
