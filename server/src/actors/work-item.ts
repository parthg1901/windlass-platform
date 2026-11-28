// One actor per [uid, itemId] applies blueprint facts and owns the durable outbox.
// Commit the revision, events and keyed effects together before any I/O. Wake retries pending effects under the same keys.
// Creation requires the user actor’s grant for this item.

import { performSlackWrite, SLACK_QUESTIONS, SLACK_RECEIPTS } from "../slack/thread.js";
import { sourceEffects, type SourceEffect } from "../sources/effects.js";
import { itemUpdates } from "../sources/updates.js";
import { bindingTo, filingNote, issueBindingOf, originBinding, originOf } from "../sources/bindings.js";
import type { SourceBinding } from "../sources/types.js";
import { slackMayAnswer } from "../slack/blocks.js";
import type { SlackBinding } from "../factory/intake.js";
import { finishedItem, mergeKindAllowed, type TaskKind } from "../factory/readiness-track.js";
import { environmentFailure } from "../factory/check-environment.js";
import { plannerReadiness } from "../factory/readiness.js";
import { newAgent } from "../factory/budget.js";
import { networkBody, unionNetwork } from "../blocked-network.js";
import type { NetworkReceipt, ActorClient } from "./internal.js";
import { HIDDEN } from "../agent-publish.js";
import { readFeedback, feedbackId, type FeedbackNotice, type FeedbackSubject } from "./github-inbox.js";
import { sources, untrustedWords } from "../factory/untrusted.js";
import {
	batchText,
	cleanFeedback,
	feedbackWords,
	fingerprint,
	fits,
	oversizedFeedback,
	QUIET_MS,
	MOST_MS,
} from "../factory/feedback.js";
import { isAddressed } from "../github/events.js";
import type { FeedbackBatch, FeedbackEntry, HostedSplit } from "../contract.js";
import { GithubProblem } from "../github/repos.js";
import { verdictWords } from "../factory/verdict.js";
import { mergeCandidate, requiredCiBranches } from "../factory/autonomy.js";
import {
	APPROVALS,
	editablePartAgents,
	openPlanQuestions,
	PlanError,
	unattendedKeys,
} from "../factory/feature-plan.js";
import { criticSessionId } from "../factory/feature-ids.js";
import { contextAtPlace, partRun, resolveRun, runPlace, type RunSettings } from "../factory/resolve-run.js";
import { limitApplies, type PlacementInventory } from "../factory/placement.js";
import { hasPushCiAt, repositoryAdmission } from "../github/feature-ci.js";
import { branchFor } from "../codehost/branch.js";
import {
	featureBranch,
	subtaskBranch,
	openFeature,
	refHead,
	advanceFeatureRef,
	compareBranches,
	mergeIntoFeature,
	readyFeature,
	mergeReviewedPull,
} from "../github/feature.js";
import {
	crossRepo,
	integrationView,
	issueReference,
	linkSection,
	nextOpening,
	readyRefusal,
	repoOf,
	repoViews,
	withSection,
	INPUTS_DIRECTORY,
} from "../factory/cross-repo.js";
import {
	ForeignRun,
	dispatchIntegration,
	findIntegrationRun,
	integrationWorkflowProblem,
	readIntegrationRun,
} from "../github/integration.js";
import type { FeatureRepoState } from "../factory/types.js";
import { gitlabCi, gitlabOf, prepareGitlabMerge } from "./gitlab-item.js";
import { hostCaps } from "../codehost/capabilities.js";
import { hostFor, type BoundHost, type GithubBinding } from "../codehost/item.js";
import { keyOf } from "../codehost/ref.js";
import { GitlabError } from "../gitlab/app.js";
import {
	observeIssue,
	writeIssueComment,
	type IssueChanges,
	type IssueNotice,
	type ObservedIssue,
} from "./github-item.js";
import { recentSubject, type IssueBinding, type JiraBinding, type LinearBinding } from "../factory/intake.js";
import { CHECK_DENIED, checkConclusion, checkSummary, checkTitle, evidenceLine } from "../factory/verified-check.js";
import type { CheckRunUpdate } from "../github/checks.js";
import type { GithubUser } from "../github/app.js";
import { SUBTASK_HARNESSES, hostedCatalog, worksWithoutAsking } from "../sandbox/harnesses.js";
import {
	hostedSizeFor,
	type ItemReview,
	type ModelList,
	type PartScreenshots,
	type PlanSubtask,
	type SessionSummary,
	type WorkType,
} from "../contract.js";
import { itemAgent, ledgerSeconds, retryAt } from "../factory/budget.js";
import { addHosted, mergeUsage } from "../factory/cost.js";
import { partsRetryUsage } from "../factory/usage-summary.js";
import type { ReviewDelivery } from "./session-inbox.js";
import { actor, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { clientError, describeError, requireService, requireServiceFor, serviceParams } from "../auth.js";
import { config, githubConfig } from "../config.js";
import { redact } from "../github/redact.js";
import { githubId } from "../github/ids.js";
import {
	type GithubId,
	type ItemAction,
	type ItemEvent,
	type ItemReport,
	type ItemSummary,
	type ItemView,
	MAX_NOTE_CHARS,
	MAX_PUBLISH_TITLE_CHARS,
	MAX_PUBLISH_BODY_CHARS,
	type SandboxPlace,
	type SessionRepository,
	type Verdict,
} from "../contract.js";
import { MAX_SECRET_REQUESTS, secretRequestLimit } from "../repo-secrets.js";
import {
	activeJob,
	advance,
	rerunKey,
	personAdds,
	featureCiBranch,
	watchingParts,
	canRetry,
	canUpdateFeature,
	featureCiQuestion,
	featureUpdateChoice,
	completedKeys,
	currentKey,
	requestedDelivery,
	plannerCapacityText,
	nextPrPoll,
	prPollKey,
	singlePlanAlternative,
	turnCheckEffect,
	upgradeSubtaskQuestion,
} from "../factory/blueprint.js";
import {
	feedbackComment,
	itemComment,
	reviewRoundComment,
	requestedReviewBody,
	reportBlocks,
	REVIEW_OFF_REASON,
} from "../factory/review.js";
import type {
	Effect as BlueprintEffect,
	Fact,
	FactoryItem,
	RequestedReview,
	JoinResult,
	VerifiedCheckEffect,
} from "../factory/types.js";
import { type GithubApp, githubApp, GithubError, GraphqlRefusal } from "../github/app.js";
import { spellSeconds } from "../usage.js";
import { checkBaseFailures } from "../github/ci-base.js";
import { CI_POLLING, ciState, rerunnableJobs, workflowOverdue } from "../codehost/ci.js";
import { resolveBoundRepository } from "../github/repos.js";
import {
	type RequestedSecretSave,
	secretsActor,
	grantIsValid,
	isSessionGone,
	itemActor,
	sessionActor,
	userActor,
} from "./internal.js";
import type { DefaultBuilder, ItemFacts } from "./user-items.js";

/** What the item knows around the blueprint's `FactoryItem`. */
export interface ItemMeta {
	taskKind?: TaskKind;
	/** What the work's latest changes are, for the Usage summary (factory/usage-summary.ts). */
	workType?: WorkType;
	flaky?: boolean;
	ciCodeFailure?: boolean;
	mergedDifferentHead?: true;
	pendingBuilder?: DefaultBuilder;
	/** Sealed by the requesting session. Kept with the claim until the save is settled. */
	pendingSecret?: RequestedSecretSave;
	/** Latest cumulative receipt for each session. A retry or an older receipt adds nothing. */
	blockedSessions?: Record<string, NetworkReceipt>;
	/**
	 * Its bindings to work sources (sources/bindings.ts); items so far keep a field per source instead, read by
	 * `bindingsOf`. Never write it yet: these still read the per-source fields directly and would lose an item stored
	 * with only `bindings` until they go through `bindingTo`: `updateDirectory` (register/forget, `github_binding`),
	 * `queueIssueCheck` and `checkIssue`, the "Closes #n" lines in `crossOpenOrDescribe`, `dispatchFeature` and the
	 * `publish` effect, `onCreate` (Jira activation, `github_binding`), the Jira retry in `internalAct`, and
	 * `internalGithubRetry` / `internalGithubIssue`.
	 */
	bindings?: SourceBinding[];
	/** The GitHub issue the item was filed from: what its polling, issue comment and "Closes #n" are made from. Only set for a GitHub item. */
	github?: IssueBinding;
	/** The Linear issue it was filed from: the destination for its progress updates. */
	linear?: LinearBinding;
	jira?: JiraBinding;
	/** Only a generation captured at admission authorizes posting; never resolve a new mapping on retry. */
	slack?: SlackBinding;
	criticSessionId?: string;
	reviewerSessionId: string | null;
	reviewBase: { head: string; sha: string } | null;
	handoffReview: { recommendation: ItemReview["recommendation"]; reason: string | null } | null;
	uid: string;
	sessionId: string;
	/** The repository of the user's GitHub connection; `branch` is the base. */
	repository: SessionRepository;
	source: ItemSummary["source"];
	createdAt: number;
	activityAt: number;
	/** The latest verdict's result and flags, for the index. */
	verdict: ItemSummary["verdict"];
	/**
	 * The hosted sandbox seconds of the item's session over its whole life, and the ledger's holds already
	 * in it: the ledger keeps only its last days, so the item adds each hold once as it sees it. `hosted` is what
	 * billing made of those seconds as each was first seen (usage.ts `hostedSplit`); absent where no plan applied.
	 */
	ledger: { seconds: number; holds: string[]; hosted?: HostedSplit };
}

/** What `user` passes when it creates a `workItem`. */
export interface ItemCreateInput {
	placeNote?: string;
	/** A grant bound to this actor's key (internal.ts): proof that `user` created it. */
	grant: string;
	item: FactoryItem;
	meta: ItemMeta;
	/** The person who filed it, when it is started at once: the `start` fact is decided with the creation. */
	startedBy: string | null;
}

/** What a session answers about a turn of the item, as facts (session-inbox.ts). */
export type ItemPublishAnswer =
	| { kind: "base_conflict" }
	| { kind: "published"; head: string; pr: { number: number; url: string } | null }
	| { kind: "publish_failed"; said: string; transient: boolean };

interface Stored {
	item: FactoryItem;
	meta: ItemMeta;
}

interface ItemVars {
	jiraRetry?: Promise<boolean>;
	featureCi?: Partial<Record<PreviewSlot, { key: string; reading: Promise<Preview> }>>;
	savingSecret?: Promise<void>;
	/** Null for an actor `user` did not create. */
	stored: Stored | null;
	/** The tail of the write queue: every transaction runs after the one before it. */
	writing: Promise<unknown>;
	/** The effects being performed now, by row id: one is not performed twice at once. */
	performing: Set<string>;
	/** Every handoff edits the same comment, including a retry that overlaps the next run. */
	handoff: Promise<void>;
	/** The schedule that wakes the item for its earliest effect, as the item row has it. */
	due: { id: string; at: number } | null;
	reporting: Promise<void> | null;
	reportAgain: boolean;
}

interface Ctx {
	vars: ItemVars;
	db: RawAccess;
	key: string[];
	log: { warn(entry: unknown): void; error(entry: unknown): void };
	client(): ActorClient;
	keepAwake<T>(promise: Promise<T>): Promise<T>;
	schedule: {
		at(timestamp: number, action: string, ...args: unknown[]): Promise<string>;
		cancel(id: string): Promise<boolean>;
	};
}

/** How long an effect that could not be performed waits before it is tried again: 15 s, doubling, at most 5 min. */
const EFFECT_RETRY_FIRST_MS = 15_000;
const EFFECT_RETRY_MOST_MS = 5 * 60_000;
/**
 * GitHub refused to mark a draft feature PR ready for review: tried again after each of these waits, then the person is
 * asked to mark it ready (`pr_ready_read`). The rest of the handover goes on without it.
 */
export const READY_RETRY_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
/** GitHub refuses the ready-for-review mutation to a token with Pull requests write alone; it needs Contents write too. */
const READY_PERMISSIONS = { metadata: "read", contents: "write", pull_requests: "write" } as const;
/** The action the item's schedule fires: its name is looked up when it fires, so it is one constant (factory-e2e.ts checks it is registered). */
export const DUE_ACTION = "internalDue";
/** The item's page shows at most this many entries of its log, the newest. */
const VIEW_EVENTS = 500;

type IssueCheck = IssueChanges & { kind: "check_issue"; key: "pending"; at: number };
const ISSUE_CHANGE_WINDOW_MS = 15_000;

type FeedbackEffect =
	| { kind: "feedback_ready"; key: "pending"; at: number }
	| { kind: "feedback_ack"; key: string }
	| { kind: "feedback_comment"; key: string; run: number; who: string };
/** `register`'s `repo`: a cross-repo feature's other repository, by alias, registered with that repository's directory. */
type Effect =
	| { kind: "review_comment"; key: string; pr: number; parts?: { id: string; label: string }[] }
	| SourceEffect
	| { kind: "poll_branch"; key: string; at: number; repo?: string }
	| BlueprintEffect
	| FeedbackEffect
	| IssueCheck
	| { kind: "register"; key: string; pr: number; head: string; repo?: string }
	| { kind: "forget"; key: string };
/** A CI nudge with `pr` came from that pull request's own pipeline, which may have run a merge commit rather than the head. */
type GithubNudge = { installationId: GithubId; repositoryId: GithubId } & (
	| { kind: "ci"; head: string; pr?: number }
	| { kind: "pr"; pr: number }
);

type EffectRow = { id: string; effect: string; due_at: number; attempts: number };

function rowId(effect: Effect): string {
	if (effect.kind === "linear_write" && effect.key === "owner_needed")
		return `linear_write:owner_needed:${effect.questionId}`;
	return `${effect.kind}:${effect.kind === "ask" ? effect.question.id : effect.key}`;
}

/** Whether the turn of a `deliver` key is the first of its run (`<item>:<run>:<step>:<attempt>`, blueprint.ts `stepKey`). */
function startsRun(key: string): boolean {
	const [, , step, attempt] = key.split(":");
	return step === "1" && attempt === "1";
}

function secondReview(item: FactoryItem, meta: ItemMeta): ItemSummary["review"] {
	if (item.awaitingPlace) return null;
	if (!item.reviewer || "off" in item.reviewer) return { state: "off", recommendation: null };
	if (meta.handoffReview) {
		const last = item.run?.review?.filed ?? item.run?.review?.before;
		if (meta.handoffReview.reason)
			return {
				state: "none",
				recommendation: last?.recommendation === "changes_requested" ? last.recommendation : null,
			};
		return { state: "filed", recommendation: meta.handoffReview.recommendation ?? last?.recommendation ?? null };
	}
	if (item.run?.step.kind !== "review") return null;
	return { state: item.run.step.turn === "started" ? "running" : "waiting", recommendation: null };
}

function summaryOf({ item, meta }: Stored): ItemSummary {
	const { repository } = meta;
	return {
		id: item.id,
		mode: item.mode ?? "single",
		parent: item.parent ?? null,
		title: item.task.title,
		repository: {
			provider: repository.provider,
			id: repository.id,
			owner: repository.owner,
			name: repository.name,
			branch: repository.branch,
			private: repository.private,
			url: repository.url,
		},
		...(crossRepo(item) && { repositories: repoViews(item), integration: integrationView(item) }),
		place: item.place,
		resolved: item.resolved,
		ranWith: item.ranWith,
		...(item.awaitingPlace && { awaitingPlace: true }),
		...(item.placement && { placement: item.placement }),
		source: meta.source,
		origin: originOf(meta),
		state: item.state,
		wait: item.wait,
		question:
			item.question === null
				? null
				: {
						id: item.question.id,
						kind: item.question.kind,
						text: item.question.text,
						choices: item.question.choices,
						recommended: item.question.recommended ?? item.question.choices[0]?.id,
						askedAt: item.question.askedAt,
						...(item.question.push && { push: item.question.push }),
						...(item.question.secret && { secret: item.question.secret }),
						...(item.question.asked && { asked: item.question.asked }),
						...(item.question.criticReason && { criticReason: item.question.criticReason }),
						...(item.question.criticFindings && { criticFindings: item.question.criticFindings }),
						...(item.question.check && { check: item.question.check }),
					},
		pullRequest: item.pr,
		verdict: meta.verdict,
		review: secondReview(item, meta),
		budget: item.budget,
		spent: item.spent,
		...(item.jobs?.length && {
			// A part queued before its spend was recorded has none yet.
			partsUsage: mergeUsage(item.jobs.map(job => job.spent?.usage)),
			partsRetryUsage: partsRetryUsage(item.jobs),
		}),
		...(meta.workType && { workType: meta.workType }),
		...(item.startedAt !== undefined && { startedAt: item.startedAt }),
		agent: itemAgent(item),
		sessionId: meta.sessionId,
		createdAt: meta.createdAt,
		updatedAt: meta.activityAt,
		...(item.endedAt !== undefined && ENDED.has(item.state) && { endedAt: item.endedAt }),
		revision: item.revision,
		...(item.run &&
			item.run.endedAt === null &&
			!ENDED.has(item.state) && {
				step: {
					kind: item.run.step.kind,
					startedAt: item.run.step.startedAt,
					turn: item.run.step.turn,
					rounds: { ...item.run.rounds, review: item.run.rounds.review ?? 0 },
				},
			}),
	};
}

// Read through the write queue so the current question and its log come from the same revision.
async function viewOf(c: Ctx): Promise<ItemView> {
	const read = () =>
		queued(c, async () => {
			const stored = await load(c.db);
			if (!stored) throw new UserError("That item does not exist.", { code: "item_not_found" });
			return { stored, view: await pageOf(c, stored) };
		});
	let { stored, view } = await read();
	if (
		view.plan?.status === "proposed" &&
		["plan_approval", "replan_approval", "single_suggested"].includes(view.question?.kind ?? "")
	) {
		const inventory = await placementInventory(c, stored.meta.uid, stored.item.agent?.model);
		if (await take(c, { kind: "refresh_plan", version: view.plan.version, inventory, at: Date.now() }))
			({ stored, view } = await read());
	}
	const { item } = stored;
	const q = view.question;
	if (
		q &&
		(q.kind === "plan_approval" || q.kind === "replan_approval") &&
		item.featurePlan?.status === "proposed" &&
		item.filedTurn === currentKey(item) &&
		!crossRepo(item)
	) {
		try {
			await checkFeatureCi(c, stored, {}, true);
		} catch (error) {
			const fallback = singlePlanAlternative(item);
			const block =
				error instanceof PlanError
					? error.message
					: "The platform could not verify this repository’s push CI. Refresh the item to check again.";
			q.approvalBlock = block;
			q.text += "\n" + block;
			q.choices = q.choices.filter(choice => choice.id !== "approve");
			if (fallback) q.choices.unshift(fallback);
		}
	}
	if (item.mode === "orchestrate" || (item.parent && featureCiQuestion(item))) {
		const target = await targetStatus(c, stored).catch(() => null);
		if (target && !item.parent) {
			view.featureTargetAhead = target.value;
			view.canUpdateFeature = target.available && target.value > 0;
		}
		if (q && featureCiQuestion(item)) {
			q.choices = q.choices.filter(choice => choice.id !== "update_feature");
			if (target?.available && target.value > 0) q.choices.splice(-1, 0, featureUpdateChoice(target.branch));
		}
	}
	if (q && !q.choices.some(option => option.id === q.recommended)) q.recommended = q.choices[0]?.id;
	return view;
}

export const FEEDBACK_TABLE =
	"CREATE TABLE IF NOT EXISTS feedback(id TEXT PRIMARY KEY,data TEXT NOT NULL,at INTEGER NOT NULL,received INTEGER NOT NULL,batch TEXT NOT NULL,ready INTEGER NOT NULL,after_run INTEGER NOT NULL DEFAULT -1,state TEXT NOT NULL DEFAULT 'pending',reason TEXT NOT NULL,run INTEGER,plan INTEGER,saved_plan TEXT)";
export const CHECKS_TABLE =
	"CREATE TABLE IF NOT EXISTS checks (sha TEXT PRIMARY KEY, check_run_id TEXT, external_id TEXT NOT NULL, state TEXT NOT NULL, conclusion TEXT, at INTEGER NOT NULL, said TEXT NOT NULL)";
export const REVIEWS_TABLE =
	"CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, run INTEGER NOT NULL, head TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)";

/** The report and its reference snapshots share one JSON value and one transaction with the turn. */
/** The verdict comment's id on each pull request the item handed over on (`writeMarkedComment`). */
export const VERDICT_COMMENT_TABLE =
	"CREATE TABLE IF NOT EXISTS verdict_comment(pr INTEGER PRIMARY KEY, id TEXT NOT NULL)";
export const REPORTS_TABLE =
	"CREATE TABLE IF NOT EXISTS reports (key TEXT PRIMARY KEY, run INTEGER NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)";

export async function storeReport(
	db: Pick<RawAccess, "execute">,
	item: FactoryItem,
	sessionId: string,
	fact: Extract<Fact, { kind: "turn_ended" }>,
): Promise<void> {
	if (!item.run || !fact.report || typeof fact.report === "string") return;
	const head = fact.pushedHead ?? null;
	const report: ItemReport = {
		by: "builder",
		sessionId,
		run: item.run.n,
		key: fact.key,
		head,
		at: fact.at,
		title: fact.report.title,
		blocks: reportBlocks(fact.report),
		records: [],
		screenshots: fact.report.screenshots.map(shot => ({ ...shot, head })),
	};
	await db.execute(
		"INSERT OR REPLACE INTO reports (key, run, at, data) VALUES (?, ?, ?, ?)",
		report.key,
		report.run,
		report.at,
		JSON.stringify(report),
	);
}

async function publishReport(db: Pick<RawAccess, "execute">, turn: string, head: string): Promise<void> {
	// A sandbox without a commit can return a branch name in its publish receipt.
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) return;
	const [row] = await db.execute<{ data: string }>("SELECT data FROM reports WHERE key = ?", turn);
	if (!row) return;
	const report: ItemReport = JSON.parse(row.data);
	report.head = head;
	for (const shot of report.screenshots) shot.head = head;
	await db.execute("UPDATE reports SET data = ? WHERE key = ?", JSON.stringify(report), turn);
}

export async function latestReport(
	db: Pick<RawAccess, "execute">,
	run: number,
	at = Number.MAX_SAFE_INTEGER,
): Promise<ItemReport | null> {
	const [row] = await db.execute<{ data: string }>(
		"SELECT data FROM reports WHERE run = ? AND at <= ? ORDER BY at DESC, rowid DESC LIMIT 1",
		run,
		at,
	);
	return row ? (JSON.parse(row.data) as ItemReport) : null;
}

type FeedbackRow = {
	id: string;
	data: string;
	batch: string;
	state: FeedbackBatch["state"];
	reason: string;
	run: number | null;
	plan: number | null;
	saved_plan: string | null;
};

async function feedbackView(db: RawAccess): Promise<ItemView["feedback"]> {
	const batches = new Map<string, FeedbackBatch>();
	for (const r of await db.execute<FeedbackRow>("SELECT * FROM feedback ORDER BY at, id")) {
		const key = r.state + ":" + r.batch;
		let batch = batches.get(key);
		if (!batch)
			batches.set(
				key,
				(batch = {
					entries: [],
					state: r.state,
					reason: r.reason,
					run: r.run,
					plan: r.plan,
					...(r.saved_plan && { savedPlan: JSON.parse(r.saved_plan) }),
				}),
			);
		batch.entries.push(JSON.parse(r.data));
	}
	const [counts] = await db.execute<{ n: number }>(
		"SELECT count(*) AS n FROM issue_actions WHERE subject LIKE 'feedback-denied:%'",
	);
	return { batches: [...batches.values()], notTaken: counts.n };
}

async function recentReviews(db: Pick<RawAccess, "execute">, at = Number.MAX_SAFE_INTEGER): Promise<ItemReview[]> {
	const rows = await db.execute<{ data: string }>(
		"SELECT data FROM (SELECT data, at, rowid AS seq FROM reviews WHERE at <= ? ORDER BY at DESC, rowid DESC LIMIT 10) ORDER BY at, seq",
		at,
	);
	return rows.map(row => JSON.parse(row.data) as ItemReview);
}

async function pageOf(c: Ctx, stored: Stored): Promise<ItemView> {
	const run = stored.item.run;
	const events = await c.db.execute<{ data: string }>(
		"SELECT data FROM (SELECT seq, data FROM events ORDER BY seq DESC LIMIT ?) ORDER BY seq",
		VIEW_EVENTS,
	);
	const verdicts = await c.db.execute<{ data: string }>("SELECT data FROM verdicts ORDER BY at, id");
	const plan = stored.item.featurePlan;
	const completed = completedKeys(stored.item);
	const view: ItemView = {
		...summaryOf(stored),
		blockedNetwork: itemNetwork(stored.meta),
		feedback: await feedbackView(c.db),
		verifiedCheck:
			(
				await c.db.execute<NonNullable<ItemView["verifiedCheck"]>>(
					"SELECT sha, state, conclusion, said FROM checks WHERE sha = ?",
					run?.ci?.moved ?? stored.item.head ?? "",
				)
			)[0] ?? null,
		plan: plan ?? null,
		...(stored.item.jobs && {
			subtasks: stored.item.jobs.map(j => ({
				id: j.id,
				key: j.task.key,
				state: j.state,
				dispatchedAt: j.dispatchedAt ?? null,
				startedAt: j.startedAt ?? null,
				wait: j.wait ?? j.placementRefusal ?? null,
			})),
		}),
		...(plan && {
			editableAgents: editablePartAgents(
				plan,
				stored.item.state,
				run?.step.kind,
				(stored.item.jobs ?? []).map(j => j.task.key),
			),
			unattended: unattendedKeys(plan, completed),
			completedSubtasks: [...completed],
		}),
		...(stored.item.replanWhy && { replanWhy: stored.item.replanWhy }),
		canRetry: canRetry(stored.item),
		reviewerSessionId: stored.meta.reviewerSessionId ?? null,
		reviewNone:
			stored.meta.handoffReview?.reason ??
			(stored.item.reviewer && "off" in stored.item.reviewer ? REVIEW_OFF_REASON[stored.item.reviewer.off] : null),
		reviews: await recentReviews(c.db),
		task: stored.item.task,
		// What the gate and CI read stays here: the page shows the run as the contract has it.
		run:
			run === null
				? null
				: {
						n: run.n,
						startedAt: run.startedAt,
						endedAt: run.endedAt,
						stopReason: run.stopReason,
						...(stored.item.parent && { failureFingerprint: run.lastFailure }),
						step: run.step,
						autoSteps: run.autoSteps ?? 0,
						rounds: { ...run.rounds, review: run.rounds.review ?? 0 },
					},
		head: stored.item.head,
		report: run ? await latestReport(c.db, run.n) : null,
		events: events.map(row => JSON.parse(row.data) as ItemEvent),
		verdicts: verdicts.map(row => JSON.parse(row.data) as Verdict),
	};
	if (ENDED.has(view.state)) {
		const { meta, item } = stored;
		view.record =
			view.parent || crossRepo(item)
				? null
				: finishedItem(
						view,
						meta.taskKind,
						meta.flaky,
						item.jobs?.some(j => j.ciFix),
					);
		if (view.record && meta.mergedDifferentHead) view.record.verified = view.record.clean = false;
		const gate = (item.run?.ci?.gate ?? item.run?.gate)?.verified;
		const gateFailed = gate?.run?.checks.some(c => c.status === "failed" && !c.startError && !environmentFailure(c));
		if (
			view.record?.failed &&
			!gateFailed &&
			(meta.ciCodeFailure === false || (gate && view.verdict?.ci !== "failed" && !item.run?.rounds.ci))
		)
			view.record.failed = false;
	}
	return view;
}

async function indexedSummary(c: Ctx, stored: Stored) {
	if (!ENDED.has(stored.item.state)) return summaryOf(stored);
	return queued(c, async () => {
		const saved = (await load(c.db))!;
		return { ...summaryOf(saved), record: (await pageOf(c, saved)).record };
	});
}

/** Sends summaries to the user's index until the newest has gone; calls meanwhile collapse into one more. */
function report(c: Ctx): void {
	c.vars.reportAgain = true;
	if (c.vars.reporting) return;
	const loop = (async () => {
		await Promise.resolve();
		try {
			while (c.vars.reportAgain && c.vars.stored) {
				c.vars.reportAgain = false;
				try {
					await userActor(c, c.vars.stored.meta.uid).internalItemChanged(await indexedSummary(c, c.vars.stored));
				} catch (error) {
					c.log.warn({ msg: "could not report the item's summary to its user", error: describeError(error) });
				}
			}
		} finally {
			c.vars.reporting = null;
		}
	})();
	c.vars.reporting = loop;
	void c.keepAwake(loop);
}

function queued<T>(c: Ctx, job: () => Promise<T>): Promise<T> {
	const run = c.vars.writing.then(job, job);
	c.vars.writing = run.catch(() => undefined);
	return run;
}

/** The key of the item's repository, or of a cross-repo feature's other repository on the same host. */
const keyIn = (meta: ItemMeta, repositoryId = meta.repository.id) => keyOf({ ...meta.repository, id: repositoryId });

async function repositoryAutonomy(c: Ctx, meta: ItemMeta, repositoryId = meta.repository.id) {
	try {
		return await userActor(c, meta.uid).internalRepositoryAutonomy(keyIn(meta, repositoryId));
	} catch {
		return { autoApprovePlans: false, autoMergeSingles: false, waitForCiOnEachPart: false, mergeKinds: undefined };
	}
}

/** Whether a feature's parts wait for their own CI: fixed when the feature PR opens, so an unreadable setting fails the effect (it is tried again) rather than dropping the wait. */
async function waitsForPartCi(c: Ctx, meta: ItemMeta, repositoryId = meta.repository.id): Promise<boolean> {
	return (
		(await userActor(c, meta.uid).internalRepositoryAutonomy(keyIn(meta, repositoryId))).waitForCiOnEachPart === true
	);
}

async function autoApprovePlans(c: Ctx, { item, meta }: Stored) {
	const repositories = item.repos?.map(r => keyIn(meta, r.repositoryId)) ?? [keyIn(meta)];
	try {
		const user = userActor(c, meta.uid);
		const settings = await Promise.all(repositories.map(key => user.internalRepositoryAutonomy(key)));
		return settings.length > 0 && settings.every(s => s.autoApprovePlans);
	} catch {
		return null;
	}
}

/** Both receipt paths charge the same settled holds, including a replay after a restart. */
async function takeSessionFact(c: Ctx, stored: Stored, fact: Fact): Promise<void> {
	if (fact.kind === "turn_ended" || fact.kind === "review_ended") {
		const { item, meta } = stored;
		if (currentKey(item) === fact.key && (item.run?.step.kind === "refine" || item.run?.step.kind === "plan_review")) {
			const enabled = await autoApprovePlans(c, stored);
			if (fact.kind === "turn_ended") fact = { ...fact, autoApprovePlans: enabled === true };
			else if (fact.planReview?.decision === "approve") {
				let checking = "read the available places for the subtasks";
				try {
					if (enabled === null) throw new PlanError("The repository’s automatic approval setting could not be read.");
					if (!enabled) throw new PlanError("Automatic approval is turned off for this repository.");
					if (!item.featurePlan?.singleSuggested) {
						fact.inventory = await placementInventory(c, meta.uid, item.agent?.model);
						checking = "verify the repository’s CI requirements";
						await checkFeatureCi(c, stored);
					}
					fact = { ...fact, by: "critic" };
					checking = "validate the plan for approval";
					advance(item, fact);
				} catch (error) {
					fact = {
						...fact,
						by: undefined,
						approvalProblem:
							error instanceof PlanError || error instanceof GithubProblem
								? error.message
								: `The platform could not ${checking}.`,
					};
				}
			}
		}
		const hostedSeconds =
			stored.item.place.kind === "hosted"
				? lifetimeSeconds(stored.meta, await userActor(c, stored.meta.uid).internalItemFacts(sessionsOf(stored.meta))) +
					childSeconds(stored.item)
				: 0;
		await take(c, {
			...fact,
			spend: {
				tokens: fact.spend?.tokens ?? 0,
				...(fact.spend?.rawTokens !== undefined && { rawTokens: fact.spend.rawTokens }),
				hostedSeconds,
				...(stored.meta.ledger.hosted && { hosted: stored.meta.ledger.hosted }),
				...(fact.spend?.agent && { agent: fact.spend.agent }),
				...(fact.spend?.meter && { meter: fact.spend.meter }),
				...(fact.spend?.usd !== undefined && { usd: fact.spend.usd }),
			},
		});
	} else {
		await take(c, fact);
	}
}

function filedNote(meta: ItemMeta) {
	const origin = originBinding(meta);
	if (origin) return filingNote(origin);
	return `Filed from ${meta.source === "api" ? "the API" : "the web app"}.`;
}

async function activateJiraIssue(c: Pick<Ctx, "client">, uid: string, item: string, binding: JiraBinding) {
	const site = c.client().jiraSite.get([binding.siteId], { params: serviceParams() });
	if (!(await site.internalActivateIssue(binding.origin.jira.id, uid, item, binding.generation)))
		throw new UserError("A newer item has been filed for this Jira issue.", { code: "item_conflict" });
}

type CheckReceipt = {
	kind: "check_recorded";
	at: number;
	effect: VerifiedCheckEffect;
	id: string | null;
	installationId: GithubId;
};

/**
 * The item after `fact`, stored with its effects and events in one transaction over the revision it
 * was decided from, and then performed. Resolves once it is stored, with whether the fact changed
 * anything: an action that answers after this has answered for what is durable.
 */
async function take(
	c: Ctx,
	fact: Fact | CheckReceipt | { kind: "issue_note"; at: number } | { kind: "network_reported"; at: number },
	{
		baseSha,
		nudged,
		issue,
		overflow,
		secret,
		slackUser,
	}: {
		secret?: RequestedSecretSave;
		overflow?: string[];
		baseSha?: string | null;
		nudged?: boolean;
		issue?: Pick<ObservedIssue, "subject" | "by" | "said">;
		slackUser?: string;
	} = {},
): Promise<boolean> {
	// Order outside facts (including cancellation and GitHub events) after a claimed answer.
	if (fact.kind !== "claim_secret" && fact.kind !== "settle_secret" && c.vars.savingSecret)
		await c.vars.savingSecret.catch(() => {});
	const stored = c.vars.stored;
	if (!stored) return false;
	// From here to the write being queued nothing is awaited: the decision is one step.
	const before = stored.item;
	const outcome: ReturnType<typeof advance> =
		fact.kind === "issue_note" || fact.kind === "network_reported" || fact.kind === "check_recorded"
			? { item: { ...before, revision: before.revision + 1 }, effects: [], events: [] }
			: advance(before, fact);
	if (outcome.item === before) return false;
	if (issue?.said) outcome.events.push({ at: fact.at, by: issue.by, step: null, said: issue.said });
	stored.item = outcome.item;
	if (fact.kind === "pr_read" && fact.state === "merged" && fact.prHead && fact.prHead !== before.head)
		stored.meta.mergedDifferentHead = true;
	if (fact.kind === "published") delete stored.meta.ciCodeFailure;
	if (fact.kind === "turn_ended" && fact.changes && currentKey(before) === fact.key) {
		stored.meta.taskKind = fact.taskKind;
		stored.meta.workType = fact.workType;
	}
	if (fact.kind === "ci_read" && fact.reading.kind === "read" && fact.head === fact.reading.head) {
		const failed = fact.reading.runs.filter(r => r.state === "failed");
		const retry = outcome.effects.find(e => e.kind === "rerun_ci") ?? before.ciReruns?.[rerunKey(fact)];
		if (failed.some(r => r.baseResult === "failed" && !retry?.jobs.some(j => j.failed && j.jobId === r.jobId)))
			stored.meta.flaky = true;
		if (failed.length && before.run?.step.kind === "ci")
			stored.meta.ciCodeFailure = failed.some(r => !r.environment && !r.baseResult);
	}
	if (outcome.item.run?.step.kind === "plan_review") stored.meta.criticSessionId = criticSessionId(outcome.item.id);
	if (fact.kind === "default_place_ready") {
		delete stored.meta.pendingBuilder;
		stored.meta.reviewerSessionId = fact.reviewerSessionId;
	}
	if (fact.kind === "claim_secret") stored.meta.pendingSecret = secret;
	if (fact.kind === "settle_secret") delete stored.meta.pendingSecret;
	// Polls advance the revision and retry counters even when nothing happened on the item.
	const next = outcome.item;
	if (
		outcome.events.length ||
		before.state !== next.state ||
		before.run?.n !== next.run?.n ||
		before.run?.step.n !== next.run?.step.n ||
		before.run?.step.turn !== next.run?.step.turn ||
		before.question?.id !== next.question?.id ||
		before.pr?.number !== next.pr?.number
	) {
		stored.meta.activityAt = Math.max(stored.meta.activityAt, fact.at);
	}
	const handoff = outcome.effects.find(
		(effect): effect is Extract<Effect, { kind: "handoff" }> => effect.kind === "handoff",
	);
	const strip = handoff ?? outcome.storeVerdict;
	if (strip)
		stored.meta.verdict = { result: strip.verdict.result, flags: strip.verdict.flags, ci: strip.verdict.ci.state };
	if (outcome.item.run?.n !== before.run?.n) {
		stored.meta.handoffReview = null;
		stored.meta.reviewBase = null;
	}
	const pin =
		outcome.storeVerdict ??
		(stored.meta.repository.provider === "gitlab" && fact.kind === "ci_read" && fact.prHead === handoff?.verdict.head
			? handoff
			: undefined);
	if (pin && baseSha && /^[0-9a-f]{40}$/.test(baseSha))
		stored.meta.reviewBase = { head: pin.verdict.head, sha: baseSha };
	const handedFiling =
		fact.kind === "review_ended" && fact.review?.id === outcome.item.run?.ci?.secondReview?.review ? fact.review : null;
	if (handedFiling) stored.meta.handoffReview = { recommendation: handedFiling.recommendation, reason: null };
	// Every filing the blueprint took is kept, the rounds that sent the builder back too: the page shows each round.
	let filing =
		handedFiling ??
		(fact.kind === "review_ended" && fact.review && fact.review.id === outcome.tookReview ? fact.review : null);
	if (filing && before.requestedReview?.key === filing.id) {
		const { owner, name, pr } = before.requestedReview;
		filing = { ...filing, requestedPull: { owner, name, pr } };
	}
	if (handoff && before.run?.n === next.run?.n) {
		const recommendation = handoff.review !== null ? handoff.assessment?.recommendation : null;
		stored.meta.handoffReview = {
			recommendation: recommendation ?? stored.meta.handoffReview?.recommendation ?? null,
			reason: handoff.reviewNone,
		};
	}
	// The item, its revision and its data are taken from this decision now: a later decision, made while this
	// one waits for its write, changes `stored` and must not be written beside this one's data.
	const data = JSON.stringify({ item: next, meta: stored.meta });
	// An `ask` is the question on the item itself, which reaches the index with the summary: nothing is left to perform.
	const effects: Effect[] = outcome.effects.filter(effect => effect.kind !== "ask");
	if (filing && !filing.requestedPull && before.pr) {
		// Pin the parts and their plan numbers before a new fix or replan can change them.
		const parts = before.jobs
			?.filter(job => job.startedAt !== undefined || job.report || job.state === "done")
			.map(job => {
				const index = before.approvedPlan?.subtasks.findIndex(task => task.key === job.task.key) ?? -1;
				return { id: job.id, label: index < 0 ? job.task.title : "Part " + (index + 1) + ": " + job.task.title };
			});
		effects.push({ kind: "review_comment", key: filing.id, pr: before.pr.number, parts });
	}
	// A cut-off review may have left its checkout paused while the item waited for its owner.
	// Keep cleanup in the outbox, independently of GitHub and of a withdrawal still stopping a turn.
	if (
		stored.meta.reviewerSessionId &&
		next.run &&
		before.state !== next.state &&
		(next.state === "review" || ENDED.has(next.state))
	) {
		effects.push({ kind: "release_review", key: String(next.run.n), run: next.run.n, to: "review" });
	}
	if (stored.meta.reviewerSessionId && handoff?.continuedIn)
		effects.push({ kind: "release_review", key: String(handoff.verdict.run), run: handoff.verdict.run, to: "review" });
	const updates = itemUpdates(before, next, fact, {
		handoff: !!handoff,
		...(slackUser && { by: { source: "slack", person: slackUser } }),
	});
	effects.push(
		...sourceEffects(stored.meta, updates, next, { url: itemUrl(next.id), issueGone: issue?.subject === "gone" }),
	);
	const sibling =
		fact.kind === "feature_ready" && fact.repo && crossRepo(next) && repoOf(next, fact.repo) !== next.repos![0]
			? fact.repo
			: null;
	if (sibling && fact.kind === "feature_ready")
		effects.push({
			kind: "register",
			key: fact.key + "/" + sibling,
			pr: fact.pr.number,
			head: fact.head,
			repo: sibling,
		});
	else if (fact.kind === "feature_ready" || (fact.kind === "published" && fact.pr))
		effects.push({ kind: "register", key: fact.key, pr: fact.pr!.number, head: fact.head });
	if (
		fact.kind !== "published" &&
		fact.kind !== "feature_ready" &&
		(before.run?.ci?.moved !== next.run?.ci?.moved || (next.mode === "orchestrate" && before.head !== next.head)) &&
		next.pr &&
		next.head &&
		!ENDED.has(next.state)
	)
		effects.push({ kind: "register", key: String(next.revision), pr: next.pr.number, head: next.head });
	for (const repo of next.repos?.slice(1) ?? []) {
		if (
			repo.featureCi &&
			repo.pr &&
			repo.head &&
			fact.kind !== "feature_ready" &&
			repo.head !== repoOf(before, repo.alias).head
		)
			effects.push({
				kind: "register",
				key: next.revision + "/" + repo.alias,
				pr: repo.pr.number,
				head: repo.head,
				repo: repo.alias,
			});
	}
	if (ENDED.has(next.state) && !ENDED.has(before.state)) effects.push({ kind: "forget", key: String(next.revision) });
	scheduleBranchPolls(effects, before, next, fact.at);
	try {
		await queued(c, () =>
			c.db.transaction(
				async tx => {
					const [row] = await tx.execute<{ revision: number }>("SELECT revision FROM item WHERE id = 1");
					if (row?.revision !== before.revision)
						throw new Error(`the item is at revision ${row?.revision ?? "none"}, not ${before.revision}`);
					if (issue) await tx.execute("INSERT INTO issue_actions VALUES(?)", issue.subject);
					if (fact.kind === "request_review")
						await tx.execute("INSERT INTO issue_actions VALUES(?),(?)", fact.subject, reviewHeadSubject(fact.request));
					await tx.execute("UPDATE item SET revision = ?, data = ? WHERE id = 1", next.revision, data);
					// What this decision left behind goes with it: a publish waiting for its retry is not done for a cancelled item.
					for (const old of await tx.execute<{ id: string; effect: string }>("SELECT id, effect FROM effects")) {
						if (
							(issue?.subject === "gone" && old.id === "issue_comment:link") ||
							!live(next, JSON.parse(old.effect) as Effect)
						)
							await tx.execute("DELETE FROM effects WHERE id = ? AND effect = ?", old.id, old.effect);
					}
					if (next.feedbackReplans && next.featurePlan?.version !== before.featurePlan?.version && next.featurePlan) {
						const { version, spec, subtasks } = next.featurePlan;
						await tx.execute(
							"UPDATE feedback SET plan=?,saved_plan=? WHERE state='taken' AND run=?",
							version,
							JSON.stringify({ goal: spec.goal, subtasks: subtasks.map(t => t.title) }),
							next.run!.n,
						);
					}
					if (overflow?.length) {
						await tx.execute(
							"UPDATE feedback SET state='pending', reason=?, after_run=?, batch='overflow' WHERE id IN (SELECT value FROM json_each(?))",
							feedbackWords.overflow,
							before.run?.n ?? 0,
							JSON.stringify(overflow),
						);
					}
					for (const decision of outcome.feedback ?? []) {
						const ids = JSON.stringify(decision.ids);
						await tx.execute(
							"UPDATE feedback SET state=?,reason=?,run=?,plan=?,batch=? WHERE id IN (SELECT value FROM json_each(?))",
							decision.state,
							decision.reason,
							decision.run ?? null,
							decision.plan ?? null,
							decision.ids[0],
							ids,
						);
						if (decision.state !== "taken") continue;
						await tx.execute("INSERT OR IGNORE INTO issue_actions SELECT value FROM json_each(?)", ids);
						const writers = new Set<string>();
						for (const row of await tx.execute<{ data: string }>(
							"SELECT data FROM feedback WHERE id IN (SELECT value FROM json_each(?))",
							ids,
						)) {
							const entry: FeedbackEntry = JSON.parse(row.data);
							writers.add("@" + entry.author);
							if (entry.kind.endsWith("_comment")) effects.push({ kind: "feedback_ack", key: entry.id });
						}
						effects.push({
							kind: "feedback_comment",
							key: String(decision.run),
							run: decision.run!,
							who: [...writers].join(", "),
						});
					}
					if (ENDED.has(next.state) && next.state !== before.state)
						await tx.execute(
							"UPDATE feedback SET state='declined',reason=? WHERE state IN ('pending','held','question')",
							feedbackWords.ended(next.state),
						);
					if (fact.kind === "github_feedback" || before.run?.n !== next.run?.n || ENDED.has(next.state))
						await scheduleFeedback(tx, next);
					if (fact.kind === "check_recorded") await storeCheckReceipt(tx, next.id, fact, outcome.events);
					for (const event of outcome.events)
						await tx.execute("INSERT INTO events (at, data) VALUES (?, ?)", event.at, JSON.stringify(event));
					for (const effect of effects) {
						// Rework can reopen a posted check or one whose POST reply is still outstanding.
						if (
							effect.kind === "verified_check" &&
							effect.existingOnly &&
							!(
								await tx.execute(
									"SELECT 1 FROM checks WHERE sha=? AND check_run_id IS NOT NULL UNION ALL SELECT 1 FROM effects WHERE id=? LIMIT 1",
									effect.key,
									rowId(effect),
								)
							).length
						)
							continue;
						if (effect.kind === "verified_check" && effect.state === "completed" && handoff && effect.verdictId)
							await prepareCompletedCheck(tx, next, effect, handoff);
						await tx.execute(
							`INSERT OR ${effect.kind === "requested_review" || effect.kind === "linear_write" || effect.kind === "jira_comment" || effect.kind === "slack_write" ? "IGNORE" : "REPLACE"} INTO effects (id, effect, due_at, attempts) VALUES (?, ?, ?, 0)`,
							rowId(effect),
							JSON.stringify(effect),
							"at" in effect && effect.at !== undefined ? effect.at : 0,
						);
					}
					if (fact.kind === "turn_ended" && currentKey(before) === fact.key)
						await storeReport(tx, before, stored.meta.sessionId, fact);
					if (fact.kind === "published" && before.run?.gate && !before.run.updateFromBase)
						await publishReport(tx, before.run.gate.turn, fact.head);
					if (filing) {
						const r = filing;
						await tx.execute(
							"INSERT OR REPLACE INTO reviews (id, run, head, at, data) VALUES (?, ?, ?, ?, ?)",
							r.id,
							r.run,
							r.head,
							r.at,
							JSON.stringify(r),
						);
					}
					if (strip)
						await tx.execute(
							"INSERT OR REPLACE INTO verdicts (id, run, head, at, data) VALUES (?, ?, ?, ?, ?)",
							strip.verdict.id,
							strip.verdict.run,
							strip.verdict.head,
							strip.verdict.at,
							JSON.stringify(strip.verdict),
						);
				},
				{ name: "item.take" },
			),
		);
	} catch (error) {
		// What is stored is what holds: the item is read again, and the fact is lost to whoever sends it again.
		c.vars.stored = await load(c.db).catch(() => c.vars.stored);
		throw error;
	}
	if (nudged && fact.kind === "ci_read") {
		const state = next.run?.ci?.lastReadState;
		const previous = before.run?.ci?.lastReadState ?? before.run?.ci?.last?.state;
		if (state && state !== "retry" && state !== previous)
			console.log(`[wlp] factory.ci.nudge_found item=${next.id} head=${fact.head.slice(0, 7)} state=${state}`);
	}
	if (fact.kind === "check_recorded") {
		if (fact.id === null && outcome.events.length)
			console.log(`github.verified_check.not_permitted installation=${fact.installationId} item=${next.id}`);
	} else {
		for (const event of outcome.events)
			console.log(
				`[wlp] item.event uid=${stored.meta.uid} item=${before.id} revision=${next.revision}: ${event.said.replace(/\s+/g, " ").slice(0, 200)}`,
			);
	}
	report(c);
	// The item's one schedule, set before anything is performed: an item stopped by a deploy before its effects ran wakes for them.
	await armDue(c);
	void c.keepAwake(performDue(c));
	return true;
}

/** Serialize all item transitions behind the durable claim, including a replay after a restart. */
function saveClaimedSecret(c: Ctx, input: RequestedSecretSave, recover = false): Promise<void> {
	if (c.vars.savingSecret) throw new UserError("The secret is being saved.", { code: "item_conflict" });
	const save = async () => {
		const { uid, sessionId } = c.vars.stored!.meta;
		const by = `person:${uid}`;
		if (
			!recover &&
			!(await take(
				c,
				{ kind: "claim_secret", at: Date.now(), by, question: input.requestId, name: input.name },
				{ secret: input },
			))
		)
			throw new UserError("That secret request is no longer open.", { code: "item_conflict" });
		let failure: string | null = null;
		let code = "bad_secret";
		try {
			await secretsActor(c, uid, sessionId).internalSaveRequestedSecret(sessionId, input);
		} catch (error) {
			const received = (error as { code?: unknown })?.code;
			if (
				error instanceof Error &&
				typeof received === "string" &&
				["secret_exists", "secrets_disabled", "bad_secret", "too_many_secrets"].includes(received)
			) {
				failure = error.message;
				code = received;
			} else failure = "The platform could not confirm the secret was saved. Check Secrets before retrying.";
		}
		if (!(await take(c, { kind: "settle_secret", at: Date.now(), by, question: input.requestId, error: failure })))
			throw new Error("The claimed secret question could not be settled.");
		if (failure) throw new UserError(failure, { code });
	};
	c.vars.savingSecret = save().finally(() => {
		delete c.vars.savingSecret;
	});
	return c.vars.savingSecret;
}

async function load(db: RawAccess): Promise<Stored | null> {
	const [row] = await db.execute<{ data: string }>("SELECT data FROM item WHERE id = 1");
	if (!row) return null;
	const stored = JSON.parse(row.data) as Stored;
	// Older rows stamped every poll. Recover their last activity from the event log and recorded transitions.
	if (stored.meta.activityAt === undefined) {
		const [last] = await db.execute<{ at: number | null }>("SELECT MAX(at) AS at FROM events");
		const { run, question, endedAt } = stored.item;
		stored.meta.activityAt = Math.max(
			stored.meta.createdAt,
			last?.at ?? 0,
			run?.step.startedAt ?? 0,
			run?.endedAt ?? 0,
			question?.askedAt ?? 0,
			endedAt ?? 0,
		);
	}
	upgradeSubtaskQuestion(stored.item);
	if (
		stored.item.parent &&
		(!stored.item.reviewer || ("off" in stored.item.reviewer && stored.item.reviewer.off === "deployment"))
	) {
		stored.item.reviewer = { off: "feature" };
	} else if (!stored.item.awaitingPlace) stored.item.reviewer ??= { off: "deployment" };
	return stored;
}

type OldBuilder = Omit<DefaultBuilder, "context" | "role"> & {
	policy: RunSettings;
	mode: "single" | "orchestrate";
	model: string | null;
	effort: string | null;
	machineModel?: string;
	machineEffort?: string;
	hostedProfile: RunSettings["profile"];
	hostedSize?: RunSettings["hostedSize"];
};

/** Upgrade the filed job and every copy of an approved task before the outbox can retry them. */
async function loadOnWake(c: Pick<Ctx, "db" | "client">) {
	const stored = await load(c.db);
	if (!stored) return null;
	const { item, meta } = stored;
	const pending = meta.pendingBuilder as DefaultBuilder | OldBuilder | undefined;
	const old = pending && "policy" in pending ? pending : undefined;
	// A bound single item has no builder to place or subtasks to resolve.
	if (!old && (item.mode !== "orchestrate" || (item.context && item.runRole))) return stored;
	const { defaultPlace } = meta as ItemMeta & { defaultPlace?: RunSettings };
	const role = item.parent ? "part" : (old?.mode ?? item.mode) === "orchestrate" ? "planner" : "builder";
	const settings: RunSettings = { ...defaultPlace };
	if (old) {
		Object.assign(settings, old.policy, {
			profile: old.hostedProfile,
			hostedSize: old.hostedSize,
			model: old.model,
			effort: old.effort,
			machineModel: old.machineModel,
			machineEffort: old.machineEffort,
		});
		// Old Plan-first jobs always selected Windlass and its first machine profile.
		if (old.mode === "orchestrate") Object.assign(settings, { harness: "windlass", machineProfile: null });
	} else {
		// A bound session wins over the filing policy, which may have overflowed to Hosted.
		const session: SessionSummary | null = await sessionActor(c, meta.uid, meta.sessionId)
			.internalSummary()
			.catch(error => {
				if (isSessionGone(error)) return null;
				throw error;
			});
		const agent = itemAgent(item);
		const place = session?.place ?? item.place;
		const model = session?.model ?? agent.model;
		settings.place = runPlace(place);
		settings.harness = session?.harness ?? agent.harness;
		settings.placeFallback = "wait";
		if (settings.harness === "windlass") Object.assign(settings, { model, effort: agent.effort });
		else Object.assign(settings, { machineModel: model, machineEffort: agent.effort });
		if (place.kind === "machine")
			settings.machineProfile = session?.profile ?? item.placement?.profile ?? settings.machineProfile;
		else
			Object.assign(settings, {
				profile: session?.profile ?? item.placement?.profile,
				hostedSize: session?.hostedSize ?? item.placement?.hostedSize,
			});
	}
	if (settings.harness && settings.harness !== "windlass" && settings.place !== "hosted") {
		const signIn = item.agent?.signIn;
		settings.payer = signIn === "subscription" || signIn === "chatgpt" ? "machine" : "unconfirmed";
	}
	// A proposal already refreshed on a newer server can have repository layers but no filed item layer.
	const context = (item.context = { ...item.context, item: { ...settings, ...item.context?.item } });
	item.runRole = role;
	item.resolved = resolveRun(context, role);
	if (old) meta.pendingBuilder = { context, role, title: old.title, repository: old.repository, issue: old.issue };
	delete (meta as ItemMeta & { defaultPlace?: RunSettings }).defaultPlace;

	function recoverPart(task: PlanSubtask, route = item.routes?.[task.key]) {
		if (task.resolved) return;
		const place = route?.preferred ?? item.place;
		const part = {
			place: runPlace(place),
			model: settings.model,
			effort: task.agent?.model ? task.agent.effort : settings.effort,
			hostedSize: task.needs?.hostedSize ?? hostedSizeFor(task.needs ?? {}) ?? undefined,
		};
		// Resolve the saved machine id from the approved route, never a possibly renamed display name.
		const resolved = partRun({ item: part }, { ...task, place: undefined });
		if (
			resolved.agent !== "windlass" &&
			(place.kind === "machine" || route?.alternatives.some(p => p.kind === "machine"))
		)
			resolved.payer = "unconfirmed";
		task.resolved = resolved;
	}
	for (const plan of [item.approvedPlan, item.featurePlan]) {
		if (plan?.status === "approved") for (const task of plan.subtasks) recoverPart(task);
	}
	for (const job of item.jobs ?? []) recoverPart(job.task, job.route);
	await c.db.execute("UPDATE item SET data=? WHERE id=1", JSON.stringify(stored));
	return stored;
}

// Only the oldest Slack write competes for the timer. A rate-limited acknowledgement
// holds later replies in commit order, without holding up any non-Slack effect.
const RUNNABLE_EFFECT = `(id NOT GLOB 'slack_write:*' OR rowid = (SELECT MIN(rowid) FROM effects WHERE id GLOB 'slack_write:*'))`;

/**
 * Performs every effect that is due and not being performed, in the order they were stored, then sets
 * the schedule for the next one. An effect is removed once performed; one that failed is tried again
 * later. Never throws.
 */
async function performDue(c: Ctx): Promise<void> {
	try {
		const now = Date.now();
		const rows = (
			await c.db.execute<EffectRow>(
				`SELECT id, effect, due_at, attempts FROM effects WHERE due_at <= ? AND ${RUNNABLE_EFFECT} ORDER BY rowid`,
				now,
			)
		).filter(row => !c.vars.performing.has(row.id));
		for (const row of rows) c.vars.performing.add(row.id);
		// Armed before they are performed: a server that stops under a slow push leaves a schedule that wakes the item for it.
		if (rows.length > 0) await armDue(c);
		await Promise.all(rows.map(row => performRow(c, row)));
		await armDue(c);
	} catch (error) {
		c.log.error({ msg: "could not perform the item's effects", error: describeError(error) });
	}
}

async function performRow(c: Ctx, row: EffectRow): Promise<void> {
	c.vars.performing.add(row.id);
	try {
		const done = await perform(c, row);
		if (done === "deferred") return;
		await queued(c, async () => {
			// Found not wanted, it is let go only if the stored item does not want it either: the decision that retired it may
			// still be waiting for its write, which can fail, and the item read again then waits for this effect. That write
			// is queued before this one, so it has gone through or failed by now.
			if (!done) {
				const durable = await load(c.db);
				if (durable && live(durable.item, JSON.parse(row.effect) as Effect)) return;
			}
			await c.db.execute("DELETE FROM effects WHERE id = ? AND effect = ?", row.id, row.effect);
		});
	} catch (error) {
		const wait = Math.min(EFFECT_RETRY_MOST_MS, EFFECT_RETRY_FIRST_MS * 2 ** Math.min(row.attempts, 10));
		c.log.warn({
			msg: "an effect of the item could not be performed; it is tried again",
			effect: row.id,
			inSeconds: wait / 1000,
			error: row.id.startsWith("slack_write:")
				? "slack_write_retry"
				: row.id.startsWith("jira_comment:")
					? "jira_comment_retry"
					: row.id.startsWith("linear_write:")
						? "linear_write_retry"
						: describeError(error),
		});
		await queued(c, () =>
			c.db.execute(
				"UPDATE effects SET due_at = ?, attempts = attempts + 1 WHERE id = ? AND effect = ?",
				Date.now() + wait,
				row.id,
				row.effect,
			),
		).catch(() => undefined);
	} finally {
		c.vars.performing.delete(row.id);
	}
}

/**
 * One schedule, at the earliest effect still to perform; the one before it is cancelled. A stored
 * schedule whose time has passed is not armed: its firing may have been cut off after RivetKit took it.
 */
function armDue(c: Ctx): Promise<void> {
	return queued(c, () => armDueInQueue(c));
}

async function armDueInQueue(c: Ctx): Promise<void> {
	// An effect being performed now counts as due EFFECT_RETRY_FIRST_MS from now, not at its own time: armed "now" for it, the
	// schedule would fire again and again while a slow push goes on; left out, a server that stops under the push would
	// leave nothing to wake the item.
	const rows = await c.db.execute<{ id: string; due_at: number }>(
		`SELECT id, due_at FROM effects WHERE ${RUNNABLE_EFFECT}`,
	);
	const now = Date.now();
	const times = rows.map(row => (c.vars.performing.has(row.id) ? now + EFFECT_RETRY_FIRST_MS : row.due_at));
	const at = times.length === 0 ? null : Math.min(...times);
	const due = c.vars.due;
	if (at === null || (due !== null && due.at === at && due.at > Date.now())) return;
	const id = await c.schedule.at(Math.max(at, Date.now()), DUE_ACTION);
	c.vars.due = { id, at };
	await c.db.execute("UPDATE item SET due = ? WHERE id = 1", JSON.stringify(c.vars.due));
	if (due !== null) await c.schedule.cancel(due.id).catch(() => false);
}

async function binding(c: Ctx): Promise<GithubId | null> {
	const [row] = await c.db.execute<{ installation: string }>("SELECT installation FROM github_binding WHERE id = 1");
	return githubId(row?.installation);
}

/** Rebuild the one durable timer from unconsumed subjects, including overflow eligible in this run. */
async function scheduleFeedback(tx: Pick<RawAccess, "execute">, item: FactoryItem) {
	const [due] = await tx.execute<{ at: number | null }>(
		"SELECT min(ready) AS at FROM feedback WHERE state='pending' AND after_run < ?",
		item.run?.n ?? 0,
	);
	if (due.at === null) await tx.execute("DELETE FROM effects WHERE id='feedback_ready:pending'");
	else {
		const e: FeedbackEffect = { kind: "feedback_ready", key: "pending", at: due.at };
		await tx.execute("INSERT OR REPLACE INTO effects VALUES(?,?,?,0)", rowId(e), JSON.stringify(e), due.at);
	}
}

function refusedByGithub(error: unknown): error is GithubError {
	return error instanceof GithubError && !error.rateLimited && [403, 404, 422].includes(error.status);
}

const reviewHeadSubject = (r: Pick<RequestedReview, "repositoryId" | "pr" | "head">) =>
	`pr-review:${r.repositoryId}:${r.pr}:${r.head}`;

async function receiveFeedback(c: Ctx, notice: FeedbackNotice) {
	const changed = await queued(c, async () => {
		const stored = await load(c.db);
		if (!stored || !hostCaps(stored.meta.repository.provider).feedback) return false;
		const primary =
			stored.meta.repository.id === notice.repositoryId &&
			stored.item.pr?.number === notice.pr &&
			(await binding(c)) === notice.installationId;
		const sibling =
			notice.requestedReview &&
			stored.item.repos?.some(
				r =>
					r.repositoryId === notice.repositoryId &&
					r.installationId === notice.installationId &&
					r.pr?.number === notice.pr,
			);
		if (!primary && !sibling) return false;
		const { item } = stored;
		if (item.state === "done" || item.state === "cancelled") return false;
		const now = Date.now();
		return c.db.transaction(async tx => {
			if (notice.requestedReview) {
				const { id, head, base, sender, owner } = notice.requestedReview;
				if (ENDED.has(item.state)) return false;
				const subject = reviewHeadSubject({ ...notice, head });
				if (
					(await tx.execute("SELECT 1 FROM issue_actions WHERE subject IN (?,?)", id, subject)).length ||
					item.requestedReview
				) {
					await tx.execute("INSERT OR IGNORE INTO issue_actions VALUES(?)", id);
					return false;
				}
				if (!stored.meta.reviewerSessionId || !item.run) {
					await tx.execute("INSERT INTO issue_actions VALUES(?)", id);
					await tx.execute(
						"INSERT INTO events(at,data) VALUES(?,?)",
						now,
						JSON.stringify({
							at: now,
							step: null,
							by: "platform",
							said: "The requested PR review could not start because this item has no reviewer.",
						}),
					);
					return true;
				}
				const repo = item.repos?.find(r => r.repositoryId === notice.repositoryId) ?? stored.meta.repository;
				return {
					kind: "request_review" as const,
					at: now,
					subject: id,
					request: {
						key: `${item.id}:${item.run.n}:${subject}`,
						repositoryId: notice.repositoryId,
						installationId: notice.installationId,
						owner: repo.owner,
						name: repo.name,
						pr: notice.pr,
						head,
						base,
						sender,
						untrusted: !owner || !primary || !!item.foreignPush || stored.meta.reviewBase?.head !== head,
					},
				};
			}
			if (notice.denied || notice.approval) {
				const subject = notice.denied ? "feedback-denied:" + notice.denied : notice.approval!.id;
				const added = await tx.execute("INSERT OR IGNORE INTO issue_actions VALUES(?) RETURNING subject", subject);
				if (added.length && notice.approval)
					await tx.execute(
						"INSERT INTO events(at,data) VALUES(?,?)",
						now,
						JSON.stringify({
							at: now,
							step: null,
							by: "github:" + notice.approval.author,
							said: feedbackWords.approved(notice.approval.author),
						}),
					);
				return !!added.length;
			}
			const review = notice.entries.find(e => e.kind === "changes_requested" || e.kind === "commented");
			let added = false;
			for (const e of notice.entries) {
				const oversized = oversizedFeedback(e);
				const rows = await tx.execute(
					"INSERT OR IGNORE INTO feedback(id,data,at,received,batch,ready,state,reason) VALUES(?,?,?,?,?,?,?,?) RETURNING id",
					e.id,
					JSON.stringify(e),
					e.at,
					now,
					review?.id ?? "comments",
					review ? now : now + QUIET_MS,
					oversized ? "declined" : "pending",
					oversized ? feedbackWords.oversized : feedbackWords.waiting,
				);
				added ||= !!rows.length;
				// A line delivery can beat its review; the review collects the still-pending line.
				if (review && !rows.length)
					await tx.execute(
						"UPDATE feedback SET batch=?,ready=? WHERE id=? AND state='pending' AND batch='comments'",
						review.id,
						now,
						e.id,
					);
			}
			if (!added) return false;
			if (!review)
				await tx.execute(
					"UPDATE feedback SET ready=min(?, (SELECT min(received) FROM feedback WHERE state='pending' AND batch='comments') + ?) WHERE state='pending' AND batch='comments'",
					now + QUIET_MS,
					MOST_MS,
				);
			await scheduleFeedback(tx, item);
			return true;
		});
	});
	if (typeof changed === "object") {
		const admitted = await take(c, changed);
		if (!admitted)
			await queued(c, () => c.db.execute("INSERT OR IGNORE INTO issue_actions VALUES(?)", changed.subject));
		return admitted;
	}
	if (changed) await take(c, { kind: "issue_note", at: Date.now() });
	else await armDue(c); // A duplicate repairs a lost timer after a restart.
	return changed;
}

async function feedbackReady(c: Ctx) {
	const now = Date.now();
	const item = c.vars.stored!.item;
	const rows = await queued(c, () =>
		c.db.execute<FeedbackRow>(
			`SELECT * FROM feedback WHERE state='held' OR (state='pending' AND batch=(
		SELECT batch FROM feedback WHERE state='pending' AND ready<=? AND after_run<? ORDER BY ready, received, rowid LIMIT 1) AND after_run<?) ORDER BY at,id`,
			now,
			item.run?.n ?? 0,
			item.run?.n ?? 0,
		),
	);
	if (item !== c.vars.stored!.item || !rows.some(r => r.state === "pending")) return;
	const { taken, rest } = fits(rows.map(r => JSON.parse(r.data) as FeedbackEntry));
	const writers = [...new Set(taken.map(e => e.author))];
	const ids = taken.map(e => e.id),
		overflow = rest.map(e => e.id);
	if (ids.every(id => item.feedback?.held?.includes(id))) {
		// The current held batch is full. Keep the rest for the first eligible later run.
		await queued(c, () =>
			c.db.transaction(async tx => {
				await tx.execute(
					"UPDATE feedback SET after_run=?,batch='overflow',reason=? WHERE state='pending' AND id IN (SELECT value FROM json_each(?))",
					item.run?.n ?? 0,
					feedbackWords.overflow,
					JSON.stringify(overflow),
				);
				await scheduleFeedback(tx, c.vars.stored!.item);
			}),
		);
		return;
	}
	await take(
		c,
		{
			kind: "github_feedback",
			at: now,
			by: "github:" + writers[0],
			writers,
			ids,
			fingerprint: fingerprint(taken),
			text: batchText(taken, {
				pr: item.pr!.number,
				run: (item.run?.n ?? 0) + 1,
				head: item.run?.ci?.moved ?? item.head,
			}),
			others: taken.some(e => e.access !== "owner"),
		},
		{ overflow },
	);
}

/**
 * Whether a delivery from a cross-repo feature's other repository wakes anything: only its own PR's poll
 * once the feature is handed over (`merged`), through the installation bound to it at filing. Never the
 * primary's polls, whose PR may have the same number.
 */
export function siblingWakes(item: FactoryItem, sibling: FeatureRepoState, input: GithubNudge): boolean {
	if (input.installationId !== sibling.installationId || ENDED.has(item.state)) return false;
	if (input.kind === "ci") return watchingParts(item) && !!sibling.featureCi?.key && sibling.head === input.head;
	return item.run?.step.kind === "merged" && sibling.pr?.number === input.pr;
}

/** Under the item's write queue. A directory lookup may race a new push, a cancel, or a transfer. */
async function nudge(c: Ctx, input: GithubNudge, provider: SessionRepository["provider"] = "github"): Promise<boolean> {
	const stored = await load(c.db);
	if (!stored) throw new UserError("That item does not exist.", { code: "item_not_found" });
	const { item, meta } = stored;
	if (provider !== (meta.repository.provider ?? "github")) return false;
	// A cross-repo feature's other repository: its PR poll, woken only by a nudge from the installation bound to that repository at filing.
	const sibling =
		crossRepo(item) && input.repositoryId !== meta.repository.id
			? item.repos!.find(r => r.repositoryId === input.repositoryId)
			: undefined;
	if (sibling) {
		if (!siblingWakes(item, sibling, input)) return false;
	} else if (
		ENDED.has(item.state) ||
		input.repositoryId !== meta.repository.id ||
		(provider === "github" && input.installationId !== (await binding(c)))
	)
		return false;
	const repo = crossRepo(item) ? (sibling ?? item.repos![0]) : undefined;
	const ciKey = input.kind === "ci" && watchingParts(item) ? (repo ?? item).featureCi?.key : null;
	const id =
		repo && item.run?.step.kind === "merged" && input.kind === "pr"
			? `poll_repo_pr:${currentKey(item)}/${repo.alias}`
			: `poll_${input.kind}:${input.kind === "pr" ? prPollKey(item) : (ciKey ?? currentKey(item))}`;
	const [row] = await c.db.execute<EffectRow>("SELECT * FROM effects WHERE id = ?", id);
	if (!row || c.vars.performing.has(row.id)) return false;
	const poll: Effect = JSON.parse(row.effect);
	const matches =
		input.kind === "ci"
			? poll.kind === "poll_ci" &&
				(poll.head === input.head || (input.pr !== undefined && input.pr === (repo ?? item).pr?.number))
			: (poll.kind === "poll_pr" || poll.kind === "poll_repo_pr") && poll.pr === input.pr;
	if (!matches || !live(item, poll)) return false;
	// Pre-webhook CI rows did not retain GitHub's retry floor. Honor their scheduled read once.
	const legacyBackoff =
		item.run?.ci?.webhooks === undefined && item.wait?.sentence.includes("GitHub asked the platform to wait until");
	const floor = poll.kind === "poll_ci" ? (poll.notBefore ?? (legacyBackoff ? poll.at : 0)) : 0;
	const at = Math.max(Date.now() + 15_000, floor);
	if (row.due_at > at) {
		await c.db.execute("UPDATE effects SET due_at = ? WHERE id = ?", at, id);
		console.log(
			`[wlp] factory.${input.kind}.nudged item=${item.id}${input.kind === "ci" ? " head=" + input.head.slice(0, 7) : ""}`,
		);
	}
	// Also repairs a crash between the update and the timer write.
	await armDueInQueue(c);
	return true;
}

/** The item's code host (`hostFor`), through the installation the item was filed through. */
function hostOf(c: Ctx, meta: ItemMeta, access: "read" | "write" = "read", repo?: FeatureRepoState) {
	return hostFor(c, meta, { access, repo, installation: () => binding(c) });
}

/** A bound host with the GitHub App behind it at hand, for the flows that still call the App directly. */
type AppHost = BoundHost & GithubBinding;

/** Runs `perform` with a token for the bound repository, scoped to `permissions`. */
function tokenStep<T>(
	hub: AppHost,
	permissions: Record<string, "read" | "write">,
	perform: (hub: AppHost & { token: string; private: boolean }) => Promise<T>,
): Promise<T> {
	return hub.withToken(permissions, token => perform({ ...hub, token, private: hub.repository.private }));
}

/** The item's host where the flow needs the GitHub App: parts, cross-repo features, verdict checks and feedback. */
async function appHost(c: Ctx, meta: ItemMeta, access: "read" | "write" = "read", repo?: FeatureRepoState) {
	return appOf(await hostOf(c, meta, access, repo));
}

/** The bound host with its GitHub App; refuses a host without one, as GitLab is. */
function appOf(bound: BoundHost): AppHost {
	if (!bound.github) throw new Error("This operation requires a GitHub repository.");
	return { ...bound, ...bound.github };
}

async function reconcileFeedback(c: Ctx, meta: ItemMeta, hub: AppHost, pr: number) {
	const { app, installationId } = hub;
	const target = { repositoryId: meta.repository.id, installationId, pr };
	const now = Date.now();
	const [cursor] = await c.db.execute<{ since: number }>("SELECT since FROM feedback_cursor WHERE id=1");
	const subjects: FeedbackSubject[] = [];
	const since = Math.max(now - 3 * 86_400_000, (cursor?.since ?? meta.createdAt) - 1000);
	await app.withToken(
		installationId,
		{ repositoryId: target.repositoryId, permissions: { metadata: "read", pull_requests: "read" } },
		async token => {
			// Run again with a new token when a kept one is refused: nothing of a refused try is kept.
			subjects.length = 0;
			const repo = hub.repository;
			for (const r of await app.reviews(token, repo, pr)) {
				if (!recentSubject(r.at, now)) continue;
				if (
					r.state === "approved" ||
					r.state === "changes_requested" ||
					(r.state === "commented" && isAddressed(r.body, app.settings.slug) !== null)
				)
					subjects.push({ kind: "review", sender: r.author, association: r.association, id: r.id });
				// A single line comment comes as a "commented" review with an empty body: its lines may be addressed.
				// Only reviews since the last poll are opened, so each costs one call once.
				else if (r.state === "commented" && r.at >= since) {
					for (const line of await app.reviewComments(token, repo, pr, r.id))
						if (recentSubject(line.at, now) && isAddressed(line.body, app.settings.slug) !== null)
							subjects.push({
								kind: "review_comment",
								sender: line.author,
								association: line.association,
								id: line.id,
							});
				}
			}
			for (const r of await hub.host.listComments(token, repo.owner, repo.name, pr, true, since))
				if (r.id && r.person && isAddressed(r.body, app.settings.slug) !== null)
					subjects.push({ kind: "issue_comment", sender: r.person, association: r.association, id: r.id });
		},
		{ reuse: true },
	);
	for (const s of subjects) {
		const id = feedbackId(s);
		if (
			(
				await c.db.execute(
					"SELECT 1 FROM feedback WHERE id=? UNION ALL SELECT 1 FROM issue_actions WHERE subject IN (?,?) LIMIT 1",
					id,
					id,
					"feedback-denied:" + id,
				)
			).length
		)
			continue;
		const notice = await readFeedback(c, meta.uid, target, s, {
			pollingOwner: githubConfig().webhook ? undefined : hub.connectedUserId,
		});
		if (notice) await receiveFeedback(c, notice);
	}
	await c.db.execute("INSERT OR REPLACE INTO feedback_cursor VALUES(1,?)", now);
}

function planRepositories({ item, meta }: Stored): Record<string, GithubId> {
	return {
		...Object.fromEntries((item.repos ?? []).map(repo => [repo.alias, repo.repositoryId])),
		"": meta.repository.id,
	};
}

/** `featureModel`: the feature's Windlass model, which a Windlass subtask choosing only an effort runs. */
async function placementInventory(
	c: Ctx,
	uid: string,
	featureModel: string | undefined,
	snapshotRepository?: GithubId,
): Promise<PlacementInventory & { hostedCapacity: number }> {
	const repositories = planRepositories(c.vars.stored!);
	return { ...(await userActor(c, uid).internalPlacementInventory(repositories, snapshotRepository)), featureModel };
}

async function planCiBranches(c: Ctx, { item, meta }: Stored, repo?: FeatureRepoState) {
	const branch = repo ?? item;
	const waitForParts = branch.pr
		? !branch.featureCi
		: (await repositoryAutonomy(c, meta, repo?.repositoryId)).waitForCiOnEachPart;
	return requiredCiBranches(item, !!waitForParts, repo?.alias);
}

/**
 * Approval of a cross-repo plan: every repository is checked through its own installation before any
 * branch is made, and every refusal is named at once. Each needs saved checks and push CI on the actual
 * feature and child branch names; the combined run's repository needs the integration workflow; a base
 * that moved since the planner read it is named, and approval needs the person to reconfirm it (`bases`).
 */
async function checkCrossRepo(c: Ctx, stored: Stored, bases: Readonly<Record<string, string>>) {
	const { item, meta } = stored;
	const plan = item.featurePlan!;
	const problems: string[] = [];
	const unknown = Object.keys(bases).filter(alias => !item.repos!.some(r => r.alias === alias));
	if (unknown.length)
		problems.push(
			`bases names ${unknown.join(", ")}, which ${unknown.length === 1 ? "is" : "are"} not a repository of this feature.`,
		);
	for (const repo of item.repos!) {
		const label = `${repo.owner}/${repo.name}`;
		try {
			if (!(await userActor(c, meta.uid).internalHasChecks(repo.repositoryId)))
				problems.push(`${label}: add saved repository checks.`);
			const branches = await planCiBranches(c, stored, repo);
			problems.push(
				...(await tokenStep(
					await appHost(c, meta, "write", repo),
					{ contents: "read", actions: "read", checks: "read", statuses: "read", pull_requests: "read" },
					async ({ app, token, owner, name, private: hidden }) => {
						const found = await repositoryAdmission(app, token, owner, name, {
							alias: repo.alias,
							baseRef: repo.baseRef,
							ciBase: repo.pr ? featureBranch(item.id) : repo.baseRef,
							branches,
							planningBaseSha: repo.planningBaseSha,
							reconfirmed: bases[repo.alias],
							runsIntegration: plan.finalIntegration?.runFrom === repo.alias,
							opened: !!repo.pr,
						});
						// As GitHub says it now, not as it was at filing: a repository made private since is checked out by no one.
						if (plan.finalIntegration?.runFrom !== repo.alias && hidden)
							found.push(
								`${label}: the combined run checks out the other repositories without a token, so ${label} must be public.`,
							);
						return found;
					},
				)),
			);
		} catch (error) {
			problems.push(`${label}: ${error instanceof GithubProblem ? error.message : describeError(error)}`);
		}
	}
	if (problems.length) throw new PlanError("Approval needs every repository ready first. " + problems.join(" "));
}

type PreviewSlot = "push" | "target";
type Preview = { head: string; value: number };
export const FEATURE_CI_CACHE =
	"CREATE TABLE IF NOT EXISTS feature_ci_preview(slot TEXT PRIMARY KEY, inputs TEXT NOT NULL, expires INTEGER NOT NULL, head TEXT, value INTEGER)";

/** One durable minute per observation, including concurrent views and interrupted lookups. */
async function previewFeatureCi(
	c: Ctx,
	slot: PreviewSlot,
	key: string,
	read: () => Promise<Preview>,
): Promise<Preview> {
	const unavailable = () =>
		new PlanError(
			"The platform could not verify this repository’s push CI. Refresh the item in a minute to check again.",
		);
	const cache = (c.vars.featureCi ??= {});
	const pending = cache[slot];
	if (pending) {
		if (pending.key !== key) throw unavailable();
		return pending.reading;
	}
	const reading = (async () => {
		const now = Date.now();
		const reserved = await c.db.execute(
			"INSERT INTO feature_ci_preview(slot, inputs, expires) VALUES(?, ?, ?) ON CONFLICT(slot) DO UPDATE SET inputs=excluded.inputs, expires=excluded.expires, head=NULL, value=NULL WHERE expires <= ? OR (slot='target' AND inputs <> excluded.inputs) RETURNING slot",
			slot,
			key,
			now + 60_000,
			now,
		);
		if (!reserved.length) {
			const [cached] = await c.db.execute<{ inputs: string; head: string | null; value: number | null }>(
				"SELECT inputs, head, value FROM feature_ci_preview WHERE slot=?",
				slot,
			);
			if (cached?.inputs !== key || !cached.head || cached.value === null) throw unavailable();
			return { head: cached.head, value: cached.value };
		}
		const result = await read();
		await c.db.execute(
			"UPDATE feature_ci_preview SET head=?, value=?, expires=? WHERE slot=? AND inputs=?",
			result.head,
			result.value,
			Date.now() + 60_000,
			slot,
			key,
		);
		return result;
	})();
	cache[slot] = { key, reading };
	try {
		return await reading;
	} finally {
		delete cache[slot];
	}
}

type TargetStatus = Preview & { branch: string; available: boolean };

async function targetStatus(c: Ctx, stored: Stored): Promise<TargetStatus | null> {
	const { item, meta } = stored;
	if (item.parent) return itemActor(c, meta.uid, item.parent.itemId).internalFeatureTarget();
	if (item.mode !== "orchestrate" || crossRepo(item) || !item.pr || !item.head || ENDED.has(item.state)) return null;
	const branch = item.task.base;
	const snapshot = await previewFeatureCi(c, "target", JSON.stringify([branch, item.head]), async () => {
		const hub = await appHost(c, meta);
		const comparison = await hub.app.withToken(
			hub.installationId,
			{ repositoryId: meta.repository.id, permissions: { metadata: "read", contents: "read" } },
			token => compareBranches(hub.app, token, hub.owner, hub.name, branch, featureBranch(item.id)),
			{ reuse: true },
		);
		return { head: comparison.base, value: comparison.behind };
	}).catch(() => null);
	return (
		snapshot && { ...snapshot, branch, available: canUpdateFeature(item) && item.question?.kind !== "feature_update" }
	);
}

async function checkFeatureCi(c: Ctx, stored: Stored, bases: Readonly<Record<string, string>> = {}, preview = false) {
	if (crossRepo(stored.item)) return checkCrossRepo(c, stored, bases);
	const { item, meta } = stored;
	if (!(await userActor(c, meta.uid).internalHasChecks(meta.repository.id)))
		throw new PlanError(
			item.replans
				? "Add saved repository checks before approving the revised plan."
				: "Use a single item or add saved repository checks before approving orchestration.",
		);
	const branches = await planCiBranches(c, stored);
	const ref = item.pr ? featureBranch(item.id) : meta.repository.branch;
	const read = async () => {
		const hub = await appHost(c, meta, "write");
		return hub.app.withToken(
			hub.installationId,
			{
				repositoryId: meta.repository.id,
				permissions: {
					metadata: "read",
					contents: "read",
					actions: "read",
					checks: "read",
					statuses: "read",
					pull_requests: "read",
				},
			},
			async token => {
				const head = await refHead(hub.app, token, hub.owner, hub.name, ref);
				return { head, value: Number(await hasPushCiAt(hub.app, token, hub.owner, hub.name, head, branches)) };
			},
			{ reuse: true },
		);
	};
	const { value: eligible } = preview
		? await previewFeatureCi(c, "push", JSON.stringify([ref, branches]), read)
		: await read();
	if (!eligible)
		throw new PlanError(
			`This repository’s CI does not report on pushes to the ${branches.length === 1 ? "feature branch" : "feature and child branches"}. ${item.replans ? "Add" : "Run as a single item or add"} windlass/** to the workflow’s push branches.`,
		);
}

function repositoryDirectory(c: Ctx, meta: ItemMeta) {
	return c.client().githubRepository.getOrCreate([String(meta.repository.id)], { params: serviceParams() });
}

async function updateDirectory(
	c: Ctx,
	meta: ItemMeta,
	effect: Extract<Effect, { kind: "register" | "forget" }>,
): Promise<boolean> {
	const item = c.vars.stored?.item;
	if (effect.kind === "register" && effect.repo && item && crossRepo(item)) {
		const repo = repoOf(item, effect.repo);
		const directory = c.client().githubRepository.getOrCreate([String(repo.repositoryId)], { params: serviceParams() });
		return queued(c, async () => {
			const durable = await load(c.db);
			if (!durable || !live(durable.item, effect)) return false;
			await directory.internalRegister({
				uid: meta.uid,
				itemId: durable.item.id,
				installationId: repo.installationId,
				pr: effect.pr,
				head: effect.head,
			});
			return true;
		});
	}
	if (effect.kind === "forget" && item && crossRepo(item)) {
		for (const repo of item.repos!.slice(1))
			await c
				.client()
				.githubRepository.getOrCreate([String(repo.repositoryId)], { params: serviceParams() })
				.internalForget(item.id);
	}
	const directory = repositoryDirectory(c, meta);
	const installation = effect.kind === "register" ? (await appHost(c, meta)).installationId : null;
	// Order directory writes with local decisions, outside any SQLite transaction.
	return queued(c, async () => {
		const durable = await load(c.db);
		if (!durable || !live(durable.item, effect)) return false;
		if (effect.kind === "forget" && meta.github && !ENDED.has(durable.item.state)) return true;
		if (effect.kind === "register" && installation !== null) {
			await c.db.execute("INSERT OR REPLACE INTO github_binding VALUES (1, ?)", String(installation));
			await directory.internalRegister({
				uid: meta.uid,
				itemId: durable.item.id,
				installationId: installation,
				pr: effect.pr,
				head: effect.head,
				moved: durable.item.run?.ci?.moved,
			});
		} else {
			await directory.internalForget(durable.item.id);
			const installed = await binding(c);
			if (durable.item.state === "failed" && durable.item.pr && installed !== null) {
				await directory.internalRegister({
					uid: meta.uid,
					itemId: durable.item.id,
					installationId: installed,
					pr: durable.item.pr.number,
				});
			} else if (!meta.github) await c.db.execute("DELETE FROM github_binding");
		}
		return true;
	});
}

const itemUrl = (id: string) => `${config.origins[0]}/items/${encodeURIComponent(id)}`;

async function storeCheckReceipt(
	tx: Pick<RawAccess, "execute">,
	itemId: string,
	fact: CheckReceipt,
	events: ItemEvent[],
) {
	const e = fact.effect;
	const denied = fact.id === null;
	await tx.execute(
		`INSERT INTO checks VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sha) DO UPDATE SET
		check_run_id=coalesce(excluded.check_run_id,checks.check_run_id), external_id=excluded.external_id,
		state=excluded.state, conclusion=excluded.conclusion, at=excluded.at, said=excluded.said`,
		e.key,
		fact.id,
		e.verdictId ?? `pending:${itemId}:${e.run}`,
		denied ? "not_posted" : e.state,
		denied ? null : e.conclusion,
		e.changedAt,
		denied ? CHECK_DENIED : e.title,
	);
	if (
		denied &&
		!(
			await tx.execute(
				"SELECT 1 FROM events WHERE json_extract(data, '$.step.run') = ? AND json_extract(data, '$.said') = ? LIMIT 1",
				e.run,
				CHECK_DENIED,
			)
		).length
	)
		events.push({ by: "platform", at: fact.at, step: e.step, said: CHECK_DENIED });
}

async function prepareCompletedCheck(
	tx: Pick<RawAccess, "execute">,
	item: FactoryItem,
	effect: Extract<VerifiedCheckEffect, { state: "completed" }>,
	handoff: Handoff,
) {
	let assessment = handoff.review !== null ? (handoff.assessment ?? null) : null;
	// Reviews filed before check runs carried only their filing id on the handoff.
	if (handoff.review && !assessment) {
		const [row] = await tx.execute<{ data: string }>("SELECT data FROM reviews WHERE id=?", handoff.review);
		const filed: ItemReview | null = row ? JSON.parse(row.data) : null;
		if (filed?.recommendation)
			assessment = {
				recommendation: filed.recommendation,
				blocking: filed.blocks.filter(b => b.kind === "finding" && b.severity === "blocking").length,
			};
	}
	const unfinished = handoff.unfinished === true;
	effect.title = checkTitle(handoff.verdict, assessment, unfinished);
	effect.conclusion = checkConclusion(handoff.verdict, assessment, unfinished);
	effect.summary = checkSummary(
		handoff.verdict,
		assessment,
		item.spent,
		item.budget,
		itemUrl(item.id),
		itemAgent(item),
		unfinished,
	);
}

/** Only the token request and the write treat a permission refusal as a finished effect. */
function checkRefused(error: unknown): null {
	if (error instanceof GithubError && (error.status === 403 || error.status === 422)) return null;
	throw error;
}

async function postVerifiedCheck(c: Ctx, meta: ItemMeta, itemId: string, e: VerifiedCheckEffect): Promise<void> {
	const { app, installationId, owner, name } = await appHost(c, meta, "write");
	const issued = await app
		.installationToken(installationId, {
			repositoryId: meta.repository.id,
			permissions: { metadata: "read", checks: "write" },
		})
		.catch(checkRefused);
	let id: string | null = null;
	if (issued) {
		const { token } = issued;
		const [row] = await c.db.execute<{ check_run_id: string | null }>(
			"SELECT check_run_id FROM checks WHERE sha=?",
			e.key,
		);
		const existing = row?.check_run_id ?? (await app.findCheckRun(token, owner, name, e.key, itemId));
		if (!existing && e.existingOnly) return;
		const url = itemUrl(itemId);
		const update: CheckRunUpdate = {
			external_id: e.verdictId ?? `pending:${itemId}:${e.run}`,
			details_url: url,
			started_at: new Date(e.startedAt).toISOString(),
			output: { title: e.title, summary: e.verdictId ? e.summary : e.summary + "\n\n" + evidenceLine(url) },
			...(e.state === "in_progress"
				? { status: e.state }
				: { status: e.state, conclusion: e.conclusion, completed_at: new Date(e.changedAt).toISOString() }),
		};
		id = existing
			? await app
					.updateCheckRun(token, owner, name, existing, update)
					.then(() => existing)
					.catch(checkRefused)
			: await app.createCheckRun(token, owner, name, e.key, update).catch(checkRefused);
	}
	await take(c, { kind: "check_recorded", at: Date.now(), effect: e, id, installationId });
}

type Handoff = Extract<Effect, { kind: "handoff" }>;

async function handoffProblem(c: Ctx, effect: Handoff, said: string): Promise<void> {
	const [, , n, attempt] = effect.key.split(":");
	const event: ItemEvent = {
		at: Date.now(),
		by: "platform",
		step: { run: effect.verdict.run, kind: "handoff", n: Number(n), attempt: Number(attempt) },
		said,
	};
	// A scheduled retry of the same refusal leaves one explanation in the item's log.
	await queued(c, () =>
		c.db.execute(
			"INSERT INTO events (at, data) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM events WHERE json_extract(data, '$.step.run') = ? AND json_extract(data, '$.step.kind') = 'handoff' AND json_extract(data, '$.said') = ?)",
			event.at,
			JSON.stringify(event),
			effect.verdict.run,
			said,
		),
	);
}

/**
 * Posts the item's verdict comment on its pull request, or edits the one posted before. The comment's id
 * is kept on the item when it is first posted or found, and edited by that id afterwards: a pull request
 * with more comments than are listed (ten pages) is never searched again, so it gets no second comment.
 * Without a kept id (posted before ids were kept, or the reply to the post was lost) the platform looks
 * for its marker, and refuses rather than post again when the list is cut short.
 */
type CommentHub = Pick<BoundHost, "host" | "isOwn">;
async function writeMarkedComment(
	c: Ctx,
	hub: CommentHub,
	token: string,
	owner: string,
	name: string,
	pr: number,
	body: string,
) {
	const [kept] = await c.db.execute<{ id: string }>("SELECT id FROM verdict_comment WHERE pr=?", pr);
	if (kept) {
		try {
			await hub.host.updateComment(token, owner, name, kept.id, body);
			return;
		} catch (error) {
			// Deleted on GitHub: ours is gone, so posting it again makes no second one.
			if (!((error instanceof GithubError || error instanceof GitlabError) && error.status === 404)) throw error;
			await c.db.execute("DELETE FROM verdict_comment WHERE pr=? AND id=?", pr, kept.id);
			const id = await hub.host.createComment(token, owner, name, pr, body);
			if (id) await c.db.execute("INSERT OR REPLACE INTO verdict_comment VALUES(?,?)", pr, id);
			return;
		}
	}
	const id = await upsertMarkedComment(hub, token, owner, name, pr, body);
	if (id) await c.db.execute("INSERT OR REPLACE INTO verdict_comment VALUES(?,?)", pr, id);
}

async function upsertMarkedComment(
	hub: CommentHub,
	token: string,
	owner: string,
	name: string,
	pr: number,
	body: string,
) {
	const marker = body.split("\n", 1)[0];
	const { host } = hub;
	const comments = await host.listComments(token, owner, name, pr, true);
	const own = comments.find(c => c.body.split("\n", 1)[0] === marker && hub.isOwn(c));
	if (own && !own.id) throw new Error("GitHub returned an invalid verdict comment id");
	const id = own?.id ?? (await host.createComment(token, owner, name, pr, body));
	if (own?.id) await host.updateComment(token, owner, name, own.id, body);
	return id;
}

async function handoffOnGithub(c: Ctx, meta: ItemMeta, number: number, effect: Handoff, row: EffectRow): Promise<void> {
	const { verdict } = effect;
	let action = "reach the pull request";
	try {
		const hub = await appHost(c, meta);
		const { app, host, installationId, owner, name, login } = hub;
		await app.withToken(
			installationId,
			{ repositoryId: meta.repository.id, permissions: { metadata: "read", pull_requests: "write" } },
			async token => {
				if (!effect.reviewDone) {
					action = "request your review";
					const pull = await host.readPull(token, owner, name, number);
					const rows = await c.db.execute<{ login: string }>(
						"SELECT DISTINCT json_extract(data,'$.author') AS login FROM feedback WHERE state='taken' AND run=? AND json_extract(data,'$.kind')='changes_requested'",
						verdict.run,
					);
					const wanted = [...new Set([login, ...rows.map(r => r.login)])].filter(
						name => !pull.requestedReviewers.some(r => r.toLowerCase() === name.toLowerCase()),
					);
					for (const reviewer of wanted) {
						try {
							await app.requestReviewers(token, owner, name, number, [reviewer]);
						} catch (error) {
							if (!(error instanceof GithubError && error.status === 422)) throw error;
							console.log(`[wlp] factory.review_request_refused item=${verdict.item} status=422`);
							await handoffProblem(c, effect, "GitHub refused the review request (422).");
						}
					}
					// The person may finish their review while a refused comment waits to be retried.
					const done = JSON.stringify({ ...effect, reviewDone: true });
					await queued(c, () =>
						c.db.execute("UPDATE effects SET effect = ? WHERE id = ? AND effect = ?", done, row.id, row.effect),
					);
					row.effect = done;
				}

				action = "post the verdict comment";
				const [reviewRow] = effect.review
					? await c.db.execute<{ data: string }>("SELECT data FROM reviews WHERE id = ?", effect.review)
					: [];
				const body = itemComment(verdict, effect.words, await latestReport(c.db, verdict.run), {
					filed: reviewRow ? (JSON.parse(reviewRow.data) as ItemReview) : null,
					reason: effect.reviewNone,
					unfinished: effect.unfinished,
					owner,
					name,
				});
				await writeMarkedComment(c, hub, token, owner, name, number, body);
			},
		);
	} catch (error) {
		const status = error instanceof GithubError && error.status ? ` (GitHub ${error.status})` : "";
		await handoffProblem(c, effect, `Could not ${action}${status}. The platform will try again.`);
		throw error;
	}
}

function itemNetwork(meta: Pick<ItemMeta, "blockedSessions">) {
	return unionNetwork(...Object.values(meta.blockedSessions ?? {}).map(receipt => receipt.network));
}

/**
 * The item's lifetime hosted seconds after the ledger's latest entries for its session: each hold
 * counted once, whenever it is seen, and kept after the ledger has let it go. Decided synchronously on
 * the stored meta, which the next write of the item stores.
 */
function sessionsOf(meta: ItemMeta): string[] {
	return [meta.sessionId, meta.reviewerSessionId, meta.criticSessionId].filter((id): id is string => !!id);
}

const childSeconds = (item: FactoryItem) => (item.jobs ?? []).reduce((sum, j) => sum + j.spent.hostedSeconds, 0);

function lifetimeSeconds(meta: ItemMeta, facts: ItemFacts): number {
	const seen = new Set(meta.ledger.holds);
	const fresh = facts.entries.filter(entry => !seen.has(entry.hold));
	// Every hold ever counted is kept: an older answer that comes back after a newer one would otherwise drop a hold, which the
	// next answer would count again. An item's life holds few of them (its hosted budget, in holds of minutes).
	let hosted = meta.ledger.hosted;
	for (const entry of fresh) if (entry.hosted) hosted = addHosted(hosted, entry.hosted);
	meta.ledger = {
		seconds: meta.ledger.seconds + ledgerSeconds(fresh, sessionsOf(meta)),
		holds: [...meta.ledger.holds, ...fresh.map(entry => entry.hold)],
		...(hosted && { hosted }),
	};
	return meta.ledger.seconds;
}

/** The user's facts for the item, and the item's hosted time taken in when it has grown: settled after a turn, it would otherwise be missed. */
async function factsOf(c: Ctx, meta: ItemMeta): Promise<ItemFacts> {
	const facts = await userActor(c, meta.uid).internalItemFacts(sessionsOf(meta));
	const stored = c.vars.stored;
	if (stored?.item.place.kind === "hosted") {
		const seconds = lifetimeSeconds(stored.meta, facts) + childSeconds(stored.item);
		const { hosted } = stored.meta.ledger;
		if (seconds > stored.item.spent.hostedSeconds)
			await take(c, { kind: "spent", at: Date.now(), hostedSeconds: seconds, ...(hosted && { hosted }) });
	}
	return facts;
}

/** States in which an item asks nothing more of anyone: what was stored for its steps is not done. */
const ENDED: ReadonlySet<FactoryItem["state"]> = new Set(["done", "cancelled", "failed"]);

/**
 * Whether an effect is still wanted by the item as it is: of its current step's current attempt, with
 * the item not ended. Decided in the transaction that moves the item on (the rows it leaves behind go)
 * and again in the step that sends an effect, since a row read before a cancel may be performed after
 * it. A withdrawal is always wanted: it is what a cancel leaves.
 */
export function live(item: FactoryItem, effect: Effect): boolean {
	if (effect.kind === "poll_branch") return watchesBranch(item, effect.repo);
	if (effect.kind === "discard_placement") return item.state === "cancelled";
	if (effect.kind === "resolve_default_place")
		return !!item.awaitingPlace && item.state === "waiting" && item.wait?.retryAt === effect.at;
	if (effect.kind === "requested_review") return !ENDED.has(item.state) && item.requestedReview?.key === effect.key;
	if (effect.kind === "post_requested_review") return !ENDED.has(item.state);
	if (effect.kind === "feedback_ready" || effect.kind === "feedback_ack") return true;
	if (effect.kind === "feedback_comment")
		return item.run?.n === effect.run && item.state !== "review" && !ENDED.has(item.state);
	if (effect.kind === "merge_feature_target")
		return item.featureUpdate?.key === effect.key && item.joining?.child === item.id && item.joining.key === effect.key;
	if (effect.kind === "notify_integrated")
		return item.state === "done" && (item.integratedHead ?? item.head) === effect.head;
	if (effect.kind === "cancel_children" || effect.kind === "verified_check") return true;
	if (effect.kind === "linear_write" && ["start", "review_opened", "review_handover"].includes(effect.key))
		return !ENDED.has(item.state);
	if (
		effect.kind === "review_comment" ||
		effect.kind === "issue_comment" ||
		effect.kind === "linear_write" ||
		effect.kind === "jira_comment" ||
		effect.kind === "slack_write"
	)
		return true;
	if (effect.kind === "check_issue" || effect.kind === "register_issue") return !ENDED.has(item.state);
	if (effect.kind === "forget") return ENDED.has(item.state) || !item.run?.ci;
	if (effect.kind === "register" && effect.repo) {
		const repo = item.repos?.find(r => r.alias === effect.repo);
		return !ENDED.has(item.state) && repo?.pr?.number === effect.pr && (!repo.featureCi || repo.head === effect.head);
	}
	if (effect.kind === "register")
		return !ENDED.has(item.state) && item.head === effect.head && item.pr?.number === effect.pr;
	// The managed PR sections say where the feature stands while it runs; an ended feature writes no more.
	if (effect.kind === "link_prs") return crossRepo(item) && item.state !== "draft" && !ENDED.has(item.state);
	if (effect.kind === "release_review" || effect.kind === "withdraw" || effect.kind === "ask") return true;
	const run = item.run;
	if (item.question?.kind === "machine_removed" || ENDED.has(item.state) || run === null) return false;
	const key = currentKey(item);
	if (item.featureUpdate && ["dispatch", "poll_ci"].includes(effect.kind)) return false;
	switch (effect.kind) {
		case "auto_merge":
			return (
				item.state === "review" &&
				run.ci?.autoMergeKey === effect.key &&
				item.head === effect.head &&
				item.pr?.number === effect.pr
			);
		case "update_parent_feature":
			return effect.key === key && run.step.kind === "ci" && !!item.parent && !item.question;
		case "sandbox_retry":
			return (
				effect.key === key &&
				item.wait?.reason === "capacity" &&
				item.wait.retryAt === effect.at &&
				!item.question &&
				run.step.turn === null
			);
		case "provider_retry":
			return effect.key === key && item.wait?.reason === "provider" && !item.question;
		case "fresh_sandbox":
			return effect.key === key && !item.question && run.step.turn === null;
		case "describe_feature":
			return effect.key === key && run.step.kind === "publish" && !item.question;
		case "integration":
		case "poll_integration":
			return (
				effect.key === key &&
				run.step.kind === "integration" &&
				!item.question &&
				item.integration?.attempt === effect.attempt
			);
		case "ready_pr":
			return effect.run === run.n && run.step.kind === "merged" && item.pr?.number === effect.pr && !item.question;
		case "poll_repo_pr":
			return (
				effect.key === `${key}/${effect.repo}` &&
				run.step.kind === "merged" &&
				item.state === "review" &&
				!item.question
			);
		case "integrate":
			return effect.key === key && run.step.kind === "subtasks" && !item.question;
		case "dispatch": {
			if (item.question || run.step.kind !== "subtasks") return false;
			const job = effect.child && item.jobs?.find(j => j.id === effect.child);
			return job
				? activeJob(job) && !job.placementRefusal && job.dispatchKey === effect.key
				: !effect.child && effect.key === key;
		}
		case "deliver":
			return effect.key === key && run.step.turn === "delivered";
		case "check_turn":
			return effect.turn === key && run.step.turn !== null;
		case "publish":
			return effect.key === key && run.step.kind === "publish" && item.question?.kind !== "turn_refused";
		case "rerun_ci":
			if (item.question || (run.step.kind !== "subtasks" && run.step.kind !== "ci")) return false;
		// Reruns belong to the same feature head and repository as their poll.
		// falls through
		case "poll_ci":
			if (run.step.kind === "subtasks") {
				const branch = featureCiBranch(item, effect.repo);
				return watchingParts(item) && branch.featureCi?.key === effect.key && branch.head === effect.head;
			}
			return (
				effect.key === key &&
				(run.step.kind === "ci" || run.step.kind === "handoff") &&
				(item.pr !== null || !!item.parent || !!run.takingPush) &&
				item.question?.kind !== "branch_push"
			);
		case "poll_pr":
			return effect.key === prPollKey(item) && effect.pr === item.pr?.number;
		case "handoff":
			return item.pr !== null && (run.n === effect.verdict.run || (run.n === effect.continuedIn && !run.ci?.handed));
	}
}

/** Merge into the first delivery's window. A delivery during the read needs a subsequent window. */
async function queueIssueCheck(c: Ctx, input: IssueNotice) {
	await queued(c, async () => {
		if (!c.vars.stored || ENDED.has(c.vars.stored.item.state)) return;
		const id = "check_issue:pending";
		const [row] = await c.db.execute<EffectRow>("SELECT * FROM effects WHERE id=?", id);
		const old: IssueCheck | undefined = row && JSON.parse(row.effect);
		const now = Date.now();
		const reading = c.vars.performing.has(id);
		let at = old && !(reading && old.at <= now) ? old.at : now + ISSUE_CHANGE_WINDOW_MS;
		if (!reading && input.action === "closed" && input.senderId === c.vars.stored.meta.github!.senderId) {
			// Withdraw a running turn promptly when the filer closes. Respect the same read budget.
			const [item] = await c.db.execute<{ issue_checked_at: number }>("SELECT issue_checked_at FROM item WHERE id=1");
			at = Math.min(at, Math.max(now, item.issue_checked_at + ISSUE_CHANGE_WINDOW_MS));
		}
		const next: IssueCheck = { kind: "check_issue", key: "pending", ...old, at };
		if (input.action === "edited") next.edited = true;
		else if (!next.closedBy?.includes(input.senderId)) next.closedBy = [...(next.closedBy ?? []), input.senderId];
		const data = JSON.stringify(next);
		if (row?.effect !== data) {
			await c.db.execute(
				"INSERT OR REPLACE INTO effects (id, effect, due_at, attempts) VALUES (?, ?, ?, ?)",
				id,
				data,
				row?.attempts ? Math.max(at, row.due_at) : at,
				row?.attempts ?? 0,
			);
		}
		await armDueInQueue(c);
	});
}

async function checkIssue(c: Ctx, meta: ItemMeta, changes: IssueChanges) {
	const binding = meta.github!;
	const connection = await userActor(c, meta.uid).internalGithubConnection();
	if (!connection?.installations.some(i => i.id === binding.installationId)) return;
	const observations = await observeIssue(binding, meta.repository.id, changes, by =>
		repositoryDirectory(c, meta).internalIssuePermission(binding.installationId, by),
	);
	for (const seen of observations) {
		if ((await c.db.execute("SELECT 1 FROM issue_actions WHERE subject=?", seen.subject)).length) continue;
		const state = c.vars.stored!.item.state;
		if (
			ENDED.has(state) ||
			(state === "review" && (seen.cancel === "before_review" || seen.subject === "stranger-close"))
		)
			continue;
		const cancel = seen.cancel === "draft" ? state === "draft" : seen.cancel === "before_review";
		await take(c, cancel ? { kind: "cancel", at: Date.now(), by: seen.by } : { kind: "issue_note", at: Date.now() }, {
			issue: seen,
		});
	}
}

export function rescheduleChildPoll(db: Pick<RawAccess, "execute">, row: EffectRow, now: number) {
	return db.execute(
		"UPDATE effects SET due_at = ?, attempts = attempts + 1 WHERE id = ? AND effect = ?",
		retryAt(now, row.attempts + 1),
		row.id,
		row.effect,
	);
}

function repositoryDenied(error: unknown): error is GithubProblem {
	return error instanceof GithubProblem && (error.code === "github_denied" || error.code === "github_gone");
}

function featureRefusal(error: unknown): error is GithubProblem | GithubError {
	return repositoryDenied(error) || (error instanceof GithubError && [403, 404, 409, 422].includes(error.status));
}

// Rate limits and outages must stay on the retry queue.
export function lostAccess(error: unknown): boolean {
	if (error instanceof GithubProblem) return repositoryDenied(error);
	return (
		error instanceof GithubError &&
		!error.rateLimited &&
		!error.unreachable &&
		[401, 403, 404, 410, 422].includes(error.status)
	);
}

/**
 * Writes the managed section on each of a cross-repo feature's PRs, keeping what anyone else wrote there.
 * A PR the platform cannot write to any more is left as it is: the section is a courtesy, never retried for ever.
 */
async function linkPrs(c: Ctx, meta: ItemMeta, item: FactoryItem): Promise<void> {
	for (const repo of item.repos ?? []) {
		if (!repo.pr) continue;
		const pr = repo.pr.number;
		try {
			await tokenStep(
				await appHost(c, meta, "write", repo),
				{ pull_requests: "write" },
				async ({ host, token, owner, name }) => {
					const latest = c.vars.stored?.item ?? item;
					const pull = await host.readPull(token, owner, name, pr);
					const body = withSection(pull.body, linkSection(latest, repo.alias));
					if (body !== pull.body) await host.updatePull(token, owner, name, pr, { title: pull.title, body });
				},
			);
		} catch (error) {
			if (!lostAccess(error)) throw error;
			console.log(
				`[wlp] factory.cross_repo.link_dropped item=${item.id} repo=${repo.alias} said=${JSON.stringify(describeError(error))}`,
			);
		}
	}
}

/** Opens a cross-repo feature one repository at a time (a seed, then a draft PR), or writes both PR descriptions after its summary. */
async function crossOpenOrDescribe(
	c: Ctx,
	meta: ItemMeta,
	item: FactoryItem,
	effect: Extract<Effect, { kind: "dispatch" | "describe_feature" }>,
): Promise<void> {
	const key = effect.key;
	const opening = effect.kind === "dispatch" ? nextOpening(item) : null;
	try {
		if (opening) {
			const { repo } = opening;
			await tokenStep(
				await appHost(c, meta, "write", repo),
				{ contents: "write", pull_requests: "write" },
				async ({ app, token, owner, name, author }) => {
					if (!live(c.vars.stored!.item, effect)) return;
					if (opening.step === "seed") {
						// The commit the planner read, or reconfirmed at approval: the feature starts where it was planned.
						const sha = repo.planningBaseSha ?? (await refHead(app, token, owner, name, repo.baseRef));
						await take(c, { kind: "feature_seed", key, sha, repo: repo.alias, at: Date.now() });
						return;
					}
					const waitForCiOnEachPart = await waitsForPartCi(c, meta, repo.repositoryId);
					const opened = await openFeature(app, token, owner, name, {
						id: item.id,
						title: item.task.title,
						base: repo.baseRef,
						seed: repo.seed!,
						author,
						created: meta.createdAt,
						body: networkBody(
							withSection(item.featurePlan!.spec.goal, linkSection(item, repo.alias)),
							itemNetwork(meta),
							false,
						),
						draftOnly: true,
					});
					await take(c, {
						kind: "feature_ready",
						key,
						...opened,
						waitForCiOnEachPart,
						repo: repo.alias,
						at: Date.now(),
					});
				},
			);
			return;
		}
		const report = await latestReport(c.db, item.run!.n);
		const text = [
			report?.title,
			...(report?.blocks.map(b => ("text" in b ? b.text : "")) ?? []),
			meta.github && issueReference(item.repos![0], meta.github.origin.issue.number),
		]
			.filter(Boolean)
			.join("\n\n");
		for (const repo of item.repos!) {
			const pr = repo.pr!.number;
			await tokenStep(
				await appHost(c, meta, "write", repo),
				{ pull_requests: "write" },
				({ host, token, owner, name }) =>
					host.updatePull(token, owner, name, pr, {
						title: item.task.title,
						body: networkBody(withSection(text, linkSection(item, repo.alias)), itemNetwork(meta), false),
					}),
			);
		}
		await take(c, {
			kind: "published",
			key,
			at: Date.now(),
			pr: item.pr,
			head: item.head!,
			openItems: 1,
			webhooks: githubConfig().pollFallback,
		});
	} catch (error) {
		if (!featureRefusal(error)) throw error;
		const where = opening ? `${opening.repo.owner}/${opening.repo.name}: ` : "";
		await take(c, { kind: "feature_problem", key, at: Date.now(), reason: where + error.message });
	}
}

/** Starts a cross-repo feature's combined run, or reads it. A refusal by GitHub (no workflow, no permission) is a run that could not run. */
async function integrationStep(
	c: Ctx,
	meta: ItemMeta,
	item: FactoryItem,
	effect: Extract<Effect, { kind: "integration" | "poll_integration" }>,
): Promise<void> {
	const plan = item.approvedPlan?.finalIntegration;
	const run = item.integration!;
	const base = { at: Date.now(), key: effect.key, attempt: effect.attempt };
	if (!plan)
		return void (await take(c, {
			...base,
			kind: "integration_read",
			state: "unavailable",
			url: null,
			said: "the approved plan has no combined run",
		}));
	const from = repoOf(item, plan.runFrom);
	try {
		if (effect.kind === "integration") {
			// A PR merged or closed already: the set is not what would be tested.
			for (const repo of item.repos!) {
				const state = await tokenStep(
					await appHost(c, meta, "read", repo),
					{ pull_requests: "read" },
					({ host, token, owner, name }) => host.readPull(token, owner, name, repo.pr!.number).then(p => p.state),
				);
				if (state === "merged" || state === "closed")
					return void (await take(c, {
						...base,
						kind: "integration_read",
						state: "unavailable",
						url: null,
						said: `${repo.owner}/${repo.name}#${repo.pr!.number} was ${state} before the repositories were tested together`,
					}));
			}
			// The workflow GitHub runs is the one at the dispatched commit: it is checked there, every time.
			const refused = await tokenStep(
				await appHost(c, meta, "read", from),
				{ actions: "read", contents: "read" },
				({ app, token, owner, name }) =>
					integrationWorkflowProblem(app, token, owner, name, effect.heads[plan.runFrom]),
			);
			if (refused)
				return void (await take(c, {
					...base,
					kind: "integration_read",
					state: "unavailable",
					url: null,
					said: refused,
				}));
			const heads = Object.fromEntries(
				item
					.repos!.filter(r => plan.inputs.includes(r.alias))
					.map(r => [r.alias, { repository: `${r.owner}/${r.name}`, sha: effect.heads[r.alias] }]),
			);
			const started = await tokenStep(
				await appHost(c, meta, "write", from),
				{ actions: "write" },
				({ app, token, owner, name }) =>
					dispatchIntegration(app, token, owner, name, {
						ref: featureBranch(item.id),
						item: item.id,
						attempt: effect.attempt,
						heads,
						runFrom: plan.runFrom,
						command: plan.command,
						timeoutSeconds: plan.timeoutSeconds,
					}),
			);
			await take(c, { ...base, kind: "integration_started", runId: started?.runId ?? null, url: started?.url ?? null });
			return;
		}
		// The run is the platform's only on the head of `runFrom` it was dispatched on.
		const runHead = run.heads?.[plan.runFrom] ?? "";
		const reading = await tokenStep(
			await appHost(c, meta, "read", from),
			{ actions: "read" },
			({ app, token, owner, name }) =>
				run.runId
					? readIntegrationRun(app, token, owner, name, run.runId, runHead)
					: findIntegrationRun(app, token, owner, name, featureBranch(item.id), item.id, effect.attempt, runHead),
		);
		if (!reading) {
			const lost = run.dispatchedAt !== null && Date.now() - run.dispatchedAt > 10 * 60_000;
			await take(c, {
				...base,
				kind: "integration_read",
				state: lost ? "unavailable" : "queued",
				url: null,
				said: lost ? "GitHub lists no run of the integration workflow for this attempt" : null,
			});
		} else if (!run.runId)
			await take(c, { ...base, kind: "integration_started", runId: reading.runId, url: reading.url });
		else
			await take(c, {
				...base,
				kind: "integration_read",
				state: reading.state,
				url: reading.url,
				said: reading.said,
				...(reading.seconds !== undefined && { seconds: reading.seconds }),
			});
	} catch (error) {
		if (!repositoryDenied(error) && !(error instanceof ForeignRun) && !refusedByGithub(error)) throw error;
		await take(c, { ...base, kind: "integration_read", state: "unavailable", url: null, said: error.message });
	}
}

/** A note from the person, into the builder's running turn: false when no builder turn runs to take it, and it waits for the next. */
async function steerNote(c: Ctx, stored: Stored, note: string): Promise<boolean> {
	const step = stored.item.run?.step;
	if (
		stored.item.state !== "working" ||
		step?.turn !== "started" ||
		step.kind === "review" ||
		step.kind === "plan_review"
	)
		return false;
	return await sessionActor(c, stored.meta.uid, stored.meta.sessionId)
		.internalOwnerNote({ itemId: stored.item.id, text: personAdds(note) })
		.catch((error: unknown) => {
			if (isSessionGone(error)) return false;
			throw error;
		});
}

async function dispatchFeature(
	c: Ctx,
	{ item, meta }: Stored,
	effect: Extract<Effect, { kind: "dispatch" | "describe_feature" }>,
	row: EffectRow,
): Promise<boolean | "deferred"> {
	const key = effect.key;
	const job =
		effect.kind === "dispatch" && effect.child ? item.jobs?.find(j => j.id === effect.child) : item.jobs?.at(-1);
	if (crossRepo(item) && (effect.kind === "describe_feature" || nextOpening(item))) {
		await crossOpenOrDescribe(c, meta, item, effect);
		return true;
	}
	if (effect.kind === "dispatch" && item.pr && job) {
		if (!job.placement && job.state === "draft" && !job.cancelRequested) {
			await take(c, {
				kind: "place_child",
				child: job.id,
				key,
				inventory: await placementInventory(
					c,
					meta.uid,
					item.agent?.model,
					crossRepo(item) ? undefined : meta.repository.id,
				),
				at: Date.now(),
			});
			return true;
		}
		const v = await userActor(c, meta.uid).internalFeatureChild({ parent: item.id, child: job.id });
		const changed =
			v &&
			(await take(c, {
				kind: "child_update",
				key,
				child: v.id,
				state: v.state,
				startedAt: v.run?.startedAt,
				wait: v.wait?.sentence,
				placement: v.placement,
				head: v.head,
				spent: v.spent,
				budget: v.budget,
				failure: v.run?.failureFingerprint,
				report: JSON.stringify({
					title: v.report?.title,
					blocks: v.report?.blocks,
					verdict: v.verdict,
					stop: v.run?.stopReason,
					question: v.question?.text,
				}).slice(0, 5000),
				at: Date.now(),
			}));
		if (!changed && live(c.vars.stored!.item, effect)) {
			// The child notice replaces this keyed effect immediately. An unchanged observation only moves its fallback timer.
			await queued(c, () => rescheduleChildPoll(c.db, row, Date.now()));
			return "deferred";
		}
		return true;
	}
	try {
		const hub = await appHost(c, meta, "write");
		await hub.app.withToken(
			hub.installationId,
			{
				repositoryId: meta.repository.id,
				permissions: { contents: "write", metadata: "read", pull_requests: "write" },
			},
			async token => {
				if (!live(c.vars.stored!.item, effect)) return;
				const { app, host, owner, name } = hub;
				if (effect.kind === "describe_feature") {
					const report = await latestReport(c.db, item.run!.n);
					const body = [
						report?.title,
						...(report?.blocks.map(b => ("text" in b ? b.text : "")) ?? []),
						meta.github && "Closes #" + meta.github.origin.issue.number + ".",
					]
						.filter(Boolean)
						.join("\n\n");
					await host.updatePull(token, owner, name, item.pr!.number, {
						title: item.task.title,
						body: networkBody(body, itemNetwork(meta), hub.repository.private),
					});
					await take(c, {
						kind: "published",
						key,
						at: Date.now(),
						pr: item.pr,
						head: item.head!,
						openItems: 1,
						webhooks: githubConfig().pollFallback,
					});
				} else if (!item.seed) {
					const sha = await refHead(app, token, owner, name, meta.repository.branch);
					await take(c, { kind: "feature_seed", key, sha, at: Date.now() });
				} else {
					const waitForCiOnEachPart = await waitsForPartCi(c, meta);
					const opened = await openFeature(app, token, owner, name, {
						id: item.id,
						title: item.task.title,
						base: meta.repository.branch,
						seed: item.seed,
						author: hub.author,
						created: meta.createdAt,
						body: networkBody(item.featurePlan!.spec.goal, itemNetwork(meta), hub.repository.private),
					});
					await take(c, { kind: "feature_ready", key, ...opened, waitForCiOnEachPart, at: Date.now() });
				}
			},
		);
	} catch (error) {
		if (!featureRefusal(error)) throw error;
		await take(c, { kind: "feature_problem", key, at: Date.now(), reason: error.message });
	}
	return true;
}

function itemBranch(item: FactoryItem, meta: ItemMeta) {
	if (item.parent) return subtaskBranch(item.parent.itemId, item.parent.key, item.id);
	return item.mode === "orchestrate" ? featureBranch(item.id) : branchFor(item.task.title, meta.sessionId);
}

// CI and review already observe branch moves. Cover the gaps, including a push while a builder works.
function watchesBranch(item: FactoryItem, repo?: string) {
	if (
		!item.run ||
		(item.state !== "working" && item.state !== "waiting") ||
		item.machineRemoved ||
		item.run.ci?.handed ||
		item.run.takingPush ||
		item.awaitingPlace ||
		item.feedback?.awaiting
	)
		return false;
	if (item.mode === "orchestrate" && (!item.approvedPlan || !featureCiBranch(item, repo).pr)) return false;
	if (item.question) return !item.question.push || item.question.repo === repo;
	return (
		!prPollKey(item) &&
		!(item.parent && item.run.step.kind === "subtasks") &&
		!["ci", "handoff", "publish"].includes(item.run.step.kind) &&
		!(watchingParts(item) && featureCiBranch(item, repo).featureCi?.key)
	);
}

function scheduleBranchPolls(effects: Effect[], before: FactoryItem, next: FactoryItem, at: number) {
	for (const repo of next.repos?.map(r => r.alias) ?? [undefined]) {
		if (watchesBranch(next, repo) && !watchesBranch(before, repo))
			effects.push({ kind: "poll_branch", key: repo ?? next.id, repo, at: at + CI_POLLING.everyMs });
	}
}

async function observePush(
	c: Ctx,
	item: FactoryItem,
	hub: AppHost,
	branch: string,
	head: string,
	repo?: string,
	standalone = false,
) {
	const previous = featureCiBranch(item, repo).head ?? null;
	const key = currentKey(item);
	if (
		!key ||
		(item.state !== "working" && item.state !== "waiting") ||
		!/^[a-f0-9]{40}$/.test(head) ||
		head === (item.question?.push?.head ?? previous) ||
		item.run?.takingPush ||
		item.run?.ci?.handed
	)
		return false;
	const push = await hub.app
		.withToken(
			hub.installationId,
			{ repositoryId: hub.repository.id, permissions: { metadata: "read", contents: "read" } },
			async token => {
				const read = await hub.app.branchPush(token, hub.owner, hub.name, branch, head);
				if (read === "platform") return read;
				if (!read) return;
				const owner = read.pusher.id === hub.connectedUserId;
				if (!owner && (await hub.app.issuePermission(hub.installationId, hub.repository.id, read.pusher)) !== "write")
					return;
				return {
					author: cleanFeedback(read.author).slice(0, 120),
					message: redact(cleanFeedback(read.message)).split("\n", 1)[0].slice(0, 500),
					pusher: read.pusher.login,
					own: owner && read.authorId === hub.connectedUserId && !!previous && read.parent === previous,
				};
			},
			{ reuse: true },
		)
		.catch(() => undefined);
	if (push === "platform" || (!push && (!standalone || !(previous || item.question?.push)))) return false;
	// A replay must finish a join that may already have moved the feature ref.
	if (
		item.parent &&
		item.run?.step.kind === "subtasks" &&
		(await itemActor(c, c.key[0]!, item.parent.itemId).internalJoinStarted(item.id, key))
	)
		return false;
	return take(c, { kind: "branch_push", at: Date.now(), key, previous, head, push, repo });
}

async function readBranchPush(c: Ctx, item: FactoryItem, meta: ItemMeta, repo?: string) {
	if (!hostCaps(meta.repository.provider).pushEvents) return false;
	const hub = await appHost(c, meta, "read", repo ? repoOf(item, repo) : undefined);
	const branch = itemBranch(item, meta);
	const head = await hub.app
		.withToken(
			hub.installationId,
			{ repositoryId: hub.repository.id, permissions: { metadata: "read", contents: "read" } },
			token => refHead(hub.app, token, hub.owner, hub.name, branch),
			{ reuse: true },
		)
		.catch(() => null);
	return !!head && observePush(c, item, hub, branch, head, repo, true);
}

async function pollCi(
	c: Ctx,
	stored: Stored,
	effect: Extract<Effect, { kind: "poll_ci" }>,
	row: EffectRow,
	session: ReturnType<typeof sessionActor>,
) {
	const { item, meta } = stored;
	const repo = effect.repo ? repoOf(item, effect.repo) : undefined;
	const branch = repo ?? item;
	const number = branch.pr?.number ?? 0;
	const settings =
		item.run?.step.kind === "handoff" &&
		item.mode !== "orchestrate" &&
		!item.parent &&
		(await repositoryAutonomy(c, meta));
	const autoMergeSingles =
		!!settings && !!settings.autoMergeSingles && mergeKindAllowed(settings.mergeKinds, meta.taskKind);
	if (meta.repository.provider === "gitlab") {
		const snapshot = await hostOf(c, meta)
			.then(hub => gitlabCi(gitlabOf(hub), effect.head, number, item.task.base, autoMergeSingles))
			.catch(() => ({
				reading: { kind: "failed" as const, said: "GitLab CI could not be read." },
				mergeable: null,
				prHead: null,
				baseSha: null,
			}));
		const { baseSha, ...result } = snapshot;
		const openItems = item.run?.step.kind === "handoff" ? 0 : (await factsOf(c, meta)).openItems;
		await take(
			c,
			{
				kind: "ci_read",
				at: Date.now(),
				key: effect.key,
				head: effect.head,
				...result,
				autoMergeSingles,
				openItems,
				webhooks: true,
			},
			{ baseSha, nudged: row.due_at < effect.at },
		);
		return true;
	}
	const read = async () => {
		const hub = await appHost(c, meta, "read", repo);
		// Some push receipts hold a branch name. Encode it as one path segment.
		const target = {
			installationId: hub.installationId,
			repositoryId: hub.repository.id,
			owner: hub.owner,
			name: hub.name,
			head: encodeURIComponent(effect.head),
		};
		const ci = item.run?.ci;
		const reading = await hub.host.readCi(target, {
			since: branch.featureCi?.since ?? ci?.since,
			branch: branch.featureCi ? featureBranch(item.id) : undefined,
		});
		// GitHub can still be computing mergeability, or the PR may have moved past the pushed head.
		const pull = !number || item.parent ? null : await hub.pull(number).catch(() => null);
		const featureHead =
			branch.featureCi && pull?.headSha && pull.headSha !== effect.head && !item.joining
				? await hub.app.withToken(
						hub.installationId,
						{ repositoryId: target.repositoryId, permissions: { metadata: "read", contents: "read" } },
						token => refHead(hub.app, token, hub.owner, hub.name, featureBranch(item.id)),
						{ reuse: true },
					)
				: undefined;
		const partBranch = !number || item.parent ? itemBranch(item, meta) : null;
		const liveHead = partBranch
			? await hub.app
					.withToken(
						hub.installationId,
						{ repositoryId: target.repositoryId, permissions: { metadata: "read", contents: "read" } },
						token => refHead(hub.app, token, hub.owner, hub.name, partBranch),
						{ reuse: true },
					)
					.catch(() => null)
			: pull?.headSha;
		if (
			liveHead &&
			(!pull || pull.state === "open" || pull.state === "draft") &&
			(await observePush(c, item, hub, partBranch ?? pull!.head, featureHead ?? liveHead, effect.repo))
		)
			return null;
		const state = ciState(reading);
		const elapsed = ci ? Date.now() - ci.since : 0;
		const timedOut = workflowOverdue(reading, Date.now());
		const noChildCi =
			item.parent &&
			(state === "not_permitted" ||
				state === "incomplete" ||
				((state === "none" || state === "skipped") && elapsed >= CI_POLLING.noneAfterMs));
		const head = reading.kind === "read" && !/^[0-9a-f]{40}$/.test(effect.head) ? reading.head : effect.head;
		const itemCi =
			item.run?.step.kind === "ci" && item.mode !== "orchestrate" && (!pull?.headSha || pull.headSha === head);
		const mergeCheck =
			autoMergeSingles && pull?.state === "open" && pull.base === item.task.base && pull.headSha === effect.head;
		const progress = branch.featureCi ?? ci;
		const baseRef = repo?.baseRef ?? item.task.base;
		const needsPaths =
			!!branch.featureCi &&
			state === "failed" &&
			pull?.headSha === head &&
			!item.jobs?.some(j => j.ciFix && activeJob(j));
		const compare =
			needsPaths ||
			mergeCheck ||
			!!(item.parent && progress?.waitForBase) ||
			(itemCi && /^[0-9a-f]{40}$/.test(head) && (state === "failed" || state === "cancelled" || timedOut || noChildCi));
		const comparison = compare
			? await hub.app
					.withToken(
						hub.installationId,
						{ repositoryId: target.repositoryId, permissions: { metadata: "read", contents: "read" } },
						token =>
							compareBranches(hub.app, token, hub.owner, hub.name, needsPaths ? branch.seed! : item.task.base, head),
						{ reuse: true },
					)
					.catch(() => null)
			: null;
		// The feature seed is for the diff. The PR's current base SHA is the one whose checks count.
		const prBase = pull?.base === baseRef ? pull.baseSha : undefined;
		const baseTip = needsPaths ? prBase : (comparison?.base ?? prBase);
		let basePassed;
		if (progress?.waitForBase) {
			if (baseTip && baseTip !== progress.waitForBase) {
				const base = await hub.host.readCi({ ...target, head: baseTip });
				basePassed = base.kind === "read" && base.head === baseTip && ciState(base) === "passed";
			}
		} else if ((itemCi || needsPaths) && state === "failed" && reading.kind === "read" && reading.head === head) {
			const willRetry =
				!reading.truncated &&
				(item.parent || pull?.headSha === head) &&
				!item.ciReruns?.[rerunKey(effect)] &&
				rerunnableJobs(reading, false).length > 0;
			if (!willRetry && baseTip)
				await checkBaseFailures(
					hub.app,
					{ ...target, head: baseTip },
					reading,
					branch.featureCi
						? undefined
						: tests => session.internalBaseTests({ head, base: baseTip, tests }).catch(() => "unknown"),
				);
			else if (!baseTip)
				for (const check of reading.runs)
					if (check.state === "failed" && !check.environment) check.baseResult = "pending";
		}
		const paths = needsPaths ? comparison?.files?.map(f => f.filename) : undefined;
		return {
			reading,
			featureHead,
			paths,
			baseAhead: comparison?.behind,
			baseTip: baseTip ?? undefined,
			basePassed,
			baseSha: pull?.base === meta.repository.branch ? pull.baseSha : null,
			mergeable: pull?.mergeable ?? null,
			prHead: liveHead || null,
		};
	};
	const result = await read().catch((error: unknown) => ({
		reading: { kind: "failed" as const, said: describeError(error) },
		featureHead: undefined,
		paths: undefined,
		baseAhead: 0,
		baseTip: undefined,
		basePassed: undefined,
		mergeable: null,
		prHead: null,
		baseSha: null,
	}));
	if (!result) return true;
	const { reading, featureHead, paths, baseAhead, baseTip, basePassed, mergeable, prHead, baseSha } = result;
	const target =
		item.run?.step.kind === "ci" &&
		(item.parent || item.mode === "orchestrate") &&
		(ciState(reading) !== "passed" || mergeable === false)
			? await targetStatus(c, stored).catch(() => null)
			: null;
	const featureTarget = target?.available && target.value > 0 ? target.branch : undefined;
	const openItems = item.run?.step.kind === "handoff" ? 0 : (await factsOf(c, meta)).openItems;
	await take(
		c,
		{
			kind: "ci_read",
			at: Date.now(),
			key: effect.key,
			head: effect.head,
			repo: effect.repo,
			featureHead,
			paths,
			reading,
			basePassed,
			autoMergeSingles,
			baseAhead,
			baseTip,
			featureTarget,
			featureTargetHead: featureTarget ? target?.head : undefined,
			mergeable,
			prHead,
			openItems,
			webhooks: githubConfig().pollFallback,
		},
		{ baseSha, nudged: row.due_at < effect.at },
	);
	return true;
}

// A throw retries the effect. False rechecks the durable item before dropping a stale effect.
async function perform(c: Ctx, row: EffectRow): Promise<boolean | "deferred"> {
	const effect: Effect = JSON.parse(row.effect);
	const stored = c.vars.stored;
	// Checked in the step that sends it: a cancel stored since the row was read leaves it undone.
	if (!stored || !live(stored.item, effect)) return false;
	const { item, meta } = stored;
	if (effect.kind === "slack_write") {
		const { ref, mappingGeneration } = bindingTo(meta, "slack")!;
		const channel = ref.scope ?? "",
			generation = mappingGeneration ?? "";
		const workspace = c.client().slackWorkspace.get([ref.tenant], { params: serviceParams() });
		await performSlackWrite(c.db, { threadTs: ref.id || null }, item.id, effect, {
			read: () => viewOf(c),
			post: (message, thread) =>
				workspace.internalPost(channel, generation, message, thread, { uid: meta.uid, id: item.id }),
			update: (ts, message) => workspace.internalUpdate(channel, generation, ts, message),
		});
		return true;
	}
	if (effect.kind === "jira_comment" || effect.kind === "linear_write") {
		if ((await c.db.execute("SELECT 1 FROM issue_actions WHERE subject=?", row.id)).length) return true;
		// The mapping's owner writes to the issue with their connection, also for an item a teammate filed.
		const params = { params: serviceParams() };
		let posted: boolean;
		if (effect.kind === "jira_comment") {
			const { ref } = bindingTo(meta, "jira")!;
			const projectId = ref.scope ?? "";
			const mapper: string | null = await c.client().jiraSite.get([ref.tenant], params).internalProjectOwner(projectId);
			if (!mapper) return true;
			posted = await userActor(c, mapper).internalJiraWrite({
				siteId: ref.tenant,
				projectId,
				issueId: ref.id,
				itemId: item.id,
				action: effect,
				filedBy: { uid: meta.uid, repositoryId: meta.repository.id },
			});
		} else {
			const { ref } = bindingTo(meta, "linear")!;
			const mapper: string | null = await c
				.client()
				.linearWorkspace.get([ref.tenant], params)
				.internalOwner(ref.scope ?? "");
			if (!mapper) return true;
			posted = await userActor(c, mapper).internalLinearWrite({
				workspaceId: ref.tenant,
				teamId: ref.scope ?? "",
				issueId: ref.id,
				itemId: item.id,
				write: effect,
			});
		}
		if (posted) await c.db.execute("INSERT OR IGNORE INTO issue_actions VALUES(?)", row.id);
		return true;
	}
	const sessionId =
		"to" in effect && effect.to === "critic"
			? meta.criticSessionId
			: "to" in effect && effect.to === "review"
				? meta.reviewerSessionId
				: meta.sessionId;
	if (!sessionId) throw new Error("Review delivery has no reviewer session.");
	const session = sessionActor(c, meta.uid, sessionId);
	// Catch only the session RPC. A failure from GitHub or another actor still belongs to the retry queue.
	const gone = Symbol("deleted session");
	const onGone = async (error: unknown): Promise<typeof gone> => {
		if (!isSessionGone(error)) throw error;
		if (
			(effect.kind === "deliver" ||
				effect.kind === "check_turn" ||
				effect.kind === "fresh_sandbox" ||
				effect.kind === "publish") &&
			c.vars.stored &&
			live(c.vars.stored.item, effect)
		) {
			await take(c, {
				kind: "session_deleted",
				key: effect.kind === "check_turn" ? effect.turn : effect.key,
				at: Date.now(),
			});
		}
		return gone;
	};
	switch (effect.kind) {
		case "discard_placement":
			await userActor(c, meta.uid).internalDiscardPlacement(item.id);
			return true;
		case "resolve_default_place": {
			if (!meta.pendingBuilder) return false;
			const context = item.context ?? meta.pendingBuilder.context;
			const job = { ...meta.pendingBuilder, context: item.useHosted ? contextAtPlace(context, "hosted") : context };
			const result = await userActor(c, meta.uid).internalDefaultBuilder({ id: item.id, job });
			if (!result || !c.vars.stored || !live(c.vars.stored.item, effect)) return false;
			if (!("session" in result))
				await take(c, {
					kind: "default_place_wait",
					at: Date.now(),
					sentence: result.wait,
					reviewer: result.reviewer,
				});
			else {
				const session = result.session;
				await take(c, {
					kind: "default_place_ready",
					at: Date.now(),
					place: session.place,
					reviewer: result.reviewer,
					reviewerSessionId: result.reviewerSessionId,
					agent: newAgent(
						session.harness ?? "windlass",
						session.model,
						resolveRun(job.context, job.role).effort,
						session.item?.signIn,
					),
				});
			}
			return true;
		}
		case "sandbox_retry":
			await take(c, { ...effect, at: Date.now() });
			return true;
		case "provider_retry":
			await take(c, { ...effect, at: Date.now(), loginChanged: row.due_at < effect.at });
			return true;
		case "requested_review":
			await session.internalDeliver(requestedDelivery(item, effect));
			return true;
		case "review_comment": {
			const [filing] = await c.db.execute<{ data: string }>("SELECT data FROM reviews WHERE id=?", effect.key);
			if (!filing) return true;
			const hub = await hostOf(c, meta, "write");
			const review: ItemReview = JSON.parse(filing.data);
			const screenshots = effect.parts
				? await Promise.all(
						effect.parts.map(async part => {
							const sets = await itemActor(c, meta.uid, part.id).internalScreenshotSets();
							return {
								label: part.label,
								count: sets.reduce((n, set) => n + (set.at <= review.at ? set.screenshots.length : 0), 0),
							};
						}),
					)
				: [];
			if (!effect.parts) {
				const report = await latestReport(c.db, review.run, review.at);
				const reviews = await recentReviews(c.db, review.at);
				screenshots.push({
					label: "",
					count: reviews.reduce((n, r) => n + r.screenshots.length, report?.screenshots.length ?? 0),
				});
			}
			const body = reviewRoundComment(item.id, review, hub, screenshots);
			await hub.withToken({ pull_requests: "write" }, token =>
				upsertMarkedComment(hub, token, hub.owner, hub.name, effect.pr, body),
			);
			return true;
		}
		case "post_requested_review": {
			const { key, head, base, pr, repositoryId, installationId } = effect;
			const [filed] = await c.db.execute<{ data: string }>("SELECT data FROM reviews WHERE id=?", key);
			const review: ItemReview = JSON.parse(filed.data);
			const app = githubApp(),
				connection = await userActor(c, meta.uid).internalGithubConnection();
			if (!app || !connection) throw new Error("The GitHub connection is unavailable.");
			let said = `Requested review of PR #${pr} at ${head.slice(0, 7)}`;
			try {
				const { repository } = await resolveBoundRepository(app, connection, repositoryId, installationId, "write");
				await app.withToken(
					installationId,
					{ repositoryId, permissions: { metadata: "read", contents: "read", pull_requests: "write" } },
					token =>
						app.postRequestedReview(
							token,
							repository,
							pr,
							base,
							head,
							key,
							requestedReviewBody(item.id, review, repository),
						),
				);
				said += " posted on GitHub.";
			} catch (error) {
				if (!refusedByGithub(error)) throw error;
				said += ` filed on the item. GitHub refused the review (HTTP ${error.status}).`;
			}
			await queued(c, () =>
				c.db.transaction(async tx => {
					await tx.execute("DELETE FROM effects WHERE id=?", row.id);
					const at = Date.now();
					await tx.execute(
						"INSERT INTO events(at,data) VALUES(?,?)",
						at,
						JSON.stringify({ at, step: null, by: "platform", said }),
					);
				}),
			);
			await take(c, { kind: "issue_note", at: Date.now() });
			return true;
		}
		case "feedback_ready":
			await feedbackReady(c);
			return "deferred";
		case "feedback_ack": {
			await (await hostOf(c, meta)).acknowledge(effect.key);
			return true;
		}
		case "feedback_comment": {
			const update = c.vars.handoff.then(async () => {
				if (!live(c.vars.stored!.item, effect)) return;
				const hub = await hostOf(c, meta);
				const write = async (token: string) => {
					const marker = `<!-- windlass-item:${item.id} -->`;
					const [prev] = await c.db.execute<{ data: string }>(
						"SELECT data FROM verdicts WHERE run < ? ORDER BY at DESC,rowid DESC LIMIT 1",
						effect.run,
					);
					let body = marker + "\n\n" + feedbackComment(effect.who);
					if (prev) {
						const verdict: Verdict = JSON.parse(prev.data);
						const [filed] = await c.db.execute<{ data: string }>(
							"SELECT data FROM reviews WHERE run=? AND head=? AND json_extract(data,'$.requestedPull') IS NULL ORDER BY at DESC LIMIT 1",
							verdict.run,
							verdict.head,
						);
						body = itemComment(
							verdict,
							verdictWords(verdict, null),
							await latestReport(c.db, verdict.run),
							{
								filed: filed ? JSON.parse(filed.data) : null,
								reason: null,
								owner: hub.owner,
								name: hub.name,
								gitlabUrl: hub.webUrl,
							},
							effect,
						);
					}
					await writeMarkedComment(c, hub, token, hub.owner, hub.name, item.pr!.number, body);
				};
				await hub.withToken({ pull_requests: "write" }, write);
			});
			c.vars.handoff = update.catch(() => {});
			await update;
			return true;
		}
		case "verified_check":
			if (hostCaps(meta.repository.provider).verdict !== "check-run") return true;
			// A handoff or cancellation can replace a pending row after the due scan.
			if (!(await c.db.execute("SELECT 1 FROM effects WHERE id=? AND effect=?", row.id, row.effect)).length)
				return true;
			await postVerifiedCheck(c, meta, item.id, effect);
			return true;
		case "notify_integrated":
			await itemActor(c, meta.uid, item.parent!.itemId).internalChildNotice({
				id: item.id,
				spent: item.spent,
				budget: item.budget,
				state: "done",
				integratedHead: effect.head,
			});
			return true;
		case "cancel_children":
			for (const child of effect.ids) {
				const view = await userActor(c, meta.uid).internalFeatureChild({ parent: item.id, child, cancel: true });
				const active = c.vars.stored?.item,
					job = active?.jobs?.find(j => j.id === child);
				if (
					(!view || ENDED.has(view.state)) &&
					active &&
					job &&
					(ENDED.has(active.state) || active.question?.kind === "machine_removed")
				) {
					await take(c, {
						kind: "child_notice",
						child,
						state: view?.state ?? "cancelled",
						spent: view?.spent ?? job.spent,
						at: Date.now(),
					});
				} else if (!view && active && job?.cancelRequested && job.state === "draft") {
					// A placement wait has no child actor to report cancellation.
					await take(c, {
						kind: "child_update",
						key: job.dispatchKey ?? currentKey(active)!,
						child,
						state: "cancelled",
						spent: job.spent,
						head: null,
						report: "Cancelled before launch.",
						at: Date.now(),
					});
				}
			}
			return true;
		case "link_prs":
			await linkPrs(c, meta, item);
			return true;
		case "integration":
		case "poll_integration":
			await integrationStep(c, meta, item, effect);
			return true;
		case "poll_repo_pr": {
			const repo = repoOf(item, effect.repo);
			// The normalized pull omits the merge commit and timestamp needed for this receipt.
			let pull: Awaited<ReturnType<GithubApp["call"]>>;
			try {
				pull = await tokenStep(
					await appHost(c, meta, "read", repo),
					{ pull_requests: "read" },
					({ app, token, owner, name }) =>
						app.call({
							path: `/repos/${owner}/${name}/pulls/${effect.pr}`,
							auth: { bearer: token },
							what: "read the feature pull request",
						}),
				);
			} catch (error) {
				// Denied, gone or archived: polling again changes nothing, so the person is asked.
				if (!lostAccess(error)) throw error;
				await take(c, {
					kind: "repo_pr_lost",
					at: Date.now(),
					key: effect.key,
					repo: effect.repo,
					said: error instanceof GithubProblem ? error.message : describeError(error),
				});
				return true;
			}
			const body = (pull.body ?? {}) as Record<string, unknown>;
			const merged = body.merged === true;
			const state = merged ? "merged" : body.state === "closed" ? "closed" : body.draft === true ? "draft" : "open";
			const head = ((body.head ?? {}) as Record<string, unknown>).sha;
			const changed = await take(c, {
				kind: "repo_pr_read",
				at: Date.now(),
				key: effect.key,
				repo: effect.repo,
				state,
				prHead: typeof head === "string" ? head : null,
				mergedCommit: merged && typeof body.merge_commit_sha === "string" ? body.merge_commit_sha : null,
				mergedAt:
					merged && typeof body.merged_at === "string" && Number.isFinite(Date.parse(body.merged_at))
						? Date.parse(body.merged_at)
						: null,
			});
			if (!changed && live(c.vars.stored!.item, effect)) {
				await queued(c, () => rescheduleChildPoll(c.db, row, Date.now()));
				return "deferred";
			}
			return true;
		}
		case "update_parent_feature": {
			const parent = itemActor(c, meta.uid, item.parent!.itemId);
			if ((await parent.internalUpdateForChild(item.id, effect.key, effect.target, effect.automatic)) === "pending") {
				await queued(c, () => rescheduleChildPoll(c.db, row, Date.now()));
				return "deferred";
			}
			await take(c, { kind: "parent_update_finished", key: effect.key, at: Date.now() });
			return true;
		}
		case "merge_feature_target": {
			let result: Extract<Fact, { kind: "feature_updated" }>["result"];
			try {
				const repo = effect.repo ? repoOf(item, effect.repo) : undefined;
				const hub = await appHost(c, meta, "write", repo);
				const head = await hub.app.withToken(
					hub.installationId,
					{ repositoryId: hub.repository.id, permissions: { metadata: "read", contents: "write" } },
					token =>
						mergeIntoFeature(
							hub.app,
							token,
							hub.owner,
							hub.name,
							item.id,
							effect.target,
							"Update the feature from " + (repo?.baseRef ?? item.task.base),
						),
				);
				result = { head };
			} catch (error) {
				if (error instanceof GithubError && error.status === 409) {
					result = { conflicts: error.conflictFiles };
				} else if (lostAccess(error))
					result = { problem: `GitHub refused the feature update. ${describeError(error)}` };
				else throw error;
			}
			await take(c, { kind: "feature_updated", at: Date.now(), key: effect.key, result });
			return true;
		}
		case "integrate": {
			if (await readBranchPush(c, item, meta)) return true;
			const parent = itemActor(c, meta.uid, item.parent!.itemId);
			const claim = await parent.internalClaimJoin(item.id, effect.key);
			if (claim === "busy") {
				await queued(c, () => rescheduleChildPoll(c.db, row, Date.now()));
				return "deferred";
			}
			let result: JoinResult;
			if (claim === "claimed") {
				try {
					const hub = await appHost(c, meta, "write");
					result = await hub.app.withToken(
						hub.installationId,
						{ repositoryId: meta.repository.id, permissions: { contents: "write", metadata: "read" } },
						async token => {
							if (
								item.mergeTarget &&
								(await compareBranches(hub.app, token, hub.owner, hub.name, item.mergeTarget, effect.head)).behind
							)
								return {
									key: effect.key,
									reason: "The conflict resolution did not merge the requested target commit.",
									conflict: false,
									missingTarget: true,
								};
							const head = await advanceFeatureRef(
								hub.app,
								token,
								hub.owner,
								hub.name,
								item.parent!.itemId,
								item.childBase!,
								effect.head,
								item.task.title,
							);
							return { key: effect.key, head };
						},
					);
				} catch (error) {
					if (!lostAccess(error) && !(error instanceof GithubError && error.status === 409)) throw error;
					result = {
						key: effect.key,
						reason: describeError(error),
						conflict: error instanceof GithubError && error.status === 409 && /merge/i.test(error.message),
					};
				}
				await parent.internalFinishJoin(item.id, result);
			} else result = claim;
			if ("head" in result) await take(c, { kind: "integrated", key: effect.key, head: result.head, at: Date.now() });
			else
				await take(c, {
					kind: "feature_problem",
					key: effect.key,
					reason: result.reason,
					rebase: result.conflict,
					missingTarget: result.missingTarget,
					at: Date.now(),
				});
			return true;
		}
		case "dispatch":
		case "describe_feature":
			return dispatchFeature(c, stored, effect, row);
		case "check_issue":
			await c.db.execute("UPDATE item SET issue_checked_at=? WHERE id=1", Date.now());
			await checkIssue(c, meta, effect);
			return true;
		case "issue_comment": {
			const binding = issueBindingOf(bindingTo(meta, "github")!);
			const hub = await appHost(c, meta);
			const [old] = await c.db.execute<{ id: string }>("SELECT id FROM issue_comment");
			const latest = c.vars.stored!.item;
			const id = await writeIssueComment(
				hub.host,
				hub.app.settings.slug,
				hub.repository,
				binding,
				item.id,
				latest.task.title,
				latest.state,
				latest.pr?.number,
				old?.id,
			);
			await c.db.execute("INSERT OR REPLACE INTO issue_comment VALUES(1,?)", id);
			return true;
		}
		case "register_issue":
			return queued(c, async () => {
				if (!live(c.vars.stored!.item, effect)) return false;
				const binding = issueBindingOf(bindingTo(meta, "github")!);
				await repositoryDirectory(c, meta).internalRegister({
					uid: meta.uid,
					itemId: item.id,
					installationId: binding.installationId,
					issue: binding.origin.issue.number,
					generation: binding.generation,
				});
				return true;
			});
		case "register":
		case "forget":
			if (hostCaps(meta.repository.provider).hooks !== "app") return true; // The owner's index wakes these items.
			return updateDirectory(c, meta, effect);
		case "deliver": {
			if (effect.to === "critic") {
				try {
					await userActor(c, meta.uid).internalPlanCritic(meta.sessionId, item.context!);
				} catch (error) {
					await take(c, {
						kind: "review_ended",
						key: effect.key,
						at: Date.now(),
						outcome: "error",
						said: null,
						refused: describeError(error),
						review: null,
						spend: { tokens: 0, hostedSeconds: item.spent.hostedSeconds },
					});
					return true;
				}
				if (!c.vars.stored || !live(c.vars.stored.item, effect)) return false;
				await session
					.internalDeliver({
						key: effect.key,
						itemId: item.id,
						title: item.task.title,
						text: effect.text,
						agent: "critic",
						maxSteps: effect.maxSteps,
						fetchBase: null,
						startsRun: false,
						untrusted: effect.untrusted,
					})
					.catch(onGone);
				return true;
			}
			let checkout: ReviewDelivery | null = null;
			if (effect.to === "review") {
				if (
					!effect.checkout ||
					!effect.reviewerInput ||
					!meta.reviewBase ||
					meta.reviewBase.head !== effect.checkout.head
				) {
					await take(c, {
						kind: "review_ended",
						key: effect.key,
						at: Date.now(),
						outcome: "error",
						refused: "GitHub did not identify the base commit for this review",
						review: null,
						said: null,
						spend: { tokens: 0, hostedSeconds: item.spent.hostedSeconds },
					});
					return true;
				}
				const report = await latestReport(c.db, item.run!.n);
				const prose = (heading: string) => report?.blocks.find(b => b.kind === "text" && b.heading === heading);
				const description = prose("What it did"),
					lookAt = prose("Where to look"),
					risk = report?.blocks.find(b => b.kind === "risk");
				checkout = {
					...effect.reviewerInput,
					baseSha: meta.reviewBase.sha,
					report: report
						? {
								title: report.title,
								description: description?.kind === "text" ? description.text : "",
								lookAt: lookAt?.kind === "text" ? lookAt.text : "",
								concerns: risk?.text ?? "",
								screenshots: report.screenshots.map(s => ({ file: s.id, caption: s.caption })),
							}
						: null,
				};
			}
			let text = effect.text;
			if (effect.feedbackQuote) {
				const { head, start, length } = effect.feedbackQuote;
				const run = item.run!.n;
				const rows = await c.db.execute<{ data: string }>(
					"SELECT data FROM feedback WHERE state='taken' AND run=? ORDER BY at,id",
					run,
				);
				const quote = batchText(
					rows.map(row => JSON.parse(row.data) as FeedbackEntry),
					{ pr: item.pr!.number, run, head },
				);
				text = text.slice(0, start) + quote + text.slice(start + length);
			}
			// A provider retry replays the delivered planner prompt, including its inventory.
			if (effect.agent === "planner" && item.run!.step.attempt === 1) {
				const inventory = await placementInventory(c, meta.uid, item.agent?.model);
				// Each agent's models in short: "sonnet (low/high)". The planner may propose one; the person approves it.
				const listed = (list?: ModelList | null) =>
					list?.models.map(m => (m.efforts.length ? `${m.id} (${m.efforts.join("/")})` : m.id));
				const hostedModels = Object.fromEntries(
					SUBTASK_HARNESSES.map(({ id }) => [
						id,
						hostedCatalog(id, inventory.hostedCredentials ?? [])?.models.map(m => m.id),
					]),
				);
				const places = inventory.machines.map(({ machineId, repositorySecrets, ...description }) => ({
					...description,
					agentModels: Object.fromEntries(
						Object.entries(inventory.models?.machines?.[machineId] ?? {}).map(([id, list]) => [id, listed(list)]),
					),
					limited: inventory.limited
						?.filter(a => limitApplies(a, machineId))
						.map(({ harness, limitedUntil }) => ({ harness, limitedUntil })),
				}));
				const parent = item.place;
				const parentName =
					parent.kind === "hosted" ? "hosted" : inventory.machines.find(m => m.machineId === parent.machineId)?.name;
				const run = resolveRun(item.context!, "part");
				const selected = run.place;
				const defaultPlace: SandboxPlace =
					typeof selected === "object"
						? { kind: "machine", machineId: selected.machine }
						: selected === "hosted"
							? { kind: "hosted" }
							: parent;
				if (await autoApprovePlans(c, stored))
					text +=
						"\nThis repository auto-approves small plans. Ask only questions whose answers change the work and state the obvious defaults in the spec.";
				text += plannerReadiness(await userActor(c, meta.uid).internalReadinessLevel(keyIn(meta)));
				text += "\n" + plannerCapacityText(defaultPlace, inventory.machines, inventory.hostedCapacity);
				// A hosted fallback runs this planner only. Its parts still prefer a compatible machine.
				const prefer =
					typeof selected === "object"
						? inventory.machines.find(m => m.machineId === selected.machine)?.name
						: selected === "hosted"
							? "hosted"
							: parent.kind === "machine"
								? parentName
								: undefined;
				text +=
					"\nOmit place and agent to inherit the owner’s settings. Use place.prefer or agent for a part that requires a different choice. Owner preference (data): " +
					JSON.stringify({
						prefer,
						selection: selected === "any-machine" ? "any compatible machine" : undefined,
						harness: run.agent,
						profile: run.profile,
						model: run.model ?? undefined,
						effort: run.effort ?? undefined,
					});
				text +=
					"\n\nRunners reporting slots can allocate up to four slots within their reported capacity." +
					(inventory.hostedSizes
						? " Hosted sandboxes come in sizes (Small 1 vCPU, 1 GiB; Medium 2 vCPU, 4 GiB, the default; Large 4 vCPU, 8 GiB): name cpus or memoryGiB in a hosted subtask's needs only when it needs more than Medium (a large build or test suite)."
						: "") +
					"\nPlacement inventory (read-only data): " +
					JSON.stringify({
						parent: parentName,
						screenshotsEnabled: inventory.screenshotsEnabled,
						repositoryScreenshots: inventory.repositoryScreenshots,
						hostedCredentials: inventory.hostedCredentials?.map(k => (k.plan ? `${k.provider} plan` : k.provider)),
						hostedModels,
						keyProfiles: inventory.keyProfiles,
						hostedEgress: inventory.hostedEgress,
						hostedProfiles: inventory.hostedProfiles,
						...(inventory.hostedSizes && { hostedSizes: inventory.hostedSizes }),
						windlassModels: listed(inventory.models?.windlass),
						featureModel:
							resolveRun({ ...item.context, item: { ...item.context?.item, harness: "windlass" } }, "part").model ??
							inventory.models?.windlass?.defaultModel,
						machines: places,
					});
				// The budget figures are the planning turn's own text (blueprint.ts `plannerBudgetText`).
			}
			await session
				.internalDeliver({
					key: effect.key,
					itemId: item.id,
					title: item.task.title,
					text,
					checkout,
					agent: effect.agent,
					maxSteps: effect.maxSteps,
					fetchBase: effect.fetchBase,
					startsRun: startsRun(effect.key),
					untrusted: effect.untrusted ?? [],
					...(effect.unsandboxed && { unsandboxed: true }),
					...(effect.fresh && { fresh: effect.fresh }),
					...(effect.asksLeft !== undefined && { asksLeft: effect.asksLeft }),
					...(effect.budget && { budget: effect.budget }),
				})
				.catch(onGone);
			return true;
		}
		case "release_review":
			await session.internalFreeSandbox(effect.run).catch(onGone);
			return true;
		case "fresh_sandbox": {
			// The person chose a new sandbox for a step whose sandbox could not be prepared: the session's is removed, as "Free" does.
			const result = await session.internalFreeSandbox(undefined, effect.hostedSize).catch(onGone);
			if (result === gone) return true;
			if (result.sizeUnavailable) {
				await take(c, {
					kind: "sandbox_resize_refused",
					key: effect.key,
					at: Date.now(),
					plan: effect.plan,
					size: result.sizeUnavailable,
				});
				return true;
			}
			await take(c, {
				kind: "sandbox_freed",
				key: effect.key,
				at: Date.now(),
				plan: effect.plan,
				hostedSize: effect.hostedSize,
			});
			return true;
		}
		case "withdraw":
			await session.internalWithdraw(effect.key).catch(onGone);
			return true;
		case "check_turn": {
			const fact = await session.internalCheckTurn({ turn: effect.turn, check: effect.key }).catch(onGone);
			if (fact === gone) return true;
			// No receipt yet (including a started turn draining its network outbox). Keep the
			// check alive until the session can answer for this delivery.
			if (fact === null) await take(c, { kind: "turn_running", at: Date.now(), key: effect.key });
			else await takeSessionFact(c, stored, fact);
			return true;
		}
		case "publish": {
			// Read before the push: a lookup that fails tries the effect again before anything was pushed, not after a push that went through.
			const { openItems } = await factsOf(c, meta);
			// Asked again after the lookup: a cancel stored while it was answered pushes nothing.
			const now = c.vars.stored;
			if (!now || !live(now.item, effect)) return false;
			const body = meta.github ? `${item.task.body}\n\nCloses #${meta.github.origin.issue.number}.` : item.task.body;
			const gitlab = meta.repository.provider === "gitlab";
			let answer = await session
				.internalPublish({
					key: effect.key,
					title: item.task.title,
					body,
					blockedNetwork: itemNetwork(meta),
					branchOnly: gitlab || !!item.parent,
					updateFromBase: item.run?.updateFromBase,
				})
				.catch(onGone);
			if (answer === gone) return true;
			if (gitlab && !item.parent && answer.kind === "published") {
				if (!c.vars.stored || !live(c.vars.stored.item, effect)) return false;
				const pull = await session
					.internalOpenFromPushed({
						title: item.task.title.slice(0, MAX_PUBLISH_TITLE_CHARS),
						body: networkBody(body, itemNetwork(meta), false).slice(0, MAX_PUBLISH_BODY_CHARS),
						head: answer.head,
					})
					.catch(onGone);
				if (pull === gone) return true;
				answer = { ...answer, pr: { number: pull.number, url: pull.url } };
			}
			if (
				answer.kind === "publish_failed" &&
				!answer.transient &&
				(await readBranchPush(c, item, meta).catch(() => false))
			)
				return true;
			const receipt = { at: Date.now(), key: effect.key };
			await take(
				c,
				answer.kind === "published"
					? {
							...answer,
							...receipt,
							openItems,
							webhooks: meta.repository.provider === "gitlab" || githubConfig().pollFallback,
						}
					: { ...answer, ...receipt },
			);
			return true;
		}
		case "auto_merge": {
			if (meta.repository.provider === "gitlab") {
				let reason: string | null = null;
				try {
					const refused = () => new Error("Automatic merge is not authorized for this merge request.");
					const hub = gitlabOf(await hostOf(c, meta));
					const policy = await repositoryAutonomy(c, meta);
					if (!policy.autoMergeSingles) throw refused();
					// GitLab is read outside the write queue; only the recheck and the merge hold it.
					const merge = await prepareGitlabMerge(
						hub,
						effect.pr,
						effect.head,
						item.task.base,
						effect.baseTip,
						item.id,
						policy.mergeKinds,
					);
					await queued(c, async () => {
						const latest = c.vars.stored!.item,
							review = latest.run?.ci?.secondReview;
						const now = await repositoryAutonomy(c, meta);
						if (
							!live(latest, effect) ||
							!review ||
							!mergeCandidate(latest, review) ||
							!now.autoMergeSingles ||
							JSON.stringify(now.mergeKinds) !== JSON.stringify(policy.mergeKinds)
						)
							throw refused();
						await merge();
					});
				} catch (error) {
					reason = describeError(error);
				}
				await take(c, {
					kind: "auto_merge_result",
					key: effect.key,
					head: effect.head,
					at: Date.now(),
					reason,
					behind: false,
				});
				return true;
			}
			// Give our own completed check a chance to reach branch protection before requesting the merge.
			const posting = await c.db.execute(
				"SELECT 1 FROM effects WHERE id=? AND attempts=0",
				"verified_check:" + effect.head,
			);
			if (posting.length && !row.attempts) {
				await queued(c, () =>
					c.db.execute(
						"UPDATE effects SET due_at=?, attempts=1 WHERE id=? AND effect=?",
						Date.now() + EFFECT_RETRY_FIRST_MS,
						row.id,
						row.effect,
					),
				);
				return "deferred";
			}
			let behind = false;
			let reason: string | null = null;
			try {
				const hub = await appHost(c, meta, "write");
				await reconcileFeedback(c, meta, hub, effect.pr);
				await hub.app.withToken(
					hub.installationId,
					{ repositoryId: meta.repository.id, permissions: { metadata: "read", contents: "write" } },
					async token => {
						const pull = await hub.pull(effect.pr);
						if (pull.mergedByApp && pull.headSha === effect.head && pull.base === item.task.base) return; // Replayed after GitHub accepted the merge.
						if (
							pull.state !== "open" ||
							!pull.mergeable ||
							pull.base !== item.task.base ||
							pull.headSha !== effect.head ||
							!pull.title
						)
							throw new Error("The pull request is no longer open and mergeable at the reviewed head and base.");
						await queued(c, async () => {
							const pending = await c.db.execute(
								"SELECT 1 FROM feedback WHERE state IN ('pending','held','question') LIMIT 1",
							);
							const latest = c.vars.stored!.item,
								review = latest.run?.ci?.secondReview;
							if (pending.length || !live(latest, effect) || !review || !mergeCandidate(latest, review))
								throw new Error("Feedback or a change to this item requires handover.");
							const settings = await userActor(c, meta.uid).internalRepositoryAutonomy(meta.repository.id);
							if (!settings.autoMergeSingles) throw new Error("Automatic merge is off.");
							const target = {
								installationId: hub.installationId,
								repositoryId: meta.repository.id,
								owner: hub.owner,
								name: hub.name,
								head: effect.head,
							};
							behind =
								(await mergeReviewedPull(hub.app, token, target, pull, effect.baseTip, settings.mergeKinds)) ===
								"behind";
							if (behind) reason = "The base branch advanced before merge.";
						});
					},
				);
			} catch (error) {
				reason = describeError(error);
			}
			await take(c, { kind: "auto_merge_result", key: effect.key, head: effect.head, at: Date.now(), reason, behind });
			return true;
		}
		case "rerun_ci": {
			if (!(await take(c, { ...effect, kind: "ci_rerun_started", at: Date.now() }))) return false;
			let result;
			try {
				const hub = await hostOf(c, meta, "write", effect.repo ? repoOf(item, effect.repo) : undefined);
				result = await hub.host.rerunJobs(hub.target(effect.head), effect.jobs);
			} catch (error) {
				result = { accepted: [], said: `Could not request a CI rerun: ${describeError(error)}.` };
			}
			await take(c, { kind: "ci_rerun_result", repo: effect.repo, at: Date.now(), head: effect.head, ...result });
			return true;
		}
		case "poll_ci":
			return pollCi(c, stored, effect, row, session);
		case "poll_branch": {
			await readBranchPush(c, item, meta, effect.repo);
			await queued(c, () =>
				c.db.execute(
					"UPDATE effects SET due_at=? WHERE id=? AND effect=?",
					Date.now() + CI_POLLING.prEveryMs,
					row.id,
					row.effect,
				),
			);
			return "deferred";
		}
		case "poll_pr": {
			// In review, too: the last turn's sandbox time is settled while the person reviews.
			await factsOf(c, meta);
			const hub = await hostOf(c, meta);
			const pull = await hub.pull(effect.pr);
			const ci = item.run?.ci;
			// Only the GitHub App reads outside pushes and reconciles feedback so far: a host whose caps turn these on
			// must have the App behind it (`appOf`) until `observePush` and `reconcileFeedback` move behind the bound host.
			if (
				(pull.state === "open" || pull.state === "draft") &&
				hub.caps.pushEvents &&
				(await observePush(c, item, appOf(hub), pull.head, pull.headSha))
			)
				return true;
			const pushCi =
				ci &&
				item.state === "review" &&
				item.mode !== "orchestrate" &&
				!item.machineRemoved &&
				(pull.state === "open" || pull.state === "draft") &&
				pull.headSha &&
				pull.headSha !== ci.head &&
				(pull.headSha !== ci.moved || (ci.reviewPush?.head === pull.headSha && !ci.reviewPush.asked))
					? await hub.host.readCi(hub.target(pull.headSha))
					: undefined;
			await take(c, {
				kind: "pr_read",
				at: Date.now(),
				key: effect.key,
				pushCi,
				state: pull.state,
				mergedByApp: pull.mergedByApp,
				prHead: pull.headSha || null,
				webhooks: hub.webhooks,
			});
			if ((pull.state === "open" || pull.state === "draft") && item.state === "review" && hub.caps.feedback)
				await reconcileFeedback(c, meta, appOf(hub), effect.pr);
			return true;
		}
		case "handoff": {
			const next = c.vars.handoff.then(async () => {
				const latest = c.vars.stored?.item;
				if (!latest?.pr || !live(latest, effect)) return false;
				let current = effect;
				if (latest.mode === "orchestrate") {
					// Never for a cross-repo feature, whatever path led here: its PRs leave draft only after a review of the set.
					const refused = readyRefusal(latest);
					if (refused) throw new PlanError(refused);
					const n = latest.pr.number;
					const step = await readyStep(effect.readyRefusals ?? 0, () => markFeatureReady(c, meta, latest.id, n));
					if (step.kind === "retry" || step.kind === "ask") {
						const { said, refusals } = step;
						const wait = step.kind === "retry" ? step.wait : undefined;
						current = { ...effect, readyRefusals: refusals };
						c.log.warn({
							msg: "GitHub refused to mark the feature PR ready for review",
							effect: row.id,
							refusals,
							...(wait !== undefined ? { inSeconds: wait / 1000 } : { handedToPerson: true }),
							error: said,
						});
						// Asked before the count is stored: a server stopped in between asks again rather than never.
						if (wait === undefined) await take(c, { kind: "pr_ready_read", at: Date.now(), pr: n, refused: said });
						const data = JSON.stringify(current);
						await queued(c, () =>
							c.db.execute(
								"UPDATE effects SET effect = ?, due_at = ? WHERE id = ? AND effect = ?",
								data,
								wait === undefined ? row.due_at : Date.now() + wait,
								row.id,
								row.effect,
							),
						);
						row.effect = data;
						if (wait !== undefined) {
							await handoffProblem(
								c,
								effect,
								`GitHub refused to mark pull request #${n} ready for review: ${sentence(said)} The platform will try again in ${spellSeconds(wait / 1000)}.`,
							);
							return "deferred" as const;
						}
					}
				}
				if (meta.repository.provider === "gitlab") {
					const hub = await hostOf(c, meta);
					const [filed] = effect.review
						? await c.db.execute<{ data: string }>("SELECT data FROM reviews WHERE id=?", effect.review)
						: [];
					const body = itemComment(effect.verdict, effect.words, await latestReport(c.db, effect.verdict.run), {
						filed: filed ? JSON.parse(filed.data) : null,
						reason: effect.reviewNone,
						unfinished: effect.unfinished,
						owner: hub.owner,
						name: hub.name,
						gitlabUrl: hub.webUrl,
					});
					await hub.withToken({ pull_requests: "write" }, token =>
						writeMarkedComment(c, hub, token, hub.owner, hub.name, latest.pr!.number, body),
					);
					return true;
				}
				await handoffOnGithub(c, meta, latest.pr.number, current, row);
				return true;
			});
			c.vars.handoff = next.then(
				() => undefined,
				() => undefined,
			);
			return next;
		}
		case "ready_pr": {
			const refused = await markFeatureReady(c, meta, item.id, effect.pr);
			await take(c, { kind: "pr_ready_read", at: Date.now(), pr: effect.pr, refused });
			return true;
		}
		case "ask":
			return true;
	}
}

const sentence = (text: string) => text.replace(/\.?$/, ".");

/**
 * The hand-off's ready-for-review step after `refusals` earlier refusals: ready; refused again, tried after the next wait
 * of `READY_RETRY_MS`; or refused once more than there are waits, so the person is asked. Once asked, the hand-off does
 * not try again (`asked`): the person's "Try again" has its own effect.
 */
export async function readyStep(
	refusals: number,
	mark: () => Promise<string | null>,
): Promise<{ kind: "ready" | "asked" } | { kind: "retry" | "ask"; said: string; refusals: number; wait?: number }> {
	if (refusals > READY_RETRY_MS.length) return { kind: "asked" };
	const said = await mark();
	if (said === null) return { kind: "ready" };
	const wait = READY_RETRY_MS[refusals];
	return wait === undefined
		? { kind: "ask", said, refusals: refusals + 1 }
		: { kind: "retry", said, refusals: refusals + 1, wait };
}

/**
 * Marks the draft feature PR ready for review: null once it is (also when the person marked it), GitHub's reason when it
 * refused. An unreachable or rate-limited GitHub throws, for the effect's ordinary retry.
 */
async function markFeatureReady(c: Ctx, meta: ItemMeta, id: string, pr: number): Promise<string | null> {
	const hub = await appHost(c, meta, "write");
	try {
		await hub.withToken(READY_PERMISSIONS, token => readyFeature(hub.app, token, hub.owner, hub.name, pr, id));
		return null;
	} catch (error) {
		const said = readyRefused(error);
		if (said === null) throw error;
		return said;
	}
}

/**
 * GitHub's reason when marking the PR ready failed because GitHub refused it, counted toward the hand-over to the person;
 * null for anything else (unreachable, rate-limited, a fault of the platform's own), left to the effect's ordinary retry.
 */
export function readyRefused(error: unknown): string | null {
	// GitHub's GraphQL rate limit also answers 200 with `errors`.
	if (error instanceof GraphqlRefusal) return error.type === "RATE_LIMITED" ? null : (error.said ?? error.message);
	if (error instanceof GithubError && !error.rateLimited && !error.unreachable)
		return `GitHub answered ${error.status}${error.said ? ` (${error.said})` : ""}`;
	return null;
}

const MAX_RAISE = {
	tokens: 1_000_000_000,
	hostedSeconds: 7 * 86_400,
	usd: 100_000,
} as const;

/** The fact of a person's action, checked; throws a UserError for one that cannot be taken. */
function factOf(action: ItemAction, by: string, at: number): Fact {
	const bad = (message: string) => new UserError(message, { code: "bad_input" });
	const note = (value: unknown, needed: boolean): string | undefined => {
		if (value === undefined || value === null || value === "") {
			if (needed) throw bad("Write a note for the agent.");
			return undefined;
		}
		if (typeof value !== "string" || value.length > MAX_NOTE_CHARS)
			throw bad(`A note is text of at most ${MAX_NOTE_CHARS} characters.`);
		return value;
	};
	// The subtasks whose agent works without asking that the person confirmed on the approval card.
	const agentsOf = (value: unknown): { agents?: string[] } => {
		if (value === undefined || value === null) return {};
		if (!Array.isArray(value) || value.length > 6 || !value.every(key => typeof key === "string" && key.length <= 32))
			throw bad("Confirm the subtasks by their keys.");
		return { agents: value as string[] };
	};
	switch (action?.kind) {
		case "cancel_subtask":
			return { kind: action.kind, key: action.key, by, at };
		case "edit_plan":
			return { kind: action.kind, version: action.version, plan: action.plan, by, at };
		case "approve_plan": {
			const bases = (action as { bases?: unknown }).bases;
			if (
				bases !== undefined &&
				bases !== null &&
				(typeof bases !== "object" ||
					Array.isArray(bases) ||
					Object.entries(bases).length > 2 ||
					!Object.entries(bases).every(
						([alias, sha]) =>
							/^[a-z][a-z0-9-]{0,15}$/.test(alias) && typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha),
					))
			)
				throw bad("Reconfirm a moved base by its repository's alias and full commit.");
			return {
				kind: action.kind,
				version: action.version,
				by,
				at,
				...agentsOf(action.agents),
				...(bases ? { bases: bases as Record<string, string> } : {}),
			};
		}
		case "run_single":
			return { kind: action.kind, by, at };
		case "set_subtask_agent":
			return { kind: action.kind, key: String(action.key), agent: action.agent, by, at };
		case "update_feature":
		case "start":
		case "cancel":
		case "retry":
			return { kind: action.kind, at, by };
		case "send_back":
			return { kind: "send_back", at, by, note: note(action.note, true) as string };
		case "note": {
			// Given to the agent as the person's words: nothing hidden in it may ride along.
			const text = typeof action.note === "string" ? action.note.replace(HIDDEN, "").trim() : action.note;
			return { kind: "note", at, by, note: note(text, true) as string };
		}
		case "answer": {
			if (action.choice === "add_secret") throw bad("Use the dedicated secret action to set the value.");
			if (typeof action.question !== "string" || typeof action.choice !== "string")
				throw bad("Say which question this answers, and which choice.");
			const budget: Record<string, number> = {};
			for (const [name, most] of Object.entries(MAX_RAISE)) {
				const value = (action.budget as Record<string, unknown> | undefined)?.[name];
				if (value === undefined) continue;
				if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > most)
					throw bad(`A budget's ${name} is a number above 0 and at most ${most}.`);
				budget[name] = value;
			}
			// An answer to the agent's question is the note: without words there is nothing to send it.
			// A note that answers the agent goes to it as the person's words: nothing hidden in it may ride along.
			const replyNote =
				action.choice === "reply" && typeof action.note === "string" ? action.note.replace(HIDDEN, "") : action.note;
			const answerNote =
				action.choice === "reply" && typeof replyNote === "string" && replyNote.trim() === "" ? undefined : replyNote;
			if (action.choice === "reply" && answerNote === undefined) throw bad("Write your answer to the agent.");
			return {
				kind: "answer",
				at,
				by,
				question: action.question,
				choice: action.choice,
				note: note(answerNote, false),
				budget,
				...agentsOf(action.agents),
			};
		}
		default:
			throw bad("Say what to do with the item.");
	}
}

/** A Slack button answers only the question it was posted for, with a choice Slack may offer. */
function slackRefusal(item: FactoryItem, fact: Fact, question: string) {
	const open = item.question;
	if (open?.id !== question) throw new UserError("This question is no longer open.", { code: "item_conflict" });
	const choice = fact.kind === "approve_plan" ? "approve" : fact.kind === "answer" ? fact.choice : null;
	if (!choice || !slackMayAnswer(open, choice))
		throw new UserError("Answer this question in Windlass.", { code: "item_conflict" });
	// A button posted before the plan changed: Slack offers no approval while its questions are open.
	if (APPROVALS.has(choice) && item.featurePlan && openPlanQuestions(item.featurePlan).length)
		throw new UserError("Answer the plan’s open questions in Windlass before approving.", { code: "item_conflict" });
}

const CONFLICT: Record<ItemAction["kind"], string> = {
	update_feature: "The feature cannot be updated at this step.",
	cancel_subtask: "This subtask is no longer running.",
	edit_plan: "That plan has changed. Read the latest version.",
	approve_plan: "Review the latest plan and answer its questions first.",
	run_single: "This item cannot switch to single mode.",
	set_subtask_agent: "That subtask has started or the plan changed.",
	start: "Only a draft can be started.",
	cancel: "The item is done or cancelled already.",
	retry: "Only an item that failed can be retried.",
	send_back: "Only an item in review can be sent back.",
	note: "This item has ended, or its plan's parts take the notes.",
	answer: "That question is not open any more, or does not offer that choice.",
};

export const workItem = actor({
	options: { name: "Work item", icon: "list-check", actionTimeout: 60_000 },

	db: db({
		onMigrate: async db => {
			// `due` is the schedule for the earliest effect: kept, so that a woken actor cancels it rather than adding another.
			await db.execute(
				"CREATE TABLE IF NOT EXISTS item (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, data TEXT NOT NULL, due TEXT, issue_checked_at INTEGER NOT NULL DEFAULT 0)",
			);
			await db.execute(
				"CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY, effect TEXT NOT NULL, due_at INTEGER NOT NULL, attempts INTEGER NOT NULL)",
			);
			await db.execute(
				"CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, data TEXT NOT NULL)",
			);
			await db.execute(FEATURE_CI_CACHE);
			await db.execute(CHECKS_TABLE);
			await db.execute(SLACK_RECEIPTS);
			await db.execute(SLACK_QUESTIONS);
			await db.execute(REPORTS_TABLE);
			await db.execute(REVIEWS_TABLE);
			await db.execute(FEEDBACK_TABLE);
			await db.execute("CREATE INDEX IF NOT EXISTS feedback_pending ON feedback(state,after_run,ready)");
			await db.execute("CREATE TABLE IF NOT EXISTS feedback_cursor(id INTEGER PRIMARY KEY, since INTEGER NOT NULL)");
			await db.execute(
				"CREATE TABLE IF NOT EXISTS github_binding (id INTEGER PRIMARY KEY CHECK (id = 1), installation TEXT NOT NULL)",
			);
			await db.execute("CREATE TABLE IF NOT EXISTS issue_actions(subject TEXT PRIMARY KEY)");
			await db.execute(
				"CREATE TABLE IF NOT EXISTS issue_comment(singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL)",
			);
			await db.execute(VERDICT_COMMENT_TABLE);
			const stored = await load(db);
			// An older server could consume a started turn's check while its receipt was pending.
			if (stored?.item.place.kind === "machine" && stored.item.run?.step.turn === "started") {
				const poll = turnCheckEffect(currentKey(stored.item)!, stored.item.run.step, Date.now());
				if (live(stored.item, poll))
					await db.execute(
						"INSERT OR IGNORE INTO effects VALUES (?, ?, ?, 0)",
						rowId(poll),
						JSON.stringify(poll),
						poll.at,
					);
			}
			// Backfill items published before G2 on their next wake.
			if (stored?.item.run?.step.kind === "review" && stored.item.pr && !ENDED.has(stored.item.state)) {
				const poll = nextPrPoll(stored.item, Date.now());
				await db.execute(
					"INSERT OR IGNORE INTO effects VALUES (?, ?, ?, 0)",
					rowId(poll),
					JSON.stringify(poll),
					poll.at,
				);
			}
			if (
				stored?.meta.repository.provider !== "gitlab" &&
				stored?.item.pr &&
				stored.item.head &&
				!ENDED.has(stored.item.state) &&
				!(await db.execute("SELECT 1 FROM github_binding")).length
			) {
				const effect: Effect = {
					kind: "register",
					key: `existing:${stored.item.revision}`,
					pr: stored.item.pr.number,
					head: stored.item.head,
				};
				await db.execute(
					"INSERT OR IGNORE INTO effects SELECT ?, ?, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM effects WHERE id LIKE 'register:%')",
					rowId(effect),
					JSON.stringify(effect),
				);
			}
			await db.execute(
				"CREATE TABLE IF NOT EXISTS verdicts (id TEXT PRIMARY KEY, run INTEGER NOT NULL, head TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)",
			);
		},
	}),

	// Only `user` creates an item. An actor made any other way stays without a row and removes itself on wake.
	onCreate: async (c, input: ItemCreateInput | undefined) => {
		try {
			if (!input || !grantIsValid(input.grant, c.key, "workItem") || input.item?.id !== c.key[1]) return;
			let item = input.item;
			const events: ItemEvent[] = [];
			let effects: Effect[] = [];
			if (input.placeNote && !(input.startedBy && item.awaitingPlace))
				events.push({ at: input.meta.createdAt, by: "platform", step: null, said: input.placeNote });
			if (input.startedBy !== null) {
				const started = advance(item, { kind: "start", at: input.meta.createdAt, by: input.startedBy });
				({ item } = started);
				events.push(...started.events);
				effects = started.effects;
				scheduleBranchPolls(effects, input.item, item, input.meta.createdAt);
			}
			if (input.meta.jira) await activateJiraIssue(c, input.meta.uid, item.id, input.meta.jira);
			// Filing, then starting: a source hears of both, and of nothing else the new item has not done.
			const updates = [...itemUpdates(null, input.item), ...itemUpdates(input.item, item)];
			effects.push(...sourceEffects(input.meta, updates, item, { url: itemUrl(item.id) }));
			await c.db.transaction(
				async tx => {
					if (input.meta.github)
						await tx.execute("INSERT INTO github_binding VALUES(1,?)", String(input.meta.github.installationId));
					await tx.execute(
						"INSERT INTO item (id, revision, data) VALUES (1, ?, ?)",
						item.revision,
						JSON.stringify({ item, meta: input.meta }),
					);
					await tx.execute(
						"INSERT INTO events (at, data) VALUES (?, ?)",
						input.meta.createdAt,
						JSON.stringify({
							at: input.meta.createdAt,
							by: input.startedBy ?? "platform",
							step: null,
							said: filedNote(input.meta),
						} satisfies ItemEvent),
					);
					for (const event of events)
						await tx.execute("INSERT INTO events (at, data) VALUES (?, ?)", event.at, JSON.stringify(event));
					for (const effect of effects)
						await tx.execute(
							"INSERT INTO effects (id, effect, due_at, attempts) VALUES (?, ?, ?, 0)",
							rowId(effect),
							JSON.stringify(effect),
							"at" in effect && effect.at !== undefined ? effect.at : 0,
						);
				},
				{ name: "item.create" },
			);
		} catch (error) {
			c.log.error({ msg: "could not initialise the work item", error: describeError(error) });
		}
	},

	createVars: async (c): Promise<ItemVars> => {
		const [row] = await c.db.execute<{ due: string | null }>("SELECT due FROM item WHERE id = 1");
		return {
			stored: await loadOnWake(c),
			writing: Promise.resolve(),
			performing: new Set(),
			handoff: Promise.resolve(),
			due: row?.due ? (JSON.parse(row.due) as ItemVars["due"]) : null,
			reporting: null,
			reportAgain: false,
		};
	},

	onDestroy: async c => {
		const stored = c.vars.stored;
		if (stored)
			await Promise.all([
				queued(c, () => repositoryDirectory(c, stored.meta).internalForget(stored.item.id)),
				userActor(c, stored.meta.uid).internalDeleteItemAttachments(stored.item.id),
			]);
	},

	onWake: c => {
		if (!c.vars.stored) {
			c.destroy();
			return;
		}
		// A claimed answer resumes with the same sealed input and request id.
		const pending = c.vars.stored.meta.pendingSecret;
		if (pending) void c.keepAwake(saveClaimedSecret(c, pending, true).catch(() => {}));
		// What a deploy cut off is performed again, under the keys it was stored with.
		void c.keepAwake(performDue(c));
	},

	actions: {
		// --- called by `user` only ---------------------------------------------------------------

		internalFeatureTarget: async (c): Promise<TargetStatus | null> => {
			requireServiceFor(c, "call");
			const stored = c.vars.stored;
			return stored && !stored.item.parent ? targetStatus(c, stored) : null;
		},
		internalUpdateForChild: async (
			c,
			child: string,
			request: string,
			target: string,
			automatic?: true,
		): Promise<"pending" | "finished"> => {
			requireServiceFor(c, "call");
			await c.vars.writing;
			const item = c.vars.stored!.item;
			const job = item.jobs?.find(j => j.id === child);
			if (!job || ENDED.has(item.state)) return "finished";
			if (
				item.featureUpdate ||
				item.question?.kind === "feature_update" ||
				item.jobs?.some(j => j.conflictFix?.child === child && activeJob(j))
			)
				return "pending";
			if (job.featureUpdateReceipt === request) return "finished";
			return (await take(c, {
				kind: "update_feature",
				at: Date.now(),
				by: automatic ? "platform" : "person:" + c.key[0],
				child,
				request,
				target,
				automatic,
			}))
				? "pending"
				: "finished";
		},
		internalJoinStarted: async (c, child: string, key: string): Promise<boolean> => {
			requireServiceFor(c, "call");
			await c.vars.writing;
			const item = c.vars.stored!.item;
			return (
				(item.joining?.child === child && item.joining.key === key) ||
				item.jobs?.find(job => job.id === child)?.join?.key === key
			);
		},
		// The durable grant survives a restart between GitHub’s ref update and its receipt.
		internalClaimJoin: async (c, child: string, key: string): Promise<"busy" | "claimed" | JoinResult> => {
			requireServiceFor(c, "call");
			await take(c, { kind: "claim_join", at: Date.now(), child, key });
			await c.vars.writing;
			const item = c.vars.stored!.item,
				job = item.jobs?.find(j => j.id === child);
			if (job?.join?.key === key) return job.join;
			if (item.joining?.child === child && item.joining.key === key) return "claimed";
			if (
				job &&
				activeJob(job) &&
				!job.cancelRequested &&
				(item.joining || item.question?.kind === "feature_update" || item.question?.kind === "branch_push")
			)
				return "busy";
			return { key, reason: "The feature stopped before this subtask integrated.", conflict: false };
		},
		internalFinishJoin: async (c, child: string, result: JoinResult) => {
			requireServiceFor(c, "call");
			await take(c, { kind: "finish_join", at: Date.now(), child, result });
		},
		internalChildNotice: async (
			c,
			child: Pick<ItemSummary, "id" | "spent" | "state"> & { budget?: ItemSummary["budget"]; integratedHead?: string },
		) => {
			requireServiceFor(c, "call");
			await take(c, {
				kind: "child_notice",
				at: Date.now(),
				child: child.id,
				spent: child.spent,
				...(child.budget && { budget: child.budget }),
				state: child.state,
				integratedHead: child.integratedHead,
			});
		},
		// The seed belongs to the parent. Looking it up on clone also covers previously created child sessions.
		// A cross-repo feature's child asks for the seed of its own repository (`repositoryId`).
		internalSetupSeed: async (c, source: "child" | "feature", repositoryId?: GithubId): Promise<string | null> => {
			requireServiceFor(c, "call");
			const stored = c.vars.stored;
			if (!stored) throw new Error("The work item is unavailable for setup.");
			if (source === "child") {
				const parent = stored.item.parent;
				return parent
					? itemActor(c, stored.meta.uid, parent.itemId).internalSetupSeed("feature", stored.meta.repository.id)
					: null;
			}
			if (crossRepo(stored.item) && repositoryId !== undefined) {
				const seed = stored.item.repos!.find(r => r.repositoryId === repositoryId)?.seed;
				if (!seed) throw new Error("The feature has no recorded setup commit for that repository.");
				return seed;
			}
			if (!stored.item.seed) throw new Error("The feature has no recorded setup commit.");
			return stored.item.seed;
		},
		/**
		 * The other repositories of a cross-repo feature a planning turn of `key` reads, each at the base
		 * commit the filing recorded: null for any other turn. The session fetches each with a read token of
		 * its own and leaves no credentials behind (agent-session.ts, `materializeInputs`).
		 */
		internalPlanningInputs: (
			c,
			key: string,
		): {
			directory: string;
			inputs: {
				alias: string;
				repositoryId: GithubId;
				installationId: GithubId;
				owner: string;
				name: string;
				baseRef: string;
				sha: string | null;
			}[];
		} | null => {
			requireService(c);
			const item = c.vars.stored?.item;
			if (
				!item ||
				!crossRepo(item) ||
				!["refine", "plan_review"].includes(item.run?.step.kind ?? "") ||
				currentKey(item) !== key
			)
				return null;
			return {
				directory: INPUTS_DIRECTORY,
				inputs: item.repos!.slice(1).map(r => ({
					alias: r.alias,
					repositoryId: r.repositoryId,
					installationId: r.installationId,
					owner: r.owner,
					name: r.name,
					baseRef: r.baseRef,
					sha: r.planningBaseSha,
				})),
			};
		},
		internalChildRequest: (c, id: string) => {
			requireService(c);
			const s = c.vars.stored,
				job = s?.item.jobs?.find(j => j.id === id);
			const paused =
				!!s?.item.featureUpdate ||
				s?.item.question?.kind === "feature_update" ||
				s?.item.question?.kind === "branch_push";
			if (
				!s ||
				!job ||
				job.repairOffer ||
				!activeJob(job) ||
				s.item.run?.step.kind !== "subtasks" ||
				s.item.featurePlan?.status !== "approved" ||
				(s.item.question && !paused) ||
				ENDED.has(s.item.state)
			)
				return null;
			if (
				!job.placement &&
				(job.ciFix || job.conflictFix || job.reviewFix) &&
				job.task.resolved &&
				worksWithoutAsking(job.task.resolved.agent)
			)
				return null;
			const completed = s.item.jobs?.filter(j => j.state === "done") ?? [];
			const previous = completed.at(-1);
			const reports = completed.filter(j => job.task.dependsOn.includes(j.task.key)).map(j => j.report);
			// A cross-repo feature's child is made in its subtask's repository, from that repository's feature branch.
			const repo = crossRepo(s.item) ? repoOf(s.item, job.task.repo) : null;
			return {
				settings: s.item.context!,
				paused,
				job: { ...job, start: repo?.head ?? s.item.head, dispatchKey: job.dispatchKey ?? currentKey(s.item)! },
				sessionId: s.meta.sessionId,
				feature: summaryOf(s),
				repository: repo && { id: repo.repositoryId, base: repo.baseRef, alias: repo.alias },
				joinOnGate: !!(repo ?? s.item).featureCi,
				featureBody: s.item.task.body,
				context: JSON.stringify({
					spec: s.item.featurePlan.spec,
					answers: s.item.featurePlan.questions.map(({ text, answer }) => ({ text, answer })),
					reports,
				}),
				previous: previous && { head: previous.head, report: previous.report, place: previous.placement?.place },
				// The subtask's task was planned from the feature's (its sources go with it), and quotes the reports of subtasks before it.
				untrusted: sources(
					s.item.untrusted,
					job.reviewFix?.reviewedHead ? [untrustedWords.review(job.reviewFix.reviewedHead)] : [],
					job.ciFix && [untrustedWords.ci(job.ciFix.head)],
					reports.length ? [untrustedWords.earlier] : [],
				),
				// What the feature's person chose to run anyway on "Docker, hardened": the subtask's task carries the same text.
				...(s.item.unsandboxed?.length && { unsandboxed: s.item.unsandboxed }),
			};
		},
		internalFilePlan: async (c, input: { key: string; plan: unknown }): Promise<string> => {
			requireService(c);
			try {
				const { item, meta } = c.vars.stored!;
				const inventory = await placementInventory(c, meta.uid, item.agent?.model);
				return (await take(c, { ...input, inventory, kind: "file_plan", at: Date.now() }))
					? "Plan filed. End your turn."
					: "This planning turn ended.";
			} catch (error) {
				return describeError(error);
			}
		},
		internalSummary: async (c): Promise<ItemSummary> => {
			requireService(c);
			// A site probe after retry authorization must see the committed transition.
			if (c.vars.jiraRetry) await c.vars.jiraRetry.catch(() => {});
			if (!c.vars.stored) throw new UserError("That item does not exist.", { code: "item_not_found" });
			return indexedSummary(c, c.vars.stored);
		},

		internalBlockedNetwork: async (c, receipt: NetworkReceipt): Promise<void> => {
			requireService(c);
			const meta = c.vars.stored?.meta;
			if (!meta || !sessionsOf(meta).includes(receipt.sessionId)) return;
			const previous = meta.blockedSessions?.[receipt.sessionId];
			if (previous && previous.revision >= receipt.revision) {
				// A duplicate can arrive while the original write is queued. Acknowledge durable state.
				await queued(c, async () => {
					const saved = (await load(c.db))?.meta.blockedSessions?.[receipt.sessionId];
					if (!saved || saved.revision < receipt.revision) throw new Error("Network receipt was not saved.");
				});
				return;
			}
			(meta.blockedSessions ??= {})[receipt.sessionId] = receipt;
			await take(c, { kind: "network_reported", at: Date.now() });
		},
		internalView: async (c): Promise<ItemView> => {
			requireService(c);
			if (!c.vars.stored) throw new UserError("That item does not exist.", { code: "item_not_found" });
			return await viewOf(c);
		},

		internalScreenshotSets: async (c): Promise<Omit<PartScreenshots, "itemId" | "key" | "title">[]> => {
			requireService(c);
			const filed = [
				...(await c.db.execute<{ data: string }>("SELECT data FROM reports ORDER BY at DESC LIMIT 20")).map(
					row => JSON.parse(row.data) as ItemReport,
				),
				...(await c.db.execute<{ data: string }>("SELECT data FROM reviews ORDER BY at DESC LIMIT 20")).map(row => ({
					...(JSON.parse(row.data) as ItemReview),
					by: "reviewer" as const,
				})),
			];
			return filed
				.filter(one => one.screenshots.length > 0)
				.map(one => ({ by: one.by, head: one.head, at: one.at, screenshots: one.screenshots }))
				.sort((a, b) => b.at - a.at);
		},

		internalSecretRequestLimit: async (c, key: string, name: string): Promise<string | null> => {
			requireServiceFor(c, "call");
			const item = c.vars.stored?.item;
			// The turn can reach the tool before the item's turn_started receipt arrives.
			if (
				!item?.run ||
				currentKey(item) !== key ||
				item.question ||
				item.claimedSecret ||
				!["queued", "working"].includes(item.state) ||
				!item.run.step.turn
			)
				return "This turn can no longer request a secret.";
			const previous = item.run.asks ?? 0;
			const problem = secretRequestLimit(name, previous, item.run.declinedSecrets ?? [], "run");
			if (previous >= MAX_SECRET_REQUESTS) return problem;
			const counted = await take(c, { kind: "secret_attempt", key, previous, at: Date.now() });
			return problem ?? (counted ? null : "This turn can no longer request a secret.");
		},

		internalSetRequestedSecret: async (c, input: RequestedSecretSave): Promise<void> => {
			requireServiceFor(c, "call");
			if (!c.vars.stored) throw new UserError("That item does not exist.", { code: "item_not_found" });
			await saveClaimedSecret(c, input);
		},

		/** A person's action (`UserActions.actOnItem`), by `by` ("person:<uid>"). Refused with `item_conflict` when it changes nothing. */
		internalAct: async (
			c,
			input: { action: ItemAction; by: string; slack?: { user: string; question: string } },
		): Promise<ItemView> => {
			requireService(c);
			const stored = c.vars.stored;
			if (!stored) throw new UserError("That item does not exist.", { code: "item_not_found" });
			if (c.vars.savingSecret) throw new UserError("The secret is being saved.", { code: "item_conflict" });
			const fact = factOf(input?.action, String(input?.by), Date.now());
			if (input.slack) slackRefusal(stored.item, fact, input.slack.question);
			let changed: boolean;
			try {
				if (fact.kind === "update_feature" || (fact.kind === "answer" && fact.choice === "update_feature")) {
					let branch: string | undefined;
					const repo = stored.item.question?.updateRepo
						? repoOf(stored.item, stored.item.question.updateRepo)
						: undefined;
					if (fact.kind === "update_feature" && canUpdateFeature(stored.item)) branch = stored.item.task.base;
					else if (fact.kind === "answer" && stored.item.question?.id === fact.question) {
						if (stored.item.question.kind === "feature_update") branch = repo?.baseRef ?? stored.item.task.base;
						else if (featureCiQuestion(stored.item)) {
							const target = await targetStatus(c, stored);
							if (target?.available && target.value > 0) branch = target.branch;
						}
					}
					if (branch) {
						const hub = await appHost(c, stored.meta, "read", repo);
						fact.target = await hub.app.withToken(
							hub.installationId,
							{ repositoryId: hub.repository.id, permissions: { metadata: "read", contents: "read" } },
							token => refHead(hub.app, token, hub.owner, hub.name, branch),
							{ reuse: true },
						);
					}
				}
				if (
					fact.kind === "answer" &&
					fact.choice === "send_back" &&
					stored.item.question?.id === fact.question &&
					stored.item.question.push
				) {
					if (await readBranchPush(c, stored.item, stored.meta, stored.item.question.repo)) return viewOf(c);
				}
				if (fact.kind === "note") fact.steered = await steerNote(c, stored, fact.note);
				if (fact.kind === "set_subtask_agent" || fact.kind === "edit_plan")
					fact.inventory = await placementInventory(c, stored.meta.uid, stored.item.agent?.model);
				const approving =
					stored.item.featurePlan?.status === "proposed" &&
					(fact.kind === "approve_plan" || (fact.kind === "answer" && fact.choice === "approve"));
				if (approving && (fact.kind === "approve_plan" || fact.kind === "answer")) {
					fact.inventory = await placementInventory(c, stored.meta.uid, stored.item.agent?.model);
					if (advance(stored.item, fact).item.featurePlan?.status === "approved")
						await checkFeatureCi(c, stored, fact.kind === "approve_plan" ? fact.bases : undefined);
				}
				if (fact.kind === "retry" && stored.meta.jira && canRetry(stored.item)) {
					if (c.vars.jiraRetry) throw new UserError("A retry is already in progress.", { code: "item_conflict" });
					c.vars.jiraRetry = activateJiraIssue(c, stored.meta.uid, stored.item.id, stored.meta.jira).then(() =>
						take(c, fact, { slackUser: input.slack?.user }),
					);
					try {
						changed = await c.vars.jiraRetry;
					} finally {
						delete c.vars.jiraRetry;
					}
				} else changed = await take(c, fact, { slackUser: input.slack?.user });
				if (approving && c.vars.stored?.item.featurePlan?.status === "proposed" && changed)
					throw new PlanError("The plan settings changed. Review the new version before approving.");
			} catch (error) {
				if (error instanceof PlanError) throw new UserError(error.message, { code: "bad_input" });
				throw clientError(c.log, error, "The item could not be changed. Try again.");
			}
			if (!changed) throw new UserError(CONFLICT[input.action.kind], { code: "item_conflict" });
			return await viewOf(c);
		},

		internalGithubRetry: async (c, input: { installationId: GithubId; subject: string; by: GithubUser }) => {
			requireServiceFor(c, "call");
			const binding = c.vars.stored?.meta.github;
			if (!binding || binding.installationId !== input.installationId || binding.senderId !== input.by.id) return;
			if ((await c.db.execute("SELECT 1 FROM issue_actions WHERE subject=?", input.subject)).length) return;
			const by = "github:" + input.by.login;
			await take(c, { kind: "retry", at: Date.now(), by }, { issue: { subject: input.subject, by, said: "" } });
		},
		internalGithubIssue: async (c, input: IssueNotice) => {
			requireServiceFor(c, "call");
			const meta = c.vars.stored?.meta,
				binding = meta?.github;
			if (
				!meta ||
				!binding ||
				ENDED.has(c.vars.stored!.item.state) ||
				binding.installationId !== input.installationId ||
				meta.repository.id !== input.repositoryId ||
				binding.origin.issue.number !== input.issue
			)
				return;
			if (input.action === "edited" || input.action === "closed") return queueIssueCheck(c, input);
			await checkIssue(c, meta, input.action === "unlabeled" ? { unlabeledBy: input.senderId } : {});
		},

		internalGithubFeedback: async (c, input: FeedbackNotice) => {
			requireServiceFor(c, "call");
			return receiveFeedback(c, input);
		},

		internalReverify: async (
			c,
			input: { installationId: GithubId; repositoryId: GithubId; head: string },
		): Promise<boolean> => {
			requireServiceFor(c, "call");
			if (
				hostCaps(c.vars.stored?.meta.repository.provider).verdict !== "check-run" ||
				input.repositoryId !== c.vars.stored?.meta.repository.id ||
				input.installationId !== (await binding(c))
			)
				return false;
			return take(c, { kind: "reverify", head: input.head, at: Date.now() });
		},

		internalMachineAvailable: async c => {
			requireServiceFor(c, "call");
			await queued(c, async () => {
				const item = c.vars.stored?.item;
				if (!item?.awaitingPlace || item.question || item.state !== "waiting") return;
				await c.db.execute("UPDATE effects SET due_at=0 WHERE id=?", "resolve_default_place:" + item.wait?.retryAt);
				await armDueInQueue(c);
			});
		},

		internalProviderChanged: async (c, revision: number): Promise<void> => {
			requireServiceFor(c, "call");
			await queued(c, async () => {
				const item = c.vars.stored?.item;
				if (item?.revision !== revision || item.question) return;
				const placement = item.run?.step.kind === "subtasks" && item.state === "waiting";
				if (!placement && item.wait?.reason !== "provider") return;
				// Admission waits belong to the user's queue. A refused turn or unplaced child has its own timer.
				const key = currentKey(item);
				const now = Date.now();
				const rows = placement
					? await c.db.execute(
							"UPDATE effects SET due_at=? WHERE id GLOB 'dispatch:*' AND due_at>? RETURNING id",
							now,
							now,
						)
					: await c.db.execute(
							"UPDATE effects SET due_at=? WHERE id=? AND due_at>? RETURNING id",
							now,
							"provider_retry:" + key,
							now,
						);
				if (rows.length) await armDueInQueue(c);
			});
		},

		internalMergeGitlab: async (c, reviewedHead: string): Promise<ItemView> => {
			requireServiceFor(c, "call");
			const refused = (message: string) => new UserError(message, { code: "gitlab_merge_refused" });
			/** What a merge of the reviewed head needs of the item, or null once it is done. */
			const mergeable = () => {
				const stored = c.vars.stored;
				if (stored?.meta.repository.provider !== "gitlab") throw refused("This item has no GitLab merge request.");
				const { item, meta } = stored;
				if (!reviewedHead || item.head !== reviewedHead)
					throw refused("The head changed. Review the current commit before merging.");
				if (item.state === "done") return null;
				const head = item.head,
					pr = item.pr?.number,
					ci = item.run?.ci,
					base = meta.reviewBase;
				if (
					item.state !== "review" ||
					item.run?.step.kind !== "merged" ||
					item.question ||
					!head ||
					!pr ||
					!ci ||
					ci.head !== head ||
					ci.moved ||
					ci.last?.state !== "passed" ||
					meta.verdict?.result !== "pass" ||
					meta.verdict.ci !== "passed" ||
					!base ||
					base.head !== head
				)
					throw refused("Merge requires a handed-over item with a passing verdict and pipeline for this head.");
				const key = prPollKey(item);
				if (!key) throw refused("The item is not waiting for a merge.");
				return { meta, head, pr, target: item.task.base, base: base.sha, key, itemId: item.id };
			};
			const ready = mergeable();
			if (!ready) return viewOf(c);
			// GitLab is read outside the write queue. A lost response after GitLab accepted the merge is reconciled by reading the MR.
			const hub = gitlabOf(await hostOf(c, ready.meta));
			const matches = (mr: Awaited<ReturnType<typeof hub.pull>>) =>
				mr.state === "merged" && mr.headSha === ready.head && mr.base === ready.target;
			let merge: (() => Promise<void>) | null = null;
			if (!matches(await hub.pull(ready.pr))) {
				try {
					merge = await prepareGitlabMerge(hub, ready.pr, ready.head, ready.target, ready.base, ready.itemId);
				} catch (error) {
					throw refused(describeError(error));
				}
			}
			let failure: unknown = null;
			// Serialize owner clicks, and recheck only what the reads were for before merging.
			const receipt = await queued(c, async () => {
				const now = mergeable();
				if (!now) return null;
				if (now.pr !== ready.pr || now.base !== ready.base || now.key !== ready.key || now.target !== ready.target)
					throw refused("The item changed. Refresh it before merging.");
				if (merge)
					await merge().catch(error => {
						failure = error;
					});
				return { key: now.key, head: now.head };
			});
			if (receipt && !matches(await hub.pull(ready.pr)))
				throw refused(failure ? describeError(failure) : "GitLab has not confirmed a merge at this head and base.");
			if (receipt)
				await take(c, {
					kind: "pr_read",
					key: receipt.key,
					prHead: receipt.head,
					state: "merged",
					at: Date.now(),
					webhooks: true,
				});
			return viewOf(c);
		},

		internalGitlabNudge: async (
			c,
			input: { projectId: string } & ({ kind: "ci"; head: string; pr?: number } | { kind: "pr"; pr: number }),
		): Promise<boolean> => {
			requireServiceFor(c, "call");
			const repositoryId = c.vars.stored?.meta.repository.id;
			if (!repositoryId || String(repositoryId) !== input.projectId) return false;
			return queued(c, () => nudge(c, { ...input, repositoryId, installationId: repositoryId }, "gitlab"));
		},

		internalGithubNudge: async (c, input: GithubNudge): Promise<boolean> => {
			requireServiceFor(c, "call");
			return queued(c, () => nudge(c, input));
		},

		// --- called by the item's session and by `user` -----------------------------------------

		/** A fact about the item's turn, from its session's outbox or from the user's turn queue. Resolves once it is stored. */
		internalFact: async (c, fact: Fact): Promise<void> => {
			requireService(c);
			const stored = c.vars.stored;
			if (!stored || typeof fact?.kind !== "string" || typeof fact.at !== "number") return;
			if (fact.kind === "placement_wait") {
				requireServiceFor(c, "call");
				await take(c, fact);
				return;
			}
			if (
				fact.kind !== "machine_removed" &&
				fact.kind !== "turn_ended" &&
				fact.kind !== "review_ended" &&
				fact.kind !== "turn_started" &&
				fact.kind !== "turn_running" &&
				fact.kind !== "turn_waiting" &&
				fact.kind !== "turn_paused" &&
				fact.kind !== "turn_resumed" &&
				fact.kind !== "machine_away"
			)
				return;
			await takeSessionFact(c, stored, fact);
		},

		// --- called by the actor's own schedule only ------------------------------------------------

		[DUE_ACTION]: async (c): Promise<void> => {
			const fire = c.scheduledFire;
			if (!fire) throw new UserError("This action is internal.", { code: "forbidden" });
			// One line per firing, so that a late or lost schedule shows in the logs.
			console.log(
				`[wlp] schedule.fired action=${DUE_ACTION} item=${c.key[1]} late_ms=${fire.firedAt - fire.scheduledAt}`,
			);
			if (c.vars.due?.id === fire.id) c.vars.due = null;
			await performDue(c);
		},
	},
});
