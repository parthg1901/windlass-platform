/**
 * Work sources: the places requests come from and progress is posted back to (GitHub and GitLab issues, Linear,
 * Jira, Slack). Each has one capability record (registry.ts), and shared flows decide by its flags, never by the
 * source's id, so a source added later is one record more (the `sandbox/harnesses.ts` rule).
 *
 * Browser-safe: the web generates its source words from the same records.
 */

import { type GithubId, HOST_IDS } from "../contract/github.js";

/** Every work source, in the order lists and filters show them: the code hosts' issues first. */
export const SOURCE_IDS = [...HOST_IDS, "linear", "jira", "slack"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

/** What a source can do. A field is only added once something reads it. */
export interface SourceCaps {
	/** The source's name in every UI string, refusal and log line. */
	displayName: string;
	/** What one filing is: an issue, or a message (which has no issue to re-read). */
	noun: "issue" | "message";
	/** How the source writes a person's name before it: "@" for a login (GitHub, GitLab), nothing for a full name. */
	handle: "@" | "";
	/** Labels that ask for Quick mode. */
	quickLabels: readonly string[];
	/** Someone else's filing as the agent's turn names it (`untrustedWords.source`), and the pattern that recognizes it as third-party text. */
	untrusted: { words(display: string, author: string): string; pattern: RegExp };
}

/** One filing in a source: the same shape for every source. */
export interface SourceRef<S extends SourceId = SourceId> {
	source: S;
	/** The source's account the filing is in: GitHub installation, GitLab project, Linear workspace, Jira site, Slack team. */
	tenant: string;
	/** What an owner mapped to the repository: Linear team, Jira project, Slack channel. Null for code-host issues. */
	scope: string | null;
	/** The issue's id; Slack: the thread the request was posted in, empty when it was in none. */
	id: string;
	/** As the source shows it: "#12", "ENG-12"; empty for a Slack message. */
	display: string;
	url: string | null;
}

/** Facts only one source has, kept on its bindings as `extra`. Sources not listed have none. */
interface SourceExtra {
	/** The raw ids as stored (numbers or decimal strings), the issue number, content digest, reaction target and trigger label. */
	github: {
		installationId: GithubId;
		senderId: GithubId;
		number: number;
		contentDigest: string;
		triggerLabel?: string;
		reactionTarget?: string;
	};
	gitlab: { projectId: GithubId };
}

/** An item's tie to a source: where it was filed from (`origin`), or later also posts to (`follower`). */
export type SourceBinding = {
	[S in SourceId]: {
		ref: SourceRef<S>;
		role: "origin" | "follower";
		/** Which filing of the issue it is; a message is filed once. */
		generation: number | "message";
		/** Only the mapping captured at admission authorizes posting (Slack's rule). */
		mappingGeneration: string | null;
		/** What the page and the first log line show. Empty names where the source keeps none. */
		origin: { author: string; sender: string; trusted: boolean };
		trigger: { via: string | null; at: number; senderId: string } | null;
		modeReason?: string | null;
	} & (S extends keyof SourceExtra ? { extra: SourceExtra[S] } : { extra?: undefined });
}[SourceId];

/** A binding to one source, whose `extra` is that source's. */
export type BindingOf<S extends SourceId> = Extract<SourceBinding, { ref: { source: S } }>;
