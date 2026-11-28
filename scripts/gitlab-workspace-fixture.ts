/** GitLab actor E2E uses a fake model, not a fake remote branch. Run the platform's Git
 * commands on a scratch checkout of the loopback stand-in; keep all other fake commands inert.
 * `record` sees every sandbox command with its arguments, environment and standard input (the fd the
 * Git credential arrives on), so a check can assert which credentials entered the sandbox. */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExecOptions, ExecResult } from "../server/src/sandbox/api.js";
import { FakeHandle } from "../server/src/sandbox-fake.js";

export interface SandboxCommand {
	command: string;
	stdin: string;
	env: Record<string, string>;
	cwd: string;
}

export function installGitlabWorkspaceFixture(storage: string, record?: (entry: SandboxCommand) => void) {
	const original = FakeHandle.prototype.run;
	if (record) {
		const write = FakeHandle.prototype.writeTextFile;
		FakeHandle.prototype.writeTextFile = function (path, content) {
			record({ command: `write ${path}`, stdin: content, env: {}, cwd: "" });
			return write.call(this, path, content);
		};
	}
	const roots = new Map<string, Promise<string>>();
	FakeHandle.prototype.run = async function (command, options: ExecOptions = {}) {
		record?.({
			command,
			stdin: options.stdin ?? "",
			env: { ...options.env, ...options.secretEnv },
			cwd: options.cwd ?? "",
		});
		if (
			!roots.has(this.id) &&
			options.gitUser &&
			command.includes("wlp_git clone --quiet") &&
			command.includes("username=oauth2")
		) {
			roots.set(this.id, mkdtemp(join(storage, "git-")));
		}
		const root = roots.get(this.id);
		if (
			!root ||
			!(
				options.gitUser ||
				command.includes('echo "wlp:dir $target"') ||
				command.includes("private=$(mktemp -d /tmp/wlp-git.XXXXXXXX)") ||
				command.includes("bridge export HEAD index MERGE_HEAD")
			)
		)
			return original.call(this, command, options);
		const cwd = await root;

		const result = await new Promise<ExecResult>((resolve, reject) => {
			const child = spawn("bash", ["-c", command], {
				cwd: options.gitUser ? "/" : cwd,
				env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" },
				signal: options.signal,
				timeout: options.timeoutMs,
			});
			let stdout = "",
				stderr = "";
			child.stdout.setEncoding("utf8").on("data", text => {
				stdout += text;
				options.onStdout?.(text);
			});
			child.stderr.setEncoding("utf8").on("data", text => {
				stderr += text;
				options.onStderr?.(text);
			});
			child.stdin.on("error", () => {});
			child.stdin.end(options.stdin ?? "");
			child.on("error", reject);
			child.on("close", code =>
				resolve({ exitCode: code, stdout, stderr, timedOut: code === null, aborted: !!options.signal?.aborted }),
			);
		});
		if (result.exitCode === 0 && command.includes('echo "wlp:dir $target"')) {
			// The only simulated part of the Git change is what the model typed.
			await writeFile(join(cwd, `windlass-fixture-${basename(cwd)}.txt`), "Built by the fixture model.\n", {
				flag: "wx",
			});
		}
		return result;
	};
}
