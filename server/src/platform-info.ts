/**
 * The facts of this deployment, cached: asking the sandbox layer can mean starting a container. And
 * what a browser needs to reach the actors: where the engine is, and a token for it.
 *
 * Both are served over plain HTTP by every server (`GET /platform/info`, `GET /platform/connection`,
 * see index.ts), not by an actor: they hold no state, and one actor that every visitor asks first
 * would be a hot spot and a single point of failure, and the connection is what a browser needs
 * before it can reach any actor at all. Each server answers from its own cache.
 *
 * They are two routes because they are two kinds of answer. The information is the same for hours,
 * is asked once when a page loads, and may be seen by anyone. The connection holds a token: it runs
 * out, so the web app asks for it again and again while a tab is open, it must never be kept by
 * anything between the server and the browser, and it can fail by itself (the engine cannot be asked)
 * while the sign-in screen still has everything it shows.
 */

import { googleCredentials } from "./platform-login.js";
import { fingerprint } from "./runner/frame-auth.js";
import { UserError } from "rivetkit";
import { assertOrigin } from "./auth.js";
import { config, engineAdminToken, githubConfig } from "./config.js";
import { ConnectionTokens } from "./connection-tokens.js";
import {
	type GithubInfo,
	PLATFORM_CONNECTION_PATH,
	PLATFORM_INFO_PATH,
	type PlatformConnection,
	type PlatformInfo,
} from "./contract.js";
import { getLayer } from "./layer.js";
import { offeredProfiles } from "./sandbox/profiles.js";
import { billing } from "./billing/config.js";
import { PLAN_LIST } from "./billing/plans.js";
import { MIN_RUNNER_VERSION } from "./runner/control.js";

const FRESH_MS = 5 * 60 * 1000;
/** A missing image or a failed lookup is asked about again sooner. */
const RETRY_MS = 15 * 1000;

interface Slow {
	windlassVersion: string | null;
	at: number;
}

let cached: Slow | null = null;
let loading: Promise<Slow> | null = null;

async function loadSlow(): Promise<Slow> {
	const layer = await getLayer();
	const windlassVersion = await layer.windlass.version().catch(() => null);
	return { windlassVersion, at: Date.now() };
}

async function slow(): Promise<Slow> {
	if (cached && Date.now() - cached.at < (cached.windlassVersion !== null ? FRESH_MS : RETRY_MS)) return cached;
	if (!loading) {
		loading = loadSlow()
			.then(value => {
				cached = value;
				return value;
			})
			.finally(() => {
				loading = null;
			});
	}
	return loading;
}

let github: GithubInfo | null | undefined;

/** What the web app is told of the deployment's GitHub App; null without one, and the web app then shows nothing of GitHub. */
function githubInfo(): GithubInfo | null {
	if (github === undefined) {
		const { app } = githubConfig();
		github = app ? { slug: app.slug, url: app.webUrl } : null;
	}
	return github;
}

export async function platformInfo(): Promise<PlatformInfo> {
	const layer = await getLayer();
	const { windlassVersion } = await slow();
	const info: PlatformInfo = {
		demoEnabled: config.demo,
		windlassVersion,
		profiles: offeredProfiles(layer.sandboxes.profiles()),
	};
	// Left out where hosted sandboxes have no network mode, or it is `open`: the answer is then what it was before modes.
	const hostedEgress = layer.sandboxes.egress?.();
	if (hostedEgress !== undefined && hostedEgress !== "open") info.hostedEgress = hostedEgress;
	// Left out where hosted sandboxes have one size: the web app then shows nothing of sizes.
	const sizes = layer.sandboxes.sizes?.() ?? [];
	if (sizes.length > 1) info.hostedSizes = sizes;
	// Left out without a GitHub App: the answer is then what it was before there could be one.
	const app = githubInfo();
	if (googleCredentials()) info.googleLogin = true;
	if (app) info.github = app;
	if (config.machines)
		info.machines = {
			minRunnerVersion: MIN_RUNNER_VERSION,
			platformFingerprint: config.machines.identity && fingerprint(config.machines.identity.root),
			runnerImage: config.machines.runnerImage,
			runnerHarnesses: config.machines.runnerHarnesses,
			platformUrl: config.machines.publicUrl,
		};
	if (billing()) info.billing = { plans: PLAN_LIST };
	if (config.items)
		info.items = {
			reviewer: config.factory.reviewer,
			orchestrate: process.env.WLP_FACTORY_ORCHESTRATE !== "0",
			screenshots: config.factory.screenshots,
		};
	return info;
}

let tokens: ConnectionTokens | null | undefined;

/**
 * This server's source of connection tokens, or null when the engine asks for none (RIVET_ADMIN_TOKEN
 * is unset). With an admin token the address browsers use is known: the server does not start
 * without it (startup.ts).
 */
export function connectionTokens(): ConnectionTokens | null {
	if (tokens === undefined) {
		const adminToken = engineAdminToken();
		const { endpoint, tokenEndpoint, tokenTtlMs } = config.browsers;
		tokens =
			adminToken !== null && endpoint !== null
				? new ConnectionTokens({
						endpoint: tokenEndpoint ?? endpoint,
						adminToken,
						namespace: config.engine.namespace,
						ttlMs: tokenTtlMs,
					})
				: null;
	}
	return tokens;
}

/** Throws a ConnectionTokenError when a token is needed and cannot be had. */
export async function platformConnection(): Promise<PlatformConnection> {
	const source = connectionTokens();
	return {
		endpoint: config.browsers.endpoint,
		namespace: config.engine.namespace,
		token: source ? await source.current() : null,
	};
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
	});
}

/**
 * A `GET` route of the platform's. The origin check is the one the actors make (`assertOrigin`): a
 * browser on another site is refused, and a client that sends no origin is let through. An allowed
 * browser gets the CORS header it needs to read the answer. Errors have the shape of RivetKit's
 * (`group`, `code`, `message`), so the web app reads them the same way.
 */
async function getRoute(
	request: Request,
	path: string,
	answer: (cors: Record<string, string>) => Promise<Response>,
): Promise<Response> {
	const origin = request.headers.get("origin");
	const cors: Record<string, string> = { vary: "Origin" };
	try {
		assertOrigin({ request });
	} catch (error) {
		const message = error instanceof UserError ? error.message : "This origin is not allowed to connect.";
		return json(403, { group: "user", code: "origin_not_allowed", message }, cors);
	}
	if (origin) cors["access-control-allow-origin"] = origin;
	if (request.method === "OPTIONS") {
		return new Response(null, {
			status: 204,
			headers: { ...cors, "access-control-allow-methods": "GET", "access-control-max-age": "600" },
		});
	}
	if (request.method !== "GET" && request.method !== "HEAD") {
		return json(
			405,
			{ group: "user", code: "method_not_allowed", message: `Use GET for ${path}.` },
			{ ...cors, allow: "GET" },
		);
	}
	return answer(cors);
}

/** `GET /platform/info`. */
export function platformInfoResponse(request: Request): Promise<Response> {
	return getRoute(request, PLATFORM_INFO_PATH, async cors => {
		try {
			return json(200, await platformInfo(), cors);
		} catch (error) {
			console.error("[wlp] the platform's information could not be read:", error);
			return json(
				500,
				{ group: "rivetkit", code: "internal_error", message: "The platform's information could not be read." },
				cors,
			);
		}
	});
}

/**
 * `GET /platform/connection`: a `PlatformConnection`. With no admin token configured `token` is null,
 * which is an answer and not a failure: the local engine asks for none. When a token is needed and the
 * engine could not be asked for it, the answer is 503 `connection_unavailable`; why is in the server's
 * log (connection-tokens.ts) and not in the answer, which says nothing of the engine.
 */
export function platformConnectionResponse(request: Request): Promise<Response> {
	return getRoute(request, PLATFORM_CONNECTION_PATH, async cors => {
		try {
			return json(200, await platformConnection(), cors);
		} catch {
			// Already logged where it failed, once for all the browsers that were waiting.
			return json(
				503,
				{
					group: "platform",
					code: "connection_unavailable",
					message: "The server could not prepare a connection to the agents. Try again in a moment.",
				},
				cors,
			);
		}
	});
}
