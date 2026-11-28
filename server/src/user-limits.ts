import { UserError } from "rivetkit";
import type { RawAccess } from "rivetkit/db";
import { requireServiceFor } from "./auth.js";
import { config } from "./config.js";
import { planLimits, type BillingState } from "./billing/plans.js";
import { MAX_MACHINES, type FactoryLimits } from "./contract.js";
import { ATTACHMENT_LIMITS } from "./factory/attachments.js";

const ranges = {
	hostedRunning: [1, 100],
	dailyTokens: [1, Number.MAX_SAFE_INTEGER],
	githubItemsPerDay: [1, 1_000_000],
	"item.tokens": [1, 1_000_000_000],
	"item.hostedSeconds": [1, 7 * 86400],
	"item.usd": [1, 100_000],
	"item.planPct": [1, 1000],
	"item.planWeekPct": [1, 1000],
	"attachments.bytes": [1, ATTACHMENT_LIMITS.bytes],
	"attachments.perItem": [1, 1_000_000],
	"attachments.accountBytes": [1, Number.MAX_SAFE_INTEGER],
	"attachments.days": [1, 36500],
	dailySeconds: [60, 86400],
	maxKept: [1, 1000],
	// The month's hosted minutes and the paired machines: a plan sets them where the deployment has billing.
	hostedMinutes: [1, 10_000_000],
	machines: [1, 100],
} as const;
type Key = keyof typeof ranges;
type Overrides = Partial<Record<Key, number | null>>;
type Db = Pick<RawAccess, "execute">;
export const LIMITS_AUDIT_TABLE = `CREATE TABLE IF NOT EXISTS limit_changes (
	id INTEGER PRIMARY KEY, at INTEGER NOT NULL, operator TEXT NOT NULL, setting TEXT NOT NULL,
	old_value INTEGER, new_value INTEGER, overrides TEXT NOT NULL)`;

/**
 * The account's limits: the operator's override of a setting where there is one, then the plan's where the deployment
 * has billing (`billing` is the account's subscription; null without billing), then the deployment's default.
 */
export function effectiveUserLimits(overrides: Overrides, billing: BillingState | null = null, now = Date.now()) {
	const plan = billing === null ? null : planLimits(billing, now);
	const defaults = config.factory;
	const value = (key: Key, fallback: number) => overrides[key] ?? fallback;
	const item = { ...defaults.item },
		attachments = { ...defaults.attachments };
	for (const key of Object.keys(item) as (keyof typeof item)[]) {
		const fallback = item[key];
		if (fallback !== undefined) item[key] = value(`item.${key}`, fallback);
	}
	for (const key of Object.keys(attachments) as (keyof typeof attachments)[])
		attachments[key] = value(`attachments.${key}`, attachments[key]);
	// Overrides of limits that are gone (the turn caps, the review cap, the feature multiplier, GitHub drafts, the item's
	// turns and working time) may still be stored: they are read past. Only the figures below are kept.
	const factory: FactoryLimits = {
		hostedRunning: value("hostedRunning", plan?.hostedRunning ?? defaults.hostedRunning),
		dailyTokens: overrides.dailyTokens === undefined ? defaults.dailyTokens : overrides.dailyTokens,
		githubItemsPerDay: value("githubItemsPerDay", plan?.githubItemsPerDay ?? defaults.githubItemsPerDay),
		item,
		attachments,
	};
	const subscription =
		plan?.plan.id === "pro" && billing
			? { period: billing.period, periodStart: billing.periodStart, periodEnd: billing.periodEnd }
			: null;
	const usage = {
		...config.usage,
		subscription,
		monthlySeconds: null as number | null,
		includedSeconds: null as number | null,
		plan: plan?.plan.id ?? null,
	};
	// With a plan, the month's hosted minutes take the place of the day's allowance, unless the operator set one for the user.
	if (plan) {
		usage.dailySeconds = null;
		usage.maxKept = plan.maxKept;
		usage.monthlySeconds = plan.monthlySeconds;
		usage.includedSeconds = plan.includedSeconds;
	}
	for (const key of ["dailySeconds", "maxKept"] as const) if (overrides[key] !== undefined) usage[key] = overrides[key];
	if (overrides.hostedMinutes !== undefined) {
		const minutes = overrides.hostedMinutes;
		usage.includedSeconds = minutes === null ? null : minutes * 60;
		// The operator's minutes are the included ones: a plan's spend cap still pays for overage past them.
		usage.monthlySeconds =
			minutes === null ? null : minutes * 60 + (plan ? plan.monthlySeconds - plan.includedSeconds : 0);
	}
	const machines = value("machines", plan?.machines ?? MAX_MACHINES);
	return { factory, usage, machines, plan: plan?.plan ?? null };
}

export async function readUserLimits(db: Db) {
	const [row] = await db.execute<{ id: number; overrides: string }>(
		"SELECT id, overrides FROM limit_changes ORDER BY id DESC LIMIT 1",
	);
	const overrides: Overrides = row ? JSON.parse(row.overrides) : {};
	return { id: row?.id ?? 0, overrides };
}
/** The operator's overrides, and the account's subscription where the deployment has billing (billing/account.ts). */
export type UserLimits = Awaited<ReturnType<typeof readUserLimits>> & { billing?: BillingState | null };

/** The account's limits now: the operator's overrides, the plan, the deployment's defaults. */
export function accountLimits(limits: UserLimits, now = Date.now()) {
	return effectiveUserLimits(limits.overrides, limits.billing ?? null, now);
}
export type LimitAuditRow = {
	id: number;
	at: number;
	operator: string;
	setting: Key;
	old_value: number | null;
	new_value: number | null;
	overrides: string;
};
export type LimitChange = { operator: string; key: string; value: number | "default" | "unlimited" };

function setting(limits: ReturnType<typeof effectiveUserLimits>, key: Key) {
	if (key === "dailySeconds" || key === "maxKept") return limits.usage[key];
	if (key === "hostedMinutes") return limits.usage.includedSeconds === null ? null : limits.usage.includedSeconds / 60;
	if (key === "machines") return limits.machines;
	if (key.startsWith("item.")) return limits.factory.item[key.slice(5) as keyof FactoryLimits["item"]];
	if (key.startsWith("attachments."))
		return limits.factory.attachments[key.slice(12) as keyof FactoryLimits["attachments"]];
	return limits.factory[key as Exclude<keyof FactoryLimits, "item" | "attachments">];
}

export function limitsSubject(uid: string, operator: string) {
	if (typeof operator !== "string" || !/^[A-Za-z0-9_.@-]{1,128}$/.test(operator))
		throw new UserError("Invalid operator identity.", { code: "bad_input" });
	return `limits:${encodeURIComponent(uid)}:${operator}`;
}

/** The new snapshot and its audit record are the same row. Independent edits serialize in SQLite. */
export async function changeUserLimit(
	c: { key: string[]; conn?: { params: unknown } | null; db: Pick<RawAccess, "transaction"> },
	input: LimitChange,
) {
	requireServiceFor(c, limitsSubject(c.key[0]!, input?.operator));
	if (!Object.hasOwn(ranges, input.key)) throw new UserError("Unknown limit.", { code: "bad_input" });
	const key = input.key as Key;
	const [min, max] = ranges[key];
	const { value } = input;
	if (
		value !== "default" &&
		!(
			value === "unlimited" &&
			(key === "dailyTokens" || key === "dailySeconds" || key === "maxKept" || key === "hostedMinutes")
		) &&
		(typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
	)
		throw new UserError(`Use an integer from ${min} to ${max}, or default.`, { code: "bad_input" });
	return c.db.transaction(
		async tx => {
			const before = await readUserLimits(tx);
			const overrides = { ...before.overrides };
			if (value === "default") delete overrides[key];
			else overrides[key] = value === "unlimited" ? null : value;
			if (before.overrides[key] === overrides[key]) return before;
			const after = effectiveUserLimits(overrides);
			const [row] = await tx.execute<{ id: number }>(
				"INSERT INTO limit_changes(at, operator, setting, old_value, new_value, overrides) VALUES(?,?,?,?,?,?) RETURNING id",
				Date.now(),
				input.operator,
				key,
				setting(effectiveUserLimits(before.overrides), key),
				setting(after, key),
				JSON.stringify(overrides),
			);
			return { id: row!.id, overrides };
		},
		{ name: "limits.change" },
	);
}
