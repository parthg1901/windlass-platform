/**
 * The user's linked accounts on other surfaces, inside the user's actor: the Settings actions, and the index of where this
 * user is linked. `surfaceAccounts` holds the links themselves and answers who a person is; this index only lists them.
 *
 *   identity_links   one row per surface tenant this user linked in. A row whose link has gone (replaced by a newer proof,
 *                    or the workspace disconnected) is dropped when the list is read.
 */

import { UserError } from "rivetkit";
import type { RawAccess } from "rivetkit/db";
import { requireUser } from "../auth.js";
import type { LinkedAccount, LinkSurface } from "../contract.js";
import { isActorGone, type ActorClient } from "./internal.js";
import { surfaceAccountsOf } from "./surface-accounts.js";
import { beginLinearLink, completeLinearLink, type LinearCtx } from "./user-linear.js";

export const IDENTITY_TABLES = [
	"CREATE TABLE IF NOT EXISTS identity_links (surface TEXT NOT NULL, tenant TEXT NOT NULL, PRIMARY KEY(surface, tenant))",
];

type Ctx = Parameters<typeof requireUser>[0] & { key: string[]; db: RawAccess; client(): ActorClient };
const SURFACES: readonly LinkSurface[] = ["slack", "linear", "jira"];
const badTicket = () =>
	new UserError("This link is not valid. Start again from where you were asked to link.", { code: "link_ticket" });

/** Records that this user is linked in a tenant, after the directory linked them. */
async function remember(c: Pick<Ctx, "db">, surface: LinkSurface, tenant: string) {
	await c.db.execute("INSERT OR IGNORE INTO identity_links VALUES(?,?)", surface, tenant);
}

/** Links this user to a person the surface's own sign-in proved (connecting Jira proves its account). */
export async function linkProvenAccount(
	c: Pick<Ctx, "db" | "key" | "client">,
	surface: LinkSurface,
	tenant: string,
	person: { id: string; name: string },
	tenantName: string,
) {
	await surfaceAccountsOf(c, surface, tenant).internalLink(c.key[0]!, person.id, person.name, tenantName);
	await remember(c, surface, tenant);
}

async function list(c: Ctx): Promise<LinkedAccount[]> {
	const accounts: LinkedAccount[] = [];
	const rows = await c.db.execute<{ surface: LinkSurface; tenant: string }>(
		"SELECT surface, tenant FROM identity_links ORDER BY surface, tenant",
	);
	for (const { surface, tenant } of rows) {
		const link = await surfaceAccountsOf(c, surface, tenant)
			.internalLinkOf(c.key[0]!)
			.catch(error => {
				if (isActorGone(error)) return null;
				throw error;
			});
		if (link) accounts.push({ surface, tenant, tenantName: link.tenantName, name: link.name });
		else await c.db.execute("DELETE FROM identity_links WHERE surface=? AND tenant=?", surface, tenant);
	}
	return accounts;
}

export const linkedAccountActions = {
	linkedAccounts: (c: Ctx) => {
		requireUser(c);
		return list(c);
	},
	linkAccount: async (c: Ctx, ticket: string): Promise<LinkedAccount[]> => {
		requireUser(c);
		if (typeof ticket !== "string" || ticket.length > 8192) throw badTicket();
		const slack = /^slack\.(T[A-Z0-9]{1,32})\.([a-f0-9-]{36})$/.exec(ticket);
		if (slack) {
			const [, team, proof] = slack;
			await surfaceAccountsOf(c, "slack", team!).internalRedeem(c.key[0]!, proof!);
			await remember(c, "slack", team!);
		} else if (ticket.startsWith("linear.")) {
			const proven = await completeLinearLink(c as unknown as LinearCtx, ticket.slice("linear.".length));
			if (!proven) throw badTicket();
			await linkProvenAccount(c, "linear", proven.workspace.id, proven.person, proven.workspace.name);
		} else throw badTicket();
		return list(c);
	},
	linkAccountStart: (c: Ctx, input: { surface: "linear"; origin: string }) => {
		requireUser(c);
		if (input?.surface !== "linear") throw new UserError("Choose an account to link.", { code: "bad_input" });
		return beginLinearLink(c as unknown as LinearCtx, input);
	},
	unlinkAccount: async (c: Ctx, input: { surface: LinkSurface; tenant: string }): Promise<LinkedAccount[]> => {
		requireUser(c);
		const surface = input?.surface,
			tenant = input?.tenant;
		if (!SURFACES.includes(surface) || typeof tenant !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(tenant))
			throw new UserError("Choose a linked account.", { code: "bad_input" });
		await surfaceAccountsOf(c, surface, tenant).internalUnlink(c.key[0]!);
		await c.db.execute("DELETE FROM identity_links WHERE surface=? AND tenant=?", surface, tenant);
		return list(c);
	},
};
