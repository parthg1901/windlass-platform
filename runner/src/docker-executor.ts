// Executes a pairing's sandbox operations through Docker. Serialize lifecycle changes and act only on pairing-owned resources.
import { randomBytes } from "node:crypto";
import { SpareBuildError, WarmSpares, validSpec, SPARE_SESSION, type SpareSpec } from "./warm-spares.js";
import {
	cloneCommand,
	cloneReadyBase,
	refreshReadyClone,
	WORKSPACE_HEAD_COMMAND,
} from "../../server/src/github/git.js";
import { runSetupCommand } from "../../server/src/sandbox/setup.js";
import { spareSetup, type SpareSetup, type SpareRecipe } from "../../server/src/runner/spare-recipe.js";
import { dropPreviousSnapshots } from "./snapshot-retention.js";
import { digest, type SnapshotSelection, type SnapshotSource } from "../../server/src/sandbox/snapshot-key.js";
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import { MODEL_PROVIDERS, type HarnessOptions, type ModelProvider } from "../../server/src/contract.js";
import { innerModesReason, reportedCodexModes } from "../../server/src/sandbox/codex-modes.js";
import { codexLogin } from "./codex-login.js";
import { PROFILE_RUN_FLAGS } from "../../server/src/sandbox/docker-flags.js";
import { commonRunFlags } from "../../server/src/sandbox/profiles.js";
import { tmpName } from "../../server/src/sandbox/docker.js";
import { currentProvider, installedProvider } from "./opencode-login.js";
import {
	ensureRelay,
	prepareRelay,
	localProviders,
	relaySocketVolume,
	openHarnessKey,
	endHarnessLeases,
	removeRelay,
	stopLegacyClaude,
} from "./claude-relay.js";
import { probeHarnessOptions } from "./harness-options.js";
import claudePackage from "../../sandbox/harness/claude/package.json";
import { MAX_REPORTED_SANDBOXES, type Report } from "../../server/src/runner/control.js";
import { PROFILE_DENIED, type Args, type Operation, type Value } from "../../server/src/runner/protocol.js";
import { BackupStore, dockerBackupIO } from "./session-backups.js";
import { ENVIRONMENT_SLOT_WAIT, SandboxUserError } from "../../server/src/sandbox/api.js";
import { LABEL, LABEL_ARG, docker } from "../../server/src/sandbox/docker.js";
import { DOCKER_BWRAP_PROBE } from "../../server/src/sandbox/docker-flags.js";
import { NAME, WORKSPACE, type ForwardedKeyLease } from "../../server/src/sandbox/provider.js";
import {
	containerName,
	removeRunningTokenFiles,
	DockerSandboxes,
	DockerSandboxHandle,
} from "../../server/src/sandbox/sandboxes.js";
import { tokenFilePath } from "../../server/src/sandbox/token-file.js";
import { mirrorOwner, saveSessionMirror } from "../../server/src/sandbox/git-mirrors.js";
import {
	clampStoreLimits,
	DEFAULT_STORE_LIMITS,
	type StoreCaps,
	type StoreLimits,
} from "../../server/src/sandbox/store-limits.js";
import { DockerModelRelay } from "../../server/src/sandbox/model-relay.js";
import { readsModelRelay } from "../../server/src/model-relay-url.js";
import { probeImage } from "../../server/src/sandbox/tokens.js";
import { audit, safeSentence } from "./audit.js";
import {
	bubblewrap,
	checkBubblewrap,
	externalId,
	harnessImage,
	image,
	shotsImage,
	MachineDocker,
	rawId,
	type Limits,
	type Profile,
	type MachineHarness,
} from "./policy.js";
import { localSizing } from "./sizing.js";
import { harnessOfRaw, MACHINE_HARNESSES, SESSION_NAME } from "./machine-harnesses.js";
import { isMachineHarness } from "./setup-choices.js";
const legacyLoginLabel = LABEL + ".claude-login=1";
import { cleanClaudeOutput } from "./claude-output.js";
import {
	claudeLoginGeneration,
	dockerReason,
	loginFileState,
	dropDetachedLoginVolume,
	retireClaudeRelay,
	withLoginVolume,
} from "./harness-login.js";
import { open, type Egress } from "./egress-policy.js";
import { EgressNetwork } from "./egress-network.js";
import { forget, loadPair, read, Refusal, RunnerError, save, VERSION, type Identity } from "./state.js";

// Stop each relay under its own login-volume lock. The pairing keeps the credentials.
export async function retirePairingRelays(machine: MachineDocker) {
	await retireClaudeRelay(machine);
	if (codexLogin(machine)) await withLoginVolume(machine, () => removeRelay(machine, "codex"));
	if (currentProvider(machine)) await withLoginVolume(machine, () => removeRelay(machine, "opencode"));
}

type Lifecycle = Extract<Operation, { name: "connect" | "state" | "suspend" | "destroy" }>;
// A newly created or rediscovered box holds its slot until its first observed turn ends.
export interface Box {
	activeTurns?: number;
	size?: number;
	claim?: Claim;
	startTimes?: { spare?: true; image: number; pulled?: true; create: number };
	resizePending?: true;
	snapshotCandidate?: boolean;
	savingSnapshot?: boolean;
	egress?: string;
	legacyClaude?: boolean;
	raw: string;
	sessionId: string;
	state: "running" | "paused";
	profile: Profile;
	harness?: MachineHarness;
	usedAt: number;
	busy: number;
	workspaceChecked: boolean;
}

// Docker's archive HEAD stats just the path, even in a stopped or paused container.
// Use the CLI's daemon connection so this also respects the owner's Docker context.
async function hasWorkspaceGit(raw: string) {
	const path = `/containers/${containerName(raw)}/archive?path=${WORKSPACE}/.git`;
	const result = await docker(["system", "dial-stdio"], {
		stdin: `HEAD ${path} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n`,
		timeoutMs: 30_000,
	});
	if (result.code === 0) {
		if (result.stdout.startsWith("HTTP/1.1 200 ")) return true;
		if (result.stdout.startsWith("HTTP/1.1 404 ")) return false;
	}
	throw new RunnerError("Docker could not check the sandbox workspace.");
}

// Health checks need Docker's diagnostic itself, without the CLI wrapper's command and exit status.
async function dockerOutput(args: string[]) {
	try {
		const result = await docker(args);
		if (result.code === 0) return result.stdout;
		throw new Error(result.stderr.trim() || result.stdout.trim() || "Docker exited without a diagnostic.");
	} catch (error) {
		let line = error instanceof Error ? cleanClaudeOutput(error.message).split(/[\r\n]/, 1)[0] : "";
		// Docker may echo a setting (including a credential) verbatim in its diagnostic.
		for (const value of Object.values(process.env)
			.filter((v): v is string => !!v)
			.sort((a, b) => b.length - a.length)) {
			line = line.replaceAll(value, "[redacted]");
		}
		line = line
			.replace(/\b(?!unix:)[a-z][a-z0-9+.-]*:\/\/\S+|\bBasic\s+\S+/gi, "[redacted]")
			.replace(/\b(?:token|password|secret|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "[redacted]");
		throw new RunnerError(safeSentence(line).trim().slice(0, 500) || "Docker did not provide a diagnostic.");
	}
}

const INVENTORY_TTL_MS = 6 * 60 * 60_000;
const SIGN_IN_RETRIES_MS = [10_000, 30_000, 60_000];
const INVENTORY_RETRY_MS = 5 * 60_000;

interface Claim {
	session: string;
	key: string;
	setup?: SpareSetup;
	attempt?: string;
}

// The Docker session label is immutable. The pairing's private state binds each claimed
// id exactly once, before any session can receive it. Unbound spares never enter boxes.
function claimFor(value: unknown): Claim | undefined {
	if (
		value &&
		typeof value === "object" &&
		"session" in value &&
		typeof value.session === "string" &&
		NAME.test(value.session) &&
		"key" in value &&
		typeof value.key === "string" &&
		/^[a-f0-9]{64}$/.test(value.key) &&
		(!("setup" in value) || spareSetup(value.setup)) &&
		(!("attempt" in value) || (typeof value.attempt === "string" && /^[a-f0-9]{32}$/.test(value.attempt)))
	)
		return value as Claim;
}

export class Executor extends MachineDocker {
	readonly provider: DockerSandboxes;
	readonly network: EgressNetwork;
	readonly slots: Report["slots"];
	get maxTurns() {
		return this.slots?.max;
	}
	readonly boxes = new Map<string, Box>();
	warmSpares = false;
	spareSetupTimes = false;
	spareReseed = false;
	// A restart forgets all demand. Only a fresh signed recipe from a resumed session can restore it.
	private needsSpareSeed = true;
	private readonly spares = new WarmSpares(
		(raw, spec, signal) => this.buildSpare(raw, spec, signal),
		raw => this.removeUnbound(raw),
		Date.now,
		() => this.publishReport?.(),
	);
	private waitForTurn?: string;
	private lastSpareSkip?: string;
	private readonly availableMemory = process.availableMemory;
	private nextSpareDisk = 0;
	private spareDisk = 0;
	private readonly unbound = new Set<string>();
	private claimFile(raw: string) {
		return `claim-${this.identity.machineId}-${raw}.json`;
	}
	private spareContext() {
		return digest([
			this.identity.uid,
			this.identity.machineId,
			VERSION,
			image,
			shotsImage,
			this.claudePin,
			this.codexPin,
			this.opencodePin,
			this.network.policy,
			this.network.domains(),
			this.slots,
			this.screenshots,
			this.allowedProfiles,
			this.sessionVolumes,
		]);
	}
	private async dropSpare(raw: string) {
		const rows = await dockerOutput([
			"ps",
			"-aq",
			...this.filters(),
			"--filter",
			"label=" + LABEL + ".session=" + SPARE_SESSION,
			"--filter",
			"name=^/" + containerName(raw) + "$",
		]);
		if (claimFor(read(this.claimFile(raw)))) return;
		// A previous removal may have left just the pairing's labelled helpers.
		try {
			await this.network.detach(raw);
		} finally {
			if (rows.trim()) await this.provider.destroy(raw);
		}
	}
	private async buildSpare(raw: string, spec: SpareSpec, signal: AbortSignal) {
		const { spare, profile, harness, prepared, screenshots, size, mirrorRepo } = spec.args;
		const { uid } = this.identity;
		if (read(this.claimFile(raw)) !== undefined) throw new SpareBuildError("bound");
		if ((await this.disk()) <= Math.max(5e9, this.storeLimits().free)) throw new SpareBuildError("disk");
		signal.throwIfAborted();
		if (harness) this.requireHarness(profile, harness);
		this.requireProfile(profile);
		const provider = this.providerFor(harness);
		await provider.create({
			reservedId: raw.slice(-12),
			uid,
			sessionId: SPARE_SESSION,
			profile,
			harness,
			screenshots,
			size,
			mirrorRepo,
			deferredRelayNonce: harness ? randomBytes(16).toString("hex") : undefined,
			fromSnapshot: prepared && { ...prepared, attempt: randomBytes(16).toString("hex") },
			ownData: harness ? undefined : "required",
		});
		signal.throwIfAborted();
		await this.network.attach(raw, containerName(raw), false);
		const box = await provider.connect(raw, { ownData: true });
		if (!box || (!harness && !box.ownData)) throw new SpareBuildError("private-data");
		signal.throwIfAborted();
		if (profile === bubblewrap) {
			const probe = await checkBubblewrap(timeoutMs => box.ask(DOCKER_BWRAP_PROBE, { timeoutMs }), signal);
			if (!probe.ok) throw new SpareBuildError("bubblewrap");
		}
		if (prepared) {
			if (!box.snapshot || box.snapshot.inputs !== prepared.inputs || box.snapshot.generation !== prepared.generation)
				throw new SpareBuildError("snapshot");
			// The platform refreshes and validates this image through restorePrepared after claim.
			return;
		}
		const c = spare.connected;
		if (!c) {
			const result = await box.run(cloneCommand(spare.url), { timeoutMs: 180_000, signal });
			if (result.exitCode !== 0) throw new SpareBuildError("clone");
		} else {
			if (!(await cloneReadyBase(box, spare.url, c.branch, c.commit, mirrorOwner(uid, c.repo), signal)))
				throw new SpareBuildError("base");
			let setup: SpareSetup | undefined;
			if (c.command) {
				const startedAt = Date.now();
				const result = await runSetupCommand(box, { command: c.command, cwd: box.cwd, timeoutMs: c.timeoutMs, signal });
				if (result.state !== "succeeded") throw new SpareBuildError("setup");
				setup = { startedAt, durationMs: result.durationMs };
			}
			// Check after setup, off the claim path. No process or socket can use a
			// ready container between this check and its single claim.
			const head = await box.run(WORKSPACE_HEAD_COMMAND, { timeoutMs: 30_000, signal });
			if (head.exitCode !== 0 || head.stdout.trim() !== c.commit) throw new SpareBuildError("changed-base");
			return setup;
		}
	}
	private async verifySpare(raw: string, built: SpareSpec, spec: SpareSpec) {
		const { spare, prepared } = spec.args,
			c = spare.connected;
		const box = await this.provider.connect(raw, { ownData: true });
		if (
			!box ||
			(!spec.args.harness && !box.ownData) ||
			box.uid !== this.identity.uid ||
			box.profile !== spec.args.profile
		)
			return false;
		if (prepared)
			return (
				!!box.snapshot &&
				!!box.image &&
				box.image ===
					(await this.provider.selectedImage(prepared, this.identity.uid, spec.args.profile, !!spec.args.screenshots))
			);
		// A connected request carries a freshly authorized GitHub ref. Setup may depend
		// on any source file, so its outputs cannot be carried to a different commit.
		if (c && c.commit === built.args.spare.connected?.commit) return true;
		if (c?.command) return false;
		return (await box.run(refreshReadyClone(spare.url, c?.branch, c?.commit), { timeoutMs: 10_000 })).exitCode === 0;
	}
	/** Each machine harness's pinned image and provider, set only when the runner was started with it. */
	private installed(harness: MachineHarness) {
		return {
			claude: { pin: this.claudePin, provider: this.claudeProvider },
			codex: { pin: this.codexPin, provider: this.codexProvider },
			opencode: { pin: this.opencodePin, provider: this.opencodeProvider },
		}[harness];
	}
	private providerFor(harness?: MachineHarness) {
		return harness ? this.installed(harness).provider! : this.provider;
	}
	private relayNonce(raw: string) {
		return dockerOutput([
			"inspect",
			"-f",
			`{{index .Config.Labels "${LABEL}.relay-session"}}`,
			containerName(raw),
		]).then(value => value.trim());
	}

	openTurnKey(raw: string, harness: MachineHarness, forward: ForwardedKeyLease) {
		return withLoginVolume(this, async () => {
			return openHarnessKey(this, harness, await this.relayNonce(raw), forward);
		});
	}

	turnCredentials(raw: string, harness: MachineHarness, keys: Partial<Record<ModelProvider, string>>) {
		return withLoginVolume(this, async (): Promise<{ env: Record<string, string>; close?: () => Promise<void> }> => {
			const record = MACHINE_HARNESSES[harness];
			const env = record.keyEnv(keys);
			if (env) return { env };
			const login = record.machineLogin(this) ?? undefined;
			if (!login && record.needsLogin && !Object.keys(keys).length)
				throw new Refusal(`Run windlass-runner login ${harness} on this machine.`);
			const nonce = await this.relayNonce(raw);
			if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Refusal("Invalid session relay nonce.");
			return record.credentials(this, nonce, login, keys);
		});
	}

	private get spareMemoryMargin() {
		return Math.max(2 ** 30, this.slots?.reserve.memoryBytes ?? 0);
	}
	private spareRoom(size = 1) {
		const running = [...this.boxes.values()].filter(b => b.state === "running");
		const max = this.maxTurns ?? 1;
		const runningUnits = running.reduce((n, box) => n + (box.size ?? 1), 0);
		const idle = this.slots
			? running.reduce((n, box) => n + (box.activeTurns === 0 && !box.savingSnapshot ? (box.size ?? 1) : 0), 0)
			: 0;
		const capacity = Math.min(
			this.limits.spares ?? 1,
			(this.limits.maxRunning ?? Infinity) - running.length,
			(this.limits.maxSandboxes ?? Infinity) - this.boxes.size,
		);
		if (capacity <= 0) return "container-limit";
		const turnRoom = Math.floor((max - runningUnits + idle) / size);
		if (turnRoom <= 0) return "turn-slots";
		if (!this.slots) return Math.min(capacity, turnRoom);

		const unit = this.slots.unit.memoryBytes;
		const budget = Math.floor(((this.limits.sandboxMemory ?? Infinity) / unit - runningUnits) / size);
		// Existing containers already count against available memory. Each new spare fills
		// a foreground slot, so the same memory covers both reservations.
		const pooled = this.spares.raws.length;
		const uncovered = Math.max(0, max - runningUnits - this.spares.units) * unit;
		const available = this.availableMemory() - this.spareMemoryMargin;
		const memoryRoom = available >= uncovered ? pooled + Math.floor(available / (size * unit)) : 0;
		const limit = Math.min(capacity, turnRoom, budget, memoryRoom);
		return limit > 0 ? limit : "memory";
	}
	// A background build needs a slot alongside every kept running box and spare.
	private environmentFits(size: number) {
		const running = [...this.boxes.values()].filter(box => box.state === "running");
		const units = running.reduce((sum, box) => sum + (box.size ?? 1), size) + this.spares.units;
		const pooled = this.spares.raws.length;
		const uncovered = Math.max(0, (this.maxTurns ?? 1) - units);
		return (
			units <= (this.maxTurns ?? 1) &&
			running.length + pooled < (this.limits.maxRunning ?? Infinity) &&
			this.boxes.size + pooled < (this.limits.maxSandboxes ?? Infinity) &&
			(!this.slots ||
				(units * this.slots.unit.memoryBytes <= (this.limits.sandboxMemory ?? Infinity) &&
					this.availableMemory() >= (size + uncovered) * this.slots.unit.memoryBytes + this.spareMemoryMargin))
		);
	}
	private skipSpare(reason: string) {
		if (this.lastSpareSkip !== reason) console.info(`spare.skip reason=${reason}`);
		this.lastSpareSkip = reason;
		return this.spares.trim();
	}
	private waitForSpareRemoval(size: number) {
		return (
			this.freeDiskBytes === null ||
			this.freeDiskBytes <= this.storeLimits().free ||
			this.limits.maxRunning !== undefined ||
			this.limits.maxSandboxes !== undefined ||
			this.limits.sandboxMemory !== undefined ||
			(!!this.slots && this.availableMemory() < size * this.slots.unit.memoryBytes + this.spareMemoryMargin)
		);
	}
	private async removeUnbound(raw: string) {
		try {
			await this.dropSpare(raw);
			this.unbound.delete(raw);
		} catch {
			this.unbound.add(raw);
			console.warn(`Could not remove spare ${raw}.`);
		}
	}
	private async reapUnbound() {
		for (const raw of this.unbound) await this.removeUnbound(raw);
	}
	/** Preparation never owns the executor's serial queue. */
	async maintainSpares(online = () => true) {
		if (!this.inventoryStarted) return this.skipSpare("inventory");
		if (!this.warmSpares || !this.sessionVolumes) return this.skipSpare("capability");
		if (!this.dockerHealth.ok || this.egressError) return this.skipSpare("machine-health");
		if (this.limits.spares === 0) return this.skipSpare("disabled");
		const spec = this.spares.recipe;
		if (!spec) return this.skipSpare("no-recipe");
		if (spec.context !== this.spareContext()) return this.skipSpare("context");
		const limit = this.spareRoom(spec.args.size);
		if (typeof limit !== "number") return this.skipSpare(limit);
		if (this.waitForTurn && this.boxes.get(this.waitForTurn)?.state === "running") return this.spares.trim(limit, spec);
		if (Date.now() >= this.nextSpareDisk) {
			this.nextSpareDisk = Date.now() + 30_000;
			this.spareDisk = await this.disk().catch(() => 0);
		}
		if (this.spareDisk <= Math.max(this.storeLimits().free, 5e9)) return this.skipSpare("disk");
		// A create or resume can have reserved capacity without having published its
		// running box yet. Admit in its order, then build outside that order.
		await this.serial(async () => {
			if (!online() || !this.warmSpares || this.spares.recipe !== spec) return;
			const room = this.spareRoom(spec.args.size);
			if (typeof room !== "number") return;
			this.lastSpareSkip = undefined;
			this.spares.fill(room);
		});
	}
	stopSpares() {
		void this.spares.trim();
	}
	turnStarted(box: Box) {
		box.activeTurns = (box.activeTurns ?? 0) + 1;
		if (!this.spares.raws.length) return;
		const spec = this.spares.recipe;
		const room = spec && this.spareRoom(spec.args.size);
		const retiring = this.spares.trim(typeof room === "number" ? room : 0, spec);
		if (this.waitForSpareRemoval(box.size ?? 1)) return retiring;
	}
	turnEnded(box: Box) {
		box.activeTurns = Math.max(0, (box.activeTurns ?? 0) - 1);
		if (!box.activeTurns && this.waitForTurn === externalId(this.identity.machineId, box.raw))
			this.waitForTurn = undefined;
	}

	private readonly codexPin?: string;
	private readonly codexProvider?: DockerSandboxes;
	private codexCredential?: ReturnType<typeof codexLogin>;
	private codexOptions?: HarnessOptions;
	private codexGeneration?: string;
	private nextCodexProbe = 0;
	private codexInner?: boolean;
	private readonly opencodePin?: string;
	private readonly opencodeProvider?: DockerSandboxes;
	private opencodeLogin?: ReturnType<typeof currentProvider>;
	private opencodeOptions?: HarnessOptions;
	private probedLogin?: string;
	private readonly claudePin?: string;
	private readonly claudeProvider?: DockerSandboxes;
	private credentialPathChecked = false;
	private nextClaudeProbe = 0;
	private nextOpenCodeProbe = 0;
	private claudeOptions?: HarnessOptions;
	private claudeGeneration?: string;
	private signIn: "none" | "token" | "unknown" = "unknown";
	private signInReason?: string;
	private signInRetry?: ReturnType<typeof setTimeout>;
	private signInRetries = 0;
	private enforceEgress = false;
	private inventoryStarted = false;
	private egressError?: string;
	private pending: Promise<unknown> = Promise.resolve();
	private dockerHealth: Report["docker"] = { ok: false, reason: "Docker has not been checked." };
	publishReport?: () => void;
	private commandSandbox: Report["commandSandbox"] = { ok: false, reason: "The Windlass sandbox probe has not run." };
	private freeDiskBytes: number | null = null;
	// A peer without session-volumes expects the shared machine volume and would lose a workspace on the next turn.
	sessionVolumes = false;
	modelRelays = false;
	harnessKeyRelays = false;
	windlassKeyRelays = false;
	startTimes = false;
	blockedNetwork = false;
	memoryEvents = false;
	environmentImage = false;
	/** The server named `session-backups`: the runner keeps its sessions' copies (session-backups.ts). */
	sessionBackups = false;
	readonly backups: BackupStore;
	readonly modelRelay: DockerModelRelay;
	// Read from the pinned image at welcome. Windlass 0.7.1 supports all relay wires.
	private sandboxWindlass: string | null = null;
	private relaySwept = false;
	private readonly relayLeases = new Map<string, Set<() => Promise<void>>>();
	private nextVolumeSweep = 0;
	private storeCaps: StoreCaps = {};
	platformStoreCaps(caps: StoreCaps | undefined) {
		this.storeCaps = caps ?? {};
	}
	private reportedStoreLimits() {
		const limits = this.storeLimits(),
			requested = this.limits.store ?? DEFAULT_STORE_LIMITS;
		const capped =
			limits.machine !== requested.machine || limits.user !== requested.user || limits.free !== requested.free;
		return { ...limits, ...(capped && { capped: true as const }) };
	}
	storeLimits(): StoreLimits {
		return clampStoreLimits(this.limits.store ?? DEFAULT_STORE_LIMITS, this.storeCaps);
	}

	constructor(
		identity: Identity,
		private readonly limits: Limits,
		readonly screenshots = false,
		readonly claude = false,
		private readonly allowedProfiles: Profile[] = ["docker-hardened"],
		policy: Egress = open,
		readonly opencode = false,
		readonly codex = false,
	) {
		super(identity);
		this.slots =
			limits.slots === null ? undefined : (limits.slots ?? localSizing({ slots: limits.maxTurns?.toString() }));
		this.network = new EgressNetwork(this, policy);
		this.backups = new BackupStore(
			identity.uid,
			dockerBackupIO({
				volume: this.backupVolume,
				labels: this.labels,
				image,
				ownedVolume: create => this.ownedVolume(create, this.backupVolume),
			}),
		);
		this.modelRelay = new DockerModelRelay({
			machine: identity.machineId,
			image,
			labelFlags: this.pairingLabelFlags,
			ensureImage: async () => {
				await this.ensureImage();
			},
		});
		const network = this.network.sandboxNetwork();
		const slots = this.slots;
		const storeLimits = () => this.storeLimits();
		this.provider = new DockerSandboxes({
			slots,
			network,
			machine: identity.machineId,
			image,
			shotsImage,
			storeLimits,
			dataVolume: async (_uid, sandbox) => {
				const name = sandbox === undefined ? this.volume : this.sessionVolume(sandbox);
				await this.ownedVolume(true, name, sandbox);
				return name;
			},
			dropDataVolume: (_uid, sandbox) => this.dropVolume(this.sessionVolume(sandbox), sandbox),
			ownVolumeName: (_uid, sandbox) => this.sessionVolume(sandbox),
		});
		if (codex) {
			this.codexPin = harnessImage("codex");
			if (!this.codexPin) throw new Refusal("This runner was built without the Codex image.");
			this.codexProvider = new DockerSandboxes({
				slots,
				network,
				machine: identity.machineId,
				image: this.codexPin,
				harness: "codex",
				storeLimits,
				sessionRelay: () => this.sessionSocket("codex"),
			});
		}
		if (opencode) {
			this.opencodePin = harnessImage("opencode");
			if (!this.opencodePin) throw new Refusal("This runner was built without the OpenCode image.");
			this.opencodeProvider = new DockerSandboxes({
				slots,
				network,
				machine: identity.machineId,
				image: this.opencodePin,
				helperImage: image,
				storeLimits,
				harness: "opencode",
				sessionRelay: () => this.sessionSocket("opencode"),
			});
		}
		if (claude) {
			this.claudePin = harnessImage("claude");
			if (!this.claudePin) throw new Refusal("This runner was built without the Claude Code image.");
			this.claudeProvider = new DockerSandboxes({
				slots,
				network,
				machine: identity.machineId,
				image: this.claudePin,
				helperImage: image,
				storeLimits,
				sessionRelay: () => this.sessionSocket("claude"),
			});
		}
	}
	/** Give the forwarder a socket volume and a nonce before the first turn chooses its credential. */
	private async sessionSocket(harness: MachineHarness) {
		await this.ownedVolume(true, relaySocketVolume(this, harness));
		return { nonce: randomBytes(16).toString("hex"), env: [] };
	}
	prepareClaudeRelay() {
		return prepareRelay(this);
	}
	requireHarness(profile: Profile, harness: MachineHarness = "claude") {
		const record = MACHINE_HARNESSES[harness];
		// The pin and the provider are set together (constructor).
		if (!this.installed(harness).provider) throw new Refusal(record.notEnabled);
		if (profile !== "docker-hardened" && !(record.innerProfile && profile === bubblewrap && this.codexInner))
			throw new Refusal(record.profileRefusal);
	}
	async prepareHarness(profile: Profile, harness: MachineHarness = "claude") {
		this.requireHarness(profile, harness);
		const { pin } = this.installed(harness);
		const missing = MACHINE_HARNESSES[harness].missingImage;
		if (!missing) return this.ensureImage(pin);
		try {
			await this.ensureImage(pin);
		} catch {
			throw new Refusal(missing);
		}
	}
	private async refreshLogin() {
		if (this.codexPin) {
			const credential = codexLogin(this);
			this.codexCredential = credential && (await this.ownedVolume(false, this.codexVolume)) ? credential : undefined;
			if ((this.codexCredential?.generation ?? "signed-out") !== this.codexGeneration) this.codexOptions = undefined;
		}
		if (this.opencodePin) {
			this.opencodeLogin = await installedProvider(this);
			if ((this.opencodeLogin?.generation ?? "signed-out") !== this.probedLogin) this.opencodeOptions = undefined;
		}
		if (!this.claudePin) return;
		let reason: string | undefined;
		await withLoginVolume(this, async () => {
			this.signIn = await loginFileState(this, {
				start: true,
				why: why => {
					reason = why;
				},
			});
			this.claudeGeneration = this.signIn === "token" ? claudeLoginGeneration(this) : undefined;
		}).catch((error: unknown) => {
			this.signIn = "unknown";
			reason =
				error instanceof RunnerError
					? error.message
					: `the check could not run: ${error instanceof Error ? dockerReason(error.message) : "no reason given"}`;
		});
		this.signInChecked(reason);
	}
	/** Logs a new reason the sign-in could not be checked, once, and checks again soon while it is unknown. */
	private signInChecked(reason: string | undefined) {
		if (this.signIn !== "unknown") {
			if (this.signInReason !== undefined)
				console.log(`Claude Code sign-in checked: ${this.signIn === "token" ? "signed in" : "not signed in"}.`);
			this.signInReason = undefined;
			this.signInRetries = 0;
			clearTimeout(this.signInRetry);
			this.signInRetry = undefined;
			return;
		}
		const why = reason ?? "no reason given";
		if (why !== this.signInReason) console.log(`Could not check the Claude Code sign-in: ${why}`);
		this.signInReason = why;
		if (this.signInRetry !== undefined || this.signInRetries >= SIGN_IN_RETRIES_MS.length) return;
		const delay = SIGN_IN_RETRIES_MS[this.signInRetries++]!;
		this.signInRetry = setTimeout(() => {
			this.signInRetry = undefined;
			void this.serial(() => this.refreshLogin()).then(
				() => this.publishReport?.(),
				() => {},
			);
		}, delay);
		this.signInRetry.unref?.();
	}
	async loginChanged(signedIn: boolean) {
		await this.refreshLogin();
		if (signedIn) await this.restoreRelay();
		await this.refreshClaudeOptions(true);
		await this.refreshOpenCodeOptions(true);
		await this.refreshCodexOptions(true);
	}
	private async ensureSignedInRelay() {
		await withLoginVolume(this, async () => {
			if ((await loginFileState(this)) === "token") await ensureRelay(this);
		});
	}
	private async refreshCodexOptions(force = false) {
		const pin = this.codexPin;
		const login = this.codexCredential;
		const generation = login?.generation ?? "signed-out";
		if (!pin || (!force && generation === this.codexGeneration && Date.now() < this.nextCodexProbe)) return;
		this.codexGeneration = generation;
		this.nextCodexProbe = Date.now() + INVENTORY_RETRY_MS;
		let options: HarnessOptions | undefined;
		try {
			await this.ensureImage(pin);
			if (this.codexInner === undefined && this.allowedProfiles.includes(bubblewrap)) {
				let passed = true;
				for (const mode of ["read-only", "workspace-write"]) {
					const result = await docker(
						[
							"run",
							"--rm",
							"--name",
							tmpName(),
							"--pull",
							"never",
							"--log-driver",
							"none",
							...this.pairingLabelFlags,
							...commonRunFlags(1, "none"),
							...PROFILE_RUN_FLAGS[bubblewrap]!,
							pin,
							"codex",
							"-c",
							`sandbox_mode="${mode}"`,
							"sandbox",
							"--",
							"/bin/true",
						],
						{ timeoutMs: 30_000 },
					);
					if (result.code !== 0) {
						passed = false;
						break;
					}
				}
				this.codexInner = passed;
			}
			options = await probeHarnessOptions(this, pin, undefined, { login });
		} catch {
			// The session can disappear normally if the owner logs out during discovery.
		}
		await this.refreshLogin();
		if ((this.codexCredential?.generation ?? "signed-out") !== generation) return;
		if (options) {
			this.codexOptions = options;
			this.nextCodexProbe = Date.now() + INVENTORY_TTL_MS;
		} else console.log("Could not read Codex model options.");
	}
	async openCodeDefault(keys: ModelProvider[]) {
		if (!this.harnessKeyRelays || !this.opencodePin)
			throw new Refusal("This machine does not offer OpenCode Settings keys.");
		const login = currentProvider(this);
		const local = login?.providers ?? (login ? [login.provider] : []);
		const providers = [...localProviders(local, keys), ...keys];
		const options = await probeHarnessOptions(this, this.opencodePin, providers, undefined, true);
		return options.defaultModel;
	}
	private async refreshOpenCodeOptions(force = false) {
		const pin = this.opencodePin;
		const login = this.opencodeLogin;
		const generation = login?.generation ?? "signed-out";
		if (!pin || (!force && this.probedLogin === generation && Date.now() < this.nextOpenCodeProbe)) return;
		this.probedLogin = generation;
		this.nextOpenCodeProbe = Date.now() + INVENTORY_RETRY_MS;
		try {
			await this.ensureImage(pin);
			const local = login?.providers ?? (login ? [login.provider] : ["free"]);
			const providers = [...new Set([...local, ...MODEL_PROVIDERS].map(p => (p === "chatgpt" ? "openai" : p)))];
			const options = await probeHarnessOptions(this, pin, providers);
			// The terminal can replace the credential while the offline probe is running.
			await this.refreshLogin();
			if ((this.opencodeLogin?.generation ?? "signed-out") === generation) {
				this.opencodeOptions = options;
				this.nextOpenCodeProbe = Date.now() + INVENTORY_TTL_MS;
			}
		} catch {
			console.log("Could not read OpenCode model options.");
		}
	}
	private async restoreRelay() {
		if (this.codex && this.codexCredential && [...this.boxes.values()].some(b => b.harness === "codex"))
			await withLoginVolume(this, async () => {
				const login = codexLogin(this);
				if (login) await ensureRelay(this, login);
			});
		if (this.opencode && this.opencodeLogin && [...this.boxes.values()].some(b => b.harness === "opencode")) {
			await withLoginVolume(this, async () => {
				const login = currentProvider(this);
				if (login) await ensureRelay(this, login);
			});
		}
		if (
			this.claude &&
			this.signIn === "token" &&
			[...this.boxes.values()].some(b => b.harness === "claude" && !b.legacyClaude)
		)
			await this.ensureSignedInRelay();
	}
	private async refreshClaudeOptions(force = false) {
		const pin = this.claudePin;
		if (!pin || (!force && Date.now() < this.nextClaudeProbe)) return;
		this.nextClaudeProbe = Date.now() + INVENTORY_RETRY_MS;
		try {
			await this.ensureImage(pin);
			// Read the pinned adapter with a dummy token, even before login.
			this.claudeOptions = await probeHarnessOptions(this, pin);
			this.nextClaudeProbe = Date.now() + INVENTORY_TTL_MS;
		} catch {
			console.log("Could not read Claude Code model options.");
		}
	}
	// Count, reserve and change a container under one ordering, including idle stops and prune.
	serial<T>(work: () => Promise<T>): Promise<T> {
		const next = this.pending.then(work);
		this.pending = next.catch(() => {});
		return next;
	}
	private filters() {
		return [LABEL_ARG, ...Object.entries(this.labels).map(([k, v]) => k + "=" + v)].flatMap(label => [
			"--filter",
			"label=" + label,
		]);
	}
	// Docker keeps the container and its workspace across a rename. Finish all such renames
	// before writing a status.json the rollback runner can read.
	async migrateClaudeNames() {
		const names = await dockerOutput([
			"ps",
			"-a",
			...this.filters(),
			"--filter",
			`label=${LABEL}.harness=claude`,
			"--format",
			"{{.Names}}",
		]);
		for (const name of names.trim().split("\n")) {
			const raw = /^wlp-session-([a-f0-9]{12})$/.exec(name)?.[1];
			if (raw) await dockerOutput(["rename", name, containerName("claude-" + raw)]);
		}
	}
	async discover(onlySession?: string) {
		const filters = this.filters();
		if (onlySession && ![...this.boxes.values()].some(b => b.sessionId === onlySession && b.claim))
			filters.push("--filter", `label=${LABEL}.session=${onlySession}`);
		const rows = await dockerOutput([
			"ps",
			"-a",
			...filters,
			"--format",
			`{{.Names}}|{{.State}}|{{.Label "${LABEL}.session"}}|{{.Label "${LABEL}.profile"}}|{{.Label "${LABEL}.harness"}}|{{.Label "${LABEL}.egress"}}|{{.Label "${LABEL}.relay-session"}}|{{.Label "${LABEL}.slots"}}`,
		]);
		const found = new Set<string>();
		for (const line of rows.trim().split("\n")) {
			const [name, state, labelSession, profile, harness, egress, relay, size] = line.split("|");
			const raw = SESSION_NAME.exec(name)?.[1];
			const claim = raw && labelSession === SPARE_SESSION ? claimFor(read(this.claimFile(raw))) : undefined;
			const sessionId = claim?.session ?? labelSession;
			if (raw && labelSession === SPARE_SESSION && !claim && !this.spares.owns(raw)) this.unbound.add(raw);
			if (onlySession && sessionId !== onlySession) continue;
			const prefixed = raw && harnessOfRaw(raw);
			// A name's prefix and its harness label agree; only Claude's older sandboxes have its label without the prefix.
			const harnessMatches = !harness
				? !prefixed
				: isMachineHarness(harness) && (prefixed ? prefixed === harness : MACHINE_HARNESSES[harness].unprefixedNames);
			if (!raw || !harnessMatches || !NAME.test(sessionId) || (profile !== bubblewrap && profile !== "docker-hardened"))
				continue;
			const id = externalId(this.identity.machineId, raw);
			found.add(id);
			const box = this.boxes.get(id) ?? {
				raw,
				sessionId,
				profile,
				...(isMachineHarness(harness) ? { harness } : {}),
				usedAt: Date.now(),
				busy: 0,
				workspaceChecked: false,
			};
			this.boxes.set(
				id,
				Object.assign(box, {
					egress,
					claim,
					size: Number(size) || 1,
					legacyClaude: !!harness && !/^[0-9a-f]{32}$/.test(relay),
					state: state === "running" || state === "restarting" ? ("running" as const) : ("paused" as const),
				}),
			);
		}
		for (const [id, box] of this.boxes) {
			if ((!onlySession || box.sessionId === onlySession) && !found.has(id)) this.boxes.delete(id);
		}
		this.dockerHealth = { ok: true };
		// Only in the service, after its welcome: `status` and `prune` list sandboxes too.
		if (!onlySession && this.inventoryStarted && Date.now() >= this.nextVolumeSweep) {
			this.nextVolumeSweep = Date.now() + 10 * 60_000;
			await this.sweepVolumes();
		}
	}
	// Serialize sweeps with creates. The minimum age protects volumes a create is about to mount.
	async sweepVolumes(minAgeMs?: number) {
		try {
			return await this.provider.sweepDataVolumes(minAgeMs, this.labels);
		} catch {
			return 0;
		}
	}
	async secureCredentialPath() {
		if (this.credentialPathChecked) return;
		if (this.claude) await withLoginVolume(this, () => stopLegacyClaude(this));
		else await retireClaudeRelay(this);
		if (!this.codex && codexLogin(this)) await withLoginVolume(this, () => removeRelay(this, "codex"));
		if (!this.opencode && currentProvider(this)) await withLoginVolume(this, () => removeRelay(this, "opencode"));
		const pair = loadPair();
		if (pair?.current.machineId === this.identity.machineId) {
			for (const old of pair.previous) await retirePairingRelays(new MachineDocker(old));
		}
		this.credentialPathChecked = true;
	}
	// Run only after this pairing's authenticated welcome. Stop an old container before
	// advertising a tighter policy. Its workspace remains available to the owner.
	private async reconcileEgress() {
		await this.discover();
		const running = new Set([...this.spares.raws, ...this.unbound]); // Spare helpers are removed by their own reaper.
		for (const [id, box] of this.boxes) {
			if (box.state !== "running") continue;
			if (box.legacyClaude || (box.egress || "open") !== this.network.policy.mode) {
				await this.lifecycle("suspend", id);
				continue;
			}
			if (!box.egress) await this.network.migrateOpen(containerName(box.raw));
			if (box.egress === "restricted" || box.harness) {
				await this.network.attach(box.raw, containerName(box.raw));
				running.add(box.raw);
			}
		}
		await this.network.reconcile(running);
	}
	async refresh(): Promise<void> {
		try {
			await this.secureCredentialPath();
			if (this.enforceEgress) {
				try {
					await this.reconcileEgress();
					this.egressError = undefined;
				} catch (error) {
					this.egressError =
						error instanceof RunnerError ? error.message : "Docker could not apply the runner’s network policy.";
					throw new RunnerError(this.egressError);
				}
				await this.reapUnbound();
			} else if (this.dockerHealth.ok) await dockerOutput(["version", "--format", "{{.Server.Version}}"]);
			else await this.discover();
			await this.refreshLogin();
			if (this.inventoryStarted) {
				await this.refreshClaudeOptions();
				await this.refreshOpenCodeOptions();
				await this.refreshCodexOptions();
			}
		} catch (error) {
			const reason = error instanceof RunnerError ? error.message : "Docker did not provide a diagnostic.";
			const category = /permission denied|EACCES/i.test(reason)
				? "permission denied"
				: /no such file|ENOENT/i.test(reason)
					? "not found"
					: "unreachable";
			audit(null, null, "docker", category);
			this.dockerHealth = { ok: false, reason };
			this.signIn = "unknown";
			this.signInReason = `Docker is not reachable: ${reason}`;
		}
	}
	/** The welcome's `gitHost`, which an --egress-domains list takes in place of github.com. */
	platformGitHost(host: string | undefined) {
		this.network.platformGitHost(host);
	}
	async checkAuthenticatedNetwork() {
		this.enforceEgress = true;
		await this.serial(() => this.refresh());
	}
	async welcome(signal: AbortSignal) {
		if (!this.dockerHealth.ok || signal.aborted) return;
		try {
			// A killed runner can leave setup between Docker create and start, before its
			// in-container deadline exists. Only the authenticated pairing reaps its leftovers.
			const stale = await dockerOutput(["ps", "-aq", ...this.filters(), "--filter", "label=" + legacyLoginLabel]);
			for (const id of stale.trim().split(/\s+/).filter(Boolean)) {
				if (signal.aborted) return;
				await docker(["rm", "-f", id]);
			}
			await this.ensureImage();
			await this.serial(async () => {
				if (signal.aborted) return;
				if (this.signIn === "unknown") await this.refreshLogin();
				await this.restoreRelay();
				await this.prepareModelRelay();
				this.inventoryStarted = true;
				await this.refreshClaudeOptions();
				await this.refreshOpenCodeOptions();
				await this.refreshCodexOptions();
				// Keep the result of a real sandbox create after this initial bubblewrap check.
				const first = this.freeDiskBytes === null;
				this.freeDiskBytes = await this.disk();
				if (first)
					this.commandSandbox = this.allowedProfiles.includes(bubblewrap)
						? await this.probe()
						: { ok: false, reason: PROFILE_DENIED };
			});
		} catch (error) {
			if (signal.aborted) return;
			this.freeDiskBytes = null;
			if (!this.commandSandbox.ok)
				this.commandSandbox = {
					ok: false,
					reason: error instanceof RunnerError ? error.message : "The sandbox image could not be checked.",
				};
		}
	}
	get modelRelayReady(): boolean {
		return readsModelRelay(this.sandboxWindlass);
	}

	// The returned callback releases only this conversation's claim on the lease.
	trackRelay(id: string, end: () => Promise<void>): () => void {
		let ends = this.relayLeases.get(id);
		if (!ends) this.relayLeases.set(id, (ends = new Set()));
		ends.add(end);
		const mine = ends;
		return () => {
			mine.delete(end);
			if (!mine.size && this.relayLeases.get(id) === mine) this.relayLeases.delete(id);
		};
	}

	// Also clear relay state left by a crashed runner.
	private async endRelays(id: string, raw: string, harness?: MachineHarness): Promise<void> {
		const ends = [...(this.relayLeases.get(id) ?? [])];
		this.relayLeases.delete(id);
		await Promise.all(ends.map(end => end().catch(() => {})));
		if (harness) {
			const nonce = await this.relayNonce(raw).catch(() => "");
			if (nonce) await withLoginVolume(this, () => endHarnessLeases(this, harness, nonce));
		} else await this.modelRelay.endSandbox(raw).catch(() => {});
	}

	private async prepareModelRelay(): Promise<void> {
		if (this.sandboxWindlass === null) this.sandboxWindlass = await probeImage(image).catch(() => null);
		if (!this.relaySwept) {
			await this.modelRelay.sweep().catch(() => 0);
			this.relaySwept = true;
		}
	}

	report(): Report {
		const harnesses: NonNullable<Report["harnesses"]> = [];
		if (this.claudePin)
			harnesses.push({
				id: "claude",
				adapter: "claude-agent-acp " + claudePackage.dependencies["@agentclientprotocol/claude-agent-acp"],
				image: this.claudePin.split("@").at(-1)!,
				signIn: this.signIn,
				loginGeneration: this.claudeGeneration,
				...(this.signIn === "unknown" && this.signInReason && { signInReason: this.signInReason.slice(0, 300) }),
				...(this.claudeOptions && { options: this.claudeOptions }),
			});
		if (this.codexPin)
			harnesses.push({
				id: "codex",
				adapter: "codex-acp 2.9.0",
				image: this.codexPin.split("@").at(-1)!,
				signIn: !this.dockerHealth.ok ? "unknown" : this.codexCredential ? "token" : "none",
				loginGeneration: this.codexCredential?.generation,
				...(this.codexCredential && { method: this.codexCredential.provider === "chatgpt" ? "chatgpt" : "api-key" }),
				modes: reportedCodexModes(!!this.codexInner),
				...(!this.codexInner && { modeReason: innerModesReason }),
				...(this.codexOptions && { options: this.codexOptions }),
			});
		if (this.opencodePin)
			harnesses.push({
				id: "opencode",
				adapter: "OpenCode 1.19.6",
				image: this.opencodePin.split("@").at(-1)!,
				signIn: !this.dockerHealth.ok ? "unknown" : this.opencodeLogin ? "token" : "none",
				loginGeneration: this.opencodeLogin?.generation,
				machineProviders: this.opencodeLogin?.providers ?? (this.opencodeLogin ? [this.opencodeLogin.provider] : []),
				...(this.opencodeOptions && { options: this.opencodeOptions }),
			});
		return {
			kind: "report",
			environmentBuild: true,
			...(this.warmSpares &&
				this.sessionVolumes &&
				this.limits.spares !== 0 && { warmSpares: { ready: this.spares.ready } }),
			blockedNetwork: this.network.policy.mode === "restricted",
			gitMirrors: true,
			sessionVolumes: true,
			...(this.sessionBackups && { sessionBackups: true }),
			modelRelay: this.modelRelayReady,
			egress: this.network.policy.mode,
			allowedProfiles: this.allowedProfiles,
			slots: this.slots,
			host: {
				cpus: availableParallelism(),
				sandboxCpus: this.slots?.unit.cpus ?? 1,
				memoryBytes: totalmem(),
				memoryFreeBytes: freemem(),
				load1: loadavg()[0] ?? null,
			},
			docker: this.egressError ? { ok: false, reason: this.egressError } : this.dockerHealth,
			...(this.claudePin && { claudeRelay: true as const }),
			...(this.network.policy.domains && { egressDomains: this.network.domains()!.length }),
			...(harnesses.length ? { harnesses: harnesses.map(h => ({ ...h, keyRelay: true as const })) } : {}),
			...(this.screenshots ? { screenshots: true } : {}),
			commandSandbox: this.commandSandbox,
			freeDiskBytes: this.freeDiskBytes,
			storeLimits: this.reportedStoreLimits(),
			sandboxes: [...this.boxes.entries()]
				.slice(0, MAX_REPORTED_SANDBOXES)
				.map(([id, { sessionId, state, usedAt, resizePending }]) => ({ id, sessionId, state, usedAt, resizePending })),
			...(this.limits.maxRunning !== undefined ? { maxRunning: this.limits.maxRunning } : {}),
			...(this.limits.maxSandboxes !== undefined ? { maxSandboxes: this.limits.maxSandboxes } : {}),
		};
	}
	private room() {
		if (
			this.limits.maxRunning !== undefined &&
			[...this.boxes.values()].filter(b => b.state === "running").length >= this.limits.maxRunning
		)
			throw new SandboxUserError("This machine has reached its own limit on running sandboxes, set by --max-running.");
	}
	private requireProfile(profile: Profile) {
		if (!this.allowedProfiles.includes(profile)) throw new Refusal(PROFILE_DENIED);
	}
	private requireEgress(box: Box) {
		if (this.egressError) throw new Refusal(this.egressError);
		if ((box.egress || "open") !== this.network.policy.mode)
			throw new Refusal(
				"This kept sandbox has a different network policy. Save its workspace and recreate the sandbox to use the runner’s current --egress setting.",
			);
	}
	async existing(sessionId: string, profile: Profile, harness?: MachineHarness) {
		this.requireProfile(profile);
		if (this.egressError) throw new Refusal(this.egressError);
		// The owner may have removed the container since discovery. Refresh just this
		// session once the rest of the inventory is known, before applying capacity limits.
		if (!this.dockerHealth.ok) await this.discover();
		else if ([...this.boxes.values()].some(box => box.sessionId === sessionId)) await this.discover(sessionId);
		else return;
		for (const [id, box] of this.boxes) {
			if (box.sessionId === sessionId) {
				this.requireRelaySession(box);
				this.requireProfile(box.profile);
				this.requireEgress(box);
				if (box.harness !== harness) throw new Refusal("This session already has a sandbox with a different harness.");
				if (!box.workspaceChecked) {
					if (!(await hasWorkspaceGit(box.raw))) {
						await this.remove(id);
						await this.discover(sessionId);
						if (this.boxes.has(id)) throw new RunnerError("Docker could not remove the unfinished sandbox.");
						continue;
					}
					box.workspaceChecked = true;
				}
				this.publishReport?.();
				return id;
			}
		}
	}
	async create(
		sessionId: string,
		profile: Profile,
		screenshots = false,
		harness?: MachineHarness,
		size = 1,
		prepared?: SnapshotSelection & { privateData: boolean },
		mirrorRepo?: string,
		spare?: SpareRecipe,
		environmentBuild = false,
		privateData = false,
	): Promise<string> {
		// Another create could have finished while this one waited for the image.
		if (harness) this.requireHarness(profile, harness);
		const existing = await this.existing(sessionId, profile, harness);
		if (existing) return existing;
		if (environmentBuild && this.spares.raws.length && !this.environmentFits(size))
			throw new SandboxUserError(ENVIRONMENT_SLOT_WAIT);
		if (this.limits.maxSandboxes !== undefined && this.boxes.size >= this.limits.maxSandboxes)
			throw new SandboxUserError("This machine has reached its own limit on kept sandboxes, set by --max-sandboxes.");
		this.room();
		const candidate = !privateData &&
			!environmentBuild &&
			spare && {
				context: this.spareContext(),
				args: { spare, profile, harness, screenshots, size, prepared, mirrorRepo },
			};
		const spec =
			this.warmSpares && this.sessionVolumes && (this.limits.spares ?? 1) > 0 && validSpec(candidate)
				? candidate
				: undefined;
		const readyBefore = this.spares.ready;
		const taken = spec && (await this.spares.take(spec, (raw, built) => this.verifySpare(raw, built, spec)));
		let claimed = taken?.raw;
		const claim: Claim | undefined =
			claimed && spec
				? { session: sessionId, key: digest([spec.args.spare]), setup: taken?.setup, attempt: prepared?.attempt }
				: undefined;
		if (claimed && claim) {
			try {
				if (harness) await this.ownedVolume(true, relaySocketVolume(this, harness));
				save(this.claimFile(claimed), claim);
			} catch {
				console.info(`spare.skip id=${claimed} reason=bind`);
				await this.removeUnbound(claimed);
				claimed = undefined;
			}
		}
		if (!claimed) {
			const retiring = environmentBuild ? undefined : this.spares.trim();
			await this.network.prepare();
			this.freeDiskBytes = await this.disk();
			if (this.waitForSpareRemoval(size)) await retiring;
			if (this.freeDiskBytes < 5_000_000_000) throw new Refusal("Docker needs at least 5 GB free to create a sandbox.");
		}
		const input = { uid: this.identity.uid, sessionId, profile, size, mirrorRepo };
		const raw =
			claimed ??
			(harness
				? await withLoginVolume(this, () => this.providerFor(harness).create({ ...input, harness }))
				: await this.provider.create({
						...input,
						fromSnapshot: prepared,
						privateData: privateData || prepared?.privateData,
						screenshots: this.screenshots && screenshots,
						ownData: this.sessionVolumes,
					}));
		const id = externalId(this.identity.machineId, raw);
		this.boxes.set(id, {
			raw,
			sessionId,
			profile,
			harness,
			size,
			claim: claimed ? claim : undefined,
			snapshotCandidate: !!prepared?.writer && !prepared.privateData && !harness,
			egress: this.network.policy.mode,
			state: "running",
			usedAt: Date.now(),
			busy: 0,
			workspaceChecked: true,
		});
		try {
			await this.network.attach(raw, containerName(raw));
		} catch (error) {
			await this.remove(id);
			if (claimed) {
				console.info(`spare.skip id=${claimed} reason=network`);
				return this.create(sessionId, profile, screenshots, harness, size, prepared, mirrorRepo);
			}
			throw error;
		}
		if (profile === bubblewrap && !claimed) {
			const box = new DockerSandboxHandle(raw, profile, this.identity.uid);
			try {
				this.commandSandbox = await checkBubblewrap(timeoutMs => box.ask(DOCKER_BWRAP_PROBE, { timeoutMs }));
				if (!this.commandSandbox.ok) throw new Refusal(this.commandSandbox.reason);
			} catch (error) {
				await this.remove(id);
				throw error;
			}
		}
		if (claimed) console.info(`spare.claim id=${claimed} reason=recipe-match`);
		else {
			let reason = spec ? "pool-empty" : spare ? "invalid-recipe" : "no-recipe";
			if (spec && readyBefore) reason = "recipe-mismatch";
			if (!this.warmSpares || !this.sessionVolumes) reason = "capability";
			else if (this.limits.spares === 0) reason = "disabled";
			console.info(`spare.skip id=${raw} reason=${reason}`);
		}
		if (!environmentBuild) {
			this.needsSpareSeed = false;
			this.spares.used(spec);
			this.waitForTurn = spec ? id : undefined;
		}
		this.publishReport?.();
		return id;
	}
	get canReseed() {
		return (
			this.spareReseed && this.warmSpares && this.sessionVolumes && this.limits.spares !== 0 && this.needsSpareSeed
		);
	}
	seedSpare(session: string, id: string, spare: SpareRecipe, screenshots = false) {
		const box = this.owned(id, session);
		if (!box || !this.canReseed) return false;
		const spec = {
			context: this.spareContext(),
			args: {
				profile: box.profile,
				harness: box.harness,
				size: box.size ?? 1,
				screenshots: !box.harness && this.screenshots && screenshots,
				mirrorRepo: spare.connected?.repo,
				spare,
			},
		};
		if (!validSpec(spec)) return false;
		this.spares.used(spec);
		this.needsSpareSeed = false;
		this.waitForTurn = box.state === "running" && box.activeTurns !== 0 ? id : undefined;
		return true;
	}
	async saveMirror(session: string, id: string, stage: string, partial: boolean) {
		const box = this.running(id, session);
		// The base pin, never the session's image: a harness image, or a snapshot committed after setup.
		return saveSessionMirror(containerName(box.raw), stage, partial, { image, floor: this.storeLimits().free });
	}
	/**
	 * `backupSave` and `backupRestore`: in the session's own running sandbox, which stays in use (not
	 * stopped as idle) while its copy moves. Not serial: the store orders its own changes.
	 */
	async backup<N extends "backupSave" | "backupRestore">(session: string, name: N, args: Args<N>): Promise<Value<N>> {
		if (!this.sessionBackups) throw new Refusal("This runner keeps no copies for this platform.");
		const box = this.running(args.id, session);
		box.busy++;
		try {
			const container = containerName(box.raw);
			return (
				name === "backupSave"
					? await this.backups.save(session, container, args as Args<"backupSave">)
					: await this.backups.restore(session, container, args as Args<"backupRestore">)
			) as Value<N>;
		} finally {
			box.busy--;
			box.usedAt = Date.now();
		}
	}
	async backupCopy(session: string, args: Args<"backupCopy">) {
		if (!this.sessionBackups) throw new Refusal("This runner keeps no copies for this platform.");
		return this.backups.copy(session, args);
	}
	async saveSnapshot(session: string, id: string, source: SnapshotSource) {
		const box = this.running(id, session);
		if (!box.snapshotCandidate || box.busy || box.harness) return false;
		box.snapshotCandidate = false;
		box.savingSnapshot = true;
		try {
			return await this.provider.saveSnapshot(box.raw, source);
		} finally {
			box.savingSnapshot = false;
		}
	}
	private owned(id: string, session?: string) {
		rawId(this.identity.machineId, id);
		const box = this.boxes.get(id);
		if (box && session !== undefined && box.sessionId !== session)
			throw new Refusal("This sandbox belongs to another session.");
		return box;
	}
	private requireRelaySession(box: Box) {
		if (box.legacyClaude)
			throw new Refusal(
				"This Claude session predates credential isolation. Archive its workspace locally and recreate the session.",
			);
	}
	running(id: string, session: string) {
		const box = this.owned(id, session);
		if (!box || box.state !== "running")
			throw new Refusal("Commands require a running sandbox owned by this machine and session.");
		this.requireProfile(box.profile);
		this.requireEgress(box);
		this.requireRelaySession(box);
		if (box.harness) this.requireHarness(box.profile, box.harness);
		box.usedAt = Date.now();
		return box;
	}
	/** Keep the control report in step with an observed container transition, including an idle stop. */
	private noteState(id: string, box: Box, state: "none" | "running" | "paused") {
		if (box.state === state) return;
		if (state === "none") this.boxes.delete(id);
		else box.state = state;
		this.publishReport?.();
	}
	async lifecycle(op: Lifecycle["name"], id: string, session?: string) {
		if (!this.dockerHealth.ok) await this.discover();
		const box = this.owned(id, session);
		if (!box) {
			// A repeated destroy is harmless, but an existing, unlabelled namesake is not ours.
			const raw = rawId(this.identity.machineId, id);
			if ((await docker(["container", "inspect", "--format", "{{.Id}}", containerName(raw)])).code === 0)
				throw new Refusal("This sandbox does not belong to this machine.");
			if (op === "destroy") this.publishReport?.();
			return op === "state" ? ("none" as const) : null;
		}
		box.usedAt = Date.now();
		if (op === "state") {
			const state = await this.provider.state(box.raw);
			this.noteState(id, box, state);
			return state;
		}
		if (op === "connect") {
			this.requireRelaySession(box);
			this.requireProfile(box.profile);
			this.requireEgress(box);
			if (box.harness) {
				this.requireHarness(box.profile, box.harness);
				await this.ownedVolume(true, relaySocketVolume(this, box.harness));
			}
			if (box.state === "paused") {
				this.room();
				const retiring = this.spares.trim();
				if (this.waitForSpareRemoval(box.size ?? 1)) await retiring;
			}
			const handle = await this.provider.connect(box.raw, { ownData: this.sessionVolumes });
			if (!!box.resizePending !== !!handle?.resizePending) {
				box.resizePending = handle?.resizePending || undefined;
				this.publishReport?.();
			}
			this.noteState(id, box, handle ? "running" : "none");
			if (!handle) {
				// Gone, or removed for mounting the machine volume (`DockerSandboxes.connect`): its forwarder goes too.
				if (box.egress === "restricted" || box.harness) await this.network.detach(box.raw).catch(() => {});
				return null;
			}
			if (!box.egress) await this.network.migrateOpen(containerName(box.raw));
			await this.network.attach(box.raw, containerName(box.raw));
			// Released peers reject unknown keys. Advertise optional fields only after capability negotiation.
			const answer = {
				cwd: handle.cwd,
				profile: box.profile,
				...(handle.snapshot && {
					snapshot: { ...handle.snapshot, ...(box.claim?.attempt && { attempt: box.claim.attempt }) },
				}),
				...(this.warmSpares &&
					box.claim && {
						readyKey: box.claim.key,
						...(this.spareSetupTimes && box.claim.setup && { readySetup: box.claim.setup }),
					}),
				...(box.harness ? { harness: box.harness } : {}),
				...(this.screenshots && !box.harness ? { screenshots: true } : {}),
				...(this.canReseed && { needsSpareSeed: true as const }),
				...(handle.ownData && this.sessionVolumes ? { ownData: true as const } : {}),
				...(!box.harness && this.windlassKeyRelays && { windlassKeyRelay: true as const }),
				// A harness uses its credential relay for forwarded platform leases.
				...((box.harness ? this.harnessKeyRelays : this.modelRelays && this.modelRelayReady)
					? { modelRelay: true as const }
					: {}),
				...(this.blockedNetwork && box.egress === "restricted" ? { blockedNetwork: true as const } : {}),
				...(this.memoryEvents && { memoryEvents: true as const }),
				...(this.startTimes && box.startTimes
					? {
							startTimes: this.warmSpares
								? box.startTimes
								: {
										image: box.startTimes.image,
										create: box.startTimes.create,
										...(box.startTimes.pulled && { pulled: true as const }),
									},
						}
					: {}),
				...(this.environmentImage && handle.image ? { image: handle.image } : {}),
			};
			delete box.startTimes;
			return answer;
		}
		// The server names the token by the external sandbox id; the provider knows the raw id.
		if (box.state === "running") {
			const path = tokenFilePath(id);
			await new DockerSandboxHandle(box.raw, box.profile, this.identity.uid).removeFiles([path, path + ".tmp"]);
		}
		// Its turns' leases end with it: the relay's files of them, their forwarders and the conversations' entries.
		await this.endRelays(id, box.raw, box.harness);
		if (op === "destroy") await this.remove(id);
		else {
			if (box.egress === "restricted" || box.harness) await this.network.detach(box.raw);
			await this.provider.suspend(box.raw);
			const state = await this.provider.state(box.raw);
			this.noteState(id, box, state);
			if (state === "running") throw new RunnerError("Docker could not stop the sandbox.");
		}
		// A tracked ACP process releases its own slot when its exit arrives.
		if (!box.activeTurns) this.turnEnded(box);
		return null;
	}
	async requestedRemoval(id: string) {
		if (!this.dockerHealth.ok) await this.discover();
		if (this.boxes.has(id)) await this.lifecycle("destroy", id);
		else this.publishReport?.();
		// The control acknowledgement also covers a sandbox that was never this machine's.
	}
	private async remove(id: string) {
		const { raw, harness, egress, claim } = this.boxes.get(id)!;
		if (egress === "restricted" || harness) await this.network.detach(raw);
		await this.provider.destroy(raw);
		this.boxes.delete(id);
		if (claim) forget(this.claimFile(raw));
		if (harness === "claude")
			await withLoginVolume(this, async () => {
				// An unrelated or unreadable login volume must survive sandbox removal.
				const state = await loginFileState(this).catch(() => "unknown");
				if (state === "none") await dropDetachedLoginVolume(this);
			});
		this.publishReport?.();
	}
	async idle(ms: number, connected: (session: string) => boolean) {
		// A running process (including Windlass throughout a turn), an outstanding operation,
		// or a connected session socket keeps the sandbox in use.
		for (const [id, b] of this.boxes) {
			if (b.state === "running" && !b.busy && !connected(b.sessionId) && Date.now() - b.usedAt >= ms) {
				await this.lifecycle("suspend", id);
				audit(b.sessionId, id, "idle-suspend", "done");
			}
		}
	}
	override async logout() {
		const { uid, machineId } = this.identity;
		await removeRunningTokenFiles(uid, machineId, raw => externalId(machineId, raw));
		await super.logout(); // Files left on the volume by previous runner versions.
	}
	async suspendAll() {
		await this.discover();
		let failed = false;
		for (const [id, box] of this.boxes) {
			if (box.state !== "running") continue;
			try {
				await this.lifecycle("suspend", id);
			} catch {
				failed = true;
				audit(box.sessionId, id, "suspend", "failed");
			}
		}
		if (failed) throw new RunnerError("Docker could not stop all kept sandboxes.");
	}
	async prune() {
		await this.spares.trim();
		await this.discover();
		await this.reapUnbound();
		this.spares.used();
		forget(`recent-${this.identity.machineId}.json`); // Clean up the restart hint from older versions.
		for (const [id, b] of this.boxes) {
			await this.lifecycle("destroy", id);
			audit(b.sessionId, id, "prune", "done");
		}
		// A killed runner can also have left a labelled probe or disk-check helper.
		await withLoginVolume(this, async () => {
			const helpers = await docker(["ps", "-aq", ...this.filters()], { check: true });
			for (const id of helpers.stdout.trim().split(/\s+/).filter(Boolean))
				await docker(["rm", "-fv", id], { check: true });
			await this.network.prune();
			await this.provider.dropSnapshots(this.identity.uid);
			await dropPreviousSnapshots(this.identity);
			const volumes = await docker(["volume", "ls", "-q", ...this.filters()], { check: true });
			for (const name of volumes.stdout.trim().split(/\s+/).filter(Boolean)) await this.dropVolume(name);
		});
	}
}
