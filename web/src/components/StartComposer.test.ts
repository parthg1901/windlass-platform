// @vitest-environment jsdom
/**
 * The start composer against the mock: what pressing Enter sends, what each picker changes, what it
 * starts on, and what it keeps across the visit to GitHub.
 */
import {
	promptTitle,
	type AuthResult,
	type CreateSessionInput,
	type GithubId,
	type MachineSummary,
	type PromptInput,
} from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionApi, UserApi } from "../api/client";
import { createMockClient, type MockClient } from "../api/mock";
import { saveAuth } from "../lib/authStore";
import { PROVIDERS_CHANGED } from "../state/hooks";
import { StartComposer } from "./StartComposer";
import { NewAgent } from "../screens/NewAgent";
import { AppProvider } from "../state/app";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ada: AuthResult = {
	token: "mock:user:u_ada:ada@example.com",
	profile: { uid: "u_ada", email: "ada@example.com", demo: false },
};
const demo: AuthResult = { token: "mock:demo:demo_1:", profile: { uid: "demo_1", email: null, demo: true } };

let host: HTMLElement;
let root: Root | null;
let client: MockClient;
/** What was sent: each agent created, and each prompt, in order. */
let created: CreateSessionInput[];
let prompted: PromptInput[];

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = null;
	created = [];
	prompted = [];
	history.replaceState(null, "", "/new");
	sessionStorage.clear();
});

afterEach(() => {
	if (root) act(() => root?.unmount());
	host.remove();
	client?.dispose();
	saveAuth("mock", null);
});

/** Lets the mock answer, in steps: what one answer renders can ask the next. */
async function settle(steps = 12): Promise<void> {
	for (let step = 0; step < steps; step++)
		await act(async () => void (await new Promise(resolve => setTimeout(resolve, 2))));
}

/**
 * A mock whose user calls are recorded; `machines` changes the machines the user is told of. With
 * `machines`, the mock also launches Claude Code on a model those machines report, as the server does
 * once runners report their models: it leaves the model out of what it hands on.
 */
function mock(machines?: (list: MachineSummary[]) => MachineSummary[]): MockClient {
	const made = createMockClient({ pace: 0, origin: "http://localhost:5173" });
	const user = made.user.bind(made);
	const session = made.session.bind(made);
	(made as { user: (auth: AuthResult) => UserApi }).user = who => {
		const api = user(who);
		return {
			...api,
			createSession: (input: CreateSessionInput) => (
				created.push(input),
				api.createSession(machines && input.harness === "claude" ? { ...input, model: undefined } : input)
			),
			...(machines
				? {
						machines: async () => machines(await api.machines()),
						watch: (events: Parameters<UserApi["watch"]>[0]) =>
							api.watch({
								...events,
								onMachines: events.onMachines
									? (list: MachineSummary[]) => events.onMachines?.(machines(list))
									: undefined,
							}),
					}
				: {}),
		};
	};
	(made as { session: (auth: AuthResult, id: string) => SessionApi }).session = (who, id) => {
		const api = session(who, id);
		return { ...api, prompt: (input: PromptInput) => (prompted.push(input), api.prompt(input)) };
	};
	return made;
}

/** Signs in and shows the new agent's page, as `/new` or a repository's `/new` does. */
async function show(
	options: {
		who?: AuthResult;
		repositoryId?: number;
		machines?: (list: MachineSummary[]) => MachineSummary[];
		before?(client: MockClient): Promise<void>;
	} = {},
): Promise<void> {
	client = mock(options.machines);
	saveAuth("mock", options.who ?? ada);
	await options.before?.(client);
	root ??= createRoot(host);
	act(() =>
		root?.render(
			createElement(AppProvider, {
				client,
				children: createElement(NewAgent, { repositoryId: options.repositoryId as GithubId | undefined }),
			}),
		),
	);
	await settle();
}

const field = () => host.querySelector(".start textarea") as HTMLTextAreaElement;

/** Types into a field as a browser does, so that React sees the change. */
function write(text: string, into: HTMLTextAreaElement | HTMLInputElement = field()): void {
	act(() => {
		const prototype = into instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(into, text);
		into.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

/** Enter in the task's field. */
async function enter(): Promise<void> {
	await act(
		async () =>
			void field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })),
	);
	await settle();
}

/**
 * The control of a picker, by the name the chip it replaced had: where it runs, its sandbox and the
 * repository are one pill ("on", "sandbox", "repo"), the effort is its own button beside the agent, and
 * the mode is in the options. Its value is what the control shows.
 */
const PICKERS: Record<string, string> = {
	repo: "where",
	on: "where",
	sandbox: "where",
	agent: "agent",
	effort: "effort",
	mode: "options",
	criteria: "criteria",
	setup: "setup",
};
const pill = (label: string) =>
	host.querySelector(`[data-picker="${PICKERS[label] ?? label}"]`) as HTMLButtonElement | null;
const value = (label: string) =>
	(label === "sandbox"
		? pill(label)?.dataset.sandbox
		: label === "repo"
			? pill(label)?.dataset.repo
			: label === "effort"
				? pill(label)?.dataset.effort
				: pill(label)?.dataset.value) ?? null;
/** Opens the control's picker. */
const open = (label: string) => act(() => (pill(label) as HTMLButtonElement).click());
/** Opens the repository's picker: its row in the where menu. */
async function openRepo(): Promise<void> {
	open("where");
	act(() => (pop().querySelector('[data-value="repo"]') as HTMLElement).click());
	await act(async () => void (await new Promise(resolve => setTimeout(resolve, 5))));
}
/** The open picker, the newest one: a menu or a small form, drawn at the end of the page. */
const pop = () => [...document.querySelectorAll(".ui-pop")].at(-1) as HTMLElement;
/** Chooses the row of this value in the open menu. */
const pick = (value: string) => act(() => (pop().querySelector(`[data-value="${value}"]`) as HTMLElement).click());
/** Opens a row's submenu as the keyboard does (→ on the highlighted row), and chooses in it. */
function pickIn(row: string, value: string): void {
	act(
		() =>
			void pop()
				.querySelector(`[data-value="${row}"]`)
				?.dispatchEvent(new MouseEvent("pointermove", { bubbles: true })),
	);
	act(
		() =>
			void document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
			),
	);
	act(() => (document.querySelector(`.ui-pop-sub [data-value="${value}"]`) as HTMLElement).click());
}
/** Chooses a model in the agent's menu, then an effort in the effort button's menu. */
function pickModelEffort(model: string, effort: string): void {
	pick(model);
	open("effort");
	pick(effort);
}
/** Switches the open agent menu to another agent with its logo button; the menu stays open on that agent's models. */
const switchAgent = (name: string) =>
	act(() => (pop().querySelector(`[aria-label="Switch agent"] [aria-label="${name}"]`) as HTMLButtonElement).click());
/** Chooses a mode in the options, by its name. */
function mode(name: string): void {
	open("options");
	const option = [...pop().querySelectorAll('[role="menuitemradio"]')].find(
		candidate => candidate.querySelector(".ui-item-label")?.textContent === name,
	) as HTMLElement;
	act(() => option.click());
}
/** A button in the open picker, by its words. */
const press = (words: string) =>
	act(() =>
		([...pop().querySelectorAll("button")].find(button => button.textContent === words) as HTMLButtonElement).click(),
	);
/** Chooses in the launch button's menu, by its words. */
async function launchMenu(words: string): Promise<void> {
	act(() => (host.querySelector(".ui-split-more") as HTMLButtonElement).click());
	await act(async () =>
		(
			[...pop().querySelectorAll('[role="menuitem"]')].find(
				row => row.querySelector(".ui-item-label")?.textContent === words,
			) as HTMLElement
		).click(),
	);
}

it("names a personal agent with its complete opening request", () => {
	const task = "Run the whole test suite and fix the missing CSV writer";
	expect(promptTitle(task + ". Report what changed.")).toBe(task + ".");
	expect(
		promptTitle("Add the CSV writer so that the export command can save one record for every reading in the archive"),
	).toBe("Add the CSV writer");
});

describe("the start composer", () => {
	it("starts an agent with the defaults when a task is typed and Enter pressed, and opens it", async () => {
		await show();
		// The newest agent was launched on acme/harbor, whose saved defaults are the hardened container and the second model.
		expect(value("repo")).toBe("acme/harbor @ main");
		write("Run the tests and fix what fails");
		await enter();
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({
			repository: { id: 7101, branch: "main" },
			profile: "docker-hardened",
			model: "gpt-6-luna",
			mode: "full",
		});
		expect(created[0]?.place).toBeUndefined();
		expect(created[0]?.harness).toBeUndefined();
		expect(prompted).toEqual([expect.objectContaining({ text: "Run the tests and fix what fails" })]);
		expect(prompted[0]?.effort).toBeUndefined();
		expect(location.pathname).toMatch(/^\/agents\/[0-9a-f]+$/);
	});

	it("sends the hosted size chosen with Hosted, and the default for agents otherwise", async () => {
		await show();
		write("Run the typecheck");
		open("where");
		pickIn("platform", "large");
		await enter();
		expect(created[0]?.hostedSize).toBe("large");
	});

	it("does nothing on Enter with an empty task, and creates without a prompt from the line under it", async () => {
		await show();
		await enter();
		expect(created).toHaveLength(0);
		await launchMenu("Create without a prompt");
		await settle();
		expect(created).toHaveLength(1);
		expect(created[0]?.title).toBeUndefined();
		expect(prompted).toHaveLength(0);
	});

	it("sends no title: the server names the agent from its first prompt, without the secrets saved", async () => {
		await show();
		write("\n  Add the tests command to the README  \nThen run them, and say what passed.");
		await enter();
		expect(created).toHaveLength(1);
		expect(created[0]).not.toHaveProperty("title");
		expect(prompted[0]?.text).toBe("Add the tests command to the README  \nThen run them, and say what passed.");
	});
});

describe("the start composer where it offers no switch", () => {
	it("starts an agent even when a work item was being filed elsewhere before the visit to GitHub", async () => {
		sessionStorage.setItem(
			"wlp.new-agent.draft",
			JSON.stringify({ prompt: "Add a health check", kind: "item", criteria: "It answers 200." }),
		);
		await show();
		expect(field().value).toBe("Add a health check");
		expect(pill("agent")).not.toBeNull();
		expect(pill("criteria")).toBeNull();
	});
});

describe("the start composer's one-line tray", () => {
	it("is +, the agent, where, options, the isolation and Launch, in that order", async () => {
		await show();
		const tray = host.querySelector(".start-tools") as HTMLElement;
		expect([...tray.querySelectorAll("[data-picker]")].map(control => (control as HTMLElement).dataset.picker)).toEqual(
			["setup", "agent", "effort", "where", "options", "isolation"],
		);
		expect(tray.querySelector(".tray-end .start-launch")).not.toBeNull();
		// No mode pill and no line of facts under the box: they are in the menus and the isolation's tooltip.
		expect(host.querySelector('[data-picker="mode"], [data-picker="repo"]')).toBeNull();
		expect(host.querySelector("p.start-sandbox")).toBeNull();
	});

	it("has one where control: the place and the repository at its branch, chosen in one menu", async () => {
		await show();
		const where = pill("where") as HTMLButtonElement;
		expect(where.dataset.value).toBe("Hosted");
		expect(where.dataset.repo).toBe("acme/harbor @ main");
		expect(where.textContent).toContain("Hosted");
		expect(where.textContent).toContain("harbor");
		expect(where.textContent).toContain("main");
		expect(where.querySelector(".repo-tile")).not.toBeNull();
		open("where");
		const labels = [...pop().querySelectorAll(".ui-menu-group-label b")].map(label => label.textContent);
		expect(labels).toEqual(["Hosted", "My machines", "Repository"]);
		const repoRow = pop().querySelector('[data-value="repo"]') as HTMLElement;
		expect(repoRow.textContent).toContain("acme/harbor");
		expect(repoRow.textContent).toContain("at main");
		// Its row opens the repository's picker in the menu's place.
		act(() => repoRow.click());
		await act(async () => void (await new Promise(resolve => setTimeout(resolve, 5))));
		expect(pop().textContent).toContain("Paste an address");
		expect(document.querySelectorAll(".ui-pop")).toHaveLength(1);
	});

	it("chooses the effort with its own button beside the agent, and lists models only in the agent's menu", async () => {
		await show();
		open("agent");
		expect([...pop().querySelectorAll(".ui-menu-group-label b")].map(label => label.textContent)).not.toContain(
			"Effort",
		);
		pick("windlass:gpt-6.1-sol");
		open("effort");
		pick("high");
		expect(value("effort")).toBe("high");
		expect(pill("effort")?.querySelectorAll(".effort-bars .effort-bar-on").length).toBeGreaterThan(0);
		expect(pill("effort")?.getAttribute("aria-label")).toBe("Effort: high");
	});

	it("hides the effort button for a model that takes none", async () => {
		await show();
		open("on");
		pick("m_nas");
		await settle();
		open("agent");
		switchAgent("Claude Code");
		pick("claude:haiku");
		expect(pill("effort")).toBeNull();
	});

	it("groups the models by provider, with clean names and the credential each uses", async () => {
		await show();
		open("on");
		pick("m_nas");
		await settle();
		open("agent");
		expect(pop().querySelector('[data-value="windlass:gpt-6.1-sol"] .ui-item-label')?.textContent).toBe("GPT-6.1 Sol");
		expect(pop().textContent).not.toContain("provider-prefixed");
		switchAgent("Claude Code");
		const label = pop().querySelector(".ui-menu-group-label") as HTMLElement;
		expect(label.querySelector("b")?.textContent).toBe("Anthropic");
		expect(label.textContent).toContain("Claude subscription · nas");
	});

	it("says the isolation at rest in one plain word, and puts isolation and size with Hosted", async () => {
		await show();
		const chip = pill("isolation") as HTMLButtonElement;
		// acme/harbor's saved default is Open: said in plain ink, never amber, as nothing needs doing.
		expect(chip.dataset.value).toBe("Open");
		expect(chip.getAttribute("aria-label")).toMatch(
			/^Isolation: Open: Commands run freely and can reach the internet\. Runs hosted, Small \(1 CPU · 1 GB · \$0\.067\/h\)\.$/,
		);
		expect(host.querySelector(".start [class*=warn], .start svg.warn")).toBeNull();
		open("options");
		expect([...pop().querySelectorAll(".ui-menu-group-label b")].map(label => label.textContent)).toEqual(["Mode"]);
		act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		open("where");
		expect(pop().querySelector('[data-value="platform"]')?.textContent).toContain("Open · Small");
		act(
			() =>
				void pop()
					.querySelector('[data-value="platform"]')
					?.dispatchEvent(new MouseEvent("pointermove", { bubbles: true })),
		);
		act(
			() =>
				void document.activeElement?.dispatchEvent(
					new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
				),
		);
		const sub = document.querySelector(".ui-pop-sub") as HTMLElement;
		expect([...sub.querySelectorAll(".ui-menu-group-label b")].map(label => label.textContent)).toEqual([
			"Isolation",
			"Size",
		]);
		expect([...sub.querySelectorAll(".ui-item-label")].map(label => label.textContent)).toEqual([
			"Strict",
			"Open",
			"Small",
			"Medium",
			"Large",
		]);
		expect(sub.querySelector("[class*=warn]")).toBeNull();
		expect(sub.textContent).not.toMatch(/E2B|Docker|microVM|Daytona|agentOS|Firecracker/);
	});
});

describe("each picker of the start composer", () => {
	it("sends no repository, chosen in the repository's picker", async () => {
		await show();
		await openRepo();
		press("No repository");
		expect(value("repo")).toBe("none");
		write("Look around");
		await enter();
		expect(created).toHaveLength(1);
		expect(created[0]?.repository).toBeUndefined();
		expect(created[0]?.repoUrl).toBeUndefined();
	});

	it("sends a pasted address", async () => {
		await show();
		await openRepo();
		press("Paste an address");
		write("https://example.com/acme/pier.git", pop().querySelector('input[type="url"]') as HTMLInputElement);
		expect(value("repo")).toBe("example.com/acme/pier");
		write("Look around");
		await enter();
		expect(created[0]).toMatchObject({ repoUrl: "https://example.com/acme/pier.git" });
		expect(created[0]?.repository).toBeUndefined();
	});

	it("sends the setup command changed beside the repository's picker, and offers its secrets there", async () => {
		await show();
		open("setup");
		await settle();
		const setup = pop().querySelector("textarea.setup-input") as HTMLTextAreaElement;
		expect(setup.value).toBe("npm ci");
		expect([...pop().querySelectorAll("button")].some(button => button.textContent === "Manage…")).toBe(true);
		write("pnpm install", setup);
		write("Look around");
		await enter();
		expect(created[0]?.setupCommand).toBe("pnpm install");
	});

	it("sends the place chosen, with that machine's sandbox", async () => {
		await show();
		expect(value("on")).toBe("Hosted");
		open("on");
		pick("m_nas");
		expect(value("on")).toContain("nas");
		write("Run the tests on my machine");
		await enter();
		expect(created[0]).toMatchObject({ place: { kind: "machine", machineId: "m_nas" }, profile: "docker-hardened" });
	});

	it("offers hosted agents with a compatible Settings key and explains missing keys", async () => {
		await show();
		open("agent");
		const claudeDisabled = () =>
			pop().querySelector('[aria-label="Switch agent"] [aria-label="Claude Code"]')?.getAttribute("aria-disabled") ===
			"true";
		expect(claudeDisabled()).toBe(true);
		// A disabled agent says why and leads straight to its Connections cell.
		const connect = pop().querySelector<HTMLElement>(".picker-connect")!;
		expect(connect.textContent).toContain("not connected for Hosted");
		const link = [...connect.querySelectorAll("a")].find(a => a.textContent === "Connect Claude Code");
		expect(link?.getAttribute("href")).toMatch(/^\/connections(\?mock=[^#]*)?#claude-hosted$/);
		const user = client.user(ada);
		const save = () => user.saveModelProvider({ provider: "anthropic", key: "sk-ant-api03-" + "x".repeat(32) });
		await save();
		await act(async () => void window.dispatchEvent(new Event(PROVIDERS_CHANGED)));
		expect(claudeDisabled()).toBe(false);
		expect(pop().querySelector('[data-value="windlass:anthropic/claude-sonnet-4"]')).toBeTruthy();
		await user.removeModelProvider("anthropic");
		await act(async () => void window.dispatchEvent(new Event("focus")));
		expect(claudeDisabled()).toBe(true);
		expect(pop().querySelector('[data-value="windlass:anthropic/claude-sonnet-4"]')).toBeNull();
		await save();
		await act(async () => void window.dispatchEvent(new Event(PROVIDERS_CHANGED)));
		const codex = pop().querySelector('[aria-label="Switch agent"] [aria-label="Codex"]') as HTMLElement;
		expect(codex.getAttribute("aria-disabled")).toBe("true");
		switchAgent("OpenCode");
		expect(pop().querySelector('[data-value="opencode:default"]')).toBeTruthy();
		expect(pop().querySelector('[data-value="opencode:anthropic/claude-sonnet-4"]')).toBeTruthy();
		expect(pop().textContent).toContain("Hosted agents use the plans and keys on Connections.");
		expect(pop().querySelector(".picker-connect")?.textContent).not.toContain("Claude Code");
		switchAgent("Claude Code");
		pick("claude:sonnet");
		write("Run the hosted task");
		await enter();
		expect(created[0]).toMatchObject({ harness: "claude", model: "sonnet", profile: "docker-hardened" });
		expect(created[0]?.place).toBeUndefined();
		expect(prompted).toHaveLength(1);
	});

	it("sends Claude Code chosen on a machine that offers it, in the hardened container on its own default model", async () => {
		await show();
		open("on");
		pick("m_nas");
		await settle();
		open("agent");
		switchAgent("Claude Code");
		pick("claude:default");
		// nas's runner reported Claude Code's models: the adapter's default, by the name it gives it.
		expect(value("agent")).toBe("Claude Code · Default (recommended)");
		expect(value("mode")).toBe("Auto");
		write("Add the test command to the README");
		await enter();
		expect(created[0]).toMatchObject({
			harness: "claude",
			profile: "docker-hardened",
			place: { kind: "machine", machineId: "m_nas" },
			mode: "auto",
		});
		expect(created[0]?.model).toBeUndefined();
	});

	it("switches agent in one press from the logo row at the top of the agent's menu", async () => {
		await show();
		open("on");
		pick("m_nas");
		await settle();
		open("agent");
		const row = pop().querySelector('[aria-label="Switch agent"]') as HTMLElement;
		expect([...row.querySelectorAll("button")].map(button => button.getAttribute("aria-label"))).toContain(
			"Claude Code",
		);
		expect(row.querySelector('[aria-pressed="true"]')?.getAttribute("aria-label")).toBe("Windlass");
		act(() => (row.querySelector('[aria-label="Claude Code"]') as HTMLButtonElement).click());
		expect(value("agent")?.startsWith("Claude Code · ")).toBe(true);
		// The menu stays open on the agent's models.
		expect(pop().querySelector('[data-value^="claude:"]')).not.toBeNull();
	});

	it("sends the model chosen with the agent, and the effort with its first prompt", async () => {
		await show();
		open("agent");
		pickModelEffort("windlass:gpt-6.1-sol", "low");
		expect(value("agent")).toBe("Windlass · GPT-6.1 Sol");
		expect(value("effort")).toBe("low");
		// The agent's menu lists models only: the efforts are the effort picker's.
		open("agent");
		expect(pop().querySelector(".ui-pop-sub, [aria-haspopup]")).toBeNull();
		open("agent");
		write("Fix the flaky test");
		await enter();
		expect(created[0]?.model).toBe("gpt-6.1-sol");
		expect(prompted[0]?.effort).toBe("low");
	});

	/** The machines, each of whose Claude Code reports these options. */
	const reporting =
		(options: { models: Array<{ id: string; name: string | null; efforts: string[] }>; defaultModel: string }) =>
		(list: MachineSummary[]) =>
			list.map(machine => ({
				...machine,
				harnesses: machine.harnesses?.map(harness => ({
					...harness,
					optionsDigest: undefined,
					options: { ...options, modes: [], checkedAt: 1 },
				})),
			}));
	/** The agent picker's rows of Claude Code's models: each as shown (its "default" tag after it), and whether it is chosen. */
	const modelRows = () =>
		[...pop().querySelectorAll('[data-value^="claude:"]')].map(row => [
			`${row.querySelector(".ui-item-label")?.textContent}${row.querySelector(".ui-tag") ? " default" : ""}`,
			row.getAttribute("aria-checked") === "true",
		]);

	it("offers Claude Code's models and efforts as its machine's runner reported them, and sends the ones chosen", async () => {
		const models = [
			{ id: "opus", name: "Opus", efforts: ["low", "high"] },
			{ id: "sonnet", name: "Sonnet", efforts: ["low", "high"] },
			{ id: "haiku", name: null, efforts: [] },
		];
		await show({ machines: reporting({ models, defaultModel: "opus" }) });
		open("on");
		pick("m_nas");
		open("agent");
		switchAgent("Claude Code");
		pick("claude:opus");
		open("agent");
		// By the names the adapter gave them, its id in words where it gave none.
		expect(modelRows()).toEqual([
			["Opus default", true],
			["Sonnet", false],
			["Haiku", false],
		]);
		pickModelEffort("claude:sonnet", "high");
		expect(value("agent")).toBe("Claude Code · Sonnet");
		expect(value("effort")).toBe("high");
		write("Add the test command to the README");
		await enter();
		expect(created[0]).toMatchObject({ harness: "claude", model: "sonnet" });
		expect(prompted[0]?.effort).toBe("high");
	});

	it("starts Claude Code on the default its runner reported, not the first model listed, and sends no model for it", async () => {
		const models = [
			{ id: "haiku", name: "Haiku", efforts: [] },
			{ id: "opus", name: "Opus", efforts: ["low", "high"] },
		];
		await show({ machines: reporting({ models, defaultModel: "opus" }) });
		open("on");
		pick("m_nas");
		open("agent");
		switchAgent("Claude Code");
		pick("claude:opus");
		expect(value("agent")).toBe("Claude Code · Opus (default)");
		open("agent");
		expect(modelRows()).toEqual([
			["Haiku", false],
			["Opus default", true],
		]);
		// Away and back: the default chosen again is still the adapter's own, and its efforts are offered.
		pick("claude:haiku");
		expect(value("agent")).toBe("Claude Code · Haiku");
		open("agent");
		pickModelEffort("claude:opus", "high");
		expect(value("agent")).toBe("Claude Code · Opus (default)");
		expect(value("effort")).toBe("high");
		write("Add the test command to the README");
		await enter();
		expect(created[0]).toMatchObject({ harness: "claude" });
		expect(created[0]?.model).toBeUndefined();
		expect(prompted[0]?.effort).toBe("high");
	});

	it("sends the mode chosen", async () => {
		await show();
		expect(value("mode")).toBe("Full");
		mode("Ask");
		expect(value("mode")).toBe("Ask");
		write("Fix the flaky test");
		await enter();
		expect(created[0]?.mode).toBe("ask");
	});

	it("sends the sandbox chosen, and offers its saved default back", async () => {
		await show();
		expect(value("sandbox")).toBe("Open");
		open("sandbox");
		pickIn("platform", "docker-windlass-sandbox");
		expect(value("sandbox")).toBe("Strict");
		expect(pill("sandbox")?.classList.contains("ui-pill-changed")).toBe(true);
		open("sandbox");
		expect(pop().textContent).toContain("Back to the default (acme/harbor's: Open)");
		write("Fix the flaky test");
		await enter();
		expect(created[0]).toMatchObject({ profile: "docker-windlass-sandbox", mode: "auto" });
	});
});

describe("what the start composer starts on", () => {
	/** An agent of the user's launched on no repository, on "nas", in the hardened container, on the second model and in Ask: the newest of all. */
	const lastOnNas = async (mock: MockClient) => {
		await mock.user(ada).createSession({
			place: { kind: "machine", machineId: "m_nas" },
			profile: "docker-hardened",
			model: "gpt-6-sol",
			mode: "ask",
		});
	};

	it("launches with the repository's machine and profile over the account place and hosted sandbox", async () => {
		await show({
			repositoryId: 7101,
			before: async mock => {
				const user = mock.user(ada);
				await user.saveAccountDefaults({ startPlace: { kind: "hosted" } });
				await user.saveRepositoryDefaults(7101, {
					startPlace: { kind: "machine", machineId: "m_nas", profile: "docker-windlass-sandbox" },
				});
			},
		});
		expect(value("on")).toBe("nas");
		write("Run the tests");
		await enter();
		expect(created[0]).toMatchObject({
			place: { kind: "machine", machineId: "m_nas" },
			profile: "docker-windlass-sandbox",
		});
	});

	it("explains a removed repository machine and uses the account default", async () => {
		await show({
			repositoryId: 7101,
			machines: () => [],
			before: async mock => {
				const user = mock.user(ada);
				await user.saveAccountDefaults({ startPlace: { kind: "hosted" } });
				await user.saveRepositoryDefaults(7101, {
					startPlace: { kind: "machine", machineId: "m_nas", profile: "docker-hardened" },
				});
			},
		});
		expect(value("on")).toBe("Hosted");
		open("on");
		expect(pop().textContent).toContain("machine from your repository default is no longer paired");
	});

	it("starts from deployment defaults after a launch on another machine", async () => {
		await show({ before: lastOnNas });
		created = [];
		expect(value("repo")).toBe("none");
		write("Look around");
		await enter();
		expect(created[0]?.place).toBeUndefined();
		expect(created[0]).toMatchObject({ model: "gpt-6.1-sol", mode: "auto" });
	});

	it("puts the account's saved default before the newest agent's, and the repository's before the account's", async () => {
		await show({
			before: async mock => (
				await lastOnNas(mock),
				void (await mock.user(ada).saveAccountDefaults({ model: "gpt-6.1-sol", profile: "docker-windlass-sandbox" }))
			),
		});
		created = [];
		write("Look around");
		await enter();
		expect(created[0]?.place).toBeUndefined();
		expect(created[0]).toMatchObject({ profile: "docker-windlass-sandbox", model: "gpt-6.1-sol" });
		act(() => root?.unmount());
		root = null;
		client.dispose();
		created = [];
		// Opened from acme/harbor's page: its saved defaults come first.
		await show({
			repositoryId: 7101,
			before: async mock =>
				void (await mock.user(ada).saveAccountDefaults({ model: "gpt-6.1-sol", profile: "docker-windlass-sandbox" })),
		});
		write("Look around");
		await enter();
		expect(created[0]).toMatchObject({ repository: { id: 7101 }, profile: "docker-hardened", model: "gpt-6-luna" });
	});

	it("puts a choice made here before every default", async () => {
		await show({ repositoryId: 7101 });
		open("agent");
		pick("windlass:gpt-6-sol");
		open("sandbox");
		pickIn("platform", "docker-windlass-sandbox");
		write("Look around");
		await enter();
		expect(created[0]).toMatchObject({ profile: "docker-windlass-sandbox", model: "gpt-6-sol" });
	});
});

describe("the start composer and the visit to GitHub", () => {
	it("keeps the task and every choice, the mode included, across connecting GitHub", async () => {
		await show({ who: demo });
		write("Add a health check");
		open("on");
		pick("m_nas");
		mode("Ask");
		await openRepo();
		expect(value("repo")).toBe("none");
		// The browser leaves for GitHub here; jsdom stays, with what was kept for the way back.
		press("Connect GitHub");
		await settle();
		expect(JSON.parse(sessionStorage.getItem("wlp.new-agent.draft") ?? "null")).toMatchObject({
			prompt: "Add a health check",
			place: "m_nas",
			mode: "ask",
		});
		// Back from GitHub: the page loads again.
		act(() => root?.unmount());
		root = null;
		client.dispose();
		await show({ who: demo });
		expect(field().value).toBe("Add a health check");
		expect(value("on")).toContain("nas");
		expect(value("mode")).toBe("Ask");
		await enter();
		expect(created[0]).toMatchObject({ place: { kind: "machine", machineId: "m_nas" }, mode: "ask" });
	});
});

describe("connecting GitHub from the start composer in a popup", () => {
	/** A window `window.open` hands back: where it was sent, and whether it was closed. */
	let opened: { location: { href: string }; closed: boolean; close(): void; focus(): void; document: Document } | null;
	let realOpen: typeof window.open;
	/** A demo user of each test's own: the GitHub connection's state is one per user, for the page's life. */
	let who: AuthResult;
	let made = 0;
	beforeEach(() => {
		realOpen = window.open;
		opened = null;
		made += 1;
		who = { token: `mock:demo:demo_popup${made}:`, profile: { uid: `demo_popup${made}`, email: null, demo: true } };
	});
	afterEach(() => {
		window.open = realOpen;
	});
	const popupOpens = () => {
		window.open = (() => {
			opened = {
				location: { href: "about:blank" },
				closed: false,
				close() {
					this.closed = true;
				},
				focus() {},
				document: document.implementation.createHTMLDocument(""),
			};
			return opened as unknown as Window;
		}) as typeof window.open;
	};
	/** The popup back from GitHub: its message, from a window this page opened. */
	const popupAnswers = async (hash: string) => {
		const frame = document.createElement("iframe");
		document.body.append(frame);
		const from = frame.contentWindow as Window;
		Object.defineProperty(from, "opener", { value: window });
		await act(
			async () =>
				void window.dispatchEvent(
					new MessageEvent("message", {
						origin: location.origin,
						source: from,
						data: { type: "wlp.github.return", hash },
					}),
				),
		);
		if (opened) opened.closed = true;
		frame.remove();
		// The picker lists again after its search's pause.
		await act(async () => void (await new Promise(resolve => setTimeout(resolve, 400))));
		await settle(20);
	};

	it("keeps the page and the task, and lists the repositories once GitHub answers", async () => {
		popupOpens();
		await show({ who });
		write("Add a health check");
		await openRepo();
		press("Connect GitHub");
		await settle(40);
		// The window went to GitHub; this page stayed, and kept nothing for a way back.
		expect(opened?.location.href).toContain(`#github=mock.${who.profile.uid}`);
		expect(sessionStorage.getItem("wlp.new-agent.draft")).toBeNull();
		expect(pop()?.textContent).toContain("Finish connecting in the GitHub window.");
		await popupAnswers(`#github=mock.${who.profile.uid}`);
		expect(field().value).toBe("Add a health check");
		// Connected: the repository's picker lists them, without going anywhere.
		expect(pop()?.textContent).toContain("Your repositories");
		expect(pop()?.textContent).toContain("acme/harbor");
		expect(await client.user(who).github()).toMatchObject({ connection: { login: expect.any(String) } });
	});

	it("offers reconnect in the picker and opens GitHub for the connected user", async () => {
		popupOpens();
		await show();
		await openRepo();
		expect(pop().textContent).toContain("Installed by someone else? Reconnect GitHub to pick it up.");
		press("Reconnect GitHub");
		await settle();
		expect(opened?.location.href).toContain(`#github=mock.${ada.profile.uid}`);
		await popupAnswers(`#github=mock.${ada.profile.uid}`);
	});

	it("says so when the window is closed before GitHub answered, and connects nothing", async () => {
		popupOpens();
		await show({ who });
		write("Add a health check");
		await openRepo();
		press("Connect GitHub");
		await settle(40);
		act(() => opened?.close());
		// It looks every half second, and waits a moment for a message that may be on its way.
		await act(async () => void (await new Promise(resolve => setTimeout(resolve, 1500))));
		await settle();
		expect(host.textContent + (pop()?.textContent ?? "")).toContain(
			"GitHub was not connected: its window was closed before it finished.",
		);
		expect(field().value).toBe("Add a health check");
		expect(await client.user(who).github()).toEqual({ connection: null });
	});

	it("leaves the page for GitHub when the browser blocks the popup, keeping the task for the way back", async () => {
		let asked = 0;
		window.open = (() => (asked++, null)) as typeof window.open;
		await show({ who });
		write("Add a health check");
		await openRepo();
		press("Connect GitHub");
		await settle();
		expect(asked).toBe(1);
		expect(JSON.parse(sessionStorage.getItem("wlp.new-agent.draft") ?? "null")).toMatchObject({
			prompt: "Add a health check",
		});
	});
});

it("opens an item's repository placement in the composer and honors an explicit hosted choice", async () => {
	client = mock();
	saveAuth("mock", ada);
	const user = client.user(ada);
	await user.saveAccountDefaults({ place: "hosted" });
	await user.saveRepositoryDefaults(7101, {
		place: { machine: "m_nas" },
		harness: "claude",
		reviewModel: "gpt-6-sol",
		machineProfile: "docker-hardened",
	});
	root = createRoot(host);
	act(() =>
		root!.render(
			createElement(AppProvider, {
				client,
				children: createElement(StartComposer, { kind: "item", sessions: [], items: [], repositoryId: 7101 }),
			}),
		),
	);
	await settle();
	expect(value("on")).toContain("nas");
	// Plan first: the parts start from the repository's agent, and the line says where that comes from.
	expect(value("agent")).toContain("Claude Code");
	const line = host.querySelector(".run-line")!.textContent!;
	expect(line).toContain("Parts run on");
	expect(host.querySelector(".start-run")?.textContent).toContain(
		"Planning and review run on Windlass with GPT-6 Sol.",
	);
	expect(line).toContain("nas · Claude Code");
	expect(line).toContain("set for this repository");
	open("where");
	pick("platform");
	expect(value("on")).toBe("Hosted");
	write("Run this one on the platform");
	const title = host.querySelector<HTMLInputElement>(".start-item input[maxlength]")!;
	expect(title.value).toBe("Run this one on the platform");
	write("Check  hosted placement", title);
	await launchMenu("File as a draft");
	await settle();
	const filed = (await user.listItems()).find(i => i.title === "Check  hosted placement");
	expect(filed?.place).toEqual({ kind: "hosted" });
});
