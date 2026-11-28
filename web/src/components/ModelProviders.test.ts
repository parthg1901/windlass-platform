// @vitest-environment jsdom
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { createMockClient } from "../api/mock";
import { saveAuth } from "../lib/authStore";
import { AppProvider } from "../state/app";
import { ChatgptPlan } from "./ChatgptPlan";
import { ClaudePlan } from "./ClaudePlan";
import { ModelProviders } from "./ModelProviders";

/** The keys and the plans' rows, as the Connections page has them. */
const Rows = () =>
	createElement(
		Fragment,
		null,
		createElement("ul", null, createElement(ChatgptPlan), createElement(ClaudePlan)),
		createElement(ModelProviders),
	);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

HTMLDialogElement.prototype.showModal ??= function () {
	this.open = true;
};
HTMLDialogElement.prototype.close ??= function () {
	this.open = false;
};

it("adds, checks, replaces and removes a provider key", async () => {
	const client = createMockClient({ pace: 0 });
	const auth = {
		token: "mock:user:u_keys:ada@example.com",
		profile: { uid: "u_keys", email: "ada@example.com", demo: false },
	};
	saveAuth("mock", auth);
	const host = document.body.appendChild(document.createElement("div"));
	const root = createRoot(host);
	const settle = async () => {
		for (let i = 0; i < 6; i++) await act(async () => void (await new Promise(r => setTimeout(r, 2))));
	};
	const row = (provider: string) => host.querySelector<HTMLElement>(`[data-provider="${provider}"]`)!;
	const state = (provider: string) => row(provider).querySelector(".provider-state")?.textContent;
	const press = async (scope: ParentNode, label: string) => {
		const button = [...scope.querySelectorAll("button")].find(one => one.textContent?.startsWith(label));
		expect(button, label).toBeDefined();
		await act(async () => button!.click());
		await settle();
	};
	const enter = async (key: string) => {
		const input = document.querySelector<HTMLInputElement>("dialog input")!;
		expect(input.type).toBe("password");
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, key);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await press(document.querySelector("dialog")!, "Save key");
	};
	try {
		await act(async () => root.render(createElement(AppProvider, { client, children: createElement(Rows) })));
		await settle();
		expect(host.querySelectorAll(".provider-row:not(.chatgpt-plan):not(.claude-plan)")).toHaveLength(4);
		expect(host.querySelector(".provider-row.chatgpt-plan")?.textContent).toContain("ChatGPT plan");
		expect(state("claude-plan")).toBe("Not connected");
		await press(row("claude-plan"), "Connect");
		expect(row("claude-plan").querySelector(".plan-connect pre")?.textContent).toBe(
			"npx @windlassai/cli connect claude",
		);
		// The terminal's code is approved on the connect page; the row turns green on its own once the plan arrives.
		await client.user(auth).approvePlanConnect("KQ2M-8XF4", "anthropic");
		for (let i = 0; i < 40 && state("claude-plan") !== "Connected"; i++)
			await act(async () => void (await new Promise(r => setTimeout(r, 200))));
		expect(state("claude-plan")).toBe("Connected");
		expect(row("claude-plan").textContent).toContain("you@example.com · Max");
		expect(state("openai")).toBe("No key");

		await press(row("openai"), "Add key");
		await enter("not-a-key");
		expect(document.querySelector("dialog [role=alert]")?.textContent).toMatch(/format does not match/);
		await enter("sk-proj-abcdefghijklmnop1234");
		expect(document.querySelector("dialog")).toBeNull();
		expect(state("openai")).toBe("Connected");
		expect(row("openai").textContent).toContain("…1234");
		expect(row("openai").textContent).toContain("1 model");
		expect(host.textContent).not.toContain("abcdefghijklmnop");

		await press(row("openai"), "Check");
		expect(row("openai").textContent).toContain("checked");

		await press(row("openai"), "Replace");
		expect(document.querySelector<HTMLInputElement>("dialog input")!.value).toBe("");
		await enter("sk-proj-zyxwvutsrqponmlk9876");
		expect(row("openai").textContent).toContain("…9876");
		expect((await client.user(auth).modelProviders()).map(one => one.last4)).toEqual(["9876"]);

		await press(row("openai"), "Remove");
		expect(document.querySelector("dialog")?.textContent).toMatch(/blocks new requests.*already running may finish/i);
		await press(document.querySelector("dialog")!, "Keep it");
		expect(row("openai").textContent).toContain("…9876");
		await press(row("openai"), "Remove");
		await press(document.querySelector("dialog")!, "Remove key");
		expect(state("openai")).toBe("No key");
		expect(await client.user(auth).modelProviders()).toEqual([]);
	} finally {
		act(() => root.unmount());
		host.remove();
		client.dispose();
		localStorage.clear();
	}
}, 15_000);

it("connects the ChatGPT plan from a terminal, and shows its Codex line only where plans are on", async () => {
	const base = createMockClient({ pace: 0 });
	const auth = {
		token: "mock:user:u_chatgpt:ada@example.com",
		profile: { uid: "u_chatgpt", email: "ada@example.com", demo: false },
	};
	saveAuth("mock", auth);
	let allowed = true;
	let rechecked = 0;
	const client = {
		...base,
		user: (a: typeof auth) => ({
			...base.user(a),
			modelPlans: async () => ({ ...(await base.user(a).modelPlans()), allowed }),
			recheckModelPlan: async (provider: "openai" | "anthropic") => {
				rechecked++;
				return base.user(a).recheckModelPlan(provider);
			},
		}),
	} as typeof base;
	const host = document.body.appendChild(document.createElement("div"));
	const root = createRoot(host);
	const settle = async () => {
		for (let i = 0; i < 6; i++) await act(async () => void (await new Promise(r => setTimeout(r, 2))));
	};
	const row = () => host.querySelector<HTMLElement>(".provider-row.chatgpt-plan")!;
	const render = async () => {
		await act(async () => root.render(createElement(AppProvider, { client, children: createElement(Rows) })));
		await settle();
	};
	const state = () => row().querySelector(".provider-state")?.textContent;
	try {
		await render();
		expect(state()).toBe("Not connected");
		const connect = [...row().querySelectorAll("button")].find(b => b.textContent === "Connect")!;
		await act(async () => connect.click());
		await settle();
		expect(row().querySelector(".plan-connect pre")?.textContent).toBe("npx @windlassai/cli connect codex");
		// The terminal's code is approved on the connect page; the row turns green on its own once the sign-in arrives.
		await base.user(auth).approvePlanConnect("KQ2M-8XF4", "openai");
		for (let i = 0; i < 40 && state() !== "Connected"; i++)
			await act(async () => void (await new Promise(r => setTimeout(r, 200))));
		expect(state()).toBe("Connected");
		expect(row().querySelector(".plan-connect")).toBeNull();
		expect(row().textContent).toContain("Connected as ada@example.com · Plus");
		expect(row().textContent).toContain("Also pays for hosted Codex · 2 models");
		const check = [...row().querySelectorAll("button")].find(b => b.textContent === "Check again")!;
		await act(async () => check.click());
		await settle();
		expect(rechecked).toBe(1);

		act(() => root.unmount());
		allowed = false;
		const again = createRoot(host);
		await act(async () => again.render(createElement(AppProvider, { client, children: createElement(Rows) })));
		await settle();
		expect(row().textContent).toContain("Connected as ada@example.com · Plus");
		expect(row().textContent).not.toContain("hosted Codex");
		expect(row().textContent).not.toContain("Check again");
		act(() => again.unmount());
	} finally {
		host.remove();
		base.dispose();
		localStorage.clear();
	}
}, 20_000);
