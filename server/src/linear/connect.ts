import { config } from "../config.js";
import { serverSealer } from "../signin/seal.js";
import {
	LINEAR_SCOPES,
	LinearApp,
	LinearError,
	type LinearIdentity,
	type LinearToken,
	type LinearWorkspace,
	linearApp,
	redactLinear,
} from "./app.js";

export const LINEAR_CALLBACK_PATH = "/linear/callback";

/** Why a connection did not come about: what the web app is sent back with, and turns into a sentence. */
export type LinearConnectFailure =
	/** The state is missing, forged or expired. */
	| "state"
	/** The state was used before. */
	| "used"
	/** The owner declined at Linear. */
	| "denied"
	/** Linear did not accept the code. */
	| "code"
	/** Linear did not grant all the requested scopes. */
	| "scope"
	/** The token Linear gave is a person's, not the app user's. */
	| "not_app"
	/** Linear could not be reached. */
	| "unreachable"
	| "failed";

interface LinearTicket {
	nonce: string;
	token: LinearToken;
	identity: LinearIdentity;
}

const ticketSubject = (uid: string) => `linear-connect\n${uid}`;

export function openLinearTicket(uid: string, ticket: string): LinearTicket {
	return JSON.parse(serverSealer().open("transit", ticketSubject(uid), ticket));
}

/** What a sign-in as oneself proved: the Linear person and workspace, for the user who began it. */
export interface LinearLinkTicket {
	nonce: string;
	person: { id: string; name: string };
	workspace: LinearWorkspace;
}

const linkSubject = (uid: string) => `linear-link\n${uid}`;

export function openLinearLinkTicket(uid: string, ticket: string): LinearLinkTicket {
	return JSON.parse(serverSealer().open("transit", linkSubject(uid), ticket));
}

export type LinearClaim =
	| { ok: true; uid: string; nonce: string; origin: string; verifier: string | null }
	| {
			ok: false;
			reason: "state" | "used" /** The web app's address, when the state was readable enough to name one. */;
			origin: string | null;
	  };

/** What the route needs of the user's actor. */
export interface LinearConnectStore {
	/** Checks the signed state and takes its number out of the user's list; it works once. */
	claim(state: string): Promise<LinearClaim>;
}

function redirect(location: string): Response {
	return new Response(null, {
		status: 302,
		headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
	});
}

/** Back to the web app, with what happened in the fragment: it is not sent to any server, and not kept in a log. */
const back = (origin: string, fragment: string) => redirect(`${origin}/settings#${fragment}`);
const failed = (origin: string, code: LinearConnectFailure) => back(origin, `linear-error=${code}`);

export interface LinearConnectDeps {
	store: LinearConnectStore;
	app?: LinearApp | null;
	origins?: string[];
	log?: (line: string) => void;
}

/** `GET /linear/callback`. Always answers with a redirect to the web app; without a Linear app the route does not exist. */
export async function linearCallbackResponse(request: Request, deps: LinearConnectDeps): Promise<Response> {
	const app = deps.app === undefined ? linearApp() : deps.app;
	const origins = deps.origins ?? config.origins;
	const log = deps.log ?? ((line: string) => console.log(line));
	if (!app)
		return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
	if (request.method !== "GET" && request.method !== "HEAD")
		return new Response("Use GET.\n", {
			status: 405,
			headers: { allow: "GET", "content-type": "text/plain; charset=utf-8" },
		});

	const params = new URL(request.url).searchParams;
	const home = origins[0] ?? "";
	const unreadable = () =>
		home === ""
			? new Response("This link to connect Linear is not valid any more. Go back to Windlass and connect again.\n", {
					status: 400,
					headers: { "content-type": "text/plain; charset=utf-8" },
				})
			: failed(home, "state");
	const state = params.get("state");
	if (state === null || state === "" || state.length > 8192) return unreadable();

	let claimed: LinearClaim;
	try {
		claimed = await deps.store.claim(state);
	} catch (error) {
		console.error(
			`[wlp] linear.connect.failed: ${redactLinear(error instanceof Error ? error.message : "unknown error")}`,
		);
		return unreadable();
	}
	if (!claimed.ok) {
		const origin = claimed.origin !== null && origins.includes(claimed.origin) ? claimed.origin : home;
		return origin === "" ? unreadable() : failed(origin, claimed.reason);
	}
	if (!origins.includes(claimed.origin)) return unreadable();
	const { uid, origin } = claimed;
	if (claimed.nonce.startsWith("link."))
		return linked(app, params, { uid, origin, nonce: claimed.nonce, verifier: claimed.verifier }, log);

	let token: LinearToken | null = null;
	try {
		if (params.get("error") !== null)
			return failed(origin, params.get("error") === "access_denied" ? "denied" : "failed");
		const code = params.get("code");
		if (code === null || code === "" || code.length > 2048) return failed(origin, "code");

		try {
			token = await app.exchangeCode(code, claimed.verifier);
		} catch (error) {
			if (error instanceof LinearError && !error.unreachable) {
				log(`[wlp] linear.connect.refused uid=${uid}: ${error.message}`);
				return failed(origin, "code");
			}
			throw error;
		}
		const missing = LINEAR_SCOPES.filter(scope => !token!.scopes.includes(scope));
		if (missing.length > 0) {
			log(`[wlp] linear.connect.scope uid=${uid}: not granted: ${missing.join(",")}`);
			return failed(origin, "scope");
		}

		let identity: LinearIdentity;
		try {
			identity = await app.identity(token.accessToken);
		} catch (error) {
			if (error instanceof LinearError && error.code === "not_app_user") {
				log(`[wlp] linear.connect.not_app uid=${uid}`);
				return failed(origin, "not_app");
			}
			throw error;
		}
		const ticket: LinearTicket = { nonce: claimed.nonce, token, identity };
		log(`[wlp] linear.connect.confirmed uid=${uid} workspace=${identity.workspace.id}`);
		return back(origin, `linear=${serverSealer().seal("transit", ticketSubject(uid), JSON.stringify(ticket))}`);
	} catch (error) {
		const unreachable = error instanceof LinearError && error.unreachable;
		console.error(
			`[wlp] linear.connect.failed uid=${uid}: ${redactLinear(error instanceof Error ? error.message : "unknown error", [token?.accessToken, token?.refreshToken])}`,
		);
		return failed(origin, unreachable ? "unreachable" : "failed");
	}
}

/**
 * The end of a sign-in as oneself (`linear/app.ts` `person`): the person's token proves who they are and is revoked at once.
 * The web app is sent back with a ticket only the user who began it can redeem (`linkAccount`, at once), or `link-error`.
 */
async function linked(
	app: LinearApp,
	params: URLSearchParams,
	claimed: { uid: string; origin: string; nonce: string; verifier: string | null },
	log: (line: string) => void,
): Promise<Response> {
	const { uid, origin } = claimed;
	const failure = (code: LinearConnectFailure) => back(origin, `link-error=linear.${code}`);
	if (params.get("error") !== null) return failure(params.get("error") === "access_denied" ? "denied" : "failed");
	const code = params.get("code");
	if (code === null || code === "" || code.length > 2048) return failure("code");
	let token: LinearToken | null = null;
	try {
		token = await app.exchangeCode(code, claimed.verifier);
		const { person, workspace } = await app.person(token.accessToken);
		const ticket: LinearLinkTicket = { nonce: claimed.nonce, person, workspace };
		log(`[wlp] linear.link.confirmed uid=${uid} workspace=${workspace.id}`);
		return back(
			origin,
			`link-return=linear.${serverSealer().seal("transit", linkSubject(uid), JSON.stringify(ticket))}`,
		);
	} catch (error) {
		const unreachable = error instanceof LinearError && error.unreachable;
		log(
			`[wlp] linear.link.failed uid=${uid}: ${redactLinear(error instanceof Error ? error.message : "unknown error", [token?.accessToken, token?.refreshToken])}`,
		);
		return failure(unreachable ? "unreachable" : error instanceof LinearError ? "code" : "failed");
	} finally {
		if (token) await app.revoke(token.accessToken).catch(() => undefined);
	}
}
