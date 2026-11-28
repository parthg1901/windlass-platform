// @vitest-environment jsdom
/**
 * The Connections page: the grid's cells as the mock's keys, plans and machines stand, the cell a link names,
 * a cell's connect, the Pay-with choices saved and read back, and Settings' pointer here.
 */
import type { AuthResult } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockClient, type MockClient } from "../api/mock";
import { App } from "../App";
import { saveAuth } from "../lib/authStore";
import { AppProvider } from "../state/app";
import { chooseOption } from "../test/select";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.setConfig({ testTimeout: 30_000 });
HTMLDialogElement.prototype.showModal ??= function () {
	this.open = true;
};
HTMLDialogElement.prototype.close ??= function () {
	this.open = false;
};
Element.prototype.scrollIntoView ??= () => {};
window.scrollTo = () => {};
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

const ada: AuthResult = {
	token: "mock:user:u_conn:ada@example.com",
	profile: { uid: "u_conn", email: "ada@example.com", demo: false },
};

let host: HTMLElement;
let root: Root;
let client: MockClient;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	sessionStorage.clear();
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	client.dispose();
	saveAuth("mock", null);
	localStorage.clear();
});

async function settle(steps = 14): Promise<void> {
	for (let step = 0; step < steps; step++)
		await act(async () => void (await new Promise(resolve => setTimeout(resolve, 2))));
}

function render(path: string) {
	history.replaceState(null, "", path);
	saveAuth("mock", ada);
	root = createRoot(host);
	act(() => root.render(createElement(AppProvider, { client, children: createElement(App) })));
}

const cell = (id: string) => host.querySelector<HTMLElement>(`#${id}`);
const state = (id: string) => cell(id)?.querySelector(".conn-state")?.textContent;

it("shows each agent at each place, and marks the cell a link names", async () => {
	client = createMockClient({ pace: 0, machine: "sources" });
	await client.user(ada).saveModelProvider({ provider: "anthropic", key: `sk-ant-api03-${"x".repeat(32)}` });
	render("/connections#codex-hosted");
	await settle();
	const [mac] = await client.user(ada).machines();
	const headers = [...host.querySelectorAll(".conn-grid thead th")].map(th => th.textContent);
	expect(headers.slice(0, 2)).toEqual(["Agent", "Hosted"]);
	expect(headers).toHaveLength(2 + (await client.user(ada).machines()).length);
	expect(state("claude-hosted")).toBe("Anthropic key");
	expect(cell("claude-hosted")?.textContent).toContain("…xxxx");
	expect(state("codex-hosted")).toBe("Not connected");
	expect(cell("codex-hosted")?.getAttribute("aria-current")).toBe("true");
	expect(cell("codex-hosted")?.className).toContain("conn-cell-target");
	expect(state("windlass-hosted")).toBe("Your keys");
	expect(state(`claude-${mac!.machineId}`)).toBe("This machine's own login");
	expect(cell(`windlass-${mac!.machineId}`)?.textContent).toContain("Same as Hosted");
	expect(document.title).toBe("Connections · Windlass");
	expect(host.querySelector('.topbar-tab[aria-current="page"]')?.textContent).toBe("Connections");
	// The plans and keys moved here from Settings.
	expect(host.querySelector("#plan-openai")).not.toBeNull();
	expect(host.querySelector("#key-google")).not.toBeNull();
});

it("connects from a cell: a key's entry opens over the page, and the cell turns green", async () => {
	client = createMockClient({ pace: 0, machine: "none" });
	render("/connections");
	await settle();
	const add = [...(cell("opencode-hosted")?.querySelectorAll("button") ?? [])].find(b =>
		b.textContent?.startsWith("Add"),
	);
	expect(add?.textContent).toBe("Add OpenAI key");
	await act(async () => add!.click());
	const input = document.querySelector<HTMLInputElement>("dialog input")!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
			input,
			"sk-proj-abcdefghijklmnop1234",
		);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	const save = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find(
		b => b.textContent === "Save key",
	);
	await act(async () => save!.click());
	await settle();
	expect(document.querySelector("dialog")).toBeNull();
	expect(state("opencode-hosted")).toBe("OpenAI key");
	expect(state("codex-hosted")).toBe("OpenAI key");
	expect(host.querySelector("#key-openai")?.textContent).toContain("…1234");

	// A plan's cell opens its connect command.
	const connect = [...(cell("claude-hosted")?.querySelectorAll("button") ?? [])].find(b =>
		b.textContent?.startsWith("Connect"),
	);
	expect(connect?.textContent).toBe("Connect Claude plan");
	await act(async () => connect!.click());
	await settle();
	expect(document.querySelector("dialog .plan-connect pre")?.textContent).toBe("npx @windlassai/cli connect claude");
});

it("saves who pays per agent and reads it back", async () => {
	client = createMockClient({ pace: 0, machine: "none" });
	await client.user(ada).saveModelProvider({ provider: "anthropic", key: `sk-ant-api03-${"x".repeat(32)}` });
	render("/connections");
	await settle();
	expect(await client.user(ada).payWith()).toEqual([
		{ harness: "claude", payWith: "plan-then-key", whenLimited: null, updatedAt: null },
		{ harness: "codex", payWith: "plan-then-key", whenLimited: null, updatedAt: null },
	]);
	const card = host.querySelector<HTMLElement>("#pay-claude")!;
	expect(card.textContent).toContain("items wait for the reset and sessions ask you first");
	const limited = card.querySelector<HTMLButtonElement>("#pay-claude-limited")!;
	expect(limited.disabled).toBe(false);
	await chooseOption(limited, "key");
	await settle();
	expect(card.textContent).toContain("items and sessions switch to your Anthropic key");
	await chooseOption(card.querySelector<HTMLButtonElement>("#pay-claude-with")!, "plan");
	await settle();
	expect(limited.disabled).toBe(true);
	const saved = await client.user(ada).payWith();
	expect(saved[0]).toMatchObject({ harness: "claude", payWith: "plan", whenLimited: "key" });
	expect(saved[0]?.updatedAt).toEqual(expect.any(Number));

	// Read back on a new visit.
	act(() => root.unmount());
	render("/connections");
	await settle();
	expect(host.querySelector<HTMLElement>("#pay-claude-with")?.dataset.value).toBe("plan");
	// Without a saved key a limited plan always waits, whatever was chosen.
	expect(host.querySelector("#pay-codex")?.textContent).toContain("No OpenAI key saved");
	await expect(
		client.user(ada).savePayWith({ harness: "opencode", payWith: "plan", whenLimited: null }),
	).rejects.toMatchObject({ reason: "bad_input" });
});

it("leaves only the model defaults in Settings, with the way to Connections", async () => {
	client = createMockClient({ pace: 0, machine: "none" });
	render("/settings");
	await settle();
	expect(host.querySelector("#plan-openai")).toBeNull();
	expect(host.querySelector("#key-openai")).toBeNull();
	const moved = host.querySelector("#settings-models");
	expect(moved?.textContent).toContain("moved to Connections");
	expect(moved?.querySelector('a[href="/connections"]')).not.toBeNull();
});

it("badges a limited plan with its reset, and offers to reconnect one that stopped working", async () => {
	localStorage.setItem("wlp.mock.plan.u_conn", "1");
	client = createMockClient({ pace: 0, machine: "none", plans: "limited" });
	render("/connections");
	await settle();
	const limited = cell("codex-hosted")?.querySelector(".conn-badge");
	expect(limited?.textContent).toMatch(/^Limited until \d\d:\d\d$/);
	expect(limited?.className).toContain("ui-status-warn");
	expect(cell("windlass-hosted")?.querySelector(".conn-badge")?.textContent).toMatch(/^Limited until/);
	// The intro no longer says Pay with waits for a release.
	expect(host.querySelector("#connections-pay")?.textContent).not.toContain("upcoming release");

	act(() => root.unmount());
	client.dispose();
	client = createMockClient({ pace: 0, machine: "none", plans: "invalid" });
	render("/connections");
	await settle();
	expect(cell("codex-hosted")?.querySelector(".conn-badge")?.textContent).toBe("Stopped working");
	const reconnect = [...(cell("codex-hosted")?.querySelectorAll("button") ?? [])].find(
		b => b.textContent === "Reconnect",
	);
	expect(reconnect).toBeDefined();
	await act(async () => reconnect!.click());
	await settle();
	expect(document.querySelector("dialog")?.textContent).toContain("ChatGPT plan");
});

it("a machine's own Claude login: kept and stays there, with the way back; then the two ways and the command", async () => {
	client = createMockClient({ pace: 0, machine: "sources" });
	render("/connections");
	await settle();
	const [mac] = await client.user(ada).machines();
	const id = `claude-${mac!.machineId}`;
	// Nothing on Windlass pays for Claude Code: Hosted says so plainly, beside the machine's login.
	expect(state("claude-hosted")).toBe("Not connected");
	expect(cell("claude-hosted")?.textContent).toContain("Hosted Claude Code needs your plan or a key on Windlass.");
	expect(state(id)).toBe("This machine's own login");
	expect(cell(id)?.textContent).toContain("Stays on this machine");
	const back = [...(cell(id)?.querySelectorAll("button") ?? [])].find(
		b => b.textContent === "Switch back to your plan",
	);
	expect(back).toBeDefined();
	await act(async () => back!.click());
	await settle(60);
	// The other machine of the mock still keeps its own login: Hosted still says it needs one on Windlass.
	expect(cell("claude-hosted")?.textContent).toContain("needs your plan or a key on Windlass");
	expect(state(id)).toBe("Not connected");
	const options = [...(cell(id)?.querySelectorAll<HTMLLabelElement>(".conn-own-option") ?? [])];
	expect(options.map(option => option.textContent)).toEqual([
		"Your Claude plan, from Windlass",
		"This machine's own login — it never leaves this machine",
	]);
	expect(options[0]!.querySelector("input")!.checked).toBe(true);
	expect(cell(id)?.querySelector("pre")).toBeNull();
	await act(async () => options[1]!.querySelector("input")!.click());
	expect(cell(id)?.querySelector("pre")?.textContent).toBe("npx @windlassai/cli connect claude --this-machine");
	expect(cell(id)?.textContent).toContain("Waiting for the machine to report the login");
});
