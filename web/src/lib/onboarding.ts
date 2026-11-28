/**
 * The first-run setup on Home (components/Onboarding.tsx): ① connect GitHub, ② pick a repository, ③ connect the
 * agents, ④ file a first work item.
 *
 * When it opens (`shouldOnboard`): for a signed-in, non-demo user on a deployment with a GitHub App and work items,
 * whose account has no agent sessions and no work items yet, and that either is not set up (GitHub is not connected,
 * or no agent can run anywhere: no plan, no checked key, no ChatGPT sign-in, no signed-in agent on a machine) or has
 * a setup under way from an earlier visit. It never opens once dismissed, or once anything was run: the first item
 * filed ends it for good.
 *
 * Dismissing and resuming: what the setup has reached (its step and the repository picked) is kept per user in this
 * browser (`localStorage`, `wlp.onboarding.<uid>`); a dismissed setup can be resumed from Home's empty page.
 */
import { type GithubId, type ItemSummary, MAX_TITLE_CHARS } from "@contract";

export const ONBOARDING_STEPS = ["GitHub", "Repository", "Agents", "First item"] as const;
export type OnboardingStep = 1 | 2 | 3 | 4;

export interface PickedRepository {
	id: GithubId;
	owner: string;
	name: string;
}

/** What one visit leaves for the next. */
export interface OnboardingSaved {
	step: OnboardingStep;
	repository: PickedRepository | null;
	dismissed: boolean;
}

export interface OnboardingFacts {
	demo: boolean;
	/** The deployment has a GitHub App and work items: without either there is nothing to set up here. */
	offered: boolean;
	/** Null while they are read. */
	githubConnected: boolean | null;
	agentConnected: boolean | null;
	sessions: number | null;
	items: number | null;
	saved: OnboardingSaved | null;
}

/** Whether the setup opens; null while what decides it is still being read. */
export function shouldOnboard(facts: OnboardingFacts): boolean | null {
	if (facts.demo || !facts.offered || facts.saved?.dismissed) return false;
	if (facts.sessions === null || facts.items === null) return null;
	if (facts.sessions > 0 || facts.items > 0) return false;
	if (facts.saved) return true;
	if (facts.githubConnected === null || facts.agentConnected === null) return null;
	return !facts.githubConnected || !facts.agentConnected;
}

/** Where the setup opens: where it was left, or the first step not done yet. */
export function startingStep(saved: OnboardingSaved | null, githubConnected: boolean): OnboardingStep {
	if (saved) return saved.step === 1 || githubConnected ? saved.step : 1;
	return githubConnected ? 2 : 1;
}

const storageKey = (uid: string) => `wlp.onboarding.${uid}`;

function isStep(value: unknown): value is OnboardingStep {
	return value === 1 || value === 2 || value === 3 || value === 4;
}

export function loadOnboarding(uid: string): OnboardingSaved | null {
	try {
		const raw = JSON.parse(localStorage.getItem(storageKey(uid)) ?? "null") as Partial<OnboardingSaved> | null;
		if (!raw || !isStep(raw.step)) return null;
		const repository = raw.repository;
		return {
			step: raw.step,
			repository:
				repository && typeof repository.name === "string" && typeof repository.owner === "string"
					? { id: repository.id, owner: repository.owner, name: repository.name }
					: null,
			dismissed: raw.dismissed === true,
		};
	} catch {
		// Storage may be disabled: the setup opens again on the next visit while the account is not set up.
		return null;
	}
}

export function saveOnboarding(uid: string, saved: OnboardingSaved): void {
	try {
		localStorage.setItem(storageKey(uid), JSON.stringify(saved));
	} catch {
		// As above.
	}
}

/** A starter task the last step offers: an open bug, or a small safe change any repository can take. */
export interface StarterTask {
	title: string;
	body: string;
	/** What it is, in a few words, under its title. */
	hint: string;
}

/** Generic tasks that are safe on any repository and end in a small pull request. */
const GENERIC_TASKS: StarterTask[] = [
	{
		title: "Add a test for an untested function",
		body: "Find a small function that has no test, and add one that covers its main cases. Change nothing else.",
		hint: "Small · a new test file or case",
	},
	{
		title: "Fix typos and broken links in the README",
		body: "Read the README and fix spelling mistakes, broken links and commands that no longer match the code. Keep the wording otherwise.",
		hint: "Small · documentation only",
	},
	{
		title: "Explain how to run the project locally",
		body: "Check how the project is installed, built and tested, and make sure the README says it in a short section with the exact commands.",
		hint: "Small · documentation only",
	},
];

/** A work item's title is at most MAX_TITLE_CHARS. */
const clip = (title: string) => (title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title);

/** Up to three starter tasks: the oldest open bugs first (at most two), then generic ones. */
export function starterTasks(issues: readonly { number: number; title: string; url: string }[]): StarterTask[] {
	const bugs = issues.slice(0, 2).map(issue => ({
		title: clip(`Fix #${issue.number}: ${issue.title}`),
		body: `Fix the bug reported in ${issue.url}. Read the issue first, reproduce it with a test where you can, and keep the change small.`,
		hint: `Open issue labelled “bug” · #${issue.number}`,
	}));
	return [...bugs, ...GENERIC_TASKS].slice(0, 3);
}

const MINUTE = 60_000;

/**
 * What a finished first item looks like, shown under the setup as an example: one of the mock's items (acme/harbor's
 * checksum log), handed over with its pull request open, CI passed and the second review approving.
 */
export function sampleItem(now: number): ItemSummary {
	return {
		id: "example",
		title: "Show the upload's checksum in the log",
		repository: {
			provider: "github",
			id: 7101,
			owner: "acme",
			name: "harbor",
			branch: "main",
			private: true,
			url: "https://github.com/acme/harbor",
		},
		place: { kind: "hosted" },
		source: "web",
		origin: null,
		state: "review",
		wait: null,
		question: null,
		pullRequest: { number: 61, url: "https://github.com/acme/harbor/pull/61" },
		verdict: { result: "pass", flags: [], ci: "passed" },
		review: { state: "filed", recommendation: "approve" },
		agent: {
			harness: "claude",
			model: "default",
			tokens: "counted",
			reportedTokens: 1_744_000,
			cost: null,
			fiveHour: null,
		},
		budget: { tokens: 2_000_000, hostedSeconds: 3600 },
		spent: { tokens: 1_744_000, turns: 1, activeSeconds: 45 * 60, hostedSeconds: 45 * 60 },
		sessionId: "example",
		createdAt: now - 71 * MINUTE,
		startedAt: now - 70 * MINUTE,
		updatedAt: now - 20 * MINUTE,
		revision: 1,
	};
}
