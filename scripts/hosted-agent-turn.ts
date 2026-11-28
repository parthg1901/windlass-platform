import { timelineFixture } from "../fixtures/acp-agent/timeline.js";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import type { AcpProfile } from "../server/src/sandbox/harnesses.js";
import { hostedKeyMessage } from "../server/src/sandbox/harnesses.js";
import { harnessOf } from "../server/src/sandbox/harness.js";
import type { SandboxLayer } from "../server/src/sandbox/api.js";
import type { CredentialRef } from "../server/src/contract.js";
import type { ProcessEnd, StartOptions, TurnSandbox } from "../server/src/sandbox/provider.js";

/** An ACP adapter stand-in makes the same HTTP request as its pinned CLI, through the real relay route. */
export async function checkHostedTurn(
	id: AcpProfile["id"],
	key: CredentialRef,
	real: string,
	handle: TurnSandbox,
	sessionId: string,
	relay: (request: Request) => Promise<Response>,
) {
	const agent = harnessOf({} as SandboxLayer, id);
	const mode = id === "codex" ? "agent-full-access" : id === "opencode" ? "build" : "auto";
	let request: Request | undefined;
	let starts = 0,
		holds = 0;
	let shown = "";
	const sandbox = Object.assign(Object.create(handle) as TurnSandbox, {
		profile: "e2b-open",
		holdForTurn: async () => {
			holds++;
			return async () => {
				holds--;
			};
		},
		stopLeftovers: async () => 0,
		sweep: async () => 0,
		writeSecretFile: () => {
			throw Error("ACP must not write credentials into files");
		},
		start(command: string[], opts: StartOptions) {
			starts++;
			assert.equal(holds, 1);
			assert.deepEqual(command, ["wlp-" + id + "-acp"]);
			assert.ok(!JSON.stringify(opts).includes(real));
			const env = opts.secretEnv!;
			const headers: Record<string, string> = { "content-type": "application/json" };
			let url: string;
			if (id === "claude") {
				url = env.ANTHROPIC_BASE_URL + "/v1/messages?beta=true";
				Object.assign(headers, {
					"x-api-key": env.ANTHROPIC_API_KEY,
					"x-app": "cli",
					"anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,thinking-display-updates-2026-08-18",
				});
			} else if (id === "codex") {
				url = env.WLP_CODEX_BASE_URL + "/responses";
				Object.assign(headers, {
					authorization: "Bearer " + env.WLP_SESSION_BEARER,
					"x-client-feature-id": "codex",
					originator: "codex",
				});
			} else {
				const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
				assert.deepEqual(config.enabled_providers, [key.provider]);
				const placeholder = JSON.parse(env.OPENCODE_AUTH_CONTENT!)[key.provider].key;
				const base = config.provider[key.provider].options.baseURL;
				url =
					base +
					{
						openai: "/responses",
						anthropic: "/messages",
						google: "/models/gemini-test:streamGenerateContent?alt=sse",
						openrouter: "/chat/completions",
					}[key.provider];
				headers["x-opencode-session-id"] = "test";
				if (key.provider === "google") headers["x-goog-api-key"] = placeholder;
				else if (key.provider === "anthropic")
					Object.assign(headers, { "x-api-key": placeholder, "anthropic-beta": "interleaved-thinking-2025-05-14" });
				else headers.authorization = "Bearer " + placeholder;
			}
			shown = (headers.authorization ?? headers["x-api-key"] ?? headers["x-goog-api-key"])!.replace(/^Bearer /, "");
			request = new Request(url, {
				method: "POST",
				headers,
				body: JSON.stringify(id === "claude" ? { thinking: { type: "adaptive", display: "updates" } } : {}),
			});
			let finish!: (end: ProcessEnd) => void;
			const ended = new Promise<ProcessEnd>(resolve => {
				finish = resolve;
			});
			return {
				tag: "fixture",
				ended,
				hasEnded: false,
				closeStdin: () => finish({ code: 0, signal: null, error: null }),
				signal: async () => {},
				killClient() {},
				write(line: string) {
					const frame = JSON.parse(line);
					const reply = (result: unknown) =>
						queueMicrotask(() => opts.onStdout!(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\n"));
					if (frame.method === "initialize") reply({ protocolVersion: 1 });
					else if (frame.method === "session/new")
						reply({
							sessionId: "fixture",
							configOptions:
								id === "opencode"
									? [
											{
												id: "model",
												type: "select",
												category: "model",
												currentValue: key.provider + "/fixture",
												options: [{ value: key.provider + "/fixture" }],
											},
										]
									: [],
							modes: { currentModeId: mode, availableModes: [{ id: mode, name: mode }] },
						});
					else if (frame.method === "session/prompt")
						void relay(request!.clone()).then(async response => {
							assert.equal(response.status, 200);
							assert.ok(!(await response.text()).includes(real));
							opts.onStdout!(
								JSON.stringify({
									jsonrpc: "2.0",
									method: "session/update",
									params: {
										sessionId: "fixture",
										update: { sessionUpdate: "tool_call", toolCallId: "test", rawInput: { [shown]: "field" } },
									},
								}) + "\n",
							);
							reply({ stopReason: "end_turn", usage: { inputTokens: 13, outputTokens: 7 } });
						});
					else reply({});
					return true;
				},
			};
		},
	});
	await assert.rejects(agent.runTurn(sandbox, { prompt: "hello" }), { message: hostedKeyMessage(id) });
	assert.equal(starts, 0);
	const timeline = timelineFixture();
	const result = await agent.runTurn(sandbox, {
		prompt: "hello",
		modelKey: { sessionId, key },
		onAcpUpdate: update => timeline.recorder.update(update),
	});
	await delay(450);
	await timeline.vars.serial;
	try {
		for (const rows of [timeline.items, timeline.stored()]) {
			assert.ok(
				JSON.stringify(rows).includes("model-relay"),
				"live and stored tool fields contain the redaction marker",
			);
			assert.ok(!JSON.stringify(rows).includes(shown));
		}
	} finally {
		timeline.sql.close();
	}
	assert.equal(holds, 0);
	assert.equal(result.failure, null, JSON.stringify(result.failure));
	assert.equal(result.acp?.tokens?.inputTokens, 13);
	assert.equal(result.acp?.tokens?.outputTokens, 7);
	assert.equal((await relay(request!)).status, 401, "turn close revokes the placeholder");
	console.log(`ok    hosted ${id}/${key.provider} turn, missing key, credential isolation and revocation`);
}
