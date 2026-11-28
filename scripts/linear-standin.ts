/**
 * A stand-in for the parts of Linear the platform talks to, for the checks: no Linear OAuth app exists
 * while they run, and none may be called. One HTTP server on a loopback port that is, at once,
 *
 *   Linear itself   `/oauth/authorize`, where the owner consents (played by `authorize()`)
 *   Linear's API    `/oauth/token` (authorization code and refresh token), `/graphql` (the reads filing
 *                   needs and the item updates)
 *   Linear's hooks  `deliver()`, which signs and POSTs a webhook delivery to the platform as Linear does
 *
 * It checks what Linear checks, as far as the platform depends on it: the client id and secret, a code
 * that works once with the registered redirect address and the PKCE verifier, `actor=app` (without it
 * the token is a person's and `viewer.app` is false), the scopes asked for, expiry and refresh, a bearer
 * token on every API call. Mutations require the write scope.
 *
 * Webhook payloads follow Linear's shape (`action`, `type`, `actor`, `data`, `updatedFrom` with the
 * previous value of each changed field, `organizationId`, `webhookTimestamp`), signed with
 * `Linear-Signature`, the hex HMAC-SHA256 of the exact bytes, and sent with `Linear-Delivery` and
 * `Linear-Event`. `updateIssue()` computes `updatedFrom` from what actually changed.
 */

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface StandinPerson {
	id: string;
	name: string;
	app: boolean;
}

export interface StandinTeam {
	id: string;
	key: string;
	name: string;
}

export interface StandinLabel {
	id: string;
	name: string;
}

export interface StandinIssue {
	id: string;
	identifier: string;
	number: number;
	title: string;
	description: string;
	teamId: string;
	creatorId: string;
	assigneeId: string | null;
	labelIds: string[];
	stateType: string;
	stateId?: string;
	archived: boolean;
}

export interface StandinOptions {
	/** Teams a page of the listing holds at most (Linear's is 100). */
	pageSize?: number;
	/** What the token exchange grants beside what was asked, or instead of it. */
	grantScopes?: (asked: string[]) => string[];
}

interface Grant {
	clientId: string;
	redirectUri: string;
	challenge: string | null;
	scopes: string[];
	actor: "app" | "user";
	person?: StandinPerson;
	used: boolean;
}

interface Session {
	actor: "app" | "user";
	person?: StandinPerson;
	expiresAt: number;
	refresh: string;
	scopes: string[];
}

export interface DeliveryOptions {
	/** Signs with this instead of the app's signing secret. */
	secret?: string;
	/** Replaces `webhookTimestamp` before the body is signed. */
	timestamp?: number;
	deliveryId?: string;
	event?: string;
	/** Sent instead of the signature of the body. */
	signature?: string;
	/** Sent instead of the signed bytes, with the signature of the original ones. */
	bytes?: Uint8Array;
	/** Leave a header out. */
	omit?: string[];
	method?: string;
}

const UUID_HEX = () => randomUUID();

export class LinearStandin {
	readonly clientId = "linear-client-" + randomBytes(4).toString("hex");
	readonly clientSecret = "lin-client-secret-" + randomBytes(16).toString("hex");
	/** The app's webhook signing secret, as Linear shows it. */
	readonly signingSecret = "lin_wh_" + randomBytes(24).toString("hex");
	readonly redirectUri: string;
	readonly workspace = { id: UUID_HEX(), name: "Acme", urlKey: "acme" };
	readonly appUser: StandinPerson = { id: UUID_HEX(), name: "Windlass", app: true };
	readonly human: StandinPerson = { id: UUID_HEX(), name: "Ada Owner", app: false };
	readonly stranger: StandinPerson = { id: UUID_HEX(), name: "Sam Other", app: false };
	readonly teams: StandinTeam[] = [];
	readonly labels = new Map<string, StandinLabel>();
	readonly issues = new Map<string, StandinIssue>();
	readonly comments = new Map<string, { issueId: string; body: string }>();
	readonly commentReads: string[] = [];
	readonly attachments = new Map<string, string>();
	readonly workflowStates = new Map<string, Array<{ id: string; type: string; name: string; position: number }>>();
	graphqlFailure: 503 | "RATELIMITED" | null = null;
	denyStateChange = false;
	/** Every mutation attempted, including retries. */
	readonly writes: string[] = [];
	/** The paths of API calls, without credentials. */
	readonly calls: string[] = [];
	readonly deliveries: Array<{ deliveryId: string; status: number; body: string }> = [];
	/** What the next consent does. `person`: who signs in as themselves (the owner, `human`, when unset). */
	consent: { approve: boolean; actor?: "app" | "user"; person?: StandinPerson } = { approve: true };

	private readonly grants = new Map<string, Grant>();
	private readonly sessions = new Map<string, Session>();
	private readonly refreshes = new Map<string, string>();
	private counter = 0;
	private server: Server | null = null;

	private constructor(private readonly options: StandinOptions) {
		this.redirectUri = "";
	}

	static async start(options: StandinOptions = {}): Promise<LinearStandin> {
		const standin = new LinearStandin(options);
		standin.server = createServer((request, response) => void standin.route(request, response));
		await new Promise<void>(resolve => standin.server!.listen(0, "127.0.0.1", resolve));
		(standin as { redirectUri: string }).redirectUri = `http://localhost:${standin.port}/linear/callback`;
		return standin;
	}

	get port(): number {
		return (this.server!.address() as AddressInfo).port;
	}

	/** Both Linear's address and its API's. */
	get url(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	async close(): Promise<void> {
		this.server?.closeAllConnections();
		await new Promise<void>(resolve => this.server?.close(() => resolve()));
	}

	// ---- the workspace -----------------------------------------------------------------------

	addTeam(key: string, name = key): StandinTeam {
		const team = { id: UUID_HEX(), key, name };
		this.teams.push(team);
		this.workflowStates.set(team.id, [
			{ id: UUID_HEX(), type: "started", name: "In Review", position: 4 },
			{ id: UUID_HEX(), type: "started", name: "Building", position: 1 },
			{ id: UUID_HEX(), type: "completed", name: "Shipped", position: 0 },
		]);
		return team;
	}

	label(name: string): StandinLabel {
		for (const label of this.labels.values()) if (label.name === name) return label;
		const label = { id: UUID_HEX(), name };
		this.labels.set(label.id, label);
		return label;
	}

	// ---- issues, and the deliveries Linear makes of them -------------------------------------

	private person(id: string | null): StandinPerson | null {
		return [this.appUser, this.human, this.stranger].find(person => person.id === id) ?? null;
	}

	private data(issue: StandinIssue): Record<string, unknown> {
		const team = this.teams.find(entry => entry.id === issue.teamId)!;
		return {
			id: issue.id,
			identifier: issue.identifier,
			number: issue.number,
			title: issue.title,
			description: issue.description,
			teamId: issue.teamId,
			team: { id: team.id, key: team.key, name: team.name },
			creatorId: issue.creatorId,
			assigneeId: issue.assigneeId,
			assignee: issue.assigneeId ? { id: issue.assigneeId, name: this.person(issue.assigneeId)?.name } : undefined,
			labelIds: [...issue.labelIds],
			labels: issue.labelIds.map(id => ({ id, name: this.labels.get(id)!.name, color: "#888888" })),
			url: this.issueUrl(issue),
			updatedAt: new Date().toISOString(),
		};
	}

	issueUrl(issue: StandinIssue): string {
		return `${this.url}/${this.workspace.urlKey}/issue/${issue.identifier}/title`;
	}

	private envelope(
		action: "create" | "update" | "remove",
		issue: StandinIssue,
		actor: StandinPerson,
		updatedFrom?: Record<string, unknown>,
	): Record<string, unknown> {
		return {
			action,
			type: "Issue",
			actor: { id: actor.id, name: actor.name, type: actor.app ? "application" : "user" },
			createdAt: new Date().toISOString(),
			data: this.data(issue),
			url: this.issueUrl(issue),
			...(updatedFrom ? { updatedFrom } : {}),
			organizationId: this.workspace.id,
			webhookTimestamp: Date.now(),
			webhookId: UUID_HEX(),
		};
	}

	createIssue(input: {
		team: StandinTeam;
		title?: string;
		description?: string;
		labels?: string[];
		assignee?: StandinPerson | null;
		creator?: StandinPerson;
		actor?: StandinPerson;
	}): { issue: StandinIssue; payload: Record<string, unknown> } {
		this.counter += 1;
		const issue: StandinIssue = {
			id: UUID_HEX(),
			identifier: `${input.team.key}-${this.counter}`,
			number: this.counter,
			title: input.title ?? `Issue ${this.counter}`,
			description: input.description ?? "",
			teamId: input.team.id,
			creatorId: (input.creator ?? this.human).id,
			assigneeId: input.assignee?.id ?? null,
			labelIds: (input.labels ?? []).map(name => this.label(name).id),
			stateType: "unstarted",
			archived: false,
		};
		this.issues.set(issue.id, issue);
		return { issue, payload: this.envelope("create", issue, input.actor ?? input.creator ?? this.human) };
	}

	/** Changes an issue and answers the `update` delivery Linear would make: `updatedFrom` holds the previous value of what changed. */
	updateIssue(
		issue: StandinIssue,
		patch: {
			title?: string;
			description?: string;
			assignee?: StandinPerson | null;
			addLabels?: string[];
			removeLabels?: string[];
			team?: StandinTeam;
			stateType?: string;
		},
		actor: StandinPerson = this.human,
	): Record<string, unknown> {
		const before: Record<string, unknown> = { updatedAt: new Date(Date.now() - 1000).toISOString() };
		if (patch.title !== undefined && patch.title !== issue.title) {
			before.title = issue.title;
			issue.title = patch.title;
		}
		if (patch.description !== undefined && patch.description !== issue.description) {
			before.description = issue.description;
			issue.description = patch.description;
		}
		if (patch.assignee !== undefined && (patch.assignee?.id ?? null) !== issue.assigneeId) {
			before.assigneeId = issue.assigneeId;
			issue.assigneeId = patch.assignee?.id ?? null;
		}
		if (patch.addLabels || patch.removeLabels) {
			const next = new Set(issue.labelIds);
			for (const name of patch.addLabels ?? []) next.add(this.label(name).id);
			for (const name of patch.removeLabels ?? []) next.delete(this.label(name).id);
			if (next.size !== issue.labelIds.length || [...next].some(id => !issue.labelIds.includes(id))) {
				before.labelIds = [...issue.labelIds];
				issue.labelIds = [...next];
			}
		}
		if (patch.team && patch.team.id !== issue.teamId) {
			before.teamId = issue.teamId;
			issue.teamId = patch.team.id;
			delete issue.stateId;
		}
		if (patch.stateType !== undefined && patch.stateType !== issue.stateType) {
			before.stateId = randomUUID();
			issue.stateType = patch.stateType;
			delete issue.stateId;
		}
		return this.envelope("update", issue, actor, before);
	}

	removeIssue(issue: StandinIssue, actor: StandinPerson = this.human): Record<string, unknown> {
		this.issues.delete(issue.id);
		return this.envelope("remove", issue, actor);
	}

	/** POSTs a delivery to the platform as Linear does. `payload` may be a body (bytes) of its own. */
	async deliver(
		target: string,
		payload: Record<string, unknown> | string,
		options: DeliveryOptions = {},
	): Promise<{ status: number; body: string; deliveryId: string; bytes: Buffer }> {
		const body =
			typeof payload === "string"
				? payload
				: { ...payload, ...(options.timestamp === undefined ? {} : { webhookTimestamp: options.timestamp }) };
		const signed = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
		const deliveryId = options.deliveryId ?? randomUUID();
		const headers: Record<string, string> = {
			"content-type": "application/json; charset=utf-8",
			"linear-delivery": deliveryId,
			"linear-event": options.event ?? "Issue",
			"linear-signature":
				options.signature ??
				createHmac("sha256", options.secret ?? this.signingSecret)
					.update(signed)
					.digest("hex"),
			"user-agent": "Linear-Webhook",
		};
		for (const name of options.omit ?? []) delete headers[name];
		const sent = options.bytes ? Buffer.from(options.bytes) : signed;
		const response = await fetch(target, {
			method: options.method ?? "POST",
			headers,
			body: options.method === "GET" ? undefined : sent,
		});
		const answer = await response.text();
		this.deliveries.push({ deliveryId, status: response.status, body: answer });
		return { status: response.status, body: answer, deliveryId, bytes: sent };
	}

	// ---- OAuth -------------------------------------------------------------------------------

	/**
	 * The owner's click: what the browser does at the address the platform sent it to, and the address
	 * Linear sends it back to (`redirect_uri` with `code` and `state`, or `error`).
	 */
	async authorize(authorizeUrl: string): Promise<string> {
		const response = await fetch(authorizeUrl, { redirect: "manual" });
		const location = response.headers.get("location");
		if (!location) throw new Error(`the stand-in's consent page answered ${response.status}: ${await response.text()}`);
		return location;
	}

	/** Makes the access token of a session expire, as a day passing does. */
	expire(accessToken: string): void {
		const session = this.sessions.get(accessToken);
		if (session) session.expiresAt = Date.now() - 1;
	}

	/** Revokes the access token and its refresh token, as an uninstall does. */
	revoke(accessToken: string): void {
		const session = this.sessions.get(accessToken);
		if (session) this.refreshes.delete(session.refresh);
		this.sessions.delete(accessToken);
	}

	private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", this.url);
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		const raw = Buffer.concat(chunks).toString("utf8");
		const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
			response.writeHead(status, { "content-type": "application/json", ...headers });
			response.end(JSON.stringify(body));
		};
		try {
			if (request.method === "GET" && url.pathname === "/oauth/authorize") return this.consentPage(url, response);
			if (request.method === "POST" && url.pathname === "/oauth/token") return this.tokenEndpoint(raw, request, send);
			if (request.method === "POST" && url.pathname === "/oauth/revoke") {
				this.calls.push("POST /oauth/revoke");
				const token = new URLSearchParams(raw).get("token");
				if (!token || !this.sessions.has(token)) return send(400, { error: "invalid_token" });
				this.revoke(token);
				return send(200, {});
			}
			if (request.method === "POST" && url.pathname === "/graphql") return this.graphql(raw, request, send);
			send(404, { error: "not_found" });
		} catch (error) {
			send(500, { error: error instanceof Error ? error.message : "failed" });
		}
	}

	private consentPage(url: URL, response: ServerResponse): void {
		const q = url.searchParams;
		const bad = (message: string) => {
			response.writeHead(400, { "content-type": "text/plain" });
			response.end(message);
		};
		if (q.get("client_id") !== this.clientId) return bad("unknown client");
		const redirectUri = q.get("redirect_uri") ?? "";
		if (redirectUri !== this.redirectUri) return bad("redirect_uri is not registered");
		if (q.get("response_type") !== "code") return bad("response_type must be code");
		const state = q.get("state") ?? "";
		const back = new URL(redirectUri);
		if (state) back.searchParams.set("state", state);
		if (!this.consent.approve) back.searchParams.set("error", "access_denied");
		else {
			const asked = (q.get("scope") ?? "").split(/[ ,]+/).filter(Boolean);
			const code = "code-" + randomBytes(12).toString("hex");
			const actor = this.consent.actor ?? (q.get("actor") === "app" ? "app" : "user");
			const challenge = q.get("code_challenge");
			if (challenge && q.get("code_challenge_method") !== "S256") return bad("only S256");
			this.grants.set(code, {
				clientId: this.clientId,
				redirectUri,
				challenge,
				scopes: this.options.grantScopes ? this.options.grantScopes(asked) : asked,
				actor,
				person: this.consent.person,
				used: false,
			});
			back.searchParams.set("code", code);
		}
		response.writeHead(302, { location: back.toString() });
		response.end();
	}

	private tokenEndpoint(raw: string, request: IncomingMessage, send: (status: number, body: unknown) => void): void {
		this.calls.push("POST /oauth/token");
		if (!String(request.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded"))
			return send(400, { error: "invalid_request" });
		const form = new URLSearchParams(raw);
		if (form.get("client_id") !== this.clientId || form.get("client_secret") !== this.clientSecret)
			return send(401, { error: "invalid_client", error_description: "client credentials are not valid" });
		let actor: "app" | "user", scopes: string[], person: StandinPerson | undefined;
		if (form.get("grant_type") === "authorization_code") {
			const grant = this.grants.get(form.get("code") ?? "");
			if (!grant || grant.used)
				return send(400, { error: "invalid_grant", error_description: "the code is not valid" });
			grant.used = true;
			if (form.get("redirect_uri") !== grant.redirectUri)
				return send(400, { error: "invalid_grant", error_description: "redirect_uri does not match" });
			if (
				grant.challenge &&
				createHash("sha256")
					.update(form.get("code_verifier") ?? "")
					.digest("base64url") !== grant.challenge
			)
				return send(400, { error: "invalid_grant", error_description: "code_verifier does not match" });
			({ actor, scopes, person } = grant);
		} else if (form.get("grant_type") === "refresh_token") {
			const old = this.refreshes.get(form.get("refresh_token") ?? "");
			const session = old ? this.sessions.get(old) : undefined;
			if (!old || !session)
				return send(400, { error: "invalid_grant", error_description: "the refresh token is not valid" });
			this.refreshes.delete(session.refresh);
			this.sessions.delete(old);
			({ actor, scopes, person } = session);
		} else return send(400, { error: "unsupported_grant_type" });
		const accessToken = "lin_oauth_" + randomBytes(20).toString("hex");
		const refresh = "lin_refresh_" + randomBytes(20).toString("hex");
		this.sessions.set(accessToken, { actor, person, expiresAt: Date.now() + 86_399_000, refresh, scopes });
		this.refreshes.set(refresh, accessToken);
		send(200, {
			access_token: accessToken,
			token_type: "Bearer",
			expires_in: 86_399,
			scope: scopes.join(","),
			refresh_token: refresh,
		});
	}

	private graphql(
		raw: string,
		request: IncomingMessage,
		send: (status: number, body: unknown, headers?: Record<string, string>) => void,
	): void {
		const bearer = /^Bearer (.+)$/.exec(String(request.headers.authorization ?? ""))?.[1] ?? "";
		const session = this.sessions.get(bearer);
		let parsed: { query?: string; variables?: Record<string, unknown> };
		try {
			parsed = JSON.parse(raw);
		} catch {
			return send(400, { errors: [{ message: "invalid JSON" }] });
		}
		const query = String(parsed.query ?? "");
		this.calls.push(
			`POST /graphql ${/^\s*mutation\b/.test(query) ? "mutation" : /\bviewer\b/.test(query) ? "viewer" : /\bteams\s*\(/.test(query) ? "teams" : /\bissue\s*\(/.test(query) ? "issue" : /\bcomment\(/.test(query) ? "comment" : "other"}`,
		);
		if (!session || session.expiresAt <= Date.now())
			return send(401, {
				errors: [
					{ message: "Authentication required, not authenticated", extensions: { type: "AuthenticationError" } },
				],
			});
		if (this.graphqlFailure === "RATELIMITED")
			return send(
				400,
				{ errors: [{ message: "private rate limit details", extensions: { type: "usage", code: "RATELIMITED" } }] },
				{ "retry-after": "30" },
			);
		if (this.graphqlFailure)
			return send(this.graphqlFailure, { errors: [{ message: "private Linear outage details" }] });
		const variables = parsed.variables ?? {};
		if (/^\s*mutation\b/.test(query)) {
			const operation = /\b(commentCreate|attachmentCreate|issueUpdate)\(/.exec(query)?.[1] ?? "unknown";
			this.writes.push(operation);
			const refuse = (message: string) => send(200, { errors: [{ message }] });
			if (!session.scopes.includes("write")) return refuse("Missing write scope");
			const input = variables.input as { id: string; issueId: string; body: string; url: string } | undefined;
			const issue = this.issues.get(input?.issueId ?? String(variables.id));
			if (!issue) return refuse("Issue not found");
			if (operation === "commentCreate" && input?.body && input.id) {
				if (this.comments.has(input.id)) return refuse("Comment ID already exists");
				this.comments.set(input.id, { issueId: issue.id, body: input.body });
			} else if (operation === "attachmentCreate" && input?.url) {
				this.attachments.set(issue.id, input.url);
			} else if (operation === "issueUpdate" && !this.denyStateChange && variables.stateId) {
				const state = this.workflowStates.get(issue.teamId)?.find(s => s.id === variables.stateId);
				if (!state) return refuse("Unknown state");
				issue.stateType = state.type;
				issue.stateId = state.id;
			} else return refuse("Mutation declined");
			return send(200, { data: { [operation]: { success: true } } });
		}
		if (/\bcomment\(/.test(query)) {
			this.commentReads.push(String(variables.id));
			const comment = this.comments.get(String(variables.id));
			return send(200, { data: { comment: comment ? { issue: { id: comment.issueId } } : null } });
		}
		if (/\bviewer\b/.test(query)) {
			const viewer = session.actor === "app" ? this.appUser : (session.person ?? this.human);
			return send(200, {
				data: { viewer: { id: viewer.id, name: viewer.name, app: viewer.app }, organization: this.workspace },
			});
		}
		if (/\bteams\s*\(/.test(query)) {
			const size = Math.min(Number(this.options.pageSize ?? 100), 100);
			const start = variables.after ? Number(String(variables.after).replace("cursor-", "")) : 0;
			const nodes = this.teams.slice(start, start + size);
			const end = start + nodes.length;
			return send(200, {
				data: {
					teams: {
						nodes,
						pageInfo: {
							hasNextPage: end < this.teams.length,
							endCursor: end < this.teams.length ? `cursor-${end}` : null,
						},
					},
				},
			});
		}
		if (/\bissue\s*\(/.test(query)) {
			const issue = this.issues.get(String(variables.id));
			if (!issue)
				return send(200, {
					data: null,
					errors: [
						{
							message: "Entity not found: Issue - Could not find referenced Issue.",
							extensions: { type: "invalid input" },
						},
					],
				});
			const team = this.teams.find(entry => entry.id === issue.teamId)!;
			const creator = this.person(issue.creatorId),
				assignee = this.person(issue.assigneeId);
			const workflow = this.workflowStates.get(team.id)!;
			const filter = variables.filter as { type: { eq: string }; name?: { eq: string } } | undefined;
			const matches = workflow.filter(s => s.type === filter?.type.eq && (!filter.name || s.name === filter.name.eq));
			const start = Number(variables.after ?? 0);
			const end = start + Math.min(Number(variables.first ?? 50), this.options.pageSize ?? 100);
			return send(200, {
				data: {
					issue: {
						id: issue.id,
						identifier: issue.identifier,
						title: issue.title,
						description: issue.description,
						url: this.issueUrl(issue),
						archivedAt: issue.archived ? new Date().toISOString() : null,
						trashed: false,
						team: {
							id: team.id,
							...(filter && {
								states: {
									nodes: matches.slice(start, end),
									pageInfo: { hasNextPage: end < matches.length, endCursor: String(end) },
								},
							}),
						},
						creator: creator ? { id: creator.id, name: creator.name } : null,
						assignee: assignee ? { id: assignee.id } : null,
						labels: { nodes: issue.labelIds.map(id => ({ id, name: this.labels.get(id)!.name })) },
						state: { ...workflow.find(s => s.id === issue.stateId), type: issue.stateType },
					},
				},
			});
		}
		send(200, { errors: [{ message: "unknown query", extensions: { type: "invalid input" } }] });
	}
}
