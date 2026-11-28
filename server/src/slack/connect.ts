import { config, slackConfig } from "../config.js";
import { serverSealer } from "../signin/seal.js";
import { settings, SLACK_SCOPES } from "./app.js";

export function authorizeSlack(uid: string, nonce: string, origin: string) {
	const app = settings();
	const state = serverSealer().seal("transit", "slack-state", JSON.stringify({ uid, nonce, origin }));
	const url = new URL("/oauth/v2/authorize", app.url);
	url.search = new URLSearchParams({
		scope: SLACK_SCOPES.join(","),
		client_id: app.clientId,
		redirect_uri: app.redirectUrl,
		state,
	}).toString();
	return { url: url.href };
}

// Return the code to the signed-in account. Only it can redeem the sealed code and its pending nonce.
export function slackCallbackResponse(request: Request): Response {
	if (!slackConfig()) return new Response(null, { status: 404 });
	if (request.method !== "GET") return new Response(null, { status: 405 });
	let origin = config.origins[0],
		fragment = "slack-error=state";
	const params = new URL(request.url).searchParams;
	try {
		const state = JSON.parse(serverSealer().open("transit", "slack-state", params.get("state") ?? ""));
		if (config.origins.includes(state.origin)) {
			origin = state.origin;
			const code = params.get("code");
			fragment = code
				? "slack=" +
					serverSealer().seal("transit", `slack-code:${state.uid}`, JSON.stringify({ code, nonce: state.nonce }))
				: params.get("error") === "access_denied"
					? "slack-error=denied"
					: "slack-error=failed";
		}
	} catch {
		/* Invalid state returns to the configured Settings page. */
	}
	return new Response(null, {
		status: 302,
		headers: {
			location: `${origin}/settings#${fragment}`,
			"cache-control": "no-store",
			"referrer-policy": "no-referrer",
		},
	});
}
