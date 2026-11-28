import { createHash, randomBytes } from "node:crypto";
import { isRecord } from "../util.js";
import { decimalId, gitlabId, parseGitlabJson } from "./ids.js";

export interface GitlabAppSettings {
	clientId: string;
	baseUrl: string;
	redirectUrl: string;
	/** Where project hooks deliver: the deployment's public address, path prefix included. */
	webhookUrl: string;
}

export interface GitlabToken {
	accessToken: string;
	refreshToken: string | null;
	expiresAt: number | null;
	scopes: string[];
}

export interface GitlabCall {
	method?: "GET" | "POST" | "PUT" | "DELETE";
	/** Relative to apiUrl, beginning with a slash. */
	path: string;
	token: string;
	body?: Record<string, unknown>;
}

type Project = string | number;
export type NoteParent = "issues" | "merge_requests";

function requiredId(value: unknown): string {
	const id = decimalId(value);
	if (!id) throw new Error("Invalid GitLab identifier");
	return id;
}

/** GitLab accepts a decimal ID or the whole namespace/project path in one encoded component. */
function projectRoot(project: Project): string {
	const id = decimalId(project);
	if (id) return `/projects/${id}`;
	if (
		typeof project !== "string" ||
		!project.includes("/") ||
		project.split("/").some(p => !/^[a-zA-Z0-9_.-]+$/.test(p) || p === "." || p === "..")
	)
		throw new Error("Invalid GitLab project path");
	return `/projects/${encodeURIComponent(project)}`;
}

function subject(project: Project, kind: NoteParent, iid: number | string): string {
	return `${projectRoot(project)}/${kind}/${requiredId(iid)}`;
}

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 10;
/** Hooks, merge requests, notes, award emoji, pipelines, job retries and project access tokens all need `api`. */
export const GITLAB_SCOPES = ["api"] as const;
export const GITLAB_PERSON_SCOPES = ["read_user"] as const;
/** Names the project access tokens this platform makes for Git, so a stale one can be found and revoked. */
export const GIT_TOKEN_PREFIX = "windlass-git-";
export const newVerifier = () => randomBytes(32).toString("base64url");
export const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
export const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
export const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Provider diagnostics may echo the request (including OAuth credentials). Keep only the status and retry time. */
export class GitlabError extends Error {
	constructor(
		readonly status: number,
		readonly said: string,
		readonly retryAt = 0,
	) {
		super(`GitLab: ${said}`);
		this.name = "GitlabError";
	}
	get rateLimited() {
		return this.status === 429;
	}
	get unauthorized() {
		return this.status === 401;
	}
	get unreachable() {
		return this.status === 0 || this.status >= 500;
	}
}

async function json(response: Response): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_BYTES) {
				void reader.cancel().catch(() => undefined);
				throw new GitlabError(502, "response too large");
			}
			chunks.push(value);
		}
		return size ? parseGitlabJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) : null;
	} catch (error) {
		if (error instanceof GitlabError) throw error;
		throw new GitlabError(502, "invalid or incomplete response");
	} finally {
		reader.releaseLock();
	}
}

/** Plain HTTP is for local stand-ins only. */
function endpoint(raw: string): URL {
	const url = URL.parse(raw);
	if (
		!url ||
		url.username ||
		url.password ||
		/[?#]/.test(url.href) ||
		(url.protocol !== "https:" &&
			!(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
	)
		throw new Error("Invalid GitLab endpoint");
	return url;
}

async function request(url: string, init: RequestInit): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(20_000) });
	} catch {
		throw new GitlabError(0, "request did not get through");
	}
	if (!response.ok) {
		void response.body?.cancel().catch(() => undefined);
		const retry = response.headers.get("retry-after") ?? "";
		const retryAt = /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry);
		throw new GitlabError(response.status, `HTTP ${response.status}`, Number.isFinite(retryAt) ? retryAt : 0);
	}
	return response;
}

/** A project as GitLab describes it to this token, or null. Only provider-confirmed path segments are kept. */
export function projectAccess(value: unknown) {
	const p = record(value),
		id = gitlabId(p.id),
		parts = text(p.path_with_namespace).split("/");
	if (!id || parts.length < 2 || parts.some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === "." || part === ".."))
		return null;
	const name = parts.pop()!,
		permissions = record(p.permissions),
		last = Date.parse(text(p.last_activity_at));
	const level = Math.max(
		Number(record(permissions.project_access).access_level ?? 0),
		Number(record(permissions.group_access).access_level ?? 0),
	);
	return {
		id,
		owner: parts.join("/"),
		name,
		defaultBranch: text(p.default_branch),
		private: p.visibility !== "public",
		/** Developer (30) or above on a project that is not archived. */
		writable: !p.archived && level >= 30,
		/** The viewer's role there: 40 is Maintainer, which creating a project access token takes. */
		level,
		pushedAt: Number.isFinite(last) ? last : null,
	};
}

export class GitlabApp {
	readonly settings: Readonly<GitlabAppSettings>;

	constructor(
		settings: GitlabAppSettings,
		private readonly secrets: { clientSecret: () => string | null },
	) {
		const baseUrl = endpoint(settings.baseUrl).href.replace(/\/+$/, "");
		this.settings = Object.freeze({
			clientId: settings.clientId,
			baseUrl,
			redirectUrl: endpoint(settings.redirectUrl).href,
			webhookUrl: endpoint(settings.webhookUrl).href,
		});
	}

	cloneUrl(owner: string, name: string): string {
		const parts = [...owner.split("/"), name];
		if (parts.some(p => !p || p === "." || p === ".." || /[/\\\x00-\x1f]/.test(p)))
			throw new Error("Invalid GitLab project path");
		return `${this.settings.baseUrl}/${parts.map(encodeURIComponent).join("/")}.git`;
	}

	/** `person`: someone signing in as themselves with `read_user` only, to prove which GitLab user they are (a linked account). */
	authorizeUrl(state: string, codeChallenge: string, as: "app" | "person" = "app"): string {
		const params = new URLSearchParams({
			client_id: this.settings.clientId,
			redirect_uri: this.settings.redirectUrl,
			response_type: "code",
			scope: (as === "app" ? GITLAB_SCOPES : GITLAB_PERSON_SCOPES).join(" "),
			state,
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});
		return `${this.settings.baseUrl}/oauth/authorize?${params}`;
	}

	private async oauth(action: "token" | "revoke", form: Record<string, string>): Promise<unknown> {
		const secret = this.secrets.clientSecret();
		if (!secret) throw new Error("GitLab OAuth client secret is not set");
		return json(
			await request(`${this.settings.baseUrl}/oauth/${action}`, {
				method: "POST",
				headers: { accept: "application/json" },
				body: new URLSearchParams({ ...form, client_id: this.settings.clientId, client_secret: secret }),
			}),
		);
	}

	private async token(form: Record<string, string>): Promise<GitlabToken> {
		const result = record(await this.oauth("token", form));
		const accessToken = text(result.access_token);
		if (
			!accessToken ||
			/\s/.test(accessToken) ||
			(result.token_type && text(result.token_type).toLowerCase() !== "bearer")
		)
			throw new GitlabError(502, "invalid token response");
		const expires = result.expires_in;
		return {
			accessToken,
			refreshToken: text(result.refresh_token) || null,
			scopes: text(result.scope).split(/\s+/).filter(Boolean),
			expiresAt:
				typeof expires === "number" && Number.isSafeInteger(expires) && expires > 0
					? Date.now() + expires * 1000
					: null,
		};
	}

	exchangeCode(code: string, verifier: string): Promise<GitlabToken> {
		return this.token({
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			redirect_uri: this.settings.redirectUrl,
		});
	}
	refresh(refreshToken: string): Promise<GitlabToken> {
		return this.token({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			redirect_uri: this.settings.redirectUrl,
		});
	}
	async revoke(token: string): Promise<void> {
		await this.oauth("revoke", { token });
	}

	private api(call: GitlabCall): Promise<Response> {
		const base = `${this.settings.baseUrl}/api/v4`;
		const url = URL.parse(base + call.path);
		if (
			!call.path.startsWith("/") ||
			call.path.startsWith("//") ||
			!url ||
			!url.href.startsWith(`${base}/`) ||
			url.hash ||
			/[\\\x00-\x1f]/.test(call.path)
		)
			throw new Error("Invalid GitLab API path");
		return request(url.href, {
			method: call.method ?? "GET",
			headers: {
				accept: "application/json",
				authorization: `Bearer ${call.token}`,
				...(call.body && { "content-type": "application/json" }),
			},
			...(call.body && { body: JSON.stringify(call.body) }),
		});
	}

	async call(call: GitlabCall): Promise<{ body: unknown; headers: Headers; status: number }> {
		const response = await this.api(call);
		return { body: await json(response), headers: response.headers, status: response.status };
	}

	async pages(call: Pick<GitlabCall, "token" | "path">): Promise<{ items: unknown[]; truncated: boolean }> {
		const items: unknown[] = [];
		const queryAt = call.path.indexOf("?");
		const path = queryAt < 0 ? call.path : call.path.slice(0, queryAt);
		const params = new URLSearchParams(queryAt < 0 ? "" : call.path.slice(queryAt + 1));
		params.set("per_page", "100");
		for (let page = 1; page <= MAX_PAGES; page++) {
			params.set("page", String(page));
			const { body, headers } = await this.call({ token: call.token, path: `${path}?${params}` });
			if (!Array.isArray(body)) throw new GitlabError(502, "invalid listing");
			if (body.length > 100) throw new GitlabError(502, "invalid page size");
			items.push(...body);
			// Never follow a URL from Link: reconstruct the next numbered page on the configured instance.
			const next = headers.get("x-next-page");
			if (next === "" || (next === null && !/rel="next"/.test(headers.get("link") ?? "") && body.length < 100))
				return { items, truncated: false };
			if (next && next !== String(page + 1)) throw new GitlabError(502, "invalid pagination");
		}
		return { items, truncated: true };
	}

	projects(token: string, query: string) {
		const params = new URLSearchParams({ membership: "true", search: query, order_by: "last_activity_at" });
		return this.pages({ token, path: `/projects?${params}` });
	}

	async openMr(token: string, project: Project, body: Record<string, unknown>) {
		return (await this.call({ token, method: "POST", path: `${projectRoot(project)}/merge_requests`, body })).body;
	}

	async readMr(token: string, project: Project, iid: number) {
		return (await this.call({ token, path: subject(project, "merge_requests", iid) })).body;
	}

	async updateMr(token: string, project: Project, iid: number, body: Record<string, unknown>) {
		return (await this.call({ token, method: "PUT", path: subject(project, "merge_requests", iid), body })).body;
	}

	async mergeMr(token: string, project: Project, iid: number, head: string, title: string) {
		return (
			await this.call({
				token,
				method: "PUT",
				path: `${subject(project, "merge_requests", iid)}/merge`,
				body: { sha: head, squash: true, squash_commit_message: title },
			})
		).body;
	}

	/** The commit a branch points at now. */
	async branchHead(token: string, project: Project, branch: string): Promise<string> {
		const ref = record(
			(await this.call({ token, path: `${projectRoot(project)}/repository/branches/${encodeURIComponent(branch)}` }))
				.body,
		);
		const sha = text(record(ref.commit).id);
		if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("GitLab did not identify the branch head.");
		return sha;
	}

	/** The paths a change touches, or null when GitLab could not list them all. */
	async changedPaths(token: string, project: Project, from: string, to: string): Promise<string[] | null> {
		if (![from, to].every(sha => /^[0-9a-f]{40,64}$/i.test(sha))) throw new Error("Invalid GitLab commit");
		const params = new URLSearchParams({ from, to, straight: "false" });
		const body = record(
			(await this.call({ token, path: `${projectRoot(project)}/repository/compare?${params}` })).body,
		);
		if (body.compare_timeout === true || !Array.isArray(body.diffs)) return null;
		return body.diffs
			.flatMap(diff => {
				const d = record(diff),
					paths = [text(d.old_path), text(d.new_path)];
				return paths[0] === paths[1] ? [paths[0]] : paths;
			})
			.filter(Boolean);
	}

	/** GitLab returns a list: request only the newest pipeline for this commit, on any ref. */
	async pipelines(token: string, project: Project, head: string) {
		const params = new URLSearchParams({ sha: head, order_by: "id", sort: "desc", per_page: "1" });
		return (await this.call({ token, path: `${projectRoot(project)}/pipelines?${params}` })).body;
	}

	/** The newest pipelines of a merge request: its source branch's, its own (detached) and merged results. */
	async mrPipelines(token: string, project: Project, iid: number) {
		return (await this.call({ token, path: `${subject(project, "merge_requests", iid)}/pipelines?per_page=20` })).body;
	}

	async pipeline(token: string, project: Project, pipelineId: string) {
		return (await this.call({ token, path: `${projectRoot(project)}/pipelines/${requiredId(pipelineId)}` })).body;
	}

	async commitParents(token: string, project: Project, sha: string): Promise<string[]> {
		if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new Error("Invalid GitLab commit");
		const commit = record((await this.call({ token, path: `${projectRoot(project)}/repository/commits/${sha}` })).body);
		return Array.isArray(commit.parent_ids) ? commit.parent_ids.map(text) : [];
	}

	pipelineJobs(token: string, project: Project, pipelineId: string, limit: number) {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid GitLab job page size");
		return this.call({
			token,
			path: `${projectRoot(project)}/pipelines/${requiredId(pipelineId)}/jobs?per_page=${limit}`,
		});
	}

	async retryJob(token: string, project: Project, jobId: string) {
		return (await this.call({ token, method: "POST", path: `${projectRoot(project)}/jobs/${requiredId(jobId)}/retry` }))
			.body;
	}

	notes(token: string, project: Project, kind: NoteParent, iid: number | string) {
		return this.pages({ token, path: `${subject(project, kind, iid)}/notes?sort=asc&order_by=created_at` });
	}

	async createNote(token: string, project: Project, kind: NoteParent, iid: number | string, body: string) {
		return (await this.call({ token, method: "POST", path: `${subject(project, kind, iid)}/notes`, body: { body } }))
			.body;
	}

	async updateNote(
		token: string,
		project: Project,
		kind: NoteParent,
		iid: number | string,
		noteId: string,
		body: string,
	) {
		await this.call({
			token,
			method: "PUT",
			path: `${subject(project, kind, iid)}/notes/${requiredId(noteId)}`,
			body: { body },
		});
	}

	async eyes(token: string, project: Project, kind: NoteParent, iid: number | string, noteId?: string) {
		const parent = subject(project, kind, iid);
		const path = noteId === undefined ? parent : `${parent}/notes/${requiredId(noteId)}`;
		await this.call({ token, method: "POST", path: `${path}/award_emoji`, body: { name: "eyes" } });
	}

	async viewer(token: string) {
		const user = record((await this.call({ token, path: "/user" })).body);
		const id = gitlabId(user.id),
			login = text(user.username);
		if (id === null || !login) throw new GitlabError(502, "invalid user response");
		return { id, login, name: text(user.name) };
	}

	/** Subscribe only to event types the webhook route understands. */
	async projectHook(token: string, projectId: string | number, url: string, secret: string): Promise<string> {
		const project = projectRoot(projectId);
		const target = endpoint(url);
		if (!secret) throw new Error("GitLab webhook secret is not set");
		const { body } = await this.call({
			method: "POST",
			token,
			path: `${project}/hooks`,
			body: {
				name: "Windlass",
				url: target.href,
				token: secret,
				enable_ssl_verification: true,
				merge_requests_events: true,
				pipeline_events: true,
				push_events: false,
				issues_events: true,
				note_events: true,
			},
		});
		const id = decimalId(record(body).id);
		if (!id) throw new GitlabError(502, "invalid project hook response");
		return id;
	}

	/**
	 * A project access token for one sandbox Git operation: `read_repository` as Reporter to clone and fetch,
	 * `write_repository` as Developer to push, expiring at the earliest UTC midnight at least an hour away (GitLab
	 * takes a date, not a time). Revoke it with `revokeProjectToken` when the operation ends. Creating one takes
	 * Maintainer on the project and, on GitLab.com, Premium or Ultimate.
	 */
	async createGitToken(token: string, project: Project, access: "read" | "write", now = Date.now()) {
		const expiresAt = new Date(now + 60 * 60 * 1000 + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
		const scope = access === "write" ? "write_repository" : "read_repository";
		const { body } = await this.call({
			method: "POST",
			token,
			path: `${projectRoot(project)}/access_tokens`,
			body: {
				name: `${GIT_TOKEN_PREFIX}${access}`,
				description: "One Windlass sandbox Git operation. Windlass revokes it when the operation ends.",
				scopes: [scope],
				access_level: access === "write" ? 30 : 20,
				expires_at: expiresAt,
			},
		});
		const made = record(body),
			id = decimalId(made.id),
			secret = text(made.token);
		const scopes = Array.isArray(made.scopes) ? made.scopes : [];
		if (!id || !secret || /\s/.test(secret) || scopes.length !== 1 || scopes[0] !== scope) {
			// A token GitLab made with other scopes than asked is not used; revoke it if it can be named.
			if (id) await this.revokeProjectToken(token, project, id).catch(() => undefined);
			throw new GitlabError(502, "invalid project access token response");
		}
		return { id, token: secret, expiresAt };
	}

	/** Revokes a project access token. One GitLab no longer has is already gone. */
	async revokeProjectToken(token: string, project: Project, tokenId: string): Promise<void> {
		try {
			await this.call({
				method: "DELETE",
				token,
				path: `${projectRoot(project)}/access_tokens/${requiredId(tokenId)}`,
			});
		} catch (error) {
			if (!(error instanceof GitlabError && error.status === 404)) throw error;
		}
	}

	/** Active Git tokens of this platform's on the project created before `before`: left by an operation that never ended. */
	async staleGitTokens(token: string, project: Project, before: number): Promise<string[]> {
		const { items } = await this.pages({ token, path: `${projectRoot(project)}/access_tokens?state=active` });
		return items.flatMap(item => {
			const t = record(item),
				id = decimalId(t.id),
				created = Date.parse(text(t.created_at));
			return id &&
				text(t.name).startsWith(GIT_TOKEN_PREFIX) &&
				t.active !== false &&
				t.revoked !== true &&
				Number.isFinite(created) &&
				created < before
				? [id]
				: [];
		});
	}

	jobTrace(token: string, project: Project, jobId: string): Promise<Response> {
		return this.api({ token, path: `${projectRoot(project)}/jobs/${requiredId(jobId)}/trace` });
	}
}
