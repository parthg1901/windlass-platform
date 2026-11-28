/**
 * How a computer starts the runner's setup, said once for every way in: the platform's `install.sh`
 * (server/src/install-script.ts) and `npx @windlassai/cli connect --machine` (cli/src/machine.ts) run the same
 * one-off container with the same mounts and say the same about Docker's problems. The image and the platform's
 * address come from the platform (`MachinesInfo`). No imports: the CLI bundles this module on its own, and the
 * runner and the web app read it too.
 */

/** The command the Machines page shows first. */
export const MACHINE_CONNECT_COMMAND = "npx @windlassai/cli connect --machine";
/** The command that keeps a Claude login on a paired machine only, for its Claude Code (Connections shows it). */
export const THIS_MACHINE_CLAUDE_COMMAND = "npx @windlassai/cli connect claude --this-machine";

/** The volume that keeps the runner's state, its machine key among it, across containers and updates. */
export const RUNNER_STATE_VOLUME = "windlass-runner";
export const RUNNER_STATE_DIR = "/var/lib/windlass-runner";
export const DOCKER_SOCKET = "/var/run/docker.sock";
/** The runner service's container, which the setup starts and a local `docker exec` reaches. */
export const RUNNER_CONTAINER = "windlass-runner";

/**
 * `docker` arguments of the setup's one-off container. `terminal`: the setup's questions on this terminal
 * (install.sh). `connect`: no questions; the setup takes its defaults, signs no agent in and writes its progress
 * as `SetupEvent` lines for the CLI. Docker keeps no log of it, as sign-ins may happen in it.
 */
export function setupRunArgs(
	image: string,
	platform: string,
	how: "terminal" | "connect",
	/** The machine's name, where the caller knows it better than the container does (Docker Desktop's VM is "docker-desktop"). */
	name?: string,
): string[] {
	return [
		"run",
		...(how === "terminal" ? ["-it"] : []),
		"--rm",
		"--log-driver",
		"none",
		"-v",
		`${DOCKER_SOCKET}:${DOCKER_SOCKET}`,
		"-v",
		`${RUNNER_STATE_VOLUME}:${RUNNER_STATE_DIR}`,
		image,
		"setup",
		"--platform",
		platform,
		...(how === "connect" ? ["--connect"] : []),
		...(name ? ["--name", name] : []),
	];
}

/** The page that approves a machine's pairing code, on the platform the runner pairs with. */
export function machineApproveUrl(platform: string, code: string): string {
	return `${platform}/connect?${new URLSearchParams({ code, kind: "machine" })}`;
}

/** Where Docker runs, for its messages: Windows itself (`windows`) and a Windows shell without WSL (`windows-shell`, install.sh) differ. */
export type DockerHost = "darwin" | "linux" | "wsl" | "windows" | "windows-shell" | "other";

/** What to tell a person whose Docker is missing, stopped or not theirs. Each ends with running the command again. */
export const DOCKER_HELP: {
	missing: Record<DockerHost, string>;
	stopped: Record<DockerHost, string>;
	denied: string;
	pull(image: string): string;
} = {
	missing: {
		darwin:
			"Docker is not installed. Install Docker Desktop (https://docs.docker.com/desktop/setup/install/mac-install/) or OrbStack (https://orbstack.dev), start it, then run this again.",
		linux:
			"Docker is not installed. Install Docker Engine (https://docs.docker.com/engine/install/), then run this again.",
		wsl: "Docker is not available in this WSL distribution. In Docker Desktop, open Settings > Resources > WSL integration, turn it on for this distribution, then run this again.",
		windows:
			"Docker is not installed. Install Docker Desktop (https://docs.docker.com/desktop/setup/install/windows-install/), start it, then run this again.",
		"windows-shell":
			"Run this in a WSL terminal with Docker Desktop's WSL integration on, or run the setup command from the Machines page in PowerShell.",
		other: "Docker is not installed. Install Docker, then run this again.",
	},
	stopped: {
		darwin:
			"Docker is not running. Start Docker Desktop or OrbStack, wait until it says it is running, then run this again.",
		linux: "Docker is not running. Start it (for example: sudo systemctl start docker), then run this again.",
		wsl: "Docker is not running. Start Docker Desktop on Windows, then run this again.",
		windows: "Docker is not running. Start Docker Desktop, wait until it says it is running, then run this again.",
		"windows-shell": "Docker is not running. Start Docker Desktop, then run this again.",
		other: "Docker is not running. Start it, then run this again.",
	},
	denied:
		"Docker is running, but this user may not use it. Add the user to the docker group (then log in again), or run this as a user who can run docker.",
	pull: image => `Could not fetch ${image}. Check this machine's network, then run this again.`,
};

/** Whether `docker info`'s complaint is that this user may not reach the daemon, rather than that it is not running. */
export const dockerDenied = (problem: string) => /permission denied/i.test(problem);

/**
 * One line the setup writes in `connect` mode, as JSON: a step starting (`step`), progress within it
 * (`progress`), a message (`log`), the pairing code and machine key to approve (`pairing`), and the last word
 * (`done`). The CLI shows them; any other line is shown as it is.
 */
export type SetupEvent =
	| { event: "step" | "progress" | "done"; text: string }
	| { event: "log"; level: "info" | "success" | "warn" | "error"; text: string }
	| { event: "pairing"; code: string; key: string };

const LOG_LEVELS = ["info", "success", "warn", "error"];

/** The event a line holds, or null for a line that is not one. */
export function parseSetupEvent(line: string): SetupEvent | null {
	if (!line.startsWith("{")) return null;
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	const v = value as Record<string, unknown> | null;
	if (typeof v !== "object" || v === null) return null;
	if (v.event === "pairing")
		return typeof v.code === "string" && typeof v.key === "string"
			? { event: "pairing", code: v.code, key: v.key }
			: null;
	if (typeof v.text !== "string") return null;
	if (v.event === "log")
		return typeof v.level === "string" && LOG_LEVELS.includes(v.level)
			? { event: "log", level: v.level as "info", text: v.text }
			: null;
	if (v.event === "step" || v.event === "progress" || v.event === "done") return { event: v.event, text: v.text };
	return null;
}
