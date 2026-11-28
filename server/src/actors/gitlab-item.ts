import { ciState, type CiReading } from "../codehost/ci.js";
import { mergeKindAllowed, taskKind, type TaskKind } from "../factory/readiness-track.js";
import type { BoundHost, GitlabBinding } from "../codehost/item.js";
import type { Pull } from "../codehost/types.js";

/** A bound host that is GitLab's, for the flows only GitLab has yet (its CI snapshot and reviewed merge). */
export type GitlabBound = BoundHost & { gitlab: GitlabBinding };

export function gitlabOf(bound: BoundHost): GitlabBound {
	if (!bound.gitlab) throw new Error("GitLab is unavailable.");
	return bound as GitlabBound;
}

export async function gitlabCi(hub: GitlabBound, head: string, number: number, base: string, mergeCheck: boolean) {
	const mr = number ? await hub.pull(number) : null;
	const reading = await hub.gitlab.pipeline(head, number || undefined);
	const baseSha = (mr?.base === base && mr.baseSha) || null;
	const tip = mergeCheck && baseSha ? await hub.gitlab.baseTip(base) : undefined;
	return {
		reading,
		prHead: mr?.headSha || null,
		mergeable: mr?.mergeable ?? null,
		baseSha,
		baseTip: tip,
		baseAhead: tip && tip === baseSha && mr?.mergeBaseSha === tip ? 0 : undefined,
	};
}

/**
 * Never infer a merge from the webhook. Reads the MR, its target branch, the pipeline at the reviewed head and the
 * notes, outside the item's write queue. The returned step runs inside it: it rechecks only that the MR still has
 * the reviewed head and base, then merges at that head (GitLab refuses a merge whose head has moved since).
 */
export async function prepareGitlabMerge(
	hub: GitlabBound,
	number: number,
	head: string,
	base: string,
	reviewedBase: string | undefined,
	itemId: string,
	kinds?: TaskKind[],
) {
	const mr = await hub.pull(number);
	const reviewed = (pull: Pull) =>
		!!reviewedBase &&
		pull.state === "open" &&
		pull.headSha === head &&
		pull.base === base &&
		pull.baseSha === reviewedBase;
	if (
		!reviewed(mr) ||
		!mr.mergeable ||
		mr.mergeBaseSha !== reviewedBase ||
		(await hub.gitlab.baseTip(base)) !== reviewedBase
	)
		throw new Error("The merge request is not mergeable at the reviewed head and base.");
	const ci: CiReading = await hub.gitlab.pipeline(head, number);
	if (ci.kind !== "read" || ci.head !== head || ci.truncated || ciState(ci) !== "passed")
		throw new Error("CI no longer passes on the reviewed head.");
	const notes = await hub.host.listComments(hub.gitlab.token, hub.owner, hub.name, number, true);
	if (
		notes.some(
			n =>
				!hub.isOwn(n) ||
				!(
					n.body.startsWith(`<!-- windlass-item:${itemId} -->\n`) ||
					n.body.startsWith(`<!-- windlass-review:${itemId}:`)
				),
		)
	)
		throw new Error("Merge request feedback requires handover.");
	if (kinds) {
		// As on GitHub: the kind comes from the change itself, and a partial list cannot authorize a merge.
		const paths = await hub.gitlab.app.changedPaths(hub.gitlab.token, hub.gitlab.project.id, reviewedBase!, head);
		if (!mergeKindAllowed(kinds, paths?.length && paths.length < 300 ? taskKind(paths) : null))
			throw new Error("Automatic merge is off for this kind of change.");
	}
	return async () => {
		if (!reviewed(await hub.pull(number))) throw new Error("The merge request changed before merge.");
		await hub.host.mergePull(hub.gitlab.token, hub.owner, hub.name, number, head, mr.title);
	};
}
