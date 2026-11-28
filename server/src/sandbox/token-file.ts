/**
 * A Windlass turn's token file and a plan's token in a turn's relay. Windlass reads its bearer from an access token
 * file (`WINDLASS_ACCESS_TOKEN_FILE`): on the ChatGPT plan that file holds only the plan relay's placeholder for the
 * turn (`writePlanPlaceholder`), in Docker's per-container /dev/shm tmpfs or Windlass's data directory on a microVM's
 * private disk, which bubblewrap hides from sandboxed commands. The plan's token itself goes to a relay the agent
 * cannot read (`openModelKeyRelay`): inside the sandbox on E2B and Daytona, in a container on a paired machine, or the
 * platform's relay hosted. A token that expires (a ChatGPT plan's) is handed again before it runs out, and a plan that
 * was removed, reconnected or turned off closes the relay within a minute (`rotatePlanToken`). No sandbox, hosted or
 * on a machine, is ever handed an access token itself.
 */

import { SandboxUserError } from "./api.js";
import { TOKEN_REPLACE_LEAD_MS, TOKEN_REPLACE_RETRY_MS, tokenFileContent } from "./handoff.js";
import { MODEL_RELAY_WINDLASS, readsModelRelay, SETTINGS_KEY_WINDLASS } from "../model-relay-url.js";
import { DATA_DIR, type KeyReference, type KeyTurnRelay, type TakeRelayRequest, type TurnSandbox } from "./provider.js";
import { errorText } from "../util.js";
import { credentialWire } from "../../../sandbox/relay/wires.cjs";
import type { PlanSecret } from "../credentials/transit.js";
import type { LocalModelRelay, LocalPlanRelayOptions } from "./plan-relay.js";

/** Prefix used by both providers and for cleaning pre-upgrade volumes. */
export const TOKEN_FILE_PREFIX = "access-token-";

/** Docker mounts this tmpfs privately. Bubblewrap replaces /dev inside agent commands. */
const DOCKER_TOKEN_DIR = "/dev/shm";

export function tokenFilePath(
	sandboxId: string,
	directory: typeof DATA_DIR | typeof DOCKER_TOKEN_DIR = DOCKER_TOKEN_DIR,
): string {
	if (!/^[A-Za-z0-9_-]+$/.test(sandboxId)) throw new Error("invalid sandbox id");
	return `${directory}/${TOKEN_FILE_PREFIX}${sandboxId}.json`;
}

/** Where a turn's token file goes in this sandbox: Docker's private tmpfs, or Windlass's data directory on a microVM's private disk. */
export function turnTokenFilePath(sandbox: Pick<TurnSandbox, "id" | "profile">): string {
	const hosted = sandbox.profile === "daytona" || sandbox.profile.startsWith("e2b");
	return tokenFilePath(sandbox.id, hosted ? DATA_DIR : DOCKER_TOKEN_DIR);
}

/** How often a turn's relay in a sandbox or on a machine looks whether its plan is still the one it pays with. */
export const PLAN_CHECK_MS = 60_000;

export interface RotateOptions {
	/** How much the token in the relay has left when it is replaced. Default `TOKEN_REPLACE_LEAD_MS`; checks change it. */
	leadMs?: number;
	/** How long after a failed replacement the next is tried, and the least time between two. Default `TOKEN_REPLACE_RETRY_MS`. */
	retryMs?: number;
	/** The most time between two looks at the plan, also for a token that never expires (a setup token). Default `PLAN_CHECK_MS`. */
	checkMs?: number;
	/** Where the log lines go: `[wlp] plan_token.gone`, `plan_token.replace_failed`. Default the console. They never contain a token. */
	log?: (line: string) => void;
}

/** The turn's relay or its file could not be had in the sandbox: the sandbox's failure, not the plan's. */
export class TokenFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TokenFileError";
	}
}

/**
 * Settings-key turns get only a relay address and placeholder. A plan on a sandbox with an address of its own
 * gets the relay inside it (`TurnSandbox.localPlanRelay`), so the plan's requests leave from there; the token,
 * opened here for this turn, goes to that relay and nowhere the agent can read, which then follows the plan
 * (`rotatePlanToken`). Elsewhere (hosted Docker) a plan goes through the platform relay like a key, which resolves the
 * plan's current token at every request.
 */
export async function openModelKeyRelay(
	sandbox: TurnSandbox,
	sessionId: string,
	key: KeyReference,
	signal?: AbortSignal,
	takeRequest?: TakeRelayRequest,
	openSecret?: () => Promise<PlanSecret | null>,
	onSeen?: LocalPlanRelayOptions["onSeen"],
): Promise<KeyTurnRelay> {
	if (key.harness === "windlass") {
		if (!key.plan && sandbox.windlassKeyProblem) throw new TokenFileError(sandbox.windlassKeyProblem);
		// A connected runner or restored snapshot can have an older binary than its current image.
		const minimum = key.plan ? MODEL_RELAY_WINDLASS : SETTINGS_KEY_WINDLASS;
		const version = await sandbox.ask(["windlass", "--version"], { timeoutMs: 10_000 });
		if (version?.code !== 0 || !readsModelRelay(/^Windlass\s+(\S+)/.exec(version.stdout.trim())?.[1], minimum))
			throw new TokenFileError(
				`Windlass needs ${minimum} to use ${key.plan ? "your ChatGPT plan" : "Settings keys"} in this sandbox.`,
			);
		signal?.throwIfAborted();
	}
	if (key.plan && sandbox.localPlanRelay) {
		if (!openSecret) throw new Error("A plan turn on this sandbox needs its secret opened for the turn.");
		const opened = await openSecret();
		signal?.throwIfAborted();
		if (!opened)
			throw new SandboxUserError(
				"The plan for this turn changed, was removed, or its sign-in is no longer accepted. Reconnect it if needed, then send the prompt again.",
			);
		const relay = await sandbox.localPlanRelay(opened.secret, {
			signal,
			takeRequest,
			wire: credentialWire(key),
			harness: key.harness,
			onSeen,
		});
		return rotatePlanToken(relay, opened.expiresAt, openSecret);
	}
	if (!sandbox.modelKeyRelay)
		throw new TokenFileError(
			key.plan
				? "A plan requires the platform's model relay (WLP_MODEL_RELAY_URL) for this sandbox."
				: "A saved provider key requires a model relay for this sandbox.",
		);
	return sandbox.modelKeyRelay(sessionId, key, signal, takeRequest);
}

/**
 * Windlass on the ChatGPT plan reads its bearer from an access token file, as it reads a handed-in token: the file
 * holds the plan relay's placeholder for this turn, with an expiry past the turn's end (Windlass refuses an expired
 * one before it sends anything). The relay ends the placeholder with the turn, whatever the file says.
 */
export async function writePlanPlaceholder(
	sandbox: TurnSandbox,
	path: string,
	placeholder: string,
	expiresAt: number,
): Promise<void> {
	await sandbox
		.writeSecretFile(path, tokenFileContent({ accessToken: placeholder, expiresAt }))
		.catch((error: unknown) => {
			throw new TokenFileError(errorText(error));
		});
}

/** When a token is replaced: once it has `leadMs` left, or, one that has no more than that already, once half of what it has is gone. */
function replaceAtOf(expiresAt: number, leadMs: number, now = Date.now()): number {
	const left = Math.max(0, expiresAt - now);
	return expiresAt - (left > leadMs ? leadMs : left / 2);
}

/**
 * Keeps the turn's relay in a sandbox or on a machine on the plan it pays with. An expiring token (`expiresAt`, a
 * ChatGPT plan's) is replaced on a token file's schedule: the token handed at the start has at least twenty minutes
 * left (the sign-in holder's promise), and when it has ten left `open` asks for the current one, which the holder
 * refreshes, and the relay is handed it. A try that fails is tried again every `retryMs`. Between replacements, and for
 * a token that never expires (a setup token), the plan is looked at every `checkMs`: one that was reconnected, removed
 * or turned off (`WLP_PLAN_USERS`) gives no token, and the relay is closed, so the turn's requests stop.
 */
export function rotatePlanToken(
	relay: LocalModelRelay,
	expiresAt: number | undefined,
	open: () => Promise<PlanSecret | null>,
	options: RotateOptions = {},
): KeyTurnRelay {
	const leadMs = options.leadMs ?? TOKEN_REPLACE_LEAD_MS;
	const retryMs = options.retryMs ?? TOKEN_REPLACE_RETRY_MS;
	const checkMs = options.checkMs ?? PLAN_CHECK_MS;
	const log = options.log ?? (line => console.warn(line));
	let current = expiresAt;
	/** Until the next look: the next check, or the replacement if that is sooner. */
	const nextIn = () =>
		current === undefined ? checkMs : Math.max(retryMs, Math.min(checkMs, replaceAtOf(current, leadMs) - Date.now()));
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const schedule = (inMs: number) => {
		if (stopped) return;
		timer = setTimeout(() => void replace(), inMs);
		timer.unref?.();
	};
	const replace = async () => {
		try {
			const next = await open();
			if (stopped) return;
			if (!next) {
				stopped = true;
				log("[wlp] plan_token.gone: the plan changed, was removed or is off for this user; its relay is closed");
				await relay.close();
				return;
			}
			if (next.expiresAt === undefined || next.expiresAt === current) {
				// Nothing newer: a token that never expires, or one the holder still reuses (looked at again soon once due).
				const due = current !== undefined && replaceAtOf(current, leadMs) <= Date.now();
				return schedule(due ? retryMs : nextIn());
			}
			await relay.hand(next.secret);
			current = next.expiresAt;
			schedule(nextIn());
		} catch (error) {
			if (stopped) return;
			log(
				`[wlp] plan_token.replace_failed: ${errorText(error).replace(/\s+/g, " ").trim()}; trying again in ${Math.round(retryMs / 1000)} s`,
			);
			schedule(retryMs);
		}
	};
	schedule(nextIn());
	return {
		env: relay.env,
		placeholder: relay.placeholder,
		...(relay.lease !== undefined && { lease: relay.lease }),
		close: async () => {
			stopped = true;
			clearTimeout(timer);
			await relay.close();
		},
	};
}

export function tokenFilePaths(path: string): string[] {
	return [path, `${path}.tmp`];
}
