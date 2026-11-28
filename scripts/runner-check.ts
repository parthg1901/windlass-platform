import { loginHttp } from "./login-http.js";
import { cloneReadyBase } from "../server/src/github/git.js";
import { runSetupCommand } from "../server/src/sandbox/setup.js";
import { MIRROR_ROOT, mirrorOwner } from "../server/src/sandbox/git-mirrors.js";
import { DockerSnapshots } from "../server/src/sandbox/snapshots.js";
/** Run: cd server && npx tsx ../scripts/runner-check.ts
 * Use --screenshots-only to check the screenshots pins, or --harness-only for Claude login and isolation.
 * Without a flag it runs --profiles-only and --harness-only first; --main-only leaves them out (CI runs them in a job of their own).
 * CI splits --main-only into --service-only and --outages-only. The five-minute outage and two-minute sleep are wall time.
 */
import { writeProofDocker } from "./runner-proof-docker.js";
import { imageId } from "./check-image.js";
import { localListeners } from "./check-listeners.js";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";
import { AcpConnection, LineSplitter } from "../server/src/sandbox/acp.js";
import { DATA_DIR, docker, LABEL_ARG, MACHINE_LABEL, SHOTS_IMAGE } from "../server/src/sandbox/docker.js";
import { containerName, DockerSandboxes, DockerSandboxHandle } from "../server/src/sandbox/sandboxes.js";
import { COMMON_RUN_FLAGS, commonRunFlags } from "../server/src/sandbox/profiles.js";
import { tokenFilePath } from "../server/src/sandbox/token-file.js";
import { PAIRING_TTL_MS, REFUSED_RETRY_MS, refuse, type Refusal } from "../server/src/runner/control.js";
import { RUNNER_GRACE_MS } from "../server/src/runner/protocol.js";
import { optionsDigest } from "../server/src/runner/catalog.js";
import { certify } from "../server/src/runner/frame-auth.js";
import { ConversationLost, ServerChannel } from "../server/src/runner/channel.js";
import { safeSentence } from "../runner/src/audit.js";
import { localSizing } from "../runner/src/sizing.js";
import { stub, until } from "./runner-stub-server.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const tmp = await mkdtemp(join(tmpdir(), "wlp-runner-check-"));
const state = join(tmp, "state");
const bundle = join(tmp, "runner.cjs");
const exec = promisify(execFile);
const ok = (s: string) => console.log("PASS  " + s);
const children = new Set<ChildProcess>();
const env = (dir: string) => ({
	PATH: process.env.PATH,
	HOME: tmp,
	RIVET_LOG_LEVEL: "silent",
	WLP_RUNNER_STATE_DIR: dir,
});
async function stop(p: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
	if (p.exitCode !== null || p.signalCode) return;
	const closed = new Promise<void>(resolve => p.once("exit", () => resolve()));
	p.kill("SIGCONT");
	p.kill(signal);
	const timer = setTimeout(() => p.kill("SIGKILL"), 12_000);
	try {
		await closed;
	} finally {
		clearTimeout(timer);
	}
}
async function scripted(ch: ServerChannel, id: string, interrupt: () => Promise<void>, resume?: string) {
	const fixture = JSON.parse(await readFile(join(root, "fixtures/acp-probe/script.json"), "utf8"));
	fixture.responses.shift(); // omit the network example; the shell step is local
	const path = "/workspace/fixture.json";
	await ch.request("writeTextFile", { id, path, content: JSON.stringify(fixture) });
	const events: string[] = [],
		seq = new Set<number>();
	let duplicates = 0;
	let dropped: Promise<void> | undefined;
	const acp = new AcpConnection(
		line => ch.write(process.id, line + "\n"),
		{
			async request() {
				return { outcome: { outcome: "cancelled" } };
			},
			notification(method, params) {
				if (method !== "_windlass/event") return;
				const e = params.event as { type: string; seq?: number };
				if (e.seq !== undefined) {
					if (seq.has(e.seq)) duplicates++;
					seq.add(e.seq);
				}
				events.push(e.type);
				if (!dropped && e.type === "tool.started") dropped = interrupt();
			},
		},
		"windlass",
	);
	const lines = new LineSplitter(line => acp.receive(line));
	const process = ch.start(
		{ id, argv: ["windlass", "acp"], tag: "fixture", options: { env: { WINDLASS_ACP_SCRIPT: path } } },
		(fd, s) => {
			if (fd === 1) lines.push(s);
		},
	);
	const call = <T>(method: string, params: Record<string, unknown>) =>
		acp.request<T>(method, params, { timeoutMs: 430_000 });
	await call("initialize", {
		protocolVersion: 1,
		clientInfo: { name: "runner-check", version: "1" },
		clientCapabilities: { _meta: { windlass: { events: true, updates: false } } },
	});
	const params = { cwd: "/workspace", mcpServers: [], _meta: { windlass: { approval: "full", attended: true } } };
	const opened = await call<{ sessionId: string }>(resume ? "session/resume" : "session/new", {
		...params,
		...(resume ? { sessionId: resume } : {}),
	});
	const sessionId = resume ?? opened.sessionId;
	const result = await call<{ stopReason: string }>("session/prompt", {
		sessionId,
		prompt: [{ type: "text", text: "Run the local fixture." }],
	});
	await dropped;
	assert.ok(dropped);
	assert.ok(events.includes("execution.succeeded"));
	assert.equal(duplicates, 0);
	assert.equal(result.stopReason, "end_turn");
	await call("session/close", { sessionId });
	ch.closeIn(process.id);
	assert.equal((await process.ended).code, 0);
	return sessionId;
}
// One integration against the actual platform routes, user and machine actors. The demo
// account has no GitHub link, so this also exercises the nullable login in PairStatus.
async function realMachine(runnerImage: string) {
	const {
		engine: port,
		http: [http],
	} = await localListeners();
	const endpoint = "http://127.0.0.1:" + port;
	const platform = "http://127.0.0.1:" + http;
	const node = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
		cwd: join(root, "server"),
		stdio: "ignore",
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			WLP_SECRET: randomBytes(32).toString("hex"),
			WLP_MACHINES: "1",
			WLP_REQUIRE_SIGNED_RUNNER: "1",
			WLP_PLATFORM_KEY: certify(generateKeyPairSync("ed25519").privateKey, 1, Date.now() + 86_400_000),
			WLP_DEMO: "1",
			WLP_SANDBOX: "fake",
			WLP_PUBLIC_URL: platform,
			WLP_HTTP_PORT: String(http),
			RIVET_RUN_ENGINE_PORT: String(port),
			RIVET_LOG_LEVEL: "silent",
			RIVETKIT_STORAGE_PATH: join(tmp, "real-engine"),
		},
	});
	const directory = join(tmp, "real-runner");
	const name = "wlp-check-runner-" + randomBytes(6).toString("hex");
	let service: ChildProcess | undefined;
	let output = "",
		stderr = "",
		health = "";
	try {
		await until(
			async () => {
				if (node.exitCode !== null) throw Error("Local platform exited during startup.");
				return (await fetch(platform + "/health").catch(() => null))?.ok === true;
			},
			"Local platform did not start.",
			90_000,
		);
		const { createClient } = await import("../server/src/client.js");
		const client = createClient<import("../server/src/client.js").Registry>({ endpoint, namespace: "default" });
		const auth = await loginHttp(platform).demo();
		const user = client.user.getOrCreate([auth.profile.uid], { params: { token: auth.token } });
		await mkdir(directory, { mode: 0o700 });
		const socket = "/var/run/docker.sock";
		service = spawn(
			"docker",
			[
				"run",
				"--rm",
				"--pull",
				"never",
				"--name",
				name,
				"--label",
				LABEL_ARG,
				"--log-driver",
				"none",
				"--network",
				"host",
				"--user",
				`${process.getuid!()}:${process.getgid!()}`,
				"--group-add",
				String((await stat(socket)).gid),
				"-e",
				"HOME=/tmp",
				"-v",
				socket + ":" + socket,
				"-v",
				directory + ":/var/lib/windlass-runner",
				runnerImage,
				"--platform",
				platform,
				"--allow-profile",
				"docker-windlass-sandbox",
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		service.stderr!.on("data", chunk => {
			stderr = (stderr + chunk).slice(-8192);
		});
		service.stdout!.on("data", chunk => {
			output = (output + chunk).slice(-8192);
		});
		await until(() => /enter [A-Z0-9]{4}-[A-Z0-9]{4}/.test(output), "Real platform did not start pairing.");
		const code = /enter ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(output)![1];
		const claim = await user.claimMachine({ code });
		// The runner prints the machine key's fingerprint, and the page is shown the same one, worked out from the key it paired with.
		await until(
			() => output.includes(`Machine key: ${claim.keyFingerprint}.`),
			`The runner did not print the machine key the page shows (${claim.keyFingerprint}).`,
		);
		const machine = await user.confirmMachine({ code, keyConfirmed: true });
		await until(
			async () => {
				const current = (await user.machines()).find(m => m.machineId === machine.machineId);
				health = current?.commandSandbox?.ok === false ? current.commandSandbox.reason : "";
				return current?.status === "online" && current.freeDiskBytes !== null;
			},
			"The real machine actor did not accept the runner's hello and report.",
			60_000,
		);
		const connected = (await user.machines()).find(m => m.machineId === machine.machineId)!;
		assert.deepEqual(connected.allowedProfiles, ["docker-hardened", "docker-windlass-sandbox"]);
		ok(
			"The packaged runner reported its opt-in and bubblewrap probe: " +
				(connected.commandSandbox?.ok ? "passed." : health),
		);
		assert.match(output, /Paired with an account without a GitHub login/);
		// The test client sees only the runner's filesystem. Inspect through the host daemon.
		const filterPath = "/usr/local/bin/seccomp-bwrap.json";
		const nameForFilter = "wlp-check-seccomp-" + randomBytes(6).toString("hex");
		const { stdout: created } = await exec("docker", [
			"exec",
			name,
			"docker",
			"create",
			"--pull",
			"never",
			"--name",
			nameForFilter,
			"--security-opt",
			"seccomp=" + filterPath,
			runnerImage,
			"status",
		]);
		try {
			const { stdout } = await exec("docker", [
				"inspect",
				"--format",
				"{{json .HostConfig.SecurityOpt}}",
				created.trim(),
			]);
			const option = (JSON.parse(stdout) as string[]).find(opt => opt.startsWith("seccomp="));
			assert.deepEqual(
				JSON.parse(option!.slice(8)),
				JSON.parse(await readFile(join(root, "sandbox/seccomp-bwrap.json"), "utf8")),
			);
			ok("The runner image’s Docker CLI sent the bundled seccomp JSON to the host daemon.");
		} finally {
			await docker(["rm", nameForFilter], { check: true });
		}
		const pruneStarted = performance.now();
		await assert.rejects(
			exec("docker", ["exec", name, "windlass-runner", "prune"], { timeout: 3_000 }),
			(error: { code?: number; stderr?: string }) =>
				error.code === 1 &&
				!!error.stderr?.includes(
					"run prune in a one-off runner container with the same state volume and Docker socket",
				),
		);
		ok(
			`Prune refused the running service in ${((performance.now() - pruneStarted) / 1000).toFixed(2)}s and explained how to prune after stopping it.`,
		);
		const publicKey = async () =>
			createPublicKey(JSON.parse(await readFile(join(directory, "pair.json"), "utf8")).key).export({
				type: "spki",
				format: "der",
			});
		const formerKey = await publicKey();
		await user.removeMachine({ machineId: machine.machineId, removeSandboxes: false });
		await until(() => output.includes("was removed"), "Real actor removal did not reach the runner.");
		assert.equal(service.exitCode, null);
		async function pairThroughService() {
			output = "";
			const pairing = exec("docker", ["exec", name, "windlass-runner", "pair"], { timeout: 60_000 });
			await until(
				() => /enter [A-Z0-9]{4}-[A-Z0-9]{4}/.test(output),
				"The local pair command did not start a fresh pairing.",
			);
			const code = /enter ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(output)![1];
			await user.claimMachine({ code });
			const paired = await user.confirmMachine({ code, keyConfirmed: true });
			assert.match((await pairing).stdout, /Paired with/);
			await until(
				async () => (await user.machines()).some(m => m.machineId === paired.machineId && m.status === "online"),
				"The new pairing did not reconnect.",
			);
			return paired.machineId;
		}
		const replacement = await pairThroughService();
		assert.notEqual(replacement, machine.machineId);
		assert.ok(!formerKey.equals(await publicKey()));
		assert.notEqual(await pairThroughService(), replacement);
		const status = await exec("docker", ["exec", name, "windlass-runner", "status"]);
		for (const id of [machine.machineId, replacement]) assert.ok(status.stdout.includes(id + " (previous pairing)"));
		ok(
			"The packaged runner pairs against the real actor, parks on removal, and accepts a local pair command both while parked and while online.",
		);
	} catch (error) {
		for (const [source, tail] of [
			["stdout", output],
			["stderr", stderr],
			["health", health],
		]) {
			const lines = tail.trim().split("\n").slice(-6);
			for (const line of lines) {
				const clean = safeSentence(line.replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b|\b(?:ws|wss):\/\/\S+/gi, "[redacted]"));
				if (clean) console.error(`Runner ${source}: ${clean.slice(0, 500)}`);
			}
		}
		throw error;
	} finally {
		if (service) {
			await stop(service);
			await docker(["rm", "-f", name]);
		}
		await stop(node);
	}
}
// Build the rollback target with its own state parser, discovery and session code.
async function rollbackRunner(image: string) {
	const previous = join(tmp, "b12b61e");
	await mkdir(previous);
	const archive = join(previous, "sources.tar");
	await exec("git", ["archive", "-o", archive, "b12b61e", "runner", "server/src", "server/tsconfig.json"], {
		cwd: root,
	});
	await exec("tar", ["-xf", archive, "-C", previous]);
	for (const dir of ["server", "runner"])
		await symlink(join(root, dir, "node_modules"), join(previous, dir, "node_modules"));
	const program = join(previous, "runner.cjs");
	await exec(process.execPath, ["runner/bundle.mjs", image, program], { cwd: previous });
	return program;
}
async function check(image: string, shotsPin?: string, claudePin?: string) {
	const srv = await stub(join(tmp, "engine"));
	const { machineId, uid, sessionId } = srv;
	const setupName = "wlp-check-setup-" + randomBytes(6).toString("hex");
	const hostedRaw = randomBytes(6).toString("hex");
	const hostedName = containerName(hostedRaw);
	const marker = "dev.windlass-platform.check=" + randomBytes(6).toString("hex");
	const ownedFilters = ["--filter", "label=" + LABEL_ARG, "--filter", "label=" + MACHINE_LABEL + "=" + machineId];
	const containers = async () =>
		(await docker(["ps", "-a", ...ownedFilters, "--format", "{{.Names}}"], { check: true })).stdout.trim();
	const reported = (id: string) => srv.state.report!.sandboxes.some(box => box.id === id);
	const testClock = join(tmp, "owner-clock.cjs");
	await writeFile(
		testClock,
		`const timers = require("node:timers/promises"); const wait = timers.setTimeout;
timers.setTimeout = (ms, ...args) => wait(ms === ${REFUSED_RETRY_MS} ? 3500 : ms, ...args);
const timeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = ms => timeout(ms === ${PAIRING_TTL_MS} ? 6500 : ms);\n`,
	);
	function run(
		dir = state,
		preload?: string,
		program = bundle,
		dockerEnv: NodeJS.ProcessEnv = {},
		{ platform = srv.platform, flags = [] }: { platform?: string; flags?: string[] } = {},
	) {
		const child = spawn(
			process.execPath,
			[
				"--require",
				testClock,
				...(preload ? ["--require", preload] : []),
				program,
				"--platform",
				platform,
				"--egress",
				"open",
				...flags,
			],
			{ env: { ...env(dir), ...dockerEnv }, stdio: ["ignore", "pipe", "pipe"] },
		);
		let output = "";
		child.stdout.on("data", s => {
			output += s;
		});
		child.stderr.on("data", s => {
			output += s;
		});
		children.add(child);
		child.once("exit", () => children.delete(child));
		return { child, output: () => output };
	}
	async function cli(command: string, dir = state) {
		return (await exec(process.execPath, [bundle, command], { env: env(dir), timeout: 20_000 })).stdout;
	}
	const limitsOf = async (name: string) => {
		const [box] = JSON.parse((await docker(["inspect", name], { check: true })).stdout);
		return [
			box.HostConfig.NanoCpus,
			box.HostConfig.Memory,
			box.HostConfig.MemorySwap,
			box.HostConfig.PidsLimit,
			box.HostConfig.CpuShares,
			box.Config.Labels["dev.windlass-platform.slots"],
		];
	};
	let hosted = false;
	try {
		await mkdir(state, { mode: 0o700 });
		if (process.argv.includes("--snapshots-only")) {
			const service = run(
				state,
				undefined,
				bundle,
				{},
				{ flags: ["--slots", "3", "--slot-cpus", "0.5", "--slot-memory", "1g", "--keep-free", "0GB"] },
			);
			try {
				await until(() => !!srv.state.report?.slots, "Runner did not report");
				const key = {
					writer: true,
					attempt: randomBytes(16).toString("hex"),
					repo: "123",
					inputs: "a".repeat(64),
					generation: "c".repeat(64),
				};
				const { writer: _writer, ...requestKey } = key;
				assert.equal(srv.state.report?.gitMirrors, true);
				const slot = MIRROR_ROOT + "/" + mirrorOwner(uid, key.repo);
				const source = { ...requestKey, commit: "b".repeat(40), created: Date.now() };
				const profile = "docker-hardened" as const;
				async function session(sessionId: string, privateData: boolean, request = key) {
					await srv.attach(sessionId);
					const channel = srv.channel(sessionId);
					return {
						channel,
						create: (size: number) =>
							channel.request("create", {
								profile,
								size,
								mirrorRepo: request.repo,
								prepared: { ...request, privateData },
							}),
					};
				}
				const a = await session(sessionId, false),
					id = await a.create(4);
				assert.equal(
					(await a.channel.request("run", { id, command: `test ! -r ${slot} && test ! -w ${slot}` })).exitCode,
					0,
				);
				// The slot is read-only in the session. The runner's save helper writes it from a stage.
				assert.notEqual(
					(
						await a.channel.request("run", {
							id,
							options: { gitUser: true },
							command: `mountpoint -q ${slot} && touch ${slot}/runner-proof`,
						})
					).exitCode,
					0,
				);
				const stage = randomBytes(16).toString("hex");
				const staged = await a.channel.request("run", {
					id,
					options: { gitUser: true },
					command: [
						"set -e",
						`dir=/tmp/wlp-transport-${stage}.mirror`,
						'mkdir -m 700 "$dir"',
						'cd "$dir"',
						"git init -q --bare seed",
						"export GIT_DIR=seed",
						"tree=$(git mktree </dev/null)",
						'commit=$(git -c user.name=r -c user.email=r@example.org commit-tree "$tree" -m proof)',
						'echo "$commit refs/heads/main" > seed/packed-refs',
						'echo "ref: refs/heads/main" > seed/HEAD',
						'echo "$commit"',
					].join("\n"),
				});
				assert.equal(staged.exitCode, 0, staged.stderr);
				const proof = staged.stdout.trim();
				assert.equal(await a.channel.request("saveMirror", { id, stage, partial: false }), true);
				assert.deepEqual(await limitsOf(containerName(id.slice(-12))), [
					1.5e9,
					3 * 2 ** 30,
					3 * 2 ** 30,
					1536,
					256,
					"3",
				]);
				assert.equal((await a.channel.request("run", { id, command: "touch /workspace/build-output" })).exitCode, 0);
				assert.equal(await a.channel.request("saveSnapshot", { id, source }), true);
				assert.equal(await a.channel.request("saveSnapshot", { id, source }), false);
				await a.channel.request("run", { id, command: "touch /workspace/agent-wrote-this" });
				await a.channel.request("destroy", { id });
				const next = { ...key, writer: false, attempt: randomBytes(16).toString("hex") };
				const b = await session(srv.other, true, next),
					restored = await b.create(2);
				const name = containerName(restored.slice(-12));
				assert.equal(
					(
						await b.channel.request("run", {
							id: restored,
							options: { gitUser: true },
							command: `mountpoint -q ${slot} && git --git-dir=${slot}/repo.git rev-parse HEAD`,
						})
					).stdout.trim(),
					proof,
				);
				const limits = [1e9, 2 ** 31, 2 ** 31, 1024, 256, "2"];
				assert.deepEqual(await limitsOf(name), limits);
				// Reconnect must repair drift using the reader's size, even when its producer was clamped.
				await docker(["update", "--cpus", "0.5", "--pids-limit", "512", name], { check: true });
				assert.deepEqual((await b.channel.request("connect", { id: restored }))?.snapshot, {
					...source,
					attempt: next.attempt,
				});
				assert.deepEqual(await limitsOf(name), limits);
				await until(() => reported(restored), "Restored sandbox missing from inventory");
				assert.deepEqual(srv.state.report?.slots, srv.state.helloSlots);
				assert.equal(srv.state.report?.slots?.max, 3);
				ok(
					"A snapshot restore gets its own two-slot limits and label, and reconnect repairs them using the consumer's size.",
				);
				assert.equal(
					(
						await b.channel.request("run", {
							id: restored,
							command: "test -e build-output && test ! -e agent-wrote-this",
						})
					).exitCode,
					0,
				);
				assert.equal(await b.channel.request("saveSnapshot", { id: restored, source }), false);
				await b.channel.request("destroy", { id: restored });
				const child = { ...key, writer: false, inputs: "f".repeat(64), attempt: randomBytes(16).toString("hex") };
				const childId = await a.channel.request("create", { profile, prepared: { ...child, privateData: false } });
				const childSource = { ...source, inputs: child.inputs, attempt: child.attempt };
				assert.equal(await a.channel.request("saveSnapshot", { id: childId, source: childSource }), false);
				await a.channel.request("destroy", { id: childId });
				ok("A cold subtask with a read-only request cannot save a snapshot.");
				const fresh = { ...key, inputs: "0".repeat(64), attempt: randomBytes(16).toString("hex") };
				// Reuse the accepted socket after destroy, with a different dependency key.
				const cold = await a.channel.request("create", { profile, prepared: { ...fresh, privateData: false } });
				const ran = await a.channel.request("run", {
					id: cold,
					command: 'test -n "$CHECK_TOKEN"',
					options: { secretEnv: { CHECK_TOKEN: "fixture" } },
				});
				assert.equal(ran.exitCode, 0);
				const dirty = { ...source, inputs: fresh.inputs, attempt: fresh.attempt };
				assert.equal(await a.channel.request("saveSnapshot", { id: cold, source: dirty }), false);
				await a.channel.request("destroy", { id: cold });
				ok("A runner refuses to save a sandbox after a command received secret environment variables.");
				ok("An authenticated machine save and private reviewer restore preserve only pre-turn files.");
				// Same two authenticated session sockets, same repository, no network dependency.
				const spare = {
					url: "https://fixture.invalid/owner/repo.git",
					connected: {
						repo: key.repo,
						branch: "main",
						commit: proof,
						command: "sleep 4 && touch ready-output",
						timeoutMs: 30_000,
						generation: key.generation,
					},
				};
				const args = { profile, mirrorRepo: key.repo, spare };
				const beforeCold = Date.now();
				const first = await a.channel.request("create", args);
				assert.equal((await a.channel.request("connect", { id: first }))?.startTimes?.spare, undefined);
				const coldBox = new DockerSandboxHandle(first.slice(-12), profile, uid);
				assert.ok(
					await cloneReadyBase(
						coldBox,
						spare.url,
						"main",
						proof,
						mirrorOwner(uid, key.repo),
						new AbortController().signal,
					),
				);
				assert.equal((await runSetupCommand(coldBox, { ...spare.connected, cwd: coldBox.cwd })).state, "succeeded");
				assert.equal(
					(await a.channel.request("run", { id: first, command: "test -e ready-output && touch first-session-only" }))
						.exitCode,
					0,
				);
				const coldMs = Date.now() - beforeCold;
				await a.channel.request("destroy", { id: first });
				await until(() => srv.state.report?.warmSpares?.ready === 1, "Runner did not prepare the cloned workspace");
				const beforeWarm = Date.now();
				const second = await b.channel.request("create", args);
				assert.notEqual(second, first);
				assert.equal((await b.channel.request("connect", { id: second }))?.startTimes?.spare, true);
				assert.equal(
					(
						await b.channel.request("run", {
							id: second,
							command: "test -e ready-output && test ! -e first-session-only && git rev-parse HEAD",
						})
					).stdout.trim(),
					proof,
				);
				const warmMs = Date.now() - beforeWarm;
				await assert.rejects(a.channel.request("run", { id: second, command: "pwd" }));
				assert.ok(warmMs < coldMs, `cold ${coldMs}ms, ready ${warmMs}ms`);
				ok(`Ready sandbox reached its first command in ${warmMs}ms vs ${coldMs}ms cold (4s setup fixture).`);
				await b.channel.request("destroy", { id: second });
			} finally {
				await stop(service.child);
				await new DockerSnapshots(machineId, image).drop(uid);
				await docker(["network", "rm", "wlp-open-" + machineId]);
			}
			return;
		}
		if (process.argv.includes("--sizing-only")) {
			for (const command of ["run", "setup"]) {
				for (const [flag, value] of [
					["--slots", "65"],
					["--slot-cpus", "999999"],
					["--slot-memory", "512m"],
					["--sandbox-memory", "1g"],
				]) {
					await assert.rejects(
						exec(process.execPath, [bundle, command, flag, value], { env: env(state) }),
						(e: { stderr?: string }) => !!e.stderr?.includes(flag),
					);
				}
			}
			const bin = join(tmp, "bin");
			await mkdir(bin);
			const prefix = "sizing-" + machineId + "-";
			await writeProofDocker(bin, prefix, (await exec("which", ["docker"])).stdout.trim(), undefined, [
				"wlp-egress-",
				"wlp-claude-relay-",
				"wlp-opencode-relay-",
				"wlp-harness-opencode-",
			]);
			const host = join(tmp, "two-cores.cjs");
			await writeFile(
				host,
				'const os = require("node:os"); os.availableParallelism = () => 2; os.totalmem = () => 12 * 2**30;',
			);
			const start = (flags: string[]) => run(state, host, bundle, { PATH: bin + ":" + process.env.PATH }, { flags });
			let service = start([]);
			try {
				await until(() => !!srv.state.report?.slots, "Missing default sizing report");
				await srv.attach(srv.other);
				const kept = await srv.channel(srv.other).request("create", { profile: "docker-hardened" });
				assert.deepEqual(await limitsOf(prefix + "agent-" + kept.slice(-12)), [
					2e9,
					4 * 2 ** 30,
					4 * 2 ** 30,
					1024,
					256,
					"1",
				]);
				srv.reset(srv.other);
				await stop(service.child);
				await until(() => !srv.online(), "Runner did not disconnect.");
				service = start(["--max-turns", "3", "--slot-cpus", "0.75", "--slot-memory", "2g"]);
				await until(() => srv.state.report?.slots?.max === 3, "Missing authenticated sizing report");
				const slots = srv.state.report!.slots!;
				assert.equal(slots.max, 3);
				assert.deepEqual(slots.unit, { cpus: 0.75, memoryBytes: 2 ** 31, pids: 512 });
				assert.deepEqual(srv.state.helloSlots, slots);
				await srv.attach(srv.other);
				await srv.channel(srv.other).request("connect", { id: kept });
				assert.deepEqual(await limitsOf(prefix + "agent-" + kept.slice(-12)), [
					0.75e9,
					2 ** 31,
					2 ** 31,
					512,
					256,
					"1",
				]);
				await srv.attach();
				const { weightedFifo } = await import("./machine-fairness-check.js");
				const created: string[] = [];
				await weightedFifo(slots, async (turn, size) => {
					const channel = srv.channel(turn === "large" ? sessionId : srv.other);
					const id = await channel.request("create", { profile: "docker-hardened", size });
					if (turn === "large") {
						created.push(id);
						assert.deepEqual(await limitsOf(prefix + "agent-" + id.slice(-12)), [
							1.5e9,
							2 ** 32,
							2 ** 32,
							1024,
							256,
							"2",
						]);
					} else assert.equal(id, kept);
				});
				assert.equal(created.length, 2);
				assert.equal(created[0], created[1]);
				ok(
					"Authenticated hello and inventory carry the same slots. Retried size-two create has one labelled container with twice the advertised limits.",
				);
			} finally {
				await stop(service.child);
			}
			return;
		}
		if (process.argv.includes("--profiles-only")) {
			const windlass = "docker-windlass-sandbox",
				hardened = "docker-hardened";
			const policyFlag = "--allow-profile";
			const denied = /--allow-profile docker-windlass-sandbox/;
			let service: ReturnType<typeof run>;
			async function start(flags: string[] = [], dir = state) {
				srv.state.report = null;
				service = run(dir, undefined, bundle, {}, { flags });
				await until(() => {
					assert.equal(service.child.exitCode, null, "Runner rejected its service flags");
					return !!srv.state.report;
				}, "Runner did not report");
				return srv.state.report!;
			}
			async function stopRunner() {
				srv.reset(sessionId);
				await stop(service.child);
				await until(() => !srv.online(), "Runner stayed connected");
			}
			const initial = await start();
			assert.deepEqual(initial.allowedProfiles, [hardened]);
			assert(!initial.commandSandbox.ok && denied.test(initial.commandSandbox.reason));
			await srv.attach();
			const refuse = async (request: Promise<unknown>) => {
				await assert.rejects(request, denied);
				assert.equal(srv.state.lastErrorKind, "refused");
			};
			await refuse(srv.channel(sessionId).request("create", { profile: windlass }));
			ok("A new pairing reports hardened only and refuses a Windlass create on the wire.");
			await stopRunner();
			const legacy = join(tmp, "legacy");
			await mkdir(legacy, { mode: 0o700 });
			// The pre-policy state volume contained a pair.json but no profile policy.
			await copyFile(join(state, "pair.json"), join(legacy, "pair.json"));
			assert.deepEqual((await start([], legacy)).allowedProfiles, [hardened, windlass]);
			await stopRunner();
			const allowed = await start([policyFlag, hardened, policyFlag, windlass]);
			assert.deepEqual(allowed.allowedProfiles, [hardened, windlass]);
			await stopRunner();
			assert.deepEqual((await start()).allowedProfiles, [hardened, windlass]);
			ok("An upgraded pairing keeps both profiles and an explicit opt-in survives restart.");
			await srv.attach();
			const handoff = srv.channel(sessionId);
			for (const profile of allowed.commandSandbox.ok ? ([hardened, windlass] as const) : ([hardened] as const)) {
				const id = await handoff.request("create", { profile });
				const path = tokenFilePath(id);
				await handoff.request("writeSecretFile", {
					id,
					path,
					content: JSON.stringify({ accessToken: "fake-runner-fixture", expiresAt: Date.now() + 3_600_000 }),
				});
				const fs = await handoff.request("ask", { id, argv: ["stat", "-f", "-c", "%T", path] });
				assert.equal(fs?.stdout.trim(), "tmpfs");
				const login = await handoff.request("ask", {
					id,
					argv: ["windlass", "login", "status"],
					options: { env: { WINDLASS_ACCESS_TOKEN_FILE: path } },
				});
				assert.equal(login?.code, 0);
				assert.ok(login?.stdout.includes(path));
				await handoff.request("destroy", { id });
				ok(profile + " passes the private tmpfs file to Windlass.");
			}

			// A hardened Windlass session has a data volume of its own; the Windlass sandbox profile keeps the machine's.
			assert.equal(srv.state.report?.sessionVolumes, true);
			const own = (sandbox: string) => `wlp-machine-${machineId}-${sandbox.slice(-12)}`;
			const mountsOf = async (sandbox: string) =>
				(
					JSON.parse(
						(await docker(["container", "inspect", containerName(sandbox.slice(-12))], { check: true })).stdout,
					)[0].Mounts as { Name?: string; Destination: string }[]
				)
					.map(m => `${m.Name}:${m.Destination}`)
					.join(" ");
			const volumeGone = async (name: string) => (await docker(["volume", "inspect", name])).code !== 0;
			await srv.attach(srv.other);
			const peer = srv.channel(srv.other);
			const a = await handoff.request("create", { profile: hardened }),
				b = await peer.request("create", { profile: hardened });
			assert.equal(await mountsOf(a), `${own(a)}:${DATA_DIR}`);
			assert.equal(await mountsOf(b), `${own(b)}:${DATA_DIR}`);
			const [volumeA] = JSON.parse((await docker(["volume", "inspect", own(a)], { check: true })).stdout);
			assert.deepEqual(
				[
					volumeA.Labels[MACHINE_LABEL],
					volumeA.Labels["dev.windlass-platform.uid"],
					volumeA.Labels["dev.windlass-platform.sandbox"],
				],
				[machineId, uid, a.slice(-12)],
			);
			const inData = (channel: typeof handoff, id: string, command: string) => channel.request("run", { id, command });
			assert.equal(
				(await inData(handoff, a, `mkdir -p ${DATA_DIR}/sessions && echo a > ${DATA_DIR}/sessions/marker-a`)).exitCode,
				0,
			);
			assert.equal(
				(await inData(peer, b, `mkdir -p ${DATA_DIR}/sessions && echo b > ${DATA_DIR}/sessions/marker-b`)).exitCode,
				0,
			);
			const markers = async (channel: typeof handoff, id: string) =>
				(await inData(channel, id, `find ${DATA_DIR} -name 'marker-*' -printf '%f '`)).stdout.trim();
			assert.equal(await markers(handoff, a), "marker-a");
			assert.equal(await markers(peer, b), "marker-b");
			// What A plants where B's state would be under a shared volume does not reach B.
			await inData(handoff, a, `echo planted > ${DATA_DIR}/sessions/marker-planted`);
			assert.equal(await markers(peer, b), "marker-b");
			await handoff.request("destroy", { id: a });
			assert.ok(await volumeGone(own(a)));
			assert.ok(!(await volumeGone(own(b))));
			// The session's next sandbox, with the Windlass sandbox profile: the machine volume, without A's data.
			if (allowed.commandSandbox.ok) {
				const shared = await handoff.request("create", { profile: windlass });
				assert.equal(await mountsOf(shared), `wlp-machine-${machineId}:${DATA_DIR}`);
				assert.ok(!(await markers(handoff, shared)).includes("marker-a"));
				await handoff.request("destroy", { id: shared });
				assert.equal((await docker(["volume", "inspect", `wlp-machine-${machineId}`])).code, 0);
			}
			srv.reset(srv.other);
			ok(
				"Hardened sessions each mount a data volume of their own and cannot see each other's Windlass data; destroy removes it; the Windlass sandbox profile keeps the machine volume.",
			);

			// Even a runner on a host without user namespaces can discover a pre-existing container.
			await stopRunner();
			const raw = randomBytes(6).toString("hex"),
				id = "m" + machineId + "-" + raw;
			await docker(
				[
					"run",
					"-d",
					"--pull",
					"never",
					"--name",
					containerName(raw),
					"--label",
					LABEL_ARG,
					"--label",
					MACHINE_LABEL + "=" + machineId,
					"--label",
					"dev.windlass-platform.uid=" + uid,
					"--label",
					"dev.windlass-platform.session=" + sessionId,
					"--label",
					"dev.windlass-platform.profile=" + windlass,
					image,
				],
				{ check: true },
			);
			assert.deepEqual((await start([policyFlag, hardened])).allowedProfiles, [hardened]);
			await srv.attach();
			const channel = srv.channel(sessionId);
			await refuse(channel.request("connect", { id }));
			await refuse(channel.request("create", { profile: hardened }));
			await refuse(channel.request("ask", { id, argv: ["true"] }));
			assert.equal(await channel.request("state", { id }), "running");
			await channel.request("destroy", { id });
			ok("After revocation connect, repeat create and direct commands are refused while removal works.");
			await stopRunner();
			await assert.rejects(
				exec(process.execPath, [bundle, "run", policyFlag, "e2b"], { env: env(state) }),
				(e: { stderr?: string }) => !!e.stderr?.includes("--allow-profile"),
			);
			ok("The CLI rejects an unknown profile id before connecting.");
			await writeFile(join(state, `profiles-${machineId}.json`), '["e2b"]');
			await assert.rejects(
				exec(process.execPath, [bundle, "run"], { env: env(state), timeout: 10_000 }),
				(e: { stderr?: string }) => !!e.stderr?.includes("Invalid profile policy"),
			);
			ok("A malformed saved policy stops the service before connecting.");
			await rm(join(state, `profiles-${machineId}.json`));
			// Prune removes a session volume left without its container, and leaves another machine's.
			const orphan = `wlp-machine-${machineId}-${randomBytes(6).toString("hex")}`;
			const foreignMachine = "m_" + randomBytes(8).toString("hex");
			const foreign = `wlp-machine-${foreignMachine}-${randomBytes(6).toString("hex")}`;
			await docker(
				[
					"volume",
					"create",
					"--label",
					LABEL_ARG,
					"--label",
					MACHINE_LABEL + "=" + machineId,
					"--label",
					"dev.windlass-platform.uid=" + uid,
					"--label",
					"dev.windlass-platform.sandbox=" + orphan.slice(-12),
					orphan,
				],
				{ check: true },
			);
			await docker(
				[
					"volume",
					"create",
					"--label",
					LABEL_ARG,
					"--label",
					MACHINE_LABEL + "=" + foreignMachine,
					"--label",
					"dev.windlass-platform.uid=" + uid,
					"--label",
					"dev.windlass-platform.sandbox=" + foreign.slice(-12),
					foreign,
				],
				{ check: true },
			);
			try {
				const prune = spawn(process.execPath, [bundle, "prune"], {
					env: env(state),
					stdio: ["pipe", "ignore", "ignore"],
				});
				prune.stdin.end("yes\n");
				assert.equal(await new Promise(resolve => prune.on("exit", resolve)), 0);
				assert.notEqual((await docker(["volume", "inspect", orphan])).code, 0);
				assert.equal((await docker(["volume", "inspect", foreign])).code, 0);
				ok("Prune removes an orphaned session volume of this machine and leaves another machine's.");
			} finally {
				await docker(["volume", "rm", "-f", foreign]);
				await docker(["volume", "rm", "-f", orphan]);
			}
			return;
		}
		if (claudePin) {
			const token = "sk-ant-oat01-" + randomBytes(30).toString("base64url");
			const volume = "wlp-harness-claude-" + machineId;

			const path = "/run/wlp-harness/claude/token";
			const create = { profile: "docker-hardened", harness: "claude" } as const;
			const clean = (text: string) => {
				assert.ok(!text.includes(token.slice(0, 16)) && !text.includes(token.slice(-16)), "Claude login data escaped.");
			};
			srv.observeControl(clean);
			const probeLog = join(tmp, "probe-calls");
			const failureFlag = join(tmp, "probe-failure");
			await writeFile(probeLog, "");
			const probes = async () => (await readFile(probeLog, "utf8")).trim().split("\n").filter(Boolean);
			const guard = join(tmp, "check-docker.cjs"),
				calls = join(tmp, "docker-calls");
			// Observe every docker spawn in an owner command. Record only its verb and whether
			// it violated the policy, so a regression cannot put the fixture token in the log.
			await writeFile(
				guard,
				`const cp = require("node:child_process"), fs = require("node:fs");
for (const method of ["spawn", "spawnSync"]) {
 const original = cp[method];
 cp[method] = function(file, args, opts) {
  if (file === "docker") {
   if (/sk-ant-oat01-[A-Za-z0-9_-]+/.test(JSON.stringify([args, opts?.env ?? process.env]))) throw Error("credential passed to docker");
   if (args[0] === "run" && args.at(-1) === "wlp-claude-acp") {
    const flags = ${JSON.stringify(commonRunFlags(1, "none"))};
    if (!JSON.stringify(args).includes(JSON.stringify(flags).slice(1,-1))
      || args.includes("--mount") || !args.includes("CLAUDE_CODE_OAUTH_TOKEN=options-only")) throw Error("unsafe options probe");
    fs.appendFileSync(${JSON.stringify(probeLog)}, args.at(-2) + "\\n");
    // Run the fixture in the actual probe container with its offline flags.
    const fixture = ${JSON.stringify(join(root, "fixtures/acp-agent"))};
    args = [...args.slice(0,-2), "--mount", "type=bind,src=" + fixture + ",dst=/fixture,readonly", args.at(-2),
     ...(fs.existsSync(${JSON.stringify(failureFlag)}) ? ["false"] : ["node", "/fixture/agent.mjs"])];
    const child = original.call(this, file, args, opts);
    const write = child.stdin.write.bind(child.stdin);
    let initialized = false;
    child.stdin.write = (line, ...rest) => {
     const {method, params} = JSON.parse(line);
     if (!initialized ? method !== "initialize" : !(method === "session/new" && params.cwd === "/workspace" || method === "session/set_config_option" && params.configId === "model"))
      throw Error("unexpected probe request");
     initialized = true;
     return write(line, ...rest);
    };
    return child;
   }
   if (args.includes("setup-token")) {
    const approved = ["run", "--rm", "-it", "--log-driver", "none", "--pull", "never",
     ...${JSON.stringify(["--label", LABEL_ARG, "--label", MACHINE_LABEL + "=" + machineId, "--label", "dev.windlass-platform.uid=" + uid, ...COMMON_RUN_FLAGS])},
     ${JSON.stringify(claudePin)}, "/opt/wlp-claude/node_modules/.bin/claude-agent-acp", "--cli", "setup-token"];
    if (JSON.stringify(args) !== JSON.stringify(approved) || opts.stdio !== "inherit") throw Error("unsafe setup invocation");
    fs.appendFileSync(${JSON.stringify(calls)}, "private-setup\\n");
    // Leave these exact options on a real container without starting the browser flow.
    return original.call(this, file, ["create", "--name", ${JSON.stringify(setupName)}, ...args.slice(1)], { stdio: "ignore" });
   }
   fs.appendFileSync(${JSON.stringify(calls)}, args[0] + "\\n");
  }
  return original.apply(this, arguments);
 };
}
require("node:module").syncBuiltinESMExports();`,
			);
			async function owner(args: string[], input = "", settings = {}) {
				const child = spawn(process.execPath, ["--require", guard, bundle, ...args], {
					env: { ...env(state), ...settings },
					stdio: "pipe",
				});
				let output = "";
				child.stdout.on("data", s => (output += s));
				child.stderr.on("data", s => (output += s));
				child.stdin.on("error", () => {});
				child.stdin.end(input);
				const code = await new Promise(resolve => child.on("close", resolve));
				clean(output);
				return { code, output };
			}
			const { e2bSandboxes } = await import("../server/src/sandbox/e2b/sandboxes.js");
			const { FakeE2b } = await import("../server/src/sandbox/e2b/fake.js");
			const { readE2bSettings } = await import("../server/src/sandbox/e2b/config.js");
			const { createFakeSandboxLayer } = await import("../server/src/sandbox-fake.js");
			const hostedDocker = new DockerSandboxes({
				machine: null,
				dataVolume: async () => {
					throw new Error("unexpected volume");
				},
				dropDataVolume: async () => {},
			});
			const hostedE2b = e2bSandboxes(new FakeE2b(), readE2bSettings({}));
			for (const provider of [hostedDocker, hostedE2b, createFakeSandboxLayer({ signIns: "memory" }).sandboxes]) {
				for (const harness of ["claude", "opencode", "codex"] as const) {
					const name = harness === "codex" ? "Codex" : harness === "claude" ? "Claude Code" : "OpenCode";
					await assert.rejects(
						provider.create({
							...create,
							harness,
							uid,
							sessionId,
							profile: provider === hostedE2b ? "e2b" : create.profile,
						}),
						provider === hostedDocker
							? /configured platform model relay/
							: provider === hostedE2b
								? /microVM-only profile and a configured model relay/
								: new RegExp("fake sandbox does not run " + name),
					);
				}
			}
			ok("Hosted Docker and E2B require a configured relay; the fake sandbox refuses third-party agents.");
			const baseOnly = join(tmp, "windlass-only.cjs");
			await exec(process.execPath, ["runner/bundle.mjs", image, baseOnly], { cwd: root });
			await assert.rejects(
				exec(process.execPath, [baseOnly, "--harness", "claude"], { env: env(state) }),
				(error: { stderr?: string }) => !!error.stderr?.includes("pinned Claude Code image"),
			);
			let service = run();
			await until(() => !!srv.state.report, "Runner did not pair.");
			await srv.attach();
			const ch = srv.channel(sessionId);
			await assert.rejects(ch.request("create", create), /--harness claude/);
			assert.equal(srv.state.lastErrorKind, "refused");
			ok("Claude create needs the machine owner's opt-in.");
			srv.detach();
			await stop(service.child);
			await until(() => !srv.online(), "Runner did not stop.");
			const enabled = ["--harness", "claude", "--harness", "claude", "--screenshots"];
			const report = () => srv.state.report?.harnesses?.[0];
			const absentPin = join(tmp, "absent-claude.cjs");
			await exec(
				process.execPath,
				["runner/bundle.mjs", image, absentPin, image, "claude=sha256:" + randomBytes(32).toString("hex")],
				{ cwd: root },
			);
			service = run(state, undefined, absentPin, {}, { flags: enabled });
			await until(() => !!report(), "Missing image fixture did not connect.");
			await srv.attach();
			await assert.rejects(ch.request("create", create), /pinned Claude Code image is missing/);
			srv.detach();
			await stop(service.child);
			await until(() => !srv.online(), "Runner did not disconnect.");
			// A crash between create and start leaves no in-container timer to reap the setup.
			const orphanSetup = (
				await docker(
					[
						"create",
						"--label",
						LABEL_ARG,
						"--label",
						MACHINE_LABEL + "=" + machineId,
						"--label",
						"dev.windlass-platform.uid=" + uid,
						"--label",
						"dev.windlass-platform.claude-login=1",
						image,
						"true",
					],
					{ check: true },
				)
			).stdout.trim();
			srv.state.report = null;
			service = run(state, guard, bundle, {}, { flags: enabled });
			await until(
				() => report()?.signIn === "none" && !!report()?.options?.modes.length,
				"Enabled runner did not report the unsigned Claude harness.",
			);
			assert.ok((await docker(["container", "inspect", orphanSetup])).code !== 0, "Reconnect left the abandoned setup");
			await srv.attach();
			await assert.rejects(ch.request("create", { ...create, profile: "docker-windlass-sandbox" }), /docker-hardened/);

			// An unlabelled namesake is never mounted or overwritten.
			await docker(["volume", "create", volume], { check: true });
			try {
				assert.equal((await owner(["login", "claude"], token + "\n")).code, 1);
				const unsigned = await ch.request("create", create);
				assert.equal((await ch.request("connect", { id: unsigned }))?.harness, "claude");
				await ch.request("destroy", { id: unsigned });
				assert.ok((await owner(["status"])).output.includes("unknown"));
			} finally {
				await docker(["volume", "rm", volume], { check: true });
			}
			for (const invalid of ["wrong", token + "\nsecond", token + "x".repeat(512)]) {
				assert.equal((await owner(["login", "claude"], invalid + "\n")).code, 1);
			}
			assert.equal((await docker(["volume", "inspect", volume])).code === 0, false);
			assert.equal(
				(await owner(["login", "claude"], token + "\n", { CLAUDE_CODE_OAUTH_TOKEN: token, CHECK_PASTED_TOKEN: token }))
					.code,
				0,
			);
			await until(() => report()?.signIn === "token", "Login did not publish a signed-in report.", 15_000);
			assert.deepEqual(await probes(), [claudePin, claudePin], "one probe on startup and another after login");
			const options = report()?.options;
			assert.ok(
				options &&
					options.defaultModel === "default" &&
					options.models.find(m => m.id === "default")?.efforts.includes("high"),
			);
			assert.deepEqual(options.models.find(m => m.id === "sonnet")?.efforts, ["default", "low"]);
			// Each login gets a generation of its own, which the platform reads to tell one login from the next.
			const loginGeneration = report()?.loginGeneration;
			assert.match(loginGeneration ?? "", /^[0-9a-f]{32}$/);
			assert.deepEqual(report(), {
				options,
				optionsDigest: optionsDigest(options),
				optionsCheckedAt: options.checkedAt,
				id: "claude",
				adapter: "claude-agent-acp 0.109.0",
				image: claudePin,
				signIn: "token",
				keyRelay: true,
				loginGeneration,
			});
			clean(JSON.stringify(srv.state.report));
			const labels = JSON.parse(
				(await docker(["volume", "inspect", "-f", "{{json .Labels}}", volume], { check: true })).stdout,
			);
			assert.equal(labels[MACHINE_LABEL], machineId);
			assert.equal(labels["dev.windlass-platform.uid"], uid);
			const otherState = join(tmp, "another-pairing");
			await mkdir(otherState, { mode: 0o700 });
			const pairing = JSON.parse(await readFile(join(state, "pair.json"), "utf8"));
			pairing.current.machineId = "m_" + randomBytes(8).toString("hex");
			await writeFile(join(otherState, "pair.json"), JSON.stringify(pairing), { mode: 0o600 });
			const otherEnv = { WLP_RUNNER_STATE_DIR: otherState };
			assert.match((await owner(["status"], "", otherEnv)).output, /Claude Code.*: pays with your plans and keys/);
			assert.equal((await owner(["logout", "claude"], "", otherEnv)).code, 0);
			const staleVolume = "wlp-harness-claude-" + pairing.current.machineId;
			const pending = spawn(process.execPath, [bundle, "login", "claude"], { env: env(otherState), stdio: "pipe" });
			children.add(pending);
			let notice = "";
			pending.stdout.on("data", chunk => (notice += chunk));
			pending.stderr.on("data", chunk => (notice += chunk));
			const done = new Promise(resolve =>
				pending.on("close", code => {
					children.delete(pending);
					resolve(code);
				}),
			);
			await until(() => notice.includes("Anthropic"), "The pending login did not start.");
			pairing.current.machineId = "m_" + randomBytes(8).toString("hex");
			await writeFile(join(otherState, "pair.json"), JSON.stringify(pairing), { mode: 0o600 });
			pending.stdin.end(token + "\n");
			try {
				assert.equal(await done, 1);
				clean(notice);
				assert.match(notice, /pairing changed/);
				assert.ok(
					(await docker(["volume", "inspect", staleVolume])).code !== 0,
					"A superseded pairing received the login",
				);
			} finally {
				await docker(["volume", "rm", staleVolume]);
			}
			// Exercise a re-pair with a login on both identities, independently of the service.
			const previous = { ...pairing.current };
			assert.equal((await owner(["login", "claude"], token, otherEnv)).code, 0);
			pairing.previous = [previous];
			pairing.current = { ...previous, machineId: "m_" + randomBytes(8).toString("hex") };
			const pairIds = [previous.machineId, pairing.current.machineId];
			try {
				await writeFile(join(otherState, "pair.json"), JSON.stringify(pairing), { mode: 0o600 });
				assert.equal((await owner(["login", "claude"], token, otherEnv)).code, 0);
				const logout = await owner(["logout", "claude"], "", otherEnv);
				assert.equal(logout.code, 0);
				const status = await owner(["status"], "", otherEnv);
				for (const id of pairIds) {
					assert.ok(
						(await docker(["volume", "inspect", "wlp-harness-claude-" + id])).code !== 0,
						"Logout left a pairing's login volume",
					);
					assert.ok(logout.output.split("\n").some(line => line.includes(id) && line.includes("signed out")));
				}
				assert.equal(logout.output.trim().split("\n").length, pairIds.length);
				assert.equal(status.code, 0);
				assert.equal(status.output.match(/: pays with your plans and keys$/gm)?.length, pairIds.length);
				assert.doesNotMatch(status.output, /login kept on this machine/);
			} finally {
				for (const id of pairIds) await docker(["volume", "rm", "wlp-harness-claude-" + id]);
			}
			ok("Logout after a re-pair clears both login volumes and reports each pairing signed out.");
			assert.match((await owner(["status"])).output, /Claude Code.*: login kept on this machine/);
			ok(
				"Login validates one line, uses stdin, checks volume ownership and reports only the pinned harness and sign-in state.",
			);

			// The daemon still has its last signed-in report. Status must read the volume,
			// including an empty file, without trusting that report or an earlier login.
			await docker(
				[
					"run",
					"--rm",
					"--pull",
					"never",
					"--network",
					"none",
					"--user",
					"0",
					"--mount",
					"type=volume,src=" + volume + ",dst=/login,volume-nocopy",
					image,
					"truncate",
					"-s",
					"0",
					"/login/token",
				],
				{ check: true },
			);
			assert.match((await owner(["status"])).output, /Claude Code.*: pays with your plans and keys/);

			// Attach a real terminal with echo initially on. The local shim stands in only
			// for Anthropic's browser flow. Wait for the private prompt before writing.
			const terminal = spawn(
				"script",
				[
					"--quiet",
					"--return",
					"--echo",
					"always",
					"--command",
					'exec "$CHECK_NODE" --require "$CHECK_GUARD" "$CHECK_BUNDLE" login claude',
					"/dev/null",
				],
				{
					env: { ...env(state), CHECK_NODE: process.execPath, CHECK_GUARD: guard, CHECK_BUNDLE: bundle },
					stdio: "pipe",
				},
			);
			children.add(terminal);
			let transcript = "";
			terminal.stdout.on("data", data => (transcript += data));
			terminal.stderr.on("data", data => (transcript += data));
			const finished = new Promise(resolve =>
				terminal.on("close", code => {
					children.delete(terminal);
					resolve(code);
				}),
			);
			await until(
				() => transcript.includes("Paste the token") || terminal.exitCode !== null,
				"Missing private terminal prompt.",
			);
			assert.ok(transcript.includes("Paste the token"), "The setup invocation failed the Docker argument guard");
			terminal.stdin.write(token + "\n");
			assert.equal(await finished, 0);
			clean(transcript);
			assert.ok((await readFile(calls, "utf8")).includes("private-setup"));
			const setup = JSON.parse((await docker(["inspect", setupName], { check: true })).stdout)[0];
			assert.deepEqual(setup.HostConfig.CapDrop, ["ALL"]);
			assert.ok(setup.HostConfig.SecurityOpt.includes("no-new-privileges"));
			assert.equal(setup.Config.Labels[MACHINE_LABEL], machineId);
			assert.equal(setup.Config.Labels["dev.windlass-platform.uid"], uid);
			assert.deepEqual(setup.Mounts, []);
			ok("The setup CLI has session hardening, pairing labels and no login mount. The paste has echo off.");

			await until(async () => (await probes()).length >= 3, "Login rotation did not refresh options.");
			const beforeLaunch = await probes();
			assert.deepEqual(beforeLaunch, [claudePin, claudePin, claudePin], "login rotation probes again");
			const id = await ch.request("create", { ...create, screenshots: true });
			assert.deepEqual(await probes(), beforeLaunch, "launch used the reported options");
			const name = containerName("claude-" + id.slice(-12));
			const inspect = async (name: string) => JSON.parse((await docker(["inspect", name], { check: true })).stdout)[0];
			const box = await inspect(name);
			assert.equal(box.Config.Image, claudePin);
			assert.equal(box.Config.Labels["dev.windlass-platform.harness"], "claude");
			assert.equal(box.HostConfig.LogConfig.Type, "none");
			assert.deepEqual(box.Mounts, []);
			assert.match(box.Config.Labels["dev.windlass-platform.relay-session"], /^[0-9a-f]{32}$/);
			assert.ok(!box.Config.Env.some((entry: string) => /^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=/.test(entry)));
			assert.equal((await ch.request("run", { id, command: "test ! -e " + path })).exitCode, 0);
			assert.equal((await ch.request("connect", { id }))?.harness, "claude");
			await assert.rejects(ch.request("create", { profile: "docker-hardened" }), /different harness/);
			await srv.attach(srv.other);
			const windlass = srv.channel(srv.other);
			const ordinary = await windlass.request("create", { profile: "docker-hardened" });
			assert.ok(
				!(await inspect(containerName(ordinary.slice(-12)))).Mounts.some((m: { Name?: string }) =>
					m.Name?.startsWith("wlp-harness-"),
				),
			);
			assert.equal((await windlass.request("run", { id: ordinary, command: "test ! -e " + path })).exitCode, 0);
			await assert.rejects(windlass.request("readTextFile", { id, path }), /another session/);
			ok("The idle Claude session has a relay nonce and no credential or login mount.");

			// Exercise prefix and body boundaries on both file descriptors. No credential in the command.
			const scrubFile = "/tmp/claude-scrub-fixture";
			await docker(["exec", name, "sh", "-c", "printf %s%s sk-ant- oat01-output_fixture > " + scrubFile], {
				check: true,
			});
			const echo =
				"t=$(cat " +
				scrubFile +
				'); for fd in 1 2; do printf "before <%s" "${t:0:6}" >&$fd; sleep .1; printf %s "${t:6:12}" >&$fd; sleep .1; printf "%s> after\\n" "${t:18}" >&$fd; done';
			const expected = "before <[claude token]> after\n";
			const outputs = ["", "", ""];
			const collect = (fd: 1 | 2, text: string) => {
				outputs[fd] += text;
			};
			const result = await ch.request("run", { id, command: echo }, { onOutput: collect });
			assert.ok(
				result.stdout === expected && result.stderr === expected && outputs[1] === expected && outputs[2] === expected,
				"run leaked or damaged a stream or result",
			);
			outputs.fill("");
			const proc = ch.start({ id, argv: ["bash", "-c", echo], tag: "claudecheck" }, collect);
			await proc.ended;
			assert.ok(outputs[1] === expected && outputs[2] === expected, "start leaked or damaged a stream");
			const answer = await ch.request("ask", { id, argv: ["bash", "-c", echo] });
			assert.ok(answer?.stdout === expected && answer.stderr === expected, "ask leaked or damaged a result");
			assert.ok(
				(await ch.request("readTextFile", { id, path: scrubFile })) === "[claude token]",
				"readTextFile leaked the token",
			);
			await writeFile(calls, "");
			const status = await owner(["status"]);
			assert.match(status.output, /Claude Code.*: login kept on this machine/);
			assert.ok(
				!(await readFile(calls, "utf8")).split("\n").some(v => ["run", "start", "exec"].includes(v)),
				"status started a container",
			);
			assert.match(
				(await owner(["status"], "", { DOCKER_HOST: "unix:///missing/" + machineId })).output,
				/Claude Code.*unknown/,
			);
			clean(service.output());
			clean((await owner(["log"])).output);
			clean(await readFile(join(state, "status.json"), "utf8"));
			ok(
				"Run, start, ask and file reads scrub Claude tokens. Status probes metadata without starting a container. Logs and status contain no token.",
			);

			srv.detach(srv.other);
			srv.detach();
			await stop(service.child);
			await until(() => !srv.online(), "Enabled runner did not disconnect.");
			const oldRunner = await rollbackRunner(image);
			// A protocol-1 binary cannot read a pinned pairing. Check local discovery with its original record.
			await assert.rejects(exec(process.execPath, [oldRunner, "status"], { env: env(state) }), /Invalid pair.json/);
			const rollbackState = join(tmp, "rollback-state");
			await mkdir(rollbackState, { mode: 0o700 });
			const {
				current,
				previous: earlier,
				platform,
				key,
			} = JSON.parse(await readFile(join(state, "pair.json"), "utf8"));
			await writeFile(join(rollbackState, "pair.json"), JSON.stringify({ current, previous: earlier, platform, key }), {
				mode: 0o600,
			});
			const oldStatus = await exec(process.execPath, [oldRunner, "status"], { env: env(rollbackState) });
			assert.ok(oldStatus.stdout.includes(ordinary), "The old runner missed the Windlass session");
			assert.ok(!oldStatus.stdout.includes(id), "The old runner adopted the token-mounted Claude session");
			ok("The old runner refuses the pinned pairing and discovers only the ordinary session with its original state.");

			// Recreate 8d01472's persisted name and snapshot. Upgrade with the harness disabled.
			await docker(["rename", name, containerName(id.slice(-12))], { check: true });
			await rm(join(state, "harness.json"));
			const statusPath = join(state, "status.json");
			await writeFile(statusPath, JSON.stringify({ ...JSON.parse(await readFile(statusPath, "utf8")), claude: true }));
			service = run();
			await until(() => srv.online(), "Runner did not restart.");
			await srv.attach();
			await assert.rejects(ch.request("connect", { id }), /--harness claude/);
			await assert.rejects(ch.request("readTextFile", { id, path }), /--harness claude/);
			assert.equal((await inspect(name)).Id, box.Id);
			const migrated = await exec(process.execPath, [oldRunner, "status"], { env: env(rollbackState) });
			assert.ok(migrated.stdout.includes(ordinary) && !migrated.stdout.includes(id));
			ok("Upgrade preserves the existing Claude container and hides it from b12b61e discovery.");
			srv.detach();
			await stop(service.child);
			await until(() => !srv.online(), "Runner did not disconnect.");
			// A new runner build is how the machine receives a different immutable Claude image.
			const changed = join(tmp, "changed-pin.cjs");
			await exec(process.execPath, ["runner/bundle.mjs", image, changed, image, "claude=" + image], { cwd: root });
			service = run(state, guard, changed, {}, { flags: enabled });
			await until(
				() => report()?.image === image && report()?.options !== undefined,
				"Updated pin missed the signed-in probe.",
			);
			assert.deepEqual(await probes(), [...beforeLaunch, image]);
			await stop(service.child);
			await until(() => !srv.online(), "Updated runner did not stop.");
			srv.state.report = null;
			service = run(state, guard, changed, {}, { flags: enabled });
			await until(() => srv.online(), "Runner did not restart with Claude.");
			await srv.attach();
			assert.equal((await ch.request("connect", { id }))?.harness, "claude");
			await until(() => report()?.options !== undefined, "Startup missed the signed-in probe");
			assert.deepEqual(await probes(), [...beforeLaunch, image, image]);
			const lastCatalog = report()?.options;
			await writeFile(failureFlag, "");
			assert.equal((await owner(["login", "claude"], token)).code, 0);
			await until(
				() => service.output().includes("Could not read Claude Code model options."),
				"Failed probe was not recorded",
			);
			assert.deepEqual(report()?.options, lastCatalog);
			clean(service.output());
			assert.equal(service.output().split("Could not read Claude Code model options.").length - 1, 1);
			assert.equal((await probes()).length, 6, "a failed probe does not immediately repeat");
			assert.equal((await ch.request("connect", { id }))?.harness, "claude");
			await rm(failureFlag);
			ok("A failed options probe reports once and the signed-in runner continues serving sessions.");
			// A killed login helper could leave its private staging file. Logout clears both.
			await docker(
				[
					"run",
					"--rm",
					"--pull",
					"never",
					"--network",
					"none",
					"--user",
					"0",
					"--mount",
					"type=volume,src=" + volume + ",dst=/login,volume-nocopy",
					image,
					"touch",
					"/login/.token.abandoned",
				],
				{ check: true },
			);
			assert.equal((await owner(["logout", "claude"])).code, 0);
			await until(
				() => report()?.signIn === "none" && !!report()?.options?.models.length,
				"Logout did not publish a signed-out report.",
				15_000,
			);
			assert.equal(
				(
					await ch.request("run", {
						id,
						command: "test ! -e " + path + " && test ! -e /run/wlp-harness/claude/.token.abandoned",
					})
				).exitCode,
				0,
			);
			await ch.request("destroy", { id });
			assert.ok((await docker(["volume", "inspect", volume])).code !== 0, "Detached signed-out volume survived");
			assert.equal((await owner(["login", "claude"], token)).code, 0);
			await stop(service.child);
			await until(() => !srv.online(), "Runner did not stop before the offline Docker probe.");
			srv.state.report = null;
			service = run(state, undefined, bundle, { DOCKER_HOST: "unix:///missing/" + machineId }, { flags: enabled });
			await until(
				() => report()?.signIn === "unknown" && srv.state.report?.docker.ok === false,
				"A failed Docker query did not report unknown.",
			);
			await stop(service.child);
			assert.equal((await owner(["prune"], "yes\n")).code, 0);
			assert.ok((await docker(["volume", "inspect", volume])).code !== 0, "Prune kept the login volume");
			assert.ok((await docker(["container", "inspect", setupName])).code !== 0, "Prune left the setup-token container");
			ok("Prune removes a leftover setup-token container.");
			ok(
				"Discovery preserves the harness and opt-in. Logout removes the relay and detached login volume and publishes none. Prune removes a signed-in volume.",
			);
			return;
		}
		if (shotsPin) {
			const baseOnly = join(tmp, "base-only.cjs");
			await exec(process.execPath, ["runner/bundle.mjs", image, baseOnly], { cwd: root });
			await assert.rejects(
				exec(process.execPath, [baseOnly, "--screenshots"], { env: env(state) }),
				(error: { stderr?: string }) =>
					!!error.stderr?.includes("requires a runner built with a pinned screenshots sandbox image"),
			);
			ok("The base-only runner explains which image --screenshots needs.");
			for (const enabled of [false, true]) {
				srv.state.report = null;
				const service = run(state, undefined, bundle, {}, { flags: enabled ? ["--screenshots"] : [] });
				const report = () => srv.state.report;
				await until(() => !!report(), "Runner did not report its screenshot capability.", 75_000);
				assert.equal(report()?.screenshots === true, enabled);
				await srv.attach();
				const channel = srv.channel(sessionId);
				for (const screenshots of [false, true]) {
					const id = await channel.request("create", { profile: "docker-hardened", screenshots });
					const name = containerName(id.slice(-12));
					assert.equal((await channel.request("connect", { id }))?.screenshots === true, enabled);
					const actual = await docker(["inspect", "-f", "{{.Config.Image}}", name], { check: true });
					assert.equal(actual.stdout.trim(), enabled && screenshots ? shotsPin : image);
					assert.equal(await channel.request("create", { profile: "docker-hardened", screenshots: !screenshots }), id);
					await channel.request("destroy", { id });
				}
				srv.detach();
				await stop(service.child);
				await until(() => !srv.online(), "Runner did not disconnect.");
				ok(
					`Runner ${enabled ? "with" : "without"} --screenshots reports its capability and selects the right pin for both repository settings.`,
				);
			}
			return;
		}
		const bin = join(tmp, "bin");
		await mkdir(bin);
		const measured = join(tmp, "disk-measurements");
		const pullStarted = join(tmp, "pull-started"),
			releasePull = join(tmp, "release-pull");
		const wrappedDocker = { PATH: bin + ":" + env(state).PATH, CHECK_DOCKER_PATH: env(state).PATH };
		// A delayed pull is entirely local. All container operations use the real daemon.
		await writeFile(
			join(bin, "docker"),
			`#!/bin/sh
if [ "$1" = manifest ] && [ "$2" = inspect ]; then
  echo '{"manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64"}}]}'
  exit 0
fi
if [ "$1" = "pull" ]; then
  echo start >> "$CHECK_PULL_STARTED"
  for i in $(seq 1 100); do [ -f "$CHECK_RELEASE_PULL" ] && break; sleep 0.1; done
  exit 1
fi
for arg in "$@"; do
  if [ "$arg" = "df" ] && [ -n "$CHECK_DF_LOG" ]; then echo df >> "$CHECK_DF_LOG"; fi
  if [ "$arg" = "df" ] && [ -n "$CHECK_LOW_DISK" ]; then printf 'Avail\\n4999999999\\n'; exit 0; fi
done
PATH="$CHECK_DOCKER_PATH" exec docker "$@"
`,
			{ mode: 0o700 },
		);

		async function checkOutages(ch: ServerChannel, id: string, child: ChildProcess) {
			const name = containerName(id.slice(-12));
			let windlass: string | undefined;
			for (const [duration, freeze] of [
				[5000, false],
				[300_000, false],
				[120_000, true],
			] as const) {
				windlass = await scripted(
					ch,
					id,
					async () => {
						const before = await readFile(measured, "utf8");
						srv.cut();
						if (freeze) {
							child.kill("SIGSTOP");
							await docker(["pause", name], { check: true });
						}
						try {
							await wait(duration);
							assert.equal(await readFile(measured, "utf8"), before);
						} finally {
							if (freeze) {
								await docker(["unpause", name], { check: true });
								child.kill("SIGCONT");
							}
							srv.restore();
						}
					},
					windlass,
				);
				ok(
					`A scripted Windlass turn finished with unique events across a ${duration / 1000}s ${freeze ? "laptop sleep" : "network loss"}.`,
				);
			}
			ok("Disk is measured on welcome and create, and the five-minute outage starts no disk helper.");
			return windlass;
		}
		if (process.argv.includes("--outages-only")) {
			const service = run(
				state,
				undefined,
				bundle,
				{ ...wrappedDocker, CHECK_DF_LOG: measured },
				{ flags: ["--allow-profile", "docker-windlass-sandbox"] },
			);
			await until(() => !!srv.state.report, "Runner did not report.");
			assert.equal(await readFile(measured, "utf8"), "df\n");
			await srv.attach();
			const ch = srv.channel(sessionId);
			const id = await ch.request("create", {
				profile: srv.state.report!.commandSandbox.ok ? "docker-windlass-sandbox" : "docker-hardened",
			});
			assert.ok((await readFile(measured, "utf8")).split("df\n").length >= 3);
			await checkOutages(ch, id, service.child);
			return;
		}
		for (const [flag, value] of [
			["--max-running", "0"],
			["--max-sandboxes", "1.5"],
		]) {
			await assert.rejects(
				exec(process.execPath, [bundle, "status", flag, value], { env: env(state) }),
				(error: { code?: number; stderr?: string }) =>
					error.code === 1 && error.stderr?.trim() === `Give ${flag} a positive whole number.`,
			);
		}
		const expiredAudit = join(state, "audit-2000-01-01.jsonl");
		await writeFile(expiredAudit, "old", { mode: 0o600 });
		// A runner died after docker run and before the workspace's git init.
		const unfinishedRaw = randomBytes(6).toString("hex");
		const unfinishedName = containerName(unfinishedRaw);
		await docker(
			[
				"run",
				"-d",
				"--pull",
				"never",
				"--name",
				unfinishedName,
				"--label",
				LABEL_ARG,
				"--label",
				MACHINE_LABEL + "=" + machineId,
				"--label",
				"dev.windlass-platform.uid=" + uid,
				"--label",
				"dev.windlass-platform.session=" + sessionId,
				"--label",
				"dev.windlass-platform.profile=docker-hardened",
				image,
			],
			{ check: true },
		);
		srv.state.pairingMode = "refused";
		let service = run();
		await until(() => service.output().includes("Pairing was refused"), "Pairing refusal did not park the runner.");
		assert.equal(service.child.exitCode, null);
		assert.match(await cli("status"), /restart the container/);
		assert.equal(srv.state.pairStarts, 1);
		await assert.rejects(
			exec(process.execPath, [bundle, "pair", "--platform", srv.platform], {
				env: env(join(tmp, "standalone")),
				timeout: 10_000,
			}),
			(error: { code?: number; stdout?: string }) =>
				error.code === 1 && !!error.stdout?.includes("Pairing was refused"),
		);
		srv.state.pairingMode = "gone";
		assert.match(await cli("pair"), /pairing code expired/);
		srv.state.pairingMode = "waiting";
		assert.match(await cli("pair"), /pairing code expired/);
		const invalid = join(tmp, "standalone");
		await writeFile(join(invalid, "status.json"), "broken", { mode: 0o600 });
		await assert.rejects(
			exec(process.execPath, [bundle, "status"], { env: env(invalid) }),
			(error: { stderr?: string }) => !!error.stderr?.includes("status.json. Repair or restore"),
		);
		const parkedStarts = srv.state.pairStarts;
		const parkedPolls = srv.state.pollFailures;
		await wait(7000);
		assert.equal(srv.state.pairStarts, parkedStarts);
		assert.equal(srv.state.pollFailures, parkedPolls);
		assert.match(await cli("log"), /pairing code expired/);
		srv.state.pairingMode = "approve";
		srv.state.startFailures = 1;
		const paired = await cli("pair");
		assert.match(paired, /Trying again/);
		assert.match(paired, /Paired with runner-check/);
		ok(
			"Refused start, expired code and polling deadline all park the service. Only the owner's pair command obtains another code.",
		);
		await until(() => !!srv.state.report, "The runner did not pair and report.", 75_000);
		assert.match(service.output(), /Paired with runner-check\. If that is not you, run `windlass-runner pair` again\./);
		assert.ok(srv.state.pollFailures >= 2 && srv.state.clockRefusals > 0);
		await assert.rejects(stat(expiredAudit), { code: "ENOENT" });
		assert.equal((await stat(state)).mode & 0o777, 0o700);
		assert.equal((await stat(join(state, "pair.json"))).mode & 0o777, 0o600);
		assert.equal((await readFile(join(state, "lock"), "utf8")).trim(), String(service.child.pid));
		assert.equal(srv.state.report!.docker.ok, true);
		ok(
			"Pairing retries a 503, identifies the account, protects the key and lock, and corrects a 30-minute clock error.",
		);
		assert.ok(reported("m" + machineId + "-" + unfinishedRaw));
		await srv.attach();
		const recoveryChannel = srv.channel(sessionId);
		const [recovered, repeated] = await Promise.all(
			[1, 2].map(() => recoveryChannel.request("create", { profile: "docker-hardened" })),
		);
		assert.notEqual(recovered, "m" + machineId + "-" + unfinishedRaw, "Create adopted the unfinished sandbox.");
		assert.equal(repeated, recovered);
		const recoveredName = containerName(recovered.slice(-12));
		assert.equal(await containers(), recoveredName);
		await docker(["exec", recoveredName, "test", "-e", "/workspace/.git"], { check: true });
		await recoveryChannel.request("destroy", { id: recovered });
		srv.detach();
		ok("Concurrent creates replace a rediscovered unfinished sandbox once.");
		const waiting = "Another runner holds the state lock. Waiting to retry.";
		const interrupted = run(state, undefined, bundle, {}, { flags: ["run"] });
		await until(() => interrupted.output().includes(waiting), "Second service did not wait for the lock.");
		const stopping = performance.now();
		await stop(interrupted.child);
		assert.equal(interrupted.child.exitCode, 0);
		assert.ok(performance.now() - stopping < 3000, "Stopping a waiting service took too long.");

		const standby = run();
		await until(() => standby.output().includes(waiting), "Service started with --platform did not wait for the lock.");
		await wait(4000); // Cross the test clock's 3.5-second retry while the first service is still online.
		assert.equal(standby.output().trim(), waiting);
		assert.equal(standby.child.exitCode, null);
		assert.ok(srv.online());
		assert.equal((await readFile(join(state, "lock"), "utf8")).trim(), String(service.child.pid));
		await stop(service.child);
		service = standby;
		await until(() => service.output().includes("Online"), "The waiting service did not take over.", 10_000);
		assert.equal((await readFile(join(state, "lock"), "utf8")).trim(), String(service.child.pid));
		ok(
			"A second service reports the held lock once, stays alive and takes over after the first stops. SIGTERM interrupts a waiting service.",
		);
		const second = join(tmp, "second");
		await mkdir(second, { mode: 0o700 });
		await copyFile(join(state, "pair.json"), join(second, "pair.json"));
		const mismatch = run(second, undefined, bundle, {}, { platform: "http://127.0.0.1:1" });
		await until(() => mismatch.output().includes("pair with a different platform"), "Platform mismatch did not park.");
		assert.equal(mismatch.child.exitCode, null);
		assert.match(await cli("status", second), /pair with a different platform/);
		await stop(mismatch.child);
		const oldPair = await readFile(join(state, "pair.json"));
		srv.state.pairingMode = "gone";
		assert.match(await cli("pair"), /pairing code expired/);
		assert.ok(oldPair.equals(await readFile(join(state, "pair.json"))));
		await until(() => srv.online(), "An abandoned pairing failed to reconnect with the working key.");
		srv.state.pairingMode = "approve";
		ok(
			"A platform mismatch parks, standalone pairing exits on refusal, and an abandoned replacement preserves the working pairing.",
		);
		const duplicate = run(second);
		await until(() => duplicate.output().includes("key-in-use"), "Copied key was not refused.");
		assert.equal(duplicate.child.exitCode, null);
		assert.match(await cli("status", second), /key-in-use/);
		await stop(duplicate.child);
		ok("A second process with a copied key stays alive and the first stays online.");

		// The join run lost the gateway while the HTTP route still answered. Also
		// exercise immediate HTTP failures, when a tight loop would make the most attempts.
		for (const link of ["gateway", "all", "gateway"] as const) {
			const { connections, connectionRequests } = srv.state;
			srv.cut(link);
			await wait(30_000);
			const attempts = srv.state.connectionRequests - connectionRequests;
			const reports = srv.state.reports;
			const restored = performance.now();
			srv.restore();
			// The longest wait the runner allows itself (runner/src/control.ts): an attempt begun just before the
			// restore runs out its CONNECT_TIMEOUT_MS of 5 s, then waits at most MAX_BACKOFF_MS of 15 s; and a
			// few seconds for the handshake.
			await until(() => srv.state.connections > connections, "Runner took over 25s to reconnect.", 25_000);
			assert.ok(attempts >= 3 && attempts <= 5, `Made ${attempts} attempts during the cut.`);
			ok(
				`Runner reconnected ${((performance.now() - restored) / 1000).toFixed(2)}s after a 30s ${link} cut, with ${attempts} attempts during the cut.`,
			);
			// The server counts a hello before the runner receives its welcome and resets its backoff.
			await until(() => srv.state.reports > reports, "Runner did not report after reconnecting.");
		}

		const missing = join(tmp, "missing.cjs");
		await exec(process.execPath, ["runner/bundle.mjs", "sha256:" + randomBytes(32).toString("hex"), missing], {
			cwd: root,
		});
		for (const fault of ["daemon", "image", "disk"] as const) {
			await stop(service.child);
			await until(() => !srv.online(), "Test runner did not disconnect.");
			srv.state.report = null;
			// This socket never exists. Keep its path within the Unix socket limit even with a long TMPDIR.
			const missingHost = `unix:///run/absent-directory-${machineId}/missing.sock`;
			const dockerEnv =
				fault === "daemon"
					? { DOCKER_HOST: missingHost, CHECK_PRIVATE_SETTING: "absent-directory" }
					: fault === "disk"
						? { ...wrappedDocker, CHECK_LOW_DISK: "1" }
						: {};
			service = run(state, undefined, fault === "image" ? missing : bundle, dockerEnv);
			await until(() => !!srv.state.report, "Missing machine-health report.");
			if (fault === "daemon") {
				const health = srv.state.report!.docker;
				assert.ok(!health.ok);
				const { stderr, code } = await docker(["--host", missingHost, "ps"]);
				assert.notEqual(code, 0);
				const prefix = stderr
					.trim()
					.split(/[\r\n]/, 1)[0]
					.split("unix://")[0];
				// Credential-path checks may conceal the Docker diagnostic before discovery runs.
				assert.ok(
					health.reason === "Docker did not provide a diagnostic." ||
						(prefix.length > 0 && health.reason.startsWith(prefix)),
				);
				assert.ok(
					!health.reason.includes("absent-directory") && !/[\r\n]/.test(health.reason) && health.reason.length <= 500,
				);
				assert.match(await cli("log"), /"operation":"docker","outcome":"(?:not found|unreachable)"/);
			} else {
				await srv.attach();
				await assert.rejects(
					srv.channel(sessionId).request("create", { profile: "docker-hardened" }),
					fault === "disk" ? /at least 5 GB free/ : /pinned sandbox image is missing/,
				);
				assert.equal((await docker(["ps", "-aq", ...ownedFilters])).stdout.trim(), "");
			}
		}
		await stop(service.child);
		await until(() => !srv.online(), "Fault fixture stayed connected.");
		const slowImage = join(tmp, "slow.cjs");
		await exec(process.execPath, ["runner/bundle.mjs", "fixture.invalid/sandbox@sha256:" + "0".repeat(64), slowImage], {
			cwd: root,
		});
		service = run(state, undefined, slowImage, {
			...wrappedDocker,
			CHECK_PULL_STARTED: pullStarted,
			CHECK_RELEASE_PULL: releasePull,
		});
		await until(
			() =>
				stat(pullStarted).then(
					() => true,
					() => false,
				),
			"The simulated pull did not start.",
		);
		await srv.attach();
		const pullingChannel = srv.channel(sessionId);
		const creates = Promise.all(
			[1, 2].map(() =>
				assert.rejects(pullingChannel.request("create", { profile: "docker-hardened" }), /pinned sandbox image/),
			),
		);
		try {
			assert.equal(await pullingChannel.request("state", { id: "m" + machineId + "-" + hostedRaw }), "none");
		} finally {
			await writeFile(releasePull, "done");
		}
		await creates;
		assert.equal(await readFile(pullStarted, "utf8"), "start\n");
		await stop(service.child);
		await until(() => !srv.online(), "Slow pull fixture stayed connected.");
		ok("Concurrent creates and welcome share one image pull while another lifecycle request completes.");
		async function startWithLimits(...flags: string[]) {
			srv.state.report = null;
			service = run(state, undefined, bundle, {}, { flags });
			await until(() => !!srv.state.report, "The runner did not report after changing its limits.");
		}
		async function stopService() {
			await stop(service.child);
			await until(() => !srv.online(), "The runner stayed connected after stopping.");
		}
		async function limitsInStatus(running: string, kept: string) {
			const lines = (await cli("status")).split("\n");
			assert.ok(lines.includes("Running sandbox limit: " + running));
			assert.ok(lines.includes("Kept sandbox limit: " + kept));
			return lines;
		}
		await startWithLimits();
		const boxes = [];
		for (let i = 0; i < 11; i++) {
			const session = i === 0 ? sessionId : i === 1 ? srv.other : sessionId + "_cap" + i;
			await srv.attach(session);
			const channel = srv.channel(session);
			const id = await channel.request("create", { profile: "docker-hardened" });
			if (i >= 1 && i <= 7) await channel.request("suspend", { id });
			boxes.push({ session, channel, id });
		}
		const inventory = await limitsInStatus("no limit", "no limit");
		assert.equal(inventory.filter(line => line.endsWith("  running")).length, 4);
		assert.equal(inventory.filter(line => line.endsWith("  paused")).length, 7);
		for (const { session, channel, id } of boxes.slice(2)) {
			await channel.request("destroy", { id });
			srv.reset(session);
		}
		ok("Without flags the runner keeps eleven sandboxes, four running, and status shows no limit for both.");
		const [first, secondBox] = boxes;
		await stopService();
		await startWithLimits("--max-running", "1");
		await limitsInStatus("1", "no limit");
		await until(() => first.channel.connected && secondBox.channel.connected, "The sessions did not reconnect.");
		const runningLimit = {
			name: "SandboxUserError",
			message: "This machine has reached its own limit on running sandboxes, set by --max-running.",
		};
		await assert.rejects(secondBox.channel.request("connect", { id: secondBox.id }), runningLimit);
		await secondBox.channel.request("destroy", { id: secondBox.id });
		await assert.rejects(secondBox.channel.request("create", { profile: "docker-hardened" }), runningLimit);
		await first.channel.request("suspend", { id: first.id });
		ok("--max-running 1 refuses a second start on resume and create with the owner's flag in the session message.");
		await stopService();
		await startWithLimits("--max-sandboxes", "1");
		await limitsInStatus("no limit", "1");
		await until(() => first.channel.connected && secondBox.channel.connected, "The sessions did not reconnect.");
		await assert.rejects(secondBox.channel.request("create", { profile: "docker-hardened" }), {
			name: "SandboxUserError",
			message: "This machine has reached its own limit on kept sandboxes, set by --max-sandboxes.",
		});
		await first.channel.request("destroy", { id: first.id });
		srv.detach(srv.other);
		await stopService();
		ok(
			"--max-sandboxes 1 counts the suspended sandbox and refuses a second create with the owner's flag in the session message.",
		);
		srv.state.gatewayLifetime = 2000;
		srv.state.report = null;
		service = run(
			state,
			undefined,
			bundle,
			{ ...wrappedDocker, CHECK_DF_LOG: measured },
			{ flags: ["--allow-profile", "docker-windlass-sandbox"] },
		);
		await until(() => !!srv.state.report, "Healthy runner did not report again.");
		ok("An unavailable daemon is reported, and a missing pin or less than 5 GB free prevents sandbox creation.");
		assert.equal(await readFile(measured, "utf8"), "df\n");
		const connections = srv.state.connections,
			requests = srv.state.connectionRequests;
		await wait(srv.state.gatewayLifetime + 100);
		srv.state.gatewayLifetime = 60_000;
		await srv.attach();
		assert.equal(srv.state.connections, connections);
		assert.equal(srv.state.connectionRequests, requests + 1);
		await srv.attach();
		assert.equal(srv.state.connectionRequests, requests + 1);
		ok(
			"An expired gateway credential is renewed for a session open and reused on the next open, on the original control connection.",
		);
		let ch = srv.channel(sessionId);
		let id: string;
		try {
			id = await ch.request("create", { profile: "docker-windlass-sandbox" });
			ok("Bubblewrap starts in the created sandbox.");
		} catch (error) {
			assert.match((error as Error).message, /Bubblewrap could not start in the new sandbox/);
			assert.equal(
				srv.state.report!.commandSandbox.ok,
				false,
				"Startup probe must reflect this kernel's create-time result.",
			);
			assert.equal((await docker(["ps", "-aq", ...ownedFilters])).stdout.trim(), "");
			ok("This kernel refused the create-time bubblewrap probe; the runner removed the failed sandbox.");
			id = await ch.request("create", { profile: "docker-hardened" });
		}
		assert.ok((await readFile(measured, "utf8")).split("df\n").length >= 3);
		const raw = id.slice(-12);
		assert.equal(id, "m" + machineId + "-" + raw);
		const name = containerName(raw);
		const [inspection] = JSON.parse((await docker(["inspect", name], { check: true })).stdout);
		assert.equal(inspection.Config.Labels[MACHINE_LABEL], machineId);
		assert.equal(inspection.Config.Labels["dev.windlass-platform.uid"], uid);
		assert.equal(inspection.Config.Labels["dev.windlass-platform.session"], sessionId);
		assert.equal(inspection.Config.Image, image);
		assert.equal(inspection.Config.User, "agent");
		const slot = localSizing().unit;
		assert.equal(inspection.HostConfig.Privileged, false);
		assert.equal(inspection.HostConfig.Memory, slot.memoryBytes);
		assert.deepEqual(inspection.HostConfig.CapDrop, ["ALL"]);
		assert.equal(inspection.HostConfig.PidsLimit, slot.pids);
		assert.equal(inspection.Mounts.length, 1);
		assert.equal(inspection.Mounts[0].Type, "volume");
		assert.notEqual(inspection.Mounts[0].Name, "wlp-user-" + uid);
		await until(() => reported(id), "Create did not promptly report the sandbox.", 5000);
		const reports = srv.state.reports;
		assert.equal(await ch.request("create", { profile: "docker-hardened" }), id);
		assert.equal(await containers(), name);
		assert.equal(srv.state.reports, reports);
		ok("Repeating create returns the one container and the unchanged inventory is reported once.");
		await ch.request("writeTextFile", { id, path: "/tmp/runner-file", content: "survives suspend" });
		await ch.request("writeSecretFile", { id, path: "/tmp/private-fixture", content: "ordinary fixture" });
		assert.equal(
			(await ch.request("ask", { id, argv: ["stat", "-c", "%a", "/tmp/private-fixture"] }))?.stdout.trim(),
			"600",
		);
		assert.equal((await ch.request("run", { id, command: "pwd", options: { cwd: "/tmp" } })).stdout.trim(), "/tmp");
		await ch.request("removeFiles", { id, paths: ["/tmp/private-fixture"] });
		await assert.rejects(ch.request("readTextFile", { id, path: "/tmp/absent-file" }), /cannot read.*absent-file/);
		assert.equal(srv.state.lastErrorKind, "sandbox");
		const log = await cli("log");
		assert.ok(
			!log.includes("ordinary fixture") && !log.includes("/tmp/private-fixture") && !log.includes("PRIVATE KEY"),
		);
		await ch.request("suspend", { id });
		assert.equal(await ch.request("state", { id }), "paused");
		assert.equal(await ch.request("create", { profile: "docker-hardened" }), id);
		assert.equal((await docker(["inspect", "-f", "{{.State.Status}}", name])).stdout.trim(), "exited");
		assert.equal((await ch.request("connect", { id }))?.cwd, "/workspace");
		assert.equal(await ch.request("readTextFile", { id, path: "/tmp/runner-file" }), "survives suspend");
		ok("Create, read, write, ask, run, suspend and resume use the pinned image, local limits and labelled volume.");

		await srv.attach(srv.other);
		await assert.rejects(
			srv.channel(srv.other).request("run", { id, command: "touch /tmp/wrong-session" }),
			/another session/,
		);
		assert.equal(srv.state.lastErrorKind, "refused");
		srv.unknownOperation();
		await assert.rejects(ch.request("run", { id, command: "touch /tmp/unknown-op" }), /does not serve/);
		await assert.rejects(
			ch.request("create", { profile: "docker-hardened", unexpected: true } as never),
			/Invalid arguments/,
		);
		assert.equal(
			(await ch.request("run", { id, command: "test ! -e /tmp/wrong-session && test ! -e /tmp/unknown-op" })).exitCode,
			0,
		);
		await docker(
			[
				"run",
				"-d",
				"--name",
				hostedName,
				"--label",
				LABEL_ARG,
				"--label",
				marker,
				"--label",
				"dev.windlass-platform.uid=" + uid,
				image,
				"sleep",
				"infinity",
			],
			{ check: true },
		);
		hosted = true;
		const foreign = "m" + machineId + "-" + hostedRaw;
		await assert.rejects(ch.request("destroy", { id: foreign }), /does not belong/);
		await assert.rejects(ch.request("run", { id: foreign, command: "touch /tmp/touched" }), /owned/);
		const hostedProvider = new DockerSandboxes({
			image,
			machine: null,
			dataVolume: async () => {
				throw Error("unexpected create");
			},
			dropDataVolume: async () => {},
		});
		assert.deepEqual(
			(await hostedProvider.list(uid)).map(x => x.id),
			[hostedRaw],
		);
		assert.ok(!(await cli("status")).includes(hostedRaw));
		assert.equal((await docker(["exec", hostedName, "test", "!", "-e", "/tmp/touched"])).code, 0);
		srv.detach(srv.other);
		srv.incompatible(srv.other);
		srv.ticket(srv.other);
		await until(() => !srv.channel(srv.other).connected, "The incompatible session stayed connected.");
		srv.incompatible();
		await srv.attach(srv.other);
		ok("An unverified session refusal cannot prevent the next authenticated attach.");
		ok("Cross-session, hosted and unknown operations are refused. Hosted and runner inventories are disjoint.");

		let output = "";
		const stopped = ch.start({ id, tag: "stopme", argv: ["sh", "-c", "echo ready; sleep 120"] }, (_, s) => {
			output += s;
		});
		await until(() => output.includes("ready"), "The process did not stream output.");
		await srv.attach(); // A new ticket takes over the live socket with this process still outstanding.
		assert.ok((await ch.request("ask", { id, argv: ["wlp-run", "list", "stopme"] }))?.stdout.trim());
		await ch.request("signal", { process: stopped.id, sig: "TERM", who: "all" });
		await stopped.ended;
		const abort = new AbortController();
		const cancelled = await ch.request(
			"run",
			{ id, command: "echo ready; sleep 120" },
			{ signal: abort.signal, onOutput: () => abort.abort() },
		);
		assert.equal(cancelled.aborted, true);
		assert.equal(cancelled.timedOut, false);
		ok("The server's tag identifies the process. Signalling stops it and cancel aborts a run.");

		// The marker is after the final blocking write: it cannot exist while the runner's pipes are paused.
		srv.acks(false);
		const hash = createHash("sha256");
		let bytes = 0;
		const stream = ch.start(
			{ id, tag: "pressure", argv: ["sh", "-c", "seq -f '%09.0f' 0 2097151; touch /tmp/writer-finished"] },
			(_, data) => {
				hash.update(data);
				bytes += data.length;
			},
		);
		// The window counts encoded frames, including JSON escapes for these newlines.
		// Observe the writer coming to rest without assuming eight MiB of payload fit.
		let lastBytes = 0,
			changed = Date.now();
		await until(() => {
			if (bytes !== lastBytes) {
				lastBytes = bytes;
				changed = Date.now();
			}
			return bytes >= 4 * 1024 ** 2 && Date.now() - changed > 1200;
		}, "The source did not stall with acknowledgements withheld.");
		assert.equal((await docker(["exec", name, "test", "!", "-e", "/tmp/writer-finished"])).code, 0);
		const peak = bytes;
		await wait(1000);
		assert.equal(bytes, peak);
		srv.cut();
		srv.acks(true);
		await wait(5000);
		srv.restore();
		assert.equal((await stream.ended).code, 0);
		assert.equal(bytes, 20 * 1024 ** 2);
		const expected = createHash("sha256");
		for (let n = 0; n < 2_097_152; n++) expected.update(String(n).padStart(9, "0") + "\n");
		assert.equal(hash.digest("hex"), expected.digest("hex"));
		ok("Withheld receipts block the container writer. After a real TCP cut all 20 MiB arrive once and in order.");

		let running = false;
		const oldRun = ch.request(
			"run",
			{ id, command: "echo ready; sleep 3; touch /tmp/orphan-finished" },
			{
				onOutput: () => {
					running = true;
				},
			},
		);
		const lost = assert.rejects(oldRun, ConversationLost);
		const acp = ch.start({ id, tag: "orphan", argv: ["windlass", "acp"] }, () => {});
		await until(
			async () => running && !!(await docker(["exec", name, "wlp-run", "list", "orphan"])).stdout.trim(),
			"Orphan fixture did not start.",
		);
		srv.reset();
		await srv.attach();
		ch = srv.channel(sessionId);
		await lost;
		assert.ok((await acp.ended).error instanceof ConversationLost);
		await until(
			async () => !(await docker(["exec", name, "wlp-run", "list", "orphan"])).stdout.trim(),
			"Reset left Windlass running.",
		);
		await until(
			async () => (await docker(["exec", name, "test", "-e", "/tmp/orphan-finished"])).code === 0,
			"Reset killed an independent run.",
		);
		ok(
			"Control logout removes the turn file. A fresh conversation closes Windlass and lets an independent command finish.",
		);

		// The crash test resumes a real session even when CI runs the outage sequence separately.
		const windlass = process.argv.includes("--service-only")
			? await scripted(ch, id, async () => {})
			: await checkOutages(ch, id, service.child);
		const crash = ch.start({ id, tag: "crash", argv: ["sh", "-c", "sleep 120 | windlass acp"] }, () => {});
		await until(
			async () => !!(await docker(["exec", name, "wlp-run", "list", "crash"])).stdout.trim(),
			"Crash fixture did not start.",
		);
		const epoch = srv.state.epoch;
		await stop(service.child, "SIGKILL");
		await until(() => !srv.online(), "Killed runner stayed online.");
		srv.state.report = null;
		srv.state.idleMs = 2000;
		// Section 9 row 2 uses a one-minute grace. Shorten only that timer in the test
		// process and restarted runner; the released runner has no timing override.
		const clock = join(tmp, "grace.cjs");
		await writeFile(
			clock,
			`const timer = global.setTimeout; global.setTimeout = (fn, ms, ...args) => timer(fn, ms === ${RUNNER_GRACE_MS} ? 60000 : ms, ...args);\n`,
		);
		service = run(state, clock);
		await until(() => srv.state.epoch !== epoch && !!srv.state.report, "Restart did not report.");
		assert.ok((await crash.ended).error instanceof ConversationLost);
		assert.ok(srv.state.report!.sandboxes.some(b => b.id === id));
		assert.ok(!srv.state.report!.sandboxes.some(b => b.id === foreign));
		assert.equal(await ch.request("create", { profile: "docker-hardened" }), id);
		assert.equal(await containers(), name);
		assert.ok((await ch.request("stopLeftovers", { id, program: "windlass" })) > 0);
		assert.equal(await ch.request("readTextFile", { id, path: "/tmp/runner-file" }), "survives suspend");
		const orphan = ch.start({ id, tag: "longloss", argv: ["windlass", "acp"] }, () => {});
		await until(
			async () => !!(await docker(["exec", name, "wlp-run", "list", "longloss"])).stdout.trim(),
			"Long-outage fixture did not start.",
		);
		const timer = globalThis.setTimeout;
		globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
			timer(fn, ms === RUNNER_GRACE_MS ? 60_000 : ms, ...args)) as typeof setTimeout;
		try {
			srv.cut();
			await until(() => !ch.connected, "The session socket stayed connected.");
			await wait(5000); // Longer than the two-second idle interval, within the conversation's grace.
			assert.equal((await docker(["inspect", "-f", "{{.State.Status}}", name])).stdout.trim(), "running");
			await wait(85_000);
			assert.ok((await orphan.ended).error instanceof ConversationLost);
			await until(
				async () => (await docker(["inspect", "-f", "{{.State.Status}}", name])).stdout.trim() === "exited",
				"The sandbox did not idle-stop after the orphaned Windlass process ended.",
			);
		} finally {
			globalThis.setTimeout = timer;
			srv.restore();
		}
		await until(() => ch.connected, "Fresh socket did not attach after the expired grace.", 90_000);
		await ch.request("connect", { id });
		assert.equal((await ch.request("ask", { id, argv: ["wlp-run", "list", "longloss"] }))?.stdout.trim(), "");
		await scripted(ch, id, async () => {}, windlass);
		ok(
			"Windlass keeps the disconnected sandbox running past idle time. After grace expires, the process ends, idle stops the sandbox, and Windlass can resume.",
		);
		srv.detach();
		await until(
			async () => (await docker(["inspect", "-f", "{{.State.Status}}", name])).stdout.trim() === "exited",
			"Welcome idle time was ignored.",
		);
		await srv.attach();
		await ch.request("connect", { id });
		await ch.request("destroy", { id });
		await until(() => !reported(id), "Destroy did not promptly report the removal.", 5000);
		assert.equal(await ch.request("state", { id }), "none");
		ok(
			"SIGKILL loses the conversation. Restart recovers only owned containers, the next turn can stop leftovers, and welcome controls idle suspension.",
		);

		const replacement = await ch.request("create", { profile: "docker-hardened" });
		assert.notEqual(replacement, id);
		const replacementName = containerName(replacement.slice(-12));
		assert.equal(await containers(), replacementName);
		await docker(["pause", replacementName], { check: true });
		assert.equal(await ch.request("create", { profile: "docker-hardened" }), replacement);
		assert.equal((await docker(["inspect", "-f", "{{.State.Status}}", replacementName])).stdout.trim(), "paused");
		await docker(["unpause", replacementName], { check: true });
		await docker(["rm", "-f", replacementName], { check: true });
		const remove = await ch.request("create", { profile: "docker-hardened" });
		assert.notEqual(remove, replacement);
		assert.equal(await containers(), containerName(remove.slice(-12)));
		await until(() => reported(remove) && !reported(replacement), "The new inventory was not reported.", 5000);
		srv.send({ kind: "remove", sandbox: remove });
		await until(() => srv.state.removed === remove, "Control removal not acknowledged.");
		await until(() => !reported(remove), "Control removal did not promptly update the report.", 5000);
		ok(
			"Create reuses a stopped, paused or rediscovered sandbox. Session destroy and external deletion each allow a fresh create, and both removal paths report promptly.",
		);
		await ch.request("create", { profile: "docker-hardened" });
		for (const refusal of [
			refuse("outdated", { runnerVersion: "0.0.9" }),
			refuse("bad-frame"),
			refuse("unknown"),
			{ kind: "refused", reason: "other", message: "Account unavailable." } as Refusal,
		]) {
			srv.send(refusal);
			await until(() => service.output().includes(refusal.message), "The refusal was not logged.");
			assert.equal(service.child.exitCode, null);
			assert.ok((await cli("status")).includes(refusal.message));
			assert.ok((await cli("log")).includes(refusal.reason));
			const count = srv.state.connectionRequests;
			await wait(1500);
			assert.equal(srv.state.connectionRequests, count);
			await until(() => srv.online(), "Runner missed its slow retry.", 12_000);
		}
		async function expectParked() {
			await until(async () => (await cli("status")).includes("was removed"), "Removal did not appear in status.");
			assert.match(await cli("log"), /windlass-runner pair.*new key/);
			assert.ok(JSON.parse(await readFile(join(state, "pair.json"), "utf8")).key === null);
			const attempts = srv.state.connectionRequests,
				starts = srv.state.pairStarts;
			await wait(7500); // More than twice this process's test REFUSED_RETRY_MS.
			assert.equal(srv.state.connectionRequests, attempts);
			assert.equal(srv.state.pairStarts, starts);
			assert.equal(service.child.exitCode, null);
		}
		srv.send(refuse("removed", { removeSandboxes: true }));
		await expectParked();
		assert.equal((await docker(["volume", "ls", "-q", ...ownedFilters])).stdout.trim(), "");
		assert.equal((await docker(["ps", "-aq", ...ownedFilters])).stdout.trim(), "");
		assert.match(await cli("pair"), /Paired with runner-check/);
		await until(() => srv.online(), "Pairing again left the runner idle.");
		await srv.attach();
		const kept = await ch.request("create", { profile: "docker-hardened" });
		await stop(service.child);
		srv.state.httpRefusal = "unknown";
		service = run();
		await until(() => service.output().includes("HTTP 403"), "HTTP refusal was not reported.");
		assert.equal(service.child.exitCode, null);
		assert.match(await cli("status"), /HTTP 403/);
		srv.state.httpRefusal = "removed";
		await expectParked();
		assert.equal(
			(
				await docker(["inspect", "-f", "{{.State.Status}}", containerName(kept.slice(-12))], { check: true })
			).stdout.trim(),
			"exited",
		);
		assert.match(await cli("log"), /removed/);
		await stop(service.child);
		ok("Recoverable refusals retry slowly. Both forms of removal erase the key and park until the owner acts.");

		const prune = spawn(process.execPath, [bundle, "prune"], { env: env(state), stdio: ["pipe", "ignore", "ignore"] });
		prune.stdin.end("yes\n");
		assert.equal(await new Promise(resolve => prune.on("exit", resolve)), 0);
		assert.equal((await docker(["ps", "-aq", ...ownedFilters])).stdout.trim(), "");
		assert.equal((await docker(["volume", "ls", "-q", ...ownedFilters])).stdout.trim(), "");
		assert.equal((await docker(["inspect", containerName(kept.slice(-12))])).code === 0, false);
		assert.equal((await docker(["inspect", "-f", "{{.State.Running}}", hostedName])).stdout.trim(), "true");
		ok(
			"Queued removal is acknowledged. Confirmed prune removes the machine's containers and volume and leaves hosted Docker intact.",
		);
	} finally {
		for (const p of children) await stop(p);
		await srv.close();
		if (claudePin) await docker(["rm", "-fv", setupName]);
		if (hosted) await docker(["rm", "-f", hostedName], { check: true });
		for (const id of (await docker(["ps", "-aq", ...ownedFilters])).stdout.trim().split(/\s+/).filter(Boolean))
			await docker(["rm", "-fv", id], { check: true });
		for (const v of (await docker(["volume", "ls", "-q", ...ownedFilters])).stdout.trim().split(/\s+/).filter(Boolean))
			await docker(["volume", "rm", v], { check: true });
		for (const net of (await docker(["network", "ls", "-q", ...ownedFilters])).stdout
			.trim()
			.split(/\s+/)
			.filter(Boolean))
			await docker(["network", "rm", net], { check: true });
	}
}
const privateHarnessTag = "chk-" + randomUUID();
const privateTag = process.env.WLP_RUNNER_CHECK_IMAGE ? undefined : `windlass-runner:chk-${randomUUID()}`;
try {
	const image = await imageId();
	if (
		process.argv.includes("--profiles-only") ||
		process.argv.includes("--sizing-only") ||
		process.argv.includes("--snapshots-only") ||
		process.argv.includes("--outages-only")
	) {
		await exec(process.execPath, ["runner/bundle.mjs", image, bundle], { cwd: root });
		await check(image);
	} else if (process.argv.includes("--harness-only")) {
		const { stdout } = await exec(join(root, "sandbox/harness/build.sh"), ["claude", image], {
			env: { ...process.env, WLP_HARNESS_TAG: privateHarnessTag },
		});
		const pin = stdout.trim();
		// A missing screenshots pin makes any attempt to fetch it for a Claude session fail.
		const unusedShots = "sha256:" + randomBytes(32).toString("hex");
		await exec(process.execPath, ["runner/bundle.mjs", image, bundle, unusedShots, "claude=" + pin], { cwd: root });
		await check(image, undefined, pin);
	} else if (process.argv.includes("--screenshots-only")) {
		const shots = await imageId(SHOTS_IMAGE);
		await exec(process.execPath, ["runner/bundle.mjs", image, bundle, shots], { cwd: root });
		await check(image, shots);
	} else {
		if (
			!process.argv.includes("--real-machine") &&
			!process.argv.includes("--main-only") &&
			!process.argv.includes("--service-only")
		) {
			for (const suite of ["--profiles-only", "--harness-only"]) {
				const focused = spawn(process.execPath, [...process.execArgv, process.argv[1]!, suite], { stdio: "inherit" });
				assert.equal(await new Promise(resolve => focused.on("exit", resolve)), 0);
			}
		}
		if (privateTag) {
			await exec(join(root, "scripts/runner-build.sh"), [image], {
				env: {
					...process.env,
					WLP_RUNNER_BUILD_TAG: privateTag,
					WLP_RUNNER_HARNESSES: "claude",
					WLP_HARNESS_TAG: privateHarnessTag,
					WLP_RUNNER_PLATFORMS: "",
				},
			});
		}
		const runnerImage = await imageId(privateTag ?? process.env.WLP_RUNNER_CHECK_IMAGE);
		if (!process.argv.includes("--real-machine")) {
			await exec(process.execPath, ["runner/bundle.mjs", image, bundle], { cwd: root });
			await check(image);
		}
		await realMachine(runnerImage);
	}
} catch (error) {
	// Client exceptions can contain signed URLs. Identify the failing assertion without replaying its arguments.
	const where = error instanceof Error ? /runner-check\.ts:(\d+)/.exec(error.stack ?? "")?.[1] : undefined;
	console.error(`FAIL  runner-check.ts line ${where ?? "unknown"}`);
	process.exitCode = 1;
} finally {
	await docker(["image", "rm", "windlass-platform-claude:" + privateHarnessTag]);
	if (privateTag && (await docker(["image", "inspect", privateTag])).code === 0) {
		await docker(["image", "rm", privateTag], { check: true });
	}
	await rm(tmp, { recursive: true, force: true });
}
// The in-process Rivet native runtime retains worker handles after registry.shutdown().
process.exit(process.exitCode ?? 0);
