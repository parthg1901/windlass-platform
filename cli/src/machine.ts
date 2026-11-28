/**
 * `connect --machine`: pairs this computer as a machine, the way the platform's install.sh does, with the approval
 * in the browser instead of a code typed on Machines. It checks Docker, pulls the platform's runner image and runs
 * the runner's setup in a one-off container (`setupRunArgs`, shared with install.sh). The runner makes its own key
 * pair and pairs as always; this only shows the code and machine key it reports and opens the page that approves
 * them (`machineApproveUrl`). The machine's key never leaves the container and its volume; nothing here holds a
 * secret. No agent signs in here: the machine's agents pay with the plans and keys on the account, unless the
 * question that follows (local-login.ts `chooseClaudeHere`) keeps a Claude login on this machine.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { createInterface } from "node:readline";
import {
	DOCKER_HELP,
	type DockerHost,
	dockerDenied,
	machineApproveUrl,
	parseSetupEvent,
	setupRunArgs,
} from "../../server/src/contract/machine-setup.ts";
import { PLATFORM_INFO_PATH } from "../../server/src/contract/limits.ts";
import { CliError, get } from "./platform.ts";
import { openBrowser, printable, say } from "./terminal.ts";

const IMAGE = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;

export interface MachineOptions {
	platform: string;
	browser: boolean;
}

export async function connectMachine(options: MachineOptions): Promise<void> {
	const { image, platformUrl } = await runnerImage(options.platform);
	await checkDocker();
	say("Fetching the Windlass runner…");
	if ((await docker(["pull", image], "inherit")).code !== 0) throw new CliError(DOCKER_HELP.pull(image));
	say("Starting the runner's setup. It pairs this computer, then starts the runner in the background.\n");
	await runSetup(setupRunArgs(image, platformUrl, "connect", machineName()), platformUrl, options.browser);
}

/** The runner image this platform publishes and the address a runner pairs with, as install.sh has them. */
async function runnerImage(platform: string): Promise<{ image: string; platformUrl: string }> {
	const answer = await get(platform, PLATFORM_INFO_PATH);
	if (answer.status !== 200) throw new CliError(`The platform answered HTTP ${answer.status}. Try again.`);
	const machines = answer.body.machines as { runnerImage?: unknown; platformUrl?: unknown } | undefined;
	if (!machines) throw new CliError("This platform does not take machines.");
	if (machines.runnerImage === null)
		throw new CliError("This platform has not published a runner yet, so there is nothing to install.");
	const { runnerImage: image, platformUrl } = machines;
	if (typeof image !== "string" || !IMAGE.test(image) || typeof platformUrl !== "string" || !webOrigin(platformUrl))
		throw new CliError("The platform's answer was not understood. Is this a Windlass platform?");
	return { image, platformUrl: webOrigin(platformUrl)! };
}

function webOrigin(address: string): string | null {
	try {
		const url = new URL(address);
		return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
	} catch {
		return null;
	}
}

function dockerHost(): DockerHost {
	if (process.platform === "darwin") return "darwin";
	if (process.platform === "win32") return "windows";
	if (process.platform !== "linux") return "other";
	try {
		return /microsoft/i.test(readFileSync("/proc/version", "utf8")) ? "wsl" : "linux";
	} catch {
		return "linux";
	}
}

/** Docker is installed, running and this user's to use, or a message that says which is not, then `next`. */
export async function checkDocker(next?: string): Promise<void> {
	const host = dockerHost();
	const info = await docker(["info", "--format", "{{.ServerVersion}}"], "pipe");
	const fail = (message: string) => new CliError(next ? `${message} ${next}` : message);
	if (info.missing) throw fail(DOCKER_HELP.missing[host]);
	if (info.code === 0) return;
	throw fail(dockerDenied(info.stderr) ? DOCKER_HELP.denied : DOCKER_HELP.stopped[host]);
}

/** This computer's name for the Machines page; inside Docker Desktop the runner would only see its VM's. */
function machineName(): string | undefined {
	const name = hostname().replace(/\.local$/, "");
	return name.length > 0 && name.length <= 64 && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(name) ? name : undefined;
}

/** Runs the setup container, showing what it says; ends when it does, refusing when it failed. */
async function runSetup(args: string[], platformUrl: string, browser: boolean): Promise<void> {
	const child = spawn("docker", args, { stdio: ["ignore", "pipe", "inherit"] });
	let paired = false;
	const lines = createInterface({ input: child.stdout });
	const shown = (async () => {
		for await (const line of lines) {
			const event = parseSetupEvent(line);
			if (!event) {
				if (line.trim()) say(printable(line));
				continue;
			}
			if (event.event === "pairing") {
				const url = machineApproveUrl(platformUrl, event.code);
				say(
					`Approve this machine in your browser. Check that the page shows the code ${printable(event.code)} and the machine key ${printable(event.key)}.`,
				);
				if (browser && (await openBrowser(url))) say(`Opened ${printable(url)}`);
				else say(`Open this page in a browser where you are signed in to Windlass:\n\n  ${printable(url)}\n`);
				say("Waiting for approval…");
			} else if (event.event === "log") {
				if (event.level === "success" && /^Paired with /.test(event.text)) paired = true;
				const prefix = { info: "", success: "", warn: "Note: ", error: "Error: " }[event.level];
				say(prefix + printable(event.text));
			} else if (event.event === "step") say(printable(event.text) + "…");
			else if (event.event === "done") say(printable(event.text));
		}
	})();
	const code = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	await shown;
	if (code === 0) return;
	throw new CliError(
		paired
			? "The machine is paired, but its runner did not start. Run this command again to start it."
			: "The machine was not connected. Run this command again to start over.",
	);
}

/** Runs `docker`; `missing` when there is no docker command at all. */
export function docker(
	args: string[],
	stdio: "inherit" | "pipe",
): Promise<{ code: number | null; stdout: string; stderr: string; missing: boolean }> {
	return new Promise(resolve => {
		const child = spawn("docker", args, { stdio: ["ignore", stdio, stdio] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", chunk => (stdout += chunk));
		child.stderr?.on("data", chunk => (stderr += chunk));
		child.once("error", error =>
			resolve({ code: null, stdout, stderr, missing: (error as NodeJS.ErrnoException).code === "ENOENT" }),
		);
		child.once("close", code => resolve({ code, stdout, stderr, missing: false }));
	});
}
