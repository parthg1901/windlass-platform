import { SecretRedactor, type Redactor } from "../repo-secrets.js";
import type { CredentialRef, HarnessId, ModelProvider } from "../contract.js";
import type { KeyTurnRelay } from "./provider.js";
import { ACCESS_TOKEN_FILE_ENV } from "./handoff.js";

type KeyEnv = (ref: Omit<CredentialRef, "generation">, base: string, placeholder: string) => Record<string, string>;

const WINDLASS_KEY_VARIABLES: Record<ModelProvider, string> = {
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	google: "GEMINI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
};

/** Each harness's placeholder env, in the format its adapter expects. */
const KEY_ENV: Record<HarnessId, KeyEnv> = {
	windlass: ({ provider }, base, placeholder) => ({
		WINDLASS_MODEL_BASE_URL: base,
		WINDLASS_MODEL_ALLOWED_ORIGIN: new URL(base).origin,
		WINDLASS_PROVIDER: provider,
		[WINDLASS_KEY_VARIABLES[provider]]: placeholder,
	}),
	// A Claude plan's token goes where Claude Code sends it as a bearer; a Settings key as `x-api-key`.
	claude: ({ plan }, base, placeholder) => ({
		ANTHROPIC_BASE_URL: base,
		[plan ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY"]: placeholder,
	}),
	codex: (_ref, base, placeholder) => ({
		WLP_CODEX_BASE_URL: base,
		WLP_SESSION_BEARER: placeholder,
		CODEX_HOME: "/opt/wlp-codex/home",
		CODEX_SQLITE_HOME: "/opt/wlp-codex/home/sqlite",
		INITIAL_AGENT_MODE: "agent-full-access",
	}),
	opencode: ({ provider }, base, placeholder) => {
		const version = provider === "anthropic" ? "/v1" : provider === "google" ? "/v1beta" : "";
		return {
			OPENCODE_AUTH_CONTENT: JSON.stringify({ [provider]: { type: "api", key: placeholder } }),
			OPENCODE_CONFIG_CONTENT: JSON.stringify({
				enabled_providers: [provider],
				provider: { [provider]: { options: { baseURL: base + version } } },
			}),
		};
	},
};

/** The hosted CLI receives one turn's placeholder, in the format its adapter expects. */
export function hostedKeyEnv(
	id: HarnessId,
	ref: Omit<CredentialRef, "generation">,
	lease: KeyTurnRelay,
): Record<string, string> {
	return KEY_ENV[id](ref, lease.env.WINDLASS_MODEL_BASE_URL!, lease.placeholder);
}

/**
 * Windlass on the ChatGPT plan: its ChatGPT provider, sent to the plan's relay, with the bearer read from an
 * access token file that holds the turn's placeholder (`writePlanPlaceholder`), as Windlass reads a handed-in token.
 */
export function windlassPlanEnv(lease: KeyTurnRelay, tokenFile: string): Record<string, string> {
	const base = lease.env.WINDLASS_MODEL_BASE_URL!;
	return {
		WINDLASS_PROVIDER: "chatgpt",
		WINDLASS_MODEL_BASE_URL: base,
		WINDLASS_MODEL_ALLOWED_ORIGIN: new URL(base).origin,
		[ACCESS_TOKEN_FILE_ENV]: tokenFile,
	};
}

export function redactKeyLease(secrets: Redactor, placeholder: string): Redactor {
	const relay = new SecretRedactor([{ name: "model-relay", value: placeholder }]);
	return {
		active: true,
		text: s => secrets.text(relay.text(s)),
		deep: v => secrets.deep(relay.deep(v)),
		held: s => Math.max(secrets.held(s), relay.held(s)),
	};
}
