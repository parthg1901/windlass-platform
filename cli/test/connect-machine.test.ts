/**
 * `connect --machine` as a user runs it: the CLI against a stand-in platform that publishes a runner image, with a
 * stand-in `docker` on PATH that answers as Docker does and plays the setup container's lines.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DOCKER_HELP, machineApproveUrl, setupRunArgs } from "../../server/src/contract/machine-setup.ts";
import { cli } from "./stand-ins.ts";

const IMAGE = "ghcr.io/windlassai/windlass-runner@sha256:" + "ab".repeat(32);

const bin = mkdtempSync(join(tmpdir(), "windlassai-machine-"));
const empty = mkdtempSync(join(tmpdir(), "windlassai-no-docker-"));
after(() => {
	rmSync(bin, { recursive: true, force: true });
	rmSync(empty, { recursive: true, force: true });
});
const calls = join(bin, "calls");
const event = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "'\\''")}'`;
const PAIRING = event({ event: "pairing", code: "WXYZ-1210", key: "K7Q2M-XR4TD" });
writeFileSync(
	join(bin, "docker"),
	`#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >> '${calls}'; done
printf -- '--\\n' >> '${calls}'
case "$FAKE_DOCKER:$1" in
  stopped:info) echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1 ;;
  denied:info) echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1 ;;
  *:info) echo 29.1.3 ;;
  offline:pull) echo "network unreachable" >&2; exit 1 ;;
  *:pull) echo "Pulled $2" ;;
  refused:run)
    printf '%s\\n' ${event({ event: "step", text: "Checking the runner's images" })} ${PAIRING}
    printf '%s\\n' ${event({ event: "log", level: "error", text: "The pairing code expired or was denied, so re-run the setup command to get a new code." })}
    exit 1 ;;
  *:run)
    printf '%s\\n' ${PAIRING} ${event({ event: "log", level: "success", text: "Paired with octocat. If that is not you, run setup again and pair again." })}
    printf '%s\\n' 'a plain line' ${event({ event: "done", text: "This machine is online." })} ;;
esac
`,
);
chmodSync(join(bin, "docker"), 0o755);

/** The platform's information route, publishing a runner image (or `machines` as given). */
async function platform(machines?: unknown) {
	const server = createServer((req, res) => {
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		if (req.method !== "GET" || req.url !== "/platform/info") return res.writeHead(404).end("{}");
		const body = { machines: machines === undefined ? { runnerImage: IMAGE, platformUrl: url } : machines };
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	after(() => server.close());
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Each docker command the CLI ran, as its arguments. */
function dockerCalls(): string[][] {
	if (!existsSync(calls)) return [];
	const runs = readFileSync(calls, "utf8").split("--\n").filter(Boolean);
	return runs.map(run => run.split("\n").filter(Boolean));
}

function connect(site: string, env: Record<string, string> = {}) {
	rmSync(calls, { force: true });
	return cli(bin, ["connect", "--machine", "--no-browser"], { WINDLASS_PLATFORM: site, ...env });
}

test("checks Docker, pulls the platform's runner and runs its setup as install.sh does, showing the page to approve", async () => {
	const site = await platform();
	const run = await connect(site);
	assert.equal(run.code, 0, run.stderr);
	const [info, pull, setup, ...more] = dockerCalls();
	assert.deepEqual(info, ["info", "--format", "{{.ServerVersion}}"]);
	assert.deepEqual(pull, ["pull", IMAGE]);
	const shared = setupRunArgs(IMAGE, site, "connect");
	assert.deepEqual(setup!.slice(0, shared.length), shared);
	const rest = setup!.slice(shared.length);
	assert.ok(rest.length === 0 || (rest.length === 2 && rest[0] === "--name"), rest.join(" "));
	assert.deepEqual(more, []);
	// The same container as install.sh's, with no terminal and no questions.
	const terminal = setupRunArgs(IMAGE, site, "terminal");
	assert.deepEqual(
		shared.filter(arg => arg !== "--connect"),
		terminal.filter(arg => arg !== "-it"),
	);
	assert.match(run.stdout, /code WXYZ-1210 and the machine key K7Q2M-XR4TD/);
	assert.ok(run.stdout.includes(machineApproveUrl(site, "WXYZ-1210")));
	assert.match(run.stdout, /kind=machine/);
	assert.match(run.stdout, /Paired with octocat/);
	assert.match(run.stdout, /a plain line\nThis machine is online\.\n/);
	assert.ok(!run.stdout.includes('{"event"'));
});

test("says what is wrong with Docker, and runs nothing more", async () => {
	const site = await platform();
	const missing = await cli(empty, ["connect", "--machine", "--no-browser"], { WINDLASS_PLATFORM: site, PATH: empty });
	assert.equal(missing.code, 1);
	assert.ok(
		Object.values(DOCKER_HELP.missing).some(message => missing.stderr.includes(message)),
		missing.stderr,
	);
	const stopped = await connect(site, { FAKE_DOCKER: "stopped" });
	assert.equal(stopped.code, 1);
	assert.ok(
		Object.values(DOCKER_HELP.stopped).some(message => stopped.stderr.includes(message)),
		stopped.stderr,
	);
	assert.equal(dockerCalls().length, 1);
	const denied = await connect(site, { FAKE_DOCKER: "denied" });
	assert.equal(denied.code, 1);
	assert.ok(denied.stderr.includes(DOCKER_HELP.denied), denied.stderr);
	assert.equal(dockerCalls().length, 1);
	const offline = await connect(site, { FAKE_DOCKER: "offline" });
	assert.equal(offline.code, 1);
	assert.ok(offline.stderr.includes(DOCKER_HELP.pull(IMAGE)), offline.stderr);
	assert.equal(dockerCalls().length, 2);
});

test("a denied pairing runs nothing more and says nothing was connected", async () => {
	const site = await platform();
	const run = await connect(site, { FAKE_DOCKER: "refused" });
	assert.equal(run.code, 1);
	assert.match(run.stdout, /Error: The pairing code expired or was denied/);
	assert.match(run.stderr, /The machine was not connected/);
	assert.deepEqual(
		dockerCalls().map(args => args[0]),
		["info", "pull", "run"],
	);
});

test("a platform without machines, or without a runner yet, runs no docker", async () => {
	const none = await connect(await platform(null));
	assert.equal(none.code, 1);
	assert.match(none.stderr, /does not take machines/);
	const unpublished = await connect(await platform({ runnerImage: null, platformUrl: "https://x.example" }));
	assert.equal(unpublished.code, 1);
	assert.match(unpublished.stderr, /has not published a runner yet/);
	assert.deepEqual(dockerCalls(), []);
});
