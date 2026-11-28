// @vitest-environment jsdom
/** When the first-run setup opens, where it starts, what it keeps, and the starter tasks it offers. */
import { afterEach, describe, expect, it } from "vitest";
import {
	loadOnboarding,
	type OnboardingFacts,
	saveOnboarding,
	shouldOnboard,
	startingStep,
	starterTasks,
} from "./onboarding";

const facts = (over: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
	demo: false,
	offered: true,
	githubConnected: false,
	agentConnected: false,
	sessions: 0,
	items: 0,
	saved: null,
	...over,
});

describe("whether the setup opens", () => {
	it("opens for a new account that is not set up, and waits while that is being read", () => {
		expect(shouldOnboard(facts())).toBe(true);
		expect(shouldOnboard(facts({ githubConnected: true }))).toBe(true);
		expect(shouldOnboard(facts({ agentConnected: true }))).toBe(true);
		expect(shouldOnboard(facts({ githubConnected: null }))).toBeNull();
		expect(shouldOnboard(facts({ sessions: null }))).toBeNull();
	});

	it("stays shut once set up, once anything ran, for the demo, without GitHub or items, and once dismissed", () => {
		expect(shouldOnboard(facts({ githubConnected: true, agentConnected: true }))).toBe(false);
		expect(shouldOnboard(facts({ sessions: 1 }))).toBe(false);
		expect(shouldOnboard(facts({ items: 2 }))).toBe(false);
		expect(shouldOnboard(facts({ demo: true }))).toBe(false);
		expect(shouldOnboard(facts({ offered: false }))).toBe(false);
		const saved = { step: 3 as const, repository: null, dismissed: true };
		expect(shouldOnboard(facts({ saved }))).toBe(false);
	});

	it("resumes a setup under way even when everything is connected now", () => {
		const saved = { step: 4 as const, repository: { id: 7101, owner: "acme", name: "harbor" }, dismissed: false };
		expect(shouldOnboard(facts({ githubConnected: true, agentConnected: true, saved }))).toBe(true);
		expect(shouldOnboard(facts({ githubConnected: true, agentConnected: true, saved, items: 1 }))).toBe(false);
	});
});

it("starts where it was left, or at the first step not done; back at GitHub when GitHub went", () => {
	expect(startingStep(null, false)).toBe(1);
	expect(startingStep(null, true)).toBe(2);
	expect(startingStep({ step: 3, repository: null, dismissed: false }, true)).toBe(3);
	expect(startingStep({ step: 3, repository: null, dismissed: false }, false)).toBe(1);
});

describe("what it keeps", () => {
	afterEach(() => localStorage.clear());

	it("keeps the step, the repository and the dismissal per user, and ignores what it cannot read", () => {
		expect(loadOnboarding("u1")).toBeNull();
		const saved = { step: 2 as const, repository: { id: 7101, owner: "acme", name: "harbor" }, dismissed: true };
		saveOnboarding("u1", saved);
		expect(loadOnboarding("u1")).toEqual(saved);
		expect(loadOnboarding("u2")).toBeNull();
		localStorage.setItem("wlp.onboarding.u3", '{"step":9}');
		expect(loadOnboarding("u3")).toBeNull();
		localStorage.setItem("wlp.onboarding.u4", "not json");
		expect(loadOnboarding("u4")).toBeNull();
	});
});

it("offers the oldest open bugs first, at most two, then safe generic tasks, three in all", () => {
	const generic = starterTasks([]);
	expect(generic).toHaveLength(3);
	expect(generic[0]?.title).toBe("Add a test for an untested function");
	const issues = [1, 2, 3].map(number => ({
		number,
		title: `Bug ${number}`,
		url: `https://github.com/a/b/issues/${number}`,
	}));
	const tasks = starterTasks(issues);
	expect(tasks.map(task => task.title)).toEqual([
		"Fix #1: Bug 1",
		"Fix #2: Bug 2",
		"Add a test for an untested function",
	]);
	expect(tasks[0]?.body).toContain("https://github.com/a/b/issues/1");
	const long = starterTasks([{ number: 9, title: "x".repeat(200), url: "u" }]);
	expect(long[0]?.title.length).toBeLessThanOrEqual(80);
});
