/**
 * What a runner and its machine's actor say on the machine's control socket, and what a runner asks
 * the platform's HTTP routes before it has one (Plans/2026-11-19 "bring your own computer", section 3).
 * Imported by the `machine` actor, the routes, the runner and the stand-ins of both, so it imports
 * nothing of the server's: no RivetKit, no configuration, only types.
 *
 * The control socket (`machine.get([uid, machineId]).webSocket("control")`). Every WebSocket message is
 * one bounded JSON frame. Authenticated reports have extra space for harness inventories. Control frames are never resent: a new socket starts
 * over with a new challenge, and what the actor still wants done (a removal) it asks again.
 *
 *   challenge  actor → runner   first frame on every socket: a nonce for the runner to sign
 *   hello      runner → actor   the signature, the runner's release, its process epoch and its clock
 *   welcome    actor → runner   accepted: the idle time the runner applies to sandboxes on its own, and
 *                               to a runner that reads them, the server's capabilities (SERVER_CAPABILITIES)
 *                               and its git host (`gitHost`, which an --egress-domains list always has)
 *   refused    actor → runner   not accepted, or no longer (the machine was removed), with a sentence to
 *                               show; the actor then closes the socket
 *   report     runner → actor   what the machine has: Docker, the probe, free disk, its sandboxes. Sent
 *                               after welcome and whenever what it says changed, at most every REPORT_MS
 *   catalog    runner → actor   changed options for one harness, before the report referencing their digest
 *   host       runner → actor   changed host sample between inventory reports
 *   heartbeat  either way       sent every CONTROL_HEARTBEAT_MS; a socket that is silent for CONTROL_DEAD_MS is closed
 *   attach     actor → runner   a session wants its sandbox: open that session's socket with the ticket
 *   remove     actor → runner   remove one sandbox (its session was deleted); answered with `removed`
 *   removed    runner → actor   that sandbox is gone, or was never this machine's
 *   forget-backup     actor → runner   remove a deleted session's copy of its agent session from the
 *                                      machine's volume of copies; only to a runner whose report said
 *                                      `sessionBackups`; answered with `backup-forgotten`
 *   backup-forgotten  runner → actor   that copy is gone, or there was none
 *   forget-claude-login     actor → runner   remove the Claude Code login kept on the machine (`windlass-runner
 *                                            login claude`), so its Claude Code pays through Pay with again;
 *                                            answered with `claude-login-forgotten`. Every runner from
 *                                            MIN_RUNNER_VERSION (0.3.13) reads it, so it is not gated
 *   claude-login-forgotten  runner → actor   `ok`: the login is gone (or there was none); false: Docker could not
 *                                            remove it
 *
 * What a refusal leads to on the runner: it says the sentence, never exits (a container that exits is
 * started again by Docker, which would only repeat the refusal), and asks again after REFUSED_RETRY_MS.
 * "removed" is the one exception: it forgets its key, removes its sandboxes and its data volume first
 * when `removeSandboxes` says so, and waits to be paired again.
 *
 * Validation is here and nowhere else, built with the session protocol's checks (check.ts); no stream
 * field of that protocol is used here. A frame that does not pass is null: the actor refuses the socket
 * ("bad-frame"), the runner drops the socket and connects again.
 */
import { createHash, createPublicKey } from "node:crypto";
import { endpointShape, helloFields, removalFields, welcomeFields } from "./frame-auth.js";
import { MACHINE_HARNESS_IDS, type HarnessOptions, type MachineProbe, type PlatformConnection } from "../contract.js";
import {
	MACHINE_PROFILES,
	MIN_RUNNER_VERSION,
	machineProfile,
	outdatedRunner,
	type MachineProfile,
	positiveLimit,
} from "./protocol.js";
import {
	type Assert,
	type Of,
	type Same,
	boolean,
	count,
	either,
	integer,
	is,
	json,
	list,
	nullable,
	object,
	oneOf,
	optional,
	plain,
	text,
} from "./check.js";
import { MAX_STORE_BYTES, type StoreCaps } from "../sandbox/store-limits.js";

export { MIN_RUNNER_VERSION, outdatedRunner } from "./protocol.js";
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024;
// Only a paired runner's inventory report needs room for full provider catalogs.
const MAX_HARNESS_OPTIONS_BYTES = 768 * 1024;
export const MAX_REPORT_BYTES = MAX_CONTROL_FRAME_BYTES + 2 * MAX_HARNESS_OPTIONS_BYTES;
/** A slow heartbeat: it costs no write on either side. */
export const CONTROL_HEARTBEAT_MS = 30_000;
export const CONTROL_DEAD_MS = 90_000;
/** A socket heard from within this is live (it sends a heartbeat every CONTROL_HEARTBEAT_MS): see `secondHello`. */
export const LIVE_MS = CONTROL_HEARTBEAT_MS + 10_000;
/** The least time between two scheduled reports: a change within it goes with the next one. A sandbox made or removed is the exception: the runner reports that at once, since the page and a session that lost a `create` read the newest report. */
export const REPORT_MS = 60_000;
export const REFUSED_RETRY_MS = 10 * 60_000;
/** How far a runner's clock may be from the platform's: a signed time further off is refused (and signed again with the offset), and the page warns about one. */
export const CLOCK_TOLERANCE_MS = 60_000;
/** The most sandboxes one report lists. */
export const MAX_REPORTED_SANDBOXES = 100;

/** `m_` and 16 hex digits, made by the platform when a machine is confirmed. */
export const MACHINE_ID = /^m_[0-9a-f]{16}$/;
/** User and session ids, as the platform makes them (`u_…`, `s_…`): letters, digits, `_` and `-`. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A pairing code as the platform makes it: eight Crockford base32 digits in two groups. */
export const PAIRING_CODE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
/** How long a pairing code and its poll secret are good for. */
export const PAIRING_TTL_MS = 10 * 60_000;
/** How often a runner asks whether its code was confirmed. */
export const PAIRING_POLL_MS = 2_000;

/**
 * The machine key's fingerprint, as the runner prints it while it pairs and the Machines page shows it
 * before Connect: the first 50 bits of SHA-256 over the key's SPKI DER, in base32 (RFC 4648), in two
 * groups of five ("K7Q2M-XR4TD"). Both sides compute it from the key itself, so it is never sent. A
 * person who compares them sees that the code they typed is the one of the machine in front of them.
 * `key` is the PEM the runner sends or the base64 SPKI DER the platform keeps. Null for anything else.
 */
export function machineKeyFingerprint(key: string): string | null {
	let der: Buffer;
	try {
		const parsed = key.startsWith("-----BEGIN PUBLIC KEY-----")
			? createPublicKey(key)
			: createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" });
		if (parsed.asymmetricKeyType !== "ed25519") return null;
		der = parsed.export({ type: "spki", format: "der" });
	} catch {
		return null;
	}
	const hash = createHash("sha256").update(der).digest();
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	// 50 bits: the first 7 bytes give 56, of which the top 50 are read five at a time.
	const bits = hash.subarray(0, 7).reduce((value, byte) => (value << 8n) | BigInt(byte), 0n) >> 6n;
	let out = "";
	for (let shift = 45n; shift >= 0n; shift -= 5n) out += alphabet[Number((bits >> shift) & 31n)];
	return `${out.slice(0, 5)}-${out.slice(5)}`;
}
/**
 * The first runner release that prints the machine key's fingerprint while it pairs. Older runners print
 * only the code: the confirm step then asks the person to vouch for the machine another way. Raise it if
 * the release that ships the print is another.
 */
export const PRINTS_KEY_RUNNER_VERSION = "0.3.2";

// ---- Versions ----

const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** Whether release `version` ("1.2.3") is `minimum` or later. A version that is not one is not. */
export function versionAtLeast(version: string, minimum: string): boolean {
	const a = VERSION.exec(version);
	const b = VERSION.exec(minimum);
	if (a === null || b === null) return false;
	for (let i = 1; i <= 3; i++) if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i]);
	return true;
}

// ---- What is signed with the machine's key (Ed25519, the signature in base64url) ----

/** Over the control socket's challenge. */
export const controlProof = (uid: string, machineId: string, nonce: string) =>
	`wlp-runner-control/1|${uid}|${machineId}|${nonce}`;
/** With the session socket's hello (protocol.ts), over the ticket the `attach` frame carried, which the runner does not read. */
export const sessionProof = (uid: string, sessionId: string, machineId: string, ticket: string) =>
	`wlp-runner-session/1|${uid}|${sessionId}|${machineId}|${ticket}`;
/** With POST RUNNER_CONNECTION_PATH, over the runner's time corrected by the offset it was last told. */
export const connectionProof = (uid: string, machineId: string, time: number, nonce?: string) =>
	nonce
		? `wlp-runner-connection/2|${uid}|${machineId}|${time}|${nonce}`
		: `wlp-runner-connection/1|${uid}|${machineId}|${time}`;

// ---- Checks ----

/** One line of text: what a machine says of itself, or a reason, shown on the page as it is. */
const line = (max: number) => is<string>(v => text(max)(v) && !/[\u0000-\u001f\u007f]/.test(v as string));
const name = is<string>(v => typeof v === "string" && NAME.test(v));
const machineId = is<string>(v => typeof v === "string" && MACHINE_ID.test(v));
const version = is<string>(v => typeof v === "string" && VERSION.test(v));
const base64url = (length: number) =>
	is<string>(v => typeof v === "string" && v.length === length && /^[A-Za-z0-9_-]+$/.test(v));
/** 32 random bytes. */
const nonce = base64url(43);
/** An Ed25519 signature: 64 bytes. */
const signature = base64url(86);
const epoch = is<string>(v => typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v));
const time = is<number>(v => count(v) && (v as number) > 0);
const sandboxId = line(255);
const probe = either(object({ ok: oneOf(true) }), object({ ok: oneOf(false), reason: line(500) }));

// ---- Actor → runner ----

/**
 * What a server reads beyond what every server this runner may meet reads, named in its welcome. A
 * runner sends a field of this kind only to a server that named it: the server's checks refuse a
 * frame with a key they do not know. A name this runner does not know is ignored, so a later
 * server can name more without a new gate.
 *
 *   spare-reseed     a connect may request a fresh base recipe after the runner restarts
 *   git-mirrors      the report's `gitMirrors`, and the `mirrorRepo` and `saveMirror` operations
 *   egress-domains   the report's `egressDomains`
 *   session-volumes  the report's `sessionVolumes` and a connect's `ownData`; without it, a runner
 *                    gives no hardened sandbox a data volume of its own
 *
 * Every runner from MIN_RUNNER_VERSION on has the machine's model relay for Settings keys and the plan relay
 * (docs/machines.md, "Plans on this machine"), so neither is named here.
 *   start-times      the first connect's `startTimes` after a create (docs/architecture.md, "Start times")
 *   store-limits     the report's `storeLimits`: the snapshot and Git mirror limits in force (docs/machines.md)
 *   memory-events    a connect's `memoryEvents`: the session can read its container's memory limit and OOM kills
 *   blocked-network  restricted proxy observation on the session socket (report and connect flags)
 *   sign-in-reason   a harness entry's `signInReason`: why its sign-in could not be checked ("unknown")
 *   environment-image  a connect's `image`: the Docker image id the sandbox was made from, which a prepared
 *                    environment records (docs/github-and-repositories.md, "A repository's prepared environment")
 *   resumable-conversation  the report's `resumableConversation`: the runner keeps a session's processes,
 *                    their output and their relay leases through the grace for a conversation a
 *                    restarted server resumes, so a graceful stop need not end a machine turn
 *                    (runner/journal.ts)
 *   session-backups  the report's `sessionBackups`, the `backupSave`, `backupRestore` and `backupCopy`
 *                    operations, and the `forget-backup` and `backup-forgotten` frames: the runner
 *                    keeps copies of its sessions' agent sessions in a volume on the machine
 *                    (sandbox/machine-backups.ts)
 */
export const SERVER_CAPABILITIES = [
	"environment-build",
	"warm-spares",
	"spare-reseed",
	"spare-setup-times",
	"git-mirrors",
	"egress-domains",
	"session-volumes",
	"harness-key-relay",
	"start-times",
	"store-limits",
	"sign-in-reason",
	"blocked-network",
	"environment-image",
	"resumable-conversation",
	"memory-events",
	"session-backups",
] as const;
export type Capability = (typeof SERVER_CAPABILITIES)[number];
/**
 * The first runner release whose checks take `capabilities` in a welcome. An older runner refuses a
 * welcome with it, so the actor names capabilities only to a runner whose hello reports this or later.
 */
export const CAPABILITIES_RUNNER_VERSION = "0.3.0";
const capabilities = list(line(64), 32);
/**
 * The first runner release whose checks take `gitHost` in a welcome. runner-v0.3.0 shipped before the field
 * existed and refuses unknown welcome keys, so it must never get one. Raise it if another release ships without it.
 */
export const GIT_HOST_RUNNER_VERSION = "0.3.1";
/**
 * The first runner release whose checks take `storeLimits` in a welcome: runner-v0.3.1 refuses unknown
 * welcome keys, so it never gets one and keeps its built-in limits (BUILT_IN_STORE_LIMITS).
 */
export const STORE_LIMITS_RUNNER_VERSION = "0.3.2";
const storeBytes = is<number>(v => count(v) && (v as number) <= MAX_STORE_BYTES);
/** The deployment's caps on a machine's stores, in bytes: a ceiling on `machine` and `user`, a floor on `free`. Only those it sets. */
const storeCaps = object({ machine: optional(storeBytes), user: optional(storeBytes), free: optional(storeBytes) });
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A DNS name of two labels or more, lower case, no address: what an --egress-domains list can hold. */
const gitHost = is<string>(
	v =>
		typeof v === "string" &&
		v.length <= 253 &&
		v.split(".").length >= 2 &&
		v.split(".").every(label => LABEL.test(label)) &&
		!/^\d+$/.test(v.split(".").at(-1)!),
);
/**
 * The welcome's `capabilities` and `gitHost`, for a runner whose hello reported `runnerVersion`. `gitUrl`:
 * where the platform's git clones from (WLP_GITHUB_URL). Its host is named only for an https address on
 * the default port with a DNS name, the only kind a runner's list can reach (as hosted's, e2b/network.ts).
 */
export function welcomeCapabilities(
	runnerVersion: string,
	gitUrl?: string,
	caps: StoreCaps = {},
): { capabilities?: string[]; gitHost?: string; storeLimits?: StoreCaps } {
	if (!versionAtLeast(runnerVersion, CAPABILITIES_RUNNER_VERSION)) return {};
	let host: string | undefined;
	try {
		const url = new URL(gitUrl ?? "");
		if (url.protocol === "https:" && url.port === "" && gitHost(url.hostname)) host = url.hostname;
	} catch {}
	const capped = Object.keys(caps).length > 0 && versionAtLeast(runnerVersion, STORE_LIMITS_RUNNER_VERSION);
	return {
		capabilities: [...SERVER_CAPABILITIES],
		...(host && versionAtLeast(runnerVersion, GIT_HOST_RUNNER_VERSION) && { gitHost: host }),
		...(capped && { storeLimits: { ...caps } }),
	};
}

const refusal = either(
	either(
		object({ kind: oneOf("refused"), reason: oneOf("outdated"), minimum: version, message: line(500) }),
		object({ kind: oneOf("refused"), reason: oneOf("removed"), removeSandboxes: boolean, message: line(500) }),
	),
	/**
	 * "key-in-use": another runner with this key is connected (`secondHello`). "unknown": the signature
	 * is not this machine's key's. "bad-frame": the runner sent what this server does not read.
	 * "other": a reason of a newer server's, made by `parseServerFrame`; only its sentence is read.
	 */
	object({
		kind: oneOf("refused"),
		reason: oneOf("key-in-use", "unknown", "bad-frame", "signing-disabled", "other"),
		message: line(500),
	}),
);
const serverFrame = either(
	either(
		either(
			object({ kind: oneOf("challenge"), nonce }),
			either(
				object({
					kind: oneOf("welcome"),
					idleSuspendMs: count,
					capabilities: optional(capabilities),
					gitHost: optional(gitHost),
					storeLimits: optional(storeCaps),
				}),
				object({
					kind: oneOf("welcome"),
					idleSuspendMs: count,
					capabilities: optional(capabilities),
					gitHost: optional(gitHost),
					storeLimits: optional(storeCaps),
					refusal: optional(refusal),
					...welcomeFields,
				}),
			),
		),
		either(refusal, object({ kind: oneOf("heartbeat") })),
	),
	either(
		/** `ticket` goes into the session socket's hello as it is (protocol.ts limits it to 1024). */
		object({ kind: oneOf("attach"), sessionId: name, ticket: text(1024) }),
		either(
			object({ kind: oneOf("remove"), sandbox: sandboxId }),
			either(object({ kind: oneOf("forget-backup"), sessionId: name }), object({ kind: oneOf("forget-claude-login") })),
		),
	),
);
export type Refusal = Of<typeof refusal>;
export type ServerFrame = Of<typeof serverFrame>;

// ---- Runner → actor ----

const slots = object({
	max: is<number>(v => positiveLimit(v) && v <= 64),
	unit: object({
		cpus: is<number>(v => typeof v === "number" && Number.isFinite(v) && v > 0),
		memoryBytes: positiveLimit,
		pids: positiveLimit,
	}),
	reserve: object({ cpus: count, memoryBytes: count }),
});

/**
 * The hello keeps this shape in every release, so an actor can tell any runner that it is outdated.
 * `epoch` is made once per runner process; `time` is the runner's clock when it sent this, for the
 * offset the page warns about (a frame's travel time is well inside CLOCK_TOLERANCE_MS). The actor
 * checks it in this order, and records nothing before the first passes: the signature over
 * `controlProof` (else "unknown"; a removed machine's key is kept to check it before "removed" is
 * said), the release (else "outdated", recorded for the page), then `secondHello`.
 */
const helloBase = {
	kind: oneOf("hello"),
	runnerVersion: version,
	epoch,
	time,
	signature,
	slots: optional(slots),
	maxTurns: optional(positiveLimit),
};
const hello = either(
	object({ ...helloBase, protocol: optional(oneOf(1)) }),
	object({ ...helloBase, protocol: oneOf(2), ...helloFields }),
);
const modelChoice = object({ id: line(512), name: nullable(line(512)), efforts: list(line(64), 16) });
const optionsShape = object({
	models: list(modelChoice, 16_384),
	defaultModel: line(512),
	checkedAt: time,
	modes: list(object({ id: line(64), name: line(128), description: nullable(line(512)) }), 16),
});
/** Leave room for the sandbox inventory in the same control frame. */
export const validHarnessOptions = is<HarnessOptions>(
	v =>
		optionsShape(v) &&
		v.models.some(model => model.id === v.defaultModel) &&
		new Set(v.models.map(m => m.id)).size === v.models.length &&
		Buffer.byteLength(JSON.stringify(v)) <= MAX_HARNESS_OPTIONS_BYTES,
);
export function boundedCodexOptions(options: HarnessOptions) {
	return options.models.length <= 32 && Buffer.byteLength(JSON.stringify(options)) <= 16 * 1024;
}
const harnessId = oneOf(...MACHINE_HARNESS_IDS);
const digest = is<string>(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v));
const catalogShape = object({ kind: oneOf("catalog"), id: harnessId, options: validHarnessOptions });
const catalog = is<Of<typeof catalogShape>>(
	v => catalogShape(v) && (v.id !== "codex" || boundedCodexOptions(v.options)),
);
const harnessEntry = object({
	id: harnessId,
	keyRelay: optional(oneOf(true)),
	machineProviders: optional(list(line(128), 512)),
	loginGeneration: optional(is<string>(v => typeof v === "string" && /^[0-9a-f]{32}$/.test(v))),
	modes: optional(list(line(64), 16)),
	modeReason: optional(line(500)),
	optionsDigest: optional(digest),
	optionsCheckedAt: optional(time),
	adapter: line(64),
	image: line(128),
	signIn: oneOf("token", "none", "unknown"),
	signInReason: optional(line(300)),
	options: optional(validHarnessOptions),
});
const harnesses = list(
	is<Of<typeof harnessEntry>>(
		v =>
			harnessEntry(v) &&
			(v.id === "codex"
				? !v.options || boundedCodexOptions(v.options)
				: v.modes === undefined && v.modeReason === undefined),
	),
	4,
);
const profileList = list(machineProfile, MACHINE_PROFILES.length);
export const validAllowedProfiles = is<MachineProfile[]>(
	v => profileList(v) && v.includes("docker-hardened") && new Set(v).size === v.length,
);
const nonnegative = is<number>(v => typeof v === "number" && Number.isFinite(v) && v >= 0);
export const validMachineName = is<string>(
	v => typeof v === "string" && v.length <= 64 && v.trim().length > 0 && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(v),
);
export const egressMode = oneOf("open", "restricted", "none");
const host = object({
	cpus: positiveLimit,
	sandboxCpus: is<number>(v => nonnegative(v) && v > 0),
	memoryBytes: count,
	memoryFreeBytes: count,
	load1: nullable(nonnegative),
});
const hostFrame = object({ kind: oneOf("host"), host: nullable(host) });
const report = object({
	egress: optional(egressMode),
	/** How many public hosts the owner's `--egress-domains` list names (github.com included); absent: any public host. The list stays on the machine. */
	egressDomains: optional(is<number>(v => positiveLimit(v) && v <= 64)),
	name: optional(validMachineName),
	host: optional(host),
	slots: optional(slots),
	/** Absent on pre-policy runners, which allowed both Docker profiles. */
	allowedProfiles: optional(validAllowedProfiles),
	/** Accepted for compatibility with older runner reports. */
	claudeLogin: optional(oneOf(true)),
	claudeRelay: optional(oneOf(true)),
	harnesses: optional(harnesses),
	kind: oneOf("report"),
	docker: probe,
	/** The bubblewrap probe (BWRAP_PROBE) in a container of the "docker-windlass-sandbox" profile. */
	commandSandbox: probe,
	/** The runner was started with --screenshots and has a pinned screenshots image. */
	screenshots: optional(boolean),
	environmentBuild: optional(oneOf(true)),
	warmSpares: optional(object({ ready: is<number>(v => count(v) && v <= 2) })),
	gitMirrors: optional(boolean),
	/** A Windlass session in a new hardened sandbox gets a data volume of its own (SESSION_VOLUME_PROFILES). */
	sessionVolumes: optional(boolean),
	blockedNetwork: optional(boolean),
	/** Windlass's Settings-key turns can send their model requests through the machine's model relay (docs/model-relay.md). */
	modelRelay: optional(boolean),
	/** A resumed conversation keeps its processes, output and relay leases through the grace (`resumable-conversation`). */
	resumableConversation: optional(boolean),
	/** The runner keeps copies of its sessions' agent sessions on the machine (`session-backups`, sandbox/machine-backups.ts). */
	sessionBackups: optional(boolean),
	freeDiskBytes: nullable(count),
	/** `usedAt` by the runner's clock: the actor corrects it by the offset from the hello. */
	sandboxes: list(
		object({
			resizePending: optional(oneOf(true)),
			id: sandboxId,
			sessionId: name,
			state: oneOf("running", "paused"),
			usedAt: count,
		}),
		MAX_REPORTED_SANDBOXES,
	),
	/**
	 * The snapshot and Git mirror limits in force, in bytes: its owner's (`--snapshot-disk`, `--snapshot-user`,
	 * `--keep-free`, or the defaults) held to the welcome's `storeLimits`; `capped` where those changed one.
	 */
	storeLimits: optional(
		object({ machine: storeBytes, user: storeBytes, free: storeBytes, capped: optional(oneOf(true)) }),
	),
	/** The caps its owner set (`--max-running`, `--max-sandboxes`), left out where none is set. */
	maxRunning: optional(positiveLimit),
	maxSandboxes: optional(positiveLimit),
});
const runnerFrame = either(
	either(hello, either(report, either(catalog, hostFrame))),
	either(
		object({ kind: oneOf("heartbeat") }),
		either(
			object({ kind: oneOf("removed"), sandbox: sandboxId }),
			either(
				object({ kind: oneOf("backup-forgotten"), sessionId: name }),
				object({ kind: oneOf("claude-login-forgotten"), ok: boolean }),
			),
		),
	),
);
export type Hello = Of<typeof hello>;
export type Report = Of<typeof report>;

/** The report a server that named `capabilities` in its welcome reads: without the fields of those it did not name. */
export function reportFor<R extends Report>(report: R, named: readonly string[] | undefined): R {
	// `start-times` has no field in the report: only a connect says it.
	const fields: Partial<Record<Capability, keyof Report>> = {
		"environment-build": "environmentBuild",
		"warm-spares": "warmSpares",
		"blocked-network": "blockedNetwork",
		"git-mirrors": "gitMirrors",
		"egress-domains": "egressDomains",
		"session-volumes": "sessionVolumes",
		"store-limits": "storeLimits",
		"resumable-conversation": "resumableConversation",
		"session-backups": "sessionBackups",
	};
	const kept: Report = { ...report };
	for (const [capability, field] of Object.entries(fields) as [Capability, keyof Report][])
		if (!named?.includes(capability)) delete kept[field];
	// A field inside each harness entry: taken out of every entry for a server that does not read it.
	if (!named?.includes("sign-in-reason") && kept.harnesses)
		kept.harnesses = kept.harnesses.map(({ signInReason: _, ...entry }) => entry);
	if (!named?.includes("harness-key-relay") && kept.harnesses)
		kept.harnesses = kept.harnesses.map(({ keyRelay: _, machineProviders: __, ...entry }) => entry);
	return kept as R;
}
export type RunnerFrame = Of<typeof runnerFrame>;

/** Bound pending work before parsing another frame. Include the frame currently being processed. */
export class ControlQueue {
	private frames = 0;
	private bytes = 0;
	reserve(bytes: number) {
		if (this.frames >= 128 || this.bytes + bytes > 2 * MAX_REPORT_BYTES) return false;
		this.frames++;
		this.bytes += bytes;
		return true;
	}
	release(bytes: number) {
		this.frames--;
		this.bytes -= bytes;
	}
}

function frameText(data: unknown, maxBytes = MAX_CONTROL_FRAME_BYTES): unknown {
	if (typeof data !== "string" || data.length > maxBytes || Buffer.byteLength(data) > maxBytes) return undefined;
	return json(data);
}

/** For the actor: null for anything a runner sent that is not a frame of this module. */
export function parseRunnerFrame(data: unknown, allowLargeReport = true): RunnerFrame | null {
	const v = frameText(data, allowLargeReport ? MAX_REPORT_BYTES : MAX_CONTROL_FRAME_BYTES);
	if (
		plain(v) &&
		v.kind !== "report" &&
		v.kind !== "catalog" &&
		typeof data === "string" &&
		Buffer.byteLength(data) > MAX_CONTROL_FRAME_BYTES
	)
		return null;
	return runnerFrame(v) ? v : null;
}

/** For the runner: null for anything that is not a frame; a refusal it does not know is "other", so its sentence still shows. */
export function parseServerFrame(data: unknown, strict = false): ServerFrame | null {
	const v = frameText(data);
	if (serverFrame(v)) return v;
	if (!strict && plain(v) && v.kind === "refused" && line(500)(v.message))
		return { kind: "refused", reason: "other", message: v.message };
	return null;
}

/** The refusal, with the sentence the runner prints: made here so the actor and its stand-in say the same. */
export function refuse(
	reason: "outdated" | "removed" | "key-in-use" | "unknown" | "bad-frame",
	detail: { runnerVersion?: string; removeSandboxes?: boolean } = {},
): Refusal {
	switch (reason) {
		case "outdated":
			return { kind: "refused", reason, minimum: MIN_RUNNER_VERSION, message: outdatedRunner(detail.runnerVersion) };
		case "removed":
			return {
				kind: "refused",
				reason,
				removeSandboxes: detail.removeSandboxes === true,
				message: detail.removeSandboxes
					? "This machine was removed from its account. Its sandboxes and data volume are being removed; run `windlass-runner pair` to add it again."
					: "This machine was removed from its account; its sandboxes stay. Run `windlass-runner pair` to add it again.",
			};
		case "key-in-use":
			return {
				kind: "refused",
				reason,
				message:
					"Another runner with this machine's key is connected. If you copied the key, stop the other runner; if you did not, remove the machine on the Machines page.",
			};
		case "unknown":
			return {
				kind: "refused",
				reason,
				message: "The platform does not know this machine's key. Run `windlass-runner pair` to add the machine again.",
			};
		case "bad-frame":
			return {
				kind: "refused",
				reason,
				message: "The platform could not read what this runner sent. Use the runner release the Machines page names.",
			};
	}
}

/**
 * What the actor does with an accepted hello while it may hold a socket already: "accept" with none,
 * "replace" (close the old one, keep the new, and record nothing) when the hello comes from the same
 * runner process, or from another while the old socket has gone quiet past LIVE_MS (a runner that
 * restarted while its old socket was half open), and "refuse" ("key-in-use", recorded for the page's
 * warning) for a second runner process while the first is live.
 */
export function secondHello(
	live: { epoch: string; heardAt: number } | null,
	hello: Pick<Hello, "epoch">,
	now: number,
): "accept" | "replace" | "refuse" {
	if (live === null) return "accept";
	if (live.epoch === hello.epoch || now - live.heardAt > LIVE_MS) return "replace";
	return "refuse";
}

// ---- HTTP, before the runner has a socket ----

/**
 * POST RUNNER_PAIR_PATH, unsigned: a runner with no key asks to be paired. `PairRequest` in,
 * `PairStarted` out. The runner prints the code and polls with the pairing id and the poll secret.
 */
export const RUNNER_PAIR_PATH = "/runner/pair";
/** POST: `PairPoll` in, `PairStatus` out, every PAIRING_POLL_MS for PAIRING_TTL_MS. A 5xx is tried again. */
export const RUNNER_PAIR_POLL_PATH = "/runner/pair/poll";
/**
 * POST, signed: `ConnectionRequest` in. 200: the platform's `PlatformConnection`, with which the runner
 * opens the control socket. Otherwise a `ConnectionRefusal`: 403 "clock" (sign again with the offset to
 * `serverTime`), 403 "unknown", 410 "removed". A removed machine's key is checked before it is told.
 */
export const RUNNER_CONNECTION_PATH = "/runner/connection";

const pairRequest = object({
	protocol: optional(oneOf(2)),
	/** The machine's Ed25519 public key, SPKI PEM. */
	publicKey: text(512),
	name: line(64),
	os: line(32),
	arch: line(32),
	runnerVersion: version,
});
const pairStarted = object({
	code: is<string>(v => typeof v === "string" && PAIRING_CODE.test(v)),
	pairing: base64url(43),
	pollSecret: base64url(43),
});
const pairPoll = object({ pairing: base64url(43), pollSecret: base64url(43) });
const pairStatus = either(
	object({ state: oneOf("waiting", "gone") }),
	/** `githubLogin`: the account's GitHub login, for the runner to print; null when it has no GitHub connection. */
	object({
		state: oneOf("approved"),
		uid: name,
		machineId,
		githubLogin: nullable(line(64)),
		platformRoot: optional(text(80)),
		endpoint: optional(text(2048)),
	}),
);
const connectionRequest = object({ uid: name, machineId, time, signature, nonce: optional(nonce) });
const connectionRefusal = either(
	either(
		object({ reason: oneOf("clock"), serverTime: time }),
		either(
			object({ reason: oneOf("removed"), removeSandboxes: boolean }),
			object({ reason: oneOf("removed"), removeSandboxes: boolean, ...removalFields }),
		),
	),
	object({ reason: oneOf("unknown") }),
);

export type PairRequest = Of<typeof pairRequest>;
export type PairStarted = Of<typeof pairStarted>;
export type PairPoll = Of<typeof pairPoll>;
export type PairStatus = Of<typeof pairStatus>;
export type ConnectionRequest = Of<typeof connectionRequest>;
export type ConnectionRefusal = Of<typeof connectionRefusal>;

/** Each null for a body that is not one: the route answers 400, the runner treats it as a failed request. */
export const parsePairRequest = (body: unknown): PairRequest | null => (pairRequest(body) ? body : null);
export const parsePairStarted = (body: unknown): PairStarted | null => (pairStarted(body) ? body : null);
export const parsePairPoll = (body: unknown): PairPoll | null => (pairPoll(body) ? body : null);
export const parsePairStatus = (body: unknown): PairStatus | null => (pairStatus(body) ? body : null);
export const parseConnectionRequest = (body: unknown): ConnectionRequest | null =>
	connectionRequest(body) ? body : null;
export const parseConnectionRefusal = (body: unknown): ConnectionRefusal | null =>
	connectionRefusal(body) ? body : null;

const connection = object({
	endpointChange: optional(endpointShape),
	endpoint: nullable(text(2048)),
	namespace: text(255),
	token: nullable(object({ token: text(8192), expiresAt: integer, validForMs: count })),
});
/** For the runner: the 200 answer of RUNNER_CONNECTION_PATH. */
export const parseConnection = (body: unknown): Of<typeof connection> | null => (connection(body) ? body : null);

export type Drift = [
	Assert<Same<Of<typeof optionsShape>, HarnessOptions>>,
	Assert<Same<Of<typeof probe>, MachineProbe>>,
	Assert<Same<Omit<Of<typeof connection>, "endpointChange">, PlatformConnection>>,
	Assert<Same<Of<typeof storeCaps>, StoreCaps>>,
];
