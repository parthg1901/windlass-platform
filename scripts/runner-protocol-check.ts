/**
 * The runner channel under the failures it will meet, on loopback sockets the check delivers by hand
 * and a clock it moves by hand: a link cut in the middle of an operation with the server's end left
 * half-open, a reconnect over it, late frames from the dead socket, frames delivered twice, the session
 * actor waking with nothing, the runner restarting, the grace running out, a 20 MiB stream through a
 * full window, messages larger than a frame, and input that is not the protocol.
 *
 *   cd server && npx tsx ../scripts/runner-protocol-check.ts
 */
import { createHash } from "node:crypto";
import { parseRunnerFrame } from "../server/src/runner/control.js";
import { mock } from "node:test";
import {
	ConversationLost,
	RunnerChannel,
	ServerChannel,
	type ChannelSocket,
	type ConversationRecord,
} from "../server/src/runner/channel.js";
import {
	ACK_MS,
	DEAD_MS,
	MAX_FRAME_BYTES,
	MAX_MESSAGE_BYTES,
	MAX_OPS_IN_FLIGHT,
	OP_MS,
	PING_MS,
	RUNNER_GRACE_MS,
	WINDOW_BYTES,
	parseFrame,
	validArgs,
	type Operation,
} from "../server/src/runner/protocol.js";

let failures = 0;
function expect(name: string, ok: boolean, detail = ""): void {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const outcome = (p: Promise<unknown>) =>
	p.then(
		v => v,
		(e: Error) => e,
	);
/** What `p` has come to once everything already due has run: its value, its error, or "pending". */
async function now(p: Promise<unknown>): Promise<unknown> {
	let value: unknown = "pending";
	void p.then(
		v => {
			value = v;
		},
		(e: unknown) => {
			value = e;
		},
	);
	await new Promise(resolve => setImmediate(resolve));
	return value;
}
const identity = { runnerVersion: "0.1.0", machineId: "m_check", ticket: "ticket", signature: "signature" };
const box = { id: "box" };

/** One end of a socket. Sent text waits in the peer's inbox until `flush`. */
class End implements ChannelSocket {
	peer!: End;
	inbox: string[] = [];
	open = true;
	cut = false;
	twice = false;
	notifyClose = true;
	largest = 0;
	private listener: (data: unknown) => void = () => {};
	private closed = () => {};
	send(text: string): void {
		if (!this.open) throw new Error("closed");
		this.largest = Math.max(this.largest, Buffer.byteLength(text));
		if (!this.cut) this.peer.inbox.push(text);
	}
	onMessage(listener: (data: unknown) => void): void {
		this.listener = listener;
	}
	onClose(listener: () => void): void {
		this.closed = listener;
	}
	close(): void {
		if (!this.open) return;
		this.open = false;
		if (this.notifyClose) this.closed();
		// What was sent before a close still arrives before it.
		if (this.peer && !this.cut) {
			this.peer.take();
			this.peer.close();
		}
	}
	/** Hands the inbox to the channel; numbered frames twice when `twice` is set. */
	take(): boolean {
		const texts = this.inbox.splice(0);
		for (const text of texts) {
			if (!this.open) break;
			this.listener(text);
			if (this.twice && text.includes('"seq"')) this.listener(text);
		}
		return texts.length > 0;
	}
	lateClose(): void {
		this.closed();
	}
	/** Late delivery: what a dead socket still had in flight. */
	late(texts: string[]): void {
		for (const text of texts) this.listener(text);
	}
}
function join(server: ServerChannel, runner: RunnerChannel) {
	const s = new End(),
		r = new End();
	s.peer = r;
	r.peer = s;
	server.attach(s);
	runner.attach(r, identity);
	const link = {
		s,
		r,
		flush() {
			while (s.take() || r.take());
		},
		/** The link breaks: what is in flight is lost, the runner notices, the server's end stays half-open. */
		cut() {
			s.cut = r.cut = true;
			const lost = { toServer: s.inbox.splice(0), toRunner: r.inbox.splice(0) };
			r.close();
			return lost;
		},
	};
	link.flush();
	return link;
}

function server(accept = true, onReset?: () => void) {
	const resets: string[] = [];
	return {
		ch: new ServerChannel({
			accept: () => accept,
			onReset: why => {
				resets.push(why);
				onReset?.();
			},
		}),
		resets,
	};
}
/** A runner whose operations wait in `held` unless `serve` answers them. */
function runner(
	serve?: (ch: RunnerChannel, op: Operation) => void,
	hooks: { onDrain?(): void; onReset?(): void } = {},
) {
	const log = {
		ops: [] as string[],
		held: [] as Operation[],
		input: [] as string[],
		resets: [] as string[],
		refused: [] as string[],
		cancels: [] as string[],
		drains: 0,
	};
	const ch: RunnerChannel = new RunnerChannel({
		onOperation: op => {
			log.ops.push(op.name);
			if (serve) serve(ch, op);
			else log.held.push(op);
		},
		onInput: (_, data) => log.input.push(data),
		onCloseIn: () => log.input.push("EOF"),
		onCancel: id => log.cancels.push(id),
		onDrain: () => {
			log.drains++;
			hooks.onDrain?.();
		},
		onRefused: why => log.refused.push(why),
		onReset: why => {
			log.resets.push(why);
			hooks.onReset?.();
		},
	});
	return { ch, log };
}
{
	const s = server(),
		r = runner(),
		link = join(s.ch, r.ch);
	const abort = new AbortController();
	const forward = {
		provider: "openai" as const,
		placeholder: "wlpm1.fixture",
		host: "relay.fixture.test",
		expiresAt: Date.now() + 60_000,
		proofKey: "a".repeat(43),
	};
	const waiting = outcome(s.ch.request("modelRelay", { id: "box", forward }, { signal: abort.signal }));
	link.flush();
	abort.abort();
	link.flush();
	const result = await now(waiting);
	expect(
		"abort settles a pending key relay setup and cancels it on the runner",
		result instanceof Error && r.log.cancels.length === 1,
	);
	s.ch.close();
	r.ch.close();
}
if (process.argv.includes("--key-abort")) process.exit(failures ? 1 : 0);
const answer = (ch: RunnerChannel, op: Operation) => {
	if (op.name === "state") ch.respond(op, "running");
	else if (op.name === "readTextFile") ch.respond(op, "x".repeat(9 * 1024 * 1024));
	else if (op.name === "start" || op.name === "writeTextFile") ch.respond(op, null);
};
const done = { code: 0, signal: null, error: null };

async function dropAndResume(): Promise<void> {
	const { ch: s } = server();
	const { ch: r, log } = runner();
	const a = join(s, r);
	const out: string[] = [];
	const proc = s.start({ ...box, tag: "t1", argv: ["windlass", "acp"] }, (_, data) => out.push(data));
	const state = s.request("state", box);
	a.flush();
	const [start, ask] = log.held;
	r.respond(start, null);
	r.output(start.id, 1, "one");
	r.respond(ask, "running");
	const lost = a.cut();
	s.write(proc.id, "answer");
	s.closeIn(proc.id);
	r.output(start.id, 1, "two");
	const b = join(s, r);
	b.s.twice = b.r.twice = true;
	b.flush();
	a.s.late(lost.toServer);
	r.end(start.id, done);
	b.flush();
	mock.timers.tick(ACK_MS);
	b.flush();
	expect(
		"a reconnect over a half-open socket takes over the conversation",
		!a.s.open && s.connected && log.resets.length === 0,
	);
	expect(
		"an answer lost with the link arrives once; the operation ran once",
		(await state) === "running" && log.ops.join() === "start,state",
	);
	expect(
		"output across the break arrives once, in order, then the end",
		(await proc.ended).code === 0 && out.join() === "one,two",
	);
	expect("stdin written during the break arrives once, before its close", log.input.join() === "answer,EOF");
	expect("lost receipts are made good: nothing is left buffered", s.buffered.frames === 0 && r.buffered.frames === 0);
}

async function actorWakes(): Promise<void> {
	const { ch: s1 } = server();
	const { ch: r, log } = runner();
	const a = join(s1, r);
	const running = outcome(s1.request("run", { ...box, command: "sleep 60" }));
	const proc = s1.start({ ...box, tag: "t2", argv: ["windlass", "acp"] }, () => {});
	a.flush();
	s1.close("The session's actor went to sleep.");
	expect(
		"an actor that sleeps fails what it waited for as lost",
		(await running) instanceof ConversationLost && (await proc.ended).error instanceof ConversationLost,
	);
	const { ch: s2 } = server();
	const early = s2.request("state", box);
	const b = join(s2, r);
	expect(
		"the woken actor starts a new conversation; the runner lets the old one go",
		log.resets.length === 1 && log.ops.length === 3,
	);
	r.respond(log.held[0], { exitCode: 0, timedOut: false, aborted: false, stdout: "", stderr: "" });
	const quiet = b.s.inbox.length === 0 && r.buffered.frames === 0;
	r.respond(log.held[2], "paused");
	b.flush();
	expect(
		"an answer from the old conversation goes nowhere; work queued before the socket runs",
		quiet && (await early) === "paused",
	);
}

async function runnerRestarts(): Promise<void> {
	const { ch: s } = server();
	const old = runner();
	const a = join(s, old.ch);
	const waiting = outcome(s.request("state", box));
	a.flush();
	a.cut();
	old.ch.close();
	const fresh = runner(answer);
	const b = join(s, fresh.ch);
	expect("a second runner cannot displace a socket that still looks alive", !b.r.open && s.connected);
	mock.timers.tick(DEAD_MS);
	expect("45 s of silence drops the half-open socket", !a.s.open && !s.connected);
	const c = join(s, fresh.ch);
	const error = await waiting;
	expect(
		"the restarted runner's hello fails the old work as lost",
		error instanceof ConversationLost && error.message.includes("restarted"),
	);
	const next = s.request("state", box);
	c.flush();
	expect("and the new conversation serves", (await next) === "running");
}

async function grace(): Promise<void> {
	const { ch: s, resets } = server();
	const { ch: r, log } = runner();
	const a = join(s, r);
	const waiting = outcome(s.request("state", box));
	a.flush();
	a.s.close();
	mock.timers.tick(RUNNER_GRACE_MS - 1);
	s.attach(new End()); // A socket that never says hello earns no time.
	const before = resets.length;
	mock.timers.tick(1);
	const error = await waiting;
	expect(
		"the grace is ten minutes, then the work fails on both sides",
		before === 0 && error instanceof ConversationLost && resets.length === 1 && log.resets.length === 1,
	);
	const b = join(s, r);
	const next = s.request("state", box);
	b.flush();
	r.respond(log.held[1], "running");
	b.flush();
	expect("after the grace a new conversation starts on the next socket", (await next) === "running");
}

async function stream(): Promise<void> {
	const { ch: s } = server();
	const { ch: r, log } = runner(answer);
	let link = join(s, r);
	const received = createHash("sha256"),
		sent = createHash("sha256");
	let bytes = 0,
		peak = 0,
		waits = 0;
	const proc = s.start({ ...box, tag: "t3", argv: ["windlass", "acp"] }, (_, data) => {
		received.update(data);
		bytes += data.length;
	});
	link.flush();
	const id = proc.id;
	const size = 20 * 1024 * 1024,
		chunk = 64 * 1024;
	for (let at = 0; at < size; at += chunk) {
		const data = String(at).padEnd(chunk, "é");
		sent.update(data);
		const more = r.output(id, 1, data);
		peak = Math.max(peak, r.buffered.bytes);
		if (at % (5 * 1024 * 1024) === 0 && at) {
			link.cut();
			link = join(s, r);
		}
		if (!more) {
			waits++;
			link.flush();
			mock.timers.tick(ACK_MS);
			link.flush();
		}
	}
	r.end(id, done);
	link.flush();
	expect(
		"20 MiB arrives whole and in order across four broken links",
		(await proc.ended).code === 0 && bytes === size && received.digest("hex") === sent.digest("hex"),
	);
	expect(
		"a full window stops the source and lets it go on",
		waits > 0 && log.drains === waits && peak < WINDOW_BYTES + 2 * MAX_FRAME_BYTES,
		`${waits} waits, peak ${peak} bytes`,
	);
}

async function large(): Promise<void> {
	const { ch: s } = server();
	let saved = "";
	const { ch: r } = runner((ch, op) => {
		if (op.name === "writeTextFile") saved = op.args.content;
		answer(ch, op);
	});
	const link = join(s, r);
	const content = '雪\u0000"\\😀\ud800'.repeat(200_000);
	const put = s.request("writeTextFile", { ...box, path: "/workspace/a", content });
	const big = outcome(s.request("readTextFile", { ...box, path: "/workspace/a" }));
	link.flush();
	expect(
		"a 4.6 MB file crosses in frames under the limit, text intact",
		(await put) === null && saved === content && Math.max(link.s.largest, link.r.largest) <= MAX_FRAME_BYTES,
	);
	const error = await big;
	expect(
		"an answer over 8 MiB comes back as the runner's refusal",
		error instanceof Error && !(error instanceof ConversationLost) && error.message.includes("larger"),
	);

	const { ch: s2 } = server();
	const { ch: r2, log } = runner();
	const b = join(s2, r2);
	const proc = s2.start({ ...box, tag: "t7", argv: ["windlass", "acp"] }, () => {});
	const refused = outcome(s2.request("state", box));
	const read = outcome(s2.request("readTextFile", { ...box, path: "/workspace/b" }));
	b.flush();
	const [start, state, file] = log.held;
	r2.respond(start, null);
	const huge = "e".repeat(MAX_MESSAGE_BYTES);
	try {
		r2.end(start.id, { code: null, signal: null, error: new Error(huge) });
	} catch {}
	try {
		r2.refuse(state, { kind: "sandbox", message: huge });
	} catch {}
	b.flush();
	const ended = (await now(proc.ended)) as { error?: Error },
		no = await now(refused);
	expect(
		"an end or a refusal too large to send still arrives, with a short error",
		!!ended.error?.message.includes("larger") && no instanceof Error && no.message.includes("larger"),
	);
	// Exactly MAX_MESSAGE_BYTES, with the halves of one emoji in different parts.
	const empty = JSON.stringify({ kind: "res", id: file.id, ok: true, value: "" });
	const left = "a".repeat(MAX_FRAME_BYTES / 8 - 1 - (empty.indexOf('""') + 1));
	const value = left + "😀" + "b".repeat(MAX_MESSAGE_BYTES - empty.length - left.length - 4);
	r2.respond(file, value);
	b.flush();
	expect("an 8 MiB answer split inside a surrogate pair arrives", (await now(read)) === value);
}

async function untrusted(): Promise<void> {
	const { ch: s } = server();
	const { ch: r, log } = runner();
	const link = join(s, r);
	const bad = outcome(s.request("state", box));
	const other = outcome(s.request("state", box));
	link.flush();
	const forge = (seq: number, body: unknown) => link.r.send(JSON.stringify({ kind: "msg", seq, ack: 2, body }));
	forge(1, { kind: "res", id: log.held[0].id, ok: true, value: 42 });
	link.flush();
	const error = await bad;
	expect(
		"an answer of the wrong shape fails that operation only",
		error instanceof Error && !(error instanceof ConversationLost) && s.connected,
	);
	forge(2, { kind: "op", id: "x", name: "state", args: box });
	link.flush();
	expect(
		"a message only the platform sends ends the conversation",
		(await other) instanceof ConversationLost && !s.connected,
	);

	const plain = runner();
	const se = new End(),
		re = new End();
	se.peer = re;
	re.peer = se;
	plain.ch.attach(re, identity);
	se.inbox = [];
	se.send(JSON.stringify({ kind: "welcome", protocol: 1, conversation: "c", received: 0, resumed: false }));
	se.send(
		JSON.stringify({
			kind: "msg",
			seq: 1,
			ack: 0,
			body: { kind: "op", id: "y", name: "dockerRun", args: { image: "anything" } },
		}),
	);
	re.take();
	const reply = parseFrame(se.inbox[0]);
	expect(
		"an operation the runner does not serve is refused, not run",
		!plain.log.ops.length &&
			reply?.kind === "msg" &&
			reply.body.kind === "res" &&
			!reply.body.ok &&
			reply.body.error.kind === "refused",
	);
	plain.ch.close();
	const many = Array.from({ length: MAX_OPS_IN_FLIGHT + 1 }, () => outcome(s.request("state", box)));
	expect("no more than 16 operations wait at once", (await many[MAX_OPS_IN_FLIGHT]) instanceof Error);
	const hostile = [
		null,
		7,
		"{",
		"[]",
		`{"kind":"__proto__"}`,
		`{"kind":"ack","ack":-1}`,
		`{"kind":"ack","ack":1,"extra":1}`,
		`{"kind":"msg","seq":0,"ack":0,"body":{"kind":"in","id":"p","data":""}}`,
		`{"kind":"msg","seq":1,"ack":0,"body":{"kind":"out","id":"p","fd":3,"data":""}}`,
		`{"kind":"msg","seq":1,"ack":0,"body":{"kind":"end","id":"p","code":"0","signal":null,"error":null}}`,
		" ".repeat(MAX_FRAME_BYTES + 1),
	];
	expect(
		"frames that are not the protocol are refused without throwing",
		hostile.every(v => parseFrame(v) === null),
		`${hostile.length} cases`,
	);

	const { ch: s3 } = server();
	const c = join(s3, runner(answer).ch);
	const proc = s3.start({ ...box, tag: "t8", argv: ["windlass", "acp"] }, () => {});
	c.flush();
	c.cut(); // From here nothing the server sends is acknowledged.
	let writes = 0;
	while (writes < 100 && s3.write(proc.id, "x".repeat(4 * 1024 * 1024))) writes++;
	expect(
		"what is never acknowledged is bounded: the conversation ends",
		writes < 100 && !!(await proc.ended).error?.message.includes("acknowledge"),
		`${writes} writes of 4 MiB`,
	);
}

const profileReport = (allowedProfiles?: unknown) =>
	parseRunnerFrame(
		JSON.stringify({
			kind: "report",
			docker: { ok: true },
			commandSandbox: { ok: true },
			freeDiskBytes: null,
			sandboxes: [],
			allowedProfiles,
		}),
	);
const hardened = "docker-hardened",
	windlass = "docker-windlass-sandbox";
expect(
	"the control report accepts both owner policies and legacy reports",
	[undefined, [hardened], [hardened, windlass], [windlass, hardened]].every(
		ids => profileReport(ids)?.kind === "report",
	),
);
expect(
	"malformed owner policies are refused",
	[
		null,
		hardened,
		[],
		[windlass],
		[hardened, hardened],
		[hardened, "e2b"],
		[hardened, windlass, hardened],
		[hardened, {}],
	].every(ids => profileReport(ids) === null),
);

const generationReport = (loginGeneration: unknown) =>
	parseRunnerFrame(
		JSON.stringify({
			kind: "report",
			docker: { ok: true },
			commandSandbox: { ok: true },
			freeDiskBytes: null,
			sandboxes: [],
			harnesses: [{ id: "claude", adapter: "fixture", image: "fixture", signIn: "token", loginGeneration }],
		}),
	);
expect(
	"a legacy control report carries the login generation and rejects arbitrary identity text",
	generationReport("a".repeat(32))?.kind === "report" && generationReport("canary@example.invalid") === null,
);

async function harnessCreate() {
	const model = { id: "opus", name: "Opus", efforts: ["low", "high"] };
	const options = { models: [model], defaultModel: "opus", modes: [], checkedAt: 1000 };
	const accepted = (options: unknown) =>
		parseRunnerFrame(
			JSON.stringify({
				kind: "report",
				docker: { ok: true },
				commandSandbox: { ok: true },
				freeDiskBytes: null,
				sandboxes: [],
				harnesses: [{ id: "claude", adapter: "fixture", image: "fixture", signIn: "token", options }],
			}),
		) !== null;
	expect(
		"a bounded model report passes, oversized or inconsistent options are refused",
		accepted(options) &&
			[
				{ models: Array(33).fill(model) },
				{ models: [{ ...model, efforts: Array(17).fill("x") }] },
				{ defaultModel: "absent" },
				{ checkedAt: -1 },
				{ modes: [null] },
				{ models: [model, model] },
				{
					models: Array.from({ length: 1800 }, (_, i) => ({
						...model,
						id: i ? String(i) : model.id,
						name: "界".repeat(210),
					})),
				},
				{ models: [{ ...model, name: "x".repeat(513) }] },
			].every(change => !accepted({ ...options, ...change })),
	);
	const args = { profile: "docker-hardened", harness: "claude" } as const;
	const { ch: s } = server();
	const { ch: r } = runner((ch, op) => {
		if (op.name !== "create") return answer(ch, op);
		if ("harness" in op.args) ch.refuse(op, { kind: "refused", message: "This runner does not serve that operation." });
		else ch.respond(op, "windlass-box");
	});
	const link = join(s, r);
	const refused = outcome(s.request("create", args));
	link.flush();
	const error = await refused;
	const next = s.request("create", { profile: args.profile });
	link.flush();
	expect(
		"a Windlass-only runner refuses a Claude create with its sentence and accepts a Windlass create on the same socket",
		error instanceof Error && error.message.includes("does not serve") && (await next) === "windlass-box",
	);
	expect(
		"create admits the Claude id and refuses caller-supplied images, mounts and other harness ids",
		validArgs("create", args) &&
			!validArgs("create", { ...args, image: "anything" }) &&
			!validArgs("create", { ...args, mount: "/tmp" }) &&
			!validArgs("create", { ...args, harness: "other" }),
	);
}

async function mismatch(): Promise<void> {
	const { ch: s } = server();
	const pending = outcome(s.request("state", box));
	const { ch: r, log } = runner();
	const se = new End(),
		re = new End();
	se.peer = re;
	re.peer = se;
	s.attach(se);
	r.attach(re, identity);
	se.inbox[0] = se.inbox[0].replace('"protocol":1', '"protocol":2');
	se.take();
	re.take();
	let settled = false;
	void pending.then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(
		"a runner on another protocol is told why, apart from a broken link",
		log.refused.length === 1 && log.refused[0].includes("protocol 2") && !settled,
	);
	s.close();
}

async function liveness(): Promise<void> {
	let lost = 0;
	const s = new ServerChannel({
		accept: () => true,
		onDisconnect: () => {
			lost++;
		},
	});
	const { ch: r, log } = runner();
	const link = join(s, r);
	for (let i = 0; i < 4; i++) {
		mock.timers.tick(PING_MS);
		link.flush();
	}
	expect("heartbeats keep an idle link open", s.connected && r.connected);
	const stop = new AbortController();
	void outcome(s.request("run", { ...box, command: "sleep 60" }, { signal: stop.signal }));
	link.flush();
	stop.abort();
	link.flush();
	expect("aborting a run reaches the runner", log.cancels.length === 1 && log.cancels[0] === log.held[0].id);
	// A silent network passes neither frames nor a close event back to the actor.
	link.s.cut = link.r.cut = true;
	link.s.notifyClose = false;
	mock.timers.tick(DEAD_MS);
	expect("a peer that goes quiet is dropped after 45 s", !s.connected && !r.connected);
	expect("the owner learns of a dead socket without a local close event", lost === 1);
	link.s.lateClose();
	expect("a late close of the dead socket does not notify the owner again", lost === 1);
	s.close();
	r.close();
}

function timers(): void {
	const count = () => process.getActiveResourcesInfo().filter(name => name === "Timeout").length;
	const before = count();
	const { ch: s } = server();
	const { ch: r } = runner();
	const link = join(s, r);
	void outcome(s.request("run", { ...box, command: "true", options: { timeoutMs: 100_000 } }));
	s.attach(new End());
	link.cut();
	s.close();
	r.close();
	expect("closing clears every heartbeat, grace, hello and request timer", count() === before);
}

async function order(): Promise<void> {
	const { ch: s } = server();
	const { ch: r, log } = runner();
	const a = join(s, r);
	const early = s.start({ ...box, tag: "t5", argv: ["windlass", "acp"] }, () => {});
	s.write(early.id, "first");
	s.closeIn(early.id);
	a.flush(); // The runner's startup is still under way.
	const before = log.input.length;
	r.respond(log.held[0], null);
	a.flush();
	expect(
		"stdin written before the runner answers start reaches the process, in order",
		before === 0 && log.input.join() === "first,EOF",
	);
	r.end(log.held[0].id, done);
	s.close();
	r.close();

	let tail = () => {};
	const { ch: s2 } = server();
	const { ch: r2, log: log2 } = runner(undefined, { onDrain: () => tail() });
	const b = join(s2, r2);
	let sent = 0,
		got = 0;
	const proc = s2.start({ ...box, tag: "t6", argv: ["windlass", "acp"] }, () => got++);
	b.flush();
	r2.respond(log2.held[0], null);
	b.flush();
	const id = log2.held[0].id;
	do sent++;
	while (r2.output(id, 1, "a".repeat(100 * 1024)));
	b.s.inbox.splice(1);
	b.s.take(); // One chunk arrives before the link breaks, unacknowledged.
	b.cut();
	tail = () => {
		tail = () => {};
		sent++;
		r2.output(id, 1, "tail");
	};
	const c = join(s2, r2);
	r2.end(id, done);
	c.flush();
	expect(
		"output written from onDrain on a resume goes after what is resent",
		(await proc.ended).code === 0 && got === sent,
	);
	s2.close();
	r2.close();
}

async function expiry(): Promise<void> {
	const { ch: s } = server();
	const { ch: r, log } = runner();
	const expired = outcome(s.request("state", box));
	mock.timers.tick(OP_MS + RUNNER_GRACE_MS);
	const error = await expired;
	join(s, r);
	expect(
		"an operation that expired before the first socket never runs",
		error instanceof ConversationLost && log.ops.length === 0,
	);
	const long = await now(
		s.request("run", { ...box, command: "true", options: { timeoutMs: 25 * 24 * 60 * 60 * 1000 } }),
	);
	expect(
		"a timeout past what a timer can hold is refused at once",
		long instanceof Error && long.message.includes("Invalid"),
	);
	s.close();
	r.close();

	const { ch: s2 } = server();
	const { ch: r2 } = runner();
	join(s2, r2).cut();
	mock.timers.tick(RUNNER_GRACE_MS - 1);
	const se = new End(),
		re = new End();
	se.peer = re;
	re.peer = se;
	s2.attach(se);
	r2.attach(re, identity);
	se.take(); // The server resumes; its welcome is on the way.
	mock.timers.tick(1); // The runner's grace runs out first.
	re.take();
	expect(
		"a welcome that comes after the runner gave up closes that socket on both ends",
		!re.open && !se.open && !s2.connected,
	);
	s2.close();
	r2.close();
}

async function closing(): Promise<void> {
	const { ch: s } = server(true, () => s.close());
	join(s, runner().ch).s.close();
	const c = join(s, runner().ch); // A new runner: the server's conversation ends, and its owner closes it.
	const { ch: r } = runner(undefined, { onReset: () => r.close() });
	join(server().ch, r).cut();
	const d = join(server().ch, r); // A new server: the runner's conversation ends, and its owner closes it.
	expect(
		"closing from onReset during a handshake leaves both ends closed",
		!s.connected && !c.s.open && !r.connected && !d.r.open,
	);

	let late: Promise<unknown> = Promise.resolve();
	const { ch: s2 } = server(true, () => {
		late = s2.request("state", box);
	});
	join(s2, runner().ch);
	s2.close();
	expect("work asked for from onReset during close fails at once", (await now(late)) instanceof ConversationLost);
}

async function strangers(): Promise<void> {
	const { ch: s } = server();
	const { ch: r } = runner();
	const link = join(s, r);
	const silent = Array.from({ length: 5 }, () => {
		const end = new End();
		end.notifyClose = false;
		end.peer = new End();
		s.attach(end);
		return end;
	});
	expect(
		"a fifth socket that has not introduced itself sends the oldest away; the current one is not touched",
		!silent[0]!.open && silent.slice(1).every(end => end.open) && s.connected && link.s.open,
	);
	s.close();
	r.close();
}

/** What a session actor's storage holds of a durable conversation (runner/journal.ts), kept in memory for the check. */
class Storage {
	record: ConversationRecord | null = null;
	/** The outgoing writer: what `unsaved` says, stored, then let out. */
	save(ch: ServerChannel): void {
		const u = ch.unsaved();
		if (!u) return;
		if (u.conversation === null) this.record = null;
		else {
			if (u.fresh || !this.record)
				this.record = { conversation: u.conversation, sent: 0, acked: 0, received: 0, frames: [] };
			const r = this.record;
			r.frames = [...r.frames.filter(([seq]) => seq > u.acked), ...u.frames.filter(([seq]) => seq > u.acked)];
			r.sent = Math.max(r.sent, u.sent);
			r.acked = Math.max(r.acked, u.acked);
		}
		ch.saved(u);
	}
	/** The timeline's writer: what was received, committed with what it produced, then acknowledged. */
	commit(ch: ServerChannel): void {
		const n = ch.receivedCount;
		if (this.record && this.record.conversation === ch.conversationId) {
			this.record.received = Math.max(this.record.received, n);
			ch.committed(ch.conversationId, n);
		}
	}
	/** A copy, as a restarted server reads it. */
	read(): ConversationRecord | null {
		return this.record && structuredClone(this.record);
	}
}

/** A durable server end whose storage is `store`, saved by hand as the actor's writers would. */
function durable(store: Storage, from: ConversationRecord | null = null) {
	const { ch, resets } = server();
	ch.keepIn(() => undefined, from);
	return { ch, resets };
}

async function durableRestart(): Promise<void> {
	const store = new Storage();
	const { ch: s1 } = durable(store);
	const { ch: r, log } = runner();
	const a = join(s1, r);
	store.save(s1);
	const out1: string[] = [];
	const proc = s1.start({ ...box, tag: "t9", argv: ["windlass", "acp"] }, (_, data) => out1.push(data));
	a.flush();
	expect("durable: a frame goes out only once it is stored (written ahead)", log.ops.length === 0);
	store.save(s1);
	a.flush();
	const [start] = log.held;
	expect("durable: once stored it goes", start?.name === "start");
	r.respond(start, null);
	r.output(start.id, 1, "one");
	a.flush();
	store.commit(s1);
	r.output(start.id, 1, "two");
	a.flush();
	mock.timers.tick(ACK_MS);
	a.flush();
	expect(
		"durable: only what is committed is acknowledged",
		out1.join() === "one,two" && r.buffered.frames === 1,
		`runner holds ${r.buffered.frames}`,
	);
	// Written while the link is about to break: stored, never delivered.
	s1.write(proc.id, "steer");
	void outcome(
		s1.request("writeSecretFile", { ...box, path: "/dev/shm/access-token-box.json", content: "SECRET-TOKEN-VALUE" }),
	);
	void outcome(
		s1.request("modelRelay", {
			...box,
			forward: { provider: "openai", host: "relay.fixture.test", placeholder: "wlpm1.pending", expiresAt: 1 },
		}),
	);
	void outcome(
		s1.request("planRelayToken", { ...box, lease: "a".repeat(32), token: "RELAY-TOKEN-VALUE-0123", expiresAt: 1 }),
	);
	store.save(s1);
	const stored = JSON.stringify(store.read());
	expect(
		"durable: no frame that carries a token is stored",
		!stored.includes("SECRET-TOKEN-VALUE") &&
			!stored.includes("RELAY-TOKEN-VALUE") &&
			!stored.includes("wlpm1.pending"),
	);
	const lost = a.cut().toRunner.map(frame => JSON.parse(frame).body);
	const pendingIds = lost.filter(body => body?.kind === "op").map(body => body.id);
	// The server is gone; the runner keeps its process, which goes on printing.
	s1.abandon();
	r.output(start.id, 1, "three");
	const out2: string[] = [];
	const { ch: s2, resets } = durable(store, store.read());
	const taken = s2.adoptProcess(start.id, (_, data) => out2.push(data));
	const b = join(s2, r);
	b.flush();
	mock.timers.tick(ACK_MS);
	b.flush();
	expect(
		"durable: the restarted server resumes the same conversation; the runner resets nothing",
		log.resets.length === 0 && resets.length === 0 && s2.connected,
	);
	expect(
		"durable: output received but not committed, and output made during the gap, arrive once",
		out2.join() === "two,three",
		out2.join(),
	);
	expect("durable: frames the runner had not received are sent again, once", log.input.join() === "steer");
	expect(
		"durable: the pending secret operations replay as cancels for their original ids",
		new Set(pendingIds).size === 3 && log.cancels.join() === pendingIds.join(),
	);
	expect(
		"durable: replay opens no lease, writes no token and cancels no received operation",
		log.ops.join() === "start" && !log.held.some(op => log.cancels.includes(op.id)),
	);
	r.end(start.id, done);
	b.flush();
	expect("durable: the process taken up ends as it ends", (await taken!.ended).code === 0);
	store.commit(s2);
	mock.timers.tick(ACK_MS);
	b.flush();
	store.save(s2);
	expect(
		"durable: once all is committed and acknowledged, nothing is held",
		r.buffered.frames === 0 && s2.buffered.frames === 0 && (store.read()?.frames.length ?? -1) === 0,
	);
}

async function durablePastGrace(): Promise<void> {
	const store = new Storage();
	const { ch: s1 } = durable(store);
	const { ch: r, log } = runner();
	const a = join(s1, r);
	s1.start({ ...box, tag: "t10", argv: ["windlass", "acp"] }, () => {});
	store.save(s1);
	a.flush();
	r.respond(log.held[0], null);
	a.flush();
	store.commit(s1);
	a.cut();
	s1.abandon();
	// The runner waited out its grace: the conversation and its processes are let go (the orphan rule).
	mock.timers.tick(RUNNER_GRACE_MS);
	const { ch: s2, resets } = durable(store, store.read());
	const taken = s2.adoptProcess(log.held[0].id, () => {});
	const b = join(s2, r);
	b.flush();
	const end = await taken!.ended;
	expect(
		"durable: past the runner's grace the restarted server starts a new conversation, and the process it held ends as lost",
		log.resets.length === 1 && resets.length === 1 && end.error instanceof ConversationLost,
	);
	const next = s2.request("state", box);
	store.save(s2);
	b.flush();
	r.respond(log.held[1], "running");
	b.flush();
	expect("durable: and the new conversation serves", (await next) === "running");
	expect("durable: storage then holds the new conversation", store.read()?.conversation === s2.conversationId);
}

async function main(): Promise<void> {
	mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_000_000 });
	try {
		for (const check of [
			dropAndResume,
			actorWakes,
			runnerRestarts,
			grace,
			stream,
			large,
			untrusted,
			harnessCreate,
			mismatch,
			liveness,
			order,
			expiry,
			closing,
			strangers,
			durableRestart,
			durablePastGrace,
		])
			await check();
	} finally {
		mock.timers.reset();
	}
	timers();
	console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
	process.exitCode = failures ? 1 : 0;
}
// An unresolved promise alone would let Node exit successfully before the last check.
const watchdog = setTimeout(() => {
	console.error("FAIL  check did not finish");
	process.exit(1);
}, 60_000);
main()
	.catch((error: Error) => {
		console.error(`FAIL  ${error.stack}`);
		process.exitCode = 1;
	})
	.finally(() => clearTimeout(watchdog));
