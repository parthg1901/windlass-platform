/**
 * An item's budget as the screens say it (server/src/factory/budget.ts holds the rules): dollars of work, every turn at
 * API prices whoever pays (a key's turns at what they cost, a plan's at what they would on a key), and tokens only while
 * some turn could not be priced.
 */
import type { ItemBudget, ItemSpend } from "@contract";
import { budgetUnits, partShare, spellTokens, spellUsd } from "../../../server/src/factory/budget.js";

export type MoneyFigure = "usd" | "tokens";

/** The figures that hold an item now, in the order a stop names them. */
export function heldFigures(budget: ItemBudget, spent: Pick<ItemSpend, "usdUnknown">): MoneyFigure[] {
	const units = budgetUnits(budget, spent);
	return (["usd", "tokens"] as const).filter(figure => units[figure]);
}

/** One figure's amount: "$1.25 of work", "400k tokens"; with `unit` false, "$1.25", "400k". */
export function figureWords(figure: MoneyFigure, value: number, unit = true): string {
	if (figure === "usd") return unit ? `${spellUsd(value)} of work` : spellUsd(value);
	return unit ? `${spellTokens(value)} tokens` : spellTokens(value);
}

/**
 * What an item spent of its budget: "$0.40 of work of $1.25", with "· 900k of 2M tokens" while a turn could not be
 * priced. Before it spent anything it says what it may: "$1.25 of work".
 */
export function spendWords(budget: ItemBudget, spent: ItemSpend | null): string {
	const figures = heldFigures(budget, spent ?? {});
	if (!spent || spent.turns === 0) return figures.map(figure => figureWords(figure, budget[figure] ?? 0)).join(" or ");
	return figures
		.map(figure =>
			figure === "usd"
				? `${figureWords(figure, spent.usd ?? 0)} of ${spellUsd(budget.usd ?? 0)}`
				: `${spellTokens(spent.tokens)} of ${figureWords(figure, budget.tokens)}`,
		)
		.join(" · ");
}

/** A part's budget from its planned tokens: an item's dollars in proportion (budget.ts `partShare`). */
export function partBudget(single: ItemBudget, tokens: number): ItemBudget {
	return { tokens, hostedSeconds: single.hostedSeconds, ...partShare(single, tokens) };
}

/** A tokens line for "How this is counted": the cost-weighted figure, and its budget where tokens hold. */
export function tokenDetail(budget: ItemBudget, spent: ItemSpend): string {
	const raw = spent.rawTokens ?? spent.tokens;
	const held = heldFigures(budget, spent).includes("tokens");
	return `${spellTokens(spent.tokens)} cost-weighted tokens (${spellTokens(raw)} as reported)${held ? ` of a ${spellTokens(budget.tokens)}-token budget` : ""}.`;
}

const FIELD_LABELS: Record<MoneyFigure, string> = { usd: "Work, at API prices", tokens: "Tokens" };

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
