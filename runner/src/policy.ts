import type { StoreLimits } from "../../server/src/sandbox/store-limits.js";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import type { MachineSlotCapacity } from "../../server/src/contract.js";
import type { Args } from "../../server/src/runner/protocol.js";
import {
	LABEL,
	LABEL_ARG,
	MACHINE_LABEL,
	NO_LOGS,
	createVolume,
	docker,
	removeVolume,
	runHelper,
	tmpName,
} from "../../server/src/sandbox/docker.js";
import { DOCKER_BWRAP_PROBE, PROFILE_RUN_FLAGS } from "../../server/src/sandbox/docker-flags.js";
import { COMMON_RUN_FLAGS } from "../../server/src/sandbox/profiles.js";
import { safeSentence } from "./audit.js";
import type { Report } from "../../server/src/runner/control.js";
import { DATA_DIR, type Answer } from "../../server/src/sandbox/provider.js";
import { Refusal, RunnerError, type Identity } from "./state.js";

declare const SANDBOX_IMAGE: string;
declare const SHOTS_IMAGE_PIN: string;
declare const HARNESS_IMAGES: Partial<Record<MachineHarness, string>>;
export type MachineHarness = NonNullable<Args<"create">["harness"]>;
export const harnessImage = (id: MachineHarness) => HARNESS_IMAGES[id];
export const shotsImage = SHOTS_IMAGE_PIN;
export const image = SANDBOX_IMAGE;
export const imagePins = () => ({ sandbox: image, "sandbox-shots": shotsImage, ...HARNESS_IMAGES });
export const bubblewrap = "docker-windlass-sandbox";
/** On a volume that is one sandbox's own data volume: its raw id. */
export const SANDBOX_LABEL = LABEL + ".sandbox";
export type Profile = Args<"create">["profile"];

// The machine belongs to its owner, so the platform sets no default sandbox limits.
/** `store`: the snapshot and Git mirror limits its owner set (`--snapshot-disk`, `--snapshot-user`, `--keep-free`); the defaults when left out. */
export type Limits = {
	sandboxMemory?: number;
	spares?: number;
	slots?: MachineSlotCapacity | null;
	maxTurns?: number;
	maxRunning?: number;
	maxSandboxes?: number;
	store?: StoreLimits;
};
// The Docker name distinguishes Claude containers. The platform keeps the original sandbox id across upgrades.
export const externalId = (machine: string, raw: string) =>
	`m${machine}-${raw.replace(/^(?:claude|opencode|codex)-/, "")}`;
export function rawId(machine: string, id: string) {
	const prefix = externalId(machine, "");
	const raw = id.slice(prefix.length);
	if (!id.startsWith(prefix) || !/^[a-f0-9]{12}$/.test(raw))
		throw new Refusal("This sandbox id does not belong to this machine.");
	return raw;
}

/** Docker exec also exits non-zero when it never started the command in the container. */
export async function checkBubblewrap(
	exec: (timeoutMs: number) => Promise<Answer | null>,
	signal?: AbortSignal,
): Promise<Report["commandSandbox"]> {
	let detail = "";
	for (const [attempt, timeoutMs] of [20_000, 30_000, 45_000].entries()) {
		if (attempt) await delay(attempt * 500, undefined, { signal });
		signal?.throwIfAborted();
		const result = await exec(timeoutMs).catch(() => null);
		if (result?.code === 0) return { ok: true };
		const stderr = result?.stderr.trim() ?? "";
		if (result && result.code !== null && /^bwrap:\s*\S/m.test(stderr)) {
			return {
				ok: false,
				reason: safeSentence("Bubblewrap could not start in the new sandbox. " + stderr).slice(0, 500),
			};
		}
		detail = !result
			? "Docker exec could not be started."
			: result.code === null
				? "Docker exec timed out or was interrupted."
				: stderr || result.stdout.trim() || `Docker exec exited with code ${result.code} without a diagnostic.`;
	}
	throw new RunnerError(
		safeSentence("Docker could not complete the Bubblewrap probe after 3 attempts. " + detail).slice(0, 500),
	);
}

function imageRole(pin: string) {
	if (pin === image) return "sandbox";
	if (pin === shotsImage) return "screenshots";
	if (pin === harnessImage("claude")) return "Claude Code";
	if (pin === harnessImage("codex")) return "Codex";
	return "OpenCode";
}

async function pullImage(pin: string, platform: string, progress: boolean) {
	const child = spawn("docker", ["pull", "--platform", platform, pin], {
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30 * 60_000,
		killSignal: "SIGKILL",
	});
	let diagnostic = "";
	for (const output of [child.stdout, child.stderr]) {
		output.on("data", (chunk: Buffer) => {
			diagnostic = (diagnostic + chunk.toString()).slice(-8192);
			if (progress) process.stderr.write(chunk);
		});
	}
	const code = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	if (code === 0) return true;
	if (
		/no matching manifest|no match for platform|does not match the specified platform|does not provide the specified platform/i.test(
			diagnostic,
		)
	)
		throw new RunnerError(`This runner release has no ${platform} images (${imageRole(pin)}).`);
	throw new RunnerError(`The pinned ${imageRole(pin)} image is missing and could not be pulled.`);
}

async function daemonPlatform() {
	const result = await docker(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"], { timeoutMs: 10_000 });
	const platform = result.stdout.trim();
	if (result.code !== 0 || !/^linux\/[a-z0-9_]+$/.test(platform))
		throw new RunnerError("Could not determine the Linux Docker daemon architecture.");
	return platform;
}

/** True when the image was pulled. */
async function fetchImage(
	pin: string,
	mode: "setup" | "run" | "session" = "session",
	platform?: string,
): Promise<boolean> {
	const cached = await docker(["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", pin]);
	if (!pin.includes("@")) {
		if (cached.code !== 0)
			throw new RunnerError(`The pinned ${imageRole(pin)} image is missing and could not be pulled.`);
		return false;
	}
	platform ??= await daemonPlatform();
	if (cached.code === 0 && cached.stdout.trim() === platform) return false;
	if (mode !== "run") return pullImage(pin, platform, mode === "setup");
	// A service started without setup only needs the index to check compatibility.
	const manifest = await docker(["manifest", "inspect", pin], { timeoutMs: 30_000 });
	if (manifest.code !== 0) throw new RunnerError(`Could not inspect the pinned ${imageRole(pin)} image index.`);
	const entries: { platform?: { os: string; architecture: string } }[] | undefined = JSON.parse(
		manifest.stdout,
	).manifests;
	// A locally assembled runner can also refer directly to a single image manifest.
	if (!entries) return pullImage(pin, platform, false);
	if (!entries.some(entry => entry.platform && entry.platform.os + "/" + entry.platform.architecture === platform))
		throw new RunnerError(`This runner release has no ${platform} images (${imageRole(pin)}).`);
	return false;
}

export async function prepareImages(agents: MachineHarness[], screenshots: boolean, mode: "setup" | "run") {
	const pins = [image, ...agents.map(id => harnessImage(id)!), ...(screenshots ? [shotsImage] : [])];
	const platform = pins.some(pin => pin.includes("@")) ? await daemonPlatform() : undefined;
	for (const pin of new Set(pins)) {
		if (mode === "setup" || pin.includes("@")) await fetchImage(pin, mode, platform);
	}
}

export class MachineDocker {
	readonly labels: Record<string, string>;
	readonly volume: string;
	readonly claudeVolume: string;
	readonly opencodeVolume: string;
	constructor(readonly identity: Identity) {
		this.labels = { [MACHINE_LABEL]: identity.machineId, [LABEL + ".uid"]: identity.uid };
		this.opencodeVolume = "wlp-harness-opencode-" + identity.machineId;
		this.claudeVolume = "wlp-harness-claude-" + identity.machineId;
		this.volume = "wlp-machine-" + identity.machineId;
		this.backupVolume = this.volume + "-backups";
	}
	/** The copies of its sessions' agent sessions (session-backups.ts): one volume, the pairing's. */
	readonly backupVolume: string;
	/** A hardened Windlass session's own data volume (SESSION_VOLUME_PROFILES), by its raw sandbox id. */
	sessionVolume(raw: string) {
		if (!/^[a-f0-9]{12}$/.test(raw)) throw new Refusal("This sandbox id does not belong to this machine.");
		return `${this.volume}-${raw}`;
	}
	/** `sandbox` (a raw id) labels the volume as that sandbox's own, and is required of one that exists. */
	async ownedVolume(create: boolean, name = this.volume, sandbox?: string) {
		const labels = sandbox === undefined ? this.labels : { ...this.labels, [SANDBOX_LABEL]: sandbox };
		const volumes = await docker(["volume", "ls", "-q", "--filter", "name=" + name], { check: true });
		if (!volumes.stdout.trim().split("\n").includes(name)) {
			if (!create) return false;
			await createVolume(name, labels);
		}
		const [v] = JSON.parse((await docker(["volume", "inspect", name], { check: true })).stdout);
		if (
			v.Driver !== "local" ||
			Object.keys(v.Options ?? {}).length ||
			v.Labels?.[LABEL] !== "1" ||
			Object.entries(labels).some(([k, value]) => v.Labels[k] !== value)
		)
			throw new Refusal("The data volume must be a plain local volume owned by this machine.");
		return true;
	}
	/** `sandbox`: the volume must be that sandbox's own (`ownedVolume`). */
	async dropVolume(name = this.volume, sandbox?: string) {
		if (await this.ownedVolume(false, name, sandbox)) await removeVolume(name);
	}
	get pairingLabelFlags() {
		return Object.entries(this.labels).flatMap(([k, v]) => ["--label", k + "=" + v]);
	}
	private flags(name: string, profile: Profile) {
		return [
			"--rm",
			"--name",
			name,
			"--label",
			LABEL_ARG,
			...this.pairingLabelFlags,
			"--pull",
			"never",
			...NO_LOGS,
			...COMMON_RUN_FLAGS,
			...PROFILE_RUN_FLAGS[profile]!,
		];
	}
	private helper(argv: string[], mount = false) {
		const name = tmpName();
		return runHelper(
			[
				...this.flags(name, "docker-hardened"),
				...(mount ? ["--mount", `type=volume,src=${this.volume},dst=/data,volume-nocopy`] : []),
			],
			name,
			argv,
			{ image },
		);
	}
	private preparing = new Map<string, Promise<boolean>>();
	ensureImage(pin = image) {
		const pending = this.preparing.get(pin);
		if (pending) return pending;
		const fetch = fetchImage(pin).finally(() => this.preparing.delete(pin));
		this.preparing.set(pin, fetch);
		return fetch;
	}
	async disk() {
		const result = await this.helper(["df", "-B1", "--output=avail", "/workspace"]);
		const bytes = Number(result.stdout.trim().split("\n")[1]);
		if (result.code !== 0 || !Number.isSafeInteger(bytes) || bytes < 0)
			throw new RunnerError("Could not measure free space on Docker's sandbox filesystem.");
		return bytes;
	}
	async probe() {
		// Test docker exec in the same mount namespace as a real sandbox. Running bwrap
		// as the image command can pass on a daemon where the create-time probe fails.
		const name = tmpName();
		const probeVolume = name + "-data";
		await this.ownedVolume(true, probeVolume);
		try {
			const started = await docker(
				["run", "-d", ...this.flags(name, bubblewrap), "-v", `${probeVolume}:${DATA_DIR}`, image, "sleep", "infinity"],
				{ timeoutMs: 30_000 },
			);
			if (started.code !== 0) throw new RunnerError("Docker could not start the Bubblewrap probe container.");
			return await checkBubblewrap(async timeoutMs => {
				const result = await docker(["exec", name, ...DOCKER_BWRAP_PROBE], { timeoutMs });
				return result.timedOut ? { ...result, code: null } : result;
			});
		} finally {
			await docker(["rm", "-f", name]);
			await this.dropVolume(probeVolume);
		}
	}
}
