/**
 * surfaceAccounts[surface, tenant]: which Windlass user each person on another surface is, for every surface that files work
 * (Slack, Linear, Jira, GitLab). GitHub's own directory is `githubAccount`. Service actions only.
 *
 *   link      one row per linked person: the surface's user id and the Windlass uid, each in one link at most. A newer proof
 *             replaces an older link of either.
 *   proof     one-time codes sent privately on the surface (Slack's ephemeral reply): opened by a signed-in Windlass user,
 *             a code links that user to the person it was sent to. Good for five minutes and once.
 *   prompted  the people already asked to link on one subject (a Linear or Jira issue), so each is asked once there.
 *
 * Proofs that come from a sign-in at the surface itself (Linear, Jira, GitLab) link through `internalLink`.
 */

import { createHash, randomUUID } from "node:crypto";
import { actor, UserError } from "rivetkit";
import { db } from "rivetkit/db";
import { internalConnection, requireServiceFor, serviceParams } from "../auth.js";
import type { HasClient } from "./internal.js";

export type Surface = "slack" | "linear" | "jira" | "gitlab";
export const PROOF_TTL_MS = 300_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const surfaces: readonly string[] = ["slack", "linear", "jira", "gitlab"];

/** The person a uid is linked as. */
export type LinkOf = { externalUserId: string; name: string; tenantName: string };

export const surfaceAccounts = actor({
	onBeforeConnect: internalConnection,
	onCreate: c => {
		if (c.key.length !== 2 || !surfaces.includes(c.key[0]!) || !/^[A-Za-z0-9._:-]{1,128}$/.test(c.key[1]!)) c.destroy();
	},
	db: db({
		onMigrate: async db => {
			await db.execute(
				"CREATE TABLE IF NOT EXISTS link (external_id TEXT PRIMARY KEY, uid TEXT NOT NULL UNIQUE, name TEXT NOT NULL, at INTEGER NOT NULL)",
			);
			await db.execute(
				"CREATE TABLE IF NOT EXISTS proof (digest TEXT PRIMARY KEY, external_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, expires INTEGER NOT NULL)",
			);
			await db.execute(
				"CREATE TABLE IF NOT EXISTS prompted (external_id TEXT, subject TEXT, at INTEGER, PRIMARY KEY(external_id, subject))",
			);
			await db.execute("CREATE TABLE IF NOT EXISTS tenant (id INTEGER PRIMARY KEY CHECK(id=1), name TEXT NOT NULL)");
		},
	}),
	actions: {
		/** A new one-time code for this person, replacing any earlier one. Only its digest is kept. */
		async internalOffer(c, externalId: string, name: string, tenantName: string): Promise<string> {
			requireServiceFor(c, "call");
			const proof = randomUUID();
			await c.db.transaction(async tx => {
				await tx.execute("DELETE FROM proof WHERE expires<=?", Date.now());
				await tx.execute(
					"INSERT OR REPLACE INTO proof VALUES(?,?,?,?)",
					hash(proof),
					externalId,
					name,
					Date.now() + PROOF_TTL_MS,
				);
				await tx.execute("INSERT OR REPLACE INTO tenant VALUES(1,?)", tenantName);
			});
			return proof;
		},
		/** Links `uid` to the person a code was sent to. The code is spent either way. */
		async internalRedeem(c, uid: string, proof: string): Promise<void> {
			requireServiceFor(c, "call");
			await c.db.transaction(async tx => {
				const [row] = await tx.execute<{ external_id: string; name: string }>(
					"DELETE FROM proof WHERE digest=? AND expires>? RETURNING external_id, name",
					hash(proof),
					Date.now(),
				);
				if (!row) throw new UserError("This link has expired or was already used.", { code: "link_ticket" });
				await tx.execute("DELETE FROM link WHERE external_id=? OR uid=?", row.external_id, uid);
				await tx.execute("INSERT INTO link VALUES(?,?,?,?)", row.external_id, uid, row.name, Date.now());
			});
		},
		/** Links `uid` to a person the surface's own sign-in proved. */
		async internalLink(c, uid: string, externalId: string, name: string, tenantName: string): Promise<void> {
			requireServiceFor(c, "call");
			await c.db.transaction(async tx => {
				const [old] = await tx.execute<{ uid: string }>("SELECT uid FROM link WHERE external_id=?", externalId);
				await tx.execute("DELETE FROM link WHERE external_id=? OR uid=?", externalId, uid);
				await tx.execute("INSERT INTO link VALUES(?,?,?,?)", externalId, uid, name, Date.now());
				await tx.execute("INSERT OR REPLACE INTO tenant VALUES(1,?)", tenantName);
				if (old && old.uid !== uid)
					console.log(`surface.account.relinked surface=${c.key[0]} from=${old.uid} to=${uid}`);
			});
		},
		async internalWho(c, externalId: string): Promise<string | null> {
			requireServiceFor(c, "call");
			const [row] = await c.db.execute<{ uid: string }>("SELECT uid FROM link WHERE external_id=?", externalId);
			return row?.uid ?? null;
		},
		async internalLinkOf(c, uid: string): Promise<LinkOf | null> {
			requireServiceFor(c, "call");
			const [row] = await c.db.execute<{ external_id: string; name: string; tenant: string | null }>(
				"SELECT external_id, link.name, tenant.name AS tenant FROM link LEFT JOIN tenant WHERE uid=?",
				uid,
			);
			return row ? { externalUserId: row.external_id, name: row.name, tenantName: row.tenant ?? "" } : null;
		},
		/** Revokes `uid`'s link here. Only that uid's own link goes. */
		async internalUnlink(c, uid: string, externalId?: string): Promise<void> {
			requireServiceFor(c, "call");
			if (externalId === undefined) await c.db.execute("DELETE FROM link WHERE uid=?", uid);
			else await c.db.execute("DELETE FROM link WHERE uid=? AND external_id=?", uid, externalId);
		},
		/** Forgets every link and code: the workspace itself was disconnected. */
		async internalClear(c): Promise<void> {
			requireServiceFor(c, "call");
			await c.db.transaction(async tx => {
				for (const table of ["link", "proof", "prompted"]) await tx.execute(`DELETE FROM ${table}`);
			});
		},
		/** True the first time this person is to be asked to link on `subject`, false after. */
		async internalPromptOnce(c, externalId: string, subject: string): Promise<boolean> {
			requireServiceFor(c, "call");
			await c.db.execute("DELETE FROM prompted WHERE at<=?", Date.now() - 90 * 86_400_000);
			const rows = await c.db.execute(
				"INSERT OR IGNORE INTO prompted VALUES(?,?,?) RETURNING external_id",
				externalId,
				subject,
				Date.now(),
			);
			return rows.length > 0;
		},
	},
});

export interface SurfaceAccounts {
	internalOffer(externalId: string, name: string, tenantName: string): Promise<string>;
	internalRedeem(uid: string, proof: string): Promise<void>;
	internalLink(uid: string, externalId: string, name: string, tenantName: string): Promise<void>;
	internalWho(externalId: string): Promise<string | null>;
	internalLinkOf(uid: string): Promise<LinkOf | null>;
	internalUnlink(uid: string, externalId?: string): Promise<void>;
	internalClear(): Promise<void>;
	internalPromptOnce(externalId: string, subject: string): Promise<boolean>;
}

/** The directory of one surface's tenant. `getOrCreate`: a lookup of an unknown tenant answers nobody. */
export function surfaceAccountsOf(c: HasClient, surface: Surface, tenant: string): SurfaceAccounts {
	return c.client().surfaceAccounts.getOrCreate([surface, tenant], { params: serviceParams() }) as SurfaceAccounts;
}

/** Jira's account ids are Atlassian's, the same on every site: one directory for all of them. */
export const JIRA_TENANT = "atlassian";

/** Where an unlinked person is sent to link. The address carries no secret. */
export const linkedAccountsUrl = (origin: string) => `${origin}/settings#linked-accounts`;
