import { randomUUID } from "node:crypto";
import { UserError } from "rivetkit";
import type { RawAccess } from "rivetkit/db";
import { requireUser, serviceParams } from "../auth.js";
import { config, slackConfig } from "../config.js";
import type { GithubId, SlackChannel, SlackIdentity, SlackStatus } from "../contract.js";
import { githubApp } from "../github/app.js";
import { resolveRepository, type StoredConnection } from "../github/repos.js";
import { sealSecret } from "../repo-secrets.js";
import { serverSealer } from "../signin/seal.js";
import { exchangeCode } from "../slack/app.js";
import { authorizeSlack } from "../slack/connect.js";

import { type ActorClient, isActorGone } from "./internal.js";

export const SLACK_TABLES = [
	"CREATE TABLE IF NOT EXISTS slack_connect (id INTEGER PRIMARY KEY CHECK(id=1), nonce TEXT, expires INTEGER)",
	"CREATE TABLE IF NOT EXISTS slack_owner (id INTEGER PRIMARY KEY CHECK(id=1), team TEXT)",
	"CREATE TABLE IF NOT EXISTS slack_links (team TEXT PRIMARY KEY)",
];
type Ctx = Parameters<typeof requireUser>[0] & {
	key: string[];
	db: RawAccess;
	vars: { github: StoredConnection | null };
	client(): ActorClient;
};
const queues = new WeakMap<object, Promise<unknown>>();
function action<A extends unknown[], R>(fn: (c: Ctx, ...args: A) => Promise<R>) {
	return (c: Ctx, ...args: A) => {
		requireUser(c);
		const next = (queues.get(c.vars) ?? Promise.resolve()).then(() => fn(c, ...args));
		queues.set(
			c.vars,
			next.catch(() => {}),
		);
		return next;
	};
}
function workspace(c: Ctx, team: string) {
	return c.client().slackWorkspace.get([team], { params: serviceParams() });
}
async function owner(c: Ctx) {
	const [row] = await c.db.execute<{ team: string }>("SELECT team FROM slack_owner");
	if (!row) throw new UserError("Connect a Slack workspace first.", { code: "slack_not_connected" });
	return workspace(c, row.team);
}
async function ifPresent<T>(read: Promise<T>): Promise<T | null> {
	try {
		return await read;
	} catch (error) {
		if (isActorGone(error)) return null;
		throw error;
	}
}
async function status(c: Ctx): Promise<SlackStatus> {
	if (!slackConfig()) return { state: "off" };
	const links: SlackIdentity[] = [];
	for (const { team } of await c.db.execute<{ team: string }>("SELECT team FROM slack_links")) {
		const workspaceName = await ifPresent<string>(workspace(c, team).internalLinked(c.key[0]));
		if (workspaceName) links.push({ teamId: team, workspaceName });
		else await c.db.execute("DELETE FROM slack_links WHERE team=?", team);
	}
	const [row] = await c.db.execute<{ team: string }>("SELECT team FROM slack_owner");
	if (row) {
		const view = await ifPresent<Pick<Extract<SlackStatus, { state: "connected" }>, "workspaceName" | "mappings">>(
			workspace(c, row.team).internalView(c.key[0]),
		);
		if (view) return { state: "connected", ...view, links };
		await c.db.execute("DELETE FROM slack_owner");
	}
	return { state: "disconnected", links };
}

export const slackSettingsActions = {
	slack: action(status),
	slackConnect: action(async (c, { origin }: { origin: string }) => {
		if (!config.origins.includes(origin))
			throw new UserError("Connect from Windlass Settings.", { code: "origin_not_allowed" });
		const nonce = randomUUID();
		await c.db.execute("INSERT OR REPLACE INTO slack_connect VALUES(1,?,?)", nonce, Date.now() + 600_000);
		return authorizeSlack(c.key[0], nonce, origin);
	}),
	slackComplete: action(async (c, ticket: string) => {
		const uid = c.key[0],
			invalid = () => new UserError("Start a new Slack connection.", { code: "slack_ticket" });
		let grant: { nonce: string; code: string };
		try {
			grant = JSON.parse(serverSealer().open("transit", `slack-code:${uid}`, ticket));
		} catch {
			throw invalid();
		}
		if (
			!(
				await c.db.execute(
					"DELETE FROM slack_connect WHERE nonce=? AND expires>? RETURNING id",
					grant.nonce,
					Date.now(),
				)
			).length
		)
			throw invalid();
		if ((await status(c)).state === "connected")
			throw new UserError("Disconnect your workspace first.", { code: "slack_connected" });
		const { teamId, name, bot, token } = await exchangeCode(grant.code);
		const ws = c.client().slackWorkspace.getOrCreate([teamId], { params: serviceParams() });
		const sealed = sealSecret(serverSealer(), uid, `slack:${teamId}`, "bot", token);
		await c.db.execute("INSERT OR REPLACE INTO slack_owner VALUES(1,?)", teamId);
		await ws.internalInstall({ owner: uid, name, bot, sealed });
		return status(c);
	}),
	slackChannels: action(async (c): Promise<SlackChannel[]> => (await owner(c)).internalChannels(c.key[0])),
	saveSlackMapping: action(async (c, input: { channelId: string; repositoryId: GithubId }) => {
		const ws = await owner(c),
			app = githubApp(),
			connection = c.vars.github;
		if (!connection || !app) throw new UserError("Connect GitHub first.", { code: "github_not_connected" });
		const {
			id,
			owner: login,
			name,
			private: hidden,
		} = (await resolveRepository(app, connection, input.repositoryId, "write")).described;
		// A private repository's plans stay out of the channel until the owner allows them.
		await ws.internalMap(c.key[0], input.channelId, { id, owner: login, name }, !hidden);
		return status(c);
	}),
	setSlackDetails: action(async (c, input: { channelId: string; details: boolean }) => {
		await (await owner(c)).internalDetails(c.key[0], input.channelId, input.details === true);
		return status(c);
	}),
	removeSlackMapping: action(async (c, id: string) => {
		await (await owner(c)).internalMap(c.key[0], id, null);
		return status(c);
	}),
	disconnectSlack: action(async c => {
		await (await owner(c)).internalDisconnect(c.key[0]);
		await c.db.execute("DELETE FROM slack_owner");
		await c.db.execute("DELETE FROM slack_connect");
		return status(c);
	}),
	linkSlack: action(async (c, ticket: string) => {
		const parts = /^(T[A-Z0-9]+)\.([a-f0-9-]{36})$/.exec(ticket);
		if (!parts) throw new UserError("Invalid Slack link.", { code: "slack_proof" });
		const [, team, proof] = parts;
		await c.db.execute("INSERT OR IGNORE INTO slack_links VALUES(?)", team);
		await workspace(c, team).internalLink(c.key[0], proof);
		return status(c);
	}),
	unlinkSlack: action(async (c, team: string) => {
		await workspace(c, team).internalUnlink(c.key[0]);
		await c.db.execute("DELETE FROM slack_links WHERE team=?", team);
		return status(c);
	}),
};
