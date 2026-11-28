// The phases of one session turn, in the order `executeTurn` (agent-session.ts) runs them.
// Each phase takes the turn's `TurnScope`: its constants and the locals later phases read again.
// Session actions interleave at every await, so each phase keeps the original order of its awaits and state writes.
import { SETUP_TURN_MS } from "../user-readiness.js";
import { isGuide } from "../../repo-setup/guide-check.js";
import { SetupPhase } from "../../repo-setup/phase.js";
import { REVIEW_MS, PUBLISH_MS, reviewSetup } from "../../repo-setup/review.js";
import { publishSetup, type SetupTurn } from "../../repo-setup/publish.js";
import { privateLine, type AcceptedDraft } from "../../repo-setup/filing.js";
import { openNote } from "../../repo-setup/notes.js";
import { fileReadiness } from "../../factory/readiness-filing.js";
import { setTimeout as delay } from "node:timers/promises";
import { UserError } from "rivetkit";
import { oldSandbox } from "../../agent-publish.js";
import { describeError, isSandboxUserError } from "../../auth.js";
import { config } from "../../config.js";
import {
	generatedSessionTitle,
	type ReviewRecord,
	type RepositoryCheck,
	type TurnOutcome,
	type TurnUsage,
	type Verified,
	type ModelKeySpend,
	largerHostedSize,
	type HostedSize,
	outOfMemoryWords,
	type CredentialRef,
	type ModelList,
	isPlanProvider,
	type PlanProvider,
	type RelaySeen,
} from "../../contract.js";
import { billing } from "../../billing/config.js";
import { GithubError, githubApp, type InstallationToken } from "../../github/app.js";
import { gitlabApp } from "../../gitlab/connect.js";
import { changedReviewPaths, checkoutReview, readOnlyReview } from "../../github/git.js";
import { INPUTS_DIRECTORY } from "../../factory/cross-repo.js";
import { GithubProblem, problemOf, resolveBoundRepository } from "../../github/repos.js";
import type {
	OutOfMemory,
	RunTurnInput,
	RunTurnResult,
	SandboxHandle,
	SandboxLayer,
	TurnCheckpoint,
} from "../../sandbox/api.js";
import { MachineUnreachable, type machineActor } from "../../sandbox/runner-layer.js";
import { accountSecretsFor, accountSecretsNote, turnEnvironment } from "../../account-secrets.js";
import { unaskedNote } from "../../personal-servers.js";
import { type Redactor, MAX_SECRET_REQUESTS, secretRequestLimit, commandSandbox } from "../../repo-secrets.js";
import { projectOf } from "../../server-approvals.js";
import {
	type ServerQuestionContext,
	serverApprovedNote,
	serverRecalledNote,
	unsetRemedy,
} from "../../server-question.js";
import { setupProjectOf } from "../../setup-command.js";
import { VerificationLog, groupReviewPaths } from "../../verified.js";
import { turnTokens } from "../../factory/budget.js";
import { reportedModelUsage, usesPlatformModel } from "../../usage.js";
import { PlatformChecks } from "../../sandbox/platform-checks.js";
import { type Handoff, itemActor, modelKeyActor, secretsActor, userActor } from "../internal.js";
import { openSavedCredential } from "../../credentials/transit.js";
import { attachmentStore, uploadShots } from "../../sandbox/attach.js";
import { REPORT_TAKEN, askPerson, requestSecret, secretRequestNotice } from "../../agent-publish.js";
import { RULES } from "../../factory/blueprint.js";
import { DATA_DIR } from "../../sandbox/provider.js";
import { planReviewOf } from "../../factory/autonomy.js";
import { reviewerTask } from "../../factory/reviewer-task.js";
import { accountKey, accountLocation, type AccountLocation } from "../provider-accounts.js";
import { resetTime, type LimitEvent, type UsageObservation } from "../../provider-usage.js";
import {
	type ProviderRefusal,
	limitObservation,
	publicUsageEvent,
	refusalMessage,
	stepRefusal,
	turnRefusal,
} from "../../provider-refusal.js";
import { sources, untrustedTurn, unmarkedNote } from "../../factory/untrusted.js";
import { earlierContext, fileReport, fileReview, NO_REPO_SHOTS, ReviewCommands } from "../../factory/review.js";
import { DeploymentFull, ENVIRONMENT_SLOT_WAIT, PLATFORM_RESTART, sandboxConnectionLost } from "../../sandbox/api.js";
import { StartClock, keepStartTimes, startTimesLog } from "../../start-times.js";
import { SANDBOX_ESCAPE_REFUSED } from "../../sandbox/codex-modes.js";
import {
	harnessName,
	itemModeOf,
	itemSignInChanged,
	itemSignInMessage,
	machineHarness,
	machineHarnesses,
	withSettingsKeys,
} from "../../sandbox/harnesses.js";
import { stepLimitNote } from "../../sandbox/platform-steps.js";
import { capabilitiesOf, harnessOf } from "../../sandbox/harness.js";
import { privateSessionData } from "../../sandbox/session-data.js";
import { sessionRepository } from "../../github/publish.js";
import { type TurnRun, type TurnCredential, addUsage, restartShellResult, segmentLimit } from "../turn-resume.js";
import { ConversationLost } from "../../runner/channel.js";
import { type InboxRow, itemTurnText, sendOutbox, waitingRows } from "../session-inbox.js";
import { persist, note, append, serial, writeItems, acpRecorder, onWindlassEvent, writeMeta } from "./timeline.js";
import {
	str,
	duration,
	abortTurn,
	askQuestion,
	askServer,
	serverKey,
	ago,
	rememberServer,
	knowServers,
	sealTurn,
} from "./questions.js";
import type { Ctx, SessionMeta, ActiveTurn, HeldSecrets } from "./state.js";
import { runnerLink, layerOf, machineOf } from "./runner.js";
import { publish } from "./summary.js";
import { platformNotes, saveBackup, dropWorkspace } from "./workspace.js";
import { shellQuote } from "../../util.js";
import {
	tail,
	TurnProblem,
	githubConnection,
	ReviewRefused,
	GitAccessRefused,
	itemPrompt,
	within,
	PlanWaitError,
} from "./common.js";
import { BudgetWatch, budgetStopNote } from "./budget-watch.js";
import { readSecrets } from "./secrets.js";
import { usesScreenshotImage } from "./setup.js";
import { metered, takeHold, removeSandbox, noteSandbox, closeMeter, useOf, meterAfterTurn, armIdle } from "./meter.js";
import { openSandbox, destroySessionSandboxes, copyWorkspace, refreshSandbox } from "./sandbox.js";
import { agentPush, agentFetchBase, agentPublish, unpushedWork } from "./publish.js";
import { heartbeat, wholeTask, pauseTurn } from "./pause.js";

/** How long one turn may run before the platform stops it. WLP_TURN_TIMEOUT_MS overrides it. */
const TURN_TIMEOUT_MS = config.turnTimeoutMs;
/** How long the end of a turn waits for the `user` actor to take the new summary. */
const REPORT_WAIT_MS = 5_000;
export const SIGN_IN_REMEDY = "Sign in with ChatGPT again, then send the prompt once more.";
const WINDLASS_OUTCOMES: readonly TurnOutcome[] = ["succeeded", "unresolved", "failed", "stopped", "interrupted"];

export type MachineFacts = import("../machine.js").MachineFacts;
export type OfferedHarness = NonNullable<NonNullable<MachineFacts["report"]>["harnesses"]>[number];
type Item = NonNullable<ActiveTurn["item"]>;
type Handling = ReturnType<typeof untrustedTurn>;

export type ItemTurnEnd = {
	outcome: TurnOutcome;
	itemSignIn: TurnCredential["itemSignIn"];
	/** What the turn ran on and who paid (null where it never got that far): for its cost. */
	credential: TurnCredential | null;
	stepLimit?: number;
	verified: Verified | null;
	used: SandboxHandle | null;
	unpushed: boolean | null;
	usage: TurnUsage | null;
	checks: RepositoryCheck[];
	acp?: RunTurnResult["acp"];
};

/** What the turn needs of agent-session.ts, which a module here must not import. */
export interface TurnHooks {
	turnCredential(
		c: Ctx,
		meta: SessionMeta,
		offered: OfferedHarness | undefined,
		model: string,
		signal?: AbortSignal,
		pinned?: TurnCredential,
		keyOnce?: boolean,
	): Promise<TurnCredential>;
	takeTurnRequest(c: Ctx, meta: SessionMeta, run: TurnRun, active: ActiveTurn): Promise<boolean>;
	itemTurnStarted(
		c: Ctx,
		meta: SessionMeta,
		item: Item,
		sandbox: SandboxHandle,
		turn: number,
		credential: TurnCredential,
		effort: string | null,
	): Promise<void>;
	itemTurnEnded(c: Ctx, meta: SessionMeta, item: Item, ended: ItemTurnEnd): Promise<void>;
	describeAfterTurn(c: Ctx, meta: SessionMeta, sandbox: SandboxHandle, turn: number): Promise<void>;
	askForSlot(c: Ctx, meta: SessionMeta, row: InboxRow, deploymentFull?: number | null): Promise<void>;
}

/** One turn's constants and the locals that cross its phases. Phases mutate it; none copies a field a later phase reads again. */
export interface TurnScope {
	readonly meta: SessionMeta;
	readonly active: ActiveTurn;
	readonly hooks: TurnHooks;
	readonly machine: ReturnType<typeof machineActor> | null;
	readonly startedAt: number;
	readonly turn: number;
	readonly effort: string | null;
	readonly mode: string | undefined;
	readonly reviewer: boolean;
	readonly checkout: Item["row"]["checkout"] | undefined;
	readonly requested: NonNullable<Item["row"]["checkout"]>["requested"] | undefined;
	readonly critic: boolean;
	/** The prompt the agent is given: resume and review preparation rewrite it. */
	text: string;
	// Apply the same untrusted-source policy to an original prompt and its resume fallback.
	untrusted: string[];
	outsideText: boolean;
	handling: Handling;
	readonly signal: AbortSignal;
	/** The turn's own record (WLP_TURN_RESUME): its segments, its limit across pauses, and what pausing it needs. */
	readonly run: TurnRun | null;
	/** The runner conversation's losses when the agent started (`ServerChannel.losses`): more at its end, and the machine went away mid-turn. */
	lossesAtStart: number | null;
	readonly setupPhase: SetupPhase | null;
	setupStage: "agent" | "publish" | "record";
	agentStarted: boolean;
	thrown: unknown;
	/** What a resumed turn's agent is given instead of its "carry on" should its saved session be gone after all. */
	fresh: RunTurnInput["fresh"];
	resumed: string | null;
	layer: SandboxLayer | null;
	result: RunTurnResult | null;
	problem: string | null;
	lastStepRefusal: ProviderRefusal | null;
	readonly account: AccountLocation;
	generation: string | null;
	itemSignIn: TurnCredential["itemSignIn"];
	credential: TurnCredential | null;
	// Coalesce successive readings by window while an actor write is in flight.
	readonly pendingLimits: Map<string, LimitEvent>;
	writingLimits: Promise<void> | null;
	readonly acpTimeline: ReturnType<typeof acpRecorder>;
	events: number;
	/** False once the turn is closed: late callbacks from the agent are ignored. */
	open: boolean;
	/** An item's turn with a budget: its spend so far, measured to stop it there (budget-watch.ts). */
	watch: BudgetWatch | null;
	used: SandboxHandle | null;
	/** While `openSandbox` runs: an error then is the sandbox's, not the agent's (`sandboxFailed`). */
	opening: boolean;
	/** When the turn's limit stops it, ms since the epoch: set when its clock starts. */
	turnEndsAt: number;
	/** `TurnSandbox.memoryEvents` when the sandbox was opened. */
	memoryAtStart: { oomKills: number; totalMiB: number } | null;
	readonly turnBegan: number;
	/** The meter's use when the turn ended (`meterAfterTurn`). */
	meterUse: string | null;
	// A turn that never ends would hold its sandbox, and one of the user's running slots, for ever.
	limit: ReturnType<typeof setTimeout> | undefined;
	clock: StartClock | null;
}

/** The turn's sandbox and what was decided about it before the agent's input is built. */
interface OpenedTurn {
	layer: SandboxLayer;
	sandbox: SandboxHandle;
	credential: TurnCredential;
	takeRequest: (() => Promise<boolean>) | undefined;
	harness: ReturnType<typeof harnessOf>;
	caps: Awaited<ReturnType<ReturnType<typeof harnessOf>["capabilities"]>>;
	profile: ReturnType<SandboxLayer["sandboxes"]["profile"]>;
	platformTool: (tool: OpenedTurn["caps"]["platformTools"][number]) => boolean;
	summary: boolean;
}

/** Everything the agent's launch is built from: the input common to both harness kinds and the platform tools' handlers. */
export interface TurnLaunch extends OpenedTurn {
	common: RunTurnInput;
	item: ActiveTurn["item"];
	held: HeldSecrets;
	planning: boolean;
	planner: boolean;
	notes: ReturnType<typeof platformNotes>;
	store: ReturnType<typeof attachmentStore>;
	browser: boolean;
	unavailable: string;
	/** Report and review filings, chained so they run one at a time. */
	filings: { chain: Promise<string> };
	setup: SessionMeta["readiness"];
	repoTools: boolean;
	screenshots: boolean;
	listed: ReviewRecord[];
	commands: ReviewCommands;
	uiChanged: boolean;
	filingFiles: (() => { read(path: string, sha: string): Promise<string>; close(): Promise<void> }) | null;
	storedBrief: string | null;
	setupTurn: SetupTurn | undefined;
	accepted: AcceptedDraft | undefined;
	onReport: RunTurnInput["onReport"];
	onRequestSecret: RunTurnInput["onRequestSecret"];
	onAsk: RunTurnInput["onAsk"];
	onPush: RunTurnInput["onPush"];
	onFetchBase: RunTurnInput["onFetchBase"];
	onReview: RunTurnInput["onReview"];
}

export function newTurnScope(
	c: Ctx,
	meta: SessionMeta,
	active: ActiveTurn,
	text: string,
	machine: ReturnType<typeof machineActor> | null,
	hooks: TurnHooks,
): TurnScope {
	const startedAt = Date.now();
	const turn = active.number;
	const effort = active.effort;
	// A work item keeps its profile's approval (Windlass), or its agent's mode for the profile that never asks (harnesses.ts, `itemModes`).
	const mode = meta.origin ? itemModeOf(meta.harness, meta.profile) : meta.mode;
	const reviewer = meta.origin?.role === "reviewer";
	const checkout = active.item?.row.checkout;
	const requested = checkout?.requested;
	const critic = reviewer && active.item?.row.agent === "critic";
	const untrusted = active.item?.row.untrusted ?? active.untrusted ?? meta.run?.untrusted ?? [];
	const outsideText = untrusted.length > 0 || !!active.item?.row.fresh?.untrusted.length;
	const handling = untrustedTurn({
		agent: meta.harness ?? "windlass",
		profile: meta.profile,
		untrusted,
		unsandboxed: active.item?.row.unsandboxed,
	});
	const signal = active.controller.signal;
	const run = meta.run?.turn === turn ? meta.run : null;
	// Reattached runner channels can lose their grace period during slot acquisition.
	const lossesAtStart: number | null = active.reattach ? 0 : null;
	const setupPhase = meta.readiness?.draft
		? new SetupPhase(meta.model, s => active.secrets?.redactor.text(s) ?? s)
		: null;
	const resumed = meta.windlassSessionId;
	const account: AccountLocation = {
		place: meta.place.kind === "machine" ? meta.place.machineId : "hosted",
		harness: meta.harness ?? ("windlass" as const),
	};
	const itemSignIn = run?.credential?.itemSignIn ?? meta.origin?.signIn;
	const pendingLimits = new Map<string, LimitEvent>();
	const acpTimeline = acpRecorder(c, turn);
	const turnEndsAt = Date.now() + TURN_TIMEOUT_MS;
	const turnBegan = Date.now();
	return {
		meta,
		active,
		hooks,
		machine,
		startedAt,
		turn,
		effort,
		mode,
		reviewer,
		checkout,
		requested,
		critic,
		text,
		untrusted,
		outsideText,
		handling,
		signal,
		run,
		lossesAtStart,
		setupPhase,
		setupStage: "agent",
		agentStarted: false,
		thrown: null,
		fresh: undefined,
		resumed,
		layer: null,
		result: null,
		problem: null,
		lastStepRefusal: null,
		account,
		generation: null,
		itemSignIn,
		credential: run?.credential ?? null,
		pendingLimits,
		writingLimits: null,
		acpTimeline,
		events: 0,
		open: true,
		watch: null,
		used: null,
		opening: false,
		turnEndsAt,
		memoryAtStart: null,
		turnBegan,
		meterUse: null,
		limit: undefined,
		clock: null,
	};
}

/** Refuses the turn on "Docker, hardened" for someone else's text in `retryText`; the item asks, and can run it anyway. */
function refuseUntrusted(
	c: Ctx,
	t: TurnScope,
	item: ActiveTurn["item"],
	stop: Extract<Handling, { kind: "stop" }>,
	retryText: string,
): never {
	if (!item) {
		const reason = `The GitHub feedback prompt was not run because commands run directly in the sandbox and the prompt contains ${stop.sources.join(", ")}. You can review the feedback and send your own instructions.`;
		note(c, t.turn, "warn", reason);
		throw new TurnProblem(reason);
	}
	item.refused = stop.reason;
	item.untrustedRefusal = {
		sources: stop.sources,
		retry: { text: retryText, fetchBase: item.row.fetchBase, untrusted: t.untrusted },
	};
	throw new TurnProblem(stop.reason);
}

function unmarked(c: Ctx, t: TurnScope, text: string) {
	if (t.meta.untrustedUnmarkedNoted) return;
	t.meta.untrustedUnmarkedNoted = true;
	note(c, t.turn, "warn", text);
	void persist(c);
}

/** Told the first time the agent says anything: from then on a resume continues its conversation of this turn. */
function prompted(c: Ctx, t: TurnScope) {
	if (!t.run || t.run.prompted) return;
	t.run.prompted = true;
	void persist(c);
}

async function observe(c: Ctx, t: TurnScope, observation: UsageObservation) {
	if (t.generation !== null)
		await userActor(c, t.meta.uid)
			.internalObserveUsage(t.account, t.generation, observation)
			.catch(() => c.log.warn({ msg: "Could not record provider usage" }));
}

function recordLimit(c: Ctx, t: TurnScope, event: LimitEvent) {
	if (event.status === "rejected" || t.pendingLimits.get(event.window.kind)?.status !== "rejected")
		t.pendingLimits.set(event.window.kind, event);
	t.writingLimits ??= (async () => {
		while (t.pendingLimits.size) {
			const next = t.pendingLimits.values().next().value!;
			t.pendingLimits.delete(next.window.kind);
			await observe(c, t, { kind: "event", event: next });
		}
		t.writingLimits = null;
	})();
}

/** A request of the agent's to publish or push, kept until it is handled: the turn does not close under it. */
function tracked(t: TurnScope, work: Promise<string>): Promise<string> {
	t.active.publishes.add(work);
	void work.finally(() => t.active.publishes.delete(work));
	return work;
}

function itemSignInRefusal(
	meta: SessionMeta,
	facts: MachineFacts,
	offered: OfferedHarness | undefined,
	credential: TurnCredential,
) {
	const machine = machineHarness(meta.harness);
	// A plan or a key pays: the machine's own sign-in is not asked for.
	if (!machine || !facts.report || credential.key) return null;
	if (!offered) return `This machine does not offer ${machine.name}.`;
	const effective = withSettingsKeys(offered, []);
	return (
		itemSignInMessage(machine, facts.name, effective.signIn) ??
		itemSignInChanged(machine, facts.name, credential.itemSignIn ?? meta.origin?.signIn, effective.method)
	);
}

function usageOf(value: unknown): TurnUsage | null {
	if (typeof value !== "object" || value === null) return null;
	const { inputTokens, cachedInputTokens, outputTokens, reasoningTokens } = value as Record<string, unknown>;
	if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;
	return {
		inputTokens,
		cachedInputTokens: typeof cachedInputTokens === "number" ? cachedInputTokens : 0,
		outputTokens,
		reasoningTokens: typeof reasoningTokens === "number" ? reasoningTokens : 0,
	};
}

/** Why Windlass produced no result, from its exit code (see its user guide, "Exit codes") and stderr. */
function failureMessage(result: RunTurnResult): string {
	const said = tail(result.stderrTail ?? "");
	let what: string;
	if (result.timedOut) what = "Windlass ran past the time limit and was stopped";
	else if (result.exitCode === null) what = "Windlass was killed before it finished";
	else if (result.exitCode === 2)
		what = "Windlass refused to start (exit code 2: an option, the model or the session was not accepted)";
	else if (result.exitCode === 0) what = "Windlass ended without reporting a result";
	else what = `Windlass ended without a result (exit code ${result.exitCode})`;
	return said ? `${what}:\n${said}` : `${what}.`;
}

/** The turn's start clock: at the first output (or the turn's end) it keeps the record on the session, shows it, and logs it. */
function startClock(c: Ctx, meta: SessionMeta, turn: number, waited: number | null): StartClock {
	const place = meta.profile.startsWith("e2b") ? "e2b" : meta.place.kind === "machine" ? "machine" : "hosted";
	return new StartClock(turn, meta.harness ?? "windlass", place, waited, times => {
		meta.startTimes = keepStartTimes(meta.startTimes, times);
		console.log(startTimesLog(meta.sessionId, times));
		publish(c);
		void persist(c);
	});
}

async function resizeOptions(c: Ctx, meta: SessionMeta, layer: SandboxLayer): Promise<HostedSize[]> {
	if (meta.place.kind === "hosted" && billing(meta.uid)) return userActor(c, meta.uid).internalHostedSizes();
	return layer.sandboxes.sizes?.().map(size => size.id) ?? [];
}

function withLarger(memory: OutOfMemory, offered: HostedSize[]): OutOfMemory {
	return { ...memory, larger: largerHostedSize(memory.size ?? "large", offered) ?? undefined };
}

/** Compare the sandbox's own kill counts over the turn. A silent E2B guest can also be diagnosed from its provider's samples. */
export async function noteTurnMemory(
	c: Ctx,
	meta: SessionMeta,
	active: ActiveTurn,
	sandbox: SandboxHandle,
	start: { oomKills: number; totalMiB: number } | null,
	began: number,
	turn: number,
): Promise<void> {
	if (!start) return;
	try {
		const end = await sandbox.memoryEvents?.().catch(() => null);
		const killed = end ? end.oomKills - start.oomKills : 0;
		if (end && killed <= 0) return;
		const peak = (await sandbox.memoryPeak?.(began).catch(() => null)) ?? null;
		if (peak === null && !end) return;
		const hosted = meta.place.kind === "hosted";
		const memory: OutOfMemory = peak ?? {
			usedMiB: end!.totalMiB,
			totalMiB: end!.totalMiB,
			...(hosted && meta.hostedSize && { size: meta.hostedSize }),
		};
		const layer = hosted ? await layerOf(c, meta) : null;
		const offered = layer ? await resizeOptions(c, meta, layer) : undefined;
		const what = end
			? ` Its kernel stopped ${killed === 1 ? "a program" : `${killed} programs`} to free memory during this turn: a command that ended with "Killed" or exit code 137 was one of them.`
			: " It stopped answering commands.";
		note(c, turn, "warn", `${outOfMemoryWords(memory, offered, meta.place.kind)}${what}`);
		const allocation = hosted ? `size=${meta.hostedSize ?? "small"} used=${memory.usedMiB}` : "place=machine";
		console.log(
			`[wlp] sandbox.out_of_memory session=${meta.sessionId} turn=${turn} ${allocation} total=${memory.totalMiB} killed=${killed}`,
		);
		if (active.item) active.item.outOfMemory = offered ? withLarger(memory, offered) : memory;
		// Its next connect finds it silent and restarts it: the item has been told of this sandbox's memory already.
		meta.memoryNoted = sandbox.id;
	} catch (error) {
		c.log.warn({ msg: "could not read the sandbox's memory at the turn's end", error: String(error) });
	}
}

/**
 * Pay with held an item's turn for its plan after the queue had let it start (the plan was limited meanwhile): the item
 * waits for the plan's reset as after a usage-limit refusal (blueprint.ts `askProviderRefusal`), and asks where none is known.
 */
function planWait(meta: SessionMeta, item: ActiveTurn["item"], wait: PlanWaitError): never {
	if (item) {
		const { text, fetchBase, untrusted } = item.row;
		item.providerRefusal = {
			kind: "usage_limit",
			message: wait.message,
			...(wait.retryAt !== null && { resetsAt: wait.retryAt }),
			placeName: placeNameOf(meta),
			retry: { text, fetchBase, ...(untrusted.length && { untrusted }) },
		};
	}
	throw new TurnProblem(wait.message);
}

/** Where the session runs, as an item's refusal names it. */
export function placeNameOf(meta: Pick<SessionMeta, "place" | "machineName">): string | undefined {
	return meta.place.kind === "hosted" ? "hosted" : (meta.machineName ?? undefined);
}

function refuseItemPolicy(item: ActiveTurn["item"], reason: string): never {
	if (item) {
		item.refused = reason;
		item.policyRefusal = true;
	}
	throw new TurnProblem(reason);
}

function secretRequestHandler(
	c: Ctx,
	meta: SessionMeta,
	turn: number,
	item: ActiveTurn["item"],
	redactor: Redactor,
	acp: boolean,
	isOpen: () => boolean,
): NonNullable<RunTurnInput["onRequestSecret"]> {
	return async (request, withdrawn) => {
		const refuse = async (message: string) => {
			const scope = item ? item.row.key.split(":").slice(0, 2).join(":") : "session";
			if (meta.secretRefusalRun !== scope) {
				meta.secretRefusalRun = scope;
				note(c, turn, "warn", "A secret request was refused.");
				await persist(c);
			}
			return message;
		};
		const validate = () =>
			requestSecret(
				request.arguments,
				!!item?.asked || !!meta.secretRequest,
				!!meta.secretRequestBlocked || !!meta.tainted,
				redactor,
			);
		if (!isOpen() || withdrawn.aborted) return "The call ended. Nothing was recorded.";
		const taken = validate();
		const name = taken.request?.name ?? "";
		let problem: string | null;
		try {
			if (item) {
				problem = await itemActor(c, meta.uid, item.row.itemId).internalSecretRequestLimit(item.row.key, name);
			} else {
				const attempts = meta.secretAsks ?? 0;
				problem = secretRequestLimit(name, attempts, meta.declinedSecrets ?? [], "session");
				if (attempts < MAX_SECRET_REQUESTS) {
					meta.secretAsks = attempts + 1;
					await writeMeta(c, meta);
				}
			}
			if (!problem && !taken.request) problem = taken.told;
			if (!problem)
				problem = await secretsActor(c, meta.uid, meta.sessionId).internalRequestedSecretConflict(meta.sessionId, name);
		} catch {
			problem = "The platform could not check this secret request. Try again.";
		}
		if (!isOpen() || withdrawn.aborted) return "The call ended. Nothing was recorded.";
		if (problem) return refuse(problem);
		// Another tool call or a third-party event may have landed during the lookups.
		const current = validate();
		if (!current.request) return refuse(current.told);
		const notice = secretRequestNotice(acp, !setupProjectOf(meta));
		const secretRequest = { ...current.request, notice, id: String(turn) };
		meta.secretRequest = secretRequest;
		append(c, {
			turn,
			kind: "platform",
			level: "info",
			text: `A secret was requested for ${name}.\n${notice}`,
			secretRequest,
		});
		await persist(c);
		return current.told;
	};
}

/** Saves the turn, waits for the machine's turn slot, then starts the turn's clock and its time limit. */
export async function startTurn(c: Ctx, t: TurnScope): Promise<void> {
	const { meta, machine, signal, turn, run, active } = t;
	await persist(c);
	const waiting = Date.now();
	if (machine && meta.place.kind === "machine") {
		let announced = false;
		for (;;) {
			signal.throwIfAborted();
			const slot = await machine.turnSlot(meta.sessionId, turn, meta.size ?? meta.origin?.size ?? 1);
			signal.throwIfAborted();
			if (slot.state === "granted") break;
			if (slot.state === "unsupported") throw new TurnProblem("This runner does not support sizing beyond one slot.");
			if (slot.state === "offline" || slot.state === "removed")
				throw runnerLink(c, meta.place.machineId).away(slot.state);
			if (!announced && slot.state === "waiting") {
				const size = slot.size ?? 1;
				const waiting = slot.behind
					? "Waiting behind an earlier turn"
					: `Waiting for ${size} free slot${size === 1 ? "" : "s"}`;
				const free = slot.max === null ? "" : `; ${Math.max(0, slot.max - slot.busy)} of ${slot.max} free`;
				note(c, turn, "info", `${waiting} on ${meta.machineName ? `‘${meta.machineName}’` : "your machine"}${free}.`);
				announced = true;
			}
			await delay(1000, undefined, { signal });
		}
	}
	t.clock = c.vars.startClock = startClock(c, meta, turn, machine ? Date.now() - waiting : null);
	// A resumed turn has what is left of its limit, never less than the floor: the time it was paused does not count.
	const draftBudget = meta.readiness?.draft?.answers ? Math.min(SETUP_TURN_MS, REVIEW_MS) : SETUP_TURN_MS;
	const turnBudget = meta.readiness?.draft
		? draftBudget + REVIEW_MS + PUBLISH_MS
		: meta.readiness
			? SETUP_TURN_MS
			: TURN_TIMEOUT_MS;
	const limitMs = segmentLimit(turnBudget, config.turnResume.floorMs, run);
	if (run) {
		run.segmentAt = Date.now();
		heartbeat(c, true);
	}
	// The deadline the sandbox is told (the turn-deadline hook) is this segment's: what is left, with the floor.
	t.turnEndsAt = Date.now() + limitMs;
	t.limit = setTimeout(() => {
		if (!t.open) return;
		const ran =
			run && run.resumes > 0
				? `This turn ran for ${duration(run.activeMs + limitMs)}, not counting the time it was paused; the limit is ${duration(turnBudget)}, so it was stopped.`
				: `This turn ran for ${duration(turnBudget)}, which is the limit, so it was stopped.`;
		note(c, turn, "warn", ran);
		if (meta.environmentBuild)
			c.vars.environmentResult ??= {
				finishedAt: Date.now(),
				commit: "",
				image: "",
				checks: [],
				snapshot: false,
				failure: { kind: "setup", check: null, line: "The build ran out of time.", excerpt: "" },
			};
		abortTurn(c, meta, active);
	}, limitMs);
}

/** The turn used its item's budget while it ran (budget-watch.ts): it stops as a person's Stop would, its work kept. */
function stopAtBudget(c: Ctx, t: TurnScope, running: number, figure: string): void {
	const { meta, active } = t;
	if (!t.open || active.closed || active.stopping || !active.item) return;
	active.item.budgetStopped = true;
	note(c, active.number, "warn", budgetStopNote(harnessName(meta.harness)));
	console.log(
		`[wlp] factory.budget_stop session=${meta.sessionId} turn=${active.number} figure=${figure} used=${running}`,
	);
	abortTurn(c, meta, active);
}

/** Picks the turn's model credential and refuses, before secrets or the sandbox, what the turn must not run. */
export async function takeCredential(
	c: Ctx,
	t: TurnScope,
): Promise<{ layer: SandboxLayer; credential: TurnCredential; takeRequest: OpenedTurn["takeRequest"] }> {
	const { meta, active, signal, run } = t;
	const layer = (t.layer = await layerOf(c, meta));
	// A person's turn is checked when it is sent; nobody sends an item's. Refused before the sandbox opens: the item asks, with the login hint.
	// Only a machine agent's turn reads what the runner offers; Windlass's does not.
	const facts =
		meta.place.kind === "machine" && machineHarness(meta.harness)
			? await runnerLink(c, meta.place.machineId).facts()
			: null;
	const offered = facts?.report?.harnesses?.find(h => h.id === meta.harness);
	const credential =
		active.credential ??
		(await t.hooks.turnCredential(c, meta, offered, meta.model, signal, run?.credential, false).catch(error => {
			if (error instanceof PlanWaitError) return planWait(meta, active.item, error);
			if (!(error instanceof UserError) || !["harness_signed_out", "chatgpt_required"].includes(String(error.code)))
				throw error;
			return refuseItemPolicy(active.item, error.message);
		}));
	const { key } = credential;
	t.itemSignIn = credential.itemSignIn ?? meta.origin?.signIn;
	t.credential = credential;
	// The blueprint's budget for this turn: its spend is watched from here, to stop it there (#100a).
	const budget = active.item?.row.budget;
	if (budget && active.item && !t.watch)
		t.watch = new BudgetWatch({
			budget,
			harness: meta.harness ?? "windlass",
			credential,
			itemSignIn: t.itemSignIn,
			earlier: run?.usage ?? null,
			onOver: (running, figure) => stopAtBudget(c, t, running, figure),
		});
	if (run) {
		run.credential = credential;
		if (key && meta.place.kind === "hosted") run.remainingRequests ??= config.modelRelay.turnRequests;
		await writeMeta(c, meta);
	}
	const takeRequest =
		run?.remainingRequests !== undefined ? () => t.hooks.takeTurnRequest(c, meta, run, active) : undefined;
	const signedOut = active.item && facts ? itemSignInRefusal(meta, facts, offered, credential) : null;
	if (signedOut) refuseItemPolicy(active.item, signedOut);
	// Refuse unsafe outside text before acquiring secrets or opening the sandbox.
	if (t.handling.kind === "stop") refuseUntrusted(c, t, active.item, t.handling, active.item?.row.text ?? t.text);
	return { layer, credential, takeRequest };
}

/** Opens the turn's secrets and its sandbox. An environment build's turn ends here (it throws). */
export async function openTurnSandbox(c: Ctx, t: TurnScope, layer: SandboxLayer): Promise<SandboxHandle> {
	const { meta, active, turn, signal, run, requested } = t;
	// Before anything is started: the setup command and Windlass are handed them, and what either says is shown without them.
	active.secrets ??= await readSecrets(c, meta, turn);
	for (const text of active.secrets.unopened.splice(0)) note(c, turn, "warn", text);
	t.opening = true;
	const sandbox = await openSandbox(c, meta, turn, signal, layer, active.secrets, !requested && !meta.readiness);
	t.opening = false;
	t.clock!.opened();
	// A build's turn ends here: it starts no agent (`buildEnvironment` ran in the setup).
	if (meta.environmentBuild) {
		c.vars.environmentResult ??= signal.aborted
			? { interrupted: true }
			: {
					finishedAt: Date.now(),
					commit: "",
					image: sandbox.image ?? "",
					checks: [],
					snapshot: false,
					failure: {
						kind: meta.cloned ? "setup" : "clone",
						check: null,
						line: meta.cloned ? "The setup command did not run." : "The repository could not be cloned.",
						excerpt: "",
					},
				};
		throw new TurnProblem("The environment build ended.");
	}
	t.used = sandbox;
	// The sandbox’s own kill count, to compare at the end of the turn.
	t.memoryAtStart = (await sandbox.memoryEvents?.().catch(() => null)) ?? null;
	// A resumed turn in the same sandbox measures from where its first segment there began: a pause is no fresh start.
	if (run?.memory?.sandboxId === sandbox.id)
		t.memoryAtStart = { oomKills: run.memory.oomKills, totalMiB: run.memory.totalMiB };
	else if (run && t.memoryAtStart) run.memory = { sandboxId: sandbox.id, ...t.memoryAtStart };
	if (sandbox.outOfMemory && active.item && meta.memoryNoted !== sandbox.id) {
		// After an OOM restart, offer a larger size when available. Otherwise continue at the current size.
		active.item.outOfMemory = withLarger(sandbox.outOfMemory, await resizeOptions(c, meta, layer));
		if (active.item.outOfMemory.larger) throw new TurnProblem(sandbox.notice ?? outOfMemoryWords(sandbox.outOfMemory));
	}
	return sandbox;
}

/** Asks the sandbox's harness what it can do, refuses a role it cannot serve, and tells an item its turn started. */
export async function checkHarness(
	c: Ctx,
	t: TurnScope,
	layer: SandboxLayer,
	sandbox: SandboxHandle,
	credential: TurnCredential,
): Promise<Pick<OpenedTurn, "harness" | "caps" | "profile" | "platformTool">> {
	const { meta, active, account, reviewer, critic, checkout, turn, effort } = t;
	const { key } = credential;
	// What the turn is handed goes by what the session's harness can do, asked of this sandbox's. Windlass's ChatGPT
	// models count against the ChatGPT plan's limits wherever they run, also where no plan was pinned (provider-accounts.ts).
	Object.assign(
		account,
		accountLocation({
			...account,
			provider: usesPlatformModel(meta.harness, credential.model) ? undefined : key?.provider,
		}),
	);
	// A plan's limits are its own, apart from the key of the same provider (provider-accounts.ts).
	if (account.provider && key?.plan) account.plan = true;
	t.generation =
		key?.generation ??
		(await userActor(c, meta.uid)
			.internalProviderGeneration(account)
			.catch(() => {
				c.log.warn({ msg: "Provider login generation unavailable for this turn" });
				return null;
			}));
	const harness = harnessOf(layer, meta.harness ?? "windlass");
	const caps = await harness.capabilities(sandbox);
	const profile = layer.sandboxes.profile(meta.profile);
	const platformTool = (tool: (typeof caps.platformTools)[number]) => caps.platformTools.includes(tool);
	// The plan critic needs the restricted Windlass profile. Every reviewer needs its filing tool.
	if (
		reviewer &&
		((critic && !caps.restrictedReview) ||
			(!critic && !checkout) ||
			!platformTool(critic ? "file_plan_review" : "file_review"))
	) {
		const reason = "The reviewer’s filing tool is unavailable.";
		if (active.item) active.item.refused = reason;
		throw new TurnProblem(reason);
	}
	if (
		meta.readiness &&
		(!caps.restrictedReview ||
			!platformTool(meta.readiness.draft ? "file_repo_setup" : "report") ||
			(meta.readiness.draft && !platformTool("file_repo_setup_review")))
	)
		throw new TurnProblem("The read-only setup tools are unavailable.");
	if (meta.demo && !caps.demo) throw new TurnProblem("This agent's harness has no demo mode.");
	if (active.item) await t.hooks.itemTurnStarted(c, meta, active.item, sandbox, turn, credential, effort);
	return { harness, caps, profile, platformTool };
}

/**
 * Puts the account of the session this one continues (continuation.ts) before the person's prompt.
 * What it quotes keeps its sources, labelled as on any resume; only this prompt's own can stop the turn.
 */
function handOver(c: Ctx, t: TurnScope, handoff: Handoff): void {
	const { meta } = t;
	const own = t.untrusted;
	const untrusted = sources(own, handoff.untrusted);
	const text = `${handoff.text}\n\nThe person's message for this session:\n\n${t.text}`;
	const handling = untrustedTurn({
		agent: meta.harness ?? "windlass",
		profile: meta.profile,
		untrusted,
		currentSources: own,
		unsandboxed: undefined,
	});
	if (t.resumed) {
		if (handling.kind !== "stop")
			t.fresh = { prompt: text, ...(handling.kind === "marked" && { untrusted: handling.sources }) };
		return;
	}
	// What the earlier conversation had seen counts as seen in this one.
	t.outsideText ||= handoff.untrusted.length > 0 || !!meta.secretRequestBlocked;
	t.text = text;
	t.untrusted = untrusted;
	t.handling = handling;
	if (handling.kind === "stop") refuseUntrusted(c, t, undefined, handling, text);
	note(
		c,
		t.turn,
		"info",
		"The agent does not have the earlier session's memory, so its first prompt includes an account of that session.",
	);
}

/** Decides which conversation the agent continues and what it is told; answers whether this is a summary turn. */
export async function choosePrompt(c: Ctx, t: TurnScope): Promise<boolean> {
	const { meta, active, run, critic, requested, turn } = t;
	// Windlass freezes tools at the first prompt. Start summaries fresh, but resume a paused segment's conversation.
	const summary = active.item?.row.agent === "summary";
	if (summary !== !!meta.summaryConversation || (summary && !active.resume)) {
		meta.windlassSessionId = null;
		meta.summaryConversation = summary || undefined;
	}
	// Read after the sandbox is open: a sandbox made in place of a lost one has the session only when its copy was restored.
	t.resumed = critic || requested ? null : meta.windlassSessionId;
	// A continuing session's first turn: the earlier session's account goes with the prompt, or stands by should its memory fail to resume.
	if (meta.handoff && !active.item && !active.resume) handOver(c, t, meta.handoff);
	// Reuse the task when its saved conversation did not survive replacement.
	if (active.resume && run?.prompted) {
		const whole = await wholeTask(c, meta, active, turn);
		t.outsideText ||= whole.untrusted.length > 0;
		const wholeHandling = untrustedTurn({
			agent: meta.harness ?? "windlass",
			profile: meta.profile,
			untrusted: whole.untrusted,
			currentSources: active.item ? whole.untrusted : t.untrusted,
			unsandboxed: whole.unsandboxed,
		});
		if (t.resumed) {
			t.untrusted = [];
			t.handling = untrustedTurn({
				agent: meta.harness ?? "windlass",
				profile: meta.profile,
				untrusted: t.untrusted,
				unsandboxed: active.item?.row.unsandboxed,
			});
			if (wholeHandling.kind !== "stop")
				t.fresh = { prompt: whole.text, ...(wholeHandling.kind === "marked" && { untrusted: wholeHandling.sources }) };
		} else {
			t.text = whole.text;
			t.untrusted = whole.untrusted;
			t.handling = wholeHandling;
			if (t.handling.kind === "stop") refuseUntrusted(c, t, active.item, t.handling, whole.text);
			note(
				c,
				turn,
				"info",
				"The agent no longer has its earlier conversation of this turn, so it was given the whole task again.",
			);
		}
	} else if (active.item) {
		// Without the previous conversation, continuing requires the whole task.
		const chosen = itemTurnText(active.item.row, t.text, t.resumed);
		if (chosen.fresh) {
			// The whole task's sources are its own (a GitHub issue's text), and go by the same rule as any turn's.
			t.text = chosen.text;
			t.untrusted = chosen.untrusted;
			t.handling = untrustedTurn({
				agent: meta.harness ?? "windlass",
				profile: meta.profile,
				untrusted: t.untrusted,
				unsandboxed: chosen.unsandboxed,
			});
			if (t.handling.kind === "stop") refuseUntrusted(c, t, active.item, t.handling, chosen.text);
			note(
				c,
				turn,
				"info",
				"The agent no longer has its earlier conversation of this step, so it was given the whole task again.",
			);
		}
	}
	return summary;
}

export function markRunning(c: Ctx, t: TurnScope): void {
	const { meta, signal } = t;
	if (!signal.aborted && meta.status === "starting") {
		meta.status = "running";
		publish(c);
		void persist(c);
	}
}

/** Builds the input common to both harness kinds and the handlers of the platform tools the agent may call. */
export async function turnTools(c: Ctx, t: TurnScope, opened: OpenedTurn): Promise<TurnLaunch> {
	const { meta, active, turn, signal, reviewer, critic, requested, mode, effort } = t;
	const { sandbox, credential, takeRequest, caps, platformTool, summary } = opened;
	const { model, key } = credential;
	const common: RunTurnInput = {
		...(key && {
			modelKey: {
				sessionId: meta.sessionId,
				key,
				takeRequest,
				openSecret: () =>
					openSavedCredential(meta.uid, key, (uid, ref, nonce) =>
						modelKeyActor(c, uid).internalCredential(ref, nonce, meta.place.kind === "machine"),
					),
				// A plan's relay in the sandbox tells what the provider said of the plan's health (credentials/plan-health.ts).
				...(key.plan &&
					isPlanProvider(key.provider) && {
						onSeen: (seen: RelaySeen) =>
							void modelKeyActor(c, meta.uid)
								.internalObservePlan(key.provider as PlanProvider, key.generation, seen)
								.catch(() => c.log.warn({ msg: "Could not record the plan's health" })),
					}),
			},
		}),
		prompt: t.text,
		mode,
		planMode: active.planMode,
		windlassSessionId: t.resumed ?? undefined,
		model,
		effort: effort ?? undefined,
		signal,
		onQuestion:
			active.item || meta.readiness
				? undefined
				: (question, withdrawn) => askQuestion(c, meta, active, question, withdrawn),
		onControl: control => {
			if (t.open) active.control = control;
		},
		// A machine turn whose conversation is kept: what it would need to be taken up after a restart, read with each timeline write.
		...(c.vars.runner?.durable && {
			onCheckpoint: (read: () => TurnCheckpoint | null) => {
				if (t.open) active.checkpoint = read;
			},
			...(active.reattach && { reattach: active.reattach }),
		}),
		onStartMark: (point, ms) => t.clock?.mark(point, ms),
		wantsTitle: !meta.titleIsTyped && !meta.origin && !meta.titleGenerated,
		onAcpUpdate: update => {
			if (!t.open) return;
			prompted(c, t);
			if (update.sessionUpdate === "usage_update" && update.rateLimit) recordLimit(c, t, update.rateLimit);
			if (update.sessionUpdate === "usage_update") t.watch?.reported(update.cost);
			if (caps.events === "acp") t.acpTimeline.update(update);
			const title = generatedSessionTitle(
				update,
				{ typed: meta.titleIsTyped, item: meta.origin },
				active.secrets?.redactor,
			);
			if (title && (title !== meta.title || !meta.titleGenerated)) {
				meta.title = title;
				meta.titleGenerated = true;
			} else if (
				update.sessionUpdate === "current_mode_update" &&
				!active.modeQueued &&
				meta.mode !== update.currentModeId
			)
				meta.mode = update.currentModeId;
			else return;
			publish(c);
			void persist(c);
		},
	};
	const item = active.item;
	const held = active.secrets!;
	const planning = item?.row.agent === "planner";
	const planner = !!meta.readiness || critic || planning || item?.row.agent === "summary";
	// Told once, to whichever agent takes the next prompt: what setup left, and whether the workspace is a new one.
	const notes = platformNotes(meta, reviewer);
	const store = item ? attachmentStore() : null;
	if (planning)
		t.text += `\n\nSet needs.screenshots only for subtasks that change what users see and whose repository allows screenshots (${item.crossRepoPlan ? "the primary" : "this"} repository ${held.screenshots ? "allows" : "does not allow"} them).`;
	// A builder can reconnect to a sandbox created before a setting changed.
	const browser =
		!!item &&
		!requested &&
		caps.reportScreenshots &&
		usesScreenshotImage(meta, sandbox, held.screenshots) &&
		(await sandbox.run("test -x /usr/local/bin/wlp-shot", { signal, timeoutMs: 5000 })).exitCode === 0;
	if (meta.origin?.subtaskScreenshots && (!browser || !store))
		refuseItemPolicy(
			item,
			!held.screenshots
				? "Enable screenshots for this repository and deployment, then retry."
				: !store
					? "Configure screenshot storage, then retry."
					: "The sandbox lacks a working screenshot tool. Check the pinned image and the runner’s --screenshots flag.",
		);
	const unavailable = held.screenshots
		? "Screenshots are unavailable in this sandbox. File without screenshots."
		: NO_REPO_SHOTS;
	const filings = { chain: Promise.resolve("") };
	const setup = meta.readiness;
	const onReport: RunTurnInput["onReport"] =
		setup && !setup.draft
			? async (request, withdrawn) => {
					if (!t.open || withdrawn.aborted || setup.result) return "These setup checks have already been filed.";
					const answer = fileReadiness(request.arguments, held.redactor, report => {
						setup.result = report;
					});
					if (setup.result) await persist(c);
					return answer;
				}
			: item && !planning && !reviewer && platformTool("report")
				? (request, withdrawn) => {
						const file = async () => {
							if (!t.open || withdrawn.aborted) return "The report call ended. File it again.";
							if (!browser && Array.isArray(request.arguments?.screenshots) && request.arguments.screenshots.length)
								return unavailable;
							const top = meta.cloneDirectory === "." ? sandbox.cwd : `${sandbox.cwd}/${meta.cloneDirectory}`;
							const owner = {
								by: "builder" as const,
								uid: meta.uid,
								sessionId: meta.sessionId,
								itemId: item.row.itemId,
								key: item.row.key,
							};
							return fileReport(
								request.arguments,
								held.redactor,
								(filed, answer) => {
									if (!t.open || withdrawn.aborted) throw new Error("The report call ended.");
									if (meta.origin?.subtaskScreenshots && !filed.screenshots.length)
										throw new Error("This part requires screenshot evidence.");
									item.report = filed;
									meta.report = { ...filed, run: Number(item.row.key.split(":")[1]) };
									note(
										c,
										turn,
										"info",
										`The agent filed its report: “${filed.title}”.${answer === REPORT_TAKEN ? "" : " " + answer}`,
									);
								},
								store && browser
									? shots => uploadShots(sandbox, top, shots, owner, userActor(c, meta.uid), store, withdrawn)
									: null,
							);
						};
						filings.chain = filings.chain
							.then(file, file)
							.catch(() => "The platform could not finish filing this report. File it again.");
						if (summary)
							filings.chain = filings.chain.then(answer => {
								if (!item.report) item.said = held.redactor.text(answer).slice(0, 400);
								return answer;
							});
						return tracked(t, filings.chain);
					}
				: undefined;
	meta.secretRequestBlocked = t.outsideText || ((!!t.resumed || !!active.resume) && !!meta.secretRequestBlocked);
	const onRequestSecret: RunTurnInput["onRequestSecret"] =
		!planner && !reviewer && (!item || typeof item.row.asksLeft === "number") && platformTool("request_secret")
			? secretRequestHandler(c, meta, turn, item, held.redactor, caps.events === "acp", () => t.open)
			: undefined;
	// Only a builder with a remaining question allowance may ask its owner.
	const onAsk: RunTurnInput["onAsk"] =
		item && !planner && !reviewer && typeof item.row.asksLeft === "number" && platformTool("ask_person")
			? (request, withdrawn) => {
					if (!t.open || withdrawn.aborted) return "The call ended. Nothing was recorded.";
					const taken = askPerson(
						request.arguments,
						{ already: !!item.asked || !!meta.secretRequest, left: item.row.asksLeft ?? 0 },
						held.redactor,
					);
					if (taken.asked) item.asked = taken.asked;
					note(c, turn, taken.asked ? "info" : "warn", taken.said);
					return taken.told;
				}
			: undefined;
	// Repository tools remain bound to this session. MCP calls can originate anywhere in the container.
	const repoTools =
		!planner && !reviewer && !!meta.repo && (meta.repo.provider === "gitlab" ? gitlabApp() : githubApp()) !== null;
	const onPush: RunTurnInput["onPush"] =
		repoTools && platformTool("push") ? request => tracked(t, agentPush(c, meta, active, sandbox, request)) : undefined;
	const onFetchBase: RunTurnInput["onFetchBase"] =
		repoTools && platformTool("fetch_base") ? request => agentFetchBase(c, meta, active, sandbox, request) : undefined;
	t.lossesAtStart ??= c.vars.runner?.channel.losses ?? null;
	t.agentStarted = true;
	const screenshots = browser && !!store;
	const listed: ReviewRecord[] = [];
	const commands = new ReviewCommands(held.redactor);
	return {
		...opened,
		common,
		item,
		held,
		planning,
		planner,
		notes,
		store,
		browser,
		unavailable,
		filings,
		setup,
		repoTools,
		screenshots,
		listed,
		commands,
		uiChanged: false,
		filingFiles: null,
		storedBrief: null,
		setupTurn: undefined,
		accepted: undefined,
		onReport,
		onRequestSecret,
		onAsk,
		onPush,
		onFetchBase,
		onReview: undefined,
	};
}

/** Repo setup: checks the repository out read-only and, for a draft, adds the evidence to the prompt. */
export async function prepareSetup(
	c: Ctx,
	t: TurnScope,
	l: TurnLaunch,
	setup: NonNullable<SessionMeta["readiness"]>,
): Promise<void> {
	const { meta, signal, setupPhase } = t;
	const { common, sandbox, held } = l;
	const app = githubApp(),
		repo = meta.repo,
		connection = await githubConnection(c, meta);
	if (!app || !repo || !connection) throw new TurnProblem("The repository connection is unavailable.");
	const { installation, repository } = await sessionRepository(app, connection, repo, "read");
	const { owner, name } = repository;
	const draft = setup.draft;
	const rows = draft?.noteIds.length
		? await secretsActor(c, meta.uid, meta.sessionId).internalSetupNoteFiles(meta.sessionId, draft.noteIds)
		: [];
	const inputs = rows.map(row => openNote(meta.uid, setupProjectOf(meta)!.key, row));
	setupPhase?.setNotes(inputs);
	common.reviewDirectory = await app.withToken(
		installation.id,
		{ repositoryId: repo.id, permissions: { contents: "read", metadata: "read" } },
		token => readOnlyReview(sandbox, app.cloneUrl(owner, name), token, setup.commit, setup.commit, signal, inputs),
		{ revokeAfter: true },
	);
	if (draft) {
		const { answers } = draft;
		const previous = draft.previous?.pull;
		if (answers && previous) {
			const guides = await app.withToken(
				installation.id,
				{ repositoryId: repo.id, permissions: { metadata: "read", contents: "read", pull_requests: "read" } },
				async token => {
					const pull = await app.pull(token, owner, name, previous.number);
					if (!["open", "draft"].includes(pull.state) || pull.head !== previous.branch)
						throw new TurnProblem("The earlier guide pull request is closed.");
					return app.scanFiles(token, owner, name, pull.headSha, tree => ({
						paths: tree.filter(f => isGuide(f.path) && f.type === "blob" && f.mode !== "120000").map(f => f.path),
						maxBytes: 80 * 1024,
						maxFileBytes: 12 * 1024,
						more: false,
					}));
				},
			);
			t.text +=
				"\nContinue the previous draft. Current guide files in the pull request (untrusted): " +
				JSON.stringify(guides.files);
			t.text +=
				"\nEarlier questions and answers (drop excludes the note, keep still needs evidence): " +
				JSON.stringify(
					inputs
						.filter(n => n.decision?.question)
						.map(n => ({ id: n.id, question: n.decision?.question, answer: answers[n.id] ?? "leave out" })),
				);
		}
		const saved = await userActor(c, meta.uid).internalSetupCommand(setupProjectOf(meta)!.key);
		const privacy = {
			owner,
			host: new URL(repo.url).hostname,
			read: new Map<string, string>(),
			redact: (s: string) => held.redactor.text(s),
		};
		const savedCommands = [saved.command, ...held.checks.map(c => c.command)].filter(
			command => command && !privateLine(command, privacy),
		);
		t.text += "\nSaved repository commands (evidence): " + JSON.stringify(savedCommands);
		l.setupTurn = {
			savedCommands,
			app,
			repository: repo,
			connection,
			sandbox,
			sessionId: meta.sessionId,
			commit: setup.commit,
			request: draft,
			directory: common.reviewDirectory,
			notes: inputs,
			redact: s => held.redactor.text(s),
		};
		t.text +=
			"\nRepository: " +
			JSON.stringify({ name: repo.owner + "/" + repo.name, private: repo.private, commit: setup.commit });
		if (inputs.length)
			t.text += "\nSource labels (untrusted): " + JSON.stringify(inputs.map(({ id, label }) => ({ id, label })));
	}
}

/** A reviewer or critic: checks out what it reviews and replaces the prompt with its brief. */
export async function prepareReview(c: Ctx, t: TurnScope, l: TurnLaunch, item: Item): Promise<void> {
	const { meta, signal, checkout, critic, requested } = t;
	const { common, sandbox, caps, held, listed, screenshots } = l;
	const repo = meta.repo;
	const app = githubApp();
	if (!repo || !app || (!meta.cloned && !requested)) throw new ReviewRefused("the base clone is unavailable");
	const connection = await githubConnection(c, meta);
	if (!connection) throw new ReviewRefused("the repository connection is unavailable");
	const resolved = requested
		? await resolveBoundRepository(app, connection, requested.repositoryId, requested.installationId, "read")
		: await sessionRepository(app, connection, repo, "read");
	const scope = { repositoryId: resolved.repository.id, permissions: { contents: "read", metadata: "read" } } as const;
	const { owner, name } = resolved.repository;
	let directory = meta.cloneDirectory ?? ".";
	if (checkout && requested) {
		directory = await app.withToken(
			resolved.installation.id,
			scope,
			token => readOnlyReview(sandbox, app.cloneUrl(owner, name), token, checkout.head, checkout.baseSha, signal),
			{ revokeAfter: true },
		);
		common.reviewDirectory = directory;
	} else if (checkout)
		await app.withToken(
			resolved.installation.id,
			scope,
			token => checkoutReview(sandbox, app.cloneUrl(owner, name), token, directory, checkout.pr, checkout.head, signal),
			{ revokeAfter: true },
		);
	if (caps.events === "windlass") {
		// Setup must not seed approvals in a reviewer's private data directory.
		const grants = `${DATA_DIR}/approvals`;
		const grantCheck = await sandbox.run(
			`set -eu
test ! -L '${grants}'
if test -e '${grants}'; then
  test -d '${grants}'
  found=$(find '${grants}' -mindepth 1 -print -quit)
  test -z "$found"
fi`,
			{ signal, timeoutMs: 5000 },
		);
		if (grantCheck.aborted || grantCheck.timedOut)
			throw new TurnProblem("checking the saved project approvals was interrupted");
		if (grantCheck.exitCode !== 0)
			throw new ReviewRefused("could not establish that Windlass has no saved project approvals");
	}
	if (critic) {
		const list =
			`git -C ${shellQuote(directory)} ls-tree -r --name-only -z HEAD` +
			(item.crossRepoPlan ? ` && find ${shellQuote(INPUTS_DIRECTORY)} -mindepth 2 -type f -print0` : "");
		const tree = await sandbox.run(list, { signal, timeoutMs: 10000 });
		if (tree.exitCode !== 0 || tree.timedOut || tree.aborted || !tree.stdout.endsWith("\0"))
			throw new TurnProblem("The critic could not read the tracked repository tree.");
		t.text += "\n\nTracked repository tree: " + JSON.stringify(tree.stdout.split("\0").slice(0, -1));
	}
	if (checkout) {
		const paths = await changedReviewPaths(sandbox, directory, checkout.baseSha, checkout.head, !!requested);
		l.filingFiles = () => {
			let issued: InstallationToken | undefined;
			return {
				async read(path, sha) {
					issued ??= await app.installationToken(resolved.installation.id, scope);
					return app.fileAt(issued.token, owner, name, path, sha);
				},
				async close() {
					if (issued) await app.revoke(issued);
				},
			};
		};
		l.uiChanged = paths.some(path =>
			/\.(tsx|jsx|vue|svelte|css|scss|html)$|^(web|app|pages|components|src\/ui)\//i.test(path),
		);
		const manifestsChanged = paths.some(path =>
			/(?:^|\/)(?:package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lock[^/]*|requirements[^/]*\.txt|pyproject\.toml|uv\.lock|poetry\.lock|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|Gemfile[^/]*)$/.test(
				path,
			),
		);
		const brief = reviewerTask(
			held.redactor.deep({
				...checkout,
				mcp: caps.events === "acp",
				reviewDirectory: common.reviewDirectory,
				changed: groupReviewPaths(paths),
				uiChanged: l.uiChanged,
				manifestsChanged,
				screenshots,
			}),
			listed,
			held.redactor.text(t.text),
		);
		l.storedBrief = held.redactor.text(itemPrompt(item.row));
		t.text = brief;
	}
}

/** The reviewer's `file_review` handler, once its checkout is known. */
export function reviewHandler(c: Ctx, t: TurnScope, l: TurnLaunch): RunTurnInput["onReview"] {
	const { meta, reviewer, checkout } = t;
	const {
		item,
		filingFiles,
		platformTool,
		sandbox,
		listed,
		commands,
		held,
		screenshots,
		store,
		browser,
		unavailable,
		caps,
		profile,
		filings,
	} = l;
	let calls = 0;
	return reviewer && item && checkout && filingFiles && platformTool("file_review")
		? (request, withdrawn) => {
				const openFiles = filingFiles;
				const file = async () => {
					if (!t.open || withdrawn.aborted) return "The review call ended.";
					const args = request.arguments;
					if (request.via !== "mcp" && args?.commands === true) {
						if (Object.keys(args).length !== 1)
							return "A command lookup takes only the commands field. No filing was used.";
						return (
							"Completed shell commands in call order: " +
							(commands
								.records()
								.map(r => r.ref)
								.join(", ") || "none")
						);
					}
					if (calls >= RULES.reviewFilings)
						return "No more filings in this turn. The platform keeps the last review it accepted. End your turn.";
					calls++;
					const owner = {
						by: "reviewer" as const,
						uid: meta.uid,
						sessionId: meta.sessionId,
						itemId: item.row.itemId,
						key: item.row.key,
					};
					const top = meta.cloneDirectory === "." ? sandbox.cwd : `${sandbox.cwd}/${meta.cloneDirectory}`;
					const files = openFiles();
					const result = await fileReview(
						args,
						{
							records: listed,
							commands: commands.records(),
							earlier: earlierContext(checkout.earlier),
							round: checkout.round,
							redactor: held.redactor,
						},
						checkout.baseSha,
						checkout.head,
						screenshots,
						files.read,
						store ? shots => uploadShots(sandbox, top, shots, owner, userActor(c, meta.uid), store, withdrawn) : null,
						browser ? undefined : unavailable,
					).finally(files.close);
					if (result.retryFree) calls--;
					if (!t.open || withdrawn.aborted) return "The review call ended.";
					if (result.filing) {
						if (l.uiChanged && !result.filing.screenshots.length)
							result.filing.notes.push("UI files changed; no screenshots.");
						meta.review = {
							...result.filing,
							id: item.row.key,
							run: Number(item.row.key.split(":")[1]),
							round: checkout.round,
							head: checkout.head,
							base: checkout.baseSha,
							verdictId: checkout.verdictId,
							by: {
								sessionId: meta.sessionId,
								model: meta.model,
								via: request.via ?? (caps.events === "windlass" ? "host" : "mcp"),
								commandSandbox: commandSandbox(profile),
							},
							at: Date.now(),
							state: "filed",
							said: null,
						};
						await persist(c);
					}
					item.said = result.answer;
					return result.answer;
				};
				filings.chain = filings.chain
					.then(file, file)
					.catch(() => "The platform could not finish filing this review. Try again.");
				return tracked(t, filings.chain);
			}
		: undefined;
}

function launchInput(t: TurnScope, l: TurnLaunch): RunTurnInput {
	const { reviewer, active } = t;
	const { common, notes, planner, held, onReview, onReport, onAsk, onRequestSecret, onPush, onFetchBase } = l;
	return {
		...common,
		prompt: notes.text + t.text,
		...(t.fresh && { fresh: { ...t.fresh, prompt: notes.text + t.fresh.prompt } }),
		checks: planner || reviewer ? [] : held.checks,
		maxSteps: reviewer ? RULES.reviewMaxSteps : active.item?.row.maxSteps,
		onReview,
		onReport,
		onAsk,
		onRequestSecret,
		onPush,
		onFetchBase,
	};
}

/** Runs an ACP agent's prompt. */
export async function runAcpAgent(c: Ctx, t: TurnScope, l: TurnLaunch): Promise<void> {
	const { meta, active, turn, reviewer } = t;
	const { harness, sandbox, item, repoTools, platformTool, held, notes } = l;
	// These agents take no marker: the text is labelled in the prompt, and the timeline says so once.
	if (t.handling.kind === "labelled") unmarked(c, t, t.handling.note);
	const result = (t.result = await harness.runTurn(sandbox, {
		...launchInput(t, l),
		...(item && { unattended: true }),
		// Over MCP a publish is always put to the person, never "for this session": any process in the container may have asked.
		onPublish:
			repoTools && !item && platformTool("publish")
				? (request, withdrawn) => tracked(t, agentPublish(c, meta, active, sandbox, "none", request, withdrawn))
				: undefined,
		secrets: {
			env: Object.fromEntries(
				(reviewer ? [] : meta.repo ? held.opened : held.account)
					.filter(s => s.scope === "agent" && held.requestedNames?.includes(s.name))
					.map(s => [s.name, s.value]),
			),
			withholdEnv: [],
			passEnv: [],
			redactor: held.redactor,
		},
		// ACP checks are run by the platform after the agent's prompt ends.
		forceChecks: item?.row.agent === "run_checks",
		onChecks: (event, said) => {
			if (event.type === "synthetic.appended" && event.data?.origin === "check_report")
				meta.secretRequestBlocked = true;
			active.checks.note(event);
			if (t.open && said) note(c, turn, said.level, said.text);
		},
		harnessModels: meta.harnessModels,
		onAcpNote: text => {
			if (t.open) note(c, turn, "warn", text);
		},
		onEffortFallback: fallback => {
			if (t.open)
				note(
					c,
					turn,
					"info",
					`The selected model uses its default effort${fallback && fallback !== "default" ? ` (“${fallback}”)` : ""}.`,
				);
		},
		onAcpModes: (chosen, offered, fallbackFrom) => {
			if (!t.open) return;
			meta.availableModes = offered;
			if (!active.modeQueued) meta.mode = chosen;
			if (fallbackFrom !== undefined)
				note(
					c,
					turn,
					"info",
					`${machineHarnesses[meta.harness as keyof typeof machineHarnesses].name} does not offer “${fallbackFrom}” here. Using its current mode “${chosen}”.`,
				);
			publish(c);
			void persist(c);
		},
	}));
	// The agent took the prompt once it answered it.
	if (result.acp?.stopReason) notes.told();
}

/** Runs Windlass (or the repo setup phases over it), then the checks a checks-only delivery forces, then publishes accepted setup guides. */
export async function runWindlassAgent(c: Ctx, t: TurnScope, l: TurnLaunch): Promise<void> {
	const { meta, active, turn, signal, reviewer, setupPhase } = t;
	const { harness, sandbox, layer, profile, item, planner, held, setup, notes } = l;
	// Resume keeps a named agent until explicitly switched. The inbox also records planners from before this handoff was supported.
	const clearPlanner = !!(
		t.resumed &&
		active.item &&
		!planner &&
		!reviewer &&
		(await c.db.execute("SELECT 1 FROM inbox WHERE agent IN ('planner', 'summary') AND turn IS NOT NULL LIMIT 1"))
			.length
	);
	const servers: ServerQuestionContext = {
		profile,
		demo: meta.demo,
		dataInSandbox: await privateSessionData(meta, layer.sandboxes, sandbox.id),
		project: projectOf(meta),
		machine: machineOf(meta),
		hostedEgress: meta.place.kind === "hosted" ? layer.sandboxes.egress?.() : undefined,
		// Null for a session that is not on a repository of the GitHub connection: it can have none.
		secrets: setupProjectOf(meta) ? held.opened.map(({ name, scope }) => ({ name, scope })) : null,
		accountSecrets: accountSecretsFor(held.account, held.opened).map(secret => secret.name),
	};
	// What the panel says of the account's secrets goes by this sandbox, as the list of the repository's does.
	meta.accountSecrets = accountSecretsNote(profile);
	// Told of no source (above): the timeline says once that the text went labelled only.
	if (t.handling.kind === "labelled") unmarked(c, t, t.handling.note);
	const windlassInput = windlassInputOf(c, t, l, servers, clearPlanner);
	if (l.setupTurn && setupPhase) {
		const reviewed = await reviewSetup(
			l.setupTurn,
			windlassInput,
			input => harness.runTurn(sandbox, input),
			t.turnEndsAt,
			setupPhase,
		);
		t.setupStage = "record";
		t.result = reviewed.result;
		l.accepted = reviewed.filed;
		if (setup) setup.diagnosis = setupPhase.diagnosis();
	} else t.result = await harness.runTurn(sandbox, windlassInput);
	const result = t.result;
	// On a checks-only delivery run every saved command the native diff-based gate omitted.
	if (
		item?.row.agent === "run_checks" &&
		result.summary?.outcome === "succeeded" &&
		!result.failure &&
		!signal.aborted
	) {
		const evidence = active.checks.verified(turn, held.checks, result.checks, meta.verified ?? null);
		const forced = new VerificationLog();
		const gate = new PlatformChecks(
			sandbox,
			held.checks,
			(event, said) => {
				forced.note(event);
				if (said) note(c, turn, said.level, said.text);
			},
			{
				agent: "Windlass",
				redactor: held.redactor,
				signal,
				force: true,
				isolated: profile.approval !== "full" || !!meta.tainted || t.handling.kind === "marked",
			},
		);
		await gate.finishNativeTurn(evidence);
		if (gate.ended !== null) active.checks = forced;
		if (signal.aborted) result.aborted = true;
	}
	// Windlass took the prompt if it said anything at all; a turn that never reached it is told again.
	if (t.events > 0) notes.told();
	const { setupTurn, accepted } = l;
	if (setup && setupTurn && accepted) {
		const { noteIds } = setupTurn.request;
		if (noteIds.length) await secretsActor(c, meta.uid, meta.sessionId).internalSetupNoteFiles(meta.sessionId, noteIds);
		t.setupStage = "publish";
		const publication = await publishSetup(
			setupTurn,
			accepted,
			AbortSignal.any([signal, AbortSignal.timeout(PUBLISH_MS)]),
		);
		t.setupStage = "record";
		await userActor(c, meta.uid).internalSetupPublished(
			meta.sessionId,
			publication,
			accepted.decisions,
			meta.repo!.installationId,
			setupTurn.commit,
		);
		setup.result = accepted.score;
		await persist(c);
	}
}

function windlassInputOf(
	c: Ctx,
	t: TurnScope,
	l: TurnLaunch,
	servers: ServerQuestionContext,
	clearPlanner: boolean,
): RunTurnInput {
	const { meta, active, turn, signal, run, reviewer, critic } = t;
	const {
		sandbox,
		layer,
		profile,
		item,
		planner,
		planning,
		held,
		setup,
		browser,
		repoTools,
		platformTool,
		credential,
	} = l;
	// Receipted against the Settings key it names; the ChatGPT plan's tokens count against the daily allowance, as before.
	const key = usesPlatformModel(meta.harness, credential.model) ? undefined : credential.key;
	return {
		...launchInput(t, l),
		// Windlass gets the secrets that keep to their scope in this sandbox, the repository's and the account's, with the names its commands are and are not to have; every saved value is taken out of what it says.
		secrets: {
			...turnEnvironment(planner || reviewer ? [] : held.opened, planner || reviewer ? [] : held.account, profile),
			redactor: held.redactor,
		},
		// Disable unasked personal-server calls once outside text taints the session.
		servers:
			planner || reviewer
				? []
				: t.untrusted.length || meta.tainted
					? held.servers.map(server => ({ ...server, unasked: false }))
					: held.servers,
		// Windlass's question about a tool of one whose tools run without asking: the layer answers it, and the timeline says for whom and why.
		onUnasked: call => {
			if (t.open)
				note(c, turn, "info", unaskedNote(str(call.server)), {
					code: "question_allowed",
					call: { messageId: str(call.messageId), callId: str(call.callId) },
				});
		},
		// A command's timeout is held to what is left of the turn (windlass-config.ts `TURN_TIME_HOOK`).
		endsAt: t.turnEndsAt,
		...(t.handling.kind === "marked" &&
			(sources => ({
				untrusted: sources,
				onUntrustedUnmarked: () => {
					if (t.open) unmarked(c, t, unmarkedNote(sources));
				},
			}))(t.handling.sources)),
		// Once Windlass says the session is tainted, also part way through this turn, nobody is there to answer for the user's servers.
		...(item && { unaskedUntilTainted: true }),
		...(setup?.draft?.noteIds.length && { untrusted: ["notes imported from the Repo setup page"] }),
		reportScreenshots: browser,
		onPlanReview:
			critic && item
				? async (request, withdrawn) => {
						if (withdrawn.aborted || item.planReview) return "This critic filing is closed.";
						const review = planReviewOf(held.redactor.deep(request.arguments));
						if (!review)
							return "File approve or revise and up to twelve concise findings. Revision needs a concrete finding.";
						item.planReview = review;
						return "Plan review filed. End your turn.";
					}
				: undefined,
		planner,
		repoSetup: !!meta.readiness,
		clearPlanner,
		crossRepoPlan: planning && item?.crossRepoPlan === true,
		onPlan:
			planning && item
				? request =>
						tracked(
							t,
							itemActor(c, meta.uid, item.row.itemId).internalFilePlan({
								key: item.row.key,
								plan: held.redactor.deep(request.arguments),
							}),
						)
				: undefined,
		script: meta.demo ? layer.windlass.demoScript(t.text, turn) : undefined,
		onEvent: event => {
			if (!t.open) return;
			const used = t.watch && reportedModelUsage(event);
			if (used) t.watch?.used(used);
			// Reads and model output can contain raw notes. Only accounting events belong in the timeline.
			if (setup?.draft) {
				const usage = reportedModelUsage(event, true);
				if (!usage) return;
				event = { ...event, data: { usage } };
			}
			t.events += 1;
			prompted(c, t);
			try {
				// Windlass echoes the submitted brief in this event. Keep its receipt, with the same short text as the user row.
				if (l.storedBrief !== null && event.type === "inbox.enqueued" && event.data?.origin === null) {
					event = { ...event, data: { ...event.data, content: [{ type: "text", text: l.storedBrief }] } };
					l.storedBrief = null;
				}
				if (signal.reason === PLATFORM_RESTART && run) {
					const result = restartShellResult(event);
					if (result !== event) run.stoppedCommand = true;
					event = result;
				}
				event = publicUsageEvent(event, t.lastStepRefusal);
				t.lastStepRefusal = stepRefusal(t.lastStepRefusal, event);
				if (event.type === "step.failed" && t.lastStepRefusal?.retryAfterMs !== undefined)
					t.lastStepRefusal.resetsAt = resetTime(Date.now() + t.lastStepRefusal.retryAfterMs);
				if (reviewer) l.commands.note(event);
				// Kept at once: Windlass says it once per session, and a later turn's servers go by it.
				if (
					(event.type === "taint.noticed" || event.type === "taint.cleared") &&
					meta.tainted !== (event.type === "taint.noticed")
				) {
					meta.tainted = event.type === "taint.noticed";
					void persist(c);
				}
				active.checks.note(event);
				onWindlassEvent(c, meta, turn, event, key);
			} catch (error) {
				c.log.error({ msg: "could not record a Windlass event", error: describeError(error) });
			}
		},
		onPublish:
			repoTools && !active.item && platformTool("publish")
				? (request, withdrawn) =>
						tracked(t, agentPublish(c, meta, active, sandbox, commandSandbox(profile), request, withdrawn))
				: undefined,
		// The project's own MCP servers, which Windlass leaves stopped until the user says otherwise; nobody can say so in an item's turn.
		onServerQuestion: meta.readiness
			? async () => false
			: active.item
				? async question => {
						note(
							c,
							turn,
							"info",
							`The project's MCP server “${str(question?.name)}” was not started: a work item's turn has nobody to approve it.`,
						);
						return false;
					}
				: (question, withdrawn) => askServer(c, meta, active, servers, question, withdrawn),
		onServerApproved: (question, outcome) => {
			const named = { name: str(question?.name), fingerprint: str(question?.fingerprint) };
			const recalled = active.recalled.get(serverKey(named));
			const remedy = unsetRemedy(Array.isArray(question?.unset) ? question.unset.map(str) : [], servers);
			const said = recalled
				? serverRecalledNote(question, outcome, ago(Date.now() - recalled.approvedAt), remedy)
				: serverApprovedNote(question, outcome, remedy);
			note(c, turn, said.level, said.text);
			// Save new approvals only after Windlass accepts them. Recalled approvals do not renew the grant.
			if (!recalled && (outcome.state === "running" || outcome.state === "starting" || outcome.state === "failed"))
				void rememberServer(c, meta, named);
		},
		onServers: said => {
			if (t.open) knowServers(c, meta, said);
		},
	};
}

/** Classifies what stopped the turn early: the repo setup or environment build result, item refusals, and the problem shown. */
export async function recordFailure(c: Ctx, t: TurnScope, error: unknown): Promise<void> {
	const { meta, active, turn, signal, checkout, setupPhase } = t;
	t.thrown = error;
	if (meta.readiness && setupPhase) {
		const why =
			error instanceof GithubError && meta.repo
				? problemOf(error, meta.repo.owner, meta.repo.name).message
				: error instanceof Error
					? error.message
					: "Run setup again.";
		if (t.setupStage === "agent") {
			const diagnosis = setupPhase.diagnosis();
			meta.readiness.error = setupPhase.clean(why, 360);
			meta.readiness.diagnosis = diagnosis;
			const skills = {
				...diagnosis.skills,
				filings: diagnosis.skills.filings.map(({ proposals, refusedLines, ...summary }) => summary),
			};
			c.log.warn({
				msg: "repo setup phase failed",
				session: meta.sessionId,
				turn,
				error: meta.readiness.error,
				...diagnosis,
				skills,
			});
		} else {
			meta.readiness.error =
				(t.setupStage === "publish"
					? "The guides could not be published. "
					: "Repo setup could not save the result. ") + setupPhase.clean(why);
		}
		error = t.thrown = new TurnProblem(meta.readiness.error);
	}
	if (meta.environmentBuild && !c.vars.environmentResult) {
		if (t.opening && isSandboxUserError(error) && error.message === ENVIRONMENT_SLOT_WAIT) {
			c.vars.environmentResult = { waiting: ENVIRONMENT_SLOT_WAIT };
		} else if (
			signal.aborted ||
			sandboxConnectionLost(error) ||
			(t.opening && meta.sandboxId && (await t.layer?.sandboxes.state(meta.sandboxId).catch(() => null)) === "none")
		) {
			c.vars.environmentResult = { interrupted: true };
		} else {
			c.vars.environmentResult = {
				finishedAt: Date.now(),
				commit: "",
				image: "",
				checks: [],
				snapshot: false,
				failure: { kind: "setup", check: null, line: "The build could not start its sandbox.", excerpt: "" },
			};
		}
	}
	const failure =
		checkout && meta.repo && error instanceof GithubError ? problemOf(error, meta.repo.owner, meta.repo.name) : error;
	if (
		checkout &&
		active.item &&
		!signal.aborted &&
		(failure instanceof ReviewRefused ||
			(failure instanceof GithubProblem && (failure.code === "github_denied" || failure.code === "github_gone")))
	) {
		const reason = active.secrets?.redactor.text(failure.message) ?? failure.message;
		active.item.refused = `The reviewer's checkout of ${checkout.head.slice(0, 7)} failed: ${reason}`;
	}
	// No scoped Git credential to clone with: retrying cannot help until the owner acts, so the item asks rather than counting it as cut off.
	if (active.item && !signal.aborted && !active.item.refused && failure instanceof GitAccessRefused)
		active.item.refused = active.secrets?.redactor.text(failure.message) ?? failure.message;
	if (active.item && !active.item.started && error instanceof MachineUnreachable)
		active.item.machineAway = error.reason;
	if (active.item && error instanceof DeploymentFull) active.item.full = error.limit;
	if (!signal.aborted) {
		// An error's text is the sandbox's or the provider's: the repository's saved values are taken out of it before it is logged or shown.
		const clean = (text: string) => active.secrets?.redactor.text(text) ?? text;
		t.problem = clean(
			error instanceof TurnProblem || isSandboxUserError(error)
				? error.message
				: `The sandbox failed: ${describeError(error)}`,
		);
		// Only failures preparing the sandbox count here. Capacity, connectivity and policy refusals are classified separately.
		if (
			active.item &&
			t.opening &&
			!active.item.refused &&
			!(error instanceof TurnProblem) &&
			!(error instanceof DeploymentFull) &&
			!(error instanceof MachineUnreachable)
		)
			active.item.sandboxFailed = clean(isSandboxUserError(error) ? error.message : describeError(error));
		if (error instanceof TurnProblem)
			c.log.warn({ msg: "turn failed", session: meta.sessionId, turn, error: clean(error.message) });
		else
			c.log.error({
				msg: "turn failed",
				session: meta.sessionId,
				turn,
				error: clean(error instanceof Error ? (error.stack ?? error.message) : String(error)),
			});
	}
}

/** Stops the turn's network watch, its clock and its limit, seals it, and waits for the agent's pushes under way. */
export async function windDown(c: Ctx, t: TurnScope): Promise<void> {
	const { meta, active } = t;
	try {
		await active.finishNetwork?.();
	} finally {
		// The image outlives its source. Dispose of the build here even if its result never reaches the user actor.
		if (meta.environmentBuild && t.layer)
			await destroySessionSandboxes(c, meta).catch(error =>
				c.log.warn({ msg: "could not remove the environment build sandbox", error: describeError(error) }),
			);
	}
	// A turn that ended before its agent's first output keeps what it measured.
	t.clock?.finish();
	if (c.vars.startClock === t.clock) c.vars.startClock = null;
	t.acpTimeline.flush();
	t.open = false;
	t.watch?.close();
	clearTimeout(t.limit);
	// From here on the turn takes no message, no answer and no stop of a call, and has no question.
	sealTurn(c, meta, active);
	// A push for the agent that was under way when the turn ended is finished first: the turn does not close under it.
	if (active.publishes.size > 0) await Promise.allSettled([...active.publishes]);
}

type SegmentEnd =
	| { paused: true }
	| { paused: false; segmentUsage: TurnUsage | null; modelKey: ModelKeySpend | undefined };

/** Pauses a resumable turn that was cut short; otherwise notes its memory and answers its usage for closing it. */
export async function endSegment(c: Ctx, t: TurnScope): Promise<SegmentEnd> {
	const { meta, active, run, signal, account, result } = t;
	// Losing the runner pauses the turn unless another stop already won.
	const lostLink =
		(t.lossesAtStart !== null && (c.vars.runner?.channel.losses ?? 0) > t.lossesAtStart) ||
		((t.agentStarted || active.resume !== undefined || active.item?.started === true) &&
			(t.thrown instanceof ConversationLost ||
				(t.thrown instanceof MachineUnreachable && t.thrown.reason === "offline")));
	if (run && meta.place.kind === "machine" && !signal.aborted && lostLink) active.pausing ??= "machine";
	// A turn that ended by itself just as the server went away has ended: only one that was cut short pauses.
	const ownEnd =
		!!result &&
		!result.aborted &&
		(capabilitiesOf(meta.harness).events === "acp"
			? !!result.acp?.stopReason && result.acp.stopReason !== "cancelled"
			: !!result.summary && result.summary.outcome !== "interrupted");
	const pausing =
		!!active.pausing &&
		!!run &&
		meta.run === run &&
		!c.vars.destroying &&
		!active.item?.withdrawn &&
		!active.outOfTime &&
		(active.pausing === "machine" || !ownEnd);
	// A paused segment retains its original OOM counter for comparison on resume.
	if (!pausing && t.used && !active.item?.outOfMemory)
		await noteTurnMemory(c, meta, active, t.used, t.memoryAtStart, t.turnBegan, t.turn);
	const segmentUsage = usageOf(t.result?.summary?.usage) ?? t.result?.acp?.tokens ?? null;
	const modelKey =
		capabilitiesOf(meta.harness).events === "acp" && account.provider && t.generation && segmentUsage
			? { provider: account.provider, generation: t.generation, tokens: turnTokens(segmentUsage) }
			: undefined;
	if (pausing && active.pausing && run) {
		try {
			await pauseTurn(c, meta, active, active.pausing, segmentUsage, modelKey, t.result);
		} catch (error) {
			c.log.error({ msg: "could not pause the turn", error: describeError(error) });
		}
		return { paused: true };
	}
	return { paused: false, segmentUsage, modelKey };
}

/** The turn's outcome and the message shown with it, from what the agent reported or the problem that stopped it. */
function turnOutcome(
	c: Ctx,
	t: TurnScope,
	caps: ReturnType<typeof capabilitiesOf>,
	summary: RunTurnResult["summary"] | null,
): { outcome: TurnOutcome; stepLimit: number | undefined; message: string | null } {
	const { meta, active, turn, signal, account, reviewer, result, problem } = t;
	let outcome: TurnOutcome;
	let stepLimit: number | undefined;
	let message: string | null = null;
	if (t.resumed && result?.resumed === false && result.windlassSessionId)
		note(
			c,
			turn,
			t.fresh ? "info" : "warn",
			t.fresh
				? `${harnessName(meta.harness)} could not continue its saved conversation, so it was given the whole task again.`
				: `${harnessName(meta.harness)} could not continue the conversation; the files are as they were.`,
		);
	if (caps.events === "acp") {
		const reason = result?.acp?.stopReason;
		if (result?.acp && result.windlassSessionId) meta.harnessModels = result.acp.models;
		if (result?.failure || problem) {
			outcome = "error";
			message = result?.failure?.message ?? problem;
			// Codex asked to leave its sandbox (acp-harness.ts): the step ends, and the item asks with the platform's note.
			if (result?.failure?.reason === SANDBOX_ESCAPE_REFUSED && active.item)
				active.item.escaped = result.failure.message;
		} else if (result?.acp?.stepLimit !== undefined && !result.aborted && !signal.aborted) {
			// The platform stopped the turn at its step limit (platform-steps.ts), as Windlass stops at its own.
			outcome = "unresolved";
			stepLimit = result.acp.stepLimit;
			note(c, turn, "warn", stepLimitNote(harnessName(meta.harness), stepLimit));
		} else if (reason === "cancelled" || result?.aborted || signal.aborted) outcome = "stopped";
		// Checks the platform ran still failed, or could not start: the turn ends as Windlass's does then.
		else if (reason === "end_turn") outcome = result?.acp?.checks === "unresolved" ? "unresolved" : "succeeded";
		else if (reason === "max_tokens" || reason === "max_turn_requests") outcome = "unresolved";
		else if (reason === "refusal") outcome = "failed";
		else {
			outcome = "error";
			message = `${harnessName(meta.harness)} ended without a recognized stop reason.`;
		}
	} else if (result?.aborted || (!result && signal.aborted)) {
		outcome = "interrupted";
	} else if (result) {
		const failure = result.failure ?? null;
		// Windlass's own sentence about it; the layer may hand it over without a capital.
		const said = failure
			? str(failure.message)
					.trim()
					.replace(/^[a-z]/, letter => letter.toUpperCase())
			: "";
		const reported = summary?.outcome as TurnOutcome | undefined;
		if (failure?.reason === "auth_required" && account.provider && !account.plan) {
			outcome = "error";
			message = `Check your ${account.provider} key in Settings. ${said}`.trim();
		} else if (failure?.reason === "auth_required") {
			// No sign-in, one that could not be refreshed, or an access token the provider rejected: the remedy is the same.
			outcome = "error";
			message = `ChatGPT did not accept the saved sign-in. ${SIGN_IN_REMEDY}`;
		} else if (failure?.reason === "session_not_found") {
			outcome = "error";
			meta.windlassSessionId = null;
			message = `${said || "Windlass no longer has the session this agent was working in."}\nThe next prompt starts a new Windlass session; the files in the workspace are still there.`;
		} else if (failure?.reason === "host_tools_required") {
			outcome = "error";
			message = oldSandbox(meta.place.kind);
			if (active.item) active.item.refused = message;
		} else if (reported !== undefined && WINDLASS_OUTCOMES.includes(reported)) {
			// Windlass's own outcome stands. If the turn failed, its events in the timeline say how.
			outcome = reported;
			if (typeof summary?.stepLimit === "number") stepLimit = summary.stepLimit;
			// A token-refresh failure belongs to the platform even when Windlass supplies a generic failure.
			if (failure?.reason === "token_unavailable" && said) message = said;
		} else if (failure) {
			outcome = "error";
			const stderr = tail(result.stderrTail ?? "");
			message = said || failureMessage(result);
			if (said && stderr && !said.includes(stderr)) message = `${said}\n${stderr}`;
		} else {
			outcome = "error";
			message = failureMessage(result);
			if (result.exitCode === 2 && t.resumed && t.events === 0) {
				// Most likely Windlass no longer has the session we asked it to continue.
				meta.windlassSessionId = null;
				message += "\nThe next prompt starts a new Windlass session.";
			}
		}
	} else {
		outcome = reviewer && !active.item?.refused ? "interrupted" : "error";
		message = problem ?? "The turn could not be run.";
	}
	return { outcome, stepLimit, message };
}

/** Records the provider's usage reading for the turn and, when the provider refused it, the message and the item's retry. */
async function noteProviderOutcome(
	c: Ctx,
	t: TurnScope,
	outcome: TurnOutcome,
	message: string | null,
): Promise<string | null> {
	const { meta, active, account, result, startedAt } = t;
	await t.writingLimits;
	const refusal = turnRefusal(outcome, result, t.lastStepRefusal);
	const limitReading = limitObservation(refusal, Date.now());
	if (limitReading) await observe(c, t, limitReading);
	else if (outcome === "succeeded") await observe(c, t, { kind: "success", at: Date.now(), startedAt });
	// Claude Code's refusal names no reset; the plan's relay read it from the provider's headers (checklist L2).
	if (refusal && limitReading && refusal.resetsAt === undefined && account.plan && isPlanProvider(account.provider)) {
		const plan = await userActor(c, meta.uid)
			.internalPlanStatus(account.provider)
			.catch(() => null);
		if (plan?.health === "limited" && plan.resetKnown && plan.limitedUntil !== null)
			refusal.resetsAt = plan.limitedUntil;
	}
	if (refusal) {
		// Windlass describes a handed-in token to its host. Use the sandbox layer's remedy for its owner.
		if (!result?.acp && result?.failure?.reason === "auth_required" && message) {
			if ((account.provider && !account.plan) || refusal.message.includes("WINDLASS_ACCESS_TOKEN_FILE"))
				refusal.message = message;
			else if (!refusal.message.includes(SIGN_IN_REMEDY)) refusal.message += ` ${SIGN_IN_REMEDY}`;
		}
		const redactor = active.secrets?.redactor;
		const safe = redactor?.deep(refusal) ?? refusal;
		message = refusalMessage(safe);
		if (active.item) {
			const { text, fetchBase } = active.item.row;
			active.item.providerRefusal = {
				...safe,
				accountKey: t.generation === null ? undefined : accountKey(account, t.generation),
				placeName: placeNameOf(meta),
				retry: {
					text: redactor?.text(text) ?? text,
					fetchBase,
					...(active.item.row.untrusted.length && { untrusted: active.item.row.untrusted }),
				},
			};
		} else if (safe.kind === "invalid_request" || safe.kind.startsWith("model_")) {
			message += " You can change the model or reasoning effort with your next prompt.";
		}
	}
	return message;
}

/** Snapshot before publishing completion. If the snapshot fails, invalidate the previous copy. */
async function saveWorkspace(
	c: Ctx,
	t: TurnScope,
	caps: ReturnType<typeof capabilitiesOf>,
	used: SandboxHandle,
): Promise<void> {
	const { meta, turn, reviewer, result } = t;
	// The agent's session is copied out of the sandbox meanwhile, when the agent ran: both only read.
	const saving = caps.backups && result && t.layer ? saveBackup(c, meta, turn, used, t.layer) : undefined;
	const copied = reviewer || c.vars.stopping || c.vars.destroying ? null : await copyWorkspace(c, meta, used);
	if (!copied) await dropWorkspace(c);
	await saving;
}

async function closeReviewerSandbox(c: Ctx, t: TurnScope, layer: SandboxLayer, sandboxId: string): Promise<void> {
	const { meta, active, critic, requested } = t;
	try {
		if (
			active.item &&
			(critic || requested || active.item.withdrawn || active.item.refused || meta.review?.id === active.item.row.key)
		) {
			await removeSandbox(c, meta, sandboxId, "Removed the reviewer’s checkout at the end of its turn.");
		} else if (meta.sandbox === "running") {
			await layer.sandboxes.suspend(sandboxId);
			noteSandbox(c, meta, "paused");
			await closeMeter(c, meta, "now", useOf(meta));
		}
	} catch (error) {
		c.log.warn({
			msg: "could not close the reviewer sandbox; item cleanup or idle accounting will retry",
			error: describeError(error),
		});
	}
}

/**
 * A hosted turn paid by a plan whose provider lists no models (a Claude plan) keeps what its agent offered at the
 * session's start on the plan, for the pickers (credentials/plans.ts `recordAgentModels`). Best effort: a list that
 * does not arrive leaves the plan as it was.
 */
async function keepPlanModels(
	c: Ctx,
	meta: SessionMeta,
	key: CredentialRef | undefined,
	models: ModelList | null | undefined,
): Promise<void> {
	if (!key?.plan || meta.place.kind !== "hosted" || !models?.models.length) return;
	try {
		await modelKeyActor(c, meta.uid).internalPlanModels(
			key,
			models.models.map(m => m.id),
		);
	} catch (error) {
		c.log.warn({ msg: "could not keep the models the plan's agent reported", error: describeError(error) });
	}
}

/** Records the turn's outcome, saves its workspace, appends `turn.ended` and returns the session to idle, whatever goes wrong. */
export async function closeTurn(
	c: Ctx,
	t: TurnScope,
	segmentUsage: TurnUsage | null,
	modelKey: ModelKeySpend | undefined,
): Promise<void> {
	const { meta, active, turn, run, reviewer, startedAt } = t;
	try {
		const caps = capabilitiesOf(meta.harness);
		const result = t.result;
		const summary = result?.summary ?? null;
		// Windlass's summary event, or what an ACP agent answered its prompt with; with what the turn's earlier segments used.
		const usage = addUsage(run?.usage ?? null, segmentUsage);
		// Settle all reported requests before this turn's completion can admit more work.
		if (usesPlatformModel(meta.harness, meta.model)) {
			await serial(c, () => writeItems(c));
			await sendOutbox(c, meta.uid);
		}
		const decided = turnOutcome(c, t, caps, summary);
		const { outcome, stepLimit } = decided;
		await keepPlanModels(c, meta, run?.credential?.key, result?.acp?.models);
		const message = await noteProviderOutcome(c, t, outcome, decided.message);
		if (result?.windlassSessionId && (result.acp || outcome !== "error"))
			meta.windlassSessionId = result.windlassSessionId;

		const used = t.used;
		if (used && !meta.readiness) await saveWorkspace(c, t, caps, used);

		// What the session's work rests on now, from what Windlass recorded of this turn's checks; a turn the platform could not run failed before any.
		const saved = reviewer ? [] : (active.secrets?.checks ?? []);
		let verified =
			caps.checks === "none" ? null : active.checks.verified(turn, saved, result?.checks, meta.verified ?? null);
		if (outcome === "error" && verified?.state === "stopped") verified = { ...verified, state: "failed" };
		meta.verified = verified;

		// Report the resumed segment before publishing turn.ended. A warm sandbox still needs a hold for its idle time.
		if (active.resume && used && !reviewer && meta.sandbox === "running" && meta.meter && !active.outOfTime) {
			const answer = await metered(c, () => takeHold(c, meta, false));
			if (answer && !answer.ok && answer.reason === "allowance") active.outOfTime = true;
		}

		c.vars.pending = [];
		append(c, {
			turn,
			kind: "turn.ended",
			outcome,
			exitCode: result?.exitCode ?? null,
			steps:
				typeof summary?.steps === "number"
					? summary.steps
					: typeof result?.acp?.steps === "number"
						? result.acp.steps
						: null,
			// A turn that was paused ran in segments: their running time, without the pauses.
			durationMs:
				run && run.resumes > 0
					? run.activeMs + (Date.now() - run.segmentAt)
					: typeof summary?.durationMs === "number"
						? summary.durationMs
						: Date.now() - startedAt,
			usage,
			...(modelKey && { modelKey }),
			...(caps.usage === "context" ? { context: result?.acp?.usage ?? null } : {}),
			...(caps.events === "acp" && meta.windlassSessionId ? { sessionId: meta.windlassSessionId } : {}),
			cachedShare: typeof summary?.cachedShare === "number" ? summary.cachedShare : null,
			message,
			verified,
		});
		if (reviewer && t.layer && meta.sandboxId) await closeReviewerSandbox(c, t, t.layer, meta.sandboxId);
		meta.status = "idle";
		meta.lastOutcome = outcome;
		meta.updatedAt = Date.now();
		meta.lastUsedAt = meta.updatedAt;
		meta.turnStartedAt = null;
		meta.run = null;
		// In the step that lets the next prompt in: what this turn leaves to settle is the hold it has now.
		t.meterUse = useOf(meta);
		c.vars.closingItem = active.item?.row.key;
		c.vars.turn = null;
		publish(c);
		if (outcome === "error") await refreshSandbox(c, meta);
		// Probe unpublished commits before idle suspension.
		const unpushed =
			!reviewer && !meta.readiness && meta.repo && used
				? await unpushedWork(c, meta, meta.repo, c.vars.workspace?.files ?? null).catch(() => null)
				: null;
		// The agent had the platform publish in this turn, before the turn's checks ran, and nothing changed since: the pull request's description is told what they came to.
		if (active.published && unpushed === false && used) await t.hooks.describeAfterTurn(c, meta, used, turn);
		if (active.item)
			await t.hooks.itemTurnEnded(c, meta, active.item, {
				outcome,
				itemSignIn: t.itemSignIn,
				credential: t.credential,
				stepLimit,
				verified,
				used,
				unpushed,
				usage,
				checks: active.secrets?.checks ?? [],
				acp: result?.acp,
			});
		await persist(c);
		await within(c.vars.reporting, REPORT_WAIT_MS);
	} catch (error) {
		// Whatever went wrong while closing the turn, the session must not stay "running".
		c.log.error({ msg: "could not close the turn cleanly", error: describeError(error) });
		meta.status = "idle";
		meta.lastUsedAt = Date.now();
		meta.turnStartedAt = null;
		meta.run = null;
		if (c.vars.turn === active) t.meterUse = useOf(meta);
		c.vars.turn = null;
		c.vars.pending = [];
		publish(c);
		await persist(c);
	}
}

/** Gives back the sandbox, settles the meter and idle timers, and re-admits a review delivery that found the session busy. */
export async function settleAfterTurn(c: Ctx, t: TurnScope, release: () => void): Promise<void> {
	const { meta, active, reviewer } = t;
	delete c.vars.closingItem;
	// Given back before what follows the turn for its time: a sandbox out of time is suspended there.
	release();
	await meterAfterTurn(c, meta, active, t.meterUse);
	// The idle times count from here.
	await armIdle(c, meta);
	// A requested review and a second review share this session. Re-admit a delivery that found it busy.
	if (reviewer && !c.vars.turn) {
		const next = (await waitingRows(c.db)).find(row => row.key !== active.item?.row.key);
		if (next) void c.keepAwake(t.hooks.askForSlot(c, meta, next));
	}
}
