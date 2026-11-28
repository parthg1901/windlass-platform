/** E2B owns the session disk and enforces its idle lease. Only manage sandboxes tagged for this deployment; hold the lease while a turn or long command runs. */

import { runCommand, within } from "../command.js";
import { readsModelRelay, SETTINGS_KEY_WINDLASS } from "../../model-relay-url.js";
import { INIT_WORKSPACE } from "../../github/git-flags.js";
import { hostedProfiles, machineHarnesses } from "../harnesses.js";
import type { SandboxProfile, SandboxProfileId } from "../../contract.js";
import {
	type ConnectOptions,
	type CreateSandboxInput,
	DeploymentFull,
	type ExecOptions,
	type ExecResult,
	type ListedSandbox,
	type OutOfMemory,
	type SandboxPrice,
	type SandboxObservation,
	SandboxConnectionLost,
	SandboxUserError,
} from "../api.js";
import { HostedSandboxes, type HostedSandboxProvider } from "../hosted.js";
import { findProfile, profilesFor } from "../profiles.js";
import {
	BWRAP_PROBE,
	DATA_DIR,
	type Answer,
	type InternalExecResult,
	NAME,
	type ProcessEnd,
	RUN_TAG,
	SECRET_FILE_SCRIPT,
	SWEEP_SCRIPT,
	type SandboxProcess,
	type StartOptions,
	type TurnSandbox,
	WORKSPACE,
	assertEnvNames,
	GIT_USER_ENV,
	gitProcess,
	markTurnSandbox,
	signalGitProcess,
	randomId,
	shellQuote,
} from "../provider.js";
import { tokenFilePath, tokenFilePaths } from "../token-file.js";
import { config } from "../../config.js";
import { openRelayLease } from "../relay-leases.js";
import { type LocalPlanRelayOptions, startPlanRelay } from "../plan-relay.js";
import {
	E2bBusyError,
	type E2bClient,
	type E2bCommand,
	type E2bCommandOptions,
	type E2bConnection,
	E2bLimitError,
	type E2bSandboxInfo,
	E2bSnapshotModeError,
} from "./client.js";
import {
	ADOPT_SCRIPT,
	AUDIT_SCRIPT,
	E2bSnapshots,
	RECORD_PATH,
	RECORD_SCRIPT,
	SNAP_META,
	type SnapshotRecord,
} from "./snapshots.js";
import { DEFERRED_INPUTS, HASH, SHA, type SnapshotSource } from "../snapshot-key.js";
import { type E2bSettings, planRefusal, refusesSize, templateFor } from "./config.js";
import { DEFAULT_SNAPSHOT_LIMITS, offeredSize } from "../hosted-settings.js";
import { describeUsage, estimatedCostUsd, pricePerSecond } from "./pricing.js";
import {
	type E2bNetwork,
	withHosts,
	withPlanHosts,
	DNS_LOG,
	DNS_LOG_BYTES,
	blockedLookups,
	guestDnsArgv,
	guestNetworkStep,
	networkConfig,
} from "./network.js";
import {
	HOSTED_SIZE_NAMES,
	HOSTED_SIZE_SPECS,
	type HostedSize,
	type HostedSizeOption,
	isHostedSize,
	outOfMemoryWords,
} from "../../contract.js";
import { errorText } from "../../util.js";
import { GUEST_HARDENING_SCRIPT, HARDENED } from "./guest-hardening.js";

/** The metadata keys of a sandbox of the platform. */
export const META = {
	deployment: "wlp_deployment",
	uid: "wlp_uid",
	session: "wlp_session",
	profile: "wlp_profile",
	network: "wlp_network",
	size: "wlp_size",
	environmentBuild: "wlp_environment_build",
	/** The hosted agent a sandbox was made for (its template's), absent for Windlass: what it may reach follows it (`withPlanHosts`). */
	harness: "wlp_harness",
} as const;

export function sandboxSize(metadata: Record<string, string>): HostedSize {
	const named = metadata[META.size];
	// Sandboxes made before sizes were recorded (some still paused on the live deployment) are small.
	if (named === undefined) return "small";
	if (!isHostedSize(named)) throw new Error("Invalid E2B sandbox size metadata");
	return named;
}

/** E2B's sandbox ids are short strings of letters and digits; anything else was never one. */
const SANDBOX_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A template's own environment is only set while it is built, so what the Dockerfile's ENV gives a container is given here to every command. */
const SANDBOX_ENVS = { LANG: "C.UTF-8", NO_COLOR: "1" };
/** How often a refused pause is tried, and how long apart (E2B: "retry the pause after a short wait"). */
const PAUSE_TRIES = 3;
const PAUSE_RETRY_MS = 5_000;

/** What a user reads when the deployment already runs as many sandboxes as it may. */
export function capReached(limit: number): string {
	return `This deployment runs at most ${limit} ${limit === 1 ? "sandbox" : "sandboxes"} at the same time, and ${limit === 1 ? "it is" : "all of them are"} in use. Try again in a few minutes; an agent's sandbox is freed shortly after its turn has ended.`;
}

/** E2B itself refused: the account's own limit, whatever this deployment's is. */
export const ACCOUNT_LIMIT =
	"E2B refused to start another sandbox because of an account limit or start-rate limit. Try again in a few minutes.";
export const E2B_BUSY = "E2B could not start a sandbox just now. Try again in a minute.";

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * How long `true`, the first command of every connect, may take. A guest that is out of memory (a command of
 * the agent's took all of it) still starts commands and never finishes one, and E2B's pause keeps that memory:
 * every resume brings the same wedged guest back. Ten seconds is far beyond what `true` takes in a sandbox that works.
 */
const PROBE_MS = 10_000;
/** How long the sandbox's name files may take (`guestNetwork`): its lock waits 25 s at most. */
const GUEST_NETWORK_MS = 30_000;
/** How long `GUEST_HARDENING_SCRIPT` may take (`harden`): a few systemctl calls the first time, file reads after. */
const HARDENING_MS = 30_000;

/** What the person reads when a sandbox could not be locked down (`E2bProvider.harden`): it is not used. */
export function hardeningRefusal(reason: string): string {
	return `The sandbox was not used: E2B's base system in it has an SSH server and accounts without a password, which would let any command in it become root, and switching them off failed (${reason}). Try again; if it keeps failing, the operator should rebuild the E2B template (sandbox/e2b/build.sh).`;
}

/** What the turn's timeline says when a sandbox that did not answer was started again from its disk (`E2bProvider.restart`). */
export const RESTARTED_NOTICE =
	"The sandbox had stopped answering commands, most likely because something in it used all of its memory. It was restarted from its disk: the files in the workspace are kept, the programs that were running in it are not.";
const RESTARTED_TAIL =
	"It was restarted from its disk: the files in the workspace are kept, the programs that were running in it are not.";

/** Used memory at this share of the total counts as running out: the guest's kernel keeps a little for itself, so 100% is never sampled. */
const OUT_OF_MEMORY_SHARE = 0.9;
/**
 * How far back E2B's samples are read, and how many of the latest count: a sandbox found silent may have been paused
 * for hours with its memory full, so what tells is its last samples before that, not the time since it started.
 */
const METRICS_LOOKBACK_MS = 24 * 60 * 60_000;
const METRICS_LAST = 20;
/** The guest's own count of processes its kernel killed for memory, and its memory: read as root, a fixed script. */
const GUEST_MEMORY_SCRIPT = `awk '/^oom_kill /{k=$2} END{print "oom_kill", k+0}' /proc/vmstat; awk '/^MemTotal:/{print "total_kib", $2}' /proc/meminfo`;

const messageOf = (error: unknown) => errorText(error).replace(/\s+/g, " ").trim();

/** What this server knows of a sandbox it has used: for the turn's hold and for the line about what it cost. Nothing another server needs. */
interface Known {
	uid: string;
	session: string;
	cpuCount: number;
	memoryMB: number;
	/** Since when it has been running, as far as this server saw; null while it is not. */
	runningSince: number | null;
	/** When its timeout runs out unless someone pushes it out again: the latest it can still be running. */
	deadline: number;
	/** Turns at work in it (one, as the actors run them). */
	holds: number;
	keepalive: ReturnType<typeof setInterval> | undefined;
}

export interface E2bProviderOptions {
	/** Where the lines `[wlp] e2b.…` go. Default the console. */
	log?: (line: string) => void;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** Called with the Windlass version a new sandbox reported (`windlass --version` in the template). */
	onVersion?: (version: string) => void;
	/** Where the sandbox's pinned names point (network.ts `PIN_ADDRESS`). The Docker stand-in of the tests names its own filter. */
	pinAddress?: string;
	/** How long the first command of a connect may take before the sandbox counts as not answering (`answers`). Default `PROBE_MS`. */
	probeMs?: number;
	/** How long the sandbox's name files may take (`guestNetwork`). Default `GUEST_NETWORK_MS`. */
	networkMs?: number;
	/** How long the hardening script may take (`harden`). Default `HARDENING_MS`. */
	hardeningMs?: number;
}

/** The profiles a sandbox on E2B can be made with. */
const E2B_PROFILES: readonly SandboxProfileId[] = ["e2b", "e2b-open"];

function sandboxProfile(metadata: Record<string, string>) {
	const named = E2B_PROFILES.find(id => id === metadata[META.profile]);
	if (!named) throw new Error("Invalid E2B sandbox profile metadata");
	return named;
}

export type GuestCommand = Omit<E2bCommand, "pid">;

/** A Windlass guest over a provider command stream. E2B and Daytona supply their own transport and idle hold. */
export abstract class HostedGuest implements TurnSandbox {
	readonly cwd = WORKSPACE;
	private readonly turnLimitMs: number;
	size: HostedSize = "small";
	image?: string;
	abstract holdForTurn(): Promise<() => Promise<void>>;

	constructor(
		readonly id: string,
		readonly uid: string,
		readonly profile: SandboxProfileId,
		readonly approval: "auto" | "full",
		relaySettings: Pick<E2bSettings, "windlassVersion" | "modelRelayOrigin" | "turnLimitMs">,
		session?: string,
	) {
		markTurnSandbox(this);
		this.turnLimitMs = relaySettings.turnLimitMs;
		const relay = relaySettings.modelRelayOrigin;
		if (relay !== null) {
			if (!readsModelRelay(relaySettings.windlassVersion, SETTINGS_KEY_WINDLASS))
				this.windlassKeyProblem = `Hosted Windlass needs ${SETTINGS_KEY_WINDLASS} to use Settings keys.`;
			const leaseInput = () => {
				if (!session)
					throw new Error(
						"this sandbox names no session (its wlp_session is empty), so its turns cannot use the model relay",
					);
				return { uid, sessionId: session, origin: relay };
			};
			this.modelKeyRelay = async (sessionId, key, signal, takeRequest) => {
				if (sessionId !== session) throw new Error("This model relay belongs to another session.");
				return openRelayLease({
					...leaseInput(),
					key,
					signal,
					ttlMs: relaySettings.turnLimitMs,
					requestLimit: config.modelRelay.turnRequests,
					takeRequest,
				});
			};
		}
	}

	readonly windlassKeyProblem?: string;
	readonly modelKeyRelay?: TurnSandbox["modelKeyRelay"];

	/** The relay runs as the transport user (`gitUser`), which `agent` cannot read or signal; it ends by itself after the turn's limit. */
	localPlanRelay(token: string, options: LocalPlanRelayOptions) {
		return startPlanRelay((argv, start) => this.start(argv, start), token, {
			...options,
			expiresAt: Date.now() + this.turnLimitMs + 60_000,
			requestLimit: config.modelRelay.turnRequests,
		});
	}

	run(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		return this.exec(["bash", "-c", command], options);
	}

	start(argv: string[], options: StartOptions = {}): SandboxProcess {
		const tag = `r${randomId(6)}`;
		assertEnvNames(options.env);
		assertEnvNames(options.secretEnv);
		const envs = options.gitUser
			? GIT_USER_ENV
			: options.secretEnv === undefined
				? options.env
				: { ...options.secretEnv, ...options.env };
		const command = (options.gitUser ? gitProcess(tag, argv) : ["wlp-run", "exec", tag, ...argv])
			.map(shellQuote)
			.join(" ");
		const emit = (handler: ((chunk: string) => void) | undefined, text: string) => {
			if (text === "" || handler === undefined) return;
			try {
				handler(text);
			} catch {
				/* A consumer cannot interrupt the output stream. */
			}
		};
		let hasEnded = false;
		let stdinOpen = true;
		const started = this.startCommand(command, {
			gitUser: options.gitUser,
			cwd: options.gitUser ? "/" : (options.cwd ?? this.cwd),
			envs,
			stdin: true,
			onStdout: text => emit(options.onStdout, text),
			onStderr: text => emit(options.onStderr, text),
		});
		let queue = started;
		const enqueue = (write: (cmd: GuestCommand) => Promise<void>) => {
			queue = queue.then(async cmd => {
				await write(cmd);
				return cmd;
			});
			void queue.catch(() => {
				stdinOpen = false;
			});
		};
		let detach: (end: ProcessEnd) => void = () => {};
		const detached = new Promise<ProcessEnd>(resolve => (detach = resolve));
		const natural = started.then(
			command =>
				command.wait().then(
					(result): ProcessEnd => {
						const signal = /^signal: (.+)$/.exec(result.error?.trim() ?? "")?.[1] ?? null;
						return { code: signal === null ? result.exitCode : null, signal, error: null };
					},
					(error: unknown): ProcessEnd => ({
						code: null,
						signal: null,
						error: new SandboxConnectionLost(`the connection to the command in the sandbox broke: ${messageOf(error)}`),
					}),
				),
			(error: unknown): ProcessEnd => ({
				code: null,
				signal: null,
				error: new Error(`could not start the command in the sandbox: ${messageOf(error)}`),
			}),
		);
		const ended = Promise.race([natural, detached]).then(end => {
			hasEnded = true;
			stdinOpen = false;
			return end;
		});
		return {
			tag,
			write: text => {
				if (!stdinOpen) return false;
				enqueue(cmd => cmd.sendStdin(text));
				return true;
			},
			closeStdin: () => {
				if (!stdinOpen) return;
				stdinOpen = false;
				enqueue(cmd => cmd.closeStdin());
			},
			ended,
			get hasEnded() {
				return hasEnded;
			},
			signal: async (sig, who) => {
				await this.plain(options.gitUser ? signalGitProcess(tag, sig) : ["wlp-run", "signal", tag, sig, who], {
					gitUser: options.gitUser,
					timeoutMs: 10_000,
				}).catch(() => undefined);
			},
			killClient: () => {
				void started.then(command => command.disconnect()).catch(() => undefined);
				detach({ code: null, signal: "SIGKILL", error: null });
			},
		};
	}

	exec(argv: string[], options: ExecOptions = {}): Promise<InternalExecResult> {
		return runCommand(this, argv, options, "stopped listening to the command", () => this.holdLongCommand());
	}

	protected abstract holdLongCommand(): () => Promise<void>;

	protected async plain(
		argv: string[],
		options: { gitUser?: true; root?: true; stdin?: string; env?: Record<string, string>; timeoutMs: number },
	) {
		let stdout = "";
		let stderr = "";
		const command = await this.startCommand(argv.map(shellQuote).join(" "), {
			gitUser: options.gitUser,
			root: options.root,
			cwd: options.gitUser || options.root ? "/" : this.cwd,
			envs: options.gitUser ? GIT_USER_ENV : options.env,
			stdin: options.stdin !== undefined,
			onStdout: text => (stdout += text),
			onStderr: text => (stderr += text),
		});
		const done = command.wait();
		done.catch(() => undefined);
		if (options.stdin !== undefined) {
			if (options.stdin !== "") await command.sendStdin(options.stdin);
			await command.closeStdin();
		}
		if (!(await within(done, options.timeoutMs))) {
			await command.kill().catch(() => undefined);
			return { code: null, stdout, stderr, timedOut: true };
		}
		const result = await done;
		return {
			code: /^signal: /.test(result.error?.trim() ?? "") ? null : result.exitCode,
			stdout,
			stderr,
			timedOut: false,
		};
	}

	async ask(
		argv: string[],
		options: { env?: Record<string, string>; timeoutMs?: number } = {},
	): Promise<Answer | null> {
		const result = await this.plain(argv, { env: options.env, timeoutMs: options.timeoutMs ?? 60_000 }).catch(
			() => null,
		);
		return result === null ? null : { code: result.code, stdout: result.stdout, stderr: result.stderr };
	}

	async stopLeftovers(program: string): Promise<number> {
		const found = await this.plain(["wlp-run", "tags-of", program], { timeoutMs: 10_000 });
		const tags = found.stdout.split("\n").filter(tag => RUN_TAG.test(tag));
		await Promise.all(
			tags.map(async tag => {
				await this.plain(["wlp-run", "signal", tag, "INT", "leader"], { timeoutMs: 10_000 });
				await this.sweep(tag, { waitMs: 3000 });
			}),
		);
		return tags.length;
	}

	async sweep(tag: string, options: { waitMs?: number; files?: string[] } = {}): Promise<number> {
		if (!RUN_TAG.test(tag)) throw new Error("invalid run tag");
		const list = async () => {
			const result = await this.plain(["wlp-run", "list", tag], { timeoutMs: 10_000 }).catch(() => null);
			if (result === null || result.code !== 0) return 0; // the sandbox is gone or paused: nothing runs
			return result.stdout.split("\n").filter(line => line.trim() !== "").length;
		};
		const files = options.files ?? [];
		const waitMs = options.waitMs ?? 0;
		if (waitMs > 0 || files.length === 0) {
			const deadline = Date.now() + waitMs;
			let count = await list();
			while (count > 0 && Date.now() < deadline) {
				await realSleep(150);
				count = await list();
			}
			if (count === 0 && files.length === 0) return 0;
		}
		const result = await this.plain(["sh", "-c", SWEEP_SCRIPT, "sh", tag, ...files], { timeoutMs: 15_000 }).catch(
			() => null,
		);
		const left = result === null || result.code !== 0 ? 0 : Number(result.stdout.trim());
		return Number.isFinite(left) ? left : 0;
	}

	protected abstract startCommand(command: string, options: E2bCommandOptions): Promise<GuestCommand>;
	abstract readTextFile(path: string): Promise<string>;
	abstract writeTextFile(path: string, content: string): Promise<void>;

	private readonly writes = new Map<string, Promise<void>>();

	async writeSecretFile(path: string, content: string): Promise<void> {
		const previous = this.writes.get(path) ?? Promise.resolve();
		const write = previous
			.catch(() => {})
			.then(async () => {
				const result = await this.plain(["sh", "-c", SECRET_FILE_SCRIPT, "sh", path], {
					stdin: content,
					timeoutMs: 30_000,
				});
				if (result.code !== 0)
					throw new Error(result.timedOut ? "timed out" : result.stderr.trim() || `exit ${result.code}`);
			});
		this.writes.set(path, write);
		try {
			await write;
		} catch (error) {
			throw new Error(`cannot write ${path}: ${messageOf(error)}`);
		} finally {
			if (this.writes.get(path) === write) this.writes.delete(path);
		}
	}

	async removeFiles(paths: string[]): Promise<void> {
		if (paths.length === 0) return;
		await this.plain(["rm", "-f", "--", ...paths], { timeoutMs: 10_000 }).catch(() => undefined);
	}
}

export class E2bSandboxHandle extends HostedGuest {
	constructor(
		private readonly owner: E2bProvider,
		public connection: E2bConnection,
		id: string,
		uid: string,
		profile: SandboxProfileId,
		approval: "auto" | "full",
		private readonly network: Pick<E2bNetwork, "mode" | "hosts"> = { mode: "open", hosts: [] },
		session?: string,
	) {
		super(id, uid, profile, approval, owner.settings, session);
	}

	/** Made from a post-setup snapshot (snapshots.ts): what it was saved from. Set by `E2bProvider` before the handle is handed out. */
	snapshot?: SnapshotSource;
	/** `SandboxHandle.notice`: set when this connect started the sandbox again from its disk. */
	notice?: string;
	/** `SandboxHandle.outOfMemory`: with `notice`, when it had run out of memory. */
	outOfMemory?: OutOfMemory;

	/**
	 * The guest's own count of processes its kernel killed for want of memory, and its memory in MiB: a turn
	 * reads it at its start and end (`TurnSandbox.memoryEvents`). Null when the sandbox does not answer.
	 */
	async memoryEvents(): Promise<{ oomKills: number; totalMiB: number } | null> {
		const answer = await this.plain(["sh", "-c", GUEST_MEMORY_SCRIPT], { root: true, timeoutMs: 10_000 }).catch(
			() => null,
		);
		if (answer === null || answer.timedOut || answer.code !== 0) return null;
		const kills = /^oom_kill (\d+)$/m.exec(answer.stdout),
			total = /^total_kib (\d+)$/m.exec(answer.stdout);
		return kills === null
			? null
			: { oomKills: Number(kills[1]), totalMiB: total === null ? 0 : Math.round(Number(total[1]) / 1024) };
	}

	/** The most memory E2B sampled the sandbox using since `sinceMs`, against its total, in MiB; null without samples. */
	memoryPeak(sinceMs: number): Promise<OutOfMemory | null> {
		return this.owner.memoryPeak(this.id, sinceMs, this.size);
	}

	/** One of the provider's own fixed scripts as root (snapshots.ts): never a command of a session's. Its last line of output, or null. */
	async rootAnswer(
		script: string,
		args: string[],
		options: { stdin?: string; timeoutMs: number },
	): Promise<{ code: number | null; stdout: string } | null> {
		const result = await this.plain(["sh", "-c", script, "sh", ...args], {
			root: true,
			stdin: options.stdin,
			timeoutMs: options.timeoutMs,
		}).catch(() => null);
		return result === null || result.timedOut ? null : { code: result.code, stdout: result.stdout };
	}

	// The root-owned stub only appends ASCII lines. Advance past whole lines on success so a
	// failed read or a chunk ending mid-name can be retried at exactly the same byte.
	private dnsOffset = 0;
	private readonly dnsNames = new Set<string>();

	/** The names its lookup stub was asked for that it may not reach (network.ts `DNS_STUB`); none in `open`, or when the log cannot be read. */
	async blockedHosts(skip: Iterable<string> = []): Promise<string[]> {
		if (this.network.mode === "open") return [];
		const read = await this.ask(
			[
				"dd",
				"if=" + DNS_LOG,
				"bs=64K",
				"iflag=skip_bytes,count_bytes",
				"skip=" + this.dnsOffset,
				"count=" + (DNS_LOG_BYTES + 4096),
				"status=none",
			],
			{ timeoutMs: 15_000 },
		);
		if (read === null || read.code !== 0) return [];
		const lines = read.stdout.slice(0, read.stdout.lastIndexOf("\n") + 1);
		if (lines) {
			this.dnsOffset += Buffer.byteLength(lines);
			for (const host of blockedLookups(lines, this.network.hosts, 2000)) {
				this.dnsNames.add(host);
				if (this.dnsNames.size > 2000) this.dnsNames.delete(this.dnsNames.values().next().value!);
			}
		}
		const seen = new Set(skip);
		return [...this.dnsNames].filter(host => !seen.has(host)).slice(0, 50);
	}

	protected holdLongCommand(): () => Promise<void> {
		// Short commands finish before the first hold and cost no extra E2B request.
		let holding: Promise<() => Promise<void>> | null = null;
		const timer = setTimeout(() => {
			holding = this.owner.holdFor(this, { refresh: false }).catch(() => async () => {});
		}, this.owner.holdCommandsAfterMs);
		return async () => {
			clearTimeout(timer);
			if (holding) await (await holding)();
		};
	}

	protected startCommand(command: string, options: E2bCommandOptions) {
		return this.connection.start(command, options);
	}

	/** A path as E2B's file API needs it: that API resolves a relative one against the user's home, not the workspace. */
	private absolute(path: string): string {
		return path.startsWith("/") ? path : `${this.cwd}/${path}`;
	}

	async readTextFile(path: string): Promise<string> {
		try {
			return await this.connection.readFile(this.absolute(path));
		} catch (error) {
			throw new Error(`cannot read ${path}: ${messageOf(error)}`);
		}
	}

	async writeTextFile(path: string, content: string): Promise<void> {
		try {
			await this.connection.writeFile(this.absolute(path), content);
		} catch (error) {
			throw new Error(`cannot write ${path}: ${messageOf(error)}`);
		}
	}

	holdForTurn(): Promise<() => Promise<void>> {
		return this.owner.holdFor(this);
	}
}

export function e2bSandboxes(client: E2bClient, settings: E2bSettings, options?: E2bProviderOptions) {
	return new HostedSandboxes(new E2bProvider(client, settings, options));
}

export class E2bProvider implements HostedSandboxProvider {
	readonly supportsAllowList = true;
	readonly openProfileId = "e2b-open";
	/** A sandbox nobody uses is paused by E2B when its idle timeout runs out ("The dead-man switch"). */
	readonly idleStopMs: number;
	private readonly known = new Map<string, Known>();
	/** The tail of each sandbox's queue of network changes (`serial`). */
	private readonly networkChanges = new Map<string, Promise<void>>();
	/** Sandboxes this process ran `GUEST_HARDENING_SCRIPT` in since they last started (`harden`): a connect to one that has run since needs no second run. */
	private readonly hardened = new Set<string>();
	/** How long a command outside a turn may run before the sandbox is vouched for as for a turn (`E2bSandboxHandle.exec`). */
	readonly holdCommandsAfterMs: number;
	private readonly log: (line: string) => void;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	/** WLP_E2B_SNAPSHOTS=on: the deployment's post-setup snapshots. Null: off, and the four snapshot calls are absent. */
	private readonly snapshotStore: E2bSnapshots | null;
	/** Reads the names and records of snapshots whatever the switch says: a sandbox made from one before it was turned off is still judged by its record. */
	private readonly snapshotRecords: E2bSnapshots;
	/** What each sandbox this process made from a snapshot was saved from, so a connect needs no read of its record. */
	private readonly sources = new Map<string, SnapshotSource>();
	readonly artifacts?: HostedSandboxProvider["artifacts"];
	/** E2B refused a filesystem-only snapshot once: said once, and no other save is tried by this process. */
	private snapshotsRefused = false;

	constructor(
		private readonly client: E2bClient,
		readonly settings: E2bSettings,
		private readonly options: E2bProviderOptions = {},
	) {
		this.log = options.log ?? (line => console.log(line));
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? realSleep;
		this.holdCommandsAfterMs = Math.floor(settings.idleTimeoutMs / 3);
		this.idleStopMs = settings.idleTimeoutMs;
		const limits = settings.snapshots;
		this.snapshotStore = limits
			? new E2bSnapshots(client, { ...settings, snapshots: limits }, this.log, this.now)
			: null;
		this.snapshotRecords =
			this.snapshotStore ??
			new E2bSnapshots(client, { ...settings, snapshots: DEFAULT_SNAPSHOT_LIMITS }, this.log, this.now);
		if (this.snapshotStore !== null) {
			const store = this.snapshotStore;
			this.artifacts = {
				hasSnapshot: (uid, repo) => store.has(uid, repo),
				saveSnapshot: (id, source) => this.saveSetupSnapshot(store, id, source),
				dropSnapshots: (uid, repo) => store.drop(uid, repo),
				sweepSnapshots: async () => {
					await store.prune();
				},
			};
		}
		this.log(
			settings.modelRelayOrigin
				? `[wlp] e2b.model_relay: Settings-key requests go through ${settings.modelRelayOrigin}/model-relay; plan requests leave from a relay inside each sandbox, which never holds a credential the agent can read`
				: `[wlp] e2b.model_relay: off (${settings.modelRelayOff ?? "not configured"}): Settings keys are unavailable; plan requests leave from a relay inside each sandbox`,
		);
	}

	/** By E2B's published prices for the smallest size (pricing.ts): an estimate. Each size's is in `sizes`. */
	price(): SandboxPrice {
		return pricePerSecond(HOSTED_SIZE_SPECS.small.cpus, HOSTED_SIZE_SPECS.small.memoryMiB, this.settings.rateCard);
	}

	/** The sizes whose templates the deployment has (WLP_E2B_SIZES), with what an hour of each is estimated to cost. */
	sizes(): HostedSizeOption[] {
		return this.settings.sizes.map(id => {
			const spec = HOSTED_SIZE_SPECS[id];
			return {
				id,
				cpus: spec.cpus,
				memoryMiB: spec.memoryMiB,
				usdPerHour: estimatedCostUsd(3600, spec.cpus, spec.memoryMiB, this.settings.rateCard),
			};
		});
	}

	/**
	 * The most memory E2B sampled a sandbox using in its last samples since `sinceMs` (at most `METRICS_LOOKBACK_MS`
	 * back), against its total, in MiB. Null without samples, or where it never came near its total: then it did not run out.
	 */
	async memoryPeak(id: string, sinceMs: number, size?: HostedSize): Promise<OutOfMemory | null> {
		if (this.client.metrics === undefined) return null;
		const samples = (
			await this.client.metrics(id, Math.max(sinceMs, this.now() - METRICS_LOOKBACK_MS)).catch(() => [])
		).slice(-METRICS_LAST);
		const peak = samples.reduce<{ memUsed: number; memTotal: number } | null>(
			(best, one) =>
				one.memTotal > 0 && (best === null || one.memUsed / one.memTotal > best.memUsed / best.memTotal) ? one : best,
			null,
		);
		if (peak === null || peak.memUsed < peak.memTotal * OUT_OF_MEMORY_SHARE) return null;
		return {
			usedMiB: Math.round(peak.memUsed / 2 ** 20),
			totalMiB: Math.round(peak.memTotal / 2 ** 20),
			...(size && { size }),
		};
	}

	/** The users with sandboxes of this deployment, by E2B's own list. */
	async owners(): Promise<string[]> {
		const found = await this.client.list({ metadata: { [META.deployment]: this.settings.deployment } });
		return [
			...new Set(
				found
					.filter(info => info.metadata[META.deployment] === this.settings.deployment)
					.map(info => info.metadata[META.uid] ?? "")
					.filter(uid => NAME.test(uid)),
			),
		];
	}

	/** The user's sandboxes of this deployment, by E2B's own list: running and paused. */
	async inventory(uid: string): Promise<ListedSandbox[]> {
		if (!NAME.test(uid)) return [];
		const found = await this.client.list({
			metadata: { [META.deployment]: this.settings.deployment, [META.uid]: uid },
		});
		// The filter is E2B's; a sandbox is only taken for this user's when its own metadata says so too.
		return found
			.filter(info => info.metadata[META.deployment] === this.settings.deployment && info.metadata[META.uid] === uid)
			.map(info => ({
				id: info.sandboxId,
				sessionId: info.metadata[META.session] ?? "",
				state: info.state,
				...((info.metadata[META.environmentBuild] === "true" || info.metadata[SNAP_META.candidate]) && {
					buildStartedAt: info.startedAt,
				}),
			}));
	}

	profiles(): SandboxProfile[] {
		return profilesFor(
			"e2b",
			{ ...this.settings, network: this.network.mode },
			this.settings.modelRelayOrigin !== null,
		).map(p => (this.settings.modelRelayOrigin && p.id === "e2b-open" ? { ...p, platformKeys: true } : p));
	}

	/** WLP_E2B_NETWORK: what every sandbox of the deployment may reach (network.ts). */
	get network(): E2bNetwork {
		return this.settings.network;
	}

	/**
	 * What one sandbox may reach: the deployment's network, and in `restricted` the hosts its session's
	 * repositories allow (repository-network.ts). Hosts beyond MAX_HOSTS are left out and said in the log.
	 */
	private networkFor(which: string, extra: readonly string[] | undefined, harness: string | undefined): E2bNetwork {
		const { network, dropped } = withHosts(withPlanHosts(this.network, harness), extra);
		if (dropped.length > 0)
			this.log(
				`[wlp] e2b.network.dropped ${which}: ${dropped.length} of the repository's hosts left out, beyond the ${network.hosts.length} a sandbox may have (${dropped.slice(0, 5).join(", ")}${dropped.length > 5 ? ", …" : ""})`,
			);
		return network;
	}

	async applyEgress(id: string, hosts: readonly string[]): Promise<boolean> {
		if (this.network.mode !== "restricted") return this.network.mode === "open";
		return this.serial(id, async () => {
			// Only under a turn's hold: E2B's connect resumes a paused sandbox and pushes a running one's
			// timeout out, and outside a turn nothing would count that time or stop it again.
			const known = this.known.get(id);
			if (known === undefined || known.holds === 0) return false;
			const info = await this.ours(id);
			if (info === undefined || info.state !== "running") return false;
			const connection = await this.client.connect(id, this.settings.idleTimeoutMs);
			if (connection === undefined) return false;
			const network = this.networkFor(`id=${id}`, hosts, info.metadata[META.harness]);
			try {
				await this.client.updateNetwork(id, networkConfig(network));
				await this.guestNetwork(connection, network);
			} catch (error) {
				throw new Error(`could not change the sandbox's network: ${messageOf(error)}`);
			}
			this.log(`[wlp] e2b.network.changed id=${id}: ${network.hosts.length} hosts`);
			return true;
		});
	}

	/**
	 * Runs the changes of one sandbox's network one after the other: a connect's and a host allowed from
	 * its session would otherwise interleave, and E2B's list and the names file could end up from
	 * different calls (network.ts `GUEST_DNS_SCRIPT` holds a lock of its own in the sandbox too).
	 */
	private serial<T>(id: string, change: () => Promise<T>): Promise<T> {
		const run = (this.networkChanges.get(id) ?? Promise.resolve()).then(change);
		const tail: Promise<void> = run.then(
			() => undefined,
			() => undefined,
		);
		this.networkChanges.set(id, tail);
		void tail.then(() => {
			if (this.networkChanges.get(id) === tail) this.networkChanges.delete(id);
		});
		return run;
	}

	/**
	 * The sandbox's name files for the deployment's mode, as root (network.ts `GUEST_DNS_SCRIPT`): the
	 * allowed names pinned, every other lookup failing at once. A fixed script; nothing of a session's is in it.
	 */
	private async guestNetwork(connection: E2bConnection, network: E2bNetwork = this.network): Promise<void> {
		const mode = network.mode;
		let stdout = "";
		let stderr = "";
		const starting = this.now();
		let command: E2bCommand;
		try {
			command = await connection.start(guestDnsArgv(network, this.options.pinAddress).map(shellQuote).join(" "), {
				root: true,
				cwd: "/",
				stdin: false,
				onStdout: text => (stdout += text),
				onStderr: text => (stderr += text),
			});
		} catch (error) {
			throw new Error(
				`could not set the sandbox's names for WLP_E2B_NETWORK=${mode}: E2B did not start the script (${messageOf(error)})`,
			);
		}
		const startMs = this.now() - starting;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const limit = this.options.networkMs ?? GUEST_NETWORK_MS;
		const result = await Promise.race([
			command.wait(),
			new Promise<null>(resolve => (timer = setTimeout(() => resolve(null), limit))),
		]).finally(() => clearTimeout(timer));
		if (result === null) await command.kill().catch(() => undefined);
		if (result === null)
			throw new Error(
				`could not set the sandbox's names for WLP_E2B_NETWORK=${mode}: the script started (in ${Math.round(startMs / 100) / 10} s) and did not end within ${limit / 1000} s; ${guestNetworkStep(stdout)}`,
			);
		if (result.exitCode !== 0 || !stdout.includes(`network ${mode}`))
			throw new Error(
				`could not set the sandbox's names for WLP_E2B_NETWORK=${mode} (${stderr.trim().slice(-300) || `exit ${result.exitCode}`}; ${guestNetworkStep(stdout)})`,
			);
	}

	/**
	 * Takes away what E2B's base system adds that lets any user of the guest become root (guest-hardening.ts):
	 * as root, before anything of a session's runs, at every create, resume and restart. Throws a
	 * `SandboxUserError` unless the script says the guest is as it must be; the caller then does not use the sandbox.
	 */
	private async harden(id: string, connection: E2bConnection): Promise<void> {
		this.hardened.delete(id);
		let stdout = "";
		let stderr = "";
		const failed = (reason: string) => {
			this.log(`[wlp] e2b.sandbox.hardening_failed id=${id}: ${reason}`);
			return new SandboxUserError(hardeningRefusal(reason));
		};
		let command: E2bCommand;
		try {
			command = await connection.start(["sh", "-c", GUEST_HARDENING_SCRIPT].map(shellQuote).join(" "), {
				root: true,
				cwd: "/",
				stdin: false,
				onStdout: text => (stdout += text),
				onStderr: text => (stderr += text),
			});
		} catch (error) {
			throw failed(`E2B did not start the script: ${messageOf(error)}`);
		}
		const limit = this.options.hardeningMs ?? HARDENING_MS;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const result = await Promise.race([
			command.wait().catch((error: unknown) => ({ exitCode: -1, error: messageOf(error) })),
			new Promise<null>(resolve => (timer = setTimeout(() => resolve(null), limit))),
		]).finally(() => clearTimeout(timer));
		if (result === null) {
			await command.kill().catch(() => undefined);
			throw failed(`the script did not end within ${limit / 1000} s`);
		}
		const last = stdout.trim().split("\n").pop()?.trim() ?? "";
		if (result.exitCode !== 0 || last !== HARDENED) {
			const said = last.startsWith("refused") ? last : stderr.trim().slice(-300) || last.slice(-300);
			throw failed(
				(
					said ||
					(result.exitCode === 0 ? "the script ended without saying the guest is hardened" : `exit ${result.exitCode}`)
				).slice(0, 300),
			);
		}
		this.hardened.add(id);
	}

	/**
	 * Null when the sandbox runs a command to its end within `probeMs`; otherwise what went wrong, in words
	 * for a log line and an error. As root, so that nothing of a session's (its process limit, its files) is in the way.
	 */
	private async answers(connection: E2bConnection): Promise<string | null> {
		const limit = this.options.probeMs ?? PROBE_MS;
		const deadline = this.now() + limit;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<"late">(resolve => (timer = setTimeout(() => resolve("late"), limit)));
		let command: E2bCommand | undefined;
		try {
			const started = connection.start("true", { root: true, cwd: "/", stdin: false });
			started.catch(() => undefined);
			const first = await Promise.race([started, late]);
			if (first === "late") return `E2B did not start a command in it within ${limit / 1000} s`;
			command = first;
			const done = command.wait();
			done.catch(() => undefined);
			const end = await Promise.race([done, late]);
			if (end === "late") return `a command started in it and did not end within ${limit / 1000} s`;
			return end.exitCode === 0
				? null
				: `\`true\` ended with exit code ${end.exitCode}${end.error ? ` (${end.error})` : ""}`;
		} catch (error) {
			return `a command in it failed: ${messageOf(error)}`;
		} finally {
			clearTimeout(timer);
			if (command !== undefined && this.now() >= deadline) void command.kill().catch(() => undefined);
		}
	}

	/**
	 * The sandbox does not answer (`answers`): it is paused and started again from its disk, without the memory
	 * the pause kept (`onResume: "reboot"`, E2B's rescue for a wedged guest). The workspace's files stay; no
	 * process of before runs, so a turn that was cut off is gone with them. Throws when it still does not answer.
	 */
	private async restart(
		info: E2bSandboxInfo,
		silent: string,
		memory: OutOfMemory | null = null,
	): Promise<E2bConnection> {
		const id = info.sandboxId;
		// Said in every error below: what the person can do about it is a larger size.
		const why = memory === null ? silent : `${silent}; ${outOfMemoryWords(memory, this.settings.sizes)}`;
		// Without pauses (WLP_E2B_PAUSE=0) there is no start from the disk: only a new sandbox, which the person chooses.
		if (!this.settings.pause)
			throw new Error(
				`the sandbox does not answer (${why}); with WLP_E2B_PAUSE=0 it cannot be started again from its disk`,
			);
		this.log(
			`[wlp] e2b.sandbox.unresponsive id=${id} session=${info.metadata[META.session] ?? ""} size=${sandboxSize(info.metadata)}${memory === null ? "" : ` memory=${memory.usedMiB}/${memory.totalMiB}MiB`}: ${silent}; it is paused and started again from its disk`,
		);
		for (let attempt = 1; ; attempt += 1) {
			try {
				await this.client.pause(id);
				break;
			} catch (error) {
				if (!(error instanceof E2bBusyError) || attempt >= PAUSE_TRIES)
					throw new Error(
						`the sandbox does not answer (${why}), and it could not be paused to start it again: ${messageOf(error)}`,
					);
				await this.sleep(PAUSE_RETRY_MS);
			}
		}
		this.ended({ ...info, state: "running" }, "paused", "to be started again from its disk");
		let fresh: E2bConnection | undefined;
		try {
			fresh = await this.client.connect(id, this.settings.idleTimeoutMs, { reboot: true });
		} catch (error) {
			if (error instanceof E2bLimitError) throw new SandboxUserError(ACCOUNT_LIMIT);
			if (error instanceof E2bBusyError) throw new SandboxUserError(E2B_BUSY);
			throw new Error(
				`the sandbox does not answer (${why}), and it could not be started again from its disk: ${messageOf(error)}`,
			);
		}
		if (fresh === undefined) throw new Error("the sandbox was gone after it was paused to be started again");
		const still = await this.answers(fresh);
		if (still !== null)
			throw new Error(
				`the sandbox does not answer (${why}), and still did not after it was started again from its disk (${still})`,
			);
		this.log(`[wlp] e2b.sandbox.rebooted id=${id}: started again from its disk, and it answers`);
		return fresh;
	}

	async provision(input: CreateSandboxInput): Promise<string> {
		if (
			input.harness &&
			(!hostedProfiles.includes(input.profile) || input.screenshots || !this.settings.modelRelayOrigin)
		)
			throw new SandboxUserError(
				`${machineHarnesses[input.harness].name} needs the microVM-only profile and a configured model relay.`,
			);
		if (typeof input.uid !== "string" || !NAME.test(input.uid))
			throw new Error(
				'invalid user id: it must be 1 to 64 letters, digits, "_" or "-", starting with a letter or digit',
			);
		const profile = this.profiles().find(profile => profile.id === input.profile);
		if (!profile) throw new Error(`unknown sandbox profile: ${String(input.profile)}`);
		if (!profile.available || !E2B_PROFILES.includes(profile.id))
			throw new SandboxUserError(
				`The sandbox "${profile.name}" is not available: ${profile.unavailableReason ?? "not supported here"}`,
			);
		const network = this.networkFor(`session=${input.sessionId}`, input.network, input.harness);
		const config = networkConfig(network);
		await this.assertRoom();
		// The size asked for, or the largest the deployment has a template of below it (WLP_E2B_SIZES).
		const size = offeredSize(this.settings, input.hostedSize);
		const template = templateFor(this.settings, size, !!input.screenshots, input.harness);
		// A post-setup snapshot of this user and repository, when the session asks for one and one fits (snapshots.ts). Of this size's template only: a snapshot starts sandboxes of its own size.
		const selected =
			!input.harness && input.fromSnapshot && this.snapshotStore
				? await this.snapshotStore
						.select(input.fromSnapshot, input.uid, input.profile, !!input.screenshots, size)
						.catch(() => null)
				: null;
		const build = input.environmentBuild || !!selected?.metadata[SNAP_META.candidate];
		const metadata = {
			[META.deployment]: this.settings.deployment,
			[META.uid]: input.uid,
			[META.session]: input.sessionId.slice(0, 200),
			[META.profile]: input.profile,
			[META.size]: size,
			...(input.harness && { [META.harness]: input.harness }),
			...(network.mode === "open" ? {} : { [META.network]: network.mode }),
			...(selected?.metadata ?? {}),
			...(build && { [META.environmentBuild]: "true" }),
		};
		let connection: E2bConnection;
		try {
			connection = await this.client.create({
				template: selected?.template ?? template,
				timeoutMs: this.settings.idleTimeoutMs,
				metadata,
				envs: SANDBOX_ENVS,
				onTimeout: this.settings.pause && !build ? "pause" : "kill",
				...(config === null ? {} : { network: config }),
			});
		} catch (error) {
			if (error instanceof E2bLimitError) throw new SandboxUserError(ACCOUNT_LIMIT);
			if (error instanceof E2bBusyError) throw new SandboxUserError(E2B_BUSY);
			// The snapshot went (another server's eviction) or E2B could not boot it: the ordinary way, as on Docker.
			if (selected?.hit) {
				this.log(
					`[wlp] e2b.snapshot.miss name=${selected.name} session=${input.sessionId}: a sandbox could not be made from it (${messageOf(error).slice(0, 200)}), so setup runs`,
				);
				return this.provision({ ...input, fromSnapshot: undefined });
			}
			// A size the account's plan does not allow: said with the plan's limits, to the person and in the log.
			if (refusesSize(messageOf(error))) {
				this.log(`[wlp] e2b.size_refused size=${size} template=${template}: ${messageOf(error).slice(0, 300)}`);
				throw new SandboxUserError(planRefusal(size, messageOf(error).slice(0, 300)));
			}
			// A size the deployment lists without its template built at E2B: said with what to do, not as E2B's words alone.
			if (input.harness && /not.?found|template/i.test(messageOf(error)))
				throw new Error(
					`Missing template "${template}". Run sandbox/e2b/build.sh with WLP_E2B_HARNESS=${input.harness}, WLP_E2B_SIZE=${size} and WLP_E2B_HARNESS_IMAGE set to the published harness image.`,
				);
			if (size !== "small" && /not.?found|template/i.test(messageOf(error)))
				throw new Error(
					`could not create a ${HOSTED_SIZE_NAMES[size]} sandbox from the template "${template}" (${messageOf(error)}): build it (sandbox/e2b/build.sh with WLP_E2B_SIZE=${size}), or leave ${size} out of WLP_E2B_SIZES`,
				);
			throw new Error(`could not create the sandbox: ${messageOf(error)}`);
		}
		const id = connection.sandboxId;
		const began = this.now();
		const discard = async () => {
			await this.client
				.kill(id)
				.catch((error: unknown) =>
					this.log(
						`[wlp] e2b.sandbox.kill_failed id=${id}: ${messageOf(error)}; its own timeout stops it within ${Math.round(this.settings.idleTimeoutMs / 1000)} s`,
					),
				);
		};
		// Another server may have looked at the list at the same moment and made one too: then this one is one too many.
		const running = await this.runningCount().catch(() => null);
		if (running !== null && running > this.settings.maxRunning) {
			await discard();
			this.log(
				`[wlp] e2b.cap_reached deployment=${this.settings.deployment}: ${running} sandboxes ran at once where ${this.settings.maxRunning} may; the newest (id=${id}) was removed again`,
			);
			throw new DeploymentFull(this.settings.maxRunning, capReached(this.settings.maxRunning));
		}
		// Before anything else runs in it, even the provider's own scripts: E2B's SSH server and empty passwords go.
		try {
			await this.harden(id, connection);
		} catch (error) {
			await discard();
			throw error;
		}
		const handle = new E2bSandboxHandle(
			this,
			connection,
			id,
			input.uid,
			profile.id,
			profile.approval,
			network,
			input.sessionId,
		);
		handle.size = size;
		if (selected?.hit && input.fromSnapshot) {
			// The snapshot's own record must name this deployment, this user, the repository and the key, or nothing of it is used.
			const adopted = await handle.rootAnswer(ADOPT_SCRIPT, [DNS_LOG], { timeoutMs: 30_000 });
			let record: unknown = null;
			try {
				record = adopted?.code === 0 ? JSON.parse(adopted.stdout) : null;
			} catch {
				record = null;
			}
			if (!this.snapshotStore!.recordFits(record, selected.name, input.uid, input.fromSnapshot, selected.key)) {
				await discard();
				this.log(
					`[wlp] e2b.snapshot.refused name=${selected.name} id=${id}: the sandbox made from it does not hold its record for this user and repository; it was removed, and setup runs`,
				);
				return this.provision({ ...input, fromSnapshot: undefined });
			}
			const source = this.snapshotStore!.sourceOf(record, input.fromSnapshot.attempt);
			handle.snapshot = source;
			this.sources.set(id, source);
		}
		try {
			// Before anything of the session's runs in it: from the first command on, only the allowed names resolve.
			if (config !== null) await this.guestNetwork(connection, network);
			// A workspace from a snapshot holds the repository as setup left it: it is not made again.
			const init = await handle.exec(
				["sh", "-c", selected?.hit ? "windlass --version" : INIT_WORKSPACE + " && windlass --version"],
				{ timeoutMs: 60_000 },
			);
			if (init.exitCode !== 0)
				throw new Error(
					`could not set up the workspace: ${(init.stderr.trim() || init.stdout.trim() || `exit ${init.exitCode}`).slice(-500)}`,
				);
			// "Windlass 0.4.0 (linux-x64)"
			const version = /^\S+\s+(\S+)/.exec(init.stdout.trim().split("\n").pop() ?? "")?.[1];
			if (version !== undefined) this.options.onVersion?.(version);
			if (profile.id === "e2b" && this.settings.windlassSandbox) {
				// The profile promises Windlass's sandbox, so a sandbox in which it cannot work is not handed out. `e2b-open` promises none.
				const probe = await handle.ask(BWRAP_PROBE, { timeoutMs: 20_000 });
				if (probe === null || probe.code !== 0)
					throw new Error(
						`bubblewrap does not work in this sandbox, so Windlass could not sandbox commands in it as WLP_E2B_WINDLASS_SANDBOX=1 promises (${probe === null ? "the probe could not be run" : probe.stderr.trim().slice(-300) || `exit ${probe.code}`}). Unset it, or rebuild the template`,
					);
			}
		} catch (error) {
			await discard();
			throw error;
		}
		const info = await this.client.info(id).catch(() => undefined);
		// What E2B says the sandbox has, and until it says, what the size is built with: the cost lines are of the real size.
		const spec = HOSTED_SIZE_SPECS[size];
		this.known.set(id, {
			uid: input.uid,
			session: input.sessionId,
			cpuCount: info?.cpuCount || spec.cpus,
			memoryMB: info?.memoryMB || spec.memoryMiB,
			runningSince: began,
			deadline: began + this.settings.idleTimeoutMs,
			holds: 0,
			keepalive: undefined,
		});
		if (info !== undefined && info.memoryMB > 0 && Math.abs(info.memoryMB - spec.memoryMiB) > spec.memoryMiB / 4)
			this.log(
				`[wlp] e2b.size_mismatch id=${id} size=${size} template=${template}: E2B says ${info.cpuCount} vCPU and ${info.memoryMB} MiB, the size is ${spec.cpus} vCPU and ${spec.memoryMiB} MiB; rebuild the template with WLP_E2B_SIZE=${size}`,
			);
		this.log(
			`[wlp] e2b.sandbox.created id=${id} uid=${input.uid} session=${input.sessionId} size=${size} template=${selected?.hit ? `snapshot ${selected.name}` : template}${running === null ? "" : `: ${running} of at most ${this.settings.maxRunning} running`}`,
		);
		return id;
	}

	async acquire(id: string, options: ConnectOptions = {}): Promise<TurnSandbox | undefined> {
		const info = await this.ours(id);
		if (info === undefined) return undefined;
		const made = sandboxProfile(info.metadata);
		const size = sandboxSize(info.metadata);
		const paused = info.state === "paused";
		// Starting a paused sandbox adds one to those that run, as creating one does.
		if (paused) await this.assertRoom();
		let connection: E2bConnection | undefined;
		const connectedAt = this.now();
		try {
			connection = await this.client.connect(id, this.settings.idleTimeoutMs);
		} catch (error) {
			if (error instanceof E2bLimitError) throw new SandboxUserError(ACCOUNT_LIMIT);
			if (error instanceof E2bBusyError) throw new SandboxUserError(E2B_BUSY);
			throw new Error(`could not start the sandbox: ${messageOf(error)}`);
		}
		if (connection === undefined) return undefined;
		// Before anything else: a sandbox that starts commands and never finishes one would hang every step below.
		const silent = await this.answers(connection);
		let restarted = false;
		let memory: OutOfMemory | null = null;
		if (silent !== null) {
			// E2B's samples are read from outside the guest: they say whether its memory was used up when it stopped answering.
			memory = await this.memoryPeak(id, 0, size);
			// A paused one has run only since this connect.
			connection = await this.restart(paused ? { ...info, startedAt: connectedAt } : info, silent, memory);
			restarted = true;
		}
		// Before anything of the session's: a resume or a start from the disk may bring E2B's SSH server back, and a
		// sandbox this process has not seen since it started may have been made before the hardening existed.
		if (paused || restarted || !this.hardened.has(id)) {
			try {
				await this.harden(id, connection);
			} catch (error) {
				// Nothing of the session's may go on in it: it is paused (its workspace kept) until a later connect hardens it.
				if (this.settings.pause) await this.client.pause(id).catch(() => undefined);
				throw error;
			}
		}
		const now = this.now();
		const known = this.remember(info);
		const network = this.networkFor(`id=${id}`, options.network, info.metadata[META.harness]);
		const handle = new E2bSandboxHandle(
			this,
			connection,
			id,
			known.uid,
			made,
			findProfile(made).approval,
			network,
			info.metadata[META.session],
		);
		handle.size = size;
		if (restarted)
			handle.notice =
				memory === null ? RESTARTED_NOTICE : `${outOfMemoryWords(memory, this.settings.sizes)} ${RESTARTED_TAIL}`;
		if (memory !== null) handle.outOfMemory = memory;
		const from = info.metadata[SNAP_META.from];
		if (from) handle.snapshot = await this.sourceFor(handle, info, from);
		const build = info.metadata[SNAP_META.build];
		if (typeof build === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(build)) handle.image = build;
		if (paused || restarted) {
			const running = await this.runningCount().catch(() => null);
			if (running !== null && running > this.settings.maxRunning) {
				await this.client.pause(id).catch(() => undefined);
				this.log(
					`[wlp] e2b.cap_reached deployment=${this.settings.deployment}: ${running} sandboxes ran at once where ${this.settings.maxRunning} may; id=${id} was paused again`,
				);
				throw new DeploymentFull(this.settings.maxRunning, capReached(this.settings.maxRunning));
			}
			known.runningSince = now;
			known.deadline = now + this.settings.idleTimeoutMs;
			if (paused) this.log(`[wlp] e2b.sandbox.resumed id=${id} uid=${known.uid} session=${known.session}`);
			await this.tidy(handle);
		} else {
			known.runningSince ??= info.startedAt;
			// A connect only ever pushes the timeout out.
			if (known.holds === 0) known.deadline = Math.max(info.endAt, now + this.settings.idleTimeoutMs);
		}
		// The deployment's mode, whatever the sandbox was made with: E2B's configuration replaced as a whole and the
		// names written again (a resume may have rewritten them). Metadata cannot be changed after create, so a
		// sandbox once out of `open` is set at every connect. Open to open changes nothing, as before network modes.
		if (info.metadata[META.network] || network.mode !== "open") {
			try {
				await this.serial(id, async () => {
					await this.client.updateNetwork(id, networkConfig(network));
					await this.guestNetwork(connection, network);
				});
			} catch (error) {
				throw new Error(
					`could not set the sandbox's network to WLP_E2B_NETWORK=${this.network.mode}: ${messageOf(error)}`,
				);
			}
		}
		return handle;
	}

	async inspect(id: string): Promise<SandboxObservation> {
		const info = await this.ours(id);
		if (!info) return { state: "none" };
		// For a paused VM getInfo returns the last pause time. For a running VM endAt is a future deadline.
		return info.state === "paused" ? { state: "paused", pausedAt: info.endAt } : { state: "running" };
	}

	async suspend(id: string): Promise<void> {
		const info = await this.ours(id);
		if (info === undefined) return;
		if (info.metadata[META.environmentBuild] === "true") {
			await this.client.kill(id);
			this.ended(info, "killed", "the environment build has no workspace to keep");
			this.forget(id);
			return;
		}
		if (info.state !== "running") return;
		if (!this.settings.pause) {
			// Said plainly, each time: without a pause there is nothing to come back to.
			await this.client.kill(id);
			this.ended(
				info,
				"killed",
				"WLP_E2B_PAUSE=0, so it was killed where it would have been paused: the files in its workspace and its Windlass session are lost",
			);
			return;
		}
		// The access token file a turn that was cut off left behind. A turn that ended removed its own.
		const connection = await this.client.connect(id, this.settings.idleTimeoutMs).catch(() => undefined);
		if (connection !== undefined) {
			const path = tokenFilePath(id, DATA_DIR);
			const made = sandboxProfile(info.metadata);
			await new E2bSandboxHandle(
				this,
				connection,
				id,
				info.metadata[META.uid] ?? "",
				made,
				findProfile(made).approval,
			).removeFiles(tokenFilePaths(path));
		}
		for (let attempt = 1; ; attempt += 1) {
			try {
				await this.client.pause(id);
				break;
			} catch (error) {
				// E2B is still writing an earlier snapshot of it: the sandbox goes on running, and a little later the pause works.
				if (!(error instanceof E2bBusyError) || attempt >= PAUSE_TRIES)
					throw new Error(
						`could not pause the sandbox (its own timeout pauses it within ${Math.round(this.settings.idleTimeoutMs / 1000)} s): ${messageOf(error)}`,
					);
				await this.sleep(PAUSE_RETRY_MS);
			}
		}
		this.ended(info, "paused");
	}

	async destroy(id: string): Promise<void> {
		const info = await this.ours(id);
		if (info === undefined) return;
		await this.client.kill(id);
		this.ended(info, "killed");
		this.forget(id);
	}

	/**
	 * A turn starts in the sandbox: from now until the returned function is called, this server pushes the
	 * sandbox's timeout out again and again, so the sandbox runs for as long as the turn and stops soon
	 * after a server that died. Before that, a sandbox that has too little left of the time the plan lets
	 * it run without a pause is paused and resumed, which starts that time again (`refresh: false` leaves
	 * that out: for a command that is already running, which a pause would cut off).
	 */
	async holdFor(handle: E2bSandboxHandle, options: { refresh?: boolean } = {}): Promise<() => Promise<void>> {
		const id = handle.id;
		const known =
			this.known.get(id) ??
			this.remember({
				sandboxId: id,
				templateId: "",
				state: "running",
				metadata: { [META.uid]: handle.uid, [META.size]: handle.size },
				startedAt: this.now(),
				endAt: this.now(),
				cpuCount: 0,
				memoryMB: 0,
			});
		known.holds += 1;
		if (known.holds === 1) {
			try {
				const ran = known.runningSince === null ? 0 : this.now() - known.runningSince;
				const needed = this.settings.turnLimitMs + this.settings.turnLeaseMs;
				// Only where a pause helps: a turn that would not fit into a whole fresh period is not helped by starting one.
				if (
					options.refresh !== false &&
					this.settings.pause &&
					needed < this.settings.maxRuntimeMs &&
					ran + needed > this.settings.maxRuntimeMs
				)
					await this.refresh(handle, known, ran);
				await this.client.setTimeout(id, this.settings.turnLeaseMs);
				known.deadline = this.now() + this.settings.turnLeaseMs;
			} catch (error) {
				known.holds -= 1;
				throw error;
			}
			let failed = false;
			known.keepalive = setInterval(
				() => {
					this.client.setTimeout(id, this.settings.turnLeaseMs).then(
						() => {
							known.deadline = this.now() + this.settings.turnLeaseMs;
							failed = false;
						},
						(error: unknown) => {
							// Once per failure, not once a minute: the turn finds out by itself when its sandbox stops.
							if (!failed)
								this.log(
									`[wlp] e2b.keepalive_failed id=${id}: the sandbox's timeout could not be pushed out (${messageOf(error)}); unless that changes it stops ${Math.max(0, Math.round((known.deadline - this.now()) / 1000))} s from now, and the turn in it with it`,
								);
							failed = true;
						},
					);
				},
				Math.max(1_000, Math.floor(this.settings.turnLeaseMs / 3)),
			);
			// A turn that has ended otherwise must not be kept alive by this.
			known.keepalive.unref?.();
		}
		let released = false;
		return async () => {
			if (released) return;
			released = true;
			known.holds -= 1;
			if (known.holds > 0) return;
			clearInterval(known.keepalive);
			known.keepalive = undefined;
			// Back to the short timeout: from here the sandbox waits for the next `connect`, and not for long.
			await this.client.setTimeout(id, this.settings.idleTimeoutMs).then(
				() => {
					known.deadline = this.now() + this.settings.idleTimeoutMs;
				},
				() => undefined,
			);
		};
	}

	/**
	 * Removes the access token files of the user's turns that are running now, each in its session's
	 * sandbox: for a sign-in that was forgotten. A paused sandbox is left alone; what it holds is removed
	 * when it is next resumed (`tidy`).
	 */
	async forgetTokenFiles(uid: string): Promise<void> {
		if (!NAME.test(uid)) return;
		const running = await this.client.list({
			metadata: { [META.deployment]: this.settings.deployment, [META.uid]: uid },
			state: ["running"],
		});
		await Promise.all(
			running.map(async info => {
				const connection = await this.client.connect(info.sandboxId, this.settings.idleTimeoutMs);
				if (connection === undefined) return;
				const path = tokenFilePath(info.sandboxId, DATA_DIR);
				const made = sandboxProfile(info.metadata);
				await new E2bSandboxHandle(this, connection, info.sandboxId, uid, made, findProfile(made).approval).removeFiles(
					tokenFilePaths(path),
				);
			}),
		);
	}

	/** The source of a sandbox made from snapshot `from`: as this process recorded it at create, else from the record in it. Throws when that record is not the snapshot's. */
	private async sourceFor(handle: E2bSandboxHandle, info: E2bSandboxInfo, from: string): Promise<SnapshotSource> {
		const cached = this.sources.get(info.sandboxId);
		if (cached) return cached;
		let record: unknown = null;
		try {
			record = JSON.parse(await handle.readTextFile(RECORD_PATH));
		} catch {
			record = null;
		}
		const attempt = info.metadata[SNAP_META.attempt] ?? "";
		// Snapshots turned off since: the sandbox is still one made from a snapshot, and is judged by its record.
		if (!this.snapshotRecords.recordFits(record, from, handle.uid) || !/^[a-f0-9]{32}$/.test(attempt))
			throw new Error("Invalid prepared sandbox record");
		const r = record as SnapshotRecord;
		const source = {
			attempt,
			repo: r.repo,
			inputs: r.inputs,
			generation: r.generation,
			commit: r.commit,
			created: r.created,
		};
		this.sources.set(info.sandboxId, source);
		return source;
	}

	/**
	 * Saves the sandbox's disk as the post-setup snapshot of its user and repository (snapshots.ts). Only a
	 * sandbox made cold for this very request and template build, as a writer, and only when the audit
	 * finds nothing on its disk that must not be in one. False for every refusal, with a log line that says
	 * which; never throws.
	 */
	private async saveSetupSnapshot(store: E2bSnapshots, id: string, source: SnapshotSource): Promise<boolean> {
		if (this.snapshotsRefused) return false;
		if (
			!/^[1-9]\d{0,19}$/.test(source.repo) ||
			!HASH.test(source.generation) ||
			!HASH.test(source.inputs) ||
			source.inputs === DEFERRED_INPUTS ||
			!SHA.test(source.commit) ||
			!Number.isSafeInteger(source.created) ||
			!/^[a-f0-9]{32}$/.test(source.attempt)
		)
			return false;
		const refused = (why: string) => {
			this.log(`[wlp] e2b.snapshot.not_saved id=${id}: ${why}`);
			return false;
		};
		try {
			const info = await this.ours(id);
			if (info === undefined || info.state !== "running") return false;
			const m = info.metadata,
				uid = m[META.uid] ?? "";
			if (!NAME.test(uid) || m[SNAP_META.from] || m[SNAP_META.attempt] !== source.attempt || !m[SNAP_META.candidate])
				return refused("it was not made for this save");
			const screenshots = m[SNAP_META.variant] === "shots";
			const size = sandboxSize(m);
			const build = await store.build(store.templateOf(screenshots, size));
			if (build === null || build !== m[SNAP_META.build])
				return refused("the template was rebuilt since the sandbox was made");
			const profile = sandboxProfile(m);
			const key = store.key(source, uid, profile, screenshots, build, size);
			if (m[SNAP_META.candidate] !== key && m[SNAP_META.candidate] !== store.coldKey(source, uid, profile))
				return refused("its setup is not the one it was made for");
			const connection = await this.client.connect(id, this.settings.idleTimeoutMs);
			if (connection === undefined) return false;
			const handle = new E2bSandboxHandle(this, connection, id, uid, profile, findProfile(profile).approval);
			// E2B writes the image while the sandbox is paused for a moment; its own short timeout must not run out meanwhile.
			const release = await this.holdFor(handle, { refresh: false });
			try {
				const audit = await handle.rootAnswer(AUDIT_SCRIPT, [DATA_DIR], { timeoutMs: 120_000 });
				const answer = audit?.stdout.trim().split("\n").pop() ?? "";
				const ok = /^ok (\d+)$/.exec(answer);
				if (ok === null)
					return refused(
						/^refused [a-z-]+$/.test(answer) ? `the disk check ${answer} it` : "the disk check gave no answer",
					);
				const used = Number(ok[1]);
				if (used > store.limits.maxBytes)
					return refused(`its disk holds ${Math.round(used / 2 ** 20)} MiB, more than WLP_E2B_SNAPSHOT_MAX_GB allows`);
				const record: SnapshotRecord = {
					v: 1,
					deployment: this.settings.deployment,
					uid,
					repo: source.repo,
					key,
					inputs: source.inputs,
					generation: source.generation,
					commit: source.commit,
					created: source.created,
				};
				const written = await handle.rootAnswer(RECORD_SCRIPT, [], {
					stdin: JSON.stringify(record),
					timeoutMs: 30_000,
				});
				if (written?.stdout.trim() !== "written") return refused("its record could not be written");
				const name = store.nameFor(uid, source.repo, source.generation, key, this.now());
				const began = this.now();
				try {
					await this.client.createSnapshot(id, name);
				} catch (error) {
					if (error instanceof E2bSnapshotModeError) {
						this.snapshotsRefused = true;
						return refused(
							`E2B takes no filesystem-only snapshot for this account (${messageOf(error).slice(0, 200)}); a memory snapshot is never taken instead, and this server tries no other save until it restarts`,
						);
					}
					return refused(`E2B could not make the snapshot: ${messageOf(error).slice(0, 200)}`);
				}
				this.log(
					`[wlp] e2b.snapshot.saved name=${name} id=${id} uid=${uid}: ${Math.round(used / 2 ** 20)} MiB on its disk, ${Math.round((this.now() - began) / 1000)} s to save`,
				);
				await store
					.prune(name)
					.catch((error: unknown) => this.log(`[wlp] e2b.snapshot.prune_deferred: ${messageOf(error)}`));
				return true;
			} finally {
				await release();
			}
		} catch (error) {
			return refused(messageOf(error).slice(0, 300));
		}
	}

	/** The deployment's sandboxes that run now, by E2B's own list. */
	private async runningCount(): Promise<number> {
		const rows = await this.client.list({
			metadata: { [META.deployment]: this.settings.deployment },
			state: ["running"],
		});
		return rows.length;
	}

	private async assertRoom(): Promise<void> {
		const running = await this.runningCount();
		if (running < this.settings.maxRunning) return;
		this.log(
			`[wlp] e2b.cap_reached deployment=${this.settings.deployment}: ${running} of at most ${this.settings.maxRunning} sandboxes are running; none was started`,
		);
		throw new DeploymentFull(this.settings.maxRunning, capReached(this.settings.maxRunning));
	}

	/** The sandbox, when it exists and is this deployment's. */
	private async ours(id: string): Promise<E2bSandboxInfo | undefined> {
		if (typeof id !== "string" || !SANDBOX_ID.test(id)) return undefined;
		const info = await this.client.info(id);
		const known = this.known.get(id);
		if (info === undefined || info.metadata[META.deployment] !== this.settings.deployment) {
			if (info === undefined && known !== undefined) {
				this.stoppedByItself(id, known, "is gone");
				this.forget(id);
			}
			return undefined;
		}
		if (info.state === "paused" && known !== undefined) this.stoppedByItself(id, known, "was paused");
		return info;
	}

	private remember(info: E2bSandboxInfo): Known {
		let known = this.known.get(info.sandboxId);
		if (known === undefined) {
			known = {
				uid: info.metadata[META.uid] ?? "",
				session: info.metadata[META.session] ?? "",
				cpuCount: info.cpuCount,
				memoryMB: info.memoryMB,
				runningSince: null,
				deadline: info.endAt,
				holds: 0,
				keepalive: undefined,
			};
			this.known.set(info.sandboxId, known);
		}
		const spec = HOSTED_SIZE_SPECS[sandboxSize(info.metadata)];
		// E2B's own figures where it gives them; else the size's (a sandbox remembered before it was asked about).
		known.cpuCount = info.cpuCount > 0 ? info.cpuCount : known.cpuCount || spec.cpus;
		known.memoryMB = info.memoryMB > 0 ? info.memoryMB : known.memoryMB || spec.memoryMiB;
		return known;
	}

	private forget(id: string): void {
		const known = this.known.get(id);
		if (known?.keepalive !== undefined) clearInterval(known.keepalive);
		this.known.delete(id);
		this.hardened.delete(id);
	}

	/** The sandbox stopped running through this server: one line with how long it ran and what that costs, by estimate. */
	private ended(info: E2bSandboxInfo, how: "paused" | "killed", note = ""): void {
		const known = this.remember(info);
		const since = info.state === "running" ? (known.runningSince ?? info.startedAt) : null;
		const ran =
			since === null
				? "it was paused already, so nothing ran"
				: `it ran ${describeUsage((this.now() - since) / 1000, known.cpuCount, known.memoryMB, this.settings.rateCard)}`;
		known.runningSince = null;
		this.log(
			`[wlp] e2b.sandbox.${how} id=${info.sandboxId} uid=${known.uid} session=${known.session}: ${ran}${note === "" ? "" : `; ${note}`}`,
		);
	}

	/** This server last saw the sandbox running and now it is not: its own timeout stopped it. How long it ran is known to the timeout at most. */
	private stoppedByItself(id: string, known: Known, what: string): void {
		if (known.runningSince === null) return;
		const until = Math.min(this.now(), known.deadline);
		// A sandbox that is gone may have been killed from outside (the E2B console, a cleanup), not only by its timeout.
		const how =
			what === "is gone" ? "is gone: removed outside this server, or by its own timeout" : `${what} by its own timeout`;
		this.log(
			`[wlp] e2b.sandbox.${what === "is gone" ? "gone" : "timed_out"} id=${id} uid=${known.uid} session=${known.session}: it ${how}; it ran at most ${describeUsage(Math.max(0, until - known.runningSince) / 1000, known.cpuCount, known.memoryMB, this.settings.rateCard)}`,
		);
		known.runningSince = null;
	}

	/** Pauses the sandbox and resumes it, which starts the time the plan lets it run without a pause again. */
	private async refresh(handle: E2bSandboxHandle, known: Known, ran: number): Promise<void> {
		const id = handle.id;
		this.log(
			`[wlp] e2b.sandbox.refreshed id=${id}: it has run ${Math.round(ran / 60_000)} min of the ${Math.round(this.settings.maxRuntimeMs / 60_000)} the plan allows without a pause, which leaves too little for a turn, so it is paused and resumed before the turn starts`,
		);
		await this.client.pause(id);
		const connection = await this.client.connect(id, this.settings.idleTimeoutMs);
		if (connection === undefined) throw new Error("the sandbox was gone after it was paused");
		// A resume like any other: hardened again before the turn starts in it, or paused again and not used.
		await this.harden(id, connection).catch(async (error: unknown) => {
			await this.client.pause(id).catch(() => undefined);
			throw error;
		});
		handle.connection = connection;
		known.runningSince = this.now();
	}

	/**
	 * What a sandbox that was just resumed may still hold of a turn that was cut off with its server: E2B
	 * restores memory too, so that turn's Windlass would go on working, with nobody listening, on the
	 * access token in its file. Both are removed before anything else happens in the sandbox.
	 */
	private async tidy(handle: E2bSandboxHandle): Promise<void> {
		const path = tokenFilePath(handle.id, DATA_DIR);
		const stopped = await handle.stopLeftovers("windlass").catch(() => 0);
		await handle.removeFiles(tokenFilePaths(path));
		if (stopped > 0)
			this.log(
				`[wlp] e2b.sandbox.tidied id=${handle.id}: stopped ${stopped} Windlass run(s) that a turn cut off before the pause had left in it`,
			);
	}
}
