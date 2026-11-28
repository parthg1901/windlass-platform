/** Docker runs each session in its own container. Stopping the client leaves guest processes alive, so signal and sweep by run tag. */
import { runCommand } from "./command.js";
import type { SnapshotSelection } from "./snapshot-key.js";
import { INIT_WORKSPACE } from "../github/git-flags.js";
import { gitMirrorMount, type MirrorStore, restoreGitMirror, saveSessionMirror } from "./git-mirrors.js";
import { attemptLabel, candidateLabel, variantLabel, DockerSnapshots, sourceFromLabels } from "./snapshots.js";
import { snapshotLimits, type StoreLimits } from "./store-limits.js";
import type { SnapshotSource } from "./snapshot-key.js";

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { sandboxSlots, type MachineSlotCapacity, type SandboxProfile, type SandboxProfileId } from "../contract.js";
import { CLAUDE, machineHarness } from "./harnesses.js";
import {
	type ConnectOptions,
	type CreateSandboxInput,
	type ExecOptions,
	type ExecResult,
	type ListedSandbox,
	type SandboxPrice,
	SandboxUserError,
	type Sandboxes,
} from "./api.js";
import {
	DATA_DIR,
	IMAGE,
	SHOTS_IMAGE,
	LABEL,
	LABEL_ARG,
	MACHINE_LABEL,
	NO_LOGS,
	WORKSPACE,
	docker,
	randomId,
} from "./docker.js";
import { PROFILE_RUN_FLAGS } from "./docker-flags.js";
import { codexDefaultMode } from "./codex-modes.js";
import { SESSION_VOLUME_PROFILES, commonRunFlags, resourceFlags, findProfile, profilesFor } from "./profiles.js";
import {
	type Answer,
	type InternalExecResult,
	GIT_USER_ENV,
	NAME,
	type ProcessEnd,
	RUN_TAG,
	SECRET_FILE_SCRIPT,
	SWEEP_SCRIPT,
	type SandboxProcess,
	type StartOptions,
	type TurnSandbox,
	assertEnvNames,
	gitProcess,
	signalGitProcess,
	markTurnSandbox,
} from "./provider.js";
import { TOKEN_FILE_PREFIX, tokenFilePath } from "./token-file.js";
import { type DockerModelRelay, MODEL_RELAY_WINDLASS } from "./model-relay.js";
import { readsModelRelay } from "../model-relay-url.js";
import { probeImage } from "./tokens.js";
import { sleep } from "../util.js";

const SANDBOX_ID = /^(?:(?:claude|opencode|codex)-)?[a-f0-9]{12}$/;

export const containerName = (id: string) => `wlp-session-${id}`;

// Alias secret names before launching Docker: a runner must not let a remote name configure its local client.
const SECRET_ALIAS = "WLP_SECRET_";

/** Restore validated names only inside the guest, then exec the program without the aliases. */
function secretNamesScript(names: string[]): string {
	const assign = names.map((name, n) => `${name}="$${SECRET_ALIAS}${n}"`).join(" ");
	const aliases = names.map((_, n) => `${SECRET_ALIAS}${n}`).join(" ");
	return `export ${assign}; unset ${aliases}; exec "$@"`;
}

function assertUid(uid: string): void {
	if (!NAME.test(uid)) throw new Error("invalid user id");
}

export type { InternalExecResult, ProcessEnd, SandboxProcess, StartOptions } from "./provider.js";

/** A started program of this provider's: a runner stops reading its output while its session's window is full. */
export interface DockerProcess extends SandboxProcess {
	/** Stops reading the program's output (true), or reads on (false). Unread output fills the pipe, and the program's writes wait. */
	pauseOutput(paused: boolean): void;
}

/**
 * Starts a stopped sandbox container. Docker resolves a mirror's volume-subpath again here.
 * Should its slot be gone, an empty one is put back (the clone treats that as no mirror) and
 * the start is tried once more. The common start pays for nothing extra.
 */
export async function startContainer(name: string, helperImage: string, store?: MirrorStore): Promise<void> {
	let started = await docker(["start", name], { timeoutMs: 60_000 });
	if (started.code !== 0 && (await restoreGitMirror(name, helperImage, store).catch(() => false)))
		started = await docker(["start", name], { timeoutMs: 60_000 });
	if (started.code !== 0) throw new Error(`could not start the sandbox: ${started.stderr.trim()}`);
}

export class DockerSandboxHandle implements TurnSandbox {
	readonly cwd = WORKSPACE;
	constructor(
		readonly id: string,
		readonly profile: SandboxProfileId,
		/** The user whose data volume the container mounts, from the container's label. */
		readonly uid: string,
		readonly snapshot?: SnapshotSource,
		readonly resizePending = false,
		/** Runs the Git mirror save helper (`DockerSandboxOptions.helperImage`). */
		readonly helperImage = IMAGE,
		/** Its data directory is a volume of its own (`SandboxHandle.ownData`). */
		readonly ownData = false,
		/** The model relay of this provider (docs/model-relay.md), for key- and plan-paid turns; none: they cannot run here. */
		relay?: DockerModelRelay,
		/** The free bytes below which a mirror save writes nothing (`StoreLimits.free`); the default limits' when left out. */
		private readonly mirrorFloor?: () => number,
		/** The image the container was made from (`SandboxHandle.image`). */
		readonly image?: string,
		session?: string,
	) {
		markTurnSandbox(this);
		// The user names the lease in the relay, whose ceiling per user counts by it.
		if (relay) {
			this.modelKeyRelay = (sessionId, key, signal, takeRequest) => {
				if (sessionId !== session) throw new Error("This model relay belongs to another session.");
				return relay.openKey(this.container, this.id, this.uid, sessionId, key, signal, takeRequest);
			};
		}
	}

	readonly modelKeyRelay?: TurnSandbox["modelKeyRelay"];

	get approval(): "auto" | "full" {
		return findProfile(this.profile).approval;
	}

	get container(): string {
		return containerName(this.id);
	}

	saveMirror(stage: string, partial: boolean): Promise<boolean> {
		return saveSessionMirror(this.container, stage, partial, { image: this.helperImage, floor: this.mirrorFloor?.() });
	}

	run(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		return this.exec(["bash", "-c", command], options);
	}

	/**
	 * Starts argv (no shell) under wlp-run and leaves its standard input open. `tag` is the run's tag
	 * when the caller has named it already (a runner is given the server's); otherwise one is made.
	 */
	start(argv: string[], options: StartOptions = {}, tag = `r${randomId(6)}`): DockerProcess {
		if (!RUN_TAG.test(tag)) throw new Error("invalid run tag");
		assertEnvNames(options.env);
		assertEnvNames(options.secretEnv);
		const env = Object.entries(options.gitUser ? GIT_USER_ENV : (options.env ?? {})).flatMap(([key, value]) => [
			"-e",
			`${key}=${value}`,
		]);
		const secret = Object.entries(options.gitUser ? {} : (options.secretEnv ?? {})).filter(
			([key]) => options.env?.[key] === undefined,
		);
		for (const [key] of secret)
			if (key.startsWith(SECRET_ALIAS))
				throw new Error(`the variable ${key} cannot be handed to a program in the sandbox: its name is the platform's`);
		// Named only, by alias: the client takes each value from its own environment, which is this process's with the aliases added.
		// Values stay off the client command line, but the daemon receives them, and its debug request logging can record them.
		const aliases = secret.map(([, value], n) => [`${SECRET_ALIAS}${n}`, value] as const);
		const names = secret.length === 0 ? [] : ["sh", "-c", secretNamesScript(secret.map(([key]) => key)), "sh"];
		const user = options.gitUser ? ["--user", "65534:65534"] : [];
		const program = options.gitUser ? gitProcess(tag, argv) : ["wlp-run", "exec", tag, ...argv];
		const args = [
			"exec",
			...user,
			"-i",
			"-w",
			options.gitUser ? "/" : (options.cwd ?? this.cwd),
			...env,
			...aliases.flatMap(([alias]) => ["-e", alias]),
			this.container,
			...names,
			...program,
		];
		const child = spawn("docker", args, {
			stdio: ["pipe", "pipe", "pipe"],
			...(secret.length === 0 ? {} : { env: { ...process.env, ...Object.fromEntries(aliases) } }),
		});
		const out = new StringDecoder("utf8");
		const err = new StringDecoder("utf8");
		let hasEnded = false;
		let stdinOpen = true;
		const emit = (handler: ((chunk: string) => void) | undefined, text: string) => {
			if (text === "" || handler === undefined) return;
			try {
				handler(text);
			} catch {
				// A listener's failure must not stop the program's output from being read.
			}
		};
		child.stdout.on("data", (chunk: Buffer) => emit(options.onStdout, out.write(chunk)));
		child.stderr.on("data", (chunk: Buffer) => emit(options.onStderr, err.write(chunk)));
		child.stdin.on("error", () => (stdinOpen = false));
		child.stdin.on("close", () => (stdinOpen = false));
		const ended = new Promise<ProcessEnd>(resolve => {
			let failure: Error | null = null;
			const finish = (code: number | null, signal: string | null) => {
				if (hasEnded) return;
				emit(options.onStdout, out.end());
				emit(options.onStderr, err.end());
				hasEnded = true;
				stdinOpen = false;
				resolve({ code, signal, error: failure });
			};
			child.on("error", error => {
				failure = new Error(`could not run docker exec: ${error.message}`);
				// Without a process there is no "close" to wait for.
				if (child.pid === undefined) finish(null, null);
			});
			child.on("close", (code, signal) => finish(code, signal));
		});
		return {
			tag,
			pauseOutput: paused => {
				for (const pipe of [child.stdout, child.stderr]) {
					if (paused) pipe.pause();
					else pipe.resume();
				}
			},
			write: text => {
				if (!stdinOpen) return false;
				child.stdin.write(text);
				return true;
			},
			closeStdin: () => {
				if (!stdinOpen) return;
				stdinOpen = false;
				child.stdin.end();
			},
			ended,
			get hasEnded() {
				return hasEnded;
			},
			signal: async (sig, who) => {
				const command = options.gitUser ? signalGitProcess(tag, sig) : ["wlp-run", "signal", tag, sig, who];
				await docker(["exec", ...user, this.container, ...command], { timeoutMs: 10_000 }).catch(() => undefined);
			},
			killClient: () => {
				child.kill("SIGKILL");
			},
		};
	}

	/** Runs argv directly with `docker exec`: no shell, no standard input, not under wlp-run. Null when `docker` could not be run. */
	async ask(
		argv: string[],
		options: { env?: Record<string, string>; timeoutMs?: number } = {},
	): Promise<Answer | null> {
		const env = Object.entries(options.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
		const result = await docker(["exec", ...env, this.container, ...argv], { timeoutMs: options.timeoutMs }).catch(
			() => null,
		);
		return result === null
			? null
			: { code: result.timedOut ? null : result.code, stdout: result.stdout, stderr: result.stderr };
	}

	/** A container runs until it is stopped: there is nothing to keep alive for a turn. */
	async holdForTurn(): Promise<() => Promise<void>> {
		return async () => {};
	}

	exec(argv: string[], options: ExecOptions = {}): Promise<InternalExecResult> {
		return runCommand(this, argv, options, "killed the local docker client");
	}

	/**
	 * Stops every run of `program` still going in the container (one whose `docker exec` client died with
	 * a server that stopped): SIGINT to its leader, then SIGKILL to all its processes after 3 s. Returns
	 * how many runs were stopped.
	 */
	async stopLeftovers(program: string): Promise<number> {
		const found = await docker(["exec", this.container, "wlp-run", "tags-of", program], { timeoutMs: 10_000 });
		const tags = found.stdout.split("\n").filter(tag => /^[A-Za-z0-9_-]+$/.test(tag));
		await Promise.all(
			tags.map(async tag => {
				await docker(["exec", this.container, "wlp-run", "signal", tag, "INT", "leader"], { timeoutMs: 10_000 });
				await this.sweep(tag, { waitMs: 3000 });
			}),
		);
		return tags.length;
	}

	/**
	 * Makes sure nothing of a run is left: waits up to `waitMs` for the processes that carry `tag` to go,
	 * kills what is left, and removes `files`. Returns how many processes were still there after that.
	 */
	async sweep(tag: string, options: { waitMs?: number; files?: string[] } = {}): Promise<number> {
		if (!RUN_TAG.test(tag)) throw new Error("invalid run tag");
		const list = async () => {
			const result = await docker(["exec", this.container, "wlp-run", "list", tag], { timeoutMs: 10_000 }).catch(
				() => null,
			);
			if (result === null || result.code !== 0) return 0; // the container is gone or stopped: nothing runs
			return result.stdout.split("\n").filter(line => line.trim() !== "").length;
		};
		const files = options.files ?? [];
		const waitMs = options.waitMs ?? 0;
		if (waitMs > 0 || files.length === 0) {
			const deadline = Date.now() + waitMs;
			let count = await list();
			while (count > 0 && Date.now() < deadline) {
				await sleep(150);
				count = await list();
			}
			if (count === 0 && files.length === 0) return 0;
		}
		// One call: SIGKILL to what is left, the files removed, and what still runs after that counted.
		const result = await docker(["exec", this.container, "sh", "-c", SWEEP_SCRIPT, "sh", tag, ...files], {
			timeoutMs: 15_000,
		}).catch(() => null);
		const left = result === null || result.code !== 0 ? 0 : Number(result.stdout.trim());
		return Number.isFinite(left) ? left : 0;
	}

	async readTextFile(path: string): Promise<string> {
		const result = await docker(["exec", "-w", this.cwd, this.container, "cat", "--", path], { timeoutMs: 60_000 });
		if (result.code !== 0) throw new Error(`cannot read ${path}: ${result.stderr.trim()}`);
		return result.stdout;
	}

	async writeTextFile(path: string, content: string): Promise<void> {
		const result = await docker(
			[
				"exec",
				"-i",
				"-w",
				this.cwd,
				this.container,
				"sh",
				"-c",
				'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"',
				"sh",
				path,
			],
			{
				stdin: content,
				timeoutMs: 60_000,
			},
		);
		if (result.code !== 0) throw new Error(`cannot write ${path}: ${result.stderr.trim()}`);
	}

	/**
	 * Writes a file that only its owner can read (0600), whole: the content goes to a file beside it
	 * (`<path>.tmp`), which is then renamed into place, so whoever reads `path` sees the old content or
	 * the new and never a part of either. The content is passed on standard input, never on a command
	 * line. One write of a path at a time.
	 */
	async writeSecretFile(path: string, content: string): Promise<void> {
		const result = await docker(["exec", "-i", this.container, "sh", "-c", SECRET_FILE_SCRIPT, "sh", path], {
			stdin: content,
			timeoutMs: 30_000,
		});
		// What `sh` says about a failure names the path, never the content.
		if (result.code !== 0)
			throw new Error(
				`cannot write ${path}: ${result.timedOut ? "timed out" : result.stderr.trim() || `exit ${result.code}`}`,
			);
	}

	/** Removes files. A no-op for those that are gone, and when the container is. */
	async removeFiles(paths: string[]): Promise<void> {
		if (paths.length === 0) return;
		await docker(["exec", this.container, "rm", "-f", "--", ...paths], { timeoutMs: 10_000 }).catch(() => undefined);
	}
}

interface Inspected {
	session?: string;
	screenshots: boolean;
	snapshot?: SnapshotSource;
	/** The Docker image id the container was made from. */
	image?: string;
	memory: number;
	resize?: MachineSlotCapacity["unit"];
	status: string;
	profile: SandboxProfileId;
	uid: string;
	/**
	 * It mounts its own data volume (`DockerSandboxOptions.ownVolumeName`) at the data directory, which
	 * goes with it. Read from its mounts, not a label: a snapshot commit would copy a label into the image
	 * (snapshots.ts allows none).
	 */
	ownData: boolean;
	/**
	 * A Windlass sandbox of SESSION_VOLUME_PROFILES that mounts another data volume there: the user's
	 * shared one, as before own volumes, or as a runner makes for a server that did not name
	 * `session-volumes`. Its commands can read the other sessions' data (`connect`).
	 */
	sharedData: boolean;
}

/** A sandbox's own data volume as `docker volume inspect` prints it. */
interface InspectedVolume {
	Name: string;
	CreatedAt?: string;
	Labels?: Record<string, string> | null;
}

/** On a volume that is one sandbox's own data volume: that sandbox's raw id. */
export const SANDBOX_VOLUME_LABEL = `${LABEL}.sandbox`;

function stateOf(status: string): "none" | "running" | "paused" {
	if (status === "running" || status === "restarting") return "running";
	if (status === "created" || status === "exited" || status === "paused") return "paused";
	return "none";
}

/** Clear the private file and any pre-upgrade copy on the data volume. */
async function forgetTokenFile(id: string): Promise<void> {
	const paths = [tokenFilePath(id), tokenFilePath(id, DATA_DIR)];
	await docker(["exec", containerName(id), "rm", "-f", "--", ...paths.flatMap(path => [path, path + ".tmp"])], {
		timeoutMs: 10_000,
	}).catch(() => undefined);
}

async function listDockerSandboxes(uid: string, machineLabel: string): Promise<ListedSandbox[]> {
	assertUid(uid);
	// Docker cannot filter by a label's absence: the hosted provider's are told apart below.
	const onMachine = machineLabel === "" ? [] : ["--filter", `label=${MACHINE_LABEL}=${machineLabel}`];
	const result = await docker(
		[
			"ps",
			"-a",
			"--no-trunc",
			"--filter",
			`label=${LABEL_ARG}`,
			"--filter",
			`label=${LABEL}.uid=${uid}`,
			...onMachine,
			"--format",
			`{{.Names}}|{{.State}}|{{.Label "${LABEL}.session"}}|{{.Label "${MACHINE_LABEL}"}}`,
		],
		{ timeoutMs: 30_000, check: true },
	);
	const found: ListedSandbox[] = [];
	for (const line of result.stdout.split("\n")) {
		const [name = "", status = "", sessionId = "", machine = ""] = line.trim().split("|");
		const id = name.startsWith("wlp-session-") ? name.slice("wlp-session-".length) : "";
		const state = stateOf(status);
		if (SANDBOX_ID.test(id) && state !== "none" && machine === machineLabel) found.push({ id, sessionId, state });
	}
	return found;
}

/** Remove each session's private file on logout, including containers with private transcript storage. */
export async function removeRunningTokenFiles(
	uid: string,
	machine: string,
	fileId = (raw: string) => raw,
): Promise<void> {
	const sessions = await listDockerSandboxes(uid, machine);
	await Promise.all(
		sessions
			.filter(session => session.state === "running" && /^[a-f0-9]{12}$/.test(session.id))
			.map(async ({ id }) => {
				const path = tokenFilePath(fileId(id));
				const result = await docker(["exec", containerName(id), "rm", "-f", "--", path, path + ".tmp"], {
					timeoutMs: 10_000,
				});
				// A concurrent stop or removal already discarded the tmpfs.
				if (result.code !== 0 && !/is not running|No such container/i.test(result.stderr))
					throw new Error("Could not remove the session's access token.");
			}),
	);
}

/** What the hosted provider and a runner's differ in. */
export type DockerSandboxOptions = {
	/** The snapshot store's deployment identity. Left out where snapshots were never on. */
	deployment?: string;
	/**
	 * The snapshot and Git mirror stores' limits (store-limits.ts), read at each use: the deployment's
	 * settings for the hosted provider, the owner's flags held to the platform's caps for a runner's.
	 * The default limits (`snapshotLimits`) when left out.
	 */
	storeLimits?: () => StoreLimits;
	/** Scopes Git mirror slots to this deployment, whether or not snapshots are on. */
	mirrorScope?: string;
	cpus?: number;
	slots?: MachineSlotCapacity;
	network?: { name: string; env: Record<string, string>; mode: string };
	/** The model relay (docs/model-relay.md) for this provider's key- and plan-paid turns; none: those turns cannot run here. */
	modelRelay?: DockerModelRelay;
	hostedKeys?: boolean;
	/** The Windlass version of the image, which decides whether `modelRelay` is used (0.7.1 or later): the one the layer's `windlass.problem()` reads. */
	modelRelayWindlass?: () => Promise<string | null>;
	/** The sandbox image; windlass-platform-sandbox:latest when left out. */
	image?: string;
	shotsImage?: string;
	/**
	 * Runs the Git mirror allocator and save helpers: the pinned base sandbox image, never a
	 * session's own (a harness image, or a snapshot committed after setup). `image` when left out.
	 */
	helperImage?: string;
	/**
	 * Null for the hosted provider. A runner's machine id: every container it makes carries it as
	 * MACHINE_LABEL, and each provider lists and acts on only the containers whose machine label is its
	 * own (none for the hosted one), so a runner and a hosted server on one Docker daemon never see each
	 * other's sandboxes.
	 */
	machine: string | null;
} & (
	| {
			/**
			 * Makes sure a data volume of `uid`'s exists and returns its name: the one volume a container
			 * mounts, at Windlass's data directory. Without `sandbox`, the volume the user's sessions share: the
			 * hosted provider's is `wlp-user-<uid>`, which it also takes old sign-ins out of (volumes.ts); a
			 * runner's is its own, so the two never share one. With `sandbox` (a raw id), the volume of that one
			 * sandbox (SESSION_VOLUME_PROFILES), labelled `${LABEL}.sandbox=<id>`.
			 */
			dataVolume(uid: string, sandbox?: string): Promise<string>;
			/** Removes the volume `dataVolume(uid, sandbox)` made, when it is there and its labels are that user's and sandbox's. */
			dropDataVolume(uid: string, sandbox: string): Promise<void>;
			/**
			 * The name of the volume `dataVolume(uid, sandbox)` makes for one sandbox. Where it is given, a new
			 * Windlass sandbox of SESSION_VOLUME_PROFILES gets a volume of its own unless `create` is told
			 * otherwise (a runner, for a server that did not name `session-volumes`), and the provider tells
			 * sandboxes and their volumes apart by it. Where it is not, every sandbox mounts `dataVolume(uid)`.
			 */
			ownVolumeName?(uid: string, sandbox: string): string;
			sessionRelay?: never;
			harness?: never;
	  }
	| {
			/** Runner-issued placeholder and immutable helper identity for a new Claude session. */
			machine: string;
			image: string;
			harness?: "claude" | "opencode" | "codex";
			sessionRelay(): Promise<{ env: string[]; nonce: string }>;
			ownVolumeName?: never;
	  }
);

export class DockerSandboxes implements Sandboxes {
	private readonly image: string;
	private readonly shotsImage: string;
	private readonly helperImage: string;
	private readonly machine: string;

	constructor(private readonly options: DockerSandboxOptions) {
		if (options.machine !== null && !NAME.test(options.machine)) throw new Error("invalid machine id");
		this.image = options.image ?? IMAGE;
		this.shotsImage = options.shotsImage ?? SHOTS_IMAGE;
		this.helperImage = options.helperImage ?? this.image;
		// A container without the label reads as "" (Go templates), which is the hosted provider's.
		this.machine = options.machine ?? "";
	}

	private resources(size: number) {
		const unit = this.options.slots?.unit ?? { cpus: this.options.cpus ?? 1, memoryBytes: 1536 * 2 ** 20, pids: 512 };
		return {
			cpus: (Math.round(unit.cpus * 1e9) * size) / 1e9,
			memoryBytes: unit.memoryBytes * size,
			pids: unit.pids * size,
		};
	}

	private async inspect(id: string): Promise<Inspected | null> {
		if (!SANDBOX_ID.test(id)) return null;
		// JSON has no raw newline in it, so each of the two takes a line of its own.
		const result = await docker([
			"container",
			"inspect",
			"--format",
			`{{.State.Status}}|{{.HostConfig.CpuShares}}|{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.PidsLimit}}|{{.Image}}\n{{json .Mounts}}\n{{json .Config.Labels}}`,
			containerName(id),
		]);
		if (result.code !== 0) return null;
		const [fields = "", mountsJson = "", labelsJson = ""] = result.stdout.trim().split("\n");
		const [status, shares, nanos, memory, swap, pids, image] = fields.split("|");
		let labels: Record<string, string> | null;
		let mounts: { Type?: string; Name?: string; Destination?: string }[] | null;
		try {
			labels = JSON.parse(labelsJson);
			mounts = JSON.parse(mountsJson);
		} catch {
			throw new Error(
				`docker container inspect returned missing or invalid labels or mounts JSON for ${containerName(id)}`,
			);
		}
		if (labels?.[LABEL] !== "1" || (labels[MACHINE_LABEL] ?? "") !== this.machine) return null;
		const label = labels[LABEL + ".requested-slots"] || labels[LABEL + ".slots"] || "1";
		const size = sandboxSlots(/^[1-4]$/.test(label) ? Number(label) : 1, this.options.slots?.max ?? 1);
		const unit = this.resources(size);
		const matches =
			shares === "256" &&
			Number(nanos) === Math.round(unit.cpus * 1e9) &&
			Number(memory) === unit.memoryBytes &&
			Number(swap) === unit.memoryBytes &&
			Number(pids) === unit.pids;
		const profile = labels[LABEL + ".profile"] as SandboxProfileId,
			uid = labels[LABEL + ".uid"];
		const data = (mounts ?? []).find(mount => mount.Destination === DATA_DIR);
		const windlass =
			!labels[LABEL + ".harness"] && this.options.sessionRelay === undefined && /^[a-f0-9]{12}$/.test(id);
		const ownName =
			windlass && this.options.ownVolumeName && NAME.test(uid ?? "") ? this.options.ownVolumeName(uid!, id) : undefined;
		const ownData = data?.Type === "volume" && ownName !== undefined && data.Name === ownName;
		return {
			status,
			profile,
			uid,
			session: labels[LABEL + ".session"],
			ownData,
			sharedData: ownName !== undefined && SESSION_VOLUME_PROFILES.includes(profile) && data !== undefined && !ownData,
			screenshots: labels[variantLabel] === "shots",
			snapshot: sourceFromLabels(labels),
			memory: Number(memory),
			image: /^sha256:[a-f0-9]{64}$/.test(image ?? "") ? image : undefined,
			resize: (this.options.slots || this.options.cpus !== undefined) && !matches ? unit : undefined,
		};
	}

	/** The data directory is a volume of the user's (wlp-user-<uid>): it outlives every sandbox. */
	readonly sessionsLiveInSandbox = false;
	/** Except where the profile gives each sandbox its own (SESSION_VOLUME_PROFILES), as the hosted provider's does. */
	async privateSessionData(profile: SandboxProfileId): Promise<boolean> {
		return this.options.ownVolumeName !== undefined && SESSION_VOLUME_PROFILES.includes(profile);
	}
	/** A container runs until it is stopped. */
	readonly idleStopMs = null;

	/** A container on the server's own machine is not billed by the second. */
	price(): SandboxPrice | null {
		return null;
	}

	/** The user's containers, by the labels each was made with. */
	async list(uid: string): Promise<ListedSandbox[]> {
		return listDockerSandboxes(uid, this.machine);
	}

	/** The users with hosted sandboxes on this Docker: a runner's, which carry a machine label, are not this layer's. */
	async owners(): Promise<string[]> {
		if (this.machine !== "") return [];
		const result = await docker(
			[
				"ps",
				"-a",
				"--no-trunc",
				"--filter",
				`label=${LABEL_ARG}`,
				"--format",
				`{{.Names}}|{{.Label "${LABEL}.uid"}}|{{.Label "${MACHINE_LABEL}"}}`,
			],
			{ timeoutMs: 30_000, check: true },
		);
		const uids = new Set<string>();
		for (const line of result.stdout.split("\n")) {
			const [name = "", uid = "", machine = ""] = line.trim().split("|");
			if (name.startsWith("wlp-session-") && machine === "" && NAME.test(uid)) uids.add(uid);
		}
		return [...uids];
	}

	profiles(): SandboxProfile[] {
		return profilesFor("docker", undefined, this.relayOn === true).map(p =>
			this.options.hostedKeys && p.id === "docker-hardened" ? { ...p, platformKeys: true } : p,
		);
	}

	/** Whether the image's Windlass reads the relay's address, once known (`modelRelayReady`). */
	private relayOn: boolean | null = null;

	/**
	 * Whether this provider's Windlass sandboxes use the model relay: it has one, and the image's Windlass is
	 * 0.7.1 or later, which routes every provider through WINDLASS_MODEL_BASE_URL. Retry an unreadable version.
	 */
	async modelRelayReady(): Promise<boolean> {
		if (this.options.modelRelay === undefined) return false;
		if (this.relayOn !== null) return this.relayOn;
		const version = await (this.options.modelRelayWindlass ?? (() => probeImage(this.image)))().catch(() => null);
		if (version === null) return false;
		this.relayOn = readsModelRelay(version);
		return this.relayOn;
	}

	async prepareModelRelay(): Promise<string> {
		const relay = this.options.modelRelay;
		if (relay === undefined)
			return "[wlp] model_relay: off (WLP_MODEL_RELAY=off): hosted turns on a Settings key or a plan cannot run";
		const on = await this.modelRelayReady();
		const removed = await relay.sweep().catch(() => 0);
		const left = removed ? `; removed ${removed} forwarder(s) and the relay's token files a stopped server left` : "";
		return on
			? `[wlp] model_relay: key- and plan-paid model requests go through the relay container ${relay.relayName} to the platform relay; sandboxes never hold a credential${left}`
			: `[wlp] model_relay: off (the image's Windlass is not ${MODEL_RELAY_WINDLASS} or later, or could not be read): hosted Windlass turns on a Settings key or a plan cannot run${left}`;
	}

	profile(id: SandboxProfileId): SandboxProfile {
		const profile = findProfile(id);
		return { ...profile, layers: [...profile.layers] };
	}

	/**
	 * `ownData` false: a sandbox of SESSION_VOLUME_PROFILES mounts the user's shared volume all the same,
	 * as a runner makes them for a server that did not name `session-volumes`, which would not know that
	 * the data went with the sandbox. Left out: it gets one of its own where the provider makes them
	 * (`DockerSandboxOptions.ownVolumeName`).
	 */
	async create(
		input: CreateSandboxInput & { ownData?: boolean | "required"; reservedId?: string; deferredRelayNonce?: string },
	): Promise<string> {
		assertUid(input.uid);
		const harness = this.options.sessionRelay
			? (this.options.harness ?? "claude")
			: this.options.machine === null
				? input.harness
				: undefined;
		const agent = machineHarness(input.harness ?? harness) ?? CLAUDE;
		if (harness !== input.harness) throw new SandboxUserError(`${agent.name} runs only on a machine offering it.`);
		if (harness && this.options.machine === null && !this.options.hostedKeys)
			throw new SandboxUserError("Hosted agents need a configured platform model relay.");
		const supported =
			this.options.machine === null ? input.profile === "docker-hardened" : agent.profiles.includes(input.profile);
		if (harness && (!supported || input.screenshots))
			throw new SandboxUserError(`${agent.name} requires the hardened ${agent.name} image.`);
		const base =
			harness && this.options.machine === null
				? process.env[`WLP_${harness.toUpperCase()}_IMAGE`] || `windlass-platform-${harness}:dev`
				: input.screenshots
					? this.shotsImage
					: this.image;
		const selected =
			input.fromSnapshot && !harness
				? await this.snapshots(base, !!input.screenshots)
						.select(input.fromSnapshot, input.uid, input.profile)
						.catch(() => null)
				: null;
		const image = selected?.image ?? base;
		const profile = findProfile(input.profile);
		const flags = PROFILE_RUN_FLAGS[input.profile];
		if (!profile.available || flags === undefined)
			throw new SandboxUserError(
				`The sandbox "${profile.name}" is not available: ${profile.unavailableReason ?? "not supported here"}`,
			);
		// Older runners adopt only wlp-session-<12 hex>. Keep Claude sessions outside that namespace from creation.
		if (input.reservedId && !/^[a-f0-9]{12}$/.test(input.reservedId)) throw new Error("Invalid reserved sandbox id.");
		const id = (harness ? harness + "-" : "") + (input.reservedId ?? randomId(6));
		const name = containerName(id);
		// The reviewer cannot share transcripts or project-wide MCP approvals with the user's other sessions.
		// A session whose commands run directly in the container gets a volume of its own.
		// A spare runs repository setup before claim. Even a bubblewrap spare must never mount the shared data.
		const own =
			!harness &&
			!input.privateData &&
			this.options.ownVolumeName !== undefined &&
			(input.ownData === "required" || (SESSION_VOLUME_PROFILES.includes(input.profile) && input.ownData !== false));
		if (input.ownData === "required" && !own) throw new Error("The sandbox requires a private data volume.");
		const volume =
			input.privateData || harness || this.options.sessionRelay
				? null
				: await this.options.dataVolume(input.uid, own ? id : undefined);
		const scope = this.mirrorScope;
		const mirror =
			input.mirrorRepo && scope
				? await gitMirrorMount(this.helperImage, scope, this.machine, input.uid, input.mirrorRepo, {
						floor: this.limits().free,
					}).catch(() => null)
				: null;
		// An idle harness has only its public routing nonce. The runner signs it and
		// opens its forwarder once a session has claimed this container.
		const relay =
			harness && input.deferredRelayNonce
				? { nonce: input.deferredRelayNonce, env: [] }
				: await this.options.sessionRelay?.();
		const requested = sandboxSlots(input.size ?? 1, 4);
		const size = Math.min(requested, this.options.slots?.max ?? 1);
		const limits = this.resources(size);
		const result = await docker(
			[
				"run",
				"-d",
				"--pull",
				"never",
				"--name",
				name,
				"--label",
				LABEL_ARG,
				"--label",
				`${LABEL}.uid=${input.uid}`,
				"--label",
				`${LABEL}.session=${input.sessionId.slice(0, 200)}`,
				"--label",
				`${LABEL}.profile=${input.profile}`,
				...(this.machine === "" ? [] : ["--label", `${MACHINE_LABEL}=${this.machine}`]),
				...(selected && input.fromSnapshot
					? [
							"--label",
							candidateLabel + "=" + (input.fromSnapshot.writer ? selected.key : ""),
							"--label",
							variantLabel + "=" + (input.screenshots ? "shots" : "base"),
							"--label",
							attemptLabel + "=" + input.fromSnapshot.attempt,
						]
					: []),
				...(this.options.slots ? ["--label", `${LABEL}.slots=${size}`] : []),
				...(this.options.slots && requested > size ? ["--label", `${LABEL}.requested-slots=${requested}`] : []),
				...NO_LOGS,
				...commonRunFlags(limits.cpus, this.options.network?.name, limits.memoryBytes, limits.pids),
				...(this.options.network
					? [
							"--label",
							`${LABEL}.egress=${this.options.network.mode}`,
							...Object.entries(this.options.network.env).flatMap(([k, v]) => ["-e", k + "=" + v]),
						]
					: []),
				...flags,
				// Windlass reads its handed-in token in this container's /dev/shm.
				...(!harness ? ["--ipc", "private"] : []),
				...(harness ? ["--label", `${LABEL}.harness=${harness}`] : []),
				...(relay ? ["--label", `${LABEL}.relay-session=${relay.nonce}`, ...relay.env] : []),
				// The Codex image starts in Container access; on the Windlass sandbox profile it starts inside its own sandbox.
				...(harness === "codex" ? ["-e", "INITIAL_AGENT_MODE=" + codexDefaultMode(input.profile)] : []),
				...(mirror ? ["--mount", mirror] : []),
				...(volume ? ["-v", `${volume}:${DATA_DIR}`] : []),
				image,
			],
			{ timeoutMs: 120_000 },
		);
		if (result.code !== 0) {
			// A conflict belongs to the container that already held the name.
			if (/container name .*already in use/i.test(result.stderr))
				throw new Error("The sandbox name was already in use.");
			await docker(["rm", "-f", name]);
			// The error said below is the one that matters: a volume left behind goes with the next sweep.
			if (own) await this.dropOwnVolume(input.uid, id).catch(() => {});
			const message = result.stderr.trim();
			// Eviction can race docker run. Older daemons also lack volume-subpath.
			if (mirror && /mount|subpath|sub-path|volume|no such file/i.test(message))
				return this.create({ ...input, mirrorRepo: undefined });
			if (selected && /No such image|not found/i.test(message))
				return this.create({ ...input, fromSnapshot: undefined });
			if (harness && /No such image|pull access denied|not found/i.test(message))
				throw new Error(
					`Missing harness image ${image}. Build it with sandbox/harness/build.sh ${harness} or preload the configured image.`,
				);
			if (/No such image|pull access denied|not found/i.test(message))
				throw new Error(
					`the sandbox image ${image} is missing; run ${input.screenshots ? "WLP_SANDBOX_VARIANT=shots " : ""}sandbox/build.sh (${message})`,
				);
			throw new Error(`could not create the sandbox: ${message}`);
		}
		if (selected?.hit) return id;
		const init = await docker(["exec", "-w", WORKSPACE, name, "sh", "-c", INIT_WORKSPACE], { timeoutMs: 60_000 });
		if (init.code !== 0) {
			await docker(["rm", "-f", name]);
			if (own) await this.dropOwnVolume(input.uid, id).catch(() => {});
			throw new Error(`could not set up the workspace: ${init.stderr.trim()}`);
		}
		return id;
	}

	private async dropOwnVolume(uid: string, id: string) {
		if (this.options.sessionRelay === undefined) await this.options.dropDataVolume(uid, id);
	}

	/**
	 * The sandboxes' own data volumes of this provider: labelled with a sandbox, with its machine (none
	 * for the hosted provider) and with `match`, and named as `ownVolumeName` names that sandbox's.
	 * `sandbox` narrows them to one sandbox's.
	 */
	private async ownVolumes(
		match: Record<string, string>,
		sandbox?: string,
	): Promise<(InspectedVolume & { uid: string; sandbox: string })[]> {
		const nameOf = this.options.sessionRelay === undefined ? this.options.ownVolumeName : undefined;
		if (!nameOf) return [];
		const filters = [
			LABEL_ARG,
			sandbox === undefined ? SANDBOX_VOLUME_LABEL : `${SANDBOX_VOLUME_LABEL}=${sandbox}`,
			...(this.machine ? [`${MACHINE_LABEL}=${this.machine}`] : []),
			...Object.entries(match).map(([k, v]) => `${k}=${v}`),
		].flatMap(label => ["--filter", "label=" + label]);
		const names = (await docker(["volume", "ls", "-q", ...filters], { timeoutMs: 30_000, check: true })).stdout
			.split("\n")
			.map(line => line.trim())
			.filter(Boolean);
		if (names.length === 0) return [];
		// One removed in between is left out of the answer, which is then not 0.
		const inspected = await docker(["volume", "inspect", ...names], { timeoutMs: 30_000 });
		let volumes: InspectedVolume[];
		try {
			volumes = JSON.parse(inspected.stdout || "[]");
		} catch {
			return [];
		}
		const found: (InspectedVolume & { uid: string; sandbox: string })[] = [];
		for (const volume of volumes) {
			const labels = volume.Labels ?? {};
			const uid = labels[`${LABEL}.uid`] ?? "",
				id = labels[SANDBOX_VOLUME_LABEL] ?? "";
			if (
				labels[LABEL] !== "1" ||
				(labels[MACHINE_LABEL] ?? "") !== this.machine ||
				!NAME.test(uid) ||
				!/^[a-f0-9]{12}$/.test(id)
			)
				continue;
			let expected: string;
			try {
				expected = nameOf(uid, id);
			} catch {
				continue;
			}
			if (volume.Name === expected) found.push({ ...volume, uid, sandbox: id });
		}
		return found;
	}

	/**
	 * Removes the own data volumes of this provider's sandboxes (and, on a runner, of `match`, its pairing)
	 * whose container is gone and that are older than `minAgeMs`: younger, one may be a create's that has
	 * not reached `docker run` yet. Docker also refuses to remove a volume a container still mounts.
	 */
	async sweepDataVolumes(minAgeMs = 10 * 60_000, match: Record<string, string> = {}): Promise<number> {
		const volumes = await this.ownVolumes(match);
		if (volumes.length === 0) return 0;
		const containers = new Set(
			(await docker(["ps", "-a", "--no-trunc", "--format", "{{.Names}}"], { timeoutMs: 30_000, check: true })).stdout
				.split("\n")
				.map(line => line.trim()),
		);
		let removed = 0;
		for (const volume of volumes) {
			const created = Date.parse(volume.CreatedAt ?? "");
			if (containers.has(containerName(volume.sandbox)) || !Number.isFinite(created) || Date.now() - created < minAgeMs)
				continue;
			try {
				await this.dropOwnVolume(volume.uid, volume.sandbox);
				removed += 1;
				console.log(`[wlp] sandbox.volume_swept volume=${volume.Name}`);
			} catch {
				// In use after all, or removed meanwhile: the next sweep sees.
			}
		}
		return removed;
	}

	private readonly limits = () => this.options.storeLimits?.() ?? snapshotLimits;

	private get mirrorScope() {
		return this.options.mirrorScope ?? this.options.deployment ?? this.machine;
	}

	private snapshots(base = this.image, screenshots = false) {
		return new DockerSnapshots(
			this.machine,
			base,
			this.options.network,
			this.limits,
			screenshots,
			this.options.deployment,
			this.mirrorScope,
		);
	}

	async hasSnapshot(uid: string, repo: string) {
		return this.snapshots().has(uid, repo);
	}

	async selectedImage(input: SnapshotSelection, uid: string, profile: SandboxProfileId, shots: boolean) {
		const selection = await this.snapshots(shots ? this.shotsImage : this.image, shots).select(input, uid, profile);
		return selection.hit ? selection.image : null;
	}

	async saveSnapshot(id: string, source: SnapshotSource) {
		const found = await this.inspect(id);
		if (!found || found.snapshot || this.options.sessionRelay) return false;
		const name = containerName(id);
		// Re-resolve the selected pin: a mutable tag may have moved during setup.
		const base = found.screenshots ? this.shotsImage : this.image;
		return this.snapshots(base, found.screenshots).save(name, found.uid, found.profile, source);
	}

	async sweepSnapshots(retained: (uid: string) => Promise<ReadonlySet<string> | null>) {
		if (this.machine || this.options.deployment) await this.snapshots().sweepOwners(retained);
	}

	async dropSnapshots(uid: string, repo?: string) {
		if (this.machine || this.options.deployment) await this.snapshots().drop(uid, repo);
	}

	private async reconcile(name: string, found: Inspected) {
		if (!found.resize) return false;
		const { cpus, memoryBytes, pids } = found.resize;
		const shrinking =
			(found.memory === 0 || memoryBytes < found.memory) && ["running", "paused", "restarting"].includes(found.status);
		if (shrinking && found.status === "restarting") return true;
		// cgroup v2 can accept a shrink and OOM-kill the workload. Freeze it while
		// measuring and applying the limit. A stopped sandbox needs no usage check.
		const freeze = shrinking && found.status === "running";
		if (freeze) await docker(["pause", name], { check: true });
		try {
			if (shrinking) {
				const stats = await docker(["system", "dial-stdio"], {
					timeoutMs: 10_000,
					stdin: `GET /containers/${name}/stats?stream=false&one-shot=true HTTP/1.0\r\nHost: docker\r\nConnection: close\r\n\r\n`,
				});
				if (stats.code !== 0 || !/^HTTP\/1\.[01] 200 /.test(stats.stdout)) return true;
				let used: number;
				try {
					used = JSON.parse(stats.stdout.split("\r\n\r\n")[1]).memory_stats.usage;
				} catch {
					return true;
				}
				if (!Number.isSafeInteger(used) || used <= 0 || used >= memoryBytes) return true;
			}
			const result = await docker(["update", ...resourceFlags(cpus, memoryBytes, pids), name]);
			if (result.code === 0) return false;
			if (shrinking && /current (?:memory )?usage|memory usage|device or resource busy/i.test(result.stderr))
				return true;
			throw new Error("Could not update the sandbox limits: " + result.stderr.trim());
		} finally {
			if (freeze) await docker(["unpause", name], { check: true });
		}
	}

	/**
	 * `ownData` false: a sandbox that mounts the user's shared volume (`Inspected.sharedData`) is one a
	 * runner made for a server that did not name `session-volumes`, and is kept (see `create`).
	 */
	async connect(id: string, options: ConnectOptions = {}): Promise<DockerSandboxHandle | undefined> {
		const found = await this.inspect(id);
		if (found === null || stateOf(found.status) === "none") return undefined;
		if (found.sharedData && options.ownData !== false) {
			// Made before sandboxes of its profile had data of their own: its commands can read the user's other
			// sessions. It is removed, and the session goes on in a new sandbox as from one that was lost.
			console.log(`[wlp] sandbox.removed_shared_data id=${id}`);
			await this.destroy(id);
			return undefined;
		}
		const resizePending = await this.reconcile(containerName(id), found);
		if (found.status === "paused") await docker(["unpause", containerName(id)], { check: true });
		else if (found.status !== "running" && found.status !== "restarting") {
			await startContainer(containerName(id), this.helperImage);
		}
		// An interrupted pre-upgrade turn may have left a file on the shared volume. Clear
		// those before returning a handle that could run setup or commands against it.
		if (/^[a-f0-9]{12}$/.test(id)) {
			const legacy = `${DATA_DIR}/${TOKEN_FILE_PREFIX}*`;
			await docker(["exec", containerName(id), "/bin/sh", "-c", `/bin/rm -f -- ${legacy}.json ${legacy}.json.tmp`], {
				timeoutMs: 10_000,
				check: true,
			});
		}
		const windlass = /^[a-f0-9]{12}$/.test(id);
		const relayReady = windlass
			? this.options.sessionRelay === undefined && (await this.modelRelayReady())
			: this.options.hostedKeys;
		return new DockerSandboxHandle(
			id,
			found.profile,
			found.uid,
			found.snapshot,
			resizePending,
			this.helperImage,
			found.ownData,
			relayReady ? this.options.modelRelay : undefined,
			() => this.limits().free,
			found.image,
			found.session,
		);
	}

	async state(id: string): Promise<"none" | "running" | "paused"> {
		const found = await this.inspect(id);
		return found === null ? "none" : stateOf(found.status);
	}

	async suspend(id: string): Promise<void> {
		const found = await this.inspect(id);
		// Its lease ends too: the relay's file of its turn, and its forwarder.
		if (found !== null) await this.options.modelRelay?.endSandbox(id).catch(() => undefined);
		if (found === null || found.status !== "running") return;
		await forgetTokenFile(id);
		// SIGTERM to the container's init, SIGKILL after 5 s. A turn still running is cut off: stop it first.
		await docker(["stop", "-t", "5", containerName(id)], { timeoutMs: 60_000 });
	}

	async destroy(id: string): Promise<void> {
		const found = await this.inspect(id);
		if (found === null) {
			// The container is gone already (a removal cut off after it, or by the owner's hand): its own volume
			// is found by its labels. A namesake of someone else's is no sandbox of this provider's.
			if (
				/^[a-f0-9]{12}$/.test(id) &&
				(await docker(["container", "inspect", "--format", "{{.Id}}", containerName(id)])).code !== 0
			)
				for (const volume of await this.ownVolumes({}, id)) await this.dropOwnVolume(volume.uid, id);
			return;
		}
		if (found.status === "running") await forgetTokenFile(id);
		await this.options.modelRelay?.endSandbox(id).catch(() => undefined);
		await docker(["rm", "-f", "-v", containerName(id)], { timeoutMs: 60_000, check: true });
		if (found.ownData) await this.dropOwnVolume(found.uid, id);
	}
}
