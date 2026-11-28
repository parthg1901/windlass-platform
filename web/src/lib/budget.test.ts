import type { ItemBudget, ItemSpend } from "@contract";
import { describe, expect, it } from "vitest";
import { heldFigures, moneyFields, partBudget, spendWords, tokenDetail } from "./budget";

const budget: ItemBudget = { tokens: 2_000_000, hostedSeconds: 7200, usd: 4 };
const spent = (more: Partial<ItemSpend> = {}): ItemSpend => ({
	tokens: 900_000,
	rawTokens: 5_000_000,
	turns: 2,
	activeSeconds: 60,
	hostedSeconds: 30,
	...more,
});

describe("budget words", () => {
	it("says dollars of work, whoever paid, and no tokens", () => {
		expect(heldFigures(budget, spent({ usd: 3 }))).toEqual(["usd"]);
		expect(spendWords(budget, spent({ usd: 3 }))).toBe("$3 of work of $4");
		expect(spendWords(budget, null)).toBe("$4 of work");
		expect(spendWords(budget, spent({ turns: 0 }))).toBe("$4 of work");
	});

	it("gives a part dollars in proportion to its planned tokens", () => {
		const part = partBudget(budget, 500_000);
		expect(part).toEqual({ tokens: 500_000, hostedSeconds: 7200, usd: 1 });
		expect(spendWords(part, null)).toBe("$1 of work");
	});

	it("adds tokens while a turn could not be priced, and holds an item without dollars to tokens", () => {
		expect(heldFigures(budget, spent({ usd: 1, usdUnknown: true }))).toEqual(["usd", "tokens"]);
		expect(spendWords(budget, spent({ usd: 1, usdUnknown: true }))).toBe("$1 of work of $4 · 900k of 2M tokens");
		expect(spendWords({ tokens: 2_000_000, hostedSeconds: 1 }, spent())).toBe("900k of 2M tokens");
	});

	it("keeps tokens as a detail", () => {
		expect(tokenDetail(budget, spent({ usd: 1 }))).toBe("900k cost-weighted tokens (5M as reported).");
		expect(moneyFields(budget, spent({ usd: 1 })).map(field => field.label)).toEqual(["Work, at API prices"]);
	});
});
