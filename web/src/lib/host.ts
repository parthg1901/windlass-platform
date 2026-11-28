/**
 * A repository's code host in words, from the host and source records (codehost/capabilities.ts,
 * sources/registry.ts): its name and what it calls the change it reviews. Rows written before GitLab have no
 * provider: they are GitHub's.
 */
import type { HostId } from "@contract";
import { hostCaps } from "../../../server/src/codehost/capabilities.js";
import { sourceCaps } from "../../../server/src/sources/registry.js";

export interface HostWords {
	/** "GitHub", "GitLab". */
	name: string;
	/** "pull request", "merge request". */
	noun: string;
	/** "PR", "MR". */
	short: string;
	/** The mark before a request's number: "#", "!". */
	mark: string;
}

export function hostWords(host: HostId | undefined): HostWords {
	const id = host ?? "github";
	return { name: sourceCaps(id).displayName, ...hostCaps(id).request };
}

/** "#12" on GitHub, "!12" on GitLab. */
export const requestNumber = (host: HostId | undefined, number: number) => `${hostWords(host).mark}${number}`;

/** "pull request" → "Pull request", to start a sentence. */
export const sentenceCase = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);
