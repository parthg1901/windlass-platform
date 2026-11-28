/**
 * The verdict (Plans "software factory" §8, without the reviewer's `review`): what the work at a pushed
 * head rests on, for a machine to act on and a person to read. It is made from three things only, none
 * of them the agent's words: what the session's gate recorded of its last turn (`Verified`, from
 * Windlass's events: verified.ts), the observations on the changes (`workFlags`), and what the code host says
 * of CI at the head (codehost/ci.ts).
 *
 * CI decides: its result on the pushed head is what the verdict rests on first. The person's own checks
 * are optional: a loop before the push, whose failure sends the agent back and whose pass can stand in
 * for CI that did not run, or did not speak.
 * `result`, the first that holds:
 *
 *   fail         a check of the gate's run failed (started, and did not pass), or CI failed
 *   incomplete   the turn was stopped, failed, or was cut off
 *   pass         CI passed on the pushed head: it ran on the final files, so files changed after the
 *                checks ran do not count against it, and no check need be set at all; or, CI not having
 *                passed, the user's own checks passed in the gate's run with nothing changed after it
 *                ("not needed" counts where it rests on such a run). Never while the pull request holds
 *                a commit pushed after the head (`moved`): nothing verified that one
 *   unverified   nothing verified this state of the work: CI did not pass (none ran, nothing in it
 *                passed, unfinished when it was handed over, not readable, not permitted, unread) and no
 *                run of the user's checks that passed stands behind it, or the pull request moved on.
 *                The repository's own checks alone do not stand behind it
 *
 * A pass whose CI was not read, or had not finished, says so in its first words ("Your checks passed;
 * CI has not been read."), not "Ready for review."
 *
 * Flags never change `result`: a pass with flags is shown as "needs a look", never "ready". That
 * matters the more as CI passes happily when tests were deleted or skipped. A verdict never merges
 * anything.
 *
 * Also here: the fingerprint of a failure (§2.1 step 5), by which a fix that brings back the same
 * failure stops the run at once (§2.4).
 */

import { createHash } from "node:crypto";
import type { ReviewRecommendation, SandboxPlace, TurnOutcome, Verified } from "../contract.js";
import type { CiReading } from "../codehost/ci.js";
import { flagWords, verifiedHeadline } from "../verified.js";
import { environmentFailure } from "./check-environment.js";
import type { CiProgress, GateEvidence, Verdict } from "./types.js";

const CUT_SHORT: ReadonlySet<TurnOutcome> = new Set(["stopped", "failed", "interrupted", "error"]);

/** The checks of the gate's run that failed: started, and did not pass. */
function failingChecks(verified: Verified): Array<{ name: string; output?: string }> {
	// A turn without its own run can carry a previous failure for the timeline.
	if (verified.run?.turn !== verified.turn) return [];
	return verified.run.checks.filter(check => check.status !== "passed" && check.startError === undefined);
}

/** What the gate makes of a turn by itself, before anything is pushed (§2.1 step 2): "fail" sends the agent back, "pass" and "unverified" publish. */
export function gateResult(outcome: TurnOutcome, verified: Verified | null, forced = false): Verdict["result"] {
	if (CUT_SHORT.has(outcome)) return "incomplete";
	if (verified === null) return "unverified";
	if (forced) {
		const run = verified.run;
		if (
			verified.state === "passed" &&
			(run?.turn !== verified.turn ||
				verified.unrun.length ||
				!run.checks.some(check => check.required) ||
				run.checks.some(check => check.required && check.carried))
		)
			return "unverified";
		if (verified.state === "not_needed") return "unverified";
		if (
			verified.state === "unresolved" &&
			run?.turn === verified.turn &&
			run.checks.every(check => check.status === "passed" || check.startError || environmentFailure(check))
		)
			return "unverified";
	}
	switch (verified.state) {
		case "passed":
			return verified.changedAfter || (verified.run !== null && verified.run.turn !== verified.turn)
				? "unverified"
				: "pass";
		case "unresolved":
			return failingChecks(verified).length > 0 ? "fail" : "unverified";
		case "not_needed":
			return verified.unneeded.on === "run" && !verified.changedAfter ? "pass" : "unverified";
		case "stopped":
		case "failed":
			return "incomplete";
		default:
			return "unverified";
	}
}

/** What the verdict says of CI, from the item's last reading. CI still running when the person had the work handed over is "timed_out". */
export function verdictCi(progress: CiProgress | null): Verdict["ci"] {
	const last = progress?.last ?? null;
	// Never read at all (GitHub did not answer): unknown, which is not "no CI".
	if (last === null) return { state: "unread", runs: [], said: null };
	if (last.state === "incomplete")
		return {
			state: "unread",
			runs: last.runs,
			said:
				last.runs.length === 0
					? "GitHub reported CI but supplied no readable check results"
					: "GitHub listed more checks than the platform reads, and none of those it read failed",
		};
	return { state: last.state === "pending" ? "timed_out" : last.state, runs: last.runs, said: last.said };
}

export interface VerdictInput {
	id: string;
	item: string;
	run: number;
	head: string;
	at: number;
	place: SandboxPlace;
	gate: GateEvidence | null;
	ci: Verdict["ci"];
	acceptance: string[];
	mergeable: boolean | null;
	/** The pull request's commit, when it has moved past `head`. */
	moved?: string | null;
}

/** What a verdict says of a pull request that holds a commit after the one verified. */
export const movedSentence = (head: string, moved: string) =>
	`The pull request is now at ${moved.slice(0, 7)}, a commit pushed after ${head.slice(0, 7)}: nothing verified it.`;

export function verdictOf(input: VerdictInput): Verdict {
	const verified = input.gate?.verified ?? null;
	const gate = input.gate === null ? "unverified" : gateResult(input.gate.outcome, verified, input.gate.forcedChecks);
	// A carried run is evidence for this commit only when the gate attests to its state.
	const checks = verified?.run && (verified.run.turn === verified.turn || gate === "pass") ? verified.run.checks : [];
	const usersRan = checks.some(check => check.whose === "user");
	const moved = input.moved ?? null;
	// A pass is of the commit verified: a pull request that holds another one is not passed, whatever its earlier commit came to.
	const passed =
		moved === null && (input.ci.state === "passed" || (input.ci.state !== "cancelled" && gate === "pass" && usersRan));
	const result: Verdict["result"] =
		gate === "fail" || input.ci.state === "failed"
			? "fail"
			: gate === "incomplete"
				? "incomplete"
				: passed
					? "pass"
					: "unverified";
	return {
		id: input.id,
		item: input.item,
		run: input.run,
		head: input.head,
		at: input.at,
		place: input.place.kind,
		attestedBy: input.place.kind === "hosted" ? "platform" : `machine:${input.place.machineId}`,
		result,
		gate: {
			state: verified?.state ?? null,
			required: checks
				.filter(check => check.whose === "user")
				.map(check => ({ name: check.name, status: check.status, sentBack: check.sentBack })),
			...(verified?.unneeded ? { unneeded: verified.unneeded } : {}),
		},
		ci: input.ci,
		flags: input.gate?.flags ?? [],
		acceptance: input.acceptance,
		mergeable: input.mergeable,
		moved,
		said: {
			ci: moved === null ? ciSentence(input.ci) : `${ciSentence(input.ci)} ${movedSentence(input.head, moved)}`,
			flags: (input.gate?.flags ?? []).map(flag => flagWords(flag.kind)),
		},
	};
}

const FAILING_CONCLUSIONS = ["failure", "timed_out", "startup_failure", "action_required", "error"];

/** What the verdict says of CI, in a sentence: for the log, the pull request and the item's page alike. */
export function ciSentence(ci: Verdict["ci"]): string {
	const count = new Set(ci.runs.map(run => run.name)).size;
	switch (ci.state) {
		case "passed": {
			const passed = new Set(ci.runs.filter(run => run.conclusion === "success").map(run => run.name)).size;
			return `CI passed (${passed} ${passed === 1 ? "check" : "checks"}).`;
		}
		case "cancelled": {
			const cancelled = ci.runs.filter(run => run.conclusion === "cancelled" || run.conclusion === "stale");
			const describe = (runs: typeof cancelled) =>
				`${runs.length} ${runs.length === 1 ? "check was" : "checks were"} cancelled (${runs.map(run => run.name).join(", ")})`;
			const timedOut = ci.runs.filter(run => run.conclusion === "timed_out");
			const stopped = cancelled.filter(run => run.stopped || run.conclusion === "stale");
			const other = cancelled.filter(run => !stopped.includes(run));
			return (
				"CI did not finish: " +
				[
					...(timedOut.length ? [`${timedOut.map(run => run.name).join(", ")} timed out.`] : []),
					...(stopped.length
						? [
								`${describe(stopped)}; not rerun because ${stopped.length === 1 ? "it was" : "they were"} stopped while running.`,
							]
						: []),
					...(other.length ? [`${describe(other)}; nothing failed.`] : []),
				].join(" ")
			);
		}
		case "failed": {
			const failing = ci.runs.filter(run => FAILING_CONCLUSIONS.includes(run.conclusion));
			return `CI failed: ${[...new Set(failing.map(run => run.name))].join(", ")}.`;
		}
		case "not_run":
			return ci.said ? `GitHub did not start the CI jobs: ${ci.said}` : "GitHub did not start the CI jobs.";
		case "none":
			return "No CI ran on this commit.";
		case "skipped":
			return `CI ran, and nothing in it passed: ${count === 1 ? "its one check was" : `its ${count} checks were`} skipped, cancelled or neutral.`;
		case "timed_out":
			return "CI had not finished when this was handed over.";
		case "unread":
			return `CI could not be read${ci.said ? ` in full: ${ci.said}` : ": GitHub did not answer while the platform waited for it"}. The pull request's own page shows its CI.`;
		case "not_permitted":
			return `CI was not read: GitHub does not let the platform see this repository's checks${ci.said ? ` (“${ci.said}”)` : ""}. The GitHub App needs read access to Checks, Commit statuses and Actions, accepted on the installation. The pull request's own page shows them.`;
	}
}

/** The verdict in plain sentences, for the item page and the line on the pull request. */
export function verdictHeadline(verdict: Verdict, review?: ReviewRecommendation | null, unfinished = false): string {
	switch (verdict.result) {
		case "fail":
			return "Failing.";
		case "incomplete":
			return "Incomplete: the last turn did not finish.";
		case "unverified":
			return verdict.moved ? "Not verified: the pull request has a newer commit." : "Not verified.";
		case "pass":
			if (verdict.flags.length) return "Needs a look.";
			switch (verdict.ci.state) {
				case "unread":
				case "not_permitted":
					return "Your checks passed; CI has not been read.";
				case "timed_out":
					return "Your checks passed; CI had not finished.";
				case "not_run":
					return "Your checks passed; CI did not start.";
				default:
					if (review === "changes_requested") return "Code review requested changes.";
					if (unfinished) return "Code review is incomplete after requesting changes.";
					return "Ready for review.";
			}
	}
}

export function verdictWords(
	verdict: Verdict,
	gate: GateEvidence | null,
	review?: ReviewRecommendation | null,
	unfinished = false,
): string {
	const head = verdictHeadline(verdict, review, unfinished);
	// No checks set is no shortcoming: checks are the person's choice, and CI decides without them.
	const gateSaid = !gate?.verified
		? "The turn left no record of its checks; CI decides."
		: gate.verified.state === "none_set"
			? "No checks are set for this repository; CI decides."
			: verifiedHeadline(gate.verified);
	const ci = verdict.said.ci;
	const flags = verdict.flags.map(
		(flag, index) => `${verdict.said.flags[index] ?? flagWords(flag.kind)}: ${flag.where.join(", ")}.`,
	);
	const merge = verdict.mergeable === false ? ["GitHub says the pull request conflicts with its base."] : [];
	return [head, gateSaid, ci, ...flags, ...merge].join(" ");
}

// ---------------------------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------------------------

const ERROR_LINE =
	/\b(error|errors|fail|failed|failure|failing|assert\w*|exception|panic\w*|expected|cannot|undefined)\b/i;

/**
 * The lines of a failure's output that say what failed, with what changes from one run to the next
 * (numbers, durations, hashes, temporary paths) taken out, so the same failure gives the same lines.
 */
function normalisedLines(texts: string[]): string[] {
	const lines = new Set<string>();
	for (const text of texts) {
		for (const raw of text.split("\n")) {
			if (!ERROR_LINE.test(raw)) continue;
			const line = raw
				.replace(/\/tmp\/[^\s:'"]+/g, "/tmp/…")
				.replace(/\b[0-9a-f]{7,}\b/gi, "#")
				.replace(/\d+(?:\.\d+)?/g, "0")
				.replace(/\s+/g, " ")
				.trim();
			if (line !== "") lines.add(line);
		}
	}
	return [...lines].sort();
}

export function failureFingerprint(failing: string[], texts: string[]): string {
	return createHash("sha256")
		.update([...new Set(failing)].sort().join("\n"))
		.update("\n\n")
		.update(normalisedLines(texts).join("\n"))
		.digest("hex");
}

/** Of a gate that failed: the failing checks and what they printed. */
export function gateFingerprint(verified: Verified): string {
	const failing = failingChecks(verified);
	return failureFingerprint(
		failing.map(check => `gate:${check.name}`),
		failing.map(check => check.output ?? ""),
	);
}

/** Of CI that failed: the failing runs, their summaries and the ends of their logs. */
export function ciFingerprint(reading: Extract<CiReading, { kind: "read" }>): string {
	const failing = reading.runs.filter(run => run.state === "failed");
	return failureFingerprint(
		failing.map(run => `ci:${run.app}/${run.name}`),
		[...failing.map(run => run.summary), ...reading.logs.map(log => log.text ?? "")],
	);
}
