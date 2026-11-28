/** userGitlab[uid] owns the sealed grant, pending OAuth states and the owner's selected project. */
import { actor, UserError } from "rivetkit";
import { createClient } from "rivetkit/client";
import { db, type RawAccess } from "rivetkit/db";
import { assertOrigin, authenticate, checkGeneration, requireServiceFor, serviceParams } from "../auth.js";
import { config, ownEngineEndpoint } from "../config.js";
import type { GitlabProjectList, GitlabStatus, SessionRepository } from "../contract.js";
import { challengeOf, GitlabApp, GitlabError, newVerifier, projectAccess, type GitlabToken } from "../gitlab/app.js";
import { GITLAB_RECONNECT, gitlabApp, issuerOf, openGitlabTicket, type GitlabConnectStore } from "../gitlab/connect.js";
import { decimalId } from "../gitlab/ids.js";
import { openSecret, sealSecret } from "../repo-secrets.js";
import { readSignedPayload, signedPayload } from "../signatures.js";
import { serverSealer } from "../signin/seal.js";
import { isActorGone, userActor } from "./internal.js";

const STATE_TTL = 10 * 60_000;
const invalid = () => new UserError("Start connecting GitLab again.", { code: "gitlab_state" });
const disconnected = () => new UserError("Connect GitLab first.", { code: "gitlab_not_connected" });
const reconnect = () => new UserError("Reconnect GitLab in Settings.", { code: GITLAB_RECONNECT });
function configured() {
	const app = gitlabApp();
	if (!app) throw new UserError("GitLab is not configured.", { code: "gitlab_off" });
	return app;
}
interface Context {
	key: string[];
	db: RawAccess;
	conn?: { params: unknown } | null;
	vars: { queue: Promise<void> };
	client(): unknown; // Avoid a circular registry type, as in internal.ts.
}
function checkKey(key: string[]) {
	if (key.length !== 1 || !key[0]) throw new UserError("Invalid actor key.", { code: "forbidden" });
}
async function owner(c: Context) {
	checkKey(c.key);
	const caller = authenticate(c.key, c.conn?.params);
	if (caller.kind !== "user") throw new UserError("This action is for users.", { code: "forbidden" });
	checkGeneration(caller, await userActor(c, c.key[0]!).internalTokenGeneration());
	return caller;
}
/** A refresh token rotates; never refresh, replace or disconnect the grant concurrently. */
function serialized<T>(c: Context, job: () => Promise<T>) {
	const next = c.vars.queue.then(job);
	c.vars.queue = next.then(
		() => {},
		() => {},
	);
	return next;
}
type Grant = {
	issuer: string;
	viewer: string;
	sealed: string;
	project: string | null;
	hook_id: string | null;
	hook_sealed: string | null;
};

/** A removed binding rejects further deliveries even if the GitLab hook could not be deleted. */
async function removeHook(app: GitlabApp, token: string, project: string | null, hook: string | null) {
	const projectId = project && decimalId(JSON.parse(project).id);
	const hookId = decimalId(hook);
	if (!projectId || !hookId) return;
	try {
		await app.call({ method: "DELETE", path: `/projects/${projectId}/hooks/${hookId}`, token });
	} catch {
		/* stale provider hook: no local binding */
	}
}
async function grant(c: Context, app: GitlabApp) {
	return (
		await c.db.execute<Grant>(
			"SELECT issuer, viewer, sealed, project, hook_id, hook_sealed FROM grant_record WHERE id=1 AND issuer=?",
			issuerOf(app),
		)
	)[0];
}
const tokenScope = (issuer: string, viewer: string) => JSON.stringify(["gitlab", issuer, viewer]);
function seal(c: Context, issuer: string, viewer: string, token: GitlabToken) {
	return sealSecret(serverSealer(), c.key[0]!, tokenScope(issuer, viewer), "oauth-token", JSON.stringify(token));
}
function open(c: Context, saved: Grant): GitlabToken {
	return JSON.parse(
		openSecret(serverSealer(), c.key[0]!, tokenScope(saved.issuer, saved.viewer), "oauth-token", saved.sealed),
	);
}
/** Never send an old issuer's credentials to a new instance. Local deletion is authoritative. */
async function retire(c: Context, app: GitlabApp, saved: Grant, replacement?: { viewer: string; token: GitlabToken }) {
	if (saved.issuer !== issuerOf(app)) return;
	try {
		const old = open(c, saved);
		if (replacement?.viewer !== saved.viewer) await removeHook(app, old.accessToken, saved.project, saved.hook_id);
		if (
			old.accessToken === replacement?.token.accessToken ||
			(old.refreshToken && old.refreshToken === replacement?.token.refreshToken)
		)
			return;
		await app.revoke(old.refreshToken ?? old.accessToken);
	} catch {
		/* Remote cleanup is best effort. */
	}
}
async function tokenInQueue(c: Context, app: GitlabApp) {
	const saved = await grant(c, app);
	if (!saved) throw disconnected();
	let token = open(c, saved);
	if (token.expiresAt !== null && token.expiresAt <= Date.now() + 60_000) {
		if (!token.refreshToken) throw disconnected();
		const renewed = await app.refresh(token.refreshToken).catch(async error => {
			// GitLab answers invalid_grant (400) or 401 for a revoked or expired grant: no retry can succeed.
			if (!(error instanceof GitlabError && (error.status === 400 || error.status === 401))) throw error;
			await c.db.transaction(async tx => {
				await tx.execute("DELETE FROM grant_record");
				await tx.execute("INSERT OR REPLACE INTO revoked_record VALUES (1, ?)", Date.now());
			});
			throw reconnect();
		});
		token = { ...renewed, refreshToken: renewed.refreshToken ?? token.refreshToken };
		await c.db.execute("UPDATE grant_record SET sealed=? WHERE id=1", seal(c, saved.issuer, saved.viewer, token));
	}
	return token.accessToken;
}
async function status(c: Context): Promise<GitlabStatus> {
	const app = gitlabApp();
	if (!app) return { state: "off" };
	const saved = await grant(c, app);
	if (saved)
		return {
			state: "connected",
			baseUrl: app.settings.baseUrl,
			project: saved.project ? JSON.parse(saved.project) : null,
		};
	return (await c.db.execute("SELECT 1 FROM revoked_record")).length
		? { state: "disconnected", reconnect: true }
		: { state: "disconnected" };
}
/** Use only provider-confirmed paths and construct links on the configured instance. */
function project(app: GitlabApp, value: unknown): SessionRepository | null {
	const p = projectAccess(value);
	if (!p?.defaultBranch || !p.writable) return null;
	return {
		provider: "gitlab",
		id: p.id,
		owner: p.owner,
		name: p.name,
		branch: p.defaultBranch,
		private: p.private,
		url: app.cloneUrl(p.owner, p.name).slice(0, -4),
	};
}
const badProject = () => new UserError("Choose a writable GitLab project.", { code: "gitlab_project" });

function hookBinding(saved: Grant | undefined) {
	if (!saved?.project || !saved.hook_sealed || !saved.hook_id) return null;
	const projectId = decimalId(JSON.parse(saved.project).id);
	return projectId && { projectId, bindingId: JSON.stringify([saved.issuer, saved.hook_id]) };
}

type Claimed = { origin: string; verifier: string };
export const userGitlab = actor({
	onBeforeConnect: async (c, params: { token: string } | undefined) => {
		assertOrigin(c);
		checkKey(c.key);
		const caller = authenticate(c.key, params);
		if (caller.kind === "user") checkGeneration(caller, await userActor(c, c.key[0]!).internalTokenGeneration());
		else requireServiceFor({ key: c.key, conn: { params } }, "call");
	},
	db: db({
		onMigrate: async db => {
			await db.execute(
				"CREATE TABLE IF NOT EXISTS grant_record (id INTEGER PRIMARY KEY CHECK(id=1), issuer TEXT NOT NULL, viewer TEXT NOT NULL, sealed TEXT NOT NULL, project TEXT, hook_id TEXT, hook_sealed TEXT)",
			);
			await db.execute(
				"CREATE TABLE IF NOT EXISTS revoked_record (id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL)",
			);
			await db.execute(
				"CREATE TABLE IF NOT EXISTS oauth_state (nonce TEXT PRIMARY KEY, issuer TEXT NOT NULL, origin TEXT NOT NULL, verifier TEXT NOT NULL, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
			);
		},
	}),
	createVars: () => ({ queue: Promise.resolve() }),
	actions: {
		internalGitlabAccess: async (
			c,
			projectId: string,
		): Promise<{ project: SessionRepository; viewer: string; token: string }> => {
			requireServiceFor(c, "call");
			const app = configured();
			return serialized(c, async () => {
				const saved = await grant(c, app);
				const project: SessionRepository | null = saved?.project ? JSON.parse(saved.project) : null;
				if (!saved || !project || String(project.id) !== projectId) throw badProject();
				return { project, viewer: saved.viewer, token: await tokenInQueue(c, app) };
			});
		},
		internalGitlabHook: async c => {
			requireServiceFor(c, "call");
			const app = gitlabApp(),
				saved = app ? await grant(c, app) : undefined;
			const binding = hookBinding(saved);
			if (!binding || !saved?.hook_sealed) return null;
			return {
				...binding,
				secret: openSecret(
					serverSealer(),
					c.key[0]!,
					JSON.stringify(["gitlab-project", saved.issuer, binding.projectId]),
					"webhook-token",
					saved.hook_sealed,
				),
			};
		},
		internalGitlabHookCurrent: async (c, projectId: string, bindingId: string) => {
			requireServiceFor(c, "call");
			const app = gitlabApp(),
				binding = app && hookBinding(await grant(c, app));
			return !!binding && binding.projectId === projectId && binding.bindingId === bindingId;
		},
		gitlab: async c => {
			await owner(c);
			return status(c);
		},
		gitlabConnect: async (c, input: { origin: string }) => {
			const { generation } = await owner(c),
				app = configured(),
				origin = input?.origin;
			if (!config.origins.includes(origin))
				throw new UserError("Connect from the web app's address.", { code: "origin_not_allowed" });
			const nonce = newVerifier(),
				verifier = newVerifier(),
				exp = Date.now() + STATE_TTL;
			const state = signedPayload("gl1", "github-state", { k: "gitlab-state", uid: c.key[0], nonce, origin, exp });
			await c.db.transaction(async tx => {
				await tx.execute(
					"DELETE FROM oauth_state WHERE expires_at <= ? OR nonce NOT IN (SELECT nonce FROM oauth_state ORDER BY expires_at DESC LIMIT 19)",
					Date.now(),
				);
				await tx.execute(
					"INSERT INTO oauth_state VALUES (?, ?, ?, ?, ?, ?)",
					nonce,
					issuerOf(app),
					origin,
					verifier,
					generation,
					exp,
				);
			});
			return { url: app.authorizeUrl(state, challengeOf(verifier)) };
		},
		internalGitlabClaim: async (c, nonce: string): Promise<Claimed | null> => {
			requireServiceFor(c, "call");
			checkKey(c.key);
			if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) return null;
			const [row] = await c.db.execute<Claimed>(
				"UPDATE oauth_state SET nonce=?, expires_at=? WHERE nonce=? AND issuer=? AND expires_at>? RETURNING origin, verifier",
				`ticket:${nonce}`,
				Date.now() + 300_000,
				nonce,
				issuerOf(configured()),
				Date.now(),
			);
			return row ?? null;
		},
		gitlabComplete: async (c, ticket: string): Promise<GitlabStatus> => {
			const { generation } = await owner(c),
				app = configured();
			let confirmed;
			try {
				confirmed = openGitlabTicket(c.key[0]!, ticket);
			} catch {
				throw invalid();
			}
			const { nonce, issuer, viewerId, token } = confirmed;
			if (issuer !== issuerOf(app)) throw invalid();
			return serialized(c, async () => {
				const previous = await grant(c, app);
				await c.db.transaction(async tx => {
					const claimed = await tx.execute(
						"DELETE FROM oauth_state WHERE nonce=? AND generation=? AND issuer=? AND expires_at>? RETURNING nonce",
						`ticket:${nonce}`,
						generation,
						issuer,
						Date.now(),
					);
					if (!claimed.length) throw invalid();
					// Reauthorizing the same account keeps its selection and hook, not another account's.
					await tx.execute("DELETE FROM revoked_record");
					await tx.execute("DELETE FROM grant_record WHERE issuer != ? OR viewer != ?", issuer, viewerId);
					await tx.execute(
						`INSERT INTO grant_record (id, issuer, viewer, sealed) VALUES (1, ?, ?, ?)
						ON CONFLICT (id) DO UPDATE SET sealed=excluded.sealed`,
						issuer,
						viewerId,
						seal(c, issuer, viewerId, token),
					);
				});
				if (previous) await retire(c, app, previous, { viewer: viewerId, token });
				return status(c);
			});
		},
		gitlabProjects: async (c, query: string): Promise<GitlabProjectList> => {
			await owner(c);
			if (typeof query !== "string" || query.length > 256)
				throw new UserError("Invalid project search.", { code: "bad_input" });
			const app = configured();
			return serialized(c, async () => {
				const page = await app.projects(await tokenInQueue(c, app), query);
				return { projects: page.items.flatMap(item => project(app, item) ?? []), more: page.truncated };
			});
		},
		gitlabPickProject: async (c, projectId: string): Promise<GitlabStatus> => {
			await owner(c);
			const app = configured(),
				id = decimalId(projectId);
			if (!id) throw badProject();
			return serialized(c, async () => {
				const token = await tokenInQueue(c, app);
				const response = await app.call({ path: `/projects/${id}`, token }).catch(error => {
					if (error instanceof GitlabError && [403, 404].includes(error.status)) throw badProject();
					throw error;
				});
				const picked = project(app, response.body);
				if (!picked || String(picked.id) !== id) throw badProject();
				const saved = await grant(c, app);
				if (!saved) throw disconnected();
				if (saved.hook_id && saved.project && String(JSON.parse(saved.project).id) === id) {
					await c.db.execute("UPDATE grant_record SET project=? WHERE id=1", JSON.stringify(picked));
				} else {
					// The suffix locates an existing owner. It is not proof of the binding.
					const secret = `${newVerifier()}_${Buffer.from(c.key[0]!).toString("base64url")}`;
					const hookSealed = sealSecret(
						serverSealer(),
						c.key[0]!,
						JSON.stringify(["gitlab-project", issuerOf(app), id]),
						"webhook-token",
						secret,
					);
					const hookId = await app.projectHook(token, id, app.settings.webhookUrl, secret).catch(error => {
						if (error instanceof GitlabError && error.status === 403)
							throw new UserError("GitLab requires Maintainer access to register the Windlass project hook.", {
								code: "gitlab_hook_denied",
							});
						throw error;
					});
					const description = JSON.stringify(picked);
					try {
						await c.db.execute(
							"UPDATE grant_record SET project=?, hook_id=?, hook_sealed=? WHERE id=1",
							description,
							hookId,
							hookSealed,
						);
					} catch (error) {
						await removeHook(app, token, description, hookId);
						throw error;
					}
					await removeHook(app, token, saved.project, saved.hook_id);
				}
				return status(c);
			});
		},
		gitlabDisconnect: async c => {
			await owner(c);
			return serialized(c, async () => {
				const app = gitlabApp(),
					saved = app && (await grant(c, app));
				await c.db.transaction(async tx => {
					await tx.execute("DELETE FROM oauth_state");
					await tx.execute("DELETE FROM grant_record");
					await tx.execute("DELETE FROM revoked_record");
				});
				// Local access ends even when the instance is down or the saved token expired.
				if (app && saved) await retire(c, app, saved);
				return status(c);
			});
		},
	},
});

interface CallbackClient {
	userGitlab: {
		get(key: string[], options: { params: unknown }): { internalGitlabClaim(nonce: string): Promise<Claimed | null> };
	};
}
let callbackClient: CallbackClient | undefined;
export const actorGitlabConnectStore: GitlabConnectStore = {
	async claim(state) {
		const fields = readSignedPayload(state, "gl1", 8192, k => (k === "gitlab-state" ? "github-state" : null));
		if (
			!fields ||
			typeof fields.uid !== "string" ||
			!fields.uid ||
			typeof fields.nonce !== "string" ||
			typeof fields.origin !== "string" ||
			!config.origins.includes(fields.origin) ||
			typeof fields.exp !== "number" ||
			fields.exp <= Date.now()
		)
			return { ok: false, reason: "state", origin: null };
		callbackClient ??= createClient({ endpoint: ownEngineEndpoint() }) as unknown as CallbackClient;
		const actor = callbackClient.userGitlab.get([fields.uid], { params: serviceParams() });
		let claimed;
		try {
			claimed = await actor.internalGitlabClaim(fields.nonce);
		} catch (error) {
			if (!isActorGone(error)) throw error;
		}
		if (!claimed || claimed.origin !== fields.origin) return { ok: false, reason: "used", origin: fields.origin };
		return { ok: true, uid: fields.uid, nonce: fields.nonce, ...claimed };
	},
};
