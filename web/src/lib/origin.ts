import type { ItemOrigin, ItemSource } from "@contract";
import { bySource } from "../../../server/src/sources/registry.js";

export const filingSource: Record<ItemSource, string> = {
	web: "the web",
	api: "the API",
	...bySource(caps => caps.displayName),
};

/** The issue an item was filed from, whichever tracker it is on: what a link and a note about its author need. */
export interface OriginIssue {
	/** The work source's id (sources/types.ts), which names its mark. */
	provider: "github" | "linear" | "jira";
	tracker: "GitHub" | "Linear" | "Jira";
	url: string;
	/** "#12" or "ENG-12". */
	label: string;
	/** The author as the tracker names them: "@login" on GitHub, a name on Linear. */
	author: string;
	trusted: boolean;
	/** Who filed it, in the same form. */
	sender: string;
}

export function originIssue(origin: ItemOrigin): OriginIssue {
	if (origin.issue) {
		const { issue } = origin;
		return {
			provider: "github",
			tracker: "GitHub",
			url: issue.url,
			label: `#${issue.number}`,
			author: "@" + issue.author,
			trusted: issue.trusted,
			sender: "@" + origin.sender,
		};
	}
	const issue = origin.linear ?? origin.jira;
	return {
		provider: origin.linear ? "linear" : "jira",
		tracker: origin.linear ? "Linear" : "Jira",
		url: issue.url,
		label: issue.identifier,
		author: issue.author,
		trusted: issue.trusted,
		sender: origin.sender,
	};
}
