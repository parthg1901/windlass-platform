/**
 * The runner's check of the Claude Code sign-in (runner/src/harness-login.ts `loginFileState`, docker-executor.ts
 * `refreshLogin`), against a stand-in `docker` on PATH. A check that cannot run says why, in the log and in the
 * report, and is tried again; one that then works flips the state to "token". Where Docker's archive stat of the
 * login file cannot be had (as under Docker Desktop), the started helper's `test -s` decides. A token piped to
 * `login claude --token-stdin` is kept as a pasted one is, and the platform's `forget-claude-login` removes it. Run with:
 *
 *   cd server && npx tsx ../scripts/runner-signin-check.ts
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "wlp-signin-check-"));
const state = join(dir, "state");
const plan = join(dir, "plan");
const calls = join(dir, "calls");
const runs = join(dir, "runs");
const uid = "u_signin",
	machineId = "m_" + "c".repeat(16);
// The runner bundle's constants (runner/bundle.mjs), here as globals.
Object.assign(globalThis, {
	SANDBOX_IMAGE: "sandbox@sha256:" + "1".repeat(64),
	SHOTS_IMAGE_PIN: "",
	HARNESS_IMAGES: { claude: "claude@sha256:" + "2".repeat(64) },
	CLAUDE_RELAY_SCRIPT: "",
	OPENCODE_RELAY_SCRIPT: "",
	EGRESS_SOURCE: "",
});
process.env.WLP_RUNNER_STATE_DIR = state;
process.env.PATH = `${dir}:${process.env.PATH}`;
// What the stand-in does with each call, from the plan file: "create" fails or makes a container, "dial" answers the
// archive stat or fails as Docker Desktop's proxy may, "start" exits with the helper's `test -s`.
writeFileSync(
	join(dir, "docker"),
	`#!/usr/bin/env node
const fs = require("node:fs"), a = process.argv.slice(2), plan = JSON.parse(fs.readFileSync(${JSON.stringify(plan)}, "utf8"));
fs.appendFileSync(${JSON.stringify(calls)}, a.slice(0, 2).join(" ") + "\\n");
if (a[0] === "run") fs.appendFileSync(${JSON.stringify(runs)}, JSON.stringify({ args: a, stdin: fs.readFileSync(0, "utf8") }) + "\\n");
const labels = { "dev.windlass-platform": "1", "dev.windlass-platform.machine": ${JSON.stringify(machineId)}, "dev.windlass-platform.uid": ${JSON.stringify(uid)} };
if (a[0] === "volume" && a[1] === "ls") console.log("wlp-harness-claude-${machineId}");
else if (a[0] === "volume" && a[1] === "inspect") console.log(JSON.stringify([{ Driver: "local", Labels: labels }]));
else if (a[0] === "container" && a[1] === "inspect") { console.error("Error: No such container: " + a[2]); process.exit(1); }
else if (a[0] === "version" || (a[0] === "image" && a[1] === "inspect")) console.log("linux/amd64");
else if (a[0] === "create") { if (plan.create === "fail") { console.error("Error response from daemon: the helper could not be created"); process.exit(1); } console.log("c0ffee"); }
else if (a[0] === "system" && a[1] === "dial-stdio") { if (plan.dial === "fail") { console.error("error during connect: dial-stdio is not supported here"); process.exit(1); } process.stdout.write("HTTP/1.1 404 Not Found\\r\\n\\r\\n"); }
else if (a[0] === "start") process.exit(plan.start);
else if (a[0] === "rm") process.exit(0);
else process.exit(0);
`,
);
chmodSync(join(dir, "docker"), 0o755);
mkdirSync(state);
const { privateKey } = generateKeyPairSync("ed25519");
writeFileSync(
	join(state, "pair.json"),
	JSON.stringify({
		current: { uid, machineId },
		previous: [],
		platform: "https://windlass.example",
		key: privateKey.export({ type: "pkcs8", format: "pem" }),
	}),
	{ mode: 0o600 },
);
const TOKEN = "sk-ant-oat01-" + "Lq7_x-2".repeat(12) + "ZZAA";
/** The helper containers the login ran (`docker run`), with what each got on standard input. */
function helperRuns(): { args: string[]; stdin: string }[] {
	if (!existsSync(runs)) return [];
	const found = readFileSync(runs, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line));
	rmSync(runs);
	return found.filter((run: { args: string[] }) => run.args.includes("/run/wlp-harness/claude"));
}
/** A helper's arguments without its random container name, to compare two of them. */
const shape = (args: string[]) => args.map((arg, i) => (args[i - 1] === "--name" ? "<name>" : arg));

const lines: string[] = [];
const log = console.log;
console.log = (...args: unknown[]) => {
	lines.push(args.join(" "));
};
let failed = 0;
const ok = (name: string, body: () => void) => {
	try {
		body();
		log(`PASS  ${name}`);
	} catch (error) {
		failed++;
		log(`FAIL  ${name}: ${(error as Error).message}`);
	}
};
try {
	const { Executor } = await import("../runner/src/docker-executor.js");
	const executor = new Executor({ uid, machineId } as never, { slots: null } as never, false, true);
	const internals = executor as unknown as { refreshLogin(): Promise<void>; signInRetry?: unknown };
	const claude = () => executor.report().harnesses?.find(h => h.id === "claude");

	writeFileSync(plan, JSON.stringify({ create: "fail" }));
	await internals.refreshLogin();
	ok(
		"a helper that cannot be made leaves the sign-in unknown, with Docker's reason in the report and the log, and a check again armed",
		() => {
			assert.equal(claude()?.signIn, "unknown");
			assert.match(claude()?.signInReason ?? "", /the helper could not be created/);
			assert.ok(
				lines.some(line => /^Could not check the Claude Code sign-in: .*the helper could not be created/.test(line)),
				lines.join(" | "),
			);
			assert.ok(internals.signInRetry !== undefined, "no check again was set");
		},
	);

	writeFileSync(plan, JSON.stringify({ create: "ok", dial: "fail", start: 0 }));
	await internals.refreshLogin();
	ok(
		"the next check works where the archive stat does not: the started helper finds the token, and the state flips to token",
		() => {
			assert.equal(claude()?.signIn, "token");
			assert.equal(claude()?.signInReason, undefined);
			assert.ok(internals.signInRetry === undefined, "a check again stayed armed");
			assert.ok(
				lines.some(line => line === "Claude Code sign-in checked: signed in."),
				lines.join(" | "),
			);
			assert.ok(readFileSync(calls, "utf8").includes("start -a"), "the helper was not started");
		},
	);

	writeFileSync(plan, JSON.stringify({ create: "ok", dial: "fail", start: 1 }));
	await internals.refreshLogin();
	ok("a helper that finds no token says not signed in", () => assert.equal(claude()?.signIn, "none"));

	writeFileSync(plan, JSON.stringify({ create: "ok", dial: "fail", start: 125 }));
	await internals.refreshLogin();
	ok("a helper that cannot run says so, and nothing in the reason is a credential", () => {
		assert.equal(claude()?.signIn, "unknown");
		assert.match(
			claude()?.signInReason ?? "",
			/dial-stdio exited 1: error during connect.*the helper container exited 125/,
		);
		assert.doesNotMatch(JSON.stringify(executor.report()), /sk-ant-/);
	});
	clearTimeout(internals.signInRetry as ReturnType<typeof setTimeout>);

	const { Readable } = await import("node:stream");
	const { claudeLoginFromStdin, storeClaudeLogin } = await import("../runner/src/harness-login.js");
	writeFileSync(plan, JSON.stringify({ create: "ok", dial: "fail", start: 0 }));
	helperRuns();
	await storeClaudeLogin(executor, TOKEN);
	const [pasted] = helperRuns();
	const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
	Object.defineProperty(process, "stdin", { value: Readable.from([Buffer.from(TOKEN + "\n")]), configurable: true });
	try {
		await claudeLoginFromStdin(executor, new AbortController().signal);
	} finally {
		Object.defineProperty(process, "stdin", stdin);
	}
	const [piped, ...more] = helperRuns();
	ok("login claude --token-stdin keeps the piped token as a pasted login keeps it: on the helper's stdin only", () => {
		assert.ok(pasted && piped, "no helper wrote the login volume");
		assert.deepEqual(more, []);
		assert.equal(piped.stdin, TOKEN);
		assert.deepEqual(shape(piped.args), shape(pasted.args));
		assert.ok(piped.args.some(arg => arg.includes('mv -fT -- "$t" token')));
		assert.ok(!piped.args.some(arg => arg.includes("sk-ant")), "the token on docker's argv");
	});

	Object.defineProperty(process, "stdin", { value: Readable.from([Buffer.from("not a token\n")]), configurable: true });
	let refused: unknown;
	try {
		await claudeLoginFromStdin(executor, new AbortController().signal);
	} catch (error) {
		refused = error;
	} finally {
		Object.defineProperty(process, "stdin", stdin);
	}
	ok("login claude --token-stdin refuses what is not one setup token, and writes nothing", () => {
		assert.match(String((refused as Error)?.message), /Expected one Claude setup token/);
		assert.deepEqual(helperRuns(), []);
	});

	writeFileSync(plan, JSON.stringify({ create: "ok", dial: "fail", start: 1 }));
	let published = 0;
	executor.publishReport = () => published++;
	await executor.forgetClaudeLogin();
	clearTimeout(internals.signInRetry as ReturnType<typeof setTimeout>);
	const [removal] = helperRuns();
	ok("forget-claude-login removes the token as logout does, then reports Claude Code with no login", () => {
		assert.ok(removal, "no helper removed the login");
		assert.equal(removal.stdin, "");
		assert.ok(removal.args.some(arg => arg.includes('rm -f -- "$1/token"')));
		assert.equal(claude()?.signIn, "none");
		assert.ok(published > 0, "no report was published");
	});
} finally {
	console.log = log;
	rmSync(dir, { recursive: true, force: true });
}
console.log(failed === 0 ? "\nall passed" : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
