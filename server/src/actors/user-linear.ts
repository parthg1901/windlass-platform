/**
 * The owner's side of the Linear integration, inside the user's actor: the workspace the owner connected, the teams mapped to
 * repositories, and what one verified delivery comes to. The routes (linear/connect.ts, linear/webhook.ts) reach it through
 * service actions.
 *
 *   linear_connection  one row: the workspace, its app user, the teams Linear listed when it was read, and the OAuth token, sealed
 *                      for this user and this workspace (signin/seal.ts) like a repository's secret. The token is in no answer
 *                      and no log.
 *   linear_mapping     one row per mapped team: the repository of the owner's GitHub connection it files to. The only copy of
 *                      the mapping: filing reads it again, so a removed mapping or a team that left the workspace files nothing.
 *   linear_state       the connections that were begun, each good once and bound to the web origin that began it.
 *   linear_delivery    the deliveries that were taken in, for redelivery.
 *
 * Which user a delivery goes to is `linearWorkspace`'s claim of the team, made when a mapping is saved and given up when it ends.
 *
 * An app token cannot say which person authorized it (linear/app.ts), so no Linear person is the owner's own: every issue is filed
 * as third-party text (a draft, quoted), as GitHub's issues of other people are.
 */

import { UserError } from "rivetkit";
import type { RawAccess } from "rivetkit/db";
import { clientError, serviceParams } from "../auth.js";
import { config, linearConfig, ownEngineEndpoint } from "../config.js";
import type { GithubId, LinearMapping, LinearStatus, LinearTeam, LinearTeamList } from "../contract.js";
import type { TrackerFiled, LinearFiling } from "../factory/intake.js";
import { githubApp } from "../github/app.js";
import { githubId, isGithubId } from "../github/ids.js";
import { GithubProblem, resolveRepository, type StoredConnection } from "../github/repos.js";
import {
	LinearError,
	isLinearId,
	linearApp,
	newVerifier,
	challengeOf,
	redactLinear,
	type LinearApp,
	type LinearToken,
	type LinearWrite,
	type LinearTeam as ProtocolTeam,
} from "../linear/app.js";
import { type LinearClaim, type LinearConnectStore, openLinearTicket } from "../linear/connect.js";
import { isTriggerLabel, type LinearDelivery, type LinearDispatch } from "../linear/webhook.js";
import { openSecret, sealSecret } from "../repo-secrets.js";
import { readSignedPayload, signedPayload } from "../signatures.js";
import { serverSealer } from "../signin/seal.js";
import { createClient } from "rivetkit/client";
import { isActorGone, type ActorClient } from "./internal.js";
import type { ItemsState } from "./user-items.js";

export const LINEAR_TABLES = [
	`CREATE TABLE IF NOT EXISTS linear_connection (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		workspace TEXT NOT NULL,
		app_user TEXT NOT NULL,
		teams TEXT NOT NULL,
		sealed TEXT NOT NULL,
		connected_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS linear_mapping (
		team_id TEXT PRIMARY KEY,
		repository_id TEXT NOT NULL,
		owner TEXT NOT NULL,
		name TEXT NOT NULL,
		saved_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS linear_state (
		nonce TEXT PRIMARY KEY,
		verifier TEXT NOT NULL,
		origin TEXT NOT NULL,
		expires_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS linear_delivery (
		id TEXT PRIMARY KEY,
		received_at INTEGER NOT NULL,
		decision TEXT NOT NULL
	)`,
];

export const LINEAR_STATE_TTL_MS = 10 * 60_000;
const TICKET_TTL_MS = 5 * 60_000;
/** How many connections may be begun and left unfinished. */
const MAX_PENDING = 20;
/** How long a delivery id is remembered: Linear redelivers within hours. */
const DELIVERIES_KEPT_MS = 7 * 86_400_000;
/** A token this close to its end is refreshed before it is used. */
const REFRESH_MARGIN_MS = 60_000;
/** What no Linear person's id can be: nobody is the owner's own author (see the top of this file). */
const NOBODY = "unknown";
const PROJECT = (workspaceId: string) => `linear:${workspaceId}`;
const TOKEN_NAME = "oauth-token";

export interface LinearCtx {
	key: string[];
	db: RawAccess;
	vars: {
		items: Pick<ItemsState, "created" | "items">;
		github: StoredConnection | null;
		linearWriteRetryAt?: number;
		claimingTeams?: Set<{ workspaceId: string; teamId: string }>;
	};
	client(): ActorClient;
	log: { error(entry: unknown): void; warn(entry: unknown): void };
}

// ---------------------------------------------------------------------------------------------
// The signed state
// ---------------------------------------------------------------------------------------------

const STATE_PREFIX = "ln1";

interface StatePayload {
	k: "linear-state";
	uid: string;
	nonce: string;
	origin: string;
	exp: number;
}

/**
 * A state is signed under the key of GitHub's states with its own prefix, which the MAC covers: a GitHub state is not a Linear one,
 * nor the reverse. Used once: the user's actor issued its number and takes it out when it is claimed.
 */
function issueState(uid: string, nonce: string, origin: string, now = Date.now()): string {
	const payload: StatePayload = { k: "linear-state", uid, nonce, origin, exp: now + LINEAR_STATE_TTL_MS };
	return signedPayload(STATE_PREFIX, "github-state", payload);
}

function readState(token: unknown): StatePayload | null {
	const fields = readSignedPayload(token, STATE_PREFIX, 8192, kind =>
		kind === "linear-state" ? "github-state" : null,
	);
	if (!fields) return null;
	const { uid, nonce, origin, exp } = fields;
	if (
		typeof uid !== "string" ||
		uid === "" ||
		typeof nonce !== "string" ||
		nonce === "" ||
		typeof origin !== "string" ||
		typeof exp !== "number"
	)
		return null;
	return { k: "linear-state", uid, nonce, origin, exp };
}

// ---------------------------------------------------------------------------------------------
// What is stored
// ---------------------------------------------------------------------------------------------

interface Stored {
	workspace: { id: string; name: string; urlKey: string };
	appUser: { id: string; name: string };
	teams: ProtocolTeam[];
	sealed: string;
	connectedAt: number;
}

async function readConnection(db: RawAccess): Promise<Stored | null> {
	const [row] = await db.execute<{
		workspace: string;
		app_user: string;
		teams: string;
		sealed: string;
		connected_at: number;
	}>("SELECT workspace, app_user, teams, sealed, connected_at FROM linear_connection WHERE id = 1");
	return row
		? {
				workspace: JSON.parse(row.workspace),
				appUser: JSON.parse(row.app_user),
				teams: JSON.parse(row.teams),
				sealed: row.sealed,
				connectedAt: row.connected_at,
			}
		: null;
}

async function readMappings(db: RawAccess): Promise<LinearMapping[]> {
	const rows = await db.execute<{
		team_id: string;
		repository_id: string;
		owner: string;
		name: string;
		saved_at: number;
	}>("SELECT team_id, repository_id, owner, name, saved_at FROM linear_mapping ORDER BY team_id");
	// GitHub's ids are numbers where they are exact (github/ids.ts); the column is text, so they are read back through `githubId`.
	return rows.flatMap(r => {
		const id = githubId(r.repository_id);
		return id === null
			? []
			: [{ teamId: r.team_id, repository: { id, owner: r.owner, name: r.name }, savedAt: r.saved_at }];
	});
}

const lower = (id: string) => id.toLowerCase();

const queues = new WeakMap<object, Promise<unknown>>();

/** One change of the connection or its token at a time: Linear rotates a refresh token, so two refreshes must not race. */
function inLinearQueue<T>(c: LinearCtx, job: () => Promise<T>): Promise<T> {
	const next = (queues.get(c.vars) ?? Promise.resolve()).then(job);
	queues.set(
		c.vars,
		next.catch(() => undefined),
	);
	return next;
}

function requireLinear(): LinearApp {
	const app = linearApp();
	if (!app)
		throw new UserError("This deployment has no Linear app, so Linear cannot be connected here.", {
			code: "linear_off",
		});
	return app;
}

const notConnected = () =>
	new UserError("Linear is not connected. Connect a Linear workspace first.", { code: "linear_not_connected" });
const reconnect = () =>
	new UserError("Linear no longer accepts this connection. Connect Linear again.", { code: "linear_reconnect" });

function workspaceActor(c: LinearCtx, workspaceId: string) {
	return c.client().linearWorkspace.getOrCreate([workspaceId], { params: serviceParams() });
}

function releaseTeam(c: LinearCtx, workspaceId: string, teamId: string): Promise<void> {
	return workspaceActor(c, workspaceId).internalRelease({ teamId, uid: c.key[0] });
}

/** What the owner is told of a failure at Linear; anything else is logged and answered in general words. */
function linearFailure(c: LinearCtx, error: unknown, fallback: string): UserError {
	if (error instanceof UserError) return error;
	if (error instanceof LinearError) {
		if (error.unauthorized) return reconnect();
		if (error.unreachable)
			return new UserError("Linear could not be reached. Try again.", { code: "linear_unreachable" });
		if (error.rateLimited)
			return new UserError("Linear is limiting requests. Try again in a minute.", { code: "linear_unreachable" });
	}
	return clientError(c.log, error instanceof Error ? new Error(redactLinear(error.message)) : error, fallback);
}

// ---------------------------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------------------------

function sealToken(uid: string, workspaceId: string, token: LinearToken): string {
	return sealSecret(serverSealer(), uid, PROJECT(workspaceId), TOKEN_NAME, JSON.stringify(token));
}

function openToken(uid: string, stored: Stored): LinearToken {
	try {
		const token = JSON.parse(
			openSecret(serverSealer(), uid, PROJECT(stored.workspace.id), TOKEN_NAME, stored.sealed),
		) as LinearToken;
		if (typeof token.accessToken !== "string" || token.accessToken === "") throw new Error("no token");
		return token;
	} catch {
		throw new LinearError(
			401,
			"the saved connection cannot be opened",
			"use the saved Linear token",
			"AuthenticationError",
		);
	}
}

/**
 * The connection's access token, refreshed when it is about to end. A token Linear no longer honours, or one that has expired with
 * no refresh token, is a `LinearError` that is `unauthorized`: the owner connects again.
 */
async function tokenInQueue(c: LinearCtx, app: LinearApp): Promise<{ stored: Stored; token: string }> {
	const uid = c.key[0]!;
	const stored = await readConnection(c.db);
	if (!stored) throw notConnected();
	const token = openToken(uid, stored);
	if (token.expiresAt === null || token.expiresAt - REFRESH_MARGIN_MS > Date.now())
		return { stored, token: token.accessToken };
	if (!token.refreshToken)
		throw new LinearError(401, "the token has expired", "use the saved Linear token", "AuthenticationError");
	const renewed = await app.refresh(token.refreshToken);
	const sealed = sealToken(uid, stored.workspace.id, {
		...renewed,
		refreshToken: renewed.refreshToken ?? token.refreshToken,
	});
	// Written before it is used: the old refresh token is spent.
	await c.db.execute(
		"UPDATE linear_connection SET sealed = ? WHERE id = 1 AND connected_at = ?",
		sealed,
		stored.connectedAt,
	);
	return { stored: { ...stored, sealed }, token: renewed.accessToken };
}

function accessToken(c: LinearCtx, app: LinearApp) {
	return inLinearQueue(c, () => tokenInQueue(c, app));
}

export interface LinearItemWrite {
	workspaceId: string;
	teamId: string;
	issueId: string;
	itemId: string;
	write: LinearWrite;
}

export async function writeLinearItem(c: LinearCtx, input: LinearItemWrite): Promise<boolean> {
	// Serialize the read and mutation: the item's outbox can deliver start, review and merge concurrently.
	return inLinearQueue(c, async () => {
		if ((c.vars.linearWriteRetryAt ?? 0) > Date.now()) throw new Error("linear_rate_limited");
		try {
			const app = requireLinear();
			const { stored, token } = await tokenInQueue(c, app);
			if (stored.workspace.id !== input.workspaceId) throw notConnected();
			if (!(await c.db.execute("SELECT 1 FROM linear_mapping WHERE team_id=?", input.teamId)).length) return false;
			await app.writeIssue(token, input.issueId, input.teamId, input.itemId, input.write);
			return true;
		} catch (error) {
			if (error instanceof LinearError && error.rateLimited) {
				c.vars.linearWriteRetryAt = Math.max(Date.now() + 15_000, error.retryAt);
				throw new Error("linear_rate_limited");
			}
			if (error instanceof LinearError && error.unreachable) throw new Error("linear_unreachable");
			if (!(error instanceof LinearError || error instanceof UserError)) throw new Error("linear_write_failed");
			c.log.warn({
				msg: "Linear item update declined",
				item: input.itemId,
				event: input.write.key,
				status: error instanceof LinearError ? error.status : undefined,
			});
			return false;
		}
	});
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

function connectedStatus(stored: Stored): LinearStatus {
	// The app token cannot name the person who authorized it (linear/app.ts), so the connection is shown as the app user's.
	return {
		state: "connected",
		connection: {
			workspace: stored.workspace,
			user: stored.appUser,
			appUser: stored.appUser,
			connectedAt: stored.connectedAt,
		},
	};
}

export async function linearStatus(c: LinearCtx): Promise<LinearStatus> {
	if (!linearConfig().app) return { state: "off" };
	const stored = await readConnection(c.db);
	return stored ? connectedStatus(stored) : { state: "disconnected" };
}

/** Begins a connection for this user: the address at Linear to send the browser to. */
export async function beginLinearConnect(c: LinearCtx, input: { origin: string }): Promise<{ url: string }> {
	const app = requireLinear();
	const origin = typeof input?.origin === "string" ? input.origin.replace(/\/+$/, "") : "";
	// The browser is sent back there: only to the web app's own address.
	if (!config.origins.includes(origin))
		throw new UserError("Linear can only be connected from the web app's own address.", { code: "origin_not_allowed" });
	try {
		const verifier = newVerifier();
		const nonce = newVerifier();
		const now = Date.now();
		await c.db.execute("DELETE FROM linear_state WHERE expires_at <= ?", now);
		// Somebody who begins again and again leaves no more than a few behind; the oldest go first.
		await c.db.execute(
			"DELETE FROM linear_state WHERE nonce NOT IN (SELECT nonce FROM linear_state ORDER BY expires_at DESC LIMIT ?)",
			MAX_PENDING - 1,
		);
		await c.db.execute(
			"INSERT INTO linear_state (nonce, verifier, origin, expires_at) VALUES (?, ?, ?, ?)",
			nonce,
			verifier,
			origin,
			now + LINEAR_STATE_TTL_MS,
		);
		return { url: app.authorizeUrl(issueState(c.key[0]!, nonce, origin, now), challengeOf(verifier)) };
	} catch (error) {
		throw linearFailure(c, error, "Connecting Linear could not be started. Try again.");
	}
}

/** Takes a state's number out of the list: it is there once. Answers with the verifier and the origin that began it. */
export async function claimLinearState(
	c: LinearCtx,
	nonce: string,
): Promise<{ ok: boolean; verifier: string | null; origin: string | null }> {
	if (typeof nonce !== "string" || nonce === "") return { ok: false, verifier: null, origin: null };
	// A claimed state becomes a one-use ticket. Disconnect cancels both kinds of pending connection.
	const now = Date.now();
	const [row] = await c.db.execute<{ verifier: string; origin: string }>(
		"UPDATE linear_state SET nonce = ?, expires_at = ? WHERE nonce = ? AND expires_at > ? RETURNING verifier, origin",
		`ticket:${nonce}`,
		now + TICKET_TTL_MS,
		nonce,
		now,
	);
	return row ? { ok: true, verifier: row.verifier, origin: row.origin } : { ok: false, verifier: null, origin: null };
}

/**
 * Records the connection that Linear confirmed for the state this user began. Mappings of teams the workspace still has are kept;
 * the rest are dropped, and their claims given up first, so that a failure leaves a mapping nobody is routed to and not a claim
 * that blocks everyone else.
 */
export async function completeLinearConnection(c: LinearCtx, ticket: string): Promise<LinearStatus> {
	const app = requireLinear();
	const uid = c.key[0]!;
	const invalid = () =>
		new UserError("This link to connect Linear is not valid for this account any more. Connect Linear again.", {
			code: "linear_ticket",
		});
	let confirmed;
	try {
		confirmed = openLinearTicket(uid, ticket);
	} catch {
		throw invalid();
	}
	const { token, identity, nonce } = confirmed;
	const workspace = {
		id: lower(identity.workspace.id),
		name: identity.workspace.name,
		urlKey: identity.workspace.urlKey,
	};
	const appUser = { id: lower(identity.appUser.id), name: identity.appUser.name };
	await inLinearQueue(c, async () => {
		const claimed = await c.db.execute(
			"DELETE FROM linear_state WHERE nonce = ? AND expires_at > ? RETURNING nonce",
			`ticket:${nonce}`,
			Date.now(),
		);
		if (!claimed.length) throw invalid();
		// Team lists can exceed a redirect header, so read them after the ticket returns.
		const teams = await app.teams(token.accessToken).catch(error => {
			throw linearFailure(c, error, "The Linear teams could not be listed. Connect Linear again.");
		});
		const known = teams.map(team => ({ ...team, id: lower(team.id) }));
		const previous = await readConnection(c.db);
		const present = new Set(known.map(team => team.id));
		const sameWorkspace = previous?.workspace.id === workspace.id;
		const mappings = await readMappings(c.db);
		const kept = mappings.filter(mapping => sameWorkspace && present.has(mapping.teamId));
		for (const mapping of mappings)
			if (!kept.includes(mapping)) await releaseTeam(c, previous!.workspace.id, mapping.teamId);
		await c.db.transaction(async tx => {
			await tx.execute(
				"INSERT OR REPLACE INTO linear_connection (id, workspace, app_user, teams, sealed, connected_at) VALUES (1, ?, ?, ?, ?, ?)",
				JSON.stringify(workspace),
				JSON.stringify(appUser),
				JSON.stringify(known),
				sealToken(uid, workspace.id, token),
				Date.now(),
			);
			await tx.execute(
				"DELETE FROM linear_mapping WHERE team_id NOT IN (SELECT value FROM json_each(?))",
				JSON.stringify(kept.map(mapping => mapping.teamId)),
			);
		});
		console.log(
			`[wlp] linear.connected uid=${uid} workspace=${workspace.id} teams=${known.length} mapped=${kept.length}`,
		);
	});
	return linearStatus(c);
}

function teamList(teams: ProtocolTeam[], mappings: LinearMapping[]): LinearTeamList {
	const byTeam = new Map(mappings.map(mapping => [mapping.teamId, mapping]));
	return {
		teams: teams.map(
			(team): LinearTeam => ({ id: team.id, key: team.key, name: team.name, mapping: byTeam.get(team.id) ?? null }),
		),
	};
}

/**
 * The workspace's teams, read from Linear now, with the mapping of each. A mapping whose team left the workspace is dropped
 * here. When Linear cannot be reached the teams of the last read are shown.
 */
export async function linearTeams(c: LinearCtx, fresh = false): Promise<{ list: LinearTeamList; stored: Stored }> {
	const app = requireLinear();
	const { stored, token } = await accessToken(c, app).catch(error => {
		throw linearFailure(c, error, "The Linear teams could not be listed. Try again.");
	});
	let teams = stored.teams;
	try {
		teams = (await app.teams(token)).map(team => ({ id: lower(team.id), key: team.key, name: team.name }));
		await c.db.execute(
			"UPDATE linear_connection SET teams = ? WHERE id = 1 AND connected_at = ?",
			JSON.stringify(teams),
			stored.connectedAt,
		);
	} catch (error) {
		if (fresh || !(error instanceof LinearError && error.unreachable))
			throw linearFailure(c, error, "The Linear teams could not be listed. Try again.");
	}
	const present = new Set(teams.map(team => team.id));
	const mappings = await readMappings(c.db);
	const gone = mappings.filter(mapping => !present.has(mapping.teamId));
	for (const mapping of gone) await unmap(c, stored.workspace.id, mapping.teamId);
	return {
		list: teamList(
			teams,
			mappings.filter(mapping => present.has(mapping.teamId)),
		),
		stored,
	};
}

/** Gives the team's claim up, then removes the mapping: a mapping whose claim is gone is routed nothing, and is removed by the next call. */
async function unmap(c: LinearCtx, workspaceId: string, teamId: string): Promise<void> {
	await inLinearQueue(c, async () => {
		if ((await readConnection(c.db))?.workspace.id !== workspaceId) return;
		await releaseTeam(c, workspaceId, teamId);
		await c.db.execute("DELETE FROM linear_mapping WHERE team_id = ?", teamId);
	});
}

export async function linearHoldsTeam(c: LinearCtx, workspaceId: string, teamId: string): Promise<boolean> {
	const connection = await readConnection(c.db);
	if (connection?.workspace.id !== workspaceId) return false;
	// The directory can call back before a successful save has written its mapping.
	for (const claim of c.vars.claimingTeams ?? [])
		if (claim.workspaceId === workspaceId && claim.teamId === teamId) return true;
	if (!(await c.db.execute("SELECT 1 FROM linear_mapping WHERE team_id = ?", teamId)).length) return false;
	try {
		const app = requireLinear();
		const { stored, token } = await accessToken(c, app);
		return stored.workspace.id === workspaceId && lower((await app.identity(token)).workspace.id) === workspaceId;
	} catch (error) {
		if (
			(error instanceof LinearError && (error.unauthorized || error.code === "invalid_grant")) ||
			(error instanceof UserError && error.code === "linear_not_connected")
		)
			return false;
		throw error;
	}
}

export async function saveLinearMapping(
	c: LinearCtx,
	input: { teamId: string; repositoryId: GithubId },
): Promise<LinearTeamList> {
	requireLinear();
	const teamId = typeof input?.teamId === "string" ? lower(input.teamId) : "";
	if (!isLinearId(teamId) || !isGithubId(input?.repositoryId))
		throw new UserError("Choose one of the listed teams and one of the listed repositories.", { code: "bad_input" });
	const connection = c.vars.github;
	if (!(await readConnection(c.db))) throw notConnected();
	if (!connection)
		throw new UserError("GitHub is not connected. Connect GitHub first.", { code: "github_not_connected" });
	const app = githubApp();
	if (!app)
		throw new UserError("This deployment has no GitHub App, so GitHub cannot be connected here.", {
			code: "github_off",
		});
	// Linear is asked now: a team that is not in the connected workspace cannot be mapped, whatever a client says.
	const { list, stored } = await linearTeams(c, true);
	if (!list.teams.some(team => team.id === teamId))
		throw new UserError("That team is not in the connected Linear workspace.", { code: "linear_team" });
	let repository;
	try {
		// The owner must be able to push to it now; filing asks again.
		repository = (await resolveRepository(app, connection, input.repositoryId, "write")).described;
	} catch (error) {
		if (error instanceof GithubProblem)
			throw new UserError(error.message, {
				code: error.code === "github_gone" || error.code === "github_denied" ? "bad_input" : error.code,
			});
		throw clientError(c.log, error, "The repository could not be checked at GitHub. Try again.");
	}
	// The team is this user's alone while it is mapped.
	const pending = (c.vars.claimingTeams ??= new Set());
	const claim = { workspaceId: stored.workspace.id, teamId };
	pending.add(claim);
	try {
		const claimed = await workspaceActor(c, stored.workspace.id).internalClaim({ teamId, uid: c.key[0] });
		if (!claimed)
			throw new UserError("Another Windlass user has already mapped that team.", { code: "linear_team_taken" });
		await inLinearQueue(c, async () => {
			if ((await readConnection(c.db))?.connectedAt !== stored.connectedAt) throw notConnected();
			await c.db.execute(
				"INSERT INTO linear_mapping (team_id, repository_id, owner, name, saved_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (team_id) DO UPDATE SET repository_id = excluded.repository_id, owner = excluded.owner, name = excluded.name, saved_at = excluded.saved_at",
				teamId,
				String(repository.id),
				repository.owner,
				repository.name,
				Date.now(),
			);
		});
	} catch (error) {
		if (error instanceof UserError) throw error;
		throw clientError(c.log, error, "The mapping could not be saved. Try again.");
	} finally {
		pending.delete(claim);
	}
	console.log(`[wlp] linear.mapping.saved uid=${c.key[0]} team=${teamId} repository=${repository.id}`);
	return teamList(
		list.teams.map(({ id, key, name }) => ({ id, key, name })),
		await readMappings(c.db),
	);
}

export async function removeLinearMapping(c: LinearCtx, teamId: string): Promise<LinearTeamList> {
	requireLinear();
	const stored = await readConnection(c.db);
	if (!stored) throw notConnected();
	const id = typeof teamId === "string" ? lower(teamId) : "";
	if (!isLinearId(id)) throw new UserError("Choose one of the listed teams.", { code: "bad_input" });
	await unmap(c, stored.workspace.id, id);
	console.log(`[wlp] linear.mapping.removed uid=${c.key[0]} team=${id}`);
	return teamList(stored.teams, await readMappings(c.db));
}

/** Forgets the connection: every team's claim is given up first, then the token and the mappings go. Items already filed stay. */
export async function disconnectLinear(c: LinearCtx): Promise<LinearStatus> {
	await inLinearQueue(c, async () => {
		const stored = await readConnection(c.db);
		if (stored) {
			for (const mapping of await readMappings(c.db)) await releaseTeam(c, stored.workspace.id, mapping.teamId);
			try {
				await requireLinear().revoke(openToken(c.key[0]!, stored).accessToken);
			} catch (error) {
				c.log.warn({
					msg: "Could not revoke the Linear token",
					workspace: stored.workspace.id,
					status: error instanceof LinearError ? error.status : undefined,
				});
			}
		}
		await c.db.transaction(async tx => {
			await tx.execute("DELETE FROM linear_mapping");
			await tx.execute("DELETE FROM linear_connection");
			await tx.execute("DELETE FROM linear_state");
			await tx.execute("DELETE FROM linear_delivery");
		});
		if (stored) console.log(`[wlp] linear.disconnected uid=${c.key[0]} workspace=${stored.workspace.id}`);
	});
	return linearStatus(c);
}

// ---------------------------------------------------------------------------------------------
// One verified delivery
// ---------------------------------------------------------------------------------------------

/** A link to the issue: Linear's own when it is https, otherwise the one Linear's addresses have. */
function issueUrl(reported: string, urlKey: string, identifier: string): string {
	if (/^https:\/\/[^\s/]+\/\S*$/.test(reported) && reported.length <= 500) return reported;
	return `https://linear.app/${encodeURIComponent(urlKey || "issue")}/issue/${identifier}`;
}

/**
 * What one verified delivery comes to for the owner. The delivery names the issue and what changed; the issue itself is read from
 * Linear now with the connection's token, and the connection and the mapping are read from here: the route's claim is only where
 * the delivery was sent. Nothing is filed unless the workspace is still this connection's, the team still mapped, and what
 * qualified the issue still holds (an interrupted filing is finished anyway, in `fileTrackerIssue`).
 *
 * Answers `duplicate` for a delivery id that was already decided. Throws when it must be redelivered: Linear or GitHub
 * unreachable. Final decisions are kept so a redelivery after a lost reply finds them. A daily-cap refusal leaves the delivery open. A filing
 * the lost reply hid is not filed twice either way: the issue's active item has one key.
 */
export async function fileLinearDelivery(
	c: LinearCtx,
	delivery: LinearDelivery,
	file: (filing: LinearFiling) => Promise<TrackerFiled>,
): Promise<LinearDispatch> {
	const app = linearApp();
	const stored = await readConnection(c.db);
	if (!app || !stored || stored.workspace.id !== lower(delivery.workspaceId)) return "ignored";
	const reasons: Array<"label" | "assignment"> = [];
	if (delivery.assignedTo !== null && lower(delivery.assignedTo) === stored.appUser.id) reasons.push("assignment");
	if (delivery.label) reasons.push("label");
	const teamId = lower(delivery.teamId);
	const [mapping] = await c.db.execute<{ repository_id: string }>(
		"SELECT repository_id FROM linear_mapping WHERE team_id = ?",
		teamId,
	);
	const repositoryId = mapping && githubId(mapping.repository_id);
	if (reasons.length === 0 || !repositoryId) return "ignored";

	await c.db.execute("DELETE FROM linear_delivery WHERE received_at <= ?", Date.now() - DELIVERIES_KEPT_MS);
	const id = lower(delivery.deliveryId);
	if ((await c.db.execute("SELECT 1 FROM linear_delivery WHERE id = ?", id)).length > 0) return "duplicate";

	const result = await decide(c, app, stored, delivery, reasons, teamId, repositoryId, file);
	const decision = summary(result);
	if (result.kind !== "refused" || !result.dailyCap)
		await c.db.execute(
			"INSERT OR IGNORE INTO linear_delivery VALUES (?, ?, ?)",
			id,
			Date.now(),
			JSON.stringify(decision),
		);
	console.log(
		`linear.delivery.${decision.kind} workspace=${stored.workspace.id} delivery=${id}${decision.itemId ? ` item=${decision.itemId}` : ` (${decision.why})`}`,
	);
	return "taken";
}

/** What is kept and logged of a decision: its kind and its item or reason, nothing of the issue's text. */
function summary(result: TrackerFiled): { kind: string; itemId?: string; why?: string } {
	if (result.kind === "filed" || result.kind === "exists") return { kind: result.kind, itemId: result.itemId };
	return { kind: result.kind, why: result.kind === "ignored" ? result.why : result.reason };
}

async function decide(
	c: LinearCtx,
	app: LinearApp,
	stored: Stored,
	delivery: LinearDelivery,
	reasons: Array<"label" | "assignment">,
	teamId: string,
	repositoryId: GithubId,
	file: (filing: LinearFiling) => Promise<TrackerFiled>,
): Promise<TrackerFiled> {
	let issue;
	try {
		const { token } = await accessToken(c, app);
		issue = await app.issue(token, delivery.issueId);
	} catch (error) {
		if (error instanceof LinearError && error.unauthorized)
			return { kind: "refused", reason: "Linear no longer accepts the connection; the owner has to connect it again." };
		throw error;
	}
	if (!issue || lower(issue.id) !== lower(delivery.issueId))
		return { kind: "ignored", why: "Linear has no such issue." };
	if (lower(issue.teamId) !== teamId) return { kind: "ignored", why: "The issue is not in the mapped team." };

	const holds = {
		label: issue.labels.some(label => isTriggerLabel(label.name)),
		assignment: issue.assigneeId !== null && lower(issue.assigneeId) === stored.appUser.id,
	};
	const via = reasons.find(reason => holds[reason]);
	return file({
		issue: {
			id: lower(issue.id),
			identifier: issue.identifier,
			url: issueUrl(issue.url, stored.workspace.urlKey, issue.identifier),
			title: issue.title,
			description: issue.description,
			labels: issue.labels.map(label => label.name),
			creator: issue.creator && { id: lower(issue.creator.id), name: issue.creator.name },
			closed: issue.archived || issue.stateType === "completed" || issue.stateType === "canceled",
		},
		team: { id: teamId, workspaceId: stored.workspace.id },
		repository: { id: repositoryId },
		owner: { linearUserId: NOBODY },
		trigger: {
			via: via ?? reasons[0]!,
			at: delivery.sentAt,
			sender: { id: delivery.actorId ?? NOBODY, name: "a Linear user" },
			...(via ? {} : { lapsed: true as const }),
		},
	});
}

// ---------------------------------------------------------------------------------------------
// What the routes need of the actors
// ---------------------------------------------------------------------------------------------

interface UserLinearActions {
	internalLinearClaim(nonce: string): Promise<{ ok: boolean; verifier: string | null; origin: string | null }>;
	internalLinearDelivery(delivery: LinearDelivery): Promise<LinearDispatch>;
}

let client: {
	user: { get(key: string[], options: { params: unknown }): unknown };
	linearWorkspace: { get(key: string[], options: { params: unknown }): unknown };
} | null = null;

function actors() {
	client ??= createClient({ endpoint: ownEngineEndpoint() }) as unknown as NonNullable<typeof client>;
	const options = { params: serviceParams() };
	return {
		user: (uid: string) => client!.user.get([uid], options) as UserLinearActions,
		owner: (workspaceId: string) =>
			client!.linearWorkspace.get([workspaceId], options) as { internalOwner(teamId: string): Promise<string | null> },
	};
}

/** `POST /linear/webhook`'s hand-over: the team's claimant, if there is one, files the delivery or says it already has. */
export async function dispatchLinearDelivery(delivery: LinearDelivery): Promise<LinearDispatch> {
	const { user, owner } = actors();
	try {
		const uid = await owner(delivery.workspaceId).internalOwner(delivery.teamId);
		return uid === null ? "ignored" : await user(uid).internalLinearDelivery(delivery);
	} catch (error) {
		// A workspace nobody mapped a team of has no actor, and a user who is gone has no connection.
		if (isActorGone(error)) return "ignored";
		throw error;
	}
}

/**
 * What `GET /linear/callback` needs of the actors. The state is checked here (its signature, its time, the number in the named
 * user's actor, which is there once), so a state that was forged, expired or replayed never reaches the code exchange.
 */
export const actorLinearConnectStore: LinearConnectStore = {
	async claim(state: string): Promise<LinearClaim> {
		const payload = readState(state);
		if (!payload) return { ok: false, reason: "state", origin: null };
		if (payload.exp <= Date.now())
			return { ok: false, reason: "state", origin: config.origins.includes(payload.origin) ? payload.origin : null };
		let claimed;
		try {
			claimed = await actors().user(payload.uid).internalLinearClaim(payload.nonce);
		} catch (error) {
			// A user whose actor is gone started nothing.
			if (isActorGone(error)) return { ok: false, reason: "state", origin: null };
			throw error;
		}
		// The origin is the one the owner's actor kept for this number, and must be the one signed into the state.
		if (!claimed.ok || claimed.origin !== payload.origin || claimed.verifier === null)
			return { ok: false, reason: "used", origin: config.origins.includes(payload.origin) ? payload.origin : null };
		return { ok: true, uid: payload.uid, nonce: payload.nonce, origin: claimed.origin, verifier: claimed.verifier };
	},
};
