import { randomUUID } from "node:crypto";
import { actor, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { internalConnection, requireServiceFor } from "../auth.js";
import { config } from "../config.js";
import { MAX_NOTE_CHARS, type SlackMapping } from "../contract.js";
import { openSecret } from "../repo-secrets.js";
import { serverSealer } from "../signin/seal.js";
import {
	isJoinedChannel,
	listChannels,
	openView,
	postMessage,
	postPrivate,
	revoke,
	updateMessage,
} from "../slack/app.js";
import { APPROVALS } from "../factory/feature-plan.js";
import { escapeText, revisionModal, type SlackMessage, type SlackPost } from "../slack/blocks.js";
import type { SlackInteraction } from "../slack/interactions.js";
import type { SlackDelivery } from "../slack/webhook.js";
import { type ActorClient, userActor } from "./internal.js";
import { resolveFiler } from "./issue-intake.js";
import { surfaceAccountsOf } from "./surface-accounts.js";

type Install = { owner: string; name: string; bot: string; sealed: string };
type Mapping = { id: string; name: string; repository: string; generation: string; details: number };
/** The thread an item posts into, recorded with its first message. */
type Thread = { uid: string; item: string; generation: string };
type Ctx = { db: RawAccess; key: string[]; vars: { queue: Promise<unknown> }; client(): ActorClient };
const unavailable = () => new UserError("This Slack connection is no longer available.", { code: "slack_unavailable" });

function serial<T>(c: Ctx, work: () => Promise<T>) {
	const run = c.vars.queue.then(work);
	c.vars.queue = run.catch(() => {});
	return run;
}
async function install(c: Ctx, owner?: string) {
	const [row] = await c.db.execute<Install>("SELECT * FROM install");
	if (!row || (owner && row.owner !== owner)) throw unavailable();
	return row;
}
function token(c: Ctx, row: Install) {
	return openSecret(serverSealer(), row.owner, `slack:${c.key[0]}`, "bot", row.sealed);
}

const route = "SELECT m.generation, m.repository FROM mapping m, install WHERE m.id=? AND install.bot<>?";
type Route = { generation: string; repository: string };
/** The Windlass user a Slack member linked (surface-accounts.ts), or null. */
const memberOf = async (c: Ctx, userId: string) => (await resolveFiler(c, "slack", c.key[0]!, userId))?.uid ?? null;
const itemUrl = (item: string) => `${config.origins[0]}/items/${item}`;

// A mention in an item's thread never files new work. Its owner may answer the open question by a choice's label.
async function reply(c: Ctx, bearer: string, d: SlackDelivery, thread: Thread, uid: string | null) {
	const say = (text: string) => postPrivate(bearer, d.channelId, d.userId, text, d.threadTs);
	if (uid === thread.uid) {
		const answer = await userActor(c, uid).internalSlackReply({ id: thread.item, text: d.text, slackUser: d.userId });
		if (answer.kind === "answered") return;
		if (answer.kind === "choices")
			return say(
				`Reply with one of: ${answer.labels.map(escapeText).join(", ")}. Or answer in Windlass: ${itemUrl(thread.item)}`,
			);
	}
	await say(`Replies in this thread don't file new work. Open the item: ${itemUrl(thread.item)}`);
}

async function deliver(c: Ctx, d: SlackDelivery, generation: string, uid: string | null) {
	const [current] = await c.db.execute<Route>(route, d.channelId, d.userId);
	if (!current || current.generation !== generation || (await memberOf(c, d.userId)) !== uid) return;
	const row = await install(c);
	const bearer = token(c, row);
	// Slash commands also reach channels the bot has left since the mapping was saved.
	if (d.deliveryId.startsWith("command:") && !(await isJoinedChannel(bearer, d.channelId))) return;
	const [thread] = d.threadTs
		? await c.db.execute<Thread>(
				"SELECT uid, item, generation FROM thread WHERE channel=? AND ts=?",
				d.channelId,
				d.threadTs,
			)
		: [];
	if (thread) return reply(c, bearer, d, thread, thread.generation === generation ? uid : null);
	if (!uid) {
		// Sent privately: only this member can open it, which is what proves the Slack account is theirs.
		const proof = await surfaceAccountsOf(c, "slack", c.key[0]!).internalOffer(d.userId, "", row.name);
		await postPrivate(
			bearer,
			d.channelId,
			d.userId,
			`Link your Windlass account, then try again: ${config.origins[0]}/settings#link=slack.${c.key[0]}.${proof}`,
		);
		return;
	}
	const repository: SlackMapping["repository"] = JSON.parse(current.repository);
	const filer = { surface: "slack", externalUserId: d.userId, verified: true };
	const result = await userActor(c, uid).internalSlackIntake({ delivery: d, repository, generation, filer });
	if (result.kind === "refused") await postPrivate(bearer, d.channelId, d.userId, result.reason);
}

/**
 * Who may act on an item's buttons: the Slack member linked to the item's owner, while the mapping that filed it stands.
 * Resolved from our own tables. The payload contributes only the signed Slack user id and the item it names.
 */
async function authorize(
	c: Ctx,
	a: SlackInteraction,
): Promise<{ bearer: string; owner: string | null; refusal: string | null }> {
	const bearer = token(c, await install(c));
	const [thread] = await c.db.execute<Thread>(
		`SELECT t.uid, t.item, t.generation FROM thread t JOIN mapping m ON m.id=t.channel AND m.generation=t.generation
		WHERE t.channel=? AND t.item=?`,
		a.channelId,
		a.value.i,
	);
	if (!thread)
		return {
			bearer,
			owner: null,
			refusal: `This item no longer posts to this channel. Open it in Windlass: ${itemUrl(a.value.i)}`,
		};
	if ((await memberOf(c, a.userId)) === thread.uid) return { bearer, owner: thread.uid, refusal: null };
	const owner = await surfaceAccountsOf(c, "slack", c.key[0]!).internalLinkOf(thread.uid);
	const who = owner ? `<@${owner.externalUserId}>` : "the person who filed this item";
	return { bearer, owner: null, refusal: `Only ${who} can ${APPROVALS.has(a.value.c) ? "approve" : "answer"} this.` };
}

async function interact(c: Ctx, a: SlackInteraction) {
	const { bearer, owner, refusal } = await authorize(c, a);
	const say = (text: string) => postPrivate(bearer, a.channelId, a.userId, text);
	if (!owner) return say(refusal!);
	try {
		await userActor(c, owner).internalSlackAct({
			id: a.value.i,
			question: a.value.q,
			choice: a.value.c,
			version: a.value.v,
			note: a.note,
			slackUser: a.userId,
		});
	} catch (error) {
		// Refusals carry our own wording. Anything else is retried by the inbox.
		const { code, message } = error as { code?: string; message?: string };
		if (!code || !["item_conflict", "bad_input", "item_not_found", "items_off"].includes(code)) throw error;
		await say(`${message} Open the item: ${itemUrl(a.value.i)}`);
	}
}

export const slackWorkspace = actor({
	onBeforeConnect: internalConnection,
	db: db({
		onMigrate: async db => {
			await db.execute(
				"CREATE TABLE IF NOT EXISTS install (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, name TEXT, bot TEXT, sealed TEXT)",
			);
			await db.execute(
				"CREATE TABLE IF NOT EXISTS mapping (id TEXT PRIMARY KEY, name TEXT, repository TEXT, generation TEXT, details INTEGER NOT NULL DEFAULT 0)",
			);
			await db.execute(
				"CREATE TABLE IF NOT EXISTS thread (channel TEXT, ts TEXT, uid TEXT, item TEXT, generation TEXT, PRIMARY KEY(channel, ts))",
			);
			await db.execute(
				"CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, received INTEGER, payload TEXT, generation TEXT, uid TEXT, attempts INTEGER DEFAULT 0)",
			);
		},
	}),
	createVars: () => ({ queue: Promise.resolve() as Promise<unknown> }),
	actions: {
		async internalInstall(c, row: Install) {
			requireServiceFor(c, "call");
			const saved = await c.db.execute(
				"INSERT INTO install VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,bot=excluded.bot,sealed=excluded.sealed WHERE owner=excluded.owner RETURNING id",
				row.owner,
				row.name,
				row.bot,
				row.sealed,
			);
			if (!saved.length)
				throw new UserError("Another Windlass account manages this workspace.", { code: "slack_owner" });
		},
		async internalView(c, uid: string) {
			requireServiceFor(c, "call");
			const [row] = await c.db.execute<Install>("SELECT * FROM install WHERE owner=?", uid);
			if (!row) return null;
			const mappings = await c.db.execute<Mapping>("SELECT * FROM mapping ORDER BY name");
			return {
				workspaceName: row.name,
				mappings: mappings.map(m => ({
					channel: { id: m.id, name: m.name },
					repository: JSON.parse(m.repository) as SlackMapping["repository"],
					details: m.details === 1,
				})),
			};
		},
		async internalChannels(c, uid: string) {
			requireServiceFor(c, "call");
			return listChannels(token(c, await install(c, uid)));
		},
		/** `details`: post plan and question content, not only links. */
		async internalMap(c, uid: string, id: string, repository: SlackMapping["repository"] | null, details = false) {
			requireServiceFor(c, "call");
			await serial(c, async () => {
				const row = await install(c, uid);
				if (!repository) {
					await c.db.execute("DELETE FROM mapping WHERE id=?", id);
					return;
				}
				const channel = (await listChannels(token(c, row))).find(channel => channel.id === id);
				if (!channel) throw unavailable();
				await c.db.execute(
					"INSERT OR REPLACE INTO mapping VALUES(?,?,?,?,?)",
					id,
					channel.name,
					JSON.stringify(repository),
					randomUUID(),
					details ? 1 : 0,
				);
			});
		},
		async internalDetails(c, uid: string, id: string, details: boolean) {
			requireServiceFor(c, "call");
			await serial(c, async () => {
				await install(c, uid);
				if (!(await c.db.execute("UPDATE mapping SET details=? WHERE id=? RETURNING id", details ? 1 : 0, id)).length)
					throw unavailable();
			});
		},
		async internalDisconnect(c, uid: string) {
			requireServiceFor(c, "call");
			await serial(c, async () => {
				const row = await install(c, uid);
				await c.db.transaction(async tx => {
					for (const table of ["install", "mapping", "thread"]) await tx.execute(`DELETE FROM ${table}`);
					await tx.execute("UPDATE inbox SET payload=NULL,uid=NULL");
				});
				await surfaceAccountsOf(c, "slack", c.key[0]!).internalClear();
				await revoke(token(c, row)).catch(() => {}); // Local disconnect also works with a revoked token.
			});
		},
		async internalReceive(c, d: SlackDelivery) {
			requireServiceFor(c, "call");
			// Snapshot authority in the same write as the dedupe key. A retry number identifies an attempt, not a request.
			await c.db.execute("DELETE FROM inbox WHERE received<?", Date.now() - 7 * 86_400_000);
			const uid = await memberOf(c, d.userId);
			await c.db.transaction(async tx => {
				const [current] = await tx.execute<Route>(route, d.channelId, d.userId);
				const payload = current ? JSON.stringify(uid ? d : { ...d, text: "" }) : null;
				await tx.execute(
					"INSERT OR IGNORE INTO inbox(id,received,payload,generation,uid) VALUES(?,?,?,?,?)",
					d.deliveryId,
					Date.now(),
					payload,
					current?.generation ?? null,
					current ? uid : null,
				);
			});
			if ((await c.db.execute("SELECT 1 FROM inbox WHERE id=? AND payload IS NOT NULL", d.deliveryId)).length)
				await c.schedule.after(0, "internalDeliver", d.deliveryId);
		},
		async internalDeliver(c, id: string) {
			if (!c.scheduledFire) throw unavailable();
			await serial(c, async () => {
				const [row] = await c.db.execute<{ payload: string; generation: string; uid: string | null; attempts: number }>(
					"UPDATE inbox SET attempts=attempts+1 WHERE id=? AND payload IS NOT NULL RETURNING *",
					id,
				);
				if (!row) return;
				// Arm the retry before contacting another actor. Its idempotency key survives a lost reply.
				const retry = await c.schedule.after(
					Math.min(1800_000, 15_000 * 2 ** Math.min(row.attempts - 1, 7)),
					"internalDeliver",
					id,
				);
				const payload = JSON.parse(row.payload);
				try {
					await ("deliveryId" in payload ? deliver(c, payload, row.generation, row.uid) : interact(c, payload));
				} catch (error) {
					if (row.attempts < 8 && (error as { code?: string }).code !== "slack_unavailable") return;
					c.log.warn({ msg: "Slack filing could not be delivered", attempts: row.attempts });
				}
				await c.db.execute("UPDATE inbox SET payload=NULL,uid=NULL WHERE id=?", id);
				await c.schedule.cancel(retry);
			});
		},
		async internalInteract(c, a: SlackInteraction) {
			requireServiceFor(c, "call");
			if (a.value.c === "revise" && a.note === undefined) {
				// The modal must open within three seconds of the press. Opening it changes nothing.
				const { bearer, owner, refusal } = await authorize(c, a);
				if (!owner) await postPrivate(bearer, a.channelId, a.userId, refusal!);
				else await openView(bearer, a.trigger, revisionModal({ ...a.value, ch: a.channelId }, MAX_NOTE_CHARS));
				return;
			}
			await c.db.execute("DELETE FROM inbox WHERE received<?", Date.now() - 7 * 86_400_000);
			const saved = await c.db.execute(
				"INSERT OR IGNORE INTO inbox(id,received,payload) VALUES(?,?,?) RETURNING id",
				a.id,
				Date.now(),
				JSON.stringify(a),
			);
			if (saved.length) await c.schedule.after(0, "internalDeliver", a.id);
		},
		/** `item` owns the thread this message starts or joins. */
		async internalPost(
			c,
			channel: string,
			generation: string,
			post: SlackPost,
			threadTs: string | null,
			item: { uid: string; id: string },
		) {
			requireServiceFor(c, "call");
			return serial(c, async () => {
				const row = await install(c);
				const [mapping] = await c.db.execute<{ details: number }>(
					"SELECT details FROM mapping WHERE id=? AND generation=?",
					channel,
					generation,
				);
				if (!mapping) throw unavailable();
				const ts = await postMessage(
					token(c, row),
					channel,
					mapping.details === 1 && post.full ? post.full : post.brief,
					threadTs,
				);
				await c.db.execute(
					"INSERT OR IGNORE INTO thread VALUES(?,?,?,?,?)",
					channel,
					threadTs ?? ts,
					item.uid,
					item.id,
					generation,
				);
				return ts;
			});
		},
		async internalUpdate(c, channel: string, generation: string, ts: string, message: SlackMessage) {
			requireServiceFor(c, "call");
			await serial(c, async () => {
				const row = await install(c);
				if (!(await c.db.execute("SELECT 1 FROM mapping WHERE id=? AND generation=?", channel, generation)).length)
					throw unavailable();
				await updateMessage(token(c, row), channel, ts, message);
			});
		},
	},
});
