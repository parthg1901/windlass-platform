/** Run from server with npx tsx --test src/slack/blocks.test.ts. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChoiceId, FeaturePlan, ItemQuestion } from "../contract.js";
import { CHOICES, choice } from "../factory/answered.js";
import { cut, LIMITS, planPost, questionPost, resolvedMessage, slackChoices, type Block } from "./blocks.js";
import { resolvedLine } from "./thread.js";

const url = "https://windlass.test/items/i_1";
const question = (over: Partial<ItemQuestion> = {}): ItemQuestion => ({
	id: "q1",
	kind: "turn_refused",
	text: "The provider refused the turn.",
	askedAt: 1,
	recommended: "again",
	choices: [
		{ id: "again", label: "Try again" },
		{ id: "give_up", label: "Give up" },
		{ id: "reply", label: "Reply" },
	],
	...over,
});
const plan = (over: Partial<FeaturePlan> = {}): FeaturePlan => ({
	version: 2,
	status: "proposed",
	budget: { tokens: 900_000, hostedSeconds: 3600 },
	compare: { singleBudget: { tokens: 400_000, hostedSeconds: 1800 } },
	spec: { goal: "Ship <!channel> search", requirements: [], outOfScope: [], acceptance: ["pnpm test passes"] },
	questions: [
		{ id: "p1", text: "Keep the old index?", recommended: "No" },
		{ id: "p2", text: "Answered", answer: "yes" },
	],
	subtasks: Array.from({ length: 12 }, (_, n) => ({
		key: `s${n}`,
		title: `Part ${n}`,
		brief: "",
		acceptance: [],
		dependsOn: [],
		owns: [],
		budget: { tokens: 1000 },
	})),
	singleSuggested: null,
	...over,
});
const elements = (blocks: Block[] | undefined) => (blocks?.find(b => b.type === "actions")?.elements ?? []) as Block[];
const texts = (blocks: Block[] | undefined) => JSON.stringify(blocks ?? []);

test("cut keeps the limit and never splits a surrogate pair", () => {
	assert.equal(cut("short", 10), "short");
	const long = cut("a".repeat(5000), LIMITS.section);
	assert.equal(long.length, LIMITS.section);
	assert.ok(long.endsWith("…"));
	assert.equal(cut("ab😀cd", 4), "ab…");
});

test("plan post summarises the plan, cuts long lists and offers Approve, Request changes and Open", () => {
	const ask = question({
		id: "plan-q",
		kind: "plan_approval",
		recommended: "approve",
		choices: [
			{ id: "approve", label: "Approve" },
			{ id: "revise", label: "Revise" },
			{ id: "give_up", label: "Give up" },
		],
	});
	const post = planPost("i_1", ask, plan(), url);
	const full = texts(post.full!.blocks);
	assert.match(full, /Ship <!channel> search/);
	assert.ok(
		post.full!.blocks!.every(
			b =>
				b.type !== "section" ||
				(b.text as { type: string }).type === "plain_text" ||
				!String((b.text as { text: string }).text).includes("<!"),
		),
		"builder text is plain_text only",
	);
	assert.match(full, /Part 9 \(1,000 tokens\)/);
	assert.doesNotMatch(full, /Part 10/);
	assert.match(full, /and 2 more/);
	assert.match(full, /Keep the old index\? \(recommended: No\)/);
	assert.doesNotMatch(full, /Answered/);
	assert.match(full, /900,000 tokens/);
	assert.match(full, /Full plan/);
	// Approval waits for the open question.
	assert.deepEqual(
		elements(post.full!.blocks).map(b => b.action_id),
		["revise", "open"],
	);
	const ready = planPost("i_1", ask, plan({ questions: [{ id: "p2", text: "Answered", answer: "yes" }] }), url);
	const buttons = elements(ready.full!.blocks);
	assert.deepEqual(
		buttons.map(b => b.action_id),
		["approve", "revise", "open"],
	);
	assert.equal(buttons[0]!.style, "primary");
	assert.deepEqual(JSON.parse(String(buttons[0]!.value)), { i: "i_1", q: "plan-q", v: 2, c: "approve" });
	assert.doesNotMatch(post.brief.text, /Ship/);
	assert.doesNotMatch(texts(post.brief.blocks), /Ship/);
	assert.deepEqual(
		elements(ready.brief.blocks).map(b => b.action_id),
		["approve", "revise", "open"],
	);
	assert.ok(post.full!.blocks!.length <= 50);
	for (const block of post.full!.blocks!) {
		const text = (block.text as { text?: string } | undefined)?.text;
		if (text) assert.ok(text.length <= LIMITS.section);
	}
});

test("plan post leaves Approve to Windlass when a part works without asking", () => {
	const ask = question({
		kind: "plan_approval",
		choices: [
			{ id: "approve", label: "Approve" },
			{ id: "revise", label: "Revise" },
		],
	});
	const unattended = plan({
		subtasks: [
			{
				key: "s",
				title: "Run",
				brief: "",
				acceptance: [],
				dependsOn: [],
				owns: [],
				budget: { tokens: 1 },
				agent: { harness: "claude" },
			},
		],
	});
	assert.deepEqual(
		slackChoices(ask, unattended).map(c => c.id),
		["revise"],
	);
	const post = planPost("i_1", ask, unattended, url);
	assert.deepEqual(
		elements(post.full!.blocks).map(b => b.action_id),
		["revise", "open"],
	);
	assert.match(texts(post.full!.blocks), /works without asking/);
});

test("question post offers each pressable choice and marks the recommended one", () => {
	const post = questionPost("i_1", question(), url);
	const buttons = elements(post.full!.blocks);
	assert.deepEqual(
		buttons.map(b => b.action_id),
		["choice:again", "choice:give_up", "open"],
	);
	assert.equal(buttons[0]!.style, "primary");
	assert.equal(buttons[1]!.style, undefined);
	assert.match(texts(post.full!.blocks), /The provider refused the turn/);
	assert.doesNotMatch(texts(post.brief.blocks), /refused/);
	assert.deepEqual(
		elements(post.brief.blocks).map(b => b.action_id),
		["choice:again", "choice:give_up", "open"],
	);
});

test("builder text, check output and secret requests never reach a post", () => {
	const asked = question({
		kind: "agent_ask",
		asked: { text: "SECRET-BUILDER-TEXT", options: ["BUILDER-OPTION"] },
		check: { name: "c", command: "make", exitCode: 1, kind: "not_found", line: "CHECK-LINE", excerpt: "CHECK-EXCERPT" },
	});
	const post = questionPost("i_1", asked, url);
	for (const message of [post.brief, post.full!]) {
		const raw = JSON.stringify(message);
		for (const hidden of ["SECRET-BUILDER-TEXT", "BUILDER-OPTION", "CHECK-LINE", "CHECK-EXCERPT"])
			assert.ok(!raw.includes(hidden), hidden);
		assert.deepEqual(elements(message.blocks), []);
	}
	assert.match(JSON.stringify(post.full), /Open in Windlass/);
	const secret = questionPost(
		"i_1",
		question({ kind: "secret_needed", secret: { name: "TOKEN", why: "SECRET-WHY" }, text: "Needs TOKEN" }),
		url,
	);
	assert.deepEqual(secret, { brief: { text: `Question ready: ${url}` } });
});

test("resolution lines say who answered and where, without buttons", () => {
	const q = question();
	assert.equal(
		resolvedLine(q, { kind: "answer", question: "q1", choice: "give_up", by: "person:u" } as never),
		"Answered on the web: Give up",
	);
	assert.equal(
		resolvedLine(q, { kind: "answer", question: "q1", choice: "again", by: "person:u" } as never, "U1"),
		"Answered by <@U1> in Slack: Try again",
	);
	assert.equal(
		resolvedLine(q, { kind: "approve_plan", version: 1, by: "person:u" } as never, "U1"),
		"Approved by <@U1> in Slack",
	);
	assert.equal(resolvedLine(q, { kind: "approve_plan", version: 1, by: "person:u" } as never), "Approved on the web");
	assert.equal(resolvedLine(q, { kind: "cancel", by: "person:u" } as never), "This question is no longer open.");
	assert.equal(resolvedLine(q, { kind: "turn_ended" } as never), "This question is no longer open.");
	const odd = question({ choices: [{ id: "give_up", label: "Stop <now> & drop" }] });
	const line = resolvedLine(odd, { kind: "answer", question: "q1", choice: "give_up", by: "person:u" } as never, "U1");
	assert.equal(line, "Answered by <@U1> in Slack: Stop &lt;now&gt; &amp; drop");
	const message = resolvedMessage(line, url);
	assert.match(JSON.stringify(message.blocks), /<@U1>.*&lt;now&gt;/);
	assert.deepEqual(elements(message.blocks), []);
});

const singleAsk = (over: Partial<ItemQuestion> = {}) =>
	question({
		id: "single-q",
		kind: "single_suggested",
		text: "Automatic approval requires a plan based on trusted inputs.\nOne small docs edit to CONTRIBUTING.md.",
		recommended: "run_single",
		choices: [choice("run_single"), choice("orchestrate_anyway")],
		...over,
	});
const singlePlan = (questions: FeaturePlan["questions"]) =>
	plan({ subtasks: [], singleSuggested: "One small docs edit to CONTRIBUTING.md.", questions });
const labelled = (blocks: Block[] | undefined) =>
	elements(blocks).map(b => [b.action_id, (b.text as { text: string }).text, b.style ?? null]);

test("a one-implementer plan is posted as a plan, listing its open questions and holding back its approval", () => {
	const ask = singleAsk();
	const open = singlePlan([
		{ id: "p1", text: "Keep the old index?", recommended: "No" },
		{ id: "p2", text: "Answered", answer: "yes" },
	]);
	assert.deepEqual(
		slackChoices(ask, open).map(c => c.id),
		["orchestrate_anyway"],
	);
	const post = planPost("i_1", ask, open, url);
	const full = texts(post.full!.blocks);
	assert.match(full, /One implementer suggested \(version 2\)/);
	assert.match(full, /Goal: Ship <!channel> search/);
	assert.match(full, /One small docs edit to CONTRIBUTING\.md/);
	assert.match(full, /Keep the old index\? \(recommended: No\)/);
	assert.match(full, /Answer the open questions in Windlass before approving\./);
	assert.match(full, /pnpm test passes/);
	assert.match(full, /Full plan/);
	assert.doesNotMatch(full, /Parts/, "no empty parts list");
	for (const message of [post.brief, post.full!])
		assert.deepEqual(labelled(message.blocks), [
			["choice:orchestrate_anyway", "Split into parts", null],
			["open", "Open in Windlass", null],
		]);
	// What the button carries is the web's answer to that question.
	assert.deepEqual(JSON.parse(String(elements(post.full!.blocks)[0]!.value)), {
		i: "i_1",
		q: "single-q",
		v: 2,
		c: "orchestrate_anyway",
	});
	// Posted as a plain question (a plan from an earlier turn), the plan still holds the approval back.
	assert.deepEqual(
		elements(questionPost("i_1", ask, url, open).full!.blocks).map(b => b.action_id),
		["choice:orchestrate_anyway", "open"],
	);
});

test("with its questions answered, a one-implementer plan offers both of the web's choices in short words", () => {
	const answered = singlePlan([{ id: "p1", text: "Keep the old index?", answer: "No" }]);
	const post = planPost("i_1", singleAsk(), answered, url);
	assert.deepEqual(labelled(post.full!.blocks), [
		["choice:run_single", "Approve as one implementer", "primary"],
		["choice:orchestrate_anyway", "Split into parts", null],
		["open", "Open in Windlass", null],
	]);
	assert.doesNotMatch(texts(post.full!.blocks), /Answer the open questions/);
	assert.deepEqual(JSON.parse(String(elements(post.full!.blocks)[0]!.value)).c, "run_single");
	// The web offers no revision here, so neither does Slack.
	assert.ok(!elements(post.full!.blocks).some(b => b.action_id === "revise"));
});

test("an approval block holds back approving the feature, as on the web, and says why", () => {
	const block = "This repository runs no CI on pushes to feature branches.";
	const ask = question({
		kind: "plan_approval",
		approvalBlock: block,
		choices: [
			{ id: "run_single", label: "Use the current Windlass session as one implementer" },
			choice("revise"),
			choice("give_up"),
		],
	});
	const answered = plan({ questions: [] });
	const post = planPost("i_1", ask, answered, url);
	// One implementer needs no feature CI: the web offers it in the block's place.
	assert.deepEqual(labelled(post.full!.blocks), [
		["choice:run_single", "Approve as one implementer", "primary"],
		["revise", "Request changes", null],
		["open", "Open in Windlass", null],
	]);
	assert.match(texts(post.full!.blocks), /no CI on pushes/);
	const withApprove = { ...ask, choices: [choice("approve"), ...ask.choices] };
	assert.ok(!slackChoices(withApprove, answered).some(c => c.id === "approve"));
	// Where one implementer is what the question approves, the block holds it back too.
	assert.deepEqual(
		slackChoices(singleAsk({ approvalBlock: block }), answered).map(c => c.id),
		["orchestrate_anyway"],
	);
});

test("every choice Slack can show has a short label that Slack does not cut", () => {
	const ids = Object.keys(CHOICES) as ChoiceId[];
	// One question per choice: a message holds at most 25 buttons.
	const shown = ids.flatMap(id =>
		elements(questionPost("i_1", question({ choices: [choice(id)] }), url).full!.blocks).filter(
			b => b.action_id !== "open",
		),
	);
	assert.equal(shown.length, ids.length - 3, "reply, raise and add_secret need input");
	for (const b of shown) {
		const text = (b.text as { text: string }).text;
		assert.ok(text.length <= 30 && text.length <= LIMITS.button && !text.endsWith("…"), text);
	}
	for (const kind of ["plan_approval", "replan_approval", "single_suggested"] as const) {
		const ask = question({ kind, choices: ids.map(choice) });
		for (const b of elements(planPost("i_1", ask, plan({ questions: [] }), url).full!.blocks)) {
			const text = (b.text as { text: string }).text;
			assert.ok(text.length <= 30 && !text.endsWith("…"), `${kind}: ${text}`);
		}
	}
});

test("resolution lines say one implementer and a split as what was done", () => {
	const ask = singleAsk();
	const by = (picked: string) => ({ kind: "answer", question: "single-q", choice: picked, by: "person:u" }) as never;
	assert.equal(resolvedLine(ask, by("run_single"), "U1"), "Approved as one implementer by <@U1> in Slack");
	assert.equal(resolvedLine(ask, by("run_single")), "Approved as one implementer on the web");
	assert.equal(resolvedLine(ask, by("orchestrate_anyway"), "U1"), "Asked to split into parts by <@U1> in Slack");
	// The plan question that did not list one implementer accepts it as well.
	const planAsk = question({ id: "single-q", kind: "plan_approval", choices: [choice("revise")] });
	assert.equal(resolvedLine(planAsk, by("run_single"), "U1"), "Approved as one implementer by <@U1> in Slack");
});
