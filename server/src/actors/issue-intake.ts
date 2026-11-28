/**
 * GitHub, GitLab, Linear, Jira and Slack share one user queue, daily cap and reservation table.
 * Each intake keeps its permission checks, delivery identity and item binding separate.
 */

import { createHash } from "node:crypto";
import { gitlabApp } from "../gitlab/connect.js";
import { GitlabError, record, text } from "../gitlab/app.js";
import { gitlabCodeHost } from "../gitlab/host.js";
import { decimalId } from "../gitlab/ids.js";
import type { GitlabDelivery } from "../gitlab/webhook.js";
import { serviceParams } from "../auth.js";
import type { JiraReservation } from "./jira-site.js";
import { mayUse } from "../access.js";
import { config } from "../config.js";
import type { CreateItemInput, GithubId, ItemSummary, UserProfile } from "../contract.js";
import {
	issueMode,
	linearIdentifier,
	trackerId,
	trackerName,
	refusals,
	taskOfText,
	taskOfTracker,
	taskOfSlack,
	type GitlabBinding,
	type Intake,
	type JiraFiling,
	type SlackFiling,
	type SlackBinding,
	type LinearFiling,
	type TrackerFiled,
} from "../factory/intake.js";
import { untrustedWords } from "../factory/untrusted.js";
import { githubApp } from "../github/app.js";
import { isGithubId } from "../github/ids.js";
import { GithubProblem, problemOf, resolveBoundRepository, resolveRepository } from "../github/repos.js";
import { sourceCaps } from "../sources/registry.js";
import { SOURCE_IDS, type SourceId } from "../sources/types.js";
import { accountLimits } from "../user-limits.js";
import { gitlabAccess, isActorGone, itemActor } from "./internal.js";
import type { ItemsCtx, ItemsState } from "./user-items.js";

/** The sources of an item filed from an issue: the ones that share the queue, the cap and the reservations. */
export const INTAKE_SOURCES: ReadonlySet<ItemSummary["source"]> = new Set(SOURCE_IDS);

/** The in-memory scope of an issue-filed creation's key (`ItemsState.created`): apart from the web's and the API's, with one namespace for external intake (their keys differ in form). */
export const intakeScope = (key: string) => "intake:" + key;

const queues = new WeakMap<ItemsState, Promise<unknown>>();

/**
 * Runs a filing after every earlier one of this user's, whichever tracker it came from: all share the user's budget, so
 * the cap is read and the reservation made one filing at a time. A filing that fails does not hold up the next.
 */
export function inIntakeQueue<T>(c: ItemsCtx, job: () => Promise<T>): Promise<T> {
	const next = (queues.get(c.vars.items) ?? Promise.resolve()).then(job);
	queues.set(
		c.vars.items,
		next.catch(() => {}),
	);
	return next;
}

export async function existingItem(c: Pick<ItemsCtx, "client">, uid: string, id: string) {
	try {
		return await itemActor(c, uid, id).internalSummary();
	} catch (error) {
		if (!isActorGone(error) && (error as { code?: string })?.code !== "item_not_found") throw error;
	}
}

/**
 * The one cap on items filed from an issue: how many a day, all external intakes together, drafts among them. A flood of
 * labelled issues stops here. A filing interrupted after its key was reserved counts as filed (`github_item_keys` rows the
 * index does not have yet), and `resuming` is the id of one that is being finished, which the cap does not refuse again.
 */
export async function quotaRefusal(c: ItemsCtx, resuming?: string, from = "GitHub") {
	const filed = [...c.vars.items.items.values()].filter(i => INTAKE_SOURCES.has(i.source) && !i.parent);
	const midnight = Math.floor(Date.now() / 86_400_000) * 86_400_000;
	const { githubItemsPerDay } = accountLimits(c.vars.items.limits).factory;
	const unindexed = "FROM github_item_keys k WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.id=k.id)";
	const [pending] = await c.db.execute<{ count: number; reserved: number }>(
		`SELECT count(*) AS count, count(CASE WHEN id=? THEN 1 END) AS reserved ${unindexed} AND created_at >= ? AND created_at < ?`,
		resuming ?? null,
		midnight,
		midnight + 86_400_000,
	);
	if (
		!pending.reserved &&
		filed.filter(i => i.createdAt >= midnight && i.createdAt < midnight + 86_400_000).length + pending.count >=
			githubItemsPerDay
	)
		return refusals.daily(githubItemsPerDay, from);
	return null;
}

export function intakeInput(
	task: { title: string; body: string; acceptance: string[] },
	mode: "single" | "orchestrate",
	repository: { id: GithubId; branch: string },
	start: boolean,
	key: string,
): CreateItemInput {
	return { ...task, mode, repository, start, idempotencyKey: key };
}

export const isEnded = (item: Pick<ItemSummary, "state">) =>
	item.state === "done" || item.state === "failed" || item.state === "cancelled";

/** A GitLab issue's filings are keyed like the trackers': this base, then the generation. */
const gitlabBase = (projectId: string, iid: string) => `gitlab:${projectId}:${iid}:`;

/**
 * An issue's filings from the keys `<base><generation>`: those the index holds, and one the index does not yet (an
 * interrupted filing). `open` is the item still running, `resuming` an interrupted filing to finish, and `generation`
 * the one this filing takes: an ended item lets the issue be filed again.
 */
function filings(c: ItemsCtx, base: string) {
	const prefix = intakeScope(base);
	const made = [...c.vars.items.created].flatMap(([key, entry]) =>
		key.startsWith(prefix) && /^\d+$/.test(key.slice(prefix.length))
			? [{ generation: Number(key.slice(prefix.length)), id: entry.id }]
			: [],
	);
	const last = made.sort((a, b) => a.generation - b.generation).at(-1);
	const held = last && c.vars.items.items.get(last.id);
	const resuming = last && !held ? last : undefined;
	return {
		open: last && held && !isEnded(held) ? last.id : undefined,
		resuming,
		generation: resuming?.generation ?? (last?.generation ?? 0) + 1,
	};
}

export type SiteJiraFiling = JiraFiling & { plan: JiraReservation };
export async function fileTrackerIssue(
	c: ItemsCtx,
	f: LinearFiling | SiteJiraFiling,
	itemId: (uid: string, key: string) => string,
	file: (profile: UserProfile, input: CreateItemInput, source: SourceId, intake: Intake) => Promise<ItemSummary>,
): Promise<TrackerFiled> {
	const { profile } = c.vars,
		{ issue, trigger } = f;
	const jira = "project" in f ? f : null,
		sourceId: SourceId = jira ? "jira" : "linear",
		tracker = jira ? "Jira" : "Linear";
	if ("team" in f) {
		const { team, owner } = f;
		if (
			!(
				issue &&
				trigger &&
				team &&
				f.repository &&
				owner &&
				trackerId(issue.id) &&
				linearIdentifier(issue.identifier) &&
				trackerId(team.id) &&
				trackerId(team.workspaceId) &&
				trackerId(owner.linearUserId) &&
				isGithubId(f.repository.id) &&
				(trigger.via === "label" || trigger.via === "assignment") &&
				Number.isFinite(trigger.at) &&
				trackerId(trigger.sender?.id) &&
				typeof issue.title === "string" &&
				typeof issue.description === "string" &&
				Array.isArray(issue.labels) &&
				(issue.creator === null || (trackerId(issue.creator?.id) && typeof issue.creator.name === "string")) &&
				typeof issue.url === "string" &&
				/^https:\/\/[^\s/]+\//.test(issue.url)
			)
		)
			return { kind: "refused", reason: "The Linear issue was not well formed." };
	}
	const keyPrefix = jira ? `jira:${jira.project.siteId}:${issue.id}:` : `linear:${issue.id}:`;
	if (!profile || !mayUse(profile, config.access))
		return { kind: "ignored", why: "The owner may not use Windlass here." };
	if (issue.closed) return { kind: "ignored", why: `The issue is closed in ${tracker}.` };
	const uid = profile.uid;

	// The issue's earlier filings, from the keys; the Jira site actor has already chosen the generation.
	const prefix = intakeScope(keyPrefix);
	let generation = jira?.plan.generation ?? 1;
	if (!jira) {
		const found = filings(c, keyPrefix);
		if (found.open) return { kind: "exists", itemId: found.open };
		generation = found.generation;
	}
	const resuming = c.vars.items.created.get(prefix + generation);
	const indexed = resuming && c.vars.items.items.get(resuming.id);
	if (indexed) return { kind: "exists", itemId: indexed.id };
	if (trigger.lapsed && !resuming) return { kind: "ignored", why: "The issue no longer has what qualified it." };

	if (!config.items) return { kind: "refused", reason: refusals.off };
	const app = githubApp(),
		connection = c.vars.github;
	if (!app || !connection)
		return {
			kind: "refused",
			reason: "Not taken: GitHub is not connected, so there is no repository to file this on.",
		};
	let repository;
	try {
		repository = (await resolveRepository(app, connection, f.repository.id, "write")).repository;
	} catch (error) {
		// A GitHub that cannot answer is no refusal: the delivery fails and the tracker redelivers it.
		if (error instanceof GithubProblem && error.code !== "github_unreachable" && error.code !== "github_failed")
			return { kind: "refused", reason: "Not taken: " + error.message };
		throw error;
	}

	const labels = issue.labels
		.filter((label): label is string => typeof label === "string")
		.map(label => label.trim().toLowerCase());
	const bugType = jira?.issue.issueType.trim().toLowerCase() === "bug";
	if (bugType) labels.push("bug");
	const {
		mode,
		reason: modeReason,
		refusal,
	} = issueMode("", labels, process.env.WLP_FACTORY_ORCHESTRATE !== "0", sourceCaps(sourceId).quickLabels);
	const resumed = resuming && (await existingItem(c, uid, resuming.id));
	if (refusal) return { kind: "refused", reason: refusal };
	const cap = resumed ? null : await quotaRefusal(c, resuming?.id, tracker);
	if (cap) return { kind: "refused", reason: cap, dailyCap: true };

	const key = keyPrefix + generation;
	const trusted = "owner" in f && issue.creator?.id === f.owner.linearUserId;
	const author = trackerName(issue.creator?.name),
		sender = trackerName(trigger.sender.name);
	const { task } = taskOfTracker({ ...issue, body: issue.description, author, trusted }, tracker);
	const source = { id: issue.id, identifier: issue.identifier, url: issue.url, author };
	const fields = {
		modeReason: bugType ? "This is a Jira bug, so it runs in Quick mode without a plan." : modeReason,
		generation,
		via: trigger.via,
		triggeredAt: trigger.at,
		senderId: trigger.sender.id,
	};
	const input = intakeInput(task, mode, { id: repository.id, branch: repository.defaultBranch }, trusted, key);
	let intake: Intake;
	if ("project" in f) {
		const site = c.client().jiraSite.get([f.project.siteId], { params: serviceParams() });
		await site.internalReserveIssue(uid, issue.id, itemId(uid, key), f.plan);
		intake = {
			jira: {
				...fields,
				siteId: f.project.siteId,
				projectId: f.project.id,
				origin: { jira: { ...source, trusted: false }, sender },
			},
		};
	} else
		intake = {
			linear: {
				...fields,
				workspaceId: f.team.workspaceId,
				teamId: f.team.id,
				origin: { linear: { ...source, trusted }, sender },
			},
		};
	const item = await file(profile, input, sourceId, intake);
	return { kind: "filed", itemId: item.id, state: item.state };
}

/** The sources of a turn's text that a Linear item carries when its issue is someone else's. */
export const linearSources = (origin: { linear: { identifier: string; author: string; trusted: boolean } }) =>
	origin.linear.trusted ? [] : [untrustedWords.source("linear", origin.linear.identifier, origin.linear.author)];

export type GitlabTrigger = Extract<GitlabDelivery, { event: "issue" | "note" }>;

/** A hook identifies the subject; only the selected project's current issue and note supply task text. */
export async function fileGitlabIssue(
	c: ItemsCtx,
	delivery: GitlabTrigger,
	file: (profile: UserProfile, input: CreateItemInput, binding: GitlabBinding) => Promise<ItemSummary>,
): Promise<string | null> {
	const profile = c.vars.profile,
		app = gitlabApp();
	if (!profile || !mayUse(profile, config.access) || !config.items || !app) return null;
	const projectId = decimalId(delivery.projectId),
		iid = decimalId(delivery.iid);
	if (!projectId || !iid) return null;
	const { project, token, viewer } = await gitlabAccess(c, profile.uid, projectId);
	if (viewer !== delivery.senderId) return null;
	const path = `/projects/${projectId}/issues/${iid}`;
	const get = async (path: string) => {
		try {
			return record((await app.call({ path, token })).body);
		} catch (e) {
			if (e instanceof GitlabError && e.status === 404) return null;
			throw e;
		}
	};
	const issue = await get(path);
	if (!issue || issue.state !== "opened" || decimalId(issue.iid) !== iid || decimalId(issue.project_id) !== projectId)
		return null;
	const { open, resuming, generation } = filings(c, gitlabBase(projectId, iid));
	if (open) return open;
	const key = gitlabBase(projectId, iid) + generation;
	const sources = [untrustedWords.source("gitlab", `#${iid}`)];
	let body = text(issue.description);
	if (delivery.event === "note") {
		const noteId = decimalId(delivery.noteId);
		if (!noteId) return null;
		const note = await get(`${path}/notes/${noteId}`);
		if (
			!note ||
			decimalId(note.id) !== noteId ||
			note.system ||
			decimalId(record(note.author).id) !== viewer ||
			!/^\/windlass(?:\s|$)/.test(text(note.body))
		)
			return null;
		const words = text(note.body).slice("/windlass".length).trim();
		if (/^feature(?:\s|$)/i.test(words)) return null;
		if (words) {
			body += `\n\nGitLab note:\n${words}`;
			sources.push(untrustedWords.gitlabNote(noteId));
		}
	} else if (!Array.isArray(issue.labels) || !issue.labels.includes("windlass")) return null;
	if (await quotaRefusal(c, resuming?.id, "GitLab")) return null;
	const author = record(issue.author);
	const { task } = taskOfText({
		title: text(issue.title),
		body,
		fallbackTitle: `Issue #${iid}`,
		from: `From GitLab issue #${iid}. ${project.url}/-/issues/${iid}`,
		by: trackerName(author.username),
		tracker: "GitLab",
		trusted: false,
		note: "",
	});
	const input = intakeInput(task, "single", project, decimalId(author.id) === viewer, key);
	const item = await file(profile, input, { project, iid, generation, sources });
	// Acknowledgement is best effort: failure to react must never undo a successful filing.
	const host = gitlabCodeHost(app, { id: viewer, project, accessToken: async () => token });
	await host
		.react(
			token,
			project,
			delivery.event === "note"
				? { kind: "issue_comment", id: `${iid}:${delivery.noteId}` }
				: { kind: "issue", id: iid },
			"eyes",
		)
		.catch(() => undefined);
	return item.id;
}

/** A signed request is one filing forever, even after the item ends. Called in the linked user's intake queue. */
export async function fileSlackRequest(
	c: ItemsCtx,
	f: SlackFiling,
	file: (profile: UserProfile, filing: { input: CreateItemInput; binding: SlackBinding }) => Promise<ItemSummary>,
): Promise<TrackerFiled> {
	const { profile, github: connection } = c.vars;
	if (!profile || !mayUse(profile, config.access))
		return { kind: "refused", reason: "This account cannot file work items here." };
	if (!config.items) return { kind: "refused", reason: refusals.off };
	const d = f.delivery;
	const parsed = taskOfSlack(d.text);
	if (!parsed) return { kind: "refused", reason: "Include a description of the work to file." };
	const app = githubApp();
	if (!app || !connection) return { kind: "refused", reason: "Connect GitHub in Windlass Settings to file here." };
	let repository;
	try {
		const { installation } = await resolveRepository(app, connection, f.repository.id, "read");
		// Discovery may be cached. Verify current access to the mapped repository before starting work.
		repository = (await resolveBoundRepository(app, connection, f.repository.id, installation.id, "write")).repository;
	} catch (error) {
		const failure = problemOf(error, connection.user.login);
		if (failure.code === "github_failed" || failure.code === "github_unreachable") throw failure;
		return { kind: "refused", reason: "Your GitHub account needs write access to the mapped repository." };
	}
	const key = "slack:" + createHash("sha256").update(`${d.teamId}:${d.deliveryId}`).digest("hex");
	const held = c.vars.items.created.get(intakeScope(key));
	if (held && c.vars.items.items.has(held.id)) return { kind: "exists", itemId: held.id };
	const resumed = held && (await existingItem(c, profile.uid, held.id));
	const cap = !resumed && (await quotaRefusal(c, held?.id, "Slack"));
	if (cap) return { kind: "refused", reason: cap, dailyCap: true };
	const mode = issueMode(parsed.quick ? "quick" : "", [], process.env.WLP_FACTORY_ORCHESTRATE !== "0");
	const input = intakeInput(parsed.task, mode.mode, { id: repository.id, branch: repository.defaultBranch }, true, key);
	const binding = { teamId: d.teamId, channelId: d.channelId, threadTs: d.threadTs, generation: f.generation };
	const item = await file(profile, { input, binding });
	return { kind: "filed", itemId: item.id, state: item.state };
}
