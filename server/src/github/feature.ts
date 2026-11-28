import { mergeKindAllowed, taskKind, type TaskKind } from "../factory/readiness-track.js";
import { GithubError, GraphqlRefusal, type GithubApp, type Pull } from "./app.js";
import { ciState, readCi, type CiTarget } from "./ci.js";

/** Called under the item write queue, after checking its review, feedback and repository setting. */
export async function mergeReviewedPull(
	app: GithubApp,
	token: string,
	target: CiTarget,
	pull: Pick<Pull, "number" | "title" | "base" | "baseSha">,
	reviewedBase?: string,
	kinds?: TaskKind[],
) {
	const ci = await readCi(app, target);
	if (ci.kind !== "read" || ci.head !== target.head || ciState(ci) !== "passed")
		throw new Error("CI no longer passes on the reviewed head.");
	const compared = await compareBranches(app, token, target.owner, target.name, pull.base, target.head);
	if (compared.behind > 0) return "behind";
	if (compared.base !== reviewedBase || compared.base !== pull.baseSha)
		throw new Error("The base branch changed before merge.");
	if (kinds) {
		// GitHub caps comparisons at 300 files. A partial list cannot authorize a merge.
		const files = compared.files;
		const kind =
			files?.length && files.length < 300
				? taskKind(files.flatMap(f => (f.previous_filename ? [f.previous_filename, f.filename] : [f.filename])))
				: null;
		if (!mergeKindAllowed(kinds, kind)) throw new Error("Automatic merge is off for this kind of change.");
	}
	await app.squashMerge(token, target.owner, target.name, pull.number, target.head, pull.title);
	return "merged";
}

export function featureBranch(item: string) {
	if (!/^i_[a-z0-9]+$/.test(item)) throw new Error("Invalid feature identity.");
	return "windlass/feature-" + item;
}

export function subtaskBranch(feature: string, key: string, child: string) {
	if (!/^[a-z][a-z0-9_-]{0,31}$/.test(key) || !/^i_[a-z0-9]+$/.test(child))
		throw new Error("Invalid subtask identity.");
	// A revised plan may reuse a key. Its new session must never overwrite the old branch.
	return featureBranch(feature) + "-" + key + "-" + child;
}

const obj = (v: unknown) => (v ?? {}) as Record<string, unknown>;
function sha(v: unknown) {
	if (typeof v !== "string" || !/^[0-9a-f]{40}$/.test(v))
		throw new Error("GitHub did not identify the requested commit.");
	return v;
}
export async function refHead(app: GithubApp, token: string, owner: string, repo: string, ref: string) {
	const path = "/repos/" + owner + "/" + repo + "/git/ref/heads/" + ref.split("/").map(encodeURIComponent).join("/");
	const { body } = await app.call({ path, auth: { bearer: token }, what: "read the branch commit" });
	return sha(obj(obj(body).object).sha);
}
/** Commits reachable from the base branch but absent from this item's exact pushed head. */
export async function commitsBehindBase(
	app: GithubApp,
	token: string,
	owner: string,
	repo: string,
	base: string,
	head: string,
): Promise<number> {
	return (await compareBranches(app, token, owner, repo, base, sha(head))).behind;
}

/** Read both live refs in one comparison. The base SHA identifies which tip a part was offered. */
export async function compareBranches(
	app: GithubApp,
	token: string,
	owner: string,
	repo: string,
	base: string,
	head: string,
) {
	const path = `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
	const { body } = await app.call({
		path,
		query: { per_page: 1 },
		auth: { bearer: token },
		what: "compare the item with its base branch",
	});
	const behind = obj(body).behind_by;
	if (typeof behind !== "number" || !Number.isSafeInteger(behind) || behind < 0)
		throw new Error("GitHub did not report how far the base branch is ahead.");
	return {
		behind,
		base: sha(obj(obj(body).base_commit).sha),
		files: obj(body).files as { filename: string; previous_filename?: string }[] | undefined,
	};
}

export async function advanceFeatureRef(
	app: GithubApp,
	token: string,
	owner: string,
	repo: string,
	id: string,
	base: string,
	head: string,
	title: string,
) {
	const branch = featureBranch(id);
	if (branch === base) throw new Error("The feature branch must differ from the destination.");
	const path = "/repos/" + owner + "/" + repo + "/git/refs/heads/" + branch;
	const auth = { bearer: token };
	try {
		const { body } = await app.call({
			method: "PATCH",
			path,
			auth,
			body: { sha: sha(head), force: false },
			what: "fast-forward the feature branch",
		});
		if (sha(obj(obj(body).object).sha) !== head) throw new Error("GitHub did not confirm the fast-forward.");
		return head;
	} catch (error) {
		if (!(error instanceof GithubError && [409, 422].includes(error.status) && /fast.forward/i.test(error.said)))
			throw error;
	}
	return mergeIntoFeature(app, token, owner, repo, id, head, "Integrate " + title);
}

/** Both writers hold the feature actor’s join grant until this exact commit has a receipt. */
export async function mergeIntoFeature(
	app: GithubApp,
	token: string,
	owner: string,
	repo: string,
	id: string,
	head: string,
	message: string,
) {
	const branch = featureBranch(id),
		auth = { bearer: token };
	const merged = await app.call({
		method: "POST",
		path: "/repos/" + owner + "/" + repo + "/merges",
		auth,
		body: { base: branch, head: sha(head), commit_message: message },
		what: "merge into the feature branch",
	});
	// A retry after GitHub accepted the merge but the parent did not record its receipt.
	return merged.status === 204 ? refHead(app, token, owner, repo, branch) : sha(obj(merged.body).sha);
}

/**
 * One empty marker commit gives the draft PR a distinct head. Fixed identity, date and parent make retries identical.
 * `draftOnly` (a cross-repo feature): a repository without draft PRs refuses the feature instead of getting an ordinary PR.
 */
export async function openFeature(
	app: GithubApp,
	token: string,
	owner: string,
	repo: string,
	input: {
		id: string;
		title: string;
		base: string;
		seed: string;
		created: number;
		body: string;
		author: { name: string; email: string };
		draftOnly?: boolean;
	},
) {
	const branch = featureBranch(input.id),
		root = "/repos/" + owner + "/" + repo,
		auth = { bearer: token };
	if (branch === input.base) throw new Error("The feature branch must differ from the destination.");
	const commit = await app.call({
		path: root + "/git/commits/" + sha(input.seed),
		auth,
		what: "read the feature base tree",
	});
	const tree = sha(obj(obj(commit.body).tree).sha);
	const author = { ...input.author, date: new Date(input.created).toISOString() };
	const marker = await app.call({
		method: "POST",
		path: root + "/git/commits",
		auth,
		body: { tree, parents: [input.seed], author, committer: author, message: "Start " + input.title },
		what: "create the feature start commit",
	});
	const head = sha(obj(marker.body).sha);
	try {
		await app.call({
			method: "POST",
			path: root + "/git/refs",
			auth,
			body: { ref: "refs/heads/" + branch, sha: head },
			what: "create the feature branch",
		});
	} catch (e) {
		if (!(e instanceof GithubError && e.status === 422) || (await refHead(app, token, owner, repo, branch)) !== head)
			throw e;
	}
	let pull = await app.openPull(token, owner, repo, branch, input.base);
	if (!pull) {
		const fields = { title: input.title, body: input.body, head: branch, base: input.base };
		try {
			pull = await app.createPull(token, owner, repo, { ...fields, draft: true });
		} catch (error) {
			if (
				!(
					error instanceof GithubError &&
					error.status === 422 &&
					/(?:^|: )draft pull requests are not supported in this repository\.?$/i.test(error.said)
				)
			)
				throw error;
			if (input.draftOnly)
				throw new GithubError(
					422,
					`draft pull requests are not supported in ${owner}/${repo}, and a cross-repo feature's pull requests must be drafts`,
					"open the feature PR",
				);
			pull = await app.createPull(token, owner, repo, {
				...fields,
				draft: false,
				body: fields.body + "\n\nFeature in progress.",
			});
		}
	}
	if (pull.headSha !== head || pull.base !== input.base) throw new Error("The feature PR changed during creation.");
	return { head, pr: { number: pull.number, url: pull.url } };
}

/**
 * Marks the draft feature PR ready for review; nothing to do once it is not a draft (the person may have marked it).
 * The token needs Contents write besides Pull requests write: GitHub refuses the mutation to a token with Pull requests
 * write alone ("Resource not accessible by integration"). There is no REST way: the pull request update ignores `draft`.
 * A refusal throws a `GraphqlRefusal` with GitHub's reason.
 */
export async function readyFeature(
	app: GithubApp,
	token: string,
	owner: string,
	repo: string,
	number: number,
	id: string,
) {
	const auth = { bearer: token };
	const { body } = await app.call({
		path: `/repos/${owner}/${repo}/pulls/${number}`,
		auth,
		what: "read the feature pull request",
	});
	if (obj(obj(body).head).ref !== featureBranch(id))
		throw new Error("The pull request no longer belongs to the feature branch.");
	if (!obj(body).draft) return;
	const path = app.settings.apiUrl.endsWith("/api/v3") ? "/../graphql" : "/graphql";
	const result = await app.call({
		method: "POST",
		path,
		auth,
		what: "mark the feature PR ready for review",
		body: {
			query:
				"mutation($id:ID!){ markPullRequestReadyForReview(input:{pullRequestId:$id}) { pullRequest { isDraft } } }",
			variables: { id: obj(body).node_id },
		},
	});
	if (obj(obj(obj(obj(result.body).data).markPullRequestReadyForReview).pullRequest).isDraft !== false)
		throw new GraphqlRefusal(
			"mark the PR ready for review",
			result.body,
			"GitHub did not confirm the PR is ready for review.",
		);
}
