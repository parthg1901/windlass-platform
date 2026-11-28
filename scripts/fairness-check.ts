// Local checks for machine scheduling and session persistence.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LABEL, MACHINE_LABEL } from "../server/src/sandbox/docker.js";
import { DockerSandboxes } from "../server/src/sandbox/sandboxes.js";

Object.assign(globalThis, { SANDBOX_IMAGE: "fixture", SHOTS_IMAGE_PIN: "", HARNESS_IMAGES: { claude: "fixture" } });

const identity = { uid: "u_fixture", machineId: "m_fixture" };

test("agent containers get low CPU shares and the machine's CPU cap", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wlp-flags-"));
	const path = process.env.PATH,
		cap = process.env.WLP_RUNNER_CPUS;
	process.env.WLP_RUNNER_STATE_DIR = dir;
	const { Executor } = await import("../runner/src/docker-executor.js");
	const { localSizing, sizeMachine } = await import("../runner/src/sizing.js");
	try {
		writeFileSync(join(dir, "docker"), '#!/bin/sh\nif [ "$1" = run ]; then printf "%s\\n" "$@" > "$0.args"; fi\n', {
			mode: 0o755,
		});
		process.env.PATH = dir + ":" + path;
		for (const override of [undefined, "0.75"]) {
			if (override) process.env.WLP_RUNNER_CPUS = override;
			else delete process.env.WLP_RUNNER_CPUS;
			const owner = new Executor(identity, {}, false, true);
			owner.network.attach = async () => {};
			owner.network.prepare = async () => {}; // This check captures session CPU flags without a daemon.
			owner.disk = async () => 10_000_000_000;
			owner.existing = async () => undefined;
			owner.ownedVolume = async () => true;
			owner.prepareClaudeRelay = async () => ({
				env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:17892", CLAUDE_CODE_OAUTH_TOKEN: "fixture" },
				nonce: "0".repeat(32),
			});
			for (const harness of [undefined, "claude"] as const) {
				await owner.create("s_fixture", "docker-hardened", false, harness);
				const flags = readFileSync(join(dir, "docker.args"), "utf8").trim().split("\n");
				const value = (flag: string) => (flags.includes(flag) ? flags[flags.indexOf(flag) + 1] : undefined);
				assert.equal(value("--cpu-shares"), "256");
				assert.equal(value("--cpus"), override ?? String(localSizing().unit.cpus));
				assert.equal(flags.filter(f => f === "--cpus").length, 1);
				assert.equal(value("--cap-drop"), "ALL");
			}
		}
		const owner = new Executor(identity, { slots: sizeMachine({ cores: 8, memoryBytes: 32 * 2 ** 30 }) });
		owner.network.attach = async () => {};
		owner.network.prepare = async () => {};
		owner.disk = async () => 10_000_000_000;
		owner.existing = async () => undefined;
		owner.ownedVolume = async () => true;
		await owner.create("s_large", "docker-hardened", false, undefined, 2);
		const args = readFileSync(join(dir, "docker.args"), "utf8").trim().split("\n");
		for (const [flag, value] of [
			["--cpus", "4"],
			["--memory", "16384m"],
			["--memory-swap", "16384m"],
			["--pids-limit", "2048"],
		])
			assert.equal(args[args.indexOf(flag) + 1], value);
		process.env.WLP_RUNNER_CPUS = "1 --privileged";
		assert.throws(() => new Executor(identity, {}), /WLP_RUNNER_CPUS/);
	} finally {
		process.env.PATH = path;
		if (cap === undefined) delete process.env.WLP_RUNNER_CPUS;
		else process.env.WLP_RUNNER_CPUS = cap;
		rmSync(dir, { recursive: true, force: true });
	}
});

const sandboxId = "0123456789ab";
const sandboxName = "wlp-session-" + sandboxId;

function mockInspect(t: TestContext, status: "exited" | "running", commands = "") {
	const dir = mkdtempSync(join(tmpdir(), "wlp-inspect-"));
	const path = process.env.PATH!;
	t.after(() => {
		process.env.PATH = path;
		rmSync(dir, { recursive: true, force: true });
	});
	// Pair each template field with its rendered value so a format change is visible to the check.
	const fields = {
		"{{.State.Status}}": status,
		"{{.HostConfig.CpuShares}}": 256,
		"{{.HostConfig.NanoCpus}}": 1_000_000_000,
		"{{.HostConfig.Memory}}": 1.5 * 2 ** 30,
		"{{.HostConfig.MemorySwap}}": 1.5 * 2 ** 30,
		"{{.HostConfig.PidsLimit}}": 512,
		"{{.Image}}": "sha256:" + "0".repeat(64),
	};
	const format = [Object.keys(fields).join("|"), "{{json .Mounts}}", "{{json .Config.Labels}}"].join("\n");
	const labels = {
		[LABEL]: "1",
		[MACHINE_LABEL]: identity.machineId,
		[LABEL + ".profile"]: "docker-hardened",
		[LABEL + ".uid"]: identity.uid,
	};
	const output = join(dir, "docker.inspect");
	writeFileSync(output, [Object.values(fields).join("|"), "[]", JSON.stringify(labels)].join("\n") + "\n");
	writeFileSync(
		join(dir, "docker"),
		`#!/bin/sh
if [ "$1 $2 $3" = "container inspect --format" ] && [ "$4" = '${format}' ] && [ "$5" = '${sandboxName}' ]; then
	exec cat "$0.inspect"
fi
printf '%s\\n' "$*" >> "$0.args"
case "$1" in
	${commands}
	*) exit 1 ;;
esac
`,
		{ mode: 0o755 },
	);
	process.env.PATH = dir + ":" + path;
	return { output, calls: () => readFileSync(join(dir, "docker.args"), "utf8").trimEnd().split("\n") };
}

test("a resumed sandbox adopts this runner's CPU policy", async t => {
	const docker = mockInspect(t, "exited", "update|start|exec) exit 0 ;;");
	const options = {
		machine: identity.machineId,
		dataVolume: async () => "fixture",
		dropDataVolume: async () => {},
		slots: {
			max: 2,
			unit: { cpus: 0.75, memoryBytes: 1.5 * 2 ** 30, pids: 512 },
			reserve: { cpus: 0, memoryBytes: 0 },
		},
	};
	assert.ok(await new DockerSandboxes(options).connect(sandboxId));
	assert.deepEqual(docker.calls(), [
		`update --memory 1536m --memory-swap 1536m --cpu-shares 256 --cpus 0.75 --pids-limit 512 ${sandboxName}`,
		`start ${sandboxName}`,
		`exec ${sandboxName} /bin/sh -c /bin/rm -f -- /home/agent/.local/share/windlass/access-token-*.json /home/agent/.local/share/windlass/access-token-*.json.tmp`,
	]);
});

test("a daemon refusal to lower memory leaves the running session usable", async t => {
	const docker = mockInspect(
		t,
		"running",
		`
		pause|unpause|exec) exit 0 ;;
		system) cat >/dev/null; printf 'HTTP/1.0 200 OK\\r\\n\\r\\n{"memory_stats":{"usage":4096}}' ;;
		update) echo 'memory limit is below current usage' >&2; exit 1 ;;
	`,
	);
	const provider = new DockerSandboxes({
		machine: identity.machineId,
		dataVolume: async () => "fixture",
		dropDataVolume: async () => {},
		slots: { max: 2, unit: { cpus: 1, memoryBytes: 2 ** 30, pids: 512 }, reserve: { cpus: 0, memoryBytes: 0 } },
	});
	assert.equal((await provider.connect(sandboxId))?.resizePending, true);
	assert.deepEqual(docker.calls(), [
		`pause ${sandboxName}`,
		"system dial-stdio",
		`update --memory 1024m --memory-swap 1024m --cpu-shares 256 --cpus 1 --pids-limit 512 ${sandboxName}`,
		`unpause ${sandboxName}`,
		`exec ${sandboxName} /bin/sh -c /bin/rm -f -- /home/agent/.local/share/windlass/access-token-*.json /home/agent/.local/share/windlass/access-token-*.json.tmp`,
	]);
});

test("an empty or truncated inspect response identifies the sandbox", async t => {
	const docker = mockInspect(t, "exited");
	const provider = new DockerSandboxes({
		machine: identity.machineId,
		dataVolume: async () => "fixture",
		dropDataVolume: async () => {},
	});
	const truncated = readFileSync(docker.output, "utf8").trimEnd().slice(0, -1);
	for (const output of ["", truncated]) {
		writeFileSync(docker.output, output);
		await assert.rejects(provider.connect(sandboxId), {
			message: `docker container inspect returned missing or invalid labels or mounts JSON for ${sandboxName}`,
		});
	}
});

test("runner advertises machine-sized slots by default, and accepts a positive whole-number override", async () => {
	const { Executor } = await import("../runner/src/docker-executor.js");
	const { localSizing } = await import("../runner/src/sizing.js");
	const { parseRunnerFrame } = await import("../server/src/runner/control.js");
	const hello = {
		kind: "hello",
		runnerVersion: "1.0.0",
		epoch: "e0123456789",
		time: Date.now(),
		signature: "A".repeat(86),
	};
	const parse = (extra: object) => parseRunnerFrame(JSON.stringify({ ...hello, ...extra }));
	assert.equal(new Executor(identity, {}).maxTurns, localSizing().max);
	assert.equal(new Executor(identity, { maxTurns: 3 }).maxTurns, 3);
	assert.ok(parse({ maxTurns: 2 }));
	assert.ok(parse({}));
	for (const cap of [0, -1, 1.5, "3", null]) assert.equal(parse({ maxTurns: cap }), null);
});

test("a snapshot during attach still waits for the first machine profile", async () => {
	const { RunnerLink } = await import("../server/src/sandbox/runner-layer.js");
	let release!: () => void;
	const wait = new Promise<void>(resolve => {
		release = resolve;
	});
	const link = new RunnerLink(
		{ ...identity, sessionId: "s_test" },
		{
			facts: async () => {
				await wait;
				return { status: "online", name: "Fixture", publicKey: "", report: null };
			},
			attach: async () => ({ ok: false, reason: "offline" }),
			removeSandbox: async () => {},
		},
		() => {},
	);
	const attach = link.ready().catch(() => {});
	try {
		let settled = false;
		const snapshot = link.snapshotFacts().then(() => {
			settled = true;
		});
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(settled, false, "snapshot returned without its profile");
		release();
		await snapshot;
		assert.equal(link.known?.name, "Fixture");
	} finally {
		release();
		link.close();
		await attach;
	}
});
