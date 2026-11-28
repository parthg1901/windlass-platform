import type { RawAccess } from "rivetkit/db";
import type {
	ModelList,
	LiveDelta,
	ItemReview,
	FeedbackEntry,
	PendingQuestion,
	PullRequestInfo,
	RepositoryCheck,
	SandboxPlace,
	SandboxProfileId,
	SessionSnapshot,
	SessionStatus,
	SessionSummary,
	StartTimes,
	TimelineItem,
	TurnOutcome,
	Verified,
	WorkspaceFile,
	HostedSize,
} from "../../contract.js";
import type { BlockedNetwork, NetworkBlockedItem } from "../../contract.js";
import type { StoredRepository } from "../../github/publish.js";
import type { OutOfMemory, TurnAnswer, TurnCheckpoint, TurnControl, TurnPersonalServer } from "../../sandbox/api.js";
import type { MachineUnreachable, RunnerLink } from "../../sandbox/runner-layer.js";
import type { ConversationRecord } from "../../runner/channel.js";
import type { OutgoingJournal } from "../../runner/journal.js";
import type { OpenedAccountSecret } from "../../account-secrets.js";
import type { OpenedSecret, Redactor } from "../../repo-secrets.js";
import type { KnownServer, ServerApproval } from "../../server-approvals.js";
import type { UnfinishedSetup } from "../../setup-command.js";
import type { Attempts, Submission } from "../../submissions.js";
import type { VerificationLog } from "../../verified.js";
import type { HoldReport, OpenStretch, PendingAsk } from "../../usage.js";
import type {
	ContinuedFrom,
	EnvironmentBuildOrigin,
	EnvironmentBuildReport,
	Handoff,
	MachineCopy,
	SealedSecrets,
	SessionCreateInput,
} from "../internal.js";
import type { AgentAsk, AgentReport } from "../../agent-publish.js";
import type { Judgment } from "../../factory/readiness.js";
import type { PlanReview } from "../../factory/autonomy.js";
import type { ItemProviderRefusal, UntrustedRefusal } from "../../factory/types.js";
import type { StartClock } from "../../start-times.js";
import type { HarnessId } from "../../sandbox/harness.js";
import type { PauseReason, TurnRun, TurnCredential } from "../turn-resume.js";
import type { InboxRow } from "../session-inbox.js";

export type FeedbackPrompt = { text: string; entries: FeedbackEntry[] };

export interface SessionMeta {
	readiness?: NonNullable<SessionCreateInput["readiness"]> & {
		result?: Judgment;
		error?: string;
		diagnosis?: import("../../repo-setup/types.js").SetupDiagnosis;
	};
	githubFeedback?: { pending?: FeedbackPrompt; seen: { id: string; at: number }[] };
	secretRequest?: SessionSnapshot["secretRequest"];
	/** Plain sessions have no item run. Count requests and remember skipped names across their turns. */
	secretAsks?: number;
	secretRefusalRun?: string;
	declinedSecrets?: string[];
	/** The current conversation has seen outside text, including turns on harnesses without a taint marker. */
	secretRequestBlocked?: boolean;
	size?: number;
	/** A session that only builds the repository's prepared environment (user-environments.ts): one turn, no agent. */
	environmentBuild?: EnvironmentBuildOrigin;
	/** The validated environment the current sandbox started from (SessionSummary.environment); null once it has another. */
	environment?: SessionSummary["environment"] | null;
	/** Hosted, where the layer offers sizes: what its sandboxes are made in. A sandbox keeps its size; another is a new sandbox. */
	hostedSize?: HostedSize;
	/** The sandbox whose running out of memory a turn's end noted: its restart at the next connect is not asked about again. */
	memoryNoted?: string;
	uid: string;
	sessionId: string;
	demo: boolean;
	title: string;
	/** Set by a person at creation or rename. Absent on older sessions. */
	titleIsTyped?: boolean;
	/** An agent has titled the session (`generatedSessionTitle`): its turns stop waiting for one. Absent on older sessions. */
	titleGenerated?: boolean;
	place: SandboxPlace;
	profile: SandboxProfileId;
	model: string;
	/** The effort its turns run at unless a prompt names another; null is the model's default. Absent on older sessions. */
	effort?: string | null;
	mode: string;
	availableModes: SessionSummary["availableModes"];
	/** The last few turns' start times (start-times.ts), oldest first. Absent on sessions that have had no turn since. */
	startTimes?: StartTimes[];
	repoUrl: string | null;
	createdAt: number;
	updatedAt: number;
	status: SessionStatus;
	turns: number;
	lastOutcome: TurnOutcome | null;
	/** What its turns used, by model and payer (`SessionSummary.spent`). */
	spent?: import("../../contract/cost.js").SpendUsage;
	/** The sandbox this session was given, kept when it turns out to be gone so the next turn can say so. */
	sandboxId: string | null;
	sandbox: "none" | "running" | "paused";
	// Shared data survives replacement. Only the provider-confirmed sandbox ID owns its data.
	ownDataSandbox?: string | null;
	// The panel shows the account secret restrictions observed by the last turn.
	accountSecrets?: string | null;
	/** Whether `repoUrl` has been cloned into the current sandbox. */
	cloned: boolean;
	/** The agent this session runs. Absent means Windlass. */
	harness?: HarnessId;
	harnessModels?: ModelList | null;
	/** The harness's own conversation id, kept across turns. */
	windlassSessionId: string | null;
	/** True for a conversation opened with the feature summary's tool list. */
	summaryConversation?: true;
	turnStartedAt: number | null;
	/** When this session was created, last ran a turn, or last used its workspace. */
	lastUsedAt: number;
	/** The idle check the durable schedule holds: its id, and when it fires. */
	idleCheck?: { id: string; at: number } | null;
	/** The last turn ended on an approval nobody answered in a hosted sandbox: the sandbox pauses at once, not after the idle time. */
	pauseNow?: true;
	/** Set when the session was launched on a repository of the user's GitHub connection (`repoUrl` is its address). */
	repo?: StoredRepository | null;
	/** The branch the platform pushes the session's work to: named when it first pushes, and kept. */
	publishBranch?: string;
	// Last known remote head, including commits pushed by others.
	pushedHead?: string | null;
	// Only a commit the platform pushed can serve as a force-with-lease expectation.
	platformPushed?: string | null;
	/** Whether the workspace had commits GitHub lacks when it was last asked, and what that answer was for (`unpushedWork`). */
	unpushed?: { key: string; value: boolean } | null;
	/** The session's pull request, as GitHub last described it. */
	pull?: PullRequestInfo | null;
	/** What the session's work rests on since its last turn ended (verified.ts): what a pull request's description is given. */
	verified?: Verified | null;
	// Missing permission requires a fresh publish approval.
	publishUnasked?: boolean;
	// A restore must match the saved session ID, size and hash.
	backup?: { windlassSessionId: string; size: number; sha256: string; at: number; turn: number } | null;
	/** The last turn that may have changed Windlass's session. The copy is behind while its `turn` is lower. */
	memoryTurn?: number;
	/** Set once the session's data was too large to copy and the timeline said so: nothing is packed again while the limit is no higher. */
	backupStopped?: { size: number; limit: number } | null;
	/** Windlass's memory was restored into a new sandbox, and it has not yet been told that the workspace is a fresh one. */
	freshWorkspace?: boolean;
	/** The timeline said once that text from someone else went to this session's agent as labelled text only (factory/untrusted.ts). */
	untrustedUnmarkedNoted?: boolean;
	/** Windlass said this session's conversation holds untrusted content (`taint.noticed`), and has not cleared it since. */
	tainted?: boolean;
	// Project server definitions from the most recent Windlass report.
	servers?: KnownServer[];
	/** When `servers`, or what is remembered of their approvals through this session, last changed. */
	serversChangedAt: number;
	// Clear only after setup completes. Missing means this clone needs no setup.
	setupDue?: string | null;
	// Include hosts allowed after the turn read the repository list.
	networkHosts?: string[];
	/** The blocked hosts the timeline named for the sandbox it has now: each is named once per sandbox (`noteBlockedHosts`). */
	hostsNoted?: string[];
	/** Lifetime totals and a monotone receipt for the item actor. */
	blocked?: { revision: number; network: BlockedNetwork };
	snapshotCommit?: string | null;
	cloneDirectory?: string;
	/** A cross-repo feature's planning turn put its other repositories' trees in the workspace (`planningInputs`). */
	planningInputs?: true;
	/** The setup run in progress, as its starting item has it. Still set when the actor wakes: the run was cut off with its server. */
	setupRunning?: { id: string; command: string; limitMs: number } | null;
	/** A setup run in the current sandbox that did not succeed, of which the agent has not been told yet. */
	setupUnfinished?: UnfinishedSetup | null;
	// Replacement checkouts run setup on the base before restoring the work branch.
	workDue?: { branch: string; at?: string; directory: string; setupBase?: string; setUp?: boolean } | null;
	/** The workspace was put on the session's branch after a setup run on the base, and the agent has not been told that its branch's dependencies were not installed by it. */
	setupOnBase?: { branch: string; base: string } | null;
	// A running stretch survives sleep until its hold is settled.
	meter?: OpenStretch | null;
	/** What the sandbox ran of holds that the user's actor has not been told yet: told again when the session is next awake. */
	unsettled?: HoldReport[];
	// Persist the pending request before sending it so a lost response can be retried with the same ID.
	meterAsked?: PendingAsk | null;
	// Cache the answer with acceptance so a retried key cannot enqueue another prompt.
	submissions?: Array<Submission & PromptAnswer>;
	/** Set for a work item's session: its turns come from the item's deliveries (session-inbox.ts), and no person prompts it. Absent: a person's. */
	origin?: SessionCreateInput["origin"];
	review?: ItemReview;
	reviewBase?: string;
	/** The run that owns this checkout. Late cleanup for an earlier run cannot free it. */
	reviewRun?: number;
	/** For a session on one of the user's machines: the machine's name at launch. */
	machineName: string | null;
	/** What the item's agent last filed with `report`: the pull request's title and description. */
	report?: (AgentReport & { run: number }) | null;
	// A paused turn resumes with the same turn number and accumulated running time.
	run?: TurnRun | null;
	/** Set for a session made to continue another (`continueSession`); `told` once its agent was told so (`platformNotes`). */
	continuedFrom?: ContinuedFrom & { told?: boolean };
	/** An account of the earlier session for the first turn whose agent does not remember it (`sessionHandoff`); cleared once told. */
	handoff?: Handoff | null;
	/** `windlassSessionId` is a copy of the earlier session's agent session: it becomes this session's only by a restore into a sandbox whose agent data is its own. */
	copiedSession?: boolean;
	/** On a machine: the earlier session's copy, copied to this session's name when its first sandbox is made (sandbox.ts). */
	pendingCopy?: MachineCopy;
}

/** What `prompt()` answers: the turn the message is in, and whether it was steered into one that ran. */
export type PromptAnswer = { turn: number; steered: boolean };

/** A question put to the user: the copy the clients see, and the ways to settle the layer's promise. */
export interface Asked {
	pending: PendingQuestion;
	/** Declines it for the platform when nobody answers. Unset while a server's question stands aside. */
	timer: ReturnType<typeof setTimeout> | undefined;
	/** Each settles the promise the layer waits on; only the first call of either does anything. */
	answer(answer: TurnAnswer): void;
	decline(note?: string): void;
	/** A question about a project's server only: shows it, the first time and again after it stood aside, with a new time to answer in. */
	put?(): void;
	/** A question about a project's server only: the definition it is about. */
	server?: { name: string; fingerprint: string };
}

/** How a question about a request of the agent's to publish ended. */
export type PublishAnswer =
	| { kind: "allowed"; how: "once" | "session" }
	/** `note` is what the user wrote for the agent. */
	| { kind: "declined"; note?: string }
	| { kind: "expired" }
	/** The call or the turn ended before anyone answered. */
	| { kind: "withdrawn" };

export interface ActiveTurn {
	credential?: TurnCredential;
	untrusted?: string[];
	/** The turn is being stopped so that it pauses instead of ending (`pauseTurn`): its server is going away, or its machine went. */
	pausing?: PauseReason;
	/** A segment that resumes a paused turn (`resumePaused`): why it paused, for how long, and what the person sent meanwhile. */
	resume?: { reason: PauseReason; pausedMs: number; held: string[] };
	finishNetwork?: () => Promise<void>;
	/** What the turn would need to be taken up again by a restarted server (`RunTurnInput.onCheckpoint`), read with each timeline write. */
	checkpoint?: () => TurnCheckpoint | null;
	/** A turn a restarted server takes up: its process goes on (`RunTurnInput.reattach`). */
	reattach?: TurnCheckpoint;
	planMode?: boolean;
	openAcp?: () => NewItem | null;
	/** A user choice queued for the next prompt takes precedence over this turn’s ACP updates. */
	modeQueued?: boolean;
	number: number;
	effort: string | null;
	controller: AbortController;
	done: Promise<void>;
	/** The layer's handle for steering the turn and stopping one call; null until Windlass has started it. */
	control: TurnControl | null;
	/** The question the turn waits on. It is held here and nowhere else: when the turn goes, so does it. */
	question: Asked | null;
	/** The questions of this turn whose promise the layer may still be waiting on. */
	unsettled: Set<Asked>;
	// Redisplay deferred server questions FIFO after the tool call releases the question slot.
	aside: Asked[];
	// Recalling an approval must not renew its timestamp.
	recalled: Map<string, ServerApproval>;
	/** True once the turn is being stopped: no question is put any more. */
	stopping: boolean;
	/** True once the turn is being closed: nothing of it can be steered, stopped or answered any more. */
	closed: boolean;
	// Plaintext secrets belong only to this in-memory turn.
	secrets: HeldSecrets | null;
	/** What Windlass's events say of this turn's checks (verified.ts). */
	checks: VerificationLog;
	/** True once the platform published or pushed for the agent in this turn: what it pushed had not been through the turn's checks. */
	published?: boolean;
	/** The agent's requests to publish or push that are being handled: the turn does not close under a push. */
	publishes: Set<Promise<string>>;
	/** True once the turn was stopped because its user's sandbox time for the day is used up: its sandbox is suspended when it has closed. */
	outOfTime?: boolean;
	// A push after pushedAtStart counts as work even when the agent left a clean tree.
	item?: {
		row: InboxRow & { slot: string };
		report: AgentReport | null;
		asked?: AgentAsk | null;
		full: number | null;
		machineAway?: MachineUnreachable["reason"];
		withdrawn?: boolean;
		started: boolean;
		crossRepoPlan?: boolean;
		planReview?: PlanReview;
		said?: string;
		pushedAtStart: string | null;
		policyRefusal?: true;
		refused?: string | null;
		untrustedRefusal?: UntrustedRefusal;
		providerRefusal?: ItemProviderRefusal;
		/** Stopped at the delivery's budget while it ran (budget-watch.ts): the item asks its budget question. */
		budgetStopped?: boolean;
		escaped?: string;
		sandboxFailed?: string;
		outOfMemory?: OutOfMemory;
	};
}

export interface HeldSecrets {
	requestedNames?: string[];
	/** Read before the turn had a number (the prompt's own row is redacted with them): what could not be opened, for the turn to tell once. */
	unopened: string[];
	snapshotSetup?: SealedSecrets["snapshotSetup"];
	environment?: SealedSecrets["environment"];
	screenshots: boolean;
	/** The repository's; none for a session that is not on a repository of the GitHub connection. */
	opened: OpenedSecret[];
	/** The account's, all of them: one whose name a secret of the repository has is not handed over (account-secrets.ts). */
	account: OpenedAccountSecret[];
	/** The user's own MCP servers, as Windlass's configuration takes them. */
	servers: TurnPersonalServer[];
	/** The checks the user saved for the session's repository (repository-checks.ts); none for a session that is not on one. */
	checks: RepositoryCheck[];
	/** The hosts its repository's network list allows (repository-network.ts); absent when the user's actor did not say. */
	network?: string[];
	/** When they were asked for: a host allowed from the session after this is not in them (`SessionVars.hostsAllowed`). */
	networkAt?: number;
	redactor: Redactor;
}

export interface SessionVars {
	savingSecret?: boolean;
	/** Null for an actor that `user` did not create: it rejects everything and removes itself. */
	meta: SessionMeta | null;
	/** A build session's result, once its setup and checks ran (`buildEnvironment`); reported when its turn has closed. */
	environmentResult?: EnvironmentBuildReport;
	nextSeq: number;
	/** Timeline items not yet in SQLite, in `seq` order. */
	unwritten: TimelineItem[];
	flushTimer: ReturnType<typeof setTimeout> | null;
	/** True while a write of the waiting items is queued and has not started. */
	flushQueued: boolean;
	/** The tail of the write queue. */
	serial: Promise<unknown>;
	pending: LiveDelta[];
	turn: ActiveTurn | null;
	/** True while `prompt` is deciding, so a second prompt cannot slip in between its awaits. */
	accepting: boolean;
	/** The prompts with a key that are being decided: another attempt of one of them ends as it does (submissions.ts). */
	attempts: Attempts<PromptAnswer>;
	/** Admission of the last ordinary ACP prompt, including follow-ups waiting for their own turns. */
	nextPrompt?: Promise<PromptAnswer>;
	destroying: boolean;
	/** True once the actor is going to sleep or being destroyed. */
	stopping: boolean;
	reporting: Promise<void> | null;
	reportAgain: boolean;
	/** Still closing this inbox row after the agent itself went idle. */
	closingItem?: string;
	/** A suspend or removal of the idle sandbox under way; a prompt or a read of the workspace waits for it. */
	idling: Promise<void> | null;
	// Idle cleanup waits for all operations on this sandbox, including reads and pushes.
	sandboxOps: number;
	/** The one check of named tests on the item’s base running in this sandbox. */
	baseTest?: string;
	/** The copy of the workspace taken when the last turn ended; undefined until it is read from SQLite. */
	workspace: WorkspaceCopy | null | undefined;
	/** The tail of the queue that sets the idle check, so two of them cannot cross. */
	arming: Promise<void>;
	/** True while the platform commits and pushes the workspace: no turn starts under it, and no second push. */
	publishing: boolean;
	/** The key of the delivery `takeDelivered` is taking, while it does: the same delivery sent again meanwhile leaves its slot alone. */
	delivering?: string | null;
	/** When GitHub was last asked about the session's pull request. */
	pullCheckedAt: number;
	/** Whether the workspace has commits GitHub lacks, as last read from the sandbox, and what it was read for. */
	unpushed: { key: string; value: boolean | null } | null;
	/** Fires when the running sandbox's hold is over, or when an unused sandbox would have stopped by itself (`armMeter`). */
	meterTimer: ReturnType<typeof setTimeout> | null;
	/** The tail of the queue of calls to the user's meter: a hold is traded or settled by one of them at a time. */
	metering: Promise<unknown>;
	// Unset until this instance reads the provider timeout.
	idleStopMs: number | null;
	// Reject a sandbox-state read when its generation changes while awaiting the provider.
	sandboxGen: number;
	// Compare the original use and generation before settling a stretch carried over a wake.
	carried: { use: string; gen: number } | null;
	// The runner socket belongs to this instance. A wake reconstructs its conversation.
	runner: RunnerLink | null;
	// Durable machine turns journal outgoing frames before sending them.
	journal: OutgoingJournal | null;
	restored: ConversationRecord | null;
	/** When the wake that takes a machine turn up after a crash was last scheduled (`armTakeUp`). */
	takeUpArmedAt: number;
	/** A concurrent grant waits for the current resume attempt before deciding who owns its slot. */
	resuming: Promise<void> | null;
	/** Re-arms the wake that resumes the running turn after a crash (`heartbeat`); null between turns. */
	heartbeat: ReturnType<typeof setInterval> | null;
	/** The stop of a setup cut off with the server (`stopCutOffSetup`): a turn waits for it before it uses the sandbox. */
	setupReap: Promise<void> | null;
	/** The running turn's start clock (start-times.ts), which `openSandbox` tells when the sandbox and the workspace are ready. */
	startClock: StartClock | null;
	// Preserve concurrent allowHost additions newer than the turn's network list.
	hostsAllowed: Map<string, number>;
}

/** What the helpers below need of an actor context; every hook's and action's `c` fits. */
export interface Ctx {
	vars: SessionVars;
	db: RawAccess;
	key: string[];
	log: { info(entry: unknown): void; warn(entry: unknown): void; error(entry: unknown): void };
	broadcast(name: string, ...args: unknown[]): void;
	// biome-ignore lint/suspicious/noExplicitAny: the registry's type would be circular here
	client(): any;
	keepAwake<T>(promise: Promise<T>): Promise<T>;
	schedule: {
		at(timestamp: number, action: string, ...args: unknown[]): Promise<string>;
		cancel(id: string): Promise<boolean>;
	};
}

export type NewItem =
	| Omit<NetworkBlockedItem, "seq" | "at">
	| Omit<Extract<TimelineItem, { kind: "user" }>, "seq" | "at">
	| Omit<Extract<TimelineItem, { kind: "platform" }>, "seq" | "at">
	| Omit<Extract<TimelineItem, { kind: "acp" }>, "seq" | "at">
	| Omit<Extract<TimelineItem, { kind: "windlass" }>, "seq" | "at">
	| Omit<Extract<TimelineItem, { kind: "setup" }>, "seq" | "at">
	| Omit<Extract<TimelineItem, { kind: "turn.ended" }>, "seq" | "at">;

/** The changed files of the workspace and their diff, as they were when it was last read. */
export interface WorkspaceCopy {
	files: WorkspaceFile[];
	diff: string;
}
