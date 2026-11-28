/** From server/: npx tsx ../scripts/daytona-provider-test.ts. No Daytona credentials or network. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DeploymentFull } from "../server/src/sandbox/api.js";
import { readDaytonaSettings } from "../server/src/sandbox/daytona/config.js";
import { HOSTED_SIZE_SPECS, isHostedSize } from "../server/src/contract.js";
import type { OpenPty } from "../server/src/sandbox/daytona/guest.js";
import {
	createDaytonaProvider,
	DaytonaProvider,
	type DaytonaClient,
	type Machine,
} from "../server/src/sandbox/daytona/provider.js";
import { META } from "../server/src/sandbox/e2b/sandboxes.js";
import { HostedSandboxes } from "../server/src/sandbox/hosted.js";
import { DATA_DIR, shellQuote } from "../server/src/sandbox/provider.js";
import { GUEST_NODE } from "../server/src/sandbox/plan-relay.js";
import { turnTokenFilePath, writePlanPlaceholder } from "../server/src/sandbox/token-file.js";

type CreateSandbox = Parameters<DaytonaClient["create"]>[0];

class FakeDaytona implements DaytonaClient {
	readonly machines = new Map<string, Machine>();
	readonly creates: CreateSandbox[] = [];
	readonly filters: Record<string, string>[] = [];
	activity = 0;
	constructor(private readonly openPty: OpenPty) {}

	async create(input: CreateSandbox) {
		this.creates.push(input);
		const id = "vm-" + this.creates.length;
		const labels = { ...input.labels },
			size = labels[META.size];
		if (!isHostedSize(size)) throw new Error("Unknown size");
		const spec = HOSTED_SIZE_SPECS[size];
		const vm: Machine = {
			id,
			name: input.name!,
			labels,
			snapshot: input.snapshot,
			user: input.user!,
			public: !!input.public,
			target: input.target ?? "us",
			sandboxClass: "linux-vm",
			state: "started",
			cpu: spec.cpus,
			memory: spec.memoryMiB / 1024,
			disk: { small: 3, standard: 8, large: 10 }[size],
			process: { createPty: this.openPty },
			start: async () => {
				vm.state = "started";
			},
			stop: async () => {
				vm.state = "stopped";
			},
			delete: async () => {
				this.machines.delete(id);
			},
			refreshActivity: async () => {
				this.activity++;
			},
		};
		this.machines.set(id, vm);
		return vm;
	}
	async get(id: string) {
		return this.machines.get(id);
	}
	async *list({ labels }: Parameters<DaytonaClient["list"]>[0]) {
		this.filters.push(labels);
		for (const vm of this.machines.values()) {
			if (Object.entries(labels).every(([key, value]) => vm.labels[key] === value)) yield vm;
		}
	}
}

const root = fileURLToPath(new URL("../", import.meta.url));
const disk = await mkdtemp(join(root, ".daytona-check-"));
const launchers: string[] = [],
	inputs: string[] = [];
// script(1) provides a real terminal for the shipped bridge. Only the SDK and OS user switch are simulated.
const openPty: OpenPty = async ({ onData }) => {
	const child = spawn(
		"script",
		["-qefc", "exec /usr/bin/python3 -I " + shellQuote(join(root, "sandbox/daytona/process.py")), "/dev/null"],
		{
			cwd: disk,
			env: { PATH: disk + ":/usr/local/bin:/usr/bin:/bin", HOME: disk, LANG: "C.UTF-8" },
		},
	);
	let launched = false,
		requested = false;
	child.stdout.on("data", chunk => onData(chunk));
	const done = new Promise<{ exitCode?: number }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", code => resolve({ exitCode: code ?? undefined }));
	});
	return {
		async sendInput(data) {
			const text = String(data);
			if (!launched) {
				launched = true;
				launchers.push(text);
				assert.match(text, /sudo -n -H -u (agent|nobody) -- \/usr\/bin\/setpriv --no-new-privs/);
				return;
			}
			inputs.push(text);
			let frame = JSON.parse(text);
			if (!requested) {
				requested = true;
				frame = {
					...frame,
					cwd: disk,
					command: frame.command
						.replaceAll("/tmp/wlp-transport-process-", disk + "/transport-")
						.replaceAll(GUEST_NODE, process.execPath)
						.replaceAll(DATA_DIR, disk)
						.replaceAll("/workspace/", disk + "/"),
				};
			}
			await new Promise<void>((resolve, reject) =>
				child.stdin.write(JSON.stringify(frame) + "\n", error => (error ? reject(error) : resolve())),
			);
		},
		wait: () => done,
		kill: async () => {
			child.kill();
		},
		disconnect: async () => {
			child.stdout.removeAllListeners("data");
		},
	};
};

try {
	await writeFile(join(disk, "windlass"), "#!/bin/sh\necho 'Windlass 0.7.1'\n", { mode: 0o755 });
	const run = await readFile(join(root, "sandbox/wlp-run"), "utf8");
	await writeFile(join(disk, "wlp-run"), run.replace("dir=/tmp/.wlp-run", "dir=" + shellQuote(join(disk, "runs"))), {
		mode: 0o755,
	});
	const env = {
		WLP_MODEL_RELAY_URL: "https://relay.example.com",
		DAYTONA_TARGET: "eu",
		WLP_HOSTED_DEPLOYMENT: "canary",
		WLP_HOSTED_SIZES: "standard,large",
		WLP_HOSTED_MAX_RUNNING: "1",
		WLP_HOSTED_IDLE_TIMEOUT_MS: "61000",
	};
	assert.throws(() => readDaytonaSettings({}), /relay/i);
	assert.throws(() => readDaytonaSettings({ ...env, WLP_MODEL_RELAY: "off" }), /relay/i);
	assert.throws(() => readDaytonaSettings({ ...env, WLP_HOSTED_NETWORK: "restricted" }), /allow-list/);
	assert.throws(() => readDaytonaSettings({ ...env, WLP_HOSTED_SNAPSHOTS: "on" }), /prepared environments/);
	const settings = readDaytonaSettings(env),
		fake = new FakeDaytona(openPty);
	assert.throws(() => createDaytonaProvider(settings, ""), /DAYTONA_API_KEY/);
	const boxes = new HostedSandboxes(new DaytonaProvider(fake, settings));
	assert.equal(boxes.hasSnapshot, undefined);
	assert.equal(boxes.idleStopMs, 120_000);
	assert.deepEqual(
		boxes
			.profiles()
			.filter(p => p.available)
			.map(p => p.id),
		["daytona"],
	);
	assert.equal(boxes.profile("daytona").accessTokenReadable, false);
	assert.equal(boxes.profile("e2b").available, false);
	const input = { uid: "alice", sessionId: "test", profile: "daytona" as const, hostedSize: "standard" as const };
	await assert.rejects(boxes.create({ ...input, profile: "e2b" }), /allow-list/);
	const id = await boxes.create(input),
		vm = fake.machines.get(id)!;
	assert.deepEqual(vm.labels, {
		wlp_deployment: "canary",
		wlp_uid: "alice",
		wlp_session: "test",
		wlp_size: "standard",
		wlp_network: "open",
		wlp_profile: "daytona",
	});
	assert.equal(vm.snapshot, "windlass-platform-sandbox-standard");
	assert.equal(vm.target, "eu");
	assert.equal(vm.disk, 8);
	vm.disk = 3;
	await assert.rejects(boxes.connect(id), /Medium resource shape/);
	vm.disk = 8;
	assert.equal(fake.creates[0]?.autoPauseInterval, 0);
	assert.equal(fake.creates[0]?.autoStopInterval, 2);
	assert.equal(fake.creates[0]?.autoDeleteInterval, -1);
	assert.equal(fake.creates[0]?.public, false);
	await assert.rejects(boxes.create(input), DeploymentFull);
	assert.deepEqual(await boxes.list("alice"), [{ id, sessionId: "test", state: "running" }]);
	assert.deepEqual(fake.filters.at(-1), { [META.deployment]: "canary", [META.uid]: "alice" });
	assert.deepEqual(await boxes.owners(), ["alice"]);
	assert.deepEqual(await boxes.list("bob"), []);
	const guest = (await boxes.connect(id))!;
	const release = await guest.holdForTurn();
	await release();
	assert.equal(fake.activity, 2);
	await guest.writeTextFile("nested/file", "disk contents");
	// Windlass here pays with the ChatGPT plan: the sandbox gets only a placeholder file.
	const file = { path: turnTokenFilePath(guest) };
	await writePlanPlaceholder(guest, file.path, "wlp-plan." + "p".repeat(43), Date.now() + 3_600_000);
	const stored = JSON.parse(await guest.readTextFile(file.path));
	assert.equal(stored.accessToken, "wlp-plan." + "p".repeat(43));
	assert.equal((await stat(resolve(disk, file.path.split("/").at(-1)!))).mode & 0o777, 0o600);
	let out = "",
		err = "",
		gotLine!: () => void;
	const streamed = new Promise<void>(resolve => {
		gotLine = resolve;
	});
	const proc = guest.start(["sh", "-c", 'printf "ready\\n"; cat; printf "%s" "$PRIVATE" >&2; exit 7'], {
		secretEnv: { PRIVATE: "off-argv" },
		onStdout: s => {
			out += s;
			if (out.includes("ready\n")) gotLine();
		},
		onStderr: s => {
			err += s;
		},
	});
	await Promise.race([
		streamed,
		proc.ended.then(() => {
			throw new Error("Process ended before interactive input");
		}),
	]);
	proc.write("first\n");
	proc.write("世界\n");
	proc.closeStdin();
	assert.equal((await proc.ended).code, 7);
	assert.equal(out, "ready\nfirst\n世界\n");
	assert.equal(err, "off-argv");
	assert.ok(!launchers.join("").includes("off-argv"));
	assert.equal((await guest.run("sleep 10", { timeoutMs: 500 })).timedOut, true);
	assert.equal((await guest.run("true", { gitUser: true })).exitCode, 0);
	assert.ok(launchers.some(line => line.includes("-u nobody --")));
	// A Claude plan's relay: as the transport user, its program and token on standard input, gone at the turn's end.
	const planToken = "sk-ant-oat01-FAKE-DAYTONA-PLAN-" + "q".repeat(30);
	const launched = launchers.length,
		sent = inputs.length;
	const relay = await guest.localPlanRelay!(planToken, { wire: "claude-plan", harness: "claude" });
	assert.equal(launchers.length, launched + 1);
	assert.match(launchers.at(-1)!, /-u nobody --/);
	const request = JSON.parse(inputs[sent]!);
	assert.ok(!JSON.stringify(request).includes(planToken));
	assert.ok(request.command.includes("git-run"));
	assert.ok(!launchers.join("").includes(planToken));
	const base = new URL(relay.env.WINDLASS_MODEL_BASE_URL!);
	assert.equal(base.hostname, "127.0.0.1");
	const hello = (bearer: string) =>
		fetch(new URL("/api/hello", base), { method: "HEAD", headers: { authorization: `Bearer ${bearer}` } }).then(
			r => r.status,
		);
	assert.equal(await hello(relay.placeholder), 200);
	assert.equal(await hello(planToken), 401);
	await relay.close();
	await assert.rejects(hello(relay.placeholder));
	await boxes.suspend(id);
	assert.equal(await boxes.state(id), "paused");
	assert.equal((await boxes.list("alice"))[0]?.state, "paused");
	fake.machines.set("peer", { ...vm, id: "peer", state: "started" });
	await assert.rejects(boxes.connect(id), DeploymentFull);
	assert.equal(vm.state, "stopped");
	fake.machines.delete("peer");
	const resumed = (await boxes.connect(id))!;
	assert.equal(await resumed.readTextFile("nested/file"), "disk contents");
	await assert.rejects(resumed.readTextFile(file.path));
	vm.state = "stopping";
	await assert.rejects(boxes.observe(id), /stopping/);
	await assert.rejects(boxes.list("alice"), /stopping/);
	vm.state = "started";
	vm.target = "us";
	assert.equal(await boxes.state(id), "none");
	await boxes.suspend(id);
	assert.equal(vm.state, "started");
	vm.target = "eu";
	vm.labels[META.deployment] = "other";
	assert.equal(await boxes.connect(id), undefined);
	await boxes.destroy(id);
	assert.ok(fake.machines.has(id));
	assert.deepEqual(await boxes.owners(), []);
	vm.labels[META.deployment] = "canary";
	await boxes.destroy(id);
	await boxes.destroy(id);
	assert.equal(await boxes.state(id), "none");
	assert.deepEqual(
		boxes.sizes().map(s => [s.cpus, s.memoryMiB]),
		[
			[1, 1024],
			[2, 4096],
			[4, 8192],
		],
	);
	assert.ok(Math.abs(boxes.price().usdPerSecond - 0.00001859) < 1e-14);
	const rateFile = join(disk, "rates.json");
	await writeFile(
		rateFile,
		JSON.stringify({ daytona: { "linux-vm": { usdPerVcpuSecond: 1, usdPerGiBSecond: 2, usdPerDiskGiBSecond: 3 } } }),
	);
	assert.equal(
		new DaytonaProvider(fake, readDaytonaSettings({ ...env, WLP_HOSTED_RATE_CARD_FILE: rateFile })).price()
			.usdPerSecond,
		12,
	);
	console.log("Daytona provider, guest pipes, relay, lifecycle, capacity and pricing passed.");
} finally {
	await rm(disk, { recursive: true, force: true });
}
