/** Pay with (server/src/pay-with.ts): its storage in the user's actor and the rule a hosted turn will follow. */
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import type { PayWithChoice } from "../server/src/contract.js";
import {
	PAY_WITH_HARNESSES,
	PAY_WITH_TABLE,
	PayWithProblem,
	payWithFor,
	payWithPatchOf,
	readPayWith,
	savePayWith,
} from "../server/src/pay-with.js";

function account() {
	const sql = new DatabaseSync(":memory:");
	sql.exec(PAY_WITH_TABLE);
	const db = {
		async execute<Row>(query: string, ...args: unknown[]) {
			return sql.prepare(query).all(...(args as SQLInputValue[])) as Row[];
		},
	};
	return { sql, db };
}

test("the plan agents come from the harness records", () => {
	assert.deepEqual([...PAY_WITH_HARNESSES], ["claude", "codex"]);
});

test("an account that saved nothing has the defaults", async () => {
	const { db } = account();
	assert.deepEqual(await readPayWith(db), [
		{ harness: "claude", payWith: "plan-then-key", whenLimited: null, updatedAt: null },
		{ harness: "codex", payWith: "plan-then-key", whenLimited: null, updatedAt: null },
	]);
});

test("a saved choice is read back, and saving again replaces it", async () => {
	const { db } = account();
	const saved = await savePayWith(db, { harness: "codex", payWith: "plan", whenLimited: "ask" }, 1000);
	assert.deepEqual(saved[1], { harness: "codex", payWith: "plan", whenLimited: "ask", updatedAt: 1000 });
	assert.equal(saved[0]?.updatedAt, null, "the other agent keeps its defaults");
	await savePayWith(db, { harness: "codex", payWith: "key", whenLimited: null }, 2000);
	assert.deepEqual((await readPayWith(db))[1], {
		harness: "codex",
		payWith: "key",
		whenLimited: null,
		updatedAt: 2000,
	});
});

test("input that names no plan agent or choice is refused", () => {
	assert.deepEqual(payWithPatchOf({ harness: "claude", payWith: "plan-then-key" }), {
		harness: "claude",
		payWith: "plan-then-key",
		whenLimited: null,
	});
	for (const raw of [
		null,
		{ harness: "opencode", payWith: "key", whenLimited: null },
		{ harness: "windlass", payWith: "key", whenLimited: null },
		{ harness: "claude", payWith: "both", whenLimited: null },
		{ harness: "claude", payWith: "plan", whenLimited: "never" },
	])
		assert.throws(() => payWithPatchOf(raw), PayWithProblem, JSON.stringify(raw));
});

test("a stored row that is no longer valid reads as the defaults", async () => {
	const { db, sql } = account();
	sql.exec("INSERT INTO pay_with VALUES ('claude', 'both', NULL, 5), ('codex', 'plan', 'never', 6)");
	for (const choice of await readPayWith(db)) assert.equal(choice.updatedAt, null);
});

test("payWithFor: what pays, and what a limited plan does", () => {
	const choice = (
		harness: "claude" | "codex",
		payWith: PayWithChoice["payWith"],
		whenLimited: PayWithChoice["whenLimited"],
	) => ({
		harness,
		payWith,
		whenLimited,
		updatedAt: 1,
	});
	const cases: Array<
		[string, PayWithChoice[], Parameters<typeof payWithFor>[1], "item" | "interactive", boolean, object]
	> = [
		["defaults: an item waits", [], "claude", "item", true, { payWith: "plan-then-key", whenLimited: "wait" }],
		["defaults: a session asks", [], "claude", "interactive", true, { payWith: "plan-then-key", whenLimited: "ask" }],
		["no key: always waits", [], "codex", "interactive", false, { payWith: "plan-then-key", whenLimited: "wait" }],
		[
			"a chosen rule beats the defaults",
			[choice("claude", "plan-then-key", "key")],
			"claude",
			"item",
			true,
			{ payWith: "plan-then-key", whenLimited: "key" },
		],
		[
			"no key beats a chosen rule",
			[choice("claude", "plan-then-key", "key")],
			"claude",
			"item",
			false,
			{ payWith: "plan-then-key", whenLimited: "wait" },
		],
		[
			"plan only never switches",
			[choice("codex", "plan", "ask")],
			"codex",
			"interactive",
			true,
			{ payWith: "plan", whenLimited: "wait" },
		],
		[
			"key only",
			[choice("codex", "key", "ask")],
			"codex",
			"interactive",
			true,
			{ payWith: "key", whenLimited: "wait" },
		],
		[
			"another agent's choice is not this one's",
			[choice("codex", "key", null)],
			"claude",
			"item",
			true,
			{ payWith: "plan-then-key", whenLimited: "wait" },
		],
		["an agent no plan pays for", [], "opencode", "interactive", true, { payWith: "key", whenLimited: "wait" }],
		[
			"Windlass: the plan pays; an item waits, and its banner may offer the key",
			[],
			"windlass",
			"item",
			true,
			{ payWith: "plan", whenLimited: "wait", keyWhenLimited: true },
		],
		[
			"Windlass: a session is asked",
			[],
			"windlass",
			"interactive",
			true,
			{ payWith: "plan", whenLimited: "ask", keyWhenLimited: true },
		],
		[
			"Windlass without a key offering the model: always waits",
			[],
			"windlass",
			"interactive",
			false,
			{ payWith: "plan", whenLimited: "wait" },
		],
		[
			"Windlass follows no plan agent's choice",
			[choice("codex", "key", "key")],
			"windlass",
			"item",
			true,
			{ payWith: "plan", whenLimited: "wait", keyWhenLimited: true },
		],
	];
	for (const [name, choices, harness, origin, hasKey, expected] of cases)
		assert.deepEqual(payWithFor(choices, harness, origin, hasKey), expected, name);
});

// Pay with applied at a turn's start (`decidePayer`), and the user actor's side of it (actors/user-payer.ts).
const { decidePayer } = await import("../server/src/pay-with.js");
type PayerInput = import("../server/src/pay-with.js").PayerInput;

const AT = Date.UTC(2026, 10, 27, 13);
const planNow = (health: "ok" | "limited" | "invalid", running = 0) => ({
	provider: "anthropic" as const,
	health,
	limitedUntil: health === "limited" ? AT + 3600_000 : null,
	resetKnown: true,
	running,
});
const input = (patch: Partial<PayerInput>): PayerInput => ({
	rule: { payWith: "plan-then-key", whenLimited: "wait" },
	origin: "item",
	plan: planNow("ok"),
	hasKey: true,
	cap: 3,
	keyMessage: "Add an Anthropic key on the Connections page to run Claude Code here.",
	at: AT,
	...patch,
});
const kind = (decision: ReturnType<typeof decidePayer>) =>
	"pay" in decision ? decision.pay : Object.keys(decision)[0];

test("only the real Claude Code takes a Claude plan, and only Codex the ChatGPT plan among the agents a plan pays for", async () => {
	const { planProviders } = await import("../server/src/sandbox/harnesses.js");
	const { HARNESS_IDS } = await import("../server/src/contract.js");
	assert.deepEqual(
		HARNESS_IDS.filter(id => planProviders(id).includes("anthropic")),
		["claude"],
		"no SDK harness or Windlass ever runs on a Claude plan token",
	);
	assert.deepEqual(
		[...PAY_WITH_HARNESSES].map(id => planProviders(id)),
		[["anthropic"], ["openai"]],
	);
});

test("Pay with applied: each rule against a usable or limited plan, for an item and a session, with and without a key", () => {
	type Case = [
		PayWithChoice["payWith"],
		"wait" | "key" | "ask",
		"ok" | "limited",
		"item" | "interactive",
		boolean,
		string,
	];
	const cases: Case[] = [
		// plan first, then the key
		["plan-then-key", "wait", "ok", "item", true, "plan"],
		["plan-then-key", "wait", "ok", "interactive", false, "plan"],
		["plan-then-key", "wait", "limited", "item", true, "wait"],
		["plan-then-key", "key", "limited", "item", true, "key"],
		["plan-then-key", "key", "limited", "interactive", true, "key"],
		["plan-then-key", "ask", "limited", "interactive", true, "ask"],
		["plan-then-key", "ask", "limited", "item", true, "wait"],
		["plan-then-key", "wait", "limited", "interactive", true, "wait"],
		// plan only: never the key
		["plan", "wait", "ok", "item", true, "plan"],
		["plan", "wait", "limited", "item", true, "wait"],
		["plan", "wait", "limited", "interactive", true, "wait"],
		// key only: never the plan
		["key", "wait", "ok", "item", true, "key"],
		["key", "wait", "limited", "interactive", true, "key"],
		["key", "wait", "ok", "item", false, "refuse"],
	];
	for (const [payWith, whenLimited, health, origin, hasKey, expected] of cases) {
		// As payWithFor gives it: without a key, or but the plan, a limited plan only waits.
		const rule = { payWith, whenLimited: payWith !== "plan-then-key" || !hasKey ? ("wait" as const) : whenLimited };
		const decision = decidePayer(input({ rule, origin, hasKey, plan: planNow(health) }));
		assert.equal(kind(decision), expected, `${payWith}/${whenLimited} ${health} ${origin} key=${hasKey}`);
	}
	// No key saved: always wait, whatever the origin.
	const noKey = decidePayer(input({ origin: "interactive", hasKey: false, plan: planNow("limited") }));
	assert.equal(kind(noKey), "wait");
	const wait = decidePayer(input({ plan: planNow("limited") }));
	assert.ok("wait" in wait);
	assert.equal(wait.wait.sentence, "Your Claude plan is limited until 14:00 UTC. This item starts by itself then.");
	assert.deepEqual([wait.wait.retryAt, wait.wait.limited, wait.wait.keyNow], [AT + 3600_000, true, true]);
	const ask = decidePayer(
		input({ origin: "interactive", rule: { payWith: "plan-then-key", whenLimited: "ask" }, plan: planNow("limited") }),
	);
	assert.ok("ask" in ask && /Wait, or use your key for this turn\?$/.test(ask.ask.sentence));
	// The person chose the key for this turn.
	assert.equal(kind(decidePayer(input({ plan: planNow("limited"), keyOnce: true }))), "key");
	assert.equal(kind(decidePayer(input({ plan: planNow("limited"), keyOnce: true, hasKey: false }))), "wait");
});

test("Pay with: a broken or missing plan falls back to the key only where the rule allows", () => {
	assert.equal(kind(decidePayer(input({ plan: planNow("invalid") }))), "key");
	const reconnect = decidePayer(input({ plan: planNow("invalid"), hasKey: false }));
	assert.ok("refuse" in reconnect && /Reconnect it on the Connections page/.test(reconnect.refuse));
	assert.equal(
		kind(decidePayer(input({ plan: planNow("invalid"), rule: { payWith: "plan", whenLimited: "wait" } }))),
		"refuse",
	);
	assert.equal(kind(decidePayer(input({ plan: null }))), "key");
	assert.equal(kind(decidePayer(input({ plan: null, hasKey: false }))), "refuse");
	assert.equal(kind(decidePayer(input({ plan: null, rule: { payWith: "plan", whenLimited: "wait" } }))), "refuse");
	// A limit whose time has passed is tried again.
	assert.equal(kind(decidePayer(input({ plan: planNow("limited"), at: AT + 3600_000 }))), "plan");
});

test("Pay with: past the plan's parallel-turn cap a turn waits like at a limit, with its reason", () => {
	assert.equal(kind(decidePayer(input({ plan: planNow("ok", 2) }))), "plan");
	const busy = decidePayer(input({ plan: planNow("ok", 3), rule: { payWith: "plan", whenLimited: "wait" } }));
	assert.ok("wait" in busy);
	assert.equal(busy.wait.retryAt, null, "tried again soon, not at a reset");
	assert.equal(busy.wait.limited, false);
	assert.match(busy.wait.sentence, /already paying for 3 turns at once/);
	assert.equal(
		kind(decidePayer(input({ plan: planNow("ok", 3), rule: { payWith: "plan-then-key", whenLimited: "key" } }))),
		"key",
	);
	assert.equal(
		kind(
			decidePayer(
				input({
					plan: planNow("ok", 5),
					origin: "interactive",
					rule: { payWith: "plan-then-key", whenLimited: "ask" },
				}),
			),
		),
		"ask",
	);
});

test("Pay with: an item filed by an unverified account never pays with the owner's plan", () => {
	const stranger = { surface: "Slack", externalUserId: "U123", verified: false };
	assert.equal(kind(decidePayer(input({ filer: stranger }))), "key");
	const refused = decidePayer(input({ filer: stranger, hasKey: false }));
	assert.ok("refuse" in refused && /filed from Slack by an account not linked to yours/.test(refused.refuse));
	assert.equal(
		kind(decidePayer(input({ filer: stranger, rule: { payWith: "plan", whenLimited: "wait" }, hasKey: false }))),
		"refuse",
	);
	assert.equal(kind(decidePayer(input({ filer: { ...stranger, verified: true } }))), "plan");
	assert.equal(kind(decidePayer(input({}))), "plan", "no filer: the owner's own item");
});

test("the user actor counts a plan's turns by session for its cap, and a key chosen once pays the item's next turn", async () => {
	process.env.WLP_PLAN_USERS = "*";
	process.env.WLP_PLAN_PARALLEL_TURNS = "2";
	const { CREDENTIAL_TABLES } = await import("../server/src/credentials/index.js");
	const payer = await import("../server/src/actors/user-payer.js");
	const { sql, db } = account();
	for (const table of [...CREDENTIAL_TABLES, payer.PAY_ONCE_TABLE]) sql.exec(table);
	sql.exec(
		"INSERT INTO model_plan (provider, sealed, generation, account, added_at, checked_at, check_ok) VALUES ('anthropic', 'x', 'p1', NULL, 1, 1, 1)",
	);
	sql.exec(
		"INSERT INTO model_provider (provider, sealed, generation, last4, added_at, checked_at, check_ok) VALUES ('anthropic', 'x', 'k1', 'abcd', 1, 1, 1)",
	);
	const session = (id: string, item?: string) => ({
		id,
		harness: "claude" as const,
		model: "sonnet",
		place: { kind: "hosted" as const },
		status: "idle",
		...(item && { item: { id: item } }),
	});
	const sessions = new Map(["s1", "s2", "s3", "s4"].map(id => [id, session(id, id === "s4" ? "i4" : undefined)]));
	const c = {
		key: ["u_payer"],
		db,
		vars: {
			sessions,
			items: { items: new Map([["i4", { origin: null, sessionId: "s4" }]]) },
		},
	} as unknown as Parameters<typeof payer.payerOf>[0];
	const now = Date.now();
	payer.holdPlanTurn(c, "anthropic", "s1", now);
	payer.holdPlanTurn(c, "anthropic", "s2", now);
	assert.equal(payer.planRunning(c, "anthropic", "s3", now), 2);
	const context = await payer.payerContext(c);
	const third = payer.payerOf(c, context, sessions.get("s3") as never, "sonnet");
	assert.equal(kind(third.decision), "ask", "a person's third turn on the plan is asked about (the key may pay)");
	assert.equal(kind(payer.payerOf(c, context, sessions.get("s4") as never, "sonnet").decision), "wait");
	assert.deepEqual(payer.payerOf(c, context, sessions.get("s1") as never, "sonnet").ref, {
		provider: "anthropic",
		generation: "p1",
		plan: true,
	});
	// An idle session past the grace gives its place back.
	assert.equal(payer.planRunning(c, "anthropic", "s3", now + 3 * 60_000), 0);
	// "Use my key now" for the item: its next turn pays with the key, once.
	assert.ok(await payer.useKeyOnce(c, "s4"));
	payer.holdPlanTurn(c, "anthropic", "s1");
	payer.holdPlanTurn(c, "anthropic", "s2");
	const once = await payer.turnPayer(c, "s4", "sonnet", false);
	assert.deepEqual({ ...once?.ref }, { provider: "anthropic", generation: "k1" });
	assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM pay_once").get()?.n, 0, "used up");
	assert.equal(kind((await payer.turnPayer(c, "s4", "sonnet", false))!.decision), "wait");
	// Hosted OpenCode, which no plan pays for: its provider's key pays, and without one the turn is refused.
	sessions.set("s5", { ...session("s5"), harness: "opencode" } as never);
	const keyed = await payer.turnPayer(c, "s5", "anthropic/claude-haiku-5-5", false);
	assert.deepEqual({ ...keyed?.ref }, { provider: "anthropic", generation: "k1" });
	const unpaid = (await payer.turnPayer(c, "s5", "google/gemini", false))!.decision;
	assert.ok("refuse" in unpaid && /Add a Google key/.test(unpaid.refuse));
});

test("on a machine Pay with decides a plan agent's turn as hosted; only Claude Code's login kept on the machine wins", async () => {
	const payer = await import("../server/src/actors/user-payer.js");
	const { machinePaysWith } = await import("../server/src/actors/agent-session.js");
	const onMachine = { harness: "claude" as const, place: { kind: "machine" as const, machineId: "desk" } };
	assert.equal(payer.paysWithRule(onMachine, true), true);
	assert.equal(payer.paysWithRule({ ...onMachine, harness: "opencode" }, true), false, "no plan pays for OpenCode");
	assert.equal(payer.paysWithRule({ harness: "claude", place: { kind: "hosted" } }), true);
	// Claude Code's own login kept on the machine (`windlass-runner login claude`) wins there.
	assert.equal(machinePaysWith("claude", { signIn: "token" }), false);
	assert.equal(machinePaysWith("claude", { signIn: "none" }), true);
	assert.equal(machinePaysWith("claude", { signIn: "unknown" }), true);
	// The machine's listing says the same, even with a Claude plan connected and a key saved: no `paysWith` while the
	// login is kept (`connect claude --this-machine`), and Pay with again once it is removed ("Switch back to your plan").
	const { listedHarness } = await import("../server/src/sandbox/harnesses.js");
	const kept = listedHarness({ id: "claude", signIn: "token", keyRelay: true } as const, ["anthropic"], ["anthropic"]);
	assert.equal(kept.paysWith, undefined);
	assert.equal(kept.method, "subscription");
	const removed = listedHarness(
		{ id: "claude", signIn: "none", keyRelay: true } as const,
		["anthropic"],
		["anthropic"],
	);
	assert.equal(removed.paysWith, true);
	// Codex keeps no login on a machine: Pay with always decides.
	assert.equal(machinePaysWith("codex", { signIn: "none" }), true);
	assert.equal(machinePaysWith("codex", undefined), true);
	assert.equal(machinePaysWith("opencode", { signIn: "none" }), false, "OpenCode signs in on the machine");
});

test("on a machine the ChatGPT plan can pay with plans off for the account; a Claude plan cannot", async () => {
	process.env.WLP_PLAN_USERS = "someone-else";
	const { CREDENTIAL_TABLES } = await import("../server/src/credentials/index.js");
	const { usablePlan, planAllowed } = await import("../server/src/credentials/plans.js");
	const { sql, db } = account();
	for (const table of CREDENTIAL_TABLES) sql.exec(table);
	for (const provider of ["anthropic", "openai"])
		sql.exec(
			`INSERT INTO model_plan (provider, sealed, generation, account, added_at, checked_at, check_ok) VALUES ('${provider}', 'x', 'g-${provider}', NULL, 1, 1, 1)`,
		);
	const { config } = await import("../server/src/config.js");
	const before = config.plans;
	(config as { plans: unknown }).plans = new Set(["someone-else"]);
	try {
		assert.equal(planAllowed("u_off", "openai"), false);
		assert.equal(planAllowed("u_off", "openai", true), true);
		assert.equal(planAllowed("u_off", "anthropic", true), false);
		assert.equal(await usablePlan(db, "u_off", "openai"), null);
		assert.equal((await usablePlan(db, "u_off", "openai", true))?.generation, "g-openai");
		assert.equal(await usablePlan(db, "u_off", "anthropic", true), null);
	} finally {
		(config as { plans: unknown }).plans = before;
	}
});

test("Windlass on a limited ChatGPT plan: an item waits (the key offered), a session asks, and without a key both wait", () => {
	const chatgpt = { ...planNow("limited"), provider: "openai" as const };
	type Case = ["item" | "interactive", boolean, "ok" | "limited", string, boolean?];
	const cases: Case[] = [
		["item", true, "ok", "plan"],
		["interactive", true, "ok", "plan"],
		["item", true, "limited", "wait", true],
		["item", false, "limited", "wait", false],
		["interactive", true, "limited", "ask"],
		["interactive", false, "limited", "wait", false],
	];
	for (const [origin, hasKey, health, expected, keyNow] of cases) {
		const rule = payWithFor([], "windlass", origin, hasKey);
		const decision = decidePayer(
			input({ rule, origin, hasKey, plan: health === "ok" ? { ...chatgpt, ...planNow("ok") } : chatgpt }),
		);
		const name = `${origin} key=${hasKey} ${health}`;
		assert.equal(kind(decision), expected, name);
		if (keyNow !== undefined) assert.ok("wait" in decision && decision.wait.keyNow === keyNow, name);
	}
	const ask = decidePayer(
		input({ rule: payWithFor([], "windlass", "interactive", true), origin: "interactive", plan: chatgpt }),
	);
	assert.ok("ask" in ask);
	assert.equal(ask.ask.sentence, "Your ChatGPT plan is limited until 14:00 UTC. Wait, or use your key for this turn?");
	// "Use my key": this turn only; never without a key that offers the model.
	const rule = payWithFor([], "windlass", "interactive", true);
	assert.equal(kind(decidePayer(input({ rule, origin: "interactive", plan: chatgpt, keyOnce: true }))), "key");
	// The plan alone pays otherwise: a missing or broken plan never falls back to the key the picker did not choose.
	assert.equal(kind(decidePayer(input({ rule, plan: { ...chatgpt, health: "invalid" } }))), "refuse");
	assert.equal(kind(decidePayer(input({ rule, plan: null }))), "refuse");
});

test("hosted Windlass in the user actor: its ChatGPT models follow Pay with, and the key runs the openai/ model for one turn", async () => {
	process.env.WLP_PLAN_USERS = "*";
	const { CREDENTIAL_TABLES } = await import("../server/src/credentials/index.js");
	const payer = await import("../server/src/actors/user-payer.js");
	const { config } = await import("../server/src/config.js");
	const plans = config.plans;
	(config as { plans: unknown }).plans = "all";
	const { sql, db } = account();
	for (const table of [...CREDENTIAL_TABLES, payer.PAY_ONCE_TABLE]) sql.exec(table);
	const until = Date.now() + 3600_000;
	sql
		.prepare(
			"INSERT INTO model_plan (provider, sealed, generation, account, added_at, checked_at, check_ok, health) VALUES ('openai', 'x', 'p1', NULL, 1, 1, 1, ?)",
		)
		.run(
			JSON.stringify({
				health: "limited",
				limitedUntil: until,
				resetKnown: true,
				healthAt: Date.now(),
				backoff: 0,
				authFailures: 0,
				windows: [],
			}),
		);
	const session = (id: string, model: string, item?: string) => ({
		id,
		harness: "windlass" as const,
		model,
		place: { kind: "hosted" as const },
		status: "idle",
		...(item && { item: { id: item } }),
	});
	const sessions = new Map([
		["person", session("person", "gpt-5")],
		["item", session("item", "gpt-5", "i1")],
		["keyed", session("keyed", "openai/gpt-5")],
	]);
	const c = {
		key: ["u_windlass"],
		db,
		vars: { sessions, items: { items: new Map([["i1", { origin: null, sessionId: "item" }]]) } },
	} as unknown as Parameters<typeof payer.payerOf>[0];
	try {
		assert.equal(payer.paysWithRule(sessions.get("person")!, false, "gpt-5"), true);
		assert.equal(payer.paysWithRule(sessions.get("keyed")!, false, "openai/gpt-5"), false, "the picker chose the key");
		assert.equal(
			payer.paysWithRule({ harness: "windlass", place: { kind: "machine", machineId: "desk" } }, true, "gpt-5"),
			false,
			"Windlass on a machine keeps its own plan rule",
		);
		// No OpenAI key: both wait.
		let context = await payer.payerContext(c);
		assert.equal(kind(payer.payerOf(c, context, sessions.get("person") as never, "gpt-5").decision), "wait");
		const waiting = payer.payerOf(c, context, sessions.get("item") as never, "gpt-5");
		assert.ok("wait" in waiting.decision && !waiting.decision.wait.keyNow && waiting.plan === "openai");
		// An OpenAI key that does not offer the model is no key here.
		sql.exec(
			`INSERT INTO model_provider (provider, sealed, generation, last4, added_at, checked_at, check_ok, models) VALUES ('openai', 'x', 'k1', 'abcd', 1, 1, 1, '["gpt-4.1"]')`,
		);
		context = await payer.payerContext(c);
		assert.equal(kind(payer.payerOf(c, context, sessions.get("person") as never, "gpt-5").decision), "wait");
		sql.exec(`UPDATE model_provider SET models = '["gpt-4.1","gpt-5"]'`);
		context = await payer.payerContext(c);
		assert.equal(kind(payer.payerOf(c, context, sessions.get("person") as never, "gpt-5").decision), "ask");
		const item = payer.payerOf(c, context, sessions.get("item") as never, "gpt-5");
		assert.ok("wait" in item.decision && item.decision.wait.keyNow, "the item's banner offers the key");
		// "Use my key" for the person's turn: the key's version of the same model, this turn.
		const once = await payer.turnPayer(c, "person", "gpt-5", true);
		assert.deepEqual({ ...once?.ref }, { provider: "openai", generation: "k1" });
		assert.equal(once?.keyModel, "openai/gpt-5");
		assert.equal(
			kind((await payer.turnPayer(c, "person", "gpt-5", false))!.decision),
			"ask",
			"the next turn asks again",
		);
		// "Use my key now" on the item's banner: its next turn, once.
		assert.ok(await payer.useKeyOnce(c, "item"));
		const itemOnce = await payer.turnPayer(c, "item", "gpt-5", false);
		assert.equal(itemOnce?.keyModel, "openai/gpt-5");
		assert.equal(kind((await payer.turnPayer(c, "item", "gpt-5", false))!.decision), "wait");
		// The plan healthy again: it pays, pinned, with no key model. Windlass's turns never held a place under the
		// plan's parallel-turn cap: Codex's three do not hold it back, and it takes none of theirs.
		sql.exec("UPDATE model_plan SET health = NULL");
		for (const codex of ["x1", "x2", "x3"]) {
			sessions.set(codex, { ...session(codex, "gpt-5"), harness: "codex" as never, status: "working" });
			payer.holdPlanTurn(c, "openai", codex);
		}
		const plan = await payer.turnPayer(c, "person", "gpt-5", false);
		assert.deepEqual({ ...plan?.ref }, { provider: "openai", generation: "p1", plan: true });
		assert.equal(plan?.keyModel, undefined);
		assert.equal(payer.planRunning(c, "openai"), 3, "the Windlass turn took no place");
	} finally {
		(config as { plans: unknown }).plans = plans;
	}
});
