// @vitest-environment jsdom
import type { RepositoryDefaults } from "@contract";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { createMockClient } from "../api/mock";
import { saveAuth } from "../lib/authStore";
import { AppProvider, useApp, useAuth } from "../state/app";
import { useAccount } from "../state/hooks";
import { chooseOption } from "../test/select";
import { RepositoryOverrides } from "./RunSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("shows a repository's inherited place and agent with their source, overrides one, and goes back to the default", async () => {
	const client = createMockClient({ pace: 0 });
	const auth = {
		token: "mock:user:u_over:ada@example.com",
		profile: { uid: "u_over", email: "ada@example.com", demo: false },
	};
	const user = client.user(auth);
	await user.saveAccountDefaults({
		place: { machine: "m_nas" },
		machineProfile: "docker-windlass-sandbox",
		placeFallback: "wait",
	});
	const start = (await user.repository(7103)).defaults;
	saveAuth("mock", auth);
	function Page() {
		const { client } = useApp();
		const signedIn = useAuth();
		const account = useAccount();
		const [defaults, setDefaults] = useState<RepositoryDefaults>(start);
		return createElement(RepositoryOverrides, {
			account,
			defaults,
			save: change => client.user(signedIn).saveRepositoryDefaults(7103, change),
			onSaved: setDefaults,
		});
	}
	const host = document.body.appendChild(document.createElement("div"));
	const root = createRoot(host);
	const settle = async () => {
		for (let i = 0; i < 10; i++) await act(async () => void (await new Promise(r => setTimeout(r, 2))));
	};
	const row = (title: string) =>
		[...host.querySelectorAll<HTMLElement>(".run-row")].find(
			r => r.querySelector(".run-row-title")?.textContent === title,
		)!;
	const press = async (scope: HTMLElement, label: string) => {
		await act(async () => [...scope.querySelectorAll("button")].find(b => b.textContent === label)!.click());
		await settle();
	};
	try {
		await act(async () => root.render(createElement(AppProvider, { client, children: createElement(Page) })));
		await settle();
		expect(row("Place").textContent).toContain("nas · waits when offline");
		expect(row("Place").textContent).toContain("your default");
		// Folded: nothing to edit until it is overridden.
		expect(row("Place").querySelector(".select")).toBeNull();
		await press(row("Place"), "Override for this repository");
		await chooseOption(row("Place").querySelector<HTMLElement>(".select")!, "hosted");
		await settle();
		expect((await user.repository(7103)).defaults.place).toBe("hosted");
		expect(row("Place").textContent).toContain("Hosted");
		expect(row("Place").textContent).toContain("set for this repository");
		await press(row("Place"), "Use your default");
		expect((await user.repository(7103)).defaults.place).toBeNull();
		expect(row("Place").textContent).toContain("your default");
		const chooseAgent = async () => {
			await press(row("Agent"), "Override for this repository");
			await chooseOption(row("Agent").querySelector<HTMLElement>(".select")!, "claude");
			await settle();
		};
		await chooseAgent();
		expect((await user.repository(7103)).defaults.machineProfile).toBeNull();
		await press(row("Agent"), "Use your default");
		expect(row("Place").textContent).toContain("Strict");
		await press(row("Place"), "Override for this repository");
		await chooseOption(row("Place").querySelectorAll<HTMLElement>(".select")[1]!, "docker-hardened");
		await settle();
		await chooseAgent();
		await press(row("Agent"), "Use your default");
		expect(row("Place").textContent).toContain("set for this repository");
		expect((await user.repository(7103)).defaults.machineProfile).toBe("docker-hardened");
		expect(row("Agent").textContent).toContain("Windlass");
		expect(row("Plans & reviews").textContent).toContain("your default");
		await press(row("Plans & reviews"), "Override for this repository");
		await press(row("Plans & reviews"), "Same as building");
		await act(async () =>
			document.querySelector<HTMLElement>('[role="menuitemradio"][data-value="gpt-6-sol"]')!.click(),
		);
		await settle();
		expect((await user.repository(7103)).defaults).toMatchObject({ model: null, reviewModel: "gpt-6-sol" });
		expect(row("Plans & reviews").textContent).toContain("set for this repository");
		await press(row("Plans & reviews"), "Use your default");
		expect(row("Plans & reviews").textContent).toContain("your default");
	} finally {
		act(() => root.unmount());
		host.remove();
		client.dispose();
		localStorage.clear();
	}
});
