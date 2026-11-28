/** cd server && npx tsx ../scripts/machine-check.ts */
import { loginHttp } from "./login-http.js";
import { optionsDigest } from "../server/src/runner/catalog.js";
import { localListeners } from "./check-listeners.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { MachineHostUpdate, MachineSummary } from "../server/src/contract.js";
import type { Registry } from "../server/src/client.js";
import {
	CONTROL_DEAD_MS,
	REFUSED_RETRY_MS,
	machineKeyFingerprint,
	parseConnection,
	RUNNER_PAIR_PATH,
} from "../server/src/runner/control.js";
import { FakeRunner, controlProxy, post } from "./runner-fake.js";

const refused = (p: Promise<unknown>, code: string) => assert.rejects(p, e => (e as { code?: string }).code === code);
async function eventually(test: () => boolean | Promise<boolean>, ms = 90_000) {
	const end = Date.now() + ms;
	while (!(await test())) {
		if (Date.now() >= end) throw new Error("Timed out");
		await wait(50);
	}
}

async function server() {
	// Observe real sleeps and wakes outside the actor; listing an offline machine must leave it asleep.
	const { machine } = await import("../server/src/actors/machine.js");
	// Model the raw transport seen on a silent link: a local close need not deliver a close event.
	const accept = machine.config.onWebSocket!;
	machine.config.onWebSocket = (c, ws) => {
		const close = ws.close.bind(ws);
		const listen = ws.addEventListener.bind(ws);
		let closedHere = false;
		ws.close = (code, reason) => {
			closedHere = true;
			close(code, reason);
		};
		ws.addEventListener = (type, listener) =>
			listen(type, event => {
				if (type !== "close" || !closedHere) return listener(event);
			});
		return accept(c, ws);
	};
	const create = machine.config.onCreate!;
	machine.config.onCreate = async (c, input) => {
		await create(c, input);
		if (input?.details.name === "Old machine fixture") {
			// Age a private test database. Fire the production schedule with no clock argument.
			await c.db.execute("UPDATE machine SET created = ?", Date.now() - 91 * 86_400_000);
			await c.schedule.after(15_000, "expire");
		}
	};
	// A report of 404 bytes free stands for the user actor being briefly away (its node restarting) when the machine publishes it.
	const { user } = await import("../server/src/actors/user.js");
	const userActions = user.config.actions!;
	for (const action of ["startClaudeLogin", "finishClaudeLogin", "cancelClaudeLogin"])
		assert.ok(!Object.hasOwn(userActions, action));
	assert.ok(!Object.hasOwn(machine.config.actions!, "internalClaudeLogin"));
	const changed = userActions.internalMachineChanged;
	userActions.internalMachineChanged = async (c, id, facts) => {
		if (facts?.report?.freeDiskBytes === 404) {
			process.send?.({ hook: "publish-refused", id });
			throw new Error("The user actor is away.");
		}
		return changed(c, id, facts);
	};
	const machineActions = machine.config.actions!;
	type MachineCtx = Parameters<typeof machineActions.internalRevoke>[0];
	Object.assign(machineActions, {
		e2eWaitingForHello: (c: MachineCtx) => c.vars.greeting !== null,
		// Advance the production alarm and its stored timestamp together in this private database.
		async e2eAgeKeyWarning(c: MachineCtx) {
			const alarm = (await c.schedule.list()).find(event => event.action === "expireKeyWarning");
			if (!alarm || alarm.runAt <= Date.now() + REFUSED_RETRY_MS) return false;
			await c.db.execute(
				"UPDATE machine SET duplicate = duplicate - ? WHERE duplicate IS NOT NULL",
				alarm.runAt - Date.now(),
			);
			await c.schedule.cancel(alarm.id);
			await c.schedule.after(50, alarm.action);
			return true;
		},
	});
	for (const hook of ["onWake", "onSleep"] as const) {
		const original = machine.config[hook]!;
		machine.config[hook] = async c => {
			await original(c);
			process.send?.({ hook, id: c.key[1] });
		};
	}
	await import("../server/src/index.js");
}

async function realRunner() {
	const [{ id, key }] = (await once(process, "message")) as [{ id: { uid: string; machineId: string }; key: Buffer }];
	process.disconnect();
	Object.assign(globalThis, { SANDBOX_IMAGE: "sha256:" + "0".repeat(64), SHOTS_IMAGE_PIN: "" });
	// The runner in this tree says its last release (runner/package.json) until the release commit raises it to the
	// platform's minimum: its hello says the release it will ship as.
	const { MIN_RUNNER_VERSION, versionAtLeast } = await import("../server/src/runner/control.js");
	const { VERSION } = await import(new URL("../runner/src/state.ts", import.meta.url).href);
	if (!versionAtLeast(VERSION, MIN_RUNNER_VERSION)) {
		const send = WebSocket.prototype.send;
		WebSocket.prototype.send = function (this: WebSocket, data: Parameters<WebSocket["send"]>[0]) {
			const frame = typeof data === "string" && data.includes('"hello"') ? JSON.parse(data) : null;
			return send.call(
				this,
				frame?.kind === "hello" ? JSON.stringify({ ...frame, runnerVersion: MIN_RUNNER_VERSION }) : data,
			);
		};
	}
	const { control } = await import(new URL("../runner/src/control.ts", import.meta.url).href);
	const { Executor } = await import(new URL("../runner/src/docker-executor.ts", import.meta.url).href);
	const { save } = await import(new URL("../runner/src/state.ts", import.meta.url).href);
	const owner = new Executor(id, { maxRunning: 1, maxSandboxes: 1 });
	// The connection's state in status.json, as runner/src/main.ts keeps it: the check reads "key-in-use" there.
	const saveStatus = (connection: string, idleSuspendMs?: number) =>
		save("status.json", { machineId: id.machineId, connection, idleSuspendMs: idleSuspendMs ?? null });
	await control(
		owner,
		createPrivateKey({ key, type: "pkcs8", format: "der" }),
		process.env.WLP_PUBLIC_URL!,
		new AbortController().signal,
		saveStatus,
		undefined,
		"Test machine",
		null,
	);
}

async function check() {
	const {
		engine: port,
		http: [http, peerPort],
	} = await localListeners(2);
	const endpoint = `http://127.0.0.1:${port}`;
	const origin = `http://127.0.0.1:${http}`;
	const peer = `http://127.0.0.1:${peerPort}`;
	const dir = await mkdtemp(join(tmpdir(), "wlp-machine-check-"));
	const secret = randomBytes(32).toString("hex");
	process.env.WLP_SECRET = secret;
	const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(WLP_|RIVET|E2B_|PORT$)/.test(k)));
	const env = {
		...cleanEnv,
		WLP_SECRET: secret,
		WLP_DEMO: "1",
		WLP_SANDBOX: "fake",
		RIVET_LOG_LEVEL: "silent",
		WLP_GITHUB_APP_ID: "1",
		WLP_GITHUB_APP_SLUG: "local",
		WLP_GITHUB_CLIENT_ID: "local",
		WLP_GITHUB_CLIENT_SECRET: secret,
		WLP_GITHUB_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 })
			.privateKey.export({ type: "pkcs8", format: "pem" })
			.toString(),
		WLP_GITHUB_API_URL: origin,
		WLP_GITHUB_URL: origin,
	};
	const nodes = new Set<ChildProcess>();
	const hooks: { hook: string; id: string }[] = [];
	async function start(http: number, enabled: boolean, second = false) {
		const node = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "node"], {
			cwd: fileURLToPath(new URL("../server/", import.meta.url)),
			stdio: ["ignore", "ignore", "ignore", "ipc"],
			env: {
				...env,
				WLP_MACHINES: enabled ? "1" : "0",
				WLP_HTTP_PORT: String(http),
				WLP_PUBLIC_URL: origin,
				RIVET_RUN_ENGINE_PORT: String(port),
				RIVETKIT_STORAGE_PATH: second ? join(dir, "node2") : dir,
				...(second
					? { NODE_ENV: "production", RIVET_ENDPOINT: endpoint, RIVET_TOKEN: "default", WLP_PUBLIC_ENDPOINT: endpoint }
					: {}),
			},
		});
		nodes.add(node);
		node.on("message", message => hooks.push(message as (typeof hooks)[number]));
		await eventually(async () => {
			if (node.exitCode !== null) throw new Error("Node exited");
			return (await fetch(`http://127.0.0.1:${http}/health`).catch(() => null))?.ok === true;
		}, 90_000);
		return node;
	}
	async function stop(node: ChildProcess) {
		node.kill("SIGTERM");
		const exited = () => node.exitCode !== null || node.signalCode !== null;
		try {
			await eventually(exited, 30_000);
		} catch {
			node.kill("SIGKILL");
			await eventually(exited);
		}
		nodes.delete(node);
	}
	let proxy: Awaited<ReturnType<typeof controlProxy>> | undefined;
	let stage = "starting a private local engine";
	const step = (name: string) => {
		console.log("ok   " + stage);
		stage = name;
	};
	try {
		const node = await start(http, true);
		const { createClient } = await import("../server/src/client.js");
		const { serviceParams } = await import("../server/src/auth.js");
		const { createGrant, grantIsValid, secretsActor } = await import("../server/src/actors/internal.js");
		const { issueTicket } = await import("../server/src/github/state.js");
		const client = createClient<Registry>({ endpoint, token: "default", namespace: "default" });
		async function account() {
			const auth = await loginHttp(origin).demo();
			return {
				uid: auth.profile.uid,
				user: client.user.getOrCreate([auth.profile.uid], { params: { token: auth.token } }),
			};
		}
		const accounts = await Promise.all([account(), account()]);
		const runner = new FakeRunner();
		runner.details.name = "0123456789ab";
		const wrong = new FakeRunner();
		step("pairing, racing claims, repeat confirmation and the account shown to the runner");
		const pair = await runner.pair(origin);
		assert.deepEqual(await runner.poll(origin, pair), { state: "waiting" });
		assert.deepEqual(await runner.poll(origin, { ...pair, pollSecret: randomBytes(32).toString("base64url") }), {
			state: "gone",
		});
		const code = { code: pair.code.toLowerCase().replace("-", " ") };
		await refused(accounts[0].user.confirmMachine({ ...code, keyConfirmed: true }), "pairing_not_found");
		const race = await Promise.allSettled(accounts.map(a => a.user.claimMachine(code)));
		assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
		const winner = race.findIndex(r => r.status === "fulfilled");
		assert.equal((race[1 - winner] as PromiseRejectedResult).reason.code, "pairing_not_found");
		const { uid, user } = accounts[winner];
		const other = accounts[1 - winner].user;
		await user.githubComplete(issueTicket(uid, { user: { id: 7, login: "machine-check" }, installations: [] }));
		// The machine key's fingerprint is worked out from the key that paired, and Connect needs the person to say it matches.
		const claimed = (race[winner] as PromiseFulfilledResult<Awaited<ReturnType<typeof user.claimMachine>>>).value;
		const printed = machineKeyFingerprint(runner.details.publicKey);
		assert.match(printed ?? "", /^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
		assert.equal(claimed.keyFingerprint, printed);
		// The fake runner reports the oldest version the platform takes, which prints the fingerprint.
		assert.equal(claimed.keyPrinted, true);
		assert.notEqual(machineKeyFingerprint(new FakeRunner().details.publicKey), printed);
		await refused(user.confirmMachine({ ...code } as Parameters<typeof user.confirmMachine>[0]), "key_not_confirmed");
		const [first, repeat] = await Promise.all([
			user.confirmMachine({ ...code, keyConfirmed: true }),
			user.confirmMachine({ ...code, keyConfirmed: true }),
		]);
		const machineId = first.machineId;
		const id = { uid, machineId };
		assert.deepEqual(first.profiles, []);
		assert.equal(first.status, "waiting");
		assert.equal(repeat.machineId, machineId);
		assert.deepEqual(await runner.poll(origin, pair), { state: "approved", ...id, githubLogin: "machine-check" });
		const sessionKey = [uid, "s_0123456789abcdef"];
		const grant = createGrant("agentSession", sessionKey);
		assert(grantIsValid(grant, sessionKey, "agentSession"));

		const warn = console.warn;
		try {
			const rejects = (grant: string, key: string[], kind: string) => {
				let lines = 0;
				console.warn = (...args: unknown[]) => {
					lines++;
					assert(
						args.length === 1 && args[0] === `[wlp] actor.create_refused kind=${kind} keyParts=${key.length}`,
						"the refusal must log only kind and key shape",
					);
				};
				assert(!grantIsValid(grant, key, kind), "a creation grant crossed its binding");
				assert.equal(lines, 1, "one warning per refused grant");
			};
			for (const kind of ["machine", "machinePairing", "workItem"]) rejects(grant, sessionKey, kind);
			rejects(grant, [uid, "s_another"], "agentSession");
			const machineGrant = createGrant("machine", [uid, machineId]);
			rejects(machineGrant, [uid, machineId], "agentSession");
			rejects(machineGrant, [`machine:${uid}`, machineId], "agentSession");
		} finally {
			console.warn = warn;
		}
		console.log("ok   session creation grant, kind isolation and one redacted refusal");
		await refused(other.confirmMachine({ ...code, keyConfirmed: true }), "pairing_not_found");
		await refused(other.setMachineSecrets({ machineId, send: false }), "machine_not_found");
		await refused(
			other.createSession({ profile: "docker-hardened", place: { kind: "machine", machineId } }),
			"machine_not_found",
		);
		// Paired, but its runner has not reported yet: told so, not that the sandbox does not exist.
		await assert.rejects(user.createSession({ profile: "docker-hardened", place: { kind: "machine", machineId } }), {
			code: "machine_not_connected",
			message: /Linux arm64 machine \(012345\)/,
		});
		assert.equal((await user.setMachineSecrets({ machineId, send: false }))[0].sendSecrets, false);
		const service = () => client.machine.get([uid, machineId], { params: serviceParams() });
		const row = async () => (await user.machines()).find(r => r.machineId === machineId)!;
		const observer = user.connect();
		const events: MachineSummary[][] = [];
		const samples: MachineHostUpdate[] = [];
		observer.on("machineHost", update => samples.push(update as MachineHostUpdate));
		observer.on("machines", rows => events.push(rows as MachineSummary[]));
		await observer.me();
		step("wrong and replayed proofs, foreign origin, runner version and signed clock correction");
		const skew = await runner.connection(origin, id, Date.now() - 90_000);
		assert.equal(skew.status, 403);
		const clock = await skew.json();
		assert.equal(clock.reason, "clock");
		const conn = parseConnection(await (await runner.connection(origin, id, clock.serverTime)).json());
		assert(conn);
		const bad = await wrong.connect(conn, id);
		await eventually(() => bad.frames.some(f => f.kind === "refused" && f.reason === "unknown"));
		// The last release before the plan relay is told to update, with the version it needs.
		const old = await runner.connect(conn, id, { version: "0.3.12" });
		await eventually(() =>
			old.frames.some(
				f =>
					f.kind === "refused" &&
					f.reason === "outdated" &&
					f.message ===
						"This runner is 0.3.12. Update your runner to 0.3.13 or later with the command on the Machines page.",
			),
		);
		await eventually(async () => (await row()).warnings.some(w => w.kind === "outdated"));
		assert.equal((await row()).runnerVersion, "0.3.12");
		await assert.rejects(user.createSession({ profile: "docker-hardened", place: { kind: "machine", machineId } }), {
			code: "runner_outdated",
			message: /^Update your runner on “Linux arm64 machine \(012345\)” to 0\.3\.13 or later/,
		});
		const replay = await runner.connect(conn, id, { signature: old.proof() });
		await eventually(() => replay.frames.some(f => f.kind === "refused" && f.reason === "unknown"));
		const foreign = new WebSocket(old.ws.url, {
			headers: { Origin: "https://foreign.invalid" },
		} as unknown as string[]);
		let challenged = false;
		foreign.onmessage = () => {
			challenged = true;
		};
		await eventually(() => foreign.readyState === 3);
		assert(!challenged);
		step("same-process reconnect, a refused second runner, reports and opaque attach");
		proxy = await controlProxy(port);
		const loginSocket = await runner.connect({ ...conn, endpoint: proxy.endpoint }, id);
		await eventually(() =>
			events.some(rows => rows.some(r => r.status === "online" && r.freeDiskBytes === runner.report.freeDiskBytes)),
		);
		loginSocket.send({ ...runner.report, name: "F892B469D6C5" });
		await eventually(async () => (await row()).name === "F892B469D6C5");
		const renamedProfiles = (await row()).profiles;
		assert.deepEqual(
			renamedProfiles.map(p => p.name),
			["Strict", "Open"],
		);
		assert(renamedProfiles.every(p => p.details?.includes('your machine "Linux arm64 machine (f892b4)"')));
		assert.equal((await service().internalFacts()).name, "Linux arm64 machine (f892b4)");
		loginSocket.send({ ...runner.report, freeDiskBytes: 123 });
		await eventually(async () => (await row()).freeDiskBytes === 123);
		assert.equal((await row()).name, "F892B469D6C5");
		loginSocket.send({ ...runner.report, name: "Workshop" });
		await eventually(async () => (await row()).name === "Workshop");
		const harness = { id: "claude", adapter: "fixture", image: "fixture", signIn: "none" } as const;
		// Exercise the actual gateway and action transport with more than 256 KiB.
		const models = Array.from({ length: 1000 }, (_, i) => ({
			id: "provider/model-" + i,
			name: "Model " + i + "x".repeat(256),
			efforts: [],
		}));
		const options = { models, defaultModel: models[0]!.id, modes: [], checkedAt: 1000 };
		const catalogDigest = optionsDigest(options);
		runner.report.slots = {
			max: 2,
			unit: { cpus: 1, memoryBytes: 1.5 * 2 ** 30, pids: 512 },
			reserve: { cpus: 0, memoryBytes: 0 },
		};
		const host = { cpus: 2, sandboxCpus: 1, memoryBytes: 12e9, memoryFreeBytes: 4e9, load1: 1 };
		loginSocket.send({ kind: "catalog", id: "claude", options });
		loginSocket.send({
			...runner.report,
			host,
			harnesses: [{ ...harness, optionsDigest: catalogDigest, optionsCheckedAt: options.checkedAt }],
		});
		await eventually(() => events.at(-1)?.some(r => r.harnesses?.[0]?.optionsDigest === catalogDigest) === true);
		assert.equal((await row()).harnesses?.[0]?.options, undefined);
		assert.deepEqual(await user.machineCatalog({ machineId, id: "claude", digest: catalogDigest }), options);
		assert.deepEqual((await row()).slots, { ...runner.report.slots, busy: 0, queued: 0 });
		const beforeSample = events.length;
		// An older runner sends inline options even when only its load changes.
		loginSocket.send({ ...runner.report, host: { ...host, load1: 2 }, harnesses: [{ ...harness, options }] });
		await eventually(() => samples.some(sample => sample.machineId === machineId && sample.host?.load1 === 2));
		assert.equal(events.length, beforeSample);
		assert.equal((await row()).host?.load1, 2);
		loginSocket.send({ kind: "host", host: { ...host, load1: 3 } });
		await eventually(() => samples.at(-1)?.host?.load1 === 3);
		assert.equal(events.length, beforeSample);
		loginSocket.send({
			...runner.report,
			harnesses: [{ ...harness, optionsDigest: catalogDigest, optionsCheckedAt: 2000 }],
		});
		await eventually(async () => (await row()).harnesses?.[0]?.optionsCheckedAt === 2000);
		assert.equal((await user.machineCatalog({ machineId, id: "claude", digest: catalogDigest }))?.checkedAt, 2000);
		loginSocket.send({ ...runner.report, harnesses: [harness] });
		await eventually(async () => (await row()).harnesses?.[0]?.signIn === "none");
		loginSocket.send({ ...runner.report, claudeLogin: true, harnesses: [harness] });
		await eventually(async () => (await service().internalFacts()).report?.claudeLogin === true);
		const listed = await row();
		assert.deepEqual(
			listed.profiles.map(p => p.id),
			["docker-windlass-sandbox", "docker-hardened"],
		);
		assert(listed.profiles.every(p => p.available && p.details?.includes('your machine "Workshop"')));
		const launched = await user.createSession({ profile: "docker-hardened", place: { kind: "machine", machineId } });
		await user.saveAccountSecret({
			name: "EXAMPLE_SETTING",
			value: "fixture value",
			scope: "setup",
			profile: "docker-hardened",
		});
		const readSecrets = () =>
			secretsActor({ client: () => client }, uid, launched.id).internalSessionSecrets(launched.id);
		assert.equal((await readSecrets()).account?.secrets.length, 0);
		await user.setMachineSecrets({ machineId, send: true });
		assert.deepEqual(
			(await readSecrets()).account?.secrets.map(s => s.name),
			["EXAMPLE_SETTING"],
		);
		proxy.drop();
		const back = await runner.connect(conn, id, { version: "1.0.0" });
		await eventually(() => back.frames.some(f => f.kind === "welcome"));
		proxy.close();
		proxy = undefined;
		assert(!(await row()).warnings.some(w => w.kind === "key"));
		const duplicate = await runner.connect(conn, id, { epoch: randomUUID() });
		await eventually(() => duplicate.frames.some(f => f.kind === "refused" && f.reason === "key-in-use"));
		await eventually(async () => (await row()).warnings.some(w => w.kind === "key"));
		assert.equal(back.ws.readyState, 1);
		step("the duplicate-key warning clears after its retry window while the original runner stays online");
		const fixture = () =>
			service() as unknown as { e2eAgeKeyWarning(): Promise<boolean>; e2eWaitingForHello(): Promise<boolean> };
		assert(await fixture().e2eAgeKeyWarning(), "no warning expiry after the refused runner's retry");
		await eventually(async () => {
			const machine = await row();
			return machine.status === "online" && !machine.warnings.some(w => w.kind === "key");
		});
		const ticket = randomUUID();
		const attached = await service().internalAttach({ sessionId: "s_deleted", ticket });
		const expectedKey = createPublicKey(runner.key).export({ type: "spki", format: "der" }).toString("base64");
		assert(attached.ok && (await service().internalFacts()).publicKey === expectedKey);
		await eventually(() => back.frames.some(f => f.kind === "attach" && f.ticket === ticket));
		const fresh = randomUUID();
		assert((await service().internalAttach({ sessionId: "s_deleted", ticket: fresh })).ok);
		await eventually(() => back.frames.some(f => f.kind === "attach" && f.ticket === fresh));
		step("the user actor briefly away keeps the control socket; sockets that never say hello go, one at a time");
		back.send({ ...runner.report, freeDiskBytes: 404 });
		await eventually(() => hooks.some(h => h.hook === "publish-refused" && h.id === machineId));
		assert.equal(back.ws.readyState, 1);
		back.send({ ...runner.report, freeDiskBytes: 405 });
		await eventually(async () => (await row()).freeDiskBytes === 405);
		const silent = async () => {
			const ws: WebSocket = await createClient<Registry>({
				endpoint: conn.endpoint!,
				namespace: conn.namespace,
				token: conn.token?.token ?? "default",
				disableMetadataLookup: true,
			})
				.machine.get([uid, machineId])
				.webSocket("control");
			await eventually(() => ws.readyState === 1);
			return ws;
		};
		const codes: number[] = [];
		const quiet = await silent();
		quiet.addEventListener("close", e => codes.push(e.code));
		const opened = Date.now();
		const quieter = await silent();
		quieter.addEventListener("close", e => codes.push(e.code));
		await eventually(() => quiet.readyState === 3);
		await eventually(() => quieter.readyState === 3);
		const lasted = Date.now() - opened;
		assert(lasted >= 8000, `a silent control socket lasted ${lasted} ms`);
		// Neither close is a refusal (1008), which a runner would answer by dropping its sessions and waiting ten minutes.
		await eventually(() => codes.length === 2);
		assert.deepEqual(codes, [1001, 1001], `silent control sockets were closed with ${codes.join(", ")}`);
		assert.equal(back.ws.readyState, 1);
		assert.equal(await fixture().e2eWaitingForHello(), false, "the actor kept the expired greeting");
		step("a silent control socket marks the machine offline on the person's list by its deadline");
		proxy = await controlProxy(port);
		const quietLink = await runner.connect({ ...conn, endpoint: proxy.endpoint }, id);
		await eventually(() => quietLink.frames.some(f => f.kind === "welcome"));
		await eventually(async () => (await row()).freeDiskBytes === runner.report.freeDiskBytes);
		const since = events.length;
		proxy.drop();
		await eventually(
			async () =>
				events.slice(since).some(rows => rows.some(r => r.machineId === machineId && r.status === "offline")) &&
				(await row()).status === "offline",
			CONTROL_DEAD_MS + 60_000,
		);
		proxy.close();
		proxy = undefined;
		step("list reads leaving the actor asleep, a second node and queued removal");
		const actorId = await service().resolve();
		const sleeps = () => hooks.filter(h => h.id === machineId && h.hook === "onSleep").length;
		const before = sleeps();
		assert(
			(
				await fetch(endpoint + "/actors/" + actorId + "/sleep?namespace=default", {
					method: "POST",
					headers: { authorization: "Bearer default", "content-type": "application/json" },
					body: "{}",
				})
			).ok,
		);
		await eventually(() => sleeps() > before);
		const wakes = () => hooks.filter(h => h.id === machineId && h.hook === "onWake").length;
		const asleep = wakes();
		for (let i = 0; i < 3; i++) assert.equal((await row()).status, "offline");
		assert.equal(wakes(), asleep);
		await service().internalRemoveSandbox({ sandboxId: "deleted-sandbox" });
		// A deleted session's copy on the machine (machine-backups.ts): told once the runner reports it keeps copies.
		await service().internalRemoveBackup({ sessionId: "s_deleted" });
		const node2 = await start(peerPort, true, true);
		assert.equal((await runner.connection(peer, id)).status, 200);
		runner.report.sessionBackups = true;
		const returned = await runner.connect(conn, id);
		await eventually(() => returned.frames.some(f => f.kind === "remove" && f.sandbox === "deleted-sandbox"));
		await eventually(() => returned.frames.some(f => f.kind === "forget-backup" && f.sessionId === "s_deleted"));
		delete runner.report.sessionBackups;
		step(
			"Switch back to your plan: the runner removes the machine's own Claude login and answers; offline, nothing to ask",
		);
		assert.equal(await service().internalForgetClaudeLogin(), "removed");
		assert.ok(returned.frames.some(f => f.kind === "forget-claude-login"));
		returned.ws.close();
		await eventually(async () => (await row()).status === "offline");
		assert.equal(await service().internalForgetClaudeLogin(), "offline");

		step("the real runner connects, and a second process epoch is refused without either control loop exiting");
		// Use the real control loop and Docker executor. A missing local socket makes the Docker
		// probe fail without pulling an image or creating a container. The signing key stays in memory.
		const run = async () => {
			const state = await mkdtemp(join(dir, "runner-"));
			const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "runner"], {
				cwd: fileURLToPath(new URL("../server/", import.meta.url)),
				stdio: ["ignore", "ignore", "ignore", "ipc"],
				serialization: "advanced",
				env: {
					...env,
					WLP_PUBLIC_URL: origin,
					DOCKER_HOST: "unix://" + join(dir, "no-docker.sock"),
					DOCKER_CONTEXT: "",
					WLP_RUNNER_STATE_DIR: state,
				},
			});
			nodes.add(child);
			child.send({ id, key: runner.key.export({ type: "pkcs8", format: "der" }) });
			return { child, state };
		};
		const accepted = await run();
		await eventually(
			async () => (await row()).status === "online" && (await row()).warnings.some(w => w.kind === "docker"),
		);
		// The caps its owner set (realRunner: --max-running 1, --max-sandboxes 1) are what the list says of the machine.
		await eventually(async () => {
			const listed = await row();
			return listed.maxRunning === 1 && listed.maxSandboxes === 1;
		});
		const beforeDuplicate = Date.now();
		const copy = await run();
		await eventually(async () => (await row()).warnings.some(w => w.kind === "key" && w.at >= beforeDuplicate));
		await eventually(async () => {
			const status = await readFile(join(copy.state, "status.json"), "utf8").catch(() => null);
			return status !== null && JSON.parse(status).connection.startsWith("key-in-use");
		});
		for (const { child } of [accepted, copy]) {
			assert.equal(child.exitCode, null);
			assert.equal(child.signalCode, null);
		}
		assert.equal((await row()).status, "online");
		await Promise.all([stop(accepted.child), stop(copy.child)]);
		await eventually(async () => (await row()).status === "offline");
		step("revoke racing an authenticated hello, signed tombstones and replay after removal");
		let release!: () => void;
		const pending = await runner.connect(conn, id, {
			beforeHello: new Promise<void>(r => {
				release = r;
			}),
		});
		await eventually(() => pending.frames.some(f => f.kind === "challenge"));
		const removal = user.removeMachine({ machineId, removeSandboxes: true });
		release();
		await removal;
		await eventually(
			() => pending.frames.some(f => f.kind === "refused" && f.reason === "removed") && returned.ws.readyState === 3,
		);
		assert.equal((await service().internalFacts()).status, "removed");
		assert.deepEqual(await service().internalAttach({ sessionId: "s_deleted", ticket }), {
			ok: false,
			reason: "removed",
		});
		const gone = await runner.connection(origin, id);
		assert.equal(gone.status, 410);
		assert.deepEqual(await gone.json(), { reason: "removed", removeSandboxes: true });
		assert.equal((await wrong.connection(origin, id)).status, 403);
		const stranger = await wrong.connect(conn, id);
		await eventually(() => stranger.frames.some(f => f.kind === "refused" && f.reason === "unknown"));
		await refused(user.confirmMachine({ ...code, keyConfirmed: true }), "pairing_not_found");
		assert.equal((await user.machines()).length, 0);
		await observer.dispose();
		step("three slots under concurrent confirmation and five code lookups per account");
		const more = await Promise.all(
			Array.from({ length: 4 }, () => {
				const fixture = new FakeRunner();
				return fixture.pair(origin);
			}),
		);
		await Promise.all(more.map(p => user.claimMachine({ code: p.code })));
		const confirmed = await Promise.allSettled(
			more.map(p => user.confirmMachine({ code: p.code, keyConfirmed: true })),
		);
		assert.equal(confirmed.filter(r => r.status === "fulfilled").length, 3);
		assert(confirmed.some(r => r.status === "rejected" && r.reason.code === "too_many_machines"));
		for (let i = 0; i < 4; i++) await refused(other.claimMachine({ code: "0000-0000" }), "pairing_not_found");
		await refused(other.claimMachine({ code: "0000-0000" }), "too_many_claims");
		step("expired pairing and scheduled 90-day removal");
		const { codeDigest, digest, newPairCode, publicSpki } = await import("../server/src/runner-keys.js");
		const expCode = newPairCode(),
			pairingId = randomBytes(32).toString("base64url");
		const pollSecret = randomBytes(32).toString("base64url");
		const claimant = await account();
		const params = serviceParams();
		await client.pairingDirectory
			.get(["starts"], { params })
			.internalStart(codeDigest(expCode)!, pairingId, digest("fixture"));
		await client.machinePairing.create([pairingId], {
			params,
			input: {
				grant: createGrant("machinePairing", [pairingId]),
				details: runner.details,
				publicKey: publicSpki(runner.details.publicKey)!,
				pollHash: digest(pollSecret),
				expires: Date.now() + 15_000,
			},
		});
		await claimant.user.claimMachine({ code: expCode });
		await eventually(async () => (await runner.poll(origin, { pairing: pairingId, pollSecret }))?.state === "gone");
		await refused(claimant.user.confirmMachine({ code: expCode, keyConfirmed: true }), "pairing_not_found");
		assert.equal((await claimant.user.machines()).length, 0);
		const idle = new FakeRunner();
		idle.details.name = "Old machine fixture";
		const started = await idle.pair(origin);
		const idleCode = { code: started.code };
		await claimant.user.claimMachine(idleCode);
		const aged = await claimant.user.confirmMachine({ ...idleCode, keyConfirmed: true });
		const agedId = { uid: claimant.uid, machineId: aged.machineId };
		const idleMachine = client.machine.get([claimant.uid, aged.machineId], { params });
		await refused(idleMachine.expire(), "forbidden");
		assert.equal((await idleMachine.internalFacts()).status, "waiting");
		await eventually(async () => (await claimant.user.machines()).length === 0);
		const expired = await idle.connection(origin, agedId);
		assert.equal(expired.status, 410);
		assert.deepEqual(await expired.json(), { reason: "removed", removeSandboxes: false });

		step("Deny on the connect page ends a pairing, only for the account that looked its code up");
		const denier = await account();
		const outsider = await account();
		const deniedRunner = new FakeRunner();
		const deniedPair = await deniedRunner.pair(origin);
		const deniedCode = { code: deniedPair.code };
		await refused(denier.user.denyMachine(deniedCode), "pairing_not_found");
		await denier.user.claimMachine(deniedCode);
		await refused(outsider.user.claimMachine(deniedCode), "pairing_not_found");
		await refused(outsider.user.denyMachine(deniedCode), "pairing_not_found");
		assert.deepEqual(await deniedRunner.poll(origin, deniedPair), { state: "waiting" });
		await denier.user.denyMachine(deniedCode);
		assert.deepEqual(await deniedRunner.poll(origin, deniedPair), { state: "gone" });
		await refused(denier.user.confirmMachine({ ...deniedCode, keyConfirmed: true }), "pairing_not_found");
		await refused(denier.user.denyMachine(deniedCode), "pairing_not_found");
		// Once confirmed, Deny leaves the machine paired: it is removed on Machines.
		const keptPair = await new FakeRunner().pair(origin);
		await denier.user.claimMachine({ code: keptPair.code });
		const keptMachine = await denier.user.confirmMachine({ code: keptPair.code, keyConfirmed: true });
		await denier.user.denyMachine({ code: keptPair.code });
		assert.deepEqual(
			(await denier.user.machines()).map(m => m.machineId),
			[keptMachine.machineId],
		);

		step("pairing quotas across nodes regardless of forwarding headers, with room for other runners");
		const quotaRunner = new FakeRunner();
		const starts = await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				fetch((i % 2 ? origin : peer) + RUNNER_PAIR_PATH, {
					method: "POST",
					headers: { "content-type": "application/json", "x-forwarded-for": `192.0.2.${i + 1}` },
					body: JSON.stringify(quotaRunner.details),
					redirect: "error",
				}),
			),
		);
		assert.equal(starts.filter(r => r.status === 201).length, 3);
		assert.equal(starts.filter(r => r.status === 429).length, 2);
		assert.equal((await post(origin, RUNNER_PAIR_PATH, new FakeRunner().details)).status, 201);
		const chunks = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new Uint8Array(3000));
				c.enqueue(new Uint8Array(3000));
				c.close();
			},
		});
		const chunked: RequestInit & { duplex: "half" } = { method: "POST", body: chunks, duplex: "half" };
		assert.equal((await fetch(origin + RUNNER_PAIR_PATH, chunked)).status, 413);
		// Count actual admissions by the shared actor, without allocating a thousand throwaway actors.
		// The expiry checks above can outlast the service token used to set them up.
		const budget = client.pairingDirectory.get(["starts"], { params: serviceParams() }).connect();
		let admitted = 0;
		try {
			// Thirteen earlier admissions are still in this ten-minute window (including the short-lived fixture and the two of Deny).
			const earlier = 13;
			for (let i = 0; i < 128 && admitted + earlier < 1024; i++) {
				const batch = await Promise.all(
					Array.from({ length: 32 }, () =>
						budget.internalStart(digest(randomUUID()), randomUUID(), randomBytes(44).toString("base64")),
					),
				);
				admitted += batch.filter(expires => expires !== null).length;
			}
			assert.equal(admitted + earlier, 1024);
			assert.equal(
				await budget.internalStart(digest(randomUUID()), randomUUID(), randomBytes(44).toString("base64")),
				null,
			);
		} finally {
			await budget.dispose();
		}
		step("disabled routes, user actions and platform info after restart");
		await stop(node2);
		await stop(node);
		await start(http, false);
		assert.equal((await post(origin, RUNNER_PAIR_PATH, {})).status, 404);
		assert(!(await (await fetch(origin + "/platform/info")).json()).machines);
		await Promise.all(
			[
				user.machines(),
				user.claimMachine(code),
				user.confirmMachine({ ...code, keyConfirmed: true }),
				user.removeMachine({ machineId, removeSandboxes: false }),
				user.setMachineSecrets({ machineId, send: true }),
			].map(action => refused(action, "machines_off")),
		);
		console.log("ok   " + stage);
	} catch (error) {
		// Assertion values and client errors can carry a key, poll secret or a gateway URL.
		const location = error instanceof Error ? /machine-check.ts:(\d+)/.exec(error.stack ?? "")?.[1] : undefined;
		throw new Error(
			`${stage} failed (line ${location ?? "unknown"}, ${(error as { code?: string }).code ?? "check"}).`,
		);
	} finally {
		proxy?.close();
		for (const node of [...nodes].reverse()) await stop(node);
		try {
			const runtime = JSON.parse(await readFile(join(dir, ".rivetkit/var/engine/runtime.json"), "utf8"));
			if (Number.isInteger(runtime.pid) && runtime.pid > 1) process.kill(runtime.pid, "SIGTERM");
		} catch {
			/* The local engine normally exits with its node. */
		}
		await rm(dir, { recursive: true, force: true });
	}
}

process.env.RIVET_LOG_LEVEL = "silent";
if (process.argv[2] === "node") await server();
else if (process.argv[2] === "runner") await realRunner();
else await check();
