/** An item's cost in words: what it added to your bills, what each plan carried at API prices, unknown said as such. */
import type { CostRates, SpendUsage } from "@contract";
import { describe, expect, it } from "vitest";
import {
	addSandbox,
	addTurn,
	itemCost,
	modelUsageSince,
	noUsage,
	turnMeter,
} from "../../../server/src/factory/cost.js";
import { costWords, lineWords, payerAmount, payerLabel, sandboxRows, summaryCost, todayCostWords, usd } from "./cost";

const RATES: CostRates = {
	models: { "anthropic/claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3 } },
	source: null,
	sandbox: { standard: 0.18 },
};

const used = (input: number) => ({ inputTokens: input, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 });

function usage(...turns: Parameters<typeof turnMeter>[0][]): SpendUsage {
	const into = noUsage();
	for (const turn of turns) addTurn(into, turnMeter(turn));
	return into;
}

const keyTurn = {
	harness: "windlass",
	model: "anthropic/claude-sonnet-4-5",
	size: null,
	usage: used(1_000_000),
} as const;
const key = { provider: "anthropic", generation: "g" } as const;

const plan = { ...key, plan: true } as const;

describe("an item's cost in words", () => {
	it("says dollars, a fraction of a cent too", () => {
		expect(usd(3)).toBe("$3.00");
		expect(usd(0.004)).toBe("$0.004");
		expect(usd(0)).toBe("$0.00");
	});
	it("values a plan's turns at API prices, and adds nothing to the bills for them", () => {
		const cost = itemCost(usage({ ...keyTurn, key: plan }), RATES);
		expect(costWords(cost)).toBe("Included in your plans");
		expect(payerLabel(cost.payers[0]!)).toBe("Included in your Claude plan");
		expect(payerAmount(cost.payers[0]!)).toBe("1 turn · ≈ $3.00 at API prices");
		expect(lineWords(cost.lines[0]!)).toBe("≈ $3.00 at API prices");
		expect(payerLabel({ payer: "plan", provider: "openai" })).toBe("Included in your ChatGPT plan");
		expect(payerLabel({ payer: "machine-plan", provider: "anthropic" })).toBe("Included in your machine's plan");
		expect(payerLabel({ payer: "machine-key", provider: "openai" })).toBe("Paid with your machine's OpenAI key");
	});
	it("says a key's dollars and extra hosted time as what the item added, never the estimate or a plan's value", () => {
		const both = usage({ ...keyTurn, key }, { ...keyTurn, key: plan });
		addSandbox(both, "standard", 3600);
		const estimated = itemCost(both, RATES);
		expect(costWords(estimated)).toBe("$3.00 extra");
		expect(estimated.workUsd).toBe(6);
		expect(sandboxRows(estimated, "hosted", RATES)).toEqual([
			{ label: "Sandbox", value: "≈ $0.18 hosted for 1 h, estimated" },
		]);
		both.hosted = { includedSeconds: 3000, extraSeconds: 600, extraUsd: 0.06 };
		const billed = itemCost(both, RATES);
		expect(costWords(billed)).toBe("$3.06 extra");
		expect(sandboxRows(billed, "hosted", RATES)).toEqual([
			{ label: "Included in your Windlass plan", value: "50 hosted min" },
			{ label: "Extra hosted time", value: "10 hosted min · $0.06" },
		]);
		expect(sandboxRows(billed, "machine", RATES)).toEqual([{ label: "Sandbox", value: "$0.00: your machine" }]);
		expect(sandboxRows(estimated, "hosted", { sandbox: null })[0]?.value).toBe("1 h, not billed by time here");
		const sandboxOnly = noUsage();
		addSandbox(sandboxOnly, "standard", 3600);
		expect(costWords(itemCost(sandboxOnly, RATES))).toBe("Nothing extra");
	});
	it("says unknown, never a guess, and what is known beside it", () => {
		const unknown = itemCost(usage({ ...keyTurn, key, model: "anthropic/claude-new" }), RATES);
		expect(costWords(unknown)).toBe("Cost unknown");
		expect(lineWords(unknown.lines[0]!)).toBe("Cost unknown");
		const some = itemCost(usage({ ...keyTurn, key }, { ...keyTurn, key, model: "anthropic/claude-new" }), RATES);
		expect(costWords(some)).toBe("$3.00 extra + some cost unknown");
		expect(payerAmount(some.payers[0]!)).toBe("At least $3.00, the rest unknown");
		const planUnknown = itemCost(usage({ ...keyTurn, key: plan, model: "anthropic/claude-new" }), RATES);
		expect(costWords(planUnknown)).toBe("Included in your plans");
		expect(payerAmount(planUnknown.payers[0]!)).toBe("1 turn · cost unknown");
	});
	it("says nothing before anything was used, and sums a feature's parts", () => {
		expect(costWords(itemCost(undefined, RATES))).toBeNull();
		const spent = { tokens: 0, turns: 0, activeSeconds: 0, hostedSeconds: 0, usage: usage({ ...keyTurn, key }) };
		expect(costWords(summaryCost({ spent, partsUsage: usage({ ...keyTurn, key }) }, RATES))).toBe("$6.00 extra");
	});
});

describe("today's model cost on Usage", () => {
	it("says the day's key dollars, and what the plans carried at API prices", () => {
		expect(todayCostWords(undefined, RATES)).toBe("$0.00 on your keys");
		expect(todayCostWords(usage({ ...keyTurn, key }), RATES)).toBe("$3.00 on your keys");
		expect(todayCostWords(usage({ ...keyTurn, key }, { ...keyTurn, key: plan }), RATES)).toBe(
			"$3.00 on your keys + ≈ $3.00 included in your plans",
		);
		expect(todayCostWords(usage({ ...keyTurn, key: plan }), RATES)).toBe("≈ $3.00 included in your plans");
	});
	it("counts only what an item used since it was last read", () => {
		const before = usage({ ...keyTurn, key });
		const after = usage({ ...keyTurn, key }, { ...keyTurn, key }, { ...keyTurn, key: plan });
		addSandbox(after, "standard", 600);
		const since = modelUsageSince(after, before);
		expect(since.sandbox).toEqual([]);
		expect(since.models.map(line => [line.payer, line.turns, line.inputTokens])).toEqual([
			["key", 1, 1_000_000],
			["plan", 1, 1_000_000],
		]);
		expect(todayCostWords(since, RATES)).toBe("$3.00 on your keys + ≈ $3.00 included in your plans");
		expect(modelUsageSince(before, before).models).toEqual([]);
	});
});
