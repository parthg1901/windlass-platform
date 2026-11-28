/**
 * End-to-end check of the server's three actors, through RivetKit's client, as the web app uses them,
 * and of its HTTP routes (`/platform/info`, `/platform/connection`, `/health`).
 *
 *   cd server && npx tsx ../scripts/e2e.ts                 starts a server on fresh state
 *   cd server && npx tsx ../scripts/e2e.ts --github-only   the GitHub scenarios on a fresh fake server
 *   cd server && npx tsx ../scripts/e2e.ts --endpoint URL  uses a running server (HTTP on the
 *                                                         same host, port 6440, or at WLP_E2E_API)
 *
 * WLP_SANDBOX chooses the sandbox layer of the server it starts (default here: fake). The server is
 * always started with WLP_DEMO=1; with --endpoint the server must have it too. Some checks need the
 * server's own output or a restart and are skipped with --endpoint; some are for one layer only.
 * With the Docker layer, WLP_E2E_REPO=<https git address> adds a check that clones that repository.
 * The server's state and log go to a new directory under WLP_E2E_DIR (default: the system's temporary
 * directory), removed when everything passed unless WLP_E2E_KEEP=1.
 *
 * --section=core|usage|resume partitions the full run across CI jobs with separate local servers.
 * --idle-only runs the platform and sign-in checks, then only the idle sandbox checks (`IDLE_CHECKS`).
 *
 * Prints one PASS/FAIL/SKIP line per check and exits 1 if any failed.
 */

import { loginHttp } from "./login-http.js";
import { connectChatgpt } from "./chatgpt-connect.js";
import { imageId } from "./check-image.js";
import { localListeners, portFree } from "./check-listeners.js";
import { type ChildProcess, execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	createWriteStream,
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createClient, type Registry } from "../server/src/client.js";
import { GithubStandin } from "./github-standin.js";
import { sessionCapabilities } from "../server/src/sandbox/harnesses.js";
import { Report } from "./check-report.js";
import { sleep, waitFor } from "./check-wait.js";
import {
	type AuthResult,
	type RepositoryEnvironment,
	type WindlassDelta,
	MAX_PROMPT_CHARS,
	type GithubId,
	type PendingQuestion,
	type SessionSnapshot,
	type SessionSummary,
	type TimelineItem,
} from "../server/src/contract.js";

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../server");
const args = process.argv.slice(2);
const snapshotBenchmark = args.includes("--snapshot-benchmark");
const snapshotOnly = snapshotBenchmark || args.includes("--snapshots-only");
const endpointArg = args.includes("--endpoint") ? args[args.indexOf("--endpoint") + 1] : undefined;
const {
	engine: ENGINE_PORT,
	http: [HTTP_PORT, refusalPort],
} = endpointArg === undefined ? await localListeners(2) : { engine: Number(new URL(endpointArg).port), http: [6440] };
const ENDPOINT = endpointArg ?? `http://127.0.0.1:${ENGINE_PORT}`;
/** The server's own HTTP routes. */
const API = process.env.WLP_E2E_API ?? `${new URL(ENDPOINT).protocol}//${new URL(ENDPOINT).hostname}:${HTTP_PORT}`;
const MODE = (process.env.WLP_SANDBOX ?? "fake") as "fake" | "docker";
const OWN_SERVER = endpointArg === undefined;
const FAKE = MODE === "fake";
const identityOnly = args.includes("--identity-only");
const githubOnly = args.includes("--github-only");
if (githubOnly && (!OWN_SERVER || !FAKE || identityOnly)) throw new Error("--github-only requires a local fake server");
if (identityOnly && (!OWN_SERVER || !FAKE)) throw new Error("--identity-only requires a local fake server");
const idleOnly = args.includes("--idle-only");
if (idleOnly && !OWN_SERVER) throw new Error("--idle-only requires a server of its own");
/** Only the checks of a turn that pauses and resumes across a restart (WLP_TURN_RESUME). */
const resumeOnly = args.includes("--resume-only");
if (resumeOnly && !OWN_SERVER) throw new Error("--resume-only requires a server of its own");
const section = args.find(arg => arg.startsWith("--section="))?.slice("--section=".length);
if (section !== undefined && (!["core", "usage", "resume"].includes(section) || !OWN_SERVER || args.length !== 1)) {
	throw new Error("Use --section=core, --section=usage or --section=resume on its own");
}
const sandboxImage = OWN_SERVER && MODE === "docker" ? await imageId() : undefined;
/** How long one turn may take. A Docker turn creates a container and runs real commands. */
const TURN_MS = FAKE ? 30_000 : 240_000;
/** How long the server this script starts lets a question wait before it declines it: short, so the wait can be watched. */
const QUESTION_MS = FAKE ? 8_000 : 20_000;

/** The ceiling on a person's hosted agents working at once that this script's cases assume: its servers are started with it (WLP_FACTORY_HOSTED_RUNNING). */
const RUNNING_CEILING = 3;

// A browser sends its origin on the WebSocket handshake. Node's WebSocket can be told to as well, which
// lets this script play a page from an origin the server does not allow.
const NativeWebSocket = globalThis.WebSocket;
let webSocketOrigin: string | null = null;
class OriginWebSocket extends NativeWebSocket {
	constructor(url: string | URL, protocols?: string | string[]) {
		// biome-ignore lint/suspicious/noExplicitAny: undici's WebSocket takes an options object here
		super(url, (webSocketOrigin ? { protocols, headers: { Origin: webSocketOrigin } } : protocols) as any);
	}
}
globalThis.WebSocket = OriginWebSocket as typeof WebSocket;

const tally = new Report({ failure: "dash", fold: false });
const { pass, fail, skip } = tally;

function describe(error: unknown): string {
	if (typeof error === "object" && error !== null) {
		const { code, message } = error as { code?: unknown; message?: unknown };
		if (code !== undefined) return `${String(code)}: ${String(message)}`;
		if (message !== undefined) return String(message);
	}
	return String(error);
}

/** Runs one check: PASS with what it returns, FAIL with what it throws. */
const check = (name: string, body: () => Promise<string | undefined> | string | undefined) =>
	tally.check(name, body, describe);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/** Expects `call` to fail with a RivetKit error of this code; returns its message. */
async function refused(call: () => Promise<unknown>, code: string | string[]): Promise<string> {
	const codes = Array.isArray(code) ? code : [code];
	let result: unknown;
	try {
		result = await call();
	} catch (error) {
		const got = (error as { code?: unknown }).code;
		assert(
			typeof got === "string" && codes.includes(got),
			`expected error ${codes.join(" or ")}, got ${describe(error)}`,
		);
		return String((error as { message?: unknown }).message);
	}
	throw new Error(
		`expected error ${codes.join(" or ")}, but the call succeeded with ${JSON.stringify(result)?.slice(0, 200)}`,
	);
}

function withTimeout<T>(what: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((done, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms: ${what}`)), timeoutMs);
		promise.then(
			value => {
				clearTimeout(timer);
				done(value);
			},
			error => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

// ---------------------------------------------------------------------------------------------
// The server under test
// ---------------------------------------------------------------------------------------------

class Server {
	private child: ChildProcess | null = null;
	private startOffset = 0;
	output = "";

	readonly storage = mkdtempSync(join(process.env.WLP_E2E_DIR ?? tmpdir(), "wlp-e2e-"));
	readonly logFile = join(this.storage, "server.log");
	/** The server's WLP_SECRET: a check that calls an internal action signs its service token with it (`serviceUser`). */
	readonly secret = randomBytes(24).toString("hex");

	constructor() {
		// Before anything of the server is imported here, which reads WLP_SECRET once (config.ts).
		process.env.WLP_SECRET = this.secret;
	}

	get outputSinceStart(): string {
		return this.output.slice(this.startOffset);
	}

	async start(extraEnv: Record<string, string> = {}): Promise<void> {
		this.startOffset = this.output.length;
		const log = createWriteStream(this.logFile, { flags: "a" });
		const env: Record<string, string | undefined> = {
			...process.env,
			WLP_DEMO: "1",
			WLP_SANDBOX: MODE,
			// Hosted Windlass's ChatGPT models pay with the ChatGPT plan, which WLP_PLAN_USERS gates. Its catalog check at
			// connect is refused locally: no check sends a fake token to OpenAI.
			WLP_PLAN_USERS: process.env.WLP_PLAN_USERS ?? "*",
			WLP_OPENAI_BASE_URL: process.env.WLP_OPENAI_BASE_URL ?? "http://127.0.0.1:9",
			...(sandboxImage && { WLP_SANDBOX_IMAGE: sandboxImage }),
			WLP_SECRET: this.secret,
			RIVETKIT_STORAGE_PATH: this.storage,
			RIVET_RUN_ENGINE_PORT: String(ENGINE_PORT),
			WLP_HTTP_PORT: String(HTTP_PORT),
			WLP_FAKE_DELAY_MS: process.env.WLP_FAKE_DELAY_MS ?? "15",
			WLP_QUESTION_TIMEOUT_MS: String(QUESTION_MS),
			// One demo user keeps more sandboxes here, and runs them for longer, than an account may: the
			// two limits have a check of their own (usage-check.ts).
			WLP_DAILY_SANDBOX_SECONDS: "unlimited",
			WLP_MAX_KEPT_SANDBOXES: "unlimited",
			// A person's ceiling on agents working at once, set to what the checks of that limit count to.
			WLP_FACTORY_HOSTED_RUNNING: String(RUNNING_CEILING),
			...extraEnv,
		};
		// The local engine asks browsers for no token. An admin token in the shell this is run from is some
		// other engine's, and must not be sent to this one or anywhere else.
		delete env.RIVET_ADMIN_TOKEN;
		delete env.WLP_PUBLIC_ENDPOINT;
		const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
			cwd: SERVER_DIR,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.child = child;
		const keep = (chunk: Buffer) => {
			this.output += chunk.toString("utf8");
			log.write(chunk);
		};
		child.stdout?.on("data", keep);
		child.stderr?.on("data", keep);
		child.on("close", (code, signal) => {
			if (this.child === child) this.child = null;
			log.end(`\n[e2e] server exited: code ${code} signal ${signal}\n`);
		});

		// The HTTP routes come up once the node has registered with the engine.
		await waitFor(
			"the server to answer",
			async () => {
				if (!this.child)
					throw new Error(`the server exited while starting (code ${child.exitCode}, signal ${child.signalCode})`);
				try {
					return (await fetch(`${API}/platform/info`)).ok;
				} catch {
					return false;
				}
			},
			120_000,
			400,
		).catch(error => {
			throw new Error(
				`${error.message}\nLast lines of ${this.logFile}:\n${this.output.trimEnd().split("\n").slice(-80).join("\n")}`,
				{ cause: error },
			);
		});
	}

	/** Stops the server as Ctrl-C would. */
	async stop(): Promise<void> {
		const child = this.child;
		if (!child) return;
		child.kill("SIGTERM");
		await waitFor("the server to exit", () => this.child === null, 40_000, 100).catch(() => child.kill("SIGKILL"));
		await sleep(300);
		this.reapEngine();
	}

	/** Kills the server with no chance to shut down, as a crash would. */
	async crash(): Promise<void> {
		const child = this.child;
		if (!child) return;
		child.kill("SIGKILL");
		await waitFor("the server to die", () => this.child === null, 10_000, 50);
		// The engine is a child of the server; make sure it does not outlive it and keep the port.
		await sleep(500);
		this.reapEngine();
		await waitFor(`ports ${ENGINE_PORT} and ${HTTP_PORT} to be free`, portsFree, 20_000, 200);
	}

	private reapEngine(): void {
		try {
			const runtime = JSON.parse(
				readFileSync(join(this.storage, ".rivetkit", "var", "engine", "runtime.json"), "utf8"),
			) as { pid?: number };
			if (typeof runtime.pid === "number") process.kill(runtime.pid, "SIGKILL");
		} catch {
			// No engine left, which is the point.
		}
	}

	remove(): void {
		if (tally.failures === 0 && process.env.WLP_E2E_KEEP !== "1")
			rmSync(this.storage, { recursive: true, force: true });
		else console.log(`\nserver log and state kept in ${this.storage}`);
	}
}

/** Both of the server's ports: the engine's and the platform's HTTP routes. */
async function portsFree(): Promise<boolean> {
	return (await portFree(ENGINE_PORT)) && (await portFree(HTTP_PORT));
}

/** `GET /platform/info`, from a page at `origin` when one is given. */
function platformInfo(origin?: string): Promise<Response> {
	return fetch(`${API}/platform/info`, { headers: origin ? { Origin: origin } : {} });
}

/**
 * Starts the server with a remote engine configured and no WLP_SECRET; it must stop by itself, before
 * it connects anywhere. The endpoint is a closed local port with a made-up token.
 */
/** `GET /platform/connection`, from a page at `origin` when one is given. */
function platformConnection(origin?: string): Promise<Response> {
	return fetch(`${API}/platform/connection`, { headers: origin ? { Origin: origin } : {} });
}

/**
 * Starts a server that is expected to refuse to start, on a port of its own, and returns what it said.
 * `change` is given the environment it would otherwise start with.
 */
async function startRefused(
	change: (env: Record<string, string | undefined>) => void,
): Promise<{ code: number | null; output: string }> {
	const env: Record<string, string | undefined> = {
		...process.env,
		WLP_SANDBOX: "fake",
		WLP_SECRET: randomBytes(24).toString("hex"),
		WLP_HTTP_PORT: String(refusalPort),
		RIVET_RUN_ENGINE_PORT: String(ENGINE_PORT),
	};
	delete env.RIVET_ADMIN_TOKEN;
	delete env.WLP_PUBLIC_ENDPOINT;
	change(env);
	const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
		cwd: SERVER_DIR,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
	child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
	const code = await withTimeout(
		"the server to refuse to start",
		new Promise<number | null>(done => child.on("exit", exitCode => done(exitCode))),
		30_000,
	).catch(error => {
		child.kill("SIGKILL");
		throw error;
	});
	return { code, output };
}

/** The `docker inspect` state of a sandbox's container ("running", "paused", "exited", ...), or "gone". */
function containerState(sandboxId: string): string {
	try {
		return execFileSync("docker", ["inspect", "-f", "{{.State.Status}}", `wlp-session-${sandboxId}`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch {
		return "gone";
	}
}

function sandboxContainers(): string[] {
	const out = execFileSync(
		"docker",
		["ps", "-a", "--filter", "label=dev.windlass-platform=1", "--format", "{{.Names}}"],
		{ encoding: "utf8" },
	);
	return out.split("\n").filter(name => name.startsWith("wlp-session-"));
}

/** How long the server under test accepts a sign-in attempt. Shortened when this script restarts its server. */
let loginTtlMs = 10 * 60 * 1000;
const SHORT_LOGIN_TTL_MS = 15_000;

function loginVolumes(attempt: string): string[] {
	return execFileSync("docker", ["volume", "ls", "-q", "--filter", "label=dev.windlass-platform=1"], {
		encoding: "utf8",
	})
		.split("\n")
		.filter(name => name === `wlp-login-${attempt}`);
}

async function controlPlane(path: string, method = "GET"): Promise<Response> {
	return fetch(`${ENDPOINT}${path}`, {
		method,
		headers: { Authorization: "Bearer default", "Content-Type": "application/json" },
		body: method === "GET" ? undefined : "{}",
	});
}

/** The user actor as the platform's own actors call it, with a service token signed with the server's secret. */
async function serviceUser(server: Server, uid: string) {
	// Signed with the server's secret: this process has it as WLP_SECRET (`Server`'s constructor).
	assert(process.env.WLP_SECRET === server.secret, "this process does not have the server's secret");
	const { serviceParams } = await import("../server/src/auth.js");
	return newClient().user.get([uid], { params: serviceParams() }) as unknown as {
		internalRelease(sessionId: string): Promise<void>;
		internalSessionChanged(summary: SessionSummary): Promise<void>;
		internalAcquireRun(
			sessionId: string,
		): Promise<{ ok: boolean; running: number; known: boolean; until: number | null; claim: number | null }>;
		internalReleaseRun(input: {
			sessionId: string;
			claim: number;
			summary: SessionSummary;
		}): Promise<{ released: boolean }>;
		internalSweepSandboxes(): Promise<void>;
	};
}

/** Puts a session's actor to sleep through the control plane, as the lifecycle documentation describes. */
async function forceSleep(sid: string): Promise<void> {
	const list = (await (await controlPlane("/actors?namespace=default&name=agentSession")).json()) as {
		actors: Array<{ actor_id: string; key: string }>;
	};
	const record = list.actors.find(entry => entry.key.includes(sid));
	assert(record, `the control plane does not list the session's actor: ${plain(list).slice(0, 300)}`);
	const slept = await controlPlane(`/actors/${record.actor_id}/sleep?namespace=default`, "POST");
	assert(slept.ok, `the control plane refused the sleep: ${slept.status} ${await slept.text()}`);
}

/** The demo users this run signed in. With the Docker layer each has a data volume, removed at the end. */
const demoUids: string[] = [];

/** Removes this run's volumes, and only those: other work may be using the same Docker. */
function removeDemoVolumes(): string[] {
	const failures: string[] = [];
	const existing = execFileSync("docker", ["volume", "ls", "-q", "--filter", "label=dev.windlass-platform=1"], {
		encoding: "utf8",
	}).split("\n");
	for (const uid of demoUids) {
		// The user's volume, and any a hardened sandbox of theirs had of its own (wlp-session-data-<uid>-<id>).
		for (const name of existing.filter(
			name =>
				name === `wlp-user-${uid}` ||
				(/^[a-f0-9]{12}$/.test(name.slice(`wlp-session-data-${uid}-`.length)) &&
					name.startsWith(`wlp-session-data-${uid}-`)),
		)) {
			try {
				execFileSync("docker", ["volume", "rm", name], { stdio: "pipe" });
			} catch (error) {
				failures.push(`${name}: ${describe(error).split("\n")[0]}`);
			}
		}
	}
	return failures;
}

// ---------------------------------------------------------------------------------------------
// Watching a session
// ---------------------------------------------------------------------------------------------

type Client = ReturnType<typeof createClient<Registry>>;
type WindlassItem = Extract<TimelineItem, { kind: "windlass" }>;

function newClient(options: { origin?: string } = {}): Client {
	return createClient<Registry>({
		endpoint: ENDPOINT,
		headers: options.origin ? { Origin: options.origin } : undefined,
	});
}

/** A connection to one session that records every event in the order it arrived. */
class Watch {
	readonly items: TimelineItem[] = [];
	readonly deltas: WindlassDelta[] = [];
	readonly summaries: SessionSummary[] = [];
	/** Every `question` event: the question when one is asked, null when it is settled. */
	readonly questions: Array<PendingQuestion | null> = [];
	/** Arrival order across both streams: "i<seq>" for an item, "d" for a delta. */
	readonly order: string[] = [];
	readonly conn;

	constructor(client: Client, uid: string, id: string, token: string) {
		this.conn = client.agentSession.get([uid, id], { params: { token } }).connect();
		// RivetKit 3.1.1's client types event payloads as `unknown`, hence the casts.
		this.conn.on("item", (payload: unknown) => {
			const item = payload as TimelineItem;
			this.items.push(item);
			this.order.push(`i${item.seq}`);
		});
		this.conn.on("delta", (payload: unknown) => {
			this.deltas.push(payload as WindlassDelta);
			this.order.push("d");
		});
		this.conn.on("summary", (payload: unknown) => {
			this.summaries.push(payload as SessionSummary);
		});
		this.conn.on("question", (payload: unknown) => {
			this.questions.push(payload as PendingQuestion | null);
		});
	}

	/** The question the turn is waiting on, once it has been announced. */
	async untilQuestion(turn: number, timeoutMs = TURN_MS): Promise<PendingQuestion> {
		return waitFor(
			`turn ${turn} to ask its question`,
			() => {
				const last = this.questions.at(-1);
				if (last && last.turn === turn) return last;
				const ended = this.ended(turn);
				if (ended)
					throw new Error(
						`turn ${turn} ended (${ended.outcome}${ended.message ? `: ${ended.message}` : ""}) without asking anything`,
					);
				return undefined;
			},
			timeoutMs,
		);
	}

	/** The stored Windlass events of one type in a turn, oldest first. */
	windlass(turn: number, type: string): WindlassItem[] {
		return this.items.filter(
			(item): item is WindlassItem => item.kind === "windlass" && item.turn === turn && item.event.type === type,
		);
	}

	/** The stored Windlass events of one type about one tool call. */
	ofCall(turn: number, type: string, call: { messageId: string; callId: string }): WindlassItem[] {
		return this.windlass(turn, type).filter(
			item => item.event.data?.messageId === call.messageId && item.event.data?.callId === call.callId,
		);
	}

	/** The statuses the session went through from the summary event at `from` on. */
	statusesFrom(from: number): string {
		return this.summaries
			.slice(from)
			.map(summary => summary.status)
			.filter((status, index, all) => index === 0 || status !== all[index - 1])
			.join(" > ");
	}

	ended(turn: number): Extract<TimelineItem, { kind: "turn.ended" }> | undefined {
		return this.items.find(
			(item): item is Extract<TimelineItem, { kind: "turn.ended" }> => item.kind === "turn.ended" && item.turn === turn,
		);
	}

	async untilEnded(turn: number, timeoutMs = TURN_MS): Promise<Extract<TimelineItem, { kind: "turn.ended" }>> {
		const ended = await waitFor(`turn ${turn} to end`, () => this.ended(turn), timeoutMs);
		await waitFor(`the session to be idle after turn ${turn}`, () => this.summaries.at(-1)?.status === "idle", 15_000);
		return ended;
	}

	statuses(): string {
		return this.summaries
			.map(summary => summary.status)
			.filter((status, index, all) => index === 0 || status !== all[index - 1])
			.join(" > ");
	}
}

function plain(value: unknown): string {
	return JSON.stringify(value);
}

/** Checks that seqs are 1, 2, 3, ... with no gap and no repeat. */
function dense(items: TimelineItem[], from = 1): void {
	items.forEach((item, index) => {
		assert(item.seq === from + index, `seq ${item.seq} at position ${index}, expected ${from + index}`);
	});
}

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

/** Two live launches contend for the last slot while the first is still waiting for its meter. */
async function runningSlotRace(server: Server, client: Client, auth: AuthResult, profile: string): Promise<void> {
	await check(
		"a late idle report during a slow reserve cannot give the last running slot to two launches",
		async () => {
			const uid = auth.profile.uid;
			const params = { token: auth.token };
			const user = client.user.getOrCreate([uid], { params });
			const service = await serviceUser(server, uid);
			const sessions = await Promise.all(
				Array.from({ length: RUNNING_CEILING + 1 }, (_, i) =>
					user.createSession({ profile: profile as SessionSummary["profile"], title: `Racing launch ${i}` }),
				),
			);
			const handles = sessions.map(one => client.agentSession.get([uid, one.id], { params }));
			const last = RUNNING_CEILING - 1;
			try {
				await Promise.all(handles.slice(0, last).map(one => one.prompt({ text: "Run the long build (slow)" })));
				const launch = handles[last].prompt({ text: "Run the long build (slow)" });
				try {
					await waitFor(
						"the last slot to be claimed",
						async () =>
							(await user.listSessions()).some(one => one.id === sessions[last].id && one.status === "starting"),
						10_000,
						25,
					);
					const stale = (await handles[last].snapshot()).summary;
					assert(stale.status === "idle" && stale.turns === 0, "the meter had already answered");
					await service.internalSessionChanged(stale);
					await refused(() => handles[last + 1].prompt({ text: "One too many" }), "too_many_running");
				} finally {
					await launch;
				}
				assert((await handles[last + 1].snapshot()).summary.turns === 0, "the fourth session started a turn");
				return "three launches admitted, the fourth refused before its first turn";
			} finally {
				await Promise.all(sessions.map(one => user.deleteSession(one.id)));
			}
		},
	);
}

const loginOrigin = "http://localhost:5173";

async function identityChecks(client: Client, server: Server, github: GithubStandin) {
	await check("login requests share address and deployment budgets before attempt allocation", async () => {
		const remaining = 60_000 - (Date.now() % 60_000);
		if (remaining < 5_000) await new Promise(done => setTimeout(done, remaining));
		const { serviceParams } = await import("../server/src/auth.js");
		const request = (step: string, ip: string) =>
			fetch(API + "/platform/login/" + step, {
				method: "POST",
				headers: { origin: loginOrigin, "content-type": "application/json", "x-test-ip": ip },
				body: JSON.stringify({
					id: step === "finish" ? "invalid!" : "budget-check",
					provider: "github",
					secret: "b".repeat(43),
				}),
			});

		for (const [step, ip, status] of [
			["finish", "192.0.2.1", 400],
			["finish", "192.0.2.1", 400],
			["start", "192.0.2.1", 429],
			["finish", "192.0.2.2", 400],
			["finish", "192.0.2.3", 400],
			["start", "192.0.2.4", 429],
		] as const) {
			const response = await request(step, ip);
			assert(response.status === status, `login budget for ${ip}: expected ${status}, got ${response.status}`);
		}
		await refused(() => client.login.get(["budget-check"], { params: serviceParams() }).demo(), "not_found");
		return "429 for both ceilings, refused requests created no attempt actor";
	});
	await server.stop();
	await server.start({ ...github.env(), WLP_ITEMS: "1" });
	const userOf = (auth: AuthResult) => client.user.get([auth.profile.uid], { params: { token: auth.token } });
	const signIn = async (name: string, auth?: AuthResult) => {
		const login = loginHttp(API);
		const { url } = await login.start("github", auth);
		return login.finish(github.authorize(name, url), auth);
	};
	const { issueUserToken } = await import("../server/src/tokens.js");
	const profile = { uid: "u_owner", email: "owner@example.invalid", demo: false };
	const owner = { profile, token: issueUserToken(profile, 0) };
	await client.user.getOrCreate([profile.uid], { params: { token: owner.token } }).me();
	const original = github.addUser("my-sub");
	original.emails = [{ email: profile.email, primary: true, verified: true }];
	github.addUser("their-sub").emails = original.emails;

	await check("an existing session explicitly links GitHub and an unlinked identity gets a fresh uid", async () => {
		assert((await signIn("my-sub", owner)).profile.uid === profile.uid, "link changed owner");
		const [linked] = await userOf(owner).linkedLogins();
		assert(linked?.provider === "github" && linked.display === "my-sub", "link lost the GitHub login");
		assert((await signIn("my-sub")).profile.uid === profile.uid, "linked login lost owner");
		const fresh = await signIn("their-sub");
		assert(fresh.profile.uid !== profile.uid && fresh.profile.email === null, "email selected an account");
		assert((await signIn("their-sub")).profile.uid === fresh.profile.uid, "fresh uid was unstable");
		await refused(() => signIn("their-sub", owner), "identity_linked");
		assert(
			!github.requests.some(r => r.path.includes("/user/emails")),
			"login requested email without email admission",
		);
		await refused(() => userOf(owner).unlinkLogin("github"), "last_login");
		return "owner retained, matching email created a distinct user, last method retained";
	});

	await check("pending provider attempts are immutable and require the starting browser", async () => {
		const login = loginHttp(API);
		const started = await login.start("github");
		await refused(() => login.start("github"), "attempt_started");
		const callback = github.authorize("my-sub", started.url);
		await refused(() => login.finish(callback, undefined, ""), "bad_browser");
		assert((await login.finish(callback)).profile.uid === profile.uid, "original browser lost the attempt");
		return "second start refused, original secret completed the original attempt";
	});

	await check("a pending link requires the original signed-in owner; five failures close an attempt", async () => {
		const other = await signIn("their-sub");
		const login = loginHttp(API);
		const { url } = await login.start("github", owner);
		const callback = github.authorize("my-sub", url);
		await refused(() => login.finish(callback), "wrong_account");
		await refused(() => login.finish(callback, other), "wrong_account");
		for (let i = 0; i < 3; i++) await refused(() => login.finish(callback, owner, ""), "bad_browser");
		await refused(() => login.finish(callback, owner), "attempt_locked");
		return "owner and browser checked before exchange; failure cap enforced";
	});

	await check("ChatGPT connects to the authenticated uid only", async () => {
		const auth = await signIn("my-sub");
		const user = userOf(auth);
		await refused(() => client.user.get([auth.profile.uid]).approvePlanConnect("KQ2M-8XF4", "openai"), "unauthorized");
		const { fakeSignInFiles } = await import("../server/src/sandbox-fake.js");
		await connectChatgpt(API, user, { files: fakeSignInFiles("plan") });
		assert((await user.chatgpt()).email === "plan@example.com", "model grant missing");
		assert(
			(await user.me()).uid === "u_owner" && (await user.me()).email === auth.profile.email,
			"model grant changed profile",
		);
		await user.forgetChatgpt();
		assert(
			!(await user.chatgpt()).connected && (await user.me()).uid === "u_owner",
			"disconnect changed platform session",
		);
		return "model grant attached and removed, same uid and session";
	});

	await check("sign out everywhere revokes both sign-ins and direct session access", async () => {
		const first = await signIn("my-sub");
		const second = await signIn("my-sub");
		const other = await signIn("their-sub");
		const session = await userOf(first).createSession({ profile: "docker-windlass-sandbox" });
		const direct = client.agentSession.get([first.profile.uid, session.id], { params: { token: first.token } });
		const userSocket = userOf(first).connect();
		const sessionSocket = direct.connect();
		try {
			userSocket.onError(() => {});
			sessionSocket.onError(() => {});
			userSocket.on("sessions", () => {});
			sessionSocket.on("summary", () => {});
			await withTimeout(
				"open the user and session subscriptions",
				Promise.all([userSocket.me(), sessionSocket.snapshot()]),
				10_000,
			);
			// Stop each subscription on its first server disconnect, before the client reconnects with the revoked token.
			const closed = [userSocket, sessionSocket].map(
				socket =>
					new Promise<void>((resolve, reject) => {
						socket.onClose(() => socket.dispose().then(resolve, reject));
					}),
			);
			await withTimeout(
				"sign out and close both subscriptions",
				Promise.all([userOf(second).signOutEverywhere(), ...closed]),
				15_000,
			);
		} catch (error) {
			await withTimeout(
				"dispose the user and session subscriptions",
				Promise.all([userSocket.dispose(), sessionSocket.dispose()]),
				10_000,
			);
			throw error;
		}
		await refused(() => userOf(first).me(), "invalid_token");
		await refused(() => userOf(second).me(), "invalid_token");
		await refused(() => direct.snapshot(), "invalid_token");
		await userOf(other).me();
		const fresh = await signIn("my-sub");
		await userOf(fresh).deleteSession(session.id);
		return "both browsers refused, other account kept, new login works";
	});

	await check("sign out everywhere can revoke every API token of just this user", async () => {
		const owner = await signIn("my-sub");
		const other = await signIn("their-sub");
		const mint = async (auth: AuthResult, name: string) =>
			(await userOf(auth).createApiToken({ name, scopes: ["items:read"] })).secret;
		const status = async (token: string) =>
			(await fetch(API + "/api/items/missing", { headers: { authorization: "Bearer " + token } })).status;
		const a = await mint(owner, "one");
		const b = await mint(owner, "two");
		const theirs = await mint(other, "other");
		await userOf(owner).signOutEverywhere({ revokeApiTokens: false });
		assert((await status(a)) === 404, "opting out revoked an API token");
		await userOf(await signIn("my-sub")).signOutEverywhere({ revokeApiTokens: true });
		for (const token of [a, b]) assert((await status(token)) === 401, "the API still accepted a revoked token");
		assert((await status(theirs)) === 404, "another user's API token was revoked");
		return "opt-out preserved tokens, opt-in returned HTTP 401 for both, other account kept access";
	});

	await check("admin revocation targets one uid and survives restart", async () => {
		const auth = await signIn("my-sub");
		const uid = auth.profile.uid;
		const { issueServiceToken } = await import("../server/src/tokens.js");
		await refused(() => userOf(auth).internalRevokeTokens(), "forbidden");
		await refused(
			() => client.user.get([uid], { params: { token: issueServiceToken("revoke:other") } }).internalRevokeTokens(),
			"forbidden",
		);
		const { stdout } = await promisify(execFile)(
			process.execPath,
			["--import", "tsx", "src/revoke-user-tokens.ts", uid],
			{
				cwd: SERVER_DIR,
				env: { ...process.env, WLP_SECRET: server.secret, RIVET_ENGINE: ENDPOINT },
				encoding: "utf8",
				timeout: 30_000,
			},
		);
		assert(stdout.includes(uid), "the revoke command did not acknowledge its uid");
		await server.stop();
		await server.start({ ...github.env(), WLP_ITEMS: "1" });
		await refused(() => userOf(auth).me(), "invalid_token");
		await userOf(await signIn("my-sub")).me();
		return "old generation still refused after restart";
	});

	await check("email grants admission only and the optional GitHub permission has a specific diagnostic", async () => {
		await server.stop();
		await server.start({ ...github.env(), WLP_ALLOWED_USERS: profile.uid, WLP_ALLOWED_EMAILS: profile.email });
		github.addUser("invited").emails = original.emails;
		const admitted = await signIn("invited");
		assert(
			admitted.profile.email === profile.email && admitted.profile.uid !== profile.uid,
			"email selected the owner uid",
		);
		github.emailPermission = false;
		try {
			assert((await signIn("my-sub")).profile.uid === profile.uid, "UID admission required email permission");
			const message = await refused(() => signIn("invited"), "email_permission");
			assert(message === "The GitHub App needs the Email addresses permission", "missing permission diagnostic");
			assert(!server.output.includes("sensitive@example.invalid"), "provider text entered the server log");
			await fetch(API + "/signin?code=callback-log-canary&state=state-log-canary");
			assert(
				!server.output.includes("callback-log-canary") && !server.output.includes("state-log-canary"),
				"callback query entered the log",
			);
		} finally {
			github.emailPermission = true;
		}
		return "verified matching email admitted a new UID, 403 kept UID access and explained email admission";
	});

	await check("operator recovery binds an existing uid to the configured instance", async () => {
		const replacement = new GithubStandin({ callbackUrl: loginOrigin + "/signin" });
		await replacement.start();
		try {
			const sameId = replacement.addUser("enterprise-owner");
			assert(sameId.id === original.id, "fixture needs equal numeric IDs");
			await server.stop();
			const env = {
				...replacement.env(),
				WLP_ITEMS: "1",
				WLP_GOOGLE_CLIENT_ID: "test",
				WLP_GOOGLE_CLIENT_SECRET: "test",
			};
			await server.start(env);
			const login = loginHttp(API);
			const { url } = await login.start("github");
			const fresh = await login.finish(replacement.authorize("enterprise-owner", url));
			assert(fresh.profile.uid !== profile.uid, "foreign instance selected the old uid");
			const recovery = replacement.addUser("recovery");
			const recover = (uid: string, provider: string, id: string) =>
				promisify(execFile)(
					process.execPath,
					["--import", "tsx", "src/link-identity.ts", "--uid", uid, "--provider", provider, "--id", id],
					{ cwd: SERVER_DIR, env: { ...process.env, ...env, RIVET_ENGINE: ENDPOINT }, timeout: 30_000 },
				);
			await recover(profile.uid, "github", String(recovery.id));
			const recovered = loginHttp(API);
			const start = await recovered.start("github");
			const auth = await recovered.finish(replacement.authorize("recovery", start.url));
			assert(auth.profile.uid === profile.uid, "server recovery did not restore the owner");
			await recover(profile.uid, "google", "operator-verified-sub");
			await userOf(auth).unlinkLogin("github");
			const remaining = await userOf(auth).linkedLogins();
			assert(
				remaining.length === 1 && remaining[0].provider === "google" && remaining[0].display === null,
				"unlink removed the wrong method",
			);
			await refused(() => userOf(auth).unlinkLogin("google"), "last_login");
			return "same numeric ID isolated, signed-out owner recovered, another method required for unlink";
		} finally {
			await replacement.stop();
		}
	});
}

/** A prompt whose turn asks before it runs a command: both layers choose that scenario by these words. */
const ASK = "Fetch the response headers of example.com";
/** A prompt whose turn runs one command for a while: the turn to steer, and to stop one call of. */
const LONG = "Run the long build and report its progress (slow)";

async function main(server: Server | null): Promise<void> {
	const client = newClient();
	const attempt = () => `e2e-${randomBytes(8).toString("hex")}`;
	const demoSignIn = async (id = attempt()): Promise<AuthResult> => {
		const result = await loginHttp(API, loginOrigin, id).demo();
		demoUids.push(result.profile.uid);
		return result;
	};

	if (server && (githubOnly || section === "usage" || section === "resume")) {
		try {
			const info = (await (await platformInfo()).json()) as import("../server/src/contract.js").PlatformInfo;
			const profile = info.profiles.find(p => p.available)!.id;
			if (githubOnly) {
				await githubChecks(server, client, demoSignIn, profile);
			} else {
				// The full run reaches these restarts after switching to the short sign-in TTL.
				loginTtlMs = SHORT_LOGIN_TTL_MS;
				const user = await demoSignIn();
				if (section === "usage") await usageAndIdleChecks(server, client, user, profile, demoSignIn);
				else await resumeChecks(server, client, user.profile.uid, user.token, profile, LONG);
			}
		} finally {
			await client.dispose();
		}
		return;
	}

	// --- platform ---------------------------------------------------------------------------------

	let availableProfile = "docker-windlass-sandbox";
	/** Whether that profile holds every command of the agent in Windlass's sandbox: there the account's secrets are given to MCP servers. */
	let commandsSandboxed = true;
	let models: string[] = [];
	await check("platform info over HTTP, from any server, with no actor", async () => {
		const response = await platformInfo();
		assert(response.ok, `GET /platform/info answered ${response.status}`);
		assert(
			response.headers.get("content-type")?.startsWith("application/json"),
			`content-type is ${response.headers.get("content-type")}`,
		);
		const info = (await response.json()) as import("../server/src/contract.js").PlatformInfo;
		assert(info.demoEnabled === true, "demoEnabled is not true: start the server with WLP_DEMO=1");
		const [first] = info.profiles;
		assert(first, "no available profile");
		assert(
			info.profiles.every(profile => profile.available && profile.unavailableReason === undefined),
			`unavailable profile in platform info: ${plain(info.profiles)}`,
		);
		// The models are each user's own (`user.models`): the deployment names none.
		assert(
			!("models" in info) && !("efforts" in info),
			`the platform's information still names models or efforts: ${plain(Object.keys(info))}`,
		);
		if (!FAKE)
			assert(
				typeof info.windlassVersion === "string" && info.windlassVersion !== "",
				"windlassVersion is null: is the sandbox image built?",
			);
		availableProfile = first.id;
		commandsSandboxed = first.approval === "auto" && !first.commandNetwork && !first.commandsCanReadAccessToken;
		if (OWN_SERVER) {
			// The information is no actor's: none named "platform" exists, whoever asked.
			const listed = (await (await controlPlane("/actors?namespace=default&name=platform")).json()) as {
				actors?: unknown[];
			};
			assert((listed.actors ?? []).length === 0, `the control plane lists ${listed.actors?.length} platform actors`);
		}
		const health = await fetch(`${API}/health`);
		assert(health.ok, `GET /health answered ${health.status}`);
		assert((await fetch(`${API}/nothing-here`)).status === 404, "an unknown path did not answer 404");
		return `windlass ${info.windlassVersion}, ${info.profiles.length} available profiles; /health ${health.status}`;
	});

	await check("platform info: only the web app's origin may read it", async () => {
		const evil = await platformInfo("http://evil.example");
		assert(evil.status === 403, `a page on another site got ${evil.status}`);
		const body = (await evil.json()) as { group?: string; code?: string; message?: string };
		assert(
			body.group === "user" &&
				body.code === "origin_not_allowed" &&
				body.message === "This origin is not allowed to connect.",
			`refused with ${plain(body)}`,
		);
		assert(evil.headers.get("access-control-allow-origin") === null, "the refusal carries a CORS header");
		const good = await platformInfo("http://localhost:5173");
		assert(
			good.ok && good.headers.get("access-control-allow-origin") === "http://localhost:5173",
			`the web app's origin got ${good.status}, CORS ${good.headers.get("access-control-allow-origin")}`,
		);
		const preflight = await fetch(`${API}/platform/info`, {
			method: "OPTIONS",
			headers: { Origin: "http://127.0.0.1:5173", "Access-Control-Request-Method": "GET" },
		});
		assert(
			preflight.status === 204 && preflight.headers.get("access-control-allow-origin") === "http://127.0.0.1:5173",
			`preflight answered ${preflight.status}`,
		);
		const none = await platformInfo();
		assert(
			none.ok && none.headers.get("access-control-allow-origin") === null,
			"a client without an origin was not let through plainly",
		);
		return "another site 403 origin_not_allowed; the web app's origins allowed with CORS; no origin allowed";
	});

	if (OWN_SERVER) {
		await check("with a remote engine and no WLP_SECRET the server refuses to start, in one sentence", async () => {
			const { code, output } = await startRefused(env => {
				env.RIVET_ENDPOINT = "http://e2e-namespace:sk_e2e_made_up@127.0.0.1:9";
				delete env.WLP_SECRET;
			});
			assert(code === 1, `the server exited with ${code}: ${output.slice(-500)}`);
			const lines = output.trim().split("\n");
			assert(
				lines.length === 1 &&
					lines[0].startsWith("[wlp] WLP_SECRET is not set:") &&
					lines[0].endsWith("on all of them."),
				`it said: ${output.slice(0, 600)}`,
			);
			assert(!output.includes("sk_e2e_made_up"), "the output shows the engine's token");
			assert(await portFree(refusalPort), "it bound its HTTP port before refusing");
			return lines[0];
		});
	} else {
		skip(
			"with a remote engine and no WLP_SECRET the server refuses to start, in one sentence",
			"needs to start a server",
		);
	}

	// --- sign-in ----------------------------------------------------------------------------------

	let a: AuthResult | null = null;
	let b: AuthResult | null = null;
	await check("demo sign-in", async () => {
		a = await demoSignIn();
		b = await demoSignIn();
		assert(/^demo_[0-9a-f]{12}$/.test(a.profile.uid), `uid is ${a.profile.uid}`);
		assert(a.profile.demo === true && a.profile.email === null, "profile is not a demo profile");
		assert(a.profile.uid !== b.profile.uid, "two demo sign-ins gave the same uid");
		assert(typeof a.token === "string" && a.token.split(".").length === 4, "the token has an unexpected shape");
		const me = await client.user.getOrCreate([a.profile.uid], { params: { token: a.token } }).me();
		assert(plain(me) === plain(a.profile), `user.me() is ${plain(me)}`);
		const chatgpt = await client.user.getOrCreate([a.profile.uid], { params: { token: a.token } }).chatgpt();
		assert(chatgpt.connected === false, "a demo user is reported as connected to ChatGPT");
		// The demo's scripted model answers under any name: its list is the stand-in, and says so.
		const list = await client.user.getOrCreate([a.profile.uid], { params: { token: a.token } }).models();
		assert(
			list.source === "demo" &&
				list.fetchedAt === null &&
				list.models.length >= 1 &&
				list.defaultModel === list.models[0]!.id &&
				list.models.every(model => model.efforts.length > 0),
			`a demo user's models are ${plain(list)}`,
		);
		models = list.models.map(model => model.id);
		return a.profile.uid;
	});
	if (!a || !b) throw new Error("no demo users: the remaining checks cannot run");
	const userA: AuthResult = a;
	const userB: AuthResult = b;
	const uid = userA.profile.uid;
	const token = userA.token;
	const userHandle = client.user.getOrCreate([uid], { params: { token } });

	if (idleOnly && server) {
		await idleChecks(server, client, uid, token, availableProfile, ASK, LONG);
		await client.dispose().catch(() => undefined);
		return;
	}
	if (resumeOnly && server) {
		await resumeChecks(server, client, uid, token, availableProfile, LONG);
		await client.dispose().catch(() => undefined);
		return;
	}

	// --- authentication ---------------------------------------------------------------------------

	await check("auth: a call without a token is rejected", async () => {
		await refused(() => client.user.getOrCreate([uid]).me(), "unauthorized");
		await refused(() => client.user.getOrCreate([uid], { params: {} }).listSessions(), "unauthorized");
		return "stateless action";
	});
	await check("auth: a tampered token is rejected", async () => {
		const [version, kid, payload, signature] = token.split(".");
		const forgedPayload = Buffer.from(
			JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), uid: userB.profile.uid }),
			"utf8",
		).toString("base64url");
		const flipped = `${version}.${kid}.${payload}.${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
		await refused(() => client.user.getOrCreate([uid], { params: { token: flipped } }).me(), "invalid_token");
		await refused(
			() =>
				client.user
					.getOrCreate([userB.profile.uid], { params: { token: `${version}.${kid}.${forgedPayload}.${signature}` } })
					.me(),
			"invalid_token",
		);
		await refused(() => client.user.getOrCreate([uid], { params: { token: "v1.e30.x" } }).me(), "invalid_token");
		return "flipped signature, swapped payload, garbage";
	});
	await check("auth: user A's token against user B's key is rejected", async () => {
		await refused(
			() => client.user.getOrCreate([userB.profile.uid], { params: { token } }).listSessions(),
			"forbidden",
		);
		await refused(
			() =>
				client.user
					.getOrCreate([userB.profile.uid], { params: { token } })
					.createSession({ profile: availableProfile as never }),
			"forbidden",
		);
		return "user actor";
	});
	await check("auth: a WebSocket connection is rejected the same way", async () => {
		for (const [params, code] of [
			[undefined, "unauthorized"],
			[{ token: `${token}x` }, "invalid_token"],
		] as const) {
			const conn = client.user.getOrCreate([uid], { params }).connect();
			conn.onError(() => undefined);
			try {
				await refused(() => withTimeout("an action over a rejected connection", conn.me(), 10_000), code);
			} finally {
				await conn.dispose().catch(() => undefined);
			}
		}
		const wrong = client.user.getOrCreate([userB.profile.uid], { params: { token } }).connect();
		wrong.onError(() => undefined);
		try {
			await refused(() => withTimeout("an action over a rejected connection", wrong.me(), 10_000), "forbidden");
		} finally {
			await wrong.dispose().catch(() => undefined);
		}
		return "no token, bad token, another user's key";
	});
	await check("auth: internal actions refuse a user's token", async () => {
		const fake: SessionSummary = {
			id: "s_x",
			capabilities: sessionCapabilities("windlass"),
			title: "x",
			place: { kind: "hosted" },
			profile: "docker-hardened",
			model: "m",
			mode: "full",
			availableModes: [],
			repoUrl: null,
			createdAt: 0,
			updatedAt: 0,
			status: "idle",
			turns: 0,
			lastOutcome: null,
			sandbox: "none",
		};
		await refused(() => userHandle.internalSessionChanged(fake), "forbidden");
		await refused(() => userHandle.internalAcquireRun("s_x"), "forbidden");
		await refused(() => userHandle.internalReleaseRun({ sessionId: "s_x", claim: 1, summary: fake }), "forbidden");
		return "user.internalSessionChanged, user.internalAcquireRun, user.internalReleaseRun";
	});
	await check("auth: idle cleanup removes only the unclaimed user actor", async () => {
		const stranger = `u_${randomBytes(10).toString("hex")}`;
		await refused(() => client.user.getOrCreate([stranger]).me(), "unauthorized");
		await waitFor(
			"the empty user actor to be removed",
			async () => {
				try {
					// Looking up the key lets the unused actor go idle.
					await client.user.get([stranger]).resolve();
					return false;
				} catch (error) {
					return (error as { code?: string }).code === "not_found";
				}
			},
			60_000,
			500,
		);
		// B signed in but has only received refused calls so far. Its original actor must still exist.
		await client.user.get([userB.profile.uid], { params: { token: userB.token } }).me();
		return "unclaimed actor removed, signed-in user kept";
	});
	await check("auth: a session cannot be created around the user actor", async () => {
		const forged = `s_${randomBytes(8).toString("hex")}`;
		const input = {
			grant: token,
			title: "forged",
			titleIsTyped: true,
			profile: availableProfile,
			model: models[0],
			repoUrl: null,
			demo: true,
			createdAt: Date.now(),
		};
		try {
			const handle = await client.agentSession.create([uid, forged], { input: input as never, params: { token } });
			await handle.snapshot();
			throw new Error("the forged session answered a snapshot");
		} catch (error) {
			const code = (error as { code?: string }).code;
			assert(
				code === "session_not_found" || code === "not_found" || code === "destroying" || code === "destroyed",
				`unexpected: ${describe(error)}`,
			);
		}
		await waitFor(
			"the forged session actor to be removed",
			async () => {
				try {
					await client.agentSession.get([uid, forged], { params: { token } }).snapshot();
					return false;
				} catch (error) {
					return (error as { code?: string }).code === "not_found";
				}
			},
			10_000,
			200,
		);
		return "actor without a grant removed itself";
	});
	await check("origin: only the web app's origin may connect", async () => {
		const evil = newClient({ origin: "http://evil.example" });
		const good = newClient({ origin: "http://localhost:5173" });
		try {
			await refused(() => evil.user.getOrCreate([uid], { params: { token } }).me(), "origin_not_allowed");
			await refused(() => loginHttp(API, "http://evil.example").start("github"), "origin_not_allowed");
			await good.user.getOrCreate([uid], { params: { token } }).me();

			webSocketOrigin = "http://evil.example";
			const conn = client.user.getOrCreate([uid], { params: { token } }).connect();
			conn.onError(() => undefined);
			try {
				await refused(
					() => withTimeout("an action over a rejected connection", conn.me(), 10_000),
					"origin_not_allowed",
				);
			} finally {
				await conn.dispose().catch(() => undefined);
			}
			webSocketOrigin = "http://127.0.0.1:5173";
			const allowed = client.user.getOrCreate([uid], { params: { token } }).connect();
			try {
				await withTimeout("an action over an allowed connection", allowed.me(), 10_000);
			} finally {
				await allowed.dispose().catch(() => undefined);
			}
		} finally {
			webSocketOrigin = null;
			await evil.dispose().catch(() => undefined);
			await good.dispose().catch(() => undefined);
		}
		return "http actions and WebSocket, allowed and not";
	});

	// --- sessions ---------------------------------------------------------------------------------

	const userConn = userHandle.connect();
	const sessionLists: SessionSummary[][] = [];
	userConn.on("sessions", (list: unknown) => {
		sessionLists.push(list as SessionSummary[]);
	});
	await userConn.me();

	await check("createSession refuses bad input", async () => {
		await refused(() => userConn.createSession({ place: null as never, profile: "docker-hardened" }), "bad_input");
		await refused(() => userConn.createSession({ profile: "nope" as never }), "bad_profile");
		await refused(() => userConn.createSession({ profile: "e2b" }), "profile_unavailable");
		await refused(() => userConn.createSession({ profile: "e2b-open" }), "profile_unavailable");
		await refused(() => userConn.createSession({ profile: availableProfile as never, model: "gpt-nope" }), "bad_model");
		for (const repoUrl of [
			"https://user:secret@github.com/a/b.git",
			"https://token@github.com/a/b.git",
			"http://github.com/a/b.git",
			"git@github.com:a/b.git",
			"https://github.com/a/b.git; rm -rf /",
			"--upload-pack=x",
		]) {
			await refused(() => userConn.createSession({ profile: availableProfile as never, repoUrl }), "bad_repo_url");
		}
		assert((await userConn.listSessions()).length === 0, "a refused createSession left a session behind");
		return "profile, model, repository address";
	});

	await check("Windlass refuses full on a command-sandbox profile at creation", async () => {
		return await refused(
			() => userConn.createSession({ profile: "docker-windlass-sandbox", mode: "full" }),
			"bad_input",
		);
	});

	for (const [profile, expected] of [
		["docker-windlass-sandbox", "auto"],
		["docker-hardened", "full"],
	] as const) {
		await check(`Windlass offers ask and ${expected} on ${profile} and validates changes`, async () => {
			const made = await userConn.createSession({ profile });
			try {
				assert(
					made.mode === expected && plain(made.availableModes.map(m => m.id)) === plain(["ask", expected]),
					plain(made),
				);
				const agent = client.agentSession.get([uid, made.id], { params: { token } });
				await refused(() => agent.setMode({ mode: expected === "auto" ? "full" : "auto" }), "bad_input");
				assert(
					(await agent.setMode({ mode: "ask" })).mode === "ask" && (await agent.snapshot()).summary.mode === "ask",
					"mode was not saved",
				);
				return `default ${expected}, saved ask`;
			} finally {
				await userConn.deleteSession(made.id);
			}
		});
	}

	let session: SessionSummary | null = null;
	await check("createSession", async () => {
		const before = sessionLists.length;
		const created = await userConn.createSession({ profile: availableProfile as never });
		assert(/^s_[0-9a-f]{16}$/.test(created.id), `id is ${created.id}`);
		assert(
			created.title === "New agent" && created.status === "idle" && created.turns === 0 && created.sandbox === "none",
			`summary is ${plain(created)}`,
		);
		assert(created.model === models[0], `model is ${created.model}, expected the default ${models[0]}`);
		session = created;
		const list = await waitFor(
			"the sessions event",
			() => (sessionLists.length > before ? sessionLists.at(-1) : undefined),
			5_000,
		);
		assert(
			list.length === 1 && list[0].id === created.id,
			`sessions event carried ${plain(list.map(entry => entry.id))}`,
		);
		assert(plain(await userConn.listSessions()) === plain([created]), "listSessions differs from the created summary");
		return `${created.id} on ${created.profile}`;
	});
	if (!session) throw new Error("no session: the remaining checks cannot run");
	const first: SessionSummary = session;
	const sid = first.id;

	await check("auth: user B cannot reach user A's session", async () => {
		await refused(
			() => client.agentSession.get([uid, sid], { params: { token: userB.token } }).snapshot(),
			"forbidden",
		);
		await refused(() => client.agentSession.get([uid, sid]).snapshot(), "unauthorized");
		await refused(() => client.agentSession.get([uid, sid], { params: { token } }).internalDestroy(), "forbidden");
		await refused(
			() => client.agentSession.get([uid, sid], { params: { token } }).internalRename("hijacked"),
			"forbidden",
		);
		return "snapshot, internalDestroy, internalRename";
	});

	const watch = new Watch(client, uid, sid, token);
	const sessionHandle = client.agentSession.get([uid, sid], { params: { token } });

	await check("snapshot of a new session", async () => {
		const snapshot = await watch.conn.snapshot();
		assert(snapshot.timeline.length === 0 && snapshot.pending.length === 0, "a new session has a timeline");
		assert(snapshot.question === null, "a new session has a pending question");
		assert(
			snapshot.profile.id === first.profile && snapshot.windlassSessionId === null,
			"profile or windlassSessionId is off",
		);
		assert(
			plain(await watch.conn.changes()) === "[]" && (await watch.conn.diff()) === "",
			"changes/diff are not empty without a sandbox",
		);
		return "empty timeline; changes() and diff() empty without a sandbox";
	});

	await check("prompt refuses bad input", async () => {
		await refused(() => watch.conn.prompt({ text: "   " }), "empty_prompt");
		await refused(() => watch.conn.prompt({ text: "x".repeat(MAX_PROMPT_CHARS + 1) }), "prompt_too_long");
		await refused(() => watch.conn.prompt({ text: "hello", effort: "extreme" }), "bad_effort");
		await refused(() => watch.conn.prompt({ text: "hello", model: "gpt-nope" }), "bad_model");
		assert(watch.items.length === 0, "a refused prompt left items in the timeline");
		return "empty, too long, effort, model";
	});

	// --- first turn -------------------------------------------------------------------------------

	const promptOne = "Write a small Python program that prints prime numbers, then run it";
	await check("prompt: returns at once and the turn streams to its end", async () => {
		const started = Date.now();
		const { turn, steered } = await watch.conn.prompt({ text: promptOne, effort: "low" });
		const took = Date.now() - started;
		assert(turn === 1 && steered === false, `prompt() returned ${plain({ turn, steered })}`);
		const ended = await watch.untilEnded(1);
		assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
		assert(took < 15_000, `prompt() took ${took} ms to return`);
		return `prompt() returned in ${took} ms; turn took ${Date.now() - started} ms; ${watch.items.length} items, ${watch.deltas.length} deltas; exit code ${ended.exitCode}, steps ${ended.steps}`;
	});
	await check("prompt: items arrive in seq order, deltas in between", async () => {
		dense(watch.items);
		const [user] = watch.items;
		assert(
			user.kind === "user" && user.text === promptOne && user.effort === "low" && user.turn === 1,
			`first item is ${plain(user).slice(0, 200)}`,
		);
		assert(watch.items.at(-1)?.kind === "turn.ended", "the last item is not turn.ended");
		assert(watch.items.filter(item => item.kind === "turn.ended").length === 1, "more than one turn.ended");
		assert(
			watch.items.some(item => item.kind === "platform" && item.text.startsWith("Starting a hosted sandbox")),
			'no "Starting a hosted sandbox" item',
		);
		const windlass = watch.items.filter(item => item.kind === "windlass");
		assert(windlass.length > 5, `only ${windlass.length} windlass items`);
		assert(watch.deltas.length > 0, "no delta events");
		assert(
			watch.deltas.every(
				delta =>
					delta.turn === 1 &&
					["text.delta", "reasoning.delta", "tool.input.delta", "tool.progress"].includes(delta.event.type),
			),
			"a delta of another kind or turn",
		);
		assert(
			!windlass.some(
				item =>
					item.kind === "windlass" &&
					["text.delta", "reasoning.delta", "tool.input.delta", "tool.progress"].includes(item.event.type),
			),
			"a delta was stored as an item",
		);
		const firstDelta = watch.order.indexOf("d");
		const lastDelta = watch.order.lastIndexOf("d");
		assert(
			firstDelta > watch.order.indexOf("i1") && lastDelta < watch.order.length - 1,
			"deltas arrived outside the turn's items",
		);

		// Each finished text must equal the deltas that streamed before it, which holds only if nothing was lost or reordered.
		let texts = 0;
		const streamed = new Map<string, string>();
		let cursor = 0;
		for (const entry of watch.order) {
			if (entry === "d") {
				const { event } = watch.deltas[cursor];
				cursor += 1;
				if (event.type === "text.delta")
					streamed.set(String(event.messageId), (streamed.get(String(event.messageId)) ?? "") + String(event.text));
				continue;
			}
			const item = watch.items.find(candidate => `i${candidate.seq}` === entry);
			if (item?.kind === "windlass" && item.event.type === "text.ended") {
				const messageId = String(item.event.data?.messageId);
				assert(streamed.get(messageId) === item.event.data?.text, `text.ended of ${messageId} differs from its deltas`);
				streamed.delete(messageId);
				texts += 1;
			}
		}
		assert(texts > 0, "no text.ended to compare with its deltas");
		return `${windlass.length} windlass items, ${texts} texts equal to their deltas, statuses ${watch.statuses()}`;
	});
	await check("prompt: summary follows the turn", async () => {
		const last = watch.summaries.at(-1);
		assert(last, "no summary event");
		assert(watch.statuses() === "starting > running > idle", `statuses were ${watch.statuses()}`);
		assert(
			last.turns === 1 && last.lastOutcome === "succeeded" && last.sandbox === "running",
			`summary is ${plain(last)}`,
		);
		assert(last.title === promptOne, `title is "${last.title}"`);
		assert(last.updatedAt > first.updatedAt, "updatedAt did not move");
		const listed = await waitFor(
			"the user's list to show the turn",
			async () => {
				const [entry] = await userConn.listSessions();
				return entry.turns === 1 && entry.status === "idle" ? entry : undefined;
			},
			5_000,
		);
		assert(plain(listed) === plain(last), `user's list has ${plain(listed)}`);
		assert(
			sessionLists.some(list => list[0]?.status !== "idle"),
			"the user's sessions event never showed the session as busy",
		);
		return `title "${last.title}"; the user's list followed`;
	});

	let afterOne: SessionSnapshot | null = null;
	await check("snapshot returns the same timeline", async () => {
		const snapshot = await sessionHandle.snapshot();
		assert(
			plain(snapshot.timeline) === plain(watch.items),
			`snapshot has ${snapshot.timeline.length} items, the events gave ${watch.items.length}`,
		);
		assert(snapshot.pending.length === 0, "pending is not empty after the turn");
		assert(
			typeof snapshot.windlassSessionId === "string" && snapshot.windlassSessionId.startsWith("ses_"),
			`windlassSessionId is ${snapshot.windlassSessionId}`,
		);
		assert(
			plain(snapshot.summary) === plain(watch.summaries.at(-1)),
			"snapshot.summary differs from the last summary event",
		);
		afterOne = snapshot;
		return `${snapshot.timeline.length} items, ${snapshot.windlassSessionId}`;
	});

	await check("changes and diff show the workspace", async () => {
		const changes = await watch.conn.changes();
		assert(changes.length > 0, "no changed files after a turn that writes one");
		assert(
			changes.every(file => file.status.length === 2 && file.path !== ""),
			`odd entries: ${plain(changes)}`,
		);
		const diff = await watch.conn.diff();
		assert(diff.includes(`+++ b/${changes[0].path}`), `the diff does not mention ${changes[0].path}`);
		return `${changes.map(file => `${file.status} ${file.path}`).join(", ")}; diff ${diff.length} chars`;
	});

	// --- second turn ------------------------------------------------------------------------------

	await check("a second prompt continues the session", async () => {
		const { turn } = await watch.conn.prompt({ text: "Explore the workspace and describe what is there" });
		assert(turn === 2, `turn is ${turn}`);
		const ended = await watch.untilEnded(2);
		assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
		dense(watch.items);
		const second = watch.items.filter(item => item.turn === 2);
		assert(
			second[0].kind === "user" && second.at(-1)?.kind === "turn.ended",
			"turn 2 does not run from its user item to its turn.ended",
		);
		// A prompt that names no effort keeps the one turn 1 chose.
		const [secondPrompt] = second;
		assert(secondPrompt?.kind === "user" && secondPrompt.effort === "low", `turn 2's prompt is ${plain(secondPrompt)}`);
		assert(
			!second.some(item => item.kind === "platform" && item.text.startsWith("Starting a hosted sandbox")),
			"turn 2 created a sandbox again",
		);
		const snapshot = await sessionHandle.snapshot();
		assert(
			snapshot.windlassSessionId === afterOne?.windlassSessionId,
			`Windlass session changed from ${afterOne?.windlassSessionId} to ${snapshot.windlassSessionId}`,
		);
		assert(plain(snapshot.timeline) === plain(watch.items), "snapshot differs from the events");
		assert(
			snapshot.summary.turns === 2 && snapshot.summary.title === watch.summaries[0].title,
			"turns or title are off",
		);
		assert(snapshot.summary.effort === "low", `the session's effort is ${plain(snapshot.summary.effort)}`);
		const sessionIds = new Set(
			second.flatMap(item =>
				item.kind === "windlass" && typeof item.event.sessionId === "string" ? [item.event.sessionId] : [],
			),
		);
		assert(
			sessionIds.size === 1 && sessionIds.has(String(afterOne?.windlassSessionId)),
			`turn 2's events carry sessions ${[...sessionIds].join(", ")}`,
		);
		return `${second.length} items in turn 2, same Windlass session, title unchanged`;
	});

	// --- stop -------------------------------------------------------------------------------------

	// (A second prompt during a turn used to be refused here. It steers the turn now: see the steering checks.)
	await check("a snapshot taken mid-turn carries what streamed; stop() ends the turn as interrupted", async () => {
		const deltasBefore = watch.deltas.length;
		// Null is the model's default, chosen: the session forgets turn 1's effort.
		const { turn, steered } = await watch.conn.prompt({ text: "Fix the failing test (slow)", effort: null });
		assert(turn === 3 && steered === false, `prompt() returned ${plain({ turn, steered })}`);

		// A client that connects now must be able to catch up: what streamed so far is in `pending`.
		await waitFor("the turn to stream", () => watch.deltas.length > deltasBefore, TURN_MS);
		let sawPending = 0;
		// Texts arrive whole in the demo, so what stays pending for a while is a running command's output:
		// keep looking until one shows, for as long as the turn runs.
		for (let tries = 0; tries < 400 && sawPending === 0; tries += 1) {
			const live = await sessionHandle.snapshot();
			assert(
				live.pending.every(delta => delta.turn === 3),
				"pending holds deltas of another turn",
			);
			if (live.summary.status === "idle") break;
			sawPending = live.pending.length;
			if (sawPending === 0) await sleep(40);
		}
		assert(sawPending > 0, "no snapshot taken during the turn had anything in pending");

		await watch.conn.stop();
		const ended = await watch.untilEnded(3);
		assert(ended.outcome === "interrupted", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
		assert(
			watch.summaries.some(summary => summary.status === "stopping"),
			"status never became stopping",
		);
		const userItems = watch.items.filter(item => item.turn === 3 && item.kind === "user");
		assert(userItems.length === 1, "turn 3 has more than its one user item");
		const [thirdPrompt] = userItems;
		assert(thirdPrompt?.kind === "user" && thirdPrompt.effort === null, "turn 3 did not run at the default effort");
		const after = await sessionHandle.snapshot();
		assert(
			after.pending.length === 0 &&
				after.question === null &&
				after.summary.status === "idle" &&
				after.summary.lastOutcome === "interrupted",
			`after the stop: ${plain(after.summary)}`,
		);
		await watch.conn.stop();
		return `${sawPending} deltas pending mid-turn; statuses ${watch.statuses()}`;
	});
	await check("the session works after a stop", async () => {
		const { turn } = await watch.conn.prompt({ text: "Write a short program" });
		const ended = await watch.untilEnded(turn);
		assert(turn === 4 && ended.outcome === "succeeded", `turn ${turn} ended ${ended.outcome}: ${ended.message ?? ""}`);
		dense(watch.items);
		return `turn ${turn} ${ended.outcome}`;
	});

	// --- rename -----------------------------------------------------------------------------------

	await check("rename", async () => {
		const lists = sessionLists.length;
		const summaries = watch.summaries.length;
		await refused(() => userConn.renameSession(sid, "   "), "bad_title");
		await refused(() => userConn.renameSession("s_0000000000000000", "x"), "session_not_found");
		const title = "  Primes,   renamed ";
		const renamed = await userConn.renameSession(sid, title);
		assert(renamed.title === title, `title is "${renamed.title}"`);
		const event = await waitFor(
			"the session's summary event",
			() => (watch.summaries.length > summaries ? watch.summaries.at(-1) : undefined),
			5_000,
		);
		assert(event.title === title, "the session's summary event has another title");
		const list = await waitFor(
			"the user's sessions event",
			() => (sessionLists.length > lists ? sessionLists.at(-1) : undefined),
			5_000,
		);
		assert(list.find(entry => entry.id === sid)?.title === title, "the sessions event has another title");
		await refused(() => userConn.renameSession(sid, "x".repeat(200)), "bad_input");
		await userConn.renameSession(sid, "Primes, renamed");
		return "explicit title preserved on both actors, overlong title refused";
	});

	// --- sleep and wake ---------------------------------------------------------------------------

	const beforeSleep = watch.items.slice();
	await check("the timeline survives an actor sleep and wake", async () => {
		await watch.conn.dispose();
		await forceSleep(sid);
		await sleep(2_500);
		const woken = await sessionHandle.snapshot();
		assert(
			plain(woken.timeline) === plain(beforeSleep),
			`after waking the timeline has ${woken.timeline.length} items, before ${beforeSleep.length}`,
		);
		assert(
			woken.summary.sandbox === "paused",
			`the sandbox is "${woken.summary.sandbox}" after a sleep, expected "paused"`,
		);
		assert(
			woken.summary.status === "idle" && woken.summary.title === "Primes, renamed" && woken.summary.turns === 4,
			`summary after waking: ${plain(woken.summary)}`,
		);
		assert(woken.windlassSessionId === afterOne?.windlassSessionId, "windlassSessionId was lost");
		const listed = await waitFor(
			"the user's list to show the paused sandbox",
			async () => {
				const entry = (await userConn.listSessions()).find(candidate => candidate.id === sid);
				return entry?.sandbox === "paused" ? entry : undefined;
			},
			5_000,
		);
		return `${woken.timeline.length} items intact; sandbox ${listed.sandbox}`;
	});

	const watchTwo = new Watch(client, uid, sid, token);
	await check("a prompt after waking resumes the sandbox and keeps counting", async () => {
		const { turn } = await watchTwo.conn.prompt({ text: "Explore the workspace again" });
		assert(turn === 5, `turn is ${turn}`);
		const ended = await watchTwo.untilEnded(5);
		assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
		dense(watchTwo.items, beforeSleep.length + 1);
		assert(
			watchTwo.items.some(item => item.kind === "platform" && item.text === "Resuming sandbox"),
			'no "Resuming sandbox" item',
		);
		assert(watchTwo.summaries.at(-1)?.sandbox === "running", "the sandbox is not running after the turn");
		const snapshot = await sessionHandle.snapshot();
		assert(
			plain(snapshot.timeline) === plain([...beforeSleep, ...watchTwo.items]),
			"snapshot differs from what was seen before and after the sleep",
		);
		return `seq continued at ${beforeSleep.length + 1}; same files: ${(await watchTwo.conn.changes()).length} changed`;
	});

	await check("an actor shutdown during a turn stops the turn and closes it as interrupted", async () => {
		const { turn } = await watchTwo.conn.prompt({ text: "Fix the failing test (slow)" });
		await waitFor("the turn to stream", () => watchTwo.deltas.some(delta => delta.turn === turn), TURN_MS);
		await forceSleep(sid);
		// The connection drops with the actor and the client reconnects, which wakes it again.
		const snapshot = await waitFor(
			"the turn to be closed",
			async () => {
				const now = await sessionHandle.snapshot().catch(() => undefined);
				return now &&
					now.summary.status === "idle" &&
					now.timeline.at(-1)?.turn === turn &&
					now.timeline.at(-1)?.kind === "turn.ended"
					? now
					: undefined;
			},
			60_000,
			300,
		);
		const last = snapshot.timeline.at(-1);
		assert(
			last?.kind === "turn.ended" && last.outcome === "interrupted",
			`the turn ended as ${plain(last).slice(0, 200)}`,
		);
		assert(
			!snapshot.timeline.some(item => item.turn === turn && item.kind === "platform" && item.level === "warn"),
			"the turn was closed by the recovery on wake, not by the shutdown itself",
		);
		assert(
			snapshot.pending.length === 0 && snapshot.summary.lastOutcome === "interrupted",
			`summary is ${plain(snapshot.summary)}`,
		);
		dense(snapshot.timeline);
		return `turn ${turn} interrupted by the shutdown; ${snapshot.timeline.length} items`;
	});

	// --- a server that dies mid-turn --------------------------------------------------------------

	const askedBeforeCrash: { id: string; turn: number; questionId: string; problem: string | null } = {
		id: "",
		turn: 0,
		questionId: "",
		problem: "the crash check did not get that far",
	};
	// A session whose turn ended with its sandbox running, so its hold is open when the server dies: the
	// sandbox-time checks after the crash. The fake layer restarts as a slow provider (state, resume, destroy), with a
	// provider's idle stop, and with its first create refused (WLP_FAKE_*, sandbox-fake.ts).
	const counted = {
		id: "",
		promptAt: 0,
		endedAt: 0,
		wokeAt: 0,
		found: -1,
		problem: "the crash check did not get that far" as string | null,
	};
	const IDLE_STOP_S = 2;
	const PROVIDER_DELAY_MS = 1_000;
	const countedUsage = async () => (await userHandle.usage()).today.find(row => row.sessionId === counted.id);
	// A second such session, woken after the restart by a prompt with nothing connected first; `logFrom` is where the restarted server's output begins.
	const promptWoken = {
		id: "",
		promptAt: 0,
		endedAt: 0,
		logFrom: 0,
		problem: "the crash check did not get that far" as string | null,
	};

	if (server) {
		await check("a turn lost to a server crash is closed as interrupted on wake", async () => {
			if (FAKE) {
				try {
					const made = await userConn.createSession({
						profile: availableProfile as never,
						title: "Counted before the crash",
					});
					const handle = client.agentSession.get([uid, made.id], { params: { token } });
					counted.promptAt = Date.now();
					const { turn } = await handle.prompt({ text: "Write a short program" });
					const ended = await waitFor(
						"its turn to end",
						async () => {
							const now = await handle.snapshot();
							const last = now.timeline.at(-1);
							return now.summary.status === "idle" && last?.kind === "turn.ended" && last.turn === turn
								? last
								: undefined;
						},
						TURN_MS,
						100,
					);
					counted.id = made.id;
					counted.endedAt = ended.at;
					counted.problem = (await countedUsage())?.heldSeconds ? null : "its hold was not open after the turn";
				} catch (error) {
					counted.problem = describe(error);
				}
				try {
					const made = await userConn.createSession({
						profile: availableProfile as never,
						title: "Woken by a prompt after the crash",
					});
					const handle = client.agentSession.get([uid, made.id], { params: { token } });
					promptWoken.promptAt = Date.now();
					const { turn } = await handle.prompt({ text: "Write a short program" });
					const ended = await waitFor(
						"its turn to end",
						async () => {
							const now = await handle.snapshot();
							const last = now.timeline.at(-1);
							return now.summary.status === "idle" && last?.kind === "turn.ended" && last.turn === turn
								? last
								: undefined;
						},
						TURN_MS,
						100,
					);
					promptWoken.id = made.id;
					promptWoken.endedAt = ended.at;
					const row = (await userHandle.usage()).today.find(entry => entry.sessionId === made.id);
					promptWoken.problem = row?.heldSeconds ? null : "its hold was not open after the turn";
				} catch (error) {
					promptWoken.problem = describe(error);
				}
			}
			const { turn } = await watchTwo.conn.prompt({ text: "Fix the failing test (slow)" });
			await waitFor("the turn to stream", () => watchTwo.deltas.some(delta => delta.turn === turn), TURN_MS);
			const seen = watchTwo.items.length;
			// A second session, waiting on a question when the server dies: see the check after this one.
			try {
				const created = await userConn.createSession({
					profile: availableProfile as never,
					title: "Asked before the crash",
				});
				askedBeforeCrash.id = created.id;
				const handle = client.agentSession.get([uid, created.id], { params: { token } });
				askedBeforeCrash.turn = (await handle.prompt({ text: ASK })).turn;
				askedBeforeCrash.questionId = (
					await waitFor("the question before the crash", async () => (await handle.snapshot()).question, TURN_MS, 100)
				).id;
				askedBeforeCrash.problem = null;
			} catch (error) {
				askedBeforeCrash.problem = describe(error);
			}
			await watchTwo.conn.dispose().catch(() => undefined);
			await userConn.dispose().catch(() => undefined);
			await server.crash();
			promptWoken.logFrom = server.output.length;
			await server.start({
				WLP_GOOGLE_CLIENT_ID: "unused-check-client",
				WLP_GOOGLE_CLIENT_SECRET: "unused-check-secret",
				WLP_LOGIN_TTL_MS: String(SHORT_LOGIN_TTL_MS),
				...(FAKE
					? {
							WLP_FAKE_PROVIDER_DELAY_MS: String(PROVIDER_DELAY_MS),
							WLP_FAKE_IDLE_STOP_MS: String(IDLE_STOP_S * 1000),
							WLP_FAKE_CREATE_FAILS: "1",
						}
					: {}),
			});
			loginTtlMs = SHORT_LOGIN_TTL_MS;
			// Woken before any other session: nothing in the new server has asked the layer for its idle stop yet.
			if (counted.problem === null) {
				await client.agentSession.get([uid, counted.id], { params: { token } }).snapshot();
				counted.wokeAt = Date.now();
				counted.found = (
					await waitFor(
						"the hold left open by the crash to be settled",
						async () => {
							const row = await countedUsage();
							return row && row.heldSeconds === 0 ? row : undefined;
						},
						20_000,
						200,
					)
				).seconds;
			}

			const snapshot = await withTimeout("the first snapshot after the restart", sessionHandle.snapshot(), 90_000);
			const last = snapshot.timeline.at(-1);
			assert(
				last?.kind === "turn.ended" && last.turn === turn && last.outcome === "interrupted",
				`the last item is ${plain(last).slice(0, 200)}`,
			);
			assert(
				snapshot.timeline.some(item => item.turn === turn && item.kind === "platform" && item.level === "warn"),
				"no warning item about the lost turn",
			);
			assert(
				snapshot.summary.status === "idle" && snapshot.summary.lastOutcome === "interrupted",
				`summary is ${plain(snapshot.summary)}`,
			);
			dense(snapshot.timeline);
			assert(snapshot.pending.length === 0, "pending survived a restart");
			const listed = await waitFor(
				"the user's list to show the session idle",
				async () => {
					const entry = (await userHandle.listSessions()).find(candidate => candidate.id === sid);
					return entry?.status === "idle" ? entry : undefined;
				},
				10_000,
				200,
			);
			return `${snapshot.timeline.length} items (${seen + beforeSleep.length} seen before the crash); the user's list shows ${listed.status}`;
		});

		await check(
			"a question pending when the server died is gone on wake, and its turn is closed as interrupted",
			async () => {
				const lost = askedBeforeCrash;
				assert(lost.problem === null, `no session was waiting on a question before the crash: ${lost.problem}`);
				const handle = client.agentSession.get([uid, lost.id], { params: { token } });
				const snapshot = await withTimeout("the first snapshot after the restart", handle.snapshot(), 90_000);
				assert(snapshot.question === null, `a question survived the restart: ${plain(snapshot.question)}`);
				const last = snapshot.timeline.at(-1);
				assert(
					last?.kind === "turn.ended" && last.turn === lost.turn && last.outcome === "interrupted",
					`the last item is ${plain(last).slice(0, 200)}`,
				);
				assert(
					snapshot.summary.status === "idle" && snapshot.summary.lastOutcome === "interrupted",
					`summary is ${plain(snapshot.summary)}`,
				);
				assert(
					snapshot.timeline.some(item => item.kind === "windlass" && item.event.type === "approval.requested"),
					"the question's approval.requested is not in the timeline",
				);
				dense(snapshot.timeline);
				await refused(() => handle.answer({ questionId: lost.questionId, choice: "once" }), "no_question");
				const listed = await waitFor(
					"the user's list to show the session idle",
					async () => {
						const entry = (await userHandle.listSessions()).find(candidate => candidate.id === lost.id);
						return entry?.status === "idle" ? entry : undefined;
					},
					10_000,
					200,
				);
				return `status ${listed.status}, no question, an answer is refused with no_question`;
			},
		);
		if (askedBeforeCrash.id) await userHandle.deleteSession(askedBeforeCrash.id).catch(() => undefined);

		if (FAKE) {
			await check("a hold the crash left open is counted to the provider's idle stop, not to the wake", async () => {
				assert(counted.problem === null, `no session had an open hold before the crash: ${counted.problem}`);
				const bound = Math.ceil((counted.endedAt - counted.promptAt) / 1000) + IDLE_STOP_S;
				const toWake = Math.round((counted.wokeAt - counted.promptAt) / 1000);
				assert(
					counted.found <= bound + 1,
					`${counted.found} s counted; the sandbox can have run ${bound} s at most (its turn, then the ${IDLE_STOP_S} s idle stop), and it was woken ${toWake} s after its prompt`,
				);
				return `${counted.found} s counted (bound ${bound} s; ${toWake} s to the wake)`;
			});

			const countedWatch = counted.problem === null ? new Watch(client, uid, counted.id, token) : null;
			await check(
				"a prompt in the last steps of a turn that failed without a sandbox keeps its own hold and place",
				async () => {
					assert(countedWatch, `no session for it: ${counted.problem}`);
					// Its sandbox died with the server; the replacement's create is refused once, so the turn fails, and its end reads the state slowly.
					const failed = await countedWatch.conn.prompt({ text: "Write a short program" });
					const ended = await countedWatch.untilEnded(failed.turn);
					assert(ended.outcome === "error", `the first turn ended ${ended.outcome}`);
					const { turn } = await countedWatch.conn.prompt({ text: "Fix the failing test (slow)" });
					await waitFor(
						"the second turn to stream",
						() => countedWatch.deltas.some(delta => delta.turn === turn),
						TURN_MS,
					);
					// The refused create had made its sandbox: the session's next create removes it first.
					assert(/the sandbox was made/.test(ended.message ?? ""), `the first turn failed otherwise: ${ended.message}`);
					assert(
						new RegExp(`\\[wlp\\] sandbox\\.swept id=\\S+ session=${counted.id}`).test(server.output),
						"the sandbox the refused create made was not removed by the next create",
					);
					await sleep(PROVIDER_DELAY_MS + 1_000);
					assert(!countedWatch.ended(turn), "the second turn ended before it could be looked at");
					const row = await countedUsage();
					assert(
						row && row.heldSeconds > 0,
						`mid-turn the session holds ${row?.heldSeconds ?? 0} s: the failed turn's end closed the new turn's hold`,
					);
					assert(
						(await userHandle.usage()).kept.some(kept => kept.sessionId === counted.id),
						"the session has no place among the kept sandboxes",
					);
					const second = await countedWatch.untilEnded(turn);
					assert(second.outcome === "succeeded", `the second turn ended ${second.outcome}: ${second.message ?? ""}`);
					return `turn ${failed.turn} ${ended.outcome}, its orphan swept by the next create; turn ${turn} held ${row.heldSeconds} s mid-turn`;
				},
			);
			await countedWatch?.conn.dispose().catch(() => undefined);

			await check(
				"a prompt that wakes a session with a hold the crash left open counts that hold to the provider's idle stop, not to the wake",
				async () => {
					assert(promptWoken.problem === null, `no session had an open hold before the crash: ${promptWoken.problem}`);
					const handle = client.agentSession.get([uid, promptWoken.id], { params: { token } });
					// Nothing connects first: the prompt asks for its hold while the wake's read of the sandbox's state (PROVIDER_DELAY_MS) is still out.
					const wokeAt = Date.now();
					const { turn } = await handle.prompt({ text: "Write a short program" });
					await waitFor(
						"its turn to end",
						async () => {
							const now = await handle.snapshot();
							return now.summary.status === "idle" &&
								now.timeline.some(item => item.kind === "turn.ended" && item.turn === turn)
								? true
								: undefined;
						},
						TURN_MS,
						200,
					);
					// The first hold the restarted server counted for the session is the one the crash left open, traded for the prompt's.
					const first = await waitFor(
						"the hold left open by the crash to be counted",
						() =>
							server.output
								.slice(promptWoken.logFrom)
								.match(
									new RegExp(
										`\\[wlp\\] usage\\.counted uid=\\S+ session=${promptWoken.id} hold=(\\S+) kind=\\S+ seconds=(-?\\d+)`,
									),
								) ?? undefined,
						20_000,
						200,
					);
					const found = Number(first[2]);
					const bound = Math.ceil((promptWoken.endedAt - promptWoken.promptAt) / 1000) + IDLE_STOP_S;
					const toWake = Math.round((wokeAt - promptWoken.promptAt) / 1000);
					assert(
						toWake > bound + 5,
						`woken ${toWake} s after its prompt, too soon to tell a count to the wake from one to the idle stop (${bound} s)`,
					);
					assert(
						found <= bound + 1,
						`${found} s counted for hold ${first[1]}; the sandbox can have run ${bound} s at most (its turn, then the ${IDLE_STOP_S} s idle stop), and the prompt woke it ${toWake} s after its first prompt`,
					);
					return `${found} s counted (bound ${bound} s; ${toWake} s to the waking prompt)`;
				},
			);
			if (promptWoken.id) await userHandle.deleteSession(promptWoken.id).catch(() => undefined);

			await userHandle.deleteSession(counted.id).catch(() => undefined);
		}

		const watchThree = new Watch(client, uid, sid, token);
		await check(
			FAKE ? "a sandbox that is gone is replaced, with a warning" : "the session works after a server crash",
			async () => {
				const { turn } = await watchThree.conn.prompt({ text: "Write a short program" });
				const ended = await watchThree.untilEnded(turn);
				assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
				if (FAKE) {
					// The fake layer's sandboxes lived in the server that was killed.
					const warning = watchThree.items.find(item => item.kind === "platform" && item.level === "warn");
					assert(
						warning?.kind === "platform" && warning.text.includes("no longer exists"),
						"no warning that the earlier sandbox is gone",
					);
					assert(
						watchThree.items.some(
							item => item.kind === "platform" && item.text.startsWith("Starting a hosted sandbox"),
						),
						"no new sandbox was created",
					);
				}
				return `turn ${turn} ${ended.outcome}`;
			},
		);
		await watchThree.conn.dispose().catch(() => undefined);
	} else {
		skip("a turn lost to a server crash is closed as interrupted on wake", "needs its own server");
		skip(
			"a question pending when the server died is gone on wake, and its turn is closed as interrupted",
			"needs its own server",
		);
		await watchTwo.conn.dispose().catch(() => undefined);
		await userConn.dispose().catch(() => undefined);
	}

	// --- delete -----------------------------------------------------------------------------------

	const userConnTwo = userHandle.connect();
	const listsTwo: SessionSummary[][] = [];
	userConnTwo.on("sessions", (list: unknown) => {
		listsTwo.push(list as SessionSummary[]);
	});
	await userConnTwo.me();

	await check("delete", async () => {
		const created = server
			? [...server.output.matchAll(/\[wlp\] sandbox\.created id=(\S+) session=(\S+)/g)]
					.filter(match => match[2] === sid)
					.map(match => match[1])
			: [];
		const current = created.at(-1);
		if (!FAKE && current)
			assert(
				sandboxContainers().includes(`wlp-session-${current}`),
				`container wlp-session-${current} does not exist before the delete`,
			);
		await refused(() => userConnTwo.deleteSession("s_0000000000000000"), "session_not_found");
		await userConnTwo.deleteSession(sid);
		const list = await waitFor("the sessions event", () => listsTwo.at(-1), 5_000);
		assert(!list.some(entry => entry.id === sid), "the sessions event still lists the session");
		assert(!(await userConnTwo.listSessions()).some(entry => entry.id === sid), "listSessions still lists the session");
		await refused(() => sessionHandle.snapshot(), ["not_found", "session_not_found", "destroying", "destroyed"]);
		await refused(() => userConnTwo.deleteSession(sid), "session_not_found");

		if (!server) return "session and actor gone (sandbox not checked: needs the server's output)";
		assert(current, "the server never logged a sandbox for this session");
		await waitFor(
			"the sandbox to be destroyed",
			() => server.output.includes(`[wlp] sandbox.destroyed id=${current} session=${sid}`),
			20_000,
			100,
		);
		if (!FAKE)
			assert(!sandboxContainers().includes(`wlp-session-${current}`), `container wlp-session-${current} still exists`);
		return `session, actor and sandbox ${current} gone${FAKE ? "" : " (docker ps agrees)"}`;
	});

	// --- a real clone (Docker layer, on request: it needs the network) ----------------------------

	const repo = process.env.WLP_E2E_REPO;
	if (!FAKE && repo) {
		await check("a repository is cloned into the workspace", async () => {
			const cloned = await userConnTwo.createSession({ profile: availableProfile as never, repoUrl: repo });
			const clonedWatch = new Watch(client, uid, cloned.id, token);
			try {
				await clonedWatch.conn.snapshot();
				const { turn } = await clonedWatch.conn.prompt({ text: "Explore the workspace and write notes" });
				const ended = await clonedWatch.untilEnded(turn);
				assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
				assert(
					clonedWatch.items.some(item => item.kind === "platform" && item.text === `Cloning ${cloned.repoUrl}`),
					'no "Cloning" item',
				);
				const changes = await clonedWatch.conn.changes();
				const diff = await clonedWatch.conn.diff();
				// The repository's own files are committed, so only what the agent wrote shows up.
				assert(changes.length >= 1 && changes.length <= 3, `changes are ${plain(changes)}`);
				assert(diff.includes("README"), "the agent's notes do not list the repository's README");
				return `${cloned.repoUrl}: ${changes.map(file => `${file.status} ${file.path}`).join(", ")}`;
			} finally {
				await clonedWatch.conn.dispose().catch(() => undefined);
				await userConnTwo.deleteSession(cloned.id).catch(() => undefined);
			}
		});
	} else {
		skip(
			"a repository is cloned into the workspace",
			FAKE
				? "the fake layer clones nothing; its Cloning step is checked below"
				: "set WLP_E2E_REPO to an https git address to run it",
		);
	}

	// --- questions --------------------------------------------------------------------------------

	const asking = await userConnTwo.createSession({ profile: availableProfile as never, title: "Questions" });
	const askWatch = new Watch(client, uid, asking.id, token);
	const askHandle = client.agentSession.get([uid, asking.id], { params: { token } });
	await askWatch.conn.snapshot();
	/** The question of the first turn, which the next few checks look at before one of them answers it. */
	const first_: { question: PendingQuestion | null } = { question: null };
	const pendingQuestion = (): PendingQuestion => {
		assert(first_.question, "no question is pending: the check that asks one failed");
		return first_.question;
	};
	/** Starts a turn that asks, and returns its question once it is announced. */
	const ask = async (): Promise<PendingQuestion> => {
		await waitFor(
			"the session to be idle",
			() => askWatch.summaries.length === 0 || askWatch.summaries.at(-1)?.status === "idle",
			TURN_MS,
		);
		const { turn, steered } = await askWatch.conn.prompt({ text: ASK });
		assert(steered === false, "the prompt steered a turn instead of starting one");
		const asked = await askWatch.untilQuestion(turn);
		// The question is announced first, then the summary that says the session waits.
		await waitFor("the summary event to say waiting", () => askWatch.summaries.at(-1)?.status === "waiting", 5_000);
		return asked;
	};
	const settledOf = (question: PendingQuestion) => askWatch.ofCall(question.turn, "tool.settled", question).at(-1);
	const answeredOf = (question: PendingQuestion) => askWatch.ofCall(question.turn, "approval.answered", question);

	await check("a question is asked: the session waits, the question is announced and is in the snapshot", async () => {
		const asked = await ask();
		assert(
			/^q_[0-9a-f]{16}$/.test(asked.id) && asked.turn === 1,
			`the question's id or turn is off: ${plain(asked).slice(0, 200)}`,
		);
		assert(
			asked.title !== "" && asked.subject !== "" && asked.messageId !== "" && asked.callId !== "",
			`the question lacks a field: ${plain(asked).slice(0, 300)}`,
		);
		assert(
			Array.isArray(asked.details) && asked.details.every(detail => typeof detail === "string"),
			"details is not a list of sentences",
		);
		assert(
			asked.choices.some(choice => choice.id === "once" && choice.approve) &&
				asked.choices.some(choice => choice.id === "deny" && !choice.approve),
			`choices are ${plain(asked.choices)}`,
		);
		assert(
			asked.choices.every(
				choice =>
					choice.label !== "" &&
					(choice.remembers === null || (typeof choice.remembers === "string" && choice.remembers !== "")),
			),
			`a choice is malformed: ${plain(asked.choices)}`,
		);
		assert(asked.subagent === null, `subagent is ${plain(asked.subagent)}`);
		assert(
			Math.abs(Date.now() - asked.askedAt) < 60_000 && asked.expiresAt > asked.askedAt,
			"askedAt or expiresAt is off",
		);
		if (OWN_SERVER)
			assert(
				asked.expiresAt - asked.askedAt === QUESTION_MS,
				`the question expires after ${asked.expiresAt - asked.askedAt} ms, the server was started with ${QUESTION_MS}`,
			);
		first_.question = asked;

		await waitFor("the summary event to say waiting", () => askWatch.summaries.at(-1)?.status === "waiting", 5_000);
		const requested = await waitFor(
			"the approval.requested item",
			() => askWatch.ofCall(asked.turn, "approval.requested", asked).at(-1),
			5_000,
		);
		assert(
			askWatch.ofCall(asked.turn, "tool.called", asked).length === 1,
			"the question's call is not the one tool.called names",
		);
		const snapshot = await askHandle.snapshot();
		assert(
			plain(snapshot.question) === plain(asked),
			`snapshot().question is ${plain(snapshot.question).slice(0, 200)}`,
		);
		assert(snapshot.summary.status === "waiting", `snapshot().summary.status is ${snapshot.summary.status}`);
		assert(
			snapshot.timeline.some(item => item.seq === requested.seq),
			"the snapshot's timeline lacks the approval.requested item",
		);
		await waitFor(
			"the user's list to show the session waiting",
			async () =>
				(await userConnTwo.listSessions()).find(entry => entry.id === asking.id && entry.status === "waiting"),
			5_000,
		);
		assert(askWatch.questions.length === 1, `${askWatch.questions.length} question events arrived`);
		return `"${asked.title}" about \`${asked.subject}\`; choices ${asked.choices.map(choice => choice.id).join(", ")}; statuses ${askWatch.statuses()}; the user's list says waiting`;
	});

	await check("a client that connects while a question is pending sees it", async () => {
		const asked = pendingQuestion();
		const late = new Watch(client, uid, asking.id, token);
		try {
			const snapshot = await late.conn.snapshot();
			assert(
				plain(snapshot.question) === plain(asked),
				`the late client's snapshot has question ${plain(snapshot.question).slice(0, 200)}`,
			);
			assert(snapshot.summary.status === "waiting", `the late client's snapshot says ${snapshot.summary.status}`);
			assert(
				snapshot.timeline.some(
					item =>
						item.kind === "windlass" &&
						item.event.type === "approval.requested" &&
						item.event.data?.callId === asked.callId,
				),
				"its timeline lacks the approval.requested item",
			);
		} finally {
			await late.conn.dispose().catch(() => undefined);
		}
		return `question ${asked.id}, status waiting`;
	});

	// User B listens on user A's session from here until the question has been answered.
	const intruder = client.agentSession.get([uid, asking.id], { params: { token: userB.token } });
	const intruderConn = intruder.connect();
	const overheard: unknown[] = [];
	intruderConn.onError(() => undefined);
	for (const name of ["question", "summary", "item"] as const)
		intruderConn.on(name, (payload: unknown) => overheard.push(payload));
	await check("user B cannot answer, stop a call of, or steer user A's session", async () => {
		const asked = pendingQuestion();
		await refused(() => intruder.answer({ questionId: asked.id, choice: "once" }), "forbidden");
		await refused(() => intruder.stopCall({ messageId: asked.messageId, callId: asked.callId }), "forbidden");
		await refused(() => intruder.prompt({ text: "A message from user B" }), "forbidden");
		await refused(
			() => client.agentSession.get([uid, asking.id]).answer({ questionId: asked.id, choice: "once" }),
			"unauthorized",
		);
		await refused(
			() =>
				client.agentSession
					.get([uid, asking.id], { params: { token: `${token}x` } })
					.stopCall({ messageId: asked.messageId, callId: asked.callId }),
			"invalid_token",
		);
		await refused(
			() =>
				withTimeout(
					"an action over user B's connection",
					intruderConn.answer({ questionId: asked.id, choice: "deny" }),
					10_000,
				),
			"forbidden",
		);
		const snapshot = await askHandle.snapshot();
		assert(
			snapshot.question?.id === asked.id && snapshot.summary.status === "waiting",
			"the question did not stay pending",
		);
		assert(
			!snapshot.timeline.some(item => item.kind === "user" && item.text === "A message from user B"),
			"user B's message is in the timeline",
		);
		return "answer, stopCall and prompt: forbidden; no token: unauthorized; a bad token: invalid_token";
	});

	await check("an unknown question id or a choice the question lacks is refused", async () => {
		const asked = pendingQuestion();
		const unknown = await refused(
			() => askWatch.conn.answer({ questionId: "q_0000000000000000", choice: "once" }),
			"no_question",
		);
		const lacking = await refused(() => askWatch.conn.answer({ questionId: asked.id, choice: "always" }), "bad_choice");
		await refused(() => askWatch.conn.answer({ questionId: asked.id } as never), "bad_answer");
		await refused(() => askWatch.conn.answer({ questionId: asked.id, choice: "deny", note: 7 } as never), "bad_answer");
		await refused(
			() => askWatch.conn.answer({ questionId: asked.id, choice: "deny", note: "x".repeat(MAX_PROMPT_CHARS + 1) }),
			"note_too_long",
		);
		const snapshot = await askHandle.snapshot();
		assert(
			snapshot.question?.id === asked.id && snapshot.summary.status === "waiting",
			"a refused answer settled the question",
		);
		assert(askWatch.questions.length === 1, "a refused answer was announced");
		return `unknown id: "${unknown}"; missing choice: "${lacking}"`;
	});

	await check("allow once: the call runs, and the status returns to running and then idle", async () => {
		const asked = pendingQuestion();
		await askWatch.conn.answer({ questionId: asked.id, choice: "once" });
		await waitFor("the question event to say null", () => askWatch.questions.at(-1) === null, 5_000);
		const ended = await askWatch.untilEnded(asked.turn);
		assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
		const [answered] = answeredOf(asked);
		assert(
			answered && answered.event.data?.choice === "once" && answered.event.data.approve === true,
			`approval.answered is ${plain(answered?.event.data)}`,
		);
		assert(answeredOf(asked).length === 1, "the call was answered more than once");
		const [started] = askWatch.ofCall(asked.turn, "tool.started", asked);
		assert(started && started.seq > answered.seq, "the call did not start after the answer");
		const settled = settledOf(asked);
		assert(
			settled && settled.seq > started.seq && !String(settled.event.data?.output).includes("declined"),
			`the call settled as ${plain(settled?.event.data).slice(0, 200)}`,
		);
		assert(
			askWatch.statuses() === "starting > running > waiting > running > idle",
			`statuses were ${askWatch.statuses()}`,
		);
		assert(askWatch.questions.length === 2, `${askWatch.questions.length} question events arrived for one question`);
		const snapshot = await askHandle.snapshot();
		assert(
			snapshot.question === null && snapshot.summary.status === "idle" && snapshot.summary.turns === 1,
			`after the turn: ${plain(snapshot.summary)}`,
		);
		assert(plain(snapshot.timeline) === plain(askWatch.items), "the snapshot differs from the events");
		await refused(() => askWatch.conn.answer({ questionId: asked.id, choice: "once" }), "no_question");
		dense(askWatch.items);
		return `the call settled ${settled.event.data?.outcome}; statuses ${askWatch.statuses()}`;
	});

	await check("user B's connection received nothing of user A's question", async () => {
		// Every event of the turn above went to user A's connection; none may have reached user B's.
		assert(
			askWatch.questions.length >= 2 && askWatch.summaries.length > 0 && askWatch.items.length > 0,
			"user A's connection saw no events to compare with",
		);
		await sleep(300);
		assert(
			overheard.length === 0,
			`user B's connection received ${overheard.length} events, the first: ${String(plain(overheard[0])).slice(0, 200)}`,
		);
		return `user A saw ${askWatch.questions.length} question, ${askWatch.summaries.length} summary and ${askWatch.items.length} item events; user B none`;
	});
	await intruderConn.dispose().catch(() => undefined);

	await check("deny with a note: the call is not run and the note reaches the model", async () => {
		const asked = await ask();
		assert(
			asked.turn === 2 && asked.id !== first_.question?.id,
			`the second question is ${plain({ id: asked.id, turn: asked.turn })}`,
		);
		await askHandle.answer({ questionId: asked.id, choice: "deny", note: "  not now, use the cached copy  " });
		const ended = await askWatch.untilEnded(asked.turn);
		assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
		const [answered] = answeredOf(asked);
		assert(
			answered && answered.event.data?.choice === "deny" && answered.event.data.approve === false,
			`approval.answered is ${plain(answered?.event.data)}`,
		);
		assert(
			answered.event.data.note === "not now, use the cached copy",
			`the note arrived as ${plain(answered.event.data.note)}`,
		);
		assert(askWatch.ofCall(asked.turn, "tool.started", asked).length === 0, "the declined call was started");
		const settled = settledOf(asked);
		assert(
			settled &&
				settled.event.data?.outcome === "error" &&
				String(settled.event.data.output).includes("not now, use the cached copy"),
			`the call settled as ${plain(settled?.event.data).slice(0, 300)}`,
		);
		assert(
			askWatch.questions.at(-1) === null && (await askHandle.snapshot()).question === null,
			"the question is still pending",
		);
		return `the model was told: "${String(settled.event.data.output)}"`;
	});

	await check("two answers at once: exactly one is taken, the other is refused with no_question", async () => {
		const asked = await ask();
		const sent = ["deny", "once"];
		const results = await Promise.allSettled([
			askWatch.conn.answer({ questionId: asked.id, choice: sent[0] }),
			askHandle.answer({ questionId: asked.id, choice: sent[1] }),
		]);
		const taken = results.flatMap((result, index) => (result.status === "fulfilled" ? [sent[index]] : []));
		const refusals = results.flatMap(result =>
			result.status === "rejected" ? [(result.reason as { code?: unknown }).code] : [],
		);
		assert(
			taken.length === 1 && refusals.length === 1 && refusals[0] === "no_question",
			`fulfilled: ${plain(taken)}; refused with: ${plain(refusals)}`,
		);
		const ended = await askWatch.untilEnded(asked.turn);
		assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
		const answers = answeredOf(asked);
		assert(
			answers.length === 1 && answers[0].event.data?.choice === taken[0],
			`Windlass recorded ${plain(answers.map(item => item.event.data?.choice))}, the answer taken was ${taken[0]}`,
		);
		return `"${taken[0]}" was taken; the other answer got no_question`;
	});

	if (OWN_SERVER) {
		await check(
			"a question nobody answers in a hosted sandbox ends the turn when its time is up, and the sandbox pauses at once",
			async () => {
				const asked = await ask();
				await waitFor(
					"the platform to settle the question",
					() => askWatch.questions.at(-1) === null,
					QUESTION_MS + 20_000,
				);
				const waited = Date.now() - asked.askedAt;
				// WLP_HOSTED_QUESTION_TIMEOUT_MS is at most WLP_QUESTION_TIMEOUT_MS: the short time this server was started with.
				assert(
					waited >= QUESTION_MS - 200 && waited < QUESTION_MS + 10_000,
					`the question was settled after ${waited} ms; its time was ${QUESTION_MS} ms`,
				);
				const ended = await askWatch.untilEnded(asked.turn);
				assert(ended.outcome !== "succeeded", `outcome is ${ended.outcome}: the turn went on without an answer`);
				const said = askWatch.items.find(
					item => item.kind === "platform" && item.turn === asked.turn && item.text.includes("Nobody answered"),
				);
				assert(
					said?.kind === "platform" &&
						said.level === "warn" &&
						/so the turn was ended and its sandbox paused\. Send a prompt to go on\.$/.test(said.text),
					`no platform item says that nobody answered: ${plain(said)}`,
				);
				assert(
					askWatch.ofCall(asked.turn, "tool.started", asked).length === 0,
					"the call was started although nobody allowed it",
				);
				await waitFor("the sandbox to pause", () => askWatch.summaries.at(-1)?.sandbox === "paused", 20_000);
				const paused = askWatch.items.find(
					item =>
						item.kind === "platform" &&
						item.text.startsWith("Paused the sandbox: its turn ended on a question nobody answered."),
				);
				assert(paused, "no line says the sandbox was paused for it");
				await refused(() => askWatch.conn.answer({ questionId: asked.id, choice: "once" }), "no_question");
				return `ended after ${waited} ms (${ended.outcome}): "${said.text}"; then "${paused.kind === "platform" ? paused.text : ""}"`;
			},
		);
	} else {
		skip(
			"a question nobody answers in a hosted sandbox ends the turn when its time is up, and the sandbox pauses at once",
			"needs its own server, started with a short time for questions",
		);
	}

	await check("stop() during a question withdraws it and ends the turn as interrupted", async () => {
		const asked = await ask();
		const from = askWatch.summaries.length - 1;
		await askWatch.conn.stop();
		await waitFor("the question event to say null", () => askWatch.questions.at(-1) === null, 10_000);
		const ended = await askWatch.untilEnded(asked.turn);
		assert(ended.outcome === "interrupted", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
		await refused(() => askWatch.conn.answer({ questionId: asked.id, choice: "once" }), "no_question");
		assert(
			askWatch.ofCall(asked.turn, "tool.started", asked).length === 0,
			"the call was started although the turn was stopped",
		);
		const snapshot = await askHandle.snapshot();
		assert(
			snapshot.question === null &&
				snapshot.summary.status === "idle" &&
				snapshot.summary.lastOutcome === "interrupted",
			`after the stop: ${plain(snapshot.summary)}`,
		);
		assert(
			askWatch.statusesFrom(from) === "waiting > stopping > idle",
			`statuses from the question on were ${askWatch.statusesFrom(from)}`,
		);
		return `statuses ${askWatch.statusesFrom(from)}; an answer afterwards is refused with no_question`;
	});

	await check("a question does not survive the actor's sleep", async () => {
		const asked = await ask();
		await forceSleep(asking.id);
		// The connection drops with the actor and the client reconnects, which wakes it again.
		const snapshot = await waitFor(
			"the turn to be closed",
			async () => {
				const now = await askHandle.snapshot().catch(() => undefined);
				return now &&
					now.summary.status === "idle" &&
					now.timeline.at(-1)?.turn === asked.turn &&
					now.timeline.at(-1)?.kind === "turn.ended"
					? now
					: undefined;
			},
			60_000,
			300,
		);
		const last = snapshot.timeline.at(-1);
		assert(
			last?.kind === "turn.ended" && last.outcome === "interrupted",
			`the turn ended as ${plain(last).slice(0, 200)}`,
		);
		assert(snapshot.question === null, `a question survived the sleep: ${plain(snapshot.question)}`);
		assert(
			!snapshot.timeline.some(
				item => item.turn === asked.turn && item.kind === "windlass" && item.event.type === "approval.answered",
			),
			"the question was answered by something",
		);
		await refused(() => askHandle.answer({ questionId: asked.id, choice: "once" }), "no_question");
		dense(snapshot.timeline);
		return `turn ${asked.turn} interrupted by the shutdown; no question after waking`;
	});
	await askWatch.conn.dispose().catch(() => undefined);
	await userConnTwo.deleteSession(asking.id).catch(() => undefined);

	// --- the project's MCP servers (fake layer's switches) -------------------------------------------

	if (FAKE) {
		const harbor = await userConnTwo.createSession({ profile: availableProfile as never, title: "Servers" });
		let harborWatch!: Watch;
		const harborHandle = client.agentSession.get([uid, harbor.id], { params: { token } });
		// Subscribe for the next turn on a fresh socket. A gateway reconnect between cases can
		// miss the previous idle event, so establish the starting state from this socket's snapshot.
		const watchNextTurn = async () => {
			await harborWatch?.conn.dispose();
			harborWatch = new Watch(client, uid, harbor.id, token);
			await waitFor(
				"the session to be idle",
				async () => (await harborWatch.conn.snapshot()).summary.status === "idle",
				TURN_MS,
				200,
			);
		};
		/** The platform's lines of a turn that name the server. */
		const linesOf = (turn: number) =>
			harborWatch.items.flatMap(item =>
				item.kind === "platform" && item.turn === turn && item.text.includes("MCP server") ? [item] : [],
			);
		/** Starts a turn whose project names a server, and returns the question about it once it is announced. */
		const askAbout = async (text: string): Promise<PendingQuestion> => {
			await watchNextTurn();
			const { turn } = await harborWatch.conn.prompt({ text });
			const asked = await harborWatch.untilQuestion(turn);
			assert(asked.server !== undefined, `the question is not about a server: ${plain(asked).slice(0, 200)}`);
			return asked;
		};

		let firstId = "";
		await check(
			"a server the project names is asked about before the prompt goes: the session waits, and nothing of the turn has run",
			async () => {
				const asked = await askAbout("say hello (mcp)");
				firstId = asked.id;
				await waitFor(
					"the summary event to say waiting",
					() => harborWatch.summaries.at(-1)?.status === "waiting",
					5_000,
				);
				assert(asked.title === 'Start this project\'s MCP server "harbor"?', `title: ${asked.title}`);
				assert(asked.subject === "python3 tools/harbor_mcp.py", `subject: ${asked.subject}`);
				assert(
					asked.messageId === "" && asked.callId === "" && asked.subagent === null,
					"a server's question names a call or a subagent",
				);
				assert(
					plain(asked.server) ===
						plain({
							name: "harbor",
							file: "/workspace/.windlass/config.json",
							remote: false,
							unset: [],
							holdsTurn: true,
						}),
					`server: ${plain(asked.server)}`,
				);
				assert(
					plain(asked.choices.map(choice => [choice.id, choice.label, choice.approve])) ===
						plain([
							["start", "Start it for this project", true],
							["not_now", "Not now", false],
						]),
					`choices: ${plain(asked.choices)}`,
				);
				assert(
					asked.choices[0].remembers?.includes("30 days") && asked.choices[1].remembers === null,
					`remembers: ${plain(asked.choices.map(choice => choice.remembers))}`,
				);
				// The fake profile is the one whose commands Windlass sandboxes: the question says what the server can do that they cannot.
				assert(
					asked.details.length === 3 &&
						/outside Windlass's sandbox around commands: unlike the agent's commands, it has the network/.test(
							asked.details[0],
						),
					`details: ${plain(asked.details)}`,
				);
				assert(
					/remembered for 30 days for exactly this definition/.test(asked.details[1]),
					`details: ${plain(asked.details)}`,
				);
				assert(
					asked.details[2] ===
						"It is an approval of this command, not of the files it runs: a later commit can change those without a new question.",
					`details: ${plain(asked.details)}`,
				);
				if (OWN_SERVER)
					assert(
						asked.expiresAt - asked.askedAt === QUESTION_MS,
						`the question expires after ${asked.expiresAt - asked.askedAt} ms`,
					);
				assert(
					harborWatch.items.every(item => item.turn !== asked.turn || item.kind !== "windlass"),
					"Windlass had events of the turn before the question was answered",
				);
				const snapshot = await harborHandle.snapshot();
				assert(
					plain(snapshot.question) === plain(asked) && snapshot.summary.status === "waiting",
					`snapshot: ${plain(snapshot.question).slice(0, 200)}, ${snapshot.summary.status}`,
				);
				await refused(() => harborWatch.conn.answer({ questionId: asked.id, choice: "once" }), "bad_choice");
				return `"${asked.title}" ${asked.subject}; ${asked.details[0]}`;
			},
		);

		await check('"not now" leaves the server stopped: one line, and the turn runs', async () => {
			const asked = await harborHandle.snapshot().then(snapshot => snapshot.question);
			assert(asked?.id === firstId, "the first question is not pending any more");
			const from = harborWatch.summaries.length - 1;
			await harborWatch.conn.answer({ questionId: asked.id, choice: "not_now", note: "ignored" });
			await waitFor("the question event to say null", () => harborWatch.questions.at(-1) === null, 5_000);
			const ended = await harborWatch.untilEnded(asked.turn);
			assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
			const lines = linesOf(asked.turn);
			assert(
				lines.length === 1 &&
					lines[0].level === "info" &&
					lines[0].text ===
						'Left the MCP server "harbor" stopped. If the agent tries to use it, it is told that the server waits for you; your next message asks again.',
				`lines: ${plain(lines.map(line => line.text))}`,
			);
			const firstEvent = harborWatch.items.find(item => item.turn === asked.turn && item.kind === "windlass");
			assert(
				firstEvent !== undefined && firstEvent.seq > lines[0].seq,
				"the turn's events do not come after the answer",
			);
			assert(
				harborWatch.statusesFrom(from) === "waiting > running > idle",
				`statuses were ${harborWatch.statusesFrom(from)}`,
			);
			await refused(() => harborWatch.conn.answer({ questionId: asked.id, choice: "start" }), "no_question");
			return lines[0].text;
		});

		await check(
			"the next message asks again, and approving starts the server: one line that says when the agent has its tools",
			async () => {
				const asked = await askAbout("say hello again (mcp)");
				assert(
					asked.id !== firstId && asked.subject === "python3 tools/harbor_mcp.py",
					`asked: ${plain(asked).slice(0, 200)}`,
				);
				await harborWatch.conn.answer({ questionId: asked.id, choice: "start" });
				const ended = await harborWatch.untilEnded(asked.turn);
				assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
				const lines = linesOf(asked.turn);
				assert(
					lines.length === 1 &&
						lines[0].level === "info" &&
						lines[0].text ===
							'Started the MCP server "harbor" for this project: 2 tools. The agent has them from this turn on.',
					`lines: ${plain(lines.map(line => line.text))}`,
				);
				return lines[0].text;
			},
		);

		await check("an approved definition is not asked about again, and a changed one is", async () => {
			await watchNextTurn();
			const before = harborWatch.questions.length;
			const { turn } = await harborWatch.conn.prompt({ text: "once more (mcp)" });
			await harborWatch.untilEnded(turn);
			assert(
				harborWatch.questions.length === before && linesOf(turn).length === 0,
				`an approved server was asked about again: ${plain(harborWatch.questions.slice(before)).slice(0, 200)}`,
			);
			const asked = await askAbout("and now (mcp-changed)");
			assert(
				asked.subject === "python3 tools/harbor_mcp.py --berths 12" && asked.server?.name === "harbor",
				`asked: ${plain(asked).slice(0, 200)}`,
			);
			await harborWatch.conn.answer({ questionId: asked.id, choice: "start" });
			await harborWatch.untilEnded(asked.turn);
			assert(
				linesOf(asked.turn).length === 1 && linesOf(asked.turn)[0].text.startsWith('Started the MCP server "harbor"'),
				`lines: ${plain(linesOf(asked.turn).map(line => line.text))}`,
			);
			return `no question for the approved definition; asked again about ${asked.subject}`;
		});

		await check(
			"a definition that reads a variable which is not set says so, in the question and after an approval",
			async () => {
				const asked = await askAbout("try (mcp-env)");
				assert(plain(asked.server?.unset) === plain(["HARBOR_TOKEN"]), `unset: ${plain(asked.server?.unset)}`);
				// The session has no repository to save a secret for; a secret of the account would set the variable: any, where its sandbox gives them all to MCP servers.
				const remedy = `A variable is set by saving a secret for a repository of your GitHub connection, and this session is not on one. ${commandsSandboxed ? "A secret of your account under that name, saved in your settings, sets it for MCP servers too." : "A secret of your account under that name, saved in your settings, sets it for MCP servers in this sandbox if it is also for the agent's commands."}`;
				assert(
					asked.details.length === 4 &&
						asked.details[3] ===
							`It will not start yet: its definition reads the variable HARBOR_TOKEN, which is not set where Windlass runs. ${remedy}`,
					`details: ${plain(asked.details)}`,
				);
				await harborWatch.conn.answer({ questionId: asked.id, choice: "start" });
				const ended = await harborWatch.untilEnded(asked.turn);
				assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
				const lines = linesOf(asked.turn);
				assert(
					lines.length === 1 &&
						lines[0].level === "warn" &&
						lines[0].text ===
							`Approved the MCP server "harbor" for this project, but it did not start: the environment variable HARBOR_TOKEN named in its env is not set. ${remedy}`,
					`lines: ${plain(lines.map(line => line.text))}`,
				);
				return lines[0].text;
			},
		);

		await check(
			"a definition that changes under its question is not started, and the new one is asked about",
			async () => {
				const asked = await askAbout("move (mcp-moved)");
				assert(asked.subject === "python3 tools/harbor_mcp.py --port old", `subject: ${asked.subject}`);
				await harborWatch.conn.answer({ questionId: asked.id, choice: "start" });
				const again = await waitFor(
					"the question about the new definition",
					() => {
						const last = harborWatch.questions.at(-1);
						return last && last.id !== asked.id ? last : undefined;
					},
					10_000,
				);
				assert(
					again.subject === "python3 tools/harbor_mcp.py --port new" && again.turn === asked.turn,
					`asked again: ${plain(again).slice(0, 200)}`,
				);
				await harborWatch.conn.answer({ questionId: again.id, choice: "start" });
				await harborWatch.untilEnded(asked.turn);
				const lines = linesOf(asked.turn).map(line => line.text);
				assert(
					lines.length === 2 &&
						lines[0] ===
							'The definition of the MCP server "harbor" changed while it was asked about, so nothing was started. The new definition is asked about.' &&
						lines[1].startsWith('Started the MCP server "harbor"'),
					`lines: ${plain(lines)}`,
				);
				return lines[0];
			},
		);

		if (OWN_SERVER) {
			await check(
				'a server\'s question nobody answers is settled as "not now" when its time is up, and the turn goes on',
				async () => {
					const asked = await askAbout("read the docs (mcp-remote)");
					assert(
						asked.title === 'Connect to this project\'s MCP server "docs"?' &&
							asked.subject === "https://docs.example.com/mcp" &&
							asked.server?.remote === true,
						`asked: ${plain(asked).slice(0, 300)}`,
					);
					assert(
						asked.choices[0].label === "Connect for this project" &&
							/^Nothing is started: Windlass reaches it at that address/.test(asked.details[0]),
						`asked: ${plain(asked).slice(0, 400)}`,
					);
					await waitFor(
						"the summary event to say waiting",
						() => harborWatch.summaries.at(-1)?.status === "waiting",
						5_000,
					);
					const from = harborWatch.summaries.length - 1;
					await waitFor(
						"the platform to settle the question",
						() => harborWatch.questions.at(-1) === null,
						QUESTION_MS + 20_000,
					);
					const waited = Date.now() - asked.askedAt;
					assert(
						waited >= QUESTION_MS - 200 && waited < QUESTION_MS + 10_000,
						`the question was settled after ${waited} ms; its time was ${QUESTION_MS} ms`,
					);
					const ended = await harborWatch.untilEnded(asked.turn);
					assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
					const lines = linesOf(asked.turn);
					assert(
						lines.length === 1 &&
							lines[0].level === "warn" &&
							/^Nobody answered about the MCP server "docs" within \d+ seconds, so it stays unconnected\. Your next message asks again\.$/.test(
								lines[0].text,
							),
						`lines: ${plain(lines.map(line => line.text))}`,
					);
					assert(
						harborWatch.statusesFrom(from) === "waiting > running > idle",
						`statuses were ${harborWatch.statusesFrom(from)}`,
					);
					await refused(() => harborWatch.conn.answer({ questionId: asked.id, choice: "start" }), "no_question");
					return `settled after ${waited} ms: "${lines[0].text}"`;
				},
			);
		} else {
			skip(
				'a server\'s question nobody answers is settled as "not now" when its time is up, and the turn goes on',
				"needs its own server, started with a short time for questions",
			);
		}

		await check(
			"stop() during a server's question withdraws it without a line and ends the turn as interrupted",
			async () => {
				const asked = await askAbout("read the docs (mcp-remote)");
				await waitFor(
					"the summary event to say waiting",
					() => harborWatch.summaries.at(-1)?.status === "waiting",
					5_000,
				);
				const from = harborWatch.summaries.length - 1;
				await harborWatch.conn.stop();
				await waitFor("the question event to say null", () => harborWatch.questions.at(-1) === null, 10_000);
				const ended = await harborWatch.untilEnded(asked.turn);
				assert(ended.outcome === "interrupted", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
				assert(linesOf(asked.turn).length === 0, `lines: ${plain(linesOf(asked.turn).map(line => line.text))}`);
				assert(
					harborWatch.statusesFrom(from) === "waiting > stopping > idle",
					`statuses were ${harborWatch.statusesFrom(from)}`,
				);
				await refused(() => harborWatch.conn.answer({ questionId: asked.id, choice: "start" }), "no_question");
				return `statuses ${harborWatch.statusesFrom(from)}`;
			},
		);

		/** A turn in which Windlass reports the server while it runs and a tool call asks as well: returns both questions once the call's is shown. */
		const askBoth = async (): Promise<{ server: PendingQuestion; call: PendingQuestion; from: number }> => {
			await watchNextTurn();
			const from = harborWatch.questions.length;
			const { turn } = await harborWatch.conn.prompt({ text: `${ASK} (mcp-late)` });
			const call = await waitFor(
				"the tool call's question",
				() => {
					const last = harborWatch.questions.at(-1);
					return last && last.turn === turn && last.server === undefined ? last : undefined;
				},
				TURN_MS,
			);
			const server = harborWatch.questions[from];
			assert(
				server?.server !== undefined && server.turn === turn,
				`the first question of the turn is not the server's: ${plain(harborWatch.questions.slice(from)).slice(0, 300)}`,
			);
			return { server, call, from };
		};

		await check(
			"a tool call's question comes first: the server's steps aside for it and is put again after it",
			async () => {
				const { server, call, from } = await askBoth();
				assert(
					server.server?.holdsTurn === false && server.subject === "python3 tools/harbor_mcp.py --tide",
					`server: ${plain(server).slice(0, 300)}`,
				);
				assert(
					harborWatch.windlass(server.turn, "step.started").length > 0,
					"the question put while the turn runs came before the turn's first model call",
				);
				// Only the call's question is shown, and only it makes the session wait.
				const during = await harborHandle.snapshot();
				assert(
					during.question?.id === call.id && during.summary.status === "waiting",
					`while both are open the snapshot shows ${plain(during.question).slice(0, 120)}, ${during.summary.status}`,
				);
				assert(
					plain(harborWatch.questions.slice(from).map(question => question?.id ?? null)) ===
						plain([server.id, call.id]),
					`question events: ${plain(harborWatch.questions.slice(from).map(question => question?.id ?? null))}`,
				);
				await harborWatch.conn.answer({ questionId: call.id, choice: "once" });
				const again = await waitFor(
					"the server's question to be put again",
					() => {
						const last = harborWatch.questions.at(-1);
						return last && last.id === server.id && harborWatch.questions.length > from + 2 ? last : undefined;
					},
					10_000,
				);
				assert(again.expiresAt > server.expiresAt, "the question put again has no new time to answer in");
				assert(
					plain(harborWatch.questions.slice(from).map(question => question?.id ?? null)) ===
						plain([server.id, call.id, null, server.id]),
					`question events: ${plain(harborWatch.questions.slice(from).map(question => question?.id ?? null))}`,
				);
				// It does not hold the turn: the session runs under it, and the turn's end takes it away, with a line.
				const ended = await harborWatch.untilEnded(server.turn);
				assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
				assert(harborWatch.questions.at(-1) === null, "the question outlived the turn");
				const lines = linesOf(server.turn);
				assert(
					lines.length === 1 &&
						lines[0].level === "info" &&
						lines[0].text ===
							'The turn ended before anyone answered about the MCP server "harbor". Your next message asks again.',
					`lines: ${plain(lines.map(line => line.text))}`,
				);
				assert(lines[0].seq < ended.seq, "the line about the question comes after the turn's end");
				await refused(() => harborWatch.conn.answer({ questionId: server.id, choice: "start" }), "no_question");
				return `question events: server, call, null, server again; then "${lines[0].text}"`;
			},
		);

		await check(
			"a server's question that stands aside can still be answered, and a yes in a running turn says when the agent learns of the tools",
			async () => {
				const { server, call, from } = await askBoth();
				await harborWatch.conn.answer({ questionId: server.id, choice: "start" });
				await waitFor("the line about the server", () => linesOf(server.turn).length > 0, 10_000);
				const during = await harborHandle.snapshot();
				assert(
					during.question?.id === call.id && during.summary.status === "waiting",
					`after the server's answer the snapshot shows ${plain(during.question).slice(0, 120)}, ${during.summary.status}`,
				);
				await harborWatch.conn.answer({ questionId: call.id, choice: "once" });
				const ended = await harborWatch.untilEnded(server.turn);
				assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
				assert(
					plain(harborWatch.questions.slice(from).map(question => question?.id ?? null)) ===
						plain([server.id, call.id, null]),
					`question events: ${plain(harborWatch.questions.slice(from).map(question => question?.id ?? null))}`,
				);
				const lines = linesOf(server.turn).map(line => line.text);
				assert(
					lines.length === 1 &&
						lines[0] ===
							'Started the MCP server "harbor" for this project: 2 tools. The turn was already running: the agent is told of them at its next step.',
					`lines: ${plain(lines)}`,
				);
				return lines[0];
			},
		);

		await harborWatch?.conn.dispose().catch(() => undefined);
		await userConnTwo.deleteSession(harbor.id).catch(() => undefined);
	} else {
		skip(
			"the project's MCP servers",
			"the fake layer's switches; scripts/mcp-check.ts runs them against a real Windlass",
		);
	}

	// --- steering a turn, stopping one call -------------------------------------------------------

	// A new session is `starting` for a while: the fake layer's clone of this address takes a second
	// and a half, and the Docker layer creates a container.
	const steering = await userConnTwo.createSession({
		profile: availableProfile as never,
		repoUrl: FAKE ? "https://example.com/org/slow-clone.git" : undefined,
	});
	const steerWatch = new Watch(client, uid, steering.id, token);
	await steerWatch.conn.snapshot();
	const STEER = "Also, keep the report short.";
	const longCall = { messageId: "", callId: "" };

	await check("a message sent while the turn is starting is refused; one sent while it runs steers it", async () => {
		const { turn, steered } = await steerWatch.conn.prompt({ text: LONG });
		assert(turn === 1 && steered === false, `prompt() returned ${plain({ turn, steered })}`);
		const early = await refused(() => steerWatch.conn.prompt({ text: "Too early" }), "steer_unavailable");
		assert(/try again in a moment/i.test(early), `the refusal does not say to try again: "${early}"`);
		assert(
			(await steerWatch.conn.snapshot()).summary.status === "starting",
			"the turn was not starting when the message was refused",
		);

		const started = await waitFor(
			"the long command to start",
			() => steerWatch.windlass(1, "tool.started")[0],
			TURN_MS,
		);
		longCall.messageId = String(started.event.data?.messageId);
		longCall.callId = String(started.event.data?.callId);
		const titleBefore = steerWatch.summaries.at(-1)?.title;
		// `model` and `effort` are ignored for a steer, so values that a new turn would refuse do no harm.
		const reply = await steerWatch.conn.prompt({ text: `  ${STEER}  `, model: "gpt-nope", effort: "extreme" });
		assert(reply.turn === 1 && reply.steered === true, `the steer returned ${plain(reply)}`);
		const stored = await waitFor(
			"the steer's user item",
			() => steerWatch.items.find(item => item.kind === "user" && item.steer === true),
			5_000,
		);
		assert(
			stored.kind === "user" && stored.turn === 1 && stored.text === STEER,
			`the steer was stored as ${plain(stored)}`,
		);
		const [opening] = steerWatch.items;
		assert(
			opening.kind === "user" && !opening.steer && opening.text === LONG,
			`the turn's first item is ${plain(opening).slice(0, 200)}`,
		);
		assert(
			!steerWatch.items.some(item => item.kind === "user" && item.text === "Too early"),
			"the refused message was stored",
		);
		const textOf = (item: WindlassItem) => plain(item.event.data?.content);
		await waitFor(
			"Windlass to take the message in",
			() => steerWatch.windlass(1, "inbox.enqueued").find(item => textOf(item).includes(STEER)),
			10_000,
		);
		const summary = steerWatch.summaries.at(-1);
		assert(
			summary?.turns === 1 &&
				summary.status === "running" &&
				summary.title === titleBefore &&
				summary.title.startsWith("Run the long build"),
			`after the steer the summary is ${plain(summary)}`,
		);
		assert(!steerWatch.items.some(item => item.kind === "turn.ended"), "the turn ended before it could be steered");
		return `refused while starting: "${early}"; then steered: turn ${reply.turn}, stored with steer: true, title and turn count unchanged`;
	});

	await check("stopCall stops the long command and the turn goes on to its end", async () => {
		assert(longCall.callId !== "", "no running call is known: the check before this one failed");
		const begun = steerWatch.windlass(1, "tool.started")[0].at;
		const other = await steerWatch.conn.stopCall({ messageId: longCall.messageId, callId: "call_that_does_not_exist" });
		assert(
			other.stopped === false && typeof other.message === "string" && other.message !== "",
			`stopping an unknown call returned ${plain(other)}`,
		);
		await refused(() => steerWatch.conn.stopCall({ messageId: "", callId: longCall.callId }), "bad_call");
		const result = await steerWatch.conn.stopCall(longCall);
		assert(result.stopped === true, `stopCall returned ${plain(result)}`);
		const ended = await steerWatch.untilEnded(1);
		assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
		assert(
			steerWatch.ofCall(1, "tool.cancel_requested", longCall).length === 1,
			"no tool.cancel_requested for the call",
		);
		const settled = steerWatch.ofCall(1, "tool.settled", longCall).at(-1);
		assert(
			settled && settled.event.data?.outcome === "error" && /stopped/i.test(String(settled.event.data.output)),
			`the call settled as ${plain(settled?.event.data).slice(0, 300)}`,
		);
		const ran = settled.at - begun;
		assert(ran < (FAKE ? 4_000 : 10_000), `the call ran for ${ran} ms: it was not stopped early`);
		// The steered message of the check before: delivered to the model at the step after the stopped call.
		const enqueued = steerWatch
			.windlass(1, "inbox.enqueued")
			.find(item => plain(item.event.data?.content).includes(STEER));
		const delivered = steerWatch
			.windlass(1, "inbox.delivered")
			.find(item => item.event.data?.messageId === enqueued?.event.data?.messageId);
		assert(
			enqueued && delivered && delivered.seq > settled.seq && delivered.seq < ended.seq,
			"the steered message was not delivered between the stopped call and the turn's end",
		);
		assert(
			steerWatch.windlass(1, "step.started").some(item => item.seq > delivered.seq),
			"no step followed the stopped call",
		);
		assert(
			steerWatch.items.filter(item => item.kind === "user").length === 2 &&
				steerWatch.items.filter(item => item.kind === "turn.ended").length === 1,
			"the steer made a turn of its own",
		);
		assert(steerWatch.summaries.at(-1)?.turns === 1, `the session counts ${steerWatch.summaries.at(-1)?.turns} turns`);
		const idle = await refused(() => steerWatch.conn.stopCall(longCall), "no_turn");
		dense(steerWatch.items);
		const snapshot = await steerWatch.conn.snapshot();
		assert(plain(snapshot.timeline) === plain(steerWatch.items), "the snapshot differs from the events");
		return `an unknown call: "${other.message}"; the command was stopped after ${ran} ms and settled "${String(settled.event.data.output).split("\n").at(-1)}"; the steer was delivered next; with no turn: "${idle}"`;
	});

	if (FAKE) {
		await check("a message sent while the turn is stopping is refused", async () => {
			const { turn } = await steerWatch.conn.prompt({ text: "Wait for the slow build (slow) (slow-stop)" });
			await waitFor("the command to start", () => steerWatch.windlass(turn, "tool.started")[0], TURN_MS);
			await steerWatch.conn.stop();
			const late = await refused(() => steerWatch.conn.prompt({ text: "Too late" }), "steer_unavailable");
			assert(/being stopped/.test(late) && /try again in a moment/i.test(late), `the refusal is "${late}"`);
			await refused(() => steerWatch.conn.prompt({ text: "   " }), "empty_prompt");
			const ended = await steerWatch.untilEnded(turn);
			assert(ended.outcome === "interrupted", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
			assert(
				!steerWatch.items.some(item => item.kind === "user" && item.text === "Too late"),
				"the refused message was stored",
			);
			const again = await steerWatch.conn.prompt({ text: "Write a short program" });
			assert(again.turn === turn + 1 && again.steered === false, `the prompt after the stop returned ${plain(again)}`);
			assert(
				(await steerWatch.untilEnded(again.turn)).outcome === "succeeded",
				"the turn after the stop did not succeed",
			);
			return `"${late}"; the next prompt started turn ${again.turn}`;
		});
	} else {
		skip("a message sent while the turn is stopping is refused", "uses the fake layer's slow stop");
	}
	await steerWatch.conn.dispose().catch(() => undefined);
	await userConnTwo.deleteSession(steering.id).catch(() => undefined);

	// --- the limit on running sessions ------------------------------------------------------------

	if (FAKE) {
		await check(`at most ${RUNNING_CEILING} sessions of a user run at once`, async () => {
			const created: SessionSummary[] = [];
			for (let index = 0; index <= RUNNING_CEILING; index += 1)
				created.push(await userConnTwo.createSession({ profile: availableProfile as never, title: `limit ${index}` }));
			const handles = created.map(entry => client.agentSession.get([uid, entry.id], { params: { token } }));
			// The first of them waits on a question: a waiting session holds its place like a running one.
			await handles[0].prompt({ text: ASK });
			for (const handle of handles.slice(1, RUNNING_CEILING))
				await handle.prompt({ text: "Run the long build (slow)" });
			await waitFor(
				"the first session to wait on its question",
				async () => (await handles[0].snapshot()).summary.status === "waiting",
				15_000,
				50,
			);
			const message = await refused(
				() => handles[RUNNING_CEILING].prompt({ text: "One too many" }),
				"too_many_running",
			);
			assert(
				(await userConnTwo.listSessions()).find(entry => entry.id === created[0].id)?.status === "waiting",
				"the user's list does not show the first session as waiting",
			);
			assert((await handles[RUNNING_CEILING].snapshot()).timeline.length === 0, "the refused prompt left a timeline");
			await handles[0].stop();
			await waitFor(
				"the stopped session to be idle",
				async () => (await handles[0].snapshot()).summary.status === "idle",
				15_000,
				100,
			);
			const { turn } = await handles[RUNNING_CEILING].prompt({ text: "Now there is room" });
			assert(turn === 1, "the prompt was not accepted once a session had stopped");
			assert(
				created[0].title === "limit 0" && (await handles[0].snapshot()).summary.title === "limit 0",
				"a given title was replaced by the prompt",
			);
			for (const entry of created) await userConnTwo.deleteSession(entry.id);
			assert((await userConnTwo.listSessions()).length === 0, "sessions remain after deleting them");
			return `the fourth was refused while one of the three was waiting on a question: "${message}"; deleting running sessions works`;
		});
	} else {
		skip(
			`at most ${RUNNING_CEILING} sessions of a user run at once`,
			"four containers at once is too much for this machine; run in fake mode",
		);
	}

	// --- endings other than success, and the repository clone (fake layer's switches) ---------------

	if (FAKE) {
		const scratch = await userConnTwo.createSession({
			profile: availableProfile as never,
			repoUrl: "https://example.com/org/project.git",
			model: models.at(-1),
		});
		const scratchWatch = new Watch(client, uid, scratch.id, token);
		await scratchWatch.conn.snapshot();
		await check("failures end the turn with a readable message and leave the session usable", async () => {
			const run = async (text: string) => {
				const { turn } = await scratchWatch.conn.prompt({ text });
				return scratchWatch.untilEnded(turn);
			};
			const crashed = await run("please (crash)");
			assert(
				crashed.outcome === "error" && crashed.exitCode === 1 && crashed.message?.includes("simulated crash"),
				`crash: ${plain(crashed)}`,
			);
			assert(
				scratchWatch.items.some(
					item => item.kind === "platform" && item.text === "Cloning https://example.com/org/project.git",
				),
				'no "Cloning" item',
			);
			const thrown = await run("please (throw)");
			assert(
				thrown.outcome === "error" && thrown.exitCode === null && thrown.message?.startsWith("The sandbox failed"),
				`throw: ${plain(thrown)}`,
			);
			const signedOut = await run("please (auth-fail)");
			assert(
				signedOut.outcome === "error" && /sign in with chatgpt again/i.test(signedOut.message ?? ""),
				`auth-fail: ${plain(signedOut)}`,
			);
			const outdated = await run("please (missing-host-tools)");
			assert(
				outdated.outcome === "error" && /platform's tools/.test(outdated.message ?? ""),
				"a sandbox without host tools must refuse the turn",
			);
			const refused = await run("please (invalid-effort)");
			assert(
				refused.outcome === "failed" &&
					refused.message?.includes("The provider refused the request. HTTP 400: Invalid value: 'ultra'") &&
					refused.message.includes("[param: reasoning.effort]"),
				`provider 400: ${plain(refused)}`,
			);
			const failed = await run("please (exec-fail)");
			assert(
				failed.outcome === "failed" && failed.message === null && failed.steps === 1,
				`exec-fail: ${plain(failed)}`,
			);
			assert(
				scratchWatch
					.windlass(failed.turn, "execution.failed")
					.some(item => String(item.event.data?.message).includes("failed 4 times")),
				"the failed turn's events do not say how it failed",
			);
			const busy = await run("please (session-busy)");
			assert(
				busy.outcome === "error" && busy.message?.includes("another Windlass process"),
				`session-busy: ${plain(busy)}`,
			);
			const kept = (await scratchWatch.conn.snapshot()).windlassSessionId;
			assert(
				typeof kept === "string" && kept.startsWith("ses_"),
				`the Windlass session after the failures so far is ${kept}`,
			);
			// A session the sandbox's Windlass does not read: its own sentence, what the user can do about it, and the session is kept for a Windlass that reads it.
			const unread = await run("please (session-unread)");
			assert(
				unread.outcome === "error" &&
					unread.message?.includes(`session ${kept}`) &&
					unread.message.includes("does not read") &&
					unread.message.includes("open the session with the version that wrote it"),
				`session-unread: ${plain(unread)}`,
			);
			assert(
				(await scratchWatch.conn.snapshot()).windlassSessionId === kept,
				"a session Windlass could not read was given up",
			);
			const gone = await run("please (session-gone)");
			assert(
				gone.outcome === "error" &&
					gone.message?.includes(kept) &&
					gone.message.includes("starts a new Windlass session"),
				`session-gone: ${plain(gone)}`,
			);
			assert(
				(await scratchWatch.conn.snapshot()).windlassSessionId === null,
				"the lost Windlass session is still stored",
			);
			const fine = await run("and now a normal one");
			assert(fine.outcome === "succeeded", `after the failures: ${plain(fine)}`);
			const renewed = (await scratchWatch.conn.snapshot()).windlassSessionId;
			assert(typeof renewed === "string" && renewed !== kept, `the prompt after a lost session continued ${renewed}`);
			assert(
				scratchWatch.windlass(fine.turn, "session.created").length === 1,
				"the prompt after a lost session did not start a new Windlass session",
			);
			assert(
				scratchWatch.items.filter(item => item.kind === "platform" && item.text.startsWith("Cloning")).length === 1,
				"the repository was cloned more than once",
			);
			dense(scratchWatch.items);
			assert(
				scratch.model === models.at(-1) && scratch.repoUrl === "https://example.com/org/project.git",
				"the session's model or repository is off",
			);
			return `crash: "${crashed.message?.split("\n")[0]}"; throw: "${thrown.message}"; auth-fail: "${signedOut.message}"; missing-host-tools: "${outdated.message?.slice(0, 96)}…"; exec-fail: failed, the events say how; session-busy: "${busy.message}"; session-unread: "${unread.message?.slice(0, 80)}…"; session-gone: "${gone.message?.split("\n").join(" / ")}"; then succeeded in a new Windlass session`;
		});
		await scratchWatch.conn.dispose();
		await userConnTwo.deleteSession(scratch.id);

		await check("a clone that fails ends the turn as an error", async () => {
			const broken = await userConnTwo.createSession({
				profile: availableProfile as never,
				repoUrl: "https://example.com/org/fail-clone.git",
			});
			const brokenWatch = new Watch(client, uid, broken.id, token);
			await brokenWatch.conn.snapshot();
			await brokenWatch.conn.prompt({ text: "hello" });
			const ended = await brokenWatch.untilEnded(1);
			assert(
				ended.outcome === "error" &&
					ended.message?.includes("Cloning https://example.com/org/fail-clone.git failed") &&
					ended.message.includes("not found"),
				`ended: ${plain(ended)}`,
			);
			await brokenWatch.conn.dispose();
			await userConnTwo.deleteSession(broken.id);
			return ended.message ?? "";
		});
	} else {
		skip(
			"failures end the turn with a readable message and leave the session usable",
			"uses the fake layer's switches",
		);
		skip("a clone that fails ends the turn as an error", "uses the fake layer's switches");
	}
	await userConnTwo.dispose().catch(() => undefined);

	// --- ChatGPT sign-in --------------------------------------------------------------------------

	if (FAKE) {
		await check(
			"the fake layer's token source: no token without a sign-in, one request per user at a time, a fresh answer reused, a new sign-in's token after adopt",
			async () => {
				// The layer itself, beside the server's, with the users' sign-ins kept in this process: what the actors' turns ask before they start.
				const { createFakeSandboxLayer, fakeSignInFiles } = await import("../server/src/sandbox-fake.js");
				const { SandboxUserError } = await import("../server/src/sandbox/api.js");
				const { SignInRefreshError } = await import("../server/src/sandbox/handoff.js");
				const fake = createFakeSandboxLayer({ signIns: "memory" });
				// As the connect route hands the user's actor an uploaded sign-in.
				const signIn = async (uid: string, code: string) => {
					const directory = fake.signIns!;
					await directory.adopt(
						uid,
						directory.sealer.seal("user", uid, JSON.stringify({ files: fakeSignInFiles(code) })),
					);
				};
				const refusal = async (uid: string) =>
					fake.tokens.current(uid).then(
						() => null,
						(error: unknown) => error,
					);
				await fake.logins.ensureUserVolume("u_demo");
				const none = await refusal("u_demo");
				assert(
					none instanceof SandboxUserError && /Sign in with ChatGPT/.test(none.message),
					`a user without a sign-in: ${plain(none instanceof Error ? none.message : none)}`,
				);
				await signIn("u_ann", "ann");
				await signIn("u_ben", "ben");
				const at = Date.now();
				const [many, other] = await Promise.all([
					Promise.all(Array.from({ length: 6 }, () => fake.tokens.current("u_ann"))),
					fake.tokens.current("u_ben"),
				]);
				const first = many[0]!;
				assert(
					many.every(token => token.accessToken === first.accessToken && token.expiresAt === first.expiresAt),
					"six requests at once for one user got different answers",
				);
				assert(other.accessToken !== first.accessToken, "two users were given the same token");
				assert(first.expiresAt - at > 55 * 60_000, "the token does not last about an hour");
				first.accessToken = "changed by the caller";
				const again = await fake.tokens.current("u_ann");
				assert(again.accessToken === many[1]!.accessToken, "a fresh answer was not reused");
				await signIn("u_ann", "ann2");
				const adopted = await fake.tokens.current("u_ann");
				assert(
					adopted.accessToken !== again.accessToken,
					"after a new sign-in the old one's token was handed out again",
				);
				await fake.logins.logout("u_ann");
				const out = await refusal("u_ann");
				assert(
					out instanceof SandboxUserError && /Sign in with ChatGPT/.test(out.message),
					"after logout a token was still handed out",
				);
				// A sign-in whose saved token is about to run out: asking refreshes it, once for everyone who asks.
				await signIn("u_eve", "brief");
				const due = await Promise.all(Array.from({ length: 4 }, () => fake.tokens.current("u_eve")));
				assert(
					due.every(token => token.accessToken === due[0]!.accessToken) && due[0]!.expiresAt - Date.now() > 55 * 60_000,
					"a token that was due was not replaced by one new token for all who asked",
				);
				assert(
					(await fake.logins.status("u_eve"))?.accessExpiresAt === due[0]!.expiresAt,
					"the refreshed sign-in was not saved",
				);
				const expired = await refusal(await signIn("u_cat", "expired").then(() => "u_cat"));
				assert(
					expired instanceof SandboxUserError && /Sign in with ChatGPT again/.test(expired.message),
					"a sign-in that is no longer accepted is not the user's to renew",
				);
				const offline = await refusal(await signIn("u_dan", "offline").then(() => "u_dan"));
				assert(
					offline instanceof Error && !(offline instanceof SandboxUserError),
					"a token that cannot be had this time was reported as the user's doing",
				);
				assert(
					offline instanceof SignInRefreshError && offline.code === "network_error",
					"a sign-in service that cannot be reached is not told by Windlass's code for it, `network_error`",
				);
				for (const said of [none, out, expired, offline])
					assert(!/FAKE-ACCESS-TOKEN/.test(String((said as Error).message)), "an error message contains a token");
				return `not signed in: "${(none as Error).message}"; 6 requests at once: one answer; reused; replaced by adopt; gone after logout; a token that was due: one refresh for 4 requests, saved; expired: SandboxUserError; offline: ${(offline as Error).name} (${(offline as { code?: string }).code})`;
			},
		);

		// Model checks start with a signed platform fixture and attach the fake model grant in Settings.
		const connectPlan = async (code: string) => {
			const profile = { uid: "u_" + randomBytes(12).toString("hex"), demo: false, email: "platform@example.invalid" };
			const { issueUserToken } = await import("../server/src/tokens.js");
			const auth = { profile, token: issueUserToken(profile, 0) };
			const user = client.user.getOrCreate([profile.uid], { params: { token: auth.token } });
			const { fakeSignInFiles } = await import("../server/src/sandbox-fake.js");
			await connectChatgpt(API, user, { files: fakeSignInFiles(code) });
			return auth;
		};

		await check(
			"the models are the signed-in account's own: listed once for all who ask at once and kept, each model with its own efforts, and gone with the sign-in",
			async () => {
				const mona = await connectPlan("mona");
				const user = client.user.getOrCreate([mona.profile.uid], { params: { token: mona.token } });
				const lists = await Promise.all([1, 2, 3, 4, 5].map(() => user.models()));
				const [list] = lists;
				assert(
					list!.source === "account" &&
						typeof list!.fetchedAt === "number" &&
						list!.models.length === 3 &&
						list!.defaultModel === "gpt-6.1-sol",
					`the account's models are ${plain(list)}`,
				);
				assert(
					lists.every(other => plain(other) === plain(list)),
					"five requests at once were not answered from one listing",
				);
				assert(plain(await user.models()) === plain(list), "a list that is fresh was listed again");
				if (server) {
					const listed = server.output
						.split("\n")
						.filter(line => line.includes(`[wlp] models.listed uid=${mona.profile.uid}:`));
					assert(listed.length === 1, `Windlass was asked for the models ${listed.length} times`);
				}
				// A model's own efforts, and a model that takes none.
				const some = list!.models.find(model => model.id === "gpt-6-sol")!;
				const none = list!.models.find(model => model.efforts.length === 0)!;
				assert(
					plain(some.efforts) === plain(["low", "medium", "high"]) && none.id === "gpt-6-luna",
					`the efforts are ${plain(list!.models)}`,
				);
				const session = await user.createSession({ profile: availableProfile as never, model: some.id });
				const conn = client.agentSession.get([mona.profile.uid, session.id], { params: { token: mona.token } });
				const tooMuch = await refused(() => conn.prompt({ text: "hello", effort: "max" }), "bad_effort");
				const noEffort = await refused(
					() => conn.prompt({ text: "hello", model: none.id, effort: "low" }),
					"bad_effort",
				);
				await refused(() => conn.prompt({ text: "hello", model: "gpt-nope" }), "bad_model");
				await refused(() => user.createSession({ profile: availableProfile as never, model: "gpt-nope" }), "bad_model");
				await refused(() => user.saveAccountDefaults({ model: "gpt-nope" }), "bad_model");
				assert((await conn.snapshot()).timeline.length === 0, "a refused prompt left items in the timeline");
				await user.deleteSession(session.id);
				// The list does not outlive the sign-in it was read with: forgotten, there is the stand-in, which says why.
				await user.forgetChatgpt();
				const after = await user.models();
				assert(
					after.source === "signed-out" && after.fetchedAt === null,
					`after the sign-in was forgotten the models are ${plain(after)}`,
				);
				return `${list!.models.map(model => `${model.id} [${model.efforts.join(" ")}]`).join(", ")}; refused: "${tooMuch}" / "${noEffort}"; after forgetting: ${after.source}`;
			},
		);

		await check(
			"a user without a ChatGPT sign-in is told to sign in; with one, turns run unscripted on an access token handed to them",
			async () => {
				// A user who signed in and then had the sign-in forgotten: the platform's token is still good, the ChatGPT sign-in is gone.
				const without = await connectPlan("carol");
				const withoutUser = client.user.getOrCreate([without.profile.uid], { params: { token: without.token } });
				assert(
					(await withoutUser.chatgpt()).connected === true,
					"a user who just signed in is not reported as connected",
				);
				await withoutUser.forgetChatgpt();
				await withoutUser.forgetChatgpt();
				assert(
					(await withoutUser.chatgpt()).connected === false,
					"a user whose sign-in was forgotten is reported as connected",
				);
				const blocked = await withoutUser.createSession({ profile: availableProfile as never });
				const blockedHandle = client.agentSession.get([without.profile.uid, blocked.id], {
					params: { token: without.token },
				});
				const message = await refused(() => blockedHandle.prompt({ text: "hello" }), "chatgpt_required");
				const snapshot = await blockedHandle.snapshot();
				assert(
					snapshot.timeline.length === 0 && snapshot.summary.status === "idle" && snapshot.summary.turns === 0,
					"the refused prompt changed the session",
				);
				await withoutUser.deleteSession(blocked.id);

				const bob = await connectPlan("bob");
				const bobUser = client.user.getOrCreate([bob.profile.uid], { params: { token: bob.token } });
				const session = await bobUser.createSession({ profile: availableProfile as never });
				const bobWatch = new Watch(client, bob.profile.uid, session.id, bob.token);
				await bobWatch.conn.prompt({ text: "hello there" });
				const ended = await bobWatch.untilEnded(1);
				assert(ended.outcome === "succeeded", `a signed-in user's turn ended ${ended.outcome}`);
				await bobWatch.conn.prompt({ text: "and once more" });
				assert(
					(await bobWatch.untilEnded(2)).outcome === "succeeded",
					"a signed-in user's second turn did not succeed",
				);
				await bobWatch.conn.dispose();
				await bobUser.deleteSession(session.id);
				let handed = "the server's output is not at hand";
				if (server) {
					// The layer says when it hands a turn a token, and never the token.
					const lines = server.output.split("\n").filter(line => line.includes("[wlp] token.handed"));
					const bobs = lines.filter(line => line.includes(`uid=${bob.profile.uid}:`));
					assert(bobs.length === 2, `the signed-in user's two turns were handed a token ${bobs.length} times`);
					assert(
						!lines.some(line => demoUids.some(demo => line.includes(`uid=${demo}:`))),
						"a demo user's scripted turn was handed an access token",
					);
					assert(!/FAKE-ACCESS-TOKEN/.test(server.output), "an access token is in the server's output");
					handed = `each of the signed-in user's 2 turns was handed a token, none of the ${demoUids.length} demo users' turns was`;
				}
				return `refusal: "${message}"; ${handed}`;
			},
		);

		await check(
			"the sign-in is the user's actor's: turns started at once cause one refresh, the refreshed sign-in outlives the actor's sleep, a forgotten one yields nothing, and the actor data holds no token",
			async () => {
				const eve = await connectPlan("brief");
				const uidOfEve = eve.profile.uid;
				const user = client.user.getOrCreate([uidOfEve], { params: { token: eve.token } });
				// Connecting the ChatGPT plan checks its catalog with a current token: the brief one is refreshed then, once.
				const before = await user.chatgpt();
				assert(
					before.connected &&
						typeof before.accessExpiresAt === "number" &&
						before.accessExpiresAt - Date.now() > 55 * 60_000,
					`connecting did not refresh the sign-in's brief token: ${plain(before)}`,
				);

				// Only servers may ask the actor for the sign-in or its token: the user's own token is refused, and so is everyone else's.
				const inner = user as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
				for (const call of [
					() => inner.internalAccessToken!("n".repeat(22)),
					() => inner.internalSignInStatus!(),
					() => inner.internalSignOut!(),
					() => inner.internalAdoptSignIn!("x"),
				])
					await refused(call, "forbidden");
				const stranger = client.user.getOrCreate([uidOfEve], { params: { token } }) as unknown as Record<
					string,
					(...args: unknown[]) => Promise<unknown>
				>;
				await refused(() => stranger.chatgpt!(), "forbidden");
				await refused(() => stranger.forgetChatgpt!(), "forbidden");
				await refused(() => stranger.internalAccessToken!("n".repeat(22)), "forbidden");

				// Three turns at once, each of which asks for the user's token before it starts.
				const sessions = await Promise.all(
					[1, 2, 3].map(() => user.createSession({ profile: availableProfile as never })),
				);
				const watches = sessions.map(session => new Watch(client, uidOfEve, session.id, eve.token));
				try {
					await Promise.all(watches.map(watch => watch.conn.prompt({ text: "hello" })));
					const ended = await Promise.all(watches.map(watch => watch.untilEnded(1)));
					assert(
						ended.every(turn => turn.outcome === "succeeded"),
						`the three turns ended ${ended.map(turn => turn.outcome).join(", ")}`,
					);
					const after = await user.chatgpt();
					assert(
						after.connected && (after.accessExpiresAt ?? 0) - Date.now() > 55 * 60_000,
						`the refreshed sign-in was not saved: ${plain(after)}`,
					);
					const linesOf = (what: string) =>
						server
							? server.output
									.split("\n")
									.filter(line => line.includes(`[wlp] ${what}`) && line.includes(`uid=${uidOfEve}:`))
							: [];
					if (server) {
						assert(
							linesOf("token.handed").length === 3,
							`the three turns were handed a token ${linesOf("token.handed").length} times`,
						);
						assert(
							linesOf("sign-in.refreshed").length === 1,
							`connecting and three turns at once refreshed the sign-in ${linesOf("sign-in.refreshed").length} times`,
						);
					}

					// The actor sleeps: the token it kept in memory is gone, and what it wakes with is what it stored.
					const list = (await (await controlPlane("/actors?namespace=default&name=user")).json()) as {
						actors: Array<{ actor_id: string; key: string }>;
					};
					const record = list.actors.find(entry => entry.key.includes(uidOfEve));
					assert(record, "the control plane does not list the user's actor");
					const slept = await controlPlane(`/actors/${record.actor_id}/sleep?namespace=default`, "POST");
					assert(slept.ok, `the control plane refused the sleep: ${slept.status}`);
					await sleep(1_500);
					await watches[0]!.conn.prompt({ text: "and once more" });
					assert(
						(await watches[0]!.untilEnded(2)).outcome === "succeeded",
						"a turn after the user's actor slept did not succeed",
					);
					if (server) {
						assert(linesOf("token.handed").length === 4, "the turn after the sleep was not handed a token");
						// Had the refreshed sign-in not been stored, the actor would have woken with the one whose token had a minute left, and refreshed again.
						assert(
							linesOf("sign-in.refreshed").length === 1,
							"the user's actor woke with the sign-in from before the refresh",
						);
					}

					await user.forgetChatgpt();
					assert((await user.chatgpt()).connected === false, "a forgotten sign-in is still reported");
					// Each prompt pins the ChatGPT plan: a session that ran a moment ago is refused before a turn starts too.
					const unsigned = await refused(() => watches[1]!.conn.prompt({ text: "hello again" }), "chatgpt_required");
					assert(
						watches[1]!.items.filter(item => item.kind === "windlass" && item.turn === 2).length === 0,
						"a turn started after the sign-in was forgotten",
					);
					if (server)
						assert(linesOf("token.handed").length === 4, "a turn was handed a token of a sign-in that was forgotten");
					// A session that asks is refused before a turn starts.
					const late = await user.createSession({ profile: availableProfile as never });
					sessions.push(late);
					const message = await refused(
						() =>
							client.agentSession.get([uidOfEve, late.id], { params: { token: eve.token } }).prompt({ text: "hello" }),
						"chatgpt_required",
					);

					let stored = "the server's actor data is not at hand";
					if (server) {
						// Everything the engine wrote for this server's actors: the sealed sign-ins are in there, and no token is.
						let files = 0;
						let sealed = 0;
						const leaks: string[] = [];
						const walk = (dir: string) => {
							for (const entry of readdirSync(dir, { withFileTypes: true })) {
								const path = join(dir, entry.name);
								if (entry.isDirectory()) walk(path);
								else if (entry.isFile() && path !== server.logFile && statSync(path).size < 256 * 1024 * 1024) {
									const text = readFileSync(path).toString("latin1");
									files += 1;
									if (text.includes("wlps1.")) sealed += 1;
									if (/FAKE-(ACCESS|REFRESH)-TOKEN/.test(text)) leaks.push(path.replace(server.storage, ""));
								}
							}
						};
						walk(server.storage);
						assert(leaks.length === 0, `a token is readable in the actor data: ${leaks.join(", ")}`);
						assert(!/FAKE-(ACCESS|REFRESH)-TOKEN/.test(server.output), "a token is in the server's output");
						stored =
							sealed > 0
								? `${files} files of actor data read: sealed sign-ins in ${sealed}, a token in none`
								: `${files} files of actor data read: a token in none (and no sealed blob was found as text either, so the engine's files may not be readable this way)`;
					}
					return `connect and 3 turns at once: one refresh; after the actor's sleep: no second one; forgotten: a running session's prompt is refused "${unsigned}", a new one "${message}"; ${stored}`;
				} finally {
					for (const watch of watches) await watch.conn.dispose().catch(() => undefined);
					for (const session of sessions) await user.deleteSession(session.id).catch(() => undefined);
				}
			},
		);

		await check(
			"a sign-in that is no longer accepted, or whose token cannot be had, ends the turn with what to do",
			async () => {
				const turnOf = async (code: string) => {
					const auth = await connectPlan(code);
					const user = client.user.getOrCreate([auth.profile.uid], { params: { token: auth.token } });
					// The sign-in is there, so the prompt is taken: only asking for its token shows what state it is in.
					assert((await user.chatgpt()).connected === true, `the ${code} user is not reported as connected`);
					const session = await user.createSession({ profile: availableProfile as never });
					const watch = new Watch(client, auth.profile.uid, session.id, auth.token);
					try {
						await watch.conn.prompt({ text: "hello" });
						const first = await watch.untilEnded(1);
						assert(
							watch.items.filter(item => item.kind === "windlass").length === 0,
							`the ${code} user's turn has Windlass events`,
						);
						// The session is usable afterwards, and the next prompt is taken and answered the same way.
						await watch.conn.prompt({ text: "hello again" });
						const second = await watch.untilEnded(2);
						assert(
							second.outcome === first.outcome && second.message === first.message,
							`the ${code} user's second turn ended differently: ${plain(second)}`,
						);
						assert((await watch.conn.snapshot()).summary.status === "idle", `the ${code} user's session is not idle`);
						return first;
					} finally {
						await watch.conn.dispose().catch(() => undefined);
						await user.deleteSession(session.id).catch(() => undefined);
					}
				};
				const expired = await turnOf("expired");
				assert(
					expired.outcome === "error" && expired.message?.match(/sign in with chatgpt again/gi)?.length === 1,
					`expired: ${plain(expired)}`,
				);
				const offline = await turnOf("offline");
				assert(
					offline.outcome === "error" &&
						/could not get an access token/.test(offline.message ?? "") &&
						/send the prompt again/.test(offline.message ?? "") &&
						!/sign in with chatgpt again/i.test(offline.message ?? ""),
					`offline: ${plain(offline)}`,
				);
				return `expired: "${expired.message}"; offline: "${offline.message}"`;
			},
		);
	} else {
		skip(
			"a user without a ChatGPT sign-in is told to sign in; with one, turns run unscripted on an access token handed to them",
			"needs a signed-in account; run in fake mode, or scripts/sandbox-check.ts for the real hand-off",
		);
		skip(
			"the sign-in is the user's actor's: turns started at once cause one refresh, the refreshed sign-in outlives the actor's sleep, a forgotten one yields nothing, and the actor data holds no token",
			"needs a signed-in account; run in fake mode, or scripts/signin-check.ts for the same with a real Windlass",
		);
		skip(
			"a sign-in that is no longer accepted, or whose token cannot be had, ends the turn with what to do",
			"needs a signed-in account; run in fake mode",
		);
	}

	if (server && loginTtlMs === SHORT_LOGIN_TTL_MS) {
		await check("an unfinished sign-in attempt is discarded when it expires", async () => {
			const id = attempt();
			const handle = loginHttp(API, loginOrigin, id);
			const started = await handle.start("google");
			assert(
				started.url.startsWith("https://") && started.redirectPrefix.startsWith("http://"),
				`start gave ${plain(started)}`,
			);
			assert(Math.abs(started.expiresAt - (Date.now() + loginTtlMs)) < 8_000, "expiresAt is off");
			// Neither layer contacts OpenAI for an address that is not the loopback one.
			const wrong = await refused(() => handle.finish("https://example.com/not-the-callback"), "invalid_callback");
			// An attempt is kept, sealed, in its actor: no layer makes a volume for it.
			if (!FAKE) assert(loginVolumes(id).length === 0, `an attempt left a volume: wlp-login-${id}`);
			await waitFor(
				"the attempt to be discarded",
				() => server.output.includes(`[wlp] login.discarded attempt=${id}`),
				loginTtlMs + 20_000,
				250,
			);
			await refused(() => handle.finish(`${started.redirectPrefix}?code=late&state=x`), "not_found");
			return `after ${Math.round(loginTtlMs / 1000)} s the actor and the attempt in it were gone; a wrong address was answered with "${wrong}"`;
		});
	} else {
		skip(
			"an unfinished sign-in attempt is discarded when it expires",
			"needs its own server, restarted with a short expiry",
		);
	}

	await check("the demo sign-in's login actor goes away", async () => {
		const id = attempt();
		await demoSignIn(id);
		await refused(() => loginHttp(API, loginOrigin, id).demo(), "attempt_done");
		await waitFor(
			"the login actor to remove itself",
			async () => {
				try {
					await loginHttp(API, loginOrigin, id).finish("expired");
					return false;
				} catch (error) {
					return (error as { code?: string }).code === "not_found";
				}
			},
			15_000,
			300,
		);
		await refused(() => loginHttp(API, loginOrigin, "bad id!").start("github"), "bad_attempt_id");
		return "destroyed a few seconds after issuing its token";
	});

	// --- a message sent twice ---------------------------------------------------------------------

	await submissionChecks(server, client, uid, token, availableProfile, LONG);

	// --- the turn's time limit, on a server restarted with a short one ------------------------------

	if (server && FAKE) {
		await check("the turn's time limit applies while a question waits", async () => {
			const limitMs = 3_000;
			await server.stop();
			await waitFor(`ports ${ENGINE_PORT} and ${HTTP_PORT} to be free`, portsFree, 20_000, 200);
			await server.start({ WLP_TURN_TIMEOUT_MS: String(limitMs), WLP_LOGIN_TTL_MS: String(loginTtlMs) });
			const limited = await userHandle.createSession({ profile: availableProfile as never, title: "Limited" });
			const limitedWatch = new Watch(client, uid, limited.id, token);
			try {
				const { turn } = await limitedWatch.conn.prompt({ text: ASK });
				const asked = await limitedWatch.untilQuestion(turn);
				assert(
					asked.expiresAt - asked.askedAt === QUESTION_MS && QUESTION_MS > limitMs,
					"the question would expire before the turn's limit",
				);
				const ended = await limitedWatch.untilEnded(turn, limitMs + 20_000);
				assert(ended.outcome === "interrupted", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
				const said = limitedWatch.items.find(
					item => item.kind === "platform" && item.level === "warn" && item.text.includes("which is the limit"),
				);
				assert(said?.kind === "platform", "no platform item says that the turn reached its limit");
				const ran = ended.at - limitedWatch.items[0].at;
				assert(
					ran >= limitMs - 200 && ran < limitMs + 8_000,
					`the turn ran for ${ran} ms; its limit was ${limitMs} ms`,
				);
				assert(limitedWatch.questions.at(-1) === null, "the question was not withdrawn");
				assert(
					limitedWatch.ofCall(turn, "approval.answered", asked).length === 0 &&
						limitedWatch.ofCall(turn, "tool.started", asked).length === 0,
					"the question was answered, or its call run, by something",
				);
				const snapshot = await limitedWatch.conn.snapshot();
				assert(
					snapshot.question === null && snapshot.summary.status === "idle",
					`after the limit: ${plain(snapshot.summary)}`,
				);
				await refused(() => limitedWatch.conn.answer({ questionId: asked.id, choice: "once" }), "no_question");
				return `"${said.text}" after ${ran} ms, while waiting; statuses ${limitedWatch.statuses()}`;
			} finally {
				await limitedWatch.conn.dispose().catch(() => undefined);
				await userHandle.deleteSession(limited.id).catch(() => undefined);
			}
		});
	} else {
		skip(
			"the turn's time limit applies while a question waits",
			"needs its own server with the fake layer, restarted with a short limit",
		);
	}

	// --- one owner for a session's sandboxes and its place: a server restarted with one kept sandbox per user ---

	const OWNER_CHECKS = [
		"a sandbox made by a create whose answer was lost is removed by its session's delete",
		"a sandbox found gone is replaced only with a place of its own: at the cap the replacement is refused",
		"a free with a prompt sent at the same moment: the prompt's sandbox and its place survive",
		"a prompt refused for a place gives its running slot back at once, and a late release leaves a newer claim",
		"a sandbox that outlived its session's delete holds no place, and the sweep removes it",
	];
	if (server && FAKE) {
		// Removing a sandbox takes PROVIDER_MS here, so that a prompt sent during a free arrives while the session removes it.
		const PROVIDER_MS = 1_500;
		const holdRemovals = join(server.storage, "hold-sandbox-removals");
		await server.stop();
		await waitFor(`ports ${ENGINE_PORT} and ${HTTP_PORT} to be free`, portsFree, 20_000, 200);
		await server.start({
			WLP_LOGIN_TTL_MS: String(loginTtlMs),
			WLP_MAX_KEPT_SANDBOXES: "1",
			WLP_FAKE_HOLD_REMOVALS: holdRemovals,
			WLP_FAKE_CREATE_FAILS: "1",
			WLP_FAKE_PROVIDER_DELAY_MS: String(PROVIDER_MS),
		});
		const someone = await demoSignIn();
		const theirs = client.user.getOrCreate([someone.profile.uid], { params: { token: someone.token } });
		const turnOf = async (id: string, text: string) => {
			const watch = new Watch(client, someone.profile.uid, id, someone.token);
			try {
				return await watch.untilEnded((await watch.conn.prompt({ text })).turn);
			} finally {
				await watch.conn.dispose().catch(() => undefined);
			}
		};
		const lines = (pattern: string) => server.output.split("\n").filter(line => new RegExp(pattern).test(line));
		const madeFor = (id: string) => lines(`\\[wlp\\] sandbox\\.created id=\\S+ session=${id}`);

		await check(OWNER_CHECKS[0], async () => {
			const orphaned = await theirs.createSession({ profile: availableProfile as never, title: "Its create is lost" });
			// The first create of this server makes its sandbox and then fails, as a create whose answer was lost (WLP_FAKE_CREATE_FAILS).
			const ended = await turnOf(orphaned.id, "Write a short program");
			assert(
				ended.outcome === "error" && /the sandbox was made/.test(ended.message ?? ""),
				`the turn ended ${ended.outcome}: ${ended.message}`,
			);
			await theirs.deleteSession(orphaned.id);
			const swept = lines(`\\[wlp\\] sandbox\\.swept id=\\S+ session=${orphaned.id}`);
			assert(swept.length === 1, `${swept.length} sandboxes swept by the delete`);
			const usage = await theirs.usage();
			assert(usage.sandboxes.kept === 0, `${usage.sandboxes.kept} kept after the delete`);
			return swept[0]!.replace(/^.*sandbox\.swept /, "");
		});

		await check(OWNER_CHECKS[1], async () => {
			const gone = await theirs.createSession({ profile: availableProfile as never, title: "Its sandbox is removed" });
			const other = await theirs.createSession({ profile: availableProfile as never, title: "Takes the one place" });
			try {
				// Its sandbox is removed as the turn ends, as a provider removes one; the session still names it.
				assert(
					(await turnOf(gone.id, "Write a short program (lose-sandbox)")).outcome === "succeeded",
					"the first turn failed",
				);
				// The count drops a place whose sandbox the provider does not list once it is CLAIM_SETTLING_MS old (usage.ts): given back here at once.
				await (await serviceUser(server, someone.profile.uid)).internalRelease(gone.id);
				assert(
					(await turnOf(other.id, "Write a short program")).outcome === "succeeded",
					"the other session's turn failed",
				);
				const before = madeFor(gone.id).length;
				const replaced = await turnOf(gone.id, "Write a short program");
				assert(
					replaced.outcome === "error" &&
						/^You keep 1 hosted sandbox, the most an account may have/.test(replaced.message ?? ""),
					`the replacement ended ${replaced.outcome}: ${replaced.message}`,
				);
				assert(madeFor(gone.id).length === before, "a sandbox was made for it past the cap");
				const usage = await theirs.usage();
				assert(
					usage.sandboxes.kept === 1 && usage.kept[0]?.sessionId === other.id,
					`kept: ${usage.sandboxes.kept}, ${plain(usage.kept.map(k => k.sessionId))}`,
				);
				return `"${replaced.message?.slice(0, 60)}…"; no sandbox made, the one place still the other session's`;
			} finally {
				await theirs.deleteSession(gone.id).catch(() => undefined);
				await theirs.deleteSession(other.id).catch(() => undefined);
			}
		});

		await check(OWNER_CHECKS[2], async () => {
			const freed = await theirs.createSession({ profile: availableProfile as never, title: "Freed while prompted" });
			try {
				assert((await turnOf(freed.id, "Write a short program")).outcome === "succeeded", "the first turn failed");
				const watch = new Watch(client, someone.profile.uid, freed.id, someone.token);
				try {
					// Wait for the fake provider to begin destroying this sandbox before sending the prompt.
					const original = madeFor(freed.id)
						.at(-1)
						?.match(/id=(\S+)/)?.[1];
					assert(original, "the first turn did not create a sandbox");
					const removing = `[wlp] fake sandbox removal started id=${original}`;
					const freeing = (async () => {
						const deadline = Date.now() + 60_000;
						for (;;) {
							try {
								return await theirs.freeSandbox(freed.id);
							} catch (error) {
								if ((error as { code?: string }).code !== "sandbox_busy" || Date.now() >= deadline) throw error;
								await sleep(100);
							}
						}
					})();
					await Promise.race([
						waitFor("sandbox removal to start", () => server.output.includes(removing), 60_000),
						freeing.then(() => {
							throw new Error("the free finished before the concurrent prompt");
						}),
					]);
					const { turn } = await watch.conn.prompt({ text: "Write a short program" });
					await freeing;
					const ended = await watch.untilEnded(turn);
					assert(ended.outcome === "succeeded", `the prompt's turn ended ${ended.outcome}: ${ended.message}`);
				} finally {
					await watch.conn.dispose().catch(() => undefined);
				}
				const made = madeFor(freed.id)
					.at(-1)
					?.match(/id=(\S+)/)?.[1];
				const usage = await theirs.usage();
				const snapshot = await client.agentSession
					.get([someone.profile.uid, freed.id], { params: { token: someone.token } })
					.snapshot();
				assert(
					madeFor(freed.id).length === 2 && snapshot.summary.sandbox !== "none",
					`${madeFor(freed.id).length} sandboxes made; the session's is ${snapshot.summary.sandbox}`,
				);
				assert(
					lines(`sandbox\\.(destroyed|freed|swept) id=${made}`).length === 0,
					`the prompt's sandbox ${made} was removed`,
				);
				assert(
					usage.kept.some(k => k.sessionId === freed.id),
					"the prompt's place was given back by the free",
				);
				return `the old sandbox freed, the prompt's ${made} kept with its place`;
			} finally {
				await theirs.deleteSession(freed.id).catch(() => undefined);
			}
		});

		await check(OWNER_CHECKS[3], async () => {
			const holder = await theirs.createSession({ profile: availableProfile as never, title: "Holds the one place" });
			const refusedOne = await theirs.createSession({ profile: availableProfile as never, title: "Refused a place" });
			try {
				assert((await turnOf(holder.id, "Write a short program")).outcome === "succeeded", "the first turn failed");
				// No sandbox yet, and the one place is taken: the slot is claimed, then the place is refused (holdSandbox).
				const session = client.agentSession.get([someone.profile.uid, refusedOne.id], {
					params: { token: someone.token },
				});
				await refused(() => session.prompt({ text: "Write a short program" }), "too_many_sandboxes");
				const listed = async () => (await theirs.listSessions()).find(entry => entry.id === refusedOne.id)?.status;
				const at = Date.now();
				// Without the release it is listed as starting until the launch check, LAUNCH_LEASE_MS (60 s) after the claim.
				await waitFor(
					"the refused session to be listed idle again",
					async () => (await listed()) === "idle",
					5_000,
					100,
				);
				const freedAfter = Date.now() - at;
				// The user's actor stores the idle summary before it writes its log line: the line is waited for too.
				const released = () => lines(`\\[wlp\\] run\\.released uid=\\S+ session=${refusedOne.id}`).length;
				await waitFor("the release to be logged", async () => released() > 0, 5_000, 100);
				assert(released() === 1, "the release was not logged once");

				// Two claims, and the first one's release arriving late: it leaves the second alone.
				const service = await serviceUser(server, someone.profile.uid);
				const first = await service.internalAcquireRun(refusedOne.id);
				const second = await service.internalAcquireRun(refusedOne.id);
				assert(
					first.ok &&
						second.ok &&
						typeof first.claim === "number" &&
						typeof second.claim === "number" &&
						second.claim > first.claim,
					`claims ${plain(first)} then ${plain(second)}`,
				);
				const summary = (await session.snapshot()).summary;
				const late = await service.internalReleaseRun({ sessionId: refusedOne.id, claim: first.claim, summary });
				assert(
					!late.released && (await listed()) === "starting",
					`the late release ${plain(late)} left it ${await listed()}`,
				);
				const own = await service.internalReleaseRun({ sessionId: refusedOne.id, claim: second.claim, summary });
				assert(own.released && (await listed()) === "idle", `its own release ${plain(own)} left it ${await listed()}`);
				const again = await service.internalReleaseRun({ sessionId: refusedOne.id, claim: second.claim, summary });
				assert(!again.released, "a second release of the same claim released something");
				// Acquire, release, acquire, as fast as the actor takes them (one millisecond, often): the new claim has a name of its own,
				// so a late release of the one before it frees nothing.
				const third = await service.internalAcquireRun(refusedOne.id);
				await service.internalReleaseRun({ sessionId: refusedOne.id, claim: third.claim as number, summary });
				const fourth = await service.internalAcquireRun(refusedOne.id);
				const stale = await service.internalReleaseRun({
					sessionId: refusedOne.id,
					claim: third.claim as number,
					summary,
				});
				assert(
					fourth.claim !== third.claim && !stale.released && (await listed()) === "starting",
					`claims ${third.claim}, ${fourth.claim}; the late release ${plain(stale)}`,
				);
				await service.internalReleaseRun({ sessionId: refusedOne.id, claim: fourth.claim as number, summary });
				return `listed idle ${freedAfter} ms after the refusal; a late release kept the newer claim, its own freed it`;
			} finally {
				await theirs.deleteSession(holder.id).catch(() => undefined);
				await theirs.deleteSession(refusedOne.id).catch(() => undefined);
			}
		});

		await check(OWNER_CHECKS[4], async () => {
			// Keep the marked sandbox through every removal attempt made while deleting its session.
			const orphaned = await theirs.createSession({ profile: availableProfile as never, title: "Outlives its delete" });
			assert(
				(await turnOf(orphaned.id, "Write a short program (outlive-delete)")).outcome === "succeeded",
				"the turn failed",
			);
			writeFileSync(holdRemovals, "");
			await theirs.deleteSession(orphaned.id);
			await waitFor(
				"the provider to refuse the removal",
				() => server.output.includes("fake sandbox removal held id="),
				5_000,
			);
			// With the cap at 1, the orphan would hold the one place: another agent starts all the same.
			const next = await theirs.createSession({ profile: availableProfile as never, title: "After the orphan" });
			try {
				const ended = await turnOf(next.id, "Write a short program");
				assert(ended.outcome === "succeeded", `the next agent's turn ended ${ended.outcome}: ${ended.message}`);
				rmSync(holdRemovals);
				await (await serviceUser(server, someone.profile.uid)).internalSweepSandboxes();
				const removals = () => lines(`\\[wlp\\] sandbox\\.orphan_removed uid=\\S+ id=\\S+ session=${orphaned.id}`);
				await waitFor("the orphan removal to be logged", () => removals().length > 0, 5_000);
				const removed = removals();
				assert(removed.length === 1, `${removed.length} orphan removals logged`);
				const usage = await theirs.usage();
				assert(
					usage.sandboxes.kept === 1 && usage.kept.every(kept => kept.sessionId !== orphaned.id),
					`kept: ${plain(usage.kept.map(k => k.sessionId))}`,
				);
				return removed[0]!.replace(/^.*sandbox\.orphan_removed /, "");
			} finally {
				await theirs.deleteSession(next.id).catch(() => undefined);
			}
		});
	} else {
		for (const name of OWNER_CHECKS) skip(name, "needs its own server with the fake layer");
	}

	if (section !== "core") {
		await usageAndIdleChecks(server, client, userA, availableProfile, demoSignIn);
		if (server) await resumeChecks(server, client, uid, token, availableProfile, LONG);
		else for (const name of RESUME_CHECKS) skip(name, "needs its own server, restarted with WLP_TURN_RESUME");
	}
	await integrationChecks(server, client, userA, availableProfile, demoSignIn);
	await client.dispose().catch(() => undefined);
}

async function usageAndIdleChecks(
	server: Server | null,
	client: Client,
	user: AuthResult,
	availableProfile: string,
	demoSignIn: () => Promise<AuthResult>,
) {
	const {
		profile: { uid },
		token,
	} = user;
	// --- the reply between a session and its user's actor lost (WLP_FAKE_RESERVE_FAULT, user.ts) -----------

	const FAULT_CHECKS = [
		"a turn's first reserve whose reply is lost refuses the prompt, and the hold it opened is counted at 0 s before the next is taken",
		"a renewal whose reply is lost is asked again under the same hold: nothing counted twice, nothing counted in full",
		"with the user's actor away past the hold's grace, the turn runs until shortly before its hold runs out, and stops then with the line that says why",
		"a first hold asked for when the server died is not the next prompt's: that prompt's stretch is counted from its own request",
	];
	if (server && FAKE) {
		const HOLD_S = 5;
		// usage.counted lines of one session, by hold: what the book counted, once each.
		const counted = (session: string) =>
			[
				...server.output.matchAll(
					new RegExp(
						`\\[wlp\\] usage\\.counted uid=\\S+ session=${session} hold=(\\S+) kind=(\\S+) seconds=(-?\\d+)`,
						"g",
					),
				),
			].map(m => ({ hold: m[1]!, kind: m[2]!, seconds: Number(m[3]) }));
		const lost = (session: string, kind: string) =>
			[
				...server.output.matchAll(
					new RegExp(`\\[wlp\\] usage\\.fault_lost uid=\\S+ session=${session} hold=(\\S+) ${kind}:`, "g"),
				),
			].map(m => m[1]!);
		await server.stop();
		await waitFor(`ports ${ENGINE_PORT} and ${HTTP_PORT} to be free`, portsFree, 20_000, 200);
		await server.start({
			WLP_LOGIN_TTL_MS: String(loginTtlMs),
			WLP_USAGE_HOLD_SECONDS: String(HOLD_S),
			WLP_FAKE_RESERVE_FAULT: "lose:1,lose-renewal:1,delay:1500",
		});
		const someone = await demoSignIn();
		const theirs = client.user.getOrCreate([someone.profile.uid], { params: { token: someone.token } });
		const faulted = await theirs.createSession({ profile: availableProfile as never, title: "Its replies are lost" });
		let ran = 0;
		try {
			await check(FAULT_CHECKS[0], async () => {
				const handle = client.agentSession.get([someone.profile.uid, faulted.id], { params: { token: someone.token } });
				const said = await refused(() => handle.prompt({ text: "Write a short program" }), "usage_unavailable");
				const [hold] = lost(faulted.id, "fresh");
				assert(hold, "no reply was lost");
				// The next prompt reports the lost hold first, then takes its own; it is slow, so that it renews (the next check).
				const watch = new Watch(client, someone.profile.uid, faulted.id, someone.token);
				try {
					const { turn } = await watch.conn.prompt({ text: "Fix the failing test (slow)" });
					const started = Date.now();
					const ended = await watch.untilEnded(turn);
					ran = Math.ceil((Date.now() - started) / 1000);
					assert(ended.outcome === "succeeded", `the next turn ended ${ended.outcome}: ${ended.message}`);
				} finally {
					await watch.conn.dispose().catch(() => undefined);
				}
				const ofLost = await waitFor(
					"the lost hold to be counted",
					() => {
						const rows = counted(faulted.id).filter(row => row.hold === hold);
						return rows.length > 0 ? rows : undefined;
					},
					15_000,
					200,
				);
				assert(
					ofLost.length === 1 && ofLost[0]!.kind === "used" && ofLost[0]!.seconds === 0,
					`the lost hold was counted as ${plain(ofLost)}`,
				);
				return `"${said.slice(0, 60)}…"; hold ${hold} counted once, at 0 s`;
			});

			await check(FAULT_CHECKS[1], async () => {
				const [renewal] = lost(faulted.id, "renewal");
				assert(renewal, `no renewal's reply was lost (the turn ran ${ran} s on holds of ${HOLD_S} s)`);
				const rows = await waitFor(
					"the turn's holds to be counted",
					() => {
						const all = counted(faulted.id);
						return all.some(row => row.hold === renewal) ? all : undefined;
					},
					30_000,
					200,
				);
				const holds = rows.map(row => row.hold);
				assert(new Set(holds).size === holds.length, `a hold was counted twice: ${plain(rows)}`);
				assert(!rows.some(row => row.kind === "unreported"), `a hold was counted in full: ${plain(rows)}`);
				// Each counted at most what its stretch can have run: a hold of HOLD_S, or the wait for the retry (METER_RETRY_MS, 15 s) after the lost reply.
				assert(
					rows.every(row => row.seconds <= HOLD_S + 16),
					`a hold was counted past its stretch: ${plain(rows)}`,
				);
				return `${rows.length} holds counted once each (the sandbox runs on after the turn of ${ran} s, renewed every ${HOLD_S} s); the renewal ${renewal} asked again under its id`;
			});
		} finally {
			await theirs.deleteSession(faulted.id).catch(() => undefined);
		}

		await runningSlotRace(server, client, await demoSignIn(), availableProfile);

		await check(FAULT_CHECKS[2], async () => {
			const { UNCHECKED_TURN_NOTE, holdDeadline } = await import("../server/src/usage.js");
			await server.stop();
			await waitFor(`ports ${ENGINE_PORT} and ${HTTP_PORT} to be free`, portsFree, 20_000, 200);
			// The question waits as long as the hold's grace and more: the turn runs on, its sandbox with it, until the meter stops it.
			await server.start({
				WLP_LOGIN_TTL_MS: String(loginTtlMs),
				WLP_USAGE_HOLD_SECONDS: String(HOLD_S),
				WLP_FAKE_RESERVE_FAULT: "down:300000",
				WLP_QUESTION_TIMEOUT_MS: "600000",
			});
			const away = await theirs.createSession({
				profile: availableProfile as never,
				title: "Its user's actor is away",
			});
			const watch = new Watch(client, someone.profile.uid, away.id, someone.token);
			try {
				const promptAt = Date.now();
				const { turn } = await watch.conn.prompt({ text: ASK });
				const deadline = holdDeadline(promptAt, HOLD_S);
				const ended = await watch.untilEnded(turn, deadline - Date.now() + 60_000);
				const line = watch.items.find(
					(item): item is Extract<TimelineItem, { kind: "platform" }> =>
						item.kind === "platform" && item.turn === turn && item.text === UNCHECKED_TURN_NOTE,
				);
				assert(
					line,
					`the turn ended ${ended.outcome} without the line: ${plain(watch.items.filter(item => item.kind === "platform").map(item => (item as { text: string }).text))}`,
				);
				const firstMissed = server.output
					.split("\n")
					.find(text => text.includes(`usage.fault_down uid=${someone.profile.uid} session=${away.id}`));
				assert(firstMissed, "no renewal was refused");
				assert(
					Math.abs(line.at - deadline) < 10_000,
					`stopped ${Math.round((line.at - promptAt) / 1000)} s after the prompt; the hold's deadline was ${Math.round((deadline - promptAt) / 1000)} s`,
				);
				return `stopped ${Math.round((line.at - promptAt) / 1000)} s after the prompt (deadline ${Math.round((deadline - promptAt) / 1000)} s; first renewal refused at about ${HOLD_S} s): "${line.text.slice(0, 60)}…"`;
			} finally {
				await watch.conn.dispose().catch(() => undefined);
				await theirs.deleteSession(away.id).catch(() => undefined);
			}
		});

		await check(FAULT_CHECKS[3], async () => {
			await server.stop();
			await waitFor(`ports ${ENGINE_PORT} and ${HTTP_PORT} to be free`, portsFree, 20_000, 200);
			// A first hold is answered after 5 s: the server dies while the session waits, once it has stored what it asked for.
			await server.start({ WLP_LOGIN_TTL_MS: String(loginTtlMs), WLP_FAKE_RESERVE_FAULT: "delay:5000" });
			const cut = await theirs.createSession({
				profile: availableProfile as never,
				title: "Its first hold was cut off",
			});
			const handle = client.agentSession.get([someone.profile.uid, cut.id], { params: { token: someone.token } });
			const asking = handle.prompt({ text: "Write a short program" }).then(
				() => "answered",
				(error: unknown) => describe(error),
			);
			await sleep(2_000);
			await server.crash();
			const before = await asking;
			await server.start({ WLP_LOGIN_TTL_MS: String(loginTtlMs) });
			// Long enough that a stretch counted from the request before the crash stands out from the turn's own by more than the book's slack.
			await sleep(10_000);
			const from = server.output.length;
			// The prompt is what wakes the session. Until the engine has given the dead server's actor to the new one it
			// refuses the connection (service_unavailable), which never reaches the actor: such a prompt is sent again.
			let watch = new Watch(client, someone.profile.uid, cut.id, someone.token);
			try {
				let turn: number | undefined;
				for (const tryUntil = Date.now() + 30_000; turn === undefined; ) {
					try {
						turn = (await watch.conn.prompt({ text: "Write a short program" })).turn;
					} catch (error) {
						if (!describe(error).includes("service_unavailable") || Date.now() >= tryUntil) throw error;
						await watch.conn.dispose().catch(() => undefined);
						await sleep(1_000);
						watch = new Watch(client, someone.profile.uid, cut.id, someone.token);
					}
				}
				const ended = await watch.untilEnded(turn);
				assert(
					ended.outcome === "succeeded",
					`the turn after the crash ended ${ended.outcome}: ${ended.message ?? ""}`,
				);
				await watch.conn.dispose().catch(() => undefined);
				// Its sleep suspends the sandbox and settles the turn's stretch.
				await forceSleep(cut.id);
				const lines = await waitFor(
					"the turn's hold to be counted",
					() => {
						const found = server.output
							.slice(from)
							.split("\n")
							.filter(text => text.includes(`usage.counted uid=${someone.profile.uid} session=${cut.id} `));
						return found.length > 0 ? found : undefined;
					},
					20_000,
					200,
				);
				// The book counts no more than the time since it took the hold, and says so when a session reports more.
				const over = lines.filter(text => text.includes("since its hold was taken"));
				assert(
					over.length === 0,
					`the session reported a stretch from before the crash: ${over.map(text => text.replace(/^.*usage\.counted /, "")).join("; ")}`,
				);
				return `the prompt cut off by the crash: ${before.slice(0, 60)}; after it: ${lines.map(text => text.replace(/^.*usage\.counted uid=\S+ session=\S+ /, "")).join("; ")}`;
			} finally {
				await watch.conn.dispose().catch(() => undefined);
				await theirs.deleteSession(cut.id).catch(() => undefined);
			}
		});
	} else {
		for (const name of FAULT_CHECKS) skip(name, "needs its own server with the fake layer");
	}

	// --- idle sandboxes, on a server restarted with short idle times ---------------------------------

	if (server) {
		await idleChecks(server, client, uid, token, availableProfile, ASK, LONG);
	} else {
		for (const name of IDLE_CHECKS) skip(name, "needs its own server, restarted with short idle times");
	}
}

async function integrationChecks(
	server: Server | null,
	client: Client,
	user: AuthResult,
	availableProfile: string,
	demoSignIn: () => Promise<AuthResult>,
) {
	const {
		profile: { uid },
		token,
	} = user;
	// --- the agent's memory outlives its sandbox: a server whose sandboxes hold Windlass's sessions, and a bucket ---

	if (server && FAKE) {
		await backupChecks(server, client, uid, token, availableProfile);
	} else {
		for (const name of BACKUP_CHECKS)
			skip(name, "needs its own server with the fake layer, restarted with a stand-in for the bucket");
	}

	// --- GitHub: a server restarted with a GitHub App, and a stand-in for GitHub ---------------------------

	if (server && FAKE) {
		await githubChecks(server, client, demoSignIn, availableProfile);
	} else {
		for (const name of GITHUB_CHECKS)
			skip(name, "needs its own server with the fake layer, restarted with a stand-in for GitHub");
	}

	// --- the user's remembered approvals of projects' MCP servers: sandboxes that keep Windlass's data to themselves ---
	// After the GitHub checks, whose first one is about a server that never had a GitHub App.

	if (server && FAKE) {
		await serverApprovalChecks(server, client, demoSignIn, availableProfile);
	} else {
		for (const name of SERVER_APPROVAL_CHECKS)
			skip(
				name,
				"needs its own server with the fake layer, restarted with sandboxes that keep Windlass's data and with a stand-in for GitHub",
			);
	}

	// --- what browsers connect with ----------------------------------------------------------------
	// Last, so that the checks above run when they always did: several of them are about what an actor
	// does a set time after it was last used.

	await check(
		"the connection for browsers over HTTP: no token, and no endpoint, where the engine asks for none",
		async () => {
			const response = await platformConnection();
			assert(response.ok, `GET /platform/connection answered ${response.status}`);
			assert(
				response.headers.get("content-type")?.startsWith("application/json"),
				`content-type is ${response.headers.get("content-type")}`,
			);
			assert(
				response.headers.get("cache-control") === "no-store",
				`cache-control is ${response.headers.get("cache-control")}`,
			);
			const connection = (await response.json()) as import("../server/src/contract.js").PlatformConnection;
			// With --endpoint the server may be one that issues tokens: then it must say where browsers connect. No token is shown.
			if (OWN_SERVER)
				assert(
					plain(connection) === plain({ endpoint: null, namespace: "default", token: null }),
					`the server answered ${plain({ ...connection, token: connection.token === null ? null : "(a token)" })}`,
				);
			else
				assert(
					typeof connection.namespace === "string" &&
						(connection.token === null || (typeof connection.endpoint === "string" && connection.token.validForMs > 0)),
					"the answer is not a connection",
				);
			const evil = await platformConnection("http://evil.example");
			assert(evil.status === 403, `a page on another site got ${evil.status}`);
			const refusal = (await evil.json()) as { code?: string; token?: unknown };
			assert(
				refusal.code === "origin_not_allowed" &&
					refusal.token === undefined &&
					evil.headers.get("access-control-allow-origin") === null,
				`refused with ${plain({ code: refusal.code })}`,
			);
			const good = await platformConnection("http://localhost:5173");
			assert(
				good.ok && good.headers.get("access-control-allow-origin") === "http://localhost:5173",
				`the web app's origin got ${good.status}, CORS ${good.headers.get("access-control-allow-origin")}`,
			);
			const post = await fetch(`${API}/platform/connection`, { method: "POST" });
			assert(post.status === 405, `POST answered ${post.status}`);
			if (server) {
				assert(
					server.output.includes(
						"[wlp] browsers: the endpoint the web app was built with, with no token (RIVET_ADMIN_TOKEN is not set)",
					),
					"the server did not say at its start what browsers connect with",
				);
				assert(!server.output.includes("connection.token_failed"), "the server tried to issue a token");
			}
			return `endpoint ${connection.endpoint}, namespace ${connection.namespace}, token ${connection.token === null ? "none" : "issued"}; another site 403; POST 405`;
		},
	);

	if (OWN_SERVER) {
		await check(
			"with an admin token and no address for browsers the server refuses to start, in one sentence",
			async () => {
				const { code, output } = await startRefused(env => {
					env.RIVET_ADMIN_TOKEN = "e2e_made_up_admin_token";
				});
				assert(code === 1, `the server exited with ${code}: ${output.slice(-500)}`);
				const lines = output.trim().split("\n");
				assert(
					lines.length === 1 && lines[0].startsWith("[wlp] WLP_PUBLIC_ENDPOINT is not set:"),
					`it said: ${output.slice(0, 600)}`,
				);
				assert(!output.includes("e2e_made_up_admin_token"), "the output shows the admin token");
				assert(await portFree(refusalPort), "it bound its HTTP port before refusing");
				return lines[0];
			},
		);
	} else {
		skip(
			"with an admin token and no address for browsers the server refuses to start, in one sentence",
			"needs to start a server",
		);
	}
}

/**
 * A message that reaches the platform twice (docs/architecture.md, "A message sent twice"): with the key of its
 * submission it is taken once and answered as its first attempt was, also after the session's actor
 * slept and after the server was restarted; without one it is what it always was.
 */
async function submissionChecks(
	server: Server | null,
	client: Client,
	uid: string,
	token: string,
	profile: string,
	LONG: string,
): Promise<void> {
	const user = client.user.getOrCreate([uid], { params: { token } });
	const key = () => randomBytes(16).toString("hex");
	const userItems = (items: TimelineItem[]) =>
		items.filter((item): item is Extract<TimelineItem, { kind: "user" }> => item.kind === "user");
	const launched = key();
	const once = key();
	const steer = key();
	const made = await user.createSession({ profile: profile as never, title: "Sent twice", idempotencyKey: launched });
	const handle = client.agentSession.get([uid, made.id], { params: { token } });
	const watch = new Watch(client, uid, made.id, token);
	await watch.conn.snapshot();
	/** The timeline as it was when the turns had ended: what no repeat may add to. */
	let settled: TimelineItem[] = [];

	try {
		await check(
			"a prompt sent twice with one key while its turn runs, and again after it ended, is one message and one turn",
			async () => {
				const first = await handle.prompt({ text: LONG, idempotencyKey: once });
				assert(first.turn === 1 && first.steered === false, `the first attempt was answered ${plain(first)}`);
				await waitFor("the long command to start", () => watch.windlass(1, "tool.started")[0], TURN_MS);
				const whileRunning = await handle.prompt({ text: LONG, idempotencyKey: once });
				// A message steered into the turn is one submission too.
				const steered = [
					await handle.prompt({ text: "Also, keep the report short.", idempotencyKey: steer }),
					await handle.prompt({ text: "Also, keep the report short.", idempotencyKey: steer }),
				];
				const ended = await watch.untilEnded(1);
				const afterwards = await handle.prompt({ text: LONG, idempotencyKey: once });
				const lateSteer = await handle.prompt({ text: "Also, keep the report short.", idempotencyKey: steer });
				await sleep(500);
				const snapshot = await handle.snapshot();
				assert(
					plain(whileRunning) === plain(first) && plain(afterwards) === plain(first),
					`the three answers: ${plain([first, whileRunning, afterwards])}`,
				);
				assert(
					steered.every(answer => answer.turn === 1 && answer.steered === true) &&
						plain(lateSteer) === plain(steered[0]),
					`the steered message's answers: ${plain([...steered, lateSteer])}`,
				);
				const messages = userItems(snapshot.timeline);
				assert(
					messages.length === 2 && messages[0].text === LONG && !messages[0].steer && messages[1].steer === true,
					`the session's user messages: ${plain(messages.map(item => [item.turn, item.steer === true, item.text]))}`,
				);
				assert(
					snapshot.summary.turns === 1 &&
						snapshot.summary.status === "idle" &&
						snapshot.timeline.at(-1)?.kind === "turn.ended",
					`after the repeats: ${plain(snapshot.summary)}`,
				);
				// Windlass was handed two messages: the prompt and the one steered into its turn.
				const handed = watch.windlass(1, "inbox.enqueued").length;
				assert(
					snapshot.timeline.filter(item => item.kind === "turn.ended").length === 1 && handed === 2,
					`a repeat started a turn or reached Windlass: ${handed} messages were handed to it`,
				);
				assert(
					!plain(snapshot).includes(once) && !plain(watch.items).includes(steer),
					"a key is in what a client is sent",
				);
				settled = snapshot.timeline;
				return `three answers ${plain(first)}, a steered message three times ${plain(steered[0])}; ${messages.length} user messages, 1 turn, ended ${ended.outcome}`;
			},
		);

		await check(
			"a key that is no key, or that comes with another message, is refused and changes nothing",
			async () => {
				for (const bad of ["", "k".repeat(256), 7])
					await refused(
						() => handle.prompt({ text: "Explore the workspace", idempotencyKey: bad as never }),
						"bad_idempotency_key",
					);
				const message = await refused(
					() => handle.prompt({ text: "Something else entirely", idempotencyKey: once }),
					"idempotency_key_reused",
				);
				await refused(
					() => user.createSession({ profile: profile as never, title: "Another one", idempotencyKey: launched }),
					"idempotency_key_reused",
				);
				await refused(
					() => user.createSession({ profile: profile as never, idempotencyKey: "" }),
					"bad_idempotency_key",
				);
				assert(plain((await handle.snapshot()).timeline) === plain(settled), "a refused prompt changed the timeline");
				return message;
			},
		);

		await check(
			"the keys outlive the actor's sleep; createSession with its key again answers with the same agent",
			async () => {
				await watch.conn.dispose();
				await forceSleep(made.id);
				await sleep(2_500);
				const answer = await handle.prompt({ text: LONG, idempotencyKey: once });
				const again = await user.createSession({
					profile: profile as never,
					title: "Sent twice",
					idempotencyKey: launched,
				});
				const snapshot = await handle.snapshot();
				assert(
					plain(answer) === plain({ turn: 1, steered: false }) &&
						plain(snapshot.timeline) === plain(settled) &&
						snapshot.summary.turns === 1,
					`after the sleep: ${plain(answer)}, ${snapshot.timeline.length} items, was ${settled.length}`,
				);
				assert(
					again.id === made.id &&
						(await user.listSessions()).filter(entry => entry.title === "Sent twice").length === 1,
					`createSession again answered with ${again.id}, the first with ${made.id}`,
				);
				return `prompt answered ${plain(answer)} with nothing added; createSession answered with ${again.id} again`;
			},
		);

		if (server) {
			await check("the keys outlive a server restart", async () => {
				await server.stop();
				await waitFor(`ports ${ENGINE_PORT} and ${HTTP_PORT} to be free`, portsFree, 20_000, 200);
				await server.start({ WLP_LOGIN_TTL_MS: String(loginTtlMs) });
				const answer = await handle.prompt({ text: LONG, idempotencyKey: once });
				const steered = await handle.prompt({ text: "Also, keep the report short.", idempotencyKey: steer });
				const again = await user.createSession({
					profile: profile as never,
					title: "Sent twice",
					idempotencyKey: launched,
				});
				const snapshot = await handle.snapshot();
				assert(
					plain(answer) === plain({ turn: 1, steered: false }) && plain(steered) === plain({ turn: 1, steered: true }),
					`after the restart: ${plain([answer, steered])}`,
				);
				assert(
					plain(snapshot.timeline) === plain(settled) &&
						snapshot.summary.turns === 1 &&
						snapshot.summary.status === "idle",
					`after the restart the session has ${snapshot.timeline.length} items, had ${settled.length}`,
				);
				assert(again.id === made.id, `createSession again answered with ${again.id}, the first with ${made.id}`);
				return `prompt ${plain(answer)}, steered message ${plain(steered)}, agent ${again.id}: all as before the restart`;
			});
		} else {
			skip("the keys outlive a server restart", "needs to restart the server");
		}

		await check(
			"without a key the same prompt again is a second message, and after the turn a second turn",
			async () => {
				const second = new Watch(client, uid, made.id, token);
				try {
					const first = await handle.prompt({ text: LONG });
					assert(first.turn === 2 && first.steered === false, `the prompt was answered ${plain(first)}`);
					await waitFor("the long command to start", () => second.windlass(2, "tool.started")[0], TURN_MS);
					const again = await handle.prompt({ text: LONG });
					assert(again.turn === 2 && again.steered === true, `the same prompt again was answered ${plain(again)}`);
					await handle.stop();
					await second.untilEnded(2);
					const third = await handle.prompt({ text: LONG });
					assert(
						third.turn === 3 && third.steered === false,
						`the same prompt after the turn was answered ${plain(third)}`,
					);
					await waitFor("the third turn to start", () => second.summaries.at(-1)?.status === "running", TURN_MS);
					await handle.stop();
					await second.untilEnded(3);
					const messages = userItems((await handle.snapshot()).timeline).filter(item => item.turn > 1);
					assert(messages.length === 3, `turns 2 and 3 have ${messages.length} user messages`);
					return "answered {turn 2}, {turn 2, steered}, {turn 3}: three messages, two turns";
				} finally {
					await second.conn.dispose().catch(() => undefined);
				}
			},
		);
	} finally {
		await watch.conn.dispose().catch(() => undefined);
		await user.deleteSession(made.id).catch(() => undefined);
	}
}

const IDLE_CHECKS = [
	"an idle sandbox is suspended by itself, with one line in the timeline",
	"a prompt after an automatic suspend resumes the sandbox",
	"no suspend while a turn runs or waits on a question",
	"the running-sessions count after an automatic suspend",
	"an idle sandbox is removed after the longer time; the timeline stays and the next prompt starts a new one",
	"the idle checks hold across a server restart",
	"a prompt that wakes a session with a paused sandbox keeps its hold while the provider is slow to say the state",
	"a removal that falls due while a read of the workspace resumes the sandbox leaves it, and the check comes back",
	"a session put to sleep is woken by its schedule, and a removal cut off by a crash is armed again on the next wake and runs",
];

async function idleChecks(
	server: Server,
	client: Client,
	uid: string,
	token: string,
	profile: string,
	ASK: string,
	LONG: string,
): Promise<void> {
	const SUSPEND_MS = FAKE ? 3_000 : 6_000;
	const DESTROY_MS = FAKE ? 12_000 : 25_000;
	const seconds = (ms: number) => `${ms / 1000} seconds`;
	const SUSPENDED = `Suspended the sandbox after ${seconds(SUSPEND_MS)} without use; the next prompt resumes it.`;
	const REMOVED = `Removed the sandbox and its files after ${seconds(DESTROY_MS)} without use; the next prompt starts a new one.`;
	await server.stop();
	await waitFor(`ports ${ENGINE_PORT} and ${HTTP_PORT} to be free`, portsFree, 20_000, 200);
	await server.start({
		WLP_IDLE_SUSPEND_MS: String(SUSPEND_MS),
		WLP_IDLE_DESTROY_MS: String(DESTROY_MS),
		WLP_LOGIN_TTL_MS: String(loginTtlMs),
	});

	const userHandle = client.user.getOrCreate([uid], { params: { token } });
	const idle = await userHandle.createSession({ profile: profile as never, title: "Idle" });
	const handle = client.agentSession.get([uid, idle.id], { params: { token } });
	const watch = new Watch(client, uid, idle.id, token);
	type PlatformItem = Extract<TimelineItem, { kind: "platform" }>;
	const lines = (text: string) =>
		watch.items.filter((item): item is PlatformItem => item.kind === "platform" && item.text === text);
	const logged = (what: string) =>
		[...server.output.matchAll(new RegExp(`\\[wlp\\] sandbox\\.${what} id=(\\S+) session=${idle.id}`, "g"))].map(
			match => match[1],
		);
	const sandboxOf = () =>
		[...server.output.matchAll(/\[wlp\] sandbox\.created id=(\S+) session=(\S+)/g)]
			.filter(match => match[2] === idle.id)
			.map(match => match[1])
			.at(-1);
	let ok = true;
	const step = async (name: string, body: () => Promise<string | undefined>) => {
		if (!ok) {
			skip(name, "an earlier idle check failed");
			return;
		}
		ok = await check(name, body);
	};

	try {
		await step(IDLE_CHECKS[0], async () => {
			await refused(() => handle.internalIdle(), "forbidden");
			const { turn } = await watch.conn.prompt({ text: "Write a short program" });
			const ended = await watch.untilEnded(turn);
			const line = await waitFor("the suspend line", () => lines(SUSPENDED)[0], SUSPEND_MS + 20_000, 100);
			const after = line.at - ended.at;
			assert(
				after >= SUSPEND_MS - 100 && after < SUSPEND_MS + 10_000,
				`suspended ${after} ms after the turn ended; the idle time is ${SUSPEND_MS} ms`,
			);
			assert(line.kind === "platform" && line.level === "info" && line.turn === turn, `the line is ${plain(line)}`);
			await waitFor(
				"the summary to show the sandbox paused",
				() => watch.summaries.at(-1)?.sandbox === "paused",
				5_000,
			);
			const listed = await waitFor(
				"the user's list to show it",
				async () => {
					const entry = (await userHandle.listSessions()).find(candidate => candidate.id === idle.id);
					return entry?.sandbox === "paused" ? entry : undefined;
				},
				5_000,
				100,
			);
			assert(listed.status === "idle", `the user's list shows ${listed.status}`);
			const id = logged("idle_suspended")[0];
			assert(id && id === sandboxOf(), "the server did not log the suspend of this session's sandbox");
			if (!FAKE) assert(containerState(id) !== "running", `container wlp-session-${id} is still running`);
			return `after ${after} ms: "${line.text}"${FAKE ? "" : `; docker: ${containerState(id)}`}`;
		});

		await step(IDLE_CHECKS[1], async () => {
			const { turn } = await watch.conn.prompt({ text: "Write a short program" });
			const ended = await watch.untilEnded(turn);
			assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
			assert(
				watch.items.some(item => item.kind === "platform" && item.turn === turn && item.text === "Resuming sandbox"),
				'no "Resuming sandbox" item',
			);
			assert(
				!watch.items.some(
					item => item.kind === "platform" && item.turn === turn && item.text.startsWith("Starting a hosted sandbox"),
				),
				"a new sandbox was created",
			);
			if (!FAKE) assert(containerState(sandboxOf() ?? "") === "running", "the container is not running after the turn");
			return `turn ${turn} ${ended.outcome} in the same sandbox`;
		});

		await step(IDLE_CHECKS[2], async () => {
			// The turn before this one armed a check that falls due while this one waits on its question.
			const kept = server.output
				.split("\n")
				.filter(line => line.includes(`sandbox.idle_kept session=${idle.id}`)).length;
			const suspends = logged("idle_suspended").length;
			const { turn } = await watch.conn.prompt({ text: ASK });
			const asked = await watch.untilQuestion(turn);
			await waitFor(
				"the idle check to find the turn",
				() =>
					server.output.split("\n").filter(line => line.includes(`sandbox.idle_kept session=${idle.id}`)).length > kept,
				SUSPEND_MS + 10_000,
				100,
			);
			await sleep(1_000);
			assert(
				logged("idle_suspended").length === suspends && lines(SUSPENDED).length === 1,
				"the sandbox was suspended while the turn waited on a question",
			);
			const waiting = await handle.snapshot();
			assert(
				waiting.summary.status === "waiting" &&
					waiting.summary.sandbox === "running" &&
					waiting.question?.id === asked.id,
				`while waiting: ${plain(waiting.summary)}`,
			);
			const waited = Date.now() - asked.askedAt;
			await watch.conn.answer({ questionId: asked.id, choice: "once" });
			const ended = await watch.untilEnded(turn);
			assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
			const line = await waitFor(
				"the suspend after the answered turn",
				() => lines(SUSPENDED)[1],
				SUSPEND_MS + 20_000,
				100,
			);
			assert(line.at - ended.at >= SUSPEND_MS - 100, "suspended before the idle time after the turn had passed");
			return `kept while the question waited ${waited} ms (idle time ${SUSPEND_MS} ms); suspended ${line.at - ended.at} ms after the answered turn ended`;
		});

		if (FAKE) {
			await step(IDLE_CHECKS[3], async () => {
				const others = [
					await userHandle.createSession({ profile: profile as never, title: "busy 1" }),
					await userHandle.createSession({ profile: profile as never, title: "busy 2" }),
					await userHandle.createSession({ profile: profile as never, title: "one too many" }),
				];
				const handles = others.map(entry => client.agentSession.get([uid, entry.id], { params: { token } }));
				try {
					const entry = (await userHandle.listSessions()).find(candidate => candidate.id === idle.id);
					assert(
						entry?.status === "idle" && entry.sandbox === "paused",
						`the suspended session is listed as ${plain(entry)}`,
					);
					await handles[0].prompt({ text: LONG });
					await handles[1].prompt({ text: LONG });
					// Suspended, it holds no place: it can take the third.
					const { turn } = await handle.prompt({ text: LONG });
					const message = await refused(() => handles[2].prompt({ text: "One too many" }), "too_many_running");
					await handle.stop();
					await watch.untilEnded(turn);
					await handles[0].stop();
					await handles[1].stop();
					await waitFor(
						"the busy sessions to be idle",
						async () =>
							(await Promise.all(handles.slice(0, 2).map(one => one.snapshot()))).every(
								snap => snap.summary.status === "idle",
							),
						15_000,
						100,
					);
					return `the suspended session took the third place; the fourth was refused: "${message}"`;
				} finally {
					for (const entry of others) await userHandle.deleteSession(entry.id).catch(() => undefined);
				}
			});
		} else {
			skip(IDLE_CHECKS[3], "four containers at once is too much for this machine; run in fake mode");
		}

		await step(IDLE_CHECKS[4], async () => {
			// The last turn of this session has ended; nothing touches it until the removal.
			const lastEnd = [...watch.items].reverse().find(item => item.kind === "turn.ended");
			assert(lastEnd, "no turn has ended");
			const id = sandboxOf();
			assert(id, "no sandbox was logged for the session");
			const line = await waitFor("the removal line", () => lines(REMOVED)[0], DESTROY_MS + 30_000, 200);
			const after = line.at - lastEnd.at;
			assert(
				after >= DESTROY_MS - 100 && after < DESTROY_MS + 15_000,
				`removed ${after} ms after the last turn ended; the time is ${DESTROY_MS} ms`,
			);
			await waitFor("the summary to show no sandbox", () => watch.summaries.at(-1)?.sandbox === "none", 5_000);
			assert(logged("idle_removed").includes(id), "the server did not log the removal of this session's sandbox");
			if (!FAKE) assert(containerState(id) === "gone", `container wlp-session-${id} is ${containerState(id)}`);
			const snapshot = await handle.snapshot();
			assert(plain(snapshot.timeline) === plain(watch.items), "the timeline differs from what was seen");
			dense(snapshot.timeline);
			const { turn } = await watch.conn.prompt({ text: "Write a short program" });
			const ended = await watch.untilEnded(turn);
			assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
			const fresh = watch.items.filter(item => item.kind === "platform" && item.turn === turn);
			assert(
				fresh.some(item => item.kind === "platform" && item.text.startsWith("Starting a hosted sandbox")),
				'no "Starting a hosted sandbox" item',
			);
			assert(
				!fresh.some(item => item.kind === "platform" && item.level === "warn"),
				"the new sandbox came with a warning",
			);
			return `after ${after} ms: "${line.text}"; ${snapshot.timeline.length} items readable; turn ${turn} in a new sandbox`;
		});

		await step(IDLE_CHECKS[5], async () => {
			const lastEnd = [...watch.items].reverse().find(item => item.kind === "turn.ended");
			assert(lastEnd, "no turn has ended");
			const removals = logged("idle_removed").length;
			// Nobody is connected to the session from here on: only its schedule can wake it.
			await watch.conn.dispose().catch(() => undefined);
			await server.stop();
			await waitFor(`ports ${ENGINE_PORT} and ${HTTP_PORT} to be free`, portsFree, 20_000, 200);
			const restarted = Date.now();
			await server.start({
				WLP_IDLE_SUSPEND_MS: String(SUSPEND_MS),
				WLP_IDLE_DESTROY_MS: String(DESTROY_MS),
				WLP_LOGIN_TTL_MS: String(loginTtlMs),
			});
			await waitFor(
				"the removal after the restart",
				() => logged("idle_removed").length > removals,
				DESTROY_MS + 40_000,
				200,
			);
			const snapshot = await handle.snapshot();
			const line = snapshot.timeline.filter(item => item.kind === "platform" && item.text === REMOVED).at(-1);
			assert(
				line && line.at >= restarted && line.at >= lastEnd.at + DESTROY_MS - 100,
				`the removal line is ${plain(line)}`,
			);
			assert(snapshot.summary.sandbox === "none", `the sandbox is ${snapshot.summary.sandbox}`);
			if (!FAKE) assert(containerState(logged("idle_removed").at(-1) ?? "") === "gone", "the container still exists");
			return `removed ${line.at - lastEnd.at} ms after the last turn, by a server started ${restarted - lastEnd.at} ms after it`;
		});

		if (FAKE) {
			// From here the fake provider is slow: resuming a paused sandbox, saying its state and removing one each take PROVIDER_MS.
			const PROVIDER_MS = 4_000;
			const idleEnv = {
				WLP_IDLE_SUSPEND_MS: String(SUSPEND_MS),
				WLP_IDLE_DESTROY_MS: String(DESTROY_MS),
				WLP_LOGIN_TTL_MS: String(loginTtlMs),
			};
			const count = (what: string) => server.output.split("\n").filter(line => line.includes(what)).length;
			const busyLines = () => count(`sandbox.idle_busy session=${idle.id}`);
			const firings = () => count(`schedule.fired session=${idle.id} action=internalIdle`);
			await step(IDLE_CHECKS[6], async () => {
				await server.stop();
				await waitFor(`ports ${ENGINE_PORT} and ${HTTP_PORT} to be free`, portsFree, 20_000, 200);
				await server.start({ ...idleEnv, WLP_FAKE_PROVIDER_DELAY_MS: String(PROVIDER_MS) });
				const first = new Watch(client, uid, idle.id, token);
				const made = await first.conn.prompt({ text: "Write a short program" });
				await first.untilEnded(made.turn);
				await first.conn.dispose().catch(() => undefined);
				// Asleep with its sandbox paused, nothing connected: the prompt wakes the actor, whose read of the paused sandbox's state takes PROVIDER_MS.
				await forceSleep(idle.id);
				await sleep(2_500);
				const row = async () => (await userHandle.usage()).today.find(entry => entry.sessionId === idle.id);
				const countedBefore = (await row())?.seconds ?? 0;
				const { turn } = await handle.prompt({ text: "Fix the failing test (slow)" });
				await sleep(PROVIDER_MS + 1_500);
				// A waking provider can still be starting at the first sample. Check the hold
				// throughout startup and on the running turn, before it can legitimately settle.
				const { mid, held } = await waitFor(
					"the resumed turn to run with its hold",
					async () => {
						const mid = await handle.snapshot();
						const held = (await row())?.heldSeconds ?? 0;
						assert(held > 0, "mid-turn the session holds 0 s: the wake closed the prompt's hold");
						if (mid.summary.status === "starting") return undefined;
						assert(mid.summary.status === "running", `the turn is ${mid.summary.status} when it is looked at`);
						return { mid, held };
					},
					TURN_MS,
					100,
				);
				assert(mid.summary.sandbox === "running", `the running sandbox is recorded as ${mid.summary.sandbox}`);
				const done = await waitFor(
					"the turn to end",
					async () => {
						const now = await handle.snapshot();
						return now.summary.status === "idle"
							? now.timeline.find(item => item.kind === "turn.ended" && item.turn === turn)
							: undefined;
					},
					TURN_MS,
					200,
				);
				const ran = Math.floor(
					(done.at - mid.timeline.find(item => item.kind === "user" && item.turn === turn)!.at) / 1000,
				);
				const counted = await waitFor(
					"the hold to be settled once the sandbox is suspended",
					async () => {
						const now = await row();
						return now && now.heldSeconds === 0 ? now.seconds - countedBefore : undefined;
					},
					SUSPEND_MS + 3 * PROVIDER_MS + 10_000,
					300,
				);
				assert(counted >= ran - 1, `${counted} s counted for a turn of ${ran} s`);
				return `held ${held} s mid-turn; ${counted} s counted for a turn of ${ran} s`;
			});

			await step(IDLE_CHECKS[7], async () => {
				const slow = new Watch(client, uid, idle.id, token);
				// It winds down slowly when stopped, so the sleep has begun before its end could copy the workspace.
				const { turn } = await slow.conn.prompt({ text: "Fix the failing test (slow) (slow-stop)" });
				await waitFor("the turn to stream", () => slow.deltas.some(delta => delta.turn === turn), TURN_MS);
				await slow.conn.dispose().catch(() => undefined);
				// A turn stopped by its actor's sleep leaves no copy of the workspace, so a read resumes the paused sandbox.
				const sleptAt = Date.now();
				await forceSleep(idle.id);
				await sleep(sleptAt + DESTROY_MS - 2_000 - Date.now());
				const id = sandboxOf();
				const busyBefore = busyLines();
				const removals = logged("idle_removed").length;
				const suspends = logged("idle_suspended").length;
				const readAt = Date.now();
				const files = await handle.changes();
				const answered = Date.now();
				assert(
					answered - readAt >= PROVIDER_MS,
					`the read took ${answered - readAt} ms: it answered from a copy, not from the sandbox`,
				);
				// The read marks the sandbox used as it resumes it, and sets the check for its idle time from then
				// (`markUsed`); the removal that fell due under it was deferred (IDLE_RETRY_MS in agent-session.ts).
				// So what comes next is that check, which suspends the sandbox the read left running. When it does
				// depends on the host: no sample at a set time after the read can expect "running".
				const next = await waitFor(
					"the sandbox to be suspended or removed after the read",
					() =>
						logged("idle_removed").length > removals
							? "removed"
							: logged("idle_suspended").length > suspends
								? "suspended"
								: undefined,
					SUSPEND_MS + 2 * PROVIDER_MS + 15_000,
					200,
				);
				assert(next === "suspended", "the sandbox was removed under the read");
				assert(
					logged("idle_suspended").at(-1) === id && sandboxOf() === id,
					`the suspended sandbox is ${logged("idle_suspended").at(-1)}, the session's was ${id}`,
				);
				assert(busyLines() > busyBefore, "the removal did not fall due while the read resumed the sandbox");
				const after = await handle.snapshot();
				const line = after.timeline.filter(item => item.kind === "platform" && item.text === SUSPENDED).at(-1);
				// The sandbox ran the idle time from the read before it was suspended: the read had resumed it, and the check came back for it.
				assert(
					line && line.at >= readAt + PROVIDER_MS + SUSPEND_MS - 100,
					`the suspend line is ${plain(line)}; the read began at ${readAt}`,
				);
				return `${files.length} files read from the resumed sandbox in ${answered - readAt} ms; the removal deferred, and the check came back and suspended it ${line.at - answered} ms after the read`;
			});

			await step(IDLE_CHECKS[8], async () => {
				const fresh = new Watch(client, uid, idle.id, token);
				const made = await fresh.conn.prompt({ text: "Write a short program" });
				await fresh.untilEnded(made.turn);
				await fresh.conn.dispose().catch(() => undefined);
				const before = firings();
				// Nobody is connected and the actor is made to sleep, which pauses the sandbox and leaves the removal to its schedule: only that wakes it.
				await forceSleep(idle.id);
				await waitFor(
					"the schedule to wake the session for its removal",
					() => firings() > before,
					DESTROY_MS + 30_000,
					100,
				);
				const fired = server.output
					.split("\n")
					.filter(line => line.includes(`schedule.fired session=${idle.id}`))
					.at(-1);
				// The removal takes PROVIDER_MS: the server dies under it, after the schedule let go of the check and before it set the next.
				await sleep(1_000);
				await server.crash();
				await server.start(idleEnv);
				const removals = logged("idle_removed").length;
				await handle.snapshot();
				await waitFor("the removal after the wake", () => logged("idle_removed").length > removals, 20_000, 200);
				const snapshot = await handle.snapshot();
				assert(
					snapshot.summary.sandbox === "none" &&
						snapshot.timeline.some(item => item.kind === "platform" && item.text === REMOVED),
					`after the wake: ${plain(snapshot.summary)}`,
				);
				return `${fired?.replace(/^.*schedule\.fired /, "") ?? "?"}; after the crash the wake armed it again and it removed the sandbox`;
			});
		} else {
			for (const name of IDLE_CHECKS.slice(6)) skip(name, "needs the fake layer's slow provider");
		}
	} finally {
		await watch.conn.dispose().catch(() => undefined);
		await userHandle.deleteSession(idle.id).catch(() => undefined);
	}
}

// ---------------------------------------------------------------------------------------------
// A turn that pauses and resumes across a restart (WLP_TURN_RESUME, server/src/actors/turn-resume.ts)
// ---------------------------------------------------------------------------------------------

const RESUME_CHECKS = [
	"a turn running when the server stops (SIGTERM) pauses, and resumes as the same turn on the next server",
	"a turn cut off by a crash (SIGKILL) is woken by its heartbeat on the next server, and resumes",
	"a message sent to a paused turn is held, shown, and given to the agent when it resumes; Stop ends a paused turn at once",
	"a resumed turn gets what is left of its limit, at least the floor: the paused time does not count",
	"an agent whose memory went with its sandbox is given the whole task, rebuilt from the timeline",
	"crashes in a row while resuming, with nothing done in between, end the turn as interrupted",
];

/**
 * Turns that outlive their server: each server here is started with WLP_TURN_RESUME, a heartbeat of a few seconds, and,
 * on the fake layer, events slow enough that a turn is still running when the server goes. The fake layer's sandboxes
 * live in the server's memory, so after a restart a turn resumes in a new one: with Windlass's sessions kept per user
 * (as on Docker) its memory is kept, and with WLP_FAKE_BACKUP_DIR (as on E2B) it goes with the old sandbox.
 */
async function resumeChecks(
	server: Server,
	client: Client,
	uid: string,
	token: string,
	profile: string,
	LONG: string,
): Promise<void> {
	type Ended = Extract<TimelineItem, { kind: "turn.ended" }>;
	type Platform = Extract<TimelineItem, { kind: "platform" }>;
	const userHandle = client.user.getOrCreate([uid], { params: { token } });
	const plainEnv: Record<string, string> = { WLP_LOGIN_TTL_MS: String(loginTtlMs) };
	const base: Record<string, string> = {
		WLP_TURN_RESUME: "1",
		WLP_TURN_HEARTBEAT_MS: "4000",
		WLP_LOGIN_TTL_MS: String(loginTtlMs),
		...(FAKE && { WLP_FAKE_DELAY_MS: "60" }),
	};
	let env = base;
	const restart = async (how: "stop" | "crash", extra: Record<string, string> = {}) => {
		if (how === "stop") await server.stop();
		else await server.crash();
		await waitFor(`ports ${ENGINE_PORT} and ${HTTP_PORT} to be free`, portsFree, 20_000, 200);
		env = { ...base, ...extra };
		await server.start(env);
	};
	const handleOf = (id: string) => client.agentSession.get([uid, id], { params: { token } });
	/** The sessions made here, deleted at the end: their sandboxes go with them. */
	const made: string[] = [];
	const make = async (title: string, selectedProfile = profile) => {
		const id = (await userHandle.createSession({ profile: selectedProfile as never, title })).id;
		made.push(id);
		return id;
	};
	try {
		/** Starts a turn and waits until it streams and its first events are stored: the agent has its prompt. */
		const startLong = async (id: string, text = LONG) => {
			const watch = new Watch(client, uid, id, token);
			try {
				const { turn } = await watch.conn.prompt({ text });
				await waitFor(
					`turn ${turn} to stream`,
					() =>
						watch.deltas.some(delta => delta.turn === turn) ||
						watch.items.some(item => item.kind === "windlass" && item.turn === turn),
					TURN_MS,
				);
				await sleep(1_500);
				return turn;
			} finally {
				await watch.conn.dispose().catch(() => undefined);
			}
		};
		/** Snapshots until turn `turn` has ended and the session is idle. */
		const endedOf = (id: string, turn: number, timeoutMs = 3 * TURN_MS) =>
			waitFor(
				`turn ${turn} of ${id} to end`,
				async () => {
					const snap = await handleOf(id).snapshot();
					const ended = snap.timeline.find((item): item is Ended => item.kind === "turn.ended" && item.turn === turn);
					return ended && snap.summary.status === "idle" ? { snap, ended } : undefined;
				},
				timeoutMs,
				500,
			);
		/** What a resumed turn's timeline must say: one pause, one resume, one end, and nothing cut short. */
		const resumedOnce = (timeline: TimelineItem[], turn: number) => {
			const notes = timeline.filter((item): item is Platform => item.kind === "platform" && item.turn === turn);
			const paused = notes.filter(item => item.code === "turn_paused");
			const resumed = notes.filter(item => item.code === "turn_resumed");
			const ends = timeline.filter(item => item.kind === "turn.ended" && item.turn === turn);
			assert(ends.length === 1, `turn ${turn} has ${ends.length} turn.ended items`);
			assert(
				paused.length >= 1 && resumed.length >= 1,
				`turn ${turn} paused ${paused.length} times and resumed ${resumed.length} times`,
			);
			assert(!notes.some(item => /cut short/.test(item.text)), "a line says the turn was cut short");
			dense(timeline);
			return { paused, resumed };
		};
		/** The prompts the agent was given in the turn after its resume, as the engine echoed them. */
		const promptsAfter = (timeline: TimelineItem[], turn: number, seq: number) =>
			timeline
				.filter(
					item =>
						item.kind === "windlass" && item.turn === turn && item.seq > seq && item.event.type === "inbox.enqueued",
				)
				.map(item => JSON.stringify(item.kind === "windlass" ? item.event.data : null));
		let ok = true;
		const step = async (name: string, body: () => Promise<string | undefined>) => {
			if (!ok) {
				skip(name, "an earlier check of resuming failed");
				return;
			}
			ok = await check(name, body);
		};

		await restart("stop");

		await step(RESUME_CHECKS[0], async () => {
			const id = await make("Paused by a deploy");
			const turn = await startLong(id);
			const from = server.output.length;
			await restart("stop");
			const log = server.output.slice(from);
			assert(
				log.includes(`[wlp] turn.paused session=${id} turn=${turn} reason=restart`),
				"the server did not log the pause",
			);
			assert(
				log.includes(`[wlp] sandbox.kept_for_resume`) && log.includes(`session=${id}`),
				"the sandbox of the paused turn was not kept running for it",
			);
			const { snap, ended } = await endedOf(id, turn);
			const { paused, resumed } = resumedOnce(snap.timeline, turn);
			assert(ended.outcome === "succeeded", `the turn ended ${ended.outcome}: ${ended.message ?? ""}`);
			assert(
				paused[0]!.text === "The server is restarting; this turn will resume by itself.",
				`the pause says: ${paused[0]!.text}`,
			);
			assert(
				resumed[0]!.text.startsWith("Resumed after a server restart (the turn was paused "),
				`the resume says: ${resumed[0]!.text}`,
			);
			assert(
				snap.summary.turns === turn && snap.summary.lastOutcome === "succeeded",
				`summary: ${plain(snap.summary)}`,
			);
			const row = (await userHandle.usage()).today.find(entry => entry.sessionId === id);
			const resumeTime = resumed[0]!.at;
			const segmentSeconds = (ended.at - resumeTime) / 1000;
			assert(
				row && row.seconds >= Math.floor(ended.durationMs / 1000) - 1 && row.unreportedSeconds === 0,
				`the counted sandbox time does not cover the completed turn: ${plain(row)}, active ${ended.durationMs} ms`,
			);
			const resumeLog = server.output.slice(server.output.indexOf(`turn.resumed session=${id} turn=${turn}`, from));
			const reports = [...resumeLog.matchAll(/usage\.counted uid=\S+ session=(\S+) hold=\S+ kind=used seconds=(\d+)/g)];
			assert(
				reports.some(m => m[1] === id && Number(m[2]) >= Math.floor(segmentSeconds) - 1),
				"the resumed segment was not settled before the turn ended",
			);
			if (FAKE) {
				assert(
					snap.timeline.some(
						item =>
							item.kind === "windlass" &&
							item.turn === turn &&
							item.event.type === "execution.interrupted" &&
							item.event.data?.reason === "shutdown",
					),
					"the restart was not reported as a shutdown",
				);
				const given = promptsAfter(snap.timeline, turn, resumed[0]!.seq);
				assert(
					given.some(text => text.includes("The platform restarted while you were working on this turn")),
					`the agent was given: ${given.join(" | ").slice(0, 300)}`,
				);
			}
			return `turn ${turn}: ${resumed[0]!.text}, then ${ended.outcome}`;
		});

		await step(RESUME_CHECKS[1], async () => {
			const id = await make("Cut off by a crash");
			const turn = await startLong(id);
			const from = server.output.length;
			await restart("crash");
			// Nothing asks the session anything: the wake its heartbeat kept scheduled brings it back.
			await waitFor(
				"the heartbeat's wake to pause the turn",
				() => server.output.slice(from).includes(`[wlp] turn.crashed session=${id} turn=${turn} crashes=1`),
				60_000,
				250,
			);
			const { snap, ended } = await endedOf(id, turn);
			const { paused, resumed } = resumedOnce(snap.timeline, turn);
			assert(ended.outcome === "succeeded", `the turn ended ${ended.outcome}: ${ended.message ?? ""}`);
			assert(
				paused[0]!.text === "The server stopped while this turn was running; it will resume by itself.",
				`the pause says: ${paused[0]!.text}`,
			);
			assert(resumed[0]!.text.startsWith("Resumed after a server restart"), `the resume says: ${resumed[0]!.text}`);
			return `woken by its heartbeat; ${resumed[0]!.text}`;
		});

		if (!FAKE) {
			for (const name of RESUME_CHECKS.slice(2)) skip(name, "times its turns by the fake layer's events");
			return;
		}

		// A server that waits before it resumes, so the pause can be looked at; a short limit, with a floor.
		const LIMIT_MS = 16_000;
		const FLOOR_MS = 7_000;
		const DELAY_MS = 75_000;
		const limits = {
			WLP_TURN_TIMEOUT_MS: String(LIMIT_MS),
			WLP_TURN_RESUME_FLOOR_MS: String(FLOOR_MS),
			WLP_TURN_RESUME_DELAY_MS: String(DELAY_MS),
		};
		const held = {
			id: "",
			turn: 0,
			stopped: "",
			stoppedTurn: 0,
			startedAt: 0,
			problem: "the check did not get that far" as string | null,
		};
		await step(RESUME_CHECKS[2], async () => {
			await restart("stop", limits);
			held.id = await make("Held while paused");
			held.stopped = await make("Stopped while paused");
			held.startedAt = Date.now();
			[held.turn, held.stoppedTurn] = await Promise.all([startLong(held.id), startLong(held.stopped)]);
			// Most of its limit: what is left after the pause is less than the floor.
			await sleep(Math.max(0, held.startedAt + LIMIT_MS - 6_000 - Date.now()));
			await restart("stop", limits);
			const watch = new Watch(client, uid, held.id, token);
			try {
				const answer = await watch.conn.prompt({ text: "Also keep the long build log (slow)." });
				assert(answer.turn === held.turn && answer.steered === true, `the message was answered ${plain(answer)}`);
				const snap = await watch.conn.snapshot();
				assert(
					snap.summary.status === "paused" &&
						snap.summary.paused?.reason === "restart" &&
						snap.summary.paused.held === 1,
					`summary: ${plain(snap.summary)}`,
				);
				const row = snap.timeline.at(-1);
				assert(
					row?.kind === "user" && row.held === true && row.steer === true && row.turn === held.turn,
					`the last item is ${plain(row).slice(0, 200)}`,
				);
			} finally {
				await watch.conn.dispose().catch(() => undefined);
			}
			const stoppedHandle = handleOf(held.stopped);
			await stoppedHandle.stop();
			const after = await stoppedHandle.snapshot();
			const end = after.timeline.find(
				(item): item is Ended => item.kind === "turn.ended" && item.turn === held.stoppedTurn,
			);
			assert(
				end?.outcome === "stopped" && after.summary.status === "idle",
				`after Stop: ${plain(after.summary)}, ${plain(end)}`,
			);
			const { snap } = await endedOf(held.id, held.turn, DELAY_MS + 3 * TURN_MS);
			const { resumed } = resumedOnce(snap.timeline, held.turn);
			const given = promptsAfter(snap.timeline, held.turn, resumed[0]!.seq);
			assert(
				given.some(
					text =>
						text.includes("Also keep the long build log (slow).") &&
						text.includes("While the turn was paused, the person sent"),
				),
				`the agent was given: ${given.join(" | ").slice(0, 300)}`,
			);
			assert(!server.output.includes(`[wlp] turn.resumed session=${held.stopped}`), "the stopped turn resumed");
			held.problem = null;
			return `held 1 message, given on resume; the other turn ended ${end.outcome} at once and did not resume`;
		});

		await step(RESUME_CHECKS[3], async () => {
			assert(held.problem === null, held.problem ?? "");
			const { snap, ended } = await endedOf(held.id, held.turn, 1_000);
			const resumed = snap.timeline.find(
				(item): item is Platform => item.kind === "platform" && item.turn === held.turn && item.code === "turn_resumed",
			)!;
			const limit = snap.timeline.find(
				(item): item is Platform =>
					item.kind === "platform" &&
					item.turn === held.turn &&
					item.text.includes("not counting the time it was paused"),
			);
			assert(
				limit,
				`no line says the limit stopped it; the turn ended ${ended.outcome}: ${snap.timeline
					.filter(item => item.kind === "platform" && item.turn === held.turn)
					.map(item => (item.kind === "platform" ? item.text : ""))
					.join(" | ")}`,
			);
			const segment = limit.at - resumed.at;
			assert(
				segment >= FLOOR_MS - 1_000 && segment < FLOOR_MS + 8_000,
				`the resumed turn was stopped ${segment} ms after it resumed; its floor is ${FLOOR_MS} ms`,
			);
			assert(
				limit.at - held.startedAt > LIMIT_MS + 10_000,
				`the turn was stopped ${limit.at - held.startedAt} ms after it started: the pause was counted`,
			);
			return `"${limit.text}" ${segment} ms after the resume, ${limit.at - held.startedAt} ms after the start`;
		});

		await step(RESUME_CHECKS[4], async () => {
			const bucket = join(server.storage, "resume-bucket");
			const memory = { WLP_FAKE_BACKUP_DIR: bucket };
			await restart("stop", memory);
			const id = await make("Memory lost while paused", FAKE ? "docker-windlass-sandbox" : profile);
			const first = new Watch(client, uid, id, token);
			try {
				const { turn } = await first.conn.prompt({ text: "Write a short program that prints the date." });
				const ended = await first.untilEnded(turn);
				assert(ended.outcome === "succeeded", `turn ${turn} ended ${ended.outcome}`);
			} finally {
				await first.conn.dispose().catch(() => undefined);
			}
			const turn = await startLong(id, `Now add a flag for the time zone. ${LONG}${FAKE ? " (secret)" : ""}`);
			// The copy of its memory goes too: the new sandbox has none to restore.
			rmSync(join(bucket, "sessions", uid, `${id}.tgz`), { force: true });
			await restart("stop", memory);
			const { snap, ended } = await endedOf(id, turn);
			const { resumed } = resumedOnce(snap.timeline, turn);
			assert(ended.outcome === "succeeded", `the turn ended ${ended.outcome}: ${ended.message ?? ""}`);
			assert(
				snap.timeline.some(
					item =>
						item.kind === "platform" &&
						item.turn === turn &&
						item.text ===
							"The agent no longer has its earlier conversation of this turn, so it was given the whole task again.",
				),
				"no line says the agent was given the whole task",
			);
			const given = promptsAfter(snap.timeline, turn, resumed[0]!.seq).join(" | ");
			for (const part of [
				"Your earlier conversation is gone",
				"Now add a flag for the time zone.",
				"The session's first prompt was",
				"Write a short program that prints the date.",
				"reconstructed by the platform from the session's timeline",
			]) {
				assert(given.includes(part), `the agent's whole task lacks "${part}": ${given.slice(0, 400)}`);
			}
			if (FAKE) {
				const events = snap.timeline.filter(
					item => item.turn === turn && item.seq > resumed[0]!.seq && item.kind === "windlass",
				);
				const source = (await import("../server/src/factory/untrusted.js")).untrustedWords.conversation;
				assert(
					events.some(
						item =>
							item.kind === "windlass" &&
							item.event.type === "fake.prompt_untrusted" &&
							item.event.data?.source === source,
					),
					"rebuilt prompt missing its earlier-agent source",
				);
				assert(
					!snap.secretRequest &&
						events.some(
							item =>
								item.kind === "windlass" &&
								item.event.type === "tool.settled" &&
								item.event.data?.output === "A request coming from third-party text was not shown as a secret prompt.",
						),
					"rebuilt conversation did not block the secret request",
				);
			}
			return "this turn's message, the first prompt and a reconstruction of the earlier turn";
		});

		await step(RESUME_CHECKS[5], async () => {
			await restart("stop");
			const id = await make("Crashes while resuming");
			const turn = await startLong(id);
			// Resumed segments that get nowhere before the next crash: the fake layer's events come seconds apart.
			const slow = { WLP_FAKE_DELAY_MS: "3000" };
			for (let crash = 1; crash <= 4; crash++) {
				const from = server.output.length;
				await restart("crash", slow);
				await waitFor(
					`the wake after crash ${crash}`,
					() => server.output.slice(from).includes(`[wlp] turn.crashed session=${id} turn=${turn} crashes=${crash}`),
					60_000,
					100,
				);
				if (crash < 4)
					await waitFor(
						`resume ${crash}`,
						() => server.output.slice(from).includes(`[wlp] turn.resumed session=${id} turn=${turn}`),
						30_000,
						50,
					);
			}
			const { snap, ended } = await endedOf(id, turn);
			assert(ended.outcome === "interrupted", `the turn ended ${ended.outcome}`);
			assert(
				snap.timeline.some(
					item =>
						item.kind === "platform" &&
						item.turn === turn &&
						item.text ===
							"The server stopped 3 times in a row while resuming this turn, with nothing done in between, so the turn was ended.",
				),
				"no line says why it ended",
			);
			return `ended ${ended.outcome} after 3 resumes that each crashed`;
		});
	} finally {
		for (const id of made) await userHandle.deleteSession(id).catch(() => undefined);
		// Back to a server without resume for the checks that follow.
		await server.stop();
		await waitFor(`ports ${ENGINE_PORT} and ${HTTP_PORT} to be free`, portsFree, 20_000, 200);
		await server.start(plainEnv);
	}
}

// ---------------------------------------------------------------------------------------------
// The copy of Windlass's session in the bucket (server/src/sandbox/backup.ts)
// ---------------------------------------------------------------------------------------------

const BACKUP_CHECKS = [
	"a turn's end copies Windlass's session to the bucket, and the timeline says nothing of it",
	"a sandbox that is lost is replaced, and the agent's memory is restored into the new one",
	"without a copy in the bucket the agent starts without its memory, and the timeline says so",
	"a copy that is not the one the session saved is not unpacked: the agent starts without its memory",
	"a turn whose copy could not be saved says nothing, and the restore says what is missing",
	"a session whose data outgrows the limit is no longer copied, and the timeline says so once",
	"deleting a session removes its copy from the bucket",
];

/**
 * The fake layer with WLP_FAKE_BACKUP_DIR: its Windlass sessions live in its sandboxes, as on E2B, and
 * a directory stands in for the bucket. The sandboxes are in the server's memory, so stopping the
 * server loses every one of them, and the directory stays: a lost sandbox with its copy still there.
 */
async function backupChecks(
	server: Server,
	client: Client,
	uid: string,
	token: string,
	profile: string,
): Promise<void> {
	const bucket = join(server.storage, "bucket");
	const LIMIT = 1024 * 1024;
	const env = {
		WLP_FAKE_BACKUP_DIR: bucket,
		WLP_BACKUP_MAX_BYTES: String(LIMIT),
		WLP_LOGIN_TTL_MS: String(loginTtlMs),
	};
	const restart = async () => {
		await server.stop();
		await waitFor(`ports ${ENGINE_PORT} and ${HTTP_PORT} to be free`, portsFree, 20_000, 200);
		await server.start(env);
	};
	await restart();

	const RESTORED = "Restored the agent's memory of the conversation into the new sandbox.";
	const WITHOUT =
		"The agent's memory of the conversation went with the old sandbox, so it starts this turn without it.";
	const userHandle = client.user.getOrCreate([uid], { params: { token } });
	const session = await userHandle.createSession({ profile: profile as never, title: "Memory" });
	const handle = client.agentSession.get([uid, session.id], { params: { token } });
	const objectFile = join(bucket, "sessions", uid, `${session.id}.tgz`);
	const object = () => (existsSync(objectFile) ? readFileSync(objectFile) : null);
	const sha = (bytes: Buffer | null) =>
		bytes === null ? "none" : createHash("sha256").update(bytes).digest("hex").slice(0, 12);
	const logged = (what: string) =>
		server.output.split("\n").filter(line => line.includes(`[wlp] backup.${what} session=${session.id}`));
	type PlatformItem = Extract<TimelineItem, { kind: "platform" }>;
	const notes = (items: TimelineItem[], turn: number) =>
		items.filter((item): item is PlatformItem => item.kind === "platform" && item.turn === turn);
	const seqs = (items: TimelineItem[], test: (turn: number) => boolean) =>
		items.flatMap(item =>
			item.kind === "windlass" && test(item.turn) && typeof item.event.seq === "number" ? [item.event.seq] : [],
		);
	/** One turn to its end, on a connection of its own: a restart drops the one before. */
	const turn = async (text: string) => {
		const watch = new Watch(client, uid, session.id, token);
		try {
			const { turn: number } = await watch.conn.prompt({ text });
			const ended = await watch.untilEnded(number);
			assert(ended.outcome === "succeeded", `turn ${number} ended ${ended.outcome}: ${ended.message ?? ""}`);
			const snapshot = await handle.snapshot();
			return {
				number,
				snapshot,
				notes: notes(snapshot.timeline, number),
				created: snapshot.timeline.some(
					item => item.kind === "windlass" && item.turn === number && item.event.type === "session.created",
				),
			};
		} finally {
			await watch.conn.dispose().catch(() => undefined);
		}
	};
	let ok = true;
	const step = async (name: string, body: () => Promise<string | undefined>) => {
		if (!ok) {
			skip(name, "an earlier check of the copy failed");
			return;
		}
		ok = await check(name, body);
	};
	let windlassSession = "";

	try {
		await step(BACKUP_CHECKS[0], async () => {
			const first = await turn("Write a short program");
			windlassSession = first.snapshot.windlassSessionId ?? "";
			assert(/^ses_/.test(windlassSession), `the session names no Windlass session: ${windlassSession}`);
			const saved = object();
			assert(saved !== null && saved.length > 0, `no object at ${objectFile}`);
			const line = logged("saved").at(-1) ?? "";
			assert(
				line.includes(`turn=${first.number} bytes=${saved.length} `),
				`the server logged "${line}" for an object of ${saved.length} bytes`,
			);
			const second = await turn("Write a short program");
			const again = object();
			assert(again !== null && sha(again) !== sha(saved), "the second turn did not replace the object");
			assert(logged("saved").length === 2, `${logged("saved").length} saves were logged for two turns`);
			const said = [...first.notes, ...second.notes].filter(item => /memory|copy|bucket/i.test(item.text));
			assert(said.length === 0, `the timeline speaks of the copy: ${plain(said)}`);
			assert(
				second.snapshot.windlassSessionId === windlassSession && !second.created,
				"the second turn did not continue the Windlass session",
			);
			return `${saved.length} then ${again.length} bytes, one object, replaced; nothing in the timeline`;
		});

		await step(BACKUP_CHECKS[1], async () => {
			const before = await handle.snapshot();
			const last = Math.max(...seqs(before.timeline, () => true));
			await restart();
			const next = await turn("Write a short program");
			const texts = next.notes.map(item => item.text);
			assert(
				next.notes.some(item => item.level === "warn" && item.text.includes("no longer exists")),
				`no warning that the sandbox is gone: ${plain(texts)}`,
			);
			assert(
				texts.some(text => text.startsWith("Starting a hosted sandbox")),
				"no new sandbox was created",
			);
			const restored = next.notes.find(item => item.text === RESTORED);
			assert(
				restored?.level === "info" &&
					texts.indexOf(RESTORED) > texts.findIndex(text => text.startsWith("Starting a hosted sandbox")),
				`no line that the memory was restored, after the sandbox was created: ${plain(texts)}`,
			);
			assert(!texts.includes(WITHOUT), "the timeline also says the memory is gone");
			assert(
				next.snapshot.windlassSessionId === windlassSession,
				`the Windlass session is ${next.snapshot.windlassSessionId}, was ${windlassSession}`,
			);
			const continued = seqs(next.snapshot.timeline, number => number === next.number);
			assert(
				!next.created && continued.length > 0 && Math.min(...continued) === last + 1,
				`the turn's events start at seq ${Math.min(...continued)} after ${last}${next.created ? ", in a new session" : ""}`,
			);
			assert(logged("restored").length === 1, "the server logged no restore");
			return `same Windlass session ${windlassSession}, its log goes on at seq ${last + 1}: "${RESTORED}"`;
		});

		await step(BACKUP_CHECKS[2], async () => {
			rmSync(objectFile);
			await restart();
			const next = await turn("Write a short program");
			const texts = next.notes.map(item => item.text);
			assert(
				texts.includes(WITHOUT) && !texts.some(text => text.startsWith("Restored")),
				`the timeline says: ${plain(texts)}`,
			);
			assert(
				next.created &&
					next.snapshot.windlassSessionId !== windlassSession &&
					/^ses_/.test(next.snapshot.windlassSessionId ?? ""),
				`the Windlass session is ${next.snapshot.windlassSessionId}`,
			);
			assert(
				logged("restore_failed").some(line => line.includes("the bucket has no copy")),
				"the server did not log why",
			);
			windlassSession = next.snapshot.windlassSessionId ?? "";
			assert(object() !== null, "the new Windlass session was not copied when its turn ended");
			return `a new Windlass session ${windlassSession}, and a copy of it: "${WITHOUT}"`;
		});

		await step(BACKUP_CHECKS[3], async () => {
			const good = object();
			assert(good !== null, "no object to damage");
			const bad = Buffer.from(good);
			bad[0] ^= 0xff;
			writeFileSync(objectFile, bad);
			await restart();
			const next = await turn("Write a short program");
			const texts = next.notes.map(item => item.text);
			assert(
				texts.includes(WITHOUT) && !texts.some(text => text.startsWith("Restored")),
				`the timeline says: ${plain(texts)}`,
			);
			assert(
				next.created && next.snapshot.windlassSessionId !== windlassSession,
				"the damaged copy's session was continued",
			);
			assert(
				logged("restore_failed").some(line => line.includes("not the copy this session saved")),
				"the server did not log why",
			);
			windlassSession = next.snapshot.windlassSessionId ?? "";
			return `the same size, another hash: nothing unpacked, a new Windlass session ${windlassSession}`;
		});

		await step(BACKUP_CHECKS[4], async () => {
			const kept = sha(object());
			const failures = logged("save_failed").length;
			// The sandbox is gone when this turn ends: its copy cannot be made, and the next turn needs a new sandbox.
			const lost = await turn("Write a short program (lose-sandbox)");
			assert(logged("save_failed").length === failures + 1, "the server logged no failed save");
			assert(
				!lost.notes.some(item => /memory|copy|bucket/i.test(item.text)),
				`the timeline speaks of the failed save: ${plain(lost.notes.map(item => item.text))}`,
			);
			assert(sha(object()) === kept, "the earlier copy was replaced by a save that failed");
			const next = await turn("Write a short program");
			const line = next.notes.find(item => item.text.startsWith("Restored"));
			assert(
				line?.level === "warn" &&
					line.text ===
						"Restored the agent's memory of the conversation into the new sandbox, without the last turn: no copy of it could be saved.",
				`the timeline says: ${plain(next.notes.map(item => item.text))}`,
			);
			assert(
				next.snapshot.windlassSessionId === windlassSession && !next.created,
				"the Windlass session was not continued from the earlier copy",
			);
			return `"${line.text}"`;
		});

		await step(BACKUP_CHECKS[5], async () => {
			const kept = sha(object());
			const grown = await turn("Write a short program (big-memory)");
			const lines = (items: TimelineItem[]) =>
				items.filter(
					(item): item is PlatformItem =>
						item.kind === "platform" && item.text.startsWith("The agent's memory of the conversation has grown to"),
				);
			const line = lines(grown.snapshot.timeline)[0];
			assert(
				line?.level === "warn" &&
					line.turn === grown.number &&
					line.text.includes("at most 1 MB") &&
					line.text.includes("no longer copied") &&
					line.text.includes("will not remember the conversation from here on"),
				`the line is ${plain(line)}`,
			);
			assert(sha(object()) === kept, "an object was written for a session over the limit");
			assert(logged("too_large").length === 1, "the server did not log the size");
			const after = await turn("Write a short program");
			assert(
				lines(after.snapshot.timeline).length === 1 && logged("too_large").length === 1 && sha(object()) === kept,
				"the next turn packed the session again, or said it again",
			);
			// The copy from before the session grew is still the one a lost sandbox is given.
			await restart();
			const next = await turn("Write a short program");
			const restored = next.notes.find(item => item.text.startsWith("Restored"));
			assert(
				restored?.level === "warn" &&
					restored.text.includes("without the last 2 turns: no copy of them could be saved"),
				`the timeline says: ${plain(next.notes.map(item => item.text))}`,
			);
			assert(
				next.snapshot.windlassSessionId === windlassSession,
				"the Windlass session was not continued from the earlier copy",
			);
			assert(
				sha(object()) !== kept && logged("saved").some(entry => entry.includes(`turn=${next.number} `)),
				"the restored session, which is small again, was not copied when its turn ended",
			);
			return `"${line.text}" Once; the earlier copy stayed and was restored: "${restored.text}"`;
		});

		await step(BACKUP_CHECKS[6], async () => {
			assert(object() !== null, "no object before the delete");
			await userHandle.deleteSession(session.id);
			assert(object() === null, `${objectFile} is still there`);
			assert(logged("removed").length === 1, `the server logged ${logged("removed").length} removals`);
			return "the object is gone with the session";
		});
	} finally {
		await userHandle.deleteSession(session.id).catch(() => undefined);
	}
}

// ---------------------------------------------------------------------------------------------
// GitHub (server/src/github/): connecting, launching on a repository, the pull request
// ---------------------------------------------------------------------------------------------

const GITHUB_CHECKS = [
	"without a GitHub App the platform says nothing of GitHub, and every GitHub action refuses",
	"with a GitHub App the platform's information names it",
	"connecting GitHub: the state goes to GitHub, the callback route checks it, and the ticket records the connection",
	"a state works once, a ticket works once, and neither works for another user",
	"an installation that is not the user's cannot be attached by naming its id",
	"a connected user lists and searches the repositories they may read, and no other",
	"an agent is launched on a private repository: the session records it, and the clone is the platform's, with a token for that repository alone",
	"a repository's page: what is saved for it by GitHub's id, defaults saved field by field and at once, what GitHub says of it now, and all of it deleted in one step",
	"open pull request: the platform pushes the session's branch and opens it, with one line in the timeline",
	"push changes goes to the same pull request, with one line in the timeline",
	"continue in a new pull request: a new session with the same settings, on the default branch or stacked on the pushed one, linked to the first, whose agent is told what came before",
	"a repository's checks: saved as one list, run before a turn ends, said on the turn's closing item, and written into the pull request's description with every push",
	"nothing is pushed while a turn runs, or for a session with no repository of the connection",
	"a user who may only read a repository is told so, and nothing is pushed in their name",
	"the agent pushes its branch itself, unasked, with a token for that push, and Open pull request then opens one",
	"a repository that is gone, and an app that was uninstalled, are each said in a sentence",
	"disconnecting forgets the connection: nothing is listed, pushed or cloned any more",
	"no token and no secret of GitHub's is in the server's output or in any timeline",
];

/**
 * The server is restarted with a GitHub App whose GitHub is scripts/github-standin.ts. The fake sandbox
 * layer runs no git: what is checked here is the server's side of it, through its HTTP route and its
 * actors, as the web app uses them (the tokens it asks GitHub for, what it records, what it says).
 * The git commands themselves, against a real remote, are scripts/github-check.ts.
 */
async function githubChecks(
	server: Server,
	client: Client,
	demoSignIn: () => Promise<AuthResult>,
	profile: string,
): Promise<void> {
	const [
		off,
		on,
		connecting,
		once,
		notTheirs,
		listing,
		launching,
		page,
		opening,
		pushing,
		continuing,
		verifying,
		blocked,
		readOnly,
		agentPushed,
		gone,
		disconnecting,
		secrets,
	] = GITHUB_CHECKS as [
		string,
		string,
		string,
		string,
		string,
		string,
		string,
		string,
		string,
		string,
		string,
		string,
		string,
		string,
		string,
		string,
		string,
		string,
	];
	const ORIGIN = "http://localhost:5173";
	const userOf = (auth: AuthResult) => client.user.getOrCreate([auth.profile.uid], { params: { token: auth.token } });
	const sessionOf = (auth: AuthResult, id: string) =>
		client.agentSession.get([auth.profile.uid, id], { params: { token: auth.token } });
	type Info = import("../server/src/contract.js").PlatformInfo;

	const alice = await demoSignIn();
	const bob = await demoSignIn();
	const carol = await demoSignIn();

	await check(off, async () => {
		const info = (await (await platformInfo()).json()) as Info;
		assert(!("github" in info), `the platform's information has ${plain(info.github)}`);
		await refused(() => loginHttp(API, ORIGIN).start("github"), "provider_off");
		const message = await refused(() => userOf(alice).github(), "github_off");
		await refused(() => userOf(alice).githubConnect({ origin: ORIGIN }), "github_off");
		await refused(() => userOf(alice).githubRepositories(""), "github_off");
		await refused(
			() => userOf(alice).createSession({ profile: profile as never, repository: { id: 1 } }),
			"github_off",
		);
		const route = await fetch(`${API}/github/callback?code=x&state=y`, { redirect: "manual" });
		assert(route.status === 404, `the callback route answered ${route.status}`);
		const plainSession = await userOf(alice).createSession({ profile: profile as never, title: "No GitHub" });
		assert(
			plainSession.repository === undefined && plainSession.pullRequest === undefined,
			`a session's summary has ${plain(plainSession)}`,
		);
		const state = await sessionOf(alice, plainSession.id).publishState();
		assert(state.repository === null && state.pullRequest === null, `its publish state is ${plain(state)}`);
		await userOf(alice).deleteSession(plainSession.id);
		assert(!server.outputSinceStart.includes("[wlp] github"), "the server said something of GitHub");
		return `"${message}"; the callback route is 404`;
	});

	const standin = new GithubStandin({ callbackUrl: `${API}/github/callback`, strictBranches: false });
	await standin.start();
	try {
		await server.stop();
		await waitFor(`ports ${ENGINE_PORT} and ${HTTP_PORT} to be free`, portsFree, 20_000, 200);
		await server.start({ ...standin.env(), WLP_LOGIN_TTL_MS: String(loginTtlMs) });

		// Who is at "GitHub": ada with two private repositories, an organization she can write to and bo can read, and mallory.
		const ada = standin.addUser("ada");
		standin.addUser("bo");
		standin.addUser("mallory");
		const adaInstallation = standin.addInstallation("ada", "User");
		const harbor = standin.addRepository({
			owner: "ada",
			name: "harbor",
			private: true,
			installation: adaInstallation,
		});
		standin.addRepository({ owner: "ada", name: "notes", private: true, installation: adaInstallation });
		const acme = standin.addInstallation("acme", "Organization");
		const quay = standin.addRepository({ owner: "acme", name: "quay", private: true, installation: acme });
		const vault = standin.addRepository({ owner: "acme", name: "vault", private: true, installation: acme });
		quay.access.set("ada", "write");
		quay.access.set("bo", "read");
		vault.access.set("ada", "admin");
		const malloryInstallation = standin.addInstallation("mallory", "User");
		standin.addRepository({ owner: "mallory", name: "lair", private: true, installation: malloryInstallation });

		/** The browser's visit to the server's callback route: where it is sent next, and what the fragment says. */
		const visit = async (
			address: string,
		): Promise<{ location: string; ticket: string | null; error: string | null }> => {
			const response = await fetch(address, { redirect: "manual" });
			assert(response.status === 302, `the callback route answered ${response.status}`);
			const location = response.headers.get("location") ?? "";
			const fragment = location.includes("#") ? location.slice(location.indexOf("#") + 1) : "";
			return {
				location,
				ticket: fragment.startsWith("github=") ? fragment.slice(7) : null,
				error: fragment.startsWith("github-error=") ? fragment.slice(13) : null,
			};
		};
		/** A platform user connects as a GitHub user, all the way. */
		const connect = async (auth: AuthResult, login: string) => {
			const { url } = await userOf(auth).githubConnect({ origin: ORIGIN });
			const back = await visit(standin.authorize(login, url));
			assert(back.ticket !== null, `the callback sent the browser to ${back.location.slice(0, 80)}`);
			return userOf(auth).githubComplete(back.ticket);
		};
		const mintedSince = (from: number) =>
			standin.minted.slice(from).map(
				entry =>
					`${Object.entries(entry.permissions ?? {})
						.map(([name, level]) => `${name}:${level}`)
						.join(",")} @ ${entry.repositoryIds?.join(",") ?? "all"}`,
			);

		await check(on, async () => {
			const info = (await (await platformInfo()).json()) as Info;
			assert(plain(info.github) === plain({ slug: standin.slug, url: standin.url }), `github is ${plain(info.github)}`);
			assert(
				server.outputSinceStart.includes(`[wlp] github: app ${standin.slug} (id ${standin.appId})`),
				"the server did not say at its start which GitHub App it has",
			);
			const status = await userOf(alice).github();
			assert(status.connection === null, `a user who never connected has ${plain(status)}`);
			await refused(() => userOf(alice).githubRepositories(""), "github_not_connected");
			await refused(() => userOf(alice).githubConnect({ origin: "http://evil.example" }), "origin_not_allowed");
			return `${info.github?.slug} at ${info.github?.url}`;
		});

		let ticket = "";
		let callback = "";
		await check(connecting, async () => {
			const { url } = await userOf(alice).githubConnect({ origin: ORIGIN });
			const address = new URL(url);
			assert(
				url.startsWith(`${standin.url}/login/oauth/authorize?`) &&
					address.searchParams.get("client_id") === standin.clientId &&
					address.searchParams.get("code_challenge_method") === "S256",
				`the address is ${url.slice(0, 120)}`,
			);
			callback = standin.authorize("ada", url);
			const back = await visit(callback);
			assert(
				back.location.startsWith(`${ORIGIN}/#github=`) && back.ticket !== null,
				`the browser was sent to ${back.location.slice(0, 80)}`,
			);
			ticket = back.ticket;
			// Until the web app hands the ticket in, nothing is connected.
			assert(
				(await userOf(alice).github()).connection === null,
				"the connection was recorded before the ticket was handed in",
			);
			const status = await userOf(alice).githubComplete(ticket);
			const accounts = status.connection?.accounts ?? [];
			assert(status.connection?.login === "ada", `connected as ${status.connection?.login}`);
			assert(
				accounts
					.map(account => `${account.login}:${account.kind}`)
					.sort()
					.join(",") === "acme:organization,ada:user",
				`accounts are ${plain(accounts)}`,
			);
			assert(
				accounts.every(account => account.manageUrl.startsWith(standin.url)),
				"an account has no page at GitHub",
			);
			assert(plain(await userOf(alice).github()) === plain(status), "github() does not answer what githubComplete did");
			const userTokens = [...standin.tokens.values()].filter(token => token.kind === "user");
			assert(
				userTokens.length > 0 && userTokens.every(token => !standin.alive(token.value)),
				"a user access token is still alive at GitHub",
			);
			return `ada, for ${accounts.map(account => account.login).join(" and ")}; ${userTokens.length} user token(s), all deleted at GitHub`;
		});

		await check(once, async () => {
			const again = await visit(callback);
			assert(
				again.error === "used" && again.ticket === null,
				`the same callback address again led to ${again.location}`,
			);
			await refused(() => userOf(alice).githubComplete(ticket), "github_ticket");
			await refused(() => userOf(bob).githubComplete(ticket), "github_ticket");
			// A state begun by bob, finished by a ticket handed to alice's actor: alice's actor does not take it.
			const begun = await userOf(bob).githubConnect({ origin: ORIGIN });
			const bobs = await visit(standin.authorize("mallory", begun.url));
			assert(bobs.ticket !== null, "bob's own connection gave no ticket");
			const said = await refused(() => userOf(alice).githubComplete(bobs.ticket as string), "github_ticket");
			assert((await userOf(alice).github()).connection?.login === "ada", "alice's connection changed");
			const forged = `${bobs.ticket.slice(0, -6)}AAAAAA`;
			await refused(() => userOf(bob).githubComplete(forged), "github_ticket");
			const state = new URL(begun.url).searchParams.get("state") ?? "";
			const tampered = await visit(
				`${API}/github/callback?code=x&state=${encodeURIComponent(`${state.slice(0, -4)}AAAA`)}`,
			);
			assert(tampered.error === "state", `a changed state led to ${tampered.location}`);
			const none = await visit(`${API}/github/callback?code=x`);
			assert(none.error === "state", `no state led to ${none.location}`);
			assert(
				(await userOf(bob).github()).connection === null,
				"bob is connected though his ticket was never handed in by him",
			);
			return `the callback again: "${again.error}"; a ticket again and another user's: refused ("${said}")`;
		});

		await check(notTheirs, async () => {
			const begun = await userOf(bob).githubConnect({ origin: ORIGIN });
			const state = new URL(begun.url).searchParams.get("state");
			// mallory authorizes as herself and names ada's installation.
			const guessed = await visit(standin.installed("mallory", adaInstallation.id, state));
			assert(guessed.error === "not_yours" && guessed.ticket === null, `it led to ${guessed.location}`);
			const bare = await userOf(bob).githubConnect({ origin: ORIGIN });
			const noCode = await visit(
				`${API}/github/callback?installation_id=${adaInstallation.id}&setup_action=install&state=${encodeURIComponent(new URL(bare.url).searchParams.get("state") ?? "")}`,
			);
			assert(noCode.error === "code", `an installation id with no code led to ${noCode.location}`);
			assert((await userOf(bob).github()).connection === null, "bob has a connection");
			assert(server.output.includes("[wlp] github.connect.not_theirs"), "the server did not log the attempt");
			// The installation page, for an account to add: the state is one the callback takes.
			const install = await userOf(bob).githubConnect({ origin: ORIGIN, install: true });
			assert(
				install.url.startsWith(`${standin.url}/apps/${standin.slug}/installations/new?state=`),
				`the installation address is ${install.url.slice(0, 100)}`,
			);
			return `naming installation ${adaInstallation.id} as mallory: "${guessed.error}"; with no code: "${noCode.error}"`;
		});

		await check(listing, async () => {
			const all = await userOf(alice).githubRepositories("");
			const names = all.repositories.map(repository => `${repository.owner}/${repository.name}`).sort();
			assert(names.join(",") === "acme/quay,acme/vault,ada/harbor,ada/notes", `alice sees ${names.join(", ")}`);
			const found = await userOf(alice).githubRepositories("harb");
			assert(
				found.repositories.length === 1 &&
					found.repositories[0].id === harbor.id &&
					found.repositories[0].private &&
					found.repositories[0].canPush,
				`a search found ${plain(found)}`,
			);
			const branches = await userOf(alice).githubBranches(harbor.id);
			assert(branches.defaultBranch === "main" && branches.branches[0] === "main", `branches are ${plain(branches)}`);
			// carol connects as bo, a member of acme who may read one of its two repositories.
			const status = await connect(carol, "bo");
			assert(
				status.connection?.accounts.map(account => account.login).join(",") === "acme",
				`bo's accounts are ${plain(status.connection?.accounts)}`,
			);
			const member = await userOf(carol).githubRepositories("");
			assert(
				member.repositories.map(repository => repository.name).join(",") === "quay" &&
					member.repositories[0].canPush === false,
				`bo sees ${plain(member.repositories)}`,
			);
			await refused(() => userOf(carol).githubBranches(vault.id), "github_denied");
			await refused(
				() => userOf(carol).createSession({ profile: profile as never, repository: { id: vault.id } }),
				"github_denied",
			);
			await refused(
				() => userOf(carol).createSession({ profile: profile as never, repository: { id: harbor.id } }),
				"github_gone",
			);
			await refused(
				() =>
					userOf(alice).createSession({
						profile: profile as never,
						repository: { id: harbor.id },
						repoUrl: "https://github.com/a/b.git",
					}),
				"bad_input",
			);
			return `alice: ${names.join(", ")}; bo: quay, read only; a repository he cannot read is refused`;
		});

		let sessionId = "";
		// Assigned inside a check: the cast keeps its type from narrowing to the initial null.
		let watch = null as Watch | null;
		await check(launching, async () => {
			const created = await userOf(alice).createSession({
				profile: profile as never,
				title: "Fix the harbor light",
				repository: { id: harbor.id },
			});
			sessionId = created.id;
			assert(
				plain(created.repository) ===
					plain({
						provider: "github",
						id: harbor.id,
						owner: "ada",
						name: "harbor",
						branch: "main",
						private: true,
						url: `${standin.url}/ada/harbor`,
					}),
				`the summary's repository is ${plain(created.repository)}`,
			);
			assert(
				created.repoUrl === `${standin.url}/ada/harbor.git` && created.pullRequest === null,
				`repoUrl ${created.repoUrl}, pull request ${plain(created.pullRequest)}`,
			);
			watch = new Watch(client, alice.profile.uid, sessionId, alice.token);
			const from = standin.minted.length;
			const { turn } = await watch.conn.prompt({ text: "Write a short program" });
			const ended = await watch.untilEnded(turn);
			assert(ended.outcome === "succeeded", `the turn ended ${ended.outcome}: ${ended.message ?? ""}`);
			const cloning = watch.items.find(item => item.kind === "platform" && item.text.startsWith("Cloning"));
			assert(
				cloning?.kind === "platform" && cloning.text === "Cloning ada/harbor at main",
				`the timeline says ${plain(cloning)}`,
			);
			const minted = mintedSince(from);
			assert(
				minted.includes(`metadata:read,contents:read @ ${harbor.id}`),
				`the tokens asked for were ${minted.join("; ")}`,
			);
			assert(!minted.some(entry => entry.includes("write")), `a token for writing was asked for: ${minted.join("; ")}`);
			const cloneToken = standin.minted.slice(from).find(entry => entry.permissions?.contents === "read")?.token ?? "";
			assert(cloneToken !== "" && !standin.alive(cloneToken), "the clone's token was not revoked");
			const snapshot = await sessionOf(alice, sessionId).snapshot();
			assert(
				plain(snapshot.summary.repository) === plain(created.repository),
				"the snapshot's summary lost the repository",
			);
			const listed = (await userOf(alice).listSessions()).find(session => session.id === sessionId);
			assert(plain(listed?.repository) === plain(created.repository), "the user's list lost the repository");
			return `"${cloning.text}"; tokens: ${minted.join("; ")}; the clone's token revoked`;
		});

		await check(page, async () => {
			const user = userOf(alice);
			const info = (await (await platformInfo()).json()) as Info;
			const offered = (await user.models()).models.map(candidate => candidate.id);
			const [model, other] = [offered[0], offered[1] ?? offered[0]];
			const unavailable = info.profiles.find(candidate => !candidate.available);
			const NONE = {
				place: null,
				harness: null,
				machineProfile: null,
				placeFallback: null,
				screenshots: false,
				profile: null,
				model: null,
				hostedSize: null,
				updatedAt: null,
			};

			// Nothing is kept until something is saved: the page is there all the same, named after the agent on it.
			const empty = await user.repository(harbor.id);
			assert(
				plain(empty.defaults) === plain(NONE) &&
					empty.name === "ada/harbor" &&
					empty.approvals.length === 0 &&
					plain(empty.saved) === plain({ setup: false, secrets: 0, checks: 0, network: 0 }),
				`before anything was saved: ${plain(empty)}`,
			);
			assert((await user.savedRepositories()).length === 0, "a repository is listed as having something saved");
			for (const id of [0, -1, 1.5, "7", null]) await refused(() => user.repository(id as never), "bad_input");

			// One field at a time, each leaving the other; and two saves at once, of which neither is lost.
			const first = await user.saveRepositoryDefaults({ repositoryId: harbor.id, model: other });
			assert(
				first.profile === null && first.model === other && typeof first.updatedAt === "number",
				`after saving a model: ${plain(first)}`,
			);
			const second = await user.saveRepositoryDefaults({ repositoryId: harbor.id, profile: profile as never });
			assert(second.profile === profile && second.model === other, `after saving a sandbox: ${plain(second)}`);
			for (let round = 0; round < 12; round += 1) {
				await user.saveRepositoryDefaults({ repositoryId: harbor.id, profile: null, model: null });
				const secret = `wlpcheck_${randomBytes(12).toString("hex")}`;
				await Promise.all([
					user.saveRepositoryDefaults({ repositoryId: harbor.id, profile: profile as never }),
					user.saveRepositoryDefaults({ repositoryId: harbor.id, model }),
					user.saveRepositorySetup({ repositoryId: harbor.id, command: `echo ${round}` }),
					user.saveRepositorySecret({
						repositoryId: harbor.id,
						profile: profile as never,
						name: "CHECK_TOKEN",
						value: secret,
						scope: "setup",
					}),
					user.saveRepositoryChecks({ repositoryId: harbor.id, checks: [{ name: "test", command: `echo ${round}` }] }),
				]);
				const now = await user.repository(harbor.id);
				assert(
					now.defaults.profile === profile &&
						now.defaults.model === model &&
						now.saved.setup &&
						now.saved.secrets === 1 &&
						now.saved.checks === 1,
					`round ${round}: five saves at once left ${plain(now)}`,
				);
				assert(
					(await user.repositoryChecks(harbor.id)).checks[0]?.command === `echo ${round}`,
					`round ${round}: the checks were lost`,
				);
				assert(
					(await user.repositorySetup(harbor.id)).command === `echo ${round}`,
					`round ${round}: the setup command was lost`,
				);
				// Nothing of the page carries a secret's value.
				assert(
					!plain(now).includes(secret) && !plain(await user.savedRepositories()).includes(secret),
					"the page carries a secret's value",
				);
			}

			// What the deployment does not offer is refused, and what was saved stays.
			await refused(
				() => user.saveRepositoryDefaults({ repositoryId: harbor.id, model: "no-such-model" }),
				"bad_model",
			);
			await refused(
				() => user.saveRepositoryDefaults({ repositoryId: harbor.id, profile: "no-such-sandbox" as never }),
				"bad_input",
			);
			if (unavailable)
				await refused(
					() => user.saveRepositoryDefaults({ repositoryId: harbor.id, profile: unavailable.id }),
					"bad_input",
				);
			assert(
				plain((await user.repository(harbor.id)).defaults.model) === plain(model),
				"a refused save changed what was saved",
			);
			assert(
				plain(await user.savedRepositories()) === plain([{ id: harbor.id, name: "ada/harbor" }]),
				`the repositories with something saved: ${plain(await user.savedRepositories())}`,
			);

			// GitHub says what it is now; one the connection does not cover, and one this user may not read, are refused in a sentence.
			const described = await user.githubRepository(harbor.id);
			assert(
				described.id === harbor.id &&
					described.owner === "ada" &&
					described.name === "harbor" &&
					described.private &&
					described.canPush &&
					described.defaultBranch === "main",
				`GitHub's word on it: ${plain(described)}`,
			);
			await refused(() => user.githubRepository(999_999_999), "github_gone");
			await refused(() => userOf(carol).githubRepository(vault.id), "github_denied");
			// Its page opens for somebody who cannot reach it, with nothing of anybody else's on it.
			const carols = await userOf(carol).repository(harbor.id);
			assert(
				plain(carols.defaults) === plain(NONE) &&
					carols.name === null &&
					plain(carols.saved) === plain({ setup: false, secrets: 0, checks: 0, network: 0 }),
				`another user's page of the same repository: ${plain(carols)}`,
			);

			// All of it goes in one step, and the agent stays.
			const cleared = await user.forgetRepository(harbor.id);
			assert(
				plain(cleared.defaults) === plain(NONE) &&
					plain(cleared.saved) === plain({ setup: false, secrets: 0, checks: 0, network: 0 }) &&
					cleared.approvals.length === 0,
				`after deleting what was saved: ${plain(cleared)}`,
			);
			assert(
				(await user.repositorySetup(harbor.id)).command === "" &&
					(await user.repositorySecrets({ repositoryId: harbor.id, profile: profile as never })).secrets.length === 0,
				"a setup command or a secret is still there",
			);
			assert(
				(await user.savedRepositories()).length === 0 &&
					(await user.listSessions()).some(session => session.id === sessionId),
				"the list still names it, or the agent went with it",
			);
			assert(
				server.output.includes(`[wlp] defaults.saved uid=${alice.profile.uid} project=github:${harbor.id}`) &&
					server.output.includes(`[wlp] repository.forgotten uid=${alice.profile.uid} project=github:${harbor.id}`),
				"the server did not log the saves and the deletion",
			);
			return `12 rounds of four saves at once kept all four; refused: an unknown model and sandbox${unavailable ? `, ${unavailable.id}` : ""}; GitHub: ada/harbor, gone, denied`;
		});

		const lines = () =>
			(watch?.items ?? [])
				.filter((item): item is Extract<TimelineItem, { kind: "platform" }> => item.kind === "platform")
				.map(item => item.text);
		let branch = "";
		await check(opening, async () => {
			assert(watch, "no session");
			const handle = sessionOf(alice, sessionId);
			const before = await handle.publishState();
			assert(
				before.blocked === null && before.changes === true && before.pullRequest === null,
				`the publish state is ${plain({ ...before, draft: undefined })}`,
			);
			assert(before.branch === "windlass/fix-the-harbor-light", `the branch is ${before.branch}`);
			assert(
				before.draft.title === "Fix the harbor light" && before.draft.body !== "",
				`the draft is ${plain(before.draft)}`,
			);
			branch = before.branch;
			await refused(() => handle.publish({ message: { title: "  ", body: "" } }), "bad_message");
			const from = standin.minted.length;
			const result = await handle.publish({ message: { title: "Fix the harbor light", body: "It was dark." } });
			const pull = result.state.pullRequest;
			assert(
				result.opened &&
					pull?.number === 1 &&
					pull.state === "open" &&
					pull.branch === branch &&
					pull.base === "main" &&
					pull.url === `${standin.url}/ada/harbor/pull/1`,
				`the result is ${plain(result.state.pullRequest)}`,
			);
			const made = standin.pulls.at(-1);
			// The description is the user's, and after it the section that says what was verified: here, in one sentence, nothing.
			assert(
				made?.title === "Fix the harbor light" &&
					made.body.startsWith("It was dark.\n\n<!-- windlass-platform:verified -->") &&
					made.body.includes("\n\nNothing was verified: no checks are set for this repository.\n\n") &&
					made.head === branch &&
					made.base === "main",
				`GitHub has ${plain(made)}`,
			);
			assert(pull.verified === "nothing verified", `the pull request says "${pull.verified}"`);
			const minted = mintedSince(from);
			assert(
				minted.includes(`metadata:read,contents:write @ ${harbor.id}`) &&
					minted.includes(`metadata:read,contents:read,pull_requests:write @ ${harbor.id}`),
				`the tokens asked for were ${minted.join("; ")}`,
			);
			const pushToken = standin.minted.slice(from).find(entry => entry.permissions?.contents === "write")?.token ?? "";
			assert(pushToken !== "" && !standin.alive(pushToken), "the push's token was not revoked");
			const line = await waitFor(
				"the timeline's line",
				() => lines().find(text => text.startsWith("Opened pull request")),
				5_000,
			);
			assert(
				line === `Opened pull request #1 in ada/harbor from ${branch}. Its description reports: nothing verified.`,
				`the timeline says "${line}"`,
			);
			const summary = await waitFor(
				"the summary with the pull request",
				() => [...(watch?.summaries ?? [])].reverse().find(one => one.pullRequest?.number === 1),
				5_000,
			);
			assert(summary.pullRequest?.state === "open", "the summary's pull request is not open");
			const listed = await waitFor(
				"the user's list with the pull request",
				async () =>
					(await userOf(alice).listSessions()).find(
						session => session.id === sessionId && session.pullRequest?.number === 1,
					),
				5_000,
			);
			assert(listed.pullRequest?.url === pull.url, "the user's list has another address");
			return `#${pull.number} from ${branch}; "${line}"; tokens: ${minted.join("; ")}`;
		});

		await check(pushing, async () => {
			assert(watch, "no session");
			const handle = sessionOf(alice, sessionId);
			const count = standin.pulls.length;
			const result = await handle.publish({ message: { title: "Trim the wick", body: "" } });
			assert(
				!result.opened && result.state.pullRequest?.number === 1 && standin.pulls.length === count,
				`the result is ${plain(result.state.pullRequest)}; GitHub has ${standin.pulls.length} pull requests`,
			);
			const line = await waitFor("the timeline's line", () => lines().find(text => text.startsWith("Pushed")), 5_000);
			assert(
				line === `Pushed the work to ${branch}; pull request #1 is updated. Its description reports: nothing verified.`,
				`the timeline says "${line}"`,
			);
			// Merged at GitHub: the panel's read sees it, and so does everyone who watches the session.
			(standin.pulls[0] as (typeof standin.pulls)[number]).state = "closed";
			(standin.pulls[0] as (typeof standin.pulls)[number]).merged = true;
			await sleep(100);
			const merged = await waitFor(
				"the merged state",
				async () =>
					(await handle.publishState()).pullRequest?.state === "merged" ? true : (await sleep(2_000), undefined),
				40_000,
				500,
			);
			assert(merged, "the pull request is not seen as merged");
			const again = await handle.publish({ message: { title: "After the merge", body: "" } });
			assert(
				again.opened && again.state.pullRequest?.number === 2,
				`after a merge the result is ${plain(again.state.pullRequest)}`,
			);
			return `"${line}"; merged at GitHub is seen; the next push opened #2`;
		});

		await check(continuing, async () => {
			assert(watch, "no session");
			const user = userOf(alice);
			const parent = await sessionOf(alice, sessionId).snapshot();
			await refused(() => user.continueSession({ id: "s_none" }), "session_not_found");
			await refused(() => userOf(bob).continueSession({ id: sessionId }), "session_not_found");
			const pasted = await user.createSession({ profile: profile as never, title: "No repository" });
			await refused(() => user.continueSession({ id: pasted.id }), "no_repository");
			await refused(() => user.continueSession({ id: pasted.id, stack: true }), "no_repository");
			// A turn that runs: nothing is continued from under it.
			const { turn: running } = await watch.conn.prompt({ text: "Write a short program" });
			await refused(() => user.continueSession({ id: sessionId }), "turn_running");
			await watch.untilEnded(running);

			const child = await user.continueSession({ id: sessionId, idempotencyKey: "continue-harbor" });
			const again = await user.continueSession({ id: sessionId, idempotencyKey: "continue-harbor" });
			const stacked = await user.continueSession({ id: sessionId, stack: true });
			assert(again.id === child.id && stacked.id !== child.id && child.id !== sessionId, "the same key made another");
			const same = (one: SessionSummary) =>
				one.harness === parent.summary.harness &&
				one.model === parent.summary.model &&
				(one.effort ?? null) === (parent.summary.effort ?? null) &&
				one.mode === parent.summary.mode &&
				one.profile === parent.summary.profile &&
				plain(one.place) === plain(parent.summary.place) &&
				one.repository?.id === harbor.id &&
				one.pullRequest === null &&
				plain(one.continuedFrom) === plain({ id: sessionId, title: parent.summary.title });
			assert(same(child) && same(stacked), `the new sessions are ${plain([child, stacked])}`);
			assert(
				child.repository?.branch === "main" && stacked.repository?.branch === branch,
				`they start from ${child.repository?.branch} and ${stacked.repository?.branch}`,
			);
			const listed = await user.listSessions();
			assert(
				listed.filter(one => one.continuedFrom?.id === sessionId).length === 2 &&
					listed.find(one => one.id === sessionId)?.continuedFrom === undefined,
				"the user's list does not link them",
			);

			// The fake layer keeps no copy: the agent starts a new conversation, given an account of the first.
			const next = new Watch(client, alice.profile.uid, child.id, alice.token);
			try {
				const { turn } = await next.conn.prompt({ text: "Write a short program" });
				const ended = await next.untilEnded(turn);
				assert(ended.outcome === "succeeded", `the turn ended ${ended.outcome}: ${ended.message ?? ""}`);
				const texts = next.items.flatMap(item => (item.kind === "platform" ? [item.text] : []));
				assert(texts.includes("Cloning ada/harbor at main"), `the timeline says ${plain(texts)}`);
				assert(
					texts.includes(
						"The agent does not have the earlier session's memory, so its first prompt includes an account of that session.",
					),
					`no line about the account: ${plain(texts)}`,
				);
				const snapshot = await sessionOf(alice, child.id).snapshot();
				assert(
					snapshot.windlassSessionId !== null && snapshot.windlassSessionId !== parent.windlassSessionId,
					`the new session's agent session is ${snapshot.windlassSessionId}, the first's ${parent.windlassSessionId}`,
				);
				const first = await sessionOf(alice, sessionId).snapshot();
				assert(
					first.summary.pullRequest?.number === parent.summary.pullRequest?.number &&
						first.summary.turns === parent.summary.turns + 1,
					"the first session changed",
				);
			} finally {
				await next.conn.dispose().catch(() => undefined);
			}
			await user.deleteSession(pasted.id);
			await user.deleteSession(stacked.id);
			await user.deleteSession(child.id);
			return `${child.id} on main and ${stacked.id} on ${branch}, both from ${sessionId}; refused: unknown, another user's, no repository, a running turn`;
		});

		await check(verifying, async () => {
			assert(watch, "no session");
			const user = userOf(alice);
			const handle = sessionOf(alice, sessionId);
			await refused(
				() =>
					user.saveRepositoryChecks({ repositoryId: harbor.id, checks: [{ name: "has space", command: "npm test" }] }),
				"bad_checks",
			);
			await refused(
				() =>
					user.saveRepositoryChecks({
						repositoryId: harbor.id,
						checks: [
							{ name: "a", command: "x" },
							{ name: "a", command: "y" },
						],
					}),
				"bad_checks",
			);
			const saved = await user.saveRepositoryChecks({
				repositoryId: harbor.id,
				checks: [
					{ name: "test", command: "npm test" },
					{ name: "lint", command: "npm run lint", timeoutSeconds: 60 },
				],
			});
			assert(
				saved.checks.length === 2 &&
					(await user.repository(harbor.id)).saved.checks === 2 &&
					(await userOf(carol).repositoryChecks(harbor.id)).checks.length === 0,
				`saved: ${plain(saved)}`,
			);

			// The session is handed them with its next turn, and the turn's closing item says what they came to and whose they are.
			const first = await watch.conn.prompt({ text: "Write a short program" });
			const ended = await watch.untilEnded(first.turn);
			assert(ended.verified !== null, "a Windlass turn has no verification record");
			const ran = ended.verified.run?.checks
				.map(one => `${one.name}:${one.whose}:${one.required === true}:${one.status}:${one.sentBack}`)
				.join(",");
			assert(
				ended.outcome === "succeeded" &&
					ended.verified.state === "passed" &&
					ended.verified.run?.turn === first.turn &&
					ran === "test:user:true:passed:0,lint:user:true:passed:0" &&
					ended.verified.unrun.length === 0,
				`the turn ended ${ended.outcome} with ${plain(ended.verified)}`,
			);
			assert(watch.windlass(first.turn, "checks.finished").length === 1, "the timeline has no run of checks");
			// The record keeps where that run is in Windlass's log: a later ending that needs no check names the run it rests on by it.
			assert(
				typeof ended.verified.run?.seq === "number" && ended.verified.run.seq > 0,
				`the record of the run is ${plain(ended.verified.run)}`,
			);
			const pushed = await handle.publish({ message: { title: "With its checks", body: "" } });
			const described = standin.pulls.at(-1)?.body ?? "";
			assert(
				pushed.state.pullRequest?.verified === "2 checks passed",
				`the pull request says "${pushed.state.pullRequest?.verified}"`,
			);
			assert(
				described.includes(`The 2 checks that applied passed when the agent's turn ${first.turn} ended.`) &&
					described.includes("- **test** (`npm test`), ada's required check: passed in 40 ms.") &&
					described.includes("- **lint** (`npm run lint`), ada's required check: passed in 40 ms."),
				`the description is ${plain(described)}`,
			);
			assert(
				!described.includes("Nothing was verified") && described.split("### What was verified").length === 2,
				"the description kept the section of the push before it",
			);

			// A check that fails: the turn ends with it unresolved, and the next push says that instead.
			await user.saveRepositoryChecks({ repositoryId: harbor.id, checks: [{ name: "test", command: "npm run fail" }] });
			const second = await watch.conn.prompt({ text: "Write a short program" });
			const failing = await watch.untilEnded(second.turn);
			assert(failing.verified !== null, "a Windlass turn has no verification record");
			assert(
				failing.outcome === "unresolved" &&
					failing.verified.state === "unresolved" &&
					failing.verified.unresolved?.reason === "max_rounds" &&
					failing.verified.run?.checks[0]?.status === "failed",
				`the turn ended ${failing.outcome} with ${plain(failing.verified)}`,
			);
			const again = await handle.publish({ message: { title: "With a check failing", body: "" } });
			const now = standin.pulls.at(-1)?.body ?? "";
			assert(
				again.state.pullRequest?.verified === "1 of 1 check failing" &&
					now.includes(
						`The agent's turn ${second.turn} ended with a check still failing: the agent had been sent back as often as a turn allows.`,
					) &&
					now.includes("- **test** (`npm run fail`), ada's required check: failed with exit code 1 after 40 ms."),
				`the description is ${plain(now)}`,
			);
			// The end of what the failing check printed is the one Windlass's record of the run carried.
			assert(
				failing.verified.run?.checks[0]?.output === "test: 1 failed" &&
					now.includes("<summary>The end of what test printed</summary>\n\n```text\ntest: 1 failed\n```"),
				`the description is ${plain(now)}`,
			);
			assert(
				!now.includes("npm run lint") && now.split("### What was verified").length === 2 && !/[✓✅]/.test(now),
				"the description kept the section of the push before it",
			);
			const line = lines()
				.filter(text => text.startsWith("Pushed"))
				.at(-1);
			assert(line?.endsWith("Its description reports: 1 of 1 check failing.") === true, `the timeline says "${line}"`);
			// None again: the checks after this one run as they did.
			assert(
				(await user.saveRepositoryChecks({ repositoryId: harbor.id, checks: [] })).updatedAt === null &&
					(await user.repository(harbor.id)).saved.checks === 0,
				"the checks were not deleted",
			);
			return `"${again.state.pullRequest?.verified}"; "${line}"`;
		});

		await check(blocked, async () => {
			assert(watch, "no session");
			const handle = sessionOf(alice, sessionId);
			const { turn } = await watch.conn.prompt({ text: "Fix the failing test (slow)" });
			await waitFor("the turn to run", () => watch?.summaries.at(-1)?.status === "running", TURN_MS);
			const state = await handle.publishState();
			assert(
				state.blocked !== null && state.blocked.includes("Wait for the turn to end"),
				`while a turn runs the state says ${plain(state.blocked)}`,
			);
			const said = await refused(
				() => handle.publish({ message: { title: "Too early", body: "" } }),
				"publish_blocked",
			);
			await handle.stop();
			await watch.untilEnded(turn);
			const pasted = await userOf(alice).createSession({ profile: profile as never, title: "Pasted" });
			await refused(
				() => sessionOf(alice, pasted.id).publish({ message: { title: "Nowhere", body: "" } }),
				"publish_blocked",
			);
			await userOf(alice).deleteSession(pasted.id);
			// Another user cannot push alice's session.
			await refused(
				() =>
					client.agentSession
						.get([alice.profile.uid, sessionId], { params: { token: bob.token } })
						.publish({ message: { title: "Not mine", body: "" } }),
				"forbidden",
			);
			return `"${said}"`;
		});

		await check(readOnly, async () => {
			const created = await userOf(carol).createSession({
				profile: profile as never,
				title: "Look at the quay",
				repository: { id: quay.id },
			});
			const carolWatch = new Watch(client, carol.profile.uid, created.id, carol.token);
			try {
				const { turn } = await carolWatch.conn.prompt({ text: "Write a short program" });
				const ended = await carolWatch.untilEnded(turn);
				assert(ended.outcome === "succeeded", `the turn ended ${ended.outcome}: ${ended.message ?? ""}`);
				const from = standin.minted.length;
				const said = await refused(
					() => sessionOf(carol, created.id).publish({ message: { title: "Try", body: "" } }),
					"github_denied",
				);
				assert(
					said ===
						"bo can read acme/quay on GitHub but not write to it, so the platform cannot push there for you. Ask an owner of acme for write access, then push again.",
					`it said "${said}"`,
				);
				assert(
					!mintedSince(from).some(entry => entry.includes("write")),
					`a token for writing was asked for: ${mintedSince(from).join("; ")}`,
				);
				assert(!standin.pulls.some(pull => pull.repository === quay.id), "a pull request was opened");
				return `"${said}"`;
			} finally {
				await carolWatch.conn.dispose().catch(() => undefined);
				await userOf(carol)
					.deleteSession(created.id)
					.catch(() => undefined);
			}
		});

		await check(agentPushed, async () => {
			const created = await userOf(alice).createSession({
				profile: profile as never,
				title: "The agent pushes",
				repository: { id: harbor.id },
			});
			const pushWatch = new Watch(client, alice.profile.uid, created.id, alice.token);
			try {
				// The fake's model calls the platform's push when the prompt says "(push)", as a model calls a host tool. The fake
				// sandbox runs no git, so git names no commit: the line names the branch alone, and `pushed` is not set here
				// (github-check.ts pushes with real git; `PublishState.pushed` is the session's `pushedHead`).
				const from = standin.minted.length;
				const { turn } = await pushWatch.conn.prompt({ text: "Write a short program (push)" });
				const ended = await pushWatch.untilEnded(turn);
				assert(ended.outcome === "succeeded", `the turn ended ${ended.outcome}: ${ended.message ?? ""}`);
				const branchNow = (await sessionOf(alice, created.id).publishState()).branch;
				const line = pushWatch.items.find(
					item => item.kind === "platform" && item.text.startsWith("The agent pushed its work to"),
				);
				assert(
					line?.kind === "platform" && line.text === `The agent pushed its work to ${branchNow}.`,
					`the timeline says ${plain(line)}`,
				);
				const asked = pushWatch.items.some(
					item => item.kind === "platform" && /asked to publish|Allow the agent/.test(item.text),
				);
				const pushToken =
					standin.minted.slice(from).find(entry => entry.permissions?.contents === "write")?.token ?? "";
				assert(
					!asked && pushToken !== "" && !standin.alive(pushToken),
					`asked: ${asked}; a push token ${pushToken === "" ? "was not minted" : "was not revoked"}`,
				);
				const state = await sessionOf(alice, created.id).publishState();
				assert(
					state.pullRequest === null && state.blocked === null,
					`the state is ${plain({ ...state, draft: undefined })}`,
				);
				const opened = await sessionOf(alice, created.id).publish({
					message: { title: "From what the agent pushed", body: "" },
				});
				assert(
					opened.opened && opened.state.pullRequest?.branch === branchNow,
					`the result is ${plain(opened.state.pullRequest)}`,
				);
				return `"${line.text}", unasked, one push token revoked; then #${opened.state.pullRequest?.number} opened`;
			} finally {
				await pushWatch.conn.dispose().catch(() => undefined);
				await userOf(alice)
					.deleteSession(created.id)
					.catch(() => undefined);
			}
		});

		await check(gone, async () => {
			const doomed = standin.addRepository({
				owner: "ada",
				name: "doomed",
				private: true,
				installation: adaInstallation,
			});
			await userOf(alice).githubRepositories("", true);
			const created = await userOf(alice).createSession({
				profile: profile as never,
				title: "Doomed",
				repository: { id: doomed.id },
			});
			const doomedWatch = new Watch(client, alice.profile.uid, created.id, alice.token);
			try {
				const { turn } = await doomedWatch.conn.prompt({ text: "Write a short program" });
				await doomedWatch.untilEnded(turn);
				standin.deleteRepository(doomed);
				const lost = await refused(
					() => sessionOf(alice, created.id).publish({ message: { title: "Try", body: "" } }),
					"github_gone",
				);
				assert(lost.includes("ada/doomed") && lost.includes("no longer"), `it said "${lost}"`);
				// The app is uninstalled from mallory's account, whom bob connected as.
				const status = await connect(bob, "mallory");
				assert(status.connection?.accounts.length === 1, "bob is not connected as mallory");
				standin.uninstall(malloryInstallation);
				const uninstalled = await refused(() => userOf(bob).githubRepositories("", true), "github_gone");
				assert(
					uninstalled ===
						"The GitHub App is no longer installed on mallory. Connect GitHub again and install it there, then try once more.",
					`it said "${uninstalled}"`,
				);
				return `"${lost}" | "${uninstalled}"`;
			} finally {
				await doomedWatch.conn.dispose().catch(() => undefined);
				await userOf(alice)
					.deleteSession(created.id)
					.catch(() => undefined);
			}
		});

		await check(disconnecting, async () => {
			assert(watch, "no session");
			const status = await userOf(alice).githubDisconnect();
			assert(
				status.connection === null && (await userOf(alice).github()).connection === null,
				"the connection is still there",
			);
			await refused(() => userOf(alice).githubRepositories(""), "github_not_connected");
			await refused(
				() => userOf(alice).createSession({ profile: profile as never, repository: { id: harbor.id } }),
				"github_not_connected",
			);
			const said = await refused(
				() => sessionOf(alice, sessionId).publish({ message: { title: "After", body: "" } }),
				"github_gone",
			);
			assert(
				said === "GitHub is not connected any more. Connect GitHub again in Settings, then try once more.",
				`a push says "${said}"`,
			);
			// The session stays, with what it was launched on; and a ticket from before cannot bring the connection back.
			const kept = (await userOf(alice).listSessions()).find(session => session.id === sessionId);
			assert(
				kept?.repository?.name === "harbor" && kept.pullRequest?.number === 2,
				"the session lost its repository or its pull request",
			);
			await refused(() => userOf(alice).githubComplete(ticket), "github_ticket");
			// Connecting again works, and the session can push again.
			await connect(alice, "ada");
			const again = await sessionOf(alice, sessionId).publish({ message: { title: "Back again", body: "" } });
			assert(
				again.state.pullRequest?.number === 2 && !again.opened,
				`after connecting again the result is ${plain(again.state.pullRequest)}`,
			);
			// A session of a user who disconnected before its first prompt: the clone says so.
			const late = await userOf(alice).createSession({
				profile: profile as never,
				title: "Too late",
				repository: { id: harbor.id },
			});
			await userOf(alice).githubDisconnect();
			const lateWatch = new Watch(client, alice.profile.uid, late.id, alice.token);
			try {
				const { turn } = await lateWatch.conn.prompt({ text: "Write a short program" });
				const ended = await lateWatch.untilEnded(turn);
				assert(
					ended.outcome === "error" && ended.message === said,
					`the turn ended ${ended.outcome}: ${ended.message}`,
				);
			} finally {
				await lateWatch.conn.dispose().catch(() => undefined);
				await userOf(alice)
					.deleteSession(late.id)
					.catch(() => undefined);
			}
			return `"${said}"; connecting again brings the session's pushes back`;
		});

		await check(secrets, async () => {
			assert(watch, "no session");
			const tokens = [...standin.tokens.keys()];
			const texts = [
				server.output,
				JSON.stringify((await sessionOf(alice, sessionId).snapshot()).timeline),
				JSON.stringify(watch.items),
			];
			const found = [standin.clientSecret, ...tokens].filter(secret => texts.some(text => text.includes(secret)));
			assert(
				found.length === 0,
				`${found.length} of them appear: ${found.map(secret => `${secret.slice(0, 8)}…`).join(", ")}`,
			);
			assert(!texts.some(text => text.includes("PRIVATE KEY")), "the private key appears");
			assert(tokens.length > 10, `only ${tokens.length} tokens were issued`);
			return `${tokens.length} tokens were issued; none, nor the client secret or the private key, is in ${texts[0].length + texts[1].length} characters of log and timeline`;
		});

		await watch?.conn.dispose().catch(() => undefined);
		if (sessionId)
			await userOf(alice)
				.deleteSession(sessionId)
				.catch(() => undefined);
	} finally {
		await standin.stop().catch(() => undefined);
	}
}

// ---------------------------------------------------------------------------------------------
// The user's remembered approvals of projects' MCP servers (server/src/server-approvals.ts)
// ---------------------------------------------------------------------------------------------

const SERVER_APPROVAL_CHECKS = [
	"a session whose project names no server has no list of servers",
	"the first session on a repository is asked, and its panel lists the server: waiting, then running, with the approval and until when",
	"a second session on the same repository is not asked: the server starts, and one line says why",
	"a later turn in the same sandbox says nothing, and a sandbox that replaces a lost one is not asked",
	"a changed definition, another user, and another repository that names the server the same way are each asked",
	'"not now" is not remembered, and the panel approves the server that waits: it starts with the next turn, unasked',
	"the panel's approval answers a question that is open, and refuses a definition that is not the one shown",
	"forgetting holds for the next session: it is asked, and the sandbox the server started in is not",
	"a session with no repository is its own project, and one launched through the GitHub connection is known by the repository's id",
	"what is remembered is with the user, not with a server: it holds across a restart, and for no other user",
	"an approval past its time is asked about again, and the panel no longer lists it",
	"the repository's page lists the approval with its times, for its user alone, and forgetting it there has the next session asked",
	"a user's own MCP server and its secret, saved in the account's settings, reach a sandbox that exists with its next turn, are listed apart from the project's, and are no other user's",
];

/**
 * The fake layer with WLP_FAKE_BACKUP_DIR, so that its Windlass remembers an approval in the sandbox
 * it was given in and nowhere else, as Windlass does on E2B: what a second session or a new sandbox
 * is spared is then the platform's doing. GitHub is the stand-in, for a session whose project is a
 * repository of the connection. The sandboxes are in the server's memory, so a restart loses them all.
 */
async function serverApprovalChecks(
	server: Server,
	client: Client,
	demoSignIn: () => Promise<AuthResult>,
	profile: string,
): Promise<void> {
	const [none, first, second, replaced, asked, notNow, open, forgetting, projects, restart, expiry, page, account] =
		SERVER_APPROVAL_CHECKS as [
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
		];
	type Servers = import("../server/src/contract.js").SessionServers;
	const DAYS_30 = 30 * 24 * 60 * 60 * 1000;
	const ORIGIN = "http://localhost:5173";
	const HARBOR = "python3 tools/harbor_mcp.py";
	const REPO = "https://example.com/acme/harbor.git";
	const standin = new GithubStandin({ callbackUrl: `${API}/github/callback`, strictBranches: false });
	await standin.start();
	const env = {
		...standin.env(),
		WLP_FAKE_BACKUP_DIR: join(server.storage, "bucket-approvals"),
		WLP_LOGIN_TTL_MS: String(loginTtlMs),
	};
	const restartWith = async (extra: Record<string, string> = {}) => {
		await server.stop();
		await waitFor(`ports ${ENGINE_PORT} and ${HTTP_PORT} to be free`, portsFree, 20_000, 200);
		await server.start({ ...env, ...extra });
	};

	const userOf = (auth: AuthResult) => client.user.getOrCreate([auth.profile.uid], { params: { token: auth.token } });
	interface Opened {
		id: string;
		auth: AuthResult;
		watch: Watch;
		servers(): Promise<Servers>;
	}
	const opened: Opened[] = [];
	const watchOf = (auth: AuthResult, id: string): Opened => {
		const handle = client.agentSession.get([auth.profile.uid, id], { params: { token: auth.token } });
		const session: Opened = {
			id,
			auth,
			watch: new Watch(client, auth.profile.uid, id, auth.token),
			servers: () => handle.servers(),
		};
		opened.push(session);
		return session;
	};
	const launch = async (
		auth: AuthResult,
		input: { repoUrl?: string; repository?: { id: GithubId } } = {},
	): Promise<Opened> => {
		const created = await userOf(auth).createSession({ profile: profile as never, title: "Servers", ...input });
		const session = watchOf(auth, created.id);
		await session.watch.conn.snapshot();
		return session;
	};
	/** Starts a turn and waits for the question about a server, or for the turn's end without one. */
	const begin = async (
		session: Opened,
		text: string,
	): Promise<{ turn: number; asked: PendingQuestion | null; from: number }> => {
		const { watch } = session;
		await waitFor(
			"the session to be idle",
			() => watch.summaries.length === 0 || watch.summaries.at(-1)?.status === "idle",
			TURN_MS,
		);
		const from = watch.summaries.length;
		const questions = watch.questions.length;
		const { turn } = await watch.conn.prompt({ text });
		const got = await waitFor(
			"a question about a server, or the turn's end",
			() =>
				watch.questions.slice(questions).find(question => question !== null && question.turn === turn) ??
				(watch.ended(turn) ? "ended" : undefined),
			TURN_MS,
		);
		return { turn, asked: got === "ended" ? null : got, from };
	};
	const finish = async (session: Opened, turn: number) => {
		const ended = await session.watch.untilEnded(turn);
		assert(ended.outcome === "succeeded", `turn ${turn} ended ${ended.outcome}: ${ended.message ?? ""}`);
	};
	/** A turn that must not ask: to its end. Returns the platform's lines about servers. */
	const unasked = async (session: Opened, text: string): Promise<string[]> => {
		const { turn, asked, from } = await begin(session, text);
		assert(asked === null, `the session was asked: ${plain(asked).slice(0, 200)}`);
		await finish(session, turn);
		assert(
			!session.watch.summaries.slice(from).some(summary => summary.status === "waiting"),
			"the session waited on a question",
		);
		return linesOf(session, turn);
	};
	/** A turn that must ask: answers, and runs to its end. */
	const answered = async (
		session: Opened,
		text: string,
		choice: "start" | "not_now",
	): Promise<{ turn: number; asked: PendingQuestion; lines: string[] }> => {
		const { turn, asked } = await begin(session, text);
		assert(asked?.server !== undefined, "the session was not asked about a server");
		await session.watch.conn.answer({ questionId: asked.id, choice });
		await finish(session, turn);
		return { turn, asked, lines: linesOf(session, turn) };
	};
	const linesOf = (session: Opened, turn: number) =>
		session.watch.items.flatMap(item =>
			item.kind === "platform" && item.turn === turn && item.text.includes("MCP server") ? [item.text] : [],
		);
	const STARTED = 'Started the MCP server "harbor" for this project: 2 tools. The agent has them from this turn on.';
	/** The line of a server started from the user's record. When they approved is said as "a moment ago", or in minutes once this run has taken that long. */
	const RECALLED =
		/^Started the MCP server "harbor" because you approved it for this project (a moment|1 minute|\d+ minutes) ago: 2 tools\. The agent has them from this turn on\.$/;
	const recalled = (lines: string[]) => lines.length === 1 && RECALLED.test(lines[0] ?? "");
	const FORGETTING =
		"Forgetting holds for the next session or sandbox. Where the server already started, Windlass's own record still starts it, and a running one is not stopped.";

	let ok = true;
	const step = async (name: string, body: () => Promise<string | undefined>) => {
		if (!ok) {
			skip(name, "an earlier check of the remembered approvals failed");
			return;
		}
		ok = await check(name, body);
	};

	try {
		await restartWith();
		const ada = await demoSignIn();
		const bo = await demoSignIn();
		let one: Opened | null = null;
		let two: Opened | null = null;
		let print = "";
		let approvedAt = 0;

		await step(none, async () => {
			const session = await launch(ada, { repoUrl: "https://example.com/acme/nothing.git" });
			const { turn } = await session.watch.conn.prompt({ text: "Write a short program" });
			await finish(session, turn);
			const snapshot = await session.watch.conn.snapshot();
			assert(snapshot.summary.servers === undefined, `the summary has ${plain(snapshot.summary.servers)}`);
			const listed = await session.servers();
			assert(
				listed.servers.length === 0 &&
					plain(listed.project) === plain({ kind: "address", label: "example.com/acme/nothing.git" }),
				`servers() is ${plain(listed)}`,
			);
			await userOf(ada).deleteSession(session.id);
			return "no servers in its summary, and an empty list";
		});

		await step(first, async () => {
			one = await launch(ada, { repoUrl: REPO });
			const { turn, asked } = await begin(one, "say hello (mcp)");
			assert(asked?.server?.name === "harbor" && asked.subject === HARBOR, `asked: ${plain(asked).slice(0, 200)}`);
			// Where Windlass's data is the sandbox's own, the question says how far the platform remembers the answer.
			assert(asked.details.length === 3, `details: ${plain(asked.details)}`);
			assert(
				asked.details[1] ===
					"Approving starts it now and is remembered for 30 days for exactly this definition: your sessions on example.com/acme/harbor.git then start it without asking, until you forget the approval in a session's panel.",
				`details: ${plain(asked.details)}`,
			);
			assert(
				asked.details[2] ===
					"It is an approval of this command, not of the files it runs: a later commit can change those without a new question.",
				`details: ${plain(asked.details)}`,
			);
			assert(
				asked.choices[0].remembers ===
					"exactly this definition, for your sessions on example.com/acme/harbor.git, for 30 days",
				`remembers: ${asked.choices[0].remembers}`,
			);
			const waiting = await one.servers();
			const before = waiting.servers[0];
			assert(
				waiting.servers.length === 1 &&
					before.name === "harbor" &&
					before.state === "waiting" &&
					before.subject === HARBOR &&
					before.remote === false &&
					before.file === "/workspace/.windlass/config.json",
				`while it waits: ${plain(waiting.servers)}`,
			);
			assert(
				/^[0-9a-f]{16}$/.test(before.fingerprint ?? "") &&
					before.approval === null &&
					before.tools === null &&
					before.reason === null,
				`while it waits: ${plain(before)}`,
			);
			assert(
				plain(waiting.project) === plain({ kind: "address", label: "example.com/acme/harbor.git" }) &&
					waiting.forgetting === FORGETTING,
				`project ${plain(waiting.project)}; "${waiting.forgetting}"`,
			);
			print = before.fingerprint ?? "";
			const told = one.watch.summaries.at(-1)?.servers;
			assert(told?.count === 1 && told.changedAt > 0, `the summary's servers are ${plain(told)}`);
			const at = Date.now();
			await one.watch.conn.answer({ questionId: asked.id, choice: "start" });
			await finish(one, turn);
			assert(plain(linesOf(one, turn)) === plain([STARTED]), `lines: ${plain(linesOf(one, turn))}`);
			const listed = await waitFor(
				"the approval to be remembered",
				async () => ((await (one as Opened).servers()).servers[0]?.approval ? (one as Opened).servers() : undefined),
				10_000,
				100,
			);
			const server = listed.servers[0];
			assert(
				server.state === "running" && server.tools === 2 && server.fingerprint === print,
				`after the approval: ${plain(server)}`,
			);
			assert(
				server.approval !== null &&
					server.approval.approvedAt >= at &&
					server.approval.approvedAt <= Date.now() &&
					server.approval.expiresAt - server.approval.approvedAt === DAYS_30,
				`the approval is ${plain(server.approval)}`,
			);
			approvedAt = server.approval.approvedAt;
			const after = one.watch.summaries.at(-1)?.servers;
			assert(
				after !== undefined && after.changedAt > told.changedAt,
				`the summary's servers did not change: ${plain(told)} then ${plain(after)}`,
			);
			const mine = (await userOf(ada).listSessions()).find(summary => summary.id === (one as Opened).id);
			assert(mine?.servers?.count === 1, `the user's list has ${plain(mine?.servers)}`);
			return `"${asked.details[1]}" Then running with 2 tools, approved until ${new Date(server.approval.expiresAt).toISOString()}`;
		});

		await step(second, async () => {
			two = await launch(ada, { repoUrl: REPO });
			const lines = await unasked(two, "say hello (mcp)");
			assert(recalled(lines) && lines[0].includes("a moment ago"), `lines: ${plain(lines)}`);
			const listed = await two.servers();
			const server = listed.servers[0];
			assert(
				listed.servers.length === 1 && server.state === "running" && server.tools === 2 && server.fingerprint === print,
				`its panel lists ${plain(listed.servers)}`,
			);
			// Using the approval does not renew it.
			assert(
				server.approval?.approvedAt === approvedAt,
				`the approval is ${plain(server.approval)}, given at ${approvedAt}`,
			);
			assert(!server.subject.includes("--") && two.watch.questions.length === 0, "a question event arrived");
			return lines[0];
		});

		await step(replaced, async () => {
			assert(one, "no first session");
			const same = await unasked(one, "once more (mcp)");
			assert(same.length === 0, `a turn in the sandbox the server was approved in says ${plain(same)}`);
			// The sandbox is gone when this turn ends, as if E2B had lost it.
			const lost = await unasked(one, "and again (mcp) (lose-sandbox)");
			assert(lost.length === 0, `lines: ${plain(lost)}`);
			const { turn, asked } = await begin(one, "where were we (mcp)");
			assert(asked === null, `the replaced sandbox asked: ${plain(asked).slice(0, 200)}`);
			await finish(one, turn);
			const texts = one.watch.items.flatMap(item =>
				item.kind === "platform" && item.turn === turn ? [item.text] : [],
			);
			assert(
				texts.some(text => text.startsWith("Starting a hosted sandbox")),
				`no new sandbox was made: ${plain(texts)}`,
			);
			assert(recalled(linesOf(one, turn)), `lines: ${plain(linesOf(one, turn))}`);
			return `nothing said in the same sandbox; in the one that replaced it: "${linesOf(one, turn)[0]}"`;
		});

		await step(asked, async () => {
			assert(two, "no second session");
			const changed = await answered(two, "and now (mcp-changed)", "not_now");
			assert(changed.asked.subject === `${HARBOR} --berths 12`, `asked about ${changed.asked.subject}`);
			const theirs = await launch(bo, { repoUrl: REPO });
			const other = await answered(theirs, "say hello (mcp)", "not_now");
			assert(other.asked.subject === HARBOR, `another user was asked about ${other.asked.subject}`);
			const elsewhere = await launch(ada, { repoUrl: "https://example.com/acme/lighthouse.git" });
			const same = await answered(elsewhere, "say hello (mcp)", "not_now");
			const listed = await elsewhere.servers();
			assert(
				same.asked.subject === HARBOR &&
					listed.servers[0]?.fingerprint === print &&
					listed.servers[0].approval === null &&
					listed.servers[0].state === "waiting",
				`another repository: ${plain(listed.servers)}`,
			);
			await userOf(ada).deleteSession(elsewhere.id);
			return `asked about ${changed.asked.subject}; another user asked; another repository with the same definition (${print}) asked`;
		});

		let theirs: Opened | null = null;
		await step(notNow, async () => {
			theirs = opened.find(session => session.auth === bo) ?? null;
			assert(theirs, "no session of the other user");
			const waiting = (await theirs.servers()).servers[0];
			assert(
				waiting?.state === "waiting" && waiting.approval === null && waiting.fingerprint === print,
				`after "not now": ${plain(waiting)}`,
			);
			const again = await answered(theirs, "try again (mcp)", "not_now");
			assert(
				again.lines.length === 1 && again.lines[0].startsWith('Left the MCP server "harbor" stopped.'),
				`lines: ${plain(again.lines)}`,
			);
			const items = theirs.watch.items.length;
			const approved = await theirs.watch.conn.approveServer({ name: "harbor", fingerprint: print });
			assert(
				approved.servers[0]?.state === "waiting" &&
					approved.servers[0].approval !== null &&
					approved.servers[0].approval.expiresAt - approved.servers[0].approval.approvedAt === DAYS_30,
				`after the panel's approval: ${plain(approved.servers)}`,
			);
			const line = await waitFor(
				"the line about the panel's approval",
				() => theirs?.watch.items.slice(items).find(item => item.kind === "platform"),
				5_000,
			);
			assert(
				line.kind === "platform" &&
					line.level === "info" &&
					line.text ===
						'Approved the MCP server "harbor" for this project in the session\'s panel. It starts with the next turn.',
				`the line is ${plain(line)}`,
			);
			const lines = await unasked(theirs, "and now (mcp)");
			assert(recalled(lines), `lines: ${plain(lines)}`);
			assert((await theirs.servers()).servers[0]?.state === "running", "the server does not run");
			return `"${line.text}" Then: "${lines[0]}"`;
		});

		await step(open, async () => {
			const session = await launch(bo, { repoUrl: "https://example.com/acme/pier.git" });
			const { turn, asked } = await begin(session, "say hello (mcp)");
			assert(asked?.server !== undefined, "the session was not asked");
			await refused(
				() => session.watch.conn.approveServer({ name: "harbor", fingerprint: "0000000000000000" }),
				"server_changed",
			);
			await refused(() => session.watch.conn.approveServer({ name: "tracker", fingerprint: print }), "server_gone");
			await refused(() => session.watch.conn.approveServer({ name: "harbor" } as never), "bad_server");
			await refused(() => session.watch.conn.forgetServer({} as never), "bad_server");
			assert(
				(await session.watch.conn.snapshot()).question?.id === asked.id,
				"a refused approval settled the question",
			);
			await session.watch.conn.approveServer({ name: "harbor", fingerprint: print });
			await waitFor("the question event to say null", () => session.watch.questions.at(-1) === null, 5_000);
			await finish(session, turn);
			assert(plain(linesOf(session, turn)) === plain([STARTED]), `lines: ${plain(linesOf(session, turn))}`);
			const listed = await waitFor(
				"the approval to be remembered",
				async () => ((await session.servers()).servers[0]?.approval ? session.servers() : undefined),
				10_000,
				100,
			);
			assert(
				listed.servers[0].state === "running" && listed.servers[0].tools === 2,
				`its panel lists ${plain(listed.servers)}`,
			);
			await refused(() => session.watch.conn.approveServer({ name: "harbor", fingerprint: print }), "server_changed");
			await refused(() => session.watch.conn.answer({ questionId: asked.id, choice: "start" }), "no_question");
			await userOf(bo).deleteSession(session.id);
			return `the open question was answered from the panel: "${STARTED}"; another definition, an unknown server and a server that runs are refused`;
		});

		await step(forgetting, async () => {
			assert(one && two, "no sessions");
			// This session's workspace has the changed definition, which waits: the approval it lists is of the earlier one.
			const before = (await two.servers()).servers[0];
			assert(
				before?.state === "waiting" &&
					before.fingerprint !== print &&
					before.approval === null &&
					before.earlier?.approvedAt === approvedAt,
				`before forgetting: ${plain(before)}`,
			);
			assert(
				(await one.servers()).servers[0]?.approval?.approvedAt === approvedAt,
				"the first session does not list the approval",
			);
			const items = two.watch.items.length;
			const forgotten = await two.watch.conn.forgetServer({ name: "harbor" });
			assert(
				forgotten.servers[0]?.approval === null && forgotten.servers[0].earlier === undefined,
				`after forgetting: ${plain(forgotten.servers)}`,
			);
			const line = await waitFor(
				"the line about forgetting",
				() => two?.watch.items.slice(items).find(item => item.kind === "platform"),
				5_000,
			);
			assert(
				line.kind === "platform" &&
					line.text ===
						'Forgot your approval of the MCP server "harbor" for this project. The next session or sandbox asks again; where it already started, Windlass\'s own record still starts it.',
				`the line is ${plain(line)}`,
			);
			// The first session of the same project sees it gone as well: the record is the user's, not a session's.
			assert(
				(await one.servers()).servers[0]?.approval === null,
				"the other session on the repository still lists the approval",
			);
			const count = two.watch.items.length;
			const nothing = await two.watch.conn.forgetServer({ name: "harbor" });
			assert(
				nothing.servers[0]?.approval === null && two.watch.items.length === count,
				"forgetting what is not remembered said something",
			);
			const next = await launch(ada, { repoUrl: REPO });
			const again = await answered(next, "say hello (mcp)", "not_now");
			assert(again.asked.subject === HARBOR, `the next session was asked about ${again.asked.subject}`);
			// The sandbox of the first session started the server already: its Windlass goes on starting it.
			const still = await unasked(one, "still here (mcp)");
			assert(
				still.length === 0 && (await one.servers()).servers[0]?.state === "running",
				`the sandbox the server started in: ${plain(still)}`,
			);
			// Bo's own approval of the same repository is untouched.
			assert(theirs && (await theirs.servers()).servers[0]?.approval !== null, "another user's approval went with it");
			await userOf(ada).deleteSession(next.id);
			return `"${line.text}" The next session was asked; the first one's sandbox was not`;
		});

		let alone: Opened | null = null;
		let onGithub: Opened | null = null;
		await step(projects, async () => {
			alone = await launch(ada);
			const mine = await answered(alone, "say hello (mcp)", "start");
			assert(
				mine.asked.details[1] ===
					"Approving starts it now and is remembered for 30 days for exactly this definition, for this session, which has no repository: a sandbox that replaces this one starts it without asking, until you forget the approval in the session's panel.",
				`details: ${plain(mine.asked.details)}`,
			);
			assert(
				mine.asked.choices[0].remembers === "exactly this definition, for this session, for 30 days",
				`remembers: ${mine.asked.choices[0].remembers}`,
			);
			const listed = await waitFor(
				"the approval to be remembered",
				async () =>
					(await (alone as Opened).servers()).servers[0]?.approval ? (alone as Opened).servers() : undefined,
				10_000,
				100,
			);
			assert(
				plain(listed.project) === plain({ kind: "session", label: "this session" }),
				`project: ${plain(listed.project)}`,
			);
			const another = await launch(ada);
			const asked = await answered(another, "say hello (mcp)", "not_now");
			assert(asked.asked.subject === HARBOR, "another session without a repository was not asked");
			await userOf(ada).deleteSession(another.id);

			// A repository of the GitHub connection: ada at GitHub has harbor, and connects.
			standin.addUser("ada");
			const installation = standin.addInstallation("ada", "User");
			const harbor = standin.addRepository({ owner: "ada", name: "harbor", private: true, installation });
			const { url } = await userOf(ada).githubConnect({ origin: ORIGIN });
			const back = await fetch(standin.authorize("ada", url), { redirect: "manual" });
			const location = back.headers.get("location") ?? "";
			assert(
				back.status === 302 && location.includes("#github="),
				`the callback sent the browser to ${location.slice(0, 80)}`,
			);
			await userOf(ada).githubComplete(location.slice(location.indexOf("#github=") + 8));
			onGithub = await launch(ada, { repository: { id: harbor.id } });
			const github = await answered(onGithub, "say hello (mcp)", "start");
			assert(
				github.asked.details[1].includes("your sessions on ada/harbor then start it without asking"),
				`details: ${plain(github.asked.details)}`,
			);
			assert(
				plain((await onGithub.servers()).project) === plain({ kind: "github", label: "ada/harbor" }),
				"the project is not the repository",
			);
			const again = await launch(ada, { repository: { id: harbor.id } });
			const lines = await unasked(again, "say hello (mcp)");
			assert(recalled(lines), `a second session on the GitHub repository: ${plain(lines)}`);
			// The same repository by its address is another project: it was not launched through the connection.
			const byAddress = await launch(ada, { repoUrl: "https://github.example/ada/harbor.git" });
			const pasted = await answered(byAddress, "say hello (mcp)", "not_now");
			assert(pasted.asked.subject === HARBOR, "the pasted address was not asked");
			await userOf(ada).deleteSession(again.id);
			await userOf(ada).deleteSession(byAddress.id);
			return `"this session" is asked once and another session without a repository again; ada/harbor (GitHub id ${harbor.id}) is asked once, and its pasted address again`;
		});

		await step(restart, async () => {
			assert(one && alone && onGithub && theirs, "no sessions");
			for (const session of opened) await session.watch.conn.dispose().catch(() => undefined);
			await restartWith();
			// Every sandbox went with the server: each session gets a new one, and its Windlass asks about the server.
			const github = watchOf(ada, onGithub.id);
			const mine = watchOf(ada, alone.id);
			const bos = watchOf(bo, theirs.id);
			const forgotten = watchOf(ada, one.id);
			for (const session of [github, mine, bos]) {
				const lines = await unasked(session, "after the restart (mcp)");
				assert(recalled(lines), `session ${session.id} after the restart: ${plain(lines)}`);
			}
			// What ada forgot stays forgotten, in the session the server once started in too: its sandbox is new.
			const again = await answered(forgotten, "after the restart (mcp)", "not_now");
			assert(again.asked.subject === HARBOR, "the forgotten approval came back");
			assert(
				server.output.includes(`[wlp] server.approval_remembered uid=${ada.profile.uid} `) &&
					server.output.includes(`[wlp] server.approval_forgotten uid=${ada.profile.uid} `),
				"the server did not log what it remembered and forgot",
			);
			return "three sessions of two users were not asked in their new sandboxes; the forgotten one was";
		});

		await step(expiry, async () => {
			const TTL = 10_000;
			for (const session of opened) await session.watch.conn.dispose().catch(() => undefined);
			await restartWith({ WLP_SERVER_APPROVAL_TTL_MS: String(TTL) });
			const cy = await demoSignIn();
			const begun = await launch(cy, { repoUrl: REPO });
			const approved = await answered(begun, "say hello (mcp)", "start");
			assert(plain(approved.lines) === plain([STARTED]), `lines: ${plain(approved.lines)}`);
			const listed = await waitFor(
				"the approval to be remembered",
				async () => ((await begun.servers()).servers[0]?.approval ? begun.servers() : undefined),
				10_000,
				100,
			);
			const approval = listed.servers[0].approval;
			assert(
				approval !== null && approval.expiresAt - approval.approvedAt === TTL,
				`the approval is ${plain(approval)}`,
			);
			const soon = await launch(cy, { repoUrl: REPO });
			const lines = await unasked(soon, "say hello (mcp)");
			assert(
				recalled(lines) && Date.now() < approval.expiresAt,
				`within its time: ${plain(lines)}, ${approval.expiresAt - Date.now()} ms left`,
			);
			await sleep(Math.max(0, approval.expiresAt - Date.now()) + 300);
			const late = await launch(cy, { repoUrl: REPO });
			const again = await answered(late, "say hello (mcp)", "not_now");
			assert(again.asked.subject === HARBOR, "past its time the approval still answered");
			assert(
				(await begun.servers()).servers[0]?.approval === null,
				"the panel still lists an approval that has run out",
			);
			return `within ${TTL / 1000} seconds a second session was not asked; after them a third was, and the first one's panel lists no approval`;
		});

		await step(page, async () => {
			assert(onGithub, "no session on the repository");
			const github = onGithub;
			const repositoryId = (await userOf(ada).listSessions()).find(session => session.id === github.id)?.repository?.id;
			assert(repositoryId, "the session lost its repository");
			const view = await userOf(ada).repository(repositoryId);
			const [approval] = view.approvals;
			assert(
				view.name === "ada/harbor" &&
					view.approvals.length === 1 &&
					approval.name === "harbor" &&
					approval.definitions === 1 &&
					approval.expiresAt - approval.approvedAt === DAYS_30,
				`the page lists ${plain(view.approvals)} for ${view.name}`,
			);
			assert(view.forgetting === FORGETTING, `it says of forgetting: "${view.forgetting}"`);
			assert(
				plain(await userOf(ada).savedRepositories()) === plain([{ id: repositoryId, name: "ada/harbor" }]),
				`the repositories with something saved: ${plain(await userOf(ada).savedRepositories())}`,
			);
			// Another user's page of the same repository has none of it, and cannot forget it.
			assert(
				(await userOf(bo).forgetRepositoryApproval({ repositoryId, name: "harbor" })).approvals.length === 0 &&
					(await userOf(ada).repository(repositoryId)).approvals.length === 1,
				"another user saw or forgot the approval",
			);
			const after = await userOf(ada).forgetRepositoryApproval({ repositoryId, name: "harbor" });
			assert(
				after.approvals.length === 0 && (await userOf(ada).savedRepositories()).length === 0,
				`after forgetting: ${plain(after.approvals)}`,
			);
			assert((await github.servers()).servers[0]?.approval === null, "the session's panel still lists the approval");
			const fresh = await launch(ada, { repository: { id: repositoryId } });
			const again = await answered(fresh, "say hello (mcp)", "not_now");
			assert(again.asked.subject === HARBOR, "the next session on the repository was not asked");
			return `ada/harbor: "harbor", good for 30 days; forgotten on the page, and the next session was asked`;
		});

		await step(account, async () => {
			const mine = userOf(ada);
			const empty = await mine.account();
			assert(
				empty.servers.length === 0 &&
					empty.defaults.profile === null &&
					empty.defaults.model === null &&
					empty.serverReach.length > 0,
				`an account nothing is saved for: ${plain(empty).slice(0, 300)}`,
			);
			assert(
				(empty.serverReach[0]?.command ?? "").includes("outside Windlass's sandbox around commands") ||
					(empty.serverReach[0]?.command ?? "").includes("as the agent's commands do here") ||
					(empty.serverReach[0]?.command ?? "").includes("never inside Windlass's sandbox"),
				`what a server can reach: ${empty.serverReach[0]?.command}`,
			);
			await refused(
				() => mine.savePersonalServer({ name: "windlass_platform", definition: { command: "x" } }),
				"bad_server",
			);
			await refused(() => mine.savePersonalServer({ name: "notes", definition: { comand: "x" } }), "bad_server");
			const saved = await mine.savePersonalServer({
				name: "notes",
				definition: { command: "notes-mcp", args: ["--stdio"], env: { NOTES_TOKEN: "${NOTES_TOKEN}" } },
			});
			assert(
				saved.servers.length === 1 &&
					saved.servers[0]?.subject === "notes-mcp --stdio" &&
					saved.servers[0]?.unasked === false &&
					plain(saved.servers[0]?.reads) === plain([{ name: "NOTES_TOKEN", saved: false }]),
				`saved: ${plain(saved.servers)}`,
			);
			// Its tools ask unless its user says otherwise, and the setting is saved with the definition and is not part of it.
			await refused(
				() =>
					mine.savePersonalServer({
						name: "notes",
						definition: saved.servers[0]?.definition,
						unasked: "yes" as never,
						existing: true,
					}),
				"bad_server",
			);
			const unasked = await mine.savePersonalServer({
				name: "notes",
				definition: saved.servers[0]?.definition,
				unasked: true,
				existing: true,
			});
			assert(
				unasked.servers[0]?.unasked === true && !("unasked" in (unasked.servers[0]?.definition ?? {})),
				`with the setting on: ${plain(unasked.servers)}`,
			);
			assert(
				(await mine.savePersonalServer({ name: "notes", definition: saved.servers[0]?.definition, existing: true }))
					.servers[0]?.unasked === false,
				"the setting was not switched off again",
			);
			await refused(
				() => mine.savePersonalServer({ name: "notes", definition: { command: "other" } }),
				"server_exists",
			);

			// A session with no server of its project: the user's own is the only one, and does not start without its secret.
			const session = await launch(ada, { repoUrl: "https://example.com/acme/nothing.git" });
			const turn = async (text: string) => {
				const { turn: number } = await session.watch.conn.prompt({ text });
				await finish(session, number);
				return session.servers();
			};
			const without = await turn("Write a short program");
			const [failed] = without.servers;
			assert(
				without.servers.length === 1 &&
					failed.name === "notes" &&
					failed.origin === "user" &&
					failed.state === "failed" &&
					failed.reason === "the environment variable NOTES_TOKEN named in its env is not set" &&
					failed.approval === null &&
					failed.fingerprint === null &&
					failed.asks === undefined,
				`without its secret: ${plain(without.servers)}`,
			);

			// The secret is saved for the account: no value comes back, and the sandbox that exists has it from its next turn.
			const value = `made-up-${randomBytes(12).toString("hex")}`;
			const listed = await mine.saveAccountSecret({
				profile: profile as never,
				name: "NOTES_TOKEN",
				value,
				scope: "setup",
			});
			assert(
				listed.secrets.length === 1 &&
					listed.secrets[0]?.name === "NOTES_TOKEN" &&
					listed.secrets[0]?.scope === "setup" &&
					!plain([listed, await mine.account()]).includes(value),
				"the list of the account's secrets is not one name without a value",
			);
			const handed = listed.secrets[0]?.reach.servers === true;
			const withIt = await turn("Write a short program again");
			const [now] = withIt.servers;
			if (handed)
				assert(
					now?.state === "running" && now.tools === 1 && now.origin === "user" && withIt.accountSecrets == null,
					`with its secret: ${plain(withIt)}`,
				);
			// Where the profile's commands are not held in Windlass's sandbox, a secret for MCP servers only reaches no server, and the panel says why.
			else
				assert(
					now?.state === "failed" &&
						typeof withIt.accountSecrets === "string" &&
						withIt.accountSecrets.includes("only those that are also for the agent's commands"),
					`in a sandbox that hands it to no server: ${plain(withIt)}`,
				);
			// Its user says it may also go where the agent's commands could read it: the scope alone is saved, no value comes back, and the server starts in every profile.
			await refused(
				() => mine.saveAccountSecret({ profile: profile as never, name: "NOT_SAVED", scope: "agent" }),
				"secret_not_found",
			);
			const wide = await mine.saveAccountSecret({ profile: profile as never, name: "NOTES_TOKEN", scope: "agent" });
			assert(
				wide.secrets[0]?.scope === "agent" &&
					plain(wide.secrets[0]?.reach) === plain({ servers: true, commands: "yes", note: null }) &&
					!plain(wide).includes(value),
				`also for the agent's commands: ${plain(wide)}`,
			);
			const [everywhere] = (await turn("Write a short program a third time")).servers;
			assert(
				everywhere?.state === "running" && everywhere.tools === 1,
				`with its secret also for the agent's commands: ${plain(everywhere)}`,
			);
			assert(
				!server.output.includes(value) && !plain((await session.watch.conn.snapshot()).timeline).includes(value),
				"the secret's value is in the server's log or in the timeline",
			);

			// Another user has none of it.
			const theirs = await userOf(bo).account();
			assert(
				theirs.servers.length === 0 &&
					(await userOf(bo).accountSecrets({ profile: profile as never })).secrets.length === 0,
				`another user's account: ${plain(theirs.servers)}`,
			);

			// The defaults are saved field by field, and a deleted server is gone from the sandbox with its next turn.
			const models = (await mine.models()).models.map(model => model.id);
			await mine.saveAccountDefaults({ model: models[models.length - 1] });
			const defaults = await mine.saveAccountDefaults({ profile: profile as never });
			assert(
				defaults.profile === profile && defaults.model === models[models.length - 1],
				`the defaults: ${plain(defaults)}`,
			);
			await refused(() => mine.saveAccountDefaults({ model: "no-such-model" }), "bad_model");
			assert((await mine.deletePersonalServer("notes")).servers.length === 0, "the server was not deleted");
			const after = await turn("Write a short program once more");
			assert(
				after.servers.length === 0 && (await session.watch.conn.snapshot()).summary.servers === undefined,
				`after it was deleted: ${plain(after.servers)}`,
			);
			await mine.deleteAccountSecret({ profile: profile as never, name: "NOTES_TOKEN" });
			await mine.saveAccountDefaults({ profile: null, model: null });
			return `"notes": could not start without its secret, ${handed ? "ran with it from the next turn" : "is given no account secret in this profile, which the panel says"}, and was gone after it was deleted`;
		});
	} finally {
		for (const session of opened) await session.watch.conn.dispose().catch(() => undefined);
		await standin.stop().catch(() => undefined);
	}
}

// ---------------------------------------------------------------------------------------------

/** Interleave short, cold setups on the same local repository and Docker image. */
async function snapshotTimings(
	server: Server,
	client: Client,
	github: GithubStandin,
	repo: ReturnType<GithubStandin["addRepository"]>,
	uid: string,
	token: string,
) {
	const params = { token },
		user = client.user.get([uid], { params });
	try {
		await user.saveRepositorySetup({
			repositoryId: repo.id,
			command: 'node -e \'require("node:fs").copyFileSync("base.txt", "built.txt")\'',
		});
		for (let run = 1; run <= 3; run++) {
			for (const mode of ["off", "on"] as const) {
				await server.stop();
				await waitFor("the previous server to release its ports", portsFree, 30_000, 250);
				await server.start({ ...github.env(), WLP_SNAPSHOTS: mode });
				const before = github.requests.length;
				const session = await user.createSession({
					profile: "docker-hardened",
					repository: { id: repo.id, branch: "main" },
				});
				try {
					const actor = client.agentSession.get([uid, session.id], { params });
					await actor.prompt({ text: "Explore the workspace" });
					await waitFor(
						"the benchmark turn",
						async () => (await actor.snapshot()).timeline.some(t => t.kind === "turn.ended"),
						TURN_MS,
						500,
					);
					const { timeline } = await actor.snapshot();
					const start = timeline.find(t => t.kind === "platform" && t.text.startsWith("Starting a hosted sandbox"));
					const first = timeline.find(t => t.kind === "windlass");
					const setup = timeline.find(t => t.kind === "setup" && t.state === "succeeded");
					const last = timeline.at(-1);
					assert(
						start && first && last?.kind === "turn.ended" && last.outcome === "succeeded",
						"Benchmark turn failed",
					);
					assert(setup?.kind === "setup" && setup.durationMs !== null, "Benchmark setup failed");
					const startMs = first.at - start.at,
						setupMs = setup.durationMs;
					console.log(
						JSON.stringify({ repository: repo.name, mode, run, startMs, setupMs, overheadMs: startMs - setupMs }),
					);
					assert(
						!github.requests.slice(before).some(r => r.path.includes("/git/trees/") || r.path.includes("/contents/")),
						"A short cold setup fetched dependency inputs",
					);
				} finally {
					await user.deleteSession(session.id);
				}
			}
		}
	} finally {
		await user.forgetRepository(repo.id);
	}
}

/** Run the real actors, clone, setup, private fetch and scripted Windlass turn on Docker. */
async function preparedSessions(server: Server) {
	const github = new GithubStandin({ callbackUrl: API + "/github/callback" });
	const relayName = "snapshot-check-github-" + randomBytes(6).toString("hex");
	const socketDir = mkdtempSync(join(tmpdir(), "snapshot-check-"));
	const relay = createServer(socket => {
		const upstream = createConnection(Number(new URL(localAddress).port), "127.0.0.1");
		socket.on("error", () => upstream.destroy());
		upstream.on("error", () => socket.destroy());
		socket.pipe(upstream).pipe(socket);
	});
	let localAddress = "";
	const client = newClient();
	try {
		await github.start();
		localAddress = github.url;
		// A bridge container can reach this fixture even on hosts that block container-to-host TCP.
		const socket = join(socketDir, "github.sock");
		await new Promise<void>(resolve => relay.listen(socket, resolve));
		chmodSync(socketDir, 0o755);
		chmodSync(socket, 0o777);
		const forward =
			"const net=require('node:net');net.createServer(s=>{const d=net.connect('/fixture/github.sock');s.on('error',()=>d.destroy());d.on('error',()=>s.destroy());s.pipe(d).pipe(s)}).listen(8080)";
		execFileSync("docker", [
			"run",
			"-d",
			"--pull",
			"never",
			"--name",
			relayName,
			"--cap-drop",
			"ALL",
			"--read-only",
			"-v",
			socketDir + ":/fixture:ro",
			sandboxImage!,
			"node",
			"-e",
			forward,
		]);
		const address = execFileSync(
			"docker",
			["inspect", "--format", "{{.NetworkSettings.Networks.bridge.IPAddress}}", relayName],
			{ encoding: "utf8" },
		).trim();
		github.url = "http://" + address + ":8080";
		github.addUser("ada");
		const installation = github.addInstallation("ada", "User");
		const repo = github.addRepository({
			owner: "ada",
			name: "snapshot-check",
			installation,
			files: { "package-lock.json": "{}", "base.txt": "first" },
		});
		const base = github.branchHead(repo, "main")!;
		await server.start({ ...github.env(), WLP_SNAPSHOTS: snapshotBenchmark ? "off" : "on" });
		const auth = await loginHttp(API).demo();
		const uid = auth.profile.uid,
			params = { token: auth.token };
		demoUids.push(uid);
		const user = client.user.getOrCreate([uid], { params });
		const { url } = await user.githubConnect({ origin: "http://localhost:5173" });
		const callback = await fetch(github.authorize("ada", url), { redirect: "manual" });
		const ticket = new URLSearchParams(new URL(callback.headers.get("location")!).hash.slice(1)).get("github");
		assert(ticket, "GitHub connection failed");
		await user.githubComplete(ticket);
		if (snapshotBenchmark) return await snapshotTimings(server, client, github, repo, uid, auth.token);
		const command =
			'test -f quick || sleep 31; mkdir -p node_modules; cp base.txt node_modules/built-at; if [ -n "${CHECK_TOKEN:-}" ]; then echo "$CHECK_TOKEN" > node_modules/secret; fi';
		await user.saveRepositorySetup({ repositoryId: repo.id, command });
		// Only a prepared environment's build saves an image (environments.ts): ask for one and wait for how it ends.
		async function build(): Promise<RepositoryEnvironment> {
			const asked = Date.now();
			await user.rebuildEnvironment({ repositoryId: repo.id, place: "hosted" });
			return await waitFor(
				"the environment build",
				async () => {
					const env = (await user.repositoryEnvironments(repo.id)).environments.find(e => e.place === "hosted");
					// A build that could not start says why in its note; it would only be tried again half an hour later.
					if (env && !env.attempt && env.note && env.note !== "Not built yet.")
						throw new Error("The build did not start: " + env.note);
					if (env?.attempt) return env.attempt.finishedAt !== null && env.attempt.startedAt >= asked ? env : undefined;
					return env?.ready && env.ready.startedAt >= asked ? env : undefined;
				},
				10 * 60_000,
				2000,
			);
		}
		async function turn(hit: boolean, secret = false, branch = "main") {
			const session = await user.createSession({ profile: "docker-hardened", repository: { id: repo.id, branch } });
			try {
				const actor = client.agentSession.get([uid, session.id], { params });
				await actor.prompt({ text: "Explore the workspace" });
				await waitFor(
					"the prepared sandbox turn",
					async () => (await actor.snapshot()).timeline.some(t => t.kind === "turn.ended"),
					TURN_MS,
					500,
				);
				const snapshot = await actor.snapshot();
				const last = snapshot.timeline.at(-1);
				assert(
					last?.kind === "turn.ended" && last.outcome === "succeeded",
					"Turn failed: " +
						plain(snapshot.timeline.filter(t => t.kind === "platform" || t.kind === "turn.ended")).slice(-2000),
				);
				const setup = snapshot.timeline.find(t => t.kind === "setup" && t.state === "succeeded");
				if (secret) {
					assert(
						snapshot.timeline.some(t => t.kind === "platform" && t.text.includes("CHECK_TOKEN")),
						"Expected setup to receive the fixture secret",
					);
					assert(
						!snapshot.timeline.some(t => t.kind === "platform" && t.text.includes("Saving a prepared sandbox")),
						"Secret-bearing setup attempted a commit",
					);
				}
				const notice = snapshot.timeline.some(
					t =>
						t.kind === "platform" &&
						t.text.includes("Started from a validated environment") &&
						t.text.includes(base.slice(0, 12)),
				);
				assert(
					!!setup === !hit && notice === hit,
					"Unexpected setup or snapshot notice: " +
						plain(snapshot.timeline.filter(t => t.kind === "platform" || t.kind === "setup")).slice(-1800),
				);
				if (hit) {
					const name = execFileSync(
						"docker",
						[
							"ps",
							"-q",
							"--filter",
							"label=dev.windlass-platform.uid=" + uid,
							"--filter",
							"label=dev.windlass-platform.session=" + session.id,
						],
						{ encoding: "utf8" },
					).trim();
					assert(name && !name.includes("\n"), "Expected a single live sandbox");
					execFileSync("docker", [
						"exec",
						name,
						"sh",
						"-c",
						'test "$(cat base.txt)" = next && test "$(cat node_modules/built-at)" = first && test ! -e node_modules/secret',
					]);
					if (branch === "feature") execFileSync("docker", ["exec", name, "test", "-f", "/workspace/feature.txt"]);
					execFileSync("docker", [
						"exec",
						name,
						"grep",
						"-rFql",
						"Setup came from a snapshot of the repository base at commit " + base,
						"/home/agent/.local/share/windlass/sessions",
					]);
				}
			} finally {
				await user.deleteSession(session.id);
			}
		}
		try {
			const secret = { repositoryId: repo.id, profile: "docker-hardened", name: "CHECK_TOKEN" };
			const putSecret = () =>
				user.saveRepositorySecret({ ...secret, value: randomBytes(16).toString("hex"), scope: "setup" });
			await putSecret();
			const beforeSeed = github.gitResponseBytes;
			await turn(false, true);
			const seeded = github.gitResponseBytes - beforeSeed;
			const images = execFileSync(
				"docker",
				["image", "ls", "-q", "--filter", "label=dev.windlass-platform.snapshot.uid=" + uid],
				{ encoding: "utf8" },
			).trim();
			assert(!images, "A secret-bearing setup left a snapshot image");
			await user.deleteRepositorySecret(secret);
			const beforeWarm = github.gitResponseBytes;
			await turn(false);
			const warm = github.gitResponseBytes - beforeWarm;
			assert(warm > 0 && warm < seeded, "A fresh session downloaded the full repository again");
			pass(
				"Two hosted sessions on the same private repository reuse Git objects",
				`${seeded} then ${warm} Git HTTP response bytes`,
			);
			const unbuilt = execFileSync(
				"docker",
				["image", "ls", "-q", "--filter", "label=dev.windlass-platform.snapshot.uid=" + uid],
				{ encoding: "utf8" },
			).trim();
			assert(!unbuilt, "An ordinary session saved a prepared image");
			// The build uses the repository's default sandbox; a check validates what setup made.
			await user.saveRepositoryDefaults({ repositoryId: repo.id, profile: "docker-hardened" });
			// Once main's base.txt says "broken", the check calls a tool the sandbox does not have (exit 127): the
			// sandbox's problem, which keeps a build from being promoted. A failure of the code alone would not.
			await user.saveRepositoryChecks({
				repositoryId: repo.id,
				checks: [
					{
						name: "built",
						command: "test -f node_modules/built-at && if grep -q broken base.txt; then wlp-no-such-tool; fi",
					},
				],
			});
			const ready = await build();
			assert(
				ready.state === "ready" &&
					ready.ready?.snapshot === true &&
					ready.ready.commit === base &&
					ready.ready.checks.every(c => c.status === "passed"),
				"The environment was not promoted: " + plain(ready),
			);
			pass("A build runs setup and the saved checks, and is promoted when they pass");
			github.commit(repo, "main", { "base.txt": "broken" }, "Break the check");
			const failed = await build();
			assert(
				failed.state === "failed" &&
					failed.attempt?.failure?.kind === "not_found" &&
					failed.attempt.failure.check === "built" &&
					failed.ready?.commit === base &&
					failed.ready.snapshot,
				"A failed build was not recorded as one, or replaced the ready one: " + plain(failed),
			);
			pass("A failed build is reported with its check and keeps the last ready image");
			github.commit(repo, "main", { "base.txt": "next", quick: "" }, "Source-only change");
			github.commit(repo, "feature", { "feature.txt": "from feature" }, "Feature source", "main");
			await turn(true, false, "feature");
			await turn(true);
			await putSecret();
			await turn(false, true);
			await user.deleteRepositorySecret(secret);
			pass("Secret-bearing setup runs cold and cannot publish a prepared image");
			github.commit(repo, "main", { "package-lock.json": "{ }" }, "Changed lockfile");
			await turn(false);
			pass(
				"A real session skips setup only for matching inputs, checks out current source, and gives the base commit to Windlass",
			);
			const stale = await waitFor(
				"the environment marked stale",
				async () => {
					const env = (await user.repositoryEnvironments(repo.id)).environments.find(e => e.place === "hosted");
					return env?.state === "stale" ? env : undefined;
				},
				20_000,
				500,
			).catch(async () => (await user.repositoryEnvironments(repo.id)).environments.find(e => e.place === "hosted"));
			assert(stale?.state === "stale", "A session that missed the ready image did not mark it stale: " + plain(stale));
			pass("A session whose ready image no longer matches marks the environment stale");
			await user.saveRepositorySetup({ repositoryId: repo.id, command: "true" });
			const remaining = execFileSync(
				"docker",
				["image", "ls", "-q", "--filter", "label=dev.windlass-platform.snapshot.uid=" + uid],
				{ encoding: "utf8" },
			).trim();
			assert(!remaining, "Editing the setup command retained the old snapshot image");
			pass("Editing setup evicts the previous image");
		} finally {
			await user.forgetRepository(repo.id);
		}
	} finally {
		await client.dispose();
		spawnSync("docker", ["rm", "-fv", relayName]);
		relay.close();
		await github.stop();
		rmSync(socketDir, { recursive: true, force: true });
	}
}

let server: Server | null = null;
let crashed = false;
try {
	console.log(`e2e: sandbox layer ${MODE}; ${OWN_SERVER ? "starting a server on fresh state" : `using ${ENDPOINT}`}`);
	if (OWN_SERVER) {
		if (!existsSync(join(SERVER_DIR, "src", "index.ts"))) throw new Error(`run this from ${SERVER_DIR}`);
		server = new Server();
		if (FAKE && (!section || section === "core") && !idleOnly && !githubOnly && !resumeOnly) {
			const github = new GithubStandin({ callbackUrl: loginOrigin + "/signin" });
			await github.start();
			await server.start({
				...github.env(),
				WLP_ITEMS: "1",
				WLP_CLIENT_IP_HEADER: "x-test-ip",
				WLP_LOGIN_ADDRESS_PER_MINUTE: "2",
				WLP_LOGIN_TOTAL_PER_MINUTE: "4",
			});
			const identityClient = newClient();
			try {
				await identityChecks(identityClient, server, github);
			} finally {
				await identityClient.dispose();
				await github.stop();
			}
			await server.stop();
		}
		if (snapshotOnly) {
			if (FAKE) throw new Error("--snapshots-only requires Docker");
			await preparedSessions(server);
		} else if (!identityOnly) await server.start();
	}
	if (!identityOnly && !snapshotOnly) await main(server);
} catch (error) {
	crashed = true;
	console.log(`FAIL  the run stopped early  -- ${describe(error)}`);
	if (error instanceof Error && error.stack) console.log(error.stack.split("\n").slice(1, 6).join("\n"));
} finally {
	if (server) {
		await server.stop().catch(() => undefined);
		const unhandled = server.output.split("\n").filter(line => line.includes("unhandled promise rejection"));
		if (unhandled.length > 0)
			fail("no unhandled promise rejections in the server", `${unhandled.length}: ${unhandled[0]}`);
		else pass("no unhandled promise rejections in the server");
		if (!FAKE) {
			// Only what this run's server made: other work may be using the same Docker.
			const made = [...server.output.matchAll(/\[wlp\] sandbox\.created id=(\S+)/g)].map(
				match => `wlp-session-${match[1]}`,
			);
			const left = sandboxContainers().filter(name => made.includes(name));
			if (left.length > 0) fail("no sandbox containers left behind", left.join(", "));
			else pass("no sandbox containers left behind", `${made.length} created and removed`);
			const stuck = removeDemoVolumes();
			if (stuck.length > 0) fail("the demo users' data volumes are removed", stuck.join("; "));
			else pass("the demo users' data volumes are removed", `${demoUids.length} demo users`);
			// Demo turns are scripted and get no access token.
			const handed = server.output.split("\n").filter(line => line.includes("[wlp] token.handed")).length;
			if (handed > 0) fail("no scripted turn was handed an access token", `${handed} were`);
			else pass("no scripted turn was handed an access token");
		}
	}
}
if (crashed) tally.failures += 1;
console.log(
	`\n${tally.failures === 0 ? "ALL PASSED" : "FAILED"}: ${tally.passes} passed, ${tally.failures} failed, ${tally.skips} skipped (sandbox layer: ${MODE})`,
);
server?.remove();
process.exit(tally.failures === 0 ? 0 : 1);
