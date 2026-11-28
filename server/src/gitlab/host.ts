import type { GithubId, GithubRepository } from "../contract.js";
import {
	JOB_READS_PER_READING,
	LOGS_PER_READING,
	readLogTail,
	type CiLog,
	type CiReading,
	type CiRun,
	type CiTarget,
} from "../codehost/ci.js";
import { GitCredentialRefused } from "../codehost/credential.js";
import type { CodeHost, GitAccess, GitCredential, Pull } from "../codehost/types.js";
import { redact } from "../github/redact.js";
import { verifiedWords } from "../verified.js";
import { GitlabApp, GitlabError, projectAccess, record as obj, text } from "./app.js";
import { decimalId, gitlabId } from "./ids.js";
import { gitlabWebhookRoute, parseGitlabWebhook, type GitlabDelivery, type GitlabWebhookBinding } from "./webhook.js";

/** The owner supplies a current OAuth token, refreshing and persisting it outside the adapter. */
export interface GitlabConnection {
	id: GithubId;
	project?: Pick<GithubRepository, "id" | "owner" | "name">;
	accessToken(): Promise<string>;
}
export interface GitlabRepository {
	id: GithubId;
	branch: string;
	closesIssue?: number;
}
export interface GitlabHook extends GitlabWebhookBinding {
	dispatch?(delivery: GitlabDelivery): Promise<void>;
}
type Host = CodeHost<GitlabConnection, GitlabRepository, GitlabDelivery>;

function id(v: unknown): string {
	const value = decimalId(v);
	if (!value) throw new Error("Invalid GitLab identifier.");
	return value;
}
function parsePull(body: unknown): Pull {
	const mr = obj(body),
		refs = obj(mr.diff_refs),
		number = Number(id(mr.iid));
	if (!Number.isSafeInteger(number) || !["opened", "closed", "merged", "locked"].includes(text(mr.state)))
		throw new Error("Invalid GitLab merge request.");
	return {
		number,
		url: text(mr.web_url),
		title: text(mr.title),
		body: text(mr.description),
		state: mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : mr.draft ? "draft" : "open",
		mergeable:
			mr.detailed_merge_status === "mergeable"
				? true
				: mr.has_conflicts === true || mr.detailed_merge_status === "conflict"
					? false
					: null,
		head: text(mr.source_branch),
		headSha: text(mr.sha) || text(refs.head_sha),
		base: text(mr.target_branch),
		baseSha: text(refs.start_sha),
		mergeBaseSha: text(refs.base_sha),
		requestedReviewers: Array.isArray(mr.reviewers) ? mr.reviewers.map(r => text(obj(r).username)).filter(Boolean) : [],
	};
}
function repository(body: unknown): GithubRepository {
	const p = projectAccess(body);
	if (!p) throw new Error("Invalid GitLab project.");
	return {
		id: p.id,
		owner: p.owner,
		name: p.name,
		defaultBranch: p.defaultBranch || "main",
		private: p.private,
		canPush: p.writable,
		pushedAt: p.pushedAt,
	};
}

function state(status: unknown): CiRun["state"] {
	switch (status) {
		case "success":
			return "passed";
		case "failed":
			return "failed";
		case "canceled":
			return "cancelled";
		case "skipped":
			return "neutral";
		default:
			return "pending";
	}
}

async function failureLog(app: GitlabApp, token: string, target: CiTarget, run: CiRun): Promise<CiLog> {
	const none = (why: string): CiLog => ({ name: run.name, untrusted: true, text: null, why });
	let body;
	try {
		body = (await app.jobTrace(token, target.repositoryId, run.jobId!)).body;
	} catch {
		return none("The GitLab job trace could not be read.");
	} // Never return an upstream diagnostic or a credential.
	if (!body) return none("The GitLab job trace could not be read.");
	const tail = await readLogTail(body, text => redact(text, [token]));
	return "why" in tail ? none(tail.why) : { name: run.name, untrusted: true, ...tail };
}

type Pipeline = Record<string, unknown>;

const mergeResult = (pipe: Pipeline) =>
	/^refs\/merge-requests\/\d+\/(?:merge|train)$/.test(text(pipe.ref)) && typeof pipe.sha === "string";

/** A merged-results (or merge train) pipeline runs on a merge commit whose second parent is the MR's source head. */
async function runsHead(app: GitlabApp, token: string, target: CiTarget, pipe: Pipeline): Promise<boolean> {
	if (pipe.sha === target.head) return true;
	if (!mergeResult(pipe)) return false;
	const parents = await app.commitParents(token, target.repositoryId, text(pipe.sha));
	return parents.length === 2 && parents[1] === target.head;
}

/**
 * The newest pipeline that ran the head: a branch pipeline, the merge request's own pipeline, or a merged-results
 * pipeline whose source is the head. Without a merge request, only pipelines of the commit itself.
 */
async function pipelineFor(app: GitlabApp, token: string, target: CiTarget, pull?: number): Promise<Pipeline | null> {
	const own = await app.pipelines(token, target.repositoryId, target.head);
	if (!Array.isArray(own)) throw new Error("Invalid GitLab pipeline list.");
	const candidates = own.map(obj);
	if (pull) {
		const listed = await app.mrPipelines(token, target.repositoryId, pull);
		if (!Array.isArray(listed)) throw new Error("Invalid GitLab pipeline list.");
		candidates.push(obj(obj(await app.readMr(token, target.repositoryId, pull)).head_pipeline), ...listed.map(obj));
	}
	const newest = new Map<string, Pipeline>();
	for (const pipe of candidates) {
		const key = decimalId(pipe.id);
		if (key) newest.set(key, pipe);
	}
	const ordered = [...newest.entries()].sort(([a], [b]) => (BigInt(b) > BigInt(a) ? 1 : -1)).map(([, pipe]) => pipe);
	let mergeReads = 0;
	for (const pipe of ordered) {
		if (pipe.sha === target.head) return pipe;
		if (mergeReads < 3 && mergeResult(pipe)) {
			mergeReads++;
			if (await runsHead(app, token, target, pipe)) return pipe;
		}
	}
	return null;
}

function jobRun(value: unknown, pipelineId: string): CiRun {
	const job = obj(value),
		status = text(job.status),
		jobState = state(status);
	const optional = job.allow_failure === true && ["failed", "manual", "canceled"].includes(status);
	const run: CiRun = {
		app: "gitlab-ci",
		name: text(job.name),
		state: optional ? "neutral" : jobState,
		conclusion: status === "failed" ? "failure" : status,
		url: text(job.web_url),
		summary: "",
		jobId: id(job.id),
		workflowId: pipelineId,
		retryRunId: pipelineId,
	};
	if (job.failure_reason === "runner_system_failure") run.environment = true;
	return run;
}

async function pipelineJobs(app: GitlabApp, token: string, target: CiTarget, pipelineId: string) {
	const jobs = await app.pipelineJobs(token, target.repositoryId, pipelineId, JOB_READS_PER_READING + 1);
	if (!Array.isArray(jobs.body)) throw new Error("Invalid GitLab jobs list.");
	const truncated = jobs.body.length > JOB_READS_PER_READING || !!jobs.headers.get("x-next-page");
	return { runs: jobs.body.slice(0, JOB_READS_PER_READING).map(job => jobRun(job, pipelineId)), truncated };
}

/** The pipeline verdict matters too (e.g. downstream jobs). */
async function readPipeline(
	app: GitlabApp,
	token: string,
	target: CiTarget,
	pull?: number,
	skipLogs = false,
): Promise<CiReading> {
	const logs: CiLog[] = [];
	const pipe = await pipelineFor(app, token, target, pull);
	if (!pipe) return { kind: "read", head: target.head, runs: [], logs, truncated: false };
	const pipelineId = id(pipe.id);
	const { runs, truncated } = await pipelineJobs(app, token, target, pipelineId);
	for (const run of runs) {
		if (!skipLogs && run.state === "failed" && logs.length < LOGS_PER_READING)
			logs.push(await failureLog(app, token, target, run));
	}
	const pipelineState = state(pipe.status);
	if (!runs.length || (pipelineState !== "passed" && !runs.some(r => r.state === pipelineState))) {
		runs.push({
			name: "Pipeline",
			app: "gitlab-ci",
			state: pipelineState,
			conclusion: text(pipe.status),
			url: text(pipe.web_url),
			summary: "",
			jobId: null,
		});
	}
	const since = Date.parse(text(pipe.created_at));
	return {
		kind: "read",
		head: target.head,
		runs,
		logs,
		truncated,
		...(pipelineState === "pending" && Number.isFinite(since) && { inProgressSince: since }),
	};
}

/** GitLab's notes are addressed by their parent IID *and* note ID, unlike GitHub's. */
function noteIds(key: string): [string, string] {
	const parts = key.split(":");
	if (parts.length !== 2) throw new Error("Invalid GitLab note reference.");
	return [id(parts[0]), id(parts[1])];
}

/** Longer than any one clone, fetch or push (with its retry): an older token of ours was left by one that never ended. */
const STALE_GIT_TOKEN_MS = 15 * 60 * 1000;
const MAINTAINER = 40;

function statusOf(error: unknown) {
	return error instanceof GitlabError ? error.status : 0;
}

/** Why GitLab would not make the token, in words that say what is needed. */
async function refusal(app: GitlabApp, token: string, projectId: string, access: GitAccess) {
	const what = access === "write" ? "push" : "clone or fetch";
	const project = await app
		.call({ token, path: `/projects/${id(projectId)}` })
		.then(({ body }) => projectAccess(body))
		.catch(() => null);
	const path = project ? `${project.owner}/${project.name}` : `GitLab project ${projectId}`;
	const never = "Windlass never hands your GitLab sign-in to the sandbox instead.";
	if (project && project.level < MAINTAINER)
		return new GitCredentialRefused(
			`Windlass needs Maintainer access on ${path} to create a short-lived project token for Git, so the ${what} did not run. ${never}`,
		);
	return new GitCredentialRefused(
		`GitLab refused to create a short-lived project token on ${path}, so the ${what} did not run. Project access tokens need Maintainer access and, on GitLab.com, a Premium or Ultimate plan (any plan on self-managed GitLab), and a group owner or administrator can turn them off. ${never}`,
	);
}

/**
 * A project access token for one sandbox Git operation, made with the owner's grant, which itself stays in this
 * process. Tokens of ours that an earlier operation left (a crash between making and revoking one) are revoked
 * first, as far as the grant may; each also expires within about a day.
 */
export async function gitlabGitCredential(
	app: GitlabApp,
	grant: () => Promise<string>,
	projectId: string,
	access: GitAccess,
): Promise<GitCredential> {
	const token = await grant();
	const stale = await app.staleGitTokens(token, projectId, Date.now() - STALE_GIT_TOKEN_MS).catch(() => []);
	for (const tokenId of stale)
		await app.revokeProjectToken(token, projectId, tokenId).then(
			() => console.log(`[wlp] gitlab.git_token.revoked project=${projectId} token=${tokenId} stale=true`),
			error =>
				console.warn(
					`[wlp] gitlab.git_token.revoke_failed project=${projectId} token=${tokenId} status=${statusOf(error)}`,
				),
		);
	let made: Awaited<ReturnType<GitlabApp["createGitToken"]>>;
	try {
		made = await app.createGitToken(token, projectId, access);
	} catch (error) {
		const status = statusOf(error);
		console.warn(`[wlp] gitlab.git_token.refused project=${projectId} access=${access} status=${status}`);
		if ([400, 403, 404, 405, 422].includes(status)) throw await refusal(app, token, projectId, access);
		throw error;
	}
	console.log(
		`[wlp] gitlab.git_token.created project=${projectId} token=${made.id} access=${access} expires=${made.expiresAt}`,
	);
	let revoked = false;
	return {
		token: made.token,
		username: "oauth2",
		async revoke() {
			if (revoked) return;
			revoked = true;
			try {
				await app.revokeProjectToken(await grant(), projectId, made.id);
				console.log(`[wlp] gitlab.git_token.revoked project=${projectId} token=${made.id}`);
			} catch (error) {
				console.error(
					`[wlp] gitlab.git_token.revoke_failed project=${projectId} token=${made.id} status=${statusOf(error)} expires=${made.expiresAt}`,
				);
			}
		},
	};
}

export function gitlabCodeHost(app: GitlabApp, connection: GitlabConnection, hook?: GitlabHook): Host {
	function projectKey(owner: string, name: string) {
		const project = connection.project;
		if (!project) return `${owner}/${name}`;
		if (project.owner !== owner || project.name !== name) throw new Error("GitLab project does not match.");
		return id(project.id);
	}
	function checkConnection(key: GithubId) {
		if (id(key) !== id(connection.id)) throw new Error("GitLab connection does not match.");
	}
	function checkTarget(target: Pick<CiTarget, "installationId" | "repositoryId">) {
		checkConnection(target.installationId);
		if (connection.project && id(target.repositoryId) !== id(connection.project.id))
			throw new Error("GitLab project does not match.");
		if (hook && id(target.repositoryId) !== id(hook.projectId)) throw new Error("GitLab project does not match.");
	}
	// The owner's grant, for calls made from this process only.
	const withToken: Host["withToken"] = async (target, _access, step) => {
		checkTarget(target);
		return step(await connection.accessToken());
	};
	const open = async (token: string, project: string, input: Parameters<Host["openPull"]>[3]) =>
		parsePull(
			await app.openMr(token, project, {
				title: input.draft ? `Draft: ${input.title}` : input.title,
				description: input.body,
				source_branch: input.head,
				target_branch: input.base,
			}),
		);
	return {
		cloneUrl: app.cloneUrl.bind(app),
		pushUrl: app.cloneUrl.bind(app),
		withToken,
		gitCredential: async (target, access) => {
			checkTarget(target);
			return gitlabGitCredential(app, () => connection.accessToken(), id(target.repositoryId), access);
		},
		openPull: (token, owner, name, input) => open(token, projectKey(owner, name), input),
		async openFromPushed(input) {
			if (!input.connection) throw new Error("GitLab is not connected.");
			const repo = input.repository,
				footer = repo.closesIssue ? `\n\nCloses #${id(repo.closesIssue)}` : "";
			const pull = await withToken(
				{ installationId: input.connection.id, repositoryId: repo.id },
				"pull:write",
				async token => {
					// Recover both a previous run's MR and a POST whose reply was lost. Forks may reuse branch names.
					const query = new URLSearchParams({
						state: "opened",
						source_branch: input.branch,
						target_branch: repo.branch,
					});
					const response = await app.call({ token, path: `/projects/${id(repo.id)}/merge_requests?${query}` });
					if (!Array.isArray(response.body)) throw new Error("Invalid GitLab merge request list.");
					const prior = response.body
						.map(obj)
						.find(
							mr =>
								decimalId(mr.source_project_id) === id(repo.id) &&
								decimalId(mr.target_project_id) === id(repo.id) &&
								mr.source_branch === input.branch &&
								mr.target_branch === repo.branch,
						);
					return prior
						? parsePull(prior)
						: open(token, id(repo.id), {
								title: input.message.title,
								body: input.message.body + footer,
								head: input.branch,
								base: repo.branch,
							});
				},
			);
			return {
				number: pull.number,
				url: pull.url,
				state: pull.state,
				title: pull.title,
				branch: pull.head,
				base: pull.base,
				pushedAt: Date.now(),
				verified: verifiedWords(input.evidence.verified, [], input.evidence.during),
			};
		},
		async readPull(token, owner, name, n) {
			return parsePull(await app.readMr(token, projectKey(owner, name), n));
		},
		async updatePull(token, owner, name, n, input) {
			return parsePull(
				await app.updateMr(token, projectKey(owner, name), n, { title: input.title, description: input.body }),
			);
		},
		async mergePull(token, owner, name, n, head, title) {
			if (!/^[0-9a-f]{40,64}$/i.test(head)) throw new Error("Invalid GitLab merge head.");
			await app.mergeMr(token, projectKey(owner, name), n, head, title);
		},
		async closePull(token, owner, name, n) {
			await app.updateMr(token, projectKey(owner, name), n, { state_event: "close" });
		},
		hasBranch: (token, owner, name, branch) =>
			app.branchHead(token, projectKey(owner, name), branch).then(
				() => true,
				(error: unknown) => {
					if (error instanceof GitlabError && error.status === 404) return false;
					throw error;
				},
			),
		async readCi(target, options) {
			try {
				return await withToken(target, "log:read", token =>
					readPipeline(app, token, target, options?.pull, options?.baseResultsOnly),
				);
			} catch (error) {
				if (error instanceof GitlabError && [401, 403].includes(error.status))
					return { kind: "not_permitted", said: "GitLab did not allow reading CI." };
				if (error instanceof GitlabError && error.status === 429)
					return {
						kind: "rate_limited",
						retryAt: error.retryAt || Date.now() + 60_000,
						said: "GitLab CI reads are rate limited.",
					};
				return { kind: "failed", said: "GitLab CI could not be read." };
			}
		},
		jobLog: (token, owner, name, jobId) => app.jobTrace(token, projectKey(owner, name), jobId),
		async rerunJobs(target, jobs) {
			const accepted: string[] = [];
			try {
				await withToken(target, "pull:write", async token => {
					// Each job's own pipeline, which must still be one that ran this head.
					for (const pipelineId of new Set(jobs.flatMap(j => (j.retryRunId ? [j.retryRunId] : [])))) {
						if (!(await runsHead(app, token, target, obj(await app.pipeline(token, target.repositoryId, pipelineId)))))
							continue;
						for (const run of (await pipelineJobs(app, token, target, pipelineId)).runs) {
							if (
								!run.jobId ||
								!["failed", "cancelled"].includes(run.state) ||
								!jobs.some(j => j.jobId === run.jobId && j.retryRunId === pipelineId)
							)
								continue;
							await app.retryJob(token, target.repositoryId, run.jobId);
							accepted.push(run.jobId);
						}
					}
				});
			} catch {
				/* Return only the jobs GitLab accepted. */
			}
			return {
				accepted,
				said:
					accepted.length === jobs.length
						? "Requested the GitLab job retries."
						: "Some GitLab jobs could not be retried.",
			};
		},
		async listRepositories(c, query) {
			checkConnection(c.id);
			const list = await app.projects(await connection.accessToken(), query);
			return { repositories: list.items.map(repository), more: list.truncated, incomplete: false };
		},
		async listComments(token, owner, name, n, requireComplete, since) {
			const list = await app.notes(token, projectKey(owner, name), "merge_requests", n);
			if (requireComplete && list.truncated) throw new Error("Incomplete GitLab note listing.");
			return list.items
				.map(obj)
				.filter(note => !note.system && (!since || Date.parse(text(note.updated_at)) >= since))
				.map(note => {
					const author = obj(note.author),
						personId = gitlabId(author.id),
						login = text(author.username);
					return {
						id: `${n}:${id(note.id)}`,
						body: text(note.body),
						author: login,
						person: personId && login ? { id: personId, login } : null,
						association: "NONE",
					};
				});
		},
		async createComment(token, owner, name, n, body) {
			const note = await app.createNote(token, projectKey(owner, name), "merge_requests", n, body);
			return `${n}:${id(obj(note).id)}`;
		},
		async updateComment(token, owner, name, key, body) {
			await app.updateNote(token, projectKey(owner, name), "merge_requests", ...noteIds(key), body);
		},
		async react(token, repo, target) {
			const project = projectKey(repo.owner, repo.name);
			if (target.kind === "issue") await app.eyes(token, project, "issues", id(target.id));
			else
				await app.eyes(
					token,
					project,
					target.kind === "review_comment" ? "merge_requests" : "issues",
					...noteIds(target.id),
				);
		},
		parseWebhook(headers, bytes) {
			if (!hook) throw new Error("GitLab webhook is not configured.");
			return parseGitlabWebhook(headers, bytes, hook);
		},
		webhookRoute: hook?.dispatch ? gitlabWebhookRoute(hook, hook.dispatch) : async () => null,
	};
}
