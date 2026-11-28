import type { ItemAgent } from "@contract";
import { describe, expect, it } from "vitest";
import { agentFacts, agentLine, agentTokens } from "./item-agent";

const agent = (patch: Partial<ItemAgent>): ItemAgent => ({
	harness: "claude",
	model: "sonnet",
	tokens: "not_reported",
	reportedTokens: 0,
	cost: null,
	fiveHour: null,
	...patch,
});

describe("an item's agent on its page", () => {
	it("names the agent and its model", () => {
		expect(agentLine(undefined)).toBe("Windlass");
		expect(agentLine(agent({}))).toBe("Claude Code · Sonnet");
		expect(agentLine(agent({ harness: "opencode", model: "default" }))).toBe("OpenCode · its default model");
		expect(agentLine(agent({ effort: "high" }))).toBe("Claude Code · Sonnet · effort high");
	});
	it("never shows tokens that were not measured as 0, and draws a meter only for counted ones", () => {
		expect(agentTokens(undefined)).toBeNull();
		expect(agentTokens(agent({ harness: "windlass", tokens: "counted" }))).toBeNull();
		expect(agentTokens(agent({}))).toBe("Not reported by Claude Code");
		expect(agentTokens(agent({ tokens: "subscription", reportedTokens: 33_500 }))).toBe(
			"33,500 reported by Claude Code, not counted: a subscription is not billed by token",
		);
	});
	it("says the 5-hour window where there is one, never a reported dollar cost", () => {
		expect(agentFacts(agent({ harness: "opencode" }))).toEqual([]);
		expect(agentFacts(agent({ harness: "codex", tokens: "counted", subscriptionTokens: 12 }))).toContainEqual({
			label: "Subscription tokens",
			value: "12",
		});
		expect(agentFacts(agent({ tokens: "subscription", reportedTokens: 33_500 }))).toEqual([
			{ label: "5-hour window", value: "Not reported: Claude Code sends it only with a usage warning" },
		]);
		// A subscription's reported cost is not what it cost the person: lib/cost.ts prices items instead.
		expect(agentFacts(agent({ tokens: "subscription", cost: { amount: 0.42, currency: "USD" } }))).not.toContainEqual(
			expect.objectContaining({ label: "Cost" }),
		);
		expect(agentFacts(agent({ fiveHour: { first: 38, latest: 41.4 } }))[0]?.value).toBe(
			"38% used at the first turn, 41% after the latest",
		);
	});
});
