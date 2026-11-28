// What an item cost (server/src/factory/cost.ts) and where its token prices come from (server/src/model-prices.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CostRates, SpendUsage, TurnUsage } from "../server/src/contract.js";
import { UsageBook, type UsageEntry, type UsageLimits } from "../server/src/usage.js";
import { FACTORY_DEFAULTS } from "../server/src/factory/budget.js";
import { createItem } from "../server/src/factory/blueprint.js";
import { chargeTurn, noteHostedTime } from "../server/src/factory/change.js";
import { itemCost, mergeUsage, turnCost, turnMeter, type TurnMeter } from "../server/src/factory/cost.js";
import type { FactoryItem, FeatureJob } from "../server/src/factory/types.js";
import {
	MAX_CATALOG_BYTES,
	ModelPriceCache,
	REFRESH_MS,
	RETRY_MS,
	parseModelPrices,
} from "../server/src/model-prices.js";

const RATES: CostRates = {
	models: {
		"anthropic/claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3 },
		"openai/gpt-5.3-codex": { input: 1.75, output: 14 },
	},
	source: { name: "models.dev", url: "https://models.dev/api.json", fetchedAt: 0 },
	sandbox: { small: 0.0306, standard: 0.1656, large: null },
};

const tokens = (input: number, cached: number, output: number): TurnUsage => ({
	inputTokens: input,
	cachedInputTokens: cached,
	outputTokens: output,
	reasoningTokens: 0,
});

const close = (actual: number, expected: number) =>
	assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

function item(place: FactoryItem["place"] = { kind: "hosted" }): FactoryItem {
	return createItem({
		id: "i_00000000000000cc",
		task: { title: "Fix add()", body: "", acceptance: [], base: "main" },
		reviewer: { off: "deployment" },
		place,
		budget: { ...FACTORY_DEFAULTS.item },
	});
}

const charge = (into: FactoryItem, meter: TurnMeter, hostedSeconds = 0) =>
	chargeTurn(into, { tokens: 0, hostedSeconds, meter });

test("a Settings key's tokens are priced from the catalog, cached input at its own price", () => {
	const meter = turnMeter({
		harness: "windlass",
		model: "anthropic/claude-sonnet-4-5",
		key: { provider: "anthropic", generation: "g1" },
		usage: tokens(1_000_000, 800_000, 100_000),
		size: "standard",
	});
	assert.equal(meter.payer, "key");
	const into = item();
	charge(into, meter);
	const cost = itemCost(into.spent.usage, RATES);
	// 200k fresh input at $3, 800k cached at $0.30, 100k output at $15 per million.
	close(cost.workUsd, 0.6 + 0.24 + 1.5);
	close(cost.extraUsd, 0.6 + 0.24 + 1.5);
	assert.equal(cost.unknown, false);
	assert.deepEqual(
		cost.payers.map(p => [p.payer, p.provider, p.turns]),
		[["key", "anthropic", 1]],
	);
});

test("a catalog without a cached price prices cached input as input", () => {
	const usage: SpendUsage = { models: [], sandbox: [] };
	const into = item({ kind: "machine", machineId: "m1" });
	into.spent.usage = usage;
	charge(
		into,
		turnMeter({
			harness: "codex",
			model: "gpt-5.3-codex",
			signIn: "api-key",
			usage: tokens(1_000_000, 500_000, 0),
			size: null,
		}),
	);
	assert.equal(into.spent.usage.models[0]?.payer, "machine-key");
	close(itemCost(into.spent.usage, RATES).extraUsd, 1.75);
});

test("the agent's own cost is preferred where its record says it is the turn's", () => {
	const into = item();
	charge(
		into,
		turnMeter({
			harness: "claude",
			model: "sonnet",
			key: { provider: "anthropic", generation: "g1" },
			usage: tokens(1_000_000, 0, 0),
			cost: { amount: 0.42, currency: "USD" },
			size: "standard",
		}),
	);
	const cost = itemCost(into.spent.usage, RATES);
	close(cost.workUsd, 0.42);
	assert.equal(cost.unknown, false);
	// OpenCode's reported cost covers its whole conversation, so its tokens are priced instead.
	const opencode = turnMeter({
		harness: "opencode",
		model: "anthropic/claude-sonnet-4-5",
		key: { provider: "anthropic", generation: "g1" },
		usage: tokens(1_000_000, 0, 0),
		cost: { amount: 9, currency: "USD" },
		size: "standard",
	});
	assert.equal(opencode.agentUsd, null);
	// A cost in another currency is not taken either.
	assert.equal(
		turnMeter({ harness: "claude", model: "sonnet", usage: null, cost: { amount: 1, currency: "EUR" }, size: null })
			.agentUsd,
		null,
	);
});

test("a plan's turns are worth what they would cost on a key, and add nothing to the bills", () => {
	const into = item();
	charge(
		into,
		turnMeter({
			harness: "claude",
			model: "opus",
			key: { provider: "anthropic", generation: "g1", plan: true },
			usage: tokens(2_000_000, 1_000_000, 50_000),
			cost: { amount: 3.1, currency: "USD" },
			size: "standard",
		}),
	);
	// Windlass without a key runs on the user's ChatGPT sign-in; Claude Code on a machine's subscription.
	charge(into, turnMeter({ harness: "windlass", model: "default", usage: tokens(10, 0, 1), size: "standard" }));
	charge(
		into,
		turnMeter({ harness: "claude", model: "default", signIn: "subscription", usage: tokens(10, 0, 1), size: null }),
	);
	const cost = itemCost(into.spent.usage, RATES);
	assert.equal(cost.extraUsd, 0);
	// Claude Code's own $3.10 for the first; "default" has no catalog price, so the other two are unknown.
	assert.equal(cost.unknown, true);
	assert.deepEqual(
		cost.payers.map(p => [p.payer, p.provider, p.turns, p.unknown]),
		[
			["plan", "anthropic", 1, false],
			["plan", "openai", 1, true],
			["machine-plan", "anthropic", 1, true],
		],
	);
	close(cost.payers[0]!.usd, 3.1);
	close(cost.workUsd, 3.1);
	assert.equal(cost.lines[0]?.tokens.inputTokens, 2_000_000, "tokens stay as details");
});

test("hosted time is priced at its size; a machine's sandbox costs nothing", () => {
	const hosted = item();
	charge(hosted, turnMeter({ harness: "windlass", model: "default", usage: tokens(1, 0, 1), size: "standard" }), 1800);
	// Time settled after the turn is taken at the size the turn ran at.
	hosted.spent.hostedSeconds = 3600;
	noteHostedTime(hosted);
	assert.deepEqual(hosted.spent.usage?.sandbox, [{ size: "standard", seconds: 3600 }]);
	// Billing off: the rate card, as an estimate, and nothing extra.
	const estimate = itemCost(hosted.spent.usage, RATES);
	close(estimate.sandbox.estimateUsd!, 0.1656);
	assert.equal(estimate.sandbox.billed, false);
	assert.equal(estimate.extraUsd, 0);

	const machine = item({ kind: "machine", machineId: "m1" });
	machine.spent.hostedSeconds = 900;
	charge(machine, turnMeter({ harness: "claude", model: "default", signIn: "api-key", usage: null, size: null }));
	assert.deepEqual(machine.spent.usage?.sandbox, []);
	assert.equal(itemCost(machine.spent.usage, RATES).sandbox.estimateUsd, 0);

	// A size without a known rate is unknown; a deployment that does not bill by time charges nothing.
	const large: SpendUsage = { models: [], sandbox: [{ size: "large", seconds: 60 }] };
	assert.equal(itemCost(large, RATES).sandbox.unknown, true);
	assert.equal(itemCost(large, { ...RATES, sandbox: null }).unknown, false);
	assert.equal(itemCost(large, { ...RATES, sandbox: null }).sandbox.estimateUsd, null);
});

test("an unknown model, or a key turn that reported nothing, is unknown, never guessed", () => {
	const into = item();
	charge(
		into,
		turnMeter({
			harness: "windlass",
			model: "anthropic/claude-made-up-9",
			key: { provider: "anthropic", generation: "g1" },
			usage: tokens(1000, 0, 10),
			size: "standard",
		}),
	);
	let cost = itemCost(into.spent.usage, RATES);
	assert.equal(cost.unknown, true);
	assert.equal(cost.lines[0]?.usd, null);
	assert.equal(cost.workUsd, 0);
	// Prices not read yet: the same.
	assert.equal(itemCost(into.spent.usage, { ...RATES, models: null }).unknown, true);

	const silent = item();
	charge(
		silent,
		turnMeter({
			harness: "claude",
			model: "sonnet",
			key: { provider: "anthropic", generation: "g1" },
			usage: null,
			size: "standard",
		}),
	);
	cost = itemCost(silent.spent.usage, RATES);
	assert.equal(cost.unknown, true);
	assert.equal(silent.spent.usage?.models[0]?.unreported, 1);
});

test("a feature sums its parts, retries among them, apart from its own turns", () => {
	const meter = (input: number) =>
		turnMeter({
			harness: "windlass",
			model: "anthropic/claude-sonnet-4-5",
			key: { provider: "anthropic", generation: "g1" },
			usage: tokens(input, 0, 0),
			size: "standard",
		});
	const part = (id: string, key: string, input: number, seconds: number, state: FeatureJob["state"]) => {
		const child = item();
		child.spent.hostedSeconds = seconds;
		charge(child, meter(input), seconds);
		return { id, task: { key }, state, spent: child.spent } as unknown as FeatureJob;
	};
	const feature = item();
	feature.mode = "orchestrate";
	// The first attempt at "parser" failed and was dispatched again.
	feature.jobs = [
		part("i_p1", "parser", 1_000_000, 600, "failed"),
		part("i_p2", "parser", 1_000_000, 600, "done"),
		part("i_w1", "writer", 2_000_000, 1200, "done"),
	];
	// The feature's hosted seconds include its parts' (work-item.ts `childSeconds`): only its own are its sandbox.
	charge(feature, meter(500_000), 300 + 2400);
	assert.deepEqual(feature.spent.usage?.sandbox, [{ size: "standard", seconds: 300 }]);
	const parts = mergeUsage(feature.jobs.map(job => job.spent.usage));
	assert.equal(parts.models[0]?.turns, 3);
	const total = itemCost(mergeUsage([feature.spent.usage, parts]), RATES);
	close(total.workUsd, (4_000_000 + 500_000) * 3e-6);
	close(total.sandbox.estimateUsd!, (2700 / 3600) * 0.1656);
});

// ---------------------------------------------------------------------------------------------
// Hosted time under Windlass billing
// ---------------------------------------------------------------------------------------------

const DAY = 86_400_000;
const START = Date.UTC(2026, 10, 1);
const entry = (session: string, seconds: number, weight = 1, day = 0): UsageEntry => ({
	day: START / DAY + day,
	session,
	hold: `${session}-${seconds}-${day}`,
	kind: "used",
	seconds,
	weight,
	startedAt: START + day * DAY,
	at: START + day * DAY,
	note: null,
});
/** Monthly Pro: 30 included minutes, and $1.20 of cap at $0.006 a minute pays for 200 more. */
const PRO = {
	dailySeconds: null,
	maxKept: null,
	holdSeconds: 900,
	plan: "pro" as const,
	includedSeconds: 1800,
	monthlySeconds: 1800 + 200 * 60,
	subscription: { period: "month" as const, periodStart: START, periodEnd: START + 30 * DAY },
};
const splits = (limits: UsageLimits, entries: UsageEntry[]) => {
	const book = new UsageBook(limits, { entries });
	return entries.map(one => book.hostedSplit(one));
};

test("hosted time is included until the plan's minutes are used, then extra at the overage price", () => {
	const [before, crossing, after] = splits(PRO, [
		entry("other", 1200),
		entry("item", 1200, 1, 1),
		entry("item", 600, 2, 2),
	]);
	// Another session's 20 minutes leave 10 included; this item's 20 cross the line; the next 10 large count 20, all extra.
	assert.deepEqual(before, { includedSeconds: 1200, extraSeconds: 0, extraUsd: 0 });
	assert.equal(crossing?.includedSeconds, 600);
	assert.equal(crossing?.extraSeconds, 600);
	close(crossing!.extraUsd, 10 * 0.006);
	assert.equal(after?.includedSeconds, 0);
	assert.equal(after?.extraSeconds, 1200);
	close(after!.extraUsd, 20 * 0.006);
});

test("extra hosted time past the spend cap is not billed", () => {
	const [, over] = splits(PRO, [entry("other", 1800 + 190 * 60), entry("item", 1200, 1, 1)]);
	// 10 of the cap's minutes are left: 20 extra, 10 billed.
	assert.equal(over?.extraSeconds, 1200);
	close(over!.extraUsd, 10 * 0.006);
});

test("Free and yearly Pro have no overage, and billing off or an exempt account has no split", () => {
	const free = { ...PRO, plan: "free" as const, subscription: null, monthlySeconds: 1800 };
	assert.deepEqual(splits(free, [entry("other", 1800), entry("item", 600, 1, 1)])[1], {
		includedSeconds: 600,
		extraSeconds: 0,
		extraUsd: 0,
	});
	const yearly = { ...PRO, subscription: { ...PRO.subscription, period: "year" as const } };
	assert.equal(splits(yearly, [entry("other", 1800), entry("item", 600, 1, 1)])[1]?.extraSeconds, 0);
	const off = { ...PRO, plan: null, includedSeconds: null, monthlySeconds: null, subscription: null };
	assert.equal(splits(off, [entry("item", 600)])[0], null);
});

test("an item's hosted split is kept as billing made it, summed over a feature, and its extra is on the bills", () => {
	const into = item();
	charge(into, turnMeter({ harness: "windlass", model: "default", usage: tokens(1, 0, 1), size: "standard" }), 600);
	noteHostedTime(into, { includedSeconds: 300, extraSeconds: 300, extraUsd: 0.03 });
	const part: SpendUsage = { models: [], sandbox: [], hosted: { includedSeconds: 60, extraSeconds: 0, extraUsd: 0 } };
	const cost = itemCost(mergeUsage([into.spent.usage, part]), RATES);
	assert.equal(cost.sandbox.billed, true);
	assert.equal(cost.sandbox.includedSeconds, 360);
	assert.equal(cost.sandbox.extraSeconds, 300);
	assert.equal(cost.sandbox.estimateUsd, null);
	close(cost.extraUsd, 0.03);
});

// ---------------------------------------------------------------------------------------------
// The price catalog
// ---------------------------------------------------------------------------------------------

const CATALOG = {
	anthropic: {
		id: "anthropic",
		models: {
			"claude-sonnet-4-5": { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
			"claude-free": { cost: { input: 0, output: 0 } },
			"claude-unpriced": { name: "no cost" },
			"claude-bad": { cost: { input: -1, output: 2 } },
		},
	},
	openai: { models: { "gpt-5.3-codex": { cost: { input: 1.75, output: 14, cache_read: 0.175 } } } },
	openrouter: { models: { "anthropic/claude-sonnet-4.5": { cost: { input: 3, output: 15 } } } },
	mistral: { models: { "mistral-large": { cost: { input: 2, output: 6 } } } },
};

test("the catalog parser keeps the platform's providers' priced models", () => {
	assert.deepEqual(parseModelPrices(CATALOG), {
		"anthropic/claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3 },
		"anthropic/claude-free": { input: 0, output: 0 },
		"openai/gpt-5.3-codex": { input: 1.75, output: 14, cacheRead: 0.175 },
		"openrouter/anthropic/claude-sonnet-4.5": { input: 3, output: 15 },
	});
	assert.throws(() => parseModelPrices([]), /not a JSON object/);
	assert.throws(() => parseModelPrices({ mistral: CATALOG.mistral }), /none of the platform's providers/);
});

function stubFetch(answers: Array<() => Response>) {
	const calls: string[] = [];
	const stub = (async (url: string | URL | Request) => {
		calls.push(String(url));
		const next = answers.shift();
		if (!next) throw new Error("no answer");
		return next();
	}) as typeof fetch;
	return { stub, calls };
}

test("the cache reads once, keeps stale prices when a refresh fails, and tries again later", async () => {
	let now = 1_000;
	const logs: string[] = [];
	const { stub, calls } = stubFetch([
		() => Response.json(CATALOG),
		() => new Response("upstream down", { status: 503 }),
		() => new Response("{not json"),
	]);
	const cache = new ModelPriceCache({
		url: "https://prices.test/api.json",
		fetch: stub,
		now: () => now,
		log: line => logs.push(line),
	});
	const first = await cache.prices();
	assert.equal(first.models?.["anthropic/claude-sonnet-4-5"]?.input, 3);
	assert.deepEqual(first.source, { name: "models.dev", url: "https://prices.test/api.json", fetchedAt: 1_000 });
	await cache.prices();
	assert.equal(calls.length, 1, "read once a day");

	now += REFRESH_MS;
	await cache.prices();
	// The refresh runs in the background: the held prices answer meanwhile, and after it fails.
	await new Promise(resolve => setTimeout(resolve, 10));
	const stale = await cache.prices();
	assert.equal(stale.source?.fetchedAt, 1_000);
	assert.match(logs[0] ?? "", /answered 503/);
	assert.match(logs[0] ?? "", /the prices read before are kept/);
	assert.equal(calls.length, 2, "a failed read waits before the next");

	now += RETRY_MS;
	await cache.prices();
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal((await cache.prices()).models?.["openai/gpt-5.3-codex"]?.output, 14);
	assert.match(logs[1] ?? "", /not JSON/);
});

test("an oversized or malformed catalog is refused", async () => {
	const logs: string[] = [];
	const big = "x".repeat(64);
	const { stub } = stubFetch([
		() => new Response(big, { headers: { "content-length": String(MAX_CATALOG_BYTES + 1) } }),
		() =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(big));
						controller.enqueue(new TextEncoder().encode(big));
						controller.close();
					},
				}),
			),
		() => Response.json({ mistral: {} }),
	]);
	let now = 0;
	const cache = new ModelPriceCache({
		url: "https://prices.test/",
		fetch: stub,
		now: () => now,
		maxBytes: 100,
		log: line => logs.push(line),
	});
	assert.deepEqual(await cache.prices(), { models: null, source: null });
	now += RETRY_MS;
	assert.deepEqual(await cache.prices(), { models: null, source: null });
	now += RETRY_MS;
	assert.deepEqual(await cache.prices(), { models: null, source: null });
	assert.equal(logs.length, 3);
	assert.match(logs[0]!, /larger than 100 bytes/);
	assert.match(logs[1]!, /larger than 100 bytes/);
	assert.match(logs[2]!, /none of the platform's providers/);
});

test("prices off: nothing is read", async () => {
	const { stub, calls } = stubFetch([]);
	assert.deepEqual(await new ModelPriceCache({ url: null, fetch: stub }).prices(), { models: null, source: null });
	assert.equal(calls.length, 0);
});

test("a session's summary says what its turns used, by model and payer, without hosted time", async () => {
	const { summaryOf } = await import("../server/src/actors/agent-session/summary.js");
	const { addSandbox, addTurn, noUsage } = await import("../server/src/factory/cost.js");
	type Meta = Parameters<typeof summaryOf>[0];
	const base = {
		sessionId: "s_1",
		harness: "claude",
		title: "t",
		place: { kind: "hosted" },
		profile: "e2b-open",
		model: "default",
		mode: "auto",
		availableModes: [],
		repoUrl: null,
		createdAt: 0,
		updatedAt: 0,
		status: "idle",
		turns: 2,
		lastOutcome: "succeeded",
		sandbox: "paused",
	} as unknown as Meta;
	assert.equal(summaryOf(base).spent, undefined, "nothing used: no spend");
	const spent = noUsage();
	const turn = (plan: boolean) =>
		turnMeter({
			harness: "claude",
			model: "anthropic/claude-sonnet-4-5",
			key: { provider: "anthropic", generation: "g", ...(plan && { plan: true as const }) },
			usage: tokens(1_000_000, 0, 0),
			size: null,
		});
	addTurn(spent, turn(false));
	addTurn(spent, turn(true));
	addSandbox(spent, "small", 600);
	const summary = summaryOf({ ...base, spent } as Meta);
	assert.deepEqual(
		summary.spent?.models.map(line => [line.payer, line.turns]),
		[
			["key", 1],
			["plan", 1],
		],
	);
	assert.deepEqual(summary.spent?.sandbox, [], "hosted time is the sandbox's, said apart");
	const cost = itemCost(summary.spent, RATES);
	assert.deepEqual(
		cost.payers.map(payer => [payer.payer, payer.usd]),
		[
			["plan", 3],
			["key", 3],
		],
	);
});

test("Claude Code's reported cost is its session's running total: a turn counts what it grew by", () => {
	const usd = (amount: number) => ({ amount, currency: "USD" });
	// The live sequence: $0.06 after the first turn, then $0.11, $0.17, $0.23 for one-line replies.
	let total: number | undefined;
	const turns = [0.06, 0.11, 0.17, 0.23].map(amount => {
		const one = turnCost(usd(amount), total);
		total = one.total;
		return Math.round((one.cost?.amount ?? 0) * 100) / 100;
	});
	assert.deepEqual(turns, [0.06, 0.05, 0.06, 0.06]);
	// A total below the last is a counter that started again: all of it is this turn's.
	assert.deepEqual(turnCost(usd(0.02), 0.23), { cost: usd(0.02), total: 0.02 });
	// Nothing reported, or not in dollars: nothing changes.
	assert.deepEqual(turnCost(null, 0.23), { cost: null, total: 0.23 });
	assert.deepEqual(turnCost({ amount: 3, currency: "EUR" }, 0.23), {
		cost: { amount: 3, currency: "EUR" },
		total: 0.23,
	});
});
