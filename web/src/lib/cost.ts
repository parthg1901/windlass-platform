/**
 * An item's cost as the screens say it (server/src/factory/cost.ts prices it): dollars for what an API key or a
 * hosted sandbox paid, "on your Claude plan" for what a subscription carried, and "cost unknown" where the
 * platform could not price a part. Token counts are only details.
 */
import type { CostRates, ItemSize, ItemSummary, ModelProvider, SpendUsage, WorkType } from "@contract";
import { PLAN_NAMES } from "@contract";
import { type CostLine, type ItemCost, itemCost, mergeUsage } from "../../../server/src/factory/cost.js";
import { SMALL_PLAN_LIMIT } from "../../../server/src/factory/feature-plan.js";

/** "$1.23", "$0.004" under a cent, "$0.00" for nothing. */
export function usd(amount: number): string {
	if (amount > 0 && amount < 0.01) return `$${amount.toFixed(amount < 0.001 ? 4 : 3)}`;
	return amount.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** "on your Claude plan", "on your machine's plan". */
export function planWords(plan: { payer: CostLine["payer"]; provider: ModelProvider | null }): string {
	if (plan.payer === "machine-plan") return "on your machine's plan";
	const name = plan.provider ? PLAN_NAMES[plan.provider as keyof typeof PLAN_NAMES] : undefined;
	return `on your ${name ?? "plan"}`;
}

/** What an item's summary used, its parts' too for a feature, priced. */
export function summaryCost(item: Pick<ItemSummary, "spent" | "partsUsage">, rates: CostRates): ItemCost {
	return itemCost(mergeUsage([item.spent.usage, item.partsUsage]), rates);
}

/** Whether anything was used to cost. */
export const anyCost = (cost: ItemCost): boolean => cost.lines.length > 0 || cost.sandbox.seconds > 0;

/**
 * One figure for a card: "$1.23", "$1.23 + on your Claude plan", "On your ChatGPT plan", "$0.40 + some cost
 * unknown". Null before anything was used.
 */
export function costWords(cost: ItemCost): string | null {
	if (!anyCost(cost)) return null;
	const parts: string[] = [];
	if (cost.usd > 0 || (cost.plans.length === 0 && !cost.unknown)) parts.push(usd(cost.usd));
	for (const plan of cost.plans) parts.push(planWords(plan));
	if (cost.unknown) parts.push(parts.length ? "some cost unknown" : "cost unknown");
	const words = parts.join(" + ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Work items' model turns of a day as Usage's figure: "$1.23", "$1.23 + on your Claude plan", "On your ChatGPT plan";
 * "$0.00" before any turn. Priced like an item's cost.
 */
export function todayCostWords(usage: SpendUsage | undefined, rates: CostRates): string {
	return costWords(itemCost(usage, rates)) ?? usd(0);
}

const PAYER_WORDS: Record<CostLine["payer"], string> = {
	key: "your API key",
	"machine-key": "your machine's API key",
	plan: "your plan",
	"machine-plan": "your machine's plan",
};

/** What a model line cost: "$0.82", "On your Claude plan", "Cost unknown" (or "at least $0.40"). */
export function lineWords(line: CostLine): string {
	if (line.payer === "plan" || line.payer === "machine-plan") {
		const words = planWords(line);
		return words.charAt(0).toUpperCase() + words.slice(1);
	}
	if (!line.unknown) return usd(line.usd ?? 0);
	return line.knownUsd > 0 ? `At least ${usd(line.knownUsd)}, the rest unknown` : "Cost unknown";
}

/** Who paid a line, in words: "your API key". */
export const payerWords = (line: Pick<CostLine, "payer">): string => PAYER_WORDS[line.payer];

/** The Usage summary's sizes in words, with what each is. */
export const SIZE_WORDS: Record<ItemSize, { name: string; what: string }> = {
	small: { name: "Small", what: "one item" },
	medium: { name: "Medium", what: `a feature of up to ${SMALL_PLAN_LIMIT} parts` },
	large: { name: "Large", what: `a feature of ${SMALL_PLAN_LIMIT + 1} parts or more` },
};

/** The Usage summary's types in words, with what each is. */
export const TYPE_WORDS: Record<WorkType, { name: string; what: string }> = {
	docs: { name: "Docs", what: "only documentation" },
	tests: { name: "Tests", what: "only tests" },
	deps: { name: "Dependencies", what: "only manifests and lockfiles" },
	feature: { name: "Features and fixes", what: "source code changed" },
	other: { name: "Other", what: "config, CI, assets or no change" },
};
