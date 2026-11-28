/**
 * A user's sandbox time and kept sandboxes: what is counted, the two limits, and the book that decides.
 *
 * Only hosted sandboxes use this book. Their time counts from the moment a sandbox is created or
 * resumed until it is suspended, removed, or stops by itself. A paused sandbox runs nothing and
 * counts no time; it counts as one of the sandboxes its user keeps.
 *
 *   The allowance    A user may use WLP_DAILY_SANDBOX_SECONDS of sandbox time in one UTC day (two hours
 *                    unless set otherwise).
 *   The cap          A user may keep WLP_MAX_KEPT_SANDBOXES sandboxes at once, running or paused (five).
 *
 * One place decides both: the user's `user` actor, which every server reaches and which runs one step
 * at a time. It keeps a `UsageBook` beside its tables, and every decision is one synchronous call on
 * the book, so two sessions that ask at the same moment are answered one after the other.
 *
 * A ledger, not a counter. Every second counted is in an entry: which session, which hold, how many
 * seconds, when, and a note where something was out of the ordinary. A day's total is the sum of its
 * entries and is never stored by itself, so it can be added up again, the usage page can show the
 * days and the agents, and a mistake can be seen. Nothing is ever taken out of an entry.
 *
 * Reserve, then settle. A session does not ask whether time is left and report afterwards: two that
 * asked together would both be told yes. Before its sandbox runs, it takes a hold: a few minutes of
 * the day's allowance (WLP_USAGE_HOLD_SECONDS), which count as used from that moment for everybody
 * else. While the sandbox runs, the session trades the hold for the next one when it ends, reporting
 * what the first really used (`reserve` with `settle`, one step). When the sandbox stops, it settles
 * the last hold with what ran, and the rest of that hold is free again. A hold never reaches past
 * midnight UTC, so the hold that follows it is taken from the new day.
 *
 * A hold that nobody settles runs out by itself, HOLD_GRACE_SECONDS after the time it was for: its
 * session's server stopped under it. It is then counted in full, as an entry of the kind "unreported":
 * the sandbox ran for some part of it that nobody measured, and the whole hold is the most this book
 * can know. A session that did measure, and only could not say so in time (it stopped its sandbox as
 * its server shut down), keeps its report and sends it when it is next awake: the difference is then
 * recorded in a "corrected" entry. A provider observation can also confirm an overrun. The original entry stays as it was.
 *
 * What a session reports is checked against the hold: never less than nothing, and never more than
 * the time since the hold was taken. A report above the hold's own length is counted (the sandbox ran
 * that long) and the entry says by how much it went over.
 *
 * The cap is a count and a claim in the same step. A session that needs a sandbox it does not have is
 * given a place with its hold or is refused both; the place is given back when its sandbox is removed.
 * The count can come apart from what exists (a sandbox that was never made, one removed at the
 * provider), so it is held against the provider's own list (`reconcile`): a claim with no sandbox
 * behind it is dropped, and a sandbox with no claim is counted even past the cap, because it exists.
 *
 * This file has no actor and reads no clock: the `user` actor keeps the book (actors/user.ts), the
 * session actor holds and settles (actors/agent-session.ts), and scripts/usage-check.ts runs the rules
 * on their own.
 */

import type { RawAccess } from "rivetkit/db";
import type {
	HarnessId,
	HostedMonth,
	PlanId,
	SandboxPlace,
	SessionSummary,
	TurnUsage,
	WindlassEvent,
	HostedSplit,
	UsageDay,
	UsageNumbers,
	UsageSession,
} from "./contract.js";
import { windlassProvider } from "./sandbox/harnesses.js";
import { USAGE_HISTORY_DAYS } from "./contract.js";
import { meterPeriod, monthOf, type MeterPeriod, type SubscriptionDates } from "./billing/meter.js";
import { PLANS } from "./billing/plans.js";

/**
 * Whether the platform's own limits hold a session at this place: its sandbox time, its place among the
 * kept sandboxes, and its slot among the person's agents working at once (user.ts `internalAcquireRun`,
 * the turn queue in user-items.ts). Not on one of the user's machines: what bounds one is its runner's
 * own caps, which its owner sets (`--max-running`, `--max-sandboxes`; `MachineSummary`).
 */
export function hostedLimitsApply(place: SandboxPlace): boolean {
	return place.kind === "hosted";
}

export const DAY_MS = 86_400_000;
/** The defaults of the three settings (config.ts). */
export const DEFAULT_DAILY_SECONDS = 2 * 60 * 60;
export const DEFAULT_MAX_KEPT = 5;
export const DEFAULT_HOLD_SECONDS = 5 * 60;
/**
 * How long after the time it was for a hold still waits to be settled. It covers a session that
 * reports late, and the time a provider lets a sandbox run after the server that used it has died
 * (E2B: WLP_E2B_TURN_LEASE_MS, three minutes at most by default), so by the time a hold is counted in
 * full its sandbox has stopped.
 */
export const HOLD_GRACE_SECONDS = 4 * 60;
/** The least that must be left of the day for a turn to start: less than this is spent on starting the sandbox. */
export const MIN_START_SECONDS = 30;
/** How much later than this book's own clock a session's report may be before it is cut to that clock. */
export const REPORT_SLACK_SECONDS = 5;
/** What follows a hold's id in the entry that corrects it: a hold is counted once and corrected once. */
const LATE = "+late";
/** A hold taken this close to midnight UTC is the new day's first: the session would trade it within the same moment. */
const MIDNIGHT_SLACK_MS = 2_000;
/** A claim this young is not dropped for having no sandbox: its session is still making one. */
export const CLAIM_SETTLING_MS = 5 * 60_000;
/** How many days of entries the `user` actor keeps in its table; the usage page shows USAGE_HISTORY_DAYS of them. */
export const USAGE_KEPT_DAYS = 90;

export function dayOf(ms: number): number {
	return Math.floor(ms / DAY_MS);
}

export function nextUtcDay(at: number) {
	return (dayOf(at) + 1) * DAY_MS;
}

/** Only ChatGPT turns spend the platform’s daily model allowance. */
export function usesPlatformModel(harness: HarnessId = "windlass", model?: string): boolean {
	return harness === "windlass" && !windlassProvider(model);
}

/** Count each child from its durable spawn.ended total. Its streamed child.event copies cover the same requests. */
export function reportedModelUsage(event: WindlassEvent, includeTitle = false): TurnUsage | null {
	if (
		!(includeTitle && event.type === "session.title_usage") &&
		!["step.ended", "step.failed", "step.refused", "compaction.ended", "spawn.ended"].includes(event.type)
	)
		return null;
	const raw = event.data?.usage;
	if (typeof raw !== "object" || raw === null) return null;
	const usage = raw as Partial<TurnUsage>;
	const number = (value: unknown) =>
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
	return {
		inputTokens: number(usage.inputTokens),
		outputTokens: number(usage.outputTokens),
		cachedInputTokens: number(usage.cachedInputTokens),
		reasoningTokens: number(usage.reasoningTokens),
	};
}

/**
 * What a turn cut off with its server used, from the request events it recorded before the cut: their sum, the same
 * figures the turn summary would have added up. Null where none of them reported usage (an agent whose events carry
 * none, or a cut before its first request ended). A request still under way at the cut reported nothing and is not in it.
 */
export function cutTurnUsage(events: Iterable<WindlassEvent>): TurnUsage | null {
	let total: TurnUsage | null = null;
	for (const event of events) {
		const used = reportedModelUsage(event);
		if (used === null) continue;
		total =
			total === null
				? used
				: {
						inputTokens: total.inputTokens + used.inputTokens,
						cachedInputTokens: total.cachedInputTokens + used.cachedInputTokens,
						outputTokens: total.outputTokens + used.outputTokens,
						reasoningTokens: total.reasoningTokens + used.reasoningTokens,
					};
	}
	return total;
}

/** The timeline's sentence about a cut-off turn's tokens: what is counted of it, or that nothing could be. */
export function cutTurnUsageNote(usage: TurnUsage | null): string {
	if (usage === null)
		return "No model request of this turn reported its tokens before the cut, so none are counted for it.";
	const tokens = usage.inputTokens + usage.outputTokens;
	return `The ${tokens.toLocaleString("en-US")} tokens this turn's finished model requests reported before the cut are counted; a request still under way at the cut is not.`;
}

export const TOKEN_USAGE_TABLE = `CREATE TABLE IF NOT EXISTS token_usage (
	day INTEGER NOT NULL, session TEXT NOT NULL, seq INTEGER NOT NULL, tokens INTEGER NOT NULL,
	PRIMARY KEY (day, session, seq))`;
export interface TokenReceipt {
	seq: number;
	at: number;
	tokens: number;
	key?: import("./contract.js").CredentialRef;
}

export async function recordTurnTokens(db: Pick<RawAccess, "execute">, session: string, receipt: TokenReceipt) {
	if (![receipt.seq, receipt.tokens, receipt.at].every(n => Number.isSafeInteger(n) && n > 0))
		throw new Error("Invalid token receipt.");
	if (receipt.key) {
		const { provider, generation } = receipt.key;
		const rows = await db.execute(
			"INSERT INTO model_key_usage(day,session,seq,tokens,provider,generation) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING seq",
			dayOf(receipt.at),
			session,
			receipt.seq,
			receipt.tokens,
			provider,
			generation,
		);
		return rows.length > 0;
	}
	const rows = await db.execute(
		"INSERT INTO token_usage(day, session, seq, tokens) VALUES(?,?,?,?) ON CONFLICT DO NOTHING RETURNING seq",
		dayOf(receipt.at),
		session,
		receipt.seq,
		receipt.tokens,
	);
	return rows.length > 0;
}

export async function tokensOn(db: Pick<RawAccess, "execute">, at: number): Promise<number> {
	const [row] = await db.execute<{ used: number }>(
		"SELECT COALESCE(SUM(tokens), 0) AS used FROM token_usage WHERE day=?",
		dayOf(at),
	);
	return row!.used;
}

export function dailyTokenWait(used: number, limit: number | null): string | null {
	return limit === null || used < limit
		? null
		: `Your daily model token cap of ${limit.toLocaleString("en-US")} has been reached. New turns can start at 00:00 UTC.`;
}

/** A day as the contract names it: "2026-11-17". */
export function dayName(day: number): string {
	return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** The settings, as the book takes them. `null` is "no limit". */
export interface UsageLimits {
	dailySeconds: number | null;
	maxKept: number | null;
	holdSeconds: number;
	/**
	 * Hosted seconds a UTC calendar month may use, weighted by size (billing/meter.ts): a plan's included minutes and
	 * what its spend cap pays for, or the operator's `hostedMinutes`. Absent or null: no monthly allowance, as before plans.
	 */
	monthlySeconds?: number | null;
	subscription?: SubscriptionDates | null;
	/** Of `monthlySeconds`, what the plan includes: past it is overage. */
	includedSeconds?: number | null;
	/** The plan the monthly allowance is of, where billing set it; for the words of a refusal. */
	plan?: PlanId | null;
}

/** A second or more of sandbox time that was counted. */
export interface UsageEntry {
	/** The UTC day it counts against: the day its hold was taken on. */
	day: number;
	session: string;
	/** The hold it closed. A hold is closed once, so this names the entry. */
	hold: string;
	/**
	 * "used": the session reported what ran. "unreported": nobody did before the hold ran out, or the
	 * session took another hold without settling this one, and the hold is counted in full.
	 * "corrected": the report for an unreported hold came after all; `seconds` is the adjustment to the estimate (positive for a measured overrun), and `hold` is the hold's id with LATE after it.
	 */
	kind: "used" | "unreported" | "corrected";
	seconds: number;
	/** Monthly weight locked in when the hold opened. Older rows have no weight. */
	weight?: number | null;
	/** Opening time from the separate hold index. Older settled holds only have their ledger timestamp. */
	startedAt?: number;
	/** When it was counted, ms since the epoch. */
	at: number;
	/** Set where the count is not simply what was reported: why. */
	note: string | null;
}

/** Sandbox time a session has reserved for a sandbox that runs. */
export interface UsageHold {
	/** Made by the session: asking again with the same id is the same request, not a second hold. */
	id: string;
	session: string;
	day: number;
	seconds: number;
	/** Monthly weight locked in when the hold opened. Older rows have no weight. */
	weight?: number | null;
	startedAt: number;
	/** When it is counted in full unless it was settled. */
	expiresAt: number;
}

/** A session's place among the sandboxes its user keeps. */
export interface KeptClaim {
	session: string;
	since: number;
}

/** What a step did to the book, for whoever keeps a copy of it elsewhere. */
export interface UsageChange {
	entries: UsageEntry[];
	opened: UsageHold[];
	/** The ids of holds that are no longer open. */
	closed: string[];
	kept: KeptClaim[];
	/** The sessions whose place was given back. */
	released: string[];
}

function noChange(): UsageChange {
	return { entries: [], opened: [], closed: [], kept: [], released: [] };
}

export function isEmptyChange(change: UsageChange): boolean {
	return (
		change.entries.length === 0 &&
		change.opened.length === 0 &&
		change.closed.length === 0 &&
		change.kept.length === 0 &&
		change.released.length === 0
	);
}

export type ReserveRefusal =
	/** Too little of today's allowance is left. */
	| "allowance"
	/** The user keeps as many sandboxes as they may, and this session has none. */
	| "sandboxes";

export type ReserveResult =
	| { ok: true; hold: UsageHold; change: UsageChange }
	| { ok: false; reason: ReserveRefusal; change: UsageChange };

export interface HoldReport {
	hold: string;
	seconds: number;
	/** When the provider observed this VM running or paused. Bounds a measured correction to an expired hold. */
	observedUntil?: number;
}

export interface ReserveInput {
	/** The session's own sandbox weight, when supplied by the session opening this hold. */
	weight?: number;
	/** The new hold's id, made by the session. */
	id: string;
	session: string;
	/** True when the session has no sandbox and is about to have one made: it needs a place among the kept ones. */
	keep?: boolean;
	/** True when something is about to start (a turn, a paused sandbox): MIN_START_SECONDS must be left. Otherwise a sandbox that runs is given whatever is left. */
	fresh?: boolean;
	/** The session's open hold and what its sandbox ran of it: closed in the same step the new one is taken in. */
	settle?: HoldReport;
}

function openingTime(row: UsageEntry | UsageHold): number {
	return row.startedAt ?? row.day * DAY_MS;
}

/** One user's sandbox time and kept sandboxes. Every method takes the time, so nothing here reads a clock. */
export class UsageBook {
	private readonly entries: UsageEntry[] = [];
	private readonly modelTotals = new Map<number, number>();

	private readonly totals = new Map<number, number>();
	/** By session: a session has one sandbox, and so one open hold. */
	private readonly holds = new Map<string, UsageHold>();
	private readonly claims = new Map<string, KeptClaim>();
	/**
	 * The session whose place a session shares, if any: a work item's reviewer shares its builder's, so that an item
	 * counts as one place (its reviewer's sandbox is released after each review). Set by whoever knows the sessions.
	 */
	sharing: (session: string) => string | undefined = () => undefined;
	/** What a second of a session's sandbox counts as of the monthly allowance: its size's weight (billing/meter.ts). */
	weightOf: (session: string) => number = () => 1;

	constructor(
		readonly limits: UsageLimits,
		state: { entries?: readonly UsageEntry[]; holds?: readonly UsageHold[]; kept?: readonly KeptClaim[] } = {},
	) {
		for (const entry of state.entries ?? []) this.add(entry);
		for (const hold of state.holds ?? []) this.holds.set(hold.session, hold);
		for (const claim of state.kept ?? []) this.claims.set(claim.session, claim);
	}

	modelTokens(at: number) {
		return this.modelTotals.get(dayOf(at)) ?? 0;
	}

	/** A retried or delayed receipt cannot roll back a committed daily total. */
	noteModelTokens(at: number, total: number) {
		const day = dayOf(at);
		this.modelTotals.set(day, Math.max(this.modelTokens(at), total));
	}

	/** The least that must be left for something to start: never more than one hold. */
	get startSeconds(): number {
		return Math.min(MIN_START_SECONDS, this.limits.holdSeconds);
	}

	private add(entry: UsageEntry): void {
		this.entries.push(entry);
		this.totals.set(entry.day, (this.totals.get(entry.day) ?? 0) + entry.seconds);
	}

	/** The seconds counted on a day: the sum of its entries. */
	usedOn(day: number): number {
		return this.totals.get(day) ?? 0;
	}

	/** The same sum, added up again from the entries: what `usedOn` must equal. */
	recount(day: number): number {
		return this.entries.reduce((sum, entry) => (entry.day === day ? sum + entry.seconds : sum), 0);
	}

	private storedWeight(row: UsageEntry | UsageHold): number {
		return row.weight ?? 1;
	}

	/** Free keeps the ledger day (including the midnight handover). Pro uses the hold's opening instant. */
	private countsIn(row: UsageEntry | UsageHold, period: MeterPeriod): boolean {
		const at = this.limits.subscription ? openingTime(row) : row.day * DAY_MS;
		return at >= period.start && at < period.end;
	}

	usedInPeriod(period: MeterPeriod): number {
		let sum = 0;
		for (const entry of this.entries) if (this.countsIn(entry, period)) sum += entry.seconds * this.storedWeight(entry);
		return sum;
	}

	/**
	 * What Windlass billing makes of one entry, in hosted seconds: the part the plan's monthly allowance still included
	 * when it was counted (after the period's entries counted before it), and the part past it, with what that costs at
	 * the plan's overage price up to the spend cap. Free and yearly Pro have no overage: there it is all included. Null
	 * where no plan applies (billing off, an exempt account).
	 */
	hostedSplit(entry: UsageEntry): HostedSplit | null {
		const { plan, includedSeconds, subscription } = this.limits;
		if (!plan || includedSeconds == null) return null;
		const weighted = entry.seconds * this.storedWeight(entry);
		const centsPer1000 = subscription?.period === "month" ? PLANS[plan].overageCentsPer1000 : null;
		if (centsPer1000 === null || weighted <= 0) return { includedSeconds: weighted, extraSeconds: 0, extraUsd: 0 };
		const period = meterPeriod(subscription ?? null, openingTime(entry));
		let before = 0;
		for (const earlier of this.entries) {
			if (earlier === entry) break;
			if (this.countsIn(earlier, period)) before += earlier.seconds * this.storedWeight(earlier);
		}
		const included = Math.min(weighted, Math.max(0, includedSeconds - before));
		const extra = weighted - included;
		// Past the cap nothing is billed (billing/account.ts `overageMinutes`).
		const cap = this.limits.monthlySeconds ?? includedSeconds;
		const billed = Math.min(extra, Math.max(0, cap - Math.max(before, includedSeconds)));
		return { includedSeconds: included, extraSeconds: extra, extraUsd: (billed / 60) * (centsPer1000 / 100_000) };
	}

	private heldInPeriod(period: MeterPeriod, except?: string): number {
		let sum = 0;
		for (const hold of this.holds.values())
			if (hold.session !== except && this.countsIn(hold, period)) sum += hold.seconds * this.storedWeight(hold);
		return sum;
	}

	/** The seconds open holds have reserved of a day, without `except`'s. */
	heldOn(day: number, except?: string): number {
		let sum = 0;
		for (const hold of this.holds.values()) if (hold.day === day && hold.session !== except) sum += hold.seconds;
		return sum;
	}

	holdOf(session: string): UsageHold | null {
		return this.holds.get(session) ?? null;
	}

	openHolds(): UsageHold[] {
		return [...this.holds.values()];
	}

	keeps(session: string): boolean {
		return this.claims.has(session);
	}

	kept(): KeptClaim[] {
		return [...this.claims.values()];
	}

	/** The places the claims take: a claim that shares another one's place (`sharing`) takes none of its own. */
	places(): number {
		let count = 0;
		for (const claim of this.claims.values()) if (!this.shares(claim.session)) count++;
		return count;
	}

	/** Whether a session has a place to share now: the one it shares (`sharing`) holds a claim. */
	shares(session: string): boolean {
		const other = this.sharing(session);
		return other !== undefined && other !== session && this.claims.has(other);
	}

	/** Whether a session without a place would be refused one now. */
	atCap(session: string): boolean {
		return (
			!this.claims.has(session) &&
			!this.shares(session) &&
			this.limits.maxKept !== null &&
			this.places() >= this.limits.maxKept
		);
	}

	/** The day a hold taken now counts against. */
	private holdDay(now: number): number {
		return dayOf(now + MIDNIGHT_SLACK_MS);
	}

	/** Closes a hold with what its session reported, and returns the entry that counts it. */
	private close(hold: UsageHold, reported: number, now: number): UsageEntry {
		// What can have run of a hold is the time since it was taken, by this book's clock.
		const most = Math.max(0, Math.ceil((now - hold.startedAt) / 1000)) + REPORT_SLACK_SECONDS;
		const notes: string[] = [];
		let seconds: number;
		if (!Number.isFinite(reported) || reported < 0) {
			notes.push(`the session reported ${String(reported)} s, which cannot be: counted as 0 s`);
			seconds = 0;
		} else {
			// Whole seconds, the nearest: a hold that was traded a few milliseconds after its time ran its length, not a second more.
			seconds = Math.round(reported);
			if (seconds > most) {
				notes.push(
					`the session reported ${seconds} s, more than the ${most} s since its hold was taken: ${most} s counted`,
				);
				seconds = most;
			}
		}
		if (seconds > hold.seconds) notes.push(`${seconds - hold.seconds} s over its hold of ${hold.seconds} s`);
		return {
			day: hold.day,
			startedAt: hold.startedAt,
			session: hold.session,
			hold: hold.id,
			weight: this.storedWeight(hold),
			kind: "used",
			seconds,
			at: now,
			note: notes.length === 0 ? null : notes.join("; "),
		};
	}

	private unreported(hold: UsageHold, at: number, why: string): UsageEntry {
		return {
			day: hold.day,
			startedAt: hold.startedAt,
			session: hold.session,
			hold: hold.id,
			weight: this.storedWeight(hold),
			kind: "unreported",
			seconds: hold.seconds,
			at,
			note: why,
		};
	}

	/** Counts in full every hold that ran out without being settled. Every other step begins with this. */
	sweep(now: number): UsageChange {
		const change = noChange();
		for (const hold of [...this.holds.values()]) {
			if (hold.expiresAt > now) continue;
			this.holds.delete(hold.session);
			const entry = this.unreported(
				hold,
				hold.expiresAt,
				"no report came before the hold ran out, so it is counted in full",
			);
			this.add(entry);
			change.entries.push(entry);
			change.closed.push(hold.id);
		}
		return change;
	}

	/**
	 * Takes a hold for a session whose sandbox is about to run or goes on running, with a place among
	 * the kept sandboxes when it needs one. A refusal takes nothing and closes nothing: a hold named in
	 * `settle` stays open, and its sandbox may run to the end of it.
	 */
	reserve(now: number, input: ReserveInput): ReserveResult {
		const change = this.sweep(now);
		const own = this.holds.get(input.session) ?? null;
		// The same request again, after an answer that was lost on its way.
		if (own !== null && own.id === input.id) return { ok: true, hold: own, change };

		// A long restart may outlast both the hold and its grace. Reconcile a measured trade even
		// when sweep already booked it in full, before testing the remaining allowance.
		if (!own && input.settle?.observedUntil !== undefined) {
			const late = this.settle(now, { session: input.session, ...input.settle });
			if (late.entry) change.entries.push(late.entry);
		}
		const day = this.holdDay(now);
		const settled = own !== null && input.settle?.hold === own.id ? this.close(own, input.settle.seconds, now) : null;
		// A hold of its own that the session does not settle was lost with a server: it is counted in full.
		const dropped =
			own !== null && settled === null
				? this.unreported(own, now, "its session took another hold without settling this one, so it is counted in full")
				: null;
		const closing = settled ?? dropped;

		let grant = this.limits.holdSeconds;
		if (this.limits.dailySeconds !== null) {
			const left =
				this.limits.dailySeconds -
				this.usedOn(day) -
				this.heldOn(day, input.session) -
				(closing !== null && closing.day === day ? closing.seconds : 0);
			if (left < (input.fresh === true ? this.startSeconds : 1)) return { ok: false, reason: "allowance", change };
			grant = Math.min(grant, left);
		}
		// The month's hosted minutes, weighted by the session's size: the same rule as the day's, in weighted seconds.
		const weight = input.weight ?? this.weightOf(input.session);
		const monthly = this.limits.monthlySeconds ?? null;
		if (monthly !== null) {
			const subscription = this.limits.subscription ?? null;
			const period = meterPeriod(subscription, subscription ? now : day * DAY_MS);
			const closingWeighted =
				closing !== null && this.countsIn(closing, period) ? closing.seconds * this.storedWeight(closing) : 0;
			const left = monthly - this.usedInPeriod(period) - this.heldInPeriod(period, input.session) - closingWeighted;
			if (left < (input.fresh === true ? this.startSeconds : 1) * weight)
				return { ok: false, reason: "allowance", change };
			grant = Math.min(grant, Math.floor(left / weight), Math.ceil((period.end - now) / 1000));
		}
		// Asked after the allowance: someone told to free a sandbox must not then be told the day is used up.
		if (input.keep === true && this.atCap(input.session)) return { ok: false, reason: "sandboxes", change };

		// Never past midnight: the hold after this one is the new day's.
		grant = Math.max(1, Math.min(grant, Math.ceil(((day + 1) * DAY_MS - now) / 1000)));
		if (own !== null && closing !== null) {
			this.holds.delete(input.session);
			this.add(closing);
			change.entries.push(closing);
			change.closed.push(own.id);
		}
		if (input.keep === true) change.kept.push(...this.claim(now, input.session).change.kept);
		const hold: UsageHold = {
			id: input.id,
			session: input.session,
			day,
			seconds: grant,
			weight,
			startedAt: now,
			expiresAt: now + (grant + HOLD_GRACE_SECONDS) * 1000,
		};
		this.holds.set(input.session, hold);
		change.opened.push(hold);
		return { ok: true, hold, change };
	}

	/**
	 * The sandbox stopped: counts what it ran of the hold. A report for a hold that was counted in full
	 * because it came too late corrects the estimate once. `known` is false for a hold this book
	 * has neither open nor counted as unreported, and for a second report: nothing is counted then.
	 */
	settle(
		now: number,
		input: HoldReport & { session: string },
	): { known: boolean; entry: UsageEntry | null; change: UsageChange } {
		const change = this.sweep(now);
		const own = this.holds.get(input.session);
		if (own === undefined || own.id !== input.hold) {
			const full = this.entries.find(
				entry => entry.kind === "unreported" && entry.hold === input.hold && entry.session === input.session,
			);
			if (full === undefined || this.entries.some(entry => entry.hold === `${input.hold}${LATE}`))
				return { known: false, entry: null, change };
			// An estimate only gives time back. With a provider observation and the original opening
			// time, the VM may have measurably run beyond the reservation while its server was down.
			let most = full.seconds;
			if (full.startedAt !== undefined && input.observedUntil !== undefined && Number.isFinite(input.observedUntil)) {
				let end = Math.min(input.observedUntil, now);
				// A renewal whose reply was lost may itself already be settled or still open.
				// Any time in that later hold belongs to it.
				for (const row of this.entries) {
					if (row.session === full.session && row.startedAt !== undefined && row.startedAt > full.startedAt)
						end = Math.min(end, row.startedAt);
				}
				if (own && own.startedAt >= full.startedAt) end = Math.min(end, own.startedAt);
				most = Math.max(0, Math.round((end - full.startedAt) / 1000));
			}
			const ran = Number.isFinite(input.seconds)
				? Math.min(most, Math.max(0, Math.round(input.seconds)))
				: full.seconds;
			const entry: UsageEntry = {
				day: full.day,
				startedAt: openingTime(full),
				session: full.session,
				hold: `${full.hold}${LATE}`,
				weight: this.storedWeight(full),
				kind: "corrected",
				seconds: ran - full.seconds,
				at: now,
				note: `its session reported afterwards that the sandbox ran ${ran} s of the ${full.seconds} s that were counted in full`,
			};
			this.add(entry);
			change.entries.push(entry);
			return { known: true, entry, change };
		}
		this.holds.delete(input.session);
		const entry = this.close(own, input.seconds, now);
		this.add(entry);
		change.entries.push(entry);
		change.closed.push(own.id);
		return { known: true, entry, change };
	}

	/**
	 * A place among the kept sandboxes, for a session whose sandbox is about to be made: kept when it has
	 * one, refused at the cap, otherwise taken, in one step.
	 */
	claim(now: number, session: string): { ok: boolean; change: UsageChange } {
		const change = noChange();
		// A place it has already is claimed anew, from now: a sandbox is about to be made for it, and a reconcile
		// meanwhile must count the claim as one just made (`CLAIM_SETTLING_MS`), not drop it for its old age.
		if (this.atCap(session) && !this.claims.has(session)) return { ok: false, change };
		const claim = { session, since: now };
		this.claims.set(session, claim);
		change.kept.push(claim);
		return { ok: true, change };
	}

	/** The session's sandbox is gone: its place is free. */
	release(session: string): UsageChange {
		const change = noChange();
		if (this.claims.delete(session)) change.released.push(session);
		return change;
	}

	/**
	 * Holds the claims against the sessions the provider has a sandbox for. A claim without a sandbox is
	 * dropped, unless the session still holds time to make the sandbox it just claimed. A sandbox without a
	 * claim is given one, also past the cap: it exists, and leaving it out would let its user make more.
	 */
	reconcile(
		now: number,
		existing: readonly string[],
		canClaim = (_session: string) => true,
	): { added: string[]; dropped: string[]; change: UsageChange } {
		const change = noChange();
		const there = new Set(existing);
		const added: string[] = [];
		const dropped: string[] = [];
		for (const claim of [...this.claims.values()]) {
			if (
				there.has(claim.session) ||
				(this.holds.has(claim.session) && now - claim.since < CLAIM_SETTLING_MS && canClaim(claim.session))
			)
				continue;
			this.claims.delete(claim.session);
			change.released.push(claim.session);
			dropped.push(claim.session);
		}
		for (const session of there) {
			if (this.claims.has(session)) continue;
			const claim = { session, since: now };
			this.claims.set(session, claim);
			change.kept.push(claim);
			added.push(session);
		}
		return { added, dropped, change };
	}

	/** Today's numbers. Holds that have run out are still counted as held until `sweep` counts them: the sum is the same. */
	numbers(now: number): UsageNumbers {
		const day = dayOf(now);
		const usedSeconds = this.usedOn(day);
		const heldSeconds = this.heldOn(day);
		const allowance = this.limits.dailySeconds;
		return {
			at: now,
			day: dayName(day),
			resetsAt: (day + 1) * DAY_MS,
			allowanceSeconds: allowance,
			usedSeconds,
			heldSeconds,
			leftSeconds: allowance === null ? null : Math.max(0, allowance - usedSeconds - heldSeconds),
			startSeconds: this.startSeconds,
			sandboxes: { kept: this.places(), limit: this.limits.maxKept },
			...(this.limits.monthlySeconds != null && { hosted: this.month(now) }),
		};
	}

	/** The month's hosted minutes, in weighted seconds; only where there is a monthly allowance. */
	month(now: number): HostedMonth {
		const subscription = this.limits.subscription ?? null;
		const period = meterPeriod(subscription, now);
		const limitSeconds = this.limits.monthlySeconds ?? 0;
		const usedSeconds = this.usedInPeriod(period);
		const heldSeconds = this.heldInPeriod(period);
		return {
			month: monthOf(period.start),
			resetsAt: period.end,
			...(subscription?.period && { period: subscription.period }),
			includedSeconds: Math.min(limitSeconds, this.limits.includedSeconds ?? limitSeconds),
			limitSeconds,
			usedSeconds,
			heldSeconds,
			leftSeconds: Math.max(0, limitSeconds - usedSeconds - heldSeconds),
			...(this.limits.plan && { plan: this.limits.plan }),
		};
	}

	/** The last `count` days, the oldest first and today last. */
	days(now: number, count = USAGE_HISTORY_DAYS): UsageDay[] {
		const today = dayOf(now);
		return Array.from({ length: count }, (_, index) => {
			const day = today - (count - 1 - index);
			return { day: dayName(day), seconds: this.usedOn(day) };
		});
	}

	/** Today's sandbox time by session, the most first, with what each one's running sandbox holds. `title` is the caller's to fill in. */
	today(now: number): UsageSession[] {
		const day = dayOf(now);
		const rows = new Map<string, UsageSession>();
		const row = (session: string): UsageSession => {
			let found = rows.get(session);
			if (found === undefined) {
				found = { sessionId: session, title: null, seconds: 0, unreportedSeconds: 0, heldSeconds: 0 };
				rows.set(session, found);
			}
			return found;
		};
		const corrected = new Set(this.entries.filter(entry => entry.kind === "corrected").map(entry => entry.hold));
		for (const entry of this.entries) {
			if (entry.day !== day) continue;
			const found = row(entry.session);
			found.seconds += entry.seconds;
			if (entry.kind === "unreported" && !corrected.has(`${entry.hold}${LATE}`))
				found.unreportedSeconds += entry.seconds;
		}
		for (const hold of this.holds.values()) if (hold.day === day) row(hold.session).heldSeconds += hold.seconds;
		return [...rows.values()].sort(
			(a, b) => b.seconds + b.heldSeconds - (a.seconds + a.heldSeconds) || (a.sessionId < b.sessionId ? -1 : 1),
		);
	}

	/** The entries of a day, in the order they were counted: for a check, and for whoever reads the ledger. */
	entriesOn(day: number): UsageEntry[] {
		return this.entries.filter(entry => entry.day === day);
	}
}

// ---------------------------------------------------------------------------------------------
// What a session keeps of the time its sandbox runs
// ---------------------------------------------------------------------------------------------

/**
 * A stretch of a sandbox running, as its session keeps it in its stored state: the hold it has now,
 * and since when that hold has been running by the session's own clock. A sandbox runs from `since`
 * of its first hold to the settling of its last; trading one hold for the next moves `since` to the
 * moment of the trade, so every second is in exactly one hold.
 */
export interface OpenStretch {
	hold: string;
	since: number;
	/** How many seconds the hold is for: the session trades it for the next one when they are over. */
	seconds: number;
	/**
	 * The id of the hold the current use of the sandbox began with: a turn, a read of the workspace, a
	 * push or a wake takes a new one, and a renewal keeps it. A decision to stop counting names it, so a
	 * use that began after the decision is not stopped by it.
	 */
	use: string;
	/** When the session last saw the sandbox running after the time it would have stopped by itself. */
	seen?: number;
}

/**
 * A hold a session asked for and had no answer to, kept with the session's stored state from before
 * the request was sent. The book may have opened it, and closed the hold it was traded for: so it is
 * asked for again under the same id, from `at`, while the stretch it continues runs, and reported with
 * what ran of it when that ends (`closingReports`). One asked for with nothing running is reported at
 * 0 s: what was asked for it never started.
 */
export interface PendingAsk {
	id: string;
	/** When it was first asked, by the session's clock: the stretch goes on in it from there. */
	at: number;
}

/**
 * What a session reports when its stretch ends at `until`. With a trade that may or may not have
 * reached the book (`asked`), both halves are reported: the book knows exactly one of the two holds,
 * and the report for the other counts nothing there. Either way every second from `open.since` to
 * `until` is counted once.
 */
export function closingReports(
	open: OpenStretch,
	asked: PendingAsk | null,
	until: number,
	observedUntil?: number,
): HoldReport[] {
	const measured = observedUntil === undefined ? {} : { observedUntil };
	const reports = [{ hold: open.hold, seconds: stretchSeconds(open, until), ...measured }];
	if (asked) reports.push({ hold: asked.id, seconds: Math.max(0, until - asked.at) / 1000, ...measured });
	return reports;
}

/** How long before the book would count an unrenewed hold in full a session stops what runs on it. */
export const STOP_MARGIN_MS = 30_000;

/**
 * When a session whose hold could not be traded for the next one stops its sandbox: a margin before the
 * book stops counting the hold (`UsageHold.expiresAt`). Not at the first renewal that failed: until
 * then the book still counts what runs past the hold, so a short outage of the user's actor costs
 * nothing. `since` is when the hold was asked for, by the session's clock, which is never after the
 * book took it. A lease of `seconds` with no grace after it is stopped the same way (`graceSeconds` 0).
 */
export function holdDeadline(since: number, seconds: number, graceSeconds = HOLD_GRACE_SECONDS): number {
	return since + (seconds + graceSeconds) * 1000 - STOP_MARGIN_MS;
}

/** The seconds of a stretch's hold that ran until `until`. */
export function stretchSeconds(stretch: OpenStretch, until: number): number {
	return Math.max(0, until - stretch.since) / 1000;
}

/**
 * The latest moment a sandbox can have been running that its session finds stopped without having
 * stopped it. A provider that stops an unused sandbox by itself (`idleStopMs`) did so that long after
 * the sandbox was last used; where there is no such timeout, nothing is known but now.
 */
export function stoppedBy(
	stretch: OpenStretch,
	lastUsedAt: number,
	idleStopMs: number | null,
	now: number,
	pausedAt?: number,
): number {
	if (pausedAt !== undefined && Number.isFinite(pausedAt)) return Math.min(now, pausedAt);
	if (idleStopMs === null) return now;
	return Math.min(now, Math.max(stretch.seen ?? 0, Math.max(stretch.since, lastUsedAt) + idleStopMs));
}

/** Close a carried hold at the provider's last pause, even if it ran beyond the hold. Without that
 * measurement, bound the estimate by the provider timeout and the hold we had before the restart. */
export function foundStoppedAt(
	stretch: OpenStretch,
	lastUsedAt: number,
	idleStopMs: number | null,
	now: number,
	pausedAt?: number,
): number {
	const until = stoppedBy(stretch, lastUsedAt, idleStopMs, now, pausedAt);
	return Number.isFinite(pausedAt) ? until : Math.min(until, stretch.since + stretch.seconds * 1000);
}

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

/** A length of sandbox time for a sentence: "2 h", "1 h 50 min", "12 min", "4 min 5 s", "45 s". */
export function spellSeconds(total: number): string {
	const seconds = Math.max(0, Math.round(total));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const rest = seconds % 60;
	if (hours > 0) return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
	// Under ten minutes the seconds matter.
	if (minutes >= 10 || (minutes > 0 && rest === 0)) return `${minutes} min`;
	if (minutes > 0) return `${minutes} min ${rest} s`;
	return `${seconds} s`;
}

/** "It resets at 00:00 UTC, in 5 h 12 min." The day is UTC's, so the hour is said in UTC and as a time from now. */
function resetWords(numbers: Pick<UsageNumbers, "resetsAt" | "at">): string {
	return `The allowance is whole again at 00:00 UTC, in ${spellSeconds(Math.max(60, Math.ceil((numbers.resetsAt - numbers.at) / 60_000) * 60))}.`;
}

/** Whole hosted minutes, for a sentence: "87", "1,800". Used minutes are rounded down, so that "N of M" never says more than was used. */
export function spellMinutes(weightedSeconds: number): string {
	return Math.floor(Math.max(0, weightedSeconds) / 60).toLocaleString("en-US");
}

/** Whether what stops a start is the month's hosted minutes rather than the day's allowance. */
export function monthIsShort(numbers: UsageNumbers): boolean {
	const month = numbers.hosted;
	if (!month) return false;
	return (
		numbers.leftSeconds === null || month.leftSeconds < numbers.leftSeconds || month.leftSeconds < numbers.startSeconds
	);
}

/** "1 December": the day the month's minutes start again, in UTC. */
function monthResetWords(month: HostedMonth): string {
	const date = new Date(month.resetsAt);
	return `${date.getUTCDate()} ${date.toLocaleString("en-US", { month: "long", timeZone: "UTC" })}`;
}

/**
 * What a user reads when the month's hosted minutes stop something: what was used of how many, and the way on. A plan
 * with overage that reached its spend cap says so; one without says Pro. Their own machines are never counted.
 */
export function monthRefusal(month: HostedMonth): string {
	const capped = month.limitSeconds > month.includedSeconds;
	const used = `You have used ${spellMinutes(month.usedSeconds + month.heldSeconds)} of your ${spellMinutes(month.limitSeconds)} hosted minutes ${month.plan === "pro" ? `for the period ending ${monthResetWords(month)}` : "this month"}${capped ? ", up to your overage spend cap" : ""}`;
	const way =
		month.plan === "free"
			? "Run the agent on one of your own machines, which are never counted, or move to Pro for 1,800 hosted minutes a month."
			: month.plan === "pro"
				? `${month.period === "year" ? "Switch to monthly Pro for overage, or run" : capped ? "Raise the spend cap in Settings, or run" : "Run"} the agent on one of your own machines, which are never counted.`
				: "Run the agent on one of your own machines, which are never counted.";
	return `${used}, so nothing more can run hosted. ${way} The minutes start again on ${monthResetWords(month)} at ${new Date(month.resetsAt).toISOString().slice(11, 16)} UTC.`;
}

/** What a user reads when something that needs sandbox time is refused for the day's allowance: what was used, what the allowance is, and when it is whole again. */
export function allowanceRefusal(numbers: UsageNumbers): string {
	if (monthIsShort(numbers)) return monthRefusal(numbers.hosted!);
	const allowance = spellSeconds(numbers.allowanceSeconds ?? 0);
	const used = spellSeconds(numbers.usedSeconds);
	const held = numbers.heldSeconds > 0 ? spellSeconds(numbers.heldSeconds) : null;
	const left = numbers.leftSeconds ?? 0;
	let said: string;
	if (left > 0) {
		said = `Only ${spellSeconds(left)} of today's ${allowance} of sandbox time is left (${used} used${held === null ? "" : `, ${held} held for sandboxes that are running now`}), which is too little to start with, so nothing was started.`;
	} else if (held === null) {
		said = `Today's ${allowance} of sandbox time is used up, so nothing was started.`;
	} else {
		said = `Today's ${allowance} of sandbox time is all used or held: ${used} used, and ${held} held for sandboxes that are running now. Nothing was started.`;
	}
	// A hold is given back in part when its sandbox stops: worth a try before midnight.
	if (held !== null) said += " What a running sandbox does not use of its hold is free again when it stops.";
	return `${said} ${resetWords(numbers)}`;
}

/** Who holds a place among the kept sandboxes, in words: an agent by its title, a work item's builder or reviewer by its item's. */
export function keptHolder(
	sessions: ReadonlyMap<string, Pick<SessionSummary, "title" | "item">>,
	session: string,
): string {
	const held = sessions.get(session);
	if (!held) return "a sandbox left behind by an agent that no longer exists";
	if (held.item?.role === "reviewer") return `the reviewer of the item “${held.title}”`;
	return held.item ? `the item “${held.title}”` : `“${held.title}”`;
}

/** What a user reads when an agent needs a sandbox and they keep as many as they may. */
export function sandboxRefusal(numbers: UsageNumbers): string {
	const limit = numbers.sandboxes.limit ?? numbers.sandboxes.kept;
	return `You keep ${limit} hosted ${limit === 1 ? "sandbox" : "sandboxes"}, the most an account may have, and this agent needs one of its own. Sandboxes on your own machines are not counted. Free one on the Usage page, which says what goes with it, or delete an agent you no longer need. Then send this again.`;
}

export const USAGE_UNAVAILABLE =
	"Your sandbox time could not be checked just now, so nothing was started. Try again in a moment.";

/** The timeline's line when a running turn is stopped because the day's allowance is used up. */
export function turnStoppedNote(numbers: UsageNumbers): string {
	if (monthIsShort(numbers))
		return `This turn was stopped at the end of the time it held. ${monthRefusal(numbers.hosted!)} The sandbox is suspended with its files as they are, and the conversation is kept.`;
	return `Today's ${spellSeconds(numbers.allowanceSeconds ?? 0)} of sandbox time is used up, so this turn was stopped at the end of the time it held. The sandbox is suspended with its files as they are, and the conversation is kept. ${resetWords(numbers)} A prompt after that goes on from here.`;
}

/** The timeline's lines when a turn is stopped, or a sandbox with no turn suspended, because its user's sandbox time could not be checked until the hold ran out (`holdDeadline`). */
export const UNCHECKED_TURN_NOTE =
	"Your sandbox time could not be checked for several minutes, so this turn was stopped before it ran on uncounted. The sandbox is suspended with its files as they are, and the conversation is kept: send the prompt again in a moment.";
export const UNCHECKED_IDLE_NOTE =
	"Suspended the sandbox: your sandbox time could not be checked for several minutes. Its files are kept, and the next prompt resumes it.";

/** The timeline's line when a sandbox that runs with no turn in it is suspended for the same reason. */
export function idleSuspendedNote(numbers: UsageNumbers): string {
	if (monthIsShort(numbers))
		return `Suspended the sandbox: the hosted minutes are used up. Its files are kept. ${monthRefusal(numbers.hosted!)}`;
	return `Suspended the sandbox: today's ${spellSeconds(numbers.allowanceSeconds ?? 0)} of sandbox time is used up. Its files are kept. ${resetWords(numbers)}`;
}

/** The timeline's line when the user freed the session's sandbox on the usage page. `memory` is null for an agent that has no memory yet. */
export function freedNote(memory: "kept" | "copied" | "lost" | null, reason?: string): string {
	const remembered =
		memory === "lost"
			? " The agent's own memory of the conversation went with it, so it starts the next turn without it."
			: memory === null
				? ""
				: " The agent keeps its memory of the conversation, and is told that the workspace is a new one.";
	const action = reason ?? "You freed this agent's sandbox on the Usage page.";
	return `${action} The files in its workspace are gone. The conversation stays, and the next prompt starts a new sandbox.${remembered}`;
}
