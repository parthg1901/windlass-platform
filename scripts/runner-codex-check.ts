import assert from "node:assert/strict";
import test from "node:test";
import { parseRunnerFrame } from "../server/src/runner/control.js";
import { codexModes, reportedCodexModes } from "../server/src/sandbox/codex-modes.js";
import { initialSessionModes } from "../server/src/sandbox/profiles.js";
import { launchModes } from "../web/src/lib/modes.js";
Object.assign(globalThis, { SANDBOX_IMAGE: "fixture", SHOTS_IMAGE_PIN: "", HARNESS_IMAGES: { codex: "fixture" } });
test("Codex catalogs have independent model and byte limits on both frame shapes", () => {
	const options = {
		models: [{ id: "fixture", name: "Example", efforts: ["low"] }],
		defaultModel: "fixture",
		modes: codexModes("docker-hardened"),
		checkedAt: 1,
	};
	const entry = {
		id: "codex",
		adapter: "codex-acp 2.9.0",
		image: "fixture",
		signIn: "none",
		modes: ["agent-full-access"],
	};
	const report = {
		kind: "report",
		docker: { ok: true },
		commandSandbox: { ok: true },
		freeDiskBytes: 1,
		sandboxes: [],
	};
	for (const frame of [
		(opts: unknown) => ({ ...report, harnesses: [{ ...entry, options: opts }] }),
		(opts: unknown) => ({ kind: "catalog", id: "codex", options: opts }),
	]) {
		assert.ok(parseRunnerFrame(JSON.stringify(frame(options))));
		for (const [n, size] of [
			[40, 8],
			[32, 512],
		] as const) {
			const models = Array.from({ length: n }, (_, i) => ({
				id: i ? String(i) : "fixture",
				name: "a".repeat(size),
				efforts: ["low"],
			}));
			assert.equal(parseRunnerFrame(JSON.stringify(frame({ ...options, models }))), null);
		}
	}
});
test("the Windlass sandbox profile offers Codex only Read-only and Workspace access, starting in workspace-write", () => {
	const probed = reportedCodexModes(true);
	assert.deepEqual(probed, ["agent-full-access", "read-only", "workspace-write"]);
	assert.deepEqual(reportedCodexModes(false), ["agent-full-access"]);
	const inner = codexModes("docker-windlass-sandbox", probed);
	assert.deepEqual(
		inner.map(m => m.id),
		["read-only", "workspace-write"],
	);
	// Auto review's reviewer model approves running outside the sandbox: not offered even when a runner reports it.
	assert.deepEqual(
		codexModes("docker-windlass-sandbox", [...probed, "agent"]).map(m => m.id),
		["read-only", "workspace-write"],
	);
	assert.deepEqual(
		codexModes("docker-hardened", probed).map(m => m.id),
		["agent-full-access"],
	);
	assert.deepEqual(initialSessionModes("docker-windlass-sandbox", "codex", false, inner), {
		mode: "workspace-write",
		availableModes: inner,
	});
	assert.equal(
		initialSessionModes("docker-hardened", "codex", false, codexModes("docker-hardened", probed)).mode,
		"agent-full-access",
	);
	assert.equal(launchModes("codex", { id: "docker-windlass-sandbox", approval: "auto" })?.default, "workspace-write");
	assert.equal(launchModes("codex", { id: "docker-hardened", approval: "full" })?.default, "agent-full-access");
});
test("Codex reports no sign-in of its own: a plan or a Settings key pays for it on a machine", async () => {
	const { Executor } = await import("../runner/src/docker-executor.js");
	const { compactReport } = await import("../server/src/runner/catalog.js");
	const runner = new Executor(
		{ uid: "u_fixture", machineId: "m_0000000000000001" },
		{},
		false,
		false,
		["docker-hardened"],
		{ mode: "open", allow: [] },
		false,
		true,
	);
	(runner as unknown as { dockerHealth: { ok: boolean } }).dockerHealth = { ok: true };
	const frame = parseRunnerFrame(JSON.stringify(compactReport(runner.report())));
	assert.ok(frame && frame.kind === "report");
	const codex = frame.harnesses?.find(h => h.id === "codex");
	assert.equal(codex?.signIn, "none");
	assert.equal(codex?.loginGeneration, undefined);
	const { MACHINE_HARNESSES } = await import("../runner/src/machine-harnesses.js");
	await assert.rejects(
		MACHINE_HARNESSES.codex.changeLogin(runner, true, new AbortController().signal),
		/Codex has no login on this machine/,
	);
});

/**
 * The real ACP client against a scripted Codex agent. The session/new reply is the recorded codex-acp 2.9.0
 * handshake; the permission requests are the shapes codex-acp 2.9.0 sends for `exec_command` with
 * `sandbox_permissions: "require_escalated"` and for `apply_patch` outside the writable roots.
 */
/** What the scripted Codex adds to its `initialize` answer, and the `session/new` params it was sent. */
let codexInit: Record<string, unknown> = {};
let sessionNew: { mcpServers?: unknown[] } | undefined;
async function scriptedCodexTurn(
	profile: "docker-hardened" | "docker-windlass-sandbox",
	during: (emit: (frame: unknown) => void, sessionId: string, promptId: unknown) => void,
	answered: (frame: { id: unknown; result?: unknown }) => boolean,
	/** legacy: modes only in session/new's `modes` (no mode config option), so the client uses session/set_mode. */
	legacy?: { openIn: string; reportSetMode: boolean },
	/** More of the turn's input: a work item's (`unattended`, its mode). */
	more: Record<string, unknown> = {},
) {
	const { readFileSync } = await import("node:fs");
	const { harnessOf } = await import("../server/src/sandbox/harness.js");
	const { markTurnSandbox } = await import("../server/src/sandbox/provider.js");
	const opened = JSON.parse(
		readFileSync(new URL("../fixtures/codex/handshake.jsonl", import.meta.url), "utf8").split("\n")[2],
	).result;
	const signals: string[] = [];
	const methods: string[] = [];
	const notes: string[] = [];
	const permissions: unknown[] = [];
	let finished = false;
	const sandbox = {
		profile,
		cwd: "/workspace",
		async stopLeftovers() {
			return 0;
		},
		async sweep() {
			return 0;
		},
		start(_argv: string[], opts: { onStdout?: (chunk: string) => void }) {
			let finish!: (end: { code: number | null; signal: string | null; error: null }) => void;
			const ended = new Promise<{ code: number | null; signal: string | null; error: null }>(resolve => {
				finish = resolve;
			});
			const emit = (frame: unknown) =>
				queueMicrotask(() => opts.onStdout!(JSON.stringify({ jsonrpc: "2.0", ...(frame as object) }) + "\n"));
			let mode = legacy?.openIn ?? (profile === "docker-hardened" ? "agent-full-access" : "workspace-write");
			const options = (current: string) =>
				opened.configOptions
					.filter((o: { id: string }) => !legacy || o.id !== "mode")
					.map((o: { id: string }) => (o.id === "mode" ? { ...o, currentValue: current } : o));
			let prompt: unknown;
			const process = {
				tag: "fixture",
				ended,
				hasEnded: false,
				write(line: string) {
					const frame = JSON.parse(line);
					methods.push(frame.method);
					if (frame.method === "initialize")
						emit({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: {}, ...codexInit } });
					else if (frame.method === "providers/set") emit({ id: frame.id, result: {} });
					else if (frame.method === "session/new" && (sessionNew = frame.params))
						emit({
							id: frame.id,
							result: { ...opened, configOptions: options(mode), modes: { ...opened.modes, currentModeId: mode } },
						});
					else if (frame.method === "session/set_config_option") {
						if (frame.params.configId === "mode") mode = frame.params.value;
						emit({ id: frame.id, result: { configOptions: options(mode) } });
					} else if (frame.method === "session/set_mode") {
						if (!legacy || legacy.reportSetMode) {
							mode = frame.params.modeId;
							if (legacy)
								emit({
									method: "session/update",
									params: {
										sessionId: frame.params.sessionId,
										update: { sessionUpdate: "current_mode_update", currentModeId: mode },
									},
								});
						}
						emit({ id: frame.id, result: {} });
					} else if (frame.method === "session/cancel") {
						emit({ id: prompt, result: { stopReason: "cancelled" } });
					} else if (frame.method === "session/prompt") {
						prompt = frame.id;
						during(emit, frame.params.sessionId, frame.id);
					} else if (frame.method === undefined && frame.id !== undefined) {
						permissions.push(frame.result);
						if (answered(frame)) emit({ id: prompt, result: { stopReason: "end_turn" } });
					}
					return true;
				},
				closeStdin() {
					if (finished) return;
					finished = true;
					process.hasEnded = true;
					finish({ code: 0, signal: null, error: null });
				},
				async signal(sig: string) {
					signals.push(sig);
					if (!finished) {
						finished = true;
						process.hasEnded = true;
						finish({ code: null, signal: sig, error: null });
					}
				},
				killClient() {},
			};
			return process;
		},
	};
	markTurnSandbox(sandbox);
	const asked: unknown[] = [];
	const result = await harnessOf({ machine: { name: "Bench" } } as never, "codex").runTurn(sandbox as never, {
		prompt: "go",
		onAcpNote: text => notes.push(text),
		onQuestion: async question => {
			asked.push(question);
			return { choice: question.choices.find(c => c.approve)?.id ?? "" };
		},
		...more,
	});
	return { result, notes, permissions, asked, signals, methods };
}
const escalated = (sessionId: string) => ({
	method: "session/request_permission",
	id: 0,
	params: {
		sessionId,
		toolCall: {
			toolCallId: "exec-1",
			title: "id > /home/agent/escalated; echo wrote",
			rawInput: { command: "id > /home/agent/escalated; echo wrote", cwd: "/workspace" },
			kind: "execute",
			status: "pending",
		},
		options: [
			{ optionId: "allow_once", name: "Yes, proceed", kind: "allow_once" },
			{
				optionId: "accept_execpolicy_amendment",
				name: "Yes, and don't ask again for commands that start with `id`",
				kind: "allow_always",
			},
			{ optionId: "cancel", name: "No, and tell Codex what to do differently", kind: "reject_once" },
		],
	},
});
const edit = (sessionId: string) => ({
	method: "session/request_permission",
	id: 1,
	params: {
		sessionId,
		toolCall: {
			toolCallId: "exec-2",
			title: "Edit files",
			locations: [{ path: "/workspace/.codex/config.toml" }],
			kind: "edit",
			status: "pending",
		},
		options: [
			{ optionId: "allow_once", name: "Yes, proceed", kind: "allow_once" },
			{ optionId: "allow_for_session", name: "Yes, and don't ask again for these files", kind: "allow_always" },
			{ optionId: "cancel", name: "No, and tell Codex what to do differently", kind: "reject_once" },
		],
	},
});
const declinable = (sessionId: string) => {
	const frame = escalated(sessionId);
	frame.id = 2;
	frame.params.options.splice(2, 0, {
		optionId: "decline",
		name: "No, continue without running it",
		kind: "reject_once",
	});
	return frame;
};

test("on the Windlass sandbox profile every Codex request to leave its sandbox is refused without asking, with a note", async () => {
	const turn = await scriptedCodexTurn(
		"docker-windlass-sandbox",
		(emit, id) => {
			emit(escalated(id));
			emit(edit(id));
			emit(declinable(id));
		},
		() => true,
	);
	assert.equal(turn.result.failure, null);
	assert.deepEqual(turn.asked, [], "the user was asked about a request outside the sandbox");
	assert.deepEqual(turn.permissions, [
		{ outcome: { outcome: "selected", optionId: "cancel" } },
		{ outcome: { outcome: "selected", optionId: "cancel" } },
		{ outcome: { outcome: "selected", optionId: "decline" } },
	]);
	assert.deepEqual(turn.notes, [
		"Codex asked to run a command outside its sandbox; refused on this profile.",
		"Codex asked to edit files outside its sandbox; refused on this profile.",
		"Codex asked to run a command outside its sandbox; refused on this profile.",
	]);
});
test("on the hardened profile, where the container is the boundary, a Codex request still reaches the user", async () => {
	const turn = await scriptedCodexTurn(
		"docker-hardened",
		(emit, id) => emit(escalated(id)),
		() => true,
	);
	assert.equal(turn.result.failure, null);
	assert.equal(turn.asked.length, 1);
	assert.deepEqual(turn.permissions, [{ outcome: { outcome: "selected", optionId: "allow_once" } }]);
	assert.deepEqual(turn.notes, []);
});
test("a Codex mode the profile forbids, reported by the agent, ends the turn and stops the agent", {
	timeout: 10_000,
}, async () => {
	for (const update of [
		{ sessionUpdate: "current_mode_update", currentModeId: "agent-full-access" },
		{
			sessionUpdate: "config_option_update",
			configOptions: [{ id: "mode", category: "mode", type: "select", currentValue: "agent", options: [] }],
		},
	]) {
		const turn = await scriptedCodexTurn(
			"docker-windlass-sandbox",
			(emit, sessionId) => emit({ method: "session/update", params: { sessionId, update } }),
			() => false,
		);
		assert.equal(turn.result.failure?.reason, "engine");
		assert.match(
			turn.result.failure.message,
			/^Codex switched to the mode “(Container access|agent)”, which this sandbox profile does not allow\. The turn was stopped\.$/,
		);
		assert.deepEqual(turn.signals, ["TERM"], "the agent process was left running");
	}
});
test("on the session/set_mode path a Codex mode counts only once Codex opened in it or reported it", {
	timeout: 10_000,
}, async () => {
	const { innerModesReason } = await import("../server/src/sandbox/codex-modes.js");
	const end = (emit: (frame: unknown) => void, _: string, id: unknown) =>
		emit({ id, result: { stopReason: "end_turn" } });
	const ignored = await scriptedCodexTurn(
		"docker-windlass-sandbox",
		() => {},
		() => false,
		{ openIn: "read-only", reportSetMode: false },
	);
	assert.equal(ignored.result.failure?.message, innerModesReason);
	assert.ok(ignored.methods.includes("session/set_mode"));
	assert.ok(!ignored.methods.includes("session/prompt"), "a turn was prompted in a mode Codex never reported");
	for (const legacy of [
		{ openIn: "read-only", reportSetMode: true },
		{ openIn: "workspace-write", reportSetMode: false },
	]) {
		const turn = await scriptedCodexTurn("docker-windlass-sandbox", end, () => false, legacy);
		assert.equal(turn.result.failure, null, JSON.stringify(legacy));
		assert.ok(turn.methods.includes("session/prompt"));
	}
});

test("a work item runs Codex in Workspace access on the Windlass sandbox profile and Container access on the hardened one", async () => {
	const { itemModeOf, itemProfiles, itemProfileProblem, worksWithoutAsking } = await import(
		"../server/src/sandbox/harnesses.js"
	);
	assert.deepEqual(itemProfiles("codex"), ["docker-windlass-sandbox", "docker-hardened"]);
	assert.equal(itemModeOf("codex", "docker-windlass-sandbox"), "workspace-write");
	assert.equal(itemModeOf("codex", "docker-hardened"), "agent-full-access");
	assert.deepEqual(
		[itemModeOf("claude", "docker-windlass-sandbox"), itemModeOf("windlass", "docker-hardened")],
		[undefined, undefined],
	);
	assert.equal(itemProfileProblem("codex", "docker-windlass-sandbox"), null);
	assert.equal(itemProfileProblem("claude", "docker-windlass-sandbox"), "A work item runs Claude Code only on “Open”.");
	assert.equal(initialSessionModes("docker-windlass-sandbox", "codex", true).mode, "workspace-write");
	assert.equal(initialSessionModes("docker-hardened", "codex", true).mode, "agent-full-access");
	// Commands run unasked only in the container; in Codex's sandbox a request to leave it ends the step.
	assert.deepEqual(
		[
			worksWithoutAsking("codex", "docker-hardened"),
			worksWithoutAsking("codex", "docker-windlass-sandbox"),
			worksWithoutAsking("claude"),
		],
		[true, false, true],
	);
	for (const profile of ["docker-windlass-sandbox", "docker-hardened"] as const) {
		const chosen: string[] = [];
		const end = (emit: (frame: unknown) => void, _: string, id: unknown) =>
			emit({ id, result: { stopReason: "end_turn" } });
		const turn = await scriptedCodexTurn(profile, end, () => false, undefined, {
			unattended: true,
			mode: itemModeOf("codex", profile),
			onAcpModes: (id: string) => {
				chosen.push(id);
			},
		});
		assert.equal(turn.result.failure, null, profile + ": " + JSON.stringify(turn.result.failure));
		assert.deepEqual(chosen, [itemModeOf("codex", profile)], profile);
	}
});
test("in a work item's turn on the Windlass sandbox profile a request to leave Codex's sandbox is refused and ends the step", {
	timeout: 10_000,
}, async () => {
	const { SANDBOX_ESCAPE_REFUSED } = await import("../server/src/sandbox/codex-modes.js");
	const turn = await scriptedCodexTurn(
		"docker-windlass-sandbox",
		(emit, id) => emit(escalated(id)),
		() => false,
		undefined,
		{ unattended: true, mode: "workspace-write" },
	);
	assert.deepEqual(turn.asked, [], "the request was put to someone");
	// Refused although allow_once was offered: the refusal comes before an item's allow-once.
	assert.deepEqual(turn.permissions, [{ outcome: { outcome: "selected", optionId: "cancel" } }]);
	assert.ok(turn.methods.includes("session/cancel"), "the turn was not stopped");
	assert.equal(turn.result.failure?.reason, SANDBOX_ESCAPE_REFUSED);
	assert.equal(
		turn.result.failure?.message,
		"Codex asked to run a command outside its sandbox; refused on this profile.",
	);
	assert.deepEqual(turn.notes, ["Codex asked to run a command outside its sandbox; refused on this profile."]);
	// A person's turn on that profile is refused the same way and goes on.
	const watched = await scriptedCodexTurn(
		"docker-windlass-sandbox",
		(emit, id) => emit(escalated(id)),
		() => true,
	);
	assert.equal(watched.result.failure, null);
	assert.ok(!watched.methods.includes("session/cancel"));
});
test("in a work item's turn on the hardened profile a Codex request is allowed once without asking", async () => {
	const turn = await scriptedCodexTurn(
		"docker-hardened",
		(emit, id) => emit(escalated(id)),
		() => true,
		undefined,
		{ unattended: true, mode: "agent-full-access" },
	);
	assert.equal(turn.result.failure, null);
	assert.deepEqual(turn.asked, []);
	assert.deepEqual(turn.permissions, [{ outcome: { outcome: "selected", optionId: "allow_once" } }]);
});
test("a Codex item gets the platform's MCP server only behind the image's bridge; an older image is noted", async () => {
	const end = (emit: (frame: unknown) => void, _: string, id: unknown) =>
		emit({ id, result: { stopReason: "end_turn" } });
	const item = { unattended: true, mode: "workspace-write", onReport: () => "Recorded." };
	try {
		// codex-acp 2.9.0 alone: it takes acp servers, but on a port Codex's requirements.toml does not allow.
		codexInit = { agentCapabilities: { mcpCapabilities: { acp: true, http: true } } };
		const old = await scriptedCodexTurn("docker-windlass-sandbox", end, () => false, undefined, item);
		assert.deepEqual(sessionNew?.mcpServers, []);
		assert.deepEqual(old.notes, [
			"Codex here cannot take the platform's tools, so this turn has no report. A newer harness image on the machine has them.",
		]);
		codexInit = { ...codexInit, _meta: { "windlass-platform/acpMcp": 1 } };
		const bridged = await scriptedCodexTurn("docker-windlass-sandbox", end, () => false, undefined, item);
		assert.deepEqual(sessionNew?.mcpServers, [
			{ type: "acp", name: "windlass_platform", serverId: "windlass-platform" },
		]);
		assert.deepEqual(bridged.notes, []);
	} finally {
		codexInit = {};
	}
});
