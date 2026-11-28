// @vitest-environment jsdom
import { CLAUDE_LAUNCH_MODES, type AuthResult, type PromptInput } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformError } from "../api/client";
import { createMockClient } from "../api/mock";
import { handOver, takeHandover } from "../state/handover";
import { Composer, type ComposerProps } from "./Composer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
/** What the composer sent, in order, and what each send is answered with: a failure, or nothing. */
let sent: PromptInput[];
let answers: Array<Error | null>;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	sent = [];
	answers = [];
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
});

const onSend = async (input: PromptInput) => {
	sent.push(input);
	const answer = answers.shift() ?? null;
	if (answer) throw answer;
};

const show = (props: Partial<ComposerProps> = {}) =>
	act(() =>
		root.render(
			createElement(Composer, {
				status: "idle",
				online: true,
				models: null,
				model: "gpt-6.1-sol",
				onSend,
				onStop: async () => undefined,
				...props,
			}),
		),
	);

const field = () => host.querySelector("textarea") as HTMLTextAreaElement;

/** Types into the field as a browser does, so that React sees the change. */
const write = (text: string) =>
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field(), text);
		field().dispatchEvent(new Event("input", { bubbles: true }));
	});

const send = () => act(async () => (host.querySelector('button[type="submit"]') as HTMLButtonElement).click());

const noAnswer = () => new PlatformError("network", "The server at http://localhost:6420 did not answer.");

describe("the composer's submissions", () => {
	it("keeps a hosted draft and disables Send while its selected provider key is missing", async () => {
		const reason = "Add an Anthropic key on the Connections page to run Claude Code here.";
		show({ modelProblem: () => reason });
		write("Review the parser");
		await send();
		expect(sent).toHaveLength(0);
		expect(field().value).toBe("Review the parser");
		expect(host.querySelector('[role="status"]')?.textContent).toContain(reason);
		show({ modelProblem: () => null });
		await send();
		expect(sent[0]?.text).toBe("Review the parser");
	});

	it("keeps a message that was not taken, and sends it again with the key it had", async () => {
		show();
		write("Fix the flaky test");
		answers.push(noAnswer());
		await send();
		expect(field().value).toBe("Fix the flaky test");
		expect(host.querySelector('[role="alert"]')?.textContent).toContain("did not answer");
		await send();
		expect(sent.map(input => input.text)).toEqual(["Fix the flaky test", "Fix the flaky test"]);
		expect(sent[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
		expect(sent[1]?.idempotencyKey).toBe(sent[0]?.idempotencyKey);
		// Taken: the field is empty, and nothing shows a control for any of this: Send, and the model's pill.
		expect(field().value).toBe("");
		expect(host.querySelectorAll("button:not(.ui-pill)")).toHaveLength(1);
	});

	it("gives a message whose text changed a key of its own", async () => {
		show();
		write("Fix the flaky test");
		answers.push(noAnswer(), noAnswer());
		await send();
		write("Fix the flaky test in ci.yml");
		await send();
		// Spaces around it are not part of what is sent, so they change nothing.
		write("  Fix the flaky test in ci.yml  ");
		await send();
		expect(sent.map(input => input.text)).toEqual([
			"Fix the flaky test",
			"Fix the flaky test in ci.yml",
			"Fix the flaky test in ci.yml",
		]);
		expect(sent[1]?.idempotencyKey).not.toBe(sent[0]?.idempotencyKey);
		expect(sent[2]?.idempotencyKey).toBe(sent[1]?.idempotencyKey);
	});

	it("gives the same words a new key once they were taken: sent again on purpose, they are a new message", async () => {
		show();
		write("Run the tests");
		await send();
		write("Run the tests");
		await send();
		expect(sent).toHaveLength(2);
		expect(sent[1]?.idempotencyKey).not.toBe(sent[0]?.idempotencyKey);
	});

	it("keeps the key through a refusal that clears itself, and when the message then steers the turn", async () => {
		show({ status: "running" });
		write("Also update the changelog");
		answers.push(
			new PlatformError(
				"user",
				"The turn is still starting and cannot take a message right now. Try again in a moment.",
				{ reason: "turn_running" },
			),
		);
		await send();
		expect(host.querySelector('[role="status"]')?.textContent).toContain("Your message is still here.");
		await send();
		expect(sent[1]).toEqual({ text: "Also update the changelog", idempotencyKey: sent[0]?.idempotencyKey });
	});

	it("sends a handed-over prompt with the key it was first sent with, until its text changes", async () => {
		handOver("s_1", {
			text: "Add a health check",
			error: "The server did not answer.",
			idempotencyKey: "key-of-the-launch-form",
		});
		const handover = takeHandover("s_1");
		show({ initial: handover });
		expect(field().value).toBe("Add a health check");
		answers.push(noAnswer());
		await send();
		expect(sent[0]?.idempotencyKey).toBe("key-of-the-launch-form");
		write("Add a health check at /healthz");
		await send();
		expect(sent[1]?.idempotencyKey).not.toBe("key-of-the-launch-form");
	});

	it("leaves one message when the first attempt arrived and only its answer was lost", async () => {
		vi.useFakeTimers();
		const client = createMockClient({ origin: "http://localhost:5173" });
		const login = client.login.demo();
		await vi.advanceTimersByTimeAsync(1000);
		const auth: AuthResult = await login;
		const created = client.user(auth).createSession({ profile: "docker-windlass-sandbox" });
		await vi.advanceTimersByTimeAsync(500);
		const api = client.session(auth, (await created).id);
		const messages: string[] = [];
		const close = api.open({
			onSnapshot: () => undefined,
			onItem: item => void (item.kind === "user" && messages.push(item.text)),
			onDelta: () => undefined,
			onSummary: () => undefined,
			onQuestion: () => undefined,
			onConnection: () => undefined,
		});
		// The server takes the prompt; the first answer never reaches the composer.
		let lost = true;
		show({
			onSend: async input => {
				sent.push(input);
				await api.prompt(input);
				if (lost) {
					lost = false;
					throw noAnswer();
				}
			},
		});
		const passes = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
		write("Fix the flaky test");
		await send();
		await passes(500);
		expect(field().value).toBe("Fix the flaky test");
		expect(host.querySelector('[role="alert"]')?.textContent).toContain("did not answer");
		await send();
		await passes(500);
		expect(field().value).toBe("");
		expect(sent).toHaveLength(2);
		expect(messages).toEqual(["Fix the flaky test"]);
		close();
		client.dispose();
	});
});

describe("a limited plan's question", () => {
	const limited = (reason: string) =>
		new PlatformError(
			"user",
			"Your Claude plan is limited until 14:00 UTC. Wait for it, or pay for this turn with your Anthropic key.",
			{
				reason,
			},
		);
	const button = (name: string) => [...host.querySelectorAll("button")].find(b => b.textContent === name);

	it("asks whether to wait or pay with the key, and sends the same message on the key this time", async () => {
		show();
		write("Fix the flaky test");
		answers.push(limited("plan_ask"));
		await send();
		expect(host.querySelector(".composer-plan-ask")?.textContent).toContain("limited until 14:00 UTC");
		expect(field().value).toBe("Fix the flaky test");
		await act(async () => button("Use my key this time")!.click());
		expect(sent).toHaveLength(2);
		expect(sent[1]).toMatchObject({
			text: "Fix the flaky test",
			payWith: "key",
			idempotencyKey: sent[0]?.idempotencyKey,
		});
		expect(sent[0]?.payWith).toBeUndefined();
		expect(field().value).toBe("");
		expect(host.querySelector(".composer-plan-ask")).toBeNull();
	});

	it("keeps the draft and says until when, when the person waits", async () => {
		show();
		write("Fix the flaky test");
		answers.push(limited("plan_ask"));
		await send();
		await act(async () => button("Wait")!.click());
		expect(sent).toHaveLength(1);
		expect(field().value).toBe("Fix the flaky test");
		expect(host.querySelector(".composer-plan-ask")).toBeNull();
		expect(host.querySelector('[role="status"]')?.textContent).toContain("limited until 14:00 UTC");
		// Sent again later, it is the same message under the same key, on the rule as it stands.
		await send();
		expect(sent[1]).toMatchObject({ text: "Fix the flaky test", idempotencyKey: sent[0]?.idempotencyKey });
		expect(sent[1]?.payWith).toBeUndefined();
	});

	it("shows a plan that only waits as the refusal it is, with the draft kept", async () => {
		show();
		write("Fix the flaky test");
		answers.push(limited("plan_limited"));
		await send();
		expect(host.querySelector(".composer-plan-ask")).toBeNull();
		expect(host.querySelector('[role="alert"]')?.textContent).toContain("limited until 14:00 UTC");
		expect(field().value).toBe("Fix the flaky test");
	});
});

describe("another harness's model picker", () => {
	it("names its models as the harness does, and tags its default as the start composer does, under their provider", () => {
		const models = {
			source: "harness" as const,
			fetchedAt: null,
			defaultModel: "opus",
			models: [
				{ id: "haiku", name: "Haiku", efforts: [] },
				{ id: "opus", name: "Opus", efforts: [] },
				{ id: "sonnet", name: null, efforts: [] },
			],
		};
		show({ harness: "Claude Code", model: "opus", models });
		const pill = host.querySelector('[data-picker="model"]') as HTMLButtonElement;
		act(() => pill.click());
		const rows = [...document.querySelectorAll('.ui-pop [role="menuitemradio"]')] as HTMLElement[];
		expect(rows.map(row => [row.dataset.value, row.querySelector(".ui-item-label")?.textContent])).toEqual([
			["haiku", "Haiku"],
			["opus", "Opus"],
			["sonnet", "Sonnet"],
		]);
		expect(rows.find(row => row.dataset.value === "opus")?.textContent).toContain("default");
		expect(document.querySelector(".ui-pop")?.textContent).toContain("Anthropic");
		expect(rows.find(row => row.getAttribute("aria-checked") === "true")?.dataset.value).toBe("opus");
		expect(pill.dataset.value).toBe("opus");
	});
});

describe("the composer's effort", () => {
	const models = {
		source: "account" as const,
		fetchedAt: 1,
		defaultModel: "gpt-6.1-sol",
		models: [
			{ id: "gpt-6.1-sol", name: null, efforts: ["low", "medium", "high"] },
			{ id: "gpt-7-nova", name: null, efforts: [] },
		],
	};
	const pill = () => host.querySelector('[data-picker="effort"]') as HTMLButtonElement;
	const choose = (level: string) => {
		act(() => pill().click());
		act(() => document.querySelector<HTMLElement>(`.ui-pop [role="menuitemradio"][data-value="${level}"]`)!.click());
	};

	it("starts at the session's effort, sends none while it is unchanged, and null for the default chosen", async () => {
		show({ models, effort: "high" });
		expect(pill().dataset.value).toBe("high");
		expect(pill().textContent).toBe("effort high");
		write("First");
		await send();
		expect(sent[0]).not.toHaveProperty("effort", expect.anything());
		choose("default");
		expect(pill().textContent).toBe("default effort");
		write("Second");
		await send();
		expect(sent[1]?.effort).toBeNull();
		// The session now runs at the default, and the choice stays.
		show({ models, effort: null });
		choose("low");
		write("Third");
		await send();
		expect(sent[2]?.effort).toBe("low");
	});

	it("shows the default for a session effort the model does not take", () => {
		show({ models, effort: "xhigh" });
		expect(pill().dataset.value).toBe("");
		expect(pill().textContent).toBe("default effort");
	});
});

describe("a message to a running turn whose harness takes none then", () => {
	// The server's refusal of a steer (server/src/actors/agent-session.ts, `steerTurn`): known by its code, whatever its words.
	const notNow = () =>
		new PlatformError("user", "The running turn could not take the message. Try again in a moment.", {
			reason: "steer_unavailable",
		});

	it("is held with “Sent when this turn ends.”, and sent once the turn ends, with the key it had", async () => {
		show({ status: "running", harness: "Claude Code", model: "default" });
		write("Also update the changelog");
		answers.push(notNow());
		await send();
		expect(field().value).toBe("");
		expect(host.querySelector(".composer-held")?.textContent).toContain("Also update the changelog");
		expect(host.querySelector(".composer-held")?.textContent).toContain("Sent when this turn ends.");
		expect(sent).toHaveLength(1);
		await act(async () =>
			root.render(
				createElement(Composer, {
					status: "idle",
					online: true,
					models: null,
					model: "default",
					harness: "Claude Code",
					onSend,
					onStop: async () => undefined,
				}),
			),
		);
		expect(sent).toHaveLength(2);
		expect(sent[1]).toEqual({ text: "Also update the changelog", idempotencyKey: sent[0]?.idempotencyKey });
		expect(host.querySelector(".composer-held")).toBeNull();
	});

	it("can be taken back into the field before the turn ends", async () => {
		show({ status: "running", harness: "Claude Code", model: "default" });
		write("Also update the changelog");
		answers.push(notNow());
		await send();
		await act(async () => (host.querySelector(".composer-held button") as HTMLButtonElement).click());
		expect(field().value).toBe("Also update the changelog");
		expect(host.querySelector(".composer-held")).toBeNull();
	});

	it("is not held for Windlass: the refusal is shown briefly and the message stays in the field", async () => {
		show({ status: "running" });
		write("Also update the changelog");
		answers.push(notNow());
		await send();
		expect(host.querySelector(".composer-held")).toBeNull();
		expect(host.querySelector(".composer-notice")?.textContent).toContain("could not take the message");
		expect(host.querySelector('[role="alert"]')).toBeNull();
		expect(field().value).toBe("Also update the changelog");
	});
});

describe("the composer's mode", () => {
	const WINDLASS = [
		{ id: "ask", name: "Ask", description: "Ask before writes, commands, network access and MCP calls." },
		{ id: "auto", name: "Auto", description: "Use Windlass’s command sandbox and ask when needed." },
	];
	let chosen: string[];
	let refuse: Error | null;
	const onMode = async (mode: string) => {
		chosen.push(mode);
		if (refuse) throw refuse;
	};
	beforeEach(() => {
		chosen = [];
		refuse = null;
	});
	const picker = () => host.querySelector('[data-picker="mode"]') as HTMLButtonElement;
	const options = () => [...document.querySelectorAll('.ui-pop [role="menuitemradio"]')] as HTMLElement[];
	const pick = async (name: string) => {
		await act(async () => picker().click());
		await act(async () =>
			options()
				.find(option => option.querySelector(".ui-item-label")?.textContent === name)
				?.click(),
		);
	};

	it("sits before the model, and opens to each mode with what it does", async () => {
		show({ modes: WINDLASS, mode: "auto", onMode });
		expect(
			[...host.querySelectorAll(".composer-selects [data-picker]")].map(pill => (pill as HTMLElement).dataset.picker),
		).toEqual(["mode", "model"]);
		expect(picker().textContent).toBe("Auto");
		await act(async () => picker().click());
		expect(picker().getAttribute("aria-expanded")).toBe("true");
		expect(options().map(option => option.textContent)).toEqual([
			"AskAsk before writes, commands, network access and MCP calls.",
			"AutoUse Windlass’s command sandbox and ask when needed.",
		]);
		expect(options().map(option => option.getAttribute("aria-checked"))).toEqual(["false", "true"]);
	});

	it("calls setMode with the chosen mode and shows it, then follows the summary", async () => {
		show({ modes: [...CLAUDE_LAUNCH_MODES], mode: "auto", onMode, harness: "Claude Code", model: "default" });
		await pick("Plan");
		expect(chosen).toEqual(["plan"]);
		expect(picker().textContent).toBe("Plan");
		expect(document.querySelector(".ui-pop")).toBeNull();
		// The summary says so, and later says the agent left Plan by itself.
		show({ modes: [...CLAUDE_LAUNCH_MODES], mode: "plan", onMode, harness: "Claude Code", model: "default" });
		expect(picker().textContent).toBe("Plan");
		show({ modes: [...CLAUDE_LAUNCH_MODES], mode: "acceptEdits", onMode, harness: "Claude Code", model: "default" });
		expect(picker().textContent).toBe("Accept edits");
		// Choosing the mode it is in asks nothing.
		await pick("Accept edits");
		expect(chosen).toEqual(["plan"]);
	});

	it("says a mode chosen while a turn runs applies from the next prompt, until the turn ends", async () => {
		show({ status: "running", modes: WINDLASS, mode: "auto", onMode });
		expect(picker().disabled).toBe(false);
		await pick("Ask");
		expect(chosen).toEqual(["ask"]);
		expect(host.querySelector(".composer-selects")?.textContent).toContain("applies from the next prompt");
		show({ status: "idle", modes: WINDLASS, mode: "ask", onMode });
		expect(host.querySelector(".composer-selects")?.textContent).not.toContain("applies from the next prompt");
		// Chosen while idle, it is for the next prompt anyway: nothing to say.
		await pick("Auto");
		expect(host.querySelector(".composer-selects")?.textContent).not.toContain("applies from the next prompt");
	});

	it("goes back to the summary's mode and says why when the choice is refused", async () => {
		refuse = new PlatformError("user", "Choose a mode offered by this agent.", { reason: "bad_input" });
		show({ modes: WINDLASS, mode: "auto", onMode });
		await pick("Ask");
		expect(picker().textContent).toBe("Auto");
		expect(host.querySelector('[role="alert"]')?.textContent).toContain("Choose a mode offered by this agent.");
	});
});
