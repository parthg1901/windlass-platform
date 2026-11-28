// Publishing the branch and deciding what an item's CI reading means.
import { mergeCandidate } from "./autonomy.js";
import { CI_POLLING, type CiReading, ciPollEvery, workflowOverdue } from "../codehost/ci.js";
import { spellSeconds } from "../usage.js";
import { choice } from "./answered.js";
import { crossRepo, handOver as crossHandOver } from "./cross-repo.js";
import type { CiProgress, Fact, TurnPlan } from "./types.js";
import { untrustedWords } from "./untrusted.js";
import { ciFingerprint, ciSentence, gateResult, verdictCi } from "./verdict.js";
import {
	ask,
	askRemoved,
	automatic,
	type Change,
	checkTiming,
	failuresOf,
	handOver,
	IMPLEMENT,
	isSha,
	marked,
	nextTurn,
	NO_GATE,
	pendingCheck,
	RULES,
	shortSha,
	verdictAt,
} from "./change.js";
import { ciFixText, ciProgress, conflictPlan, repairChecks, requestCiRerun, rerunState } from "./ci-reading.js";
import { featureUpdateChoice, flow, newerPartBase, readFeatureCi } from "./feature-flow.js";
import {
	afterCi,
	handoff,
	integratePart,
	MOVED,
	movedFrom,
	PERSON_HANDOVER,
	readForHandoff,
	skippedReview,
	subtaskCheckPlan,
} from "./review-flow.js";

export function publish(c: Change): void {
	c.enter("publish");
	c.state("working");
	c.effects.push({ kind: "publish", key: c.key });
}

export function stopPendingChecks(c: Change): void {
	for (const { sha, existingOnly } of c.item.pendingChecks ?? []) {
		const title = "Stopped before it was verified";
		c.effects.push({
			kind: "verified_check",
			key: sha,
			existingOnly,
			state: "completed",
			...checkTiming(c),
			verdictId: null,
			conclusion: "cancelled",
			title,
			summary: title + ".",
		});
	}
	c.item.pendingChecks = [];
}

export function published(c: Change, fact: Extract<Fact, { kind: "published" }>): void {
	const { item, run } = c;
	if (crossRepo(item) && item.mode === "orchestrate" && !item.parent) {
		if (!item.repos!.some(r => r.featureCi)) return crossHandOver(flow(c));
		run.confirmFeatureCi = true;
		c.enter("subtasks");
		c.state("waiting", { reason: "ci", sentence: "Confirming CI on the tested feature heads.", retryAt: c.at });
		return;
	}
	delete run.updateFromBase;
	item.head = fact.head;
	item.pr = fact.pr;
	c.say(
		fact.pr
			? `Pushed ${shortSha(fact.head)} to pull request #${fact.pr.number}.`
			: `Pushed subtask commit ${shortSha(fact.head)}${item.joinOnGate ? "" : " for CI"}.`,
	);
	c.enter("ci");
	// The gate this commit rests on is kept with it: a later turn's gate is not about it until it is pushed.
	run.ci = ciProgress(fact.head, c.at, run.gate, fact.webhooks);
	if (fact.pr && !item.parent) pendingCheck(c, fact.head, `Waiting for CI on ${shortSha(fact.head)}`);
	if (item.machineRemoved) return askRemoved(c);
	if (item.parent && item.joinOnGate) {
		const ci = run.ci;
		if (isSha(ci.head) && ci.gate && gateResult(ci.gate.outcome, ci.gate.verified, ci.gate.forcedChecks) === "pass")
			return integratePart(c, ci);
		return ask(
			c,
			"rounds",
			"Local checks must pass on the current subtask commit before integration.",
			[choice("run_checks"), choice("give_up")],
			null,
			subtaskCheckPlan(ci),
			undefined,
			{ policy: failuresOf(run).includes(NO_GATE) ? undefined : "subtask_checks", evidence: ci.head },
		);
	}
	// "Hand it over as it is" before anything was pushed: CI is read once, and the work handed over whatever it says.
	if (run.handOver) {
		delete run.handOver;
		return readForHandoff(c, run.ci, skippedReview(PERSON_HANDOVER));
	}
	if (item.featureCi) {
		c.state("waiting", { reason: "ci", sentence: "Confirming CI on the current feature head.", retryAt: c.at });
		c.effects.push({ kind: "poll_ci", key: c.key, head: fact.head, at: c.at });
	} else pollCi(c, fact.openItems, null, `Waiting for CI to start on ${shortSha(fact.head)}.`);
}

export function publishFailed(c: Change, fact: Extract<Fact, { kind: "publish_failed" }>): void {
	const step = c.run.step;
	// Consume the attempt before emitting the retry.
	step.attempt += 1;
	if (fact.transient && step.attempt <= RULES.publishTries) {
		c.say(`The push did not get through (${fact.said}); it is tried again.`);
		c.effects.push({ kind: "publish", key: c.key, at: c.at + RULES.publishRetryMs * 2 ** (step.attempt - 2) });
		return;
	}
	const said = fact.said.replace(/^GitHub refused the push(?::\s*|\s+(?=because))/, "");
	const refused = `GitHub refused the push${/^because/.test(said) ? " " : ": "}${said}`;
	// Handing it back gives the agent a turn to change what GitHub refused, with the person's note; Try again pushes the same work.
	const fix: TurnPlan = {
		...IMPLEMENT,
		text: `${refused} Change the work so that it can be pushed, then finish as before.`,
		charge: "gate",
		fingerprint: "publish_refused",
	};
	ask(c, "publish_refused", refused, [choice("send_back"), choice("again"), choice("give_up")], null, fix);
}

export function pollCi(c: Change, openItems: number, notBefore: number | null, sentence: string): void {
	const at = Math.max(c.at + ciPollEvery(openItems, c.run.ci?.webhooks), notBefore ?? 0);
	c.state("waiting", { reason: "ci", sentence, retryAt: at });
	c.effects.push({
		kind: "poll_ci",
		key: c.key,
		head: c.run.ci?.head ?? "",
		at,
		...(notBefore !== null ? { notBefore } : {}),
	});
}

function ciWaitSentence(head: string, reading: CiReading): string {
	const on = shortSha(head);
	switch (reading.kind) {
		case "read": {
			if (reading.runs.length === 0) return `Waiting for CI to start on ${on}.`;
			const finished = reading.runs.filter(run => run.state !== "pending").length;
			return `Waiting for CI on ${on}: ${finished} of ${reading.runs.length} checks finished.`;
		}
		case "rate_limited":
			return `Waiting for CI on ${on}: GitHub asked the platform to wait until ${new Date(reading.retryAt).toISOString().slice(11, 16)} UTC before reading it again.`;
		case "failed":
			return `Waiting for CI on ${on}: ${reading.said}; it is read again shortly.`;
		case "not_permitted":
			return `CI on ${on} cannot be read.`;
	}
}

const HANDOFF_READS = 4;

export function updateFromBase(c: Change): boolean {
	const { item, run } = c;
	const head = run.ci?.head;
	if (!head || !isSha(head) || head !== item.head || run.ci?.moved || item.mode === "orchestrate") return false;
	const fingerprint = `conflict:${item.task.base}`;
	const previous = failuresOf(run);
	// Main can move again while an earlier update runs; follow it a few times.
	const movedAgain =
		!item.parent && run.updatedBaseTip && run.ci?.baseTip !== run.updatedBaseTip && run.rounds.conflict < 3;
	if (previous.includes(fingerprint) && !run.ci?.waitForBase && !newerPartBase(item, run.ci!) && !movedAgain)
		return false;
	run.updatedBaseTip = run.ci?.baseTip;
	if (!previous.includes(fingerprint)) run.failures = [...previous, fingerprint];
	run.lastFailure = fingerprint;
	run.rounds.conflict++;
	run.updateFromBase = { head, at: c.at, ...(run.ci?.waitForBase && { baseTip: run.ci.baseTip }) };
	c.say(`Updating the item branch from ${item.task.base}.`);
	publish(c);
	return true;
}

function recordCiRead(c: Change, ci: CiProgress, fact: Extract<Fact, { kind: "ci_read" }>) {
	// Evidence for another commit cannot settle this head.
	const reading: CiReading =
		fact.reading.kind === "read" && isSha(ci.head) && fact.reading.head !== ci.head
			? { kind: "failed", said: `GitHub answered for commit ${shortSha(fact.reading.head)}, not ${shortSha(ci.head)}` }
			: fact.reading;
	const { state, rerun, awaitingFlakyJob } = rerunState(c, fact, reading);
	ci.lastReadState = state;
	ci.webhooks = fact.webhooks;
	// Consume this poll before scheduling another.
	c.run.step.attempt += 1;
	ci.mergeable = fact.mergeable;
	const since = c.at - ci.since;
	// An empty reading is provisional until GitHub has had time to list checks.
	const settled = (state !== "none" && state !== "skipped") || since >= CI_POLLING.noneAfterMs;
	ci.last = null;
	if (
		reading.kind === "read" &&
		state !== "retry" &&
		state !== "not_permitted" &&
		(settled || c.run.step.kind === "handoff")
	) {
		ci.last = {
			state,
			runs: reading.runs.map(({ name, app, state, conclusion, url, retryRunId }) => ({
				name,
				app,
				conclusion: state === "not_run" ? "not_run" : conclusion,
				url,
				...(state === "cancelled" && !retryRunId && { stopped: true as const }),
			})),
			said: state === "not_run" ? (reading.runs.find(run => run.state === "not_run")?.summary ?? null) : null,
		};
	}
	if (reading.kind === "not_permitted") ci.last = { state: "not_permitted", runs: [], said: reading.said };

	if (fact.prHead !== null) {
		const moved = movedFrom(ci.head, fact.prHead);
		if (moved !== ci.moved && c.item.state === "review" && c.item.mode !== "orchestrate")
			ci.reviewPush = moved ? { head: moved } : undefined;
		ci.moved = moved;
	}
	return { reading, state, since, rerun, awaitingFlakyJob };
}

export function decideCi(c: Change, fact: Extract<Fact, { kind: "ci_read" }>): void {
	const { run } = c;
	const ci = run.ci;
	if (ci === null) return;
	const { reading, state, since, rerun, awaitingFlakyJob } = recordCiRead(c, ci, fact);
	if (run.takingPush) {
		if (c.item.head === null) ci.moved = fact.prHead ?? ci.head;
		delete run.takingPush;
		if (crossRepo(c.item))
			return crossHandOver(flow(c), "The owner took over the feature branches before verification finished.");
		if (c.item.pr) return handoff(c, skippedReview(PERSON_HANDOVER));
		// A part (or a branch pushed mid-turn) has no PR to post to or poll.
		const { verdict, words } = verdictAt(c, ci);
		c.storeVerdict = { kind: "verdict", verdict, words };
		c.say(words);
		run.endedAt = c.at;
		c.enter("merged");
		return c.state("review");
	}
	const waitForReading = () =>
		pollCi(
			c,
			fact.openItems,
			reading.kind === "rate_limited" ? reading.retryAt : null,
			ciWaitSentence(ci.head, reading),
		);
	if (c.item.featureCi && c.item.state !== "review") {
		if (fact.prHead === ci.head && state === "failed" && reading.kind === "read") {
			c.item.featureCi = { head: ci.head, since: ci.since };
			c.enter("subtasks");
			c.state("waiting", { reason: "children", sentence: "Fixing CI on the feature branch.", retryAt: null });
			readFeatureCi(c, fact);
			return;
		}
		if ((fact.prHead !== null && fact.prHead !== ci.head) || fact.mergeable === false)
			return ask(
				c,
				"ci_timeout",
				"The feature PR must be at the verified head and free of conflicts before handover.",
				[choice("wait"), choice("give_up")],
				null,
				null,
			);
		if (state !== "passed" || fact.prHead !== ci.head) return waitForReading();
	}
	// One read settles a handoff even if CI is still pending.
	if (run.step.kind === "handoff") {
		const review = ci.moved
			? skippedReview(MOVED)
			: (ci.secondReview ?? skippedReview("this item was handed over before second reviews were available"));
		const wouldMerge =
			c.item.state !== "review" &&
			fact.autoMergeSingles &&
			fact.prHead === ci.head &&
			verdictAt(c, ci).verdict.result === "pass";
		// GitHub computes mergeability and the base comparison lazily after main moves: read again before handing over.
		if (
			wouldMerge &&
			(fact.mergeable === null || fact.baseAhead === undefined) &&
			c.run.step.attempt < HANDOFF_READS &&
			mergeCandidate(c.item, review, true)
		)
			return waitForReading();
		if (wouldMerge && mergeCandidate(c.item, review)) {
			if (fact.baseAhead !== undefined && fact.baseAhead > 0) {
				ci.baseTip = fact.baseTip;
				if (updateFromBase(c)) return;
			}
			if (fact.baseAhead === 0 && fact.baseTip) {
				handoff(c, review, true);
				ci.autoMergeKey = c.key;
				c.effects.push({ kind: "auto_merge", key: c.key, head: ci.head, baseTip: fact.baseTip, pr: c.item.pr!.number });
				return;
			}
		}
		return handoff(c, review);
	}

	const environmentOnly =
		state === "failed" &&
		reading.kind === "read" &&
		reading.runs.every(check => check.state !== "failed" || check.environment);
	if (
		c.item.mode === "orchestrate" &&
		(fact.mergeable === false || (state === "failed" && !environmentOnly) || ci.moved)
	) {
		const reason = ci.moved
			? "The feature PR moved after the last verified commit."
			: fact.mergeable === false
				? "The feature PR conflicts with its base."
				: "CI failed on the complete feature.";
		const retry = ci.moved ? [] : [{ id: "wait" as const, label: "Check the feature PR again" }];
		return ask(c, "rounds", reason, [...retry, ...handOver(c.item), choice("give_up")], null, null);
	}
	if (ci.moved !== null) {
		c.say(
			`The pull request is now at ${shortSha(ci.moved)}, pushed after the agent's ${shortSha(ci.head)}: it is handed over as it is.`,
		);
		return afterCi(c, ci);
	}

	ci.baseTip = fact.baseTip;
	const baseAhead = fact.baseAhead ?? 0;
	const canUpdate =
		baseAhead > 0 &&
		isSha(ci.head) &&
		ci.head === c.item.head &&
		c.item.mode !== "orchestrate" &&
		(!failuresOf(run).includes(`conflict:${c.item.task.base}`) || newerPartBase(c.item, ci));
	const canUpdateSubtask = !!c.item.parent && (canUpdate || !!fact.featureTarget);
	const ciEvidence = [
		ci.head,
		state,
		...(reading.kind === "read" ? reading.runs.map(r => [r.app, r.name, r.conclusion, r.jobId].join("/")).sort() : []),
	].join(" ");
	const question = (sentence: string, plan: TurnPlan | null = null, infrastructure = false) => {
		const choices = plan ? [{ id: "again" as const, label: "Have the agent fix CI" }] : [choice("wait")];
		if (canUpdate)
			sentence += ` The base branch ${c.item.task.base} is ${baseAhead} commit${baseAhead === 1 ? "" : "s"} ahead of this commit.`;
		const feature = fact.featureTarget && c.item.parent ? featureUpdateChoice(fact.featureTarget) : null;
		const policy =
			feature && fact.featureTargetHead && isSha(fact.featureTargetHead) && !run.autoHistory?.feature_ahead?.length
				? "feature_ahead"
				: infrastructure
					? "ci_timeout"
					: undefined;
		return ask(
			c,
			"ci_timeout",
			sentence,
			[
				...choices,
				...(canUpdate ? [choice("update_from_base")] : []),
				...(feature ? [feature] : []),
				...handOver(c.item),
				choice("give_up"),
			],
			null,
			plan,
			undefined,
			{ policy, target: fact.featureTargetHead, evidence: ciEvidence },
		);
	};
	if (ci.waitForBase) {
		if (fact.baseTip && fact.baseTip !== ci.waitForBase && fact.basePassed && updateFromBase(c)) return;
		return pollCi(c, fact.openItems, null, `Waiting for passing CI on a new ${c.item.task.base} commit.`);
	}
	if (fact.mergeable === false && !canUpdate) {
		c.say(`GitHub says the pull request conflicts with ${c.item.task.base}.`);
		return nextTurn(c, conflictPlan(c.item.task.base));
	}
	if (awaitingFlakyJob && !workflowOverdue(reading, c.at)) {
		if (since >= CI_POLLING.unreachableMs && reading.kind === "read" && reading.state !== "pending")
			return question("GitHub has not reported the re-run of the failed CI jobs.");
		return pollCi(c, fact.openItems, null, "Waiting for GitHub to report the re-run of the failed CI jobs.");
	}
	const interrupted =
		reading.kind === "read" &&
		reading.runs.some(check => check.retryRunId && (check.state === "cancelled" || check.environment));
	if (
		reading.kind === "read" &&
		(state === "failed" || state === "cancelled") &&
		!rerun &&
		(c.item.parent || fact.prHead === ci.head)
	) {
		const allowInfra = interrupted && !!automatic(c, "ci_timeout", ciEvidence, ["rerun_ci"]);
		if (requestCiRerun(c, fact, reading, allowInfra)) return;
	}
	if (
		reading.kind === "read" &&
		(state === "cancelled" || (state === "failed" && reading.runs.some(check => check.environment)))
	) {
		const interrupted = reading.runs.filter(check => check.state === "cancelled" || check.environment);
		const sentence =
			state === "cancelled"
				? ciSentence(verdictCi(ci))
				: "CI reported an environment failure in " + interrupted.map(check => check.name).join(", ") + ".";
		if (
			rerun?.some(
				job =>
					!reading.runs.some(check => check.name === job.name) ||
					(job.jobId && interrupted.some(check => check.jobId === job.jobId)),
			)
		) {
			return pollCi(c, fact.openItems, null, "Waiting for GitHub to report the rerun of the interrupted checks.");
		}
		if (state === "cancelled" || environmentOnly) return question(sentence, null, true);
	}
	switch (state) {
		case "passed":
			c.say("CI passed.");
			return afterCi(c, ci);
		case "not_permitted":
			c.say("CI could not be read: GitHub does not let the platform see it.");
			if (canUpdateSubtask) return question("CI could not be read on this subtask.");
			return afterCi(c, ci);
		case "incomplete":
			c.say(
				reading.kind === "read" && reading.runs.length === 0
					? "GitHub reported CI but supplied no readable check results."
					: "CI has more checks than the platform reads; none of those it read failed.",
			);
			if (canUpdateSubtask) return question("CI could not be read in full on this subtask.");
			return afterCi(c, ci);
		case "failed": {
			if (reading.kind !== "read") return;
			const fixes = repairChecks(c, fact, reading, ci);
			if (!fixes) {
				if (c.item.question) return;
				if (reading.runs.some(check => check.baseResult === "pending")) return waitForReading();
				return question(`The platform could not confirm whether this check fails on ${c.item.task.base}.`);
			}
			const plan: TurnPlan = {
				...IMPLEMENT,
				kind: "ci_fix",
				text: ciFixText(ci.head, fixes),
				charge: "ci",
				fingerprint: ciFingerprint(fixes),
				...marked([untrustedWords.ci(ci.head)]),
			};
			const sentence = ciSentence(verdictCi(ci));
			if (!ci.fixInherited && (canUpdate || fact.featureTarget)) return question(sentence, plan);
			c.say(sentence);
			return nextTurn(c, plan);
		}
		case "none":
			if (since >= CI_POLLING.noneAfterMs) {
				c.say(`No CI ran within ${spellSeconds(CI_POLLING.noneAfterMs / 1000)} of the push.`);
				if (canUpdateSubtask) return question("No passing CI reported on the subtask push.");
				return afterCi(c, ci);
			}
			break;
		case "skipped":
			// Waited for as "no CI" is: a job that needs another may not be listed yet.
			if (since >= CI_POLLING.noneAfterMs) {
				if (canUpdateSubtask) return question("CI skipped every check on the subtask push.");
				c.say(
					`CI ran, and nothing in it passed within ${spellSeconds(CI_POLLING.noneAfterMs / 1000)} of the push: every check was skipped or neutral.`,
				);
				return afterCi(c, ci);
			}
			break;
		case "not_run": {
			const sentence = ciSentence(verdictCi(ci));
			return pollCi(c, fact.openItems, null, sentence);
		}
		case "pending":
			if (workflowOverdue(reading, c.at))
				return question("A GitHub Actions workflow has been in progress for more than six hours.", null, true);
			break;
		case "retry":
			if (since >= CI_POLLING.unreachableMs)
				return question(`CI could not be read for ${spellSeconds(since / 1000)} after the push.`);
			break;
	}
	waitForReading();
}
