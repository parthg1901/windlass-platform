/**
 * An item's budget as the screens say it (server/src/factory/budget.ts holds the rules): dollars where an API key
 * pays, a share of each of the plan's windows it reports (5-hour and weekly) where a plan pays, tokens only where none
 * can be measured. Before a turn has said what pays, the dollar and the plan figures are shown: whichever pays holds it.
 */
import type { ItemBudget, ItemSpend } from "@contract";
import {
	budgetUnits,
	PLAN_UNREPORTED,
	partShare,
	planUnreported,
	spellPct,
	spellTokens,
	spellUsd,
} from "../../../server/src/factory/budget.js";

export type MoneyFigure = "usd" | "planPct" | "planWeekPct" | "tokens";

const PLAN_FIGURES = ["planPct", "planWeekPct"] as const;
const isPlanFigure = (figure: MoneyFigure): figure is (typeof PLAN_FIGURES)[number] =>
	figure === "planPct" || figure === "planWeekPct";

/** The figures that hold an item now, in the order a stop names them. */
export function heldFigures(budget: ItemBudget, spent: ItemSpend): MoneyFigure[] {
	const units = budgetUnits(budget, spent);
	// Known once a turn said what pays: priced dollars, a plan's window, or a plan that reports none.
	const known =
		spent.usd !== undefined || spent.planPct !== undefined || spent.planWeekPct !== undefined || !!spent.planUnreported;
	const figures: MoneyFigure[] = [];
	if (budget.usd !== undefined && (units.usd || !known)) figures.push("usd");
	for (const figure of PLAN_FIGURES)
		if (budget[figure] !== undefined && (units[figure] || !known)) figures.push(figure);
	if (figures.length === 0 || spent.usdUnknown) figures.push("tokens");
	return figures;
}

const WINDOW_WORDS = { planPct: "5-hour", planWeekPct: "weekly" } as const;

/**
 * One figure's amount: "$1.25", "5% of your 5-hour window", "1% of your weekly window", "400k tokens"; with `unit`
 * false, "5%", "400k".
 */
export function figureWords(figure: MoneyFigure, value: number, unit = true): string {
	if (figure === "usd") return spellUsd(value);
	if (figure === "planPct" || figure === "planWeekPct")
		return unit ? `${spellPct(value)} of your ${WINDOW_WORDS[figure]} window` : spellPct(value);
	return unit ? `${spellTokens(value)} tokens` : spellTokens(value);
}

/** Why tokens hold where a plan paid: "Counted in tokens: your plan doesn't report its usage."; null otherwise. */
export function budgetNote(spent: ItemSpend | null): string | null {
	return spent && planUnreported(spent) ? PLAN_UNREPORTED : null;
}

/**
 * What an item spent of its budget, in its units: "$0.40 of $1.25", "2% of 5% of your 5-hour window · 1% of 3% of
 * your weekly window". Before it spent anything it says what it may: "$1.25 or 5% of your 5-hour window and 1% of
 * your weekly window".
 */
export function spendWords(budget: ItemBudget, spent: ItemSpend | null): string {
	if (!spent || spent.turns === 0) {
		const figures = heldFigures(budget, spent ?? { tokens: 0, hostedSeconds: 0, turns: 0, activeSeconds: 0 });
		const plan = figures.filter(isPlanFigure);
		const planWords = plan.map(figure => figureWords(figure, budget[figure] ?? 0)).join(" and ");
		return figures
			.flatMap(figure =>
				!isPlanFigure(figure) ? [figureWords(figure, budget[figure] ?? 0)] : figure === plan[0] ? [planWords] : [],
			)
			.join(" or ");
	}
	const words = heldFigures(budget, spent)
		.map(figure => `${figureWords(figure, spent[figure] ?? 0, false)} of ${figureWords(figure, budget[figure] ?? 0)}`)
		.join(" · ");
	return budgetNote(spent) ? `${words} (your plan doesn't report its usage)` : words;
}

/** A part's budget from its planned tokens: an item's dollars and plan shares in proportion (budget.ts `partShare`). */
export function partBudget(single: ItemBudget, tokens: number): ItemBudget {
	return { tokens, hostedSeconds: single.hostedSeconds, ...partShare(single, tokens) };
}

/** A tokens line for "How this is counted": the cost-weighted figure, and its budget where tokens hold. */
export function tokenDetail(budget: ItemBudget, spent: ItemSpend): string {
	const raw = spent.rawTokens ?? spent.tokens;
	const held = heldFigures(budget, spent).includes("tokens");
	return `${spellTokens(spent.tokens)} cost-weighted tokens (${spellTokens(raw)} as reported)${held ? ` of a ${spellTokens(budget.tokens)}-token budget` : ""}.`;
}

const FIELD_LABELS: Record<MoneyFigure, string> = {
	usd: "Dollars",
	planPct: "Plan's 5-hour window",
	planWeekPct: "Plan's weekly window",
	tokens: "Tokens",
};

/** The rows of `ItemSpend` for the figures that hold an item now. */
export function moneyFields(
	budget: ItemBudget,
	spent: ItemSpend,
): Array<{ key: MoneyFigure; label: string; spelled(value: number): string }> {
	return heldFigures(budget, spent).map(key => ({
		key,
		label: FIELD_LABELS[key],
		spelled: value => figureWords(key, value, false),
	}));
}
