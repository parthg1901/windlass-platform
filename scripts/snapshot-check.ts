// Run with tsx from server/. --docker adds the real Docker index and isolation checks.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotDeployment } from "../server/src/sandbox/snapshot-deployment.js";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
	canReuseSnapshot,
	canSaveSnapshot,
	dependencyHash,
	digest,
	snapshotPrompt,
	type TreeEntry,
} from "../server/src/sandbox/snapshot-key.js";
import {
	attemptLabel,
	candidateLabel,
	DockerSnapshots,
	evictions,
	relieveDiskPressure,
	snapshotLimits,
	sourceFromLabels,
} from "../server/src/sandbox/snapshots.js";
import { DATA_DIR, docker, LABEL } from "../server/src/sandbox/docker.js";
import {
	BUILT_IN_STORE_LIMITS,
	clampStoreLimits,
	DEFAULT_STORE_LIMITS,
	parseStoreSize,
	storeSettings,
} from "../server/src/sandbox/store-limits.js";
import { runSetupCommand } from "../server/src/sandbox/setup.js";
import { containerName, DockerSandboxes } from "../server/src/sandbox/sandboxes.js";
import { tokenFilePath } from "../server/src/sandbox/token-file.js";
import { imageId } from "./check-image.js";

const docs = readFileSync(new URL("../docs/configuration.md", import.meta.url), "utf8").split(
	"## Docker setup snapshots",
)[1];
assert.match(docs, /local fixture repository/);
const blob = (path: string, byte: string): TreeEntry => ({ path, type: "blob", mode: "100644", sha: byte.repeat(40) });
const files = [blob("package.json", "a"), blob("pkg/go.sum", "b"), blob(".nvmrc", "c")];
const hash = (tree: TreeEntry[]) => dependencyHash(tree);
const expected = await hash(files);
assert.ok(expected);
assert.equal(await hash(files.slice().reverse()), expected);
assert.equal(await hash([...files, blob("src/index.ts", "d")]), expected);
for (const path of [
	"package.json",
	"packages/lib/package.json",
	"Gemfile.lock",
	"composer.lock",
	"Pipfile.lock",
	"poetry.lock",
	"pyproject.toml",
	"requirements-dev.txt",
	"flake.lock",
	"mix.lock",
	"go.sum",
	"Cargo.lock",
	"package-lock.json",
	"bun.lockb",
	"bun.lock",
	"pnpm-lock.yaml",
	"yarn.lock",
	"uv.lock",
]) {
	const tree = [blob("anchor/yarn.lock", "a")];
	assert.notEqual(await hash([...tree, blob(path, "b")]), await hash([...tree, blob(path, "c")]), path);
}
for (const tree of [[], [files[0]], [files[0], files[2], blob(".tool-versions", "d")]])
	assert.equal(await hash(tree), null);
assert.throws(() => hash([files[1], { ...files[0], mode: "120000" }]));
assert.equal(canReuseSnapshot(true, "windlass", 0), true);
assert.equal(canReuseSnapshot(true, "windlass", 1), false);
assert.equal(canReuseSnapshot(false, "windlass", 0), false);
assert.equal(canReuseSnapshot(true, "claude", 0), false);
assert.equal(canSaveSnapshot(undefined, 0, true, 30000), true);
for (const eligible of [
	canSaveSnapshot(undefined, 1, true, 30000),
	canSaveSnapshot({ role: "builder", owns: [] }, 0, true, 30000),
	canSaveSnapshot({ role: "reviewer" }, 0, true, 30000),
	canSaveSnapshot(undefined, 0, false, 30000),
	canSaveSnapshot(undefined, 0, true, 29999),
])
	assert.equal(eligible, false);
const commit = "a".repeat(40);
assert.match(snapshotPrompt(commit), new RegExp(commit + ".*Rebuild"));
const rows = [
	{ uid: "A", bytes: 3, used: 1 },
	{ uid: "B", bytes: 6, used: 2 },
	{ uid: "A", bytes: 6, used: 3 },
];
assert.deepEqual(evictions(rows, 4, { machine: 12, user: 8, free: 0 }), [rows[0]]);
assert.deepEqual(evictions(rows, 4, { machine: 10, user: 10, free: 0 }), rows.slice(0, 2));
assert.deepEqual(evictions(rows, 15 * 86400000), rows);
assert.deepEqual(
	evictions([rows[2]], 4, { machine: 20, user: 8, free: 0 }, [rows[0]]),
	[rows[2]],
	"pinned layers count toward the user cap",
);
const retired: number[] = [],
	readings = [0, 0, 15];
assert.equal(
	await relieveDiskPressure(
		[...rows].reverse(),
		15,
		async () => readings.shift()!,
		async row => {
			retired.push(row.used);
		},
	),
	true,
);
assert.deepEqual(retired, [1, 2]);

// Sizes as the runner's flags take them: decimal units, any case, nothing else.
assert.equal(parseStoreSize("20GB"), 20e9);
assert.equal(parseStoreSize("512MB"), 512e6);
assert.equal(parseStoreSize("1.5tb"), 1.5e12);
assert.equal(parseStoreSize(" 0GB "), 0);
for (const bad of ["", "20", "20G", "20GiB", "-1GB", "1e3GB", "GB", "20 GB extra", "2000TB"])
	assert.equal(parseStoreSize(bad), null, bad);
assert.deepEqual(DEFAULT_STORE_LIMITS, { machine: 10e9, user: 2e9, free: 40e9 });
assert.deepEqual(BUILT_IN_STORE_LIMITS, { machine: 10e9, user: 2e9, free: 15e9 }, "what runner 0.3.1 applies");
assert.deepEqual(snapshotLimits, DEFAULT_STORE_LIMITS, "a store given no limits uses the defaults");

// The deployment's settings: its own Docker uses them, machines are held to the ones that are set.
assert.deepEqual(storeSettings({}), { own: { ...DEFAULT_STORE_LIMITS }, caps: {}, problems: [] });
const set = storeSettings({ WLP_SNAPSHOT_MACHINE_MAX_GB: "50", WLP_KEEP_FREE_MIN_GB: "12.5" });
assert.deepEqual(set.own, { machine: 50e9, user: 2e9, free: 12.5e9 });
assert.deepEqual(set.caps, { machine: 50e9, free: 12.5e9 });
assert.deepEqual(storeSettings({ WLP_KEEP_FREE_MIN_GB: "0" }).caps, { free: 0 });
for (const [name, value] of [
	["WLP_SNAPSHOT_MACHINE_MAX_GB", "0"],
	["WLP_SNAPSHOT_USER_MAX_GB", "ten"],
	["WLP_KEEP_FREE_MIN_GB", "-1"],
	["WLP_SNAPSHOT_MACHINE_MAX_GB", "2000000"],
]) {
	const bad = storeSettings({ [name]: value });
	assert.equal(bad.problems.length, 1, name + "=" + value);
	assert.match(bad.problems[0], new RegExp(name));
	assert.deepEqual(bad.caps, {}, "an unusable setting counts as not set");
	assert.deepEqual(bad.own, DEFAULT_STORE_LIMITS);
}

// Ceiling on the sizes, floor on keep-free: a machine can choose less space or more free disk, never the other way.
const caps = { machine: 20e9, user: 4e9, free: 30e9 };
assert.deepEqual(
	clampStoreLimits({ machine: 50e9, user: 8e9, free: 10e9 }, caps),
	caps,
	"more space and less free disk are held to the caps",
);
assert.deepEqual(
	clampStoreLimits({ machine: 5e9, user: 1e9, free: 60e9 }, caps),
	{ machine: 5e9, user: 1e9, free: 60e9 },
	"less space and more free disk stand",
);
assert.deepEqual(
	clampStoreLimits({ machine: 50e9, user: 1e9, free: 10e9 }, { free: 30e9 }),
	{ machine: 50e9, user: 1e9, free: 30e9 },
	"only the caps that are set apply",
);
assert.deepEqual(clampStoreLimits(DEFAULT_STORE_LIMITS), DEFAULT_STORE_LIMITS, "no caps from an older platform");

// Eviction under an owner's limits: a larger machine total keeps more, a smaller user share evicts sooner.
const many = Array.from({ length: 6 }, (_, n) => ({ uid: n % 2 ? "B" : "A", bytes: 3e9, used: n + 1 }));
assert.deepEqual(
	evictions(many, 10, DEFAULT_STORE_LIMITS).map(r => r.used),
	[1, 2, 3, 4, 5, 6],
	"the defaults: each 3 GB snapshot is over a user's 2 GB",
);
const roomy = clampStoreLimits({ machine: 15e9, user: 9e9, free: 40e9 });
assert.deepEqual(
	evictions(many, 10, roomy).map(r => r.used),
	[1],
	"--snapshot-disk 15GB --snapshot-user 9GB keeps five of six",
);
assert.deepEqual(
	evictions(many, 10, clampStoreLimits(roomy, { machine: 12e9 })).map(r => r.used),
	[1, 2],
	"the deployment's ceiling evicts down to 12 GB",
);
assert.deepEqual(
	evictions(many, 10, clampStoreLimits(roomy, { user: 6e9 })).map(r => r.used),
	[1, 2],
	"the deployment's ceiling on a user's share",
);
const reading = [5e9, 9e9, 20e9],
	gone: number[] = [];
assert.equal(
	await relieveDiskPressure(
		many,
		clampStoreLimits({ ...DEFAULT_STORE_LIMITS, free: 8e9 }, { free: 18e9 }).free,
		async () => reading.shift()!,
		async row => {
			gone.push(row.used);
		},
	),
	true,
);
assert.deepEqual(gone, [1, 2], "the deployment's keep-free floor evicts until 18 GB is free");
console.log(
	"PASS dependency key, writer and secret policy, first-prompt notice, user and machine eviction, expiry, store limits and their caps",
);

if (process.argv.includes("--docker")) {
	const base = await imageId(),
		machine = "m_" + randomBytes(8).toString("hex");
	const cache = new DockerSnapshots(machine, base),
		uid = "userA",
		profile = "docker-hardened";
	const directory = mkdtempSync(join(tmpdir(), "snapshot-proof-"));
	assert.equal(snapshotDeployment(directory, false), undefined);
	const deployment = snapshotDeployment(directory);
	assert.ok(deployment);
	assert.equal(snapshotDeployment(directory), deployment);
	assert.notEqual(snapshotDeployment(join(directory, "other")), deployment);
	const source = {
		attempt: randomBytes(16).toString("hex"),
		repo: "123",
		generation: digest(["settings"]),
		inputs: digest([expected, "npm ci"]),
		commit,
		created: Date.now(),
	};
	const other = { ...source, inputs: digest([expected, "npm ci --offline"]) };
	const fixture = "snapshot-check-" + machine,
		volume = fixture + "-data",
		consumer = fixture + "-read";
	const checked = async (...args: string[]) => (await docker(args, { check: true })).stdout.trim();
	const producer = async (name: string, request: typeof source) => {
		const selected = await cache.select(request, uid, profile);
		assert.equal(selected.hit, false);
		await checked(
			"run",
			"-d",
			"--pull",
			"never",
			"--name",
			name,
			"--user",
			"agent",
			"--cap-drop",
			"ALL",
			"--label",
			LABEL + ".uid=" + uid,
			"--label",
			LABEL + ".machine=" + machine,
			"--label",
			LABEL + ".session=producer",
			"--label",
			LABEL + ".profile=" + profile,
			"--label",
			attemptLabel + "=" + request.attempt,
			"--label",
			candidateLabel + "=" + selected.key,
			"-v",
			volume + ":" + DATA_DIR,
			base,
		);
		return selected;
	};
	const bigBox = fixture + "-large",
		alias = fixture + ":alias";
	const sandboxes = new DockerSandboxes({
		image: base,
		machine,
		dataVolume: async () => volume,
		dropDataVolume: async () => {},
	});
	const containers = [consumer, bigBox];
	try {
		const producerId = await sandboxes.create({
			uid,
			profile,
			sessionId: "producer",
			fromSnapshot: { ...source, writer: true },
		});
		const container = containerName(producerId);
		containers.push(container);
		const writer = await sandboxes.connect(producerId);
		assert.ok(writer);
		const selected = await cache.select(source, uid, profile);
		assert.equal(selected.hit, false);
		const setup = await runSetupCommand(writer, {
			cwd: writer.cwd,
			timeoutMs: 10_000,
			command: [
				`touch installed && echo data-only > ${DATA_DIR}/volume-secret`,
				"setsid env -i sh -c 'echo $$ > /tmp/setup-sleeper; exec /bin/sleep 610' </dev/null >/dev/null 2>&1 &",
				"while [ ! -s /tmp/setup-sleeper ]; do sleep 0.01; done",
			].join("\n"),
		});
		assert.equal(setup.state, "succeeded");
		await checked("exec", container, "sh", "-ec", 'pid=$(cat /tmp/setup-sleeper); test ! -e "/proc/$pid"');
		const noSpace = new DockerSnapshots(machine, base, undefined, { ...snapshotLimits, free: Number.MAX_SAFE_INTEGER });
		assert.equal(await noSpace.save(container, uid, profile, source), false);
		assert.equal(
			await cache.save(container, uid, profile, { ...source, attempt: randomBytes(16).toString("hex") }),
			false,
		);
		await checked("exec", "--user", "65534", container, "mkdir", "/tmp/wlp-transport-fixture");
		await checked("exec", container, "touch", "/tmp/wlp-stage-fixture");
		const producerToken = tokenFilePath(producerId);
		await checked(
			"exec",
			container,
			"sh",
			"-ec",
			'test "$(stat -f -c %T /dev/shm)" = tmpfs; echo fake-snapshot-token > "$1"',
			"sh",
			producerToken,
		);
		assert.equal(await sandboxes.saveSnapshot(producerId, source), true);
		await checked("exec", container, "test", "-s", producerToken);
		await checked("exec", container, "touch", "/workspace/after-turn");
		for (const mismatch of [
			await new DockerSnapshots(machine, base, undefined, undefined, true).select(source, uid, profile),
			await cache.select(source, "userB", profile),
			await cache.select(other, uid, profile),
			await cache.select({ ...source, generation: digest(["edited"]) }, uid, profile),
			await cache.select({ ...source, repo: "321" }, uid, profile),
			await cache.select(source, uid, "docker-windlass-sandbox"),
		])
			assert.equal(mismatch.hit, false);
		assert.equal(await cache.has(uid, source.repo), true);
		const isolated = new DockerSnapshots(machine, base, undefined, undefined, false, deployment);
		const isolatedSelection = await isolated.select(source, uid, profile);
		assert.notEqual(isolatedSelection.key, selected.key);
		assert.equal(isolatedSelection.hit, false);
		const unknown = new DockerSnapshots(machine, base, undefined, {
			...snapshotLimits,
			user: 1,
			free: Number.MAX_SAFE_INTEGER,
		});
		await unknown.sweepOwners(async () => null);
		assert.equal(await cache.has(uid, source.repo), true, "unknown owner lost its snapshot");
		const hit = await cache.select(source, uid, profile);
		assert.equal(hit.hit, true);
		assert.equal((await new DockerSnapshots(machine, hit.image).select(source, uid, profile)).hit, false);
		const restored = await sandboxes.create({
			uid,
			profile,
			sessionId: "restored",
			fromSnapshot: { ...source, writer: false },
		});
		try {
			const box = await sandboxes.connect(restored);
			assert.deepEqual(box?.snapshot, source);
			assert.ok(box);
			assert.equal(await checked("inspect", "--format", "{{.HostConfig.IpcMode}}", box.container), "private");
			// Export the underlying rootfs so a fresh /dev/shm mount cannot hide an image-layer leak.
			const archive = join(directory, "restored.tar");
			await checked("export", "-o", archive, box.container);
			const entries = execFileSync("tar", ["-tf", archive], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).split(
				"\n",
			);
			assert.ok(entries.includes("workspace/installed"));
			assert.ok(!entries.includes(producerToken.slice(1)));
			rmSync(archive);

			console.log("PASS committed rootfs excludes the producer's tmpfs token");
		} finally {
			await sandboxes.destroy(restored);
		}
		await checked(
			"run",
			"-d",
			"--pull",
			"never",
			"--name",
			consumer,
			"--label",
			LABEL + ".session=consumer",
			"--label",
			attemptLabel + "=" + source.attempt,
			hit.image,
		);
		const [a] = JSON.parse(await checked("container", "inspect", consumer));
		const [b] = JSON.parse(await checked("image", "inspect", base));
		assert.deepEqual(a.Config.Env, b.Config.Env);
		assert.equal(a.Config.Labels[LABEL + ".session"], "consumer");
		assert.equal(Object.values(a.Config.Labels).includes("producer"), false);
		assert.deepEqual(sourceFromLabels(a.Config.Labels), source);
		await checked(
			"exec",
			consumer,
			"sh",
			"-c",
			"test ! -e /tmp/wlp-transport-fixture && test ! -e /tmp/wlp-stage-fixture && test -f /workspace/installed && test ! -e /workspace/after-turn && test ! -e " +
				DATA_DIR +
				"/volume-secret",
		);
		// A candidate estimated between 1x and 2x writable bytes must leave the existing
		// image alone. Once refused it remains refused even after the writable layer shrinks.
		const large = { ...source, repo: "456", attempt: randomBytes(16).toString("hex") };
		await producer(bigBox, large);
		await checked("exec", bigBox, "sh", "-c", "head -c 4194304 /dev/urandom > /workspace/large");
		const size = Number(await checked("container", "inspect", "--size", "--format", "{{.SizeRw}}", bigBox));
		const limited = new DockerSnapshots(machine, base, undefined, { ...snapshotLimits, user: Math.ceil(size * 1.5) });
		assert.equal(await limited.save(bigBox, uid, profile, large), false);
		assert.equal(await cache.has(uid, source.repo), true, "oversize save evicted the previous image");
		await checked("exec", bigBox, "rm", "/workspace/large");
		assert.equal(await cache.save(bigBox, uid, profile, large), false, "refused key retried");

		await noSpace.sweep(uid);
		assert.equal(await cache.has(uid, source.repo), false, "disk pressure left the image available");
		const held = await checked("image", "inspect", "--format", "{{json .RepoTags}}", hit.image);
		assert.match(held, /:held-/, "in-use layers lost their accounting tag");
		await checked("rm", "-fv", consumer);
		assert.equal(await noSpace.save(container, uid, profile, source), false);
		assert.notEqual(
			(await docker(["image", "inspect", hit.image])).code,
			0,
			"pre-commit pressure retained released layers",
		);
		await cache.drop(uid);
		assert.equal(await cache.save(container, uid, profile, source), true);

		process.env.WLP_RUNNER_STATE_DIR = directory;
		Object.assign(globalThis, { SANDBOX_IMAGE: base, SHOTS_IMAGE_PIN: "" });
		const { storePair } = await import("../runner/src/state.js");
		const { snapshotMaintenance } = await import("../runner/src/snapshot-retention.js");
		const platform = "https://fixture.invalid",
			key = generateKeyPairSync("ed25519").privateKey;
		const current = { uid: "newOwner", machineId: "m_" + randomBytes(8).toString("hex") };
		storePair({ uid, machineId: machine }, key, platform);
		storePair(current, key, platform);
		const last = await cache.select(source, uid, profile);
		assert.equal(last.hit, true);
		await checked("tag", last.image, alias);
		await checked("run", "-d", "--pull", "never", "--name", consumer, last.image);
		await snapshotMaintenance(current, key, platform, null, () => snapshotLimits)(Date.now());
		assert.equal(await cache.has(uid, source.repo), false, "re-pairing retained the previous owner's snapshot");
		assert.equal(
			await checked("image", "inspect", "--format", "{{.Id}}", alias),
			last.image,
			"removed a tag outside the index",
		);
		// Replacing the tags leaves a pinned image with no repository name, as on older runners.
		const tags: string[] = JSON.parse(await checked("image", "inspect", "--format", "{{json .RepoTags}}", last.image));
		const heldTag = tags.find(tag => tag.includes(":held-"));
		assert.ok(heldTag);
		await checked("image", "rm", heldTag);
		await checked("tag", base, alias);
		const owners: string[] = [];
		await cache.sweepOwners(async owner => {
			owners.push(owner);
			return null;
		});
		assert.deepEqual(owners, [uid], "the untagged image disappeared from accounting");
		await checked("rm", "-fv", consumer);
		await cache.sweep(uid);
		assert.notEqual(
			(await docker(["image", "inspect", last.image])).code,
			0,
			"released untagged layer survived the sweep",
		);
		console.log(
			"PASS Docker admission, refusal memory, deployment isolation, unknown owners, transport cleanup, disk pressure, pinned layers and re-pairing",
		);
	} finally {
		await docker(["rm", "-fv", ...containers]);
		await cache.drop(uid);
		await docker(["image", "rm", alias]);
		await docker(["volume", "rm", volume]);
		rmSync(directory, { recursive: true, force: true });
	}
}
