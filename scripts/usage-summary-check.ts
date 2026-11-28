// The Usage summary (server/src/factory/usage-summary.ts): an item's type and size, the percentiles, what counts as
// retry spend, and the ended items of a period.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CostRates, FinishedItem, ItemSummary, SpendUsage, TurnUsage } from "../server/src/contract.js";
import { advance, createItem } from "../server/src/factory/blueprint.js";
import { FACTORY_DEFAULTS } from "../server/src/factory/budget.js";
import { chargeTurn } from "../server/src/factory/change.js";
import { addTurn, noUsage, turnMeter, type TurnMeter } from "../server/src/factory/cost.js";
import type { FactoryItem } from "../server/src/factory/types.js";
import {
	featureWorkType,
	finishedItems,
	itemSize,
	partsRetryUsage,
	percentile,
	summarize,
	workType,
} from "../server/src/factory/usage-summary.js";

const RATES: CostRates = {
	models: { "anthropic/claude-sonnet-4-5": { input: 3, output: 15 } },
	source: null,
	sandbox: { standard: 0.36 },
};

const tokens = (input: number): TurnUsage => ({
	inputTokens: input,
	cachedInputTokens: 0,
	outputTokens: 0,
	reasoningTokens: 0,
});

/** A turn of a million input tokens on a Settings key ($3), or on the Claude plan (worth $3, added to no bill). */
const meter = (plan = false, model = "anthropic/claude-sonnet-4-5"): TurnMeter =>
	turnMeter({
		harness: "windlass",
		model,
		key: { provider: "anthropic", generation: "g", ...(plan && { plan: true }) },
		usage: tokens(1_000_000),
		size: "standard",
	});

function usage(...turns: TurnMeter[]): SpendUsage {
	const into = noUsage();
	for (const turn of turns) addTurn(into, turn);
	return into;
}

const close = (actual: number | null, expected: number) =>
	assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

test("a change's type: every path docs, tests or dependencies; else code makes it a feature", () => {
	assert.equal(workType(["README.md", "docs/setup.mdx"]), "docs");
	assert.equal(workType(["src/a.test.ts", "tests/b.py"]), "tests");
	assert.equal(workType(["package.json", "pnpm-lock.yaml"]), "deps");
	assert.equal(workType(["src/server.ts"]), "feature");
	assert.equal(workType([".github/workflows/ci.yml", "Dockerfile"]), "other");
	// Mixed: any source code is a feature; docs with tests and no code is other.
	assert.equal(workType(["README.md", "src/a.ts", "src/a.test.ts"]), "feature");
	assert.equal(workType(["package.json", "src/index.ts"]), "feature");
	assert.equal(workType(["README.md", "src/a.test.ts"]), "other");
	assert.equal(workType([]), "other");
});

test("a feature's type follows its parts': the same, any feature, else other", () => {
	assert.equal(featureWorkType(["docs", "docs", undefined]), "docs");
	assert.equal(featureWorkType(["tests", "feature"]), "feature");
	assert.equal(featureWorkType(["docs", "tests"]), "other");
	assert.equal(featureWorkType([]), "other");
});

test("one item is small, a feature of up to three parts medium, of more large", () => {
	assert.equal(itemSize("single", 0), "small");
	assert.equal(itemSize("orchestrate", 0), "medium");
	assert.equal(itemSize("orchestrate", 3), "medium");
	assert.equal(itemSize("orchestrate", 4), "large");
});

test("percentiles interpolate between ranks; one value is itself; none is null", () => {
	assert.equal(percentile([], 0.5), null);
	assert.equal(percentile([7], 0.5), 7);
	assert.equal(percentile([7], 0.9), 7);
	assert.equal(percentile([1, 3], 0.5), 2);
	close(percentile([1, 3], 0.9), 2.8);
	assert.equal(percentile([5, 1, 3], 0.5), 3);
	close(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9.1);
});

function item(): FactoryItem {
	return createItem({
		id: "i_00000000000000dd",
		task: { title: "Fix add()", body: "", acceptance: [], base: "main" },
		reviewer: { off: "deployment" },
		place: { kind: "hosted" },
		budget: { ...FACTORY_DEFAULTS.item },
	});
}

test("a run the person started again, and a CI fix, are retry spend; the first run is not", () => {
	const failed = item();
	chargeTurn(failed, { tokens: 0, hostedSeconds: 0, meter: meter() });
	assert.equal(failed.spent.retryUsage, undefined);
	failed.state = "failed";
	const { item: retried } = advance(failed, { kind: "retry", at: 5_000, by: "u_1" });
	assert.equal(retried.run?.retry, true);
	assert.equal(retried.startedAt, 5_000);
	chargeTurn(retried, { tokens: 0, hostedSeconds: 0, meter: meter() });
	assert.equal(retried.spent.usage?.models[0]?.turns, 2);
	assert.equal(retried.spent.retryUsage?.models[0]?.turns, 1);

	const fixing = item();
	fixing.run = { ...retried.run!, retry: undefined, step: { ...retried.run!.step, kind: "ci_fix" } };
	chargeTurn(fixing, { tokens: 0, hostedSeconds: 0, meter: meter() });
	assert.equal(fixing.spent.retryUsage?.models[0]?.turns, 1);
});

test("a feature's parts' retries: a retried or CI-fix part whole, the others' own retries", () => {
	const spent = (turns: number, retries: number) => ({
		usage: usage(...Array.from({ length: turns }, () => meter())),
		retryUsage: retries ? usage(...Array.from({ length: retries }, () => meter())) : undefined,
	});
	const merged = partsRetryUsage([
		{ spent: spent(3, 1) },
		{ retry: true, spent: spent(2, 0) },
		{ ciFix: { head: "h", fingerprint: "f" }, spent: spent(1, 0) },
		{ spent: spent(4, 0) },
	]);
	assert.equal(merged.models[0]?.turns, 4);
});

const DAY = 86_400_000;

function summary(more: Partial<ItemSummary>): ItemSummary {
	return {
		id: "i_x",
		title: "An item",
		mode: "single",
		parent: null,
		state: "done",
		createdAt: 0,
		updatedAt: 10 * DAY,
		endedAt: 10 * DAY,
		spent: { tokens: 0, hostedSeconds: 0, turns: 1, activeSeconds: 0, usage: usage(meter()) },
		...more,
	} as ItemSummary;
}

test("the ended items of a period: features with their parts summed in, parts and open items left out", () => {
	const part = (id: string, key: string, type: ItemSummary["workType"]) =>
		summary({ id, parent: { itemId: "i_feat", key, title: key }, workType: type, state: "done" });
	const items = finishedItems(
		[
			summary({ id: "i_old", endedAt: 1 * DAY, workType: "docs" }),
			summary({ id: "i_open", state: "working", endedAt: undefined }),
			summary({ id: "i_docs", workType: "docs", startedAt: 9 * DAY, endedAt: 9 * DAY + 600_000 }),
			summary({
				id: "i_feat",
				mode: "orchestrate",
				state: "cancelled",
				partsUsage: usage(meter(), meter()),
				partsRetryUsage: usage(meter()),
			}),
			part("i_p1", "api", "feature"),
			part("i_p2", "docs", "docs"),
			part("i_p2b", "docs", "docs"),
		],
		5 * DAY,
	);
	assert.deepEqual(
		items.map(({ id, size, parts, type, state }) => ({ id, size, parts, type, state })),
		[
			{ id: "i_feat", size: "medium", parts: 2, type: "feature", state: "cancelled" },
			{ id: "i_docs", size: "small", parts: 0, type: "docs", state: "done" },
		],
	);
	assert.equal(items[1]?.seconds, 600);
	assert.equal(items[0]?.usage.models[0]?.turns, 3);
	assert.equal(items[0]?.retryUsage.models[0]?.turns, 1);
});

function finished(more: Partial<FinishedItem>): FinishedItem {
	return {
		id: "i_x",
		title: "An item",
		state: "done",
		size: "small",
		parts: 0,
		type: "feature",
		endedAt: 0,
		seconds: 600,
		usage: usage(meter()),
		retryUsage: noUsage(),
		...more,
	};
}

test("the summary: done items grouped, plan turns at their value, retries and abandoned items apart", () => {
	const result = summarize(
		[
			finished({ usage: usage(meter()), seconds: 600 }),
			finished({ usage: usage(meter(), meter(), meter()), seconds: 1800, retryUsage: usage(meter()) }),
			finished({ usage: usage(meter(true)), seconds: 1200 }),
			finished({ type: "docs", usage: usage(meter(false, "anthropic/claude-unknown")) }),
			finished({ state: "cancelled", usage: usage(meter(), meter()) }),
			finished({ state: "failed", usage: usage(meter(true)), retryUsage: usage(meter(true)) }),
		],
		RATES,
	);
	assert.equal(result.ended, 6);
	assert.equal(result.done, 4);
	assert.deepEqual(
		result.bySize.map(group => group.key),
		["small"],
	);
	// In type order: docs before features.
	const [docs, feature] = result.byType;
	assert.equal(feature?.key, "feature");
	assert.equal(feature?.count, 3);
	// Work at API prices, whoever paid: $3, $9 and the plan's $3.
	assert.equal(feature?.priced, 3);
	close(feature?.work?.median ?? null, 3);
	close(feature?.work?.p90 ?? null, 7.8);
	assert.deepEqual(feature?.seconds, { median: 1200, p90: 1680 });
	// Only the keys' turns were added to the bills.
	close(feature?.extraUsd ?? null, 12);
	assert.equal(docs?.key, "docs");
	assert.equal(docs?.work, null);
	assert.equal(docs?.unknown, 1);
	close(result.retries.workUsd, 6);
	close(result.retries.extraUsd, 3);
	assert.equal(result.retries.items, 2);
	close(result.abandoned.workUsd, 9);
	close(result.abandoned.extraUsd, 6);
	assert.deepEqual([result.abandoned.cancelled, result.abandoned.failed], [1, 1]);
	assert.deepEqual(result.plan, { items: 2, turns: 2, usd: 6 });
});

test("nothing ended: empty groups and nothing spent", () => {
	const result = summarize([], RATES);
	assert.deepEqual(result.bySize, []);
	assert.deepEqual(result.byType, []);
	assert.equal(result.retries.workUsd, 0);
	assert.equal(result.abandoned.items, 0);
});
