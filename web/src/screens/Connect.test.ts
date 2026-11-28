// @vitest-environment jsdom
import type { PlanProvider } from "@contract";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { createMockClient } from "../api/mock";
import { saveAuth } from "../lib/authStore";
import { href, parseRoute, returnAfterSignIn, takeReturnAfterSignIn } from "../lib/router";
import { AppProvider } from "../state/app";
import { Connect } from "./Connect";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(code: string | undefined, plan: PlanProvider | undefined, kind?: "machine") {
	const client = createMockClient({ pace: 0, machine: "none" });
	const auth = {
		token: "mock:user:u_connect:ada@example.com",
		profile: { uid: "u_connect", email: "ada@example.com", demo: false },
	};
	saveAuth("mock", auth);
	const host = document.body.appendChild(document.createElement("div"));
	const root = createRoot(host);
	const screen = createElement(Connect, { code, plan, kind, theme: "light", onToggleTheme() {} });
	await act(async () => root.render(createElement(AppProvider, { client, children: screen })));
	const settle = async () => {
		for (let i = 0; i < 6; i++) await act(async () => void (await new Promise(r => setTimeout(r, 120))));
	};
	const press = async (label: string) => {
		const button = [...host.querySelectorAll("button")].find(one => one.textContent === label);
		expect(button, label).toBeDefined();
		await act(async () => button!.click());
		await settle();
	};
	return {
		host,
		client,
		auth,
		press,
		settle,
		done() {
			act(() => root.unmount());
			host.remove();
			client.dispose();
			localStorage.clear();
		},
	};
}

it("shows the terminal's code and approves it for the signed-in account", async () => {
	const page = await render("kq2m-8xf4", "anthropic");
	try {
		expect(page.host.querySelector(".connect-code")?.textContent).toBe("KQ2M-8XF4");
		expect(page.host.textContent).toContain("ada@example.com");
		expect(page.host.querySelector("h1")?.textContent).toBe("Connect your Claude plan?");
		await page.press("Approve");
		expect(page.host.querySelector("[role=status]")?.textContent).toMatch(/Approved\. Go back to your terminal/);
		expect(page.host.textContent).toContain("claude setup-token");
		expect(page.host.querySelector(".connect-card button")).toBeNull();
	} finally {
		page.done();
	}
});

it("names the ChatGPT plan and approves its code for it", async () => {
	const page = await render("KQ2M-8XF4", "openai");
	try {
		expect(page.host.querySelector("h1")?.textContent).toBe("Connect your ChatGPT plan?");
		await page.press("Approve");
		expect(page.host.querySelector("[role=status]")?.textContent).toContain("signs in to ChatGPT in your browser");
		await act(async () => void (await new Promise(r => setTimeout(r, 3_200))));
		expect(await page.client.user(page.auth).chatgpt()).toMatchObject({ connected: true });
	} finally {
		page.done();
	}
});

it("denies a code, and explains a link without one", async () => {
	const denied = await render("KQ2M-8XF4", "anthropic");
	try {
		await denied.press("Deny");
		expect(denied.host.textContent).toContain("Nothing was connected");
		expect((await denied.client.user(denied.auth).modelPlans()).plans).toEqual([]);
	} finally {
		denied.done();
	}
	for (const [code, plan] of [
		[undefined, "anthropic"],
		["KQ2M-8XF4", undefined],
	] as const) {
		const missing = await render(code, plan);
		try {
			expect(missing.host.textContent).toContain("npx @windlassai/cli connect claude");
			expect(missing.host.textContent).toContain("npx @windlassai/cli connect codex");
			expect(missing.host.querySelector(".connect-card button")).toBeNull();
		} finally {
			missing.done();
		}
	}
});

it("shows a machine's code, key and name, and Approve pairs it with the account", async () => {
	const page = await render("wxyz-1210", undefined, "machine");
	try {
		await page.settle();
		expect(page.host.querySelector("h1")?.textContent).toBe("Connect this machine to your account?");
		expect(page.host.querySelector(".connect-code")?.textContent).toBe("WXYZ-1210");
		expect(page.host.querySelector(".connect-machine-key")?.textContent).toBe("K7Q2M-XR4TD");
		expect(page.host.textContent).toContain("workstation");
		expect(page.host.textContent).toContain("Linux · x64");
		expect(page.host.textContent).toContain("Approve only if you just ran the command yourself");
		await page.press("Approve");
		expect(page.host.querySelector("[role=status]")?.textContent).toMatch(/Approved\. Go back to your terminal/);
		expect(page.host.querySelector(".connect-card button")).toBeNull();
		expect((await page.client.user(page.auth).machines()).map(machine => machine.name)).toEqual(["workstation"]);
	} finally {
		page.done();
	}
});

it("denies a machine, after which its code pairs nothing", async () => {
	const page = await render("WXYZ-1210", undefined, "machine");
	try {
		await page.settle();
		await page.press("Deny");
		expect(page.host.querySelector("[role=status]")?.textContent).toBe(
			"Denied. Nothing was connected; the terminal stops.",
		);
		const user = page.client.user(page.auth);
		await expect(user.confirmMachine({ code: "WXYZ-1210", keyConfirmed: true })).rejects.toMatchObject({
			reason: "pairing_not_found",
		});
		expect(await user.machines()).toEqual([]);
	} finally {
		page.done();
	}
});

it("explains a machine code that is not waiting, and a machine link without a code", async () => {
	const unknown = await render("ZZZZ-ZZZZ", undefined, "machine");
	try {
		await unknown.settle();
		expect(unknown.host.querySelector("[role=alert]")?.textContent).toContain("No machine is waiting with that code");
		expect(unknown.host.querySelector(".connect-card button")).toBeNull();
	} finally {
		unknown.done();
	}
	const missing = await render(undefined, undefined, "machine");
	try {
		expect(missing.host.textContent).toContain("npx @windlassai/cli connect --machine");
		expect(missing.host.querySelector(".connect-card button")).toBeNull();
	} finally {
		missing.done();
	}
});

it("keeps the connect page, its code and its plan across sign-in, once", () => {
	const route = { name: "connect", code: "KQ2M-8XF4", plan: "openai" } as const;
	expect(parseRoute("/connect", "?code=KQ2M-8XF4&plan=openai")).toEqual(route);
	expect(parseRoute("/connect", "?code=KQ2M-8XF4&plan=gemini")).toEqual({ name: "connect", code: "KQ2M-8XF4" });
	expect(href(route)).toBe("/connect?code=KQ2M-8XF4&plan=openai");
	history.replaceState(null, "", "/connect?code=KQ2M-8XF4&plan=openai");
	returnAfterSignIn();
	expect(takeReturnAfterSignIn()).toEqual(route);
	expect(takeReturnAfterSignIn()).toBeNull();
	const machine = { name: "connect", code: "KQ2M-8XF4", kind: "machine" } as const;
	expect(parseRoute("/connect", "?code=KQ2M-8XF4&kind=machine")).toEqual(machine);
	expect(parseRoute("/connect", "?code=KQ2M-8XF4&kind=toaster")).toEqual({ name: "connect", code: "KQ2M-8XF4" });
	expect(href(machine)).toBe("/connect?code=KQ2M-8XF4&kind=machine");
	history.replaceState(null, "", href(machine));
	returnAfterSignIn();
	expect(takeReturnAfterSignIn()).toEqual(machine);
	// Only the connect page is taken back to.
	history.replaceState(null, "", "/settings");
	returnAfterSignIn();
	expect(takeReturnAfterSignIn()).toBeNull();
});
