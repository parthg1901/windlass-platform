/**
 * This server's sign-in machinery: where Windlass's sign-in commands run, and what the sandbox provider
 * adds to a user's sign-in. The `user` actor and the sandbox layer's `logins` and `tokens` all take it
 * from here, so there is one of it per server process.
 *
 * Where the commands run is independent of where sandboxes run:
 *
 *   WLP_WINDLASS_BIN       a Windlass executable on this server (a path, or a name on PATH; default
 *                          `windlass`). The commands run as local processes: the way for a deployment,
 *                          and it needs no Docker. It must be Windlass 0.4.0 or later.
 *   WLP_SIGNIN_RUNNER      `local` or `docker`, to say it outright. Without it: `local` when
 *                          WLP_WINDLASS_BIN is set, otherwise `docker` when the sandboxes are Docker's
 *                          (the helper container of the sandbox image, for development), otherwise
 *                          `local`. Startup checks the selected executable.
 *   WLP_SIGNIN_TMPDIR      where the local runner makes its private directories (default: /dev/shm
 *                          where there is one, else the system's temporary directory)
 *
 * With WLP_SANDBOX=fake no Windlass runs at all: the fake layer's stand-in answers (sandbox-fake.ts).
 * Unless WLP_SIGNIN_RUNNER is set: then the sign-in is the real one over fake sandboxes, which is how
 * the sign-in is tried on a machine without Docker (scripts/signin-check.ts, section `actors`).
 */

import { config } from "../config.js";
import { windlassVersionProblem } from "../startup.js";
import { type SignInCommands, WindlassSignIns } from "./commands.js";
import { LocalLoginRunner, type LoginRunner } from "./runner.js";
import { type Sealer, serverSealer } from "./seal.js";

export interface SignInHooks {
	/** Removes the token files of the user's running turns. */
	revoke?: (uid: string) => Promise<void>;
}

export interface SignIns {
	commands: SignInCommands;
	sealer: Sealer;
	hooks: SignInHooks;
	/** Where the commands run, for the line the server prints when it starts. */
	describe: string;
	/** What keeps the commands from running there, in a sentence that says what to do; null when nothing does. */
	check: () => Promise<string | null>;
}

function chosenRunner(): "local" | "docker" {
	const said = (process.env.WLP_SIGNIN_RUNNER ?? "").trim().toLowerCase();
	if (said === "local" || said === "docker") return said;
	if (said !== "") throw new Error(`WLP_SIGNIN_RUNNER must be "local" or "docker"; got "${said}"`);
	if ((process.env.WLP_WINDLASS_BIN ?? "") !== "") return "local";
	// A server whose sandboxes are Docker's has the sandbox image, and may have no Windlass of its own.
	return config.sandbox === "docker" ? "docker" : "local";
}

async function make(): Promise<SignIns> {
	const sealer = serverSealer();
	if (config.sandbox === "fake" && (process.env.WLP_SIGNIN_RUNNER ?? "").trim() === "") {
		const { createFakeSignInCommands } = await import("../sandbox-fake.js");
		return {
			commands: createFakeSignInCommands(),
			sealer,
			hooks: {},
			describe: "the fake layer's stand-in for Windlass",
			check: async () => null,
		};
	}
	const hooks: SignInHooks = {};
	if (config.sandbox === "docker") {
		const { removeTokenFiles } = await import("../sandbox/volumes.js");
		hooks.revoke = uid => removeTokenFiles(uid);
	}
	let runner: LoginRunner;
	let describe: string;
	if (chosenRunner() === "local") {
		const binary = (process.env.WLP_WINDLASS_BIN ?? "").trim() || "windlass";
		runner = new LocalLoginRunner({ binary });
		describe = `the Windlass at ${binary}, as a local process`;
	} else {
		const { DockerLoginRunner } = await import("../sandbox/logins.js");
		runner = new DockerLoginRunner();
		describe = "a helper container of the sandbox image";
	}
	const check = async () => windlassVersionProblem(await runner.version(), describe);
	return {
		commands: new WindlassSignIns(runner, { log: line => console.error(line) }),
		sealer,
		hooks,
		describe,
		check,
	};
}

let made: Promise<SignIns> | null = null;

/** This server's sign-in machinery, made at first use. A configuration that cannot work is reported again at every use. */
export function getSignIns(): Promise<SignIns> {
	made ??= make().catch((error: unknown) => {
		made = null;
		throw error;
	});
	return made;
}
