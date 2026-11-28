// cd server && timeout 10m npx tsx ../scripts/windlass-key-docker-check.ts
// WINDLASS_BINARY optionally mounts a release in the disposable sandbox.
import "./check-secret.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { MODEL_PROVIDERS, type ModelProvider } from "../server/src/contract.js";
import { modelRelayResponse, type RelayRouteDeps } from "../server/src/model-relay-route.js";
import { docker } from "../server/src/sandbox/docker.js";
import { BodyBudget, RelayLimiter, UserRate, openRelayLease } from "../server/src/sandbox/relay-leases.js";
import { DockerSandboxHandle } from "../server/src/sandbox/sandboxes.js";
import { SandboxWindlass } from "../server/src/sandbox/turn.js";
import { sealCredentialTransit } from "../server/src/credentials/transit.js";
import { reportedModelUsage } from "../server/src/usage.js";
import { imageId } from "./check-image.js";

const models = {
	openai: "gpt-5",
	anthropic: "claude-haiku-4-5",
	google: "gemini-2.5-flash",
	openrouter: "vendor/model",
};
const roots = {
	openai: "https://api.openai.com/v1",
	anthropic: "https://api.anthropic.com/v1",
	google: "https://generativelanguage.googleapis.com/v1beta",
	openrouter: "https://openrouter.ai/api/v1",
};
const generation = {
	openai: "/responses",
	anthropic: "/messages",
	google: "/models/" + models.google + ":streamGenerateContent?alt=sse",
	openrouter: "/chat/completions",
};
const frame = (data: object, event?: string) =>
	(event ? "event: " + event + "\n" : "") + "data: " + JSON.stringify(data) + "\n\n";
const event = (type: string, data: object = {}) => frame({ type, ...data }, type);
function stream(provider: ModelProvider) {
	switch (provider) {
		case "openai":
			return (
				event("response.output_item.done", {
					output_index: 0,
					item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello" }] },
				}) + event("response.completed", { response: { output: [], usage: { input_tokens: 4, output_tokens: 2 } } })
			);
		case "anthropic":
			return (
				event("message_start", { message: { model: models.anthropic, usage: { input_tokens: 4 } } }) +
				event("content_block_start", { index: 0, content_block: { type: "text", text: "Hello" } }) +
				event("content_block_stop", { index: 0 }) +
				event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
				event("message_stop")
			);
		case "google":
			return frame({
				candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }],
				usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
			});
		case "openrouter":
			return (
				frame({
					choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: "stop" }],
					usage: { prompt_tokens: 4, completion_tokens: 2 },
				}) + "data: [DONE]\n\n"
			);
	}
}

const uid = "key-check",
	sessionId = "test-session";
const id = randomBytes(6).toString("hex");
const bridge = "wlp-key-check-" + id;
const box = new DockerSandboxHandle(id, "docker-hardened", uid);
const agent = new SandboxWindlass({ version: async () => null, problem: async () => null });
const keys = Object.fromEntries(MODEL_PROVIDERS.map(p => [p, randomBytes(24).toString("hex")]));
const origin = "http://127.0.0.1:17893";
let provider: ModelProvider = "openai",
	placeholder: string;
const seen = new Set<string>();
let mainFinished: () => void;
const mainReceipt = new Promise<void>(resolve => {
	mainFinished = resolve;
});
const scanMarker = randomBytes(20).toString("hex");
async function scanSandbox(live: boolean) {
	const needles = [scanMarker, placeholder, ...Object.values(keys)];
	const overlap = Math.max(...needles.map(s => s.length)) - 1;
	const found = new Set<string>();
	let tail = "";
	await docker(
		[
			"exec",
			box.container,
			"sh",
			"-c",
			`
		for file in /proc/[0-9]*/environ; do cat "$file" 2>/dev/null; done
		find /dev/shm /tmp /workspace /home/agent/.local/share/windlass -xdev -type f -readable -exec cat {} +
	`,
		],
		{
			check: true,
			timeoutMs: 30_000,
			onStdout(chunk) {
				const data = tail + chunk;
				for (const needle of needles) if (data.includes(needle)) found.add(needle);
				tail = data.slice(-overlap);
			},
		},
	);
	assert.ok(found.has(scanMarker), "scan missed a marker beyond 5 MiB");
	if (live) assert.ok(found.has(placeholder), "missing live relay placeholder");
	assert.ok(
		Object.values(keys).every(key => !found.has(key)),
		"provider key found in sandbox",
	);
}
const deps: RelayRouteDeps = {
	paired: async () => false,
	remote: async () => null,
	limiter: new RelayLimiter(),
	bodies: new BodyBudget(),
	rate: new UserRate(),
	now: Date.now,
	credential: async (owner, ref, nonce) => {
		assert.equal(owner, uid);
		assert.deepEqual(ref, { provider });
		return sealCredentialTransit(uid, ref, nonce, { secret: keys[ref.provider], generation: "first" });
	},
	fetch: async (input, init) => {
		const url = String(input);
		const headers = new Headers(init?.headers);
		assert.equal(
			headers.get(provider === "anthropic" ? "x-api-key" : provider === "google" ? "x-goog-api-key" : "authorization"),
			(provider === "openai" || provider === "openrouter" ? "Bearer " : "") + keys[provider],
		);
		seen.add(url);
		if (init?.method === "GET") {
			assert.equal(url, roots[provider] + "/models");
			return Response.json(
				provider === "google"
					? { models: [{ name: "models/" + models.google, supportedGenerationMethods: ["generateContent"] }] }
					: { data: [{ id: models[provider], supported_parameters: ["tools"] }] },
			);
		}
		assert.equal(url, roots[provider] + generation[provider]);
		const body = Buffer.from(init?.body as Uint8Array).toString();
		if (provider === "openai" && body.includes("Name this session")) await mainReceipt;
		// Windlass is waiting for the reply, so its live environment can be inspected too.
		await scanSandbox(true);
		return new Response(stream(provider), { headers: { "content-type": "text/event-stream" } });
	},
};

const relay = createServer(async (req, res) => {
	try {
		const body = [];
		for await (const chunk of req) body.push(chunk);
		const response = await modelRelayResponse(
			new Request(origin + req.url, {
				method: req.method,
				headers: req.headers as Record<string, string>,
				body: body.length ? Buffer.concat(body) : undefined,
			}),
			deps,
		);
		res.writeHead(response.status, Object.fromEntries(response.headers));
		res.end(Buffer.from(await response.arrayBuffer()));
	} catch (error) {
		res.destroy();
		throw error;
	}
});
const image = await imageId();
const dir = await mkdtemp(resolve(".windlass-key-check-"));
try {
	await new Promise<void>(r => relay.listen(dir + "/relay.sock", r));
	const binary = process.env.WINDLASS_BINARY;
	await docker(
		[
			"run",
			"-d",
			"--init",
			"--name",
			box.container,
			"--user",
			"agent",
			"--network",
			"none",
			...(binary ? ["--mount", "type=bind,readonly,src=" + resolve(binary) + ",dst=/usr/local/bin/windlass"] : []),
			image,
			"sleep",
			"infinity",
		],
		{ check: true },
	);
	assert.match((await box.ask(["windlass", "--version"]))!.stdout, /^Windlass 0\.7\.1[+ ]/);
	// Only the helper can reach the host socket. Both containers share an isolated loopback.
	await docker(
		[
			"run",
			"-d",
			"--name",
			bridge,
			"--user",
			String(process.getuid!()),
			"--network",
			"container:" + box.container,
			"--mount",
			`type=bind,readonly,src=${dir},dst=/relay`,
			image,
			"node",
			"-e",
			"const net = require('node:net'); net.createServer(c => { const s = net.connect('/relay/relay.sock'); s.on('error', () => c.destroy()); c.on('error', () => s.destroy()); c.pipe(s).pipe(c); }).listen(17893, '127.0.0.1')",
		],
		{ check: true },
	);
	const handle = Object.assign(box, {
		modelKeyRelay: async (
			session: string,
			ref: import("../server/src/sandbox/provider.js").KeyReference,
			signal?: AbortSignal,
		) => {
			assert.equal(session, sessionId);
			assert.deepEqual(ref, { harness: "windlass", provider, generation: "first" });
			const lease = openRelayLease({ uid, sessionId, origin, key: ref, ttlMs: 60_000, requestLimit: 20, signal });
			placeholder = lease.placeholder;
			return lease;
		},
	});
	await docker(
		[
			"exec",
			box.container,
			"sh",
			"-ec",
			'truncate -s 5M /tmp/scan-probe; echo "$1" >> /tmp/scan-probe',
			"sh",
			scanMarker,
		],
		{ check: true },
	);
	let prior: string | undefined;
	for (let turn = 0; turn < 2; turn++) {
		let output: unknown;
		const result = await agent.runTurn(handle, {
			prompt: "Check the tool environment.",
			windlassSessionId: prior,
			script: {
				responses: [
					[
						{
							type: "tool_call",
							callId: "probe",
							name: "shell",
							input: { command: 'if test -z "${WINDLASS_PROVIDER+x}"; then echo withheld; else echo exposed; fi' },
						},
						{ type: "finish", reason: "tool_calls" },
					],
					[
						{ type: "text", text: "Done" },
						{ type: "finish", reason: "stop" },
					],
				],
			},
			onEvent(event) {
				if (event.type === "tool.settled") output = event.data?.output;
			},
		});
		assert.equal(result.failure, null);
		assert.equal(String(output).trim(), "withheld", "tool environment on turn " + turn);
		prior = result.windlassSessionId!;
	}
	for (provider of MODEL_PROVIDERS) {
		const input = { prompt: "Say Hello.", model: provider + "/" + models[provider] };
		await assert.rejects(agent.runTurn(handle, input), /key (?:in Settings|on the Connections page)/);
		const spending: number[] = [];
		const receipts: string[] = [];
		const result = await agent.runTurn(handle, {
			...input,
			modelKey: { sessionId, key: { provider, generation: "first" } },
			signal: AbortSignal.timeout(60_000),
			onEvent(event) {
				if (provider === "openai" && event.type === "step.ended") mainFinished();
				const used = reportedModelUsage(event, true);
				if (used) {
					spending.push(used.inputTokens + used.outputTokens);
					receipts.push(event.type);
				}
			},
		});
		assert.equal(result.failure, null, JSON.stringify(result.failure) + " " + result.stderrTail);
		assert.equal(result.summary?.outcome, "succeeded");
		if (provider === "openai") assert.deepEqual(receipts, ["step.ended", "session.title_usage"]);
		assert.ok(spending.includes(6), provider + " usage: " + JSON.stringify(spending));
		assert.ok(seen.has(roots[provider] + "/models") && seen.has(roots[provider] + generation[provider]));
		await scanSandbox(false);
		console.log("ok  Windlass 0.7.1 " + provider + " catalog, generation, missing key and credential isolation");
	}
} finally {
	relay.closeAllConnections();
	relay.close();
	await docker(["rm", "-fv", bridge]);
	await docker(["rm", "-fv", box.container]);
	await rm(dir, { recursive: true, force: true });
}
