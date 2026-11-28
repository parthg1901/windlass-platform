import { randomBytes } from "node:crypto";
import { UserError } from "rivetkit";
import type { RawAccess } from "rivetkit/db";
import { requireUser, serviceParams } from "../auth.js";
import { config } from "../config.js";
import type {
	GithubId,
	ItemSummary,
	JiraConnection,
	JiraMapping,
	JiraProjectList,
	JiraSite,
	JiraStatus,
} from "../contract.js";
import type { TrackerFiled } from "../factory/intake.js";
import { githubApp } from "../github/app.js";
import { GithubProblem, resolveRepository, type StoredConnection } from "../github/repos.js";
import { jiraApp, JiraError, type JiraApp, type JiraToken } from "../jira/app.js";
import { digest } from "../jira/connect.js";
import { isTriggerLabel, JIRA_WEBHOOK_PATH, type JiraDelivery, type JiraDispatch } from "../jira/webhook.js";
import { signedPayload } from "../signatures.js";
import { openSecret, sealSecret } from "../repo-secrets.js";
import { serverSealer } from "../signin/seal.js";
import type { ActorClient, JiraItemWrite } from "./internal.js";
import type { SiteJiraFiling } from "./issue-intake.js";
import type { JiraGeneration, Registration } from "./jira-site.js";

export const JIRA_TABLES = [
	"CREATE TABLE IF NOT EXISTS jira_state (nonce TEXT PRIMARY KEY, origin TEXT, expires INTEGER, claimed INTEGER DEFAULT 0, ticket TEXT UNIQUE, sealed TEXT)",
	"CREATE TABLE IF NOT EXISTS jira_connection (id INTEGER PRIMARY KEY CHECK(id=1), metadata TEXT, sealed TEXT)",
];
type Ctx = Parameters<typeof requireUser>[0] & {
	db: RawAccess;
	vars: { github: StoredConnection | null };
	conn: { state?: unknown };
	client(): ActorClient;
	schedule: { at(at: number, action: "internalJiraRenew"): Promise<string> };
	log: { warn(entry: unknown): void };
};
const requestOrigin = (c: Ctx) => (c.conn.state as { origin: string | null } | undefined)?.origin;
const problem = (message: string, code: string) => new UserError(message, { code });
const invalid = () => problem("This Jira connection link is no longer valid. Connect again.", "jira_ticket");
const requireApp = () => {
	const app = jiraApp();
	if (!app) throw problem("This deployment has no Jira app.", "jira_off");
	return app;
};
const queues = new WeakMap<object, Promise<unknown>>();
function serial<T>(c: Ctx, work: () => Promise<T>): Promise<T> {
	const run = (queues.get(c.vars) ?? Promise.resolve()).then(work);
	queues.set(
		c.vars,
		run.catch(() => {}),
	);
	return run;
}
function action<A extends unknown[], R>(work: (c: Ctx, ...args: A) => Promise<R>) {
	return (c: Ctx, ...args: A) => {
		requireUser(c);
		return serial(c, () => work(c, ...args));
	};
}
const directory = (c: Ctx, site: string) => c.client().jiraSite.getOrCreate([site], { params: serviceParams() });
const registrations = (c: Ctx, site: string): Promise<Registration[]> => directory(c, site).internalProjects(c.key[0]);
const seal = (c: Ctx, purpose: string, value: unknown) =>
	sealSecret(serverSealer(), c.key[0]!, "jira", purpose, JSON.stringify(value));
const open = <T>(c: Ctx, purpose: string, blob: string): T =>
	JSON.parse(openSecret(serverSealer(), c.key[0]!, "jira", purpose, blob));
type Grant = { token: JiraToken; sites: JiraSite[] };
export async function stageGrant(c: Ctx, nonce: string, origin: string, code: string | null, ticketHash: string) {
	const claimed = await c.db.execute(
		"UPDATE jira_state SET claimed=1 WHERE nonce=? AND origin=? AND claimed=0 AND expires>? RETURNING nonce",
		nonce,
		origin,
		Date.now(),
	);
	if (!claimed.length) return "invalid";
	if (!code) return "code";
	try {
		const app = requireApp(),
			token = await app.exchangeCode(serverSealer().open("transit", `jira:${c.key[0]}:${nonce}`, code));
		if (!token.refreshToken) return "scope";
		const sites = await app.sites(token.accessToken);
		if (!sites.length) return "sites";
		const rows = await c.db.execute(
			"UPDATE jira_state SET ticket=?,sealed=?,expires=? WHERE nonce=? AND expires>? RETURNING nonce",
			ticketHash,
			seal(c, nonce, { token, sites }),
			Date.now() + 300_000,
			nonce,
			Date.now(),
		);
		return rows.length ? "ready" : "invalid";
	} catch {
		return "failed";
	}
}
async function stored(c: Ctx) {
	const [row] = await c.db.execute<{ metadata: string; sealed: string }>("SELECT metadata,sealed FROM jira_connection");
	return row && { meta: JSON.parse(row.metadata) as JiraConnection, sealed: row.sealed };
}
export const selectedSite = async (c: Ctx) => (await stored(c))?.meta.site?.id ?? null;
const connected = (connection: JiraConnection): JiraStatus => ({ state: "connected", connection });
async function status(c: Ctx): Promise<JiraStatus> {
	if (!jiraApp()) return { state: "off" };
	const saved = await stored(c);
	return saved ? connected(saved.meta) : { state: "disconnected" };
}
const purpose = (meta: JiraConnection) => `token:${meta.site?.id ?? "pending"}`;
async function save(c: Ctx, meta: JiraConnection, token: JiraToken) {
	await c.db.execute(
		"INSERT OR REPLACE INTO jira_connection VALUES(1,?,?)",
		JSON.stringify(meta),
		seal(c, purpose(meta), token),
	);
	return connected(meta);
}
async function access(c: Ctx) {
	const app = requireApp(),
		saved = await stored(c);
	if (!saved) throw problem("Connect Jira first.", "jira_not_connected");
	let token = open<JiraToken>(c, purpose(saved.meta), saved.sealed);
	if (token.expiresAt !== null && token.expiresAt <= Date.now() + 60_000) {
		const renewed = await app.refresh(token.refreshToken!);
		token = { ...renewed, refreshToken: renewed.refreshToken ?? token.refreshToken };
		await save(c, saved.meta, token);
	}
	return { app, meta: saved.meta, token };
}
async function retire(c: Ctx, site: string, row: Registration) {
	await directory(c, site).internalRemove(c.key[0], row.mapping.projectId);
	try {
		const { app, token } = await access(c);
		await app.deleteWebhook(token.accessToken, site, row.hook);
	} catch {
		c.log.warn({ msg: "Could not retire a Jira webhook at Atlassian" });
	}
}
async function clear(c: Ctx) {
	const site = (await stored(c))?.meta.site;
	if (site) for (const row of await registrations(c, site.id)) await retire(c, site.id, row);
}
async function projects(c: Ctx, expected?: string) {
	const { app, meta, token } = await access(c),
		site = meta.site;
	if (!site || (expected !== undefined && expected !== site.id))
		throw problem("Choose the connected Jira site first.", "jira_site");
	const found = await app.projects(token.accessToken, site.id);
	const rows = await registrations(c, site.id);
	for (const row of rows) if (!found.some(p => p.id === row.mapping.projectId)) await retire(c, site.id, row);
	const list: JiraProjectList = {
		projects: found.map(p => ({ ...p, mapping: rows.find(r => r.mapping.projectId === p.id)?.mapping ?? null })),
	};
	return { app, token: token.accessToken, site, rows, list };
}
const renewAhead = 3 * 86_400_000;
async function refresh(c: Ctx, app: JiraApp, token: string, site: string, hook: number) {
	const expires = await app.refreshWebhook(token, site, hook);
	await c.schedule.at(Math.max(Date.now() + 60_000, expires - renewAhead), "internalJiraRenew");
	return expires;
}
async function register(c: Ctx, app: JiraApp, token: string, site: JiraSite, mapping: JiraMapping) {
	const key = randomBytes(32).toString("base64url");
	const url = new URL(`${JIRA_WEBHOOK_PATH}/${site.id}.${key}`, app.settings.redirectUrl).href;
	const hook = await app.registerWebhook(token, site.id, url, `project = ${mapping.projectId}`);
	const hash = digest(key);
	try {
		const expires = await refresh(c, app, token, site.id, hook);
		await directory(c, site.id).internalMap(c.key[0], { mapping, siteUrl: site.url, digest: hash, hook, expires });
	} catch (error) {
		// The site may have committed the registration before its reply was lost.
		if ((await registrations(c, site.id)).some(row => row.digest === hash)) return;
		await app.deleteWebhook(token, site.id, hook).catch(() => {});
		throw error;
	}
}
export const jiraSettingsActions = {
	jira: action(status),
	jiraConnect: action(async (c, { origin }: { origin: string }) => {
		const app = requireApp();
		if (!config.origins.includes(origin) || (requestOrigin(c) && requestOrigin(c) !== origin))
			throw problem("Connect Jira from the web app.", "origin_not_allowed");
		const nonce = randomBytes(32).toString("base64url"),
			exp = Date.now() + 600_000;
		await c.db.execute(
			"DELETE FROM jira_state WHERE expires<=? OR nonce NOT IN (SELECT nonce FROM jira_state ORDER BY expires DESC LIMIT 19)",
			Date.now(),
		);
		await c.db.execute("INSERT INTO jira_state(nonce,origin,expires) VALUES(?,?,?)", nonce, origin, exp);
		return {
			url: app.authorizeUrl(
				signedPayload("ji1", "github-state", { k: "jira-state", uid: c.key[0], nonce, origin, exp }),
			),
		};
	}),
	jiraComplete: action(async (c, ticket: string) => {
		const app = requireApp();
		if (typeof ticket !== "string" || !/^[\w-]{43}$/.test(ticket)) throw invalid();
		const [row] = await c.db.execute<{ sealed: string; nonce: string; origin: string }>(
			"SELECT * FROM jira_state WHERE ticket=? AND expires>?",
			digest(ticket),
			Date.now(),
		);
		if (!row || !config.origins.includes(row.origin) || (requestOrigin(c) && requestOrigin(c) !== row.origin))
			throw invalid();
		const { sites, token } = open<Grant>(c, row.nonce, row.sealed);
		const user = await app.identity(token.accessToken, sites[0]!.id);
		if (
			!(await c.db.execute("DELETE FROM jira_state WHERE nonce=? AND expires>? RETURNING nonce", row.nonce, Date.now()))
				.length
		)
			throw invalid();
		await clear(c);
		return save(c, { user, sites, site: null, connectedAt: Date.now() }, token);
	}),
	jiraSelectSite: action(async (c, id: string) => {
		const { app, token, meta } = await access(c);
		const sites = await app.sites(token.accessToken),
			site = sites.find(s => s.id === id);
		if (!site || !meta.sites.some(s => s.id === id)) throw problem("Choose an authorized Jira site.", "jira_site");
		const user = await app.identity(token.accessToken, id);
		if (meta.site?.id !== id || user.id !== meta.user.id) await clear(c);
		return save(c, { ...meta, user, site, sites }, token);
	}),
	jiraProjects: action(async c => (await projects(c)).list),
	saveJiraMapping: action(
		async (c, { siteId, projectId, repositoryId }: { siteId: string; projectId: string; repositoryId: GithubId }) => {
			const { app, site, token, list, rows } = await projects(c, siteId);
			const project = list.projects.find(p => p.id === projectId);
			if (site.id !== siteId || !project) throw problem("Choose a listed Jira project.", "jira_project");
			const github = githubApp();
			if (!github || !c.vars.github) throw problem("Connect GitHub first.", "github_not_connected");
			const { described: repo } = await resolveRepository(github, c.vars.github, repositoryId, "write").catch(error => {
				if (error instanceof GithubProblem && ["github_gone", "github_denied"].includes(error.code))
					throw problem("Choose a writable repository.", "bad_input");
				throw problem("The repository could not be checked at GitHub. Try again.", "github_unreachable");
			});
			const mapping = {
				siteId,
				projectId,
				repository: { id: repo.id, owner: repo.owner, name: repo.name },
				savedAt: Date.now(),
			};
			const row = rows.find(r => r.mapping.projectId === projectId);
			if (row) await directory(c, site.id).internalMap(c.key[0], { ...row, mapping });
			else await register(c, app, token, site, mapping);
			project.mapping = mapping;
			return list;
		},
	),
	removeJiraMapping: action(async (c, { siteId, projectId }: { siteId: string; projectId: string }) => {
		if (!siteId || (await selectedSite(c)) !== siteId)
			throw problem("Choose the connected Jira site first.", "jira_site");
		const row = (await registrations(c, siteId)).find(r => r.mapping.projectId === projectId);
		if (row) await retire(c, siteId, row);
		return (await projects(c, siteId)).list;
	}),
	disconnectJira: action(async c => {
		await clear(c);
		await c.db.transaction(async tx => {
			await tx.execute("DELETE FROM jira_connection");
			await tx.execute("DELETE FROM jira_state");
		});
		return status(c);
	}),
};
export function renewJiraWebhooks(c: Ctx) {
	return serial(c, async () => {
		try {
			const site = (await stored(c))?.meta.site;
			if (!site) return;
			const due = (await registrations(c, site.id)).filter(row => row.expires - renewAhead <= Date.now());
			if (!due.length) return;
			const { app, token } = await access(c);
			for (const row of due) {
				try {
					const expires = await refresh(c, app, token.accessToken, site.id, row.hook);
					await directory(c, site.id).internalMap(c.key[0], { ...row, expires });
				} catch (error) {
					if (
						!(error instanceof JiraError) ||
						!(
							error.status === 404 ||
							(error.status === 400 && !(await app.hasWebhook(token.accessToken, site.id, row.hook)))
						)
					)
						throw error;
					await register(c, app, token.accessToken, site, row.mapping);
				}
			}
		} catch (error) {
			await c.schedule.at(
				Math.max(Date.now() + 3_600_000, error instanceof JiraError ? error.retryAt : 0),
				"internalJiraRenew",
			);
			c.log.warn({ msg: "Jira webhook renewal deferred" });
		}
	});
}
export function fileJiraDelivery(
	c: Ctx,
	d: JiraDelivery,
	digest: string,
	file: (f: SiteJiraFiling) => Promise<TrackerFiled>,
): Promise<JiraDispatch> {
	return serial(c, async () => {
		const meta = (await stored(c))?.meta;
		if (!jiraApp() || meta?.site?.id !== d.cloudId || (!d.label && d.assignedTo !== meta.user.id)) return "ignored";
		const row = (await registrations(c, d.cloudId)).find(
			r => r.digest === digest && r.mapping.projectId === d.projectId,
		);
		if (!row || row.expires <= Date.now()) return "ignored";
		const { app, token } = await access(c),
			issue = await app.issue(token.accessToken, d.cloudId, d.issueId);
		if (!issue || issue.id !== d.issueId || issue.projectId !== d.projectId || issue.closed) return "ignored";
		const directoryActor = directory(c, d.cloudId);
		const plan: JiraGeneration = await directoryActor.internalGeneration(c.key[0], issue.id, d.sentAt);
		if (plan.kind === "exists") return "taken";
		const assigned = d.assignedTo === meta.user.id && issue.assignee?.id === meta.user.id;
		const labelled = d.label && issue.labels.some(isTriggerLabel);
		const sender = [issue.creator, issue.assignee, issue.reporter, meta.user].find(p => p && p.id === d.actorId);
		const decision = await file({
			issue: { ...issue, url: `${meta.site.url}/browse/${issue.identifier}` },
			plan,
			project: { id: issue.projectId, siteId: d.cloudId },
			repository: row.mapping.repository,
			trigger: {
				via: !assigned && d.label ? "label" : "assignment",
				at: d.sentAt,
				sender: sender ?? { id: d.actorId ?? "unknown", name: "a Jira user" },
				...(!assigned && !labelled && { lapsed: true }),
			},
		});
		if (decision.kind === "filed" || decision.kind === "exists")
			await directoryActor.internalFinishIssue(issue.id, decision.itemId);
		if (decision.kind === "refused" && decision.dailyCap) throw new Error("jira_daily_cap");
		return decision.kind === "ignored" ? "ignored" : "taken";
	});
}
const retry = new WeakMap<object, number>();
export function writeJiraItem(c: Ctx, { siteId, projectId, issueId, itemId, action }: JiraItemWrite) {
	return serial(c, async () => {
		if ((retry.get(c.vars) ?? 0) > Date.now()) throw new Error("jira_rate_limited");
		try {
			if ((await stored(c))?.meta.site?.id !== siteId) return false;
			const row = (await registrations(c, siteId)).find(r => r.mapping.projectId === projectId);
			if (!row) return false;
			const [indexed] = await c.db.execute<{ summary: string; key: string }>(
				"SELECT summary,key FROM items WHERE id=?",
				itemId,
			);
			if (!indexed) throw new Error("item_not_indexed"); // The outbox can wake before filing commits.
			const item: ItemSummary = JSON.parse(indexed.summary);
			if (
				item.origin?.jira?.id !== issueId ||
				item.repository.id !== row.mapping.repository.id ||
				!indexed.key?.startsWith(`jira:${siteId}:${issueId}:`)
			)
				return false;
			const { app, token, meta } = await access(c);
			const issue = await app.issue(token.accessToken, siteId, issueId);
			if (issue?.id !== issueId || issue.projectId !== projectId) return false;
			await app.progress(token.accessToken, siteId, issueId, meta.user.id, itemId, action);
			return true;
		} catch (error) {
			if (error instanceof JiraError && error.status === 429)
				retry.set(c.vars, Math.max(Date.now() + 15_000, error.retryAt));
			else if (error instanceof UserError || (error instanceof JiraError && error.status > 0 && error.status < 500))
				return false;
			throw new Error("jira_write_failed");
		}
	});
}
