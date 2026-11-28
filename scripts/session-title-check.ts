// cd server && npx tsx ../scripts/session-title-check.ts
/**
 * A Windlass session's title (sandbox/turn.ts). No Docker: the turn code runs against a stand-in engine in
 * this process that, like Windlass, sends its first-line fallback as an ACP `session_info_update` and then
 * the title it generated as a `session.renamed` event.
 *
 *   - the fallback is not passed on, so the platform's own first title (`promptTitle`) stays;
 *   - the generated title is passed on once, as a `session_info_update`;
 *   - a `session.renamed` that was not generated (a person renamed it) is not passed on;
 *   - `generatedSessionTitle` cuts a long title to `MAX_TITLE_CHARS` at a word.
 */
import assert from "node:assert/strict";
import type { RunTurnInput, SandboxHandle } from "../server/src/sandbox/api.js";
import { markTurnSandbox, type ProcessEnd, type SandboxProcess } from "../server/src/sandbox/provider.js";

const { SandboxWindlass } = await import("../server/src/sandbox/turn.js");
const { generatedSessionTitle } = await import("../server/src/contract/timeline.js");
const { MAX_TITLE_CHARS } = await import("../server/src/contract/limits.js");

type Frame = { jsonrpc?: string; id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };

const SESSION = "ses_titlecheck";

/** A sandbox whose one program is a stand-in engine that titles the session as Windlass does. */
function standIn(renamed: Record<string, unknown>) {
	const sandbox = {
		id: "sbx_title",
		cwd: "/workspace",
		uid: "u_check",
		approval: "auto" as const,
		start(_argv: string[], options: { onStdout?: (chunk: string) => void } = {}): SandboxProcess {
			let finish: (end: ProcessEnd) => void = () => {};
			const ended = new Promise<ProcessEnd>(resolve => (finish = resolve));
			const emit = (frame: Frame) =>
				queueMicrotask(() => options.onStdout?.(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`));
			let seq = 0;
			const event = (type: string, data: Record<string, unknown>) =>
				emit({
					method: "_windlass/event",
					params: { sessionId: SESSION, event: { type, v: 1, data, sessionId: SESSION, seq: ++seq, time: Date.now() } },
				});
			const process: SandboxProcess & { hasEnded: boolean } = {
				tag: "wlp-session-title-check",
				ended,
				hasEnded: false,
				write(line: string) {
					for (const text of line.split("\n").filter(Boolean)) {
						const frame = JSON.parse(text) as Frame;
						if (frame.id === undefined || frame.method === undefined) continue;
						if (frame.method === "initialize") {
							const windlass = { notifications: ["_windlass/event"], openMeta: ["hostTools"] };
							emit({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: { _meta: { windlass } } } });
						} else if (frame.method === "session/new") emit({ id: frame.id, result: { sessionId: SESSION } });
						else if (frame.method === "session/prompt") {
							event("inbox.enqueued", { messageId: "u1", delivery: "steer", content: [] });
							emit({
								method: "session/update",
								params: {
									sessionId: SESSION,
									update: { sessionUpdate: "session_info_update", title: "please look at the failing build and" },
								},
							});
							event("session.renamed", renamed);
							emit({
								id: frame.id,
								result: { stopReason: "end_turn", _meta: { windlass: { outcome: "succeeded", executionId: "exe_1" } } },
							});
						} else emit({ id: frame.id, result: {} });
					}
					return true;
				},
				closeStdin() {
					process.hasEnded = true;
					finish({ code: 0, signal: null, error: null });
				},
				async signal() {},
				killClient() {
					process.hasEnded = true;
					finish({ code: null, signal: "SIGKILL", error: null });
				},
			};
			return process;
		},
		async ask() {
			return null;
		},
		async stopLeftovers() {
			return 0;
		},
		async sweep() {
			return 0;
		},
		async writeTextFile() {},
		async writeSecretFile() {},
		async removeFiles() {},
		async holdForTurn() {
			return async () => {};
		},
		async run() {
			return { exitCode: 0, stdout: "", stderr: "", aborted: false, timedOut: false };
		},
	};
	markTurnSandbox(sandbox);
	return sandbox as unknown as SandboxHandle;
}

const host = { version: async () => "0.6.0", problem: async () => null };
const script = {
	responses: [
		[
			{ type: "text", text: "Done." },
			{ type: "finish", reason: "stop" },
		],
	],
} as RunTurnInput["script"];

async function titles(renamed: Record<string, unknown>): Promise<unknown[]> {
	const seen: unknown[] = [];
	const result = await new SandboxWindlass(host).runTurn(standIn(renamed), {
		prompt: "please look at the failing build and fix it",
		script,
		onAcpUpdate: update => {
			if (update.sessionUpdate === "session_info_update") seen.push(update.title);
		},
	});
	assert.equal(result.failure, null);
	return seen;
}

assert.deepEqual(await titles({ title: "Fix the failing build", generated: true }), ["Fix the failing build"]);
console.log("PASS  the fallback title is ignored and the generated one passed on");

assert.deepEqual(await titles({ title: "My own name", generated: false }), []);
console.log("PASS  a title that was not generated is not passed on");

const long = `Investigate why the nightly build fails on the arm64 runners ${"and more ".repeat(10)}`;
const cut = generatedSessionTitle({ sessionUpdate: "session_info_update", title: long }, {});
assert(cut !== undefined && cut.length <= MAX_TITLE_CHARS && cut.endsWith("…"), cut);
assert(long.startsWith(`${cut.slice(0, -1)} `), `"${cut}" was not cut at a word`);
assert.equal(generatedSessionTitle({ sessionUpdate: "session_info_update", title: "Short" }, {}), "Short");
assert.equal(generatedSessionTitle({ sessionUpdate: "session_info_update", title: " \u0000 " }, {}), undefined);
console.log(`PASS  a long generated title is cut at a word to ${MAX_TITLE_CHARS} characters`);
