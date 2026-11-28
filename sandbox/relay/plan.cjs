// A plan's relay inside an E2B or Daytona sandbox, run as another user than the agent's
// (server/src/sandbox/plan-relay.ts, docs/model-relay.md "Plan requests from the sandbox").
// Everything it is given comes on standard input, one JSON object per line, so nothing of it is in its
// arguments, its environment or a file the agent could read:
//   {token, placeholder, expiresAt, wire, harness}
//                                     first: the token, the bearer it accepts in its place, when it stops, the
//                                     plan's wire (claude-plan, chatgpt-plan) and the agent whose routes it allows
//   {token, expiresAt?}               later: replaces the token; requests that start after it carry the new one.
//                                     A later `expiresAt` moves when it stops (a turn taken up after a restart)
//   {took, ok}                        the platform's answer to a request it was asked to count
// On a paired machine the first line also names `socket`, a Unix socket path in the relay's socket volume: it listens
// there instead, behind the turn's forwarder, which writes its nonce first (server/src/sandbox/model-relay.ts `openPlan`).
// It writes {listening: port} once it can take requests (port 0 on a socket), {take: n} for each request to count,
// {handed: true} after a replaced token, and {seen: {status, headers, code, resetsAt}} for what the provider said of
// the plan's health (every error, a success at most every SEEN_OK_MS). Standard input closing ends it.
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const { timingSafeEqual } = require("node:crypto");
const { createRelay, scrubStream } = require("./server.cjs");
const { harnessMethod } = require("./wires.cjs");
const { wireTarget, errorBody, placeholderOf, limitFacts, LEASE_ENDED } = require("./windlass.cjs");

const WIRES = ["claude-plan", "chatgpt-plan"];
// The shared relay counts by a connection's nonce. This relay has one session, so every connection carries the same.
const NONCE = "0".repeat(32);
const TOKEN = /^[\x21-\x7e]{16,4096}$/;
const PLACEHOLDER = /^wlp-plan\.[A-Za-z0-9_-]{43}$/;
// A machine's relay listens in its socket volume (/workspace/plan-<nonce>.sock); the checks, in a directory of their own.
const SOCKET = /^(?:\/[A-Za-z0-9_-]+)+\/plan-[a-f0-9]{32}\.sock$/;
const COUNT_MS = 30_000;
const FIRST_MESSAGE_MS = 10_000;
const SEEN_OK_MS = 15_000;

function same(a, b) {
	const x = Buffer.from(String(a)),
		y = Buffer.from(String(b));
	return x.length === y.length && timingSafeEqual(x, y);
}

/** The relay's provider (server.cjs `createRelay`): only the agent's routes on the plan's wire, only with the turn's placeholder. */
function planProvider(state, { upstream, take, now = Date.now, seen = () => {} }) {
	const live = () => state.expiresAt > now();
	const { wire, harness } = state;
	// Claude Code asks whether its API is there before it starts.
	const hello = wire === "claude-plan";
	return {
		methodFor: url => (hello && url === "/api/hello" ? "HEAD" : harnessMethod(harness, wire, url) || undefined),
		bearer: placeholderOf,
		unauthorizedCode: LEASE_ENDED,
		authorize: bearer => live() && typeof bearer === "string" && same(bearer, state.placeholder),
		answersLocally: (method, url) => hello && method === "HEAD" && url === "/api/hello",
		async target(url, headers) {
			if (!live()) return;
			// The token as it is now: one replaced while this request runs is not this request's.
			const token = state.token;
			const target = wireTarget(wire, url, headers, token);
			if (!target) return { refused: true };
			const counted = await take();
			if (counted === "limit")
				return { refused: true, status: 429, message: "This turn reached its model request limit." };
			if (counted !== "ok") return { refused: true, status: 503, message: "The relay could not count the request." };
			return { ...target, ...upstream, secrets: [...state.used, state.placeholder] };
		},
		responseFilter: (type, url, secrets) => scrubStream(secrets ?? [], type, true),
		errorBody,
		// The headers come through `limitHeaders`; of an error body only its code and a named reset go on.
		observe(status, headers, text) {
			const at = now();
			if (status >= 200 && status < 300 && state.lastOk !== undefined && at - state.lastOk < SEEN_OK_MS) return;
			if (status >= 200 && status < 300) state.lastOk = at;
			else state.lastOk = undefined;
			seen({ status, headers, ...(typeof text === "string" && limitFacts(text, [...state.used])) });
		},
	};
}

/** Runs the relay on the control stream: `rest` is what the loader read past its own line. */
function main(input = process.stdin, output = process.stdout, rest = "") {
	const fail = message => {
		process.stderr.write("[wlp-plan-relay] " + message + "\n");
		process.exit(2);
	};
	const say = fields => output.write(JSON.stringify(fields) + "\n");
	let state = null,
		buffer = rest,
		counted = 0;
	const waiting = new Map();
	const first = setTimeout(() => fail("no token on standard input"), FIRST_MESSAGE_MS);
	const take = () =>
		new Promise(resolve => {
			const id = ++counted;
			const timer = setTimeout(() => {
				waiting.delete(id);
				resolve("timeout");
			}, COUNT_MS);
			waiting.set(id, ok => {
				clearTimeout(timer);
				resolve(ok ? "ok" : "limit");
			});
			say({ take: id });
		});

	function listen(config) {
		const target = config.upstream ? new URL(config.upstream) : null;
		const upstream = target
			? { hostname: target.hostname, port: Number(target.port || (target.protocol === "http:" ? 80 : 443)) }
			: undefined;
		const provider = planProvider(state, { upstream, take, seen: fields => say({ seen: fields }) });
		let relay = null;
		const path = config.socket;
		if (path !== undefined && (typeof path !== "string" || !SOCKET.test(path))) return fail("unusable socket path");
		const server = net.createServer(socket => {
			if (!relay) return socket.destroy();
			// Behind a forwarder the connection starts with the forwarder's own nonce.
			if (!path) socket.unshift(Buffer.from(NONCE, "latin1"));
			relay.emit("connection", socket);
		});
		server.maxConnections = 64;
		server.on("error", error => fail("cannot listen: " + (error.code ?? "error")));
		const ready = () => {
			const port = path ? 0 : server.address().port;
			relay = createRelay({
				provider,
				// The forwarder's port in the sandbox (runner/src/egress-proxy.mjs `wlp-model-forward`).
				host: "127.0.0.1:" + (path ? 17893 : port),
				forward: target?.protocol === "http:" ? http.request : https.request,
			});
			say({ listening: port });
		};
		if (path) {
			try {
				require("node:fs").rmSync(path, { force: true });
			} catch {}
			process.on("exit", () => {
				try {
					require("node:fs").rmSync(path, { force: true });
				} catch {}
			});
			server.listen(path, ready);
		} else server.listen(0, "127.0.0.1", ready);
		// A sandbox paused past the turn's end and resumed: the wall clock says so, not the timers.
		setInterval(() => {
			if (state.expiresAt <= Date.now()) process.exit(0);
		}, 5000).unref();
	}

	function message(line) {
		let value;
		try {
			value = JSON.parse(line);
		} catch {
			return fail("unreadable control message");
		}
		if (!value || typeof value !== "object") return fail("unreadable control message");
		if (!state) {
			const { token, placeholder, expiresAt, wire, harness } = value;
			if (typeof token !== "string" || !TOKEN.test(token)) return fail("no token on standard input");
			if (typeof placeholder !== "string" || !PLACEHOLDER.test(placeholder)) return fail("no placeholder");
			if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return fail("no expiry");
			if (!WIRES.includes(wire) || typeof harness !== "string") return fail("no plan wire");
			clearTimeout(first);
			state = { token, placeholder, expiresAt, wire, harness, used: new Set([token]) };
			return listen(value);
		}
		if (typeof value.token === "string") {
			if (!TOKEN.test(value.token)) return fail("unreadable token");
			state.token = value.token;
			state.used.add(value.token);
			if (Number.isSafeInteger(value.expiresAt) && value.expiresAt > state.expiresAt) state.expiresAt = value.expiresAt;
			return say({ handed: true });
		}
		if (Number.isSafeInteger(value.took)) {
			waiting.get(value.took)?.(value.ok === true);
			waiting.delete(value.took);
		}
	}

	function receive(text) {
		buffer += text;
		let end;
		while ((end = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			if (line.trim()) message(line);
		}
		if (buffer.length > 65536) fail("control message too long");
	}
	input.setEncoding?.("utf8");
	input.on("data", receive);
	input.on("end", () => process.exit(0));
	input.on("error", () => process.exit(0));
	receive("");
}

module.exports = { main, planProvider, PLACEHOLDER };
