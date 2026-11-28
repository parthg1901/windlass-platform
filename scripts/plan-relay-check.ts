// The plan relay that runs inside an E2B or Daytona sandbox (sandbox/relay/plan.cjs, started by
// server/src/sandbox/plan-relay.ts), here as a local process with a recording upstream: the placeholder is
// swapped for the plan's token, another bearer and other routes are refused, the token never comes back,
// a replaced token is the next request's, the turn's request limit holds, and it starts only with a token.
// Run from server/: npx tsx --test ../scripts/plan-relay-check.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import test, { type TestContext } from "node:test";
import type { ProcessEnd, SandboxProcess, StartOptions } from "../server/src/sandbox/provider.js";
import {
	GUEST_NODE,
	PLAN_RELAY_ARGV,
	planRelaySources,
	startPlanRelay,
	type PlanRelayOptions,
} from "../server/src/sandbox/plan-relay.js";
import { rotatePlanToken } from "../server/src/sandbox/token-file.js";

const TOKEN = "sk-ant-oat01-" + "t".repeat(60);
const NEXT = "sk-ant-oat01-" + "n".repeat(60);
const CLAUDE_HEADERS = {
	"content-type": "application/json",
	accept: "application/json",
	"anthropic-version": "2023-06-01",
	"anthropic-beta": "oauth-2025-04-20,claude-code-20250219,not-a-beta",
	"x-app": "cli",
	"x-stainless-lang": "js",
	"user-agent": "claude-cli/2",
};

/** `TurnSandbox.start` as a local process: the guest's Node is this one. Records what the relay was started with. */
function localStart(started: Array<{ argv: string[]; options: StartOptions; stdin: string }>) {
	return (argv: string[], options: StartOptions): SandboxProcess => {
		const record = { argv, options, stdin: "" };
		started.push(record);
		assert.equal(argv[0], GUEST_NODE);
		const child = spawn(process.execPath, argv.slice(1), { env: { PATH: "/usr/bin:/bin" }, stdio: "pipe" });
		child.stdout.setEncoding("utf8").on("data", chunk => options.onStdout?.(chunk));
		child.stderr.setEncoding("utf8").on("data", chunk => options.onStderr?.(chunk));
		let hasEnded = false;
		const ended = new Promise<ProcessEnd>(resolve =>
			child.once("close", (code, signal) => {
				hasEnded = true;
				resolve({ code, signal, error: null });
			}),
		);
		return {
			tag: "rtest",
			write: text => {
				record.stdin += text;
				return child.stdin.write(text);
			},
			closeStdin: () => child.stdin.end(),
			ended,
			get hasEnded() {
				return hasEnded;
			},
			signal: async sig => {
				child.kill(`SIG${sig}`);
			},
			killClient: () => {},
		};
	};
}

interface Seen {
	method?: string;
	url?: string;
	headers: IncomingHttpHeaders;
	body: string;
}

async function stack(
	t: TestContext,
	reply?: (seen: Seen, res: import("node:http").ServerResponse) => void,
	options: Partial<PlanRelayOptions> & { token?: string } = {},
) {
	const seen: Seen[] = [];
	const origin = createServer((req, res) => {
		let body = "";
		req.on("data", chunk => (body += chunk));
		req.on("end", () => {
			const entry = { method: req.method, url: req.url, headers: req.headers, body };
			seen.push(entry);
			if (reply) return reply(entry, res);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({ type: "message", content: [{ type: "text", text: "echo " + req.headers.authorization }] }),
			);
		});
	});
	origin.listen(0, "127.0.0.1");
	await once(origin, "listening");
	t.after(() => origin.close());
	const started: Array<{ argv: string[]; options: StartOptions; stdin: string }> = [];
	const relay = await startPlanRelay(localStart(started), options.token ?? TOKEN, {
		expiresAt: Date.now() + 60_000,
		wire: "claude-plan",
		harness: "claude",
		upstream: `http://127.0.0.1:${(origin.address() as { port: number }).port}`,
		...options,
	});
	t.after(() => relay.close());
	const base = new URL(relay.env.WINDLASS_MODEL_BASE_URL!);
	const send = (
		method: string,
		path: string,
		headers: Record<string, string> = {},
		body = "",
	): Promise<{ status: number; body: string }> =>
		new Promise((resolve, reject) => {
			const req = request(
				{ host: base.hostname, port: base.port, method, path, headers: { ...headers, connection: "close" } },
				res => {
					let text = "";
					res.setEncoding("utf8").on("data", chunk => (text += chunk));
					res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
				},
			);
			req.on("error", reject);
			req.end(body);
		});
	const claude = (path = "/v1/messages?beta=true", bearer = relay.placeholder, extra: Record<string, string> = {}) =>
		send("POST", path, { ...CLAUDE_HEADERS, authorization: `Bearer ${bearer}`, ...extra }, '{"model":"sonnet"}');
	return { seen, relay, started, send, claude };
}

test("the placeholder is swapped for the plan's token, and only the plan's headers go on", async t => {
	const { seen, relay, started, claude } = await stack(t);
	assert.equal(relay.env.WINDLASS_MODEL_BASE_URL, relay.env.WINDLASS_MODEL_ALLOWED_ORIGIN);
	assert.match(relay.env.WINDLASS_MODEL_BASE_URL!, /^http:\/\/127\.0\.0\.1:\d+$/);
	const answer = await claude();
	assert.equal(answer.status, 200);
	assert.equal(seen.length, 1);
	assert.equal(seen[0]!.url, "/v1/messages?beta=true");
	assert.equal(seen[0]!.headers.authorization, `Bearer ${TOKEN}`);
	assert.equal(seen[0]!.headers["anthropic-beta"], "oauth-2025-04-20,claude-code-20250219");
	assert.equal(seen[0]!.headers["x-app"], undefined);
	assert.equal(seen[0]!.body, '{"model":"sonnet"}');
	assert.ok(!answer.body.includes(TOKEN), answer.body);
	assert.match(answer.body, /\[redacted\]/);
	// As the transport user, with the token on standard input only.
	assert.equal(started[0]!.options.gitUser, true);
	assert.equal(started[0]!.options.env, undefined);
	assert.equal(started[0]!.options.secretEnv, undefined);
	assert.ok(!started[0]!.argv.join(" ").includes(TOKEN));
	assert.deepEqual(started[0]!.argv, PLAN_RELAY_ARGV);
	assert.ok(started[0]!.stdin.includes(TOKEN));
});

test("another bearer, another host and other routes are refused before the upstream", async t => {
	const { seen, claude, send, relay } = await stack(t);
	assert.equal((await claude("/v1/messages", "wlp-plan." + "x".repeat(43))).status, 401);
	assert.equal((await claude("/v1/messages", TOKEN)).status, 401);
	assert.equal((await send("POST", "/v1/messages", { ...CLAUDE_HEADERS }, "{}")).status, 401);
	assert.equal((await claude("/v1/responses")).status, 403);
	assert.equal((await claude("/v1/complete")).status, 403);
	assert.equal(
		(await send("GET", "/v1/models?after_id=abc", { authorization: `Bearer ${relay.placeholder}` })).status,
		403,
	);
	assert.equal((await claude("/v1/messages", relay.placeholder, { host: "api.anthropic.com" })).status, 403);
	assert.equal((await claude("/v1/messages", relay.placeholder, { "x-unknown-header": "1" })).status, 403);
	assert.equal(seen.length, 0);
	assert.equal((await send("GET", "/v1/models", { authorization: `Bearer ${relay.placeholder}` })).status, 200);
	assert.equal(seen.length, 1);
});

test("Claude Code's reachability check is answered here, only with the placeholder", async t => {
	const { seen, send, relay } = await stack(t);
	assert.equal((await send("HEAD", "/api/hello", { authorization: `Bearer ${relay.placeholder}` })).status, 200);
	assert.equal((await send("HEAD", "/api/hello", { authorization: "Bearer nope" })).status, 401);
	assert.equal(seen.length, 0);
});

test("the token is taken out of streamed answers and error bodies; a 401 stays a 401", async t => {
	let status = 200;
	const { claude } = await stack(t, (entry, res) => {
		const token = entry.headers.authorization!.slice(7);
		if (status !== 200) {
			res.writeHead(status, { "content-type": "application/json" });
			return res.end(
				JSON.stringify({
					type: "error",
					error: { type: "authentication_error", message: `Invalid bearer token ${token}` },
				}),
			);
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		const delta = (text: string) =>
			`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`;
		res.write(delta("the token is " + token.slice(0, 20)));
		res.write(delta(token.slice(20)));
		res.end(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
	});
	const streamed = await claude();
	assert.equal(streamed.status, 200);
	assert.ok(!streamed.body.includes(TOKEN.slice(20)), streamed.body);
	assert.match(streamed.body, /\[redacted\]/);
	status = 401;
	const refused = await claude();
	assert.equal(refused.status, 401);
	assert.ok(!refused.body.includes(TOKEN), refused.body);
	assert.equal(JSON.parse(refused.body).error.type, "authentication_error");
});

test("it tells the platform what the provider said of the plan: limit headers, a 429's code, never the token", async t => {
	let status = 200;
	const reports: import("../server/src/contract.js").RelaySeen[] = [];
	const reset = String(Math.floor(Date.now() / 1000) + 3600);
	const { claude } = await stack(
		t,
		(entry, res) => {
			const token = entry.headers.authorization!.slice(7);
			const limits = {
				"anthropic-ratelimit-unified-status": status === 429 ? "rejected" : "allowed",
				"anthropic-ratelimit-unified-5h-utilization": status === 429 ? "1" : "0.25",
				"anthropic-ratelimit-unified-5h-reset": reset,
				"request-id": "req_123",
			};
			res.writeHead(status, { "content-type": "application/json", ...limits });
			res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", code: token, message: token } }));
		},
		{ onSeen: seen => reports.push(seen) },
	);
	assert.equal((await claude()).status, 200);
	assert.equal((await claude()).status, 200, "a second success soon after is not told again");
	status = 429;
	assert.equal((await claude()).status, 429);
	status = 401;
	assert.equal((await claude()).status, 401);
	for (let i = 0; i < 50 && reports.length < 3; i++) await new Promise(r => setTimeout(r, 20));
	assert.deepEqual(
		reports.map(r => r.status),
		[200, 429, 401],
	);
	assert.equal(reports[0]!.headers["anthropic-ratelimit-unified-5h-utilization"], "0.25");
	assert.equal(reports[0]!.headers["request-id"], undefined, "nothing that names a request or account");
	assert.equal(reports[1]!.headers["anthropic-ratelimit-unified-5h-reset"], reset);
	assert.equal(reports[1]!.code, "rate_limit_error", "the type where the code would hold the token");
	assert.ok(!JSON.stringify(reports).includes(TOKEN));
});

test("a replaced token is the one the next request carries", async t => {
	const { seen, relay, claude } = await stack(t);
	await claude();
	await relay.hand(NEXT);
	const after = await claude();
	assert.equal(seen.at(-1)!.headers.authorization, `Bearer ${NEXT}`);
	assert.ok(!after.body.includes(NEXT), after.body);
});

test("the turn's request limit holds", async t => {
	let left = 1;
	const { seen, claude } = await stack(t, undefined, { takeRequest: async () => left-- > 0 });
	assert.equal((await claude()).status, 200);
	const limited = await claude();
	assert.equal(limited.status, 429);
	assert.match(limited.body, /request limit/);
	assert.equal(seen.length, 1);
	const local = await stack(t, undefined, { requestLimit: 1 });
	assert.equal((await local.claude()).status, 200);
	assert.equal((await local.claude()).status, 429);
});

test("closing it or the turn's abort stops it, and past its expiry it refuses", async t => {
	const { relay, claude } = await stack(t);
	await relay.close();
	await assert.rejects(claude());
	await assert.rejects(relay.hand(NEXT), /ended/);
	const controller = new AbortController();
	const aborted = await stack(t, undefined, { signal: controller.signal });
	controller.abort();
	await new Promise(resolve => setTimeout(resolve, 300));
	await assert.rejects(aborted.claude());
	const brief = await stack(t, undefined, { expiresAt: Date.now() + 1000 });
	await new Promise(resolve => setTimeout(resolve, 1100));
	assert.equal((await brief.claude()).status, 401);
	assert.equal(brief.seen.length, 0);
});

test("a token handed with a later expiry moves the relay's end on", async t => {
	const { relay, claude, seen } = await stack(t, undefined, { expiresAt: Date.now() + 1000 });
	await relay.hand(NEXT, Date.now() + 60_000);
	await new Promise(resolve => setTimeout(resolve, 1100));
	assert.equal((await claude()).status, 200);
	assert.equal(seen.at(-1)!.headers.authorization, `Bearer ${NEXT}`);
	// An earlier one never brings it forward.
	await relay.hand(TOKEN, Date.now() + 500);
	await new Promise(resolve => setTimeout(resolve, 600));
	assert.equal((await claude()).status, 200);
});

test("a plan that is gone closes the turn's relay at the next look, also for a token that never expires", async t => {
	const { relay, claude } = await stack(t);
	let plan: { secret: string } | null = { secret: TOKEN };
	let asked = 0;
	const lines: string[] = [];
	const following = rotatePlanToken(
		relay,
		undefined,
		async () => {
			asked += 1;
			return plan;
		},
		{ checkMs: 100, retryMs: 10, log: line => lines.push(line) },
	);
	t.after(() => following.close());
	for (let i = 0; i < 100 && asked < 2; i++) await new Promise(r => setTimeout(r, 20));
	assert.equal((await claude()).status, 200, "the same plan: it keeps paying");
	plan = null;
	for (let i = 0; i < 100 && lines.length === 0; i++) await new Promise(r => setTimeout(r, 20));
	assert.match(lines[0] ?? "", /plan_token\.gone.*closed/);
	await assert.rejects(claude(), "the relay stopped taking requests");
	const after = asked;
	await new Promise(r => setTimeout(r, 300));
	assert.equal(asked, after, "nothing is asked once it is closed");
});

async function bare(
	stdin: string,
	closeAfter = true,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
	const child = spawn(process.execPath, PLAN_RELAY_ARGV.slice(1), { env: { PATH: "/usr/bin:/bin" } });
	let stderr = "",
		stdout = "";
	child.stderr.setEncoding("utf8").on("data", chunk => (stderr += chunk));
	child.stdout.setEncoding("utf8").on("data", chunk => (stdout += chunk));
	child.stdin.write(stdin);
	if (closeAfter) child.stdin.end();
	const [code] = (await once(child, "close")) as [number | null];
	return { code, stderr, stdout };
}

test("on a ChatGPT plan it takes Codex's routes to api.openai.com with the current access token, and nothing else", async t => {
	const ACCESS = "chatgpt-access-" + "a".repeat(40);
	const REFRESHED = "chatgpt-access-" + "b".repeat(40);
	const { seen, send, relay } = await stack(
		t,
		(_seen, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end('data: {"type":"response.completed"}\n\n');
		},
		{ token: ACCESS, wire: "chatgpt-plan", harness: "codex" },
	);
	const codex = (path: string, method = "POST", bearer = relay.placeholder) =>
		send(
			method,
			path,
			{
				authorization: `Bearer ${bearer}`,
				"content-type": "application/json",
				accept: "text/event-stream",
				originator: "codex",
			},
			method === "POST" ? "{}" : "",
		);
	assert.equal((await codex("/v1/responses")).status, 200);
	assert.equal(seen.at(-1)!.headers.authorization, `Bearer ${ACCESS}`);
	assert.equal(seen.at(-1)!.headers.originator, undefined, "Codex's own headers stay here");
	await relay.hand(REFRESHED);
	assert.equal((await codex("/v1/responses")).status, 200);
	assert.equal(seen.at(-1)!.headers.authorization, `Bearer ${REFRESHED}`, "a handed token is the next request's");
	assert.equal((await codex("/v1/models?client_version=0.171.0", "GET")).status, 200);
	assert.equal(seen.at(-1)!.url, "/v1/models");
	const count = seen.length;
	assert.equal((await codex("/v1/models", "GET")).status, 403);
	assert.equal((await codex("/v1/messages")).status, 403);
	assert.equal((await codex("/api/hello", "HEAD")).status, 403, "only Claude Code's check is answered locally");
	assert.equal((await codex("/v1/responses", "POST", ACCESS)).status, 401);
	assert.equal(seen.length, count);
});

test("on a ChatGPT plan it takes Windlass's two routes, at the /v1 base Windlass appends them to, and a rotated token is the next request's", async t => {
	const ACCESS = "chatgpt-access-" + "w".repeat(40);
	const ROTATED = "chatgpt-access-" + "r".repeat(40);
	const { seen, send, relay } = await stack(
		t,
		(_seen, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end('{"models":[]}');
		},
		{ token: ACCESS, wire: "chatgpt-plan", harness: "windlass" },
	);
	assert.equal(new URL(relay.env.WINDLASS_MODEL_BASE_URL!).pathname, "/v1");
	assert.equal(relay.env.WINDLASS_MODEL_ALLOWED_ORIGIN, new URL(relay.env.WINDLASS_MODEL_BASE_URL!).origin);
	const windlass = (path: string, method = "POST", bearer = relay.placeholder) =>
		send(
			method,
			path,
			{ authorization: `Bearer ${bearer}`, "content-type": "application/json", "user-agent": "Windlass/0.7.1" },
			method === "POST" ? "{}" : "",
		);
	assert.equal((await windlass("/v1/models", "GET")).status, 200);
	assert.equal(seen.at(-1)!.url, "/v1/models");
	assert.equal(seen.at(-1)!.headers.authorization, `Bearer ${ACCESS}`);
	// The turn's schedule (`rotatePlanToken`): when the token nears its end, the current one is asked for and handed.
	let asked = 0;
	const rotating = rotatePlanToken(
		relay,
		Date.now() + 1_000,
		async () => {
			asked += 1;
			return { secret: ROTATED, expiresAt: Date.now() + 3_600_000 };
		},
		{ leadMs: 900, retryMs: 50, log: () => {} },
	);
	for (let i = 0; i < 100 && asked === 0; i++) await new Promise(r => setTimeout(r, 20));
	await new Promise(r => setTimeout(r, 100));
	assert.equal((await windlass("/v1/responses")).status, 200);
	assert.equal(seen.at(-1)!.headers.authorization, `Bearer ${ROTATED}`, "the rotated token is the next request's");
	const count = seen.length;
	assert.equal((await windlass("/v1/models?client_version=0.171.0", "GET")).status, 403, "Codex's catalog form");
	assert.equal((await windlass("/v1/chat/completions")).status, 403);
	assert.equal((await windlass("/v1/responses", "POST", ROTATED)).status, 401);
	assert.equal(seen.length, count);
	await rotating.close();
});

test("on a paired machine it listens on its own socket behind the turn's forwarder, which writes its nonce first", async t => {
	const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { connect } = await import("node:net");
	const dir = mkdtempSync(`${tmpdir()}/plan-check-`);
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const socket = `${dir}/plan-${"a".repeat(32)}.sock`;
	const { seen, relay } = await stack(t, undefined, { socket });
	assert.ok(existsSync(socket));
	// As runner/src/egress-proxy.mjs `wlp-model-forward` does: the nonce, then the agent's bytes, with its port in Host.
	const viaForwarder = (bearer: string): Promise<number> =>
		new Promise((resolve, reject) => {
			const req = request(
				{
					method: "POST",
					path: "/v1/messages?beta=true",
					headers: {
						...CLAUDE_HEADERS,
						host: "127.0.0.1:17893",
						authorization: `Bearer ${bearer}`,
						connection: "close",
					},
					createConnection: () => {
						const conn = connect(socket);
						conn.write("b".repeat(32));
						return conn;
					},
				},
				res => {
					res.resume();
					res.on("end", () => resolve(res.statusCode ?? 0));
				},
			);
			req.on("error", reject);
			req.end('{"model":"sonnet"}');
		});
	assert.equal(await viaForwarder(relay.placeholder), 200);
	assert.equal(seen.at(-1)!.headers.authorization, `Bearer ${TOKEN}`);
	assert.equal(await viaForwarder("wlp-plan." + "x".repeat(43)), 401);
	await relay.close();
	for (let i = 0; i < 50 && existsSync(socket); i++) await new Promise(r => setTimeout(r, 20));
	assert.ok(!existsSync(socket), "its socket goes with it");
});

test("it refuses a socket path outside the form a machine's relay uses", async () => {
	const sources = planRelaySources() + "\n";
	const placeholder = "wlp-plan." + "p".repeat(43);
	const said = await bare(
		sources +
			JSON.stringify({
				token: TOKEN,
				placeholder,
				expiresAt: Date.now() + 60_000,
				wire: "claude-plan",
				harness: "claude",
				socket: "/workspace/../relay.sock",
			}) +
			"\n",
	);
	assert.equal(said.code, 2);
	assert.match(said.stderr, /unusable socket path/);
});

test("it does not start without a token on standard input", async () => {
	const sources = planRelaySources() + "\n";
	const placeholder = "wlp-plan." + "p".repeat(43);
	const expiresAt = Date.now() + 60_000;
	const none = await bare(
		sources + JSON.stringify({ placeholder, expiresAt, wire: "claude-plan", harness: "claude" }) + "\n",
	);
	assert.equal(none.code, 2);
	assert.match(none.stderr, /no token/);
	assert.equal(none.stdout, "");
	const short = await bare(sources + JSON.stringify({ token: "x", placeholder, expiresAt }) + "\n");
	assert.equal(short.code, 2);
	const expired = await bare(sources + JSON.stringify({ token: TOKEN, placeholder, expiresAt: Date.now() - 1 }) + "\n");
	assert.equal(expired.code, 2);
	assert.ok(!expired.stderr.includes(TOKEN));
	const unwired = await bare(sources + JSON.stringify({ token: TOKEN, placeholder, expiresAt, wire: "openai" }) + "\n");
	assert.equal(unwired.code, 2, "no plan's wire, no relay: a key's wire is never this relay's");
	assert.match(unwired.stderr, /no plan wire/);
	// Standard input closing before a token: it ends, never listening.
	const closed = await bare(sources);
	assert.equal(closed.stdout, "");
});
