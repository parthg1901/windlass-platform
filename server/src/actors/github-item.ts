import type { resolveCodeHost } from "../codehost/index.js";
import { config } from "../config.js";
import type { GithubId, ItemState } from "../contract.js";
import { issueComment, recentSubject, type IssueBinding } from "../factory/intake.js";
import { type GithubApp, type GithubUser } from "../github/app.js";
import { contentDigest, readIssue, subjectRead } from "../github/issues.js";

export interface IssueNotice {
	installationId: GithubId;
	repositoryId: GithubId;
	issue: number;
	senderId: GithubId;
	action: string;
}
export interface ObservedIssue {
	subject: string;
	by: string;
	said: string;
	cancel: "draft" | "before_review" | null;
}

/** Edits and closes share one issue read. Deliveries can arrive out of order. */
export interface IssueChanges {
	edited?: boolean;
	closedBy?: GithubId[];
	unlabeledBy?: GithubId;
}
export async function observeIssue(
	binding: IssueBinding,
	repositoryId: GithubId,
	changes: IssueChanges,
	permission: (by: GithubUser) => Promise<string>,
): Promise<ObservedIssue[]> {
	const number = binding.origin.issue.number;
	const found = await readIssue(binding.installationId, repositoryId, number);
	if (!found) return [];
	if (found === "gone" || "movedIssueId" in found) {
		if (found !== "gone" && found.movedIssueId !== binding.issueId) return [];
		return [
			{ subject: "gone", by: "platform", said: "The issue was deleted (or moved) on GitHub.", cancel: "before_review" },
		];
	}
	const { app, token, repo, issue } = found;
	if (issue.id !== binding.issueId) return [];
	const observations: ObservedIssue[] = [];
	if (changes.edited && recentSubject(issue.updated) && contentDigest(issue) !== binding.contentDigest)
		observations.push({
			subject: "edited",
			by: "platform",
			said: "The issue was edited on GitHub after it was filed; the item keeps the text it was filed with.",
			cancel: null,
		});
	const action =
		changes.unlabeledBy && !issue.labels.includes(binding.triggerLabel ?? "windlass")
			? "unlabeled"
			: changes.closedBy && issue.state === "closed"
				? "closed"
				: null;
	if (!action) return observations;
	const transition = await subjectRead(() => app.issueTransition(token, repo, number, action, binding.triggerLabel));
	if (!transition || !recentSubject(transition.at) || transition.at < binding.triggeredAt) return observations;
	const matched =
		action === "closed"
			? changes.closedBy?.includes(transition.author.id)
			: transition.author.id === changes.unlabeledBy;
	if (!matched) return observations;
	const actor = transition.author,
		by = "github:" + actor.login;
	if (action === "unlabeled")
		observations.push({
			subject: transition.id,
			by,
			said: `@${actor.login} removed the windlass label on GitHub.`,
			cancel: "draft",
		});
	else {
		const writer = actor.id === binding.senderId || (await permission(actor)) === "write";
		observations.push({
			subject: writer ? transition.id : "stranger-close",
			by,
			said: `The issue was closed on GitHub by @${actor.login}.`,
			cancel: writer ? "before_review" : null,
		});
	}
	return observations;
}

// The GitHub adapter accepts an optional operation label for its error messages.
export type GithubCommentHost = Pick<NonNullable<ReturnType<typeof resolveCodeHost>>, "withToken" | "listComments"> & {
	createComment: GithubApp["createIssueComment"];
	updateComment: GithubApp["updateIssueComment"];
};

export async function writeIssueComment(
	host: GithubCommentHost,
	slug: string,
	repo: { id: GithubId; owner: string; name: string },
	binding: IssueBinding,
	itemId: string,
	title: string,
	state: ItemState,
	pr: number | undefined,
	commentId?: string,
) {
	const number = binding.origin.issue.number;
	const body =
		issueComment(itemId, title, binding.origin, state, pr, `${config.origins[0]}/items/${itemId}`) +
		(binding.modeReason ? " " + binding.modeReason : "");
	const marker = body.split("\n", 1)[0];
	return host.withToken(
		{ installationId: binding.installationId, repositoryId: repo.id },
		"comment:write",
		async token => {
			if (!commentId) {
				const comments = await host.listComments(token, repo.owner, repo.name, number, true);
				const own = comments.find(
					one => one.author.toLowerCase() === slug.toLowerCase() + "[bot]" && one.body.startsWith(marker + "\n"),
				);
				if (own && !own.id) throw new Error("GitHub returned no issue comment id");
				if (own?.body === body) return own.id!;
				commentId = own?.id ?? undefined;
			}
			if (commentId) {
				await host.updateComment(token, repo.owner, repo.name, commentId, body, "update the work item link");
				return commentId;
			}
			const id = await host.createComment(token, repo.owner, repo.name, number, body, "post the work item link");
			if (!id) throw new Error("GitHub returned no issue comment id");
			return id;
		},
	);
}
