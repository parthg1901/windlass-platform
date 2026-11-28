/**
 * The server: one Rivet node, and the platform's own HTTP routes beside it.
 *
 * `registry.listen({ application })` (RivetKit 3.1.1, registry/index.ts) starts the node as
 * `registry.start()` does, waits until it has registered with the engine, and then serves every HTTP
 * request on its own port with the application's `fetch`. Actor traffic does not come through that
 * port: browsers reach actors through the engine's gateway, and the node keeps an outbound connection
 * to the engine. What a browser needs for that, the engine's address and a token, it asks this port
 * for (`/platform/connection`, platform-info.ts). Without RIVET_ENDPOINT RivetKit starts a local
 * engine on http://127.0.0.1:6420; with it this server joins that engine as one node among several.
 * See config.ts for the variables.
 */

import { debuglog } from "node:util";
import { createClient, type Registry } from "./client.js";
import { serviceParams } from "./auth.js";
import { isActorGone, isSessionGone } from "./actor-errors.js";
import { RETENTION_PATH } from "./runner/frame-auth.js";

import { loginResponse } from "./login-route.js";
import { runnerResponse } from "./runner-routes.js";
import { CONNECT_ROUTE_PATHS, connectResponse } from "./connect-route.js";
import { INSTALL_SCRIPT_PATH, installScriptResponse } from "./install-script.js";
import { modelRelayRoute } from "./model-relay-route.js";
import { apiRoute } from "./api-routes.js";
import { BILLING_WEBHOOK_PATH, billingWebhookRoute } from "./billing/route.js";
import { billing } from "./billing/config.js";
import { RUNNER_PAIR_PATH, RUNNER_PAIR_POLL_PATH, RUNNER_CONNECTION_PATH } from "./runner/control.js";
import {
	config,
	githubConfig,
	gitlabConfig,
	jiraConfig,
	linearConfig,
	ownEngineEndpoint,
	snapshotsFor,
} from "./config.js";
import { DEFAULT_ENDPOINT, PLATFORM_CONNECTION_PATH, PLATFORM_INFO_PATH } from "./contract.js";
import { webhookRoute } from "./github/webhook.js";
import { githubApp } from "./github/app.js";
import { GITHUB_CALLBACK_PATH, githubCallbackResponse } from "./github/connect.js";
import { JIRA_CALLBACK_PATH, jiraCallbackResponse } from "./jira/connect.js";
import { JIRA_WEBHOOK_PATH, jiraWebhookRoute } from "./jira/webhook.js";
import { actorLinearConnectStore, dispatchLinearDelivery } from "./actors/user-linear.js";
import { GITLAB_WEBHOOK_PATH } from "./gitlab/webhook.js";
import { receiveGitlabWebhook } from "./actors/gitlab-inbox.js";
import { actorGitlabConnectStore } from "./actors/user-gitlab.js";
import { GITLAB_CALLBACK_PATH, gitlabCallbackResponse } from "./gitlab/connect.js";
import { LINEAR_CALLBACK_PATH, linearCallbackResponse } from "./linear/connect.js";
import { LINEAR_WEBHOOK_PATH, linearWebhookRoute } from "./linear/webhook.js";
import { slackCallbackResponse } from "./slack/connect.js";
import { SLACK_INTERACTIONS_PATH, slackInteractionRoute } from "./slack/interactions.js";
import { SLACK_COMMANDS_PATH, SLACK_EVENTS_PATH, slackWebhookRoute } from "./slack/webhook.js";
import { getLayer } from "./layer.js";
import { connectionTokens, platformConnectionResponse, platformInfoResponse } from "./platform-info.js";
import { webFiles } from "./web.js";
import { registry } from "./registry.js";
import type { SandboxLayer } from "./sandbox/api.js";
import { getSignIns } from "./signin/index.js";
import { planUsersWarning, reportWebhook, startupProblem, warnAboutConnectionTokens } from "./startup.js";
import { errorText } from "./util.js";

const debug = debuglog("wlp");
process.on("unhandledRejection", reason => {
	if (isSessionGone(reason)) {
		debug("A call outlived its actor.");
		return;
	}
	console.error("[wlp] unhandled promise rejection:", reason);
});

const problem = startupProblem(config);
if (problem) {
	console.error(problem);
	process.exit(1);
}

let layer: SandboxLayer;
try {
	layer = await getLayer();
} catch (error) {
	console.error(`[wlp] the ${config.sandbox} sandbox layer could not be loaded:`, error);
	console.error("[wlp] start with WLP_SANDBOX=fake to run without it.");
	process.exit(1);
}

console.log(
	`[wlp] sandbox layer: ${config.sandbox}; demo sign-in: ${config.demo ? "on" : "off"}; web origins: ${config.origins.join(", ")}`,
);
if (config.engine.remote) {
	console.log(
		`[wlp] engine: ${config.engine.endpoint}, namespace ${config.engine.namespace}, pool ${config.engine.pool}; actor data is kept there`,
	);
} else {
	console.log(`[wlp] engine: local; actor data: ${config.storagePath}/.rivetkit`);
}
console.log(
	`[wlp] http: ${PLATFORM_INFO_PATH}, ${PLATFORM_CONNECTION_PATH} and /health on http://${config.httpHost}:${config.httpPort}`,
);
if (config.browsers.tokens) {
	console.log(
		`[wlp] browsers: ${config.browsers.endpoint}, namespace ${config.engine.namespace}, with tokens this server issues, each for ${Math.round(config.browsers.tokenTtlMs / 60_000)} minutes`,
	);
} else {
	console.log(
		`[wlp] browsers: ${config.browsers.endpoint ?? "the endpoint the web app was built with"}, with no token (RIVET_ADMIN_TOKEN is not set)`,
	);
}
if (layer.sandboxes.sweepSnapshots) {
	let client: ReturnType<typeof createClient<Registry>> | undefined;
	const sweep = () =>
		layer.sandboxes.sweepSnapshots!(async uid => {
			client ??= createClient<Registry>({ endpoint: ownEngineEndpoint() });
			try {
				const generations = await client.user.get([uid], { params: serviceParams() }).internalSnapshotGenerations();
				return new Set(snapshotsFor({ kind: "hosted" }) ? generations : []);
			} catch (error) {
				if (isActorGone(error)) return null;
				throw error;
			}
		}).catch(() => console.warn("[wlp] snapshot expiry deferred"));
	void sweep();
	setInterval(sweep, 60 * 60_000).unref();
}
if (layer.sandboxes.sweepDataVolumes) {
	// Own data volumes a create or a removal cut off with the server left without their container.
	const sweep = () => layer.sandboxes.sweepDataVolumes!().catch(() => console.warn("[wlp] data volume sweep deferred"));
	void sweep();
	setInterval(sweep, 30 * 60_000).unref();
}
if (layer.sandboxes.owners) {
	// Hosted sandboxes whose session is gone (deleted, or lost with an older deployment): each owner's actor removes its own.
	let client: ReturnType<typeof createClient<Registry>> | undefined;
	const sweep = async () => {
		const owners = await layer.sandboxes.owners!();
		client ??= createClient<Registry>({ endpoint: ownEngineEndpoint() });
		for (const uid of owners) {
			await client.user
				.get([uid], { params: serviceParams() })
				.internalSweepSandboxes()
				.catch((error: unknown) => {
					if (!isActorGone(error)) console.warn(`[wlp] sandbox.orphan_sweep uid=${uid}: deferred`);
				});
		}
	};
	const run = () => void sweep().catch(() => console.warn("[wlp] sandbox.orphan_sweep deferred"));
	setTimeout(run, 60_000).unref();
	setInterval(run, 30 * 60_000).unref();
}
const signIns = await getSignIns();
console.log(`[wlp] sign-in commands run in ${signIns.describe}`);
const windlassProblem = (await layer.windlass.problem()) ?? (await signIns.check());
if (windlassProblem) {
	console.error(`[wlp] ${windlassProblem}`);
	process.exit(1);
}
// Windlass's model relay of hosted Docker (docs/model-relay.md): on with the image's Windlass 0.7.1 or later, and what a stopped server left removed.
if (layer.sandboxes.prepareModelRelay)
	console.log(
		await layer.sandboxes
			.prepareModelRelay()
			.catch((error: unknown) => `[wlp] model_relay: could not be prepared (${errorText(error)})`),
	);
// Its route for E2B answers only on the relay's own hostname (WLP_MODEL_RELAY_URL), which serves nothing else.
const relayHost = config.modelRelay.on ? (config.modelRelay.url?.host ?? null) : null;
if (config.sandbox === "e2b" && config.modelRelay.on && relayHost === null)
	console.log(
		"[wlp] model_relay: WLP_MODEL_RELAY_URL is not set, so E2B turns are handed their access token in the sandbox; the platform's public host is never opened to E2B sandboxes in its place",
	);
const planUsers = planUsersWarning(config);
if (planUsers) console.error(planUsers);
// An admin token the engine refuses: said now, not to the first visitor.
void warnAboutConnectionTokens(connectionTokens());

// The GitHub App, when the deployment has one: said now, with a key that does not sign or a half-set configuration.
try {
	const { app, missing, webhook } = githubConfig();
	reportWebhook(webhook !== null);
	if (missing.length > 0)
		console.error(
			`[wlp] WARNING: GitHub is off: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set while the other GitHub App settings are.`,
		);
	else if (app) {
		const problem = githubApp()?.keyProblem() ?? null;
		if (problem) console.error(`[wlp] WARNING: GitHub cannot be used: ${problem}.`);
		else
			console.log(
				`[wlp] github: app ${app.slug} (id ${app.appId}) at ${app.webUrl}; users connect through ${GITHUB_CALLBACK_PATH} on this port`,
			);
	}
} catch (error) {
	// A setting that cannot be what it should be. The message names the variable and holds no value.
	console.error(
		`[wlp] the GitHub App's configuration is not usable: ${error instanceof Error ? error.message : "unknown error"}`,
	);
	process.exit(1);
}

// Linear, when the deployment has an OAuth app: said now, with a half-set configuration or a value that cannot be what it should be.
try {
	const { app, missing } = linearConfig();
	if (missing.length > 0)
		console.error(
			`[wlp] WARNING: Linear is off: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set while the other Linear settings are.`,
		);
	else if (app)
		console.log(
			`[wlp] linear: owners connect through ${LINEAR_CALLBACK_PATH}; webhooks to ${LINEAR_WEBHOOK_PATH} (callback address ${app.redirectUrl})`,
		);
} catch (error) {
	console.error(
		`[wlp] the Linear app's configuration is not usable: ${error instanceof Error ? error.message : "unknown error"}`,
	);
	process.exit(1);
}

try {
	const { app, missing } = gitlabConfig();
	if (missing.length > 0) console.error(`[wlp] WARNING: GitLab is off: missing ${missing.join(", ")}.`);
	else if (app) console.log(`[wlp] gitlab: owners connect through ${GITLAB_CALLBACK_PATH}`);
} catch {
	console.error("[wlp] the GitLab OAuth configuration is not usable: check the base and public URLs.");
	process.exit(1);
}

try {
	const { app, missing } = jiraConfig();
	if (missing.length) console.warn(`[wlp] WARNING: Jira is off: missing ${missing.join(", ")}.`);
	else if (app)
		console.log(
			`[wlp] jira: owners connect through ${JIRA_CALLBACK_PATH}; dynamic webhooks under ${JIRA_WEBHOOK_PATH}`,
		);
} catch {
	console.error("[wlp] the Jira app configuration is not usable.");
	process.exit(1);
}

// Billing (docs/billing.md): read once, so that a setting that is missing stops the server here, with its name.
try {
	const settings = billing();
	console.log(
		settings
			? `[wlp] billing: ${settings.provider.name}; webhooks to ${BILLING_WEBHOOK_PATH}`
			: "[wlp] billing: off (WLP_BILLING_PROVIDER is not set); the deployment's limits apply",
	);
} catch (error) {
	console.error(
		`[wlp] billing's configuration is not usable: ${error instanceof Error ? error.message : "unknown error"}`,
	);
	process.exit(1);
}

// The web app, where this server serves it too (WLP_WEB_DIR): its files, and its page for every address of the app.
const web = config.webDir
	? webFiles(config.webDir, {
			endpoint: config.browsers.endpoint ?? (config.engine.remote ? null : DEFAULT_ENDPOINT),
			publicUrl: process.env.WLP_PUBLIC_URL,
		})
	: null;
if (config.webDir) console.log(`[wlp] web app: served from ${config.webDir}`);

const linearWebhooks = linearWebhookRoute({ dispatch: dispatchLinearDelivery });

async function route(request: Request): Promise<Response> {
	const { pathname } = new URL(request.url);
	// Windlass's model requests from E2B sandboxes (docs/model-relay.md): on the relay's own hostname, and only there; nothing else is.
	const relayRoute = modelRelayRoute(request, pathname, relayHost);
	if (relayRoute) return relayRoute;
	if (pathname.startsWith("/platform/login/")) return loginResponse(request, pathname.slice("/platform/login/".length));
	if ([RETENTION_PATH, RUNNER_PAIR_PATH, RUNNER_PAIR_POLL_PATH, RUNNER_CONNECTION_PATH].includes(pathname))
		return runnerResponse(request);
	if (CONNECT_ROUTE_PATHS.includes(pathname)) return connectResponse(request);
	if (pathname === PLATFORM_INFO_PATH) return platformInfoResponse(request);
	if (pathname === INSTALL_SCRIPT_PATH) return installScriptResponse(request);
	const api = await apiRoute(request);
	if (api) return api;
	if (pathname === PLATFORM_CONNECTION_PATH) return platformConnectionResponse(request);
	// Where GitHub sends a user's browser back to when they connect: the GitHub App's callback URL.
	if (pathname === GITHUB_CALLBACK_PATH) return githubCallbackResponse(request);
	if (pathname === "/github/webhook") return (await webhookRoute(request))!;
	if (pathname === GITLAB_WEBHOOK_PATH) return receiveGitlabWebhook(request);
	if (pathname === GITLAB_CALLBACK_PATH) return gitlabCallbackResponse(request, { store: actorGitlabConnectStore });
	// Linear's: where its authorization sends the owner's browser back to, and its signed webhook deliveries (docs: factory.md). Not found where Linear is off.
	if (pathname === LINEAR_CALLBACK_PATH) return linearCallbackResponse(request, { store: actorLinearConnectStore });
	if (pathname === LINEAR_WEBHOOK_PATH) return (await linearWebhooks(request))!;
	if (pathname === JIRA_CALLBACK_PATH) return jiraCallbackResponse(request);
	if (pathname === JIRA_WEBHOOK_PATH || pathname.startsWith(`${JIRA_WEBHOOK_PATH}/`)) return jiraWebhookRoute(request);
	if (pathname === "/slack/callback") return slackCallbackResponse(request);
	if (pathname === SLACK_EVENTS_PATH || pathname === SLACK_COMMANDS_PATH) return slackWebhookRoute(request);
	if (pathname === SLACK_INTERACTIONS_PATH) return slackInteractionRoute(request);
	// The payment provider's webhooks (docs/billing.md); not found where billing is off.
	if (pathname === BILLING_WEBHOOK_PATH) return billingWebhookRoute(request);
	// For a load balancer or the host's health check: the node's own view of its connection to the engine.
	if (pathname === "/health") return registry.routes.health();
	// The SPA reads OAuth parameters from the browser address. Static serving only needs the path.
	const pageRequest =
		pathname === "/signin" ? new Request(new URL(pathname, request.url), { method: request.method }) : request;
	const page = web ? await web(pageRequest) : null;
	if (page) return page;
	return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

registry
	.listen({ port: config.httpPort, host: config.httpHost, application: { fetch: route } })
	.catch((error: unknown) => {
		console.error("[wlp] the server could not start:", error instanceof Error ? error.message : error);
		process.exit(1);
	});
