// @vitest-environment jsdom
/** The item page's dollars: what it added to your bills, who carried each part, each part of a feature, and by model who paid. */
import type { CostRates, ItemSummary, ItemView, SpendUsage } from "@contract";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { addSandbox, addTurn, noUsage, turnMeter } from "../../../server/src/factory/cost.js";
import { CostByModel, ItemCost } from "./ItemCost";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RATES: CostRates = {
	models: { "anthropic/claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3 } },
	source: { name: "models.dev", url: "https://models.dev/api.json", fetchedAt: Date.UTC(2026, 10, 27) },
	sandbox: { standard: 0.18 },
};

function used(turn: Partial<Parameters<typeof turnMeter>[0]>, seconds = 0): SpendUsage {
	const usage = noUsage();
	addTurn(
		usage,
		turnMeter({
			harness: "windlass",
			model: "anthropic/claude-sonnet-4-5",
			key: { provider: "anthropic", generation: "g" },
			usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
			size: "standard",
			...turn,
		}),
	);
	addSandbox(usage, "standard", seconds);
	return usage;
}

const spent = (usage: SpendUsage) => ({ tokens: 0, turns: 1, activeSeconds: 0, hostedSeconds: 0, usage });

function view(more: Partial<ItemView>): ItemView {
	return { place: { kind: "hosted" }, spent: spent(used({}, 3600)), ...more } as ItemView;
}

function render(of: ItemView, rates: CostRates | null = RATES): HTMLElement {
	const host = document.createElement("div");
	const root = createRoot(host);
	act(() =>
		root.render(
			createElement(
				"div",
				null,
				createElement(ItemCost, { view: of, rates }),
				createElement(CostByModel, { view: of, rates }),
			),
		),
	);
	return host;
}

const facts = (host: HTMLElement) =>
	Object.fromEntries(
		[...host.querySelectorAll(".item-cost > div")].map(row => [
			row.querySelector("dt")?.textContent,
			row.querySelector("dd")?.textContent,
		]),
	);

const plan = { provider: "anthropic", generation: "g", plan: true } as const;

describe("the item page's dollars", () => {
	it("says a key's real dollars as extra, and hosted time as an estimate where billing is off", () => {
		const host = render(view({}));
		expect(facts(host)).toEqual({
			Total: "$3.00 extra",
			"Paid with your Anthropic key": "$3.00",
			Sandbox: "≈ $0.18 hosted for 1 h, estimated",
		});
		expect(host.querySelector(".item-dollars-models td")?.textContent).toBe("your Anthropic key");
	});
	it("values a plan's turns at API prices, and splits hosted time into included and extra", () => {
		const usage = used({ key: plan }, 2400);
		usage.hosted = { includedSeconds: 1800, extraSeconds: 600, extraUsd: 0.06 };
		expect(facts(render(view({ spent: spent(usage) })))).toEqual({
			Total: "$0.06 extra",
			"Included in your Claude plan": "1 turn · ≈ $3.00 at API prices",
			"Included in your Windlass plan": "30 hosted min",
			"Extra hosted time": "10 hosted min · $0.06",
		});
	});
	it("says a machine's plan carried it all, and a machine's sandbox costs nothing", () => {
		const host = render(
			view({
				place: { kind: "machine", machineId: "m1" },
				spent: spent(
					used({ harness: "claude", model: "claude-sonnet-4-5", key: undefined, signIn: "subscription", size: null }),
				),
			}),
		);
		expect(facts(host)).toEqual({
			Total: "Included in your plans",
			"Included in your machine's plan": "1 turn · ≈ $3.00 at API prices",
			Sandbox: "$0.00: your machine",
		});
		expect(host.querySelector(".item-dollars-models td")?.textContent).toBe("your machine's plan");
	});
	it("gives each part of a feature its cost, retries in its sum, and the feature's own turns apart", () => {
		const part = (id: string, title: string, usage: SpendUsage) => ({ id, title, spent: spent(usage) }) as ItemSummary;
		const parser = part("i_1", "Parse the manifest", used({}));
		const writer = part("i_2", "Write the CSV", used({ key: plan }));
		const host = render(
			view({
				spent: spent(used({}, 0)),
				partsUsage: used({}),
				children: [parser, writer],
			}),
		);
		const rows = [...host.querySelectorAll(".item-dollars > .item-dollars-table tbody tr")].map(row =>
			[...row.children].map(cell => cell.textContent),
		);
		expect(rows).toEqual([
			["Planning, review and summary", "$3.00 extra"],
			["Parse the manifest", "$3.00 extra"],
			["Write the CSV", "Included in your plans"],
		]);
		expect(facts(host).Total).toBe("$6.00 extra");
	});
	it("says an unpriced model is unknown, and waits for prices before saying anything", () => {
		const host = render(view({ spent: spent(used({ model: "anthropic/claude-new" }, 3600)) }));
		expect(facts(host)).toMatchObject({ Total: "Cost unknown", "Paid with your Anthropic key": "Cost unknown" });
		expect(render(view({}), null).textContent).toBe("Reading prices…");
	});
});
