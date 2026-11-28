/**
 * Pay with (the Connections page): for each agent that can pay with a plan, whether its hosted turns pay with the
 * plan, then the key; only the plan; or only the key, and what a turn does when the plan is limited. Kept in the
 * user's actor (`pay_with`). Browser-safe: the web reads the same rule (`payWithFor`) to say what will happen.
 */

import {
	type HarnessId,
	type ItemFiler,
	MACHINE_HARNESS_IDS,
	type PlanHealth,
	PLAN_NAMES,
	type PlanProvider,
	PAY_WITH,
	type PayWith,
	type PayWithChoice,
	type PayWithPatch,
	type TurnOrigin,
	WHEN_LIMITED,
	WHEN_LIMITED_DEFAULTS,
	type WhenLimited,
} from "./contract.js";
import type { DefaultsDb } from "./repository-defaults.js";
import { machineHarness, planProviders, windlassProvider } from "./sandbox/harnesses.js";

export const PAY_WITH_TABLE =
	"CREATE TABLE IF NOT EXISTS pay_with (harness TEXT PRIMARY KEY, pay_with TEXT NOT NULL, when_limited TEXT, updated_at INTEGER NOT NULL)";

/** The agents a plan can pay for, by their harness records (today Claude Code and Codex). */
export const PAY_WITH_HARNESSES: readonly HarnessId[] = MACHINE_HARNESS_IDS.filter(
	id => (machineHarness(id)?.planProviders?.length ?? 0) > 0,
);

export class PayWithProblem extends Error {}

const isPayWith = (value: unknown): value is PayWith => (PAY_WITH as readonly unknown[]).includes(value);
const isWhenLimited = (value: unknown): value is WhenLimited => (WHEN_LIMITED as readonly unknown[]).includes(value);

const defaultChoice = (harness: HarnessId): PayWithChoice => ({
	harness,
	payWith: "plan-then-key",
	whenLimited: null,
	updatedAt: null,
});

export function payWithPatchOf(raw: unknown): PayWithPatch {
	const input = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<Record<keyof PayWithPatch, unknown>>;
	const harness = PAY_WITH_HARNESSES.find(id => id === input.harness);
	if (!harness) throw new PayWithProblem("Choose an agent that can pay with a plan.");
	if (!isPayWith(input.payWith))
		throw new PayWithProblem("Choose what pays: the plan, the key, or the plan then the key.");
	const whenLimited = input.whenLimited ?? null;
	if (whenLimited !== null && !isWhenLimited(whenLimited))
		throw new PayWithProblem("Choose what happens when the plan is limited: wait, use the key, or ask.");
	return { harness, payWith: input.payWith, whenLimited };
}

type Row = { harness: string; pay_with: string; when_limited: string | null; updated_at: number };

/** One choice per plan agent, in `PAY_WITH_HARNESSES` order: the saved one, or the defaults (also for a row no longer valid). */
export async function readPayWith(db: DefaultsDb): Promise<PayWithChoice[]> {
	const rows = await db.execute<Row>("SELECT harness, pay_with, when_limited, updated_at FROM pay_with");
	return PAY_WITH_HARNESSES.map(harness => {
		const row = rows.find(one => one.harness === harness);
		if (!row || !isPayWith(row.pay_with) || (row.when_limited !== null && !isWhenLimited(row.when_limited)))
			return defaultChoice(harness);
		return { harness, payWith: row.pay_with, whenLimited: row.when_limited, updatedAt: row.updated_at };
	});
}

export async function savePayWith(db: DefaultsDb, patch: PayWithPatch, now = Date.now()): Promise<PayWithChoice[]> {
	await db.execute(
		"INSERT OR REPLACE INTO pay_with (harness, pay_with, when_limited, updated_at) VALUES (?, ?, ?, ?)",
		patch.harness,
		patch.payWith,
		patch.whenLimited,
		now,
	);
	return readPayWith(db);
}

/**
 * Whether a plan pays for a hosted turn of `harness` on `model`: a plan agent's always (its Pay with decides between
 * the plan and the key), Windlass's for its unqualified models, which run on the ChatGPT plan; its `openai/…` ones run
 * on the key, which the model picker chose.
 */
export function planPays(harness: HarnessId | undefined, model?: string): boolean {
	const id = harness ?? "windlass";
	if (PAY_WITH_HARNESSES.includes(id)) return true;
	return planProviders(id).length > 0 && !windlassProvider(model);
}

/**
 * Pay with as `decidePayer` applies it. `keyWhenLimited`: the key may pay for one turn while the plan is limited,
 * though the plan alone pays otherwise (Windlass: its model picker chose the plan, and the key runs the model's
 * `openai/` version only when the person or the item's banner asks for it).
 */
export interface PayRule {
	payWith: PayWith;
	whenLimited: WhenLimited;
	keyWhenLimited?: true;
}

/**
 * The rule a hosted turn of `harness` follows at its start (`decidePayer`): what pays, and what a limited plan does.
 * `hasKey`: whether the user has a saved key this agent can use (for Windlass, one that offers the model's
 * `openai/` version).
 */
export function payWithFor(
	choices: readonly PayWithChoice[],
	harness: HarnessId,
	origin: TurnOrigin,
	hasKey: boolean,
): PayRule {
	// Windlass has no Pay with choice: the plan pays its ChatGPT models, and when it is limited an item waits (its banner
	// offers the key) and a person is asked, as the defaults by origin are; without a key both only wait.
	if (!PAY_WITH_HARNESSES.includes(harness) && planProviders(harness).length > 0)
		return hasKey
			? { payWith: "plan", whenLimited: WHEN_LIMITED_DEFAULTS[origin], keyWhenLimited: true }
			: { payWith: "plan", whenLimited: "wait" };
	// No plan can pay for it, so only a key does; a key is never "limited" in this sense.
	if (!PAY_WITH_HARNESSES.includes(harness)) return { payWith: "key", whenLimited: "wait" };
	const choice = choices.find(one => one.harness === harness) ?? defaultChoice(harness);
	// Key only: the plan never pays, so its limit never matters. Plan only: the key is never used, nor offered.
	// Without a saved key there is nothing to switch to or ask about.
	if (choice.payWith !== "plan-then-key" || !hasKey) return { payWith: choice.payWith, whenLimited: "wait" };
	return { payWith: choice.payWith, whenLimited: choice.whenLimited ?? WHEN_LIMITED_DEFAULTS[origin] };
}

/** What a hosted turn's start knows of the plan that could pay for it. Null: none connected, usable, or allowed. */
export interface PlanNow {
	provider: PlanProvider;
	health: PlanHealth;
	limitedUntil: number | null;
	resetKnown: boolean;
	/** The turns it pays for now, this one not among them. */
	running: number;
}

export interface PayerInput {
	rule: PayRule;
	origin: TurnOrigin;
	plan: PlanNow | null;
	hasKey: boolean;
	/** The most turns a plan pays for at once. */
	cap: number;
	/** Who filed the item from another surface; absent for the owner's own (web, API, GitHub). */
	filer?: ItemFiler;
	/** The person chose the key for this turn (`useKeyNow`, or `payWith: "key"` on a prompt). */
	keyOnce?: boolean;
	/** The sentence when no key can pay (`hostedKeyMessage`). */
	keyMessage: string;
	at: number;
}

/**
 * What pays for a hosted turn, or why it does not start: `plan` or `key`; `wait` until the plan can pay again (an item
 * waits in the turn queue, `retryAt` null: it is tried again soon; a person's prompt is refused with `PLAN_LIMITED`);
 * `ask`, the person chooses between waiting and the key this time (`PLAN_ASK`); `refuse`, nothing can pay.
 */
export type PayerDecision =
	| { pay: "plan" }
	| { pay: "key" }
	| { wait: { sentence: string; retryAt: number | null; limited: boolean; keyNow: boolean } }
	| { ask: { sentence: string; retryAt: number | null } }
	| { refuse: string };

const clock = (at: number) => new Date(at).toISOString().slice(11, 16) + " UTC";

/** The rule applied: guardrails first (an unverified filer never pays with the owner's plan), then health and the cap. */
export function decidePayer(input: PayerInput): PayerDecision {
	const { rule, origin, plan, hasKey, filer, at } = input;
	if (input.keyOnce && hasKey) return { pay: "key" };
	const viaKey = (refusal: string): PayerDecision => (hasKey ? { pay: "key" } : { refuse: refusal });
	if (rule.payWith === "key") return viaKey(input.keyMessage);
	const name = plan ? PLAN_NAMES[plan.provider] : "plan";
	if (filer && filer.verified !== true)
		return viaKey(
			`This item was filed from ${filer.surface} by an account not linked to yours, so it can't run on your ${name}. Link the account, or add a key on the Connections page.`,
		);
	const orKey = rule.payWith === "plan-then-key";
	if (!plan)
		return orKey
			? viaKey(input.keyMessage)
			: { refuse: "Connect your plan on the Connections page to run this agent here." };
	if (plan.health === "invalid") {
		if (orKey && hasKey) return { pay: "key" };
		return {
			refuse: `Your ${name} stopped working: the provider refused it twice in a row. Reconnect it on the Connections page.`,
		};
	}
	const limited = plan.health === "limited" && (plan.limitedUntil ?? 0) > at;
	const busy = !limited && plan.running >= input.cap;
	if (!limited && !busy) return { pay: "plan" };
	if (rule.whenLimited === "key" && hasKey && orKey) return { pay: "key" };
	const retryAt = limited ? plan.limitedUntil : null;
	const sentence = limited
		? plan.resetKnown
			? `Your ${name} is limited until ${clock(plan.limitedUntil!)}.`
			: `Your ${name} reached its limit; it is tried again at ${clock(plan.limitedUntil!)}.`
		: `Your ${name} is already paying for ${plan.running} turns at once, the most it runs together.`;
	const keyNow = hasKey && (orKey || rule.keyWhenLimited === true);
	if (origin === "interactive") {
		if (rule.whenLimited === "ask" && keyNow)
			return { ask: { sentence: `${sentence} Wait, or use your key for this turn?`, retryAt } };
		const again = limited ? "Send the prompt again then." : "Send the prompt again when one of them finishes.";
		return { wait: { sentence: `${sentence} ${again}`, retryAt, limited, keyNow: false } };
	}
	return {
		wait: {
			sentence: `${sentence} This item starts by itself ${limited ? "then" : "when one of them finishes"}.`,
			retryAt,
			limited,
			keyNow,
		},
	};
}
