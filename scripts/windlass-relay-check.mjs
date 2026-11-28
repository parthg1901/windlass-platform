// Windlass's model relay (sandbox/relay/windlass.cjs, docs/model-relay.md) with a recording upstream in place of the
// platform's route: the turn's placeholder is swapped for its forwarded lease's, only that turn's connections count, a
// lease replaced while requests run is the one the next request carries, the relay's caps hold, and the provider's
// error codes reach Windlass without anything else of the body.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent, createServer, request } from "node:http";
import { createRelay } from "../sandbox/relay/server.cjs";
import { errorBody, HOST, windlassProvider } from "../sandbox/relay/windlass.cjs";
import { forward } from "../runner/src/egress-proxy.mjs";

const hex = c => c.repeat(32);
const REAL_A = "wlpm1.real-lease-of-turn-a-" + "x".repeat(40);
const REAL_B = "wlpm1.real-lease-of-turn-b-" + "y".repeat(40);
/** The record the server writes for a turn: a lease forwarded to the platform's route (here the recorder). */
const forwarded = (placeholder, expiresAt) => ({
	forward: { provider: "chatgpt-plan", host: "relay.example.com", placeholder, expiresAt },
	expiresAt,
});
const WINDLASS_HEADERS = {
	"content-type": "application/json",
	accept: "text/event-stream",
	"session-id": "s1",
	cookie: "c=1",
};

/** The recorder, the relay on a socket, and one forwarder per turn as the session's namespace has it. */
async function stack(t, { limits, upstreamReply, providerOptions } = {}) {
	const seen = [];
	const held = [];
	const closed = [];
	const origin = createServer((req, res) => {
		let body = "";
		req.on("data", c => (body += c));
		res.on("close", () => {
			if (!res.writableFinished) closed.push(req.url);
		});
		req.on("end", () => {
			// Every lease is forwarded to the platform's route; its path is the one Windlass asked for, under /model-relay.
			req.url = req.url.replace(/^\/model-relay/, "");
			seen.push({
				method: req.method,
				url: req.url,
				authorization: req.headers.authorization,
				headers: req.headers,
				body,
			});
			if (upstreamReply) return upstreamReply(req, res, held);
			if (req.url === "/v1/models") {
				res.writeHead(200, {
					"content-type": "application/json",
					"x-ratelimit-remaining-requests": "99",
					"x-request-id": "req_secret",
				});
				return res.end(JSON.stringify({ models: [{ slug: "relay-model" }], echo: req.headers.authorization }));
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			const finish = () => {
				res.write(
					`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "i", output_index: 0, content_index: 0, delta: "token is " + req.headers.authorization.slice(7) })}\n\n`,
				);
				res.end(
					`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`,
				);
			};
			if (body.includes('"hold"')) held.push(finish);
			else finish();
		});
	});
	origin.listen(0, "127.0.0.1");
	await once(origin, "listening");
	const leases = new Map();
	const provider = windlassProvider({
		load: async nonce => {
			const r = leases.get(nonce);
			if (!r) throw Object.assign(Error("gone"), { code: "ENOENT" });
			return r;
		},
		upstream: { hostname: "127.0.0.1", port: origin.address().port },
		list: async () => [],
		changes: () => undefined,
		...providerOptions,
	});
	const dir = await mkdtemp(join(tmpdir(), "wlp-model-relay-"));
	const socket = join(dir, "relay.sock");
	const sockets = new Set();
	const relay = createRelay({ provider, host: HOST, limits, forward: request });
	relay.on("connection", s => {
		sockets.add(s);
		s.on("close", () => sockets.delete(s));
	});
	await new Promise(done => relay.listen(socket, done));
	const forwarders = [];
	const agents = [];
	/** A turn: its lease, its forwarder, and a client as Windlass is one. */
	async function turn(nonce, placeholder, expiresAt = Date.now() + 3_600_000, user) {
		const lease = "wlp-model." + nonce.slice(0, 31) + "f";
		leases.set(nonce, { ...forwarded(placeholder, expiresAt), lease, ...(user && { user }) });
		const fwd = forward(0, socket, nonce);
		await once(fwd, "listening");
		forwarders.push(fwd);
		const agent = new Agent({ keepAlive: true, maxSockets: 64 });
		agents.push(agent);
		const call = (method, path, { bearer = lease, body = "{}", host = HOST, headers = WINDLASS_HEADERS } = {}) =>
			new Promise((ok, fail) => {
				const req = request(
					{
						host: "127.0.0.1",
						port: fwd.address().port,
						method,
						path,
						agent,
						headers: { host, ...(bearer && { authorization: "Bearer " + bearer }), ...headers },
					},
					res => {
						let text = "";
						res.on("data", c => (text += c));
						res.on("end", () => ok({ status: res.statusCode, text, headers: res.headers }));
						res.on("error", () => ok({ status: res.statusCode, text, headers: res.headers, cut: true }));
						res.on("aborted", () => ok({ status: res.statusCode, text, headers: res.headers, cut: true }));
					},
				);
				req.on("error", fail);
				req.end(method === "POST" ? body : undefined);
			});
		return {
			nonce,
			lease,
			call,
			replace: (token, at = Date.now() + 3_600_000) => leases.set(nonce, { ...forwarded(token, at), lease }),
			end: () => leases.delete(nonce),
		};
	}
	t.after(async () => {
		for (const a of agents) a.destroy();
		for (const f of forwarders) f.close();
		relay.close();
		for (const s of sockets) s.destroy();
		origin.closeAllConnections();
		origin.close();
		await rm(dir, { recursive: true, force: true });
	});
	return { turn, seen, held, closed, leases };
}

test("the placeholder is swapped for the turn's forwarded one on the two routes, and nothing else is passed on", async t => {
	const { turn, seen } = await stack(t);
	const a = await turn(hex("a"), REAL_A);
	const models = await a.call("GET", "/v1/models");
	assert.equal(models.status, 200);
	assert.equal(seen[0].authorization, "Bearer " + REAL_A);
	assert.equal(seen[0].url, "/v1/models");
	assert.equal(seen[0].headers.cookie, undefined);
	assert.equal(seen[0].headers["session-id"], "s1");
	// The upstream echoed the token; the relay takes it out of the body. The request id stays upstream.
	assert.ok(!models.text.includes(REAL_A), models.text);
	assert.equal(models.headers["x-request-id"], undefined);
	assert.equal(models.headers["x-ratelimit-remaining-requests"], "99");
	const streamed = await a.call("POST", "/v1/responses");
	assert.equal(streamed.status, 200);
	assert.ok(streamed.text.includes("token is [redacted]"), streamed.text);
	assert.ok(!streamed.text.includes(REAL_A));
	for (const [method, path] of [
		["POST", "/v1/models"],
		["GET", "/v1/responses"],
		["POST", "/v1/chat/completions"],
		["GET", "/v1/models?x=1"],
		["POST", "/backend-api/codex/responses"],
	])
		assert.equal((await a.call(method, path)).status, 403, `${method} ${path}`);
	assert.equal((await a.call("GET", "/v1/models", { host: "127.0.0.1:17892" })).status, 403);
	assert.equal(seen.length, 2);
});

test("a Claude plan's lease forwards Claude Code's bearer to the platform as a bearer, with the OAuth beta", async t => {
	const { turn, seen, leases } = await stack(t);
	const a = await turn(hex("c"), REAL_A);
	const platform = "wlpm1.plan-placeholder";
	const forward = {
		provider: "claude-plan",
		host: "relay.example.com",
		placeholder: platform,
		expiresAt: Date.now() + 60_000,
	};
	leases.set(a.nonce, { lease: a.lease, expiresAt: Date.now() + 60_000, forward });
	const claude = {
		"content-type": "application/json",
		"anthropic-version": "2023-06-01",
		"anthropic-beta": "oauth-2025-04-20,claude-code-20250219,unknown-beta-2099-01-01",
	};
	const sent = await a.call("POST", "/v1/messages?beta=true", { headers: claude });
	assert.equal(sent.status, 200, sent.text);
	assert.ok(!sent.text.includes(platform));
	assert.equal(seen[0].url, "/v1/messages?beta=true");
	assert.equal(seen[0].authorization, "Bearer " + platform);
	assert.equal(seen[0].headers["x-api-key"], undefined);
	assert.equal(seen[0].headers["anthropic-version"], "2023-06-01");
	assert.equal(seen[0].headers["anthropic-beta"], "oauth-2025-04-20,claude-code-20250219");
	// The plan's placeholder is a bearer; sent as an API key it is refused before the platform.
	const asKey = await a.call("POST", "/v1/messages", { bearer: "", headers: { ...claude, "x-api-key": a.lease } });
	assert.equal(asKey.status, 403);
	assert.equal(seen.length, 1);
});

test("a bearer counts only on its own turn's connections, and not after the turn", async t => {
	const { turn, seen } = await stack(t);
	const a = await turn(hex("a"), REAL_A);
	const b = await turn(hex("b"), REAL_B);
	// B's placeholder through A's forwarder (a command in A that got hold of it): refused.
	assert.equal((await a.call("GET", "/v1/models", { bearer: b.lease })).status, 401);
	// The real token itself is no bearer here either.
	assert.equal((await a.call("GET", "/v1/models", { bearer: REAL_A })).status, 401);
	assert.equal((await a.call("GET", "/v1/models", { bearer: "wlp-model." + "f".repeat(32) })).status, 401);
	assert.equal((await b.call("GET", "/v1/models")).status, 200);
	assert.equal(seen.at(-1).authorization, "Bearer " + REAL_B);
	a.end();
	assert.equal((await a.call("GET", "/v1/models")).status, 401);
	const expired = await turn(hex("c"), REAL_A, Date.now() - 1);
	assert.equal((await expired.call("GET", "/v1/models")).status, 401);
	assert.equal(seen.length, 1);
});

test("a lease replaced while a request streams: that one keeps its placeholder, the next carries the new one", async t => {
	const { turn, seen, held } = await stack(t);
	const a = await turn(hex("a"), REAL_A);
	const running = a.call("POST", "/v1/responses", { body: '{"hold":true}' });
	while (!held.length) await new Promise(r => setTimeout(r, 5));
	const NEW = "wlpm1.replacement-lease-" + "z".repeat(40);
	a.replace(NEW);
	const next = await a.call("POST", "/v1/responses");
	assert.equal(next.status, 200);
	assert.equal(seen.at(-1).authorization, "Bearer " + NEW);
	held.shift()();
	const first = await running;
	assert.equal(first.status, 200);
	assert.equal(seen[0].authorization, "Bearer " + REAL_A);
	assert.ok(!first.text.includes(REAL_A) && !next.text.includes(NEW));
});

test("the relay's caps hold per turn: past them a request waits, then is refused with retry-after", async t => {
	const { turn, held } = await stack(t, {
		limits: { sessionRequests: 2, sessionWaiting: 1, machineRequests: 3, waitMs: 300 },
	});
	const a = await turn(hex("a"), REAL_A);
	const b = await turn(hex("b"), REAL_B);
	const holding = [
		a.call("POST", "/v1/responses", { body: '{"hold":1}' }),
		a.call("POST", "/v1/responses", { body: '{"hold":2}' }),
	];
	while (held.length < 2) await new Promise(r => setTimeout(r, 5));
	// A third of A's waits (one may wait), a fourth is refused at once.
	const waiting = a.call("POST", "/v1/responses", { body: '{"hold":3}' });
	await new Promise(r => setTimeout(r, 30));
	const refused = await a.call("POST", "/v1/responses");
	assert.equal(refused.status, 503);
	assert.match(refused.text, /waiting from this session \(1\)/);
	assert.equal(refused.headers["retry-after"], "2");
	// B is not held up by A's ceiling.
	const other = b.call("POST", "/v1/responses", { body: '{"hold":4}' });
	while (held.length < 3) await new Promise(r => setTimeout(r, 5));
	// The one waiting gets no slot within its wait.
	const timedOut = await waiting;
	assert.equal(timedOut.status, 503);
	assert.match(timedOut.text, /at once from this session \(2\)/);
	for (const finish of held.splice(0)) finish();
	assert.deepEqual(
		(await Promise.all([...holding, other])).map(r => r.status),
		[200, 200, 200],
	);
});

test("the provider's error code, type and message reach Windlass; its body does not", async t => {
	const { turn } = await stack(t, {
		upstreamReply: (req, res) => {
			const usage = req.url === "/v1/responses";
			res.writeHead(usage ? 429 : 400, {
				"content-type": "application/json",
				"retry-after": "7",
				"x-request-id": "req_x",
				"openai-organization": "org-secret",
			});
			res.end(
				JSON.stringify(
					usage
						? {
								error: {
									type: "usage_limit_reached",
									code: "usage_limit_reached",
									message: "The usage limit has been reached",
									plan_type: "plus",
									resets_at: 1,
								},
							}
						: {
								error: {
									code: "context_length_exceeded",
									message: `Your input exceeds the context window; seen ${req.headers.authorization}`,
									param: "input",
								},
							},
				),
			);
		},
	});
	const a = await turn(hex("a"), REAL_A);
	const usage = await a.call("POST", "/v1/responses");
	assert.equal(usage.status, 429);
	assert.equal(usage.headers["retry-after"], "7");
	assert.equal(usage.headers["openai-organization"], undefined);
	assert.deepEqual(JSON.parse(usage.text), {
		error: { message: "The usage limit has been reached", type: "usage_limit_reached", code: "usage_limit_reached" },
	});
	const overflow = await a.call("GET", "/v1/models");
	assert.equal(overflow.status, 400);
	const body = JSON.parse(overflow.text);
	assert.equal(body.error.code, "context_length_exceeded");
	assert.equal(body.error.param, "input");
	assert.match(body.error.message, /exceeds the context window; seen Bearer \[redacted\]/);
	assert.ok(!overflow.text.includes(REAL_A));
	for (const status of [401, 403]) {
		const message = "Incorrect API key provided: sk-test****abcd";
		assert.equal(
			JSON.parse(errorBody(status, JSON.stringify({ error: { message } }))).error.message,
			"The provider rejected the API key.",
		);
	}
	// A body that is not JSON is cut down to its text; one with control characters too.
	assert.equal(JSON.parse(errorBody(502, "bad\u0000 gateway")).error.message, "bad gateway");
	assert.equal(JSON.parse(errorBody(500, '{"detail":"x"}')).error.message, "x");
	assert.equal(JSON.parse(errorBody(500, '{"error":{"code":"a b"}}')).error.code, null);
});

test("a model answer with no content type is passed on as an event stream, as api.openai.com sends one for a ChatGPT token", async t => {
	const { turn } = await stack(t, {
		upstreamReply: (req, res) => {
			if (req.url === "/v1/models") {
				res.writeHead(200);
				return res.end("<html>");
			}
			res.writeHead(200);
			res.end(
				`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`,
			);
		},
	});
	const a = await turn(hex("a"), REAL_A);
	const reply = await a.call("POST", "/v1/responses");
	assert.equal(reply.status, 200);
	assert.equal(reply.headers["content-type"], "text/event-stream");
	assert.match(reply.text, /response\.completed/);
	// Only the streaming route: an untyped answer to anything else is still refused.
	assert.equal((await a.call("GET", "/v1/models")).status, 502);
});

test("a redirect is not followed", async t => {
	const { turn, seen } = await stack(t, {
		upstreamReply: (req, res) => {
			res.writeHead(302, { location: "https://example.com/" });
			res.end();
		},
	});
	const a = await turn(hex("a"), REAL_A);
	const reply = await a.call("GET", "/v1/models");
	assert.equal(reply.status, 502);
	assert.equal(seen.length, 1);
});

test("the relay's own refusals carry relay_lease_ended, so the platform does not take them for a rejected sign-in", async t => {
	const { turn } = await stack(t);
	const a = await turn(hex("a"), REAL_A);
	a.end();
	const ended = await a.call("GET", "/v1/models");
	assert.equal(ended.status, 401);
	assert.equal(JSON.parse(ended.text).error.code, "relay_lease_ended");
	const b = await turn(hex("b"), REAL_B);
	assert.equal(
		JSON.parse((await b.call("GET", "/v1/models", { bearer: "wlp-model." + "e".repeat(32) })).text).error.code,
		"relay_lease_ended",
	);
});

test("a user's turns share the hosted relay's ceiling per user", async t => {
	const { turn, held } = await stack(t, {
		limits: { sessionRequests: 4, userRequests: 2, machineRequests: 10, waitMs: 300 },
	});
	const a = await turn(hex("a"), REAL_A, undefined, "u1");
	const b = await turn(hex("b"), REAL_B, undefined, "u1");
	const c = await turn(hex("c"), REAL_B, undefined, "u2");
	const running = [
		a.call("POST", "/v1/responses", { body: '{"hold":1}' }),
		b.call("POST", "/v1/responses", { body: '{"hold":2}' }),
	];
	while (held.length < 2) await new Promise(r => setTimeout(r, 5));
	// A third of u1's, from a turn with room of its own, waits and is refused naming the user's ceiling.
	const third = await a.call("POST", "/v1/responses");
	assert.equal(third.status, 503);
	assert.match(third.text, /from your sessions \(2\)/);
	// Another user is not held up.
	const other = c.call("POST", "/v1/responses", { body: '{"hold":3}' });
	while (held.length < 3) await new Promise(r => setTimeout(r, 5));
	for (const finish of held.splice(0)) finish();
	assert.deepEqual(
		(await Promise.all([...running, other])).map(r => r.status),
		[200, 200, 200],
	);
});

test("a lease that ends stops its requests still running, and a request that started after it is refused", async t => {
	const { turn, held, closed } = await stack(t, { providerOptions: { watchMs: 30 } });
	const a = await turn(hex("a"), REAL_A);
	const b = await turn(hex("b"), REAL_B);
	// Cut off before or while it answers: the client sees the connection end either way.
	const streaming = a
		.call("POST", "/v1/responses", { body: '{"hold":1}' })
		.catch(error => ({ cut: true, error: error.code }));
	const other = b.call("POST", "/v1/responses", { body: '{"hold":2}' });
	while (held.length < 2) await new Promise(r => setTimeout(r, 5));
	a.end();
	const cut = await streaming;
	assert.ok(cut.cut || cut.status !== 200 || !cut.text.includes("response.completed"), JSON.stringify(cut));
	for (let i = 0; i < 100 && !closed.length; i++) await new Promise(r => setTimeout(r, 10));
	assert.deepEqual(closed, ["/v1/responses"], "the upstream request of the ended lease was closed");
	held[1]();
	assert.equal((await other).status, 200, "another lease's request was not touched");
	assert.equal(JSON.parse((await a.call("GET", "/v1/models")).text).error.code, "relay_lease_ended");
});

test("the relay deletes the files of expired tokens and of no lease, and leaves live ones and writes in progress", async t => {
	const files = new Map([
		[hex("1") + ".json", { ...forwarded(REAL_A, Date.now() + 60_000), lease: "wlp-model." + hex("9") }],
		[hex("2") + ".json", { ...forwarded(REAL_A, Date.now() - 1), lease: "wlp-model." + hex("9") }],
		[hex("3") + ".json", { nonsense: true }],
		[hex("4") + ".json.tmp", null],
		["stray", null],
	]);
	const removed = [];
	const { turn } = await stack(t, {
		providerOptions: {
			sweepMs: 20,
			list: async () => [...files.keys()],
			remove: async name => {
				removed.push(name);
				files.delete(name);
			},
			load: async nonce => {
				const r = files.get(nonce + ".json");
				if (!r) throw new Error("gone");
				return r;
			},
		},
	});
	await turn(hex("a"), REAL_A);
	for (let i = 0; i < 100 && removed.length < 3; i++) await new Promise(r => setTimeout(r, 10));
	assert.deepEqual(removed.sort(), [hex("2") + ".json", hex("3") + ".json", "stray"].sort());
	assert.ok(files.has(hex("1") + ".json") && files.has(hex("4") + ".json.tmp"));
});
