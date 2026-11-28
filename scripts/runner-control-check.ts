/**
 * What the types of the control socket's module cannot show: input from the other side that is not a
 * frame is refused without throwing, every refusal the actor makes is one a runner can read, a newer
 * server's refusal still shows its sentence, and the rule for a second runner with one key.
 *
 *   cd server && npx tsx ../scripts/runner-control-check.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { mock } from "node:test";
import { DockerSandboxHandle } from "../server/src/sandbox/sandboxes.js";
import { machineProfiles } from "../server/src/machines/profiles.js";
import type { Answer } from "../server/src/sandbox/provider.js";
import { validArgs, validValue, type Args, type Frame, type Body, type Name } from "../server/src/runner/protocol.js";
import { privateSessionData } from "../server/src/sandbox/session-data.js";
import type { Limits } from "../runner/src/policy.js";
import type { Box, Executor } from "../runner/src/docker-executor.js";
import {
	CAPABILITIES_RUNNER_VERSION,
	STORE_LIMITS_RUNNER_VERSION,
	REFUSED_RETRY_MS,
	type ServerFrame,
	LIVE_MS,
	MAX_CONTROL_FRAME_BYTES,
	MIN_RUNNER_VERSION,
	parseConnectionRefusal,
	parsePairStatus,
	parseRunnerFrame,
	parseServerFrame,
	refuse,
	reportFor,
	secondHello,
	versionAtLeast,
	welcomeCapabilities,
	type Report,
} from "../server/src/runner/control.js";

let failures = 0;
function expect(name: string, ok: boolean): void {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
}
const never = (parse: (data: unknown) => unknown, inputs: unknown[]) =>
	inputs.every(input => {
		try {
			return parse(input) === null;
		} catch {
			return false;
		}
	});

// Legacy runners may display a future refusal sentence. An authenticated socket rejects extra fields.
const extendedRefusal = JSON.stringify({ kind: "refused", reason: "unknown", message: "Fixture", extra: true });
expect(
	"signed control refuses unknown fields even in refusal frames",
	parseServerFrame(extendedRefusal, true) === null && parseServerFrame(extendedRefusal)?.kind === "refused",
);
const signature = "A".repeat(86);
const hello = { kind: "hello", runnerVersion: "0.1.0", epoch: "e0123456789", time: Date.now(), signature };
const junk: unknown[] = [
	undefined,
	null,
	7,
	{},
	[],
	"",
	"{",
	"null",
	"[]",
	'"hello"',
	Buffer.from("{}"),
	JSON.stringify({ ...hello, extra: 1 }),
	JSON.stringify({ ...hello, runnerVersion: "1.2" }),
	JSON.stringify({ ...hello, signature: "short" }),
	JSON.stringify({ ...hello, time: -1 }),
	`{"__proto__":{"kind":"hello"},"kind":"heartbeat"}`,
	JSON.stringify({
		kind: "report",
		docker: { ok: true },
		commandSandbox: { ok: false, reason: "no\nnewlines" },
		freeDiskBytes: null,
		sandboxes: [],
	}),
	JSON.stringify({
		kind: "report",
		docker: { ok: true },
		commandSandbox: { ok: true },
		freeDiskBytes: 1,
		sandboxes: Array.from({ length: 101 }, (_, n) => ({ id: `b${n}`, sessionId: "s_1", state: "running", usedAt: 1 })),
	}),
	JSON.stringify({ kind: "removed", sandbox: "" }),
	JSON.stringify({ kind: "heartbeat", pad: "x".repeat(MAX_CONTROL_FRAME_BYTES) }),
	"[".repeat(100_000),
];
expect("a runner's frame that is not one is null, and nothing throws", never(parseRunnerFrame, junk));
expect(
	"the same for the server's frames",
	never(parseServerFrame, [
		...junk,
		JSON.stringify({ kind: "attach", sessionId: "../x", ticket: "t" }),
		JSON.stringify({ kind: "welcome", idleSuspendMs: -5 }),
	]),
);
expect(
	"and for the HTTP answers",
	never(parsePairStatus, [...junk, { state: "approved", uid: "u_1", machineId: "m_short", githubLogin: null }]) &&
		never(parseConnectionRefusal, [...junk, { reason: "clock" }]),
);

// An older server refuses a report with a key it does not know. This server reads gitMirrors,
// names it in the welcome only to runners that read the welcome's capabilities, and a new runner
// takes a welcome from a server that names none.
const mirrorReport = {
	kind: "report",
	docker: { ok: true },
	commandSandbox: { ok: true },
	freeDiskBytes: 12,
	sandboxes: [],
	gitMirrors: true,
};
expect(
	"this server's checks take a report with gitMirrors",
	parseRunnerFrame(JSON.stringify(mirrorReport))?.kind === "report",
);
expect(
	"the actor names capabilities only to a runner that reads them",
	!("capabilities" in welcomeCapabilities(MIN_RUNNER_VERSION)) &&
		!("capabilities" in welcomeCapabilities("0.2.1")) &&
		welcomeCapabilities(CAPABILITIES_RUNNER_VERSION).capabilities?.includes("git-mirrors") === true &&
		welcomeCapabilities("1.0.0").capabilities?.includes("git-mirrors") === true,
);
expect(
	"a welcome with or without capabilities passes, and unknown names are kept for the runner to ignore",
	parseServerFrame(JSON.stringify({ kind: "welcome", idleSuspendMs: 1 }))?.kind === "welcome" &&
		parseServerFrame(JSON.stringify({ kind: "welcome", idleSuspendMs: 1, capabilities: ["git-mirrors", "later"] }))
			?.kind === "welcome" &&
		parseServerFrame(JSON.stringify({ kind: "welcome", idleSuspendMs: 1, capabilities: "git-mirrors" })) === null,
);
expect(
	"a report without the capability drops gitMirrors and keeps the rest",
	!("gitMirrors" in reportFor(mirrorReport as unknown as Report, undefined)) &&
		reportFor(mirrorReport as unknown as Report, ["git-mirrors"]).gitMirrors === true &&
		reportFor(mirrorReport as unknown as Report, []).freeDiskBytes === 12,
);
// The same for sessionVolumes: a hardened Windlass session's own data volume. A 0.2.x runner never sends it.
const volumesReport = { ...mirrorReport, sessionVolumes: true };
expect(
	"this server's checks take a report with sessionVolumes, and name session-volumes to a runner that reads capabilities",
	parseRunnerFrame(JSON.stringify(volumesReport))?.kind === "report" &&
		welcomeCapabilities(CAPABILITIES_RUNNER_VERSION).capabilities?.includes("session-volumes") === true &&
		!("capabilities" in welcomeCapabilities("0.2.1")),
);
expect(
	"each field goes only with its own capability",
	(() => {
		const none = reportFor(volumesReport as unknown as Report, undefined),
			mirrors = reportFor(volumesReport as unknown as Report, ["git-mirrors"]);
		const volumes = reportFor(volumesReport as unknown as Report, ["session-volumes"]),
			both = reportFor(volumesReport as unknown as Report, ["git-mirrors", "session-volumes"]);
		return (
			!("sessionVolumes" in none) &&
			!("gitMirrors" in none) &&
			mirrors.gitMirrors === true &&
			!("sessionVolumes" in mirrors) &&
			volumes.sessionVolumes === true &&
			!("gitMirrors" in volumes) &&
			both.gitMirrors === true &&
			both.sessionVolumes === true
		);
	})(),
);
// Windlass's model relay (docs/model-relay.md): named to every runner that reads capabilities; runners 0.3.0 and 0.3.1
// ignore the name, say nothing, and their turns get the token in the sandbox as before.
const relayReport = { ...mirrorReport, modelRelay: true };
expect(
	"this server's checks take a report with modelRelay, and name model-relay to a runner that reads capabilities",
	parseRunnerFrame(JSON.stringify(relayReport))?.kind === "report" &&
		welcomeCapabilities(CAPABILITIES_RUNNER_VERSION).capabilities?.includes("model-relay") === true &&
		welcomeCapabilities("0.3.1").capabilities?.includes("model-relay") === true &&
		!("capabilities" in welcomeCapabilities("0.2.1")),
);
expect(
	"modelRelay goes only with its own capability",
	!("modelRelay" in reportFor(relayReport as unknown as Report, ["git-mirrors", "session-volumes"])) &&
		reportFor(relayReport as unknown as Report, ["model-relay"]).modelRelay === true,
);
expect(
	"the three relay operations take only a lease, a placeholder of the relay's form and a token, and a connect may say modelRelay",
	validArgs("modelRelay", { id: "x" }) &&
		validValue("modelRelay", {
			lease: "a".repeat(32),
			placeholder: "wlp-model." + "b".repeat(32),
			env: { WINDLASS_MODEL_BASE_URL: "http://127.0.0.1:17893/v1" },
		}) &&
		!validValue("modelRelay", { lease: "a".repeat(32), placeholder: "sk-real-token", env: {} }) &&
		validArgs("modelRelayToken", { id: "x", lease: "a".repeat(32), accessToken: "t".repeat(40), expiresAt: 5 }) &&
		!validArgs("modelRelayToken", { id: "x", lease: "a".repeat(32), accessToken: "short", expiresAt: 5 }) &&
		validArgs("modelRelayClose", { id: "x", lease: "a".repeat(32) }) &&
		!validArgs("modelRelayClose", { id: "x", lease: "nope" }) &&
		validValue("connect", { cwd: "/workspace", profile: "docker-hardened", modelRelay: true }) &&
		!validValue("connect", { cwd: "/workspace", profile: "docker-hardened", modelRelay: false }),
);
expect(
	"a machine whose report has no sessionVolumes (a 0.2.1 runner) describes hardened sessions as sharing the machine volume, one that has it as having their own",
	(() => {
		const plain = {
			kind: "report",
			docker: { ok: true },
			commandSandbox: { ok: true },
			freeDiskBytes: 12,
			sandboxes: [],
		} as unknown as Report;
		const hardened = (report: Report) =>
			machineProfiles("box", report).find(profile => profile.id === "docker-hardened")!;
		const old = hardened(plain),
			current = hardened({ ...plain, sessionVolumes: true });
		return (
			old.details !== undefined &&
			!old.details.includes("data directory of its own") &&
			!old.layers.join(" ").includes("of the session's own") &&
			current.details?.includes("data directory of its own") === true &&
			current.layers.join(" ").includes("a data directory of the session's own")
		);
	})(),
);

expect(
	"a hello and a report pass",
	parseRunnerFrame(JSON.stringify(hello))?.kind === "hello" &&
		parseRunnerFrame(
			JSON.stringify({
				kind: "report",
				docker: { ok: false, reason: "permission denied" },
				commandSandbox: { ok: true },
				freeDiskBytes: 12,
				sandboxes: [
					{ id: "m_0123456789abcdef-0123456789ab", sessionId: "s_0123456789abcdef", state: "paused", usedAt: 5 },
				],
			}),
		)?.kind === "report",
);
const slots = {
	max: 3,
	unit: { cpus: 2, memoryBytes: 8 * 2 ** 30, pids: 1024 },
	reserve: { cpus: 1, memoryBytes: 4 * 2 ** 30 },
};
const plainReport = {
	kind: "report",
	docker: { ok: true },
	commandSandbox: { ok: true },
	freeDiskBytes: 12,
	sandboxes: [],
};
expect(
	"malformed slot reports are refused",
	[
		{ ...slots, max: 65 },
		{ ...slots, max: 0 },
		{ ...slots, max: 1.5 },
		{ ...slots, unit: { ...slots.unit, memoryBytes: 0 } },
		{ ...slots, reserve: { cpus: -1, memoryBytes: 0 } },
		{ ...slots, busy: 1 },
	].every(invalid => parseRunnerFrame(JSON.stringify({ ...plainReport, slots: invalid })) === null),
);
expect(
	"a report can update the machine name",
	parseRunnerFrame(JSON.stringify({ ...plainReport, name: "Build host" }))?.kind === "report",
);
expect(
	"invalid reported names are refused",
	["", " ", "x".repeat(65), "line\nfeed", "a\u0085b", "a\u202eb"].every(
		name => !parseRunnerFrame(JSON.stringify({ ...plainReport, name })),
	),
);
const harness = { id: "claude", adapter: "claude-agent-acp 0.109.0", image: "sha256:fixture", signIn: "none" };
expect(
	"the server accepts each Claude sign-in state and refuses extra login fields or an unknown harness",
	["token", "none", "unknown"].every(
		signIn =>
			parseRunnerFrame(JSON.stringify({ ...plainReport, harnesses: [{ ...harness, signIn }] }))?.kind === "report",
	) &&
		[
			{ ...harness, signIn: "other" },
			{ ...harness, secret: "fixture" },
			{ ...harness, id: "other" },
		].every(invalid => parseRunnerFrame(JSON.stringify({ ...plainReport, harnesses: [invalid] })) === null),
);
for (const op of ["start", "finish", "cancel"]) {
	expect(
		"the control socket rejects retired login operation " + op,
		!parseServerFrame(
			JSON.stringify({
				kind: "harnessLogin." + op,
				requestId: "a".repeat(32),
				...(op === "finish" ? { code: "fixture" } : {}),
			}),
		),
	);
}
expect(
	"the server accepts legacy page capability reports",
	!!parseRunnerFrame(JSON.stringify({ ...plainReport, claudeLogin: true })),
);
const capped = parseRunnerFrame(JSON.stringify({ ...plainReport, maxRunning: 2, maxSandboxes: 5 }));
expect(
	"a report carries the caps its owner set, and a report with no caps also passes",
	capped?.kind === "report" &&
		capped.maxRunning === 2 &&
		capped.maxSandboxes === 5 &&
		parseRunnerFrame(JSON.stringify(plainReport))?.kind === "report",
);
expect(
	"a cap that is no positive whole number is not one",
	never(
		parseRunnerFrame,
		[0, -1, 1.5, "3", null].map(cap => JSON.stringify({ ...plainReport, maxRunning: cap })),
	),
);
const refusals = [
	refuse("outdated", { runnerVersion: "0.0.9" }),
	refuse("removed", { removeSandboxes: true }),
	refuse("removed"),
	refuse("key-in-use"),
	refuse("unknown"),
	refuse("bad-frame"),
];
expect(
	"every refusal the actor makes is one a runner reads as made",
	refusals.every(r => JSON.stringify(parseServerFrame(JSON.stringify(r))) === JSON.stringify(r)),
);
const newer = parseServerFrame(
	JSON.stringify({ kind: "refused", reason: "suspended", until: 5, message: "Your account is suspended." }),
);
expect(
	'a refusal of a newer server is read as "other" with its sentence',
	newer?.kind === "refused" && newer.reason === "other" && newer.message === "Your account is suspended.",
);

expect(
	"a newer runner is served, an older one is not",
	versionAtLeast("0.10.0", "0.9.9") &&
		versionAtLeast(MIN_RUNNER_VERSION, MIN_RUNNER_VERSION) &&
		!versionAtLeast("0.0.9", "0.1.0") &&
		!versionAtLeast("1.0", "0.1.0"),
);
const now = 1_000_000;
expect("the first runner is accepted", secondHello(null, { epoch: "a" }, now) === "accept");
expect(
	"the same runner process replaces its socket without a record",
	secondHello({ epoch: "a", heardAt: now - 1 }, { epoch: "a" }, now) === "replace",
);
expect(
	"another process while the first is live is refused",
	secondHello({ epoch: "a", heardAt: now - LIVE_MS }, { epoch: "b" }, now) === "refuse",
);
expect(
	"another process after the first went quiet replaces it",
	secondHello({ epoch: "a", heardAt: now - LIVE_MS - 1 }, { epoch: "b" }, now) === "replace",
);

// Drive the real runner loop through HTTP answers and WebSocket events in memory.
const sockets: CheckSocket[] = [];
class CheckSocket extends EventTarget {
	readyState = 1;
	sent: { kind: string; name?: string; sandbox?: string; egress?: string; claudeRelay?: boolean; body?: Body }[] = [];
	constructor() {
		super();
		sockets.push(this);
	}
	send(text: string) {
		this.sent.push(JSON.parse(text));
	}
	frame(frame: ServerFrame | Frame) {
		assert.equal(this.readyState, 1);
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
	}
	close(code = 1000) {
		if (this.readyState !== 1) return;
		this.readyState = 3;
		this.dispatchEvent(Object.assign(new Event("close"), { code }));
	}
}
async function until(test: () => boolean) {
	const end = performance.now() + 5000;
	while (!test()) {
		assert.ok(performance.now() < end, "The runner did not handle the test event.");
		await wait(5);
	}
}

// Read the same files and run the same probe as a session container, using a private fixture tree.
{
	const { readMemoryEvents } = await import("../runner/src/memory-events.js");
	const root = mkdtempSync(join(tmpdir(), "runner-memory-"));
	const membership = join(root, "cgroup");
	const read = () =>
		readMemoryEvents({
			ask: async ([sh, flag, script, arg0]) => {
				const result = spawnSync(sh, [flag, script, arg0, root, membership], { encoding: "utf8" });
				return { code: result.status, stdout: result.stdout, stderr: result.stderr };
			},
		});
	try {
		writeFileSync(membership, "0::/\n");
		writeFileSync(join(root, "memory.max"), "1610612736\n");
		writeFileSync(join(root, "memory.events"), "low 0\nhigh 0\nmax 19\noom 5\noom_kill 2\noom_group_kill 0\n");
		assert.deepEqual(await read(), { oomKills: 2, totalMiB: 1536 });
		writeFileSync(join(root, "memory.max"), "max\n");
		assert.equal(await read(), null);

		const slot = join(root, "memory", "docker", "session");
		mkdirSync(slot, { recursive: true });
		writeFileSync(membership, "2:memory:/docker/session\n");
		writeFileSync(join(slot, "memory.limit_in_bytes"), "3221225472\n");
		writeFileSync(join(slot, "memory.oom_control"), "oom_kill_disable 0\nunder_oom 0\noom_kill 1\n");
		writeFileSync(join(slot, "memory.failcnt"), "22\n");
		assert.deepEqual(await read(), { oomKills: 1, totalMiB: 3072 });
		unlinkSync(join(slot, "memory.oom_control"));
		assert.equal(await read(), null);
		writeFileSync(join(slot, "memory.failcnt"), "0\n");
		assert.deepEqual(await read(), { oomKills: 0, totalMiB: 3072 });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const dir = mkdtempSync(join(tmpdir(), "runner-control-check-"));
process.env.WLP_RUNNER_STATE_DIR = dir;
// The runner's bundle defines these; loading its source directly needs them first.
Object.assign(globalThis, { SANDBOX_IMAGE: "sha256:" + "0".repeat(64), SHOTS_IMAGE_PIN: "" });
const { control } = await import("../runner/src/control.js");
const { RunnerError } = await import("../runner/src/state.js");
const { resolveMachineName } = await import("../runner/src/machine-name.js");
const { machineLabel } = await import("../server/src/contract.js");
for (const [name, expected] of [
	[" F892B469D6C5 ", "Linux x64 machine (f892b4)"],
	["A".repeat(64), "Linux x64 machine (aaaaaa)"],
	[" ", "Linux x64 machine"],
	["0123456789abc", "0123456789abc"],
]) {
	expect("machine label: " + expected, machineLabel({ name, os: "Linux", arch: "x64" }) === expected);
}
expect("Docker host name takes priority", (await resolveMachineName(undefined, async () => "nas")) === "nas");
expect(
	"Docker failure falls back to the local hostname",
	(await resolveMachineName(undefined, async () => {
		throw Error();
	})) === (await import("node:os")).hostname().slice(0, 64),
);
await assert.rejects(resolveMachineName("bad\nname"), /--name/);
expect(
	"explicit name survives restart without probing Docker",
	(await resolveMachineName("Build host")) === "Build host" &&
		(await resolveMachineName(undefined, async () => "nas")) === "Build host",
);
unlinkSync(join(dir, "name.json"));
// Run the CLI against a refusing pairing endpoint. A named request is observable before approval.
const interceptPair = `globalThis.SANDBOX_IMAGE = "fixture"; globalThis.SHOTS_IMAGE_PIN = "";
	globalThis.fetch = async (_url, init) => { console.log("Pairing name=" + JSON.parse(init.body).name); return Response.json({}, { status: 400 }); };`;
function runPair(...flags: string[]) {
	return spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"--import",
			"data:text/javascript," + encodeURIComponent(interceptPair),
			fileURLToPath(new URL("../runner/src/main.ts", import.meta.url)),
			"pair",
			"--platform",
			"https://runner-check.invalid",
			...flags,
		],
		{ encoding: "utf8", timeout: 10_000 },
	);
}
expect(
	"the pair CLI sends --name and reuses it after restart",
	runPair("--name", "Workshop").stdout.includes("Pairing name=Workshop") &&
		runPair().stdout.includes("Pairing name=Workshop"),
);
expect(
	"the CLI rejects an invalid override before pairing",
	runPair("--name", "x".repeat(65)).stderr.includes("printable name"),
);
unlinkSync(join(dir, "name.json"));
unlinkSync(join(dir, "lock"));
const { waitForPair, requestPair } = await import("../runner/src/pair-command.js");
let listening!: () => void;
const ready = new Promise<void>(resolve => {
	listening = resolve;
});
const localRequest = waitForPair(new AbortController().signal, listening);
await ready;
const command = requestPair(undefined, "Workshop");
const request = await localRequest;
expect("a local pair command forwards its name to the running service", request?.name === "Workshop");
request?.client.end();
await command;
const failedSandbox = "mm_0123456789abcdef-0123456789ab";
const auditRows = (): { operation: string; sandbox: string | null; outcome: string }[] =>
	readdirSync(dir).flatMap(file =>
		readFileSync(join(dir, file), "utf8")
			.trim()
			.split("\n")
			.map(line => JSON.parse(line)),
	);
const key = generateKeyPairSync("ed25519").privateKey;
const lease = (validForMs?: number) =>
	Response.json({
		endpoint: null,
		namespace: "default",
		token: validForMs === undefined ? null : { token: "fixture", validForMs, expiresAt: Date.now() + validForMs },
	});
const answer = (status: number, body: unknown = {}) => Response.json(body, { status });

async function withControl(
	answers: Response[],
	exercise: (runner: {
		status: string[];
		online(socketIndex?: number, capabilities?: string[], welcome?: object): Promise<CheckSocket>;
		expireLease(): void;
		now(): number;
		requests(): number;
		owner: Executor;
		storeCaps: unknown[];
	}) => Promise<void>,
) {
	const abort = new AbortController();
	const status: string[] = [];
	const realNow = Date.now,
		realFetch = globalThis.fetch,
		realSocket = globalThis.WebSocket;
	let clock = realNow(),
		requests = 0;
	sockets.length = 0;
	globalThis.WebSocket = CheckSocket as unknown as typeof WebSocket;
	Date.now = () => clock;
	globalThis.fetch = async () => answers[requests++] ?? answer(503);
	const storeCaps: unknown[] = [];
	const owner = {
		slots,
		maxTurns: slots.max,
		identity: { uid: "u_check", machineId: "m_0123456789abcdef" },
		serial: async <T>(work: () => Promise<T>) => work(),
		checkAuthenticatedNetwork: async () => {},
		welcome: async () => {},
		platformGitHost: () => {},
		platformStoreCaps: (caps: unknown) => {
			storeCaps.push(caps);
		},
		report: () => ({
			...plainReport,
			slots,
			blockedNetwork: true,
			egress: "restricted",
			claudeRelay: true,
			gitMirrors: true,
			sessionVolumes: true,
			modelRelay: true,
		}),
		requestedRemoval: async (id: string) => {
			if (id === failedSandbox) throw new RunnerError("Docker could not remove the sandbox.");
		},
		suspendAll: async () => {},
	} as unknown as Executor;
	const done = control(
		owner,
		key,
		"https://runner-check.invalid",
		abort.signal,
		s => status.push(s),
		undefined,
		"Build host",
		null,
	);
	try {
		const test = exercise({
			status,
			owner,
			storeCaps,
			requests: () => requests,
			now: () => clock,
			expireLease: () => {
				clock += 2000;
			},
			async online(socketIndex = 0, capabilities?: string[], welcome?: object) {
				await until(() => sockets.length > socketIndex);
				const socket = sockets[socketIndex];
				socket.frame({ kind: "challenge", nonce: "a".repeat(43) });
				await until(() => socket.sent.some(f => f.kind === "hello"));
				socket.frame({ kind: "welcome", idleSuspendMs: 60_000, ...(capabilities && { capabilities }), ...welcome });
				await until(() => socket.sent.some(f => f.kind === "report"));
				const report = socket.sent.find(f => f.kind === "report");
				for (const kind of ["hello", "report"]) {
					const frame = parseRunnerFrame(JSON.stringify(socket.sent.find(f => f.kind === kind)));
					assert.deepEqual(frame && "slots" in frame && frame.slots, slots);
				}
				assert.equal(report?.name, "Build host");
				assert.equal(report?.egress, "restricted");
				assert.equal(report?.claudeRelay, true);
				return socket;
			},
		}).finally(() => abort.abort());
		const [loop, checks] = await Promise.allSettled([done, test]);
		if (loop.status === "rejected") throw loop.reason;
		if (checks.status === "rejected") throw checks.reason;
	} finally {
		Date.now = realNow;
		globalThis.fetch = realFetch;
		globalThis.WebSocket = realSocket;
	}
}

async function checkControl(name: string, run: () => Promise<void>) {
	try {
		await run();
		expect(name, true);
	} catch (error) {
		expect(name, false);
		console.error(error instanceof Error ? error.message : "Runner check failed.");
	}
}
try {
	const { Executor: LocalExecutor } = await import("../runner/src/docker-executor.js");
	const { Refusal } = await import("../runner/src/state.js");
	const machineId = "m_0123456789abcdef",
		raw = "0123456789ab",
		id = `m${machineId}-${raw}`;
	const owner = new LocalExecutor({ uid: "u_fixture", machineId }, {});
	const session = "s_recovered",
		profile = "docker-windlass-sandbox";
	owner.boxes.set(id, {
		raw,
		sessionId: session,
		state: "running",
		profile,
		usedAt: 0,
		busy: 0,
		workspaceChecked: true,
	});
	owner.discover = async () => {};
	owner.provider.connect = async () => {
		throw new Error("Docker was asked to start the container.");
	};
	const attempts = {
		"create cannot adopt a container when the requested profile is denied": () => owner.create(session, profile),
		"a hardened create cannot recover a container with a denied profile": () =>
			owner.create(session, "docker-hardened"),
		"connect refuses the saved container before Docker can resume it": () => owner.lifecycle("connect", id, session),
		"direct operations on an already-running denied container are refused": async () => owner.running(id, session),
	};
	for (const [name, attempt] of Object.entries(attempts))
		await checkControl(name, () =>
			assert.rejects(
				attempt,
				error => error instanceof Refusal && error.message.includes("--allow-profile " + profile),
			),
		);
	const success = { code: 0, stderr: "", stdout: "" };
	const timeout = { code: null, stderr: "", stdout: "" };
	const execFailure = { code: 1, stderr: "Error response from daemon: container is restarting", stdout: "" };
	const denied = { code: 1, stderr: "bwrap: Creating new namespace failed: Operation not permitted", stdout: "" };
	async function probeCreate(answers: (Answer | null)[], failure?: "bubblewrap" | "exec") {
		const machine = new LocalExecutor({ uid: "u_fixture", machineId }, {}, false, false, [profile]);
		Object.assign(machine, { dockerHealth: { ok: true }, commandSandbox: { ok: true }, disk: async () => 100e9 });
		machine.network.prepare = machine.network.attach = async () => {};
		machine.provider.create = async () => raw;
		const removed: string[] = [];
		machine.provider.destroy = async raw => {
			removed.push(raw);
		};
		const timeouts: number[] = [];
		const probe = mock.method(
			DockerSandboxHandle.prototype,
			"ask",
			async (_argv: string[], options: { timeoutMs: number }) => {
				assert.deepEqual(machine.report().commandSandbox, { ok: true });
				timeouts.push(options.timeoutMs);
				return answers[timeouts.length - 1];
			},
		);
		try {
			const created = machine.create(session, profile);
			if (failure) {
				const message =
					failure === "bubblewrap"
						? "Bubblewrap could not start in the new sandbox. " + denied.stderr
						: "Docker could not complete the Bubblewrap probe after 3 attempts. " + execFailure.stderr;
				await assert.rejects(
					created,
					error =>
						error instanceof RunnerError &&
						error instanceof Refusal === (failure === "bubblewrap") &&
						error.message === message,
				);
				assert.deepEqual(
					machine.report().commandSandbox,
					failure === "bubblewrap" ? { ok: false, reason: message } : { ok: true },
				);
				assert.deepEqual(removed, [raw]);
				assert.equal(machine.boxes.size, 0);
			} else {
				assert.equal(await created, id);
				assert.equal(machine.running(id, session).state, "running");
				assert.deepEqual(machine.report().commandSandbox, { ok: true });
				assert.deepEqual(removed, []);
			}
			assert.deepEqual(timeouts, [20_000, 30_000, 45_000].slice(0, answers.length));
		} finally {
			probe.mock.restore();
		}
	}
	await checkControl("a timed-out Bubblewrap probe retries in the same sandbox and the session starts", () =>
		probeCreate([timeout, success]),
	);
	await checkControl("Docker exec failures retry without changing machine capability", () =>
		probeCreate([null, execFailure, execFailure], "exec"),
	);
	await checkControl("Bubblewrap's own error refuses the sandbox immediately and reports its stderr", () =>
		probeCreate([denied], "bubblewrap"),
	);

	await checkControl(
		"three simultaneous creates on a two-slot runner queue behind the in-progress container create",
		async () => {
			const { Session } = await import("../runner/src/session.js");
			const machine = new LocalExecutor({ uid: "u_fixture", machineId }, { slots: { ...slots, max: 2 } });
			machine.existing = async () => undefined;
			machine.ensureImage = async () => false;
			const creating: string[] = [],
				release: (() => void)[] = [];
			machine.create = async id => {
				creating.push(id);
				await new Promise<void>(resolve => release.push(resolve));
				return raw;
			};
			const clients = ["first", "second", "third"].map(id => {
				const session = new Session(id, machine, () => {});
				const socket = new CheckSocket();
				session.attach(socket as unknown as WebSocket, {
					runnerVersion: "0.3.4",
					machineId,
					ticket: "ticket",
					signature: "fixture",
				});
				socket.frame({ kind: "welcome", protocol: 1, conversation: id, received: 0, resumed: false });
				socket.frame({
					kind: "msg",
					seq: 1,
					ack: 0,
					body: { kind: "op", name: "create", id, args: { profile: "docker-hardened" } },
				});
				return { session, socket };
			});
			try {
				for (const [index, id] of ["first", "second", "third"].entries()) {
					await until(() => release.length > index);
					assert.equal(creating.length, index + 1);
					assert.equal(creating[index], id);
					release[index]!();
				}
				await until(() => clients.every(({ socket }) => socket.sent.some(f => f.body?.kind === "res" && f.body.ok)));
			} finally {
				for (const { session } of clients) session.channel.close();
				for (const resume of release) resume();
			}
		},
	);
	await checkControl(
		"spares match the complete create, expire, yield to turns and are consumed exactly once",
		async () => {
			const { WarmSpares, validSpec, SPARE_TTL } = await import("../runner/src/warm-spares.js");
			const base = {
				context: owner["spareContext"](),
				args: { profile: "docker-hardened" as const, spare: { url: "https://example.org/r.git" } },
			};
			assert.ok(validSpec(base));
			assert.ok(validSpec({ ...base, args: { ...base.args, profile: "docker-windlass-sandbox" } }));
			for (const args of [
				{ harness: "claude", screenshots: true },
				{ profile: "docker-windlass-sandbox", harness: "claude" },
				{ spare: { url: "https://secret@example.org/r" } },
				{ spare: { ...base.args.spare, prompt: "anything" } },
			])
				assert.equal(validSpec({ ...base, args: { ...base.args, ...args } }), false);
			let now = 0;
			const removed = new Set<string>();
			const pool = new WarmSpares(
				async () => {},
				async raw => {
					removed.add(raw);
				},
				() => now,
			);
			pool.used(base);
			const fill = async () => {
				await until(() => !pool.raws.length);
				pool.fill(1);
				await until(() => pool.ready === 1);
				return pool.raws[0]!;
			};
			for (const other of [
				{ ...base, args: { ...base.args, profile: "docker-windlass-sandbox" as const } },
				{ ...base, args: { ...base.args, harness: "codex" as const } },
				{ ...base, context: "other" },
				{ ...base, args: { ...base.args, size: 2 } },
				{ ...base, args: { ...base.args, screenshots: true } },
				{ ...base, args: { ...base.args, spare: { url: "https://example.org/another.git" } } },
			]) {
				const raw = await fill();
				assert.equal(await pool.take(other, async () => true), undefined);
				await pool.trim(0, other);
				assert.ok(removed.has(raw));
			}
			const old = await fill();
			now += SPARE_TTL;
			assert.equal(await pool.take(base, async () => true), undefined);
			await pool.trim(0, base);
			assert.ok(removed.has(old));
			const dirty = await fill();
			assert.equal(await pool.take(base, async () => false), undefined);
			assert.ok(removed.has(dirty));
			const hit = await fill();
			assert.equal((await pool.take(base, async () => true))?.raw, hit);
			assert.equal(await pool.take(base, async () => true), undefined);
			assert.ok(!removed.has(hit));
			const waiting = await fill();
			await pool.trim(0);
			assert.ok(removed.has(waiting));
			let cancelled = false;
			const building = new WarmSpares(
				async (_raw, _spec, signal) =>
					new Promise(resolve =>
						signal.addEventListener(
							"abort",
							() => {
								cancelled = true;
								resolve();
							},
							{ once: true },
						),
					),
				async () => {},
			);
			building.used(base);
			building.fill(1);
			await building.trim(0);
			assert.ok(cancelled);
			assert.equal(building.ready, 0);
			let builds = 0,
				finish!: () => void;
			const retiring = new WarmSpares(
				async () => {
					builds++;
				},
				() =>
					new Promise(resolve => {
						finish = resolve;
					}),
			);
			retiring.used(base);
			retiring.fill(1);
			await until(() => retiring.ready === 1);
			const removal = retiring.trim(0);
			await until(() => !!finish);
			retiring.fill(1);
			assert.equal(builds, 1, "a retiring container still occupies its background reservation");
			finish();
			await removal;
			retiring.fill(1);
			assert.equal(builds, 2);
		},
	);

	await checkControl(
		"two consecutive failed builds wait for another real create and a successful build resets the count",
		async () => {
			const { WarmSpares } = await import("../runner/src/warm-spares.js");
			const spec = {
				context: owner["spareContext"](),
				args: { profile: "docker-hardened" as const, spare: { url: "https://example.org/r.git" } },
			};
			let now = 0,
				builds = 0,
				fail = true;
			const pool = new WarmSpares(
				async () => {
					builds++;
					if (fail) throw new Error("setup");
				},
				async () => {},
				() => now,
			);
			const attempt = async () => {
				pool.fill(1);
				await until(() => pool.ready === 1 || pool.raws.length === 0);
			};
			pool.used(spec);
			await attempt();
			await attempt();
			assert.equal(builds, 1, "the first retry backs off");
			now += 60_000;
			await attempt();
			now += 3_600_000;
			await attempt();
			assert.equal(builds, 2);
			pool.used(spec);
			await attempt();
			now += 60_000;
			fail = false;
			await attempt();
			assert.equal(pool.ready, 1);
			await pool.trim();
			fail = true;
			await attempt();
			now += 60_000;
			await attempt();
			assert.equal(builds, 6);
		},
	);

	await checkControl("six-hour replacements expire after 24 hours without a real session", async () => {
		const { WarmSpares, SPARE_TTL } = await import("../runner/src/warm-spares.js");
		const spec = {
			context: owner["spareContext"](),
			args: { profile: "docker-hardened" as const, spare: { url: "https://example.org/r.git" } },
		};
		const day = 24 * 60 * 60_000;
		let now = 0,
			builds = 0;
		const pool = new WarmSpares(
			async () => {
				builds++;
			},
			async () => {},
			() => now,
		);
		pool.used(spec);
		pool.fill(1);
		await until(() => pool.ready === 1);
		now = SPARE_TTL;
		pool.fill(1);
		await until(() => pool.raws.length === 0);
		pool.fill(1);
		await until(() => pool.ready === 1);
		now = day;
		pool.fill(1);
		await until(() => pool.raws.length === 0);
		pool.fill(1);
		assert.equal(pool.recipe, undefined);
		assert.equal(builds, 2, "the replacement did not renew demand");
		pool.used(spec);
		pool.fill(1);
		await until(() => pool.ready === 1);
		assert.equal(builds, 3);
	});

	await checkControl("a cold seed can share a short-lived branch head but a claim always rereads it", async () => {
		const { spareHead } = await import("../server/src/actors/agent-session.js");
		let now = 0,
			reads = 0;
		const clock = mock.method(Date, "now", () => now);
		const read = async () => String(++reads);
		try {
			assert.equal(await spareHead("main", true, read), "1");
			assert.equal(await spareHead("main", true, read), "1");
			assert.equal(await spareHead("main", false, read), "2");
			now += 30_000;
			assert.equal(await spareHead("main", true, read), "3");
			assert.equal(await spareHead("other", true, read), "4");
		} finally {
			clock.mock.restore();
		}
	});

	await checkControl("an idle stop reports the paused sandbox immediately", async () => {
		const machineId = "m_0123456789abcdef";
		Object.assign(globalThis, { SANDBOX_IMAGE: "sha256:" + "0".repeat(64) });
		const { Executor } = await import("../runner/src/docker-executor.js");
		const owner = new Executor({ uid: "u_owner", machineId }, {});
		const raw = "0123456789ab",
			id = `m${machineId}-${raw}`;
		owner.boxes.set(id, {
			raw,
			sessionId: "s_idle",
			state: "running",
			profile: "docker-hardened",
			usedAt: 0,
			busy: 0,
			workspaceChecked: true,
		});
		owner.discover = async () => {};
		let stopped = false;
		owner.provider.suspend = async () => {
			stopped = true;
		};
		owner.provider.state = async () => (stopped ? "paused" : "running");
		const reports: string[] = [];
		owner.publishReport = () => reports.push(owner.report().sandboxes[0]!.state);
		const cleanup = mock.method(DockerSandboxHandle.prototype, "removeFiles", async () => {});
		try {
			await owner.idle(1, () => false);
			assert.ok(stopped);
			assert.deepEqual(reports, ["paused"]);
		} finally {
			cleanup.mock.restore();
		}
	});
	await checkControl(
		"a failed renewal preserves the control and session sockets and retries on the next attach",
		async () => {
			const errors = [
				answer(429),
				answer(403, { reason: "removed", removeSandboxes: true }),
				answer(410, { reason: "unknown" }),
				answer(403, { reason: "clock", serverTime: Date.now() + 60_000 }),
			];
			await withControl([lease(1000), ...errors, lease()], async r => {
				const ws = await r.online();
				ws.frame({ kind: "attach", sessionId: "s_live", ticket: "first" });
				await until(() => sockets[1]?.sent.some(f => f.kind === "hello") === true);
				r.expireLease();
				for (const error of errors) {
					const before = auditRows().length;
					ws.frame({ kind: "attach", sessionId: "s_new", ticket: "retry" });
					await until(() =>
						auditRows()
							.slice(before)
							.some(row => row.operation === "attach" && row.outcome === "HTTP " + error.status),
					);
					assert.equal(ws.readyState, 1, "Renewal closed the control socket.");
					assert.equal(sockets[1].readyState, 1, "Renewal closed the live session.");
					assert.equal(sockets.length, 2, "The failed attach opened a session socket.");
				}
				ws.frame({ kind: "attach", sessionId: "s_new", ticket: "fresh" });
				await until(() => sockets[2]?.sent.some(f => f.kind === "hello") === true);
				assert.equal(r.requests(), 1 + errors.length + 1);
				assert.equal(r.status.at(-1), "Online");
			});
			for (const refusal of [
				answer(403, { reason: "unknown" }),
				answer(410, { reason: "removed", removeSandboxes: false }),
			]) {
				await withControl([lease(1000), refusal], async r => {
					const ws = await r.online();
					r.expireLease();
					ws.frame({ kind: "attach", sessionId: "s_new", ticket: "refused" });
					await until(() => ws.readyState === 3);
					assert.equal(sockets.length, 1);
				});
			}
		},
	);
	await checkControl("a runner sends gitMirrors only to a server whose welcome names git-mirrors", async () => {
		for (const [capabilities, sent] of [
			[undefined, false],
			[[], false],
			[["something-newer"], false],
			[["something-newer", "git-mirrors"], true],
		] as const) {
			await withControl([lease()], async r => {
				const ws = await r.online(0, capabilities && [...capabilities]);
				const report = ws.sent.find(f => f.kind === "report");
				assert.equal(
					Object.hasOwn(report ?? {}, "gitMirrors"),
					sent,
					`welcome capabilities ${JSON.stringify(capabilities)}`,
				);
			});
		}
	});
	await checkControl("a runner sends sessionVolumes only to a server whose welcome names session-volumes", async () => {
		for (const [capabilities, sent] of [
			[undefined, false],
			[[], false],
			[["git-mirrors"], false],
			[["git-mirrors", "session-volumes"], true],
		] as const) {
			await withControl([lease()], async r => {
				const ws = await r.online(0, capabilities && [...capabilities]);
				const report = ws.sent.find(f => f.kind === "report");
				assert.equal(
					Object.hasOwn(report ?? {}, "sessionVolumes"),
					sent,
					`welcome capabilities ${JSON.stringify(capabilities)}`,
				);
				// And makes hardened sandboxes with data of their own only then: an older server would take the data for shared.
				assert.equal(
					r.owner.sessionVolumes,
					sent,
					`owner.sessionVolumes after welcome capabilities ${JSON.stringify(capabilities)}`,
				);
			});
		}
	});
	await checkControl("blocked-network and memory-events are negotiated on connect", async () => {
		for (const capabilities of [undefined, ["memory-events"], ["blocked-network"]]) {
			const memory = capabilities?.includes("memory-events") === true;
			const named = capabilities?.includes("blocked-network") === true;
			await withControl([lease()], async r => {
				const ws = await r.online(0, capabilities);
				assert.equal(Object.hasOwn(ws.sent.find(f => f.kind === "report")!, "blockedNetwork"), named);
				assert.equal(r.owner.blockedNetwork, named);
				assert.equal(r.owner.memoryEvents, memory);
			});
			const { Executor } = await import("../runner/src/docker-executor.js");
			const owner = new Executor(
				{ uid: "u_owner", machineId: "m_0123456789abcdef" },
				{},
				false,
				false,
				["docker-hardened"],
				{ mode: "restricted", allow: [] },
			);
			owner.blockedNetwork = named;
			owner.memoryEvents = memory;
			owner.discover = async () => {
				Object.assign(owner, { dockerHealth: { ok: true } });
			};
			Object.assign(owner, { disk: async () => 10_000_000_000 });
			owner.network.prepare = async () => {};
			owner.network.attach = async () => {};
			owner.provider.create = async () => "0123456789ab";
			owner.provider.connect = async () => ({ cwd: "/workspace" }) as DockerSandboxHandle;
			const id = await owner.create("s_network", "docker-hardened");
			const found = await owner.lifecycle("connect", id, "s_network");
			assert.ok(validValue("connect", found) && found);
			assert.equal("blockedNetwork" in found, named);
			assert.equal("memoryEvents" in found, memory);
		}
	});
	await checkControl(
		"a runner sends modelRelay, and lets turns use its relay, only for a server whose welcome names model-relay",
		async () => {
			for (const [capabilities, sent] of [
				[undefined, false],
				[[], false],
				[["git-mirrors", "session-volumes"], false],
				[["git-mirrors", "model-relay"], true],
				[["model-relay", "windlass-key-relay"], true],
			] as const) {
				await withControl([lease()], async r => {
					const ws = await r.online(0, capabilities && [...capabilities]);
					const report = ws.sent.find(f => f.kind === "report");
					assert.equal(
						Object.hasOwn(report ?? {}, "modelRelay"),
						sent,
						`welcome capabilities ${JSON.stringify(capabilities)}`,
					);
					assert.equal(r.owner.windlassKeyRelays, capabilities?.some(c => c === "windlass-key-relay") === true);
					assert.equal(
						r.owner.modelRelays,
						sent,
						`owner.modelRelays after welcome capabilities ${JSON.stringify(capabilities)}`,
					);
				});
			}
		},
	);
	await checkControl(
		"a connect says modelRelay only to a server that named model-relay, only for Windlass's own sandboxes, and only when the pinned image's Windlass is 0.6.0 or later",
		async () => {
			const { Executor } = await import("../runner/src/docker-executor.js");
			for (const [named, windlass, said] of [
				[false, "0.7.1", false],
				[true, "0.7.1", true],
				[true, "0.6.0", true],
				[true, "0.5.0", false],
				[true, null, false],
			] as const) {
				const owner = new Executor({ uid: "u_owner", machineId: "m_0123456789abcdef" }, {});
				owner.modelRelays = named;
				owner.windlassKeyRelays = named;
				// What `welcome` probes from the pinned sandbox image.
				(owner as unknown as { sandboxWindlass: string | null }).sandboxWindlass = windlass;
				assert.equal(
					owner.report().modelRelay,
					windlass === "0.7.1" || windlass === "0.6.0",
					`the report says modelRelay for Windlass ${windlass}`,
				);
				owner.discover = async () => {
					(owner as unknown as { dockerHealth: { ok: boolean } }).dockerHealth = { ok: true };
				};
				Object.assign(owner, { disk: async () => 10_000_000_000 });
				owner.network.prepare = async () => {};
				owner.network.attach = async () => {};
				owner.provider.create = async () => "0123456789ab";
				owner.provider.connect = async () => ({ cwd: "/workspace" }) as unknown as DockerSandboxHandle;
				const id = await owner.create("s_relay", "docker-hardened");
				const found = await owner.lifecycle("connect", id, "s_relay");
				assert.equal(
					found && typeof found === "object" && "modelRelay" in found,
					said,
					`named ${named}, Windlass ${windlass}`,
				);
				assert.equal(found && typeof found === "object" && "windlassKeyRelay" in found, named);
				assert.ok(validValue("connect", found));
			}
		},
	);
	await checkControl(
		"a runner tells a sandbox's start times on its first connect after the create, once, and only to a server that named start-times",
		async () => {
			for (const [capabilities, named] of [
				[undefined, false],
				[["git-mirrors", "model-relay"], false],
				[["git-mirrors", "start-times"], true],
			] as const) {
				await withControl([lease()], async r => {
					await r.online(0, capabilities && [...capabilities]);
					assert.equal(
						r.owner.startTimes,
						named,
						`owner.startTimes after welcome capabilities ${JSON.stringify(capabilities)}`,
					);
				});
			}
			const { Executor } = await import("../runner/src/docker-executor.js");
			for (const named of [false, true]) {
				const owner = new Executor({ uid: "u_owner", machineId: "m_0123456789abcdef" }, {});
				owner.startTimes = named;
				owner.discover = async () => {
					(owner as unknown as { dockerHealth: { ok: boolean } }).dockerHealth = { ok: true };
				};
				Object.assign(owner, { disk: async () => 10_000_000_000 });
				owner.network.prepare = async () => {};
				owner.network.attach = async () => {};
				owner.provider.create = async () => "0123456789ab";
				owner.provider.connect = async () => ({ cwd: "/workspace" }) as unknown as DockerSandboxHandle;
				const id = await owner.create("s_times", "docker-hardened");
				// What the session's create (runner/src/session.ts) puts on the box.
				owner.boxes.get(id)!.startTimes = { image: 12, pulled: true, create: 340 };
				const first = await owner.lifecycle("connect", id, "s_times");
				const second = await owner.lifecycle("connect", id, "s_times");
				assert.ok(validValue("connect", first) && validValue("connect", second));
				assert.deepEqual(
					first && typeof first === "object" && "startTimes" in first ? first.startTimes : null,
					named ? { image: 12, pulled: true, create: 340 } : null,
					`named ${named}`,
				);
				assert.equal(
					second && typeof second === "object" && "startTimes" in second,
					false,
					"only the first connect says it",
				);
			}
		},
	);
	await checkControl(
		"suspending or removing a sandbox ends its turns' relay leases: the relay's file, the forwarder and the conversation's entry",
		async () => {
			const { Executor } = await import("../runner/src/docker-executor.js");
			for (const op of ["suspend", "destroy"] as const) {
				const owner = new Executor({ uid: "u_owner", machineId: "m_0123456789abcdef" }, {});
				owner.discover = async () => {
					(owner as unknown as { dockerHealth: { ok: boolean } }).dockerHealth = { ok: true };
				};
				Object.assign(owner, { disk: async () => 10_000_000_000 });
				owner.network.prepare = async () => {};
				owner.network.attach = async () => {};
				owner.network.detach = async () => {};
				owner.provider.create = async () => "0123456789ab";
				owner.provider.suspend = async () => {};
				owner.provider.destroy = async () => {};
				owner.provider.state = async () => "paused";
				const ended: string[] = [];
				owner.modelRelay.endSandbox = async (raw: string) => {
					ended.push(`relay:${raw}`);
				};
				const id = await owner.create("s_relay", "docker-hardened");
				const untrack = owner.trackRelay(id, async () => {
					ended.push("lease");
				});
				const kept = owner.trackRelay("other", async () => {
					ended.push("other");
				});
				const box = owner.boxes.get(id)!;
				box.state = "paused";
				await owner.lifecycle(op, id, "s_relay");
				assert.deepEqual(ended, ["lease", "relay:0123456789ab"], `${op}: ${ended.join()}`);
				untrack();
				kept();
			}
		},
	);
	await checkControl(
		"the runner asks its provider for a sandbox with data of its own, and says a connect has it, only for a server that named session-volumes",
		async () => {
			const { Executor } = await import("../runner/src/docker-executor.js");
			for (const named of [false, true]) {
				const owner = new Executor({ uid: "u_owner", machineId: "m_0123456789abcdef" }, {});
				owner.sessionVolumes = named;
				owner.discover = async () => {
					(owner as unknown as { dockerHealth: { ok: boolean } }).dockerHealth = { ok: true };
				};
				Object.assign(owner, { disk: async () => 10_000_000_000 });
				owner.network.prepare = async () => {};
				owner.network.attach = async () => {};
				const asked: { create?: boolean | "required"; connect?: boolean } = {};
				owner.provider.create = async input => {
					asked.create = input.ownData;
					return "0123456789ab";
				};
				owner.provider.connect = async (_raw, options) => {
					asked.connect = options?.ownData;
					return { cwd: "/workspace", ownData: true } as unknown as DockerSandboxHandle;
				};
				const id = await owner.create("s_volumes", "docker-hardened");
				const found = await owner.lifecycle("connect", id, "s_volumes");
				assert.deepEqual(asked, { create: named, connect: named });
				assert.equal(found && typeof found === "object" && "ownData" in found, named);
				assert.ok(validValue("connect", found));
			}
			// An older server's checks refuse a connect answer with a key they do not know, which is why it is not sent to one.
			assert.ok(!validValue("connect", { cwd: "/workspace", profile: "docker-hardened", ownData: false }));
		},
	);
	await checkControl(
		"a session judges each sandbox by what was recorded when it was made, whatever the runner reports since",
		async () => {
			const meta = (ownDataSandbox: string | null) => ({ profile: "docker-hardened" as const, ownDataSandbox });
			const runner = (sessionVolumes: boolean) => ({
				sessionsLiveInSandbox: false,
				privateSessionData: async () => sessionVolumes,
			});
			// Upgrade: the old sandbox was made with the machine volume; the runner now reports sessionVolumes.
			assert.equal(
				await privateSessionData(meta(null), runner(true), "m_a-0123456789ab"),
				false,
				"upgrade: the old sandbox's data is shared, so it is kept",
			);
			assert.equal(
				await privateSessionData(meta("m_a-aaaaaaaaaaaa"), runner(true), "m_a-aaaaaaaaaaaa"),
				true,
				"upgrade: the new sandbox's data is its own",
			);
			// Downgrade: the sandbox was made with its own volume; the runner now reports nothing.
			assert.equal(
				await privateSessionData(meta("m_a-0123456789ab"), runner(false), "m_a-0123456789ab"),
				true,
				"downgrade: the old sandbox's data went with it",
			);
			assert.equal(
				await privateSessionData(meta("m_a-0123456789ab"), runner(false), "m_a-bbbbbbbbbbbb"),
				false,
				"downgrade: the next sandbox shares the machine volume",
			);
			// Without a sandbox, the guess the words use; a reviewer and E2B always own their data.
			assert.equal(await privateSessionData(meta(null), runner(true), null), true);
			assert.equal(await privateSessionData({ ...meta(null), origin: { role: "reviewer" } }, runner(false), "x"), true);
			assert.equal(await privateSessionData(meta(null), { sessionsLiveInSandbox: true }, "x"), true);
		},
	);
	await checkControl("a failed removal is audited and left unacknowledged on the live control socket", async () => {
		await withControl([lease()], async r => {
			const ws = await r.online();
			ws.frame({ kind: "remove", sandbox: failedSandbox });
			await until(
				() =>
					ws.readyState !== 1 ||
					auditRows().some(
						row =>
							row.operation === "remove" &&
							row.sandbox === failedSandbox &&
							row.outcome === "Docker could not remove the sandbox.",
					),
			);
			assert.equal(ws.readyState, 1, "Removal closed the control socket.");
			const other = "mm_0123456789abcdef-111111111111";
			ws.frame({ kind: "remove", sandbox: other });
			await until(() => ws.sent.some(f => f.kind === "removed"));
			assert.deepEqual(
				ws.sent.filter(f => f.kind === "removed").map(f => f.sandbox),
				[other],
			);
			assert.equal(r.requests(), 1);
		});
	});
	await checkControl(
		"a deleted session's copy is removed on forget-backup, and acknowledged, only for a server that named session-backups",
		async () => {
			for (const named of [false, true]) {
				await withControl([lease()], async r => {
					const removed: string[] = [];
					Object.assign(r.owner, {
						backups: {
							remove: async (session: string) => {
								removed.push(session);
							},
						},
					});
					const ws = await r.online(0, named ? ["session-backups"] : ["session-volumes"]);
					assert.equal(r.owner.sessionBackups, named);
					ws.frame({ kind: "forget-backup", sessionId: "s_gone" });
					// Frames are handled in order: the removal's answer comes after the copy's.
					const other = "mm_0123456789abcdef-222222222222";
					ws.frame({ kind: "remove", sandbox: other });
					await until(() => ws.sent.some(f => f.kind === "removed"));
					assert.deepEqual(removed, named ? ["s_gone"] : []);
					assert.deepEqual(
						ws.sent.filter(f => f.kind === "backup-forgotten").map(f => (f as { sessionId?: string }).sessionId),
						named ? ["s_gone"] : [],
					);
					assert.equal(ws.readyState, 1);
				});
			}
			const { Executor } = await import("../runner/src/docker-executor.js");
			const owner = new Executor({ uid: "u_owner", machineId: "m_0123456789abcdef" }, {});
			assert.equal(owner.backupVolume, "wlp-machine-m_0123456789abcdef-backups");
			const args = {
				id: "mm_0123456789abcdef-0123456789ab",
				owner: { uid: "u_owner", sessionId: "s_one" },
				pack: "/tmp/.wlp-backup-abcdef.tgz",
				size: 1,
				sha256: "a".repeat(64),
				max: 10,
			};
			await assert.rejects(owner.backup("s_one", "backupSave", args), /keeps no copies/);
			await assert.rejects(
				owner.backupCopy("s_one", { from: args.owner, to: { uid: "u_owner", sessionId: "s_two" } }),
				/keeps no copies/,
			);
		},
	);
	await checkControl(
		"the snapshot and mirror limits: the owner's flags, held to the platform's caps from its welcome, reported only to a server that named store-limits",
		async () => {
			const { storeFlags } = await import("../runner/src/sizing.js");
			const { RunnerError: FlagError } = await import("../runner/src/state.js");
			assert.equal(storeFlags({}), undefined, "no flags: the defaults");
			assert.deepEqual(storeFlags({ "snapshot-disk": "20GB", "keep-free": "8GB" }), {
				machine: 20e9,
				user: 2e9,
				free: 8e9,
			});
			assert.deepEqual(storeFlags({ "snapshot-user": "512MB", "keep-free": "0GB" }), {
				machine: 10e9,
				user: 512e6,
				free: 0,
			});
			for (const flags of [
				{ "snapshot-disk": "20" },
				{ "snapshot-user": "0GB" },
				{ "keep-free": "lots" },
				{ "snapshot-disk": "-5GB" },
			])
				assert.throws(
					() => storeFlags(flags),
					(error: Error) => error instanceof FlagError && error.message.startsWith("Give --" + Object.keys(flags)[0]),
					JSON.stringify(flags),
				);

			// The welcome's caps: only to a runner that reads them, only those set, and only well-formed ones taken.
			assert.equal(
				"storeLimits" in welcomeCapabilities("0.3.1", undefined, { free: 50e9 }),
				false,
				"runner 0.3.1 refuses unknown welcome keys",
			);
			assert.equal("storeLimits" in welcomeCapabilities(STORE_LIMITS_RUNNER_VERSION), false, "no caps are set");
			assert.deepEqual(
				welcomeCapabilities(STORE_LIMITS_RUNNER_VERSION, undefined, { machine: 20e9, free: 50e9 }).storeLimits,
				{ machine: 20e9, free: 50e9 },
			);
			assert.ok(
				welcomeCapabilities("0.3.1").capabilities?.includes("store-limits"),
				"naming it costs an older runner nothing: it ignores names it does not know",
			);
			const welcome = { kind: "welcome", idleSuspendMs: 1000 };
			assert.ok(parseServerFrame(JSON.stringify({ ...welcome, storeLimits: { machine: 20e9, user: 1e9, free: 0 } })));
			for (const bad of [{ free: -1 }, { machine: 1.5 }, { machine: 2e15 }, { disk: 1 }, "50GB"])
				assert.equal(parseServerFrame(JSON.stringify({ ...welcome, storeLimits: bad })), null, JSON.stringify(bad));

			// The report: what is in force, `capped` where the platform changed it, and nothing to a server that did not name it.
			Object.assign(globalThis, { SANDBOX_IMAGE: "sha256:" + "0".repeat(64) });
			const { Executor } = await import("../runner/src/docker-executor.js");
			const plainOwner = new Executor({ uid: "u_owner", machineId: "m_0123456789abcdef" }, {});
			assert.deepEqual(
				plainOwner.report().storeLimits,
				{ machine: 10e9, user: 2e9, free: 40e9 },
				"no flags, no caps: the defaults",
			);
			const owner = new Executor(
				{ uid: "u_owner", machineId: "m_0123456789abcdef" },
				{ store: storeFlags({ "snapshot-disk": "50GB", "snapshot-user": "1GB", "keep-free": "10GB" }) },
			);
			assert.deepEqual(
				owner.report().storeLimits,
				{ machine: 50e9, user: 1e9, free: 10e9 },
				"the owner's flags before any welcome",
			);
			owner.platformStoreCaps({ machine: 20e9, user: 4e9, free: 30e9 });
			assert.deepEqual(
				owner.storeLimits(),
				{ machine: 20e9, user: 1e9, free: 30e9 },
				"more space and less free disk are held to the caps, less space stands",
			);
			const report = owner.report();
			assert.deepEqual(report.storeLimits, { machine: 20e9, user: 1e9, free: 30e9, capped: true });
			assert.ok(parseRunnerFrame(JSON.stringify(reportFor(report, ["store-limits"])))?.kind === "report");
			assert.equal(
				"storeLimits" in reportFor(report, ["git-mirrors"]),
				false,
				"a server that did not name store-limits refuses the key",
			);
			assert.equal("storeLimits" in reportFor(report, undefined), false);
			owner.platformStoreCaps(undefined);
			assert.deepEqual(
				owner.report().storeLimits,
				{ machine: 50e9, user: 1e9, free: 10e9 },
				"a platform that sends no caps leaves the owner's limits",
			);
			assert.equal(
				parseRunnerFrame(
					JSON.stringify({ ...plainReport, storeLimits: { machine: 1, user: 1, free: 1, capped: false } }),
				),
				null,
			);

			// The control loop hands the welcome's caps to the executor, and none from a welcome without them.
			await withControl([lease()], async r => {
				await r.online(0, ["store-limits"], { storeLimits: { free: 30e9 } });
				assert.deepEqual(r.storeCaps, [{ free: 30e9 }]);
			});
			await withControl([lease()], async r => {
				await r.online(0, ["store-limits"]);
				assert.deepEqual(r.storeCaps, [undefined]);
			});
		},
	);
	await checkControl("status and log give the ten-minute retry time for HTTP and socket refusals", async () => {
		for (const code of [429, 1008, 4321]) {
			await withControl([code === 429 ? answer(code) : lease()], async r => {
				const reason = code === 429 ? "HTTP 429" : "socket close " + code;
				if (code !== 429) (await r.online()).close(code);
				await until(() => r.status.some(line => line.includes(reason)));
				const line = r.status.at(-1)!;
				assert.match(line, /try again in ten minutes/);
				assert.ok(line.includes(new Date(r.now() + REFUSED_RETRY_MS).toUTCString()));
				assert.ok(auditRows().some(row => row.operation === "control" && row.outcome === line));
			});
		}
	});
	await checkControl(
		"an unremovable spare is retried without blocking egress, capacity, create or connect",
		async () => {
			const owner = new LocalExecutor({ uid: "u_fixture", machineId }, { maxSandboxes: 1, maxRunning: 1 });
			const stuck = "aaaaaaaaaaaa",
				other = "bbbbbbbbbbbb";
			const pending = new Set([stuck, other]),
				attempts: string[] = [];
			let fail = true;
			const warn = mock.method(console, "warn", () => {});
			try {
				Object.assign(owner, {
					unbound: pending,
					enforceEgress: true,
					secureCredentialPath: async () => {},
					refreshLogin: async () => {},
					dockerHealth: { ok: true },
					disk: async () => 100e9,
					discover: async () => {},
					dropSpare: async (raw: string) => {
						attempts.push(raw);
						if (fail && raw === stuck) throw Error("private diagnostic");
					},
				});
				owner.network.reconcile = async running => {
					if (fail) assert.ok(running.has(stuck));
				};
				owner.network.prepare = owner.network.attach = async () => {};
				owner.provider.create = async () => "cccccccccccc";
				owner.provider.connect = async () => ({ cwd: "/workspace" }) as DockerSandboxHandle;
				await owner.refresh();
				assert.deepEqual([...pending], [stuck]);
				assert.deepEqual(owner.report().docker, { ok: true });
				assert.equal(owner.report().sandboxes.length, 0);
				assert.deepEqual(
					warn.mock.calls.map(call => call.arguments),
					[[`Could not remove spare ${stuck}.`]],
				);
				const id = await owner.create("s_real", "docker-hardened");
				assert.ok(await owner.lifecycle("connect", id, "s_real"));
				fail = false;
				await owner.refresh();
				assert.deepEqual(attempts, [stuck, other, stuck]);
				assert.equal(pending.size, 0);
				owner.network.reconcile = async () => {
					throw Error();
				};
				await owner.refresh();
				assert.equal(owner.report().docker.ok, false, "a genuine network policy failure still blocks admission");
			} finally {
				warn.mock.restore();
			}
		},
	);

	await checkControl(
		"a restart skips the base checkout seed when the repository has a usable environment",
		async () => {
			const { canSeedOnResume } = await import("../server/src/actors/agent-session.js");
			const meta = { place: { kind: "machine" as const, machineId }, repoUrl: "https://example.org/r.git" };
			const environment = { usable: true, commit: "c".repeat(40), validatedAt: 123, checks: 1 };
			assert.equal(canSeedOnResume(meta, environment), false);
			assert.equal(canSeedOnResume(meta, { ...environment, usable: false }), true);
			assert.equal(canSeedOnResume(meta, undefined), true);
		},
	);

	await checkControl(
		"spare admission reserves memory for unfilled real slots and for the OS on explicitly sized small machines",
		async () => {
			const { sizeMachine } = await import("../runner/src/sizing.js");
			const GiB = 2 ** 30;
			const slots = sizeMachine({ cores: 10, memoryBytes: 12 * GiB });
			const machine = new LocalExecutor({ uid: "u_fixture", machineId }, { slots });
			const kept: Box = {
				raw,
				sessionId: session,
				state: "running",
				profile,
				usedAt: 0,
				busy: 0,
				workspaceChecked: true,
				activeTurns: 0,
			};
			Object.assign(machine, { availableMemory: () => 7 * GiB });
			assert.equal(machine["spareRoom"](), "memory", "a spare must leave the other empty slot covered");
			machine.boxes.set(id, kept);
			assert.equal(machine["spareRoom"](), 1, "the spare fills the one empty slot");
			machine.boxes.set("other", { ...kept, activeTurns: 1 });
			assert.equal(machine["spareRoom"](), 1, "both real slots have containers and 7 GiB is still free");

			const explicit = sizeMachine({ cores: 2, memoryBytes: 4 * GiB }, { slots: 1 });
			const small = new LocalExecutor({ uid: "u_fixture", machineId }, { slots: explicit });
			small.boxes.set(id, kept);
			let free = explicit.unit.memoryBytes;
			Object.assign(small, { availableMemory: () => free });
			assert.equal(small["spareRoom"](), "memory");
			free += GiB;
			assert.equal(small["spareRoom"](), 1);
		},
	);

	await checkControl(
		"a second Quick item claims the first item’s spare while background environment builds wait",
		async () => {
			const { spareKey } = await import("../runner/src/warm-spares.js");
			const { sizeMachine } = await import("../runner/src/sizing.js");
			const GiB = 2 ** 30,
				slots = sizeMachine({ cores: 10, memoryBytes: 12 * GiB });
			assert.deepEqual([slots.max, slots.unit.cpus, slots.unit.memoryBytes], [2, 2, 5 * GiB]);
			const uid = "u_fixture";
			const runner = new LocalExecutor({ uid, machineId }, { slots }, false, false, [profile], {
				mode: "restricted",
				allow: [],
			});
			const recipe = {
				url: "https://example.org/r.git",
				connected: {
					repo: "42",
					branch: "main",
					commit: "c".repeat(40),
					generation: "a".repeat(64),
					command: "make deps",
					timeoutMs: 3000,
				},
			};
			let free = slots.unit.memoryBytes + slots.reserve.memoryBytes,
				disk = 100e9,
				cold = 0,
				built = "";
			let builtKey: string | undefined;
			const dropped: string[] = [];
			const verify = runner["verifySpare"].bind(runner);
			Object.assign(runner, {
				warmSpares: true,
				sessionVolumes: true,
				inventoryStarted: true,
				dockerHealth: { ok: true },
				availableMemory: () => free,
				disk: async () => disk,
				dropSpare: async (raw: string) => {
					dropped.push(raw);
				},
				buildSpare: async (raw: string, spec: import("../runner/src/warm-spares.js").SpareSpec) => {
					built = raw;
					builtKey = spareKey(spec);
					return { startedAt: 1000, durationMs: 25 };
				},
				verifySpare: (...args: Parameters<typeof verify>) => {
					assert.equal(spareKey(args[2]), builtKey);
					return verify(...args);
				},
			});
			runner.network.prepare = runner.network.attach = async () => {};
			runner.provider.create = async () => (++cold).toString().padStart(12, "0");
			runner.provider.connect = async () => ({ uid, profile, ownData: true }) as DockerSandboxHandle;
			const probe = mock.method(DockerSandboxHandle.prototype, "ask", async () => success);
			try {
				const { machineLayer } = await import("../server/src/sandbox/runner-layer.js");
				const { sessionSandboxInput } = await import("../server/src/actors/internal.js");
				const create = (sessionId: string, background = false) => {
					const link = {
						who: { uid, sessionId, machineId },
						facts: async () => ({ report: runner.report() }),
						again: (name: "create", args: Args<"create">) => {
							assert.ok(validArgs(name, args));
							return runner.serial(() =>
								runner.create(
									sessionId,
									args.profile,
									args.screenshots,
									args.harness,
									args.size,
									args.prepared,
									args.mirrorRepo,
									args.spare,
									args.environmentBuild,
								),
							);
						},
					};
					const meta = background
						? { environmentBuild: { project: "github:42", place: machineId, screenshots: false } }
						: { origin: { kind: "item" as const, itemId: sessionId, role: "builder" as const } };
					return machineLayer(
						link as never,
						{} as import("../server/src/sandbox/api.js").SandboxLayer,
					).sandboxes.create({
						...sessionSandboxInput({ uid, sessionId, profile, ...meta }),
						mirrorRepo: "42",
						spareRecipe: async () => (background ? undefined : recipe),
					});
				};
				const first = await create("s_item_a");
				const kept = runner.boxes.get(first)!;
				await runner.turnStarted(kept);
				runner.turnEnded(kept);
				await runner.maintainSpares();
				await until(() => runner.report().warmSpares?.ready === 1);
				const afterA = built;
				await assert.rejects(create("s_env_a", true), /Waiting for a free slot/);
				// A stays running for CI. There is an OS margin but no extra 5 GiB for a third container.
				free = 4 * GiB;
				await runner.maintainSpares();
				assert.equal(runner.report().warmSpares?.ready, 1);
				disk = 6e9; // Below the speculative build floor. Claiming needs no new container.
				const second = await create("s_item_b");
				assert.equal(runner.boxes.get(second)?.raw, afterA);
				assert.deepEqual(dropped, []);
				assert.equal(cold, 1);
				assert.equal(kept.state, "running");
				assert.equal(runner.boxes.get(second)?.claim?.session, "s_item_b");
				kept.state = "paused";
				await runner.turnStarted(runner.boxes.get(second)!);
				runner.turnEnded(runner.boxes.get(second)!);
				disk = 100e9;
				free = slots.unit.memoryBytes + slots.reserve.memoryBytes;
				await runner.maintainSpares();
				await until(() => runner.report().warmSpares?.ready === 1);
				assert.notEqual(built, afterA);
				await assert.rejects(create("s_env_b", true), /Waiting for a free slot/);
				assert.deepEqual(dropped, []);
				runner.boxes.get(second)!.state = "paused";
				const retried = await create("s_env_b", true);
				assert.ok(runner.boxes.has(retried));
				await runner.maintainSpares();
				assert.equal(runner.report().warmSpares?.ready, 1);
				assert.deepEqual(dropped, []);
				assert.equal(cold, 2);
			} finally {
				probe.mock.restore();
			}
		},
	);

	await checkControl(
		"the changes view reads kept item A on a default two-core 12 GiB runner and item B claims its spare, including after restart",
		async () => {
			const { STATUS_COMMAND } = await import("../server/src/actors/agent-session.js");
			const { Session } = await import("../runner/src/session.js");
			const { sizeMachine } = await import("../runner/src/sizing.js");
			const { machineLayer } = await import("../server/src/sandbox/runner-layer.js");
			const { sessionSandboxInput } = await import("../server/src/actors/internal.js");
			const GiB = 2 ** 30,
				hostMemory = 12 * GiB;
			const slots = sizeMachine({ cores: 2, memoryBytes: hostMemory });
			assert.deepEqual([slots.max, slots.unit.cpus, slots.unit.memoryBytes], [1, 2, 4 * GiB]);
			const uid = "u_fixture";
			const recipe = {
				url: "https://example.org/r.git",
				connected: {
					repo: "42",
					branch: "main",
					commit: "c".repeat(40),
					generation: "a".repeat(64),
					command: "make deps",
					timeoutMs: 3000,
				},
			};
			const probe = mock.method(DockerSandboxHandle.prototype, "ask", async () => success);
			const log = mock.method(console, "info", () => {});
			try {
				for (const restart of [false, true]) {
					const kept = restart ? "222222222222" : "111111111111";
					let cold = 0,
						setups = 0,
						free = 8 * GiB;
					const dropped: string[] = [];
					const built: string[] = [];
					const attachments: [string, boolean | undefined][] = [];
					const limits: Limits = { slots };
					function executor() {
						const runner = new LocalExecutor({ uid, machineId }, limits, false, false, [profile], {
							mode: "restricted",
							allow: [],
						});
						Object.assign(runner, {
							warmSpares: true,
							spareReseed: true,
							spareSetupTimes: true,
							sessionVolumes: true,
							inventoryStarted: true,
							dockerHealth: { ok: true },
							availableMemory: () => free,
							disk: async () => 100e9,
							dropSpare: async (raw: string) => {
								dropped.push(raw);
							},
							blockedNetwork: true,
							memoryEvents: true,
						});
						runner.network.prepare = async () => {};
						runner.network.blocked = async () => ({ broker: "a".repeat(64), hosts: [], overflow: 0 });
						runner.network.attach = async (raw, _name, relay) => {
							attachments.push([raw, relay]);
						};
						runner.provider.create = async input => {
							if (!input.reservedId) {
								cold++;
								return kept;
							}
							assert.equal(input.ownData, "required");
							assert.equal(input.sessionId, "@ready");
							built.push(input.reservedId);
							return input.reservedId;
						};
						runner.provider.connect = async raw =>
							({
								uid,
								profile,
								ownData: raw !== kept,
								cwd: "/workspace",
								ask: async () => success,
								run: async (command: string) => {
									if (command === "exec 2>&1; make deps") setups++;
									return {
										exitCode: 0,
										stdout: command.includes("wlp:dir") ? "wlp:dir ." : recipe.connected.commit,
										stderr: "",
									};
								},
							}) as unknown as DockerSandboxHandle;
						return runner;
					}
					let runner = executor();
					const sandboxes = (sessionId: string) =>
						machineLayer(
							{
								who: { uid, sessionId, machineId },
								channel: { authenticated: true },
								facts: async () => ({ report: runner.report() }),
								again: async (_name: string, args: Args<"create"> | Args<"connect">) =>
									"profile" in args
										? runner.create(
												sessionId,
												args.profile,
												args.screenshots,
												args.harness,
												args.size,
												args.prepared,
												args.mirrorRepo,
												args.spare,
											)
										: runner.lifecycle("connect", args.id, sessionId),
								request: async (name: string, args: Args<"seedSpare">) => {
									assert.equal(name, "seedSpare");
									return runner.seedSpare(sessionId, args.id, args.spare, args.screenshots);
								},
							} as never,
							{} as import("../server/src/sandbox/api.js").SandboxLayer,
						).sandboxes;
					const createItem = (sessionId: string) =>
						sandboxes(sessionId).create({
							...sessionSandboxInput({
								uid,
								sessionId,
								profile,
								harness: "windlass",
								origin: { kind: "item", itemId: "i_fixture", role: "builder" },
							}),
							mirrorRepo: "42",
							spareRecipe: async () => recipe,
						});
					const first = await createItem("s_first");
					if (restart) {
						const old = runner.boxes.get(first)!;
						runner = executor();
						runner.boxes.set(first, { ...old }); // Inventory rediscovers the running sandbox, with no recipe on disk.
						const found = await runner.lifecycle("connect", first, "s_first");
						assert.ok(validValue("connect", found) && found?.needsSpareSeed);
						assert.throws(() => runner.seedSpare("s_second", first, recipe));
						let authorize!: () => void;
						const resumed = await sandboxes("s_first").connect(first, {
							spareSeed: async () => {
								await new Promise<void>(resolve => {
									authorize = resolve;
								});
								return recipe;
							},
						});
						assert.ok(resumed, "the real turn resumes while the server authorizes a fresh recipe");
						authorize();
						await until(() => !runner.canReseed);
						assert.equal(runner.seedSpare("s_first", first, recipe), false);
					}
					const box = runner.boxes.get(first)!;
					const client = new Session("s_first", runner, () => {});
					const socket = new CheckSocket();
					client.attach(socket as unknown as WebSocket, {
						runnerVersion: "0.3.4",
						machineId,
						ticket: "ticket",
						signature: "fixture",
					});
					socket.frame({ kind: "welcome", protocol: 1, conversation: "s_first", received: 0, resumed: false });
					let seq = 0;
					async function request<N extends Name>(name: N, args: Args<N>) {
						const id = "op" + ++seq;
						socket.frame({ kind: "msg", seq, ack: 0, body: { kind: "op", id, name, args } });
						await until(() => socket.sent.some(f => f.body?.kind === "res" && f.body.id === id));
						const response = socket.sent.find(f => f.body?.kind === "res" && f.body.id === id)!.body;
						assert.ok(response?.kind === "res" && response.ok, JSON.stringify(response));
						return response.value;
					}
					let endTurn!: () => void, finishStatus!: () => void;
					const start = mock.method(DockerSandboxHandle.prototype, "start", () => ({
						ended: new Promise(resolve => {
							endTurn = () => resolve({ code: 0, signal: null, error: null });
						}),
					}));
					const file = mock.method(DockerSandboxHandle.prototype, "readTextFile", async () => "changed");
					const status = mock.method(DockerSandboxHandle.prototype, "run", async (command: string) => {
						assert.equal(command, STATUS_COMMAND);
						await new Promise<void>(resolve => {
							finishStatus = resolve;
						});
						return { exitCode: 0, timedOut: false, aborted: false, stdout: " M README.md\0", stderr: "" };
					});
					try {
						const turn = () => request("start", { id: first, tag: "r123456789abc", argv: ["windlass", "acp"] });
						await turn();
						await runner.maintainSpares();
						assert.equal(built.length, 0);
						endTurn();
						await until(() => box.busy === 0);
						limits.maxRunning = 1;
						await runner.maintainSpares();
						assert.equal(built.length, 0, "a kept box still counts against --max-running");
						delete limits.maxRunning;
						limits.sandboxMemory = 6 * GiB;
						await runner.maintainSpares();
						assert.equal(built.length, 0, "a kept box still counts against --sandbox-memory");
						delete limits.sandboxMemory;
						free = slots.unit.memoryBytes;
						await runner.maintainSpares();
						assert.equal(built.length, 0, "leave the OS its reserve");
						free = 8 * GiB;
						await runner.maintainSpares();
						await until(() => runner.report().warmSpares?.ready === 1);
						if (restart) {
							await turn();
							await until(() => dropped.length === 1);
							await runner.maintainSpares();
							assert.deepEqual(dropped, built, "the resumed ACP turn reclaimed the borrowed slot");
							endTurn();
							await until(() => box.busy === 0);
							await runner.maintainSpares();
							await until(() => runner.report().warmSpares?.ready === 1);
						}
						assert.equal(await request("readTextFile", { id: first, path: "README.md" }), "changed");
						assert.equal(await request("memoryEvents", { id: first }), null);
						await request("blockedNetwork", { id: first, turn: 1, retained: [] });
						const reading = request("run", { id: first, command: STATUS_COMMAND });
						await until(() => !!finishStatus);
						await runner.maintainSpares();
						assert.equal(runner.report().warmSpares?.ready, 1, "the spare survives maintenance during git status");
						finishStatus();
						assert.deepEqual(await reading, {
							exitCode: 0,
							timedOut: false,
							aborted: false,
							stdout: " M README.md\0",
							stderr: "",
						});
					} finally {
						finishStatus?.();
						endTurn?.();
						start.mock.restore();
						file.mock.restore();
						status.mock.restore();
						client.channel.close();
					}
					const ready = built.at(-1)!;
					assert.deepEqual(attachments.at(-1), [ready, false]);
					assert.equal(runner.report().sandboxes.length, 1);
					assert.equal(box.state, "running");
					const second = await createItem("s_second");
					assert.notEqual(second, first);
					assert.ok(second.endsWith(ready));
					assert.equal(cold, 1);
					assert.equal(setups, restart ? 2 : 1);
					assert.throws(() => runner.running(second, "s_first"));
					assert.equal(runner.running(first, "s_first"), box);
					const claimed = await runner.lifecycle("connect", second, "s_second");
					assert.ok(validValue("connect", claimed) && claimed?.readyKey && claimed.readySetup && claimed.ownData);
					assert.equal(runner.report().warmSpares?.ready, 0);
					assert.ok(log.mock.calls.some(call => call.arguments[0] === `spare.build id=${ready} reason=ready`));
					assert.ok(log.mock.calls.some(call => call.arguments[0] === `spare.claim id=${ready} reason=recipe-match`));
				}
			} finally {
				probe.mock.restore();
				log.mock.restore();
			}
		},
	);

	await checkControl("an unfinished spare yields a cold create without waiting for setup to exit", async () => {
		const runner = new LocalExecutor({ uid: "u_fixture", machineId }, { slots: { ...slots, max: 1 } });
		const recipe = { url: "https://example.org/repo.git" };
		let finish!: () => void,
			signal: AbortSignal | undefined,
			dropped = false;
		let cold = 0;
		Object.assign(runner, {
			warmSpares: true,
			sessionVolumes: true,
			inventoryStarted: true,
			dockerHealth: { ok: true },
			availableMemory: () => 32 * 2 ** 30,
			disk: async () => 100e9,
			dropSpare: async () => {
				dropped = true;
			},
			buildSpare: async (_raw: string, _spec: unknown, abort: AbortSignal) => {
				signal = abort;
				await new Promise<void>(resolve => {
					finish = resolve;
				});
			},
		});
		runner.network.prepare = runner.network.attach = async () => {};
		runner.provider.create = async () => (++cold).toString().padStart(12, "0");
		const first = await runner.create("s_first", "docker-hardened", false, undefined, 1, undefined, undefined, recipe);
		runner.boxes.get(first)!.state = "paused";
		await runner.maintainSpares();
		assert.ok(signal);
		try {
			const starting = runner.create("s_second", "docker-hardened", false, undefined, 1, undefined, undefined, recipe);
			await until(() => cold === 2);
			assert.ok(signal.aborted);
			assert.equal(dropped, false);
			assert.ok(runner.boxes.has(await starting));
		} finally {
			finish();
		}
		await until(() => dropped);
	});

	await checkControl("the Windlass spare selects its own data volume before Docker can run setup", async () => {
		const runner = new LocalExecutor({ uid: "u_fixture", machineId }, {});
		const reached = new Error("volume selected");
		const volumes: (string | undefined)[] = [];
		runner.ownedVolume = async (_create, _name, sandbox) => {
			volumes.push(sandbox);
			throw reached;
		};
		const input = { uid: "u_fixture", sessionId: "@ready", profile, reservedId: raw } as const;
		await assert.rejects(runner.provider.create({ ...input, ownData: "required" }), error => error === reached);
		await assert.rejects(
			runner.provider.create({ ...input, sessionId: session, ownData: true }),
			error => error === reached,
		);
		assert.deepEqual(volumes, [raw, undefined]);
	});

	await checkControl(
		"the executor admits on free disk, claims once, binds the new session and falls back cold under pressure",
		async () => {
			const owner = new LocalExecutor(
				{ uid: "u_fixture", machineId: "m_0123456789abcdef" },
				{ slots: { ...slots, max: 1 } },
			);
			const built: string[] = [],
				removed: string[] = [];
			const recipe = {
				url: "https://example.org/fixture.git",
				connected: {
					repo: "42",
					branch: "main",
					commit: "c".repeat(40),
					generation: "a".repeat(64),
					command: "make deps",
					timeoutMs: 3000,
				},
			};
			let setupRuns = 0;
			const oldRecipe = join(dir, `recent-${machineId}.json`);
			let cold = 0,
				disk = 100e9;
			Object.assign(owner, {
				warmSpares: true,
				spareSetupTimes: true,
				sessionVolumes: true,
				inventoryStarted: true,
				dockerHealth: { ok: true },
				availableMemory: () => 32 * 2 ** 30,
				disk: async () => disk,
				dropSpare: async (raw: string) => {
					removed.push(raw);
				},
			});
			owner.network.prepare = owner.network.attach = async () => {};
			owner.provider.create = async input => {
				if (input.reservedId) {
					built.push(input.reservedId);
					return input.reservedId;
				}
				return (++cold).toString(16).padStart(12, "0");
			};
			owner.provider.connect = async () =>
				({
					uid: "u_fixture",
					profile: "docker-hardened",
					ownData: true,
					cwd: "/workspace",
					run: async (command: string) => {
						if (command === "exec 2>&1; make deps") setupRuns++;
						return {
							exitCode: 0,
							stdout: command.includes("wlp:dir") ? "wlp:dir ." : recipe.connected.commit,
							stderr: "",
						};
					},
				}) as unknown as DockerSandboxHandle;
			owner.modelRelay.endSandbox = owner.provider.destroy = async () => {};
			writeFileSync(
				oldRecipe,
				JSON.stringify({
					uid: owner.identity.uid,
					spec: { context: "previous process", args: { profile: "docker-hardened", spare: recipe, mirrorRepo: "42" } },
				}),
			);
			await owner.maintainSpares();
			assert.deepEqual(built, [], "restart ignores even a valid recipe from disk until a real create");
			unlinkSync(oldRecipe);
			const first = await owner.create("s_first", "docker-hardened", false, undefined, 1, undefined, "42", recipe);
			assert.ok(!readdirSync(dir).includes(`recent-${machineId}.json`), "create does not persist a recipe");
			owner.boxes.get(first)!.state = "paused";
			await owner.lifecycle("destroy", first, "s_first");
			const beforeBuild = Date.now();
			await owner.maintainSpares();
			await until(() => owner.report().warmSpares?.ready === 1);
			assert.equal(owner.report().sandboxes.length, 0);
			const beforeClaim = Date.now();
			const second = await owner.create("s_second", "docker-hardened", false, undefined, 1, undefined, "42", recipe);
			assert.ok(second.endsWith(built[0]!));
			assert.equal(cold, 1);
			assert.throws(() => owner.running(second, "s_first"));
			const connected = await owner.lifecycle("connect", second, "s_second");
			assert.ok(validValue("connect", connected) && connected?.readySetup);
			const setup = connected.readySetup;
			assert.equal(setupRuns, 1);
			assert.ok(setup.startedAt >= beforeBuild && setup.startedAt + setup.durationMs <= beforeClaim);
			const { readySetupItems } = await import("../server/src/actors/agent-session.js");
			const [started, ended] = readySetupItems(1, recipe.connected, connected.readySetup);
			assert.equal(started!.id, ended!.id);
			assert.deepEqual(
				[started, ended].map(i => [i!.kind, i!.command, i!.state, i!.exitCode, i!.at, i!.durationMs]),
				[
					["setup", "make deps", "started", null, setup.startedAt, null],
					["setup", "make deps", "succeeded", 0, setup.startedAt + setup.durationMs, setup.durationMs],
				],
			);
			owner.spareSetupTimes = false;
			const legacy = await owner.lifecycle("connect", second, "s_second");
			assert.ok(validValue("connect", legacy) && legacy?.readyKey && !legacy.readySetup);
			owner.boxes.get(second)!.state = "paused";
			await owner.lifecycle("destroy", second, "s_second");
			await owner.maintainSpares();
			await until(() => owner.report().warmSpares?.ready === 1);
			disk = 6e9;
			let finish!: () => void;
			Object.assign(owner, {
				dropSpare: async (raw: string) => {
					removed.push(raw);
					await new Promise<void>(resolve => {
						finish = resolve;
					});
				},
			});
			const changed = { ...recipe, connected: { ...recipe.connected, command: "make changed" } };
			const log = mock.method(console, "info", () => {});
			try {
				const starting = owner.create("s_third", "docker-hardened", false, undefined, 1, undefined, "42", changed);
				await until(() => !!finish);
				assert.equal(cold, 1, "the cold container waits for removal to finish");
				finish();
				const third = await starting;
				assert.equal(cold, 2);
				assert.equal(owner.boxes.get(third)?.claim, undefined);
				assert.deepEqual(removed, [built[1]]);
				assert.deepEqual(
					log.mock.calls.map(call => call.arguments[0]),
					[
						`spare.skip id=${built[1]} reason=capacity`,
						`spare.skip id=${owner.boxes.get(third)!.raw} reason=recipe-mismatch`,
					],
				);
			} finally {
				finish?.();
				log.mock.restore();
			}
		},
	);
} finally {
	for (const file of readdirSync(dir)) unlinkSync(join(dir, file));
	rmdirSync(dir);
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exitCode = failures ? 1 : 0;
