/**
 * A plan's relay inside a hosted sandbox with an address of its own (E2B, Daytona), so the plan's
 * requests leave from there and not from the platform's one address (docs/model-relay.md, "Plan requests
 * from the sandbox"). The program (sandbox/relay/plan.cjs, on the shared relay) runs as the transport user,
 * not as `agent`: the agent cannot read its memory, its standard input or its /proc files, nor signal it.
 * The program's source and the token both arrive on its standard input, so nothing is written to the
 * sandbox's disk and nothing secret is on a command line.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HarnessId, RelaySeen } from "../contract.js";
import { relaySeenOf } from "../credentials/plan-health.js";
import { type KeyWire, wires } from "../../../sandbox/relay/wires.cjs";
import type { KeyTurnRelay, SandboxProcess, StartOptions, TakeRelayRequest } from "./provider.js";

/** The image's Node (sandbox/Dockerfile), by its full path: the transport user's PATH does not name /usr/local/bin. */
export const GUEST_NODE = "/usr/local/bin/node";

const SOURCES = ["server.cjs", "wires.cjs", "windlass.cjs", "plan.cjs"] as const;

/**
 * Reads the first line of standard input (the sources, as JSON), loads them as CommonJS modules from memory
 * and hands the rest of the stream to plan.cjs `main`. No secret is in it: it is the program's argument.
 */
export const PLAN_RELAY_LOADER = `let b="";const d=c=>{b+=c;const i=b.indexOf("\\n");if(i<0){if(b.length>4e6)process.exit(2);return}process.stdin.off("data",d);const s=JSON.parse(b.slice(0,i)),m={};const r=n=>{if(!n.startsWith("./"))return require(n);n=n.slice(2);if(m[n])return m[n].exports;if(!Object.hasOwn(s,n))throw Error("no module "+n);const o=m[n]={exports:{}};new Function("exports","require","module","__filename","__dirname",s[n])(o.exports,r,o,"/wlp-plan-relay/"+n,"/wlp-plan-relay");return o.exports};r("./plan.cjs").main(process.stdin,process.stdout,b.slice(i+1))};process.stdin.setEncoding("utf8");process.stdin.on("data",d)`;

/** How the relay is started, as the transport user (`StartOptions.gitUser`). */
export const PLAN_RELAY_ARGV = [GUEST_NODE, "--max-old-space-size=96", "-e", PLAN_RELAY_LOADER];

declare const PLAN_RELAY_SOURCES: string;
let sources: string | undefined;
/** The relay's modules as one JSON line, read once from sandbox/relay (the runner's bundle carries them). */
export function planRelaySources(): string {
	if (typeof PLAN_RELAY_SOURCES === "string") return PLAN_RELAY_SOURCES;
	sources ??= JSON.stringify(
		Object.fromEntries(
			SOURCES.map(name => [name, readFileSync(new URL(`../../../sandbox/relay/${name}`, import.meta.url), "utf8")]),
		),
	);
	return sources;
}

/** A relay in the sandbox: the env and placeholder of a key lease, and the token it sends can be replaced. */
export interface LocalModelRelay extends KeyTurnRelay {
	/**
	 * Replaces the token; requests that start once this resolved carry the new one, those running keep theirs. With
	 * `expiresAt`, the relay stops by itself then instead (a turn taken up after a restart has a new window).
	 */
	hand(token: string, expiresAt?: number): Promise<void>;
}

/** What a turn asks of `TurnSandbox.localPlanRelay`: the plan's wire, the agent whose routes it allows, the turn's limits. */
export interface LocalPlanRelayOptions {
	/** The plan's wire (`credentialWire`): plan.cjs refuses any but a plan's. */
	wire: KeyWire;
	harness: HarnessId;
	signal?: AbortSignal;
	takeRequest?: TakeRelayRequest;
	/** What the provider said of the plan's health, as the relay saw it (credentials/plan-health.ts). */
	onSeen?: (seen: RelaySeen) => void;
}

export interface PlanRelayOptions extends LocalPlanRelayOptions {
	/** When the relay stops by itself, whatever the platform does: a server that died mid-turn leaves no token behind past it. */
	expiresAt: number;
	/** Without `takeRequest`, the relay counts this many requests itself here. */
	requestLimit?: number;
	/** The relay's checks only: where it sends requests in place of the wire's API host. */
	upstream?: string;
	/** A Unix socket to listen on instead of a loopback port (a machine's relay behind the turn's forwarder, plan.cjs `SOCKET`). */
	socket?: string;
	startMs?: number;
}

const START_MS = 20_000;

/** A fresh bearer for one turn, in the relay's format (plan.cjs `PLACEHOLDER`). */
export function planPlaceholder(): string {
	return `wlp-plan.${randomBytes(32).toString("base64url")}`;
}

/**
 * Starts the relay with `start` as the transport user and hands it the token. Rejects, with the relay
 * stopped, when it does not listen in time: the turn fails rather than put the token in the sandbox.
 */
export async function startPlanRelay(
	start: (argv: string[], options: StartOptions) => SandboxProcess,
	token: string,
	options: PlanRelayOptions,
): Promise<LocalModelRelay> {
	options.signal?.throwIfAborted();
	const placeholder = planPlaceholder();
	let remaining = options.requestLimit;
	let stdout = "";
	let stderr = "";
	let ready: (port: number) => void = () => {};
	const listening = new Promise<number>(resolve => (ready = resolve));
	const handed: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
	let proc: SandboxProcess | undefined = undefined;
	const answerCount = async (id: number) => {
		let ok: boolean;
		try {
			if (options.takeRequest) ok = await options.takeRequest();
			else if (remaining === undefined) ok = true;
			else {
				ok = remaining > 0;
				if (ok) remaining -= 1;
			}
		} catch {
			ok = false;
		}
		proc?.write(`${JSON.stringify({ took: id, ok })}\n`);
	};
	const line = (text: string) => {
		let said: unknown;
		try {
			said = JSON.parse(text);
		} catch {
			return;
		}
		if (!said || typeof said !== "object") return;
		const fields = said as Record<string, unknown>;
		if (Number.isSafeInteger(fields.listening)) ready(fields.listening as number);
		else if (Number.isSafeInteger(fields.take)) void answerCount(fields.take as number);
		else if (fields.handed === true) handed.shift()?.resolve();
		else if (fields.seen !== undefined) {
			const seen = relaySeenOf(fields.seen);
			if (seen) options.onSeen?.(seen);
		}
	};
	proc = start(PLAN_RELAY_ARGV, {
		gitUser: true,
		onStdout: chunk => {
			stdout += chunk;
			let end: number;
			while ((end = stdout.indexOf("\n")) >= 0) {
				line(stdout.slice(0, end));
				stdout = stdout.slice(end + 1);
			}
			if (stdout.length > 65_536) stdout = "";
		},
		onStderr: chunk => {
			stderr = (stderr + chunk).slice(-2000);
		},
	});
	const running = proc;
	void running.ended.then(() => {
		for (const waiter of handed.splice(0)) waiter.reject(new Error("This relay has ended."));
	});
	let closing: Promise<void> | undefined;
	const close = () =>
		(closing ??= (async () => {
			options.signal?.removeEventListener("abort", onAbort);
			running.closeStdin();
			const gone = (ms: number) =>
				Promise.race([running.ended.then(() => true), new Promise<false>(r => setTimeout(() => r(false), ms))]);
			if (!(await gone(1000))) {
				await running.signal("KILL", "leader");
				await gone(5000);
			}
			running.killClient();
			for (const waiter of handed.splice(0)) waiter.reject(new Error("This relay has ended."));
		})());
	const onAbort = () => void close();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	running.write(`${planRelaySources()}\n`);
	running.write(
		`${JSON.stringify({ token, placeholder, expiresAt: options.expiresAt, wire: options.wire, harness: options.harness, upstream: options.upstream, socket: options.socket })}\n`,
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const port = await Promise.race([
		listening,
		running.ended.then(end => end),
		new Promise<"timeout">(resolve => (timer = setTimeout(() => resolve("timeout"), options.startMs ?? START_MS))),
		new Promise<"aborted">(resolve => {
			if (options.signal?.aborted) resolve("aborted");
			options.signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
		}),
	]).finally(() => clearTimeout(timer));
	if (typeof port !== "number") {
		await close();
		if (port === "aborted") throw options.signal?.reason ?? new Error("aborted");
		const said = stderr.split(token).join("[redacted]").trim().split("\n").pop() ?? "";
		const why =
			port === "timeout"
				? "it did not start in time"
				: port.error?.message || said || `it exited (${port.code ?? port.signal})`;
		throw new Error(`the plan's relay could not be started in the sandbox: ${why}`);
	}
	const origin = `http://127.0.0.1:${port}`;
	return {
		placeholder,
		// The wire's API base, as the platform relay's: `/v1` for a ChatGPT plan, where Codex and Windlass append their routes.
		env: { WINDLASS_MODEL_BASE_URL: origin + wires[options.wire].base, WINDLASS_MODEL_ALLOWED_ORIGIN: origin },
		hand: async (next, expiresAt) => {
			if (closing || running.hasEnded) throw new Error("This relay has ended.");
			const done = new Promise<void>((resolve, reject) => handed.push({ resolve, reject }));
			running.write(`${JSON.stringify({ token: next, expiresAt })}\n`);
			await done;
		},
		close,
	};
}
