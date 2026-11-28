import type { ProviderRefusal } from "../provider-refusal.js";
import type { PlacementRoute, PlacementInventory } from "./placement.js";
import type {
	CheckConclusion,
	ChildPlacement,
	FeatureRepository,
	IntegrationView,
	ReviewRecommendation,
} from "../contract.js";
import type { AgentAsk, AgentReport } from "../agent-publish.js";
import type { OutOfMemory } from "../sandbox/api.js";
import type {
	ChoiceId,
	HostedSize,
	ItemBudget,
	ItemSpend,
	ItemEvent,
	ItemQuestion,
	ItemReview,
	ItemRun,
	ItemState,
	ItemStep,
	ItemTask,
	SandboxPlace,
	TurnOutcome,
	Verdict,
	VerdictRun,
	Verified,
	VerifiedFlag,
	Wait,
	Waiting,
} from "../contract.js";
import type { PersonDecision, ReviewerTaskInput } from "./reviewer-task.js";
import type { RerunnableJob, CiReading, CiState } from "../codehost/ci.js";

export type {
	ChoiceId,
	FactoryLimits,
	ItemBudget,
	ItemSpend,
	ItemEvent,
	ItemState,
	QuestionKind,
	StepKind,
	Verdict,
	VerdictRun,
	Wait,
	WaitReason,
	Waiting,
} from "../contract.js";

export type TurnStepKind =
	| "summary"
	| "refine"
	| "implement"
	| "ci_fix"
	| "run_checks"
	| "conflict"
	| "review"
	| "review_fix";

export type Step = ItemStep;

export interface GateEvidence {
	/** The turn explicitly verified an existing commit and needs its own local evidence. */
	forcedChecks?: true;
	outcome: TurnOutcome;
	verified: Verified | null;
	flags: VerifiedFlag[];
}

interface BaseFailureDecision {
	waitForBase?: string;
	fixInherited?: boolean;
}

export interface CiProgress extends BaseFailureDecision {
	autoMergeKey?: string;
	/** Base branch tip observed when this part was offered a CI update. */
	baseTip?: string;
	/** Older item rows predate webhook polling. */
	webhooks?: boolean;
	/** The person accepted CI alone for this published head. A new publication starts without it. */
	ciAlone?: true;
	lastReadState?: CiState;
	head: string;
	/** When it was pushed: CI's waits (CI_POLLING) count from here. */
	since: number;
	/** Evidence from the latest poll, cleared when a fresh reading is unavailable or still due. */
	last: { state: Exclude<CiState, "retry">; runs: VerdictRun[]; said: string | null } | null;
	mergeable: boolean | null;
	/** Evidence belongs to the pushed head, even if later unpublished work changes the gate. */
	gate: (GateEvidence & { turn?: string }) | null;
	/** A foreign head has no verdict from the agent. Null until GitHub reports a different head. */
	moved: string | null;
	reviewPush?: { head: string; failure?: string; asked?: true };
	/** The id of the verdict handed over for `head`, made again when the pull request moves after it. */
	handed: string | null;
	/** Original handoff, restored if the PR returns to the reviewed head. */
	secondReview: HandoffReview | null;
}

export interface Run extends ItemRun {
	/** The person started this run again after one that failed or was given up (Retry): what it uses is retry spend. */
	retry?: true;
	/** The PR summaries were published in this run. A retry can inherit a passing integration on the same heads. */
	confirmFeatureCi?: true;
	/** Read CI once before the owner takes the branch. */
	takingPush?: true;
	/** All planning deliveries in this run were checked for third-party input. Absent on older runs. */
	planInputsTrusted?: boolean;
	/** Ordered policy positions taken and the evidence that prompted each one. */
	autoHistory?: Record<string, { position: number; fingerprint: string }[]>;
	/** Delivery and original commit of the automatic local verification attempt. */
	autoCheck?: { turn: string; head: string };
	/** The fingerprint of the last failure a fix turn was started for. */
	lastFailure: string | null;
	/** Older runs keep only lastFailure. */
	failures?: string[];
	/** The one fix turn for failed checks this run took past its token budget (`RULES.checkFixGrace`). */
	budgetGrace?: true;
	/** Set while the workspace is pushed for "Hand it over as it is" (blueprint.ts `answer`): it is handed over once pushed. */
	handOver?: true;
	/** A part can take another base update once its feature tip changes again. */
	updatedBaseTip?: string;
	/** A person's base update stays attached to its publish step across retries. */
	updateFromBase?: { head: string; at: number; baseTip?: string };
	/** The turn that produced the work about to be published, including across publish retries. */
	gate: (GateEvidence & { turn: string }) | null;
	ci: CiProgress | null;
	review: RunReview | null;
	/** Questions asked with `ask_person` plus all `request_secret` attempts in this run. Absent on runs stored before the tool: none. */
	asks?: number;
	/** Delivery whose secret request was already charged before checking its name. */
	secretAttemptKey?: string;
	declinedSecrets?: string[];
}

/** A blocking finding of a review, as the next round's reviewer must answer it (`earlier` blocks). */
export interface EarlierFinding {
	id: string;
	/** The finding it continues, through every round: what "the same changes again" compares. */
	root: string;
	title: string;
	text: string;
	/** Carried by a review that said it is not fixed, without filing it again: that review's "earlier" text. */
	notFixed?: string | null;
	paths?: string[];
}

/** Older reviews default to round one with no earlier findings. */
export interface RunReview {
	verdictId: string;
	head: string;
	refiles: number;
	prReads?: number;
	/** 1 for the run's first review; one more after each round of fixes. */
	round?: number;
	/** The head the round before reviewed. */
	previousHead?: string | null;
	/** The round before's blocking findings, which this round answers. */
	earlier?: EarlierFinding[];
	/** This round's blocking findings, once filed: the next round's `earlier`. */
	open?: EarlierFinding[];
	/** The fingerprint of the blocking roots a fix was last started for. */
	lastOpen?: string | null;
	/** This round's filing, once filed: what "Hand it over as it is" keeps. */
	filed?: { id: string; trustedApproval?: boolean } & CheckReview;
	/** The run's last filing before this round, which this round's head has none of until it files. */
	before?: { id: string } & CheckReview;
}

export type Task = ItemTask & { featureBody?: string };

/** The primary repository mirrors the item’s seed, pull request and head. */
export interface FeatureRepoState extends FeatureRepository {
	featureCi?: FeatureCi;
	seed?: string;
	marker?: string;
	head?: string | null;
	pr?: { number: number; url: string } | null;
	draft?: boolean;
	prState?: "open" | "draft" | "merged" | "closed" | null;
	prHead?: string | null;
	mergedCommit?: string | null;
	/** When GitHub says the PR merged (`merged_at`, ms): the merge order is judged by these, not by when each was read. */
	mergedAt?: number | null;
	/** Set (the reading's time) while this merge's order waits on a fresh reading of a prerequisite not seen merged yet. */
	orderPending?: number | null;
}

/** A cross-repo feature's combined run (`IntegrationView`). `charged`: its time is on the ledger. */
export interface IntegrationRun extends IntegrationView {
	dispatchedAt: number | null;
	runId: string | null;
	/** Same-input retries of a run that did not finish for the runner's sake. */
	retries: number;
	charged: boolean;
}

export type JoinResult = { key: string } & (
	| { head: string }
	| { reason: string; conflict: boolean; missingTarget?: boolean }
);

/** The independent CI poll on one feature branch, pinned to its current head. */
export interface FeatureCi extends BaseFailureDecision {
	afterParts?: true;
	head: string;
	since: number;
	key?: string;
	passed?: boolean;
	repeated?: boolean;
}

export interface FeatureJob {
	askMachine?: boolean;
	offerHosted?: boolean;
	hostedProfile?: ChildPlacement["profile"];
	reviewFix?: { reviewedHead?: string };
	ciFix?: { head: string; fingerprint: string };
	conflictFix?: { target: string; child?: string; retry?: true };
	/** Immutable tip from which this child branches, after repository setup at the original seed. */
	start?: string | null;
	/** Current attempt attached to a creation request by the parent actor. */
	dispatchKey?: string;
	dispatchedAt?: number;
	startedAt?: number;
	wait?: string;
	placementRefusal?: string;
	repairOffer?: ChildPlacement;
	placementWaitSince?: number;
	/** Last serialized integration result, retained so a restarted child can receive it again. */
	join?: JoinResult;
	/** Receipt for a target update requested from this part’s CI question. */
	featureUpdateReceipt?: string;
	route?: PlacementRoute;
	warm?: string[];
	placement?: ChildPlacement;
	failure?: string | null;
	cancelRequested?: boolean;
	/** Dispatched in a run the person started again: all it uses is retry spend. */
	retry?: true;
	id: string;
	task: import("../contract.js").PlanSubtask;
	state: import("../contract.js").ItemState;
	spent: ItemSpend;
	/** The subtask's budget as its item last said it: its plan's, and what the person gave it since. Absent until it said. */
	budget?: ItemBudget;
	head: string | null;
	report: string;
}

export interface FeedbackInput {
	ids: string[];
	text: string;
	fingerprint: string;
	others: boolean;
	by: string;
	writers?: string[];
}

export interface FeedbackDecision {
	ids: string[];
	state: "held" | "question" | "taken" | "declined";
	reason: string;
	run?: number;
	plan?: number;
}

export interface FactoryItem {
	context?: import("./resolve-run.js").RunContext;
	resolved?: import("./resolve-run.js").ResolvedRun;
	runRole?: import("./resolve-run.js").RunRole;
	ranWith?: import("../contract.js").ItemSummary["ranWith"];
	requestedReview?: RequestedReview;
	/** Waiting for the builder to bind to a machine before its first run. */
	awaitingPlace?: string;
	awaitingReviewer?: boolean;
	useHosted?: boolean;
	placeAttempts?: number;
	/** A foreign push observed on this PR disqualifies it even if the original head returns. */
	foreignPush?: true;
	/** Withdrawn turns can still report spend after the person answers. */
	pushWithdrawals?: string[];
	/** Question claimed by Add it and continue. No continuation is delivered until the save settles. */
	claimedSecret?: Question;
	/** One rerun request per commit. Keep the original job ids to distinguish a fresh attempt from a delayed listing. */
	ciReruns?: Record<string, { jobs: RerunnableJob[]; reported?: boolean }>;
	/**
	 * The person's own words to the work since it was filed, oldest first, the newest kept (`RULES.personDecisions`): their
	 * send-back notes, their answers' notes and their own feedback on GitHub. The second reviewer is given them as the person's
	 * decisions (reviewer-task.ts), so that it does not ask for one to be undone.
	 */
	decisions?: PersonDecision[];
	/** The person's notes for the builder's next turn, sent while no builder turn ran (`note`); taken by the next one. */
	ownerNote?: string;
	/** A cross-repo feature's repositories, the primary first. Absent: the one repository of `task`. */
	repos?: FeatureRepoState[];
	integration?: IntegrationRun;
	feedbackReplans?: number;
	/**
	 * A feature's own token allowance: what its planner, its summary and its review may spend, apart from its
	 * subtasks. It starts at one item's budget (`singleBudget`) and grows by what the person gives it. The
	 * feature's budget is this and its subtasks' budgets together (blueprint.ts `featureTotal`). Absent on a
	 * feature stored before it was kept: `singleBudget.tokens`.
	 */
	ownTokens?: number;
	/** Turns counted toward the backstop from here (`RULES.turnBackstop`): set when the person lets the item go on past it. */
	backstopFrom?: number;
	feedback?: {
		held: string[] | null;
		heldText: string;
		heldFingerprint: string;
		heldWriters: string[];
		heldOthers: boolean;
		awaiting: FeedbackInput | null;
		taken: string[];
		runs: Record<string, number>;
		othersRuns: number;
		lastIds: string[];
	};
	/** Checks opened by this run, including a handed head reopened for rework. */
	pendingChecks?: {
		sha: string;
		existingOnly: boolean;
		feedback?: boolean /** Reviewed in this round, which asked for changes: completed by the head a later round hands over. */;
		reviewRound?: number;
	}[];
	lastReverifyAt?: number;
	routes?: Record<string, PlacementRoute>;
	placement?: ChildPlacement;
	jobs?: FeatureJob[];
	featureCi?: FeatureCi;
	joinOnGate?: boolean;
	joining?: { child: string; key: string };
	/** Target commit pinned when requested. Waits behind a part already holding the join grant. */
	featureUpdate?: { repo?: string; key: string; target: string; child?: string };
	stoppedJob?: string;
	retryChildren?: boolean;
	forceSplit?: boolean;
	seed?: string;
	childBase?: string;
	mergeTarget?: string;
	/** The feature commit after this child's successful join. Its own pushed head stays on the child. */
	integratedHead?: string;
	cancelAfterIntegration?: boolean;
	approvedPlan?: import("../contract.js").FeaturePlan;
	mode?: import("../contract.js").ItemMode;
	singleBudget?: ItemBudget;
	filedTurn?: string;
	replans?: number;
	/** Why the feature was last planned again, as its revised plan's card says it. */
	replanWhy?: string;
	featurePlan?: import("../contract.js").FeaturePlan;
	parent?: NonNullable<import("../contract.js").ItemSummary["parent"]>;
	id: string;
	/** Increased by every change; the actor stores a state only over the revision it read. */
	revision: number;
	state: ItemState;
	/** Set exactly when `state` is "waiting". */
	wait: Waiting | null;
	task: Task;
	/**
	 * Where outside text in `task` came from (untrusted.ts): an issue written by someone other than the person
	 * who filed it, and for a subtask its feature's sources and the reports of the subtasks before it.
	 * Every turn that hands the agent the task says so. Absent: the task is the person's own.
	 */
	untrusted?: string[];
	/**
	 * The sources of someone else's text (untrusted.ts, `thirdParty`) the person chose to run anyway on
	 * "Docker, hardened" ("Run it anyway"), where no agent can contain what such text talks it into: a
	 * turn whose such sources are all here goes there labelled only. A subtask starts with its feature's.
	 * Absent: none.
	 */
	unsandboxed?: string[];
	/** Decided when the builder binds to its place. */
	reviewer?: { on: true } | { off: "deployment" | "feature" | "machine" | "profile" };
	place: SandboxPlace;
	machineRemoved: boolean;
	budget: ItemBudget;
	spent: ItemSpend;
	/** Absent for items filed before agents could be chosen: Windlass. */
	agent?: import("../contract.js").ItemAgent;
	/** Since when the item is "working": active time (§2.4) is the sum of such stretches. */
	workingSince: number | null;
	/** When it last entered done, failed or cancelled; absent while it is not ended, and on items that ended before this was kept. */
	endedAt?: number;
	/** When its first run began. */
	startedAt?: number;
	run: Run | null;
	pr: { number: number; url: string } | null;
	/** The commit pushed last. */
	head: string | null;
	question: Question | null;
}

/** Stored round-cap causes resume like a repeated failure. */
export type StopCause =
	| "repeated"
	| "turns"
	| "interruptions"
	| "plan"
	| "gate"
	| "ci"
	| "conflict"
	| "review"
	| "sandboxes"
	| keyof ItemBudget;

/** A question as the contract shows it (`ItemQuestion`), and what answering it goes on with. */
export interface Question extends ItemQuestion {
	updateRepo?: string;
	inherited?: { head: string; baseTip: string; repo?: string };
	repo?: string;
	child?: string;
	cause: StopCause | null;
	/** The turn that was about to start when the question was asked: what "raise" and "again" go on with. */
	resume: TurnPlan | null;
}

/** base is the target branch. The actor supplies its pinned SHA to reviewerTask. */
export type ReviewCheckout = { head: string; base: string; pr: number };
export type ReviewerInput = Pick<
	ReviewerTaskInput,
	"round" | "task" | "pr" | "head" | "previousHead" | "verdictWords" | "records" | "filings" | "decisions"
> & { verdictId: string; earlier: EarlierFinding[] };
export type CheckReview = { recommendation: ReviewRecommendation; blocking: number };
export type HandoffReview =
	| { review: string; reviewNone: null; assessment?: CheckReview }
	| { review: null; reviewNone: string };

export interface TurnPlan {
	/** Include this continuation’s instructions when the agent needs the whole task again. */
	includeInFresh?: boolean;
	kind: TurnStepKind;
	/** Absent on builder plans, including resume plans saved before reviewer sessions. */
	to?: "work" | "review";
	checkout?: ReviewCheckout | null;
	text: string;
	/** Range occupied by the quoted batch. A held batch's line locations are rendered against the head at handoff. */
	feedbackQuote?: { head: string | null; start: number; length: number };
	/** False: another attempt of the current step. */
	newStep: boolean;
	/** The round the turn counts in (`Run.rounds`, shown and never capped); "interruptions": the step's cut-off turns, counted when they end. */
	charge: "plan" | "gate" | "ci" | "conflict" | "review" | "interruptions" | null;
	/** For a fix turn: the failure it is for (§2.1 step 5). */
	fingerprint: string | null;
	/** For a conflict turn: the base branch to fetch into the workspace first. */
	fetchBase: string | null;
	/**
	 * Where the outside text in `text` came from, in the person's words ("CI logs of abc1234"): text the
	 * platform does not vouch for. The session's Windlass is told, and its session is tainted from that turn
	 * on (untrusted.ts). Absent or empty: the platform's own sentences and the item's person's words only.
	 */
	untrusted?: string[];
}

/** The owner's explicit retry replays this delivery, including a conflict step's base fetch. */
export interface ItemProviderRefusal extends ProviderRefusal {
	accountKey?: string;
	placeName?: string;
	retry: Pick<TurnPlan, "text" | "fetchBase" | "untrusted">;
}

/** A turn the session did not start on "Docker, hardened" for someone else's text, whatever the agent (untrusted.ts, `untrustedTurn`). */
export interface UntrustedRefusal {
	sources: string[];
	retry: Pick<TurnPlan, "text" | "fetchBase" | "untrusted">;
}

/** Who caused a fact a person or GitHub caused (§1.3): "person:<uid>". Facts from the platform have none. */
export type Cause = string;

/** What the agent's turn used: tokens of this turn (`turnTokens`), and the sandbox seconds the ledger holds for the item's session so far (`ledgerSeconds`). */
export interface TurnSpend {
	/** Counted against the item's token budget, cost-weighted (budget.ts `weightedTokens`): none where the agent's tokens are not (budget.ts, `agentTurn`). */
	tokens: number;
	/** The same tokens as reported, cached input at full count. Absent where none are counted, and on outbox rows stored before: `tokens`. */
	rawTokens?: number;
	hostedSeconds: number;
	/** What a machine harness reported of the turn. Absent for Windlass. */
	agent?: AgentTurn;
	/** The turn's model, payer, tokens and sandbox size, for its cost (cost.ts). Absent from the platform's own spend facts. */
	meter?: import("./cost.js").TurnMeter;
	/** The turn's model dollars at API prices, whoever paid (budget.ts `turnUsd`); null where they could not be priced. */
	usd?: number | null;
	/** What billing made of the item's own hosted seconds so far, a lifetime total like `hostedSeconds`; absent with billing off. */
	hosted?: import("../contract.js").HostedSplit;
}

/** What a machine harness (Claude Code, OpenCode) reported of one turn. */
export interface AgentTurn {
	/** Tokens it reported; null where it reported none. */
	reported: number | null;
	/** Whether they count against the item's token budget (harnesses.ts, `itemTokens`). */
	counted: boolean;
	/** Its conversation's cost so far. */
	cost: { amount: number; currency: string } | null;
	/** Claude Code's 5-hour window, % used, at the turn's start and end. */
	fiveHour: { start: number; end: number } | null;
}

export type RequestedReview = Pick<FeatureRepository, "repositoryId" | "installationId" | "owner" | "name"> & {
	key: string;
	pr: number;
	head: string;
	base: string;
	sender: string;
	untrusted: boolean;
};

export type BranchPush = Omit<NonNullable<ItemQuestion["push"]>, "head"> & { pusher: string; own: boolean };

export type Fact =
	| {
			kind: "branch_push";
			at: number;
			key: string;
			previous: string | null;
			head: string;
			push?: BranchPush;
			repo?: string;
	  }
	| { kind: "sandbox_reclaimed"; at: number; said: string }
	| { kind: "request_review"; at: number; subject: string; request: RequestedReview }
	| {
			kind: "default_place_ready";
			reviewer: NonNullable<FactoryItem["reviewer"]>;
			reviewerSessionId: string | null;
			at: number;
			place: SandboxPlace;
			agent: NonNullable<FactoryItem["agent"]>;
	  }
	| { kind: "default_place_wait"; reviewer?: boolean; at: number; sentence: string }
	| ({ kind: "github_feedback"; at: number } & FeedbackInput)
	| { kind: "reverify"; at: number; head: string }
	/** A cross-repo feature's combined run was asked of GitHub (`runId` once GitHub named it). */
	| { kind: "integration_started"; at: number; key: string; attempt: number; runId: string | null; url: string | null }
	/** What the combined run came to, or that it could not be started or read (`unavailable`). `seconds`: how long it ran. */
	| {
			kind: "integration_read";
			at: number;
			key: string;
			attempt: number;
			state: "queued" | "running" | "passed" | "failed" | "cancelled" | "timed_out" | "unavailable";
			url: string | null;
			said: string | null;
			seconds?: number;
	  }
	/** A cross-repo feature's pull request in `repo` cannot be read any more: the App lost access, or the repository or PR is gone. */
	| { kind: "repo_pr_lost"; at: number; key: string; repo: string; said: string }
	| {
			kind: "repo_pr_read";
			at: number;
			key: string;
			repo: string;
			state: "open" | "draft" | "merged" | "closed";
			prHead: string | null;
			mergedCommit: string | null /** `merged_at` (ms), null when GitHub did not say. */;
			mergedAt?: number | null;
	  }
	| { kind: "cancel_subtask"; key: string; by: string; at: number }
	| {
			kind: "update_feature";
			automatic?: true;
			at: number;
			by: Cause;
			target?: string;
			child?: string;
			request?: string;
	  }
	| {
			kind: "feature_updated";
			at: number;
			key: string;
			result: { head: string } | { problem: string } | { conflicts: string[] };
	  }
	| { kind: "parent_update_finished"; at: number; key: string }
	| { kind: "claim_join"; at: number; child: string; key: string }
	| { kind: "finish_join"; at: number; child: string; result: JoinResult }
	| {
			kind: "child_notice";
			integratedHead?: string;
			at: number;
			child: string;
			state: FactoryItem["state"];
			spent: ItemSpend;
			budget?: ItemBudget;
	  }
	| { kind: "file_plan"; inventory?: PlacementInventory; at: number; key: string; plan: unknown }
	| { kind: "edit_plan"; inventory?: PlacementInventory; at: number; by: string; version: number; plan: unknown }
	/** `agents`: the subtasks whose agent works without asking that the person confirmed (`ItemAction`). */
	| { kind: "refresh_plan"; version: number; inventory: PlacementInventory; at: number }
	| {
			kind: "approve_plan";
			inventory?: PlacementInventory;
			at: number;
			by: string;
			version: number;
			agents?: string[];
			bases?: Record<string, string>;
	  }
	| { kind: "run_single"; at: number; by: string }
	| { kind: "set_subtask_agent"; inventory?: PlacementInventory; at: number; by: string; key: string; agent: unknown }
	| { kind: "start"; at: number; by: Cause }
	| { kind: "machine_removed"; at: number }
	| { kind: "cancel"; at: number; by: Cause }
	| { kind: "retry"; at: number; by: Cause }
	/** "Send back" with a note, from review. */
	| { kind: "send_back"; at: number; by: Cause; note: string }
	/** The person's note to the builder: `steered` into its running turn, or kept for its next one. */
	| { kind: "note"; at: number; by: Cause; note: string; steered?: boolean }
	| { kind: "claim_secret"; at: number; by: Cause; question: string; name: string }
	| { kind: "settle_secret"; at: number; by: Cause; question: string; error: string | null }
	| {
			kind: "answer";
			target?: string;
			inventory?: PlacementInventory;
			at: number;
			by: Cause;
			question: string;
			choice: ChoiceId;
			note?: string;
			budget?: Partial<ItemBudget>;
			agents?: string[];
	  }
	| { kind: "ci_rerun_result"; repo?: string; at: number; head: string; accepted: string[]; said: string }
	/** The ledger has counted more hosted sandbox time for the item's session (it settles after a turn ends, and then while nothing else happens). */
	| { kind: "spent"; at: number; hostedSeconds: number; hosted?: import("../contract.js").HostedSplit }
	/**
	 * The draft feature PR's ready-for-review step after handover: `refused` is GitHub's reason when it kept refusing (the
	 * person is asked to mark it ready), null once the PR is ready.
	 */
	| { kind: "pr_ready_read"; at: number; pr: number; refused: string | null }
	| StepFact;

/** Receipts dispatched against the active step or its own poll or child key. */
export type StepFact =
	/** `repo`: a cross-repo feature's repository, by alias; absent: the one repository. */
	| { kind: "feature_seed"; at: number; key: string; sha: string; repo?: string }
	| {
			kind: "feature_ready";
			waitForCiOnEachPart?: boolean;
			at: number;
			key: string;
			head: string;
			pr: NonNullable<FactoryItem["pr"]>;
			repo?: string;
	  }
	| { kind: "place_child"; child?: string; at: number; key: string; inventory: PlacementInventory }
	| {
			kind: "placement_wait";
			at: number;
			child: string;
			key: string;
			sentence: string;
			askMachine?: boolean;
			offerHosted?: boolean;
			hostedProfile?: ChildPlacement["profile"];
			refused?: boolean;
			dailyCap?: boolean;
			providerUntil?: number;
			accountKey?: string;
	  }
	| {
			kind: "child_update";
			startedAt?: number;
			wait?: string;
			placement?: ChildPlacement;
			failure?: string | null;
			at: number;
			key: string;
			child: string;
			state: FactoryItem["state"];
			spent: ItemSpend;
			budget?: ItemBudget;
			report: string;
			head: string | null;
	  }
	| { kind: "integrated"; head?: string; at: number; key: string }
	| { kind: "feature_problem"; at: number; key: string; reason: string; rebase?: boolean; missingTarget?: boolean }
	| { kind: "sandbox_retry"; key: string; at: number; plan: TurnPlan }
	| { kind: "provider_retry"; key: string; at: number; plan: TurnPlan; loginChanged?: boolean }
	| { kind: "turn_waiting"; at: number; key: string; wait: Wait }
	| { kind: "session_deleted"; at: number; key: string }
	| {
			kind: "turn_started";
			at: number;
			key: string;
			role?: import("./resolve-run.js").RunRole;
			actual?: Pick<
				import("./resolve-run.js").ResolvedRun,
				"place" | "agent" | "model" | "effort" | "profile" | "payer"
			> & { size?: HostedSize | number | null; payerSource?: "account" | "deployment" };
	  }
	/** The session's answer to `check_turn`: that turn still runs. `key` is the check's. */
	| { kind: "turn_running"; at: number; key: string }
	/** The turn of `key` is paused, not ended: its machine went away mid-turn (`since`). It resumes by itself when the machine is back. */
	| { kind: "turn_paused"; at: number; key: string; since: number; machine: string | null }
	/** The paused turn of `key` runs again: its machine came back after `offlineMs`. */
	| { kind: "turn_resumed"; at: number; key: string; offlineMs: number }
	/** The paused turn of `key` has waited for its machine since `since`, long enough (WLP_MACHINE_AWAY_ASK_MS) to ask the person once. */
	| { kind: "machine_away"; deadline?: number; at: number; key: string; since: number; machine: string | null }
	| {
			kind: "turn_ended";
			taskKind?: import("./readiness-track.js").TaskKind;
			/** What the work's changed paths are (usage-summary.ts `workType`); absent where git named none. */
			workType?: import("../contract.js").WorkType;
			autoApprovePlans?: boolean;
			at: number;
			key: string;
			outcome: TurnOutcome;
			/** The configured limit when the harness ended this turn at its step limit. */
			stepLimit?: number;
			verified: Verified | null;
			flags: VerifiedFlag[];
			/** Whether there is something to push: the workspace or local commits differ from what GitHub has of the branch (from the base, before the first push). */
			changes: boolean;
			/** What the agent filed. A string can arrive from a session outbox written before structured reports. */
			report: AgentReport | string | null;
			/** The question the builder asked its person in the turn (`ask_person`), cleaned by the session. */
			asked?: AgentAsk | null;
			secret?: Question["secret"];
			/** A push made by the host tool can precede the item's publish step. */
			pushedHead?: string | null;
			/** Session-authored reason the turn could not start. */
			refused?: string | null;
			policyRefusal?: true;
			reportProblem?: string;
			/** Retain the refused delivery and its sources for explicit owner approval. */
			untrustedRefusal?: UntrustedRefusal;
			providerRefusal?: ItemProviderRefusal;
			/** Platform-authored explanation of a refused sandbox escape. */
			escaped?: string;
			/** Sandbox setup failed before the agent ran. */
			sandboxFailed?: string;
			/** Measured hosted memory and limit in MiB, plus the sandbox size. */
			outOfMemory?: OutOfMemory;
			/** Its session stopped the turn at the delivery's `budget` (#100a): the item asks its budget question. */
			budgetStopped?: true;
			spend: TurnSpend;
	  }
	| {
			kind: "review_ended";
			approvalProblem?: string;
			planReview?: import("./autonomy.js").PlanReview;
			inventory?: PlacementInventory;
			by?: "critic";
			at: number;
			key: string;
			outcome: TurnOutcome;
			stepLimit?: number;
			review: ItemReview | null;
			said: string | null;
			refused?: string | null;
			providerRefusal?: ItemProviderRefusal /** As `turn_ended`'s. */;
			sandboxFailed?: string;
			outOfMemory?: OutOfMemory;
			/** Its session stopped the review at the delivery's `budget` (#100a). */
			budgetStopped?: true;
			spend: TurnSpend;
	  }
	/** The session's sandbox was removed for "Start on a fresh sandbox" (`fresh_sandbox` effect): `plan` runs next, in a new one. */
	| { kind: "sandbox_freed"; at: number; key: string; plan: TurnPlan; hostedSize?: HostedSize }
	| { kind: "sandbox_resize_refused"; at: number; key: string; plan: TurnPlan; size: HostedSize }
	/** `openItems`: the user's items not done, failed or cancelled; it sets how often CI is polled. */
	| { kind: "base_conflict"; at: number; key: string }
	| {
			kind: "published";
			at: number;
			key: string;
			head: string;
			pr: { number: number; url: string } | null;
			openItems: number;
			webhooks: boolean;
	  }
	/** `transient`: a network error, retried; otherwise GitHub refused (a moved branch, a protected one, `.github/workflows`). */
	| { kind: "publish_failed"; at: number; key: string; said: string; transient: boolean }
	| { kind: "secret_attempt"; at: number; key: string; previous: number }
	| {
			kind: "ci_rerun_started";
			repo?: string;
			at: number;
			key: string;
			head: string;
			jobs: RerunnableJob[];
			openItems: number;
	  }
	/** `prHead`: the commit the pull request's branch is at, as GitHub said it with the reading; null when it did not. */
	| {
			kind: "ci_read";
			basePassed?: boolean;
			featureHead?: string;
			repo?: string;
			paths?: string[];
			autoMergeSingles?: boolean;
			at: number;
			key: string;
			head: string;
			reading: CiReading;
			baseAhead?: number;
			baseTip?: string;
			featureTarget?: string;
			featureTargetHead?: string;
			mergeable: boolean | null;
			prHead: string | null;
			openItems: number;
			webhooks: boolean;
	  }
	| { kind: "auto_merge_result"; behind?: boolean; at: number; key: string; head: string; reason: string | null }
	| {
			kind: "pr_read";
			pushCi?: CiReading;
			mergedByApp?: boolean;
			at: number;
			key: string;
			state: "open" | "draft" | "merged" | "closed";
			prHead: string | null;
			webhooks: boolean;
	  };

/** The actor commits effects with state and replays them by key. An effect time is its earliest execution. */
export type VerifiedCheckEffect = {
	kind: "verified_check";
	key: string;
	run: number;
	step: NonNullable<ItemEvent["step"]>;
	startedAt: number;
	changedAt: number;
	verdictId: string | null;
	title: string;
	summary: string;
	existingOnly?: boolean;
} & ({ state: "in_progress"; conclusion: null } | { state: "completed"; conclusion: CheckConclusion });

export type Effect =
	| ({ kind: "requested_review"; to: "review" } & RequestedReview)
	| ({ kind: "post_requested_review" } & RequestedReview)
	| { kind: "discard_placement"; key: string }
	| { kind: "resolve_default_place"; key: string; at: number }
	| { kind: "auto_merge"; key: string; head: string; baseTip?: string; pr: number }
	| VerifiedCheckEffect
	| { kind: "sandbox_retry"; key: string; at: number; plan: TurnPlan }
	| { kind: "provider_retry"; key: string; at: number; plan: TurnPlan }
	| { kind: "cancel_children"; key: string; ids: string[] }
	| { kind: "notify_integrated"; key: string; head: string }
	| { kind: "integrate"; key: string; head: string }
	| { kind: "merge_feature_target"; repo?: string; key: string; target: string }
	| { kind: "update_parent_feature"; automatic?: true; key: string; target: string }
	| { kind: "describe_feature"; key: string }
	/** A cross-repo feature: write the managed section that links its pull requests on each of them. */
	| { kind: "link_prs"; key: string }
	/** A cross-repo feature: start its combined run on `heads`, by alias. */
	| { kind: "integration"; key: string; attempt: number; heads: Record<string, string> }
	| { kind: "poll_integration"; key: string; attempt: number; at: number }
	/** A cross-repo feature: read its pull request in `repo`. */
	| { kind: "poll_repo_pr"; key: string; repo: string; pr: number; at: number }
	| { kind: "dispatch"; child?: string; key: string; at?: number }
	/** Put a message in the session's inbox; it starts a turn when a slot and a lease are granted. */
	| {
			kind: "deliver";
			key: string;
			text: string;
			feedbackQuote?: TurnPlan["feedbackQuote"];
			agent: "critic" | "planner" | "summary" | "run_checks" | null;
			maxSteps: number;
			fetchBase: string | null /** A builder's turn: the questions its run may still ask (`ask_person`). */;
			asksLeft?: number;
			to?: "review" | "critic";
			checkout?: ReviewCheckout;
			reviewerInput?: ReviewerInput /** `TurnPlan.untrusted`; for a reviewer's turn, always some. Absent: none. */;
			untrusted?: string[] /** Every source of someone else's in `untrusted` is in `FactoryItem.unsandboxed`. */;
			unsandboxed?: true /** A builder's turn that goes on with its step: the prompt for an agent without the step's conversation (session-inbox.ts `Delivery.fresh`). */;
			fresh?: { text: string; untrusted: string[]; unsandboxed?: true };
			/** Where the turn is stopped while it runs (budget.ts `turnBudget`); absent where nothing measurable holds the item. */
			budget?: import("./budget.js").TurnBudget;
	  }
	/** The turn of `key` is not wanted any more: take it out of the inbox, or stop it. */
	| { kind: "release_review"; key: string; run: number; to: "review" }
	| { kind: "withdraw"; key: string; to?: "review" | "critic" }
	/** Remove the session's sandbox (the person chose a fresh one); `sandbox_freed` with `plan` follows. */
	| {
			kind: "fresh_sandbox";
			key: string;
			at?: number;
			plan: TurnPlan;
			to?: "review" | "critic" /** "Start on a larger sandbox": the size of the new one. */;
			hostedSize?: HostedSize;
	  }
	/** Ask the session whether the turn of `turn` still runs; it answers `turn_running` with `key`, or `turn_ended`. */
	| { kind: "check_turn"; key: string; turn: string; at: number; to?: "review" | "critic" }
	/** Commit and push the session's branch, then open or update its pull request with the agent's report and the verified section. */
	| { kind: "publish"; key: string; at?: number }
	| { kind: "rerun_ci"; repo?: string; key: string; head: string; jobs: RerunnableJob[]; openItems: number }
	| { kind: "poll_ci"; repo?: string; key: string; head: string; at: number; notBefore?: number }
	| { kind: "poll_pr"; key: string; pr: number; at: number }
	/** Mark the draft feature PR ready for review once more, as the person asked; `pr_ready_read` follows. */
	| { kind: "ready_pr"; key: string; run: number; pr: number }
	/** Record the question and show it ("Needs you"). */
	| { kind: "ask"; question: Question }
	/** Record the verdict, request a review from the item's person, and put the verdict line on the pull request. */
	| ({
			kind: "handoff";
			key: string;
			verdict: Verdict;
			words: string;
			continuedIn?: number;
			reviewDone?: true;
			/** How often GitHub refused to mark the feature PR ready for review: it is tried again after a wait, then handed to the person. */
			readyRefusals?: number;
			/** The run's last review asked for changes (or for the person), and no review was filed for the head handed over. */
			unfinished?: true;
	  } & HandoffReview);

/** A transaction-only effect, consumed before the actor performs any deliveries. */
export interface VerdictEffect {
	kind: "verdict";
	verdict: Verdict;
	words: string;
}

export interface Outcome {
	feedback?: FeedbackDecision[];
	/** The same object as given when the fact changed nothing. */
	item: FactoryItem;
	/** The id of the review filing this fact's review turn filed and the blueprint took (any round, handed over or not): the actor keeps it with the item. */
	tookReview?: string;
	/** Store beside the item before performing the outbox. This effect never goes to GitHub. */
	storeVerdict?: VerdictEffect;
	effects: Effect[];
	/** Entries for the item's event log (§1.2 `events`), in the order they happened. */
	events: ItemEvent[];
}
