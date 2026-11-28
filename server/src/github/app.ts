import { dependencyHash, SHA, type TreeEntry } from "../sandbox/snapshot-key.js";

import type { GithubId } from "../contract.js";
import type { GitAccess, GitCredential } from "../codehost/types.js";
import { VERIFIED_NAME, type CheckRunUpdate } from "./checks.js";
import { decimalId, githubId, githubJsonInteger, parseGithubJson } from "./ids.js";
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { githubClientSecret, githubConfig, githubPrivateKey } from "../config.js";
import { redact } from "./redact.js";

/**
 * The GitHub App as the server uses it. Each installation token is requested for one repository and only the
 * permissions its step needs (`TokenScope`); only read-only ones are kept for reuse. User tokens come from the code exchange.
 */
/** The REST API version every request names; the one GitHub's documentation showed when this was written. */
export const GITHUB_API_VERSION = "2026-03-10";
const USER_AGENT = "windlass-platform";
const REQUEST_TIMEOUT_MS = 20_000;
/** Listings are read a hundred a page (GitHub's most), up to this many pages. */
const MAX_PAGES = 10;
/** A kept read-only token is not used again within this long of its expiry (GitHub's tokens last an hour). */
const KEEP_MARGIN_MS = 10 * 60 * 1000;
/** At most this many read-only tokens are kept at once, the oldest dropped first. */
const MAX_KEPT_TOKENS = 2000;

/** GitHub accepts inline reviews only on lines displayed in the PR diff. Context is on the right. */
function reviewLineInPatch(patch: string, side: string, line: number): boolean {
	let left = 0,
		right = 0;
	for (const row of patch.split("\n")) {
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
		if (hunk) {
			left = Number(hunk[1]);
			right = Number(hunk[2]);
			continue;
		}
		if (row.startsWith("-") && side === "LEFT" && left === line) return true;
		if ((row.startsWith("+") || row.startsWith(" ")) && side === "RIGHT" && right === line) return true;
		if (row.startsWith("-") || row.startsWith(" ")) left++;
		if (row.startsWith("+") || row.startsWith(" ")) right++;
	}
	return false;
}

const readsOnly = (scope: TokenScope) => Object.values(scope.permissions).every(level => level === "read");

export interface GithubAppSettings {
	appId: string;
	slug: string;
	clientId: string;
	/** GitHub's API, without a trailing slash. */
	apiUrl: string;
	/** GitHub itself, without a trailing slash: where users authorize and git clones from. */
	webUrl: string;
}

/**
 * A failure of a call to GitHub. `status` is GitHub's answer (0 when it could not be reached), `said`
 * is GitHub's own `message`, redacted. Whoever catches it turns it into a sentence for the user; the
 * error's own message is for the server's log and names the call, never a credential.
 */
export class GithubError extends Error {
	constructor(
		readonly status: number,
		readonly said: string,
		what: string,
		readonly headers = new Headers(),
		readonly conflictFiles: string[] = [],
		readonly oauthCode?: string,
	) {
		super(`${what}: ${status === 0 ? said : `GitHub answered ${status}${said ? ` (${said})` : ""}`}`);
		this.name = "GithubError";
	}

	get rateLimited(): boolean {
		return (
			this.status === 429 ||
			(this.status === 403 &&
				(this.headers.has("retry-after") ||
					this.headers.get("x-ratelimit-remaining") === "0" ||
					/rate limit/i.test(this.said)))
		);
	}

	get unreachable(): boolean {
		return this.status === 0 || this.status >= 500;
	}
}

/**
 * A GraphQL request GitHub answered without doing it. GitHub answers most refusals with 200 and an `errors` list, so
 * `type` and `said` come from its first error; both are null when it gave none and only left out the expected data.
 */
export class GraphqlRefusal extends Error {
	readonly type: string | null;
	readonly said: string | null;
	constructor(what: string, body: unknown, unconfirmed: string) {
		const first = graphqlError(body);
		super(first ? `GitHub refused to ${what}: ${first.text}` : unconfirmed);
		this.name = "GraphqlRefusal";
		this.type = first?.type ?? null;
		this.said = first?.text ?? null;
	}
}

/** The first of a GraphQL answer's `errors`, as "TYPE: message", cut to a log line. */
export function graphqlError(body: unknown): { type: string | null; text: string } | null {
	const errors = record(body).errors;
	if (!Array.isArray(errors) || errors.length === 0) return null;
	const first = record(errors[0]);
	const type = typeof first.type === "string" && first.type ? first.type.slice(0, 64) : null;
	const message = typeof first.message === "string" ? first.message.replace(/\s+/g, " ").trim().slice(0, 300) : "";
	return { type, text: [type, message].filter(Boolean).join(": ") || "an error without a message" };
}

export type PermissionLevel = "read" | "write";

/** What an installation token is asked for: one repository (or none: the installation's list) and the permissions of one step. */
export interface TokenScope {
	/** GitHub's id of the one repository the token is good for; omitted only to list the installation's repositories. */
	repositoryId?: GithubId;
	permissions: {
		metadata: "read";
		issues?: PermissionLevel;
		contents?: PermissionLevel;
		pull_requests?: PermissionLevel;
		checks?: PermissionLevel;
		statuses?: "read";
		actions?: PermissionLevel;
	};
}

export interface InstallationToken {
	/** Repository returned by GitHub for a token requested by one numeric ID. */
	repository?: Repository;
	/** A secret. */
	token: string;
	expiresAt: number;
}

/** Only an https picture address is kept: the web app shows it as an image. */
export function picture(value: unknown): string | null {
	const url = typeof value === "string" && value.length <= 2048 ? URL.parse(value) : null;
	return url?.protocol === "https:" ? url.href : null;
}

export interface GithubUser {
	id: GithubId;
	login: string;
	name?: string | null;
	avatar?: string | null;
}

export interface Installation {
	id: GithubId;
	account: { id: GithubId; login: string; type: "User" | "Organization" };
	/** The installation's page at GitHub, where its repositories are chosen. */
	htmlUrl: string;
	suspended: boolean;
}

export interface Repository {
	secretScanning?: true;
	id: GithubId;
	owner: string;
	name: string;
	private: boolean;
	archived: boolean;
	defaultBranch: string;
	pushedAt: number | null;
}

export interface Pull {
	mergedByApp?: true;
	number: number;
	url: string;
	state: "open" | "draft" | "merged" | "closed";
	mergeable: boolean | null;
	title: string;
	/** Its description, as GitHub has it; "" when it has none. */
	body: string;
	/** Its branch. */
	head: string;
	/** The commit its branch is at, as GitHub has it; "" when GitHub did not say. */
	headSha: string;
	baseSha: string;
	base: string;
	requestedReviewers: string[];
}

type Auth = { bearer: string } | { basic: string } | null;

interface Call {
	method?: "PUT" | "GET" | "POST" | "PATCH" | "DELETE";
	path: string;
	query?: Record<string, string | number>;
	body?: unknown;
	auth: Auth;
	/** What the call is, for an error's message: "list the installation's repositories". */
	what: string;
	/** Against GitHub itself instead of its API (the code exchange). */
	web?: boolean;
	/** Credentials that must not appear in an error, beside the ones in `auth`. */
	secrets?: string[];
	/** When the work the call is part of must be over (ms since the epoch): the call gets what is left of it, at most its own limit. */
	deadline?: number;
}

export const record = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
export const text = (value: unknown): string => (typeof value === "string" ? value : "");
const whole = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) ? value : 0);

function githubPerson(value: unknown, allowBot = false): GithubUser | null {
	const row = record(value),
		id = githubId(row.id),
		login = text(row.login);
	const person = row.type === "User" && /^[a-z0-9][a-z0-9_.-]{0,99}$/i.test(login);
	const bot = allowBot && row.type === "Bot" && /^[a-z0-9][a-z0-9_.-]{0,99}\[bot\]$/i.test(login);
	return id && (person || bot) ? { id, login } : null;
}

export class GithubApp {
	private key: KeyObject | null = null;

	constructor(
		readonly settings: GithubAppSettings,
		private readonly secrets: { clientSecret: () => string | null; privateKey: () => string | null },
	) {}

	/** `https://github.com/owner/name`. */
	repositoryUrl(owner: string, name: string): string {
		return `${this.settings.webUrl}/${owner}/${name}`;
	}

	/** What git clones from and pushes to. */
	cloneUrl(owner: string, name: string): string {
		return `${this.repositoryUrl(owner, name)}.git`;
	}

	/** Where a user authorizes the app: the web application flow's first step, with PKCE. */
	authorizeUrl(state: string, codeChallenge: string, redirect?: string): string {
		const query = new URLSearchParams({
			client_id: this.settings.clientId,
			state,
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});
		if (redirect) query.set("redirect_uri", redirect);
		return `${this.settings.webUrl}/login/oauth/authorize?${query}`;
	}

	/** Where a user installs the app on an account and chooses its repositories. */
	installUrl(state: string): string {
		return `${this.settings.webUrl}/apps/${this.settings.slug}/installations/new?${new URLSearchParams({ state })}`;
	}

	// ---- the app's own token ------------------------------------------------------------------

	private privateKey(): KeyObject {
		if (this.key) return this.key;
		const pem = this.secrets.privateKey();
		if (pem === null) throw new Error("WLP_GITHUB_PRIVATE_KEY is not set");
		try {
			this.key = createPrivateKey(pem);
		} catch {
			// Node's own message may quote the input.
			throw new Error(
				"WLP_GITHUB_PRIVATE_KEY is not a private key: give the PEM file GitHub lets you download, as it is or in base64",
			);
		}
		if (this.key.asymmetricKeyType !== "rsa") {
			this.key = null;
			throw new Error("WLP_GITHUB_PRIVATE_KEY is not an RSA key, which is what GitHub signs an app's tokens with");
		}
		return this.key;
	}

	/** The app's JWT. `iat` is a minute back for clocks that differ, and `exp` nine minutes ahead: GitHub accepts ten at most. */
	jwt(now = Date.now()): string {
		const seconds = Math.floor(now / 1000);
		const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
		const body = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: seconds - 60, exp: seconds + 9 * 60, iss: this.settings.appId })}`;
		return `${body}.${createSign("RSA-SHA256").update(body).sign(this.privateKey()).toString("base64url")}`;
	}

	/** Null when the key signs; otherwise why not, in a sentence that names the variable. */
	keyProblem(): string | null {
		try {
			this.jwt();
			return null;
		} catch (error) {
			return error instanceof Error ? error.message : "WLP_GITHUB_PRIVATE_KEY could not be used";
		}
	}

	// ---- requests -----------------------------------------------------------------------------

	private async request(call: Call, redirect: RequestRedirect): Promise<Response> {
		const base = call.web ? this.settings.webUrl : this.settings.apiUrl;
		const url = new URL(`${base}${call.path}`);
		for (const [name, value] of Object.entries(call.query ?? {})) url.searchParams.set(name, String(value));
		const headers: Record<string, string> = {
			accept: call.web ? "application/json" : "application/vnd.github+json",
			"user-agent": USER_AGENT,
		};
		if (!call.web) headers["x-github-api-version"] = GITHUB_API_VERSION;
		if (call.auth && "bearer" in call.auth) {
			headers.authorization = `Bearer ${call.auth.bearer}`;
		} else if (call.auth) {
			headers.authorization = `Basic ${Buffer.from(call.auth.basic, "utf8").toString("base64")}`;
		}
		if (call.body !== undefined) headers["content-type"] = "application/json";

		const limit =
			call.deadline === undefined ? REQUEST_TIMEOUT_MS : Math.min(REQUEST_TIMEOUT_MS, call.deadline - Date.now());
		if (limit <= 0) throw new GithubError(0, "no time was left for it", `could not ${call.what}`);
		try {
			return await fetch(url, {
				method: call.method ?? "GET",
				headers,
				body: call.body === undefined ? undefined : JSON.stringify(call.body),
				signal: AbortSignal.timeout(limit),
				redirect,
			});
		} catch (error) {
			const why =
				error instanceof Error && error.name === "TimeoutError"
					? `no answer within ${Math.ceil(limit / 1000)} seconds`
					: "the request did not get through";
			throw new GithubError(0, why, `could not ${call.what}`);
		}
	}

	async call(
		call: Call,
		redirect: RequestRedirect = "follow",
	): Promise<{ status: number; body: unknown; next: boolean; link: string }> {
		const response = await this.request(call, redirect);
		const raw = await response.text().catch(() => "");
		let body: unknown = null;
		if (raw !== "") {
			try {
				body = parseGithubJson(raw);
			} catch {
				body = null;
			}
		}
		// The code exchange answers 200 with an `error` in it.
		const refused = call.web && text(record(body).error) !== "";
		if (!response.ok || refused) {
			const fields = record(body);
			const errors = Array.isArray(fields.errors)
				? fields.errors.map(entry => text(record(entry).message) || text(entry)).filter(entry => entry !== "")
				: [];
			const said = [text(fields.message) || text(fields.error_description) || text(fields.error), ...errors]
				.filter(part => part !== "")
				.join(": ");
			const known = [...(call.secrets ?? [])];
			if (call.auth) known.push("bearer" in call.auth ? call.auth.bearer : call.auth.basic);
			// The merges endpoint usually returns just a message. Some hosts also identify conflicting paths.
			const conflicts =
				response.status === 409 && call.path.endsWith("/merges")
					? [
							...(Array.isArray(fields.conflicts) ? fields.conflicts : []),
							...(Array.isArray(fields.errors)
								? fields.errors.filter(entry => record(entry).path || record(entry).filename)
								: []),
						]
					: [];
			const files = conflicts
				.map(entry => text(record(entry).path) || text(record(entry).filename) || text(entry))
				.filter(Boolean)
				.slice(0, 12)
				.map(path => redact(path.replace(/\s+/g, " ").slice(0, 200), known));
			throw new GithubError(
				refused && response.ok ? 400 : response.status,
				redact(said.replace(/\s+/g, " ").slice(0, 300), known),
				`could not ${call.what}`,
				response.headers,
				files,
				fields.error === "redirect_uri_mismatch" ? "redirect_uri_mismatch" : undefined,
			);
		}
		return {
			status: response.status,
			body,
			link: response.headers.get("link") ?? "",
			next: /rel="next"/.test(response.headers.get("link") ?? ""),
		};
	}

	/** Every page of a listing, a hundred a page; `truncated` when there were more pages than are read. */
	async pages<T>(
		call: Omit<Call, "method" | "body">,
		read: (body: unknown) => T[],
	): Promise<{ items: T[]; truncated: boolean }> {
		const items: T[] = [];
		for (let page = 1; page <= MAX_PAGES; page += 1) {
			const answer = await this.call({ ...call, query: { ...call.query, per_page: 100, page } });
			items.push(...read(answer.body));
			if (!answer.next) return { items, truncated: false };
		}
		return { items, truncated: true };
	}

	// https://docs.github.com/en/rest/apps/webhooks#list-deliveries-for-an-app-webhook
	// "You must use a JWT"; status=failure selects 400–599; the Link header supplies the next cursor.
	async hookDeliveries(input: { cursor?: string; status: "failure" }) {
		const answer = await this.call({
			path: "/app/hook/deliveries",
			query: { status: input.status, ...(input.cursor ? { cursor: input.cursor } : {}), per_page: 100 },
			auth: { bearer: this.jwt() },
			what: "list failed webhook deliveries",
		});
		if (!Array.isArray(answer.body)) throw new Error("GitHub returned no delivery list");
		const deliveries = answer.body.flatMap(value => {
			const row = record(value);
			const id = decimalId(row.id);
			if (id === null) return [];
			return {
				id,
				guid: text(row.guid),
				at: Date.parse(text(row.delivered_at)),
				installationId: githubId(row.installation_id),
			};
		});
		const next = /<([^>]+)>;\s*rel="next"/.exec(answer.link)?.[1];
		// Use only the cursor, never a link's host or credentials.
		return { deliveries, cursor: next ? new URL(next, this.settings.apiUrl).searchParams.get("cursor") : null };
	}

	// https://docs.github.com/en/rest/apps/webhooks#redeliver-a-delivery-for-an-app-webhook
	// "You must use a JWT"; GitHub answers "202 - Accepted".
	async redeliver(id: string): Promise<void> {
		if (typeof id !== "string" || decimalId(id) === null) throw new Error("Invalid webhook delivery id");
		await this.call({
			method: "POST",
			path: `/app/hook/deliveries/${id}/attempts`,
			auth: { bearer: this.jwt() },
			what: "redeliver a failed webhook",
		});
	}

	// ---- installation tokens ------------------------------------------------------------------

	/** Asks GitHub for a token of one installation, restricted to `scope`. Throws GithubError: 404 when the installation is gone, 422 when it does not cover the repository or the permission. */
	async installationToken(installationId: GithubId, scope: TokenScope, deadline?: number): Promise<InstallationToken> {
		const body: Record<string, unknown> = { permissions: scope.permissions };
		if (scope.repositoryId !== undefined) body.repository_ids = [githubJsonInteger(scope.repositoryId)];
		const answer = await this.call({
			method: "POST",
			path: `/app/installations/${installationId}/access_tokens`,
			body,
			auth: { bearer: this.jwt() },
			what: "get a token for the installation",
			deadline,
		});
		const fields = record(answer.body);
		const token = text(fields.token);
		const expiresAt = Date.parse(text(fields.expires_at));
		if (token === "")
			throw new GithubError(answer.status, "the answer holds no token", "could not get a token for the installation");
		const repository =
			scope.repositoryId && Array.isArray(fields.repositories)
				? fields.repositories.map(r => this.repositoryOf(r)).find(r => r?.id === scope.repositoryId)
				: null;
		return {
			token,
			...(repository && { repository }),
			expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 60 * 60 * 1000,
		};
	}

	/** Revokes an installation token. Never throws: a token that could not be revoked runs out within its hour. */
	async revoke(token: InstallationToken | string): Promise<boolean> {
		const secret = typeof token === "string" ? token : token.token;
		try {
			await this.call({
				method: "DELETE",
				path: "/installation/token",
				auth: { bearer: secret },
				what: "revoke an installation token",
			});
			return true;
		} catch (error) {
			console.error(`[wlp] github.token.revoke_failed: ${error instanceof Error ? error.message : "unknown error"}`);
			return false;
		}
	}

	/**
	 * A token for a sandbox's Git on one repository: `contents: read` to clone and fetch, `contents: write` to push.
	 * Its `revoke` is `revoke` above (`withGitCredential` calls it when the operation has ended).
	 */
	async gitCredential(installationId: GithubId, repositoryId: GithubId, access: GitAccess): Promise<GitCredential> {
		const issued = await this.installationToken(installationId, {
			repositoryId,
			permissions: { metadata: "read", contents: access },
		});
		return {
			token: issued.token,
			username: "x-access-token",
			revoke: async () => {
				await this.revoke(issued);
			},
		};
	}

	/**
	 * Runs `step` with a token of the installation for exactly `scope`. The token is not kept: one that
	 * `step` took into a sandbox (`revokeAfter`) is revoked when the step has ended, however it ended.
	 *
	 * With `reuse`, for a scope that only reads and a step that keeps the token in this process, a token
	 * asked for earlier with exactly the same installation, repository and permissions is used again
	 * until `KEEP_MARGIN_MS` before it expires (see `keptToken`).
	 */
	async withToken<T>(
		installationId: GithubId,
		scope: TokenScope,
		step: (token: string) => Promise<T>,
		options: { revokeAfter?: boolean; reuse?: boolean } = {},
	): Promise<T> {
		if (options.reuse && !options.revokeAfter && readsOnly(scope))
			return this.withKeptToken(installationId, scope, step);
		const issued = await this.installationToken(installationId, scope);
		try {
			return await step(issued.token);
		} finally {
			if (options.revokeAfter) await this.revoke(issued);
		}
	}

	/**
	 * Read-only installation tokens kept for reuse, by installation, repository and permissions. They are
	 * held in this process's memory only: never written anywhere, never logged, never handed to a sandbox.
	 * A poll of an item's CI reads GitHub three times (the repository, the commit's checks, the pull
	 * request), and every item polls for as long as its CI runs; without this each read asked for a token.
	 */
	private readonly kept = new Map<string, { pending: Promise<InstallationToken>; expiresAt: number | null }>();

	/** Forgets every kept token: for the checks, and when GitHub's answers about an installation changed. */
	forgetTokens(): void {
		this.kept.clear();
	}

	private async withKeptToken<T>(
		installationId: GithubId,
		scope: TokenScope,
		step: (token: string) => Promise<T>,
	): Promise<T> {
		const key = `${installationId}:${scope.repositoryId ?? "all"}:${Object.entries(scope.permissions)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, level]) => `${name}=${level}`)
			.join(",")}`;
		const kept = this.kept.get(key);
		if (kept) {
			const issued = await kept.pending.catch(() => null);
			if (issued && issued.expiresAt - Date.now() > KEEP_MARGIN_MS) {
				try {
					return await step(issued.token);
				} catch (error) {
					// A kept token GitHub no longer takes (revoked, or the installation or its repositories changed since)
					// is dropped and the step tried once with a new one, which answers as a token asked for now would.
					if (!(error instanceof GithubError) || error.rateLimited || ![401, 403, 404].includes(error.status))
						throw error;
				}
			}
			if (this.kept.get(key) === kept) this.kept.delete(key);
		}
		const entry: { pending: Promise<InstallationToken>; expiresAt: number | null } = {
			pending: this.installationToken(installationId, scope),
			expiresAt: null,
		};
		entry.pending.then(
			issued => {
				entry.expiresAt = issued.expiresAt;
			},
			() => {
				if (this.kept.get(key) === entry) this.kept.delete(key);
			},
		);
		if (this.kept.size >= MAX_KEPT_TOKENS) {
			const now = Date.now();
			for (const [name, other] of this.kept)
				if (other.expiresAt !== null && other.expiresAt - now <= KEEP_MARGIN_MS) this.kept.delete(name);
			// Then the oldest first: a Map keeps the order its keys were set in.
			for (const name of this.kept.keys()) {
				if (this.kept.size < MAX_KEPT_TOKENS) break;
				this.kept.delete(name);
			}
		}
		this.kept.set(key, entry);
		return step((await entry.pending).token);
	}

	// ---- a user who connects ------------------------------------------------------------------

	/** Exchanges the code a user's authorization ended with for a user access token. */
	async exchangeCode(code: string, codeVerifier: string | null, redirect?: string): Promise<string> {
		const clientSecret = this.secrets.clientSecret();
		if (clientSecret === null) throw new Error("WLP_GITHUB_CLIENT_SECRET is not set");
		const body: Record<string, string> = { client_id: this.settings.clientId, client_secret: clientSecret, code };
		if (redirect) body.redirect_uri = redirect;
		if (codeVerifier !== null) body.code_verifier = codeVerifier;
		const answer = await this.call({
			method: "POST",
			path: "/login/oauth/access_token",
			body,
			auth: null,
			web: true,
			what: "exchange the authorization code",
			secrets: [clientSecret, code],
		});
		const token = text(record(answer.body).access_token);
		if (token === "")
			throw new GithubError(answer.status, "the answer holds no token", "could not exchange the authorization code");
		return token;
	}

	async viewer(userToken: string): Promise<GithubUser> {
		const answer = await this.call({ path: "/user", auth: { bearer: userToken }, what: "read who authorized" });
		const fields = record(answer.body);
		const id = githubId(fields.id);
		const login = text(fields.login);
		if (id === null || login === "")
			throw new GithubError(answer.status, "the answer names no user", "could not read who authorized");
		return { id, login, name: text(fields.name) || null, avatar: picture(fields.avatar_url) };
	}

	async verifiedPrimaryEmail(userToken: string): Promise<string | null> {
		const { items } = await this.pages(
			{ path: "/user/emails", auth: { bearer: userToken }, what: "read verified email" },
			body => {
				if (!Array.isArray(body)) throw new Error("GitHub returned no email list");
				return body;
			},
		);
		const primary = items.map(record).filter(row => row.primary === true && row.verified === true);
		return primary.length === 1 ? text(primary[0]?.email) : null;
	}

	/** The installations of this app the user can reach: accounts they own, and ones they are a member or collaborator in. */
	async userInstallations(userToken: string): Promise<Installation[]> {
		const { items } = await this.pages(
			{ path: "/user/installations", auth: { bearer: userToken }, what: "list the user's installations" },
			body => {
				const list = record(body).installations;
				if (!Array.isArray(list))
					throw new GithubError(502, "the answer holds no installations list", "could not list installations");
				return list;
			},
		);
		return items.map(item => this.installationOf(item)).filter((item): item is Installation => item !== null);
	}

	private installationOf(value: unknown): Installation | null {
		const fields = record(value),
			account = record(fields.account);
		const id = githubId(fields.id),
			accountId = githubId(account.id),
			login = text(account.login);
		if (!id || !accountId || !login || (account.type !== "User" && account.type !== "Organization")) return null;
		return {
			id,
			account: { id: accountId, login, type: account.type },
			htmlUrl: text(fields.html_url),
			suspended: fields.suspended_at != null,
		};
	}

	/** Read the current account and suspension state before applying an installation webhook. */
	async activeInstallation(id: GithubId): Promise<Installation | null> {
		let installation;
		try {
			const { body } = await this.call({
				path: `/app/installations/${id}`,
				auth: { bearer: this.jwt() },
				what: "read the installation",
			});
			installation = this.installationOf(body);
		} catch (error) {
			if (error instanceof GithubError && error.status === 404) return null;
			throw error;
		}
		if (!installation || installation.id !== id || installation.suspended) return null;
		return installation;
	}

	/** Deletes the user access token at GitHub: the platform has asked what it needed. Never throws. */
	async forgetUserToken(userToken: string): Promise<void> {
		const clientSecret = this.secrets.clientSecret();
		if (clientSecret === null) return;
		try {
			await this.call({
				method: "DELETE",
				path: `/applications/${this.settings.clientId}/token`,
				body: { access_token: userToken },
				auth: { basic: `${this.settings.clientId}:${clientSecret}` },
				what: "delete the user's token",
				secrets: [userToken, clientSecret],
			});
		} catch (error) {
			console.error(`[wlp] github.user_token.delete_failed status=${error instanceof GithubError ? error.status : 0}`);
		}
	}

	// ---- repositories -------------------------------------------------------------------------

	private repositoryOf(value: unknown): Repository | null {
		const fields = record(value);
		const id = githubId(fields.id);
		const owner = text(record(fields.owner).login);
		const name = text(fields.name);
		if (id === null || owner === "" || name === "") return null;
		const pushed = Date.parse(text(fields.pushed_at));
		return {
			id,
			owner,
			name,
			...(record(record(fields.security_and_analysis).secret_scanning).status === "enabled" && {
				secretScanning: true as const,
			}),
			private: fields.private === true,
			archived: fields.archived === true,
			defaultBranch: text(fields.default_branch) || "main",
			pushedAt: Number.isFinite(pushed) ? pushed : null,
		};
	}

	/** Every repository the token's installation covers (the first thousand). */
	async installationRepositories(
		token: string,
		deadline?: number,
	): Promise<{ repositories: Repository[]; truncated: boolean }> {
		const { items, truncated } = await this.pages(
			{
				path: "/installation/repositories",
				auth: { bearer: token },
				what: "list the installation's repositories",
				deadline,
			},
			body => {
				const list = record(body).repositories;
				return Array.isArray(list) ? list : [];
			},
		);
		return {
			repositories: items.map(item => this.repositoryOf(item)).filter((item): item is Repository => item !== null),
			truncated,
		};
	}

	async repositoryById(token: string, id: GithubId): Promise<Repository> {
		const answer = await this.call({
			path: `/repositories/${id}`,
			auth: { bearer: token },
			what: "resolve the repository by id",
		});
		const found = this.repositoryOf(answer.body);
		if (found?.id !== id) throw new Error("GitHub did not return the requested repository");
		return found;
	}

	async repository(token: string, owner: string, name: string, deadline?: number): Promise<Repository> {
		const answer = await this.call({
			path: `/repos/${owner}/${name}`,
			auth: { bearer: token },
			what: `read ${owner}/${name}`,
			deadline,
		});
		const found = this.repositoryOf(answer.body);
		if (!found)
			throw new GithubError(answer.status, "the answer describes no repository", `could not read ${owner}/${name}`);
		return found;
	}

	/** The first three hundred branch names. */
	async branches(token: string, owner: string, name: string): Promise<{ branches: string[]; truncated: boolean }> {
		const names: string[] = [];
		for (let page = 1; page <= 3; page += 1) {
			const answer = await this.call({
				path: `/repos/${owner}/${name}/branches`,
				query: { per_page: 100, page },
				auth: { bearer: token },
				what: `list the branches of ${owner}/${name}`,
			});
			for (const item of Array.isArray(answer.body) ? answer.body : []) {
				const branch = text(record(item).name);
				if (branch !== "") names.push(branch);
			}
			if (!answer.next) return { branches: names, truncated: false };
		}
		return { branches: names, truncated: true };
	}

	/**
	 * What a GitHub user may do in a repository, by GitHub's own reckoning of every grant (the
	 * repository's, a team's, the organization's): "admin", "write", "read" or "none". A user GitHub
	 * does not know there is "none".
	 */
	async permission(
		token: string,
		owner: string,
		name: string,
		login: string,
		deadline?: number,
		userId?: GithubId,
	): Promise<"admin" | "write" | "read" | "none"> {
		try {
			const answer = await this.call({
				path: `/repos/${owner}/${name}/collaborators/${encodeURIComponent(login)}/permission`,
				auth: { bearer: token },
				what: `read what ${login} may do in ${owner}/${name}`,
				deadline,
			});
			const row = record(answer.body);
			if (userId !== undefined && githubId(record(row.user).id) !== userId) return "none";
			const level = text(row.permission);
			return level === "admin" || level === "write" || level === "read" ? level : "none";
		} catch (error) {
			if (!(error instanceof GithubError) || error.status !== 404) throw error;
		}
		// Not found: the user is not one GitHub knows in this repository, or the repository is not there.
		// Asking for the repository tells which; if it is gone, that is the failure.
		await this.repository(token, owner, name, deadline);
		return "none";
	}

	/** Git author names are self-reported. The branch activity identifies who actually moved this ref. */
	async branchPush(token: string, owner: string, name: string, branch: string, head: string) {
		const root = `/repos/${owner}/${name}`,
			auth = { bearer: token };
		const ref = "refs/heads/" + branch;
		const activity = await this.call({
			path: root + "/activity",
			auth,
			query: { ref, per_page: 1 },
			what: "identify the branch push",
		});
		const latest = record(Array.isArray(activity.body) && activity.body[0]);
		if (latest.ref !== ref || latest.after !== head) return null;
		const actor = record(latest.actor);
		if (actor.type === "Bot" && text(actor.login).toLowerCase() === this.settings.slug.toLowerCase() + "[bot]")
			return "platform" as const;
		const pusher = githubPerson(actor);
		if (!pusher) return null;
		const result = await this.call({ path: root + "/commits/" + head, auth, what: "read the pushed commit" });
		const commit = record(result.body),
			data = record(commit.commit);
		const author = text(record(commit.author).login) || text(record(data.author).name);
		if (commit.sha !== head || !author || typeof data.message !== "string") return null;
		const parent = Array.isArray(commit.parents) && commit.parents.length === 1 ? record(commit.parents[0]).sha : null;
		return { pusher, author, parent, authorId: githubId(record(commit.author).id), message: data.message };
	}

	async findCheckRun(
		token: string,
		owner: string,
		name: string,
		sha: string,
		item: string,
		checkName = VERIFIED_NAME,
	): Promise<string | null> {
		const { items, truncated } = await this.pages(
			{
				path: `/repos/${owner}/${name}/commits/${sha}/check-runs`,
				auth: { bearer: token },
				what: "find the item's check run",
				query: { check_name: checkName, app_id: this.settings.appId, filter: "all" },
			},
			body => {
				const runs = record(body).check_runs;
				if (!Array.isArray(runs)) throw new Error("GitHub did not list check runs");
				return runs;
			},
		);
		for (const fields of items.map(record)) {
			if (
				fields.name !== checkName ||
				fields.head_sha !== sha ||
				decimalId(record(fields.app).id) !== this.settings.appId
			)
				continue;
			const external = text(fields.external_id);
			if (external.startsWith(item + ":") || external.startsWith("pending:" + item + ":")) {
				const id = decimalId(fields.id);
				if (!id) throw new Error("GitHub returned an invalid check run id");
				return id;
			}
		}
		if (truncated) throw new Error("GitHub cut the list of matching check runs short");
		return null;
	}

	async createCheckRun(
		token: string,
		owner: string,
		name: string,
		sha: string,
		update: CheckRunUpdate,
		checkName = VERIFIED_NAME,
	): Promise<string> {
		const { body } = await this.call({
			method: "POST",
			path: `/repos/${owner}/${name}/check-runs`,
			auth: { bearer: token },
			body: { ...update, name: checkName, head_sha: sha },
			what: "create the item's check run",
		});
		const id = decimalId(record(body).id);
		if (!id) throw new Error("GitHub returned an invalid check run id");
		return id;
	}

	async updateCheckRun(token: string, owner: string, name: string, id: string, update: CheckRunUpdate): Promise<void> {
		await this.call({
			method: "PATCH",
			path: `/repos/${owner}/${name}/check-runs/${id}`,
			auth: { bearer: token },
			body: update,
			what: "update the item's check run",
		});
	}

	/** The sole annotation of each candidate check run, in one request with the same Checks permission. */
	async checkAnnotations(token: string, ids: string[]): Promise<Map<string, string>> {
		const path = this.settings.apiUrl.endsWith("/api/v3") ? "/../graphql" : "/graphql";
		const query =
			"query($ids: [ID!]!) { nodes(ids: $ids) { ... on CheckRun { id annotations(first: 1) { nodes { message } } } } }";
		const { body } = await this.call({
			method: "POST",
			path,
			auth: { bearer: token },
			body: { query, variables: { ids } },
			what: "read check annotations",
		});
		const messages = new Map<string, string>();
		const nodes = record(record(body).data).nodes;
		for (const node of Array.isArray(nodes) ? nodes : []) {
			const { id, annotations } = record(node);
			const list = record(annotations).nodes;
			const message = Array.isArray(list) ? text(record(list[0]).message) : "";
			if (typeof id === "string" && message) messages.set(id, message);
		}
		return messages;
	}

	/** A workflow can supply check output, but GitHub records which runner and steps the job used. */
	async jobNeverStarted(token: string, owner: string, name: string, jobId: string): Promise<boolean> {
		const { body } = await this.call({
			path: `/repos/${owner}/${name}/actions/jobs/${jobId}`,
			auth: { bearer: token },
			what: "read the Actions job",
		});
		const { steps, runner_id } = record(body);
		return Array.isArray(steps) && steps.length === 0 && (runner_id === 0 || runner_id === null);
	}

	/** Job logs redirect to short-lived storage URLs. Start a fresh request there without the installation token. */
	async jobLog(token: string, owner: string, name: string, jobId: string): Promise<Response> {
		const response = await this.request(
			{ path: `/repos/${owner}/${name}/actions/jobs/${jobId}/logs`, auth: { bearer: token }, what: "read the job log" },
			"manual",
		);
		const location = response.headers.get("location");
		if (response.status < 300 || response.status >= 400 || !location) return response;
		await response.body?.cancel();
		return fetch(new URL(location, response.url), {
			headers: { "user-agent": USER_AGENT },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	}

	// ---- pull requests ------------------------------------------------------------------------

	private pullOf(value: unknown): Pull | null {
		const fields = record(value);
		const number = whole(fields.number);
		if (number === 0) return null;
		const merged = fields.merged === true || (fields.merged_at !== null && fields.merged_at !== undefined);
		const state = merged
			? "merged"
			: text(fields.state) === "closed"
				? "closed"
				: fields.draft === true
					? "draft"
					: "open";
		const requestedReviewers = Array.isArray(fields.requested_reviewers)
			? fields.requested_reviewers.map(user => text(record(user).login))
			: [];
		const mergedByApp =
			merged && text(record(fields.merged_by).login).toLowerCase() === this.settings.slug.toLowerCase() + "[bot]";
		return {
			number,
			requestedReviewers,
			...(mergedByApp && { mergedByApp: true }),
			url: text(fields.html_url),
			state,
			mergeable: typeof fields.mergeable === "boolean" ? fields.mergeable : null,
			title: text(fields.title),
			body: text(fields.body),
			head: text(record(fields.head).ref),
			headSha: text(record(fields.head).sha),
			baseSha: text(record(fields.base).sha),
			base: text(record(fields.base).ref),
		};
	}

	async createPull(
		token: string,
		owner: string,
		name: string,
		input: { title: string; body: string; head: string; base: string; draft?: boolean },
	): Promise<Pull> {
		const answer = await this.call({
			method: "POST",
			path: `/repos/${owner}/${name}/pulls`,
			body: input,
			auth: { bearer: token },
			what: `open a pull request in ${owner}/${name}`,
		});
		const pull = this.pullOf(answer.body);
		if (!pull)
			throw new GithubError(
				answer.status,
				"the answer describes no pull request",
				`could not open a pull request in ${owner}/${name}`,
			);
		return pull;
	}

	async squashMerge(
		token: string,
		owner: string,
		name: string,
		number: number,
		head: string,
		title: string,
	): Promise<void> {
		const { body } = await this.call({
			method: "PUT",
			path: `/repos/${owner}/${name}/pulls/${number}/merge`,
			auth: { bearer: token },
			body: { sha: head, merge_method: "squash", commit_title: title },
			what: "merge the reviewed pull request",
		});
		if (record(body).merged !== true)
			throw new Error(text(record(body).message) || "GitHub did not confirm the merge.");
	}

	async pull(token: string, owner: string, name: string, number: number): Promise<Pull> {
		const answer = await this.call({
			path: `/repos/${owner}/${name}/pulls/${number}`,
			auth: { bearer: token },
			what: `read pull request #${number} of ${owner}/${name}`,
		});
		const pull = this.pullOf(answer.body);
		if (pull?.number !== number)
			throw new GithubError(
				answer.status,
				"the answer does not describe the requested pull request",
				`could not read pull request #${number} of ${owner}/${name}`,
			);
		return pull;
	}

	/** Resolve a branch (or pinned review base) once. Every dependency read uses immutable objects. */
	async setupInputs(token: string, owner: string, name: string, revision: string, requireLock = true) {
		const prefix = `/repos/${owner}/${name}`;
		const auth = { bearer: token };
		const { body } = await this.call({
			path: prefix + "/commits/" + encodeURIComponent(revision),
			auth,
			what: "resolve the setup revision",
		});
		const commit = text(record(body).sha),
			treeSha = text(record(record(record(body).commit).tree).sha);
		if (!SHA.test(commit) || !SHA.test(treeSha)) throw new Error("Missing setup revision");
		const tree = record(
			(
				await this.call({
					path: prefix + "/git/trees/" + treeSha,
					query: { recursive: "1" },
					auth,
					what: "read the dependency tree",
				})
			).body,
		);
		if (tree.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree))
			throw new Error("Incomplete dependency tree");
		const files = tree.tree.map((entry): TreeEntry => {
			const e = record(entry);
			if (!text(e.path) || !SHA.test(text(e.sha))) throw new Error("Incomplete tree entry");
			return { path: text(e.path), sha: text(e.sha), mode: text(e.mode), type: text(e.type) };
		});
		return { commit, dependencies: dependencyHash(files, requireLock) };
	}

	/**
	 * The files of a revision that `pick` chooses from its tree, as text, for the fixed reading of a
	 * repository's network needs (repository-network.ts). Read by blob, so a lockfile over the contents
	 * API's 1 MB is read too; a file that is not UTF-8 is passed over. `incomplete` when GitHub cut the
	 * tree short or `pick` left files out. What `pick` says of size holds whatever the tree said: a blob
	 * larger than `maxFileBytes` is passed over, and reading stops once the files read come to `maxBytes`.
	 */
	async scanFiles(
		token: string,
		owner: string,
		name: string,
		revision: string,
		pick: (
			tree: Array<{ path: string; type: string; mode?: string; size: number | null }>,
			truncated: boolean,
		) => { paths: string[]; more: boolean; maxBytes: number; maxFileBytes: number },
	): Promise<{ commit: string; files: Array<{ path: string; text: string }>; incomplete: boolean }> {
		const prefix = `/repos/${owner}/${name}`;
		const auth = { bearer: token };
		const { body } = await this.call({
			path: prefix + "/commits/" + encodeURIComponent(revision),
			auth,
			what: "resolve the branch to read",
		});
		const commit = text(record(body).sha),
			treeSha = text(record(record(record(body).commit).tree).sha);
		if (!SHA.test(commit) || !SHA.test(treeSha)) throw new Error("GitHub named no commit for the branch.");
		const tree = record(
			(
				await this.call({
					path: prefix + "/git/trees/" + treeSha,
					query: { recursive: "1" },
					auth,
					what: "list the repository's files",
				})
			).body,
		);
		const entries = (Array.isArray(tree.tree) ? tree.tree : [])
			.map(entry => {
				const e = record(entry);
				return {
					path: text(e.path),
					type: text(e.type),
					mode: text(e.mode),
					sha: text(e.sha),
					size: typeof e.size === "number" ? e.size : null,
				};
			})
			.filter(entry => entry.path !== "" && SHA.test(entry.sha));
		const picked = pick(entries, tree.truncated === true);
		const shaOf = new Map(entries.map(entry => [entry.path, entry.sha]));
		const files: Array<{ path: string; text: string }> = [];
		let bytes = 0;
		let cut = false;
		for (let at = 0; at < picked.paths.length && !cut; at += 6) {
			const batch = picked.paths.slice(at, at + 6);
			const read = await Promise.all(
				batch.map(async path => {
					const blob = record(
						(
							await this.call({
								path: `${prefix}/git/blobs/${shaOf.get(path)}`,
								auth,
								what: "read a file of the repository",
							})
						).body,
					);
					if (blob.encoding !== "base64" || typeof blob.content !== "string") return null;
					const data = Buffer.from(blob.content, "base64");
					if (data.length > picked.maxFileBytes) return { path, size: data.length, text: null };
					try {
						return { path, size: data.length, text: new TextDecoder("utf-8", { fatal: true }).decode(data) };
					} catch {
						return null;
					}
				}),
			);
			for (const file of read) {
				if (!file) continue;
				if (file.text === null || bytes + file.size > picked.maxBytes) {
					cut = true;
					continue;
				}
				bytes += file.size;
				files.push({ path: file.path, text: file.text });
			}
		}
		return { commit, files, incomplete: tree.truncated === true || picked.more || cut };
	}

	async fileAt(token: string, owner: string, name: string, path: string, sha: string): Promise<string> {
		if (!/^[0-9a-f]{40}$/.test(sha) || path.split("/").some(part => !part || part === "." || part === ".."))
			throw new Error("Invalid file location.");
		const encoded = path.split("/").map(encodeURIComponent).join("/");
		const answer = await this.call({
			path: `/repos/${owner}/${name}/contents/${encoded}`,
			query: { ref: sha },
			auth: { bearer: token },
			what: "read the reviewed file",
		});
		const file = record(answer.body);
		if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string" || file.path !== path)
			throw new Error("GitHub did not return the file contents.");
		return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(file.content, "base64"));
	}

	async requestReviewers(token: string, owner: string, name: string, number: number, logins: string[]): Promise<void> {
		await this.call({
			method: "POST",
			path: `/repos/${owner}/${name}/pulls/${number}/requested_reviewers`,
			body: { reviewers: logins },
			auth: { bearer: token },
			what: "request a review",
		});
	}

	/** A scoped permission preflight by database ID needs no delivery-supplied name. Verify the principal too. */
	async issuePermission(installation: GithubId, repositoryId: GithubId, user: GithubUser) {
		try {
			// A token requested with repository_ids returns its repositories. No separate metadata read
			// is needed to deny a reader. The subject lookup below resolves the ID again at acceptance.
			const { token, repository } = await this.installationToken(installation, {
				repositoryId,
				permissions: { metadata: "read" },
			});
			if (!repository) return "none";
			const { body } = await this.call({
				path: `/repos/${repository.owner}/${repository.name}/collaborators/${encodeURIComponent(user.login)}/permission`,
				auth: { bearer: token },
				what: "check the issue sender's permission",
			});
			const row = record(body),
				level = row.permission;
			if (githubId(record(row.user).id) !== user.id) return "none";
			return level === "admin" || level === "write" || level === "maintain"
				? "write"
				: level === "read"
					? "read"
					: "none";
		} catch (error) {
			if (error instanceof GithubError && [404, 410, 422].includes(error.status)) return "none";
			throw error;
		}
	}

	// https://docs.github.com/en/rest/issues/issues#get-an-issue
	async issue(token: string, repo: Repository, number: number) {
		const path = `/repos/${repo.owner}/${repo.name}/issues/${number}`;
		let answer;
		try {
			answer = await this.call({ path, auth: { bearer: token }, what: "read the issue" }, "manual");
		} catch (error) {
			if (!(error instanceof GithubError)) throw error;
			if (error.status === 404 || error.status === 410) return "gone" as const;
			if (![301, 302, 303, 307, 308].includes(error.status)) throw error;
			const api = new URL(this.settings.apiUrl + "/");
			const location = error.headers.get("location");
			const target = location && URL.parse(location, this.settings.apiUrl + path);
			if (!target || target.origin !== api.origin || !target.pathname.startsWith(api.pathname)) return null;
			const route = target.pathname.slice(api.pathname.length);
			const targetId = githubId(/^repositories\/(\d+)\/issues\/\d+$/.exec(route)?.[1]);
			const targetName = /^repos\/([^/]+\/[^/]+)\/issues\/\d+$/.exec(route)?.[1];
			if (
				(targetId && targetId !== repo.id) ||
				(targetName && targetName.toLowerCase() !== (repo.owner + "/" + repo.name).toLowerCase())
			)
				return "gone" as const;
			return null;
		}
		const row = record(answer.body),
			id = decimalId(row.id),
			author = githubPerson(row.user, true);
		const repositoryId = githubId(record(row.repository).id ?? row.repository_id);
		if (id && repositoryId && repositoryId !== repo.id) return { movedIssueId: id };
		if (
			!id ||
			!author ||
			row.number !== number ||
			row.url !== this.settings.apiUrl + path ||
			row.pull_request ||
			!Array.isArray(row.labels)
		)
			return null;
		return {
			id,
			author,
			number,
			title: text(row.title),
			body: text(row.body),
			url: this.repositoryUrl(repo.owner, repo.name) + "/issues/" + number,
			state: text(row.state),
			labels: row.labels.map(v => record(v).name),
			updated: Date.parse(text(row.updated_at)),
		};
	}

	// https://docs.github.com/en/rest/issues/comments#get-an-issue-comment
	async issueCommand(token: string, repo: Repository, number: number, id: string) {
		if (typeof id !== "string" || decimalId(id) !== id) return null;
		const base = `/repos/${repo.owner}/${repo.name}/issues`;
		const { body } = await this.call({
			path: `${base}/comments/${id}`,
			auth: { bearer: token },
			what: "read the addressed issue comment",
		});
		const row = record(body),
			author = githubPerson(row.user);
		if (!author || decimalId(row.id) !== id || row.issue_url !== `${this.settings.apiUrl}${base}/${number}`)
			return null;
		return {
			id: "comment:" + id,
			author,
			body: text(row.body),
			association: text(row.author_association),
			at: Date.parse(text(row.created_at)),
		};
	}

	private feedbackSubject(repo: Repository, pr: number, raw: unknown, kind: "review" | "line") {
		const row = record(raw),
			author = githubPerson(row.user),
			id = decimalId(row.id);
		const pull = this.settings.apiUrl + `/repos/${repo.owner}/${repo.name}/pulls/${pr}`;
		const parent = row.pull_request_url ?? record(record(row._links).pull_request).href;
		if (!author || !id || parent !== pull) return null;
		const commit = text(
			kind === "line" && row.line === null ? (row.original_commit_id ?? row.commit_id) : row.commit_id,
		);
		if (!/^[a-f0-9]{40}$/i.test(commit)) return null;
		return {
			id,
			nodeId: text(row.node_id),
			author,
			association: text(row.author_association),
			body: text(row.body),
			commit,
			path: kind === "line" ? text(row.path) : null,
			line: whole(row.line ?? row.original_line) || null,
			at: Date.parse(text(kind === "review" ? row.submitted_at : row.created_at)),
			state: text(row.state).toLowerCase(),
			url:
				this.repositoryUrl(repo.owner, repo.name) +
				"/pull/" +
				pr +
				(kind === "review" ? "#pullrequestreview-" : "#discussion_r") +
				id,
		};
	}

	async review(token: string, repo: Repository, pr: number, id: string) {
		if (decimalId(id) !== id) return null;
		const { body } = await this.call({
			path: `/repos/${repo.owner}/${repo.name}/pulls/${pr}/reviews/${id}`,
			auth: { bearer: token },
			what: "read the review",
		});
		const review = this.feedbackSubject(repo, pr, body, "review");
		return review?.id === id ? review : null;
	}

	async reviews(token: string, repo: Repository, pr: number) {
		const call = {
			path: `/repos/${repo.owner}/${repo.name}/pulls/${pr}/reviews`,
			auth: { bearer: token },
			what: "list pull request reviews",
		};
		let page = await this.call({ ...call, query: { per_page: 100 } });
		// GitHub lists oldest first. Follow only the page number, never a supplied URL with the token.
		const last = /[?&]page=(\d+)[^>]*>; rel="last"/.exec(page.link);
		if (last) page = await this.call({ ...call, query: { per_page: 100, page: Number(last[1]) } });
		if (!Array.isArray(page.body)) throw new Error("GitHub returned no reviews list");
		return page.body.map(r => this.feedbackSubject(repo, pr, r, "review")).filter(r => r !== null);
	}

	async postRequestedReview(
		token: string,
		repo: Repository,
		pr: number,
		base: string,
		head: string,
		key: string,
		review: { body: string; comments: { path: string; line: number; side: string; body: string }[] },
	) {
		const path = `/repos/${repo.owner}/${repo.name}/pulls/${pr}/reviews`,
			auth = { bearer: token };
		const marker = `<!-- windlass-review:${key} -->`;
		const { items, truncated } = await this.pages({ path, auth, what: "find the requested review" }, body => {
			if (!Array.isArray(body)) throw new Error("GitHub returned no reviews list");
			return body.filter(r => record(r.user).login === this.settings.slug + "[bot]" && text(r.body).startsWith(marker));
		});
		if (items.length) return;
		if (truncated) throw new Error("The PR review list is incomplete.");
		let comments = review.comments;
		if (comments.length) {
			const diff = await this.call({
				path: `/repos/${repo.owner}/${repo.name}/compare/${base}...${head}`,
				query: { per_page: 1 },
				auth,
				what: "read the reviewed diff",
			});
			const files = record(diff.body).files;
			if (!Array.isArray(files)) throw new Error("GitHub returned no files for the reviewed diff.");
			comments = comments.flatMap(comment => {
				const file = files.find(
					f => (comment.side === "LEFT" ? (f.previous_filename ?? f.filename) : f.filename) === comment.path,
				);
				return file && reviewLineInPatch(text(file.patch), comment.side, comment.line)
					? [{ ...comment, path: file.filename }]
					: [];
			});
		}
		await this.call({
			method: "POST",
			path,
			auth,
			what: "post the requested review",
			body: { comments, body: marker + "\n\n" + review.body, event: "COMMENT", commit_id: head },
		});
	}

	async reviewComments(token: string, repo: Repository, pr: number, id: string) {
		if (decimalId(id) !== id) return [];
		const { items, truncated } = await this.pages(
			{
				path: `/repos/${repo.owner}/${repo.name}/pulls/${pr}/reviews/${id}/comments`,
				auth: { bearer: token },
				what: "read the review’s line comments",
			},
			raw => {
				if (!Array.isArray(raw)) throw new Error("GitHub returned no review comments list");
				return raw
					.filter(r => decimalId(record(r).pull_request_review_id) === id)
					.map(r => this.feedbackSubject(repo, pr, r, "line"))
					.filter(r => r !== null);
			},
		);
		if (truncated) throw new Error("The review comments list is incomplete.");
		return items;
	}

	async reviewComment(token: string, repo: Repository, pr: number, id: string) {
		if (decimalId(id) !== id) return null;
		const { body } = await this.call({
			path: `/repos/${repo.owner}/${repo.name}/pulls/comments/${id}`,
			auth: { bearer: token },
			what: "read the line comment",
		});
		const line = this.feedbackSubject(repo, pr, body, "line");
		return line?.id === id ? line : null;
	}

	async acknowledgeFeedback(
		installationId: GithubId,
		repo: Pick<Repository, "id" | "owner" | "name">,
		key: string,
		reviewNodeId?: string,
	) {
		const [kind, id = ""] = key.split(":");
		const permission = kind === "issue" || kind === "issue_comment" ? "issues" : "pull_requests";
		await this.withToken(
			installationId,
			{ repositoryId: repo.id, permissions: { metadata: "read", [permission]: "write" } },
			async token => {
				if (kind === "issue" || kind === "issue_comment" || kind === "review_comment")
					return this.react(token, repo, { kind, id }, "eyes");
				// A review body takes reactions through GraphQL.
				if (kind !== "review" || !reviewNodeId) throw new Error("Missing GitHub review node.");
				const path = this.settings.apiUrl.endsWith("/api/v3") ? "/../graphql" : "/graphql";
				const query = "mutation($id:ID!) { addReaction(input:{subjectId:$id,content:EYES}) { reaction { content } } }";
				const { body } = await this.call({
					method: "POST",
					path,
					auth: { bearer: token },
					body: { query, variables: { id: reviewNodeId } },
					what: "acknowledge a review",
				});
				const result = record(record(body).data).addReaction;
				if (record(record(result).reaction).content !== "EYES")
					throw new GraphqlRefusal("acknowledge the review", body, "GitHub did not acknowledge the review.");
			},
		).catch(error => {
			if (error instanceof GraphqlRefusal && (error.type === "FORBIDDEN" || error.type === "NOT_FOUND")) {
				console.warn(`github.feedback.ack_skipped entry=${key} graphql=${error.type}`);
				return;
			}
			if (!(error instanceof GithubError) || error.rateLimited || ![403, 404, 410].includes(error.status)) throw error;
			console.warn(`github.feedback.ack_skipped entry=${key} status=${error.status}`);
		});
	}

	async react(
		token: string,
		repo: Pick<Repository, "owner" | "name">,
		target: { kind: "issue" | "issue_comment" | "review_comment"; id: string },
		content: "eyes",
	) {
		if (decimalId(target.id) !== target.id) throw new Error("Invalid reaction target id.");
		const resource = { issue: "issues", issue_comment: "issues/comments", review_comment: "pulls/comments" }[
			target.kind
		];
		await this.call({
			method: "POST",
			path: `/repos/${repo.owner}/${repo.name}/${resource}/${target.id}/reactions`,
			auth: { bearer: token },
			body: { content },
			what: "post an acknowledgement reaction",
		});
	}

	// Issue webhooks carry no labeler's event ID. Use the latest relevant transition in the issue's own history.
	// https://docs.github.com/en/rest/issues/events#list-issue-events
	async issueTransition(token: string, repo: Repository, number: number, action: string, triggerLabel = "windlass") {
		const label = action === "labeled" || action === "unlabeled";
		const { items, truncated } = await this.pages(
			{
				path: `/repos/${repo.owner}/${repo.name}/issues/${number}/events`,
				auth: { bearer: token },
				what: "read the issue's events",
			},
			body => {
				if (!Array.isArray(body)) throw new Error("GitHub returned no issue event list");
				return body.map(record);
			},
		);
		if (truncated) return null;
		const last = items
			.filter(r =>
				label
					? (r.event === "labeled" || r.event === "unlabeled") && record(r.label).name === triggerLabel
					: r.event === action || (action === "closed" && r.event === "reopened"),
			)
			.at(-1);
		if (!last || last.event !== action) return null;
		const id = decimalId(last.id),
			author = githubPerson(last.actor);
		return id && author ? { id: "event:" + id, author, at: Date.parse(text(last.created_at)) } : null;
	}

	async issueCommentPages(token: string, owner: string, name: string, number: number, since?: number) {
		return this.pages(
			{
				path: `/repos/${owner}/${name}/issues/${number}/comments`,
				query: since === undefined ? undefined : { since: new Date(since).toISOString() },
				auth: { bearer: token },
				what: "list the issue or pull request comments",
			},
			body => {
				if (!Array.isArray(body)) throw new Error("GitHub returned no comment list");
				return body.map(entry => {
					const fields = record(entry);
					return {
						id: decimalId(fields.id),
						body: text(fields.body),
						author: text(record(fields.user).login),
						person: githubPerson(fields.user),
						association: text(fields.author_association),
					};
				});
			},
		);
	}

	async issueComments(
		token: string,
		owner: string,
		name: string,
		number: number,
		requireComplete = false,
		since?: number,
	) {
		const { items, truncated } = await this.issueCommentPages(token, owner, name, number, since);
		if (requireComplete && truncated)
			throw new Error("GitHub returned more issue comments than could be checked for the marker");
		return items;
	}

	async createIssueComment(
		token: string,
		owner: string,
		name: string,
		number: number,
		body: string,
		what = "post the verdict comment",
	) {
		const answer = await this.call({
			method: "POST",
			path: `/repos/${owner}/${name}/issues/${number}/comments`,
			body: { body },
			auth: { bearer: token },
			what,
		});
		return decimalId(record(answer.body).id);
	}

	async updateIssueComment(
		token: string,
		owner: string,
		name: string,
		id: string,
		body: string,
		what = "edit the verdict comment",
	): Promise<void> {
		await this.call({
			method: "PATCH",
			path: `/repos/${owner}/${name}/issues/comments/${id}`,
			body: { body },
			auth: { bearer: token },
			what,
		});
	}

	/** Gives an open pull request another title and description. */
	async updatePull(
		token: string,
		owner: string,
		name: string,
		number: number,
		input: { title: string; body: string },
	): Promise<Pull> {
		const answer = await this.call({
			method: "PATCH",
			path: `/repos/${owner}/${name}/pulls/${number}`,
			body: input,
			auth: { bearer: token },
			what: `update pull request #${number} of ${owner}/${name}`,
		});
		const pull = this.pullOf(answer.body);
		if (!pull)
			throw new GithubError(
				answer.status,
				"the answer describes no pull request",
				`could not update pull request #${number} of ${owner}/${name}`,
			);
		return pull;
	}

	async openSetupPull(token: string, owner: string, name: string, id: GithubId, base: string): Promise<Pull | null> {
		for (let page = 1; ; page++) {
			const answer = await this.call({
				path: `/repos/${owner}/${name}/pulls`,
				query: { state: "open", base, per_page: 100, page },
				auth: { bearer: token },
				what: "find the repository setup pull request",
			});
			if (!Array.isArray(answer.body)) throw new Error("GitHub returned no pull request list.");
			for (const raw of answer.body) {
				const head = record(record(raw).head);
				if (String(record(head.repo).id) !== String(id) || !/^windlass\/repo-setup-\d{8}$/.test(text(head.ref)))
					continue;
				const pull = this.pullOf(raw);
				if (pull && pull.base === base) return pull;
			}
			if (!answer.next) return null;
		}
	}

	/** The open pull request from `head` into `base`, if there is one: GitHub allows one per pair of branches. */
	async openPull(token: string, owner: string, name: string, head: string, base: string): Promise<Pull | null> {
		const answer = await this.call({
			path: `/repos/${owner}/${name}/pulls`,
			query: { state: "open", head: `${owner}:${head}`, base, per_page: 5 },
			auth: { bearer: token },
			what: `look for an open pull request in ${owner}/${name}`,
		});
		const list = (Array.isArray(answer.body) ? answer.body : [])
			.map(item => this.pullOf(item))
			.filter((item): item is Pull => item !== null);
		return list.find(item => item.head === head) ?? null;
	}
}

let own: GithubApp | null | undefined;

/** This server's GitHub App, from its configuration; null when the deployment has none. */
export function githubApp(): GithubApp | null {
	if (own === undefined) {
		const { app } = githubConfig();
		own = app ? new GithubApp(app, { clientSecret: githubClientSecret, privateKey: githubPrivateKey }) : null;
	}
	return own;
}
