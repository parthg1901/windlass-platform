/** Stand-in for a paired runner, serving recorded Windlass turns over real control and session sockets. */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient, type Registry } from "../server/src/client.js";
import type { WindlassEvent } from "../server/src/contract.js";
import { type ChannelSocket, RunnerChannel } from "../server/src/runner/channel.js";
import { MIN_RUNNER_VERSION, parseConnection, parseServerFrame, sessionProof } from "../server/src/runner/control.js";
import type { Operation } from "../server/src/runner/protocol.js";
import { FakeAcpAgent } from "./acp-agent-fake.js";
import { FakeRunner } from "./runner-fake.js";
import { sleep } from "./check-wait.js";

const FIXTURE = fileURLToPath(
	new URL("../fixtures/windlass-events/demo-several-steps-in-one-turn.jsonl", import.meta.url),
);

export function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
/** How long one probe of `until` may take before it is asked again. */
const ATTEMPT_MS = 15_000;
/**
 * Asks `probe` until it gives a value, for `ms` at most. A call made while a restarted engine still
 * answers `service_unavailable` can be left without an answer: such an attempt is abandoned after
 * ATTEMPT_MS and the probe is asked again, so the wait still ends by its deadline.
 */
export async function until<T>(
	what: string,
	probe: () => T | undefined | null | false | Promise<T | undefined | null | false>,
	ms = 30_000,
): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const attempt = Promise.resolve().then(probe);
		attempt.catch(() => undefined);
		let timer: Parameters<typeof clearTimeout>[0];
		const abandoned = new Promise<undefined>(done => {
			timer = setTimeout(done, Math.max(50, Math.min(ATTEMPT_MS, end - Date.now())));
		});
		const value = await Promise.race([attempt, abandoned]).finally(() => clearTimeout(timer));
		if (value !== undefined && value !== null && value !== false) return value;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}
export function opened(ws: WebSocket): Promise<void> {
	if (ws.readyState === 1) return Promise.resolve();
	return new Promise((done, fail) => {
		ws.addEventListener("open", () => done(), { once: true });
		ws.addEventListener("close", () => fail(new Error("the socket closed while opening")), { once: true });
	});
}

const RECORDED: WindlassEvent[] = readFileSync(FIXTURE, "utf8")
	.split("\n")
	.filter(line => line.trim() !== "")
	.map(line => JSON.parse(line) as WindlassEvent)
	.filter(event => event.type !== "cli.summary");

/** The text of every `session/prompt` an engine of the stand-in was sent, oldest first: what a resumed turn was given. */
export const enginePrompts: string[] = [];

/** `windlass acp`, as little of it as a turn needs: it replays one recorded turn. "(slow)" in the prompt spaces its events out. */
class Engine {
	private session = `ses_standin${randomBytes(6).toString("hex")}`;
	private buffer = "";
	private timers: ReturnType<typeof setTimeout>[] = [];
	private prompt: unknown = null;

	constructor(
		private readonly say: (line: string) => void,
		private readonly onOpen: (meta: Record<string, unknown>) => void,
		private readonly missingSession: () => boolean,
	) {}

	input(data: string): void {
		this.buffer += data;
		for (let at = this.buffer.indexOf("\n"); at >= 0; at = this.buffer.indexOf("\n")) {
			const line = this.buffer.slice(0, at);
			this.buffer = this.buffer.slice(at + 1);
			if (line.trim() !== "")
				this.handle(JSON.parse(line) as { id?: unknown; method?: string; params?: Record<string, unknown> });
		}
	}

	stop(): void {
		for (const timer of this.timers) clearTimeout(timer);
	}

	private send(message: Record<string, unknown>): void {
		this.say(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	}

	private handle(m: { id?: unknown; method?: string; params?: Record<string, unknown> }): void {
		const reply = (result: unknown) => this.send({ id: m.id, result });
		switch (m.method) {
			case "initialize":
				return reply({
					protocolVersion: 1,
					agentCapabilities: { _meta: { windlass: { notifications: ["_windlass/event"], openMeta: ["hostTools"] } } },
				});
			case "session/new":
				this.onOpen((m.params?._meta as { windlass?: Record<string, unknown> })?.windlass ?? {});
				return reply({ sessionId: this.session });
			case "_windlass/resolve":
				this.session = String(m.params?.session);
				return reply({ sessionId: this.session, cwd: "/workspace" });
			case "session/resume":
				if (this.missingSession())
					return this.send({ id: m.id, error: { code: -32002, message: "The saved session is gone." } });
				this.onOpen((m.params?._meta as { windlass?: Record<string, unknown> })?.windlass ?? {});
				return reply({});
			case "session/close":
				return reply({});
			case "session/prompt": {
				this.prompt = m.id;
				const text = JSON.stringify(m.params?.prompt ?? "");
				enginePrompts.push(
					((m.params?.prompt as Array<{ text?: unknown }> | undefined) ?? [])
						.map(part => String(part.text ?? ""))
						.join(""),
				);
				if (text.includes("(session title)")) {
					// As Windlass does: its first-line fallback over ACP, which the platform ignores, then the generated title.
					this.send({
						method: "session/update",
						params: {
							sessionId: this.session,
							update: { sessionUpdate: "session_info_update", title: "Read the repo (fallback)" },
						},
					});
					this.send({
						method: "_windlass/event",
						params: {
							sessionId: this.session,
							event: {
								type: "session.renamed",
								v: 1,
								data: { title: "Inspect the files", generated: true },
								sessionId: this.session,
								seq: RECORDED.length + 1,
								time: Date.now(),
							},
						},
					});
				}
				const gap = text.includes("(slow)") ? 120 : 5;
				RECORDED.forEach((event, index) => {
					this.timers.push(
						setTimeout(
							() =>
								this.send({
									method: "_windlass/event",
									params: { sessionId: this.session, event: { ...event, sessionId: this.session } },
								}),
							gap * (index + 1),
						),
					);
				});
				this.timers.push(setTimeout(() => this.answer("end_turn", "succeeded"), gap * (RECORDED.length + 1)));
				return;
			}
			case "session/cancel":
				this.stop();
				this.send({
					method: "_windlass/event",
					params: {
						sessionId: this.session,
						event: {
							type: "execution.interrupted",
							v: 1,
							data: { executionId: "exe_1" },
							sessionId: this.session,
							seq: 999,
							time: Date.now(),
						},
					},
				});
				return this.answer("cancelled", "interrupted");
			default:
				if (m.id !== undefined && m.method !== undefined)
					this.send({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
		}
	}

	private answer(stopReason: string, outcome: string): void {
		if (this.prompt === null) return;
		this.send({ id: this.prompt, result: { stopReason, _meta: { windlass: { executionId: "exe_1", outcome } } } });
		this.prompt = null;
	}
}

type AgentProcess = Pick<Engine, "input" | "stop">;

interface Box {
	size?: number;
	harness?: "claude" | "opencode" | "codex";
	id: string;
	sessionId: string;
	profile: "docker-windlass-sandbox" | "docker-hardened";
	state: "running" | "paused";
	files: Map<string, string>;
	/** The engines running in it, which outlive the runner process that started them, as in a container. */
	engines: Set<AgentProcess>;
}

/** What the runner holds for one session: its channel, in memory only. */
interface Served {
	channel: RunnerChannel;
	ws: WebSocket | null;
	resets: string[];
	processes: Map<string, { engine: AgentProcess | null; box: Box }>;
	runs: Map<string, Operation>;
}

export class StandInRunner {
	constructor(
		private readonly origin: string,
		private readonly endpoint: string,
		private readonly options: {
			claude?: boolean;
			stateDir?: string;
			getToken?: () => Promise<string>;
			namespace?: string;
			onAcpUpdate?: () => void;
		} = {},
	) {
		if (options.claude)
			this.fake.report.harnesses = [
				{ id: "claude", adapter: "claude-agent-acp 0.109.0", image: "sha256:fake", signIn: "token" },
			];
	}

	/** Messages received by the in-process fixture, for assertions about cancellation and steering. */
	readonly acpInput: string[] = [];

	readonly fake = new FakeRunner();
	id!: { uid: string; machineId: string };
	readonly boxes = new Map<string, Box>();
	readonly opens = new Map<string, Record<string, unknown>>();
	served = new Map<string, Served>();
	control: { ws: WebSocket; send(frame: never): void } | null = null;
	epoch = randomUUID();
	/** What an `attach` frame does: "serve" it, "ignore" it, or "hold" its ticket for the check to use. */
	attachMode: "serve" | "ignore" | "hold" = "serve";
	held: Array<{ sessionId: string; ticket: string }> = [];
	attaches = 0;
	usedTickets: Array<{ sessionId: string; ticket: string }> = [];
	cancels: string[] = [];
	leftovers = 0;
	/** Agent processes started, of any session: a turn taken up after a restart starts none. */
	engineStarts = 0;
	readonly missingSessions = new Set<string>();
	/** The machine is at its owner's cap (`--max-sandboxes`): a `create` is refused as the real runner refuses it. */
	full = false;
	/** Its owner's `--max-sandboxes`: a `create` for a new session past this many is refused, as `full` is. */
	maxSandboxes: number | undefined = undefined;
	/** How many create replies to lose by restarting before answering or reporting the container. */
	loseCreates = 0;
	/**
	 * Whether the session's turns pay (a plan): its Windlass reports 0.7.1 and its leftover sweep finds nothing. Every
	 * runner has the plan relay; what the server asks of it is counted here.
	 */
	paying = false;
	/** What plan relays were asked: `limits` each one's request limit, `ends` each open's and hand-over's `expiresAt`. */
	readonly planRelays = {
		opened: 0,
		tokens: 0,
		seen: 0,
		closed: 0,
		leases: new Set<string>(),
		limits: [] as number[],
		ends: [] as number[],
	};
	creates = 0;
	offline = false;
	removed = false;

	async pair(user: {
		claimMachine(input: { code: string }): Promise<unknown>;
		confirmMachine(input: { code: string; keyConfirmed: true }): Promise<{ machineId: string }>;
	}): Promise<void> {
		const pairing = await this.fake.pair(this.origin);
		await user.claimMachine({ code: pairing.code });
		await user.confirmMachine({ code: pairing.code, keyConfirmed: true });
		const status = await this.fake.poll(this.origin, pairing);
		assert(status?.state === "approved", `pairing ended ${status?.state ?? "without status"}`);
		this.id = { uid: status.uid, machineId: status.machineId };
	}

	private client() {
		return createClient<Registry>({
			endpoint: this.endpoint,
			token: "default",
			getToken: this.options.getToken,
			namespace: this.options.namespace ?? "default",
			disableMetadataLookup: true,
		});
	}

	async openControl(version = MIN_RUNNER_VERSION) {
		const answer = await this.fake.connection(this.origin, this.id);
		const connection = parseConnection(await answer.json());
		assert(connection, `no connection (HTTP ${answer.status})`);
		return this.fake.connect(connection, this.id, { epoch: this.epoch, version });
	}

	/** The control socket, again whenever it closes, unless the machine is offline or removed. */
	async connectControl(): Promise<void> {
		const control = await this.openControl();
		// One begun before the machine went off the network does not bring it back.
		if (this.offline || this.removed || this.control) {
			control.ws.close();
			return;
		}
		this.control = control as never;
		control.ws.addEventListener("message", ({ data }) => {
			const frame = parseServerFrame(data);
			if (frame?.kind === "attach") this.attach(frame.sessionId, frame.ticket);
			if (frame?.kind === "remove") this.boxes.delete(frame.sandbox);
			// What a real runner does when its machine is removed: it serves no session any more.
			if (frame?.kind === "refused" && frame.reason === "removed") {
				this.removed = true;
				for (const served of this.served.values()) served.ws?.close();
			}
		});
		control.ws.addEventListener("close", () => {
			if (this.control?.ws !== control.ws) return;
			this.control = null;
			if (!this.offline && !this.removed) void this.reconnect();
		});
		await opened(control.ws);
		await until(
			"the machine's welcome",
			() => {
				if (control.ws.readyState > 1) {
					if (this.control?.ws === control.ws) this.control = null;
					throw new Error("the control socket was refused");
				}
				return control.frames.some(frame => frame.kind === "welcome");
			},
			15_000,
		);
	}

	private async reconnect(): Promise<void> {
		for (;;) {
			await sleep(500);
			if (this.offline || this.removed || this.control) return;
			try {
				await this.connectControl();
				return;
			} catch {
				// The server is restarting.
			}
		}
	}

	report(): void {
		this.fake.report.sandboxes = [...this.boxes.values()].map(({ id, sessionId, state }) => ({
			id,
			sessionId,
			state,
			usedAt: Date.now(),
		}));
		this.control?.send(this.fake.report as never);
	}

	/** The machine goes off the network (control socket closed, and no reconnection), or comes back. */
	async setOffline(off: boolean): Promise<void> {
		this.offline = off;
		if (off) {
			const control = this.control;
			this.control = null;
			control?.ws.close();
			for (const served of this.served.values()) served.ws?.close();
		} else {
			await this.connectControl();
		}
	}

	/** The session's grace ran out on the runner: its conversation ends, and what it ran is stopped (the orphan rule). */
	expireGrace(sessionId: string): void {
		const served = this.served.get(sessionId);
		if (!served) return;
		this.served.delete(sessionId);
		served.channel.close("The platform did not come back within ten minutes.");
		served.ws?.close();
	}

	/** The runner process dies and starts again: every channel is gone, the containers and what runs in them are not. */
	async restartProcess(): Promise<void> {
		const served = [...this.served.values()];
		this.served = new Map();
		for (const s of served) s.ws?.close();
		const control = this.control;
		this.control = null;
		this.epoch = randomUUID();
		control?.ws.close();
		await sleep(200);
		await this.connectControl();
	}

	private async attach(sessionId: string, ticket: string): Promise<void> {
		this.attaches += 1;
		if (this.attachMode === "ignore") return;
		if (this.attachMode === "hold") {
			this.held.push({ sessionId, ticket });
			return;
		}
		let served = this.served.get(sessionId);
		if (!served) {
			served = this.serve(sessionId);
			this.served.set(sessionId, served);
		}
		const ws = (await this.client().agentSession.get([this.id.uid, sessionId]).webSocket("runner")) as WebSocket;
		await opened(ws);
		served.ws = ws;
		this.usedTickets.push({ sessionId, ticket });
		served.channel.attach(socketOf(ws), {
			runnerVersion: MIN_RUNNER_VERSION,
			machineId: this.id.machineId,
			ticket,
			signature: this.fake.sign(sessionProof(this.id.uid, sessionId, this.id.machineId, ticket)),
		});
	}

	private serve(sessionId: string): Served {
		const served: Served = {
			ws: null,
			resets: [],
			processes: new Map(),
			runs: new Map(),
			channel: new RunnerChannel({
				onOperation: op => this.operation(served, sessionId, op),
				onInput: (process, data) => served.processes.get(process)?.engine?.input(data),
				onCloseIn: process => this.end(served, process, { code: 0, signal: null, error: null }),
				onCancel: id => {
					const op = served.runs.get(id);
					if (!op) return;
					served.runs.delete(id);
					this.cancels.push(id);
					served.channel.respond(op, { exitCode: null, timedOut: false, aborted: true, stdout: "", stderr: "" });
				},
				onDrain: () => undefined,
				// The orphan rule: what the ended conversation started gets its stdin closed.
				onReset: reason => {
					served.resets.push(reason);
					for (const id of [...served.processes.keys()]) this.end(served, id, { code: 0, signal: null, error: null });
				},
				onRefused: reason => served.resets.push(`refused: ${reason}`),
			}),
		};
		return served;
	}

	private end(served: Served, process: string, end: { code: number | null; signal: string | null; error: null }): void {
		const p = served.processes.get(process);
		if (!p) return;
		served.processes.delete(process);
		if (p.engine) {
			p.engine.stop();
			p.box.engines.delete(p.engine);
		}
		served.channel.end(process, end);
	}

	private operation(served: Served, sessionId: string, op: Operation): void {
		const { channel } = served;
		const box = "id" in op.args ? this.boxes.get(op.args.id as string) : undefined;
		const mine = box !== undefined && box.sessionId === sessionId;
		switch (op.name) {
			case "create": {
				this.creates += 1;
				// As the runner does: a session's sandbox, once made, is the answer to its every `create`, also after a restart.
				const had = [...this.boxes.values()].find(existing => existing.sessionId === sessionId);
				// The real runner's sentence (runner/src/docker-executor.ts), sent as a SandboxUserError is (runner/src/session.ts).
				if (!had && (this.full || (this.maxSandboxes !== undefined && this.boxes.size >= this.maxSandboxes)))
					return channel.refuse(op, {
						kind: "user",
						message: "This machine has reached its own limit on kept sandboxes, set by --max-sandboxes.",
					});
				const made: Box = had ?? {
					id: `${this.id.machineId}-${randomBytes(6).toString("hex")}`,
					sessionId,
					size: op.args.size,
					profile: op.args.profile,
					harness: op.args.harness,
					state: "running",
					files: new Map(),
					engines: new Set(),
				};
				this.boxes.set(made.id, made);
				if (this.loseCreates > 0) {
					// Before any report: the real runner reports at most once a minute, so the server cannot count on one.
					this.loseCreates--;
					void sleep(300).then(() => this.restartProcess());
					return;
				}
				if (!had) this.report();
				return channel.respond(op, made.id);
			}
			case "connect":
				if (!mine) return channel.respond(op, null);
				box.state = "running";
				return channel.respond(op, {
					cwd: "/workspace",
					profile: box.profile,
				});
			case "state":
				return channel.respond(op, mine ? box.state : "none");
			case "suspend":
				if (mine) box.state = "paused";
				return channel.respond(op, null);
			case "destroy":
				if (mine) this.boxes.delete(box.id);
				this.report();
				return channel.respond(op, null);
			case "run":
				if (!mine) return channel.refuse(op, { kind: "refused", message: "No such sandbox." });
				// A clone that goes on until it is cancelled, for the stopped turn.
				if (op.args.command.includes("slow-clone")) {
					served.runs.set(op.id, op);
					return;
				}
				return channel.respond(op, { exitCode: 0, timedOut: false, aborted: false, stdout: "", stderr: "" });
			case "readTextFile": {
				const content = box?.files.get(op.args.path);
				if (!mine || content === undefined)
					return channel.refuse(op, { kind: "sandbox", message: `no such file: ${op.args.path}` });
				return channel.respond(op, content);
			}
			case "writeTextFile":
			case "writeSecretFile":
				if (mine) box.files.set(op.args.path, op.args.content);
				return channel.respond(op, null);
			case "removeFiles":
				for (const path of op.args.paths) box?.files.delete(path);
				return channel.respond(op, null);
			case "start": {
				if (!mine) return channel.refuse(op, { kind: "refused", message: "No such sandbox." });
				const isEngine = op.args.argv[0] === "windlass" && op.args.argv[1] === "acp";
				let engine: AgentProcess | null;
				if (op.args.argv[0] === "wlp-claude-acp" && box.harness === "claude" && this.options.claude) {
					const agent = new FakeAcpAgent(line => {
						if (this.options.onAcpUpdate && JSON.parse(line).method === "session/update") this.options.onAcpUpdate();
						channel.output(op.id, 1, line);
					}, this.options.stateDir);
					engine = {
						input: chunk => {
							this.acpInput.push(chunk);
							agent.input(chunk);
						},
						stop: () => agent.stop(),
					};
				} else
					engine = isEngine
						? new Engine(
								line => channel.output(op.id, 1, line),
								meta => this.opens.set(sessionId, meta),
								() => this.missingSessions.has(sessionId),
							)
						: null;
				if (engine) box.engines.add(engine);
				if (engine) this.engineStarts += 1;
				served.processes.set(op.id, { engine, box });
				return channel.respond(op, null);
			}
			case "signal":
				this.end(served, op.args.process, { code: null, signal: `SIG${op.args.sig}`, error: null });
				return channel.respond(op, null);
			case "killClient":
				this.end(served, op.args.process, { code: null, signal: "SIGKILL", error: null });
				return channel.respond(op, null);
			case "ask":
				// The plan turn's check of the sandbox's Windlass (token-file.ts `openModelKeyRelay`).
				if (this.paying && op.args.argv.join(" ") === "windlass --version")
					return channel.respond(op, { code: 0, stdout: "Windlass 0.7.1\n", stderr: "" });
				// A paying turn's sweep of leftover processes before its token file (provider.ts `sweepSessionProcesses`): none here.
				if (this.paying && op.args.argv[0] === "/usr/bin/python3")
					return channel.respond(op, { code: 0, stdout: "", stderr: "" });
				// No shell here: an answer of a program that is not there, which the turn reads as "nothing to read".
				return channel.respond(op, { code: 127, stdout: "", stderr: "stand-in runner: no shell" });
			case "stopLeftovers": {
				// Engines a dead runner process left running, which no channel serves any more.
				const live = new Set([...served.processes.values()].map(p => p.engine));
				const left = mine ? [...box.engines].filter(engine => !live.has(engine)) : [];
				for (const engine of left) {
					engine.stop();
					box?.engines.delete(engine);
				}
				this.leftovers += left.length;
				return channel.respond(op, left.length);
			}
			case "sweep":
				return channel.respond(op, 0);
			// The relay itself is the runner's (model-relay.ts `openPlan`): here only what it was asked is counted.
			case "planRelay": {
				if (!mine) return channel.refuse(op, { kind: "refused", message: "No such sandbox." });
				const lease = randomBytes(16).toString("hex");
				this.planRelays.opened += 1;
				this.planRelays.leases.add(lease);
				this.planRelays.limits.push(op.args.requestLimit);
				this.planRelays.ends.push(op.args.expiresAt);
				return channel.respond(op, {
					lease,
					placeholder: `wlp-plan.${randomBytes(32).toString("base64url")}`,
					env: {
						WINDLASS_MODEL_BASE_URL: "http://127.0.0.1:17893/v1",
						WINDLASS_MODEL_ALLOWED_ORIGIN: "http://127.0.0.1:17893",
					},
				});
			}
			case "planRelayToken":
				if (!this.planRelays.leases.has(op.args.lease))
					return channel.refuse(op, { kind: "refused", message: "This plan relay lease has ended." });
				this.planRelays.tokens += 1;
				this.planRelays.ends.push(op.args.expiresAt);
				return channel.respond(op, null);
			case "planRelaySeen":
				this.planRelays.seen += 1;
				return channel.respond(op, []);
			case "modelRelayClose":
				if (this.planRelays.leases.delete(op.args.lease)) this.planRelays.closed += 1;
				return channel.respond(op, null);
		}
	}
}

function socketOf(ws: WebSocket): ChannelSocket {
	return {
		send: text => ws.send(text),
		close: () => ws.close(),
		onMessage: listener => ws.addEventListener("message", event => listener(event.data)),
		onClose: listener => ws.addEventListener("close", () => listener()),
	};
}
