// @vitest-environment jsdom
/** An item waiting for its plan: "Use my key now" only where a key can pay, and the way to the rule. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlatformError } from "../api/client";
import { PlanWaitActions } from "./PlanWait";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const buttons = () => [...host.querySelectorAll("button")].map(b => b.textContent);

it("offers the key now where one can pay, and calls for it", async () => {
	const onUseKey = vi.fn(async () => undefined);
	act(() =>
		root.render(
			createElement(PlanWaitActions, { plan: { provider: "anthropic", limited: true, keyNow: true }, onUseKey }),
		),
	);
	expect(buttons()).toEqual(["Use my key now"]);
	const rule = host.querySelector<HTMLAnchorElement>("a");
	expect(rule?.textContent).toBe("Change who pays");
	expect(rule?.getAttribute("href")).toBe("/connections#pay-claude");
	await act(async () => host.querySelector("button")!.click());
	expect(onUseKey).toHaveBeenCalledTimes(1);
});

it("offers no key where none can pay, and says why a switch was refused", async () => {
	act(() =>
		root.render(
			createElement(PlanWaitActions, {
				plan: { provider: "openai", limited: false, keyNow: false },
				onUseKey: async () => undefined,
			}),
		),
	);
	expect(buttons()).toEqual([]);
	expect(host.querySelector("a")?.getAttribute("href")).toBe("/connections#pay-codex");

	const refused = async () => {
		throw new PlatformError("user", "No saved key can pay for this item.", { reason: "bad_input" });
	};
	act(() =>
		root.render(
			createElement(PlanWaitActions, {
				plan: { provider: "anthropic", limited: true, keyNow: true },
				onUseKey: refused,
			}),
		),
	);
	await act(async () => host.querySelector("button")!.click());
	expect(host.querySelector('[role="alert"]')?.textContent).toBe("No saved key can pay for this item.");
});
