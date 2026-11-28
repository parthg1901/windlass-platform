/**
 * An item's cost as the screens say it (server/src/factory/cost.ts prices it), split by who carried it: what a plan
 * included (its turns, and what they are worth at API prices), what an API key paid, and hosted time the Windlass plan
 * included or billed as extra. The headline is what the item added to your bills. Token counts are only details.
 */
import type { CostRates, ItemSize, ItemSummary, ModelKeySpend, SpendUsage, WorkType } from "@contract";
import { PLAN_NAMES } from "@contract";
import {
	type CostLine,
	type ItemCost,
	itemCost,
	mergeUsage,
	onPlan,
	type PayerCost,
} from "../../../server/src/factory/cost.js";
import { SMALL_PLAN_LIMIT } from "../../../server/src/factory/feature-plan.js";
import { plural, sandboxTime } from "./format";
import { SOURCE_NAMES } from "./models";

/** "$1.23", "$0.004" under a cent, "$0.00" for nothing. */
export function usd(amount: number): string {
	if (amount > 0 && amount < 0.01) return `$${amount.toFixed(amount < 0.001 ? 4 : 3)}`;
	return amount.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Who carried some turns: "your Claude plan", "your machine's plan", "your Anthropic key", "your machine's OpenAI key". */
export function payerName({ payer, provider }: Pick<PayerCost, "payer" | "provider">): string {
	const whose = payer === "machine-plan" || payer === "machine-key" ? "your machine's" : "your";
	if (onPlan({ payer })) {
		const name = provider && payer === "plan" ? PLAN_NAMES[provider as keyof typeof PLAN_NAMES] : undefined;
		return `${whose} ${name ?? "plan"}`;
	}
	return `${whose} ${provider ? SOURCE_NAMES[provider] : "API"} key`;
}

/** "Included in your Claude plan", "Paid with your Anthropic key". */
export const payerLabel = (payer: Pick<PayerCost, "payer" | "provider">): string =>
	`${onPlan(payer) ? "Included in" : "Paid with"} ${payerName(payer)}`;

const capital = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/** Dollars that may be partly unknown: "$0.82", "at least $0.40, the rest unknown", "cost unknown". */
function knownWords(amount: number, unknown: boolean): string {
	if (!unknown) return usd(amount);
	return amount > 0 ? `at least ${usd(amount)}, the rest unknown` : "cost unknown";
}

/** What one payer's turns cost: a key's dollars ("$0.82"); a plan's turns and their value ("3 turns · ≈ $1.20 at API prices"). */
export function payerAmount(payer: PayerCost): string {
	if (!onPlan(payer)) return capital(knownWords(payer.usd, payer.unknown));
	const value = payer.unknown ? knownWords(payer.usd, true) : `≈ ${usd(payer.usd)} at API prices`;
	return `${plural(payer.turns, "turn")} · ${value}`;
}

/** What a model line cost: "$0.82" on a key, "≈ $0.82 at API prices" on a plan, "Cost unknown". */
export function lineWords(line: CostLine): string {
	if (line.unknown) return capital(knownWords(line.knownUsd, true));
	return onPlan(line) ? `≈ ${usd(line.usd ?? 0)} at API prices` : usd(line.usd ?? 0);
}

/** What an item's summary used, its parts' too for a feature, priced. */
export function summaryCost(item: Pick<ItemSummary, "spent" | "partsUsage">, rates: CostRates): ItemCost {
	return itemCost(mergeUsage([item.spent.usage, item.partsUsage]), rates);
}

/**
 * A session's model cost by who paid (`SessionSummary.spent`), one row per plan and key as an item's cost says them:
 * "Included in your Claude plan: 1 turn · ≈ $0.05 at API prices", "Paid with your Anthropic key: $0.06". Empty before
 * a turn used anything.
 */
export function sessionPayerRows(spent: SpendUsage | undefined, rates: CostRates): { label: string; value: string }[] {
	if (!spent?.models.length) return [];
	return itemCost(spent, rates).payers.map(payer => ({ label: payerLabel(payer), value: payerAmount(payer) }));
}

/** Who paid for one turn, from its `turn.ended`: "Included in your Claude plan", "Paid with your Anthropic key"; null when it does not say. */
export function turnPayerLabel(modelKey: ModelKeySpend | undefined): string | null {
	return modelKey ? payerLabel({ payer: modelKey.plan ? "plan" : "key", provider: modelKey.provider }) : null;
}

/** Whether anything was used to cost. */
export const anyCost = (cost: ItemCost): boolean => cost.lines.length > 0 || cost.sandbox.seconds > 0;

/**
 * One figure for a card: what the item added to your bills (keys' dollars and extra hosted time), "$1.23 extra"; or
 * "Included in your plans" where it added nothing ("Nothing extra" where no plan carried any of it either). "+ some
 * cost unknown", or "Cost unknown", where a key's turns could not be priced. Null before anything was used.
 */
export function costWords(cost: ItemCost): string | null {
	if (!anyCost(cost)) return null;
	const unknown = cost.payers.some(payer => !onPlan(payer) && payer.unknown);
	if (cost.extraUsd > 0) return `${usd(cost.extraUsd)} extra${unknown ? " + some cost unknown" : ""}`;
	if (unknown) return "Cost unknown";
	// Hosted time where billing is off is only estimated: nothing you pay for, but no plan of yours carried it either.
	return cost.payers.some(onPlan) || cost.sandbox.billed ? "Included in your plans" : "Nothing extra";
}

/** Hosted minutes, the unit Windlass billing counts in: "12 hosted min", "0.5 hosted min". */
export function hostedMinutes(seconds: number): string {
	const minutes = seconds / 60;
	return `${Number(minutes.toFixed(minutes < 10 ? 1 : 0))} hosted min`;
}

/**
 * The sandbox's rows on an item's cost: what the Windlass plan included and the extra hosted time it billed; where
 * billing is off, an estimate at the rate card, labelled as one.
 */
export function sandboxRows(
	cost: ItemCost,
	place: "hosted" | "machine",
	rates: Pick<CostRates, "sandbox">,
): { label: string; value: string }[] {
	const { sandbox } = cost;
	if (place === "machine") return [{ label: "Sandbox", value: "$0.00: your machine" }];
	if (sandbox.billed)
		return [
			{ label: "Included in your Windlass plan", value: hostedMinutes(sandbox.includedSeconds) },
			...(sandbox.extraSeconds > 0
				? [{ label: "Extra hosted time", value: `${hostedMinutes(sandbox.extraSeconds)} · ${usd(sandbox.extraUsd)}` }]
				: []),
		];
	if (sandbox.seconds === 0) return [{ label: "Sandbox", value: "None yet" }];
	const time = sandboxTime(sandbox.seconds);
	if (rates.sandbox === null || sandbox.estimateUsd === null)
		return [{ label: "Sandbox", value: `${time}, not billed by time here` }];
	if (sandbox.unknown) return [{ label: "Sandbox", value: `${time}, cost unknown` }];
	return [{ label: "Sandbox", value: `≈ ${usd(sandbox.estimateUsd)} hosted for ${time}, estimated` }];
}

/**
 * Work items' model turns of a day as Usage's figure: "$1.23 on your keys", with "≈ $0.80 included in your plans"
 * where a plan carried turns; "$0.00 on your keys" before any turn. Priced like an item's cost.
 */
export function todayCostWords(usage: SpendUsage | undefined, rates: CostRates): string {
	const cost = itemCost(usage, rates);
	const keys = cost.payers.filter(payer => !onPlan(payer));
	const plans = cost.payers.filter(onPlan);
	const sum = (payers: PayerCost[]) => payers.reduce((total, payer) => total + payer.usd, 0);
	const parts: string[] = [];
	if (keys.length > 0 || plans.length === 0) parts.push(`${usd(sum(keys))} on your keys`);
	if (plans.length > 0) parts.push(`≈ ${usd(sum(plans))} included in your plans`);
	if (cost.unknown) parts.push("some cost unknown");
	return parts.join(" + ");
}

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
