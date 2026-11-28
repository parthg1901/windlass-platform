import { createHash } from "node:crypto";
import { config, gitlabClientSecret, gitlabConfig } from "../config.js";
import { serverSealer } from "../signin/seal.js";
import { GITLAB_SCOPES, GitlabApp, GitlabError, type GitlabToken } from "./app.js";

export const GITLAB_CALLBACK_PATH = "/gitlab/callback";
/** The error code for a grant GitLab refused: only the owner reconnecting can help. */
export const GITLAB_RECONNECT = "gitlab_reconnect";
export function gitlabApp(): GitlabApp | null {
	const { app } = gitlabConfig();
	return app && new GitlabApp(app, { clientSecret: gitlabClientSecret });
}

export type GitlabClaim =
	| { ok: true; uid: string; origin: string; nonce: string; verifier: string }
	| { ok: false; reason: "state" | "used"; origin: string | null };
export interface GitlabConnectStore {
	claim(state: string): Promise<GitlabClaim>;
}
export interface GitlabConnectDeps {
	store: GitlabConnectStore;
	app?: GitlabApp | null;
	origins?: string[];
}
interface Ticket {
	nonce: string;
	token: GitlabToken;
	viewerId: string;
	issuer: string;
}
export const issuerOf = (app: GitlabApp) => JSON.stringify([app.settings.baseUrl, app.settings.clientId]);
/** The GitLab instance as a directory key (`surfaceAccounts`): its users' ids are the instance's. */
export const gitlabTenant = (app: GitlabApp) =>
	createHash("sha256").update(app.settings.baseUrl).digest("hex").slice(0, 32);
const subject = (uid: string) => `gitlab-connect\n${uid}`;
export function openGitlabTicket(uid: string, blob: string): Ticket {
	return JSON.parse(serverSealer().open("transit", subject(uid), blob));
}

/** Exchange only after a one-time claim. Finishing still needs the initiating Windlass user's session. */
export async function gitlabCallbackResponse(request: Request, deps: GitlabConnectDeps): Promise<Response> {
	const app = deps.app === undefined ? gitlabApp() : deps.app;
	if (!app) return new Response(null, { status: 404 });
	if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
	const origins = deps.origins ?? config.origins;
	const back = (origin: string | null, fragment: string) => {
		const home = origin && origins.includes(origin) ? origin : origins[0];
		return home
			? new Response(null, {
					status: 302,
					headers: {
						location: `${home}/settings#${fragment}`,
						"cache-control": "no-store",
						"referrer-policy": "no-referrer",
					},
				})
			: new Response(null, { status: 400 });
	};
	const params = new URL(request.url).searchParams;
	const state = params.get("state");
	let origin: string | null = null;
	try {
		if (!state || state.length > 8192) return back(null, "gitlab-error=state");
		const claim = await deps.store.claim(state);
		origin = claim.origin;
		if (!claim.ok) return back(origin, `gitlab-error=${claim.reason}`);
		if (!origins.includes(claim.origin)) return back(null, "gitlab-error=state");
		if (params.has("error")) return back(origin, "gitlab-error=denied");
		const code = params.get("code");
		if (!code || code.length > 2048) return back(origin, "gitlab-error=code");
		const token = await app.exchangeCode(code, claim.verifier);
		if (!GITLAB_SCOPES.every(scope => token.scopes.includes(scope))) return back(origin, "gitlab-error=scope");
		const viewer = await app.viewer(token.accessToken);
		const ticket: Ticket = { nonce: claim.nonce, token, viewerId: String(viewer.id), issuer: issuerOf(app) };
		return back(origin, `gitlab=${serverSealer().seal("transit", subject(claim.uid), JSON.stringify(ticket))}`);
	} catch (error) {
		return back(
			origin,
			error instanceof GitlabError && error.status === 0 ? "gitlab-error=unreachable" : "gitlab-error=failed",
		);
	}
}
