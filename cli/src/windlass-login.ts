/**
 * `connect codex` signs in with ChatGPT on this computer, the way OpenAI documents for a remote host: the sign-in
 * is completed locally with the same client (Windlass's own `windlass login`, which opens the browser and catches
 * the 127.0.0.1 callback itself, or lets its user paste the address on a machine without one), and the files it
 * saves go to the platform, which refreshes them from then on.
 *
 * Windlass runs with a private data directory (`XDG_DATA_HOME`, as server/src/signin/runner.ts does on the
 * platform), so it neither reads nor changes this computer's own Windlass sign-in. The directory is removed however
 * the run ends. Nothing here prints, logs or keeps what is in the files.
 */
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_MATERIAL_FILE_BYTES,
	SIGN_IN_UPLOAD_FILES,
	SIGN_IN_WINDLASS_VERSION,
	type SignInUpload,
	validSignInUpload,
} from "../../server/src/contract/connect.ts";
import { CliError } from "./platform.ts";
import { onPath } from "./setup-token.ts";

/** The prefix of the private directory, so a left one (a killed process) can be told from anything else. */
export const PRIVATE_DIR_PREFIX = "windlassai-signin-";

/** Whether `windlass --version` ("Windlass 0.7.1 (linux-x64)") names a release whose sign-in files the platform reads: the pinned one or a later patch. */
export function compatibleWindlass(said: string, pinned = SIGN_IN_WINDLASS_VERSION): boolean {
	const found = /^\S+\s+v?(\d+)\.(\d+)\.(\d+)/.exec(said.trim());
	const want = /^(\d+)\.(\d+)\.(\d+)/.exec(pinned);
	if (!found || !want) return false;
	return found[1] === want[1] && found[2] === want[2] && Number(found[3]) >= Number(want[3]);
}

/** What `windlass --version` prints, or null when there is no `windlass` to ask. */
function installedVersion(env: NodeJS.ProcessEnv): Promise<string | null> {
	if (!onPath("windlass", env)) return Promise.resolve(null);
	return new Promise(resolve => {
		let out = "";
		const child = spawn("windlass", ["--version"], { stdio: ["ignore", "pipe", "ignore"], env });
		const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
		child.stdout.on("data", chunk => (out += chunk));
		child.once("error", () => resolve(null));
		child.once("close", code => {
			clearTimeout(timer);
			resolve(code === 0 ? out : null);
		});
	});
}

/** The installed `windlass` when it is a compatible release, else the pinned release through npx. Fixed words only. */
export async function windlassLoginCommand(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
	const said = await installedVersion(env);
	if (said !== null && compatibleWindlass(said)) return ["windlass", "login"];
	return ["npx", "-y", "-p", `windlass-agent@${SIGN_IN_WINDLASS_VERSION}`, "windlass", "login"];
}

/**
 * The environment Windlass signs in with: this one, with its data, configuration, state, cache, home and
 * temporary files in `dir`, and nothing of a Windlass setting of this computer's (a token file would stop it
 * from saving a sign-in at all). npm keeps this computer's cache and settings, so npx works as it always does.
 */
export function privateEnv(dir: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const kept = Object.fromEntries(Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith("WINDLASS")));
	const home = homedir();
	return {
		...kept,
		npm_config_userconfig: env.npm_config_userconfig ?? join(home, ".npmrc"),
		...(process.platform !== "win32" && { npm_config_cache: env.npm_config_cache ?? join(home, ".npm") }),
		HOME: join(dir, "home"),
		XDG_DATA_HOME: join(dir, "data"),
		XDG_CONFIG_HOME: join(dir, "config"),
		XDG_STATE_HOME: join(dir, "state"),
		XDG_CACHE_HOME: join(dir, "cache"),
		TMPDIR: join(dir, "tmp"),
	};
}

/** Runs the sign-in on this terminal. While it runs, Ctrl-C is Windlass's to handle: this process waits to clean up. */
function run(
	argv: string[],
	env: NodeJS.ProcessEnv,
	cwd: string,
): Promise<{ code: number | null; signal: string | null }> {
	const ignore = () => {};
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	for (const signal of signals) process.on(signal, ignore);
	return new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
		const child = spawn(argv[0]!, argv.slice(1), {
			stdio: "inherit",
			env,
			cwd,
			shell: process.platform === "win32",
		});
		child.once("error", error =>
			reject(new CliError(`Could not run ${argv[0]} (${(error as NodeJS.ErrnoException).code ?? "error"}).`)),
		);
		child.once("close", (code, signal) => resolve({ code, signal }));
	}).finally(() => {
		for (const signal of signals) process.off(signal, ignore);
	});
}

/** The upload's files as Windlass left them in `data`: plain files of a sane size only, and only a finished sign-in. */
export async function readSignIn(data: string): Promise<SignInUpload | null> {
	const files: Record<string, string> = {};
	for (const name of SIGN_IN_UPLOAD_FILES) {
		const path = join(data, name);
		const found = await lstat(path).catch(() => null);
		if (found === null || !found.isFile() || found.size > MAX_MATERIAL_FILE_BYTES) continue;
		files[name] = await readFile(path, "utf8");
	}
	const upload = { files };
	return validSignInUpload(upload) ? upload : null;
}

/** Signs in with ChatGPT through Windlass in a private directory and answers the files it saved; the directory is gone afterwards. */
export async function windlassSignIn(): Promise<SignInUpload> {
	// mkdtemp makes it with mode 0700: nobody else on this computer can list or enter it.
	const dir = await mkdtemp(join(tmpdir(), PRIVATE_DIR_PREFIX));
	try {
		for (const sub of ["home", "config", "state", "cache", "tmp", join("data", "windlass")])
			await mkdir(join(dir, sub), { recursive: true, mode: 0o700 });
		const argv = await windlassLoginCommand();
		const ended = await run(argv, privateEnv(dir), join(dir, "home"));
		const upload = await readSignIn(join(dir, "data", "windlass"));
		if (upload) return upload;
		if (ended.signal !== null) throw new CliError("The ChatGPT sign-in was stopped. Nothing was connected.");
		throw new CliError(
			ended.code === 0
				? "Windlass did not save a ChatGPT sign-in. Run the command again."
				: "The ChatGPT sign-in did not finish. Nothing was connected; run the command again.",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
