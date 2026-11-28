/**
 * What an item cost, in dollars: model tokens priced by model and provider, plus its hosted sandbox time.
 *
 * Pure and browser-safe: the work item records what each turn used (`addTurn`, `addSandbox`) and the web prices it
 * (`itemCost`) with the rates of the moment (`CostRates`, server/src/model-prices.ts), so a refreshed price list
 * reprices every item without touching it.
 *
 * A turn's model dollars are, in order: what its agent reported, where its harness record says that is the turn's
 * (`AcpProfile.reportedCost`); its tokens at the catalog's price for the model; otherwise unknown, never a guess.
 * A turn a subscription plan carried is priced the same way: what it would have cost on a key, its value, never a
 * charge. Hosted time is what Windlass billing made of it (`SpendUsage.hosted`: included in the plan, or extra), or,
 * where billing is off, an estimate at the rate card. A machine's sandboxes cost nothing here.
 */

import {
	MODEL_PROVIDERS,
	type CostPayer,
	type CostRates,
	type CredentialRef,
	type HarnessId,
	type HostedSplit,
	type HostedSize,
	type ModelPrice,
	type ModelProvider,
	type ModelUse,
	type SpendUsage,
	type TurnUsage,
	type UsageTokens,
} from "../contract.js";
import { itemTokensOf, machineHarness, selectedKey, type SignInMethod } from "../sandbox/harnesses.js";

/** What one turn used, as the session saw it when the turn ended. */
export interface TurnMeter {
	harness: HarnessId;
	model: string;
	provider: ModelProvider | null;
	payer: CostPayer;
	usage: TurnUsage | null;
	/** The turn's dollars as its agent reported them; null where it reported none the platform takes. */
	agentUsd: number | null;
	/** The hosted size the turn ran at; null on a machine. */
	size: HostedSize | null;
}

/** Who paid for a turn: its pinned credential where it had one, otherwise the agent's sign-in. */
export function turnPayer(
	harness: HarnessId,
	model: string,
	key?: CredentialRef,
	signIn?: SignInMethod,
): { payer: CostPayer; provider: ModelProvider | null } {
	if (key) return { payer: key.plan ? "plan" : "key", provider: key.provider };
	const machine = machineHarness(harness);
	// Windlass without a key runs its unqualified models on the user's ChatGPT sign-in.
	if (!machine) return { payer: "plan", provider: "openai" };
	const provider = selectedKey(harness, model, MODEL_PROVIDERS) ?? null;
	return { payer: itemTokensOf(machine, signIn) === "budget" ? "machine-key" : "machine-plan", provider };
}

/** The meter of a turn that ended. `cost` is the agent's last `usage_update` cost. */
export function turnMeter(input: {
	harness: HarnessId;
	model: string;
	key?: CredentialRef;
	signIn?: SignInMethod;
	usage: TurnUsage | null;
	cost?: { amount: number; currency: string } | null;
	size: HostedSize | null;
}): TurnMeter {
	const { payer, provider } = turnPayer(input.harness, input.model, input.key, input.signIn);
	const { cost } = input;
	const reported =
		machineHarness(input.harness)?.reportedCost === "turn" &&
		cost?.currency === "USD" &&
		Number.isFinite(cost.amount) &&
		cost.amount >= 0;
	return {
		harness: input.harness,
		model: input.model,
		provider,
		payer,
		usage: input.usage,
		agentUsd: reported ? cost.amount : null,
		size: input.size,
	};
}

/**
 * One turn's share of an agent's reported cost. Claude Code reports its session's running total (`total_cost_usd`,
 * which a resumed session carries on), not the turn's: the turn's is what the total grew by since the last turn
 * ended (`previous`). A total below that is a counter that started again, and all of it is this turn's. `total`
 * is what to remember for the next turn.
 */
export function turnCost(
	reported: { amount: number; currency: string } | null | undefined,
	previous: number | undefined,
): { cost: { amount: number; currency: string } | null; total: number | undefined } {
	if (!reported || reported.currency !== "USD" || !Number.isFinite(reported.amount) || reported.amount < 0)
		return { cost: reported ?? null, total: previous };
	const amount = previous !== undefined && reported.amount >= previous ? reported.amount - previous : reported.amount;
	return { cost: { amount, currency: "USD" }, total: reported.amount };
}

export const noUsage = (): SpendUsage => ({ models: [], sandbox: [] });

const noTokens = (): UsageTokens => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });

function addTokens(into: UsageTokens, from: UsageTokens): void {
	into.inputTokens += from.inputTokens;
	into.cachedInputTokens += Math.min(Math.max(0, from.cachedInputTokens || 0), from.inputTokens);
	into.outputTokens += from.outputTokens;
}

type LineKey = Pick<ModelUse, "harness" | "model" | "provider" | "payer">;

const sameLine = (a: LineKey, b: LineKey) =>
	a.harness === b.harness && a.model === b.model && a.provider === b.provider && a.payer === b.payer;

function lineFor(usage: SpendUsage, of: LineKey): ModelUse {
	let line = usage.models.find(line => sameLine(line, of));
	if (!line) {
		line = {
			harness: of.harness,
			model: of.model,
			provider: of.provider,
			payer: of.payer,
			turns: 0,
			unreported: 0,
			agentUsd: 0,
			...noTokens(),
			priced: noTokens(),
		};
		usage.models.push(line);
	}
	return line;
}

/** Adds a turn to what an item used. */
export function addTurn(usage: SpendUsage, meter: TurnMeter): void {
	const line = lineFor(usage, meter);
	line.turns += 1;
	if (meter.usage) addTokens(line, meter.usage);
	if (meter.agentUsd !== null) line.agentUsd += meter.agentUsd;
	else if (meter.usage) addTokens(line.priced, meter.usage);
	else line.unreported += 1;
	if (meter.size) usage.size = meter.size;
}

/** Adds hosted sandbox time at a size. */
export function addSandbox(usage: SpendUsage, size: HostedSize, seconds: number): void {
	if (!(seconds > 0)) return;
	const entry = usage.sandbox.find(entry => entry.size === size);
	if (entry) entry.seconds += seconds;
	else usage.sandbox.push({ size, seconds });
}

/** Two hosted splits as one. */
export const addHosted = (a: HostedSplit | undefined, b: HostedSplit): HostedSplit => ({
	includedSeconds: (a?.includedSeconds ?? 0) + b.includedSeconds,
	extraSeconds: (a?.extraSeconds ?? 0) + b.extraSeconds,
	extraUsd: (a?.extraUsd ?? 0) + b.extraUsd,
});

export const sandboxSeconds = (usage: SpendUsage | undefined): number =>
	(usage?.sandbox ?? []).reduce((sum, entry) => sum + entry.seconds, 0);

/** Several usages as one: a feature's own turns and its parts'. */
export function mergeUsage(usages: ReadonlyArray<SpendUsage | undefined>): SpendUsage {
	const merged = noUsage();
	for (const usage of usages) {
		for (const line of usage?.models ?? []) {
			const into = lineFor(merged, line);
			into.turns += line.turns;
			into.unreported += line.unreported;
			into.agentUsd += line.agentUsd;
			addTokens(into, line);
			addTokens(into.priced, line.priced);
		}
		for (const entry of usage?.sandbox ?? []) addSandbox(merged, entry.size, entry.seconds);
		if (usage?.hosted) merged.hosted = addHosted(merged.hosted, usage.hosted);
	}
	return merged;
}

/**
 * The model turns `after` holds beyond `before`: what an item used since an earlier reading of its usage (the user's
 * day of model spend, user-items.ts). Sandbox time is left out.
 */
export function modelUsageSince(after: SpendUsage | undefined, before: SpendUsage | undefined): SpendUsage {
	const since = noUsage();
	const less = (a: UsageTokens, b: UsageTokens | undefined): UsageTokens => ({
		inputTokens: Math.max(0, a.inputTokens - (b?.inputTokens ?? 0)),
		cachedInputTokens: Math.max(0, a.cachedInputTokens - (b?.cachedInputTokens ?? 0)),
		outputTokens: Math.max(0, a.outputTokens - (b?.outputTokens ?? 0)),
	});
	for (const line of after?.models ?? []) {
		const old = before?.models.find(one => sameLine(one, line));
		if (line.turns <= (old?.turns ?? 0)) continue;
		since.models.push({
			harness: line.harness,
			model: line.model,
			provider: line.provider,
			payer: line.payer,
			turns: line.turns - (old?.turns ?? 0),
			unreported: Math.max(0, line.unreported - (old?.unreported ?? 0)),
			agentUsd: Math.max(0, line.agentUsd - (old?.agentUsd ?? 0)),
			...less(line, old),
			priced: less(line.priced, old?.priced),
		});
	}
	return since;
}

/** The catalog's price of a model, by its provider and id ("anthropic/claude-sonnet-4-5" or "claude-sonnet-4-5"). */
export function modelPrice(
	models: CostRates["models"],
	provider: ModelProvider | null,
	model: string,
): ModelPrice | null {
	if (!models || !provider) return null;
	const id = model.startsWith(provider + "/") ? model.slice(provider.length + 1) : model;
	return Object.hasOwn(models, `${provider}/${id}`) ? models[`${provider}/${id}`]! : null;
}

/** Tokens at a price. Cached input at the cached price where the catalog has one, otherwise as input. */
export function tokensUsd(tokens: UsageTokens, price: ModelPrice): number {
	const cached = Math.min(tokens.cachedInputTokens, tokens.inputTokens);
	return (
		((tokens.inputTokens - cached) * price.input +
			cached * (price.cacheRead ?? price.input) +
			tokens.outputTokens * price.output) /
		1_000_000
	);
}

export const PAID_BY_TOKEN: ReadonlySet<CostPayer> = new Set(["key", "machine-key"]);

/** One model and payer of an item, priced at API prices whoever paid. */
export interface CostLine extends Pick<ModelUse, "harness" | "model" | "provider" | "payer" | "turns"> {
	tokens: UsageTokens;
	/** Dollars: null where some of it could not be priced (`unknown`). */
	usd: number | null;
	/** Dollars of what could be priced, where some could not. */
	knownUsd: number;
	unknown: boolean;
}

/** Who carried some of an item's model turns: one plan or key of a provider, its turns and their dollars. */
export interface PayerCost {
	payer: CostPayer;
	provider: ModelProvider | null;
	turns: number;
	/** What a key paid, or what a plan's turns are worth at API prices; the known part where `unknown`. */
	usd: number;
	unknown: boolean;
}

export interface ItemCost {
	/** What the item added to the person's bills: model turns a key paid for, and extra hosted time. */
	extraUsd: number;
	/** All its model work at API prices, whoever paid: what its dollar budget counts. */
	workUsd: number;
	/** By who carried them, plans before keys. */
	payers: PayerCost[];
	/**
	 * Its hosted time: where billing split it, the hosted seconds the plan included and the extra ones with what they
	 * cost; otherwise (`billed` false) an estimate at the rate card, null where hosted time is not billed by time here.
	 */
	sandbox: {
		seconds: number;
		billed: boolean;
		includedSeconds: number;
		extraSeconds: number;
		extraUsd: number;
		estimateUsd: number | null;
		unknown: boolean;
	};
	/** Some part could not be priced: the figures are at least what they say. */
	unknown: boolean;
	lines: CostLine[];
}

export const onPlan = (payer: Pick<PayerCost, "payer">): boolean => !PAID_BY_TOKEN.has(payer.payer);

/** Prices what an item used at the given rates. */
export function itemCost(usage: SpendUsage | undefined, rates: CostRates): ItemCost {
	const lines: CostLine[] = [];
	const payers: PayerCost[] = [];
	for (const line of usage?.models ?? []) {
		const pricing = line.priced.inputTokens + line.priced.outputTokens > 0;
		const price = pricing ? modelPrice(rates.models, line.provider, line.model) : null;
		const knownUsd = line.agentUsd + (price ? tokensUsd(line.priced, price) : 0);
		const unknown = line.unreported > 0 || (pricing && !price);
		lines.push({
			harness: line.harness,
			model: line.model,
			provider: line.provider,
			payer: line.payer,
			turns: line.turns,
			tokens: {
				inputTokens: line.inputTokens,
				cachedInputTokens: line.cachedInputTokens,
				outputTokens: line.outputTokens,
			},
			usd: unknown ? null : knownUsd,
			knownUsd,
			unknown,
		});
		const payer = payers.find(one => one.payer === line.payer && one.provider === line.provider);
		if (payer) {
			payer.turns += line.turns;
			payer.usd += knownUsd;
			payer.unknown ||= unknown;
		} else payers.push({ payer: line.payer, provider: line.provider, turns: line.turns, usd: knownUsd, unknown });
	}
	payers.sort((a, b) => Number(onPlan(b)) - Number(onPlan(a)));
	const hosted = usage?.hosted;
	let estimateUsd: number | null = rates.sandbox === null ? null : 0;
	let sandboxUnknown = false;
	// Null rates: hosted time is not billed by the second here (a local Docker layer).
	if (!hosted && rates.sandbox !== null) {
		for (const entry of usage?.sandbox ?? []) {
			const perHour = rates.sandbox[entry.size];
			if (typeof perHour === "number") estimateUsd! += (entry.seconds / 3600) * perHour;
			else sandboxUnknown = true;
		}
	}
	const sandbox = {
		seconds: sandboxSeconds(usage),
		billed: !!hosted,
		includedSeconds: hosted?.includedSeconds ?? 0,
		extraSeconds: hosted?.extraSeconds ?? 0,
		extraUsd: hosted?.extraUsd ?? 0,
		estimateUsd: hosted ? null : estimateUsd,
		unknown: sandboxUnknown,
	};
	const keyUsd = payers.reduce((sum, payer) => (onPlan(payer) ? sum : sum + payer.usd), 0);
	return {
		extraUsd: keyUsd + sandbox.extraUsd,
		workUsd: payers.reduce((sum, payer) => sum + payer.usd, 0),
		payers,
		sandbox,
		unknown: lines.some(line => line.unknown) || sandboxUnknown,
		lines,
	};
}
