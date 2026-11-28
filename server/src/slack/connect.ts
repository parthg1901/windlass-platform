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

/** Sign in with Slack as oneself, read-only (`openid profile`), to link that Slack user: the address to send the browser to. */
export function authorizeSlackLink(uid: string, nonce: string, origin: string) {
	const app = settings();
	const state = serverSealer().seal("transit", "slack-state", JSON.stringify({ uid, nonce, origin, link: true }));
	const url = new URL("/openid/connect/authorize", app.url);
	url.search = new URLSearchParams({
		response_type: "code",
		scope: "openid profile",
		client_id: app.clientId,
		redirect_uri: app.redirectUrl,
		state,
		nonce,
	}).toString();
	return { url: url.href };
}
export const slackLinkSubject = (uid: string) => `slack-link:${uid}`;

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
			const code = params.get("code"),
				denied = params.get("error") === "access_denied";
			// A sign-in to link a Slack user comes back as a ticket only the user who began it can redeem (`linkAccount`).
			if (state.link === true)
				fragment = code
					? "link-return=slack-signin." +
						serverSealer().seal("transit", slackLinkSubject(state.uid), JSON.stringify({ code, nonce: state.nonce }))
					: `link-error=slack.${denied ? "denied" : "failed"}`;
			else
				fragment = code
					? "slack=" +
						serverSealer().seal("transit", `slack-code:${state.uid}`, JSON.stringify({ code, nonce: state.nonce }))
					: denied
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
