import type { AcpUpdate, ProviderAccount, UsageWindow, Wait } from "./contract.js";
import { harnessName, knownHarness } from "./sandbox/harnesses.js";

export type LimitEvent = NonNullable<Extract<AcpUpdate, { sessionUpdate: "usage_update" }>["rateLimit"]>;
export type UsageObservation =
	| { kind: "event"; event: LimitEvent }
	| { kind: "refusal"; at: number; resetsAt: number | null; window?: UsageWindow }
	| { kind: "success"; at: number; startedAt: number };

export const MINUTE = 60_000;
export const MAX_PROVIDER_WAIT = 360 * MINUTE;

export const resetTime = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < 8.64e15 - MINUTE
		? value
		: undefined;

export function claudeLimit(raw: unknown, at: number): LimitEvent | undefined {
	if (!raw || typeof raw !== "object") return;
	const { status, rateLimitType, utilization, resetsAt } = raw as Record<string, unknown>;
	if (status !== "allowed" && status !== "allowed_warning" && status !== "rejected") return;
	const kind =
		rateLimitType === "five_hour"
			? "5h"
			: rateLimitType === "seven_day"
				? "7d"
				: rateLimitType === "seven_day_opus" || rateLimitType === "seven_day_sonnet"
					? "model"
					: rateLimitType === "rpm"
						? "rpm"
						: "other";
	const usedPct =
		typeof utilization === "number" && Number.isFinite(utilization) && utilization >= 0
			? Math.min(utilization, 1) * 100
			: null;
	return {
		status,
		window: { kind, usedPct, resetsAt: claudeReset(resetsAt) ?? null, observedAt: at, source: "event" },
	};
}

// The Claude SDK reports Unix seconds. The platform stores Unix milliseconds.
function claudeReset(seconds: unknown) {
	return typeof seconds === "number" ? resetTime(seconds * 1000) : undefined;
}

export function limitError(raw: unknown) {
	if (!raw || typeof raw !== "object") return;
	const { errorKind, rateLimit, codexErrorInfo } = raw as Record<string, unknown>;
	if (errorKind === "rate_limit") {
		const resetsAt = claudeReset((rateLimit as Record<string, unknown> | null)?.resetsAt);
		const event = claudeLimit(rateLimit, Date.now());
		return {
			reason: "usage_limit",
			...(resetsAt !== undefined && { resetsAt }),
			...(event && { window: { ...event.window, source: "refusal" as const } }),
		};
	}
	if (codexErrorInfo === "usageLimitExceeded") return { reason: "quota_exhausted" };
	if (codexErrorInfo === "rateLimitExceeded") return { reason: "usage_limit" };
}

export function usageRefusal(kind: string) {
	return ["usage_limit", "quota_exhausted", "insufficient_quota", "rate_limit"].includes(kind);
}

export interface StoredUsage {
	account: ProviderAccount;
	backoff: number;
	lastRefusal: number;
	lastSuccess: number;
	refusedUntil?: number;
	warnings?: Partial<Record<UsageWindow["kind"], number | null>>;
}

export function accountState(stored: Pick<StoredUsage, "account" | "warnings">, at: number): ProviderAccount["state"] {
	if ((stored.account.limitedUntil ?? 0) > at) return "limited";
	return Object.values(stored.warnings ?? {}).some(reset => reset === null || reset > at) ? "warning" : "ok";
}

/** A successful probe resets the streak. Concurrent turns and advisory events cannot lift a live refusal. */
export function observeUsage(previous: StoredUsage, observation: UsageObservation): StoredUsage {
	const { account } = previous;
	const at = observation.kind === "event" ? observation.event.window.observedAt : observation.at;
	const active = (account.limitedUntil ?? 0) > at;
	if (observation.kind === "success") {
		if (
			previous.lastSuccess >= at ||
			(account.limitedUntil ?? 0) > observation.startedAt ||
			(!previous.backoff && account.state !== "limited")
		)
			return previous;
		return {
			...previous,
			backoff: 0,
			lastSuccess: at,
			refusedUntil: 0,
			account: { ...account, state: accountState(previous, at), limitedUntil: null },
		};
	}
	const refusal = observation.kind === "refusal";
	const reset = refusal && observation.resetsAt !== null && observation.resetsAt > at ? observation.resetsAt : null;
	const window: UsageWindow = refusal
		? {
				kind: observation.window?.kind ?? "other",
				usedPct: observation.window?.usedPct ?? null,
				resetsAt: reset,
				observedAt: at,
				source: "refusal",
			}
		: observation.event.window;
	if (refusal && at <= Math.max(previous.lastRefusal, previous.lastSuccess)) return previous;
	const older = account.windows.find(w => w.kind === window.kind && w.source === window.source);
	if ((older && older.observedAt > at) || (!refusal && at < previous.lastSuccess)) return previous;
	const windows = [...account.windows.filter(w => w !== older), window];
	const rejected = refusal || observation.event.status === "rejected";
	const backoff = refusal ? (window.resetsAt === null ? Math.min(previous.backoff + 1, 6) : 0) : previous.backoff;
	let until = active ? account.limitedUntil : null;
	if (rejected) {
		const fallback = at + Math.min(300, 15 * 2 ** Math.max(0, backoff - 1)) * MINUTE;
		const end = window.resetsAt === null ? fallback : window.resetsAt + (refusal ? MINUTE : 0);
		// A refusal supersedes estimates, including a rejected event without a reset.
		if (refusal) until = end;
		else if ((previous.refusedUntil ?? 0) <= at) until = Math.max(until ?? 0, end);
	}
	const warnings = { ...previous.warnings };
	if (!rejected && (observation.event.status === "allowed_warning" || (window.usedPct ?? 0) >= 90))
		warnings[window.kind] = window.resetsAt;
	else delete warnings[window.kind];
	const updated = {
		account: { ...account, windows, limitedUntil: until },
		warnings,
		backoff,
		refusedUntil: refusal ? (until ?? 0) : previous.refusedUntil,
		lastRefusal: refusal ? at : previous.lastRefusal,
		lastSuccess: previous.lastSuccess,
	};
	updated.account.state = accountState(updated, at);
	return updated;
}

export const utcReset = (at: number) => new Date(at).toISOString().slice(11, 16) + " UTC";

export function providerWait(harness: string, place: string, until: number, reset?: number | null): Wait {
	const name = harnessName(knownHarness(harness) ?? "windlass");
	const where = place === "hosted" ? "on hosted" : "on ‘" + place + "’";
	const sentence =
		reset != null
			? `Your ${name} limit ${where} resets at ${utcReset(reset)}. This item continues at ${utcReset(until)}.`
			: `Waiting for the ${name} usage limit ${where}. This item can try again at ${utcReset(until)}.`;
	return { reason: "provider", sentence, retryAt: until };
}
