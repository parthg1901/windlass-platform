import { networkBody } from "../blocked-network.js";
import type { BlockedNetwork } from "../contract.js";
import { mirrorOwner } from "../sandbox/git-mirrors.js";
import type { GithubId, PublishMessage, PullRequestInfo, SessionRepository, Verified } from "../contract.js";
import type { SandboxHandle } from "../sandbox/api.js";
import { type WorkDiff, verifiedSection, verifiedWords, withVerifiedSection, workFlags } from "../verified.js";
import { type GithubApp, GithubError, type Pull, type Repository } from "./app.js";
import {
	CLONE_MINUTES,
	type GitOutcome,
	checkoutWork,
	cloneWithToken,
	hasMirror,
	saveMirrorAfterClone,
	commitWork,
	mergeBaseForCi,
	outgoingPatch,
	unsafeWorkspace,
	discardHandover,
	fetchWithToken,
	probeWork,
	pushWithToken,
	readWork,
} from "./git.js";
import { withGitCredential } from "../codehost/credential.js";
import { refHead } from "./feature.js";
import { outgoingCredentials, redact } from "./redact.js";
import {
	GithubProblem,
	NOT_CONNECTED,
	type StoredConnection,
	problemOf,
	resolveBoundRepository,
	resolveRepository,
} from "./repos.js";

/** What a session keeps of the repository it was launched on. */
export interface StoredRepository extends SessionRepository {
	/** Base of the last successful clone or fetch, confirmed outside the sandbox. */
	baseSha?: string | null;
	/** Set only by issue intake, outside the agent's publish message. */
	closesIssue?: number;
	/** The installation that covered it when the session was made. A hint: the connection is asked again each time. */
	installationId: GithubId;
}

export function sessionRepository(
	app: GithubApp,
	connection: StoredConnection,
	repo: StoredRepository,
	need: "read" | "write",
) {
	if (repo.provider === "gitlab")
		throw new GithubProblem("github_failed", "This operation requires a GitHub repository.");
	return repo.closesIssue
		? resolveBoundRepository(app, connection, repo.id, repo.installationId, need)
		: resolveRepository(app, connection, repo.id, need);
}

function pullBody(
	repo: StoredRepository,
	body: string,
	section: string | null,
	blocked?: BlockedNetwork,
	showHosts = false,
) {
	const describe = (text: string) => {
		const description = networkBody(text, blocked, showHosts);
		return section === null ? description : withVerifiedSection(description, section);
	};
	if (!repo.closesIssue) return describe(body);
	const footer = `\n\nCloses #${repo.closesIssue}.`;
	const text = body.trimEnd();
	return describe(text.endsWith(footer) ? text.slice(0, -footer.length) : text) + footer;
}

const fullName = (repository: { owner: string; name: string }) => `${repository.owner}/${repository.name}`;

/** The address GitHub credits a user's commits by, when the user keeps their own private. */
export function authorOf(connection: StoredConnection): { name: string; email: string } {
	return {
		name: connection.user.login,
		email: `${connection.user.id}+${connection.user.login}@users.noreply.github.com`,
	};
}

/** What a clone or a push that failed means for the user. */
function gitProblem(
	outcome: GitOutcome,
	what: "clone" | "push",
	repository: string,
	account: string,
	branch: string,
): GithubProblem {
	const said = outcome.said ? ` Git said: ${outcome.said}` : "";
	switch (outcome.failure) {
		case "gone":
			return new GithubProblem(
				"github_gone",
				`${repository} is no longer on GitHub, or the GitHub App can no longer see it. Check that the repository exists and that the app's installation on ${account} still includes it.`,
			);
		case "denied":
			return new GithubProblem(
				"github_denied",
				what === "push"
					? `GitHub did not let the GitHub App push to ${repository}. Its installation on ${account} needs the permission "Contents: read and write"; if it has it, the repository's own rules keep the app out.`
					: `GitHub did not let the GitHub App read ${repository}. Check that its installation on ${account} still includes the repository.`,
			);
		case "protected":
			return new GithubProblem(
				"github_denied",
				`GitHub refused the push: a rule of ${repository} protects branches named like ${branch}. Let the GitHub App create such branches in the repository's branch rules, then push again.`,
			);
		case "workflow":
			return new GithubProblem(
				"github_denied",
				`GitHub refused the push because it changes a workflow file under .github/workflows, which the GitHub App is not allowed to do. Take that change out, or make it yourself.`,
			);
		case "diverged":
			return new GithubProblem(
				"github_failed",
				`The branch ${branch} at GitHub has commits this workspace does not have, so the push was refused rather than overwrite them. If the agent rebased the branch, have the agent push it: its own push may replace what the platform pushed before. A commit anyone else pushed is never overwritten: delete the branch at GitHub to start it again from the workspace.`,
			);
		case "no_branch":
			return new GithubProblem("github_gone", `${repository} has no branch ${branch} any more.`);
		case "unreachable":
			return new GithubProblem(
				"github_unreachable",
				`GitHub could not be reached from the sandbox.${said} Try again in a moment.`,
			);
		case "timeout":
			// Said as GitHub out of reach: trying again later is what cures it (an item's publish step does, by itself).
			return new GithubProblem(
				"github_unreachable",
				what === "clone"
					? `Cloning ${repository} took longer than ${CLONE_MINUTES} minutes and was stopped.`
					: `Pushing to ${repository} took too long and was stopped, so whether GitHub got it is not known. Push again: a push of what GitHub already has pushes nothing.`,
			);
		default:
			return new GithubProblem(
				"github_failed",
				`${what === "clone" ? `Cloning ${repository}` : `Pushing to ${repository}`} failed.${said}`,
			);
	}
}

/** Only a base confirmed by GitHub may exclude history. A branch that moves during
 * the operation requires a new observation before publication. */
async function confirmBase(
	app: GithubApp,
	token: string,
	repo: StoredRepository,
	remote: Repository,
	outcome: GitOutcome,
	pinnedBase?: string,
) {
	if (outcome.ok) {
		const observed = outcome.marks.get("base");
		const trusted =
			pinnedBase ??
			(observed ? await refHead(app, token, remote.owner, remote.name, repo.branch).catch(() => null) : null);
		repo.baseSha = trusted === observed ? trusted : null;
	}
	return outcome;
}

/** Where setup runs and which fetched commit to restore after it. */
export interface Cloned {
	/** Fetched work commit for checkout after setup. For a deleted subtask branch this is the feature tip. */
	workAt: string | null;
	/** GitHub no longer has the requested work branch. A subtask can resume on the feature branch. */
	workGone: boolean;
	/** Where the clone is, relative to the workspace: "." unless the workspace already held something. */
	directory: string;
}

/**
 * Clones the session's repository into its new sandbox. Resolves with `false` when it was aborted,
 * and throws GithubProblem when it could not be done. The token is good for reading this one
 * repository, and is revoked when the clone has ended. `work` names the branch the session's work was
 * pushed to, for a sandbox made in place of a lost one: the clone says at which commit GitHub has it
 * (`workAt`), and the workspace stays on the base until `putOnWork`, after the setup command.
 */
export async function cloneRepository(
	app: GithubApp,
	connection: StoredConnection | null,
	repository: StoredRepository,
	sandbox: SandboxHandle,
	signal?: AbortSignal,
	work?: string,
	pinnedBase?: string,
	uid?: string,
): Promise<Cloned | false> {
	if (!connection) throw new GithubProblem("github_gone", NOT_CONNECTED);
	const resolved = await sessionRepository(app, connection, repository, "read");
	const name = fullName(resolved.repository);
	const account = resolved.installation.account.login;
	let outcome: GitOutcome;
	try {
		const owner = uid && sandbox.profile.startsWith("docker-") ? mirrorOwner(uid, String(repository.id)) : undefined;
		const attempt = (reference: boolean, repair = false) =>
			withGitCredential(
				{ gitCredential: access => app.gitCredential(resolved.installation.id, repository.id, access) },
				"read",
				async ({ token, username }) => {
					const clone = await cloneWithToken(sandbox, token, {
						url: app.cloneUrl(resolved.repository.owner, resolved.repository.name),
						branch: repository.branch,
						directory: resolved.repository.name,
						work,
						signal,
						pinnedBase,
						mirror: owner ? { owner, reference, repair } : undefined,
						username,
					});
					return confirmBase(
						app,
						token,
						repository,
						resolved.repository,
						clone,
						work === undefined ? pinnedBase : undefined,
					);
				},
			);
		outcome = await attempt(!!owner && (await hasMirror(sandbox, owner, signal)));
		if (outcome.failure === "mirror" && !signal?.aborted) outcome = await attempt(false, true);
		// Only a clone whose base GitHub confirmed seeds the slot.
		saveMirrorAfterClone(
			sandbox,
			outcome.ok && repository.baseSha && !signal?.aborted ? outcome : { ...outcome, ok: false },
		);
	} catch (error) {
		throw problemOf(error, account, name);
	}
	if (outcome.failure === "aborted" || signal?.aborted) return false;
	if (!outcome.ok) throw gitProblem(outcome, "clone", name, account, repository.branch);
	return {
		workAt: outcome.marks.get("haswork") || null,
		workGone: outcome.marks.has("nowork"),
		directory: outcome.marks.get("dir") || ".",
	};
}

/**
 * Puts the clone in `directory` on the session's branch `work`, once the setup command has run on the
 * base (git.ts `workCheckoutScript`); resolves with the commit it is on. Throws when git could not.
 */
export async function putOnWork(
	sandbox: SandboxHandle,
	directory: string,
	work: string,
	start?: string,
): Promise<string> {
	const outcome = await checkoutWork(sandbox, directory, work, start);
	const unsafe = outcome.marks.get("unsafe");
	if (unsafe !== undefined) throw new Error(unsafeWorkspace(unsafe));
	const head = outcome.marks.get("work") || "";
	if (!outcome.ok || !/^[0-9a-f]{40,64}$/.test(head))
		throw new Error(`the workspace could not be put on ${work}${outcome.said ? `: ${outcome.said}` : ""}`);
	return head;
}

/** What a pull request's description is to say was verified, as the session holds it (verified.ts). */
export interface PublishEvidence {
	machine?: { name: string | null } | null;
	/** What the session's work rests on; null when no turn of the session has ended. */
	verified: Verified | null;
	/** The turn that is running while this is published, whose checks have not run; null between turns. */
	during: number | null;
	/** The user's checks as they are saved now: what their commands run is looked at among the changes. */
	checks: ReadonlyArray<{ name: string; command: string }>;
	/** Takes the saved secrets of the session's repository and account out of the section. */
	redact: (text: string) => string;
}

/**
 * The section for a pull request and the few words kept with it. `work` is what git says of the
 * changes that are pushed, null when it did not say: then nothing was looked for in them, and the
 * section says so. The section leaves through both redactions: the saved secrets, by value, and
 * whatever looks like a credential.
 */
export function evidenceSection(
	evidence: PublishEvidence,
	work: WorkDiff | null,
	login: string,
): { section: string; words: string } {
	const flags = work === null ? null : workFlags(work, [...evidence.checks, ...(evidence.verified?.run?.checks ?? [])]);
	const clean = (text: string) => redact(evidence.redact(text));
	// Remove secrets from the raw name before Markdown quoting can split a saved value.
	const machine = evidence.machine?.name ? { name: clean(evidence.machine.name) } : (evidence.machine ?? undefined);
	return {
		section: clean(verifiedSection({ verified: evidence.verified, flags, during: evidence.during, login, machine })),
		words: verifiedWords(evidence.verified, flags ?? [], evidence.during),
	};
}

export interface PushInput {
	app: GithubApp;
	/** The user's connection as their actor has it now; null when there is none. */
	connection: StoredConnection | null;
	repository: StoredRepository;
	sandbox: SandboxHandle;
	sessionId: string;
	/** The branch the work goes to. */
	branch: string;
	/** The commit the platform last pushed to the branch, if it pushed before. */
	pushed: string | null;
	/**
	 * The commit the platform itself last pushed to the branch: a push refused as no fast-forward may
	 * replace it, and only it (git.ts `pushScript`'s lease), for a branch the agent rebased. Not
	 * `pushed`, which may be a commit someone else pushed, taken in when a sandbox was replaced. Absent,
	 * a branch that moved is never overwritten (the panel's push).
	 */
	lease?: string | null;
	/** Takes the saved secrets of the session's repository and account out of text: what it would change is not pushed. */
	redact?: (text: string) => string;
}

/** What `pushWork` did. */
export interface Pushed {
	/** The push arrived but the local refs or index could not be synchronized. */
	workspaceChanged?: boolean;
	/** True when something was pushed; false when GitHub had everything in the workspace already. */
	pushed: boolean;
	/** True when the push replaced the platform's own last push (a rebased branch). */
	forced: boolean;
	/** The branch's commit at GitHub now, when git said which. */
	head: string | null;
	/** How many files the platform's commit holds; 0 when the agent had committed everything itself; null when git did not say. */
	committedFiles: number | null;
}

export interface PublishInput extends PushInput {
	privateBody?: string;
	blockedNetwork?: BlockedNetwork;
	/** The pull request the session has, if any. */
	pull: PullRequestInfo | null;
	message: PublishMessage;
	/** What the pull request's description says was verified. */
	evidence: PublishEvidence | null;
	/**
	 * The request is the agent's (agent-publish.ts), which writes the pull request's title and description:
	 * a pull request that is open already is given them too, where they differ from what it has, and
	 * a request with nothing to push may still do that.
	 */
	retitle?: boolean;
	/**
	 * With `retitle`: a pull request that is open already keeps the title it has at GitHub, which its first push gave it or its
	 * person wrote since; only its description is given anew. A work item's later turns report on their own part of the
	 * work, and the last one's title would name only that part.
	 */
	keepTitle?: boolean;
	/**
	 * The caller wants the pull request to show the work, and a push only where one is needed: a work
	 * item's step, after its agent may have pushed everything itself (`push`). With nothing new to push
	 * and the pull request open, its section is written again instead of the push being refused.
	 */
	shownIsEnough?: boolean;
}

export interface Published {
	pull: PullRequestInfo;
	/** True when this run opened the pull request. */
	opened: boolean;
	/** True when this run pushed something to the branch. */
	pushed: boolean;
	/** True when this run gave a pull request that was open already another title or description. */
	retitled: boolean;
	/** The branch's commit at GitHub now, when git said which. */
	head: string | null;
	/** How many files the platform's commit holds; 0 when the agent had committed everything itself; null when git did not say. */
	committedFiles: number | null;
}

/** Thrown when the push went through and the pull request did not: the commit is at GitHub, so the caller keeps it. */
export class PullProblem extends GithubProblem {
	constructor(
		problem: GithubProblem,
		readonly head: string | null,
	) {
		super(problem.code, problem.message);
	}
}

export function infoOf(pull: Pull, pushedAt: number, verified: string): PullRequestInfo {
	return {
		number: pull.number,
		url: pull.url,
		state: pull.state,
		title: pull.title,
		branch: pull.head,
		base: pull.base,
		pushedAt,
		verified,
	};
}

const isOpen = (pull: PullRequestInfo | null): pull is PullRequestInfo =>
	pull !== null && (pull.state === "open" || pull.state === "draft");

function commitMessage(message: PublishMessage): string {
	const own = message.commit?.trim() ?? "";
	if (own !== "") return own;
	const body = message.body.trim();
	return body === "" ? message.title.trim() : `${message.title.trim()}\n\n${body}`;
}

/**
 * Commits what is uncommitted with `message` and pushes the session's branch, and nothing else: no pull
 * request is opened or changed. The agent's `push`; `publishWork` pushes with it too, so there is one
 * way the platform pushes. Asks GitHub first whether the user may push. Throws GithubProblem.
 */
export async function pushWork(input: PushInput, message: string): Promise<Pushed> {
	if (!input.connection) throw new GithubProblem("github_gone", NOT_CONNECTED);
	return commitAndPush(input, await sessionRepository(input.app, input.connection, input.repository, "write"), message);
}

export class BaseMergeConflict extends Error {}

/** Fetch at answer time. Only the exact merge of the polled head may go through the normal scanned push. */
export async function updateBranchFromBase(
	input: PushInput,
	update: { head: string; at: number; baseTip?: string },
): Promise<Pushed> {
	const { app, repository, branch, sandbox, connection } = input;
	if (!connection) throw new GithubProblem("github_gone", NOT_CONNECTED);
	const resolved = await sessionRepository(app, connection, repository, "write");
	const found = await fetchBase(app, connection, repository, sandbox, branch);
	if (!found || !repository.baseSha)
		throw new GithubProblem("github_unreachable", "The item branch or its current base could not be confirmed.");
	const merged = await mergeBaseForCi(
		sandbox,
		branch,
		repository.branch,
		update.baseTip ?? repository.baseSha,
		update.head,
		update.at,
		authorOf(connection),
	);
	if (merged.ok && merged.marks.has("conflict")) throw new BaseMergeConflict();
	const head = merged.marks.get("head");
	if (!merged.ok || !head)
		throw new GithubProblem("github_failed", `The base could not be merged into ${branch}. ${merged.said}`.trim());
	return commitAndPush(
		{ ...input, pushed: update.head, lease: null },
		resolved,
		`Merge ${repository.branch} into ${branch}`,
		head,
	);
}

async function commitAndPush(
	input: PushInput,
	resolved: Awaited<ReturnType<typeof resolveRepository>>,
	message: string,
	expectedHead?: string,
): Promise<Pushed> {
	const { app, repository, sandbox, branch } = input;
	const connection = input.connection as StoredConnection;
	const { installation } = resolved;
	const name = fullName(resolved.repository);
	const account = installation.account.login;
	// Older sessions have no actor-held base. A clone or fetch racing a remote change
	// can also leave it unknown. Recover from GitHub before deciding there is work.
	if (repository.baseSha == null) {
		try {
			repository.baseSha = await app.withToken(
				installation.id,
				{ repositoryId: repository.id, permissions: { metadata: "read", contents: "read" } },
				token => refHead(app, token, resolved.repository.owner, resolved.repository.name, repository.branch),
				{ revokeAfter: true },
			);
		} catch (error) {
			throw problemOf(error, account, name);
		}
	}
	return scannedPush(
		input,
		message,
		{
			author: authorOf(connection),
			push: attempt =>
				withGitCredential(
					{ gitCredential: access => app.gitCredential(installation.id, repository.id, access) },
					"write",
					({ token, username }) =>
						pushWithToken(sandbox, token, {
							attempt,
							url: app.cloneUrl(resolved.repository.owner, resolved.repository.name),
							branch,
							lease: input.lease ?? null,
							username,
						}),
				),
			problem: error => problemOf(error, account, name),
			failure: outcome => gitProblem(outcome, "push", name, account, branch),
		},
		expectedHead,
	);
}

/** Commit, scan and transfer the identical outgoing object range for either provider. */
export async function scannedPush(
	input: Omit<PushInput, "app" | "connection">,
	message: string,
	remote: {
		author: { name: string; email: string };
		push(attempt: Parameters<typeof pushWithToken>[2]["attempt"]): Promise<GitOutcome>;
		problem(error: unknown): Error;
		failure(outcome: GitOutcome): Error;
	},
	expectedHead?: string,
): Promise<Pushed> {
	const { sandbox, repository, branch } = input;
	const baseSha = repository.baseSha ?? null;
	const committed = await commitWork(
		sandbox,
		{ sessionId: input.sessionId, branch, baseSha, pushed: input.pushed, author: remote.author },
		message,
	);
	const unsafe = committed.marks.get("unsafe");
	if (unsafe !== undefined) throw new GithubProblem("github_failed", unsafeWorkspace(unsafe));
	if (!committed.ok) {
		if (committed.failure === "timeout")
			throw new GithubProblem(
				"github_failed",
				"Committing the workspace's changes took too long and was stopped. Try again.",
			);
		throw new GithubProblem(
			"github_failed",
			`The workspace's changes could not be committed.${committed.said ? ` Git said: ${committed.said}` : ""}`,
		);
	}
	if (committed.marks.has("norepo"))
		throw new GithubProblem(
			"github_failed",
			"The workspace is not a git repository any more, so there is nothing to push.",
		);
	const head = committed.marks.get("head") || null;
	if (expectedHead && head !== expectedHead) {
		await discardHandover(sandbox, committed.attempt);
		throw new GithubProblem("github_failed", "The workspace changed while updating the branch. Nothing was pushed.");
	}
	const count = Number(committed.marks.get("committed"));
	const committedFiles = committed.marks.has("committed") && Number.isInteger(count) ? count : null;
	if (committed.marks.has("nothing")) return { pushed: false, forced: false, head, committedFiles };

	// Nothing that holds the value of a saved secret leaves the sandbox: a setup command may have written one into a file,
	// and the agent's push is never asked about. The proposed commit stays private until the scan and push succeed.
	const patch = await outgoingPatch(sandbox, committed.attempt);
	let kinds: string[];
	try {
		kinds = patch === null ? [] : outgoingCredentials(patch, input.redact);
	} catch {
		await discardHandover(sandbox, committed.attempt);
		throw new GithubProblem(
			"github_failed",
			"Nothing was pushed. The outgoing commits could not be checked for credentials.",
		);
	}
	if (kinds.length) {
		await discardHandover(sandbox, committed.attempt);
		throw new GithubProblem(
			"github_failed",
			`Nothing was pushed. Remove the following credentials from the commits to push: ${kinds.join(", ")}.`,
		);
	}
	const leaking = secretFiles(patch, input.redact);
	if (leaking.files.length > 0) {
		await discardHandover(sandbox, committed.attempt);
		throw new GithubProblem("github_failed", secretRefusal(leaking));
	}

	let pushed: GitOutcome;
	try {
		pushed = await remote.push(committed.attempt);
	} catch (error) {
		// No token was to be had, so the push never ran: what the commit step left for it goes.
		await discardHandover(sandbox, committed.attempt);
		throw remote.problem(error);
	}
	if (!pushed.ok) {
		if (pushed.marks.has("changedrange"))
			throw new GithubProblem(
				"github_failed",
				"The outgoing objects no longer match the scanned commits. Nothing was pushed. Try again.",
			);
		if (pushed.marks.has("nohandover"))
			throw new GithubProblem("github_failed", "The commit to push could not be found in the sandbox. Try again.");
		if (pushed.marks.has("stale")) {
			throw new GithubProblem(
				"github_failed",
				`The branch ${branch} on the remote has commits someone else pushed since the platform's last push, so the push was refused rather than replace them. Fetch them (the agent's fetch_base brings origin/${branch} too), merge them into the workspace, and push again.`,
			);
		}
		throw remote.failure(pushed);
	}
	return {
		pushed: true,
		workspaceChanged: pushed.marks.has("workspacechanged"),
		forced: pushed.marks.has("forced"),
		head: pushed.marks.get("pushed") || head,
		committedFiles,
	};
}

/**
 * The files whose lines in `patch` (git log -p) hold a saved secret's value, and the secrets' names; with
 * no patch to read (git did not answer), every push is refused: what would be sent cannot be looked at.
 */
function secretFiles(patch: string | null, redact?: (text: string) => string): { files: string[]; names: string[] } {
	if (patch === null) return { files: ["(the commits to push could not be read)"], names: [] };
	if (!redact) return { files: [], names: [] };
	const files = new Set<string>();
	const names = new Set<string>();
	for (const part of patch.split(/\n(?=diff --git )/)) {
		const cleaned = redact(part);
		if (cleaned === part) continue;
		const path = /^diff --git a\/(.+?) b\//.exec(part)?.[1] ?? "(a commit's message)";
		files.add(redact(path));
		for (const match of cleaned.matchAll(/\[secret:([A-Za-z0-9_]+)\]/g))
			if (!part.includes(match[0])) names.add(match[1] as string);
	}
	return { files: [...files], names: [...names] };
}

/** Why a push was refused for a secret's value in what it would send. */
function secretRefusal(found: { files: string[]; names: string[] }): string {
	const files = found.files.join(", ");
	const names =
		found.names.length === 0
			? "a secret saved for this repository or account"
			: `the secret${found.names.length === 1 ? "" : "s"} ${found.names.join(", ")} saved for this repository or account`;
	return `Nothing was pushed: ${files} would have gone to GitHub with the value of ${names} in it. The platform's own commit was undone, so the change is in the workspace as it was. Take the value out (and out of any commit that has it), then push again.`;
}

/** A PullProblem retains the pushed head so a retry can finish publishing. */
export async function publishWork(input: PublishInput): Promise<Published> {
	const { app, connection, repository, sandbox, branch } = input;
	if (!connection) throw new GithubProblem("github_gone", NOT_CONNECTED);
	// Check the user’s write access before committing in their name.
	const resolved = await sessionRepository(app, connection, repository, "write");
	const { installation } = resolved;
	const name = fullName(resolved.repository);
	const account = installation.account.login;

	// Default the outgoing-commit scan to the PR redactor.
	const work = await commitAndPush(
		{ ...input, redact: input.redact ?? input.evidence?.redact },
		resolved,
		commitMessage(input.message),
	);
	if (work.workspaceChanged)
		throw new PullProblem(
			new GithubProblem(
				"github_failed",
				`GitHub has ${work.head} on ${branch}. The workspace Git state could not be synchronized after the push. Fetch and reconcile the branch before publishing again.`,
			),
			work.head,
		);
	const { pushed, head, committedFiles } = work;
	const open = isOpen(input.pull) ? input.pull : null;
	const nothingToPush = () =>
		new GithubProblem(
			"github_failed",
			`There is nothing to push: ${branch} at GitHub already has everything in the workspace.`,
		);
	if (!pushed && open && !input.retitle && !input.shownIsEnough) throw nothingToPush();
	if (!pushed && input.pushed === null)
		throw new GithubProblem(
			"github_failed",
			`There is nothing to open a pull request with: the workspace has no changes and no commit that ${repository.branch} does not have.`,
		);
	const said = input.evidence
		? evidenceSection(input.evidence, await readWork(sandbox, repository.baseSha ?? null), connection.user.login)
		: { section: null, words: "" };

	const now = Date.now();
	const title = input.message.title.trim();
	const published = (pull: Pull, at: number, outcome: "opened" | "retitled" | "kept"): Published => ({
		pull: infoOf(pull, at, said.words),
		opened: outcome === "opened",
		retitled: outcome === "retitled",
		pushed,
		head,
		committedFiles,
	});
	try {
		// GitHub requires contents:read to resolve both refs when opening a PR.
		return await app.withToken(
			installation.id,
			{ repositoryId: repository.id, permissions: { metadata: "read", contents: "read", pull_requests: "write" } },
			async (token): Promise<Published> => {
				const { owner, name: repo } = resolved.repository;
				// The installation listing used to find a repository can predate a visibility change.
				const isPrivate =
					(!!input.privateBody || !!input.blockedNetwork?.hosts.length) &&
					(await app.repositoryById(token, repository.id)).private;
				const body = pullBody(
					repository,
					(isPrivate && input.privateBody) || input.message.body,
					said.section,
					input.blockedNetwork,
					isPrivate,
				);
				if (open) {
					// It may have been merged or closed at GitHub since: then the push went to a branch with no pull request.
					const current = await app.pull(token, owner, repo, open.number).catch(() => null);
					if (current && (current.state === "open" || current.state === "draft")) {
						const at = pushed ? now : open.pushedAt;
						const titled = input.keepTitle ? current.title : title;
						if (input.retitle && (current.title !== titled || current.body.trim() !== body)) {
							const updated = await app.updatePull(token, owner, repo, current.number, { title: titled, body });
							return published(updated, at, "retitled");
						}
						if (!pushed && !input.shownIsEnough) throw nothingToPush();
						// A push from the panel leaves the description as it is at GitHub, where its user may have edited it, but for the section.
						const described = pullBody(repository, current.body, said.section);
						const kept =
							input.retitle || current.body.trim() === described
								? current
								: await app.updatePull(token, owner, repo, current.number, { title: current.title, body: described });
						return published(kept, at, "kept");
					}
					if (!pushed) throw nothingToPush();
				}
				try {
					const created = await app.createPull(token, owner, repo, {
						title,
						body,
						head: branch,
						base: repository.branch,
					});
					return published(created, now, "opened");
				} catch (error) {
					// One pull request per pair of branches: one that is open already is the session's.
					if (error instanceof GithubError && error.status === 422 && /already exists/i.test(error.said)) {
						const existing = await app.openPull(token, owner, repo, branch, repository.branch);
						if (existing) {
							const described =
								input.shownIsEnough && input.retitle
									? { title: input.keepTitle ? existing.title : title, body }
									: { title: existing.title, body: pullBody(repository, existing.body, said.section) };
							const kept =
								existing.title === described.title && existing.body.trim() === described.body
									? existing
									: await app.updatePull(token, owner, repo, existing.number, described);
							return published(kept, now, "kept");
						}
					}
					if (error instanceof GithubError && error.status === 422 && /no commits between/i.test(error.said)) {
						throw new GithubProblem(
							"github_failed",
							`GitHub opened no pull request: ${branch} has no commit that ${repository.branch} does not have.`,
						);
					}
					if (error instanceof GithubError && error.status === 422) {
						throw new GithubProblem(
							"github_failed",
							`The work is on ${branch} at GitHub, but GitHub opened no pull request${error.said ? `: ${error.said}` : ""}.`,
						);
					}
					if (error instanceof GithubError && error.status === 403) {
						throw new GithubProblem(
							"github_denied",
							`The work is on ${branch} at GitHub, but the GitHub App may not open pull requests in ${name}. Its installation on ${account} needs the permission "Pull requests: read and write"; then choose "Open pull request" again.`,
						);
					}
					throw error;
				}
			},
		);
	} catch (error) {
		throw new PullProblem(problemOf(error, account, name), head);
	}
}

/**
 * Opens the session's pull request from what is at GitHub on `branch` already, committing and pushing
 * nothing, and touching no sandbox: for the panel's click while a turn runs, once the agent has pushed.
 * The section says what the work rested on, without reading the changes (the workspace is the agent's
 * then). A pull request that is open for the branch already is taken up. Throws GithubProblem.
 */
export async function openFromPushed(input: {
	app: GithubApp;
	connection: StoredConnection | null;
	repository: StoredRepository;
	branch: string;
	message: PublishMessage;
	evidence: PublishEvidence;
}): Promise<PullRequestInfo> {
	const { app, connection, repository, branch } = input;
	if (!connection) throw new GithubProblem("github_gone", NOT_CONNECTED);
	const resolved = await sessionRepository(app, connection, repository, "write");
	const name = fullName(resolved.repository);
	const account = resolved.installation.account.login;
	const said = evidenceSection(input.evidence, null, connection.user.login);
	const body = pullBody(repository, input.message.body, said.section);
	try {
		return await app.withToken(
			resolved.installation.id,
			{ repositoryId: repository.id, permissions: { metadata: "read", contents: "read", pull_requests: "write" } },
			async token => {
				const { owner, name: repo } = resolved.repository;
				try {
					return infoOf(
						await app.createPull(token, owner, repo, {
							title: input.message.title.trim(),
							body,
							head: branch,
							base: repository.branch,
						}),
						Date.now(),
						said.words,
					);
				} catch (error) {
					if (error instanceof GithubError && error.status === 422 && /already exists/i.test(error.said)) {
						const existing = await app.openPull(token, owner, repo, branch, repository.branch);
						if (existing) return infoOf(existing, Date.now(), said.words);
					}
					throw error;
				}
			},
		);
	} catch (error) {
		throw problemOf(error, account, name);
	}
}

/**
 * Fetches the base branch into the workspace as `origin/<base>`, for a work item's turn that merges it
 * and for the agent's `fetch_base` (git.ts `fetchBaseScript`), with a token that may only read the
 * repository; with `work`, the session's own branch too, as `origin/<work>`, where GitHub has it, so the
 * agent can merge what others pushed there. Throws GithubProblem.
 */
export async function fetchBase(
	app: GithubApp,
	connection: StoredConnection | null,
	repository: StoredRepository,
	sandbox: SandboxHandle,
	work: string | null = null,
): Promise<boolean> {
	if (!connection) throw new GithubProblem("github_gone", NOT_CONNECTED);
	const resolved = await sessionRepository(app, connection, repository, "read");
	const name = fullName(resolved.repository);
	const account = resolved.installation.account.login;
	let fetched: GitOutcome;
	try {
		fetched = await withGitCredential(
			{ gitCredential: access => app.gitCredential(resolved.installation.id, repository.id, access) },
			"read",
			async ({ token, username }) => {
				const fetch = await fetchWithToken(sandbox, token, {
					url: app.cloneUrl(resolved.repository.owner, resolved.repository.name),
					base: repository.branch,
					work,
					username,
				});
				return confirmBase(app, token, repository, resolved.repository, fetch);
			},
		);
	} catch (error) {
		throw problemOf(error, account, name);
	}
	const unsafe = fetched.marks.get("unsafe");
	if (unsafe !== undefined) throw new GithubProblem("github_failed", unsafeWorkspace(unsafe));
	if (!fetched.ok) throw gitProblem(fetched, "clone", name, account, repository.branch);
	return fetched.marks.has("fetchedwork");
}

/**
 * Writes the section into the description of the session's open pull request without pushing
 * anything, and resolves with the pull request as it is then: for a turn that ended after its work
 * was pushed, so that the description says what that turn's checks came to. The caller has made
 * sure the workspace holds nothing GitHub lacks: the section is about what the pull request shows.
 * Null when the pull request is no longer open or GitHub could not be asked; never throws.
 */
export async function describePull(input: {
	app: GithubApp;
	connection: StoredConnection | null;
	repository: StoredRepository;
	sandbox: SandboxHandle;
	pull: PullRequestInfo;
	evidence: PublishEvidence;
}): Promise<PullRequestInfo | null> {
	const { app, connection, repository, pull } = input;
	if (!connection || !isOpen(pull)) return null;
	try {
		const said = evidenceSection(
			input.evidence,
			await readWork(input.sandbox, repository.baseSha ?? null),
			connection.user.login,
		);
		const resolved = await sessionRepository(app, connection, repository, "write");
		const { owner, name } = resolved.repository;
		return await app.withToken(
			resolved.installation.id,
			{ repositoryId: repository.id, permissions: { metadata: "read", contents: "read", pull_requests: "write" } },
			async token => {
				const current = await app.pull(token, owner, name, pull.number);
				if (current.state !== "open" && current.state !== "draft") return null;
				const described = pullBody(repository, current.body, said.section);
				const kept =
					current.body.trim() === described
						? current
						: await app.updatePull(token, owner, name, current.number, { title: current.title, body: described });
				return infoOf(kept, pull.pushedAt, said.words);
			},
		);
	} catch (error) {
		console.error(
			`[wlp] github.pull.describe_failed repository=${repository.id} pull=${pull.number}: ${error instanceof Error ? error.message : "unknown error"}`,
		);
		return null;
	}
}

/**
 * The pull request as GitHub describes it now, or as it was known when GitHub cannot be asked: a
 * panel that shows a state a few minutes old is better than one that shows an error.
 */
export async function refreshPull(
	app: GithubApp,
	connection: StoredConnection | null,
	repository: StoredRepository,
	pull: PullRequestInfo,
): Promise<PullRequestInfo> {
	if (!connection) return pull;
	try {
		const resolved = await sessionRepository(app, connection, repository, "read");
		const current = await app.withToken(
			resolved.installation.id,
			{ repositoryId: repository.id, permissions: { metadata: "read", pull_requests: "read" } },
			token => app.pull(token, resolved.repository.owner, resolved.repository.name, pull.number),
		);
		return infoOf(current, pull.pushedAt, pull.verified);
	} catch (error) {
		console.error(
			`[wlp] github.pull.refresh_failed repository=${repository.id} pull=${pull.number}: ${error instanceof Error ? error.message : "unknown error"}`,
		);
		return pull;
	}
}

/**
 * Whether the workspace has something GitHub does not, read from a sandbox that is running: true,
 * false, or null when git did not say (the sandbox layer's fake says nothing).
 */
export async function hasUnpushedWork(
	sandbox: SandboxHandle,
	baseSha: string | null,
	pushed: string | null,
): Promise<boolean | null> {
	const probed = await probeWork(sandbox, baseSha, pushed);
	if (!probed.ok || (!probed.marks.has("head") && !probed.marks.has("nothing"))) return null;
	if (!baseSha && !pushed && !probed.marks.has("dirty") && probed.marks.has("head")) return null;
	return probed.marks.has("dirty") || !probed.marks.has("nothing");
}
