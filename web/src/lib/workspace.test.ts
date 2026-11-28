/**
 * The Agents home's rail and filters (lib/workspace.ts): repositories grouped by owner with their live
 * state, what each filter leaves, the rail's search, and the filters and the folded rail as a browser
 * remembers them, or does not.
 */
import type { GithubId, ItemFeed, ItemSummary, SessionSummary } from "@contract";
import { describe, expect, it } from "vitest";
import {
	NO_FILTERS,
	activeRepositories,
	filterCount,
	itemStatus,
	loadFilters,
	loadOpenQuiet,
	loadPinned,
	loadRailFolded,
	matchesItem,
	matchesSession,
	railBadge,
	railOf,
	railSections,
	saveFilters,
	saveOpenQuiet,
	savePinned,
	saveRailFolded,
	togglePin,
	searchRail,
	sessionStatus,
	toggleFilter,
	type Filters,
} from "./workspace";

const repo = (id: number, owner: string, name: string) => ({
	provider: "github" as const,
	id: id as GithubId,
	owner,
	name,
	branch: "main",
	private: false,
	url: `https://github.com/${owner}/${name}`,
});

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id,
		title: id,
		mode: "auto",
		availableModes: [],
		capabilities: {} as SessionSummary["capabilities"],
		place: { kind: "hosted" },
		profile: "docker-windlass-sandbox",
		model: "m",
		repoUrl: null,
		createdAt: 1,
		updatedAt: 1,
		status: "idle",
		turns: 1,
		lastOutcome: "succeeded",
		sandbox: "none",
		...over,
	} as SessionSummary;
}

function item(id: string, over: Partial<ItemSummary> = {}): ItemSummary {
	return {
		id,
		title: id,
		repository: repo(1, "acme", "harbor"),
		place: { kind: "hosted" },
		source: "web",
		state: "working",
		question: null,
		pullRequest: null,
		createdAt: 1,
		updatedAt: 1,
		...over,
	} as ItemSummary;
}

/** A Storage that keeps its values in a map, or throws on every call. */
function storage(throwing = false): Storage & { map: Map<string, string> } {
	const map = new Map<string, string>();
	const guard = () => {
		if (throwing) throw new Error("SecurityError");
	};
	return {
		map,
		get length() {
			return map.size;
		},
		clear: () => map.clear(),
		key: (index: number) => [...map.keys()][index] ?? null,
		getItem: (key: string) => (guard(), map.get(key) ?? null),
		setItem: (key: string, value: string) => (guard(), void map.set(key, value)),
		removeItem: (key: string) => (guard(), void map.delete(key)),
	};
}

describe("the rail", () => {
	const sessions = [
		session("a", { repository: repo(1, "acme", "harbor"), status: "running", updatedAt: 50 }),
		session("b", { repository: repo(1, "acme", "harbor"), status: "waiting", updatedAt: 40 }),
		session("c", { repository: repo(2, "acme", "quay"), updatedAt: 90 }),
		session("d", { repository: repo(3, "ada", "tide-tables"), updatedAt: 10 }),
		session("e", { status: "waiting", updatedAt: 5 }),
		// A work item's session is part of its item, and not counted as an agent.
		session("f", { repository: repo(2, "acme", "quay"), item: { id: "i9" }, updatedAt: 99 }),
	];
	const items = [
		item("i1", { question: { askedAt: 3 } as ItemSummary["question"], updatedAt: 30 }),
		item("i2", { repository: repo(3, "ada", "tide-tables"), state: "done", updatedAt: 20 }),
		item("i3", { parent: { itemId: "i1", key: "k", title: "t" } }),
	];

	it("groups the repositories by owner, the owner and the repository used last first, and only saved settings last", () => {
		const rail = railOf({
			sessions,
			items,
			saved: [
				{ id: 7 as GithubId, name: "acme/old-pier" },
				{ id: 1 as GithubId, name: "acme/harbor" },
			],
		});
		expect(rail.groups.map(group => [group.owner, group.repositories.map(one => one.name)])).toEqual([
			["acme", ["quay", "harbor", "old-pier"]],
			["ada", ["tide-tables"]],
		]);
		expect(rail.repositories).toBe(4);
	});

	it("counts each repository's agents and work items, what runs and what asks, and the totals of everything and of no repository", () => {
		const rail = railOf({ sessions, items, saved: [] });
		const harbor = rail.groups[0]?.repositories.find(one => one.name === "harbor");
		expect(harbor).toMatchObject({ agents: 2, items: 1, running: 1, needs: 2 });
		const quay = rail.groups[0]?.repositories.find(one => one.name === "quay");
		expect(quay).toMatchObject({ agents: 1, items: 0, running: 0, needs: 0 });
		expect(rail.everything).toEqual({ count: 7, running: 1, needs: 3 });
		expect(rail.none).toEqual({ count: 1, running: 0, needs: 1 });
	});

	it("counts a repository's items as the feed counts them, the ended ones beyond the feed's rows too", () => {
		const feed = {
			counts: {
				byRepository: [
					{
						repository: 3 as GithubId,
						owner: "ada",
						name: "tide-tables",
						source: "web",
						open: 0,
						done: 6,
						failed: 1,
						cancelled: 2,
					},
				],
			},
		} as unknown as ItemFeed;
		const rail = railOf({ sessions, items, feed, saved: [] });
		expect(rail.groups[1]?.repositories[0]?.items).toBe(9);
	});

	it("badges: the amber count of what asks, a ring while it runs, no count for a quiet one, and saved for settings alone", () => {
		expect(railBadge({ running: 1, needs: 2, agents: 2, items: 1, saved: false })).toEqual({
			needs: 2,
			running: true,
			count: null,
			saved: false,
		});
		expect(railBadge({ running: 0, needs: 0, agents: 2, items: 3, saved: false })).toEqual({
			needs: 0,
			running: false,
			count: null,
			saved: false,
		});
		expect(railBadge({ running: 0, needs: 0, agents: 0, items: 0, saved: true })).toEqual({
			needs: 0,
			running: false,
			count: null,
			saved: true,
		});
	});

	it("with a filter on, lists only the repositories something matches, and the one shown whatever it has", () => {
		const filters: Filters = { ...NO_FILTERS, status: ["needs"] };
		const rail = railOf({ sessions, items, saved: [{ id: 7 as GithubId, name: "acme/old-pier" }], filters });
		expect(rail.groups.flatMap(group => group.repositories.map(one => one.name))).toEqual(["harbor"]);
		const kept = railOf({ sessions, items, saved: [], filters, keep: 3 as GithubId });
		expect(kept.groups.flatMap(group => group.repositories.map(one => one.name))).toEqual(["harbor", "tide-tables"]);
	});

	it("puts the repositories with something running or asking in Active now, what asks first", () => {
		const rail = railOf({ sessions, items, saved: [{ id: 7 as GithubId, name: "acme/old-pier" }] });
		const active = activeRepositories(rail.groups);
		expect(active.every(one => one.running > 0 || one.needs > 0)).toBe(true);
		expect(active.map(one => one.name)).not.toContain("old-pier");
		const firstQuiet = active.findIndex(one => one.needs === 0);
		expect(firstQuiet === -1 || active.slice(firstQuiet).every(one => one.needs === 0)).toBe(true);
	});

	it("finds repositories by owner and name, in any case", () => {
		const rail = railOf({ sessions, items, saved: [] });
		expect(searchRail(rail.groups, "TIDE").map(group => group.repositories.map(one => one.name))).toEqual([
			["tide-tables"],
		]);
		expect(searchRail(rail.groups, "acme/h").flatMap(group => group.repositories.map(one => one.name))).toEqual([
			"harbor",
		]);
		expect(searchRail(rail.groups, "nothing")).toEqual([]);
	});
});

describe("the filters", () => {
	it("say where a session and a work item stand", () => {
		expect([
			sessionStatus({ status: "running", lastOutcome: null }),
			sessionStatus({ status: "waiting", lastOutcome: null }),
			sessionStatus({ status: "idle", lastOutcome: "succeeded" }),
			sessionStatus({ status: "idle", lastOutcome: "error" }),
			sessionStatus({ status: "idle", lastOutcome: null }),
		]).toEqual(["running", "needs", "done", "failed", null]);
		expect([
			itemStatus({ state: "working", question: null }),
			itemStatus({ state: "waiting", question: {} as ItemSummary["question"] }),
			itemStatus({ state: "done", question: null }),
			itemStatus({ state: "failed", question: null }),
			itemStatus({ state: "queued", question: null }),
			itemStatus({ state: "cancelled", question: null }),
		]).toEqual(["running", "needs", "done", "failed", null, null]);
	});

	it("leave what matches every filter that is on, each any of its values", () => {
		const claude = session("c", { harness: "claude", place: { kind: "machine", machineId: "nas" }, status: "running" });
		expect(matchesSession(claude, NO_FILTERS)).toBe(true);
		expect(matchesSession(claude, { ...NO_FILTERS, agent: ["claude", "codex"] })).toBe(true);
		expect(matchesSession(claude, { ...NO_FILTERS, agent: ["windlass"] })).toBe(false);
		expect(matchesSession(claude, { ...NO_FILTERS, place: ["machine:nas"], status: ["running"] })).toBe(true);
		expect(matchesSession(claude, { ...NO_FILTERS, place: ["hosted"] })).toBe(false);
		expect(matchesSession(claude, { ...NO_FILTERS, kind: ["item"] })).toBe(false);
		const work = item("w", { agent: { harness: "codex" } as ItemSummary["agent"] });
		expect(matchesItem(work, { ...NO_FILTERS, kind: ["item"], agent: ["codex"], status: ["running"] })).toBe(true);
		expect(matchesItem(work, { ...NO_FILTERS, kind: ["agent"] })).toBe(false);
		expect(matchesItem(item("x"), { ...NO_FILTERS, agent: ["windlass"] })).toBe(true);
	});

	it("turn one value on and off, and count what is on", () => {
		const on = toggleFilter(toggleFilter(NO_FILTERS, "status", "needs"), "place", "hosted");
		expect(on).toEqual({ ...NO_FILTERS, status: ["needs"], place: ["hosted"] });
		expect(filterCount(on)).toBe(2);
		expect(toggleFilter(on, "status", "needs").status).toEqual([]);
	});

	it("are remembered by the browser, and forgotten once none is on", () => {
		const kept = storage();
		const filters: Filters = { status: ["needs", "failed"], agent: ["claude"], place: ["machine:nas"], kind: ["item"] };
		saveFilters(filters, kept);
		expect(loadFilters(kept)).toEqual(filters);
		saveFilters(NO_FILTERS, kept);
		expect(kept.map.size).toBe(0);
		expect(loadFilters(kept)).toEqual(NO_FILTERS);
	});

	it("drop what the browser kept that is not a filter, and start with none from a browser that keeps nothing", () => {
		const kept = storage();
		kept.map.set(
			"wlp.workspace.filters",
			JSON.stringify({
				status: ["needs", "sleeping", 3],
				agent: "claude",
				place: ["hosted", "machine:", "elsewhere"],
				kind: ["item", "item"],
			}),
		);
		expect(loadFilters(kept)).toEqual({ status: ["needs"], agent: [], place: ["hosted"], kind: ["item"] });
		kept.map.set("wlp.workspace.filters", "{not json");
		expect(loadFilters(kept)).toEqual(NO_FILTERS);
		const refusing = storage(true);
		expect(loadFilters(refusing)).toEqual(NO_FILTERS);
		expect(() => saveFilters({ ...NO_FILTERS, kind: ["agent"] }, refusing)).not.toThrow();
		expect(loadFilters(null)).toEqual(NO_FILTERS);
	});

	it("keep the rail folded or not", () => {
		const kept = storage();
		expect(loadRailFolded(kept)).toBe(false);
		saveRailFolded(true, kept);
		expect(loadRailFolded(kept)).toBe(true);
		saveRailFolded(false, kept);
		expect(loadRailFolded(kept)).toBe(false);
		expect(() => saveRailFolded(true, storage(true))).not.toThrow();
		expect(loadRailFolded(storage(true))).toBe(false);
	});

	it("keep the owners whose quiet repositories are unfolded, and the pins", () => {
		const kept = storage();
		expect([...loadOpenQuiet(kept)]).toEqual([]);
		saveOpenQuiet(new Set(["ada", "acme"]), kept);
		expect([...loadOpenQuiet(kept)].sort()).toEqual(["acme", "ada"]);
		saveOpenQuiet(new Set(), kept);
		expect(kept.map.size).toBe(0);
		expect(() => saveOpenQuiet(new Set(["ada"]), storage(true))).not.toThrow();
		expect([...loadOpenQuiet(storage(true))]).toEqual([]);
		expect(loadPinned(kept)).toEqual([]);
		savePinned(togglePin(togglePin([], "7"), "9"), kept);
		expect(loadPinned(kept)).toEqual(["7", "9"]);
		savePinned(togglePin(loadPinned(kept), "7"), kept);
		expect(loadPinned(kept)).toEqual(["9"]);
		savePinned([], kept);
		expect(kept.map.size).toBe(0);
		expect(loadPinned(storage(true))).toEqual([]);
	});

	it("sort the rail by activity: pinned, active, recent, then by owner with the quiet ones folded, each repository once", () => {
		const now = Date.parse("2026-11-27T12:00:00Z");
		const day = 24 * 60 * 60 * 1000;
		const repo = (
			id: number,
			owner: string,
			name: string,
			usedAt: number,
			more: { running?: number; needs?: number; saved?: boolean } = {},
		) => ({ id, owner, name, agents: 1, items: 0, running: 0, needs: 0, saved: false, usedAt, ...more });
		const groups = [
			{
				owner: "acme",
				repositories: [
					repo(1, "acme", "busy", now - day, { running: 1 }),
					repo(2, "acme", "lately", now - 2 * day),
					repo(3, "acme", "month", now - 10 * day),
					repo(4, "acme", "old", now - 40 * day),
					repo(5, "acme", "saved", 0, { saved: true }),
				],
			},
			{
				owner: "ada",
				repositories: [repo(6, "ada", "asks", now - 3 * day, { needs: 2 }), repo(7, "ada", "pinned", now - 60 * day)],
			},
		];
		const sections = railSections(groups, { pinned: ["7"], now });
		const names = (list: { name: string }[]) => list.map(one => one.name);
		expect(names(sections.pinned)).toEqual(["pinned"]);
		expect(names(sections.active)).toEqual(["asks", "busy"]);
		expect(names(sections.recent)).toEqual(["lately"]);
		expect(sections.owners).toEqual([
			{
				owner: "acme",
				shown: [groups[0]!.repositories[2]],
				quiet: [groups[0]!.repositories[3], groups[0]!.repositories[4]],
			},
		]);
		// The chosen repository is never folded away as quiet.
		expect(names(railSections(groups, { now, keep: "4" }).owners[0]!.shown)).toEqual(["month", "old"]);
	});
});
