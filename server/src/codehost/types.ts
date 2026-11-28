import type { GithubRepositoryList, PublishMessage, PullRequestInfo, Verified } from "../contract.js";
import type { CiReading, CiTarget, RerunnableJob } from "./ci.js";

export interface Pull {
	number: number;
	url: string;
	state: PullRequestInfo["state"];
	mergeable: boolean | null;
	mergedByApp?: true;
	title: string;
	body: string;
	head: string;
	headSha: string;
	base: string;
	baseSha: string;
	mergeBaseSha?: string;
	requestedReviewers: string[];
}

interface Comment {
	id: string | null;
	body: string;
	author: string;
	person: { id: number | string; login: string } | null;
	association: string;
}

interface PublishEvidence {
	machine?: { name: string | null } | null;
	verified: Verified | null;
	during: number | null;
	checks: ReadonlyArray<{ name: string; command: string }>;
	redact: (text: string) => string;
}

/** API access for a token the platform keeps in this process. Git in a sandbox takes a `GitCredential` instead. */
export type Access = "pull:read" | "pull:write" | "merge" | "comment:read" | "comment:write" | "log:read";

/** What a sandbox's Git may do with a credential: clone and fetch, or push too. */
export type GitAccess = "read" | "write";

/**
 * A credential for Git over HTTPS that a sandbox may hold for one operation: limited to one repository and to
 * `access`, short-lived, and revoked when the operation ends (`withGitCredential`). Never the owner's own grant.
 */
export interface GitCredential {
	token: string;
	/** The HTTPS user name the host expects with the token. */
	username: "oauth2" | "x-access-token";
	/** Revokes the credential. Never throws: one that could not be revoked runs out at its expiry. */
	revoke(): Promise<void>;
}

/** Connection, stored repository and trimmed delivery are the provider's actor-boundary types. */
export interface CodeHost<Connection, StoredRepo, Delivery> {
	cloneUrl(owner: string, name: string): string;
	pushUrl(owner: string, name: string): string;
	/** A token for API calls the platform makes itself. It never enters a sandbox: Git there takes `gitCredential`. */
	withToken<T>(
		target: Pick<CiTarget, "installationId" | "repositoryId">,
		access: Access,
		step: (token: string) => Promise<T>,
	): Promise<T>;
	/**
	 * A Git credential for one repository, limited to `access`, for a sandbox's clone, fetch or push. Throws
	 * `GitCredentialRefused` when the host will not make one; the caller never falls back to a broader grant.
	 */
	gitCredential(target: Pick<CiTarget, "installationId" | "repositoryId">, access: GitAccess): Promise<GitCredential>;

	openPull(
		token: string,
		owner: string,
		name: string,
		input: { title: string; body: string; head: string; base: string; draft?: boolean },
	): Promise<Pull>;
	openFromPushed(input: {
		connection: Connection | null;
		repository: StoredRepo;
		branch: string;
		message: PublishMessage;
		evidence: PublishEvidence;
	}): Promise<PullRequestInfo>;
	readPull(token: string, owner: string, name: string, number: number): Promise<Pull>;
	updatePull(
		token: string,
		owner: string,
		name: string,
		number: number,
		input: { title: string; body: string },
	): Promise<Pull>;
	mergePull(token: string, owner: string, name: string, number: number, head: string, title: string): Promise<void>;
	closePull(token: string, owner: string, name: string, number: number): Promise<void>;
	/** Whether the repository has the branch now. Only "no such branch" is false; any other refusal is thrown. */
	hasBranch(token: string, owner: string, name: string, branch: string): Promise<boolean>;

	/** Aggregate the head's checks, statuses, workflow runs and bounded failure logs. */
	/** `pull`: the pull or merge request whose pipelines may also have run the head (GitLab's merge request pipelines). */
	readCi(
		target: CiTarget,
		options?: { baseResultsOnly?: boolean; since?: number; branch?: string; pull?: number },
	): Promise<CiReading>;
	jobLog(token: string, owner: string, name: string, jobId: string): Promise<Response>;
	rerunJobs(target: CiTarget, jobs: RerunnableJob[]): Promise<{ accepted: string[]; said: string }>;

	listComments(
		token: string,
		owner: string,
		name: string,
		number: number,
		requireComplete?: boolean,
		since?: number,
	): Promise<Comment[]>;
	createComment(token: string, owner: string, name: string, number: number, body: string): Promise<string | null>;
	updateComment(token: string, owner: string, name: string, id: string, body: string): Promise<void>;
	react(
		token: string,
		repository: { owner: string; name: string },
		target: { kind: "issue" | "issue_comment" | "review_comment"; id: string },
		content: "eyes",
	): Promise<void>;

	/** Authenticate original bytes before decoding; null means signed but not actionable. */
	parseWebhook(headers: Headers, bytes: Uint8Array): Delivery | null;
	webhookRoute(request: Request): Promise<Response | null>;
	listRepositories(connection: Connection, query: string): Promise<GithubRepositoryList>;
}
