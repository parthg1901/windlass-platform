/**
 * The software factory's part of the `user` actor (Plans "software factory" §1.2, §4.1): the index of
 * the user's work items, the turn queue, and the user's API tokens. user.ts registers these actions
 * and holds the state in its vars; everything about items is here.
 *
 * The index. One row per item with its summary, as the item last reported it, and the key it was
 * created with. An item and its agent session are made with ids derived from that key (or random,
 * without one), so a creation tried again after a lost answer reaches the same two actors and makes
 * nothing twice; the item's session is an ordinary row of the sessions' index, marked with its item.
 *
 * The turn queue. An item's turn does not take a running slot the way a person's prompt does
 * (`internalAcquireRun`, which refuses at the limit): its session asks here, and the request waits
 * as a row until it is admitted (factory/budget.ts `admit`), which answers granted or a wait with
 * the sentence the item shows. A slot is a row with its own id, named for the turn it was given to,
 * and released only by that id, when that turn ends (the session's outbox), or when it has been held
 * longer than any turn may run: never by what a session's summary says, which cannot tell "released"
 * from "not reported yet". A person's prompt counts these slots, and the factory counts the person's
 * running sessions, against the same limit. Requests are admitted oldest first: each item has at most
 * one turn waiting, so oldest first is round-robin over items. A request that waits is tried again when
 * a slot is given back, when a session of the person's goes idle, and at its wait's time on the actor's schedule.
 */

import {
	deploymentSize,
	filedAgentSettings,
	namesModel,
	partRun,
	resolveRun,
	runPlace,
	withoutUnofferedModels,
	type ResolvedRun,
	type RunContext,
} from "../factory/resolve-run.js";
import { type DefaultDestination, checkRunPlace, placeMachines } from "../factory/default-place.js";
import { isBranchName } from "../github/git.js";
import type { SessionRepository } from "../contract.js";
import {
	windlassProvider,
	hostedProvider,
	hostedProviders,
	selectedKey,
	type HostedCredential,
} from "../sandbox/harnesses.js";
import {
	accountFor,
	accountKey,
	loginGeneration,
	limitedAccounts,
	providerAccounts,
	PROVIDER_TABLE,
} from "./provider-accounts.js";
import {
	bindRoute,
	choosePlacement,
	machineSlots,
	placeKey,
	type AgentModels,
	type PlacementInventory,
	type PlacementRoute,
} from "../factory/placement.js";
import { plannerMachines } from "../machines/details.js";
import type { ChildPlacement, HostedSize, ItemFeed, PlanSubtask, SpendUsage } from "../contract.js";
import { mergeUsage, modelUsageSince } from "../factory/cost.js";
import { hostedCredentials } from "../credentials/index.js";
import { itemHarnessProblem, knownHarness, subtaskHarnessProblem } from "../sandbox/harnesses.js";
import { itemSessionId } from "../factory/feature-ids.js";
import { featureBranch, subtaskBranch } from "../github/feature.js";
import { githubIntake } from "./github-intake.js";
import {
	fileGitlabIssue,
	type GitlabTrigger,
	fileTrackerIssue,
	fileSlackRequest,
	inIntakeQueue,
	INTAKE_SOURCES,
	intakeScope,
	type SiteJiraFiling,
} from "./issue-intake.js";
import type { Intake, IntakeTrigger, TrackerFiled, LinearFiling, SlackFiling } from "../factory/intake.js";
import { GithubProblem, resolveBoundRepository, resolveRepository, type StoredConnection } from "../github/repos.js";
import { githubApp } from "../github/app.js";
import { refHead } from "../github/feature.js";
import { ALIAS } from "../factory/feature-plan.js";
import { crossRepoFactory } from "../config.js";
import type { FeatureRepoInput, FeatureRepository } from "../contract.js";
import { isGithubId } from "../github/ids.js";
import { snapshotPlaces } from "../snapshot-places.js";
import { setupProjectKey } from "../setup-command.js";
import { createHash, randomBytes } from "node:crypto";
import { UserError } from "rivetkit";
import type { RawAccess } from "rivetkit/db";
import { mayUse } from "../access.js";
import { shortLabel } from "../factory/answered.js";
import { slackChoices } from "../slack/blocks.js";
import { type CleanPage, ItemPageProblem, cleanItemPage, itemFeed, itemPage, listedItems } from "../item-pages.js";
import {
	API_TOKEN_WINDOW_MS,
	API_TOKENS_TABLE,
	ApiTokenProblem,
	createApiToken,
	listApiTokens,
	revokeApiToken,
	tokenOwner,
	useApiToken,
} from "../api-tokens.js";
import { clientError, requireService, requireServiceFor, requireUser } from "../auth.js";
import { attachmentKey } from "../factory/attachments.js";
import {
	ATTACHMENT_PUT_TTL_MS,
	attachmentStore,
	type AttachmentLedger,
	type Reservation,
	type ReserveResult,
} from "../sandbox/attach.js";
import { backupConfig, config } from "../config.js";
import {
	machineLabel,
	type GithubId,
	type ApiToken,
	type ModelList,
	type ApiTokenScope,
	type CreateItemInput,
	type CreateSessionInput,
	type ChoiceId,
	type FactoryLimits,
	type FinishedItems,
	type ItemAction,
	type ItemSummary,
	type ItemView,
	type PartScreenshots,
	type MachineSummary,
	type ItemMode,
	MAX_ACCEPTANCE_CRITERIA,
	MAX_ITEM_BODY_CHARS,
	MAX_NOTE_CHARS,
	MAX_TITLE_CHARS,
	type SandboxProfileId,
	type SessionSummary,
	SUMMARY_DAYS,
	type SummaryDays,
	USAGE_HISTORY_DAYS,
	type UserProfile,
	type Wait,
	isHostedSize,
} from "../contract.js";
import { createItem, RULES } from "../factory/blueprint.js";
import { finishedItems } from "../factory/usage-summary.js";
import { sources, thirdParty, untrustedWords } from "../factory/untrusted.js";
import { bindingsOf, legacyBindings, submissionIdentity, untrustedOf } from "../sources/bindings.js";
import {
	keptFull,
	makeSandboxRoom,
	nextSandboxRelease,
	releaseAt,
	releaseDueSandboxes,
} from "./user/kept-sandboxes.js";
import { type Admission, admit, retryAt } from "../factory/budget.js";
import {
	holdPlanTurn,
	type PayerAnswer,
	type PayerContext,
	payerContext,
	payerOf,
	paysWithRule,
	sessionModel,
} from "./user-payer.js";
import { getLayer } from "../layer.js";
import { REVIEW_OFF_REASON } from "../factory/review.js";
import { readAccountDefaults, readDefaults } from "../repository-defaults.js";
import { Attempts, type Submission, SubmissionProblem, isRepeat, submissionOf } from "../submissions.js";
import { hostedSizesForPlan } from "../billing/plans.js";
import { accountLimits, LIMITS_AUDIT_TABLE, readUserLimits, type UserLimits } from "../user-limits.js";
import {
	dailyTokenWait,
	TOKEN_USAGE_TABLE,
	usesPlatformModel,
	type UsageBook,
	dayOf,
	hostedLimitsApply,
	keptHolder,
} from "../usage.js";
import { createItemActor, isSessionGone, itemActor, sessionActor, type ActorClient } from "./internal.js";
import type { TurnAnswer, TurnRelease, TurnRequest } from "./session-inbox.js";
import { itemMachines, launchPlace, machineModelLists } from "./user-machines.js";
import type { ItemMeta } from "./work-item.js";

declare module "./internal.js" {
	interface UserInternal extends AttachmentLedger {}
}

export const ATTACHMENT_SWEEP_ACTION = "internalAttachmentSweep";
const DAY = 86_400_000;
// A margin past the PUT link's life, for a transfer still in flight when the link expired.
const ATTACHMENT_DRAIN_MS = ATTACHMENT_PUT_TTL_MS + 5 * 60_000;
export const ITEM_TABLES = [
	PROVIDER_TABLE,
	LIMITS_AUDIT_TABLE,
	TOKEN_USAGE_TABLE,
	"CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, item TEXT NOT NULL, session TEXT NOT NULL, step_key TEXT NOT NULL, sha256 TEXT NOT NULL, key TEXT NOT NULL, bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, ended_at INTEGER)",
	"CREATE INDEX IF NOT EXISTS attachments_active_digest ON attachments(item, step_key, sha256) WHERE state IN ('reserved','kept')",
	"CREATE INDEX IF NOT EXISTS attachments_item ON attachments(item, state)",
	"CREATE TABLE IF NOT EXISTS attachment_sweep (id INTEGER PRIMARY KEY CHECK(id=1), schedule TEXT NOT NULL, at INTEGER NOT NULL)",
	"CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, summary TEXT NOT NULL, key TEXT, sent TEXT)",
	// Work items' model turns of the UTC day (`modelsToday`): what an item's usage grew by, one row per change.
	"CREATE TABLE IF NOT EXISTS models_day (id INTEGER PRIMARY KEY, day INTEGER NOT NULL, usage TEXT NOT NULL)",
	// A creation's key and the digest of what it asked for, written before either of its actors is made: a creation tried
	// again under that key with another body is refused even when the first never reached the index.
	// Pin before the deterministic session actor is created, including across a lost creation reply.
	"CREATE TABLE IF NOT EXISTS child_launch (id TEXT PRIMARY KEY, placement TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS item_keys (key TEXT PRIMARY KEY, sent TEXT NOT NULL, id TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS github_item_keys (key TEXT PRIMARY KEY, sent TEXT NOT NULL, id TEXT NOT NULL, draft INTEGER NOT NULL, created_at INTEGER NOT NULL)",
	// A turn of an item's session waiting for a slot: `wait` is what it was last told, `attempt` how often it waited.
	"CREATE TABLE IF NOT EXISTS turn_request (key TEXT PRIMARY KEY, session TEXT NOT NULL, item TEXT NOT NULL, title TEXT NOT NULL, starts_run INTEGER NOT NULL, at INTEGER NOT NULL, attempt INTEGER NOT NULL, full INTEGER, full_until INTEGER, wait TEXT)",
	// A slot given to the turn of `key`: released by its id, or when `expires_at` has passed.
	"CREATE TABLE IF NOT EXISTS turn_slot (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, session TEXT NOT NULL, item TEXT NOT NULL, title TEXT NOT NULL, at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
	// A slot whose session has not been told of it yet: told on the queue's next run and on wake, until the session answers.
	"CREATE TABLE IF NOT EXISTS turn_grant (slot TEXT PRIMARY KEY)",
	// The schedule that tries the waiting requests again: one, at the earliest wait's time.
	"CREATE TABLE IF NOT EXISTS turn_queue (id INTEGER PRIMARY KEY CHECK (id = 1), schedule TEXT NOT NULL, at INTEGER NOT NULL)",
	API_TOKENS_TABLE,
];

interface Request {
	key: string;
	session: string;
	item: string;
	title: string;
	startsRun: boolean;
	at: number;
	attempt: number;
	/** The hosted deployment's cap, when that was the refusal. */
	full: number | null;
	/** Retry time after a deployment refusal or an unanswered machine attach. */
	deferUntil: number | null;
	wait: Wait | null;
}

interface Slot {
	id: string;
	key: string;
	session: string;
	item: string;
	title: string;
	at: number;
	expiresAt: number;
	/** False until the session has answered for its grant: a grant lost with a server or a reply is sent again. */
	told: boolean;
}

export interface ItemsState {
	limits: UserLimits;
	items: Map<string, ItemSummary>;
	/** The items created with a key, by that key: what was asked for, and the item. */
	created: Map<string, Submission & { id: string }>;
	creating: Attempts<ItemSummary>;
	requests: Map<string, Request>;
	slots: Map<string, Slot>;
	queueAt: { id: string; at: number } | null;
	arming?: Promise<void>;
	sandboxRetries?: Map<string, number>;
}

/** A slot is held at most this long: longer than any turn may run, and the time a lost release costs. */
const SLOT_LEASE_MS = config.turnTimeoutMs + 5 * 60_000;
/** What the sandbox layer said of the deployment's cap is believed this long. */
const FULL_FOR_MS = 5 * 60_000;
const KEYED = "work item";
/** The action the turn queue's schedule fires (factory-e2e.ts checks it is registered under this name). */
export const QUEUE_ACTION = "internalTurnQueue";

/** The key of a creation in `ItemsState.created`: an item filed from an issue is in a scope of its own, apart from the web's and the API's. */
const scopedKey = (intake: boolean, key: string) => (intake ? intakeScope(key) : "user:" + key);

export async function loadItems(db: RawAccess): Promise<ItemsState> {
	const items = new Map<string, ItemSummary>();
	const created = new Map<string, Submission & { id: string }>();
	for (const row of await db.execute<{ summary: string; key: string | null; sent: string | null }>(
		"SELECT summary, key, sent FROM items",
	)) {
		const summary = JSON.parse(row.summary) as ItemSummary;
		summary.origin ??= null;
		summary.mode ??= "single";
		summary.parent ??= null;
		items.set(summary.id, summary);
		if (row.key !== null && row.sent !== null)
			created.set(scopedKey(INTAKE_SOURCES.has(summary.source), row.key), {
				key: row.key,
				sent: row.sent,
				id: summary.id,
			});
	}
	for (const row of await db.execute<{ key: string; sent: string; id: string }>("SELECT key, sent, id FROM item_keys"))
		created.set(scopedKey(false, row.key), row);
	for (const row of await db.execute<{ key: string; sent: string; id: string }>(
		"SELECT key, sent, id FROM github_item_keys",
	))
		created.set(scopedKey(true, row.key), row);
	const requests = new Map<string, Request>();
	type RequestRow = {
		key: string;
		session: string;
		item: string;
		title: string;
		starts_run: number;
		at: number;
		attempt: number;
		full: number | null;
		full_until: number | null;
		wait: string | null;
	};
	for (const row of await db.execute<RequestRow>(
		"SELECT key, session, item, title, starts_run, at, attempt, full, full_until, wait FROM turn_request",
	)) {
		requests.set(row.key, {
			key: row.key,
			session: row.session,
			item: row.item,
			title: row.title,
			startsRun: row.starts_run === 1,
			at: row.at,
			attempt: row.attempt,
			full: row.full,
			deferUntil: row.full_until,
			wait: row.wait ? (JSON.parse(row.wait) as Wait) : null,
		});
	}
	const slots = new Map<string, Slot>();
	type SlotRow = {
		id: string;
		key: string;
		session: string;
		item: string;
		title: string;
		at: number;
		expires_at: number;
	};
	const untold = new Set((await db.execute<{ slot: string }>("SELECT slot FROM turn_grant")).map(row => row.slot));
	for (const row of await db.execute<SlotRow>("SELECT id, key, session, item, title, at, expires_at FROM turn_slot"))
		slots.set(row.id, { ...row, expiresAt: row.expires_at, told: !untold.has(row.id) });
	const [queue] = await db.execute<{ schedule: string; at: number }>(
		"SELECT schedule, at FROM turn_queue WHERE id = 1",
	);
	return {
		limits: await readUserLimits(db),
		items,
		created,
		creating: new Attempts(),
		requests,
		slots,
		queueAt: queue ? { id: queue.schedule, at: queue.at } : null,
	};
}

/**
 * What an item reads of its user: its session's entries in the ledger, each once by its hold (the item
 * adds up its own lifetime total from them, since the ledger keeps only the last days), and the user's
 * items not done, failed or cancelled.
 */
export interface ItemFacts {
	entries: Array<{ hold: string; session: string; seconds: number }>;
	openItems: number;
}

/** What the factory's functions need of the user actor's context. */
export interface ItemsCtx {
	vars: {
		tokenGen: number;
		github?: StoredConnection | null;
		items: ItemsState;
		machines: Map<string, MachineSummary>;
		sessions: Map<string, SessionSummary>;
		usage: UsageBook;
		profile: UserProfile | null;
	};
	db: RawAccess;
	key: string[];
	log: { warn(entry: unknown): void; error(entry: unknown): void };
	broadcast(name: string, ...args: unknown[]): void;
	client(): ActorClient;
	keepAwake<T>(promise: Promise<T>): Promise<T>;
	schedule: {
		at(timestamp: number, action: string, ...args: unknown[]): Promise<string>;
		cancel(id: string): Promise<boolean>;
	};
	conn?: { params: unknown } | null;
	scheduledFire?: { id: string; scheduledAt: number; firedAt: number };
}

export interface ItemSessionInput {
	payer?: ResolvedRun["payer"];
	afterPlanning?: Pick<ResolvedRun, "model" | "effort">;
	sessionId: string;
	itemId: string;
	role: "builder" | "reviewer";
	subtaskScreenshots?: boolean;
	planCritic?: true;
	size?: number;
	hostedSize?: HostedSize;
	owns?: string[];
	childBranch?: { name: string; start: string };
	issue?: { number: number; installationId: GithubId };
	gitlab?: { project: SessionRepository; iid: string };
	effort?: string;
}
export interface MakeSession {
	(owner: UserProfile, input: CreateSessionInput, item: ItemSessionInput): Promise<SessionSummary>;
	/** The account's Windlass models, to leave out a saved default model they no longer offer (`withoutUnofferedModels`). */
	accountModels?(demo: boolean): Promise<ModelList>;
}

// ---------------------------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------------------------

function itemList(state: ItemsState): ItemSummary[] {
	return listedItems(state.items.values());
}

/** What the live feed carries: open items, the newest ended ones, the counts (item-pages.ts). */
const feedOf = (state: ItemsState): ItemFeed => itemFeed(itemList(state), state.items.values());

/** The summary's own fields of an item's summary or page: the index keeps no more. */
function summaryFields(item: ItemSummary): ItemSummary {
	const {
		id,
		title,
		repository,
		place,
		source,
		state,
		wait,
		question,
		pullRequest,
		verdict,
		review,
		budget,
		spent,
		sessionId,
		createdAt,
		updatedAt,
		revision,
	} = item;
	return {
		id,
		title,
		repository,
		place,
		agent: item.agent,
		resolved: item.resolved,
		ranWith: item.ranWith,
		repositories: item.repositories,
		record: item.record,
		endedAt: item.endedAt,
		...(item.awaitingPlace && { awaitingPlace: true }),
		...(item.placement && { placement: item.placement }),
		source,
		mode: item.mode ?? "single",
		parent: item.parent ?? null,
		origin: item.origin ?? null,
		state,
		wait,
		question,
		pullRequest,
		verdict,
		review,
		budget,
		spent,
		...(item.partsUsage && { partsUsage: item.partsUsage }),
		...(item.partsRetryUsage && { partsRetryUsage: item.partsRetryUsage }),
		...(item.workType && { workType: item.workType }),
		...(item.startedAt !== undefined && { startedAt: item.startedAt }),
		sessionId,
		createdAt,
		updatedAt,
		revision,
		...(item.step && { step: item.step }),
	};
}

/** Takes a summary the item reported when it is newer than the one held: reports can arrive out of order. */
async function noteItem(c: ItemsCtx, given: ItemSummary): Promise<void> {
	const summary = summaryFields(given);
	const held = c.vars.items.items.get(summary.id);
	if (!held || held.revision > summary.revision) return;
	c.vars.items.items.set(summary.id, summary);
	await c.db.execute("UPDATE items SET summary = ? WHERE id = ?", JSON.stringify(summary), summary.id);
	await noteModelsToday(c.db, modelUsageSince(summary.spent.usage, held.spent.usage));
	if (ended(summary))
		await c.db.execute(
			"UPDATE attachments SET ended_at=COALESCE(ended_at, ?) WHERE item=?",
			summary.updatedAt,
			summary.id,
		);
	else if (ended(held))
		await c.db.execute("UPDATE attachments SET ended_at=NULL WHERE item=? AND ended_at>0", summary.id);
	c.broadcast("items", feedOf(c.vars.items));
	if (releaseAt(summary) !== releaseAt(held)) queueChanged(c);
}

// The one path for a person's action, from the web or from Slack.
async function act(
	c: ItemsCtx,
	uid: string,
	id: string,
	action: ItemAction,
	slack?: { user: string; question: string },
): Promise<ItemView> {
	enabled();
	knownItem(c, id);
	const view = await itemActor(c, uid, id).internalAct({ action, by: `person:${uid}`, ...(slack && { slack }) });
	await noteItem(c, view);
	return view;
}

/** A Slack button or reply. `version`: the plan the Approve button was posted with. */
export interface SlackAnswer {
	id: string;
	question: string;
	choice: ChoiceId;
	version?: number;
	note?: string;
	slackUser: string;
}
export type SlackReply = { kind: "answered" } | { kind: "choices"; labels: string[] } | { kind: "none" };
const words = (text: string) =>
	text
		.toLowerCase()
		.replace(/_/g, " ")
		.replace(/[^\p{L}\p{N} ]/gu, "")
		.replace(/\s+/g, " ")
		.trim();

function slackOwner(c: ItemsCtx): UserProfile {
	const { profile } = c.vars;
	if (!profile || !mayUse(profile, config.access))
		throw new UserError("This account cannot act on work items here.", { code: "item_not_found" });
	return profile;
}

// Approve is the web's version-bound approval. Every other choice is the web's answer to that question.
function slackAct(c: ItemsCtx, input: SlackAnswer) {
	const { uid } = slackOwner(c);
	const action: ItemAction =
		input.choice === "approve" && input.version !== undefined
			? { kind: "approve_plan", version: input.version }
			: { kind: "answer", question: input.question, choice: input.choice, ...(input.note && { note: input.note }) };
	return act(c, uid, input.id, action, { user: input.slackUser, question: input.question });
}

/** Adds model turns to today's (`modelsToday`); only today's row is kept. */
async function noteModelsToday(db: ItemsCtx["db"], fresh: SpendUsage): Promise<void> {
	if (fresh.models.length === 0) return;
	const today = dayOf(Date.now());
	await db.execute("DELETE FROM models_day WHERE day < ?", today);
	await db.execute("INSERT INTO models_day(day, usage) VALUES(?, ?)", today, JSON.stringify(fresh));
}

/** Work items' model turns today (`UsageView.modelsToday`). */
export async function modelsToday(db: ItemsCtx["db"], now: number): Promise<SpendUsage> {
	const rows = await db.execute<{ usage: string }>("SELECT usage FROM models_day WHERE day = ?", dayOf(now));
	return mergeUsage(rows.map(row => JSON.parse(row.usage) as SpendUsage));
}

function knownItem(c: ItemsCtx, id: unknown): ItemSummary {
	const summary = typeof id === "string" ? c.vars.items.items.get(id) : undefined;
	if (!summary) throw new UserError("That item does not exist.", { code: "item_not_found" });
	return summary;
}

const githubItemId = (uid: string, key: string) => `i_${hex16(JSON.stringify(["github", uid, key]))}`;
const hex16 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The input of a new item, checked. */
function cleanItemInput(raw: unknown) {
	const bad = (message: string) => new UserError(message, { code: "bad_input" });
	const input = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<Record<keyof CreateItemInput, unknown>>;
	if (input.mode !== undefined && input.mode !== "single" && input.mode !== "orchestrate")
		throw bad("Choose single or orchestrate for the work item.");
	if (input.mode === "orchestrate" && process.env.WLP_FACTORY_ORCHESTRATE === "0")
		throw bad("Orchestrated work items are disabled.");
	const harness = knownHarness(input.harness ?? "windlass");
	if (harness === null) throw bad("Choose an agent this platform runs: windlass, or one of your machine's.");
	const notForItems = itemHarnessProblem(harness);
	if (notForItems) throw bad(notForItems);
	const title = typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim() : "";
	if (title === "" || title.length > MAX_TITLE_CHARS)
		throw bad(`Give the item a title of at most ${MAX_TITLE_CHARS} characters.`);
	const body = typeof input.body === "string" ? input.body.trim() : "";
	if (body === "" || body.length > MAX_ITEM_BODY_CHARS)
		throw bad(`Say what is to be done, in at most ${MAX_ITEM_BODY_CHARS} characters.`);
	const acceptance = input.acceptance === undefined || input.acceptance === null ? [] : input.acceptance;
	if (
		!Array.isArray(acceptance) ||
		acceptance.length > MAX_ACCEPTANCE_CRITERIA ||
		!acceptance.every(line => typeof line === "string" && line.trim() !== "" && line.length <= MAX_NOTE_CHARS)
	) {
		throw bad(
			`The acceptance criteria are at most ${MAX_ACCEPTANCE_CRITERIA} lines of text, each at most ${MAX_NOTE_CHARS} characters.`,
		);
	}
	const place = launchPlace(input.place ?? undefined);
	const repository = input.repository as { id?: unknown; branch?: unknown } | undefined;
	if (typeof repository !== "object" || repository === null || !isGithubId(repository.id))
		throw bad("Choose a repository of your GitHub connection for the item.");
	if (input.start !== undefined && input.start !== null && typeof input.start !== "boolean")
		throw bad("Say yes or no to starting the item at once.");
	const mode: ItemMode = input.mode ?? (process.env.WLP_FACTORY_ORCHESTRATE === "0" ? "single" : "orchestrate");
	const partProblem = mode === "orchestrate" && subtaskHarnessProblem(harness);
	if (partProblem) throw bad(partProblem);
	const repositories = cleanRepositories(input.repositories, repository.id, mode, bad);
	const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
	if (
		input.effort !== undefined &&
		input.effort !== null &&
		(typeof input.effort !== "string" || input.effort.length > 64)
	)
		throw new UserError("Choose one of the efforts the item's agent offers.", { code: "bad_effort" });
	if (input.hostedSize !== undefined && input.hostedSize !== null && !isHostedSize(input.hostedSize))
		throw bad("Choose a hosted size: Small, Medium or Large.");
	if (isHostedSize(input.hostedSize) && place.kind !== "hosted")
		throw bad("A hosted size is for an item that runs hosted.");
	return {
		mode,
		place: input.place == null ? input.place : runPlace(place),
		title,
		body,
		acceptance: acceptance.map((line: string) => line.trim()),
		repository: { id: repository.id, ...(typeof repository.branch === "string" ? { branch: repository.branch } : {}) },
		repositories,
		profile: text(input.profile) as SandboxProfileId | null,
		model: text(input.model),
		reviewModel: text(input.reviewModel),
		effort: text(input.effort),
		start: input.start === true,
		harness: input.harness == null ? input.harness : harness,
		...(isHostedSize(input.hostedSize) && { hostedSize: input.hostedSize }),
	};
}

/**
 * A filing's repositories (`CreateItemInput.repositories`), checked: null for one repository. Two only for
 * Plan first, where the deployment allows cross-repo features, the first being the item's `repository`.
 */
function cleanRepositories(
	raw: unknown,
	primary: GithubId,
	mode: string,
	bad: (message: string) => UserError,
): FeatureRepoInput[] | null {
	if (raw === undefined || raw === null) return null;
	if (!Array.isArray(raw) || raw.length < 1) throw bad("List the feature's repositories: one or two.");
	if (raw.length > 2) throw bad("A feature spans at most two repositories.");
	const list = raw.map((entry): FeatureRepoInput => {
		const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
		if (typeof e.alias !== "string" || !ALIAS.test(e.alias))
			throw bad(
				"Give each repository a short alias: a lowercase letter, then up to 15 lowercase letters, digits or dashes.",
			);
		if (!isGithubId(e.id)) throw bad("Name each repository by GitHub's id for it.");
		if (e.branch !== undefined && typeof e.branch !== "string")
			throw bad("A repository's base branch is a branch name.");
		return { alias: e.alias, id: e.id, ...(typeof e.branch === "string" && { branch: e.branch }) };
	});
	if (String(list[0]!.id) !== String(primary)) throw bad("The first of the repositories is the item's repository.");
	if (new Set(list.map(r => r.alias)).size !== list.length || new Set(list.map(r => String(r.id))).size !== list.length)
		throw bad("Name each repository once, each with its own alias.");
	if (list.length === 1) return null;
	if (mode !== "orchestrate") throw bad("Only a Plan-first feature spans two repositories.");
	if (!crossRepoFactory()) throw bad("Features over two repositories are not offered on this deployment.");
	return list;
}

/**
 * Binds a cross-repo filing's repositories to the user's GitHub connection now: GitHub's ids for each and
 * its installation, which are the authority from here on, and the commit of each base the planner reads.
 * The primary is the item's session's own repository. Each must be one the user can write to, and not
 * archived: the feature pushes a branch and opens a pull request in every one of them.
 */
async function bindRepositories(
	c: ItemsCtx,
	list: FeatureRepoInput[],
	primaryBranch: string | undefined,
): Promise<FeatureRepository[]> {
	const app = githubApp(),
		connection = c.vars.github;
	if (!app || !connection)
		throw new UserError("Connect GitHub to file a feature over two repositories.", { code: "github_not_connected" });
	const bound: FeatureRepository[] = [];
	for (const [i, entry] of list.entries()) {
		const named = (error: unknown): never => {
			if (error instanceof GithubProblem) throw new UserError(`${entry.alias}: ${error.message}`, { code: error.code });
			throw error;
		};
		const found = await resolveRepository(app, connection, entry.id, "write").catch(named);
		// Read again by id through that installation: the listing may be minutes old, and an archive since then refuses the binding.
		const { installation, repository } = await resolveBoundRepository(
			app,
			connection,
			entry.id,
			found.installation.id,
			"write",
		).catch(named);
		const baseRef = (i === 0 ? primaryBranch : entry.branch) ?? repository.defaultBranch;
		const planningBaseSha = await app.withToken(
			installation.id,
			{ repositoryId: entry.id, permissions: { metadata: "read", contents: "read" } },
			token => refHead(app, token, repository.owner, repository.name, baseRef),
		);
		bound.push({
			alias: entry.alias,
			repositoryId: entry.id,
			installationId: installation.id,
			owner: repository.owner,
			name: repository.name,
			url: app.repositoryUrl(repository.owner, repository.name),
			private: repository.private,
			baseRef,
			planningBaseSha,
		});
	}
	return bound;
}

export interface DefaultBuilder {
	context: RunContext;
	role: "builder" | "planner" | "part" | "repair";
	repository: CreateItemInput["repository"];
	title: string;
	issue?: { number: number; installationId: GithubId };
	gitlab?: { project: SessionRepository; iid: string };
}

const availabilityErrors = new Set([
	"bad_input",
	"bad_model",
	"bad_effort",
	"machine_not_found",
	"machine_not_connected",
	"runner_outdated",
	"runner_signing_disabled",
	"bad_profile",
	"profile_unavailable",
	"harness_signed_out",
]);

async function defaultBuilder(
	c: ItemsCtx,
	owner: UserProfile,
	itemId: string,
	job: DefaultBuilder,
	run: ResolvedRun,
	makeSession: MakeSession,
	phase: "file" | "retry",
	child?: Pick<ItemSessionInput, "owns" | "size" | "subtaskScreenshots" | "childBranch">,
): Promise<{ session: SessionSummary | null; destination: DefaultDestination }> {
	const sessionId = itemSessionId(itemId);
	const existing = c.vars.sessions.get(sessionId);
	if (existing)
		return { session: existing, destination: { place: existing.place, harness: existing.harness ?? "windlass" } };
	const machines = itemMachines(c.vars.machines);
	let models: AgentModels | undefined;
	if (!child && run.place !== "hosted" && run.agent !== "windlass" && (run.model || run.effort)) {
		models = { machines: await machineModelLists(c, placeMachines(run.place, machines), id => id === run.agent) };
	}
	const destination: DefaultDestination =
		child && typeof run.place === "object"
			? {
					place: { kind: "machine", machineId: run.place.machine },
					profile: run.profile ?? undefined,
					harness: run.agent,
				}
			: checkRunPlace(run, machines, models);
	// Explicit filing choices fail at the call site. A saved default or a retry can wait for availability.
	const filedChoice =
		phase === "file" && [run.sources.place, run.sources.agent, run.sources.model, run.sources.effort].includes("item");
	if (filedChoice && destination.refusal)
		throw new UserError(destination.refusal.message, { code: destination.refusal.code });
	if (destination.wait && !child) return { session: null, destination };
	let profile = destination.profile;
	if (!profile) {
		const available = (await getLayer()).sandboxes.profiles().filter(p => p.available);
		profile = (run.agent === "windlass" ? available[0] : (available.find(p => p.platformKeys) ?? available[0]))?.id;
	}
	try {
		if (!profile) throw new UserError("Choose an available sandbox profile.", { code: "bad_profile" });
		// A one-implementer plan reuses this Windlass workspace, with the build model.
		const build =
			job.role === "planner"
				? resolveRun({ ...job.context, item: { ...job.context.item, harness: "windlass" } }, "builder")
				: null;
		const session = await makeSession(
			owner,
			{
				title: job.title,
				repository: job.repository,
				place: destination.place,
				profile,
				harness: run.agent,
				model: run.model ?? undefined,
				...(destination.place.kind === "hosted" &&
					(run.sources.size !== "deployment" || job.context.deployment?.hostedSize) && { hostedSize: run.size }),
			},
			{
				sessionId,
				itemId,
				role: "builder",
				payer: run.payer,
				issue: job.issue,
				gitlab: job.gitlab,
				effort: run.effort ?? undefined,
				...(build && { afterPlanning: { model: build.model, effort: build.effort } }),
				...child,
			},
		);
		return { session, destination };
	} catch (error) {
		if (child || !(error instanceof UserError) || !availabilityErrors.has(error.code)) throw error;
		if (filedChoice && ["bad_input", "bad_model", "bad_effort", "harness_signed_out"].includes(error.code)) throw error;
		return { session: null, destination: { ...destination, wait: error.message } };
	}
}

async function bindReviewer(
	c: ItemsCtx,
	owner: UserProfile,
	session: SessionSummary,
	itemId: string,
	child: boolean,
	job: DefaultBuilder,
	makeSession: MakeSession,
): Promise<{
	reviewer?: import("../factory/types.js").FactoryItem["reviewer"];
	reviewerSessionId: string | null;
	wait?: string;
}> {
	const off = (reason: keyof typeof REVIEW_OFF_REASON) => ({ reviewer: { off: reason }, reviewerSessionId: null });
	if (child) return off("feature");
	if (!config.factory.reviewer || session.repository?.provider === "gitlab") return off("deployment");
	const reviewerSessionId = `s_${hex16(`review\n${itemId}`)}`;
	if (!c.vars.sessions.has(reviewerSessionId)) {
		const { id, branch } = session.repository!;
		const run = resolveRun(job.context, "reviewer");
		try {
			await makeSession(
				owner,
				{
					title: session.title,
					place: session.place,
					profile: run.profile ?? session.profile,
					harness: run.agent,
					model: run.model ?? undefined,
					repository: { id, branch },
				},
				{
					sessionId: reviewerSessionId,
					itemId,
					role: "reviewer",
					issue: job.issue,
					gitlab: job.gitlab,
					effort: run.effort ?? undefined,
					...(session.hostedSize && { hostedSize: session.hostedSize }),
				},
			);
		} catch (error) {
			if (!(error instanceof UserError) || !availabilityErrors.has(error.code)) throw error;
			return { wait: "The reviewer cannot start. " + error.message, reviewerSessionId: null, reviewer: undefined };
		}
	}
	return { reviewer: { on: true } as const, reviewerSessionId };
}

/** Bind the same repository even when the item's machine session cannot be created yet. */
async function waitingRepository(c: ItemsCtx, job: DefaultBuilder): Promise<SessionRepository> {
	const app = githubApp(),
		connection = c.vars.github;
	if (!app || !connection) throw new UserError("Connect GitHub to file this item.", { code: "github_not_connected" });
	const { id, branch } = job.repository;
	if (branch !== undefined && !isBranchName(branch))
		throw new UserError("Choose a valid base branch.", { code: "bad_input" });
	const { repository } = job.issue
		? await resolveBoundRepository(app, connection, id, job.issue.installationId, "read")
		: await resolveRepository(app, connection, id, "read");
	return {
		provider: "github",
		id,
		owner: repository.owner,
		name: repository.name,
		private: repository.private,
		branch: branch ?? repository.defaultBranch,
		url: app.repositoryUrl(repository.owner, repository.name),
	};
}

/**
 * Makes the item: its session (`makeSession`, under an id derived from the item's), then the item
 * actor, then its row in the index, in one step at the end. Both actors are made under ids fixed
 * before anything is asked of the engine, and one that exists already is taken as made: a creation
 * that is tried again after a lost answer, or after the server stopped half way, finishes the first.
 */
/** The account's and the repository's saved defaults for a new item, without a model the account no longer offers. */
async function savedContext(
	c: ItemsCtx,
	profile: UserProfile,
	project: string,
	makeSession: MakeSession,
): Promise<RunContext> {
	const account = await readAccountDefaults(c.db);
	const repository = await readDefaults(c.db, project);
	if (!makeSession.accountModels || !(namesModel(account) || namesModel(repository))) return { account, repository };
	// Without a list (the plan is signed out), the defaults stay as saved and the item waits with the reason.
	const list = await makeSession.accountModels(profile.demo).catch(() => null);
	if (!list) return { account, repository };
	return { account: withoutUnofferedModels(account, list), repository: withoutUnofferedModels(repository, list) };
}

async function makeItem(
	c: ItemsCtx,
	profile: UserProfile,
	raw: unknown,
	source: ItemSummary["source"],
	submission: Submission | null,
	makeSession: MakeSession,
	intake?: Intake,
	child?: {
		resolved: ResolvedRun;
		context: RunContext;
		role: "part" | "repair";
		screenshots: boolean;
		mergeTarget?: string;
		joinOnGate: boolean;
		featureBody: string;
		placement: ChildPlacement;
		id: string;
		base: string;
		start?: string | null;
		owns: string[];
		parent: NonNullable<ItemSummary["parent"]>;
		budget: ItemSummary["budget"];
		untrusted?: string[];
		unsandboxed?: string[];
	},
): Promise<ItemSummary> {
	const input = cleanItemInput(raw);
	const { github, linear, gitlab, jira, slack } = intake ?? {};
	// An issue proposes a feature in its own repository only: a sibling needs the owner's own filing.
	if (intake && input.repositories)
		throw new UserError("An issue files a feature in its own repository only.", { code: "bad_input" });
	// Where the deployment has billing, a feature over two repositories is Pro's (billing/plans.ts).
	if (input.repositories && accountLimits(c.vars.items.limits).plan?.crossRepo === false)
		throw new UserError(
			"Features over two repositories are on Pro. Upgrade in Settings, or file one item per repository.",
			{ code: "bad_input" },
		);
	const uid = profile.uid;
	const itemId =
		child?.id ??
		(intake && submission
			? githubItemId(uid, submission.key)
			: `i_${submission ? hex16(`${uid}\n${submission.key}`) : randomBytes(8).toString("hex")}`);
	const sessionId = itemSessionId(itemId);
	const issue = github && { number: github.origin.issue.number, installationId: github.installationId };
	const context: RunContext =
		child?.context ??
		(await savedContext(c, profile, `${gitlab ? "gitlab" : "github"}:${input.repository.id}`, makeSession));
	const role = child?.role ?? (input.mode === "orchestrate" ? "planner" : "builder");
	if (!child) {
		const offered = hostedSizesForPlan(
			(await getLayer()).sandboxes.sizes?.() ?? [],
			accountLimits(c.vars.items.limits).plan,
		);
		context.deployment = { hostedSize: deploymentSize(offered.map(s => s.id)) };
		context.item = {
			place: input.place,
			reviewModel: input.reviewModel,
			harness: input.harness,
			hostedSize: input.hostedSize,
			profile: input.profile,
			machineProfile: input.profile,
		};
		Object.assign(context.item, filedAgentSettings(context, input.model, input.effort));
	}
	const run = child?.resolved ?? resolveRun(context, role);
	const job: DefaultBuilder = {
		context,
		role,
		repository: input.repository,
		title: input.title,
		issue,
		...(gitlab && { gitlab: { project: gitlab.project, iid: gitlab.iid } }),
	};
	let summary: ItemSummary;
	// Set just before the session is made: a refusal before that made nothing, and leaves the key unused.
	let begun = false;
	if (submission) {
		// The key is this body's from here, before anything is made: in memory now, so that a second attempt is judged by it at
		// once, and stored before the first actor, so that it holds across a restart too.
		c.vars.items.created.set(scopedKey(!!intake, submission.key), { ...submission, id: itemId });
		if (intake)
			await c.db.execute(
				"INSERT OR IGNORE INTO github_item_keys VALUES(?,?,?,?,?)",
				submission.key,
				submission.sent,
				itemId,
				Number(!input.start),
				Date.now(),
			);
		else
			await c.db.execute(
				"INSERT OR IGNORE INTO item_keys (key, sent, id) VALUES (?, ?, ?)",
				submission.key,
				submission.sent,
				itemId,
			);
	}
	try {
		// Bound before anything is made: a repository the connection cannot read refuses the filing with nothing left behind.
		const repos =
			input.repositories && !child ? await bindRepositories(c, input.repositories, input.repository.branch) : undefined;
		if (repos)
			context.repositories = Object.fromEntries(
				await Promise.all(repos.map(async r => [r.alias, await readDefaults(c.db, "github:" + r.repositoryId)])),
			);
		begun = true;
		const { session, destination } = await defaultBuilder(
			c,
			profile,
			itemId,
			job,
			run,
			makeSession,
			"file",
			child && {
				owns: child.owns,
				size: child.placement.units,
				subtaskScreenshots: child.screenshots,
				...(child.start && {
					childBranch: { name: subtaskBranch(child.parent.itemId, child.parent.key, itemId), start: child.start },
				}),
			},
		);
		if (session) {
			if (!run.model && run.agent === "windlass" && !child) (context.deployment ??= {}).model = session.model;
			run.model ??= session.model;
			run.profile ??= session.profile;
			run.size = session.hostedSize ?? run.size;
		}
		const repository = session?.repository ?? job.gitlab?.project ?? (await waitingRepository(c, job));
		if (!repository) throw new Error("the item's session has no repository");
		const review = session && (await bindReviewer(c, profile, session, itemId, !!child, job, makeSession));
		const now = Date.now();
		const meta: ItemMeta = {
			...((!session || review?.wait) && { pendingBuilder: job }),
			uid,
			sessionId,
			reviewerSessionId: review?.reviewerSessionId ?? null,
			reviewBase: null,
			handoffReview: null,
			repository,
			source,
			github,
			...(linear && { linear }),
			...(jira && { jira }),
			...(slack && { slack }),
			createdAt: now,
			activityAt: now,
			verdict: null,
			ledger: { seconds: 0, holds: [] },
		};
		const limits = accountLimits(c.vars.items.limits).factory;
		const item = createItem({
			id: itemId,
			mode: input.mode,
			...(repos && { repos }),
			reviewer: review?.reviewer,
			task: { title: input.title, body: input.body, acceptance: input.acceptance, base: repository.branch },
			place: session?.place ?? destination.place,
			budget: child?.budget ?? limits.item,
			agent: {
				harness: session ? (session.harness ?? "windlass") : destination.harness,
				model: session?.model ?? "default",
				effort: run.effort,
				...(session?.item?.signIn && { signIn: session.item.signIn }),
			},
		});
		item.runRole = role;
		item.context = context;
		item.resolved = run;
		if (!session) item.awaitingPlace = destination.wait;
		else if (run.place === "any-machine") run.place = runPlace(session.place);
		if (review?.wait) {
			item.awaitingPlace = review.wait;
			item.awaitingReviewer = true;
		}
		if (child) {
			item.task.featureBody = child.featureBody;
			item.parent = child.parent;
			item.joinOnGate = child.joinOnGate;
			item.childBase = child.base;
			item.mergeTarget = child.mergeTarget;
			item.placement = child.placement;
		}
		// An issue someone else wrote is not the person's own text: every turn that hands the agent the task says where it came from.
		const outside = sources(child?.untrusted, gitlab?.sources, bindingsOf(meta).flatMap(untrustedOf));
		if (outside.length) item.untrusted = outside;
		const allowed = thirdParty(child?.unsandboxed).filter(source => outside.includes(source));
		if (allowed.length) item.unsandboxed = allowed;
		await createItemActor(c, uid, itemId, {
			item,
			meta,
			placeNote: destination.wait,
			startedBy: input.start ? `person:${uid}` : null,
		});
		summary = await itemActor(c, uid, itemId).internalSummary();
	} catch (error) {
		// Nothing was made: the key is unused again, as a refused attempt leaves it. Once anything may exist, it stays this body's.
		if (submission && !begun) {
			c.vars.items.created.delete(scopedKey(!!intake, submission.key));
			await c.db
				.execute(
					intake ? "DELETE FROM github_item_keys WHERE key = ?" : "DELETE FROM item_keys WHERE key = ?",
					submission.key,
				)
				.catch(() => undefined);
		}
		throw clientError(c.log, error, "The item could not be filed. Try again.");
	}
	// In one step with the item: from here a creation with this key answers with it.
	c.vars.items.items.set(summary.id, summary);
	if (submission) c.vars.items.created.set(scopedKey(!!intake, submission.key), { ...submission, id: summary.id });
	const index = (db: Pick<RawAccess, "execute">) =>
		db.execute(
			"INSERT INTO items (id, created_at, summary, key, sent) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET summary = excluded.summary",
			summary.id,
			summary.createdAt,
			JSON.stringify(summary),
			submission?.key ?? null,
			submission?.sent ?? null,
		);
	if (intake && submission) {
		try {
			await c.db.transaction(async tx => {
				await index(tx);
				await tx.execute("DELETE FROM github_item_keys WHERE key=?", submission.key);
			});
		} catch (error) {
			c.vars.items.items.delete(summary.id);
			throw error;
		}
	} else await index(c.db);
	c.broadcast("items", feedOf(c.vars.items));
	console.log(`[wlp] item.created uid=${uid} item=${summary.id} session=${sessionId} source=${source}`);
	if (!summary.awaitingPlace && summary.place.kind === "machine" && !c.vars.machines.has(summary.place.machineId)) {
		await notifyRemovedMachines(c, summary.place.machineId);
		return itemView(c, summary.id);
	}
	return summary;
}

/** `createItem`, keyed or not, as `createSession` is: the same key answers with the item it made. */
async function fileItem(
	c: ItemsCtx,
	profile: UserProfile,
	raw: unknown,
	source: ItemSummary["source"],
	makeSession: MakeSession,
	intake?: Intake,
): Promise<ItemSummary> {
	if (typeof raw !== "object" || raw === null) throw new UserError("Say what the item is.", { code: "bad_input" });
	let attempt: Promise<ItemSummary>;
	try {
		const { idempotencyKey, ...asked } = raw as CreateItemInput;
		// Retrying a tracker reservation finishes the same generation even after the issue text changes.
		const [binding] = legacyBindings(intake ?? {});
		const identity = binding ? submissionIdentity(binding, asked, idempotencyKey) : asked;
		const submission = submissionOf(idempotencyKey, identity);
		if (submission === null) return await makeItem(c, profile, asked, source, null, makeSession);
		const key = scopedKey(!!intake, submission.key);
		const made = c.vars.items.created.get(key);
		const item = made && isRepeat(made, submission, KEYED) ? c.vars.items.items.get(made.id) : undefined;
		if (item) return item;
		attempt = c.vars.items.creating.run({ ...submission, key }, KEYED, () =>
			makeItem(c, profile, asked, source, submission, makeSession, intake),
		);
	} catch (error) {
		if (error instanceof SubmissionProblem) throw new UserError(error.message, { code: error.code });
		throw error;
	}
	return await attempt;
}

async function attachmentStates(c: ItemsCtx, view: ItemView): Promise<ItemView> {
	if (view.mode === "orchestrate") {
		view.children = [...c.vars.items.items.values()].filter(i => i.parent?.itemId === view.id);
	}
	const parts = view.children?.length ? await partScreenshots(c, view.children) : [];
	if (parts.length) view.partScreenshots = parts;
	const shots = [
		...(view.report?.screenshots ?? []),
		...view.reviews.flatMap(review => review.screenshots),
		...parts.flatMap(set => set.screenshots),
	];
	if (!shots.length) return view;
	const items = [view.id, ...new Set(parts.map(set => set.itemId))];
	const rows = await c.db.execute<{ id: string }>(
		`SELECT id FROM attachments WHERE item IN (${items.map(() => "?").join(",")}) AND state='kept' AND ended_at IS NOT 0`,
		...items,
	);
	const live = new Set(rows.map(row => row.id));
	for (const shot of shots) shot.state = live.has(shot.id) ? "kept" : "removed";
	return view;
}

/** The screenshot sets of a feature's parts, the newest first. A part that cannot be read now is left out of this answer. */
async function partScreenshots(c: ItemsCtx, children: ItemSummary[]): Promise<PartScreenshots[]> {
	const sets = await Promise.all(
		children.map(async child => {
			const filed = await itemActor(c, c.key[0] as string, child.id)
				.internalScreenshotSets()
				.catch(() => []);
			return filed.map(set => ({ itemId: child.id, key: child.parent?.key ?? "", title: child.title, ...set }));
		}),
	);
	return sets.flat().sort((a, b) => b.at - a.at);
}

async function itemView(c: ItemsCtx, id: string): Promise<ItemView> {
	const view = await itemActor(c, c.key[0] as string, id).internalView();
	await noteItem(c, view);
	return await attachmentStates(c, view);
}

// ---------------------------------------------------------------------------------------------
// The turn queue
// ---------------------------------------------------------------------------------------------

async function storeRequest(db: RawAccess, request: Request): Promise<void> {
	await db.execute(
		"INSERT OR REPLACE INTO turn_request (key, session, item, title, starts_run, at, attempt, full, full_until, wait) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		request.key,
		request.session,
		request.item,
		request.title,
		request.startsRun ? 1 : 0,
		request.at,
		request.attempt,
		request.full,
		request.deferUntil,
		request.wait === null ? null : JSON.stringify(request.wait),
	);
}

/** The factory's slots held now on hosted sandboxes, for `internalAcquireRun`: they count against the person's hosted ceiling too. A machine's never do. */
export function factorySlots(c: {
	vars: { items: ItemsState; sessions: ReadonlyMap<string, SessionSummary> };
}): number {
	let hosted = 0;
	for (const slot of c.vars.items.slots.values())
		if (hostedLimitsApply(c.vars.sessions.get(slot.session)?.place ?? { kind: "hosted" })) hosted++;
	return hosted;
}

type QueueSession = Pick<SessionSummary, "place" | "sandbox" | "status" | "item">;

function holdsHostedPlace(session: QueueSession): boolean {
	return (
		hostedLimitsApply(session.place) && (session.sandbox === "running" || (!session.item && session.status !== "idle"))
	);
}

/** Factory turns share the places left by personal sessions, including places already held by factory turns. */
export function plannerHostedCapacity(limits: UserLimits, sessions: Iterable<QueueSession>): number {
	let personal = 0;
	for (const session of sessions) if (!session.item && holdsHostedPlace(session)) personal++;
	const remaining = accountLimits(limits).factory.hostedRunning - personal;
	return Math.max(0, Math.min(RULES.parallelChildren, remaining));
}

function sessionProvider(
	session: SessionSummary,
	machine: MachineSummary | undefined | null,
	hosted: readonly HostedCredential[],
) {
	const model = session.model === "default" ? session.harnessModels?.defaultModel : session.model;
	if (!session.harness || session.harness === "windlass") return windlassProvider(model);
	if (session.place.kind === "hosted")
		return hostedProvider(session.harness, model, hostedProviders(session.harness, hosted));
	return selectedKey(
		session.harness,
		model,
		machine?.harnesses?.find(h => h.id === session.harness)?.platformKeys ?? [],
	);
}

/** The wait of a turn its plan holds back (Pay with), with what the item's banner offers; null when it may go on. */
function planHold(payer: PayerAnswer, context: PayerContext, attempt: number, now: number): Admission | null {
	if (!("wait" in payer.decision) || !payer.plan) return null;
	const { sentence, retryAt: reset, limited, keyNow } = payer.decision.wait;
	const generation = context.plans.get(payer.plan)?.generation;
	return {
		ok: false,
		wait: {
			reason: "provider",
			sentence,
			retryAt: reset ?? retryAt(now, attempt),
			...(generation && {
				accountKey: accountKey({ place: "hosted", harness: "claude", provider: payer.plan, plan: true }, generation),
			}),
			plan: { provider: payer.plan, limited, keyNow },
		},
	};
}

/**
 * Admits what can run now, oldest first, and gives each its slot; every other request gets the wait
 * that holds it. The counts and the grants are one synchronous step; what was decided is then
 * written, the sessions told of their slots (except `answering`, which is answered directly), the
 * items told of their waits, and the schedule set for the earliest wait. A grant whose session could
 * not be told is taken back and tried again later.
 */
async function runQueue(c: ItemsCtx, answering: string | null = null, retrying = false): Promise<Slot | null> {
	// Pay with is read only when a hosted turn of a plan agent waits here.
	const paying = [...c.vars.items.requests.values()].some(request => {
		const session = c.vars.sessions.get(request.session);
		return session !== undefined && paysWithRule(session, false, sessionModel(session));
	});
	const [accounts, hosted, payers] = await Promise.all([
		providerAccounts(c.db, Date.now()),
		hostedCredentials(c.db, c.key[0]!),
		paying ? payerContext(c) : null,
	]);
	const state = c.vars.items;
	const now = Date.now();
	const released: string[] = [];
	for (const slot of state.slots.values()) {
		if (slot.expiresAt > now) continue;
		state.slots.delete(slot.id);
		released.push(slot.id);
		// Asked for again: a turn whose slot outlived every turn's limit never started (its grant was lost with a server), and a
		// session that ended it answers a second grant by giving it back.
		if (!state.requests.has(slot.key))
			state.requests.set(slot.key, {
				key: slot.key,
				session: slot.session,
				item: slot.item,
				title: slot.title,
				startsRun: false,
				at: slot.at,
				attempt: 0,
				full: null,
				deferUntil: null,
				wait: null,
			});
		console.warn(
			`[wlp] factory.slot_expired uid=${c.key[0]} slot=${slot.id} key=${slot.key}: held past ${Math.round(SLOT_LEASE_MS / 60_000)} min without its turn's end being reported; given back and asked for again`,
		);
	}
	const limits = accountLimits(state.limits).factory;
	const tokenWait = dailyTokenWait(c.vars.usage.modelTokens(now), limits.dailyTokens);
	const sessions = [...c.vars.sessions.values()];
	const usage = c.vars.usage.numbers(now);
	// What holds the hosted places, in words, for an item told it waits for one (budget.ts `admit`).
	const holders = c.vars.usage
		.kept()
		.filter(claim => !c.vars.usage.shares(claim.session))
		.map(claim => keptHolder(c.vars.sessions, claim.session));
	// The user's hosted sandboxes at work: running ones, and the person's own agents working (`internalAcquireRun` counts those).
	const hostedRunning = new Set(sessions.filter(holdsHostedPlace).map(session => session.id));
	// A session given a slot runs a sandbox from then on, whether or not its summary has said so yet: counted across admissions, not only within one.
	for (const slot of state.slots.values()) {
		if (c.vars.sessions.get(slot.session)?.place.kind === "hosted") hostedRunning.add(slot.session);
	}
	const granted: Slot[] = [];
	const waits: Request[] = [];
	const capped: Request[] = [];
	const dropped: string[] = [];
	const removed: Request[] = [];
	for (const request of [...state.requests.values()].sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1))) {
		// The item may not be in the index yet: its first delivery can come before its creation has answered here.
		const session = c.vars.sessions.get(request.session);
		if (!session) {
			state.requests.delete(request.key);
			dropped.push(request.key);
			continue;
		}
		const machine = session.place.kind === "machine" ? c.vars.machines.get(session.place.machineId) : null;
		if (session.place.kind === "machine" && !machine) {
			// Keep the request until the item's durable withdrawal. Its creation can precede the index entry.
			removed.push(request);
			continue;
		}
		const placement = state.items.get(request.item)?.placement;
		const capacity = machine && placement ? machineSlots(machine) : null;
		// Pay with (user-payer.ts): a hosted turn of a plan agent waits for its plan's reset or room under its cap, and
		// counts against the limits of what pays for it, the plan's or the key's.
		const model = sessionModel(session);
		const payer = payers && paysWithRule(session, false, model) ? payerOf(c, payers, session, model) : null;
		const answer: Admission =
			(payer && payers && planHold(payer, payers, request.attempt, now)) ||
			admit({
				provider: accountFor(accounts, {
					place: placeKey(session.place),
					harness: session.harness ?? "windlass",
					provider: payer?.ref?.provider ?? sessionProvider(session, machine, hosted),
					...(payer?.ref?.plan && { plan: true as const }),
				}),
				at: now,
				limits,
				dailyTokenWait: usesPlatformModel(session.harness, session.model) ? tokenWait : null,
				// The session's own sandbox, running already, is not one more for its turn.
				place: machine
					? {
							kind: "machine",
							name: machineLabel(machine),
							online: machine.status === "online",
							...(capacity &&
								capacity.max !== null &&
								placement && { slots: { free: Math.max(0, capacity.max - capacity.busy), units: placement.units } }),
							attachRetryAt: machine.since <= request.at ? request.deferUntil : null,
							running: machine.sandboxes.filter(box => box.state === "running" && box.sessionId !== session.id).length,
							max: machine.maxRunning ?? Infinity,
							keptFull: keptFull(c, session),
						}
					: {
							kind: "hosted",
							usage,
							running: hostedRunning.size - (hostedRunning.has(session.id) ? 1 : 0),
							needsSandbox:
								session.sandbox === "none" && !c.vars.usage.keeps(session.id) && !c.vars.usage.shares(session.id),
							holders,
							deploymentFull: (request.deferUntil ?? 0) > now ? request.full : null,
						},
				attempt: request.attempt,
			});
		if (answer.ok) {
			// The one asking now is told in its answer; any other is told below, and until it answers the grant stays recorded.
			const slot: Slot = {
				id: `t_${randomBytes(8).toString("hex")}`,
				key: request.key,
				session: request.session,
				item: request.item,
				title: request.title,
				at: now,
				expiresAt: now + SLOT_LEASE_MS,
				told: request.key === answering,
			};
			state.requests.delete(request.key);
			state.slots.set(slot.id, slot);
			granted.push(slot);
			// Its plan's place under the cap is taken with the slot: the next request in this pass counts it.
			if (payer?.ref?.plan && payer.plan && payer.capped) holdPlanTurn(c, payer.plan, session.id, now);
			if (hostedLimitsApply(session.place)) hostedRunning.add(session.id);
			continue;
		}
		if (answer.keptCap) capped.push(request);
		const before = request.wait;
		// A try that was due counts as one more wait: the next one is further off.
		if (retrying && before !== null && before.retryAt !== null && before.retryAt <= now) request.attempt += 1;
		request.wait = answer.wait;
		if (before?.sentence !== answer.wait.sentence || before?.retryAt !== answer.wait.retryAt) waits.push(request);
	}

	for (const id of released) {
		await c.db.execute("DELETE FROM turn_slot WHERE id = ?", id);
		await c.db.execute("DELETE FROM turn_grant WHERE slot = ?", id);
	}
	for (const key of dropped) await c.db.execute("DELETE FROM turn_request WHERE key = ?", key);
	for (const slot of granted) {
		// The request becomes its slot in one transaction: a server stopped in between leaves one or the other, never neither.
		await c.db.transaction(
			async tx => {
				await tx.execute("DELETE FROM turn_request WHERE key = ?", slot.key);
				await tx.execute(
					"INSERT OR REPLACE INTO turn_slot (id, key, session, item, title, at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					slot.id,
					slot.key,
					slot.session,
					slot.item,
					slot.title,
					slot.at,
					slot.expiresAt,
				);
				if (!slot.told) await tx.execute("INSERT OR IGNORE INTO turn_grant (slot) VALUES (?)", slot.id);
			},
			{ name: "queue.grant" },
		);
		console.log(
			`[wlp] factory.slot_granted uid=${c.key[0]} slot=${slot.id} key=${slot.key} factory=${state.slots.size}`,
		);
	}
	for (const request of waits) await storeRequest(c.db, request);

	const uid = c.key[0] as string;
	const mine = granted.find(slot => slot.key === answering) ?? null;
	// Every slot its session has not answered for: the ones granted now, and any whose grant was lost before.
	for (const slot of [...state.slots.values()].filter(one => !one.told)) {
		try {
			await sessionActor(c, uid, slot.session).internalGrant({ key: slot.key, slot: slot.id });
			slot.told = true;
			await c.db.execute("DELETE FROM turn_grant WHERE slot = ?", slot.id);
		} catch (error) {
			if (!isSessionGone(error)) {
				// Kept, slot and all: the session may have taken it and only its answer was lost. Told again on the next run, or freed by its lease.
				c.log.warn({
					msg: "could not give a session its slot; it is told again later",
					session: slot.session,
					error: String(error),
				});
				continue;
			}
			state.slots.delete(slot.id);
			await c.db.execute("DELETE FROM turn_slot WHERE id = ?", slot.id);
			await c.db.execute("DELETE FROM turn_grant WHERE slot = ?", slot.id);
		}
	}
	for (const request of removed) {
		await itemActor(c, uid, request.item).internalFact({ kind: "machine_removed", at: now });
		state.requests.delete(request.key);
		await c.db.execute("DELETE FROM turn_request WHERE key = ?", request.key);
	}
	let room = false;
	for (const request of capped) {
		const session = c.vars.sessions.get(request.session);
		if (state.requests.get(request.key) !== request || !session) continue;
		if (await makeSandboxRoom(c, session)) {
			request.wait = null;
			room = true;
			break;
		}
	}
	for (const request of waits) {
		if (request.wait === null || state.requests.get(request.key) !== request) continue;
		const fact = { kind: "turn_waiting" as const, at: now, key: request.key, wait: request.wait };
		await itemActor(c, uid, request.item)
			.internalFact(fact)
			.catch((error: unknown) =>
				c.log.warn({ msg: "could not tell an item why its turn waits", item: request.item, error: String(error) }),
			);
	}
	if (room) {
		const retry = await runQueue(c, answering);
		return mine ?? retry ?? [...state.slots.values()].find(slot => slot.key === answering) ?? null;
	}
	await armQueue(c);
	return mine;
}

/** One schedule, at the earliest time a waiting request is to be tried again. */
function armQueue(c: ItemsCtx): Promise<void> {
	const state = c.vars.items;
	const work = (state.arming ?? Promise.resolve()).then(() => scheduleQueue(c));
	state.arming = work.catch(() => {});
	return work;
}

async function scheduleQueue(c: ItemsCtx): Promise<void> {
	const state = c.vars.items;
	const times = [...state.requests.values()]
		.map(request => request.wait?.retryAt ?? null)
		.filter((at): at is number => at !== null);
	const due = nextSandboxRelease(c);
	if (Number.isFinite(due)) times.push(due);
	if (times.length === 0) return;
	const at = Math.max(Date.now(), Math.min(...times));
	if (state.queueAt !== null && state.queueAt.at <= at && state.queueAt.at > Date.now()) return;
	const before = state.queueAt;
	const id = await c.schedule.at(at, QUEUE_ACTION);
	state.queueAt = { id, at };
	await c.db.execute("INSERT OR REPLACE INTO turn_queue (id, schedule, at) VALUES (1, ?, ?)", id, at);
	if (before !== null) await c.schedule.cancel(before.id).catch(() => false);
}

/** Recheck persisted timers on adoption. A late summary or an actor restart can also reveal a wait on an older login. */
export async function notifyProviderWaits(
	c: ItemsCtx,
	items: Iterable<ItemSummary>,
	change: "login" | "settings" | "adopted" = "login",
) {
	const settingsChanged = change === "settings";
	const waits = [...items].filter(
		item =>
			(settingsChanged && item.state === "waiting" && item.step?.kind === "subtasks") ||
			(item.wait?.reason === "provider" && (change !== "login" || item.wait.accountKey)),
	);
	if (!waits.length) return;
	const [accounts, hosted] = await Promise.all([
		providerAccounts(c.db, Date.now()),
		hostedCredentials(c.db, c.key[0]!),
	]);
	const active = new Set(limitedAccounts(accounts).map(a => a.accountKey));
	for (const item of waits) {
		// A placement wait belongs to the prospective child, which can use a different connection from its parent.
		if (item.step?.kind === "subtasks") {
			if (!settingsChanged && item.wait?.accountKey && active.has(item.wait.accountKey)) continue;
		} else {
			const session = c.vars.sessions.get(item.sessionId);
			if (!session) continue;
			const machine = session.place.kind === "machine" ? c.vars.machines.get(session.place.machineId) : undefined;
			const harness = session.harness ?? "windlass";
			const provider = sessionProvider(session, machine, hosted);
			const location = { place: placeKey(session.place), harness, provider };
			const generation = await loginGeneration(c.db, location);
			if (generation === null ? !settingsChanged : item.wait!.accountKey === accountKey(location, generation)) continue;
		}
		await itemActor(c, c.key[0]!, item.id)
			.internalProviderChanged(item.revision)
			.catch(error =>
				c.log.warn({ msg: "Could not advance the item's provider retry", item: item.id, error: String(error) }),
			);
	}
}

/** Removal also reaches drafts and work waiting on GitHub. Repeat on wake in case a notification was cut off. */
export async function notifyRemovedMachines(c: ItemsCtx, machineId?: string): Promise<void> {
	for (const item of c.vars.items.items.values()) {
		if (
			item.awaitingPlace ||
			item.place.kind !== "machine" ||
			(machineId && item.place.machineId !== machineId) ||
			c.vars.machines.has(item.place.machineId)
		)
			continue;
		if (["done", "failed", "cancelled"].includes(item.state) || item.question?.kind === "machine_removed") continue;
		await itemActor(c, c.key[0]!, item.id).internalFact({ kind: "machine_removed", at: Date.now() });
	}
}

/** Something that frees capacity happened (a person's session went idle), or the actor woke: the waiting requests are tried, and the schedule armed again. Never throws. */
export function queueChanged(c: ItemsCtx): void {
	const { requests, slots } = c.vars.items;
	if (requests.size === 0 && [...slots.values()].every(slot => slot.told)) {
		if (!Number.isFinite(nextSandboxRelease(c))) return;
		void c.keepAwake(
			armQueue(c).catch(error => c.log.warn({ msg: "Could not schedule sandbox expiry", error: String(error) })),
		);
		return;
	}
	void c.keepAwake(
		runQueue(c).catch(error => c.log.error({ msg: "the turn queue could not be run", error: String(error) })),
	);
}

/**
 * Why a session may not be deleted, when it is a work item's: the item owns it, and its steps would
 * find it gone. The item is cancelled instead, which leaves the agent and its timeline to be read.
 */
export function itemSessionRefusal(c: { vars: { items: ItemsState } }, session: SessionSummary): UserError | null {
	if (!session.item) return null;
	const item = c.vars.items.items.get(session.item.id);
	const name = item ? `“${item.title}”` : "a work item";
	return new UserError(
		`This agent works for ${name}. Cancel the item instead; the agent and what it did stay readable.`,
		{ code: "item_session" },
	);
}

// ---------------------------------------------------------------------------------------------
// API tokens
// ---------------------------------------------------------------------------------------------

function tokenInput<T>(step: () => Promise<T>): Promise<T> {
	return step().catch(error => {
		if (error instanceof ApiTokenProblem) throw new UserError(error.message, { code: error.code });
		throw error;
	});
}

/** The profile of the user an API token names, when the token is good for `scope` here. */
async function apiCaller(
	c: ItemsCtx,
	token: unknown,
	scope: ApiTokenScope,
	distinguishScope = false,
): Promise<UserProfile> {
	const owner = tokenOwner(token);
	const profile = c.vars.profile;
	const refused = new UserError("That API token is not valid, or may not do this.", { code: "invalid_token" });
	// The access rules hold for a token as for a sign-in: someone taken off the list, or a demo user once the demo is off, is locked out at once.
	if (!owner || owner.uid !== c.key[0] || !profile || !mayUse(profile, config.access)) throw refused;
	const now = Date.now();
	const admission = await useApiToken(c.db, owner.digest, scope, now, config.httpLimits.apiToken);
	if (admission === "invalid") {
		if (distinguishScope && (await c.db.execute("SELECT 1 FROM api_token WHERE digest=?", owner.digest)).length)
			throw new UserError("Use a token with items:read to read a screenshot.", { code: "missing_scope" });
		throw refused;
	}
	if (admission === "limited") {
		const retryAfter = Math.ceil((API_TOKEN_WINDOW_MS - (now % API_TOKEN_WINDOW_MS)) / 1000);
		throw new UserError("This API token has reached its request limit. Try again next minute.", {
			code: "token_rate_limited",
			metadata: { retryAfter },
		});
	}
	return profile;
}

// ---------------------------------------------------------------------------------------------
// The actions
// ---------------------------------------------------------------------------------------------

/** The switch for work items (WLP_ITEMS), read by each of the person's actions on items and API tokens as the machines' are. */
function enabled(): void {
	if (!config.items) throw new UserError("Work items are not available on this platform.", { code: "items_off" });
}

const ended = (item: ItemSummary) => ["done", "cancelled", "failed"].includes(item.state);

// Calls can interleave at any await. Keep quota decisions, the single alarm and object deletion ordered per user.
const writes = new WeakMap<ItemsState, Promise<unknown>>();
function attachmentWrite<T>(c: ItemsCtx, work: () => Promise<T>): Promise<T> {
	const next = (writes.get(c.vars.items) ?? Promise.resolve()).then(work);
	writes.set(
		c.vars.items,
		next.catch(() => {}),
	);
	return next;
}

async function armSweep(c: ItemsCtx, now: number) {
	const [old] = await c.db.execute<{ schedule: string; at: number }>(
		"SELECT schedule, at FROM attachment_sweep WHERE id=1",
	);
	if (old && old.at > now && old.schedule !== c.scheduledFire?.id) return;
	const at = now + DAY;
	const id = await c.schedule.at(at, ATTACHMENT_SWEEP_ACTION);
	await c.db.execute("INSERT OR REPLACE INTO attachment_sweep VALUES(1,?,?)", id, at);
	if (old && old.schedule !== c.scheduledFire?.id) await c.schedule.cancel(old.schedule).catch(() => false);
}

async function reserveAttachment(c: ItemsCtx, input: Reservation): Promise<ReserveResult> {
	const { sessionId, itemId, key, sha256, bytes } = input;
	const item = c.vars.items.items.get(itemId);
	if (!item || ended(item) || c.vars.sessions.get(sessionId)?.item?.id !== itemId || !key.startsWith(itemId + ":"))
		return { refused: "item_ended" };
	const limits = accountLimits(c.vars.items.limits).factory.attachments;
	if (!Number.isSafeInteger(bytes) || bytes <= 0 || !/^[a-f0-9]{64}$/.test(sha256))
		throw new Error("Invalid screenshot size or digest.");
	if (bytes > limits.bytes) return { refused: "too_large" };
	await armSweep(c, Date.now());
	return c.db.transaction(
		async tx => {
			// Reuse active reservations and kept images. A discarded key belongs to its final sweep.
			const [same] = await tx.execute<{
				id: string;
				key: string;
				at: number;
				bytes: number;
				width: number;
				height: number;
			}>(
				"SELECT id,key,at,bytes,width,height FROM attachments WHERE item=? AND step_key=? AND sha256=? AND state IN ('reserved','kept') AND ended_at IS NOT 0 LIMIT 1",
				itemId,
				key,
				sha256,
			);
			if (!c.vars.items.items.has(itemId) || ended(c.vars.items.items.get(itemId)!))
				return { refused: "item_ended" } as const;
			if (same) {
				if (same.bytes !== bytes) throw new Error("The file size differs from its recorded digest.");
				// Retrying an unfinished upload can issue a fresh link even if the first reservation is old.
				const at = same.width ? same.at : Date.now();
				if (!same.width) await tx.execute("UPDATE attachments SET at=? WHERE id=?", at, same.id);
				return { id: same.id, key: same.key, at, width: same.width, height: same.height };
			}
			const [usage] = await tx.execute<{ count: number; total: number }>(
				"SELECT COUNT(CASE WHEN item=? AND state!='discarded' THEN 1 END) AS count, COALESCE(SUM(bytes),0) AS total FROM attachments WHERE state!='removed'",
				itemId,
			);
			if (usage.count >= limits.perItem) return { refused: "item" } as const;
			if (usage.total + bytes > limits.accountBytes) return { refused: "account" } as const;
			const id = "a_" + randomBytes(8).toString("hex");
			const objectKey = attachmentKey(backupConfig().prefix, c.key[0], itemId, id);
			const at = Date.now();
			await tx.execute(
				"INSERT INTO attachments VALUES(?,?,?,?,?,?,?,0,0,'reserved',?,NULL)",
				id,
				itemId,
				sessionId,
				key,
				sha256,
				objectKey,
				bytes,
				at,
			);
			return { id, key: objectKey, at, width: 0, height: 0 };
		},
		{ name: "attachments.reserve" },
	);
}

async function removeRows(c: ItemsCtx, rows: Array<{ id: string; key: string }>, final: boolean) {
	const store = attachmentStore();
	if (!store) return;
	for (const row of rows) {
		try {
			await store.remove(row.key);
			if (final) await c.db.execute("UPDATE attachments SET state='removed' WHERE id=?", row.id);
		} catch {
			c.log.warn({ msg: "A screenshot could not be removed. The daily sweep will retry." });
		}
	}
}

async function links(c: ItemsCtx, item: string, ttlMs: number, only?: string) {
	knownItem(c, item);
	const store = attachmentStore();
	if (!store) return [];
	const rows = await c.db.execute<{ id: string; key: string }>(
		"SELECT id,key FROM attachments WHERE item=? AND state='kept' AND ended_at IS NOT 0 AND (? IS NULL OR id=?)",
		item,
		only ?? null,
		only ?? null,
	);
	return Promise.all(
		rows.map(async row => ({
			id: row.id,
			...(await store.linkToGet(row.key, { ttlMs, contentType: "image/png", disposition: "inline" })),
		})),
	);
}

export function accountTokenWait(c: Pick<ItemsCtx, "vars">): string | null {
	const used = c.vars.usage.modelTokens(Date.now());
	return dailyTokenWait(used, accountLimits(c.vars.items.limits).factory.dailyTokens);
}

async function partDefaults(c: ItemsCtx, repositories: Record<string, GithubId>) {
	const [account, entries] = await Promise.all([
		readAccountDefaults(c.db),
		Promise.all(
			Object.entries(repositories).map(
				async ([alias, id]) => [alias, await readDefaults(c.db, "github:" + id)] as const,
			),
		),
	]);
	const saved = Object.fromEntries(entries);
	return { account, repository: saved[""], repositories: saved };
}

export async function placementInventory(
	c: ItemsCtx,
	models: () => Promise<AgentModels>,
	repositories: Record<string, GithubId>,
	snapshotRepository?: GithubId,
): Promise<PlacementInventory> {
	const { sandboxes } = await getLayer();
	const profiles = sandboxes.profiles().filter(p => p.available);
	const machines = plannerMachines([...c.vars.machines.values()]);
	const personal = [...c.vars.sessions.values()].filter(s => !s.item && s.status !== "idle");
	for (const m of machines)
		m.personalRunning = personal.filter(s => s.place.kind === "machine" && s.place.machineId === m.machineId).length;
	const [catalogs, hosted, accounts, defaults, fresh] = await Promise.all([
		models(),
		hostedCredentials(c.db, c.key[0]!),
		providerAccounts(c.db, Date.now()),
		partDefaults(c, repositories),
		snapshotRepository === undefined
			? []
			: snapshotPlaces(
					c.db,
					setupProjectKey(snapshotRepository) ?? "",
					c.vars.github?.connectedAt,
					config.hosted?.snapshots?.ttlMs,
				).catch(() => []),
	]);
	const sizes = hostedSizesForPlan(sandboxes.sizes?.() ?? [], accountLimits(c.vars.items.limits).plan);
	return {
		defaults,
		machines,
		models: catalogs,
		hostedCredentials: hosted,
		limited: limitedAccounts(accounts),
		dailyTokenWait: accountTokenWait(c),
		snapshotPlaces: fresh,
		screenshotsEnabled: config.factory.screenshots,
		screenshotStorage: !!attachmentStore(),
		repositoryScreenshots: Object.fromEntries(
			Object.entries(defaults.repositories).map(([alias, r]) => [alias, r.screenshots]),
		),
		hostedSizes: sizes.map(size => size.id),
		hostedRates: Object.fromEntries(sizes.map(size => [size.id, size.usdPerHour])),
		hostedProfiles: profiles.map(p => p.id),
		keyProfiles: profiles.filter(p => p.platformKeys).map(p => p.id),
		hostedEgress: sandboxes.egress?.(),
	};
}

async function childLaunch(
	c: ItemsCtx,
	id: string,
	context: RunContext,
	task: PlanSubtask,
	route: PlacementRoute,
	warm: string[],
	defaultProfile: SandboxProfileId,
	featureModel: string,
	agentModels: () => Promise<AgentModels>,
	repositoryId: GithubId,
): Promise<ReturnType<typeof choosePlacement>> {
	const [row] = await c.db.execute<{ placement: string }>("SELECT placement FROM child_launch WHERE id=?", id);
	const pinned: ChildPlacement | undefined = row && JSON.parse(row.placement);
	const inventory = await placementInventory(c, agentModels, { [task.repo ?? ""]: repositoryId }, repositoryId);
	inventory.defaults = context;
	inventory.defaultProfile = pinned?.profile ?? defaultProfile;
	inventory.featureModel = featureModel;
	const selected = choosePlacement(
		task,
		pinned ? { preferred: pinned.place, alternatives: [], names: { [placeKey(pinned.place)]: pinned.name } } : route,
		inventory,
		warm,
	);
	if (!selected.decision) return selected;
	if (pinned) {
		if (pinned.units !== selected.decision.units || pinned.profile !== selected.decision.profile)
			return {
				refused: "The original sandbox size or profile is no longer available on ‘" + pinned.name + "’.",
				permanent: true,
				larger: undefined,
			};
		return { decision: pinned };
	}
	await c.db.execute("INSERT INTO child_launch VALUES (?,?)", id, JSON.stringify(selected.decision));
	return selected;
}

/** The refusals of a child's creation that no retry cures until the person changes the plan or the machine. */
const CHILD_REFUSALS = new Set([
	"bad_input",
	"bad_model",
	"bad_effort",
	"bad_profile",
	"profile_unavailable",
	"machine_not_connected",
	"runner_outdated",
	"runner_signing_disabled",
	"harness_signed_out",
]);

export const itemActions = {
	async internalDefaultBuilder(
		c: ItemsCtx,
		input: { id: string; job: DefaultBuilder },
		makeSession: MakeSession,
	): Promise<
		| { wait: string; reviewer?: boolean }
		| {
				session: SessionSummary;
				reviewer: NonNullable<import("../factory/types.js").FactoryItem["reviewer"]>;
				reviewerSessionId: string | null;
		  }
		| null
	> {
		requireServiceFor(c, "call");
		return attachmentWrite(c, async () => {
			const owner = c.vars.profile;
			if (!owner) throw new Error("The item owner is unavailable.");
			const item = await itemActor(c, owner.uid, input.id).internalSummary();
			if (!item.awaitingPlace || item.state !== "waiting") return null;
			const run = resolveRun(input.job.context, input.job.role);
			const { session, destination } = await defaultBuilder(c, owner, input.id, input.job, run, makeSession, "retry");
			if (!session) return { wait: destination.wait! };
			const review = await bindReviewer(c, owner, session, input.id, false, input.job, makeSession);
			return review.wait
				? { wait: review.wait, reviewer: true }
				: { session, reviewerSessionId: review.reviewerSessionId, reviewer: review.reviewer! };
		});
	},
	async internalDiscardPlacement(c: ItemsCtx, itemId: string, remove: (id: string) => Promise<void>) {
		requireServiceFor(c, "call");
		// Order cancellation after any builder or reviewer creation already in flight.
		await attachmentWrite(c, async () => {
			for (const session of c.vars.sessions.values()) {
				if (session.item?.id === itemId) await remove(session.id);
			}
		});
	},
	async internalFeatureChild(
		c: ItemsCtx,
		input: { parent: string; child: string; cancel?: boolean },
		makeSession: MakeSession,
		agentModels: () => Promise<AgentModels>,
	): Promise<ItemView | null> {
		requireServiceFor(c, "call");
		const uid = c.key[0]!;
		// Share an ordering boundary with cancellation so an interrupted creation can never outlive its parent.
		return attachmentWrite(c, async () => {
			const owner = c.vars.profile;
			if (!owner) throw new Error("The feature owner is unavailable.");
			const parentActor = itemActor(c, uid, input.parent);
			const request = await parentActor.internalChildRequest(input.child);
			let existing = c.vars.items.items.get(input.child);
			if ((!request || request.paused) && !existing) return null;
			if (!existing && request) {
				if ((input.cancel || request.job.cancelRequested) && !c.vars.sessions.has(itemSessionId(input.child)))
					return null;
				const session = c.vars.sessions.get(request.sessionId);
				if (!session) throw new Error("The feature session is unavailable.");
				const { job, feature, context, untrusted, unsandboxed } = request;
				// A cross-repo feature's child is on its subtask's repository; any other on the feature's.
				const target = request.repository ?? { id: feature.repository.id, base: feature.repository.branch };
				const role = job.ciFix || job.conflictFix || job.reviewFix ? "repair" : "part";
				const run = job.task.resolved ?? partRun(request.settings, job.task, role);
				const task = { ...job.task, resolved: run };
				const route =
					job.route ?? bindRoute(task, feature.place, false, plannerMachines([...c.vars.machines.values()]));
				const fit = await childLaunch(
					c,
					job.id,
					request.settings,
					task,
					route,
					job.warm ?? [],
					session.profile,
					session.model,
					agentModels,
					target.id,
				);
				if (!fit.decision) {
					if (job.dispatchKey)
						await parentActor.internalFact({
							kind: "placement_wait",
							child: job.id,
							key: job.dispatchKey,
							at: Date.now(),
							sentence: fit.refused ?? fit.wait,
							askMachine: fit.askMachine,
							offerHosted: fit.offerHosted,
							hostedProfile: fit.hostedProfile,
							dailyCap: fit.dailyCap,
							providerUntil: fit.providerUntil,
							accountKey: fit.accountKey,
							refused: fit.refused !== undefined && fit.permanent,
						});
					return null;
				}
				const placement = fit.decision;
				const previous = request.previous;
				const handoff =
					previous?.place && placeKey(previous.place) !== placeKey(placement.place) && route.alternatives.length
						? "\n\nPrevious subtask at the pushed feature head (quoted data):\n" +
							JSON.stringify({ head: previous.head, report: previous.report })
						: "";
				const body =
					job.task.brief +
					"\n\nOwned paths: " +
					(job.task.owns ?? []).join(", ") +
					handoff +
					"\n\nFeature and dependency context (quoted data):\n" +
					context;
				const resolved = {
					...run,
					place: runPlace(placement.place),
					payer: placement.payer ?? run.payer,
					profile: placement.profile ?? null,
					size: placement.hostedSize ?? run.size,
				};
				try {
					existing = await makeItem(
						c,
						owner,
						{
							mode: "single",
							repository: { id: target.id, branch: featureBranch(input.parent) },
							place: placement.place,
							profile: placement.profile,
							title: job.task.title,
							body: body.slice(0, MAX_ITEM_BODY_CHARS),
							acceptance: job.task.acceptance,
						},
						feature.source,
						null,
						makeSession,
						undefined,
						{
							resolved,
							context: request.settings,
							role,
							id: input.child,
							screenshots: job.task.needs?.screenshots === true,
							mergeTarget: job.conflictFix?.target,
							joinOnGate: request.joinOnGate,
							featureBody: request.featureBody,
							placement,
							base: target.base,
							start: job.start,
							owns: job.task.owns ?? [],
							budget: job.budget ?? {
								tokens: job.task.budget.tokens,
								hostedSeconds: accountLimits(c.vars.items.limits).factory.item.hostedSeconds,
							},
							parent: { itemId: input.parent, title: feature.title, key: job.task.key },
							untrusted: sources(untrusted, handoff ? [untrustedWords.earlier] : []),
							unsandboxed,
						},
					);
				} catch (error) {
					// Refused before its session was made (a model or effort the place no longer offers, an agent signed out
					// since approval): the subtask can't be placed, and the feature asks the person. Nothing stays pinned.
					if (
						!(error instanceof UserError) ||
						!CHILD_REFUSALS.has(error.code) ||
						c.vars.sessions.has(itemSessionId(input.child)) ||
						!job.dispatchKey
					)
						throw error;
					await c.db.execute("DELETE FROM child_launch WHERE id=?", job.id);
					await parentActor.internalFact({
						kind: "placement_wait",
						child: job.id,
						key: job.dispatchKey,
						at: Date.now(),
						sentence: `‘${placement.name}’: ${error.message}`,
						refused: true,
					});
					return null;
				}
			}
			if (!existing || existing.parent?.itemId !== input.parent) return null;
			const actor = itemActor(c, uid, existing.id);
			const view = await actor.internalView();
			const active = await parentActor.internalChildRequest(input.child);
			if (input.cancel || !active || active.job.cancelRequested) {
				if (!ended(view)) return actor.internalAct({ action: { kind: "cancel" }, by: "platform" });
			} else if (!active.paused && view.state === "draft")
				return actor.internalAct({ action: { kind: "start" }, by: "platform" });
			return view;
		});
	},
	internalGitlabIntake(c: ItemsCtx, trigger: GitlabTrigger, makeSession: MakeSession) {
		requireServiceFor(c, "call");
		return inIntakeQueue(c, () =>
			fileGitlabIssue(c, trigger, (profile, input, gitlab) =>
				fileItem(c, profile, input, "gitlab", makeSession, { gitlab }),
			),
		);
	},
	internalGithubIntake(c: ItemsCtx, trigger: IntakeTrigger, makeSession: MakeSession) {
		requireServiceFor(c, "call");
		// All trackers share this user's budget: one queue. The durable claim makes interruption replayable.
		return inIntakeQueue(c, () =>
			githubIntake(
				c,
				trigger,
				key => githubItemId(c.key[0]!, key),
				(profile, filing) => fileItem(c, profile, filing.input, "github", makeSession, { github: filing.binding }),
			),
		);
	},
	internalTrackerIntake(
		c: ItemsCtx,
		filing: LinearFiling | SiteJiraFiling,
		makeSession: MakeSession,
	): Promise<TrackerFiled> {
		requireServiceFor(c, "call");
		return inIntakeQueue(c, () =>
			fileTrackerIssue(c, filing, githubItemId, (profile, input, source, intake) =>
				fileItem(c, profile, input, source, makeSession, intake),
			),
		);
	},
	internalSlackIntake(c: ItemsCtx, filing: SlackFiling, makeSession: MakeSession) {
		requireServiceFor(c, "call");
		return inIntakeQueue(c, () =>
			fileSlackRequest(c, filing, (profile, made) =>
				fileItem(c, profile, made.input, "slack", makeSession, { slack: made.binding }),
			),
		);
	},
	internalReserveAttachment(c: ItemsCtx, input: Reservation) {
		requireService(c);
		return attachmentWrite(c, () => reserveAttachment(c, input));
	},
	async internalRecordAttachment(c: ItemsCtx, input: { id: string; width: number; height: number }) {
		requireService(c);
		await attachmentWrite(c, async () => {
			const rows = await c.db.execute(
				"UPDATE attachments SET width=?,height=? WHERE id=? AND state='reserved' AND ended_at IS NOT 0 RETURNING id",
				input.width,
				input.height,
				input.id,
			);
			if (!rows.length) throw new Error("The screenshot reservation ended.");
		});
	},
	async internalReleaseAttachment(c: ItemsCtx, id: string) {
		requireService(c);
		await attachmentWrite(c, async () => {
			const rows = await c.db.execute<{ id: string; key: string }>(
				"UPDATE attachments SET state='discarded', at=? WHERE id=? AND state='reserved' RETURNING id,key",
				Date.now(),
				id,
			);
			await removeRows(c, rows, false);
		});
	},
	internalSettleAttachments(c: ItemsCtx, input: { sessionId: string; key: string; keep: string[] }) {
		requireService(c);
		return attachmentWrite(c, () =>
			c.db.transaction(
				async tx => {
					for (const id of new Set(input.keep))
						await tx.execute(
							"UPDATE attachments SET state='kept' WHERE session=? AND step_key=? AND id=? AND width>0 AND state='reserved' AND ended_at IS NOT 0",
							input.sessionId,
							input.key,
							id,
						);
					return tx.execute<{ id: string; key: string }>(
						"SELECT id,key FROM attachments WHERE session=? AND step_key=? AND state='reserved'",
						input.sessionId,
						input.key,
					);
				},
				{ name: "attachments.settle" },
			),
		);
	},
	internalDeleteItemAttachments(c: ItemsCtx, itemId: string) {
		requireService(c);
		return attachmentWrite(c, async () => {
			const rows = await c.db.transaction(
				async tx => {
					await tx.execute("DELETE FROM items WHERE id=?", itemId);
					return tx.execute<{ id: string; key: string }>(
						"UPDATE attachments SET ended_at=0, state='discarded', at=? WHERE item=? AND state IN ('reserved','kept') RETURNING id,key",
						Date.now(),
						itemId,
					);
				},
				{ name: "attachments.deleteItem" },
			);
			c.vars.items.items.delete(itemId);
			await removeRows(c, rows, false);
		});
	},
	internalAttachmentSweep(c: ItemsCtx) {
		const fire = c.scheduledFire;
		if (!fire) throw new UserError("This action is internal.", { code: "forbidden" });
		return attachmentWrite(c, async () => {
			const [alarm] = await c.db.execute<{ schedule: string }>("SELECT schedule FROM attachment_sweep WHERE id=1");
			if (alarm?.schedule !== fire.id) return;
			await armSweep(c, fire.firedAt);
			const rows = await c.db.execute<{ id: string; key: string }>(
				"SELECT id,key FROM attachments WHERE state!='removed' AND at<=? AND (state='discarded' OR ended_at=0 OR (state='reserved' AND at<?) OR (state='kept' AND ended_at<?))",
				fire.firedAt - ATTACHMENT_DRAIN_MS,
				fire.firedAt - 2 * 3600_000,
				fire.firedAt - accountLimits(c.vars.items.limits).factory.attachments.days * DAY,
			);
			await removeRows(c, rows, true);
		});
	},
	itemAttachmentLinks(c: ItemsCtx, id: string) {
		requireUser(c);
		enabled();
		return links(c, id, 600_000);
	},
	async internalApiItemAttachment(c: ItemsCtx, input: { token: string; id: string; attachment: string }) {
		requireServiceFor(c, "api");
		await apiCaller(c, input.token, "items:read", true);
		const [link] = c.vars.items.items.has(input.id) ? await links(c, input.id, 60_000, input.attachment) : [];
		if (!link) throw new UserError("That item or attachment does not exist.", { code: "item_not_found" });
		return link.url;
	},
	listItems: (c: ItemsCtx, page?: unknown): ItemSummary[] => {
		requireUser(c);
		enabled();
		// Without a page, the whole list, for API clients and scripts (the web app reads `itemFeed`); with one, a page of it (item-pages.ts).
		let clean: CleanPage | null;
		try {
			clean = cleanItemPage(page);
		} catch (error) {
			if (error instanceof ItemPageProblem) throw new UserError(error.message, { code: "bad_input" });
			throw error;
		}
		const list = itemList(c.vars.items);
		return clean === null ? list : itemPage(list, clean);
	},
	itemFeed: (c: ItemsCtx): ItemFeed => {
		requireUser(c);
		enabled();
		return feedOf(c.vars.items);
	},
	finishedItems: (c: ItemsCtx, days: unknown): FinishedItems => {
		requireUser(c);
		enabled();
		if (!SUMMARY_DAYS.includes(days as SummaryDays))
			throw new UserError("Choose 7, 30 or 90 days.", { code: "bad_input" });
		const since = Date.now() - (days as SummaryDays) * 86_400_000;
		return { days: days as SummaryDays, since, items: finishedItems(c.vars.items.items.values(), since) };
	},

	item: async (c: ItemsCtx, id: string): Promise<ItemView> => {
		requireUser(c);
		enabled();
		knownItem(c, id);
		try {
			return await itemView(c, id);
		} catch (error) {
			throw clientError(c.log, error, "The item could not be read. Try again.");
		}
	},

	createItem: async (c: ItemsCtx, input: CreateItemInput, makeSession: MakeSession): Promise<ItemSummary> => {
		const profile = requireUser(c);
		enabled();
		return fileItem(c, profile, input, "web", makeSession);
	},

	mergeGitlabItem: async (c: ItemsCtx, itemId: string, reviewedHead: string): Promise<ItemView> => {
		const profile = requireUser(c);
		enabled();
		knownItem(c, itemId);
		const view = await itemActor(c, profile.uid, itemId).internalMergeGitlab(reviewedHead);
		await noteItem(c, view);
		return attachmentStates(c, view);
	},

	actOnItem: async (c: ItemsCtx, input: { id: string; action: ItemAction }): Promise<ItemView> => {
		const profile = requireUser(c);
		return await attachmentStates(c, await act(c, profile.uid, input?.id, input?.action));
	},

	/** A press in the item's Slack thread, by the member linked to this account. */
	internalSlackAct: async (c: ItemsCtx, input: SlackAnswer): Promise<void> => {
		requireServiceFor(c, "call");
		await slackAct(c, input);
	},

	/** A mention in the item's thread: the owner's answer when it names a choice of the open question. */
	internalSlackReply: async (
		c: ItemsCtx,
		input: { id: string; text: string; slackUser: string },
	): Promise<SlackReply> => {
		requireServiceFor(c, "call");
		slackOwner(c);
		knownItem(c, input.id);
		const view = await itemActor(c, c.key[0], input.id).internalView();
		const choices = view.question ? slackChoices(view.question, view.plan) : [];
		if (!view.question || !choices.length) return { kind: "none" };
		const wanted = words(input.text);
		const choice = choices.find(
			ch => words(ch.label) === wanted || words(shortLabel(ch)) === wanted || words(ch.id) === wanted,
		);
		if (!choice) return { kind: "choices", labels: choices.map(ch => ch.label) };
		await slackAct(c, {
			id: input.id,
			question: view.question.id,
			choice: choice.id,
			version: view.plan?.version,
			slackUser: input.slackUser,
		});
		return { kind: "answered" };
	},

	// Answered with work items off too: the ceiling on running agents among these holds for a person's own agents as well.
	factoryLimits: (c: ItemsCtx): FactoryLimits => {
		requireUser(c);
		return accountLimits(c.vars.items.limits).factory;
	},

	apiTokens: async (c: ItemsCtx): Promise<ApiToken[]> => {
		requireUser(c);
		enabled();
		return await listApiTokens(c.db);
	},

	createApiToken: async (
		c: ItemsCtx,
		input: { name: string; scopes: ApiTokenScope[] },
	): Promise<{ token: ApiToken; secret: string }> => {
		const profile = requireUser(c);
		enabled();
		// Admission and minting must agree even if sign-out commits while this call waits for SQLite.
		const made = await c.db.transaction(async tx => {
			const [{ gen }] = await tx.execute<{ gen: number }>("SELECT gen FROM token_generation WHERE id = 1");
			requireUser({ key: c.key, conn: c.conn, vars: { tokenGen: gen } });
			return tokenInput(() => createApiToken(tx, profile.uid, input, Date.now()));
		});
		console.log(
			`[wlp] api_token.created uid=${profile.uid} token=${made.token.id} scopes=${made.token.scopes.join(",")}`,
		);
		return made;
	},

	revokeApiToken: async (c: ItemsCtx, id: string): Promise<ApiToken[]> => {
		const profile = requireUser(c);
		enabled();
		await revokeApiToken(c.db, id);
		console.log(`[wlp] api_token.revoked uid=${profile.uid} token=${String(id).slice(0, 40)}`);
		return await listApiTokens(c.db);
	},

	// --- called by api-routes.ts, with the caller's API token -------------------------------------

	internalApiCreateItem: async (
		c: ItemsCtx,
		input: { token: string; item: CreateItemInput },
		makeSession: MakeSession,
	): Promise<ItemSummary> => {
		requireServiceFor(c, "api");
		return fileItem(c, await apiCaller(c, input?.token, "items:create"), input?.item, "api", makeSession);
	},

	internalApiItem: async (c: ItemsCtx, input: { token: string; id: string }): Promise<ItemView> => {
		requireServiceFor(c, "api");
		await apiCaller(c, input?.token, "items:read");
		knownItem(c, input?.id);
		return await itemView(c, input.id);
	},

	// --- called by `workItem` and by item sessions ------------------------------------------------

	internalItemChanged: async (c: ItemsCtx, summary: ItemSummary): Promise<void> => {
		requireService(c);
		if (typeof summary?.id !== "string") return;
		const before = c.vars.items.items.get(summary.id);
		await noteItem(c, summary);
		await notifyProviderWaits(c, [summary]);
		if (
			summary.parent &&
			before &&
			summary.revision > before.revision &&
			(ended(summary) || summary.question?.id !== before.question?.id)
		) {
			const parent = itemActor(c, c.key[0]!, summary.parent.itemId);
			void c.keepAwake(
				parent
					.internalChildNotice({ id: summary.id, spent: summary.spent, budget: summary.budget, state: summary.state })
					.catch(error =>
						c.log.warn({
							msg: "The feature will read the child on its scheduled check.",
							child: summary.id,
							error: String(error),
						}),
					),
			);
		}
	},

	/** What an item reads of its user: the hosted sandbox seconds the ledger has for its session, and the user's open items. */
	internalItemFacts: (c: ItemsCtx, sessionIds: string[]): ItemFacts => {
		requireService(c);
		const today = dayOf(Date.now());
		const entries = Array.from({ length: USAGE_HISTORY_DAYS }, (_, back) => c.vars.usage.entriesOn(today - back))
			.flat()
			.filter(entry => sessionIds.includes(entry.session))
			.map(({ hold, session, seconds }) => ({ hold, session, seconds }));
		const openItems = [...c.vars.items.items.values()].filter(
			item => item.state !== "done" && item.state !== "failed" && item.state !== "cancelled",
		).length;
		return { entries, openItems };
	},

	/** An item session asks for a slot for the turn of `key`: granted now, or queued with a wait the item is told. Asked again, it answers the same. */
	internalRequestTurn: async (c: ItemsCtx, input: TurnRequest): Promise<TurnAnswer> => {
		requireService(c);
		const state = c.vars.items;
		const key = String(input?.key);
		const held = [...state.slots.values()].find(slot => slot.key === key);
		if (held) {
			// Asked by its session: this answer tells it, so the grant need not be sent again.
			if (!held.told) {
				held.told = true;
				await c.db.execute("DELETE FROM turn_grant WHERE slot = ?", held.id);
			}
			return { granted: true, slot: held.id };
		}
		const session = c.vars.sessions.get(String(input?.sessionId));
		if (!session?.item || session.item.id !== input.itemId) return { granted: false };
		const now = Date.now();
		const known = state.requests.get(key);
		const full =
			typeof input.deploymentFull === "number" && input.deploymentFull > 0
				? input.deploymentFull
				: (known?.full ?? null);
		const resumeAt =
			typeof input.resumeAt === "number" && Number.isSafeInteger(input.resumeAt) && input.resumeAt > 0
				? Math.min(input.resumeAt, now)
				: null;
		const request: Request = {
			key,
			session: session.id,
			item: input.itemId,
			title: String(input.title ?? ""),
			startsRun: input.startsRun === true,
			at: resumeAt !== null ? Math.min(resumeAt, known?.at ?? now) : (known?.at ?? now),
			attempt: known?.attempt ?? 0,
			full,
			deferUntil: input.deploymentFull ? now + FULL_FOR_MS : (known?.deferUntil ?? null),
			wait: known?.wait ?? null,
		};
		state.requests.set(key, request);
		await storeRequest(c.db, request);
		const mine = await runQueue(c, key);
		return mine ? { granted: true, slot: mine.id } : { granted: false };
	},

	/** The turn a slot was given to has ended, or could not start: the slot is free. Named by its id, so a release that comes twice frees nothing else. */
	internalTurnDone: async (c: ItemsCtx, input: TurnRelease): Promise<void> => {
		requireService(c);
		const slot = c.vars.items.slots.get(String(input?.slot));
		if (!slot || slot.session !== input.sessionId) return;
		const retry = input.machineWait;
		const request: Request | null = retry
			? {
					key: slot.key,
					session: slot.session,
					item: slot.item,
					title: slot.title,
					startsRun: retry.startsRun,
					at: retry.at,
					attempt: 0,
					full: null,
					deferUntil: retryAt(retry.at, 0),
					wait: null,
				}
			: null;
		// Keep the slot until its durable release commits. An outbox retry after a failed write still finds it.
		const released = await c.db.transaction(
			async tx => {
				const rows = await tx.execute("DELETE FROM turn_slot WHERE id = ? RETURNING id", slot.id);
				if (!rows.length) return false;
				await tx.execute("DELETE FROM turn_grant WHERE slot = ?", slot.id);
				if (request) await storeRequest(tx, request);
				return true;
			},
			{ name: "queue.release" },
		);
		if (!released || !c.vars.items.slots.delete(slot.id)) return;
		if (request) c.vars.items.requests.set(request.key, request);
		await runQueue(c);
	},

	/** The item does not want the turn of `key` any more, before it started: its request goes. */
	internalWithdrawTurn: async (c: ItemsCtx, input: { sessionId: string; key: string }): Promise<void> => {
		requireService(c);
		const key = String(input?.key);
		const slot = [...c.vars.items.slots.values()].find(slot => slot.key === key && slot.session === input.sessionId);
		// The inbox confirmed this delivery was withdrawn before it started. Its attach can still hold a
		// slot, or its delayed release can already have put it back in the queue.
		await c.db.transaction(
			async tx => {
				await tx.execute("DELETE FROM turn_request WHERE key = ? AND session = ?", key, input.sessionId);
				if (slot) {
					await tx.execute("DELETE FROM turn_slot WHERE id = ?", slot.id);
					await tx.execute("DELETE FROM turn_grant WHERE slot = ?", slot.id);
				}
			},
			{ name: "queue.withdraw" },
		);
		if (c.vars.items.requests.get(key)?.session === input.sessionId) c.vars.items.requests.delete(key);
		if (slot && c.vars.items.slots.delete(slot.id)) queueChanged(c);
	},

	// --- called by the actor's own schedule only ------------------------------------------------

	internalTurnQueue: async (c: ItemsCtx): Promise<void> => {
		const fire = c.scheduledFire;
		if (!fire) throw new UserError("This action is internal.", { code: "forbidden" });
		console.log(
			`[wlp] schedule.fired action=${QUEUE_ACTION} uid=${c.key[0]} waiting=${c.vars.items.requests.size} late_ms=${fire.firedAt - fire.scheduledAt}`,
		);
		if (c.vars.items.queueAt?.id === fire.id) c.vars.items.queueAt = null;
		await releaseDueSandboxes(c);
		await runQueue(c, null, true);
	},
};
