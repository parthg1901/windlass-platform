// @vitest-environment jsdom
/**
 * The Factory page against the mock: its address and the bar's "Agents · Factory" with the count of
 * what asks, its groups and filters, filing a work item from it without leaving, the first visit, and
 * a deployment without the second review.
 */
import {
	ITEM_FEED_ENDED,
	ITEM_PAGE_DEFAULT,
	type AuthResult,
	type CreateItemInput,
	type ItemListPage,
	type ItemSummary,
} from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserApi } from "../api/client";
import { createMockClient, type MockClient, type MockOptions } from "../api/mock";
import { App } from "../App";
import { saveAuth } from "../lib/authStore";
import { parseRoute } from "../lib/router";
import { filterItems } from "./Factory";
import { AppProvider } from "../state/app";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The whole app renders here: beside the other files on a busy machine, its first render can take longer than the default 5 s.
vi.setConfig({ testTimeout: 30_000 });
// jsdom has no media queries: the theme reads one, and a wide screen matches none of the app's.
// Most tests read the list, which a phone gets; the board's own tests set `wide`.
let wide = false;
window.matchMedia ??= ((query: string) => ({
	matches: wide && query.includes("min-width: 761px"),
	media: query,
	onchange: null,
	addEventListener() {},
	removeEventListener() {},
	addListener() {},
	removeListener() {},
	dispatchEvent: () => false,
})) as typeof window.matchMedia;

const ada: AuthResult = {
	token: "mock:user:u_ada:ada@example.com",
	profile: { uid: "u_ada", email: "ada@example.com", demo: false },
};

let host: HTMLElement;
let root: Root | null;
let client: MockClient;
/** What was filed, in order. */
let filed: CreateItemInput[];
/** The pages of items asked for, in order. */
let paged: ItemListPage[];

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = null;
	filed = [];
	paged = [];
	sessionStorage.clear();
});

afterEach(() => {
	if (root) act(() => root?.unmount());
	host.remove();
	client.dispose();
	saveAuth("mock", null);
});

async function settle(steps = 14): Promise<void> {
	for (let step = 0; step < steps; step++)
		await act(async () => void (await new Promise(resolve => setTimeout(resolve, 2))));
}

/** Signs in to a mock set up by `options` and shows the app at `path`. */
async function show(path: string, options: MockOptions = {}): Promise<void> {
	history.replaceState(null, "", path);
	client = createMockClient({ pace: 0, origin: "http://localhost:5173", ...options });
	const user = client.user.bind(client);
	(client as { user: (auth: AuthResult) => UserApi }).user = who => {
		const api = user(who);
		return {
			...api,
			createItem: (input: CreateItemInput) => (filed.push(input), api.createItem(input)),
			listItems: (page?: ItemListPage) => (page && paged.push(page), api.listItems(page)),
		};
	};
	saveAuth("mock", ada);
	root = createRoot(host);
	act(() => root?.render(createElement(AppProvider, { client, children: createElement(App) })));
	await settle();
}

/** The user's items as the mock has them. */
const listed = (): Promise<ItemSummary[]> => client.user(ada).listItems();

const tabs = () => host.querySelector('nav[aria-label="Main"]') as HTMLElement | null;
const tab = (name: string) =>
	[...(tabs()?.querySelectorAll("a") ?? [])].find(link => link.textContent?.startsWith(name)) as
		| HTMLAnchorElement
		| undefined;
/** The groups shown, in order, with the titles of their rows; the ended ones only once unfolded. */
const groups = () =>
	[...host.querySelectorAll(".factory-group")]
		.filter(group => !group.closest("[hidden]"))
		.map(group => ({
			name: group.querySelector(".agent-group-name")?.textContent ?? "",
			titles: [...group.querySelectorAll(".agent-title")].map(title => title.firstChild?.textContent ?? ""),
		}));
const rows = () =>
	[...host.querySelectorAll(".factory-group .item-row")].filter(row => !row.closest("[hidden]")) as HTMLElement[];
const field = () => host.querySelector(".start textarea") as HTMLTextAreaElement;
/** The start composer's pill of a picker, by its name ("repo", "where", "agent", "mode", "criteria"). */
const pill = (name: string) => host.querySelector(`.start [data-picker="${name}"]`) as HTMLButtonElement | null;
/** The open picker, the newest one, drawn at the end of the page. */
const pop = () => ([...document.querySelectorAll(".ui-pop")].at(-1) ?? null) as HTMLElement | null;
/** Opens the repository's picker: the last row of the where menu. */
async function openRepo(): Promise<void> {
	act(() => (pill("where") as HTMLButtonElement).click());
	act(() => (pop()?.querySelector('[data-value="repo"]') as HTMLElement).click());
	await settle(2);
}
const button = (words: string) =>
	[...host.querySelectorAll("button")].find(candidate => candidate.textContent === words) as HTMLButtonElement;

function write(text: string, into: HTMLTextAreaElement = field()): void {
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(into, text);
		into.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

/** Chooses a repository in the rail ("all": Everything), or opens the "from" filter's menu and chooses one of its choices, by its words. */
async function filter(label: string, choice: string): Promise<void> {
	if (label === "repo") {
		const name = choice === "all" ? "Everything" : choice.slice(choice.indexOf("/") + 1);
		const row = [
			...host.querySelectorAll<HTMLAnchorElement>('nav.ws-rail[aria-label="Repositories"] a.ws-rail-row'),
		].find(candidate => candidate.querySelector(".ws-rail-name")?.textContent === name) as HTMLAnchorElement;
		await act(async () => row.click());
		await settle(4);
		return;
	}
	act(() =>
		(
			host.querySelector(
				`.factory-filters [data-picker="${label === "repo" ? "repository" : label}"]`,
			) as HTMLButtonElement
		).click(),
	);
	const option = [...(pop()?.querySelectorAll('[role="menuitemradio"]') ?? [])].find(
		candidate => candidate.querySelector(".ui-item-label")?.textContent === choice,
	) as HTMLElement;
	await act(async () => option.click());
	await settle(4);
}

describe("the Factory page's address and the bar's tabs", () => {
	it("is at /factory, with Agents · Factory in the bar and the count of the items that ask", async () => {
		await show("/factory");
		const asking = (await listed()).filter(item => item.question !== null).length;
		expect(asking).toBeGreaterThan(0);
		expect(host.querySelector("h1")?.textContent).toBe("Factory");
		expect(tab("Agents")?.getAttribute("href")).toBe("/");
		expect(tab("Factory")?.getAttribute("aria-current")).toBe("page");
		expect(tab("Factory")?.textContent).toBe(`Factory · ${asking} need you`);
		expect(document.title).toBe(`(${asking}) Factory · Windlass`);
		// To Home by its tab, where the count stays.
		await act(async () => tab("Agents")?.click());
		await settle();
		expect(location.pathname).toBe("/");
		expect(tab("Agents")?.getAttribute("aria-current")).toBe("page");
		expect(tab("Factory")?.textContent).toBe(`Factory · ${asking} need you`);
	});

	it("says no count when nothing asks", async () => {
		await show("/factory", { items: "none" });
		expect(tab("Factory")?.textContent).toBe("Factory");
	});

	it("is not found, and has no tab, where the deployment offers no work items", async () => {
		await show("/factory", { items: "off" });
		expect(host.textContent).toContain("Nothing at this address");
		expect(tab("Factory")).toBeUndefined();
		act(() => root?.unmount());
		root = null;
		client.dispose();
		await show("/", { items: "off" });
		expect(host.querySelector("h1")?.textContent).toBe("Agents");
		expect(tab("Factory")).toBeUndefined();
	});

	it("reads its filters from the address, and writes them back", () => {
		expect(parseRoute("/factory", "?repository=7101&from=github")).toEqual({
			name: "factory",
			repository: 7101,
			from: "github",
		});
		expect(parseRoute("/factory", "?repository=x&from=email")).toEqual({ name: "factory" });
		expect(parseRoute("/factory/")).toEqual({ name: "factory" });
	});

	it("names a GitLab project by its key, so it never shares a GitHub repository's id", () => {
		expect(parseRoute("/factory", "?repository=gitlab%3A7101")).toEqual({ name: "factory", repository: "gitlab:7101" });
		const on = (provider: "github" | "gitlab", id: string) =>
			({ id, source: "web", repository: { provider, id: 7101, owner: "acme", name: "harbor" } }) as ItemSummary;
		const list = [on("github", "i1"), on("gitlab", "i2")];
		expect(filterItems(list, { repository: 7101 }).map(item => item.id)).toEqual(["i1"]);
		expect(filterItems(list, { repository: "gitlab:7101" }).map(item => item.id)).toEqual(["i2"]);
	});
});

describe("the Factory page's groups and filters", () => {
	it("groups every item across repositories by what its person must do, the ended ones folded", async () => {
		await show("/factory");
		const all = await listed();
		const names = (items: ItemSummary[]) => items.map(item => item.title).sort();
		const shown = groups();
		expect(shown.map(group => group.name)).toEqual(["Needs you", "Ready for you", "In progress", "Drafts"]);
		const of = (name: string) => (shown.find(group => group.name === name)?.titles ?? []).slice().sort();
		const asking = all.filter(item => item.question !== null);
		expect(of("Needs you")).toEqual(names(asking));
		const rest = all.filter(item => item.question === null);
		expect(of("Ready for you")).toEqual(names(rest.filter(item => item.state === "review")));
		expect(of("In progress")).toEqual(
			names(rest.filter(item => ["working", "queued", "waiting"].includes(item.state))),
		);
		expect(of("Drafts")).toEqual(names(rest.filter(item => item.state === "draft")));
		// Needs you: the longest waiting first, with the question.
		const first = asking.sort((a, b) => (a.question?.askedAt ?? 0) - (b.question?.askedAt ?? 0))[0] as ItemSummary;
		expect(shown[0]?.titles[0]).toBe(first.title);
		expect(rows()[0]?.textContent).toContain(first.question?.text);
		// More than one repository is listed, each row says which.
		expect(new Set(all.map(item => item.repository.name)).size).toBeGreaterThan(1);
		// The ended ones, folded until asked for.
		const ended = rest.filter(item => ["done", "failed", "cancelled"].includes(item.state));
		expect(ended.length).toBeGreaterThan(0);
		act(() => button(`Show ${ended.length} ended items`).click());
		await settle();
		expect(groups().at(-1)).toMatchObject({ name: "Ended" });
		expect((groups().at(-1)?.titles ?? []).slice().sort()).toEqual(names(ended));
	});

	it("reads the ended ones from the server a page at a time, and starts again under a filter", async () => {
		await show("/factory", { items: "many" });
		const all = await listed();
		const ended = all.filter(item => item.question === null && ["done", "failed", "cancelled"].includes(item.state));
		expect(ended.length).toBeGreaterThan(2 * ITEM_PAGE_DEFAULT);
		// Nothing is asked of the server until they are unfolded.
		expect(paged).toEqual([]);
		act(() => button(`Show ${ended.length} ended items`).click());
		await settle();
		const endedRows = () => groups().find(group => group.name === "Ended")?.titles ?? [];
		const byFiling = ended.slice().sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
		expect(endedRows()).toEqual(byFiling.slice(0, ITEM_PAGE_DEFAULT).map(item => item.title));
		expect(paged).toEqual([{ ended: true, before: null, limit: ITEM_PAGE_DEFAULT, repository: null, source: null }]);
		expect(host.textContent).toContain(`${ITEM_PAGE_DEFAULT} of ${ended.length} work items`);
		// The next page starts after the last row shown.
		act(() => button(`Show ${ITEM_PAGE_DEFAULT} more`).click());
		await settle();
		expect(endedRows()).toEqual(byFiling.slice(0, 2 * ITEM_PAGE_DEFAULT).map(item => item.title));
		const last = byFiling[ITEM_PAGE_DEFAULT - 1] as ItemSummary;
		expect(paged[1]).toMatchObject({ ended: true, before: { createdAt: last.createdAt, id: last.id } });
		// Under a filter, the server is asked for that repository's from the first page.
		await filter("repo", "acme/harbor");
		const harbor = byFiling.filter(item => item.repository.id === 7101);
		expect(paged.at(-1)).toMatchObject({ ended: true, before: null, repository: 7101 });
		expect(endedRows()).toEqual(harbor.slice(0, ITEM_PAGE_DEFAULT).map(item => item.title));
		// Read to the end: no more to show.
		for (let page = 0; page < 5 && host.textContent?.includes(`Show ${ITEM_PAGE_DEFAULT} more`); page++) {
			act(() => button(`Show ${ITEM_PAGE_DEFAULT} more`).click());
			await settle();
		}
		expect(endedRows()).toEqual(harbor.map(item => item.title));
		expect(host.textContent).not.toContain(`Show ${ITEM_PAGE_DEFAULT} more`);
	});

	it("shows a row's verdict, CI, second review, pull request and issue", async () => {
		await show("/factory");
		const ready = (await listed()).find(
			item =>
				item.state === "review" && item.review?.state === "filed" && item.verdict?.ci === "passed" && item.pullRequest,
		);
		expect(ready).toBeDefined();
		const row = rows().find(
			candidate => candidate.querySelector(".agent-title")?.firstChild?.textContent === ready?.title,
		) as HTMLElement;
		expect(row.querySelector(".item-verdict")).not.toBeNull();
		expect(row.textContent).toContain("CI passed");
		expect(row.querySelector(".item-row-review")?.textContent).toMatch(/^reviewed: /);
		expect(row.querySelector(`a[href="${ready?.pullRequest?.url}"]`)).not.toBeNull();
		const fromIssue = (await listed()).find(item => item.origin?.issue !== undefined) as ItemSummary;
		const issueRow = rows().find(
			candidate => candidate.querySelector(".agent-title")?.firstChild?.textContent === fromIssue.title,
		) as HTMLElement;
		expect(issueRow.querySelector(`a[href="${fromIssue.origin?.issue?.url}"]`)?.textContent).toBe(
			`issue #${fromIssue.origin?.issue?.number}`,
		);
	});

	it("filters by repository and by where an item came from, in the address", async () => {
		await show("/factory");
		const all = await listed();
		await filter("repo", "acme/harbor");
		expect(location.pathname).toBe("/factory");
		expect(new URLSearchParams(location.search).get("repository")).toBe("7101");
		const harbor =
			all.filter(
				item =>
					item.repository.id === 7101 &&
					item.question === null &&
					item.state !== "done" &&
					item.state !== "failed" &&
					item.state !== "cancelled",
			).length + all.filter(item => item.repository.id === 7101 && item.question !== null).length;
		expect(rows().length).toBe(harbor);
		expect(rows().every(row => row.querySelector(".agent-repo")?.textContent === "acme/harbor")).toBe(true);
		await filter("from", "GitHub issue");
		expect(new URLSearchParams(location.search).get("from")).toBe("github");
		expect(rows().length).toBeGreaterThan(0);
		expect(rows().every(row => row.textContent?.includes("issue #"))).toBe(true);
		await filter("from", "API");
		const api = all.filter(
			item =>
				item.repository.id === 7101 && item.source === "api" && !["done", "failed", "cancelled"].includes(item.state),
		);
		expect(rows().length).toBe(api.length);
		await filter("repo", "all");
		await filter("from", "all");
		expect(location.search).toBe("");
		expect(groups().map(group => group.name)).toContain("Needs you");
	});

	it("opens filtered from a link, and says when nothing matches", async () => {
		await show("/factory?repository=7101&from=web");
		expect(rows().length).toBeGreaterThan(0);
		expect(
			rows().every(
				row =>
					row.querySelector(".agent-repo")?.textContent === "acme/harbor" &&
					!row.textContent?.includes("issue #") &&
					!row.textContent?.includes("from the API"),
			),
		).toBe(true);
		act(() => root?.unmount());
		root = null;
		client.dispose();
		await show("/factory?repository=999");
		expect(host.textContent).toContain("No work item matches.");
		await act(async () => button("Show them all").click());
		await settle(4);
		expect(location.search).toBe("");
		expect(rows().length).toBeGreaterThan(0);
	});
});

describe("the live feed's ended items beyond its first page", () => {
	const isEnded = (item: ItemSummary) => ["done", "failed", "cancelled"].includes(item.state);
	const byFiling = (list: ItemSummary[]) =>
		list.slice().sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));

	it("dates the Factory's ended rows by when each was filed, the order they stand in", async () => {
		await show("/factory", { items: "many" });
		const ended = byFiling((await listed()).filter(item => item.question === null && isEnded(item)));
		act(() => button(`Show ${ended.length} ended items`).click());
		await settle();
		const dates = [
			...([...host.querySelectorAll(".factory-group")]
				.find(group => group.querySelector(".agent-group-name")?.textContent === "Ended")
				?.querySelectorAll(".agent-time") ?? []),
		];
		expect(dates.length).toBe(ITEM_PAGE_DEFAULT);
		const first = ended[0] as ItemSummary;
		const [filed, endedAt] = [...(dates[0]?.querySelectorAll("time") ?? [])];
		expect(filed?.getAttribute("dateTime")).toBe(new Date(first.createdAt).toISOString());
		expect(filed?.textContent).toMatch(/^filed \d{1,2} [A-Z][a-z]{2}/);
		// And when it ended, under it.
		expect(first.endedAt).toBeDefined();
		expect(endedAt?.getAttribute("dateTime")).toBe(new Date(first.endedAt!).toISOString());
		expect(endedAt?.textContent).toMatch(/^ended \d{1,2} [A-Z][a-z]{2}/);
		expect(dates.some(time => time.textContent?.includes("ago"))).toBe(false);
	});

	it("an ended item's page says when it was filed and when it ended", async () => {
		await show("/factory", { items: "many" });
		const one = (await listed()).find(item => isEnded(item) && item.endedAt !== undefined) as ItemSummary;
		const open = (await listed()).find(item => !isEnded(item)) as ItemSummary;
		const headerTimes = async (id: string) => {
			act(() => {
				history.pushState(null, "", `/items/${id}`);
				window.dispatchEvent(new PopStateEvent("popstate"));
			});
			await settle();
			return [...host.querySelectorAll<HTMLTimeElement>(".item-meta time")];
		};
		const ended = await headerTimes(one.id);
		expect(ended.map(time => time.dateTime)).toEqual([
			new Date(one.createdAt).toISOString(),
			new Date(one.endedAt!).toISOString(),
		]);
		expect(ended.map(time => time.textContent)).toEqual([
			expect.stringMatching(/^filed .+/),
			expect.stringMatching(/^ended .+/),
		]);
		const active = await headerTimes(open.id);
		expect(active.map(time => time.dateTime)).toEqual([new Date(open.createdAt).toISOString()]);
		expect(active[0]?.textContent).toMatch(/^filed .+/);
	});

	it("on a repository's Work items tab: the fold is said from the counts, and unfolded reads a page at a time", async () => {
		await show("/repositories/7101/items", { items: "many" });
		const ended = byFiling(
			(await listed()).filter(item => !item.parent && item.repository.id === 7101 && isEnded(item)),
		);
		expect(ended.length).toBeGreaterThan(ITEM_FEED_ENDED);
		// The feed carries fewer of them than there are: the fold's words are the counts'.
		const feed = await client.user(ada).itemFeed();
		expect(feed.ended.filter(item => item.repository.id === 7101).length).toBeLessThan(ended.length);
		const of = (state: string) => ended.filter(item => item.state === state).length;
		const words = ["done", "failed", "cancelled"]
			.filter(state => of(state) > 0)
			.map(state => `${of(state)} ${state}`)
			.join(", ");
		const section = () => host.querySelector('section[aria-labelledby="repo-items"]') as HTMLElement;
		expect(section().querySelector(".items-fold")?.textContent).toContain(words);
		expect(paged).toEqual([]);
		act(() => button(`Show ${ended.length} ended items`).click());
		await settle();
		const endedRows = () =>
			[...section().querySelectorAll(".items-group")]
				.find(group => group.querySelector(".items-group-head")?.firstChild?.textContent === "Ended")
				?.querySelectorAll(".agent-title") ?? [];
		const titles = () => [...endedRows()].map(title => title.firstChild?.textContent ?? "");
		expect(paged).toEqual([{ ended: true, before: null, limit: ITEM_PAGE_DEFAULT, repository: 7101, source: null }]);
		expect(titles()).toEqual(ended.slice(0, ITEM_PAGE_DEFAULT).map(item => item.title));
		expect(section().textContent).toContain(`${ITEM_PAGE_DEFAULT} of ${ended.length}`);
		act(() => button(`Show ${ITEM_PAGE_DEFAULT} more`).click());
		await settle();
		const last = ended[ITEM_PAGE_DEFAULT - 1] as ItemSummary;
		expect(paged[1]).toMatchObject({
			ended: true,
			repository: 7101,
			before: { createdAt: last.createdAt, id: last.id },
		});
		expect(titles()).toEqual(ended.slice(0, 2 * ITEM_PAGE_DEFAULT).map(item => item.title));
	});

	it("on the usage page: a row for each item the feed carries, and how many older ended ones there are", async () => {
		await show("/usage#usage-items", { items: "many" });
		const feed = await client.user(ada).itemFeed();
		expect(feed.counts.ended).toBeGreaterThan(feed.ended.length);
		const table = host.querySelector(".factory-cost") as HTMLElement;
		expect(table.querySelectorAll("tbody tr")).toHaveLength(10);
		const total = feed.open.length + feed.ended.length;
		act(() => button(`Show ${total - 10} more`).click());
		expect(table.querySelectorAll("tbody tr")).toHaveLength(total);
		const older = feed.counts.ended - feed.ended.length;
		const note = host.querySelector(".factory-cost-older") as HTMLElement;
		expect(note.textContent).toBe(`And ${older} older ended items, listed under Ended on the Factory page.`);
		expect(note.querySelector("a")?.getAttribute("href")).toBe("/factory");
	});

	it("on the usage page: each item's cost in dollars, or the plan that carried it, and the listed items' total", async () => {
		await show("/usage#usage-items", { items: "many" });
		await settle();
		const table = host.querySelector(".factory-cost") as HTMLElement;
		expect(table.querySelector("thead th:nth-child(2)")?.textContent).toBe("Cost");
		const costs = [...table.querySelectorAll("tbody tr td:nth-of-type(1)")].map(cell => cell.textContent ?? "");
		expect(costs.some(cost => /^\$\d/.test(cost))).toBe(true);
		expect(costs.some(cost => cost.includes("on your ChatGPT plan") || cost === "On your ChatGPT plan")).toBe(true);
		expect(costs.join(" ")).not.toContain("tokens");
		expect(host.querySelector(".factory-cost-total")?.textContent).toMatch(
			/^Cost of the items listed here: \$[\d,]+\.\d\d, plus what your plans carried\./,
		);
	});
});

describe("filing a work item from the Factory page", () => {
	it("files it with the composer on Work item, started, and stays: the row comes in through the live list", async () => {
		await show("/factory");
		const before = (await listed()).length;
		write("Add the tests command to the README\nSay how to run the unit tests, with its command.");
		expect(host.querySelector<HTMLInputElement>(".start-title input")?.value).toBe(
			"Add the tests command to the README",
		);
		// Its done-when criteria: one line under the text, opened only when used, one criterion a line.
		expect(pill("criteria")?.textContent).toBe("Add done-when criteria");
		expect(host.querySelector(".start-criteria-inline")).toBeNull();
		act(() => (pill("criteria") as HTMLButtonElement).click());
		write(
			"The README names the unit test command.\n\nIt says where the tests live.",
			host.querySelector(".start-criteria-inline textarea") as HTMLTextAreaElement,
		);
		// Done: a short list in its place.
		act(() => (host.querySelector(".start-criteria-done") as HTMLButtonElement).click());
		expect([...host.querySelectorAll(".start-criteria-list li")].map(line => line.textContent)).toEqual([
			"The README names the unit test command.",
			"It says where the tests live.",
		]);
		await act(
			async () =>
				void field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })),
		);
		await settle();
		expect(filed).toHaveLength(1);
		expect(filed[0]).toMatchObject({
			title: "Add the tests command to the README",
			body: "Say how to run the unit tests, with its command.",
			acceptance: ["The README names the unit test command.", "It says where the tests live."],
			start: true,
			repository: { branch: "main" },
		});
		expect(filed[0]?.idempotencyKey).toBeTruthy();
		expect(location.pathname).toBe("/factory");
		expect(field().value).toBe("");
		expect(host.querySelector(".start-criteria-list")).toBeNull();
		expect(host.querySelector(".start-filed")?.textContent).toBe(
			"Filed “Add the tests command to the README”: its plan comes to you for approval. Open",
		);
		expect((await listed()).length).toBe(before + 1);
		expect(groups().find(group => group.name === "Needs you")?.titles).toContain("Add the tests command to the README");
	});

	it("files the effort chosen with the item's agent and model", async () => {
		await show("/factory");
		act(() => (pill("agent") as HTMLButtonElement).click());
		act(() => (pop()?.querySelector('[data-value="windlass:gpt-6.1-sol"]') as HTMLElement).click());
		act(() => (pill("effort") as HTMLButtonElement).click());
		act(() => (pop()?.querySelector('[data-value="high"]') as HTMLElement).click());
		expect(pill("agent")?.getAttribute("data-value")).toBe("Windlass · GPT-6.1 Sol");
		expect(pill("effort")?.getAttribute("data-effort")).toBe("high");
		expect(pill("effort")?.querySelectorAll(".effort-bars .effort-bar-on").length).toBeGreaterThan(0);
		write("Rename the tide table columns");
		await act(
			async () =>
				void field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })),
		);
		await settle();
		expect(filed[0]).toMatchObject({ title: "Rename the tide table columns", model: "gpt-6.1-sol", effort: "high" });
		expect((await listed()).find(item => item.title === "Rename the tide table columns")?.agent).toMatchObject({
			harness: "windlass",
			effort: "high",
		});
	});

	it("files a draft from the line under it, into Drafts", async () => {
		await show("/factory");
		write("Rename the tide table columns again");
		act(() => (host.querySelector(".ui-split-more") as HTMLButtonElement).click());
		await act(async () =>
			(
				[...(pop()?.querySelectorAll('[role="menuitem"]') ?? [])].find(
					row => row.querySelector(".ui-item-label")?.textContent === "File as a draft",
				) as HTMLElement
			).click(),
		);
		await settle();
		expect(filed[0]).toMatchObject({
			title: "Rename the tide table columns again",
			body: "Rename the tide table columns again",
			start: false,
		});
		expect(groups().find(group => group.name === "Drafts")?.titles).toContain("Rename the tide table columns again");
		expect(host.querySelector(".start-filed")?.textContent).toBe(
			"Filed “Rename the tide table columns again” as a draft. Open",
		);
	});

	it("files nothing without a repository, and says so", async () => {
		await show("/factory", { items: "none", github: false });
		write("Add a health check");
		await act(
			async () =>
				void field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })),
		);
		await settle();
		expect(filed).toHaveLength(0);
		expect(host.querySelector(".start-status")?.textContent).toBe(
			"A work item needs a repository: choose one under “where”.",
		);
	});

	it("has the same tray as the Agents page: agent, effort, where (the place and the repository), options and File, on one line", async () => {
		await show("/factory");
		const tray = host.querySelector(".start-tools") as HTMLElement;
		expect([...tray.querySelectorAll("[data-picker]")].map(control => (control as HTMLElement).dataset.picker)).toEqual(
			["agent", "effort", "where", "options"],
		);
		expect(tray.querySelector(".start-launch")).not.toBeNull();
		expect(pill("where")?.dataset.repo).toMatch(/ @ main$/);
		// A work item chooses its agent and model too; it starts on Windlass.
		expect(pill("agent")?.getAttribute("data-value")).toMatch(/^Windlass · /);
	});
});

describe("the screenshots of a work item's repository", () => {
	it("are said in the repository's picker once one is chosen, with the way to its setting", async () => {
		await show("/factory", { items: "none", github: false });
		await openRepo();
		expect(pop()).not.toBeNull();
		expect(document.querySelector(".start-shots")).toBeNull();
		act(() => root?.unmount());
		root = null;
		client.dispose();
		await show("/factory");
		await openRepo();
		await settle();
		const note = document.querySelector(".start-shots") as HTMLElement;
		expect(note.textContent).toBe("Screenshots are off for this repository: turn them on.");
		expect(note.querySelector("a")?.getAttribute("href")).toMatch(/^\/repositories\/[0-9]+\/settings#screenshots$/);
	});
});

describe("the Factory page's first visit", () => {
	it("says what the factory does in three sentences under the composer, the GitHub label among them", async () => {
		await show("/factory", { items: "none" });
		const empty = host.querySelector(".factory-empty") as HTMLElement;
		expect(empty.querySelector("h2")?.textContent).toBe("No work items yet");
		const text = empty.querySelector("p")?.textContent ?? "";
		expect(text.split(/(?<=\.)\s+/)).toHaveLength(3);
		expect(text).toContain("labelling a GitHub issue windlass");
		expect(empty.querySelector("code")?.textContent).toBe("windlass");
		expect(host.querySelector(".start textarea")).not.toBeNull();
		expect(host.querySelector(".factory-filters")).toBeNull();
	});
});

describe("a deployment without the second review", () => {
	it("says so once under the heading, and no row has a word of it", async () => {
		await show("/factory", { reviewer: false });
		expect(host.querySelector(".factory-reviewer-off")?.textContent).toBe(
			"No second review on this deployment: the verdict rests on CI and your checks.",
		);
		act(() =>
			button(`Show ${host.querySelector(".factory-fold button")?.textContent?.replace(/^Show /, "")}`)?.click(),
		);
		expect(rows().length).toBeGreaterThan(0);
		expect(host.querySelectorAll(".item-row-review")).toHaveLength(0);
		expect(host.textContent).not.toMatch(/reviewed: |being reviewed|waiting for its reviewer/);
	});

	it("says it before any item exists", async () => {
		await show("/factory", { reviewer: false, items: "none" });
		expect(host.querySelector(".factory-reviewer-off")).not.toBeNull();
	});

	it("says nothing of it where the reviewer is on, and the rows keep its word", async () => {
		await show("/factory");
		expect(host.querySelector(".factory-reviewer-off")).toBeNull();
		expect(host.querySelectorAll(".item-row-review").length).toBeGreaterThan(0);
	});
});

describe("the Factory page's board", () => {
	beforeEach(() => {
		wide = true;
	});
	afterEach(() => {
		wide = false;
	});

	it("caps the tray at two rows and columns at eight, keeping totals when expanded", async () => {
		// The tray measures its columns when it mounts: three columns, so two rows hold six.
		const style = document.head.appendChild(document.createElement("style"));
		style.textContent = ".board-tray .board-cards { grid-template-columns: 320px 320px 320px; }";
		await show("/factory", { items: "many" });
		await settle(2);
		for (const [selector, limit] of [
			[".board-tray", 6],
			[".board-column-ready", 8],
			[".board-column-ended", 8],
		] as const) {
			const lane = host.querySelector(selector)!;
			const total = Number(lane.querySelector(".board-column-count")?.textContent);
			const count = () => lane.querySelectorAll(":scope > ul > li").length;
			const toggle = lane.querySelector("button")!;
			expect(count()).toBe(limit);
			expect(toggle.textContent).toBe(selector === ".board-tray" ? `Show all ${total}` : `Show ${total - limit} more`);
			act(() => toggle.click());
			await settle();
			expect(count()).toBe(total);
			expect(Number(lane.querySelector(".board-column-count")?.textContent)).toBe(total);
			expect(toggle.textContent).toBe("Show fewer");
			act(() => toggle.click());
			expect(count()).toBe(limit);
		}
		style.remove();
	});

	it("shows the board on a wide screen with no switch, and a feature as one card with its parts", async () => {
		await show("/factory", { items: "features" });
		await settle(2);
		expect(host.querySelector(".factory-board")).not.toBeNull();
		expect(host.querySelector(".factory-group")).toBeNull();
		expect(host.querySelector(".factory-view")).toBeNull();
		act(() => host.querySelector<HTMLButtonElement>(".board-tray .board-toggle")!.click());
		const titles = [...host.querySelectorAll(".board-card-title")].map(title => title.firstChild?.textContent ?? "");
		const top = (await listed()).filter(item => !item.parent);
		expect(titles.slice().sort()).toEqual(top.map(item => item.title).sort());
		const feature = [...host.querySelectorAll(".board-card")].find(card => card.querySelector(".board-part-asks"));
		expect(feature?.closest(".board-tray")).not.toBeNull();
		expect(feature?.querySelector(".board-card-action")?.textContent).toBe("Answer");
		// One figure a card: dollars, or the plan that carried it; a feature's counts its parts too.
		await settle();
		const costs = [...host.querySelectorAll(".board-card-cost")].map(cost => cost.textContent ?? "");
		expect(costs.some(cost => /^\$\d/.test(cost))).toBe(true);
		expect(costs.every(cost => cost === "" || /^\$\d|^On your/.test(cost))).toBe(true);
		expect(feature?.querySelector(".board-card-cost")?.textContent).not.toBe("");
	});

	it("draws an empty column as a slim strip and gives the width to the columns with cards", async () => {
		await show("/factory?repository=7101", { items: "many" });
		await settle(2);
		const slim = [...host.querySelectorAll(".board-column-slim")];
		const full = [...host.querySelectorAll(".board-pipeline > .board-column:not(.board-column-slim)")];
		expect(full.length).toBeGreaterThan(0);
		for (const column of slim) {
			expect(column.querySelector(".board-column-count")?.textContent).toBe("0");
			expect(column.querySelector("ul")).toBeNull();
		}
		const tracks = (host.querySelector(".board-pipeline") as HTMLElement).style.gridTemplateColumns.split(
			/ (?![^(]*\))/,
		);
		expect(tracks.filter(track => track === "44px").length).toBe(slim.length);
	});
});

describe("the Factory's rail and the way back", () => {
	it("lists each repository with what needs you and what is in progress", async () => {
		await show("/factory");
		const all = await listed();
		const row = [...host.querySelectorAll("nav.ws-rail a.ws-rail-row")].find(
			link => link.querySelector(".ws-rail-name")?.textContent === "harbor",
		) as HTMLAnchorElement;
		const needs = all.filter(item => item.repository.id === 7101 && item.question !== null).length;
		expect(row.getAttribute("href")).toBe("/factory?repository=7101");
		expect(Number(row.querySelector(".ws-badge-needs")?.textContent ?? 0)).toBe(needs);
		expect(host.querySelector('nav.ws-rail a.ws-rail-row[aria-current="page"] .ws-rail-name')?.textContent).toBe(
			"Everything",
		);
		// The rail stands for the repository filter; "from" stays a chip.
		expect(host.querySelector('.factory-filters [data-picker="repository"]')).toBeNull();
		expect(host.querySelector('.factory-filters [data-picker="from"]')).not.toBeNull();
		// The Agents home's rail: its search, its owners and its foot; a work item is always on a repository, so no "No repository".
		const rail = host.querySelector("nav.ws-rail") as HTMLElement;
		expect(rail.querySelector(".ws-search input")).not.toBeNull();
		expect(rail.querySelector(".ws-rail-owner-row")).not.toBeNull();
		expect(rail.querySelector(".ws-rail-foot")?.getAttribute("href")).toMatch(/^\/usage/);
		expect([...rail.querySelectorAll(".ws-rail-name")].map(name => name.textContent)).not.toContain("No repository");
	});

	it("opens an item from a filtered Factory with the Factory lit and a way back to that filter, and Back brings the ended ones back", async () => {
		await show("/factory?repository=7101");
		const fold = [...host.querySelectorAll("button")].find(one =>
			/^Show \d+ ended/.test(one.textContent ?? ""),
		) as HTMLButtonElement;
		act(() => fold.click());
		await settle(2);
		expect(host.textContent).toContain("Hide the ended ones");
		const link = host.querySelector<HTMLAnchorElement>(
			".factory-group .item-row a[href^='/items/']",
		) as HTMLAnchorElement;
		await act(async () => link.click());
		await settle();
		expect(location.pathname).toMatch(/^\/items\//);
		expect(tab("Factory")?.getAttribute("aria-current")).toBe("page");
		expect(tab("Factory")?.textContent).toMatch(/need you$/);
		const back = host.querySelector(".nav-back") as HTMLAnchorElement;
		expect(back.textContent).toBe("Factory · harbor");
		expect(back.getAttribute("href")).toBe("/factory?repository=7101");
		expect([...host.querySelectorAll(".trail .trail-link")].map(crumb => crumb.textContent)).toEqual([
			"Factory",
			"harbor",
		]);
		expect(host.querySelector(".trail a[href='/factory?repository=7101']")).not.toBeNull();
		await act(async () => back.click());
		await new Promise(resolve => window.addEventListener("popstate", resolve, { once: true }));
		await settle();
		expect(location.search).toBe("?repository=7101");
		expect(host.textContent).toContain("Hide the ended ones");
	});
});
