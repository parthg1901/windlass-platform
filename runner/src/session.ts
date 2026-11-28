import { basename } from "node:path";
import { RunnerChannel, type ChannelSocket, type SessionTrust } from "../../server/src/runner/channel.js";
import type { Hello, Operation, Value } from "../../server/src/runner/protocol.js";
import { SandboxUserError } from "../../server/src/sandbox/api.js";
import { DockerSandboxHandle, type DockerProcess, type StartOptions } from "../../server/src/sandbox/sandboxes.js";
import { tokenFilePath } from "../../server/src/sandbox/token-file.js";
import { containerName } from "../../server/src/sandbox/sandboxes.js";
import type { KeyTurnRelay } from "../../server/src/sandbox/provider.js";
import type { ModelProvider, RelaySeen } from "../../server/src/contract.js";
import { MAX_PLAN_SEEN } from "../../server/src/runner/protocol.js";
import type { DockerPlanRelay } from "../../server/src/sandbox/model-relay.js";
import { randomBytes } from "node:crypto";
import { audit, safeSentence } from "./audit.js";
import { type Box, Executor } from "./docker-executor.js";
import { cleanClaudeOutput, claudeStream } from "./claude-output.js";
import { readMemoryEvents } from "./memory-events.js";
import { shotsImage } from "./policy.js";
import { Refusal } from "./state.js";
import { MACHINE_HARNESSES } from "./machine-harnesses.js";

// run() uses this same start() internally. Capture its pipes without reimplementing the
// Docker provider's stdin handling, cancellation, signal escalation or output truncation.
class Handle extends DockerSandboxHandle {
	constructor(
		private readonly box: Box,
		uid: string,
		private readonly track: (p: DockerProcess) => void,
	) {
		super(box.raw, box.profile, uid);
	}
	override start(argv: string[], options?: StartOptions, tag?: string) {
		// Scrub before DockerSandboxHandle accumulates or truncates a run result and before
		// the channel frames (and retains for replay) a single byte of streamed output.
		const stdout = this.box.harness && options?.onStdout ? claudeStream(options.onStdout) : undefined;
		const stderr = this.box.harness && options?.onStderr ? claudeStream(options.onStderr) : undefined;
		const p = super.start(
			argv,
			{ ...options, onStdout: stdout?.write ?? options?.onStdout, onStderr: stderr?.write ?? options?.onStderr },
			tag,
		);
		void p.ended.then(() => {
			stdout?.end();
			stderr?.end();
		});
		this.track(p);
		return p;
	}
}

class Conversation {
	private active = true;
	private paused = false;
	private pipes = new Set<DockerProcess>();
	private processes = new Map<
		string,
		{ p: DockerProcess; acp: boolean; handle: Handle; id: string; closeLogin?: () => Promise<void> }
	>();
	private runs = new Map<string, AbortController>();
	/** The turns' leases of the model relay this conversation opened, by the name the server knows them by. */
	private relays = new Map<
		string,
		{
			operation: string;
			relay: KeyTurnRelay | DockerPlanRelay;
			provider?: ModelProvider;
			/** A plan relay's: what the provider said of the plan since the server last asked (`planRelaySeen`). */
			plan?: { seen: RelaySeen[] };
			id: string;
			untrack: () => void;
		}
	>();
	constructor(
		private owner: Executor,
		private session: string,
		private channel: RunnerChannel,
	) {}
	input(id: string, data: string) {
		this.processes.get(id)?.p.write(data);
	}
	eof(id: string) {
		this.processes.get(id)?.p.closeStdin();
	}
	cancel(id: string) {
		this.runs.get(id)?.abort();
		for (const [lease, held] of this.relays) if (held.operation === id) void this.closeRelay(lease);
	}
	private async closeRelay(lease: string) {
		const held = this.relays.get(lease);
		if (!held) return;
		this.relays.delete(lease);
		held.untrack();
		await held.relay.close();
	}
	pause(paused: boolean) {
		this.paused = paused;
		for (const p of this.pipes) p.pauseOutput(paused);
	}
	async orphan() {
		this.active = false;
		this.pause(false);
		// The server that opened them is gone: their turns end, and the relay forgets their tokens.
		const leases = [...this.relays.values()].map(({ relay, untrack }) => {
			untrack();
			return relay.close();
		});
		this.relays.clear();
		await Promise.all(leases);
		const stops = [...this.processes.values()].map(async ({ p, acp, handle, id, closeLogin }) => {
			p.closeStdin();
			await closeLogin?.();
			if (acp) {
				const path = tokenFilePath(id);
				await handle.sweep(p.tag, { waitMs: 3000, files: [path, path + ".tmp"] });
			}
		});
		await Promise.all(stops);
	}
	private output(id: string, fd: 1 | 2, text: string) {
		if (this.active && !this.channel.output(id, fd, text)) this.pause(true);
	}
	private requireActive() {
		if (!this.active) throw new Refusal("The session conversation ended.");
	}
	private async execute(op: Operation, abort?: AbortController): Promise<Value<Operation["name"]>> {
		const o = this.owner;
		switch (op.name) {
			case "create": {
				const { harness, profile, prepared } = op.args;
				if (prepared && harness) throw new Refusal("This harness cannot use snapshots.");
				if (harness) o.requireHarness(profile, harness);
				const existing = await o.serial(() => {
					this.requireActive();
					return o.existing(this.session, profile, harness);
				});
				if (existing) return existing;
				const screenshots = !harness && op.args.screenshots === true && o.screenshots;
				// What making it takes, for the first connect to tell a server that named `start-times` (docs/architecture.md, "Start times").
				const began = Date.now();
				let pulled = await o.ensureImage(); // The disk-space helper always uses the base pin.
				if (harness) pulled = (await o.prepareHarness(profile, harness)) === true || pulled;
				if (screenshots) pulled = (await o.ensureImage(shotsImage)) || pulled;
				const imaged = Date.now();
				return o.serial(async () => {
					this.requireActive();
					const creating = Date.now();
					const made = await o.create(
						this.session,
						profile,
						screenshots,
						harness,
						op.args.size,
						prepared,
						op.args.mirrorRepo,
						this.channel.authenticated ? op.args.spare : undefined,
						op.args.environmentBuild,
						op.args.privateData,
					);
					const box = o.boxes.get(made);
					// Only a sandbox this create made: `existing` hands back one an earlier create made.
					if (box && box.usedAt >= creating)
						box.startTimes = {
							...(box.claim && { spare: true as const }),
							image: imaged - began,
							...(pulled && { pulled: true as const }),
							create: Date.now() - creating,
						};
					return made;
				});
			}
			case "seedSpare":
				return this.channel.authenticated && o.seedSpare(this.session, op.args.id, op.args.spare, op.args.screenshots);
			case "openCodeDefault":
				return o.openCodeDefault(op.args.providers);
			case "hasSnapshot":
				return o.provider.hasSnapshot(o.identity.uid, op.args.repo);
			// Not serial: a save runs for minutes in its own helper container, outside the sandbox.
			case "saveMirror":
				return o.saveMirror(this.session, op.args.id, op.args.stage, op.args.partial);
			// The session's own copies (session-backups.ts): its own sandbox, and its own name, checked there.
			case "backupSave":
			case "backupRestore":
				this.requireActive();
				return op.name === "backupSave"
					? o.backup(this.session, "backupSave", op.args)
					: o.backup(this.session, "backupRestore", op.args);
			case "backupCopy":
				this.requireActive();
				return o.backupCopy(this.session, op.args);
			case "saveSnapshot": {
				const { id, source } = op.args;
				return o.serial(() => {
					this.requireActive();
					return o.saveSnapshot(this.session, id, source);
				});
			}
			case "connect":
			case "suspend":
			case "destroy":
			case "state":
				return o.serial(async () => {
					this.requireActive();
					return o.lifecycle(op.name, op.args.id, this.session);
				});
			case "killClient":
			case "signal": {
				const run = this.processes.get(op.args.process);
				if (!run) throw new Refusal("This process does not belong to this session.");
				if (op.name === "signal") await run.p.signal(op.args.sig, op.args.who);
				else run.p.killClient();
				return null;
			}
		}
		const id = op.args.id;
		const box = o.running(id, this.session);
		if (
			op.name === "start" ||
			op.name === "writeSecretFile" ||
			(op.name === "run" && Object.keys(op.args.options?.secretEnv ?? {}).length)
		)
			box.snapshotCandidate = false;
		if (box.savingSnapshot) throw new Refusal("The sandbox is saving its prepared image.");
		const h = new Handle(box, o.identity.uid, p => {
			this.pipes.add(p);
			if (this.paused) p.pauseOutput(true);
			void p.ended.then(() => this.pipes.delete(p));
		});
		const streams = {
			onStdout: (s: string) => this.output(op.id, 1, s),
			onStderr: (s: string) => this.output(op.id, 2, s),
		};
		box.busy++;
		try {
			switch (op.name) {
				case "start": {
					const acp =
						(box.harness && basename(op.args.argv[0] ?? "") === `wlp-${box.harness}-acp`) ||
						(basename(op.args.argv[0] ?? "") === "windlass" && op.args.argv.includes("acp"));
					let p: DockerProcess;
					let closeLogin: (() => Promise<void>) | undefined;
					try {
						if (acp) {
							const retiring = o.turnStarted(box);
							if (retiring) {
								await retiring;
								this.requireActive();
								o.running(id, this.session);
							}
						}
						let argv = op.args.argv;
						const options = { ...op.args.options, ...streams };
						if (acp && box.harness) {
							const held = [...this.relays.values()].filter(one => one.id === id);
							const keys = Object.fromEntries(
								held.filter(one => one.provider).map(one => [one.provider!, one.relay.placeholder]),
							);
							const plan = held.find(one => one.plan);
							const { WLP_TURN_KEY_LEASES: expected = "", ...secrets } = options.secretEnv ?? {};
							const leases = plan ? [plan.relay.placeholder] : Object.values(keys);
							if (leases.sort().join(",") !== expected) throw new Refusal("The turn's provider key leases changed.");
							// A plan pays through its relay on this machine: neither the machine's own sign-in nor a key.
							const credentials = plan
								? { env: MACHINE_HARNESSES[box.harness].planEnv(plan.relay.placeholder) }
								: await o.turnCredentials(box.raw, box.harness, keys);
							if (credentials.close) {
								const end = credentials.close;
								let closed: Promise<void> | undefined;
								const close = () =>
									(closed ??= end().catch(() => {
										audit(this.session, id, "turn-login", "cleanup-failed");
									}));
								const untrack = o.trackRelay(id, close);
								closeLogin = () => {
									untrack();
									return close();
								};
							}
							this.requireActive();
							options.secretEnv = { ...secrets, ...credentials.env };
							if (box.harness === "opencode") argv = ["env", "-u", "WLP_SESSION_BEARER", ...argv];
							if (box.harness === "claude")
								argv = [
									"env",
									"-u",
									keys.anthropic && !plan ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY",
									...argv,
								];
						}
						p = h.start(argv, options, op.args.tag);
					} catch (error) {
						await closeLogin?.();
						if (acp) o.turnEnded(box);
						throw error;
					}
					this.processes.set(op.id, { p, acp, handle: h, id, closeLogin });
					box.busy++;
					// start() returns synchronously. Answer in this stack, before any pipe event can run.
					this.channel.respond(op, null);
					void p.ended.then(async end => {
						await closeLogin?.();
						box.busy--;
						box.usedAt = Date.now();
						this.processes.delete(op.id);
						if (acp) o.turnEnded(box);
						if (this.active)
							this.channel.end(
								op.id,
								box.harness && end.error ? { ...end, error: new Error(cleanClaudeOutput(end.error.message)) } : end,
							);
					});
					return null;
				}
				case "run": {
					const { exitCode, timedOut, aborted, stdout, stderr } = await h.run(op.args.command, {
						...op.args.options,
						...streams,
						signal: abort!.signal,
					});
					return { exitCode, timedOut, aborted, stdout, stderr };
				}
				case "ask": {
					const answer = await h.ask(op.args.argv, op.args.options);
					return box.harness && answer
						? { ...answer, stdout: cleanClaudeOutput(answer.stdout), stderr: cleanClaudeOutput(answer.stderr) }
						: answer;
				}
				case "memoryEvents":
					return o.memoryEvents ? await readMemoryEvents(h) : null;
				case "blockedNetwork":
					if (!o.blockedNetwork || box.egress !== "restricted")
						throw new Refusal("This sandbox does not report blocked network requests.");
					return await o.network.blocked(box.raw, op.args.turn, op.args.retained);
				case "readTextFile": {
					const text = await h.readTextFile(op.args.path);
					return box.harness ? cleanClaudeOutput(text) : text;
				}
				case "writeTextFile":
				case "writeSecretFile":
					await h[op.name](op.args.path, op.args.content);
					return null;
				case "removeFiles":
					await h.removeFiles(op.args.paths);
					return null;
				case "stopLeftovers":
					return await h.stopLeftovers(op.args.program);
				case "sweep":
					return await h.sweep(op.args.tag, op.args.options);
				case "modelRelay": {
					abort?.signal.throwIfAborted();
					const forward = op.args.forward;
					if (box.harness ? !o.harnessKeyRelays : !o.modelRelayReady)
						throw new Refusal("This sandbox's turns cannot use the model relay.");
					// A plan never goes through the platform from a machine: its relay here sends it (`planRelay`).
					if (forward.provider === "claude-plan" || forward.provider === "chatgpt-plan")
						throw new Refusal("A plan pays through this machine's plan relay, not the platform's.");
					const relay = box.harness
						? await o.openTurnKey(box.raw, box.harness, forward)
						: await o.modelRelay.open(containerName(box.raw), box.raw, undefined, forward);
					if (!this.active || abort?.signal.aborted) {
						await relay.close();
						throw new Refusal("The session conversation ended.");
					}
					const lease = randomBytes(16).toString("hex");
					// A suspend or removal of the sandbox ends it too, and takes it out of this conversation.
					const untrack = o.trackRelay(id, async () => {
						this.relays.delete(lease);
						await relay.close();
					});
					this.relays.set(lease, { operation: op.id, relay, id, untrack, provider: forward.provider });
					return { lease, placeholder: relay.placeholder, env: relay.env };
				}
				case "planRelay": {
					abort?.signal.throwIfAborted();
					const { wire, harness, token, expiresAt, requestLimit } = op.args;
					if ((harness === "windlass") !== !box.harness || (box.harness && harness !== box.harness))
						throw new Refusal("This plan relay is for another agent.");
					const plan = { seen: [] as RelaySeen[] };
					const relay = await o.modelRelay.openPlan(containerName(box.raw), box.raw, token, {
						wire,
						harness,
						expiresAt,
						requestLimit,
						onSeen: seen => {
							plan.seen.push(seen);
							if (plan.seen.length > MAX_PLAN_SEEN) plan.seen.shift();
						},
					});
					if (!this.active || abort?.signal.aborted) {
						await relay.close();
						throw new Refusal("The session conversation ended.");
					}
					const lease = randomBytes(16).toString("hex");
					const untrack = o.trackRelay(id, async () => {
						this.relays.delete(lease);
						await relay.close();
					});
					this.relays.set(lease, { operation: op.id, relay, id, untrack, plan });
					return { lease, placeholder: relay.placeholder, env: relay.env };
				}
				case "planRelayToken": {
					const held = this.relays.get(op.args.lease);
					if (held?.id !== id || !held.plan || !("hand" in held.relay))
						throw new Refusal("This plan relay lease is not this sandbox's, or it has ended.");
					await (held.relay as DockerPlanRelay).hand(op.args.token, op.args.expiresAt);
					return null;
				}
				case "planRelaySeen": {
					const held = this.relays.get(op.args.lease);
					if (held?.id !== id || !held.plan) return [];
					return held.plan.seen.splice(0);
				}
				case "modelRelayClose": {
					const held = this.relays.get(op.args.lease);
					if (held?.id === id) await this.closeRelay(op.args.lease);
					return null;
				}
			}
		} finally {
			box.busy--;
			box.usedAt = Date.now();
		}
	}
	async serve(op: Operation, orphaned: Promise<void>) {
		const abort =
			op.name === "run" || op.name === "modelRelay" || op.name === "planRelay" ? new AbortController() : undefined;
		if (abort) this.runs.set(op.id, abort);
		let id = "id" in op.args && this.owner.boxes.has(op.args.id) ? op.args.id : null;
		let outcome = "done";
		try {
			// Finish the previous turn's tagged cleanup before a new turn writes its token.
			await orphaned;
			if (!this.active) return;
			const value = await this.execute(op, abort);
			if (op.name === "create" && typeof value === "string") id = value;
			if (this.active && op.name !== "start") this.channel.respond(op, value);
		} catch (error) {
			const kind = error instanceof Refusal ? "refused" : error instanceof SandboxUserError ? "user" : "sandbox";
			outcome = kind;
			if (this.active)
				this.channel.refuse(op, {
					kind,
					message: cleanClaudeOutput(error instanceof Error ? error.message : String(error)),
				});
		} finally {
			this.runs.delete(op.id);
			audit(this.session, id, op.name, outcome);
		}
	}
}

export class Session {
	readonly channel: RunnerChannel;
	private conversation: Conversation;
	private socket?: WebSocket;
	refused = false;
	orphaned: Promise<void> = Promise.resolve();
	constructor(
		private id: string,
		private owner: Executor,
		private forget: () => void,
	) {
		this.channel = new RunnerChannel({
			onOperation: op => {
				void this.conversation.serve(op, this.orphaned);
			},
			onInput: (id, data) => this.conversation.input(id, data),
			onCloseIn: id => this.conversation.eof(id),
			onCancel: id => this.conversation.cancel(id),
			onDrain: () => this.conversation.pause(false),
			onReset: () => {
				this.orphaned = this.conversation.orphan();
				this.conversation = new Conversation(this.owner, this.id, this.channel);
				// During a fresh handshake the new socket is already here. After the
				// detached channel's grace, only the orphaned processes need to outlive it.
				void this.orphaned.then(() => {
					if (!this.socket && !this.refused) this.forget();
				});
			},
			onRefused: reason => {
				this.refused = true;
				audit(this.id, null, "session", safeSentence(reason));
				this.channel.close();
			},
		});
		this.conversation = new Conversation(owner, id, this.channel);
	}
	attach(
		ws: WebSocket,
		identity: Pick<Hello, "runnerVersion" | "machineId" | "ticket" | "signature">,
		secure?: SessionTrust,
	) {
		this.socket = ws;
		ws.addEventListener("close", () => {
			if (this.socket === ws) this.socket = undefined;
		});
		const socket: ChannelSocket = {
			send: text => ws.send(text),
			close: () => ws.close(),
			onMessage: fn => ws.addEventListener("message", e => fn(e.data)),
			onClose: fn => ws.addEventListener("close", fn),
		};
		this.channel.attach(socket, identity, secure);
	}
}
