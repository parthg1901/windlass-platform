/**
 * The Agents home as a workspace: a rail of the user's repositories on the left, grouped by owner,
 * each with its live state, and the chosen repository's work on the right. Everything here is worked
 * out from what the web app already holds: the summaries of the user's sessions, the live feed of
 * their work items (with its counts), and the repositories something is saved for.
 *
 * The lists are partitioned by repository, and can be filtered: by status, by agent, by where it runs
 * and by kind (an agent session or a work item). The filters are the viewer's own, kept in this
 * browser (`loadFilters`, `saveFilters`); a browser that keeps nothing starts with none.
 */
import type {
	GithubId,
	RepoAddress,
	HarnessId,
	ItemFeed,
	ItemSummary,
	SandboxPlace,
	SavedRepository,
	SessionSummary,
} from "@contract";
import { repoAddress } from "../../../server/src/codehost/ref.js";
import { ownAgents } from "./repositories";
import { HARNESS_DISPLAY_ORDER } from "./acp";

// ---- the filters -----------------------------------------------------------------------------------

export type StatusFilter = "running" | "needs" | "done" | "failed";
export type KindFilter = "agent" | "item";
/** "hosted", or "machine:<its id>". */
export type PlaceFilter = string;

export const STATUS_FILTERS: readonly StatusFilter[] = ["running", "needs", "done", "failed"];
export const STATUS_FILTER_WORD: Record<StatusFilter, string> = {
	running: "Running",
	needs: "Needs you",
	done: "Done",
	failed: "Failed",
};
export const KIND_FILTERS: readonly KindFilter[] = ["agent", "item"];
export const KIND_FILTER_WORD: Record<KindFilter, string> = { agent: "Agent sessions", item: "Work items" };

/** What is shown: each list empty means "any". */
export interface Filters {
	status: StatusFilter[];
	agent: HarnessId[];
	place: PlaceFilter[];
	kind: KindFilter[];
}

export const NO_FILTERS: Filters = { status: [], agent: [], place: [], kind: [] };

/** How many filters are on. */
export const filterCount = (filters: Filters): number =>
	filters.status.length + filters.agent.length + filters.place.length + filters.kind.length;

/** One value of one filter turned on or off. */
export function toggleFilter<K extends keyof Filters>(filters: Filters, key: K, value: Filters[K][number]): Filters {
	const now = filters[key] as string[];
	const next = now.includes(value) ? now.filter(one => one !== value) : [...now, value];
	return { ...filters, [key]: next };
}

export const placeKey = (place: SandboxPlace): PlaceFilter =>
	place.kind === "machine" ? `machine:${place.machineId}` : "hosted";

/** Where a session stands, in the filters' words; null for an agent that never ran a turn. */
export function sessionStatus(session: Pick<SessionSummary, "status" | "lastOutcome">): StatusFilter | null {
	if (session.status === "waiting") return "needs";
	if (session.status !== "idle") return "running";
	if (session.lastOutcome === null) return null;
	return session.lastOutcome === "failed" || session.lastOutcome === "error" ? "failed" : "done";
}

/**
 * Where a work item stands, in the filters' words: it needs its person when it asks them something
 * (as the bar's count has it), and runs while its agent works on it. One that is queued, waits on
 * something else (CI, a free turn), is in review, a draft or cancelled is none of the four.
 */
export function itemStatus(item: Pick<ItemSummary, "state" | "question">): StatusFilter | null {
	if (item.question !== null) return "needs";
	if (item.state === "working") return "running";
	if (item.state === "done") return "done";
	if (item.state === "failed") return "failed";
	return null;
}

const itemHarness = (item: Pick<ItemSummary, "agent">): HarnessId => item.agent?.harness ?? "windlass";

export function matchesSession(session: SessionSummary, filters: Filters): boolean {
	if (filters.kind.length > 0 && !filters.kind.includes("agent")) return false;
	if (filters.status.length > 0) {
		const status = sessionStatus(session);
		if (status === null || !filters.status.includes(status)) return false;
	}
	if (filters.agent.length > 0 && !filters.agent.includes(session.harness ?? "windlass")) return false;
	if (filters.place.length > 0 && !filters.place.includes(placeKey(session.place))) return false;
	return true;
}

export function matchesItem(item: ItemSummary, filters: Filters): boolean {
	if (filters.kind.length > 0 && !filters.kind.includes("item")) return false;
	if (filters.status.length > 0) {
		const status = itemStatus(item);
		if (status === null || !filters.status.includes(status)) return false;
	}
	if (filters.agent.length > 0 && !filters.agent.includes(itemHarness(item))) return false;
	if (filters.place.length > 0 && !filters.place.includes(placeKey(item.place))) return false;
	return true;
}

const FILTERS_KEY = "wlp.workspace.filters";

const only = <T extends string>(value: unknown, allowed: (one: string) => one is T): T[] =>
	Array.isArray(value) ? [...new Set(value.filter((one): one is T => typeof one === "string" && allowed(one)))] : [];

/** The viewer's filters as this browser kept them; none where it kept nothing, or cannot keep anything. */
export function loadFilters(storage: Pick<Storage, "getItem"> | null = safeStorage()): Filters {
	try {
		const text = storage?.getItem(FILTERS_KEY);
		if (!text) return NO_FILTERS;
		const value = JSON.parse(text) as Partial<Record<keyof Filters, unknown>>;
		return {
			status: only(value.status, (one): one is StatusFilter => (STATUS_FILTERS as readonly string[]).includes(one)),
			agent: only(value.agent, (one): one is HarnessId => (HARNESS_DISPLAY_ORDER as readonly string[]).includes(one)),
			place: only(value.place, (one): one is PlaceFilter => one === "hosted" || /^machine:.+/.test(one)),
			kind: only(value.kind, (one): one is KindFilter => (KIND_FILTERS as readonly string[]).includes(one)),
		};
	} catch {
		return NO_FILTERS;
	}
}

export function saveFilters(
	filters: Filters,
	storage: Pick<Storage, "setItem" | "removeItem"> | null = safeStorage(),
): void {
	try {
		if (filterCount(filters) === 0) storage?.removeItem(FILTERS_KEY);
		else storage?.setItem(FILTERS_KEY, JSON.stringify(filters));
	} catch {
		// A browser that keeps nothing forgets them at the next visit.
	}
}

const RAIL_KEY = "wlp.workspace.rail";

/** Whether the viewer folded the rail away, as this browser kept it. */
export function loadRailFolded(storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
	try {
		return storage?.getItem(RAIL_KEY) === "folded";
	} catch {
		return false;
	}
}

export function saveRailFolded(
	folded: boolean,
	storage: Pick<Storage, "setItem" | "removeItem"> | null = safeStorage(),
): void {
	try {
		if (folded) storage?.setItem(RAIL_KEY, "folded");
		else storage?.removeItem(RAIL_KEY);
	} catch {
		// Kept for this visit only.
	}
}

export function safeStorage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

// ---- the rail --------------------------------------------------------------------------------------

/** One repository in the rail, with its live state under the filters. */
export interface RailRepository {
	id: RepoAddress;
	owner: string;
	name: string;
	/** The user's own agents on it, and its work items (a feature's subtasks are part of their feature). */
	agents: number;
	items: number;
	/** How many of those are at work, and how many ask the user something. */
	running: number;
	needs: number;
	/** Something is saved for it and nothing is on it. */
	saved: boolean;
	/** When something on it was last used: the order of the rail. */
	usedAt: number;
}

export interface RailGroup {
	owner: string;
	repositories: RailRepository[];
}

/** The totals of a scope that is not one repository: everything, or what is on no repository. */
export interface RailTotals {
	count: number;
	running: number;
	needs: number;
}

export interface Rail {
	groups: RailGroup[];
	everything: RailTotals;
	none: RailTotals;
	/** How many repositories the rail lists. */
	repositories: number;
}

export interface RailInput {
	sessions: readonly SessionSummary[] | null;
	/** The live feed's items (open first, then the newest ended), and its counts of every item. */
	items: readonly ItemSummary[] | null;
	feed?: ItemFeed | null;
	saved: readonly SavedRepository[];
	filters?: Filters;
	/** A repository kept in the rail whatever the filters say: the one shown. */
	keep?: RepoAddress | null;
}

const isRunning = (status: StatusFilter | null) => status === "running";

/**
 * The rail: the repositories grouped by owner, the owner used last first and within it the repository
 * used last first; a repository that only has saved settings comes after those with work. Each counts
 * its agents and work items under the filters; with no filter on, the work items are counted as the
 * feed counts them, ended ones included. A repository with nothing the filters leave is not listed,
 * but `keep`.
 */
export function railOf({ sessions, items, feed = null, saved, filters = NO_FILTERS, keep = null }: RailInput): Rail {
	const filtering = filterCount(filters) > 0;
	const found = new Map<string, RailRepository>();
	const everything: RailTotals = { count: 0, running: 0, needs: 0 };
	const none: RailTotals = { count: 0, running: 0, needs: 0 };
	const entry = (id: RepoAddress, owner: string, name: string): RailRepository => {
		const key = String(id);
		let repository = found.get(key);
		if (!repository) {
			repository = { id, owner, name, agents: 0, items: 0, running: 0, needs: 0, saved: false, usedAt: 0 };
			found.set(key, repository);
		}
		return repository;
	};
	for (const session of ownAgents(sessions ?? [])) {
		if (!matchesSession(session, filters)) continue;
		const status = sessionStatus(session);
		const totals = session.repository ? null : none;
		for (const sum of [everything, totals]) {
			if (!sum) continue;
			sum.count += 1;
			if (isRunning(status)) sum.running += 1;
			if (status === "needs") sum.needs += 1;
		}
		if (!session.repository) continue;
		const repository = entry(repoAddress(session.repository), session.repository.owner, session.repository.name);
		repository.agents += 1;
		if (isRunning(status)) repository.running += 1;
		if (status === "needs") repository.needs += 1;
		repository.usedAt = Math.max(repository.usedAt, session.updatedAt);
	}
	for (const item of items ?? []) {
		if (item.parent || !matchesItem(item, filters)) continue;
		const status = itemStatus(item);
		everything.count += 1;
		if (isRunning(status)) everything.running += 1;
		if (status === "needs") everything.needs += 1;
		const repository = entry(repoAddress(item.repository), item.repository.owner, item.repository.name);
		repository.items += 1;
		if (isRunning(status)) repository.running += 1;
		if (status === "needs") repository.needs += 1;
		repository.usedAt = Math.max(repository.usedAt, item.updatedAt);
	}
	if (!filtering) {
		// The feed carries only the newest ended items: its counts are the whole of each repository's.
		const counted = new Map<string, number>();
		for (const row of feed?.counts.byRepository ?? []) {
			const key = String(row.repository);
			counted.set(key, (counted.get(key) ?? 0) + row.open + row.done + row.failed + row.cancelled);
			entry(row.repository, row.owner, row.name);
		}
		for (const [key, total] of counted) {
			const repository = found.get(key);
			if (repository && total > repository.items) {
				everything.count += total - repository.items;
				repository.items = total;
			}
		}
		for (const one of saved) {
			if (found.has(String(one.id))) continue;
			const [owner, name] = splitName(one.name, one.id);
			const repository = entry(one.id, owner, name);
			repository.saved = true;
		}
	}
	if (keep !== null && !found.has(String(keep))) {
		const known = saved.find(one => String(one.id) === String(keep));
		const fromSession = sessions?.find(
			session => session.repository && String(repoAddress(session.repository)) === String(keep),
		)?.repository;
		const fromItem = items?.find(item => String(repoAddress(item.repository)) === String(keep))?.repository;
		const named = fromSession ?? fromItem;
		if (named) entry(repoAddress(named), named.owner, named.name);
		else if (known) {
			const [owner, name] = splitName(known.name, known.id);
			entry(known.id, owner, name);
		}
	}
	const byOwner = new Map<string, RailRepository[]>();
	for (const repository of found.values()) {
		const list = byOwner.get(repository.owner) ?? [];
		list.push(repository);
		byOwner.set(repository.owner, list);
	}
	const order = (a: RailRepository, b: RailRepository) =>
		Number(a.saved) - Number(b.saved) || b.usedAt - a.usedAt || a.name.localeCompare(b.name);
	const groups = [...byOwner.entries()].map(([owner, repositories]) => ({
		owner,
		repositories: repositories.sort(order),
	}));
	const newest = (group: RailGroup) => Math.max(0, ...group.repositories.map(repository => repository.usedAt));
	groups.sort((a, b) => newest(b) - newest(a) || a.owner.localeCompare(b.owner));
	return { groups, everything, none, repositories: found.size };
}

function splitName(name: string | null, id: GithubId): [string, string] {
	if (name?.includes("/")) {
		const at = name.indexOf("/");
		return [name.slice(0, at), name.slice(at + 1)];
	}
	return ["", name ?? `repository ${id}`];
}

/** The rail's repositories a search leaves: those whose "owner/name" has the words in it, in any case. */
export function searchRail(groups: readonly RailGroup[], query: string): RailGroup[] {
	const needle = query.trim().toLowerCase();
	if (needle === "") return [...groups];
	return groups
		.map(group => ({
			...group,
			repositories: group.repositories.filter(repository =>
				`${repository.owner}/${repository.name}`.toLowerCase().includes(needle),
			),
		}))
		.filter(group => group.repositories.length > 0);
}

/**
 * What a rail row shows at its end: the amber count of what asks and a running ring. A quiet one shows
 * no count (its name is dimmer), only "saved" where nothing but settings is saved for it.
 */
export function railBadge(entry: Pick<RailRepository, "running" | "needs" | "agents" | "items" | "saved">): {
	needs: number;
	running: boolean;
	count: number | null;
	saved: boolean;
} {
	const count = entry.agents + entry.items;
	return { needs: entry.needs, running: entry.running > 0, count: null, saved: entry.saved && count === 0 };
}

/** The repositories with something running or asking, what asks first, then the one used last: the rail's "Active now". */
export function activeRepositories(groups: readonly RailGroup[]): RailRepository[] {
	return groups
		.flatMap(group => group.repositories)
		.filter(repository => repository.running > 0 || repository.needs > 0)
		.sort((a, b) => Number(b.needs > 0) - Number(a.needs > 0) || b.usedAt - a.usedAt || a.name.localeCompare(b.name));
}

const OWNERS_KEY = "wlp.workspace.folded-owners";

/** The owners whose repositories the viewer folded away in the rail, as this browser kept them. */
export function loadFoldedOwners(storage: Pick<Storage, "getItem"> | null = safeStorage()): Set<string> {
	try {
		const value: unknown = JSON.parse(storage?.getItem(OWNERS_KEY) ?? "[]");
		return new Set(Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : []);
	} catch {
		return new Set();
	}
}

export function saveFoldedOwners(
	owners: ReadonlySet<string>,
	storage: Pick<Storage, "setItem" | "removeItem"> | null = safeStorage(),
): void {
	try {
		if (owners.size === 0) storage?.removeItem(OWNERS_KEY);
		else storage?.setItem(OWNERS_KEY, JSON.stringify([...owners].sort()));
	} catch {
		// Kept for this visit only.
	}
}
