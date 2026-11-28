/**
 * What the server and a runner say on a session's socket (Plans/2026-11-19 "bring your own computer",
 * section 1.4). Every WebSocket message is one JSON frame of at most MAX_FRAME_BYTES:
 *
 *   hello    runner → server  first frame on every socket: who it is, and the conversation it resumes
 *   welcome  server → runner  the answer: that conversation resumed, a new one, or a refusal to show
 *   msg      either way       one numbered message (a `Body`)
 *   part     either way       a numbered piece of a message too large for one frame
 *   ack      either way       how far the sender has received; also the heartbeat
 *
 * Validation is here and nowhere else. A type and its check are one definition, so they cannot drift
 * apart, and the `Same` assertions at the end tie the operations to the provider interfaces they carry.
 */
import { spareRecipe, spareSetup } from "./spare-recipe.js";
import { forwardHost, forwardPlaceholder, validProofKey } from "../../../sandbox/relay/wires.cjs";
import { isIP } from "node:net";
import { DEFERRED_INPUTS } from "../sandbox/snapshot-key.js";
import { helloFields, welcomeFields } from "./frame-auth.js";
import { MACHINE_HARNESS_IDS, MODEL_PROVIDERS, type SandboxProfileId } from "../contract.js";
import type { BackupOwner, CreateSandboxInput, ExecOptions, ExecResult } from "../sandbox/api.js";
import { PACK_PATH, SESSION } from "../sandbox/backup-names.js";
import {
	NAME,
	RUN_TAG,
	type Answer,
	type SandboxProcess,
	type StartOptions,
	type TurnSandbox,
} from "../sandbox/provider.js";
import {
	type Assert,
	type Check,
	type Of,
	type Same,
	anything,
	boolean,
	count,
	either,
	integer,
	is,
	json,
	list,
	nil,
	nullable,
	object,
	oneOf,
	optional,
	plain,
	string,
	text,
} from "./check.js";

export const positiveLimit = is<number>(v => count(v) && v > 0);

export const PROTOCOL_VERSION = 2;
export const OLD_RUNNER = "This runner is too old for this platform. Update it with the command on the Machines page.";
/** Under the 256 KiB RivetKit takes per incoming message (registry.ts); the probe measures the gateway. */
export const MAX_FRAME_BYTES = 128 * 1024;
/** The largest message, as JSON: a `run` result holds up to 4 MiB of output (sandboxes.ts, STDOUT_CAP). */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/** Unacknowledged data past which a stream's source is asked to wait (`RunnerChannel.output`). */
export const WINDOW_BYTES = 8 * 1024 * 1024;
export const WINDOW_FRAMES = 10_000;
/** Operations one side may have outstanding: this, times MAX_MESSAGE_BYTES, bounds the answers held. */
export const MAX_OPS_IN_FLIGHT = 16;
export const ACK_MS = 1_000;
export const PING_MS = 15_000;
export const DEAD_MS = 45_000;
export const RUNNER_GRACE_MS = 600_000;
/** What an operation without a `timeoutMs` of its own may take: `create` is `docker run` and `git init`. */
export const OP_MS = 180_000;

/**
 * The longest wait an operation may name. Node fires a timer past 2^31 ms (24.8 days) after 1 ms, on
 * either end; the platform's longest is the setup command's (WLP_SETUP_TIMEOUT_MS, ten minutes unless
 * a deployment raises it), so a day refuses nothing real.
 */
const duration = is<number>(v => count(v) && (v as number) <= 24 * 60 * 60 * 1000);
const id = text(255);
const tag = is<string>(v => id(v) && RUN_TAG.test(v));
const env = is<Record<string, string>>(
	v =>
		plain(v) &&
		Object.entries(v).every(([k, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof value === "string"),
);
/** A machine serves the two Docker profiles; E2B's and the rest are the deployment's. */
export const MACHINE_PROFILES = ["docker-hardened", "docker-windlass-sandbox"] as const;
export type MachineProfile = (typeof MACHINE_PROFILES)[number];
export const machineProfile = oneOf(...MACHINE_PROFILES);
export const PROFILE_DENIED =
	"This machine’s owner has not allowed the Windlass sandbox profile. Start the runner with --allow-profile docker-windlass-sandbox to allow it.";
const harness = optional(oneOf(...MACHINE_HARNESS_IDS));
const sandbox = { id };
const relayLease = is<string>(v => typeof v === "string" && /^[a-f0-9]{32}$/.test(v));
const forwardKey = object({
	provider: oneOf(...MODEL_PROVIDERS),
	host: forwardHost,
	placeholder: forwardPlaceholder,
	proofKey: optional(validProofKey),
	expiresAt: count,
});
const startOptions = {
	gitUser: optional(oneOf(true)),
	cwd: optional(string),
	env: optional(env),
	secretEnv: optional(env),
};

/**
 * The methods of `Sandboxes`, `SandboxHandle`, `TurnSandbox` and `SandboxProcess` that cross to a
 * machine, as [arguments, result]. `id` is a sandbox; `process` is the id of the `start` that made it.
 * `profiles`, `list`, `price` and the other facts come from the machine's report, not from here.
 */
const fingerprint = is<string>(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v));
const snapshotKey = {
	attempt: is<string>(v => typeof v === "string" && /^[a-f0-9]{32}$/.test(v)),
	generation: fingerprint,
	repo: is<string>(v => typeof v === "string" && /^[1-9]\d{0,19}$/.test(v)),
	inputs: fingerprint,
};
const snapshotSource = object({
	...snapshotKey,
	commit: is<string>(v => typeof v === "string" && /^[a-f0-9]{40}$/.test(v)),
	created: count,
});
// Only a canonical DNS name or an IP may cross the session socket, even from a faulty helper.
const destination = nullable(
	is<string>(
		v =>
			typeof v === "string" &&
			v.length <= 253 &&
			!v.includes("%") &&
			(!!isIP(v) || v.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))),
	),
);
const endpoint = { host: destination, port: nullable(is<number>(v => count(v) && v <= 65535)) };
const refusalEntry = object({
	...endpoint,
	reason: oneOf("machine_policy", "private", "provider", "malformed"),
	firstAt: count,
	lastAt: count,
	count: positiveLimit,
});
/** A copy's owner (`BackupOwner`): a user id and a session id of the platform's form, as a copy's name takes them. */
const backupOwner = object({
	uid: is<string>(v => typeof v === "string" && NAME.test(v)),
	sessionId: is<string>(v => typeof v === "string" && SESSION.test(v)),
});
const packPath = is<string>(v => typeof v === "string" && PACK_PATH.test(v));
const operations = {
	openCodeDefault: [object({ providers: list(oneOf(...MODEL_PROVIDERS), MODEL_PROVIDERS.length) }), text(512)],
	memoryEvents: [object(sandbox), nullable(object({ oomKills: count, totalMiB: positiveLimit }))],
	/** The proxy's cumulative snapshot for this turn. A new turn starts its counters before setup. */
	blockedNetwork: [
		object({ ...sandbox, turn: positiveLimit, retained: list(object(endpoint), 50) }),
		object({ broker: fingerprint, hosts: list(refusalEntry, 50), overflow: count }),
	],
	create: [
		object({
			privateData: optional(oneOf(true)),
			environmentBuild: optional(oneOf(true)),
			spare: optional(spareRecipe),
			profile: machineProfile,
			mirrorRepo: optional(snapshotKey.repo),
			size: optional(is<number>(v => positiveLimit(v) && v <= 4)),
			harness,
			screenshots: optional(boolean),
			prepared: optional(
				object({
					...snapshotKey,
					inputs: either(fingerprint, oneOf(DEFERRED_INPUTS)),
					writer: boolean,
					privateData: boolean,
				}),
			),
		}),
		id,
	],
	seedSpare: [object({ ...sandbox, spare: spareRecipe, screenshots: optional(boolean) }), boolean],
	hasSnapshot: [object({ repo: snapshotKey.repo }), boolean],
	saveMirror: [
		object({ ...sandbox, stage: is<string>(v => typeof v === "string" && /^[0-9a-f]{32}$/.test(v)), partial: boolean }),
		boolean,
	],
	saveSnapshot: [
		object({ ...sandbox, source: snapshotSource, options: optional(object({ timeoutMs: duration })) }),
		boolean,
	],
	/** `ownData`: its Windlass data directory is a volume of its own (SandboxHandle.ownData), said only to a server that named `session-volumes`. */
	connect: [
		object(sandbox),
		nullable(
			object({
				cwd: string,
				profile: machineProfile,
				harness,
				snapshot: optional(snapshotSource),
				screenshots: optional(boolean),
				ownData: optional(oneOf(true)),
				/** Its turns can use the machine's model relay (the three operations below), said only to a server that named `model-relay`. */
				modelRelay: optional(oneOf(true)),
				windlassKeyRelay: optional(oneOf(true)),
				blockedNetwork: optional(oneOf(true)),
				memoryEvents: optional(oneOf(true)),
				/** On the first connect after its create, what making it took (SandboxHandle.runnerStart), said only to a server that named `start-times`. */
				needsSpareSeed: optional(oneOf(true)),
				readyKey: optional(fingerprint),
				readySetup: optional(spareSetup),
				startTimes: optional(
					object({ spare: optional(oneOf(true)), image: count, pulled: optional(oneOf(true)), create: count }),
				),
				/** The Docker image id it was made from (SandboxHandle.image), said only to a server that named `environment-image`. */
				image: optional(is<string>(v => typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v))),
			}),
		),
	],
	state: [object(sandbox), oneOf("none", "running", "paused")],
	suspend: [object(sandbox), nil],
	destroy: [object(sandbox), nil],
	/** Its output streams as `out` with this operation's id; `cancel` is its abort signal. */
	run: [
		object({
			...sandbox,
			command: string,
			options: optional(object({ ...startOptions, stdin: optional(string), timeoutMs: optional(duration) })),
		}),
		object({ exitCode: nullable(integer), timedOut: boolean, aborted: boolean, stdout: string, stderr: string }),
	],
	readTextFile: [object({ ...sandbox, path: string }), string],
	writeTextFile: [object({ ...sandbox, path: string, content: string }), nil],
	/** The server names the tag, so a process has it before the runner answers. Its id is the process. */
	start: [object({ ...sandbox, tag, argv: list(string), options: optional(object(startOptions)) }), nil],
	signal: [object({ process: id, sig: oneOf("INT", "TERM", "KILL"), who: oneOf("leader", "all") }), nil],
	killClient: [object({ process: id }), nil],
	ask: [
		object({
			...sandbox,
			argv: list(string),
			options: optional(object({ env: optional(env), timeoutMs: optional(duration) })),
		}),
		nullable(object({ code: nullable(integer), stdout: string, stderr: string })),
	],
	stopLeftovers: [object({ ...sandbox, program: string }), count],
	sweep: [
		object({
			...sandbox,
			tag,
			options: optional(object({ waitMs: optional(duration), files: optional(list(string)) })),
		}),
		count,
	],
	writeSecretFile: [object({ ...sandbox, path: string, content: string }), nil],
	removeFiles: [object({ ...sandbox, paths: list(string) }), nil],
	/**
	 * Windlass's model relay (docs/model-relay.md), only to a runner whose connect said `modelRelay`: a
	 * lease for one turn (its forwarder listens in the sandbox), the turn's token handed to the relay, and
	 * the lease's end. `lease` names the lease on the runner; it is no credential.
	 */
	modelRelay: [
		object({ ...sandbox, forward: optional(forwardKey) }),
		object({
			lease: relayLease,
			placeholder: is<string>(v => typeof v === "string" && /^wlp-model\.[a-f0-9]{32}$/.test(v)),
			env,
		}),
	],
	modelRelayToken: [
		object({
			...sandbox,
			lease: relayLease,
			accessToken: is<string>(v => typeof v === "string" && /^[\x21-\x7e]{16,16384}$/.test(v)),
			expiresAt: count,
		}),
		nil,
	],
	modelRelayClose: [object({ ...sandbox, lease: relayLease }), nil],
	/**
	 * The copies of a session's agent session that the machine keeps (machine-backups.ts), only to a
	 * runner whose report said `sessionBackups`. The runner holds each in a volume of its own and checks
	 * every one against the session whose socket asks: `owner` is that session, and `id` its sandbox.
	 *
	 *   backupSave     takes the archive the sandbox packed at `pack` (and removes it there), and keeps
	 *                  it when it is `size` bytes with `sha256`, at most `max`: `saved` with what the
	 *                  runner itself measured, `changed` (not what was packed), `too_large`, or `full`
	 *                  (the machine's volume of copies has no room for it)
	 *   backupRestore  puts the session's copy at `pack` in the sandbox when it is `size` bytes with
	 *                  `sha256`: `placed`, `missing` (none), or `changed` (not the copy recorded)
	 *   backupCopy     copies `from`'s copy to `to`'s name (`to` is the asking session): false when
	 *                  `from` has none
	 *
	 * A copy's removal is the machine's control socket's (`forget-backup`, control.ts), so that it
	 * happens after the session is gone.
	 */
	backupSave: [
		object({ ...sandbox, owner: backupOwner, pack: packPath, size: count, sha256: fingerprint, max: positiveLimit }),
		object({ outcome: oneOf("saved", "changed", "too_large", "full"), size: count, sha256: optional(fingerprint) }),
	],
	backupRestore: [
		object({ ...sandbox, owner: backupOwner, pack: packPath, size: count, sha256: fingerprint }),
		oneOf("placed", "missing", "changed"),
	],
	backupCopy: [object({ from: backupOwner, to: backupOwner }), boolean],
} as const satisfies Record<string, readonly [Check<unknown>, Check<unknown>]>;

export type Name = keyof typeof operations;
export type Args<N extends Name> = Of<(typeof operations)[N][0]>;
export type Value<N extends Name> = Of<(typeof operations)[N][1]>;
export type Operation = { [N in Name]: { kind: "op"; id: string; name: N; args: Args<N> } }[Name];
export const isName = (v: unknown): v is Name => typeof v === "string" && Object.hasOwn(operations, v);
export const validArgs = <N extends Name>(name: N, args: unknown): args is Args<N> => operations[name][0](args);
export const validValue = <N extends Name>(name: N, value: unknown): value is Value<N> => operations[name][1](value);

/** `user` is a SandboxUserError, a sentence fit to show; `refused` is the runner's policy saying no. */
const failure = object({ kind: oneOf("user", "sandbox", "refused"), message: string });
export type Failure = Of<typeof failure>;

/** The arguments of `op` and the value of `res` are checked against the operation by the receiver. */
const body = either(
	either(
		object({ kind: oneOf("op"), id, name: string, args: is<Record<string, unknown>>(plain) }),
		either(
			object({ kind: oneOf("res"), id, ok: oneOf(true), value: anything }),
			object({ kind: oneOf("res"), id, ok: oneOf(false), error: failure }),
		),
	),
	either(
		either(
			object({ kind: oneOf("out"), id, fd: oneOf(1, 2), data: string }),
			object({ kind: oneOf("end"), id, code: nullable(integer), signal: nullable(string), error: nullable(string) }),
		),
		either(object({ kind: oneOf("in"), id, data: string }), object({ kind: oneOf("close-in", "cancel"), id })),
	),
);
export type Body = Of<typeof body>;

const resume = object({ conversation: id, received: count });
const helloBase = {
	kind: oneOf("hello"),
	runnerVersion: text(64),
	machineId: id,
	ticket: text(1024),
	signature: text(1024),
	resume: nullable(resume),
};
const hello = either(
	object({ ...helloBase, protocol: oneOf(1) }),
	object({ ...helloBase, protocol: oneOf(PROTOCOL_VERSION), ...helloFields }),
);
/** A refusal keeps this shape in every version, so a runner of any version can show it. */
const refusal = object({ kind: oneOf("welcome"), protocol: integer, refused: text(1000) });
const welcomeBase = { kind: oneOf("welcome"), conversation: id, received: count, resumed: boolean };
const welcome = either(
	either(
		object({ ...welcomeBase, protocol: oneOf(1) }),
		object({ ...welcomeBase, protocol: oneOf(PROTOCOL_VERSION), ...welcomeFields }),
	),
	refusal,
);
const seq = is<number>(v => count(v) && v !== 0);
const frame = either(
	either(hello, welcome),
	either(
		either(
			object({ kind: oneOf("msg"), seq, ack: count, body }),
			object({ kind: oneOf("part"), seq, ack: count, data: text(MAX_FRAME_BYTES), last: boolean }),
		),
		object({ kind: oneOf("ack"), ack: count }),
	),
);
export type Hello = Of<typeof hello>;
export type Welcome = Of<typeof welcome>;
/** A hello in another protocol: only its number is read, to say why it is refused. */
export type Foreign = { kind: "foreign"; protocol: number };
export type Frame = Of<typeof frame> | Foreign;

/** Null for anything that is not a frame of this protocol. Nothing of a refused frame is kept. */
export function parseFrame(data: unknown, protocol = PROTOCOL_VERSION): Frame | null {
	if (typeof data !== "string" || data.length > MAX_FRAME_BYTES || Buffer.byteLength(data) > MAX_FRAME_BYTES)
		return null;
	const v = json(data);
	if (plain(v) && v.kind === "hello" && Number.isSafeInteger(v.protocol) && v.protocol !== protocol)
		return { kind: "foreign", protocol: v.protocol as number };
	return frame(v) ? v : null;
}

/** A message put back together from its parts. */
export function parseBody(data: string): Body | null {
	const v = json(data);
	return body(v) ? v : null;
}

export function protocolRefusal(runnerProtocol: number, protocol = PROTOCOL_VERSION): string {
	if (protocol === 2 && runnerProtocol < protocol) return OLD_RUNNER;
	return runnerProtocol < protocol
		? `This machine's runner speaks protocol ${runnerProtocol}; the platform needs ${protocol}. Update the runner.`
		: `This machine's runner speaks protocol ${runnerProtocol}, newer than the platform's ${protocol}. Use the runner release the Machines page names.`;
}

// The wire types are the provider's, without what cannot cross a socket (callbacks, an AbortSignal).
export type Drift = [
	Assert<Same<Args<"create">["harness"], CreateSandboxInput["harness"]>>,
	Assert<Same<Args<"run">["options"], Omit<ExecOptions, "onStdout" | "onStderr" | "signal"> | undefined>>,
	Assert<Same<Value<"run">, ExecResult>>,
	Assert<Same<Args<"start">["options"], Omit<StartOptions, "onStdout" | "onStderr"> | undefined>>,
	Assert<Same<Args<"ask">["options"], Parameters<TurnSandbox["ask"]>[1]>>,
	Assert<Same<Value<"ask">, Answer | null>>,
	Assert<Same<Args<"sweep">["options"], Parameters<TurnSandbox["sweep"]>[1]>>,
	Assert<Same<Args<"signal">["sig"] | Args<"signal">["who"], Parameters<SandboxProcess["signal"]>[number]>>,
	Assert<Same<Args<"create">["profile"], Extract<SandboxProfileId, `docker-${string}`>>>,
	Assert<Same<Args<"backupCopy">["from"], BackupOwner>>,
];
