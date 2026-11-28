/**
 * The landing page's words, kept apart from its markup so that the page, its FAQPage JSON-LD and
 * llms.txt say the same thing. Every claim here is one the platform's code and docs back, as the hosted
 * service runs it (the reviewer on, hosted sandboxes on an allowlisted network): no dates for what is not
 * built, no numbers that were not measured. What only a pull request has (dollar cost per item, paying
 * with a Claude plan) stays out until it lands.
 */

export const LANDING_TITLE = "Windlass — the open-source software factory";

export const LANDING_DESCRIPTION =
	"Hand off a GitHub or Linear issue to a coding agent. Get back a pull request only after your CI passes and a second agent reviews it.";

/** One sentence an answer engine can quote as is. */
export const ONE_LINER =
	"Windlass is an open-source software factory: it takes an issue from GitHub, GitLab, Linear, Jira or Slack, has a coding agent (Windlass, Claude Code, Codex or OpenCode) build it in a sandbox, and hands back a pull request only after your checks and CI pass on the exact commit and a second agent reviews it.";

export const REPO_URL = "https://github.com/WindlassAI/windlass-platform";

export interface Proof {
	key: "ci" | "keys" | "open";
	title: string;
	text: string;
}

/** The strip under the hero. */
export const PROOF: Proof[] = [
	{
		key: "ci",
		title: "Your CI decides, not the agent.",
		text: "On GitHub every item ends in a windlass/verified check you can make required.",
	},
	{
		key: "keys",
		title: "Your keys stay out of the sandbox.",
		text: "Model keys are relayed per turn, and Windlass pushes the branch itself.",
	},
	{
		key: "open",
		title: "Open source, runs anywhere.",
		text: "Hosted, on your own machine, or self-hosted. Apache-2.0.",
	},
];

export interface Step {
	label: string;
	text: string;
}

/** The Factory's sequence, as the server's factory flow runs it. */
export const FACTORY_STEPS: Step[] = [
	{ label: "File", text: "A GitHub or GitLab label or mention, Linear, Jira, Slack, the API or the Factory page." },
	{ label: "Plan", text: "Bigger work is split into parts you approve. Small plans can approve themselves." },
	{ label: "Build", text: "Each part runs in a sandbox of its own, up to three at once." },
	{ label: "Check", text: "Your repository's checks run. Failures go back to the agent." },
	{ label: "CI", text: "Your CI runs on the pushed commit. Failing logs go back to the agent." },
	{ label: "Review", text: "A second agent reviews the exact commit, in its own sandbox." },
	{ label: "Verified", text: "windlass/verified passes only on what was observed, never on what the agent says." },
	{ label: "Merge", text: "You merge, or turn on auto-merge for a repository once you trust it." },
];

export interface SafetyCard {
	key: "keys" | "network" | "resume";
	title: string;
	text: string;
}

export const SAFETY: SafetyCard[] = [
	{
		key: "keys",
		title: "Credentials stay outside",
		text: "Your model key is relayed per turn and never written into the sandbox. Windlass pushes the branch itself with a token for that one repository, so the agent is never handed one.",
	},
	{
		key: "network",
		title: "The network is allowlisted",
		text: "Hosted commands reach only the hosts you allow. A blocked request shows up on the item, with one click to allow it for that repository.",
	},
	{
		key: "resume",
		title: "Runs survive restarts",
		text: "A turn running when the server restarts, or when your machine drops off, picks up again from the agent's own saved session.",
	},
];

export type AgentId = "windlass" | "claude" | "codex" | "opencode";

export interface AgentRow {
	id: AgentId;
	name: string;
	hosted: string;
	machine: string;
}

/** Where each agent runs, and what it can take on there. Planning and review run on Windlass. */
export const AGENT_GRID: AgentRow[] = [
	{
		id: "windlass",
		name: "Windlass agent",
		hosted: "Everything, plans included",
		machine: "Everything, plans included",
	},
	{ id: "claude", name: "Claude Code", hosted: "Quick items and plan parts", machine: "Quick items and plan parts" },
	{ id: "codex", name: "Codex", hosted: "Quick items", machine: "Quick items" },
	{ id: "opencode", name: "OpenCode", hosted: "Quick items and plan parts", machine: "Quick items and plan parts" },
];

export interface Plan {
	name: string;
	price: string;
	per: string;
	points: string[];
	accent?: boolean;
}

/** The plans, as server/src/billing/plans.ts sets them. */
export const PLANS: Plan[] = [
	{
		name: "Free",
		price: "$0",
		per: "",
		points: [
			"120 hosted minutes a month",
			"Unlimited runs on up to 3 of your machines",
			"Every agent, the Factory and Repo setup",
		],
	},
	{
		name: "Pro",
		price: "$15",
		per: "a month, or $144 a year",
		points: [
			"1,800 hosted minutes a month",
			"$0.006 a minute after that, under a spend cap you set (at most $20)",
			"Up to 10 machines",
			"Everything in Free",
		],
		accent: true,
	},
	{
		name: "Self-host",
		price: "Free",
		per: "",
		points: [
			"The whole platform, Apache-2.0",
			"On your own server, with your own sandboxes",
			"A compose kit and an operator's guide",
		],
	},
];

export interface Faq {
	question: string;
	answer: string;
}

export const FAQ: Faq[] = [
	{
		question: "How is this different from Devin, Copilot's coding agent or OpenHands?",
		answer:
			"Three things. Your checks, your CI and an independent review decide whether work is done, and on GitHub that verdict is a check you can make required. You choose the agent (Claude Code, Codex, OpenCode or Windlass) instead of being locked to one. And it is open source: run it hosted, on your own machine, or on your own servers.",
	},
	{
		question: "Does Windlass store my code or keys?",
		answer:
			"Your API keys are stored encrypted and relayed per turn; they are never written into the sandbox. Code lives in your repository, and in the sandbox while an agent works on it. Repository secrets you choose to share are passed in as environment variables. Self-host if you want everything on your own infrastructure.",
	},
	{
		question: "Can it merge on its own?",
		answer:
			"Only if you turn auto-merge on for a GitHub repository, and only for a single item whose checks and CI passed on the exact commit and whose review approved it. Otherwise you merge.",
	},
	{
		question: "Which agents and models can I use?",
		answer:
			"Claude Code, Codex, OpenCode and the Windlass agent, with your own keys for Anthropic, OpenAI, Google Gemini or OpenRouter. Planning and review run on the Windlass agent; the others build quick items and the parts of a plan (Codex quick items only).",
	},
	{
		question: "Where does the agent's code run?",
		answer:
			"In a hosted sandbox, or on a Mac, Linux or Windows (WSL) machine of yours with Docker. Your machine connects out to Windlass, so nothing on your network has to open up.",
	},
	{
		question: "What does it cost to run?",
		answer:
			"Hosted time is on your plan; time on your own machines is not counted. Model tokens are billed by your provider, on your own key. Each item has a budget in dollars, and its page shows what it cost: model, sandbox and retries.",
	},
	{
		question: "Is it open source?",
		answer: "Yes. The platform is Apache-2.0, and the Windlass agent is MIT.",
	},
	{
		question: "How do I get access?",
		answer:
			"The hosted service is open to invited accounts while it is young: an invited account signs in with GitHub or Google. Anyone can self-host the platform today.",
	},
];
