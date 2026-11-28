import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const mode of ["manual", "import", "decline"])
	test(
		mode === "decline"
			? "declining every mounted credential falls through to regular login"
			: mode === "import"
				? "setup imports two API keys, declines a foreign refresh token and drops the mount"
				: "setup pairs, signs in only OpenCode, accepts a hidden OpenCode key and prints the runnable Docker command",
		async () => {
			const importing = mode !== "manual",
				accept = mode === "import";
			const root = fileURLToPath(new URL("../", import.meta.url));
			const dir = await mkdtemp(join(root, ".setup-check-"));
			const pin = "sha256:" + "1".repeat(64),
				id = "m_" + "a".repeat(16);
			const registry = "ghcr.io/windlassai/";
			const runner = registry + "windlass-runner@" + pin;
			const ref = role => registry + "windlass-platform-" + role + "@" + pin;
			const pins = [
				ref("sandbox"),
				ref("sandbox-shots"),
				"claude=" + ref("claude"),
				"opencode=" + ref("opencode"),
				"codex=" + ref("codex"),
			];
			const asked = [];
			const platformRoot = generateKeyPairSync("ed25519")
				.publicKey.export({ format: "der", type: "spki" })
				.toString("base64");
			let refuseSetup = false;
			const server = createServer(async (req, res) => {
				let body = "";
				for await (const c of req) body += c;
				asked.push(req.url);
				if (refuseSetup) {
					res.writeHead(403);
					res.end("{}");
					return;
				}
				res.setHeader("content-type", "application/json");
				res.end(
					JSON.stringify(
						req.url === "/runner/pair"
							? { code: "ABCD-EFGH", pairing: "a".repeat(43), pollSecret: "b".repeat(43) }
							: {
									state: "approved",
									uid: "fixture",
									machineId: id,
									githubLogin: "fixture-owner",
									platformRoot,
									endpoint: "http://127.0.0.1:" + server.address().port,
								},
					),
				);
			});
			try {
				await new Promise(done => server.listen(0, "127.0.0.1", done));
				const origin = "http://127.0.0.1:" + server.address().port;
				execFileSync(process.execPath, [
					join(root, "runner/bundle.mjs"),
					pins[0],
					join(dir, "runner.cjs"),
					...pins.slice(1),
				]);
				await writeFile(join(dir, "package.json"), JSON.stringify({ type: "commonjs" }));
				const preload = join(dir, "host.cjs");
				const state = join(dir, "state"),
					volume = join(dir, "relay-volume"),
					source = join(dir, "auth.json");
				await Promise.all([mkdir(state), mkdir(volume)]);
				const fixture = JSON.stringify({
					"opencode-go": { type: "api", key: "fixture-existing-go" },
					opencode: { type: "api", key: "fixture-existing-zen" },
					openai: { type: "oauth", refresh: "fixture-foreign-refresh", access: "fixture-foreign-access" },
				});
				if (importing) await writeFile(source, fixture);
				await writeFile(
					preload,
					`require('node:os').hostname=()=>'0123456789ab';
const fs=require('node:fs/promises'),open=fs.open;
fs.open=(p,...args)=>open(p==='/import/opencode/auth.json'?${JSON.stringify(source)}:p,...args);
require('node:module').syncBuiltinESMExports()`,
				);
				await writeFile(
					join(dir, "docker"),
					`#!/usr/bin/env node
const a=process.argv.slice(2),d=process.env.WLP_RUNNER_STATE_DIR,fs=require('node:fs'),pin=${JSON.stringify(pin)};
if (a[0]==='container' && a.at(-1)==='0123456789ab') {
 const mounts=[{Type:'bind',Source:'/var/run/docker.sock',Destination:'/var/run/docker.sock'},{Type:'volume',Name:'setup-test',Destination:d},...${importing ? "[{Type:'bind',RW:false,Source:'/fixture/source',Destination:'/import/opencode'}]" : "[]"}];
 if (a.includes('{{json .Image}} {{json .Mounts}}')) console.log(JSON.stringify(pin),JSON.stringify(mounts));
 else console.log(JSON.stringify([pin, ${JSON.stringify(importing ? "local:test" : runner)}, mounts]));
}
else if(a[0]==='version') console.log('linux/arm64');
else if(a[0]==='image' && a.some(v=>v.includes('@'))) {
 if(!fs.existsSync(d+'/pulled-'+a.find(v=>v.includes('@')).split('/').at(-1))) process.exit(1);
 console.log('linux/arm64');
}
else if(a[0]==='manifest') console.log(JSON.stringify({manifests:[{platform:{os:'linux',architecture:'amd64'}}]}));
else if(a[0]==='pull') {
 const role=a.at(-1).split('/').at(-1);
 if(process.env.RELEASE_MISSING_ARCH) {console.error('no matching manifest for linux/arm64 in the manifest list entries');process.exit(1);}
 console.log('Pull progress '+role);fs.writeFileSync(d+'/pulled-'+role,'');
}
else if(a[0]==='image') console.log(pin);
else if(a[0]==='container') { console.error('No such container');process.exitCode=1; }
else if(a[0]==='volume' && a[1]==='ls') console.log('wlp-harness-opencode-${id}');
else if(a[0]==='volume' && a[1]==='inspect') console.log(JSON.stringify([{Driver:'local',Labels:{'dev.windlass-platform':'1','dev.windlass-platform.machine':'${id}','dev.windlass-platform.uid':'fixture'}}]));
else if(a[0]==='run' && a.includes('--network') && a.includes('none')) {
 if (!a.some(v=>v.includes('dst=/login,volume-nocopy'))) process.exit(3);
 process.chdir(${JSON.stringify(volume)}); fs.chownSync=()=>{};eval(a.at(-1));
 fs.appendFileSync('revisions',JSON.parse(fs.readFileSync('login.json')).generation+'\\n');
}
else process.exitCode=2;
`,
					{ mode: 0o755 },
				);
				const env = { ...process.env, PATH: dir + ":" + process.env.PATH, WLP_RUNNER_STATE_DIR: state };
				const child = spawn(
					"script",
					[
						"-qef",
						"-c",
						`"${process.execPath}" --require "${preload}" "${dir}/runner.cjs" setup --platform ${origin} ${importing ? "--screenshots " : ""}--harness codex --harness claude --harness opencode`,
						"/dev/null",
					],
					{ env, stdio: ["pipe", "pipe", "pipe"] },
				);
				// Claude Code and Codex pay with the account's plans and keys: only OpenCode is asked to sign in.
				const prompts = [
					["OpenCode: sign in now?", ""],
					...(importing
						? [
								["(opencode-go) API key: import?", accept ? "" : "n"],
								["(opencode) API key: import?", accept ? "" : "n"],
								["can't be shared safely", "n"],
							]
						: []),
					...(!accept
						? [
								["OpenCode provider", "openai"],
								["Enter the openai API key", "setup-fixture-secret"],
							]
						: []),
				];
				let output = "",
					step = 0;
				child.stdout.on("data", chunk => {
					output += chunk;
					// An optional question that was not asked is passed over once the next one is.
					while (
						step < prompts.length &&
						prompts[step][2] &&
						!output.includes(prompts[step][0]) &&
						prompts[step + 1] &&
						output.includes(prompts[step + 1][0])
					)
						step++;
					if (step < prompts.length && output.includes(prompts[step][0])) child.stdin.write(prompts[step++][1] + "\n");
				});
				const timer = setTimeout(() => child.kill("SIGTERM"), 45000);
				let code;
				try {
					code = await new Promise(done => child.once("exit", done));
				} finally {
					clearTimeout(timer);
					child.stdin.destroy();
				}
				assert.equal(code, 0, output.replaceAll("setup-fixture-secret", "[fixture]"));
				assert.equal(step, prompts.length);
				assert.doesNotMatch(output, /Claude Code: sign in now\?|Codex: sign in now\?/);
				assert.ok(!output.includes("setup-fixture-secret"));
				assert.match(output, /ABCD-EFGH/);
				assert.deepEqual(asked, ["/runner/pair", "/runner/pair/poll"]);
				const stored = JSON.parse(await readFile(join(volume, "login.json"), "utf8"));
				const ids = accept ? ["opencode-go", "opencode"] : ["openai"];
				assert.deepEqual(Object.keys(stored.records), ids);
				for (const [i, id] of ids.entries())
					assert.equal(
						stored.records[id].key,
						accept ? ["fixture-existing-go", "fixture-existing-zen"][i] : "setup-fixture-secret",
					);
				assert.doesNotMatch(JSON.stringify(stored), /foreign-refresh|foreign-access/);
				assert.ok(output.includes("-e WLP_RUNNER_STATE_DIR=" + state));
				assert.deepEqual(JSON.parse(await readFile(join(state, "opencode-" + id + ".json"), "utf8")).providers, ids);
				for (const name of await readdir(state, { withFileTypes: true }))
					if (name.isFile())
						assert.doesNotMatch(
							await readFile(join(state, name.name), "utf8"),
							/fixture-existing-|fixture-foreign-|setup-fixture-secret/,
						);
				if (accept) {
					const revisions = (await readFile(join(volume, "revisions"), "utf8")).trim().split("\n");
					const metadata = JSON.parse(await readFile(join(state, "opencode-" + id + ".json"), "utf8"));
					assert.equal(revisions.length, 2);
					assert.notEqual(revisions[0], revisions[1]);
					assert.equal(metadata.generation, revisions[1]);
				}
				if (importing) assert.equal(await readFile(source, "utf8"), fixture);
				assert.doesNotMatch(output, /fixture-existing-|fixture-foreign-|\/import\/opencode|\/fixture\/source/);
				assert.ok(
					output.includes(
						(importing ? pin : runner) +
							" run --platform " +
							origin +
							(importing ? " --screenshots" : "") +
							" --harness codex --harness claude --harness opencode",
					),
					"printed service command: " + output.split("Start the runner on this machine:").at(-1),
				);
				for (const role of ["sandbox", "claude", "opencode", "codex", ...(importing ? ["sandbox-shots"] : [])]) {
					const progress = output.indexOf("Pull progress windlass-platform-" + role + "@");
					assert.ok(
						progress >= 0 && progress < output.indexOf("ABCD-EFGH"),
						"missing pre-pair pull progress for " + role,
					);
				}
				if (!importing) assert.doesNotMatch(output, /Pull progress windlass-platform-sandbox-shots/);
				if (!importing) {
					const bundle = join(dir, "runner.cjs");
					const before = asked.length;
					await rm(join(state, "pulled-" + ref("sandbox").split("/").at(-1)));
					for (const command of ["setup", "run"]) {
						await assert.rejects(
							promisify(execFile)(process.execPath, ["--require", preload, bundle, command, "--platform", origin], {
								env: { ...env, RELEASE_MISSING_ARCH: "1" },
								timeout: 8000,
							}),
							error => {
								assert.match(error.stderr, /This runner release has no linux\/arm64 images/);
								return true;
							},
						);
					}
					assert.equal(asked.length, before);
					const piped = spawn(process.execPath, [bundle, "login", "opencode", "--provider", "openai"], {
						env,
						stdio: ["pipe", "ignore", "pipe"],
					});
					let error = "";
					piped.stderr.setEncoding("utf8").on("data", chunk => {
						error += chunk;
					});
					piped.stdin.end("a".repeat(5000));
					assert.notEqual(await new Promise(done => piped.once("close", done)), 0);
					assert.match(error, /openai API key.*4096/);
					assert.doesNotMatch(error, /Claude/);
					const published = "registry.invalid/runner@" + pin;
					const report = () =>
						JSON.parse(
							execFileSync(process.execPath, [bundle, "capabilities"], {
								env: { ...env, WLP_RUNNER_IMAGE: published },
							}),
						);
					const full = report();
					const { capabilities } = full;
					assert.ok(Array.isArray(capabilities) && capabilities.every(value => typeof value === "string"));
					assert.ok(capabilities.includes("harness-key-relay"));
					assert.deepEqual(full, { image: published, harnesses: ["claude", "opencode", "codex"], capabilities });
					execFileSync(process.execPath, [join(root, "runner/bundle.mjs"), pin, bundle, "claude=" + pin]);
					assert.deepEqual(report(), { image: published, harnesses: ["claude"], capabilities });
					const run = (...args) =>
						promisify(execFile)(process.execPath, ["--require", preload, bundle, ...args], { env, timeout: 10000 });
					await assert.rejects(run("run", "--harness", "codex"), /pinned Codex image/);
					await assert.rejects(run("status", "--name", "example"), /with setup, run or pair/);
					await assert.rejects(run("pair", "--egress", "none"), /with setup or run/);
					refuseSetup = true;
					await assert.rejects(run("setup", "--platform", origin, "--harness", "claude"), error => {
						assert.match(error.stdout, /re-run the setup command/);
						assert.doesNotMatch(error.stdout, /restart the container/);
						return true;
					});
				}
			} finally {
				server.closeAllConnections();
				server.close();
				await rm(dir, { recursive: true, force: true });
			}
		},
	);
