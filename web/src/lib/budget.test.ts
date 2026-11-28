import type { ItemBudget, ItemSpend } from "@contract";
import { describe, expect, it } from "vitest";
import { budgetNote, heldFigures, moneyFields, partBudget, spendWords, tokenDetail } from "./budget";

const budget: ItemBudget = { tokens: 2_000_000, hostedSeconds: 7200, usd: 4, planPct: 20 };
const spent = (more: Partial<ItemSpend> = {}): ItemSpend => ({
	tokens: 900_000,
	rawTokens: 5_000_000,
	turns: 2,
	activeSeconds: 60,
	hostedSeconds: 30,
	...more,
});

describe("budget words", () => {
	it("says dollars where a key paid, and no tokens", () => {
		expect(heldFigures(budget, spent({ usd: 3 }))).toEqual(["usd"]);
		expect(spendWords(budget, spent({ usd: 3 }))).toBe("$3 of $4");
	});

	it("says the plan's 5-hour share where a plan paid", () => {
		expect(spendWords(budget, spent({ planPct: 2.5 }))).toBe("2.5% of 20% of your 5-hour window");
	});

	it("says what a part may use before it ran, in both units", () => {
		const part = partBudget(budget, 500_000);
		expect(part).toMatchObject({ usd: 1, planPct: 5, tokens: 500_000 });
		expect(spendWords(part, null)).toBe("$1 or 5% of your 5-hour window");
	});

	it("falls back to tokens where a key turn could not be priced, or the item has only tokens", () => {
		expect(heldFigures(budget, spent({ usd: 1, usdUnknown: true }))).toEqual(["usd", "tokens"]);
		expect(spendWords({ tokens: 2_000_000, hostedSeconds: 1 }, spent())).toBe("900k of 2M tokens");
	});

	it("keeps tokens as a detail", () => {
		expect(tokenDetail(budget, spent({ usd: 1 }))).toBe("900k cost-weighted tokens (5M as reported).");
		expect(moneyFields(budget, spent({ usd: 1 })).map(field => field.label)).toEqual(["Dollars"]);
	});

	const both: ItemBudget = { ...budget, planWeekPct: 3 };

	it("says each window the plan reports, and both before anything paid", () => {
		expect(spendWords(both, spent({ planPct: 4, planWeekPct: 1 }))).toBe(
			"4% of 20% of your 5-hour window · 1% of 3% of your weekly window",
		);
		expect(spendWords(both, null)).toBe("$4 or 20% of your 5-hour window and 3% of your weekly window");
		expect(moneyFields(both, spent({ planPct: 4, planWeekPct: 1 })).map(field => field.label)).toEqual([
			"Plan's 5-hour window",
			"Plan's weekly window",
		]);
	});

	it("holds a plan that reports only its weekly window to that window, not tokens", () => {
		expect(heldFigures(both, spent({ planWeekPct: 0.5 }))).toEqual(["planWeekPct"]);
		expect(spendWords(both, spent({ planWeekPct: 0.5 }))).toBe("0.5% of 3% of your weekly window");
	});

	it("says so where tokens hold because the plan reports no window", () => {
		expect(heldFigures(both, spent({ planUnreported: true }))).toEqual(["tokens"]);
		expect(spendWords(both, spent({ planUnreported: true }))).toBe(
			"900k of 2M tokens (your plan doesn't report its usage)",
		);
		expect(budgetNote(spent({ planUnreported: true }))).toBe("Counted in tokens: your plan doesn't report its usage.");
		expect(budgetNote(spent({ planUnreported: true, planWeekPct: 1 }))).toBeNull();
	});

	it("gives a part both plan shares in proportion", () => {
		expect(partBudget(both, 500_000)).toMatchObject({ usd: 1, planPct: 5, planWeekPct: 0.8 });
	});
});
