/**
 * One real model request of hosted Windlass on the ChatGPT plan from an E2B sandbox (docs/model-relay.md), the
 * whole way a hosted E2B turn takes it:
 *
 *   E2B microVM: real Windlass, its token file holding a placeholder  ->  the plan relay inside the microVM,
 *     run as the transport user and handed the token on its standard input  ->  api.openai.com
 *
 * The server's route (behind the relay's own hostname) stays up for Settings keys; this turn must not use it.
 *
 * It starts the platform server in this process, on ports of its own with its own storage (the fake
 * sandbox layer, so nothing of a deployment is used), and puts it behind a Cloudflare quick tunnel
 * (`cloudflared tunnel --url`, no account) as WLP_MODEL_RELAY_URL. It makes one E2B sandbox from the
 * template, under `restricted` (its plan host allowed for its relay), and runs one turn through the platform's
 * own turn code (plan relay, placeholder file): "Reply with exactly: relay ok".
 * That is one short model call, plus Windlass's model list.
 *
 *   cd server && E2B_API_KEY=e2b_... WLP_RELAY_CHECK_TOKEN_FILE=/path/token.json npx tsx ../scripts/model-relay-e2b-check.ts
 *
 * WLP_RELAY_CHECK_TOKEN_FILE holds what `windlass login token --json` prints, run where a ChatGPT
 * sign-in is saved: `{"accessToken": ..., "expiresAt": ...}`, mode 600. Nothing else of the sign-in is
 * read. The token is handed to the relay only; the check fails if it is found in the sandbox.
 *
 * Optional: WLP_E2B_NETWORK (`restricted` by default, `none`, or `open`), WLP_RELAY_CHECK_MODEL (the
 * account's default otherwise), WLP_RELAY_CHECK_URL with WLP_RELAY_CHECK_HTTP_PORT (a hostname of your
 * own already routed to that local port, instead of a quick tunnel), WLP_E2B_TEMPLATE.
 *
 * Limits on itself: one sandbox, killed in `finally` by this run's own deployment label; a hard limit of
 * five minutes (exit 3); exit 2 without the key or the token file. Exit 0 when every check passed.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccessToken, AccessTokens, ChatgptLogins, TurnQuestion } from "../server/src/sandbox/api.js";
import type { WindlassEvent } from "../server/src/contract.js";
import { sleep } from "./check-wait.js";

const LIMIT_MS = 5 * 60_000;
let passes = 0;
let failures = 0;
const oneLine = (text: string) =>
	text
		.trim()
		.replace(/\s*\n\s*/g, " | ")
		.slice(0, 1500);
function expect(name: string, ok: boolean, detail = ""): boolean {
	if (ok) passes += 1;
	else failures += 1;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${oneLine(detail)})` : ""}`);
	return ok;
}

const apiKey = (process.env.E2B_API_KEY ?? "").trim();
const tokenFile = (process.env.WLP_RELAY_CHECK_TOKEN_FILE ?? "").trim();
if (apiKey === "" || tokenFile === "") {
	console.error(
		"model-relay-e2b-check: set E2B_API_KEY and WLP_RELAY_CHECK_TOKEN_FILE (what `windlass login token --json` prints, in a file). Nothing was done.",
	);
	process.exit(2);
}
let token: AccessToken;
try {
	const read = JSON.parse(readFileSync(tokenFile, "utf8")) as AccessToken;
	if (typeof read.accessToken !== "string" || read.accessToken.length < 16 || typeof read.expiresAt !== "number")
		throw new Error("not {accessToken, expiresAt}");
	if (read.expiresAt < Date.now() + 10 * 60_000) throw new Error("it expires within ten minutes; make a new one");
	token = read;
} catch (error) {
	console.error(
		`model-relay-e2b-check: WLP_RELAY_CHECK_TOKEN_FILE cannot be used: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(2);
}

const hardStop = setTimeout(() => {
	console.log("FAIL  the check ran past its five minutes");
	void cleanup().finally(() => process.exit(3));
}, LIMIT_MS);
hardStop.unref();

const enginePort = 6720,
	httpPort = Number(process.env.WLP_RELAY_CHECK_HTTP_PORT || 6745);
const storage = mkdtempSync(join(tmpdir(), "wlp-relay-e2b-check-"));
let tunnel: ChildProcess | null = null;
let killSandboxes: () => Promise<void> = async () => {};
async function cleanup(): Promise<void> {
	await killSandboxes().catch((error: unknown) =>
		console.log(`WARN  the sandbox could not be removed: ${String(error)}`),
	);
	tunnel?.kill();
	rmSync(storage, { recursive: true, force: true });
}

/** The relay's own hostname: a quick tunnel to the server's port, or the one given. */
async function relayOrigin(): Promise<string> {
	const given = (process.env.WLP_RELAY_CHECK_URL ?? "").trim();
	if (given) return given.replace(/\/+$/, "");
	tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${httpPort}`], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	return await new Promise<string>((resolve, reject) => {
		let said = "";
		const timer = setTimeout(
			() => reject(new Error(`cloudflared gave no quick tunnel within 60 s: ${said.slice(-500)}`)),
			60_000,
		);
		tunnel!.on("error", error =>
			reject(new Error(`cloudflared could not be started (${error.message}); install it, or set WLP_RELAY_CHECK_URL`)),
		);
		tunnel!.stderr!.on("data", chunk => {
			said += String(chunk);
			const found = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(said);
			if (found) {
				clearTimeout(timer);
				resolve(found[0]);
			}
		});
	});
}

try {
	const origin = await relayOrigin();
	const mode = (process.env.WLP_E2B_NETWORK ?? "restricted").trim() || "restricted";
	console.log(`model-relay-e2b-check: relay ${origin}, E2B network ${mode}`);
	Object.assign(process.env, {
		WLP_DEMO: "1",
		WLP_SANDBOX: "fake",
		WLP_SECRET: randomBytes(24).toString("hex"),
		RIVETKIT_STORAGE_PATH: storage,
		RIVET_RUN_ENGINE_PORT: String(enginePort),
		WLP_HTTP_PORT: String(httpPort),
		WLP_MODEL_RELAY: "on",
		WLP_MODEL_RELAY_URL: origin,
		WLP_E2B_WINDLASS_VERSION: process.env.WLP_E2B_WINDLASS_VERSION || "0.7.1",
		WLP_E2B_NETWORK: mode,
	});
	for (const name of ["RIVET_ENDPOINT", "RIVET_ADMIN_TOKEN", "WLP_PUBLIC_ENDPOINT", "WLP_E2B_NETWORK_ALLOW"])
		delete process.env[name];

	// What reaches api.openai.com from the route, seen without changing it.
	const upstream: { url: string; status: number }[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const response = await realFetch(input, init);
		if (String(input).startsWith("https://api.openai.com/"))
			upstream.push({ url: String(input), status: response.status });
		return response;
	}) as typeof fetch;
	const relayLines: string[] = [];
	const warn = console.warn;
	console.warn = (...args: unknown[]) => {
		const line = args.map(String).join(" ");
		if (line.includes("model_relay.")) relayLines.push(line);
		warn(...args);
	};

	await import("../server/src/index.js");
	for (
		let i = 0;
		i < 300 &&
		!(await realFetch(`http://127.0.0.1:${httpPort}/health`).then(
			r => r.ok,
			() => false,
		));
		i++
	)
		await sleep(400);

	// The tunnel answers for the route: a placeholder of no turn is refused as the relay's own.
	let reached = "";
	for (let i = 0; i < 60 && !reached.includes("relay_lease_ended"); i++) {
		reached = await realFetch(`${origin}/model-relay/v1/models`, {
			headers: { authorization: "Bearer wlpm1.none" },
		}).then(
			r => r.text(),
			(e: unknown) => String(e),
		);
		if (!reached.includes("relay_lease_ended")) await sleep(1000);
	}
	expect(
		"the relay's hostname reaches this server's route through Cloudflare",
		reached.includes("relay_lease_ended"),
		reached.slice(0, 200),
	);

	const { readE2bSettings } = await import("../server/src/sandbox/e2b/config.js");
	const { createE2bSdkClient } = await import("../server/src/sandbox/e2b/sdk.js");
	const { createE2bSandboxLayer } = await import("../server/src/sandbox/e2b/index.js");
	const { cleanupDeployment } = await import("../server/src/sandbox/e2b/cleanup.js");
	const { DATA_DIR, randomId } = await import("../server/src/sandbox/provider.js");
	const deployment = `relaycheck-${randomId(4)}`;
	const settings = {
		...readE2bSettings(),
		deployment,
		maxRunning: 1,
		pause: false,
		windlassSandbox: false,
		openProfile: false,
	};
	expect(
		"the E2B settings send Windlass's model requests to the relay, and the network allows its host and not api.openai.com",
		settings.modelRelayOrigin === origin &&
			(mode === "open" ||
				(settings.network?.hosts.includes(new URL(origin).hostname) === true &&
					!settings.network.hosts.includes("api.openai.com"))),
		`${settings.modelRelayOrigin ?? settings.modelRelayOff}; ${settings.network?.mode}: ${settings.network?.hosts.join(",")}`,
	);
	const client = createE2bSdkClient(apiKey);
	killSandboxes = async () => {
		await cleanupDeployment(client, deployment, { kill: true });
	};
	const tokens: AccessTokens = { current: async () => ({ ...token }) };
	const layer = createE2bSandboxLayer(
		{ logins: {} as ChatgptLogins, tokens },
		{ client, settings, log: line => console.log(`      ${line}`) },
	);
	const id = await layer.sandboxes.create({
		uid: "relay-check",
		sessionId: `relay-check-${deployment}`,
		profile: "e2b",
	});
	const handle = await layer.sandboxes.connect(id);
	expect(
		"the sandbox offers a plan relay inside it",
		handle !== undefined && typeof (handle as { localPlanRelay?: unknown }).localPlanRelay === "function",
	);
	if (handle === undefined) throw new Error("the sandbox could not be connected");

	const events: WindlassEvent[] = [];
	const began = Date.now();
	const result = await layer.windlass.runTurn(handle, {
		modelKey: {
			sessionId: `relay-check-${deployment}`,
			key: { provider: "openai", plan: true, generation: "relay-check" },
			openSecret: async () => ({ secret: token.accessToken, expiresAt: token.expiresAt }),
		},
		prompt: "Reply with exactly: relay ok",
		...(process.env.WLP_RELAY_CHECK_MODEL ? { model: process.env.WLP_RELAY_CHECK_MODEL } : {}),
		onEvent: event => events.push(event),
		onQuestion: async (question: TurnQuestion) => ({
			choice: question.choices.find(choice => choice.approve)?.id ?? question.choices[0]?.id ?? "",
		}),
	});
	const said = JSON.stringify(events);
	const ms = Date.now() - began;
	expect(
		"a real Windlass turn in E2B answers through the relay",
		result.failure === null && /relay ok/i.test(said),
		`${ms} ms, failure ${JSON.stringify(result.failure)}, stderr ${result.stderrTail?.slice(-400)}`,
	);
	expect(
		"its model call left from the sandbox: nothing of it went through the server's route",
		!upstream.some(u => u.url.endsWith("/v1/responses")),
		JSON.stringify(upstream),
	);
	expect(
		"the relay refused or failed nothing on the way",
		!relayLines.some(
			line =>
				line.includes("model_relay.failed") && !line.includes("wlpm1.none") && !/placeholder is not valid/.test(line),
		),
		relayLines.join(" | "),
	);
	// What a command in the sandbox can read: the token must be in none of it. Searched here, never sent there.
	const scan = await handle.run(
		`for f in /proc/[0-9]*/environ /proc/[0-9]*/cmdline; do cat "$f" 2>/dev/null; echo; done; find ${DATA_DIR} /tmp /workspace /home/agent /dev/shm -xdev -type f -readable -size -2M -exec cat {} + 2>/dev/null; true`,
		{ timeoutMs: 60_000 },
	);
	expect(
		"the access token is nowhere in the sandbox",
		scan.stdout.length > 0 && !scan.stdout.includes(token.accessToken),
		`${scan.stdout.length} bytes read`,
	);
} catch (error) {
	expect("the check ran", false, error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
	await cleanup();
}
console.log(`\nmodel-relay-e2b-check: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
