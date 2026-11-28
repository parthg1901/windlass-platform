/**
 * `connect claude --this-machine`: keeps a Claude login on this computer only, for this machine's Claude Code.
 * `claude setup-token` runs here as for `connect claude` (connect.ts `claudeToken`), but its token goes to the
 * Windlass runner on this computer instead of the platform: `windlass-runner login claude --token-stdin` in the
 * runner's container, which keeps it in its Claude login volume as `windlass-runner login claude` does. The token
 * travels on that command's standard input only: never on an argument, never printed, never over the network. The
 * runner reports the login to the platform itself, so nothing is sent from here.
 */
import { spawn } from "node:child_process";
import { validPlanToken } from "../../server/src/contract/connect.ts";
import {
	MACHINE_CONNECT_COMMAND,
	RUNNER_CONTAINER,
	THIS_MACHINE_CLAUDE_COMMAND,
} from "../../server/src/contract/machine-setup.ts";
import { claudeToken } from "./connect.ts";
import { checkDocker, docker } from "./machine.ts";
import { CliError } from "./platform.ts";
import { ask, interactive, printable, say } from "./terminal.ts";
import { scrub } from "./token.ts";

const PAIR_FIRST = `Pair this machine first: ${MACHINE_CONNECT_COMMAND}`;

export async function connectClaudeHere(options: { token?: string } = {}): Promise<void> {
	if (options.token !== undefined && !validPlanToken("anthropic", options.token))
		throw new CliError("Standard input does not hold a setup token (it starts with sk-ant-oat01-).");
	await localRunner();
	say("This keeps a Claude login on this computer for its Claude Code. It never leaves this machine.\n");
	const token = options.token ?? (await claudeToken());
	const kept = await runnerLogin(token);
	if (kept.code !== 0) {
		const reason = lastLine(kept.output);
		throw new CliError(
			reason ? `The runner did not keep the login: ${reason}` : "The runner did not keep the login. Try again.",
		);
	}
	say("Claude Code on this machine now uses this login. It stays on this machine.");
	say("To pay with your Claude plan from Windlass again, choose Switch back to your plan on Connections.");
}

/** The runner's container is here and running, or a message that says to pair this machine first. */
async function localRunner(): Promise<void> {
	await checkDocker(PAIR_FIRST);
	const state = await docker(["container", "inspect", "--format", "{{.State.Running}}", RUNNER_CONTAINER], "pipe");
	if (state.code === 0 && state.stdout.trim() === "true") return;
	throw new CliError(
		state.code === 0
			? `The Windlass runner on this computer is stopped. Start it with docker start ${RUNNER_CONTAINER}, then run this again.`
			: `No Windlass runner is running on this computer. ${PAIR_FIRST}`,
	);
}

/** `docker exec -i` the runner's login with the token on its standard input; what it said, for an error. */
function runnerLogin(token: string): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"docker",
			["exec", "-i", RUNNER_CONTAINER, "windlass-runner", "login", "claude", "--token-stdin"],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		let output = "";
		child.stdout.on("data", chunk => (output += chunk));
		child.stderr.on("data", chunk => (output += chunk));
		child.once("error", reject);
		child.once("close", code => resolve({ code, output }));
		child.stdin.on("error", () => {});
		child.stdin.end(token + "\n");
	});
}

/** The last thing the runner said, scrubbed and printable. */
function lastLine(output: string): string {
	const line =
		output
			.split(/\r?\n/)
			.map(part => part.trim())
			.filter(Boolean)
			.at(-1) ?? "";
	return printable(scrub(line)).slice(0, 300);
}

/**
 * The end of `connect --machine`: how this machine's Claude Code pays. `--local-claude` keeps a login here; at a
 * terminal the person is asked, the plan from Windlass being the default; with no one to ask, the plan it is.
 */
export async function chooseClaudeHere(localClaude: boolean): Promise<void> {
	let here = localClaude;
	if (!here && interactive()) {
		say("\nClaude Code on this machine:");
		say("  1. Use your Claude plan from Windlass (recommended)");
		say("  2. Keep a login on this machine only");
		here = (await ask("Choose 1 or 2 [1]: ")) === "2";
	}
	if (!here) return;
	say("");
	try {
		await connectClaudeHere();
	} catch (error) {
		if (!(error instanceof CliError)) throw error;
		throw new CliError(
			`The machine is connected, but no Claude login was kept on it. ${error.message} To try again: ${THIS_MACHINE_CLAUDE_COMMAND}`,
		);
	}
}
