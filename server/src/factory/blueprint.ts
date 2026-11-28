/**
 * The blueprint: the fixed sequence a work item runs, as a pure function over the item and the facts that reach it.
 * The model decides only inside a turn; the next step comes from what the platform observed, never from the agent.
 *
 *   refine (features) → implement → gate (verification; fail → fix turn) → publish (push, PR) → ci (fail → ci_fix,
 *   conflict → merge turn) → review (optional; changes → review_fix) → handoff → merged (done or cancelled)
 *
 * Stop rules, checked before every turn: a repeated failure fingerprint asks "Try it once more"; a used-up budget
 * pauses and asks; a turn backstop and 3 cut-off turns per step end loops. Nothing stops silently or discards work.
 *
 * The actor stores what `advance` returns in one write, then performs the effects by key. Facts name their attempt
 * key; a stale key changes nothing. No clock is read: every time is a fact's `at`.
 */
import { defaultPlaceRetryAt } from "./default-place.js";
import { criticPrompt, mergeCandidate, smallPlanProblem } from "./autonomy.js";
import { MAX_SECRET_REQUESTS, secretRequestLimit } from "../repo-secrets.js";
import { isDeepStrictEqual } from "node:util";
import type { FeatureRepository, HarnessId, ItemAgent, Verified, VerifiedCheck } from "../contract.js";
import { ciPollEvery } from "../codehost/ci.js";
import { spellSeconds } from "../usage.js";
import { contextAtPlace, partRun, resolveRun, runPlace } from "./resolve-run.js";
import {
	hostedTerms,
	reviewPart,
	bindRoute,
	choosePlacement,
	freeMachineSlots,
	machineSlots,
	placementRetryAt,
	type PlacementInventory,
} from "./placement.js";
import { answeredWords, choice } from "./answered.js";
import { feedbackWords } from "./feedback.js";
import type { FeedbackInput } from "./types.js";
import {
	validatePlan,
	planScope,
	PlanError,
	editablePartAgents,
	subtaskHarness,
	unsupportedParts,
	unattendedKeys,
	agentProfileProblem,
	agentOf,
} from "./feature-plan.js";
import {
	aliases,
	boundRepos,
	crossFact,
	crossRepo,
	featureOpened,
	integrationAnswer,
	recordIntegrated,
	recordOpened,
	recordSeed,
	repoOf,
} from "./cross-repo.js";
import { refusalMessage } from "../provider-refusal.js";
import { budgetStop, itemAgent, newAgent, noSpend, retryAt, spellTokens, spellUsd, unmeasuredTurn } from "./budget.js";
import { environmentFailure, outputExcerpt, type EnvironmentFailure } from "./check-environment.js";
import type {
	ChoiceId,
	Fact,
	StepFact,
	FeatureJob,
	FactoryItem,
	ItemBudget,
	ItemSpend,
	Outcome,
	Question,
	StopCause,
	Task,
	TurnPlan,
	TurnStepKind,
} from "./types.js";
import { runAnywayWords, sources, thirdParty, untrustedWords } from "./untrusted.js";
import { harnessName, worksWithoutAsking } from "../sandbox/harnesses.js";
import { gateFingerprint, gateResult } from "./verdict.js";
import {
	activeJob,
	ask,
	ASKING,
	askPlacement,
	askPlan,
	askProviderRefusal,
	askRemoved,
	AUTO_POLICY,
	automatic,
	backstopTurns,
	beginRun,
	retryRun,
	Change,
	chargeTurn,
	checkTurn,
	completedKeys,
	currentKey,
	CUT_SHORT,
	decided,
	decline,
	dispatchAgain,
	dispatchJob,
	extraOf,
	failingNames,
	failuresOf,
	featureBranches,
	featureTotal,
	feedbackState,
	FINAL,
	firstPlan,
	gateFixText,
	handOver,
	handOverAny,
	hostedChoice,
	IMPLEMENT,
	isSha,
	marked,
	nextTurn,
	NO_GATE,
	noteHostedTime,
	OUTCOME_WORDS,
	outOfMemory,
	ownSpent,
	ownTokens,
	confirmPayerChoice,
	pendingCheck,
	plannerBudgetText,
	popHeld,
	repair,
	replanning,
	resetRun,
	RULES,
	sandboxFailed,
	shortSha,
	spendTurn,
	stepLimitReached,
	budgetStopped,
	takeFeedback,
	takeHeld,
	taskText,
	turnBudgetStop,
	verdictAt,
	withNote,
} from "./change.js";
import { ciProgress, conflictPlan, featureCiBranch, rerunKey } from "./ci-reading.js";
import {
	approveFeature,
	cancelActive,
	featureCiQuestion,
	featureUpdateChoice,
	flow,
	followFeatureHead,
	grantFeatureUpdate,
	integratedTip,
	nextChild,
	queueConflictFix,
	queueFeatureCi,
	queueReviewFix,
	readFeatureCi,
	readUpdatedCi,
	refreshPlan,
	requestFeatureUpdate,
	retryFeature,
	runSingle,
	watchingParts,
} from "./feature-flow.js";
import {
	fixAfterReview,
	keptReview,
	MOVED,
	PERSON_HANDOVER,
	prPollKey,
	prRead,
	prReadyRead,
	readyAnswer,
	readForHandoff,
	reviewEnded,
	skippedReview,
	startReview,
	subtaskCheckPlan,
} from "./review-flow.js";
import { decideCi, pollCi, publish, published, publishFailed, stopPendingChecks, updateFromBase } from "./ci-flow.js";
export {
	RULES,
	stepKey,
	currentKey,
	FRESH_START,
	personAdds,
	plannerBudgetText,
	turnCheckEffect,
	activeJob,
	completedKeys,
	TRY_AGAIN_LABEL,
} from "./change.js";
export { rerunKey, featureCiBranch } from "./ci-reading.js";
export { featureCiQuestion, featureUpdateChoice, canUpdateFeature, watchingParts } from "./feature-flow.js";
export { upgradeSubtaskQuestion, requestedDelivery, prPollKey, nextPrPoll } from "./review-flow.js";

export function reviewSendsBack(item: FactoryItem): boolean {
	return (
		!item.parent &&
		item.mode !== "orchestrate" &&
		item.reviewer !== undefined &&
		"on" in item.reviewer &&
		item.place.kind === "hosted"
	);
}

export interface NewItem {
	mode?: FactoryItem["mode"];
	/** A cross-repo feature's repositories as the filing bound them, the primary first. */
	repos?: FeatureRepository[];
	id: string;
	task: Task;
	reviewer: FactoryItem["reviewer"];
	place: FactoryItem["place"];
	budget: ItemBudget;
	agent?: { harness: HarnessId; model: string; effort?: string | null; signIn?: ItemAgent["signIn"] };
}

export function createItem(input: NewItem): FactoryItem {
	return {
		id: input.id,
		revision: 0,
		state: "draft",
		wait: null,
		task: input.task,
		...(input.repos && input.repos.length > 1 && input.mode === "orchestrate" && { repos: boundRepos(input.repos) }),
		mode: input.mode ?? "single",
		reviewer: input.reviewer,
		place: input.place,
		machineRemoved: false,
		singleBudget: { ...input.budget },
		// A feature's budget is its own allowance until a plan adds its subtasks' (`featureTotal`): tokens, while its parts
		// get dollars of their own (budget.ts `partShare`).
		budget:
			input.mode === "orchestrate"
				? { tokens: input.budget.tokens, hostedSeconds: input.budget.hostedSeconds }
				: { ...input.budget },
		...(input.mode === "orchestrate" && { ownTokens: input.budget.tokens }),
		spent: noSpend(),
		...(input.agent && {
			agent: newAgent(input.agent.harness, input.agent.model, input.agent.effort, input.agent.signIn),
		}),
		workingSince: null,
		run: null,
		pr: null,
		head: null,
		question: null,
	};
}

export function canRetry(item: FactoryItem): boolean {
	return item.state === "failed" && !item.machineRemoved && !item.parent && (!item.jobs?.length || !!item.approvedPlan);
}

/** Use the fact's clock. Stale deliveries return the original item with no effects or events. */
export function advance(item: FactoryItem, fact: Fact): Outcome {
	const unchanged: Outcome = { item, effects: [], events: [] };
	const withdrawn =
		(fact.kind === "turn_ended" || fact.kind === "review_ended") && item.pushWithdrawals?.includes(fact.key);
	const receipt =
		(fact.kind === "turn_ended" || fact.kind === "review_ended") &&
		item.state === "cancelled" &&
		(item.parent || item.mode === "orchestrate") &&
		item.run?.step.turn &&
		fact.key === currentKey(item);
	if (item.claimedSecret && fact.kind !== "settle_secret") return unchanged;
	if (
		FINAL.has(item.state) &&
		fact.kind !== "child_notice" &&
		fact.kind !== "finish_join" &&
		fact.kind !== "feature_updated" &&
		!receipt &&
		!withdrawn
	)
		return unchanged;
	const change = new Change(
		structuredClone(item),
		fact.at,
		"by" in fact ? (fact.by ?? "platform") : "platform",
		takeChoice,
	);
	if (item.run?.ci?.moved) change.item.foreignPush = true; // Includes moves stored before this flag existed.
	if (withdrawn) {
		change.item.pushWithdrawals = item.pushWithdrawals!.filter(key => key !== fact.key);
		chargeTurn(change.item, fact.spend);
	} else if (receipt) spendTurn(change, fact.spend);
	else if (!apply(change, fact)) return unchanged;
	if (watchingParts(change.item)) {
		const started = !watchingParts(item) && fact.kind !== "ci_read";
		for (const target of featureBranches(change.item)) {
			if (target.featureCi?.afterParts && target.featureCi.head === target.head && change.item.jobs?.some(activeJob))
				continue;
			if (
				target.featureCi &&
				target.head &&
				(target.featureCi.head !== target.head || target.featureCi.afterParts || started)
			) {
				const decision = target.featureCi.head === target.head ? target.featureCi : undefined;
				target.featureCi = {
					head: target.head,
					since: fact.at,
					waitForBase: decision?.waitForBase,
					fixInherited: decision?.fixInherited,
				};
				queueFeatureCi(change, "alias" in target ? target.alias : undefined);
			}
		}
	}
	if (change.item.run?.ci?.moved) change.item.foreignPush = true;
	if (change.item.requestedReview && (FINAL.has(change.item.state) || change.item.state === "failed")) {
		change.effects.push({ kind: "withdraw", key: change.item.requestedReview.key, to: "review" });
		delete change.item.requestedReview;
	}
	if (
		change.item.feedback &&
		(FINAL.has(change.item.state) || change.item.state === "failed" || change.item.machineRemoved)
	) {
		const f = change.item.feedback;
		for (const batch of [f.awaiting, popHeld(f)])
			if (batch)
				decline(
					change,
					batch,
					change.item.machineRemoved ? feedbackWords.machineRemoved : feedbackWords.ended(change.item.state),
				);
		f.awaiting = null;
	}
	change.item.revision += 1;
	return {
		item: change.item,
		effects: change.effects,
		events: change.events,
		...(change.feedback.length && { feedback: change.feedback }),
		...(change.storeVerdict && { storeVerdict: change.storeVerdict }),
		...(change.tookReview && { tookReview: change.tookReview }),
	};
}

function askRunPlace(c: Change, reason: string) {
	const run = c.item.resolved;
	const hosted = !c.item.awaitingReviewer && run?.place !== "hosted" && run?.fallback === "hosted" && !c.item.useHosted;
	// A recovered run keeps its filed place, even if no machine is available yet.
	const choices: Question["choices"] = [run?.payer === "unconfirmed" ? confirmPayerChoice : choice("wait")];
	if (hosted) choices.push(hostedChoice(run?.agent));
	choices.push(choice("give_up"));
	ask(c, "run_place", reason, choices, null, null);
}

function waitForDefaultPlace(
	c: Change,
	sentence: string,
	at = defaultPlaceRetryAt(c.at, c.item.placeAttempts ?? 0),
): boolean {
	c.item.placeAttempts = (c.item.placeAttempts ?? 0) + 1;
	if (c.item.wait?.sentence !== sentence) c.say(sentence);
	c.item.awaitingPlace = sentence;
	c.state("waiting", { reason: "machine", sentence, retryAt: at });
	c.effects.push({ kind: "resolve_default_place", key: String(at), at });
	return true;
}

function recordRun(item: FactoryItem, fact: Extract<Fact, { kind: "turn_started" }>) {
	if (!fact.actual) return;
	const role = fact.role ?? item.runRole ?? "builder";
	const run = role === item.runRole && item.resolved ? item.resolved : resolveRun(item.context ?? {}, role);
	const { size, payerSource, ...actual } = fact.actual;
	const sources = { ...run.sources };
	if (payerSource) sources.payer = payerSource;
	if (item.useHosted) sources.place = "item";
	(item.ranWith ??= {})[role] = { ...run, ...actual, sources, size: size ?? null };
}

function apply(c: Change, fact: Fact): boolean {
	const { item } = c;
	if (fact.kind === "turn_started" && item.requestedReview?.key === fact.key && fact.role === "reviewer") {
		recordRun(item, fact);
		return true;
	}
	if (fact.kind === "review_ended" && item.requestedReview?.key === fact.key) {
		const request = item.requestedReview;
		delete item.requestedReview;
		chargeTurn(item, fact.spend);
		const review = fact.review;
		if (
			fact.outcome === "succeeded" &&
			review?.state === "filed" &&
			review.id === fact.key &&
			review.head === request.head &&
			review.base === request.base
		) {
			c.tookReview = review.id;
			c.effects.push({ ...request, kind: "post_requested_review" });
		} else
			c.sayOfItem(
				`Requested review of PR #${request.pr} at ${shortSha(request.head)}: ${fact.refused || fact.said || "The reviewer did not file a review."}`,
			);
		return true;
	}
	switch (fact.kind) {
		case "request_review":
			if (
				!item.run ||
				item.state === "failed" ||
				item.machineRemoved ||
				item.requestedReview ||
				(item.run.step.kind === "review" && item.run.step.turn)
			)
				return false;
			if (turnBudgetStop(c) || backstopTurns(item) >= RULES.turnBackstop) return false;
			item.requestedReview = fact.request;
			c.effects.push({ ...fact.request, kind: "requested_review", to: "review" });
			return true;
		case "github_feedback": {
			const f = feedbackState(item);
			if (fact.ids.every(id => f.lastIds.includes(id) || f.taken.includes(id))) return false;
			f.lastIds = fact.ids;
			const batch: FeedbackInput = {
				ids: fact.ids,
				text: fact.text,
				fingerprint: fact.fingerprint,
				others: fact.others,
				by: fact.by,
				writers: fact.writers,
			};
			if (item.machineRemoved || item.parent || item.state === "failed" || item.state === "draft" || crossRepo(item)) {
				decline(
					c,
					batch,
					item.machineRemoved
						? feedbackWords.machineRemoved
						: item.parent
							? feedbackWords.child
							: crossRepo(item)
								? "Feedback on a cross-repo feature is not taken yet."
								: feedbackWords.ended(item.state),
				);
			} else if (item.state === "review") takeFeedback(c, batch);
			else {
				// The actor refits all still-held entries and new entries together, oldest first.
				f.held = batch.ids;
				f.heldText = batch.text;
				f.heldFingerprint = batch.fingerprint;
				f.heldWriters = batch.writers ?? [batch.by.replace(/^github:/, "")];
				f.heldOthers = batch.others;
				c.feedback.push({ ids: batch.ids, state: "held", reason: feedbackWords.held });
				c.say(feedbackWords.heldLog);
			}
			return true;
		}
		case "update_feature":
			if (fact.automatic && (item.run?.autoHistory?.feature_ahead?.length || backstopTurns(item) >= RULES.turnBackstop))
				return false;
			if (!requestFeatureUpdate(c, fact.target, fact.request, fact.child)) return false;
			if (fact.automatic) automatic(c, "feature_ahead", fact.target!, ["update_feature"]);
			return true;
		case "feature_updated": {
			const update = item.featureUpdate;
			if (!update || update.key !== fact.key || item.joining?.child !== item.id || item.joining.key !== fact.key)
				return false;
			delete item.featureUpdate;
			delete item.joining;
			const job = update.child && item.jobs?.find(j => j.id === update.child);
			if (job) job.featureUpdateReceipt = update.key;
			if ("head" in fact.result) {
				if (update.repo) recordIntegrated(item, update.repo, fact.result.head);
				else item.head = fact.result.head;
				const ci = featureCiBranch(item, update.repo).featureCi;
				if (ci) delete ci.waitForBase;
				c.say(
					`Updated the feature from ${update.repo ? repoOf(item, update.repo).baseRef : item.task.base} to ${shortSha(fact.result.head)}.`,
				);
			}
			if (FINAL.has(item.state) || item.state === "failed" || item.machineRemoved) return true;
			if ("problem" in fact.result) {
				ask(
					c,
					"feature_update",
					fact.result.problem,
					[{ id: "update_feature", label: "Check the feature branch again" }, choice("give_up")],
					null,
					null,
					undefined,
					{ target: update.target, updateRepo: update.repo },
				);
			} else if ("head" in fact.result && c.run.step.kind === "ci") {
				c.run.ci = ciProgress(fact.result.head, c.at, null, c.run.ci?.webhooks ?? false);
				readUpdatedCi(c);
				pendingCheck(c, fact.result.head, "Waiting for CI on " + shortSha(fact.result.head));
			} else {
				if ("conflicts" in fact.result) {
					if (c.run.step.kind !== "subtasks") c.enter("subtasks");
					queueConflictFix(c, { target: update.target, child: update.child }, fact.result.conflicts, update.repo);
				}
				c.state("waiting", {
					reason: "children",
					sentence:
						"conflicts" in fact.result
							? "Resolving the feature update conflicts."
							: "Continuing subtasks on the updated feature branch.",
					retryAt: null,
				});
				for (const job of item.jobs ?? []) if (activeJob(job) && (!repair(job) || job.dispatchKey)) dispatchJob(c, job);
				nextChild(c);
			}
			return true;
		}
		case "parent_update_finished":
			if (!item.parent || fact.key !== c.key || c.run.step.kind !== "ci" || item.question || !c.run.ci) return false;
			readUpdatedCi(c);
			return true;
		case "claim_join": {
			const job = item.jobs?.find(j => j.id === fact.child);
			if (
				item.joining ||
				!job ||
				job.join?.key === fact.key ||
				!activeJob(job) ||
				job.cancelRequested ||
				item.question ||
				item.state !== "waiting" ||
				item.run?.step.kind !== "subtasks"
			)
				return false;
			item.joining = { child: fact.child, key: fact.key };
			return true;
		}
		case "finish_join": {
			if (item.joining?.child !== fact.child || item.joining.key !== fact.result.key) return false;
			const job = item.jobs!.find(j => j.id === fact.child)!;
			delete item.joining;
			job.join = fact.result;
			if ("head" in fact.result) integratedTip(item, job, fact.result.head);
			if (item.featureUpdate) grantFeatureUpdate(c);
			return true;
		}
		case "cancel_subtask": {
			const job = item.jobs?.find(j => j.task.key === fact.key && activeJob(j));
			if (
				!job ||
				job.cancelRequested ||
				item.run?.step.kind !== "subtasks" ||
				item.question ||
				item.state !== "waiting"
			)
				return false;
			job.cancelRequested = true;
			c.say("Requested cancellation of " + job.task.title + ".");
			c.effects.push({ kind: "cancel_children", key: String(item.revision + 1), ids: [job.id] });
			return true;
		}
		case "child_notice": {
			const job = item.jobs?.find(j => j.id === fact.child);
			if (!job) return false;
			const charged = chargeChild(item, job, fact.spent, fact.budget);
			// Old child actors can still send a fast-forward receipt without a serialized join.
			if (fact.integratedHead && !job.join && job.state !== "done") integratedTip(item, job, fact.integratedHead);
			if (
				(FINAL.has(item.state) || item.state === "failed" || item.machineRemoved) &&
				(FINAL.has(fact.state) || fact.state === "failed")
			) {
				const changed = job.state !== fact.state;
				job.state = fact.state;
				if (fact.integratedHead) job.head = fact.integratedHead;
				return changed || charged;
			}
			if (
				activeJob(job) &&
				(!repair(job) || job.dispatchKey) &&
				item.run?.step.kind === "subtasks" &&
				!item.question &&
				item.state === "waiting"
			) {
				dispatchJob(c, job);
				return true;
			}
			return charged;
		}
		case "edit_plan":
		case "file_plan":
			return proposePlan(c, fact);
		case "refresh_plan":
			if (!planQuestion(item) || item.featurePlan?.version !== fact.version || item.filedTurn !== c.key) return false;
			return refreshPlan(c, fact.inventory) !== null;
		case "approve_plan":
			if (!planQuestion(item) || item.featurePlan?.version !== fact.version) return false;
			return approveFeature(c, fact.inventory, fact.agents, fact.bases);
		case "set_subtask_agent": {
			const plan = item.featurePlan;
			if (
				!plan ||
				!editablePartAgents(
					plan,
					item.state,
					item.run?.step.kind,
					(item.jobs ?? []).map(j => j.task.key),
				).includes(fact.key)
			)
				return false;
			const task = plan.subtasks.find(s => s.key === fact.key);
			if (!task || !fact.inventory) return false;
			const agent = fact.agent === null ? undefined : agentOf(fact.agent);
			const next = { ...task, agent };
			reviewPart(next, item.context, item.place, !!plan.overflow, fact.inventory);
			if (!agent) delete next.agent;
			const problem = agentProfileProblem(next);
			if (problem) throw new PlanError(problem);
			if (next.placementProblem) throw new PlanError(next.placementProblem);
			for (const p of [plan, item.approvedPlan]) {
				const kept = p?.subtasks.find(s => s.key === fact.key);
				if (kept) Object.assign(kept, next);
				if (kept && agent) kept.agent = structuredClone(agent);
				else if (kept) delete kept.agent;
			}
			const model = next.resolved?.model ?? agent?.model;
			c.say(`‘${task.title}’ will run ${harnessName(subtaskHarness(next))}${model ? " on " + model : ""}.`);
			return true;
		}
		case "run_single":
			if (!planQuestion(item) || item.replans) return false;
			runSingle(c);
			return true;
		case "machine_removed":
			if (item.awaitingPlace || item.place.kind !== "machine" || item.machineRemoved) return false;
			if (item.joining?.child !== item.id) delete item.featureUpdate;
			// An in-flight ref write needs no machine. Let its receipt release the parent's durable grant.
			if (item.parent && item.run?.step.kind === "subtasks" && !item.question) {
				if (item.cancelAfterIntegration) return false;
				item.cancelAfterIntegration = true;
				return true;
			}
			item.machineRemoved = true;
			cancelActive(c);
			if (item.state === "failed") return true;
			if (item.run?.step.turn) c.effects.push({ kind: "withdraw", key: c.key });
			askRemoved(c);
			return true;
		case "branch_push":
			return branchPushed(c, fact);
		case "reverify": {
			const ci = item.run?.ci;
			if (
				item.state !== "review" ||
				item.run?.step.kind !== "merged" ||
				!ci ||
				(fact.head !== ci.head && fact.head !== ci.moved)
			)
				return false;
			if (item.lastReverifyAt !== undefined && c.at < item.lastReverifyAt + 60_000) return false;
			item.lastReverifyAt = c.at;
			readForHandoff(c, ci);
			return true;
		}
		case "start":
			if (item.state !== "draft") return false;
			c.say("Started.");
			if (item.awaitingPlace) {
				askRunPlace(c, item.awaitingPlace);
				return true;
			}
			beginRun(c, firstPlan(item, null));
			return true;
		case "default_place_wait":
			if (!item.awaitingPlace || item.question || item.state !== "waiting") return false;
			if (fact.reviewer) item.awaitingReviewer = true;
			if (fact.sentence !== item.awaitingPlace) {
				item.awaitingPlace = fact.sentence;
				askRunPlace(c, fact.sentence);
				return true;
			}
			return waitForDefaultPlace(c, fact.sentence);
		case "default_place_ready":
			if (!item.awaitingPlace || item.question || item.state !== "waiting") return false;
			delete item.awaitingPlace;
			delete item.awaitingReviewer;
			delete item.placeAttempts;
			item.reviewer = fact.reviewer;
			item.place = fact.place;
			item.agent = fact.agent;
			if (item.context && item.useHosted) {
				item.resolved = resolveRun(contextAtPlace(item.context, "hosted"), item.runRole ?? "builder");
			}
			if (item.resolved) {
				item.resolved.model ??= fact.agent.model;
				item.resolved.place = runPlace(fact.place);
			}
			c.say("The selected place is ready.");
			beginRun(c, firstPlan(item, null));
			return true;
		case "retry":
			if (!canRetry(item)) return false;
			c.say("Started again.");
			if (item.jobs?.length) retryFeature(c);
			else retryRun(c, firstPlan(item, null));
			return true;
		case "send_back":
			return sendBack(c, fact.note);
		case "note":
			if (item.mode === "orchestrate") return false;
			c.sayOfItem(fact.steered ? `Note to the running turn: ${fact.note}` : `Note for the next turn: ${fact.note}`);
			if (!fact.steered) item.ownerNote = item.ownerNote ? `${item.ownerNote}\n\n${fact.note}` : fact.note;
			if (item.run) decided(item, { kind: "note", run: item.run.n, text: fact.note });
			return true;
		case "cancel":
			// The durable fast-forward may already be at GitHub. Settle it before reporting a terminal child state.
			if (item.parent && item.run?.step.kind === "subtasks" && !item.question) {
				if (item.cancelAfterIntegration) return false;
				item.cancelAfterIntegration = true;
				c.say("Cancellation requested while confirming the feature branch update.");
				return true;
			}
			if (item.joining?.child !== item.id) delete item.featureUpdate;
			cancel(c);
			return true;
		case "claim_secret": {
			const q = item.question;
			if (q?.kind !== "secret_needed" || q.id !== fact.question || q.secret?.name !== fact.name) return false;
			item.claimedSecret = q;
			item.question = null;
			c.state("waiting", { reason: "person", sentence: `Saving ${fact.name}.`, retryAt: null });
			return true;
		}
		case "settle_secret": {
			const q = item.claimedSecret;
			if (!q || q.id !== fact.question) return false;
			delete item.claimedSecret;
			item.question = q;
			if (!fact.error)
				return answer(c, { kind: "answer", question: q.id, choice: "add_secret", by: fact.by, at: fact.at });
			const text = [`A secret was requested for ${q.secret!.name}.`, q.secret?.notice, fact.error]
				.filter(Boolean)
				.join("\n");
			ask(c, q.kind, text, q.choices, q.cause, q.resume, fact.error, { secret: q.secret });
			return true;
		}
		case "answer":
			return answer(c, fact);
		case "integration_started":
		case "integration_read":
		case "repo_pr_read":
		case "repo_pr_lost":
			return item.run !== null && crossRepo(item) && crossFact(flow(c), fact, item.approvedPlan?.finalIntegration);
		case "ci_rerun_result": {
			const rerun = item.ciReruns?.[rerunKey(fact)];
			if (!rerun || rerun.reported) return false;
			rerun.reported = true;
			for (const job of rerun.jobs) if (job.jobId && !fact.accepted.includes(job.jobId)) job.jobId = null;
			c.say(fact.said);
			return true;
		}
		case "sandbox_reclaimed":
			c.say(fact.said);
			return true;
		case "pr_ready_read":
			return prReadyRead(c, fact);
		case "spent":
			if (item.place.kind !== "hosted" || !(fact.hostedSeconds > item.spent.hostedSeconds)) return false;
			item.spent.hostedSeconds = fact.hostedSeconds;
			noteHostedTime(item, fact.hosted);
			return true;
		default:
			return stepFact(c, fact);
	}
}

function stepFact(c: Change, fact: StepFact): boolean {
	const run = c.item.run;
	if (run === null || c.item.featureUpdate) return false;
	const step = run.step;
	const key = c.key;
	// A withdrawal can race a turn's receipt or a push already on its way to GitHub.
	if (c.item.question?.kind === "machine_removed" || (c.item.machineRemoved && c.item.state === "failed")) {
		if (fact.key !== key) return false;
		if (fact.kind === "turn_ended" && step.turn === "started") {
			spendTurn(c, fact.spend, fact.providerRefusal);
			return true;
		}
		if (fact.kind === "published" && step.kind === "publish" && c.item.question?.kind === "machine_removed") {
			published(c, fact);
			return true;
		}
		return false;
	}
	// These receipts name a child dispatch, poll, or merge attempt checked by its owner.
	switch (fact.kind) {
		case "place_child":
		case "placement_wait": {
			const job = fact.child ? c.item.jobs?.find(j => j.id === fact.child) : c.item.jobs?.at(-1);
			if (
				!job ||
				fact.key !== (job.dispatchKey ?? key) ||
				step.kind !== "subtasks" ||
				c.item.question ||
				job.cancelRequested ||
				job.state !== "draft"
			)
				return false;
			if (fact.kind === "placement_wait") {
				if (job.id !== fact.child) return false;
				if (fact.askMachine || fact.refused) return placementRefused(c, job, fact.sentence, fact);
				return waitForPlacement(c, job, fact.sentence, fact);
			}
			if (job.placement) return false;
			job.route ??= bindRoute(job.task, c.item.place, false, fact.inventory.machines);
			const fit = choosePlacement(job.task, job.route, { ...fact.inventory, defaults: c.item.context }, job.warm, c.at);
			if (fit.decision) {
				delete job.placementWaitSince;
				const run = job.task.resolved;
				if (repair(job) && run && worksWithoutAsking(run.agent)) {
					const place = fit.decision;
					job.repairOffer = place;
					const agent = [harnessName(run.agent), run.model, run.effort].filter(Boolean).join(" · ");
					run.place = runPlace(place.place);
					run.payer = place.payer ?? run.payer;
					const payer = run.payer === "key" ? "your Settings key" : "the machine sign-in";
					const hosted = place.hostedSize && hostedTerms(run.size, place.hostedSize, fact.inventory);
					job.task.review = {
						inherited: run,
						places: [{ place: place.place, name: place.name, sendSecrets: place.sendSecrets, payer: run.payer }],
						...(hosted && { hosted }),
					};
					const size = hosted ? `, ${hosted.size} at ${hosted.rate}× the standard hosted rate` : "";
					job.placementRefusal = `Run this repair with ${agent} on ${place.name} using ${payer}${size}? It works without asking and ${place.sendSecrets ? "gets" : "does not get"} repository secrets.`;
					return askPlacement(c, job);
				}
				job.placement = fit.decision;
				delete job.wait;
				dispatchJob(c, job);
				return true;
			}
			const sentence = fit.refused ?? fit.wait;
			if (fit.askMachine || fit.permanent) return placementRefused(c, job, sentence, fit);
			return waitForPlacement(c, job, sentence, fit);
		}
		case "child_update": {
			const job = c.item.jobs?.find(j => j.id === fact.child);
			if (
				!job ||
				!activeJob(job) ||
				fact.key !== (job.dispatchKey ?? key) ||
				step.kind !== "subtasks" ||
				c.item.question
			)
				return false;
			if (fact.placement) job.placement = fact.placement;
			const charged = chargeChild(c.item, job, fact.spent, fact.budget);
			if (
				!charged &&
				job.wait === fact.wait &&
				(!fact.startedAt || job.startedAt === fact.startedAt) &&
				job.state === fact.state &&
				job.report === fact.report &&
				job.head === fact.head &&
				(job.failure ?? null) === (fact.failure ?? null)
			)
				return false;
			job.failure = fact.failure ?? null;
			job.state = fact.state;
			job.report = fact.report;
			job.head = fact.head;
			job.wait = fact.wait;
			if (fact.startedAt !== undefined) job.startedAt = fact.startedAt;
			if (activeJob(job)) {
				c.state("waiting", {
					reason: "children",
					sentence: `Running ‘${job.task.title}’${job.placement ? " on ‘" + job.placement.name + "’" : ""}.`,
					retryAt: null,
				});
				dispatchJob(c, job, retryAt(c.at, 0));
			} else {
				if (job.state === "done" && job.head && !job.join) integratedTip(c.item, job, job.head);
				if (job.state === "failed" && job.conflictFix && !c.item.stoppedJob) {
					if (!job.conflictFix.retry)
						queueConflictFix(c, { ...job.conflictFix, retry: true }, job.task.owns ?? [], job.task.repo);
					else {
						ask(
							c,
							"feature_update",
							"The conflict-resolution part failed twice. Check the feature branch again or give up.",
							[{ id: "update_feature", label: "Check the feature branch again" }, choice("give_up")],
							"repeated",
							null,
							undefined,
							{ updateRepo: job.task.repo },
						);
						return true;
					}
				} else if (job.state !== "done" && !c.item.stoppedJob) {
					c.item.stoppedJob = job.id;
					cancelActive(c);
				}
				nextChild(c);
			}
			return true;
		}
		case "turn_running":
			// Asked while delivered too: a turn whose slot was granted and never taken (a server stopped in between) is noticed.
			if (step.turn === null || fact.key !== `${key}/check${step.checks}`) return false;
			const wait = c.item.wait;
			if (wait) capacityDeadline(c, wait.reason, wait.since, wait.sentence);
			checkTurn(c);
			return true;
		case "auto_merge_result":
			if (
				!run.ci ||
				run.ci.autoMergeKey !== fact.key ||
				step.kind !== "merged" ||
				c.item.state !== "review" ||
				fact.head !== c.item.head
			)
				return false;
			if (fact.behind && run.ci.secondReview && mergeCandidate(c.item, run.ci.secondReview) && updateFromBase(c)) {
				delete run.ci.autoMergeKey;
				run.endedAt = null;
				return true;
			}
			if (fact.reason !== null) {
				delete run.ci.autoMergeKey;
				c.say("Automatic merge handed over: " + fact.reason);
				const review = run.ci.secondReview ?? skippedReview(PERSON_HANDOVER);
				c.effects.push({ kind: "handoff", ...verdictAt(c, run.ci), ...review });
			} else {
				prRead(c, {
					mergedByApp: true,
					kind: "pr_read",
					key,
					at: c.at,
					state: "merged",
					prHead: fact.head,
					webhooks: !!run.ci?.webhooks,
				});
			}
			return true;
		case "ci_rerun_started":
			if (c.item.ciReruns?.[rerunKey(fact)]) return false;
			if (step.kind === "subtasks") {
				const ci = featureCiBranch(c.item, fact.repo).featureCi;
				if (!watchingParts(c.item) || ci?.key !== fact.key || ci.head !== fact.head) return false;
				(c.item.ciReruns ??= {})[rerunKey(fact)] = { jobs: fact.jobs };
				queueFeatureCi(c, fact.repo, c.at + ciPollEvery(fact.openItems));
				return true;
			}
			if (c.item.question || step.kind !== "ci" || fact.key !== key || run.ci?.head !== fact.head) return false;
			// Commit the claim and the next poll before the POST. Replaying the effect cannot request a second run.
			(c.item.ciReruns ??= {})[rerunKey(fact)] = { jobs: fact.jobs };
			step.attempt++;
			run.ci.since = c.at;
			pollCi(c, fact.openItems, null, "Waiting for GitHub to rerun the checks.");
			return true;
		case "ci_read":
			if (c.item.question?.kind === "branch_push") return false;
			if (step.kind === "subtasks") {
				if (!watchingParts(c.item)) return false;
				const branch = featureCiBranch(c.item, fact.repo);
				if (!branch.featureCi || branch.featureCi.key !== fact.key || fact.head !== branch.head) return false;
				if (!followFeatureHead(c, fact)) readFeatureCi(c, fact);
				return true;
			}
			if ((step.kind !== "ci" && step.kind !== "handoff") || fact.key !== key || fact.head !== run.ci?.head)
				return false;
			if (!run.takingPush && followFeatureHead(c, fact)) return true;
			decideCi(c, fact);
			if (
				fact.featureTarget &&
				c.item.question &&
				featureCiQuestion(c.item) &&
				!c.item.question.choices.some(option => option.id === "update_feature")
			)
				c.item.question.choices.splice(-1, 0, featureUpdateChoice(fact.featureTarget));
			return true;
		case "pr_read":
			if (fact.key !== prPollKey(c.item)) return false;
			prRead(c, fact);
			return true;
	}
	if (fact.key !== key) return false;
	switch (fact.kind) {
		case "secret_attempt":
			if (
				fact.previous !== (run.asks ?? 0) ||
				!ASKING.has(step.kind as TurnStepKind) ||
				!step.turn ||
				c.item.question ||
				c.item.claimedSecret ||
				!["queued", "working"].includes(c.item.state) ||
				(run.asks ?? 0) >= MAX_SECRET_REQUESTS
			)
				return false;
			run.asks = (run.asks ?? 0) + 1;
			run.secretAttemptKey = key;
			return true;
		case "feature_seed":
			if (step.kind !== "subtasks") return false;
			if (crossRepo(c.item)) {
				if (!fact.repo || !recordSeed(c.item, fact.repo, fact.sha)) return false;
			} else if (c.item.seed) return false;
			else c.item.seed = fact.sha;
			dispatchAgain(c);
			return true;
		case "feature_ready":
			if (step.kind !== "subtasks") return false;
			if (crossRepo(c.item)) {
				if (!fact.repo || !recordOpened(c.item, fact.repo, fact.head, fact.pr)) return false;
				if (!fact.waitForCiOnEachPart) repoOf(c.item, fact.repo).featureCi = { head: fact.head, since: c.at };
				if (!featureOpened(c.item)) {
					dispatchAgain(c);
					return true;
				}
				c.effects.push({ kind: "link_prs", key });
			} else if (c.item.pr) return false;
			else {
				c.item.pr = fact.pr;
				c.item.head = fact.head;
				if (!fact.waitForCiOnEachPart) c.item.featureCi = { head: fact.head, since: c.at };
			}
			nextChild(c);
			return true;
		case "integrated":
			if (!c.item.parent || step.kind !== "subtasks") return false;
			c.effects.push({ kind: "notify_integrated", key, head: fact.head ?? c.item.head! });
			if (fact.head) c.item.integratedHead = fact.head;
			c.run.endedAt = c.at;
			c.state("done");
			c.say("Integrated the verified subtask into the feature branch.");
			return true;
		case "feature_problem":
			if (c.item.question) return false;
			if (c.item.cancelAfterIntegration) {
				cancel(c);
				return true;
			}
			if (crossRepo(c.item) && !featureOpened(c.item)) {
				// One repository refused its branch or draft PR: what opened stays, and "again" retries only the rest.
				ask(
					c,
					"integration",
					`${fact.reason}. The pull requests opened so far are kept; no subtask runs until every repository has its draft.`,
					[{ id: "again", label: "Try the remaining repository again" }, choice("give_up")],
					null,
					null,
				);
			} else if (fact.missingTarget && c.item.mergeTarget) {
				c.say(fact.reason);
				c.run.endedAt = c.at;
				c.state("failed");
			} else if (fact.rebase && c.item.parent) {
				nextTurn(c, conflictPlan(c.item.task.base));
			} else ask(c, "publish_refused", fact.reason, [choice("give_up")], null, null);
			return true;
		case "sandbox_retry":
			if (
				c.item.question ||
				step.turn !== null ||
				c.item.wait?.reason !== "capacity" ||
				fact.at < (c.item.wait.retryAt ?? Infinity)
			)
				return false;
			nextTurn(c, fact.plan);
			return true;
		case "provider_retry":
			if (c.item.wait?.reason !== "provider" || (!fact.loginChanged && fact.at < (c.item.wait.retryAt ?? Infinity)))
				return false;
			nextTurn(c, fact.plan);
			return true;
		case "sandbox_resize_refused":
			if (c.item.question || step.turn !== null) return false;
			ask(
				c,
				"turn_refused",
				`A ${fact.size} sandbox is no longer available to this account. Try again in the current sandbox, or give it up.`,
				[choice("again"), ...handOverAny(c.item), choice("give_up")],
				null,
				fact.plan,
			);
			return true;
		case "sandbox_freed":
			if (c.item.question || step.turn !== null) return false;
			if (fact.hostedSize && c.item.resolved) {
				c.item.resolved.size = fact.hostedSize;
				c.item.resolved.sources.size = "item";
			}
			nextTurn(c, fact.plan);
			return true;
		case "turn_waiting": {
			if (step.turn !== "delivered") return false;
			const now = c.item.wait;
			const wait =
				step.kind === "review" && run.review
					? { ...fact.wait, sentence: `Second review of ${shortSha(run.review.head)}. ${fact.wait.sentence}` }
					: fact.wait;
			if (c.item.question) return false;
			if (now?.reason === wait.reason && capacityDeadline(c, wait.reason, now.since, wait.sentence)) return true;
			if (now !== null && now.reason === wait.reason && now.sentence === wait.sentence && now.retryAt === wait.retryAt)
				return false;
			if (now?.reason !== wait.reason) c.say(wait.sentence);
			c.state("waiting", wait);
			return true;
		}
		case "session_deleted":
			if (step.kind === "plan_review" && step.turn) {
				step.turn = null;
				askPlan(c);
				return true;
			}
			if (c.item.question?.kind === "turn_refused") return false;
			step.turn = null;
			ask(c, "turn_refused", "This agent was deleted.", [...handOver(c.item), choice("give_up")], null, null);
			return true;
		case "turn_started":
			if (step.turn !== "delivered") return false;
			recordRun(c.item, fact);
			step.turn = "started";
			if (c.item.question?.kind === "sandboxes" || c.item.question?.kind === "machine_away") c.item.question = null;
			c.state("working");
			c.say("The turn started.");
			checkTurn(c);
			return true;
		case "turn_paused": {
			if (step.turn !== "started") return false;
			const sentence = `Paused: waiting for ${fact.machine ? `the machine “${fact.machine}”` : "the machine"} (offline since ${clock(fact.since)} UTC). The turn resumes by itself when it is back.`;
			if (c.item.wait?.reason === "machine" && c.item.wait.sentence === sentence) return false;
			c.say(sentence);
			c.state("waiting", { reason: "machine", sentence, retryAt: null });
			return true;
		}
		case "turn_resumed":
			if (step.turn !== "started" || (c.item.wait?.reason !== "machine" && c.item.question?.kind !== "machine_away"))
				return false;
			if (c.item.question?.kind === "machine_away") c.item.question = null;
			c.say(`The machine came back after ${spellDuration(fact.offlineMs)}: the turn resumed where it was.`);
			c.state("working");
			return true;
		case "machine_away":
			if (
				step.turn !== "started" ||
				step.awayAsked ||
				c.item.question ||
				c.item.wait?.reason !== "machine" ||
				c.at < (fact.deadline ?? fact.since + AUTO_POLICY.machine_away)
			)
				return false;
			step.awayAsked = true;
			ask(
				c,
				"machine_away",
				`${fact.machine ? `The machine “${fact.machine}”` : "The machine"} has been offline since ${clock(fact.since)} UTC, and this item's turn is paused until it is back. Keep waiting, or give up on the item. To run it elsewhere, give up and start it again on another place.`,
				[choice("wait"), choice("give_up")],
				null,
				null,
			);
			return true;
		case "turn_ended":
			if (step.turn === null || step.kind === "review" || step.kind === "plan_review") return false;
			turnEnded(c, fact);
			return true;
		case "review_ended":
			if (step.turn && step.kind === "plan_review") {
				finishCritic(c, fact);
				return true;
			}
			if (step.turn === null || step.kind !== "review") return false;
			reviewEnded(c, fact);
			return true;
		case "base_conflict":
			if (step.kind !== "publish" || !run.updateFromBase || c.item.question) return false;
			delete run.updateFromBase;
			// The update already spent this conflict round.
			nextTurn(c, { ...conflictPlan(c.item.task.base), charge: null, fingerprint: null });
			return true;
		case "published":
		case "publish_failed":
			if (step.kind !== "publish") return false;
			if (fact.kind === "published") published(c, fact);
			else publishFailed(c, fact);
			return true;
	}
}

const fromPush = (head: string) => "Use fetch_base to fetch the updated PR branch and start from " + head + ". ";

function branchPushed(c: Change, fact: Extract<Fact, { kind: "branch_push" }>): boolean {
	const { item } = c,
		{ push, head } = fact;
	if (
		!item.run ||
		fact.key !== c.key ||
		(item.state !== "working" && item.state !== "waiting") ||
		item.machineRemoved ||
		item.joining ||
		item.featureUpdate ||
		item.feedback?.awaiting ||
		item.run.ci?.handed ||
		item.run.takingPush ||
		item.run.step.kind === "merged"
	)
		return false;
	if (item.question?.push && item.question.repo !== fact.repo) return false;
	const branch = featureCiBranch(item, fact.repo);
	if ((branch.head ?? null) !== fact.previous || head === (item.question?.push?.head ?? branch.head) || !isSha(head))
		return false;
	if (c.run.step.turn) {
		if (c.run.step.turn === "started") (item.pushWithdrawals ??= []).push(c.key);
		c.effects.push({ kind: "withdraw", key: c.key, ...(c.run.step.kind === "review" && { to: "review" as const }) });
	}
	item.foreignPush = true;
	if (item.run.ci && item.run.ci.head === branch.head) item.run.ci.moved = head;
	// Retire deliveries and poll keys before asking. A feature's join queue stays paused until the answer.
	c.enter(item.mode === "orchestrate" ? "subtasks" : "ci");
	if (!push) {
		item.question = null;
		takeBranchOver(c, head, fact.repo);
		return true;
	}
	const resume = {
		...IMPLEMENT,
		text: fromPush(head) + "Continue the task.",
		...marked(item.untrusted, [push.own ? "your push of " + shortSha(head) : untrustedWords.push(head, push.pusher)]),
	};
	ask(
		c,
		"branch_push",
		`@${push.pusher} pushed to the branch. How should the work continue?`,
		[
			{ id: "send_back", label: "Continue from your push" },
			{ id: "hand_over", label: "Take it over" },
			choice("give_up"),
		],
		null,
		resume,
		undefined,
		{ push: { head, author: push.author, message: push.message }, repo: fact.repo },
	);
	return true;
}

function takeBranchOver(c: Change, head: string, repo?: string) {
	cancelActive(c);
	const previous = featureCiBranch(c.item, repo).head;
	const ci = c.run.ci && c.run.ci.head === previous ? c.run.ci : ciProgress(previous ?? head, c.at, null, false);
	c.run.ci = ci;
	ci.moved = head;
	c.run.takingPush = true;
	readForHandoff(c, ci, skippedReview(MOVED), repo);
}

function sendBack(c: Change, note: string, push?: string): boolean {
	const { item } = c;
	if (item.state !== "review" || item.machineRemoved) return false;
	c.sayOfItem("Sent back: " + note);
	if (item.mode === "orchestrate") {
		resetRun(c, "subtasks");
		queueReviewFix(c, note, []);
	} else {
		const text = push ? fromPush(push) + note : "The person sent your work back: " + note;
		beginRun(c, { ...IMPLEMENT, text, ...(push && marked([untrustedWords.ci(push)])) });
	}
	decided(item, { kind: "send_back", run: c.run.n, text: note });
	return true;
}

function ownReplans(item: FactoryItem) {
	return (item.replans ?? 0) - (item.feedbackReplans ?? 0);
}

export function plannerCapacityText(
	place: FactoryItem["place"],
	machines: PlacementInventory["machines"],
	hostedCapacity: number,
): string {
	if (place.kind === "hosted") {
		if (hostedCapacity > 1) return `Hosted parts run up to ${hostedCapacity} at once. Additional parts wait.`;
		if (hostedCapacity === 0) return "All hosted places are in use on this account. Hosted parts wait for a slot.";
		const available = [];
		for (const machine of machines) {
			if (!machine.online || machine.orchestrator === "never") continue;
			const free = freeMachineSlots(machineSlots(machine));
			if (free > 0) available.push(`${machine.name} (${free} free slot${free === 1 ? "" : "s"})`);
		}
		const guidance = "Hosted parts run one at a time on this account. Prefer fewer, larger parts";
		return available.length
			? `${guidance}; independent parts can run in parallel on these online machines: ${available.join(", ")}.`
			: `${guidance}.`;
	}
	const machine = machines.find(m => m.machineId === place.machineId);
	const parts = machine?.online ? Math.min(RULES.parallelChildren, freeMachineSlots(machineSlots(machine))) : 0;
	const name = machine ? `Your machine '${machine.name}'` : "Your selected machine";
	return `${name} can run ${parts} part${parts === 1 ? "" : "s"} at once. Additional parts wait for a slot.`;
}

/** The queue can keep reporting the same wait even when no new capacity event arrives. */
function capacityDeadline(c: Change, reason: string, since: number, sentence: string): boolean {
	const step = c.run.step;
	if (c.item.question) return false;
	if (reason === "sandboxes" && !step.capAsked && c.at >= since + AUTO_POLICY.sandboxes) {
		step.capAsked = true;
		ask(c, "sandboxes", sentence, [choice("wait"), choice("give_up")], "sandboxes", null);
		return true;
	}
	if (
		reason === "machine" &&
		step.turn === "delivered" &&
		!step.awayAsked &&
		c.at >= since + AUTO_POLICY.machine_away
	) {
		step.awayAsked = true;
		ask(c, "machine_away", sentence, [choice("wait"), choice("give_up")], null, null);
		return true;
	}
	return false;
}

function startRetryPlan(item: FactoryItem, kind: TurnStepKind): TurnPlan {
	return {
		...IMPLEMENT,
		kind,
		text: `Your last turn could not start, so nothing of it reached you. Carry on with the task:\n\n${taskText(item.task)}`,
		newStep: false,
		...marked(item.untrusted),
	};
}

function turnEnded(c: Change, fact: Extract<Fact, { kind: "turn_ended" }>): void {
	const { item, run } = c;
	const step = run.step;
	const kind = step.kind as TurnStepKind;
	spendTurn(c, fact.spend, fact.providerRefusal);
	// A provider refusal reports no tokens. Handle it before checking the budget.
	if (fact.providerRefusal) return askProviderRefusal(c, fact.providerRefusal, { ...IMPLEMENT, kind });
	// Missing billable usage would let another turn exceed its budget.
	const memory = fact.outOfMemory && fact.outcome !== "succeeded" ? fact.outOfMemory : null;
	const unmeasured =
		fact.refused || fact.sandboxFailed || (memory && fact.outcome === "error")
			? null
			: unmeasuredTurn(fact.spend, itemAgent(item));
	if (fact.sandboxFailed) return sandboxFailed(c, fact.sandboxFailed, startRetryPlan(item, kind));
	delete step.sandboxFailures;
	if (memory)
		return outOfMemory(c, memory, {
			...IMPLEMENT,
			kind,
			text: `Your last turn ran the sandbox out of memory and did not finish. Carry on with the task, and keep the memory your commands use at once low (fewer tests or workers in parallel):\n\n${taskText(item.task)}`,
			newStep: false,
			...marked(item.untrusted),
		});
	if (unmeasured) return ask(c, "budget", unmeasured, [...handOver(item), choice("give_up")], "tokens", null);

	if (fact.escaped)
		return ask(
			c,
			"turn_refused",
			sandboxEscapeQuestion(item, fact.escaped),
			[...handOver(item), choice("give_up")],
			null,
			null,
		);
	const result = gateResult(fact.outcome, fact.verified, kind === "run_checks");
	// Refused on "Docker, hardened" for someone else's text: the person may run that very turn anyway, labelled only.
	if (fact.refused && fact.untrustedRefusal?.sources.length) {
		const resume: TurnPlan = { ...IMPLEMENT, kind, ...fact.untrustedRefusal.retry, newStep: false };
		return ask(
			c,
			"turn_refused",
			`The agent's turn could not start. ${fact.refused}`,
			[...handOver(item), choice("give_up"), choice("run_anyway")],
			null,
			resume,
		);
	}
	// A startup failure uses its own retry allowance. Sign-in and other policy refusals need the owner.
	if (fact.refused) {
		const resume: TurnPlan = startRetryPlan(item, kind);
		return ask(
			c,
			"turn_refused",
			`The agent's turn could not start. ${fact.refused}`,
			[choice("again"), ...handOver(item), choice("give_up")],
			null,
			resume,
			undefined,
			{ policy: fact.policyRefusal ? undefined : "turn_start" },
		);
	}
	// Surface a recorded question even when its turn was cut short.
	const prepaid = run.secretAttemptKey === fact.key;
	if (
		fact.secret &&
		ASKING.has(kind) &&
		!secretRequestLimit(fact.secret.name, prepaid ? 0 : (run.asks ?? 0), run.declinedSecrets ?? [], "run")
	) {
		if (!prepaid) run.asks = (run.asks ?? 0) + 1; // A receipt from a session predating upfront accounting.
		const text = [`A secret was requested for ${fact.secret.name}.`, fact.secret.notice].filter(Boolean).join("\n");
		return ask(
			c,
			"secret_needed",
			text,
			[choice("add_secret"), choice("without_secret"), choice("give_up")],
			null,
			{ ...IMPLEMENT, kind, newStep: false },
			text,
			{ secret: fact.secret },
		);
	}
	if (fact.asked && ASKING.has(kind)) {
		run.asks = (run.asks ?? 0) + 1;
		const resume: TurnPlan = { ...IMPLEMENT, kind, newStep: false };
		return ask(
			c,
			"agent_ask",
			AGENT_ASKS,
			[choice("reply"), ...handOver(item), choice("give_up")],
			null,
			resume,
			AGENT_ASKS,
			{ asked: { text: fact.asked.text, options: [...fact.asked.options] } },
		);
	}
	if (fact.stepLimit !== undefined) return stepLimitReached(c, { ...IMPLEMENT, kind }, fact.stepLimit, fact.verified);
	// Stopped at its budget while it ran: the budget question (`nextTurn`), and "give more" goes on from there.
	if (fact.budgetStopped) return budgetStopped(c, { ...IMPLEMENT, kind });
	if (CUT_SHORT.has(fact.outcome) || result === "incomplete") {
		step.interruptions += 1;
		// The cut-off that reaches the limit is not tried again: the person is asked next (`nextTurn`, "interruptions").
		c.say(
			`The turn ${OUTCOME_WORDS[fact.outcome] ?? "did not finish"}${step.interruptions >= RULES.interruptions ? "." : "; the step is tried again."}`,
		);
		return nextTurn(c, {
			...IMPLEMENT,
			kind,
			text: "You were interrupted. Continue from where you were.",
			newStep: false,
			charge: "interruptions",
		});
	}
	if (kind === "summary") {
		if (!fact.report)
			return ask(
				c,
				"turn_refused",
				["The final summary was not filed.", fact.reportProblem].filter(Boolean).join(" "),
				[choice("again"), choice("give_up")],
				null,
				{ ...IMPLEMENT, kind },
				undefined,
				{ policy: "summary_missing" },
			);
		c.enter("publish");
		c.effects.push({ kind: "describe_feature", key: c.key });
		return;
	}
	if (kind === "refine") return fact.autoApprovePlans ? considerCritic(c) : askPlan(c);
	// A builder that changed nothing for a review answers it in its report: the same head is reviewed again, with that report.
	if (!fact.changes && kind === "review_fix" && run.ci && run.review && run.ci.head === item.head) {
		if (run.ci.moved) return readForHandoff(c, run.ci, keptReview(run, run.ci));
		c.say(
			`The agent changed nothing for the review; ${shortSha(run.ci.head)} is reviewed again, with the agent's report.`,
		);
		return startReview(c, run.ci);
	}
	// A checks-only turn can verify the existing commit. Publish confirms its SHA before CI is read.
	if (!fact.changes && kind !== "run_checks") {
		const resume: TurnPlan = {
			...IMPLEMENT,
			kind,
			text: "You changed nothing. Finish the task or use report to explain why it needs no change.",
		};
		return ask(
			c,
			"no_change",
			"The agent ended its turn without changing anything.",
			[choice("again"), ...handOver(item), choice("give_up")],
			null,
			resume,
		);
	}

	finishGate(c, fact, kind, result);
}

function finishGate(
	c: Change,
	fact: Extract<Fact, { kind: "turn_ended" }>,
	kind: TurnStepKind,
	result: ReturnType<typeof gateResult>,
): void {
	const { run } = c;
	if (kind === "run_checks" && result !== "unverified") {
		run.failures = failuresOf(run).filter(failure => failure !== NO_GATE);
		if (run.lastFailure === NO_GATE) run.lastFailure = null;
	}
	c.enter("gate");
	run.gate = {
		turn: fact.key,
		...(kind === "run_checks" && { forcedChecks: true }),
		outcome: fact.outcome,
		verified: fact.verified,
		flags: fact.flags,
	};
	if (result === "fail" && fact.verified !== null) {
		// Fixing code cannot repair the sandbox that runs its checks.
		const environment = environmentChecks(fact.verified);
		const failing = failingNames(fact.verified.run?.checks ?? []);
		if (environment.length && !failing) return askEnvironment(c, kind, environment);
		c.say(`The checks failed: ${failing}.`);
		return nextTurn(c, {
			...IMPLEMENT,
			kind,
			text: gateFixText(failing),
			charge: "gate",
			fingerprint: gateFingerprint(fact.verified),
		});
	}
	const said =
		result === "pass"
			? "The checks passed."
			: fact.verified === null
				? "The turn left no record of its checks: the work is pushed for CI to verify."
				: fact.verified.state === "none_set"
					? "No checks are set for this repository: the work is pushed for CI to verify."
					: "The checks verified nothing in this turn: the work is pushed for CI to verify.";
	c.say(said);
	publish(c);
}

/** Keep the agent's words in Question.asked, separate from the platform message. */
const AGENT_ASKS = "The agent stopped to ask you a question before it goes on.";

export function sandboxEscapeQuestion(item: Pick<FactoryItem, "agent">, note: string): string {
	const name = harnessName(item.agent?.harness ?? "windlass");
	return `${name} asked to leave its sandbox, which “Strict” never allows, so the step was stopped. ${note} File the work again on “Open”, where ${name}'s commands run in the container without asking, or give up.`;
}

const answeredText = (note: string) => `The person answered your question:\n\n${note}\n\nGo on with the task.`;

function environmentChecks(verified: Verified): Array<{ check: VerifiedCheck; failure: EnvironmentFailure }> {
	return (verified.run?.checks ?? []).flatMap(check => {
		const failure = environmentFailure(check);
		return failure ? [{ check, failure }] : [];
	});
}

const ENVIRONMENT_WORDS: Record<EnvironmentFailure["kind"], string> = {
	package_manager: "its package manager refused to run",
	network: "a tool it needs could not be fetched over the network",
	not_found: "the shell did not find the command",
};

export function environmentQuestion(
	failed: ReadonlyArray<{ check: Pick<VerifiedCheck, "name" | "command">; failure: EnvironmentFailure }>,
): string {
	const [{ check, failure }] = failed;
	const others =
		failed.length > 1
			? ` ${failed.length - 1 === 1 ? "One more check" : `${failed.length - 1} more checks`} failed the same way.`
			: "";
	return `The check “${check.name}” could not run in the sandbox: ${ENVIRONMENT_WORDS[failure.kind]}.${others} This is not a code problem, so the agent was not sent back. Fix the environment, then run the step again.`;
}

function askEnvironment(
	c: Change,
	kind: TurnStepKind,
	failed: Array<{ check: VerifiedCheck; failure: EnvironmentFailure }>,
): void {
	const [{ check, failure }] = failed;
	const names = failed.map(({ check }) => check.name).join(", ");
	c.say(`The checks could not run in the sandbox: ${names}. The agent was not sent back.`);
	const resume: TurnPlan = {
		...IMPLEMENT,
		kind,
		text: `The platform's checks could not run in your sandbox: ${failed.map(({ check }) => `${check.name} (\`${check.command}\`)`).join(", ")}. That was the environment, not your code, so the platform is checking again. Run ${failed.length === 1 ? "that command" : "those commands"} yourself; if it fails because of the code, fix the code. Then end your turn.`,
	};
	ask(
		c,
		"check_environment",
		environmentQuestion(failed),
		[{ id: "again", label: "Run the step again" }, ...handOver(c.item), choice("give_up")],
		null,
		resume,
		undefined,
		{
			check: {
				name: check.name,
				command: check.command,
				exitCode: check.exitCode,
				kind: failure.kind,
				line: failure.line,
				excerpt: outputExcerpt(check.output),
			},
		},
	);
}

function cancel(c: Change): void {
	if (c.item.awaitingPlace && c.item.state === "waiting") c.effects.push({ kind: "discard_placement", key: c.item.id });
	stopPendingChecks(c);
	const { item } = c;
	const run = item.run;
	cancelActive(c);
	if (run !== null && run.step.turn !== null)
		c.effects.push({
			kind: "withdraw",
			key: c.key,
			...(run.step.kind === "plan_review" ? { to: "critic" as const } : run.step.kind === "review" && { to: "review" }),
		});
	if (run !== null && run.endedAt === null) {
		run.endedAt = c.at;
		run.stopReason = "cancelled";
	}
	item.question = null;
	c.say("Cancelled.");
	c.state("cancelled");
}

function proposePlan(c: Change, fact: Extract<Fact, { kind: "edit_plan" | "file_plan" }>): boolean {
	const { item } = c;
	if (item.mode !== "orchestrate" || !item.singleBudget) return false;
	if (fact.kind === "edit_plan") {
		if (!item.featurePlan || item.featurePlan.version !== fact.version || !planQuestion(item)) return false;
	} else if (!item.run?.step.turn || item.run.step.kind !== "refine" || c.key !== fact.key) return false;
	const plannedJobs = item.jobs?.filter(j => !repair(j)) ?? [];
	const completed = plannedJobs.filter(j => j.state === "done");
	const plan = validatePlan(fact.plan, item.singleBudget, aliases(item));
	if (fact.kind === "edit_plan" && !Object.hasOwn(fact.plan as object, "overflow"))
		plan.overflow = item.featurePlan?.overflow ?? false;
	if (item.forceSplit && plan.singleSuggested) throw new PlanError("Propose two to six subtasks as requested.");
	const keys = [...plannedJobs.map(job => job.task.key), ...plan.subtasks.map(task => task.key)];
	if (new Set(keys).size > 6) throw new PlanError("A feature may have at most six distinct subtasks across its plans.");
	if (fact.inventory?.defaults) item.context = { ...item.context, ...fact.inventory.defaults };
	const approvedPlan = item.replans ? item.approvedPlan : undefined;
	const previous = fact.kind === "file_plan" ? approvedPlan : item.featurePlan;
	for (const q of plan.questions) {
		const old = previous?.questions.find(old => old.text === q.text && old.id !== "scope-change");
		if (fact.kind === "file_plan") {
			if (old?.answer && q.id !== "scope-change") q.answer = old.answer;
			else delete q.answer;
		}
		if (old?.answeredBy && q.answer && q.answer === old.answer) q.answeredBy = old.answeredBy;
	}
	if (fact.kind === "file_plan") {
		// A re-plan keeps each approved subtask's agent: only the person changes it, on the card.
		if (approvedPlan)
			for (const task of plan.subtasks) {
				const approved = approvedPlan.subtasks.find(s => s.key === task.key);
				if (!approved) continue;
				if (approved.agent) task.agent = structuredClone(approved.agent);
				else delete task.agent;
				const problem = agentProfileProblem(task);
				if (problem) throw new PlanError(task.title + ": " + problem);
			}
		if (approvedPlan && planScope(plan) !== planScope(approvedPlan)) {
			plan.questions = plan.questions.filter(q => q.id !== "scope-change");
			plan.questions.push({
				id: "scope-change",
				text: "The revised plan changes the approved scope or subtasks. Do you accept these changes?",
			});
		}
	}
	if (item.replans) {
		if (item.feedbackReplans && completed.length && plan.subtasks.every(s => completed.some(j => j.task.key === s.key)))
			throw new PlanError("Add a fix subtask to the completed feature.");
		if (plan.singleSuggested) throw new PlanError("Re-plan the remaining work on the existing feature branch.");
		for (const job of completed) {
			const { resolved, review, placementProblem, placementWait, requestedLargerSize, ...approved } = job.task;
			const task = plan.subtasks.find(s => s.key === approved.key);
			if (!task || !isDeepStrictEqual(task, approved)) throw new PlanError("Completed subtasks cannot be changed.");
			Object.assign(task, job.task);
		}
	}
	for (const task of plan.subtasks) {
		if (completed.some(job => job.task.key === task.key)) continue;
		if (fact.inventory) reviewPart(task, item.context, item.place, !!plan.overflow, fact.inventory);
		else if (item.context) task.resolved = partRun(item.context, task);
	}
	const proposed = {
		...plan,
		budget: featureTotal(item, plan),
		compare: { singleBudget: item.singleBudget },
		version: (item.featurePlan?.version ?? 0) + 1,
		status: "proposed" as const,
	};
	if (
		fact.kind === "file_plan" &&
		item.filedTurn === fact.key &&
		item.featurePlan &&
		isDeepStrictEqual({ ...proposed, version: item.featurePlan.version }, item.featurePlan)
	)
		return false;
	item.featurePlan = proposed;
	if (fact.kind === "file_plan") item.filedTurn = fact.key;
	else askPlan(c);
	return true;
}

function planQuestion(item: FactoryItem) {
	return (
		item.mode === "orchestrate" &&
		["plan_approval", "replan_approval", "single_suggested"].includes(item.question?.kind ?? "")
	);
}

/** Also accepted on questions filed before the item page offered the single-item fallback. */
export function singlePlanAlternative(item: FactoryItem) {
	if (
		item.mode === "orchestrate" &&
		!item.replans &&
		!crossRepo(item) &&
		item.question?.kind === "plan_approval" &&
		item.featurePlan?.status === "proposed" &&
		item.filedTurn === currentKey(item)
	)
		return { id: "run_single" as const, label: "Use the current Windlass session as one implementer" };
}

function trustedPlanInputs(item: FactoryItem): boolean {
	return item.run?.planInputsTrusted === true && !thirdParty(item.untrusted).length;
}

function considerCritic(c: Change) {
	const { item } = c,
		plan = item.featurePlan;
	if (!trustedPlanInputs(item)) return askPlan(c, "Automatic approval requires a plan based on trusted inputs.");
	if (!plan || item.filedTurn !== c.key) return askPlan(c, "The planner did not file a plan for this turn.");
	if (unsupportedParts(plan, completedKeys(item)).length) return askPlan(c);
	if (
		plan.singleSuggested &&
		item.context &&
		(resolveRun(item.context, "builder").agent !== "windlass" || item.useHosted)
	)
		return askPlan(c, "Confirm the current Windlass session before it implements this item.");
	const context = item.context;
	if (
		context &&
		plan.subtasks.some(s => {
			const defaults = partRun(context, { repo: s.repo });
			return (
				(defaults.place !== "hosted" && (s.place?.prefer === "hosted" || s.place?.allow?.includes("hosted"))) ||
				(!!s.needs?.hostedSize && s.needs.hostedSize !== defaults.size)
			);
		})
	)
		return askPlan(c, "Confirm the proposed hosted placement or size before these parts run.");
	if (!item.singleBudget) return askPlan(c, "The item has no budget to check the plan against.");
	const problem = smallPlanProblem(plan, item.singleBudget, aliases(item));
	if (problem) return askPlan(c, problem);
	if (unattendedKeys(plan, completedKeys(item)).length)
		return askPlan(c, "You need to confirm the subtasks whose agents work without asking.");
	if (backstopTurns(item) >= RULES.turnBackstop)
		return askPlan(c, "The item reached its turn limit before the reviewer could start.");
	const stop = budgetStop({ ...item.budget, tokens: ownTokens(item) }, ownSpent(item, item.spent), item.place);
	if (stop) return askPlan(c, stop.sentence);
	c.enter("plan_review");
	item.filedTurn = c.key;
	c.run.step.turn = "delivered";
	c.state("working");
	c.say("An independent critic reviews the filed plan.");
	c.effects.push({
		kind: "deliver",
		key: c.key,
		to: "critic",
		agent: "critic",
		text: criticPrompt(item, plannerBudgetText(item)),
		fetchBase: null,
		maxSteps: RULES.reviewMaxSteps,
		...marked(item.untrusted),
	});
	checkTurn(c);
}

function finishCritic(c: Change, fact: Extract<Fact, { kind: "review_ended" }>) {
	spendTurn(c, fact.spend, fact.providerRefusal);
	const review = fact.planReview;
	const needsOwner = (reason: string) =>
		askPlan(
			c,
			review?.decision === "approve"
				? "The reviewer approved, but the plan still needs your decision. " + reason
				: reason,
		);
	if (!trustedPlanInputs(c.item)) return needsOwner("Automatic approval requires a plan based on trusted inputs.");
	if (fact.refused) return needsOwner(fact.refused);
	if (fact.providerRefusal) return needsOwner(refusalMessage(fact.providerRefusal));
	if (fact.sandboxFailed) return needsOwner("The reviewer’s sandbox failed. " + fact.sandboxFailed);
	if (fact.outOfMemory) return needsOwner("The reviewer’s sandbox ran out of memory.");
	if (fact.stepLimit !== undefined) return needsOwner(`The reviewer reached its limit of ${fact.stepLimit} steps.`);
	if (fact.outcome !== "succeeded") return needsOwner(`The review turn ended with outcome “${fact.outcome}”.`);
	if (!review) return needsOwner("The reviewer ended its turn without filing a decision.");
	if (fact.spend.tokens <= 0) return needsOwner("The review turn reported no token spend.");
	if (review.decision === "revise") return askPlan(c, "The reviewer recommends revision.", review.findings);
	if (fact.approvalProblem) return needsOwner(fact.approvalProblem);
	if (fact.by !== "critic") return needsOwner("The platform could not verify the approval.");
	const plan = c.item.featurePlan;
	if (plan?.status !== "proposed" || c.item.filedTurn !== c.key)
		return needsOwner("The reviewed proposal is no longer current.");
	const pending = plan.questions.filter(q => !q.answer);
	if (pending.some(q => !q.recommended))
		return needsOwner("A plan question needs your answer because it has no recommendation.");
	for (const q of pending) {
		q.answer = q.recommended;
		q.answeredBy = "critic";
	}
	if (plan.singleSuggested) runSingle(c);
	else if (!approveFeature(c, fact.inventory))
		return needsOwner("The reviewed plan is no longer eligible for approval.");
	if (c.item.question) return;
	c.say("Approved automatically: " + (review.findings.join(" ") || "The critic approved the plan as filed."));
}

function waitForPlacement(
	c: Change,
	job: FeatureJob,
	sentence: string,
	wait: { providerUntil?: number; dailyCap?: boolean; accountKey?: string },
): boolean {
	const { providerUntil, dailyCap, accountKey } = wait;
	let retry = placementRetryAt(c.at, providerUntil, dailyCap);
	if (providerUntil === undefined && !dailyCap) {
		job.placementWaitSince ??= c.at;
		const deadline = job.placementWaitSince + AUTO_POLICY.placement_refused;
		if (c.at >= deadline) {
			job.placementRefusal = sentence;
			job.wait = sentence;
			return askPlacement(c, job);
		}
		retry = Math.min(retry, deadline);
	} else delete job.placementWaitSince;
	c.state("waiting", {
		reason: providerUntil !== undefined ? "provider" : dailyCap ? "capacity" : "machine",
		accountKey,
		sentence,
		retryAt: retry,
	});
	job.wait = sentence;
	dispatchJob(c, job, retry);
	return true;
}

function placementRefused(
	c: Change,
	job: FeatureJob,
	reason: string,
	options: Pick<FeatureJob, "askMachine" | "offerHosted" | "hostedProfile">,
): true {
	job.askMachine = options.askMachine;
	job.offerHosted = options.offerHosted;
	job.hostedProfile = options.hostedProfile;
	job.placementRefusal = reason;
	// Other children keep their places and may finish integration before the feature asks.
	if (!c.item.jobs!.some(j => j !== job && activeJob(j) && !j.placementRefusal))
		askPlacement(c, c.item.jobs!.find(j => activeJob(j) && j.placementRefusal)!);
	return true;
}

/** Child receipts are cumulative. Only charge increases to the parent. */
function chargeChild(
	item: FactoryItem,
	job: FeatureJob,
	observed: Partial<ItemSpend> & Pick<ItemSpend, "tokens">,
	budget?: ItemBudget,
): boolean {
	let changed = false;
	const seen = { ...noSpend(), ...job.spent };
	const now = { ...seen, ...observed, rawTokens: observed.rawTokens ?? observed.tokens };
	for (const figure of ["tokens", "rawTokens", "turns", "activeSeconds", "hostedSeconds"] as const) {
		const delta = (now[figure] ?? 0) - (seen[figure] ?? 0);
		if (delta <= 0) continue;
		job.spent[figure] = now[figure];
		item.spent[figure] = (item.spent[figure] ?? (figure === "rawTokens" ? item.spent.tokens : 0)) + delta;
		changed = true;
	}
	// A part's dollars are its own, like its usage: the feature sums them when it is shown.
	for (const figure of ["usd", "usdUnknown"] as const) {
		if (observed[figure] !== undefined && observed[figure] !== job.spent[figure]) {
			(job.spent as unknown as Record<string, unknown>)[figure] = observed[figure];
			changed = true;
		}
	}
	// A part's usage is its own record, taken whole: the feature sums its parts' when it is shown (`partsUsage`).
	for (const figure of ["usage", "retryUsage"] as const) {
		const usage = observed[figure];
		if (usage && JSON.stringify(usage) !== JSON.stringify(job.spent[figure])) {
			job.spent[figure] = usage;
			changed = true;
		}
	}
	if (budget) {
		const old = job.budget ?? {
			tokens: job.task.budget.tokens,
			hostedSeconds: item.singleBudget?.hostedSeconds ?? item.budget.hostedSeconds,
		};
		if (budget.tokens > old.tokens || budget.hostedSeconds > old.hostedSeconds) {
			for (const key of ["tokens", "hostedSeconds"] as const) item.budget[key] += Math.max(0, budget[key] - old[key]);
			job.budget = {
				...old,
				tokens: Math.max(budget.tokens, old.tokens),
				hostedSeconds: Math.max(budget.hostedSeconds, old.hostedSeconds),
			};
			changed = true;
		}
		// A part given more dollars: the feature's own allowance is tokens, so only the part's record grows.
		if (budget.usd !== undefined && budget.usd > ((job.budget ?? old).usd ?? 0)) {
			job.budget = { ...(job.budget ?? old), usd: budget.usd };
			changed = true;
		}
	}
	return changed;
}

function clock(at: number): string {
	const iso = new Date(at).toISOString();
	return iso.slice(0, 10) === new Date().toISOString().slice(0, 10)
		? iso.slice(11, 16)
		: `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function spellDuration(ms: number): string {
	const minutes = Math.max(1, Math.round(ms / 60_000));
	if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} hours`;
	return `${Math.round(hours / 24)} days`;
}

function answer(c: Change, fact: Extract<Fact, { kind: "answer" }>): boolean {
	const { item } = c;
	const question = item.question;
	if (question === null || question.id !== fact.question) return false;
	const picked =
		question.choices.find(option => option.id === fact.choice) ??
		(fact.choice === "run_single" ? singlePlanAlternative(item) : undefined) ??
		(fact.choice === "update_feature" && fact.target && featureCiQuestion(item)
			? featureUpdateChoice(item.childBase ?? item.task.base)
			: undefined);
	if (picked === undefined) return false;
	if (question.kind === "secret_needed" && fact.note !== undefined) return false;
	const note = fact.note?.trim() || null;
	item.question = null;
	c.say(answeredWords(picked, note));
	// The person's note is theirs whatever they chose, but for giving up: a later review of the work is held to it.
	if (note !== null && fact.choice !== "give_up" && item.run)
		decided(item, {
			kind: "answer",
			run: item.run.n,
			text: note,
			question: question.kind,
			...(question.kind === "agent_ask" && question.asked?.text && { asked: question.asked.text }),
		});
	return takeChoice(c, question, fact, note);
}

const replacementAgents: Partial<Record<ChoiceId, HarnessId>> = {
	use_windlass: "windlass",
	use_claude: "claude",
	use_opencode: "opencode",
};

function takeChoice(
	c: Change,
	question: Question,
	fact: Extract<Fact, { kind: "answer" }>,
	note: string | null,
	auto = false,
): boolean {
	const { item } = c;
	if (question.kind === "run_place" && (fact.choice === "wait" || fact.choice === "use_hosted")) {
		if (fact.choice === "wait" && item.resolved?.payer === "unconfirmed") {
			if (!item.context) return false;
			item.context.item = { ...item.context.item, payer: "machine" };
			item.resolved = resolveRun(item.context, item.runRole ?? "builder");
		} else if (fact.choice === "use_hosted") item.useHosted = true;
		return waitForDefaultPlace(c, item.awaitingPlace!, fact.choice === "wait" ? undefined : c.at);
	}
	if ((question.kind === "plan_approval" || question.kind === "replan_approval") && fact.choice === "larger_sandbox") {
		const plan = item.featurePlan!;
		for (const task of plan.subtasks)
			if (task.requestedLargerSize) {
				task.needs = { ...task.needs, hostedSize: task.requestedLargerSize };
				task.resolved = partRun(item.context ?? {}, task);
				delete task.placementProblem;
				delete task.requestedLargerSize;
			}
		plan.version++;
		askPlan(c);
		return true;
	}
	const harness = replacementAgents[fact.choice];
	if ((question.kind === "plan_approval" || question.kind === "replan_approval") && harness) {
		const plan = item.featurePlan!;
		for (const task of unsupportedParts(plan, completedKeys(item))) {
			task.agent = { harness };
			task.resolved = partRun(item.context ?? {}, task);
			delete task.placementProblem;
		}
		plan.version++;
		askPlan(c);
		return true;
	}
	const refused =
		question.kind === "placement_refused"
			? (item.jobs?.find(j => j.id === question.child) ??
				item.jobs?.find(j => j.placementRefusal && activeJob(j)) ??
				item.jobs?.at(-1))
			: undefined;
	if (refused?.repairOffer && fact.choice === "approve") {
		const place = refused.repairOffer;
		refused.route = { preferred: place.place, alternatives: [] };
		refused.placement = place;
		delete refused.repairOffer;
		delete refused.placementRefusal;
		c.state("waiting", { reason: "children", sentence: "Running the approved repair.", retryAt: null });
		dispatchJob(c, refused);
		return true;
	}
	if (refused && harness) {
		refused.task.agent = { harness };
		refused.task.resolved = partRun(item.context ?? {}, refused.task, repair(refused) ? "repair" : "part");
		delete refused.placementRefusal;
		delete refused.placement;
		c.state("waiting", { reason: "children", sentence: "Checking the selected agent.", retryAt: null });
		dispatchJob(c, refused);
		return true;
	}
	if (refused?.askMachine && (fact.choice === "wait" || fact.choice === "use_hosted")) {
		if (!refused.route || (fact.choice === "use_hosted" && !refused.offerHosted)) return false;
		if (fact.choice === "wait") refused.route.waitForMachine = true;
		else {
			refused.route = { preferred: { kind: "hosted" }, alternatives: [] };
			refused.task = { ...refused.task, place: { prefer: "hosted", reason: "The owner chose Hosted for this part." } };
			refused.task.resolved = partRun(item.context ?? {}, refused.task);
			if (refused.hostedProfile) refused.task.resolved.profile = refused.hostedProfile;
		}
		delete refused.askMachine;
		delete refused.offerHosted;
		delete refused.hostedProfile;
		delete refused.placement;
		delete refused.placementRefusal;
		c.state("waiting", { reason: "children", sentence: "Checking the selected place.", retryAt: null });
		dispatchJob(c, refused);
		return true;
	}
	if (fact.choice === "retry" && item.jobs?.length) {
		retryFeature(c);
		return true;
	}
	if (item.parent && fact.choice === "hand_over" && question.kind !== "branch_push") return false;
	if (fact.choice === "give_up") {
		if (question.kind === "placement_refused") {
			return apply(c, { kind: "cancel_subtask", key: refused!.task.key, at: c.at, by: c.by });
		}
		if (item.run) {
			item.run.endedAt = c.at;
			item.run.stopReason = question.cause ?? question.kind;
		}
		stopPendingChecks(c);
		// A turn still queued for its place (the hosted cap) goes back: nothing of it started. One paused for its machine ends with it.
		if (item.run?.step.turn === "delivered" || (question.kind === "machine_away" && item.run?.step.turn === "started"))
			c.effects.push({
				kind: "withdraw",
				key: c.key,
				...(item.run.step.kind === "plan_review"
					? { to: "critic" as const }
					: item.run.step.kind === "review" && { to: "review" }),
			});
		cancelActive(c);
		c.state("failed");
		return true;
	}
	const run = c.run;
	if (question.inherited && (fact.choice === "again" || fact.choice === "wait")) {
		const { repo, head, baseTip } = question.inherited;
		const feature = run.step.kind === "subtasks";
		const ci = feature ? featureCiBranch(item, repo).featureCi : run.ci;
		if (!ci) return false;
		if (ci.head === head) {
			if (fact.choice === "wait") ci.waitForBase = baseTip;
			else ci.fixInherited = true;
		}
		c.state("waiting", { reason: "ci", sentence: "Checking CI after your decision.", retryAt: c.at });
		if (feature) {
			// Dispatch observations may have expired while the question was open.
			for (const job of item.jobs ?? []) if (activeJob(job) && job.dispatchKey) dispatchJob(c, job);
		} else c.effects.push({ kind: "poll_ci", key: c.key, head: ci.head, at: c.at });
		return true;
	}
	const resume = question.resume;
	const resumeWithNote = resume && { ...resume, text: withNote(resume.text, note) };
	if (question.kind === "branch_push" && question.push && resumeWithNote) {
		const { head } = question.push;
		const branch = featureCiBranch(item, question.repo);
		if (fact.choice === "hand_over") {
			takeBranchOver(c, head, question.repo);
		} else if (fact.choice === "send_back") {
			stopPendingChecks(c);
			if (crossRepo(item)) recordIntegrated(item, question.repo, head);
			else item.head = head;
			if (resumeWithNote.untrusted) item.untrusted = resumeWithNote.untrusted;
			if (item.mode === "orchestrate") {
				if (branch.featureCi && item.jobs?.some(activeJob)) branch.featureCi = { head, since: c.at, afterParts: true };
				run.ci = null;
				c.state("waiting", {
					reason: "children",
					sentence: "Continuing subtasks from the updated feature branch.",
					retryAt: null,
				});
				for (const job of item.jobs ?? []) if (activeJob(job) && (!repair(job) || job.dispatchKey)) dispatchJob(c, job);
				nextChild(c);
			} else beginRun(c, resumeWithNote);
		} else return false;
		return true;
	}
	if (question.kind === "integration") return integrationAnswer(flow(c), fact.choice, question.text);
	if (question.kind === "ready_refused") return readyAnswer(c, fact.choice);
	switch (fact.choice) {
		case "send_back":
			if (question.kind === "publish_refused" && resumeWithNote) {
				nextTurn(c, resumeWithNote);
				break;
			}
		// falls through: a push that failed CI after review
		case "dismiss": {
			const push = run.ci?.reviewPush;
			if (question.kind !== "push_ci" || !push?.failure || push.head !== run.ci?.moved) return false;
			c.state("review");
			if (fact.choice === "send_back") return sendBack(c, push.failure, push.head);
			takeHeld(c);
			break;
		}
		case "run_checks": {
			if (!item.parent || !run.ci) return false;
			const plan = subtaskCheckPlan(run.ci, note);
			if (!auto) raise(c, "repeated", undefined, plan);
			nextTurn(c, plan);
			if (auto && run.step.kind === "run_checks" && run.step.turn === "delivered")
				run.autoCheck = { turn: c.key, head: run.ci.head };
			break;
		}
		case "update_feature":
			if (!fact.target || !isSha(fact.target)) return false;
			if (!item.parent) return requestFeatureUpdate(c, fact.target, undefined, undefined, question.updateRepo);
			if (run.step.kind !== "ci" || !run.ci) return false;
			c.enter("ci");
			c.state("waiting", { reason: "ci", sentence: "Waiting for the feature branch to update.", retryAt: null });
			c.effects.push({
				kind: "update_parent_feature",
				key: c.key,
				target: fact.target,
				...(auto && { automatic: true }),
			});
			break;
		case "update_from_base":
			return updateFromBase(c);
		case "ci_alone":
			if (!item.parent || !run.ci || run.ci.head !== item.head || !isSha(run.ci.head)) return false;
			run.ci.ciAlone = true;
			run.ci.last = null;
			run.ci.since = c.at;
			c.enter("ci");
			c.state("waiting", {
				reason: "ci",
				sentence: `Confirming CI on ${shortSha(run.ci.head)} for integration.`,
				retryAt: c.at,
			});
			c.effects.push({ kind: "poll_ci", key: c.key, head: run.ci.head, at: c.at });
			break;
		case "run_single":
			runSingle(c);
			break;
		case "send":
		case "leave": {
			const batch = item.feedback?.awaiting;
			if (!batch || !["feedback_feature", "feedback_more"].includes(question.kind)) return false;
			item.feedback!.awaiting = null;
			c.state("review");
			if (fact.choice === "send") takeFeedback(c, batch, true);
			else decline(c, batch, feedbackWords.left);
			if (item.state === "review") {
				if (run.step.kind === "ci" && run.ci) {
					// The question interrupted CI before its reviewer. Resume the normal handoff.
					run.endedAt = run.stopReason = null;
					c.enter("ci");
					c.state("waiting", { reason: "ci", sentence: "Reading CI for handover.", retryAt: c.at });
					c.effects.push({ kind: "poll_ci", key: c.key, head: run.ci.head, at: c.at });
				} else takeHeld(c);
			}
			break;
		}
		case "orchestrate_anyway":
			nextTurn(c, {
				...IMPLEMENT,
				kind: "refine",
				charge: "plan",
				text: "The person requests orchestration. File a plan with two to six verifiable subtasks.",
			});
			if (run.step.turn === "delivered") item.forceSplit = true;
			break;
		case "approve":
			if (item.mode !== "orchestrate") throw new PlanError("Only a planned feature has a plan to approve.");
			return approveFeature(c, fact.inventory, fact.agents);
		case "revise":
			if (question.kind === "placement_refused") {
				for (const job of item.jobs!.filter(activeJob)) job.state = "cancelled";
			}
			if (
				(question.kind === "budget" ||
					question.kind === "placement_refused" ||
					(question.kind === "rounds" && item.approvedPlan)) &&
				item.mode === "orchestrate"
			)
				replanning(item, "You asked for a revised plan");
			nextTurn(c, {
				...IMPLEMENT,
				kind: "refine",
				charge: "plan",
				text: withNote(
					question.kind === "placement_refused"
						? "Revise the placement and file the remaining plan again. Placement refusal (quoted data):\n" +
								question.text
						: "Revise your plan and file it again.",
					note,
				),
			});
			break;
		case "raise":
			raise(c, question.cause, fact.budget, resume);
			if (resumeWithNote?.charge === "review") fixAfterReview(c, resumeWithNote);
			else if (resumeWithNote) nextTurn(c, resumeWithNote);
			else if (item.approvedPlan && run.step.kind === "subtasks") nextChild(c);
			break;
		case "again":
			if (question.kind === "turn_refused") delete run.step.providerRetries;
			if (question.kind === "placement_refused") {
				delete refused!.placement;
				delete refused!.placementRefusal;
				delete refused!.placementWaitSince;
				c.state("waiting", { reason: "children", sentence: "Checking the approved places again.", retryAt: null });
				dispatchJob(c, refused!);
			} else if (question.kind === "publish_refused") publish(c);
			else if (resumeWithNote) nextTurn(c, resumeWithNote);
			break;
		case "retry":
			run.stopReason = "retried";
			run.endedAt = c.at;
			retryRun(c, firstPlan(item, note));
			break;
		case "wait":
			if (question.kind === "machine_away") {
				c.state("waiting", {
					reason: "machine",
					sentence: "Waiting for the machine to come back, as you asked. The turn resumes by itself then.",
					retryAt: null,
				});
				break;
			}
			if (question.kind === "sandboxes") {
				c.state("waiting", {
					reason: "sandboxes",
					sentence: "Waiting for a hosted sandbox to be freed, as you asked.",
					retryAt: null,
				});
				break;
			}
			if (run.lastFailure === "integration/no-ci") run.lastFailure = null;
			if (run.ci !== null) run.ci.since = c.at;
			pollCi(c, 0, null, `Waiting for CI on ${shortSha(run.ci?.head ?? "")}${auto ? "" : ", as you asked"}.`);
			break;
		case "hand_over":
			if (run.ci !== null && run.ci.head === item.head) readForHandoff(c, run.ci, keptReview(run, run.ci));
			else if (!item.parent && item.mode !== "orchestrate") {
				run.handOver = true;
				c.say("The work is pushed as it is, to be handed over.");
				publish(c);
			} else return false;
			break;
		case "fix":
			if (question.kind !== "review_question" || !resumeWithNote) return false;
			fixAfterReview(c, resumeWithNote);
			break;
		case "run_anyway": {
			// Approval covers only these named sources on subsequent turns.
			const outside = thirdParty(resume?.untrusted);
			if (question.kind !== "turn_refused" || !resumeWithNote || !outside.length) return false;
			item.unsandboxed = sources(item.unsandboxed, outside);
			c.say(runAnywayWords(itemAgent(item).harness, outside));
			nextTurn(c, resumeWithNote);
			break;
		}
		case "larger_sandbox": {
			const larger = question.kind === "out_of_memory" ? question.largerSize : undefined;
			if (item.place.kind !== "hosted" || larger === undefined || !resumeWithNote) return false;
			c.say(`The sandbox is removed, and the step goes on in a new ${larger} one.`);
			c.state("working");
			c.effects.push({
				kind: "fresh_sandbox",
				key: c.key,
				plan: resumeWithNote,
				hostedSize: larger,
				...(resumeWithNote.to === "review" && { to: "review" as const }),
			});
			break;
		}
		case "fresh_sandbox":
			if (question.kind !== "sandbox_failed" || !resumeWithNote) return false;
			// The old sandbox goes first; `sandbox_freed` starts the step once it is gone.
			c.say("The sandbox is removed, and the step starts again in a new one.");
			c.state(item.place.kind === "machine" ? "queued" : "working");
			c.effects.push({
				kind: "fresh_sandbox",
				key: c.key,
				plan: resumeWithNote,
				...(resumeWithNote.to === "review" && { to: "review" as const }),
			});
			break;
		case "add_secret":
		case "without_secret":
			if (!question.secret || !resume) return false;
			if (fact.choice === "without_secret") (run.declinedSecrets ??= []).push(question.secret.name);
			nextTurn(c, {
				...resume,
				includeInFresh: true,
				text:
					fact.choice === "add_secret"
						? `${question.secret.name} is now set in your environment.`
						: `Continue without ${question.secret.name}.`,
			});
			break;
		case "reply":
			if (question.kind !== "agent_ask" || resume === null || note === null) return false;
			// The person's answer, and nothing the agent wrote: trusted, whatever the turn it resumes carried.
			nextTurn(c, { ...resume, text: answeredText(note), untrusted: undefined });
			break;
	}
	return true;
}

const RAISED: Record<keyof ItemBudget, (n: number) => string> = {
	tokens: n => `The budget is now ${spellTokens(n)} tokens.`,
	hostedSeconds: n => `The hosted time budget is now ${spellSeconds(n)}.`,
	usd: n => `The budget is now ${spellUsd(n)} of work.`,
};

/** Stored round-cap causes resume like a repeated failure. */
function raise(
	c: Change,
	cause: StopCause | null,
	budget: Partial<ItemBudget> | undefined,
	resume: TurnPlan | null,
): void {
	const { item, run } = c;
	switch (cause) {
		case "repeated":
		case "plan":
		case "gate":
		case "ci":
		case "conflict":
		case "review":
			{
				const again = resume?.fingerprint ?? run.lastFailure;
				if (again !== null) run.failures = failuresOf(run).filter(one => one !== again);
				run.lastFailure = null;
			}
			break;
		case "interruptions":
			run.step.interruptions = 0;
			break;
		case "turns":
			item.backstopFrom = item.mode === "orchestrate" ? ownSpent(item, item.spent).turns : item.spent.turns;
			break;
		case "tokens":
		case "hostedSeconds":
		case "usd": {
			const before = item.mode === "orchestrate" && cause === "tokens" ? ownTokens(item) : (item.budget[cause] ?? 0);
			const spent =
				item.mode === "orchestrate" && cause === "tokens"
					? ownSpent(item, item.spent).tokens
					: (item.spent[cause] ?? 0);
			const asked = budget?.[cause];
			// Dollars keep their cents; tokens and seconds are whole.
			const exact = cause === "usd";
			const round = (n: number) => (exact ? Math.round(n * 100) / 100 : Math.round(n));
			// The person's own figure, when it is above what was spent; otherwise one more start's worth on top of what was spent.
			const next =
				typeof asked === "number" && Number.isFinite(asked) && asked > spent
					? round(asked)
					: Math.max(before, exact ? spent : Math.ceil(spent)) + extraOf(item, cause);
			if (item.mode === "orchestrate" && cause === "tokens") {
				item.ownTokens = next;
				item.budget.tokens = featureTotal(item).tokens;
			} else item.budget[cause] = round(next);
			c.say(RAISED[cause](item.budget[cause] ?? next));
			break;
		}
		default:
			break;
	}
}
