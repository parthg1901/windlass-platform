// Runs in the trusted relay container. Only this process opens the login file.
// The trusted namespace forwarder prefixes each Unix stream with its fixed session nonce.
const { createPublicKey, verify } = require("node:crypto");
const net = require("node:net");
const { pipeline, Transform } = require("node:stream");
const { StringDecoder } = require("node:string_decoder");
const { createGunzip, createInflate, createBrotliDecompress, createZstdDecompress } = require("node:zlib");
const { existsSync, rmSync } = require("node:fs");
const { readFile, rename, writeFile } = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");

const decoders = new Map([
	["gzip", createGunzip],
	["deflate", createInflate],
	["br", createBrotliDecompress],
	["zstd", createZstdDecompress],
]);
const { gunzipSync, inflateSync, brotliDecompressSync, zstdDecompressSync } = require("node:zlib");
const syncDecoders = new Map([
	["gzip", gunzipSync],
	["deflate", inflateSync],
	["br", brotliDecompressSync],
	["zstd", zstdDecompressSync],
]);
/** An upstream error body as text, decoded when compressed; at most 64 KiB in and out. */
function decodeError(bytes, encoding) {
	const decode =
		encoding && encoding.toLowerCase() !== "identity" ? syncDecoders.get(encoding.toLowerCase()) : undefined;
	if (encoding && encoding.toLowerCase() !== "identity" && !decode) return "";
	return (decode ? decode(bytes, { maxOutputLength: 65536 }) : bytes).toString("utf8");
}
const messages = new Set([
	"/v1/messages",
	"/v1/messages?beta=true",
	"/v1/messages/count_tokens",
	"/v1/messages/count_tokens?beta=true",
]);
const requestHeaders = new Set([
	"accept",
	"content-type",
	"anthropic-beta",
	"anthropic-version",
	"user-agent",
	"x-app",
	"anthropic-dangerous-direct-browser-access",
	"x-client-request-id",
	"x-claude-code-session-id",
]);

// Filter at the credential boundary, before any result can enter an agent file, log or ACP stream.
function matcher(secrets) {
	let pending = "";
	function consume(text, final) {
		const input = pending + text;
		pending = "";
		let result = "",
			start = 0;
		while (start < input.length) {
			let at = input.length,
				size = 0,
				partial = input.length;
			for (const secret of secrets) {
				let i = input.indexOf(secret[0], start);
				while (i >= 0 && i <= at) {
					if (input.startsWith(secret, i)) {
						if (i < at || secret.length > size) {
							at = i;
							size = secret.length;
						}
						break;
					}
					if (!final && input.length - i < secret.length && secret.startsWith(input.slice(i))) {
						partial = Math.min(partial, i);
						break;
					}
					i = input.indexOf(secret[0], i + 1);
				}
			}
			if (partial <= at && partial < input.length) {
				at = partial;
				size = 0;
			}
			result += input.slice(start, at);
			if (!size) {
				pending = input.slice(at);
				break;
			}
			result += "[redacted]";
			start = at + size;
		}
		return result;
	}
	consume.pending = () => pending.length > 0;
	return consume;
}

function scrubStream(secrets, type, responses = false) {
	const decoder = new StringDecoder("utf8");
	const consume = matcher(secrets);
	if (type === "text/event-stream" || type === "application/json") return structuredStream(secrets, type, responses);
	return new Transform({
		transform(chunk, encoding, done) {
			done(null, consume(decoder.write(chunk), false));
		},
		flush(done) {
			done(null, consume(decoder.end(), true));
		},
	});
}
// Decode provider strings before comparing them to credentials. Keep only a possible secret
// suffix between deltas in the same block, so ordinary model text is delivered immediately.
function structuredStream(secrets, type, responses) {
	const decoder = new StringDecoder("utf8");
	const scalar = matcher(secrets);
	const pieces = new Map();
	const limit = 16 * 1024 * 1024;
	let buffer = "",
		data = [],
		frameSize = 0,
		fields = [],
		skipLF = false;
	const clean = value => {
		if (typeof value === "string") return scalar(value, true);
		if (Array.isArray(value)) return value.map(clean);
		if (value && typeof value === "object") {
			return Object.fromEntries(Object.entries(value).map(([key, v]) => [scalar(key, true), clean(v)]));
		}
		return value;
	};
	// Keep only a possible secret suffix per logical output, including interleaved choices or tool calls.
	function piece(key, object, field, final, envelope) {
		if (typeof object?.[field] !== "string") return;
		const consume = pieces.get(key)?.consume ?? matcher(secrets);
		object[field] = consume(object[field], final);
		if (consume.pending()) {
			if (pieces.size >= 256 && !pieces.has(key)) throw Error("Too many open model deltas");
			pieces.set(key, { consume, envelope });
		} else pieces.delete(key);
	}
	function flushPieces(emit, prefix = "") {
		for (const [key, entry] of pieces)
			if (key.startsWith(prefix)) {
				emit(entry.envelope(entry.consume("", true)));
				pieces.delete(key);
			}
	}
	function anthropicPieces(event, emit) {
		const type = event?.type;
		if (type === "content_block_delta") {
			const index = event.index;
			if (!Number.isSafeInteger(index)) throw Error("Invalid content block");
			const kind = event.delta?.type;
			const field = {
				text_delta: "text",
				input_json_delta: "partial_json",
				thinking_delta: "thinking",
				signature_delta: "signature",
			}[kind];
			if (typeof field === "string")
				piece("block/" + index + "/" + field, event.delta, field, false, text => ({
					type,
					index,
					delta: { type: kind, [field]: text },
				}));
		} else if (type === "content_block_stop") flushPieces(emit, "block/" + event.index + "/");
		else if (type === "message_stop") flushPieces(emit, "block/");
	}
	function responsesPieces(event, emit) {
		const type = event?.type;
		if (typeof type === "string" && type.startsWith("response.")) {
			const key =
				"responses/" +
				JSON.stringify([
					type.replace(/\.(?:done|delta)$/, ""),
					event.item_id,
					event.output_index,
					event.content_index,
					event.summary_index,
				]);
			if (type.endsWith(".delta")) piece(key, event, "delta", false, delta => ({ ...event, delta }));
			else if (type.endsWith(".done")) flushPieces(emit, key);
			else if (type === "response.completed") flushPieces(emit, "responses/");
		}
	}
	function chatPieces(event, emit) {
		for (const choice of event?.choices ?? []) {
			const index = choice.index ?? 0;
			const prefix = "chat/" + index + "/";
			// Keep chunk metadata for SDKs that validate the envelope.
			const { id, object, created, model } = event;
			const wrap = delta => ({ id, object, created, model, choices: [{ index, delta, finish_reason: null }] });
			for (const field of ["content", "reasoning", "reasoning_content"])
				piece(prefix + field, choice.delta, field, !!choice.finish_reason, text => wrap({ [field]: text }));
			for (const tool of choice.delta?.tool_calls ?? []) {
				const i = tool.index ?? 0;
				piece(prefix + "tool/" + i, tool.function, "arguments", !!choice.finish_reason, text =>
					wrap({ tool_calls: [{ index: i, function: { arguments: text } }] }),
				);
			}
			if (choice.finish_reason) flushPieces(emit, prefix);
		}
	}
	function geminiPieces(event, emit) {
		for (const candidate of event?.candidates ?? []) {
			const index = candidate.index ?? 0;
			const prefix = "gemini/" + index + "/";
			for (const part of candidate.content?.parts ?? []) {
				const thought = part.thought === true;
				piece(prefix + (thought ? "thought" : "text"), part, "text", !!candidate.finishReason, text => ({
					candidates: [{ index, content: { role: "model", parts: [{ text, ...(thought && { thought }) }] } }],
				}));
			}
			if (candidate.finishReason) flushPieces(emit, prefix);
		}
	}
	function modelPieces(event, emit) {
		anthropicPieces(event, emit);
		if (!responses) return;
		responsesPieces(event, emit);
		chatPieces(event, emit);
		geminiPieces(event, emit);
	}
	function deltaFrame(event) {
		const safe = clean(event);
		return (
			(typeof safe.type === "string" && /^[a-z._0-9]+$/.test(safe.type) ? "event: " + safe.type + "\n" : "") +
			"data: " +
			JSON.stringify(safe) +
			"\n\n"
		);
	}
	function frame(output) {
		let body = data.join("\n");
		const emit = event => output(deltaFrame(event));
		if (body.trim() === "[DONE]") flushPieces(emit);
		else if (body.trim()) {
			const event = JSON.parse(body);
			modelPieces(event, emit);
			body = JSON.stringify(clean(event));
		}
		for (const field of fields) output(scalar(field, true) + "\n");
		if (data.length) output("data: " + body + "\n");
		output("\n");
		data = [];
		fields = [];
		frameSize = 0;
	}
	function line(value, output) {
		if (!value) return frame(output);
		if (value === "data" || value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
		else if (/^(event|id|retry)(:|$)/.test(value)) fields.push(value);
		else {
			output(scalar(value, true) + "\n");
			return;
		} // comments and ignored SSE fields
		frameSize += value.length + 1;
		if (frameSize > limit) throw Error("Provider event too large");
	}
	function receive(text, final, output) {
		if (!text && !final) return;
		if (type === "application/json") {
			buffer += text;
			if (buffer.length > limit) throw Error("Provider response too large");
			if (final) {
				let value = JSON.parse(buffer);
				// Without alt=sse Gemini streams a JSON array of generation chunks.
				if (responses && Array.isArray(value)) {
					const events = [];
					for (const event of value) {
						modelPieces(event, item => events.push(item));
						events.push(event);
					}
					flushPieces(item => events.push(item));
					value = events;
				}
				output(JSON.stringify(clean(value)));
			}
			return;
		}
		if (skipLF && text.startsWith("\n")) text = text.slice(1);
		skipLF = text.endsWith("\r");
		let start = 0;
		for (const m of text.matchAll(/\r\n|[\r\n]/g)) {
			line(buffer + text.slice(start, m.index), output);
			buffer = "";
			start = m.index + m[0].length;
		}
		buffer += text.slice(start);
		if (buffer.length + frameSize > limit) throw Error("Provider event too large");
		if (final) {
			if (buffer) {
				// Preserve the final unterminated line of non-event diagnostic text.
				if (!data.length && !fields.length && !/^(data|event|id|retry)(:|$)/.test(buffer)) output(scalar(buffer, true));
				else line(buffer, output);
			}
			if (data.length || fields.length) frame(output);
			flushPieces(event => output(deltaFrame(event)));
		}
	}
	return new Transform({
		destroy(error, done) {
			done(error && Error("Invalid model response"));
		},
		transform(chunk, encoding, done) {
			try {
				receive(decoder.write(chunk), false, s => this.push(s));
				done();
			} catch {
				done(Error("Invalid model response"));
			}
		},
		flush(done) {
			try {
				receive(decoder.end(), true, s => this.push(s));
				done();
			} catch {
				done(Error("Invalid model response"));
			}
		},
	});
}
exports.scrubStream = scrubStream;

/**
 * The runner writes this into the socket volume before it stops a relay for a logout, and the next relay
 * removes it. Without it a stopping or missing relay is being replaced (update, re-pair, new login): retryable.
 */
const SIGNED_OUT = "/workspace/signed-out";
exports.SIGNED_OUT = SIGNED_OUT;
/** A stopping relay starts no refresh: the request is refused as retryable, or as signed out after a logout. */
class Stopping extends Error {}
exports.Stopping = Stopping;

// Bound requests and connections per session and across the machine's shared credential.
// Local saturation returns 503 with retry-after. Claude treats a subscription 429 as an account limit.
const SESSION_REQUESTS = 8,
	SESSION_CONNECTIONS = 32,
	MACHINE_REQUESTS = 24;
exports.limits = {
	sessionRequests: SESSION_REQUESTS,
	sessionConnections: SESSION_CONNECTIONS,
	machineRequests: MACHINE_REQUESTS,
	sessionWaiting: 32,
	machineWaiting: 128,
	waitMs: 90_000,
	firstRequestMs: 10_000,
};

// Rate-limit facts the harness reads to report its own limit state. Nothing that names an account or a
// request (request-id, cookies, cf-*, organization ids), and only short values from a small character set.
const limitHeader =
	/^(?:retry-after(?:-ms)?|anthropic-ratelimit-[a-z0-9-]+|x-ratelimit-[a-z0-9-]+|x-codex(?:-[a-z0-9]+)*-(?:primary|secondary)-(?:used-percent|window-minutes|reset-at)|x-codex(?:-[a-z0-9]+)*-limit-name|x-codex-credits-(?:has-credits|unlimited|balance)|x-codex-rate-limit-reached-type)$/;
function limitHeaders(headers, secrets = []) {
	const result = {};
	let count = 0;
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (count >= 24) break;
		// Real values are numbers, timestamps, durations and status words.
		if (
			name.length > 64 ||
			!limitHeader.test(name) ||
			typeof value !== "string" ||
			!/^[A-Za-z0-9 .,:_+-]{0,64}$/.test(value)
		)
			continue;
		if ([...secrets].some(secret => secret && (name.includes(secret) || value.includes(secret)))) continue;
		result[name] = value;
		count++;
	}
	return result;
}
exports.limitHeaders = limitHeaders;

function reject(res, status, { restarting = false, message: own, headers = {}, code } = {}) {
	let type = "api_error",
		message = "The provider rejected the request.";
	if (status === 401) {
		type = "authentication_error";
		message = "Provider sign-in is missing or the session placeholder is no longer valid.";
	} else if (status === 403) {
		type = "permission_error";
		message = "This request is not allowed by the relay.";
	} else if (status === 429) {
		type = "rate_limit_error";
		message = "The provider's usage or rate limit was reached.";
	} else if (restarting) {
		message = "The relay is restarting. Try again.";
		res.setHeader("retry-after", "1");
	} else if (status >= 500) {
		message = "The provider failed or couldn't be reached.";
	}
	res.writeHead(status, { ...headers, "content-type": "application/json" });
	res.end(JSON.stringify({ type: "error", error: { type, ...(code && { code }), message: own ?? message } }));
}

/**
 * What the relay notes about an answer it did not pass on as the provider gave it: never a body, a header that
 * could carry a credential, or a query string. The latest notes are also
 * kept in a file beside the socket (`notesFile`), which `windlass-runner status` reads.
 */
// Restrict diagnostics to known values. Even printable response headers can echo a secret.
const mediaTypes = new Set([
	"application/json",
	"text/event-stream",
	"text/html",
	"text/plain",
	"application/octet-stream",
]);
const encodings = new Set(["identity", ...decoders.keys()]);
const networkErrors = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE"]);
const diagnostic = (value, allowed) => (value === undefined ? "none" : allowed.has(value) ? value : "other");
const NOTES_KEPT = 20;
exports.NOTES_FILE = "/workspace/relay-notes.json";
function notesOf(notesFile) {
	const kept = [];
	let writing = Promise.resolve();
	const note = fields => {
		const entry = { at: new Date().toISOString(), ...fields };
		console.error(
			"[wlp-relay] " +
				Object.entries(entry)
					.map(([k, v]) => k + "=" + v)
					.join(" "),
		);
		kept.push(entry);
		if (kept.length > NOTES_KEPT) kept.shift();
		if (!notesFile) return;
		const body = JSON.stringify(kept);
		writing = writing
			.then(async () => {
				const temp = notesFile + "." + process.pid;
				await writeFile(temp, body, { mode: 0o644 });
				await rename(temp, notesFile);
			})
			.catch(() => {});
	};
	note.kept = kept;
	return note;
}

function adjustCount(map, key, delta) {
	const count = (map.get(key) ?? 0) + delta;
	if (count) map.set(key, count);
	else map.delete(key);
}

// One FIFO per relay. A full session or user must not block eligible waiters.
function requestAdmission(limits, onClose) {
	const inFlight = new Map(),
		userInFlight = new Map(),
		queued = new Map();
	const waiting = [];
	let machineInFlight = 0;
	function countActive(nonce, user, delta) {
		machineInFlight += delta;
		adjustCount(inFlight, nonce, delta);
		if (user !== undefined) adjustCount(userInFlight, user, delta);
	}
	const userRoom = user => user === undefined || (userInFlight.get(user) ?? 0) < (limits.userRequests ?? Infinity);
	const room = (nonce, user) =>
		(inFlight.get(nonce) ?? 0) < limits.sessionRequests && userRoom(user) && machineInFlight < limits.machineRequests;
	const full = (nonce, user) =>
		(inFlight.get(nonce) ?? 0) >= limits.sessionRequests
			? `Too many model requests at once from this session (${limits.sessionRequests}).`
			: !userRoom(user)
				? `Too many model requests at once from your sessions (${limits.userRequests}).`
				: `Too many model requests at once on this machine (${limits.machineRequests}).`;
	function leave(entry) {
		const at = waiting.indexOf(entry);
		if (at < 0) return false;
		waiting.splice(at, 1);
		adjustCount(queued, entry.nonce, -1);
		return true;
	}
	// Give freed slots to the earliest waiters whose session has room.
	function drain() {
		for (let i = 0; i < waiting.length && machineInFlight < limits.machineRequests; ) {
			const entry = waiting[i];
			if (room(entry.nonce, entry.user)) {
				leave(entry);
				entry.grant();
			} else i++;
		}
	}
	// Pipelined responses may have no socket yet; count against the request socket until release.
	return function admit(req, res, nonce, user) {
		const closing = onClose.get(req.socket);
		return new Promise(resolve => {
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				res.off("close", release);
				closing.delete(release);
				countActive(nonce, user, -1);
				drain();
			};
			const start = () => {
				// Releasing a slot on socket close can drain a waiter on that same socket.
				if (req.socket.destroyed || res.destroyed) return resolve(false);
				countActive(nonce, user, 1);
				res.once("close", release);
				closing.add(release);
				resolve(true);
			};
			if (room(nonce, user)) return start();
			const refuse = message => {
				reject(res, 503, { message, headers: { "retry-after": "2" } });
				resolve(false);
			};
			if ((queued.get(nonce) ?? 0) >= limits.sessionWaiting)
				return refuse(`Too many model requests waiting from this session (${limits.sessionWaiting}).`);
			if (waiting.length >= limits.machineWaiting)
				return refuse(`Too many model requests waiting on this machine (${limits.machineWaiting}).`);
			const done = () => {
				clearTimeout(timer);
				res.off("close", gone);
				closing.delete(gone);
			};
			const gone = () => {
				if (leave(entry)) {
					done();
					resolve(false);
				}
			};
			const entry = {
				nonce,
				user,
				grant: () => {
					done();
					start();
				},
			};
			const timer = setTimeout(() => {
				if (leave(entry)) {
					done();
					refuse(full(nonce, user));
				}
			}, limits.waitMs);
			res.once("close", gone);
			closing.add(gone);
			waiting.push(entry);
			adjustCount(queued, nonce, 1);
		});
	};
}

exports.createRelay = function createRelay({
	publicKey,
	machine,
	readToken = () => readFile("/run/wlp-harness/claude/token", "utf8"),
	forward = https.request,
	domain = "windlass-claude-relay-v2",
	provider,
	harness = publicKey && !provider ? "claude" : undefined,
	signedOut = () => existsSync(SIGNED_OUT),
	limits: overrides,
	host = "127.0.0.1:17892",
	notesFile,
}) {
	const limits = { ...exports.limits, ...overrides };
	const note = notesOf(notesFile);
	const sessions = new WeakMap();
	const open = new Map();
	// Revocation stops this nonce's active upstream requests.
	const active = new Map();
	// The relay's own 401: where the provider gives it a code, the client can tell it from the provider's.
	const unauthorized = res =>
		reject(
			res,
			401,
			provider?.unauthorizedCode
				? {
						code: provider.unauthorizedCode,
						message: "The model relay has no lease for this turn any more: the turn ended, or the relay was restarted.",
					}
				: {},
		);
	// Per socket: what to run when it closes (one listener, however many requests are pipelined on it).
	const onClose = new WeakMap();
	const admit = requestAdmission(limits, onClose);
	const machineProvider = provider;
	const httpServer = http.createServer(async (req, res) => {
		const key = harness && require("./harness-key.cjs").harnessKeyProvider(harness, machine, req.headers, scrubStream);
		if (harness && !publicKey && !key) return reject(res, 401);
		const provider = key || machineProvider;
		const methodFor = provider?.methodFor ?? (url => (provider ? provider.accepts(url) : messages.has(url)) && "POST");
		// A request arrived: the socket's idle deadline (ingress) no longer applies. Node's own keep-alive one does.
		req.socket.setTimeout(0);
		// A forwarder can retry only if this connection has sent no response bytes.
		if (machineProvider?.closeEachReply) res.setHeader("connection", "close");
		try {
			if (req.headers.host !== host || req.method !== methodFor(req.url)) return reject(res, 403);
			const bearer = provider ? provider.bearer(req.headers, req.url) : req.headers.authorization;
			const nonce = sessions.get(req.socket);
			let user;
			if (provider?.authorize) {
				// A relay without a signing key: the provider checks the bearer against the lease of the connection's nonce.
				const lease = nonce ? await provider.authorize(bearer, nonce, req.url) : false;
				if (!lease) return unauthorized(res);
				if (typeof lease === "object" && typeof lease.user === "string") user = lease.user;
				// A reachability check the provider answers itself, once the bearer is known (Claude Code's HEAD /api/hello).
				if (provider.answersLocally?.(req.method, req.url)) {
					res.writeHead(200, { "cache-control": "no-store" });
					return res.end();
				}
			} else {
				const match = /^Bearer ([a-f0-9]{32})\.([A-Za-z0-9_-]{86})$/.exec(bearer ?? "");
				if (
					!match ||
					!verify(
						null,
						Buffer.from(domain + "\n" + machine + "\n" + match[1]),
						publicKey,
						Buffer.from(match[2], "base64url"),
					)
				)
					return reject(res, 401);
				if (nonce !== match[1]) return reject(res, 401);
			}
			if (req.socket.destroyed || res.destroyed || !(await admit(req, res, nonce, user))) return;
			// From here until the response ends, the lease's end stops this request (`endSession`).
			const stop = () => {
				res.destroy();
			};
			let mine = active.get(nonce);
			if (!mine) active.set(nonce, (mine = new Set()));
			mine.add(stop);
			res.once("close", () => {
				mine.delete(stop);
				if (!mine.size && active.get(nonce) === mine) active.delete(nonce);
			});
			let target;
			let claudeToken, own;
			// `own`: the credentials of this one request, where the provider names them (a relay of many sessions' tokens).
			const secrets = () => (claudeToken ? [claudeToken] : (own ?? provider?.secrets?.() ?? []));
			if (provider) {
				target = await provider.target(req.url, req.headers, nonce);
				if (!target) return unauthorized(res);
				// A refusal may name its own status and sentence (a turn's request limit); otherwise not allowed.
				if (target.refused) return reject(res, target.status ?? 403, target.message ? { message: target.message } : {});
				({ secrets: own, ...target } = target);
			} else {
				const token = await readToken().catch(() => undefined);
				if (!token || token.length > 512 || !/^sk-ant-oat01-[A-Za-z0-9_-]+$/.test(token)) return reject(res, 401);

				claudeToken = token;
				const headers = { authorization: "Bearer " + token };
				for (const [key, value] of Object.entries(req.headers)) {
					if (requestHeaders.has(key) || key.startsWith("x-stainless-")) headers[key] = value;
				}
				target = { hostname: "api.anthropic.com", path: req.url, headers };
			}
			if (res.destroyed) return;
			const route = req.method + " " + req.url.split("?")[0].replace(/(\/models\/)[^/]+:/, "$1[model]:");
			const up = forward({ port: 443, ...target, method: req.method }, reply => {
				const described = {
					route,
					upstream: reply.statusCode,
					contentType: diagnostic(reply.headers["content-type"]?.split(";")[0].trim().toLowerCase(), mediaTypes),
					contentEncoding: diagnostic(reply.headers["content-encoding"]?.toLowerCase(), encodings),
				};
				// What the provider said of the credential's health (a plan's: plan.cjs), from its status and limit headers only.
				const observe = text => {
					try {
						provider?.observe?.(reply.statusCode, limitHeaders(reply.headers, secrets()), text);
					} catch {}
				};
				// No redirects, reflected upstream error bodies, cookies, or diagnostic headers.
				if (reply.statusCode !== 200) {
					const status = reply.statusCode >= 400 && reply.statusCode < 600 ? reply.statusCode : 502;
					note({ event: "upstream_error", ...described, answered: status });
					if (!provider?.errorBody || status === 502) observe();
					if (provider?.errorBody && status !== 502) {
						// The provider's own error, cut down to what the client classifies it by: read whole, bounded, then rewritten.
						const parts = [];
						let size = 0;
						reply.on("data", chunk => {
							size += chunk.length;
							if (size <= 65536) parts.push(chunk);
							else reply.destroy();
						});
						// Cut off or too large: the relay's own body for the status.
						reply.on("close", () => {
							if (!reply.complete && !res.headersSent && !res.destroyed) reject(res, status);
						});
						reply.on("error", () => {});
						reply.on("end", () => {
							if (res.headersSent || res.destroyed) return;
							let text = "";
							try {
								text = decodeError(Buffer.concat(parts), reply.headers["content-encoding"]);
							} catch {}
							observe(text);
							res.writeHead(status, {
								...([429, 503, 529].includes(status) ? limitHeaders(reply.headers, secrets()) : {}),
								"content-type": "application/json",
								"cache-control": "no-store",
							});
							res.end(provider.errorBody(status, text, secrets()));
						});
						return;
					}
					// The relay's own body, never the upstream's; a limit refusal keeps its rate-limit headers.
					reject(res, status, {
						headers: [429, 503, 529].includes(status) ? limitHeaders(reply.headers, secrets()) : {},
					});
					reply.destroy();
					return;
				}
				observe();
				let type = reply.headers["content-type"]?.split(";")[0].trim().toLowerCase();
				// A provider may name the type of an answer that comes without one (or as text/plain) on its streaming route.
				const given = type;
				if ((!type || type === "text/plain") && provider?.untyped) type = provider.untyped(req.method, req.url) ?? type;
				if (type !== "text/event-stream" && type !== "application/json") {
					note({ event: "refused_200", ...described, answered: 502 });
					reject(res, 502);
					reply.destroy();
					return;
				}
				if (type !== given) note({ event: "untyped_200", ...described, passedAs: type });
				// Decode before redaction. Only the whitelisted media type reaches the client.
				const stages = [reply];
				const encoding = reply.headers["content-encoding"]?.toLowerCase();
				if (encoding && encoding !== "identity") {
					const decode = decoders.get(encoding);
					if (!decode) {
						note({ event: "refused_200", ...described, answered: 502 });
						reject(res, 502);
						reply.destroy();
						return;
					}
					stages.push(decode());
				}
				const filter = claudeToken ? scrubStream([claudeToken], type) : provider?.responseFilter?.(type, req.url, own);
				if (filter) stages.push(filter);
				if (provider?.catalogFilter && req.method === "GET") stages.push(provider.catalogFilter());
				res.writeHead(200, {
					...limitHeaders(reply.headers, secrets()),
					"content-type": type,
					"cache-control": "no-store",
				});
				pipeline([...stages, res], () => {});
			});
			up.on("error", error => {
				if (res.destroyed || res.writableEnded) return;
				if (!res.headersSent)
					note({ event: "unreachable", route, error: diagnostic(error?.code, networkErrors), answered: 502 });
				if (res.headersSent) res.destroy();
				else reject(res, 502);
			});
			up.setTimeout?.(600_000, () => up.destroy());
			res.on("close", () => up.destroy());
			req.on("error", () => up.destroy());
			req.pipe(up);
		} catch (error) {
			if (res.headersSent) res.destroy();
			else if (!(error instanceof Stopping)) reject(res, 502);
			else if (signedOut()) reject(res, 401);
			else reject(res, 503, { restarting: true });
		}
	});
	// Consume exactly one identity before the HTTP parser sees this connection. The
	// remainder may already contain HTTP bytes or may arrive in subsequent packets.
	const ingress = net.createServer(socket => {
		socket.setTimeout(5000, () => socket.destroy());
		socket.on("error", () => socket.destroy());
		function identify() {
			const bytes = socket.read(32);
			if (!bytes) return;
			socket.removeListener("readable", identify);
			const nonce = bytes.toString("latin1");
			if (!/^[0-9a-f]{32}$/.test(nonce)) return socket.destroy();
			// Past the session's ceiling: a fixed refusal, and the socket never reaches the HTTP server.
			if ((open.get(nonce) ?? 0) >= limits.sessionConnections) {
				const body = JSON.stringify({
					type: "error",
					error: {
						type: "api_error",
						message: `Too many connections to the model relay from this session (${limits.sessionConnections}).`,
					},
				});
				socket.on("data", () => {}).resume();
				socket.end(
					"HTTP/1.1 503 Service Unavailable\r\nretry-after: 2\r\nconnection: close\r\ncontent-type: application/json\r\n" +
						`content-length: ${Buffer.byteLength(body)}\r\n\r\n` +
						body,
				);
				return;
			}
			// Until its first request an identified socket has an idle deadline, so idle sockets cannot hold the session's connections.
			socket.setTimeout(limits.firstRequestMs);
			sessions.set(socket, nonce);
			adjustCount(open, nonce, 1);
			const closing = new Set();
			onClose.set(socket, closing);
			socket.once("close", () => {
				adjustCount(open, nonce, -1);
				for (const run of [...closing]) run();
			});
			httpServer.emit("connection", socket);
			socket.resume();
		}
		socket.on("readable", identify);
	});
	// The HTTP parser receives sockets from ingress. Give it the matching server
	// lifecycle so Node enforces native header and request deadlines and clears its timer.
	ingress.on("listening", () => httpServer.emit("listening"));
	ingress.on("close", () => httpServer.close());
	ingress.maxConnections = 256;
	/** Stops every request of a nonce at once: its lease has ended. Its next requests are refused by the provider. */
	ingress.endSession = nonce => {
		const mine = active.get(nonce);
		active.delete(nonce);
		for (const stop of mine ?? []) stop();
		return mine?.size ?? 0;
	};
	/** The nonces with a request running now. */
	ingress.activeSessions = () => [...active.keys()];
	provider?.watch?.(ingress);
	return ingress;
};

// Persist any in-flight token rotation before the runner removes the relay.
exports.stopOnSignal = function stopOnSignal(server, provider) {
	process.once("SIGTERM", async () => {
		server.close();
		try {
			await provider.drain?.();
		} finally {
			process.exit(0);
		}
	});
	return server;
};

if (process.env.WLP_HARNESS_KEYS) {
	const harness = process.env.WLP_HARNESS_KEYS;
	const socket = "/workspace/keys.sock";
	rmSync(socket, { force: true });
	exports
		.createRelay({
			harness,
			machine: process.env["WLP_" + harness.toUpperCase() + "_RELAY_MACHINE"],
			host: harness === "codex" ? "127.0.0.1:17892" : "127.0.0.1:17894",
		})
		.listen(socket);
} else if (process.env.WLP_CLAUDE_RELAY_PUBLIC_KEY) {
	const publicKey = createPublicKey({
		key: Buffer.from(process.env.WLP_CLAUDE_RELAY_PUBLIC_KEY, "base64"),
		format: "der",
		type: "spki",
	});
	const socket = "/workspace/relay.sock";
	rmSync(socket, { force: true });
	exports
		.createRelay({ publicKey, machine: process.env.WLP_CLAUDE_RELAY_MACHINE, notesFile: exports.NOTES_FILE })
		.listen(socket);
}
