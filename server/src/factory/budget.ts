/**
 * An item's budget (Plans "software factory" §4.3) and whether a factory turn may start now (§4.2).
 *
 * Nothing here refuses. A turn that may not start yet is given a `Wait`: the one reason, the sentence a
 * person reads (§4.5), and when it is next tried. The one who holds the request (the user actor's turn
 * queue) tries it again then, or sooner when something is freed.
 *
 * Only what costs the operator is capped, and only where it does:
 *
 *   hosted     the platform pays, so the limits are the owner's settings: the hosted sandboxes a user runs at
 *              once (`FactoryLimits.hostedRunning`), the day's allowance and kept sandboxes of usage.ts, which
 *              the owner can raise per user
 *   machine    the user's own computer: bounded only by what its runner reports it can run (its slots), which
 *              nothing here can raise; the runner queues turns past them
 *
 * An item's own budget is in the units of what pays for its turns: dollars where an API key pays, percentage
 * points of the plan's windows where a plan pays (its 5-hour window and its weekly window, each where the plan reports
 * it), and a cost-weighted token figure only where none can be measured (and, hosted, its sandbox time). When it is used up the item asks its person for more; it never throws
 * away work.
 *
 * The numbers are `FACTORY_DEFAULTS`, the defaults of the WLP_FACTORY_* settings config.ts reads. The day's
 * allowance and the kept sandboxes are usage.ts's own settings.
 */

import { MINUTE, providerWait } from "../provider-usage.js";
import type {
	CostRates,
	HarnessId,
	ItemAgent,
	ProviderAccount,
	SandboxPlace,
	TurnUsage,
	UsageNumbers,
	UsageWindow,
} from "../contract.js";
import { addTurn, itemCost, noUsage, PAID_BY_TOKEN, type TurnMeter } from "./cost.js";
import { itemTokensOf, machineHarness, type SignInMethod } from "../sandbox/harnesses.js";
import { nextUtcDay, spellSeconds, type UsageEntry } from "../usage.js";
import type {
	AgentTurn,
	FactoryItem,
	FactoryLimits,
	ItemBudget,
	ItemSpend,
	StopCause,
	TurnSpend,
	Wait,
} from "./types.js";

export const FACTORY_DEFAULTS: FactoryLimits = {
	dailyTokens: null,
	githubItemsPerDay: 20,
	attachments: { bytes: 2 * 1024 * 1024, perItem: 40, accountBytes: 1_073_741_824, days: 180 },
	hostedRunning: 3,
	item: { tokens: 2_000_000, hostedSeconds: 2 * 3600, usd: 5, planPct: 20, planWeekPct: 3 },
};

/**
 * What a cached input token counts for against an item's budget, against 1 for every other token. A
 * prompt-cache read is billed at a tenth of the base input price by Anthropic (Claude: "cache hits … 0.1x
 * base input price") and by OpenAI for its current models (GPT-5: cached input $0.125 against $1.25 per
 * million). The platform keeps no price table of its own, so the budget uses that published ratio for
 * every agent: a long turn that mostly rereads its context is not counted as if it read it all afresh.
 */
export const CACHED_INPUT_WEIGHT = 0.1;

/** A turn that waits at a place is tried again after 30 s, then twice as long each time, up to 5 min. */
export const RETRY_FIRST_MS = 30_000;
export const RETRY_MOST_MS = 5 * 60_000;

/** When a request that has waited `attempt` times before (0: never) is tried again. */
export function retryAt(at: number, attempt: number): number {
	return at + Math.min(RETRY_MOST_MS, RETRY_FIRST_MS * 2 ** Math.max(0, Math.min(attempt, 10)));
}

/** A turn's tokens as reported: what went in and what came out (cached input and reasoning are parts of those). */
export function turnTokens(usage: TurnUsage | null): number {
	return usage === null ? 0 : usage.inputTokens + usage.outputTokens;
}

/** What a turn counts against an item's budget: its tokens, cached input at `CACHED_INPUT_WEIGHT`. */
export function weightedTokens(usage: TurnUsage | null): number {
	if (usage === null) return 0;
	const cached = Math.min(Math.max(0, usage.cachedInputTokens || 0), usage.inputTokens);
	return Math.round(usage.inputTokens - cached + cached * CACHED_INPUT_WEIGHT + usage.outputTokens);
}

/** An item's agent before its first turn: Windlass's tokens are counted as they come, a machine harness has reported none. */
export function newAgent(
	harness: HarnessId,
	model: string,
	effort?: string | null,
	signIn?: ItemAgent["signIn"],
): ItemAgent {
	return {
		harness,
		model,
		...(effort && { effort }),
		...(signIn && { signIn }),
		tokens: harness === "windlass" ? "counted" : "not_reported",
		reportedTokens: 0,
		cost: null,
		fiveHour: null,
	};
}

/** The agent of an item, also of one filed before agents could be chosen. */
export function itemAgent(item: Pick<FactoryItem, "agent" | "spent">): ItemAgent {
	return item.agent ?? { ...newAgent("windlass", "default"), reportedTokens: rawTokens(item.spent) };
}

/** An item's tokens as reported, cached input at full count; an item stored before they were kept has only `tokens`. */
export const rawTokens = (spent: Pick<ItemSpend, "tokens" | "rawTokens">): number => spent.rawTokens ?? spent.tokens;

export const noSpend = (): ItemSpend => ({ tokens: 0, rawTokens: 0, turns: 0, activeSeconds: 0, hostedSeconds: 0 });

/**
 * What a machine harness reported of a turn, read from the turn's usage (the `session/prompt` answer) and
 * its last ACP usage update. Its tokens count against the item's budget only where the harness bills by
 * token (`itemTokensOf`: "budget", or an API key where the sign-in decides): a subscription's are shown,
 * not counted. `signIn`: the method used for this turn. Undefined for Windlass.
 */
export function agentTurn(
	harness: HarnessId | undefined,
	usage: TurnUsage | null,
	context?: { cost: { amount: number; currency: string } | null; fiveHourUsedPct?: number } | null,
	fiveHourAtStart?: number,
	signIn?: SignInMethod,
): AgentTurn | undefined {
	const machine = machineHarness(harness);
	if (!machine) return undefined;
	const end = context?.fiveHourUsedPct;
	return {
		reported: usage === null ? null : turnTokens(usage),
		counted: itemTokensOf(machine, signIn) === "budget",
		cost: context?.cost ?? null,
		fiveHour: end === undefined ? null : { start: fiveHourAtStart ?? end, end },
	};
}

/** A turn's spend: its tokens count only where its agent's are counted, cost-weighted. */
export function turnSpend(usage: TurnUsage | null, agent?: AgentTurn): TurnSpend {
	const counted = !agent || agent.counted;
	return {
		tokens: counted ? weightedTokens(usage) : 0,
		rawTokens: counted ? turnTokens(usage) : 0,
		hostedSeconds: 0,
		...(agent && { agent }),
	};
}

/**
 * The sentence that stops an item whose agent's tokens count against its budget (`itemTokens: "budget"`)
 * when a turn reported none: the budget cannot be enforced, and the turn is never taken as 0 tokens.
 * Null where the turn reported its tokens, or its agent's are not counted.
 */
export function unmeasuredTurn(spend: TurnSpend, agent: Pick<ItemAgent, "harness">): string | null {
	if (!spend.agent?.counted || spend.agent.reported !== null) return null;
	return `${machineHarness(agent.harness)?.name ?? "The agent"} did not report token use, so the item's budget can't be enforced.`;
}

/** Adds a turn's report to the item's agent. The cost is the conversation's so far, so the latest replaces it. */
export function noteAgentTurn(item: FactoryItem, turn: AgentTurn): void {
	const agent = item.agent ?? itemAgent(item);
	if (turn.reported !== null) {
		const subscribed = agent.tokens === "subscription" ? agent.reportedTokens : (agent.subscriptionTokens ?? 0);
		agent.reportedTokens += turn.reported;
		agent.tokens = turn.counted || agent.tokens === "counted" ? "counted" : "subscription";
		if (agent.tokens === "counted") {
			const total = subscribed + (turn.counted ? 0 : turn.reported);
			if (total) agent.subscriptionTokens = total;
		}
	}
	if (turn.cost) agent.cost = turn.cost;
	if (turn.fiveHour)
		agent.fiveHour = { first: agent.fiveHour?.first ?? turn.fiveHour.start, latest: turn.fiveHour.end };
	item.agent = agent;
}

/**
 * An item's tokens in words: "1,200 of 2,000,000 tokens (cost-weighted; 9,800 as reported)" where they are
 * counted, otherwise what its agent reported, never a 0 that was not measured.
 */
export function tokenWords(
	spent: Pick<ItemSpend, "tokens" | "rawTokens">,
	budget: Pick<ItemBudget, "tokens">,
	agent?: ItemAgent,
): string {
	const name = agent ? (machineHarness(agent.harness)?.name ?? "Windlass") : "Windlass";
	if (!agent || agent.tokens === "counted") {
		const subscription = agent?.subscriptionTokens
			? `, plus ${agent.subscriptionTokens.toLocaleString("en-US")} subscription tokens`
			: "";
		return `${spent.tokens.toLocaleString("en-US")} of ${budget.tokens.toLocaleString("en-US")} tokens (cost-weighted; ${rawTokens(spent).toLocaleString("en-US")} as reported)${subscription}`;
	}
	if (agent.tokens === "subscription")
		return `${agent.reportedTokens.toLocaleString("en-US")} tokens reported by ${name}, not counted (subscription)`;
	return `tokens not reported by ${name}`;
}

/** Settled hosted seconds for all sessions belonging to the item. */
export function ledgerSeconds(
	entries: readonly Pick<UsageEntry, "session" | "seconds">[],
	sessions: readonly string[],
): number {
	return entries.reduce((sum, entry) => (sessions.includes(entry.session) ? sum + entry.seconds : sum), 0);
}

/** "4M", "3.9M", "850k", "120". */
export function spellTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1))}M`;
	if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
	return String(Math.round(tokens));
}

/** "$1.23", "$4". */
export function spellUsd(amount: number): string {
	const cents = Math.round(amount * 100);
	return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/** "5%", "2.5%". */
export function spellPct(points: number): string {
	return `${Number(points.toFixed(points < 10 ? 1 : 0))}%`;
}

/** Said where a plan paid and reported none of its windows, so the item is held to tokens instead. */
export const PLAN_UNREPORTED = "Counted in tokens: your plan doesn't report its usage.";

/** Whether tokens hold an item because its plan reported no window it could be measured in. */
export const planUnreported = (spent: Pick<ItemSpend, "planUnreported" | "planPct" | "planWeekPct" | "usd">): boolean =>
	!!spent.planUnreported && spent.planPct === undefined && spent.planWeekPct === undefined && spent.usd === undefined;

const BUDGET_WORDS: Record<keyof ItemBudget, (spent: ItemSpend, budget: number) => string> = {
	tokens: (spent, budget) =>
		`Used its ${spellTokens(budget)}-token budget.${planUnreported(spent) ? ` ${PLAN_UNREPORTED}` : ""}`,
	hostedSeconds: (spent, budget) =>
		`This item's hosted sandbox has run for ${spellSeconds(spent.hostedSeconds)} of its ${spellSeconds(budget)}.`,
	usd: (spent, budget) => `Used ${spellUsd(spent.usd ?? 0)} of its ${spellUsd(budget)} budget.`,
	planPct: (_spent, budget) => `Used its ${spellPct(budget)} of your 5-hour window.`,
	planWeekPct: (_spent, budget) => `Used its ${spellPct(budget)} of your weekly window.`,
};

/** The plan's windows a budget is kept in, by figure. */
export const PLAN_WINDOWS = { planPct: "5h", planWeekPct: "7d" } as const;
export type PlanFigure = keyof typeof PLAN_WINDOWS;

/** The figures of a budget, in the order a stop names them. */
export const BUDGET_FIGURES = [
	"usd",
	"planPct",
	"planWeekPct",
	"tokens",
	"hostedSeconds",
] as const satisfies ReadonlyArray<keyof ItemBudget>;

/**
 * Which figures hold an item now, by what paid for its turns: dollars once a key-paid turn was priced, a plan's share
 * of each window it reports once a plan-paid turn saw that window (5-hour and weekly: both hold, and the first used up
 * stops it), tokens where none did (or a key turn could not be priced, or the plan reports no window). An item without
 * a dollar or plan budget (filed before they were kept, a feature's own allowance) holds to tokens.
 */
export function budgetUnits(
	budget: Pick<ItemBudget, "usd" | "planPct" | "planWeekPct">,
	spent: Pick<ItemSpend, "usd" | "planPct" | "planWeekPct" | "usdUnknown">,
): Record<keyof ItemBudget, boolean> {
	const usd = budget.usd !== undefined && spent.usd !== undefined;
	const planPct = budget.planPct !== undefined && spent.planPct !== undefined;
	const planWeekPct = budget.planWeekPct !== undefined && spent.planWeekPct !== undefined;
	return {
		usd,
		planPct,
		planWeekPct,
		tokens: (!usd && !planPct && !planWeekPct) || !!spent.usdUnknown,
		hostedSeconds: true,
	};
}

/**
 * The first of an item's budgets it has used up, with the sentence a person reads; null while every
 * one has something left. Hosted seconds are no limit on a machine.
 */
export function budgetStop(
	budget: ItemBudget,
	spent: ItemSpend,
	place: SandboxPlace,
): { cause: StopCause & keyof ItemBudget; sentence: string } | null {
	const units = budgetUnits(budget, spent);
	for (const cause of BUDGET_FIGURES) {
		if (!units[cause] || (cause === "hostedSeconds" && place.kind !== "hosted")) continue;
		const cap = budget[cause];
		if (cap !== undefined && (spent[cause] ?? 0) >= cap) return { cause, sentence: BUDGET_WORDS[cause](spent, cap) };
	}
	return null;
}

/**
 * What a part of a feature is given in dollars and plan shares: the item's, in the proportion of its planned tokens to
 * an item's (the planner budgets in tokens only). None where the item's budget has none.
 */
export function partShare(single: ItemBudget, tokens: number): Pick<ItemBudget, "usd" | PlanFigure> {
	const ratio = single.tokens > 0 ? Math.min(1, tokens / single.tokens) : 1;
	const share = (pct: number) => Math.max(0.1, Math.round(pct * ratio * 10) / 10);
	return {
		...(single.usd !== undefined && { usd: Math.max(0.01, Math.round(single.usd * ratio * 100) / 100) }),
		...(single.planPct !== undefined && { planPct: share(single.planPct) }),
		...(single.planWeekPct !== undefined && { planWeekPct: share(single.planWeekPct) }),
	};
}

/**
 * A key-paid turn's model dollars at `models`' prices: null where they could not be priced (no catalog, an
 * unknown model, a turn that reported nothing), undefined where no key paid.
 */
export function turnUsd(meter: TurnMeter | undefined, models: CostRates["models"]): number | null | undefined {
	if (!meter || !PAID_BY_TOKEN.has(meter.payer)) return undefined;
	const usage = noUsage();
	addTurn(usage, meter);
	const cost = itemCost(usage, { models, source: null, sandbox: null });
	return cost.models.unknown ? null : cost.models.usd;
}

/**
 * The percentage points of a plan's window of `kind` used between two snapshots: the rise in its % used, or, where
 * the window was renewed meanwhile (a later reset), what the new window used. Null where either side did not see it.
 * Concurrent turns on the same plan each see the whole plan move: a share is an upper bound.
 */
export function windowShare(
	start: readonly UsageWindow[] | null | undefined,
	end: readonly UsageWindow[] | null | undefined,
	kind: "5h" | "7d",
): number | null {
	const before = start?.find(w => w.kind === kind && w.usedPct !== null);
	const after = end?.find(w => w.kind === kind && w.usedPct !== null);
	if (!before || !after) return null;
	const renewed = before.resetsAt !== null && after.resetsAt !== null && after.resetsAt > before.resetsAt + 60_000;
	return Math.max(0, renewed ? after.usedPct! : after.usedPct! - before.usedPct!);
}

/** The figures a running turn can be stopped at, in the order they hold an item. */
export const TURN_FIGURES = ["usd", "planPct", "planWeekPct", "tokens"] as const;
export type TurnFigure = (typeof TURN_FIGURES)[number];

/** What an item has left of the figure that holds it, for a turn about to start. Undefined where nothing measurable holds it. */
export function budgetLeft(budget: ItemBudget, spent: ItemSpend): { figure: TurnFigure; left: number } | undefined {
	const units = budgetUnits(budget, spent);
	for (const figure of TURN_FIGURES) {
		const cap = budget[figure];
		if (units[figure] && cap !== undefined) return { figure, left: Math.max(0, cap - (spent[figure] ?? 0)) };
	}
	return undefined;
}

/** How far past its budget a running turn goes before it is stopped: a share of the item's whole budget in that figure. */
export const TURN_BUDGET_GRACE = 0.05;

/** One figure a running turn is stopped at, and how much of it the turn may use in its unit. */
export interface TurnStop {
	figure: TurnFigure;
	/** What the turn may use: dollars, points of one of the plan's windows, or weighted tokens. */
	stopAt: number;
}

/**
 * Where an item's turn is stopped while it runs (#100a): the figure that holds the item (`budgetLeft`) and how much of
 * it the turn may use, what was left plus a small grace (`TURN_BUDGET_GRACE`), so that a turn about to finish is not
 * cut off for a few cents. Where both of a plan's windows hold the item, the weekly one is `also`: the turn stops at
 * whichever it reaches first. Decided with the turn (change.ts `nextTurn`) and handed to its session with the delivery.
 */
export interface TurnBudget extends TurnStop {
	also?: TurnStop;
}

export function turnBudget(budget: ItemBudget, spent: ItemSpend): TurnBudget | undefined {
	const held = budgetLeft(budget, spent);
	if (!held) return undefined;
	const stop = (figure: TurnFigure, left: number): TurnStop => {
		const grace = (budget[figure] ?? 0) * TURN_BUDGET_GRACE;
		return { figure, stopAt: figure === "tokens" ? Math.round(left + grace) : left + grace };
	};
	const first = stop(held.figure, held.left);
	const week = budget.planWeekPct;
	if (held.figure !== "planPct" || week === undefined || !budgetUnits(budget, spent).planWeekPct) return first;
	return { ...first, also: stop("planWeekPct", Math.max(0, week - (spent.planWeekPct ?? 0))) };
}

/**
 * During a turn: whether what it used so far in a stop's figure (`running`) reached where it stops. Unknown use
 * (null or undefined: a price not known, a window not seen, an agent that reports its tokens only at the end) never
 * stops a turn. On true the session stops the turn as a person's Stop would, and the item asks its budget question.
 */
export function overBudgetNow(stop: TurnStop | undefined, running: number | null | undefined): boolean {
	return stop !== undefined && typeof running === "number" && Number.isFinite(running) && running >= stop.stopAt;
}

/** What is known live of a running turn's use (`runningSpend`). */
export interface RunningSeen {
	usd?: number | null;
	planShare?: number | null;
	planWeekShare?: number | null;
	tokens?: number | null;
}

/**
 * What a running turn used so far in `figure`, from what is known of it live: its dollars where a key pays (`usd`,
 * priced as at its end, `turnUsd`), its rise in each of the plan's windows where a plan pays (`planShare` for the
 * 5-hour window, `planWeekShare` for the weekly one, `windowShare`), or its weighted tokens where its agent's tokens
 * count and come as it works (`tokens`). Null where it is not known.
 */
export function runningSpend(figure: TurnFigure, seen: RunningSeen): number | null {
	const value =
		figure === "usd"
			? seen.usd
			: figure === "planPct"
				? seen.planShare
				: figure === "planWeekPct"
					? seen.planWeekShare
					: seen.tokens;
	return typeof value === "number" ? value : null;
}

/** The first of a turn's stops it reached, with what it used of that figure; null while it is within all of them. */
export function crossedStop(
	budget: TurnBudget | undefined,
	seen: RunningSeen,
): { figure: TurnFigure; running: number } | null {
	if (!budget) return null;
	for (const stop of [budget, ...(budget.also ? [budget.also] : [])]) {
		const running = runningSpend(stop.figure, seen);
		if (overBudgetNow(stop, running)) return { figure: stop.figure, running: running! };
	}
	return null;
}

// ---------------------------------------------------------------------------------------------
// Whether a turn may start
// ---------------------------------------------------------------------------------------------

/** What is known of the place when a turn would start there. */
export type PlaceNow =
	| {
			kind: "hosted";
			/** The user's day (usage.ts): allowance used and held, kept sandboxes and their cap. */
			usage: UsageNumbers;
			/** The user's hosted sandboxes running now. */
			running: number;
			/** True when the session has no sandbox and one must be made: it needs a place among the kept ones. */
			needsSandbox: boolean;
			/** Who holds the kept places now, in words (usage.ts `keptHolder`), for the question the item asks at the cap. */
			holders?: string[];
			/** Set when the sandbox layer refused at the last try because the deployment runs as many as it may (WLP_E2B_MAX_RUNNING): that number. */
			deploymentFull: number | null;
	  }
	| {
			kind: "machine";
			/** What the machine is called on the Machines page. */
			name: string;
			online: boolean;
			/** Its control socket is online, but the runner did not open the session link. */
			attachRetryAt: number | null;
			keptFull: boolean;
			slots?: { units: number; free: number };
			/** Its sandboxes running, and how many its runner said it runs at most. */
			running: number;
			max: number;
	  };

/** An item's turn needs a hosted sandbox and every place the account may keep is taken: by what, and what the person can do. */
export function keptCapSentence(limit: number, holders: string[]): string {
	const named =
		holders.length === 0
			? ""
			: `: ${holders.slice(0, 5).join(", ")}${holders.length > 5 ? `, and ${holders.length - 5} more` : ""}`;
	return `This item's next turn needs a hosted sandbox, and all ${plural(limit, "hosted sandbox", "hosted sandboxes")} you may keep are in use${named}. Free one on the Usage page and the turn starts, wait for one to be freed, or give up. Sandboxes on your own machines are not counted.`;
}

export function slotWait(name: string, units: number, free: number): string {
	return `Waiting for ${units} free slot${units === 1 ? "" : "s"} on ‘${name}’. ${free} free now.`;
}

export interface AdmissionInput {
	provider?: ProviderAccount;
	/** All Factory turns currently use the platform model source. */
	dailyTokenWait?: string | null;
	at: number;
	limits: FactoryLimits;
	place: PlaceNow;
	/** How many times this request has waited before: spaces the tries. */
	attempt: number;
}

export type Admission = { ok: true } | { ok: false; wait: Wait; keptCap?: true };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const utcTime = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/** In the order a person can act on them: the first that holds is the one reason named. */

export function admit(input: AdmissionInput): Admission {
	const { at, limits, place } = input;
	const account = input.provider;
	if (account?.state === "limited" && account.limitedUntil !== null && account.limitedUntil > at) {
		const reset = account.windows.find(
			w => w.source === "refusal" && w.resetsAt !== null && w.resetsAt + MINUTE === account.limitedUntil,
		)?.resetsAt;
		return {
			ok: false,
			wait: providerWait(account.harness, place.kind === "hosted" ? "hosted" : place.name, account.limitedUntil, reset),
		};
	}
	const later = retryAt(at, input.attempt);
	const wait = (reason: Wait["reason"], sentence: string, when = later, keptCap?: true): Admission => ({
		ok: false,
		wait: { reason, sentence, retryAt: when },
		...(keptCap && { keptCap }),
	});

	if (input.dailyTokenWait) return wait("capacity", input.dailyTokenWait, nextUtcDay(at));

	if (place.kind === "machine" && (!place.online || (place.attachRetryAt ?? 0) > at)) {
		return wait(
			"machine",
			`Waiting for your machine "${place.name}" to come back online.`,
			place.online ? place.attachRetryAt! : later,
		);
	}
	if (place.kind === "machine") {
		if (place.slots && place.slots.free < place.slots.units)
			return wait("machine", slotWait(place.name, place.slots.units, place.slots.free));
		if (place.keptFull)
			return wait(
				"machine",
				`Waiting for room on your machine "${place.name}". Its runner has reached its limit on kept sandboxes.`,
				later,
				true,
			);
		if (place.running >= place.max)
			return wait(
				"machine",
				`Waiting for ‘${place.name}’: ${place.running} of ${place.max} sandboxes running there, its runner's limit.`,
			);
		return { ok: true };
	}

	const { usage } = place;
	if (usage.leftSeconds !== null && usage.leftSeconds < usage.startSeconds) {
		const allowance = spellSeconds(usage.allowanceSeconds ?? 0);
		const until = spellSeconds(Math.max(60, Math.ceil((usage.resetsAt - at) / 60_000) * 60));
		return wait(
			"capacity",
			`Your ${allowance} of hosted sandbox time for today are used; it starts again at 00:00 UTC (in ${until}). The allowance is this deployment's setting, which its owner can raise.`,
			usage.resetsAt,
		);
	}
	if (place.needsSandbox && usage.sandboxes.limit !== null && usage.sandboxes.kept >= usage.sandboxes.limit) {
		return wait("sandboxes", keptCapSentence(usage.sandboxes.limit, place.holders ?? []), later, true);
	}
	if (place.running >= limits.hostedRunning) {
		return wait(
			"capacity",
			`Waiting for one of your ${plural(limits.hostedRunning, "hosted sandbox", "hosted sandboxes")} that run at once: ${place.running} running now. Your machines don't count toward this.`,
		);
	}
	if (place.deploymentFull !== null) {
		return wait(
			"capacity",
			`Waiting for a hosted sandbox: this deployment runs ${place.deploymentFull} at once and all are in use. Trying again at ${utcTime(later)} UTC.`,
		);
	}
	return { ok: true };
}
