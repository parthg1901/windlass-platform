/**
 * The sandbox layer of a session whose place is one of its user's machines (Plans/2026-11-19 "bring
 * your own computer", sections 1.4 and 6). The machine's runner serves the provider's operations on its
 * own Docker; every one of them goes over the session's own socket, as a named operation on the
 * session's `ServerChannel` (runner/channel.ts). The turn code (turn.ts) runs here, on the server,
 * unchanged: `SandboxWindlass` over the handle this file makes.
 *
 * A machine's layer is made from the session's link alone (the session's owner, the machine's id),
 * on whichever server asks. The link reads the machine actor's last report without attaching: an offline or
 * removed machine's session stays readable. Its operations fail with a sentence a person can act on.
 *
 * The link (`RunnerLink`) is the session actor's, one per instance, kept in its vars and never stored:
 *
 *   - It has the runner attach on demand. An operation that finds no socket asks the machine's actor
 *     to send `attach` with a new one-use ticket (machines/ticket.ts), again every REATTACH_MS while it
 *     waits, and waits up to ATTACH_WAIT_MS in all for the runner's hello; a machine its actor says is
 *     offline or removed is refused at once.
 *   - A socket lost while work is outstanding is asked for again, every REATTACH_MS, until the work
 *     is done or the channel's grace ends the conversation (the channel then fails the work).
 *   - With nothing outstanding for IDLE_DETACH_MS the socket is let go, so the runner's socket does
 *     not keep the session's actor awake.
 *   - Once closed it does nothing more: no call to the machine's actor, no timer, nobody left waiting.
 *
 * What is repeated after a lost conversation (`ConversationLost`), as the slice B contract allows: the
 * operations that are the same done twice (`again`), `create` among them, because the runner answers
 * a session's second `create` with the sandbox it already made for it; `run` and `start` never (the
 * caller decides, and the turn's own `stopLeftovers` ends what a lost `start` left).
 */

import type { SnapshotSource } from "./snapshot-key.js";
import { backupConfig, config } from "../config.js";
import { isActorGone } from "../actors/internal.js";
import type { Attachment, MachineFacts, TurnSlot } from "../actors/machine.js";
import {
	isolationName,
	type RelaySeen,
	type SandboxProfile,
	type SandboxProfileId,
	type SessionSnapshot,
} from "../contract.js";
import type { LocalModelRelay } from "./plan-relay.js";
import { harnessName, machineHarness } from "./harnesses.js";
import { describeError, serviceParams } from "../auth.js";
import { type ChannelSocket, type ConversationRecord, ConversationLost, ServerChannel } from "../runner/channel.js";
import { machineProfiles } from "../machines/profiles.js";
import { PROFILE_DENIED, type Args, type Name, type Value } from "../runner/protocol.js";
import { AttachTickets } from "../machines/ticket.js";
import {
	type ConnectOptions,
	type CreateSandboxInput,
	type ExecOptions,
	type ExecResult,
	type ListedSandbox,
	type RunnerStartTimes,
	type SandboxLayer,
	type Sandboxes,
	MachineUnreachable,
	ENVIRONMENT_SLOT_WAIT,
	SandboxUserError,
} from "./api.js";
import { MachineSessionBackups } from "./machine-backups.js";
import { SESSION_VOLUME_PROFILES, findProfile } from "./profiles.js";
import { forwardKeyLease } from "./relay-leases.js";
import {
	type Answer,
	type ProcessEnd,
	type SandboxProcess,
	type StartOptions,
	type TurnSandbox,
	markTurnSandbox,
	randomId,
} from "./provider.js";
import { SandboxWindlass } from "./turn.js";
import { errorText } from "../util.js";

/** The raw socket's path: `agentSession.get([uid, sessionId]).webSocket(RUNNER_SOCKET)` on the runner's side. */
export const RUNNER_SOCKET = "runner";
/** How long an operation waits for the runner's hello once the machine's actor has sent `attach`. */
export const ATTACH_WAIT_MS = 15_000;
/** With nothing outstanding this long, the session lets go of the socket (it sleeps 30 s after its last connection). */
export const IDLE_DETACH_MS = 20_000;
/** How often the runner is offered a new ticket while work waits for its socket. */
const REATTACH_MS = 5_000;

// ---------------------------------------------------------------------------------------------
// The machine's actor, as the session sees it
// ---------------------------------------------------------------------------------------------

/** The three internal actions of the `machine` actor `[uid, machineId]` a session uses, and nothing else of it. */
export interface MachineSeam {
	/** Has the runner open this session's socket with `ticket`. */
	attach(sessionId: string, ticket: string): Promise<Attachment>;
	/** With the machine's key, which checks the runner's hello. */
	facts(): Promise<MachineFacts>;
	/** Records that the sandbox must go, and tells the runner when it is next connected. */
	removeSandbox(sandboxId: string | null, sessionId?: string): Promise<void>;
	/** Records that the session's copy of its agent session must go from the machine (machine-backups.ts). */
	removeBackup?(sessionId: string): Promise<void>;
}

/** The real `machine` actor, through the actor's client. A check passes a stand-in instead. */
// biome-ignore lint/suspicious/noExplicitAny: the registry's type would be circular here
export function machineActor(client: () => any, uid: string, machineId: string) {
	const machine = () => client().machine.get([uid, machineId], { params: serviceParams() });
	return {
		turnSlot: (sessionId: string, turn: number, size: number): Promise<TurnSlot> =>
			machine().internalTurnSlot(sessionId, turn, size),
		releaseSlot: (sessionId: string, turn: number): Promise<void> => machine().internalReleaseTurnSlot(sessionId, turn),
		/** The session's turn is paused while the machine is away (`on`): the machine wakes it when its runner is back. */
		pausedSession: (sessionId: string, on: boolean): Promise<boolean> => machine().internalPausedSession(sessionId, on),
		attach: (sessionId: string, ticket: string) => machine().internalAttach({ sessionId, ticket }),
		facts: () => machine().internalFacts(),
		removeSandbox: async (sandboxId: string | null, sessionId?: string) => {
			try {
				await machine().internalRemoveSandbox({ sandboxId, sessionId });
			} catch (error) {
				if (!isActorGone(error)) throw error;
			}
		},
		/** A machine whose actor is gone has no runner left to keep a copy for. */
		removeBackup: async (sessionId: string) => {
			try {
				await machine().internalRemoveBackup({ sessionId });
			} catch (error) {
				if (!isActorGone(error)) throw error;
			}
		},
	};
}

export { MachineUnreachable } from "./api.js";

const REMOVED = "This agent's machine was removed. Its files were there. Start a new agent to go on.";
const SLEPT = "The session went to sleep.";

/** The caller's abort signal fired before the operation was handed to the runner, which never had it. */
class Stopped extends Error {}

// ---------------------------------------------------------------------------------------------
// The session's link to the runner
// ---------------------------------------------------------------------------------------------

/** What a session's offline banner reads. */
export type MachineReach = NonNullable<SessionSnapshot["machine"]>;

interface Who {
	machineName?: string | null;
	uid: string;
	sessionId: string;
	machineId: string;
}

/** The socket RivetKit hands `onWebSocket`, as much of it as the link uses. */
interface RawSocket {
	send(text: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
	addEventListener(type: "close", listener: () => void): void;
}

export class RunnerLink {
	readonly channel: ServerChannel;
	/** The first profile read is shared by snapshots and operations waiting to attach. */
	readonly initialFacts: Promise<MachineFacts | null>;
	private readonly tickets = new AttachTickets();
	/** What the machine's actor last said of it. Had before the first ticket goes out: its key checks the hello. */
	private heard: MachineFacts | null = null;
	private reading?: Promise<MachineFacts>;
	private checkedAt = 0;
	private outstanding = 0;
	/** The callers waiting for a socket, with the one deadline they share. */
	private waiting: { promise: Promise<void>; settle(error?: Error): void } | null = null;
	/** A call to the machine's actor is under way: there is never more than one. */
	private inviting = false;
	private idle?: ReturnType<typeof setTimeout>;
	private retry?: ReturnType<typeof setTimeout>;
	/** What the link last found, for the banner; null before it needed the machine. */
	private found: MachineReach | null = null;
	private closed = false;

	/** `onReach` is told each time what the banner reads changes (answering, not answering, offline, removed). */
	constructor(
		readonly who: Who,
		private readonly machine: MachineSeam,
		onReset: (reason: string) => void,
		private readonly onReach?: (reach: MachineReach) => void,
		/**
		 * The conversation is kept in the session's storage (`ServerChannel.keepIn`, runner/journal.ts):
		 * `from` is what a restarted server read back, `onDirty` asks the owner to save.
		 */
		durable?: { from: ConversationRecord | null; onDirty(): void },
	) {
		this.channel = new ServerChannel({
			platform: config.machines?.identity && { ...who, identity: config.machines.identity },
			accept: hello => this.tickets.admits(hello, { ...this.who, publicKey: this.heard?.publicKey ?? null }),
			onReset,
			onConnect: () => this.connected(),
			onDisconnect: () => this.lost(),
		});
		this.durable = !!durable;
		if (durable) this.channel.keepIn(durable.onDirty, durable.from);
		this.initialFacts = this.facts().catch(() => null);
	}

	/** Whether the conversation is kept in storage, so that a turn's process can outlive this server. */
	readonly durable: boolean;

	/** A socket from `onWebSocket`. The channel decides by its hello whether it counts. */
	socket(ws: RawSocket): void {
		const socket: ChannelSocket = {
			send: text => ws.send(text),
			close: () => ws.close(1000),
			onMessage: listener => ws.addEventListener("message", event => listener(event.data)),
			onClose: listener => ws.addEventListener("close", () => listener()),
		};
		this.channel.attach(socket);
	}

	reach(): MachineReach | null {
		if (this.channel.connected) this.note("answering");
		return this.found;
	}

	/** What the machine's actor last said of the machine, as this link heard it; null before it asked. */
	get known(): MachineFacts | null {
		return this.heard;
	}

	/** Lets go for good: the actor is going to sleep or away, and its turn has been stopped. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.idle);
		clearTimeout(this.retry);
		this.waiting?.settle(new ConversationLost(SLEPT));
		this.channel.close(SLEPT);
	}

	facts(): Promise<MachineFacts> {
		return (this.reading ??= this.machine
			.facts()
			.then(facts => {
				this.heard = facts;
				this.checkedAt = Date.now();
				return facts;
			})
			.finally(() => {
				this.reading = undefined;
			}));
	}

	/** Refresh an idle session's banner from the control socket's owner without an attach.
	 * During a turn the session channel is the authority on whether its work is answering. */
	async snapshotFacts(): Promise<void> {
		if (this.closed) return;
		if (this.channel.connected || this.outstanding) {
			if (!this.heard) await this.initialFacts;
			return;
		}
		const previous = this.found;
		const facts = this.heard && Date.now() - this.checkedAt < 2000 ? this.heard : await this.facts();
		if (this.closed || this.channel.connected || this.outstanding || previous !== this.found) return;
		this.note(facts.status === "online" ? "answering" : facts.status === "removed" ? "removed" : "offline");
	}

	removeSandbox(id: string): Promise<void> {
		return this.machine.removeSandbox(id);
	}

	/** The session's copy on the machine goes, now or when its runner is next connected. */
	async removeBackup(sessionId: string): Promise<void> {
		if (sessionId !== this.who.sessionId) throw new Error("A session removes only its own copy.");
		if (!this.machine.removeBackup) throw new Error("This machine's actor cannot be asked to remove a copy.");
		await this.machine.removeBackup(sessionId);
	}

	/** On deletion the machine also queues any sandbox it reported before the session learnt its id. */
	removeSessionSandboxes(savedId: string | null): Promise<void> {
		return this.machine.removeSandbox(savedId, this.who.sessionId);
	}

	/** One operation: waits for a socket first, so that one the machine cannot give fails now and not after the grace. */
	request<N extends Exclude<Name, "start">>(
		name: N,
		args: Args<N>,
		options: { onOutput?: (fd: 1 | 2, data: string) => void; signal?: AbortSignal } = {},
	): Promise<Value<N>> {
		return this.busy(async () => {
			await this.wait(options.signal);
			// Stopped in the moment since the socket came: the runner must never be handed it, as the channel would hand it over before its cancel.
			if (options.signal?.aborted) throw new Stopped();
			return await this.channel.request(name, args, options);
		});
	}

	/** An operation that is the same done twice: once more after a lost conversation. */
	async again<N extends Exclude<Name, "start">>(name: N, args: Args<N>): Promise<Value<N>> {
		try {
			return await this.request(name, args);
		} catch (error) {
			if (!(error instanceof ConversationLost)) throw error;
			return await this.request(name, args);
		}
	}

	/** A process: `ready` and the channel's `start`, with what is written meanwhile held in order. */
	start(args: Args<"start">, onOutput: (fd: 1 | 2, data: string) => void): RunnerProcess {
		return new RunnerProcess(this, args, onOutput);
	}

	/**
	 * A process a turn of the server before a restart started, in the conversation read back from storage:
	 * null when the channel has no such conversation. The runner is asked back for it, again and again,
	 * until it resumes the conversation or the grace ends it (the process has then ended with ConversationLost).
	 */
	adopt(id: string, args: Args<"start">, onOutput: (fd: 1 | 2, data: string) => void): RunnerProcess | null {
		const held = this.held.get(id);
		if (!held) return null;
		this.held.delete(id);
		held.to = onOutput;
		for (const [fd, data] of held.chunks.splice(0)) onOutput(fd, data);
		return new RunnerProcess(this, args, onOutput, { id, ended: held.ended });
	}

	/**
	 * Takes the process a restarted server's turn will take up (`adopt`), before anything can ask for the
	 * runner's socket: what it sends meanwhile is kept for the turn, and while it is (`holding`) nothing
	 * received is committed, so a server that stops again before the turn took it up loses none of it.
	 */
	hold(id: string): boolean {
		const entry: {
			chunks: Array<[1 | 2, string]>;
			ended: Promise<ProcessEnd>;
			to: ((fd: 1 | 2, data: string) => void) | null;
		} = { chunks: [], ended: Promise.resolve({ code: null, signal: null, error: null }), to: null };
		const taken = this.channel.adoptProcess(id, (fd, data) =>
			entry.to ? entry.to(fd, data) : entry.chunks.push([fd, data]),
		);
		if (!taken) return false;
		entry.ended = taken.ended;
		this.held.set(id, entry);
		return true;
	}

	/** A held process nobody took up (the turn could not go on): it is stopped on the runner, and its output is no longer taken. */
	release(): void {
		for (const id of [...this.held.keys()]) {
			this.held.delete(id);
			this.channel.forgetProcess(id);
			void this.request("signal", { process: id, sig: "KILL", who: "all" }).catch(() => undefined);
		}
	}

	/** Whether a process is held for a turn that has not taken it up yet. */
	get holding(): boolean {
		return this.held.size > 0;
	}

	private readonly held = new Map<
		string,
		{ chunks: Array<[1 | 2, string]>; ended: Promise<ProcessEnd>; to: ((fd: 1 | 2, data: string) => void) | null }
	>();

	/** The server is going away and its storage keeps the conversation for the next (`ServerChannel.abandon`): nothing is ended. */
	abandon(): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.idle);
		clearTimeout(this.retry);
		this.waiting?.settle(new ConversationLost(SLEPT));
		this.channel.abandon();
	}

	/** Waits for the runner's socket for as long as the conversation lasts, not only ATTACH_WAIT_MS: it is back within the grace or not at all. */
	async reconnect(until: Promise<unknown>): Promise<void> {
		let over = false;
		void until.finally(() => {
			over = true;
		});
		while (!over && !this.closed) {
			try {
				await this.wait();
				return;
			} catch (error) {
				if (!(error instanceof MachineUnreachable) || error.reason === "removed") throw error;
				await Promise.race([new Promise(done => setTimeout(done, REATTACH_MS)), until]);
			}
		}
	}

	/** Counts `work` as outstanding while it runs. */
	async busy<T>(work: () => Promise<T>): Promise<T> {
		this.outstanding += 1;
		clearTimeout(this.idle);
		try {
			return await work();
		} finally {
			this.outstanding -= 1;
			if (this.outstanding === 0 && !this.closed) {
				clearTimeout(this.retry);
				// The work that waited on a lost socket is over: the machine did not come back for it.
				if (this.found?.state === "not_answering" && !this.channel.connected) this.note("offline");
				this.restLater();
			}
		}
	}

	/** Resolves once a socket is current. Throws MachineUnreachable when the machine's actor says it cannot be, or no hello comes in time. */
	ready(): Promise<void> {
		return this.busy(() => this.wait());
	}

	/** An abort settles this caller at once; the others go on waiting. */
	private wait(signal?: AbortSignal): Promise<void> {
		if (this.closed) return Promise.reject(new ConversationLost(SLEPT));
		if (signal?.aborted) return Promise.reject(new Stopped());
		if (this.channel.connected) return Promise.resolve();
		const { promise } = this.waiting ?? this.begin();
		if (!signal) return promise;
		return new Promise<void>((resolve, reject) => {
			const stop = () => reject(new Stopped());
			signal.addEventListener("abort", stop, { once: true });
			promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
		});
	}

	/** The first caller to find no socket: one deadline from now, before the machine is even asked, for it and all who join it. */
	private begin(): NonNullable<RunnerLink["waiting"]> {
		let settle!: (error?: Error) => void;
		const promise = new Promise<void>((resolve, reject) => {
			settle = error => (error ? reject(error) : resolve());
		});
		// Each caller handles it; this only keeps it from counting as unhandled when the only one stopped waiting.
		promise.catch(() => undefined);
		const deadline = setTimeout(() => this.unreachable("offline"), ATTACH_WAIT_MS);
		const waiting = {
			promise,
			settle: (error?: Error) => {
				if (this.waiting !== waiting) return;
				this.waiting = null;
				clearTimeout(deadline);
				settle(error);
			},
		};
		this.waiting = waiting;
		this.ask();
		return waiting;
	}

	/** While work waits for a socket: a ticket now, and another every REATTACH_MS, whatever the machine's actor took to answer the last. */
	private ask(): void {
		clearTimeout(this.retry);
		if (this.closed || this.channel.connected || this.outstanding === 0) return;
		void this.invite();
		this.retry = setTimeout(() => this.ask(), REATTACH_MS);
	}

	/** One ticket through the machine's actor; skipped while the last call has not answered, so a slow actor is never asked twice at once. */
	private async invite(): Promise<void> {
		if (this.inviting) return;
		this.inviting = true;
		try {
			// The runner's hello can come before the actor's answer to `attach`: the key must be had first.
			await this.initialFacts;
			if (this.closed) return;
			if (!this.heard) await this.facts();
			if (this.closed || this.channel.connected) return;
			const answer = await this.machine.attach(this.who.sessionId, this.tickets.issue());
			if (!answer.ok && !this.closed) this.unreachable(answer.reason === "offline" ? "offline" : "removed");
		} catch (error) {
			// Asked again on the cadence; the deadline answers whoever waits.
			if (!this.closed)
				console.warn(
					`[wlp] runner.attach_unanswered session=${this.who.sessionId} machine=${this.who.machineId}: ${errorText(error)}`,
				);
		} finally {
			this.inviting = false;
		}
	}

	/** Settles whoever waits for a socket. The name is what the link already has: nothing more is asked of an actor that may be what is slow. */
	private unreachable(reason: "offline" | "removed"): void {
		const error = this.away(reason);
		this.waiting?.settle(error);
	}

	away(reason: "offline" | "removed"): MachineUnreachable {
		if (reason === "removed" || this.found?.state !== "not_answering") this.note(reason);
		if (reason === "removed") {
			this.channel.close(REMOVED);
			return new MachineUnreachable(reason, REMOVED);
		}
		const name = this.heard?.name ?? this.who.machineName;
		return new MachineUnreachable(
			reason,
			`${name ? `Your machine "${name}"` : "Your machine"} is offline. The agent's files are there; send the prompt again when it is back.`,
		);
	}

	/** A hello made a socket current. */
	private connected(): void {
		this.note("answering");
		clearTimeout(this.retry);
		this.waiting?.settle();
		// A runner can answer a ticket after the work it was for gave up: that socket goes like any idle one.
		if (this.outstanding === 0) this.restLater();
	}

	/** The socket closed. With work outstanding the runner is asked back; the channel keeps the work for its grace. */
	private lost(): void {
		if (this.closed || this.channel.connected) return;
		this.note(this.outstanding ? "not_answering" : "offline");
		if (this.outstanding) this.ask();
	}

	private note(state: MachineReach["state"]): void {
		if (this.found?.state === state) return;
		this.found = { state, since: Date.now() };
		if (state === "offline" || state === "removed") this.checkedAt = 0;
		this.onReach?.(this.found);
	}

	private restLater(): void {
		clearTimeout(this.idle);
		this.idle = setTimeout(() => this.rest(), IDLE_DETACH_MS);
	}

	private rest(): void {
		if (this.outstanding === 0 && this.channel.connected) this.channel.detach();
	}
}

/** `SandboxProcess` over the link: started once the socket is there, with stdin and a close held until then. */
class RunnerProcess implements SandboxProcess {
	readonly ended: Promise<ProcessEnd>;
	hasEnded = false;
	private id: string | null = null;
	private held: string[] = [];
	private closing = false;

	constructor(
		private readonly link: RunnerLink,
		readonly args: Args<"start">,
		onOutput: (fd: 1 | 2, data: string) => void,
		/** A process the runner already runs (`RunnerLink.adopt`). */
		adopted?: { id: string; ended: Promise<ProcessEnd> },
	) {
		if (adopted) this.id = adopted.id;
		const ran = link.busy(async () => {
			if (adopted) {
				await link.reconnect(adopted.ended).catch(() => undefined);
				return await adopted.ended;
			}
			await link.ready();
			const { id, ended } = link.channel.start(args, onOutput);
			this.id = id;
			for (const text of this.held.splice(0)) link.channel.write(id, text);
			if (this.closing) link.channel.closeIn(id);
			return await ended;
		});
		this.ended = ran
			.then(
				end => end,
				(error: unknown): ProcessEnd => ({
					code: null,
					signal: null,
					error: error instanceof Error ? error : new Error(String(error)),
				}),
			)
			.then(end => {
				this.hasEnded = true;
				return end;
			});
	}

	get tag(): string {
		return this.args.tag;
	}

	/** Once the runner has it, on a durable link: what a turn checkpoint names (`SandboxProcess.runnerProcess`). */
	get runnerProcess(): string | null {
		return this.link.durable && this.id !== null && !this.hasEnded && this.link.channel.running(this.id)
			? this.id
			: null;
	}

	write(text: string): boolean {
		if (this.hasEnded || this.closing) return false;
		if (this.id === null) {
			this.held.push(text);
			return true;
		}
		return this.link.channel.write(this.id, text);
	}

	closeStdin(): void {
		if (this.id === null) this.closing = true;
		else this.link.channel.closeIn(this.id);
	}

	async signal(sig: "INT" | "TERM" | "KILL", who: "leader" | "all"): Promise<void> {
		// A process not started yet has nothing to signal; one whose link is gone has nobody to tell.
		if (this.id === null || this.hasEnded) return;
		await this.link.request("signal", { process: this.id, sig, who }).catch(() => undefined);
	}

	killClient(): void {
		if (this.id !== null && !this.hasEnded)
			void this.link.request("killClient", { process: this.id }).catch(() => undefined);
	}
}

// ---------------------------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------------------------

/** How often a turn takes what its machine's plan relay saw of the plan. */
const PLAN_SEEN_MS = 15_000;

/** When a machine's plan relay stops by itself: past the turn's limit from now, so a dead server leaves no token for long. */
const planRelayExpiry = () => Date.now() + config.turnTimeoutMs + 60_000;

class RunnerHandle implements TurnSandbox {
	readonly approval: "auto" | "full";
	readonly profile: SandboxProfileId;
	readonly cwd: string;
	readonly runnerScreenshots: boolean;
	readonly snapshot?: SnapshotSource;
	readonly ownData: boolean;
	readonly runnerStart?: RunnerStartTimes;
	readonly readyKey?: string;
	readonly readySetup?: TurnSandbox["readySetup"];
	readonly image?: string;
	readonly memoryEvents?: TurnSandbox["memoryEvents"];

	constructor(
		private readonly link: RunnerLink,
		readonly id: string,
		found: NonNullable<Value<"connect">>,
	) {
		this.profile = found.profile;
		this.cwd = found.cwd;
		this.runnerScreenshots = found.screenshots === true;
		this.snapshot = found.snapshot;
		this.ownData = found.ownData === true;
		this.runnerStart = found.startTimes;
		this.readyKey = found.readyKey;
		this.readySetup = found.readySetup;
		this.image = found.image;
		this.approval = findProfile(found.profile).approval;
		markTurnSandbox(this);
		if (found.memoryEvents)
			this.memoryEvents = () => link.request("memoryEvents", { id }, { signal: AbortSignal.timeout(5_000) });
		if (found.blockedNetwork)
			this.blockedNetwork = (turn, retained) =>
				link.request("blockedNetwork", { id, turn, retained }, { signal: AbortSignal.timeout(5_000) });
		if (found.modelRelay && config.modelRelay.on) {
			this.modelKeyRelay = (sessionId, key, signal) => {
				if (sessionId !== link.who.sessionId) throw new Error("This model relay belongs to another session.");
				// A plan's requests leave from the machine through its own plan relay, never through the platform's.
				if (key.plan) throw new Error("A plan pays through the machine's plan relay.");
				return forwardKeyLease(
					this.uid,
					sessionId,
					key,
					link.who.machineId,
					async forward => this.closeableRelay(await link.request("modelRelay", { id, forward }, { signal })),
					signal,
				);
			};
		}
		// The turn's request limit, counted by the relay on the machine: a machine turn has no `takeRequest`.
		this.localPlanRelay = async (token, options) => {
			if (options.wire !== "claude-plan" && options.wire !== "chatgpt-plan")
				throw new Error("A plan relay takes only a plan's wire.");
			const opened = await link.request(
				"planRelay",
				{
					id,
					wire: options.wire,
					harness: options.harness,
					token,
					expiresAt: planRelayExpiry(),
					requestLimit: config.modelRelay.turnRequests,
				},
				{ signal: options.signal },
			);
			return this.planRelayOf(opened, options.onSeen);
		};
		if (link.durable)
			this.resumePlanRelay = (relay, onSeen) =>
				this.planRelayOf({ lease: relay.lease, placeholder: relay.placeholder, env: relay.env }, onSeen);
		if (link.durable)
			this.adopt = (process, tag, { onStdout, onStderr }) =>
				link.adopt(process, { id, tag, argv: [] }, (fd, data) => (fd === 1 ? onStdout : onStderr)?.(data));
	}

	readonly blockedNetwork?: TurnSandbox["blockedNetwork"];
	readonly modelKeyRelay?: TurnSandbox["modelKeyRelay"];

	/** `TurnSandbox.localPlanRelay`: a plan relay on the machine. */
	readonly localPlanRelay: TurnSandbox["localPlanRelay"];
	/** `TurnSandbox.resumePlanRelay`: the runner keeps the plan relay with the conversation through the grace. */
	readonly resumePlanRelay?: TurnSandbox["resumePlanRelay"];

	/** `TurnSandbox.adopt`, on a durable link. */
	readonly adopt?: TurnSandbox["adopt"];

	private closeableRelay(opened: Value<"modelRelay">) {
		return {
			...opened,
			close: async () => {
				await this.link.again("modelRelayClose", { id: this.id, lease: opened.lease }).catch(() => undefined);
			},
		};
	}

	/**
	 * The machine's plan relay as a turn holds it: its token replaced with `planRelayToken`, what it saw of the plan
	 * taken every `PLAN_SEEN_MS` and once more before it is closed (the provider's answers reach plan health as a
	 * microVM's relay's do).
	 */
	private planRelayOf(opened: Value<"planRelay">, onSeen?: (seen: RelaySeen) => void): LocalModelRelay {
		const take = async () => {
			const seen = await this.link
				.request("planRelaySeen", { id: this.id, lease: opened.lease }, { signal: AbortSignal.timeout(10_000) })
				.catch(() => []);
			for (const one of seen) onSeen?.(one);
		};
		const timer = onSeen ? setInterval(() => void take(), PLAN_SEEN_MS) : undefined;
		timer?.unref?.();
		let closing: Promise<void> | undefined;
		return {
			placeholder: opened.placeholder,
			env: opened.env,
			// Where a restarted server takes it up again (`resumePlanRelay`).
			lease: opened.lease,
			// Each hand-over moves its end on: a turn taken up after a restart has a new window (`resumePlanRelay`).
			hand: async token => {
				if (closing) throw new Error("This relay has ended.");
				await this.link.again("planRelayToken", {
					id: this.id,
					lease: opened.lease,
					token,
					expiresAt: planRelayExpiry(),
				});
			},
			close: () =>
				(closing ??= (async () => {
					clearInterval(timer);
					if (onSeen) await take();
					await this.link.again("modelRelayClose", { id: this.id, lease: opened.lease }).catch(() => undefined);
				})()),
		};
	}

	get uid(): string {
		return this.link.who.uid;
	}

	async run(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		const { onStdout, onStderr, signal, ...rest } = options;
		try {
			// Not repeated: a clone, a push or a setup run that was lost is the caller's to try again or not.
			return await this.link.request(
				"run",
				{ id: this.id, command, options: rest },
				{ signal, onOutput: (fd, data) => (fd === 1 ? onStdout : onStderr)?.(data) },
			);
		} catch (error) {
			if (error instanceof Stopped) return { exitCode: null, timedOut: false, aborted: true, stdout: "", stderr: "" };
			throw error;
		}
	}

	readTextFile(path: string): Promise<string> {
		return this.link.again("readTextFile", { id: this.id, path });
	}

	async writeTextFile(path: string, content: string): Promise<void> {
		await this.link.again("writeTextFile", { id: this.id, path, content });
	}

	start(argv: string[], options: StartOptions = {}): SandboxProcess {
		const { onStdout, onStderr, ...rest } = options;
		// The server names the tag, so the process has it before the runner answers.
		return this.link.start({ id: this.id, tag: `r${randomId(6)}`, argv, options: rest }, (fd, data) =>
			(fd === 1 ? onStdout : onStderr)?.(data),
		);
	}

	/**
	 * Null when it could not be run, as the interface has it: the link is gone, or the machine with it.
	 * Repeated after a lost conversation, which is safe only for an `ask` that reads: every `ask` of
	 * turn.ts does. An `ask` that is not the same done twice needs its own path through `request`, not
	 * this one.
	 */
	ask(argv: string[], options?: { env?: Record<string, string>; timeoutMs?: number }): Promise<Answer | null> {
		return this.link.again("ask", { id: this.id, argv, options }).catch(() => null);
	}

	stopLeftovers(program: string): Promise<number> {
		return this.link.again("stopLeftovers", { id: this.id, program });
	}

	sweep(tag: string, options?: { waitMs?: number; files?: string[] }): Promise<number> {
		return this.link.again("sweep", { id: this.id, tag, options });
	}

	async writeSecretFile(path: string, content: string): Promise<void> {
		await this.link.again("writeSecretFile", { id: this.id, path, content });
	}

	async removeFiles(paths: string[]): Promise<void> {
		await this.link.again("removeFiles", { id: this.id, paths });
	}

	/** The runner installs it with its own helper container. Not repeated: a save lost with its conversation is skipped. */
	saveMirror(stage: string, partial: boolean): Promise<boolean> {
		return this.link.request("saveMirror", { id: this.id, stage, partial });
	}

	/**
	 * Nothing, as on hosted Docker: the runner never stops a sandbox while its session's socket is
	 * connected or anything runs in it, so a turn has nothing to vouch for.
	 */
	async holdForTurn(): Promise<() => Promise<void>> {
		return async () => undefined;
	}
}

class RunnerSandboxes implements Sandboxes {
	/** A sandbox on the machine stops when its session suspends it or by the runner's own idle rule, and costs the platform nothing. */
	readonly idleStopMs = null;
	/** Windlass's data is in the user's volume on the machine, which outlives every sandbox there. */
	readonly sessionsLiveInSandbox = false;

	constructor(private readonly link: RunnerLink) {}

	/**
	 * Except in a hardened sandbox, where a runner that reports `sessionVolumes` gives each its own. Only a
	 * guess, for words (`Sandboxes.privateSessionData`): the runner may be another by the time a sandbox is
	 * made, and what that one has is what its connect says (`RunnerHandle.ownData`).
	 */
	async privateSessionData(profile: SandboxProfileId): Promise<boolean> {
		if (!SESSION_VOLUME_PROFILES.includes(profile)) return false;
		const facts = this.link.known ?? (await this.link.facts().catch(() => null));
		return facts?.report?.sessionVolumes === true;
	}

	price(): null {
		return null;
	}

	/** From the machine's last report, with availability unknown while the actor cannot answer. */
	profiles(): SandboxProfile[] {
		const facts = this.link.known;
		return machineProfiles(facts?.name || this.link.who.machineName, facts?.report ?? null);
	}

	/** Never throws for a profile the platform knows: a session must stay readable whatever its machine reports. */
	profile(id: SandboxProfileId): SandboxProfile {
		return this.profiles().find(profile => profile.id === id) ?? findProfile(id);
	}

	async list(uid: string): Promise<ListedSandbox[]> {
		if (uid !== this.link.who.uid) return [];
		const { report } = await this.link.facts();
		return (report?.sandboxes ?? []).map(({ id, sessionId, state }) => ({ id, sessionId, state }));
	}

	async create(input: CreateSandboxInput): Promise<string> {
		const { link } = this;
		if (input.uid !== link.who.uid || input.sessionId !== link.who.sessionId)
			throw new Error("A machine's sandbox is made only for the session whose socket asks for it.");
		if (input.profile !== "docker-windlass-sandbox" && input.profile !== "docker-hardened")
			throw new SandboxUserError("That sandbox does not run on a machine of yours: choose Strict or Open.");
		// A `create` lost with its conversation may have made the sandbox: the runner answers the repeat with that one.
		// Request the screenshots image only when this runner offers it.
		const agent = input.harness ? machineHarness(input.harness) : null;
		if (agent && !agent.profiles.includes(input.profile))
			throw new SandboxUserError(
				`${agent.name} requires the ${agent.profiles.map(isolationName).join(" or ")} profile.`,
			);
		const report =
			input.profile === "docker-windlass-sandbox" ||
			input.environmentBuild ||
			input.spareRecipe ||
			input.mirrorRepo ||
			input.harness ||
			input.screenshots ||
			(input.size ?? 1) > 1
				? (await link.facts()).report
				: null;
		if ((input.size ?? 1) > 1 && !report?.slots)
			throw new SandboxUserError("This runner does not support sizing beyond one slot.");
		if (report?.allowedProfiles && !report.allowedProfiles.includes(input.profile))
			throw new SandboxUserError(PROFILE_DENIED);
		if (input.harness && !report?.harnesses?.some(h => h.id === input.harness))
			throw new SandboxUserError(
				`This machine's runner does not offer ${harnessName(input.harness)}. Update it and start it with --harness ${input.harness}.`,
			);
		const screenshots = !!(input.screenshots && !input.harness && report?.screenshots);
		const spare =
			report?.warmSpares && input.spareRecipe
				? await input.spareRecipe(report.warmSpares.ready).catch(() => undefined)
				: undefined;
		if (input.environmentBuild && !report?.environmentBuild && report?.warmSpares?.ready)
			throw new SandboxUserError(ENVIRONMENT_SLOT_WAIT);
		const args = {
			profile: input.profile,
			...(input.privateData && !input.fromSnapshot && { privateData: true as const }),
			...(input.environmentBuild && report?.environmentBuild && { environmentBuild: true as const }),
			...(spare && { spare }),
			...(report?.gitMirrors && input.mirrorRepo && { mirrorRepo: input.mirrorRepo }),
			...(input.size && input.size > 1 && { size: input.size }),
			...(input.harness && { harness: input.harness }),
			...(screenshots && { screenshots }),
		};
		if (input.fromSnapshot && !input.harness && config.machines?.identity) {
			await link.ready();
			if (link.channel.authenticated) {
				try {
					return await link.request("create", {
						...args,
						prepared: { ...input.fromSnapshot, privateData: !!input.privateData },
					});
				} catch (error) {
					if (
						!(error instanceof ConversationLost) &&
						!(error instanceof Error && error.message === "This runner does not serve that operation.")
					)
						throw error;
				}
			}
		}
		return await link.again("create", args);
	}

	async hasSnapshot(uid: string, repo: string) {
		if (!config.machines?.identity || uid !== this.link.who.uid) return false;
		await this.link.ready();
		return this.link.channel.authenticated && this.link.request("hasSnapshot", { repo });
	}

	async saveSnapshot(id: string, source: SnapshotSource) {
		if (!config.machines?.identity) return false;
		await this.link.ready();
		return (
			this.link.channel.authenticated &&
			this.link.request("saveSnapshot", { id, source, options: { timeoutMs: 15 * 60_000 } })
		);
	}

	async connect(id: string, options?: ConnectOptions): Promise<TurnSandbox | undefined> {
		const { link } = this;
		const found = await link.again("connect", { id });
		if (found?.needsSpareSeed && link.channel.authenticated && options?.spareSeed) {
			// Fetch the authorized base off the turn's path. A later create wins over a late reply.
			void options
				.spareSeed()
				.then(spare => {
					if (spare && link.channel.authenticated)
						return link.request("seedSpare", { id, spare, screenshots: options.screenshots });
				})
				.catch(() => {});
		}
		return found ? new RunnerHandle(link, id, found) : undefined;
	}

	/** On a machine that cannot be reached, what its last report said. */
	async state(id: string): Promise<"none" | "running" | "paused"> {
		const { link } = this;
		try {
			await link.ready();
		} catch (error) {
			if (!(error instanceof MachineUnreachable)) throw error;
			return (await link.facts()).report?.sandboxes.find(sandbox => sandbox.id === id)?.state ?? "none";
		}
		return link.again("state", { id });
	}

	/**
	 * Throws MachineUnreachable on a machine that cannot be reached, so that its caller keeps the state it
	 * had: one whose network is down may still be running it, and a session that said "paused" would not
	 * ask again. The runner stops one nobody uses by itself.
	 */
	async suspend(id: string): Promise<void> {
		await this.link.again("suspend", { id });
	}

	/** Recorded with the machine's actor first, which has the runner remove it when it is next connected: so a machine that is offline now still loses it. */
	async destroy(id: string): Promise<void> {
		const { link } = this;
		await link.removeSandbox(id);
		// Recorded: the removal happens whatever follows, so only a record not written fails the caller
		// (a session's delete is refused then, agent-session.ts `internalDestroy`). Asking now is only sooner.
		try {
			await link.ready();
			await link.again("destroy", { id });
		} catch (error) {
			if (!(error instanceof MachineUnreachable))
				console.warn(
					`[wlp] sandbox.destroy_later id=${id}: recorded with the machine, which removes it when its runner is next connected (${describeError(error)})`,
				);
		}
	}
}

/**
 * The layer of a machine. Its sign-ins are the deployment's (`hosted`): a turn on a machine pays with a plan through
 * a relay on the machine, or a Settings key through the platform's relay. The turn checks the machine sandbox's own
 * engine for host tools.
 */
export function machineLayer(link: RunnerLink, hosted: SandboxLayer): SandboxLayer {
	const host = { version: async () => null, problem: () => hosted.windlass.problem() };
	const windlass = new SandboxWindlass(host);
	return {
		machine: { name: link.known?.name || link.who.machineName || link.who.machineId },
		sandboxes: new RunnerSandboxes(link),
		windlass,
		logins: hosted.logins,
		tokens: hosted.tokens,
		backups: machineBackups(link),
	};
}

/** The largest copy a machine keeps: the deployment's limit for the bucket's (WLP_BACKUP_MAX_BYTES), which needs no bucket. */
function machineBackupMax(): number {
	try {
		return backupConfig().maxBytes;
	} catch {
		return 64 * 1024 * 1024;
	}
}

/**
 * The machine's copies of its sessions' agent sessions (machine-backups.ts), kept on the machine: over
 * this session's socket, while its runner says in its report that it keeps them (`session-backups`).
 */
function machineBackups(link: RunnerLink): MachineSessionBackups {
	return new MachineSessionBackups(machineBackupMax(), {
		available: async () => {
			const facts = await link.facts().catch(() => link.known);
			return facts?.status !== "removed" && facts?.report?.sessionBackups === true;
		},
		save: args => link.request("backupSave", args),
		restore: args => link.request("backupRestore", args),
		copy: args => link.request("backupCopy", args),
		remove: sessionId => link.removeBackup(sessionId),
	});
}
