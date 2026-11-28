/**
 * The public pages: every address that is served as prerendered HTML instead of the app's shell, and
 * the one list the build reads to write them, sitemap.xml, robots.txt, llms.txt and llms-full.txt
 * (web/site-build.ts). A page that is not here is a page of the app: it gets app.html, which is not
 * indexed.
 *
 * To add public pages (the docs, say), make `PublicPage`s in a module of your own and spread them into
 * `PUBLIC_PAGES` below. A page's body must render without the browser: no effects run, no state is
 * kept, nothing reads `window`. Its styles go into the app's stylesheet (import them in main.tsx): the
 * prerendered pages link the same stylesheet the app does. The checks in pages.test.ts hold every page
 * to the rules.
 */
import type { ReactElement } from "react";
import { absolute, SITE_NAME, SITE_URL } from "./config";
import {
	AGENT_GRID,
	FACTORY_STEPS,
	FAQ,
	LANDING_DESCRIPTION,
	LANDING_TITLE,
	ONE_LINER,
	PLANS,
	PROOF,
	REPO_URL,
	SAFETY,
} from "./content";
import { Landing } from "./Landing";
import { docsPublicPages } from "../docs/public";

export interface PublicPage {
	/** The address: starts with "/", no trailing slash (but "/" itself), no extension. It is written to `<path>/index.html`. */
	path: string;
	/** The whole `<title>`, brand included. Keep it under about 60 characters. */
	title: string;
	/** The meta description and the Open Graph one: one or two plain sentences, under about 160 characters. */
	description: string;
	/** The page's body, rendered to static HTML inside `#root`. */
	render(): ReactElement;
	/** The page as Markdown, for llms-full.txt: what an answer engine should read of it. */
	markdown(): string;
	/** Its line in llms.txt, under `section`. */
	llms: { section: string; summary: string };
	/** Structured data for its head, as JSON-LD objects (each gets "@context" if it has none). */
	jsonLd?: object[];
	/** Open Graph type: "website" for the landing, "article" for a document. */
	ogType?: "website" | "article";
	/** The Open Graph and Twitter image, an absolute path on the site; /og.png when left out. */
	image?: { path: string; alt: string; width: number; height: number };
	/** When its content last changed (YYYY-MM-DD), for sitemap.xml. Left out, the sitemap says nothing of it. */
	lastModified?: string;
	/**
	 * Whether a signed-in visitor is given the app here instead (public/site.js loads it before first
	 * paint): true for "/" only, where the landing and the user's agents share an address.
	 */
	appForSignedIn?: boolean;
	/**
	 * Whether every visitor's browser loads the app's entry here after the static page shows: true for
	 * the docs, whose search, contents and menu need it. The static markup stays visible until the app
	 * replaces it with the same page, so nothing is hidden first.
	 */
	appForEveryone?: boolean;
}

export const DEFAULT_IMAGE = {
	path: "/og.png",
	alt: "Windlass, the open-source software factory: hand off the issue, get back a PR you can trust.",
	width: 1200,
	height: 630,
};

function landingMarkdown(): string {
	return [
		`# ${SITE_NAME}`,
		"",
		ONE_LINER,
		"",
		...PROOF.map(item => `- **${item.title}** ${item.text}`),
		"",
		"## The factory",
		"",
		"Label an issue `windlass`, mention `@windlass`, or file it from Linear, Jira, Slack or the Factory page. Windlass plans it, builds it and checks it, and you get a pull request with the evidence attached.",
		"",
		...FACTORY_STEPS.map((step, index) => `${index + 1}. **${step.label}**: ${step.text}`),
		"",
		"GitLab issues come in as quick items; the windlass/verified check and auto-merge are GitHub's.",
		"",
		"## Proof, not promises",
		"",
		"Windlass builds its verdict from your checks and your CI on the exact commit it pushed, plus an independent review. On GitHub the verdict is the `windlass/verified` check, which you can make required with branch protection. Every item shows what it cost in dollars (model, sandbox and retries), and Usage tracks the median cost per finished item by size of work.",
		"",
		"## Safe by default",
		"",
		...SAFETY.map(card => `- **${card.title}.** ${card.text}`),
		"",
		"## Agents and where they run",
		"",
		...AGENT_GRID.map(
			agent =>
				`- **${agent.name}**: hosted: ${agent.hosted.toLowerCase()}; on your machine: ${agent.machine.toLowerCase()}.`,
		),
		"",
		// jargon-ok: llms.txt is reference text for machines, where the layers belong
		"Hosted sandboxes are E2B microVMs on an allowlisted network. Your own Mac, Linux or Windows (WSL) machine with Docker runs a small runner that connects out to the platform; nothing on the machine needs to be reachable from outside. Planning and review run on the Windlass agent.",
		"",
		"## Repo setup",
		"",
		"A setup score of eight checks, instant and free; Finish setup drafts the contributor guides and skills as one reviewed pull request; the windlass/guides check flags guides that go out of date.",
		"",
		"## Pricing",
		"",
		...PLANS.map(
			plan => `- **${plan.name}** (${plan.price}${plan.per ? `, ${plan.per}` : ""}): ${plan.points.join("; ")}.`,
		),
		"",
		"Model usage is billed by your provider, on your own key.",
		"",
		"## Questions",
		"",
		...FAQ.flatMap(item => [`### ${item.question}`, "", item.answer, ""]),
		"## Access",
		"",
		`The hosted service signs in invited accounts at ${absolute("/signin")}. The platform is open source at ${REPO_URL}.`,
	].join("\n");
}

const landing: PublicPage = {
	path: "/",
	title: LANDING_TITLE,
	description: LANDING_DESCRIPTION,
	render: () => <Landing />,
	markdown: landingMarkdown,
	llms: {
		section: "Pages",
		summary: "What Windlass is: sessions, sandboxes, the Factory, the agents it runs, and answers to common questions.",
	},
	ogType: "website",
	appForSignedIn: true,
	jsonLd: [
		{
			"@type": "WebSite",
			"@id": `${SITE_URL}/#website`,
			name: SITE_NAME,
			url: `${SITE_URL}/`,
			description: LANDING_DESCRIPTION,
			inLanguage: "en",
		},
		{
			"@type": "SoftwareApplication",
			"@id": `${SITE_URL}/#app`,
			name: SITE_NAME,
			url: `${SITE_URL}/`,
			description: ONE_LINER,
			applicationCategory: "DeveloperApplication",
			applicationSubCategory: "Software factory",
			operatingSystem: "Web browser",
			featureList: [
				"Files work from GitHub, GitLab, Linear, Jira, Slack, the API or the Factory page",
				"Runs the Windlass agent, Claude Code, Codex and OpenCode with your own API keys",
				"Hosted sandboxes or your own machine through an outbound runner",
				"Checks and CI on the exact pushed commit, and a second agent's review",
				"A windlass/verified check on GitHub that branch protection can require",
				"Repo setup score and contributor guides delivered as one pull request",
			],
		},
		{
			"@type": "FAQPage",
			"@id": `${SITE_URL}/#faq`,
			mainEntity: FAQ.map(item => ({
				"@type": "Question",
				name: item.question,
				acceptedAnswer: { "@type": "Answer", text: item.answer },
			})),
		},
	],
};

/** Every public page. Add yours here (see the comment at the top). */
export const PUBLIC_PAGES: PublicPage[] = [
	landing,
	...docsPublicPages().map(page => ({ ...page, appForEveryone: true })),
];
