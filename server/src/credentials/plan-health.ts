/**
 * A connected plan's health as the relays see it (docs/model-relay.md, "Plan health"): usable, at its limit until a
 * reset, or refused twice in a row (`invalid`, until it is connected again). Pure: the user actor keeps the state on
 * the plan's `model_plan` row (plans.ts `observePlan`), and Pay with reads it at a turn's start (pay-with.ts).
 *
 * Read from what each provider says of a plan's answers:
 *   anthropic  `anthropic-ratelimit-unified-*`: the 5-hour and weekly windows (utilization 0–1, reset in unix
 *              seconds, status allowed | allowed_warning | rejected) and the overall status and reset.
 *   openai     `x-codex-primary-*` / `x-codex-secondary-*` (used percent, window minutes, reset in unix seconds), and a
 *              429's code: `subscription_sharing_usage_limit_exceeded` names no reset, so none is inferred from it; the
 *              plan is probed again after a backoff instead.
 *   both       a 401 from the provider (never the relay's own, for an ended lease) counts toward `invalid`.
 */

import type { PlanHealth, PlanProvider, RelaySeen, UsageWindow } from "../contract.js";
import { MINUTE, resetTime, type UsageObservation } from "../provider-usage.js";

export interface PlanHealthState {
	health: PlanHealth;
	limitedUntil: number | null;
	resetKnown: boolean;
	windows: UsageWindow[];
	/** Provider 401s in a row: two make the plan `invalid`. */
	authFailures: number;
	/** Limits without a reset in a row: each probe waits twice as long, up to five hours. */
	backoff: number;
	healthAt: number | null;
}

export const HEALTHY: PlanHealthState = {
	health: "ok",
	limitedUntil: null,
	resetKnown: false,
	windows: [],
	authFailures: 0,
	backoff: 0,
	healthAt: null,
};

/** What one answer (or one turn's report) says of the plan. `other`: nothing about its health, only its windows. */
export interface PlanReading {
	at: number;
	status: "ok" | "limited" | "unauthorized" | "other";
	windows: UsageWindow[];
	resetsAt: number | null;
}

/** A 429 that asks for a retry sooner than this is a burst the agent retries itself, not the plan's limit. */
const SHORT_RETRY_MS = MINUTE;
/** The 429 codes that are a ChatGPT plan's usage limit. */
const CHATGPT_LIMIT_CODES = new Set(["subscription_sharing_usage_limit_exceeded", "usage_limit_reached"]);

const seconds = (value: string | undefined): number | null => {
	if (value === undefined || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
	return resetTime(Math.round(Number(value) * 1000)) ?? null;
};

const number = (value: string | undefined): number | null => {
	if (value === undefined || !/^-?\d+(?:\.\d+)?$/.test(value.trim())) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
};

const clampPct = (pct: number) => Math.min(100, Math.max(0, pct));

function retryAfterMs(headers: Record<string, string>): number | null {
	const ms = number(headers["retry-after-ms"]);
	if (ms !== null) return ms;
	const s = number(headers["retry-after"]);
	return s === null ? null : s * 1000;
}

function anthropicReading(seen: RelaySeen, at: number): PlanReading {
	const h = seen.headers;
	const prefix = "anthropic-ratelimit-unified-";
	const windows: UsageWindow[] = [];
	const rejected: number[] = [];
	for (const [name, kind] of [
		["5h", "5h"],
		["7d", "7d"],
	] as const) {
		const utilization = number(h[`${prefix}${name}-utilization`]);
		const resetsAt = seconds(h[`${prefix}${name}-reset`]);
		const status = h[`${prefix}${name}-status`];
		if (utilization === null && resetsAt === null && status === undefined) continue;
		windows.push({
			kind,
			usedPct: utilization === null ? null : clampPct(utilization * 100),
			resetsAt,
			observedAt: at,
			source: "header",
		});
		if (status === "rejected" && resetsAt !== null) rejected.push(resetsAt);
	}
	const overall = h[`${prefix}status`];
	const overallReset = seconds(h[`${prefix}reset`]);
	if (seen.status === 401) return { at, status: "unauthorized", windows, resetsAt: null };
	const isRejected = overall === "rejected" || rejected.length > 0;
	const resetsAt = (rejected.length ? Math.max(...rejected) : null) ?? overallReset ?? seen.resetsAt ?? null;
	if (seen.status === 429) {
		const retry = retryAfterMs(h);
		if (!isRejected && retry !== null && retry < SHORT_RETRY_MS)
			return { at, status: "other", windows, resetsAt: null };
		return { at, status: "limited", windows, resetsAt };
	}
	if (seen.status >= 200 && seen.status < 300)
		return isRejected ? { at, status: "limited", windows, resetsAt } : { at, status: "ok", windows, resetsAt: null };
	return { at, status: "other", windows, resetsAt: null };
}

function codexWindow(h: Record<string, string>, which: "primary" | "secondary", at: number): UsageWindow | null {
	const used = number(h[`x-codex-${which}-used-percent`]);
	const minutes = number(h[`x-codex-${which}-window-minutes`]);
	const resetsAt = seconds(h[`x-codex-${which}-reset-at`]);
	if (used === null && resetsAt === null) return null;
	const kind =
		minutes === null
			? which === "primary"
				? "5h"
				: "7d"
			: minutes === 300
				? "5h"
				: minutes === 10080
					? "7d"
					: "other";
	return { kind, usedPct: used === null ? null : clampPct(used), resetsAt, observedAt: at, source: "header" };
}

function chatgptReading(seen: RelaySeen, at: number): PlanReading {
	const h = seen.headers;
	const windows = [codexWindow(h, "primary", at), codexWindow(h, "secondary", at)].filter(
		(w): w is UsageWindow => w !== null,
	);
	if (seen.status === 401) return { at, status: "unauthorized", windows, resetsAt: null };
	if (seen.status === 429) {
		const code = seen.code ?? "";
		// Sharing a subscription's limit names no reset: back off and probe, never guess one.
		if (code === "subscription_sharing_usage_limit_exceeded") return { at, status: "limited", windows, resetsAt: null };
		const full = windows.filter(w => (w.usedPct ?? 0) >= 100 && w.resetsAt !== null).map(w => w.resetsAt!);
		if (CHATGPT_LIMIT_CODES.has(code) || full.length)
			return { at, status: "limited", windows, resetsAt: seen.resetsAt ?? (full.length ? Math.max(...full) : null) };
		const retry = retryAfterMs(h);
		if (retry !== null && retry < SHORT_RETRY_MS) return { at, status: "other", windows, resetsAt: null };
		return { at, status: "limited", windows, resetsAt: null };
	}
	if (seen.status >= 200 && seen.status < 300) return { at, status: "ok", windows, resetsAt: null };
	return { at, status: "other", windows, resetsAt: null };
}

/** What a relay's sight of one answer says of the plan. */
export function planReading(provider: PlanProvider, seen: RelaySeen, at: number): PlanReading {
	return provider === "anthropic" ? anthropicReading(seen, at) : chatgptReading(seen, at);
}

/** A turn's own report (an agent's rate-limit event, its refusal, its success) as a reading of its plan. */
export function observationReading(observation: UsageObservation): PlanReading {
	if (observation.kind === "success") return { at: observation.at, status: "ok", windows: [], resetsAt: null };
	if (observation.kind === "refusal")
		return {
			at: observation.at,
			status: "limited",
			windows: observation.window ? [observation.window] : [],
			resetsAt: observation.resetsAt,
		};
	const { status, window } = observation.event;
	return {
		at: window.observedAt,
		// An allowed event is advisory: it lifts no limit, as a concurrent turn's could be older than the refusal.
		status: status === "rejected" ? "limited" : "other",
		windows: [window],
		resetsAt: status === "rejected" ? window.resetsAt : null,
	};
}

function mergeWindows(previous: readonly UsageWindow[], fresh: readonly UsageWindow[]): UsageWindow[] {
	const byKind = new Map(previous.map(w => [w.kind, w]));
	for (const window of fresh) {
		const older = byKind.get(window.kind);
		if (!older || older.observedAt <= window.observedAt) byKind.set(window.kind, window);
	}
	return [...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

/** The next state after a reading. A reading older than the last one changes only the windows it is newer for. */
export function nextHealth(previous: PlanHealthState, reading: PlanReading): PlanHealthState {
	const { at } = reading;
	const windows = mergeWindows(previous.windows, reading.windows);
	const stale = previous.healthAt !== null && at < previous.healthAt;
	if (stale || reading.status === "other") return { ...previous, windows };
	const healthAt = at;
	if (reading.status === "unauthorized") {
		const authFailures = previous.authFailures + 1;
		return {
			...previous,
			windows,
			healthAt,
			authFailures,
			health: authFailures >= 2 ? "invalid" : previous.health,
		};
	}
	if (reading.status === "ok") {
		// The provider took a request: the token works and the plan is not at its limit now.
		return {
			...previous,
			windows,
			healthAt,
			authFailures: 0,
			backoff: 0,
			health: "ok",
			limitedUntil: null,
			resetKnown: false,
		};
	}
	const reset = reading.resetsAt !== null && reading.resetsAt > at ? reading.resetsAt : null;
	if (reset !== null)
		return {
			...previous,
			windows,
			healthAt,
			authFailures: 0,
			backoff: 0,
			health: "limited",
			limitedUntil: reset,
			resetKnown: true,
		};
	// No reset named: a limit seen while an earlier one is still being waited out is the same one, not a failed probe.
	const waiting = previous.health === "limited" && (previous.limitedUntil ?? 0) > at;
	if (waiting) return { ...previous, windows, healthAt, authFailures: 0 };
	const backoff = Math.min(previous.backoff + 1, 6);
	return {
		...previous,
		windows,
		healthAt,
		authFailures: 0,
		backoff,
		health: "limited",
		limitedUntil: at + Math.min(300, 15 * 2 ** (backoff - 1)) * MINUTE,
		resetKnown: false,
	};
}

/** The health as of `now`: a limit whose time has passed is tried again, so it reads as usable. */
export function healthAt(state: Pick<PlanHealthState, "health" | "limitedUntil">, now: number): PlanHealth {
	if (state.health === "limited" && (state.limitedUntil ?? 0) <= now) return "ok";
	return state.health;
}

/**
 * A relay's report as the platform takes it from a relay inside a sandbox (plan.cjs `{seen}`): its shape only, with
 * at most 24 short headers. Null for anything else.
 */
export function relaySeenOf(raw: unknown): RelaySeen | null {
	if (!raw || typeof raw !== "object") return null;
	const { status, headers, code, resetsAt } = raw as Record<string, unknown>;
	if (!Number.isSafeInteger(status) || (status as number) < 100 || (status as number) > 599) return null;
	if (!headers || typeof headers !== "object") return null;
	const kept: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers).slice(0, 24)) {
		if (typeof value === "string" && name.length <= 64 && value.length <= 64) kept[name.toLowerCase()] = value;
	}
	return {
		status: status as number,
		headers: kept,
		code: typeof code === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(code) ? code : null,
		resetsAt: resetTime(resetsAt) ?? null,
	};
}
