import { createHash, randomBytes } from "node:crypto";
import { createClient, type Registry } from "../client.js";
import { serviceParams } from "../auth.js";
import { config, jiraConfig, ownEngineEndpoint } from "../config.js";
import { isActorGone } from "../actor-errors.js";
import { readSignedPayload } from "../signatures.js";
import { serverSealer } from "../signin/seal.js";

export const JIRA_CALLBACK_PATH = "/jira/callback";
export const digest = (key: string) => createHash("sha256").update(key).digest("hex");
let client: ReturnType<typeof createClient<Registry>> | undefined;
export const jiraActors = () => (client ??= createClient<Registry>({ endpoint: ownEngineEndpoint() }));

export async function jiraCallbackResponse(request: Request): Promise<Response> {
	if (!jiraConfig().app) return new Response(null, { status: 404 });
	if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
	const params = new URL(request.url).searchParams;
	const state = readSignedPayload(params.get("state"), "ji1", 8192, k => (k === "jira-state" ? "github-state" : null));
	const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
	const invalid = () =>
		new Response("Invalid or expired Jira connection. Connect again in Settings.", { status: 400, headers });
	if (
		!state ||
		typeof state.uid !== "string" ||
		typeof state.nonce !== "string" ||
		typeof state.origin !== "string" ||
		!config.origins.includes(state.origin) ||
		typeof state.exp !== "number" ||
		state.exp <= Date.now()
	)
		return invalid();
	const code = params.get("code"),
		ticket = randomBytes(32).toString("base64url");
	const sealed =
		!params.has("error") && code && code.length <= 4096
			? serverSealer().seal("transit", `jira:${state.uid}:${state.nonce}`, code)
			: null;
	try {
		const owner = jiraActors().user.get([state.uid], { params: serviceParams() });
		const result = await owner.internalJiraCallback(state.nonce, state.origin, sealed, digest(ticket));
		if (result === "invalid") return invalid();
		const failure = sealed
			? result
			: params.get("error") === "access_denied"
				? "denied"
				: params.has("error")
					? "failed"
					: "code";
		const fragment = result === "ready" ? `jira=${ticket}` : `jira-error=${failure}`;
		return new Response(null, {
			status: 302,
			headers: { ...headers, location: `${state.origin}/settings#${fragment}` },
		});
	} catch (error) {
		return isActorGone(error) ? invalid() : new Response(null, { status: 503, headers });
	}
}
