// What the runner does differently per machine harness, one record each, so callers read a field instead of comparing ids.
import type { ModelProvider } from "../../server/src/contract.js";
import { innerModesReason } from "../../server/src/sandbox/codex-modes.js";
import { keyRelayUrl, openCodeCredentials, prepareRelay, type ProviderLogin } from "./claude-relay.js";
import { changeClaudeLogin, claudeLoginFromStdin } from "./harness-login.js";
import { changeProviderLogin, currentProvider } from "./opencode-login.js";
import { providerHosts } from "./opencode-providers.js";
import type { MachineDocker, MachineHarness } from "./policy.js";
import { MODEL_RELAY_URL } from "../../server/src/sandbox/model-relay.js";
import { Refusal } from "./state.js";
import { HARNESSES } from "./setup-choices.js";

type Keys = Partial<Record<ModelProvider, string>>;
type Credentials = { env: Record<string, string>; close?: () => Promise<void> };

export interface MachineHarnessRecord {
	/** Refusal when the runner was started without this harness. */
	notEnabled: string;
	/** Whether it may also run on the Windlass sandbox profile once its inner sandbox probe passed (Codex); otherwise docker-hardened only. */
	innerProfile: boolean;
	/** Refusal for a profile it cannot run on. */
	profileRefusal: string;
	/** Refusal replacing a missing pinned image's error; without one, the image error is passed on. */
	missingImage?: string;
	/** Whether its sandbox names may lack the harness prefix: Claude's predate it (`migrateClaudeNames`). */
	unprefixedNames: boolean;
	/** Hosts its sandbox may not reach under restricted egress: its provider must be reached through the relay. */
	deniedHosts: () => readonly string[];
	/** Whether its key relay shares the relay's port 17892 (the forwarder's "codex" mode); others take keys on 17894. */
	keysOnRelayPort: boolean;
	/** The machine's own sign-in the relay serves; none where the relay reads the login volume itself (Claude). */
	machineLogin: (m: MachineDocker) => ProviderLogin | undefined;
	/** The refusal for a turn with no plan, no key and no machine sign-in; none where its relay can start without (Claude). */
	noCredential?: string;
	/** A Settings key handed straight to the agent, bypassing the session relay. */
	keyEnv: (keys: Keys) => Record<string, string> | undefined;
	/** A plan-paid turn's env: the plan relay on this machine, behind the turn's forwarder on 127.0.0.1:17893 (`planRelay`). */
	planEnv: (placeholder: string) => Record<string, string>;
	/** The session relay's credentials for a turn. */
	credentials: (m: MachineDocker, nonce: string, login: ProviderLogin | undefined, keys: Keys) => Promise<Credentials>;
	/** `login` / `logout <agent>`; refuses for an agent with no login of its own on the machine. */
	changeLogin: (m: MachineDocker, login: boolean, signal: AbortSignal, provider?: string) => Promise<unknown>;
	/** Whether `login` takes `--provider`. */
	takesProvider: boolean;
	/** `login --token-stdin`: keeps a token piped in, with no questions (Claude Code's setup token). */
	tokenFromStdin?: (m: MachineDocker, signal: AbortSignal) => Promise<void>;
	/** The line after a successful logout. */
	signedOut: string;
}

/** The model relay's forwarder in the sandbox, where a plan turn's forwarder listens too (egress-proxy.mjs `wlp-model-forward`). */
const PLAN_RELAY_ORIGIN = new URL(MODEL_RELAY_URL).origin;

const relayCredentials = (m: MachineDocker, nonce: string) => prepareRelay(m, nonce);

export const MACHINE_HARNESSES: Record<MachineHarness, MachineHarnessRecord> = {
	claude: {
		notEnabled: "Claude Code is not turned on on this machine: start the runner with --harness claude.",
		innerProfile: false,
		profileRefusal: "Claude Code requires the docker-hardened profile.",
		missingImage:
			"The pinned Claude Code image is missing on this machine. Update the runner and start it with --harness claude.",
		unprefixedNames: true,
		deniedHosts: () => [],
		keysOnRelayPort: false,
		machineLogin: () => undefined,
		keyEnv: keys =>
			keys.anthropic ? { ANTHROPIC_BASE_URL: keyRelayUrl, ANTHROPIC_API_KEY: keys.anthropic } : undefined,
		planEnv: placeholder => ({ ANTHROPIC_BASE_URL: PLAN_RELAY_ORIGIN, CLAUDE_CODE_OAUTH_TOKEN: placeholder }),
		credentials: relayCredentials,
		changeLogin: changeClaudeLogin,
		takesProvider: false,
		tokenFromStdin: claudeLoginFromStdin,
		signedOut: "signed out.",
	},
	codex: {
		notEnabled: "Start the runner with --harness codex.",
		innerProfile: true,
		profileRefusal: innerModesReason,
		unprefixedNames: false,
		deniedHosts: () => ["api.openai.com", "auth.openai.com", "chatgpt.com"],
		keysOnRelayPort: true,
		// No login of its own on the machine: the ChatGPT plan (its relay here) or a Settings key pays.
		machineLogin: () => undefined,
		noCredential: "Codex on this machine pays with your ChatGPT plan or an OpenAI key. Connect one on Connections.",
		keyEnv: keys => (keys.openai ? { WLP_SESSION_BEARER: keys.openai } : undefined),
		planEnv: placeholder => ({ WLP_CODEX_BASE_URL: `${PLAN_RELAY_ORIGIN}/v1`, WLP_SESSION_BEARER: placeholder }),
		credentials: async () => {
			throw new Refusal(
				"Codex on this machine pays with your ChatGPT plan or an OpenAI key. Connect one on Connections.",
			);
		},
		changeLogin: async () => {
			throw new Refusal(
				"Codex has no login on this machine: it pays with your ChatGPT plan or OpenAI key from Connections.",
			);
		},
		takesProvider: false,
		signedOut: "signed out.",
	},
	opencode: {
		notEnabled: "Start the runner with --harness opencode.",
		innerProfile: false,
		profileRefusal: "OpenCode requires the docker-hardened profile.",
		unprefixedNames: false,
		deniedHosts: () => providerHosts,
		keysOnRelayPort: false,
		machineLogin: currentProvider,
		noCredential: "Run windlass-runner login opencode on this machine.",
		keyEnv: () => undefined,
		// No plan pays for OpenCode (harnesses.ts `planProviders`).
		planEnv: () => {
			throw new Refusal("No plan pays for OpenCode.");
		},
		credentials: openCodeCredentials,
		changeLogin: changeProviderLogin,
		takesProvider: true,
		signedOut: "signed out.",
	},
};

/** The harness whose prefix a sandbox's raw id carries ("codex-…"); undefined for a Windlass or legacy Claude name. */
export function harnessOfRaw(raw: string): MachineHarness | undefined {
	return HARNESSES.find(id => raw.startsWith(id + "-"));
}

/** A session container's name: wlp-session-, an optional harness prefix, then 12 hex digits (the raw id). */
export const SESSION_NAME = new RegExp(`^wlp-session-((?:(?:${HARNESSES.join("|")})-)?[a-f0-9]{12})$`);
