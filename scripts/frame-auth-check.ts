/** Run from server with ../scripts/locked.sh frame-auth-check.ts [case number]. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { ServerChannel, RunnerChannel, type ChannelSocket } from "../server/src/runner/channel.js";
import { controlProof, parseRunnerFrame, parseServerFrame, sessionProof } from "../server/src/runner/control.js";
import { OLD_RUNNER } from "../server/src/runner/protocol.js";
import {
	certify,
	machineStatement,
	platformWelcome,
	readPlatformKey,
	runnerHandshake,
	signRemoval,
	verifyRemoval,
	retentionRequest,
	signRetention,
	verifyRetention,
	type Trust,
} from "../server/src/runner/frame-auth.js";
import { stub, until } from "./runner-stub-server.js";
import { FakeAcpAgent } from "./acp-agent-fake.js";
import type { Executor } from "../runner/src/docker-executor.js";

const directory = mkdtempSync(join(tmpdir(), "frame-auth-"));
process.env.WLP_RUNNER_STATE_DIR = directory;
process.env.WLP_SECRET = randomBytes(32).toString("hex");
Object.assign(globalThis, { SANDBOX_IMAGE: "fixture", SHOTS_IMAGE_PIN: "" });
const { control, pair } = await import("../runner/src/control.js");
const state = await import("../runner/src/state.js");
const root = generateKeyPairSync("ed25519").privateKey;
const machine = generateKeyPairSync("ed25519");
const spki = machine.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const untilExpiry = Date.now() + 86_400_000;
const bundle = certify(root, 1, untilExpiry);
const identity = readPlatformKey(bundle);
const who = { machineId: "m_0123456789abcdef", uid: "u_fixture", sessionId: "s_fixture" };
const signMachine = (message: string) => sign(null, Buffer.from(message), machine.privateKey).toString("base64url");
const endpoint = "https://fixture.invalid";
function trust(): Trust {
	const pin = { endpoint, platformRoot: identity.root, maxSerial: 0 };
	return {
		pin,
		commit(maxSerial, endpoint) {
			Object.assign(pin, { maxSerial, endpoint });
		},
	};
}
const selected = process.argv[2];
let failed = 0;
async function check(n: number, title: string, fn: () => void | Promise<void>) {
	if (selected && selected !== String(n)) return;
	try {
		await fn();
		console.log(`PASS ${n} ${title}`);
	} catch (error) {
		failed++;
		// Assertion operands may be handshake frames. Only print test-authored explanations.
		console.error(
			`FAIL ${n} ${title}: ${error instanceof assert.AssertionError && error.generatedMessage ? "assertion failed" : error instanceof Error ? error.message.split("\n")[0] : "error"}`,
		);
	}
}
function audit() {
	return readdirSync(directory)
		.filter(name => name.startsWith("audit-"))
		.map(name => readFileSync(join(directory, name), "utf8"))
		.join("");
}

async function controlChecks() {
	// A loopback IP SAN keeps the same trusted TLS address for both platform identities.
	// The private CA is scoped to this test process. Host DNS and the system trust store stay untouched.
	const ca = join(directory, "ca.pem"),
		key = join(directory, "tls.pem");
	const openssl = spawnSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"1",
			"-subj",
			"/CN=frame-check",
			"-addext",
			"subjectAltName=IP:127.0.0.1",
			"-keyout",
			key,
			"-out",
			ca,
		],
		{ stdio: "ignore" },
	);
	assert.equal(openssl.status, 0, "local TLS fixture generation failed");
	const previous = getCACertificates("default");
	setDefaultCACertificates([...previous, readFileSync(ca, "utf8")]);
	const srv = await stub(join(directory, "rivet"), { cert: readFileSync(ca), key: readFileSync(key) });
	srv.setIdentity(identity);
	const approved = await pair(srv.platform, AbortSignal.timeout(45_000), () => {}, "Auth fixture");
	assert.ok(approved.paired, "TLS pairing failed");
	const paired = approved.paired;
	const pin = state.pairingTrust(paired);
	let welcomes = 0,
		effects = 0;
	const owner = {
		identity: paired.current,
		serial: async (fn: () => Promise<void>) => fn(),
		checkAuthenticatedNetwork: async () => {},
		platformGitHost: () => {},
		platformStoreCaps: () => {},
		storeLimits: () => ({ machine: 10e9, user: 2e9, free: 40e9 }),
		welcome: async () => {
			welcomes++;
		},
		maintainSpares: async () => {},
		stopSpares: () => {},
		create: () => {
			effects++;
		},
		requestedRemoval: () => {
			effects++;
		},
		prune: () => {
			effects++;
		},
		report: () => ({
			kind: "report",
			docker: { ok: true },
			commandSandbox: { ok: true },
			freeDiskBytes: null,
			sandboxes: [],
		}),
	} as unknown as Executor;
	async function attempt(run: (statuses: string[]) => Promise<void>) {
		const stop = new AbortController(),
			statuses: string[] = [];
		const loop = control(
			owner,
			paired.key,
			paired.platform,
			stop.signal,
			s => statuses.push(s),
			undefined,
			"Auth fixture",
			pin,
		);
		try {
			await run(statuses);
		} finally {
			stop.abort();
			await loop;
			await until(() => !srv.online(), "fixture socket still open");
		}
	}
	try {
		await check(1, "same TLS origin, untrusted online certificate", async () => {
			const other = generateKeyPairSync("ed25519").privateKey;
			srv.setIdentity(readPlatformKey(certify(other, 1, untilExpiry)));
			const before = welcomes;
			await attempt(async status => {
				await until(
					() => status.some(s => s.includes("certificate") || s === "Online"),
					"no platform verification result",
				);
				assert.equal(welcomes, before, "runner dispatched an untrusted welcome");
				assert.equal(effects, 0);
			});
		});
		await check(2, "unsigned control create drops the socket before dispatch", async () => {
			srv.setIdentity(identity);
			await attempt(async status => {
				await until(() => status.includes("Online"), "genuine control handshake failed");
				const start = audit().length;
				srv.unsignedCreate();
				await until(() => !srv.online(), "bad frame did not close control");
				assert.ok(audit().slice(start).includes("frame_auth_failed mac"), "missing MAC failure audit");
				assert.equal(effects, 0);
			});
		});
		await check(5, "persist serial 2 and reject serial 1", async () => {
			srv.setIdentity(readPlatformKey(certify(root, 2, untilExpiry)));
			await attempt(async status => {
				await until(() => status.includes("Online"), "serial 2 did not connect");
			});
			assert.equal(state.loadPair()?.pin?.maxSerial, 2, "serial 2 was not persisted");
			srv.setIdentity(identity);
			await attempt(async status => {
				await until(
					() => status.some(s => s.includes("frame_auth_failed serial") || s === "Online"),
					"no serial decision",
				);
				assert.ok(!status.includes("Online"), "lower serial reached Online");
			});
		});
		await check(6, "gateway move needs offline authorization and a verified welcome", async () => {
			const prior = "https://127.0.0.1:1";
			const baseline = { ...pin.pin, endpoint: prior };
			const saved = state.storePair(paired.current, paired.key, paired.platform, undefined, baseline);
			const moving = state.pairingTrust(saved);
			Object.assign(pin, moving);
			srv.setIdentity(readPlatformKey(certify(root, 3, untilExpiry)));
			await attempt(async status => {
				await until(
					() => status.some(s => s.includes("gateway address changed") || s === "Online"),
					"no gateway decision",
				);
				assert.ok(!status.includes("Online"), "unsigned endpoint change reached Online");
				assert.equal(state.loadPair()?.pin?.endpoint, prior);
			});
			srv.setIdentity(readPlatformKey(certify(root, 3, untilExpiry, srv.advertised)));
			await attempt(async status => {
				await until(() => status.includes("Online"), "root-authorized move did not connect");
			});
			assert.equal(state.loadPair()?.pin?.endpoint, srv.advertised, "gateway move was not persisted");
		});
	} finally {
		await srv.close();
		setDefaultCACertificates(previous);
	}
}

// A deterministic duplex transport. Bytes wait until the test delivers them.
class Wire implements ChannelSocket {
	out: string[] = [];
	closed = false;
	receive: (data: unknown) => void = () => {};
	gone = () => {};
	send(text: string) {
		this.out.push(text);
	}
	close() {
		if (!this.closed) {
			this.closed = true;
			this.gone();
		}
	}
	onMessage(fn: typeof this.receive) {
		this.receive = fn;
	}
	onClose(fn: typeof this.gone) {
		this.gone = fn;
	}
}
const { AttachTickets } = await import("../server/src/machines/ticket.js");
function channels(secure = true) {
	const tickets = new AttachTickets(),
		pin = trust();
	const input: string[] = [];
	const replies: string[] = [];
	let processId = "";
	const acp = new FakeAcpAgent(line => runner.output(processId, 1, line), directory);
	let ops = 0;
	const server = new ServerChannel({
		platform: secure ? { ...who, identity } : undefined,
		accept: hello => tickets.admits(hello, { ...who, publicKey: spki }),
	});
	const runner = new RunnerChannel({
		onOperation(op) {
			ops++;
			if (op.name === "create") runner.respond(op, op.args.mirrorRepo ?? "plain");
			if (op.name === "start") {
				processId = op.id;
				runner.respond(op, null);
			}
		},
		onInput(_id, line) {
			input.push(line);
			acp.input(line);
		},
		onCloseIn() {},
		onCancel() {},
		onDrain() {},
		onRefused() {},
	});
	function connect() {
		const s = new Wire(),
			r = new Wire(),
			ticket = tickets.issue();
		server.attach(s);
		runner.attach(
			r,
			{
				machineId: who.machineId,
				runnerVersion: "0.2.0",
				ticket,
				signature: signMachine(sessionProof(who.uid, who.sessionId, who.machineId, ticket)),
			},
			secure ? { ...who, machine: machine.privateKey, trust: pin, endpoint } : undefined,
		);
		s.receive(r.out.shift()!);
		r.receive(s.out.shift()!);
		assert.ok(server.connected && runner.connected, "session handshake failed");
		return { s, r };
	}
	return {
		server,
		runner,
		input,
		replies,
		connect,
		ops: () => ops,
		close() {
			server.close();
			runner.close();
			acp.stop();
		},
	};
}
const inputLine = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n';
async function sessionCheck(
	fn: (
		c: ReturnType<typeof channels>,
		wire: ReturnType<ReturnType<typeof channels>["connect"]>,
		id: string,
		first: string,
	) => void,
) {
	const c = channels();
	try {
		const wire = c.connect();
		const proc = c.server.start({ id: "box", tag: "fixture", argv: ["fake-acp"] }, (_fd, line) => c.replies.push(line));
		const first = wire.s.out.shift()!;
		wire.r.receive(first);
		wire.s.receive(wire.r.out.shift()!);
		fn(c, wire, proc.id, first);
	} finally {
		c.close();
	}
}
async function sessions() {
	await check(3, "modified session stdin is rejected before ACP input", () =>
		sessionCheck((c, { s, r }, id) => {
			c.server.write(id, inputLine);
			const text = s.out.shift()!;
			r.receive(text.replace("initialize", "initializf"));
			assert.deepEqual(c.input, [], "modified bytes reached the fake ACP process");
			assert.ok(r.closed, "bad tag did not drop session");
		}),
	);
	await check(4, "same-socket and cross-socket replays are rejected", () =>
		sessionCheck((c, { s, r }, id, first) => {
			c.server.write(id, inputLine);
			const text = s.out.shift()!;
			r.receive(text);
			r.receive(text);
			assert.ok(r.closed, "duplicate counter did not close session");
			s.close();
			const next = c.connect();
			// Replay the original counter-zero wire bytes against a socket expecting zero.
			next.r.receive(first);
			assert.ok(next.r.closed, "old MAC accepted by new socket");
			assert.equal(c.input.length, 1);
		}),
	);
	await check(7, "resume re-MACs outstanding stdin and delivers it exactly once", () =>
		sessionCheck((c, { s, r }, id) => {
			function rpc(method: string, params: object, requestId: number) {
				const line = JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n";
				c.server.write(id, line);
				r.receive(s.out.shift()!);
				while (r.out.length) s.receive(r.out.shift()!);
			}
			rpc("session/new", {}, 1);
			const sid = JSON.parse(c.replies[0]!).result.sessionId;
			rpc("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "ask" }] }, 2);
			const question = c.replies.map(line => JSON.parse(line)).find(m => m.method === "session/request_permission");
			assert.ok(question, "fake ACP turn did not reach its permission request");
			const answer =
				JSON.stringify({
					jsonrpc: "2.0",
					id: question.id,
					result: { outcome: { outcome: "selected", optionId: "allow-once" } },
				}) + "\n";
			c.server.write(id, answer);
			const original = JSON.parse(s.out.shift()!);
			s.close();
			r.close();
			const next = c.connect();
			const resent = next.s.out.shift()!;
			assert.equal(JSON.parse(resent).seq, original.seq);
			assert.ok(original.mac && original.mac !== JSON.parse(resent).mac, "backlog has no fresh socket MAC");
			next.r.receive(resent);
			while (next.r.out.length) next.s.receive(next.r.out.shift()!);
			assert.equal(c.input.filter(line => line === answer).length, 1);
			const results = c.replies.map(line => JSON.parse(line)).filter(m => m.id === 2);
			assert.equal(results.length, 1);
			assert.equal(results[0].result.stopReason, "end_turn");
			assert.equal(c.ops(), 1, "start repeated on resume");
		}),
	);
}

async function oldRunner() {
	await check(8, "old hello returns the update sentence and publishes the Machines warning", async () => {
		process.env.WLP_MACHINES = "1";
		process.env.WLP_REQUIRE_SIGNED_RUNNER = "1";
		process.env.WLP_PLATFORM_KEY = bundle;
		const { machine: actor, machineTables } = await import("../server/src/actors/machine.js");
		// Other checks can have loaded config when machines were off. Set this test actor's mode explicitly.
		const { config } = await import("../server/src/config.js");
		config.machines = { runnerImage: null, publicUrl: endpoint, identity };
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(":memory:");
		const raw = {
			execute: async (q: string, ...params: (string | number | null)[]) => db.prepare(q).all(...params),
		} as Parameters<typeof machineTables>[0];
		await machineTables(raw);
		db.prepare("INSERT INTO machine (id,name,version,public_key,created) VALUES (1,'fixture','0.1.0',?,0)").run(spki);
		const frames: Record<string, unknown>[] = [],
			warnings: { kind: string }[] = [];
		const listeners: Record<string, (event: { data: string }) => Promise<void>> = {};
		const ws = {
			OPEN: 1,
			readyState: 1,
			send: (s: string) => frames.push(JSON.parse(s)),
			close() {
				this.readyState = 3;
			},
			addEventListener: (key: string, fn: (typeof listeners)[string]) => {
				listeners[key] = fn;
			},
		};
		const c = {
			request: new Request("https://fixture.invalid/websocket/control"),
			key: [who.uid, who.machineId],
			db: raw,
			vars: { work: Promise.resolve(), live: null, greeting: null },
			client: () => ({
				user: {
					get: () => ({
						internalMachineChanged: (_: string, facts: { warnings: typeof warnings }) =>
							warnings.push(...facts.warnings),
					}),
				},
			}),
		};
		const accept = actor.config.onWebSocket!;
		try {
			accept(c as unknown as Parameters<typeof accept>[0], ws as unknown as Parameters<typeof accept>[1]);
			const challenge = frames.shift()!;
			await listeners.message({
				data: JSON.stringify({
					kind: "hello",
					epoch: "fixture-epoch",
					runnerVersion: "0.1.0",
					time: Date.now(),
					signature: signMachine(controlProof(who.uid, who.machineId, String(challenge.nonce))),
				}),
			});
			assert.equal(frames[0]?.message, OLD_RUNNER, "old runner was not told to update");
			assert.ok(
				warnings.some(w => w.kind === "outdated"),
				"missing Machines update warning",
			);
		} finally {
			await listeners.close({ data: "" });
			db.close();
		}
	});
}
async function startup() {
	await check(9, "startup rejects a missing, malformed or expired WLP_PLATFORM_KEY", () => {
		const probe =
			'const {config}=await import("./src/config.ts"); const {startupProblem}=await import("./src/startup.ts"); const p=startupProblem(config); if(p) { console.error(p); process.exitCode=1; }';
		for (const key of ["", "malformed", certify(root, 1, Date.now() - 1)]) {
			const env = {
				...process.env,
				WLP_SANDBOX: "fake",
				WLP_MACHINES: "1",
				WLP_REQUIRE_SIGNED_RUNNER: "1",
				WLP_PLATFORM_KEY: key,
			};
			const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
				env,
				encoding: "utf8",
			});
			assert.equal(child.status, 1, "invalid platform key allowed startup");
			assert.match(child.stderr, /WLP_PLATFORM_KEY/);
			const boot = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
				env,
				encoding: "utf8",
				timeout: 30_000,
			});
			assert.equal(boot.status, 1);
			assert.match(boot.stderr, /WLP_PLATFORM_KEY/);
			const off = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
				env: { ...env, WLP_REQUIRE_SIGNED_RUNNER: "0" },
				encoding: "utf8",
			});
			assert.equal(off.status, 0, "disabled deployment required a key");
		}
	});
}
async function loopbackHandshake(secure: boolean) {
	// Measure only TCP connect through verified control welcome. Use the same loopback
	// transport in both modes. Gateway discovery and TLS are outside this measurement.
	const server = createServer(socket => {
		const ctx = { uid: who.uid, machineId: who.machineId, challenge: randomBytes(32).toString("base64url") };
		socket.write(JSON.stringify({ kind: "challenge", nonce: ctx.challenge }) + "\n");
		createInterface({ input: socket }).once("line", line => {
			const hello = JSON.parse(line);
			const proof = secure ? machineStatement(ctx, hello) : controlProof(ctx.uid, ctx.machineId, ctx.challenge);
			assert.ok(verify(null, Buffer.from(proof), machine.publicKey, Buffer.from(hello.signature, "base64url")));
			const welcome = { kind: "welcome", idleSuspendMs: 60_000 };
			socket.end(JSON.stringify(secure ? platformWelcome(ctx, hello, welcome, identity).welcome : welcome) + "\n");
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const samples: number[] = [];
	try {
		for (let i = 0; i < 21; i++) {
			const start = performance.now();
			const socket: Socket = createConnection((server.address() as AddressInfo).port, "127.0.0.1");
			let exchange: ReturnType<typeof runnerHandshake> | undefined;
			for await (const line of createInterface({ input: socket })) {
				const frame = JSON.parse(line);
				if (frame.kind === "challenge") {
					const ctx = { uid: who.uid, machineId: who.machineId, challenge: frame.nonce };
					const base = { kind: "hello", epoch: "fixture-epoch", runnerVersion: "0.2.0", time: Date.now() };
					exchange = secure ? runnerHandshake(ctx, base, machine.privateKey) : undefined;
					socket.write(
						JSON.stringify(
							exchange?.hello ?? {
								...base,
								signature: signMachine(controlProof(ctx.uid, ctx.machineId, ctx.challenge)),
							},
						) + "\n",
					);
				} else {
					exchange?.finish(frame, trust(), endpoint);
					if (i) samples.push(performance.now() - start);
				}
			}
		}
	} finally {
		await new Promise<void>(done => server.close(() => done()));
	}
	assert.equal(samples.length, 20);
	samples.sort((a, b) => a - b);
	return (samples[9]! + samples[10]!) / 2;
}
async function benchmark() {
	const legacy = await loopbackHandshake(false),
		signed = await loopbackHandshake(true);
	const ctx = { ...who, challenge: "fixture", ticket: "fixture" };
	const hello = runnerHandshake(ctx, { kind: "hello" }, machine.privateKey);
	const reply = platformWelcome(ctx, hello.hello, { kind: "welcome" }, identity);
	const rx = hello.finish(reply.welcome, trust(), endpoint);
	const frame = { kind: "msg", seq: 1, ack: 0, body: { kind: "in", id: "fixture", data: inputLine } };
	const raw = JSON.stringify(frame);
	let bytes = 0;
	const baseline = process.cpuUsage();
	for (let i = 0; i < 1000; i++) JSON.parse(JSON.stringify(frame));
	const base = process.cpuUsage(baseline);
	const start = process.cpuUsage();
	for (let i = 0; i < 1000; i++) {
		const text = reply.auth.seal(frame);
		bytes += Buffer.byteLength(text) - Buffer.byteLength(raw);
		rx.open(text, 131072);
	}
	const cpu = process.cpuUsage(start);
	console.log(
		`BENCH loopback TCP control handshake median/20: v1 ${legacy.toFixed(3)} ms, v2 ${signed.toFixed(3)} ms, added ${(signed - legacy).toFixed(3)} ms. 1000 frames: ${bytes} additional bytes, ${((cpu.user + cpu.system - base.user - base.system) / 1000).toFixed(3)} additional CPU ms (seal + open).`,
	);
}
try {
	if (!selected || ["1", "2", "5", "6"].includes(selected)) await controlChecks();
	await sessions();
	await oldRunner();
	await startup();
	await check(
		12,
		"retention answer requires the paired root, request nonce, generation list and current serial",
		() => {
			const request = retentionRequest(who.uid, who.machineId, Date.now(), "fixture-nonce");
			const answer = signRetention(request, ["f".repeat(64)], identity);
			const pin = trust();
			assert.throws(() => verifyRetention(request + "x", answer, pin), /signature/);
			assert.throws(() => verifyRetention(request, { ...answer, generations: [] }, pin), /signature/);
			const other = readPlatformKey(certify(generateKeyPairSync("ed25519").privateKey, 1, untilExpiry));
			assert.throws(() => verifyRetention(request, signRetention(request, [], other), pin), /certificate/);
			verifyRetention(request, answer, pin);
			pin.pin.maxSerial++;
			assert.throws(() => verifyRetention(request, answer, pin), /serial/);
		},
	);
	await check(14, "ordinary mirror creation reaches the runner under both session protocols", async () => {
		for (const signed of [false, true]) {
			const c = channels(signed);
			try {
				const wire = c.connect();
				const reply = c.server.request("create", { profile: "docker-hardened", mirrorRepo: "123" });
				wire.r.receive(wire.s.out.shift()!);
				wire.s.receive(wire.r.out.shift()!);
				assert.equal(await reply, "123");
			} finally {
				c.close();
			}
		}
	});
	await check(13, "protocol 1 refuses prepared creation and saving before dispatch", async () => {
		const c = channels(false);
		try {
			const wire = c.connect();
			const key = { repo: "1", attempt: "a".repeat(32), inputs: "b".repeat(64), generation: "c".repeat(64) };
			const ops = [
				() =>
					c.server.request("create", {
						profile: "docker-hardened",
						prepared: { ...key, writer: true, privateData: false },
					}),
				() => c.server.request("saveSnapshot", { id: "box", source: { ...key, commit: "d".repeat(40), created: 1 } }),
			];
			for (const op of ops) {
				const rejected = assert.rejects(op, /authenticated session/);
				wire.r.receive(wire.s.out.shift()!);
				wire.s.receive(wire.r.out.shift()!);
				await rejected;
			}
			assert.equal(c.ops(), 0);
		} finally {
			c.close();
		}
	});
	await check(10, "offline removal binds machine, request nonce and pruning policy", () => {
		const pin = trust(),
			nonce = randomBytes(32).toString("base64url");
		const answer = signRemoval(who.uid, who.machineId, nonce, false, identity);
		assert.throws(() => verifyRemoval(who.uid, who.machineId, "different", answer, pin), /signature/);
		assert.throws(
			() => verifyRemoval(who.uid, who.machineId, nonce, { ...answer, removeSandboxes: true }, pin),
			/signature/,
		);
		assert.equal(pin.pin.maxSerial, 0);
		verifyRemoval(who.uid, who.machineId, nonce, answer, pin);
		assert.equal(pin.pin.maxSerial, 1);
	});
	await check(11, "directional keys, strict schemas, catalog/report/host and counter gaps", () => {
		const ctx = { uid: who.uid, machineId: who.machineId, challenge: randomBytes(32).toString("base64url") };
		const slots = {
			max: 3,
			unit: { cpus: 2, memoryBytes: 8 * 2 ** 30, pids: 1024 },
			reserve: { cpus: 1, memoryBytes: 4 * 2 ** 30 },
		};
		const runner = runnerHandshake(
			ctx,
			{ kind: "hello", epoch: "fixture-epoch", slots, runnerVersion: "0.2.0", time: Date.now() },
			machine.privateKey,
		);
		assert.deepEqual(parseRunnerFrame(JSON.stringify(runner.hello)), runner.hello);
		const server = platformWelcome(ctx, runner.hello, { kind: "welcome", idleSuspendMs: 60_000 }, identity);
		assert.throws(() => runner.finish({ ...server.welcome, ...{ idleSuspendMs: 0 } }, trust(), endpoint), /signature/);
		const rx = runner.finish(server.welcome, trust(), endpoint);
		const options = { models: [{ id: "one", name: "One", efforts: [] }], modes: [], defaultModel: "one", checkedAt: 1 };
		for (const frame of [
			{ kind: "catalog", id: "opencode", options },
			{ kind: "host", host: null },
			{
				kind: "report",
				slots,
				harnesses: [
					{ id: "claude", adapter: "fixture", image: "fixture", signIn: "token", loginGeneration: "a".repeat(32) },
				],
				docker: { ok: true },
				commandSandbox: { ok: true },
				sandboxes: [],
				freeDiskBytes: 0,
			},
		]) {
			const text = rx.seal(frame);
			const fields = JSON.parse(text);
			assert.throws(() => server.auth.open(JSON.stringify({ ...fields, unknown: "fixture" }), 131072), /mac/);
			assert.deepEqual(parseRunnerFrame(server.auth.open(text, 131072)), frame);
		}
		const text = server.auth.seal({ kind: "heartbeat" });
		const peer = runner.finish(server.welcome, trust(), endpoint);
		assert.throws(() => peer.open(peer.seal({ kind: "heartbeat" }), 131072), /mac/);
		assert.throws(() => rx.open(server.auth.seal({ kind: "heartbeat" }), 131072), /counter/);
		assert.equal(parseServerFrame(rx.open(text, 131072), true)?.kind, "heartbeat");
	});
	if (!selected || selected === "bench") await benchmark();
} finally {
	rmSync(directory, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
