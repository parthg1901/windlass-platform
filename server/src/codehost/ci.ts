import type { GithubId } from "../contract.js";
import { redact } from "../github/redact.js";

export const CI_POLLING = {
	everyMs: 60_000,
	/** The same, while the user has more than `crowdedAbove` items open: keeps an installation under GitHub's hourly limit. */
	crowdedEveryMs: 180_000,
	crowdedAbove: 10,
	/** Wait this long before checking recent default-branch commits for evidence of CI. */
	noneAfterMs: 10 * 60_000,
	/** Ask about a workflow GitHub reports as in progress for longer than this. */
	inProgressLimitMs: 6 * 60 * 60_000,
	/** Ask when CI could not be read at all (GitHub or the connection out of reach) for this long. */
	unreachableMs: 90 * 60_000,
	/** While an item is in review: is its pull request merged or closed. */
	prEveryMs: 10 * 60_000,
	webhookEveryMs: 5 * 60_000,
	webhookCrowdedEveryMs: 10 * 60_000,
	webhookPrEveryMs: 30 * 60_000,
} as const;

export function ciPollEvery(openItems: number, webhooks = false): number {
	if (webhooks)
		return openItems > CI_POLLING.crowdedAbove ? CI_POLLING.webhookCrowdedEveryMs : CI_POLLING.webhookEveryMs;
	return openItems > CI_POLLING.crowdedAbove ? CI_POLLING.crowdedEveryMs : CI_POLLING.everyMs;
}

export const LOG_TAIL_LINES = 200;
export const LOG_TAIL_CHARS = 16_000;
export const LOG_MAX_BYTES = 16 * 1024 * 1024;
/** Logs are read for at most this many failing jobs per reading. */
export const LOGS_PER_READING = 3;
/** Maximum job records read per CI poll to classify failures and cancellations. */
export const JOB_READS_PER_READING = 20;

/** One check run or commit status of the head. */
export interface CiRun {
	name: string;
	/** The app that reported it ("github-actions"), or "status" for a commit status. */
	app: string;
	state: "pending" | "passed" | "failed" | "not_run" | "cancelled" | "neutral";
	/** GitHub's word: a check run's `conclusion` (or its `status` while it runs), a status's `state`. */
	conclusion: string;
	url: string;
	/** The check output, job-not-started diagnostic, or status description. Untrusted and cut short. */
	summary: string;
	/** For a GitHub Actions check run: its job's id, whose log can be read. */
	jobId: string | null;
	/** A failed check whose own diagnostic is an environment failure. */
	environment?: true;
	/** Comparison with the same check or named tests on the item’s pinned base. */
	baseResult?: "failed" | "pending" | "unknown";
	/** Distinguishes Actions jobs with the same display name in different workflows. */
	workflowId?: string;
	/** The workflow for a confirmed infrastructure job on this head. */
	retryRunId?: string;
}

/** The end of a failing job's log. Untrusted: what code from the branch printed. */
export type CiLog =
	| { name: string; untrusted: true; text: string; truncated: boolean }
	| { name: string; untrusted: true; text: null; why: string };

export type CiReading =
	| {
			kind: "read";
			head: string;
			runs: CiRun[];
			truncated: boolean;
			logs: CiLog[];
			state?: "pending" | "incomplete";
			inProgressSince?: number;
	  }
	| { kind: "not_permitted"; said: string }
	| { kind: "rate_limited"; retryAt: number; said: string }
	| { kind: "failed"; said: string };

/**
 * What a reading comes to for the factory. "retry": nothing was learnt, look again later.
 * "incomplete": every run read has finished and none failed, but GitHub listed more than are read
 * (`truncated`): a failure may be among the rest, so it is not a pass. "skipped": CI ran, every run has
 * finished, none failed and none passed (all skipped or neutral): nothing in it verified the
 * work, which is not the same as no CI. "not_run": GitHub explicitly said a job never started.
 */
export type CiState =
	| "cancelled"
	| "passed"
	| "not_run"
	| "failed"
	| "pending"
	| "none"
	| "skipped"
	| "not_permitted"
	| "incomplete"
	| "retry";

export function ciState(reading: CiReading): CiState {
	if (reading.kind === "not_permitted") return "not_permitted";
	if (reading.kind !== "read") return "retry";
	if (reading.state) return reading.state;
	// Nothing usable read of a listing cut short is not "no CI": the rest of it was never seen.
	if (reading.runs.length === 0) return reading.truncated ? "incomplete" : "none";
	// A failure that was read stands, however much was not.
	if (reading.runs.some(run => run.state === "failed")) return "failed";
	if (reading.runs.some(run => run.state === "not_run")) return "not_run";
	if (reading.runs.some(run => run.state === "pending")) return "pending";
	if (reading.truncated) return "incomplete";
	if (reading.runs.some(run => run.state === "cancelled")) return "cancelled";
	// At least one check must have verified the work.
	return reading.runs.some(run => run.state === "passed") ? "passed" : "skipped";
}

export function workflowOverdue(reading: CiReading, now: number): boolean {
	return (
		reading.kind === "read" &&
		reading.inProgressSince !== undefined &&
		now - reading.inProgressSince > CI_POLLING.inProgressLimitMs
	);
}

/** Strips what a terminal would interpret and anything that is not printable text. */
export function plain(value: string): string {
	return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** The end of a text as a log tail: no timestamps GitHub put before each line, no control characters, no tokens. */
export function logTail(raw: string, cut: boolean): { text: string; truncated: boolean } {
	const lines = redact(plain(raw.replace(/\r\n?/g, "\n")))
		.split("\n")
		.map(line => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/, ""));
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	let truncated = cut || lines.length > LOG_TAIL_LINES;
	let tail = lines.slice(-LOG_TAIL_LINES).join("\n");
	if (tail.length > LOG_TAIL_CHARS) {
		tail = tail.slice(-LOG_TAIL_CHARS);
		truncated = true;
	}
	return { text: tail, truncated };
}

/**
 * The end of a streamed log. Only the end is kept while it streams; a log larger than LOG_MAX_BYTES is
 * not read to its end, and none of it is returned, since its end is what matters.
 */
export async function readLogTail(
	body: ReadableStream<Uint8Array>,
	clean: (text: string) => string = text => text,
): Promise<{ text: string; truncated: boolean } | { why: string }> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let kept = "";
	let bytes = 0;
	let cut = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > LOG_MAX_BYTES) {
				await reader.cancel();
				return { why: `the log is larger than ${LOG_MAX_BYTES / 1024 / 1024} MiB and was not read to its end` };
			}
			kept += decoder.decode(value, { stream: true });
			// Keep twice the tail, so a line cut here is not the first one kept.
			if (kept.length > LOG_TAIL_CHARS * 2) {
				kept = kept.slice(-LOG_TAIL_CHARS * 2);
				cut = true;
			}
		}
		kept += decoder.decode();
	} catch {
		return { why: "the log could not be read to its end" };
	}
	return logTail(clean(kept), cut);
}

const priority: Record<CiRun["state"], number> = {
	neutral: 0,
	passed: 1,
	cancelled: 2,
	pending: 3,
	not_run: 4,
	failed: 5,
};

/** Keep separate Actions workflows, even when they give their jobs the same name. */
export function distinctChecks(runs: CiRun[]): CiRun[] {
	const byName = new Map<string, CiRun>();
	for (const run of runs) {
		const key = JSON.stringify([run.name, run.workflowId]);
		const prior = byName.get(key);
		if (!prior || priority[run.state] > priority[prior.state]) byName.set(key, run);
	}
	return [...byName.values()];
}

export interface CiTarget {
	installationId: GithubId;
	repositoryId: GithubId;
	owner: string;
	name: string;
	/** The commit, a full SHA. */
	head: string;
}

export type RerunnableJob = Pick<CiRun, "name" | "jobId" | "retryRunId" | "environment"> & {
	failed?: true;
	passedOnRerun?: true;
};

export function rerunnableJobs(reading: Extract<CiReading, { kind: "read" }>, infrastructure: boolean) {
	const jobs: RerunnableJob[] = [];
	for (const check of reading.runs) {
		const { name, jobId, retryRunId, environment } = check;
		if (infrastructure && jobId && retryRunId && (environment || check.state === "cancelled"))
			jobs.push({ name, jobId, retryRunId, ...(environment && { environment }) });
		else if (check.state === "failed" && !environment && check.conclusion === "failure" && jobId && check.workflowId)
			jobs.push({ name, jobId, retryRunId: check.workflowId, failed: true });
	}
	return jobs;
}
