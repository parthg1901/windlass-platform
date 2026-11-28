// @vitest-environment jsdom
/**
 * The mock's machines: what the Machines page is looked at with, by hand and here. It answers as the
 * server's user actor says it does (contract.ts, `UserActions.machines` and the four calls after it).
 */
import { HARNESS_NAMES } from "../lib/acp";
import { workingCounts } from "../lib/repositories";
import { MAX_MACHINES, type AuthResult, type CreateSessionInput, type MachineSummary } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveAuth } from "../lib/authStore";
import { NewAgent } from "../screens/NewAgent";
import { AppProvider } from "../state/app";
import type { UserFeed, UserApi } from "./client";
import { createMockClient, MOCK_MACHINE_STATES, type MockClient, type MockMachineSession } from "./mock";

const auth = {
	token: "mock:user:u_machines:ada@example.com",
	profile: { uid: "u_machines", email: "ada@example.com", demo: false },
};
const make = (machine?: (typeof MOCK_MACHINE_STATES)[number]) => createMockClient({ pace: 0, machine });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

describe("the mock's machines", () => {
	it("offers machines unless told not to, with an install command only once a runner is published", async () => {
		const on = make();
		const info = await on.info();
		expect(info.machines?.runnerImage).toMatch(/@sha256:[0-9a-f]{64}$/);
		expect(info.machines?.minRunnerVersion).toBe("0.3.13");
		expect((await make("unpublished").info()).machines?.runnerImage).toBeNull();
		const off = make("off");
		expect((await off.info()).machines).toBeUndefined();
		await expect(off.user(auth).machines()).rejects.toMatchObject({ reason: "machines_off" });
		on.dispose();
		off.dispose();
	});

	it("names each sandbox by its agent's title, and none for an agent that was deleted", async () => {
		const mock = make();
		const [nas] = await mock.user(auth).machines();
		expect(nas?.status).toBe("online");
		expect(nas?.sandboxes.map(sandbox => sandbox.title)).toEqual(["Run the tests on my machine", null]);
		mock.dispose();
	});

	it("lists each machine's sandboxes as its runner reported them, none before it reported", async () => {
		const profiles = async (state: (typeof MOCK_MACHINE_STATES)[number]) => {
			const mock = make(state);
			const list = await mock.user(auth).machines();
			mock.dispose();
			return list.map(machine => machine.profiles.map(profile => profile.available));
		};
		expect(await profiles("online")).toEqual([[true, true]]);
		expect(await profiles("pairing")).toEqual([[]]);
		expect(await profiles("docker")).toEqual([[false, false]]);
		expect(await profiles("full")).toEqual([
			[true, true],
			[false, true],
			[true, true],
		]);
	});

	it("launches an agent on a machine with one of its sandboxes, outside the day's sandbox time", async () => {
		const mock = createMockClient({ pace: 0, usage: "used" });
		const user = mock.user(auth);
		const made = await user.createSession({
			place: { kind: "machine", machineId: "m_nas" },
			profile: "docker-hardened",
			title: "On nas",
		});
		expect(made.place).toEqual({ kind: "machine", machineId: "m_nas" });
		const session = mock.session(auth, made.id);
		const snapshots: Array<{ machine?: unknown; profile: string }> = [];
		const close = session.open({
			onSnapshot: snapshot => snapshots.push({ machine: snapshot.machine, profile: snapshot.profile.name }),
			onItem: () => undefined,
			onDelta: () => undefined,
			onSummary: () => undefined,
			onQuestion: () => undefined,
			onConnection: () => undefined,
		});
		await tick();
		expect(snapshots[0]).toEqual({ machine: null, profile: "Open" });
		// The day's time is used up, and a turn on the user's own machine starts all the same.
		expect(await session.prompt({ text: "What is 1 + 1, to be sure?" })).toEqual({ turn: 1, steered: false });
		await expect(
			user.createSession({ place: { kind: "machine", machineId: "m_nas" }, profile: "e2b" }),
		).rejects.toThrow("There is no such sandbox.");
		close();
		mock.dispose();
	});

	it("fails a turn at once with the server's sentence when the agent's machine is offline or removed, and its snapshot says so", async () => {
		const failed = async (machineSession: MockMachineSession) => {
			const mock = createMockClient({ pace: 0, machineSession });
			const session = mock.session(auth, "nas-tests");
			const seen: { machine?: unknown; message?: string | null } = {};
			const close = session.open({
				onSnapshot: snapshot => (seen.machine = snapshot.machine?.state),
				onItem: item => {
					if (item.kind === "turn.ended" && item.outcome === "error") seen.message = item.message;
				},
				onDelta: () => undefined,
				onSummary: () => undefined,
				onQuestion: () => undefined,
				onConnection: () => undefined,
			});
			await tick();
			const before = seen.machine;
			await session.prompt({ text: "Run the tests again." });
			await tick();
			session.resync();
			await new Promise(resolve => setTimeout(resolve, 80));
			close();
			mock.dispose();
			return { before, after: seen.machine, message: seen.message };
		};
		expect(await failed("offline")).toEqual({
			before: "answering",
			after: "offline",
			message: `Your machine "nas" is offline. The agent's files are there; send the prompt again when it is back.`,
		});
		expect(await failed("removed")).toEqual({
			before: "removed",
			after: "removed",
			message: "This agent's machine was removed. Its files were there. Start a new agent to go on.",
		});
	});

	it("tells the open page when the machine stops answering and when it is back", async () => {
		const mock = createMockClient({ pace: 0, machineSession: "not_answering" });
		const seen: string[] = [];
		const close = mock.session(auth, "nas-tests").open({
			onSnapshot: snapshot => seen.push(`snapshot ${snapshot.machine?.state}`),
			onMachine: machine => seen.push(machine.state),
			onItem: () => undefined,
			onDelta: () => undefined,
			onSummary: () => undefined,
			onQuestion: () => undefined,
			onConnection: () => undefined,
		});
		try {
			await vi.waitFor(() => expect(seen).toEqual(["snapshot answering", "not_answering", "answering"]));
		} finally {
			close();
			mock.dispose();
		}
	});

	it("starts a turn on a machine when the hosted agents working are at the ceiling", async () => {
		vi.useFakeTimers();
		try {
			const mock = createMockClient({});
			const user = mock.user(auth);
			const settle = async <T>(promise: Promise<T>) => {
				await vi.advanceTimersByTimeAsync(400);
				return promise;
			};
			// Hosted agents fill the deployment's ceiling, beside the seeds' that are at work.
			const hosted = async () => (await settle(user.createSession({ profile: "docker-windlass-sandbox" }))).id;
			// Only what runs on the platform's sandboxes counts (server/src/actors/user.ts, `internalAcquireRun`).
			const working = workingCounts(await settle(user.listSessions())).ceilinged;
			const { hostedRunning } = await settle(user.factoryLimits());
			for (let filled = working; filled < hostedRunning; filled++)
				await settle(mock.session(auth, await hosted()).prompt({ text: "Run the full build and the tests." }));
			const refused = expect(
				mock.session(auth, await hosted()).prompt({ text: "Run the full build and the tests." }),
			).rejects.toMatchObject({ reason: "too_many_running" });
			await vi.advanceTimersByTimeAsync(400);
			await refused;
			const onNas = await settle(
				user.createSession({ place: { kind: "machine", machineId: "m_nas" }, profile: "docker-hardened" }),
			);
			expect(await settle(mock.session(auth, onNas.id).prompt({ text: "Run the full build and the tests." }))).toEqual({
				turn: 1,
				steered: false,
			});
			mock.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("starts each state as its name says", async () => {
		const first = async (state: (typeof MOCK_MACHINE_STATES)[number]) => {
			const mock = make(state);
			const list = await mock.user(auth).machines();
			mock.dispose();
			return list;
		};
		expect(await first("none")).toEqual([]);
		expect((await first("pairing"))[0]).toMatchObject({ status: "waiting", sandboxes: [], commandSandbox: null });
		expect((await first("outdated"))[0]?.warnings).toEqual([{ kind: "outdated" }]);
		expect((await first("key"))[0]?.warnings[0]?.kind).toBe("key");
		expect(await first("full")).toHaveLength(MAX_MACHINES);
		const failed = make("failed");
		await expect(failed.user(auth).machines()).rejects.toMatchObject({ code: "network" });
		failed.dispose();
	});

	it("pairs a machine by its code, however it is typed, and its runner then connects", async () => {
		const mock = make("none");
		const user = mock.user(auth);
		const heard: MachineSummary[][] = [];
		const close = user.watch({ onSessions: () => undefined, onMachines: list => heard.push(list) });
		await tick();
		expect(await user.claimMachine({ code: "wxyz-12lo" })).toMatchObject({
			name: "workstation",
			os: "Linux",
			arch: "x64",
		});
		const made = await user.confirmMachine({ code: "WXYZ 1210", keyConfirmed: true });
		expect(made.status).toBe("waiting");
		// Asked again for the same code, it is the same machine.
		expect((await user.confirmMachine({ code: "WXYZ-1210", keyConfirmed: true })).machineId).toBe(made.machineId);
		await tick();
		expect(heard.at(-1)?.map(machine => machine.status)).toEqual(["online"]);
		close();
		mock.dispose();
	});

	it("denies a code it looked up, so it pairs nothing, and refuses to deny one it did not", async () => {
		const mock = make("none");
		const user = mock.user(auth);
		await expect(user.denyMachine({ code: "WXYZ-1210" })).rejects.toMatchObject({ reason: "pairing_not_found" });
		await user.claimMachine({ code: "WXYZ-1210" });
		await user.denyMachine({ code: "wxyz 12lo" });
		await expect(user.confirmMachine({ code: "WXYZ-1210", keyConfirmed: true })).rejects.toMatchObject({
			reason: "pairing_not_found",
		});
		await expect(user.claimMachine({ code: "WXYZ-1210" })).rejects.toMatchObject({ reason: "pairing_not_found" });
		// Once paired, denying changes nothing.
		await user.claimMachine({ code: "WXYZ-1211" });
		const made = await user.confirmMachine({ code: "WXYZ-1211", keyConfirmed: true });
		await user.denyMachine({ code: "WXYZ-1211" });
		expect((await user.machines()).map(machine => machine.machineId)).toEqual([made.machineId]);
		mock.dispose();
	});

	it("refuses an unknown code, a sixth try in ten minutes, and a machine past the limit", async () => {
		const mock = make("none");
		const user = mock.user(auth);
		await expect(user.claimMachine({ code: "ZZZZ-ZZZZ" })).rejects.toMatchObject({ reason: "pairing_not_found" });
		for (const code of ["AAAA-0001", "AAAA-0002", "AAAA-0003", "AAAA-0004"]) await user.claimMachine({ code });
		await expect(user.claimMachine({ code: "AAAA-0005" })).rejects.toMatchObject({ reason: "too_many_claims" });
		mock.dispose();
		const full = make("full");
		await expect(full.user(auth).claimMachine({ code: "AAAA-0006" })).rejects.toMatchObject({
			reason: "too_many_machines",
		});
		full.dispose();
	});

	it("removes a machine and turns its secrets off, answering with the list as it is then", async () => {
		const mock = make("full");
		const user = mock.user(auth);
		const [nas] = await user.machines();
		const off = await user.setMachineSecrets({ machineId: nas!.machineId, send: false });
		expect(off.find(machine => machine.machineId === nas!.machineId)?.sendSecrets).toBe(false);
		const left = await user.removeMachine({ machineId: nas!.machineId, removeSandboxes: true });
		expect(left.map(machine => machine.name)).toEqual(["workshop", "build-box"]);
		await expect(user.removeMachine({ machineId: nas!.machineId, removeSandboxes: false })).rejects.toMatchObject({
			reason: "machine_not_found",
		});
		mock.dispose();
	});

	it("can be read once in the stale state, and not again after the connection dropped", async () => {
		const mock = make("stale");
		const user = mock.user(auth);
		const states: string[] = [];
		const close = user.watch({ onSessions: () => undefined, onConnection: state => states.push(state) });
		await tick();
		expect(await user.machines()).toHaveLength(1);
		await tick();
		await tick();
		expect(states).toContain("reconnecting");
		await expect(user.machines()).rejects.toMatchObject({ code: "network" });
		close();
		mock.dispose();
	});
});

// ---------------------------------------------------------------------------------------------
// The start composer on a machine that offers Claude Code
// ---------------------------------------------------------------------------------------------

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the start composer's agent picker", () => {
	let host: HTMLElement;
	let root: Root;
	let client: MockClient;
	let created: CreateSessionInput[];
	let catalogsRead: string[];
	let feeds: Set<UserFeed>;

	/** Lets the mock answer, in steps: what one answer renders can ask the next. */
	async function settle(steps = 12): Promise<void> {
		for (let step = 0; step < steps; step++)
			await act(async () => void (await new Promise(resolve => setTimeout(resolve, 2))));
	}

	/**
	 * Signs in to a mock whose machines stand as "full" says (nas offers Claude Code signed in, workshop
	 * signed out, build-box not at all) and opens the new agent's page, on no repository: the agent
	 * then starts as the user's newest did, on this platform in Windlass's sandbox.
	 */
	async function open(machine: "full" | "fresh" = "full"): Promise<void> {
		created = [];
		catalogsRead = [];
		feeds = new Set();
		history.replaceState(null, "", "/new");
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		client = createMockClient({ pace: 0, origin: "http://localhost:5173", machine });
		saveAuth("mock", auth);
		const user = client.user.bind(client);
		(client as { user: (auth: AuthResult) => UserApi }).user = who => {
			const api = user(who);
			return {
				...api,
				createSession: (input: CreateSessionInput) => (created.push(input), api.createSession(input)),
				machineCatalog: input => {
					catalogsRead.push(input.id);
					return api.machineCatalog(input);
				},
				watch: feed => {
					feeds.add(feed);
					const close = api.watch(feed);
					return () => {
						feeds.delete(feed);
						close();
					};
				},
			};
		};
		act(() => root.render(createElement(AppProvider, { client, children: createElement(NewAgent) })));
		await settle();
		// The repository is the where menu's last row: it opens the repository's picker.
		chip("where");
		act(() => (pop()?.querySelector('[data-value="repo"]') as HTMLElement).click());
		await settle();
		press("No repository");
		await settle();
	}

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		client.dispose();
		saveAuth("mock", null);
	});

	/** The page's text, with what is open in a picker (drawn at the end of the page). */
	const text = () => document.body.textContent ?? "";
	/** The control of a picker, by the name its old chip had: where it runs, its sandbox and the repository are one pill, and the mode is in the options. */
	const PICKERS: Record<string, string> = {
		repo: "where",
		on: "where",
		sandbox: "where",
		agent: "agent",
		mode: "options",
	};
	const button = (label: string) =>
		host.querySelector(`[data-picker="${PICKERS[label] ?? label}"]`) as HTMLButtonElement;
	/** Opens a pill's picker, by its label, unless it is open; `toggle` closes an open one. */
	const chip = (label: string, toggle = false) => {
		if (toggle || button(label).getAttribute("aria-expanded") !== "true") act(() => button(label).click());
	};
	const value = (label: string) =>
		(label === "sandbox" ? button(label)?.dataset.sandbox : button(label)?.dataset.value) ?? null;
	const pop = () => ([...document.querySelectorAll(".ui-pop")].at(-1) ?? null) as HTMLElement | null;
	const press = (words: string) =>
		act(() =>
			(
				[...(pop()?.querySelectorAll("button") ?? [])].find(button => button.textContent === words) as HTMLButtonElement
			).click(),
		);
	/** Chooses where it runs. */
	const place = (machineId: string) => {
		chip("on");
		act(() => (pop()?.querySelector(`[data-value="${machineId}"]`) as HTMLElement).click());
	};
	const agents = () => {
		chip("agent");
		return [...pop()!.querySelectorAll('.agent-switch button:not([aria-disabled="true"])')].map(button =>
			button.getAttribute("aria-label"),
		);
	};
	const switchAgent = (id: keyof typeof HARNESS_NAMES) => {
		act(() => pop()!.querySelector<HTMLButtonElement>(`.agent-switch [aria-label="${HARNESS_NAMES[id]}"]`)!.click());
	};
	const agent = (id: keyof typeof HARNESS_NAMES) => {
		switchAgent(id);
		const rows = [...pop()!.querySelectorAll<HTMLElement>(`[data-value^="${id}:"]`)];
		const row =
			rows.find(candidate => candidate.dataset.value === `${id}:default` || candidate.querySelector(".ui-tag")) ??
			rows[0]!;
		act(() => row.click());
	};
	/** The approval choices in the open options menu's Mode group. */
	const modeRows = () => {
		const groups = pop()?.querySelectorAll('[role="group"][aria-labelledby]') ?? [];
		const group = [...groups].find(
			candidate => document.getElementById(candidate.getAttribute("aria-labelledby") ?? "")?.textContent === "Mode",
		);
		return [...(group?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
	};
	/** The modes offered, by name, each with what it does, and the one chosen. Its menu is the only one open. */
	const modes = () => {
		chip("mode");
		expect(document.querySelectorAll(".ui-pop")).toHaveLength(1);
		const list = modeRows().map(option => ({
			name: option.querySelector(".ui-item-label")?.textContent,
			text: option.querySelector(".ui-item-description")?.textContent,
			chosen: option.getAttribute("aria-checked") === "true",
		}));
		chip("mode", true);
		return list;
	};
	const mode = (name: string) => {
		chip("mode");
		act(() =>
			(modeRows().find(option => option.querySelector(".ui-item-label")?.textContent === name) as HTMLElement).click(),
		);
	};
	/** The lock in the tray: the chosen sandbox's facts, each with the sentence it stands for. */
	const sandboxLine = () => host.querySelector('[data-picker="isolation"]')?.getAttribute("aria-label") ?? "";
	/** Creates the agent from the launch button's menu. */
	const createWithout = async () => {
		act(() => (host.querySelector(".ui-split-more") as HTMLButtonElement).click());
		await act(async () =>
			(
				[...(pop()?.querySelectorAll('[role="menuitem"]') ?? [])].find(
					row => row.querySelector(".ui-item-label")?.textContent === "Create without a prompt",
				) as HTMLElement
			).click(),
		);
		await settle();
	};
	const launchIt = async () => {
		await act(async () => (host.querySelector('.start button[type="submit"]') as HTMLButtonElement).click());
		await settle();
	};
	const showCommands = () => act(() => (pop()?.querySelector(".agent-commands summary") as HTMLElement).click());

	it("offers Windlass or Claude Code on a machine that reports it, and what pays for it there", async () => {
		await open();
		place("m_workshop");
		await settle();
		expect(agents()).toEqual(["Windlass", "Claude Code", "OpenCode", "Codex"]);
		switchAgent("opencode");
		expect(text()).toContain("OpenAI login · workshop");
		switchAgent("claude");
		// Claude Code pays with the account's plan or key there: no login command is offered.
		expect(text()).toContain("It pays with your plan or key, as Connections sets.");
		if (pop()?.querySelector(".agent-commands")) showCommands();
		expect(pop()?.querySelector(".machine-harness pre")).toBeNull();
		chip("agent", true);
		// The second machine reports its own sign-in state.
		place("m_nas");
		await settle();
		expect(agents()).toEqual(["Windlass", "Claude Code"]);
		switchAgent("claude");
		expect(text()).toContain("Claude subscription · nas");
	}, 30_000);

	it("offers both reported catalogs on a fresh machine and launches OpenCode in its selected mode", async () => {
		await open("fresh");
		const [machine] = await client.user(auth).machines();
		expect(machine).toMatchObject({ agents: 0, sandboxes: [] });
		expect(machine!.harnesses!.every(h => h.optionsDigest && !h.options)).toBe(true);
		expect(catalogsRead).toEqual([]);
		place("m_workshop");
		agents();
		await settle();
		const catalog = (id: string) =>
			Array.from(pop()!.querySelectorAll(`[data-value^="${id}:"] .ui-item-label`), row => row.textContent);
		switchAgent("claude");
		expect(catalog("claude")).toEqual(["Default (recommended)", "Opus", "Haiku"]);
		switchAgent("opencode");
		expect(catalog("opencode")).toEqual(["GPT-5.4", "GPT-5.4 mini"]);
		act(() => {
			for (const feed of feeds)
				feed.onMachineHost?.({
					machineId: machine!.machineId,
					host: { cpus: 2, sandboxCpus: 1, memoryBytes: 12e9, memoryFreeBytes: 4e9, load1: 1 },
				});
		});
		await settle();
		expect([...catalogsRead].sort()).toEqual(["claude", "codex", "opencode"]);
		switchAgent("codex");
		expect(catalog("codex")).toEqual(["6.2 Sol"]);

		agent("opencode");
		expect(value("agent")).toContain("GPT-5.4");
		expect(modes().map(({ name, chosen }) => [name, chosen])).toEqual([
			["build", true],
			["plan", false],
		]);
		mode("plan");
		await createWithout();
		expect(created[0]).toMatchObject({ harness: "opencode", mode: "plan", profile: "docker-hardened" });
	}, 30_000);

	it("offers no other agent on a machine that reports none, nor on this platform", async () => {
		await open();
		expect(agents()).toEqual(["Windlass"]);
		// Hosted Claude Code needs a Settings key.
		expect(pop()?.querySelector('.agent-switch [aria-label="Claude Code"]')?.getAttribute("aria-disabled")).toBe(
			"true",
		);
		chip("agent", true);
		// The choice is on nas, and it goes with the machine.
		place("m_nas");
		expect(agents()).toEqual(["Windlass", "Claude Code"]);
		chip("agent", true);
		place("m_build");
		expect(value("on")).toContain("build-box");
		expect(agents()).toEqual(["Windlass"]);
		chip("agent", true);
		place("platform");
		expect(agents()).toEqual(["Windlass"]);
	});

	it("launches Claude Code in the hardened container, on its default model, with the line that says what that means", async () => {
		await open();
		place("m_nas");
		await settle();
		agents();
		agent("claude");
		agents();
		expect(text()).toContain("It uses its own sign-in on this machine.");
		expect(value("on")).toContain("nas");
		expect(value("sandbox")).toBe("Open");
		// nas's runner reported Claude Code's models: its default is named as the adapter names it, and chosen.
		expect(value("agent")).toBe("Claude Code · Default (recommended)");
		const rows = [...(pop()?.querySelectorAll('[data-value^="claude:"]') ?? [])].map(row => [
			row.querySelector(".ui-item-label")?.textContent,
			row.getAttribute("aria-checked") === "true",
		]);
		expect(rows).toEqual([
			["Default (recommended)", true],
			["Opus", false],
			["Haiku", false],
		]);
		chip("agent", true);
		await createWithout();
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({
			harness: "claude",
			profile: "docker-hardened",
			place: { kind: "machine", machineId: "m_nas" },
		});
		expect(created[0]?.model).toBeUndefined();
	});

	it("starts Claude Code on Auto, of its five modes, each said with what it does; another is sent when chosen", async () => {
		await open();
		place("m_nas");
		await settle();
		agents();
		agent("claude");
		const offered = modes();
		expect(offered.map(one => one.name)).toEqual(["Manual", "Accept edits", "Plan", "Auto", "Bypass permissions"]);
		expect(offered.find(one => one.chosen)).toEqual({
			name: "Auto",
			text: "Automatically assess tool permissions.",
			chosen: true,
		});
		mode("Plan");
		expect(value("mode")).toBe("Plan");
		await createWithout();
		expect(created[0]).toMatchObject({ harness: "claude", mode: "plan" });
	});

	it("starts Windlass on the chosen sandbox's approval, of Ask and that one", async () => {
		await open();
		// This platform's first sandbox has Windlass's command sandbox: Ask and Auto, on Auto.
		expect(modes().map(one => [one.name, one.chosen])).toEqual([
			["Ask", false],
			["Auto", true],
		]);
		expect(modes().find(one => one.chosen)?.text).toBe("Runs safe commands, asks for the rest.");
		// The hardened container has none: Ask and Full, on Full, in the warning tone.
		chip("sandbox");
		act(
			() =>
				void pop()
					?.querySelector('[data-value="platform"]')
					?.dispatchEvent(new MouseEvent("pointermove", { bubbles: true })),
		);
		act(
			() =>
				void document.activeElement?.dispatchEvent(
					new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
				),
		);
		act(() => (document.querySelector('.ui-pop-sub [data-value="docker-hardened"]') as HTMLElement).click());
		expect(modes().map(one => [one.name, one.chosen])).toEqual([
			["Ask", false],
			["Full", true],
		]);
		// Full is the user's own choice: no amber dot, as nothing needs doing.
		expect(button("mode")?.querySelector(".tray-icon-dot-warn")).toBeNull();
		write("Run the tests");
		await launchIt();
		expect(created[0]).toMatchObject({ profile: "docker-hardened", mode: "full" });
	});

	it("keeps a choice of Ask across sandboxes and agents, and stands on the default where the choice is not offered", async () => {
		await open();
		place("m_nas");
		await settle();
		mode("Ask");
		// Claude Code has no Ask: Auto, its default.
		agents();
		agent("claude");
		expect(value("mode")).toBe("Auto");
		agents();
		agent("windlass");
		expect(value("mode")).toBe("Ask");
		place("platform");
		expect(value("mode")).toBe("Ask");
		write("Run the tests");
		await launchIt();
		expect(created[0]?.mode).toBe("ask");
	});

	it("says the isolation and whose sign-in the agent uses in one plain line, and Strict or Open with nas's sandboxes", async () => {
		await open();
		expect(sandboxLine()).toMatch(
			/^Isolation: Strict: Commands sandboxed, no internet\. For untrusted code\. Runs hosted/,
		);
		place("m_nas");
		await settle();
		agents();
		agent("claude");
		expect(sandboxLine()).toBe(
			"Isolation: Open: Commands run freely and can reach the internet. Runs on nas. Uses nas's Claude Code sign-in.",
		);
		expect(sandboxLine()).not.toMatch(/token|relay|Docker/);
		// nas's sandboxes: Strict and Open, each with its outcome line, and no amber.
		chip("sandbox");
		act(
			() =>
				void pop()
					?.querySelector('[data-value="m_nas"]')
					?.dispatchEvent(new MouseEvent("pointermove", { bubbles: true })),
		);
		act(
			() =>
				void document.activeElement?.dispatchEvent(
					new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
				),
		);
		const row = document.querySelector('.ui-pop-sub [aria-checked="true"]') as HTMLElement;
		expect(row.querySelector(".ui-item-label")?.textContent).toBe("Open");
		expect(row.querySelector(".ui-item-description")?.textContent).toBe(
			"Commands run freely and can reach the internet.",
		);
		expect(document.querySelector(".ui-pop-sub [class*=warn]")).toBeNull();
	});

	/** Types the task, as a browser does. */
	function write(task: string): void {
		const field = host.querySelector(".start textarea") as HTMLTextAreaElement;
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, task);
			field.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}
});

it("shows the update and re-pair instructions for an old runner on a signed platform", async () => {
	const { Machines } = await import("../screens/Machines");
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const client = make("outdated");
	const info = await client.info();
	vi.spyOn(client, "info").mockResolvedValue({
		...info,
		machines: { ...info.machines!, platformFingerprint: "fixture" },
	});
	saveAuth("mock", auth);
	try {
		act(() =>
			root.render(createElement(AppProvider, { client, children: createElement(Machines, { adding: false }) })),
		);
		for (let i = 0; i < 50 && !host.querySelector(".machine-row-outdated"); i++)
			await act(async () => {
				await tick();
			});
		const row = host.querySelector(".machine-row-outdated");
		expect(row?.textContent).toContain("Needs an update");
		expect(row?.textContent).toContain("pair again to pin the platform key");
		expect(row?.querySelector('pre[aria-label="The update command"]')?.textContent).toContain(
			info.machines!.runnerImage,
		);
	} finally {
		act(() => root.unmount());
		host.remove();
		client.dispose();
		saveAuth("mock", null);
	}
});

it.each([true, false])(
	"offers OpenCode setup and import only for a runner image reporting support (%s)",
	async supported => {
		HTMLDialogElement.prototype.showModal ??= function () {
			this.open = true;
		};
		HTMLDialogElement.prototype.close ??= function () {
			this.open = false;
		};
		const { Machines } = await import("../screens/Machines");
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		const client = make();
		const info = await client.info();
		if (!supported)
			vi.spyOn(client, "info").mockResolvedValue({
				...info,
				machines: { ...info.machines!, runnerHarnesses: ["claude"] },
			});
		saveAuth("mock", auth);
		try {
			act(() =>
				root.render(createElement(AppProvider, { client, children: createElement(Machines, { adding: true }) })),
			);
			for (let i = 0; i < 30 && !host.querySelector(".machine-command"); i++)
				await act(async () => {
					await tick();
				});
			const command = () => host.querySelector('pre[aria-label="The setup command"]')?.textContent;
			expect(command()).toContain("docker run -it --rm");
			expect(command()).toContain(" setup --platform ");
			expect(command()).not.toContain("/import/opencode");
			const checkbox = (text: string) =>
				[...host.querySelectorAll("label")]
					.find(element => element.textContent?.includes(text))!
					.querySelector("input")!;
			act(() => checkbox("Enable Claude Code").click());
			if (!supported) {
				expect(host.textContent).not.toContain("Enable OpenCode");
				expect(host.textContent).not.toContain("Enable Codex");
				expect(host.textContent).not.toContain("Import existing OpenCode");
				expect(command()).not.toMatch(/--harness opencode|\/import\/opencode/);
				return;
			}
			act(() => checkbox("Enable OpenCode").click());
			expect(command()).toContain("--harness claude --harness opencode");
			act(() => checkbox("Enable Codex").click());
			expect(command()).toContain("docker run -it --rm --log-driver none");
			expect(command()).toContain("--harness codex");
			const background = () => host.querySelector('pre[aria-label="The background command"]')?.textContent;
			expect(background()).toContain("--harness claude --harness opencode");
			expect(command()).toContain("--harness opencode");
			expect(command()).not.toContain("/import/opencode");
			act(() => checkbox("Import existing OpenCode API keys").click());
			expect(command()).toContain('--mount "type=bind,src=$HOME/.local/share/opencode,dst=/import/opencode,readonly"');
			expect(background()).not.toContain("/import/opencode");
			// Windlass's command sandbox is allowed unless the person turns it off, in both commands.
			expect(command()).toMatch(/ --allow-profile docker-windlass-sandbox$/);
			expect(background()).toMatch(/ --allow-profile docker-windlass-sandbox$/);
			act(() => checkbox("Allow locked-down commands").click());
			// Turned off, both say so: the setup wizard then starts with the sandbox off as well.
			expect(command()).toMatch(/ --allow-profile docker-hardened$/);
			expect(background()).toMatch(/ --allow-profile docker-hardened$/);
		} finally {
			act(() => root.unmount());
			host.remove();
			client.dispose();
			saveAuth("mock", null);
		}
	},
);
