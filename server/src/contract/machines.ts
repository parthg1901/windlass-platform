/** Paired machines. */

import type { EgressMode, HarnessId, HarnessOptions, SandboxProfile, SandboxProfileId } from "../contract.js";
import type { ModelProvider } from "./account.js";
import type { ProviderAccount } from "./timeline.js";

/** Waiting means paired but never connected. Offline means previously connected; since records the last contact. */
export type MachineStatus = "waiting" | "online" | "offline";

/** A probe on the machine: passed, or what it found. */
export type MachineProbe = { ok: true } | { ok: false; reason: string };

/** Something the Machines page warns about. Each is listed only while it holds. */
export type MachineWarning =
	| { kind: "signing-disabled" }
	/** The runner is older than `MachinesInfo.minRunnerVersion`, so it is refused; its version is `MachineSummary.runnerVersion`. */
	| { kind: "outdated" }
	/** The runner cannot reach Docker on its machine; `reason` is what Docker said, as the runner reported it. */
	| { kind: "docker"; reason: string }
	/** The machine's clock is this far off the platform's (positive: ahead), enough for a turn's access token to read as expired too early or too late. */
	| { kind: "clock"; offsetSeconds: number }
	/** A second runner with this machine's key tried to connect while its runner was connected, last at `at`: the key was copied. */
	| { kind: "key"; at: number };

/** An agent's sandbox on a machine, as its runner last reported it. */
export interface MachineSandbox {
	resizePending?: true;
	sessionId: string;
	/** Null when that agent was deleted and its sandbox is still there. */
	title: string | null;
	state: "running" | "paused";
	/** When the sandbox was last used, ms since the epoch, by the platform's clock. */
	usedAt: number;
}

/** Docker may supply a short or full container ID as the local hostname. */
export function isMachineIdName(name: string): boolean {
	return /^(?:[0-9a-f]{12}|[0-9a-f]{64})?$/i.test(name.trim());
}

/** An OS as runners report it ("linux", "darwin") by the name people use: "Linux", "macOS". */
function osName(os: string | undefined): string {
	const trimmed = (os ?? "").trim();
	const known: Record<string, string> = { linux: "Linux", darwin: "macOS", windows: "Windows", win32: "Windows" };
	return known[trimmed.toLowerCase()] ?? trimmed;
}

export function machineLabel(machine: { name: string; os?: string; arch?: string }): string {
	const name = machine.name.trim();
	if (!isMachineIdName(name)) return name;
	const kind = [osName(machine.os), machine.arch?.trim()].filter(Boolean).join(" ");
	const what = kind ? kind + " machine" : "Machine";
	return name ? what + " (" + name.slice(0, 6).toLowerCase() + ")" : what;
}

/** Latest host sample for an already listed machine. */
export interface MachineHostUpdate {
	machineId: string;
	host: NonNullable<MachineSummary["host"]> | null;
}
/** Who an item's machine agent was filed to pay with: what pays on the machine (its own login, or the account's plans and keys through Pay with), or a Settings key. */
export type CredentialSource = "machine" | "key";
export interface MachineDetails {
	whenToUse: string;
	tags: string[];
	orchestrator?: "yes" | "named" | "never";
}
export interface MachineSlotCapacity {
	max: number;
	unit: { cpus: number; memoryBytes: number; pids: number };
	reserve: { cpus: number; memoryBytes: number };
}

/** Large sandboxes use two or four slots, limited by the machine's configured capacity. */
export function sandboxSlots(requested: number, max: number) {
	return Math.min(max, requested > 2 ? 4 : requested > 1 ? 2 : 1);
}

/** One of the user's machines, as the Machines page lists it. */
export interface MachineSummary extends Partial<MachineDetails> {
	providerAccounts?: ProviderAccount[];
	/** Additive runner sizing report. Older runners report turn counts and sandbox CPU instead. */
	slots?: Pick<MachineSlotCapacity, "max" | "unit"> & {
		reserve?: MachineSlotCapacity["reserve"];
		busy: number;
		queued: number;
	};
	personalRunning?: number;
	turns?: { running: number; max: number | null; queued: number };
	host?: { cpus: number; sandboxCpus: number; memoryBytes: number; memoryFreeBytes: number; load1: number | null };
	screenshots?: boolean;
	egress?: EgressMode;
	/** With `egress` restricted: how many public hosts the owner's list allows. Absent: any public host. */
	egressDomains?: number;
	claudeRelay?: true;
	/** Owner policy, independent of Docker health. Absent until the first report. */
	allowedProfiles?: Extract<SandboxProfileId, `docker-${string}`>[];
	/**
	 * `signInReason`: with `signIn` "unknown", why the runner could not check the sign-in (runner 0.3.4 and later).
	 * `machineSignIns`: the providers the machine's own sign-in serves. `platformKeys`: the Settings keys its turns
	 * can use. `paysWith`: an agent a plan can pay for (Claude Code, Codex) with no login of its own on the machine:
	 * Connections → Pay with decides what pays, as hosted, and `signIn` says whether a connected plan or a saved key can.
	 */
	harnesses?: Array<{
		id: Exclude<HarnessId, "windlass">;
		adapter: string;
		image: string;
		loginGeneration?: string;
		keyRelay?: true;
		machineProviders?: string[];
		machineSignIns?: ModelProvider[];
		machineMethod?: "api-key" | "chatgpt";
		paysWith?: true;
		platformKeys?: ModelProvider[];
		method?: "api-key" | "chatgpt" | "subscription";
		modes?: string[];
		modeReason?: string;
		signIn: "token" | "none" | "unknown";
		signInReason?: string;
		optionsDigest?: string;
		optionsCheckedAt?: number;
		options?: HarnessOptions;
	}>;
	machineId: string;
	/** Its latest reported name and the OS and architecture supplied at pairing. Nobody checked them. */
	name: string;
	os: string;
	arch: string;
	/** Its runner's release, as the runner last said. */
	runnerVersion: string;
	status: MachineStatus;
	/** Ms since the epoch: see `MachineStatus`. */
	since: number;
	/** How many of the user's agents were launched on it: what keeps its conversation here and cannot run again once it is removed. */
	agents: number;
	/** The sandboxes on it, the most recently used first; empty until its runner first reported. */
	sandboxes: MachineSandbox[];
	/** Whether Windlass can sandbox each command the agent runs there (the runner's probe of bubblewrap); null until its runner first reported. */
	commandSandbox: MachineProbe | null;
	/** Free space where Docker keeps the sandboxes, as last reported; null when not known. */
	freeDiskBytes: number | null;
	/** Runner-reported limits. Absent before the first report or when no cap is configured. */
	readySandboxes?: number;
	maxRunning?: number;
	maxSandboxes?: number;
	/** Snapshot and mirror limits in bytes. capped reflects deployment overrides; builtIn identifies limits inferred for older runners. */
	storeLimits?: { machine: number; user: number; free: number; capped?: true; builtIn?: true };
	/** The sandbox profiles this machine offers, for the launch form: every one, available or not; empty until its runner first reported. */
	profiles: SandboxProfile[];
	/** Whether the repository's and the account's saved secrets are sent to this machine's agents (on for a new machine). */
	sendSecrets: boolean;
	warnings: MachineWarning[];
}

/** What a machine said of itself when its runner asked to be paired: shown before the user confirms it. */
export interface MachineClaim {
	name: string;
	os: string;
	arch: string;
	runnerVersion: string;
	/** Platform-derived fingerprint of the pairing key, comparable with a runner that prints it. */
	keyFingerprint?: string;
	/** Whether this runner's version prints the key's fingerprint while it pairs. Older ones show only the code. */
	keyPrinted?: boolean;
}
