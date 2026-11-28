import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../server/src/config.js";
import { createItem, advance, canRetry, currentKey } from "../server/src/factory/blueprint.js";
import * as intake from "../server/src/factory/intake.js";
import { edge } from "../server/src/github/events.js";
import { MAX_ITEM_BODY_CHARS, type FeaturePlanEdit } from "../server/src/contract.js";

config.sandbox = "fake";
const bucket = mkdtempSync(join(tmpdir(), "wlp-orchestrator-shots-"));
process.env.WLP_FAKE_BACKUP_DIR = bucket;
after(() => rmSync(bucket, { recursive: true, force: true }));

const single = { tokens: 10000, hostedSeconds: 500 };
const zero = { tokens: 0, rawTokens: 0, turns: 0, activeSeconds: 0, hostedSeconds: 0 };
const task = { title: "Build search", body: "Index and display results", acceptance: ["Search works"], base: "main" };
const proposal = (): FeaturePlanEdit => ({
	spec: { goal: task.body, requirements: ["Index documents"], outOfScope: [], acceptance: task.acceptance },
	questions: [],
	singleSuggested: null,
	subtasks: ["index", "page"].map((key, i) => ({
		key,
		title: key,
		brief: "Implement " + key,
		acceptance: ["Run pnpm test"],
		owns: [key + "/**"],
		dependsOn: i ? ["index"] : [],
		budget: { tokens: single.tokens },
	})),
});
const plans = () => import("../server/src/factory/feature-plan.js");
test("an orchestrated filing starts with a planner and one item's budget as its own allowance", () => {
	const item = createItem({
		id: "i_feature",
		task,
		mode: "orchestrate",
		place: { kind: "hosted" },
		budget: single,
		reviewer: { on: true },
	});
	assert.deepEqual(item.budget, single);
	assert.equal(item.ownTokens, single.tokens);
	const start = advance(item, { kind: "start", at: 1, by: "person" });
	assert.equal(start.item.run!.step.kind, "refine");
	assert.match(start.effects.find(e => e.kind === "deliver")!.text, /file_plan/);
});

test("every planning turn's prompt gives the planner its budget figures", () => {
	const item = createItem({
		id: "i_feature",
		task,
		mode: "orchestrate",
		place: { kind: "hosted" },
		budget: single,
		reviewer: { on: true },
	});
	const first = advance(item, { kind: "start", at: 1, by: "person" });
	const text = first.effects.find(e => e.kind === "deliver")!.text;
	// One item's weighted budget, the subtask range, and the feature's own allowance on top.
	assert.match(
		text,
		/Budget \(tokens are cost-weighted: an input token read from the prompt cache counts as a tenth\):/,
	);
	assert.match(text, /One item's budget: 10,000 tokens\./);
	assert.match(text, /Each subtask's budget: at least 1,000, at most 10,000 tokens\./);
	assert.match(
		text,
		/the feature's own allowance for planning, the summary and the review: 10,000 tokens, of which 0 are spent\./,
	);
	// A planning turn after the person gave the feature more says the new allowance and what was spent.
	const key = currentKey(first.item)!;
	const spent = advance(first.item, {
		kind: "turn_ended",
		key,
		at: 2,
		outcome: "succeeded",
		changes: false,
		verified: null,
		flags: [],
		report: null,
		spend: { tokens: single.tokens, hostedSeconds: 1 },
	}).item;
	const asked = advance(spent, {
		kind: "answer",
		choice: "revise",
		question: spent.question!.id,
		by: "owner",
		at: 3,
	}).item;
	const more = advance(asked, { kind: "answer", choice: "raise", question: asked.question!.id, by: "owner", at: 4 });
	assert.match(
		more.effects.find(e => e.kind === "deliver")!.text,
		/allowance for planning, the summary and the review: 20,000 tokens, of which 10,000 are spent\./,
	);
	// A builder's turn is not given them.
	const quick = advance(
		createItem({ id: "i_quick", task, place: { kind: "hosted" }, budget: single, reviewer: { on: true } }),
		{ kind: "start", at: 1, by: "person" },
	);
	assert.doesNotMatch(quick.effects.find(e => e.kind === "deliver")!.text, /One item's budget/);
});
test("issues plan first unless the bug label, quick label or leading quick command opts out", () => {
	const label = edge(
		"issues",
		{
			action: "labeled",
			installation: { id: 1 },
			repository: { id: 2 },
			issue: { number: 3 },
			sender: { login: "sam", id: 4 },
			label: { name: "windlass:orchestrate" },
		},
		{ slug: "windlass" },
	);
	assert.ok(label);
	assert.equal(intake.issueMode("orchestrate please", []).mode, "orchestrate");
	assert.equal(intake.issueMode("", []).mode, "orchestrate");
	assert.equal(intake.issueMode("please be quick", []).mode, "orchestrate");
	assert.equal(intake.issueMode("quickly", []).mode, "orchestrate");
	assert.equal(intake.issueMode("QUICK please", ["windlass:orchestrate"]).mode, "single");
	assert.equal(intake.issueMode("orchestrate", ["windlass:quick"]).mode, "single");
	assert.equal(intake.issueMode("", ["windlass:orchestrate"]).mode, "orchestrate");
	assert.deepEqual(intake.issueMode("orchestrate", ["BUG"]).mode, "single");
	assert.match(intake.issueMode("orchestrate", ["bug"]).reason!, /bug/i);
});
test("validate the entire plan, including dependencies, paths and its one token budget per subtask", async () => {
	const { validatePlan } = await plans();
	const good = proposal();
	assert.deepEqual(validatePlan(good, single).subtasks, good.subtasks);
	// A plan of before names more figures: only its tokens are kept.
	const older = proposal();
	for (const sub of older.subtasks) Object.assign(sub.budget, { turns: 4, activeSeconds: 600, hostedSeconds: 60 });
	assert.deepEqual(
		validatePlan(older, single).subtasks.map(s => s.budget),
		[{ tokens: single.tokens }, { tokens: single.tokens }],
	);
	for (const mutate of [
		(p: FeaturePlanEdit) => p.subtasks.pop(),
		(p: FeaturePlanEdit) => p.subtasks.push(...Array(5).fill(p.subtasks[0])),
		(p: FeaturePlanEdit) => p.subtasks[0].dependsOn.push("page"),
		(p: FeaturePlanEdit) => p.subtasks[0].dependsOn.push("missing"),
		(p: FeaturePlanEdit) => (p.subtasks[0].owns = ["../other"]),
		(p: FeaturePlanEdit) => (p.subtasks[1].key = "ci-fix-1"),
		(p: FeaturePlanEdit) => (p.subtasks[0].acceptance = []),
		(p: FeaturePlanEdit) => (p.subtasks[0].budget.tokens = 0),
		(p: FeaturePlanEdit) => p.subtasks[0].budget.tokens++,
		(p: FeaturePlanEdit) => (p.subtasks[0].budget.tokens = Infinity),
		(p: FeaturePlanEdit) => (p.subtasks[0].budget.tokens = 5000.5),
	]) {
		const p = proposal();
		mutate(p);
		assert.throws(() => validatePlan(p, single));
	}
});

function started(budget = single) {
	const item = createItem({
		id: "i_feature",
		task,
		mode: "orchestrate",
		place: { kind: "hosted" },
		budget,
		reviewer: { on: true },
	});
	return advance(item, { kind: "start", at: 1, by: "person" }).item;
}
function proposed(p: FeaturePlanEdit, budget = single) {
	const item = started(budget),
		key = currentKey(item)!;
	const filed = advance(item, { kind: "file_plan", key, plan: p, at: 2 });
	assert.equal(filed.item.featurePlan?.version, 1);
	return advance(filed.item, {
		kind: "turn_ended",
		key,
		at: 3,
		outcome: "succeeded",
		changes: false,
		report: null,
		verified: null,
		flags: [],
		spend: { tokens: 10, hostedSeconds: 1 },
	}).item;
}
test("only the current answered plan can be approved and it dispatches children, never a builder turn", () => {
	const p = proposal();
	p.questions.push({ id: "target", text: "Which target?" });
	const item = proposed(p);
	const approve = { kind: "approve_plan" as const, version: 1, at: 4, by: "person:owner" };
	assert.equal(advance(item, approve).item, item);
	p.questions[0].answer = "Linux";
	const edit = { kind: "edit_plan" as const, plan: p, version: 1, at: 5, by: "person:owner" };
	const edited = advance(item, edit).item;
	assert.equal(advance(edited, edit).item, edited);
	assert.equal(advance(edited, approve).item, edited);
	const next = advance(edited, { ...approve, version: 2 });
	assert.equal(next.item.featurePlan?.approvedBy, approve.by);
	assert.equal(next.item.run!.step.kind, "subtasks");
	assert.ok(next.effects.some(e => e.kind === "dispatch"));
	assert.equal(advance(next.item, { ...approve, version: 2 }).item, next.item);
});
test("single suggestion waits for either explicit choice, and planning spend carries into single mode", () => {
	const p = { ...proposal(), subtasks: [], singleSuggested: "Only one file." };
	const item = proposed(p);
	assert.equal(item.question!.kind, "single_suggested");
	assert.deepEqual(item.question!.choices, [
		{ id: "run_single", label: "Approve the current Windlass session as one implementer" },
		{ id: "orchestrate_anyway", label: "Ask for subtasks" },
	]);
	for (const choice of ["run_single", "orchestrate_anyway"] as const) {
		const next = advance(item, { kind: "answer", choice, question: item.question!.id, by: "person", at: 4 }).item;
		assert.equal(next.run!.step.kind, choice === "run_single" ? "implement" : "refine");
		assert.equal(next.spent.tokens, 10);
		if (choice === "run_single") assert.equal(next.budget.tokens - next.spent.tokens, single.tokens);
	}
});
test("run_single gives the builder the current approved scope, including the owner’s edits", () => {
	const item = proposed({ ...proposal(), subtasks: [], singleSuggested: "One implementer is enough." });
	const spec = {
		goal: "Look up a record",
		requirements: ["Match the exact identifier"],
		acceptance: ["A missing identifier returns 404"],
		outOfScope: ["Prefix matching"],
	};
	const edited = advance(item, {
		kind: "edit_plan",
		version: 1,
		plan: { ...item.featurePlan!, spec },
		at: 4,
		by: "owner",
	}).item;
	for (const fact of [
		{ kind: "run_single" },
		{ kind: "answer", choice: "run_single", question: edited.question!.id },
	] as const) {
		const result = advance(edited, { ...fact, at: 5, by: "owner" });
		const delivery = result.effects.find(e => e.kind === "deliver");
		assert.equal(result.item.featurePlan?.status, "approved");
		assert.equal(result.item.featurePlan?.approvedBy, "owner");
		assert.ok(delivery);
		assert.equal(delivery.agent, null);
		for (const text of [task.body, spec.goal, ...spec.requirements, ...spec.acceptance, ...spec.outOfScope])
			assert.ok(delivery.text.includes(text), text);
		assert.ok(!delivery.text.includes("Index documents"));
	}
});

test("one implementer requires saved answers through both approval actions", () => {
	const p = {
		...proposal(),
		subtasks: [],
		singleSuggested: "Small change.",
		questions: [{ id: "storage", text: "Which database?" }],
	};
	const pending = proposed(p);
	for (const action of [
		{ kind: "run_single" },
		{ kind: "answer", choice: "run_single", question: pending.question!.id },
	] as const) {
		assert.throws(() => advance(pending, { ...action, at: 4, by: "owner" }), /answer.*questions/i);
	}
	const plan = { ...p, questions: [{ ...p.questions[0]!, answer: "SQLite" }] };
	const edited = advance(pending, { kind: "edit_plan", plan, version: 1, at: 5, by: "owner" }).item;
	const handoff = advance(edited, {
		kind: "answer",
		question: edited.question!.id,
		choice: "run_single",
		at: 6,
		by: "owner",
	});
	assert.match(handoff.effects.find(e => e.kind === "deliver")!.text, /Which database\?[\s\S]*SQLite/);
});

test("the owner-approved plan is bounded quoted data in the implementing prompt", () => {
	const p = proposal();
	p.spec.requirements = Array.from({ length: 20 }, () => "x".repeat(2000));
	const result = advance(proposed(p), { kind: "run_single", at: 5, by: "owner" });
	const prompt = result.effects.find(e => e.kind === "deliver")!.text;
	const payload = /owner-approved plan \(quoted data\):\n([\s\S]*)/i.exec(prompt)?.[1];
	assert.equal(payload?.length, MAX_ITEM_BODY_CHARS);
});

test("planning out of the feature's own allowance asks for more, and one implementer still gets a Quick budget", () => {
	const feature = started();
	const pending = advance(feature, {
		kind: "turn_ended",
		key: currentKey(feature)!,
		at: 2,
		outcome: "succeeded",
		changes: false,
		verified: null,
		flags: [],
		report: null,
		spend: { tokens: single.tokens, hostedSeconds: 1 },
	}).item;
	const denied = advance(pending, {
		kind: "answer",
		choice: "revise",
		question: pending.question!.id,
		by: "owner",
		at: 3,
	});
	assert.equal(denied.item.question?.kind, "budget");
	assert.deepEqual(
		denied.item.question!.choices.map(c => c.id),
		["raise", "give_up"],
	);
	assert.equal(denied.item.question!.choices[0]!.label, "Give it 10k more tokens");
	assert.ok(!denied.effects.some(e => e.kind === "deliver"));
	const more = advance(denied.item, {
		kind: "answer",
		choice: "raise",
		question: denied.item.question!.id,
		by: "owner",
		at: 4,
	});
	assert.equal(more.item.ownTokens, 2 * single.tokens);
	assert.equal(more.item.budget.tokens, 2 * single.tokens);
	assert.ok(more.effects.some(e => e.kind === "deliver" && e.agent === "planner"));
});

test("a large final planner receipt stays charged and leaves room for a Quick implementation", () => {
	const p = {
		...proposal(),
		subtasks: [],
		singleSuggested: "One change.",
		questions: [{ id: "db", text: "Which database?" }],
	};
	const start = started(),
		key = currentKey(start)!;
	const filed = advance(start, { kind: "file_plan", key, at: 2, plan: p }).item;
	const spent = 15_000;
	const pending = advance(filed, {
		kind: "turn_ended",
		key,
		at: 3,
		outcome: "succeeded",
		changes: false,
		report: null,
		verified: null,
		flags: [],
		spend: { tokens: spent, hostedSeconds: 1 },
	}).item;
	// Out of its own allowance, a feature still offers subtasks: the planner's next turn asks for more first.
	assert.ok(pending.question!.choices.some(c => c.id === "orchestrate_anyway"));
	const plan = { ...p, questions: [{ ...p.questions[0]!, answer: "SQLite" }] };
	const edited = advance(pending, { kind: "edit_plan", version: 1, plan, by: "owner", at: 4 }).item;
	const build = advance(edited, { kind: "run_single", at: 5, by: "owner" });
	assert.equal(build.item.spent.tokens, spent);
	assert.equal(build.item.budget.tokens, spent + single.tokens);
	assert.match(build.effects.find(e => e.kind === "deliver")!.text, /SQLite/);
});

test("the page retry flag matches the blueprint before and after dispatch, including a placement wait", () => {
	const failed = { ...started(), state: "failed" as const };
	const fact = { kind: "retry" as const, at: 99, by: "owner" };
	for (const item of [
		failed,
		{ ...failed, machineRemoved: true },
		{ ...failed, parent: { itemId: "parent", key: "first", title: "Feature" } },
		{
			...failed,
			jobs: [
				{ id: "i_child", task: proposal().subtasks[0]!, state: "draft" as const, spent: zero, head: null, report: "" },
			],
		},
	]) {
		assert.equal(canRetry(item), item === failed);
		assert.equal(advance(item, fact).item !== item, canRetry(item));
	}
});

test("a planner can file a plan without any builder publication tools", async () => {
	const { turnHostTools, hostToolsMeta } = await import("../server/src/sandbox/turn.js");
	const call = async () => "";
	const tools = turnHostTools({ onPlan: call, onReport: call, onPush: call, onFetchBase: call } as never);
	assert.deepEqual([...tools.keys()], ["file_plan"]);
	assert.deepEqual(
		hostToolsMeta(tools).hostTools.map(t => t.name),
		["file_plan"],
	);
});

test("machine reports accept old runners and validate new compute figures", async () => {
	const { parseRunnerFrame } = await import("../server/src/runner/control.js");
	const frame = {
		kind: "report",
		commandSandbox: { ok: true },
		docker: { ok: true },
		freeDiskBytes: null,
		sandboxes: [],
	};
	const host = { cpus: 8, sandboxCpus: 0.5, memoryBytes: 1024, memoryFreeBytes: 100, load1: 1.5 };
	assert.ok(parseRunnerFrame(JSON.stringify(frame)));
	assert.ok(parseRunnerFrame(JSON.stringify({ ...frame, host })));
	assert.equal(parseRunnerFrame(JSON.stringify({ ...frame, host: { ...host, cpus: -1 } })), null);
});
test("planner inventory exposes capacity and validated owner text without session ids or secrets", async () => {
	const { machineDetails, plannerMachines } = await import("../server/src/machines/details.js");
	const details = machineDetails({ whenToUse: "Big builds", tags: ["big-build"] });
	assert.deepEqual(details.tags, ["big-build"]);
	for (const tags of [["harness:claude"], ["arch"], ["screenshots"], ["x".repeat(25)], Array(13).fill("a")])
		assert.throws(() => machineDetails({ ...details, tags }));
	assert.throws(() => machineDetails({ ...details, whenToUse: "x".repeat(501) }));
	const [entry] = plannerMachines([
		{
			...details,
			name: "f892b469d6c5",
			os: "linux",
			arch: "arm64",
			egress: "restricted",
			sandboxes: [{ state: "running", sessionId: "private" }],
			turns: { running: 1, queued: 2, max: 1 },
			sendSecrets: true,
		},
	] as never);
	assert.equal(entry.name, "Linux arm64 machine (f892b4)");
	assert.equal(entry.egress, "restricted");
	assert.equal(entry.turns!.queued, 2);
	assert.equal(entry.whenToUse, "Big builds");
	assert.doesNotMatch(JSON.stringify(entry), /private|sendSecrets/);
});

function approved(budget = single) {
	const item = proposed(proposal(), budget);
	return advance(item, { kind: "approve_plan", version: 1, at: 4, by: "person" }).item;
}
const head = "a".repeat(40);
const pr = { number: 12, url: "https://example.invalid/pull/12" };
test("one child is reserved at a time, replay is harmless, cancellation includes the pending creation", () => {
	const item = approved();
	const ready = { kind: "feature_ready" as const, at: 5, key: currentKey(item)!, head, pr };
	const next = advance(item, ready);
	assert.equal(next.item.jobs?.length, 1);
	assert.equal(next.item.jobs![0].task.key, "index");
	assert.equal(advance(next.item, ready).item, next.item);
	assert.ok(
		advance(next.item, { kind: "cancel", at: 6, by: "person" }).effects.some(e => e.kind === "cancel_children"),
	);
});
test("stopped child spend is charged once and re-planning requires fresh approval", () => {
	const item = approved();
	const running = advance(item, { kind: "feature_ready", at: 5, key: currentKey(item)!, head, pr }).item;
	const job = running.jobs![0];
	const stopped = {
		kind: "child_update" as const,
		key: currentKey(running)!,
		child: job.id,
		at: 6,
		state: "failed" as const,
		spent: { ...zero, turns: 2 },
		head: null,
		report: "Tests failed",
	};
	const replan = advance(running, stopped);
	assert.equal(replan.item.replans, 1);
	assert.equal(replan.item.spent.turns, 3);
	assert.equal(advance(replan.item, stopped).item, replan.item);
	assert.equal(replan.item.run!.step.kind, "refine");
	assert.equal(replan.item.featurePlan?.status, "superseded");
});
test("finished children unlock their dependents, and the final summary uses a read-only turn", () => {
	let item = approved();
	item = advance(item, {
		kind: "feature_ready",
		waitForCiOnEachPart: true,
		at: 5,
		key: currentKey(item)!,
		head,
		pr,
	}).item;
	for (const key of ["index", "page"]) {
		const job = item.jobs!.at(-1)!;
		assert.equal(job.task.key, key);
		item = advance(item, {
			kind: "child_update",
			child: job.id,
			key: currentKey(item)!,
			at: 9,
			state: "done",
			spent: { ...zero, turns: 1 },
			head,
			report: key + " passed",
		}).item;
	}
	assert.equal(item.run!.step.kind, "summary");
	assert.equal(item.pr!.number, 12);
});
test("feature ref updates are fast-forward only and confined to the platform feature branch", async () => {
	const { advanceFeatureRef } = await import("../server/src/github/feature.js");
	const calls: any[] = [];
	const app = {
		call: async (req: any) => {
			calls.push(req);
			return { body: { object: { sha: head } } };
		},
	};
	await advanceFeatureRef(app as never, "token", "owner", "repo", "i_feature", "main", head, "Add the index");
	assert.equal(calls[0].method, "PATCH");
	assert.equal(calls[0].body.force, false);
	assert.match(calls[0].path, /git\/refs\/heads\/windlass\/feature-i_feature$/);
	assert.doesNotMatch(calls[0].path, /\/main$/);
	await assert.rejects(
		advanceFeatureRef(
			app as never,
			"token",
			"owner",
			"repo",
			"i_feature",
			"windlass/feature-i_feature",
			head,
			"Add the index",
		),
	);
});

test("a planner cannot answer its own questions or introduce a scope change without a question", () => {
	const p = proposal();
	p.questions.push({ id: "scope", text: "Include reports?", answer: "Yes" });
	const initial = proposed(p);
	assert.equal(initial.featurePlan!.questions[0].answer, undefined);
	let old = approved();
	old = advance(old, { kind: "feature_ready", key: currentKey(old)!, at: 5, head, pr }).item;
	const stopped = advance(old, {
		kind: "child_update",
		child: old.jobs![0].id,
		key: currentKey(old)!,
		at: 6,
		state: "failed",
		spent: zero,
		report: "Stopped",
		head: null,
	}).item;
	const changed = proposal();
	changed.spec.goal = "Different feature";
	const filed = advance(stopped, { kind: "file_plan", key: currentKey(stopped)!, at: 7, plan: changed }).item;
	assert.ok(filed.featurePlan!.questions.some(q => !q.answer));
});
test("overlapping subtasks can be scheduled in sequence; each names a check or screenshot", async () => {
	const { validatePlan } = await plans();
	const plan = proposal();
	plan.subtasks[1].dependsOn = [];
	plan.subtasks[1].owns = ["index/data.ts"];
	assert.doesNotThrow(() => validatePlan(plan, single));
	plan.subtasks[1].dependsOn = ["index"];
	assert.doesNotThrow(() => validatePlan(plan, single));
	plan.subtasks[1].acceptance = ["Looks good."];
	assert.throws(() => validatePlan(plan, single));
});
test("child integration needs both gates, ignores duplicate receipts, and merges in the child on conflict", () => {
	const child = createItem({
		id: "i_child",
		task: { ...task, base: "windlass/feature-i_feature" },
		budget: single,
		place: { kind: "hosted" },
		reviewer: { off: "deployment" },
	});
	child.parent = { itemId: "i_feature", key: "index", title: task.title };
	const start = advance(child, { kind: "start", at: 1, by: "platform" }).item;
	for (const checks of [false, true]) {
		const gate = advance(start, {
			kind: "turn_ended",
			key: currentKey(start)!,
			at: 2,
			outcome: "succeeded",
			verified: checks ? { state: "passed", turn: 1, run: null, unrun: [], changedAfter: false } : null,
			flags: [],
			changes: true,
			report: null,
			spend: { tokens: 1, hostedSeconds: 0 },
		}).item;
		const pushed = advance(gate, {
			kind: "published",
			at: 3,
			key: currentKey(gate)!,
			head,
			pr: null,
			openItems: 1,
			webhooks: false,
		}).item;
		assert.equal(pushed.pr, null);
		const ci = {
			kind: "ci_read" as const,
			key: currentKey(pushed)!,
			at: 4,
			head,
			reading: {
				kind: "read" as const,
				head,
				runs: [{ name: "build", app: "status", state: "passed", conclusion: "success", url: null, summary: null }],
				logs: [],
				truncated: false,
			},
			prHead: null,
			mergeable: null,
			openItems: 1,
			webhooks: false,
		};
		const absent = advance(pushed, { ...ci, at: 3_600_000, reading: { ...ci.reading, runs: [] } } as never).item;
		assert.ok(absent.question!.choices.some(c => c.id === "wait"));
		assert.equal(absent.run!.lastFailure, "integration/no-ci");
		const waiting = advance(absent, {
			kind: "answer",
			question: absent.question!.id,
			choice: "wait",
			by: "person",
			at: 3_600_001,
		});
		assert.ok(waiting.effects.some(e => e.kind === "poll_ci"));
		const result = advance(pushed, ci as never);
		if (!checks) assert.equal(result.item.run!.lastFailure, "integration/no-gate");
		assert.equal(
			result.effects.some(e => e.kind === "integrate"),
			checks,
		);
		assert.equal(advance(result.item, ci as never).item, result.item);
		if (checks) {
			const cancelling = advance(result.item, { kind: "cancel", at: 5, by: "person" }).item;
			const receipt = advance(cancelling, { kind: "integrated", key: currentKey(cancelling)!, at: 6 });
			assert.ok(
				receipt.effects.some(e => e.kind === "notify_integrated"),
				"the confirmed fast-forward needs a durable parent receipt",
			);
			const confirmed = receipt.item;
			assert.equal(confirmed.state, "done", "record the verified commit even when cancellation raced the fast-forward");
			const declined = advance(cancelling, {
				kind: "feature_problem",
				key: currentKey(cancelling)!,
				at: 6,
				reason: "diverged",
				rebase: true,
			}).item;
			assert.equal(declined.state, "cancelled");
			const rejected = advance(result.item, {
				kind: "feature_problem",
				key: currentKey(result.item)!,
				at: 5,
				reason: "not a fast-forward",
				rebase: true,
			});
			assert.equal(rejected.item.run!.step.kind, "conflict");
			assert.match(rejected.effects.find(e => e.kind === "deliver")!.text, /merge origin/i);
		}
	}
});

test("a feature whose own allowance is used still runs its approved subtasks on their budgets", () => {
	const item = proposed(proposal());
	const old = item.featurePlan!;
	assert.equal(old.budget.tokens, single.tokens + 2 * single.tokens);
	const next = advance(item, { kind: "approve_plan", version: old.version, at: 5, by: "person" }).item;
	assert.equal(next.budget.tokens, 3 * single.tokens);
	next.spent.tokens = next.ownTokens!;
	const running = advance(next, { kind: "feature_ready", key: currentKey(next)!, pr, head, at: 6 }).item;
	assert.equal(running.question, null);
	assert.equal(running.jobs?.length, 1);
	assert.deepEqual(running.spent, next.spent);
});

test("re-plans are not capped: each new plan's budgets are the person's to approve, and the same subtask stopping twice stops the feature", () => {
	let item = approved({ ...single, tokens: 100_000 });
	item = advance(item, { kind: "feature_ready", key: currentKey(item)!, pr, head, at: 5 }).item;
	for (let i = 0; i < 2; i++) {
		const last = item.jobs!.at(-1)!;
		item = advance(item, {
			kind: "child_update",
			child: last.id,
			key: currentKey(item)!,
			state: "failed",
			spent: { ...zero, turns: 1 },
			report: "Stopped",
			head: null,
			at: 6 + i,
			failure: "gate/" + i,
		}).item;
		if (i === 1) break;
		assert.equal(item.run!.step.kind, "refine");
		const p = proposal();
		p.subtasks[0].budget.tokens = 20_000;
		const key = currentKey(item)!;
		item = advance(item, { kind: "file_plan", plan: p, key, at: 10 }).item;
		item = advance(item, {
			kind: "turn_ended",
			key,
			at: 11,
			outcome: "succeeded",
			spend: { tokens: 1, hostedSeconds: 0 },
			verified: null,
			flags: [],
			changes: false,
			report: null,
		}).item;
		assert.equal(item.question!.kind, "replan_approval");
		// Its own allowance, the stopped subtask's budget, and the new plan's two.
		assert.equal(item.featurePlan!.budget.tokens, 100_000 + 10_000 + 20_000 + 10_000);
		item = advance(item, { kind: "approve_plan", version: item.featurePlan!.version, by: "person", at: 12 }).item;
		assert.equal(item.budget.tokens, item.featurePlan!.budget.tokens);
	}
	assert.equal(item.replans, 1);
	assert.equal(item.question?.kind, "rounds");
	assert.match(item.question!.text, /stopped a second time/);
	assert.deepEqual(
		item.question!.choices.map(c => c.id),
		["revise", "give_up"],
	);
});

test("a child notice wakes a waiting feature and settles spend after cancellation without restarting it", () => {
	const initial = approved();
	const running = advance(initial, { kind: "feature_ready", key: currentKey(initial)!, head, pr, at: 5 }).item;
	const notice = {
		kind: "child_notice" as const,
		child: running.jobs![0].id,
		state: "done" as const,
		integratedHead: "b".repeat(40),
		spent: { ...zero, tokens: 120 },
		at: 6,
	};
	const woke = advance(running, notice);
	assert.ok(woke.effects.some(e => e.kind === "dispatch"));
	const cancelledAfterNotice = advance(woke.item, { kind: "cancel", at: 7, by: "person" }).item;
	assert.equal(cancelledAfterNotice.head, notice.integratedHead);
	const cancelled = advance(running, { kind: "cancel", at: 7, by: "person" }).item;
	const settled = advance(cancelled, notice);
	assert.equal(settled.item.spent.tokens, 130);
	assert.equal(settled.item.head, notice.integratedHead);
	assert.equal(settled.item.jobs![0].state, "done");
	assert.equal(settled.item.state, "cancelled");
	assert.deepEqual(settled.effects, []);
	assert.equal(advance(settled.item, notice).item, settled.item);
});

test("a re-plan respects the historical tree limit and repeated failures in different children stop the feature", () => {
	const initial = approved();
	const running = advance(initial, { kind: "feature_ready", key: currentKey(initial)!, head, pr, at: 5 }).item;
	const job = running.jobs![0];
	const fail = {
		kind: "child_update" as const,
		key: currentKey(running)!,
		child: job.id,
		at: 6,
		state: "failed" as const,
		spent: zero,
		head: null,
		report: "Failed",
		failure: "gate/build",
	};
	const first = advance(running, fail).item;
	for (let n = 0; n < 5; n++) first.jobs!.push({ ...job, id: "i_old" + n, task: { ...job.task, key: "old" + n } });
	assert.throws(
		() => advance(first, { kind: "file_plan", key: currentKey(first)!, at: 8, plan: proposal() }),
		/six|limit/i,
	);
	running.jobs!.unshift({
		...job,
		id: "i_previous",
		task: { ...job.task, key: "another" },
		state: "failed",
		failure: fail.failure,
	});
	const stopped = advance(running, fail);
	assert.equal(stopped.item.question?.kind, "rounds");
	assert.match(stopped.item.question!.text, /same failure/i);
});

test("an explicit orchestration choice cannot lead to another single suggestion", () => {
	const p = { ...proposal(), subtasks: [], singleSuggested: "One part." };
	const item = proposed(p);
	const forced = advance(item, {
		kind: "answer",
		question: item.question!.id,
		choice: "orchestrate_anyway",
		by: "person",
		at: 7,
	}).item;
	assert.throws(() => advance(forced, { kind: "file_plan", key: currentKey(forced)!, at: 8, plan: p }), /subtasks/);
});

test("the whole-feature review uses child evidence and needs the pinned head and an available reviewer", () => {
	let item = approved();
	item = advance(item, {
		kind: "feature_ready",
		waitForCiOnEachPart: true,
		key: currentKey(item)!,
		head,
		pr,
		at: 5,
	}).item;
	for (const jobKey of ["index", "page"]) {
		item = advance(item, {
			kind: "child_update",
			key: currentKey(item)!,
			child: item.jobs!.at(-1)!.id,
			state: "done",
			head,
			report: jobKey + " evidence",
			spent: zero,
			at: 6,
		}).item;
	}
	item = advance(item, {
		kind: "turn_ended",
		key: currentKey(item)!,
		at: 7,
		outcome: "succeeded",
		spend: { tokens: 1, hostedSeconds: 0 },
		report: "Summary",
		changes: false,
		verified: null,
		flags: [],
	}).item;
	item = advance(item, {
		kind: "published",
		key: currentKey(item)!,
		at: 8,
		head,
		pr,
		openItems: 1,
		webhooks: false,
	}).item;
	const ci = {
		kind: "ci_read" as const,
		key: currentKey(item)!,
		at: 9,
		head,
		reading: {
			kind: "read" as const,
			head,
			runs: [
				{
					name: "build",
					app: "status",
					state: "passed" as const,
					conclusion: "success",
					url: "",
					summary: "",
					jobId: null,
				},
			],
			logs: [],
			truncated: false,
		},
		prHead: head,
		mergeable: true,
		openItems: 1,
		webhooks: false,
	};
	const missing = advance(item, { ...ci, at: 3_600_000, reading: { ...ci.reading, runs: [] } }).item;
	assert.deepEqual(
		missing.question?.choices.map(c => c.id),
		["wait", "hand_over", "give_up"],
	);
	const review = advance(item, ci).effects.find(e => e.kind === "deliver");
	assert.ok(
		review?.to === "review" &&
			review.reviewerInput?.task.body.includes("page evidence") &&
			review.reviewerInput.task.body.includes("index evidence"),
	);
	for (const reading of [
		{ ...ci, prHead: "b".repeat(40) },
		{ ...ci, mergeable: false },
		{ ...ci, reading: { ...ci.reading, runs: [{ ...ci.reading.runs[0], state: "failed", conclusion: "failure" }] } },
	]) {
		const blocked = advance(item, reading as never).item;
		assert.ok(blocked.question!.choices.some(c => c.id === "hand_over"));
		const handoff = advance(blocked, {
			kind: "answer",
			choice: "hand_over",
			question: blocked.question!.id,
			by: "person",
			at: 10,
		});
		assert.equal(handoff.item.run!.step.kind, "handoff");
		if (reading.prHead === head) {
			const retry = advance(blocked, {
				kind: "answer",
				choice: "wait",
				question: blocked.question!.id,
				by: "person",
				at: 10,
			});
			assert.ok(retry.effects.some(e => e.kind === "poll_ci"));
		}
	}
	const skipped = advance({ ...item, reviewer: { off: "deployment" } }, ci);
	assert.equal(skipped.item.question, null);
	assert.equal(skipped.effects.find(e => e.kind === "handoff")?.reviewNone, "turned off for this deployment");
});

test("the child verdict flags both sides of a rename outside its declared ownership", async () => {
	const { workFlags } = await import("../server/src/verified.js");
	const { ownsPath } = await plans();
	const diff = {
		files: [
			{ status: "R", path: "src/a.ts", to: "test/a.ts" },
			{ status: "M", path: "src/deep/x.ts" },
			{ status: "M", path: ".env" },
		],
		patch: "",
		config: { before: null, after: null },
		packageJson: { before: null, after: null },
	};
	const flags = workFlags(diff, [], path => ownsPath(["src/**/*.ts"], path));
	assert.deepEqual(flags.find(f => f.kind === "outside_scope")?.where, ["test/a.ts", ".env"]);
	assert.equal(
		workFlags(diff, []).some(f => f.kind === "outside_scope"),
		false,
	);
});

test("the approval question shows each subtask's token budget, their total and the feature's", () => {
	const { question } = proposed(proposal());
	assert.match(question!.text, /index.*10,000 tokens/);
	assert.match(question!.text, /Subtasks together — 20,000 tokens/);
	assert.match(question!.text, /Feature budget with planning, summary and review — 30,000 tokens/);
	assert.match(question!.text, /At most per subtask — 10,000 tokens/);
	assert.doesNotMatch(question!.text, /turns|active seconds|Reserved/);
});

test("a person can cancel the current subtask by its approved key", () => {
	const initial = approved();
	const item = advance(initial, { kind: "feature_ready", key: currentKey(initial)!, at: 1, head, pr }).item;
	const cancel = { kind: "cancel_subtask" as const, key: "index", at: 2, by: "person" };
	assert.equal(advance(item, { ...cancel, key: "page" }).item, item);
	const outcome = advance(item, cancel);
	assert.deepEqual(outcome.effects.find(e => e.kind === "cancel_children")?.ids, [item.jobs![0].id]);
	assert.equal(advance(outcome.item, cancel).item, outcome.item);
});

test("a withdrawn feature turn settles its late usage receipt exactly once", () => {
	const feature = started(),
		key = currentKey(feature)!;
	const running = advance(feature, { kind: "turn_started", key, at: 2 }).item;
	const cancelled = advance(running, { kind: "cancel", by: "person", at: 3 }).item;
	const ended = {
		kind: "turn_ended" as const,
		key,
		at: 4,
		outcome: "stopped" as const,
		changes: false,
		report: null,
		flags: [],
		verified: null,
		spend: { tokens: 1234, hostedSeconds: 3 },
	};
	const settled = advance(cancelled, ended);
	assert.equal(settled.item.spent.tokens, 1234);
	assert.equal(settled.item.state, "cancelled");
	assert.deepEqual(settled.effects, []);
	assert.equal(advance(settled.item, ended).item, settled.item);
});

const passedFeatureCi = (item: ReturnType<typeof approved>, key = currentKey(item)!) => {
	const head = item.head!;
	return advance(item, {
		kind: "ci_read",
		key,
		at: 9,
		head,
		prHead: head,
		mergeable: true,
		openItems: 1,
		webhooks: false,
		reading: {
			kind: "read",
			head,
			runs: [
				{ name: "build", app: "status", state: "passed", conclusion: "success", url: "", summary: "", jobId: null },
			],
			logs: [],
			truncated: false,
		},
	});
};

function finishFeatureParts(item: ReturnType<typeof approved>, tip: string) {
	const job = item.jobs!.at(-1)!;
	return advance(item, {
		kind: "child_update",
		key: job.dispatchKey!,
		child: job.id,
		state: "done",
		head: tip,
		at: 6,
		report: job.task.title + " evidence",
		spent: zero,
	}).item;
}

function reviewFeature(item: ReturnType<typeof approved>) {
	item = passedFeatureCi(item, item.featureCi!.key!).item;
	assert.equal(item.run!.step.kind, "summary");
	item = advance(item, {
		kind: "turn_ended",
		key: currentKey(item)!,
		at: 7,
		outcome: "succeeded",
		spend: zero,
		report: "Summary",
		changes: false,
		verified: null,
		flags: [],
	}).item;
	item = advance(item, {
		kind: "published",
		key: currentKey(item)!,
		at: 8,
		head: item.head!,
		pr,
		openItems: 1,
		webhooks: false,
	}).item;
	assert.equal(item.run!.step.kind, "ci");
	return passedFeatureCi(item);
}

function reviewingFeature() {
	let item = approved();
	item = advance(item, { kind: "feature_ready", key: currentKey(item)!, head, pr, at: 5 }).item;
	for (const _task of proposal().subtasks) item = finishFeatureParts(item, head);
	return reviewFeature(item).item;
}

function featureFiling(item: ReturnType<typeof approved>, root?: string) {
	const key = currentKey(item)!,
		pending = item.run!.review!;
	return advance(item, {
		kind: "review_ended",
		key,
		at: 10,
		outcome: "succeeded",
		said: null,
		spend: zero,
		review: {
			id: key,
			run: item.run!.n,
			round: pending.round!,
			head: item.head!,
			base: "b".repeat(40),
			verdictId: pending.verdictId,
			by: { sessionId: "second", model: "test" },
			at: 10,
			state: "filed",
			said: null,
			recommendation: root ? "changes_requested" : "approve",
			records: [],
			notes: [],
			screenshots: [],
			blocks: root
				? [
						{
							kind: "finding",
							id: root,
							root,
							severity: "blocking",
							title: "Missing index",
							text: "The page never indexes.",
							at: [{ path: "src/search.ts", side: "head", lines: { start: 4, end: 6 } }],
							refs: [],
						},
					]
				: [],
		},
	});
}

test("blocking feature review dispatches a fix part and re-reviews its integrated head after CI", () => {
	const filing = featureFiling(reviewingFeature(), "r1.f1");
	const item = filing.item,
		job = item.jobs!.at(-1)!;
	assert.equal(filing.effects.find(e => e.kind === "dispatch")?.child, job.id);
	assert.ok(!filing.effects.some(e => e.kind === "handoff"));
	assert.deepEqual(job.task.owns, ["src/search.ts"]);
	assert.match(job.task.brief, /The page never indexes/);
	assert.equal(job.reviewFix?.reviewedHead, head);
	assert.equal(item.run!.rounds.review, 1);
	const tip = "c".repeat(40);
	const reviewed = reviewFeature(finishFeatureParts(item, tip));
	const input = reviewed.effects.find(e => e.kind === "deliver")?.reviewerInput;
	assert.equal(input?.head, tip);
	assert.equal(input?.previousHead, head);
	assert.equal(input?.round, 2);
	assert.equal(input?.earlier[0].id, "r1.f1");
	assert.equal(passedFeatureCi(featureFiling(reviewed.item).item).item.state, "review");
});

test("a repeated or capped feature review asks the owner to retry, hand over or stop", () => {
	let item = featureFiling(reviewingFeature(), "r1.f1").item;
	item = reviewFeature(finishFeatureParts(item, "c".repeat(40))).item;
	const repeated = featureFiling(item, "r1.f1").item;
	assert.equal(repeated.question?.cause, "repeated");
	item = featureFiling(item, "r2.f1").item;
	item = reviewFeature(finishFeatureParts(item, "d".repeat(40))).item;
	const stopped = featureFiling(item, "r3.f1").item;
	assert.equal(stopped.question?.cause, "review");
	for (const asked of [repeated, stopped]) {
		assert.deepEqual(
			asked.question!.choices.map(c => c.id),
			["raise", "hand_over", "give_up"],
		);
		const answer = { kind: "answer" as const, at: 11, by: "person", question: asked.question!.id };
		const retry = advance(asked, { ...answer, choice: "raise", note: "Keep the public API." });
		assert.match(retry.item.jobs!.at(-1)!.task.brief, /Keep the public API/);
		assert.equal(retry.item.run!.step.kind, "subtasks");
		const handed = passedFeatureCi(advance(asked, { ...answer, choice: "hand_over" }).item);
		assert.match(handed.effects.find(e => e.kind === "handoff")!.words, /^Code review requested changes/);
	}
});

test("owner Send back on a feature starts a fix part with the note on the same PR", () => {
	const item = passedFeatureCi(featureFiling(reviewingFeature()).item).item;
	const send = { kind: "send_back" as const, at: 12, by: "person", note: "Index archived pages too." };
	const next = advance(item, send),
		job = next.item.jobs!.at(-1)!;
	assert.equal(next.item.run!.step.kind, "subtasks");
	assert.equal(job.task.brief, send.note);
	assert.equal(next.effects.find(e => e.kind === "dispatch")?.child, job.id);
	assert.equal(next.item.decisions!.at(-1)?.text, send.note);
	assert.deepEqual(next.item.pr, pr);
	assert.deepEqual(next.item.featurePlan, item.featurePlan);
	assert.equal(advance(next.item, send).item, next.item);
});

test("a disabled GitHub orchestration request is refused before claiming the issue", () => {
	const ordinary = intake.issueMode("", [], false);
	assert.equal(ordinary.mode, "single");
	assert.equal(ordinary.refusal, null);
	const asked = intake.issueMode("orchestrate", [], false);
	assert.match(asked.refusal!, /disabled/i);
	assert.match(intake.issueMode("", ["windlass:orchestrate"], false).refusal!, /disabled/i);
	assert.equal(intake.issueMode("orchestrate", ["bug"], false).refusal, null);
});

const identity = { name: "ada", email: "42+ada@users.noreply.github.com" };
async function opening(refusal?: Error) {
	const { openFeature } = await import("../server/src/github/feature.js");
	const requests: any[] = [],
		pulls: any[] = [];
	const app = {
		call: async (request: any) => {
			requests.push(request);
			return { body: request.method === "POST" ? { sha: head } : { tree: { sha: head } } };
		},
		openPull: async () => null,
		createPull: async (_token: string, _owner: string, _repo: string, input: any) => {
			pulls.push(input);
			if (input.draft && refusal) throw refusal;
			return { ...pr, headSha: head, base: "main" };
		},
	};
	await openFeature(app as never, "token", "ada", "repo", {
		id: "i_feature",
		title: "Search",
		base: "main",
		seed: head,
		created: 0,
		body: "Original goal",
		author: identity,
	});
	return { requests, pulls };
}
test("the feature marker credits the connected user as author and committer", async () => {
	const { requests } = await opening();
	const marker = requests.find(r => r.body?.parents).body;
	const expected = { ...identity, date: new Date(0).toISOString() };
	assert.deepEqual(marker.author, expected);
	assert.deepEqual(marker.committer, expected);
});

test("only an unsupported draft retries as an in-progress ordinary PR", async () => {
	const { GithubError } = await import("../server/src/github/app.js");
	const refused = (status: number, message: string) => new GithubError(status, message, "open PR");
	const message = "Draft pull requests are not supported in this repository.";
	const { pulls } = await opening(refused(422, "Validation Failed: " + message));
	assert.equal(pulls.length, 2);
	assert.deepEqual(pulls[1], { ...pulls[0], draft: false, body: "Original goal\n\nFeature in progress." });
	for (const error of [refused(403, message), refused(422, "Invalid head")])
		await assert.rejects(opening(error), error);
});

async function readying(answer: unknown, draft = true) {
	const { readyFeature } = await import("../server/src/github/feature.js");
	const requests: { method?: string; path: string }[] = [];
	const app = {
		settings: { apiUrl: "https://api.github.com" },
		call: async (request: { method?: string; path: string }) => {
			requests.push(request);
			if (request.method !== "POST")
				return { status: 200, body: { head: { ref: "windlass/feature-i_feature" }, draft, node_id: "PR_1" } };
			return { status: 200, body: answer };
		},
	};
	const done = await readyFeature(app as never, "token", "ada", "repo", 12, "i_feature").then(
		() => null,
		(error: Error) => error,
	);
	return { done, requests };
}

test("marking the feature PR ready says GitHub's GraphQL error, sent with 200", async () => {
	const { GraphqlRefusal } = await import("../server/src/github/app.js");
	const refused = await readying({
		data: { markPullRequestReadyForReview: null },
		errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration", path: ["x"] }],
	});
	assert.ok(refused.done instanceof GraphqlRefusal);
	assert.equal(refused.done.type, "FORBIDDEN");
	assert.equal(refused.done.said, "FORBIDDEN: Resource not accessible by integration");
	assert.equal(
		refused.done.message,
		"GitHub refused to mark the PR ready for review: FORBIDDEN: Resource not accessible by integration",
	);
	assert.equal(refused.requests.at(-1)?.path, "/graphql");
	const silent = await readying({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: true } } } });
	assert.ok(silent.done instanceof GraphqlRefusal && silent.done.said === null);
	assert.equal(silent.done.message, "GitHub did not confirm the PR is ready for review.");
	const untyped = await readying({ errors: [{ message: "Something\n went  wrong" }] });
	assert.equal((untyped.done as InstanceType<typeof GraphqlRefusal>).said, "Something went wrong");
	assert.equal(
		(await readying({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } })).done,
		null,
	);
	// Marked ready already (by the person, say): read, and nothing to change.
	const ready = await readying(null, false);
	assert.equal(ready.done, null);
	assert.equal(ready.requests.length, 1);
});

test("a refused ready-for-review is tried after 5 min, 15 min and 1 h, then handed to the person once", async () => {
	const { readyStep, READY_RETRY_MS } = await import("../server/src/actors/work-item.js");
	assert.deepEqual(READY_RETRY_MS, [300_000, 900_000, 3_600_000]);
	let calls = 0;
	const refuse = async () => (calls++, "FORBIDDEN: Resource not accessible by integration");
	const steps = [];
	let refusals = 0;
	for (let i = 0; i < 5; i++) {
		const step = await readyStep(refusals, refuse);
		steps.push(step);
		if ("refusals" in step) refusals = step.refusals;
	}
	assert.deepEqual(
		steps.map(s => [s.kind, "wait" in s ? s.wait : null]),
		[
			["retry", 300_000],
			["retry", 900_000],
			["retry", 3_600_000],
			["ask", null],
			["asked", null],
		],
	);
	assert.equal(calls, 4, "Asked once, the hand-off stops marking the PR ready");
	assert.equal((steps[3] as { said: string }).said, "FORBIDDEN: Resource not accessible by integration");
	assert.deepEqual(await readyStep(2, async () => null), { kind: "ready" });
});

test("only GitHub's refusal of ready-for-review counts toward the hand-over; outages and rate limits retry", async () => {
	const { readyRefused } = await import("../server/src/actors/work-item.js");
	const { GithubError, GraphqlRefusal } = await import("../server/src/github/app.js");
	const graphql = (type: string, message: string) =>
		new GraphqlRefusal("mark the PR ready for review", { errors: [{ type, message }] }, "unconfirmed");
	assert.equal(
		readyRefused(graphql("FORBIDDEN", "Resource not accessible by integration")),
		"FORBIDDEN: Resource not accessible by integration",
	);
	assert.equal(readyRefused(new GraphqlRefusal("x", { data: {} }, "unconfirmed")), "unconfirmed");
	assert.equal(readyRefused(graphql("RATE_LIMITED", "API rate limit exceeded")), null);
	assert.equal(readyRefused(new GithubError(404, "Not Found", "read")), "GitHub answered 404 (Not Found)");
	assert.equal(readyRefused(new GithubError(429, "", "read")), null);
	assert.equal(readyRefused(new GithubError(403, "API rate limit exceeded", "read")), null);
	assert.equal(readyRefused(new GithubError(502, "", "read")), null);
	assert.equal(readyRefused(new GithubError(0, "fetch failed", "read")), null);
	assert.equal(readyRefused(new Error("the deployment has no GitHub App")), null);
});

test("each subtask must fund a useful build and verification turn", async () => {
	const { validatePlan } = await plans();
	const p = proposal();
	p.subtasks[0].budget.tokens = 1000;
	validatePlan(p, single);
	p.subtasks[0].budget.tokens--;
	assert.throws(() => validatePlan(p, single), /tokens/);
});

test("a plan's budget is its subtasks' and the feature's own allowance, and more subtasks make it larger", () => {
	const full = proposal();
	full.subtasks.push({ ...full.subtasks[1], key: "docs", owns: ["docs/**"] });
	assert.equal(proposed(full).featurePlan!.budget.tokens, 4 * single.tokens);
	const pending = proposed(proposal());
	const edited = advance(pending, { kind: "edit_plan", at: 4, by: "person", version: 1, plan: full }).item;
	assert.equal(edited.featurePlan!.budget.tokens, 4 * single.tokens);
	const approvedFull = advance(edited, { kind: "approve_plan", at: 5, by: "person", version: 2 }).item;
	assert.equal(approvedFull.budget.tokens, 4 * single.tokens);
});

test("a feature's own allowance is raised by one start's worth, or to the person's figure above what it spent", () => {
	const feature = started();
	feature.spent.tokens = feature.budget.tokens;
	const pending = advance(feature, {
		kind: "turn_ended",
		key: currentKey(feature)!,
		at: 2,
		outcome: "succeeded",
		changes: false,
		verified: null,
		flags: [],
		report: null,
		spend: { tokens: 0, hostedSeconds: 0 },
	}).item;
	const stopped = advance(pending, {
		kind: "answer",
		choice: "revise",
		question: pending.question!.id,
		by: "person",
		at: 3,
	}).item;
	assert.equal(stopped.question!.kind, "budget");
	const raise = {
		kind: "answer" as const,
		choice: "raise" as const,
		question: stopped.question!.id,
		by: "person",
		at: 4,
	};
	assert.equal(advance(stopped, raise).item.budget.tokens, 2 * single.tokens);
	assert.equal(advance(stopped, { ...raise, budget: { tokens: 15_000 } }).item.ownTokens, 15_000);
	// A figure at or below what was spent gives the default extra instead: going on never stops at once again.
	assert.equal(advance(stopped, { ...raise, budget: { tokens: single.tokens } }).item.ownTokens, 2 * single.tokens);
});

test("a quiet child needs 15 polls and one parent revision in the first hour", async () => {
	const feature = approved();
	let item = advance(feature, { kind: "feature_ready", key: currentKey(feature)!, head, pr, at: 0 }).item;
	let polls = 0,
		revisions = 0,
		at = 0;
	const { rescheduleChildPoll } = await import("../server/src/actors/work-item.js");
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(":memory:");
	db.exec(
		"CREATE TABLE effects(id TEXT, effect TEXT, due_at INTEGER, attempts INTEGER); INSERT INTO effects VALUES ('poll','dispatch',0,0)",
	);
	const execute = (sql: string, ...args: (string | number)[]) => db.prepare(sql).run(...args);
	while (at < 3_600_000) {
		const next = advance(item, {
			kind: "child_update",
			key: currentKey(item)!,
			child: item.jobs![0].id,
			state: "waiting",
			spent: zero,
			head: null,
			report: "Waiting for owner",
			at,
		});
		if (next.item !== item) revisions++;
		item = next.item;
		const dispatch = next.effects.find(e => e.kind === "dispatch");
		if (dispatch) at = dispatch.at!;
		else {
			const row = db.prepare("SELECT * FROM effects").get() as {
				id: string;
				effect: string;
				due_at: number;
				attempts: number;
			};
			await rescheduleChildPoll({ execute } as never, row, at);
			at = Number(db.prepare("SELECT due_at FROM effects").get()!.due_at);
		}
		polls++;
	}
	assert.equal(polls, 15, polls + " polls per hour");
	assert.equal(db.prepare("SELECT attempts FROM effects").get()!.attempts, 14);
	db.close();
	assert.equal(revisions, 1);
	const notice = advance(item, { kind: "child_notice", child: item.jobs![0].id, state: "done", spent: zero, at });
	assert.equal(notice.effects.find(e => e.kind === "dispatch")?.at, at);
});

test("an exhausted subtask asks for more, and its new budget grows its feature's", () => {
	const child = createItem({
		id: "i_child",
		task,
		budget: single,
		reviewer: { off: "deployment" },
		place: { kind: "hosted" },
	});
	child.parent = { itemId: "i_feature", key: "index", title: task.title };
	child.spent = { ...zero, tokens: single.tokens, rawTokens: single.tokens };
	const stopped = advance(child, { kind: "start", at: 1, by: "person" }).item;
	assert.equal(stopped.question!.kind, "budget");
	assert.deepEqual(
		stopped.question!.choices.map(c => c.id),
		["raise", "give_up"],
	);
	assert.match(stopped.question!.text, /increases the feature's budget/);
	const more = advance(stopped, {
		kind: "answer",
		question: stopped.question!.id,
		choice: "raise",
		at: 2,
		by: "person",
	});
	assert.equal(more.item.budget.tokens, 2 * single.tokens);
	assert.equal(more.item.run!.n, 1);
	assert.ok(more.effects.some(e => e.kind === "deliver"));
	// The feature reads the subtask's new budget from its next update: its own budget grows by as much.
	const feature = advance(approved(), { kind: "feature_ready", key: currentKey(approved())!, at: 5, head, pr }).item;
	const job = feature.jobs![0];
	const before = feature.budget.tokens;
	const grown = advance(feature, {
		kind: "child_update",
		key: currentKey(feature)!,
		child: job.id,
		at: 6,
		state: "waiting",
		spent: { ...zero, tokens: single.tokens },
		budget: { tokens: 2 * single.tokens, hostedSeconds: single.hostedSeconds },
		head: null,
		report: "",
	}).item;
	assert.equal(grown.budget.tokens, before + single.tokens);
	assert.equal(grown.jobs![0].budget?.tokens, 2 * single.tokens);
});

test("a re-plan cannot edit completed work", () => {
	let item = approved();
	item = advance(item, { kind: "feature_ready", key: currentKey(item)!, head, pr, at: 5 }).item;
	for (const state of ["done", "failed"] as const) {
		item = advance(item, {
			kind: "child_update",
			key: currentKey(item)!,
			child: item.jobs!.at(-1)!.id,
			state,
			spent: zero,
			head,
			report: "Result",
			at: 6,
		}).item;
	}
	const plan = proposal();
	plan.subtasks[0].brief += " and change another file";
	assert.throws(() => advance(item, { kind: "file_plan", key: currentKey(item)!, plan, at: 8 }), /Completed subtasks/);
});
test("a redelivered planner must file in its own attempt before approval", () => {
	let item = started();
	const filed = currentKey(item)!;
	item = advance(item, { kind: "file_plan", key: filed, at: 2, plan: proposal() }).item;
	item = advance(item, {
		kind: "turn_ended",
		key: filed,
		at: 3,
		outcome: "interrupted",
		spend: { tokens: 1, hostedSeconds: 0 },
		report: null,
		changes: false,
		flags: [],
		verified: null,
	}).item;
	assert.notEqual(currentKey(item), filed);
	assert.equal(item.run!.step.attempt, 2);
	item = advance(item, {
		kind: "turn_ended",
		key: currentKey(item)!,
		at: 5,
		outcome: "succeeded",
		spend: { tokens: 1, hostedSeconds: 0 },
		report: null,
		changes: false,
		flags: [],
		verified: null,
	}).item;
	assert.match(item.question!.text, /without filing/);
	assert.equal(
		advance(item, { kind: "approve_plan", version: item.featurePlan!.version, at: 6, by: "person" }).item,
		item,
	);
});

test("with per-part CI, a missing integration prerequisite stops the feature at its last integrated head", () => {
	const feature = approved();
	const item = advance(feature, {
		kind: "feature_ready",
		waitForCiOnEachPart: true,
		key: currentKey(feature)!,
		head,
		pr,
		at: 5,
	}).item;
	for (const failure of ["integration/no-ci", "integration/no-gate"]) {
		const stopped = advance(item, {
			kind: "child_update",
			key: currentKey(item)!,
			child: item.jobs![0].id,
			state: "failed",
			failure,
			head: "b".repeat(40),
			report: "Stopped",
			spent: zero,
			at: 6,
		});
		assert.equal(stopped.item.replans ?? 0, 0);
		assert.deepEqual(
			stopped.item.question!.choices.map(c => c.id),
			["hand_over", "give_up"],
		);
		const handoff = advance(stopped.item, {
			kind: "answer",
			question: stopped.item.question!.id,
			choice: "hand_over",
			by: "person",
			at: 7,
		});
		assert.ok(handoff.effects.some(e => e.kind === "poll_ci" && e.head === head));
	}
});

test("push CI must target the feature and child branches", async () => {
	const { workflowReportsPush } = await import("../server/src/github/feature-ci.js");
	const branch = "windlass/feature-i_feature";
	for (const source of [
		"on: pull_request",
		"on: [pull_request, workflow_dispatch]",
		"on: {push: {branches: [main]}}",
		"on: {push: {tags: ['v*']}}",
		"on: {push: {branches-ignore: ['windlass/**']}}",
		"on: {push: {branches: ['**','!windlass/**']}}",
	])
		assert.equal(workflowReportsPush(source, branch), false, source);
	for (const source of [
		"on: push",
		"on: [push, pull_request]",
		"on: {push: null}",
		"on: {push: {branches: ['windlass/*']}}",
		"on: {push: {branches: ['**','!windlass/**','windlass/feature-*']}}",
	])
		assert.equal(workflowReportsPush(source, branch), true, source);
});

test("re-planning after a stopped subtask is the feature's own turn, held to its own allowance", () => {
	const feature = approved();
	const running = advance(feature, { kind: "feature_ready", key: currentKey(feature)!, at: 5, head, pr }).item;
	running.spent.tokens = running.ownTokens!;
	const stopped = advance(running, {
		kind: "child_update",
		key: currentKey(running)!,
		child: running.jobs![0].id,
		state: "failed",
		spent: zero,
		report: "Stopped",
		head: null,
		at: 6,
	});
	assert.equal(stopped.item.question?.kind, "budget");
	assert.equal(
		stopped.effects.some(e => e.kind === "deliver"),
		false,
	);
});

const GiB = 2 ** 30;
const macId = "m_0000000000000001",
	linuxId = "m_0000000000000002";
function machineReport(
	name = "Mac",
	machineId = macId,
	overrides: Partial<import("../server/src/contract.js").MachineSummary> = {},
): import("../server/src/contract.js").MachineSummary {
	return {
		name,
		machineId,
		os: "darwin",
		arch: "arm64",
		status: "online",
		since: 0,
		runnerVersion: "1.0.0",
		agents: 0,
		warnings: [],
		sandboxes: [],
		profiles: [{ id: "docker-hardened", available: true } as never],
		commandSandbox: { ok: true },
		allowedProfiles: ["docker-hardened"],
		screenshots: true,
		egress: "restricted",
		tags: ["build"],
		sendSecrets: false,
		freeDiskBytes: 5 * GiB,
		turns: { running: 0, queued: 0, max: 4 },
		host: { cpus: 64, sandboxCpus: 1, memoryBytes: 128 * GiB, memoryFreeBytes: 80 * GiB, load1: 0 },
		...overrides,
	};
}
import { plannerMachines, machineDetails } from "../server/src/machines/details.js";
import { choosePlacement } from "../server/src/factory/placement.js";
import type { MachineSummary, PlacementNeeds, SubtaskAgent } from "../server/src/contract.js";
function placementFeature(
	machines: MachineSummary[],
	needs: PlacementNeeds = {},
	allow: string[] = [],
	overflow = false,
	prefer = "Mac",
	agent?: SubtaskAgent,
) {
	const plan = proposal();
	plan.overflow = overflow;
	for (const sub of plan.subtasks)
		Object.assign(sub, {
			place: { prefer, reason: "Build on the owner's machine", allow },
			needs,
			...(agent && { agent }),
		});
	const item = proposed(plan);
	const inventory = { machines: plannerMachines(machines), hostedProfiles: ["docker-hardened" as const] };
	const agents = agent && agent.harness !== "windlass" ? plan.subtasks.map(s => s.key) : undefined;
	const approved = advance(item, { kind: "approve_plan", at: 4, by: "person", version: 1, inventory, agents }).item;
	return advance(approved, { kind: "feature_ready", key: currentKey(approved)!, at: 5, head, pr }).item;
}
function dispatch(item: ReturnType<typeof placementFeature>, machines: MachineSummary[]) {
	return advance(item, {
		kind: "place_child",
		at: 6,
		key: currentKey(item)!,
		inventory: { machines: plannerMachines(machines), hostedProfiles: ["docker-hardened"] },
	}).item;
}
test("placement preserves the editable proposal and bounds its reason, needs and overflow", () => {
	const p = proposal();
	const proposalPlace = { prefer: "Mac", reason: "Build here", allow: ["Linux box"] };
	Object.assign(p.subtasks[0], { place: proposalPlace, needs: { cpus: 2 } });
	const filed = proposed(p);
	assert.deepEqual(filed.featurePlan?.subtasks[0].place, proposalPlace);
	assert.equal(filed.featurePlan?.overflow, false);
	for (const invalid of [
		{ place: { ...proposalPlace, reason: "x".repeat(201) } },
		{ needs: { cpus: 0 } },
		{ needs: { memoryGiB: Infinity } },
		{ needs: { screenshots: "yes" } },
		{ needs: { egress: "invalid" } },
	])
		assert.throws(() =>
			proposed({ ...p, subtasks: [{ ...p.subtasks[0], ...invalid }, p.subtasks[1]] } as FeaturePlanEdit),
		);
	assert.throws(() => proposed({ ...p, overflow: "yes" } as never));
});
test("a daily token cap waits on hosted and machine routes, including approved overflow", () => {
	const machines = [machineReport()];
	for (const [prefer, allow] of [
		["hosted", ["Mac"]],
		["Mac", ["hosted"]],
	] as const) {
		const item = placementFeature(machines, {}, [...allow], true, prefer);
		const wait = "Your daily model token cap has been reached until 00:00 UTC.";
		const waiting = advance(item, {
			kind: "place_child",
			at: 6,
			key: currentKey(item)!,
			inventory: { machines: plannerMachines(machines), hostedProfiles: ["docker-hardened"], dailyTokenWait: wait },
		}).item;
		assert.equal(waiting.wait?.reason, "capacity");
		assert.equal(waiting.wait?.sentence, wait);
		assert.equal(waiting.question, null);
		assert.equal(waiting.jobs!.at(-1)!.placement, undefined);
		assert.ok(dispatch(waiting, machines).jobs!.at(-1)!.placement);
	}
});
test("placement 1 binds the approved Mac by id and keeps the reason after a rename", () => {
	const mac = machineReport();
	const item = placementFeature([mac]);
	const placed = dispatch(item, [{ ...mac, name: "Renamed" }]).jobs![0].placement;
	assert.deepEqual(placed?.place, { kind: "machine", machineId: macId });
	assert.equal(placed?.reason, "Build on the owner's machine");
	assert.equal(placed?.sendSecrets, false);
	assert.throws(() => placementFeature([]), /Mac/);
	assert.throws(() => placementFeature([mac, machineReport("Mac", linuxId)]), /ambiguous|more than one/i);
});
test("placement 2 refuses approval for missing screenshots, tags, profile, egress or sign-in", () => {
	const mac = machineReport();
	assert.throws(() => placementFeature([{ ...mac, screenshots: false }], { screenshots: true }), /screenshot/i);
	for (const [needs, reason] of [
		[{ tags: ["gpu"] }, /gpu/],
		[{ profile: "docker-windlass-sandbox" }, /profile/],
		[{ egress: "open" }, /egress/],
	] as const)
		assert.throws(() => placementFeature([mac], needs as PlacementNeeds), reason);
	assert.throws(
		() => placementFeature([mac], {}, [], false, "Mac", { harness: "claude" }),
		/does not offer Claude Code/,
	);
	assert.doesNotThrow(() =>
		placementFeature([mac], { tags: ["build", "os:darwin", "arch:arm64", "screenshots", "harness:windlass"] }),
	);
});
test("hosted placement matches the requested network policy and explains each refusal", () => {
	const task = proposal().subtasks[0]!;
	const route = { preferred: { kind: "hosted" as const }, alternatives: [] };
	const fit = (hostedEgress: "restricted" | "open" | "none" | undefined, needs: PlacementNeeds) =>
		choosePlacement({ ...task, needs }, route, { machines: [], hostedProfiles: ["e2b"], hostedEgress });
	for (const egress of ["restricted", "open"] as const) assert.equal(fit(egress, { egress }).decision?.name, "hosted");
	assert.equal(
		fit("open", { egress: "restricted" }).refused,
		"Hosted sandboxes here have open internet access. This part asked for restricted network access.",
	);
	assert.equal(
		fit("restricted", { egress: "open" }).refused,
		"Hosted sandboxes here have restricted network access. This part asked for open internet access.",
	);
	assert.match(fit(undefined, { egress: "restricted" }).refused!, /policy is unknown.*restricted network access/);
	assert.match(fit("none", { egress: "open" }).refused!, /no network for repositories/);
	assert.match(fit("restricted", { tags: ["gpu"] }).refused!, /machine tag “gpu”/);
});
test("placement 3 measures requested CPU and memory in sandbox units", () => {
	const mac = machineReport();
	assert.throws(() => placementFeature([mac], { cpus: 8 }), /slots|units/i);
	const sized = { ...mac, slots: { max: 3, busy: 1, queued: 0, unit: { cpus: 4, memoryBytes: 4 * GiB, pids: 1024 } } };
	const item = placementFeature([sized], { cpus: 8, memoryGiB: 8 });
	assert.equal(dispatch(item, [sized]).jobs![0].placement?.units, 2);
	// Three units use the four-slot size class, clamped to the configured capacity.
	for (const max of [3, 4]) {
		const roomy = { ...sized, slots: { ...sized.slots, busy: 0, max } };
		assert.equal(dispatch(placementFeature([roomy], { cpus: 12 }), [roomy]).jobs![0].placement?.units, max);
	}
	const legacy = machineReport("Mac", macId, { host: { ...mac.host!, sandboxCpus: 4 } });
	for (const needs of [{ cpus: 8 }, { memoryGiB: 2 }]) {
		assert.throws(() => placementFeature([legacy], needs), /Mac.*sizing beyond one slot/i);
	}
	// Said only of a plan that sizes a subtask.
	assert.doesNotMatch(proposed(proposal()).question!.text, /cpus and memoryGiB choose/i);
	const sizedPlan = proposal();
	sizedPlan.subtasks[0]!.needs = { cpus: 8 };
	assert.match(proposed(sizedPlan).question!.text, /On hosted, cpus and memoryGiB must fit the chosen size/i);
});
test("placement 4 waits for slots unless both overflow and that alternative are approved", () => {
	const full = machineReport("Mac", macId, { turns: { running: 4, max: 4, queued: 1 } });
	const linux = machineReport("Linux box", linuxId);
	const machines = [full, linux];
	for (const [allow, overflow] of [
		[["Linux box"], false],
		[[], true],
	] as const) {
		// A busy machine is a wait: approval allows it and the feature waits for a slot.
		const approved = placementFeature(machines, {}, [...allow], overflow);
		assert.equal(approved.featurePlan?.status, "approved");
		const item = dispatch(approved, machines);
		assert.match(item.wait!.sentence, /Waiting for 1 free slot on ‘Mac’/);
		assert.equal(item.question, null);
	}
	const alternative = dispatch(placementFeature(machines, {}, ["Linux box"], true), machines);
	assert.deepEqual(alternative.jobs![0].placement?.place, { kind: "machine", machineId: linuxId });
});
test("approval refuses only a permanent placement problem: busy, offline or short of disk waits or asks after approval", () => {
	const mac = machineReport(),
		linux = machineReport("Linux box", linuxId);
	const offline = {
		...mac,
		status: "offline" as const,
		turns: { max: null, running: 0, queued: 0 },
		profiles: [],
		freeDiskBytes: null,
	};
	const busy = { ...mac, turns: { running: 4, max: 4, queued: 0 } };
	for (const machines of [[offline], [busy], [offline, { ...linux, orchestrator: "never" as const }]]) {
		const approved = placementFeature(machines, {}, machines.length > 1 ? ["Linux box"] : [], true);
		assert.equal(approved.featurePlan?.status, "approved");
		const item = dispatch(approved, machines);
		if (machines[0].status === "offline") {
			assert.equal(item.question?.kind, "placement_refused");
			assert.ok(item.question.choices.some(c => c.id === "wait"));
			assert.ok(!item.question.choices.some(c => c.id === "use_hosted"));
		} else assert.equal(item.wait?.reason, "machine");
	}
	// An offline machine keeps its last report: a capability it lacks still refuses, as does an owner policy.
	assert.throws(
		() => placementFeature([{ ...offline, screenshots: false }], { screenshots: true }),
		/Mac.*screenshots/,
	);
	assert.throws(() => placementFeature([{ ...offline, orchestrator: "never" }]), /Mac.*never/);
	assert.throws(
		() => placementFeature([offline, { ...linux, orchestrator: "never" }], { tags: ["gpu"] }, ["Linux box"], true),
		/Mac.*gpu.*Linux box.*never/,
	);
	// A machine that never reported is judged when it connects.
	const unreported = { ...offline, status: "waiting" as const, egress: undefined, screenshots: undefined };
	assert.equal(placementFeature([unreported], { screenshots: true }).featurePlan?.status, "approved");
	// Low disk is temporary: dispatch waits and retries after space becomes available.
	const full = { ...mac, freeDiskBytes: 5 * GiB - 1 };
	const waiting = dispatch(placementFeature([full]), [full]);
	assert.equal(waiting.question, null);
	assert.match(waiting.wait!.sentence, /disk/);
	assert.deepEqual(dispatch(waiting, [mac]).jobs![0].placement?.place, { kind: "machine", machineId: macId });
});
test("a removed machine or changed policy asks the owner at dispatch and at launch", () => {
	const mac = machineReport();
	const ready = placementFeature([mac]);
	const placed = dispatch(ready, [mac]);
	for (const machines of [[], [{ ...mac, orchestrator: "never" as const }]]) {
		const pending = dispatch(ready, machines);
		const late = advance(placed, {
			kind: "placement_wait",
			child: placed.jobs![0].id,
			key: currentKey(placed)!,
			at: 8,
			sentence: pending.wait!.sentence,
			refused: true,
		}).item;
		for (const item of [pending, late]) {
			assert.equal(item.wait?.reason, "person");
			assert.equal(item.wait?.retryAt, null);
			assert.match(item.question!.text, /Mac/);
			assert.ok(!item.question!.text.includes(macId));
			const answer = (choice: "revise" | "again" | "give_up") =>
				advance(item, { kind: "answer", choice, question: item.question!.id, at: 9, by: "owner" });
			assert.equal(answer("revise").item.run?.step.kind, "refine");
			assert.ok(answer("again").effects.some(e => e.kind === "dispatch"));
			const cancelled = answer("give_up");
			assert.ok(cancelled.item.jobs!.at(-1)?.cancelRequested);
			assert.ok(cancelled.effects.some(e => e.kind === "cancel_children"));
		}
	}
});

test("retrying a refused placement can launch on a newly available approved alternative", () => {
	const mac = machineReport(),
		linux = machineReport("Linux box", linuxId);
	const ready = placementFeature([mac, linux], {}, ["Linux box"], true);
	const denied = dispatch(ready, [{ ...linux, orchestrator: "never" }]);
	assert.equal(denied.question?.kind, "placement_refused");
	const retry = advance(denied, {
		kind: "answer",
		choice: "again",
		question: denied.question!.id,
		at: 8,
		by: "owner",
	}).item;
	const placed = dispatch(retry, [linux]);
	assert.deepEqual(placed.jobs![0].placement?.place, { kind: "machine", machineId: linuxId });
});

test("placement 5 enforces owner participation and explicit naming", () => {
	const named = machineReport("Mac", macId, { orchestrator: "named" });
	assert.equal(machineDetails({ whenToUse: "", tags: [] }).orchestrator, "yes");
	assert.throws(() => machineDetails({ whenToUse: "", tags: [], orchestrator: "sometimes" } as never));
	assert.throws(() => placementFeature([{ ...named, orchestrator: "never" }]), /never/i);
	assert.deepEqual(dispatch(placementFeature([named]), [named]).jobs![0].placement?.place, {
		kind: "machine",
		machineId: macId,
	});
	const p = proposal(),
		pending = proposed(p);
	pending.place = { kind: "machine", machineId: macId };
	assert.throws(
		() =>
			advance(pending, {
				kind: "approve_plan",
				at: 4,
				by: "owner",
				version: 1,
				inventory: { machines: plannerMachines([named]), hostedProfiles: [] },
			}),
		/named/i,
	);
});
test("placement 6 keeps the running child pinned and waits for an offline machine at the next boundary", () => {
	const mac = machineReport(),
		offline = { ...mac, status: "offline" as const, turns: { max: null, running: 0, queued: 0 } };
	const first = dispatch(placementFeature([mac]), [mac]);
	const working = advance(first, {
		kind: "child_update",
		key: currentKey(first)!,
		child: first.jobs![0].id,
		state: "working",
		head: null,
		report: "",
		spent: zero,
		at: 7,
	}).item;
	assert.equal(dispatch(working, [offline]), working);
	const second = advance(working, {
		kind: "child_update",
		key: currentKey(working)!,
		child: working.jobs![0].id,
		state: "done",
		head,
		report: "",
		spent: zero,
		at: 8,
	}).item;
	const waiting = dispatch(second, [{ ...offline, profiles: [], freeDiskBytes: null }]);
	assert.match(waiting.wait!.sentence, /Mac.*online/);
	assert.deepEqual(waiting.jobs![0].placement?.place, { kind: "machine", machineId: macId });
});
test("a preferred machine with room wins before approved overflow", () => {
	const mac = machineReport("Mac", macId, { turns: { max: 4, running: 4, queued: 0 } });
	const linux = machineReport("Linux box", linuxId, { host: { ...mac.host!, cpus: 2 } });
	const machines = [mac, linux];
	const chosen = dispatch(placementFeature(machines, {}, ["Linux box"], true), machines);
	assert.deepEqual(chosen.jobs![0].placement?.place, { kind: "machine", machineId: linuxId });
	const next = advance(chosen, {
		kind: "child_update",
		key: currentKey(chosen)!,
		child: chosen.jobs![0].id,
		state: "done",
		head,
		report: "",
		spent: zero,
		at: 7,
	}).item;
	const busy = { ...mac, turns: { max: 4, running: 3, queued: 1 } }; // 3 preferred + 1 free - 1 queued = 3
	assert.deepEqual(dispatch(next, [busy, linux]).jobs![1].placement?.place, { kind: "machine", machineId: macId });
	assert.deepEqual(dispatch(next, [busy, { ...linux, personalRunning: 2 }]).jobs![1].placement?.place, {
		kind: "machine",
		machineId: macId,
	});
});

interface ChildOptions {
	screenshots?: true;
	/** The subtasks' agent; left out: Windlass on the feature's model. */
	agent?: SubtaskAgent;
	/** The feature session's model and the feature's effort, which a Windlass subtask inherits. */
	featureModel?: string;
	featureEffort?: string;
	/** What makeSession refuses with, as a UserError of this code. */
	refuse?: { code: string; message: string };
	/** Pick the job of this subtask (default: the first). */
	subtask?: string;
	/** Agent catalogs available to placement. */
	models?: import("../server/src/factory/placement.js").AgentModels;
}
async function childCreation(t: import("node:test").TestContext, overflow = false, options: ChildOptions = {}) {
	const { CREDENTIAL_TABLES } = await import("../server/src/credentials/index.js");
	const { itemActions, ITEM_TABLES } = await import("../server/src/actors/user-items.js");
	const { serviceParams } = await import("../server/src/auth.js");
	const { DatabaseSync } = await import("node:sqlite");
	// A UserError as the server makes one (rivetkit resolves from the server package only).
	const { clientError } = await import("../server/src/auth.js");
	const mac = machineReport("Mac", macId, {
		allowedProfiles: ["docker-windlass-sandbox", "docker-hardened"],
		harnesses: [...signedIn],
		profiles: ["docker-windlass-sandbox", "docker-hardened"].map(id => ({ id, available: true }) as never),
		slots: { max: 3, busy: 0, queued: 0, unit: { cpus: 4, memoryBytes: 4 * GiB, pids: 1024 } },
	});
	const linux = { ...mac, machineId: linuxId, name: "Linux box" };
	const feature = placementFeature(
		[mac, linux],
		{ cpus: 8, screenshots: options.screenshots },
		["Linux box"],
		overflow,
		"Mac",
		options.agent,
	);
	if (options.featureEffort)
		feature.agent = {
			harness: "windlass",
			model: options.featureModel ?? "default",
			effort: options.featureEffort,
			tokens: "counted",
			reportedTokens: 0,
			cost: null,
			fiveHour: null,
		};
	const selected = dispatch(feature, [mac]);
	const first = selected.jobs![0];
	const job = options.subtask
		? { ...first, task: feature.featurePlan!.subtasks.find(s => s.key === options.subtask)!, placement: undefined }
		: first;
	const raw = new DatabaseSync(":memory:");
	t.after(() => raw.close());
	for (const sql of [...ITEM_TABLES, ...CREDENTIAL_TABLES]) raw.exec(sql);
	raw.exec((await import("../server/src/repository-defaults.js")).DEFAULTS_TABLE);
	raw.exec("INSERT INTO repository_defaults (project,label,updated_at,screenshots) VALUES ('github:42','fixture',1,1)");
	const owner = "u_fixture",
		sessionId = "s_feature",
		repository = { id: 42, branch: "main" };
	const request = {
		settings: { account: { model: options.featureModel, effort: options.featureEffort } },
		job: { ...job, dispatchKey: currentKey(selected)! },
		sessionId,
		feature: { ...feature, title: "Feature", repository, source: "web" },
		featureBody: feature.task.body,
		context: "{}",
		previous: { place: { kind: "machine", machineId: macId }, head, report: "Prior subtask report" },
	};
	const machines = new Map([[macId, mac], ...(overflow ? [[linuxId, linux] as const] : [])]);
	const itemIndex = new Map();
	let child: typeof feature | undefined;
	const facts: import("../server/src/factory/types.js").Fact[] = [];
	const parent = {
		internalChildRequest: async () => request,
		internalFact: async (fact: (typeof facts)[number]) => facts.push(fact),
	};
	const childActor = {
		internalSummary: async () => ({ ...child, title: "Child", createdAt: 1, sessionId: "s_child" }),
		internalView: async () => child,
		internalAct: async (_input: { action: { kind: string } }) => child,
	};
	const ctx = {
		key: [owner],
		conn: { params: serviceParams() },
		broadcast() {},
		log: { error() {}, warn() {} },
		vars: {
			usage: { modelTokens: () => 0 },
			items: { items: itemIndex, limits: { id: 0, overrides: {} } },
			profile: { uid: owner },
			sessions: new Map([
				[sessionId, { profile: "docker-hardened", place: { kind: "hosted" }, model: options.featureModel }],
			]),
			machines,
		},
		db: { execute: async (sql: string, ...args: never[]) => raw.prepare(sql).all(...args) },
		client: () => ({
			workItem: {
				get: ([, id]: string[]) => (id === job.id ? childActor : parent),
				create: async (_key: string[], { input }: { input: { item: typeof feature } }) => {
					child = input.item;
				},
			},
		}),
	};
	let sessionOrigin: import("../server/src/actors/user-items.js").ItemSessionInput | undefined;
	const delivered: { place: unknown; size?: number; profile?: string }[] = [];
	const sessions: { harness?: string; model?: string; effort?: string }[] = [];
	const started: string[] = [];
	childActor.internalAct = async (input: { action: { kind: string } }) => {
		started.push(input.action.kind);
		return child;
	};
	const create = (cancel = false) =>
		itemActions.internalFeatureChild(
			ctx as never,
			{ parent: feature.id, child: job.id, cancel },
			async (_owner, input, origin) => {
				if (options.refuse)
					throw clientError(
						{ error() {} },
						new Error(options.refuse.message),
						options.refuse.message,
						options.refuse.code,
					);
				sessionOrigin = origin;
				delivered.push({ place: input.place, size: origin.size, profile: input.profile });
				sessions.push({ harness: input.harness, model: input.model, effort: origin.effort });
				return { ...input, model: input.model ?? "default", repository, id: origin.sessionId } as never;
			},
			async () => options.models ?? {},
		);
	return {
		create,
		delivered,
		sessions,
		started,
		facts,
		machines,
		mac,
		raw,
		sessionOrigin: () => sessionOrigin,
		child: () => child,
	};
}

test("approved subtasks get the screenshots image only when marked and permitted", async t => {
	const { sessionSandboxInput } = await import("../server/src/actors/internal.js");
	const sandbox = { uid: "owner", sessionId: "child", profile: "docker-hardened" as const };
	for (const marked of [true, false]) {
		const fixture = await childCreation(t, false, marked ? { screenshots: true } : {});
		await fixture.create();
		const item = fixture.sessionOrigin();
		assert.ok(item, JSON.stringify(fixture.facts));
		assert.equal(item.subtaskScreenshots, marked);
		const session = {
			...sandbox,
			origin: {
				kind: "item" as const,
				itemId: item.itemId,
				role: item.role,
				subtaskScreenshots: item.subtaskScreenshots,
			},
		};
		assert.equal(sessionSandboxInput(session, true).screenshots, marked);
		assert.equal(sessionSandboxInput(session, false).screenshots, false);
	}
	for (const role of ["builder", "reviewer"] as const) {
		const session = { ...sandbox, origin: { kind: "item" as const, itemId: "item", role } };
		for (const allowed of [true, false]) assert.equal(sessionSandboxInput(session, allowed).screenshots, allowed);
	}
});

test("session sandbox creation retains a reported multi-slot size for replacement", async () => {
	const { sessionSandboxInput } = await import("../server/src/actors/internal.js");
	const origin = { kind: "item" as const, role: "builder" as const, itemId: "i_child", size: 2 };
	assert.equal(sessionSandboxInput({ uid: "owner", sessionId: "child", profile: "docker-hardened", origin }).size, 2);
});

test("child creation sends the chosen machine and size to its session and preserves them on replay", async t => {
	const { create, delivered, machines, mac, child } = await childCreation(t);
	await create();
	assert.deepEqual(delivered, [{ place: { kind: "machine", machineId: macId }, size: 2, profile: "docker-hardened" }]);
	assert.deepEqual(child()?.place, delivered[0].place);
	assert.equal(child()?.task.featureBody, task.body);
	assert.equal(child()?.placement?.reason, "Build on the owner's machine");
	machines.set(macId, { ...mac, status: "offline" });
	await create();
	assert.equal(delivered.length, 1);
});

test("child creation rechecks the owner's policy after dispatch", async t => {
	const { create, delivered, facts, machines, mac } = await childCreation(t);
	machines.set(macId, { ...mac, orchestrator: "never" });
	await create();
	assert.deepEqual(delivered, []);
	assert.equal(facts[0]?.kind, "placement_wait");
	assert.ok(facts[0]?.kind === "placement_wait" && facts[0].refused && facts[0].sentence.includes("Mac"));
});

test("cancelling a placement wait creates no child session", async t => {
	const { create, delivered } = await childCreation(t);
	await create(true);
	assert.deepEqual(delivered, []);
});

test("budget-only edits from older forms retain the approved overflow choice", () => {
	const plan = proposal();
	plan.overflow = true;
	const pending = proposed(plan);
	const { overflow, ...edit } = plan;
	const edited = advance(pending, { kind: "edit_plan", version: 1, plan: edit, at: 4, by: "owner" }).item;
	assert.equal(edited.featurePlan?.overflow, true);
});

test("unknown hard requirements cannot disappear during plan validation", () => {
	const p = proposal();
	Object.assign(p.subtasks[0], { needs: { memoryGB: 16 } });
	assert.throws(() => proposed(p), /memoryGB/);
});

test("a limited account waits or uses an approved alternative at the child boundary", () => {
	const machines = [machineReport(), machineReport("Linux box", linuxId)];
	for (const overflow of [false, true]) {
		const item = placementFeature(machines, {}, ["Linux box"], overflow);
		const selected = advance(item, {
			kind: "place_child",
			key: currentKey(item)!,
			at: 6,
			inventory: {
				machines: plannerMachines(machines),
				hostedProfiles: [],
				limited: [{ machineId: macId, harness: "windlass" }],
			},
		}).item;
		if (overflow) assert.deepEqual(selected.jobs![0].placement?.place, { kind: "machine", machineId: linuxId });
		else assert.match(selected.wait!.sentence, /usage limit.*Mac/);
	}
});

test("fresh placement retries the soonest approved wait and caps a long provider reset", () => {
	const at = 1000,
		hour = 3600_000;
	const machines = [machineReport(), machineReport("Linux box", linuxId, { turns: { running: 1, max: 1, queued: 0 } })];
	const place = (overflow: boolean, reset: number) => {
		const item = placementFeature(machines, {}, ["Linux box"], overflow);
		return advance(item, {
			kind: "place_child",
			at,
			key: currentKey(item)!,
			inventory: {
				machines: plannerMachines(machines),
				hostedProfiles: [],
				limited: [{ machineId: macId, harness: "windlass", limitedUntil: at + reset }],
			},
		});
	};
	for (const [overflow, reset, delay] of [
		[true, 4 * hour, 30_000],
		[true, 10_000, 10_000],
		[false, 168 * hour, 6 * hour],
	] as const) {
		const result = place(overflow, reset);
		assert.equal(result.item.wait?.retryAt, at + delay);
		assert.equal(result.effects.find(e => e.kind === "dispatch")?.at, at + delay);
	}
});

test("provider placement rechecks at UTC rollover when the daily cap also holds", () => {
	const machines = [machineReport()];
	const item = placementFeature(machines);
	const midnight = Date.UTC(2026, 10, 23),
		at = midnight - 1000,
		providerUntil = midnight + 3600_000;
	const key = currentKey(item)!;
	const inventory = {
		machines: plannerMachines(machines),
		hostedProfiles: [],
		dailyTokenWait: "Daily tokens used.",
		limited: [{ machineId: "plan/openai", harness: "windlass", limitedUntil: providerUntil }],
	};
	for (const result of [
		advance(item, { kind: "place_child", key, at, inventory }),
		advance(item, {
			kind: "placement_wait",
			key,
			child: item.jobs![0].id,
			at,
			dailyCap: true,
			providerUntil,
			sentence: "Waiting.",
		}),
	]) {
		assert.equal(result.item.wait?.retryAt, midnight);
		assert.equal(result.effects.find(e => e.kind === "dispatch")?.at, midnight);
	}
});

test("Windlass's ChatGPT plan cooldown covers hosted and every approved machine, in either order", () => {
	const machines = [machineReport(), machineReport("Linux box", linuxId)];
	for (const prefer of ["Mac", "hosted"]) {
		const item = placementFeature(machines, {}, prefer === "Mac" ? ["Linux box", "hosted"] : ["Mac"], true, prefer);
		const result = advance(item, {
			kind: "place_child",
			at: 6,
			key: currentKey(item)!,
			inventory: {
				machines: plannerMachines(machines),
				hostedProfiles: ["docker-hardened"],
				limited: [{ machineId: "plan/openai", harness: "windlass", limitedUntil: 1000 }],
			},
		});
		assert.equal(result.item.wait?.reason, "provider");
		assert.equal(result.item.jobs![0].placement, undefined);
	}
});

test("hosted requires an approved route and a deployment profile", () => {
	const mac = machineReport();
	const item = placementFeature([mac]);
	assert.match(dispatch(item, []).wait!.sentence, /no longer one of your machines/);
	const p = proposal();
	p.subtasks[0].place = { prefer: "hosted", reason: "Use the hosted sandbox" };
	assert.throws(
		() =>
			advance(proposed(p), {
				kind: "approve_plan",
				version: 1,
				by: "person",
				at: 5,
				inventory: { machines: plannerMachines([mac]), hostedProfiles: [] },
			}),
		/hosted.*profile/,
	);
});

const signedIn = [
	{ id: "claude", adapter: "fixture", image: "fixture", signIn: "token" },
	{ id: "opencode", adapter: "fixture", image: "fixture", signIn: "token" },
] as const;
const agentMac = (overrides: Partial<MachineSummary> = {}) =>
	machineReport("Mac", macId, {
		harnesses: [...signedIn],
		profiles: [
			{ id: "docker-windlass-sandbox", available: true },
			{ id: "docker-hardened", available: true },
		] as never,
		allowedProfiles: ["docker-windlass-sandbox", "docker-hardened"],
		...overrides,
	});
const claudeModels = {
	source: "harness" as const,
	defaultModel: "default",
	fetchedAt: 1,
	models: [
		{ id: "default", name: "Default", efforts: [] },
		{ id: "sonnet", name: "Sonnet", efforts: ["low", "high"] },
	],
};
const windlassModels = {
	source: "account" as const,
	defaultModel: "gpt-5.5",
	fetchedAt: 1,
	models: [
		{ id: "gpt-5.5", name: null, efforts: ["medium", "high"] },
		{ id: "gpt-5.5-mini", name: null, efforts: [] },
	],
};
/** A plan whose first subtask runs Claude Code on Sonnet and whose second inherits the feature's Windlass model. */
function mixedPlan() {
	const p = proposal();
	for (const sub of p.subtasks) sub.place = { prefer: "Mac", reason: "Build on the owner's machine" };
	p.subtasks[0].agent = { harness: "claude", model: "sonnet", effort: "high" };
	return p;
}

test("plan proposals preserve an explicit agent for the approval check", () => {
	for (const harness of ["claude", "opencode"] as const) {
		const p = proposal();
		p.subtasks[0].agent = { harness, model: "m-1", effort: "high" };
		assert.deepEqual(proposed(p).featurePlan?.subtasks[0].agent, { harness, model: "m-1", effort: "high" });
	}
	const codex = proposal();
	codex.subtasks[0].agent = { harness: "codex" };
	assert.equal(proposed(codex).featurePlan?.subtasks[0].agent?.harness, "codex");
	const windlass = proposal();
	windlass.subtasks[0].agent = { harness: "windlass" };
	assert.deepEqual(proposed(windlass).featurePlan?.subtasks[0].agent, { harness: "windlass" });
	// A plan filed before subtasks named their agent: its harness need is read as the agent.
	const older = proposal();
	Object.assign(older.subtasks[0], { needs: { harness: "opencode" } });
	assert.deepEqual(proposed(older).featurePlan?.subtasks[0].agent, { harness: "opencode" });
	for (const bad of [
		{ effort: "high" },
		{},
		{ harness: "nonesuch" },
		{ harness: "claude", model: "a b" },
		{ harness: "claude", extra: 1 },
		{ harness: "claude", effort: "x".repeat(65) },
	]) {
		const p = proposal();
		Object.assign(p.subtasks[0], { agent: bad });
		assert.throws(() => proposed(p));
	}
	const profile = proposal();
	Object.assign(profile.subtasks[0], { agent: { harness: "claude" }, needs: { profile: "docker-windlass-sandbox" } });
	assert.throws(() => proposed(profile), /Claude Code requires Open isolation/);
});

test("approval names each agent that works without asking, and needs the person's confirmation of every one", () => {
	const plan = mixedPlan();
	plan.subtasks[0].title = "Build the search index";
	const item = proposed(plan);
	assert.match(
		item.question!.text,
		/Build the search index .* Claude Code \(sonnet, high effort\), works without asking/,
	);
	assert.match(item.question!.text, /page .* the resolved default agent/);
	assert.match(item.question!.text, /“Build the search index” would run an agent that works without asking/);
	const inventory = { machines: plannerMachines([agentMac()]), hostedProfiles: [] };
	const approve = { kind: "approve_plan" as const, version: 1, at: 4, by: "person:owner", inventory };
	for (const agents of [undefined, [], ["page"]])
		assert.throws(
			() => advance(item, { ...approve, agents }),
			/index: confirm that it runs Claude Code, which works without asking/,
		);
	assert.throws(
		() =>
			advance(item, {
				kind: "answer",
				at: 4,
				by: "person:owner",
				question: item.question!.id,
				choice: "approve",
				inventory,
			}),
		/confirm that it runs Claude Code/,
	);
	assert.equal(advance(item, { ...approve, agents: ["index"] }).item.featurePlan?.status, "approved");
});

test("the planner's proposal cannot pick an agent the place does not offer, has not signed in, or a model it does not list", () => {
	const route = { preferred: { kind: "machine" as const, machineId: macId }, alternatives: [] };
	const task = (agent: SubtaskAgent) => ({
		...proposal().subtasks[0],
		place: { prefer: "Mac", reason: "here" },
		agent,
	});
	const models = { machines: { [macId]: { claude: claudeModels } }, windlass: windlassModels };
	const refused = (agent: SubtaskAgent, machine: MachineSummary, pattern: RegExp) => {
		const fit = choosePlacement(task(agent), route, {
			machines: plannerMachines([machine]),
			hostedProfiles: ["docker-hardened"],
			models,
		});
		assert.equal(fit.decision, undefined, JSON.stringify(agent));
		assert.equal(fit.permanent, true);
		assert.match(String(fit.refused), pattern);
	};
	refused({ harness: "opencode" }, agentMac({ harnesses: [signedIn[0]] }), /‘Mac’: it does not offer OpenCode/);
	refused(
		{ harness: "claude" },
		agentMac({ harnesses: [{ ...signedIn[0], signIn: "none" }] }),
		/Claude Code is not signed in there/,
	);
	refused(
		{ harness: "claude" },
		agentMac({ harnesses: [{ ...signedIn[0], signIn: "unknown" }] }),
		/could not say whether Claude Code is signed in/,
	);
	refused(
		{ harness: "claude" },
		agentMac({ allowedProfiles: ["docker-windlass-sandbox"] }),
		/does not allow the Open profile, which Claude Code needs/,
	);
	refused({ harness: "claude", model: "opus" }, agentMac(), /Claude Code: That model is not offered/);
	refused(
		{ harness: "claude", model: "sonnet", effort: "max" },
		agentMac(),
		/effort for sonnet must be one of: low, high/,
	);
	refused(
		{ harness: "windlass", model: "o9" },
		agentMac(),
		/Windlass: That model is not among the ones your ChatGPT plan offers/,
	);
	refused(
		{ harness: "codex" },
		agentMac(),
		/Plan-first subtasks run Windlass, Claude Code or OpenCode for now\. Codex runs Quick items only\./,
	);
	const hosted = choosePlacement(
		task({ harness: "claude" }),
		{ preferred: { kind: "hosted" }, alternatives: [] },
		{ machines: [], hostedProfiles: ["docker-hardened"] },
	);
	assert.match(String(hosted.refused), /Add an Anthropic key on the Connections page to run Claude Code here/);
	const keyed = choosePlacement(
		task({ harness: "claude" }),
		{ preferred: { kind: "hosted" }, alternatives: [] },
		{
			machines: [],
			hostedProfiles: ["e2b-open"],
			keyProfiles: ["e2b-open"],
			hostedCredentials: [{ provider: "anthropic", checkedAt: null }],
		},
	);
	assert.equal(keyed.decision?.harness, "claude");
	assert.equal(keyed.decision?.profile, "e2b-open");
	const hostedRoute = { preferred: { kind: "hosted" as const }, alternatives: [] };
	const inventory = {
		machines: plannerMachines([agentMac()]),
		hostedProfiles: ["e2b-open" as const],
		keyProfiles: ["e2b-open" as const],
		hostedCredentials: [{ provider: "anthropic" as const, checkedAt: 1, models: ["claude-haiku-5-5"] }],
		models,
	};
	assert.equal(
		choosePlacement(task({ harness: "claude", model: "haiku" }), hostedRoute, inventory).decision?.place.kind,
		"hosted",
	);
	const withModel = task({ harness: "claude", model: "sonnet" });
	assert.match(String(choosePlacement(withModel, hostedRoute, inventory).refused), /model is not offered/);
	const withScreenshots = { ...task({ harness: "claude" }), needs: { screenshots: true } };
	assert.match(String(choosePlacement(withScreenshots, hostedRoute, inventory).refused), /cannot file screenshots/);
	assert.ok(
		choosePlacement(
			withScreenshots,
			{ ...hostedRoute, alternatives: [route.preferred] },
			{
				...inventory,
				machines: plannerMachines([agentMac({ screenshots: true })]),
			},
		).refused,
	);
	assert.equal(
		choosePlacement(withModel, { ...hostedRoute, alternatives: [route.preferred] }, inventory).decision?.name,
		"Mac",
	);
	const microVm = choosePlacement({ ...task({ harness: "windlass" }), needs: { profile: "e2b-open" } }, route, {
		machines: plannerMachines([agentMac()]),
		hostedProfiles: [],
	});
	assert.match(String(microVm.refused), /profile runs only on hosted/);
	// What the place offers is placed, in the hardened container, naming its agent.
	const placed = choosePlacement(task({ harness: "claude", model: "sonnet", effort: "high" }), route, {
		machines: plannerMachines([agentMac()]),
		hostedProfiles: [],
		models,
	}).decision;
	assert.equal(placed?.harness, "claude");
	assert.equal(placed?.profile, "docker-hardened");
	// Approval refuses such a proposal, with the reason, before any subtask runs.
	const p = proposal();
	p.subtasks[0].place = { prefer: "Mac", reason: "here" };
	p.subtasks[0].agent = { harness: "opencode" };
	assert.throws(
		() =>
			advance(proposed(p), {
				kind: "approve_plan",
				version: 1,
				at: 4,
				by: "person",
				agents: ["index"],
				inventory: { machines: plannerMachines([agentMac({ harnesses: [signedIn[0]] })]), hostedProfiles: [] },
			}),
		/index: ‘Mac’: it does not offer OpenCode/,
	);
	// Windlass children keep the machine's first allowed profile and name no harness.
	const windlass = dispatch(placementFeature([agentMac()]), [agentMac()]).jobs![0].placement;
	assert.equal(windlass?.harness, undefined);
	assert.equal(windlass?.profile, "docker-windlass-sandbox");
});

test("usage-limit routing picks among accounts of the subtask's own agent", () => {
	const machines = [agentMac(), { ...agentMac(), name: "Linux box", machineId: linuxId }];
	const item = placementFeature(machines, {}, ["Linux box"], true, "Mac", { harness: "claude" });
	const place = (limited: { machineId: string; harness: string; limitedUntil?: number }[]) =>
		advance(item, {
			kind: "place_child",
			at: 6,
			key: currentKey(item)!,
			inventory: { machines: plannerMachines(machines), hostedProfiles: [], limited },
		}).item;
	// Windlass's limit on the Mac (or everywhere) is not Claude Code's: the Mac takes it.
	for (const machineId of [macId, "plan/openai"])
		assert.deepEqual(place([{ machineId, harness: "windlass", limitedUntil: 1000 }]).jobs![0].placement?.place, {
			kind: "machine",
			machineId: macId,
		});
	// Claude Code limited on the Mac: the approved alternative's Claude Code account takes it.
	assert.deepEqual(place([{ machineId: macId, harness: "claude", limitedUntil: 1000 }]).jobs![0].placement?.place, {
		kind: "machine",
		machineId: linuxId,
	});
	// Limited on both: it waits for the soonest reset of Claude Code.
	const waiting = place([
		{ machineId: macId, harness: "claude", limitedUntil: 5000 },
		{ machineId: linuxId, harness: "claude", limitedUntil: 2000 },
	]);
	assert.equal(waiting.wait?.reason, "provider");
	assert.match(waiting.wait!.sentence, /claude|Claude Code/);
});

test("a re-plan keeps each remaining subtask's agent unless the person changes it", () => {
	const p = mixedPlan();
	const machines = [agentMac()];
	const inventory = { machines: plannerMachines(machines), hostedProfiles: [] };
	let item = advance(proposed(p), {
		kind: "approve_plan",
		version: 1,
		at: 4,
		by: "person",
		agents: ["index"],
		inventory,
	}).item;
	item = advance(item, { kind: "feature_ready", key: currentKey(item)!, at: 5, head, pr }).item;
	item = advance(item, { kind: "place_child", key: currentKey(item)!, at: 6, inventory }).item;
	const job = item.jobs![0];
	item = advance(item, {
		kind: "child_update",
		key: currentKey(item)!,
		at: 7,
		child: job.id,
		state: "failed",
		spent: { ...zero, turns: 1 },
		report: "",
		head: null,
	}).item;
	assert.equal(item.run?.step.kind, "refine");
	// The planner files the re-plan moving both subtasks to other agents: the approved ones are kept.
	const replan = mixedPlan();
	replan.subtasks[0].agent = { harness: "opencode" };
	replan.subtasks[1].agent = { harness: "claude" };
	replan.subtasks[0].budget.tokens -= 1000;
	const key = currentKey(item)!;
	let filed = advance(item, { kind: "file_plan", key, plan: replan, at: 8 }).item;
	assert.deepEqual(
		filed.featurePlan?.subtasks.map(s => s.agent),
		[{ harness: "claude", model: "sonnet", effort: "high" }, undefined],
	);
	filed = advance(filed, {
		kind: "turn_ended",
		key,
		at: 9,
		outcome: "succeeded",
		changes: false,
		report: null,
		verified: null,
		flags: [],
		spend: { tokens: 10, hostedSeconds: 1 },
	}).item;
	assert.equal(filed.question?.kind, "replan_approval");
	// The person changes one on the card: their choice is the plan's.
	const edit = structuredClone(filed.featurePlan!);
	edit.subtasks[1].agent = { harness: "opencode" };
	const edited = advance(filed, {
		kind: "edit_plan",
		version: filed.featurePlan!.version,
		plan: edit,
		at: 10,
		by: "person",
	}).item;
	assert.deepEqual(
		edited.featurePlan?.subtasks.map(s => s.agent?.harness),
		["claude", "opencode"],
	);
	assert.throws(
		() =>
			advance(edited, {
				kind: "approve_plan",
				version: edited.featurePlan!.version,
				at: 11,
				by: "person",
				agents: ["index"],
				inventory,
			}),
		/page: confirm that it runs OpenCode/,
	);
});

test("a re-plan can't keep a machine agent on a subtask it moves out of the hardened profile", () => {
	const machines = [agentMac()];
	const inventory = { machines: plannerMachines(machines), hostedProfiles: [] };
	let item = advance(proposed(mixedPlan()), {
		kind: "approve_plan",
		version: 1,
		at: 4,
		by: "person",
		agents: ["index"],
		inventory,
	}).item;
	item = advance(item, { kind: "feature_ready", key: currentKey(item)!, at: 5, head, pr }).item;
	item = advance(item, { kind: "place_child", key: currentKey(item)!, at: 6, inventory }).item;
	item = advance(item, {
		kind: "child_update",
		key: currentKey(item)!,
		at: 7,
		child: item.jobs![0].id,
		state: "failed",
		spent: { ...zero, turns: 1 },
		report: "",
		head: null,
	}).item;
	// The planner leaves the agent out (the approved one is kept) and asks for the Windlass sandbox profile.
	const replan = mixedPlan();
	delete replan.subtasks[0].agent;
	replan.subtasks[0].needs = { profile: "docker-windlass-sandbox" };
	replan.subtasks[0].budget.tokens -= 1000;
	assert.throws(
		() => advance(item, { kind: "file_plan", key: currentKey(item)!, plan: replan, at: 8 }),
		/index: Claude Code requires Open isolation/,
	);
	// Placement refuses such a subtask for good, wherever it came from.
	const task = { ...mixedPlan().subtasks[0], needs: { profile: "docker-windlass-sandbox" as const } };
	const fit = choosePlacement(task, { preferred: { kind: "machine", machineId: macId }, alternatives: [] }, inventory);
	assert.equal(fit.decision, undefined);
	assert.equal(fit.permanent, true);
	assert.match(
		String(fit.refused),
		/‘Mac’: Claude Code runs only in the Open profile, and the subtask asks for Strict/,
	);
});

test("a Windlass subtask choosing only an effort is held to the feature's model at approval", () => {
	const route = { preferred: { kind: "machine" as const, machineId: macId }, alternatives: [] };
	const task = (effort: string) => ({
		...proposal().subtasks[0],
		place: { prefer: "Mac", reason: "here" },
		agent: { harness: "windlass" as const, effort },
	});
	const fit = (effort: string, featureModel?: string) =>
		choosePlacement(task(effort), route, {
			machines: plannerMachines([agentMac()]),
			hostedProfiles: [],
			models: { windlass: windlassModels },
			featureModel,
		});
	assert.match(String(fit("max", "gpt-5.5").refused), /Windlass: .*effort for gpt-5\.5 must be one of: medium, high/);
	assert.match(String(fit("high", "gpt-5.5-mini").refused), /Windlass: gpt-5\.5-mini takes no reasoning effort/);
	assert.equal(fit("high", "gpt-5.5").decision?.place.kind, "machine");
	// The feature's model not known: the child's creation judges it.
	assert.equal(fit("max").decision?.place.kind, "machine");
	// Approval refuses it with the reason, before any subtask runs.
	const p = proposal();
	for (const sub of p.subtasks) sub.place = { prefer: "Mac", reason: "here" };
	p.subtasks[0].agent = { harness: "windlass", effort: "max" };
	assert.throws(
		() =>
			advance(proposed(p), {
				kind: "approve_plan",
				version: 1,
				at: 4,
				by: "person",
				inventory: {
					machines: plannerMachines([agentMac()]),
					hostedProfiles: [],
					models: { windlass: windlassModels },
					featureModel: "gpt-5.5",
				},
			}),
		/index: ‘Mac’: Windlass: .*effort for gpt-5\.5/,
	);
});

test("dispatch places a subtask by its agent's models: overflow skips a machine that doesn't offer the model", async t => {
	const without = { ...claudeModels, models: claudeModels.models.filter(m => m.id !== "sonnet") };
	const models = { machines: { [macId]: { claude: without }, [linuxId]: { claude: claudeModels } } };
	const run = await childCreation(t, true, { agent: { harness: "claude", model: "sonnet" }, models });
	await run.create();
	assert.deepEqual(
		run.delivered.map(d => d.place),
		[{ kind: "machine", machineId: linuxId }],
	);
	assert.equal(run.child()?.placement?.harness, "claude");
	// No place offers it: the feature hears the reason, and nothing is made.
	const nowhere = await childCreation(t, true, {
		agent: { harness: "claude", model: "sonnet" },
		models: { machines: { [macId]: { claude: without }, [linuxId]: { claude: without } } },
	});
	await nowhere.create();
	assert.deepEqual(nowhere.delivered, []);
	assert.ok(
		nowhere.facts[0]?.kind === "placement_wait" &&
			nowhere.facts[0].refused &&
			/Claude Code: That model is not offered/.test(nowhere.facts[0].sentence),
		JSON.stringify(nowhere.facts),
	);
});

test("the models each agent offers are read from every machine at once", async () => {
	const { agentModels } = await import("../server/src/actors/user.js");
	let asked = 0,
		release!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	const options = { models: [{ id: "sonnet", name: "Sonnet", efforts: [] }], defaultModel: "sonnet" };
	const catalog = {
		internalCatalog: async () => {
			asked += 1;
			await gate;
			return options;
		},
	};
	const machines = new Map(
		[macId, linuxId].map(
			id =>
				[
					id,
					{ ...agentMac(), machineId: id, harnesses: signedIn.map(h => ({ ...h, optionsDigest: "d-" + h.id })) },
				] as const,
		),
	);
	const ctx = {
		key: ["u_fixture"],
		vars: { profile: null, machines },
		client: () => ({ machine: { get: () => catalog } }),
	};
	const read = agentModels(ctx as never);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(asked, 4, "every catalog is asked before any answers");
	release();
	const models = await read;
	assert.deepEqual(Object.keys(models.machines ?? {}).sort(), [macId, linuxId].sort());
	assert.deepEqual(Object.keys(models.machines![macId]!).sort(), ["claude", "opencode"]);
});

test("child items count tokens only for metered agents; a budgeted agent's silent turn stops the child", async () => {
	const { agentTurn, turnSpend } = await import("../server/src/factory/budget.js");
	const usage = {
		inputTokens: 3000,
		outputTokens: 2000,
		cachedReadTokens: 0,
		cachedWriteTokens: 0,
		reasoningTokens: 0,
	} as never;
	const child = (harness: "claude" | "opencode") => {
		const made = createItem({
			id: "i_child_" + harness,
			task,
			place: { kind: "machine", machineId: macId },
			budget: single,
			reviewer: { off: "deployment" },
			agent: { harness, model: "default" },
		});
		made.parent = { itemId: "i_feature", key: "index", title: "Feature" };
		let o = advance(made, { kind: "start", at: 1, by: "platform" });
		o = advance(o.item, { kind: "turn_started", at: 2, key: currentKey(o.item)! });
		return (spend: ReturnType<typeof turnSpend>) =>
			advance(o.item, {
				kind: "turn_ended",
				at: 3,
				key: currentKey(o.item)!,
				outcome: "succeeded",
				verified: null,
				flags: [],
				changes: true,
				report: null,
				spend,
			}).item;
	};
	const claude = child("claude")(turnSpend(usage, agentTurn("claude", usage, null)));
	assert.equal(claude.spent.tokens, 0);
	assert.equal(claude.agent?.tokens, "subscription");
	const openCode = child("opencode")(turnSpend(usage, agentTurn("opencode", usage, { cost: null })));
	assert.ok(openCode.spent.tokens > 0);
	assert.equal(openCode.agent?.tokens, "counted");
	const silent = child("opencode")(turnSpend(null, agentTurn("opencode", null, { cost: null })));
	assert.equal(silent.question?.text, "OpenCode did not report token use, so the item's budget can't be enforced.");
});

test("a plan with mixed agents is approved, and every child starts on its own agent and model", async t => {
	const feature = { featureModel: "gpt-5.5", featureEffort: "medium" };
	// The Claude Code subtask: its own model and effort, never the feature's Windlass model.
	const claude = await childCreation(t, false, {
		...feature,
		agent: { harness: "claude", model: "sonnet", effort: "high" },
	});
	await claude.create();
	assert.deepEqual(claude.sessions, [{ harness: "claude", model: "sonnet", effort: "high" }]);
	assert.equal(claude.delivered[0]?.profile, "docker-hardened");
	assert.deepEqual(
		[claude.child()?.agent?.harness, claude.child()?.agent?.model, claude.child()?.agent?.effort],
		["claude", "sonnet", "high"],
	);
	assert.equal(claude.child()?.placement?.harness, "claude");
	assert.deepEqual(claude.started, ["start"]);
	// An OpenCode subtask with no model chosen starts on OpenCode's own default.
	const openCode = await childCreation(t, false, { ...feature, agent: { harness: "opencode" } });
	await openCode.create();
	assert.deepEqual(openCode.sessions, [{ harness: "opencode", model: undefined, effort: undefined }]);
	assert.equal(openCode.child()?.agent?.model, "default");
	// The fixture’s saved Windlass model and effort apply to a part with no override.
	const windlass = await childCreation(t, false, feature);
	await windlass.create();
	assert.deepEqual(windlass.sessions, [{ harness: "windlass", model: "gpt-5.5", effort: "medium" }]);
	assert.equal(windlass.child()?.agent?.harness, "windlass");
	// A Windlass subtask with its own model takes only the effort chosen with it.
	const mini = await childCreation(t, false, { ...feature, agent: { harness: "windlass", model: "gpt-5.5-mini" } });
	await mini.create();
	assert.deepEqual(mini.sessions, [{ harness: "windlass", model: "gpt-5.5-mini", effort: "medium" }]);
	// Through the blueprint: both subtasks of one mixed plan are approved and placed on their own agents.
	const inventory = {
		machines: plannerMachines([agentMac()]),
		hostedProfiles: [],
		models: { machines: { [macId]: { claude: claudeModels } }, windlass: windlassModels },
	};
	let item = advance(proposed(mixedPlan()), {
		kind: "approve_plan",
		version: 1,
		at: 4,
		by: "person",
		agents: ["index"],
		inventory,
	}).item;
	item = advance(item, { kind: "feature_ready", key: currentKey(item)!, at: 5, head, pr }).item;
	item = advance(item, { kind: "place_child", key: currentKey(item)!, at: 6, inventory }).item;
	assert.equal(item.jobs![0].placement?.harness, "claude");
	const { resolveRun } = await import("../server/src/factory/resolve-run.js");
	const context = { account: { model: "gpt-5.5", effort: "medium" } };
	const run = resolveRun(context, "part", item.jobs![0].task);
	assert.equal(run.model, "sonnet");
	assert.equal(run.effort, "high");
	assert.equal(resolveRun(context, "part", item.featurePlan!.subtasks[1]).model, "gpt-5.5");
});

test("a child its place refuses at creation can't be placed: the feature asks with the reason, and nothing stays pinned", async t => {
	const refusal = await childCreation(t, false, {
		agent: { harness: "claude", model: "opus" },
		refuse: { code: "bad_input", message: "That model is not offered. Choose one of: default, sonnet" },
	});
	await refusal.create();
	assert.deepEqual(refusal.delivered, []);
	const fact = refusal.facts[0];
	assert.ok(
		fact?.kind === "placement_wait" &&
			fact.refused &&
			fact.sentence === "‘Mac’: That model is not offered. Choose one of: default, sonnet",
		JSON.stringify(fact),
	);
	assert.equal(refusal.raw.prepare("SELECT count(*) AS n FROM child_launch").get()?.n, 0);
	// The feature takes that fact as a "can't place" question naming the subtask and the reason.
	const item = placementFeature([agentMac()], {}, [], false, "Mac", { harness: "claude" });
	const placed = dispatch(item, [agentMac()]);
	const asked = advance(placed, {
		kind: "placement_wait",
		at: 7,
		key: currentKey(placed)!,
		child: placed.jobs![0].id,
		sentence: fact.sentence,
		refused: true,
	}).item;
	assert.equal(asked.question?.kind, "placement_refused");
	assert.equal(asked.question?.text, "index: ‘Mac’: That model is not offered. Choose one of: default, sonnet");
	// A failure that is not a refusal is retried, not asked about.
	const outage = await childCreation(t, false, {
		agent: { harness: "claude" },
		refuse: { code: "internal_error", message: "engine away" },
	});
	await assert.rejects(() => outage.create(), /engine away/);
	assert.deepEqual(outage.facts, []);
});

test("5c.5 a Windlass limit still gates every approved machine at child creation", async t => {
	for (const overflow of [false, true]) {
		const { raw, create, delivered, facts } = await childCreation(t, overflow);
		const until = Date.now() + 3600_000;
		raw.exec("CREATE TABLE machines(id TEXT PRIMARY KEY, facts TEXT, expires INTEGER)");
		raw.prepare("INSERT INTO machines VALUES(?, '{}', NULL)").run(macId);
		raw.exec(
			"CREATE TABLE IF NOT EXISTS provider_usage(place TEXT,harness TEXT,generation TEXT,data TEXT,PRIMARY KEY(place,harness))",
		);
		for (const table of (await import("../server/src/credentials/plans.js")).MODEL_PLAN_TABLES) raw.exec(table);
		raw.exec(
			"INSERT INTO model_plan (provider, sealed, generation, added_at, check_ok) VALUES ('openai', 'x', '1', 0, 1)",
		);
		const { recordProviderUsage } = await import("../server/src/actors/provider-accounts.js");
		type Db = Parameters<typeof recordProviderUsage>[0];
		const db = {
			execute: async (sql: string, ...args: never[]) => raw.prepare(sql).all(...args),
			transaction: async <T>(work: (tx: Db) => Promise<T>) => work(db),
		} as Db;
		// A machine's Windlass turn on the ChatGPT sign-in: the ChatGPT plan's limit, which holds every machine.
		await recordProviderUsage(db, { place: macId, harness: "windlass" }, "1", {
			kind: "refusal",
			at: Date.now(),
			resetsAt: until,
		});
		await create();
		assert.equal(delivered.length, 0);
		assert.ok(facts[0]?.kind === "placement_wait" && !facts[0].refused && facts[0].providerUntil === until);
	}
});

test("5c.2 unknown resets back off on the ChatGPT plan, and only a successful real probe clears the streak", async t => {
	const { DatabaseSync } = await import("node:sqlite");
	const { machineTables } = await import("../server/src/actors/user-machines.js");
	const raw = new DatabaseSync(":memory:");
	t.after(() => raw.close());
	type Db = Parameters<typeof machineTables>[0];
	const db = {
		execute: async (sql: string, ...args: never[]) => raw.prepare(sql).all(...args),
		transaction: async <T>(work: (tx: Db) => Promise<T>) => work(db),
	} as Db;
	await machineTables(db);
	for (const table of (await import("../server/src/credentials/plans.js")).MODEL_PLAN_TABLES) raw.exec(table);
	raw.exec(
		"INSERT INTO model_plan (provider, sealed, generation, added_at, check_ok) VALUES ('openai', 'x', '1', 0, 1)",
	);
	const { recordProviderUsage, providerAccounts } = await import("../server/src/actors/provider-accounts.js");
	const location = { place: "hosted", harness: "windlass" as const };
	let now = Date.now();
	for (const minutes of [15, 30, 60, 120, 240, 300, 300]) {
		const refusal = { kind: "refusal" as const, at: now, resetsAt: null };
		await recordProviderUsage(db, location, "1", refusal);
		await recordProviderUsage(db, location, "1", refusal);
		assert.equal(raw.prepare("SELECT count(*) AS n FROM provider_usage").get()?.n, 0, "kept on the plan's row");
		const account = (await providerAccounts(db, now)).get("plan/openai")?.[0];
		assert.equal(account?.state, "limited");
		assert.equal(account.limitedUntil, now + minutes * 60_000);
		now = account.limitedUntil!;
	}
	await recordProviderUsage(db, location, "1", { kind: "success", startedAt: now, at: now + 1 });
	await recordProviderUsage(db, location, "1", { kind: "refusal", at: now + 2, resetsAt: null });
	assert.equal((await providerAccounts(db, now + 2)).get("plan/openai")?.[0].limitedUntil, now + 2 + 15 * 60_000);
});

test("legacy Windlass sign-in rows move their longest running cooldown onto the ChatGPT plan on upgrade", async t => {
	const { DatabaseSync } = await import("node:sqlite");
	const { machineTables } = await import("../server/src/actors/user-machines.js");
	const { PROVIDER_TABLE, providerAccounts, moveWindlassLimits } = await import(
		"../server/src/actors/provider-accounts.js"
	);
	const raw = new DatabaseSync(":memory:");
	t.after(() => raw.close());
	const db = { execute: async (sql: string, ...args: never[]) => raw.prepare(sql).all(...args) } as Parameters<
		typeof machineTables
	>[0];
	raw.exec(PROVIDER_TABLE);
	for (const table of (await import("../server/src/credentials/plans.js")).MODEL_PLAN_TABLES) raw.exec(table);
	raw.exec(
		"INSERT INTO model_plan (provider, sealed, generation, added_at, check_ok) VALUES ('openai', 'x', '2', 0, 1)",
	);
	const now = Date.now();
	for (const [place, generation, until] of [
		[macId, "1", now + 900_000],
		["hosted", "2", now + 200_000],
		[linuxId, "2", now + 400_000],
	] as const) {
		const account = {
			key: `${place}/windlass/${generation}`,
			harness: "windlass",
			state: "limited",
			limitedUntil: until,
			windows: [],
		};
		raw
			.prepare("INSERT INTO provider_usage VALUES(?,?,?,?)")
			.run(place, "windlass", generation, JSON.stringify({ account, backoff: 1, lastRefusal: 1, lastSuccess: -1 }));
	}
	await machineTables(db);
	await moveWindlassLimits(db, now);
	await moveWindlassLimits(db, now);
	const accounts = await providerAccounts(db, now);
	assert.equal(accounts.get("plan/openai")?.[0]?.key, "plan/openai/2");
	assert.equal(accounts.get("plan/openai")?.[0]?.limitedUntil, now + 400_000);
	assert.equal(raw.prepare("SELECT count(*) AS n FROM provider_usage").get()?.n, 0);
});

test("5c.7 new machine login ignores a stale refusal; page and stored reading contain only public window data", async t => {
	const { DatabaseSync } = await import("node:sqlite");
	const { machineTables, listMachines } = await import("../server/src/actors/user-machines.js");
	const raw = new DatabaseSync(":memory:");
	t.after(() => raw.close());
	type Db = Parameters<typeof machineTables>[0];
	const db = {
		execute: async (sql: string, ...args: never[]) => raw.prepare(sql).all(...args),
		transaction: async <T>(work: (tx: Db) => Promise<T>) => work(db),
	} as Db;
	await machineTables(db);
	for (const table of (await import("../server/src/credentials/plans.js")).MODEL_PLAN_TABLES) raw.exec(table);
	const generation = "a".repeat(32),
		next = "b".repeat(32),
		at = Date.now();
	const facts = (loginGeneration: string) =>
		JSON.stringify({
			status: "online",
			report: {
				docker: { ok: true },
				commandSandbox: { ok: true },
				freeDiskBytes: null,
				sandboxes: [],
				harnesses: [{ id: "claude", adapter: "fixture", image: "fixture", signIn: "token", loginGeneration }],
			},
		});
	raw
		.prepare("INSERT INTO machines(id, name,os,arch,facts) VALUES(?, 'Mac','darwin','arm64',?)")
		.run(macId, facts(generation));
	assert.ok(
		raw.prepare("SELECT 1 FROM sqlite_master WHERE name='provider_usage'").get(),
		"new logins have no account state to reset",
	);
	const { recordProviderUsage, providerAccounts } = await import("../server/src/actors/provider-accounts.js");
	const { claudeLimit } = await import("../server/src/provider-usage.js");
	const location = { place: macId, harness: "claude" as const };
	const reset = Math.floor(at / 1000) + 7200;
	const event = claudeLimit(
		{
			status: "rejected",
			rateLimitType: "five_hour",
			resetsAt: reset,
			utilization: 1,
			email: "canary@example.invalid",
			token: "canary-token",
			accountId: "canary-account",
		},
		at,
	)!;
	await recordProviderUsage(db, location, generation, { kind: "event", event });
	assert.equal((await providerAccounts(db, at)).get(macId)?.[0].limitedUntil, reset * 1000);
	await recordProviderUsage(db, location, generation, { kind: "refusal", at: at + 1, resetsAt: reset * 1000 });
	await recordProviderUsage(db, location, generation, {
		kind: "event",
		event: { status: "allowed", window: { ...event.window, usedPct: 0, observedAt: at + 2 } },
	});
	for (const table of (await import("../server/src/credentials/index.js")).CREDENTIAL_TABLES) raw.exec(table);
	const [machine] = await listMachines({ db, key: ["u_orch"], vars: { sessions: new Map() } });
	assert.equal(machine?.providerAccounts?.[0].limitedUntil, reset * 1000 + 60_000);
	assert.doesNotMatch(JSON.stringify([machine, raw.prepare("SELECT * FROM provider_usage").all()]), /canary/);
	raw.prepare("UPDATE machines SET facts=? WHERE id=?").run(facts(next), macId);
	assert.equal(
		await recordProviderUsage(db, location, generation, { kind: "refusal", at: at + 3, resetsAt: null }),
		false,
	);
	assert.equal((await providerAccounts(db, at + 3)).size, 0);
});

// ---------------------------------------------------------------------------------------------
// Cross-repo features (factory/cross-repo.ts): two repositories, one plan, one active child, a draft
// PR per repository, a combined run before hand-over, merges in the approved order.
// ---------------------------------------------------------------------------------------------

const crossSingle = { tokens: 10000, hostedSeconds: 4000 };
const sha = (c: string) => c.repeat(40);
const crossRepos = (): import("../server/src/contract.js").FeatureRepository[] => [
	{
		alias: "platform",
		repositoryId: 11,
		installationId: 5,
		owner: "ada",
		name: "platform",
		url: "https://github.com/ada/platform",
		private: false,
		baseRef: "main",
		planningBaseSha: sha("1"),
	},
	{
		alias: "cli",
		repositoryId: 12,
		installationId: 6,
		owner: "ada",
		name: "cli",
		url: "https://github.com/ada/cli",
		private: false,
		baseRef: "main",
		planningBaseSha: sha("2"),
	},
];
const crossProposal = (): FeaturePlanEdit => ({
	spec: {
		goal: "Show a new model capability",
		requirements: ["The CLI reports it", "The platform shows it"],
		outOfScope: [],
		acceptance: ["Both work together"],
	},
	questions: [],
	singleSuggested: null,
	subtasks: [
		// The same owned paths in two repositories are two sets of paths.
		{
			key: "cli",
			repo: "cli",
			title: "CLI field",
			brief: "Add the optional field",
			acceptance: ["Run bun test"],
			owns: ["src/**"],
			dependsOn: [],
			budget: { tokens: 3000 },
		},
		{
			key: "platform",
			repo: "platform",
			title: "Platform reader",
			brief: "Read the field when present",
			acceptance: ["Run pnpm test"],
			owns: ["src/**"],
			dependsOn: ["cli"],
			budget: { tokens: 3000 },
		},
	],
	repos: ["platform", "cli"],
	mergeOrder: [
		{
			repo: "cli",
			prerequisite: [],
			intermediate: "The released platform ignores the new field",
			evidence: "The old parser reads the new output",
			fallback: "Leave the field unused",
		},
		{
			repo: "platform",
			prerequisite: ["cli"],
			intermediate: "The platform falls back when the field is absent",
			evidence: "Absent and present cases",
			fallback: "Revert the reader",
		},
	],
	releaseGate: "request",
	finalIntegration: {
		runFrom: "platform",
		command: "bash scripts/cross-repo-integration.sh",
		inputs: ["platform", "cli"],
		profile: "actions",
		timeoutSeconds: 3600,
		requiredCases: ["models-check with the candidate CLI"],
		artifactOutputs: [],
	},
});
const crossItem = () =>
	createItem({
		id: "i_cross",
		task,
		mode: "orchestrate",
		repos: crossRepos(),
		place: { kind: "hosted" },
		budget: crossSingle,
		reviewer: { on: true },
	});
function crossProposed(p = crossProposal()) {
	const item = advance(crossItem(), { kind: "start", at: 1, by: "person" }).item,
		key = currentKey(item)!;
	const filed = advance(item, { kind: "file_plan", key, plan: p, at: 2 });
	assert.equal(filed.item.featurePlan?.version, 1, "the cross-repo plan was not filed");
	return advance(filed.item, {
		kind: "turn_ended",
		key,
		at: 3,
		outcome: "succeeded",
		changes: false,
		report: null,
		verified: null,
		flags: [],
		spend: { tokens: 10, hostedSeconds: 1 },
	}).item;
}
const step = (item: ReturnType<typeof crossItem>, fact: Record<string, unknown>) =>
	advance(item, { key: currentKey(item)!, at: 10, ...fact } as never);
/** Approved, both repositories seeded and opened: the first child is dispatched. */
function crossOpened() {
	let item = advance(crossProposed(), { kind: "approve_plan", version: 1, at: 4, by: "person:owner" }).item;
	for (const [repo, c] of [
		["platform", "3"],
		["cli", "4"],
	] as const)
		item = step(item, { kind: "feature_seed", repo, sha: sha(c) }).item;
	item = step(item, {
		kind: "feature_ready",
		waitForCiOnEachPart: true,
		repo: "platform",
		head: sha("5"),
		pr: { number: 1, url: "https://github.com/ada/platform/pull/1" },
	}).item;
	return step(item, {
		kind: "feature_ready",
		waitForCiOnEachPart: true,
		repo: "cli",
		head: sha("6"),
		pr: { number: 1, url: "https://github.com/ada/cli/pull/1" },
	});
}
/** Every child integrated: the combined run is asked for. */
function crossIntegrating() {
	let item = crossOpened().item;
	for (const [n, c] of [
		[0, "7"],
		[1, "8"],
	] as const)
		item = step(item, {
			kind: "child_update",
			child: item.jobs![n].id,
			state: "done",
			spent: zero,
			report: "done",
			head: sha(c),
		}).item;
	return item;
}

test("a one-repository planning turn's file_plan offers only single-repository fields and ignores cross-repo plan values", async () => {
	const { readFileSync } = await import("node:fs");
	const { platformTools } = await import("../server/src/agent-publish.js");
	const { validatePlan } = await plans();
	// Keep the single-repository declaration and validated plan independent of cross-repo features.
	const before = JSON.parse(readFileSync(new URL("../fixtures/one-repo-plan/main.json", import.meta.url), "utf8"));
	assert.deepEqual(
		platformTools({ plan: true, publish: false, report: false, push: false }, 600_000),
		before.declaration,
	);
	const cross = platformTools({ plan: true, publish: false, report: false, push: false, crossRepo: true }, 600_000)[0];
	const props = (
		cross.inputSchema as { properties: Record<string, { items?: { properties?: Record<string, unknown> } }> }
	).properties;
	for (const key of ["repos", "mergeOrder", "releaseGate", "earlyChecks", "finalIntegration"])
		assert.ok(key in props, `a cross-repo planning turn is not offered ${key}`);
	assert.ok("repo" in props.subtasks.items!.properties!);
	// Empty or default cross-repo values, and any others, are not read for one repository: the plan comes out as it always did.
	assert.deepEqual(validatePlan(before.withExtras, single), before.validated);
	assert.deepEqual(validatePlan(before.plan, single), before.validated);
	const named = {
		...before.plan,
		repos: ["platform", "cli"],
		releaseGate: "wait",
		finalIntegration: { runFrom: "cli" },
		subtasks: before.plan.subtasks.map((s: object) => ({ ...s, repo: "cli" })),
	};
	assert.deepEqual(validatePlan(named, single), before.validated);
	// The same through a one-repository item's planning turn: filed.
	const item = advance(
		createItem({
			id: "i_feature",
			task,
			mode: "orchestrate",
			place: { kind: "hosted" },
			budget: single,
			reviewer: { on: true },
		}),
		{ kind: "start", at: 1, by: "person" },
	).item;
	const filed = advance(item, { kind: "file_plan", key: currentKey(item)!, plan: before.withExtras, at: 2 }).item;
	assert.equal(filed.featurePlan?.version, 1, "a one-repository plan with empty cross-repo values was refused");
	assert.equal(filed.featurePlan!.repos, undefined);
});

test("cross-repo: a plan over the filing's two repositories validates, with identical paths in different repositories", async () => {
	const { validatePlan, planScope } = await plans();
	const plan = validatePlan(crossProposal(), crossSingle, ["platform", "cli"]);
	assert.deepEqual(
		plan.subtasks.map(s => s.repo),
		["cli", "platform"],
	);
	assert.equal(plan.finalIntegration?.runFrom, "platform");
	// The same paths in one repository, independent of each other, overlap.
	const same = crossProposal();
	same.subtasks[1].repo = "cli";
	same.subtasks[1].dependsOn = [];
	same.subtasks.push({ ...same.subtasks[0], key: "web", repo: "platform", owns: ["web/**"], dependsOn: [] });
	assert.doesNotThrow(() => validatePlan(same, crossSingle, ["platform", "cli"]));
	// Editing a cross-repo field changes the approved scope; a one-repository plan keeps its old fingerprint.
	const moved = structuredClone(plan);
	moved.finalIntegration!.command = "pnpm test";
	assert.notEqual(planScope(moved), planScope(plan));
	const one = proposal();
	assert.equal(planScope(one), JSON.stringify([false, one.spec, one.subtasks.map(({ budget, ...rest }) => rest)]));
});

test("cross-repo: refusals name the problem (third repo, unknown repo, empty command, cycles, merge chains, missing tasks and order)", async () => {
	const { validatePlan } = await plans();
	const filing = ["platform", "cli"];
	const cases: [string, (p: FeaturePlanEdit) => void, RegExp][] = [
		["a third repository", p => p.repos!.push("docs"), /at most 2 repositories/],
		["a repository not in the filing", p => (p.subtasks[0].repo = "docs"), /docs is not a repository of this feature/],
		["an empty final command", p => (p.finalIntegration!.command = " "), /command/],
		["a dependency cycle across repositories", p => (p.subtasks[0].dependsOn = ["platform"]), /acyclic/],
		["an A→B→A merge chain", p => p.mergeOrder!.push({ ...p.mergeOrder![0] }), /appears twice in the merge order/],
		[
			"a cycle of merge prerequisites",
			p => {
				p.mergeOrder![0].prerequisite = ["platform"];
			},
			/comes earlier in the merge order/,
		],
		["a write repository with no task", p => (p.subtasks[1].repo = "cli"), /Give platform at least one subtask/],
		["a repository missing from the merge order", p => p.mergeOrder!.pop(), /Put platform in the merge order/],
		[
			"inputs that leave out a repository",
			p => (p.finalIntegration!.inputs = ["platform"]),
			/must take cli as an input/,
		],
		["waiting for a release in the pilot", p => (p.releaseGate = "wait"), /not offered yet/],
	];
	for (const [what, mutate, expected] of cases) {
		const p = crossProposal();
		mutate(p);
		assert.throws(() => validatePlan(p, crossSingle, filing), expected, what);
	}
	// A one-repository feature does not read cross-repo fields (as before them), and a cross-repo one refuses a plan without them.
	const one = validatePlan(crossProposal(), crossSingle);
	assert.equal(one.repos, undefined);
	assert.equal(one.finalIntegration, undefined);
	assert.ok(one.subtasks.every(s => s.repo === undefined));
	const bare = proposal();
	assert.throws(() => validatePlan(bare, crossSingle, filing), /repository/);
	// Planner-supplied answers are dropped when the planner files.
	const answered = crossProposal();
	answered.questions.push({ id: "who", text: "Who releases?", answer: "the planner" });
	assert.equal(crossProposed(answered).featurePlan!.questions[0].answer, undefined);
});

test("cross-repo: the planner is told where the sibling is, and the card shows the merge order", async () => {
	const start = advance(crossItem(), { kind: "start", at: 1, by: "person" });
	assert.match(
		start.effects.find(e => e.kind === "deliver")!.text,
		/cli \(ada\/cli, base main\) is read-only at \.windlass-inputs\/cli/,
	);
	// The sibling's tree is a repository the person bound with write access, trusted as the primary's files are: nothing is marked.
	assert.equal((start.effects.find(e => e.kind === "deliver") as { untrusted?: string[] }).untrusted, undefined);
	const card = crossProposed().question!.text;
	assert.match(card, /\[cli\] CLI field/);
	assert.match(card, /Merge order — cli, then platform after cli/);
	assert.doesNotMatch(card, /Reserved/);
});

test("cross-repo: approval opens each repository in turn, both can have PR #1, and a replayed fact makes no second PR", () => {
	const approved = advance(crossProposed(), { kind: "approve_plan", version: 1, at: 4, by: "person:owner" });
	assert.ok(
		approved.effects.some(e => e.kind === "dispatch"),
		"approval did not start opening",
	);
	assert.equal(approved.item.jobs, undefined);
	let item = approved.item;
	const seeded = step(item, { kind: "feature_seed", repo: "platform", sha: sha("3") });
	assert.equal(seeded.item.repos![0].seed, sha("3"));
	assert.equal(seeded.item.seed, sha("3"));
	// The same seed again (a crash after GitHub answered): nothing changes.
	assert.equal(
		advance(seeded.item, { kind: "feature_seed", key: currentKey(item)!, repo: "platform", sha: sha("9"), at: 11 })
			.item,
		seeded.item,
	);
	item = step(seeded.item, { kind: "feature_seed", repo: "cli", sha: sha("4") }).item;
	const a = step(item, {
		kind: "feature_ready",
		repo: "platform",
		head: sha("5"),
		pr: { number: 1, url: "https://github.com/ada/platform/pull/1" },
	});
	assert.equal(a.item.jobs, undefined, "a child ran before every repository had its draft");
	const replay = advance(a.item, {
		kind: "feature_ready",
		key: currentKey(item)!,
		repo: "platform",
		head: sha("5"),
		pr: { number: 2, url: "x" },
		at: 12,
	});
	assert.equal(replay.item, a.item, "a second PR was recorded for the platform");
	const { item: opened, effects } = crossOpened();
	assert.deepEqual(
		opened.repos!.map(r => r.pr!.number),
		[1, 1],
	);
	assert.equal(opened.pr!.url, "https://github.com/ada/platform/pull/1");
	assert.ok(
		effects.some(e => e.kind === "link_prs"),
		"the PRs were not linked",
	);
	// One active child across the pair: the CLI's subtask, started at the CLI's draft marker.
	assert.equal(opened.jobs!.length, 1);
	assert.equal(opened.jobs![0].task.repo, "cli");
	assert.equal(opened.jobs![0].start, sha("6"));
});

test("cross-repo: an opening refused in one repository keeps the other, and retries only the refused one", async () => {
	const { nextOpening } = await import("../server/src/factory/cross-repo.js");
	let item = advance(crossProposed(), { kind: "approve_plan", version: 1, at: 4, by: "person:owner" }).item;
	for (const [repo, c] of [
		["platform", "3"],
		["cli", "4"],
	] as const)
		item = step(item, { kind: "feature_seed", repo, sha: sha(c) }).item;
	item = step(item, { kind: "feature_ready", repo: "platform", head: sha("5"), pr: { number: 1, url: "u" } }).item;
	const problem = { kind: "feature_problem", reason: "ada/cli: draft pull requests are not supported in ada/cli" };
	const retry = step(item, problem);
	assert.ok(retry.effects.some(e => e.kind === "dispatch"));
	const refused = step(retry.item, problem).item;
	assert.equal(refused.question!.kind, "integration");
	assert.equal(refused.repos![0].pr!.number, 1, "the opened PR was dropped");
	const again = advance(refused, {
		kind: "answer",
		question: refused.question!.id,
		choice: "again",
		by: "person",
		at: 20,
	});
	assert.ok(again.effects.some(e => e.kind === "dispatch"));
	assert.equal(nextOpening(again.item)!.repo.alias, "cli");
});

test("cross-repo: children integrate into their own repository's head, and the combined run starts on both", async () => {
	const { readyRefusal } = await import("../server/src/factory/cross-repo.js");
	let item = crossOpened().item;
	const first = step(item, {
		kind: "child_update",
		child: item.jobs![0].id,
		state: "done",
		spent: zero,
		report: "done",
		head: sha("7"),
	});
	assert.equal(first.item.repos![1].head, sha("7"));
	assert.equal(first.item.head, sha("5"), "a CLI commit became the platform PR's head");
	assert.equal(first.item.jobs![1].task.repo, "platform");
	assert.equal(first.item.jobs![1].start, sha("5"));
	item = step(first.item, {
		kind: "child_update",
		child: first.item.jobs![1].id,
		state: "done",
		spent: zero,
		report: "done",
		head: sha("8"),
	}).item;
	assert.equal(item.run!.step.kind, "integration");
	assert.equal(item.wait!.reason, "integration");
	assert.deepEqual(item.integration!.heads, { platform: sha("8"), cli: sha("7") });
	assert.equal(item.head, sha("8"));
	// Never Ready from here: the platform refuses to mark a cross-repo PR ready, on any path.
	assert.match(readyRefusal(item)!, /stay drafts/);
	assert.equal(
		readyRefusal(
			createItem({
				id: "i_one",
				task,
				mode: "orchestrate",
				place: { kind: "hosted" },
				budget: single,
				reviewer: { on: true },
			}),
		),
		null,
	);
});

test("cross-repo: a failed run asks, a cancelled one is retried once at the same heads, and its time is charged once", () => {
	let item = crossIntegrating();
	const integration = currentKey(item)!;
	const started = step(item, {
		kind: "integration_started",
		attempt: 1,
		runId: "77",
		url: "https://github.com/ada/platform/actions/runs/77",
	});
	assert.ok(started.effects.some(e => e.kind === "poll_integration"));
	item = started.item;
	item = step(item, { kind: "integration_read", attempt: 1, state: "running", url: null, said: null }).item;
	assert.equal(item.integration!.state, "running");
	const retried = step(item, {
		kind: "integration_read",
		attempt: 1,
		state: "cancelled",
		url: null,
		said: "the runner was lost",
		seconds: 300,
	});
	assert.equal(retried.item.question, null);
	const spent = retried.item.spent.activeSeconds;
	assert.equal(
		advance(retried.item, {
			kind: "integration_read",
			key: integration,
			attempt: 1,
			state: "cancelled",
			url: null,
			said: null,
			seconds: 300,
			at: 30,
		} as never).item,
		retried.item,
	);
	assert.equal(retried.item.integration!.attempt, 2);
	assert.equal(retried.item.integration!.retries, 1);
	assert.deepEqual(retried.item.integration!.heads, { platform: sha("8"), cli: sha("7") });
	const second = step(step(retried.item, { kind: "integration_started", attempt: 2, runId: "78", url: null }).item, {
		kind: "integration_read",
		attempt: 2,
		state: "timed_out",
		url: null,
		said: null,
		seconds: 10,
	}).item;
	assert.ok(!second.question!.choices.some(c => c.id === "again"), "a second same-input retry was offered");
	assert.equal(second.spent.activeSeconds, spent + 10);
	const failed = step(
		step(crossIntegrating(), { kind: "integration_started", attempt: 1, runId: "79", url: null }).item,
		{ kind: "integration_read", attempt: 1, state: "failed", url: null, said: "models-check failed" },
	).item;
	assert.ok(failed.question!.choices.some(c => c.id === "revise"));
	const replanned = advance(failed, {
		kind: "answer",
		question: failed.question!.id,
		choice: "revise",
		by: "person",
		at: 50,
	});
	const replan = replanned.item;
	assert.equal(replan.run!.step.kind, "refine");
	// The repair re-plan quotes the combined run's result: marked as such for Windlass.
	assert.deepEqual((replanned.effects.find(e => e.kind === "deliver") as { untrusted?: string[] }).untrusted, [
		"the combined run's result",
	]);
	assert.equal(replan.replans, 1);
});

test("cross-repo: a pass leads to the summary, both descriptions, and a hand-over whose merges are recorded in order", () => {
	let item = step(crossIntegrating(), { kind: "integration_started", attempt: 1, runId: "77", url: null }).item;
	const passed = step(item, {
		kind: "integration_read",
		attempt: 1,
		state: "passed",
		url: "https://github.com/ada/platform/actions/runs/77",
		said: null,
		seconds: 600,
	});
	item = passed.item;
	assert.equal(item.run!.step.kind, "summary");
	// The summary quotes the subtasks' reports and the combined run's result: both marked.
	assert.deepEqual((passed.effects.find(e => e.kind === "deliver") as { untrusted?: string[] }).untrusted, [
		"reports of the feature's subtasks",
		"the combined run's result",
	]);
	const report = { title: "Feature", description: "Done", look_at: "", concerns: "", screenshots: [] };
	const described = step(step(item, { kind: "turn_started" }).item, {
		kind: "turn_ended",
		outcome: "succeeded",
		verified: null,
		flags: [],
		changes: false,
		report,
		spend: { tokens: 1, hostedSeconds: 1 },
	});
	assert.ok(described.effects.some(e => e.kind === "describe_feature"));
	const handed = step(described.item, {
		kind: "published",
		head: sha("8"),
		pr: described.item.pr,
		openItems: 1,
		webhooks: true,
	});
	item = handed.item;
	assert.equal(item.state, "review");
	assert.equal(item.run!.step.kind, "merged");
	assert.ok(
		!handed.effects.some(e => e.kind === "handoff" || e.kind === "poll_ci"),
		"the one-PR hand-over ran on a cross-repo feature",
	);
	assert.deepEqual(
		handed.effects.filter(e => e.kind === "poll_repo_pr").map(e => (e as { repo: string }).repo),
		["platform", "cli"],
	);
	const read = (
		it: typeof item,
		repo: string,
		state: string,
		prHead: string | null,
		mergedCommit: string | null = null,
		mergedAt: number | null = null,
		at = 60,
	) =>
		advance(it, {
			kind: "repo_pr_read",
			key: `${currentKey(it)}/${repo}`,
			repo,
			state,
			prHead,
			mergedCommit,
			mergedAt,
			at,
		} as never);
	// Nothing new: no revision.
	assert.equal(read(item, "cli", "draft", sha("7")).item.repos![1].prState, "draft");
	const same = read(item, "cli", "draft", sha("7")).item;
	assert.equal(read(same, "cli", "draft", sha("7")).item, same);
	// The platform is read merged before the CLI the order puts first has been read again: the CLI is read now, nothing asked yet.
	const platformFirst = read(item, "platform", "merged", sha("8"), sha("e"), 2_000);
	assert.equal(platformFirst.item.question, null, "the merge order was judged by poll order");
	assert.equal(platformFirst.item.repos![0].mergedCommit, sha("e"));
	assert.equal(platformFirst.item.repos![0].mergedAt, 2_000);
	assert.deepEqual(
		platformFirst.effects
			.filter(e => e.kind === "poll_repo_pr")
			.map(e => [(e as { repo: string }).repo, (e as { at: number }).at]),
		[["cli", 60]],
	);
	// GitHub merged the CLI first (both merged between two polls): in order, done.
	const both = read(platformFirst.item, "cli", "merged", sha("7"), sha("c"), 1_000, 61).item;
	assert.equal(both.question, null);
	assert.equal(both.state, "done");
	// The CLI merged after the platform: by GitHub's times, out of order, though the platform was read first.
	const late = read(platformFirst.item, "cli", "merged", sha("7"), sha("c"), 3_000, 61).item;
	assert.equal(late.question!.kind, "integration");
	assert.match(late.question!.text, /before cli/);
	assert.notEqual(late.state, "done");
	// The CLI is still open on its fresh reading: the platform merged early.
	const early = read(platformFirst.item, "cli", "draft", sha("7"), null, null, 61).item;
	assert.equal(early.question!.kind, "integration");
	assert.match(early.question!.text, /before cli/);
	// Read in the other order, with the CLI merged later than the platform: still early.
	const cliRead = read(item, "cli", "merged", sha("7"), sha("c"), 3_000).item;
	assert.equal(cliRead.state, "review");
	assert.match(read(cliRead, "platform", "merged", sha("8"), sha("d"), 2_000).item.question!.text, /before cli/);
	// In order: the CLI (squash-merged as its own commit), then the platform: done.
	const cli = read(item, "cli", "merged", sha("7"), sha("c"), 1_000).item;
	assert.equal(cli.state, "review");
	assert.equal(cli.repos![1].mergedCommit, sha("c"));
	const done = read(cli, "platform", "merged", sha("8"), sha("d"), 2_000).item;
	assert.equal(done.state, "done");
	// Merged at a commit other than the one tested together: stale, and a question, never done.
	const movedMerge = read(cli, "platform", "merged", sha("a"), sha("d"), 2_000).item;
	assert.equal(movedMerge.integration!.state, "stale");
	assert.equal(movedMerge.question!.kind, "integration");
	assert.match(movedMerge.question!.text, /merged at aaaaaaa, not at 8888888/);
	assert.notEqual(movedMerge.state, "done");
	// Accepting it once nothing is left to watch ends the feature.
	const accepted = advance(movedMerge, {
		kind: "answer",
		question: movedMerge.question!.id,
		choice: "wait",
		by: "person",
		at: 70,
	}).item;
	assert.equal(accepted.state, "done");
	// Closed without merging: a question.
	assert.match(read(item, "cli", "closed", sha("7")).item.question!.text, /closed without merging/);
	// Someone pushed to a PR after the run: that result is stale.
	assert.equal(read(item, "cli", "draft", sha("f")).item.integration!.state, "stale");
});

test("cross-repo: a PR the platform lost access to asks the person, sections stop once the feature ends, and a sibling's webhook wakes only its own poll", async () => {
	const { live, lostAccess, siblingWakes } = await import("../server/src/actors/work-item.js");
	const { GithubError } = await import("../server/src/github/app.js");
	const { GithubProblem } = await import("../server/src/github/repos.js");
	let item = step(crossIntegrating(), { kind: "integration_started", attempt: 1, runId: "77", url: null }).item;
	const integrating = item;
	item = step(item, { kind: "integration_read", attempt: 1, state: "passed", url: null, said: null, seconds: 1 }).item;
	const report = { title: "Feature", description: "Done", look_at: "", concerns: "", screenshots: [] };
	const described = step(step(item, { kind: "turn_started" }).item, {
		kind: "turn_ended",
		outcome: "succeeded",
		verified: null,
		flags: [],
		changes: false,
		report,
		spend: { tokens: 1, hostedSeconds: 1 },
	});
	const handed = step(described.item, {
		kind: "published",
		head: sha("8"),
		pr: described.item.pr,
		openItems: 1,
		webhooks: true,
	}).item;
	const lost = advance(handed, {
		kind: "repo_pr_lost",
		key: `${currentKey(handed)}/cli`,
		repo: "cli",
		said: "ada/cli is archived on GitHub, so nothing can be pushed to it.",
		at: 60,
	}).item;
	assert.equal(lost.question!.kind, "integration");
	assert.match(lost.question!.text, /ada\/cli#1 cannot be read any more: ada\/cli is archived/);
	const resumed = advance(lost, { kind: "answer", question: lost.question!.id, choice: "wait", by: "person", at: 70 });
	assert.equal(resumed.item.state, "review");
	assert.deepEqual(
		resumed.effects.filter(e => e.kind === "poll_repo_pr").map(e => (e as { repo: string }).repo),
		["platform", "cli"],
	);
	// Denied, gone and archived are not tried again; a rate limit or an outage is.
	assert.ok(
		lostAccess(new GithubProblem("github_denied", "archived")) && lostAccess(new GithubProblem("github_gone", "gone")),
	);
	assert.ok(
		lostAccess(new GithubError(404, "Not Found", "read")) &&
			lostAccess(new GithubError(403, "Repository was archived so is read-only.", "write")),
	);
	assert.ok(
		!lostAccess(new GithubError(500, "", "read")) &&
			!lostAccess(new GithubError(429, "", "read")) &&
			!lostAccess(new GithubProblem("github_unreachable", "later")),
	);
	// The managed sections are written while the feature runs, never after it ended.
	assert.ok(live(handed, { kind: "link_prs", key: currentKey(handed)! }));
	const ended = advance(lost, {
		kind: "answer",
		question: lost.question!.id,
		choice: "give_up",
		by: "person",
		at: 80,
	}).item;
	assert.equal(ended.state, "failed");
	assert.ok(
		!live(ended, { kind: "link_prs", key: currentKey(handed)! }),
		"an ended feature still writes its PR sections",
	);
	// The CLI's webhook: its own PR's poll once handed over, never the primary's poll (both are PR #1) before.
	const cli = handed.repos![1];
	const nudge = { kind: "pr" as const, pr: 1, installationId: cli.installationId, repositoryId: cli.repositoryId };
	assert.ok(siblingWakes(handed, cli, nudge));
	assert.ok(!siblingWakes(integrating, cli, nudge), "a sibling's webhook woke a poll before the hand-over");
	assert.ok(!siblingWakes(handed, cli, { ...nudge, installationId: 999 }));
	assert.ok(
		!siblingWakes(handed, cli, {
			kind: "ci",
			head: sha("7"),
			installationId: cli.installationId,
			repositoryId: cli.repositoryId,
		}),
	);
});

test("cross-repo: the feature's own session reaches both repositories' hosts within what the deployment's hosts leave, the primary's first", async () => {
	const { unionHosts, networkLimit } = await import("../server/src/repository-network.js");
	const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}.example.org`);
	const deployment = names("d", 50); // 64 hosts in all: 14 left for the repositories' lists
	const limit = networkLimit(deployment);
	assert.equal(limit, 14);
	const primary = names("p", 10),
		sibling = names("s", 10);
	const union = unionHosts([primary, sibling], limit);
	assert.equal(union.length, limit, "the union went past what the deployment's hosts leave");
	for (const host of primary) assert.ok(union.includes(host), `the primary's ${host} was left out`);
	assert.equal(union.filter(h => h.startsWith("s")).length, 4);
	// A host both lists name takes one place; with room for all, every host is there.
	assert.deepEqual(unionHosts([["a.example.org"], ["a.example.org", "b.example.org"]], 40), [
		"a.example.org",
		"b.example.org",
	]);
});

test("cross-repo: feedback on its PRs is declined, and one implementer leaves the sibling out", () => {
	const item = step(crossIntegrating(), { kind: "integration_started", attempt: 1, runId: "1", url: null }).item;
	const declined = advance(item, {
		kind: "github_feedback",
		at: 70,
		ids: ["c1"],
		text: "fix",
		fingerprint: "f",
		others: false,
		by: "github:ada",
		writers: ["ada"],
	});
	assert.equal(declined.feedback![0].state, "declined");
	const single = proposal(); // a suggestion of one item has no subtasks
	const suggested = crossProposed({ ...crossProposal(), subtasks: [], singleSuggested: "One change is enough." });
	assert.match(suggested.question!.text, /cli would be left out/);
	const converted = advance(suggested, {
		kind: "answer",
		question: suggested.question!.id,
		choice: "run_single",
		by: "person",
		at: 80,
	}).item;
	assert.equal(converted.repos!.length, 1);
	assert.equal(converted.mode, "single");
	void single;
});

test("cross-repo: the Windlass CLI's CI on main and PRs only is refused by name, and CI on every branch is admitted", async () => {
	const { readFileSync } = await import("node:fs");
	const { repositoryAdmission, workflowReportsPush } = await import("../server/src/github/feature-ci.js");
	const main = readFileSync(new URL("../fixtures/windlass-ci/main.yml", import.meta.url), "utf8");
	const any = readFileSync(new URL("../fixtures/windlass-ci/any-branch.yml", import.meta.url), "utf8");
	const branches = ["windlass/feature-i_cross", "windlass/cli-field-0123456789abcdef"];
	assert.equal(workflowReportsPush(main, branches[0]), false);
	for (const branch of branches) assert.equal(workflowReportsPush(any, branch), true);
	const app = (ci: string, base = sha("2")) =>
		({
			settings: { slug: "windlass", appId: "1" },
			call: async ({ path }: { path: string }) => {
				if (path.endsWith("/git/ref/heads/main")) return { body: { object: { sha: base } } };
				if (path.endsWith("/actions/workflows"))
					return { body: { workflows: [{ path: ".github/workflows/ci.yml", state: "active" }] }, next: false };
				if (path.includes("matching-refs")) return { body: [] };
				throw new Error("unexpected " + path);
			},
			fileAt: async () => ci,
		}) as never;
	const input = {
		alias: "cli",
		baseRef: "main",
		ciBase: "main",
		branches,
		planningBaseSha: sha("2"),
		runsIntegration: false,
		opened: false,
	};
	const refused = await repositoryAdmission(app(main), "t", "WindlassAI", "windlass", input);
	assert.equal(refused.length, 1);
	assert.match(refused[0], /^WindlassAI\/windlass: push CI does not run on windlass\/\*\* branches/);
	assert.deepEqual(await repositoryAdmission(app(any), "t", "WindlassAI", "windlass", input), []);
	// A base that moved since the planner read it is named, and passes once the person reconfirms the new commit.
	const moved = await repositoryAdmission(app(any, sha("9")), "t", "WindlassAI", "windlass", input);
	assert.match(moved[0], /moved from 2222222 to 9999999/);
	assert.deepEqual(
		await repositoryAdmission(app(any, sha("9")), "t", "WindlassAI", "windlass", { ...input, reconfirmed: sha("9") }),
		[],
	);
	// A reconfirmed base is taken only when it is the head read now, and never for a branch already opened.
	assert.match(
		(
			await repositoryAdmission(app(any, sha("9")), "t", "WindlassAI", "windlass", { ...input, reconfirmed: sha("5") })
		)[0],
		/bases names 5555555 for cli, but main is at 9999999/,
	);
	assert.match(
		(await repositoryAdmission(app(any), "t", "WindlassAI", "windlass", { ...input, reconfirmed: sha("5") }))[0],
		/bases names 5555555 for cli, but main is at 2222222/,
	);
	assert.match(
		(
			await repositoryAdmission(app(any), "t", "WindlassAI", "windlass", {
				...input,
				opened: true,
				reconfirmed: sha("2"),
			})
		)[0],
		/feature branch is open already/,
	);
	// The repository the combined run starts from needs the integration workflow, enabled, in its base's tree.
	const workflow = (state: string | null) =>
		({
			settings: { slug: "windlass", appId: "1" },
			call: async ({ path, query }: { path: string; query?: Record<string, string> }) => {
				if (path.endsWith("/git/ref/heads/main")) return { body: { object: { sha: sha("2") } } };
				if (path.endsWith("/actions/workflows/windlass-integration.yml")) {
					if (state === null) {
						const { GithubError } = await import("../server/src/github/app.js");
						throw new GithubError(404, "Not Found", "look");
					}
					return { body: { state } };
				}
				if (path.endsWith("/actions/workflows"))
					return { body: { workflows: [{ path: ".github/workflows/ci.yml", state: "active" }] }, next: false };
				if (path.includes("/contents/")) {
					assert.equal(query?.ref, sha("2"), "the workflow was not read at the base's commit");
					return { body: {} };
				}
				throw new Error("unexpected " + path);
			},
			fileAt: async (_t: string, _o: string, _r: string, path: string, at: string) => {
				assert.match(at, /^[0-9a-f]{40}$/);
				return path.endsWith("ci.yml") ? any : integrationText;
			},
		}) as never;
	const reference = readFileSync(new URL("../.github/workflows/windlass-integration.yml", import.meta.url), "utf8");
	let integrationText = reference;
	const runs = { ...input, runsIntegration: true };
	assert.deepEqual(await repositoryAdmission(workflow("active"), "t", "ada", "platform", runs), []);
	// The workflow at that commit may hold at most a read of the repository, no secret, and run on workflow_dispatch alone: each refusal says why.
	const { integrationWorkflowRefusal } = await import("../server/src/github/integration.js");
	assert.equal(integrationWorkflowRefusal(reference), null, "the reference workflow is refused");
	const job = "jobs:\n  t:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo\n";
	for (const [what, text, reason] of [
		[
			"pull_request_target",
			"on:\n  workflow_dispatch: {}\n  pull_request_target: {}\npermissions:\n  contents: read\n" + job,
			/pull_request_target/,
		],
		["a push trigger", "on: [workflow_dispatch, push]\npermissions:\n  contents: read\n" + job, /runs on push/],
		[
			"a schedule",
			"on:\n  workflow_dispatch:\n  schedule:\n    - cron: '0 0 * * *'\npermissions: {}\n" + job,
			/runs on schedule/,
		],
		[
			"write permissions",
			"on: workflow_dispatch\npermissions:\n  contents: write\n" + job,
			/top-level permissions grant contents: write/,
		],
		["write-all", "on: workflow_dispatch\npermissions: write-all\n" + job, /are write-all/],
		["read-all", "on: workflow_dispatch\npermissions: read-all\n" + job, /are read-all/],
		[
			"another scope",
			"on: workflow_dispatch\npermissions:\n  contents: read\n  actions: read\n" + job,
			/grant actions: read/,
		],
		["no top-level permissions", "on: workflow_dispatch\n" + job, /sets no top-level permissions/],
		[
			"a job's write permission",
			"on: workflow_dispatch\npermissions:\n  contents: read\njobs:\n  t:\n    permissions:\n      pull-requests: write\n    runs-on: x\n    steps: []\n",
			/job t's permissions grant pull-requests: write/,
		],
		[
			"a secret",
			"on: workflow_dispatch\npermissions:\n  contents: read\n" +
				job +
				"        env:\n          T: ${{ secrets.TOKEN }}\n",
			/references secrets/,
		],
		[
			"inherited secrets",
			"on: workflow_dispatch\npermissions:\n  contents: read\njobs:\n  t:\n    uses: a/b/.github/workflows/c.yml@main\n    secrets: inherit\n",
			/references secrets/,
		],
	] as const) {
		assert.match(integrationWorkflowRefusal(text) ?? "", reason, what);
		integrationText = text;
		const [problem] = await repositoryAdmission(workflow("active"), "t", "ada", "platform", runs);
		assert.match(
			problem ?? "",
			/^ada\/platform: \.github\/workflows\/windlass-integration\.yml at 2222222 is refused: /,
			what,
		);
		assert.match(problem, reason, what);
	}
	integrationText = reference;
	assert.match(
		(await repositoryAdmission(workflow(null), "t", "ada", "platform", runs))[0],
		/needs \.github\/workflows\/windlass-integration\.yml/,
	);
	assert.match(
		(await repositoryAdmission(workflow("disabled_manually"), "t", "ada", "platform", runs))[0],
		/windlass-integration/,
	);
});

test("cross-repo: a combined run is the platform's only by its name, head, workflow file and the App's bot", async () => {
	const { findIntegrationRun, readIntegrationRun, runName, ForeignRun } = await import(
		"../server/src/github/integration.js"
	);
	const head = sha("8");
	const own = {
		id: 5,
		display_title: runName("i_cross", 1),
		name: "windlass-integration",
		path: ".github/workflows/windlass-integration.yml",
		head_sha: head,
		triggering_actor: { login: "windlass[bot]", type: "Bot" },
		status: "queued",
		conclusion: null,
		html_url: "u",
	};
	const app = (runs: object[]) =>
		({
			settings: { slug: "windlass", appId: "1" },
			call: async ({ path }: { path: string }) => {
				if (path.endsWith("/actions/workflows/windlass-integration.yml/runs")) return { body: { workflow_runs: runs } };
				if (path.endsWith("/actions/runs/5")) return { body: runs[0] };
				throw new Error("unexpected " + path);
			},
		}) as never;
	const find = (runs: object[]) =>
		findIntegrationRun(app(runs), "t", "ada", "platform", "windlass/feature-i_cross", "i_cross", 1, head);
	assert.equal((await find([own]))?.runId, "5");
	for (const [what, run] of [
		["another commit", { ...own, head_sha: sha("9") }],
		["started by a person", { ...own, triggering_actor: { login: "mallory", type: "User" } }],
		["another App's bot", { ...own, triggering_actor: { login: "other[bot]", type: "Bot" } }],
		["another workflow with the same run name", { ...own, path: ".github/workflows/ci.yml" }],
		["another attempt", { ...own, display_title: runName("i_cross", 2) }],
	] as const) {
		assert.equal(await find([run]), null, `a run on ${what} was taken for the platform's`);
		// A run already named by its id is followed only while it is still the platform's run on that head.
		if (what !== "another attempt")
			await assert.rejects(readIntegrationRun(app([run]), "t", "ada", "platform", "5", head), ForeignRun);
	}
	assert.equal((await readIntegrationRun(app([own]), "t", "ada", "platform", "5", head)).state, "queued");
});

test("cross-repo: the managed PR section links the counterpart by full URL, keeps the person's text and never closes the issue", async () => {
	const { linkSection, withSection, issueReference } = await import("../server/src/factory/cross-repo.js");
	const { item } = crossOpened();
	const section = linkSection(item, "cli");
	assert.ok(section.includes(item.task.title) && !section.includes(item.id));
	assert.match(section, /this pull request: sibling, cli, ada\/cli/);
	assert.match(section, /primary platform: https:\/\/github.com\/ada\/platform\/pull\/1/);
	assert.match(section, /Merge order: 1\. cli 2\. platform after cli/);
	assert.match(section, /combined integration: not run/);
	assert.doesNotMatch(section, /\b(Closes|Fixes|Resolves) #/i);
	const body = withSection("The person's own notes.", section);
	assert.equal(withSection(body, section), body, "writing the section twice changed the body");
	assert.ok(
		withSection(body, linkSection(item, "cli").replace("not run", "passed")).startsWith("The person's own notes."),
	);
	assert.equal(issueReference(item.repos![0], 7), "Part of ada/platform#7.");
});

test("cross-repo: the planner's copy of the sibling holds its files read-only with no git directory, and a commit it cannot have refuses", async t => {
	const { GithubStandin, gitHttpBackendAvailable } = await import("./github-standin.js");
	if (!gitHttpBackendAvailable()) return t.skip("git http-backend is not installed");
	const { materializeInput, removeInputs } = await import("../server/src/github/git.js");
	const { execFile } = await import("node:child_process");
	const { mkdtempSync, mkdirSync, existsSync, statSync, readFileSync, rmSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const standin = new GithubStandin({ callbackUrl: "http://127.0.0.1:1/callback" });
	await standin.start();
	const root = mkdtempSync(join(tmpdir(), "wlp-inputs-"));
	try {
		const installation = standin.addInstallation("ada", "User");
		const cli = standin.addRepository({
			owner: "ada",
			name: "cli",
			private: true,
			installation,
			files: { "CROSS.md": "only in the CLI\n", "src/a.ts": "export {};\n" },
		});
		standin.tokens.set("read-cli", {
			kind: "installation",
			value: "read-cli",
			installation: installation.id,
			repositories: [cli.id],
			permissions: { contents: "read", metadata: "read" },
			expiresAt: Date.now() + 3600_000,
			revoked: false,
		});
		const work = join(root, "workspace"),
			scratch = join(root, "tmp");
		mkdirSync(work);
		mkdirSync(scratch);
		const sandbox = {
			cwd: work,
			id: "inputs",
			run: (command: string, options: { stdin?: string } = {}) =>
				new Promise(done => {
					const child = execFile(
						"bash",
						["-c", command.replaceAll("/tmp/wlp-", scratch + "/wlp-")],
						{ cwd: work, env: { PATH: "/usr/bin:/bin", HOME: root }, timeout: 60_000 },
						(error, stdout, stderr) => {
							if (process.env.WLP_DEBUG_INPUTS)
								console.error(JSON.stringify({ command: command.slice(0, 80), stdout, stderr, code: error?.code }));
							done({
								exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
								timedOut: false,
								aborted: false,
								stdout,
								stderr,
							});
						},
					);
					child.stdin?.on("error", () => {});
					child.stdin?.end(options.stdin ?? "");
				}),
		} as never;
		const input = {
			url: `${standin.url}/ada/cli.git`,
			branch: "main",
			sha: standin.branchHead(cli, "main")!,
			directory: ".windlass-inputs",
			alias: "cli",
		};
		await materializeInput(sandbox, "read-cli", input);
		const file = join(work, ".windlass-inputs/cli/CROSS.md");
		assert.equal(readFileSync(file, "utf8"), "only in the CLI\n");
		assert.equal(statSync(file).mode & 0o222, 0, "the sibling's files are writable");
		assert.equal(
			existsSync(join(work, ".windlass-inputs/cli/.git")),
			false,
			"a git directory (and its remote) was left",
		);
		// Fetched again for the next planning turn: replaced, not refused.
		await materializeInput(sandbox, "read-cli", input);
		await assert.rejects(
			materializeInput(sandbox, "read-cli", { ...input, sha: sha("1") }),
			/fetch failed.*not our ref|not at/,
		);
		await assert.rejects(materializeInput(sandbox, "wrong-token", input), /refused|fetch failed/);
		// A tree larger than a planning input may be is refused by name.
		await assert.rejects(
			materializeInput(sandbox, "read-cli", { ...input, limits: { fileMiB: 512, treeMiB: 0 } }),
			/larger than a planning input may be/,
		);
		await removeInputs(sandbox, ".windlass-inputs");
		assert.equal(existsSync(join(work, ".windlass-inputs")), false);
		// In the workspace's repository: the directory is excluded, and refused when the repository has it, it is a link, or it is not the platform's.
		const git = (...args: string[]) =>
			new Promise<string>((done, fail) =>
				execFile(
					"git",
					args,
					{
						cwd: work,
						env: {
							PATH: "/usr/bin:/bin",
							HOME: root,
							GIT_CONFIG_NOSYSTEM: "1",
							GIT_AUTHOR_NAME: "a",
							GIT_AUTHOR_EMAIL: "a@b",
							GIT_COMMITTER_NAME: "a",
							GIT_COMMITTER_EMAIL: "a@b",
						},
					},
					(e, out) => (e ? fail(e) : done(out)),
				),
			);
		await git("init", "-q", "-b", "main");
		await materializeInput(sandbox, "read-cli", input);
		assert.match(readFileSync(join(work, ".git/info/exclude"), "utf8"), /^\/\.windlass-inputs\/$/m);
		assert.equal(
			(await git("status", "--porcelain", "--untracked-files=all")).trim(),
			"",
			"the planner's inputs show in the repository",
		);
		await materializeInput(sandbox, "read-cli", input);
		assert.equal(
			readFileSync(join(work, ".git/info/exclude"), "utf8").match(/windlass-inputs/g)!.length,
			1,
			"the exclusion was written twice",
		);
		await removeInputs(sandbox, ".windlass-inputs");
		const { writeFileSync, symlinkSync } = await import("node:fs");
		// Not the platform's: left alone by removal, and refused for planning.
		mkdirSync(join(work, ".windlass-inputs"));
		writeFileSync(join(work, ".windlass-inputs/notes.md"), "mine\n");
		await assert.rejects(
			materializeInput(sandbox, "read-cli", input),
			/already in the workspace, and the platform did not put it there/,
		);
		await assert.rejects(removeInputs(sandbox, ".windlass-inputs"), /could not be removed: .*did not put it there/);
		assert.equal(readFileSync(join(work, ".windlass-inputs/notes.md"), "utf8"), "mine\n");
		// Tracked, or in the commit only.
		await git("add", "-f", ".windlass-inputs/notes.md");
		await assert.rejects(materializeInput(sandbox, "read-cli", input), /is tracked in the repository/);
		await git("commit", "-q", "-m", "inputs");
		await git("rm", "-q", "--cached", "-r", ".windlass-inputs");
		await assert.rejects(materializeInput(sandbox, "read-cli", input), /is in the repository's commit/);
		await git("reset", "-q", "--hard");
		await git("rm", "-q", "-r", ".windlass-inputs");
		await git("commit", "-q", "-m", "gone");
		// A link, where removal would follow it elsewhere.
		const elsewhere = join(root, "elsewhere");
		mkdirSync(elsewhere);
		writeFileSync(join(elsewhere, "keep"), "x");
		symlinkSync(elsewhere, join(work, ".windlass-inputs"));
		await assert.rejects(materializeInput(sandbox, "read-cli", input), /is a symbolic link/);
		await assert.rejects(removeInputs(sandbox, ".windlass-inputs"), /symbolic link/);
		assert.ok(existsSync(join(elsewhere, "keep")), "removal followed the link");
	} finally {
		await standin.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test("approval resolves the current defaults before confirming or placing each part", () => {
	const item = proposed(proposal());
	const approve = { kind: "approve_plan", at: 4, version: 1, by: "owner" } as const;
	const inventory = { machines: [], hostedProfiles: [], defaults: { repository: { harness: "claude" as const } } };
	const refreshed = advance(item, { ...approve, inventory, agents: ["index", "page"] }).item;
	assert.equal(refreshed.featurePlan?.status, "proposed");
	assert.equal(refreshed.featurePlan?.version, 2);
	assert.equal(advance(refreshed, { ...approve, inventory }).item, refreshed);
	assert.throws(
		() => advance(refreshed, { ...approve, version: 2, inventory, agents: ["index"] }),
		/page: confirm that it runs Claude Code/,
	);
	const changed = advance(item, {
		...approve,
		inventory: { ...inventory, defaults: { repository: { harness: "codex" } } },
	});
	assert.equal(changed.item.featurePlan?.status, "proposed");
	assert.equal(changed.item.question?.choices[0]?.label, "Use Windlass for these parts");
});

test("a sibling's Hosted route, secrets and explicit size are bound to the reviewed version", () => {
	const item = crossProposed();
	item.place = { kind: "machine", machineId: macId };
	const task = item.featurePlan!.subtasks[0]!;
	task.needs = { hostedSize: "large" };
	const inventory = {
		machines: plannerMachines([machineReport()]),
		hostedProfiles: ["docker-hardened" as const],
		hostedRates: { large: 0.33 },
		hostedSizes: ["small", "large"] as import("../server/src/contract.js").HostedSize[],
		defaults: {
			account: { place: { machine: macId }, hostedSize: "small" as const },
			repositories: { [task.repo!]: { place: "hosted" as const } },
		},
	};
	const review = advance(item, { kind: "refresh_plan", at: 4, version: 1, inventory }).item;
	const result = review.featurePlan!.subtasks[0]!;
	assert.deepEqual(result.review!.places, [
		{ place: { kind: "hosted" }, name: "hosted", sendSecrets: true, payer: "windlass" },
	]);
	assert.deepEqual(result.review!.hosted, { saved: "small", size: "large", rate: 2, usdPerHour: 0.33 });
	const repriced = advance(review, {
		kind: "approve_plan",
		at: 5,
		by: "owner",
		version: 2,
		inventory: { ...inventory, hostedRates: { large: 0.4 } },
	}).item.featurePlan!;
	assert.equal(repriced.status, "proposed");
	assert.equal(repriced.version, 3);
	assert.equal(repriced.subtasks[0]!.review!.hosted!.usdPerHour, 0.4);
	const changed = advance(review, {
		kind: "approve_plan",
		at: 5,
		by: "owner",
		version: 2,
		inventory: {
			...inventory,
			defaults: { ...inventory.defaults, account: { ...inventory.defaults.account, hostedSize: "large" } },
		},
	}).item;
	assert.equal(changed.featurePlan?.version, 3);
	assert.equal(changed.featurePlan?.status, "proposed");
});

test("Codex parts require an owner choice before plan approval", () => {
	const item = started();
	item.context = { account: { harness: "codex" } };
	const key = currentKey(item)!;
	const filed = advance(item, { kind: "file_plan", key, at: 2, plan: proposal() });
	const done = advance(filed.item, {
		kind: "turn_ended",
		key,
		at: 3,
		outcome: "succeeded",
		changes: false,
		report: null,
		verified: null,
		flags: [],
		spend: { tokens: 10, hostedSeconds: 1 },
	});
	assert.match(done.item.question!.text, /Codex cannot build Plan-first parts/);
	const choices = done.item.question!.choices.map(c => c.id);
	assert.deepEqual(choices, ["use_windlass", "use_claude", "use_opencode", "revise"]);
	const chosen = advance(done.item, {
		kind: "answer",
		at: 4,
		by: "owner",
		question: done.item.question!.id,
		choice: "use_opencode",
	});
	assert.ok(
		chosen.item.featurePlan!.subtasks.every(
			t => t.resolved?.agent === "opencode" && t.resolved.sources.agent === "item",
		),
	);
	assert.ok(chosen.item.question!.choices.some(c => c.id === "approve"));
});

test("a part asks for Hosted when its machine is offline and the owner allowed Hosted", () => {
	const offline = machineReport("Mac", macId, { status: "offline" });
	const item = dispatch(placementFeature([offline], {}, ["hosted"], true), [offline]);
	assert.match(item.question!.text, /come back online/i);
	assert.ok(item.question!.choices.some(c => c.id === "use_hosted"));
	assert.equal(item.jobs![0].placement, undefined);
	const chosen = advance(item, {
		kind: "answer",
		at: 7,
		by: "owner",
		question: item.question!.id,
		choice: "use_hosted",
	});
	assert.equal(chosen.item.jobs![0].route?.preferred.kind, "hosted");
});

test("a Hosted fallback uses its own isolation while an explicit part profile stays required", async () => {
	const { partRun } = await import("../server/src/factory/resolve-run.js");
	const { bindRoute } = await import("../server/src/factory/placement.js");
	const context = {
		repository: {
			place: { machine: macId },
			machineProfile: "docker-hardened",
			profile: "e2b",
			placeFallback: "hosted",
		},
	} as const;
	const machines = plannerMachines([machineReport("Mac", macId, { status: "offline" })]);
	const inventory = { machines, defaults: context, hostedProfiles: ["e2b" as const] };
	const task = { ...proposal().subtasks[0], resolved: partRun(context, {}) };
	const route = bindRoute(task, { kind: "hosted" }, false, machines);
	const offered = choosePlacement(task, route, inventory);
	assert.equal(offered.offerHosted, true);
	assert.equal(offered.hostedProfile, "e2b");
	const stored = {
		...context,
		item: { place: { machine: macId }, profile: "docker-hardened", machineProfile: "docker-hardened" },
	} as const;
	assert.equal(partRun(stored, { place: { prefer: "hosted", reason: "Owner accepted" } }).profile, "e2b");
	assert.equal(
		choosePlacement({ ...task, needs: { profile: "docker-hardened" } }, route, inventory).offerHosted,
		undefined,
	);
	assert.equal(
		choosePlacement(task, route, { ...inventory, hostedProfiles: ["docker-hardened"] }).offerHosted,
		undefined,
	);
});

test("filing checks the current catalog and can use a second machine when the first read fails", async () => {
	const { machineModelLists } = await import("../server/src/actors/user-machines.js");
	const { resolveRun } = await import("../server/src/factory/resolve-run.js");
	const { checkRunPlace } = await import("../server/src/factory/default-place.js");
	const entry = { ...signedIn[0], optionsDigest: "old", method: "subscription" as const };
	const machines = [
		machineReport("Mac", macId, { harnesses: [entry] }),
		machineReport("Linux", linuxId, { harnesses: [entry] }),
	];
	const catalog = { defaultModel: "opus", models: [{ id: "opus", name: "Opus", efforts: [] }] };
	const c = {
		key: ["owner"],
		client: () => ({
			machine: {
				get: ([, id]: string[]) => ({
					internalCatalog: async (_: string, digest?: string) => {
						if (id === macId) throw new Error("offline");
						return digest === "old" ? null : catalog;
					},
				}),
			},
		}),
	};
	const models = { machines: await machineModelLists(c, machines, id => id === "claude") };
	const account = { harness: "claude", machineModel: "opus" } as const;
	const named = (id: string) =>
		checkRunPlace(resolveRun({ account: { ...account, place: { machine: id } } }, "builder"), machines, models);
	assert.match(named(macId).wait!, /current model list/);
	assert.equal(named(macId).refusal, undefined);
	assert.equal(named(linuxId).wait, undefined);
	const any = resolveRun({ account: { ...account, place: "any-machine" } }, "builder");
	assert.deepEqual(checkRunPlace(any, machines, models).place, { kind: "machine", machineId: linuxId });
});

test("placement identifies screenshot permission, storage, runner flag and hosted size separately", async () => {
	const { resolveRun } = await import("../server/src/factory/resolve-run.js");
	const inventory = {
		hostedSizes: ["small", "standard", "large"] as import("../server/src/contract.js").HostedSize[],
		hostedProfiles: ["docker-hardened" as const],
		machines: plannerMachines([machineReport("Mac", macId, { screenshots: false })]),
	};
	const task = {
		...proposal().subtasks[0],
		resolved: resolveRun({ item: { hostedSize: "small" } }, "part"),
		needs: { screenshots: true },
	};
	const route = { preferred: { kind: "hosted" as const }, alternatives: [] };
	assert.match(
		choosePlacement(task, route, { ...inventory, repositoryScreenshots: { "": false } }).refused!,
		/for this repository/,
	);
	assert.match(choosePlacement(task, route, { ...inventory, screenshotStorage: false }).refused!, /storage/);
	assert.match(choosePlacement(task, route, { ...inventory, screenshotsEnabled: false }).refused!, /deployment/);
	assert.match(
		choosePlacement(task, { ...route, preferred: { kind: "machine", machineId: macId } }, inventory).refused!,
		/--screenshots/,
	);
	assert.match(choosePlacement({ ...task, needs: { cpus: 4 } }, route, inventory).refused!, /needs Large/);
	assert.equal(choosePlacement(task, route, inventory).decision?.hostedSize, "small");
});

test("an increase above a part’s hosted size needs a separate owner answer", () => {
	const item = started();
	item.context = { item: { hostedSize: "small" } };
	const key = currentKey(item)!;
	const plan = proposal();
	plan.subtasks[0].needs = { cpus: 4 };
	const filed = advance(item, {
		kind: "file_plan",
		key,
		at: 2,
		plan,
		inventory: { machines: [], hostedProfiles: ["docker-hardened"], hostedSizes: ["small", "standard", "large"] },
	});
	const done = advance(filed.item, {
		kind: "turn_ended",
		key,
		at: 3,
		outcome: "succeeded",
		changes: false,
		report: null,
		verified: null,
		flags: [],
		spend: { tokens: 10, hostedSeconds: 1 },
	});
	assert.match(done.item.question!.text, /large hosted sandbox at 2×/);
	assert.ok(!done.item.question!.choices.some(c => c.id === "approve"));
	const chosen = advance(done.item, {
		kind: "answer",
		at: 4,
		by: "owner",
		question: done.item.question!.id,
		choice: "larger_sandbox",
	});
	assert.equal(chosen.item.featurePlan!.subtasks[0].resolved?.size, "large");
	assert.equal(chosen.item.featurePlan!.status, "proposed");
});

test("both sandbox caps exclude a machine with free slots", () => {
	const box = { sessionId: "s_busy", title: null, usedAt: 0, state: "running" as const };
	for (const limits of [{ maxRunning: 1 }, { maxSandboxes: 1 }]) {
		const mac = machineReport("Mac", macId, { ...limits, sandboxes: [box] });
		const linux = machineReport("Linux box", linuxId);
		const blocked = dispatch(placementFeature([mac]), [mac]);
		assert.match(blocked.wait!.sentence, /sandbox limit/);
		const moved = dispatch(placementFeature([mac, linux], {}, ["Linux box"], true), [mac, linux]);
		assert.deepEqual(moved.jobs![0].placement?.place, { kind: "machine", machineId: linuxId });
	}
});
