/**
 * Pay with at a turn's start (hosted, or on a machine), in the user's actor (pay-with.ts
 * `decidePayer` is the rule): which of the connected plan and the saved key pays for a turn of an agent a plan can
 * pay for, or why the turn waits. Hosted Windlass's ChatGPT models too: the plan pays, and the OpenAI key, where it
 * offers the same model, runs its `openai/` version for one turn while the plan is limited.
 *
 * The turn queue (user-items.ts `runQueue`) asks first for an item's turn, so an item waits for its plan's reset or for
 * room under the plan's parallel-turn cap before it is given a slot; the session asks again at the turn's start
 * (`internalTurnPayer`, from agent-session.ts `turnCredential`), and a person's prompt is answered there.
 *
 * The cap counts plan-paid turns by session: a session holds its plan's place from its grant or its prompt until it is
 * idle again (with a grace for the report that says it started), or until a turn's limit has passed.
 */

import { config } from "../config.js";
import {
	type CredentialRef,
	type HarnessId,
	type ItemFiler,
	type PlanProvider,
	type SessionSummary,
	type TurnOrigin,
} from "../contract.js";
import { providerStatuses, savedModelKeys } from "../credentials/keys.js";
import { usablePlan } from "../credentials/plans.js";
import {
	decidePayer,
	PAY_WITH_HARNESSES,
	type PayerDecision,
	type PayRule,
	payWithFor,
	planPays,
	readPayWith,
} from "../pay-with.js";
import {
	type CheckedProvider,
	hostedKeyMessage,
	hostedPayer,
	machineHarness,
	planProviders,
	windlassKeyModel,
} from "../sandbox/harnesses.js";
import type { ItemsCtx } from "./user-items.js";

/** How long a session's place stays held after it was taken, while its summary has not yet said it started. */
const GRACE_MS = 2 * 60_000;

type Held = { at: number; until: number };
/** Per user and plan: the sessions whose turns the plan pays for now. In memory: a restart frees every place. */
const held = new Map<string, Map<string, Held>>();

const heldKey = (uid: string, provider: PlanProvider) => `${uid}/${provider}`;

/** The turns `provider`'s plan pays for now, `except` that session's. Drops places whose session went idle. */
export function planRunning(c: ItemsCtx, provider: PlanProvider, except?: string, now = Date.now()): number {
	const places = held.get(heldKey(c.key[0]!, provider));
	if (!places) return 0;
	let running = 0;
	for (const [session, place] of places) {
		const status = c.vars.sessions.get(session)?.status;
		const gone = place.until <= now || (now - place.at > GRACE_MS && (status === undefined || status === "idle"));
		if (gone) places.delete(session);
		else if (session !== except) running += 1;
	}
	return running;
}

/** Holds a place under the plan's cap for this session's turn (taken again, it is refreshed). */
export function holdPlanTurn(c: ItemsCtx, provider: PlanProvider, session: string, now = Date.now()): void {
	const key = heldKey(c.key[0]!, provider);
	let places = held.get(key);
	if (!places) held.set(key, (places = new Map()));
	places.set(session, { at: now, until: now + config.turnTimeoutMs + GRACE_MS });
}

export const PAY_ONCE_TABLE =
	"CREATE TABLE IF NOT EXISTS pay_once (session TEXT PRIMARY KEY, harness TEXT NOT NULL, at INTEGER NOT NULL)";

/** What a turn's start reads once, so that the queue can decide for every request in one synchronous step. */
export interface PayerContext {
	choices: Awaited<ReturnType<typeof readPayWith>>;
	plans: Map<PlanProvider, Awaited<ReturnType<typeof usablePlan>>>;
	keys: CredentialRef[];
	/** The checked keys' models: whether a key offers Windlass's model in its `openai/` version. */
	offers: CheckedProvider[];
	/** Sessions whose next turn the person chose to pay with the key (`useKeyNow`). */
	keyOnce: Set<string>;
	at: number;
}

/** `onMachine`: for a turn on the user's machine, where the ChatGPT plan pays whatever `WLP_PLAN_USERS` says (`planAllowed`). */
export async function payerContext(c: ItemsCtx, onMachine = false): Promise<PayerContext> {
	const uid = c.key[0]!;
	const [choices, keys, offers, once, anthropic, openai] = await Promise.all([
		readPayWith(c.db),
		savedModelKeys(c.db),
		providerStatuses(c.db).then(statuses => statuses.filter(status => status.ok)),
		c.db.execute<{ session: string }>("SELECT session FROM pay_once"),
		usablePlan(c.db, uid, "anthropic", onMachine),
		usablePlan(c.db, uid, "openai", onMachine),
	]);
	return {
		choices,
		keys,
		offers,
		keyOnce: new Set(once.map(row => row.session)),
		plans: new Map([
			["anthropic", anthropic],
			["openai", openai],
		]),
		at: Date.now(),
	};
}

export interface PayerAnswer {
	decision: PayerDecision;
	/** What pays, pinned: the plan or the key, for `pay`; null otherwise. */
	ref: CredentialRef | null;
	/** The plan this agent's turns could pay with, also when it does not pay. */
	plan: PlanProvider | null;
	/** The rule as applied. */
	rule: PayRule;
	/** When the key pays in place of Windlass's ChatGPT plan: the model it runs, the key's version of the same model. */
	keyModel?: string;
	/**
	 * Whether the turn holds a place under the plan's parallel-turn cap: a plan agent's does. Windlass's ChatGPT turns
	 * never did, and neither count nor wait for it.
	 */
	capped: boolean;
}

/** The item filer of a session's item, when the item came from another surface (`ItemFiler`). */
function filerOf(c: ItemsCtx, session: SessionSummary): ItemFiler | undefined {
	const item = session.item ? c.vars.items.items.get(session.item.id) : undefined;
	return item?.origin?.filer;
}

/**
 * Whether Pay with decides this session's turns of `model`: hosted, of an agent a plan can pay for or of Windlass's
 * ChatGPT models (`planPays`); or on a machine (`onMachine`, from the session's turn), of a plan agent with no login of
 * its own there. Windlass on a machine keeps its own plan rule.
 */
export function paysWithRule(
	session: Pick<SessionSummary, "place" | "harness">,
	onMachine = false,
	model?: string,
): boolean {
	if (session.place.kind === "hosted") return planPays(session.harness, model);
	return onMachine && !!machineHarness(session.harness) && PAY_WITH_HARNESSES.includes(session.harness!);
}

/** The key that could pay for a turn of `model` instead of the plan, and the model it would run then. */
function keyFor(
	harness: HarnessId,
	model: string,
	context: PayerContext,
): { key: CredentialRef; model?: string } | null {
	if (!machineHarness(harness)) {
		// Windlass: the OpenAI key runs the same model in its `openai/` version, where the key offers it.
		const keyModel = windlassKeyModel(model, context.offers);
		const key = keyModel ? context.keys.find(ref => ref.provider === "openai") : undefined;
		return key && keyModel ? { key, model: keyModel } : null;
	}
	const keyPayer = hostedPayer(
		harness as Exclude<HarnessId, "windlass">,
		model,
		context.keys.map(ref => ({ provider: ref.provider, checkedAt: null })),
	);
	const key = keyPayer ? context.keys.find(ref => ref.provider === keyPayer.provider) : undefined;
	return key ? { key } : null;
}

/** Pay with for one turn of `session`, synchronously from `context`. */
export function payerOf(
	c: ItemsCtx,
	context: PayerContext,
	session: SessionSummary,
	model: string,
	keyOnce = false,
): PayerAnswer {
	const harness = session.harness ?? "windlass";
	const origin: TurnOrigin = session.item ? "item" : "interactive";
	const keyed = keyFor(harness, model, context);
	const key = keyed?.key ?? null;
	const capped = !!machineHarness(harness);
	const provider = planProviders(harness)[0] ?? null;
	const plan = provider ? (context.plans.get(provider) ?? null) : null;
	const rule = payWithFor(context.choices, harness, origin, key !== null);
	const decision = decidePayer({
		rule,
		origin,
		plan: plan && {
			provider: plan.provider,
			health: plan.health,
			limitedUntil: plan.limitedUntil,
			resetKnown: plan.resetKnown,
			running: capped ? planRunning(c, plan.provider, session.id, context.at) : 0,
		},
		hasKey: key !== null,
		cap: capped ? config.planParallelTurns : Number.POSITIVE_INFINITY,
		filer: filerOf(c, session),
		keyOnce: keyOnce || context.keyOnce.has(session.id),
		keyMessage: hostedKeyMessage(harness, model),
		at: context.at,
	});
	let ref: CredentialRef | null = null;
	if ("pay" in decision && decision.pay === "plan" && plan)
		ref = { provider: plan.provider, generation: plan.generation, plan: true };
	if ("pay" in decision && decision.pay === "key") ref = key;
	return {
		decision,
		ref,
		plan: provider,
		rule,
		...(ref && !ref.plan && keyed?.model && { keyModel: keyed.model }),
		capped,
	};
}

/** The session's model as its turns run it: "default" is its agent's default. */
export function sessionModel(session: SessionSummary, model?: string): string {
	const chosen = model ?? session.model;
	return chosen === "default" ? (session.harnessModels?.defaultModel ?? chosen) : chosen;
}

/**
 * Decides at a turn's start and, when the plan pays, holds the session's place under its cap. A key chosen once for an
 * item's next turn is used up here.
 */
export async function turnPayer(
	c: ItemsCtx,
	sessionId: string,
	model: string,
	keyOnce: boolean,
	onMachine = false,
): Promise<PayerAnswer | null> {
	const session = c.vars.sessions.get(sessionId);
	if (!session) return null;
	// Hosted, it decides for every agent: one no plan pays for pays with its key (`payWithFor`).
	const hostedAgent = session.place.kind === "hosted" && !!machineHarness(session.harness);
	if (!hostedAgent && !paysWithRule(session, onMachine, sessionModel(session, model))) return null;
	const context = await payerContext(c, onMachine);
	const answer = payerOf(c, context, session, sessionModel(session, model), keyOnce);
	if (answer.ref?.plan && answer.plan && answer.capped) holdPlanTurn(c, answer.plan, sessionId);
	if (answer.ref && !answer.ref.plan && context.keyOnce.has(sessionId))
		await c.db.execute("DELETE FROM pay_once WHERE session = ?", sessionId);
	const { decision } = answer;
	const said = "pay" in decision ? `pay=${decision.pay}` : Object.keys(decision)[0];
	console.log(
		`[wlp] paywith.turn uid=${c.key[0]} session=${sessionId} harness=${session.harness} rule=${answer.rule.payWith}/${answer.rule.whenLimited} ${said}`,
	);
	return answer;
}

/** The person chose the key for the next turn of the item's session (`useKeyNow`): refused when no key can pay. */
export async function useKeyOnce(c: ItemsCtx, sessionId: string): Promise<boolean> {
	const session = c.vars.sessions.get(sessionId);
	if (!session || !paysWithRule(session, false, sessionModel(session))) return false;
	const context = await payerContext(c);
	const answer = payerOf(c, context, session, sessionModel(session), true);
	if (!answer.ref || answer.ref.plan) return false;
	await c.db.execute(
		"INSERT OR REPLACE INTO pay_once (session, harness, at) VALUES (?, ?, ?)",
		sessionId,
		session.harness ?? "",
		Date.now(),
	);
	return true;
}
