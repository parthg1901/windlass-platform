/**
 * A stand-in for the parts of GitHub the platform calls, for the checks: no GitHub App exists while
 * they run, and none may be called. One HTTP server on a loopback port that is, at once,
 *
 *   GitHub itself      `/login/oauth/authorize`, `/login/oauth/access_token`,
 *                      `/apps/<slug>/installations/new`, and a git remote over smart HTTP at
 *                      `/<owner>/<name>.git`, served by `git http-backend` from real bare repositories
 *   GitHub's API       under `/api/v3`, as GitHub Enterprise Server has it: the installation token
 *                      endpoints, a user's installations, an installation's repositories, a user's
 *                      permission in a repository, branches, pull requests, commit CI and job logs
 *
 * It checks what GitHub checks, as far as the platform depends on it: the app's JWT (RS256 against the
 * app's public key, issuer, `exp` no more than ten minutes ahead), a code that works once and only with
 * the client secret and the PKCE verifier, an installation token's repository and permissions on every
 * API call and every git request, expiry and revocation. And it refuses as GitHub refuses: 404 for an
 * installation that is gone and for a repository a token cannot see, 422 for a repository an
 * installation does not cover, 403 with `Permission to ... denied` for a push without write access, and
 * a `pre-receive` refusal with GH006 for a protected branch. The words of those refusals are written
 * from GitHub's as they are known, not copied from a run against it.
 *
 * A browser is played by `authorize()` and `install()`: they do what the user's click at GitHub does and
 * return the address GitHub would send the browser to.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
	createHash,
	createHmac,
	randomUUID,
	createPublicKey,
	createVerify,
	generateKeyPairSync,
	randomBytes,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Level = "admin" | "write" | "read" | "none";
type Permissions = Record<string, "read" | "write">;

export interface StandinUser {
	emails?: { email: string; primary: boolean; verified: boolean }[];
	id: number;
	login: string;
}

export interface StandinInstallation {
	id: number;
	/** Grants retained while the owner reviews updated App permissions. */
	permissions?: Permissions;
	account: { id: number; login: string; type: "User" | "Organization" };
	/** Ids of the repositories it covers. */
	repositories: Set<number>;
	suspended: boolean;
}

export interface StandinRepository {
	id: number;
	owner: string;
	name: string;
	private: boolean;
	archived: boolean;
	defaultBranch: string;
	/** The bare repository on disk. */
	path: string;
	/** What each GitHub user may do in it, beside its owner. */
	access: Map<string, Level>;
	/** Branch name patterns (`*` matches anything) a push to which is refused. */
	protectedBranches: string[];
	ci: Map<
		string,
		{
			runs: unknown[];
			statuses: unknown[];
			workflows?: {
				id?: number;
				check_suite_id?: number;
				status: string;
				updated_at?: string;
				run_started_at?: string;
			}[];
		}
	>;
	jobs: Map<
		string,
		{
			run_id?: number | bigint;
			head_sha?: string;
			status?: string;
			conclusion?: string;
			steps: unknown[];
			runner_id: number | null;
			runner_name: string;
		}
	>;
	jobLogs: Map<string, string>;
}

export interface StandinIssue {
	id: number;
	number: number;
	repository: number;
	title: string;
	body: string;
	state: string;
	created_at: string;
	updated_at: string;
	readResponse?: "timeout" | { status: number; headers?: Record<string, string>; body?: unknown };
	user: StandinUser;
	labels: string[];
	events: { id: number; actor: StandinUser; event: string; label?: { name: string }; created_at: string }[];
	comments: { id: bigint; user: { id?: number; login: string; type?: string }; body: string; created_at: string }[];
}

export interface StandinCheck {
	id: number;
	repository: number;
	name: string;
	head_sha: string;
	app: { id: string; slug: string };
	external_id: string;
	details_url: string;
	status: "completed" | "in_progress";
	conclusion?: string | null;
	started_at: string;
	completed_at?: string;
	output: { title: string; summary: string };
}

export interface StandinPull {
	mergeRefusal?: string;
	mergedByApp?: boolean;
	headSha?: string;
	number: number;
	repository: number;
	title: string;
	body: string;
	head: string;
	base: string;
	state: "open" | "closed";
	merged: boolean;
	/** The commit a merge made on the base: a squash or rebase merge's own commit, which a check sets with `merged`. */
	mergeCommit?: string;
	/** When it merged, as GitHub says it: set on the first reading after `merged`, unless a check sets it. */
	mergedAt?: string;
	mergeable: boolean | null;
	draft: boolean;
	requestedReviewers: string[];
	comments: Array<{
		id: number | bigint;
		body: string;
		user: { login: string; id?: number; type?: string };
		author_association?: string;
		created_at?: string;
	}>;
}

type StandinLine = string | { path: string; line: number; body: string };

interface Token {
	kind: "installation" | "user";
	value: string;
	installation?: number;
	repositories?: number[];
	permissions?: Permissions;
	user?: number;
	refreshToken?: string;
	expiresAt: number;
	revoked: boolean;
}

export interface StandinRequest {
	method: string;
	path: string;
	/** What the request authenticated with. */
	auth: "jwt" | "installation" | "user" | "basic" | "none";
	body: unknown;
	status: number;
}

export interface StandinOptions {
	/** Where "GitHub" sends a browser after an authorization or an installation: the platform's callback route. */
	callbackUrl: string;
	appId?: string;
	slug?: string;
	clientId?: string;
	/** False for a run in which nothing is really pushed (the fake sandbox layer): a pull request's branches are then taken on trust. */
	strictBranches?: boolean;
	/** The address to listen on: a container reaches it at the host's, so the Docker check listens on all of them. */
	host?: string;
}

// GitHub sends database IDs as JSON integers, including those outside JavaScript's safe range.
const wireJson = (body: unknown) =>
	JSON.stringify(body, (_key, value) =>
		typeof value === "bigint" ? (JSON as JSON & { rawJSON(source: string): unknown }).rawJSON(String(value)) : value,
	);

const json = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
	response.end(body === null ? "" : wireJson(body));
};

const readBody = (request: IncomingMessage): Promise<Buffer> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => resolve(Buffer.concat(chunks)));
		request.on("error", reject);
	});

function git(args: string[], cwd?: string, input?: string): string {
	return execFileSync("git", args, {
		cwd,
		input,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "Stand-in",
			GIT_AUTHOR_EMAIL: "standin@example.invalid",
			GIT_COMMITTER_NAME: "Stand-in",
			GIT_COMMITTER_EMAIL: "standin@example.invalid",
		},
	}).trim();
}

/** The hook of a bare repository that refuses protected branches the way GitHub's does. */
const PRE_RECEIVE = `#!/bin/sh
protected="$(dirname "$0")/../wlp-protected"
[ -f "$protected" ] || exit 0
status=0
while read -r old new ref; do
	branch=\${ref#refs/heads/}
	while IFS= read -r pattern; do
		case "$branch" in
			$pattern)
				echo "error: GH006: Protected branch update failed for $ref." >&2
				echo "error: Changes must be made through a pull request." >&2
				status=1
				;;
		esac
	done < "$protected"
done
exit $status
`;

export class GithubStandin {
	readonly appId: string;
	readonly slug: string;
	readonly clientId: string;
	readonly clientSecret = `standin-client-secret-${randomBytes(12).toString("hex")}`;
	/** The app's private key as GitHub hands it out (PKCS#1 PEM); the stand-in keeps the public half. */
	readonly privateKeyPem: string;
	private readonly publicKey;
	readonly root = mkdtempSync(join(tmpdir(), "wlp-github-standin-"));
	readonly users = new Map<string, StandinUser>();
	readonly installations = new Map<number, StandinInstallation>();
	readonly repositories = new Map<number, StandinRepository>();
	readonly checks: StandinCheck[] = [];
	/** Runs of a repository's integration workflow, as dispatched: a check finishes one by setting its status and conclusion. */
	readonly integrationRuns: Array<{
		id: number;
		repository: number;
		ref: string;
		inputs: Record<string, string>;
		head_sha: string;
		path: string;
		triggering_actor: { login: string; type: string };
		status: string;
		conclusion: string | null;
		display_title: string;
		html_url: string;
		created_at: string;
		run_started_at: string;
		updated_at: string;
	}> = [];
	/** A test may keep a part integration in flight while the feature receives another action. */
	beforeFastForward?: () => Promise<void>;
	checkFault: 403 | 422 | "lose_reply" | null = null;
	checkTokenFault: 403 | 422 | null = null;
	readonly pulls: StandinPull[] = [];
	readonly issues: StandinIssue[] = [];
	readonly reviews: ReturnType<GithubStandin["reviewData"]>[] = [];
	readonly reactions = new Set<string>();
	readonly tokens = new Map<string, Token>();
	readonly requests: StandinRequest[] = [];
	emailPermission = true;
	gitResponseBytes = 0;
	/** Leave one authenticated advertisement pending until the client cancels it. */
	hangNextGitRead = false;
	readonly deliveries: {
		id: string;
		guid: string;
		installation_id: number | bigint | null;
		delivered_at: string;
		status_code: number;
		redelivery: boolean;
	}[] = [];
	private nextCommentId = 9007199254740992n;
	private nextDeliveryId = 3855090938003079000n;
	private readonly resend = new Map<string, () => Promise<Response>>();
	/** What each installation token asked for, in order: the body of the request that made it. */
	readonly minted: Array<{
		installation: number;
		repositoryIds: number[] | null;
		permissions: Permissions | null;
		token: string;
	}> = [];
	/** The permissions the app was given when it was registered. */
	appPermissions: Permissions = { metadata: "read", contents: "write", pull_requests: "write" };
	/** Set to make every API call fail as an unreachable GitHub would. */
	down = false;
	/** Refuse every ready-for-review mutation, as GitHub does to a token it will not let mark a PR ready. */
	refuseReady = false;
	/** Simulate a refused comment, or GitHub storing one whose reply never reaches the caller. */
	commentFault: "refuse" | "lose_reply" | null = null;
	ciRateLimit: { status: 403 | 429; headers: Record<string, string>; message: string } | null = null;
	private readonly codes = new Map<string, { user: number; challenge: string | null; used: boolean }>();
	private nextId = 1000;
	private server: Server | null = null;
	private readonly children = new Set<ChildProcess>();
	url = "";

	constructor(private readonly options: StandinOptions) {
		this.appId = options.appId ?? "424242";
		this.slug = options.slug ?? "windlass-standin";
		this.clientId = options.clientId ?? "Iv23standin0client";
		const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		this.privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
		this.publicKey = createPublicKey(publicKey.export({ type: "spki", format: "pem" }).toString());
	}

	get apiUrl(): string {
		return `${this.url}/api/v3`;
	}

	/** The environment a server needs to use this stand-in as its GitHub. */
	env(): Record<string, string> {
		return {
			WLP_GITHUB_APP_ID: this.appId,
			WLP_GITHUB_APP_SLUG: this.slug,
			WLP_GITHUB_CLIENT_ID: this.clientId,
			WLP_GITHUB_CLIENT_SECRET: this.clientSecret,
			WLP_GITHUB_PRIVATE_KEY: Buffer.from(this.privateKeyPem, "utf8").toString("base64"),
			WLP_GITHUB_API_URL: this.apiUrl,
			WLP_GITHUB_URL: this.url,
		};
	}

	async start(): Promise<void> {
		const server = createServer((request, response) => {
			this.handle(request, response).catch((error: unknown) => {
				if (!response.headersSent)
					json(response, 500, {
						message: `stand-in failure: ${error instanceof Error ? error.message : String(error)}`,
					});
				else response.end();
			});
		});
		this.server = server;
		const host = this.options.host ?? "127.0.0.1";
		await new Promise<void>(resolve => server.listen(0, host, resolve));
		const address = server.address();
		if (typeof address !== "object" || address === null) throw new Error("the stand-in has no address");
		this.url = `http://127.0.0.1:${address.port}`;
		console.log(`GitHub stand-in port: ${address.port}`);
	}

	async stop(): Promise<void> {
		for (const child of this.children) child.kill("SIGKILL");
		const server = this.server;
		this.server = null;
		if (server) {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
		rmSync(this.root, { recursive: true, force: true });
	}

	/** Sign exactly the bytes sent. A redelivery uses the original GUID and records its own answer. */
	deliver(
		url: string,
		event: string,
		payload: unknown,
		options: { secret: string; guid?: string; targetId?: string },
	): Promise<Response> {
		const body = wireJson(payload);
		const guid = options.guid ?? randomUUID();
		const installationId = (payload as { installation?: { id?: number | bigint } } | null)?.installation?.id ?? null;
		const send = async (redelivery: boolean) => {
			const response = await fetch(url, {
				method: "POST",
				body,
				headers: {
					"content-type": "application/json",
					"user-agent": "GitHub-Hookshot/standin",
					"x-github-event": event,
					"x-github-delivery": guid,
					"x-github-hook-installation-target-id": options.targetId ?? this.appId,
					"x-hub-signature-256": "sha256=" + createHmac("sha256", options.secret).update(body).digest("hex"),
				},
			});
			const id = String(++this.nextDeliveryId);
			this.deliveries.unshift({
				id,
				guid,
				installation_id: installationId,
				delivered_at: new Date().toISOString(),
				status_code: response.status,
				redelivery,
			});
			this.resend.set(id, () => send(true));
			return response;
		};
		return send(false);
	}

	// ---- the world --------------------------------------------------------------------------------

	addUser(login: string): StandinUser {
		const user = { id: (this.nextId += 1), login };
		this.users.set(login, user);
		return user;
	}

	/** Installs the app on an account: a user's own, or an organization's. */
	addInstallation(account: string, type: "User" | "Organization"): StandinInstallation {
		const owner = type === "User" ? this.users.get(account) : undefined;
		const installation: StandinInstallation = {
			id: (this.nextId += 1),
			account: { id: owner?.id ?? (this.nextId += 1), login: account, type },
			repositories: new Set(),
			suspended: false,
		};
		this.installations.set(installation.id, installation);
		return installation;
	}

	/** A repository with one commit on its default branch, covered by `installation` when one is given. */
	addRepository(input: {
		owner: string;
		name: string;
		private?: boolean;
		installation?: StandinInstallation;
		files?: Record<string, string>;
		defaultBranch?: string;
	}): StandinRepository {
		const defaultBranch = input.defaultBranch ?? "main";
		const path = join(this.root, "git", input.owner, `${input.name}.git`);
		mkdirSync(path, { recursive: true });
		git(["init", "--quiet", "--bare", `--initial-branch=${defaultBranch}`, path]);
		git(["config", "http.receivepack", "true"], path);
		writeFileSync(join(path, "hooks", "pre-receive"), PRE_RECEIVE);
		chmodSync(join(path, "hooks", "pre-receive"), 0o755);
		const repository: StandinRepository = {
			id: (this.nextId += 1),
			owner: input.owner,
			name: input.name,
			private: input.private ?? false,
			archived: false,
			defaultBranch,
			path,
			access: new Map(),
			protectedBranches: [],
			ci: new Map(),
			jobs: new Map(),
			jobLogs: new Map(),
		};
		this.repositories.set(repository.id, repository);
		this.commit(repository, defaultBranch, input.files ?? { "README.md": `# ${input.name}\n` }, "Initial commit");
		input.installation?.repositories.add(repository.id);
		return repository;
	}

	private reviewData(
		repo: StandinRepository,
		pull: StandinPull,
		person: StandinUser & { type?: "Bot" },
		state: string,
		body: string,
		comments: StandinLine[],
		at: number,
	) {
		const id = ++this.nextCommentId,
			date = new Date(at).toISOString();
		const fields = {
			pull_request_url: this.apiUrl + `/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
			user: { ...person, type: person.type ?? "User" },
			author_association:
				repo.owner === person.login ? "OWNER" : repo.access.has(person.login) ? "COLLABORATOR" : "NONE",
			commit_id: pull.headSha ?? this.branchHead(repo, pull.head) ?? "a".repeat(40),
		};
		return {
			repository: repo.id,
			pr: pull.number,
			review: { ...fields, id, node_id: "PRR_" + id, submitted_at: date, body, state },
			lines: comments.map((line, n) => ({
				...fields,
				id: ++this.nextCommentId,
				pull_request_review_id: id,
				created_at: date,
				...(typeof line === "string" ? { path: "src/main.ts", line: n + 1, body: line } : line),
			})),
		};
	}

	submitReview(
		repo: StandinRepository,
		pull: StandinPull,
		user: StandinUser & { type?: "Bot" },
		state: string,
		body: string,
		comments: StandinLine[] = [],
		at = Date.now(),
	) {
		const data = this.reviewData(repo, pull, user, state, body, comments, at);
		this.reviews.push(data);
		pull.requestedReviewers = pull.requestedReviewers.filter(login => login !== user.login);
		return data;
	}

	addIssue(repo: StandinRepository, number: number, user: StandinUser): StandinIssue {
		const at = new Date().toISOString();
		const issue: StandinIssue = {
			id: ++this.nextId,
			repository: repo.id,
			number,
			user,
			title: "A task from GitHub",
			body: "Add a short program.",
			state: "open",
			created_at: at,
			updated_at: at,
			labels: [],
			events: [],
			comments: [],
		};
		this.issues.push(issue);
		return issue;
	}

	issueEvent(issue: StandinIssue, event: string, actor: StandinUser) {
		const label = ["labeled", "unlabeled"].includes(event);
		if (label) issue.labels = event === "labeled" ? ["windlass"] : [];
		if (event === "closed" || event === "reopened") issue.state = event === "closed" ? "closed" : "open";
		issue.updated_at = new Date().toISOString();
		issue.events.push({
			id: ++this.nextId,
			event,
			actor,
			...(label && { label: { name: "windlass" } }),
			created_at: issue.updated_at,
		});
	}

	issueComment(issue: StandinIssue, user: StandinUser, body: string) {
		const comment = {
			id: ++this.nextCommentId,
			user: { ...user, type: "User" },
			body,
			created_at: new Date().toISOString(),
		};
		issue.comments.push(comment);
		return comment;
	}

	/** Adds a commit to a branch of a repository, as someone pushing to GitHub would. Returns the commit. */
	commit(
		repository: StandinRepository,
		branch: string,
		files: Record<string, string | null>,
		message: string,
		from?: string,
	): string {
		const work = mkdtempSync(join(this.root, "work-"));
		try {
			git(["init", "--quiet", `--initial-branch=${branch}`, work]);
			const start = from ?? branch;
			const exists = this.branchHead(repository, start) !== null;
			if (exists) {
				git(["fetch", "--quiet", repository.path, `refs/heads/${start}`], work);
				git(["reset", "--quiet", "--hard", "FETCH_HEAD"], work);
			}
			for (const [name, content] of Object.entries(files)) {
				if (content === null) {
					rmSync(join(work, name));
					continue;
				}
				mkdirSync(join(work, name, ".."), { recursive: true });
				writeFileSync(join(work, name), content);
			}
			git(["add", "-A"], work);
			git(["commit", "--quiet", "--allow-empty", "-m", message], work);
			// Straight into the bare repository: the hooks are for what comes over HTTP.
			git(["push", "--quiet", "--no-verify", repository.path, `HEAD:refs/heads/${branch}`], work);
			return git(["rev-parse", "HEAD"], work);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}

	featureCommit(
		repository: StandinRepository,
		parent: string,
		message: string,
		date: string,
		identity: { name: string; email: string },
	): string {
		const tree = git(["show", "-s", "--format=%T", parent], repository.path);
		const author = {
			GIT_AUTHOR_NAME: identity.name,
			GIT_AUTHOR_EMAIL: identity.email,
			GIT_AUTHOR_DATE: date,
			GIT_COMMITTER_NAME: identity.name,
			GIT_COMMITTER_EMAIL: identity.email,
			GIT_COMMITTER_DATE: date,
		};
		return execFileSync("git", ["commit-tree", tree, "-p", parent, "-m", message], {
			cwd: repository.path,
			encoding: "utf8",
			env: { ...process.env, ...author },
		}).trim();
	}

	branchHead(repository: StandinRepository, branch: string): string | null {
		try {
			return git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], repository.path);
		} catch {
			return null;
		}
	}

	/** A file's content on a branch, or null. */
	fileOn(repository: StandinRepository, branch: string, path: string): string | null {
		try {
			return execFileSync("git", ["show", `refs/heads/${branch}:${path}`], {
				cwd: repository.path,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			return null;
		}
	}

	/** The message and author of a branch's last commit. */
	lastCommit(repository: StandinRepository, branch: string): { message: string; author: string; files: string[] } {
		const [author = "", ...message] = git(
			["log", "-1", "--format=%an <%ae>%n%B", `refs/heads/${branch}`],
			repository.path,
		).split("\n");
		const files = git(["show", "--pretty=format:", "--name-only", `refs/heads/${branch}`], repository.path)
			.split("\n")
			.filter(line => line !== "");
		return { message: message.join("\n").trim(), author, files };
	}

	protect(repository: StandinRepository, patterns: string[]): void {
		repository.protectedBranches = patterns;
		if (patterns.length === 0) rmSync(join(repository.path, "wlp-protected"), { force: true });
		else writeFileSync(join(repository.path, "wlp-protected"), `${patterns.join("\n")}\n`);
	}

	deleteRepository(repository: StandinRepository): void {
		this.repositories.delete(repository.id);
		for (const installation of this.installations.values()) installation.repositories.delete(repository.id);
	}

	uninstall(installation: StandinInstallation): void {
		this.installations.delete(installation.id);
	}

	/** What a GitHub user may do in a repository: everything in their own, otherwise what they were granted. */
	levelOf(repository: StandinRepository, login: string): Level {
		if (repository.owner === login) return "admin";
		return repository.access.get(login) ?? "none";
	}

	/** The installations a user reaches: those that cover a repository they can at least read. */
	private installationsOf(user: StandinUser): StandinInstallation[] {
		return [...this.installations.values()].filter(
			installation =>
				(installation.account.type === "User" && installation.account.id === user.id) ||
				[...installation.repositories].some(
					id => this.levelOf(this.repositories.get(id) as StandinRepository, user.login) !== "none",
				),
		);
	}

	// ---- the browser ------------------------------------------------------------------------------

	/** The address a browser at GitHub's authorization page would ask for. */
	authorizeAddress(state: string, challenge: string | null): string {
		const query = new URLSearchParams({ client_id: this.clientId, state });
		if (challenge !== null) {
			query.set("code_challenge", challenge);
			query.set("code_challenge_method", "S256");
		}
		return `${this.url}/login/oauth/authorize?${query}`;
	}

	/**
	 * The user's click on "Authorize" at `address` (what the platform sent the browser to): the address
	 * GitHub then sends the browser to. With `deny` the user declines.
	 */
	authorize(login: string, address: string, options: { deny?: boolean } = {}): string {
		const params = new URL(address).searchParams;
		if (!address.startsWith(`${this.url}/login/oauth/authorize?`))
			throw new Error(`not the authorization page: ${address}`);
		if (params.get("client_id") !== this.clientId) throw new Error("the authorization names another client");
		const back = new URL(params.get("redirect_uri") ?? this.options.callbackUrl);
		const state = params.get("state");
		if (state !== null) back.searchParams.set("state", state);
		if (options.deny) {
			back.searchParams.set("error", "access_denied");
			return back.toString();
		}
		back.searchParams.set("code", this.code(login, params.get("code_challenge")));
		return back.toString();
	}

	/**
	 * The user's installation of the app on `account` from `address` (the installation page): makes the
	 * installation, covering `repositories`, and returns where GitHub sends the browser. The app asks
	 * for authorization during installation, so that address carries a code.
	 */
	install(
		login: string,
		address: string,
		account: string,
		type: "User" | "Organization",
		repositories: StandinRepository[],
	): string {
		if (!address.startsWith(`${this.url}/apps/${this.slug}/installations/new`))
			throw new Error(`not the installation page: ${address}`);
		const installation = this.addInstallation(account, type);
		for (const repository of repositories) installation.repositories.add(repository.id);
		return this.installed(login, installation.id, new URL(address).searchParams.get("state"));
	}

	/** Where GitHub sends a browser after an installation: with a code, the installation's id and the state. */
	installed(login: string, installationId: number | string, state: string | null): string {
		const back = new URL(this.options.callbackUrl);
		back.searchParams.set("code", this.code(login, null));
		back.searchParams.set("installation_id", String(installationId));
		back.searchParams.set("setup_action", "install");
		if (state !== null) back.searchParams.set("state", state);
		return back.toString();
	}

	private code(login: string, challenge: string | null): string {
		const user = this.users.get(login);
		if (!user) throw new Error(`no such user: ${login}`);
		const code = randomBytes(10).toString("hex");
		this.codes.set(code, { user: user.id, challenge, used: false });
		return code;
	}

	// ---- tokens -----------------------------------------------------------------------------------

	private verifyJwt(token: string): boolean {
		const parts = token.split(".");
		if (parts.length !== 3) return false;
		try {
			const header = JSON.parse(Buffer.from(parts[0] as string, "base64url").toString("utf8")) as { alg?: string };
			const claims = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8")) as {
				iss?: unknown;
				iat?: unknown;
				exp?: unknown;
			};
			if (header.alg !== "RS256") return false;
			if (
				!createVerify("RSA-SHA256")
					.update(`${parts[0]}.${parts[1]}`)
					.verify(this.publicKey, Buffer.from(parts[2] as string, "base64url"))
			)
				return false;
			const now = Math.floor(Date.now() / 1000);
			if (String(claims.iss) !== this.appId && String(claims.iss) !== this.clientId) return false;
			if (typeof claims.exp !== "number" || claims.exp <= now || claims.exp > now + 600) return false;
			return typeof claims.iat === "number" && claims.iat <= now;
		} catch {
			return false;
		}
	}

	private tokenOf(value: string | null): Token | null {
		const token = value === null ? undefined : this.tokens.get(value);
		if (!token || token.revoked || token.expiresAt <= Date.now()) return null;
		return token;
	}

	/** Whether the token is still good, for the checks. */
	alive(value: string): boolean {
		return this.tokenOf(value) !== null;
	}

	private authOf(request: IncomingMessage): {
		kind: StandinRequest["auth"];
		token: Token | null;
		raw: string | null;
		basic: [string, string] | null;
	} {
		const header = request.headers.authorization ?? "";
		const bearer = /^(?:Bearer|token) (.+)$/i.exec(header)?.[1] ?? null;
		if (bearer !== null) {
			if (bearer.split(".").length === 3 && !bearer.startsWith("gh"))
				return { kind: "jwt", token: null, raw: bearer, basic: null };
			const token = this.tokenOf(bearer);
			return { kind: token?.kind ?? "none", token, raw: bearer, basic: null };
		}
		const basic = /^Basic (.+)$/i.exec(header)?.[1] ?? null;
		if (basic !== null) {
			const decoded = Buffer.from(basic, "base64").toString("utf8");
			const at = decoded.indexOf(":");
			return { kind: "basic", token: null, raw: null, basic: [decoded.slice(0, at), decoded.slice(at + 1)] };
		}
		return { kind: "none", token: null, raw: null, basic: null };
	}

	/** Whether an installation token may do `need` of `permission` in `repository`. */
	private allows(token: Token, repository: StandinRepository, permission: string, need: "read" | "write"): boolean {
		const installation = token.installation === undefined ? undefined : this.installations.get(token.installation);
		if (!installation || installation.suspended || !installation.repositories.has(repository.id)) return false;
		if (token.repositories && !token.repositories.includes(repository.id)) return false;
		const has = (token.permissions ?? installation.permissions ?? this.appPermissions)[permission];
		return has === "write" || (has === "read" && need === "read");
	}

	private repositoryJson(repository: StandinRepository): Record<string, unknown> {
		const head = this.branchHead(repository, repository.defaultBranch);
		const pushed =
			head === null
				? null
				: new Date(Number(git(["log", "-1", "--format=%ct", head], repository.path)) * 1000).toISOString();
		return {
			id: repository.id,
			name: repository.name,
			full_name: `${repository.owner}/${repository.name}`,
			owner: { login: repository.owner },
			private: repository.private,
			archived: repository.archived,
			default_branch: repository.defaultBranch,
			pushed_at: pushed,
			html_url: `${this.url}/${repository.owner}/${repository.name}`,
		};
	}

	private pullJson(pull: StandinPull): Record<string, unknown> {
		const repository = this.repositories.get(pull.repository) as StandinRepository;
		return {
			number: pull.number,
			node_id: "PR_" + repository.id + "_" + pull.number,
			html_url: `${this.url}/${repository.owner}/${repository.name}/pull/${pull.number}`,
			state: pull.state,
			draft: pull.draft,
			requested_reviewers: pull.requestedReviewers.map(login => ({ login })),
			merged: pull.merged,
			...(pull.mergedByApp && { merged_by: { login: this.slug + "[bot]" } }),
			mergeable: pull.mergeable,
			merged_at: pull.merged ? (pull.mergedAt ??= new Date().toISOString()) : null,
			merge_commit_sha: pull.merged ? (pull.mergeCommit ?? null) : null,
			title: pull.title,
			body: pull.body,
			head: {
				repo: { id: repository.id },
				ref: pull.head,
				...(pull.headSha && { sha: pull.headSha }),
				...(/^windlass\/(?:feature-i_|repo-setup-)/.test(pull.head) && { sha: this.branchHead(repository, pull.head) }),
			},
			base: { ref: pull.base, sha: this.branchHead(repository, pull.base) },
		};
	}

	private installationJson(installation: StandinInstallation): Record<string, unknown> {
		const settings =
			installation.account.type === "Organization"
				? `${this.url}/organizations/${installation.account.login}/settings/installations/${installation.id}`
				: `${this.url}/settings/installations/${installation.id}`;
		return {
			id: installation.id,
			account: { id: installation.account.id, login: installation.account.login, type: installation.account.type },
			html_url: settings,
			target_type: installation.account.type,
			suspended_at: installation.suspended ? new Date().toISOString() : null,
			repository_selection: "selected",
		};
	}

	// ---- requests ---------------------------------------------------------------------------------

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", this.url);
		const path = url.pathname;
		const gitRequest = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
		if (gitRequest) {
			await this.git(request, response, url, gitRequest[1] as string, gitRequest[2] as string, gitRequest[3] as string);
			return;
		}

		const raw = await readBody(request);
		let body: unknown = null;
		try {
			body = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : null;
		} catch {
			body = Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
		}
		const auth = this.authOf(request);
		const entry: StandinRequest = {
			method: request.method ?? "GET",
			path: path + url.search,
			auth: auth.kind,
			body,
			status: 0,
		};
		this.requests.push(entry);
		const answer = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
			entry.status = status;
			json(response, status, payload, headers);
		};

		const storage = /^\/storage\/(\d+)\/(\d+)$/.exec(path);
		if (storage && request.method === "GET") {
			// Keep storage on the same origin so even an automatic redirect would reveal a forwarded credential.
			if (request.headers.authorization !== undefined)
				return answer(403, { message: "Log storage received an Authorization header" });
			const log = this.repositories.get(Number(storage[1]))?.jobLogs.get(storage[2]);
			if (log === undefined) return answer(404, { message: "Not Found" });
			entry.status = 200;
			response.writeHead(200, { "content-type": "text/plain" });
			response.end(log);
			return;
		}

		if (path === "/login/oauth/access_token" && request.method === "POST") {
			const fields = (body ?? {}) as Record<string, string>;
			const code = this.codes.get(String(fields.code));
			if (fields.client_id !== this.clientId || fields.client_secret !== this.clientSecret)
				return answer(200, {
					error: "incorrect_client_credentials",
					error_description: "The client_id and/or client_secret passed are incorrect.",
				});
			const verifierOk =
				!code?.challenge ||
				(typeof fields.code_verifier === "string" &&
					createHash("sha256").update(fields.code_verifier).digest("base64url") === code.challenge);
			if (!code || code.used || !verifierOk)
				return answer(200, {
					error: "bad_verification_code",
					error_description: "The code passed is incorrect or expired.",
				});
			code.used = true;
			const value = `ghu_${randomBytes(18).toString("hex")}`;
			const refreshToken = `ghr_${randomBytes(18).toString("hex")}`;
			this.tokens.set(value, {
				kind: "user",
				value,
				refreshToken,
				user: code.user,
				expiresAt: Date.now() + 8 * 3600_000,
				revoked: false,
			});
			return answer(200, {
				access_token: value,
				expires_in: 28800,
				refresh_token: refreshToken,
				refresh_token_expires_in: 15897600,
				scope: "",
				token_type: "bearer",
			});
		}

		if (path === "/api/graphql" && request.method === "POST") {
			const token = auth.token,
				args = body as { query?: string; variables?: { id?: string } };
			if (args.query?.includes("addReaction")) {
				const row = this.reviews.find(r => r.review.node_id === args.variables?.id);
				if (!row || !token || !this.allows(token, this.repositories.get(row.repository)!, "pull_requests", "write"))
					return answer(403, {});
				if (!args.query.includes("content:EYES")) return answer(422, {});
				this.reactions.add("review:" + row.review.id);
				return answer(200, { data: { addReaction: { reaction: { content: "EYES" } } } });
			}
			const pull = this.pulls.find(p => "PR_" + p.repository + "_" + p.number === args.variables?.id);
			if (
				!token ||
				!pull ||
				!this.allows(token, this.repositories.get(pull.repository)!, "pull_requests", "write") ||
				!args.query?.includes("markPullRequestReadyForReview")
			)
				return answer(403, {});
			// As GitHub: a token with Pull requests write alone is refused, with 200 and the reason in `errors`.
			if (this.refuseReady || !this.allows(token, this.repositories.get(pull.repository)!, "contents", "write"))
				return answer(200, {
					data: { markPullRequestReadyForReview: null },
					errors: [
						{
							type: "FORBIDDEN",
							path: ["markPullRequestReadyForReview"],
							message: "Resource not accessible by integration",
						},
					],
				});
			pull.draft = false;
			return answer(200, { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
		}
		if (!path.startsWith("/api/v3/")) return answer(404, { message: "Not Found" });
		if (this.down) return answer(503, { message: "Service unavailable" });
		const api = path.slice("/api/v3".length);
		const method = request.method ?? "GET";

		// --- as the app ---
		const attempt = /^\/app\/hook\/deliveries\/(\d+)\/attempts$/.exec(api);
		if (api === "/app/hook/deliveries" || attempt) {
			if (auth.kind !== "jwt" || !auth.raw || !this.verifyJwt(auth.raw))
				return answer(401, { message: "Bad credentials" });
			if (method === "GET" && !attempt) {
				const status = url.searchParams.get("status");
				const rows = this.deliveries.filter(d => !status || d.status_code >= 400 === (status === "failure"));
				const cursor = url.searchParams.get("cursor");
				const first = cursor ? rows.findIndex(d => d.id === cursor) : 0;
				if (first < 0) return answer(400, { message: "Unknown cursor" });
				const size = Math.min(100, Number(url.searchParams.get("per_page") ?? 30));
				const next = rows[first + size];
				if (next) url.searchParams.set("cursor", next.id);
				// GitHub writes an unquoted integer on the wire.
				const page = rows.slice(first, first + size).map(row => ({ ...row, id: BigInt(row.id) }));
				return answer(200, page, next ? { link: `<${url}>; rel="next"` } : {});
			}
			if (method === "POST" && attempt) {
				const send = this.resend.get(attempt[1]);
				if (!send) return answer(404, { message: "Not Found" });
				await (await send()).arrayBuffer();
				return answer(202, {});
			}
			return answer(405, { message: "Method not allowed" });
		}
		const target = /^\/app\/installations\/(\d+)$/.exec(api);
		if (target && method === "GET") {
			if (!auth.raw || !this.verifyJwt(auth.raw)) return answer(401, { message: "Bad credentials" });
			const installation = this.installations.get(Number(target[1]));
			return installation ? answer(200, this.installationJson(installation)) : answer(404, { message: "Not Found" });
		}
		const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(api);
		if (mint && method === "POST") {
			if (auth.kind !== "jwt" || auth.raw === null || !this.verifyJwt(auth.raw))
				return answer(401, { message: "A JSON web token could not be decoded" });
			const installation = this.installations.get(Number(mint[1]));
			if (!installation) return answer(404, { message: "Not Found" });
			if (installation.suspended) return answer(403, { message: "This installation has been suspended" });
			const fields = (body ?? {}) as { repository_ids?: number[]; permissions?: Permissions };
			const ids = Array.isArray(fields.repository_ids) ? fields.repository_ids : null;
			if (ids?.some(id => !installation.repositories.has(id)))
				return answer(422, {
					message:
						"There is at least one repository that does not exist or is not accessible to the parent installation.",
				});
			const rank = { read: 1, write: 2 } as const;
			if (fields.permissions?.checks === "write" && this.checkTokenFault)
				return answer(this.checkTokenFault, { message: "Checks write not granted" });
			for (const [name, level] of Object.entries(fields.permissions ?? {})) {
				const granted = (installation.permissions ?? this.appPermissions)[name];
				if (!granted || rank[level] > rank[granted])
					return answer(422, { message: "The permissions requested are not granted to this installation." });
			}
			const value = `ghs_${this.appId}_${randomBytes(30).toString("base64url")}`;
			this.tokens.set(value, {
				kind: "installation",
				value,
				installation: installation.id,
				repositories: ids ?? undefined,
				permissions: fields.permissions,
				expiresAt: Date.now() + 3600_000,
				revoked: false,
			});
			this.minted.push({
				installation: installation.id,
				repositoryIds: ids,
				permissions: fields.permissions ?? null,
				token: value,
			});
			return answer(201, {
				token: value,
				expires_at: new Date(Date.now() + 3600_000).toISOString(),
				permissions: fields.permissions ?? installation.permissions ?? this.appPermissions,
				...(ids && { repositories: ids.map(id => this.repositoryJson(this.repositories.get(id)!)) }),
				repository_selection: ids ? "selected" : "all",
			});
		}

		const forget = /^\/applications\/([^/]+)\/token$/.exec(api);
		if (forget && method === "DELETE") {
			if (
				!auth.basic ||
				auth.basic[0] !== this.clientId ||
				auth.basic[1] !== this.clientSecret ||
				forget[1] !== this.clientId
			)
				return answer(401, { message: "Bad credentials" });
			const token = this.tokens.get(String((body as { access_token?: unknown } | null)?.access_token));
			if (!token || token.kind !== "user") return answer(422, { message: "Validation Failed" });
			token.revoked = true;
			return answer(204, null);
		}

		// --- as a user ---
		if (api === "/user" || api === "/user/installations" || api === "/user/emails") {
			const user =
				auth.token?.kind === "user"
					? [...this.users.values()].find(candidate => candidate.id === auth.token?.user)
					: undefined;
			if (!user) return answer(401, { message: "Bad credentials" });
			if (api === "/user/emails" && !this.emailPermission)
				return answer(403, { message: "Permission denied for sensitive@example.invalid" });
			if (api === "/user/emails")
				return answer(200, user.emails ?? [{ email: user.login + "@example.invalid", primary: true, verified: true }]);
			if (api === "/user") return answer(200, { id: user.id, login: user.login, type: "User" });
			const list = this.installationsOf(user);
			return answer(200, {
				total_count: list.length,
				installations: list.map(installation => this.installationJson(installation)),
			});
		}

		// --- as an installation ---
		const token = auth.token?.kind === "installation" ? auth.token : null;
		if (!token) return answer(401, { message: "Bad credentials" });
		const installation = this.installations.get(token.installation as number);
		if (!installation) return answer(401, { message: "Bad credentials" });

		if (api === "/installation/token" && method === "DELETE") {
			token.revoked = true;
			return answer(204, null);
		}

		const pageOf = <T>(key: string, items: T[], format: (item: T) => unknown = item => item) => {
			const page = Number(url.searchParams.get("page") ?? "1");
			const size = Number(url.searchParams.get("per_page") ?? "30");
			const link =
				page * size < items.length
					? { link: `<${this.url}${path}?per_page=${size}&page=${page + 1}>; rel="next"` }
					: undefined;
			return answer(
				200,
				{ total_count: items.length, [key]: items.slice((page - 1) * size, page * size).map(format) },
				link,
			);
		};
		const arrayPage = <T>(items: T[]) => {
			const page = Number(url.searchParams.get("page") ?? "1");
			const size = Number(url.searchParams.get("per_page") ?? "30");
			const href = (n: number) => `<${this.url}${path}?per_page=${size}&page=${n}>`;
			const more =
				page * size < items.length
					? { link: href(page + 1) + '; rel="next", ' + href(Math.ceil(items.length / size)) + '; rel="last"' }
					: undefined;
			return answer(200, items.slice((page - 1) * size, page * size), more);
		};
		if (api === "/installation/repositories" && method === "GET") {
			const all = [...installation.repositories]
				.map(id => this.repositories.get(id) as StandinRepository)
				.filter(repository => !token.repositories || token.repositories.includes(repository.id));
			return pageOf("repositories", all, repository => this.repositoryJson(repository));
		}

		const byId = /^\/repositories\/(\d+)$/.exec(api);
		if (byId && method === "GET") {
			const repository = [...this.repositories.values()].find(repo => String(repo.id) === byId[1]);
			return repository && this.allows(token, repository, "metadata", "read")
				? answer(200, this.repositoryJson(repository))
				: answer(404, { message: "Not Found" });
		}
		const scoped = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(api);
		if (scoped) {
			const repository = [...this.repositories.values()].find(
				candidate =>
					candidate.owner.toLowerCase() === (scoped[1] as string).toLowerCase() &&
					candidate.name.toLowerCase() === (scoped[2] as string).toLowerCase(),
			);
			// A repository the token cannot see is not there, as far as it is told.
			if (!repository || !this.allows(token, repository, "metadata", "read"))
				return answer(404, { message: "Not Found" });
			const rest = scoped[3] ?? "";
			const denied = () => answer(403, { message: "Resource not accessible by integration" });

			if (rest === "" && method === "GET") return answer(200, this.repositoryJson(repository));

			if (method === "GET" && rest.startsWith("/contents/")) {
				if (!this.allows(token, repository, "contents", "read")) return denied();
				const ref = url.searchParams.get("ref") ?? "";
				const path = decodeURIComponent(rest.slice("/contents/".length));
				if (/^[0-9a-f]{40}$/.test(ref)) {
					try {
						const data = execFileSync("git", ["cat-file", "blob", `${ref}:${path}`], {
							cwd: repository.path,
							stdio: ["ignore", "pipe", "ignore"],
						});
						return answer(200, { type: "file", encoding: "base64", path, content: data.toString("base64") });
					} catch {
						/* No file at that revision. */
					}
				}
				return answer(404, { message: "Not Found" });
			}

			const checkPath = /^\/check-runs(?:\/(\d+))?$/.exec(rest);
			if (checkPath && (method === "POST" || method === "PATCH")) {
				if (!this.allows(token, repository, "checks", "write")) return denied();
				if (typeof this.checkFault === "number")
					return answer(this.checkFault, { message: "Writing checks was refused" });
				const fields = (body ?? {}) as Partial<StandinCheck>;
				if (
					!fields.output?.title ||
					!fields.output.summary ||
					fields.output.summary.length > 4000 ||
					!fields.details_url ||
					!fields.external_id ||
					(fields.status === "completed"
						? !fields.conclusion || !fields.completed_at
						: fields.status !== "in_progress" || fields.conclusion)
				)
					return answer(422, { message: "Invalid check run" });
				if (method === "PATCH" && checkPath[1]) {
					const check = this.checks.find(r => r.repository === repository.id && r.id === Number(checkPath[1]));
					if (!check) return answer(404, {});
					Object.assign(check, { conclusion: null, completed_at: undefined }, fields);
					return answer(200, check);
				}
				if (checkPath[1] || method !== "POST" || !fields.name || !/^[a-f0-9]{40}$/.test(fields.head_sha ?? ""))
					return answer(422, {});
				const check = {
					...fields,
					id: ++this.nextId,
					repository: repository.id,
					app: { id: this.appId, slug: this.slug },
				} as StandinCheck;
				this.checks.push(check);
				if (this.checkFault === "lose_reply") {
					this.checkFault = null;
					return answer(503, { message: "Lost reply after storing the check" });
				}
				return answer(201, check);
			}

			if (rest === "/commits" && method === "GET") {
				if (!this.allows(token, repository, "contents", "read")) return denied();
				const shas = git(
					["rev-list", "--max-count=" + (url.searchParams.get("per_page") ?? 30), repository.defaultBranch],
					repository.path,
				);
				return answer(
					200,
					shas
						.trim()
						.split("\n")
						.map(sha => ({ sha })),
				);
			}
			if (rest === "/actions/runs" && method === "GET") {
				if (!this.allows(token, repository, "actions", "read")) return denied();
				const head = url.searchParams.get("head_sha") ?? "";
				return pageOf("workflow_runs", repository.ci.get(head)?.workflows ?? [], run => ({ ...run, head_sha: head }));
			}
			const workflowJobs = /^\/actions\/runs\/(\d+)\/(jobs|rerun-failed-jobs)$/.exec(rest);
			if (workflowJobs && workflowJobs[2] === "jobs" && method === "GET") {
				if (!this.allows(token, repository, "actions", "read")) return denied();
				return pageOf(
					"jobs",
					[...repository.jobs].filter(([, job]) => String(job.run_id) === workflowJobs[1]),
					([id, job]) => ({ id, ...job }),
				);
			}
			if (workflowJobs && workflowJobs[2] === "rerun-failed-jobs" && method === "POST")
				return this.allows(token, repository, "actions", "write") ? answer(201, null) : denied();
			const revision = /^\/commits\/([^/]+)$/.exec(rest);
			const tree = /^\/git\/trees\/([a-f0-9]{40})$/.exec(rest);
			if (method === "GET" && (revision || tree)) {
				if (!this.allows(token, repository, "contents", "read")) return denied();
				if (tree) {
					const listing = git(["ls-tree", "-r", "-z", tree[1]], repository.path);
					const entries = listing
						.split("\0")
						.filter(Boolean)
						.map(entry => {
							const [header, path] = entry.split("\t"),
								[mode, type, sha] = header.split(" ");
							return { mode, type, sha, path };
						});
					return answer(200, { sha: tree[1], tree: entries, truncated: false });
				}
				const ref = decodeURIComponent(revision![1]);
				const sha = this.branchHead(repository, ref) ?? (/^[a-f0-9]{40}$/.test(ref) ? ref : null);
				if (!sha) return answer(404, { message: "Not Found" });
				return answer(200, {
					sha,
					commit: { tree: { sha: git(["show", "-s", "--format=%T", sha], repository.path) } },
				});
			}
			const blob = /^\/git\/blobs\/([a-f0-9]{40})$/.exec(rest);
			if (blob && method === "GET") {
				if (!this.allows(token, repository, "contents", "read")) return denied();
				const data = execFileSync("git", ["cat-file", "blob", blob[1]], { cwd: repository.path });
				return answer(200, { encoding: "base64", content: data.toString("base64") });
			}
			const commitCi = /^\/commits\/([^/]+)\/(check-runs|status)$/.exec(rest);
			const job = /^\/actions\/jobs\/(\d+)(\/logs)?$/.exec(rest);
			if (method === "GET" && (commitCi || job)) {
				const permission = job ? "actions" : commitCi?.[2] === "check-runs" ? "checks" : "statuses";
				if (!this.allows(token, repository, permission, "read")) return denied();
				if (this.ciRateLimit)
					return answer(this.ciRateLimit.status, { message: this.ciRateLimit.message }, this.ciRateLimit.headers);
				if (commitCi) {
					const ci = repository.ci.get(decodeURIComponent(commitCi[1]));
					if (permission !== "checks") return pageOf("statuses", ci?.statuses ?? []);
					const runs = [
						...(ci?.runs ?? []),
						...this.checks.filter(r => r.repository === repository.id && r.head_sha === commitCi[1]),
					];
					const name = url.searchParams.get("check_name"),
						app = url.searchParams.get("app_id");
					return pageOf(
						"check_runs",
						runs.filter(run => {
							const r = run as Partial<StandinCheck>;
							return (!name || r.name === name) && (!app || String(r.app?.id) === app);
						}),
					);
				}
				const id = job![1];
				if (!job![2]) {
					const details = repository.jobs.get(id);
					return details ? answer(200, { id, ...details }) : answer(404, { message: "Not Found" });
				}
				if (!repository.jobLogs.has(id)) return answer(404, { message: "Not Found" });
				return answer(302, null, { location: `${this.url}/storage/${repository.id}/${id}` });
			}

			const permission = /^\/collaborators\/([^/]+)\/permission$/.exec(rest);
			if (permission && method === "GET") {
				const login = decodeURIComponent(permission[1] as string);
				if (!this.users.has(login)) return answer(404, { message: "Not Found" });
				const level = this.levelOf(repository, login);
				return answer(200, { permission: level, role_name: level, user: this.users.get(login) });
			}

			// The integration workflow of a cross-repo feature (server/src/github/integration.ts): dispatched runs, listed and read.
			const integration = /^\/actions\/workflows\/windlass-integration\.yml(\/dispatches|\/runs)?$/.exec(rest);
			if (integration) {
				const file = ".github/workflows/windlass-integration.yml";
				const present =
					git(["ls-tree", "--name-only", repository.defaultBranch, "--", file], repository.path).trim() === file;
				if (!this.allows(token, repository, "actions", integration[1] === "/dispatches" ? "write" : "read"))
					return denied();
				if (!present) return answer(404, { message: "Not Found" });
				if (!integration[1] && method === "GET") return answer(200, { id: 1, path: file, state: "active" });
				if (integration[1] === "/dispatches" && method === "POST") {
					const fields = (body ?? {}) as { ref?: string; inputs?: Record<string, string> };
					if (!fields.ref || !this.branchHead(repository, fields.ref))
						return answer(422, { message: "No ref found for: " + fields.ref });
					const id = ++this.nextId;
					this.integrationRuns.push({
						id,
						repository: repository.id,
						ref: fields.ref,
						inputs: fields.inputs ?? {},
						head_sha: this.branchHead(repository, fields.ref)!,
						path: file,
						triggering_actor: { login: this.slug + "[bot]", type: "Bot" },
						status: "queued",
						conclusion: null,
						display_title: `windlass-integration ${fields.inputs?.feature} ${fields.inputs?.attempt}`,
						html_url: `${this.url}/${repository.owner}/${repository.name}/actions/runs/${id}`,
						created_at: new Date().toISOString(),
						run_started_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
					});
					response.writeHead(204).end();
					entry.status = 204;
					return;
				}
				if (integration[1] === "/runs" && method === "GET") {
					const branch = url.searchParams.get("branch");
					return answer(200, {
						workflow_runs: this.integrationRuns
							.filter(r => r.repository === repository.id && (!branch || r.ref === branch))
							.reverse(),
					});
				}
			}
			const actionRun = /^\/actions\/runs\/(\d+)$/.exec(rest);
			if (actionRun && method === "GET") {
				if (!this.allows(token, repository, "actions", "read")) return denied();
				const run = this.integrationRuns.find(r => r.repository === repository.id && r.id === Number(actionRun[1]));
				return run ? answer(200, run) : answer(404, { message: "Not Found" });
			}
			if (rest === "/actions/workflows" && method === "GET") {
				if (!this.allows(token, repository, "actions", "read")) return denied();
				const paths = git(
					["ls-tree", "-r", "--name-only", repository.defaultBranch, "--", ".github/workflows"],
					repository.path,
				);
				return pageOf(
					"workflows",
					paths
						.split("\n")
						.filter(Boolean)
						.map(path => ({ path, state: "active" })),
				);
			}
			const comparison = /^\/compare\/(.+)\.\.\.(.+)$/.exec(rest);
			if (comparison && method === "GET") {
				if (!this.allows(token, repository, "contents", "read")) return denied();
				const base = /^[0-9a-f]{40}$/.test(comparison[1])
					? comparison[1]
					: this.branchHead(repository, decodeURIComponent(comparison[1]));
				if (!base) return answer(404, { message: "Branch not found" });
				const head = /^[0-9a-f]{40}$/.test(comparison[2])
					? comparison[2]
					: this.branchHead(repository, decodeURIComponent(comparison[2]));
				if (!head) return answer(404, { message: "Branch not found" });
				try {
					const range = base + "..." + head;
					const files = git(["diff", "--name-only", range], repository.path)
						.split("\n")
						.filter(Boolean)
						.map(filename => ({
							filename,
							patch: git(["diff", range, "--", filename], repository.path)
								.split(/(?=^@@ )/m)
								.slice(1)
								.join(""),
						}));
					return answer(200, {
						base_commit: { sha: base },
						merge_base_commit: { sha: git(["merge-base", base, head], repository.path) },
						behind_by: Number(git(["rev-list", "--count", base, "^" + head], repository.path)),
						files,
					});
				} catch {
					return answer(404, { message: "Commit not found" });
				}
			}
			if (rest === "/merges" && method === "POST") {
				if (!this.allows(token, repository, "contents", "write")) return denied();
				const { base, head, commit_message } = body as { base: string; head: string; commit_message: string };
				const old = this.branchHead(repository, base);
				if (!old || !/^[a-f0-9]{40}$/.test(head)) return answer(422, { message: "Invalid merge" });
				if (git(["merge-base", old, head], repository.path) === head) return answer(204, null);
				let tree: string;
				try {
					tree = git(["merge-tree", "--write-tree", "--name-only", "--no-messages", old, head], repository.path);
				} catch (error) {
					const conflicts = String((error as { stdout?: string }).stdout ?? "")
						.trim()
						.split("\n")
						.slice(1);
					return answer(409, { message: "Merge conflict", conflicts });
				}
				const sha = git(["commit-tree", tree, "-p", old, "-p", head, "-m", commit_message], repository.path);
				git(["update-ref", "refs/heads/" + base, sha, old], repository.path);
				return answer(201, { sha });
			}
			if (rest.startsWith("/git/")) {
				if (!this.allows(token, repository, "contents", method === "GET" ? "read" : "write")) return denied();
				const fields = body as {
					ref: string;
					sha: string;
					tree: string;
					parents: string[];
					message: string;
					author: { date: string; name: string; email: string };
					force: boolean;
				};
				try {
					if (rest === "/git/matching-refs/heads/windlass/" && method === "GET") {
						const refs = git(
							["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/windlass/"],
							repository.path,
						);
						return answer(
							200,
							refs
								.split("\n")
								.filter(Boolean)
								.map(row => {
									const [ref, sha] = row.split(" ");
									return { ref, object: { sha } };
								}),
						);
					}
					if (rest.startsWith("/git/ref/heads/") && method === "GET") {
						const sha = this.branchHead(repository, decodeURIComponent(rest.slice("/git/ref/heads/".length)));
						return answer(sha ? 200 : 404, { object: { sha } });
					}
					if (rest.startsWith("/git/commits/") && method === "GET")
						return answer(200, {
							tree: { sha: git(["show", "-s", "--format=%T", rest.slice("/git/commits/".length)], repository.path) },
						});
					if (rest === "/git/commits" && method === "POST")
						return answer(201, {
							sha: this.featureCommit(repository, fields.parents[0], fields.message, fields.author.date, fields.author),
						});
					if (rest === "/git/refs" && method === "POST") {
						git(["update-ref", fields.ref, fields.sha, "0".repeat(40)], repository.path);
						return answer(201, { object: { sha: fields.sha } });
					}
					if (rest.startsWith("/git/refs/heads/") && method === "PATCH") {
						await this.beforeFastForward?.();
						const ref = rest.slice("/git/".length);
						if (fields.force !== false) return answer(422, { message: "Forced update refused" });
						if (git(["merge-base", ref, fields.sha], repository.path) !== git(["rev-parse", ref], repository.path))
							return answer(422, { message: "Update is not a fast forward" });
						git(["update-ref", ref, fields.sha], repository.path);
						return answer(200, { object: { sha: fields.sha } });
					}
				} catch {
					return answer(422, { message: "Ref update refused" });
				}
			}
			if (rest === "/branches" && method === "GET") {
				if (!this.allows(token, repository, "contents", "read")) return denied();
				const names = git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], repository.path)
					.split("\n")
					.filter(name => name !== "");
				return answer(
					200,
					names.map(name => ({ name, protected: false })),
				);
			}

			if (rest === "/pulls" && method === "POST") {
				if (!this.allows(token, repository, "pull_requests", "write")) return denied();
				// As GitHub does: a token that may write pull requests but cannot read the repository's contents sees no branch.
				if (!this.allows(token, repository, "contents", "read")) {
					return answer(422, {
						message: "Validation Failed",
						errors: [{ resource: "PullRequest", code: "custom", message: "not all refs are readable" }],
					});
				}
				const fields = (body ?? {}) as { title?: string; body?: string; head?: string; base?: string; draft?: boolean };
				const head = String(fields.head ?? "");
				const base = String(fields.base ?? "");
				if (this.options.strictBranches !== false) {
					const headCommit = this.branchHead(repository, head);
					const baseCommit = this.branchHead(repository, base);
					if (headCommit === null)
						return answer(422, {
							message: "Validation Failed",
							errors: [{ resource: "PullRequest", field: "head", code: "invalid" }],
						});
					if (baseCommit === null)
						return answer(422, {
							message: "Validation Failed",
							errors: [{ resource: "PullRequest", field: "base", code: "invalid" }],
						});
					if (git(["rev-list", "--count", `${baseCommit}..${headCommit}`], repository.path) === "0")
						return answer(422, {
							message: "Validation Failed",
							errors: [{ resource: "PullRequest", code: "custom", message: `No commits between ${base} and ${head}` }],
						});
				}
				if (
					this.pulls.some(
						pull =>
							pull.repository === repository.id && pull.state === "open" && pull.head === head && pull.base === base,
					)
				) {
					return answer(422, {
						message: "Validation Failed",
						errors: [
							{
								resource: "PullRequest",
								code: "custom",
								message: `A pull request already exists for ${repository.owner}:${head}.`,
							},
						],
					});
				}
				const pull: StandinPull = {
					number: this.pulls.filter(other => other.repository === repository.id).length + 1,
					repository: repository.id,
					title: String(fields.title ?? ""),
					body: String(fields.body ?? ""),
					head,
					base,
					state: "open",
					merged: false,
					mergeable: null,
					draft: fields.draft === true,
					requestedReviewers: [],
					comments: [],
				};
				this.pulls.push(pull);
				if (this.branchHead(repository, head))
					git(["symbolic-ref", `refs/pull/${pull.number}/head`, `refs/heads/${head}`], repository.path);
				return answer(201, this.pullJson(pull));
			}

			if (rest === "/pulls" && method === "GET") {
				if (!this.allows(token, repository, "pull_requests", "read")) return denied();
				const head = (url.searchParams.get("head") ?? "").split(":").pop() ?? "";
				const base = url.searchParams.get("base");
				const list = this.pulls.filter(
					pull =>
						pull.repository === repository.id &&
						pull.state === (url.searchParams.get("state") ?? "open") &&
						(head === "" || pull.head === head) &&
						(base === null || pull.base === base),
				);
				return answer(
					200,
					list.map(pull => this.pullJson(pull)),
				);
			}

			const mergeRoute = /^\/pulls\/(\d+)\/merge$/.exec(rest);
			if (mergeRoute && method === "PUT") {
				if (!this.allows(token, repository, "contents", "write")) return denied();
				const pull = this.pulls.find(p => p.repository === repository.id && p.number === Number(mergeRoute[1]));
				if (!pull) return answer(404, { message: "Pull request not found" });
				const fields = body as { sha: string; merge_method: string; commit_title: string };
				if (fields.sha !== (pull.headSha ?? this.branchHead(repository, pull.head)))
					return answer(409, { message: "Head branch was modified" });
				if (pull.mergeRefusal) return answer(405, { message: pull.mergeRefusal });
				if (pull.state !== "open" || !pull.mergeable || pull.draft)
					return answer(405, { message: "Pull request is not mergeable" });
				if (fields.merge_method !== "squash" || fields.commit_title !== pull.title)
					return answer(422, { message: "Expected a squash with the pull request title" });
				pull.mergedByApp = true;
				pull.merged = true;
				pull.state = "closed";
				return answer(200, { merged: true, message: "Pull Request successfully merged" });
			}
			const reviewRoute = /^\/pulls\/(\d+)\/reviews(?:\/(\d+)(\/comments)?)?$/.exec(rest);
			if (reviewRoute && !reviewRoute[2] && method === "POST") {
				if (!this.allows(token, repository, "pull_requests", "write")) return denied();
				const pull = this.pulls.find(p => p.repository === repository.id && p.number === Number(reviewRoute[1]));
				if (!pull) return answer(404, {});
				const fields = body as { event?: string; body?: string; comments?: StandinLine[]; commit_id?: string };
				const states = new Map([
					["REQUEST_CHANGES", "changes_requested"],
					["COMMENT", "commented"],
					["APPROVE", "approved"],
				]);
				const state = states.get(fields.event ?? "");
				if (!state || !Array.isArray(fields.comments ?? [])) return answer(422, {});
				const bot = { id: Number(this.appId), login: this.slug + "[bot]", type: "Bot" as const };
				if (fields.body?.startsWith("<!-- windlass-review:") && !fields.commit_id) return answer(422, {});
				const posted = this.submitReview(repository, pull, bot, state, fields.body ?? "", fields.comments);
				if (fields.commit_id) {
					posted.review.commit_id = fields.commit_id;
					for (const line of posted.lines) line.commit_id = fields.commit_id;
				}
				return answer(200, posted.review);
			}
			if (reviewRoute && method === "GET") {
				if (!this.allows(token, repository, "pull_requests", "read")) return denied();
				const list = this.reviews.filter(r => r.repository === repository.id && r.pr === Number(reviewRoute[1]));
				if (!reviewRoute[2]) return arrayPage(list.map(r => r.review));
				const r = list.find(r => String(r.review.id) === reviewRoute[2]);
				if (!r) return answer(404, {});
				return reviewRoute[3] ? arrayPage(r.lines) : answer(200, r.review);
			}
			const lineRoute = /^\/pulls\/comments\/(\d+)$/.exec(rest);
			if (lineRoute && method === "GET") {
				if (!this.allows(token, repository, "pull_requests", "read")) return denied();
				const line = this.reviews
					.filter(r => r.repository === repository.id)
					.flatMap(r => r.lines)
					.find(r => String(r.id) === lineRoute[1]);
				return line ? answer(200, line) : answer(404, {});
			}
			const reaction = /^\/(issues|pulls)\/comments\/(\d+)\/reactions$/.exec(rest);
			if (reaction && method === "POST") {
				if (!this.allows(token, repository, reaction[1] === "issues" ? "issues" : "pull_requests", "write"))
					return denied();
				const exists =
					reaction[1] === "issues"
						? [...this.issues, ...this.pulls].some(
								p => p.repository === repository.id && p.comments.some(c => String(c.id) === reaction[2]),
							)
						: this.reviews.some(r => r.repository === repository.id && r.lines.some(c => String(c.id) === reaction[2]));
				if (!exists) return answer(404, {});
				if ((body as { content: string }).content !== "eyes") return answer(422, {});
				this.reactions.add(reaction[1] + ":" + reaction[2]);
				return answer(200, { content: "eyes" });
			}
			const review = /^\/pulls\/(\d+)\/requested_reviewers$/.exec(rest);
			if (review && method === "POST") {
				if (!this.allows(token, repository, "pull_requests", "write")) return denied();
				const pull = this.pulls.find(one => one.repository === repository.id && one.number === Number(review[1]));
				if (!pull) return answer(404, { message: "Not Found" });
				const logins = (body as { reviewers: string[] }).reviewers;
				if (logins.some(login => !this.users.has(login) || this.levelOf(repository, login) === "none"))
					return answer(422, { message: "Reviewers must be collaborators" });
				pull.requestedReviewers = [...new Set([...pull.requestedReviewers, ...logins])];
				return answer(201, this.pullJson(pull));
			}
			const resource = /^\/issues\/(\d+)(?:\/(events|comments|reactions))?$/.exec(rest);
			const issue =
				resource && this.issues.find(i => i.repository === repository.id && i.number === Number(resource[1]));
			const base = `${this.apiUrl}/repos/${repository.owner}/${repository.name}/issues`;
			if (issue) {
				if (!this.allows(token, repository, "issues", method === "GET" ? "read" : "write")) return denied();
				if (resource[2] === "reactions" && method === "POST") {
					if ((body as { content: string }).content !== "eyes") return answer(422, {});
					this.reactions.add("issue:" + issue.number);
					return answer(200, { content: "eyes" });
				}
				if (!resource[2] && method === "GET" && issue.readResponse) {
					if (issue.readResponse === "timeout") return;
					return answer(issue.readResponse.status, issue.readResponse.body ?? {}, issue.readResponse.headers);
				}
				if (!resource[2] && method === "GET")
					return answer(200, {
						...issue,
						url: base + "/" + issue.number,
						user: { ...issue.user, type: "User" },
						labels: issue.labels.map(name => ({ name })),
					});
				if (resource[2] === "events" && method === "GET")
					return answer(
						200,
						issue.events.map(e => ({ ...e, actor: { ...e.actor, type: "User" } })),
					);
				if (resource[2] === "comments" && method === "GET")
					return arrayPage(
						issue.comments.filter(
							c => !url.searchParams.has("since") || c.created_at >= url.searchParams.get("since")!,
						),
					);
				if (resource[2] === "comments" && method === "POST") {
					if (this.commentFault === "refuse") return denied();
					const comment = {
						id: ++this.nextCommentId,
						body: (body as { body: string }).body,
						user: { login: this.slug + "[bot]", type: "Bot" },
						created_at: new Date().toISOString(),
					};
					issue.comments.push(comment);
					if (this.commentFault === "lose_reply") return void response.destroy();
					return answer(201, comment);
				}
			}
			const commentResource = /^\/issues\/comments\/(\d+)$/.exec(rest);
			if (commentResource && method === "GET") {
				for (const pull of this.pulls.filter(p => p.repository === repository.id)) {
					const comment = pull.comments.find(c => String(c.id) === commentResource[1]);
					if (!comment) continue;
					if (
						!this.allows(token, repository, "pull_requests", "read") &&
						!this.allows(token, repository, "issues", "read")
					)
						return denied();
					return answer(200, { ...comment, issue_url: base + "/" + pull.number });
				}
			}
			if (commentResource) {
				for (const i of this.issues.filter(i => i.repository === repository.id)) {
					const comment = i.comments.find(one => String(one.id) === commentResource[1]);
					if (!comment) continue;
					if (!this.allows(token, repository, "issues", method === "GET" ? "read" : "write")) return denied();
					if (method === "PATCH") comment.body = (body as { body: string }).body;
					return answer(200, { ...comment, issue_url: base + "/" + i.number });
				}
			}
			const comments = /^\/issues\/(\d+)\/comments$/.exec(rest);
			if (comments && (method === "GET" || method === "POST")) {
				if (!this.allows(token, repository, "pull_requests", method === "GET" ? "read" : "write")) return denied();
				const pull = this.pulls.find(one => one.repository === repository.id && one.number === Number(comments[1]));
				if (!pull) return answer(404, { message: "Not Found" });
				if (method === "GET")
					return arrayPage(
						pull.comments.filter(
							c => !url.searchParams.has("since") || (c.created_at ?? "") >= url.searchParams.get("since")!,
						),
					);
				if (this.commentFault === "refuse") return denied();
				const comment = {
					id: ++this.nextCommentId,
					body: (body as { body: string }).body,
					user: { login: `${this.slug}[bot]` },
				};
				pull.comments.push(comment);
				if (this.commentFault === "lose_reply") return void response.destroy();
				return answer(201, comment);
			}
			const edit = /^\/issues\/comments\/(\d+)$/.exec(rest);
			if (edit && method === "PATCH") {
				if (!this.allows(token, repository, "pull_requests", "write")) return denied();
				const comment = this.pulls
					.filter(one => one.repository === repository.id)
					.flatMap(one => one.comments)
					.find(one => String(one.id) === edit[1]);
				if (!comment) return answer(404, { message: "Not Found" });
				if (this.commentFault === "refuse") return denied();
				comment.body = (body as { body: string }).body;
				return answer(200, comment);
			}

			const one = /^\/pulls\/(\d+)$/.exec(rest);
			if (one && method === "GET") {
				if (!this.allows(token, repository, "pull_requests", "read")) return denied();
				const pull = this.pulls.find(
					candidate => candidate.repository === repository.id && candidate.number === Number(one[1]),
				);
				return pull ? answer(200, this.pullJson(pull)) : answer(404, { message: "Not Found" });
			}
			if (one && method === "PATCH") {
				if (!this.allows(token, repository, "pull_requests", "write")) return denied();
				const pull = this.pulls.find(
					candidate => candidate.repository === repository.id && candidate.number === Number(one[1]),
				);
				if (!pull) return answer(404, { message: "Not Found" });
				const fields = (body ?? {}) as { title?: unknown; body?: unknown };
				if (typeof fields.title === "string") pull.title = fields.title;
				if (typeof fields.body === "string") pull.body = fields.body;
				return answer(200, this.pullJson(pull));
			}
		}
		return answer(404, { message: "Not Found" });
	}

	/** The git remote: smart HTTP through `git http-backend`, behind the checks GitHub makes of a token. */
	private async git(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		owner: string,
		name: string,
		endpoint: string,
	): Promise<void> {
		const service = endpoint === "info/refs" ? (url.searchParams.get("service") ?? "") : endpoint;
		const write = service === "git-receive-pack";
		const repository = [...this.repositories.values()].find(
			candidate => candidate.owner === owner && candidate.name === name,
		);
		const auth = this.authOf(request);
		const entry: StandinRequest = {
			method: request.method ?? "GET",
			path: url.pathname + url.search,
			auth: auth.basic ? "basic" : "none",
			body: null,
			status: 0,
		};
		this.requests.push(entry);
		const refuse = (status: number, text: string, headers: Record<string, string> = {}) => {
			entry.status = status;
			request.resume();
			response.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
			response.end(text);
		};
		const challenge = { "www-authenticate": 'Basic realm="GitHub"' };

		const token = auth.basic && auth.basic[0] === "x-access-token" ? this.tokenOf(auth.basic[1]) : null;
		if (auth.basic && (!token || token.kind !== "installation"))
			return refuse(
				401,
				"Invalid username or token. Password authentication is not supported for Git operations.\n",
				challenge,
			);
		if (!repository)
			return token ? refuse(404, "Repository not found.\n") : refuse(401, "Repository not found.\n", challenge);
		if (!token) {
			// A public repository is read by anyone; everything else asks who is there.
			if (write || repository.private) return refuse(401, "Authentication required.\n", challenge);
		} else {
			if (!this.allows(token, repository, "contents", "read")) return refuse(404, "Repository not found.\n");
			if (write && (!this.allows(token, repository, "contents", "write") || repository.archived))
				return refuse(403, `Permission to ${owner}/${name}.git denied to ${this.slug}[bot].\n`);
		}

		if (token && !write && endpoint === "info/refs" && this.hangNextGitRead) {
			this.hangNextGitRead = false;
			return;
		}

		const env: Record<string, string> = {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			GIT_PROJECT_ROOT: join(this.root, "git"),
			GIT_HTTP_EXPORT_ALL: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			REQUEST_METHOD: request.method ?? "GET",
			PATH_INFO: url.pathname,
			QUERY_STRING: url.search.slice(1),
			CONTENT_TYPE: String(request.headers["content-type"] ?? ""),
			REMOTE_USER: token ? `${this.slug}[bot]` : "",
			REMOTE_ADDR: "127.0.0.1",
		};
		if (request.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = String(request.headers["content-encoding"]);
		if (request.headers["git-protocol"]) env.GIT_PROTOCOL = String(request.headers["git-protocol"]);
		const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
		this.children.add(child);
		child.on("close", () => this.children.delete(child));
		child.stdin.on("error", () => undefined);
		request.pipe(child.stdin);

		let head = Buffer.alloc(0);
		let sent = false;
		child.stdout.on("data", (chunk: Buffer) => {
			if (sent) {
				this.gitResponseBytes += chunk.length;
				response.write(chunk);
				return;
			}
			head = Buffer.concat([head, chunk]);
			const end = head.indexOf("\r\n\r\n");
			if (end < 0) return;
			const headers: Record<string, string> = {};
			let status = 200;
			for (const line of head.subarray(0, end).toString("utf8").split("\r\n")) {
				const at = line.indexOf(":");
				const key = line.slice(0, at).trim().toLowerCase();
				const value = line.slice(at + 1).trim();
				if (key === "status") status = Number.parseInt(value, 10);
				else if (key !== "") headers[key] = value;
			}
			entry.status = status;
			sent = true;
			response.writeHead(status, headers);
			this.gitResponseBytes += head.length - end - 4;
			response.write(head.subarray(end + 4));
		});
		await new Promise<void>(resolve => child.on("close", () => resolve()));
		if (!sent) {
			entry.status = 500;
			response.writeHead(500);
		}
		response.end();
	}
}

/** Whether this machine has what the git remote needs. */
export function gitHttpBackendAvailable(): boolean {
	try {
		return existsSync(join(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "git-http-backend"));
	} catch {
		return false;
	}
}
