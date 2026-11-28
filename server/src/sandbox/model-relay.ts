/**
 * Each daemon scope has one credential relay. A turn's forwarder shares only the session's network namespace.
 * A request needs both the forwarder's nonce and a live lease. Closing a lease revokes it before removing the forwarder.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LABEL, LABEL_ARG, MACHINE_LABEL, NO_LOGS, RELAY_LOGS, docker } from "./docker.js";
import { type KeyWire, wires } from "../../../sandbox/relay/wires.cjs";
import type { HarnessId, RelaySeen } from "../contract.js";
import { type LocalModelRelay, startPlanRelay } from "./plan-relay.js";
import {
	SECRET_FILE_SCRIPT,
	type ForwardedKeyLease,
	type KeyTurnRelay,
	type KeyReference,
	type ProcessEnd,
	type SandboxProcess,
	type StartOptions,
	type TakeRelayRequest,
} from "./provider.js";

declare const WINDLASS_RELAY_SCRIPT: string;
declare const EGRESS_SOURCE: string;

export const MODEL_RELAY_URL = "http://127.0.0.1:17893/v1";
const ROLE = `${LABEL}.model-relay`;
const VERSION = `${ROLE}-version`;
/** Recover the token filename from the forwarder after its lease owner exits. */
const NONCE_LABEL = `${ROLE}-nonce`;
const TOKENS = "/run/wlp-model/tokens";
/** runner/src/egress-proxy.mjs `MODEL_FORWARD_READY`. */
const FORWARD_READY_DIR = "/run/wlp-model/ready";
const FORWARD_READY = `${FORWARD_READY_DIR}/listening`;
/** The hosted relay's ceiling for the whole deployment, when WLP_MODEL_RELAY_REQUESTS does not name one. */
export const HOSTED_RELAY_REQUESTS = 64;
/** The hosted relay's ceiling per user, the E2B route's (relay-leases.ts `ROUTE_LIMITS.userRequests`). */
export const HOSTED_RELAY_USER_REQUESTS = 16;
export { MODEL_RELAY_WINDLASS } from "../model-relay-url.js";
/** The relay container's memory; scripts/model-relay-docker-check.ts runs 64 streams in it. */
export const RELAY_MEMORY = "192m";
/** The TCP-to-Unix forwarder also buffers data in its sockets during simultaneous uploads. */
const FORWARDER_MEMORY = "128m";
/** A machine's plan relay serves one turn (8 requests in flight, 32 waiting), as one in a microVM does. */
const PLAN_RELAY_MEMORY = "160m";

const root = () => join(import.meta.dirname, "..", "..", "..");
/** Docker embeds the relay sources; the runner uses its bundled copy. */
export function relayScript(): string {
	if (typeof WINDLASS_RELAY_SCRIPT === "string") return WINDLASS_RELAY_SCRIPT;
	const read = (name: string) => readFileSync(join(root(), "sandbox", "relay", name), "utf8");
	return [
		"const __require = require;",
		`const __wires = (() => { const module = { exports: {} }; const exports = module.exports; ${read("wires.cjs")}\n; return module.exports; })();`,
		`const __server = (() => { const module = { exports: {} }; const exports = module.exports; ${read("server.cjs")}\n; return module.exports; })();`,
		`(() => { const module = { exports: {} }; const exports = module.exports; const require = (id) => id === "./server.cjs" ? __server : id === "./wires.cjs" ? __wires : __require(id); ${read("windlass.cjs")}\n})();`,
	].join("\n");
}
function forwarderScript(): string {
	return typeof EGRESS_SOURCE === "string"
		? EGRESS_SOURCE
		: readFileSync(join(root(), "runner", "src", "egress-proxy.mjs"), "utf8");
}

const READY = `
const net = require("node:net");
const { existsSync } = require("node:fs");
const deadline = Date.now() + 8000;
const address = process.argv[1].startsWith("/") ? { path: process.argv[1] } : { host: "127.0.0.1", port: Number(process.argv[1]) };
const marker = process.argv[2];
function probe() {
	if (marker && !existsSync(marker)) return retry();
	const socket = net.connect(address);
	socket.once("connect", () => socket.end());
	socket.on("error", retry);
}
function retry() { if (Date.now() >= deadline) process.exit(1); setTimeout(probe, 50); }
probe();`;
/** Probe inside the helper namespace. A marker also proves which process owns the listener. */
async function waitForListener(id: string, address: string, marker?: string): Promise<void> {
	const result = await docker(["exec", id, "node", "-e", READY, address, ...(marker ? [marker] : [])], {
		timeoutMs: 15_000,
	});
	if (result.code !== 0)
		throw new Error(
			`the model relay helper did not start listening (${result.stderr.trim() || `exit ${result.code}`})`,
		);
}

export interface DockerModelRelayOptions {
	forwardKeyLease?: typeof import("./relay-leases.js").forwardKeyLease;
	/** The machine id of a runner's relay; "" for the hosted server's. Every container and volume carries it as MACHINE_LABEL. */
	machine: string;
	/** The pinned base image: it has node, and the agent user. */
	image: string;
	/** More labels for every container and volume (a runner's pairing). */
	labelFlags?: string[];
	/** The relay's ceiling of requests in flight for its whole scope (`limits.machineRequests`). */
	requests?: number;
	/** Its ceiling per user (`limits.userRequests`): the hosted relay serves every user of the deployment. None on a machine, which serves one. */
	userRequests?: number;
	/** Called before a container is made, so that the image is there. */
	ensureImage?: () => Promise<void>;
	/** Isolate the hosted relay’s Docker names when testing multiple deployments on one daemon. */
	nameScope?: string;
	/** The relay's own checks: another network than the bridge, an upstream other than api.openai.com, other caps. */
	network?: string;
	upstream?: string;
	limits?: Record<string, number>;
}

export interface DockerKeyRelay extends KeyTurnRelay {
	/** The turn's nonce: what its forwarder writes, and its token file's name in the relay. */
	readonly nonce: string;
}

/** A machine's plan relay for one turn: its token can be replaced (`hand`), and it ends with `close`. */
export type DockerPlanRelay = DockerKeyRelay & Pick<LocalModelRelay, "hand">;

/** `docker <args>` as a process whose standard input stays open: a plan relay's control channel. */
function dockerProcess(args: string[], name: string, options: StartOptions): SandboxProcess {
	const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => options.onStdout?.(chunk));
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => options.onStderr?.(chunk));
	child.stdin.on("error", () => {});
	let hasEnded = false;
	const ended = new Promise<ProcessEnd>(resolve => {
		child.on("error", error => {
			hasEnded = true;
			resolve({ code: null, signal: null, error });
		});
		child.on("close", (code, signal) => {
			hasEnded = true;
			resolve({ code, signal, error: null });
		});
	});
	return {
		tag: name,
		write: text => !hasEnded && child.stdin.writable && child.stdin.write(text),
		closeStdin: () => child.stdin.end(),
		ended,
		get hasEnded() {
			return hasEnded;
		},
		signal: async () => {
			await docker(["rm", "-f", name], { timeoutMs: 30_000 }).catch(() => undefined);
		},
		killClient: () => child.kill("SIGKILL"),
	};
}

export class DockerModelRelay {
	private readonly suffix: string;
	private ensuring: Promise<string> | null = null;
	private readonly openLeases = new Map<string, DockerKeyRelay>();

	constructor(private readonly options: DockerModelRelayOptions) {
		if (options.machine !== "" && !/^[A-Za-z0-9_-]+$/.test(options.machine)) throw new Error("invalid machine id");
		const scope = options.nameScope ?? options.machine;
		this.suffix = scope ? `-${scope}` : "";
	}

	get relayName(): string {
		return `wlp-model-relay${this.suffix}`;
	}
	get socketVolume(): string {
		return `wlp-model-socket${this.suffix}`;
	}
	forwarderName(sandbox: string): string {
		if (!/^[A-Za-z0-9_-]+$/.test(sandbox)) throw new Error("invalid sandbox id");
		return `wlp-model-fwd-${sandbox}`;
	}

	planRelayName(sandbox: string): string {
		if (!/^[A-Za-z0-9_-]+$/.test(sandbox)) throw new Error("invalid sandbox id");
		return `wlp-plan-relay-${sandbox}`;
	}

	private labels(role: "relay" | "forward" | "socket" | "plan"): string[] {
		return [
			"--label",
			LABEL_ARG,
			...(this.options.machine ? ["--label", `${MACHINE_LABEL}=${this.options.machine}`] : []),
			...(this.options.labelFlags ?? []),
			"--label",
			`${ROLE}=${role}`,
		];
	}

	/** Names can collide. Verify every ownership label before touching a container or volume. */
	private owned(labels: Record<string, string> | null | undefined, role: string): boolean {
		if (labels?.[LABEL] !== "1" || labels[ROLE] !== role || (labels[MACHINE_LABEL] ?? "") !== this.options.machine)
			return false;
		const extra = this.options.labelFlags ?? [];
		for (let i = 0; i + 1 < extra.length; i += 2) {
			const at = extra[i + 1].indexOf("=");
			const [key, value] = at < 0 ? [extra[i + 1], ""] : [extra[i + 1].slice(0, at), extra[i + 1].slice(at + 1)];
			if (labels[key] !== value) return false;
		}
		return true;
	}

	private async inspect(
		name: string,
	): Promise<{ id: string; running: boolean; labels: Record<string, string> } | null> {
		const result = await docker(
			["container", "inspect", "--format", "{{.Id}}|{{.State.Running}}|{{json .Config.Labels}}", name],
			{ timeoutMs: 15_000 },
		);
		if (result.code !== 0) {
			if (/no such (container|object)/i.test(result.stderr)) return null;
			throw new Error("Docker could not inspect the model relay.");
		}
		const [id, running, json] = result.stdout.trim().split("|");
		return { id, running: running === "true", labels: JSON.parse(json || "{}") ?? {} };
	}

	private get logOptions(): string[] {
		return this.options.machine ? RELAY_LOGS : NO_LOGS;
	}

	private version(): string {
		const { image, requests, userRequests, network, upstream, limits } = this.options;
		return createHash("sha256")
			.update(relayScript())
			.update(
				JSON.stringify([
					image,
					requests ?? null,
					userRequests ?? null,
					network ?? null,
					upstream ?? null,
					limits ?? null,
					RELAY_MEMORY,
					this.logOptions,
				]),
			)
			.digest("hex");
	}

	/** Concurrent callers share a single startup attempt. */
	ensure(): Promise<string> {
		this.ensuring ??= this.ensureOnce().finally(() => (this.ensuring = null));
		return this.ensuring;
	}

	private async ensureOnce(): Promise<string> {
		const version = this.version();
		let box = await this.inspect(this.relayName);
		if (box && !this.owned(box.labels, "relay"))
			throw new Error("The model relay's container name belongs to another container.");
		if (box && (box.labels[VERSION] !== version || !box.running)) {
			// Another program or a stopped one: its tokens went with its tmpfs. Turns that used it get a 401 and end.
			await docker(["rm", "-f", box.id], { timeoutMs: 30_000, check: true });
			box = null;
		}
		if (box) return box.id;
		await this.options.ensureImage?.();
		await this.ensureVolume();
		const limits = {
			...(this.options.limits ?? {}),
			...(this.options.requests ? { machineRequests: this.options.requests } : {}),
			...(this.options.userRequests ? { userRequests: this.options.userRequests } : {}),
		};
		const run = await docker(
			[
				"run",
				"-d",
				"--pull",
				"never",
				"--name",
				this.relayName,
				...this.labels("relay"),
				"--label",
				`${VERSION}=${version}`,
				"--user",
				"1000:1000",
				"--read-only",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				...this.logOptions,
				"--memory",
				RELAY_MEMORY,
				"--pids-limit",
				"48",
				"--restart",
				"no",
				"--network",
				this.options.network ?? "bridge",
				"--mount",
				`type=volume,src=${this.socketVolume},dst=/workspace`,
				"--tmpfs",
				`${TOKENS}:rw,noexec,nosuid,nodev,mode=0700,uid=1000,gid=1000,size=4m`,
				"-e",
				"WLP_MODEL_RELAY_PROGRAM=1",
				...(this.options.machine ? ["-e", "WLP_MODEL_RELAY_MACHINE=" + this.options.machine] : []),
				...(Object.keys(limits).length ? ["-e", `WLP_MODEL_RELAY_LIMITS=${JSON.stringify(limits)}`] : []),
				...(this.options.upstream ? ["-e", `WLP_MODEL_RELAY_UPSTREAM=${this.options.upstream}`] : []),
				this.options.image,
				"node",
				"-e",
				relayScript(),
			],
			{ timeoutMs: 120_000 },
		);
		if (run.code !== 0) {
			// Another server process made it at the same moment: use that one when it is this program.
			const other = await this.inspect(this.relayName);
			if (other && this.owned(other.labels, "relay") && other.labels[VERSION] === version && other.running)
				return other.id;
			throw new Error(`could not start the model relay: ${run.stderr.trim() || `exit ${run.code}`}`);
		}
		const id = run.stdout.trim();
		try {
			await waitForListener(id, "/workspace/relay.sock");
		} catch (error) {
			await docker(["rm", "-f", id], { timeoutMs: 30_000 });
			throw error;
		}
		return id;
	}

	private async ensureVolume(): Promise<void> {
		const inspected = await docker(["volume", "inspect", "--format", "{{json .Labels}}", this.socketVolume], {
			timeoutMs: 15_000,
		});
		if (inspected.code === 0) {
			if (!this.owned(JSON.parse(inspected.stdout.trim() || "{}"), "socket"))
				throw new Error("The model relay's socket volume belongs to someone else.");
			return;
		}
		const made = await docker(["volume", "create", ...this.labels("socket"), this.socketVolume], { timeoutMs: 30_000 });
		if (made.code !== 0 && (await docker(["volume", "inspect", this.socketVolume], { timeoutMs: 15_000 })).code !== 0)
			throw new Error(`could not create the model relay's socket volume: ${made.stderr.trim()}`);
	}

	openKey(
		container: string,
		sandbox: string,
		uid: string,
		sessionId: string,
		key: KeyReference,
		signal?: AbortSignal,
		takeRequest?: TakeRelayRequest,
	) {
		if (!this.options.forwardKeyLease) throw new Error("A saved provider key requires a platform model relay.");
		return this.options.forwardKeyLease(
			uid,
			sessionId,
			key,
			this.options.machine || undefined,
			forward => this.open(container, sandbox, uid, forward),
			signal,
			takeRequest,
		);
	}

	/** A Settings key's lease for one turn: the turn's forwarder first, then the forwarded lease in the relay. */
	async open(
		container: string,
		sandbox: string,
		user: string | undefined,
		forward: ForwardedKeyLease,
	): Promise<DockerKeyRelay> {
		const relay = await this.ensure();
		const nonce = randomBytes(16).toString("hex");
		const placeholder = `wlp-model.${randomBytes(16).toString("hex")}`;
		await this.endSandbox(sandbox);
		const id = await this.startForwarder(container, sandbox, nonce);
		const file = `${TOKENS}/${nonce}.json`;
		const lease: DockerKeyRelay = {
			nonce,
			placeholder,
			env: { WINDLASS_MODEL_BASE_URL: new URL(MODEL_RELAY_URL).origin + wires[forward.provider].base },
			// The file first: the relay then stops the turn's requests still running, and the forwarder's removal ends its connections.
			close: async () => {
				if (this.openLeases.get(sandbox) === lease) this.openLeases.delete(sandbox);
				await this.removeFiles(relay, [nonce]);
				await docker(["rm", "-f", id], { timeoutMs: 30_000 }).catch(() => undefined);
			},
		};
		try {
			const content = JSON.stringify({ forward, expiresAt: forward.expiresAt, lease: placeholder, user });
			const result = await docker(
				["exec", "-i", "-u", "1000:1000", relay, "sh", "-c", SECRET_FILE_SCRIPT, "sh", file],
				{ stdin: content, timeoutMs: 30_000 },
			);
			if (result.code !== 0) throw new Error("Could not write the turn's model relay lease.");
		} catch (error) {
			await lease.close();
			throw error;
		}
		this.openLeases.set(sandbox, lease);
		return lease;
	}

	/** The turn's forwarder in the session's network namespace, on 127.0.0.1:17893: to the relay, or to a plan relay's own socket. */
	private async startForwarder(container: string, sandbox: string, nonce: string, socket?: string): Promise<string> {
		const name = this.forwarderName(sandbox);
		const started = await docker(
			[
				"run",
				"-d",
				"--pull",
				"never",
				"--name",
				name,
				...this.labels("forward"),
				"--label",
				`${NONCE_LABEL}=${nonce}`,
				"--network",
				`container:${container}`,
				"--user",
				"agent",
				"--cap-drop",
				"ALL",
				"--read-only",
				"--security-opt",
				"no-new-privileges",
				"--pids-limit",
				"32",
				"--memory",
				FORWARDER_MEMORY,
				"--cpus",
				"0.25",
				"--restart",
				"no",
				...NO_LOGS,
				"--mount",
				`type=volume,src=${this.socketVolume},dst=/run/wlp-model/socket,readonly,volume-nocopy`,
				"--tmpfs",
				`${FORWARD_READY_DIR}:rw,noexec,nosuid,nodev,mode=0700,uid=1000,gid=1000,size=16k`,
				this.options.image,
				"node",
				"--input-type=module",
				"-e",
				forwarderScript(),
				"--",
				"wlp-model-forward",
				nonce,
				...(socket ? [socket] : []),
			],
			{ timeoutMs: 60_000 },
		);
		if (started.code !== 0)
			throw new Error(
				`could not start the model relay's forwarder: ${started.stderr.trim() || `exit ${started.code}`}`,
			);
		const id = started.stdout.trim();
		try {
			await waitForListener(id, "17893", FORWARD_READY);
			// Require the forwarder's own readiness marker: a session process might hold the port.
			const box = await this.inspect(id);
			if (!box?.running)
				throw new Error(
					"the model relay's forwarder could not take 127.0.0.1:17893 in the session: a process in the sandbox may be holding that port. Stop it, or send the prompt again",
				);
		} catch (error) {
			await docker(["rm", "-f", id], { timeoutMs: 30_000 });
			if (error instanceof Error && /did not start listening/.test(error.message))
				throw new Error(
					`the model relay's forwarder did not start listening on 127.0.0.1:17893 in the session (a process in the sandbox may be holding that port): ${error.message}`,
				);
			throw error;
		}
		return id;
	}

	/**
	 * A plan-paid turn's relay on a paired machine (`plan-relay`): sandbox/relay/plan.cjs in a container of its own on
	 * the bridge, so the plan's requests leave from the machine. The program and the token reach it on its standard
	 * input, which this process holds: it keeps the token in memory only, never in a file, and ends when its input
	 * closes (the turn's end, or this process's). It listens on a socket of its own in the socket volume, behind the
	 * turn's forwarder, which the agent reaches on 127.0.0.1:17893 as Windlass reaches the model relay.
	 */
	async openPlan(
		container: string,
		sandbox: string,
		token: string,
		options: {
			wire: KeyWire;
			harness: HarnessId;
			expiresAt: number;
			/** The most model requests it sends: the turn's (`PlanRelayOptions.requestLimit`). */
			requestLimit: number;
			onSeen?: (seen: RelaySeen) => void;
		},
	): Promise<DockerPlanRelay> {
		await this.options.ensureImage?.();
		await this.ensureVolume();
		await this.endSandbox(sandbox);
		const nonce = randomBytes(16).toString("hex");
		const socket = `plan-${nonce}.sock`;
		const name = this.planRelayName(sandbox);
		await docker(["rm", "-f", name], { timeoutMs: 30_000 }).catch(() => undefined);
		const relay = await startPlanRelay(
			(argv, start) =>
				dockerProcess(
					[
						"run",
						"-i",
						"--rm",
						"--pull",
						"never",
						"--name",
						name,
						...this.labels("plan"),
						"--label",
						`${NONCE_LABEL}=${nonce}`,
						"--user",
						"1000:1000",
						"--read-only",
						"--cap-drop",
						"ALL",
						"--security-opt",
						"no-new-privileges",
						...NO_LOGS,
						"--memory",
						PLAN_RELAY_MEMORY,
						"--pids-limit",
						"32",
						"--network",
						this.options.network ?? "bridge",
						"--mount",
						// As the relay mounts it: a new volume takes the image's /workspace, which uid 1000 owns.
						`type=volume,src=${this.socketVolume},dst=/workspace`,
						this.options.image,
						...argv,
					],
					name,
					start,
				),
			token,
			{
				wire: options.wire,
				harness: options.harness,
				expiresAt: options.expiresAt,
				requestLimit: options.requestLimit,
				socket: `/workspace/${socket}`,
				upstream: this.options.upstream,
				onSeen: options.onSeen,
			},
		);
		let forwarder: string;
		try {
			forwarder = await this.startForwarder(container, sandbox, nonce, socket);
		} catch (error) {
			await relay.close();
			throw error;
		}
		const lease: DockerPlanRelay = {
			nonce,
			placeholder: relay.placeholder,
			env: { WINDLASS_MODEL_BASE_URL: new URL(MODEL_RELAY_URL).origin + wires[options.wire].base },
			hand: (token, expiresAt) => relay.hand(token, expiresAt),
			close: async () => {
				if (this.openLeases.get(sandbox) === lease) this.openLeases.delete(sandbox);
				await relay.close();
				await docker(["rm", "-f", forwarder], { timeoutMs: 30_000 }).catch(() => undefined);
				await docker(["rm", "-f", name], { timeoutMs: 30_000 }).catch(() => undefined);
			},
		};
		this.openLeases.set(sandbox, lease);
		return lease;
	}

	/** Removes the files of these nonces from the relay's tmpfs. Never rejects. */
	private async removeFiles(relay: string, nonces: string[]): Promise<void> {
		const paths = nonces
			.filter(n => /^[a-f0-9]{32}$/.test(n))
			.flatMap(n => [`${TOKENS}/${n}.json`, `${TOKENS}/${n}.json.tmp`]);
		if (paths.length)
			await docker(["exec", "-u", "1000:1000", relay, "rm", "-f", "--", ...paths], { timeoutMs: 15_000 }).catch(
				() => undefined,
			);
	}

	/** The forwarder's nonce lets us revoke the lease even if its owner has exited. */
	async endSandbox(sandbox: string): Promise<void> {
		const held = this.openLeases.get(sandbox);
		if (held) await held.close();
		const plan = await this.inspect(this.planRelayName(sandbox)).catch(() => null);
		if (plan && this.owned(plan.labels, "plan")) await docker(["rm", "-f", plan.id], { timeoutMs: 30_000 });
		const box = await this.inspect(this.forwarderName(sandbox)).catch(() => null);
		if (!box || !this.owned(box.labels, "forward")) return;
		const relay = await this.inspect(this.relayName).catch(() => null);
		const nonce = box.labels[NONCE_LABEL];
		if (relay?.running && this.owned(relay.labels, "relay") && nonce) await this.removeFiles(relay.id, [nonce]);
		await docker(["rm", "-f", box.id], { timeoutMs: 30_000 });
	}

	/** One process owns each daemon scope. Keep its live leases when clearing orphaned files and forwarders. */
	async sweep(): Promise<number> {
		let removed = 0;
		for (const role of ["forward", "plan"] as const) {
			const listed = await docker(["ps", "-aq", "--no-trunc", "--filter", `label=${ROLE}=${role}`], {
				timeoutMs: 15_000,
			});
			for (const id of listed.code === 0 ? listed.stdout.split(/\s+/).filter(Boolean) : []) {
				const box = await this.inspect(id).catch(() => null);
				if (
					!box ||
					!this.owned(box.labels, role) ||
					[...this.openLeases.values()].some(lease => lease.nonce === box.labels[NONCE_LABEL])
				)
					continue;
				if ((await docker(["rm", "-f", box.id], { timeoutMs: 30_000 })).code === 0) removed += 1;
			}
		}
		const relay = await this.inspect(this.relayName).catch(() => null);
		if (relay?.running && this.owned(relay.labels, "relay")) {
			const live = [...this.openLeases.values()].map(lease => `${lease.nonce}.json`);
			// Every file but those of the leases this process holds now.
			const script = `cd ${TOKENS} && for f in *; do [ -e "$f" ] || continue; case " $* " in *" $f "*) ;; *) rm -f -- "$f" ;; esac; done`;
			await docker(["exec", "-u", "1000:1000", relay.id, "sh", "-c", script, "sh", ...live], {
				timeoutMs: 30_000,
			}).catch(() => undefined);
			// A plan relay that was killed left its socket behind.
			const sockets = [...this.openLeases.values()].map(lease => `plan-${lease.nonce}.sock`);
			const plans = `cd /workspace && for f in plan-*.sock; do [ -e "$f" ] || continue; case " $* " in *" $f "*) ;; *) rm -f -- "$f" ;; esac; done`;
			await docker(["exec", "-u", "1000:1000", relay.id, "sh", "-c", plans, "sh", ...sockets], {
				timeoutMs: 30_000,
			}).catch(() => undefined);
		}
		return removed;
	}
}
