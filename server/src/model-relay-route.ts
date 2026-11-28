/** The platform credential boundary for E2B Settings keys and forwarded Docker requests (docs/model-relay.md). */
import { createRequire } from "node:module";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable, pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import * as zlib from "node:zlib";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createClient } from "rivetkit/client";
import { openSavedCredential } from "./credentials/transit.js";
import { isModelProvider, isPlanProvider, type CredentialRef, type RelaySeen } from "./contract.js";
import { credentialWire, harnessMethod, proofHeader, type KeyWire } from "../../sandbox/relay/wires.cjs";
import { isActorGone, modelKeyActor } from "./actors/internal.js";
import { serviceParams } from "./auth.js";
import { config, ownEngineEndpoint } from "./config.js";
import { requestHost } from "./model-relay-url.js";
import type { Registry } from "./registry.js";
import {
	BodyBudget,
	RELAY_PREFIX,
	type RemoteLease,
	type Placeholder,
	verifiedMachine,
	revokeMachineLeases,
	RelayLimiter,
	ROUTE_LIMITS,
	UserRate,
	endLease,
	endedLease,
	holdsLease,
	leaseToken,
	readPlaceholder,
	trackRequest,
} from "./sandbox/relay-leases.js";
import type { KeyReference } from "./sandbox/provider.js";

const require = createRequire(import.meta.url);
const { scrubStream, limitHeaders } = require("../../sandbox/relay/server.cjs") as {
	scrubStream: (secrets: Iterable<string>, type: string, responses?: boolean) => NodeJS.ReadWriteStream;
	limitHeaders: (headers: Record<string, string>, secrets?: Iterable<string>) => Record<string, string>;
};
const { errorBody, limitFacts, LEASE_ENDED, wireTarget, anyMethod, placeholderOf } =
	require("../../sandbox/relay/windlass.cjs") as {
		errorBody: (status: number, text: string, secrets: string[]) => string;
		limitFacts: (text: string, secrets?: string[]) => { code: string | null; resetsAt: number | null };
		LEASE_ENDED: string;
		wireTarget(
			wire: KeyWire,
			path: string,
			headers: Record<string, string>,
			secret: string,
		): { hostname: string; headers: Record<string, string>; path: string } | undefined;
		anyMethod(path: string): "GET" | "POST" | undefined;
		placeholderOf(headers: Record<string, string>): string | undefined;
	};
/** Preserve Windlass's encoding preference among codecs the relay can decode. */
const DECODERS = new Map<string, () => NodeJS.ReadWriteStream>([
	["gzip", createGunzip],
	["deflate", createInflate],
	["br", createBrotliDecompress],
	...((typeof (zlib as { createZstdDecompress?: unknown }).createZstdDecompress === "function"
		? [["zstd", (zlib as unknown as { createZstdDecompress: () => NodeJS.ReadWriteStream }).createZstdDecompress]]
		: []) as [string, () => NodeJS.ReadWriteStream][]),
]);
/** How often a lease another process holds is looked at while its requests run here. */
const REMOTE_POLL_MS = 5_000;
const UPSTREAM_TIMEOUT_MS = 600_000;

function refusal(
	status: number,
	message: string,
	headers: Record<string, string> = {},
	code: string | null = null,
): Response {
	const type =
		status === 401
			? "authentication_error"
			: status === 403
				? "permission_error"
				: status === 429
					? "rate_limit_error"
					: "api_error";
	return Response.json(
		{ error: { type, code, message } },
		{ status, headers: { ...headers, "cache-control": "no-store" } },
	);
}
/** Distinguish an ended lease from an upstream authentication error. */
const leaseEnded = (message = "The session placeholder is no longer valid: its turn has ended.") =>
	refusal(401, message, {}, LEASE_ENDED);

export interface RelayRouteDeps {
	paired(uid: string, machine: string): Promise<boolean>;
	/** Returns the sealed secret behind `ref` (a Settings key or a plan), bound to this request nonce. */
	credential(uid: string, ref: Omit<CredentialRef, "generation">, request: string): Promise<string | null>;
	/** What the provider said of a plan's health (credentials/plan-health.ts); a key's answers are not told. */
	observe?(uid: string, ref: CredentialRef, seen: RelaySeen): Promise<void>;
	/** The session actor answers its lease's credential reference. */
	remote(uid: string, sessionId: string, nonce: string, consume?: boolean): Promise<RemoteLease | null>;
	fetch: typeof fetch;
	limiter: RelayLimiter;
	rate: UserRate;
	bodies: BodyBudget;
	now: () => number;
	/** The largest request body (ROUTE_LIMITS.bodyBytes). */
	bodyBytes?: number;
}

let client: ReturnType<typeof createClient<Registry>> | undefined;
const engine = () => (client ??= createClient<Registry>({ endpoint: ownEngineEndpoint() }));
const defaults: RelayRouteDeps = {
	paired: async (uid, machine) => {
		try {
			return await engine().machine.get([uid, machine], { params: serviceParams() }).internalPaired();
		} catch (error) {
			if (isActorGone(error)) return false;
			throw error;
		}
	},
	credential: (uid, ref, request) => modelKeyActor({ client: engine }, uid).internalCredential(ref, request),
	observe: async (uid, ref, seen) => {
		if (isPlanProvider(ref.provider))
			await modelKeyActor({ client: engine }, uid).internalObservePlan(ref.provider, ref.generation, seen);
	},
	remote: async (uid, sessionId, nonce, consume) => {
		try {
			return await engine()
				.agentSession.get([uid, sessionId], { params: serviceParams() })
				.internalModelRelay({ nonce, consume });
		} catch (error) {
			if (isActorGone(error)) return null;
			throw error;
		}
	},
	fetch: (input, init) => upstreamFetch(String(input), init ?? {}),
	limiter: new RelayLimiter({ ...ROUTE_LIMITS, totalRequests: config.modelRelay.requests }),
	rate: new UserRate(),
	bodies: new BodyBudget(),
	now: () => Date.now(),
};

/** Use Node HTTP to send only approved headers, avoid redirects, and decode compressed replies. */
export function upstreamFetch(url: string, init: RequestInit): Promise<Response> {
	const target = new URL(url);
	const body = init.body === undefined || init.body === null ? undefined : Buffer.from(init.body as Uint8Array);
	const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
	if (body !== undefined) headers["content-length"] = String(body.byteLength);
	return new Promise<Response>((resolve, reject) => {
		const send = target.protocol === "http:" ? httpRequest : httpsRequest;
		const req = send(target, { method: init.method ?? "GET", headers, signal: init.signal ?? undefined }, res => {
			const out = new Headers();
			for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
			const encoding = (res.headers["content-encoding"] ?? "").trim().toLowerCase();
			let stream: Readable = res;
			if (encoding !== "" && encoding !== "identity") {
				const decode = DECODERS.get(encoding);
				if (decode) {
					stream = pipeline(res, decode(), () => undefined) as unknown as Readable;
					out.delete("content-encoding");
					out.delete("content-length");
				}
			}
			const status = res.statusCode ?? 502;
			const nullBody = [101, 204, 205, 304].includes(status) || init.method === "HEAD";
			if (nullBody) res.resume();
			resolve(
				new Response(nullBody ? null : (Readable.toWeb(stream) as unknown as ReadableStream), {
					status: status < 200 || status > 599 ? 502 : status,
					headers: out,
				}),
			);
		});
		req.on("error", reject);
		req.end(body);
	});
}

/** A plan's successes are told at most this often per user and plan; every error is told. */
const SEEN_OK_MS = 15_000;
const seenOk = new Map<string, number>();

/** Tells the user's actor what the provider said of a plan's answer, without holding up the answer. */
function observePlanAnswer(
	deps: RelayRouteDeps,
	uid: string,
	token: KeyReference,
	status: number,
	headers: Record<string, string>,
	text?: string,
	secrets: string[] = [],
): void {
	if (!token.plan) return;
	const key = `${uid}/${token.provider}`;
	const now = deps.now();
	if (status >= 200 && status < 300) {
		if (now - (seenOk.get(key) ?? -Infinity) < SEEN_OK_MS) return;
		seenOk.set(key, now);
		if (seenOk.size > 10_000) seenOk.clear();
	} else seenOk.delete(key);
	const facts = text === undefined ? {} : limitFacts(text, secrets);
	const ref = { provider: token.provider, generation: token.generation, plan: true as const };
	void deps.observe?.(uid, ref, { status, headers, ...facts }).catch(() => undefined);
}

/** Revoked nonces stay invalid until their placeholders expire. */
async function tokenFor(
	deps: RelayRouteDeps,
	placeholder: Placeholder,
	machine: string | undefined,
	consume = false,
): Promise<KeyReference | "limit" | null> {
	const { uid, sessionId, nonce, expiresAt: placeholderExpires } = placeholder;
	if (machine !== placeholder.machine) return null;
	const now = deps.now();
	if (placeholderExpires <= now || endedLease(nonce, now)) return null;
	if (machine && !(await deps.paired(uid, machine))) {
		revokeMachineLeases(uid, machine);
		endLease(nonce, placeholderExpires, now);
		return null;
	}
	// This process runs the turn: what it holds is the answer, and a lease it no longer holds has ended.
	if (holdsLease(nonce)) return leaseToken(nonce, uid, sessionId, now, consume);
	const answer = await deps.remote(uid, sessionId, nonce, consume);
	if (answer === null || !answer.held) {
		// Ended: refused from now on without asking the actor again.
		endLease(nonce, placeholderExpires, now);
		return null;
	}
	if (answer.limited) return "limit";
	if (answer.token === null) return null;
	const { provider, generation, harness, plan } = answer.token;
	return isModelProvider(provider) && typeof generation === "string"
		? { provider, generation, harness, ...(plan === true && { plan }) }
		: null;
}

/** A remote owner cannot abort local requests directly. Poll its lease while requests are active. */
const watched = new Map<
	string,
	{ lookup: () => Promise<KeyReference | null>; expires: number; requests: Set<AbortController> }
>();
let watching: NodeJS.Timeout | null = null;
function watchRemote(
	nonce: string,
	expires: number,
	lookup: () => Promise<KeyReference | null>,
	controller: AbortController,
): () => void {
	let entry = watched.get(nonce);
	if (!entry) watched.set(nonce, (entry = { expires, lookup, requests: new Set() }));
	entry.requests.add(controller);
	watching ??= setInterval(() => {
		for (const [key, lease] of watched) {
			void lease.lookup().then(
				token => {
					if (token === null && (endedLease(key) || lease.expires <= Date.now()))
						for (const request of lease.requests) request.abort(new Error("the turn's model relay lease has ended"));
				},
				() => undefined,
			);
		}
	}, REMOTE_POLL_MS);
	watching.unref?.();
	const mine = entry;
	return () => {
		mine.requests.delete(controller);
		if (mine.requests.size === 0 && watched.get(nonce) === mine) watched.delete(nonce);
		if (watched.size === 0 && watching) {
			clearInterval(watching);
			watching = null;
		}
	};
}

/** The relay host serves only relay routes. Other hosts reject those paths. */
export function modelRelayRoute(
	request: Request,
	pathname: string,
	relayHost: string | null,
	deps: RelayRouteDeps = defaults,
): Promise<Response> | Response | null {
	const onRelayHost =
		relayHost !== null && requestHost(request.headers.get("host") ?? new URL(request.url).host) === relayHost;
	const relayPath = pathname.startsWith(RELAY_PREFIX + "/");
	if (onRelayHost) return relayPath ? modelRelayResponse(request, deps) : refusal(404, "Unknown model relay route.");
	if (relayPath) return refusal(404, "The model relay is not served on this host.");
	return null;
}

/** RivetKit already buffers uploads. Apply both budgets and send the body upstream with its length. */
async function readBody(
	request: Request,
	max: number,
	budget: BodyBudget,
): Promise<{ body: Uint8Array; taken: number } | { over: "large" | "busy"; taken: number }> {
	const parts: Uint8Array[] = [];
	let size = 0;
	if (request.body === null) return { body: new Uint8Array(), taken: 0 };
	const reader = request.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (size + value.byteLength > max) {
				await reader.cancel().catch(() => undefined);
				return { over: "large", taken: size };
			}
			if (!budget.take(value.byteLength)) {
				await reader.cancel().catch(() => undefined);
				return { over: "busy", taken: size };
			}
			size += value.byteLength;
			parts.push(value);
		}
	} catch (error) {
		budget.give(size);
		throw error;
	}
	return { body: Buffer.concat(parts), taken: size };
}

/** Bound log volume for unsolicited requests and report dropped entries. */
const logged = { minute: 0, lines: 0, dropped: 0 };
function relayLog(line: string): void {
	const minute = Math.floor(Date.now() / 60_000);
	if (minute !== logged.minute) Object.assign(logged, { minute, lines: 0 });
	if (logged.lines >= 60) {
		logged.dropped += 1;
		return;
	}
	logged.lines += 1;
	const dropped = logged.dropped ? ` (${logged.dropped} earlier line(s) left out)` : "";
	logged.dropped = 0;
	console.warn(`${line.replace(/\s+/g, " ").slice(0, 400)}${dropped}`);
}
/** Never log caller paths, provider headers, error bodies or exception messages. */
export async function modelRelayResponse(request: Request, deps: RelayRouteDeps = defaults): Promise<Response> {
	const began = Date.now();
	let reason = "";
	const response = await answer(request, deps, detail => {
		reason = detail;
	}).catch(() => refusal(502, "The relay could not complete the request."));
	if (response.status !== 200)
		relayLog(`[wlp] model_relay.failed status=${response.status} ms=${Date.now() - began} ${reason}`);
	return response;
}

async function errorText(reply: Response): Promise<string> {
	if (!reply.body) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of Readable.fromWeb(reply.body as WebReadableStream<Uint8Array>)) {
		size += chunk.byteLength;
		if (size > 65_536) return "";
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function answer(request: Request, deps: RelayRouteDeps, note: (reason: string) => void): Promise<Response> {
	if (!config.modelRelay.on) return refusal(404, "The model relay is off.");
	const url = new URL(request.url);
	const path = url.pathname.slice(RELAY_PREFIX.length) + url.search;
	const method = path === "/api/hello" ? "HEAD" : anyMethod(path);
	if (!url.pathname.startsWith(RELAY_PREFIX + "/") || !method || request.method !== method) {
		note(`refused ${request.method} ${url.pathname.slice(0, 80)}`);
		return refusal(403, "This request is not allowed by the relay.");
	}
	const incoming = Object.fromEntries(request.headers);
	const bearer = placeholderOf(incoming);
	const placeholder = bearer === undefined ? null : readPlaceholder(bearer, deps.now());
	if (placeholder === null) {
		note("The session placeholder is not valid.");
		return leaseEnded("The session placeholder is not valid.");
	}
	// Before any lookup: a placeholder that keeps being sent costs at most this much.
	if (!deps.rate.take(placeholder.uid, deps.now()))
		return refusal(503, `Too many model requests from your sessions (${ROUTE_LIMITS.userPerMinute} a minute).`, {
			"retry-after": "2",
		});
	const machine =
		placeholder.machine &&
		verifiedMachine(bearer!, placeholder.machine, incoming[proofHeader], method, path, deps.now());
	if (placeholder.machine) delete incoming[proofHeader];
	const lookup = async () => {
		const current = await tokenFor(deps, placeholder, machine);
		return current === "limit" ? null : current;
	};
	let token: KeyReference | null;
	try {
		const admission = await tokenFor(deps, placeholder, machine, method !== "HEAD");
		if (admission === "limit") return refusal(429, "This turn reached its model request limit.");
		token = admission;
	} catch {
		return refusal(503, "The relay could not reach the session. Try again.", { "retry-after": "1" });
	}
	if (token === null) return leaseEnded();
	// Claude Code's reachability check, for an Anthropic key or a Claude plan.
	if (method === "HEAD" && !(token.harness === "claude" && token.provider === "anthropic"))
		return refusal(403, "This request is not allowed by the relay.");
	const maxBody = deps.bodyBytes ?? ROUTE_LIMITS.bodyBytes;
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > maxBody) return refusal(413, "The request is too large for the relay.");
	const slot = await deps.limiter.acquire(placeholder.nonce, placeholder.uid, request.signal);
	if ("refused" in slot) return refusal(503, slot.refused, { "retry-after": "2" });
	// The lease's end (`close`, here or in the process that holds it) aborts the request from here on.
	const ended = new AbortController();
	const untrack = trackRequest(placeholder.nonce, ended);
	const unwatch = (!untrack || machine) && watchRemote(placeholder.nonce, placeholder.expiresAt, lookup, ended);
	let taken = 0;
	let released = false;
	const release = () => {
		if (!released) {
			released = true;
			if (untrack) untrack();
			if (unwatch) unwatch();
			deps.bodies.give(taken);
			taken = 0;
			slot.release();
		}
	};
	try {
		const signal = AbortSignal.any([request.signal, ended.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);
		// The body whole, counted as it is read, and sent with its length.
		let upstreamBody: Uint8Array | undefined;
		if (method === "POST") {
			const read = await readBody(request, maxBody, deps.bodies);
			taken = read.taken;
			if ("over" in read) {
				release();
				return read.over === "large"
					? refusal(413, "The request is too large for the relay.")
					: refusal(503, "The relay is sending too many request bodies at once. Try again.", { "retry-after": "2" });
			}
			upstreamBody = read.body;
		}
		// After reading the body and waiting for a slot, resolve the lease and the saved generation afresh.
		let secret: string | null = null;
		let wire: KeyWire | null = null;
		try {
			token = await lookup();
			if (token) {
				wire = credentialWire(token);
				if (method !== "HEAD" && harnessMethod(token.harness, wire, path) !== method) {
					note(`refused for ${token.harness ?? "windlass"}: ${method} ${url.pathname.slice(0, 80)}`);
					release();
					return refusal(403, "This request is not allowed by the relay.");
				}
				secret = (await openSavedCredential(placeholder.uid, token, deps.credential))?.secret ?? null;
			}
		} catch {
			release();
			return refusal(503, "The relay could not resolve the credential. Try again.", { "retry-after": "1" });
		}
		if (!token || !secret || !wire || ended.signal.aborted) {
			release();
			return leaseEnded();
		}
		if (method === "HEAD") {
			release();
			return new Response(null, { headers: { "cache-control": "no-store" } });
		}
		const target = wireTarget(wire, path, incoming, secret);
		if (!target) {
			release();
			return refusal(403, "This request is not allowed by the relay.");
		}
		const secrets = [secret];
		const headers = target.headers;
		const accepted = (incoming["accept-encoding"] ?? "")
			.split(",")
			.map(part => part.trim().split(";")[0]!.toLowerCase())
			.filter(name => DECODERS.has(name));
		if (accepted.length) headers["accept-encoding"] = [...new Set(accepted)].join(", ");
		let reply: Response;
		try {
			reply = await deps.fetch(`https://${target.hostname}${target.path}`, {
				method,
				headers,
				body: upstreamBody as BodyInit | undefined,
				redirect: "manual",
				signal,
			});
		} catch {
			release();
			if (ended.signal.aborted) return leaseEnded();
			return refusal(502, "The provider failed or couldn't be reached.");
		}
		const replyHeaders = Object.fromEntries(reply.headers.entries());
		if (reply.status !== 200) {
			relayLog(`[wlp] model_relay.detail provider=${wire} upstream=${reply.status}`);
			const status = reply.status >= 400 && reply.status < 600 ? reply.status : 502;
			const text = status === 502 ? "" : await errorText(reply).catch(() => "");
			if (status === 502) await reply.body?.cancel().catch(() => undefined);
			observePlanAnswer(deps, placeholder.uid, token, reply.status, limitHeaders(replyHeaders, secrets), text, secrets);
			release();
			return new Response(errorBody(status, text, secrets), {
				status,
				headers: {
					...([429, 503, 529].includes(status) ? limitHeaders(replyHeaders, secrets) : {}),
					"content-type": "application/json",
					"cache-control": "no-store",
				},
			});
		}
		observePlanAnswer(deps, placeholder.uid, token, 200, limitHeaders(replyHeaders, secrets));
		const given = (reply.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
		// Windlass reads a Responses answer as an event stream whatever its type says: one with no type, or a
		// plain-text one, is passed on as the event stream it is. Anything else (a page, a download) is not a model's answer.
		const type =
			given === "text/event-stream" || given === "application/json"
				? given
				: path === "/v1/responses" && (given === "" || given === "text/plain")
					? "text/event-stream"
					: null;
		if (
			type === null ||
			reply.body === null ||
			(reply.headers.has("content-encoding") && reply.headers.get("content-encoding") !== "identity")
		) {
			await reply.body?.cancel().catch(() => undefined);
			release();
			return refusal(502, "The provider answered with something that is not a model's answer.");
		}
		// The answer is decoded already. Every token is taken out before a byte goes back.
		const scrubbed = scrubStream(secrets, type, true);
		// One pipeline: the client going away stops the provider's stream too, and the slot is freed once either ends.
		pipeline(Readable.fromWeb(reply.body as WebReadableStream<Uint8Array>), scrubbed, release);
		(scrubbed as unknown as Readable).on("close", release);
		const stop = () => (scrubbed as unknown as Readable).destroy();
		request.signal.addEventListener("abort", stop, { once: true });
		ended.signal.addEventListener("abort", stop, { once: true });
		return new Response(Readable.toWeb(scrubbed as unknown as Readable) as unknown as ReadableStream, {
			status: 200,
			headers: { ...limitHeaders(replyHeaders, secrets), "content-type": type, "cache-control": "no-store" },
		});
	} catch (error) {
		release();
		throw error;
	}
}
