// @vitest-environment jsdom
import { StrictMode, act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockClient } from "../api/mock";
import { loadAuth, saveAuth } from "../lib/authStore";
import { lastAppHref, navigate, pageFrom, rememberAppPage } from "../lib/router";
import { AppProvider, useApp } from "../state/app";
import { Machines } from "./Machines";
import { Settings } from "./Settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

HTMLDialogElement.prototype.showModal ??= function () {
	this.open = true;
};
HTMLDialogElement.prototype.close ??= function () {
	this.open = false;
};

it.each([true, false])(
	"keeps the session on cancel and signs out with revoke API tokens set to %s",
	async revokeApiTokens => {
		const client = createMockClient({ pace: 0 });
		const login = async () => {
			const { url, redirectPrefix } = await client.login.start();
			return client.login.finish(redirectPrefix + "?code=settings&state=" + new URL(url).searchParams.get("state"));
		};
		const auth = await login();
		const before = await client.user(auth).apiTokens();
		expect(before.length).toBeGreaterThan(0);
		saveAuth("mock", auth);
		const host = document.body.appendChild(document.createElement("div"));
		const root = createRoot(host);
		const Screen = () => (useApp().auth ? createElement(Settings) : createElement("p", null, "Signed out"));
		const click = async (label: string, container: ParentNode = host) => {
			const button = Array.from(container.querySelectorAll("button")).find(one => one.textContent === label);
			expect(button, label).toBeDefined();
			await act(async () => button!.click());
		};
		try {
			await act(async () => root.render(createElement(AppProvider, { client, children: createElement(Screen) })));
			await click("Sign out everywhere");
			const checkbox = () => document.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!;
			expect(checkbox()?.labels?.[0]?.textContent).toContain("Also revoke all API tokens");
			expect(checkbox().checked).toBe(true);
			expect(document.querySelector("dialog")?.textContent).toMatch(/paired machines keep working/i);
			expect(document.querySelector('dialog a[href="/machines"]')?.textContent).toBe("Machines");
			await act(async () => checkbox().click());
			await click("Cancel", document);
			expect(await client.user(auth).apiTokens()).toEqual(before);
			expect(loadAuth("mock")).toEqual(auth);
			await click("Sign out everywhere");
			expect(checkbox().checked).toBe(true);
			if (!revokeApiTokens) await act(async () => checkbox().click());
			await click("Sign out everywhere", document.querySelector("dialog")!);
			expect(loadAuth("mock")).toBeNull();
			expect(host.textContent).toBe("Signed out");
			await expect(client.user(auth).me()).rejects.toMatchObject({ code: "unauthorized" });
			expect(await client.user(await login()).apiTokens()).toEqual(revokeApiTokens ? [] : before);
		} finally {
			act(() => root.unmount());
			host.remove();
			client.dispose();
			localStorage.clear();
		}
	},
	15_000,
);

it.each([false, true])(
	"shows linked identities and protects the last sign-in method (Google configured: %s)",
	async google => {
		const client = createMockClient({ pace: 0 });
		const github = await client.login.start("github");
		const auth = await client.login.finish(github.url);
		const info = await client.info();
		vi.spyOn(client, "info").mockResolvedValue({
			...info,
			googleLogin: google ? true : undefined,
			github: { slug: "windlass", url: google ? "https://github.example.test" : "https://github.com" },
		});
		if (google) {
			const link = await client.login.start("google", auth);
			await client.login.finish(link.url, auth);
		}
		saveAuth("mock", auth);
		const host = document.body.appendChild(document.createElement("div"));
		const root = createRoot(host);
		try {
			await act(async () => root.render(createElement(AppProvider, { client, children: createElement(Settings) })));
			const rows = Array.from(host.querySelectorAll('[aria-label="Sign-in methods"] li'));
			expect(rows.map(row => row.querySelector(".provider-name")?.textContent)).toEqual(
				google ? ["GitHub", "Google"] : ["GitHub"],
			);
			const githubRow = rows[0]!;
			expect(githubRow.textContent).toContain("@ada");
			expect(githubRow.textContent).not.toContain("github.com");
			const unlink = githubRow.querySelector("button")!;
			if (google) {
				expect(githubRow.textContent).toContain("github.example.test");
				expect(rows[1]?.textContent).toContain("ada@example.com");
				await act(async () => unlink.click());
				expect(host.querySelector("dialog")?.textContent).toContain("Unlink GitHub?");
				await act(async () => host.querySelector<HTMLButtonElement>("dialog [data-autofocus]")!.click());
				expect(await client.user(auth).linkedLogins()).toHaveLength(2);
				await act(async () => unlink.click());
				await act(async () => host.querySelector<HTMLButtonElement>("dialog .button-danger")!.click());
				expect(host.querySelector("dialog")).toBeNull();
				expect(githubRow.textContent).toContain("not linked");
				expect(githubRow.textContent).not.toContain("@ada");
				expect(githubRow.querySelector("button")?.getAttribute("aria-label")).toBe("Link GitHub");
			}
			const lastAction = rows.at(-1)!.querySelector("button")!;
			expect(lastAction.disabled).toBe(true);
			expect(document.getElementById(lastAction.getAttribute("aria-describedby")!)?.textContent).toMatch(
				/link another sign-in method/i,
			);
		} finally {
			act(() => root.unmount());
			host.remove();
			client.dispose();
			localStorage.clear();
		}
	},
);

it("refuses a pending GitHub sign-in and lists only Google after the GitHub App is removed", async () => {
	const configured = createMockClient({ pace: 0 });
	const pending = await configured.login.start("github");
	configured.dispose();
	const client = createMockClient({ pace: 0, github: false });
	await expect(client.login.finish(pending.url)).rejects.toMatchObject({ reason: "invalid_callback" });
	const login = await client.login.start("google");
	saveAuth("mock", await client.login.finish(login.url));
	const host = document.body.appendChild(document.createElement("div"));
	const root = createRoot(host);
	try {
		await act(async () => root.render(createElement(AppProvider, { client, children: createElement(Settings) })));
		const names = host.querySelectorAll('[aria-label="Sign-in methods"] .provider-name');
		expect(Array.from(names, row => row.textContent)).toEqual(["Google"]);
	} finally {
		act(() => root.unmount());
		host.remove();
		client.dispose();
		localStorage.clear();
	}
});

/** Renders a screen signed in as a fresh account, with a way to change its selects and wait. */
async function screen(name: string, render: () => ReturnType<typeof createElement>) {
	const client = createMockClient({ pace: 0 });
	const auth = {
		token: `mock:user:u_${name}:ada@example.com`,
		profile: { uid: `u_${name}`, email: "ada@example.com", demo: false },
	};
	saveAuth("mock", auth);
	const host = document.body.appendChild(document.createElement("div"));
	const root = createRoot(host);
	const settle = async () => {
		for (let i = 0; i < 10; i++) await act(async () => void (await new Promise(r => setTimeout(r, 2))));
	};
	const field = (label: string) =>
		[...host.querySelectorAll<HTMLSelectElement>(".run-default select")].find(
			el => el.labels?.[0]?.textContent === label,
		);
	const select = async (label: string, value: string) => {
		await act(async () => {
			const el = field(label)!;
			el.value = value;
			el.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await settle();
	};
	await act(async () => root.render(createElement(AppProvider, { client, children: render() })));
	await settle();
	return {
		client,
		user: client.user(auth),
		host,
		field,
		select,
		settle,
		close: () => {
			act(() => root.unmount());
			host.remove();
			client.dispose();
			localStorage.clear();
		},
	};
}

it("chooses the default agent in Settings → Models, and says what plans and reviews", async () => {
	const s = await screen("agent", () => createElement(Settings));
	try {
		expect(s.field("Agent")?.value).toBe("windlass");
		expect(s.host.textContent).toContain("Builds with");
		expect(s.host.textContent).toContain("Plans & reviews with");
		const planning = [...s.host.querySelectorAll<HTMLButtonElement>('[data-picker="model"]')][1]!;
		expect(planning.textContent).toBe("Same as building");
		await act(async () => planning.click());
		await act(async () =>
			document.querySelector<HTMLElement>('[role="menuitemradio"][data-value="gpt-6-luna"]')!.click(),
		);
		await s.settle();
		expect((await s.user.account()).defaults).toMatchObject({ model: null, reviewModel: "gpt-6-luna" });
		await s.select("Agent", "claude");
		expect((await s.user.account()).defaults.harness).toBe("claude");
		expect(planning.textContent).toContain("GPT-6 Luna");
		expect(s.host.querySelector("#settings-defaults")).toBeNull();
	} finally {
		s.close();
	}
});

it("chooses the default place on Machines, its isolation and what happens when it is offline", async () => {
	const s = await screen("place", () => createElement(Machines, { adding: false }));
	try {
		expect(s.field("Runs on")?.value).toBe("hosted");
		await s.select("Runs on", "m_nas");
		expect(s.field("Isolation")).toBeDefined();
		await act(async () => [...s.host.querySelectorAll<HTMLInputElement>(".run-segmented input")][1]!.click());
		await s.settle();
		const defaults = (await s.user.account()).defaults;
		expect(defaults).toMatchObject({ place: { machine: "m_nas" }, placeFallback: "hosted" });
		// Agents you start yourself start there too: there is one default place.
		expect(defaults.startPlace).toMatchObject({ kind: "machine", machineId: "m_nas" });
		expect(s.host.textContent).toContain("the item asks whether to wait or run on Hosted");
		await s.select("Runs on", "hosted");
		expect(s.field("Isolation")).toBeUndefined();
		expect((await s.user.account()).defaults.place).toBe("hosted");
	} finally {
		s.close();
	}
});

describe("Integrations in Settings", () => {
	async function open(
		client: ReturnType<typeof createMockClient>,
		hash = "",
		provider: "github" | "google" = "github",
	) {
		const { url, redirectPrefix } = await client.login.start(provider);
		const auth = await client.login.finish(
			redirectPrefix + "?code=tracker&state=" + new URL(url).searchParams.get("state"),
		);
		saveAuth("mock", auth);
		history.replaceState(null, "", "/settings" + hash);
		const host = document.body.appendChild(document.createElement("div"));
		const root = createRoot(host);
		await act(async () =>
			root.render(
				createElement(AppProvider, { client, children: createElement(StrictMode, null, createElement(Settings)) }),
			),
		);
		const settle = async () => {
			for (let i = 0; i < 6; i++) await act(async () => void (await new Promise(r => setTimeout(r, 5))));
		};
		await settle();
		return {
			host,
			root,
			auth,
			settle,
			close: () => {
				act(() => root.unmount());
				host.remove();
			},
		};
	}
	const section = (host: HTMLElement) => host.querySelector("[data-testid='linear-settings']") as HTMLElement;
	const choose = async (select: HTMLSelectElement, value: string) => {
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
	};
	const press = async (scope: ParentNode, label: string) => {
		const button = Array.from(scope.querySelectorAll("button")).find(
			one => one.textContent === label || one.getAttribute("aria-label") === label,
		);
		expect(button, label).toBeDefined();
		await act(async () => button!.click());
	};
	// A card's secondary actions (Disconnect…) are in its ⋯ menu.
	const pressMore = async (scope: ParentNode, name: string, label: string) => {
		await press(scope, `More ${name} actions`);
		const row = Array.from(document.querySelectorAll<HTMLElement>('.ui-pop [role="menuitem"]')).find(
			one => one.querySelector(".ui-item-label")?.textContent === label,
		);
		expect(row, label).toBeDefined();
		await act(async () => row!.click());
	};

	afterEach(() => {
		localStorage.clear();
		history.replaceState(null, "", "/");
	});

	it("connects GitLab independently, saves a project by its full ID, and disconnects", async () => {
		const mock = () => createMockClient({ pace: 0, github: false, items: "off" });
		const firstClient = mock();
		const first = await open(firstClient, "", "google");
		const card = (host: HTMLElement) => host.querySelector<HTMLElement>("#settings-gitlab")!;
		const assign = vi.fn();
		vi.stubGlobal("location", {
			assign,
			origin: "http://localhost",
			pathname: "/settings",
			search: "?mock=1",
			hash: "",
		});
		try {
			await press(card(first.host), "Connect GitLab…");
		} finally {
			vi.unstubAllGlobals();
		}
		const landing = new URL(assign.mock.calls[0]![0]);
		expect(landing.pathname + landing.search).toBe("/settings?mock=1");
		expect(await firstClient.user(first.auth).gitlab()).toEqual({ state: "disconnected" });
		first.close();

		const secondClient = mock();
		const second = await open(secondClient, landing.hash, "google");
		expect(location.hash).toBe("");
		expect(card(second.host).textContent).toContain("No project selected");
		expect(card(second.host).textContent).toMatch(/webhook.*Maintainer/);
		await expect(secondClient.user(second.auth).gitlabComplete(landing.hash.slice(8))).rejects.toThrow();
		const id = "90071992547409931";
		await choose(card(second.host).querySelector("select")!, id);
		await press(card(second.host), "Save project");
		expect(await secondClient.user(second.auth).gitlab()).toMatchObject({ project: { id, provider: "gitlab" } });
		second.close();

		const third = await open(mock(), "", "google");
		try {
			expect(card(third.host).querySelector('[role="status"]')?.textContent).toContain("acme/tools/harbor");
			// A chosen project folds the picker away behind its row's Change; Cancel folds it again.
			expect(card(third.host).querySelector("#gitlab-project")).toBeNull();
			await press(card(third.host), "Change the project");
			await third.settle();
			expect(card(third.host).querySelector("#gitlab-project")).not.toBeNull();
			expect(card(third.host).textContent).toMatch(/webhook.*Maintainer/);
			expect(document.activeElement?.id).toBe("gitlab-query");
			await press(card(third.host), "Cancel");
			expect(card(third.host).querySelector("#gitlab-project")).toBeNull();
			vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
			await pressMore(card(third.host), "GitLab", "Disconnect…");
			expect(card(third.host).textContent).toContain("Selected project");
			await pressMore(card(third.host), "GitLab", "Disconnect…");
			expect(card(third.host).textContent).toContain("Connect GitLab…");
		} finally {
			vi.restoreAllMocks();
			third.close();
		}
	});

	it("clears GitLab callback errors and hides GitLab where it is off", async () => {
		for (const [hash, message] of [
			["#gitlab-error=denied", "not given access"],
			["#gitlab=invalid", "Connect GitLab again"],
		] as const) {
			const view = await open(createMockClient({ pace: 0 }), hash);
			try {
				expect(location.hash).toBe("");
				expect(view.host.querySelector('#settings-gitlab [role="alert"]')?.textContent).toContain(message);
			} finally {
				view.close();
			}
		}
		const off = await open(createMockClient({ pace: 0, gitlab: false }));
		try {
			expect(off.host.querySelector("#settings-gitlab")).toBeNull();
		} finally {
			off.close();
		}
	});

	it("takes a GitLab or Slack return that arrives in the page already open", async () => {
		const client = createMockClient({ pace: 0 });
		const view = await open(client, "", "google");
		const api = client.user(view.auth);
		const state = (id: string) => view.host.querySelector(`#${id} .integration-state`)?.textContent;
		expect(state("settings-gitlab")).toContain("Not connected");
		expect(state("settings-slack")).toContain("Not connected");
		// Only the fragment changes: no new page load, so the cards must notice it themselves.
		const gitlab = new URL((await api.gitlabConnect({ origin: "http://localhost" })).url);
		await act(async () => void (location.hash = gitlab.hash));
		await view.settle();
		expect(location.hash).toBe("");
		expect(state("settings-gitlab")).toContain("Connected");
		expect(state("settings-gitlab")).not.toContain("Not connected");
		const slack = new URL((await api.slackConnect({ origin: "http://localhost" })).url);
		await act(async () => void (location.hash = slack.hash));
		await view.settle();
		expect(location.hash).toBe("");
		expect(state("settings-slack")).not.toContain("Not connected");
		view.close();
	});

	it("offers Connect, then shows unmapped teams, a saved mapping, and keeps it on reload", async () => {
		const client = createMockClient({ pace: 0 });
		const first = await open(client);
		expect(section(first.host).textContent).not.toContain("windlass-quick");
		expect(section(first.host).textContent).toContain("Connect Linear…");
		// Begin leaves the account disconnected until Settings redeems the ticket.
		const assign = vi.fn();
		vi.stubGlobal("location", {
			assign,
			origin: "http://localhost",
			pathname: "/settings",
			search: "?mock=1",
			hash: "",
		});
		await press(section(first.host), "Connect Linear…");
		await first.settle();
		vi.unstubAllGlobals();
		const landing = new URL(assign.mock.calls[0]![0]);
		expect(landing.origin + landing.pathname).toBe("http://localhost/settings");
		expect(landing.search).toBe("?mock=1");
		expect(landing.hash).toMatch(/^#linear=.+$/);
		expect(await client.user(first.auth).linear()).toEqual({ state: "disconnected" });
		first.close();

		const second = await open(createMockClient({ pace: 0 }), landing.hash);
		expect(location.hash).toBe("");
		expect(section(second.host).textContent).toContain("Linear is connected.");
		expect(section(second.host).querySelector("details:not([open])")?.textContent).toContain("windlass-quick");
		expect(section(second.host).querySelector("[data-testid='linear-workspace']")?.textContent).toBe(
			"WorkspaceAcmeConnected asAda Lovelace",
		);
		expect(section(second.host).querySelector("[data-testid='linear-team-ENG']")?.textContent).toContain("Not mapped");
		const [team, repository] = Array.from(section(second.host).querySelectorAll("select"));
		const save = Array.from(section(second.host).querySelectorAll("button")).find(
			one => one.textContent === "Map team",
		) as HTMLButtonElement;
		expect(save.disabled).toBe(true);
		await choose(team as HTMLSelectElement, "team-eng");
		await choose(repository as HTMLSelectElement, "7101");
		await press(section(second.host), "Map team");
		await second.settle();
		expect(section(second.host).querySelector("[data-testid='linear-team-ENG']")?.textContent).toContain(
			"→acme/harbor",
		);
		expect(section(second.host).querySelector("[data-testid='linear-team-DES']")?.textContent).toContain("Not mapped");
		second.close();

		// A reload: a new client, the same account.
		const third = await open(createMockClient({ pace: 0 }));
		expect(section(third.host).querySelector("[data-testid='linear-team-ENG']")?.textContent).toContain("→acme/harbor");
		await press(section(third.host), "Remove the mapping of Engineering");
		await third.settle();
		expect(section(third.host).querySelector("[data-testid='linear-team-ENG']")?.textContent).toContain("Not mapped");
		const confirmed = window.confirm;
		window.confirm = () => true;
		await pressMore(section(third.host), "Linear", "Disconnect…");
		window.confirm = confirmed;
		await third.settle();
		expect(section(third.host).textContent).toContain("Connect Linear…");
		third.close();
	}, 15_000);

	it("says what went wrong on a failed return from Linear, and shows nothing where the deployment has no Linear", async () => {
		const failed = await open(createMockClient({ pace: 0 }), "#linear-error=access_denied");
		expect(section(failed.host).querySelector("[role='alert']")?.textContent).toContain("Linear was not given access");
		expect(location.hash).toBe("");
		failed.close();
		const invalid = await open(createMockClient({ pace: 0 }), "#linear=invalid");
		expect(location.hash).toBe("");
		expect(section(invalid.host).querySelector("[role='alert']")?.textContent).toContain("Connect Linear again");
		expect(section(invalid.host).textContent).toContain("Connect Linear…");
		invalid.close();
		const off = await open(createMockClient({ pace: 0, linear: false }));
		expect(section(off.host)).toBeNull();
		off.close();
	}, 15_000);

	it("redeems the Jira ticket once, searches writable repositories, and manages the named mapping", async () => {
		const client = createMockClient({ pace: 0 }),
			first = await open(client);
		const section = (host: HTMLElement) => host.querySelector<HTMLElement>("#settings-jira")!;
		const assign = vi.fn();
		try {
			vi.stubGlobal("location", {
				assign,
				origin: "http://localhost",
				pathname: "/settings",
				search: "?mock=1",
				hash: "",
			});
			await press(section(first.host), "Connect Jira…");
		} finally {
			vi.unstubAllGlobals();
			first.close();
		}
		const landing = new URL(assign.mock.calls[0]![0]);
		expect(await client.user(first.auth).jira()).toEqual({ state: "disconnected" });
		history.replaceState(null, "", landing.pathname + landing.search + landing.hash);
		rememberAppPage();
		expect(lastAppHref()).toBe("/settings?mock=1");
		navigate({ name: "docs", slug: "settings" });
		expect(pageFrom()?.href).toBe("/settings?mock=1");
		const reopened = createMockClient({ pace: 0 }),
			user = reopened.user.bind(reopened);
		const complete = vi.fn((ticket: string) => user(first.auth).jiraComplete(ticket));
		vi.spyOn(reopened, "user").mockImplementation(auth => {
			const api = user(auth);
			return {
				...api,
				jiraComplete: complete,
				githubRepositories: async query => {
					const list = await api.githubRepositories(query);
					return query ? list : { ...list, repositories: [], more: true };
				},
			};
		});
		const screen = await open(reopened, landing.search + landing.hash),
			scope = section(screen.host);
		try {
			expect(complete).toHaveBeenCalledTimes(1);
			expect(location.hash).toBe("");
			await choose(scope.querySelector("select")!, "site-acme");
			await press(scope, "Connect site");
			await screen.settle();
			expect(scope.querySelector("dl")?.textContent).toBe("SiteAcme acme.atlassian.netConnected asAda Lovelace");
			const [project, repo] = scope.querySelectorAll("select");
			await choose(project!, "10001");
			expect(repo!.querySelector('option[value="7101"]')).toBeNull();
			const search = scope.querySelector<HTMLInputElement>('input[type="search"]')!;
			await act(async () => {
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "harbor");
				search.dispatchEvent(new Event("input", { bubbles: true }));
			});
			await vi.waitFor(async () => {
				await screen.settle();
				expect(repo!.textContent).toContain("acme/harbor");
			});
			await choose(repo!, "7101");
			await press(scope, "Map project");
			expect(scope.querySelector("li")?.textContent).toContain("EngineeringENG→acme/harbor");
			await press(scope, "Remove the mapping of Engineering");
			expect(scope.querySelector("li")?.textContent).toContain("Not mapped");
			vi.spyOn(window, "confirm").mockReturnValue(true);
			await pressMore(scope, "Jira Cloud", "Disconnect Jira…");
			expect(scope.textContent).toContain("Connect Jira…");
		} finally {
			screen.close();
			vi.restoreAllMocks();
		}
	}, 15_000);

	const slack = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-testid='slack-settings']")!;

	it("completes a Slack install, changes a channel’s repository, refuses read-only access, and removes the mapping", async () => {
		const client = createMockClient({ pace: 0 });
		const first = await open(client);
		expect(slack(first.host).textContent).toContain("Connect Slack…");
		const landing = await client.user(first.auth).slackConnect({ origin: location.origin });
		first.close();
		const screen = await open(client, new URL(landing.url).hash);
		try {
			const card = slack(screen.host);
			expect(location.hash).toBe("");
			expect(card.textContent).toContain("Acme Engineering");
			expect(card.textContent).toContain("Not linked");
			expect(card.querySelector('option[value="7105"]')).toBeNull(); // read-only
			const channel = card.querySelector<HTMLSelectElement>('[aria-label="Slack channel"]')!;
			expect(Array.from(channel.options, o => o.text)).toEqual([
				"Choose a channel",
				"#harbor-engineering",
				"#docs-triage",
			]);
			expect(card.textContent).not.toContain("C08HARB01");
			await choose(channel, "C08HARB01");
			await choose(card.querySelector('[aria-label="Repository"]')!, "7101");
			await press(card, "Map channel");
			await screen.settle();
			expect(card.querySelector('[aria-label="Mapped channels"]')?.textContent).toContain("acme/harbor");
			// A private repository's plans stay out of the channel until the owner allows them.
			const details = () =>
				card.querySelector<HTMLInputElement>('[aria-label="Mapped channels"] input[type="checkbox"]')!;
			expect(details().checked).toBe(false);
			details().click();
			await screen.settle();
			expect(details().checked).toBe(true);
			expect(
				((await client.user(screen.auth).slack()) as { mappings: { details: boolean }[] }).mappings[0]!.details,
			).toBe(true);
			await press(card, "Change mapping for harbor-engineering");
			await choose(card.querySelector('[aria-label="Repository"]')!, "7102");
			await press(card, "Map channel");
			await screen.settle();
			await expect(
				client.user(screen.auth).saveSlackMapping({ channelId: "C08HARB01", repositoryId: 7105 }),
			).rejects.toThrow("write access");
			expect(card.querySelectorAll('[aria-label="Mapped channels"] li')).toHaveLength(1);
			expect(card.querySelector('[aria-label="Mapped channels"]')?.textContent).toContain("ada/tide-tables");
			await press(card, "Remove mapping for harbor-engineering");
			await screen.settle();
			expect(card.querySelector('[aria-label="Mapped channels"] li')).toBeNull();
			const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
			try {
				await pressMore(card, "Slack", "Disconnect…");
			} finally {
				confirm.mockRestore();
			}
			await screen.settle();
			expect(card.textContent).toContain("Not connected");
		} finally {
			screen.close();
			client.dispose();
		}
	});

	it("scrubs private Slack links and lets a member confirm and unlink without installing a workspace", async () => {
		const client = createMockClient({ pace: 0 });
		const fragment = "#slack-link=" + client.mockSlackLinkTicket();
		history.replaceState(null, "", "/settings?mock=1" + fragment);
		rememberAppPage();
		expect(lastAppHref()).toBe("/settings?mock=1");
		const scroll = vi.fn();
		const previousScroll = HTMLElement.prototype.scrollIntoView;
		HTMLElement.prototype.scrollIntoView = scroll;
		const screen = await open(client, fragment);
		try {
			const card = slack(screen.host);
			expect(location.hash).toBe("");
			expect(card.textContent).toContain("Not linked");
			expect(card.innerHTML).not.toContain(fragment.split("=")[1]!);
			expect(scroll.mock.contexts).toEqual([card]);
			expect(document.activeElement?.textContent).toBe("Link Slack identity");
			await press(card, "Link Slack identity");
			await screen.settle();
			expect(card.textContent).toContain("Acme Engineering");
			expect(card.textContent).not.toContain("T08ACME01");
			expect(card.textContent).toContain("Not connected");
			await press(card, "Unlink Slack identity in Acme Engineering");
			await screen.settle();
			expect(card.textContent).toContain("Not linked");
		} finally {
			HTMLElement.prototype.scrollIntoView = previousScroll;
			screen.close();
			client.dispose();
		}
	});

	it("explains Slack callback failure without echoing tickets and hides Slack when off", async () => {
		for (const [hash, message] of [
			["#slack-error=denied", "Slack was not given access"],
			["#slack=invalid-ticket", "Connect Slack again"],
		] as const) {
			const client = createMockClient({ pace: 0 });
			const screen = await open(client, hash);
			try {
				expect(location.hash).toBe("");
				expect(slack(screen.host).querySelector('[role="alert"]')?.textContent).toContain(message);
				expect(screen.host.innerHTML).not.toContain("invalid-ticket");
			} finally {
				screen.close();
				client.dispose();
			}
		}
		for (const options of [{ slack: false }, { items: "off" }] as const) {
			const client = createMockClient({ pace: 0, ...options });
			const screen = await open(client, "?mock=1#slack-link=private-proof");
			try {
				expect(location.hash).toBe("");
				expect(location.search).toBe("?mock=1");
				expect(slack(screen.host)).toBeNull();
			} finally {
				screen.close();
				client.dispose();
			}
		}
	});
});
