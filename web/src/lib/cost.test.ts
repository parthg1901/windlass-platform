/** An item's cost in words: dollars for keys and hosted time, the plan's name for a plan's turns, unknown said as such. */
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
import { costWords, lineWords, planWords, summaryCost, todayCostWords, usd } from "./cost";

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

describe("an item's cost in words", () => {
	it("says dollars, a fraction of a cent too", () => {
		expect(usd(3)).toBe("$3.00");
		expect(usd(0.004)).toBe("$0.004");
		expect(usd(0)).toBe("$0.00");
	});
	it("names the plan that paid, with no dollars for it", () => {
		const cost = itemCost(usage({ ...keyTurn, key: { ...key, plan: true } }), RATES);
		expect(costWords(cost)).toBe("On your Claude plan");
		expect(lineWords(cost.lines[0]!)).toBe("On your Claude plan");
		expect(planWords({ payer: "plan", provider: "openai" })).toBe("on your ChatGPT plan");
		expect(planWords({ payer: "machine-plan", provider: "anthropic" })).toBe("on your machine's plan");
	});
	it("adds a plan's share to a key's dollars and the sandbox's", () => {
		const both = usage({ ...keyTurn, key }, { ...keyTurn, key: { ...key, plan: true } });
		addSandbox(both, "standard", 3600);
		expect(costWords(itemCost(both, RATES))).toBe("$3.18 + on your Claude plan");
	});
	it("says unknown, never a guess, and what is known beside it", () => {
		const unknown = itemCost(usage({ ...keyTurn, key, model: "anthropic/claude-new" }), RATES);
		expect(costWords(unknown)).toBe("Cost unknown");
		expect(lineWords(unknown.lines[0]!)).toBe("Cost unknown");
		const some = itemCost(usage({ ...keyTurn, key }, { ...keyTurn, key, model: "anthropic/claude-new" }), RATES);
		expect(costWords(some)).toBe("$3.00 + some cost unknown");
	});
	it("says nothing before anything was used, and sums a feature's parts", () => {
		expect(costWords(itemCost(undefined, RATES))).toBeNull();
		const spent = { tokens: 0, turns: 0, activeSeconds: 0, hostedSeconds: 0, usage: usage({ ...keyTurn, key }) };
		expect(costWords(summaryCost({ spent, partsUsage: usage({ ...keyTurn, key }) }, RATES))).toBe("$6.00");
	});
});

describe("today's model cost on Usage", () => {
	it("says the day's dollars, and the plan that carried turns, priced like an item's cost", () => {
		expect(todayCostWords(undefined, RATES)).toBe("$0.00");
		expect(todayCostWords(usage({ ...keyTurn, key }), RATES)).toBe("$3.00");
		expect(todayCostWords(usage({ ...keyTurn, key }, { ...keyTurn, key: { ...key, plan: true } }), RATES)).toBe(
			"$3.00 + on your Claude plan",
		);
	});
	it("counts only what an item used since it was last read", () => {
		const before = usage({ ...keyTurn, key });
		const after = usage({ ...keyTurn, key }, { ...keyTurn, key }, { ...keyTurn, key: { ...key, plan: true } });
		addSandbox(after, "standard", 600);
		const since = modelUsageSince(after, before);
		expect(since.sandbox).toEqual([]);
		expect(since.models.map(line => [line.payer, line.turns, line.inputTokens])).toEqual([
			["key", 1, 1_000_000],
			["plan", 1, 1_000_000],
		]);
		expect(todayCostWords(since, RATES)).toBe("$3.00 + on your Claude plan");
		expect(modelUsageSince(before, before).models).toEqual([]);
	});
});
