/**
 * The Usage summary: the items that ended in a period, grouped by size and by what their changes are, with the
 * median and p90 of their cost and time, and what was spent retrying and on items that did not finish.
 *
 * Pure and browser-safe. The server lists the ended items with what each used (`finishedItems`); the browser prices
 * them with the rates of the moment (`summarize`, through cost.ts `itemCost`), so refreshed prices reprice it too.
 * Each item's cost is its model work at API prices, whoever paid (`workUsd`), beside what it added to the person's bills
 * (`extraUsd`: key-paid turns and extra hosted time).
 */

import type { CostRates, FinishedItem, ItemSize, ItemSpend, ItemSummary, SpendUsage, WorkType } from "../contract.js";
import { isCodePath } from "../verified.js";
import { type ItemCost, itemCost, mergeUsage, onPlan } from "./cost.js";
import { SMALL_PLAN_LIMIT } from "./feature-plan.js";
import { taskKind } from "./readiness-track.js";

export const ITEM_SIZES: readonly ItemSize[] = ["small", "medium", "large"];
export const WORK_TYPES: readonly WorkType[] = ["docs", "tests", "deps", "feature", "other"];

const TYPE_OF_KIND = { "docs-only": "docs", "tests-only": "tests", "dependency bumps": "deps" } as const;

/**
 * What a change is, from the paths it changed: docs, tests and dependency bumps as readiness counts them
 * (readiness-track.ts `taskKind`, every path of one kind); otherwise "feature" where any source file that is not a
 * test changed, and "other" for the rest (config, CI, assets, docs with tests).
 */
export function workType(paths: readonly string[]): WorkType {
	const kind = taskKind([...paths]);
	if (kind !== "other") return TYPE_OF_KIND[kind];
	return paths.some(isCodePath) ? "feature" : "other";
}

/** A feature's type from its parts': theirs where they agree, "feature" where any part changed code, else "other". */
export function featureWorkType(parts: ReadonlyArray<WorkType | undefined>): WorkType {
	const known = new Set(parts.filter(type => type !== undefined));
	if (known.size === 1) return [...known][0]!;
	return known.has("feature") ? "feature" : "other";
}

/** One item is small; a feature of up to a small plan's parts (SMALL_PLAN_LIMIT) is medium, of more large. */
export function itemSize(mode: ItemSummary["mode"], parts: number): ItemSize {
	if (mode !== "orchestrate") return "small";
	return parts <= SMALL_PLAN_LIMIT ? "medium" : "large";
}

/**
 * A feature's parts' retries: the whole of a part dispatched in a run the person started again (`retry`) or to fix
 * the feature's failed CI (`ciFix`), and the retries within the others.
 */
export function partsRetryUsage(
	jobs: ReadonlyArray<{ retry?: true; ciFix?: unknown; spent?: Pick<ItemSpend, "usage" | "retryUsage"> }>,
): SpendUsage {
	return mergeUsage(jobs.map(job => (job.retry || job.ciFix ? job.spent?.usage : job.spent?.retryUsage)));
}

const ENDED = new Set<ItemSummary["state"]>(["done", "failed", "cancelled"]);

/**
 * The user's items that ended at or after `since`, newest first, each with its size, type and what it used. A
 * feature's parts are summed into it (`partsUsage`) and its type comes from theirs; the parts are not listed apart.
 */
export function finishedItems(summaries: Iterable<ItemSummary>, since: number): FinishedItem[] {
	const all = [...summaries];
	const partsOf = new Map<string, ItemSummary[]>();
	for (const item of all) {
		if (!item.parent) continue;
		const parts = partsOf.get(item.parent.itemId);
		if (parts) parts.push(item);
		else partsOf.set(item.parent.itemId, [item]);
	}
	const items: FinishedItem[] = [];
	for (const item of all) {
		const endedAt = item.endedAt ?? item.updatedAt;
		if (item.parent || !ENDED.has(item.state) || endedAt < since) continue;
		const children = partsOf.get(item.id) ?? [];
		// A revised plan files a part again under its key: a part is a key.
		const parts = item.mode === "orchestrate" ? new Set(children.map(child => child.parent!.key)).size : 0;
		items.push({
			id: item.id,
			title: item.title,
			state: item.state as FinishedItem["state"],
			size: itemSize(item.mode, parts),
			parts,
			type:
				item.mode === "orchestrate"
					? featureWorkType(children.map(child => child.workType))
					: (item.workType ?? "other"),
			endedAt,
			seconds: Math.max(0, Math.round((endedAt - (item.startedAt ?? item.createdAt)) / 1000)),
			usage: mergeUsage([item.spent.usage, item.partsUsage]),
			retryUsage: mergeUsage([item.spent.retryUsage, item.partsRetryUsage]),
		});
	}
	return items.sort((a, b) => b.endedAt - a.endedAt);
}

/** The p-th percentile (0 to 1) by linear interpolation between the closest ranks; null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = (sorted.length - 1) * p;
	const below = Math.floor(rank);
	const above = Math.ceil(rank);
	return sorted[below]! + (sorted[above]! - sorted[below]!) * (rank - below);
}

export interface Spread {
	median: number;
	p90: number;
}

function spread(values: readonly number[]): Spread | null {
	const median = percentile(values, 0.5);
	const p90 = percentile(values, 0.9);
	return median === null || p90 === null ? null : { median, p90 };
}

/** The done items of one size or type. */
export interface SummaryGroup<K extends string> {
	key: K;
	count: number;
	/** Median and p90 of the model work at API prices, whoever paid, of the items priced whole (`priced`). */
	work: Spread | null;
	priced: number;
	/** What the group added to the person's bills: model turns on API keys, and extra hosted time. */
	extraUsd: number;
	/** Items some of whose cost could not be priced. */
	unknown: number;
	seconds: Spread | null;
}

/** What some items used: their model work at API prices, and what they added to the person's bills. */
export interface SpentOn {
	items: number;
	workUsd: number;
	extraUsd: number;
	unknown: boolean;
}

export interface UsageSummary {
	/** Items that ended in the period. */
	ended: number;
	done: number;
	bySize: SummaryGroup<ItemSize>[];
	byType: SummaryGroup<WorkType>[];
	/** Turns and parts after a failed attempt (`retryUsage`), over every ended item. */
	retries: SpentOn;
	/** Items cancelled, given up or failed: everything they used. */
	abandoned: SpentOn & { cancelled: number; failed: number };
	/** Items that ran turns on a subscription plan, those turns, and what they are worth at API prices. */
	plan: { items: number; turns: number; usd: number };
}

const planOf = (cost: ItemCost) => cost.payers.filter(onPlan);
const used = (usage: SpendUsage): boolean => usage.models.some(line => line.turns > 0) || usage.sandbox.length > 0;

interface Priced {
	item: FinishedItem;
	cost: ItemCost;
}

function group<K extends string>(key: K, members: readonly Priced[]): SummaryGroup<K> {
	const whole = members.filter(({ cost }) => !cost.unknown);
	return {
		key,
		count: members.length,
		work: spread(whole.map(({ cost }) => cost.workUsd)),
		priced: whole.length,
		extraUsd: members.reduce((sum, { cost }) => sum + cost.extraUsd, 0),
		unknown: members.length - whole.length,
		seconds: spread(members.map(({ item }) => item.seconds)),
	};
}

function spentOn(costs: readonly ItemCost[]): SpentOn {
	return {
		items: costs.length,
		workUsd: costs.reduce((sum, cost) => sum + cost.workUsd, 0),
		extraUsd: costs.reduce((sum, cost) => sum + cost.extraUsd, 0),
		unknown: costs.some(cost => cost.unknown),
	};
}

/** The summary of some ended items at the given rates. Groups hold done items only, in size and type order. */
export function summarize(items: readonly FinishedItem[], rates: CostRates): UsageSummary {
	const priced = items.map(item => ({ item, cost: itemCost(item.usage, rates) }));
	const done = priced.filter(({ item }) => item.state === "done");
	const abandoned = priced.filter(({ item }) => item.state !== "done");
	const groups = <K extends string>(keys: readonly K[], of: (item: FinishedItem) => K) =>
		keys.flatMap(key => {
			const members = done.filter(({ item }) => of(item) === key);
			return members.length ? [group(key, members)] : [];
		});
	const plans = priced.map(({ cost }) => planOf(cost)).filter(plans => plans.length > 0);
	return {
		ended: items.length,
		done: done.length,
		bySize: groups(ITEM_SIZES, item => item.size),
		byType: groups(WORK_TYPES, item => item.type),
		retries: spentOn(items.filter(item => used(item.retryUsage)).map(item => itemCost(item.retryUsage, rates))),
		abandoned: {
			...spentOn(abandoned.map(({ cost }) => cost)),
			cancelled: abandoned.filter(({ item }) => item.state === "cancelled").length,
			failed: abandoned.filter(({ item }) => item.state === "failed").length,
		},
		plan: {
			items: plans.length,
			turns: plans.flat().reduce((sum, plan) => sum + plan.turns, 0),
			usd: plans.flat().reduce((sum, plan) => sum + plan.usd, 0),
		},
	};
}
