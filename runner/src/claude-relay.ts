import { SECRET_FILE_SCRIPT, type ForwardedKeyLease } from "../../server/src/sandbox/provider.js";
import type { ModelProvider } from "../../server/src/contract.js";
import { withLoginVolume } from "./harness-login.js";
import { providers } from "./opencode-providers.js";
import { createHash, createPublicKey, randomBytes, sign } from "node:crypto";
import {
	docker,
	helperFlags,
	LABEL,
	LABEL_ARG,
	RELAY_LOGS,
	runHelper,
	tmpName,
} from "../../server/src/sandbox/docker.js";
import { waitForListener } from "./helper-ready.js";
import { image, type MachineHarness, type MachineDocker } from "./policy.js";
import { loadPair, Refusal, RunnerError } from "./state.js";

declare const CLAUDE_RELAY_SCRIPT: string;
declare const OPENCODE_RELAY_SCRIPT: string;
/** OpenCode's logins on this machine (opencode-login.ts). */
export interface ProviderLogin {
	provider: string;
	providers?: string[];
	generation: string;
}
export function localProviders(machine: string[], keys: string[]) {
	return machine.filter(id => !keys.includes(id === "chatgpt" ? "openai" : id));
}

export function projection(
	selected: string | string[],
	placeholder: string,
	keys: Partial<Record<ModelProvider, string>> = {},
) {
	const machine = typeof selected === "string" ? [selected] : selected;
	const ids = [...localProviders(machine, Object.keys(keys)), ...Object.keys(keys)];
	const auth: Record<string, unknown> = {},
		config: Record<string, unknown> = {};
	for (const selected of ids) {
		const id = selected === "free" ? "opencode" : selected === "chatgpt" ? "openai" : selected;
		const route = selected === "chatgpt" ? "openai" : selected;
		const p = providers[id];
		config[id] = {
			options: {
				baseURL: (Object.hasOwn(keys, id) ? keyRelayUrl : relayUrl) + "/" + route,
				...(selected === "free" && { headers: { authorization: "Bearer " + placeholder } }),
			},
			...(p?.blocked && { blacklist: p.blocked }),
			...(p?.variants && {
				models: Object.fromEntries(
					Object.keys(p.variants).map(model => [model, { headers: { "x-wlp-route": model } }]),
				),
			}),
		};
		if (selected !== "free")
			auth[id] =
				selected === "chatgpt"
					? { type: "oauth", refresh: "", access: placeholder, expires: Number.MAX_SAFE_INTEGER }
					: { type: "api", key: keys[id as ModelProvider] ?? placeholder };
	}
	return {
		WLP_OPENCODE_PROVIDER: ids.join(","),
		OPENCODE_AUTH_CONTENT: JSON.stringify(auth),
		OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: Object.keys(config), provider: config }),
	};
}
const role = LABEL + ".credential-relay";
export const relaySocketVolume = (m: MachineDocker, harness: MachineHarness = "claude") =>
	"wlp-" + harness + "-socket-" + m.identity.machineId;
export const relayUrl = "http://127.0.0.1:17892";
export const keyRelayUrl = "http://127.0.0.1:17894";
const relayName = (m: MachineDocker, harness: MachineHarness, keys = false) =>
	"wlp-" + harness + "-relay-" + m.identity.machineId + (keys ? "-keys" : "");
const flags = (m: MachineDocker) => ["--label", LABEL_ARG, ...m.pairingLabelFlags, "--label", role + "=1"];

function owned(labels: Record<string, string> | null, m: MachineDocker) {
	return labels?.[LABEL] === "1" && labels[role] === "1" && Object.entries(m.labels).every(([k, v]) => labels[k] === v);
}

// A missing object is normal. A daemon or permissions failure must never authorize adoption.
async function inspect(name: string) {
	const result = await docker(["container", "inspect", name], { timeoutMs: 15_000 });
	if (result.code === 0) return JSON.parse(result.stdout)[0];
	if (/no such (container|object)/i.test(result.stderr)) return;
	throw new RunnerError("Docker could not inspect the credential relay.");
}

async function ownedRelay(m: MachineDocker, harness: MachineHarness, keys = false) {
	const box = await inspect(relayName(m, harness, keys));
	if (box && !owned(box.Config.Labels, m))
		throw new Refusal("The credential relay container belongs to a different pairing.");
	return box;
}

/**
 * The relay's latest notes about answers it did not pass on as the provider gave them (sandbox/relay/server.cjs
 * `notesFile`). Only the fields the relay writes, as short printable text.
 */
export async function relayNotes(m: MachineDocker, harness: MachineHarness, latest = 3): Promise<string[]> {
	const box = await ownedRelay(m, harness).catch(() => undefined);
	if (!box?.State?.Running) return [];
	// Copied out as a tar stream, never run in the relay (status starts and runs nothing: runner-check.ts). One file, so one header.
	const read = await docker(["cp", box.Id + ":/workspace/relay-notes.json", "-"], { timeoutMs: 15_000 });
	if (read.code !== 0 || read.stdout.length < 512) return [];
	const size = Number.parseInt(read.stdout.slice(124, 136).replace(/\0/g, "").trim(), 8);
	if (!Number.isSafeInteger(size) || size <= 0 || size > 65_536) return [];
	let notes: unknown;
	try {
		notes = JSON.parse(read.stdout.slice(512, 512 + size));
	} catch {
		return [];
	}
	if (!Array.isArray(notes)) return [];
	const field = (value: unknown) =>
		(typeof value === "string" || typeof value === "number") && /^[A-Za-z0-9 ./;=_+:,-]{0,120}$/.test(String(value))
			? String(value)
			: "?";
	return notes
		.slice(-latest)
		.filter(note => note && typeof note === "object")
		.map((note: Record<string, unknown>) =>
			[
				field(note.at),
				field(note.event),
				field(note.route),
				note.upstream !== undefined
					? `upstream ${field(note.upstream)}, content-type ${field(note.contentType)}`
					: `error ${field(note.error)}`,
				note.passedAs !== undefined ? `passed as ${field(note.passedAs)}` : `answered ${field(note.answered)}`,
			].join("  "),
		);
}

interface RelayKind {
	/** The agent's name in messages. */
	name: string;
	/** The relay's bundled server, read when used: checks swap the globals at run time. */
	script: () => string;
	envPrefix: string;
	/** The login volume it serves; none for an agent whose relay only takes Settings keys (Codex). */
	credentials?: (m: MachineDocker) => string;
	/** Whether a logout leaves a signed-out marker for its sessions. */
	signedOutMarker: boolean;
	/** Whether it is given time to save a refresh before removal (RELAY_STOP_SECONDS). */
	gracefulStop: boolean;
}

const RELAYS: Record<MachineHarness, RelayKind> = {
	claude: {
		name: "Claude Code",
		script: () => CLAUDE_RELAY_SCRIPT,
		envPrefix: "WLP_CLAUDE_RELAY_",
		credentials: m => m.claudeVolume,
		signedOutMarker: false,
		gracefulStop: false,
	},
	// Only its key relay: server.cjs serves `WLP_HARNESS_KEYS=codex` on the relay's port 17892.
	codex: {
		name: "Codex",
		script: () => CLAUDE_RELAY_SCRIPT,
		envPrefix: "WLP_CODEX_RELAY_",
		signedOutMarker: false,
		gracefulStop: false,
	},
	opencode: {
		name: "OpenCode",
		script: () => OPENCODE_RELAY_SCRIPT,
		envPrefix: "WLP_OPENCODE_RELAY_",
		credentials: m => m.opencodeVolume,
		signedOutMarker: true,
		gracefulStop: true,
	},
};

// Call under the login lock, including logout from a standalone runner command.
/** `signedOut` for a logout: sessions are then told signed out, not to try again (sandbox/relay/server.cjs SIGNED_OUT). */
export async function removeRelay(m: MachineDocker, harness: MachineHarness = "claude", signedOut = false) {
	const box = await ownedRelay(m, harness);
	const mark = signedOut && RELAYS[harness].signedOutMarker;
	// Written by the relay's own user into its socket volume, before the relay stops answering.
	const marked =
		mark &&
		box?.State?.Running === true &&
		(await docker(["exec", box.Id, "touch", SIGNED_OUT_MARKER], { timeoutMs: 15_000 })).code === 0;
	if (box) await retireRelay(box.Id, harness);
	if (mark && !marked) await markSignedOut(m, harness);
}
const SIGNED_OUT_MARKER = "/workspace/signed-out";
/** The marker without a running relay: a short container of the pinned base image, as the relay's user, on the socket volume. */
async function markSignedOut(m: MachineDocker, harness: MachineHarness) {
	const volume = relaySocketVolume(m, harness);
	// Without the volume no session can reach a relay; there is no one to tell.
	if (!(await m.ownedVolume(false, volume))) return;
	const name = tmpName();
	const result = await runHelper(
		[
			...helperFlags(name, "none"),
			...m.pairingLabelFlags,
			"--pull",
			"never",
			"--user",
			"1000:1000",
			"--read-only",
			"--mount",
			`type=volume,src=${volume},dst=/workspace,volume-nocopy`,
		],
		name,
		["touch", SIGNED_OUT_MARKER],
		{ image, timeoutMs: 30_000 },
	);
	if (result.code !== 0)
		throw new RunnerError(
			`Could not tell ${RELAYS[harness].name} sessions they are signed out: ${result.stderr.trim() || "exit " + result.code}.`,
		);
}
/**
 * A relay that refreshes a login saves a refresh already sent before it exits on SIGTERM, since that
 * refresh spent the old refresh token (sandbox/relay/server.cjs stopOnSignal). Its token request
 * times out after 20 s, so give it that and the write before Docker kills it.
 */
export const RELAY_STOP_SECONDS = 30;
async function retireRelay(id: string, harness: MachineHarness) {
	if (RELAYS[harness].gracefulStop)
		await docker(["stop", "-t", String(RELAY_STOP_SECONDS), id], { timeoutMs: (RELAY_STOP_SECONDS + 15) * 1000 });
	await docker(["rm", "-f", id], { check: true });
}
// The old image gave every session a volume reference. Preserve its workspace, but stop
// the process before replacing the token. Docker cannot detach a container's volume.
export async function stopLegacyClaude(m: MachineDocker) {
	const running = await docker(
		[
			"ps",
			"-q",
			"--filter",
			"volume=" + m.claudeVolume,
			"--filter",
			"label=" + LABEL + ".harness=claude",
			"--filter",
			"label=" + LABEL + ".session",
			...Object.entries(m.labels).flatMap(([k, v]) => ["--filter", "label=" + k + "=" + v]),
		],
		{ check: true },
	);
	for (const id of running.stdout.trim().split(/\s+/).filter(Boolean))
		await docker(["stop", "-t", "1", id], { check: true });
}

/** Caller holds the pairing login lock through credential and relay setup. */
export async function ensureRelay(
	m: MachineDocker,
	login?: ProviderLogin,
	harness: MachineHarness = login ? "opencode" : "claude",
	keys = false,
) {
	const relay = RELAYS[harness];
	const script = relay.script();
	const prefix = relay.envPrefix;
	const credentials = relay.credentials?.(m);
	const pair = loadPair();
	if (!pair?.key || pair.current.machineId !== m.identity.machineId || pair.current.uid !== m.identity.uid)
		throw new Refusal("The machine pairing changed while preparing the credential relay.");
	const mountLogin = !keys;
	if (mountLogin && (!credentials || !(await m.ownedVolume(!login, credentials))))
		throw new Refusal(`Run windlass-runner login ${harness} on this machine.`);
	await m.ensureImage();
	const socketVolume = relaySocketVolume(m, harness);
	await m.ownedVolume(true, socketVolume);
	const version = createHash("sha256")
		.update(script)
		.update(JSON.stringify(login ?? null))
		.update(JSON.stringify(RELAY_LOGS))
		.digest("hex");
	const publicKey = createPublicKey(pair.key).export({ format: "der", type: "spki" }).toString("base64");
	const identity = keys ? "WLP_HARNESS_KEYS=" + harness : prefix + "PUBLIC_KEY=" + publicKey;
	let box = await ownedRelay(m, harness, keys);
	if (
		box &&
		(box.Config.Labels[role + ".version"] !== version ||
			box.Config.Image !== image ||
			!box.Config.Env.includes(identity))
	) {
		await retireRelay(box.Id, harness);
		box = undefined;
	}
	if (!box) {
		await docker(
			[
				"create",
				"--pull",
				"never",
				"--name",
				relayName(m, harness, keys),
				...flags(m),
				"--label",
				role + ".version=" + version,
				"--user",
				"1000:1000",
				"--read-only",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				...RELAY_LOGS,
				"--memory",
				"192m",
				"--pids-limit",
				"48",
				"--network",
				"bridge",
				"--mount",
				`type=volume,src=${socketVolume},dst=/workspace`,
				"--tmpfs",
				"/run/wlp-keys:rw,noexec,nosuid,nodev,mode=0700,uid=1000,gid=1000,size=4m",
				...(mountLogin
					? [
							"--mount",
							`type=volume,src=${credentials},dst=/run/wlp-harness/${harness},${login ? "" : "readonly,"}volume-nocopy`,
						]
					: []),
				"-e",
				identity,
				"-e",
				prefix + "MACHINE=" + m.identity.machineId,
				...(login
					? [
							"-e",
							"WLP_OPENCODE_GENERATION=" + login.generation,
							"-e",
							"WLP_OPENCODE_PROVIDER=" + (login.providers ?? [login.provider]).join(","),
						]
					: []),
				image,
				"node",
				"-e",
				script,
			],
			{ check: true },
		);
		box = await ownedRelay(m, harness, keys);
	}
	if (!box.State.Running) {
		await docker(["start", box.Id], { check: true });
		try {
			await waitForListener(box.Id, keys ? "/workspace/keys.sock" : "/workspace/relay.sock");
		} catch (error) {
			await docker(["rm", "-f", box.Id], { check: true });
			throw error;
		}
	}
	return { key: pair.key, box: box.Id as string };
}

/** Claude Code's relay for a login kept on this machine (`login claude`), with the session's signed placeholder. */
export async function prepareRelay(m: MachineDocker, nonce = randomBytes(16).toString("hex")) {
	const { key } = await ensureRelay(m);
	if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Refusal("Invalid session relay nonce.");
	const signature = sign(null, Buffer.from("windlass-claude-relay-v2\n" + m.identity.machineId + "\n" + nonce), key);
	const placeholder = nonce + "." + signature.toString("base64url");
	return { env: { ANTHROPIC_BASE_URL: relayUrl, CLAUDE_CODE_OAUTH_TOKEN: placeholder }, nonce };
}

/** Scope the fallback bearer to this turn's projected machine providers. */
export async function openCodeCredentials(
	m: MachineDocker,
	nonce: string,
	login: ProviderLogin | undefined,
	keys: Partial<Record<ModelProvider, string>>,
) {
	const machine = login?.providers ?? (login ? [login.provider] : []);
	const allowed = localProviders(machine, Object.keys(keys));
	const path = "/run/wlp-keys/" + nonce + ".login";
	if (!allowed.length || !login) {
		const relay = login && (await ownedRelay(m, "opencode"));
		if (relay?.State.Running) await docker(["exec", relay.Id, "rm", "-f", path], { check: true });
		return { env: projection(machine, "", keys) };
	}
	const { box } = await ensureRelay(m, login);
	const placeholder = "wlp-login." + randomBytes(16).toString("hex");
	await writeRecord(box, path, { placeholder, allowed });
	return {
		env: projection(machine, placeholder, keys),
		close: () => withLoginVolume(m, () => removeRecord(box, path, placeholder)),
	};
}

function writeRecord(box: string, path: string, value: object) {
	return docker(["exec", "-i", box, "sh", "-c", SECRET_FILE_SCRIPT, "sh", path], {
		stdin: JSON.stringify(value),
		check: true,
	});
}

// The login lock orders this compare-and-remove with the next turn's write.
function removeRecord(box: string, path: string, placeholder: string) {
	const script = 'if test -f "$1" && grep -Fq -- "$2" "$1"; then rm -f -- "$1"; fi';
	return docker(["exec", box, "sh", "-c", script, "sh", path, placeholder]).then(() => {});
}

/** The key relay has its own socket and never mounts the login volume. */
export async function openHarnessKey(
	m: MachineDocker,
	harness: MachineHarness,
	nonce: string,
	forward: ForwardedKeyLease,
) {
	if (!/^[a-f0-9]{32}$/.test(nonce) || !forward.proofKey) throw new Refusal("Invalid machine key lease.");
	const { box } = await ensureRelay(m, undefined, harness, true);
	const placeholder = "wlp-model." + randomBytes(16).toString("hex");
	const path = "/run/wlp-keys/" + nonce + "." + placeholder;
	await writeRecord(box, path, forward);
	return {
		placeholder,
		env: {},
		close: async () => {
			await docker(["exec", box, "rm", "-f", path]);
		},
	};
}

/** Remove records left by a previous runner for just this sandbox. Caller holds the login lock. */
export async function endHarnessLeases(m: MachineDocker, harness: MachineHarness, nonce: string) {
	if (!/^[a-f0-9]{32}$/.test(nonce)) return;
	const keys = await ownedRelay(m, harness, true);
	if (keys?.State.Running) {
		await docker(["exec", keys.Id, "sh", "-c", 'rm -f /run/wlp-keys/"$1".wlp-model.*', "sh", nonce], { check: true });
	}
	if (harness === "opencode") {
		const login = await ownedRelay(m, harness);
		if (login?.State.Running)
			await docker(["exec", login.Id, "rm", "-f", "/run/wlp-keys/" + nonce + ".login"], { check: true });
	}
}
