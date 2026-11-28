import { actor, UserError } from "rivetkit";
import { db } from "rivetkit/db";
import { internalConnection, requireServiceFor, serviceParams } from "../auth.js";
import type { JiraMapping } from "../contract.js";
import type { JiraDelivery, JiraDispatch } from "../jira/webhook.js";
import { isActorGone } from "./internal.js";
import { existingItem, isEnded } from "./issue-intake.js";

export type Registration = { mapping: JiraMapping; hook: number; digest: string; expires: number; siteUrl: string };
type ProjectRow = { uid: string; epoch: string; registration: string };
type IssueRow = { uid: string; generation: number; item: string; pending: number; activations: number };
export type JiraReservation = Pick<IssueRow, "generation" | "activations">;
export type JiraGeneration = { kind: "exists"; itemId: string } | ({ kind: "file" } & JiraReservation);

export const jiraSite = actor({
	onBeforeConnect: internalConnection,
	onCreate: c => {
		if (c.key.length !== 1 || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(c.key[0]!)) c.destroy();
	},
	db: db({
		onMigrate: async db => {
			await db.execute(
				"CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, uid TEXT NOT NULL, epoch TEXT NOT NULL, registration TEXT NOT NULL)",
			);
			await db.execute(
				"CREATE TABLE IF NOT EXISTS delivery (id TEXT PRIMARY KEY, epoch TEXT, issue TEXT, done INTEGER, received INTEGER)",
			);
			await db.execute("CREATE INDEX IF NOT EXISTS delivery_received ON delivery(received)");
			await db.execute(
				"CREATE TABLE IF NOT EXISTS issue_filing (issue TEXT PRIMARY KEY, uid TEXT, generation INTEGER, item TEXT, pending INTEGER, activations INTEGER)",
			);
		},
	}),
	createVars: () => ({ delivering: Promise.resolve() }),
	actions: {
		async internalProjects(c, uid: string): Promise<Registration[]> {
			requireServiceFor(c, "call");
			return (await c.db.execute<ProjectRow>("SELECT registration FROM project WHERE uid=?", uid)).map(row =>
				JSON.parse(row.registration),
			);
		},
		async internalMap(c, uid: string, registration: Registration) {
			requireServiceFor(c, "call");
			const project = registration.mapping.projectId;
			const taken = () =>
				new UserError("Another Windlass user has mapped this Jira project.", { code: "jira_project_taken" });
			const [prior] = await c.db.execute<ProjectRow>("SELECT * FROM project WHERE id=?", project);
			if (prior && prior.uid !== uid) {
				// An account removed without disconnecting may leave a project behind.
				const owner = c.client().user.get([prior.uid], { params: serviceParams() });
				const site = await owner.internalJiraSite().catch((error: unknown) => {
					if (isActorGone(error)) return null;
					throw error;
				});
				if (site === c.key[0]) throw taken();
				await c.db.execute(
					"DELETE FROM project WHERE id=? AND uid=? AND registration=?",
					project,
					prior.uid,
					prior.registration,
				);
			}
			const rows = await c.db.execute(
				`INSERT INTO project VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET registration=excluded.registration
				WHERE uid=excluded.uid RETURNING id`,
				project,
				uid,
				registration.digest,
				JSON.stringify(registration),
			);
			if (!rows.length) throw taken();
		},
		async internalRemove(c, uid: string, id: string) {
			requireServiceFor(c, "call");
			await c.db.execute("DELETE FROM project WHERE id=? AND uid=?", id, uid);
		},
		async internalDispatch(c, delivery: JiraDelivery, digest: string): Promise<JiraDispatch> {
			requireServiceFor(c, "call");
			const run = c.vars.delivering.then(async (): Promise<JiraDispatch> => {
				const [row] = await c.db.execute<ProjectRow>("SELECT * FROM project WHERE id=?", delivery.projectId);
				if (!row) return "ignored";
				const reg: Registration = JSON.parse(row.registration);
				if (reg.digest !== digest || !delivery.matchedWebhookIds.includes(reg.hook) || reg.expires <= Date.now())
					return "ignored";
				const self = delivery.self && URL.parse(delivery.self);
				if (
					delivery.self !== null &&
					(!self ||
						(self.origin !== reg.siteUrl && !self.href.startsWith(`https://api.atlassian.com/ex/jira/${c.key[0]}/`)))
				)
					return "ignored";
				await c.db.execute("DELETE FROM delivery WHERE received<=?", Date.now() - 7 * 86_400_000);
				const id = delivery.deliveryId;
				await c.db.execute(
					"INSERT OR IGNORE INTO delivery VALUES(?,?,?,0,?)",
					id,
					row.epoch,
					delivery.issueId,
					Date.now(),
				);
				const [receipt] = await c.db.execute<{ done: number; epoch: string; issue: string }>(
					"SELECT * FROM delivery WHERE id=?",
					id,
				);
				if (receipt.done) return "duplicate";
				if (receipt.epoch !== row.epoch || receipt.issue !== delivery.issueId) return "ignored";
				const owner = c.client().user.get([row.uid], { params: serviceParams() });
				const result: JiraDispatch = await owner.internalJiraDelivery(delivery, digest);
				await c.db.execute("UPDATE delivery SET done=1 WHERE id=?", id);
				return result;
			});
			c.vars.delivering = run.then(
				() => {},
				() => {},
			);
			return run;
		},
		async internalGeneration(c, uid: string, issue: string, at: number): Promise<JiraGeneration> {
			requireServiceFor(c, "call");
			const [prior] = await c.db.execute<IssueRow>("SELECT * FROM issue_filing WHERE issue=?", issue);
			if (!prior) return { kind: "file", generation: 1, activations: 0 };
			if (prior.pending && prior.uid === uid)
				return { kind: "file", generation: prior.generation, activations: prior.activations };
			const item = await existingItem(c, prior.uid, prior.item);
			if (item && (!isEnded(item) || at <= (item.endedAt ?? Infinity))) return { kind: "exists", itemId: item.id };
			if (!item && !prior.pending) throw new Error("Jira filing could not be verified");
			return { kind: "file", generation: prior.generation + 1, activations: prior.activations };
		},
		async internalReserveIssue(c, uid: string, issue: string, item: string, plan: JiraReservation) {
			requireServiceFor(c, "call");
			// A retry can reactivate the previous item between reading its state and reserving its successor.
			const rows = await c.db.execute(
				`INSERT INTO issue_filing VALUES(?,?,?,?,1,0) ON CONFLICT(issue) DO UPDATE SET
				uid=excluded.uid,generation=excluded.generation,item=excluded.item,pending=1,activations=0
				WHERE generation=excluded.generation-1 AND activations=? RETURNING item`,
				issue,
				uid,
				plan.generation,
				item,
				plan.activations,
			);
			if (
				!rows.length &&
				!(
					await c.db.execute(
						"SELECT 1 FROM issue_filing WHERE issue=? AND uid=? AND item=? AND generation=?",
						issue,
						uid,
						item,
						plan.generation,
					)
				).length
			)
				throw new Error("Jira issue generation changed");
		},
		async internalActivateIssue(c, issue: string, uid: string, item: string, generation: number) {
			requireServiceFor(c, "call");
			return (
				(
					await c.db.execute(
						"UPDATE issue_filing SET activations=activations+1 WHERE issue=? AND uid=? AND item=? AND generation=? RETURNING item",
						issue,
						uid,
						item,
						generation,
					)
				).length > 0
			);
		},
		async internalFinishIssue(c, issue: string, item: string) {
			requireServiceFor(c, "call");
			await c.db.execute("UPDATE issue_filing SET pending=0 WHERE issue=? AND item=?", issue, item);
		},
	},
});
