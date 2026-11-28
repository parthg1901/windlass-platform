/**
 * A work item's agent as its page says it: who builds it, on which model, and what that agent reported
 * of its spend (server/src/factory/budget.ts, `noteAgentTurn`). Where its tokens are not counted against
 * the item's budget, no meter is drawn: a 0 that was never measured is not shown as one.
 */
import type { ItemAgent, ItemSpend } from "@contract";
import { HARNESS_NAMES } from "./acp";
import { modelWords } from "./models";
import { plural, sandboxTime } from "./format";

/** What a subscription agent spent, which no token budget holds: "4 turns, 12 min". */
export const subscriptionSpend = (spent: Pick<ItemSpend, "turns" | "activeSeconds">): string =>
	`${plural(spent.turns, "turn")}, ${sandboxTime(spent.activeSeconds)}`;

/** "Claude Code · Sonnet · effort high", "Windlass · GPT-6.2 Sol"; the agent's default model is said as such. */
export function agentLine(agent: ItemAgent | undefined): string {
	if (!agent) return "Windlass";
	return `${HARNESS_NAMES[agent.harness] ?? agent.harness} · ${agent.model === "default" ? "its default model" : modelWords(agent.model)}${agent.effort ? ` · effort ${agent.effort}` : ""}`;
}

/** The tokens row where it is no meter of the budget: null where the tokens count against it. */
export function agentTokens(agent: ItemAgent | undefined): string | null {
	if (!agent || agent.tokens === "counted") return null;
	const name = HARNESS_NAMES[agent.harness] ?? agent.harness;
	if (agent.tokens === "not_reported") return `Not reported by ${name}`;
	return `${agent.reportedTokens.toLocaleString("en-US")} reported by ${name}, not counted: a subscription is not billed by token`;
}

/**
 * What else the agent reported: Claude Code's 5-hour window at the first turn and now. Its dollar cost is not
 * shown here: lib/cost.ts prices the item, and a plan's turns have none.
 */
export function agentFacts(agent: ItemAgent | undefined): { label: string; value: string }[] {
	if (!agent) return [];
	const facts: { label: string; value: string }[] = [];
	if (agent.subscriptionTokens)
		facts.push({ label: "Subscription tokens", value: agent.subscriptionTokens.toLocaleString("en-US") });
	if (agent.fiveHour)
		facts.push({
			label: "5-hour window",
			value: `${Math.round(agent.fiveHour.first)}% used at the first turn, ${Math.round(agent.fiveHour.latest)}% after the latest`,
		});
	// Claude Code sends the share of the window used only with a usage warning (its rate_limit_event carries
	// `utilization` only then), so most items never get one. Say so rather than leave the row out.
	else if (agent.harness === "claude")
		facts.push({ label: "5-hour window", value: "Not reported: Claude Code sends it only with a usage warning" });
	return facts;
}
