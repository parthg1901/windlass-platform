/**
 * Sessions on a user's own machine, end to end: the real server (fake Windlass layer for hosted
 * sessions, WLP_MACHINES=1), the real pairing routes, the real `machine` actor and the real session
 * actor, against a runner stood in for in this process. The stand-in speaks the control socket with
 * `FakeRunner` (runner-fake.ts) and serves each session's socket on the real `RunnerChannel`, with
 * sandboxes in memory and a small `windlass acp` that replays a recorded turn. The turn code that
 * speaks to it is the server's own (turn.ts). Before the server starts, the session's link to its runner
 * (runner-layer.ts) is checked in this process, against a stand-in machine actor, on a clock it moves by
 * hand: the interleavings of hellos, answers, deadlines and closes that a real run meets only by chance.
 *
 *   cd server && npx tsx ../scripts/runner-e2e.ts
 *
 * The engine and HTTP server use ports reserved for this check. Nothing runs in
 * Docker. Prints one PASS/FAIL line per check and exits 1 if any failed.
 */
import { loginHttp } from "./login-http.js";
import { localListeners, portFree } from "./check-listeners.js";
import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepStrictEqual } from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { createClient, type Registry } from "../server/src/client.js";
import type { AcpUpdate, LiveDelta, SessionSnapshot, SessionSummary, TimelineItem } from "../server/src/contract.js";
import { type ChannelSocket, RunnerChannel } from "../server/src/runner/channel.js";
import { MIN_RUNNER_VERSION, sessionProof } from "../server/src/runner/control.js";
import { optionsDigest } from "../server/src/runner/catalog.js";
import { certify } from "../server/src/runner/frame-auth.js";
import { DEAD_MS, type Operation } from "../server/src/runner/protocol.js";
import { StandInRunner, assert, enginePrompts, until, opened } from "./runner-standin.js";
import { GithubStandin } from "./github-standin.js";
import { FakeRunner } from "./runner-fake.js";
import { sleep } from "./check-wait.js";

const {
	engine: PORT,
	http: [HTTP],
} =
	process.argv[2] === "node"
		? { engine: Number(process.env.RIVET_RUN_ENGINE_PORT), http: [Number(process.env.WLP_HTTP_PORT)] }
		: await localListeners();
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${HTTP}`;
const SERVER_DIR = fileURLToPath(new URL("../server/", import.meta.url));
/** The person's ceiling on agents working at once (WLP_FACTORY_HOSTED_RUNNING): one, so that a second hosted turn is refused. */
const CEILING = 1;
/** The design's numbers (Plans/2026-11-19, section 1.4): how long a session waits for its runner's socket. */
const OFFLINE_WAIT_MS = 15_000;

let failed = 0;
/** `promise`, or an error naming `what` once `ms` have passed: for calls that a restart can leave unanswered. */
async function within<T>(what: string, promise: Promise<T>, ms: number): Promise<T> {
	let timer: Parameters<typeof clearTimeout>[0];
	const limit = new Promise<never>((_, fail) => {
		timer = setTimeout(() => fail(new Error(`timed out after ${ms / 1000} s waiting for ${what}`)), ms);
	});
	return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** A case that has not finished in this time fails by name, rather than holding the run until CI stops it. */
const CHECK_MS = 5 * 60_000;

/** RUNNER_E2E_ONLY=<regular expression>: only the checks whose names match it run (for a local look at a few; CI runs all). */
const ONLY = process.env.RUNNER_E2E_ONLY ? new RegExp(process.env.RUNNER_E2E_ONLY) : null;

async function check(name: string, body: () => Promise<string>): Promise<void> {
	if (ONLY && !ONLY.test(name)) return;
	let timer: Parameters<typeof clearTimeout>[0];
	const limit = new Promise<never>((_, fail) => {
		timer = setTimeout(() => fail(new Error(`did not finish in ${CHECK_MS / 1000} s`)), CHECK_MS);
	});
	try {
		console.log(`PASS  ${name}  (${await Promise.race([body(), limit]).finally(() => clearTimeout(timer))})`);
	} catch (error) {
		failed += 1;
		console.log(`FAIL  ${name}  -- ${error instanceof Error ? error.message : String(error)}`);
	}
}
// ---------------------------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------------------------

class Server {
	readonly storage = mkdtempSync(join(tmpdir(), "wlp-runner-e2e-"));
	private child: ChildProcess | null = null;
	readonly secret = randomBytes(24).toString("hex");

	async start(extra: Record<string, string> = {}): Promise<void> {
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(WLP_|RIVET|E2B_)/.test(key)));
		const log = openSync(join(this.storage, "server.log"), "a");
		// The server is this file in its "node" role (`serverNode` below): the real server, with one hook.
		let child: ChildProcess;
		try {
			child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "node"], {
				cwd: SERVER_DIR,
				stdio: ["ignore", log, log],
				env: {
					...env,
					...extra,
					WLP_SECRET: this.secret,
					WLP_DEMO: "1",
					WLP_SANDBOX: "fake",
					WLP_MACHINES: "1",
					WLP_FACTORY_HOSTED_RUNNING: String(CEILING),
					WLP_PUBLIC_URL: ORIGIN,
					WLP_HTTP_PORT: String(HTTP),
					RIVET_RUN_ENGINE_PORT: String(PORT),
					RIVETKIT_STORAGE_PATH: this.storage,
					RIVET_LOG_LEVEL: "warn",
				},
			});
		} finally {
			closeSync(log);
		}
		this.child = child;
		child.on("exit", () => {
			if (this.child === child) this.child = null;
		});
		await until(
			"the server to answer",
			async () => {
				if (!this.child) throw new Error(`the server exited (code ${child.exitCode}, signal ${child.signalCode})`);
				return (await fetch(`${ORIGIN}/health`).catch(() => null))?.ok === true;
			},
			120_000,
		).catch(error => {
			throw new Error(
				`${error.message}\nLast lines of ${this.storage}/server.log:\n${this.log().trimEnd().split("\n").slice(-80).join("\n")}`,
				{ cause: error },
			);
		});
	}

	/** As a node being replaced: SIGTERM, so every actor goes to sleep. */
	async stop(): Promise<void> {
		const child = this.child;
		if (!child) return;
		child.kill("SIGTERM");
		await until("the server to exit", () => this.child === null, 40_000).catch(() => child.kill("SIGKILL"));
		await until("the engine's ports to be free", async () => (await portFree(PORT)) && (await portFree(HTTP)), 20_000);
	}

	/** As a crash: SIGKILL, no `onSleep`; the engine it started is stopped by its PID. */
	async kill(): Promise<void> {
		const child = this.child;
		if (!child) return;
		child.kill("SIGKILL");
		await until("the server to exit", () => this.child === null, 20_000);
		try {
			const runtime = JSON.parse(
				readFileSync(join(this.storage, ".rivetkit", "var", "engine", "runtime.json"), "utf8"),
			) as { pid?: number };
			if (typeof runtime.pid === "number") process.kill(runtime.pid, "SIGKILL");
		} catch {
			// No engine left, which is the point.
		}
		await until("the engine's ports to be free", async () => (await portFree(PORT)) && (await portFree(HTTP)), 20_000);
	}

	log(): string {
		return readFileSync(join(this.storage, "server.log"), "utf8");
	}

	/** While this file exists, the machine's actor fails to record a sandbox's removal (`serverNode`). */
	get refusal(): string {
		return join(this.storage, "refuse-removal");
	}
}

/**
 * The server's process: the real server, whose machine actor fails `internalRemoveSandbox` while
 * `Server.refusal` exists, as one whose storage is away; and whose session has one action more,
 * `e2eMeta`, which reads its stored meta for a check (no page shows the machine's name kept at launch), and
 * `e2eCheckpoint`, the turn whose checkpoint is stored (runner/journal.ts), or null, and `e2ePaying`, which makes a
 * session no demo's so that its turns pay. With WLP_TEST_MACHINE_PLAN the user's ChatGPT plan is a fixed stand-in:
 * its generation and an access token that lasts an hour, opened as the credential actions open a real one.
 */
async function serverNode(): Promise<void> {
	if (process.env.WLP_TEST_MODEL_SCRIPT) {
		const { SandboxWindlass } = await import("../server/src/sandbox/turn.js");
		const script = JSON.parse(readFileSync(process.env.WLP_TEST_MODEL_SCRIPT, "utf8"));
		SandboxWindlass.prototype.demoScript = () => script;
	}
	const offlineChecks = new Set<string>();
	if (process.env.WLP_TEST_PAUSED_ITEM) {
		const { RULES } = await import("../server/src/factory/blueprint.js");
		Object.assign(RULES, { turnCheckMs: 2_000 });
	}
	const { agentSession } = await import("../server/src/actors/agent-session.js");
	Object.assign(agentSession.config.actions!, {
		// Advance only the age of this fixture's paused turn so the item's real due check can repair it.
		e2eAgePause: async (c: {
			key: string[];
			vars: { resuming: Promise<void> | null; meta: { run: { paused: { at: number } } } };
		}) => {
			await until("this server's wake to register the offline session", () => offlineChecks.has(c.key[1]!));
			await c.vars.resuming;
			c.vars.meta.run.paused.at -= 16 * 60_000;
		},
		e2eMeta: (c: { vars: { meta: unknown } }) => c.vars.meta,
		e2ePaying: async (c: never, paying: boolean) => {
			const { writeMeta } = await import("../server/src/actors/agent-session/timeline.js");
			const meta = (c as { vars: { meta: { demo?: boolean } } }).vars.meta;
			meta.demo = !paying;
			await writeMeta(c, meta as never);
		},
		e2eCheckpoint: async (c: { db: { execute<T>(sql: string): Promise<T[]> } }) =>
			(await c.db.execute<{ turn: number }>("SELECT turn FROM turn_checkpoint"))[0]?.turn ?? null,
	});
	const { machine } = await import("../server/src/actors/machine.js");
	const actions = machine.config.actions!;
	if (process.env.WLP_TEST_LOST_RESUME_WAKE) {
		const register = actions.internalPausedSession;
		actions.internalPausedSession = async (c, id, on) => {
			const online = await register(c, id, on);
			if (on && !online) offlineChecks.add(id);
			return online;
		};
		// Model both independent session wakes being lost on this replacement server.
		agentSession.config.actions!.internalMachineBack = async () => {};
		agentSession.config.actions!.internalResumeTurn = async () => {};
	}
	Object.assign(actions, { e2eDestroy: (c: { destroy(): void }) => c.destroy() });
	const remove = actions.internalRemoveSandbox;
	const refusal = join(process.env.RIVETKIT_STORAGE_PATH!, "refuse-removal");
	actions.internalRemoveSandbox = async (c, input) => {
		if (existsSync(refusal)) throw new Error("the machine's storage is away (runner-e2e)");
		return remove(c, input);
	};
	const { user } = await import("../server/src/actors/user.js");
	const userActions = user.config.actions!;
	const changed = userActions.internalMachineChanged;
	const marker = join(process.env.RIVETKIT_STORAGE_PATH!, "fail-online-publish");
	userActions.internalMachineChanged = async (c, id, facts) => {
		if (facts?.status === "online" && existsSync(marker)) {
			writeFileSync(marker + ".seen", "");
			throw new Error("fixture user actor unavailable");
		}
		return changed(c, id, facts);
	};
	if (process.env.WLP_TEST_MACHINE_PLAN) {
		const { sealCredentialTransit } = await import("../server/src/credentials/transit.js");
		const openai = (ref: unknown) => {
			const r = ref as { provider?: string; plan?: boolean };
			return r?.provider === "openai" && r.plan === true;
		};
		const generation = userActions.internalCredentialGeneration;
		userActions.internalCredentialGeneration = async (c, ref, onMachine) =>
			openai(ref) && onMachine ? "e2e-plan" : generation(c, ref, onMachine);
		const credential = userActions.internalCredential;
		userActions.internalCredential = async (c, ref, nonce, onMachine) =>
			openai(ref) && onMachine
				? sealCredentialTransit(c.key[0]!, { provider: "openai", plan: true }, nonce, {
						secret: `e2e-access-${randomBytes(16).toString("hex")}`,
						generation: "e2e-plan",
						expiresAt: Date.now() + 3_600_000,
					})
				: credential(c, ref, nonce, onMachine);
	}
	const readSecrets = userActions.internalSessionSecrets;
	userActions.internalSessionSecrets = async (c, id) => {
		const sealed = await readSecrets(c, id);
		if (existsSync(join(process.env.RIVETKIT_STORAGE_PATH!, "unreadable-secret"))) {
			sealed.account!.secrets.push({ name: "TEST", scope: "setup", sealed: "unreadable" });
		}
		return sealed;
	};
	await import("../server/src/index.js");
}

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

type Client = ReturnType<typeof createClient<Registry>>;

class Watch {
	readonly items: TimelineItem[] = [];
	readonly deltas: LiveDelta[] = [];
	/** Each `machine` event: what the banner says of the machine, when it changes. */
	readonly machines: Array<{ state: string; since: number; at: number }> = [];
	readonly conn;
	constructor(client: Client, uid: string, id: string, token: string) {
		this.conn = client.agentSession.get([uid, id], { params: { token } }).connect();
		this.conn.on("item", (item: unknown) => this.items.push(item as TimelineItem));
		this.conn.on("delta", (delta: unknown) => this.deltas.push(delta as LiveDelta));
		this.conn.on("machine", (reach: unknown) =>
			this.machines.push({ ...(reach as { state: string; since: number }), at: Date.now() }),
		);
	}
	ended(turn: number) {
		return this.items.find(
			(item): item is Extract<TimelineItem, { kind: "turn.ended" }> => item.kind === "turn.ended" && item.turn === turn,
		);
	}
	untilEnded(turn: number, ms = 60_000) {
		return until(`turn ${turn} to end`, () => this.ended(turn), ms);
	}
	windlass(turn: number): number {
		return this.items.filter(item => item.kind === "windlass" && item.turn === turn).length;
	}
	warnings(turn: number): string[] {
		return this.items
			.filter(item => item.kind === "platform" && item.turn === turn && (item as { level?: string }).level === "warn")
			.map(item => (item as { text?: string }).text ?? "");
	}
}

/** A hello made by hand: whether the session answers it with a welcome before closing the socket. */
async function welcomed(
	client: Client,
	uid: string,
	sessionId: string,
	hello: Record<string, unknown>,
): Promise<boolean> {
	const ws = (await client.agentSession.get([uid, sessionId]).webSocket("runner")) as WebSocket;
	await opened(ws);
	return await new Promise<boolean>(done => {
		const timer = setTimeout(() => {
			ws.close();
			done(false);
		}, 5_000);
		ws.addEventListener("message", ({ data }) => {
			clearTimeout(timer);
			ws.close();
			done(String(data).includes('"kind":"welcome"') && !String(data).includes("refused"));
		});
		ws.addEventListener("close", () => {
			clearTimeout(timer);
			done(false);
		});
		ws.send(JSON.stringify({ kind: "hello", protocol: 1, runnerVersion: MIN_RUNNER_VERSION, resume: null, ...hello }));
	});
}

// ---------------------------------------------------------------------------------------------
// The session's link, in this process: a stand-in machine actor, the real channels, a clock moved by hand
// ---------------------------------------------------------------------------------------------

type LinkModule = typeof import("../server/src/sandbox/runner-layer.js");
type Facts = import("../server/src/actors/machine.js").MachineFacts;
type Attachment = import("../server/src/actors/machine.js").Attachment;

const LINK_WHO = { uid: "u_link", sessionId: "s_link", machineId: "m_0123456789abcdef" };
const LINK_SANDBOX = `${LINK_WHO.machineId}-000000000001`;
const turnOver = () => new Promise<void>(done => setImmediate(done));
/** Moves the hand-held clock, letting what each step makes due run before the next. */
async function advance(ms: number): Promise<void> {
	for (let left = ms; left > 0; left -= 50) {
		mock.timers.tick(Math.min(left, 50));
		await turnOver();
	}
}
/** Follows `p` from the moment it is made: `at` is its value, its error, or "pending". */
function track<T>(p: Promise<T>): { at: T | Error | "pending" } {
	const followed: { at: T | Error | "pending" } = { at: "pending" };
	p.then(
		value => {
			followed.at = value;
		},
		(error: Error) => {
			followed.at = error;
		},
	);
	return followed;
}

/** A socket between the link (RivetKit's raw socket, as `onWebSocket` hands it) and the runner's channel; what is sent arrives a moment later. */
function socketPair() {
	const server = { message: [] as Array<(event: { data: unknown }) => void>, close: [] as Array<() => void> };
	const runner = { message: [] as Array<(data: unknown) => void>, close: [] as Array<() => void> };
	let open = true;
	let silent = false;
	const close = () => {
		if (!open) return;
		open = false;
		if (silent) return;
		queueMicrotask(() => {
			for (const listener of [...server.close, ...runner.close]) listener();
		});
	};
	return {
		silence: () => {
			silent = true;
		},
		server: {
			send: (text: string) => {
				if (!open) throw new Error("closed");
				queueMicrotask(() => open && !silent && runner.message.forEach(listener => listener(text)));
			},
			close,
			addEventListener: (type: "message" | "close", listener: never) =>
				(type === "message" ? server.message : server.close).push(listener),
		},
		runner: {
			send: (text: string) => {
				if (!open) throw new Error("closed");
				queueMicrotask(() => open && !silent && server.message.forEach(listener => listener({ data: text })));
			},
			close,
			onMessage: (listener: (data: unknown) => void) => runner.message.push(listener),
			onClose: (listener: () => void) => runner.close.push(listener),
		} satisfies ChannelSocket,
	};
}

/**
 * The machine's actor as a session sees it, and the machine's runner behind it. `hello` is when the
 * runner answers an `attach`: "now" (before the actor's reply reaches the session), after a number of
 * ms, or "never"; `reply` is what the actor's answer waits for first.
 */
function bench(
	layer: LinkModule,
	options: {
		report?: Facts["report"];
		facts?: () => Promise<void>;
		serve?: (op: Operation, channel: RunnerChannel) => void;
	} = {},
) {
	const key = generateKeyPairSync("ed25519");
	const report: Facts["report"] = options.report ?? {
		kind: "report",
		docker: { ok: true },
		commandSandbox: { ok: true },
		freeDiskBytes: 10e9,
		sandboxes: [],
	};
	const facts: Facts = {
		status: "online",
		name: "Bench",
		publicKey: key.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
		report,
	};
	const log = {
		calls: [] as string[],
		attaches: [] as number[],
		tickets: [] as string[],
		ops: [] as string[],
		reaches: [] as string[],
		inFlight: 0,
		mostInFlight: 0,
	};
	const mode: { hello: "now" | "never" | number; reply: () => Promise<void>; answer: Attachment } = {
		hello: "now",
		reply: async () => undefined,
		answer: { ok: true },
	};
	const serve =
		options.serve ??
		((op: Operation, channel: RunnerChannel) => {
			if (op.name === "connect") channel.respond(op, { cwd: "/workspace", profile: "docker-hardened" });
			else if (op.name === "state") channel.respond(op, "running");
			else if (op.name === "run")
				channel.respond(op, { exitCode: 0, timedOut: false, aborted: false, stdout: "", stderr: "" });
			else if (op.name === "suspend") channel.respond(op, null);
		});
	const runner: RunnerChannel = new RunnerChannel({
		onOperation: op => {
			log.ops.push(op.name);
			serve(op, runner);
		},
		onInput: () => undefined,
		onCloseIn: () => undefined,
		onCancel: () => undefined,
		onDrain: () => undefined,
		onReset: () => undefined,
		onRefused: () => undefined,
	});
	let current: ReturnType<typeof socketPair> | null = null;
	const hello = (ticket: string) => {
		current = socketPair();
		link.socket(current.server);
		runner.attach(current.runner, {
			runnerVersion: MIN_RUNNER_VERSION,
			machineId: LINK_WHO.machineId,
			ticket,
			signature: sign(
				null,
				Buffer.from(sessionProof(LINK_WHO.uid, LINK_WHO.sessionId, LINK_WHO.machineId, ticket)),
				key.privateKey,
			).toString("base64url"),
		});
	};
	const link = new layer.RunnerLink(
		LINK_WHO,
		{
			facts: async () => {
				log.calls.push("facts");
				await options.facts?.();
				return facts;
			},
			attach: async (_sessionId, ticket) => {
				log.calls.push("attach");
				log.attaches.push(Date.now());
				log.tickets.push(ticket);
				log.mostInFlight = Math.max(log.mostInFlight, ++log.inFlight);
				try {
					if (mode.answer.ok) {
						if (mode.hello === "now") hello(ticket);
						else if (typeof mode.hello === "number") setTimeout(() => hello(ticket), mode.hello);
					}
					await mode.reply();
					return mode.answer;
				} finally {
					log.inFlight -= 1;
				}
			},
			removeSandbox: async () => undefined,
		},
		() => undefined,
		reach => log.reaches.push(reach.state),
	);
	const hosted = { windlass: { problem: () => null }, tokens: {}, logins: {}, backups: null } as never;
	return {
		link,
		sandboxes: layer.machineLayer(link, hosted).sandboxes,
		log,
		mode,
		hello,
		/** The session's socket drops, as when the runner's network goes. */
		drop: () => current?.server.close(),
		silence: () => current?.silence(),
		close: () => {
			link.close();
			runner.close();
		},
	};
}
const never = () => new Promise<void>(() => undefined);
const after = (ms: number) => () => new Promise<void>(done => setTimeout(done, ms));

async function linkChecks(): Promise<void> {
	const layer: LinkModule = await import("../server/src/sandbox/runner-layer.js");
	const { ATTACH_WAIT_MS, IDLE_DETACH_MS, MachineUnreachable } = layer;
	const benches: Array<ReturnType<typeof bench>> = [];
	const fresh = (options?: Parameters<typeof bench>[1]) => {
		const made = bench(layer, options);
		benches.push(made);
		return made;
	};
	mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.UTC(2026, 10, 19) });
	try {
		await check(
			"link: create sends Claude only to a runner offering it and keeps a protocol 1 snapshot request cold",
			async () => {
				const input = { uid: LINK_WHO.uid, sessionId: LINK_WHO.sessionId, profile: "docker-hardened" as const };
				const received: unknown[] = [];
				const serve = (op: Operation, ch: RunnerChannel) => {
					if (op.name === "create") {
						received.push(op.args);
						ch.respond(op, LINK_SANDBOX);
					}
				};
				const old = fresh({ serve });
				const refused = track(old.sandboxes.create({ ...input, harness: "claude" }));
				await advance(50);
				assert(
					refused.at instanceof Error && refused.at.message.includes("--harness claude") && !old.log.attaches.length,
					"missing preflight refusal",
				);
				const offered = fresh({
					serve,
					report: {
						kind: "report",
						docker: { ok: true },
						commandSandbox: { ok: true },
						freeDiskBytes: null,
						sandboxes: [],
						gitMirrors: true,
						harnesses: [{ id: "claude", image: "fixture", adapter: "fixture", signIn: "none" }],
					},
				});
				for (const create of [
					offered.sandboxes.create({ ...input, harness: "claude", mirrorRepo: "1" }),
					old.sandboxes.create({
						...input,
						mirrorRepo: "1",
						fromSnapshot: {
							writer: true,
							attempt: "a".repeat(32),
							repo: "1",
							generation: "b".repeat(64),
							inputs: "c".repeat(64),
						},
					}),
				]) {
					await advance(50);
					await create;
				}
				assert(
					received.length === 2 &&
						received.some(
							args =>
								JSON.stringify(args) === JSON.stringify({ profile: input.profile, mirrorRepo: "1", harness: "claude" }),
						) &&
						received.some(args => JSON.stringify(args) === JSON.stringify({ profile: input.profile })),
					"wrong create arguments",
				);
				return "checked both wire requests and the refusal before attach";
			},
		);

		await check(
			"link: a runner whose hello comes before the machine actor's answer is let in, with the key had first",
			async () => {
				const b = fresh();
				b.mode.reply = after(200);
				const connected = track(b.sandboxes.connect(LINK_SANDBOX));
				await advance(300);
				const handle = connected.at;
				assert(
					handle !== "pending" && !(handle instanceof Error) && handle !== undefined,
					`connect came to ${handle instanceof Error ? handle.message : String(handle)}`,
				);
				assert(b.log.calls.join() === "facts,attach", `calls: ${b.log.calls.join()}`);
				return "hello at once, answer at 200 ms: connected at once, facts asked once and before the ticket";
			},
		);

		await check(
			"link: Stop while a command waits for the socket ends it at once, and the runner never has it",
			async () => {
				const b = fresh();
				const handle = await (async () => {
					const connecting = b.sandboxes.connect(LINK_SANDBOX);
					await advance(50);
					return await connecting;
				})();
				assert(handle, "no handle");
				await advance(IDLE_DETACH_MS + 100);
				assert(!b.link.channel.connected, "the idle socket was kept");
				b.mode.hello = 1_000;
				const stop = new AbortController();
				const run = track(handle.run("pwd", { signal: stop.signal }));
				await turnOver();
				stop.abort();
				await turnOver();
				const at = run.at;
				await advance(1_100);
				assert(
					at !== "pending" && !(at instanceof Error) && at.aborted,
					`run came to ${at instanceof Error ? at.message : JSON.stringify(at)} when stopped`,
				);
				assert(
					b.link.channel.connected && !b.log.ops.includes("run"),
					`connected ${b.link.channel.connected}, runner had: ${b.log.ops.join()}`,
				);
				// With the socket there: stopped in the same moment it was asked, before the link has handed it over.
				const now = new AbortController();
				const quick = track(handle.run("pwd", { signal: now.signal }));
				now.abort();
				await advance(100);
				assert(
					quick.at !== "pending" && !(quick.at instanceof Error) && quick.at.aborted && !b.log.ops.includes("run"),
					`stopped as it was asked: ${JSON.stringify(quick.at)}, runner had: ${b.log.ops.join()}`,
				);
				return "aborted at once; the socket came a second later and carried no run, nor did one stopped as it was asked";
			},
		);

		await check(
			"link: suspend on a machine that cannot be reached fails, so the session keeps the state it had",
			async () => {
				const b = fresh();
				b.mode.answer = { ok: false, reason: "offline" };
				const suspended = track(b.sandboxes.suspend(LINK_SANDBOX));
				await advance(50);
				const at = suspended.at;
				assert(
					at instanceof MachineUnreachable && at.reason === "offline",
					`suspend came to ${at instanceof Error ? at.message : String(at)}`,
				);
				return at.message;
			},
		);

		await check(
			`link: the offline wait is ${ATTACH_WAIT_MS / 1000} s from the first ask, for every caller that joins it, even with the machine's actor stalled`,
			async () => {
				const b = fresh();
				b.mode.hello = "never";
				b.mode.reply = never;
				const first = track(b.sandboxes.connect(LINK_SANDBOX));
				await advance(5_000);
				const second = track(b.sandboxes.connect(LINK_SANDBOX));
				await advance(ATTACH_WAIT_MS - 5_000 - 100);
				const early = [first.at, second.at];
				await advance(200);
				const late = [first.at, second.at];
				assert(
					early.every(at => at === "pending"),
					`gave up early: ${early.map(at => (at instanceof Error ? at.message : String(at))).join(" | ")}`,
				);
				assert(
					late.every(
						at => at instanceof MachineUnreachable && at.message.startsWith('Your machine "Bench" is offline'),
					),
					`at ${ATTACH_WAIT_MS / 1000} s: ${late.map(at => (at instanceof Error ? at.message : String(at))).join(" | ")}`,
				);
				const c = fresh({ facts: never });
				const stalled = track(c.sandboxes.connect(LINK_SANDBOX));
				await advance(ATTACH_WAIT_MS + 100);
				const unnamed = stalled.at;
				assert(
					unnamed instanceof MachineUnreachable && unnamed.message.startsWith("Your machine is offline"),
					`with the facts stalled: ${unnamed instanceof Error ? unnamed.message : String(unnamed)}`,
				);
				return `both callers at ${ATTACH_WAIT_MS / 1000} s, named; with no name had: "${unnamed.message.split(".")[0]}"`;
			},
		);

		await check(
			"link: while work waits on a lost socket a ticket goes every 5 s, one call to the machine's actor at a time",
			async () => {
				const b = fresh({
					serve: (op, channel) =>
						op.name === "connect" && channel.respond(op, { cwd: "/workspace", profile: "docker-hardened" }),
				});
				const handle = await (async () => {
					const connecting = b.sandboxes.connect(LINK_SANDBOX);
					await advance(50);
					return await connecting;
				})();
				assert(handle, "no handle");
				const waiting = b.link.request("state", { id: LINK_SANDBOX }).catch(() => undefined);
				await advance(50);
				b.mode.hello = "never";
				const from = b.log.attaches.length;
				b.drop();
				await advance(16_000);
				const times = b.log.attaches.slice(from);
				const gaps = times.slice(1).map((t, i) => t - times[i]!);
				assert(
					times.length >= 4 && gaps.every(gap => gap === 5_000),
					`asked at +${times.map(t => t - times[0]!).join(", +")} ms`,
				);
				const c = fresh();
				c.mode.hello = "never";
				c.mode.reply = after(7_000);
				const slow = c.sandboxes.connect(LINK_SANDBOX).catch(() => undefined);
				await advance(ATTACH_WAIT_MS + 100);
				assert(c.log.mostInFlight === 1, `${c.log.mostInFlight} calls to the machine's actor at once`);
				b.close();
				await waiting;
				await slow;
				return `${times.length} tickets 5 s apart; at most one actor call at a time with 7 s answers`;
			},
		);

		await check(
			"link: a silent socket with no close event gets a new ticket and the pending operation resumes",
			async () => {
				const b = fresh();
				const ready = b.link.ready();
				await advance(50);
				await ready;
				b.silence();
				b.mode.hello = "never";
				const before = b.log.attaches.length;
				const state = track(b.link.request("state", { id: LINK_SANDBOX }));
				await advance(DEAD_MS + 5_000);
				const retries = b.log.attaches.slice(before);
				assert(
					b.link.reach()?.state === "not_answering" && b.log.reaches.at(-1) === "not_answering",
					`banner: ${b.log.reaches.join(", ")}`,
				);
				assert(retries.length === 2 && retries[1]! - retries[0]! === 5_000, `retry times: ${retries.join(", ")}`);
				b.hello(b.log.tickets.at(-1)!);
				await advance(100);
				assert(
					state.at === "running" && b.log.ops.join() === "state" && b.link.reach()?.state === "answering",
					`state: ${String(state.at)}, operations: ${b.log.ops.join()}`,
				);
				return "two tickets five seconds apart; one completed operation on the resumed socket";
			},
		);

		await check(
			"link: once closed it settles its waiters and asks nothing more; a socket that comes after the work gave up is let go",
			async () => {
				const b = fresh();
				b.mode.hello = "never";
				const waiting = track(b.sandboxes.connect(LINK_SANDBOX));
				await advance(100);
				const calls = b.log.calls.length;
				b.link.close();
				b.link.close();
				await turnOver();
				const at = waiting.at;
				await advance(30_000);
				assert(
					at instanceof Error && !(at instanceof MachineUnreachable),
					`at close: ${at instanceof Error ? at.message : String(at)}`,
				);
				assert(b.log.calls.length === calls, `${b.log.calls.length - calls} calls to the machine's actor after close`);
				const c = fresh();
				c.mode.hello = "never";
				const gaveUp = c.sandboxes.connect(LINK_SANDBOX).catch((error: Error) => error);
				await advance(ATTACH_WAIT_MS + 100);
				assert((await gaveUp) instanceof MachineUnreachable, "the connect did not give up");
				await advance(36_000 - ATTACH_WAIT_MS - 100);
				c.hello(c.log.tickets.at(-1)!);
				await advance(100);
				const late = c.link.channel.connected;
				await advance(IDLE_DETACH_MS + 100);
				assert(
					late && !c.link.channel.connected && c.log.ops.length === 0,
					`late socket taken ${late}, still held ${c.link.channel.connected}`,
				);
				return `closed: "${at.message}", no call after; a late socket went after ${IDLE_DETACH_MS / 1000} s idle`;
			},
		);

		await check("link: a machine session's profile is the machine's own, with its real availability", async () => {
			const b = fresh({
				report: {
					kind: "report",
					docker: { ok: true },
					commandSandbox: { ok: false, reason: "Bubblewrap could not start" },
					freeDiskBytes: 10e9,
					sandboxes: [],
				},
			});
			await advance(50);
			assert(b.log.calls.join() === "facts", `calls: ${b.log.calls.join()}`);
			const profile = b.sandboxes.profile("docker-windlass-sandbox");
			assert(
				profile.name === "Strict" && profile.details?.includes('your machine "Bench"'),
				`profile: ${profile.name}, ${profile.details}`,
			);
			assert(
				!profile.available && profile.unavailableReason === "Bubblewrap could not start",
				`availability: ${profile.available}, ${profile.unavailableReason}`,
			);
			return `${profile.name}: ${profile.unavailableReason}`;
		});

		await check("link: losing an idle socket pushes the offline banner without inviting the runner back", async () => {
			const b = fresh();
			await b.link.ready();
			b.drop();
			await advance(IDLE_DETACH_MS + 100);
			assert(b.log.reaches.join() === "answering,offline", `pushed: ${b.log.reaches.join()}`);
			assert(
				b.link.reach()?.state === "offline" && b.log.attaches.length === 1,
				"idle socket loss must wait for new work",
			);
			await b.link.ready();
			assert(b.link.reach()?.state === "answering", "the next operation did not restore the banner");
			return b.log.reaches.join(", ");
		});

		await check("link: what the banner reads is pushed each time it changes", async () => {
			const b = fresh({
				serve: (op, channel) =>
					op.name === "connect" && channel.respond(op, { cwd: "/workspace", profile: "docker-hardened" }),
			});
			const connecting = b.sandboxes.connect(LINK_SANDBOX);
			await advance(50);
			await connecting;
			const waiting = b.link.request("state", { id: LINK_SANDBOX }).catch(() => undefined);
			await advance(50);
			b.mode.hello = "never";
			b.drop();
			await advance(100);
			b.mode.answer = { ok: false, reason: "removed" };
			await advance(5_000);
			await waiting;
			const c = fresh();
			c.mode.answer = { ok: false, reason: "offline" };
			await c.sandboxes.connect(LINK_SANDBOX).catch(() => undefined);
			const seen = [...b.log.reaches, ...c.log.reaches].join(", ");
			assert(seen === "answering, not_answering, removed, offline", `pushed: ${seen}`);
			return seen;
		});
	} finally {
		for (const b of benches) b.close();
		mock.timers.reset();
	}
}

/** A Claude Code session on a machine, through the same sockets and actors as the Windlass cases. */
async function claudeChecks(
	client: Client,
	uid: string,
	token: string,
	windlassPlace: { kind: "machine"; machineId: string },
	stateDir: string,
	github: GithubStandin,
	server?: Server,
) {
	const runner = new StandInRunner(ORIGIN, ENDPOINT, { claude: true, stateDir });
	const user = client.user.get([uid], { params: { token } });
	const profile = "docker-hardened" as const;
	await runner.pair(user);
	try {
		await runner.connectControl();
		const place = { kind: "machine" as const, machineId: runner.id.machineId };
		const launch = { place, profile, harness: "claude" } as const;
		await until("the second machine's report", async () =>
			(await user.machines()).find(m => m.machineId === place.machineId && m.commandSandbox),
		);
		const session = await user.createSession(launch);
		let watch = new Watch(client, uid, session.id, token);
		const snapshot = () => watch.conn.snapshot();
		const play = async (text: string, model?: string, effort?: string) => {
			const { turn } = await watch.conn.prompt({ text, model, effort });
			const end = await watch.untilEnded(turn);
			const updates = watch.items.flatMap(i => (i.turn === turn && i.kind === "acp" ? [i.update] : []));
			return { end, updates, turn };
		};
		const refusal = (call: Promise<unknown>) =>
			call.then(
				() => "accepted",
				e => e.code,
			);
		const acpSession = async () => {
			const id = (await snapshot()).windlassSessionId;
			assert(id && /^[a-f0-9-]{36}$/.test(id), "the session has no ACP id");
			return { id, file: join(stateDir, `wlp-fake-acp-${id}.json`) };
		};
		const waitDuring = async <T>(
			turn: number,
			what: string,
			ready: () => T | undefined | null | false | Promise<T | undefined | null | false>,
		) =>
			until(what, async () => {
				assert(!watch.ended(turn), `turn ended before ${what}`);
				return await ready();
			});
		try {
			await check("Claude launch accepts only an offering machine and the hardened profile", async () => {
				const refused = await Promise.all([
					refusal(user.createSession({ ...launch, place: { kind: "hosted" } })),
					refusal(user.createSession({ ...launch, profile: "docker-windlass-sandbox" })),
					refusal(user.createSession({ ...launch, place: windlassPlace })),
				]);
				assert(refused.join() === "profile_unavailable,bad_input,bad_input", refused.join(", "));
				assert(
					session.harness === "claude" &&
						session.model === "default" &&
						(await snapshot()).summary.harness === "claude",
					"wrong harness or initial model",
				);
				return refused.join(", ");
			});
			await check("Claude creation refuses an unknown reported model with bad_input", async () => {
				const options = {
					defaultModel: "opus",
					models: [
						{ id: "opus", name: "Opus", efforts: ["default", "high"] },
						{ id: "sonnet", name: "Sonnet", efforts: [] },
					],
					checkedAt: Date.now(),
					modes: [],
				};
				runner.fake.report.harnesses![0]!.options = options;
				runner.report();
				await until(
					"reported model options",
					async () =>
						(await user.machines()).find(m => m.machineId === place.machineId)?.harnesses?.[0]?.optionsDigest ===
						optionsDigest(options),
				);
				const code = await refusal(user.createSession({ ...launch, model: "unknown" }));
				assert(code === "bad_input", "unknown-model refusal was " + code);
				const implicit = await user.createSession(launch);
				try {
					assert(implicit.model === options.defaultModel, "did not use reported default model");
				} finally {
					await user.deleteSession(implicit.id);
				}
				return code;
			});
			await check(
				"Claude sends the launch model and effort on the first turn and falls back on a model switch",
				async () => {
					const other = await user.createSession({ ...launch, model: "opus" });
					const seen = new Watch(client, uid, other.id, token);
					try {
						assert(other.harnessModels?.defaultModel === "opus", "launch did not seed the model list");
						const before = runner.acpInput.length;
						const { turn } = await seen.conn.prompt({ text: "plain", effort: "high" });
						assert((await seen.untilEnded(turn)).outcome === "succeeded", "first turn failed");
						const sent = runner.acpInput.slice(before).map(line => JSON.parse(line));
						const prompted = sent.findIndex(f => f.method === "session/prompt");
						assert(
							prompted >= 0 &&
								sent
									.slice(0, prompted)
									.filter(f => f.method === "session/set_config_option")
									.map(f => f.params.value)
									.join() === "opus,high",
							"first prompt missed its choices",
						);
						const since = runner.acpInput.length;
						const switched = await seen.conn.prompt({ text: "plain", model: "sonnet", effort: "high" });
						assert((await seen.untilEnded(switched.turn)).outcome === "succeeded", "model switch failed");
						const file = join(stateDir, "wlp-fake-acp-" + (await seen.conn.snapshot()).windlassSessionId + ".json");
						assert(JSON.parse(readFileSync(file, "utf8")).effort === "default", "new model missed its default effort");
						assert(
							!runner.acpInput
								.slice(since)
								.map(line => JSON.parse(line))
								.some(f => f.method === "session/set_config_option" && f.params.value === "high"),
							"sent the stale effort",
						);
						assert(
							seen.items.filter(i => i.turn === switched.turn && i.kind === "platform" && i.text.includes("effort"))
								.length === 1,
							"missing or repeated effort fallback",
						);
						const models = (await seen.conn.snapshot()).summary.harnessModels?.models;
						assert(
							models?.some(m => m.id === "opus" && m.efforts.includes("high")) &&
								models.some(m => m.id === "sonnet" && !m.efforts.includes("high")),
							"lost model-specific efforts",
						);
					} finally {
						await seen.conn.dispose();
						await user.deleteSession(other.id);
					}
					return "selected first turn, one fallback line and no stale effort on the wire";
				},
			);
			await check("Claude plain coalesces thought and text and clears pending deltas", async () => {
				const { end, updates, turn } = await play("plain");
				const chunks = updates.filter(u => u.sessionUpdate.endsWith("_chunk"));
				assert(
					JSON.stringify(chunks.map(u => u.content)) ===
						JSON.stringify([
							{ type: "text", text: "I'll inspect the files." },
							{ type: "text", text: "The files are ready." },
						]),
					JSON.stringify(chunks),
				);
				const deltas = watch.deltas.filter(d => d.turn === turn && "acp" in d);
				assert(
					deltas.length === 8 && new Set(deltas.map(d => "messageKey" in d && d.messageKey)).size === 2,
					"expected eight deltas across two keys",
				);
				assert(
					!(await snapshot()).pending.length &&
						end.outcome === "succeeded" &&
						end.verified?.state === "none_set" &&
						end.verified.run === null &&
						end.steps === 0 &&
						end.usage === null &&
						end.cachedShare === null,
					JSON.stringify(end),
				);
				return "eight live chunks, two stored items, no pending chunks, no checks set and no steps";
			});
			await check("a generated title replaces the first prompt's opening words", async () => {
				const { summary } = await snapshot();
				assert(summary.title === "Inspect the files", `title is "${summary.title}"`);
				return summary.title;
			});
			await check("a typed title survives the same update that titles an unnamed session", async () => {
				const other = await user.createSession({ ...launch, title: "My notes" });
				const seen = new Watch(client, uid, other.id, token);
				try {
					const { turn } = await seen.conn.prompt({ text: "plain" });
					await seen.untilEnded(turn);
					assert(
						seen.items.some(i => i.kind === "acp" && i.update.title === "Inspect the files"),
						"missing title update",
					);
					const titles = [(await seen.conn.snapshot()).summary.title, (await snapshot()).summary.title];
					assert(titles[0] === "My notes" && titles[1] === "Inspect the files", titles.join(" / "));
				} finally {
					await seen.conn.dispose();
					await user.deleteSession(other.id);
				}
				return "My notes / Inspect the files";
			});
			await check("both summary feeds publish the later generated title during the turn", async () => {
				const list = user.connect();
				let shown = false;
				let listed = false;
				const off = watch.conn.on("summary", payload => {
					shown ||= (payload as SessionSummary).title === "Review the changes";
				});
				list.on("sessions", payload => {
					listed ||= (payload as SessionSummary[]).some(s => s.id === session.id && s.title === "Review the changes");
				});
				try {
					await list.listSessions();
					const { turn } = await watch.conn.prompt({ text: "retitle" });
					try {
						await until("both live feeds to show Review the changes", () => shown && listed, 5000);
					} finally {
						await watch.conn.prompt({ text: "Check the patch" });
						await watch.untilEnded(turn);
					}
					assert(
						(await snapshot()).summary.title === "Check the patch",
						"later title lost after an empty or missing title",
					);
				} finally {
					off();
					await list.dispose();
				}
				return "both feeds before the turn ended, then Check the patch";
			});
			const sentModes = (since: number) =>
				runner.acpInput
					.slice(since)
					.map(line => JSON.parse(line))
					.filter(f => f.method === "session/set_mode")
					.map(f => f.params.modeId);
			await check("Claude defaults to auto and stores the adapter’s offered list", async () => {
				const { summary } = await snapshot();
				assert(sentModes(0)[0] === "auto", JSON.stringify(sentModes(0)));
				assert(
					summary.mode === "auto" &&
						summary.availableModes.map(m => m.id).join() === "default,acceptEdits,plan,auto,bypassPermissions" &&
						summary.availableModes.every(m => m.name && m.description),
					JSON.stringify(summary),
				);
				return "auto on session/new, five described choices";
			});
			await check("a rename and a mid-turn mode choice both survive subsequent prompts and actor sleep", async () => {
				const { turn } = await watch.conn.prompt({ text: "latechange" });
				await waitDuring(turn, "fixture waiting for follow-up", () => watch.deltas.find(d => d.turn === turn));
				const before = runner.acpInput.length;
				try {
					await watch.conn.setMode({ mode: "plan" });
				} finally {
					await watch.conn.prompt({ text: "finish" });
					await watch.untilEnded(turn);
				}
				assert((await snapshot()).summary.mode === "plan", "an update from the active turn replaced the queued mode");
				assert(!sentModes(before).length, "mode was applied to the running prompt");
				await user.renameSession(session.id, "My review");
				await play("plain");
				await watch.conn.dispose();
				await forceSleep(session.id);
				watch = new Watch(client, uid, session.id, token);
				await play("plain");
				assert((await snapshot()).summary.title === "My review", "a generated title replaced the rename after sleep");
				assert(sentModes(before).join() === "plan,plan", JSON.stringify(sentModes(before)));
				return "My review kept and plan sent on both resumed prompts";
			});
			await check("Claude’s own mode change is visible during its turn and carried into the next open", async () => {
				const { turn } = await watch.conn.prompt({ text: "leaveplan" });
				const q = await waitDuring(turn, "permission after mode change", async () => (await snapshot()).question);
				try {
					assert((await snapshot()).summary.mode === "acceptEdits", "live summary did not follow current_mode_update");
				} finally {
					await watch.conn.answer({ questionId: q.id, choice: q.choices[0]!.id });
					await watch.untilEnded(turn);
				}
				const before = runner.acpInput.length;
				await play("plain");
				assert(sentModes(before).join() === "acceptEdits", JSON.stringify(sentModes(before)));
				await watch.conn.setMode({ mode: "auto" });
				return "acceptEdits published while waiting and sent on resume";
			});
			await check("Claude uses an explicit launch mode on its first prompt and validates later choices", async () => {
				const other = await user.createSession({ ...launch, mode: "plan" });
				const seen = new Watch(client, uid, other.id, token);
				try {
					const before = runner.acpInput.length;
					const { turn } = await seen.conn.prompt({ text: "plain" });
					await seen.untilEnded(turn);
					assert(other.mode === "plan" && sentModes(before).join() === "plan", JSON.stringify(sentModes(before)));
					assert((await refusal(seen.conn.setMode({ mode: "unknown" }))) === "bad_input", "accepted an unlisted mode");
					assert((await seen.conn.snapshot()).summary.mode === "plan", "refusal changed the selected mode");
				} finally {
					await seen.conn.dispose();
					await user.deleteSession(other.id);
				}
				return "plan on session/new, bad_input for an unlisted change";
			});
			await check("Claude explains an unavailable launch choice once and keeps the adapter default", async () => {
				const other = await user.createSession({ ...launch, mode: "no-longer-offered" });
				const seen = new Watch(client, uid, other.id, token);
				try {
					for (let i = 0; i < 2; i++) {
						const { turn } = await seen.conn.prompt({ text: "plain" });
						await seen.untilEnded(turn);
					}
					const notes = seen.items.filter(
						i => i.kind === "platform" && i.text.includes("no-longer-offered") && i.text.includes("default"),
					);
					assert(notes.length === 1 && (await seen.conn.snapshot()).summary.mode === "default", JSON.stringify(notes));
				} finally {
					await seen.conn.dispose();
					await user.deleteSession(other.id);
				}
				return "one fallback line across two opens";
			});
			await check("Claude tools preserve call order, output, diff and failed edit", async () => {
				const { updates } = await play("tools");
				const calls = updates.filter(u => u.sessionUpdate.startsWith("tool_call"));
				assert(
					calls.map(c => c.status).join() === "pending,in_progress,completed,pending,failed",
					JSON.stringify(calls),
				);
				assert(
					calls[0]!.toolCallId === calls[2]!.toolCallId &&
						calls[3]!.toolCallId === calls[4]!.toolCallId &&
						JSON.stringify(calls[3]!.content).includes('"diff"'),
					"lost tool id or diff",
				);
				return "execute completed, edit failed";
			});
			for (const stop of [false, true])
				await check(
					`Claude permission is ${stop ? "withdrawn by Stop" : "answered with the offered option id"}`,
					async () => {
						const { turn } = await watch.conn.prompt({ text: "ask" });
						const question = await waitDuring(turn, "permission", async () => (await snapshot()).question);
						assert(
							question.messageId === "acp" &&
								question.callId &&
								question.choices.some(c => c.id === "allow-with-updates" && c.remembers),
							"missing ACP question choices",
						);
						if (stop) await watch.conn.stop();
						else await watch.conn.answer({ questionId: question.id, choice: "allow-once" });
						const end = await watch.untilEnded(turn);
						assert(
							end.outcome === (stop ? "stopped" : "succeeded") && !(await snapshot()).question,
							JSON.stringify(end),
						);
						assert(
							stop
								? runner.acpInput.some(line => line.includes('"outcome":"cancelled"'))
								: JSON.stringify(watch.items).includes("Permission answered: allow-once."),
							"fixture did not receive the permission answer",
						);
						return end.outcome;
					},
				);
			await check("Claude withdraws only the named permission and shows the next question", async () => {
				const { turn } = await watch.conn.prompt({ text: "askagain" });
				try {
					const first = await waitDuring(turn, "first question", async () => (await snapshot()).question);
					const served = runner.served.get(session.id)!;
					const process = [...served.processes.entries()].find(([, p]) => p.engine)![0];
					const cancel = (requestId: number | string) =>
						served.channel.output(
							process,
							1,
							JSON.stringify({
								jsonrpc: "2.0",
								method: "$/cancel_request",
								params: { requestId },
							}) + "\n",
						);
					cancel("123");
					assert((await snapshot()).question?.id === first.id, "cancelled the wrong RPC id");
					cancel(123);
					const next = await until(
						"replacement permission",
						async () => {
							const q = (await snapshot()).question;
							return q && q.id !== first.id && q;
						},
						5000,
					);
					await watch.conn.answer({ questionId: next.id, choice: "allow-once" });
					assert(
						(await watch.untilEnded(turn)).outcome === "succeeded" &&
							watch.items.some(
								i =>
									i.turn === turn &&
									i.kind === "acp" &&
									JSON.stringify(i.update).includes("Permission answered: allow-once."),
							),
						"replacement question was not answered",
					);
					return "cancelled first RPC, allowed second in the same turn";
				} finally {
					if (!watch.ended(turn)) {
						await watch.conn.stop();
						await watch.untilEnded(turn);
					}
				}
			});
			await check("Claude Stop sends session/cancel during a slow prompt", async () => {
				const before = runner.acpInput.length;
				const { turn } = await watch.conn.prompt({ text: "slow" });
				await waitDuring(turn, "slow output", () => watch.deltas.find(d => d.turn === turn && "acp" in d));
				const now = Date.now();
				await watch.conn.stop();
				const end = await watch.untilEnded(turn, 10_000);
				assert(
					end.outcome === "stopped" &&
						Date.now() - now < 10_000 &&
						runner.acpInput.slice(before).some(line => line.includes('"session/cancel"')),
					JSON.stringify(end),
				);
				return `stopped in ${Date.now() - now} ms`;
			});
			await check("Claude steering reaches the fixture and the session keeps its user row", async () => {
				const { turn } = await watch.conn.prompt({ text: "steer" });
				await waitDuring(turn, "fixture waiting for a steer", () =>
					watch.deltas.find(d => d.turn === turn && "acp" in d),
				);
				const follow = "Read the second file";
				const answer = await watch.conn.prompt({ text: follow });
				await watch.untilEnded(turn);
				assert(
					answer.steered && watch.items.some(i => i.turn === turn && i.kind === "user" && i.steer && i.text === follow),
					"no steered user row",
				);
				assert(
					watch.items.some(
						i =>
							i.turn === turn &&
							i.kind === "acp" &&
							i.update.sessionUpdate === "agent_message_chunk" &&
							JSON.stringify(i.update.content).includes(follow),
					),
					"fixture did not echo the steer",
				);
				return follow;
			});
			await check("Claude explains an unreadable secret before starting a prompt", async () => {
				const marker = join(stateDir, "unreadable-secret");
				const before = runner.acpInput.length;
				writeFileSync(marker, "");
				try {
					const error = await watch.conn.prompt({ text: "plain" }).then(
						() => null,
						e => e,
					);
					assert(
						error?.code === "secrets_unavailable" &&
							error.message.includes("could not read all saved values to redact the harness session"),
						String(error),
					);
					assert(runner.acpInput.length === before, "started an ACP process");
					return error.code;
				} finally {
					rmSync(marker);
				}
			});
			await check("Claude sends a refused steer once as a normal next prompt", async () => {
				const { turn } = await watch.conn.prompt({ text: "turnend" });
				await waitDuring(turn, "turn-end race", () => watch.deltas.find(d => d.turn === turn && "acp" in d));
				const follow = { text: "plain follow-up", idempotencyKey: randomUUID() };
				const answer = await watch.conn.prompt(follow);
				await watch.untilEnded(answer.turn);
				const retried = await watch.conn.prompt(follow);
				assert(!answer.steered && answer.turn === turn + 1 && retried.turn === answer.turn, JSON.stringify(answer));
				const rows = watch.items.filter(i => i.kind === "user" && i.text === follow.text);
				assert(rows.length === 1 && rows[0]!.turn === answer.turn, "lost or duplicated follow-up");
				assert(
					watch.items.some(i => i.turn === turn && i.kind === "platform" && i.text === "Sent when this turn ends."),
					"missing queue note",
				);
				const sent = runner.acpInput
					.map(line => JSON.parse(line))
					.find(f => f.method === "_session/steering" && f.params.prompt[0].text === follow.text);
				assert(sent?.params._meta?.steering?.idleBehavior === "promptRequired", "missing idle behavior");
				return "one user row and a new session/prompt";
			});
			await check("Claude resumes its id and starts fresh with a note if the saved id is lost", async () => {
				const first = await acpSession();
				const count = () => JSON.parse(readFileSync(first.file, "utf8")).resumes as number;
				const before = count();
				await play("plain");
				assert((await acpSession()).id === first.id && count() === before + 1, "no recorded resume");
				rmSync(first.file);
				const { end } = await play("plain");
				assert(
					end.outcome === "succeeded" &&
						(await acpSession()).id !== first.id &&
						watch
							.warnings(end.turn)
							.includes("Claude Code could not continue the conversation; the files are as they were."),
					"no new conversation or explanation",
				);
				return "one recorded resume, then a new id";
			});
			await check("Claude uses its own model and effort options and reports context", async () => {
				const { summary } = await snapshot();
				assert(
					summary.harnessModels?.models.some(m => m.id === "opus" && !m.efforts.length),
					"another model inherited the current efforts",
				);
				const { end } = await play("usage", "opus", "high");
				const state = JSON.parse(readFileSync((await acpSession()).file, "utf8"));
				assert(
					state.model === "opus" && state.effort === "high" && state.mode === "auto",
					"fixture configuration differs",
				);
				assert(
					JSON.stringify(end.context) ===
						JSON.stringify({ used: 41000, size: 200000, cost: { amount: 0.38, currency: "USD" } }),
					JSON.stringify(end),
				);
				return JSON.stringify(end.context);
			});
			await check("Claude's error and last reported sign-out say nothing pays for it on the machine", async () => {
				const { end } = await play("signedout");
				const name = (await user.machines()).find(m => m.machineId === place.machineId)!.name;
				const sentence = `Nothing can pay for Claude Code on “${name}” yet. Connect a plan or add a key on Connections.`;
				assert(
					end.outcome === "error" && end.message?.includes("Authentication required") && end.message.includes(sentence),
					JSON.stringify(end),
				);
				const entry = runner.fake.report.harnesses![0]!;
				entry.signIn = "none";
				runner.report();
				try {
					await until(
						"signed-out report",
						async () =>
							(await user.machines()).find(m => m.machineId === place.machineId)?.harnesses?.[0]?.signIn === "none",
					);
					const created = await user.createSession(launch);
					const refused = await client.agentSession
						.get([uid, created.id], { params: { token } })
						.prompt({ text: "plain" })
						.then(
							() => "",
							e => e.message,
						);
					// Pay with decides the next prompt: with no plan connected, a key would pay.
					const payWith = "Add an Anthropic key on the Connections page to run Claude Code here.";
					assert(refused.includes(payWith), `signed-out prompt was not refused by Pay with: ${refused}`);
				} finally {
					entry.signIn = "token";
					runner.report();
				}
				return sentence;
			});
			github.addUser("ada");
			const installation = github.addInstallation("ada", "User");
			const repo = github.addRepository({ owner: "ada", name: "harbor", private: true, installation });
			const { url } = await user.githubConnect({ origin: "http://localhost:5173" });
			const back = await fetch(github.authorize("ada", url), { redirect: "manual" });
			await user.githubComplete(back.headers.get("location")!.split("#github=")[1]!);
			await check(
				"Claude redacts a saved repository secret in the prompt, streamed chunks and tool output",
				async () => {
					const value = randomBytes(16).toString("hex");
					await user.saveRepositorySecret({
						repositoryId: repo.id,
						profile,
						name: "HARBOR_KEY",
						value,
						scope: "setup",
					});
					await user.setMachineSecrets({ machineId: place.machineId, send: false });
					const created = await user.createSession({ ...launch, repository: { id: repo.id } });
					const seen = new Watch(client, uid, created.id, token);
					try {
						const { turn } = await seen.conn.prompt({ text: `secret:${value}` });
						const end = await seen.untilEnded(turn);
						assert(
							end.outcome === "succeeded" && seen.items.some(i => i.kind === "acp" && i.update.status === "completed"),
							"the fixture did not echo the secret",
						);
						const steering = await seen.conn.prompt({ text: "steer" });
						await until("a steerable turn", () => seen.deltas.find(d => d.turn === steering.turn && "acp" in d));
						assert((await seen.conn.prompt({ text: value })).steered, "the fixture did not accept the steer");
						await seen.untilEnded(steering.turn);
						const saved = await seen.conn.snapshot();
						// Cut to 80 characters at the last whole word, the run of x's is too long to keep.
						const expected = "Check [secret:HARBOR_KEY] [secret:HARBOR_KEY]…";
						assert(
							saved.summary.title === expected,
							`generated title was not single-line, redacted and bounded to 80 characters: "${saved.summary.title}"`,
						);
						const content = JSON.stringify([saved, seen.items, seen.deltas]);
						assert(
							!content.includes(value) && content.includes("HARBOR_KEY"),
							"saved secret exposed or redaction missing",
						);
					} finally {
						await seen.conn.dispose();
					}
					return "prompt, steer, title, chunk and tool result scrubbed";
				},
			);
			await check("Windlass and Claude on the same stand-in retain their respective event kinds", async () => {
				const other = await user.createSession({ place, profile });
				const seen = new Watch(client, uid, other.id, token);
				try {
					const { turn } = await seen.conn.prompt({ text: "Write the primes" });
					assert(
						(await seen.untilEnded(turn)).outcome === "succeeded" &&
							seen.windlass(turn) > 0 &&
							!seen.items.some(i => i.kind === "acp") &&
							watch.items.some(i => i.kind === "acp") &&
							!watch.items.some(i => i.kind === "windlass"),
						"mixed or missing engine events",
					);
				} finally {
					await seen.conn.dispose();
				}
				return "both engines isolated";
			});
			await check("Windlass sends the selected approval on open and resume", async () => {
				const other = await user.createSession({ place, profile, mode: "ask" });
				const seen = new Watch(client, uid, other.id, token);
				try {
					for (const [method, expected] of [
						["new", "ask"],
						["resume", "ask"],
						["resume", "full"],
					]) {
						if (expected === "full") await seen.conn.setMode({ mode: expected });
						runner.opens.delete(other.id);
						const { turn } = await seen.conn.prompt({ text: "plain" });
						await seen.untilEnded(turn);
						assert(
							runner.opens.get(other.id)?.approval === expected,
							`session/${method}: ${JSON.stringify(runner.opens.get(other.id))}`,
						);
					}
				} finally {
					await seen.conn.dispose();
					await user.deleteSession(other.id);
				}
				return "ask on new and resume, full on the next resume after setMode";
			});
			await check("work items refuse a mode at creation", async () => {
				const raw = { title: "Inspect", body: "Read the repo", repository: { id: repo.id }, mode: "ask" };
				const code = await refusal(user.createItem(raw as never));
				assert(code === "bad_input", String(code));
				return code;
			});
			await check("Claude Code can be chosen for a planned item and runs Quick on a compatible machine", async () => {
				const raw = {
					title: "Inspect",
					body: "Read the repo",
					repository: { id: repo.id },
					harness: "claude" as const,
				};
				for (const [destination, requestedProfile] of [
					[{ kind: "hosted" }, profile],
					[place, "docker-windlass-sandbox"],
				] as const) {
					const waiting = await user.createItem({
						...raw,
						place: destination,
						mode: "single",
						profile: requestedProfile,
						start: true,
					});
					assert(waiting.question?.kind === "run_place" && waiting.awaitingPlace, "missing placement question");
					assert(
						!(await user.listSessions()).some(s => s.id === waiting.sessionId),
						"started a builder on an unavailable placement",
					);
					await user.actOnItem({ id: waiting.id, action: { kind: "cancel" } });
				}
				const planFirst = await user.createItem({ ...raw, place, mode: "orchestrate", start: false });
				assert(
					planFirst.mode === "orchestrate" && planFirst.resolved?.agent === "windlass",
					"Choosing Claude Code changed the planning role",
				);
				await user.actOnItem({ id: planFirst.id, action: { kind: "cancel" } });
				const item = await user.createItem({ ...raw, place, mode: "single", profile });
				const builder = (await user.listSessions()).find(s => s.id === item.sessionId);
				assert(
					item.agent?.harness === "claude" &&
						builder?.harness === "claude" &&
						builder.profile === "docker-hardened" &&
						builder.mode === "bypassPermissions",
					JSON.stringify({
						agent: item.agent,
						harness: builder?.harness,
						profile: builder?.profile,
						mode: builder?.mode,
					}),
				);
				await user.actOnItem({ id: item.id, action: { kind: "cancel" } }).catch(() => undefined);
				return "unavailable placements asked, Windlass plans, compatible Claude Code builder in bypassPermissions";
			});
			await check("Claude bounds the serialized item, live deltas and reconnect text", async () => {
				const { id } = await acpSession();
				const { turn } = await watch.conn.prompt({ text: "steer" });
				await waitDuring(turn, "fixture waiting for a steer", () =>
					watch.deltas.find(d => d.turn === turn && "acp" in d),
				);
				const served = runner.served.get(session.id)!;
				const process = [...served.processes.entries()].find(([, p]) => p.engine)![0];
				const send = (update: AcpUpdate) =>
					served.channel.output(
						process,
						1,
						JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: id, update } }) + "\n",
					);
				const big = "x".repeat(65_000);
				send({
					sessionUpdate: "tool_call",
					toolCallId: big,
					kind: big,
					status: big,
					rawInput: { [big]: 1 },
					content: [{ type: big }],
				});
				const piece = 'a"\n'.repeat(3000);
				for (let i = 0; i < 20; i++)
					send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: piece, extra: big } });
				// A permission frame is an ordered barrier that does not flush the pending text run.
				served.channel.output(
					process,
					1,
					JSON.stringify({
						jsonrpc: "2.0",
						id: 77,
						method: "session/request_permission",
						params: { sessionId: id, toolCall: { title: "barrier" }, options: [] },
					}) + "\n",
				);
				try {
					await waitDuring(turn, "all chunks processed", async () => (await snapshot()).question);
					const pending = (await snapshot()).pending.find(
						d => "acp" in d && d.acp.sessionUpdate === "agent_thought_chunk",
					);
					assert(pending && "acp" in pending, "missing pending run");
					send({
						sessionUpdate: "tool_call_update",
						content: [{ type: "content", content: { type: "text", text: big } }],
						toolCallId: "large",
						status: "completed",
					});
					await watch.conn.prompt({ text: "finish" });
					await watch.untilEnded(turn);
					const items = watch.items.filter(i => i.turn === turn && i.kind === "acp");
					const clipped = items.filter(i => i.kind === "acp" && i.truncated);
					assert(
						clipped.length === 3 && items.every(i => JSON.stringify(i).length <= 64_000),
						"whole serialized item exceeded cap or missing truncation marker",
					);
					const deltas = watch.deltas.flatMap(d =>
						d.turn === turn && "acp" in d && d.messageKey === pending.messageKey ? [d] : [],
					);
					const text = (u: AcpUpdate) => (u.content as { text: string }).text;
					const stored = clipped.find(i => i.kind === "acp" && i.messageKey === pending.messageKey);
					const kept = text(pending.acp);
					assert(
						stored?.kind === "acp" &&
							text(stored.update) === kept &&
							kept.length > 100 &&
							piece.repeat(20).startsWith(kept),
						"reconnect differs from stored prefix",
					);
					assert(
						deltas.every(d => "acp" in d && text(d.acp).length > 0 && JSON.stringify(d).length <= 64000) &&
							deltas.map(d => "acp" in d && text(d.acp)).join("") === kept,
						"broadcast exceeds retained text",
					);
					assert(
						clipped.some(i => i.kind === "acp" && i.update.toolCallId === "large" && i.update.status === "completed"),
						"truncation discarded tool state",
					);
					return `retained ${kept.length} escaped text characters identically in all three views`;
				} finally {
					if (!watch.ended(turn)) {
						await watch.conn.stop();
						await watch.untilEnded(turn);
					}
				}
			});
			await check("Claude caps mixed text and tool updates at 5000 items and one note", async () => {
				const { turn, updates } = await play("many");
				const notes = watch.items.filter(
					i => i.turn === turn && i.kind === "platform" && i.level === "warn" && i.text.includes("5,000"),
				);
				assert(updates.length === 5000 && notes.length === 1, `${updates.length} items and ${notes.length} notes`);
				return "5,000 items, one omission note";
			});
			await check("Claude refusal and token limit preserve distinct turn outcomes", async () => {
				const invalid = (await play("invalidparams")).end;
				assert(
					invalid.outcome === "error" &&
						invalid.message?.includes("The provider refused the request. Invalid reasoning effort."),
					JSON.stringify(invalid),
				);
				const refusal = (await play("refuse")).end;
				const limit = (await play("maxtokens")).end;
				assert(
					refusal.outcome === "failed" &&
						refusal.message?.includes("The provider refused") &&
						limit.outcome === "unresolved",
					`${refusal.outcome}, ${limit.outcome}`,
				);
				return "failed, unresolved";
			});
			// A Claude Code turn whose machine goes away (WLP_TURN_RESUME): its adapter is gone with the conversation, and the
			// resumed turn's new adapter takes the session up through `session/resume`, from what the old one left on disk.
			if (server)
				await check(
					"a Claude Code turn whose machine goes away mid-turn resumes through the adapter's session resume when it is back",
					async () => {
						await within("the watcher to close", watch.conn.dispose(), 15_000).catch(() => undefined);
						await server.stop();
						await server.start({
							...github.env(),
							WLP_ITEMS: "1",
							WLP_TURN_RESUME: "1",
							WLP_TEST_RUNNER_GRACE_MS: "3000",
						});
						await until("the Claude machine's control socket", () => runner.control !== null, 60_000);
						watch = new Watch(client, uid, session.id, token);
						// A turn first, so that the session has its ACP session (an earlier check may have had none).
						await play("plain");
						const { turn } = await watch.conn.prompt({ text: "steer" });
						await waitDuring(turn, "the fixture to wait for a steer", () =>
							watch.items.some(i => i.turn === turn && i.kind === "acp"),
						);
						const { id } = await acpSession();
						const input = runner.acpInput.length;
						await runner.setOffline(true);
						await until(
							"the turn to pause for its machine",
							async () => (await snapshot()).summary.status === "paused",
							90_000,
						);
						await runner.setOffline(false);
						const end = await watch.untilEnded(turn, 120_000);
						assert(end.outcome === "succeeded", `the turn ended ${end.outcome}: ${end.message}`);
						const after = runner.acpInput.slice(input).join("");
						assert(
							after.includes('"session/resume"') && after.includes(id),
							"the new adapter was not asked to resume the session",
						);
						assert(after.includes("Your machine was switched off"), "the resumed turn was not given the resume prompt");
						const resumed = watch.items.find(
							i => i.turn === turn && i.kind === "platform" && i.code === "turn_resumed",
						);
						assert(
							resumed?.kind === "platform" && resumed.text.startsWith("Resumed after the machine came back"),
							"no line says the turn resumed",
						);
						// Closed before its server goes: a connection to a server that is gone does not close.
						await within("the watcher to close", watch.conn.dispose(), 15_000).catch(() => undefined);
						await server.stop();
						await server.start({ ...github.env(), WLP_ITEMS: "1" });
						await until("the Claude machine's control socket", () => runner.control !== null, 60_000);
						watch = new Watch(client, uid, session.id, token);
						return `session ${id.slice(0, 8)} resumed by session/resume; ${resumed.text}`;
					},
				);
		} finally {
			await within("the watcher to close", watch.conn.dispose(), 15_000).catch(() => undefined);
		}
	} finally {
		runner.offline = true;
		runner.control?.ws.close();
		for (const served of runner.served.values()) served.ws?.close();
	}
}

async function main(): Promise<void> {
	const server = new Server();
	// Before anything imports auth.js, which reads it once: the service tokens this process makes are the server's.
	process.env.WLP_SECRET = server.secret;
	// First, and on a clock of their own: nothing of the server is needed for them.
	const shortSuite = ["fairness", "inventory"].includes(process.argv[2] ?? "");
	if (!shortSuite) await linkChecks();
	const runner = new StandInRunner(ORIGIN, ENDPOINT, shortSuite ? { claude: true, stateDir: server.storage } : {});
	const github = new GithubStandin({ callbackUrl: `${ORIGIN}/github/callback` });
	await github.start();
	try {
		await server.start({ ...github.env(), WLP_ITEMS: "1" });
		const client = createClient<Registry>({ endpoint: ENDPOINT, token: "default", namespace: "default" });
		const auth = await loginHttp(ORIGIN).demo();
		const { uid } = auth.profile;
		const token = auth.token;
		const user = client.user.getOrCreate([uid], { params: { token } });
		await runner.pair(user);
		const place = { kind: "machine" as const, machineId: runner.id.machineId };
		const newSession = (repoUrl?: string): Promise<SessionSummary> =>
			user.createSession({ place, profile: "docker-hardened", ...(repoUrl ? { repoUrl } : {}) });
		const refusal = (p: Promise<unknown>) =>
			p.then(
				() => "accepted",
				error => String((error as { code?: unknown }).code),
			);

		if (shortSuite) {
			const options = {
				models: [
					{ id: "opus", name: "Reported Opus", efforts: ["high"] },
					{ id: "sonnet", name: "Reported Sonnet", efforts: ["low"] },
				],
				defaultModel: "opus",
				modes: [{ id: "plan", name: "Plan", description: "Plan first" }],
				checkedAt: Date.now(),
			};
			runner.fake.report.harnesses![0]!.options = options;
			runner.fake.report.harnesses!.push({
				id: "codex",
				adapter: "codex-acp 2.9.0",
				image: "fixture",
				signIn: "none",
				modes: ["agent-full-access"],
				options: { ...options, modes: [{ id: "agent-full-access", name: "Container access", description: null }] },
			});
			runner.fake.maxTurns = 2;
			runner.fake.report.slots = {
				max: 2,
				unit: { cpus: 1, memoryBytes: 1.5 * 2 ** 30, pids: 512 },
				reserve: { cpus: 0, memoryBytes: 0 },
			};
			await runner.connectControl();
			await until("machine report", async () => (await user.machines()).some(m => m.commandSandbox));
			await check(
				"a fresh Claude session shows the machine catalog before turn one, then adopts the live ACP catalog",
				async () => {
					const created = await user.createSession({ place, profile: "docker-hardened", harness: "claude" });
					const seen = new Watch(client, uid, created.id, token);
					try {
						const before = await seen.conn.snapshot();
						assert(before.windlassSessionId === null && before.summary.turns === 0, "session already opened");
						for (const summary of [created, before.summary]) {
							deepStrictEqual(summary.harnessModels, {
								source: "harness",
								models: options.models,
								fetchedAt: options.checkedAt,
								defaultModel: "opus",
							});
							deepStrictEqual(summary.availableModes, options.modes);
							assert(summary.mode === "plan" && summary.model === "opus", "initial selection absent from report");
						}
						const { turn } = await seen.conn.prompt({ text: "plain" });
						assert((await seen.untilEnded(turn)).outcome === "succeeded", "first turn failed");
						const after = (await seen.conn.snapshot()).summary;
						assert(
							after.harnessModels?.defaultModel === "default" &&
								after.harnessModels.models.some(m => m.id === "default"),
							"first turn did not replace the catalog",
						);
						assert(
							after.availableModes?.some(m => m.id === "auto"),
							"first turn did not replace modes",
						);
					} finally {
						await seen.conn.dispose();
						await user.deleteSession(created.id);
					}
					return "model names, efforts, modes and report timestamp persisted before ACP opened";
				},
			);
			await check("Codex refuses a forged sandbox mode and prompts with the machine login command", async () => {
				const launch = { place, profile: "docker-hardened" as const, harness: "codex" as const };
				assert(
					(await refusal(user.createSession({ ...launch, mode: "workspace-write" }))) === "bad_input",
					"forged launch mode accepted",
				);
				const created = await user.createSession(launch);
				const seen = new Watch(client, uid, created.id, token);
				try {
					assert(
						(await refusal(seen.conn.setMode({ mode: "workspace-write" }))) === "bad_input",
						"forged session mode accepted",
					);
					assert(
						(await refusal(seen.conn.prompt({ text: "hello" }))) === "harness_signed_out",
						"wrong signed-out failure",
					);
				} finally {
					await seen.conn.dispose();
					await user.deleteSession(created.id);
				}
				return "restricted mode refused at create and setMode, signed-out turn refused";
			});
			await check("Codex keeps a saved restricted mode when the machine loses its inner sandbox", async () => {
				const report = runner.fake.report;
				const codex = report.harnesses!.find(h => h.id === "codex")!;
				report.allowedProfiles = ["docker-hardened", "docker-windlass-sandbox"];
				codex.modes = ["agent-full-access", "workspace-write"];
				codex.signIn = "token";
				runner.report();
				const hasInner = async () =>
					(await user.machines())
						.find(m => m.machineId === place.machineId)
						?.harnesses?.find(h => h.id === "codex")
						?.modes?.includes("workspace-write");
				await until("Codex sandbox probe passed", hasInner);
				// A runner from before Auto review was withdrawn still reports it: the platform never offers it.
				codex.modes = ["agent-full-access", "read-only", "workspace-write", "agent"];
				runner.report();
				await until(
					"Codex reported every mode",
					async () =>
						(await user.machines()).find(m => m.machineId === place.machineId)?.harnesses?.find(h => h.id === "codex")
							?.modes?.length === 4,
				);
				assert(
					(await refusal(
						user.createSession({
							place,
							profile: "docker-windlass-sandbox",
							harness: "codex",
							mode: "agent-full-access",
						}),
					)) === "bad_input",
					"Container access offered on the Windlass sandbox profile",
				);
				assert(
					(await refusal(
						user.createSession({ place, profile: "docker-windlass-sandbox", harness: "codex", mode: "agent" }),
					)) === "bad_input",
					"Auto review offered on the Windlass sandbox profile",
				);
				const plain = await user.createSession({ place, profile: "docker-windlass-sandbox", harness: "codex" });
				const plainSeen = new Watch(client, uid, plain.id, token);
				try {
					const summary = (await plainSeen.conn.snapshot()).summary;
					assert(
						summary.mode === "workspace-write",
						`default Codex mode on the Windlass sandbox profile is ${summary.mode}`,
					);
					assert(
						summary.availableModes.map(m => m.id).join() === "read-only,workspace-write",
						"Windlass sandbox profile offered more than Read-only and Workspace access",
					);
					assert(
						(await refusal(plainSeen.conn.setMode({ mode: "agent" }))) === "bad_input",
						"setMode reached Auto review on the Windlass sandbox profile",
					);
					assert(
						(await refusal(plainSeen.conn.setMode({ mode: "agent-full-access" }))) === "bad_input",
						"setMode reached Container access on the Windlass sandbox profile",
					);
				} finally {
					await plainSeen.conn.dispose();
					await user.deleteSession(plain.id);
				}
				const created = await user.createSession({
					place,
					profile: "docker-windlass-sandbox",
					harness: "codex",
					mode: "workspace-write",
				});
				const seen = new Watch(client, uid, created.id, token);
				try {
					codex.modes = ["agent-full-access"];
					codex.modeReason = "The machine's Codex sandbox probe failed.";
					runner.report();
					await until("Codex sandbox probe failed", async () => (await hasInner()) === false);
					const denied = await seen.conn.prompt({ text: "hello" }).then(
						() => "",
						(error: Error) => error.message,
					);
					assert(denied.includes(codex.modeReason), "turn omitted the probe failure");
					assert((await seen.conn.snapshot()).summary.mode === "workspace-write", "saved mode escalated");
				} finally {
					await seen.conn.dispose();
					await user.deleteSession(created.id);
				}
				return "turn refused before creating a container and the saved mode is preserved";
			});
			if (process.argv[2] === "inventory") return;
			const { machineFairnessChecks } = await import("./machine-fairness-check.js");
			await machineFairnessChecks(check, client, runner, token, server.storage);
			return;
		}
		await check("launch on a paired machine that has never reported is refused", async () => {
			const code = await refusal(newSession());
			assert(code === "machine_not_connected", `launch was ${code}`);
			return code;
		});

		await check("launch on a machine with an outdated runner is refused", async () => {
			const old = await runner.openControl("0.0.9");
			try {
				await until("the outdated version in the user's list", async () =>
					(await user.machines()).some(
						m => m.machineId === place.machineId && m.warnings.some(w => w.kind === "outdated"),
					),
				);
				const code = await refusal(newSession());
				assert(code === "runner_outdated", `launch was ${code}`);
				return code;
			} finally {
				old.ws.close();
			}
		});

		await runner.connectControl();
		// What the machine's own actor says of it now (the user's list may be behind, as after a restart).
		const { serviceParams } = await import("../server/src/auth.js");
		const machineIs = (status: string) =>
			until(
				`the machine's actor to say it is ${status}`,
				async () =>
					(await client.machine.get([uid, runner.id.machineId], { params: serviceParams() }).internalFacts()).status ===
					status,
				60_000,
			);
		await machineIs("online");
		// A launch reads the machine's profiles from its report in the user's list.
		await until("the machine's report in the user's list", async () =>
			(await user.machines()).some(machine => machine.commandSandbox !== null),
		);
		const boxesOf = (sessionId: string) => [...runner.boxes.values()].filter(box => box.sessionId === sessionId);
		const turn = async (
			sessionId: string,
			text: string,
		): Promise<{ watch: Watch; ended: Extract<TimelineItem, { kind: "turn.ended" }>; ms: number }> => {
			const watch = new Watch(client, uid, sessionId, token);
			try {
				const started = Date.now();
				const { turn: number } = await watch.conn.prompt({ text });
				const ended = await watch.untilEnded(number);
				return { watch, ended, ms: Date.now() - started };
			} finally {
				await watch.conn.dispose();
			}
		};

		await claudeChecks(client, uid, token, place, server.storage, github, server);
		if (process.argv[2] === "claude") return;
		const main = await newSession();
		await check("the first snapshot after a sandbox-less machine session wakes shows its machine profile", async () => {
			// Instantiate the link before sleep too, so the wake must build a fresh one.
			await snapshotOf(client, uid, main.id, token);
			await forceSleep(main.id);
			const before = runner.attaches;
			const snapshot = await snapshotOf(client, uid, main.id, token);
			assert(snapshot.summary.sandbox === "none", `sandbox: ${snapshot.summary.sandbox}`);
			const machine = (await user.machines()).find(row => row.machineId === place.machineId);
			const open = machine?.profiles.find(profile => profile.id === "docker-hardened");
			assert(
				open?.name === "Open" && open.available && open.details?.includes(runner.fake.details.name),
				`machine profile: ${JSON.stringify(open)}`,
			);
			deepStrictEqual(snapshot.profile, open);
			assert(runner.attaches === before, "reading the profile opened a runner socket");
			return snapshot.profile.name;
		});

		let plainEvents = 0;
		await check("a turn on the machine completes, with its sandbox on the machine, and is not metered", async () => {
			const { watch, ended } = await turn(main.id, "Write the primes");
			assert(ended.outcome === "succeeded", `ended ${ended.outcome}: ${ended.message}`);
			plainEvents = watch.windlass(ended.turn);
			assert(plainEvents > 10, `${plainEvents} Windlass events`);
			assert(boxesOf(main.id).length === 1, `${boxesOf(main.id).length} sandboxes on the machine`);
			const usage = await user.usage();
			assert(
				usage.usedSeconds === 0 && usage.heldSeconds === 0 && usage.today.length === 0 && usage.kept.length === 0,
				"the machine's sandbox counted against the user's sandbox time",
			);
			// What its server question and its pull request name the machine by, kept from the launch.
			const meta = await (
				client.agentSession.get([uid, main.id], { params: { token } }) as unknown as {
					e2eMeta(): Promise<{ machineName?: string | null }>;
				}
			).e2eMeta();
			assert(
				meta.machineName === runner.fake.details.name,
				`the session kept the machine's name as ${JSON.stringify(meta.machineName)}`,
			);
			return `${plainEvents} events, one sandbox, nothing held; the machine's name "${meta.machineName}" kept`;
		});

		await check(
			"a hosted session of the same person still takes its hold and its kept place; the machine's takes neither",
			async () => {
				const hosted = await user.createSession({ place: { kind: "hosted" }, profile: "docker-hardened" });
				try {
					const { ended } = await turn(hosted.id, "Write the primes");
					assert(ended.outcome === "succeeded", `the hosted turn ended ${ended.outcome}: ${ended.message}`);
					const usage = await user.usage();
					assert(
						usage.today.length === 1 && usage.today[0]?.sessionId === hosted.id && usage.today[0].heldSeconds > 0,
						`today: ${JSON.stringify(usage.today)}`,
					);
					assert(
						usage.sandboxes.kept === 1 && usage.kept.length === 1 && usage.kept[0]?.sessionId === hosted.id,
						`kept: ${usage.sandboxes.kept}, ${JSON.stringify(usage.kept.map(k => k.sessionId))}`,
					);
				} finally {
					await user.deleteSession(hosted.id);
				}
				return "one hold and one kept place, both the hosted session's, beside a running machine sandbox";
			},
		);

		await check(
			`a session on the machine takes no running slot: with the ceiling at ${CEILING} and a hosted turn running it starts, a second hosted one is refused, and a hosted one starts beside a machine turn`,
			async () => {
				const hosted = await user.createSession({ place: { kind: "hosted" }, profile: "docker-hardened" });
				const second = await user.createSession({ place: { kind: "hosted" }, profile: "docker-hardened" });
				try {
					const busy = new Watch(client, uid, hosted.id, token);
					try {
						const { turn: number } = await busy.conn.prompt({ text: "Fix the failing test (slow)" });
						await until("the hosted turn to run", () => busy.windlass(number) >= 3, 30_000);
						const { ended } = await turn(main.id, "Write the primes");
						assert(
							ended.outcome === "succeeded",
							`the machine's turn beside a hosted one ended ${ended.outcome}: ${ended.message}`,
						);
						const refused = await refusal(
							client.agentSession.get([uid, second.id], { params: { token } }).prompt({ text: "Write the primes" }),
						);
						assert(refused === "too_many_running", `a second hosted turn was ${refused}`);
						await busy.untilEnded(number);
					} finally {
						await busy.conn.dispose();
					}
					const onMachine = new Watch(client, uid, main.id, token);
					try {
						const { turn: number } = await onMachine.conn.prompt({ text: "Write the primes (slow)" });
						await until("the machine's turn to run", () => onMachine.windlass(number) >= 3);
						const { ended } = await turn(second.id, "Write the primes");
						assert(
							ended.outcome === "succeeded",
							`a hosted turn beside the machine's ended ${ended.outcome}: ${ended.message}`,
						);
						await onMachine.untilEnded(number);
					} finally {
						await onMachine.conn.dispose();
					}
				} finally {
					await user.deleteSession(hosted.id);
					await user.deleteSession(second.id);
				}
				// What bounds the machine is its runner's own cap: the turn says the runner's sentence.
				const capped = await newSession();
				runner.full = true;
				try {
					const { ended } = await turn(capped.id, "Write the primes");
					assert(
						ended.outcome === "error" &&
							ended.message === "This machine has reached its own limit on kept sandboxes, set by --max-sandboxes.",
						`at the machine's cap the turn ended ${ended.outcome}: ${ended.message}`,
					);
					return `machine turn beside a hosted one: succeeded; second hosted: too_many_running; hosted beside a machine turn: succeeded; at the machine's cap: "${ended.message}"`;
				} finally {
					runner.full = false;
					await user.deleteSession(capped.id);
				}
			},
		);

		await check("a link cut in the middle of a turn resumes, and the person sees nothing of it", async () => {
			const before = runner.attaches;
			const watch = new Watch(client, uid, main.id, token);
			try {
				const { turn: number } = await watch.conn.prompt({ text: "Write the primes (slow)" });
				await until("the turn's first events", () => watch.windlass(number) >= 3);
				runner.served.get(main.id)?.ws?.close();
				const ended = await watch.untilEnded(number);
				assert(ended.outcome === "succeeded", `ended ${ended.outcome}: ${ended.message}`);
				assert(
					watch.windlass(number) === plainEvents,
					`${watch.windlass(number)} events, ${plainEvents} without the cut`,
				);
				assert(watch.warnings(number).length === 0, `warnings: ${watch.warnings(number).join("; ")}`);
				assert(runner.attaches > before, "the session did not have the runner attach again");
				assert((runner.served.get(main.id)?.resets.length ?? 0) === 0, "the conversation was reset");
			} finally {
				await watch.conn.dispose();
			}
			return `the runner was asked to attach ${runner.attaches - before} time(s) after the cut; every event once`;
		});

		await check(
			"a message sent into a turn while the machine is not answering is refused at once, is not kept, and the turn goes on when the machine is back",
			async () => {
				const watch = new Watch(client, uid, main.id, token);
				const STEER = "And print the squares too";
				try {
					const { turn: number } = await watch.conn.prompt({ text: "Write the primes (slow)" });
					await until("the turn's first events", () => watch.windlass(number) >= 3);
					// The socket goes, and the runner does not come back until it is let.
					runner.attachMode = "ignore";
					runner.served.get(main.id)?.ws?.close();
					await sleep(1_000);
					const at = Date.now();
					const said = await Promise.race([
						watch.conn.prompt({ text: STEER }).then(
							() => ({ code: "taken" as unknown, message: "" }),
							error => ({
								code: (error as { code?: unknown }).code,
								message: String((error as { message?: unknown }).message ?? ""),
							}),
						),
						sleep(8_000).then(() => ({ code: "still waiting" as unknown, message: "" })),
					]);
					const ms = Date.now() - at;
					runner.attachMode = "serve";
					assert(
						said.code === "steer_unavailable" &&
							said.message ===
								"Your machine is not answering, so the message was not sent. Send it again when it is back.",
						`the message sent with the machine away: ${String(said.code)} after ${ms} ms ${said.message}`,
					);
					assert(ms < 3_000, `refused after ${ms} ms`);
					const ended = await watch.untilEnded(number);
					assert(
						ended.outcome === "succeeded",
						`the turn ended ${ended.outcome} once the machine was back: ${ended.message}`,
					);
					const timeline = (await snapshotOf(client, uid, main.id, token)).timeline;
					assert(
						!timeline.some(item => item.kind === "user" && item.text === STEER),
						"the refused message is in the timeline",
					);
					return `refused in ${ms} ms: "${said.message}"; the turn then ${ended.outcome}`;
				} finally {
					runner.attachMode = "serve";
					await watch.conn.dispose();
				}
			},
		);

		await check(
			"the session's actor going to sleep and waking ends the conversation, and the next turn works",
			async () => {
				const resets = runner.served.get(main.id)?.resets.length ?? 0;
				await server.stop();
				await server.start();
				await machineIs("online");
				const { ended } = await turn(main.id, "Write the primes");
				assert(ended.outcome === "succeeded", `ended ${ended.outcome}: ${ended.message}`);
				const now = runner.served.get(main.id)?.resets ?? [];
				assert(now.length === resets + 1, `${now.length - resets} resets on the runner`);
				return `runner told: ${now.at(-1)}`;
			},
		);

		await check(
			"a server restart during a machine turn interrupts it, ends its engine and lets the next prompt run",
			async () => {
				const watch = new Watch(client, uid, main.id, token);
				let closed = false;
				try {
					const { turn: number } = await watch.conn.prompt({ text: "Write the primes (slow)" });
					const box = await until(
						"the turn's engine to stream",
						() => watch.windlass(number) >= 3 && boxesOf(main.id).find(box => box.engines.size === 1),
					);
					// Close the watcher while its server is there: RivetKit's client can leave the dispose of a connection
					// whose reconnect gave up across the restart unanswered. The turn goes on without it.
					await within("the watcher of the turn to close", watch.conn.dispose(), 15_000);
					closed = true;
					await within("the server to stop", server.stop(), 90_000);
					await within("the server to start again", server.start(), 90_000);
					await machineIs("online");
					// The server may have closed the turn while the watcher was disconnected.
					const snapshot = await within(
						"the session's snapshot after the restart",
						snapshotOf(client, uid, main.id, token),
						30_000,
					);
					const cut = snapshot.timeline.find(item => item.turn === number && item.kind === "turn.ended");
					assert(
						cut?.kind === "turn.ended" && cut.outcome === "interrupted",
						`turn ${number} after restart: ${cut?.kind === "turn.ended" ? cut.outcome : "no ending"}`,
					);
					await until("the runner to end the interrupted turn's engine", () => box.engines.size === 0);
					const { ended } = await within("the next turn", turn(main.id, "Write the primes"), 120_000);
					assert(ended.outcome === "succeeded", `next turn ended ${ended.outcome}: ${ended.message}`);
					return `turn ${number} interrupted, its engine stopped; turn ${ended.turn} succeeded`;
				} finally {
					if (!closed) await within("the watcher of the turn to close", watch.conn.dispose(), 15_000);
				}
			},
		);

		// Turns that survive a restart (WLP_RUNNER_DURABLE_TURNS, runner/journal.ts): the same engine carries on, each event once.
		const durable = { ...github.env(), WLP_ITEMS: "1", WLP_RUNNER_DURABLE_TURNS: "1", WLP_TEST_MACHINE_PLAN: "1" };
		const eventSeqs = (timeline: TimelineItem[], number: number) =>
			timeline.flatMap(item =>
				item.kind === "windlass" && item.turn === number && typeof item.event.seq === "number" ? [item.event.seq] : [],
			);
		/** A slow turn, the server stopped mid-turn by `stop`, started again: what the timeline and the runner say of it. */
		const acrossRestart = async (stop: () => Promise<void>) => {
			const watch = new Watch(client, uid, main.id, token);
			let closed = false;
			try {
				const resets = runner.served.get(main.id)?.resets.length ?? 0;
				const { turn: number } = await watch.conn.prompt({ text: "Write the primes (slow)" });
				const box = await until(
					"the turn's engine to stream",
					() => watch.windlass(number) >= 3 && boxesOf(main.id).find(box => box.engines.size === 1),
				);
				// A server that stops before the turn's first timeline write has nothing to take up: that is the fallback, not this check.
				const session = client.agentSession.get([uid, main.id], { params: { token } }) as unknown as {
					e2eCheckpoint(): Promise<number | null>;
				};
				await until("the turn's checkpoint to be stored", async () => (await session.e2eCheckpoint()) === number);
				const starts = runner.engineStarts;
				await within("the watcher of the turn to close", watch.conn.dispose(), 15_000);
				closed = true;
				await within("the server to stop", stop(), 90_000);
				await within("the server to start again", server.start(durable), 90_000);
				await machineIs("online");
				const ended = await until(
					`turn ${number} to end after the restart`,
					async () => {
						const snapshot = await snapshotOf(client, uid, main.id, token).catch(() => null);
						const end = snapshot?.timeline.find(item => item.turn === number && item.kind === "turn.ended");
						return end && snapshot ? { end, timeline: snapshot.timeline } : null;
					},
					120_000,
				);
				const seqs = eventSeqs(ended.timeline, number);
				const notes = ended.timeline
					.filter(item => item.turn === number && item.kind === "platform")
					.map(item => (item as { text?: string }).text ?? "");
				return {
					number,
					end: ended.end,
					seqs,
					notes,
					newEngines: runner.engineStarts - starts,
					resets: (runner.served.get(main.id)?.resets.length ?? 0) - resets,
				};
			} finally {
				if (!closed) await within("the watcher of the turn to close", watch.conn.dispose(), 15_000);
			}
		};
		/** The engine events of an ordinary turn, as the timeline keeps them: what a turn taken up must show, each once. */
		const baseline = async () => {
			const { ended } = await turn(main.id, "Write the primes");
			return eventSeqs((await snapshotOf(client, uid, main.id, token)).timeline, ended.turn);
		};

		await check(
			"a server killed mid-turn on a machine comes back within the grace, and the same engine finishes the turn with each event once",
			async () => {
				await server.stop();
				await server.start(durable);
				await machineIs("online");
				const expected = await baseline();
				const taken = await acrossRestart(() => server.kill());
				assert(
					taken.end.kind === "turn.ended" && taken.end.outcome === "succeeded",
					`turn ${taken.number} ended ${taken.end.kind === "turn.ended" ? `${taken.end.outcome}: ${taken.end.message}` : "?"}`,
				);
				assert(taken.resets === 0, `the runner reset the conversation ${taken.resets} time(s)`);
				assert(taken.newEngines === 0, `${taken.newEngines} engine(s) started after the restart`);
				assert(
					new Set(taken.seqs).size === taken.seqs.length,
					`an engine event was taken twice: ${taken.seqs.join(",")}`,
				);
				assert(
					taken.seqs.join() === expected.join(),
					`events ${taken.seqs.join(",")} where an ordinary turn has ${expected.join(",")}`,
				);
				assert(!taken.notes.some(text => /cut short|resumed/i.test(text)), `notes: ${taken.notes.join(" | ")}`);
				assert(server.log().includes(`turn.take_up session=${main.id}`), "no take-up in the server's log");
				const { ended } = await turn(main.id, "Write the primes");
				assert(ended.outcome === "succeeded", `the next turn ended ${ended.outcome}: ${ended.message}`);
				return `turn ${taken.number}: ${taken.seqs.length} events once, no reset; the next turn succeeded`;
			},
		);

		await check(
			"a plan-paid machine turn killed with its server is taken up with its plan relay, handed its token again, and the relay closed only at its end",
			async () => {
				await server.stop();
				await server.start(durable);
				await machineIs("online");
				runner.paying = true;
				const paying = client.agentSession.get([uid, main.id], { params: { token } }) as unknown as {
					e2ePaying(paying: boolean): Promise<void>;
				};
				await paying.e2ePaying(true);
				try {
					// The session reads the report when its link is made: a sleep makes a new one.
					await forceSleep(main.id);
					const relays = runner.planRelays;
					const before = { ...relays };
					const first = await turn(main.id, "Write the primes");
					assert(
						first.ended.outcome === "succeeded",
						`the plan turn ended ${first.ended.outcome}: ${first.ended.message}`,
					);
					const expected = eventSeqs((await snapshotOf(client, uid, main.id, token)).timeline, first.ended.turn);
					assert(relays.opened === before.opened + 1, `${relays.opened - before.opened} plan relay(s) for one turn`);
					assert(relays.closed === before.closed + 1, "the ordinary plan turn's relay was not closed");
					assert(relays.limits.at(-1)! > 0, "the machine's plan relay was given no request limit");
					const opened = relays.opened;
					const ends = relays.ends.length;
					const taken = await acrossRestart(() => server.kill());
					assert(
						taken.end.kind === "turn.ended" && taken.end.outcome === "succeeded",
						`turn ${taken.number} ended ${taken.end.kind === "turn.ended" ? `${taken.end.outcome}: ${taken.end.message}` : "?"}`,
					);
					assert(taken.newEngines === 0, `${taken.newEngines} engine(s) started after the restart`);
					assert(taken.seqs.join() === expected.join(), `events ${taken.seqs.join(",")}, not ${expected.join(",")}`);
					assert(!taken.notes.some(text => /cut short|resumed/i.test(text)), `notes: ${taken.notes.join(" | ")}`);
					assert(relays.opened === opened + 1, `${relays.opened - opened} plan relay(s) opened for the taken-up turn`);
					assert(relays.tokens >= 1, "the taken-up turn's relay was not handed its token again");
					const [openEnd, ...handEnds] = relays.ends.slice(ends);
					assert(
						openEnd !== undefined && handEnds.length > 0 && handEnds.every(end => end > openEnd),
						"handing the taken-up turn's relay its token did not move its end on",
					);
					assert(relays.closed === before.closed + 2 && relays.leases.size === 0, "a plan relay was left open");
					assert(server.log().includes(`turn.take_up session=${main.id}`), "no take-up in the server's log");
					return `one relay, kept through the restart, handed ${relays.tokens} token(s), closed at the end`;
				} finally {
					runner.paying = false;
					await paying.e2ePaying(false);
					await forceSleep(main.id);
				}
			},
		);

		await check(
			"a graceful restart keeps a machine turn running when the runner says it keeps conversations, and the turn finishes with each event once",
			async () => {
				runner.fake.report.resumableConversation = true;
				runner.report();
				// The session reads the report when its link is made: a sleep makes a new one.
				await forceSleep(main.id);
				const expected = await baseline();
				const taken = await acrossRestart(() => server.stop());
				assert(
					taken.end.kind === "turn.ended" && taken.end.outcome === "succeeded",
					`turn ${taken.number} ended ${taken.end.kind === "turn.ended" ? `${taken.end.outcome}: ${taken.end.message}` : "?"}`,
				);
				assert(taken.resets === 0, `the runner reset the conversation ${taken.resets} time(s)`);
				assert(taken.newEngines === 0, `${taken.newEngines} engine(s) started after the restart`);
				assert(
					taken.seqs.join() === expected.join(),
					`events ${taken.seqs.join(",")} where an ordinary turn has ${expected.join(",")}`,
				);
				assert(server.log().includes(`turn.kept session=${main.id}`), "the sleep did not keep the turn");
				return `turn ${taken.number} kept through SIGTERM: ${taken.seqs.length} events once`;
			},
		);
		delete runner.fake.report.resumableConversation;
		runner.report();

		await check(
			"a graceful restart keeps a plan-paid machine turn and its plan relay, which the next server hands a token again",
			async () => {
				runner.fake.report.resumableConversation = true;
				runner.paying = true;
				runner.report();
				const paying = client.agentSession.get([uid, main.id], { params: { token } }) as unknown as {
					e2ePaying(paying: boolean): Promise<void>;
				};
				await paying.e2ePaying(true);
				try {
					await forceSleep(main.id);
					const relays = runner.planRelays;
					const before = { ...relays };
					const taken = await acrossRestart(() => server.stop());
					assert(
						taken.end.kind === "turn.ended" && taken.end.outcome === "succeeded",
						`turn ${taken.number} ended ${taken.end.kind === "turn.ended" ? `${taken.end.outcome}: ${taken.end.message}` : "?"}`,
					);
					assert(taken.newEngines === 0, `${taken.newEngines} engine(s) started after the restart`);
					assert(server.log().includes(`turn.kept session=${main.id}`), "the turn was not kept through SIGTERM");
					assert(relays.opened === before.opened + 1, `${relays.opened - before.opened} plan relay(s) for one turn`);
					assert(relays.tokens > before.tokens, "the next server did not hand the relay its token again");
					assert(relays.closed === before.closed + 1 && relays.leases.size === 0, "the relay was not closed once");
					return `turn ${taken.number} kept with its relay through SIGTERM`;
				} finally {
					runner.paying = false;
					runner.report();
					await paying.e2ePaying(false);
					await forceSleep(main.id);
				}
			},
		);

		await check(
			"a machine turn whose runner let the conversation go before the server came back ends cleanly, and the next turn works",
			async () => {
				await server.stop();
				await server.start(durable);
				await machineIs("online");
				const takeUps = server.log().split("turn.take_up session=" + main.id).length;
				const watch = new Watch(client, uid, main.id, token);
				let number = 0;
				try {
					({ turn: number } = await watch.conn.prompt({ text: "Write the primes (slow)" }));
					await until("the turn's engine to stream", () => watch.windlass(number) >= 3);
					const session = client.agentSession.get([uid, main.id], { params: { token } }) as unknown as {
						e2eCheckpoint(): Promise<number | null>;
					};
					await until("the turn's checkpoint to be stored", async () => (await session.e2eCheckpoint()) === number);
					await within("the watcher of the turn to close", watch.conn.dispose(), 15_000);
				} catch (error) {
					await watch.conn.dispose().catch(() => undefined);
					throw error;
				}
				await within("the server to stop", server.kill(), 90_000);
				// What the runner does when its grace runs out: the conversation and what it ran go (the orphan rule).
				runner.expireGrace(main.id);
				await within("the server to start again", server.start(durable), 90_000);
				await machineIs("online");
				const end = await until(
					`turn ${number} to end`,
					async () =>
						(await snapshotOf(client, uid, main.id, token).catch(() => null))?.timeline.find(
							item => item.turn === number && item.kind === "turn.ended",
						),
					120_000,
				);
				assert(
					end.kind === "turn.ended" && end.outcome !== "succeeded",
					`the turn ${end.kind === "turn.ended" ? end.outcome : "?"}`,
				);
				assert(
					server.log().split("turn.take_up session=" + main.id).length === takeUps + 1,
					"the restarted server did not try to take the turn up",
				);
				// Back to the default for the checks that follow; the next turn leaves the session awake, as they expect.
				await server.stop();
				await server.start({ ...github.env(), WLP_ITEMS: "1" });
				await machineIs("online");
				const { ended } = await turn(main.id, "Write the primes");
				assert(ended.outcome === "succeeded", `the next turn ended ${ended.outcome}: ${ended.message}`);
				return `turn ${number} ${end.kind === "turn.ended" ? `${end.outcome}: ${String(end.message).split("\n")[0]}` : ""}; next turn succeeded`;
			},
		);

		// A machine that goes away mid-turn (WLP_TURN_RESUME): past the grace (WLP_TEST_RUNNER_GRACE_MS, short here) the turn
		// pauses instead of ending, takes what is sent meanwhile as held, and resumes by itself when the runner is back.
		const resumeEnv = { ...github.env(), WLP_ITEMS: "1", WLP_TURN_RESUME: "1", WLP_TEST_RUNNER_GRACE_MS: "3000" };
		const pausedItemEnv = {
			...durable,
			WLP_TURN_RESUME: "1",
			WLP_TEST_PAUSED_ITEM: "1",
			WLP_TURN_HEARTBEAT_MS: "600000",
		};
		let pausedItemServer = false;
		const preparePausedItem = async () => {
			if (!pausedItemServer) {
				await server.stop();
				await server.start(pausedItemEnv);
				pausedItemServer = true;
			}
			await machineIs("online");
		};
		const startPausedItem = (title: string, body: string) => {
			const repo = [...github.repositories.values()].find(r => r.name === "harbor")!;
			return user.createItem({
				mode: "single",
				title,
				body,
				repository: { id: repo.id },
				profile: "docker-hardened",
				place,
				start: true,
			});
		};
		for (const scenario of [
			"restart offline",
			"second restart and missed hello",
			"expired runner and missing agent conversation",
		]) {
			await check(`paused item turn resumes after ${scenario}`, async () => {
				await preparePausedItem();
				const body = "Write the primes for the paused work item (slow).";
				const item = await startPausedItem("Recover the checks", body);
				const id = item.sessionId;
				const session = client.agentSession.get([uid, id], { params: { token } });
				try {
					await until("the item's first turn to produce output", async () =>
						(await session.snapshot()).timeline.some(i => i.turn === 1 && i.kind === "windlass"),
					);
					await server.stop();
					await runner.setOffline(true);
					assert(
						server.log().includes(`turn.paused session=${id} turn=1 reason=restart`),
						"the deploy did not pause the running turn",
					);
					await server.start(pausedItemEnv);
					await until("the item to learn about its offline machine", async () =>
						(await user.item(item.id)).wait?.sentence.startsWith("Paused:"),
					);
					if (scenario === "second restart and missed hello") {
						await server.stop();
						await server.start({ ...pausedItemEnv, WLP_TEST_LOST_RESUME_WAKE: "1" });
						pausedItemServer = false;
					}
					const conn = session.connect();
					try {
						await until(
							"the replacement server to see the machine pause",
							async () => (await conn.snapshot()).summary.paused?.reason === "machine",
						);
						if (scenario === "second restart and missed hello") {
							// Keep the session awake after its offline startup check. The item's
							// two-second due check must recover it without either session wake.
							await (conn as unknown as { e2eAgePause(): Promise<void> }).e2eAgePause();
						}
						const before = enginePrompts.length;
						if (scenario === "expired runner and missing agent conversation") {
							runner.expireGrace(id);
							runner.missingSessions.add(id);
						}
						await runner.setOffline(false);
						await machineIs("online");
						const ended = await until(
							"the resumed item turn to end",
							async () => (await conn.snapshot()).timeline.find(i => i.turn === 1 && i.kind === "turn.ended"),
							60_000,
						);
						assert(ended.kind === "turn.ended" && ended.outcome === "succeeded", JSON.stringify(ended));
						const notes = (await conn.snapshot()).timeline.filter(
							i => i.turn === 1 && i.kind === "platform" && i.code === "turn_resumed",
						);
						assert(notes.length === 1, "expected exactly one resumed segment");
						if (scenario === "second restart and missed hello")
							assert(
								server.log().includes(`turn.pause_check session=${id} turn=1`),
								"the item timer never checked the stale pause",
							);
						const given = enginePrompts.slice(before)[0] ?? "";
						assert(
							scenario === "expired runner and missing agent conversation"
								? given.includes(body)
								: given.includes("Your machine was switched off"),
							given,
						);
						await until("the item to receive the resume and completion", async () => {
							const view = await user.item(item.id);
							return view.spent.turns >= 1 && view.events.some(event => event.said.includes("the turn resumed"));
						});
						return "one resume of turn 1, its prompt and completion received";
					} finally {
						await conn.dispose();
					}
				} finally {
					runner.missingSessions.delete(id);
					if (runner.offline) await runner.setOffline(false);
					await user.actOnItem({ id: item.id, action: { kind: "cancel" } }).catch(() => undefined);
				}
			});
		}

		await check("a restored item process lost during the runner grace recovers its whole task", async () => {
			await preparePausedItem();
			runner.fake.report.resumableConversation = true;
			runner.report();
			const machine = client.machine.get([uid, place.machineId], { params: serviceParams() });
			await until(
				"runner conversation retention",
				async () => (await machine.internalFacts()).report?.resumableConversation,
			);
			const body = "Check the saved work after losing the old process (slow).";
			const item = await startPausedItem("Recover the process", body);
			const id = item.sessionId;
			const session = client.agentSession.get([uid, id], { params: { token } });
			try {
				await until(
					"a checkpoint for the item's process",
					async () => (await (session as unknown as { e2eCheckpoint(): Promise<number | null> }).e2eCheckpoint()) === 1,
				);
				await server.stop();
				assert(server.log().includes(`turn.kept session=${id} turn=1`), "the turn had no retained process");
				await runner.setOffline(true);
				runner.expireGrace(id);
				runner.missingSessions.add(id);
				const before = enginePrompts.length;
				await server.start(pausedItemEnv);
				await until("the replacement server to take up the saved process", () =>
					server.log().includes(`turn.take_up session=${id} turn=1`),
				);
				await runner.setOffline(false);
				const end = await until(
					"the item to recover the lost process",
					async () => (await session.snapshot()).timeline.find(i => i.turn === 1 && i.kind === "turn.ended"),
					60_000,
				);
				assert(
					end.kind === "turn.ended" &&
						end.outcome === "succeeded" &&
						enginePrompts.slice(before).some(prompt => prompt.includes(body)),
					JSON.stringify(end),
				);
				await until("the item to receive its completed turn", async () => (await user.item(item.id)).spent.turns >= 1);
				return "lost checkpoint process replaced, whole task delivered, item advanced";
			} finally {
				delete runner.fake.report.resumableConversation;
				runner.missingSessions.delete(id);
				if (runner.offline) await runner.setOffline(false);
				runner.report();
				await user.actOnItem({ id: item.id, action: { kind: "cancel" } }).catch(() => undefined);
			}
		});

		await check(
			"a machine that goes away mid-turn pauses the turn past the grace, holds what is sent, and resumes it when the machine is back",
			async () => {
				await server.stop();
				await server.start(resumeEnv);
				await machineIs("online");
				const watch = new Watch(client, uid, main.id, token);
				let number = 0;
				try {
					({ turn: number } = await watch.conn.prompt({ text: "Write the primes (slow)" }));
					await until("the turn's engine to stream", () => watch.windlass(number) >= 3);
				} finally {
					await within("the watcher of the turn to close", watch.conn.dispose(), 15_000);
				}
				const prompts = enginePrompts.length;
				await runner.setOffline(true);
				const away = Date.now();
				const paused = await until(
					"the turn to pause for its machine",
					async () => {
						const snapshot = await snapshotOf(client, uid, main.id, token).catch(() => null);
						return snapshot?.summary.status === "paused" && snapshot.summary.paused?.reason === "machine"
							? snapshot
							: null;
					},
					90_000,
				);
				assert(!paused.timeline.some(item => item.turn === number && item.kind === "turn.ended"), "the turn ended");
				assert(
					paused.timeline.some(
						item =>
							item.turn === number &&
							item.kind === "platform" &&
							item.code === "turn_paused" &&
							/went offline, so this turn is paused/.test(item.text),
					),
					"no line says the turn is paused",
				);
				assert(
					server.log().includes(`turn.paused session=${main.id} turn=${number} reason=machine`),
					"the server did not log the pause",
				);
				const session = client.agentSession.get([uid, main.id], { params: { token } });
				const held = await session.prompt({ text: "Then print them in reverse." });
				assert(held.turn === number && held.steered === true, `the message was answered ${JSON.stringify(held)}`);
				const holding = await snapshotOf(client, uid, main.id, token);
				assert(
					holding.summary.paused?.held === 1 &&
						holding.timeline.some(item => item.kind === "user" && item.held === true && item.turn === number),
					`summary: ${JSON.stringify(holding.summary.paused)}`,
				);
				await sleep(5_000);
				await runner.setOffline(false);
				await machineIs("online");
				const back = Date.now();
				// Nothing asks the session anything: the machine wakes it when its runner says hello.
				const ended = await until(
					`turn ${number} to end after the machine came back`,
					async () => {
						const snapshot = await snapshotOf(client, uid, main.id, token).catch(() => null);
						const end = snapshot?.timeline.find(item => item.turn === number && item.kind === "turn.ended");
						return end && end.kind === "turn.ended" && snapshot ? { end, timeline: snapshot.timeline } : null;
					},
					120_000,
				);
				assert(ended.end.outcome === "succeeded", `the turn ended ${ended.end.outcome}: ${ended.end.message}`);
				const resumed = ended.timeline.find(
					item => item.turn === number && item.kind === "platform" && item.code === "turn_resumed",
				);
				assert(
					resumed?.kind === "platform" && resumed.text.startsWith("Resumed after the machine came back (offline "),
					`the resume says: ${resumed?.kind === "platform" ? resumed.text : "nothing"}`,
				);
				assert(
					ended.timeline.filter(item => item.turn === number && item.kind === "turn.ended").length === 1,
					"more than one turn.ended",
				);
				const given = enginePrompts.slice(prompts);
				assert(
					given.some(
						text => text.includes("Your machine was switched off") && text.includes("Then print them in reverse."),
					),
					`the engine was given: ${given.join(" | ").slice(0, 300)}`,
				);
				// The time the machine was away is not the turn's: its duration leaves it out.
				const first = ended.timeline.find(item => item.turn === number && item.kind === "user")!;
				// The grace (3 s here) is still the turn's: it waited for the machine then. What came after it is not.
				const wall = ended.end.at - first.at;
				assert(
					ended.end.durationMs <= wall - (back - away - 3_000) + 1_000,
					`the turn's duration ${ended.end.durationMs} ms of ${wall} ms counts the ${back - away} ms its machine was away`,
				);
				assert(
					!server
						.log()
						.split("\n")
						.some(line => line.includes(`turn.paused session=${main.id}`) && line.includes("reason=restart")),
					"the pause was taken for a restart",
				);
				const next = await turn(main.id, "Write the primes");
				assert(next.ended.outcome === "succeeded", `the next turn ended ${next.ended.outcome}: ${next.ended.message}`);
				return `paused ${Math.round((back - away) / 1000)} s with 1 message held; ${resumed.text}`;
			},
		);

		await check(
			"a turn paused for its machine is stopped at once by Stop, and does not resume when the machine is back",
			async () => {
				const watch = new Watch(client, uid, main.id, token);
				let number = 0;
				try {
					({ turn: number } = await watch.conn.prompt({ text: "Write the primes (slow)" }));
					await until("the turn's engine to stream", () => watch.windlass(number) >= 3);
				} finally {
					await within("the watcher of the turn to close", watch.conn.dispose(), 15_000);
				}
				await runner.setOffline(true);
				await until(
					"the turn to pause for its machine",
					async () => (await snapshotOf(client, uid, main.id, token).catch(() => null))?.summary.status === "paused",
					90_000,
				);
				await client.agentSession.get([uid, main.id], { params: { token } }).stop();
				const stopped = await snapshotOf(client, uid, main.id, token);
				const end = stopped.timeline.find(item => item.turn === number && item.kind === "turn.ended");
				assert(
					end?.kind === "turn.ended" && end.outcome === "stopped" && stopped.summary.status === "idle",
					`after Stop: ${stopped.summary.status}, ${JSON.stringify(end)}`,
				);
				const resumes = server.log().split(`turn.resumed session=${main.id}`).length;
				await runner.setOffline(false);
				await machineIs("online");
				await sleep(5_000);
				assert(server.log().split(`turn.resumed session=${main.id}`).length === resumes, "the stopped turn resumed");
				// Back to the default for the checks that follow.
				await server.stop();
				await server.start({ ...github.env(), WLP_ITEMS: "1" });
				await machineIs("online");
				const { ended } = await turn(main.id, "Write the primes");
				assert(ended.outcome === "succeeded", `the next turn ended ${ended.outcome}: ${ended.message}`);
				return "stopped at once; no resume when the machine came back";
			},
		);

		await check(
			"a machine session put to sleep with its sandbox running is not suspended through a runner its sleep refuses, and its next prompt runs",
			async () => {
				const lines = (what: string) =>
					server
						.log()
						.split("\n")
						.filter(line => line.includes(what) && line.includes(`session=${main.id}`)).length;
				const before = { slow: lines("sandbox.suspend_slow"), skipped: lines("sandbox.suspend_skipped") };
				assert(boxesOf(main.id)[0]?.state === "running", `the sandbox is ${boxesOf(main.id)[0]?.state}`);
				await forceSleep(main.id);
				// The sleep says one or the other: skipped at once, or slow after the suspend's wait (SUSPEND_WAIT_MS).
				await until(
					"the sleep to say what it did with the sandbox",
					() => lines("sandbox.suspend_skipped") > before.skipped || lines("sandbox.suspend_slow") > before.slow,
					20_000,
				);
				assert(
					lines("sandbox.suspend_slow") === before.slow,
					"the sleep asked the runner to suspend, and waited for a socket it refused",
				);
				const { ended } = await turn(main.id, "Write the primes");
				assert(ended.outcome === "succeeded", `the next turn ended ${ended.outcome}: ${ended.message}`);
				return `sandbox left to the runner's idle rule (${boxesOf(main.id)[0]?.state}); the next turn succeeded`;
			},
		);

		await check(
			"the runner restarting mid-turn ends that turn, and the next turn stops what it left and works",
			async () => {
				const watch = new Watch(client, uid, main.id, token);
				let first: Extract<TimelineItem, { kind: "turn.ended" }>;
				try {
					const { turn: number } = await watch.conn.prompt({ text: "Write the primes (slow)" });
					await until("the turn's first events", () => watch.windlass(number) >= 3);
					await runner.restartProcess();
					first = await watch.untilEnded(number);
				} finally {
					await watch.conn.dispose();
				}
				assert(first.outcome !== "succeeded", "the cut turn succeeded");
				const left = runner.leftovers;
				const { ended } = await turn(main.id, "Write the primes");
				assert(ended.outcome === "succeeded", `next turn ended ${ended.outcome}: ${ended.message}`);
				assert(runner.leftovers === left + 1, `${runner.leftovers - left} leftover engines stopped`);
				return `cut turn ${first.outcome}: ${first.message?.split("\n")[0]}`;
			},
		);

		await check(
			"create in a conversation that is lost, before any report, is asked again and makes no second sandbox",
			async () => {
				const fresh = await newSession();
				const creates = runner.creates;
				runner.loseCreates = 1;
				const { ended } = await turn(fresh.id, "Write the primes");
				assert(ended.outcome === "succeeded", `ended ${ended.outcome}: ${ended.message}`);
				assert(boxesOf(fresh.id).length === 1, `${boxesOf(fresh.id).length} sandboxes for the session`);
				assert(runner.creates === creates + 2, `${runner.creates - creates} creates reached the runner`);
				return "two creates, one sandbox: the runner answered the repeat with the one it had made";
			},
		);

		await check("delete removes all reported sandboxes of a session that lost both create replies", async () => {
			const doomed = await newSession();
			runner.loseCreates = 2;
			const { ended } = await turn(doomed.id, "Write the primes");
			const [orphan] = boxesOf(doomed.id);
			assert(ended.outcome === "error" && orphan && runner.loseCreates === 0, "both creates should lose their replies");
			assert(
				(await snapshotOf(client, uid, doomed.id, token)).summary.sandbox === "none",
				"the session saved its sandbox",
			);
			const otherId = `${place.machineId}-${randomBytes(6).toString("hex")}`;
			runner.boxes.set(otherId, { ...orphan, id: otherId });
			runner.report();
			await until("both unrecorded sandboxes in the machine's report", async () =>
				(await user.machines()).some(m => m.sandboxes.filter(s => s.sessionId === doomed.id).length === 2),
			);
			await runner.setOffline(true);
			try {
				await machineIs("offline");
				await user.deleteSession(doomed.id);
				assert(boxesOf(doomed.id).length === 2, "the offline runner acted on a removal");
			} finally {
				await runner.setOffline(false);
			}
			await until("both reported sandboxes to be removed", () => boxesOf(doomed.id).length === 0, 5_000);
			assert(boxesOf(main.id).length === 1, "the main session lost its sandbox");
			return "both removed on reconnect, the other session's sandbox kept";
		});

		await check(
			"a delete whose machine cannot record the sandbox's removal is refused and keeps the session; once the machine answers it goes through",
			async () => {
				const doomed = await newSession();
				const { ended } = await turn(doomed.id, "Write the primes");
				assert(
					ended.outcome === "succeeded" && boxesOf(doomed.id).length === 1,
					`ended ${ended.outcome}, ${boxesOf(doomed.id).length} sandboxes`,
				);
				writeFileSync(server.refusal, "");
				let code: unknown;
				try {
					code = await user.deleteSession(doomed.id).then(
						() => "resolved",
						error => (error as { code?: unknown }).code,
					);
					assert(
						code === "machine_unreachable",
						`the delete ${code === "resolved" ? "went through with nothing recorded to remove its sandbox" : `failed with ${String(code)}`}`,
					);
					assert(
						(await user.listSessions()).some(s => s.id === doomed.id),
						"the session left the list",
					);
				} finally {
					rmSync(server.refusal, { force: true });
				}
				await user.deleteSession(doomed.id);
				assert(!(await user.listSessions()).some(s => s.id === doomed.id), "the second delete left the session listed");
				await until("the machine's runner to remove the sandbox", () => boxesOf(doomed.id).length === 0, 15_000);
				return `refused with ${String(code)}, still listed; the second delete removed it and its sandbox`;
			},
		);

		await check("a stopped turn cancels the command running on the machine", async () => {
			const cloning = await newSession("https://example.com/org/slow-clone.git");
			const cancels = runner.cancels.length;
			const watch = new Watch(client, uid, cloning.id, token);
			try {
				const { turn: number } = await watch.conn.prompt({ text: "Write the primes" });
				await until("the clone to run on the machine", () =>
					[...runner.served.values()].some(served => served.runs.size > 0),
				);
				await watch.conn.stop();
				const ended = await watch.untilEnded(number);
				assert(runner.cancels.length === cancels + 1, "the runner was not told to cancel the clone");
				assert(ended.outcome === "interrupted", `ended ${ended.outcome}: ${ended.message}`);
			} finally {
				await watch.conn.dispose();
			}
			return "cancel reached the runner; the turn ended interrupted";
		});

		await check("a used ticket, a wrong signature and a hello for another machine are refused", async () => {
			const used = runner.usedTickets.filter(t => t.sessionId === main.id).at(-1);
			assert(used, "no ticket was used");
			const signed = (ticket: string, machineId = runner.id.machineId, key = runner.fake) =>
				key.sign(sessionProof(uid, main.id, machineId, ticket));
			// Without a socket, so that a hello would be taken if it were good.
			runner.served.get(main.id)?.ws?.close();
			await sleep(300);
			assert(
				!(await welcomed(client, uid, main.id, {
					machineId: runner.id.machineId,
					ticket: used.ticket,
					signature: signed(used.ticket),
				})),
				"a used ticket was taken",
			);
			runner.attachMode = "hold";
			const watch = new Watch(client, uid, main.id, token);
			try {
				await watch.conn.prompt({ text: "Write the primes" });
				const first = await until("a held ticket", () => runner.held.shift());
				const stranger = new FakeRunner();
				assert(
					!(await welcomed(client, uid, main.id, {
						machineId: runner.id.machineId,
						ticket: first.ticket,
						signature: signed(first.ticket, runner.id.machineId, stranger),
					})),
					"a wrong signature was taken",
				);
				assert(
					!(await welcomed(client, uid, main.id, {
						machineId: runner.id.machineId,
						ticket: first.ticket,
						signature: signed(first.ticket),
					})),
					"a ticket shown once with a wrong signature was taken after",
				);
			} finally {
				await watch.conn.dispose();
			}
			await until(
				"the waiting turn to give up",
				async () => (await snapshotOf(client, uid, main.id, token)).summary.status === "idle",
				30_000,
			);
			const watch2 = new Watch(client, uid, main.id, token);
			try {
				await watch2.conn.prompt({ text: "Write the primes" });
				const second = await until("a held ticket", () => runner.held.shift());
				const other = `m_${randomBytes(8).toString("hex")}`;
				assert(
					!(await welcomed(client, uid, main.id, {
						machineId: other,
						ticket: second.ticket,
						signature: signed(second.ticket, other),
					})),
					"a hello for another machine was taken",
				);
			} finally {
				await watch2.conn.dispose();
			}
			runner.attachMode = "serve";
			await until(
				"the waiting turn to give up",
				async () => (await snapshotOf(client, uid, main.id, token)).summary.status === "idle",
				30_000,
			);
			const { ended } = await turn(main.id, "Write the primes");
			assert(ended.outcome === "succeeded", `a turn after them ended ${ended.outcome}: ${ended.message}`);
			return "each refused; the genuine runner is served after them";
		});

		await check(
			`a machine that is offline is refused at once, one that does not answer within ${OFFLINE_WAIT_MS / 1000} s, and the session stays readable`,
			async () => {
				await runner.setOffline(true);
				let off: Awaited<ReturnType<typeof turn>>;
				let changes: unknown[];
				try {
					await machineIs("offline");
					off = await turn(main.id, "Write the primes");
					assert(
						off.ended.outcome === "error" && /is offline/.test(off.ended.message ?? ""),
						`ended ${off.ended.outcome}: ${off.ended.message}`,
					);
					assert(off.ms < 5_000, `with the machine's actor saying offline it took ${off.ms} ms`);
					const snapshot = await snapshotOf(client, uid, main.id, token);
					assert(
						snapshot.machine?.state === "offline" && snapshot.timeline.length > 0,
						`snapshot: ${JSON.stringify(snapshot.machine)}`,
					);
					changes = await client.agentSession.get([uid, main.id], { params: { token } }).changes();
				} finally {
					await runner.setOffline(false);
					await machineIs("online");
				}
				// Online, but its runner never opens the socket.
				runner.attachMode = "ignore";
				let silent: Awaited<ReturnType<typeof turn>>;
				try {
					silent = await turn(main.id, "Write the primes");
					// The failed turn has the session look at its sandbox's state, which waits for a socket the same way: let that run out too.
					await sleep(OFFLINE_WAIT_MS + 2_000);
				} finally {
					runner.attachMode = "serve";
				}
				assert(
					silent.ended.outcome === "error" && /is offline/.test(silent.ended.message ?? ""),
					`ended ${silent.ended.outcome}: ${silent.ended.message}`,
				);
				assert(silent.ms >= OFFLINE_WAIT_MS - 1_000 && silent.ms < OFFLINE_WAIT_MS + 10_000, `took ${silent.ms} ms`);
				return `machine offline: ${off.ms} ms, "${off.ended.message}"; snapshot and ${changes.length} changes read; no hello: ${silent.ms} ms`;
			},
		);

		await check(
			"a machine removed during a turn ends that turn at once, later prompts get the removed sentence, and the session stays readable",
			async () => {
				const watch = new Watch(client, uid, main.id, token);
				let ms = 0;
				let pushedMs = 0;
				let first: Extract<TimelineItem, { kind: "turn.ended" }>;
				try {
					const { turn: number } = await watch.conn.prompt({ text: "Write the primes (slow)" });
					await until("the turn's first events", () => watch.windlass(number) >= 3);
					const removedAt = Date.now();
					await user.removeMachine({ machineId: runner.id.machineId, removeSandboxes: false });
					first = await watch.untilEnded(number);
					ms = Date.now() - removedAt;
					// The open page is told, not only a page opened afterwards.
					const told = await until(
						"the open session to be told the machine was removed",
						() => watch.machines.find(m => m.state === "removed"),
						5_000,
					);
					pushedMs = told.at - removedAt;
					assert(pushedMs < 2_000, `told ${pushedMs} ms after the removal`);
				} finally {
					await watch.conn.dispose();
				}
				assert(first.outcome !== "succeeded" && ms < 10_000, `ended ${first.outcome} after ${ms} ms: ${first.message}`);
				// Platform diagnostics can follow the reason on a separate line.
				const reason = first.message?.split("\n")[0];
				assert(
					reason === "This agent's machine was removed. Its files were there. Start a new agent to go on.",
					`removed mid-turn: ${reason}`,
				);
				const next = await turn(main.id, "Write the primes");
				assert(
					next.ended.outcome === "error" && /was removed/.test(next.ended.message ?? ""),
					`next turn ended ${next.ended.outcome}: ${next.ended.message}`,
				);
				const snapshot = await snapshotOf(client, uid, main.id, token);
				assert(
					snapshot.machine?.state === "removed" && snapshot.timeline.length > 0,
					`snapshot: ${JSON.stringify(snapshot.machine)}`,
				);
				return `the running turn ended ${ms} ms after the removal (${reason}), the open page told in ${pushedMs} ms; the next refused in ${next.ms} ms`;
			},
		);

		await check("deleting a session whose machine actor is gone succeeds", async () => {
			const machine = client.machine.get([uid, place.machineId], { params: serviceParams() });
			const { isActorGone } = await import("../server/src/actors/internal.js");
			await (machine as unknown as { e2eDestroy(): Promise<void> }).e2eDestroy();
			await until("the machine actor to disappear", () => machine.internalFacts().then(() => false, isActorGone));
			await user.deleteSession(main.id);
			assert(!(await user.listSessions()).some(s => s.id === main.id), "the session is still listed");
			return "the session with a saved sandbox id left the list";
		});
	} catch (error) {
		failed += 1;
		console.log(`FAIL  setting up  -- ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		runner.offline = true;
		runner.control?.ws.close();
		for (const served of runner.served.values()) served.ws?.close();
		await server.stop();
		await github.stop();
		if (failed === 0) rmSync(server.storage, { recursive: true, force: true });
		else console.log(`\nserver log and state kept in ${server.storage}`);
	}
}

/** Puts a session's actor to sleep through the engine's control plane, as e2e.ts does. */
async function forceSleep(sessionId: string): Promise<void> {
	const plane = (path: string, method = "GET") =>
		fetch(`${ENDPOINT}${path}`, {
			method,
			headers: { Authorization: "Bearer default", "Content-Type": "application/json" },
			body: method === "GET" ? undefined : "{}",
		});
	const list = (await (await plane("/actors?namespace=default&name=agentSession")).json()) as {
		actors: Array<{ actor_id: string; key: string }>;
	};
	const record = list.actors.find(entry => entry.key.includes(sessionId));
	assert(record, "the control plane does not list the session's actor");
	const slept = await plane(`/actors/${record.actor_id}/sleep?namespace=default`, "POST");
	assert(slept.ok, `the control plane refused the sleep: ${slept.status} ${await slept.text()}`);
}

function snapshotOf(client: Client, uid: string, id: string, token: string): Promise<SessionSnapshot> {
	return client.agentSession.get([uid, id], { params: { token } }).snapshot();
}

if (process.argv[2] === "node") await serverNode();
else if (process.argv[2] === "egress") {
	const server = new Server();
	try {
		const { sessionEgress } = await import("./runner-session-egress.js");
		await sessionEgress(server.storage, ORIGIN, ENDPOINT, env =>
			server.start({
				...env,
				WLP_REQUIRE_SIGNED_RUNNER: "1",
				WLP_PLATFORM_KEY: certify(generateKeyPairSync("ed25519").privateKey, 1, Date.now() + 86_400_000),
			}),
		);
	} finally {
		await server.stop();
		rmSync(server.storage, { recursive: true, force: true });
	}
	process.exit(0);
} else {
	await main();
	process.exit(failed === 0 ? 0 : 1);
}
