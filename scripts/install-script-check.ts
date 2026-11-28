/**
 * The platform's one-line install (server/src/install-script.ts), on its own: no server, no Docker.
 *
 *   cd server && npx tsx ../scripts/install-script-check.ts
 *
 * What it holds to: GET /install.sh is plain text that no cache keeps, with this platform's address and
 * pinned runner image in it; the script is valid POSIX sh; it says clearly when Docker is missing, stopped
 * or not this user's; it pulls the image and runs setup on the terminal, or prints that command when there
 * is no terminal; and it writes nothing on the host.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const image = "ghcr.io/windlassai/windlass-runner@sha256:" + "ab".repeat(32);
const platform = "https://windlass.example.org";
process.env.WLP_MACHINES = "1";
process.env.WLP_RUNNER_IMAGE = image;
process.env.WLP_PUBLIC_URL = platform;
const { config } = await import("../server/src/config.js");
const { INSTALL_SCRIPT_PATH, installScript, installScriptResponse } = await import("../server/src/install-script.js");
const { DOCKER_HELP, setupRunArgs } = await import("../server/src/contract/machine-setup.js");
const get = (method = "GET") => installScriptResponse(new Request(platform + INSTALL_SCRIPT_PATH, { method }));

test("GET /install.sh is the script for this platform, as plain text that is not cached", async () => {
	assert.equal(INSTALL_SCRIPT_PATH, "/install.sh");
	const response = get();
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	assert.equal(response.headers.get("etag"), null);
	const body = await response.text();
	assert.ok(body.startsWith("#!/bin/sh\n"));
	assert.ok(body.includes(`PLATFORM='${platform}'\n`));
	assert.ok(body.includes(`IMAGE='${image}'\n`));
	assert.ok(body.includes('"$IMAGE" setup --platform "$PLATFORM"'));
	assert.ok(body.includes("-v /var/run/docker.sock:/var/run/docker.sock"));
	assert.ok(body.includes("-v windlass-runner:/var/lib/windlass-runner"));
	// The same container and messages as `npx @windlassai/cli connect --machine`, from the one definition both use.
	assert.ok(body.includes(`set -- docker ${setupRunArgs('"$IMAGE"', '"$PLATFORM"', "terminal").join(" ")}\n`));
	for (const message of [DOCKER_HELP.missing.linux, DOCKER_HELP.stopped.darwin, DOCKER_HELP.denied])
		assert.ok(body.includes(`fail '${message.replaceAll("'", "'\\''")}'`), message);
	// What it runs (its messages aside): nothing with sudo, nothing written in a file.
	const commands = body
		.split("\n")
		.filter(line => !/^\s*#/.test(line))
		.join("\n")
		.replace(/(fail|say) "[^"]*"/g, "")
		.replace(/fail '(?:[^']|'\\'')*'/g, "");
	assert.doesNotMatch(
		commands,
		/\bsudo\b|mkdir|\btee\b|>>|>\s*(?!\/dev\/null\b|&)[^\s]|\$HOME|chmod|\bcurl\b|\bwget\b/,
	);
	const head = get("HEAD");
	assert.equal(head.status, 200);
	assert.equal(await head.text(), "");
	assert.equal(head.headers.get("cache-control"), "no-store");
	assert.equal(get("POST").status, 405);
	const unpublished = config.machines!.runnerImage;
	(config.machines as { runnerImage: string | null }).runnerImage = null;
	try {
		assert.match(await get().text(), /has not published a runner yet[\s\S]*exit 1/);
	} finally {
		(config.machines as { runnerImage: string | null }).runnerImage = unpublished;
	}
	const machines = config.machines;
	(config as { machines: unknown }).machines = null;
	try {
		assert.equal(get().status, 404);
	} finally {
		(config as { machines: unknown }).machines = machines;
	}
});

test("the script is POSIX sh that finds Docker's problems, then runs setup or prints it", () => {
	const dir = mkdtempSync(join(tmpdir(), "install-check-"));
	try {
		const script = join(dir, "install.sh");
		writeFileSync(script, installScript(platform, image));
		for (const shell of ["sh", "dash"])
			if (spawnSync("sh", ["-c", `command -v ${shell}`]).status === 0) execFileSync(shell, ["-n", script]);
		// A PATH with the tools the script uses, and a fake docker that does what DOCKER says.
		const bin = join(dir, "bin");
		execFileSync("mkdir", [bin]);
		for (const tool of ["uname", "grep", "cat", "sleep"])
			symlinkSync(execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), join(bin, tool));
		const calls = join(dir, "calls");
		const setsid = execFileSync("sh", ["-c", "command -v setsid"], { encoding: "utf8" }).trim();
		const fake = `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$DOCKER:$1" in
  stopped:info) echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1 ;;
  denied:info) echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1 ;;
  *:info) echo 29.1.3 ;;
  *:pull) echo "Pulled $2" ;;
  *:run) echo "setup ran with a terminal: $( [ -t 0 ] && echo yes || echo no )" ;;
esac
`;
		const home = join(dir, "home"),
			work = join(dir, "work");
		execFileSync("mkdir", [home, work]);
		const run = (docker: string | null, terminal = false) => {
			rmSync(join(bin, "docker"), { force: true });
			rmSync(calls, { force: true });
			if (docker !== null) writeFileSync(join(bin, "docker"), fake, { mode: 0o755 });
			const env = { PATH: bin, HOME: home, DOCKER: docker ?? "" };
			// setsid: no controlling terminal, as under a CI job or a pipe from another program.
			const result = terminal
				? spawnSync("script", ["-qec", `/bin/sh ${script}`, "/dev/null"], {
						cwd: work,
						env: { ...env, PATH: bin + ":/usr/bin:/bin" },
						encoding: "utf8",
					})
				: spawnSync(setsid, ["-w", "/bin/sh", script], { cwd: work, env, encoding: "utf8" });
			return {
				code: result.status,
				out: (result.stdout ?? "") + (result.stderr ?? ""),
				calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
			};
		};
		const missing = run(null);
		assert.equal(missing.code, 1);
		assert.match(missing.out, /windlass: Docker is (not installed|not available in this WSL)/);
		const stopped = run("stopped");
		assert.equal(stopped.code, 1);
		assert.match(stopped.out, /windlass: Docker is not running\. Start (it|Docker Desktop)/);
		assert.deepEqual(stopped.calls, ["info --format {{.ServerVersion}}"]);
		const denied = run("denied");
		assert.equal(denied.code, 1);
		assert.match(denied.out, /may not use it\. Add the user to the docker group/);
		const piped = run("ok");
		assert.equal(piped.code, 0, piped.out);
		assert.deepEqual(piped.calls, ["info --format {{.ServerVersion}}", "pull " + image]);
		assert.match(
			piped.out,
			/There is no terminal here[\s\S]*\n {2}docker run -it --rm --log-driver none -v \/var\/run\/docker\.sock:\/var\/run\/docker\.sock -v windlass-runner:\/var\/lib\/windlass-runner ghcr\.io\/windlassai\/windlass-runner@sha256:(ab){32} setup --platform https:\/\/windlass\.example\.org\n/,
		);
		if (spawnSync("sh", ["-c", "command -v script"]).status === 0) {
			const terminal = run("ok", true);
			assert.equal(terminal.code, 0, terminal.out);
			assert.equal(
				terminal.calls.at(-1),
				`run -it --rm --log-driver none -v /var/run/docker.sock:/var/run/docker.sock -v windlass-runner:/var/lib/windlass-runner ${image} setup --platform ${platform}`,
			);
			assert.match(terminal.out, /setup ran with a terminal: yes/);
		}
		assert.deepEqual(readdirSync(home), []);
		assert.deepEqual(readdirSync(work), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
