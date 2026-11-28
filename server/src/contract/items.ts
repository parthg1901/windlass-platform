/** Work items: lists, runs, budgets, questions, verdicts, plans and actions. */

import type { HarnessId, IdempotencyKey, SandboxPlace, SandboxProfileId } from "../contract.js";
import type { GithubId, RepoAddress, SessionRepository } from "./github.js";
import type { HostedSize } from "./hosted-sizes.js";
import type { CredentialSource } from "./machines.js";
import type { CheckStatus, Verified, VerifiedFlag } from "./repository.js";
import type { ItemReport, ItemReview, PartScreenshots, ReviewRecommendation } from "./reviews.js";
import type { SourceId } from "../sources/types.js";

/** How many work items a page holds when it does not say, and at most (`listItems`). */
export const ITEM_PAGE_DEFAULT = 25;
export const ITEM_PAGE_MAX = 100;

/** Where a page of work items starts: after this item, the last of the page before. Both never change. */
export interface ItemCursor {
	createdAt: number;
	id: string;
}

/** Newest first. Omit ended to include open and ended items together. */
export interface ItemListPage {
	before?: ItemCursor | null;
	/** `ITEM_PAGE_DEFAULT` when left out, at most `ITEM_PAGE_MAX`. */
	limit?: number;
	ended?: boolean;
	repository?: RepoAddress | null;
	source?: ItemSource | null;
}

/** How many ended work items the live feed carries (`ItemFeed.ended`): the first page of them. */
export const ITEM_FEED_ENDED = 25;

/** Per repository and filing source. Display names come from its newest filed item. */
export interface ItemCount {
	repository: RepoAddress;
	owner: string;
	name: string;
	source: ItemSource;
	/** Not done, failed or cancelled. */
	open: number;
	done: number;
	failed: number;
	cancelled: number;
}

/** Every open item, recent ended items and counts. Use listItems for older pages. Child items enter the main list when asking a question. */
export interface ItemFeed {
	/** Not done, failed or cancelled; newest filed first. */
	open: ItemSummary[];
	/** At most ITEM_FEED_ENDED ended items, newest filed first: the first page `listItems({ ended: true })` answers. */
	ended: ItemSummary[];
	counts: {
		/** Every ended item, those beyond `ended` among them. */
		ended: number;
		/** One row for each repository and way of filing that has items. */
		byRepository: ItemCount[];
	};
	/** All open subtasks, including ones without questions. */
	children?: ItemSummary[];
}

/** Where an item is. "waiting" always comes with `ItemSummary.wait`. */
export type ItemState = "draft" | "queued" | "working" | "waiting" | "review" | "done" | "failed" | "cancelled";

/** Person and budget waits require an answer. Resource and CI waits can end on their own. */
export type WaitReason =
	| "provider"
	| "children"
	| "capacity"
	| "machine"
	| "ci"
	| "person"
	| "budget"
	| "integration"
	| "sandboxes";

/** A wait as a person reads it: one reason, a sentence with its numbers, and when it is next tried. */
export interface Wait {
	/** The sign-in whose cooldown holds this item, when known. */
	accountKey?: string;
	/**
	 * A connected plan holds it (Pay with): at its limit (`limited`) or at its parallel-turn cap. `keyNow`: a saved key
	 * could pay now (the user actor's `useKeyNow`).
	 */
	plan?: { provider: import("./connect.js").PlanProvider; limited: boolean; keyNow: boolean };
	reason: WaitReason;
	/** "Waiting for one of your 5 factory turns; 5 are running (…)." */
	sentence: string;
	/** When it is tried again, ms since the epoch; null for a wait only a person ends. */
	retryAt: number | null;
}

export interface Waiting extends Wait {
	/** Since when the item waits for this reason. */
	since: number;
}

/** Factory step names are persisted and appear on the item timeline. */
export type StepKind =
	| "plan_review"
	| "subtasks"
	| "integration"
	| "summary"
	| "refine"
	| "implement"
	| "gate"
	| "publish"
	| "ci"
	| "ci_fix"
	| "run_checks"
	| "conflict"
	| "review"
	| "review_fix"
	| "handoff"
	| "merged";

/** The step a run is at. */
export interface ItemStep {
	/** Dense within its run, from 1. */
	n: number;
	kind: StepKind;
	/** From 1: a step tried again (after an interruption, a retried push, every poll of a wait) is a new attempt. */
	attempt: number;
	startedAt: number;
	/** For a turn step: delivered to the session and not started yet, started, or null once it ended. */
	turn: "delivered" | "started" | null;
	/** How many times the session was asked whether the turn still runs. */
	checks: number;
	/** How many times this step's turn was cut off, by a deploy or a restart (at most 3). */
	interruptions: number;
	/** Turns of this step whose sandbox could not be prepared (`sandboxFailed`) since the last that could. */
	sandboxFailures?: number;
	/** Consecutive automatic retries after a provider refusal on this step. */
	providerRetries?: number;
	/** The person was asked in this step about the hosted cap on kept sandboxes (question "sandboxes"): not asked again. */
	capAsked?: true;
	/** The person was asked in this step whether to go on waiting for a machine that stayed away (question "machine_away"): not asked again. */
	awayAsked?: true;
}

/** One run of the blueprint: an item has a new one when it is retried or sent back. */
export interface ItemRun {
	/** Automatic recovery choices taken in this run (zero on older runs). */
	autoSteps?: number;
	n: number;
	startedAt: number;
	endedAt: number | null;
	/** Why it ended other than by handing over: "cancelled", "retried", or the cause of the question given up on. */
	stopReason: string | null;
	step: ItemStep;
	/** Observed rounds, uncapped. Repeated failures, the budget and the turn backstop stop the run. */
	rounds: { plan: number; gate: number; ci: number; conflict: number; review?: number };
}

/** The work as the item was given it. `base` is the branch its pull request goes into. */
export interface ItemTask {
	title: string;
	body: string;
	/** What a person will check, one criterion each; listed in the verdict, not checked by a machine. */
	acceptance: string[];
	base: string;
}

/** Token budgets use cost-weighted input. The time limit applies to hosted sandboxes only. */
/**
 * An item's budget, in the units of what pays for its turns (factory/budget.ts `budgetStop`): dollars where an API key
 * pays (`usd`), percentage points of the plan's windows where a plan pays: its 5-hour window (`planPct`) and its weekly
 * window (`planWeekPct`), each held where the plan reports it. `tokens` (cost-weighted) is the fallback where none can
 * be measured: a turn whose price is unknown, a plan or agent that reports no window.
 * Items filed before the dollar and plan figures were kept have only tokens and hosted time.
 */
export interface ItemBudget {
	tokens: number;
	hostedSeconds: number;
	usd?: number;
	planPct?: number;
	planWeekPct?: number;
}

/** Raw tokens count cached input at full weight; use tokens when rawTokens is absent. Active time excludes waits. */
export interface ItemSpend extends ItemBudget {
	rawTokens?: number;
	turns: number;
	activeSeconds: number;
	/** A plan-paid turn ended without the plan reporting any window: unless another turn saw one, tokens hold. */
	planUnreported?: boolean;
	/** A key-paid turn could not be priced: its dollars are not in `usd`, so the token budget holds too. */
	usdUnknown?: boolean;
	/** What the item's own turns used, by model, payer and sandbox size: what its cost is priced from (factory/cost.ts). */
	usage?: import("./cost.js").SpendUsage;
	/** The part of `usage` spent retrying: turns of a run the person started again, and turns fixing a failed CI. */
	retryUsage?: import("./cost.js").SpendUsage;
}

/** A subtask's budget in a feature's plan: one token figure. At dispatch its token share also determines its share of hosted time. */
export type SubtaskBudget = Pick<ItemBudget, "tokens">;

/** Effective account limits after applying the operator’s overrides to the deployment defaults. */
export interface FactoryLimits {
	dailyTokens: number | null;
	/** Items filed from GitHub issues a day, drafts among them: one guard against a flood of filings. */
	githubItemsPerDay: number;
	attachments: { bytes: number; perItem: number; accountBytes: number; days: number };
	/** The user's hosted sandboxes running at once: factory turns and the person's own hosted agents together. Machines never count. */
	hostedRunning: number;
	/** A new item's budget. */
	item: ItemBudget;
}

/** "turn_refused": the session or provider refused the turn, in its words. "sandboxes": the hosted cap on kept sandboxes stopped a turn. "check_environment": a check failed because the sandbox could not run it (`ItemQuestion.check`). "ready_refused": GitHub kept refusing to mark a planned feature's draft pull request ready for review after its hand-over. */
export type QuestionKind =
	| "branch_push"
	| "run_place"
	| "push_ci"
	| "ready_refused"
	| "feature_update"
	| "sandboxes"
	| "integration"
	| "feedback_feature"
	| "feedback_more"
	| "placement_refused"
	| "single_suggested"
	| "replan_approval"
	| "plan_approval"
	| "rounds"
	| "budget"
	| "no_change"
	| "publish_refused"
	| "ci_timeout"
	| "turn_refused"
	| "machine_removed"
	| "review_question"
	| "agent_ask"
	| "secret_needed"
	| "check_environment"
	| "sandbox_failed"
	| "out_of_memory"
	| "machine_away";

/** Stored response IDs. Retry starts a new run. Again retries the failed step. */
export type ChoiceId =
	| "use_hosted"
	| "use_windlass"
	| "use_claude"
	| "use_opencode"
	| "send_back"
	| "dismiss"
	| "send"
	| "leave"
	| "run_single"
	| "orchestrate_anyway"
	| "approve"
	| "revise"
	| "raise"
	| "retry"
	| "again"
	| "wait"
	| "hand_over"
	| "give_up"
	| "fix"
	| "add_secret"
	| "without_secret"
	| "reply"
	| "run_anyway"
	| "fresh_sandbox"
	| "larger_sandbox"
	| "run_checks"
	| "ci_alone"
	| "update_from_base"
	| "update_feature";

/** Render the reason as quoted plain text, separately from the platform's own notice. */
export interface SecretRequest {
	name: string;
	why: string;
	/** Platform-authored provenance and save destination, one line each. Absent on older requests. */
	notice?: string;
}

export interface SetRequestedSecretInput {
	/** The open item question's id or SessionSnapshot.secretRequest.id, on the requesting session. */
	requestId: string;
	name: string;
	value: string;
}

/** What an item asks its person ("Needs you"). It waits until answered, for days if need be. */
export interface ItemQuestion {
	/** Unique within the item: what `ItemAction` "answer" names. */
	id: string;
	kind: QuestionKind;
	/** Current repository requirement blocking approval of this plan. */
	approvalBlock?: string;
	/** Display-only commit metadata from GitHub. */
	push?: { head: string; author: string; message: string };
	/** Why automatic plan approval needs the owner. Also included in the full question text. */
	criticReason?: string;
	criticFindings?: string[];
	text: string;
	choices: Array<{ id: ChoiceId; label: string }>;
	/** Suggested answer. Older clients and stored questions may omit it. */
	recommended?: ChoiceId;
	askedAt: number;
	secret?: SecretRequest;
	/** Untrusted builder text. Quote as plain text, separate from platform wording, and never post externally. */
	asked?: { text: string; options: string[] };
	/** Show the check's diagnostic and output tail as plain command output. */
	check?: {
		name: string;
		command: string;
		exitCode: number | null;
		kind: "package_manager" | "network" | "not_found";
		line: string;
		excerpt: string;
	};
	/** An `out_of_memory` question's next hosted size: what "Go on in a larger sandbox" makes. */
	largerSize?: HostedSize;
}

/** An entry of an item's log, oldest first: every change of the item, and what caused it. */
export interface ItemEvent {
	/** Why a run ended before its normal handoff. */
	stopReason?: "feedback";
	at: number;
	/** "person:<uid>" or "platform". */
	by: string;
	/** The step it happened in; null outside a run. */
	step: { run: number; n: number; kind: StepKind; attempt: number } | null;
	said: string;
	/** Retained after answering. Keep untrusted agent text separate from the platform's said field. */
	asked?: string;
}

/** A check run or commit status of CI, as the verdict lists it. */
export interface VerdictRun {
	/** A cancellation without evidence of runner starvation or timeout. */
	stopped?: true;
	name: string;
	/** The app that reported it ("github-actions"), or "status" for a commit status. */
	app: string;
	/** GitHub's conclusion, or `not_run` for a failure GitHub attributed to a job it never started. */
	conclusion: string;
	url: string;
}

/** Evidence for this pushed head comes from the recorded gate, change flags and CI. A verdict never merges work. */
export interface Verdict {
	id: string;
	item: string;
	run: number;
	/** The commit it is for. */
	head: string;
	at: number;
	place: "hosted" | "machine";
	attestedBy: "platform" | `machine:${string}`;
	result: "pass" | "fail" | "incomplete" | "unverified";
	gate: {
		state: Verified["state"] | null;
		/** The user's checks in the run the work rests on. */
		required: Array<{ name: string; status: CheckStatus; sentBack: number }>;
		unneeded?: Verified["unneeded"];
	};
	/**
	 * "not_run": GitHub did not start a job (`said` is its reason);
	 * "not_permitted": GitHub would not show the platform this repository's CI (`said` is GitHub's words);
	 * "timed_out": still running when the work was handed over; "unread": the platform could not read it
	 * (GitHub did not answer while it waited), or not all of it (more checks than it reads: `said`
	 * says so), so nothing is claimed of what was not read. "none" only when GitHub was read and
	 * listed no CI at all; "skipped": CI ran and finished, and none of its checks passed (all skipped or neutral). "cancelled" includes stale checks.
	 */
	ci: {
		state:
			| "passed"
			| "failed"
			| "none"
			| "skipped"
			| "cancelled"
			| "not_run"
			| "timed_out"
			| "not_permitted"
			| "unread";
		runs: VerdictRun[];
		said: string | null;
	};
	flags: VerifiedFlag[];
	acceptance: string[];
	mergeable: boolean | null;
	/** A different PR head has no verification from this verdict and cannot pass. */
	moved: string | null;
	/** CI, and each of `flags` (in the same order), in a sentence as the server words them for the item's log and the pull request. */
	said: { ci: string; flags: string[] };
}

/** An item as the user's index lists it. */
/** Which agent an item's builder runs, on which model, and what that agent said it used. */
export interface ItemAgent {
	harness: HarnessId;
	/** The builder session's model: one of the account's for Windlass, the agent's own id ("sonnet") or "default" for a machine harness. */
	model: string;
	/** The effort its turns run at (`CreateItemInput.effort`); null or absent: the agent's default. */
	effort?: string | null;
	/** The sign-in method at filing. Each turn records the method it uses. */
	signIn?: "api-key" | "chatgpt" | "subscription";
	/** Subscription tokens are shown but do not count toward the budget. Unreported tokens are unknown. */
	tokens: "counted" | "subscription" | "not_reported";
	/** Every token the agent reported over the item's turns, counted or not. */
	reportedTokens: number;
	/** Subscription tokens on an item that also has counted turns. */
	subscriptionTokens?: number;
	/** The cost the agent reported for its conversation so far (OpenCode's `usage_update.cost`); null where it reported none. */
	cost: { amount: number; currency: string } | null;
	/** Claude Code's 5-hour window, % used, at the start of the item's first turn and at the end of its latest. */
	fiveHour: { first: number; latest: number } | null;
}

/** How a work item was filed: on the web, through the API, or from a work source (sources/types.ts). */
export type ItemSource = "web" | "api" | SourceId;

/**
 * Who filed an item from another surface (Slack, Linear, Jira), when that is not the owner at the web, the API or
 * GitHub. `verified`: the surface's user is linked to this Windlass user. An item without one is the owner's. Only a
 * verified filer's item may pay with the owner's plan (pay-with.ts `decidePayer`).
 */
export interface ItemFiler {
	surface: string;
	externalUserId: string;
	verified: boolean;
}

/** The PR closes this issue in the item's repository. The sender added the label or wrote the command. */
export interface GithubIssueOrigin {
	jira?: undefined;
	issue: { number: number; url: string; author: string; trusted: boolean };
	sender: string;
	linear?: undefined;
	filer?: ItemFiler;
}

/** Linear provenance is separate from the GitHub PR binding. The event sender and issue author may differ. */
export interface LinearIssueOrigin {
	jira?: undefined;
	/** `trusted`: the issue creator's id matches the user who connected the workspace; whoever added the label does not make another person's text trusted. */
	linear: { id: string; identifier: string; url: string; author: string; trusted: boolean };
	sender: string;
	issue?: undefined;
	filer?: ItemFiler;
}

/** Jira text is always third-party, even when the consenting account wrote it. */
export interface JiraIssueOrigin {
	jira: { id: string; identifier: string; url: string; author: string; trusted: false };
	sender: string;
	issue?: undefined;
	linear?: undefined;
	filer?: ItemFiler;
}

export type ItemOrigin = GithubIssueOrigin | LinearIssueOrigin | JiraIssueOrigin;

export interface ItemSummary {
	resolved?: import("../factory/resolve-run.js").ResolvedRun;
	ranWith?: Partial<Record<import("../factory/resolve-run.js").RunRole, import("../factory/resolve-run.js").ActualRun>>;
	record?: import("../factory/readiness-track.js").ItemRecord | null;
	/** Its builder session has not been created yet. */
	awaitingPlace?: boolean;
	/** Absent for items filed before agents could be chosen: Windlass. */
	agent?: ItemAgent;
	placement?: ChildPlacement;
	mode?: ItemMode;
	parent?: { itemId: string; key: string; title: string } | null;
	id: string;
	title: string;
	/** The repository of the user's GitHub connection it is on; `branch` is the base its pull request goes into. For a cross-repo feature, its primary. */
	repository: SessionRepository;
	/** A cross-repo feature's repositories, the primary first. Absent: the one repository. */
	repositories?: FeatureRepoView[];
	/** A cross-repo feature's combined run. */
	integration?: IntegrationView;
	place: SandboxPlace;
	/** How the item was filed. */
	source: ItemSource;
	/** The source issue; null for items not filed through issue intake. */
	origin: ItemOrigin | null;
	state: ItemState;
	/** Set exactly when `state` is "waiting". */
	wait: Waiting | null;
	/** The open question, if any. */
	question: ItemQuestion | null;
	pullRequest: { number: number; url: string } | null;
	/** The latest verdict's result and flags; null before the first. */
	verdict: { result: Verdict["result"]; flags: VerifiedFlag[]; ci: Verdict["ci"]["state"] } | null;
	/** The second review for this run, or null before one is due. */
	review: {
		state: "waiting" | "running" | "filed" | "none" | "off";
		recommendation: ReviewRecommendation | null;
	} | null;
	budget: ItemBudget;
	spent: ItemSpend;
	/** A feature's: what all its parts used, retries among them. Its own turns are in `spent.usage`. */
	partsUsage?: import("./cost.js").SpendUsage;
	/** A feature's: the part of `partsUsage` spent retrying (factory/usage-summary.ts `partsRetryUsage`). */
	partsRetryUsage?: import("./cost.js").SpendUsage;
	/** What its changes are, from the paths its latest turn with changes left changed (factory/usage-summary.ts `workType`). Absent before any. */
	workType?: WorkType;
	/** When its first run began. Absent on a draft. */
	startedAt?: number;
	/** The item's agent session, among the user's sessions. */
	sessionId: string;
	createdAt: number;
	/** Last activity on the item. Background polls can advance its revision independently. */
	updatedAt: number;
	/** When it ended (done, failed or cancelled). Absent while it is open, and on an item that ended before the platform kept the time. */
	endedAt?: number;
	/** Increased by every change: a client that holds an `ItemView` of a lower revision asks for it again. */
	revision: number;
	/** The step its run is at, while the run goes on: what a list row says it is doing without reading the page. */
	step?: ItemSummaryStep;
}

/** The step of `ItemSummary.step`: its kind, since when, its turn, and the rounds of fixing used. */
export interface ItemSummaryStep {
	kind: StepKind;
	startedAt: number;
	turn: ItemStep["turn"];
	rounds: ItemRun["rounds"];
}

/** An item's page. */
export type CheckConclusion = "success" | "action_required" | "failure" | "cancelled";

export interface FeedbackEntry {
	id: string;
	author: string;
	access: "owner" | "write";
	kind: "changes_requested" | "commented" | "issue_comment" | "review_comment";
	body: string;
	path: string | null;
	line: number | null;
	commit: string | null;
	url: string;
	at: number;
}

export interface FeedbackBatch {
	savedPlan?: { goal: string; subtasks: string[] };
	entries: FeedbackEntry[];
	state: "pending" | "held" | "question" | "taken" | "declined";
	reason: string;
	run: number | null;
	plan: number | null;
}

/** A refused destination. DNS observations have no port and count the first lookup seen by the hosted stub.
 * An unparseable proxy destination has no host. Times are Unix milliseconds. For repeated destinations
 * the strongest refusal wins (private, provider, malformed, machine_policy, unlisted). Only "repository" offers allowHost.
 * With "machine", direct the owner to --egress-domains on the named machine. "never" is blocked by design.
 */
export interface BlockedHost {
	host: string | null;
	port: number | null;
	reason: "machine_policy" | "unlisted" | "private" | "provider" | "malformed";
	/** Paired machine display names, including both when an item combines matching destinations. */
	machineNames?: string[];
	allow: "repository" | "machine" | "deployment" | "never";
	firstAt: number;
	lastAt: number;
	count: number;
}

export interface BlockedNetwork {
	hosts: BlockedHost[];
	/** Number of requests to destinations beyond the session's first 50, including their retries. */
	overflow: number;
}

export interface ItemView extends ItemSummary {
	/** Commits on the target missing from the feature. Absent when the comparison is unavailable. */
	featureTargetAhead?: number;
	canUpdateFeature?: boolean;
	/** Union by host and port across all turns of the builder and reviewer. Absent on older servers. */
	blockedNetwork?: BlockedNetwork;
	feedback: { batches: FeedbackBatch[]; notTaken: number };
	verifiedCheck: {
		sha: string;
		state: "in_progress" | "completed" | "not_posted";
		conclusion: CheckConclusion | null;
		said: string;
	} | null;
	canRetry?: boolean;
	plan?: FeaturePlan | null;
	/** Remaining unattended subtask keys that each require confirmation at approval. */
	unattended?: string[];
	/** Approved parts whose agent can still be changed before job reservation. */
	editableAgents?: string[];
	/** With a plan: the keys of its subtasks whose work is integrated, which approval neither places nor confirms again. */
	completedSubtasks?: string[];
	/** After a re-plan: why the feature was planned again, in a short sentence ("A pull request comment asked for changes"). */
	replanWhy?: string;
	children?: ItemSummary[];
	/** Dispatched subtasks including placement waits. The start time is null for older jobs. */
	subtasks?: {
		id: string;
		key: string;
		state: ItemState;
		dispatchedAt: number | null;
		startedAt: number | null;
		wait: string | null;
	}[];
	/** A feature's: the screenshots its parts filed, a set for each report or review that has any, the newest set first. */
	partScreenshots?: PartScreenshots[];
	/** The builder's last report in the run shown, as the page shows it; null before one was filed. */
	report: ItemReport | null;
	/** Last ten, oldest first. */
	reviews: ItemReview[];
	reviewerSessionId: string | null;
	reviewNone: string | null;
	task: ItemTask;
	/** The run it is in, or ended last, with the rounds a run allows; null before it was started. */
	run: (ItemRun & { failureFingerprint?: string | null }) | null;
	/** The commit pushed last. */
	head: string | null;
	/** Its log, oldest first: the runs and steps before the current one are read from it. */
	events: ItemEvent[];
	/** Every verdict, the oldest first. */
	verdicts: Verdict[];
}

export type ItemMode = "single" | "orchestrate";

/** What an item's changes are: only docs, only tests, only dependency manifests and lockfiles, any other code, or the rest (config, CI, assets). */
export type WorkType = "docs" | "tests" | "deps" | "feature" | "other";

export interface PlacementNeeds {
	hostedSize?: HostedSize;
	tags?: string[];
	screenshots?: boolean;
	egress?: "open" | "restricted";
	profile?: SandboxProfileId;
	cpus?: number;
	memoryGiB?: number;
}

/**
 * A part inherits its resolved implementation agent unless the plan specifies one.
 * Claude Code and OpenCode require per-part unattended consent on machines and Hosted.
 */
export interface SubtaskAgent {
	harness: HarnessId;
	/** One the place offers for this agent. Left out: the feature's model for Windlass, the agent's own default otherwise. */
	model?: string;
	/** One the place offers for the model. Left out: the feature's effort for Windlass on its model, the agent's default otherwise. */
	effort?: string;
}

export interface ChildPlacement {
	payer?: CredentialSource;
	place: SandboxPlace;
	name: string;
	reason: string;
	units: number;
	sendSecrets: boolean;
	profile?: SandboxProfileId;
	/** A machine harness the subtask asked for (`needs.harness`); absent: Windlass. */
	harness?: HarnessId;
	/** Hosted: the size its `cpus` and `memoryGiB` chose (`hostedSizeFor`). Absent: the feature's size. */
	hostedSize?: HostedSize;
}

export interface PlanSubtask {
	review?: {
		inherited: import("../factory/resolve-run.js").ResolvedRun;
		places: {
			place: SandboxPlace;
			name: string;
			sendSecrets: boolean | null;
			payer: import("../factory/resolve-run.js").ResolvedRun["payer"];
		}[];
		hosted?: { saved: HostedSize; size: HostedSize; rate: number; usdPerHour: number | null };
	};
	placementProblem?: string;
	placementWait?: string;
	requestedLargerSize?: HostedSize;
	resolved?: import("../factory/resolve-run.js").ResolvedRun;
	/** Older plans inherit the feature's place. */
	place?: { prefer: string; reason: string; allow?: string[] };
	needs?: PlacementNeeds;
	/** Omit to inherit the resolved implementation agent. */
	agent?: SubtaskAgent;
	/** A cross-repo feature's subtask: the alias of the filing's repository it builds in (`FeatureRepository.alias`). Absent: the primary. */
	repo?: string;
	key: string;
	title: string;
	brief: string;
	acceptance: string[];
	dependsOn: string[];
	owns: string[];
	budget: SubtaskBudget;
}

/** Repository merge prerequisites are separate from subtask build dependencies. */
export interface MergeStep {
	repo: string;
	prerequisite: string[];
	intermediate: string;
	evidence: string;
	fallback: string;
}

/** A small named check of one repository against a sibling's integrated head. Stored with the plan, not run yet. */
export interface EarlyCheck {
	repo: string;
	sibling: string;
	name: string;
	command: string;
}

/** Cross-repo verification uses each integrated head. Run the command from the named repository beside its checked-out inputs. */
export interface FinalIntegration {
	runFrom: string;
	command: string;
	inputs: string[];
	/** Where it runs. "actions": the `runFrom` repository's integration workflow, on GitHub's runners. */
	profile: "actions";
	timeoutSeconds: number;
	requiredCases: string[];
	artifactOutputs: string[];
}

export interface FeaturePlanEdit {
	/** A cross-repo feature: the aliases of its filing's repositories, the primary first. Absent on a one-repository plan. */
	repos?: string[];
	mergeOrder?: MergeStep[];
	/** "request": the feature ends at a tested set and a release request. "wait": it waits for the owner's release and adopts it (not offered yet). */
	releaseGate?: "request" | "wait";
	earlyChecks?: EarlyCheck[];
	finalIntegration?: FinalIntegration;
	overflow?: boolean;
	/** Optional why supplies background shown separately from the question. */
	questions: {
		id: string;
		text: string;
		options?: string[];
		why?: string;
		recommended?: string;
		answer?: string;
		answeredBy?: "critic";
	}[];
	spec: { goal: string; requirements: string[]; outOfScope: string[]; acceptance: string[] };
	subtasks: PlanSubtask[];
	singleSuggested: string | null;
}

export interface FeaturePlan extends FeaturePlanEdit {
	version: number;
	status: "proposed" | "approved" | "superseded";
	budget: ItemBudget;
	compare: { singleBudget: ItemBudget };
	approvedBy?: string;
	approvedAt?: number;
}

/** A repository a cross-repo feature is filed over: a short alias for its mounts and results, GitHub's id for it and its base branch. */
export interface FeatureRepoInput {
	/** `^[a-z][a-z0-9-]{0,15}$`, unique in the filing. */
	alias: string;
	id: GithubId;
	branch?: string;
}

/** A repository of a cross-repo feature as the server bound it at filing. GitHub's ids are the authority; the alias only labels. */
export interface FeatureRepository {
	alias: string;
	repositoryId: GithubId;
	installationId: GithubId;
	owner: string;
	name: string;
	url: string;
	private: boolean;
	baseRef: string;
	/** The base's commit when the feature was filed: what the planner read. */
	planningBaseSha: string | null;
}

/** A repository of a cross-repo feature on its page: where its feature branch, pull request and merge stand. */
export interface FeatureRepoView extends FeatureRepository {
	primary: boolean;
	featureRef: string | null;
	seedSha: string | null;
	markerSha: string | null;
	/** The commit the feature branch was last fast-forwarded to by the platform. */
	integratedHead: string | null;
	pr: { number: number; url: string; draft: boolean } | null;
	/** What GitHub said of the pull request when it was last read. */
	prState: "open" | "draft" | "merged" | "closed" | null;
	mergedCommit: string | null;
}

/** The combined run of a cross-repo feature (`FinalIntegration`), as its page shows it. */
export interface IntegrationView {
	state: "not_run" | "queued" | "running" | "passed" | "failed" | "timed_out" | "cancelled" | "stale" | "unavailable";
	attempt: number;
	/** The heads it ran on, by alias; null before a run. */
	heads: Record<string, string> | null;
	url: string | null;
	said: string | null;
}

export interface CreateItemInput {
	mode?: ItemMode;
	/** Cross-repo plans list one or two repositories, starting with repository. Omission uses that repository alone. */
	repositories?: FeatureRepoInput[];
	/** A repository of the user's GitHub connection, by GitHub's id for it, and the base branch (default: the repository's default branch). */
	repository: { id: GithubId; branch?: string };
	/** At most MAX_TITLE_CHARS. */
	title: string;
	/** At most MAX_ITEM_BODY_CHARS. */
	body: string;
	/** At most MAX_ACCEPTANCE_CRITERIA, each at most MAX_NOTE_CHARS. */
	acceptance?: string[];
	/** Omitted choices inherit the repository, account and deployment settings in order. */
	profile?: SandboxProfileId;
	model?: string;
	reviewModel?: string;
	effort?: string;
	/** Implementation agent. Planning and review use Windlass. */
	harness?: HarnessId;
	place?: SandboxPlace;
	/** Hosted size for this item and its parts. */
	hostedSize?: HostedSize;
	/** True: started at once, as "Start" would. Left out: the item is a draft until started. */
	start?: boolean;
	/** As `CreateSessionInput.idempotencyKey`: the same key again answers with the item the first attempt made. */
	idempotencyKey?: IdempotencyKey;
}

/** What a person does to an item: each is refused (`item_conflict`) where the item's state does not allow it. */
export type ItemAction =
	| { kind: "update_feature" }
	| { kind: "cancel_subtask"; key: string }
	| { kind: "edit_plan"; version: number; plan: FeaturePlanEdit }
	/** Approval requires every remaining unattended subtask key. Cross-repo base changes require confirmation at the current heads. */
	| { kind: "approve_plan"; version: number; agents?: string[]; bases?: Record<string, string> }
	| { kind: "run_single" }
	/** After approval: the agent a subtask that has not started runs; null runs Windlass on the feature's model. */
	| { kind: "set_subtask_agent"; key: string; agent: SubtaskAgent | null }
	/** A draft: start it. */
	| { kind: "start" }
	| { kind: "cancel" }
	/** A failed item: start a new run. */
	| { kind: "retry" }
	/** An item in review: a new run, with the person's note to the agent. */
	| { kind: "send_back"; note: string }
	/** A note to the builder: into its running turn, or with its next turn. */
	| { kind: "note"; note: string }
	/** The open question: one of its choices, with a note to the agent, and for "raise" on a budget question the new budget. */
	| {
			kind: "answer";
			question: string;
			choice: ChoiceId;
			note?: string;
			budget?: Partial<ItemBudget>;
			agents?: string[];
	  };
