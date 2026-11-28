// A conversation spans reconnects. Peers replay unacknowledged frames by sequence only within that conversation.
// On loss, outstanding operations have unknown outcomes and stay behind. A replaced socket cannot deliver frames.
// Channel methods run synchronously, so actor actions interleave only between calls.
import { plain } from "./check.js";
import type { KeyObject } from "node:crypto";
import {
	authFailure,
	FrameAuthError,
	platformWelcome,
	runnerHandshake,
	type FrameAuth,
	type PlatformIdentity,
	type Trust,
} from "./frame-auth.js";
import { SandboxConnectionLost, SandboxUserError } from "../sandbox/api.js";
import type { ProcessEnd } from "../sandbox/provider.js";
import {
	ACK_MS,
	DEAD_MS,
	MAX_FRAME_BYTES,
	MAX_MESSAGE_BYTES,
	MAX_OPS_IN_FLIGHT,
	OP_MS,
	PING_MS,
	PROTOCOL_VERSION,
	RUNNER_GRACE_MS,
	WINDOW_BYTES,
	WINDOW_FRAMES,
	isName,
	parseBody,
	parseFrame,
	protocolRefusal,
	validArgs,
	validValue,
	type Args,
	type Body,
	type Failure,
	type Frame,
	type Hello,
	type Name,
	type Operation,
	type Value,
	type Welcome,
} from "./protocol.js";

export interface ChannelSocket {
	send(text: string): void;
	close(): void;
	onMessage(listener: (data: unknown) => void): void;
	onClose(listener: () => void): void;
}

/** The conversation an operation was sent in has ended: whether it ran is unknown. */
export class ConversationLost extends SandboxConnectionLost {}

// The session journal resumes a conversation within the runner's grace period.
// Only committed incoming frames may be acknowledged. Unacknowledged outgoing frames replay in sequence.
export interface ConversationRecord {
	conversation: string;
	sent: number;
	acked: number;
	received: number;
	frames: Array<[number, string]>;
}

export interface Unsaved {
	/** Null: the conversation ended, and nothing of it is to be kept. */
	conversation: string | null;
	/** The conversation changed since the last save: what is stored of the old one goes. */
	fresh: boolean;
	sent: number;
	acked: number;
	/** The frames numbered since the last save, as they may be stored. */
	frames: Array<[number, string]>;
}

// Persist a cancel with the same id in place of secret-bearing frames. After restart the caller supplies fresh credentials.
export function carriesSecret(body: Body): boolean {
	if (body.kind !== "op") return false;
	if (
		body.name === "modelRelay" ||
		body.name === "writeSecretFile" ||
		body.name === "planRelay" ||
		body.name === "planRelayToken"
	)
		return true;
	const options = (body.args as { options?: { secretEnv?: unknown } }).options;
	return (
		!!options &&
		typeof options.secretEnv === "object" &&
		options.secretEnv !== null &&
		Object.keys(options.secretEnv).length > 0
	);
}

type Output = (fd: 1 | 2, data: string) => void;
interface Options {
	/** The conversation ended with `reason`; everything outstanding in it has been let go. */
	onReset?(reason: string): void;
}
/** A UTF-16 unit takes at most 6 bytes once escaped into a part's string. */
const PART_UNITS = MAX_FRAME_BYTES / 8;
// Allow a full window and all in-flight operations, including escaping overhead. Disconnect a peer that exceeds this budget.
const HELD_BYTES = 2 * (WINDOW_BYTES + (MAX_OPS_IN_FLIGHT + 1) * MAX_MESSAGE_BYTES);
// Bound unauthenticated sockets that could hold the actor awake. A runner introduces itself in its first frame.
const MAX_STRANGERS = 4;

function measure(body: Body): string {
	const json = JSON.stringify(body);
	if (Buffer.byteLength(json) > MAX_MESSAGE_BYTES)
		throw new Error("The message is larger than the runner channel carries.");
	return json;
}

abstract class Channel {
	protected socket: ChannelSocket | null = null;
	protected conversation: string | null = null;
	protected closed = false;
	protected readonly codecs = new WeakMap<ChannelSocket, FrameAuth>();
	private sent = 0;
	private acked = 0;
	private received = 0;
	private told = 0;
	private backlog = new Map<number, { text: string; bytes: number; stored?: string }>();
	private bytes = 0;
	/** Messages made while there is no conversation, numbered when the next one starts. */
	private unsent: Body[] = [];
	private parts: string[] = [];
	private partUnits = 0;
	private heard = 0;
	private spoke = 0;
	private waiting = false;
	private strangers = new Map<ChannelSocket, ReturnType<typeof setTimeout>>();
	private clock?: ReturnType<typeof setInterval>;
	private grace?: ReturnType<typeof setTimeout>;
	// Write outgoing frames before sending and commit incoming effects before acknowledging.
	private durable: {
		frames: Array<[number, string]>;
		stored: number;
		committed: number;
		saved: string | null;
		onDirty(): void;
	} | null = null;

	constructor(
		private readonly base: Options & { onDrain?(): void; onDisconnect?(): void },
		private readonly graceReason: string,
	) {}

	// Restore the journal and give the runner a grace period to reconnect. onDirty wakes the journal writer.
	protected keep(onDirty: () => void, from: ConversationRecord | null): void {
		this.durable = { frames: [], stored: 0, committed: 0, saved: null, onDirty };
		if (!from || this.conversation) return;
		this.conversation = from.conversation;
		this.sent = from.sent;
		this.acked = from.acked;
		this.received = this.told = from.received;
		for (const [seq, text] of from.frames) {
			if (seq <= from.acked || seq > from.sent) continue;
			const bytes = Buffer.byteLength(text);
			this.backlog.set(seq, { text, bytes, stored: text });
			this.bytes += bytes;
		}
		Object.assign(this.durable, { stored: from.sent, committed: from.received, saved: from.conversation });
		this.grace = setTimeout(() => {
			this.grace = undefined;
			this.reset(this.graceReason);
		}, this.graceMs());
	}

	protected dirty(): void {
		this.durable?.onDirty();
	}

	protected graceMs(): number {
		return RUNNER_GRACE_MS;
	}

	/** What a durable channel's owner writes next; null when nothing changed. Synchronous: what it says is so now. */
	unsaved(): Unsaved | null {
		const d = this.durable;
		if (!d) return null;
		if (!this.conversation)
			return d.saved === null ? null : { conversation: null, fresh: true, sent: 0, acked: 0, frames: [] };
		const fresh = d.saved !== this.conversation;
		if (!fresh && d.frames.length === 0 && d.stored === this.sent)
			return { conversation: this.conversation, fresh, sent: this.sent, acked: this.acked, frames: [] };
		return { conversation: this.conversation, fresh, sent: this.sent, acked: this.acked, frames: d.frames.splice(0) };
	}

	/** The owner stored what `unsaved` said: those frames go out now. */
	saved(what: Pick<Unsaved, "conversation" | "sent">): void {
		const d = this.durable;
		if (!d || what.conversation !== this.conversation) return;
		d.saved = what.conversation;
		if (what.conversation === null || what.sent <= d.stored) return;
		const from = d.stored;
		d.stored = what.sent;
		if (!this.socket) return;
		for (const [seq, frame] of this.backlog) if (seq > from && seq <= what.sent) this.transmit(frame.text);
	}

	/** How much of what was received the owner can commit now, with everything it produced. */
	get receivedCount(): number {
		return this.received;
	}

	/** The owner committed what the first `received` messages produced: that much is acknowledged. */
	committed(conversation: string | null, received: number): void {
		const d = this.durable;
		if (!d || conversation === null || conversation !== this.conversation || received <= d.committed) return;
		d.committed = Math.min(received, this.received);
		if (this.socket) this.tick();
	}

	get conversationId(): string | null {
		return this.conversation;
	}

	/** What is acknowledged: everything received, or on a durable channel what is committed of it. */
	private get acknowledgeable(): number {
		return this.durable ? this.durable.committed : this.received;
	}
	/** Whether a frame may go out: on a durable channel only once it is stored. */
	private mayGo(seq: number): boolean {
		return !this.durable || seq <= this.durable.stored;
	}

	get connected(): boolean {
		return this.socket !== null;
	}
	get buffered(): { bytes: number; frames: number } {
		return { bytes: this.bytes, frames: this.backlog.size };
	}

	get authenticated(): boolean {
		return !!this.socket && this.codecs.has(this.socket);
	}
	protected badBody(): void {
		console.warn("frame_auth_failed schema");
		this.fail("The authenticated peer sent an invalid session message.");
	}

	protected abstract deliver(body: Body): void;
	protected abstract drop(reason: string): void;

	/** The owner lets go of the socket; the conversation waits for the next one, up to the grace. */
	detach(): void {
		const socket = this.socket;
		this.socket = null;
		clearInterval(this.clock);
		if (!this.grace && !this.closed && this.conversation)
			this.grace = setTimeout(() => {
				this.grace = undefined;
				this.reset(this.graceReason);
			}, this.graceMs());
		socket?.close();
	}

	/** A local close may have no close event. Release the current socket and tell its owner once. */
	private lost(): void {
		if (!this.socket) return;
		this.detach();
		this.base.onDisconnect?.();
	}

	// The actor is stopping. Leave pending work in the journal so another instance can resume it.
	abandon(): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.grace);
		this.grace = undefined;
		const socket = this.socket;
		this.socket = null;
		clearInterval(this.clock);
		socket?.close();
		this.dismiss();
	}

	close(reason = "The runner channel is closed."): void {
		if (this.closed) return;
		// Before the reset, so that what `onReset` asks of a closing channel is refused, not queued.
		this.closed = true;
		this.reset(reason);
		this.detach();
		this.dismiss();
	}

	/** Listens to a socket that has yet to introduce itself: its first frame goes to `introduce`, within DEAD_MS. */
	protected watch(socket: ChannelSocket, introduce: (frame: Frame) => void, protocol = 1): void {
		const [oldest] = this.strangers.keys();
		if (oldest && this.strangers.size >= MAX_STRANGERS) this.dismiss(oldest);
		this.strangers.set(
			socket,
			setTimeout(() => this.dismiss(socket), DEAD_MS),
		);
		socket.onMessage(data => {
			if (this.closed) return;
			if (this.socket === socket) {
				const auth = this.codecs.get(socket);
				try {
					const frame = parseFrame(auth ? auth.open(data, MAX_FRAME_BYTES) : data, protocol);
					if (auth && (!frame || !["msg", "part", "ack"].includes(frame.kind))) throw new FrameAuthError("schema");
					this.receive(frame);
				} catch (error) {
					console.warn(authFailure(error));
					this.lost();
				}
				return;
			}
			if (!this.strangers.has(socket)) return;
			clearTimeout(this.strangers.get(socket));
			this.strangers.delete(socket);
			const frame = parseFrame(data, protocol);
			try {
				if (frame) introduce(frame);
				else if (protocol === 2) throw new FrameAuthError("schema");
			} catch (error) {
				console.warn(authFailure(error));
			}
			// One its introduction did not make current (refused, a resume that failed, or the owner
			// closing the channel from `onReset` meanwhile) belongs to nobody.
			if (this.socket !== socket) socket.close();
		});
		socket.onClose(() => {
			if (this.socket === socket) this.lost();
			else this.dismiss(socket);
		});
	}

	protected dismiss(socket?: ChannelSocket): void {
		for (const s of socket ? [socket] : [...this.strangers.keys()]) {
			const timer = this.strangers.get(s);
			if (timer === undefined) continue;
			clearTimeout(timer);
			this.strangers.delete(s);
			s.close();
		}
	}

	protected resumable(peerReceived: number): boolean {
		return peerReceived >= this.acked && peerReceived <= this.sent;
	}
	protected get delivered(): number {
		return this.acknowledgeable;
	}

	/** Makes `socket` the current one, after the introduction, and sends what the peer has not received. */
	protected adopt(socket: ChannelSocket, introduction: Hello | Welcome | null, peerReceived: number): void {
		if (this.closed) return; // The owner closed the channel from `onReset` during the introduction.
		const old = this.socket;
		this.socket = socket;
		old?.close();
		clearTimeout(this.grace);
		this.grace = undefined;
		clearInterval(this.clock);
		this.clock = setInterval(() => this.tick(), ACK_MS);
		this.heard = Date.now();
		if (introduction) {
			try {
				socket.send(JSON.stringify(introduction));
			} catch {
				this.lost();
				return;
			}
		}
		this.told = this.acknowledgeable;
		// Resent before the release can call `onDrain`, so new output cannot overtake what the peer lacks.
		for (const [seq, frame] of this.backlog) if (seq > peerReceived && this.mayGo(seq)) this.transmit(frame.text);
		this.release(peerReceived);
		for (const body of this.unsent.splice(0)) this.send(body);
	}

	/** Queues a message, in one frame or several. Throws when it is larger than MAX_MESSAGE_BYTES. */
	protected send(body: Body): void {
		const json = measure(body);
		// Not numbered yet: what is withdrawn before a conversation starts must never reach the peer.
		if (this.conversation === null) {
			this.unsent.push(body);
			return;
		}
		if (this.bytes > HELD_BYTES) return this.fail("The other side does not acknowledge what it receives.");
		const ack = this.acknowledgeable;
		// A secret's frames are stored as a cancel of its id: a runner that never had it ignores that, and the owner asks again.
		const standIn =
			this.durable && carriesSecret(body)
				? (seq: number) => JSON.stringify({ kind: "msg", seq, ack, body: { kind: "cancel", id: body.id } })
				: null;
		const whole = JSON.stringify({ kind: "msg", seq: this.sent + 1, ack, body });
		if (Buffer.byteLength(whole) <= MAX_FRAME_BYTES) {
			this.push(whole, standIn);
			return;
		}
		for (let at = 0; at < json.length; at += PART_UNITS) {
			const data = json.slice(at, at + PART_UNITS);
			this.push(
				JSON.stringify({ kind: "part", seq: this.sent + 1, ack, data, last: at + PART_UNITS >= json.length }),
				standIn,
			);
		}
	}

	/** Takes back what was made for `id` and is still waiting for a conversation. */
	protected withdraw(id: string): void {
		this.unsent = this.unsent.filter(body => body.id !== id);
	}

	/** Whether a stream's source may go on; when not, `onDrain` says when it may again. */
	protected room(): boolean {
		if (this.bytes < WINDOW_BYTES && this.backlog.size < WINDOW_FRAMES) return true;
		this.waiting = true;
		return false;
	}

	/** Ends the conversation (a lost peer, the grace, a broken message); the socket, if any, stays. */
	protected reset(reason: string): void {
		const had = this.conversation !== null;
		this.drop(reason);
		this.conversation = null;
		this.sent = this.acked = this.received = this.told = this.bytes = this.partUnits = 0;
		if (this.durable) Object.assign(this.durable, { frames: [], stored: 0, committed: 0 });
		this.backlog.clear();
		this.unsent = [];
		this.parts = [];
		this.waiting = false;
		clearTimeout(this.grace);
		this.grace = undefined;
		this.durable?.onDirty();
		if (had) this.base.onReset?.(reason);
	}

	/** The peer broke the protocol: nothing it says can be trusted, so the conversation ends with the socket. */
	protected fail(reason: string): void {
		this.reset(reason);
		this.lost();
	}

	private push(text: string, standIn: ((seq: number) => string) | null = null): void {
		const bytes = Buffer.byteLength(text);
		const seq = ++this.sent;
		this.backlog.set(seq, { text, bytes });
		this.bytes += bytes;
		this.told = this.acknowledgeable;
		if (this.durable) {
			this.durable.frames.push([seq, standIn ? standIn(seq) : text]);
			this.durable.onDirty();
			return;
		}
		if (this.socket) this.transmit(text);
	}

	private transmit(text: string): void {
		try {
			if (this.socket) {
				const auth = this.codecs.get(this.socket);
				this.socket.send(auth ? auth.seal(JSON.parse(text)) : text);
			}
			this.spoke = Date.now();
		} catch {
			this.lost();
		}
	}

	private release(ack: number): void {
		if (ack <= this.acked) return;
		this.acked = ack;
		for (const [seq, frame] of this.backlog) {
			if (seq > ack) break;
			this.bytes -= frame.bytes;
			this.backlog.delete(seq);
		}
		if (this.waiting && this.bytes < WINDOW_BYTES && this.backlog.size < WINDOW_FRAMES) {
			this.waiting = false;
			this.base.onDrain?.();
		}
	}

	private receive(frame: Frame | null): void {
		this.heard = Date.now();
		if (!frame || (frame.kind !== "msg" && frame.kind !== "part" && frame.kind !== "ack"))
			return this.fail("The other side sent a frame this conversation does not have.");
		if (frame.ack > this.sent) return this.fail("The other side acknowledged what was never sent.");
		this.release(frame.ack);
		if (frame.kind === "ack" || frame.seq <= this.received) return;
		if (frame.seq !== this.received + 1) return this.fail("A frame is missing.");
		this.received = frame.seq;
		this.durable?.onDirty();
		if (frame.kind === "msg") {
			if (this.parts.length) return this.fail("A message ended before its last part.");
			return this.deliver(frame.body);
		}
		// Counted in UTF-16 units, never more than the sender's bytes: a part can end inside a surrogate
		// pair, whose halves Buffer.byteLength would count as three bytes each.
		this.partUnits += frame.data.length;
		if (this.partUnits > MAX_MESSAGE_BYTES) return this.fail("A message is larger than the runner channel carries.");
		this.parts.push(frame.data);
		if (!frame.last) return;
		const body = parseBody(this.parts.join(""));
		this.parts = [];
		this.partUnits = 0;
		if (!body) return this.authenticated ? this.badBody() : this.fail("A message could not be read.");
		this.deliver(body);
	}

	private tick(): void {
		const now = Date.now();
		if (now - this.heard >= DEAD_MS) {
			this.lost();
			return;
		}
		const ack = this.acknowledgeable;
		if (ack > this.told || now - this.spoke >= PING_MS) {
			this.told = ack;
			this.transmit(JSON.stringify({ kind: "ack", ack }));
		}
	}
}

type Pending = {
	name: Name;
	resolve(value: unknown): void;
	reject(error: Error): void;
	output?: Output;
	timer: ReturnType<typeof setTimeout>;
	forget(): void;
};
/** `held` is stdin written before the runner answered `start`: it has nowhere to go until then. */
type Process = { output: Output; finish(end: ProcessEnd): void; open: boolean; held: Body[] | null };

/** The session actor's end. It lives as long as the actor's instance, in `c.vars`. */
export class ServerChannel extends Channel {
	private pending = new Map<string, Pending>();
	private processes = new Map<string, Process>();

	// Verify the ticket and signature before resuming. onConnect must never re-enter the channel.
	constructor(
		private readonly options: Options & {
			platform?: { identity: PlatformIdentity; uid: string; machineId: string; sessionId: string };
			accept(hello: Hello): boolean;
			onConnect?(): void;
			onDisconnect?(): void;
		},
	) {
		super(options, "The machine did not come back within ten minutes.");
	}

	keepIn(onDirty: () => void, from: ConversationRecord | null): void {
		this.keep(onDirty, from);
	}

	// Register the restored process before asking for its socket so replayed output has a listener.
	adoptProcess(id: string, onOutput: Output): { id: string; ended: Promise<ProcessEnd> } | null {
		if (this.closed || !this.conversation || this.processes.has(id)) return null;
		const ended = new Promise<ProcessEnd>(finish =>
			this.processes.set(id, { output: onOutput, finish, open: true, held: null }),
		);
		return { id, ended };
	}

	forgetProcess(id: string): void {
		this.processes.delete(id);
	}

	/** Whether the runner answered this process's `start` and it has not ended: only then can a restarted server take it up again. */
	running(id: string): boolean {
		return this.processes.get(id)?.held === null;
	}

	/** A socket from the gateway. It counts once its hello is accepted; one that says nothing goes after DEAD_MS. */
	attach(socket: ChannelSocket): void {
		if (this.closed) {
			socket.close();
			return;
		}
		const platform = this.options.platform;
		const protocol = platform ? PROTOCOL_VERSION : 1;
		this.watch(
			socket,
			hello => {
				if (hello.kind === "foreign") {
					try {
						socket.send(
							JSON.stringify({ kind: "welcome", protocol, refused: protocolRefusal(hello.protocol, protocol) }),
						);
					} catch {}
					return;
				}
				if (hello.kind !== "hello" || !this.accepts(hello)) return;
				const resumes =
					hello.resume !== null &&
					hello.resume.conversation === this.conversation &&
					this.resumable(hello.resume.received);
				// Only the runner that holds the conversation may replace a live socket: it has given up on that one.
				if (this.socket && !resumes) return;
				const conversation = resumes ? this.conversation! : crypto.randomUUID();
				const base = {
					kind: "welcome" as const,
					conversation,
					received: resumes ? this.delivered : 0,
					resumed: resumes,
				};
				let welcome: Welcome = { ...base, protocol: 1 };
				if (platform && hello.protocol === 2) {
					const greeting = platformWelcome(
						{ ...platform, challenge: hello.ticket, ticket: hello.ticket },
						hello,
						{ ...base, protocol: 2 as const },
						platform.identity,
					);
					this.codecs.set(socket, greeting.auth);
					welcome = greeting.welcome;
				}
				// An expired certificate or invalid peer key must not reset outstanding work.
				if (!resumes) {
					if (this.conversation)
						this.reset("The machine's runner restarted, or gave up on this session's work after a long disconnection.");
					if (this.closed) return;
					this.conversation = conversation;
				}
				this.adopt(socket, welcome, resumes ? hello.resume!.received : 0);
				if (this.socket === socket) this.options.onConnect?.();
			},
			protocol,
		);
	}

	private accepts(hello: Hello): boolean {
		try {
			return this.options.accept(hello);
		} catch {
			return false;
		}
	}

	/** Rejects with ConversationLost when the conversation ends first, and with an Error for the runner's own failure. */
	request<N extends Exclude<Name, "start">>(
		name: N,
		args: Args<N>,
		options: { onOutput?: Output; signal?: AbortSignal } = {},
	): Promise<Value<N>> {
		return this.call(crypto.randomUUID(), name, args, options) as Promise<Value<N>>;
	}

	/** `ended` never rejects: a process that could not be started has ended with an error. */
	start(args: Args<"start">, onOutput: Output): { id: string; ended: Promise<ProcessEnd> } {
		const id = crypto.randomUUID();
		const ended = new Promise<ProcessEnd>(finish =>
			this.processes.set(id, { output: onOutput, finish, open: true, held: [] }),
		);
		this.call(id, "start", args, {}).catch((error: Error) => this.finish(id, { code: null, signal: null, error }));
		return { id, ended };
	}

	/** False once the process has ended or its stdin was closed, as `SandboxProcess.write`. */
	write(process: string, data: string): boolean {
		const p = this.processes.get(process);
		if (!p?.open) return false;
		this.input(p, { kind: "in", id: process, data });
		return true;
	}

	closeIn(process: string): void {
		const p = this.processes.get(process);
		if (!p?.open) return;
		p.open = false;
		this.input(p, { kind: "close-in", id: process });
	}

	private input(p: Process, body: Body): void {
		if (!p.held) return this.send(body);
		measure(body); // Too large throws now, as it would once sent.
		p.held.push(body);
	}

	/** The runner has the process: what was written meanwhile goes, in order. */
	private started(id: string): void {
		const p = this.processes.get(id);
		if (!p?.held) return;
		const held = p.held;
		p.held = null;
		// A send can end the conversation, and the process with it; the rest then has nowhere to go.
		for (const body of held) if (this.processes.has(id)) this.send(body);
	}

	private call(
		id: string,
		name: Name,
		args: unknown,
		{ onOutput, signal }: { onOutput?: Output; signal?: AbortSignal },
	): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (this.closed) return reject(new ConversationLost("The runner channel is closed."));
			if (!validArgs(name, args)) return reject(new Error(`Invalid arguments for the runner's ${name}.`));
			if (this.pending.size >= MAX_OPS_IN_FLIGHT)
				return reject(new Error("Too many operations are waiting on the machine."));
			const own = (args as { options?: { timeoutMs?: number } }).options?.timeoutMs;
			const timer = setTimeout(
				() => this.settle(id, new ConversationLost("The machine did not answer in time.")),
				name === "blockedNetwork" || name === "memoryEvents" ? 5_000 : (own ?? OP_MS) + RUNNER_GRACE_MS,
			);
			const cancel = () => {
				if (!this.pending.has(id)) return;
				if (name === "modelRelay" || name === "openCodeDefault") this.settle(id, new Error("The turn was stopped."));
				this.send({ kind: "cancel", id });
			};
			signal?.addEventListener("abort", cancel, { once: true });
			this.pending.set(id, {
				name,
				resolve,
				reject,
				output: onOutput,
				timer,
				forget: () => signal?.removeEventListener("abort", cancel),
			});
			try {
				this.send({ kind: "op", id, name, args: args as Record<string, unknown> });
			} catch (error) {
				this.settle(id, error as Error);
				return;
			}
			if (signal?.aborted) cancel();
		});
	}

	private settle(id: string, outcome: { value: unknown } | Error): void {
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		this.withdraw(id);
		clearTimeout(p.timer);
		p.forget();
		if (outcome instanceof Error) p.reject(outcome);
		else p.resolve(outcome.value);
	}

	private finish(id: string, end: ProcessEnd): void {
		const p = this.processes.get(id);
		if (!p) return;
		this.processes.delete(id);
		p.finish(end);
	}

	protected deliver(body: Body): void {
		switch (body.kind) {
			case "res": {
				const p = this.pending.get(body.id);
				if (!p) return; // It stopped waiting.
				if (!body.ok)
					return this.settle(
						body.id,
						body.error.kind === "user" ? new SandboxUserError(body.error.message) : new Error(body.error.message),
					);
				if (!validValue(p.name, body.value)) {
					if (this.authenticated) return this.badBody();
					return this.settle(body.id, new Error(`The machine's answer to ${p.name} could not be read.`));
				}
				// Here, not when the promise settles: the process's own messages may follow in this same task.
				if (p.name === "start") this.started(body.id);
				return this.settle(body.id, { value: body.value });
			}
			case "out":
				(this.processes.get(body.id)?.output ?? this.pending.get(body.id)?.output)?.(body.fd, body.data);
				return;
			case "end":
				return this.finish(body.id, {
					code: body.code,
					signal: body.signal,
					error: body.error === null ? null : new Error(body.error),
				});
			default:
				return this.fail("The machine's runner sent a message that only the platform sends.");
		}
	}

	protected drop(reason: string): void {
		if (this.processes.size > 0) this.lostProcesses += 1;
		for (const id of [...this.pending.keys()]) this.settle(id, new ConversationLost(reason));
		for (const id of [...this.processes.keys()])
			this.finish(id, { code: null, signal: null, error: new ConversationLost(reason) });
	}

	/** How many times a conversation ended with a process still running in it: a turn that sees this grow lost its machine mid-turn. */
	get losses(): number {
		return this.lostProcesses;
	}
	private lostProcesses = 0;

	/** WLP_TEST_RUNNER_GRACE_MS, for checks only: how long the platform waits for a runner that went away before it lets the conversation go. */
	protected override graceMs(): number {
		const test = Number(process.env.WLP_TEST_RUNNER_GRACE_MS);
		return Number.isSafeInteger(test) && test >= 1_000 ? test : RUNNER_GRACE_MS;
	}
}

export interface SessionTrust {
	uid: string;
	sessionId: string;
	machine: KeyObject;
	trust: Trust;
	endpoint: string;
}

/** The runner's end, one per session it serves. */
export class RunnerChannel extends Channel {
	private serving = new Map<string, Name>();
	private processes = new Set<string>();

	// Answer each operation once, and accept a start before sending its output. A reset must stop orphan work.
	constructor(
		private readonly options: Options & {
			onOperation(op: Operation): void;
			onInput(process: string, data: string): void;
			onCloseIn(process: string): void;
			/** The abort signal of a `run` in progress. */
			onCancel(id: string): void;
			/** A stream's source may go on after `output` said to wait. */
			onDrain(): void;
			/** The platform will not talk to this runner: the sentence says why. Reconnecting will not help. */
			onRefused(reason: string): void;
		},
	) {
		super(options, "The platform did not come back within ten minutes.");
	}

	/** A new socket, opened because the last one was given up on. Its ticket and signature are new. */
	attach(
		socket: ChannelSocket,
		identity: Pick<Hello, "runnerVersion" | "machineId" | "ticket" | "signature">,
		secure?: SessionTrust,
	): void {
		if (this.closed) {
			socket.close();
			return;
		}
		this.detach();
		this.dismiss();
		const asked = this.conversation;
		const base = {
			kind: "hello" as const,
			runnerVersion: identity.runnerVersion,
			machineId: identity.machineId,
			ticket: identity.ticket,
			resume: asked ? { conversation: asked, received: this.delivered } : null,
		};
		const exchange =
			secure &&
			runnerHandshake(
				{
					uid: secure.uid,
					sessionId: secure.sessionId,
					machineId: identity.machineId,
					challenge: identity.ticket,
					ticket: identity.ticket,
				},
				base,
				secure.machine,
			);
		const hello: Hello = exchange?.hello ?? { ...base, protocol: 1, signature: identity.signature };
		const text = JSON.stringify(hello);
		if (parseFrame(text, hello.protocol)?.kind !== "hello") throw new Error("Invalid runner identity.");
		this.watch(
			socket,
			welcome => {
				if (welcome.kind !== "welcome") return;
				if (secure && exchange) {
					if (!("platformEph" in welcome)) throw new FrameAuthError("handshake");
					this.codecs.set(socket, exchange.finish(welcome, secure.trust, secure.endpoint));
				} else if ("platformEph" in welcome) return;
				if ("refused" in welcome) return this.options.onRefused(welcome.refused);
				if (welcome.resumed) {
					if (welcome.conversation !== asked || asked !== this.conversation || !this.resumable(welcome.received)) {
						return this.fail("The platform resumed a conversation this runner does not have.");
					}
					return this.adopt(socket, null, welcome.received);
				}
				if (this.conversation)
					this.reset(
						"The platform no longer has this session's work: its server restarted, or gave up after a long disconnection.",
					);
				this.conversation = welcome.conversation;
				this.adopt(socket, null, 0);
			},
			hello.protocol,
		);
		try {
			socket.send(text);
		} catch {
			this.dismiss(socket);
		}
	}

	/** Throws for a value that is not the operation's result: that is the runner's own mistake. */
	respond<O extends Operation>(op: O, value: Value<O["name"]>): void {
		const name = this.serving.get(op.id);
		if (!name) return; // Its conversation has ended.
		if (!validValue(name, value)) throw new Error(`Invalid result for ${name}.`);
		this.serving.delete(op.id);
		if (name === "start") this.processes.add(op.id);
		this.last(
			{ kind: "res", id: op.id, ok: true, value },
			{
				kind: "res",
				id: op.id,
				ok: false,
				error: { kind: "sandbox", message: `The answer to ${name} is larger than a runner can send.` },
			},
		);
	}

	refuse(op: Operation, error: Failure): void {
		if (this.serving.delete(op.id))
			this.last(
				{ kind: "res", id: op.id, ok: false, error },
				{
					kind: "res",
					id: op.id,
					ok: false,
					error: { kind: error.kind, message: "The machine's error is larger than a runner can send." },
				},
			);
	}

	/** Output of a `run` in progress or of a started process. False: stop reading until `onDrain`. */
	output(id: string, fd: 1 | 2, data: string): boolean {
		if (!this.serving.has(id) && !this.processes.has(id)) return true;
		this.send({ kind: "out", id, fd, data });
		return this.room();
	}

	end(process: string, end: ProcessEnd): void {
		const body = { kind: "end", id: process, code: end.code, signal: end.signal } as const;
		if (this.processes.delete(process))
			this.last(
				{ ...body, error: end.error?.message ?? null },
				{ ...body, error: "The process ended with an error larger than a runner can send." },
			);
	}

	/** The message that settles something: its tracking is already gone, so one too large to send is replaced, never lost. */
	private last(body: Body, instead: Body): void {
		try {
			this.send(body);
		} catch {
			this.send(instead);
		}
	}

	protected deliver(body: Body): void {
		switch (body.kind) {
			case "op": {
				if (this.serving.has(body.id) || this.processes.has(body.id))
					return this.fail("The platform used an operation id twice.");
				const name = body.name;
				const known = isName(name);
				const valid = known && validArgs(name, body.args);
				if (this.authenticated && known && !valid) return this.badBody();
				const snapshot =
					name === "saveSnapshot" ||
					name === "hasSnapshot" ||
					(name === "create" && plain(body.args) && body.args.prepared !== undefined);
				const refusal =
					snapshot && !this.authenticated
						? "Machine snapshots require an authenticated session."
						: !valid
							? "This runner does not serve that operation."
							: this.serving.size >= MAX_OPS_IN_FLIGHT
								? "Too many operations are waiting on this machine."
								: null;
				if (refusal)
					return this.send({ kind: "res", id: body.id, ok: false, error: { kind: "refused", message: refusal } });
				this.serving.set(body.id, name as Name);
				return this.options.onOperation(body as Operation);
			}
			case "in":
				if (this.processes.has(body.id)) this.options.onInput(body.id, body.data);
				return;
			case "close-in":
				if (this.processes.has(body.id)) this.options.onCloseIn(body.id);
				return;
			case "cancel":
				this.options.onCancel(body.id);
				return;
			default:
				return this.fail("The platform sent a message that only a runner sends.");
		}
	}

	protected drop(): void {
		this.serving.clear();
		this.processes.clear();
	}
}
