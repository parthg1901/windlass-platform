// @vitest-environment jsdom
/**
 * The form that files a work item: "Where it runs" is offered where the deployment has work items and
 * machines and the user has one, and the place chosen is what the request carries (`CreateItemInput.place`).
 */
import type { AuthResult, CreateItemInput } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserApi } from "../api/client";
import { createMockClient, type MockClient, type MockMachineState } from "../api/mock";
import { saveAuth } from "../lib/authStore";
import { AppProvider } from "../state/app";
import { NewItemDialog } from "./Items";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let client: MockClient;
/** What the form asked the server to file, in order. */
let sent: CreateItemInput[];

/** Lets the mock answer: in steps, so that what one answer renders can ask the next. */
async function wait(steps = 6): Promise<void> {
	for (let step = 0; step < steps; step++) await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
}

/** Signs in with a connected ChatGPT plan and records the requests to file an item. */
async function start(machine: MockMachineState, failDefaults = false): Promise<void> {
	client = createMockClient({ origin: "http://localhost:5173", machine });
	const begun = client.login.start();
	await vi.advanceTimersByTimeAsync(1000);
	const { redirectPrefix, url } = await begun;
	const finished = client.login.finish(`${redirectPrefix}?code=abc&state=${new URL(url).searchParams.get("state")}`);
	await vi.advanceTimersByTimeAsync(1000);
	const auth: AuthResult = await finished;
	const account = client.user(auth);
	// The mock connects the plan a few seconds after its code is approved, as the connect command would.
	const approved = account.approvePlanConnect("KQ2M-8XF4", "openai");
	await vi.advanceTimersByTimeAsync(4000);
	await approved;
	saveAuth("mock", auth);
	const user = client.user.bind(client);
	(client as { user: (auth: AuthResult) => UserApi }).user = who => {
		const api = user(who);
		return {
			...api,
			repository: async id => {
				if (failDefaults) {
					failDefaults = false;
					throw new Error("offline");
				}
				return api.repository(id);
			},
			createItem: (input: CreateItemInput) => (sent.push(input), api.createItem(input)),
		};
	};
	act(() =>
		root.render(
			createElement(AppProvider, {
				client,
				children: createElement(NewItemDialog, {
					repositoryId: 7101,
					name: "acme/harbor",
					base: "main",
					onClose: () => undefined,
				}),
			}),
		),
	);
	await wait();
}

const text = () => host.textContent ?? "";
const runLine = () => host.querySelector(".run-line")?.textContent ?? "";
/** The form says what will run; its choices for this item open from "Change for this item". */
const change = () =>
	act(() => [...host.querySelectorAll("button")].find(one => one.textContent === "Change for this item")!.click());
const legend = () => [...host.querySelectorAll("legend")].find(one => one.textContent === "Where it runs") ?? null;
const radio = (value: string) => host.querySelector(`input[type="radio"][value="${value}"]`) as HTMLInputElement | null;

function typeTitle(value: string): void {
	const input = host.querySelector("input.input") as HTMLInputElement;
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function file(): Promise<void> {
	await act(async () => (document.querySelector('button[type="submit"]') as HTMLButtonElement).click());
	await wait();
}

beforeEach(() => {
	vi.useFakeTimers();
	// jsdom has no <dialog> of its own that opens.
	HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
		this.setAttribute("open", "");
	};
	HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
		this.removeAttribute("open");
	};
	sent = [];
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

describe("filing a work item", () => {
	it("requires the repository preview after a failed read and retries it before filing", async () => {
		await start("full", true);
		typeTitle("Build the report");
		await file();
		expect(sent).toHaveLength(0);
		expect(text()).toContain("Repository defaults could not be read");
		act(() => [...host.querySelectorAll("button")].find(b => b.textContent === "Retry")!.click());
		await wait();
		expect(runLine()).toContain("GPT-6 Luna");
		await file();
		expect(sent).toHaveLength(1);
	});
	it("runs on this platform unless a machine is chosen, and then says what that means and sends the machine", async () => {
		await start("full");
		expect(runLine()).toContain("Hosted · Windlass");
		// The repository saves a model; nothing else is chosen, so the rest is the deployment's.
		expect(runLine()).toContain("GPT-6 Luna— set for this repository");
		expect(legend()).toBeNull();
		change();
		expect(host.querySelector(".sandbox-chosen-name")?.textContent).toBe("Hosted");
		// The usable machines can be chosen, an offline one too.
		expect(radio("m_nas")?.disabled).toBe(false);
		expect(radio("m_workshop")?.disabled).toBe(false);
		typeTitle("Cache the station list");
		await file();
		expect(sent).toHaveLength(1);
		expect(sent[0]).not.toHaveProperty("place");

		act(() => root.unmount());
		host.replaceChildren();
		root = createRoot(host);
		client.dispose();
		sent = [];
		await start("full");
		change();
		act(() => radio("m_nas")?.click());
		expect(host.querySelector(".sandbox-chosen-name")?.textContent).toBe("nas");
		expect(runLine()).toContain("nas · Windlass");
		expect(runLine()).toContain("— chosen for this item");
		expect(text()).toContain(
			"It starts as soon as “nas” is online and has a free slot; until then it waits, and says for what.",
		);
		typeTitle("Cache the station list");
		await file();
		expect(sent[0]?.place).toEqual({ kind: "machine", machineId: "m_nas" });
		// The server picks the machine's sandbox: the form names none.
		expect(sent[0]?.profile).toBeUndefined();
	});

	it.each([
		["orchestrate", "Plan first"],
		["single", "Quick"],
	])("files the chosen %s mode", async (mode, label) => {
		await start("none");
		expect(radio("orchestrate")?.checked).toBe(true);
		expect(radio(mode)?.parentElement?.textContent).toBe(label);
		act(() => radio(mode)!.click());
		typeTitle("Make the export available");
		await file();
		expect(sent[0]?.mode).toBe(mode);
	});

	it("files the model and effort chosen for the item's agent, offering only the efforts its model takes", async () => {
		// The model and the effort are the composer's pickers: a button that opens a menu of rows.
		const control = (label: string) =>
			[...host.querySelectorAll("label")].find(one => one.textContent === label)?.control as HTMLButtonElement | null;
		const rows = () => [...document.querySelectorAll<HTMLElement>('.ui-pop [role="menuitemradio"]')];
		const choose = (label: string, value: string) => {
			act(() => control(label)!.click());
			const row = rows().find(one => one.dataset.value === value)!;
			act(() => row.click());
		};
		const efforts = () => {
			const button = control("Effort");
			if (!button) return [];
			act(() => button.click());
			const values = rows().map(one => one.dataset.value);
			act(() => button.click());
			return values;
		};
		await start("online");
		change();
		// Windlass on this platform, on the repository's model: the efforts that model takes.
		expect(efforts()).toEqual(["default", "low", "medium"]);
		choose("Model", "gpt-6.1-sol");
		expect(text()).toContain("Planning and review run on Windlass with GPT-6.1 Sol.");
		choose("Model", "gpt-6-luna");
		expect(efforts()).toEqual(["default", "low", "medium"]);
		choose("Effort", "medium");
		typeTitle("Cache the station list");
		await file();
		expect(sent[0]).toMatchObject({ model: "gpt-6-luna", effort: "medium" });
		// Claude Code on the machine: the models its runner reported, where only some take an effort.
		act(() => root.unmount());
		host.replaceChildren();
		root = createRoot(host);
		client.dispose();
		sent = [];
		await start("online");
		change();
		act(() => radio("m_nas")?.click());
		act(() => radio("claude")?.click());
		await wait();
		expect(efforts()).toEqual([]);
		choose("Model", "opus");
		expect(efforts()).toEqual(["default", "low", "high", "max"]);
		choose("Effort", "high");
		typeTitle("Cache the station list");
		await file();
		expect(sent[0]).toMatchObject({ harness: "claude", model: "opus", effort: "high", mode: "orchestrate" });
	});

	it("says an offline machine makes the item wait", async () => {
		await start("full");
		change();
		act(() => radio("m_workshop")?.click());
		expect(text()).toContain("“workshop” is offline. The item waits and asks before it runs anywhere else.");
		expect(text()).toContain("through the web proxy");
		expect(text()).not.toContain("can reach the machine's network");
	});

	it("lists a machine with an old runner, or no usable sandbox, without letting it be chosen", async () => {
		await start("outdated");
		change();
		expect(radio("m_nas")?.disabled).toBe(true);
		expect(text()).toContain("Its runner needs an update.");
		act(() => root.unmount());
		host.replaceChildren();
		root = createRoot(host);
		client.dispose();
		await start("docker");
		change();
		expect(radio("m_nas")?.disabled).toBe(true);
		expect(text()).toContain("Can't run sandboxes right now.");
	});

	it("offers only the hosted place and shows which agents need a Settings key", async () => {
		await start("off");
		expect(runLine()).toContain("Hosted · Windlass");
		change();
		expect(radio("m_nas")).toBeNull();
		expect(radio("claude")?.disabled).toBe(true);
		act(() => root.unmount());
		host.replaceChildren();
		root = createRoot(host);
		client.dispose();
		await start("none");
		change();
		expect(radio("m_nas")).toBeNull();
		expect(radio("claude")?.disabled).toBe(true);
	});
});
