// @vitest-environment jsdom
/**
 * The Agents home against the mock: the rail of repositories grouped by owner with their badges,
 * a repository's old addresses landing in it with that repository chosen, the filters and how the
 * browser remembers them, `/` to the rail's search and the arrow keys through it, and Ctrl+B.
 */
import type { AuthResult } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient, type MockClient } from "../api/mock";
import { App } from "../App";
import { saveAuth } from "../lib/authStore";
import { AppProvider } from "../state/app";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The whole app renders here: beside the other files on a busy machine, its first render can take longer than the default 5 s.
vi.setConfig({ testTimeout: 30_000 });
// jsdom has no media queries: the theme reads one, and a wide screen matches none of the app's.
window.matchMedia ??= ((query: string) => ({
	matches: false,
	media: query,
	onchange: null,
	addEventListener() {},
	removeEventListener() {},
	addListener() {},
	removeListener() {},
	dispatchEvent: () => false,
})) as typeof window.matchMedia;
// jsdom lays nothing out.
Element.prototype.scrollIntoView ??= () => undefined;

const ada: AuthResult = {
	token: "mock:user:u_ada:ada@example.com",
	profile: { uid: "u_ada", email: "ada@example.com", demo: false },
};

let host: HTMLElement;
let root: Root | null;
let client: MockClient;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = null;
	localStorage.removeItem("wlp.workspace.filters");
	localStorage.removeItem("wlp.workspace.rail");
	localStorage.removeItem("wlp.workspace.folded-owners");
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

async function show(path: string, items?: "many"): Promise<void> {
	history.replaceState(null, "", path);
	client = createMockClient({ pace: 0, origin: "http://localhost:5173", items });
	saveAuth("mock", ada);
	root = createRoot(host);
	act(() => root?.render(createElement(AppProvider, { client, children: createElement(App) })));
	await settle();
}

const rail = () => host.querySelector('nav.ws-rail[aria-label="Repositories"]') as HTMLElement;
const owners = () =>
	[...rail().querySelectorAll(".ws-rail-group")].map(group => ({
		owner: group.querySelector(".ws-rail-owner-name")?.textContent ?? "",
		names: [...group.querySelectorAll(".ws-rail-name")].map(name => name.textContent),
	}));
const ownerRow = (owner: string) =>
	[...rail().querySelectorAll<HTMLButtonElement>(".ws-rail-owner-row")].find(
		button => button.querySelector(".ws-rail-owner-name")?.textContent === owner,
	) as HTMLButtonElement;
const row = (name: string) =>
	[...rail().querySelectorAll<HTMLAnchorElement>("a.ws-rail-row")].find(
		link => link.querySelector(".ws-rail-name")?.textContent === name,
	) as HTMLAnchorElement;
const current = () => rail().querySelector('a.ws-rail-row[aria-current="page"] .ws-rail-name')?.textContent;
const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) =>
	act(() => void target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })));

describe("the rail", () => {
	it("groups the repositories by owner, with Everything and No repository at its top and the day's meter at its foot", async () => {
		await show("/?mock=1");
		const groups = owners();
		expect(groups.map(group => group.owner)).toEqual(expect.arrayContaining(["acme", "ada"]));
		const acme = groups.find(group => group.owner === "acme");
		expect(acme?.names).toEqual(
			expect.arrayContaining(["harbor", "lighthouse-docs", "signal-flags", "quay", "old-pier"]),
		);
		// The repositories with only saved settings come after those with work.
		expect(acme?.names.slice(-2).sort()).toEqual(["old-pier", "quay"]);
		const tops = [...rail().querySelectorAll(".ws-rail-rows")][0] as HTMLElement;
		expect([...tops.querySelectorAll(".ws-rail-name")].map(name => name.textContent)).toEqual([
			"Everything",
			"No repository",
		]);
		expect(current()).toBe("Everything");
		expect(rail().querySelector(".ws-rail-foot")?.textContent).toMatch(/Hosted time today.* kept sandboxes/);
		expect(rail().querySelector(".ws-rail-foot")?.getAttribute("href")).toBe("/usage?mock=1");
	});

	it("badges each repository: the amber count of what asks, a ring while something runs, nothing for a quiet one, or saved", async () => {
		await show("/");
		const harbor = row("harbor");
		expect(Number(harbor.querySelector(".ws-badge-needs")?.textContent)).toBeGreaterThan(0);
		expect(harbor.querySelector(".ws-badge-running")).not.toBeNull();
		expect(harbor.textContent).toMatch(/needs? you/);
		// Each row has the repository's tile.
		expect(harbor.querySelector(".repo-tile")?.textContent).toBe("Ha");
		expect(row("quay").querySelector(".ws-badge-saved")?.textContent).toBe("saved");
		// A quiet repository shows no count, and its row steps back.
		expect(row("signal-flags").querySelector(".ws-badge-count")).toBeNull();
		expect(row("signal-flags").parentElement?.classList.contains("ws-rail-quiet")).toBe(true);
		expect(harbor.parentElement?.classList.contains("ws-rail-quiet")).toBe(false);
		// Each row has its actions: a new agent there, and its saved settings.
		const actions = [...(harbor.parentElement?.querySelectorAll(".ws-rail-action") ?? [])].map(link =>
			link.getAttribute("href"),
		);
		expect(actions).toEqual(["/repositories/7101/new", "/repositories/7101/settings"]);
	});

	it("repeats the repositories with something running or asking under Active now", async () => {
		await show("/");
		const active = [...rail().querySelectorAll(".ws-rail-active .ws-rail-name")].map(name => name.textContent);
		expect(active).toEqual(expect.arrayContaining(["harbor", "tide-tables"]));
		expect(active).not.toContain("quay");
		expect(active).not.toContain("signal-flags");
	});

	it("folds an owner's repositories away from its row, which this browser remembers, and shows them again for a search", async () => {
		await show("/");
		const acme = ownerRow("acme");
		expect(acme.getAttribute("aria-expanded")).toBe("true");
		expect(acme.querySelector("img.owner-avatar")?.getAttribute("src")).toBe("https://github.com/acme.png?size=40");
		act(() => acme.click());
		expect(ownerRow("acme").getAttribute("aria-expanded")).toBe("false");
		expect(owners().find(group => group.owner === "acme")?.names).toEqual([]);
		expect(JSON.parse(localStorage.getItem("wlp.workspace.folded-owners") ?? "[]")).toEqual(["acme"]);
		const search = rail().querySelector(".ws-search input") as HTMLInputElement;
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, "harb");
			search.dispatchEvent(new Event("input", { bubbles: true }));
		});
		// The mock's GitLab project acme/tools/harbor is found too, under its own group.
		expect(owners()).toEqual([
			{ owner: "acme", names: ["harbor"] },
			{ owner: "acme/tools", names: ["harbor"] },
		]);
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, "");
			search.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => ownerRow("acme").click());
		expect(owners().find(group => group.owner === "acme")?.names.length).toBeGreaterThan(0);
		expect(localStorage.getItem("wlp.workspace.folded-owners")).toBeNull();
	});

	it("puts the focus in its search with /, finds by name, opens the first match with Enter, and moves through the rows with the arrow keys", async () => {
		await show("/");
		const search = rail().querySelector(".ws-search input") as HTMLInputElement;
		press("/");
		expect(document.activeElement).toBe(search);
		// In a field, / is a character like any other.
		const composer = host.querySelector(".start textarea") as HTMLTextAreaElement;
		composer.focus();
		press("/", {}, composer);
		expect(document.activeElement).toBe(composer);

		search.focus();
		act(() => {
			const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			set?.call(search, "tide");
			search.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(owners()).toEqual([{ owner: "ada", names: ["tide-tables"] }]);
		press("Enter", {}, search);
		await settle(4);
		expect(location.pathname).toBe("/repositories/7102");

		press("Escape", {}, search);
		expect(owners().length).toBeGreaterThan(1);
		press("ArrowDown", {}, search);
		expect(document.activeElement?.textContent).toMatch(/^Everything/);
		press("ArrowDown", {}, document.activeElement as HTMLElement);
		expect(document.activeElement?.textContent).toMatch(/^No repository/);
		press("End", {}, document.activeElement as HTMLElement);
		expect(document.activeElement).toBe([...rail().querySelectorAll("[data-rail-row]")].at(-1));
		press("Home", {}, document.activeElement as HTMLElement);
		press("ArrowUp", {}, document.activeElement as HTMLElement);
		expect(document.activeElement).toBe(search);
	});

	it("folds away with Ctrl+B and comes back, and the browser remembers it", async () => {
		await show("/");
		press("b", { ctrlKey: true });
		expect(rail().hasAttribute("inert")).toBe(true);
		expect(localStorage.getItem("wlp.workspace.rail")).toBe("folded");
		act(() => (host.querySelector(".ws-unfold") as HTMLButtonElement).click());
		expect(rail().hasAttribute("inert")).toBe(false);
		expect(localStorage.getItem("wlp.workspace.rail")).toBeNull();
	});
});

describe("Everything", () => {
	it("is one feed: Needs you, Working now and Recent, each newest first, the repository a label on each row, and no list by repository", async () => {
		await show("/");
		const pane = host.querySelector(".ws-pane") as HTMLElement;
		expect([...pane.querySelectorAll(".feed-heading")].map(heading => heading.firstChild?.textContent)).toEqual([
			"Needs you",
			"Working now",
			"Recent",
		]);
		expect(pane.textContent).not.toContain("By repository");
		expect(pane.querySelectorAll(".agent-group-head")).toHaveLength(0);
		for (const section of pane.querySelectorAll(".feed")) {
			const times = [...section.querySelectorAll(".feed-time")].map(time =>
				Date.parse(time.getAttribute("datetime") ?? ""),
			);
			expect(times).toEqual([...times].sort((a, b) => b - a));
		}
		// What asks: Answer for an agent, Open for a work item; each with its repository's tile and name, or none.
		const needs = pane.querySelector(".feed-needs") as HTMLElement;
		for (const row of needs.querySelectorAll(".feed-row"))
			expect(row.querySelector(".feed-button")?.textContent).toBe(
				(row as HTMLElement).dataset.kind === "agent" ? "Answer" : "Open",
			);
		expect(needs.querySelectorAll(".feed-row").length).toBeGreaterThan(0);
		const itemRow = needs.querySelector('.feed-row[data-kind="item"]') as HTMLElement;
		expect(itemRow.querySelector(".feed-repo .repo-tile")).not.toBeNull();
		// What it asks is the shared long-text clamp, at two lines, under the agent's line.
		const asked = itemRow.querySelector(".feed-main .long-text-body") as HTMLElement;
		expect(asked.dataset.clamped).toBe("true");
		expect(asked.style.getPropertyValue("--lines")).toBe("2");
		expect(itemRow.querySelector(".feed-repo")?.getAttribute("href")).toMatch(/^\/repositories\/\d+$/);
		// The filter sits on Recent's heading.
		expect(pane.querySelector(".feed-recent .ws-filter-button")).not.toBeNull();
	});
});

describe("a repository's old addresses", () => {
	it("land in the Agents home with the repository chosen, its head, composer and overview", async () => {
		await show("/repositories/7101");
		expect(current()).toBe("harbor");
		expect(host.querySelector(".ws-head .ws-owner")?.textContent).toBe("acme");
		expect(host.querySelector(".ws-head .ws-title")?.textContent).toBe("harbor");
		expect(host.querySelector(".ws-start .start textarea")).not.toBeNull();
		expect([...host.querySelectorAll('[role="tab"]')].map(tab => tab.textContent?.replace(/\d+$/, ""))).toEqual([
			"Overview",
			"Agents",
			"Work items",
		]);
		expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Overview");
		const setup = host.querySelector("#repo-setup")!;
		for (const words of [
			"Setup 3 of 8",
			"Level: Not ready",
			"CI history (30 days): 94% green on main",
			"1 flaky job: e2e (macos)",
			"0 reverts",
			"1 red commit after a merge",
			"Track record:",
			"sent back",
			"Finish setup to reach Ask first.",
		])
			expect(setup.textContent).toContain(words);
		const file = [...setup.querySelectorAll("button")].find(
			b => b.textContent === "File as work item: fix intermittent failures in e2e (macos)",
		)!;
		act(() => file.click());
		await settle();
		expect(setup.querySelector(".setup-summary a")?.textContent).toBe("Open work item");
		expect(host.querySelector("#repo-agents")).not.toBeNull();
		expect(host.querySelector(".ws-items")).not.toBeNull();
		expect(document.title).toBe("acme/harbor · Windlass");
		// The bar says the page is part of Agents.
		expect(host.querySelector('nav[aria-label="Main"] a[aria-current="page"]')?.textContent).toMatch(/^Agents/);
	});

	it("offers small-plan approval once clean items and a working setup earn it", async () => {
		await show("/repositories/7101", "many");
		const setup = host.querySelector("#repo-setup")!;
		const offer = () =>
			[...setup.querySelectorAll("label")].find(l => l.textContent?.includes("This repo earned Small plans"));
		expect(offer()).toBeUndefined();
		await act(async () => (setup.querySelector("header button") as HTMLButtonElement).click());
		await settle();
		expect(setup.textContent).toContain("Level: Small plans");
		expect(setup.textContent).toContain("0 of 3 verified features toward Full plans");
		const toggle = offer()!.querySelector("input")!;
		expect(toggle.checked).toBe(false);
		await act(async () => toggle.click());
		await settle();
		expect(offer()).toBeUndefined();
		expect((await client.user(ada).repository(7101)).defaults.autoApprovePlans).toBe(true);
	});

	it("open its saved settings and its pull requests in the same place, with the way back to the overview", async () => {
		await show("/repositories/7101/settings");
		expect(current()).toBe("harbor");
		expect(
			host.querySelector(".repo-saved, #defaults, [id='repo-defaults']") ??
				host.querySelector(".ws-pane .usage-section"),
		).not.toBeNull();
		expect(host.querySelector('.ws-head-actions a[aria-current="page"]')?.textContent).toBe("Saved settings");
		expect(host.querySelector(".ws-back a")?.getAttribute("href")).toBe("/repositories/7101");
		expect(document.title).toBe("acme/harbor · Settings · Windlass");
		act(() => (host.querySelector(".ws-head-actions a") as HTMLAnchorElement).click());
		await settle(4);
		expect(location.pathname).toBe("/repositories/7101/pulls");
		expect(host.querySelector("#repo-pulls")?.textContent).toMatch(/^Open pull requests/);
	});

	it("that launched a new agent there now show it, with the composer focused", async () => {
		await show("/repositories/7101/new");
		expect(current()).toBe("harbor");
		expect(document.activeElement).toBe(host.querySelector(".ws-start .start textarea"));
		await show2("/repositories/7101/settings/new");
		expect(current()).toBe("harbor");
	});

	it("/repositories/none shows the agents on no repository", async () => {
		await show("/repositories/none");
		expect(current()).toBe("No repository");
		expect(host.querySelector(".ws-pane h1")?.textContent).toBe("No repository");
		expect(host.querySelectorAll(".agent-group-head")).toHaveLength(0);
	});
});

/** A second address in the same test: the first app is taken down first. */
async function show2(path: string): Promise<void> {
	if (root) act(() => root?.unmount());
	client.dispose();
	await show(path);
}

describe("the filters", () => {
	const menuRow = (label: string) =>
		[
			...document.querySelectorAll<HTMLElement>(
				'[role="menuitemcheckbox"], [role="menuitemradio"], [role="menuitem"], [role="option"]',
			),
		].find(element => element.textContent?.includes(label)) as HTMLElement;

	it("are chosen from the list's header, narrow the rail and the lists, and are remembered by the browser", async () => {
		await show("/repositories/7101");
		const before = owners().flatMap(group => group.names);
		const button = host.querySelector(".ws-tabs-row .ws-filter-button") as HTMLButtonElement;
		expect(button.textContent).toBe("Filter");
		act(() => button.click());
		await settle(2);
		for (const group of ["Status", "Agent", "Runs on", "Kind"]) expect(document.body.textContent).toContain(group);
		act(() => menuRow("Needs you").click());
		await settle(2);
		expect(JSON.parse(localStorage.getItem("wlp.workspace.filters") ?? "{}")).toMatchObject({ status: ["needs"] });
		// The saved-only repositories have nothing that asks: they leave the rail.
		const after = owners().flatMap(group => group.names);
		expect(after.length).toBeLessThan(before.length);
		expect(after).not.toContain("quay");
		// The chosen repository stays.
		expect(after).toContain("harbor");
		// Every work item left on the overview asks something.
		const tags = [...host.querySelectorAll(".ws-items .ws-tag")].map(tag => tag.textContent);
		expect(tags.length).toBeGreaterThan(0);
		expect(new Set(tags)).toEqual(new Set(["Needs you"]));
		expect([...host.querySelectorAll(".ws-chip")].map(chip => chip.textContent)).toEqual(["Needs you"]);
	});

	it("come back as the browser kept them, show in the rail's button, and each chip takes its filter off", async () => {
		localStorage.setItem("wlp.workspace.filters", JSON.stringify({ status: [], agent: [], place: [], kind: ["item"] }));
		await show("/");
		expect(rail().querySelector(".ws-filter-button")?.getAttribute("aria-label")).toBe("Filter, 1 on");
		// Only work items: no agent stands in the feed.
		expect(host.querySelectorAll('.feed-row[data-kind="item"]').length).toBeGreaterThan(0);
		expect(host.querySelectorAll('.feed-row[data-kind="agent"]')).toHaveLength(0);
		const chip = host.querySelector(".ws-chip") as HTMLButtonElement;
		expect(chip.textContent).toBe("Work items");
		act(() => chip.click());
		await settle(2);
		expect(localStorage.getItem("wlp.workspace.filters")).toBeNull();
		expect(host.querySelectorAll('.feed-row[data-kind="agent"]').length).toBeGreaterThan(0);
		expect(rail().querySelector(".ws-filter-button")?.getAttribute("aria-label")).toBe("Filter");
	});

	it("start with none where the browser keeps nothing", async () => {
		const original = Storage.prototype.getItem;
		const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
			if (key.startsWith("wlp.workspace")) throw new Error("SecurityError");
			return original.call(this, key);
		});
		try {
			await show("/");
		} finally {
			get.mockRestore();
		}
		expect(host.querySelectorAll(".ws-chip")).toHaveLength(0);
	});
});
