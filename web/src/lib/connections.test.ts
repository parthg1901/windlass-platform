/** The Connections grid's cells: what pays for each agent at each place, and the one action that connects it. */
import type { MachineSummary, ModelPlanStatus, ModelProviderStatus } from "@contract";
import { describe, expect, it } from "vitest";
import {
	anyAgentConnected,
	cellId,
	connectAction,
	type ConnectionInputs,
	HOSTED_NEEDS_WINDLASS,
	hostedCell,
	machineCell,
	planBadge,
	withMachineLoginNote,
} from "./connections";
import { clockTime } from "./format";

const key = (provider: ModelProviderStatus["provider"], ok = true): ModelProviderStatus => ({
	provider,
	last4: "4f2a",
	addedAt: 1,
	checkedAt: 1,
	ok,
	models: ["m"],
});
const plan = (provider: ModelPlanStatus["provider"], over: Partial<ModelPlanStatus> = {}): ModelPlanStatus => ({
	provider,
	account: "a@b.com · Max",
	addedAt: 1,
	checkedAt: 1,
	ok: true,
	health: "ok",
	limitedUntil: null,
	resetKnown: false,
	windows: [],
	healthAt: null,
	...over,
});
const inputs = (over: Partial<ConnectionInputs> = {}): ConnectionInputs => ({
	keys: [],
	plans: { allowed: true, plans: [] },
	chatgpt: false,
	canConnectChatgpt: true,
	...over,
});

describe("a hosted cell", () => {
	it("is not connected and leads to the agent's plan, or to its key where plans are off", () => {
		expect(hostedCell("claude", inputs())).toEqual({
			id: "claude-hosted",
			state: "none",
			label: "Not connected",
			detail: null,
			action: { kind: "plan", provider: "anthropic" },
		});
		const off = inputs({ plans: { allowed: false, plans: [] } });
		expect(hostedCell("claude", off).action).toEqual({ kind: "key", provider: "anthropic" });
		expect(hostedCell("codex", off).action).toEqual({ kind: "key", provider: "openai" });
		expect(hostedCell("opencode", inputs()).action?.kind).toBe("key");
	});

	it("names the plan first, with the key as its backup", () => {
		const both = inputs({ keys: [key("anthropic")], plans: { allowed: true, plans: [plan("anthropic")] } });
		expect(hostedCell("claude", both)).toMatchObject({
			state: "plan",
			label: "Claude plan",
			detail: "Key …4f2a as backup",
			action: null,
		});
		const planOnly = inputs({ plans: { allowed: true, plans: [plan("anthropic")] } });
		expect(hostedCell("claude", planOnly).detail).toBe("a@b.com · Max");
	});

	it("shows what the saved Pay with choice makes pay, not the default", () => {
		const both = { keys: [key("anthropic")], plans: { allowed: true, plans: [plan("anthropic")] } };
		const keyOnly = inputs({
			...both,
			payWith: [{ harness: "claude", payWith: "key", whenLimited: null, updatedAt: 1 }],
		});
		expect(hostedCell("claude", keyOnly)).toMatchObject({ state: "key", label: "Anthropic key" });
		const planOnly = inputs({
			...both,
			payWith: [{ harness: "claude", payWith: "plan", whenLimited: null, updatedAt: 1 }],
		});
		expect(hostedCell("claude", planOnly)).toMatchObject({ state: "plan", detail: "a@b.com · Max" });
		const planOnlyNoPlan = inputs({
			keys: [key("anthropic")],
			payWith: [{ harness: "claude", payWith: "plan", whenLimited: null, updatedAt: 1 }],
		});
		expect(hostedCell("claude", planOnlyNoPlan).state).not.toBe("key");
	});

	it("ignores a plan the account may not use, and says the key pays", () => {
		const off = inputs({ keys: [key("anthropic")], plans: { allowed: false, plans: [plan("anthropic")] } });
		expect(hostedCell("claude", off)).toMatchObject({ state: "key", label: "Anthropic key", detail: "…4f2a" });
	});

	it("says a key whose check failed, and offers to replace it", () => {
		expect(hostedCell("codex", inputs({ keys: [key("openai", false)] }))).toMatchObject({
			state: "bad",
			label: "Key check failed",
			action: { kind: "key", provider: "openai" },
		});
	});

	it("runs Windlass on the ChatGPT sign-in, or on any key", () => {
		expect(hostedCell("windlass", inputs({ chatgpt: true }))).toMatchObject({ state: "plan", label: "ChatGPT plan" });
		expect(hostedCell("windlass", inputs({ keys: [key("google")] }))).toMatchObject({
			state: "key",
			detail: "Gemini",
		});
		expect(hostedCell("windlass", inputs()).action).toEqual({ kind: "plan", provider: "openai" });
		expect(connectAction("windlass", inputs({ canConnectChatgpt: false }))).toEqual({
			kind: "key",
			provider: "openai",
		});
	});
});

const machine = (harnesses: NonNullable<MachineSummary["harnesses"]>): MachineSummary =>
	({ machineId: "m_mac", name: "mac", harnesses }) as MachineSummary;

describe("a machine's cell", () => {
	const hosted = hostedCell("windlass", inputs({ chatgpt: true }));

	it("follows Hosted for Windlass, and says when the agent is not there", () => {
		expect(machineCell("windlass", machine([]), hosted)).toMatchObject({
			id: "windlass-m_mac",
			state: "plan",
			detail: "Same as Hosted",
			action: null,
		});
		expect(machineCell("claude", machine([]), hosted)).toMatchObject({
			state: "absent",
			action: { kind: "machines" },
		});
	});

	it("tells its own sign-in, the owner's key, a sign-in to do and a check that failed apart", () => {
		const entry = { id: "claude" as const, adapter: "a", image: "i" };
		const opencode = { ...entry, id: "opencode" as const };
		expect(machineCell("opencode", machine([{ ...opencode, signIn: "token" }]), hosted)).toMatchObject({
			state: "machine",
			label: "Own sign-in",
		});
		expect(
			machineCell("opencode", machine([{ ...opencode, signIn: "token", platformKeys: ["anthropic"] }]), hosted),
		).toMatchObject({ state: "key", label: "Your key", detail: "Anthropic" });
		expect(machineCell("claude", machine([{ ...entry, signIn: "none" }]), hosted)).toMatchObject({
			state: "none",
			label: "Sign in needed",
		});
		expect(
			machineCell("claude", machine([{ ...entry, signIn: "unknown", signInReason: "timed out" }]), hosted),
		).toMatchObject({ state: "unknown", detail: "timed out" });
	});

	it("follows Pay with as Hosted for an agent with no login of its own on the machine; a login kept there wins", () => {
		const claudeHosted = hostedCell("claude", inputs({ plans: { allowed: true, plans: [plan("anthropic")] } }));
		const entry = { id: "claude" as const, adapter: "a", image: "i" };
		for (const signIn of ["token", "none"] as const)
			expect(machineCell("claude", machine([{ ...entry, signIn, paysWith: true }]), claudeHosted)).toMatchObject({
				id: "claude-m_mac",
				state: claudeHosted.state,
				label: claudeHosted.label,
				detail: "Same as Hosted",
				action: null,
				// The other way: a login kept on this machine only.
				ownLogin: { state: "offered", machineId: "m_mac" },
			});
		// A Claude login kept on the machine wins there, and the cell offers the way back.
		expect(machineCell("claude", machine([{ ...entry, signIn: "token" }]), claudeHosted)).toEqual({
			id: "claude-m_mac",
			state: "machine",
			label: "This machine's own login",
			detail: "Stays on this machine",
			action: null,
			ownLogin: { state: "kept", machineId: "m_mac" },
		});
		// Codex keeps no login on a machine: nothing to offer.
		const codexHosted = hostedCell("codex", inputs());
		expect(
			machineCell("codex", machine([{ ...entry, id: "codex", signIn: "none", paysWith: true }]), codexHosted).ownLogin,
		).toBeUndefined();
		// No plan pays for OpenCode: its machine logins, as before.
		expect(
			machineCell("opencode", machine([{ ...entry, id: "opencode", signIn: "none" }]), claudeHosted),
		).toMatchObject({ state: "none", label: "Sign in needed" });
	});
});

describe("the Hosted cell beside a machine's own login", () => {
	const entry = { id: "claude" as const, adapter: "a", image: "i" };
	const kept = machine([{ ...entry, signIn: "token" }]);
	const onPlan = machine([{ ...entry, signIn: "none", paysWith: true }]);

	it("says plainly that Hosted needs the plan or a key on Windlass when only a machine's login is there", () => {
		const nothing = hostedCell("claude", inputs());
		expect(withMachineLoginNote(nothing, "claude", [onPlan, kept])).toEqual({
			...nothing,
			detail: HOSTED_NEEDS_WINDLASS("claude"),
		});
		expect(HOSTED_NEEDS_WINDLASS("claude")).toBe("Hosted Claude Code needs your plan or a key on Windlass.");
	});

	it("says nothing more with a plan or a key on Windlass, or with no login kept on a machine", () => {
		const planned = hostedCell("claude", inputs({ plans: { allowed: true, plans: [plan("anthropic")] } }));
		expect(withMachineLoginNote(planned, "claude", [kept])).toBe(planned);
		const keyed = hostedCell("claude", inputs({ keys: [key("anthropic")] }));
		expect(withMachineLoginNote(keyed, "claude", [kept])).toBe(keyed);
		const nothing = hostedCell("claude", inputs());
		expect(withMachineLoginNote(nothing, "claude", [onPlan])).toBe(nothing);
		const codex = hostedCell("codex", inputs());
		expect(withMachineLoginNote(codex, "codex", [kept])).toBe(codex);
	});
});

it("counts any plan, key, ChatGPT sign-in or signed-in machine agent as an agent connected", () => {
	expect(anyAgentConnected(inputs(), [])).toBe(false);
	expect(anyAgentConnected(inputs({ chatgpt: true }), [])).toBe(true);
	expect(anyAgentConnected(inputs({ keys: [key("openrouter")] }), [])).toBe(true);
	expect(anyAgentConnected(inputs({ keys: [key("openrouter", false)] }), [])).toBe(false);
	expect(anyAgentConnected(inputs(), [machine([{ id: "codex", adapter: "a", image: "i", signIn: "token" }])])).toBe(
		true,
	);
	expect(cellId("codex", "hosted")).toBe("codex-hosted");
});

describe("a plan's health in its cell", () => {
	const now = new Date(2026, 10, 27, 13, 12).getTime();
	const at = new Date(2026, 10, 27, 14, 0).getTime();

	it("says until when a plan is limited, and whether that is the provider's reset or a try", () => {
		const limited = plan("anthropic", { health: "limited", limitedUntil: at, resetKnown: true });
		expect(planBadge(limited, now)).toEqual({ tone: "warn", text: `Limited until ${clockTime(at, now)}` });
		expect(clockTime(at, now)).toBe("14:00");
		const probe = { ...limited, resetKnown: false };
		expect(planBadge(probe, now)).toEqual({ tone: "warn", text: "Limited · trying again at 14:00" });
		// Past its time it is usable again as far as the page can tell.
		expect(planBadge(limited, at + 1)).toBeNull();
		expect(planBadge(plan("anthropic"), now)).toBeNull();
		const cell = hostedCell("claude", inputs({ plans: { allowed: true, plans: [limited] } }), now);
		expect(cell).toMatchObject({ state: "plan", badge: { tone: "warn", text: "Limited until 14:00" }, action: null });
	});

	it("asks to reconnect a plan its provider refused twice", () => {
		const invalid = plan("anthropic", { health: "invalid" });
		const cell = hostedCell("claude", inputs({ plans: { allowed: true, plans: [invalid] } }), now);
		expect(cell).toMatchObject({
			state: "plan",
			badge: { tone: "bad", text: "Stopped working" },
			action: { kind: "plan", provider: "anthropic", reconnect: true },
		});
		const chatgpt = hostedCell(
			"windlass",
			inputs({ chatgpt: true, plans: { allowed: true, plans: [plan("openai", { health: "invalid" })] } }),
			now,
		);
		expect(chatgpt.action).toEqual({ kind: "plan", provider: "openai", reconnect: true });
	});
});
