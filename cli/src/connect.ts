/**
 * `connect claude` and `connect codex`, `gh auth login`-style: the platform opens a request and gives a code; the
 * user approves that code on the platform's web page, signed in there; only then does this get the plan's secret on
 * this computer (`claude setup-token`'s token, or the files of a ChatGPT sign-in through Windlass) and hand it over,
 * once, to the account that approved. The secret is never printed, logged or stored here.
 */
import {
	CONNECT_PATHS,
	type ConnectRequestState,
	type ConnectStart,
	type PlanProvider,
	type SignInUpload,
	validPlanToken,
} from "../../server/src/contract/connect.ts";
import { CliError, post } from "./platform.ts";
import { runSetupToken } from "./setup-token.ts";
import { openBrowser, printable, readHidden, say } from "./terminal.ts";
import { windlassSignIn } from "./windlass-login.ts";

/** What is handed to the platform: a Claude plan's token, or a ChatGPT sign-in's files (which the platform then refreshes). */
export type Handover = { token: string } | { signIn: SignInUpload };

/**
 * What `connect <name>` connects: the plan's provider on the platform and how this computer gets what it hands
 * over. Connecting a machine (`connect --machine`) is its own flow beside this one.
 */
export interface PlanSource {
	provider: PlanProvider;
	name: string;
	/** Gets the plan's secret on this computer, after the user approved. */
	obtain(): Promise<Handover>;
}

export const PLAN_SOURCES: Record<string, PlanSource> = {
	claude: { provider: "anthropic", name: "Claude plan", obtain: async () => ({ token: await claudeToken() }) },
	codex: { provider: "openai", name: "ChatGPT plan", obtain: async () => ({ signIn: await chatgptSignIn() }) },
};

/** What the platform's refusals mean for the person at the terminal. */
const REFUSALS: Record<string, string> = {
	bad_plan_token: "That is not a setup token (it starts with sk-ant-oat01-). Run the command again.",
	bad_sign_in: "Windlass did not save a finished ChatGPT sign-in. Run the command again.",
	plan_refused: "Anthropic did not accept that token. Run the command again to make a new one.",
	plan_check_unavailable: "Anthropic could not be reached to check the plan. Run the command again in a minute.",
	plans_off: "Connecting this plan is not available on this account. Ask the platform's operator.",
	connect_code_not_found: "This connect request expired or was already used. Run the command again.",
	too_many_connects: "The platform has too many connect requests open. Try again in a minute.",
	rate_limited: "Too many connect attempts from this network. Try again in a minute.",
	origin_not_allowed: "The platform refused this request.",
};

function refusal(answer: { status: number; body: Record<string, unknown> }): CliError {
	const code = typeof answer.body.code === "string" ? answer.body.code : "";
	return new CliError(REFUSALS[code] ?? `The platform answered HTTP ${answer.status}. Try again.`);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const USER_CODE = /^[0-9A-Z]{4}-[0-9A-Z]{4}$/;
/** Consecutive unreachable or failing polls before giving up. */
const POLL_FAILURES = 15;

function parseStart(body: Record<string, unknown>): ConnectStart | null {
	const { userCode, approveUrl, request, expiresAt, interval } = body;
	if (typeof userCode !== "string" || !USER_CODE.test(userCode)) return null;
	if (typeof approveUrl !== "string" || !/^https?:\/\//.test(approveUrl)) return null;
	if (typeof request !== "string" || typeof expiresAt !== "number") return null;
	return { userCode, approveUrl, request, expiresAt, interval: typeof interval === "number" ? interval : 2_000 };
}

export interface ConnectOptions {
	platform: string;
	/** A Claude plan's token read from standard input (`--token-stdin`) instead of running `claude setup-token`. */
	token?: string;
	browser: boolean;
}

export async function connectPlan(source: PlanSource, options: ConnectOptions): Promise<void> {
	if (options.token !== undefined && !validPlanToken(source.provider, options.token))
		throw new CliError("Standard input does not hold a setup token (it starts with sk-ant-oat01-).");
	const started = await post(options.platform, CONNECT_PATHS.start, { provider: source.provider });
	if (started.status !== 201) throw refusal(started);
	const request = parseStart(started.body);
	if (!request) throw new CliError("The platform's answer was not understood. Is this a Windlass platform?");

	say(`First, approve this in your browser. Check that the page shows the code ${request.userCode}`);
	const url = printable(request.approveUrl);
	if (options.browser && (await openBrowser(request.approveUrl))) say(`Opened ${url}`);
	else say(`Open this page in a browser where you are signed in to Windlass:\n\n  ${url}\n`);
	say("Waiting for approval…");

	const state = await waitForDecision(options.platform, request);
	if (state === "denied") throw new CliError("The request was denied in the browser. Nothing was connected.");
	if (state === "expired") throw new CliError("The code expired before it was approved. Run the command again.");

	say("Approved.");
	let handover: Handover | null = options.token !== undefined ? { token: options.token } : await source.obtain();
	const body = { request: request.request, ...handover };
	handover = null;
	let connected = await post(options.platform, CONNECT_PATHS.connect, body);
	// The provider could not be reached to check it: the platform kept the request, so the same body is handed again.
	for (let again = 1; again <= CHECK_RETRIES && checkUnavailable(connected); again++) {
		await sleep(pollInterval(request) * 2 * again);
		connected = await post(options.platform, CONNECT_PATHS.connect, body);
	}
	if (connected.status !== 200) throw refusal(connected);
	const account = typeof connected.body.account === "string" ? printable(connected.body.account) : "";
	say(`Connected: ${account || `your ${source.name}`}`);
}

/** How many more times a handover is tried while the provider cannot be reached to check it. */
const CHECK_RETRIES = 3;

function checkUnavailable(answer: { status: number; body: Record<string, unknown> }): boolean {
	return answer.status === 503 && answer.body.code === "plan_check_unavailable";
}

const pollInterval = (request: ConnectStart) => Math.min(Math.max(request.interval, 1_000), 10_000);

async function waitForDecision(platform: string, request: ConnectStart): Promise<ConnectRequestState> {
	const interval = pollInterval(request);
	// The platform decides when the request expires; this only stops a poll that never hears back.
	const giveUp = Date.now() + 15 * 60_000;
	let failures = 0;
	while (Date.now() < giveUp) {
		await sleep(interval);
		let answer: Awaited<ReturnType<typeof post>>;
		try {
			answer = await post(platform, CONNECT_PATHS.poll, { request: request.request });
		} catch (error) {
			if (++failures >= POLL_FAILURES) throw error;
			continue;
		}
		if (answer.status === 429) {
			await sleep(Math.max(answer.retryAfter, 1) * 1_000);
			continue;
		}
		if (answer.status >= 500) {
			if (++failures >= POLL_FAILURES) throw refusal(answer);
			continue;
		}
		if (answer.status !== 200) throw refusal(answer);
		failures = 0;
		const state = answer.body.state;
		if (state === "approved" || state === "denied" || state === "expired") return state;
	}
	return "expired";
}

/** Signs in with ChatGPT through Windlass on this computer, in a directory of its own (windlass-login.ts). */
async function chatgptSignIn(): Promise<SignInUpload> {
	say(
		"Signing in with ChatGPT through Windlass on this computer, in a private directory: your own Windlass sign-in is not touched.",
	);
	say("Approve Windlass in the browser it opens (or follow the link it prints).\n");
	const signIn = await windlassSignIn();
	say("\nSigned in. Handing the sign-in to the platform, which keeps and refreshes it.");
	return signIn;
}

/** Runs `claude setup-token`; falls back to a hidden paste when the token could not be read off its output. */
export async function claudeToken(): Promise<string> {
	say("Running claude setup-token. Sign in to Claude there; the token it prints comes back here.\n");
	const run = await runSetupToken();
	if (run.token && validPlanToken("anthropic", run.token)) {
		say("\nRead the setup token from claude setup-token.");
		return run.token;
	}
	if (!process.stdin.isTTY)
		throw new CliError(
			"No setup token was found in the output of claude setup-token. Run it yourself and pass the token with --token-stdin.",
		);
	say(run.captured ? "\nThe token could not be read from the output." : "");
	for (let attempt = 0; attempt < 3; attempt++) {
		const pasted = await readHidden("Paste the token claude setup-token printed (sk-ant-oat01-…, hidden): ");
		if (validPlanToken("anthropic", pasted)) return pasted;
		say("That is not a setup token. It starts with sk-ant-oat01-.");
	}
	throw new CliError("No setup token was given. Nothing was connected.");
}
