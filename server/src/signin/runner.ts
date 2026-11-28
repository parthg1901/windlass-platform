/**
 * The seam between the platform and Windlass's own sign-in: "run this `windlass login ...` command
 * against this sign-in material, and give me the material back". The platform does not reimplement
 * OpenAI's sign-in. It keeps what Windlass saves (material.ts) and lends it to Windlass for one command
 * at a time:
 *
 *   1. a private directory is made, and the material's files are written into it, readable by their
 *      owner only;
 *   2. Windlass runs with that directory as its data directory. Windlass looks for its data in
 *      `$XDG_DATA_HOME/windlass` (packages/core/src/auth/chatgpt.ts, `dataDir`), so XDG_DATA_HOME is set
 *      to the private directory, and HOME to a place inside it as well. WINDLASS_ACCESS_TOKEN_FILE is
 *      never passed on: with it Windlass would not use a saved sign-in at all;
 *   3. when the command has ended, however it ended, the files are read back: a refresh has replaced
 *      `auth.json` (Windlass writes it whole, to a temporary name that it then renames);
 *   4. the directory is removed, in every outcome: success, failure, timeout, an abort, a command that
 *      could not be started.
 *
 * Two runners do this. `LocalLoginRunner` (below) starts a Windlass executable on the server: the one
 * for real deployments, which needs no Docker. `DockerLoginRunner` (sandbox/logins.ts) does the same
 * inside a throwaway container of the sandbox image, for development on a machine that has the image
 * and no Windlass of its own.
 *
 * The material is read back also after a failure or a timeout, because a command can fail after the
 * sign-in service has already replaced the refresh token: whatever Windlass managed to save is worth
 * more than the copy that went in. What is read back is only ever handed to the caller. Standard output
 * may hold a token (`login token`), so no runner logs it or puts it into an error.
 *
 * A runner also runs what Windlass can say of an account outside a turn (`windlass --models`), which
 * needs no sign-in, only an access token of one (`runWithToken`). The token is handed in as a turn's
 * is (sandbox/token-file.ts): in a file that WINDLASS_ACCESS_TOKEN_FILE names, readable by its owner
 * only, in the same kind of private directory, which holds nothing else and is removed the same way.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AccessToken } from "../sandbox/api.js";
import { ACCESS_TOKEN_FILE_ENV, tokenFileContent } from "../sandbox/handoff.js";
import { MATERIAL_FILES, MAX_MATERIAL_FILE_BYTES, type SignInMaterial, cleanMaterial } from "./material.js";
import { errorText } from "../util.js";

export interface LoginCommand {
	/** What follows `windlass login`: `["start", "--no-browser"]`, `["finish"]`, `["token", "--json", "--valid-for", "20m"]`. */
	args: string[];
	/** Written to the command's standard input, which is then closed. */
	stdin?: string;
	/**
	 * Whether the command talks to the sign-in service. A runner that can cut a command off from the
	 * network does so when this is false (the Docker one); the local one cannot, and Windlass sends
	 * nothing for those commands anyway.
	 */
	network: boolean;
	timeoutMs: number;
	/** Aborting ends the command at once. What it had saved by then is still read back. */
	signal?: AbortSignal;
}

export interface LoginRun {
	/** Null when the command was killed. */
	code: number | null;
	/** May hold a token: never logged, never part of an error. */
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
	/** What the directory held when the command had ended. */
	material: SignInMaterial;
	/** False when the directory could not be read back (a container that had to be removed): `material` is then what went in. */
	materialRead: boolean;
}

/** A command that runs on a handed-in access token: what follows `windlass`, and its limits. */
export type TokenCommand = Pick<LoginCommand, "args" | "timeoutMs">;
/** How it ended. Nothing is read back: there was no sign-in in its directory. */
export type TokenRun = Pick<LoginRun, "code" | "stdout" | "stderr" | "timedOut">;

export interface LoginRunner {
	run(material: SignInMaterial, command: LoginCommand): Promise<LoginRun>;
	/** Runs `windlass <args>` on `token`, handed in through a file that is removed when the command has ended, and on no sign-in. */
	runWithToken(token: AccessToken, command: TokenCommand): Promise<TokenRun>;
	/** What `windlass --version` says where this runner runs it; null when it could not be asked. */
	version(): Promise<string | null>;
}

/** What is kept of a command's standard output and standard error. */
const MAX_OUTPUT_CHARS = 256 * 1024;

/** The prefix of every private directory, so a stale one can be told from anything else. */
export const TMP_PREFIX = "wlp-signin-";
/** A private directory older than this belongs to a process that died in the middle of a command: no command runs this long. */
const STALE_MS = 10 * 60 * 1000;

/**
 * Where private directories are made: WLP_SIGNIN_TMPDIR when set, otherwise `/dev/shm` where there is
 * one (memory, so a sign-in never reaches a disk, not even for the moment a command runs), otherwise
 * the system's temporary directory.
 */
export function defaultTmpRoot(): string {
	const chosen = process.env.WLP_SIGNIN_TMPDIR;
	if (chosen !== undefined && chosen !== "") return chosen;
	try {
		if (statSync("/dev/shm").isDirectory()) {
			accessSync("/dev/shm", constants.W_OK | constants.X_OK);
			return "/dev/shm";
		}
	} catch {
		// No such place here, or not ours to write to.
	}
	return tmpdir();
}

/** Variables a Windlass on the server needs from the server's own environment to reach the sign-in service. Nothing else is passed on. */
const PASSED_ON = [
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"https_proxy",
	"http_proxy",
	"all_proxy",
	"no_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
	"LANG",
	"LC_ALL",
	"TZ",
];

export interface LocalLoginRunnerOptions {
	/** The Windlass executable: a path, or a name on PATH. */
	binary: string;
	/** Where the private directories are made. Default `defaultTmpRoot()`. */
	tmpRoot?: string;
	/** Added to the command's environment, for checks (a proxy that stands in for the sign-in service). */
	env?: Record<string, string>;
	/** Where a line about a directory that could not be removed goes. It never contains material. */
	log?: (line: string) => void;
}

export class LocalLoginRunner implements LoginRunner {
	private readonly binary: string;
	private readonly tmpRoot: string;
	private readonly log: (line: string) => void;
	private swept: Promise<void> | null = null;

	constructor(private readonly options: LocalLoginRunnerOptions) {
		this.binary = options.binary;
		this.tmpRoot = options.tmpRoot ?? defaultTmpRoot();
		this.log = options.log ?? (line => console.error(line));
	}

	async run(material: SignInMaterial, command: LoginCommand): Promise<LoginRun> {
		return this.inPrivateDirectory(async (dir, env) => {
			const data = join(dir, "data", "windlass");
			for (const name of MATERIAL_FILES) {
				const text = material.files[name];
				if (text !== undefined) await writeFile(join(data, name), text, { mode: 0o600, flag: "wx" });
			}
			const ended = await execute(this.binary, ["login", ...command.args], {
				cwd: dir,
				env,
				stdin: command.stdin,
				timeoutMs: command.timeoutMs,
				signal: command.signal,
			});
			return { ...ended, material: await readBack(data), materialRead: true };
		});
	}

	async runWithToken(token: AccessToken, command: TokenCommand): Promise<TokenRun> {
		return this.inPrivateDirectory(async (dir, env) => {
			const file = join(dir, "access-token.json");
			await writeFile(file, tokenFileContent(token), { mode: 0o600, flag: "wx" });
			return execute(this.binary, command.args, {
				cwd: dir,
				env: { ...env, [ACCESS_TOKEN_FILE_ENV]: file },
				timeoutMs: command.timeoutMs,
			});
		});
	}

	/** Makes a private directory and the environment of a Windlass whose data, home and configuration are in it, runs `step`, and removes the directory however that ended. */
	private async inPrivateDirectory<T>(step: (dir: string, env: Record<string, string>) => Promise<T>): Promise<T> {
		this.swept ??= this.sweep();
		await this.swept;
		// mkdtemp makes it with mode 0700: nobody else on the machine can list or enter it.
		const dir = await mkdtemp(join(this.tmpRoot, TMP_PREFIX));
		try {
			for (const sub of ["home", "config", "tmp", join("data", "windlass")])
				await mkdir(join(dir, sub), { recursive: true, mode: 0o700 });
			const env: Record<string, string> = {
				PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
				HOME: join(dir, "home"),
				XDG_DATA_HOME: join(dir, "data"),
				XDG_CONFIG_HOME: join(dir, "config"),
				TMPDIR: join(dir, "tmp"),
			};
			for (const name of PASSED_ON) {
				const value = process.env[name];
				if (value !== undefined && value !== "") env[name] = value;
			}
			Object.assign(env, this.options.env ?? {});
			return await step(dir, env);
		} finally {
			await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
				this.log(
					`[wlp] sign-in.tmp_left dir=${dir}: the private directory of a sign-in command could not be removed (${errorText(error)}); remove it by hand`,
				);
			});
		}
	}

	async version(): Promise<string | null> {
		try {
			const said = await execute(this.binary, ["--version"], {
				cwd: this.tmpRoot,
				env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
				timeoutMs: 20_000,
			});
			// "Windlass 0.4.0 (linux-arm64)"
			const match = /^\S+\s+(\S+)/.exec(said.stdout.trim());
			return said.code === 0 && match !== null ? match[1]! : null;
		} catch {
			return null;
		}
	}

	/**
	 * Removes private directories a process left behind when it was killed in the middle of a command.
	 * Once per runner, before its first command; a directory younger than any command can run is another
	 * process's and is left alone.
	 */
	private async sweep(): Promise<void> {
		try {
			for (const name of await readdir(this.tmpRoot)) {
				if (!name.startsWith(TMP_PREFIX)) continue;
				const path = join(this.tmpRoot, name);
				const found = await stat(path).catch(() => null);
				if (
					found === null ||
					!found.isDirectory() ||
					found.uid !== process.getuid?.() ||
					Date.now() - found.mtimeMs < STALE_MS
				)
					continue;
				await rm(path, { recursive: true, force: true });
				this.log(
					`[wlp] sign-in.tmp_swept dir=${path}: a private directory an earlier server process left behind was removed`,
				);
			}
		} catch {
			// Nothing to sweep, or not ours to list: the next command still makes and removes its own.
		}
	}
}

/** The material's files as they are in `data` now. A file that is not a plain file of a sane size is not read. */
async function readBack(data: string): Promise<SignInMaterial> {
	const files: Record<string, string> = {};
	for (const name of MATERIAL_FILES) {
		const path = join(data, name);
		const found = await lstat(path).catch(() => null);
		if (found === null || !found.isFile() || found.size > MAX_MATERIAL_FILE_BYTES) continue;
		files[name] = await readFile(path, "utf8");
	}
	return cleanMaterial(files);
}

interface Executed {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
}

/** Runs a program to its end. Rejects only when it could not be started. */
function execute(
	file: string,
	args: string[],
	options: { cwd: string; env: Record<string, string>; stdin?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<Executed> {
	return new Promise((resolve, reject) => {
		// In a process group of its own, so that stopping it stops whatever it started as well: nothing
		// is left holding the directory, or the pipes this waits for.
		const child = spawn(file, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
		const kill = () => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const out = new StringDecoder("utf8");
		const err = new StringDecoder("utf8");
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		const keep = (kept: string, chunk: string) =>
			kept.length >= MAX_OUTPUT_CHARS ? kept : (kept + chunk).slice(0, MAX_OUTPUT_CHARS);
		child.stdout.on("data", (chunk: Buffer) => (stdout = keep(stdout, out.write(chunk))));
		child.stderr.on("data", (chunk: Buffer) => (stderr = keep(stderr, err.write(chunk))));
		child.stdin.on("error", () => {});
		child.stdin.end(options.stdin ?? "");
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, options.timeoutMs);
		const onAbort = () => {
			aborted = true;
			kill();
		};
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
		const done = () => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		};
		child.on("error", error => {
			done();
			// The message names the program and the reason, never an argument or anything it was given.
			reject(new Error(`could not run ${file}: ${(error as NodeJS.ErrnoException).code ?? error.message}`));
		});
		child.on("close", code => {
			done();
			resolve({ code, stdout: stdout + out.end(), stderr: stderr + err.end(), timedOut, aborted });
		});
	});
}
