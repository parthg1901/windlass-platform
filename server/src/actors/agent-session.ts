// agentSession owns one sandbox and its turns, keyed by [uid, sessionId].
// The active turn holds credentials in memory. The timeline queue commits redacted items
// and runner receipts in order so reconnects resume after the last durable sequence.
import { digest } from "../sandbox/snapshot-key.js";
import { actor, event, UserError } from "rivetkit";
import { PUBLISH_SESSION, publishUnaskedProblem, publishAsksEveryTime } from "../agent-publish.js";
import { db } from "rivetkit/db";
import {
	assertOrigin,
	authenticate,
	clientError,
	describeError,
	isSandboxUserError,
	checkGeneration,
	disconnectRevoked,
	requireService,
	requireServiceFor,
} from "../auth.js";
import { config } from "../config.js";
import {
	promptTitle,
	isMachineIdName,
	machineLabel,
	type LiveDelta,
	MAX_NOTE_CHARS,
	MAX_PROMPT_CHARS,
	MAX_REMEMBERED_SUBMISSIONS,
	type PendingQuestion,
	type PromptInput,
	type PublishMessage,
	type PublishResult,
	type PublishState,
	type HostAllowed,
	type SessionServers,
	type SessionSnapshot,
	type SetRequestedSecretInput,
	type SessionSummary,
	type TimelineItem,
	type TurnUsage,
	type WindlassEvent,
	type WorkspaceFile,
	WIDE_HOSTS,
	type HostedSize,
	isHostedSize,
	SESSION_HOSTED_SIZE,
	PLAN_ASK,
	PLAN_LIMITED,
	type HarnessId,
} from "../contract.js";
import { billing } from "../billing/config.js";
import type { BlockedNetwork, NetworkBlockedItem, PullRequestInfo } from "../contract.js";
import { githubApp } from "../github/app.js";
import { materializeInput, removeInputs } from "../github/git.js";
import { INPUTS_DIRECTORY } from "../factory/cross-repo.js";
import { OFFLINE_REPOSITORY } from "../runner/egress.js";
import { HOSTED_OFFLINE_REPOSITORY, isHostName } from "../sandbox/hosted-network.js";
import { BaseMergeConflict, describePull, openFromPushed } from "../github/publish.js";
import { GithubProblem, resolveBoundRepository } from "../github/repos.js";
import { runPlace } from "../factory/resolve-run.js";
import { ModelProblem, chosenModel, standInModels, turnEffort } from "../account-models.js";
import type { SandboxHandle, TurnCheckpoint } from "../sandbox/api.js";
import { MachineUnreachable, machineActor } from "../sandbox/runner-layer.js";
import { forgetConversation, migrateJournal, readCheckpoint, readConversation } from "../runner/journal.js";
import { stopCutOffSetup } from "../sandbox/setup.js";
import { ACCOUNT_SECRET_PROJECT } from "../account-secrets.js";
import {
	NO_REDACTION,
	SecretProblem,
	validRequestedSecretName,
	cleanSecretValue,
	sealSecret,
	commandSandbox,
} from "../repo-secrets.js";
import { SERVER_START, serverForgottenNote, serverPanelApprovedNote } from "../server-question.js";
import { setupProjectOf } from "../setup-command.js";
import { Attempts, type Submission, SubmissionProblem, isRepeat, submissionOf } from "../submissions.js";
import { VerificationLog } from "../verified.js";
import { serverSealer } from "../signin/seal.js";
import { agentTurn, turnUsd, windowShare } from "../factory/budget.js";
import { modelPrices } from "../model-prices.js";
import { turnMeter } from "../factory/cost.js";
import { cutTurnUsage, cutTurnUsageNote, usesPlatformModel, freedNote, hostedLimitsApply } from "../usage.js";
import { type BaseTestResult, type NamedTests } from "../factory/base-tests.js";
import {
	itemActor,
	modelKeyActor,
	grantIsValid,
	secretsActor,
	type ForkSource,
	type SessionCreateInput,
	userActor,
} from "./internal.js";
import { attachmentStore } from "../sandbox/attach.js";
import type { FeedbackNotice } from "./github-inbox.js";
import { batchText, feedbackWords, fits, oversizedFeedback } from "../factory/feedback.js";
import { recentSubject } from "../factory/intake.js";
import { untrustedWords } from "../factory/untrusted.js";
import type { Fact } from "../factory/types.js";
import { remoteLease, type RemoteLease } from "../sandbox/relay-leases.js";
import { plansAllowed } from "../credentials/plans.js";
import { AcpPromptRequired } from "../sandbox/acp-harness.js";
import { initialSessionModes } from "../sandbox/profiles.js";
import { codexModes, innerModesReason } from "../sandbox/codex-modes.js";
import {
	windlassProvider,
	hostedKeyMessage,
	selectedKey,
	machinePayerProblem,
	withSettingsKeys,
	harnessName,
	machineHarness,
	machineHarnesses,
	listedHarness,
	initialHarnessModels,
	machineLoginMessage,
} from "../sandbox/harnesses.js";
import { capabilitiesOf } from "../sandbox/harness.js";
import { privateSessionData } from "../sandbox/session-data.js";
import type { ItemPublishAnswer } from "./work-item.js";
import {
	CRASHES_ALLOWED,
	type TurnRun,
	type TurnCredential,
	pausedLine,
	resumePrompt,
	resumedLine,
} from "./turn-resume.js";
import {
	type EndedFact,
	type InboxRow,
	reviewEndedFactOf,
	INBOX_TABLES,
	OUTBOX_ACTION,
	deliveryOf,
	endedFact,
	endedFactOf,
	flushOutbox,
	inboxRow,
	machineUnavailable,
	markEnded,
	markTaken,
	publishReceipt,
	queueMessage,
	receive,
	rememberPublish,
	requestTurn,
	requeue,
	rowOfTurn,
	sendOutbox,
	settleTokenReceipts,
	turnChanges,
	waitingRows,
	withdrawWaiting,
} from "./session-inbox.js";
import { persist, note, append, serial, writeItems, writeMeta } from "./agent-session/timeline.js";
import {
	takeQuestion,
	duration,
	abortTurn,
	sessionServers,
	serverApprovals,
	serversChanged,
} from "./agent-session/questions.js";
import type { Ctx, SessionMeta, ActiveTurn, PromptAnswer, FeedbackPrompt, SessionVars } from "./agent-session/state.js";
import { runnerLink, layerOf, durableTurns, isRunnerSocket } from "./agent-session/runner.js";
import { publish, summaryOf, report } from "./agent-session/summary.js";
import { removeBackup } from "./agent-session/workspace.js";
import { continuationMeta, forkSource } from "./agent-session/continuation.js";
import {
	TurnProblem,
	githubConnection,
	itemPrompt,
	within,
	takeSandbox,
	sandboxChanged,
	busy,
	PlanWaitError,
} from "./agent-session/common.js";
import { PAY_WITH_HARNESSES } from "../pay-with.js";
import type { PayerAnswer } from "./user-payer.js";
import { readSecrets, sessionRedactor } from "./agent-session/secrets.js";
import { childSetupSeed } from "./agent-session/setup.js";
import {
	removeSandbox,
	useOf,
	armIdle,
	holdSandbox,
	settleWokenAsk,
	wakeMeter,
	sleepMeter,
	leaveUsage,
	idleCheck,
	releasePlace,
} from "./agent-session/meter.js";
import {
	destroySessionSandboxes,
	refreshSandbox,
	workspaceView,
	readFiles,
	readDiff,
	sweepSandboxes,
} from "./agent-session/sandbox.js";
import {
	evidenceOf,
	checkPull,
	publishStateOf,
	cleanMessage,
	publishingSettled,
	PUBLISH_WAIT_MS,
	verifiedLine,
	PublishRefused,
	publishBlocked,
	publishSession,
	testSessionBase,
	fetchSessionBase,
	openGitlabItemPull,
} from "./agent-session/publish.js";
import {
	newTurnScope,
	startTurn,
	takeCredential,
	openTurnSandbox,
	checkHarness,
	choosePrompt,
	markRunning,
	turnTools,
	prepareSetup,
	prepareReview,
	reviewHandler,
	runAcpAgent,
	runWindlassAgent,
	recordFailure,
	windDown,
	endSegment,
	closeTurn,
	settleAfterTurn,
	planWindows,
	type ItemTurnEnd,
	type OfferedHarness,
	type TurnHooks,
} from "./agent-session/turn.js";
import {
	heartbeat,
	machinePaused,
	staleOnline,
	armResumeCheck,
	MACHINE_RECHECK_MS,
	originalPrompt,
	newRun,
	markPausing,
	resumesTurns,
	crashPause,
	stalePause,
} from "./agent-session/pause.js";

export { acpRecorder } from "./agent-session/timeline.js";
export { applySandboxClamp } from "./agent-session/meter.js";
export {
	STATUS_COMMAND,
	DIFF_COMMAND,
	observeNetwork,
	spareHead,
	readySetupItems,
	readyRecipe,
	canSeedOnResume,
} from "./agent-session/sandbox.js";
export { recordPushHead } from "./agent-session/publish.js";
export { noteTurnMemory } from "./agent-session/turn.js";

/** How long shutdown waits for a stopped turn to wind down. */
const STOP_WAIT_MS = 10_000;
/** A slow machine actor may delay profile availability, but the session timeline must still open. */
const PROFILE_WAIT_MS = 2_000;

// Reserve shutdown time for both SQLite saves after the bounded waits.
export const SHUTDOWN_GRACE_MS = 20_000;
const SUSPEND_WAIT_MS = 4_000;
const SETTLE_WAIT_MS = 2_000;
const SLEEP_MARGIN_MS = 4_000;
if (STOP_WAIT_MS + SUSPEND_WAIT_MS + SETTLE_WAIT_MS + SLEEP_MARGIN_MS > SHUTDOWN_GRACE_MS) {
	throw new Error("The waits of going to sleep add up to more than the shutdown grace period.");
}

/** Agent-session sockets can outlive a browser login and can be served on a different host. */
async function sessionCaller(c: { key: string[]; client(): unknown }, params: unknown) {
	const caller = authenticate(c.key, params);
	if (caller.kind === "user") checkGeneration(caller, await userActor(c, c.key[0]).internalTokenGeneration());
	return caller;
}

/** The caller, who must be the session's user; answers with their id. */
async function requireSessionUser(c: {
	key: string[];
	vars: SessionVars;
	client(): unknown;
	conn?: { params: unknown } | null;
}): Promise<string> {
	const caller = await sessionCaller(c, c.conn?.params);
	if (caller.kind !== "user") throw new UserError("This action is for users.", { code: "forbidden" });
	if (c.vars.meta?.readiness) throw new UserError("Open Repo setup on the repository overview.", { code: "forbidden" });
	return caller.profile.uid;
}

async function maySubscribe(c: Parameters<typeof requireSessionUser>[0]): Promise<boolean> {
	try {
		await requireSessionUser(c);
		return true;
	} catch {
		return false;
	}
}

function liveMeta(c: Ctx): SessionMeta {
	const meta = c.vars.meta;
	if (!meta || c.vars.destroying) throw new UserError("That agent does not exist.", { code: "session_not_found" });
	return meta;
}

/** `WLP_PLAN_USERS` leaves this user out: hosted Windlass on the ChatGPT plan is refused. */
export const CHATGPT_PLAN_OFF =
	"Your ChatGPT plan isn't enabled for hosted runs on this account. Run this agent on your own machine, or choose a model of a Settings key (such as openai/…).";
const CHATGPT_PLAN_MISSING =
	"Connect your ChatGPT plan to run Windlass here: run npx @windlassai/cli connect codex, or choose a model of a Settings key (such as openai/…).";

/**
 * Hosted Windlass's unqualified models run on the ChatGPT plan, pinned like any plan and behind the same kill switch
 * (`WLP_PLAN_USERS`, which `internalCredentialGeneration` applies too). A demo calls no model, and an environment
 * build runs no agent: neither pins one. When the plan is limited, Pay with's "When limited" holds as for a plan agent
 * (user-payer.ts): an item waits for the reset, a person is asked, and "use my key" (`keyOnce`) runs this one turn on
 * the OpenAI key's version of the model (`openai/<model>`), where a saved key offers it.
 */
async function chatgptPlanCredential(
	c: Ctx,
	meta: SessionMeta,
	model: string,
	keyOnce?: boolean,
): Promise<TurnCredential> {
	if (meta.demo || meta.environmentBuild) return { model };
	const answer = await userActor(c, meta.uid).internalTurnPayer({ sessionId: meta.sessionId, model, keyOnce });
	// The key Pay with chose ("use my key" this once, or the rule) pays whether or not the plan could.
	if (answer && "pay" in answer.decision && answer.ref && !answer.ref.plan) return payerCredential(meta, answer, model);
	if (!plansAllowed(meta.uid)) {
		// The person sees CHATGPT_PLAN_OFF; the operator, the setting that decides it.
		console.log(`[wlp] plan.off uid=${meta.uid} session=${meta.sessionId}: WLP_PLAN_USERS does not name this user`);
		throw new UserError(CHATGPT_PLAN_OFF, { code: "harness_signed_out" });
	}
	const ref = { provider: "openai", plan: true } as const;
	const generation = await modelKeyActor(c, meta.uid).internalCredentialGeneration(ref);
	if (!generation) throw new UserError(CHATGPT_PLAN_MISSING, { code: "chatgpt_required" });
	if (answer) return payerCredential(meta, answer, model);
	return { model, key: { ...ref, generation } };
}

/**
 * Pay with's answer as the turn's credential (user-payer.ts): what pays, or the refusal a person's prompt or an item's
 * turn shows: `PLAN_ASK` (wait, or the key this time), `PLAN_LIMITED` (wait), or nothing can pay. A key paying for
 * Windlass's ChatGPT model runs the key's version of it (`keyModel`), for this turn only.
 */
function payerCredential(meta: SessionMeta, answer: PayerAnswer, model: string): TurnCredential {
	const { decision } = answer;
	if ("pay" in decision && answer.ref) return { model: answer.keyModel ?? model, key: answer.ref };
	if ("ask" in decision) throw new UserError(decision.ask.sentence, { code: PLAN_ASK });
	if ("wait" in decision) {
		if (meta.origin?.kind !== "item") throw new UserError(decision.wait.sentence, { code: PLAN_LIMITED });
		throw new PlanWaitError(decision.wait.sentence, decision.wait.retryAt, answer.plan ?? undefined);
	}
	throw new UserError("refuse" in decision ? decision.refuse : "Nothing can pay for this turn.", {
		code: "harness_signed_out",
	});
}

/**
 * Windlass's unqualified models on a machine: the ChatGPT plan, pinned like a hosted turn's, its token handed to the
 * plan relay on the machine. Not behind `WLP_PLAN_USERS` (`planAllowed`): the requests leave from the user's machine.
 */
async function machineChatgptPlan(c: Ctx, meta: SessionMeta, model: string): Promise<TurnCredential> {
	if (meta.demo || meta.environmentBuild) return { model };
	const ref = { provider: "openai", plan: true } as const;
	const generation = await modelKeyActor(c, meta.uid).internalCredentialGeneration(ref, true);
	if (!generation) throw new UserError(CHATGPT_PLAN_MISSING, { code: "chatgpt_required" });
	return { model, key: { ...ref, generation } };
}

/**
 * Whether Pay with decides a plan agent's turn on a machine, as it does hosted: a plan's token goes to the plan relay
 * there. Only a login of the agent's own kept on the machine wins (Claude Code's `windlass-runner login claude`).
 */
export function machinePaysWith(harness: HarnessId, offered: Pick<OfferedHarness, "signIn"> | undefined): boolean {
	return PAY_WITH_HARNESSES.includes(harness) && offered?.signIn !== "token";
}

/**
 * What pays for a turn. Hosted, Pay with decides for every agent (user-payer.ts), and Windlass's ChatGPT models pay
 * with the ChatGPT plan. On a machine, a plan agent follows Pay with too (its plan's token goes to the plan relay there)
 * unless its own login is kept there; OpenCode pays with its own logins there and a Settings key for other providers.
 */
export async function turnCredential(
	c: Ctx,
	meta: SessionMeta,
	offered: OfferedHarness | undefined,
	model: string,
	signal?: AbortSignal,
	pinned?: TurnCredential,
	keyOnce?: boolean,
): Promise<TurnCredential> {
	const hosted = meta.place.kind === "hosted";
	const harness = meta.harness ?? "windlass";
	// A hosted Windlass turn paused before it paid with the ChatGPT plan pinned nothing: it pins the plan now.
	if (pinned && !pinned.key && hosted && harness === "windlass" && !windlassProvider(pinned.model))
		return chatgptPlanCredential(c, meta, pinned.model);
	if (pinned) {
		const key = pinned.key;
		if (key && !key.plan && meta.place.kind === "machine" && machineHarness(meta.harness) && !offered?.keyRelay)
			throw new UserError("This runner cannot relay the Settings key for the paused turn.", {
				code: "harness_signed_out",
			});
		if (key) {
			const ref = { provider: key.provider, ...(key.plan && { plan: true as const }) };
			const onMachine = meta.place.kind === "machine";
			if ((await modelKeyActor(c, meta.uid).internalCredentialGeneration(ref, onMachine)) !== key.generation)
				throw new UserError(
					`The ${key.plan ? "plan" : "Settings key"} for this turn changed or was removed. Start a new turn.`,
					{ code: "harness_signed_out" },
				);
		}
		return pinned;
	}
	if (harness === "windlass") {
		const provider = windlassProvider(model);
		if (!provider) {
			if (hosted) return chatgptPlanCredential(c, meta, model, keyOnce);
			return machineChatgptPlan(c, meta, model);
		}
		const generation = await modelKeyActor(c, meta.uid).internalCredentialGeneration({ provider });
		if (!generation) throw new UserError(hostedKeyMessage(harness, model), { code: "harness_signed_out" });
		return { model, key: { provider, generation } };
	}
	if (hosted) {
		if (harness === "opencode" && model === "default") model = meta.harnessModels?.defaultModel ?? model;
		const answer = await userActor(c, meta.uid).internalTurnPayer({ sessionId: meta.sessionId, model, keyOnce });
		if (!answer) throw new UserError(hostedKeyMessage(harness, model), { code: "harness_signed_out" });
		return payerCredential(meta, answer, model);
	}
	const machineName = c.vars.runner?.known?.name || meta.machineName || "your machine";
	if (machinePaysWith(harness, offered)) {
		const answer = await userActor(c, meta.uid).internalTurnPayer({
			sessionId: meta.sessionId,
			model,
			keyOnce,
			machine: true,
		});
		if (answer) return payerCredential(meta, answer, model);
		throw new UserError(machineLoginMessage(machineHarnesses[harness as keyof typeof machineHarnesses], machineName), {
			code: "harness_signed_out",
		});
	}
	// Its own login on the machine pays; OpenCode's Settings keys pay for the providers it has no login for there.
	const keys = offered?.keyRelay ? await modelKeyActor(c, meta.uid).internalModelKeys() : [];
	const listed =
		offered &&
		listedHarness(
			offered,
			keys.map(k => k.provider),
		);
	const providers = listed?.platformKeys ?? [];
	const problem = listed
		? machinePayerProblem(listed, model, providers, meta.origin?.kind === "item" ? machineName : undefined)
		: "The selected machine agent is unavailable.";
	if (problem) throw new UserError(problem, { code: "harness_signed_out" });
	// Without a login of its own there, its default model is one a key can run.
	if (
		harness === "opencode" &&
		model === "default" &&
		meta.place.kind === "machine" &&
		offered?.signIn !== "token" &&
		providers.length
	)
		model = await runnerLink(c, meta.place.machineId).request("openCodeDefault", { providers }, { signal });
	const provider = selectedKey(harness, model, providers);
	const key = keys.find(k => k.provider === provider);
	return { model, key };
}

/** Persist admission before any server forwards the request. A resumed segment inherits the balance. */
export function takeTurnRequest(c: Ctx, meta: SessionMeta, run: TurnRun, active: ActiveTurn) {
	return serial(c, async () => {
		if (active.controller.signal.aborted || meta.run !== run || c.vars.turn !== active || !run.remainingRequests)
			return false;
		run.remainingRequests--;
		await c.db.execute(
			"UPDATE meta SET data = json_set(data, '$.run.remainingRequests', ?) WHERE id = 1",
			run.remainingRequests,
		);
		return true;
	});
}

/** Runs one accepted turn to its `turn.ended`. `release` gives back the sandbox its acceptance took (`takeSandbox`). Never rejects. */
async function runTurn(
	c: Ctx,
	meta: SessionMeta,
	active: ActiveTurn,
	text: string,
	release: () => void,
): Promise<void> {
	const machine = meta.place.kind === "machine" ? machineActor(() => c.client(), meta.uid, meta.place.machineId) : null;
	// A turn that can be resumed keeps its wake from the start, while its sandbox is still being had as well.
	if (meta.run?.turn === active.number) heartbeat(c, true);
	try {
		await executeTurn(c, meta, active, text, release, machine);
	} finally {
		if (machine)
			await machine
				.releaseSlot(meta.sessionId, active.number)
				.catch(error => c.log.warn({ msg: "could not release machine turn slot", error: describeError(error) }));
		startNextFeedback(c, meta);
		// A build reports once its turn has closed: the user's actor deletes the session on it.
		if (meta.readiness) reportAssessment(c, meta);
		if (meta.environmentBuild) {
			const result = c.vars.environmentResult ?? { interrupted: true };
			void c.keepAwake(
				userActor(c, meta.uid)
					.internalEnvironmentResult(meta.sessionId, result)
					.catch(error => c.log.warn({ msg: "could not report the environment build", error: describeError(error) })),
			);
		}
	}
}

function reportAssessment(c: Ctx, meta: SessionMeta) {
	void c.keepAwake(
		userActor(c, meta.uid)
			.internalReadinessResult(
				meta.sessionId,
				meta.readiness!.attempt,
				meta.readiness?.result ?? meta.readiness?.error ?? null,
				meta.readiness?.diagnosis ?? null,
			)
			.catch(error => c.log.warn({ msg: "could not save the readiness assessment", error: describeError(error) })),
	);
}

/**
 * Runs one turn's phases (agent-session/turn.ts) in order:
 * start (save, machine slot, clock and limit) → credential → secrets and sandbox → harness checks → prompt choice
 * → tools and inputs (repo setup, review checkout) → agent run (ACP or Windlass); a failure in any of them is recorded,
 * then wind down → pause a cut-short resumable turn, or close it (outcome, workspace, `turn.ended`) → settle the meter.
 */
async function executeTurn(
	c: Ctx,
	meta: SessionMeta,
	active: ActiveTurn,
	text: string,
	release: () => void,
	machine: ReturnType<typeof machineActor> | null,
): Promise<void> {
	const t = newTurnScope(c, meta, active, text, machine, TURN_HOOKS);
	try {
		await startTurn(c, t);
		const { layer, credential, takeRequest } = await takeCredential(c, t);
		const sandbox = await openTurnSandbox(c, t, layer);
		const checked = await checkHarness(c, t, layer, sandbox, credential);
		const summary = await choosePrompt(c, t);
		markRunning(c, t);
		const launch = await turnTools(c, t, { layer, sandbox, credential, takeRequest, ...checked, summary });
		if (launch.setup) await prepareSetup(c, t, launch, launch.setup);
		if (t.reviewer && (t.checkout || t.critic) && launch.item) await prepareReview(c, t, launch, launch.item);
		launch.onReview = reviewHandler(c, t, launch);
		if (!t.signal.aborted && launch.caps.events === "acp") await runAcpAgent(c, t, launch);
		else if (!t.signal.aborted) await runWindlassAgent(c, t, launch);
	} catch (error) {
		await recordFailure(c, t, error);
	}
	await windDown(c, t);
	const segment = await endSegment(c, t);
	if (segment.paused) {
		release();
		return;
	}
	heartbeat(c, false);
	await closeTurn(c, t, segment.segmentUsage, segment.modelKey);
	await settleAfterTurn(c, t, release);
}

const TURN_HOOKS: TurnHooks = {
	turnCredential,
	takeTurnRequest,
	itemTurnStarted,
	itemTurnEnded,
	describeAfterTurn,
	askForSlot,
};

// Update the verified section after an agent push only while the current head still matches its receipt.
async function describeAfterTurn(c: Ctx, meta: SessionMeta, sandbox: SandboxHandle, turn: number): Promise<void> {
	const app = githubApp();
	const { repo, pull } = meta;
	if (!app || !repo || repo.provider === "gitlab" || !pull) return;
	try {
		const described = await describePull({
			app,
			connection: await githubConnection(c, meta),
			repository: repo,
			sandbox,
			pull,
			evidence: await evidenceOf(c, meta, null),
		});
		if (described === null || meta.pull !== pull) return;
		meta.pull = described;
		note(
			c,
			turn,
			"info",
			`The description of pull request #${described.number} now says what this turn's checks came to: ${described.verified}.`,
		);
		publish(c);
	} catch (error) {
		c.log.warn({
			msg: "could not write what the turn's checks came to into the pull request",
			session: meta.sessionId,
			error: describeError(error),
		});
	}
}

// A surviving machine process must reattach to its persisted conversation and checkpoint.
async function takeUpTurn(c: Ctx, meta: SessionMeta): Promise<boolean> {
	if (meta.place.kind !== "machine") return false;
	try {
		const [conversation, saved] = durableTurns(c)
			? await Promise.all([readConversation(c.db), readCheckpoint<TurnCheckpoint>(c.db)])
			: [null, null];
		if (
			!conversation ||
			!saved ||
			saved.turn !== meta.turns ||
			saved.data.harness !== (meta.harness ?? "windlass") ||
			c.vars.runner
		) {
			await forgetConversation(c.db);
			return false;
		}
		c.vars.restored = conversation;
		const link = runnerLink(c, meta.place.machineId);
		if (!link.hold(saved.data.process)) {
			link.close();
			c.vars.runner = null;
			await forgetConversation(c.db);
			return false;
		}
		const row = await rowOfTurn(c.db, meta.turns);
		const run = row ? Number(row.key.split(":")[1]) : null;
		const active: ActiveTurn = {
			number: meta.turns,
			effort: null,
			controller: new AbortController(),
			done: Promise.resolve(),
			control: null,
			question: null,
			unsettled: new Set(),
			aside: [],
			recalled: new Map(),
			stopping: false,
			closed: false,
			secrets: null,
			checks: new VerificationLog(),
			publishes: new Set(),
			reattach: saved.data,
			...(row && {
				item: {
					row: { ...row, slot: row.slot ?? "" },
					report: meta.report && meta.report.run === run ? meta.report : null,
					full: null,
					started: true,
					pushedAtStart: meta.pushedHead ?? null,
				},
			}),
		};
		c.vars.turn = active;
		console.log(
			`[wlp] turn.take_up session=${meta.sessionId} turn=${meta.turns} machine=${meta.place.machineId}: the server stopped while the turn ran; taking its process up again`,
		);
		active.done = c.keepAwake(
			runTurn(c, meta, active, "", takeSandbox(c)).finally(() => {
				// A process the turn never took up (it could not go on) is stopped on the runner.
				c.vars.runner?.release();
			}),
		);
		return true;
	} catch (error) {
		c.log.warn({
			msg: "could not take up the machine turn after the restart; it is cut short",
			error: describeError(error),
		});
		return false;
	}
}

/** Whether going to sleep keeps the running turn for the next server: a machine turn that can be taken up, on a runner that keeps it through the grace. */
function keepsTurn(c: Ctx): boolean {
	const link = c.vars.runner;
	return !!link?.durable && link.known?.report?.resumableConversation === true && !!c.vars.turn?.checkpoint?.();
}

// Persist the last acknowledged frame and checkpoint before detaching a runner kept through sleep.
async function keepTurn(c: Ctx): Promise<boolean> {
	if (!keepsTurn(c)) return false;
	const link = c.vars.runner!;
	await persist(c);
	await c.vars.journal?.settle();
	await c.schedule.at(Date.now() + 3_000, "internalTakeUp").catch(() => undefined);
	c.vars.journal?.close();
	link.abandon();
	console.log(
		`[wlp] turn.kept session=${c.key[1]} turn=${c.vars.turn?.number}: the runner keeps the turn's process through the restart`,
	);
	return true;
}
/** How soon a resume that could not happen (the user's actor or the layer did not answer) is tried again. */
const RESUME_RETRY_MS = 60_000;
/** The most messages held for a paused turn. */
const MAX_HELD = 20;

// Resume the same turn only after admission succeeds again.
async function resumePaused(c: Ctx, meta: SessionMeta, granted: string | null = null): Promise<boolean> {
	const run = meta.run;
	if (
		!run?.paused ||
		meta.status !== "paused" ||
		c.vars.turn ||
		c.vars.accepting ||
		c.vars.resuming ||
		c.vars.stopping ||
		c.vars.destroying ||
		c.vars.publishing
	)
		return false;
	// A graceful pause resumes WLP_TURN_RESUME_DELAY_MS after it at the earliest (whichever server is up then): its wake comes then.
	if (run.paused.reason === "restart" && Date.now() < run.paused.at + config.turnResume.delayMs) {
		await c.schedule.at(run.paused.at + config.turnResume.delayMs, "internalResumeTurn").catch(() => undefined);
		return false;
	}
	let settled!: () => void;
	c.vars.resuming = new Promise<void>(resolve => {
		settled = resolve;
	});
	let release: (() => void) | null = takeSandbox(c);
	let requested: { key: string; slot: string } | null = null;
	try {
		if (c.vars.idling) await c.vars.idling.catch(() => undefined);
		const row = await rowOfTurn(c.db, run.turn);
		if (meta.place.kind === "machine") {
			const link = runnerLink(c, meta.place.machineId);
			const facts = await link.facts();
			if (meta.run !== run || !run.paused) return false;
			if (facts?.status === "removed") {
				await endPausedTurn(
					c,
					meta,
					"stopped",
					"This agent's machine was removed while the turn was paused, so the turn ended. Its files were there.",
				);
				return false;
			}
			if (facts?.status !== "online") {
				// A turn paused for a restart whose machine is away meanwhile waits for the machine.
				if (run.paused.reason === "restart") {
					run.paused.reason = "machine";
					note(c, run.turn, "info", pausedLine("machine", meta.machineName), { code: "turn_paused" });
					publish(c);
				}
				await machinePaused(c, meta, run);
				await persist(c);
				return false;
			}
			// Control can be online while the session socket is still unreachable. Keep the original
			// pause time until a socket answers, so failed attempts cannot reset the watchdog.
			try {
				await link.ready();
			} catch (error) {
				if (
					row &&
					error instanceof MachineUnreachable &&
					(await staleOnline(c, meta, run.paused)) &&
					meta.run === run &&
					run.paused
				) {
					await endPausedTurn(
						c,
						meta,
						"interrupted",
						"The machine is online but its runner could not reconnect this turn. The item was told to recover the interrupted step.",
					);
					return false;
				}
				throw error;
			}
			if (meta.run !== run || !run.paused || c.vars.stopping) return false;
		}
		let slot = row?.slot ?? null;
		if (row && (run.paused.slotFreed || !row.slot)) {
			// Asked for again, ahead of the turns that came since: the grant comes back here (`takeDelivered`).
			if (granted === null) {
				// The queue answers a duplicate request with the held slot. Don't reclaim the
				// old one while the outbox can still release it.
				const releasing = await c.db.execute(
					"SELECT 1 FROM outbox WHERE json_extract(message, '$.done.key') = ? LIMIT 1",
					row.key,
				);
				if (releasing.length) {
					await armResumeCheck(c, run.paused, RESUME_RETRY_MS);
					return false;
				}
				// Shutdown can lose the old segment's machine-slot release. Its own reservation
				// would count against the factory's free-slot check, before it could reclaim it.
				if (meta.place.kind === "machine")
					await machineActor(() => c.client(), meta.uid, meta.place.machineId).releaseSlot(meta.sessionId, run.turn);
				const answer = await requestTurn(c, meta.uid, row, null, meta.turnStartedAt ?? run.paused.at);
				if (!answer.granted) {
					if (meta.run !== run || !run.paused) return false;
					if (await staleOnline(c, meta, run.paused)) {
						await userActor(c, meta.uid).internalWithdrawTurn({ sessionId: meta.sessionId, key: row.key });
						if (meta.run === run && run.paused)
							await endPausedTurn(
								c,
								meta,
								"interrupted",
								"The machine is online but the paused turn could not reclaim its slot. The item was told to retry the step.",
							);
					} else if (run.paused) await armResumeCheck(c, run.paused, MACHINE_RECHECK_MS);
					return false;
				}
				granted = answer.slot;
				requested = { key: row.key, slot: granted };
			}
			slot = granted;
		}
		if (hostedLimitsApply(meta.place)) {
			// A scheduled resume may beat the wake's inspection, or come long after it. Settle a VM that
			// actually paused at its provider timestamp before taking the new hold. A warm VM counts through the gap.
			const runningAt = await refreshSandbox(c, meta, true);
			await holdSandbox(c, meta, true, runningAt);
		}
		const paused = run.paused;
		if (meta.run !== run || !paused || meta.status !== "paused" || c.vars.turn || c.vars.destroying) return false;
		const now = Date.now();
		const pausedMs = Math.max(0, now - paused.at);
		const original = row?.text ?? (run.prompted ? "" : await originalPrompt(c, run.turn));
		// Store the new slot before publishing an active turn. A failed write leaves a
		// paused turn to retry, and a restart can ask the queue for the same grant.
		if (row && (slot !== row.slot || paused.told))
			await serial(c, () =>
				c.db.transaction(
					async tx => {
						if (meta.run !== run || run.paused !== paused) return;
						if (slot !== row.slot)
							await tx.execute("UPDATE inbox SET slot = ? WHERE key = ? AND state = 'started'", slot, row.key);
						if (paused.told)
							await queueMessage(tx, {
								to: "item",
								itemId: row.itemId,
								fact: { kind: "turn_resumed", at: now, key: row.key, offlineMs: pausedMs },
							});
					},
					{ name: "inbox.resumed" },
				),
			);
		if (meta.run !== run || run.paused !== paused || c.vars.stopping || c.vars.destroying) return false;
		requested = null;
		// Include messages held during the asynchronous slot handoff.
		const held = run.held ?? [];
		const text = run.prompted
			? resumePrompt(paused.reason, held, run.stoppedCommand)
			: [original, ...held].join("\n\n");
		delete run.stoppedCommand;
		run.resumes += 1;
		run.fromSeq = c.vars.nextSeq;
		run.segmentAt = now;
		run.paused = null;
		run.held = [];
		meta.status = "starting";
		meta.updatedAt = now;
		note(c, run.turn, "info", resumedLine(paused.reason, pausedMs, duration), { code: "turn_resumed" });
		const key = row ? Number(row.key.split(":")[1]) : null;
		const active: ActiveTurn = {
			number: run.turn,
			effort: run.effort,
			...(run.planMode && { planMode: true }),
			controller: new AbortController(),
			done: Promise.resolve(),
			control: null,
			question: null,
			unsettled: new Set(),
			aside: [],
			recalled: new Map(),
			stopping: false,
			closed: false,
			secrets: null,
			checks: new VerificationLog(),
			publishes: new Set(),
			resume: { reason: paused.reason, pausedMs, held },
			...(row && {
				item: {
					row: { ...row, slot: slot ?? "" },
					report: meta.report && meta.report.run === key ? meta.report : null,
					full: null,
					started: true,
					pushedAtStart: meta.pushedHead ?? null,
				},
			}),
		};
		c.vars.turn = active;
		publish(c);
		// The wake after a crash, before anything of the segment runs: one that crashes at once is found again too (the loop guard counts it).
		await c.schedule.at(now + config.turnResume.heartbeatMs, "internalResumeTurn").catch(() => undefined);
		await persist(c);
		// Said once what was resumed is stored: a crash before this leaves the turn paused, as it was.
		console.log(
			`[wlp] turn.resumed session=${meta.sessionId} turn=${run.turn} reason=${paused.reason} paused_ms=${pausedMs} resumes=${run.resumes} prompted=${run.prompted === true}`,
		);
		if (row && paused.told) await flushOutbox(c, meta.uid).catch(() => sendOutbox(c, meta.uid));
		if (paused.reason === "machine" && meta.place.kind === "machine")
			void machineActor(() => c.client(), meta.uid, meta.place.machineId)
				.pausedSession(meta.sessionId, false)
				.catch(() => undefined);
		active.done = c.keepAwake(runTurn(c, meta, active, text, release));
		release = null;
		return true;
	} catch (error) {
		c.log.warn({ msg: "could not resume the paused turn", session: meta.sessionId, error: describeError(error) });
		if (error instanceof UserError && ["allowance_used", "too_many_sandboxes"].includes(String(error.code))) {
			await endPausedTurn(c, meta, "interrupted", `This turn could not resume: ${error.message}`);
		} else if (!c.vars.stopping && !c.vars.destroying && meta.run?.paused) {
			await armResumeCheck(c, meta.run.paused, RESUME_RETRY_MS).catch(error =>
				c.log.warn({ msg: "could not schedule a paused turn retry", error: describeError(error) }),
			);
		}
		return false;
	} finally {
		if (requested)
			await giveBack(c, meta, requested.key, requested.slot).catch(error =>
				c.log.warn({ msg: "could not return an unused resume grant", error: describeError(error) }),
			);
		c.vars.resuming = null;
		settled();
		release?.();
	}
}

// Closing a paused turn needs no sandbox process.
async function endPausedTurn(
	c: Ctx,
	meta: SessionMeta,
	outcome: "stopped" | "interrupted",
	message: string | null,
): Promise<void> {
	const run = meta.run;
	const turn = run?.turn ?? meta.turns;
	const now = Date.now();
	const usage = run?.usage ?? null;
	const machine = run?.paused?.reason === "machine";
	heartbeat(c, false);
	if (message) note(c, turn, outcome === "stopped" ? "info" : "warn", message);
	append(c, {
		turn,
		kind: "turn.ended",
		outcome,
		exitCode: null,
		steps: null,
		durationMs: run?.activeMs ?? 0,
		usage,
		cachedShare: null,
		message: null,
		verified: meta.verified ?? null,
	});
	meta.status = "idle";
	meta.lastOutcome = outcome;
	meta.updatedAt = now;
	meta.lastUsedAt = now;
	meta.turnStartedAt = null;
	meta.run = null;
	publish(c);
	console.log(`[wlp] turn.paused_ended session=${meta.sessionId} turn=${turn} outcome=${outcome}`);
	const row = await rowOfTurn(c.db, turn);
	if (row)
		await finishItemTurn(
			c,
			meta,
			row,
			meta.origin?.role === "reviewer"
				? reviewEndedFactOf(row.key, outcome, meta.review, null, null, usage)
				: endedFactOf(row.key, now, outcome, meta.verified ?? null, [], true, null, usage),
		);
	else await persist(c);
	if (machine && meta.place.kind === "machine")
		void machineActor(() => c.client(), meta.uid, meta.place.machineId)
			.pausedSession(meta.sessionId, false)
			.catch(() => undefined);
	await armIdle(c, meta);
	startNextFeedback(c, meta);
}

/** A message for a paused turn: kept with the turn, shown as held, and given to the agent when the turn resumes. */
async function holdMessage(
	c: Ctx,
	meta: SessionMeta,
	input: PromptInput,
	text: string,
	submission: Submission | null,
): Promise<PromptAnswer> {
	const redactor = await sessionRedactor(c, meta).catch(() => NO_REDACTION);
	const run = meta.run;
	// It resumed, or ended, while the secrets were read: the message goes as it would have then.
	if (meta.status !== "paused" || !run?.paused || c.vars.turn) return takePrompt(c, meta, input, text, submission);
	if ((run.held?.length ?? 0) >= MAX_HELD)
		throw new UserError(`${MAX_HELD} messages are held for this turn already; it takes more once it has resumed.`, {
			code: "steer_unavailable",
		});
	const shown = redactor.text(text);
	run.held = [...(run.held ?? []), shown];
	append(c, {
		turn: run.turn,
		kind: "user",
		text: shown,
		model: meta.model,
		effort: run.effort,
		steer: true,
		held: true,
	});
	meta.updatedAt = Date.now();
	publish(c);
	const answer = remember(meta, submission, { turn: run.turn, steered: true });
	await persist(c);
	return answer;
}

/** Stops the turn in progress, if any, and waits (a bounded time) until it has closed itself. */
async function stopTurn(c: Ctx): Promise<void> {
	const turn = c.vars.turn;
	if (!turn) return;
	if (c.vars.meta) abortTurn(c, c.vars.meta, turn);
	else turn.controller.abort();
	await persist(c);
	await within(turn.done, STOP_WAIT_MS);
}

/** What a key belongs to in a session, in the words of a refusal (submissions.ts). */
const KEYED = "message to this agent";

// Remember acceptance synchronously with the prompt so concurrent retries observe the same result.
function remember(meta: SessionMeta, submission: Submission | null, answer: PromptAnswer): PromptAnswer {
	if (submission)
		meta.submissions = [...(meta.submissions ?? []), { ...submission, ...answer }].slice(-MAX_REMEMBERED_SUBMISSIONS);
	return answer;
}

/** Serialize ACP prompt admissions so two refused steers cannot both start the same next turn. */
function queuePrompt(
	c: Ctx,
	meta: SessionMeta,
	input: PromptInput,
	message: string,
	submission: Submission | null,
): Promise<PromptAnswer> {
	const previous = c.vars.nextPrompt;
	const start = async () => {
		while (c.vars.turn) await c.vars.turn.done;
		return startPrompt(c, meta, input, message, submission);
	};
	const queued = previous ? previous.then(start, start) : start();
	c.vars.nextPrompt = queued;
	return queued.finally(() => {
		if (c.vars.nextPrompt === queued) {
			delete c.vars.nextPrompt;
			startNextFeedback(c, meta);
		}
	});
}

// An absent runner socket does not necessarily mean the machine is offline.
function machineAway(c: Ctx, meta: SessionMeta): boolean {
	return meta.place.kind === "machine" && c.vars.runner?.channel.connected !== true;
}

// Steering belongs to the running turn and does not acquire another slot.
async function steerTurn(
	c: Ctx,
	meta: SessionMeta,
	active: ActiveTurn | null,
	message: string,
	submission: Submission | null,
): Promise<PromptAnswer> {
	if (usesPlatformModel(meta.harness, meta.model)) {
		const wait = await userActor(c, meta.uid).internalDailyTokenWait();
		if (wait) throw new UserError(wait, { code: "daily_token_cap" });
	}
	const control = active?.control;
	const next = (turn: number) => {
		// An item's steps start its turns: a note that misses this one goes with the item's next.
		if (meta.origin) throw new UserError("The turn cannot take the note now.", { code: "steer_unavailable" });
		note(c, turn, "info", "Sent when this turn ends.");
		return queuePrompt(c, meta, { text: message }, message, submission);
	};
	if (active?.closed && capabilitiesOf(meta.harness).events === "acp") return next(active.number);
	const stopping = meta.status === "stopping" || active?.controller.signal.aborted === true || active?.closed === true;
	if (!active || !control || stopping || (meta.status !== "running" && meta.status !== "waiting")) {
		const state = stopping ? "is being stopped" : "is still starting";
		throw new UserError(`The turn ${state} and cannot take a message right now. Try again in a moment.`, {
			code: "steer_unavailable",
		});
	}
	// Refused before anything is sent or kept: queued behind a dead link, the message would arrive whenever the machine is back.
	if (machineAway(c, meta))
		throw new UserError("Your machine is not answering, so the message was not sent. Send it again when it is back.", {
			code: "steer_unavailable",
		});
	try {
		await control.steer(message);
	} catch (error) {
		if (error instanceof AcpPromptRequired) return next(active.number);
		c.log.warn({
			msg: "a running turn did not take a steered message",
			session: meta.sessionId,
			turn: active.number,
			error: describeError(error),
		});
		const why = isSandboxUserError(error) ? ` ${error.message}` : "";
		throw new UserError(`The running turn could not take the message.${why} Try again in a moment.`, {
			code: "steer_unavailable",
		});
	}
	if (active.closed && capabilitiesOf(meta.harness).events !== "acp") {
		// The turn ended while Windlass was taking the message; nothing can be added to a closed turn.
		throw new UserError("The turn ended just as the message arrived. Try again in a moment.", {
			code: "steer_unavailable",
		});
	}
	const shown = active.secrets?.redactor.text(message) ?? message;
	append(c, { turn: active.number, kind: "user", text: shown, model: meta.model, effort: active.effort, steer: true });
	meta.updatedAt = Date.now();
	publish(c);
	const answer = remember(meta, submission, { turn: active.number, steered: true });
	// A key is stored with its message, not when the turn next writes the session: a server that stops in between must not forget it.
	if (submission) void persist(c);
	return answer;
}

// Accept one prompt at a time across admission and sandbox waits.
async function takePrompt(
	c: Ctx,
	meta: SessionMeta,
	input: PromptInput,
	text: string,
	submission: Submission | null,
): Promise<PromptAnswer> {
	// A paused turn takes no new turn: the message is held, and given to the agent when the turn resumes.
	if (meta.status === "paused" && meta.run?.paused && !c.vars.turn)
		return holdMessage(c, meta, input, text, submission);
	// A turn in progress takes the message itself; `model` and `effort` are for a turn that starts.
	if (input.planMode !== undefined && (!capabilitiesOf(meta.harness).planMode || typeof input.planMode !== "boolean"))
		throw new UserError(`${harnessName(meta.harness)} has no plan mode.`, { code: "bad_input" });
	if (
		(c.vars.turn || c.vars.accepting) &&
		capabilitiesOf(meta.harness).events === "acp" &&
		(input.model || input.effort || input.planMode)
	)
		throw new UserError("Choose the model and effort when starting a turn.", { code: "bad_input" });
	if (c.vars.turn || c.vars.accepting) return await steerTurn(c, meta, c.vars.turn, text, submission);
	if (capabilitiesOf(meta.harness).events === "acp") return queuePrompt(c, meta, input, text, submission);
	return startPrompt(c, meta, input, text, submission);
}

/** GitHub feedback needs its own turn so the harness receives the prompt and its trust marker together. */
function startNextFeedback(c: Ctx, meta: SessionMeta) {
	const prompt = meta.githubFeedback?.pending;
	if (!prompt || meta.status !== "idle" || c.vars.turn || c.vars.accepting || c.vars.nextPrompt) return;
	if (c.vars.publishing || c.vars.savingSecret || c.vars.stopping || c.vars.destroying) return;
	void c.keepAwake(
		startPrompt(c, meta, prompt, prompt, null).catch(error => {
			note(c, meta.turns, "warn", `Could not start the GitHub feedback prompt: ${describeError(error)}`);
			return persist(c);
		}),
	);
}

async function startPrompt(
	c: Ctx,
	meta: SessionMeta,
	input: PromptInput,
	message: string | FeedbackPrompt,
	submission: Submission | null,
): Promise<PromptAnswer> {
	// The platform is committing and pushing the workspace: the agent does not start under it.
	if (c.vars.publishing)
		throw new UserError("The platform is pushing this agent's work to GitHub. Send the prompt again in a moment.", {
			code: "turn_running",
		});

	// Absent keeps the session's effort; null or "" is the model's default. Held against the turn's model below.
	let effort = turnEffort(input.effort, meta.effort ?? null, meta.model, null);

	// Nothing was awaited since the check above, so this prompt is the only one past it.
	c.vars.accepting = true;
	// The sandbox is this prompt's from here, and its turn's to the end: no idle check takes it meanwhile.
	let release: (() => void) | null = takeSandbox(c);
	let claimed = false;
	/** The running slot's claim, by the name (a generation) the user's actor gave it; null where there is no lease (a machine's session). */
	let claimName: number | null = null;
	try {
		// A suspend or removal of the idle sandbox finishes first; the turn then resumes or recreates it.
		if (c.vars.idling) await c.vars.idling.catch(() => undefined);
		const caps = capabilitiesOf(meta.harness);
		let model = meta.model;
		const requested = input.model || model;
		let credential: ActiveTurn["credential"];
		// A Settings key, or the ChatGPT plan, hosted or on a machine: refused here, before anything is taken.
		if (caps.events === "windlass")
			credential = await turnCredential(c, meta, undefined, requested, undefined, undefined, input.payWith === "key");
		if (
			caps.events === "windlass" &&
			meta.windlassSessionId &&
			windlassProvider(requested) !== windlassProvider(meta.model)
		)
			throw new UserError("Start a new Windlass session to change providers.", { code: "bad_model" });
		const switches = input.model !== undefined && input.model !== null && input.model !== "";
		if (switches || effort !== null) {
			// Held against the user's own models, and the effort against the ones the turn's model accepts. The demo's scripted model has the stand-in.
			const models =
				caps.models === "harness"
					? (meta.harnessModels ?? initialHarnessModels())
					: meta.demo
						? standInModels("demo")
						: await userActor(c, meta.uid).internalModels();
			try {
				if (switches) model = chosenModel(models, input.model);
				if (effort !== null) {
					// The adapter reports a new model's efforts only after selection.
					const checkOnSelection =
						caps.models === "harness" &&
						(model !== meta.model ||
							(meta.turns === 0 &&
								model !== models.defaultModel &&
								!models.models.find(m => m.id === model)?.efforts.length));
					if (!checkOnSelection || typeof effort !== "string" || effort.length > 64)
						effort = turnEffort(input.effort, meta.effort ?? null, model, models);
				}
			} catch (error) {
				if (error instanceof ModelProblem) throw new UserError(error.message, { code: error.code });
				throw error;
			}
		}

		// The owner can change egress between session creation and its first prompt.
		const facts =
			meta.place.kind === "machine" && (meta.repoUrl || caps.signIn.includes("machine"))
				? await runnerLink(c, meta.place.machineId).facts()
				: null;
		if (meta.repoUrl && facts?.report?.egress === "none")
			throw new UserError(OFFLINE_REPOSITORY, { code: "bad_input" });
		// The operator can change WLP_E2B_NETWORK between a session's launch and its turn.
		if (meta.repoUrl && meta.place.kind === "hosted" && (await layerOf(c, meta)).sandboxes.egress?.() === "none")
			throw new UserError(HOSTED_OFFLINE_REPOSITORY, { code: "bad_input" });
		if (caps.signIn.includes("machine") && facts) {
			const offered = facts.report?.harnesses?.find(entry => entry.id === meta.harness);
			if (!offered)
				throw new UserError(`This machine does not offer ${harnessName(meta.harness)}.`, { code: "bad_input" });
			if (offered.id === "codex" && !codexModes(meta.profile, offered.modes ?? []).some(m => m.id === meta.mode))
				throw new UserError(offered.modeReason ?? innerModesReason, { code: "bad_input" });
			// Pay with decides here as hosted: what pays, or the prompt waits or asks.
			if (machinePaysWith(offered.id, offered))
				credential = await turnCredential(c, meta, offered, model, undefined, undefined, input.payWith === "key");
			else if (offered.signIn === "none") {
				const keys = offered.keyRelay ? await modelKeyActor(c, meta.uid).internalModelKeys() : [];
				if (
					withSettingsKeys(
						offered,
						keys.map(k => k.provider),
						model,
					).signIn === "none"
				)
					throw new UserError(machineLoginMessage(machineHarnesses[offered.id], facts.name), {
						code: "harness_signed_out",
					});
			}
		} else if (meta.place.kind === "hosted" && caps.events === "acp") {
			credential = await turnCredential(c, meta, undefined, model, undefined, undefined, input.payWith === "key");
		}

		// The user row and default title are published before the agent starts, for every agent. Scrub them with the same secrets as its output.
		const held = await readSecrets(c, meta, null).catch(error => {
			if (error instanceof TurnProblem) throw new UserError(error.message, { code: "secrets_unavailable" });
			throw error;
		});
		// A turn the key pays in place of the ChatGPT plan (`openai/<model>`) spends none of the daily ChatGPT allowance.
		const runs = credential?.model ?? model;
		if (usesPlatformModel(meta.harness, runs)) {
			await settleTokenReceipts(c, meta.uid).catch(() => {
				throw new UserError("Your previous turn’s model usage could not be settled. Try again in a moment.", {
					code: "usage_unavailable",
				});
			});
		}
		const claim = await userActor(c, meta.uid).internalAcquireRun(meta.sessionId, runs);
		if (!claim.known || c.vars.destroying)
			throw new UserError("That agent does not exist any more.", { code: "session_not_found" });
		if (!claim.ok) {
			if (claim.dailyTokenWait) throw new UserError(claim.dailyTokenWait, { code: "daily_token_cap" });
			throw new UserError(
				`You already have ${claim.running === 1 ? "1 agent" : `${claim.running} agents`} working on this platform, the most it runs for you at once. Agents on your machines don't count. Wait for one to finish, or stop one.`,
				{ code: "too_many_running" },
			);
		}
		claimed = true;
		claimName = claim.claim;
		// Time for the sandbox to run on, and a place for one the session does not have: refused here, before anything is started.
		await holdSandbox(c, meta, true);
		if (c.vars.destroying) throw new UserError("That agent does not exist any more.", { code: "session_not_found" });

		// Deliveries can merge into the pending prompt while admission awaits a slot.
		const text = typeof message === "string" ? message : message.text;
		const shown = held.redactor.text(text);
		// Accepted. From here to the return nothing is awaited.
		const turn = meta.turns + 1;
		const now = Date.now();
		if (meta.secretRequest) (meta.declinedSecrets ??= []).push(meta.secretRequest.name);
		delete meta.secretRequest;
		meta.turns = turn;
		meta.model = model;
		meta.effort = effort;
		meta.status = "starting";
		delete meta.pauseNow;
		meta.updatedAt = now;
		meta.turnStartedAt = now;
		if (turn === 1 && !meta.titleIsTyped && !meta.origin) meta.title = promptTitle(shown);
		meta.run = newRun(
			meta,
			turn,
			effort,
			capabilitiesOf(meta.harness).planMode && input.planMode === true,
			now,
			c.vars.nextSeq,
		);
		if (meta.run && credential) meta.run.credential = credential;
		let untrusted: string[] | undefined;
		if (typeof message !== "string") {
			const reviewers = message.entries.filter(e => e.access !== "owner").map(e => e.author);
			untrusted = [...new Set(reviewers)].map(who => untrustedWords.feedback("@" + who));
			delete meta.githubFeedback!.pending;
		}
		if (meta.run && untrusted?.length) meta.run.untrusted = untrusted;
		append(c, { turn, kind: "user", text: shown, model, effort, ...(untrusted?.length && { untrusted }) });
		publish(c);

		const active: ActiveTurn = {
			number: turn,
			credential,
			effort,
			untrusted,
			controller: new AbortController(),
			done: Promise.resolve(),
			control: null,
			question: null,
			unsettled: new Set(),
			aside: [],
			recalled: new Map(),
			stopping: false,
			closed: false,
			planMode: capabilitiesOf(meta.harness).planMode && input.planMode === true,
			secrets: held,
			checks: new VerificationLog(),
			publishes: new Set(),
		};
		c.vars.turn = active;
		// The turn's first step writes the session, and the key with it.
		const answer = remember(meta, submission, { turn, steered: false });
		active.done = c.keepAwake(runTurn(c, meta, active, text, release));
		release = null;
		return answer;
	} catch (error) {
		if (meta.githubFeedback?.pending === message) delete meta.githubFeedback.pending;
		if (!c.vars.turn && meta.status !== "idle") {
			meta.status = "idle";
			meta.turnStartedAt = null;
		}
		if (claimed) {
			publish(c);
			// The place among the user's running sessions is handed back now (`internalReleaseRun`), by the claim's name, so that
			// a late one cannot free a newer claim. One that does not arrive while the user's actor is away leaves it
			// to the launch check, a minute after the claim.
			if (claimName !== null) {
				const released = userActor(c, meta.uid)
					.internalReleaseRun({ sessionId: meta.sessionId, claim: claimName, summary: summaryOf(meta) })
					.then(
						() => undefined,
						(failure: unknown) =>
							c.log.warn({ msg: "could not give back the running slot", error: describeError(failure) }),
					);
				if (!c.vars.stopping) void c.keepAwake(released);
			}
		} else if (!(error instanceof UserError)) void report(c);
		throw clientError(c.log, error, "The prompt could not be started. Try again.");
	} finally {
		c.vars.accepting = false;
		release?.();
		startNextFeedback(c, meta);
	}
}

/** Asks the user's turn queue for a slot for a waiting delivery, and takes the turn when it is granted at once. Never throws. */
async function askForSlot(
	c: Ctx,
	meta: SessionMeta,
	row: InboxRow,
	deploymentFull: number | null = null,
): Promise<void> {
	try {
		const answer = await requestTurn(c, meta.uid, row, deploymentFull);
		if (answer.granted) await takeDelivered(c, meta, row.key, answer.slot);
	} catch (error) {
		// The item asks again whether its turn runs; a delivery sent again asks again.
		c.log.warn({ msg: "could not ask the user's turn queue for a slot", key: row.key, error: describeError(error) });
	}
}

/** Gives a slot back to the queue, through the outbox. */
async function giveBack(c: Ctx, meta: SessionMeta, key: string, slot: string): Promise<void> {
	await serial(c, () => queueMessage(c.db, { to: "user", done: { slot, key } }));
	await flushOutbox(c, meta.uid);
}

// Claim the delivery and its slot before opening a turn. A replay of the grant must reuse them.
async function takeDelivered(c: Ctx, meta: SessionMeta, key: string, slot: string): Promise<void> {
	// The queue can send a grant while a reconnect or the item's poll is requesting the same
	// slot. Re-read ownership after that attempt before deciding to take it or give it back.
	await c.vars.resuming;
	const row = await inboxRow(c.db, key);
	if (row?.state === "started" && row.slot === slot) return;
	// A turn paused while its machine was away, whose slot was given back: this grant is its slot again.
	if (
		row?.state === "started" &&
		meta.run?.paused &&
		(meta.run.paused.slotFreed || !row.slot) &&
		row.turn === meta.run.turn
	) {
		if (!(await resumePaused(c, meta, slot))) {
			await c.vars.resuming;
			if ((await inboxRow(c.db, key))?.slot !== slot) await giveBack(c, meta, key, slot);
		}
		return;
	}
	// The same delivery sent again (a call that failed is sent again) while this session takes or runs it: the slot is that turn's, and stays.
	if (c.vars.delivering === key || c.vars.turn?.item?.row.key === key) return;
	if (row?.state !== "waiting" || c.vars.turn || c.vars.accepting || c.vars.publishing || c.vars.destroying) {
		await giveBack(c, meta, key, slot);
		return;
	}
	c.vars.accepting = true;
	c.vars.delivering = key;
	// The sandbox is this delivery's from here, and its turn's to the end, as for a person's prompt.
	let release: (() => void) | null = takeSandbox(c);
	try {
		if (c.vars.idling) await c.vars.idling.catch(() => undefined);
		// Confirm the session socket before recording a turn. An online control socket alone cannot run it.
		if (meta.place.kind === "machine") await runnerLink(c, meta.place.machineId).ready();
		if (
			meta.sandboxId &&
			meta.cloned &&
			typeof meta.setupDue === "string" &&
			!meta.workDue?.setupBase &&
			(await childSetupSeed(c, meta))
		) {
			// An older server left setup pending on an unpinned child checkout. No agent has run there yet.
			await removeSandbox(
				c,
				meta,
				meta.sandboxId,
				"Recreating the subtask sandbox to run setup at the feature’s base commit.",
			);
		}
		if (row.checkout) {
			const run = Number(row.key.split(":")[1]);
			if (
				meta.sandboxId &&
				(row.checkout.requested || meta.reviewRun !== run || meta.reviewBase !== row.checkout.baseSha)
			) {
				await removeSandbox(c, meta, meta.sandboxId, "Setting up a fresh checkout for the new review.");
			}
			meta.reviewRun = run;
			meta.reviewBase = row.checkout.baseSha;
		}
		await holdSandbox(c, meta, true);
		if (c.vars.destroying) throw new UserError("That agent does not exist any more.", { code: "session_not_found" });
		// The row is claimed before anything of the turn is: a withdrawal that came while the sandbox was being had leaves no
		// waiting row to claim, and the slot goes back with nothing started. Nothing else takes a turn meanwhile (`accepting`).
		const turn = meta.turns + 1;
		const claimed = await c.db.execute<{ key: string }>(
			"UPDATE inbox SET state = 'started', turn = ?, slot = ? WHERE key = ? AND state = 'waiting' RETURNING key",
			turn,
			slot,
			key,
		);
		if (claimed.length === 0) {
			console.log(`[wlp] inbox.withdrawn_while_taken session=${meta.sessionId} key=${key}`);
			await giveBack(c, meta, key, slot);
			return;
		}
		// The owner approved one implementer in the planner's workspace.
		if (meta.origin?.afterPlanning && !row.agent && !row.checkout) {
			const build = meta.origin.afterPlanning;
			if (build.model !== meta.model) meta.windlassSessionId = null;
			meta.model = build.model;
			meta.origin.effort = build.effort ?? undefined;
			delete meta.origin.afterPlanning;
		}
		const effort = meta.origin?.effort ?? null;
		// Accepted. From here to the transaction nothing is awaited.
		const now = Date.now();
		delete meta.secretRequest;
		meta.effort = effort;
		meta.turns = turn;
		meta.status = "starting";
		delete meta.pauseNow;
		meta.updatedAt = now;
		meta.turnStartedAt = now;
		meta.run = newRun(meta, turn, effort, false, now, c.vars.nextSeq);
		const first = append(c, { turn, kind: "user", text: itemPrompt(row), model: meta.model, effort });
		publish(c);
		const active: ActiveTurn = {
			number: turn,
			effort,
			controller: new AbortController(),
			done: Promise.resolve(),
			control: null,
			question: null,
			unsettled: new Set(),
			aside: [],
			recalled: new Map(),
			stopping: false,
			closed: false,
			secrets: null,
			checks: new VerificationLog(),
			publishes: new Set(),
			item: {
				row: { ...row, state: "started", turn, slot },
				report: null,
				full: null,
				started: false,
				pushedAtStart: meta.pushedHead ?? null,
			},
		};
		c.vars.turn = active;
		await serial(c, () =>
			c.db.transaction(
				async tx => {
					await tx.execute(
						"INSERT OR REPLACE INTO timeline (seq, turn, kind, at, item) VALUES (?, ?, ?, ?, ?)",
						first.seq,
						first.turn,
						first.kind,
						first.at,
						JSON.stringify(first),
					);
					await markTaken(tx, key, turn, slot);
					await tx.execute("UPDATE meta SET data = ? WHERE id = 1", JSON.stringify(meta));
				},
				{ name: "inbox.take" },
			),
		).catch(error =>
			c.log.error({
				msg: "could not store the receipt of the item's turn; its end is stored with the turn",
				error: describeError(error),
			}),
		);
		active.done = c.keepAwake(runTurn(c, meta, active, row.text, release));
		release = null;
	} catch (error) {
		if (!c.vars.turn && meta.status !== "idle") {
			meta.status = "idle";
			meta.turnStartedAt = null;
		}
		c.log.warn({ msg: "the item's turn could not start; its slot is given back", key, error: describeError(error) });
		if (error instanceof MachineUnreachable) {
			await serial(c, () =>
				c.db.transaction(tx => machineUnavailable(tx, row, slot, error.reason), { name: "inbox.machine" }),
			);
			await flushOutbox(c, meta.uid);
			return;
		}
		await giveBack(c, meta, key, slot);
		// Refused for the user's sandbox time or kept sandboxes: asked again, the queue answers with the wait.
		if (
			error instanceof UserError &&
			["allowance_used", "too_many_sandboxes", "usage_unavailable"].includes(String(error.code))
		)
			void c.keepAwake(askForSlot(c, meta, row));
	} finally {
		c.vars.accepting = false;
		c.vars.delivering = null;
		release?.();
	}
}

// Pin every input repository to the head resolved with its own scoped token.
async function planningInputs(
	c: Ctx,
	meta: SessionMeta,
	item: NonNullable<ActiveTurn["item"]>,
	sandbox: SandboxHandle,
	turn: number,
): Promise<void> {
	if (meta.origin?.role !== "builder" && !meta.origin?.planCritic) return;
	const asked =
		item.row.agent === "planner" || item.row.agent === "critic"
			? await itemActor(c, meta.uid, item.row.itemId).internalPlanningInputs(item.row.key)
			: null;
	if (!asked) {
		// Left by an earlier planning turn (a feature converted to one implementer runs its builder here next).
		if (meta.planningInputs && item.row.agent !== "summary") {
			// A builder never starts beside another repository's tree: one that cannot be removed refuses the turn.
			try {
				await removeInputs(sandbox, INPUTS_DIRECTORY);
			} catch (error) {
				item.refused = `This turn did not start: ${describeError(error)}.`;
				throw new TurnProblem(item.refused);
			}
			meta.planningInputs = undefined;
		}
		return;
	}
	meta.planningInputs = true;
	item.crossRepoPlan = true;
	const app = githubApp();
	const refuse = (why: string, policyRefusal = false) => {
		if (policyRefusal) item.policyRefusal = true;
		item.refused = `The planner reads every repository of the feature, and ${why}. Nothing was planned.`;
		throw new TurnProblem(item.refused);
	};
	if (!app) return refuse("this deployment has no GitHub App", true);
	const connection = await githubConnection(c, meta);
	if (!connection) return refuse("the GitHub connection is gone", true);
	for (const input of asked.inputs) {
		const label = `${input.owner}/${input.name}`;
		if (!input.sha) return refuse(`no base commit was recorded for ${label}`, true);
		try {
			const resolved = await resolveBoundRepository(app, connection, input.repositoryId, input.installationId, "read");
			const url = app.cloneUrl(resolved.repository.owner, resolved.repository.name);
			await app.withToken(
				input.installationId,
				{ repositoryId: input.repositoryId, permissions: { contents: "read", metadata: "read" } },
				token =>
					materializeInput(sandbox, token, {
						url,
						branch: input.baseRef,
						sha: input.sha!,
						directory: asked.directory,
						alias: input.alias,
					}),
				{ revokeAfter: true },
			);
			note(
				c,
				turn,
				"info",
				`Read ${label} at ${input.sha.slice(0, 7)} into ${asked.directory}/${input.alias}, read-only, for the planner.`,
			);
		} catch (error) {
			if (error instanceof TurnProblem) throw error;
			return refuse(
				`${label} could not be read: ${error instanceof GithubProblem ? error.message : describeError(error)}`,
				error instanceof GithubProblem && (error.code === "github_denied" || error.code === "github_gone"),
			);
		}
	}
}

/** The item's turn has its sandbox: the base is fetched for a turn that merges it, and the item is told the turn started. */
async function itemTurnStarted(
	c: Ctx,
	meta: SessionMeta,
	item: NonNullable<ActiveTurn["item"]>,
	sandbox: SandboxHandle,
	turn: number,
	credential: TurnCredential,
	effort: string | null,
): Promise<void> {
	if (item.started) return;
	item.started = true;
	if (item.row.fetchBase !== null && meta.repo) {
		const base = item.row.fetchBase;
		try {
			await fetchSessionBase(c, meta, base === meta.repo.branch ? meta.repo : { ...meta.repo, branch: base }, sandbox);
			note(
				c,
				turn,
				"info",
				`Fetched ${base} from the remote into the workspace as origin/${base}, for the agent to merge.`,
			);
		} catch (error) {
			note(
				c,
				turn,
				"warn",
				`${base} could not be fetched from the remote for the agent to merge: ${error instanceof GithubProblem ? error.message : describeError(error)}`,
			);
		}
	}
	await planningInputs(c, meta, item, sandbox, turn);
	const role =
		item.row.agent === "summary" || item.row.agent === "critic" || item.row.agent === "planner"
			? item.row.agent
			: meta.origin?.role === "reviewer"
				? "reviewer"
				: undefined;
	const fact: Fact = {
		kind: "turn_started",
		at: Date.now(),
		key: item.row.key,
		role,
		actual: {
			place: runPlace(meta.place),
			agent: meta.harness ?? "windlass",
			model: credential.model,
			effort,
			profile: meta.profile,
			size: meta.place.kind === "machine" ? (meta.origin?.size ?? 1) : (meta.hostedSize ?? null),
			// Windlass's ChatGPT models are the platform's, whether a machine's sign-in or the hosted plan pays.
			payer:
				credential.key && !usesPlatformModel(meta.harness, credential.model)
					? "key"
					: meta.harness && meta.harness !== "windlass"
						? "machine"
						: "windlass",
			payerSource: meta.origin?.payerSource,
		},
	};
	await serial(c, () => queueMessage(c.db, { to: "item", itemId: item.row.itemId, fact }));
	await flushOutbox(c, meta.uid);
}

// Persist the item's terminal fact before sending it, so a lost acknowledgement can be retried.
async function itemTurnEnded(
	c: Ctx,
	meta: SessionMeta,
	item: NonNullable<ActiveTurn["item"]>,
	ended: ItemTurnEnd,
): Promise<void> {
	const { row } = item;
	if ((item.full !== null || item.machineAway) && !item.started) {
		await serial(c, () =>
			c.db.transaction(
				async tx => {
					if (item.machineAway) await machineUnavailable(tx, row, row.slot, item.machineAway);
					else await requeue(tx, row.key, row.slot);
					await tx.execute("UPDATE meta SET data = ? WHERE id = 1", JSON.stringify(meta));
				},
				{ name: "inbox.requeue" },
			),
		);
		await flushOutbox(c, meta.uid);
		if (!item.machineAway)
			void c.keepAwake(askForSlot(c, meta, { ...row, state: "waiting", turn: null, slot: null }, item.full));
		return;
	}
	let fact: EndedFact;
	const agent = agentTurn(meta.harness, ended.usage, ended.acp?.usage, ended.acp?.fiveHourAtStart, ended.itemSignIn);
	if (meta.origin?.role === "reviewer") {
		fact = {
			...reviewEndedFactOf(
				row.key,
				ended.outcome,
				meta.review,
				item.said ?? null,
				item.refused ?? null,
				ended.usage,
				agent,
			),
			...(item.planReview && { planReview: item.planReview }),
		};
	} else {
		const changes =
			ended.used && meta.repo
				? await turnChanges(
						ended.used,
						meta.repo.baseSha ?? null,
						ended.checks,
						ended.verified,
						meta.origin?.owns,
					).catch(() => ({ flags: [] }))
				: { flags: [] };
		// Not known (git said nothing): taken as changed, and the push says whether there was anything. What the agent pushed itself in the turn is a change too.
		const changed = ended.unpushed !== false || (meta.pushedHead ?? null) !== item.pushedAtStart;
		// Until publication, only a confirmed push of this turn's complete work identifies its report.
		const pushedHead =
			ended.unpushed === false && meta.pushedHead !== item.pushedAtStart && meta.pushedHead === meta.platformPushed
				? meta.pushedHead
				: null;
		fact = {
			...endedFactOf(
				row.key,
				Date.now(),
				ended.outcome,
				ended.verified,
				changes.flags,
				changed,
				item.report,
				ended.usage,
				agent,
				item.asked,
			),
			...changes,
			...(meta.secretRequest && {
				secret: { name: meta.secretRequest.name, why: meta.secretRequest.why, notice: meta.secretRequest.notice },
			}),
			pushedHead,
			...(row.agent === "summary" && item.said && { reportProblem: item.said }),
			...(item.refused ? { refused: item.refused, policyRefusal: item.policyRefusal } : {}),
			...(item.refused && item.untrustedRefusal && { untrustedRefusal: item.untrustedRefusal }),
			...(item.escaped && { escaped: item.escaped }),
		};
	}
	// What the turn used, for its cost (factory/cost.ts). One that could not run ("error") and reported nothing cost nothing.
	if (ended.credential && (ended.usage !== null || ended.acp?.usage || ended.outcome !== "error"))
		fact.spend.meter = turnMeter({
			harness: meta.harness ?? "windlass",
			model: ended.credential.model,
			key: ended.credential.key,
			signIn: ended.itemSignIn,
			usage: ended.usage,
			cost: ended.acp?.usage?.cost,
			size: meta.place.kind === "hosted" ? (meta.hostedSize ?? SESSION_HOSTED_SIZE) : null,
		});
	// The item's budget in real units (factory/budget.ts): a key's dollars at today's prices, a plan's share of its windows.
	if (fact.spend.meter) {
		const models = await modelPrices()
			.then(rates => rates.models)
			.catch(() => null);
		const usd = turnUsd(fact.spend.meter, models);
		if (usd !== undefined) fact.spend.usd = usd;
	}
	const key = ended.credential?.key;
	if (key?.plan && item.planAtStart !== undefined) {
		const end = await planWindows(c, meta.uid, key.provider);
		const fiveHour = windowShare(item.planAtStart, end, "5h");
		const week = windowShare(item.planAtStart, end, "7d");
		if (fiveHour !== null || week !== null) fact.spend.plan = { fiveHour, week };
	}
	if (
		fact.kind === "turn_ended" &&
		meta.origin?.subtaskScreenshots &&
		ended.outcome === "succeeded" &&
		!item.asked &&
		!meta.secretRequest &&
		!item.report?.screenshots.length
	) {
		fact.refused = "This part requires a report with screenshot evidence. Retry the part to capture it.";
		fact.policyRefusal = true;
	}
	if (ended.stepLimit !== undefined) fact.stepLimit = ended.stepLimit;
	if (item.providerRefusal) fact.providerRefusal = item.providerRefusal;
	if (item.sandboxFailed) fact.sandboxFailed = item.sandboxFailed;
	if (item.outOfMemory) fact.outOfMemory = item.outOfMemory;
	// Stopped at its budget while it ran (budget-watch.ts), not by a person or a restart: the item asks for more.
	if (item.budgetStopped && !item.providerRefusal) fact.budgetStopped = true;
	if (attachmentStore()) {
		// If the server stops after the ledger commits but before the outbox commits, retry the same keep list.
		await serial(c, () =>
			c.db.execute("INSERT OR REPLACE INTO attachment_filing VALUES (?,?)", row.key, JSON.stringify(fact)),
		);
	}
	await finishItemTurn(c, meta, row, fact);
}

async function finishItemTurn(c: Ctx, meta: SessionMeta, row: InboxRow, fallback: EndedFact): Promise<Fact> {
	const result = await serial(c, async () => {
		const previous = await endedFact(c.db, row.key);
		if (previous) return previous;
		const [pending] = await c.db.execute<{ data: string }>("SELECT data FROM attachment_filing WHERE key=?", row.key);
		const fact = pending ? (JSON.parse(pending.data) as EndedFact) : fallback;
		if (pending || (fact.kind === "review_ended" && attachmentStore())) {
			const ledger = userActor(c, meta.uid);
			const filing =
				fact.kind === "review_ended"
					? ["stopped", "failed", "interrupted", "error"].includes(fact.outcome)
						? null
						: fact.review
					: typeof fact.report === "object"
						? fact.report
						: null;
			const keep = filing?.screenshots.map(shot => shot.id) ?? [];
			const abandoned = await ledger.internalSettleAttachments({ sessionId: meta.sessionId, key: row.key, keep });
			for (const entry of abandoned) await ledger.internalReleaseAttachment(entry.id).catch(() => {});
		}
		await c.db.transaction(
			async tx => {
				await markEnded(tx, row, fact);
				await tx.execute("DELETE FROM attachment_filing WHERE key=?", row.key);
				await tx.execute("UPDATE meta SET data = ? WHERE id = 1", JSON.stringify(meta));
			},
			{ name: "inbox.end" },
		);
		return fact;
	});
	await flushOutbox(c, meta.uid);
	return result;
}

/** Recover a completed filing across the ledger/outbox boundary, or report a cut-off turn. */
/** The Windlass events the timeline holds of one turn, in order. */
async function windlassEventsOf(c: Ctx, turn: number): Promise<WindlassEvent[]> {
	const events: WindlassEvent[] = [];
	for (const row of await c.db.execute<{ item: string }>(
		"SELECT item FROM timeline WHERE turn = ? AND kind = 'windlass' ORDER BY seq",
		turn,
	)) {
		const item = JSON.parse(row.item) as TimelineItem;
		if (item.kind === "windlass") events.push(item.event);
	}
	return events;
}

async function closeCutTurn(c: Ctx, meta: SessionMeta, row: InboxRow, usage: TurnUsage | null): Promise<Fact> {
	if (meta.origin?.role === "reviewer")
		return finishItemTurn(c, meta, row, reviewEndedFactOf(row.key, "interrupted", meta.review, null, null, usage));
	return finishItemTurn(
		c,
		meta,
		row,
		endedFactOf(row.key, Date.now(), "interrupted", meta.verified ?? null, [], true, null, usage),
	);
}

export const agentSession = actor({
	options: {
		name: "Agent session",
		icon: "robot",
		// A browser connection must read its generation from the user actor, which may be waking
		// and migrating its database after a restart. Allow that actor its migration window.
		onBeforeConnectTimeout: 30_000,
		// `changes`, `diff` and the internal destroy wait on the sandbox; a turn itself runs in the
		// background under `keepAwake` and is not bound by this.
		actionTimeout: 120_000,
		// Shutdown stops the turn, closes it in the timeline and pauses the sandbox.
		sleepGracePeriod: 25_000,
	},

	db: db({
		onMigrate: async db => {
			await db.execute("CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
			await db.execute(`
				CREATE TABLE IF NOT EXISTS timeline (
					seq INTEGER PRIMARY KEY,
					turn INTEGER NOT NULL,
					kind TEXT NOT NULL,
					at INTEGER NOT NULL,
					item TEXT NOT NULL
				)
			`);
			await db.execute(
				"CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK (id = 1), files TEXT NOT NULL, diff TEXT NOT NULL)",
			);
			for (const table of INBOX_TABLES) await db.execute(table);
			const inboxColumns = await db.execute<{ name: string }>("PRAGMA table_info(inbox)");
			if (!inboxColumns.some(col => col.name === "checkout"))
				await db.execute("ALTER TABLE inbox ADD COLUMN checkout TEXT");
			// Rows from before `ask_person` have none: their turns are not offered it.
			if (!inboxColumns.some(col => col.name === "asks_left"))
				await db.execute("ALTER TABLE inbox ADD COLUMN asks_left INTEGER");
			// Rows from before the marker carry no sources: their turns go as they did.
			if (!inboxColumns.some(col => col.name === "untrusted"))
				await db.execute("ALTER TABLE inbox ADD COLUMN untrusted TEXT NOT NULL DEFAULT '[]'");
			if (!inboxColumns.some(col => col.name === "unsandboxed"))
				await db.execute("ALTER TABLE inbox ADD COLUMN unsandboxed INTEGER NOT NULL DEFAULT 0");
			// Rows from before it have no whole-task prompt: their turns go as they did.
			if (!inboxColumns.some(col => col.name === "fresh")) await db.execute("ALTER TABLE inbox ADD COLUMN fresh TEXT");
			if (!inboxColumns.some(col => col.name === "budget"))
				await db.execute("ALTER TABLE inbox ADD COLUMN budget TEXT");
			await db.execute("CREATE TABLE IF NOT EXISTS attachment_filing (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
			await migrateJournal(db);
		},
	}),

	// Only the user actor signs a create grant for this exact session key.
	onCreate: async (c, input: SessionCreateInput | undefined) => {
		try {
			if (!input || !grantIsValid(input.grant, c.key, "agentSession")) return;
			const meta: SessionMeta = {
				uid: c.key[0],
				sessionId: c.key[1],
				demo: input.demo === true,
				title: String(input.title),
				titleIsTyped: input.titleIsTyped === true,
				place: input.place,
				machineName: typeof input.machineName === "string" ? input.machineName : null,
				...(input.size && { size: input.size }),
				...(input.place.kind === "hosted" && isHostedSize(input.hostedSize) && { hostedSize: input.hostedSize }),
				harness: input.harness,
				profile: input.profile,
				...initialSessionModes(
					input.profile,
					input.harness,
					!!input.origin,
					input.codexModes ?? input.harnessOptions?.modes,
				),
				...(input.harnessOptions && { harnessModels: initialHarnessModels(input.harnessOptions) }),
				...(input.mode !== undefined && { mode: input.mode }),
				model: String(input.model),
				effort: input.origin?.effort ?? (!input.origin && typeof input.effort === "string" ? input.effort : null),
				repoUrl: typeof input.repoUrl === "string" ? input.repoUrl : null,
				repo: typeof input.repo === "object" && input.repo !== null ? input.repo : null,
				publishUnasked: typeof input.repo === "object" && input.repo !== null && input.publishUnasked === true,
				createdAt: input.createdAt,
				updatedAt: input.createdAt,
				lastUsedAt: input.createdAt,
				serversChangedAt: input.createdAt,
				status: "idle",
				turns: 0,
				lastOutcome: null,
				sandboxId: null,
				sandbox: "none",
				cloned: false,
				windlassSessionId: null,
				turnStartedAt: null,
				...(input.origin?.kind === "item" && typeof input.origin.itemId === "string"
					? { origin: input.origin, ...(input.origin.childBranch && { publishBranch: input.origin.childBranch.name }) }
					: {}),
				...(input.readiness && { readiness: input.readiness }),
				...(!input.origin &&
				typeof input.environmentBuild?.project === "string" &&
				typeof input.environmentBuild.place === "string"
					? {
							environmentBuild: {
								project: input.environmentBuild.project,
								place: input.environmentBuild.place,
								screenshots: input.environmentBuild.screenshots === true,
							},
						}
					: {}),
				...(!input.origin && input.continuation && continuationMeta(input.continuation)),
			};
			await c.db.execute("INSERT OR REPLACE INTO meta (id, data) VALUES (1, ?)", JSON.stringify(meta));
		} catch (error) {
			c.log.error({ msg: "could not initialise the session", error: describeError(error) });
		}
	},

	createVars: async (c): Promise<SessionVars> => {
		const [row] = await c.db.execute<{ data: string }>("SELECT data FROM meta WHERE id = 1");
		const [last] = await c.db.execute<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM timeline");
		const meta = row ? (JSON.parse(row.data) as SessionMeta) : null;
		if (meta?.origin && meta.place.kind === "machine" && machineHarness(meta.harness) && !meta.origin.payer) {
			const origin = meta.origin as typeof meta.origin & { filedWithKey?: true };
			if (origin.filedWithKey) origin.payer = "key";
			else if (origin.signIn === "subscription" || origin.signIn === "chatgpt") origin.payer = "machine";
			delete origin.filedWithKey;
		}
		if (meta?.place.kind === "machine" && typeof meta.machineName === "string" && isMachineIdName(meta.machineName)) {
			const system = await userActor(c, meta.uid)
				.internalMachineSystem(meta.place.machineId)
				.catch(() => null);
			meta.machineName = machineLabel({ name: meta.machineName, ...system });
		}
		return {
			meta,
			nextSeq: (last?.seq ?? 0) + 1,
			unwritten: [],
			flushTimer: null,
			flushQueued: false,
			serial: Promise.resolve(),
			pending: [],
			turn: null,
			accepting: false,
			attempts: new Attempts(),
			destroying: false,
			stopping: false,
			reporting: null,
			reportAgain: false,
			idling: null,
			sandboxOps: 0,
			workspace: undefined,
			arming: Promise.resolve(),
			publishing: false,
			pullCheckedAt: 0,
			unpushed: null,
			meterTimer: null,
			metering: Promise.resolve(),
			idleStopMs: null,
			sandboxGen: 0,
			carried: null,
			runner: null,
			journal: null,
			restored: null,
			takeUpArmedAt: 0,
			resuming: null,
			heartbeat: null,
			setupReap: null,
			startClock: null,
			hostsAllowed: new Map(),
		};
	},

	onWake: async c => {
		const meta = c.vars.meta;
		if (!meta) {
			c.destroy();
			return;
		}
		// Before anything is awaited, so before the call that woke the actor can ask for a hold.
		settleWokenAsk(c, meta);
		// The signal taken here is the actor's own; the one on an action's context stops firing once
		// the action has returned.
		c.abortSignal.addEventListener(
			"abort",
			() => {
				// Capture the turn before the stop signal fires: RivetKit may already have released c.vars.
				try {
					// A turn the runner keeps through the restart is not stopped: `onSleep` lets go of it (`keepsTurn`).
					// One that can be resumed pauses instead of ending (`markPausing`).
					if (c.vars.turn && !keepsTurn(c)) {
						markPausing(c, meta);
						abortTurn(c, meta, c.vars.turn);
					}
				} catch (error) {
					console.warn(
						`[wlp] session=${meta.sessionId}: the actor was already stopping when its abort signal fired (${describeError(error)})`,
					);
				}
			},
			{ once: true },
		);

		// A turn running when the server went away: taken up where its process kept running (a machine's, M1), paused to
		// resume where it can be (WLP_TURN_RESUME), or cut short. One already paused resumes below.
		let cut = meta.status !== "idle" && meta.status !== "paused";
		let cutWords = "The server stopped while this turn was running, so the turn was cut short.";
		if (cut && (await takeUpTurn(c, meta))) {
			// The turn goes on: its process kept running on the machine, and the runner resumes the conversation.
			cut = false;
		} else if (cut && meta.status !== "stopping" && resumesTurns(meta) && meta.run?.turn === meta.turns) {
			if (await crashPause(c, meta)) cut = false;
			else
				cutWords = `The server stopped ${CRASHES_ALLOWED} times in a row while resuming this turn, with nothing done in between, so the turn was ended.`;
		}
		// A pause with no record of it (from a server without resume) is a turn cut short.
		if (meta.status === "paused" && !meta.run?.paused) cut = true;
		if (cut) {
			// The process that ran this turn is gone, and the turn with it; so is a question it was waiting on.
			const turn = meta.turns;
			note(c, turn, "warn", cutWords);
			const events = await windlassEventsOf(c, turn);
			// What the turn recorded before it was cut off says whether it changed the workspace after the checks last ran.
			if (capabilitiesOf(meta.harness).checks === "none") meta.verified = null;
			else {
				const cut = new VerificationLog();
				for (const event of events) cut.note(event);
				meta.verified = cut.cutOff(turn, meta.verified ?? null);
			}
			// The tokens its finished model requests reported: the turn row and an item's spend count them, as the account's ledger already did.
			const usage = cutTurnUsage(events);
			note(c, turn, "info", cutTurnUsageNote(usage));
			append(c, {
				turn,
				kind: "turn.ended",
				outcome: "interrupted",
				exitCode: null,
				steps: null,
				durationMs: meta.turnStartedAt ? Math.max(0, Date.now() - meta.turnStartedAt) : 0,
				usage,
				cachedShare: null,
				message: null,
				verified: meta.verified,
			});
			meta.status = "idle";
			meta.lastOutcome = "interrupted";
			meta.updatedAt = Date.now();
			meta.lastUsedAt = meta.updatedAt;
			meta.turnStartedAt = null;
			meta.run = null;
			// What that turn wrote to Windlass's session was not copied out of the sandbox: the copy is behind it.
			if (meta.backup) meta.memoryTurn = turn;
		}
		if (cut || meta.status === "paused") {
			// A setup run that was going then has no ending item, and is not run again: the agent is told.
			if (meta.setupRunning) {
				meta.setupUnfinished = {
					command: meta.setupRunning.command,
					state: "interrupted",
					exitCode: null,
					limitMs: meta.setupRunning.limitMs,
					output: "",
				};
				// What it started is still running in the sandbox: stop it now, not at the next prompt.
				const sandboxId = meta.sandboxId;
				if (sandboxId)
					c.vars.setupReap = c.keepAwake(
						layerOf(c, meta)
							.then(({ sandboxes }) => stopCutOffSetup(sandboxes, sandboxId))
							.then(
								swept => {
									if (swept) console.log(`[wlp] setup.reaped session=${meta.sessionId} sandbox=${sandboxId}`);
								},
								(error: unknown) =>
									c.log.warn({
										msg: "could not stop a setup cut off with the server; the next turn stops it",
										sandbox: sandboxId,
										error: describeError(error),
									}),
							),
					);
			}
		}
		if (cut) {
			const turn = meta.turns;
			const taken = await rowOfTurn(c.db, turn);
			if (taken) await closeCutTurn(c, meta, taken, cutTurnUsage(await windlassEventsOf(c, turn)));
		}
		if (cut && meta.environmentBuild) {
			void c.keepAwake(
				userActor(c, meta.uid)
					.internalEnvironmentResult(meta.sessionId, { interrupted: true })
					.catch(error =>
						c.log.warn({ msg: "could not report the interrupted environment build", error: describeError(error) }),
					),
			);
		}
		if (cut || meta.status === "paused") {
			await persist(c);
			publish(c);
		}
		meta.setupRunning = null;
		if (meta.readiness && meta.turns && meta.status === "idle") reportAssessment(c, meta);
		// What the item or the turn queue was not told yet before the server stopped is sent now.
		void c.keepAwake(sendOutbox(c, meta.uid));
		// A grant lost with a server leaves a delivery waiting with nothing to move it: each waiting one is asked for again (the queue answers a key it granted with the same slot).
		void c.keepAwake(
			waitingRows(c.db).then(
				rows => Promise.all(rows.map(row => askForSlot(c, meta, row))).then(() => undefined),
				(error: unknown) =>
					c.log.warn({ msg: "could not read the deliveries that wait for a slot", error: describeError(error) }),
			),
		);
		// Repair a lost idle check when the actor wakes.
		const use = useOf(meta);
		c.vars.carried = use === null ? null : { use, gen: c.vars.sandboxGen };
		void c.keepAwake(
			refreshSandbox(c, meta)
				.then(() => wakeMeter(c, meta, use))
				.then(() => armIdle(c, meta))
				// A paused turn resumes once the sandbox's state is known.
				.then(() => resumePaused(c, meta))
				.then(() => startNextFeedback(c, meta)),
		);
	},

	onSleep: async c => {
		c.vars.stopping = true;
		// The wake after a crash is not needed by a turn that pauses here, or by one the runner keeps (M1's own wake).
		heartbeat(c, false);
		// The runner lets go of what it ran for this instance however the rest ends, a throw included.
		try {
			const meta = c.vars.meta;
			if (!meta) return;
			// A machine turn the runner keeps through the restart: stored where it is, and taken up on the next wake.
			if (await keepTurn(c)) return;
			// The order and the waits are what fits in the shutdown grace period (SHUTDOWN_GRACE_MS above).
			// A turn that can be resumed pauses instead of ending (`pauseTurn`), and a wake is scheduled for it.
			markPausing(c, meta);
			await stopTurn(c);
			await persist(c);
			if (meta.sandboxId && meta.sandbox === "running" && meta.status === "paused") {
				// Kept running for the turn that resumes in a moment: an E2B sandbox's own timeout
				// pauses it should no server take the turn up, and a warm one resumes without a pause and resume of its own.
				console.log(`[wlp] sandbox.kept_for_resume id=${meta.sandboxId} session=${meta.sessionId}`);
			} else if (meta.sandboxId && meta.sandbox === "running" && meta.place.kind === "machine") {
				// Asking would have the runner attach to this instance, whose sockets are refused from here
				// (`onWebSocket`); its runner stops the sandbox itself once no session is connected to it for its idle time.
				console.log(
					`[wlp] sandbox.suspend_skipped id=${meta.sandboxId} session=${meta.sessionId}: the machine's runner stops it after its idle time`,
				);
			} else if (meta.sandboxId && meta.sandbox === "running") {
				const id = meta.sandboxId;
				// A suspend that ends after the wait goes on without the actor, whose state may be gone by then.
				let waiting = true;
				let ended = false;
				const suspended = layerOf(c, meta)
					.then(({ sandboxes }) => sandboxes.suspend(id))
					.then(
						() => {
							ended = true;
							if (!waiting) return;
							sandboxChanged(c);
							meta.sandbox = "paused";
							publish(c);
						},
						error => {
							ended = true;
							console.error(
								`[wlp] sandbox.suspend_failed id=${id} session=${meta.sessionId}: could not pause the sandbox while going to sleep (${describeError(error)})`,
							);
						},
					);
				await within(suspended, SUSPEND_WAIT_MS);
				waiting = false;
				if (!ended)
					console.warn(
						`[wlp] sandbox.suspend_slow id=${id} session=${meta.sessionId}: not paused within ${SUSPEND_WAIT_MS / 1000} s of going to sleep; its provider stops it`,
					);
			}
			// A paused sandbox is due for removal later: the schedule wakes the actor for it.
			await within(Promise.all([armIdle(c, meta), c.vars.reporting, sleepMeter(c, meta)]), SETTLE_WAIT_MS);
			await persist(c);
		} finally {
			c.vars.runner?.close();
		}
	},

	onDestroy: async c => {
		const alreadyDeleting = c.vars.destroying;
		c.vars.stopping = true;
		c.vars.destroying = true;
		heartbeat(c, false);
		try {
			const meta = c.vars.meta;
			if (!meta) return;
			await stopTurn(c);
			if (c.vars.flushTimer) clearTimeout(c.vars.flushTimer);
			if (meta.place.kind === "hosted" || !alreadyDeleting) {
				await destroySessionSandboxes(c, meta).catch(error =>
					c.log.error({ msg: "could not remove the session's sandboxes", error: describeError(error) }),
				);
			}
			await leaveUsage(c, meta);
			// After the sandbox, which is what uploads: nothing can put the copy back once it is removed.
			await removeBackup(c, meta);
		} finally {
			c.vars.runner?.close();
		}
	},

	events: {
		networkBlocked: event<NetworkBlockedItem>({ canSubscribe: c => maySubscribe(c) }),
		item: event<TimelineItem>({ canSubscribe: c => maySubscribe(c) }),
		delta: event<LiveDelta>({ canSubscribe: c => maySubscribe(c) }),
		summary: event<SessionSummary>({ canSubscribe: c => maySubscribe(c) }),
		question: event<PendingQuestion | null>({ canSubscribe: c => maySubscribe(c) }),
		machine: event<NonNullable<SessionSnapshot["machine"]>>({ canSubscribe: c => maySubscribe(c) }),
	},

	onBeforeConnect: async (c, params: unknown) => {
		assertOrigin(c);
		if (!isRunnerSocket(c.request)) await sessionCaller(c, params);
		if (!c.vars.meta) throw new UserError("That agent does not exist.", { code: "session_not_found" });
	},

	// Verify the runner hello synchronously before accepting any of its frames.
	onWebSocket: (c, ws) => {
		assertOrigin(c);
		const link = c.vars.runner;
		if (!isRunnerSocket(c.request) || !link || c.vars.stopping) {
			ws.close(1008, "Not expected");
			return;
		}
		link.socket(ws);
	},

	actions: {
		internalDisconnectRevoked: async (c, generation: number): Promise<void> => {
			requireServiceFor(c, "call");
			await disconnectRevoked(c.conns, generation);
		},
		snapshot: async (c): Promise<SessionSnapshot> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			try {
				const { sandboxes } = await layerOf(c, meta);
				if (c.vars.runner) await within(c.vars.runner.snapshotFacts(), PROFILE_WAIT_MS);
				const profile = sandboxes.profile(meta.profile);
				return await serial(c, async () => {
					await writeItems(c).catch(error =>
						c.log.error({ msg: "could not write the timeline", error: describeError(error) }),
					);
					// A stop checkpoint is provisional until a real item occupies its seq.
					const end = c.vars.unwritten[0]?.seq ?? c.vars.nextSeq;
					const rows = await c.db.execute<{ item: string }>(
						"SELECT item FROM timeline WHERE seq < ? ORDER BY seq",
						end,
					);
					// Reading pending items under the same serial queue closes the gap after the SQLite snapshot.
					const timeline = rows.map(row => JSON.parse(row.item) as TimelineItem);
					const last = timeline.length > 0 ? timeline[timeline.length - 1].seq : 0;
					for (const item of c.vars.unwritten) if (item.seq > last) timeline.push(item);
					return {
						summary: summaryOf(meta),
						profile,
						windlassSessionId: meta.windlassSessionId,
						timeline,
						pending: [...c.vars.pending],
						question: c.vars.turn?.question?.pending ?? null,
						...(!meta.origin && meta.secretRequest && { secretRequest: meta.secretRequest }),
						...(meta.place.kind === "machine" ? { machine: c.vars.runner?.reach() ?? null } : {}),
					};
				});
			} catch (error) {
				throw clientError(c.log, error, "The agent's timeline could not be read.");
			}
		},

		setMode: async (c, input: { mode: string }): Promise<SessionSummary> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			if (meta.origin)
				throw new UserError("A work item and its reviewer use the profile’s approval mode.", { code: "bad_input" });
			const mode = input?.mode;
			if (meta.harness === "codex" && meta.place.kind === "machine") {
				const facts = await runnerLink(c, meta.place.machineId).facts();
				const offered = facts.report?.harnesses?.find(h => h.id === "codex");
				if (!codexModes(meta.profile, offered?.modes ?? []).some(m => m.id === mode))
					throw new UserError(offered?.modeReason ?? innerModesReason, { code: "bad_input" });
			}
			const beforeHarnessOpen = capabilitiesOf(meta.harness).events === "acp" && !meta.availableModes.length;
			if (
				typeof mode !== "string" ||
				!mode.trim() ||
				(!beforeHarnessOpen && !meta.availableModes.some(m => m.id === mode))
			) {
				throw new UserError("Choose a mode offered by this agent.", { code: "bad_input" });
			}
			if (c.vars.turn) c.vars.turn.modeQueued = true;
			meta.mode = mode;
			publish(c);
			await persist(c);
			return summaryOf(meta);
		},

		setRequestedSecret: async (c, input: SetRequestedSecretInput): Promise<void> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			const request = meta.secretRequest;
			if (
				!request ||
				!validRequestedSecretName(input?.name) ||
				input.name !== request.name ||
				(!meta.origin && input.requestId !== request.id)
			)
				throw new UserError("That secret request is no longer open.", { code: "no_question" });
			if (c.vars.savingSecret || c.vars.accepting || c.vars.nextPrompt || meta.status === "paused")
				throw new UserError("The session is busy. Try again when the turn has ended.", { code: "turn_running" });
			const project = setupProjectOf(meta)?.key ?? ACCOUNT_SECRET_PROJECT;
			let sealed: string;
			try {
				sealed = sealSecret(serverSealer(), meta.uid, project, request.name, cleanSecretValue(input.value));
			} catch (error) {
				if (error instanceof SecretProblem) throw new UserError(error.message, { code: "bad_secret" });
				throw error;
			}
			const save = { project, sealed, name: request.name, requestId: input.requestId };
			c.vars.savingSecret = true;
			try {
				if (meta.origin) {
					await itemActor(c, meta.uid, meta.origin.itemId).internalSetRequestedSecret(save);
				} else {
					if (c.vars.turn) await c.vars.turn.done;
					if (meta.secretRequest !== request || c.vars.accepting || meta.run?.paused)
						throw new UserError("That secret request is no longer open.", { code: "no_question" });
					await secretsActor(c, meta.uid, meta.sessionId).internalSaveRequestedSecret(meta.sessionId, save);
					delete meta.secretRequest;
					await persist(c);
					const text = `${request.name} is now set in your environment.`;
					await takePrompt(c, meta, { text }, text, null);
				}
			} finally {
				delete c.vars.savingSecret;
				startNextFeedback(c, meta);
			}
		},

		internalGithubFeedback: async (c, notice: FeedbackNotice): Promise<boolean> => {
			requireServiceFor(c, "call");
			const meta = liveMeta(c);
			if (
				meta.origin ||
				meta.environmentBuild ||
				meta.repo?.provider === "gitlab" ||
				meta.repo?.id !== notice.repositoryId ||
				meta.pull?.number !== notice.pr
			)
				return false;
			const feedback = (meta.githubFeedback ??= { seen: [] });
			feedback.seen = feedback.seen.filter(e => recentSubject(e.at));
			const seen = new Set(feedback.seen.map(e => e.id));
			const entries = notice.entries.filter(e => !seen.has(e.id));
			if (entries.length) {
				const eligible = entries.filter(e => !oversizedFeedback(e));
				if (eligible.length !== entries.length)
					note(c, meta.turns, "warn", "GitHub feedback was not run. " + feedbackWords.oversized);
				const { taken, rest } = fits(eligible, feedback.pending?.entries);
				if (rest.length) note(c, meta.turns, "warn", "GitHub feedback beyond the pending batch limit was not run.");
				if (taken.length) {
					const prompt = (feedback.pending ??= { entries: [], text: "" });
					prompt.entries.push(...taken);
					prompt.text =
						"Address the feedback that fits this change on the same branch. Explain any points you leave open.\n\n" +
						batchText(prompt.entries, { pr: notice.pr, head: meta.pushedHead, session: true });
				}
				feedback.seen.push(...entries.map(({ id, at }) => ({ id, at })));
			}
			await writeMeta(c, meta);
			startNextFeedback(c, meta);
			return true;
		},

		prompt: async (c, input: PromptInput): Promise<PromptAnswer> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			if (c.vars.savingSecret) throw new UserError("The requested secret is being saved.", { code: "turn_running" });
			if (meta.origin)
				throw new UserError(
					"This agent works for a work item, whose steps send its prompts. Answer the item, or send its work back with a note.",
					{ code: "item_session" },
				);
			if (meta.environmentBuild)
				throw new UserError("This session only builds the repository's prepared environment.", {
					code: "item_session",
				});
			if (typeof input !== "object" || input === null || typeof input.text !== "string" || input.text.trim() === "") {
				throw new UserError("Write what the agent should do.", { code: "empty_prompt" });
			}
			const text = input.text.trim();
			if (text.length > MAX_PROMPT_CHARS) {
				throw new UserError(`The prompt is ${text.length} characters long; the limit is ${MAX_PROMPT_CHARS}.`, {
					code: "prompt_too_long",
				});
			}
			// Without a key every prompt is a message of its own, as it always was.
			let attempt: Promise<PromptAnswer>;
			try {
				const submission = submissionOf(input.idempotencyKey, text);
				if (submission === null) return await takePrompt(c, meta, input, text, null);
				// Taken before: answered as it was then, whatever the session does now. Nothing was awaited, so this is decided before any other call runs.
				const taken = meta.submissions?.find(kept => kept.key === submission.key);
				if (taken && isRepeat(taken, submission, KEYED)) return { turn: taken.turn, steered: taken.steered };
				// Being decided, or new: every attempt that arrives until it is taken or refused ends as this one does.
				attempt = c.vars.attempts.run(submission, KEYED, () => takePrompt(c, meta, input, text, submission));
			} catch (error) {
				if (error instanceof SubmissionProblem) throw new UserError(error.message, { code: error.code });
				throw error;
			}
			return await attempt;
		},

		stop: async (c): Promise<void> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			const turn = c.vars.turn;
			if (!turn) {
				// A paused turn has nothing running to stop: it ends now, and does not resume.
				if (meta.status === "paused" && meta.run?.paused)
					await endPausedTurn(c, meta, "stopped", "You stopped the paused turn, so it will not resume.");
				return;
			}
			turn.stopping = true;
			// A question the turn waits on is withdrawn with it: from here an answer finds nothing to answer.
			const withdrawn = takeQuestion(c, meta, turn);
			if (meta.status !== "stopping") {
				meta.status = "stopping";
				publish(c);
			} else if (withdrawn) {
				publish(c);
			}
			turn.controller.abort();
			await persist(c);
		},

		// Take and settle synchronously so concurrent answers cannot both succeed.
		answer: async (c, input: { questionId: string; choice: string; note?: string }): Promise<void> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			if (
				typeof input !== "object" ||
				input === null ||
				typeof input.questionId !== "string" ||
				typeof input.choice !== "string"
			) {
				throw new UserError("Choose one of the question's answers.", { code: "bad_answer" });
			}
			if (input.note !== undefined && input.note !== null && typeof input.note !== "string") {
				throw new UserError("The note must be text.", { code: "bad_answer" });
			}
			const note = typeof input.note === "string" ? input.note.trim() : "";
			if (note.length > MAX_NOTE_CHARS) {
				throw new UserError(`The note is ${note.length} characters long; the limit is ${MAX_NOTE_CHARS}.`, {
					code: "note_too_long",
				});
			}
			const active = c.vars.turn;
			// A server's question that stands aside for a tool call's is still open: whoever saw it may answer it.
			const asked =
				active?.question?.pending.id === input.questionId
					? active.question
					: active?.aside.find(candidate => candidate.pending.id === input.questionId);
			if (!active || !asked || active.stopping || active.closed) {
				throw new UserError("That question is not waiting for an answer any more.", { code: "no_question" });
			}
			if (asked.pending.messageId === "acp" && note)
				throw new UserError(`${harnessName(meta.harness)} takes a choice without a note.`, { code: "bad_input" });
			const choice = asked.pending.choices.find(candidate => candidate.id === input.choice);
			if (!choice) {
				throw new UserError(
					`That is not one of the question's answers. Choose one of: ${asked.pending.choices.map(candidate => candidate.label).join(", ")}`,
					{ code: "bad_choice" },
				);
			}
			if (active.question === asked) {
				takeQuestion(c, meta, active);
				publish(c);
				void persist(c);
			}
			asked.answer({ choice: choice.id, note: note === "" ? undefined : note });
		},

		stopCall: async (
			c,
			input: { messageId: string; callId: string },
		): Promise<{ stopped: boolean; message: string | null }> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			if (
				typeof input !== "object" ||
				input === null ||
				typeof input.messageId !== "string" ||
				input.messageId === "" ||
				typeof input.callId !== "string" ||
				input.callId === ""
			) {
				throw new UserError("Say which tool call to stop.", { code: "bad_call" });
			}
			const active = c.vars.turn;
			const control = active?.control;
			if (!active || !control || active.closed) {
				throw new UserError("No turn is running, so there is no tool call to stop.", { code: "no_turn" });
			}
			// As for a steer: the request would wait for the machine. Stopping the whole turn (`stop`) waits for nothing and still works.
			if (machineAway(c, meta))
				throw new UserError(
					"Your machine is not answering, so the tool call was not stopped. Stop the turn instead, or try again when the machine is back.",
					{ code: "turn_running" },
				);
			try {
				const result = await control.cancelCall(input.messageId, input.callId);
				return {
					stopped: result?.stopped === true,
					message: typeof result?.message === "string" && result.message !== "" ? result.message : null,
				};
			} catch (error) {
				if (active.closed)
					throw new UserError("The turn ended before the tool call could be stopped.", { code: "no_turn" });
				throw clientError(c.log, error, "The tool call could not be stopped. Try again.");
			}
		},

		changes: async (c): Promise<WorkspaceFile[]> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			// The sandbox is this read's until it is done: it may resume a paused one and read it.
			const release = takeSandbox(c);
			try {
				const view = await workspaceView(c, meta);
				if (view === null) return [];
				return "sandbox" in view ? ((await readFiles(c, view.sandbox)) ?? []) : view.files;
			} catch (error) {
				throw clientError(c.log, error, "The workspace's changes could not be read.");
			} finally {
				release();
			}
		},

		diff: async (c): Promise<string> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			const release = takeSandbox(c);
			try {
				const view = await workspaceView(c, meta);
				if (view === null) return "";
				return "sandbox" in view ? ((await readDiff(c, meta, view.sandbox)) ?? "") : view.diff;
			} catch (error) {
				throw clientError(c.log, error, "The workspace's diff could not be read.");
			} finally {
				release();
			}
		},

		publishState: async (c): Promise<PublishState> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			try {
				await checkPull(c, meta);
				return await publishStateOf(c, meta);
			} catch (error) {
				throw clientError(c.log, error, "The pull request's state could not be read.");
			}
		},

		publish: async (c, input: { message: PublishMessage }): Promise<PublishResult> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			if (meta.origin?.role === "reviewer") throw new UserError("The reviewer cannot publish.", { code: "reviewer" });
			const message = cleanMessage(input);
			const repo = meta.repo;
			if (!repo)
				throw new UserError(
					"This agent does not work on a repository of your GitHub connection, so there is nowhere to push.",
					{ code: "publish_blocked" },
				);
			// A push under way (the agent's, or an item's step) is waited for, and the click goes on with what it pushed.
			if (c.vars.publishing && !(await publishingSettled(c, PUBLISH_WAIT_MS))) {
				throw new UserError("The agent is pushing its work right now. Open the pull request again in a moment.", {
					code: "publish_blocked",
				});
			}
			// While a turn runs the workspace is the agent's, and nothing of it is committed or pushed: with the branch pushed and no pull
			// request open, the pull request is opened from what is at GitHub. Decided and taken in this step, with nothing awaited since the wait.
			const app = githubApp();
			const busyTurn = c.vars.turn !== null || c.vars.accepting || meta.status !== "idle";
			const openPull = meta.pull && (meta.pull.state === "open" || meta.pull.state === "draft");
			if (
				busyTurn &&
				repo.provider !== "gitlab" &&
				app &&
				meta.pushedHead &&
				meta.publishBranch &&
				!openPull &&
				!c.vars.publishing
			) {
				c.vars.publishing = true;
				try {
					const pull = await c.keepAwake(
						openFromPushed({
							app,
							connection: await githubConnection(c, meta),
							repository: repo,
							branch: meta.publishBranch,
							message,
							evidence: await evidenceOf(c, meta, c.vars.turn?.number ?? null),
						}),
					);
					meta.pull = pull;
					meta.updatedAt = Date.now();
					c.vars.pullCheckedAt = meta.updatedAt;
					note(
						c,
						meta.turns,
						"info",
						`Opened pull request #${pull.number} in ${repo.owner}/${repo.name} from ${pull.branch}, from what the agent had pushed; the turn goes on.${verifiedLine(pull)}`,
					);
					console.log(
						`[wlp] github.published session=${meta.sessionId} repository=${repo.id} pull=${pull.number} opened=true from=pushed`,
					);
					publish(c);
					await persist(c);
					return { state: await publishStateOf(c, meta), opened: true };
				} catch (error) {
					if (error instanceof GithubProblem)
						throw new PublishRefused(
							error.message,
							error.code === "github_gone" || error.code === "github_denied" ? error.code : "publish_failed",
							error.code === "github_unreachable",
						);
					throw clientError(c.log, error, "The pull request could not be opened. Try again.");
				} finally {
					c.vars.publishing = false;
					startNextFeedback(c, meta);
				}
			}
			const blocked = publishBlocked(c, meta);
			if (blocked) throw new UserError(blocked, { code: "publish_blocked" });
			// Nothing was awaited since the check: this push is the only one past it.
			c.vars.publishing = true;
			const release = takeSandbox(c);
			try {
				return await c.keepAwake(publishSession(c, meta, repo, message));
			} catch (error) {
				throw clientError(c.log, error, "The work could not be pushed. Try again.");
			} finally {
				c.vars.publishing = false;
				release();
				startNextFeedback(c, meta);
			}
		},

		setPublishUnasked: async (c, input: { unasked: boolean }): Promise<SessionSummary> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			if (typeof input !== "object" || input === null || typeof input.unasked !== "boolean")
				throw new UserError("Say whether the agent may publish without asking.", { code: "bad_input" });
			if (!meta.repo)
				throw new UserError(
					"This agent does not work on a repository of your GitHub connection, so it has nowhere to publish to.",
					{ code: "publish_blocked" },
				);
			if (input.unasked) {
				if (!capabilitiesOf(meta.harness).platformTools.includes("publish"))
					throw new UserError("This agent has no publish tool. Publish from the panel.", { code: "publish_blocked" });
				// Its publish comes over MCP, which any process in the container may reach: it asks every time.
				if (meta.harness && meta.harness !== "windlass")
					throw new UserError(publishAsksEveryTime(harnessName(meta.harness)), { code: "publish_blocked" });
				const { sandboxes } = await layerOf(c, meta);
				const problem = publishUnaskedProblem(commandSandbox(sandboxes.profile(meta.profile)));
				if (problem !== null) throw new UserError(problem, { code: "publish_blocked" });
			}
			const active = c.vars.turn;
			// A request that is being asked about is allowed by turning this on, as by its own "Allow for this session".
			const asked =
				input.unasked && active && !active.stopping && !active.closed
					? [active.question, ...active.aside].find(candidate => candidate?.pending.publish !== undefined)
					: undefined;
			if (active && asked) {
				if (active.question === asked) takeQuestion(c, meta, active);
				meta.publishUnasked = true;
				asked.answer({ choice: PUBLISH_SESSION });
			} else if ((meta.publishUnasked === true) !== input.unasked) {
				meta.publishUnasked = input.unasked;
				note(
					c,
					meta.turns,
					"info",
					input.unasked
						? "You let the agent publish this session's work without asking, in the session's panel."
						: "You turned off publishing without asking in the session's panel: the agent's next request to publish is put to you.",
				);
			}
			publish(c);
			await persist(c);
			return summaryOf(meta);
		},

		servers: async (c): Promise<SessionServers> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			try {
				return await sessionServers(c, meta);
			} catch (error) {
				throw clientError(c.log, error, "The project's MCP servers could not be read.");
			}
		},

		approveServer: async (c, input: { name: string; fingerprint: string }): Promise<SessionServers> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			if (!capabilitiesOf(meta.harness).projectServerApproval)
				throw new UserError(`${harnessName(meta.harness)} does not take project MCP servers here.`, {
					code: "bad_server",
				});
			if (meta.origin?.role === "reviewer")
				throw new UserError("The reviewer cannot start MCP servers.", { code: "reviewer" });
			if (
				typeof input !== "object" ||
				input === null ||
				typeof input.name !== "string" ||
				input.name === "" ||
				typeof input.fingerprint !== "string" ||
				input.fingerprint === ""
			) {
				throw new UserError("Say which server to approve, and which definition of it.", { code: "bad_server" });
			}
			const server = (meta.servers ?? []).find(candidate => candidate.name === input.name);
			if (!server)
				throw new UserError("This session's project no longer names an MCP server of that name.", {
					code: "server_gone",
				});
			// The approval is of the definition the user was shown: one the session has since seen change, start or go is not it.
			if (server.state !== "waiting" || server.fingerprint !== input.fingerprint) {
				throw new UserError(
					`The MCP server "${server.name}" no longer waits with the definition shown here. Read the list again and look at it once more.`,
					{ code: "server_changed" },
				);
			}
			try {
				const active = c.vars.turn;
				// A question about exactly this definition is open: this answers it, and the server starts now.
				const asked =
					active && !active.stopping && !active.closed
						? [active.question, ...active.aside].find(
								candidate =>
									candidate?.server?.name === server.name && candidate.server.fingerprint === input.fingerprint,
							)
						: undefined;
				if (active && asked) {
					if (active.question === asked) {
						takeQuestion(c, meta, active);
						publish(c);
						void persist(c);
					}
					asked.answer({ choice: SERVER_START });
				} else {
					// No Windlass runs between turns, and one that runs has asked about this definition already: the
					// approval is kept, and the next turn's Windlass is told of it before its prompt goes.
					await serverApprovals.remember(c, meta, { name: server.name, fingerprint: input.fingerprint });
					note(c, meta.turns, "info", serverPanelApprovedNote(server));
					serversChanged(c, meta);
				}
				return await sessionServers(c, meta);
			} catch (error) {
				throw clientError(c.log, error, "The approval could not be remembered. Try again.");
			}
		},

		forgetServer: async (c, input: { name: string }): Promise<SessionServers> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			if (!capabilitiesOf(meta.harness).projectServerApproval)
				throw new UserError(`${harnessName(meta.harness)} does not take project MCP servers here.`, {
					code: "bad_server",
				});
			if (
				typeof input !== "object" ||
				input === null ||
				typeof input.name !== "string" ||
				input.name === "" ||
				input.name.length > 200
			) {
				throw new UserError("Say which server's approval to forget.", { code: "bad_server" });
			}
			try {
				const forgotten = await serverApprovals.forget(c, meta, input.name);
				if (forgotten > 0) {
					const { sandboxes } = await layerOf(c, meta);
					note(
						c,
						meta.turns,
						"info",
						serverForgottenNote(
							{ name: input.name },
							{ dataInSandbox: await privateSessionData(meta, sandboxes, meta.sandboxId) },
						),
					);
					serversChanged(c, meta);
				}
				return await sessionServers(c, meta);
			} catch (error) {
				throw clientError(c.log, error, "The approval could not be forgotten. Try again.");
			}
		},

		allowHost: async (c, input: { host: string }): Promise<HostAllowed> => {
			const by = await requireSessionUser(c);
			const meta = liveMeta(c);
			const host = typeof input?.host === "string" ? input.host.trim().toLowerCase().replace(/\.$/, "") : "";
			if (!isHostName(host)) throw new UserError("That is not an exact host name.", { code: "bad_network" });
			if (meta.place.kind !== "hosted")
				throw new UserError(
					"A repository's network list is for hosted sandboxes, and this agent runs on a machine of yours: its runner's --egress settings say what it reaches.",
					{ code: "bad_network" },
				);
			const project = setupProjectOf(meta);
			if (!project)
				throw new UserError(
					"This agent has no repository of your GitHub connection, so there is no list to allow a host in. The deployment's operator can allow it for every sandbox, in WLP_E2B_NETWORK_ALLOW.",
					{ code: "bad_network" },
				);
			const { sandboxes } = await layerOf(c, meta);
			// In `none` the list applies nowhere: saying it was allowed would promise a host nothing reaches.
			if (sandboxes.egress?.() === "none")
				throw new UserError(
					`This deployment gives hosted sandboxes no network but the model API (WLP_E2B_NETWORK=none), so a host allowed for ${project.label} would be reached by nothing here.`,
					{ code: "bad_network" },
				);
			if (sandboxes.egress?.() !== "restricted" || !sandboxes.setNetwork)
				throw new UserError("Repository network settings apply to restricted hosted sandboxes.", {
					code: "bad_network",
				});
			const answer = await userActor(c, meta.uid).internalAllowHost({ sessionId: meta.sessionId, host, by });
			if (!answer.allowed) {
				note(
					c,
					meta.turns,
					"info",
					`${host} was asked for: whoever changes the settings of ${project.label} can allow it there.`,
				);
				return { network: answer.network, applied: false };
			}
			meta.networkHosts = answer.hosts.length > 0 ? answer.hosts : undefined;
			c.vars.hostsAllowed.set(host, Date.now());
			let applied = false;
			// At once only while a turn holds the sandbox, and so its time is on the meter: between turns a change
			// would start a paused sandbox, or push a running one's timeout out, with nothing counting it.
			const turn = c.vars.turn;
			if (meta.sandboxId && turn && !turn.closed) {
				try {
					applied = (await sandboxes.setNetwork?.(meta.sandboxId, meta.networkHosts ?? [])) ?? false;
				} catch (error) {
					c.log.warn({ msg: "could not change the running sandbox's network", error: describeError(error) });
				}
			}
			const wide = WIDE_HOSTS[host];
			note(
				c,
				meta.turns,
				"info",
				`${host} is allowed for ${project.label}. ${applied ? "This sandbox reaches it now; for the repository's other hosted agents it applies from the next turn." : "It applies from the next turn, in this agent's sandbox and the repository's other hosted agents'."}${wide ? ` ${wide}` : ""}`,
			);
			await persist(c);
			return { network: answer.network, applied };
		},

		// One scheduled wake covers heartbeat recovery and a paused turn waiting for its machine.
		internalResumeTurn: async (c): Promise<void> => {
			if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
			const meta = c.vars.meta;
			if (meta && !c.vars.destroying) await resumePaused(c, meta);
		},

		/** Scheduled when an item's turn paused for its machine: if it still waits, the item asks its person once (`machine_away`). */
		internalMachineAsk: async (c): Promise<void> => {
			if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
			const meta = c.vars.meta;
			const run = meta?.run;
			const paused = run?.paused;
			if (
				!meta ||
				!run ||
				!paused ||
				paused.reason !== "machine" ||
				paused.asked ||
				Date.now() < paused.at + config.turnResume.machineAskMs
			)
				return;
			const row = await rowOfTurn(c.db, run.turn);
			if (!row) return;
			paused.asked = true;
			await serial(c, () =>
				c.db.transaction(
					async tx => {
						await queueMessage(tx, {
							to: "item",
							itemId: row.itemId,
							fact: {
								kind: "machine_away",
								deadline: paused.at + config.turnResume.machineAskMs,
								at: Date.now(),
								key: row.key,
								since: paused.at,
								machine: meta.machineName,
							},
						});
						await tx.execute("UPDATE meta SET data = ? WHERE id = 1", JSON.stringify(meta));
					},
					{ name: "inbox.machine_away" },
				),
			);
			await flushOutbox(c, meta.uid);
		},

		/** The session's machine is back (its runner said hello): a turn paused for it resumes. */
		internalMachineBack: async (c): Promise<void> => {
			requireService(c);
			const meta = c.vars.meta;
			if (meta && !c.vars.destroying) void c.keepAwake(resumePaused(c, meta));
		},

		/** Scheduled while a machine turn can be taken up after a crash (`armTakeUp`): the wake itself does the work (`takeUpTurn`). */
		internalTakeUp: async (c): Promise<void> => {
			if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
		},

		internalIdle: async (c): Promise<void> => {
			// RivetKit sets `scheduledFire` on the context of a call its schedule makes; a client cannot.
			const fire = c.scheduledFire;
			if (!fire) throw new UserError("This action is internal.", { code: "forbidden" });
			const meta = c.vars.meta;
			// The arming that set this check may not have stored its id yet: one set for a moment already past
			// (the wake's repair after a crash or a deploy cut a check off) fires before `schedule.at` has
			// answered, and judged then it would look replaced and be dropped, leaving the sandbox past its time.
			// The queue never rejects.
			await c.vars.arming;
			// Every firing is said, whatever the check then finds: one that finds the sandbox paused already does nothing else that shows.
			const superseded = meta?.idleCheck ? meta.idleCheck.id !== fire.id : false;
			console.log(
				`[wlp] schedule.fired session=${c.key[1]} action=internalIdle id=${fire.id} late_ms=${fire.firedAt - fire.scheduledAt}${superseded ? " superseded" : ""}`,
			);
			if (!meta || c.vars.destroying) return;
			// A check that was replaced by a later one, and whose cancel did not reach it, does nothing.
			if (superseded) return;
			try {
				await idleCheck(c, meta);
			} catch (error) {
				c.log.error({ msg: "the idle check of the sandbox failed", error: describeError(error) });
			}
		},

		internalDeliver: async (c, input: unknown): Promise<void> => {
			requireService(c);
			const meta = liveMeta(c);
			const delivery = deliveryOf(input);
			if (
				!delivery ||
				meta.origin?.itemId !== delivery.itemId ||
				!!meta.origin.planCritic !== (delivery.agent === "critic") ||
				(meta.origin.role === "reviewer") !== Boolean(delivery.checkout || delivery.agent === "critic") ||
				(delivery.checkout && (delivery.agent || delivery.fetchBase))
			)
				throw new UserError("That delivery is not this session's.", { code: "bad_input" });
			// Stored before the item is answered: from here the same delivery again adds nothing.
			await serial(c, () => receive(c.db, delivery, Date.now()));
			const row = await inboxRow(c.db, delivery.key);
			if (row?.state !== "waiting") return;
			// Answered once the queue holds the request too: a request that did not get there fails the delivery, which the item sends again.
			const answer = await requestTurn(c, meta.uid, row);
			if (answer.granted) void c.keepAwake(takeDelivered(c, meta, row.key, answer.slot));
		},

		internalSandboxReclaimed: async (c, said: string): Promise<void> => {
			requireService(c);
			note(c, liveMeta(c).turns, "info", said);
			await persist(c);
		},

		internalOwnerNote: async (c, input: { itemId: string; text: string }): Promise<boolean> => {
			requireService(c);
			const meta = liveMeta(c);
			if (
				!meta.origin ||
				meta.origin.itemId !== input?.itemId ||
				meta.origin.role === "reviewer" ||
				meta.origin.planCritic ||
				typeof input.text !== "string"
			)
				throw new UserError("That note is not this session's.", { code: "bad_input" });
			const turn = c.vars.turn;
			if (!turn || turn.closed) return false;
			try {
				await steerTurn(c, meta, turn, input.text, null);
				return true;
			} catch (error) {
				if (error instanceof UserError && error.code === "steer_unavailable") return false;
				throw error;
			}
		},

		/** Whether this actor's process holds a turn's relay lease, and its credential reference: not held, the turn has ended. */
		internalModelRelay: (c, input: { nonce: string; consume?: boolean }): Promise<RemoteLease> => {
			requireService(c);
			const nonce = typeof input?.nonce === "string" ? input.nonce : "";
			return remoteLease(nonce, c.key[0], c.key[1], input.consume);
		},

		internalGrant: (c, input: { key: string; slot: string }): void => {
			requireService(c);
			const meta = liveMeta(c);
			if (typeof input?.key !== "string" || typeof input.slot !== "string")
				throw new UserError("A grant names a delivery and a slot.", { code: "bad_input" });
			void c.keepAwake(takeDelivered(c, meta, input.key, input.slot));
		},

		internalWithdraw: async (c, key: string): Promise<void> => {
			requireService(c);
			const meta = liveMeta(c);
			if (await serial(c, () => withdrawWaiting(c.db, String(key)))) {
				await userActor(c, meta.uid).internalWithdrawTurn({ sessionId: meta.sessionId, key: String(key) });
				return;
			}
			const active = c.vars.turn;
			if (active?.item?.row.key === key) {
				active.item.withdrawn = true;
				abortTurn(c, meta, active);
				return;
			}
			// The paused turn of that delivery ends where it is: the item does not want it any more.
			if (meta.status === "paused" && meta.run?.paused && (await rowOfTurn(c.db, meta.run.turn))?.key === key)
				await endPausedTurn(c, meta, "stopped", null);
		},

		internalCheckTurn: async (c, input: { turn: string; check: string }): Promise<Fact | null> => {
			requireService(c);
			const meta = liveMeta(c);
			const row = await inboxRow(c.db, String(input?.turn));
			// Polling for the turn end follows the same order as the outbox. A publish that follows
			// this answer must already have the session's final network receipt.
			if (
				meta.blocked &&
				(await c.db.execute("SELECT 1 FROM outbox WHERE json_extract(message, '$.to') = 'network' LIMIT 1")).length
			)
				return null;
			if (row?.state === "ended") return await endedFact(c.db, row.key);
			if (row?.state !== "started") return null;
			if (c.vars.turn?.item?.row.key === row.key || c.vars.closingItem === row.key)
				return { kind: "turn_running", at: Date.now(), key: String(input.check) };
			const paused =
				meta.status === "paused" && meta.run?.paused && row.turn === meta.run.turn ? meta.run.paused : null;
			// The item's check also repairs a long pause, independently of the session's own wakes.
			if (paused && stalePause(paused) && !c.vars.resuming) {
				console.log(
					`[wlp] turn.pause_check session=${meta.sessionId} turn=${row.turn} paused_ms=${Date.now() - paused.at}`,
				);
				void c.keepAwake(resumePaused(c, meta));
			}
			if (paused || c.vars.resuming) return { kind: "turn_running", at: Date.now(), key: String(input.check) };
			// Taken, and no turn of it runs here: the server stopped under it before its end was written.
			return await closeCutTurn(
				c,
				meta,
				row,
				row.turn === null ? null : cutTurnUsage(await windlassEventsOf(c, row.turn)),
			);
		},

		internalBaseTests: async (
			c,
			input: { head: string; base: string; tests: NamedTests },
		): Promise<BaseTestResult | "pending"> => {
			requireService(c);
			const meta = liveMeta(c);
			const repo = meta.repo;
			if (
				meta.origin?.role !== "builder" ||
				!repo ||
				meta.pushedHead !== input.head ||
				!/^[0-9a-f]{40}$/.test(input.base)
			)
				return "unknown";
			const key = digest([input.head, input.base, input.tests.runner, ...input.tests.names]);
			const [known] = await c.db.execute<{ result: BaseTestResult }>("SELECT result FROM base_test WHERE key=?", key);
			if (c.vars.baseTest === key) return "pending";
			if (known) return known.result;
			if (c.vars.baseTest) return "pending";
			c.vars.baseTest = key;
			// A sandbox check can outlast an actor RPC. The CI poll collects its receipt on the next reading.
			const check = async () => {
				const claimed = await c.db.execute("INSERT OR IGNORE INTO base_test VALUES (?, 'unknown') RETURNING key", key);
				if (!claimed.length) return;
				const result = await testSessionBase(c, meta, repo, input);
				await c.db.execute("UPDATE base_test SET result=? WHERE key=?", result, key);
			};
			void c.keepAwake(
				check()
					.catch(() => {
						/* A lost attempt keeps its inconclusive receipt. */
					})
					.finally(() => {
						delete c.vars.baseTest;
					}),
			);
			return "pending";
		},

		internalOpenFromPushed: async (
			c,
			input: { title: string; body: string; head: string },
		): Promise<PullRequestInfo> => {
			requireServiceFor(c, "call");
			return openGitlabItemPull(c, liveMeta(c), input);
		},

		internalPublish: async (
			c,
			input: {
				key: string;
				title: string;
				body: string;
				blockedNetwork?: BlockedNetwork;
				branchOnly?: boolean;
				updateFromBase?: { head: string; at: number; baseTip?: string };
			},
		): Promise<ItemPublishAnswer> => {
			requireService(c);
			const meta = liveMeta(c);
			if (meta.origin?.role === "reviewer") throw new UserError("The reviewer cannot publish.", { code: "reviewer" });
			// A push for this effect that went through and whose answer did not reach the item is answered as it was, and not pushed again.
			const known = await publishReceipt(c.db, String(input?.key ?? ""));
			if (known) return known;
			const repo = meta.repo;
			if (!repo)
				return { kind: "publish_failed", said: "the item's agent has no repository to push to", transient: false };
			const blocked = publishBlocked(c, meta);
			if (blocked) return { kind: "publish_failed", said: blocked, transient: true };
			c.vars.publishing = true;
			const release = takeSandbox(c);
			try {
				const report = meta.report?.run === Number(input.key.split(":")[1]) ? meta.report : null;
				const body = report
					? [report.description, report.concerns ? `**What the agent is unsure of:** ${report.concerns}` : ""]
							.filter(part => part !== "")
							.join("\n\n")
					: String(input?.body ?? "");
				const result = await c.keepAwake(
					publishSession(
						c,
						meta,
						repo,
						{ title: report?.title || String(input?.title ?? meta.title), body },
						true,
						input.branchOnly,
						input.blockedNetwork,
						input.updateFromBase,
					),
				);
				const pull = result.state.pullRequest;
				if (!input.branchOnly && !pull)
					return { kind: "publish_failed", said: "GitHub opened no pull request", transient: true };
				// The commit git said it pushed; where git says nothing (a sandbox layer without git), the branch names it.
				const answer = {
					kind: "published" as const,
					head: meta.pushedHead ?? pull!.branch,
					pr: pull ? { number: pull.number, url: pull.url } : null,
				};
				await rememberPublish(c.db, String(input?.key ?? ""), answer);
				return answer;
			} catch (error) {
				// GitHub out of reach, or a push that took too long, is tried again by the item; any other refusal is its person's to decide.
				if (error instanceof BaseMergeConflict) return { kind: "base_conflict" };
				if (error instanceof UserError)
					return {
						kind: "publish_failed",
						said: error.message,
						transient: error instanceof PublishRefused && error.transient,
					};
				return { kind: "publish_failed", said: describeError(error), transient: true };
			} finally {
				c.vars.publishing = false;
				release();
			}
		},

		[OUTBOX_ACTION]: async (c): Promise<void> => {
			const fire = c.scheduledFire;
			if (!fire) throw new UserError("This action is internal.", { code: "forbidden" });
			// One line per firing, so that a late or lost schedule shows in the logs.
			console.log(
				`[wlp] schedule.fired action=${OUTBOX_ACTION} session=${c.key[1]} late_ms=${fire.firedAt - fire.scheduledAt}`,
			);
			const meta = c.vars.meta;
			if (meta) await sendOutbox(c, meta.uid);
		},

		internalSummary: (c): SessionSummary => {
			requireService(c);
			return summaryOf(liveMeta(c));
		},

		/** Only `user` asks, for a session of its own (`continueSession`): the actor's key holds the user's id. */
		internalForkSource: async (c): Promise<ForkSource> => {
			requireService(c);
			return await forkSource(c, liveMeta(c));
		},

		internalAssessRepository: async (
			c,
			text: string,
			continuation?: NonNullable<SessionCreateInput["readiness"]>,
		): Promise<void> => {
			requireServiceFor(c, "call");
			const meta = liveMeta(c);
			if (!meta.readiness) throw new UserError("This session cannot run setup checks.", { code: "bad_input" });
			if (continuation) {
				if (!continuation.draft?.answers || meta.status !== "idle" || meta.sandboxId || c.vars.turn || c.vars.accepting)
					throw new UserError("The earlier setup turn is still finishing.", { code: "sandbox_busy" });
				if (meta.readiness.attempt === continuation.attempt) return;
				meta.readiness = continuation;
				meta.windlassSessionId = null;
				await startPrompt(c, meta, { text, model: meta.readiness.model, effort: meta.readiness.effort }, text, null);
			} else if (!meta.turns && !c.vars.turn && !c.vars.accepting)
				await startPrompt(c, meta, { text, model: meta.readiness.model, effort: meta.readiness.effort }, text, null);
		},
		internalBuildEnvironment: async (c): Promise<void> => {
			requireService(c);
			const meta = liveMeta(c);
			if (!meta.environmentBuild) throw new UserError("This session builds no environment.", { code: "bad_input" });
			// Its one turn: a second call (a retried request) finds it taken.
			if (meta.turns > 0 || c.vars.turn || c.vars.accepting) return;
			await startPrompt(c, meta, { text: "Build the prepared environment." }, "Build the prepared environment.", null);
		},

		internalRename: async (c, title: string): Promise<SessionSummary> => {
			requireService(c);
			const meta = liveMeta(c);
			meta.title = String(title);
			meta.titleIsTyped = true;
			// The caller is the `user` actor, which takes the summary from the return value.
			c.broadcast("summary", summaryOf(meta));
			await persist(c);
			return summaryOf(meta);
		},

		/**
		 * The user frees the session's sandbox to make room for another (usage.ts). It is removed as one
		 * that was not used for long is, the timeline says who did it and what became of the agent's
		 * memory, and the next prompt starts a new sandbox. Refused while the session works.
		 */
		internalFreeSandbox: async (
			c,
			throughReviewRun?: number,
			hostedSize?: HostedSize,
			automatic?: { reason: string; cutoff?: number },
		): Promise<{ freed: boolean; sizeUnavailable?: HostedSize }> => {
			requireService(c);
			const meta = liveMeta(c);
			if (c.vars.idling) await c.vars.idling.catch(() => undefined);
			if (automatic?.cutoff !== undefined && Math.max(meta.updatedAt, meta.lastUsedAt) >= automatic.cutoff)
				return { freed: false };
			if (throughReviewRun != null && (meta.origin?.role !== "reviewer" || (meta.reviewRun ?? 0) > throughReviewRun))
				return { freed: false };
			// A stored OOM choice can outlive Pro. Check again before touching the old sandbox.
			if (
				meta.place.kind === "hosted" &&
				hostedSize &&
				billing(meta.uid) &&
				!(await userActor(c, meta.uid).internalHostedSizes()).includes(hostedSize)
			) {
				return { freed: false, sizeUnavailable: hostedSize };
			}
			if (c.vars.turn || c.vars.accepting || meta.status !== "idle")
				throw new UserError(`${meta.title} is working. Stop its turn first, then free its sandbox.`, {
					code: "sandbox_busy",
				});
			if (busy(c))
				throw new UserError(`The platform is busy with the sandbox of ${meta.title}. Try again in a moment.`, {
					code: "sandbox_busy",
				});
			const id = meta.sandboxId;
			// Set in the same step as the checks above: from here a prompt waits for it.
			const release = takeSandbox(c);
			const work = (async () => {
				const layer = await layerOf(c, meta);
				if (id) {
					const memory = !meta.windlassSessionId
						? null
						: !(await privateSessionData(meta, layer.sandboxes, id))
							? "kept"
							: layer.backups && meta.backup?.windlassSessionId === meta.windlassSessionId
								? "copied"
								: "lost";
					await removeSandbox(
						c,
						meta,
						id,
						throughReviewRun == null
							? freedNote(memory, automatic?.reason)
							: "Released the reviewer’s sandbox for the finished run.",
					);
					console.log(`[wlp] sandbox.freed id=${id} session=${meta.sessionId}`);
				}
				// Under the same exclusion: what the provider still has for the session goes with it, by the session's
				// own hand (the user actor removes only what a session that is gone left). With no sandbox of its own,
				// its place is given back here too: `removeSandbox` did not run.
				await sweepSandboxes(c, meta, layer);
				if (!id) await releasePlace(c, meta);
				// A larger size for the next sandbox (a work item whose sandbox ran out of memory): only a new sandbox has another size.
				if (meta.place.kind === "hosted" && isHostedSize(hostedSize)) meta.hostedSize = hostedSize;
				publish(c);
				await persist(c);
			})();
			c.vars.idling = work;
			try {
				await work;
			} catch (error) {
				throw clientError(c.log, error, "The sandbox could not be freed. Try again.");
			} finally {
				c.vars.idling = null;
				release();
			}
			await armIdle(c, meta);
			return { freed: id !== null };
		},

		internalDestroy: async (c): Promise<void> => {
			requireService(c);
			c.vars.destroying = true;
			const meta = c.vars.meta;
			if (meta) {
				// Done here as well as in `onDestroy`, so that the caller can retry if the machine could not record the removals.
				await stopTurn(c);
				try {
					await serial(c, () => writeItems(c));
					await settleTokenReceipts(c, meta.uid);
					await destroySessionSandboxes(c, meta);
				} catch (error) {
					c.log.error({
						msg: "could not record the session's sandbox removals",
						session: meta.sessionId,
						error: describeError(error),
					});
					c.vars.destroying = false;
					await persist(c);
					// What a turn stopped above could not set while the session was being destroyed.
					void armIdle(c, meta);
					throw new UserError(
						"The agent could not finish settling its usage or removing its sandbox. Try again in a moment.",
						{ code: "machine_unreachable" },
					);
				}
				// What its sandbox ran is reported, and its place among the user's sandboxes given back.
				await leaveUsage(c, meta);
				// The copy of Windlass's session goes with the session, once the sandbox that uploads it is gone.
				await removeBackup(c, meta);
			}
			c.destroy();
		},
	},
});
