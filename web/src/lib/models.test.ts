/** The user's models as the screens read them, and the mock's list held against the server's own. */
import { describe, expect, it, vi } from "vitest";
import type { ModelList } from "@contract";
import { ModelProblem, checkEffort, chosenModel, standInModels } from "../../../server/src/account-models";
import { PlatformError } from "../api/client";
import { createMockClient, mockStandInModels } from "../api/mock";
import { cleanModelName, credentialWords, effortsOf, modelIds, modelWords, modelsNote, sourceOf } from "./models";
import { sessionModelWords } from "./acp";

const ada = {
	token: "mock:user:u_models:ada@example.com",
	profile: { uid: "u_models", email: "ada@example.com", demo: false },
};
const SOURCES = ["demo", "signed-out", "unavailable"] as const;

async function refusal(call: Promise<unknown>): Promise<PlatformError> {
	try {
		await call;
	} catch (error) {
		if (error instanceof PlatformError) return error;
		throw error;
	}
	throw new Error("the call was not refused");
}

function serverRefusal(step: () => unknown): { code: string; message: string } {
	try {
		step();
	} catch (error) {
		if (error instanceof ModelProblem) return { code: error.code, message: error.message };
		throw error;
	}
	throw new Error("the server's rule refused nothing");
}

describe("the user's models", () => {
	const plan: ModelList = {
		source: "account",
		models: [
			{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: ["low", "high"] },
			{ id: "gpt-6-brisk", name: null, efforts: [] },
		],
		defaultModel: "gpt-6.1-sol",
		fetchedAt: Date.UTC(2026, 10, 18, 9, 30),
	};

	it("offers each model with its own efforts, and none for a model the list does not have", () => {
		expect(modelIds(plan)).toEqual(["gpt-6.1-sol", "gpt-6-brisk"]);
		expect(effortsOf(plan, "gpt-6.1-sol")).toEqual(["low", "high"]);
		expect(effortsOf(plan, "gpt-6-brisk")).toEqual([]);
		expect(effortsOf(plan, "gpt-5-old")).toEqual([]);
		expect([modelIds(null), effortsOf(null, "gpt-6.1-sol")]).toEqual([[], []]);
	});

	it("says in one line whose list it is, and of a stand-in why it stands in", () => {
		expect(modelsNote(plan)).toMatch(/^The models of your ChatGPT plan, as read at \d\d:\d\d /);
		expect(modelsNote(mockStandInModels("demo"))).toBe("The demo uses a scripted model for every choice.");
		expect(modelsNote(mockStandInModels("unavailable"))).toContain("could not be loaded");
		expect(modelsNote(mockStandInModels("signed-out"))).toBe("Connect ChatGPT to see your plan’s models.");
		expect(modelsNote(mockStandInModels("demo"))).toContain("scripted model");
	});
});

async function connectPlan(mock: ReturnType<typeof createMockClient>) {
	// The mock connects the plan a few seconds after its code is approved, as the connect command would.
	vi.useFakeTimers();
	try {
		const approved = mock.user(ada).approvePlanConnect("KQ2M-8XF4", "openai");
		await vi.advanceTimersByTimeAsync(4000);
		await approved;
	} finally {
		vi.useRealTimers();
	}
}

describe("the mock's models", () => {
	it("has the server's stand-in, word for word", () => {
		for (const source of SOURCES) expect(mockStandInModels(source)).toEqual(standInModels(source));
	});

	it("gives a signed-in user their plan's list, the demo the stand-in, and says which", async () => {
		const mock = createMockClient({ pace: 0 });
		await connectPlan(mock);
		const list = await mock.user(ada).models();
		expect(list.source).toBe("account");
		expect(typeof list.fetchedAt).toBe("number");
		expect(list.models.map(model => model.id)).toContain(list.defaultModel);
		expect(new Set(list.models.map(model => model.efforts.join(" "))).size).toBeGreaterThan(1);
		const demo = await mock.login.demo();
		expect(await mock.user(demo).models()).toEqual(mockStandInModels("demo"));
		mock.dispose();
		const failing = createMockClient({ pace: 0, models: "unavailable" });
		await connectPlan(failing);
		expect(await failing.user(ada).models()).toEqual(mockStandInModels("unavailable"));
		failing.dispose();
	});

	it("refuses a model that is not the user's and an effort the model does not take, in the server's words", async () => {
		const mock = createMockClient({ pace: 0 });
		const user = mock.user(ada);
		await connectPlan(mock);
		const list = await user.models();
		const none = list.models.find(model => model.efforts.length === 0)!;
		const some = list.models.find(model => model.efforts.length > 0 && !model.efforts.includes("max"))!;
		const unknown = await refusal(user.createSession({ profile: "docker-windlass-sandbox", model: "gpt-nope" }));
		expect({ code: unknown.reason, message: unknown.message }).toEqual(
			serverRefusal(() => chosenModel(list, "gpt-nope")),
		);
		const session = await user.createSession({ profile: "docker-windlass-sandbox", model: some.id });
		expect(session.model).toBe(some.id);
		expect((await user.createSession({ profile: "docker-windlass-sandbox" })).model).toBe(list.defaultModel);
		const api = mock.session(ada, session.id);
		const tooMuch = await refusal(api.prompt({ text: "hello", effort: "max" }));
		expect({ code: tooMuch.reason, message: tooMuch.message }).toEqual(
			serverRefusal(() => checkEffort(list, some.id, "max")),
		);
		const noEffort = await refusal(api.prompt({ text: "hello", model: none.id, effort: "low" }));
		expect({ code: noEffort.reason, message: noEffort.message }).toEqual(
			serverRefusal(() => checkEffort(list, none.id, "low")),
		);
		const other = await refusal(api.prompt({ text: "hello", model: "gpt-nope" }));
		expect(other.reason).toBe("bad_model");
		mock.dispose();
	});
});

describe("sessionModelWords", () => {
	const claudeModels: ModelList = {
		source: "harness",
		defaultModel: "default",
		models: [
			{ id: "default", name: "Default (recommended)", efforts: [] },
			{ id: "fable", name: "Fable 5.2", efforts: [] },
		],
		fetchedAt: null,
	};

	it("names a Claude Code session's model as Claude Code does, not by its id", () => {
		expect(sessionModelWords({ harness: "claude", harnessModels: claudeModels, model: "fable" })).toBe("Fable 5.2");
		expect(sessionModelWords({ harness: "claude", harnessModels: claudeModels, model: "default" })).toBe(
			"Default (recommended)",
		);
		// A model the list does not know, or no list yet: format the id.
		expect(sessionModelWords({ harness: "claude", harnessModels: claudeModels, model: "opus" })).toBe("Opus");
		expect(sessionModelWords({ harness: "claude", harnessModels: null, model: "fable" })).toBe("Fable");
	});

	it("formats a Windlass session’s model name", () => {
		expect(sessionModelWords({ harness: "windlass", harnessModels: null, model: "gpt-6.1-sol" })).toBe("GPT-6.1 Sol");
	});
});

describe("the picker's model names and credentials", () => {
	it("names a model in words, not by its id", () => {
		expect(modelWords("anthropic/claude-haiku-5-5")).toBe("Claude Haiku 5.5");
		expect(modelWords("gpt-6.1-sol")).toBe("GPT-6.1 Sol");
		expect(modelWords("google/gemini-3-pro")).toBe("Gemini 3 Pro");
		expect(modelWords("o3-mini-2025-01-31")).toBe("o3 Mini");
		expect(cleanModelName("openai/gpt-5.4", "OpenAI/GPT-5.4")).toBe("GPT-5.4");
		expect(cleanModelName("opus", "Opus")).toBe("Opus");
	});

	it("distinguishes a paid OpenCode Zen login from its free models", () => {
		const entry = { id: "opencode" as const, adapter: "", image: "", signIn: "token" as const };
		expect(credentialWords("opencode", "opencode", { ...entry, machineProviders: ["opencode"] }, "nas")).toBe(
			"OpenCode Zen login · nas",
		);
		expect(credentialWords("opencode", "opencode", { ...entry, machineProviders: ["free"] }, "nas")).toBe("free");
	});

	it("puts each model under its provider", () => {
		expect(sourceOf("windlass", "gpt-6.1-sol")).toBe("chatgpt");
		expect(sourceOf("windlass", "anthropic/claude-opus-5-5")).toBe("anthropic");
		expect(sourceOf("claude", "opus")).toBe("anthropic");
		expect(sourceOf("opencode", "default")).toBeNull();
		expect(sourceOf("opencode", "opencode/grok-code")).toBe("opencode");
		expect(sourceOf("opencode", "xai/grok-4")).toBe("other");
	});

	it("says whose credential serves a provider: the machine's sign-in first, the key where it pays, keys when hosted", () => {
		const claude = {
			id: "claude" as const,
			adapter: "",
			image: "",
			signIn: "token" as const,
			machineSignIns: ["anthropic" as const],
		};
		expect(credentialWords("claude", "anthropic", claude, "mac-mini")).toBe("Claude subscription · mac-mini");
		expect(credentialWords("claude", "anthropic", { ...claude, platformKeys: ["anthropic"] }, "mac-mini")).toBe(
			"Anthropic key",
		);
		expect(
			credentialWords("claude", "anthropic", { ...claude, machineSignIns: undefined, paysWith: true }, "mac-mini"),
		).toBe("Claude plan");
		expect(credentialWords("claude", "anthropic", null, null)).toBe("Anthropic key");
		const opencode = {
			id: "opencode" as const,
			adapter: "",
			image: "",
			signIn: "token" as const,
			machineProviders: ["chatgpt"],
			machineSignIns: ["openai" as const],
			platformKeys: ["google" as const],
		};
		const legacy = { id: "opencode" as const, adapter: "", image: "", signIn: "token" as const };
		expect(credentialWords("opencode", "openai", legacy, "nas")).toBe("login on nas");
		expect(credentialWords("opencode", "openai", opencode, "nas")).toBe("ChatGPT plan · nas");
		expect(credentialWords("opencode", "google", opencode, "nas")).toBe("Gemini key");
		expect(credentialWords("windlass", "chatgpt", null, null)).toBe("ChatGPT plan");
	});
});
