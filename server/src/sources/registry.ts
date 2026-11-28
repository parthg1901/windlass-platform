/** The capability record of each work source (types.ts). Browser-safe. */

import { SOURCE_IDS, type SourceCaps, type SourceId } from "./types.js";

const SOURCES: Record<SourceId, SourceCaps> = {
	github: {
		displayName: "GitHub",
		noun: "issue",
		handle: "@",
		quickLabels: ["windlass:quick"],
		untrusted: { words: (display, author) => `issue ${display} by @${author}`, pattern: /^issue #\d+ by @/ },
	},
	gitlab: {
		displayName: "GitLab",
		noun: "issue",
		handle: "@",
		quickLabels: [],
		untrusted: { words: display => `GitLab issue ${display}`, pattern: /^GitLab issue #\d+$/ },
	},
	linear: {
		displayName: "Linear",
		noun: "issue",
		handle: "",
		quickLabels: ["windlass:quick", "windlass-quick"],
		untrusted: {
			words: (display, author) => `Linear issue ${display} by ${author}`,
			pattern: /^Linear issue [A-Za-z0-9]+-\d+ by /,
		},
	},
	jira: {
		displayName: "Jira",
		noun: "issue",
		handle: "",
		quickLabels: ["windlass:quick", "windlass-quick"],
		untrusted: {
			words: (display, author) => `Jira issue ${display} by ${author}`,
			pattern: /^Jira issue [A-Za-z0-9_]+-\d+ by /,
		},
	},
	slack: {
		displayName: "Slack",
		noun: "message",
		handle: "",
		quickLabels: [],
		untrusted: { words: () => "a Slack request", pattern: /^a Slack request$/ },
	},
};

export const sourceCaps = (id: SourceId): SourceCaps => SOURCES[id];

/** One value per source, from its capabilities: the source word maps the web and the platform show. */
export function bySource<T>(of: (caps: SourceCaps) => T): Record<SourceId, T> {
	return Object.fromEntries(SOURCE_IDS.map(id => [id, of(SOURCES[id])])) as Record<SourceId, T>;
}

/** How the item list's filter names a source: "Linear issue", "Slack". */
export const filterWord = (caps: SourceCaps) =>
	caps.noun === "issue" ? `${caps.displayName} issue` : caps.displayName;

/** Every source by name, as a sentence lists them: "GitHub, GitLab, Linear, Jira and Slack". */
export function sourceNames(): string {
	const names = SOURCE_IDS.map(id => SOURCES[id].displayName);
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
