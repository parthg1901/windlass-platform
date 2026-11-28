/**
 * The user's linked accounts on other surfaces, inside the user's actor: the Settings actions, and the index of where this
 * user is linked. `surfaceAccounts` holds the links themselves and answers who a person is; this index only lists them.
 *
 *   identity_links   one row per Slack, Linear or Jira tenant this user linked in. A row whose link has gone (replaced by a
 *                    newer proof, or the workspace disconnected) is dropped when the list is read. GitLab has one instance,
 *                    asked directly: its links are made by `userGitlab`, which cannot write here.
 *
 * Each surface links by a read-only sign-in as oneself there (`linkAccountStart`), whose return the web app redeems at once:
 * its ticket opens only for the user who began it. Slack's private one-time link is the exception: it was sent to a Slack
 * user, so whoever opens it confirms the named account first (`linkOffer`).
 */

import { UserError } from "rivetkit";
import type { RawAccess } from "rivetkit/db";
import { requireUser, serviceParams } from "../auth.js";
import { slackConfig } from "../config.js";
import type { LinkedAccount, LinkedAccounts, LinkOffer, LinkSurface } from "../contract.js";
import { gitlabApp, gitlabHost, gitlabTenant, issuerOf, openGitlabLinkTicket } from "../gitlab/connect.js";
import { jiraApp } from "../jira/app.js";
import { linearApp } from "../linear/app.js";
import { isActorGone, type ActorClient } from "./internal.js";
import { JIRA_TENANT, surfaceAccountsOf } from "./surface-accounts.js";
import { beginJiraLink, completeJiraLink } from "./user-jira.js";
import { beginLinearLink, completeLinearLink, type LinearCtx } from "./user-linear.js";
import { beginSlackLink, completeSlackLink } from "./user-slack.js";

export const IDENTITY_TABLES = [
	"CREATE TABLE IF NOT EXISTS identity_links (surface TEXT NOT NULL, tenant TEXT NOT NULL, PRIMARY KEY(surface, tenant))",
];

type Ctx = Parameters<typeof requireUser>[0] & { key: string[]; db: RawAccess; client(): ActorClient };
type Indexed = Exclude<LinkSurface, "gitlab">;
const SURFACES: readonly LinkSurface[] = ["slack", "linear", "jira", "gitlab"];
const badTicket = () =>
	new UserError("This link is not valid. Start again from where you were asked to link.", { code: "link_ticket" });
// Each surface's helpers run inside this same user actor, typed by the context their own module declares.
type JiraCtx = Parameters<typeof completeJiraLink>[0];
type SlackCtx = Parameters<typeof completeSlackLink>[0];
const SLACK_PRIVATE = /^slack\.(T[A-Z0-9]{1,32})\.([a-f0-9-]{36})$/;

/** Records that this user is linked in a tenant, after the directory linked them. */
async function remember(c: Pick<Ctx, "db">, surface: Indexed, tenant: string) {
	await c.db.execute("INSERT OR IGNORE INTO identity_links VALUES(?,?)", surface, tenant);
}

/** Links this user to a person the surface's own sign-in proved (connecting Jira or installing Slack proves it too). */
export async function linkProvenAccount(
	c: Pick<Ctx, "db" | "key" | "client">,
	surface: Indexed,
	tenant: string,
	person: { id: string; name: string },
	tenantName: string,
) {
	await surfaceAccountsOf(c, surface, tenant).internalLink(c.key[0]!, person.id, person.name, tenantName);
	await remember(c, surface, tenant);
}

const absentIfGone = <T>(read: Promise<T>) =>
	read.catch(error => {
		if (isActorGone(error)) return null;
		throw error;
	});

async function list(c: Ctx): Promise<LinkedAccounts> {
	const accounts: LinkedAccount[] = [];
	const rows = await c.db.execute<{ surface: Indexed; tenant: string }>(
		"SELECT surface, tenant FROM identity_links ORDER BY surface, tenant",
	);
	for (const { surface, tenant } of rows) {
		const link = await absentIfGone(surfaceAccountsOf(c, surface, tenant).internalLinkOf(c.key[0]!));
		if (link) accounts.push({ surface, tenant, tenantName: link.tenantName, name: link.name });
		else await c.db.execute("DELETE FROM identity_links WHERE surface=? AND tenant=?", surface, tenant);
	}
	const gitlab = gitlabApp();
	if (gitlab) {
		const tenant = gitlabTenant(gitlab);
		const link = await absentIfGone(surfaceAccountsOf(c, "gitlab", tenant).internalLinkOf(c.key[0]!));
		if (link) accounts.push({ surface: "gitlab", tenant, tenantName: gitlabHost(gitlab), name: link.name });
	}
	const signIn = SURFACES.filter(surface =>
		surface === "slack"
			? slackConfig()?.signIn === true
			: surface === "linear"
				? linearApp() !== null
				: surface === "jira"
					? jiraApp() !== null
					: gitlab !== null,
	);
	return { accounts, signIn };
}

/** Links the account a sign-in ticket proves. The ticket names its surface: `<surface>.<sealed>`. */
async function redeem(c: Ctx, ticket: string): Promise<LinkedAccount> {
	const uid = c.key[0]!;
	const slack = SLACK_PRIVATE.exec(ticket);
	if (slack) {
		const [, team, proof] = slack;
		await surfaceAccountsOf(c, "slack", team!).internalRedeem(uid, proof!);
		await remember(c, "slack", team!);
		return linkedIn(c, "slack", team!);
	}
	const dot = ticket.indexOf(".");
	const kind = ticket.slice(0, dot),
		sealed = ticket.slice(dot + 1);
	if (kind === "slack-signin") {
		const person = await completeSlackLink(c as unknown as SlackCtx, sealed);
		if (!person) throw badTicket();
		await linkProvenAccount(c, "slack", person.teamId, { id: person.userId, name: person.name }, person.teamName);
		return linkedIn(c, "slack", person.teamId);
	}
	if (kind === "linear") {
		const proven = await completeLinearLink(c as unknown as LinearCtx, sealed);
		if (!proven) throw badTicket();
		await linkProvenAccount(c, "linear", proven.workspace.id, proven.person, proven.workspace.name);
		return linkedIn(c, "linear", proven.workspace.id);
	}
	if (kind === "jira") {
		const person = await completeJiraLink(c as unknown as JiraCtx, sealed);
		if (!person) throw badTicket();
		await linkProvenAccount(c, "jira", JIRA_TENANT, person, "Atlassian");
		return linkedIn(c, "jira", JIRA_TENANT);
	}
	if (kind === "gitlab") {
		const app = gitlabApp();
		let proven;
		try {
			proven = openGitlabLinkTicket(uid, sealed);
		} catch {
			throw badTicket();
		}
		if (!app || proven.issuer !== issuerOf(app)) throw badTicket();
		const tenant = gitlabTenant(app);
		await surfaceAccountsOf(c, "gitlab", tenant).internalLink(
			uid,
			proven.viewerId,
			`@${proven.login}`,
			gitlabHost(app),
		);
		return linkedIn(c, "gitlab", tenant);
	}
	throw badTicket();
}

async function linkedIn(c: Ctx, surface: LinkSurface, tenant: string): Promise<LinkedAccount> {
	const link = await surfaceAccountsOf(c, surface, tenant).internalLinkOf(c.key[0]!);
	if (!link) throw badTicket();
	return { surface, tenant, tenantName: link.tenantName, name: link.name };
}

export const linkedAccountActions = {
	linkedAccounts: (c: Ctx) => {
		requireUser(c);
		return list(c);
	},
	linkAccount: async (c: Ctx, ticket: string): Promise<LinkedAccounts & { linked: LinkedAccount }> => {
		requireUser(c);
		if (typeof ticket !== "string" || ticket.length > 8192) throw badTicket();
		const linked = await redeem(c, ticket);
		return { linked, ...(await list(c)) };
	},
	linkOffer: async (c: Ctx, ticket: string): Promise<LinkOffer> => {
		requireUser(c);
		const slack = typeof ticket === "string" ? SLACK_PRIVATE.exec(ticket) : null;
		if (!slack) throw badTicket();
		const offered = await absentIfGone(surfaceAccountsOf(c, "slack", slack[1]!).internalPeek(slack[2]!));
		if (!offered) throw badTicket();
		return { surface: "slack", tenantName: offered.tenantName, name: offered.name || offered.externalId };
	},
	linkAccountStart: (c: Ctx, input: { surface: LinkSurface; origin: string }): Promise<{ url: string }> => {
		requireUser(c);
		const origin = typeof input?.origin === "string" ? input.origin : "";
		switch (input?.surface) {
			case "slack":
				return beginSlackLink(c as unknown as SlackCtx, origin);
			case "linear":
				return beginLinearLink(c as unknown as LinearCtx, { origin });
			case "jira":
				return beginJiraLink(c as unknown as JiraCtx, origin);
			case "gitlab":
				if (!gitlabApp()) throw new UserError("GitLab is not configured.", { code: "gitlab_off" });
				return c.client().userGitlab.getOrCreate([c.key[0]!], { params: serviceParams() }).internalLinkStart(origin);
			default:
				throw new UserError("Choose an account to link.", { code: "bad_input" });
		}
	},
	unlinkAccount: async (c: Ctx, input: { surface: LinkSurface; tenant: string }): Promise<LinkedAccounts> => {
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
