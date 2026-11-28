// @vitest-environment jsdom
/**
 * The page credits the issue author, and the list row links to the issue. On a draft from an
 * outside author, the page shows the original text and an author warning before Start.
 */
import type { AuthResult, ItemAction, ItemSummary, ItemView } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserApi } from "../api/client";
import { createMockClient, type MockClient } from "../api/mock";
import { saveAuth } from "../lib/authStore";
import { href, parseRoute } from "../lib/router";
import { filterItems } from "./Factory";
import { AppProvider } from "../state/app";
import { Item, useItem } from "./Item";
import { RepositoryPane, useRepository } from "./Repository";
import { useItems } from "../state/items";
import { ItemRow } from "../components/ItemRow";
import { NO_FILTERS } from "../lib/workspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let client: MockClient;
let items: ItemSummary[];
/** What the page asked the server to do, in order. */
let acted: ItemAction[];

async function wait(steps = 8): Promise<void> {
	for (let step = 0; step < steps; step++) await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
}

/** Signs in to the mock and renders `screen`, once the list is known. `change` rewrites each item page the server answers. */
async function render(
	screen: () => ReturnType<typeof createElement>,
	change: (view: ItemView) => ItemView = view => view,
): Promise<void> {
	client = createMockClient({ origin: "http://localhost:5173" });
	const begun = client.login.start();
	await vi.advanceTimersByTimeAsync(1000);
	const { redirectPrefix, url } = await begun;
	const finished = client.login.finish(`${redirectPrefix}?code=abc&state=${new URL(url).searchParams.get("state")}`);
	await vi.advanceTimersByTimeAsync(1000);
	const auth: AuthResult = await finished;
	saveAuth("mock", auth);
	const listed = client.user(auth).listItems();
	await vi.advanceTimersByTimeAsync(1000);
	items = await listed;
	const user = client.user.bind(client);
	(client as { user: (auth: AuthResult) => UserApi }).user = who => {
		const api = user(who);
		return {
			...api,
			item: (id: string) => api.item(id).then(change),
			actOnItem: (id: string, action: ItemAction) => (acted.push(action), api.actOnItem(id, action)),
		};
	};
	function Screen() {
		return screen();
	}
	act(() => root.render(createElement(AppProvider, { client, children: createElement(Screen) })));
	await wait();
}

const fromIssue = (trusted: boolean) => items.find(item => item.origin?.issue?.trusted === trusted) as ItemSummary;
const itemPage = (pick: () => ItemSummary) => () => createElement(Item, { page: useItem(pick().id, true) });
const buttons = (scope: ParentNode, label: string) =>
	[...scope.querySelectorAll("button")].filter(button => button.textContent === label);

beforeEach(() => {
	vi.useFakeTimers();
	acted = [];
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	client.dispose();
	saveAuth("mock", null);
	vi.useRealTimers();
});

describe("an item from a GitHub issue", () => {
	it("links the issue and credits its author when someone else filed it", async () => {
		await render(itemPage(() => fromIssue(false)));
		const draft = fromIssue(false);
		expect(draft.origin).toMatchObject({ issue: { number: 42, author: "harbor-user" }, sender: "ada" });
		expect(host.querySelector(".item-meta")?.textContent).toContain("Quick");
		const line = host.querySelector(".item-origin") as HTMLElement;
		expect(line.textContent).toBe("from #42 by @harbor-user");
		const link = line.querySelector("a") as HTMLAnchorElement;
		expect(link.getAttribute("href")).toBe("https://github.com/acme/harbor/issues/42");
		expect(link.target).toBe("_blank");
		expect(link.rel).toBe("noreferrer");
	});

	it("credits a trusted issue author and shows the filing source for web items", async () => {
		await render(itemPage(() => fromIssue(true)));
		expect(host.querySelector(".item-origin")?.textContent).toBe("from #37 by @ada");
		expect(host.querySelector(".item-origin a")?.getAttribute("href")).toBe("https://github.com/acme/harbor/issues/37");
		act(() => root.unmount());
		client.dispose();
		root = createRoot(host);
		await render(itemPage(() => items.find(item => item.source === "web") as ItemSummary));
		expect(host.querySelector(".item-origin")).toBeNull();
		expect(host.querySelector(".item-meta")?.textContent).toContain("from the web");
	});

	it("links to its issue from its row in the work list, and a row from the web has no such link", async () => {
		await render(() =>
			createElement(RepositoryPane, {
				page: useRepository(7101),
				view: "items",
				items: useItems(true),
				filters: NO_FILTERS,
				onFilters: () => undefined,
				machines: [],
			}),
		);
		const section = host.querySelector("section[aria-labelledby='repo-items']") as HTMLElement;
		const rowOf = (item: ItemSummary) =>
			[...section.querySelectorAll("li.item-row")].find(row =>
				row.querySelector(".agent-title")?.textContent?.startsWith(item.title),
			) as HTMLElement;
		for (const item of [fromIssue(false), fromIssue(true)]) {
			const issue = item.origin?.issue as NonNullable<NonNullable<ItemSummary["origin"]>["issue"]>;
			const links = [...rowOf(item).querySelectorAll("a")].filter(link => link.getAttribute("href") === issue.url);
			expect(links.map(link => link.textContent)).toEqual([`issue #${issue.number}`]);
			expect(links[0]?.getAttribute("aria-label")).toBe(`Issue #${issue.number} on GitHub`);
			expect(links[0]?.target).toBe("_blank");
		}
		// The trusted one has a pull request too: both stand in its facts, the pull request first.
		expect(
			[...rowOf(fromIssue(true)).querySelectorAll(".agent-meta a.item-pull")].map(link => link.textContent),
		).toEqual(["#49", "issue #37", "its agent"]);
		const web = items.find(item => item.repository.id === 7101 && item.source === "web") as ItemSummary;
		expect([...rowOf(web).querySelectorAll("a")].some(link => link.textContent?.startsWith("issue #"))).toBe(false);
	});

	it("as a draft of someone else's issue, says whose text it is before the one Start, which starts it", async () => {
		await render(itemPage(() => fromIssue(false)));
		// Start is not in the header: it stands under the text it starts.
		expect(buttons(host.querySelector(".item-actions") as HTMLElement, "Start")).toEqual([]);
		const starts = buttons(host, "Start");
		expect(starts).toHaveLength(1);
		const task = host.querySelector("section[aria-labelledby='item-task']") as HTMLElement;
		expect(host.querySelectorAll("section[aria-labelledby='item-task']")).toHaveLength(1);
		const note = task.querySelector(".callout") as HTMLElement;
		expect(note.textContent).toBe(
			"The text below was written by @harbor-user on GitHub, not by you. Starting the item gives the agent this text, as it is shown here.",
		);
		expect(host.querySelector(".item-now-text")?.textContent).toBe("A draft: read its task below, then start it.");
		// In reading order: the line, then the text, then Start.
		const snapshot = task.querySelector(".item-snapshot") as HTMLElement;
		expect(note.compareDocumentPosition(snapshot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(snapshot.compareDocumentPosition(starts[0] as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(snapshot.textContent).toContain("Print what the release script would upload and tag, without doing it.");
		expect(snapshot.textContent).toContain("@harbor-user wrote: Nothing is uploaded or tagged with --dry-run.");
		// One press starts it, with no dialog between.
		await act(async () => (starts[0] as HTMLButtonElement).click());
		await wait();
		expect(acted).toEqual([{ kind: "start" }]);
		expect(host.querySelector("dialog")).toBeNull();
		expect(host.querySelector(".item-snapshot")).toBeNull();
		expect(host.querySelector(".item-now-state")?.textContent).not.toMatch(/^Draft/);
	});

	it("shows the snapshot as the literal text the agent is given, never as HTML, Markdown or links", async () => {
		const hostile =
			"<b>x</b> and <img src=x onerror=alert(1)>\n[a](javascript:alert(1)) and **bold** and https://example.com/";
		await render(
			itemPage(() => fromIssue(false)),
			view => ({
				...view,
				task: {
					...view.task,
					body: `${view.task.body}\n${hostile}`,
					acceptance: [...view.task.acceptance, "@harbor-user wrote: [b](javascript:alert(2)) <i>y</i>"],
				},
			}),
		);
		const snapshot = host.querySelector(".item-snapshot") as HTMLElement;
		expect(snapshot.querySelector(".item-body-text")?.textContent).toContain(hostile);
		expect(snapshot.textContent).toContain("<b>x</b>");
		expect(snapshot.textContent).toContain("[a](javascript:alert(1))");
		expect(snapshot.textContent).toContain("@harbor-user wrote: [b](javascript:alert(2)) <i>y</i>");
		expect(snapshot.querySelectorAll("a, b, i, img, strong, em")).toHaveLength(0);
	});

	it("as a draft from the web, or from the person's own issue, keeps Start in the header and its task where it was", async () => {
		await render(
			itemPage(() => fromIssue(false)),
			view => ({
				...view,
				origin: view.origin?.issue ? { ...view.origin, issue: { ...view.origin.issue, trusted: true } } : view.origin,
			}),
		);
		expect(buttons(host.querySelector(".item-actions") as HTMLElement, "Start")).toHaveLength(1);
		expect(buttons(host, "Start")).toHaveLength(1);
		expect(host.querySelector(".item-snapshot")).toBeNull();
		expect(host.querySelector(".item-now-text")?.textContent).toBe("A draft: nothing runs until you start it.");
		expect(host.querySelector("section[aria-labelledby='item-task'] .callout")).toBeNull();
	});
});

describe.each([
	{
		source: "linear",
		tracker: "Linear",
		key: "ENG-123",
		author: "Grace Hopper",
		url: "https://linear.app/acme/issue/ENG-123/show-the-release-channel",
	},
	{
		source: "jira",
		tracker: "Jira",
		key: "REL-42",
		author: "Sam Lee",
		url: "https://acme.atlassian.net/browse/REL-42",
	},
])("an item from $tracker", ({ source, tracker, key, author, url }) => {
	it("links its key to the issue and warns of the outside author before Start", async () => {
		await render(itemPage(() => items.find(item => item.source === source)!));
		const line = host.querySelector(".item-origin") as HTMLElement;
		expect(line.textContent).toBe(`from ${key} by ${author}`);
		const link = line.querySelector("a") as HTMLAnchorElement;
		expect(link.textContent).toBe(key);
		expect(link.getAttribute("href")).toBe(url);
		expect(link.target).toBe("_blank");
		const note = host.querySelector("section[aria-labelledby='item-task'] .callout") as HTMLElement;
		expect(note.textContent).toBe(
			`The text below was written by ${author} on ${tracker}, not by you. Starting the item gives the agent this text, as it is shown here.`,
		);
		expect(buttons(host, "Start")).toHaveLength(1);
	});

	it("links its row to the issue and flags the outside author", async () => {
		await render(() =>
			createElement(RepositoryPane, {
				page: useRepository(7101),
				view: "items",
				items: useItems(true),
				filters: NO_FILTERS,
				onFilters: () => undefined,
				machines: [],
			}),
		);
		const link = [...host.querySelectorAll("li.item-row a")].find(one => one.textContent === key) as HTMLAnchorElement;
		expect(link.getAttribute("href")).toBe(url);
		expect(link.getAttribute("aria-label")).toBe(`Issue ${key} on ${tracker}`);
		expect(link.closest("li")?.textContent).toContain("from an outside author");
	});
});

describe("an item filed from Slack", () => {
	it("names Slack in the header without attributing the task to an issue author", async () => {
		await render(
			itemPage(() => fromIssue(false)),
			view => ({ ...view, source: "slack", origin: null }),
		);
		expect(host.querySelector(".item-meta")?.textContent).toContain("from Slack");
		expect(host.querySelector(".item-origin")).toBeNull();
		expect(host.querySelector(".item-snapshot")).toBeNull();
		expect(buttons(host.querySelector(".item-actions") as HTMLElement, "Start")).toHaveLength(1);
	});

	it("filters Slack rows from the Factory address and names the source without an issue link", async () => {
		const url = new URL(href({ name: "factory", from: "slack" }), location.origin);
		const route = parseRoute(url.pathname, url.search);
		expect(route).toEqual({ name: "factory", from: "slack" });
		if (route.name !== "factory") throw new Error("Expected the Factory route");
		await render(() => {
			const slack: ItemSummary = { ...fromIssue(false), source: "slack", origin: null };
			const matches = filterItems([fromIssue(true), slack], route);
			return createElement(
				"ul",
				null,
				matches.map(item => createElement(ItemRow, { key: item.id, item, now: Date.now() })),
			);
		});
		expect(host.querySelectorAll(".item-row")).toHaveLength(1);
		expect(host.querySelector(".agent-meta")?.textContent).toContain("from Slack");
		expect(host.querySelector(".agent-meta a[aria-label^='Issue']")).toBeNull();
	});
});
