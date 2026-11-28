/**
 * The model relay without Docker or E2B (docs/model-relay.md): a machine turn's token file on a relayed
 * sandbox (token-file.ts), the platform relay route (server/src/model-relay-route.ts) with hosted Windlass on
 * the ChatGPT plan and Settings keys, its leases and limits (server/src/sandbox/relay-leases.ts), and the E2B
 * network with the relay's host.
 *
 *   cd server && npx tsx ../scripts/model-relay-route-check.ts
 *
 * Every case here fails without the relay: the token file would hold the token, the route would not be
 * there, and `restricted` would not let the sandbox reach the platform.
 */

import "./check-secret.js";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { config } from "../server/src/config.js";
import { validArgs } from "../server/src/runner/protocol.js";
import { carriesSecret } from "../server/src/runner/channel.js";
import type { ForwardedKeyLease } from "../server/src/sandbox/provider.js";
import { createRequire } from "node:module";
import { MODEL_PROVIDERS, type CredentialRef, type RelaySeen } from "../server/src/contract.js";
import { modelKeyCaller } from "../server/src/actors/internal.js";
import { modelProviderActions } from "../server/src/credentials/keys.js";
import { CREDENTIAL_TABLES, credentialActions } from "../server/src/credentials/index.js";
import { openSavedCredential, sealCredentialTransit } from "../server/src/credentials/transit.js";
import { hostedKeyEnv, windlassPlanEnv } from "../server/src/sandbox/hosted-keys.js";
import { issueServiceToken, issueUserToken } from "../server/src/tokens.js";
import { serverSealer } from "../server/src/signin/seal.js";
import { TokenFileError, openModelKeyRelay } from "../server/src/sandbox/token-file.js";
import {
	BodyBudget,
	RelayLimiter,
	UserRate,
	forwardKeyLease,
	holdsLease,
	leaseToken,
	remoteLease,
	openRelayLease,
	readPlaceholder,
	type RemoteLease,
} from "../server/src/sandbox/relay-leases.js";
import { forwardProof, proofHeader } from "../sandbox/relay/wires.cjs";
import {
	type RelayRouteDeps,
	modelRelayResponse,
	modelRelayRoute,
	upstreamFetch,
} from "../server/src/model-relay-route.js";
import { createServer } from "node:http";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { e2bModelRelay, readE2bNetwork, withPlanHosts } from "../server/src/sandbox/e2b/network.js";
import { parseModelRelayUrl } from "../server/src/model-relay-url.js";
import { dayOf, TOKEN_USAGE_TABLE, recordTurnTokens, tokensOn } from "../server/src/usage.js";
import { checkHostedTurn } from "./hosted-agent-turn.js";
import { machineLayer } from "../server/src/sandbox/runner-layer.js";
import { readE2bSettings } from "../server/src/sandbox/e2b/config.js";
import { FakeE2b } from "../server/src/sandbox/e2b/fake.js";
import { E2bSandboxHandle, E2bProvider } from "../server/src/sandbox/e2b/sandboxes.js";
import { DockerSandboxes } from "../server/src/sandbox/sandboxes.js";
import type { DockerModelRelay } from "../server/src/sandbox/model-relay.js";
import { RELAY_REFUSED, relayRefused } from "../server/src/sandbox/handoff.js";
import { keyedDigest, signedPayload } from "../server/src/signatures.js";
import { randomBytes } from "node:crypto";
import { OkReport } from "./check-report.js";
import { sleep } from "./check-wait.js";

const tally = new OkReport();
const { expect } = tally;
const REAL_A = "real-chatgpt-token-A-" + "a".repeat(48);
const REAL_B = "real-chatgpt-token-B-" + "b".repeat(48);
/** Hosted Windlass on the ChatGPT plan: its lease names the plan, and the route asks for its current token per request. */
const PLAN = { provider: "openai", generation: "plan-g1", plan: true, harness: "windlass" } as const;
let planToken: string | null = REAL_A;
const planCredential = async (user: string, ref: { provider: string; plan?: true }, nonce: string) =>
	ref.plan && ref.provider === "openai" && planToken !== null
		? sealCredentialTransit(user, { provider: "openai", plan: true }, nonce, {
				secret: planToken,
				generation: PLAN.generation,
			})
		: null;
const planLease = (uid: string, sessionId: string, origin = "https://wlp.example.com", ttlMs = 60_000) =>
	openRelayLease({ uid, sessionId, origin, ttlMs, key: PLAN });

async function relayGuest(
	uid: string,
	session: string,
	settings = readE2bSettings({
		WLP_MODEL_RELAY_URL: "https://relay.example.com",
		WLP_HOSTED_WINDLASS_VERSION: "0.7.1",
		WLP_TURN_TIMEOUT_MS: "60000",
	}),
) {
	const client = new FakeE2b();
	const owner = new E2bProvider(client, settings, { log() {} });
	const connection = await client.create({
		template: "test",
		timeoutMs: 60_000,
		metadata: {},
		envs: {},
		onTimeout: "kill",
	});
	return new E2bSandboxHandle(owner, connection, connection.sandboxId, uid, "e2b", "auto", undefined, session);
}

async function machineKeyChecks() {
	const uid = "owner",
		session = "turn",
		machine = "paired",
		generation = "first";
	const key = { provider: "openai" as const, generation, harness: "codex" as const };
	const origin = "https://relay.example.com";
	const old = config.modelRelay.url;
	config.modelRelay.url = { origin, host: "relay.example.com" };
	try {
		const cases = process.argv.find(arg => arg.startsWith("--machine-key="))?.split("=")[1];
		if (cases) assert.ok(["all", "scope", "unpair", "abort"].includes(cases));
		for (const name of ["scope", "unpair", "abort"]) {
			if (cases && cases !== "all" && cases !== name) continue;
			const controller = new AbortController();
			let forward!: ForwardedKeyLease,
				closes = 0;
			let ready!: () => void;
			const opening = new Promise<void>(r => {
				ready = r;
			});
			const relay = forwardKeyLease(
				uid,
				session,
				key,
				machine,
				async value => {
					forward = value;
					await opening;
					return {
						placeholder: "local",
						env: {},
						close: async () => {
							closes++;
						},
					};
				},
				controller.signal,
			);
			const nonce = readPlaceholder(forward.placeholder)!.nonce;
			if (name === "abort") {
				controller.abort();
				assert.equal(holdsLease(nonce), false, "abort while runner setup is pending");
				ready();
				await assert.rejects(relay);
				assert.equal(closes, 1);
			} else {
				ready();
				const held = await relay;
				let paired = true,
					sent = 0;
				const d = deps(
					async () => {
						sent++;
						return Response.json({ data: [] });
					},
					{
						paired: async (owner, id) => paired && owner === uid && id === machine,
						credential: async (user, ref, n) => sealCredentialTransit(user, ref, n, { secret: "fixture", generation }),
					},
				);
				const send = (path: string, method: string) =>
					modelRelayResponse(
						new Request(origin + "/model-relay" + path, {
							method,
							headers: {
								authorization: "Bearer " + forward.placeholder,
								[proofHeader]: forwardProof(forward.proofKey!, machine, method, path, Date.now()),
							},
						}),
						d,
					);
				assert.equal((await send("/v1/models", "GET")).status, 200);
				if (name === "scope") assert.equal((await send("/v1/chat/completions", "POST")).status, 403);
				else {
					// Another process owns this lease and keeps reporting it held after unpair.
					const remote = signedPayload("wlpm1", "model-relay", {
						k: "f",
						u: uid,
						s: session,
						machine,
						n: randomBytes(16).toString("hex"),
						exp: Date.now() + 60_000,
					});
					const proof = keyedDigest("model-relay", "forward-proof/" + remote, remote.split(".")[1]!).toString(
						"base64url",
					);
					const inFlight: AbortSignal[] = [];
					const running = {
						...d,
						remote: async () => ({ held: true, token: { ...key, harness: "codex" as const } }),
						fetch: async (_url: unknown, init?: RequestInit) => {
							inFlight.push(init!.signal!);
							return new Promise<Response>((_, reject) =>
								init!.signal!.addEventListener("abort", () => reject(new Error("Lease closed")), { once: true }),
							);
						},
					};
					const requests = Promise.all(
						[forward.placeholder, remote].map(bearer =>
							modelRelayResponse(
								new Request(origin + "/model-relay/v1/models", {
									headers: {
										authorization: "Bearer " + bearer,
										[proofHeader]: forwardProof(
											bearer === remote ? proof : forward.proofKey!,
											machine,
											"GET",
											"/v1/models",
											Date.now(),
										),
									},
								}),
								running,
							),
						),
					);
					for (let i = 0; i < 70 && inFlight.length < 2; i++) await sleep(100);
					assert.equal(inFlight.length, 2);
					paired = false;
					for (let i = 0; i < 70 && !inFlight.every(s => s.aborted); i++) await sleep(100);
					assert.ok(
						inFlight.every(s => s.aborted),
						"unpair ends local and remote requests within one poll",
					);
					assert.deepEqual(
						(await requests).map(r => r.status),
						[401, 401],
					);
					assert.equal((await send("/v1/models", "GET")).status, 401);
				}
				assert.equal(sent, 1);
				await held.close();
			}
			console.log("ok  machine key " + name);
		}
	} finally {
		config.modelRelay.url = old;
	}
}
if (process.argv.includes("--key-wires")) {
	for (const provider of MODEL_PROVIDERS) await keyWireCheck(provider);
	await planWireCheck();
	await chatgptPlanWireCheck();
	process.exit(0);
}
if (process.argv.includes("--plan-wire")) {
	await planWireCheck();
	await chatgptPlanWireCheck();
	process.exit(0);
}
await machineKeyChecks();
if (process.argv.some(arg => arg.startsWith("--machine-key="))) process.exit(0);

// ---- the E2B route ----------------------------------------------------------------------------

interface Seen {
	url: string;
	method: string;
	authorization: string | null;
	headers: Headers;
	body: string;
	whole: boolean;
	signal: AbortSignal | null;
}
function upstream(reply: (seen: Seen) => Response | Promise<Response>, read = true) {
	const seen: Seen[] = [];
	const fetch = async (input: string | URL | Request, init?: RequestInit & { duplex?: string }) => {
		const headers = new Headers(init?.headers);
		// The body comes whole, so that fetch sends it with its length, as Windlass sends it to api.openai.com itself.
		const whole = init?.body === undefined || init.body instanceof Uint8Array;
		const body = read && init?.body ? await new Response(init.body).text() : "";
		const s = {
			url: String(input),
			method: init?.method ?? "GET",
			authorization: headers.get("authorization"),
			headers,
			body,
			whole,
			signal: init?.signal ?? null,
		};
		seen.push(s);
		if (init?.redirect !== "manual") throw new Error("redirects must not be followed");
		return reply(s);
	};
	return { seen, fetch: fetch as typeof globalThis.fetch };
}
const sse = (text: string) =>
	new Response(
		`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "i", output_index: 0, content_index: 0, delta: text })}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
const call = (placeholder: string, path = "/model-relay/v1/responses", init: RequestInit = {}) =>
	new Request(`https://wlp.example.com${path}`, {
		method: path.endsWith("/models") ? "GET" : "POST",
		body: path.endsWith("/models") ? undefined : "{}",
		...init,
		headers: {
			authorization: `Bearer ${placeholder}`,
			"content-type": "application/json",
			accept: "text/event-stream",
			"session-id": "s1",
			cookie: "c=1",
			...(init.headers as object),
		},
	});
function deps(fetch: typeof globalThis.fetch, extra: Partial<RelayRouteDeps> = {}): RelayRouteDeps {
	return {
		paired: async () => true,
		credential: planCredential,
		remote: async () => null,
		fetch,
		limiter: new RelayLimiter(),
		rate: new UserRate(),
		bodies: new BodyBudget(),
		now: () => Date.now(),
		...extra,
	};
}
/** A placeholder of a lease another server process of the deployment opened: signed as theirs are, unknown to this process. */
function foreignPlaceholder(uid: string, sessionId: string, ttlMs = 60_000): string {
	return signedPayload("wlpm1", "model-relay", {
		k: "h",
		u: uid,
		s: sessionId,
		n: randomBytes(16).toString("hex"),
		exp: Date.now() + ttlMs,
	});
}
/** What the session actor of another server process answers for a live plan lease: its reference, no secret. */
const heldPlan: RemoteLease = { held: true, token: PLAN };
/** Reads on until the stream ends or fails; "still running" when it does neither within `ms`. */
async function untilEnd(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	ms: number,
): Promise<"ended" | "aborted" | "still running"> {
	const deadline = Date.now() + ms;
	for (;;) {
		const left = deadline - Date.now();
		if (left <= 0) return "still running";
		const next = await Promise.race([
			reader.read().then(
				r => (r.done ? ("ended" as const) : ("more" as const)),
				() => "aborted" as const,
			),
			sleep(left).then(() => "still running" as const),
		]);
		if (next !== "more") return next;
	}
}
const code = async (res: Response) =>
	(
		(await res
			.clone()
			.json()
			.catch(() => ({}))) as { error?: { code?: string | null } }
	).error?.code ?? null;

{
	const up = upstream(s =>
		s.url.endsWith("/models")
			? Response.json({ models: [{ slug: "m" }], echo: s.authorization })
			: sse(`echo ${s.authorization}`),
	);
	const lease = planLease("u1", "sess-1", "https://wlp.example.com", 60 * 60_000);
	const env = windlassPlanEnv(lease, "/dev/shm/access-token-abcdefabcdef.json");
	expect(
		"hosted Windlass on the ChatGPT plan gets the route's chatgpt-plan base and exact origin, its ChatGPT provider and a token file",
		env.WINDLASS_MODEL_BASE_URL === "https://wlp.example.com/model-relay/v1" &&
			env.WINDLASS_MODEL_ALLOWED_ORIGIN === "https://wlp.example.com" &&
			env.WINDLASS_PROVIDER === "chatgpt" &&
			env.WINDLASS_ACCESS_TOKEN_FILE === "/dev/shm/access-token-abcdefabcdef.json" &&
			!JSON.stringify(env).includes(lease.placeholder),
		JSON.stringify(env),
	);
	expect(
		"the placeholder is no token and names no secret",
		!lease.placeholder.includes(REAL_A) && readPlaceholder(lease.placeholder)?.uid === "u1",
	);
	planToken = null;
	const early = await modelRelayResponse(call(lease.placeholder), deps(up.fetch));
	expect(
		"while the plan gives no token the lease is refused, with the relay's own code",
		early.status === 401 && up.seen.length === 0 && (await code(early)) === "relay_lease_ended",
	);
	planToken = REAL_A;
	const { nonce } = readPlaceholder(lease.placeholder)!;
	const envelope = await remoteLease(nonce, "u1", "sess-1");
	expect(
		"the session actor answers the lease's plan reference, never a token",
		JSON.stringify(envelope.token) === JSON.stringify(PLAN) && !JSON.stringify(envelope).includes(REAL_A),
	);
	const streamed = await modelRelayResponse(call(lease.placeholder), deps(up.fetch));
	const text = await streamed.text();
	expect(
		"a Responses call reaches api.openai.com with the turn's token in place of the placeholder",
		streamed.status === 200 &&
			up.seen[0]?.url === "https://api.openai.com/v1/responses" &&
			up.seen[0].authorization === `Bearer ${REAL_A}` &&
			up.seen[0].method === "POST",
		JSON.stringify(up.seen[0]?.url),
	);
	expect(
		"only Windlass's own headers are passed on",
		up.seen[0].headers.get("cookie") === null && up.seen[0].headers.get("session-id") === "s1",
	);
	expect(
		"the request body goes upstream whole, with its length, not as a chunked stream",
		up.seen[0].whole && up.seen[0].body === "{}" && (up.seen.at(-1)?.whole ?? false),
	);
	expect(
		"the token is taken out of the streamed answer",
		!text.includes(REAL_A) && text.includes("echo Bearer [redacted]"),
		text,
	);
	const models = await modelRelayResponse(call(lease.placeholder, "/model-relay/v1/models"), deps(up.fetch));
	expect(
		"the model list goes too, scrubbed",
		models.status === 200 &&
			up.seen[1]?.url === "https://api.openai.com/v1/models" &&
			!(await models.text()).includes(REAL_A),
	);
	for (const [path, method] of [
		["/model-relay/v1/responses", "GET"],
		["/model-relay/v1/models", "POST"],
		["/model-relay/v1/chat/completions", "POST"],
		["/model-relay/v1/models?x=1", "GET"],
	] as const) {
		const res = await modelRelayResponse(
			call(lease.placeholder, path, { method, body: method === "POST" ? "{}" : undefined }),
			deps(up.fetch),
		);
		expect(`${method} ${path} is refused`, res.status === 403, String(res.status));
	}
	// Refresh: the holder refreshed the plan's sign-in while the turn runs; the next request carries the new token.
	planToken = REAL_B;
	await (await modelRelayResponse(call(lease.placeholder), deps(up.fetch))).text();
	expect(
		"the plan's token refreshed while the turn runs is the one the next request carries, on the same lease",
		up.seen.at(-1)?.authorization === `Bearer ${REAL_B}`,
	);
	planToken = REAL_A;

	// Forged, foreign, expired and ended.
	const [v, kid, data, mac] = lease.placeholder.split(".");
	const forged = [
		v,
		kid,
		Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(data, "base64url").toString()), u: "u2" })).toString(
			"base64url",
		),
		mac,
	].join(".");
	const count = up.seen.length;
	expect(
		"a placeholder whose payload was changed is refused",
		(await modelRelayResponse(call(forged), deps(up.fetch))).status === 401,
	);
	expect(
		"the real token is no bearer at the route",
		(await modelRelayResponse(call(REAL_B), deps(up.fetch))).status === 401,
	);
	expect(
		"a placeholder past its signature's time is refused",
		(await modelRelayResponse(call(lease.placeholder), deps(up.fetch, { now: () => Date.now() + 2 * 3_600_000 })))
			.status === 401,
	);
	await lease.close();
	const over = await modelRelayResponse(call(lease.placeholder), deps(up.fetch));
	expect(
		"once the turn has ended its placeholder is refused, signature or not, as the relay's own refusal",
		over.status === 401 &&
			(await code(over)) === "relay_lease_ended" &&
			(await leaseToken(readPlaceholder(lease.placeholder)!.nonce, "u1", "sess-1")) === null &&
			up.seen.length === count,
	);
}
{
	// A lease of another server process that has ended is asked about once: the answer is kept until its placeholder expires.
	const up = upstream(() => sse("ok"));
	const local = planLease("u4", "sess-4", "https://relay.example.com");
	await local.close();
	let asked = 0;
	const d = deps(up.fetch, {
		remote: async (): Promise<RemoteLease | null> => {
			asked += 1;
			return { held: false, token: null };
		},
	});
	for (let i = 0; i < 3; i++) await modelRelayResponse(call(local.placeholder), d);
	expect("a lease this process ended is refused without asking any actor", asked === 0 && up.seen.length === 0);
	const foreign = foreignPlaceholder("u4", "sess-5");
	const results: number[] = [];
	for (let i = 0; i < 5; i++) results.push((await modelRelayResponse(call(foreign), d)).status);
	expect(
		"an ended lease of another process costs one actor call, not one per request",
		asked === 1 && results.every(r => r === 401) && up.seen.length === 0,
		`asked ${asked}, ${results.join()}`,
	);
}
{
	// A lease another server process holds: its session's actor answers with the lease's reference.
	const up = upstream(() => sse("ok"));
	const placeholder = foreignPlaceholder("u3", "sess-3");
	const asked: string[] = [];
	let held = true;
	const remote = async (uid: string, sessionId: string, nonce: string): Promise<RemoteLease> => {
		asked.push(`${uid}/${sessionId}/${nonce.length}`);
		return held ? heldPlan : { held: false, token: null };
	};
	const d = deps(up.fetch, { remote });
	const first = await modelRelayResponse(call(placeholder), d);
	await first.text();
	expect(
		"a lease of another server process is asked of its session's actor",
		first.status === 200 && asked[0] === "u3/sess-3/32" && up.seen[0]?.authorization === `Bearer ${REAL_A}`,
		asked.join(),
	);
	held = false;
	const ended = await modelRelayResponse(call(placeholder), { ...d, now: () => Date.now() + 10_000 });
	expect("when that actor says the turn has ended, the placeholder is refused", ended.status === 401);
}
{
	// The caps: a turn past its in-flight ceiling waits, then is refused with retry-after; another turn is not held up.
	const release: (() => void)[] = [];
	const up = upstream(() => new Promise<Response>(resolve => release.push(() => resolve(sse("done")))));
	const limiter = new RelayLimiter({
		sessionRequests: 2,
		sessionWaiting: 1,
		userRequests: 3,
		totalRequests: 10,
		totalWaiting: 10,
		waitMs: 200,
	});
	const a = planLease("u1", "a");
	const b = planLease("u2", "b");
	const d = deps(up.fetch, {
		limiter,
		credential: async (user, ref, nonce) =>
			sealCredentialTransit(user, ref, nonce, { secret: user === "u2" ? REAL_B : REAL_A, generation: PLAN.generation }),
	});
	const held = [modelRelayResponse(call(a.placeholder), d), modelRelayResponse(call(a.placeholder), d)];
	while (release.length < 2) await sleep(5);
	const waiting = modelRelayResponse(call(a.placeholder), d);
	await sleep(20);
	const over = await modelRelayResponse(call(a.placeholder), d);
	expect(
		"past the turn's ceiling and its waiting room a request is refused at once with retry-after",
		over.status === 503 &&
			over.headers.get("retry-after") === "2" &&
			/waiting from this session \(1\)/.test(await over.text()),
	);
	const other = modelRelayResponse(call(b.placeholder), d);
	while (release.length < 3) await sleep(5);
	expect("another turn is not held up by this one's ceiling", up.seen.at(-1)?.authorization === `Bearer ${REAL_B}`);
	const timedOut = await waiting;
	expect(
		"a request that gets no slot within the wait is refused, naming the ceiling",
		timedOut.status === 503 && /at once from this session \(2\)/.test(await timedOut.text()),
	);
	for (const r of release.splice(0)) r();
	const done = await Promise.all([...held, other]);
	for (const r of done) await r.text();
	expect(
		"the requests in flight finish",
		done.every(r => r.status === 200),
	);
	// The slots were given back when the streams ended.
	const again = modelRelayResponse(call(a.placeholder), d);
	while (release.length < 1) await sleep(5);
	release.shift()!();
	expect("their slots were given back", (await again).status === 200);
	await a.close();
	await b.close();
}
{
	// The provider's error keeps what Windlass classifies it by, and nothing else.
	const up = upstream(
		s =>
			new Response(
				JSON.stringify({
					error: {
						code: "usage_limit_reached",
						type: "usage_limit_reached",
						message: `limit for ${s.authorization}`,
						plan_type: "plus",
					},
				}),
				{
					status: 429,
					headers: {
						"content-type": "application/json",
						"retry-after": "30",
						"openai-organization": "org-secret",
						"x-request-id": "req_1",
					},
				},
			),
	);
	const a = planLease("u1", "e");
	const res = await modelRelayResponse(call(a.placeholder), deps(up.fetch));
	const body = await res.text();
	expect(
		"a usage limit reaches Windlass as one, with its retry-after, without account headers or the token",
		res.status === 429 &&
			res.headers.get("retry-after") === "30" &&
			res.headers.get("openai-organization") === null &&
			JSON.parse(body).error.code === "usage_limit_reached" &&
			!body.includes(REAL_A) &&
			!body.includes("plan_type"),
		body,
	);
	const redirect = upstream(() => new Response(null, { status: 302, headers: { location: "https://example.com" } }));
	expect(
		"a redirect is not followed",
		(await modelRelayResponse(call(a.placeholder), deps(redirect.fetch))).status === 502 && redirect.seen.length === 1,
	);
	await a.close();
}

{
	// A request that waited for a slot while its turn ended is never sent, also not with the token it was looked up with first.
	const release: (() => void)[] = [];
	const up = upstream(() => new Promise<Response>(resolve => release.push(() => resolve(sse("done")))));
	const limiter = new RelayLimiter({
		sessionRequests: 1,
		sessionWaiting: 4,
		userRequests: 16,
		totalRequests: 10,
		totalWaiting: 10,
		waitMs: 5_000,
	});
	const a = planLease("u1", "q", "https://relay.example.com");
	const d = deps(up.fetch, { limiter });
	const first = modelRelayResponse(call(a.placeholder), d);
	while (release.length < 1) await sleep(5);
	const queued = modelRelayResponse(call(a.placeholder), d);
	await sleep(30);
	await a.close();
	release.shift()!();
	await (await first).text().catch(() => "");
	const late = await queued;
	expect(
		"a request queued while its turn ended is answered 401, and never reaches the provider",
		late.status === 401 && (await code(late)) === "relay_lease_ended" && up.seen.length === 1,
		`${late.status}, ${up.seen.length} sent`,
	);
}
{
	// The body is counted as it is read: past its limit the request fails as too large, and the bodies in flight have a ceiling.
	const up = upstream(() => sse("ok"));
	const a = planLease("u1", "big", "https://relay.example.com");
	const chunks = (n: number, size: number) =>
		new ReadableStream<Uint8Array>({
			start(c) {
				for (let i = 0; i < n; i++) c.enqueue(new Uint8Array(size).fill(97));
				c.close();
			},
		});
	const streamed = (body: ReadableStream<Uint8Array>) =>
		call(a.placeholder, "/model-relay/v1/responses", { body, duplex: "half" } as RequestInit);
	const large = await modelRelayResponse(streamed(chunks(8, 1024)), deps(up.fetch, { bodyBytes: 4096 }));
	expect(
		"a body past the limit with no content-length is cut off as it is read, refused as too large, and nothing is sent",
		large.status === 413 && up.seen.length === 0,
		String(large.status),
	);
	const declared = await modelRelayResponse(
		call(a.placeholder, "/model-relay/v1/responses", { body: "x".repeat(5000), headers: { "content-length": "5000" } }),
		deps(up.fetch, { bodyBytes: 4096 }),
	);
	expect("a body that declares more than the limit is refused before anything is sent", declared.status === 413);
	// Two bodies at once in a budget of one: the first holds its bytes until its answer has ended, the second is refused.
	const bodies = new BodyBudget(3000);
	let hold!: () => void;
	const slow = upstream(() => new Promise<Response>(resolve => (hold = () => resolve(sse("ok")))));
	const holding = modelRelayResponse(streamed(chunks(2, 1000)), deps(slow.fetch, { bodies }));
	for (let i = 0; i < 100 && bodies.inFlight === 0; i++) await sleep(5);
	const refused = await modelRelayResponse(
		streamed(chunks(2, 1000)),
		deps(
			async (input, init) => {
				await new Response(init!.body).arrayBuffer();
				return sse("ok");
			},
			{ bodies },
		),
	);
	expect(
		"past the ceiling of bodies in flight across requests a request is refused with retry-after",
		refused.status === 503 && refused.headers.get("retry-after") === "2" && bodies.inFlight === 2000,
		`${refused.status}, ${bodies.inFlight} in flight`,
	);
	hold?.();
	await (await holding).text().catch(() => "");
	for (let i = 0; i < 100 && bodies.inFlight !== 0; i++) await sleep(5);
	expect("a body's bytes are given back once its answer has ended", bodies.inFlight === 0, String(bodies.inFlight));
	await a.close();
}
{
	// Before any lookup: a user's requests per minute.
	const up = upstream(() => sse("ok"));
	let asked = 0;
	const d = deps(up.fetch, {
		rate: new UserRate({ userPerMinute: 60, userBurst: 3 }),
		remote: async () => {
			asked += 1;
			return { held: false, token: null };
		},
	});
	const statuses: number[] = [];
	for (let i = 0; i < 6; i++)
		statuses.push((await modelRelayResponse(call(foreignPlaceholder("u9", `s${i}`)), d)).status);
	expect(
		"past a user's rate the relay refuses with 503 and asks no actor",
		statuses.join() === "401,401,401,503,503,503" && asked === 3,
		`${statuses.join()} asked ${asked}`,
	);
}
{
	// The lease's end aborts its requests still running.
	let upstreamSignal: AbortSignal | null = null;
	const up = upstream(seen => {
		upstreamSignal = seen.signal;
		let push!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				push = c;
				c.enqueue(new TextEncoder().encode("event: response.created\ndata: {}\n\n"));
			},
		});
		seen.signal?.addEventListener("abort", () => push.error(new Error("aborted")));
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	});
	const a = planLease("u1", "abort", "https://relay.example.com");
	const res = await modelRelayResponse(call(a.placeholder), deps(up.fetch));
	const reader = res.body!.getReader();
	await reader.read();
	await a.close();
	const outcome = await untilEnd(reader, 2000);
	expect(
		"closing a lease aborts its request still streaming, upstream and to the sandbox",
		(upstreamSignal as AbortSignal | null)?.aborted === true && (outcome === "aborted" || outcome === "ended"),
		outcome,
	);
}
{
	// Requests of a lease another process holds: aborted once that process says the turn has ended.
	let held = true;
	const up = upstream(
		seen =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(c) {
						c.enqueue(new TextEncoder().encode("event: response.created\ndata: {}\n\n"));
						seen.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
	);
	const placeholder = foreignPlaceholder("u7", "far");
	const d = deps(up.fetch, {
		remote: async (): Promise<RemoteLease> => (held ? heldPlan : { held: false, token: null }),
	});
	const res = await modelRelayResponse(call(placeholder), d);
	const reader = res.body!.getReader();
	await reader.read();
	held = false;
	const outcome = await untilEnd(reader, 12_000);
	expect(
		"a request of another process's lease is aborted within seconds of that lease ending",
		outcome === "aborted" || outcome === "ended",
		outcome,
	);
}
{
	// The relay's own hostname answers its two routes and nothing else; no other host serves them.
	const at = (host: string, path: string) => new Request(`https://${host}${path}`, { headers: { host } });
	const on = (host: string, path: string) =>
		modelRelayRoute(at(host, path), path, "relay.example.com", deps(upstream(() => sse("ok")).fetch));
	const statusOf = async (r: Response | Promise<Response> | null) => (r === null ? null : (await r).status);
	expect(
		"on the relay's host its route is served (and checks the bearer)",
		(await statusOf(on("relay.example.com", "/model-relay/v1/models"))) === 401,
	);
	expect(
		"on the relay's host every other path is refused",
		(await statusOf(on("relay.example.com", "/"))) === 404 &&
			(await statusOf(on("relay.example.com", "/platform/info"))) === 404 &&
			(await statusOf(on("relay.example.com", "/runner/connection"))) === 404,
	);
	expect(
		"on the platform's host the relay's paths are not served, and its own are left to the server",
		(await statusOf(on("wlp.example.com", "/model-relay/v1/models"))) === 404 &&
			on("wlp.example.com", "/platform/info") === null,
	);
	expect(
		"the Host header's port 443 is the same host, another port is not",
		(await statusOf(on("relay.example.com:443", "/x"))) === 404 &&
			(await statusOf(on("relay.example.com:8443", "/model-relay/v1/models"))) === 404,
	);
	expect(
		"without WLP_MODEL_RELAY_URL there is no relay route on any host",
		(await statusOf(
			modelRelayRoute(at("relay.example.com", "/model-relay/v1/models"), "/model-relay/v1/models", null),
		)) === 404,
	);
	for (const url of [
		"http://relay.example.com",
		"https://relay.example.com:8443",
		"https://localhost",
		"https://10.0.0.1",
		"https://relay.example.com/v1",
		"not a url",
	])
		expect(
			`WLP_MODEL_RELAY_URL=${url} is refused`,
			(() => {
				const r = parseModelRelayUrl(url);
				return r !== null && "problem" in r;
			})(),
		);
	expect(
		"an https address with a DNS name is the relay's",
		JSON.stringify(parseModelRelayUrl("https://Relay.Example.com/")) ===
			JSON.stringify({ origin: "https://relay.example.com", host: "relay.example.com" }),
	);
}
{
	// The relay's refusals reach the user as "send the prompt again", never as "sign in again".
	const windlassSays =
		"The access token handed in through WINDLASS_ACCESS_TOKEN_FILE was rejected (The session placeholder is no longer valid: its turn has ended., relay_lease_ended). Hand in a new token.";
	expect(
		"a refusal of the relay's own is token_unavailable",
		relayRefused("handed_in_rejected", windlassSays) &&
			RELAY_REFUSED.reason === "token_unavailable" &&
			!/sign in/i.test(RELAY_REFUSED.message),
	);
	expect(
		"the provider rejecting the real token through the relay is not",
		!relayRefused("handed_in_rejected", "The access token ... was rejected (Invalid token, invalid_api_key).") &&
			!relayRefused("network_error", windlassSays),
	);
}
{
	// An E2B sandbox with an empty wlp_session refuses the route's lease, and its turn gets nothing.
	const handle = await relayGuest("u1", "");
	const error = await openModelKeyRelay(handle, "", { provider: "openai", generation: "g", harness: "codex" }).then(
		() => null,
		(e: unknown) => e,
	);
	expect(
		"an E2B sandbox with an empty wlp_session fails a key turn before any lease is opened",
		error instanceof Error && /names no session/.test(String(error)),
		String(error),
	);
}
{
	// Hosted Docker: the relay only with the image's Windlass 0.6.0 or later.
	const relay = { relayName: "wlp-model-relay", sweep: async () => 0 } as unknown as DockerModelRelay;
	for (const [version, on] of [
		["0.7.1", true],
		["0.7.1+abc", true],
		["0.7.0", true],
		["0.6.0", true],
		["0.5.9", false],
		[null, false],
	] as const) {
		const sandboxes = new DockerSandboxes({
			machine: null,
			modelRelay: relay,
			modelRelayWindlass: async () => version,
			dataVolume: async () => "v",
			dropDataVolume: async () => {},
		} as never);
		const ready = await sandboxes.modelRelayReady();
		const line = await sandboxes.prepareModelRelay();
		const hardened = sandboxes.profiles().find(p => p.id === "docker-hardened")!;
		expect(
			`hosted Docker with Windlass ${version}: the relay is ${on ? "on" : "off"}, and the profile says so`,
			ready === on && (hardened.modelRelay === true) === on && /off/.test(line) === !on,
			line,
		);
	}
}

{
	// The request to api.openai.com is what Windlass sends there itself: its headers and no others, the body with its length.
	const got: { headers: Record<string, string | string[] | undefined>; names: string[]; body: string; url: string }[] =
		[];
	const recorder = createServer((req, res) => {
		let body = "";
		req.on("data", c => (body += c));
		req.on("end", () => {
			got.push({
				headers: req.headers,
				names: req.rawHeaders.filter((_, i) => i % 2 === 0).map(n => n.toLowerCase()),
				body,
				url: req.url ?? "",
			});
			const event =
				'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"i","output_index":0,"content_index":0,"delta":"relay ok"}\n\n';
			if (req.url === "/v1/gzip") {
				res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
				return res.end(gzipSync(event));
			}
			if (req.url === "/v1/br") {
				res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "content-encoding": "br" });
				return res.end(brotliCompressSync(event));
			}
			if (req.url === "/v1/moved") {
				res.writeHead(307, { location: "https://example.com/" });
				return res.end();
			}
			if (req.url === "/v1/untyped") {
				res.writeHead(200);
				return res.end(event);
			}
			if (req.url === "/v1/page") {
				res.writeHead(200, { "content-type": "text/html", "x-request-id": "req_page" });
				return res.end("<html>hi</html>");
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(event);
		});
	});
	await new Promise<void>(r => recorder.listen(0, "127.0.0.1", () => r()));
	const base = `http://127.0.0.1:${(recorder.address() as { port: number }).port}`;
	const windlass = {
		"content-type": "application/json",
		accept: "text/event-stream",
		"session-id": "s1",
		"user-agent": "Windlass/0.7.1",
		authorization: "Bearer x",
		"accept-encoding": "gzip, deflate, br",
	};
	const plain = await upstreamFetch(`${base}/v1/responses`, {
		method: "POST",
		headers: windlass,
		body: new TextEncoder().encode('{"input":"hi"}'),
	});
	await plain.text();
	const sent = got.at(-1)!;
	expect(
		"the upstream request carries Windlass's headers and its body's length, and none that fetch would add",
		plain.status === 200 &&
			sent.headers["content-length"] === "14" &&
			sent.headers["transfer-encoding"] === undefined &&
			sent.body === '{"input":"hi"}' &&
			!sent.names.includes("sec-fetch-mode") &&
			!sent.names.includes("accept-language") &&
			sent.headers["accept-encoding"] === "gzip, deflate, br",
		JSON.stringify(sent.headers),
	);
	for (const kind of ["gzip", "br"]) {
		const res = await upstreamFetch(`${base}/v1/${kind}`, {
			method: "POST",
			headers: windlass,
			body: new Uint8Array(),
		});
		expect(
			`a ${kind} answer is decoded, and no longer names its encoding`,
			(await res.text()).includes("relay ok") && res.headers.get("content-encoding") === null,
		);
	}
	const moved = await upstreamFetch(`${base}/v1/moved`, { method: "GET", headers: {} });
	expect("a redirect is not followed", moved.status === 307 && got.at(-1)!.url === "/v1/moved");

	// Through the route: the client's accept-encoding goes on, a 200 with no type is passed on as the stream it is, a page is not.
	const a = planLease("u1", "wire", "https://relay.example.com");
	const via = (path: string) =>
		deps(((_input: string, init: RequestInit) =>
			upstreamFetch(`${base}/v1/${path}`, init)) as unknown as typeof globalThis.fetch);
	const asked = call(a.placeholder, "/model-relay/v1/responses", {
		headers: { "accept-encoding": "gzip, deflate, br, zstd" },
	});
	const through = await modelRelayResponse(asked, via("br"));
	const throughText = await through.text();
	expect(
		"through the route, Windlass's accept-encoding reaches the provider, and its compressed answer comes back decoded",
		through.status === 200 &&
			throughText.includes("relay ok") &&
			String(got.at(-1)!.headers["accept-encoding"]).startsWith("gzip, deflate, br") &&
			got.at(-1)!.headers.authorization === `Bearer ${REAL_A}`,
		`${through.status} ${got.at(-1)!.headers["accept-encoding"]}`,
	);
	const untyped = await modelRelayResponse(call(a.placeholder), via("untyped"));
	expect(
		"a 200 with no content type is passed on as an event stream",
		untyped.status === 200 &&
			untyped.headers.get("content-type") === "text/event-stream" &&
			(await untyped.text()).includes("relay ok"),
	);
	const page = await modelRelayResponse(call(a.placeholder), via("page"));
	expect(
		"a 200 that is a page, not a model's answer, is a 502 that says so",
		page.status === 502 && /not a model's answer/.test(await page.text()),
	);
	await a.close();
	recorder.close();
}

// ---- Settings-key wires, including the machine's forwarding hop --------------------------------

{
	const key = { provider: "openai", generation: "first", harness: "windlass" } as const;
	for (const modelRelay of [true, undefined]) {
		const calls: string[] = [];
		const link = {
			who: { uid: "u", machineId: "m", sessionId: "s" },
			again: async () => ({ cwd: "/workspace", profile: "docker-hardened", modelRelay }),
			request: async (op: string) => {
				calls.push(op);
				return {};
			},
		};
		const machine = machineLayer(link as never, {} as never);
		const handle = (await machine.sandboxes.connect("box")) as import("../server/src/sandbox/provider.js").TurnSandbox;
		// Every supported runner has the plan relay; Settings keys need the connect's `modelRelay` (its Windlass reads the relay).
		assert.equal(typeof handle.localPlanRelay, "function");
		assert.equal(!!handle.modelKeyRelay, !!modelRelay && config.modelRelay.on);
		assert.deepEqual(calls, []);
	}
	console.log(
		"PASS  a machine's sandbox always has the plan relay, and Settings keys where its connect says modelRelay",
	);
	for (const version of ["0.6.0", "0.7.0"]) {
		const sandbox = {
			ask: async () => ({ code: 0, stdout: "Windlass " + version }),
			modelKeyRelay: () => assert.fail("opened a lease"),
		};
		await assert.rejects(openModelKeyRelay(sandbox as never, "s", key), /Windlass needs 0.7.1 to use Settings keys/);
	}
	const sandbox = { id: "without-relay", uid: "u1", writeSecretFile: () => assert.fail("unexpected credential file") };
	await assert.rejects(
		openModelKeyRelay(sandbox as never, "s", { provider: "openai", generation: "g", harness: "codex" }),
		TokenFileError,
	);
	// A plan's transit blob past its minute is never forwarded.
	const expired = await modelRelayResponse(
		call(foreignPlaceholder("u1", "expired-transit")),
		deps(async () => assert.fail("expired token forwarded"), {
			remote: async () => heldPlan,
			credential: async (user, ref, nonce) => {
				const realNow = Date.now;
				Date.now = () => realNow() - 120_000;
				try {
					return sealCredentialTransit(user, ref, nonce, { secret: REAL_A, generation: PLAN.generation });
				} finally {
					Date.now = realNow;
				}
			},
		}),
	);
	assert.equal(expired.status, 503);
}
{
	const input = { uid: "sweep", sessionId: "expired", origin: "https://relay.example.com", key: PLAN };
	const expired = openRelayLease({ ...input, ttlMs: -1 });
	const nonce = readPlaceholder(expired.placeholder, 0)!.nonce;
	assert.ok(holdsLease(nonce));
	const next = openRelayLease({ ...input, ttlMs: 60_000 });
	assert.ok(!holdsLease(nonce));
	await next.close();
}
for (const provider of MODEL_PROVIDERS) await keyWireCheck(provider);
await planWireCheck();
await chatgptPlanWireCheck();
async function keyWireCheck(provider: (typeof MODEL_PROVIDERS)[number]) {
	const hosts = {
		openai: "api.openai.com",
		anthropic: "api.anthropic.com",
		google: "generativelanguage.googleapis.com",
		openrouter: "openrouter.ai",
	};
	const paths = {
		openai: ["/v1/models", "/v1/responses", "/v1/chat/completions"],
		anthropic: ["/v1/models", "/v1/messages"],
		google: [
			"/v1beta/models",
			"/v1beta/models/gemini-test:generateContent",
			"/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
		],
		openrouter: ["/api/v1/models", "/api/v1/chat/completions"],
	};
	const { harnessKeyProvider } = createRequire(import.meta.url)("../sandbox/relay/harness-key.cjs");
	const { windlassProvider } = createRequire(import.meta.url)("../sandbox/relay/windlass.cjs");
	const uid = "relay-wire",
		sessionId = "session";
	const key = randomBytes(24).toString("hex");
	const halves = [key.slice(0, 24), key.slice(24)];
	const generation = randomBytes(16).toString("hex");
	const keyLease = { provider, generation, harness: "opencode" as const };
	const origin = "https://relay.example.com";
	const e2b = await relayGuest(uid, sessionId);
	const lease = await openModelKeyRelay(e2b, sessionId, keyLease);
	assert.ok(!("hand" in lease));
	const auth = provider === "anthropic" ? "x-api-key" : provider === "google" ? "x-goog-api-key" : "authorization";
	const credential = (value: string) => (auth === "authorization" ? "Bearer " + value : value);
	const sql = new DatabaseSync(":memory:");
	for (const statement of CREDENTIAL_TABLES) sql.exec(statement);
	sql
		.prepare(
			"INSERT INTO model_provider(provider, sealed, generation, last4, added_at, check_ok) VALUES (?, ?, ?, ?, ?, 1)",
		)
		.run(
			provider,
			serverSealer().seal("model-key", JSON.stringify([uid, provider]), key),
			generation,
			key.slice(-4),
			Date.now(),
		);
	const internal = {
		key: [uid],
		client: () => {
			throw new Error("no actor client in this check");
		},
		vars: { tokenGen: 0 },
		conn: { params: { token: issueServiceToken(modelKeyCaller(uid)) } },
		db: {
			async execute<Row>(query: string, ...args: unknown[]) {
				return sql.prepare(query).all(...(args as SQLInputValue[])) as Row[];
			},
		},
	};
	sql.exec(TOKEN_USAGE_TABLE);
	const receipt = { seq: 1, at: Date.now(), tokens: 20, key: keyLease };
	assert.ok(await recordTurnTokens(internal.db, sessionId, receipt));
	assert.equal(await recordTurnTokens(internal.db, sessionId, receipt), false);
	assert.equal(await tokensOn(internal.db, receipt.at), 0);
	assert.equal(
		sql.prepare("SELECT tokens FROM model_key_usage WHERE day=? AND provider=?").get(dayOf(receipt.at), provider)
			?.tokens,
		20,
	);
	assert.equal(await credentialActions.internalCredentialGeneration(internal, { provider }), generation);
	await assert.rejects(
		credentialActions.internalCredentialGeneration(
			{ ...internal, conn: { params: { token: issueServiceToken() } } },
			{
				provider,
			},
		),
	);
	let mode: "ok" | "error" | "redirect" = "ok";
	let sent = 0;
	const seen: string[] = [];
	const logs: unknown[][] = [];
	const warn = console.warn;
	const recorder = createServer(async (req, res) => {
		sent++;
		const path = req.url!;
		assert.equal(req.headers[auth] === credential(key), true, "upstream auth must use saved key");
		assert.equal(["authorization", "x-api-key", "x-goog-api-key"].filter(name => req.headers[name]).length, 1);
		assert.equal(req.headers["x-unknown"], undefined);
		assert.equal(req.headers["x-goog-api-client"], undefined);
		assert.equal(req.headers[proofHeader], undefined);
		assert.equal(req.method, path.split("?")[0]!.endsWith("/models") ? "GET" : "POST");
		seen.push(path);
		res.setHeader("x-request-id", key);
		if (mode === "redirect") return res.writeHead(307, { location: "/redirected" }).end();
		if (mode === "error")
			return res
				.writeHead(429, { "retry-after": key })
				.end(JSON.stringify({ error: { code: key, type: key, param: key, message: key } }));
		if (provider === "anthropic") {
			assert.equal(req.headers["anthropic-version"], "2023-06-01");
			if (req.method === "POST") {
				assert.ok(req.headers["anthropic-beta"]?.includes("interleaved-thinking-2025-05-14"));
				assert.ok(!req.headers["anthropic-beta"]?.includes("unknown-beta-2099-01-01"));
				let body = "";
				for await (const chunk of req) body += chunk;
				if (
					body &&
					JSON.parse(body).thinking?.display === "updates" &&
					!req.headers["anthropic-beta"]?.includes("thinking-display-updates-2026-08-18")
				)
					return res.writeHead(400).end();
			}
		}
		if (req.method === "GET" || path.endsWith(":generateContent")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.write('{"echo":"' + halves[0]);
			setImmediate(() => res.end(halves[1] + '"}'));
			return;
		}
		const delta = (text: string) =>
			path.endsWith("/responses")
				? { type: "response.output_text.delta", delta: text }
				: provider === "anthropic"
					? { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }
					: provider === "google"
						? { candidates: [{ content: { parts: [{ text }] } }] }
						: { choices: [{ index: 0, delta: { content: text } }] };
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write("data: " + JSON.stringify(delta(halves[0]!)) + "\n\n");
		setImmediate(() => res.end("data: " + JSON.stringify(delta(halves[1]!)) + "\n\n"));
	});
	await new Promise<void>(r => recorder.listen(0, "127.0.0.1", r));
	const base = "http://127.0.0.1:" + (recorder.address() as { port: number }).port;
	const d = deps(
		async (input, init) => {
			const url = new URL(String(input));
			assert.equal(url.origin, "https://" + hosts[provider]);
			return upstreamFetch(base + url.pathname + url.search, init!);
		},
		{
			credential: async (user, ref, nonce) => {
				assert.equal(user, uid);
				assert.deepEqual(ref, { provider });
				return credentialActions.internalCredential(internal, ref, nonce);
			},
		},
	);
	for (const agent of ["claude", "codex", "opencode"] as const) {
		if ((agent === "claude" && provider !== "anthropic") || (agent === "codex" && provider !== "openai")) continue;
		await checkHostedTurn(agent, keyLease, key, e2b, sessionId, request => modelRelayResponse(request, d));
	}
	if (provider === "anthropic") {
		const claude = await openModelKeyRelay(e2b, sessionId, { ...keyLease, harness: "claude" });
		const hello = (placeholder?: string, method = "HEAD", path = "/api/hello") =>
			modelRelayResponse(
				new Request(origin + "/model-relay" + path, {
					method,
					headers: placeholder ? { "x-api-key": placeholder } : {},
				}),
				d,
			);
		const before = sent;
		const reply = await hello(claude.placeholder);
		assert.equal(reply.status, 200);
		assert.equal(await reply.text(), "");
		assert.equal((await hello(lease.placeholder)).status, 403, "an OpenCode lease for the same provider");
		assert.equal((await hello()).status, 401);
		assert.equal((await hello("invalid")).status, 401);
		assert.equal((await hello(claude.placeholder, "GET")).status, 403);
		assert.equal((await hello(claude.placeholder, "HEAD", "/api/hello?beta=true")).status, 403);
		await claude.close();
		assert.equal((await hello(claude.placeholder)).status, 401);
		assert.equal(sent, before);
	}
	if (provider === "openai") {
		const controller = new AbortController();
		const old = config.modelRelay.turnRequests;
		config.modelRelay.turnRequests = 3;
		let scoped;
		try {
			scoped = await openModelKeyRelay(e2b, sessionId, { ...keyLease, harness: "codex" }, controller.signal);
		} finally {
			config.modelRelay.turnRequests = old;
		}
		// A resumed E2B segment shares the logical turn's durable budget.
		const { takeTurnRequest } = await import("../server/src/actors/agent-session.js");
		sql.exec("CREATE TABLE meta (id INTEGER PRIMARY KEY, data TEXT)");
		sql.prepare("INSERT INTO meta VALUES (1, ?)").run(
			JSON.stringify({
				run: { credential: { model: "openai/gpt-5", key: { provider, generation } }, remainingRequests: 3 },
			}),
		);
		e2b.ask = async () => ({ code: 0, stdout: "Windlass 0.7.1", stderr: "" });
		for (const expected of [[200], [200, 429]]) {
			const { data } = sql.prepare("SELECT data FROM meta WHERE id = 1").get()!;
			const meta = JSON.parse(String(data));
			const active = { controller: new AbortController() };
			const ctx = {
				vars: { turn: active, serial: Promise.resolve() },
				db: { execute: async (q: string, n: number) => sql.prepare(q).run(n) },
			};
			const consume = () => takeTurnRequest(ctx as never, meta, meta.run, active as never);
			const segment = await openModelKeyRelay(
				e2b,
				sessionId,
				{ ...meta.run.credential.key, harness: "windlass" },
				undefined,
				consume,
			);
			if (meta.run.remainingRequests === 3) {
				const nonce = readPlaceholder(segment.placeholder)!.nonce;
				assert.ok((await remoteLease(nonce, uid, sessionId, true)).token);
			}
			for (const status of expected) {
				const res = await modelRelayResponse(
					new Request(origin + "/model-relay/v1/models", {
						headers: { authorization: "Bearer " + segment.placeholder },
					}),
					d,
				);
				assert.equal(res.status, status, "resuming must not renew a turn's budget");
				await res.body?.cancel();
			}
			await segment.close();
		}
		const signed = readPlaceholder(scoped.placeholder)!;
		assert.ok(signed.expiresAt <= Date.now() + 60_000);
		const send = (path: string, method = "GET") =>
			modelRelayResponse(
				new Request(origin + "/model-relay" + path, {
					method,
					headers: { authorization: "Bearer " + scoped.placeholder },
				}),
				d,
			);
		assert.equal((await send("/v1/chat/completions", "POST")).status, 403);
		assert.equal((await send("/v1/models?client_version=0.171.0")).status, 200);
		assert.equal(seen.at(-1), "/v1/models");
		assert.ok((await remoteLease(signed.nonce, uid, sessionId, true)).token);
		assert.equal((await send("/v1/models")).status, 429);
		controller.abort();
		assert.equal((await send("/v1/models")).status, 401);
		await assert.rejects(openModelKeyRelay(e2b, sessionId, keyLease, controller.signal));
	}
	const endpoint = (path: string, headers: Record<string, string> = {}) =>
		new Request(origin + "/model-relay" + path, {
			method: path.split("?")[0]!.endsWith("/models") ? "GET" : "POST",
			headers: {
				[auth]: credential(lease.placeholder),
				...(path === "/v1/messages" && { "anthropic-beta": "interleaved-thinking-2025-05-14,unknown-beta-2099-01-01" }),
				...headers,
			},
		});
	const localPlaceholder = "wlp-model." + randomBytes(16).toString("hex");
	const previousUrl = config.modelRelay.url;
	config.modelRelay.url = { origin, host: "relay.example.com" };
	let forward!: ForwardedKeyLease;
	let localClosed = false;
	const machineId = "test-machine";
	const forwarded = await forwardKeyLease(uid, sessionId, keyLease, machineId, async value => {
		forward = value;
		return {
			placeholder: localPlaceholder,
			env: {},
			close: async () => {
				localClosed = true;
			},
		};
	});
	config.modelRelay.url = previousUrl;
	assert.equal(forwarded.placeholder, localPlaceholder);
	assert.ok(!JSON.stringify(forward).includes(key));
	const args = { id: "box", forward };
	assert.ok(validArgs("modelRelay", args) && carriesSecret({ kind: "op", id: "test", name: "modelRelay", args }));
	// A Windlass lease uses the paired runner’s existing local forwarder and only this wire’s routes.
	config.modelRelay.url = { origin, host: "relay.example.com" };
	let windlassForward!: ForwardedKeyLease;
	const windlassLease = await forwardKeyLease(
		uid,
		sessionId,
		{ ...keyLease, harness: "windlass" },
		machineId,
		async value => {
			windlassForward = value;
			return { placeholder: localPlaceholder, env: {}, close: async () => {} };
		},
	);
	config.modelRelay.url = previousUrl;
	const nonce = randomBytes(16).toString("hex");
	try {
		const local = windlassProvider({
			machine: machineId,
			load: async () => ({ lease: localPlaceholder, forward: windlassForward, expiresAt: windlassForward.expiresAt }),
		});
		const send = async (path: string, method: string) => {
			const headers = {
				[auth]: credential(localPlaceholder),
				...(provider === "anthropic" && method === "POST" && { "anthropic-beta": "interleaved-thinking-2025-05-14" }),
			};
			const target = await local.target(path, headers, nonce);
			assert.ok(target && !target.refused);
			return modelRelayResponse(new Request(origin + target.path, { method, headers: target.headers }), d);
		};
		const catalog = paths[provider][0]!;
		const generationPath = paths[provider][provider === "google" ? 2 : 1]!;
		for (const [path, method] of [
			[catalog, "GET"],
			[generationPath, "POST"],
		] as const) {
			const reply = await send(path, method);
			assert.equal(reply.status, 200);
			await reply.text();
			assert.equal(seen.at(-1), path);
		}
		if (provider === "google" || provider === "anthropic") {
			const page = catalog + (provider === "google" ? "?pageToken=page%3D" : "?after_id=claude-next");
			assert.equal((await send(page, "GET")).status, 200);
			assert.equal(seen.at(-1), page);
		}
		const forbidden = {
			openai: "/v1/chat/completions",
			anthropic: "/v1/messages/count_tokens",
			google: paths.google[1]!,
			openrouter: "/v1/responses",
		}[provider];
		const before = sent;
		assert.equal(
			(
				await modelRelayResponse(
					new Request(origin + "/model-relay" + forbidden, {
						method: "POST",
						headers: {
							[auth]: credential(windlassForward.placeholder),
							[proofHeader]: forwardProof(windlassForward.proofKey!, machineId, "POST", forbidden, Date.now()),
						},
					}),
					d,
				)
			).status,
			403,
		);
		assert.equal(sent, before);
	} finally {
		await windlassLease.close();
	}
	const relayFor = (machine: string, now = Date.now) =>
		windlassProvider({
			machine,
			now,
			load: async () => ({ lease: localPlaceholder, forward, expiresAt: forward.expiresAt }),
		});
	const machine = relayFor(machineId);
	try {
		console.warn = (...args) => {
			logs.push(args);
		};
		for (const path of paths[provider]) {
			const request = endpoint(path, provider === "google" ? { "x-goog-api-client": "gl-node/test" } : {});
			const local = { ...Object.fromEntries(request.headers), [auth]: credential(localPlaceholder) };
			assert.ok(await machine.authorize(machine.bearer(local), nonce));
			const target = await machine.target(path, local, nonce);
			assert.equal(target.hostname, forward.host);
			assert.equal(target.headers[auth] === credential(forward.placeholder), true);
			assert.equal(target.path, "/model-relay" + path);
			if (provider === "google") {
				assert.equal(target.headers["x-goog-api-client"], undefined);
				assert.deepEqual(await machine.target(path, { ...local, "x-unknown": "value" }, nonce), { refused: true });
			}
			const response = await modelRelayResponse(
				new Request(origin + target.path, { method: request.method, headers: target.headers }),
				d,
			);
			const body = await response.text();
			assert.equal(response.status, 200);
			assert.ok(
				body.includes("[redacted]") && !halves.some(piece => body.includes(piece)),
				"key fragments in model response",
			);
			assert.equal(seen.at(-1), path);
			assert.equal(response.headers.get("x-request-id"), null);
		}
		const harnessRoutes = {
			anthropic: [
				["claude", "/v1/messages?beta=true"],
				["claude", "/v1/messages/count_tokens"],
				["claude", "/v1/models"],
				["opencode", "/anthropic/messages"],
			],
			openai: [
				["codex", "/codex/v1/responses"],
				["codex", "/codex/v1/models?client_version=0.171.0"],
				["opencode", "/openai/responses"],
			],
			google: [["opencode", "/google/models/gemini-test:streamGenerateContent?alt=sse"]],
			openrouter: [["opencode", "/openrouter/chat/completions"]],
		} as const;
		for (const [harness, url] of harnessRoutes[provider]) {
			const headers = {
				[auth]: credential(localPlaceholder),
				"anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14",
			};
			const adapter = harnessKeyProvider(harness, machineId, headers, undefined, async (file: string) => {
				assert.equal(file, "/run/wlp-keys/" + nonce + "." + localPlaceholder);
				return forward;
			});
			assert.ok(await adapter.authorize(adapter.bearer(), nonce));
			const target = await adapter.target(url, headers, nonce);
			assert.equal(target.hostname, forward.host);
			const response = await modelRelayResponse(
				new Request(origin + target.path, { method: adapter.methodFor(url), headers: target.headers }),
				d,
			);
			assert.equal(response.status, 200);
			assert.ok(!(await response.text()).includes(key));
			assert.equal(seen.at(-1), target.path.slice("/model-relay".length));
		}
		const models = paths[provider][0]!;
		const signed = readPlaceholder(forward.placeholder)!;
		assert.equal(signed.machine, machineId);
		assert.ok(signed.expiresAt <= Date.now() + config.turnTimeoutMs + 60_000);
		const local = { [auth]: credential(localPlaceholder) };
		const foreign = await relayFor("another-machine").target(models, local, nonce);
		const forwardedRequest = (headers: Record<string, string>) => new Request(origin + foreign.path, { headers });
		const beforeRefusals = sent;
		assert.equal((await modelRelayResponse(forwardedRequest(foreign.headers), d)).status, 401);
		assert.equal(
			(await modelRelayResponse(forwardedRequest({ [auth]: credential(forward.placeholder) }), d)).status,
			401,
		);
		const stale = await relayFor(machineId, () => Date.now() - 61_000).target(models, local, nonce);
		assert.equal((await modelRelayResponse(forwardedRequest(stale.headers), d)).status, 401);
		const valid = await machine.target(models, local, nonce);
		assert.equal(
			(await modelRelayResponse(forwardedRequest(valid.headers), { ...d, now: () => signed.expiresAt })).status,
			401,
		);
		assert.equal(sent, beforeRefusals);
		const failure = await modelRelayResponse(endpoint(models), {
			...d,
			fetch: async () => {
				throw Error(key);
			},
		});
		assert.equal(failure.status, 502);
		assert.ok(!(await failure.text()).includes(key));
		const broken = await modelRelayResponse(endpoint(models), {
			...d,
			fetch: async () =>
				new Response(
					new ReadableStream({
						start(c) {
							c.error(Error(key));
						},
					}),
					{ headers: { "content-type": "application/json" } },
				),
		});
		await assert.rejects(broken.text(), err => err instanceof Error && !err.message.includes(key));
		const before = sent;
		for (const req of [
			endpoint(models, { "x-unknown": "override" }),
			endpoint(models + "?key=bad"),
			endpoint("/v1/files"),
			endpoint(provider === "google" ? "/v1/messages" : "/v1beta/models"),
			endpoint(models, { "anthropic-beta": "unlisted" }),
		]) {
			assert.equal((await modelRelayResponse(req, d)).status, 403);
		}
		assert.equal(sent, before);
		mode = "redirect";
		assert.equal((await modelRelayResponse(endpoint(models), d)).status, 502);
		assert.equal(sent, before + 1);
		mode = "error";
		const error = await modelRelayResponse(endpoint(models), d);
		assert.equal(error.status, 429);
		assert.ok(!halves.some(piece => JSON.stringify([...error.headers]).includes(piece)));
		const text = await error.text();
		assert.ok(!halves.some(piece => text.includes(piece)));
		const expired = await modelRelayResponse(endpoint(models), {
			...d,
			credential: async (user, ref, n) =>
				serverSealer().seal(
					"transit",
					JSON.stringify(["model-key", user, ref.provider, n]),
					JSON.stringify({ key, generation, exp: Date.now() - 1 }),
				),
		});
		assert.equal(expired.status, 503);
		sql.prepare("UPDATE model_provider SET generation = ? WHERE provider = ?").run("replacement", provider);
		assert.equal((await modelRelayResponse(endpoint(models), d)).status, 401);
		const owner = { ...internal, conn: { params: { token: issueUserToken({ uid, email: null, demo: false }, 0) } } };
		await modelProviderActions.removeModelProvider(owner, provider);
		assert.equal(await credentialActions.internalCredentialGeneration(internal, { provider }), null);
		assert.equal((await modelRelayResponse(endpoint(models), d)).status, 401);
		assert.equal(sent, before + 2);
		assert.ok(!halves.some(piece => JSON.stringify(logs).includes(piece)), "key fragments in relay log");
	} finally {
		console.warn = warn;
		sql.close();
		recorder.closeAllConnections();
		recorder.close();
		await lease.close();
		await forwarded.close();
		assert.ok(localClosed);
		const signed = readPlaceholder(forward.placeholder)!;
		assert.equal(await leaseToken(signed.nonce, uid, sessionId), null);
	}
	console.log("ok    " + provider + " hosted and machine key lease, routes, redaction and revocation");
}

/** A Claude plan: Claude Code's bearer placeholder becomes the plan's token as a bearer, for Claude Code only. */
async function planWireCheck() {
	const uid = "relay-plan",
		sessionId = "session";
	const token = "sk-ant-oat01-" + randomBytes(24).toString("hex");
	let current = randomBytes(16).toString("hex");
	const ref = { provider: "anthropic" as const, generation: current, plan: true as const };
	const origin = "https://relay.example.com";
	const e2b = await relayGuest(uid, sessionId);
	e2b.ask = async () => ({ code: 0, stdout: "Windlass 0.7.1", stderr: "" });
	// The plan's health (credentials/plan-health.ts): what the provider said of each answer goes to the user's actor.
	let limited = false;
	const reset = String(Math.floor(Date.now() / 1000) + 3600);
	const up = upstream(() =>
		limited
			? Response.json(
					{ type: "error", error: { type: "rate_limit_error", message: "limited" } },
					{
						status: 429,
						headers: { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": reset },
					},
				)
			: Response.json({ type: "message" }, { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.3" } }),
	);
	const reports: Array<{ uid: string; ref: CredentialRef; seen: RelaySeen }> = [];
	const d = deps(up.fetch, {
		credential: async (user, saved, nonce) => {
			assert.equal(user, uid);
			assert.deepEqual(saved, { provider: "anthropic", plan: true });
			return sealCredentialTransit(user, saved, nonce, { secret: token, generation: current });
		},
		observe: async (user, saved, seen) => void reports.push({ uid: user, ref: saved, seen }),
	});
	const send = (placeholder: string, path: string, headers: Record<string, string> = {}, method = "POST") =>
		modelRelayResponse(
			new Request(origin + "/model-relay" + path, {
				method,
				body: method === "POST" ? "{}" : undefined,
				headers: {
					authorization: "Bearer " + placeholder,
					"anthropic-version": "2023-06-01",
					...(method === "POST" && { "content-type": "application/json" }),
					...headers,
				},
			}),
			d,
		);
	const betas = { "anthropic-beta": "oauth-2025-04-20,claude-code-20250219,unknown-beta-2099-01-01" };

	// An E2B or Daytona sandbox runs the plan's relay itself (plan-relay.ts): the token is opened for the turn and
	// handed to it, and no platform lease is made. A generation that changed meanwhile starts nothing.
	const local: string[] = [];
	e2b.localPlanRelay = async (secret: string) => {
		local.push(secret);
		return {
			placeholder: "wlp-plan." + "p".repeat(43),
			env: { WINDLASS_MODEL_BASE_URL: "http://127.0.0.1:1" },
			hand: async () => {},
			close: async () => {},
		};
	};
	const ownRelay = e2b;
	const opener = () => openSavedCredential(uid, ref, d.credential);
	const inSandbox = await openModelKeyRelay(
		ownRelay,
		sessionId,
		{ ...ref, harness: "claude" },
		undefined,
		undefined,
		opener,
	);
	assert.equal(inSandbox.env.WINDLASS_MODEL_BASE_URL, "http://127.0.0.1:1");
	assert.deepEqual(local, [token]);
	await assert.rejects(openModelKeyRelay(ownRelay, sessionId, { ...ref, harness: "claude" }), /secret opened/);
	await assert.rejects(
		openModelKeyRelay(ownRelay, sessionId, { ...ref, generation: "old", harness: "claude" }, undefined, undefined, () =>
			openSavedCredential(uid, { ...ref, generation: "old" }, d.credential),
		),
		/changed, was removed/,
	);
	assert.deepEqual(local, [token]);
	console.log("ok    claude-plan on a sandbox with its own relay: the token opened for the turn, at its generation");

	// A sandbox without one (hosted Docker forwards to this route the same way): the route's own plan lease.
	(e2b as { localPlanRelay?: unknown }).localPlanRelay = undefined;
	const claude = await openModelKeyRelay(e2b, sessionId, { ...ref, harness: "claude" });
	assert.equal(claude.env.WINDLASS_MODEL_BASE_URL, origin + "/model-relay");
	assert.deepEqual(hostedKeyEnv("claude", ref, claude), {
		ANTHROPIC_BASE_URL: origin + "/model-relay",
		CLAUDE_CODE_OAUTH_TOKEN: claude.placeholder,
	});
	for (const path of ["/v1/messages?beta=true", "/v1/messages/count_tokens"]) {
		const reply = await send(claude.placeholder, path, betas);
		assert.equal(reply.status, 200, path);
		await reply.text();
		const seen = up.seen.at(-1)!;
		assert.equal(seen.url, "https://api.anthropic.com" + path);
		assert.equal(seen.authorization, "Bearer " + token, "the plan's token as the upstream bearer");
		assert.equal(seen.headers.get("x-api-key"), null);
		assert.equal(seen.headers.get("anthropic-version"), "2023-06-01");
		assert.equal(seen.headers.get("anthropic-beta"), "oauth-2025-04-20,claude-code-20250219");
	}
	assert.equal(reports.length, 1, "successes are told at most every 15 seconds");
	assert.deepEqual(reports[0]!.ref, ref);
	assert.equal(reports[0]!.seen.status, 200);
	assert.equal(reports[0]!.seen.headers["anthropic-ratelimit-unified-5h-utilization"], "0.3");
	limited = true;
	const refused = await send(claude.placeholder, "/v1/messages?beta=true", betas);
	assert.equal(refused.status, 429);
	await refused.text();
	limited = false;
	assert.equal(reports.at(-1)!.seen.status, 429);
	assert.equal(reports.at(-1)!.seen.headers["anthropic-ratelimit-unified-reset"], reset);
	assert.equal(reports.at(-1)!.seen.code, "rate_limit_error");
	console.log("ok    claude-plan answers tell the plan's health: a success, then a limit with its reset");
	const models = await send(claude.placeholder, "/v1/models", {}, "GET");
	assert.equal(models.status, 200);
	await models.text();
	const sent = up.seen.length;
	const hello = await send(claude.placeholder, "/api/hello", {}, "HEAD");
	assert.equal(hello.status, 200, "Claude Code's HEAD /api/hello on a plan lease");
	const asKey = await modelRelayResponse(
		new Request(origin + "/model-relay/v1/messages", {
			method: "POST",
			body: "{}",
			headers: { "x-api-key": claude.placeholder, "anthropic-version": "2023-06-01" },
		}),
		d,
	);
	assert.equal(asKey.status, 403, "a plan lease takes its placeholder as a bearer only");
	assert.equal(up.seen.length, sent, "neither reaches the provider");
	console.log("ok    claude-plan bearer swapped for the plan token, betas filtered, /api/hello allowed");

	for (const harness of ["codex", "opencode", "windlass"] as const) {
		const other = await openModelKeyRelay(e2b, sessionId, { ...ref, harness });
		assert.equal((await send(other.placeholder, "/v1/messages", betas)).status, 403, harness);
		assert.equal((await send(other.placeholder, "/v1/models", {}, "GET")).status, 403, harness);
		assert.equal((await send(other.placeholder, "/api/hello", {}, "HEAD")).status, 403, harness);
		await other.close();
	}
	assert.equal(up.seen.length, sent);
	console.log("ok    claude-plan refused for codex, opencode and windlass leases");

	// Hosted Docker: the relay forwards the plan's wire to the route with the platform placeholder as a bearer.
	const localPlaceholder = "wlp-model." + randomBytes(16).toString("hex");
	const previousUrl = config.modelRelay.url;
	config.modelRelay.url = { origin, host: "relay.example.com" };
	let forward!: ForwardedKeyLease;
	const forwarded = await forwardKeyLease(uid, sessionId, { ...ref, harness: "claude" }, undefined, async value => {
		forward = value;
		return { placeholder: localPlaceholder, env: {}, close: async () => {} };
	}).finally(() => {
		config.modelRelay.url = previousUrl;
	});
	try {
		assert.equal(forward.provider, "claude-plan");
		assert.ok(!JSON.stringify(forward).includes(token));
		const { windlassProvider } = createRequire(import.meta.url)("../sandbox/relay/windlass.cjs");
		const relay = windlassProvider({
			load: async () => ({ lease: localPlaceholder, forward, expiresAt: forward.expiresAt }),
		});
		const nonce = randomBytes(16).toString("hex");
		const local = {
			authorization: "Bearer " + localPlaceholder,
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
			...betas,
		};
		assert.ok(await relay.authorize(relay.bearer(local), nonce));
		const target = await relay.target("/v1/messages?beta=true", local, nonce);
		assert.equal(target.hostname, "relay.example.com");
		assert.equal(target.path, "/model-relay/v1/messages?beta=true");
		assert.equal(target.headers.authorization, "Bearer " + forward.placeholder);
		assert.equal(target.headers["x-api-key"], undefined);
		const reply = await modelRelayResponse(
			new Request(origin + target.path, { method: "POST", body: "{}", headers: target.headers }),
			d,
		);
		assert.equal(reply.status, 200);
		await reply.text();
		assert.equal(up.seen.at(-1)!.authorization, "Bearer " + token);
		assert.equal(up.seen.at(-1)!.headers.get("anthropic-beta"), "oauth-2025-04-20,claude-code-20250219");
		assert.deepEqual(await relay.target("/v1/messages", { "x-api-key": localPlaceholder }, nonce), { refused: true });
		console.log("ok    claude-plan forwarded from the Docker relay to the route");
	} finally {
		await forwarded.close();
	}

	// Reconnecting the plan replaces its generation: the turn's lease ends.
	current = randomBytes(16).toString("hex");
	const stale = await send(claude.placeholder, "/v1/messages", betas);
	assert.equal(stale.status, 401);
	assert.equal(((await stale.json()) as { error: { code: string } }).error.code, "relay_lease_ended");
	assert.equal(up.seen.length, sent + 1);
	await claude.close();
	console.log("ok    claude-plan lease ends when the plan's generation changes");
}

/**
 * A ChatGPT plan: Codex's bearer placeholder becomes the plan's CURRENT access token, which the user actor's
 * sign-in holder answers per request (refreshing it when due), for Codex and Windlass only.
 */
async function chatgptPlanWireCheck() {
	const uid = "relay-chatgpt-plan",
		sessionId = "session";
	let access = "chatgpt-access-" + randomBytes(24).toString("hex");
	let current = randomBytes(16).toString("hex");
	const ref = { provider: "openai" as const, generation: current, plan: true as const };
	const origin = "https://relay.example.com";
	const e2b = await relayGuest(uid, sessionId);
	// Hosted Docker's way, and a sandbox without a relay of its own: the route's lease (E2B's own is e2b-provider-test's).
	(e2b as { localPlanRelay?: unknown }).localPlanRelay = undefined;
	// Its own helpers: `--plan-wire` runs it before the module's are made.
	const up = upstream(() => new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } }));
	const call = (placeholder: string, path = "/model-relay/v1/responses", init: RequestInit = {}) =>
		new Request(origin + path, {
			method: "POST",
			body: init.method === "GET" ? undefined : "{}",
			...init,
			headers: {
				authorization: `Bearer ${placeholder}`,
				"content-type": "application/json",
				accept: "text/event-stream",
				"session-id": "s1",
				cookie: "c=1",
			},
		});
	let asked = 0;
	const d = deps(up.fetch, {
		credential: async (user, saved, nonce) => {
			assert.deepEqual(saved, { provider: "openai", plan: true });
			asked += 1;
			return sealCredentialTransit(user, saved, nonce, {
				secret: access,
				generation: current,
				expiresAt: Date.now() + 30 * 60_000,
			});
		},
	});
	const codex = await openModelKeyRelay(e2b, sessionId, { ...ref, harness: "codex" });
	const env = hostedKeyEnv("codex", ref, codex);
	assert.equal(env.WLP_CODEX_BASE_URL, origin + "/model-relay/v1");
	assert.equal(env.WLP_SESSION_BEARER, codex.placeholder);
	const send = async (path: string, method = "POST") => {
		const reply = await modelRelayResponse(call(codex.placeholder, "/model-relay" + path, { method }), d);
		await reply.text();
		return reply.status;
	};
	assert.equal(await send("/v1/responses"), 200);
	assert.equal(up.seen.at(-1)!.url, "https://api.openai.com/v1/responses");
	assert.equal(up.seen.at(-1)!.authorization, "Bearer " + access, "the plan's access token as the upstream bearer");
	assert.equal(up.seen.at(-1)!.headers.get("cookie"), null);
	// The holder refreshed the sign-in: the next request carries the new access token, on the same lease.
	const before = access;
	access = "chatgpt-access-" + randomBytes(24).toString("hex");
	assert.equal(await send("/v1/responses"), 200);
	assert.equal(up.seen.at(-1)!.authorization, "Bearer " + access);
	assert.notEqual(access, before);
	assert.equal(asked, 2, "the token is asked for per request");
	console.log("ok    chatgpt-plan bearer swapped for the plan's current access token, a refreshed one used next");

	const seen = up.seen.length;
	assert.equal(await send("/v1/models?client_version=0.171.0", "GET"), 200, "Codex's own catalog request");
	assert.equal(up.seen.at(-1)!.url, "https://api.openai.com/v1/models");
	assert.equal(
		await send("/v1/models", "GET"),
		403,
		"codex-acp's bare listing is refused: it leaves the list unnarrowed",
	);
	assert.equal(await send("/v1/chat/completions"), 403);
	assert.equal(up.seen.length, seen + 1);
	for (const harness of ["claude", "opencode"] as const) {
		const other = await openModelKeyRelay(e2b, sessionId, { ...ref, harness });
		const reply = await modelRelayResponse(call(other.placeholder), d);
		assert.equal(reply.status, 403, harness);
		await other.close();
	}
	assert.equal(up.seen.length, seen + 1);
	console.log("ok    chatgpt-plan: only Codex's routes, refused for Claude Code and OpenCode leases");

	// Hosted Windlass on the same plan (hosted Docker's way): its two routes, the placeholder swapped for the current token.
	(e2b as { ask: unknown }).ask = async () => ({ code: 0, stdout: "Windlass 0.7.1\n", stderr: "" });
	const windlass = await openModelKeyRelay(e2b, sessionId, { ...ref, harness: "windlass" });
	const windlassEnv = windlassPlanEnv(windlass, "/dev/shm/access-token-x.json");
	assert.equal(windlassEnv.WINDLASS_MODEL_BASE_URL, origin + "/model-relay/v1");
	assert.equal(windlassEnv.WINDLASS_PROVIDER, "chatgpt");
	const sendWindlass = async (path: string, method = "POST") => {
		const reply = await modelRelayResponse(call(windlass.placeholder, "/model-relay" + path, { method }), d);
		await reply.text();
		return reply.status;
	};
	assert.equal(await sendWindlass("/v1/models", "GET"), 200, "Windlass's model list");
	assert.equal(up.seen.at(-1)!.url, "https://api.openai.com/v1/models");
	assert.equal(up.seen.at(-1)!.authorization, "Bearer " + access);
	access = "chatgpt-access-" + randomBytes(24).toString("hex");
	assert.equal(await sendWindlass("/v1/responses"), 200);
	assert.equal(up.seen.at(-1)!.authorization, "Bearer " + access, "a refreshed token is the next request's");
	const windlassSeen = up.seen.length;
	assert.equal(await sendWindlass("/v1/models?client_version=0.171.0", "GET"), 403, "Codex's catalog form");
	assert.equal(await sendWindlass("/v1/chat/completions"), 403);
	assert.equal(await sendWindlass("/v1/models"), 403, "a POST to the list");
	assert.equal(up.seen.length, windlassSeen);
	await windlass.close();
	const closed = await modelRelayResponse(call(windlass.placeholder), d);
	assert.equal(closed.status, 401);
	assert.equal(((await closed.json()) as { error: { code: string } }).error.code, "relay_lease_ended");
	console.log(
		"ok    chatgpt-plan for Windlass: only GET /v1/models and POST /v1/responses, current token, relay_lease_ended once closed",
	);

	// Reconnecting or removing the ChatGPT plan replaces its generation; a refresh never does.
	current = randomBytes(16).toString("hex");
	const stale = await modelRelayResponse(call(codex.placeholder), d);
	assert.equal(stale.status, 401);
	assert.equal(((await stale.json()) as { error: { code: string } }).error.code, "relay_lease_ended");
	await codex.close();
	console.log("ok    chatgpt-plan lease ends when the plan's generation changes");
}

// ---- the E2B network ----------------------------------------------------------------------------

{
	const env = (extra: Record<string, string>) =>
		({
			WLP_PUBLIC_URL: "https://wlp.example.com",
			WLP_MODEL_RELAY_URL: "https://relay.example.com",
			WLP_E2B_WINDLASS_VERSION: "0.7.1",
			WLP_E2B_NETWORK: "restricted",
			...extra,
		}) as NodeJS.ProcessEnv;
	const hosts = (extra: Record<string, string> = {}) => readE2bNetwork(env(extra)).hosts;
	expect(
		"E2B restricted allows the relay's own host, not the platform's public host, and not api.openai.com",
		hosts().includes("relay.example.com") &&
			!hosts().includes("wlp.example.com") &&
			!hosts().includes("api.openai.com"),
		hosts().join(),
	);
	expect(
		"E2B none allows the relay's host only, and no git host",
		hosts({ WLP_E2B_NETWORK: "none" }).join() === "relay.example.com",
		hosts({ WLP_E2B_NETWORK: "none" }).join(),
	);
	expect(
		"with WLP_MODEL_RELAY=off: api.openai.com, and no relay host",
		hosts({ WLP_MODEL_RELAY: "off" }).includes("api.openai.com") &&
			!hosts({ WLP_MODEL_RELAY: "off" }).includes("relay.example.com") &&
			readE2bSettings(env({ WLP_MODEL_RELAY: "off" })).modelRelayOrigin === null,
	);
	const unset = env({ WLP_MODEL_RELAY_URL: "" });
	expect(
		"without WLP_MODEL_RELAY_URL the relay is off, and the platform's whole public host is never allowed in its place",
		readE2bSettings(unset).modelRelayOrigin === null &&
			!readE2bNetwork(unset).hosts.includes("wlp.example.com") &&
			readE2bNetwork(unset).hosts.includes("api.openai.com"),
	);
	for (const version of ["0.5.9", ""]) {
		const old = env({ WLP_E2B_WINDLASS_VERSION: version });
		expect(
			`with the template's Windlass ${version || "unknown"} the relay is off for E2B, and api.openai.com stays`,
			readE2bSettings(old).modelRelayOrigin === null &&
				readE2bNetwork(old).hosts.includes("api.openai.com") &&
				"off" in e2bModelRelay(old),
		);
	}
	const restricted = readE2bNetwork(env({}));
	expect(
		"a Windlass sandbox (no agent of its own) may reach api.openai.com for its plan relay; an OpenCode sandbox may not",
		withPlanHosts(restricted, undefined).hosts.includes("api.openai.com") &&
			withPlanHosts(restricted, "").hosts.includes("api.openai.com") &&
			!withPlanHosts(restricted, "opencode").hosts.includes("api.openai.com") &&
			withPlanHosts(restricted, undefined).hosts.includes("relay.example.com"),
		withPlanHosts(restricted, undefined).hosts.join(),
	);
	const settings = readE2bSettings(env({ WLP_E2B_WINDLASS_VERSION: "0.6.0" }));
	const guest = await relayGuest("u1", "session", settings);
	const key = { provider: "openai", generation: "first" } as const;
	await assert.rejects(
		openModelKeyRelay(guest, "session", { ...key, harness: "windlass" }),
		/Hosted Windlass needs 0.7.1 to use Settings keys/,
	);
	for (const harness of ["claude", "codex", "opencode"] as const)
		await (await openModelKeyRelay(guest, "session", { ...key, harness })).close();
	expect(
		"Windlass 0.6.0 keeps the ChatGPT and ACP relay origin",
		readE2bSettings(env({ WLP_E2B_WINDLASS_VERSION: "0.6.0" })).modelRelayOrigin === "https://relay.example.com",
	);
	expect(
		"with Windlass 0.7.1 and WLP_MODEL_RELAY_URL the relay's origin is its own host",
		readE2bSettings(env({})).modelRelayOrigin === "https://relay.example.com",
	);
}

process.exit(tally.summary("\nall model relay checks passed", failed => `\n${failed} model relay check(s) failed`));
