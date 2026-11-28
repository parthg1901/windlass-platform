// The branch an agent's session pushes to, named the same way on every code host.
import type { BoundHost } from "./item.js";

/** The title as whole words of a branch name, at most `max` characters: "Fix the failing add test…" → "fix-the-failing-add-test". */
export function branchWords(title: string, max = 40): string {
	const words = title
		.normalize("NFKD")
		// Accents come apart from their letters: "déjà" is one word, "deja".
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(word => word !== "");
	let joined = "";
	for (const word of words) {
		const next = joined === "" ? word : `${joined}-${word}`;
		if (next.length > max) break;
		joined = next;
	}
	// One word longer than the limit is cut rather than dropped.
	return joined === "" ? (words[0]?.slice(0, max) ?? "") : joined;
}

/** The branch a standalone agent's title asks for, before the code host is asked whether it is free. */
export const wantedBranch = (title: string) => `windlass/${branchWords(title) || "agent"}`;

/**
 * A standalone agent's branch: `windlass/<the title in whole words>`, or with "-2", "-3"… after it when
 * the code host already has that branch, so that a push never lands on another agent's branch.
 */
export async function freeBranch(title: string, taken: (name: string) => Promise<boolean>): Promise<string> {
	const wanted = wantedBranch(title);
	for (let n = 1; n <= 20; n++) {
		const name = n === 1 ? wanted : `${wanted}-${n}`;
		if (!(await taken(name))) return name;
	}
	throw new Error(`The repository already has ${wanted} and 19 more like it.`);
}

/** `freeBranch` against the repository at its code host, with one token for every name it tries. A refusal other than "no such branch" is thrown. */
export function freeBranchAt(bound: BoundHost, title: string): Promise<string> {
	return bound.withToken({ contents: "read" }, token =>
		freeBranch(title, branch => bound.host.hasBranch(token, bound.owner, bound.name, branch)),
	);
}

/**
 * `windlass/<the title in a few words>-<the end of the session's id>`: the branch of a work item's agent,
 * which its item names the same way (work-item.ts `itemBranch`), and of a session that pushed before
 * `freeBranch`. Also the name when the code host cannot be asked which names are free.
 */
export function branchFor(title: string, sessionId: string): string {
	const words = title
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	const end = sessionId.replace(/[^A-Za-z0-9]/g, "").slice(-6);
	return `windlass/${words === "" ? "agent" : words}-${end}`;
}
