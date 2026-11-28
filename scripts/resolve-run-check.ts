import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRun, filedAgentSettings, partRun, type RunContext } from "../server/src/factory/resolve-run.js";

const context: RunContext = {
	deployment: { model: "deployment-model", hostedSize: "small" },
	account: {
		place: { machine: "mac" },
		placeFallback: "hosted",
		harness: "claude",
		model: "windlass-model",
		effort: "low",
		machineModel: "sonnet",
		hostedSize: "large",
	},
	repository: {
		harness: "opencode",
		machineModel: "openai/repo-model",
		machineEffort: "high",
		machineProfile: "docker-hardened",
	},
	item: { hostedSize: "small" },
};

test("each field has its own precedence and source", () => {
	const run = resolveRun(context, "builder");
	assert.deepEqual(run, {
		place: { machine: "mac" },
		fallback: "hosted",
		agent: "opencode",
		model: "openai/repo-model",
		effort: "high",
		profile: "docker-hardened",
		size: "small",
		payer: "machine",
		sources: {
			place: "account",
			fallback: "account",
			agent: "repository",
			model: "repository",
			effort: "repository",
			profile: "repository",
			size: "item",
			payer: "deployment",
		},
	});
	assert.equal(resolveRun({ deployment: context.deployment }, "planner").model, "deployment-model");
});

test("planning, review, critic, summary and setup use the Windlass model", () => {
	for (const role of ["planner", "reviewer", "critic", "summary", "setup", "environment"] as const) {
		const { agent, model, effort, sources } = resolveRun(context, role);
		assert.equal(agent, "windlass");
		assert.equal(model, "windlass-model");
		assert.equal(effort, "low");
		assert.equal(sources.model, "account");
	}
});

test("planning prefers the review model over filed build models and charges its provider", () => {
	const layers: RunContext = {
		account: { model: "astra", effort: "low", reviewModel: "anthropic/claude-opus", reviewEffort: "high" },
		repository: { effort: "medium" },
	};
	for (const role of ["planner", "reviewer", "critic", "summary"] as const) {
		const run = resolveRun(layers, role);
		assert.deepEqual(
			[run.model, run.effort, run.sources.model, run.sources.effort, run.payer, run.sources.payer],
			["anthropic/claude-opus", "medium", "account", "repository", "key", "account"],
		);
		const filed = filedAgentSettings(layers, "chosen", null);
		assert.equal(resolveRun({ ...layers, item: filed }, role).model, "anthropic/claude-opus");
		assert.equal(
			resolveRun({ ...layers, repository: { reviewModel: "repo-review" }, item: filed }, role).model,
			"repo-review",
		);
		assert.equal(resolveRun({ ...layers, item: { ...filed, reviewModel: "item-review" } }, role).model, "item-review");
		assert.equal(resolveRun({ item: { model: "stored-build" } }, role).model, "stored-build");
		assert.equal(resolveRun({ ...layers, item: filed }, "builder").model, "chosen");
	}
	for (const role of ["builder", "part", "repair", "setup", "environment"] as const)
		assert.equal(resolveRun(layers, role).model, "astra");
});

test("parts and repairs inherit their repository and keep agent-specific models separate", () => {
	const withSibling = { ...context, repositories: { sibling: { harness: "codex" as const } } };
	for (const role of ["part", "repair"] as const) {
		assert.equal(partRun(withSibling, {}, role).agent, "opencode");
		assert.equal(partRun(withSibling, { repo: "sibling" }, role).model, null);
		const explicit = partRun(withSibling, { agent: { harness: "claude", model: "opus", effort: "max" } }, role);
		assert.deepEqual(
			[explicit.agent, explicit.model, explicit.effort, explicit.sources.model],
			["claude", "opus", "max", "item"],
		);
	}
});

test("out of memory keeps the workspace until the owner approves the size and rate", async () => {
	const { createItem, currentKey, advance } = await import("../server/src/factory/blueprint.js");
	const item = createItem({
		id: "i_oom",
		mode: "single",
		reviewer: { off: "deployment" },
		place: { kind: "hosted" },
		budget: { tokens: 10000, hostedSeconds: 600 },
		task: { title: "Build", body: "Build the project", base: "main", acceptance: [] },
	});
	item.resolved = resolveRun({ repository: { hostedSize: "small" } }, "builder");
	const started = advance(item, { kind: "start", at: 1, by: "owner" }).item;
	const key = currentKey(started)!;
	const working = advance(started, { kind: "turn_started", at: 2, key }).item;
	const stopped = advance(working, {
		kind: "turn_ended",
		at: 3,
		key,
		changes: false,
		flags: [],
		report: null,
		verified: null,
		outcome: "error",
		spend: { tokens: 0, hostedSeconds: 1 },
		outOfMemory: { usedMiB: 1023, totalMiB: 1024, size: "small", larger: "standard" },
	});
	assert.match(stopped.item.question!.text, /1×.*not pushed/);
	assert.equal(stopped.item.resolved?.size, "small");
	assert.ok(!stopped.effects.some(e => e.kind === "fresh_sandbox"));
	const answer = advance(stopped.item, {
		kind: "answer",
		at: 4,
		by: "owner",
		choice: "larger_sandbox",
		question: stopped.item.question!.id,
	});
	assert.equal(answer.effects.find(e => e.kind === "fresh_sandbox")?.hostedSize, "standard");
});
