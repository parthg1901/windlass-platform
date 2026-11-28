import { VERIFIED_NAME } from "./checks.js";
import type { GithubId } from "../contract.js";
import { decimalId, githubId, ownApp } from "./ids.js";
import { sourceCaps } from "../sources/registry.js";

/** The edge keeps just the inputs to a later lookup. GUID and receipt time come from the route. */
type Sender = { id: GithubId; login: string; association: string };
type InstallationSender = { senderId: GithubId | null };
type Fields = {
	issues: { issue: number; sender: Sender; label?: string };
	issue_comment: { issue: number; sender: Sender; commentId: string; body: string; isPullRequest: boolean };
	pull_request: { pr: number; head: string; base?: string; merged: boolean; setupGuides?: true; toDefault?: true };
	/** A push to the repository's default branch, for its prepared environments (environments.ts). */
	push: { head: string; base?: string };
	pull_request_review: { pr: number; reviewId: string; state: string; body: string; commitId: string; sender: Sender };
	pull_request_review_comment: {
		pr: number;
		commentId: string;
		body: string;
		path: string;
		line: number | null;
		commitId: string;
		sender: Sender;
	};
	check_run: { head: string; runId?: string };
	check_suite: { head: string };
	status: { head: string };
	installation: InstallationSender;
	installation_repositories: InstallationSender;
};

type Trimmed = { action: string; installationId: GithubId; repositoryId: GithubId | null } & {
	[E in keyof Fields]: { event: E; data: Fields[E] };
}[keyof Fields];

type Receipt = { guid: string; at: number };
export type Delivery = Trimmed & Receipt;

const obj = (v: unknown): Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown) => (typeof v === "string" ? v : "");
const id = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);
const sha = (v: unknown) => (typeof v === "string" && /^[a-f\d]{40}$/i.test(v) ? v : "");
const cut = (s: string) => (s.length > 16_000 ? s.slice(0, 15_999) + "…" : s);

/** Actor keys use the canonical decimal spelling of a positive GitHub id. */
export function githubIdKey(key: string[]): boolean {
	return key.length === 1 && githubId(key[0]) !== null;
}

/** null means unaddressed; an address by itself has an empty note. */
export function isAddressed(body: string, slug: string): string | null {
	const words = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body.trimStart());
	const address = words?.[1].toLowerCase();
	return address === "@" + slug.toLowerCase() || address === "/windlass" ? (words?.[2] ?? "") : null;
}

export function edge(
	event: string,
	payload: unknown,
	meta: { slug: string; appId?: string } & Receipt,
): Delivery | null;
export function edge(event: string, payload: unknown, meta: { slug: string; appId?: string }): Trimmed | null;
export function edge(
	event: string,
	payload: unknown,
	meta: { slug: string; appId?: string } & Partial<Receipt>,
): Trimmed | null {
	const p = obj(payload);
	const installationId = githubId(obj(p.installation).id);
	if (!installationId) return null;
	const repositoryId = githubId(obj(p.repository).id);
	const action = str(p.action);
	// Action names are also log fields. Never let arbitrary JSON text into them.
	if (event !== "status" && event !== "push" && !/^[a-z_]{1,64}$/.test(action)) return null;
	const base = {
		...("guid" in meta ? { guid: meta.guid, at: meta.at } : {}),
		installationId,
		repositoryId,
		action: event === "status" || event === "push" ? "" : action,
	};
	if (event === "installation" || event === "installation_repositories") {
		// The HMAC authenticates the body. The event-name header alone cannot make a comment
		// or another repository event an installation change.
		if (event === "installation" && !githubId(obj(obj(p.installation).account).id)) return null;
		if (
			event === "installation_repositories" &&
			!Array.isArray(p.repositories_added) &&
			!Array.isArray(p.repositories_removed)
		)
			return null;
		return { ...base, event, data: { senderId: githubId(obj(p.sender).id) } };
	}
	if (!repositoryId) return null;
	if (event === "check_run" || event === "check_suite") {
		const check = obj(p[event]);
		const head = sha(check.head_sha);
		if (ownApp(obj(check.app), meta)) {
			const runId = decimalId(check.id);
			return event === "check_run" &&
				action === "rerequested" &&
				check.name === VERIFIED_NAME &&
				head &&
				runId &&
				!runId.startsWith("0")
				? { ...base, event, data: { head, runId } }
				: null;
		}
		return action === "completed" && head ? { ...base, event, data: { head } } : null;
	}
	if (event === "push") {
		// Only the default branch moving matters, and not its deletion.
		const branch = str(obj(p.repository).default_branch);
		const head = sha(p.after);
		const before = sha(p.before);
		return branch && p.ref === "refs/heads/" + branch && p.deleted !== true && head && !/^0+$/.test(head)
			? { ...base, event, data: { head, ...(before && !/^0+$/.test(before) && { base: before }) } }
			: null;
	}
	if (event === "status") {
		const head = sha(p.sha);
		return head && ["error", "failure", "success"].includes(str(p.state)) ? { ...base, event, data: { head } } : null;
	}
	const pull = obj(p.pull_request);
	const pr = id(pull.number) ?? id(p.number);
	if (event === "pull_request") {
		const head = sha(obj(pull.head).sha);
		const target = sha(obj(pull.base).sha);
		return pr &&
			head &&
			typeof pull.merged === "boolean" &&
			(["closed", "reopened", "synchronize", "ready_for_review"].includes(action) || (action === "opened" && target))
			? {
					...base,
					event,
					data: {
						pr,
						head,
						// Ready for review changes no commit: it only wakes the item's pull request poll, not the setup guide check.
						...(target && action !== "ready_for_review" && { base: target }),
						merged: pull.merged,
						...(action === "closed" &&
							/^windlass\/repo-setup-\d{8}$/.test(str(obj(pull.head).ref)) && { setupGuides: true as const }),
						...(pull.merged === true &&
							action === "closed" &&
							str(obj(pull.base).ref) !== "" &&
							str(obj(pull.base).ref) === str(obj(p.repository).default_branch) && { toDefault: true as const }),
					},
				}
			: null;
	}
	const author = obj(p.sender);
	const userId = githubId(author.id);
	const login = str(author.login);
	if (!userId || !login || author.type === "Bot") return null;
	const issue = obj(p.issue);
	const subject = event === "issues" ? issue : obj(event === "pull_request_review" ? p.review : p.comment);
	// An issue author's association does not attest to a different person who applied a label.
	const sameAuthor = event !== "issues" || githubId(obj(issue.user).id) === userId;
	const sender = { id: userId, login, association: sameAuthor ? str(subject.author_association) || "NONE" : "NONE" };
	const n = id(issue.number);
	if (event === "issues" && n) {
		const label = str(obj(p.label).name);
		if (
			["labeled", "unlabeled"].includes(action) &&
			["windlass", "windlass:orchestrate", ...sourceCaps("github").quickLabels].includes(label)
		)
			return { ...base, event, data: { issue: n, sender, ...(label !== "windlass" && { label }) } };
		if (["closed", "reopened", "edited", "deleted", "transferred"].includes(action))
			return { ...base, event, data: { issue: n, sender } };
	}
	const commentId = decimalId(subject.id);
	if (!commentId || commentId === "0") return null;
	const body = str(subject.body);
	const addressed = isAddressed(body, meta.slug) !== null;
	if (event === "issue_comment" && action === "created" && addressed && n)
		return {
			...base,
			event,
			data: { issue: n, commentId, body: cut(body), sender, isPullRequest: !!issue.pull_request },
		};
	const commitId = sha(subject.commit_id);
	if (!pr || !commitId) return null;
	const state = str(subject.state).toLowerCase();
	if (
		event === "pull_request_review" &&
		action === "submitted" &&
		(state === "approved" || state === "changes_requested" || addressed)
	)
		return { ...base, event, data: { pr, reviewId: commentId, state, body: cut(body), commitId, sender } };
	if (event === "pull_request_review_comment" && action === "created" && addressed && typeof subject.path === "string")
		return {
			...base,
			event,
			data: { pr, commentId, body: cut(body), path: subject.path, line: id(subject.line), commitId, sender },
		};
	return null;
}
