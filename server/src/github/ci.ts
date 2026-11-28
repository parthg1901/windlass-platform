import {
	CI_POLLING,
	JOB_READS_PER_READING,
	LOGS_PER_READING,
	ciState,
	distinctChecks,
	plain,
	readLogTail,
	type CiLog,
	type CiReading,
	type CiRun,
	type CiTarget,
	type RerunnableJob,
} from "../codehost/ci.js";
import { environmentFailure } from "../factory/check-environment.js";
import { parse } from "yaml";
import { decimalId, ownApp } from "./ids.js";
import { type GithubApp, GithubError, record, text } from "./app.js";
import { redact } from "./redact.js";

export {
	CI_POLLING,
	JOB_READS_PER_READING,
	LOG_MAX_BYTES,
	LOG_TAIL_CHARS,
	LOG_TAIL_LINES,
	LOGS_PER_READING,
	ciPollEvery,
	ciState,
	logTail,
	plain,
	rerunnableJobs,
	workflowOverdue,
	type CiLog,
	type CiReading,
	type CiRun,
	type CiState,
	type CiTarget,
	type RerunnableJob,
} from "../codehost/ci.js";

/** Conclusions of a completed check run that say the code failed something. "cancelled", "skipped", "stale" and "neutral" do not. */
const FAILING = new Set(["failure", "startup_failure", "action_required"]);

const short = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function refusal({ status, headers, said }: GithubError): CiReading {
	if (status === 0) return { kind: "failed", said: "GitHub could not be reached" };
	const now = Date.now();
	const retryAfter = Number(headers.get("retry-after"));
	const reset = Number(headers.get("x-ratelimit-reset"));
	const limited =
		status === 429 ||
		(status === 403 &&
			(headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after") || /rate limit/i.test(said)));
	if (limited) {
		const retryAt =
			Number.isFinite(retryAfter) && retryAfter > 0
				? now + retryAfter * 1000
				: Number.isFinite(reset) && reset > 0
					? reset * 1000
					: now + CI_POLLING.everyMs;
		return { kind: "rate_limited", retryAt: Math.max(retryAt, now), said };
	}
	if (status === 403) return { kind: "not_permitted", said };
	return { kind: "failed", said: `GitHub answered ${status}${said ? ` (${said})` : ""}` };
}

const notStarted = (message: string) => /^The job was not started because\b/i.test(message.trim());

type Candidate = { run: CiRun; jobId: string; diagnostic: string; annotationId: string };

function checkRunOf(
	fields: Record<string, unknown>,
	candidates: Candidate[],
	workflowBySuite: Map<string, string>,
): CiRun | null {
	const name = text(fields.name);
	if (name === "") return null;
	const app = text(record(fields.app).slug) || "unknown";
	const status = text(fields.status);
	const conclusion = text(fields.conclusion);
	const state =
		status !== "completed"
			? "pending"
			: FAILING.has(conclusion)
				? "failed"
				: conclusion === "success"
					? "passed"
					: conclusion === "cancelled" || conclusion === "stale" || conclusion === "timed_out"
						? "cancelled"
						: "neutral";
	const output = record(fields.output);
	const summary = plain([text(output.title), text(output.summary)].filter(part => part !== "").join(": "));
	const run: CiRun = {
		name,
		app,
		state,
		conclusion: status === "completed" ? conclusion : status,
		url: text(fields.html_url) || text(fields.details_url),
		summary: short(summary, 500),
		jobId: app === "github-actions" ? decimalId(fields.id) : null,
	};
	if (run.jobId) run.workflowId = workflowBySuite.get(decimalId(record(fields.check_suite).id) ?? "");
	if (run.jobId !== null && state === "failed" && conclusion === "failure") {
		const diagnostic = [text(output.title), text(output.summary)].find(notStarted) ?? "";
		if (diagnostic || output.annotations_count === 1) {
			candidates.push({ run, jobId: run.jobId, diagnostic, annotationId: diagnostic ? "" : text(fields.node_id) });
		}
	}
	return run;
}

function statusOf(value: unknown): CiRun | null {
	const fields = record(value);
	const name = text(fields.context);
	if (name === "") return null;
	const word = text(fields.state);
	const state = word === "success" ? "passed" : word === "pending" ? "pending" : "failed";
	return {
		name,
		app: "status",
		state,
		conclusion: word,
		url: text(fields.target_url),
		summary: short(plain(text(fields.description)), 500),
		jobId: null,
	};
}

/** GitHub allocates a new check-run id for each attempt. Discard superseded attempts before reading diagnostics. */
function latestAttempts(checks: Record<string, unknown>[]) {
	const latest = new Map<string, Record<string, unknown>>();
	for (const check of checks) {
		const key = JSON.stringify([record(check.app).slug, check.name, record(check.check_suite).id]);
		const prior = latest.get(key);
		if (!prior || BigInt(decimalId(check.id) ?? 0) > BigInt(decimalId(prior.id) ?? 0)) latest.set(key, check);
	}
	return [...latest.values()];
}

/**
 * A failing job's log. GitHub answers with a redirect to a short-lived address at its storage, which is
 * fetched without the token. Only the end is kept while it streams; a log larger than LOG_MAX_BYTES is
 * not read to its end, and none of it is returned, since its end is what matters.
 */
async function readLog(
	app: GithubApp,
	token: string,
	owner: string,
	name: string,
	run: CiRun & { jobId: string },
): Promise<CiLog> {
	const none = (why: string): CiLog => ({ name: run.name, untrusted: true, text: null, why });
	let response: Response;
	try {
		response = await app.jobLog(token, owner, name, run.jobId);
	} catch {
		return none("the log could not be fetched");
	}
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		if (response.status === 403 || response.status === 429) return none("GitHub did not allow reading the log");
		if (response.status === 404 || response.status === 410) return none("GitHub no longer has the log");
		return none(`GitHub answered ${response.status} for the log`);
	}
	const tail = await readLogTail(response.body);
	if ("why" in tail) return none(tail.why);
	return { name: run.name, untrusted: true, ...tail };
}

async function readWorkflowJobs(app: GithubApp, token: string, target: CiTarget, runId: string, head: string) {
	const { owner, name } = target;
	const run = record(
		(
			await app.call({
				path: `/repos/${owner}/${name}/actions/runs/${runId}`,
				auth: { bearer: token },
				what: "find the cancelled job’s workflow",
			})
		).body,
	);
	// These events load the workflow from the run's head. A pull request can use a synthetic merge revision.
	if (
		!["push", "workflow_dispatch", "schedule", "merge_group"].includes(text(run.event)) ||
		run.head_sha !== head ||
		!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(text(run.path))
	)
		return {};
	const source = await app.withToken(
		target.installationId,
		{ repositoryId: target.repositoryId, permissions: { metadata: "read", contents: "read" } },
		t => app.fileAt(t, owner, name, text(run.path), head),
		{ reuse: true },
	);
	return record(record(parse(source, { maxAliasCount: 50 })).jobs);
}

function jobTimeout(jobs: Record<string, unknown>, name: string): unknown {
	const matches = [];
	for (const [id, definition] of Object.entries(jobs)) {
		const job = record(definition);
		const label = job.name ?? id;
		// An expression or reusable workflow can supply a different job's display name at runtime.
		if (typeof label !== "string" || label.includes("${{") || job.uses) return undefined;
		if (label === name) matches.push(job);
	}
	return matches.length === 1 ? matches[0]!["timeout-minutes"] : undefined;
}

async function markRetryable(
	app: GithubApp,
	token: string,
	target: CiTarget,
	head: string,
	candidates: CiRun[],
	budget: number,
) {
	const definitions = new Map<string, Promise<Record<string, unknown>>>();
	for (const run of candidates) {
		if ((!run.environment && !["cancelled", "timed_out"].includes(run.conclusion)) || !run.jobId) continue;
		if (budget-- <= 0) break;
		try {
			const job = record(
				(
					await app.call({
						path: `/repos/${target.owner}/${target.name}/actions/jobs/${run.jobId}`,
						auth: { bearer: token },
						what: "confirm the interrupted Actions job",
					})
				).body,
			);
			const runId = decimalId(job.run_id);
			if (!runId || job.head_sha !== head || job.conclusion !== run.conclusion || decimalId(job.id) !== run.jobId)
				continue;
			if (run.environment || job.conclusion === "timed_out") {
				run.retryRunId = runId;
				continue;
			}
			const unassigned =
				job.runner_id === 0 || job.runner_id === null || (job.runner_id === undefined && "runner_name" in job);
			if (
				unassigned &&
				(job.runner_name == null || job.runner_name === "") &&
				Array.isArray(job.steps) &&
				job.steps.every(
					step =>
						!record(step).started_at && (record(step).status === "queued" || record(step).conclusion === "skipped"),
				)
			) {
				run.retryRunId = runId;
				continue;
			}
			const elapsed = Date.parse(text(job.completed_at)) - Date.parse(text(job.started_at));
			if (!(elapsed > 0)) continue;
			let minutes = job.timeout_minutes ?? job["timeout-minutes"];
			if (minutes === undefined) {
				if (!definitions.has(runId)) definitions.set(runId, readWorkflowJobs(app, token, target, runId, head));
				minutes = jobTimeout(await definitions.get(runId)!, text(job.name));
			}
			if (typeof minutes === "string" && /^\d+$/.test(minutes)) minutes = Number(minutes);
			if (typeof minutes === "number" && Number.isSafeInteger(minutes) && minutes > 0 && elapsed >= minutes * 60_000)
				run.retryRunId = runId;
		} catch {
			/* Without positive evidence, leave this job stopped. */
		}
	}
}

/** GitHub reruns failed jobs and their dependents together. Every affected job must be safe to restart. */
export async function rerunJobs(app: GithubApp, target: CiTarget, jobs: RerunnableJob[]) {
	const accepted: string[] = [];
	const problems = new Set<string>();
	const workflows = new Map<string, Map<string, boolean>>();
	for (const { jobId, retryRunId, environment, failed } of jobs) {
		// Effects stored by older versions did not record why the job was cancelled.
		if (!retryRunId || !jobId) continue;
		if (!workflows.has(retryRunId)) workflows.set(retryRunId, new Map());
		workflows.get(retryRunId)!.set(jobId, !!environment || !!failed);
	}
	const problem = (error: GithubError) =>
		error.status === 403 && !error.rateLimited ? "GitHub refused Actions: write for this installation" : error.message;
	if (workflows.size) {
		try {
			await app.withToken(
				target.installationId,
				{ repositoryId: target.repositoryId, permissions: { metadata: "read", actions: "write" } },
				async token => {
					const auth = { bearer: token };
					for (const [runId, ids] of workflows) {
						try {
							const path = `/repos/${target.owner}/${target.name}/actions/runs/${runId}`;
							const listing = await app.pages(
								{
									path: path + "/jobs",
									query: { filter: "latest" },
									auth,
									what: "verify the workflow jobs before rerunning",
								},
								body => {
									const jobs = record(body).jobs;
									if (!Array.isArray(jobs)) throw new Error("GitHub did not list the workflow jobs.");
									return jobs.map(record);
								},
							);
							const affected = listing.items.filter(
								job => !["success", "skipped", "neutral"].includes(text(job.conclusion)),
							);
							const expected = new Set(ids.keys());
							const confirmed = affected.every(job => {
								const id = decimalId(job.id) ?? "";
								const reason = ids.get(id)
									? job.conclusion === "failure"
									: ["cancelled", "timed_out"].includes(text(job.conclusion));
								return job.head_sha === target.head && job.status === "completed" && reason && expected.delete(id);
							});
							if (listing.truncated || !confirmed || expected.size) {
								problems.add("the workflow includes other jobs or its attempts changed");
								continue;
							}
							await app.call({
								method: "POST",
								path: path + "/rerun-failed-jobs",
								auth,
								what: "rerun failed workflow jobs",
							});
							accepted.push(...ids.keys());
						} catch (error) {
							if (!(error instanceof GithubError)) throw error;
							problems.add(problem(error));
						}
					}
				},
			);
		} catch (error) {
			if (!(error instanceof GithubError)) throw error;
			problems.add(error.status === 422 ? "the installation did not grant Actions: write" : problem(error));
		}
	}
	const notes = [];
	for (const job of jobs) {
		if (job.failed && job.jobId && accepted.includes(job.jobId))
			notes.push(`Requested one re-run of failed CI job ${job.name}.`);
	}
	const said = [
		notes.join(" ") || (accepted.length ? "Requested a GitHub Actions rerun for the interrupted checks." : ""),
		problems.size ? `Could not request ${accepted.length ? "every" : "a"} rerun: ${[...problems].join(". ")}.` : "",
	]
		.filter(Boolean)
		.join(" ");
	return { accepted, said: said || "No interrupted checks were confirmed eligible for a rerun." };
}

function listed(value: unknown, what: string): unknown[] {
	if (!Array.isArray(value)) throw new GithubError(200, `missing ${what} list`, `read ${what}`);
	return value;
}

/** The combined status resolves branch refs to the SHA used for the workflow listing. */
async function listCommitCi(app: GithubApp, token: string, repo: string, ref: string, branch?: string) {
	const auth = { bearer: token };
	const base = `${repo}/commits/${ref}`;
	const checks = await app.pages({ path: `${base}/check-runs`, auth, what: "list check runs" }, body =>
		listed(record(body).check_runs, "check runs"),
	);
	let answeredFor = "";
	const statuses = await app.pages({ path: `${base}/status`, auth, what: "read commit statuses" }, body => {
		const fields = record(body);
		answeredFor ||= text(fields.sha);
		return listed(fields.statuses, "commit statuses");
	});
	const head = answeredFor || (/^[0-9a-f]{40}$/i.test(ref) ? ref : text(record(checks.items[0]).head_sha) || ref);
	const workflows = await app.pages(
		{ path: `${repo}/actions/runs`, query: { head_sha: head }, auth, what: "list workflow runs for the commit" },
		body => listed(record(body).workflow_runs, "workflow runs").map(record),
	);
	// Fast-forwarding a part can leave two branches' workflow runs on the same SHA.
	const otherBranch = (run: Record<string, unknown>) => !!branch && !!run.head_branch && run.head_branch !== branch;
	const otherSuites = new Set(
		workflows.items
			.filter(otherBranch)
			.map(run => decimalId(run.check_suite_id))
			.filter(Boolean),
	);
	return {
		head,
		checks: checks.items
			.map(record)
			.filter(
				check =>
					(!check.head_sha || check.head_sha === head) &&
					!ownApp(record(check.app), app.settings) &&
					!otherSuites.has(decimalId(record(check.check_suite).id)),
			),
		statuses: statuses.items,
		workflows: workflows.items.filter(run => !otherBranch(run)),
		truncated: checks.truncated || statuses.truncated || workflows.truncated,
	};
}

async function recentDefaultBranchCi(app: GithubApp, token: string, target: CiTarget, repo: string, head: string) {
	const { body } = await app.withToken(
		target.installationId,
		{ repositoryId: target.repositoryId, permissions: { metadata: "read", contents: "read" } },
		t =>
			app.call({
				path: `${repo}/commits`,
				query: { per_page: 3 },
				auth: { bearer: t },
				what: "list recent default-branch commits",
			}),
		{ reuse: true },
	);
	for (const commit of listed(body, "commits")) {
		const sha = text(record(commit).sha);
		if (sha === head) continue;
		const ci = await listCommitCi(app, token, repo, sha);
		if (ci.checks.length || ci.statuses.length || ci.workflows.length || ci.truncated) return true;
	}
	return false;
}

const activeWorkflowStates = new Set(["queued", "pending", "waiting", "requested", "in_progress"]);

/** Resolve ambiguous failures before collapsing names or choosing any logs to download. */
async function readRuns(
	app: GithubApp,
	token: string,
	target: CiTarget,
	listing: Awaited<ReturnType<typeof listCommitCi>>,
	baseResultsOnly: boolean,
): Promise<CiReading> {
	const { head, checks, statuses, workflows } = listing;
	let { truncated } = listing;
	const candidates: Candidate[] = [];
	let remainingJobReads = JOB_READS_PER_READING;
	const workflowBySuite = new Map<string, string>();
	for (const workflow of workflows) {
		const suite = decimalId(workflow.check_suite_id),
			id = decimalId(workflow.id);
		if (suite && id && workflow.head_sha === head) workflowBySuite.set(suite, id);
	}
	let runs = [
		...latestAttempts(checks).map(fields => checkRunOf(fields, candidates, workflowBySuite)),
		...statuses.map(statusOf),
	].filter((run): run is CiRun => run !== null);
	if (!baseResultsOnly && workflows.some(run => activeWorkflowStates.has(text(run.status)))) {
		// GitHub can set run_started_at while queued. The current status has held at least since updated_at.
		const starts = workflows
			.filter(run => run.status === "in_progress")
			.map(run => Date.parse(text(run.updated_at)))
			.filter(Number.isFinite);
		return {
			kind: "read",
			head,
			runs: distinctChecks(runs),
			truncated,
			logs: [],
			state: "pending",
			inProgressSince: starts.length ? Math.min(...starts) : undefined,
		};
	}
	// CI was reported, but there is no usable check result for this commit.
	if (!runs.length && (workflows.length || checks.length || statuses.length))
		return { kind: "read", head, runs, truncated, logs: [], state: "incomplete" };
	if (candidates.length) {
		let messages = new Map<string, string>();
		let unread: CiReading = { kind: "failed", said: "GitHub did not return the check annotations" };
		try {
			const ids = [...new Set(candidates.map(({ annotationId }) => annotationId).filter(Boolean))];
			if (ids.length) messages = await app.checkAnnotations(token, ids);
		} catch (error) {
			if (!(error instanceof GithubError)) throw error;
			unread = refusal(error);
		}
		const missing = new Set<CiRun>();
		for (const { run, jobId, diagnostic, annotationId } of candidates) {
			const message = diagnostic || messages.get(annotationId);
			if (message && !notStarted(message)) continue;
			// Past the budget a candidate is unread, not failed: it may be one more job that never started.
			if (remainingJobReads === 0) {
				missing.add(run);
				continue;
			}
			remainingJobReads--;
			// Workflows can write all three forms of the diagnostic. Only GitHub's job record can corroborate it.
			try {
				if (!(await app.jobNeverStarted(token, target.owner, target.name, jobId))) continue;
			} catch (error) {
				if (!(error instanceof GithubError)) throw error;
				continue;
			}
			if (message) {
				run.state = "not_run";
				run.summary = short(redact(plain(message.trim())), 500);
			} else {
				missing.add(run);
			}
		}
		// An unread annotation cannot establish a code failure. An independent, confirmed failure still stands.
		if (missing.size) {
			runs = runs.filter(run => !missing.has(run));
			if (!runs.some(run => run.state === "failed")) return unread;
			truncated = true;
		}
	}
	if (baseResultsOnly) return { kind: "read", head, runs, truncated, logs: [] };
	runs = distinctChecks(runs);
	const failing = runs
		.filter((run): run is CiRun & { jobId: string } => run.state === "failed" && run.jobId !== null)
		.slice(0, LOGS_PER_READING);
	const logs: CiLog[] = [];
	for (const run of failing) logs.push(await readLog(app, token, target.owner, target.name, run));
	const reading = { kind: "read" as const, head, runs, truncated, logs };
	for (const run of runs) {
		if (run.state !== "failed") continue;
		const output = run.summary + "\n" + (logs.find(log => log.name === run.name)?.text ?? "");
		if (environmentFailure({ status: "failed", exitCode: null, output })) run.environment = true;
	}
	const retryable = runs.filter(run => run.environment || run.state === "cancelled");
	if (ciState(reading) === "cancelled" || retryable.some(run => run.environment))
		await markRetryable(app, token, target, head, retryable, remainingJobReads);
	return reading;
}

/** Reads the CI of a commit. Never throws for anything GitHub answers: every outcome is a `CiReading`. */
export async function readCi(
	app: GithubApp,
	target: CiTarget,
	{
		baseResultsOnly = false,
		since = Date.now(),
		branch,
	}: { baseResultsOnly?: boolean; since?: number; branch?: string } = {},
): Promise<CiReading> {
	// GitHub's answer to a call of the reading, as against one to the request for its token.
	let answered: GithubError | null = null;
	try {
		return await app.withToken(
			target.installationId,
			{
				repositoryId: target.repositoryId,
				permissions: { metadata: "read", checks: "read", statuses: "read", actions: "read" },
			},
			async token => {
				try {
					const repo = `/repos/${target.owner}/${target.name}`;
					const listing = await listCommitCi(app, token, repo, target.head, branch);
					const reading = await readRuns(app, token, target, listing, baseResultsOnly);
					if (!baseResultsOnly && reading.kind === "read" && ciState(reading) === "none") {
						const gracePeriod = Date.now() - since < CI_POLLING.noneAfterMs;
						if (gracePeriod || (await recentDefaultBranchCi(app, token, target, repo, reading.head)))
							reading.state = "pending";
					}
					return reading;
				} catch (error) {
					// Thrown on, so that a kept token GitHub no longer takes is replaced by a new one (`withToken`'s `reuse`).
					if (error instanceof GithubError) answered = error;
					throw error;
				}
			},
			{ reuse: true },
		);
	} catch (error) {
		if (!(error instanceof GithubError)) throw error;
		if (error === answered) return refusal(error);
		// The token itself was refused: 422 when the installation does not have, or has not accepted, a permission asked for.
		if (error.status === 422) return { kind: "not_permitted", said: error.said };
		// Otherwise as any answer of GitHub's: a limit by its headers, before a 403 is taken for a refusal.
		return refusal(error);
	}
}
