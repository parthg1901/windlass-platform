/**
 * Test connection tokens against a local HTTP stand-in and a controlled clock. WLP_CHECK_SECTIONS=issuing,route selects sections.
 * The optional cluster section needs WLP_CHECK_ENGINE and RIVET_ADMIN_TOKEN. It issues and inspects tokens, then waits for expiry.
 */

import { matchesSection } from "./check-sections.js";
import { execFile } from "node:child_process";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { sleep as wait } from "./check-wait.js";
import { Report } from "./check-report.js";

// What the `cluster` section is given, taken before the made-up values below replace it.
const realEngine = (process.env.WLP_CHECK_ENGINE ?? "").trim().replace(/\/+$/, "");
const realAdminToken = (process.env.RIVET_ADMIN_TOKEN ?? "").trim();

const ADMIN = "FAKE-ADMIN-TOKEN-not-a-real-token";
const HOUR = 60 * 60 * 1000;
/** Every secret this check handles, to look for in what it printed: the admin tokens and each token that was issued. */
const secrets = new Set<string>([ADMIN]);
if (realAdminToken !== "") secrets.add(realAdminToken);

const output: string[] = [];
for (const method of ["log", "warn", "error"] as const) {
	const real = console[method].bind(console);
	console[method] = (...parts: unknown[]) => {
		const line = parts.map(part => (typeof part === "string" ? part : String(part))).join(" ");
		output.push(line);
		real(line.startsWith("[wlp] ") ? `      ${line}` : line);
	};
}
const tally = new Report();
const { expect } = tally;

function info(text: string): void {
	console.log(`      ${text}`);
}
async function section(name: string, body: () => Promise<void>): Promise<void> {
	if (name !== "output" && !matchesSection(name)) return;
	console.log(`\n== ${name}`);
	try {
		await body();
	} catch (error) {
		expect(`${name}: unexpected error`, false, error instanceof Error ? (error.stack ?? error.message) : String(error));
	}
}
const caught = <T>(promise: Promise<T>) =>
	promise.then(
		() => null,
		(error: unknown) => error,
	);
const plain = (value: unknown) => JSON.stringify(value);

// ---------------------------------------------------------------------------------------------
// The stand-in for the engine
// ---------------------------------------------------------------------------------------------

interface Asked {
	method: string;
	path: string;
	authorization: string | undefined;
	body: unknown;
}

class Engine {
	asked: Asked[] = [];
	/** The engine's clock: this check's time, plus how far the engine's is off. */
	skewMs = 0;
	/** The longest it issues a token for, as an engine's `max_duration`. */
	maxSeconds = 86_400;
	/** When set, what it answers in place of a token. */
	answer: ((response: ServerResponse) => void) | null = null;
	/** How long it takes to answer. */
	delayMs = 0;
	private issued = 0;
	private readonly server = createServer((request, response) => void this.handle(request, response));
	url = "";

	constructor(private readonly now: () => number) {}

	async start(): Promise<void> {
		await new Promise<void>(done => this.server.listen(0, "127.0.0.1", done));
		this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
	}

	stop(): Promise<void> {
		this.server.closeAllConnections();
		return new Promise(done => this.server.close(() => done()));
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		let body: unknown = null;
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			// Kept as null.
		}
		this.asked.push({
			method: request.method ?? "",
			path: request.url ?? "",
			authorization: request.headers.authorization,
			body,
		});
		if (this.delayMs > 0) await wait(this.delayMs);
		const send = (status: number, value: unknown) => {
			response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
			response.end(JSON.stringify(value));
		};
		if (this.answer) return this.answer(response);
		if (request.method !== "POST" || request.url !== "/auth/tokens")
			return send(404, { group: "api", code: "not_found", message: "Not found." });
		if (request.headers.authorization !== `Bearer ${ADMIN}`)
			return send(401, { group: "auth", code: "invalid_token", message: "Authentication token is invalid." });
		const { duration } = (body ?? {}) as { duration?: unknown };
		if (typeof duration !== "number" || duration < 1 || duration > this.maxSeconds) {
			return send(400, {
				group: "api",
				code: "invalid_input",
				message: `duration must be between 1 and ${this.maxSeconds} seconds`,
			});
		}
		const issuedAt = this.now() + this.skewMs;
		const token = `FAKE-CONNECTION-TOKEN-${++this.issued}-${this.url.slice(-5)}`;
		secrets.add(token);
		send(200, { token, issued_ts: issuedAt, expires_ts: issuedAt + duration * 1000 });
	}
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
	let now = 1_800_000_000_000;
	const clock = () => now;
	const engine = new Engine(clock);
	await engine.start();

	// The server's configuration is read when its modules load, so it is set first: a deployment with an
	// admin token, whose engine is the stand-in. Nothing below starts a server or touches `.data`.
	process.env.WLP_SECRET = "connection-check-secret-not-a-real-one";
	process.env.WLP_SANDBOX = "fake";
	process.env.RIVET_ADMIN_TOKEN = ADMIN;
	process.env.WLP_PUBLIC_ENDPOINT = `${engine.url}/`;
	process.env.WLP_WEB_ORIGINS = "https://app.example";
	delete process.env.WLP_CONNECTION_TOKEN_TTL_MS;
	delete process.env.RIVET_ENDPOINT;
	delete process.env.RIVET_ENGINE;
	const { CONNECTION_GRANTS, ConnectionTokenError, ConnectionTokens } = await import(
		"../server/src/connection-tokens.js"
	);
	const { config } = await import("../server/src/config.js");
	const { platformConnectionResponse } = await import("../server/src/platform-info.js");
	const { planUsersWarning, startupProblem, warnAboutConnectionTokens } = await import("../server/src/startup.js");

	const logged: string[] = [];
	const tokens = (ttlMs = HOUR, endpoint = engine.url, adminToken = ADMIN) =>
		new ConnectionTokens({
			endpoint,
			adminToken,
			namespace: "default",
			ttlMs,
			now: clock,
			log: line => logged.push(line),
		});
	const reset = () => {
		engine.asked = [];
		engine.answer = null;
		engine.skewMs = 0;
		engine.delayMs = 0;
		engine.maxSeconds = 86_400;
		logged.length = 0;
	};

	await section("issuing", async () => {
		reset();
		const source = tokens();
		const first = await source.current();
		const asked = engine.asked[0];
		expect(
			"the engine is asked with POST /auth/tokens and the admin token as its bearer",
			engine.asked.length === 1 &&
				asked?.method === "POST" &&
				asked.path === "/auth/tokens" &&
				asked.authorization === `Bearer ${ADMIN}`,
			`${asked?.method} ${asked?.path}`,
		);
		expect(
			"for the namespace, for an hour, with the grants the web app needs and no others",
			plain(asked?.body) ===
				plain({
					namespace: "default",
					duration: 3600,
					grants: [
						{ resource: "actor", target: "any", operations: ["list", "read"] },
						{ resource: "actor_gateway", target: "any", operations: ["read", "create"] },
					],
				}) && plain(CONNECTION_GRANTS) === plain((asked?.body as { grants: unknown }).grants),
			plain(asked?.body),
		);
		expect(
			"the answer is the engine's token, its expiry, and how long it is good for",
			first.token.startsWith("FAKE-CONNECTION-TOKEN-1") && first.expiresAt === now + HOUR && first.validForMs === HOUR,
			`validForMs ${first.validForMs}`,
		);

		reset();
		const crowd = tokens();
		engine.delayMs = 50;
		const answers = await Promise.all(Array.from({ length: 40 }, () => crowd.current()));
		expect(
			"forty browsers at the same moment cause one request, and get one token",
			engine.asked.length === 1 && new Set(answers.map(answer => answer.token)).size === 1,
			`${engine.asked.length} request(s)`,
		);

		reset();
		const held = tokens();
		const one = await held.current();
		now += 29 * 60 * 1000;
		const later = await held.current();
		expect(
			"the same token is handed out for half of its life, with what is left of it",
			later.token === one.token && later.validForMs === 31 * 60 * 1000 && engine.asked.length === 1,
			`after 29 minutes: ${later.validForMs / 60_000} minutes left, ${engine.asked.length} request(s)`,
		);
		now += 60 * 1000;
		const atHalf = await held.current();
		expect(
			"with exactly half left it is still handed out",
			atHalf.token === one.token && atHalf.validForMs === 30 * 60 * 1000 && engine.asked.length === 1,
		);
		now += 1;
		const next = await held.current();
		expect(
			"with less than half left the engine is asked for the next one",
			next.token !== one.token && next.validForMs === HOUR && engine.asked.length === 2,
			`${engine.asked.length} request(s)`,
		);
		let least = Number.POSITIVE_INFINITY;
		const before = engine.asked.length;
		for (let minute = 0; minute < 24 * 60; minute++) {
			now += 60 * 1000;
			least = Math.min(least, (await held.current()).validForMs);
		}
		expect(
			"over a day of visitors no answer has less than half an hour left, and the engine is asked about twice an hour",
			least >= 30 * 60 * 1000 && engine.asked.length - before >= 46 && engine.asked.length - before <= 48,
			`least ${least / 60_000} minutes; ${engine.asked.length - before} requests in 24 hours`,
		);

		reset();
		const idle = tokens();
		await idle.current();
		now += 3 * 24 * HOUR;
		expect("while nobody visits, the engine is not asked", engine.asked.length === 1);
		const afterIdle = await idle.current();
		expect(
			"and the first visitor after that gets a new token",
			afterIdle.validForMs === HOUR && engine.asked.length === 2,
		);

		for (const skewMs of [5 * HOUR, -5 * HOUR]) {
			reset();
			engine.skewMs = skewMs;
			const skewed = tokens();
			const got = await skewed.current();
			now += 20 * 60 * 1000;
			const again = await skewed.current();
			now += 11 * 60 * 1000;
			const renewed = await skewed.current();
			expect(
				`an engine whose clock is ${Math.abs(skewMs) / HOUR} hours ${skewMs > 0 ? "ahead of" : "behind"} the server's: the token's life is counted the same`,
				got.validForMs === HOUR &&
					got.expiresAt === now - 31 * 60 * 1000 + skewMs + HOUR &&
					again.token === got.token &&
					again.validForMs === 40 * 60 * 1000 &&
					renewed.token !== got.token,
				`validForMs ${got.validForMs}, then ${again.validForMs}; renewed after 31 minutes`,
			);
		}

		reset();
		engine.answer = response => {
			const token = "FAKE-CONNECTION-TOKEN-short";
			secrets.add(token);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ token, issued_ts: now, expires_ts: now + 10 * 60 * 1000 }));
		};
		const short = tokens();
		const shorter = await short.current();
		now += 5 * 60 * 1000 + 1;
		await short.current();
		expect(
			"a token the engine made shorter than asked is taken for what it is",
			shorter.validForMs === 10 * 60 * 1000 && engine.asked.length === 2,
			`validForMs ${shorter.validForMs}; asked again after half of that`,
		);

		reset();
		const other = new Engine(clock);
		await other.start();
		const [a, b] = await Promise.all([tokens().current(), tokens(HOUR, other.url).current()]);
		expect(
			"two servers each hold a token of their own",
			a.token !== b.token && engine.asked.length === 1 && other.asked.length === 1,
		);
		await other.stop();
	});

	await section("failures", async () => {
		reset();
		const source = tokens();
		const good = await source.current();
		now += 31 * 60 * 1000;
		engine.answer = response => {
			response.writeHead(503, { "content-type": "application/json" });
			response.end(
				JSON.stringify({ group: "auth", code: "issuance_unavailable", message: "Token issuance is unavailable." }),
			);
		};
		const fallback = await source.current();
		expect(
			"when the engine cannot issue, the token in hand is handed out while it lasts",
			fallback.token === good.token && fallback.validForMs === 29 * 60 * 1000,
			`${fallback.validForMs / 60_000} minutes left`,
		);
		expect(
			"and the failure is logged once, with what the engine said",
			logged.length === 1 &&
				logged[0] ===
					`[wlp] connection.token_failed: the Rivet engine at ${engine.url} refused to issue a connection token: 503 auth.issuance_unavailable (Token issuance is unavailable.)`,
			logged.join(" | "),
		);
		const askedBefore = engine.asked.length;
		for (let i = 0; i < 20; i++) await source.current();
		expect(
			"the engine is not asked again for five seconds, however many browsers ask",
			engine.asked.length === askedBefore,
		);
		now += 5_000;
		await source.current();
		expect("then it is asked again", engine.asked.length === askedBefore + 1);
		now += 28 * 60 * 1000 + 23_000;
		const last = await source.current();
		expect(
			"a token with thirty seconds left is the last that is handed out",
			last.token === good.token && last.validForMs >= 30_000 && last.validForMs < 35_000,
			`${last.validForMs} ms left`,
		);
		now += 5_000;
		const gone = await caught(source.current());
		expect("after that the answer is an error", gone instanceof ConnectionTokenError, String(gone));
		engine.answer = null;
		now += 5_000;
		const mended = await source.current();
		expect(
			"and once the engine answers again, so does the server",
			mended.token !== good.token && mended.validForMs === HOUR,
		);

		reset();
		const refused = await caught(tokens(HOUR, engine.url, "FAKE-ADMIN-TOKEN-the-wrong-one").current());
		secrets.add("FAKE-ADMIN-TOKEN-the-wrong-one");
		expect(
			"an admin token the engine refuses: the error says so, and holds no token",
			refused instanceof ConnectionTokenError &&
				refused.message ===
					`the Rivet engine at ${engine.url} refused to issue a connection token: 401 auth.invalid_token (Authentication token is invalid.)`,
			refused instanceof Error ? refused.message : String(refused),
		);

		reset();
		engine.answer = response => {
			response.writeHead(400, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					group: "api",
					code: "invalid_input",
					message: `you sent Bearer ${ADMIN} and it was not liked`,
				}),
			);
		};
		const echoed = await caught(tokens().current());
		expect(
			"an engine that repeats the admin token in its refusal: it is taken out of the error and of the log",
			echoed instanceof ConnectionTokenError &&
				!echoed.message.includes(ADMIN) &&
				echoed.message.includes("<admin token>") &&
				logged.length === 1 &&
				!logged[0]!.includes(ADMIN),
			echoed instanceof Error ? echoed.message.replace(ADMIN, "<the admin token itself>") : String(echoed),
		);

		reset();
		engine.maxSeconds = 86_400;
		const tooLong = await caught(tokens(2 * 24 * HOUR).current());
		expect(
			"a lifetime the engine does not allow: its own sentence is in the error",
			tooLong instanceof ConnectionTokenError &&
				tooLong.message.endsWith("400 api.invalid_input (duration must be between 1 and 86400 seconds)"),
			tooLong instanceof Error ? tooLong.message : "",
		);

		for (const [name, body] of [
			["no token", { issued_ts: now, expires_ts: now + HOUR }],
			["an empty token", { token: "", issued_ts: now, expires_ts: now + HOUR }],
			["no times", { token: "FAKE-CONNECTION-TOKEN-x" }],
			[
				"a token that expired before it was issued",
				{ token: "FAKE-CONNECTION-TOKEN-x", issued_ts: now, expires_ts: now - 1 },
			],
			["not JSON", "<html>"],
		] as const) {
			reset();
			engine.answer = response => {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(typeof body === "string" ? body : JSON.stringify(body));
			};
			const error = await caught(tokens().current());
			expect(
				`an answer with ${name} is refused`,
				error instanceof ConnectionTokenError && !error.message.includes("FAKE-CONNECTION-TOKEN"),
				error instanceof Error ? error.message : String(error),
			);
		}

		reset();
		const nowhere = new Engine(clock);
		await nowhere.start();
		const deadUrl = nowhere.url;
		await nowhere.stop();
		const unreachable = await caught(tokens(HOUR, deadUrl).current());
		expect(
			"an engine that is not there: the error names its address and why",
			unreachable instanceof ConnectionTokenError &&
				unreachable.message ===
					`the Rivet engine at ${deadUrl} could not be asked for a connection token (ECONNREFUSED)`,
			unreachable instanceof Error ? unreachable.message : String(unreachable),
		);
	});

	await section("route", async () => {
		reset();
		const get = (headers: Record<string, string> = {}, method = "GET") =>
			platformConnectionResponse(new Request("http://server.test/platform/connection", { method, headers }));
		expect(
			"the configuration: the endpoint without its trailing slash, tokens on, an hour",
			config.browsers.endpoint === engine.url && config.browsers.tokens === true && config.browsers.tokenTtlMs === HOUR,
			plain(config.browsers),
		);
		expect("the admin token is nowhere in the configuration", !plain(config).includes(ADMIN));

		const response = await get({ origin: "https://app.example" });
		const body = (await response.json()) as import("../server/src/contract.js").PlatformConnection;
		if (body.token) secrets.add(body.token.token);
		expect(
			"GET /platform/connection: where the engine is for browsers, the namespace, and a token with its expiry",
			response.status === 200 &&
				body.endpoint === engine.url &&
				body.namespace === "default" &&
				typeof body.token?.token === "string" &&
				body.token.token.startsWith("FAKE-CONNECTION-TOKEN-") &&
				body.token.validForMs > 59 * 60 * 1000 &&
				body.token.validForMs <= HOUR &&
				body.token.expiresAt > Date.now(),
			`status ${response.status}, endpoint ${body.endpoint}, namespace ${body.namespace}, validForMs ${body.token?.validForMs}`,
		);
		expect(
			"the answer is not to be stored, and is readable by the web app's origin only",
			response.headers.get("cache-control") === "no-store" &&
				response.headers.get("access-control-allow-origin") === "https://app.example" &&
				response.headers.get("vary") === "Origin",
		);
		expect(
			"nothing but those three is in it",
			plain(Object.keys(body).sort()) === plain(["endpoint", "namespace", "token"]) &&
				plain(Object.keys(body.token ?? {}).sort()) === plain(["expiresAt", "token", "validForMs"]) &&
				!plain(body).includes(ADMIN),
		);

		const again = (await (await get()).json()) as typeof body;
		expect(
			"the next visitor gets the same token, and the engine is not asked again",
			again.token?.token === body.token?.token && engine.asked.length === 1,
			`${engine.asked.length} request(s) to the engine`,
		);

		const evil = await get({ origin: "https://evil.example" });
		const evilBody = await evil.text();
		expect(
			"a page on another site is refused, with no token and no CORS header",
			evil.status === 403 &&
				evilBody.includes("origin_not_allowed") &&
				!evilBody.includes("FAKE-CONNECTION-TOKEN") &&
				evil.headers.get("access-control-allow-origin") === null,
			`status ${evil.status}`,
		);
		const preflight = await get({ origin: "https://app.example", "access-control-request-method": "GET" }, "OPTIONS");
		expect(
			"a preflight is answered without a token",
			preflight.status === 204 &&
				preflight.headers.get("access-control-allow-origin") === "https://app.example" &&
				(await preflight.text()) === "",
		);
		const post = await get({}, "POST");
		expect("only GET is answered", post.status === 405 && post.headers.get("allow") === "GET");
	});

	await section("route, engine gone", async () => {
		// The route's own source of tokens reads the real clock. Its token is an hour old only in an hour, so the
		// check that it fails without one runs in a process of its own: the same code, a stand-in that refuses.
		reset();
		engine.answer = response => {
			response.writeHead(401, { "content-type": "application/json" });
			response.end(
				JSON.stringify({ group: "auth", code: "invalid_token", message: "Authentication token is invalid." }),
			);
		};
		const program = `
			const { platformConnectionResponse } = await import("./src/platform-info.ts");
			const response = await platformConnectionResponse(new Request("http://server.test/platform/connection", { headers: { origin: "https://app.example" } }));
			console.log(JSON.stringify({ status: response.status, cors: response.headers.get("access-control-allow-origin"), body: await response.text() }));
		`;
		// Not a synchronous spawn: the stand-in runs in this process and has to answer meanwhile.
		const child = await new Promise<{ stdout: string; stderr: string }>(done => {
			execFile(
				process.execPath,
				["--import", "tsx", "--input-type=module", "-e", program],
				{
					env: {
						...process.env,
						WLP_TOKEN_ENDPOINT: engine.url,
						WLP_PUBLIC_ENDPOINT: "https://gateway.example.invalid",
					},
					encoding: "utf8",
				},
				(_error, stdout, stderr) => done({ stdout, stderr }),
			);
		});
		const result = JSON.parse(child.stdout.trim().split("\n").pop() ?? "{}") as {
			status?: number;
			cors?: string | null;
			body?: string;
		};
		expect(
			"with an engine that refuses the admin token the route answers 503 connection_unavailable, readable by the web app",
			result.status === 503 &&
				result.cors === "https://app.example" &&
				result.body ===
					plain({
						group: "platform",
						code: "connection_unavailable",
						message: "The server could not prepare a connection to the agents. Try again in a moment.",
					}),
			`status ${result.status}: ${result.body}`,
		);
		expect(
			"the answer names neither the engine nor a token",
			!(result.body ?? "").includes(engine.url) && !(result.body ?? "").includes(ADMIN),
		);
		expect(
			"the server's log has the reason, and no token",
			child.stderr.includes(
				`[wlp] connection.token_failed: the Rivet engine at ${engine.url} refused to issue a connection token: 401 auth.invalid_token`,
			) && !child.stderr.includes(ADMIN),
			child.stderr.trim().slice(0, 300),
		);
	});

	await section("startup", async () => {
		const { readPlatformKey } = await import("../server/src/runner/frame-auth.js");
		for (const raw of [undefined, "malformed-key-sentinel"]) {
			let problem = "";
			try {
				readPlatformKey(raw);
			} catch (error) {
				problem = (error as Error).message;
			}
			expect(
				"platform identity configuration errors name the variable and redact its value",
				problem.includes("WLP_PLATFORM_KEY") && !problem.includes("malformed-key-sentinel"),
			);
		}
		reset();
		const engineConfig = { remote: true, endpoint: "http://internal.example", namespace: "default", pool: "default" };
		const browsers = (endpoint: string | null, withTokens: boolean) => ({
			endpoint,
			tokens: withTokens,
			tokenTtlMs: HOUR,
		});
		const hosted = {
			engine: engineConfig,
			secretConfigured: true,
			unusable: [],
			browsers: browsers(null, false),
			sandbox: "docker" as const,
			allowDockerHosted: false,
		};
		expect(
			"remote engine refuses the hosted Docker layer",
			startupProblem(hosted)?.includes("WLP_ALLOW_DOCKER_HOSTED") === true,
		);
		expect(
			"explicit operator override permits the hosted Docker layer",
			startupProblem({ ...hosted, allowDockerHosted: true }) === null,
		);
		expect(
			"embedded engine permits the Docker layer",
			startupProblem({ ...hosted, engine: { ...engineConfig, remote: false } }) === null,
		);
		const fake = { ...hosted, sandbox: "fake" as const };
		const missing = startupProblem({ ...fake, browsers: browsers(null, true) });
		expect(
			"an admin token without the engine's address for browsers: the server refuses to start, in one sentence",
			missing !== null && missing.startsWith("[wlp] WLP_PUBLIC_ENDPOINT is not set:") && !missing.includes("\n"),
			missing ?? "",
		);
		expect(
			"with both, and with neither, it starts",
			startupProblem({ ...fake, browsers: browsers("https://engine.example", true) }) === null &&
				startupProblem({
					...fake,
					engine: { ...engineConfig, remote: false, endpoint: null },
					browsers: browsers(null, false),
				}) === null,
		);
		expect(
			"an address without an admin token is an engine that asks for none: it starts",
			startupProblem({ ...fake, browsers: browsers("https://engine.example", false) }) === null,
		);

		const nobody = planUsersWarning({ plans: new Set() });
		expect(
			"WLP_PLAN_USERS naming nobody is said at startup, with its effect, in one line",
			nobody !== null &&
				nobody.includes("WLP_PLAN_USERS") &&
				nobody.includes("refused for everyone") &&
				!nobody.includes("\n"),
			nobody ?? "",
		);
		expect(
			"WLP_PLAN_USERS naming users, or everyone: nothing is said",
			planUsersWarning({ plans: new Set(["u_a"]) }) === null && planUsersWarning({ plans: "all" }) === null,
		);

		const printed: string[] = [];
		expect(
			"no admin token: nothing is asked and nothing is said",
			(await warnAboutConnectionTokens(null, line => printed.push(line))) === null && printed.length === 0,
		);
		expect(
			"an engine that issues: nothing is said",
			(await warnAboutConnectionTokens(tokens(), line => printed.push(line))) === null &&
				printed.length === 0 &&
				engine.asked.length === 1,
		);
		const warned = await warnAboutConnectionTokens(tokens(HOUR, engine.url, "FAKE-ADMIN-TOKEN-the-wrong-one"), line =>
			printed.push(line),
		);
		expect(
			"an admin token the engine refuses is said when the server starts",
			warned !== null &&
				printed.length === 1 &&
				printed[0] === warned &&
				warned.startsWith("[wlp] WARNING: Browsers cannot connect: the Rivet engine at ") &&
				warned.includes("401 auth.invalid_token") &&
				warned.endsWith("Check RIVET_ADMIN_TOKEN and WLP_PUBLIC_ENDPOINT."),
			warned ?? "",
		);
	});

	await engine.stop();

	await section("cluster", async () => {
		if (realEngine === "" || realAdminToken === "") {
			info("SKIP  no real engine: set WLP_CHECK_ENGINE and RIVET_ADMIN_TOKEN to run it");
			return;
		}
		const inspect = async (token: string) => {
			const response = await fetch(`${realEngine}/auth/tokens/inspect`, {
				headers: { authorization: `Bearer ${token}` },
			});
			return {
				status: response.status,
				refusal: response.headers.get("x-rivet-error"),
				body: (await response.json().catch(() => null)) as {
					grants?: Array<{ resource: string; target: unknown; operations: string[] }>;
					issued_ts?: number;
					expires_ts?: number;
					group?: string;
					code?: string;
				} | null,
			};
		};
		const real = (ttlMs: number, adminToken = realAdminToken) =>
			new ConnectionTokens({
				endpoint: realEngine,
				adminToken,
				namespace: "default",
				ttlMs,
				log: line => logged.push(line),
			});
		logged.length = 0;

		const source = real(HOUR);
		const issued = await source.current();
		secrets.add(issued.token);
		expect(
			"the engine issues a token for an hour",
			issued.validForMs > 59 * 60 * 1000 &&
				issued.validForMs <= HOUR &&
				Math.abs(issued.expiresAt - (Date.now() + HOUR)) < 60_000,
			`validForMs ${issued.validForMs}; its expiry is ${Math.round((issued.expiresAt - Date.now()) / 1000)} s from now by this machine's clock`,
		);
		const same = await source.current();
		expect("a second visitor gets the same one", same.token === issued.token);

		const seen = await inspect(issued.token);
		const normal = (grants: ReadonlyArray<{ resource: string; target: unknown; operations: readonly string[] }>) =>
			plain(
				grants
					.map(grant => ({ resource: grant.resource, target: grant.target, operations: [...grant.operations].sort() }))
					.sort((x, y) => x.resource.localeCompare(y.resource)),
			);
		expect(
			"the engine reads it back with exactly the grants asked for",
			seen.status === 200 && normal(seen.body?.grants ?? []) === normal(CONNECTION_GRANTS),
			`status ${seen.status}, grants ${plain(seen.body?.grants)}`,
		);
		expect(
			"and with the lifetime asked for",
			(seen.body?.expires_ts ?? 0) - (seen.body?.issued_ts ?? 0) === HOUR && seen.body?.expires_ts === issued.expiresAt,
			`${((seen.body?.expires_ts ?? 0) - (seen.body?.issued_ts ?? 0)) / 1000} s`,
		);

		// RivetKit's client reads the expiry out of the token itself (client/token-provider.ts).
		let exp: unknown;
		try {
			const payload = issued.token.split(".")[1] ?? "";
			exp = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }).exp;
		} catch {
			exp = undefined;
		}
		expect(
			"the token is a JWT whose `exp` RivetKit's client can read",
			typeof exp === "number" && exp * 1000 === issued.expiresAt,
			`exp is ${typeof exp === "number" ? `${Math.round(exp - Date.now() / 1000)} s from now` : "not readable"}`,
		);

		const tooLong = await caught(real(24 * HOUR + 1000).current());
		expect(
			"more than 24 hours is refused, in the engine's words",
			tooLong instanceof ConnectionTokenError && /duration must be between 1 and \d+ seconds/.test(tooLong.message),
			tooLong instanceof Error ? tooLong.message : String(tooLong),
		);
		const day = await caught(
			real(24 * HOUR)
				.current()
				.then(token => void secrets.add(token.token)),
		);
		expect("24 hours is issued", day === null, day instanceof Error ? day.message : "");

		const wrong = await caught(real(HOUR, "not-the-admin-token-of-this-cluster").current());
		expect(
			"a wrong admin token is refused, and the error holds no token",
			wrong instanceof ConnectionTokenError &&
				wrong.message.includes("401") &&
				!wrong.message.includes("not-the-admin-token"),
			wrong instanceof Error ? wrong.message : String(wrong),
		);

		const brief = await real(2_000).current();
		secrets.add(brief.token);
		const early = await inspect(brief.token);
		info(`a token issued for 2 s, read back at once: ${early.status}`);
		info("waiting 36 s for it to run out (the engine accepts a token until 30 s after its expiry)...");
		await wait(36_000);
		const late = await inspect(brief.token);
		expect(
			"a token that ran out is refused with 401 and `x-rivet-error: auth.token_expired`, which is what RivetKit's client renews on",
			late.status === 401 && late.refusal === "auth.token_expired",
			`status ${late.status}, x-rivet-error ${late.refusal}, body ${late.body?.group}.${late.body?.code}`,
		);
	});

	await section("output", async () => {
		const leaked = output.filter(line => [...secrets].some(secret => line.includes(secret)));
		expect(
			"no admin token and no issued token is in anything this check printed",
			leaked.length === 0,
			`${output.length} lines read, ${secrets.size} secrets looked for`,
		);
	});

	tally.summary(true);
}

main()
	.catch(error => {
		tally.failures += 1;
		console.error(error instanceof Error ? error.message : "the check failed");
	})
	.finally(() => process.exit(tally.failures === 0 ? 0 : 1));
