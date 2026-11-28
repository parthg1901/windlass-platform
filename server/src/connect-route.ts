/**
 * The connect command's HTTP routes (`CONNECT_PATHS`), `gh auth login`-style and without signing in:
 * `start` opens a request and answers the code the terminal shows; the user approves that code on the web
 * page (credentials/index.ts `approvePlanConnect`); the terminal polls `poll`, and only once approved runs
 * `claude setup-token` (a Claude plan) or Windlass's own sign-in (a ChatGPT plan) and posts the token or the
 * sign-in's files to `connect`, which takes the approved request once and hands them, sealed, to the approving
 * user's actor. A body that is not a token or a finished sign-in at all, or one for the other plan, is refused
 * before the request is taken, so a typo does not cost it; nor does a provider that could not be reached to check it.
 */

import { createClient } from "rivetkit/client";
import type { TakenRequest } from "./actors/connect-codes.js";
import { isActorGone, planConnectActor } from "./actors/internal.js";
import { assertOrigin, serviceParams } from "./auth.js";
import { config, ownEngineEndpoint } from "./config.js";
import {
	CONNECT_PATHS,
	type ConnectRequestState,
	type ConnectStart,
	isPlanProvider,
	type PlanProvider,
	validPlanToken,
} from "./contract.js";
import { connectCodeDigest, connectTransitSubject, newConnectRequest } from "./credentials/connect-code.js";
import { uploadedSignIn } from "./credentials/index.js";
import { AddressBudget, clientAddress, rateLimited, readJsonBody } from "./http-limits.js";
import type { Registry } from "./registry.js";
import { serverSealer } from "./signin/seal.js";

export const CONNECT_ROUTE_PATHS: readonly string[] = Object.values(CONNECT_PATHS);
/** How often the terminal polls, like a runner's pairing poll. */
const POLL_INTERVAL_MS = 2_000;
const REFUSALS = /^(bad_plan_token|bad_sign_in|plan_refused|plan_check_unavailable|plans_off)$/;
/** A token fits in a few kilobytes; a sign-in's files (`SignInUpload`) in a few more, escaped as JSON. */
const MAX_BODY_BYTES = 4096;
const MAX_SIGN_IN_BODY_BYTES = 256 * 1024;

const budget = new AddressBudget(config.httpLimits.connect);
const polls = new AddressBudget(config.httpLimits.connectPoll);
const json = (status: number, body: unknown) =>
	Response.json(body, { status, headers: { "cache-control": "no-store" } });
const expired = () =>
	json(404, {
		code: "connect_code_not_found",
		message: "This connect request expired or was already used. Run the command again.",
	});

type Engine = () => ReturnType<typeof createClient<Registry>>;
let client: ReturnType<Engine> | undefined;
const ownEngine: Engine = () => (client ??= createClient<Registry>({ endpoint: ownEngineEndpoint() }));
const requests = (engine: Engine) => engine().connectCodes.getOrCreate(["codes"], { params: serviceParams() });

const plansOff = () => config.plans !== "all" && config.plans.size === 0;

/** `engine` is the actor client; checks pass a stand-in. */
export async function connectResponse(request: Request, engine: Engine = ownEngine): Promise<Response> {
	if (request.method !== "POST") return json(405, { code: "method_not_allowed" });
	try {
		assertOrigin({ request });
	} catch {
		return json(403, { code: "origin_not_allowed" });
	}
	const { pathname } = new URL(request.url);
	const admission = (pathname === CONNECT_PATHS.poll ? polls : budget).take(clientAddress(request));
	if (admission) return rateLimited(admission, "Too many connect attempts from this address. Try again later.");
	const body = await readJsonBody(
		request,
		pathname === CONNECT_PATHS.connect ? MAX_SIGN_IN_BODY_BYTES : MAX_BODY_BYTES,
	);
	if (body instanceof Response) return body;
	const input = body.value as { provider?: unknown; request?: unknown; token?: unknown; signIn?: unknown } | null;
	try {
		if (pathname === CONNECT_PATHS.start) return await start(engine, input?.provider);
		const digest = connectCodeDigest.ofRequest(input?.request);
		if (!digest) return json(400, { code: "bad_input" });
		if (pathname === CONNECT_PATHS.poll) {
			const state: ConnectRequestState = await requests(engine).internalPoll(digest);
			return json(200, { state });
		}
		return await connect(engine, digest, input);
	} catch (error) {
		const refused = error as { code?: unknown; message?: unknown } | null;
		if (typeof refused?.code === "string" && REFUSALS.test(refused.code))
			return json(refused.code === "plan_check_unavailable" ? 503 : 400, {
				code: refused.code,
				message: String(refused.message),
			});
		if (isActorGone(error)) return expired();
		console.error(`[wlp] plan_connect.failed (${error instanceof Error ? error.name : "unknown"})`);
		return json(500, { code: "internal_error", message: "The plan could not be connected. Try again." });
	}
}

async function start(engine: Engine, provider: unknown): Promise<Response> {
	if (!isPlanProvider(provider)) return json(400, { code: "bad_input" });
	// The ChatGPT sign-in is Windlass's for every user; WLP_PLAN_USERS gates only what pays for hosted agents with it.
	if (provider === "anthropic" && plansOff())
		return json(404, { code: "plans_off", message: "Connecting a plan is not available on this platform." });
	const opened = newConnectRequest();
	const expiresAt: number | null = await requests(engine).internalStart(
		connectCodeDigest.ofRequest(opened.request)!,
		connectCodeDigest.ofUserCode(opened.userCode)!,
		provider,
	);
	if (expiresAt === null)
		return rateLimited(60, "Too many connect requests are open. Try again in a minute.", "too_many_connects");
	const approveUrl = `${config.origins[0]}/connect?${new URLSearchParams({ code: opened.userCode, plan: provider })}`;
	const answer: ConnectStart = { ...opened, approveUrl, expiresAt, interval: POLL_INTERVAL_MS };
	return json(201, answer);
}

/** What was handed over, checked as far as it can be before the request is taken: the secret to seal, and for which plan. */
function handedOver(
	input: { token?: unknown; signIn?: unknown } | null,
): { provider: PlanProvider; secret: string } | null {
	if (input?.signIn !== undefined) {
		const secret = JSON.stringify(input.signIn);
		uploadedSignIn(secret);
		return { provider: "openai", secret };
	}
	return validPlanToken("anthropic", input?.token) ? { provider: "anthropic", secret: input.token } : null;
}

async function connect(
	engine: Engine,
	digest: string,
	input: { token?: unknown; signIn?: unknown } | null,
): Promise<Response> {
	const handed = handedOver(input);
	if (!handed)
		return json(400, { code: "bad_plan_token", message: "That's not a setup token. It starts with sk-ant-oat01-." });
	const owner: TakenRequest | "other_plan" | null = await requests(engine).internalTake(digest, handed.provider);
	if (owner === "other_plan")
		return json(400, { code: "bad_plan_token", message: "That is not for the plan this request connects." });
	if (!owner) return expired();
	const sealed = serverSealer().seal(
		"transit",
		connectTransitSubject(owner.uid, owner.provider, digest),
		handed.secret,
	);
	try {
		const plan = await planConnectActor({ client: engine }, owner.uid).internalConnectPlan(
			owner.provider,
			digest,
			sealed,
		);
		return json(200, { account: plan.account });
	} catch (error) {
		// The provider could not be asked: the terminal may hand the same secret over again.
		if ((error as { code?: unknown } | null)?.code === "plan_check_unavailable")
			await requests(engine).internalUntake(owner);
		throw error;
	}
}
