// From server: pnpm exec tsx ../scripts/codex-docker-check.mjs <local Codex image id>
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { build } from "../runner/node_modules/esbuild/lib/main.js";

const pin = process.argv[2];
assert.match(pin ?? "", /^sha256:[a-f0-9]{64}$/);
const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(join(root, ".codex-proof-"));
const id = randomBytes(8).toString("hex"),
	prefix = "f3-check-" + id;
const machineId = "m_" + id,
	net = prefix + "-uplink",
	upstream = prefix + "-upstream";
const real = (...args) => execFileSync("/usr/bin/docker", args, { encoding: "utf8" }).trim();
const jwt = () =>
	"eyJhbGciOiJub25lIn0." +
	Buffer.from(JSON.stringify({ canary: randomBytes(20).toString("hex") })).toString("base64url") +
	".fixture";
const random = () => randomBytes(24).toString("hex");
const markers = { access: jwt(), key: "sk-" + random() };
const observe = value => {
	for (const secret of Object.values(markers))
		assert.ok(!String(value).includes(secret), "credential crossed the session boundary");
};
Object.assign(process.env, {
	WLP_SECRET: random(),
	WLP_RUNNER_STATE_DIR: dir,
	F3_HARNESS: "codex",
	F3_MACHINE: machineId,
	F3_PREFIX: prefix,
	F3_DIR: dir,
	PATH: dir + ":" + process.env.PATH,
});
Object.assign(globalThis, {
	SANDBOX_IMAGE: pin,
	SHOTS_IMAGE_PIN: "",
	HARNESS_IMAGES: { codex: pin },
	// The Codex key relay is server.cjs's `WLP_HARNESS_KEYS` mode (runner/src/claude-relay.ts `RELAYS`).
	CLAUDE_RELAY_SCRIPT: (
		await build({
			entryPoints: [join(root, "sandbox/relay/server.cjs")],
			bundle: true,
			platform: "node",
			format: "cjs",
			write: false,
		})
	).outputFiles[0].text,
});
await symlink(join(root, "fixtures/claude-relay/docker.cjs"), join(dir, "docker"));
const { storePair } = await import("../runner/src/state.ts");
const { Executor } = await import("../runner/src/docker-executor.ts");
const { docker } = await import("../server/src/sandbox/docker.ts");
const { channelTurn } = await import("../fixtures/opencode/channel.mjs");
const { optionsDigest, compactReport } = await import("../server/src/runner/catalog.ts");
const { parseRunnerFrame } = await import("../server/src/runner/control.ts");
const { codexModes } = await import("../server/src/sandbox/codex-modes.ts");
const cmd = async (args, opts) => (await docker(args, { check: true, timeoutMs: 45_000, ...opts })).stdout.trim();
const who = { machineId, uid: "fixture" };
const runner = new Executor(
	who,
	{ slots: null },
	false,
	false,
	["docker-hardened"],
	{ mode: "restricted", allow: [] },
	false,
	true,
);
const args = ["--filter", "label=dev.windlass-platform.machine=" + machineId];
const boxes = [];
const boxName = id => "wlp-session-codex-" + id.slice(-12);
const probe =
	"fetch('http://127.0.0.1:17892/codex/v1/models',{headers:{authorization:'Bearer '+process.env.WLP_SESSION_BEARER}}).then(r=>console.log(r.status))";
const keyLease = raw =>
	runner.openTurnKey(raw, "codex", {
		provider: "openai",
		host: "relay.fixture.test",
		placeholder: "wlpm1.fixture",
		proofKey: randomBytes(32).toString("base64url"),
		expiresAt: Date.now() + 60_000,
	});
const keyTurn = (session, box, extra = {}) =>
	channelTurn(
		runner,
		session,
		box,
		undefined,
		undefined,
		{ observe, ...extra },
		{ providers: ["openai"], source: "key" },
	);
async function until(fn) {
	const deadline = Date.now() + 60_000;
	while (!(await fn())) {
		assert.ok(Date.now() < deadline, "timed out waiting for fixture");
		await wait(100);
	}
}
async function scan(name) {
	observe(await cmd(["inspect", name]));
	const code = `import os,glob,sys,json
needles=[v.encode() for v in json.load(sys.stdin).values()]
found=set()
files=glob.glob('/proc/[0-9]*/environ')+glob.glob('/proc/[0-9]*/cmdline')
for root in ['/home/agent','/tmp','/workspace',os.environ['CODEX_HOME']]:
 for base,dirs,names in os.walk(root):
  files += [os.path.join(base,n) for n in names]
for path in files:
 try:
  if not os.path.islink(path) and os.path.isfile(path):
   with open(path,'rb') as f:
    tail=b''
    while b:=f.read(131072):
     data=tail+b
     found.update(n for n in needles if n in data)
     tail=data[-4096:]
 except (FileNotFoundError,PermissionError): pass
print(len(found))`;
	return Number(await cmd(["exec", "-i", name, "python3", "-c", code], { stdin: JSON.stringify(markers) }));
}
async function check() {
	execFileSync(
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
			"/CN=fixture",
			"-addext",
			"subjectAltName=DNS:relay.fixture.test,DNS:auth.openai.com,DNS:api.openai.com,DNS:chatgpt.com",
			"-keyout",
			join(dir, "key.pem"),
			"-out",
			join(dir, "cert.pem"),
		],
		{ stdio: "ignore" },
	);
	await writeFile(join(dir, "expected"), JSON.stringify(markers), { mode: 0o600 });
	for (const file of ["auth.cjs", "gateway.cjs"]) await copyFile(join(root, "fixtures/codex", file), join(dir, file));
	real("network", "create", "--internal", net);
	real(
		"run",
		"-d",
		"--rm",
		"--name",
		upstream,
		"--network",
		net,
		"--network-alias",
		"auth.openai.com",
		"--network-alias",
		"relay.fixture.test",
		"--network-alias",
		"chatgpt.com",
		"--network-alias",
		"api.openai.com",
		"--user",
		"0",
		"-v",
		dir + ":/fixture:ro",
		pin,
		"node",
		"/fixture/auth.cjs",
	);
	execFileSync(process.execPath, [join(root, "runner/bundle.mjs"), pin, join(dir, "runner.cjs"), "codex=" + pin], {
		stdio: "pipe",
	});
	storePair(who, generateKeyPairSync("ed25519").privateKey, "https://fixture.invalid");
	// Codex has no login on a machine: the ChatGPT plan (its relay there) or a Settings key pays.
	const login = spawnSync(process.execPath, [join(dir, "runner.cjs"), "login", "codex"], { encoding: "utf8" });
	assert.notEqual(login.status, 0);
	assert.match(login.stdout + login.stderr, /Codex has no login on this machine/);
	await runner.refresh();
	assert.ok(runner.report().docker.ok, JSON.stringify(runner.report().docker));
	await runner.loginChanged(false);
	const report = runner.report(),
		entry = report.harnesses[0],
		catalog = entry.options;
	assert.equal(entry.signIn, "none");
	assert.equal(entry.loginGeneration, undefined);
	assert.ok(catalog?.models.length, "signed-out inventory missing");
	assert.deepEqual(entry.modes, ["agent-full-access"]);
	assert.ok(parseRunnerFrame(JSON.stringify({ kind: "catalog", id: "codex", options: catalog })));
	assert.ok(parseRunnerFrame(JSON.stringify(compactReport(report))));
	assert.ok(optionsDigest(catalog));
	boxes.push(await runner.create("first", "docker-hardened", false, "codex"));
	const first = boxName(boxes[0]);
	await assert.rejects(
		runner.turnCredentials("codex-" + boxes[0].slice(-12), "codex", {}),
		/ChatGPT plan or an OpenAI key/,
	);
	await keyTurn("first", boxes[0]);
	assert.match(await cmd(["logs", upstream]), /settings POST \/model-relay\/v1\/responses/);
	console.log("PASS Codex with a Settings key and no machine login.");
	boxes.push(await runner.create("second", "docker-hardened", false, "codex"));
	const lease = await keyLease("codex-" + boxes[0].slice(-12));
	try {
		assert.equal(
			await cmd(["exec", "-e", "WLP_SESSION_BEARER=" + lease.placeholder, first, "node", "-e", probe]),
			"200",
		);
		// Another sandbox's forwarder carries another nonce: the lease is not its.
		assert.equal(
			await cmd(["exec", "-e", "WLP_SESSION_BEARER=" + lease.placeholder, boxName(boxes[1]), "node", "-e", probe]),
			"401",
		);
	} finally {
		await lease.close();
	}
	for (const host of ["chatgpt.com", "api.openai.com"]) {
		const res = await docker([
			"exec",
			first,
			"curl",
			"-m5",
			"-sS",
			"-o",
			"/dev/null",
			"-w",
			"%{http_connect}",
			"https://" + host,
		]);
		assert.equal(res.stdout.trim(), "403");
		assert.notEqual(res.code, 0);
	}
	await cmd(["exec", first, "sh", "-ec", 'test ! -e "$CODEX_HOME/auth.json"']);
	assert.equal(await scan(first), 0);
	// Positive control proves the scan detects a projected credential. CODEX_HOME is root's (the image's Dockerfile).
	await cmd(["exec", "-i", "-u", "root", first, "sh", "-ec", 'cat > "$CODEX_HOME/auth.json"'], {
		stdin: JSON.stringify(markers),
	});
	assert.equal(await scan(first), Object.keys(markers).length);
	await cmd(["exec", "-u", "root", first, "sh", "-ec", 'rm "$CODEX_HOME/auth.json"']);
	if (process.argv.includes("--settings-keys")) return;
	Object.assign(process.env, { WLP_DEMO: "1", WLP_SANDBOX: "fake", WLP_SECRET: random() });
	const { timelineFixture } = await import("../fixtures/acp-agent/timeline.ts");
	const timeline = timelineFixture();
	try {
		await keyTurn("second", boxes[1], { onUpdate: timeline.recorder.update });
		timeline.recorder.flush();
		await until(() => timeline.items.length > 0 && timeline.stored().length === timeline.items.length);
		const stored = JSON.stringify(timeline.stored());
		assert.ok(stored.includes("Fixture turn complete."));
		observe(stored);
		observe(JSON.stringify(timeline.deltas));
	} finally {
		timeline.sql.close();
	}
	assert.equal(await scan(boxName(boxes[1])), 0);
	const sandboxRunner = new Executor(
		who,
		{ slots: null },
		false,
		false,
		["docker-hardened", "docker-windlass-sandbox"],
		{ mode: "restricted", allow: [] },
		false,
		true,
	);
	await sandboxRunner.loginChanged(true);
	const sandboxReport = sandboxRunner.report().harnesses[0];
	if (sandboxReport.modes.includes("workspace-write")) {
		assert.deepEqual(sandboxReport.modes, ["agent-full-access", "read-only", "workspace-write"]);
		assert.doesNotThrow(() => sandboxRunner.requireHarness("docker-windlass-sandbox", "codex"));
		assert.deepEqual(
			codexModes("docker-windlass-sandbox", sandboxReport.modes).map(m => m.id),
			["read-only", "workspace-write"],
		);
		const inner = await sandboxRunner.create("third", "docker-windlass-sandbox", false, "codex");
		boxes.push(inner);
		assert.equal(await cmd(["exec", boxName(inner), "printenv", "INITIAL_AGENT_MODE"]), "workspace-write");
		assert.equal(await cmd(["exec", boxName(boxes[1]), "printenv", "INITIAL_AGENT_MODE"]), "agent-full-access");
	} else {
		assert.deepEqual(sandboxReport.modes, ["agent-full-access"]);
		assert.throws(() => sandboxRunner.requireHarness("docker-windlass-sandbox", "codex"), /sandbox probe/);
	}
	console.log("Probed modes:", sandboxReport.modes.join(", "));
	for (const file of (await readdir(dir)).filter(f => /^audit-.*\.jsonl$/.test(f) || f === "status.json"))
		observe(await readFile(join(dir, file), "utf8"));
	console.log(
		"PASS Codex ACP over the runner channel on a Settings key, TLS routes, restricted egress and credential scans.",
	);
}
try {
	await check();
} finally {
	for (const id of real("ps", "-aq", ...args)
		.split(/\s+/)
		.filter(Boolean))
		real("rm", "-fv", id);
	for (const v of real("volume", "ls", "-q", ...args)
		.split(/\s+/)
		.filter(Boolean))
		real("volume", "rm", v);
	if (real("ps", "-aq", "--filter", "name=^/" + upstream + "$")) real("rm", "-fv", upstream);
	if (real("network", "ls", "-q", "--filter", "name=^" + net + "$")) real("network", "rm", net);
	await rm(dir, { recursive: true, force: true });
}
