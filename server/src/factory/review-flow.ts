// After CI: the second agent's review, its fixes, the handoff verdict and reading the pull request.
import { MAX_NOTE_CHARS, type ChoiceId, type ItemReview } from "../contract.js";
import { CI_POLLING, ciState } from "../codehost/ci.js";
import { choice } from "./answered.js";
import { feedbackWords } from "./feedback.js";
import { checkConclusion, checkTitle } from "./verified-check.js";
import type {
	CiProgress,
	EarlierFinding,
	Fact,
	HandoffReview,
	RequestedReview,
	FactoryItem,
	Run,
	TurnPlan,
	Effect,
} from "./types.js";
import { REVIEW_TOOL } from "./reviewer-task.js";
import { untrustedWords } from "./untrusted.js";
import { REVIEW_OFF_REASON, openFindings, openFingerprint, reviewAlsoText, reviewFixText } from "./review.js";
import { gateResult } from "./verdict.js";
import {
	ask,
	askProviderRefusal,
	authors,
	automatic,
	type Change,
	checkTiming,
	currentKey,
	CUT_SHORT,
	decline,
	failuresOf,
	feedbackRefusal,
	FINAL,
	handOver,
	IMPLEMENT,
	isSha,
	marked,
	nextTurn,
	NO_GATE,
	OUTCOME_WORDS,
	outOfMemory,
	pendingCheck,
	popHeld,
	RULES,
	sandboxFailed,
	shortSha,
	spendTurn,
	stepLimitReached,
	budgetStopped,
	stop,
	SUBTASK_CHECK_QUESTION,
	subtaskChoices,
	takeFeedback,
	takeHeld,
	unsandboxedOf,
	verdictAt,
	withNote,
} from "./change.js";
import { ciFixText } from "./ci-reading.js";
import { queueReviewFix } from "./feature-flow.js";

export const movedFrom = (head: string, prHead: string | null) =>
	prHead && isSha(head) && prHead !== head ? prHead : null;

/** Request a durable, immediate read of the commit before publishing a verdict outside a CI poll. */
export function readForHandoff(c: Change, ci: CiProgress, review?: HandoffReview, repo?: string): void {
	if (review) ci.secondReview = review;
	c.enter("handoff");
	ci.last = null;
	if (c.item.state !== "review")
		c.state("waiting", { reason: "ci", sentence: `Reading CI on ${shortSha(ci.head)} for handover.`, retryAt: c.at });
	c.effects.push({ kind: "poll_ci", key: c.key, head: ci.head, at: c.at, ...(repo && { repo }) });
}

export const skippedReview = (why: string): HandoffReview => ({ review: null, reviewNone: why });
export const MOVED = "the pull request moved after the agent pushed";
export const PERSON_HANDOVER = "handed over as it is, as you asked";

const lastFiling = (review: Run["review"]) => review?.filed ?? review?.before ?? null;

/** An unreviewed head cannot inherit success after a non-approving review. */
function unfinishedReview(run: Run, review: HandoffReview): boolean {
	const last = lastFiling(run.review);
	return review.review === null && last !== null && last.recommendation !== "approve";
}

export function keptReview(run: Run, ci: CiProgress): HandoffReview {
	if (ci.secondReview?.review) return ci.secondReview;
	// A round on the same head as the one before (a fix that changed nothing) keeps that one's filing until it files its own.
	const filed = run.review?.filed ?? (run.review?.previousHead === ci.head ? run.review.before : undefined);
	if (filed && run.review?.head === ci.head)
		return {
			review: filed.id,
			reviewNone: null,
			assessment: { recommendation: filed.recommendation, blocking: filed.blocking },
		};
	return skippedReview(PERSON_HANDOVER);
}
const OLD_SUBTASK_QUESTION = "This subtask needs passing local checks and CI on its commit before integration.";

export function upgradeSubtaskQuestion(item: FactoryItem): void {
	const q = item.question;
	if (
		item.parent &&
		q?.kind === "rounds" &&
		q.text === OLD_SUBTASK_QUESTION &&
		q.choices.length === 1 &&
		q.choices[0].id === "give_up"
	) {
		q.text = SUBTASK_CHECK_QUESTION;
		q.choices = subtaskChoices();
		q.recommended = "run_checks";
		if (item.wait?.sentence === OLD_SUBTASK_QUESTION) item.wait.sentence = q.text;
	}
}

export function subtaskCheckPlan(ci: CiProgress, note: string | null = null): TurnPlan {
	const verified = ci.gate?.verified;
	const names = new Set([
		...[...(verified?.run?.checks ?? []), ...(verified?.putBack ?? [])]
			.filter(check => check.whose === "user" || check.required)
			.map(check => check.name),
		...(verified?.unrun ?? []).map(check => check.name),
	]);
	const text = `Your last turn did not run the required checks${names.size ? ` (${[...names].join(", ")})` : ""}. Run them now and fix until they pass; do not change anything else unless a check fails.`;
	return { ...IMPLEMENT, kind: "run_checks", charge: "gate", fingerprint: NO_GATE, text: withNote(text, note) };
}

export function integratePart(c: Change, ci: CiProgress, record = verdictAt(c, ci)) {
	if (c.run.lastFailure === NO_GATE) c.run.lastFailure = null;
	c.storeVerdict = { kind: "verdict", verdict: record.verdict, words: record.words };
	c.enter("subtasks");
	c.effects.push({ kind: "integrate", head: ci.head, key: c.key });
}

export function afterCi(c: Change, ci: CiProgress): void {
	const { item, run } = c;
	if (item.parent) {
		if (ci.last?.state === "none" || ci.last?.state === "skipped") {
			run.lastFailure = "integration/no-ci";
			return ask(
				c,
				"ci_timeout",
				"No passing CI reported on the subtask push. Wait for an external check or stop orchestration.",
				[choice("wait"), choice("give_up")],
				null,
				null,
			);
		}
		if (ci.moved || ci.head !== item.head || ci.last?.state !== "passed" || !isSha(ci.head))
			return ask(
				c,
				"ci_timeout",
				"CI must pass on the current subtask commit before integration.",
				[choice("wait"), choice("give_up")],
				null,
				null,
			);
		const gate = ci.gate ? gateResult(ci.gate.outcome, ci.gate.verified, ci.gate.forcedChecks) : "unverified";
		const checked = run.autoCheck?.turn === ci.gate?.turn && run.autoCheck?.head === ci.head;
		const alone =
			gate === "unverified" &&
			!ci.ciAlone &&
			checked &&
			automatic(c, "subtask_checks", `Local checks did not run on ${ci.head}.`, ["ci_alone"]);
		if (gate === "unverified" && !ci.ciAlone && !alone)
			return ask(c, "rounds", SUBTASK_CHECK_QUESTION, subtaskChoices(), null, subtaskCheckPlan(ci), undefined, {
				policy: failuresOf(run).includes(NO_GATE) || run.autoCheck ? undefined : "subtask_checks",
				evidence: ci.head,
			});
		if (gate === "fail" || gate === "incomplete")
			return ask(
				c,
				"rounds",
				"The local gate did not finish successfully.",
				[choice("run_checks"), choice("give_up")],
				null,
				null,
			);
		const record = verdictAt(c, ci);
		if (gate === "unverified") {
			const reason = alone
				? "Subtask integrated on CI alone: local checks did not run."
				: "The person accepted passing CI alone for integration. Local checks did not verify this commit.";
			record.verdict.said.ci += " " + reason;
			record.words += " " + reason;
			c.say(reason);
		}
		return integratePart(c, ci, record);
	}
	if (!ci.moved && item.feedback?.held) {
		const batch = popHeld(item.feedback)!;
		const refusal = feedbackRefusal(item, batch);
		if (refusal) decline(c, batch, refusal);
		else {
			run.endedAt = c.at;
			run.stopReason = "feedback";
			c.say(feedbackWords.afterCi(shortSha(ci.head), authors(batch)), "feedback");
			c.state("review");
			takeFeedback(c, batch);
			if (item.feedback.awaiting) c.effects.push(nextPrPoll(item, c.at));
			return;
		}
	}
	if (ci.moved !== null) return handoff(c, skippedReview(MOVED));
	if (item.mode === "orchestrate" && (ci.last?.state === "none" || ci.last?.state === "skipped"))
		return ask(
			c,
			"ci_timeout",
			"No passing CI reported on the complete feature. Wait for a check or hand over the PR.",
			[choice("wait"), ...handOver(item), choice("give_up")],
			null,
			null,
		);
	if (!item.reviewer) return handoff(c, skippedReview("this item was created before second reviews were available"));
	if ("off" in item.reviewer) return handoff(c, skippedReview(REVIEW_OFF_REASON[item.reviewer.off]));
	// Older publishers could report a branch instead of a SHA. It cannot pin an independent review.
	if (!isSha(ci.head)) return handoff(c, skippedReview("the push did not identify the commit to review"));
	startReview(c, ci);
}

export function startReview(c: Change, ci: CiProgress): void {
	const { item, run } = c;
	c.enter("review");
	ci.handed = c.key;
	// A later round reviews the builder's answer to the one before: its head, and the blocking findings it must answer.
	const before = run.review;
	const round = before ? (before.round ?? 1) + 1 : 1;
	const last = before ? lastFiling(before) : null;
	run.review = {
		verdictId: c.key,
		head: ci.head,
		refiles: 0,
		prReads: 0,
		round,
		previousHead: before?.head ?? null,
		earlier: before?.open ?? [],
		lastOpen: before?.lastOpen ?? null,
		...(last && { before: last }),
	};
	const { verdict, words } = verdictAt(c, ci);
	c.storeVerdict = { kind: "verdict", verdict, words };
	if (!item.parent) pendingCheck(c, ci.head, `Code review in progress · round ${round} · ${shortSha(ci.head)}`);
	nextTurn(c, reviewPlan(c));
	c.effects.push(nextPrPoll(item, c.at));
}

function reviewPlan(c: Change): TurnPlan {
	const { item, run } = c;
	if (!item.pr || !run.review) throw new Error("a review needs a published commit");
	return {
		...IMPLEMENT,
		kind: "review",
		to: "review",
		checkout: { head: run.review.head, base: item.task.base, pr: item.pr.number },
	};
}

export function requestedDelivery(item: FactoryItem, effect: RequestedReview) {
	const { repositoryId, installationId, pr, head, base, sender } = effect;
	const untrusted = marked(
		item.untrusted,
		effect.untrusted || item.foreignPush || item.head !== head || item.run?.ci?.head !== head || item.run.ci.moved
			? [untrustedWords.feedback("@" + sender)]
			: [],
	);
	return {
		key: effect.key,
		itemId: item.id,
		title: item.task.title,
		text: "",
		agent: null,
		maxSteps: RULES.reviewMaxSteps,
		fetchBase: null,
		startsRun: false,
		...untrusted,
		...unsandboxedOf(item, untrusted.untrusted),
		checkout: {
			requested: { repositoryId, installationId },
			pr,
			head,
			baseSha: base,
			round: 1,
			task: item.task,
			previousHead: null,
			earlier: [],
			records: [],
			report: null,
			decisions: item.decisions,
			filings: RULES.reviewFilings,
			verdictId: effect.key,
			verdictWords: "This is a requested review of the current PR head. No platform verdict is attached.",
		},
	};
}

export function reviewEnded(c: Change, fact: Extract<Fact, { kind: "review_ended" }>): void {
	const { review: pending, ci } = c.run;
	if (!pending || !ci) throw new Error("the review turn has no verdict");
	spendTurn(c, fact.spend, fact.providerRefusal);
	if (fact.refused) return readForHandoff(c, ci, skippedReview(fact.refused));
	if (fact.providerRefusal) return askProviderRefusal(c, fact.providerRefusal, reviewPlan(c));
	if (fact.sandboxFailed) return sandboxFailed(c, fact.sandboxFailed, { ...reviewPlan(c), newStep: false });
	delete c.run.step.sandboxFailures;
	if (fact.outOfMemory && fact.outcome !== "succeeded")
		return outOfMemory(c, fact.outOfMemory, { ...reviewPlan(c), newStep: false });
	if (fact.stepLimit !== undefined) return stepLimitReached(c, reviewPlan(c), fact.stepLimit);
	if (fact.budgetStopped) return budgetStopped(c, reviewPlan(c));
	if (CUT_SHORT.has(fact.outcome)) {
		c.run.step.interruptions += 1;
		c.say(`The review ${OUTCOME_WORDS[fact.outcome]}.`);
		return nextTurn(c, {
			...reviewPlan(c),
			newStep: false,
			charge: "interruptions",
			text: "You were interrupted. Continue from where you were.",
		});
	}

	const filed = fact.review;
	if (
		filed?.state !== "filed" ||
		!filed.recommendation ||
		filed.id !== c.key ||
		filed.head !== pending.head ||
		filed.verdictId !== pending.verdictId ||
		filed.run !== c.run.n ||
		filed.round !== (pending.round ?? 1)
	) {
		if (pending.refiles >= RULES.reviewRefiles)
			return readForHandoff(c, ci, skippedReview("The reviewer did not file a review the platform could read."));
		pending.refiles += 1;
		const reason = JSON.stringify((fact.said || "no readable review was filed").slice(0, 500));
		const text = `You ended your turn without a review the platform could take. File it now with ${REVIEW_TOOL}. The reported reason (quoted data): ${reason}`;
		c.say("The reviewer is asked to file again.");
		return nextTurn(c, { ...reviewPlan(c), newStep: false, text });
	}

	const open = openFindings(filed, pending.earlier);
	const blocking = open.length;
	const words = {
		approve: "approves",
		changes_requested: `asks for changes (${blocking} blocking)`,
		needs_person: "needs you",
	};
	c.say(`The second review of ${shortSha(pending.head)}: ${words[filed.recommendation]}.`);
	const assessment = { recommendation: filed.recommendation, blocking };
	c.tookReview = filed.id;
	pending.filed = {
		id: filed.id,
		trustedApproval: filed.by.via === "host" && filed.by.commandSandbox === "windlass",
		...assessment,
	};
	pending.open = open;
	const feature = c.item.mode === "orchestrate";
	if (filed.recommendation === "approve" || (feature && (filed.recommendation !== "changes_requested" || !blocking)))
		return readForHandoff(c, ci, { review: filed.id, reviewNone: null, assessment });
	// Someone pushed to the pull request during the review: a fix on the reviewed head could not be pushed over theirs. The handover says it moved.
	if (ci.moved) return readForHandoff(c, ci, { review: filed.id, reviewNone: null, assessment });
	if (!feature && personFirst(c, ci, filed)) return;
	if (filed.recommendation === "needs_person") {
		pendingCheck(c, pending.head, "Code review needs your input");
		const text = `The second agent reviewed ${shortSha(pending.head)} and has questions only you can answer. Read them in its review below; then have the agent change the work, with your note, or hand it over as it is.`;
		return ask(
			c,
			"review_question",
			text,
			[choice("fix"), ...handOver(c.item), choice("give_up")],
			null,
			reviewFixPlan(filed, true, pending.earlier),
		);
	}
	const plan = reviewFixPlan(filed, false, pending.earlier);
	const fingerprint = openFingerprint(open);
	if (fingerprint === pending.lastOpen) return stop(c, "repeated", REVIEW_REPEATED, plan);
	pending.lastOpen = fingerprint;
	if (feature && (c.run.rounds.review ?? 0) >= RULES.featureReviewFixes)
		return stop(
			c,
			"review",
			"The feature still has blocking findings after " + c.run.rounds.review + " review fixes.",
			plan,
		);
	fixAfterReview(c, plan);
}

const REVIEW_REPEATED =
	"The second agent asks again for the same changes after a round of fixes, so the factory stopped instead of trying them again.";

function reviewFixPlan(filed: ItemReview, person: boolean, earlier: EarlierFinding[] | undefined): TurnPlan {
	return {
		...IMPLEMENT,
		kind: "review_fix",
		charge: "review",
		text: reviewFixText(filed, person, earlier),
		...marked([untrustedWords.review(filed.head)]),
	};
}

export function fixAfterReview(c: Change, plan: TurnPlan): void {
	const ci = c.run.ci;
	if (ci?.moved) return readForHandoff(c, ci, keptReview(c.run, ci));
	if (c.item.mode === "orchestrate") {
		const review = c.run.review!;
		const paths = [...new Set(review.open?.flatMap(f => f.paths ?? []))];
		queueReviewFix(c, plan.text, paths, review.head);
	} else nextTurn(c, plan);
	if (c.item.question === null) sendBackForReview(c, c.run.review?.round ?? 1);
}

function sendBackForReview(c: Change, round: number): void {
	const head = c.run.review?.head;
	if (!head || c.item.parent) return;
	pendingCheck(c, head, `Addressing code review feedback · round ${round + 1}`);
	const check = c.item.pendingChecks?.find(one => one.sha === head);
	if (check) check.reviewRound = round;
}

/** Held feedback goes first and carries the reviewer's points into the next run. */
function personFirst(c: Change, ci: CiProgress, filed: ItemReview): boolean {
	const { item, run } = c;
	const f = item.feedback;
	if (!f?.held || ci.moved) return false;
	const peek = {
		ids: f.held,
		text: f.heldText,
		fingerprint: f.heldFingerprint,
		others: f.heldOthers,
		by: "github:" + f.heldWriters[0],
		writers: f.heldWriters,
	};
	const refusal = feedbackRefusal(item, peek);
	if (!refusal && peek.others && f.othersRuns >= RULES.feedbackRuns) return false;
	const batch = popHeld(f)!;
	if (refusal) {
		decline(c, batch, refusal);
		return false;
	}
	run.endedAt = c.at;
	run.stopReason = "feedback";
	c.say(feedbackWords.afterReview(shortSha(ci.head), authors(batch)), "feedback");
	c.state("review");
	takeFeedback(c, batch, false, {
		text: reviewAlsoText(filed, run.review?.earlier),
		untrusted: [untrustedWords.review(filed.head)],
	});
	return true;
}

export function handoff(c: Change, review: HandoffReview, merging = false): void {
	const { item, run } = c;
	const ci = run.ci;
	if (item.head === null || item.pr === null || ci === null || ci.head !== item.head)
		throw new Error("an item is handed over only after this run pushed its work");
	if (run.step.kind !== "handoff") c.enter("handoff");
	const reviewDone = c.item.state === "review";
	ci.handed ??= c.key;
	ci.secondReview ??= review;
	if (review.reviewNone) c.say(`No second review: ${review.reviewNone.replace(/\.$/, "")}.`);
	handVerdict(c, ci, review, merging || reviewDone || undefined);
	run.endedAt ??= c.at;
	c.state("review");
	c.enter("merged");
	c.effects.push(nextPrPoll(item, c.at));
	takeHeld(c);
	askPushCi(c);
	if (item.run !== run) {
		const handed = c.effects.find(e => e.kind === "handoff");
		if (handed) handed.continuedIn = c.run.n;
	}
}

function handVerdict(c: Change, ci: CiProgress, review: HandoffReview, reviewDone?: true): void {
	const unfinished = unfinishedReview(c.run, review);
	const record = verdictAt(c, ci, review, unfinished);
	c.effects.push({
		kind: "handoff",
		...record,
		...review,
		...(reviewDone ? { reviewDone } : {}),
		...(unfinished ? { unfinished: true as const } : {}),
	});
	const { verdict } = record;
	const key = verdict.moved ?? verdict.head;
	if (!c.item.parent && isSha(key)) {
		const assessment = review.review !== null ? (review.assessment ?? null) : null;
		const title = checkTitle(verdict, assessment, unfinished);
		c.effects.push({
			kind: "verified_check",
			key,
			state: "completed",
			...checkTiming(c),
			verdictId: verdict.id,
			conclusion: checkConclusion(verdict, assessment, unfinished),
			title,
			summary: title,
		});
		// A feedback fix, or a fix of a second review, may have a different SHA. Its evidence belongs to the new head.
		const reviewed = c.run.review;
		for (const check of c.item.pendingChecks ?? [])
			if ((check.feedback || check.reviewRound !== undefined) && check.sha !== key) {
				// A later round of this run's review names itself; a reviewed head an earlier run left behind is rework like any other.
				const round = reviewed?.round ?? 1;
				const title =
					check.reviewRound === undefined || round <= check.reviewRound
						? "Rework handed over on " + shortSha(key)
						: `${assessment?.recommendation === "approve" ? "Fixed" : "Reworked"} in round ${round} on ${shortSha(key)}`;
				c.effects.push({
					kind: "verified_check",
					key: check.sha,
					existingOnly: true,
					state: "completed",
					...checkTiming(c),
					verdictId: null,
					conclusion: "cancelled",
					title,
					summary: title + ".",
				});
			}
		c.item.pendingChecks = c.item.pendingChecks?.filter(
			check => check.sha !== key && !check.feedback && check.reviewRound === undefined,
		);
	}
	c.say(record.words);
}

/** A PR read during the pinned review has its own attempt, independent of reviewer deliveries and refilings. */
export function prPollKey(item: FactoryItem): string | null {
	if (item.state === "failed" || FINAL.has(item.state)) return null;
	const run = item.run;
	if (run?.step.kind === "merged" || item.feedback?.awaiting) return currentKey(item);
	if (run?.step.kind === "review" && run.review) return `${run.review.verdictId}/pr${run.review.prReads ?? 0}`;
	return null;
}

export function nextPrPoll(item: FactoryItem, at: number): Extract<Effect, { kind: "poll_pr" }> {
	const key = prPollKey(item);
	if (!key || !item.pr) throw new Error("A PR poll needs a review and a published pull request");
	return {
		kind: "poll_pr",
		key,
		pr: item.pr.number,
		at: at + (item.run?.ci?.webhooks ? CI_POLLING.webhookPrEveryMs : CI_POLLING.prEveryMs),
	};
}

function askPushCi(c: Change) {
	const push = c.run.ci?.reviewPush;
	if (c.item.state !== "review" || c.item.question || !push?.failure || push.asked || push.head !== c.run.ci?.moved)
		return;
	push.asked = true;
	ask(
		c,
		"push_ci",
		"CI failed after your push to " + shortSha(push.head) + ". Hand it back to fix?",
		[choice("send_back"), choice("dismiss")],
		null,
		null,
	);
}

/**
 * The draft feature PR's ready-for-review step after handover. GitHub kept refusing it: the person is asked to mark the
 * PR ready (or try again). Ready, by the platform or by the person: that question is settled.
 */
export function prReadyRead(c: Change, fact: Extract<Fact, { kind: "pr_ready_read" }>): boolean {
	const { item } = c;
	if (item.mode !== "orchestrate" || item.pr?.number !== fact.pr || item.run?.step.kind !== "merged") return false;
	if (fact.refused === null) {
		if (!readySettled(c, `Pull request #${fact.pr} is ready for review.`))
			c.say(`Pull request #${fact.pr} is ready for review.`);
		return true;
	}
	if (!["review", "waiting"].includes(item.state)) return false;
	const text =
		`GitHub refused to mark pull request #${fact.pr} ready for review: ${fact.refused.replace(/\.?$/, ".")} ` +
		"Everything else is handed over. Mark it ready on GitHub yourself, or try again.";
	if (item.question && item.question.kind !== "ready_refused") {
		c.say(text);
		return true;
	}
	ask(c, "ready_refused", text, [choice("again"), choice("dismiss")], null, null);
	return true;
}

function readySettled(c: Change, said: string): boolean {
	if (c.item.question?.kind !== "ready_refused") return false;
	c.item.question = null;
	c.state("review");
	c.say(said);
	return true;
}

/** The answer to a `ready_refused` question: "Try again" marks the PR ready once more; "Dismiss" leaves the draft to the person. */
export function readyAnswer(c: Change, choice: ChoiceId): boolean {
	const { item, run } = c;
	if (!item.pr || (choice !== "again" && choice !== "dismiss")) return false;
	c.state("review");
	if (choice === "again") c.effects.push({ kind: "ready_pr", key: c.key, run: run.n, pr: item.pr.number });
	return true;
}

export function prRead(c: Change, fact: Extract<Fact, { kind: "pr_read" }>): void {
	const { run } = c;
	// The person marked the feature PR ready on GitHub.
	if (fact.state === "open") readySettled(c, "The pull request is ready for review on GitHub.");
	if (fact.state === "merged" || fact.state === "closed") {
		if (c.item.feedback?.awaiting || c.item.question?.kind === "push_ci" || c.item.question?.kind === "ready_refused")
			c.item.question = null;
		if (run.step.kind === "review") {
			if (run.step.turn) c.effects.push({ kind: "withdraw", key: c.key, to: "review" });
			run.step.turn = null;
			run.endedAt = c.at;
			c.item.question = null;
		}
		if (fact.state === "merged" && run.ci?.autoMergeKey && fact.mergedByApp && fact.prHead === run.ci.head)
			c.say("Merged automatically: verdict pass, CI green, review approved.");
		c.sayOfItem(
			fact.state === "merged" ? "The pull request was merged." : "The pull request was closed without merging.",
		);
		return c.state(fact.state === "merged" ? "done" : "cancelled");
	}
	const ci = run.ci;
	if (ci) ci.webhooks = fact.webhooks;
	if (c.item.feedback?.awaiting) {
		run.step.attempt++;
		c.effects.push(nextPrPoll(c.item, c.at));
		return;
	}
	if (run.step.kind === "review" && run.review) {
		run.review.prReads = (run.review.prReads ?? 0) + 1;
		// Keep the filing tied to the reviewed head. Handover rereads CI and the PR before exposing it.
		if (ci && fact.prHead !== null) ci.moved = movedFrom(ci.head, fact.prHead);
		c.effects.push(nextPrPoll(c.item, c.at));
		return;
	}
	run.step.attempt += 1;
	// After handover, a move replaces the public verdict.
	if (c.item.question?.kind === "push_ci" && fact.prHead && fact.prHead !== ci?.moved) {
		c.item.question = null;
		c.state("review");
	}
	if (ci && fact.prHead && c.item.state === "review" && c.item.mode !== "orchestrate" && !c.item.machineRemoved) {
		if (fact.prHead !== ci.moved) ci.reviewPush = movedFrom(ci.head, fact.prHead) ? { head: fact.prHead } : undefined;
		const push = ci.reviewPush,
			reading = fact.pushCi;
		if (push && !push.asked && reading?.kind === "read" && reading.head === push.head && ciState(reading) === "failed")
			push.failure = ciFixText(push.head, reading).slice(0, MAX_NOTE_CHARS);
	}
	if (ci !== null && fact.prHead !== null && movedFrom(ci.head, fact.prHead) !== ci.moved) {
		ci.moved = movedFrom(ci.head, fact.prHead);
		c.say(
			ci.moved === null
				? `The pull request is back at ${shortSha(ci.head)}, the commit this run pushed.`
				: `The pull request moved to ${shortSha(ci.moved)} after it was handed over.`,
		);
		return readForHandoff(c, ci);
	}
	askPushCi(c);
	c.effects.push(nextPrPoll(c.item, c.at));
}
