/** What the server says when it starts: a configuration it refuses, and a sandbox layer that cannot do all it should. */

import { versionAtLeast } from "./runner/control.js";
import type { Config } from "./config.js";
import type { ConnectionTokens } from "./connection-tokens.js";

export function windlassVersionProblem(version: string | null, source: string): string | null {
	if (version !== null && versionAtLeast(version.split("+")[0]!, "0.4.0")) return null;
	return "Windlass 0.4.0 or later is required for " + source + ". Found " + (version ?? "no executable version") + ".";
}

export function reportWebhook(enabled: boolean): void {
	if (enabled) console.log("[wlp] github: webhook on /github/webhook");
}

/**
 * The one sentence the server stops with when it must not start, or null. With a remote engine the
 * server is one of several, and a token one of them signs must be accepted by all the others: a
 * secret each would make up for itself, or keep in its own `.data/secret`, would not be.
 */
export function startupProblem(
	config: Pick<Config, "engine" | "secretConfigured" | "browsers" | "unusable" | "sandbox" | "allowDockerHosted">,
): string | null {
	// A setting that is set means something: one that cannot be used is not replaced by its default unsaid.
	if (config.unusable.length > 0) return `[wlp] ${config.unusable.join("; ")}.`;
	if (config.engine.remote && !config.secretConfigured) {
		return "[wlp] WLP_SECRET is not set: with a remote Rivet engine (RIVET_ENDPOINT) every server must sign tokens with the same secret, so set WLP_SECRET to one value of at least 16 characters on all of them.";
	}
	if (config.engine.remote && config.sandbox === "docker" && !config.allowDockerHosted) {
		return "[wlp] WLP_SANDBOX=docker with a remote Rivet engine would run hosted agents on the server host. Use fake or e2b and pair a runner on another machine, or explicitly set WLP_ALLOW_DOCKER_HOSTED=1.";
	}
	// A browser needs its reachable gateway address as well as the scoped token the server issues.
	if (config.browsers.tokens && config.browsers.endpoint === null) {
		return "[wlp] WLP_PUBLIC_ENDPOINT is not set: with RIVET_ADMIN_TOKEN the server issues the tokens browsers connect with and tells them where the engine is, so set WLP_PUBLIC_ENDPOINT to the address browsers reach the engine at (for a Rivet Cloud cluster, https://<name>-api.onrivet.dev).";
	}
	return null;
}

/**
 * The warning the server starts with when `WLP_PLAN_USERS` names nobody (unset or empty), or null: plans then pay for
 * no one's hosted turns, Windlass's own ChatGPT models included, which is easy to miss on a new deployment.
 */
export function planUsersWarning(config: Pick<Config, "plans">): string | null {
	if (config.plans === "all" || config.plans.size > 0) return null;
	return "[wlp] WARNING: WLP_PLAN_USERS is not set, so hosted Windlass on ChatGPT and plan-paid turns are refused for everyone. Set it to user ids, or * for everyone, to allow them.";
}

/**
 * Asks the engine for the first connection token now, so that an admin token the engine refuses, or
 * an engine address that does not answer, is said when the server starts and not to its first
 * visitor: `[wlp] WARNING: ...`. The server starts all the same, and asks again when a browser does.
 * `tokens` is null when the engine asks for none. Returns what it printed, or null.
 */
export async function warnAboutConnectionTokens(
	tokens: Pick<ConnectionTokens, "current"> | null,
	print: (line: string) => void = line => console.error(line),
): Promise<string | null> {
	if (tokens === null) return null;
	try {
		await tokens.current();
		return null;
	} catch (error) {
		// A ConnectionTokenError's message holds no token; nothing else is thrown there.
		const line = `[wlp] WARNING: Browsers cannot connect: ${error instanceof Error ? error.message : "no connection token could be issued"}. Check RIVET_ADMIN_TOKEN and WLP_PUBLIC_ENDPOINT.`;
		print(line);
		return line;
	}
}
