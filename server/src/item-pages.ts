/**
 * A page of the user's work items, for a list that would be slow to send or draw whole: the Factory's
 * ended items, a page at a time ("Show more"). `listItems` without a page answers with the whole list
 * as it always did; with one, with at most `limit` items after the cursor.
 *
 * The order is the list's own: newest filed first, and by id between two filed in the same
 * millisecond. A cursor is the last item of the page before, by when it was filed and its id, both of
 * which never change: a page after it holds every item older than that one, whatever changed meanwhile,
 * so a page is never skipped or repeated by an item that changed its state. One filed since comes at
 * the top of the list, where the live list already has it.
 *
 * The live feed (`itemFeed`) carries the open items and only the first page of the ended ones, with
 * counts beside them, so that what it sends stays small however many items a user has filed.
 *
 * This file has no actor in it: the `user` actor's `listItems` and `itemFeed` call it, and the web app's mock does too.
 */

import {
	type RepoAddress,
	type ItemCount,
	type ItemCursor,
	type ItemFeed,
	type ItemSummary,
	ITEM_FEED_ENDED,
	ITEM_PAGE_DEFAULT,
	ITEM_PAGE_MAX,
} from "./contract.js";
import { readRepoAddress, readRepoKey, repoAddress } from "./codehost/ref.js";
import { SOURCE_IDS } from "./sources/types.js";

/** Thrown for a page that cannot be read; `message` is fit to show. */
export class ItemPageProblem extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ItemPageProblem";
	}
}

const ENDED: ReadonlySet<ItemSummary["state"]> = new Set(["done", "failed", "cancelled"]);
const SOURCES: ReadonlySet<ItemSummary["source"]> = new Set(["web", "api", ...SOURCE_IDS]);

/** A page as asked for, checked: the cursor, the limit, and what it keeps. */
export interface CleanPage {
	before: ItemCursor | null;
	limit: number;
	/** true: only ended items; false: only open ones; null: both. */
	ended: boolean | null;
	repository: RepoAddress | null;
	source: ItemSummary["source"] | null;
}

/** What a client sent as a page; null for none (the whole list). Throws ItemPageProblem for one that is not a page. */
export function cleanItemPage(raw: unknown): CleanPage | null {
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== "object" || Array.isArray(raw)) throw new ItemPageProblem("A page of work items is an object.");
	const input = raw as Record<string, unknown>;
	let before: ItemCursor | null = null;
	if (input.before !== undefined && input.before !== null) {
		const cursor = input.before as Record<string, unknown>;
		if (
			typeof cursor !== "object" ||
			typeof cursor.createdAt !== "number" ||
			!Number.isFinite(cursor.createdAt) ||
			typeof cursor.id !== "string" ||
			cursor.id === "" ||
			cursor.id.length > 64
		) {
			throw new ItemPageProblem("Start a page after an item of the page before: its createdAt and id.");
		}
		before = { createdAt: cursor.createdAt, id: cursor.id };
	}
	const limit = input.limit === undefined ? ITEM_PAGE_DEFAULT : input.limit;
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > ITEM_PAGE_MAX)
		throw new ItemPageProblem(`A page holds 1 to ${ITEM_PAGE_MAX} work items.`);
	if (input.ended !== undefined && typeof input.ended !== "boolean")
		throw new ItemPageProblem("Say true or false for ended items only.");
	if (input.repository !== undefined && input.repository !== null && readRepoKey(input.repository) === null)
		throw new ItemPageProblem("Name the repository by GitHub's id for it.");
	if (input.source !== undefined && input.source !== null && !SOURCES.has(input.source as ItemSummary["source"]))
		throw new ItemPageProblem("Filed from is web, api, github, gitlab, linear, jira or slack.");
	return {
		before,
		limit,
		ended: typeof input.ended === "boolean" ? input.ended : null,
		repository: readRepoAddress(input.repository),
		source: (input.source ?? null) as ItemSummary["source"] | null,
	};
}

/** Newest filed first, by id between equals: the order of the list and of its pages. */
export function byFiling(a: Pick<ItemSummary, "createdAt" | "id">, b: Pick<ItemSummary, "createdAt" | "id">): number {
	return b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** Whether an item comes after the cursor in that order. */
const after = (item: Pick<ItemSummary, "createdAt" | "id">, cursor: ItemCursor) =>
	item.createdAt < cursor.createdAt || (item.createdAt === cursor.createdAt && item.id < cursor.id);

/** The page of a list (any order): the items it keeps, after the cursor, at most `limit` of them. */
export function itemPage(list: readonly ItemSummary[], page: CleanPage): ItemSummary[] {
	const kept = list.filter(
		item =>
			(page.ended === null || ENDED.has(item.state) === page.ended) &&
			(page.repository === null || String(repoAddress(item.repository)) === String(page.repository)) &&
			(page.source === null || item.source === page.source) &&
			(page.before === null || after(item, page.before)),
	);
	return kept.sort(byFiling).slice(0, page.limit);
}

/** The cursor for the page after this one; null when this one was the last (shorter than its limit). */
export function nextCursor(page: readonly ItemSummary[], limit: number): ItemCursor | null {
	const last = page[page.length - 1];
	return page.length < limit || !last ? null : { createdAt: last.createdAt, id: last.id };
}

/**
 * The user's list from every item held: top-level items, and a feature's child while it asks a
 * question (titled "<feature> — <child>"), newest filed first.
 */
export function listedItems(items: Iterable<ItemSummary>): ItemSummary[] {
	return [...items]
		.filter(item => !item.parent || item.question)
		.map(item => (item.parent ? { ...item, title: item.parent.title + " — " + item.title } : item))
		.sort(byFiling);
}

/** Every open subtask among the items held, under its own title, newest filed first: `ItemFeed.children`. */
export function openChildren(items: Iterable<ItemSummary>): ItemSummary[] {
	return [...items].filter(item => item.parent && !ENDED.has(item.state)).sort(byFiling);
}

/**
 * What the live feed carries of a list (`listedItems`, any order): every open item, the first page of
 * ended ones, and the counts; with every item held (`all`), the open subtasks beside them.
 */
export function itemFeed(list: readonly ItemSummary[], all?: Iterable<ItemSummary>): ItemFeed {
	const sorted = [...list].sort(byFiling);
	const open: ItemSummary[] = [];
	const ended: ItemSummary[] = [];
	let endedCount = 0;
	const rows = new Map<string, ItemCount>();
	for (const item of sorted) {
		const key = `${repoAddress(item.repository)}|${item.source}`;
		let row = rows.get(key);
		// The newest filed comes first: the row takes its repository's owner and name.
		if (!row)
			rows.set(
				key,
				(row = {
					repository: repoAddress(item.repository),
					owner: item.repository.owner,
					name: item.repository.name,
					source: item.source,
					open: 0,
					done: 0,
					failed: 0,
					cancelled: 0,
				}),
			);
		if (item.state === "done" || item.state === "failed" || item.state === "cancelled") {
			row[item.state] += 1;
			endedCount += 1;
			if (ended.length < ITEM_FEED_ENDED) ended.push(item);
		} else {
			row.open += 1;
			open.push(item);
		}
	}
	return {
		open,
		ended,
		counts: { ended: endedCount, byRepository: [...rows.values()] },
		...(all && { children: openChildren(all) }),
	};
}
