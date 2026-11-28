/**
 * `connect claude --this-machine` and the end of `connect --machine`, as a user runs them: a stand-in `claude` that
 * prints a setup token and a stand-in `docker` that answers for the local runner's container and keeps what
 * `docker exec` was given on standard input. Nothing here reaches real Docker or the network: both are stand-ins on PATH,
 * and the platform is a local stand-in that records every request.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { MACHINE_CONNECT_COMMAND, RUNNER_CONTAINER } from "../../server/src/contract/machine-setup.ts";
import { cli } from "./stand-ins.ts";

const TOKEN = "sk-ant-oat01-" + "Hm4_q-9".repeat(13) + "XXBB";
const IMAGE = "ghcr.io/windlassai/windlass-runner@sha256:" + "cd".repeat(32);

const bin = mkdtempSync(join(tmpdir(), "windlassai-here-"));
after(() => rmSync(bin, { recursive: true, force: true }));
const calls = join(bin, "calls");
const stdinFile = join(bin, "exec-stdin");
const claudeRan = join(bin, "claude-ran");

writeFileSync(
	join(bin, "claude"),
	`#!/bin/sh
[ "$1" = "setup-token" ] || exit 64
touch '${claudeRan}'
printf '\\033[32m✓ Long-lived authentication token created\\033[39m\\r\\n'
printf '%s\\r\\n' '${TOKEN}'
printf '\\r\\nStore this token securely.\\r\\n'
`,
);
// FAKE_RUNNER: running (default), stopped, missing; FAKE_LOGIN: refused makes the runner's login fail.
writeFileSync(
	join(bin, "docker"),
	`#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >> '${calls}'; done
printf -- '--\\n' >> '${calls}'
case "$1" in
  info) echo 29.1.3 ;;
  pull) echo "Pulled $2" ;;
  run) printf '%s\\n' '{"event":"done","text":"This machine is online."}' ;;
  container)
    case "\${FAKE_RUNNER:-running}" in
      running) echo true ;;
      stopped) echo false ;;
      *) echo "Error: No such container: ${RUNNER_CONTAINER}" >&2; exit 1 ;;
    esac ;;
  exec)
    cat > '${stdinFile}'
    if [ "$FAKE_LOGIN" = refused ]; then echo "Pair this machine before signing in to Claude Code." >&2; exit 1; fi
    echo "Claude Code: signed in." ;;
  *) echo "unexpected docker $1" >&2; exit 99 ;;
esac
`,
);
chmodSync(join(bin, "claude"), 0o755);
chmodSync(join(bin, "docker"), 0o755);

/** A platform that records every request: the local login must make none. */
async function platform() {
	const seen: string[] = [];
	const server = createServer((req, res) => {
		seen.push(`${req.method} ${req.url}`);
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		if (req.method === "GET" && req.url === "/platform/info")
			return res
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ machines: { runnerImage: IMAGE, platformUrl: url } }));
		res.writeHead(404).end("{}");
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	after(() => server.close());
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function dockerCalls(): string[][] {
	if (!existsSync(calls)) return [];
	return readFileSync(calls, "utf8")
		.split("--\n")
		.filter(Boolean)
		.map(run => run.split("\n").filter(Boolean));
}

function reset() {
	for (const file of [calls, stdinFile, claudeRan]) rmSync(file, { force: true });
}

const EXEC = ["exec", "-i", RUNNER_CONTAINER, "windlass-runner", "login", "claude", "--token-stdin"];

function noSecret(run: { stdout: string; stderr: string }) {
	for (const text of [run.stdout, run.stderr]) {
		assert.ok(!text.includes(TOKEN), "the token on screen");
		assert.ok(!text.includes("XXBB"), "a piece of the token on screen");
	}
	for (const args of dockerCalls()) assert.ok(!args.some(arg => arg.includes("sk-ant")), "the token on docker's argv");
}

test("--this-machine runs claude setup-token and hands the token to the local runner's login on stdin only", async () => {
	reset();
	const site = await platform();
	const run = await cli(bin, ["connect", "claude", "--this-machine"], { WINDLASS_PLATFORM: site.url });
	assert.equal(run.code, 0, run.stderr);
	assert.ok(existsSync(claudeRan), "claude setup-token ran");
	const [info, inspect, exec, ...more] = dockerCalls();
	assert.deepEqual(info, ["info", "--format", "{{.ServerVersion}}"]);
	assert.deepEqual(inspect, ["container", "inspect", "--format", "{{.State.Running}}", RUNNER_CONTAINER]);
	assert.deepEqual(exec, EXEC);
	assert.deepEqual(more, []);
	assert.equal(readFileSync(stdinFile, "utf8"), TOKEN + "\n");
	assert.deepEqual(site.seen, [], "nothing went to the platform");
	assert.match(run.stdout, /It stays on this machine/);
	noSecret(run);
});

test("--this-machine --token-stdin skips claude setup-token", async () => {
	reset();
	const site = await platform();
	const run = await cli(
		bin,
		["connect", "claude", "--this-machine", "--token-stdin"],
		{ WINDLASS_PLATFORM: site.url },
		`${TOKEN}\n`,
	);
	assert.equal(run.code, 0, run.stderr);
	assert.ok(!existsSync(claudeRan));
	assert.equal(readFileSync(stdinFile, "utf8"), TOKEN + "\n");
	assert.deepEqual(site.seen, []);
	noSecret(run);
});

test("with no runner here it says to pair the machine first, and runs no claude setup-token", async () => {
	for (const [runner, words] of [
		["missing", `Pair this machine first: ${MACHINE_CONNECT_COMMAND}`],
		["stopped", `docker start ${RUNNER_CONTAINER}`],
	] as const) {
		reset();
		const run = await cli(bin, ["connect", "claude", "--this-machine"], { FAKE_RUNNER: runner });
		assert.equal(run.code, 1);
		assert.ok(run.stderr.includes(words), run.stderr);
		assert.ok(!existsSync(claudeRan));
		assert.ok(!dockerCalls().some(args => args[0] === "exec"));
	}
	const empty = mkdtempSync(join(tmpdir(), "windlassai-here-nodocker-"));
	after(() => rmSync(empty, { recursive: true, force: true }));
	const missing = await cli(empty, ["connect", "claude", "--this-machine"], { PATH: empty });
	assert.equal(missing.code, 1);
	assert.ok(missing.stderr.includes(`Pair this machine first: ${MACHINE_CONNECT_COMMAND}`), missing.stderr);
});

test("the runner's refusal is shown, without the token", async () => {
	reset();
	const run = await cli(bin, ["connect", "claude", "--this-machine"], { FAKE_LOGIN: "refused" });
	assert.equal(run.code, 1);
	assert.match(run.stderr, /The runner did not keep the login: Pair this machine before signing in to Claude Code\./);
	noSecret(run);
});

test("--this-machine is only for connect claude, and --local-claude only for connect --machine", async () => {
	reset();
	for (const args of [
		["connect", "codex", "--this-machine"],
		["connect", "--machine", "--this-machine"],
		["connect", "claude", "--local-claude"],
	]) {
		const run = await cli(bin, args, {});
		assert.equal(run.code, 2, args.join(" "));
	}
	assert.deepEqual(dockerCalls(), []);
});

test("connect --machine --local-claude pairs, then keeps the login on this machine", async () => {
	reset();
	const site = await platform();
	const run = await cli(bin, ["connect", "--machine", "--no-browser", "--local-claude"], {
		WINDLASS_PLATFORM: site.url,
	});
	assert.equal(run.code, 0, run.stderr);
	assert.deepEqual(
		dockerCalls().map(args => args[0]),
		["info", "pull", "run", "info", "container", "exec"],
	);
	assert.equal(readFileSync(stdinFile, "utf8"), TOKEN + "\n");
	assert.deepEqual(site.seen, ["GET /platform/info"]);
	noSecret(run);
});

test("connect --machine with no terminal asks nothing and leaves Claude Code on the plan", async () => {
	reset();
	const site = await platform();
	const run = await cli(bin, ["connect", "--machine", "--no-browser"], { WINDLASS_PLATFORM: site.url });
	assert.equal(run.code, 0, run.stderr);
	assert.ok(!run.stdout.includes("Choose 1 or 2"));
	assert.deepEqual(
		dockerCalls().map(args => args[0]),
		["info", "pull", "run"],
	);
});

/** The CLI on a terminal: under `script`, with `input` typed into it. */
function onTerminal(args: string[], env: Record<string, string>, input: string) {
	const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
	const command = [process.execPath, main, ...args].map(word => `'${word}'`).join(" ");
	const child = spawn("script", ["-q", "-e", "-c", command, "/dev/null"], {
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DISPLAY: "", WAYLAND_DISPLAY: "", ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	child.stdout.on("data", chunk => {
		stdout += chunk;
		if (stdout.includes("Choose 1 or 2") && input) {
			child.stdin.write(input);
			input = "";
		}
	});
	return new Promise<{ code: number | null; stdout: string }>(resolve =>
		child.on("close", code => resolve({ code, stdout })),
	);
}

test("connect --machine at a terminal asks, and Enter keeps the plan from Windlass", async () => {
	reset();
	const site = await platform();
	const run = await onTerminal(["connect", "--machine", "--no-browser"], { WINDLASS_PLATFORM: site.url }, "\r");
	assert.equal(run.code, 0, run.stdout);
	assert.match(run.stdout, /Use your Claude plan from Windlass \(recommended\)/);
	assert.match(run.stdout, /Keep a login on this machine only/);
	assert.deepEqual(
		dockerCalls().map(args => args[0]),
		["info", "pull", "run"],
	);
});

test("connect --machine at a terminal, answering 2, keeps the login on this machine", async () => {
	reset();
	const site = await platform();
	const run = await onTerminal(["connect", "--machine", "--no-browser"], { WINDLASS_PLATFORM: site.url }, "2\r");
	assert.equal(run.code, 0, run.stdout);
	assert.deepEqual(
		dockerCalls().map(args => args[0]),
		["info", "pull", "run", "info", "container", "exec"],
	);
	assert.equal(readFileSync(stdinFile, "utf8"), TOKEN + "\n");
	assert.ok(!run.stdout.includes(TOKEN) && !run.stdout.includes("XXBB"));
});
