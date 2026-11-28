/**
 * The repository as the place a user's agents are gathered under: how the list of agents is grouped,
 * how much of a long group is shown, which pull requests a repository's page lists, and what a new
 * agent starts with: its user's choice, then its repository's default, then the account's and deployment's defaults.
 *
 * Everything here is worked out from what the web app already holds: the summaries of the user's
 * sessions, as their actor broadcasts them, the deployment's own information, and the user's models.
 * Nothing is asked of GitHub or of a sandbox to draw a list.
 */
import {
	MAX_TITLE_CHARS,
	type AccountDefaults,
	type GithubId,
	type ItemFeed,
	type ItemSummary,
	type ModelList,
	type PlatformInfo,
	type PullRequestInfo,
	type RepoAddress,
	type SandboxProfileId,
	type SessionRepository,
	type SessionSummary,
} from "@contract";
import { keyOf } from "../../../server/src/codehost/ref.js";

// ---- the user's own agents, and the sessions of their work items -------------------------------------

/**
 * The user's own agents: their sessions that are not a work item's. Each work item has a session of
 * its own among the user's sessions (`SessionSummary.item`); it is part of its item, and is reached
 * from the item's row and page, so no list of agents shows it a second time.
 */
export const ownAgents = (sessions: readonly SessionSummary[]): SessionSummary[] =>
	sessions.filter(session => session.item === undefined);

/**
 * What is at work, in the parts the home page names. `ceilinged` is what the server counts against
 * the ceiling on running turns (`FactoryLimits.runningTurns`, server/src/actors/user.ts,
 * `internalAcquireRun`): the user's own agents at work on this platform's sandboxes, and every work
 * item's turn wherever it runs. `items` is how many of those are work items'. `onMachines`: the user's
 * own agents at work on their machines, which are not counted against it.
 */
export function workingCounts(sessions: readonly SessionSummary[]): {
	ceilinged: number;
	items: number;
	onMachines: number;
} {
	let ceilinged = 0;
	let items = 0;
	let onMachines = 0;
	for (const session of sessions) {
		if (session.status === "idle" && (!session.item?.reviewer || session.item.reviewer.status === "idle")) continue;
		// The ceiling is on hosted sandboxes only: whatever runs on the user's machines, item or not, is theirs to bound.
		if (session.place.kind === "machine") onMachines += 1;
		else {
			ceilinged += 1;
			if (session.item !== undefined) items += 1;
		}
	}
	return { ceilinged, items, onMachines };
}

/** "3 of 6 working, 2 of them work items": what `workingCounts` counts against the ceiling, said of the whole when it is known. */
export function workingWords(
	{ ceilinged, items }: { ceilinged: number; items: number },
	ceiling: number | null,
): string {
	const head = `${ceiling === null ? ceilinged : `${ceilinged} of ${ceiling}`} working`;
	if (items === 0) return head;
	if (items === ceilinged) return `${head}, ${items === 1 ? "a work item" : "all work items"}`;
	return `${head}, ${items} of them ${items === 1 ? "a work item" : "work items"}`;
}

// ---- the list of agents, grouped -------------------------------------------------------------------

/** The agents on one repository of the user's GitHub connection, or those on none. */
export interface SessionGroup {
	/** The repository's key (`keyOf`): "github:<id>", "gitlab:<id>", or "none" for the agents that are not on a repository of the connection. */
	key: string;
	/** The repository as the group's newest session has it: a rename shows once one is launched after it. Null for the group "none". */
	repository: SessionRepository | null;
	/** The user's own agents on it (`ownAgents`), the most recently used first: by the last prompt or turn end. */
	sessions: SessionSummary[];
	/** How many work items' sessions are on it. They are not in `sessions`; a repository that has only them still has its group, which leads to its page. */
	items: number;
	/** When the group was last used: its first agent's time, or its newest work item session's where it has no agent. */
	usedAt: number;
	/** How many of its agents are at work, and how many of those wait on their user. */
	working: number;
	waiting: number;
}

export const NO_REPOSITORY = "none";

const byUse = (a: SessionSummary, b: SessionSummary) =>
	b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1);

/**
 * The agents under their repositories: the repository that was used last comes first, and the agents
 * that are on no repository of the GitHub connection (none at all, or a pasted address) come last, as
 * a group of their own. Within a group the agent that was used last comes first. The sessions of work
 * items are not among a group's agents, and are only counted (`SessionGroup.items`).
 */
export function groupSessions(sessions: readonly SessionSummary[]): SessionGroup[] {
	const groups = new Map<string, SessionGroup>();
	/** When the session a group's repository is named after was launched. */
	const namedAt = new Map<string, number>();
	for (const session of [...sessions].sort(byUse)) {
		const repository = session.repository ?? null;
		const key = repository ? keyOf(repository) : NO_REPOSITORY;
		const ofItem = session.item !== undefined;
		let group = groups.get(key);
		if (!group) {
			group = { key, repository, sessions: [], items: 0, usedAt: session.updatedAt, working: 0, waiting: 0 };
			groups.set(key, group);
			namedAt.set(key, session.createdAt);
		} else if (repository && session.createdAt > (namedAt.get(key) ?? 0)) {
			// The name a repository goes by is the one its newest session was launched under.
			group.repository = repository;
			namedAt.set(key, session.createdAt);
		}
		if (ofItem) {
			group.items += 1;
			continue;
		}
		// The sessions come most recently used first: the first agent is when the group was used.
		if (group.sessions.length === 0) group.usedAt = session.updatedAt;
		group.sessions.push(session);
		if (session.status !== "idle") group.working += 1;
		if (session.status === "waiting") group.waiting += 1;
	}
	return [...groups.values()].sort(
		(a, b) =>
			Number(a.key === NO_REPOSITORY) - Number(b.key === NO_REPOSITORY) ||
			b.usedAt - a.usedAt ||
			(a.key < b.key ? -1 : 1),
	);
}

/** How many agents of a group are shown before the rest is folded away, where there are several groups, and where there is one. */
export const GROUP_SHOWN = 6;
export const LONE_GROUP_SHOWN = 20;
/** A fold that would hide this few is not worth its line. */
const FOLD_AT_LEAST = 3;

/**
 * What of a group is shown while it is folded: its first `limit` agents, and beyond them every agent
 * that is at work or waits on its user, which is never hidden. `hidden` is how many are left out, and
 * is 0 when the group is short enough to be shown whole.
 */
export function foldGroup(
	sessions: readonly SessionSummary[],
	limit: number,
): { shown: SessionSummary[]; hidden: number } {
	const shown = sessions.filter((session, index) => index < limit || session.status !== "idle");
	const hidden = sessions.length - shown.length;
	return hidden < FOLD_AT_LEAST ? { shown: [...sessions], hidden: 0 } : { shown, hidden };
}

/** How many agents a folded group shows, given how many groups the list has. */
export const shownLimit = (groups: number) => (groups <= 1 ? LONE_GROUP_SHOWN : GROUP_SHOWN);

// ---- a repository's page ---------------------------------------------------------------------------

/** "owner/name". */
export const repositoryName = (repository: Pick<SessionRepository, "owner" | "name">) =>
	`${repository.owner}/${repository.name}`;

// ---- the work items' counts -------------------------------------------------------------------------

/** What a list of work items is kept to: one repository, one way of filing (the Factory's filters). */
export interface FeedFilters {
	repository?: RepoAddress;
	from?: ItemSummary["source"];
}

/**
 * How many work items the user has under the filters, by where they stand, from the live feed's counts
 * (`ItemFeed.counts`): the feed carries only the newest ended items, so the ended ones are never
 * counted by its rows. Zero everywhere until the feed is read.
 */
export function feedCounts(
	feed: ItemFeed | null,
	filters: FeedFilters = {},
): { open: number; done: number; failed: number; cancelled: number; ended: number; total: number } {
	const sum = { open: 0, done: 0, failed: 0, cancelled: 0, ended: 0, total: 0 };
	for (const row of feed?.counts.byRepository ?? []) {
		if (filters.repository !== undefined && String(row.repository) !== String(filters.repository)) continue;
		if (filters.from !== undefined && row.source !== filters.from) continue;
		sum.open += row.open;
		sum.done += row.done;
		sum.failed += row.failed;
		sum.cancelled += row.cancelled;
	}
	sum.ended = sum.done + sum.failed + sum.cancelled;
	sum.total = sum.open + sum.ended;
	return sum;
}

/** The repositories that have work items, by name, with how many each has: from the feed's counts, so one whose items have all ended long ago is among them. */
export function feedRepositories(feed: ItemFeed | null): Array<{ id: RepoAddress; name: string; items: number }> {
	const found = new Map<string, { id: RepoAddress; name: string; items: number }>();
	for (const row of feed?.counts.byRepository ?? []) {
		const key = String(row.repository);
		const held = found.get(key) ?? { id: row.repository, name: `${row.owner}/${row.name}`, items: 0 };
		held.items += row.open + row.done + row.failed + row.cancelled;
		found.set(key, held);
	}
	return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The user's sessions on one repository, their work items' among them (`ownAgents` leaves those out), the most recently used first. */
export function sessionsOn(sessions: readonly SessionSummary[], repositoryId: GithubId): SessionSummary[] {
	return sessions.filter(session => session.repository?.id === repositoryId).sort(byUse);
}

export interface OpenPull {
	pull: PullRequestInfo;
	/** The agent whose work it is. */
	session: SessionSummary;
}

/**
 * The pull requests the agents on a repository opened that are still open, as each agent's summary
 * last had them, the most recently pushed first. GitHub is not asked: a pull request that was merged
 * or closed at GitHub since is listed until its agent's panel next reads it.
 */
export function openPulls(sessions: readonly SessionSummary[], repositoryId: GithubId): OpenPull[] {
	const open: OpenPull[] = [];
	for (const session of sessions) {
		const pull = session.repository?.id === repositoryId ? (session.pullRequest ?? null) : null;
		if (pull && (pull.state === "open" || pull.state === "draft")) open.push({ pull, session });
	}
	return open.sort((a, b) => b.pull.pushedAt - a.pull.pushedAt || b.pull.number - a.pull.number);
}

// ---- what a new agent starts with --------------------------------------------------------------------

export interface StartingChoices {
	/** The default sandbox, when one is saved and this deployment can run it. */
	profile: SandboxProfileId | null;
	/** The default model, when one is saved and it is among the user's models. */
	model: string | null;
	/** What is saved and is not used, each with a sentence that says why; null where nothing is left out. */
	ignored: { profile: string | null; model: string | null };
}

/**
 * Saved defaults held against what can be chosen now: a repository's, or with `whose` "account" the
 * account's. The sandbox is held against the deployment's (`info`), the model against the user's own
 * (`models`), and neither is judged while what it is held against is not known. A default that names
 * a sandbox the deployment no longer lists, or cannot run, or a model that is not in the user's list,
 * is left out, and `ignored` says so in words: of a list that only stands in for the plan's, that the
 * model is left out for now.
 */
export function startingChoices(
	defaults: AccountDefaults | null,
	info: Pick<PlatformInfo, "profiles"> | null,
	models: ModelList | null,
	whose: "repository" | "account" = "repository",
): StartingChoices {
	const choices: StartingChoices = { profile: null, model: null, ignored: { profile: null, model: null } };
	if (defaults === null) return choices;
	const the = whose === "account" ? "Your account's default" : "The default";
	if (defaults.profile !== null && info !== null) {
		const saved = info.profiles.find(profile => profile.id === defaults.profile);
		if (saved?.available) choices.profile = saved.id;
		else {
			// Which one, and what is used in its place: the account's default under a repository's, the deployment's first under the account's.
			const what = saved ? `${saved.name} isolation isn't available here` : "Your saved isolation is no longer offered";
			const first = info.profiles.find(profile => profile.available)?.name;
			choices.ignored.profile =
				whose === "account"
					? `${what}. New agents use ${first ?? "the default"} instead.`
					: `${what}. Agents here use your account's default instead.`;
		}
	}
	if (defaults.model !== null && models !== null) {
		if (models.models.some(model => model.id === defaults.model)) choices.model = defaults.model;
		else if (models.source === "account")
			choices.ignored.model = `${the} model, ${defaults.model}, is not among the models your ChatGPT plan offers now, so it is ignored.`;
		else if (models.source === "demo")
			choices.ignored.model = `${the} model, ${defaults.model}, is not offered here any more, so it is ignored.`;
		else
			choices.ignored.model = `${the} model, ${defaults.model}, is not in the list that stands in for your plan's models, so it is ignored for now.`;
	}
	return choices;
}

/** Whose default a choice of a new agent stands on. */
export type DefaultSource = "repository" | "account";

/** The defaults a launch starts from, each field by itself, and whose each is; null where neither the repository nor the account has one that can be used. */
export interface LayeredChoices {
	profile: SandboxProfileId | null;
	model: string | null;
	from: { profile: DefaultSource | null; model: DefaultSource | null };
}

/**
 * The chosen repository's defaults over the account's, field by field: a repository that saves only
 * a model leaves the sandbox to the account. Both were held against the deployment already
 * (`startingChoices`), so a default that cannot be used gives way to the next.
 */
export function layerChoices(
	repository: Pick<StartingChoices, "profile" | "model">,
	account: Pick<StartingChoices, "profile" | "model">,
): LayeredChoices {
	return {
		profile: repository.profile ?? account.profile,
		model: repository.model ?? account.model,
		from: {
			profile: repository.profile !== null ? "repository" : account.profile !== null ? "account" : null,
			model: repository.model !== null ? "repository" : account.model !== null ? "account" : null,
		},
	};
}

/**
 * What a launch starts on: the user's own choice when they made one, then the chosen repository's
 * default, then the account's, then the deployment's.
 */
export function startingProfile(
	chosen: SandboxProfileId | null,
	choices: Pick<StartingChoices, "profile">,
	info: Pick<PlatformInfo, "profiles"> | null,
): SandboxProfileId | null {
	const available = (id: SandboxProfileId | null) =>
		id !== null && info !== null && info.profiles.some(profile => profile.id === id && profile.available);
	if (available(chosen)) return chosen;
	if (available(choices.profile)) return choices.profile;
	return info?.profiles.find(profile => profile.available)?.id ?? null;
}

export function startingModel(
	chosen: string,
	choices: Pick<StartingChoices, "model">,
	models: ModelList | null,
): string {
	if (chosen !== "" && (models === null || models.models.some(model => model.id === chosen))) return chosen;
	if (choices.model !== null) return choices.model;
	return models?.defaultModel ?? "";
}

/** Keep the repository selected when opening the composer from the agents home. */
export function lastRepository(sessions: readonly SessionSummary[] | null) {
	const newest = ownAgents(sessions ?? []).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0];
	return newest?.repository
		? { kind: "github" as const, repository: newest.repository }
		: newest?.repoUrl
			? { kind: "address" as const, url: newest.repoUrl }
			: null;
}

/**
 * A title from a text: its first line that says something, as it is, cut to MAX_TITLE_CHARS at a word
 * where it is longer. None for an empty text.
 */
export function titleOf(task: string): string | undefined {
	const line = task
		.split("\n")
		.map(part => part.replace(/\s+/g, " ").trim())
		.find(part => part !== "");
	if (line === undefined) return undefined;
	if (line.length <= MAX_TITLE_CHARS) return line;
	const cut = line.slice(0, MAX_TITLE_CHARS - 1);
	const space = cut.lastIndexOf(" ");
	return `${(space > MAX_TITLE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * A work item from what was written in the start composer: the first line is its title (`titleOf`),
 * and the rest what to do. A first line too long for a title is kept whole in what to do. Null for an
 * empty text.
 */
export function itemOf(text: string): { title: string; body: string } | null {
	const title = titleOf(text);
	if (title === undefined) return null;
	const lines = text.split("\n");
	const first = lines.findIndex(line => line.trim() !== "");
	const rest = lines
		.slice(first + 1)
		.join("\n")
		.trim();
	return { title, body: title.endsWith("…") ? text.trim() : rest };
}
