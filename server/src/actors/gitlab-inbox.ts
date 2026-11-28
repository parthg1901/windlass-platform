/** gitlabInbox[uid, projectId]: only an authenticated, trimmed delivery reaches durable storage. */
import { actor } from "rivetkit";
import { createClient } from "rivetkit/client";
import { db, type RawAccess } from "rivetkit/db";
import { internalConnection, requireServiceFor, serviceParams } from "../auth.js";
import { config, gitlabConfig, ownEngineEndpoint } from "../config.js";
import { isActorGone } from "../actor-errors.js";
import { AddressBudget, clientAddress, rateLimited } from "../http-limits.js";
import { GITLAB_RECONNECT } from "../gitlab/connect.js";
import {
	GitlabWebhookError,
	parseGitlabWebhook,
	readGitlabWebhookBody,
	type GitlabDelivery,
} from "../gitlab/webhook.js";
import type { Registry } from "../registry.js";

const refusals = new AddressBudget(config.httpLimits.webhookRefusals);
const refuse = (request: Request, status: number) => {
	const wait = refusals.refusal(clientAddress(request));
	return wait ? rateLimited(wait, "Too many refused webhook requests.") : new Response(null, { status });
};

export async function receiveGitlabWebhook(request: Request): Promise<Response> {
	if (!gitlabConfig().app) return new Response(null, { status: 404 });
	if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
	const match = /^[A-Za-z0-9_-]{43}_([A-Za-z0-9_-]{1,512})$/.exec(request.headers.get("x-gitlab-token") ?? "");
	if (!match) return refuse(request, 401);
	const uid = Buffer.from(match[1]!, "base64url").toString();
	if (!/^[A-Za-z0-9_-]{1,256}$/.test(uid)) return refuse(request, 401);
	const signal = AbortSignal.timeout(8000);
	const client = createClient<Registry>({
		endpoint: ownEngineEndpoint(),
		disableMetadataLookup: true,
		fetch: (url, init) =>
			fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }),
	});
	const options = { params: serviceParams() };
	try {
		// get, not getOrCreate: an unauthenticated lookup cannot create an actor.
		const binding = await client.userGitlab
			.get([uid], options)
			.internalGitlabHook()
			.catch(error => {
				if (isActorGone(error)) return null;
				throw error;
			});
		if (!binding) return refuse(request, 401);
		const delivery = parseGitlabWebhook(request.headers, await readGitlabWebhookBody(request), binding);
		// Intake re-reads the authoritative issue/note. Do not persist delivery text.
		if (delivery?.event === "issue" || delivery?.event === "note") {
			delivery.title = delivery.description = "";
			if (delivery.event === "note") delivery.body = "";
		}
		const result =
			delivery &&
			(await client.gitlabInbox
				.getOrCreate([uid, delivery.projectId], options)
				.internalReceive(binding.bindingId, delivery));
		if (result === "busy") return new Response(null, { status: 503 });
		return Response.json(
			{ taken: result === "duplicate" ? "duplicate" : !!result },
			{ status: 202, headers: { "cache-control": "no-store" } },
		);
	} catch (error) {
		if (error instanceof GitlabWebhookError) return refuse(request, error.status);
		return new Response(null, { status: 503 });
	}
}

const WEEK = 7 * 86400_000,
	RETRY = 15_000;
type Ctx = {
	key: string[];
	db: RawAccess;
	vars: { writing: Promise<unknown>; draining: boolean };
	schedule: { at(at: number, action: string): Promise<string>; cancel(id: string): Promise<boolean> };
	keepAwake<T>(work: Promise<T>): Promise<T>;
	client(): unknown;
};
type Options = { params: { token: string } };
type ActorClient = {
	userGitlab: {
		get(
			key: string[],
			options: Options,
		): { internalGitlabHookCurrent(projectId: string, bindingId: string): Promise<boolean> };
	};
	user: {
		get(
			key: string[],
			options: Options,
		): {
			internalGitlabIntake(d: Extract<GitlabDelivery, { event: "issue" | "note" }>): Promise<string | null>;
			internalGitlabWake(d: Extract<GitlabDelivery, { event: "pipeline" | "merge_request" }>): Promise<unknown>;
		};
	};
};
function queued<T>(c: Ctx, f: () => Promise<T>) {
	const next = c.vars.writing.then(f);
	c.vars.writing = next.catch(() => undefined);
	return next;
}
// Called on the write queue. Always leave a durable wake before acknowledging work or dispatching it.
async function arm(c: Ctx) {
	const [work] = await c.db.execute<{ due: number | null }>(
		"SELECT min(CASE WHEN data IS NULL THEN received + ? ELSE due END) AS due FROM inbox",
		WEEK,
	);
	const [old] = await c.db.execute<{ id: string; at: number }>("SELECT id, at FROM wake");
	if (work.due !== null) {
		const at = Math.max(Date.now() + RETRY, work.due);
		if (old && old.at > Date.now() && old.at <= at) return;
		const id = await c.schedule.at(at, "internalDue");
		await c.db.execute("INSERT OR REPLACE INTO wake VALUES (1, ?, ?)", id, at);
	} else if (old) await c.db.execute("DELETE FROM wake");
	if (old) await c.schedule.cancel(old.id).catch(() => false);
}
async function dispatch(c: Ctx, binding: string, d: GitlabDelivery) {
	const client = c.client() as ActorClient,
		key = [c.key[0]!],
		opts = { params: serviceParams() };
	if (!(await client.userGitlab.get(key, opts).internalGitlabHookCurrent(d.projectId, binding))) return;
	const owner = client.user.get(key, opts);
	if (d.event === "issue" || d.event === "note") await owner.internalGitlabIntake(d);
	else await owner.internalGitlabWake(d);
}
async function drain(c: Ctx) {
	if (c.vars.draining) return;
	c.vars.draining = true;
	try {
		await queued(c, async () => {
			await c.db.execute("DELETE FROM inbox WHERE received <= ?", Date.now() - WEEK);
			await arm(c);
		});
		while (true) {
			const [row] = await c.db.execute<{ guid: string; binding: string; data: string; tries: number }>(
				"SELECT guid, binding, data, tries FROM inbox WHERE data IS NOT NULL AND due <= ? ORDER BY due, rowid LIMIT 1",
				Date.now(),
			);
			if (!row) break;
			try {
				await dispatch(c, row.binding, JSON.parse(row.data));
			} catch (error) {
				// A grant GitLab refused stays refused until the owner reconnects, which also rebinds the hook.
				if ((error as { code?: string })?.code === GITLAB_RECONNECT) {
					await c.db.execute("UPDATE inbox SET data=NULL WHERE guid=?", row.guid);
					continue;
				}
				if (!isActorGone(error) && row.tries < 7) {
					await c.db.execute(
						"UPDATE inbox SET tries=tries+1, due=? WHERE guid=?",
						Date.now() + RETRY * 2 ** row.tries,
						row.guid,
					);
					continue;
				}
				if (!isActorGone(error)) console.warn(`gitlab.delivery.failed delivery=${row.guid}`);
			}
			// Keep only the dedupe receipt after dispatch; never log issue text or credentials.
			await c.db.execute("UPDATE inbox SET data=NULL WHERE guid=?", row.guid);
		}
	} finally {
		c.vars.draining = false;
		await queued(c, () => arm(c));
	}
}
const runDrain = (c: Ctx) => {
	void c.keepAwake(drain(c).catch(() => console.warn("gitlab.inbox.drain_failed")));
};

export const gitlabInbox = actor({
	onBeforeConnect: internalConnection,
	db: db({
		onMigrate: async db => {
			await db.execute(
				"CREATE TABLE IF NOT EXISTS inbox (guid TEXT PRIMARY KEY, binding TEXT NOT NULL, data TEXT, tries INTEGER NOT NULL, received INTEGER NOT NULL, due INTEGER NOT NULL)",
			);
			await db.execute("CREATE INDEX IF NOT EXISTS inbox_due ON inbox(due) WHERE data IS NOT NULL");
			await db.execute(
				"CREATE TABLE IF NOT EXISTS wake (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, at INTEGER NOT NULL)",
			);
		},
	}),
	createVars: () => ({ writing: Promise.resolve() as Promise<unknown>, draining: false }),
	onWake: runDrain,
	actions: {
		internalReceive: async (c, binding: string, d: GitlabDelivery): Promise<"stored" | "duplicate" | "busy"> => {
			requireServiceFor(c, "call");
			if (c.key.length !== 2 || d.projectId !== c.key[1]) throw new Error("Wrong GitLab inbox.");
			const result = await queued(c, async () => {
				const now = Date.now();
				await c.db.execute("DELETE FROM inbox WHERE received <= ?", now - WEEK);
				const known = (await c.db.execute("SELECT 1 FROM inbox WHERE guid=?", d.guid)).length > 0;
				if (!known) {
					const [count] = await c.db.execute<{ total: number; pending: number }>(
						"SELECT count(*) AS total, count(data) AS pending FROM inbox",
					);
					if (count.pending >= 2000 || count.total >= 20000) return "busy";
					await c.db.execute(
						"INSERT INTO inbox VALUES (?, ?, ?, 0, ?, ?)",
						d.guid,
						binding,
						JSON.stringify(d),
						now,
						now,
					);
				}
				await arm(c);
				return known ? "duplicate" : "stored";
			});
			if (result !== "busy") runDrain(c);
			return result;
		},
		internalDue: async c => {
			if (!c.scheduledFire) requireServiceFor(c, "call");
			await queued(c, () => arm(c));
			await drain(c);
		},
	},
});
