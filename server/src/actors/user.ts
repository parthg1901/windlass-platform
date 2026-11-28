// One actor per uid owns the account, session index and turn admission.
// Keep launch and submission claims synchronous. Service-only actions check their caller before reading account data.

import {
	addNotes,
	closeSetupPull,
	NOTE_LIFETIME,
	NOTES_TABLE,
	PUBLICATION_TABLE,
	readNotes,
	savePublication,
	setupKnowledge,
} from "../repo-setup/notes.js";
import type { DraftRequest, NoteInput, NoteDecision, SetupPublication } from "../repo-setup/types.js";
import { deploymentSize, resolveRun, type RunContext } from "../factory/resolve-run.js";
import { checkRunPlace, changesPlace, changedPlace, hasRoom, placeProblem } from "../factory/default-place.js";
import type {
	AccountDefaultsPatch,
	ContinueSessionInput,
	ItemPlaceDefaults,
	RepositoryDefaultsPatch,
} from "../contract.js";
import { digest, snapshotGeneration } from "../sandbox/snapshot-key.js";
import { placementInventory } from "./user-items.js";
import type { AgentModels } from "../factory/placement.js";
import { mayUse } from "../access.js";
import { githubId, isGithubId } from "../github/ids.js";
import type { MachineUpdate } from "./machine.js";
import { accountLimits, changeUserLimit, limitsSubject, type LimitAuditRow, type LimitChange } from "../user-limits.js";
import { loginGeneration, moveWindlassLimits, recordProviderUsage, type AccountLocation } from "./provider-accounts.js";
import type { UsageObservation } from "../provider-usage.js";
import {
	changed as machinesChanged,
	machineCatalog,
	machineModelLists,
	itemMachines,
	launchPlace,
	listMachines,
	launchMachineProfiles,
	machineActions,
	machineSecrets,
	machineTables,
} from "./user-machines.js";
import { keptFull, makeSandboxRoom } from "./user/kept-sandboxes.js";
import {
	accountTokenWait,
	ATTACHMENT_SWEEP_ACTION,
	ITEM_TABLES,
	type ItemFacts,
	type MakeSession,
	type ItemSessionInput,
	QUEUE_ACTION,
	notifyProviderWaits,
	notifyRemovedMachines,
	factorySlots,
	plannerHostedCapacity,
	itemActions,
	itemSessionRefusal,
	loadItems,
	queueChanged,
} from "./user-items.js";
import type { EnvironmentPlace, EnvironmentSchedule, RepositoryEnvironments } from "../contract.js";
import { ENVIRONMENT_SCHEDULES } from "../contract.js";
import {
	HOSTED_SIZE_NAMES,
	HOSTED_SIZES,
	ITEM_HOSTED_SIZE,
	SESSION_HOSTED_SIZE,
	isHostedSize,
	type HostedSize,
} from "../contract.js";
import type { GithubId, CreateItemInput, ItemListPage, ItemSummary } from "../contract.js";
import { randomBytes } from "node:crypto";
import { actor, event, UserError, type ActorCron } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { serviceParams } from "../auth.js";
import { MACHINE_ID } from "../runner/control.js";
import { machineActor } from "../sandbox/runner-layer.js";
import {
	assertOrigin,
	disconnectRevoked,
	userActorCaller,
	clientError,
	maySubscribe,
	requireService,
	requireServiceFor,
	requireUser,
} from "../auth.js";
import { config, githubConfig, snapshotsFor } from "../config.js";
import {
	type AccountDefaults,
	type AccountSecrets,
	type AccountSettings,
	type CreateSessionInput,
	type GithubBranchList,
	type PayWithChoice,
	type PayWithPatch,
	isPlanProvider,
	type RelaySeen,
	type StarterIssue,
	type GithubRepository,
	type GithubRepositoryList,
	type GithubStatus,
	type LinearStatus,
	type LinearTeamList,
	isolationName,
	listedSessions,
	MAX_ACCOUNT_SECRETS,
	MAX_PERSONAL_SERVERS,
	MAX_SERVER_DEFINITION_BYTES,
	MAX_TITLE_CHARS,
	type ModelProvider,
	type ModelPlanStatus,
	type PlanProvider,
	MAX_SECRETS_PER_REPOSITORY,
	type RepositoryApproval,
	type RepositoryCheck,
	type RepositoryChecks,
	type RepositoryNetwork,
	type NetworkScan,
	type EgressMode,
	type RepositoryDefaults,
	type RepositorySecrets,
	type RepositorySetup,
	type RepositoryView,
	type MachineSummary,
	type MachineHostUpdate,
	type SandboxProfile,
	type SavedRepository,
	type SecretScope,
	type SessionSummary,
	type UsageNumbers,
	type UserProfile,
} from "../contract.js";
import * as jira from "./user-jira.js";
import type { JiraItemWrite } from "./internal.js";
import type { JiraDelivery } from "../jira/webhook.js";
import { openUserGitlab } from "./user-gitlab.js";
import { SLACK_TABLES, slackSettingsActions } from "./user-slack.js";
import { IDENTITY_TABLES, linkedAccountActions } from "./user-identity.js";
import {
	LINEAR_TABLES,
	type LinearItemWrite,
	linearHoldsTeam,
	writeLinearItem,
	beginLinearConnect,
	claimLinearState,
	completeLinearConnection,
	fileLinearDelivery,
	linearStatus,
	linearTeams,
	removeLinearMapping,
	disconnectLinear,
	saveLinearMapping,
} from "./user-linear.js";
import {
	GITHUB_SYNC,
	GITHUB_SYNC_TABLE,
	retryGithubSync,
	syncGithubWebhooks,
	updateGithubInstallation,
	replaceGithubConnection,
	type InstallationChange,
} from "./user-github.js";
import { githubApp, type GithubApp } from "../github/app.js";
import { isBranchName } from "../github/git.js";
import type { StoredRepository } from "../github/publish.js";
import {
	GithubProblem,
	type StoredConnection,
	listBranches,
	listRepositories,
	listStarterIssues,
	resolveBoundRepository,
	resolveRepository,
} from "../github/repos.js";
import {
	MAX_GITHUB_ACCOUNTS,
	STATE_TTL_MS,
	TICKET_TTL_MS,
	issueState,
	newCodeVerifier,
	newNonce,
	verifyTicket,
} from "../github/state.js";
import { getLayer } from "../layer.js";
import { initialSessionModes } from "../sandbox/profiles.js";
import { codexModes, innerModesReason } from "../sandbox/codex-modes.js";
import {
	capabilitiesOf,
	hostedCatalog,
	hostedHarness,
	hostedKeyMessage,
	hostedPayer,
	availableCatalog,
	itemHarnessProblem,
	itemProfileProblem,
	itemSignInMessage,
	itemSignInMethodProblem,
	knownHarness,
	machineHarness,
	machineHarnesses,
	initialHarnessModels,
	sessionCapabilities,
} from "../sandbox/harnesses.js";
import { AccountModels, MODELS_TABLE, checkItemEffort, chosenModel, standInModels } from "../account-models.js";
import { modelProviderActions } from "../credentials/keys.js";
import { CREDENTIAL_TABLES, credentialActions, hostedCredentials } from "../credentials/index.js";
import { PAY_WITH_TABLE, PayWithProblem, payWithPatchOf, readPayWith, savePayWith } from "../pay-with.js";
import { PAY_ONCE_TABLE, type PayerAnswer, turnPayer, useKeyOnce } from "./user-payer.js";
import { planReading, relaySeenOf } from "../credentials/plan-health.js";
import { MODEL_PLAN_COLUMNS, moveSignInToPlan, observePlan, planStatuses } from "../credentials/plans.js";
import {
	ACCOUNT_SECRETS_TABLE,
	ACCOUNT_SECRET_PROJECT,
	SecretNotFound,
	TooManySecrets,
	accountSecretNames,
	deleteAccountSecret,
	listedAccountSecrets,
	saveAccountSecret,
} from "../account-secrets.js";
import { publishAsksEveryTime, publishUnaskedProblem } from "../agent-publish.js";
import {
	PERSONAL_SERVERS_TABLE,
	ServerProblem,
	addServer,
	changeServer,
	cleanServerDefinition,
	cleanServerName,
	cleanUnasked,
	deleteServer,
	listedServer,
	readServers,
} from "../personal-servers.js";
import { refreshSecretRows } from "../signin/secret-rows.js";
import { criticAllowed } from "../factory/review.js";
import {
	MAX_SECRETS_PER_USER,
	SecretProblem,
	unavailableSecretName,
	validRequestedSecretName,
	cleanSecretName,
	cleanSecretScope,
	cleanSecretValue,
	commandSandbox,
	listedSecrets,
	saveRepoSecret,
	sealSecret,
} from "../repo-secrets.js";
import { criticSessionId } from "../factory/feature-ids.js";
import {
	DEFAULTS_TABLE,
	migrateDefaults,
	type DefaultsChange,
	DefaultsProblem,
	cleanDefaults,
	repositoryDefaultsLog,
	readAccountDefaults,
	saveAccountDefaults,
	readDefaults,
	saveDefaults,
	refuseAtRepositoryCap,
} from "../repository-defaults.js";
import { ApprovalBook, type BookChange, type ServerApproval, sessionProjectKey } from "../server-approvals.js";
import { forgettingWords, personalServerReach } from "../server-question.js";
import { CHECKS_TABLE, ChecksProblem, cleanChecks, readChecks, saveChecks } from "../repository-checks.js";
import {
	NETWORK_TABLE,
	NetworkProblem,
	REQUESTS_TABLE,
	addEntry,
	cleanEntries,
	cleanEntry,
	dismissRequest,
	fileRequests,
	mayChangeNetwork,
	networkLimit,
	networkPresets,
	readNetwork,
	readRequests,
	saveNetwork,
	scanForHosts,
	scanPaths,
	unionHosts,
} from "../repository-network.js";
import { MAX_SETUP_COMMANDS, SetupCommandProblem, cleanSetupCommand, setupProjectKey } from "../setup-command.js";
import { keyOf } from "../codehost/ref.js";
import { Attempts, type Submission, SubmissionProblem, isRepeat, submissionOf } from "../submissions.js";
import { serverSealer } from "../signin/seal.js";
import { recordTurnTokens, tokensOn, usesPlatformModel, type TokenReceipt, hostedLimitsApply } from "../usage.js";
import { OFFLINE_REPOSITORY } from "../runner/egress.js";
import { HOSTED_OFFLINE_REPOSITORY } from "../sandbox/hosted-network.js";
import {
	cachedScan,
	saveSetupScan,
	claimAssessment,
	finishAssessment,
	repositoryReadiness,
	READINESS_TABLE,
	READINESS_TICK,
	SETUP_LEASE_MS,
	scheduleName,
	scheduleSetup,
	setupInputs,
} from "./user-readiness.js";
import { applyOffers, offered, type OfferRow } from "../factory/readiness-track.js";
import type { Judgment } from "../factory/readiness.js";
import { readinessPrompt } from "../factory/readiness-filing.js";
import { scanCiHistory } from "../github/ci-history.js";
import { scanRepoSetup } from "../github/setup-checks.js";
import { ENVIRONMENT_SCHEDULE_TABLE, ENVIRONMENT_TABLE, HOSTED } from "../environments.js";
import {
	BuildStartRefused,
	buildResult,
	environmentsView,
	forgetEnvironments,
	nudge as environmentNudge,
	pushed as environmentPushed,
	rebuild as rebuildEnvironments,
	saveSchedule,
	sessionEnvironment,
	settingsChanged,
	tick as environmentTick,
	wakeEnvironments,
	type EnvironmentHost,
} from "./user-environments.js";
import type {
	Continuation,
	ContinuedFrom,
	EnvironmentBuildOrigin,
	EnvironmentBuildReport,
	ForkSource,
	SessionCreateInput,
	ActorClient,
} from "./internal.js";
import { continuedInput, copyAgentSession } from "./continue-session.js";
import { errorText } from "../util.js";
import { AccountCheckout, billingTables, readBilling } from "../billing/account.js";
import { billing } from "../billing/config.js";
import { hostedSizesForPlan, planAllowsSize } from "../billing/plans.js";

import {
	type SealedSecrets,
	type RequestedSecretSave,
	createSessionActor,
	isSessionGone,
	isDuplicateKey,
	isActorGone,
	itemActor,
	itemScreenshots,
	modelKeyCaller,
	secretsCaller,
	sessionActor,
	userActor,
} from "./internal.js";
import { boundedText, type UserVars, type UserCtx } from "./user/state.js";
import { chatgptPlan, modelInput, modelsOf, signinActions, writeActorProfile, type ModelsCtx } from "./user/signin.js";
import { readUsage, sizesOf, queueOverageReport, usageActions } from "./user/usage.js";
export { itemSharing, readUsage } from "./user/usage.js";

export const DEFAULT_TITLE = "New agent";

const MAX_REPO_URL_CHARS = 300;

// Reconcile a launch that dies before its first meter acknowledgement.
const LAUNCH_LEASE_MS = 60_000;

const BACKUP_REMOVE_TRIES = 8;

const BACKUP_REMOVE_FIRST_MS = 60_000;

/** A try this far past its time when the actor wakes lost its schedule, and is set again. */
const BACKUP_REMOVE_LATE_MS = 10 * 60_000;

interface ConnParams {
	token?: string;
}

function sessionList(vars: UserVars): SessionSummary[] {
	return listedSessions([...vars.sessions.values()]).sort(
		(a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1),
	);
}

/** A key or plan was saved or removed: machines, the queue and items waiting on a provider see it. */
async function credentialsChanged(
	c: Parameters<typeof machinesChanged>[0] &
		Parameters<typeof notifyProviderWaits>[0] &
		Parameters<typeof queueChanged>[0],
): Promise<void> {
	await machinesChanged(c);
	queueChanged(c);
	await notifyProviderWaits(c, c.vars.items.items.values(), "settings");
}

function broadcastSessions(c: UserCtx): void {
	c.broadcast("sessions", sessionList(c.vars));
}

async function storeSession(c: UserCtx, summary: SessionSummary, submission: Submission | null = null): Promise<void> {
	await c.db.execute(
		"INSERT INTO sessions (id, created_at, summary, key, sent) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET summary = excluded.summary",
		summary.id,
		summary.createdAt,
		JSON.stringify(summary),
		submission?.key ?? null,
		submission?.sent ?? null,
	);
}

/** All reports, including a refresh at the ceiling, respect an outstanding claim for the next turn. */
async function storeReport(c: UserCtx, summary: SessionSummary, checkedAt = 0): Promise<void> {
	const known = c.vars.sessions.get(summary.id);
	if (!known || summary.turns < known.turns) return;
	const until = c.vars.launchUntil.get(summary.id);
	if (until !== undefined && until > checkedAt && summary.turns === known.turns) {
		summary = { ...summary, status: "starting" };
	} else {
		c.vars.launchUntil.delete(summary.id);
		c.vars.launchClaim.delete(summary.id);
	}
	c.vars.sessions.set(summary.id, summary);
	await c.db.execute(
		"UPDATE sessions SET summary = ?, launch_until = ? WHERE id = ?",
		JSON.stringify(summary),
		c.vars.launchUntil.get(summary.id) ?? null,
		summary.id,
	);
	broadcastSessions(c);
}

interface BackupRemovalCtx {
	db: RawAccess;
	schedule: { at(timestamp: number, action: string, ...args: unknown[]): Promise<string> };
}

// Schedule the retry before recording it so wake can repair an interrupted write.
// `machine`: the session was on that machine, whose actor records the removal (machine-backups.ts); null: the bucket's.
async function armBackupRemoval(
	c: BackupRemovalCtx,
	session: string,
	tries: number,
	machine: string | null = null,
): Promise<void> {
	const at = Date.now() + BACKUP_REMOVE_FIRST_MS * 2 ** tries;
	const id = await c.schedule.at(at, "internalRemoveBackup", session);
	await c.db.execute(
		"INSERT OR REPLACE INTO backup_removal (session, tries, due_at, schedule_id, machine) VALUES (?, ?, ?, ?, ?)",
		session,
		tries,
		at,
		id,
		machine,
	);
}

const MAX_GITHUB_PENDING = 20;

function requireGithub(): GithubApp {
	const app = githubApp();
	if (!app)
		throw new UserError("This deployment has no GitHub App, so GitHub cannot be connected here.", {
			code: "github_off",
		});
	return app;
}

function requireConnection(c: { vars: UserVars }): StoredConnection {
	if (!c.vars.github)
		throw new UserError("GitHub is not connected. Connect GitHub first.", { code: "github_not_connected" });
	return c.vars.github;
}

function githubStatus(vars: UserVars): GithubStatus {
	const stored = vars.github;
	if (!stored) return { connection: null };
	return {
		connection: {
			login: stored.user.login,
			accounts: stored.installations.map(installation => ({
				installationId: installation.id,
				login: installation.account.login,
				kind: installation.account.type === "Organization" ? "organization" : "user",
				manageUrl: installation.htmlUrl,
			})),
			connectedAt: stored.connectedAt,
		},
	};
}

function githubError(log: { error: (entry: unknown) => void }, error: unknown, fallback: string): UserError {
	if (error instanceof GithubProblem) return new UserError(error.message, { code: error.code });
	return clientError(log, error, fallback);
}

async function rememberPending(c: UserCtx, nonce: string, verifier: string | null): Promise<void> {
	const now = Date.now();
	await c.db.execute("DELETE FROM github_nonce WHERE expires_at <= ?", now);
	await c.db.execute(
		"DELETE FROM github_nonce WHERE kind = 'state' AND nonce NOT IN (SELECT nonce FROM github_nonce WHERE kind = 'state' ORDER BY expires_at DESC LIMIT ?)",
		MAX_GITHUB_PENDING - 1,
	);
	await c.db.execute(
		"INSERT INTO github_nonce (nonce, kind, verifier, expires_at) VALUES (?, 'state', ?, ?)",
		nonce,
		verifier,
		now + STATE_TTL_MS,
	);
}

type ApprovalRow = {
	project: string;
	label: string;
	name: string;
	fingerprint: string;
	approved_at: number;
	expires_at: number;
};

async function readApprovals(db: RawAccess): Promise<ServerApproval[]> {
	const rows = await db.execute<ApprovalRow>(
		"SELECT project, label, name, fingerprint, approved_at, expires_at FROM server_approval",
	);
	return rows.map(row => ({
		project: row.project,
		label: row.label,
		name: row.name,
		fingerprint: row.fingerprint,
		approvedAt: row.approved_at,
		expiresAt: row.expires_at,
	}));
}

// Mutate the in-memory book before awaiting. Reload from storage after a failed write.
async function changeApprovals(c: UserCtx, change: (book: ApprovalBook) => BookChange): Promise<BookChange> {
	const done = change(c.vars.approvals);
	try {
		for (const row of done.removed)
			await c.db.execute(
				"DELETE FROM server_approval WHERE project = ? AND name = ? AND fingerprint = ?",
				row.project,
				row.name,
				row.fingerprint,
			);
		for (const row of done.added) {
			await c.db.execute(
				"INSERT OR REPLACE INTO server_approval (project, label, name, fingerprint, approved_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
				row.project,
				row.label,
				row.name,
				row.fingerprint,
				row.approvedAt,
				row.expiresAt,
			);
		}
	} catch (error) {
		c.vars.approvals = new ApprovalBook(await readApprovals(c.db).catch(() => []), config.serverApprovalTtlMs);
		throw error;
	}
	return done;
}

async function setupRow(db: RawAccess, project: string) {
	const [row] = await db.execute<{ command: string; updated_at: number; snapshot_connection: number | null }>(
		"SELECT command, updated_at, snapshot_connection FROM setup_command WHERE project = ?",
		project,
	);
	return row;
}

async function readSetup(db: RawAccess, project: string): Promise<RepositorySetup> {
	const row = await setupRow(db, project);
	return { command: row?.command ?? "", updatedAt: row?.updated_at ?? null, timeoutMs: config.setupTimeoutMs };
}

async function dropHostedSnapshots(uid: string, repo?: string) {
	if (config.sandbox !== "fake" && snapshotsFor({ kind: "hosted" }))
		await (await getLayer()).sandboxes.dropSnapshots?.(uid, repo).catch(() => {
			console.warn("[wlp] snapshot cleanup deferred");
		});
}

async function saveSetup(
	c: UserCtx,
	uid: string,
	project: string,
	label: string,
	command: string,
): Promise<RepositorySetup> {
	const previous = await readSetup(c.db, project);
	if (previous.command === command) return previous;
	if (command === "") {
		await c.db.execute("DELETE FROM setup_command WHERE project = ?", project);
	} else {
		await refuseAtRepositoryCap(c.db, "setup_command", project, MAX_SETUP_COMMANDS, "setup commands");
		await c.db.execute(
			"INSERT INTO setup_command (project, label, command, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (project) DO UPDATE SET label = CASE WHEN excluded.label = '' THEN label ELSE excluded.label END, command = excluded.command, snapshot_connection = NULL, updated_at = MAX(updated_at + 1, excluded.updated_at)",
			project,
			label,
			command,
			Date.now(),
		);
	}
	await dropHostedSnapshots(uid, project.slice("github:".length));
	console.log(`[wlp] setup.saved uid=${uid} project=${project} chars=${command.length}`);
	return readSetup(c.db, project);
}

function setupCommandOf(raw: unknown): string {
	try {
		return cleanSetupCommand(raw);
	} catch (error) {
		if (error instanceof SetupCommandProblem) throw new UserError(error.message, { code: "bad_setup_command" });
		throw error;
	}
}

function sessionSetupKey(session: SessionSummary | undefined) {
	return session?.repository?.provider === "gitlab" ? null : setupProjectKey(session?.repository?.id);
}

function setupKeyOf(repositoryId: unknown): string {
	const key = setupProjectKey(repositoryId);
	if (key === null) throw new UserError("Choose one of the listed repositories.", { code: "bad_input" });
	return key;
}

async function secretProfile(id: unknown): Promise<SandboxProfile> {
	const { sandboxes } = await getLayer();
	const profile = sandboxes.profiles().find(item => item.id === id);
	if (!profile) throw new UserError("Choose one of the listed sandboxes.", { code: "bad_input" });
	return profile;
}

/** Check both stores by name alone, including secrets withheld from this session. */
async function requestedSecretConflict(
	db: Pick<RawAccess, "execute">,
	project: string | null,
	name: string,
	reader: "agent" | "person" = "agent",
): Promise<string | null> {
	const [row] = await db.execute<{ source: string }>(
		"SELECT 'repository' AS source FROM repo_secret WHERE project = ? AND name = ? UNION ALL SELECT 'account' FROM account_secret WHERE name = ? LIMIT 1",
		project,
		name,
		name,
	);
	if (!row) return null;
	return reader === "agent"
		? unavailableSecretName(name)
		: `${name} already exists for this ${row.source}, so nothing was saved. To let agents use it, change its scope under Secrets.`;
}

async function listSecrets(db: RawAccess, project: string, profile: SandboxProfile): Promise<RepositorySecrets> {
	const rows = await db.execute<{ name: string; scope: string; updated_at: number }>(
		"SELECT name, scope, updated_at FROM repo_secret WHERE project = ? ORDER BY name",
		project,
	);
	const listed = listedSecrets(rows, profile);
	// A secret of the account under the same name is not used in this repository's sessions: the list says where that is so.
	const account = rows.length === 0 ? new Set<string>() : await accountSecretNames(db);
	return account.size === 0
		? listed
		: {
				...listed,
				secrets: listed.secrets.map(secret => (account.has(secret.name) ? { ...secret, account: true } : secret)),
			};
}

function checkSecretLimit(result: Awaited<ReturnType<typeof saveRepoSecret>>): void {
	if (result === "repository_full")
		throw new UserError(`A repository can have at most ${MAX_SECRETS_PER_REPOSITORY} secrets. Delete one first.`, {
			code: "too_many_secrets",
		});
	if (result === "account_full")
		throw new UserError(
			`You have ${MAX_SECRETS_PER_USER.toLocaleString("en-US")} secrets saved over all your repositories, which is the limit. Delete one first.`,
			{ code: "too_many_secrets" },
		);
}

async function saveSecret(
	c: UserCtx,
	uid: string,
	project: string,
	label: string,
	name: string,
	value: string | undefined,
	scope: SecretScope,
): Promise<void> {
	let saved: "kept" | "new" | "replaced" = "kept";
	if (value === undefined) {
		const [found] = await c.db.execute<{ n: number }>(
			"SELECT COUNT(*) AS n FROM repo_secret WHERE project = ? AND name = ?",
			project,
			name,
		);
		if ((found?.n ?? 0) === 0)
			throw new UserError(`No secret named ${name} is saved for this repository.`, { code: "secret_not_found" });
		await c.db.execute(
			"UPDATE repo_secret SET scope = ?, updated_at = ? WHERE project = ? AND name = ?",
			scope,
			Date.now(),
			project,
			name,
		);
	} else {
		// The limits and the write are one conditional statement: saves at the same moment cannot pass a limit together.
		const result = await saveRepoSecret(c.db, {
			uid,
			project,
			label,
			name,
			sealed: sealSecret(serverSealer(), uid, project, name, value),
			scope,
			now: Date.now(),
		});
		checkSecretLimit(result);
		saved = result === "replaced" ? "replaced" : "new";
	}
	// The name, never anything of the value: not its length either.
	console.log(`[wlp] secret.saved uid=${uid} project=${project} name=${name} scope=${scope} value=${saved}`);
}

function secretInput<T>(clean: () => T): T {
	try {
		return clean();
	} catch (error) {
		if (error instanceof SecretProblem) throw new UserError(error.message, { code: "bad_secret" });
		throw error;
	}
}

function repositoryLabel(vars: UserVars, repositoryId: unknown): string {
	let newest: SessionSummary | null = null;
	for (const session of vars.sessions.values())
		if (
			session.repository?.provider !== "gitlab" &&
			session.repository?.id === repositoryId &&
			(newest === null || session.createdAt > newest.createdAt)
		)
			newest = session;
	const known = newest?.repository;
	return known ? `${known.owner}/${known.name}` : "";
}

const MAX_SAVED_REPOSITORIES = 500;

/** GitHub's id for the repository a key names; null for the key of a pasted address or of a session. */
function repositoryIdOf(project: string): GithubId | null {
	const id = /^github:([1-9][0-9]{0,18})$/.exec(project)?.[1];
	return githubId(id);
}

async function repositoryName(c: UserCtx, repositoryId: GithubId, project: string): Promise<string> {
	const known = repositoryLabel(c.vars, repositoryId);
	if (known !== "") return known;
	const [row] = await c.db.execute<{ label: string }>(
		"SELECT label FROM (SELECT label, updated_at FROM repository_defaults WHERE project = ? UNION ALL SELECT label, updated_at FROM setup_command WHERE project = ? UNION ALL SELECT label, updated_at FROM repository_checks WHERE project = ? UNION ALL SELECT label, updated_at FROM repo_secret WHERE project = ? UNION ALL SELECT label, updated_at FROM repository_network WHERE project = ?) WHERE label != '' ORDER BY updated_at DESC LIMIT 1",
		project,
		project,
		project,
		project,
		project,
	);
	return row?.label ?? c.vars.approvals.of(project, Date.now()).find(approval => approval.label !== "")?.label ?? "";
}

const NAMING_MS = 4_000;

// Repository saves can use a cached label when GitHub is slow or unreachable.
async function labelFor(c: UserCtx, repositoryId: GithubId, project: string): Promise<string> {
	const known = await repositoryName(c, repositoryId, project);
	const app = githubApp();
	const connection = c.vars.github;
	if (known !== "" || !app || !connection) return known;
	try {
		const { described } = await resolveRepository(app, connection, repositoryId, "read", Date.now() + NAMING_MS);
		return `${described.owner}/${described.name}`;
	} catch {
		return "";
	}
}

async function refreshSetupScan(c: UserCtx, id: GithubId, project: string) {
	const at = Date.now();
	const app = requireGithub();
	const { installation } = await resolveRepository(app, requireConnection(c), id, "read");
	const { repo, files } = await app.withToken(
		installation.id,
		{ repositoryId: id, permissions: { contents: "read", metadata: "read" } },
		async token => {
			const repo = await app.repositoryById(token, id);
			return { repo, files: await scanRepoSetup(app, token, repo) };
		},
		{ revokeAfter: true },
	);
	const ci = await app
		.withToken(
			installation.id,
			{
				repositoryId: id,
				permissions: {
					metadata: "read",
					contents: "read",
					checks: "read",
					statuses: "read",
					pull_requests: "read",
					actions: "read",
				},
			},
			token => scanCiHistory(app, token, repo, files.commit, at),
			{ revokeAfter: true },
		)
		.catch(() => null);
	return c.db.transaction(tx => saveSetupScan(tx, project, at, files, ci));
}

function guideFilesFor(c: Pick<CreateCtx, "client">, id: GithubId) {
	return c.client().githubRepository.getOrCreate([String(id)], { params: serviceParams() });
}

/** The ended items on the repository `project` keys: by key, so a GitLab project never counts toward a GitHub repository of the same id. */
async function repoRecords(c: UserCtx & Pick<CreateCtx, "client">, project: string) {
	const rows = [...c.vars.items.items.values()].filter(
		s => keyOf(s.repository) === project && !s.parent && ["done", "failed", "cancelled"].includes(s.state),
	);
	for (const row of rows)
		if (row.record === undefined) {
			const summary = await itemActor(c, c.vars.profile!.uid, row.id).internalSummary();
			if (row.revision === summary.revision) row.record = summary.record;
		}
	return rows.flatMap(s => (s.record ? [s.record] : []));
}

async function repoPolicy(
	c: UserCtx & Pick<CreateCtx, "client">,
	project: string,
	weekly = false,
	scanError: string | null = null,
	patch?: RepositoryDefaultsPatch,
) {
	const records = await repoRecords(c, project);
	return c.db.transaction(async tx => {
		const scan = await cachedScan(tx, project);
		const inputs =
			scan &&
			(await setupInputs(
				tx,
				project,
				scan,
				(
					await readSetup(tx, project)
				).command,
				(
					await readChecks(tx, project)
				).checks,
			));
		const readiness = await repositoryReadiness(tx, project, inputs ?? null, weekly, scanError, records);
		const manual = await readDefaults(tx, project);
		const rows = await tx.execute<OfferRow>("SELECT offer, earned, off FROM setup_offer WHERE project=?", project);
		const record = readiness.latest?.record;
		const policy = applyOffers(manual, record, rows);
		for (const offer of policy.expired)
			await tx.execute("UPDATE setup_offer SET off=1 WHERE project=? AND offer=?", project, offer);
		if (patch?.offer !== undefined) {
			if (!record || !offered(record, policy.defaults).includes(patch.offer))
				throw new UserError("This offer is no longer available.", { code: "bad_input" });
			const row = { offer: patch.offer, earned: record.earned[patch.offer]!, off: 0 };
			await tx.execute("INSERT OR REPLACE INTO setup_offer VALUES (?,?,?,0)", project, row.offer, row.earned);
			return {
				readiness,
				defaults: applyOffers(manual, record, [...rows.filter(r => r.offer !== row.offer), row]).defaults,
			};
		}
		return { readiness: { ...readiness, switchNote: policy.switchNote }, defaults: policy.defaults };
	});
}

async function repositoryView(
	c: UserCtx & Pick<CreateCtx, "client"> & { cron: Pick<ActorCron, "get"> },
	repositoryId: GithubId,
	project: string,
): Promise<RepositoryView> {
	const setup = await readSetup(c.db, project);
	const [secrets] = await c.db.execute<{ n: number }>(
		"SELECT COUNT(*) AS n FROM repo_secret WHERE project = ?",
		project,
	);
	const { checks } = await readChecks(c.db, project);
	const network = await readNetwork(c.db, project);
	const name = await repositoryName(c, repositoryId, project);
	const { sandboxes } = await getLayer();
	const approvals = new Map<string, RepositoryApproval>();
	for (const approval of c.vars.approvals.of(project, Date.now())) {
		const listed = approvals.get(approval.name);
		if (listed) listed.definitions += 1;
		else
			approvals.set(approval.name, {
				name: approval.name,
				approvedAt: approval.approvedAt,
				expiresAt: approval.expiresAt,
				definitions: 1,
			});
	}
	let scan = await cachedScan(c.db, project);
	let scanError = null;
	// A scan saved before CI history was read has no `ci` field: read it again now.
	if (c.vars.github && (!scan || !("ci" in scan) || Date.now() - scan.at > 24 * 60 * 60_000)) {
		try {
			scan = await refreshSetupScan(c, repositoryId, project);
		} catch {
			scanError = "Could not read the default branch. Open this page again to retry.";
		}
	}
	const knowledge = await setupKnowledge(c.db, c.vars.profile!.uid, project);
	const policy = await repoPolicy(c, project, !!(await c.cron.get(scheduleName(repositoryId))), scanError);
	return {
		id: repositoryId,
		name: name === "" ? null : name,
		knowledge,
		guideCheck: scan
			? await guideFilesFor(c, repositoryId).internalGuideSettings(knowledge.publication?.head)
			: { enabled: true, result: null },
		...policy,
		approvals: [...approvals.values()],
		// For all the repository's sessions, of either Docker profile: a hardened one's Windlass data may be its own.
		forgetting: forgettingWords({
			dataInSandbox: sandboxes.sessionsLiveInSandbox,
			hardenedOwnData: (await sandboxes.privateSessionData?.("docker-hardened")) === true,
		}),
		saved: { setup: !!setup.command, secrets: secrets?.n ?? 0, checks: checks.length, network: network.entries.length },
	};
}

/**
 * What the deployment's hosted sandboxes reach whatever a repository's list says (sandbox/e2b/network.ts):
 * null where hosted sandboxes have no list of hosts (not on E2B).
 */
async function hostedNetwork(): Promise<{ mode: EgressMode; hosts: string[] } | null> {
	const { sandboxes } = await getLayer();
	const hosts = sandboxes.allowedHosts?.();
	const mode = sandboxes.egress?.();
	return hosts === undefined || mode === undefined ? null : { mode, hosts: [...hosts] };
}

async function networkView(c: UserCtx, project: string): Promise<RepositoryNetwork> {
	const hosted = await hostedNetwork();
	const saved = await readNetwork(c.db, project);
	const deploymentHosts = hosted?.mode === "restricted" ? hosted.hosts : [];
	return {
		...saved,
		requests: await readRequests(c.db, project, [...saved.hosts, ...deploymentHosts]),
		presets: networkPresets(),
		hosted,
		limit: networkLimit(deploymentHosts, config.hosted?.network.maxHosts),
	};
}

async function deploymentHostsForLimit(): Promise<string[]> {
	const hosted = await hostedNetwork();
	return hosted?.mode === "restricted" ? hosted.hosts : [];
}

function networkInput<T>(read: () => T): T {
	try {
		return read();
	} catch (error) {
		if (error instanceof NetworkProblem) throw new UserError(error.message, { code: "bad_network" });
		throw error;
	}
}

/** A name a client sent, for a log line: what is printable of it. */
const logged = (text: string) => text.replace(/[^\x21-\x7e]/g, "?");

async function accountView(db: RawAccess): Promise<AccountSettings> {
	const defaults = await readAccountDefaults(db);
	const servers = await readServers(db);
	const secrets = await accountSecretNames(db);
	const { sandboxes } = await getLayer();
	return {
		defaults,
		servers: servers.map(server => listedServer(server, secrets)),
		serverReach: personalServerReach(sandboxes.profiles(), sandboxes.egress?.()),
		limits: {
			servers: MAX_PERSONAL_SERVERS,
			definitionBytes: MAX_SERVER_DEFINITION_BYTES,
			secrets: MAX_ACCOUNT_SECRETS,
		},
	};
}

/**
 * The account's secrets as a client may see them: name, when each last changed, what it reaches in a
 * sandbox of `profile`, and which repositories have a secret of their own under its name. The value's
 * column is not read, of either table, so no value can be in the answer.
 */
async function listAccountSecrets(db: RawAccess, profile: SandboxProfile): Promise<AccountSecrets> {
	const rows = await db.execute<{ name: string; scope: string; updated_at: number }>(
		"SELECT name, scope, updated_at FROM account_secret ORDER BY name",
	);
	const shared =
		rows.length === 0
			? []
			: await db.execute<{ name: string; project: string; label: string }>(
					"SELECT name, project, label FROM repo_secret WHERE name IN (SELECT name FROM account_secret)",
				);
	return listedAccountSecrets(rows, shared, profile);
}

function serverInput<T>(clean: () => T): T {
	try {
		return clean();
	} catch (error) {
		if (error instanceof ServerProblem) throw new UserError(error.message, { code: error.code });
		throw error;
	}
}

export function cleanTitle(title: unknown): string | null {
	if (typeof title !== "string") return null;
	if (!title.trim()) return null;
	if (title.length > MAX_TITLE_CHARS)
		throw new UserError(`A title can be at most ${MAX_TITLE_CHARS} characters.`, { code: "bad_input" });
	return title;
}

/** An https git address with no credentials in it, and nothing a shell or git could read as an option. */
export function cleanRepoUrl(raw: unknown): string | null {
	if (raw === undefined || raw === null || raw === "") return null;
	const problem = new UserError(
		"The repository must be an https git address without a user name or password in it, like https://github.com/owner/name.git",
		{
			code: "bad_repo_url",
		},
	);
	if (typeof raw !== "string") throw problem;
	const text = raw.trim();
	if (text.length > MAX_REPO_URL_CHARS || !/^https:\/\/[A-Za-z0-9._~:/%+-]+$/.test(text)) throw problem;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw problem;
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.hostname === "" ||
		url.pathname.length < 2
	)
		throw problem;
	return url.toString();
}

interface CreateCtx extends UserCtx, ModelsCtx {
	log: { error(entry: unknown): void };
	client(): ActorClient;
}

const KEYED = "agent";

async function sessionHostedSize(
	c: CreateCtx,
	asked: unknown,
	project: string | null,
	item: ItemSessionInput | undefined,
): Promise<HostedSize | undefined> {
	const layer = await getLayer();
	if (asked !== undefined && asked !== null && !isHostedSize(asked))
		throw new UserError(`Choose a hosted size: ${HOSTED_SIZES.map(size => HOSTED_SIZE_NAMES[size]).join(", ")}.`, {
			code: "bad_input",
		});
	// Where the deployment has billing, the plan's sizes only (billing/plans.ts): Free has no large.
	const plan = accountLimits(c.vars.items.limits).plan;
	if (plan && isHostedSize(asked) && !planAllowsSize(plan, asked))
		throw new UserError(
			`${HOSTED_SIZE_NAMES[asked]} sandboxes are on Pro. Choose a smaller size, or upgrade in Settings.`,
			{ code: "bad_input" },
		);
	const listed = layer.sandboxes.sizes?.() ?? [];
	const offered = hostedSizesForPlan(listed, plan).map(size => size.id);
	if (listed.length > 0 && offered.length === 0)
		throw new UserError("No hosted sandbox size is available on your plan.", { code: "bad_input" });
	const selected =
		asked ?? item?.hostedSize ?? (!item && project ? (await readDefaults(c.db, project)).hostedSize : null);
	if (selected && !offered.includes(selected))
		throw new UserError(
			`${HOSTED_SIZE_NAMES[selected]} is unavailable here. Choose ${offered.map(size => HOSTED_SIZE_NAMES[size]).join(" or ") || "the deployment size"}.`,
			{ code: "bad_input" },
		);
	if (listed.length <= 1) return offered[0];
	return selected ?? deploymentSize(offered, item ? ITEM_HOSTED_SIZE : SESSION_HOSTED_SIZE);
}

/** What `continueSession` hands `makeSession` beside the settings: the new session's id, made first for the copy's key, and what it carries over. */
interface ContinuedSession {
	sessionId: string;
	effort: string | null;
	continuation: Omit<Continuation, "from"> & { from: Omit<ContinuedFrom, "base"> };
}

/** `continueSession`: a new session with the earlier one's settings and memory, on a new branch from `base`. */
async function continueFrom(
	c: CreateCtx,
	profile: UserProfile,
	input: ContinueSessionInput,
	submission: Submission | null,
): Promise<SessionSummary> {
	const parent = c.vars.sessions.get(input.id);
	if (!parent) throw new UserError("That agent does not exist.", { code: "session_not_found" });
	if (parent.item || parent.readiness || parent.environmentBuild)
		throw (
			itemSessionRefusal(c, parent) ??
			new UserError("Only your own agents can be continued in a new pull request.", { code: "item_session" })
		);
	if (!parent.repository)
		throw new UserError(
			"This agent has no repository from your GitHub connection, so there is no pull request to continue.",
			{
				code: "no_repository",
			},
		);
	let source: ForkSource;
	try {
		// The actor is the caller's own: its key holds the caller's uid.
		source = await sessionActor(c, profile.uid, parent.id).internalForkSource();
	} catch (error) {
		if (isSessionGone(error)) throw new UserError("That agent does not exist any more.", { code: "session_not_found" });
		const { group, code, message } = (typeof error === "object" && error !== null ? error : {}) as {
			group?: unknown;
			code?: unknown;
			message?: unknown;
		};
		if (group === "user" && typeof code === "string" && typeof message === "string")
			throw new UserError(message, { code });
		throw clientError(c.log, error, "The agent could not be continued. Try again.");
	}
	const stacked = input.stack === true;
	if (stacked && !source.pushedBranch)
		throw new UserError("This agent has not pushed a branch yet, so there is nothing to stack on.", {
			code: "not_pushed",
		});
	const sessionId = `s_${randomBytes(8).toString("hex")}`;
	const copy = await copyAgentSession(await getLayer(), profile.uid, parent.id, sessionId, source);
	try {
		return await makeSession(c, profile, continuedInput(source, stacked), submission, undefined, {
			continued: {
				sessionId,
				effort: source.effort,
				continuation: {
					from: { id: parent.id, title: source.title, pull: source.pull, stacked },
					copy,
					// A machine's copy is made by the new session itself, over its own connection to the runner.
					machineCopy: source.place.kind === "machine" && source.copy ? { from: parent.id, ...source.copy } : null,
					// Kept beside a copy: should the copy not come back in the new sandbox, the agent still learns what came before.
					handoff: source.handoff,
					tainted: source.tainted,
					secretRequestBlocked: source.secretRequestBlocked,
				},
			},
		});
	} catch (error) {
		if (copy)
			await (await getLayer()).backups
				?.remove({ uid: profile.uid, sessionId })
				.catch(removal => console.warn(`[wlp] backup.remove_failed session=${sessionId}: ${errorText(removal)}`));
		throw error;
	}
}

async function makeSession(
	c: CreateCtx,
	profile: UserProfile,
	input: CreateSessionInput,
	submission: Submission | null,
	item?: ItemSessionInput,
	{
		build,
		readiness,
		continued,
	}: { build?: EnvironmentBuildOrigin; readiness?: SessionCreateInput["readiness"]; continued?: ContinuedSession } = {},
): Promise<SessionSummary> {
	const place = launchPlace(input.place);
	if (input.size !== undefined && ![1, 2, 4].includes(input.size))
		throw new UserError("Choose a sandbox size of 1, 2 or 4 slots.", { code: "bad_input" });
	const size = item?.size ?? input.size ?? 1;
	const harness = input.harness === undefined ? "windlass" : input.harness;
	if (knownHarness(harness) === null) throw new UserError("Choose an available harness.", { code: "bad_input" });
	// The ACP agent's record; null for Windlass.
	const acp = machineHarness(harness);
	const caps = capabilitiesOf(harness);
	// An ACP agent whose modes its profile decides, as far as the machine probed them (Codex's, codex-modes.ts).
	const profileModes = acp?.capabilities.modes === "profile";
	if (acp) {
		const notForItems = item ? itemHarnessProblem(harness) : null;
		if (notForItems) throw new UserError(notForItems, { code: "bad_input" });
		const agent = place.kind === "hosted" ? hostedHarness(acp.id) : acp;
		if (!agent.profiles.includes(input.profile))
			throw new UserError(
				`${agent.name} requires ${[...new Set(agent.profiles.map(isolationName))].join(" or ")} isolation here.`,
				{ code: "bad_input" },
			);
		const profileProblem = item ? itemProfileProblem(harness, input.profile) : null;
		if (profileProblem) throw new UserError(profileProblem, { code: "bad_input" });
		// Its publish comes over MCP, which any process in the container may reach (platform-tools.ts): it asks every time.
		if (input.publishUnasked) throw new UserError(publishAsksEveryTime(acp.name), { code: "bad_input" });
	}
	let repoUrl = cleanRepoUrl(input.repoUrl);
	const givenTitle = input.title === undefined || input.title === null ? null : cleanTitle(input.title);
	// A setup command is saved for a repository of the GitHub connection, and is checked before GitHub is asked anything.
	const setupCommand =
		input.setupCommand === undefined || input.setupCommand === null ? null : setupCommandOf(input.setupCommand);
	if (setupCommand !== null && (input.repository === undefined || input.repository === null)) {
		throw new UserError(
			"A setup command is saved for a repository of your GitHub connection. Choose one, or leave the setup command out.",
			{ code: "bad_input" },
		);
	}
	if (input.publishUnasked !== undefined && input.publishUnasked !== null && typeof input.publishUnasked !== "boolean")
		throw new UserError("Say yes or no to letting the agent publish without asking.", { code: "bad_input" });
	if (input.publishUnasked === true && (input.repository === undefined || input.repository === null)) {
		throw new UserError(
			"An agent can publish only to a repository of your GitHub connection. Choose one, or leave that setting off.",
			{ code: "bad_input" },
		);
	}
	// A repository of the user's GitHub connection: GitHub is asked now whether this user may read it.
	let repo: StoredRepository | null = null;
	if (item?.gitlab) {
		const { project, iid } = item.gitlab;
		const issue = Number(iid);
		repo = { ...project, installationId: project.id, ...(Number.isSafeInteger(issue) && { closesIssue: issue }) };
		repoUrl = project.url + ".git";
	} else if (input.repository !== undefined && input.repository !== null) {
		if (repoUrl !== null)
			throw new UserError("Choose a repository from GitHub or paste an address, not both.", { code: "bad_input" });
		const { id, branch } = input.repository;
		if (!isGithubId(id) || (branch !== undefined && branch !== null && !isBranchName(branch)))
			throw new UserError("Choose one of the listed repositories and one of its branches.", { code: "bad_input" });
		const app = requireGithub();
		try {
			const connection = requireConnection(c);
			const { installation, repository } = item?.issue
				? await resolveBoundRepository(app, connection, id, item.issue.installationId, "read")
				: await resolveRepository(app, connection, id, "read");
			repo = {
				provider: "github",
				id: repository.id,
				owner: repository.owner,
				name: repository.name,
				branch: branch ?? repository.defaultBranch,
				private: repository.private,
				url: app.repositoryUrl(repository.owner, repository.name),
				installationId: installation.id,
				...(item?.issue && { closesIssue: item.issue.number }),
			};
			repoUrl = app.cloneUrl(repository.owner, repository.name);
		} catch (error) {
			throw githubError(c.log, error, "The repository could not be checked at GitHub. Try again.");
		}
	}

	let summary: SessionSummary;
	try {
		const machine = place.kind === "machine" ? await launchMachineProfiles(c.db, c.key[0]!, place.machineId) : null;
		if (size > 1 && !machine?.slots)
			throw new UserError("Choose a machine reporting slots for a large sandbox.", { code: "bad_input" });
		if (repoUrl && machine?.egress === "none") throw new UserError(OFFLINE_REPOSITORY, { code: "bad_input" });
		if (repoUrl && place.kind === "hosted" && (await getLayer()).sandboxes.egress?.() === "none")
			throw new UserError(HOSTED_OFFLINE_REPOSITORY, { code: "bad_input" });
		const offered = machine?.harnesses?.find(entry => entry.id === harness);
		if (acp && machine && !offered)
			throw new UserError(`This machine does not offer ${acp.name}.`, { code: "bad_input" });
		// A work item is not watched: one filed on a machine whose agent is not known to be signed in would only fail at its first turn.
		const signedOut =
			item && acp && offered ? itemSignInMessage(acp, machine?.name ?? "your machine", offered.signIn) : null;
		if (signedOut) throw new UserError(signedOut, { code: "harness_signed_out" });
		const itemSignIn = item && acp?.itemTokens === "sign-in" ? (machine ? offered?.method : "api-key") : undefined;
		const methodProblem =
			item && machine && acp ? itemSignInMethodProblem(acp, machine?.name ?? "your machine", offered?.method) : null;
		if (methodProblem) throw new UserError(methodProblem, { code: "bad_input" });
		const hostedSize =
			place.kind === "hosted"
				? await sessionHostedSize(c, input.hostedSize, repo?.provider === "github" ? setupKeyOf(repo.id) : null, item)
				: undefined;
		const profiles = machine ? machine.profiles : (await getLayer()).sandboxes.profiles();
		const chosen = profiles.find(candidate => candidate.id === input.profile);
		if (!chosen) throw new UserError("That sandbox does not exist.", { code: "bad_profile" });
		if (!chosen.available) {
			throw new UserError(`${chosen.name} cannot be chosen yet. ${chosen.unavailableReason ?? ""}`.trim(), {
				code: "profile_unavailable",
			});
		}
		// A hosted ACP agent runs only on Settings keys (`hostedHarness`).
		if (!machine && acp && !chosen.platformKeys)
			throw new UserError("This hosted profile has no configured Settings-key relay.", { code: "profile_unavailable" });
		// Letting the agent publish unasked is for sandboxes whose commands cannot ask in its name.
		const unaskedProblem = repo && input.publishUnasked === true ? publishUnaskedProblem(commandSandbox(chosen)) : null;
		if (unaskedProblem !== null) throw new UserError(unaskedProblem, { code: "bad_input" });
		const catalog =
			offered?.optionsDigest && place.kind === "machine"
				? await machineCatalog(c, place.machineId, offered.id).catch(() => null)
				: undefined;
		if (offered?.optionsDigest && !catalog)
			throw new UserError("The machine’s current model list could not be read. Try again.", { code: "bad_input" });
		// A hosted agent's own model list comes from the Settings keys' checks (`hostedCatalog`).
		const credentials =
			place.kind === "hosted" && caps.models === "harness" ? await hostedCredentials(c.db, c.key[0]!) : undefined;
		const options = credentials ? hostedCatalog(harness, credentials) : availableCatalog(catalog ?? undefined, offered);
		// Where its commands run in its own sandbox, the machine must have probed that sandbox's modes.
		if (profileModes && acp.sandboxedOn.includes(chosen.id) && !offered?.modes?.includes("workspace-write"))
			throw new UserError(offered?.modeReason ?? innerModesReason, { code: "bad_input" });
		const modes = initialSessionModes(
			chosen.id,
			harness,
			!!item,
			profileModes ? codexModes(chosen.id, machine ? (offered?.modes ?? []) : undefined) : options?.modes,
		);
		if (input.mode !== undefined) {
			if (
				typeof input.mode !== "string" ||
				!input.mode.trim() ||
				(caps.modes === "profile" && !modes.availableModes.some(m => m.id === input.mode))
			)
				throw new UserError("Choose a mode offered by this agent.", { code: "bad_input" });
			modes.mode = input.mode;
		}
		// A build runs no agent, so it asks for no model list (and needs no sign-in): the stand-in names one.
		const models =
			caps.models === "harness"
				? initialHarnessModels(options ?? undefined)
				: build
					? standInModels("demo")
					: await modelsOf(c, profile.demo);
		const model = modelInput(() => chosenModel(models, input.model), options && machine ? "bad_input" : undefined);
		if (credentials && acp && !hostedPayer(acp.id, model, credentials))
			throw new UserError(hostedKeyMessage(harness, model), { code: "harness_signed_out" });
		// An item's effort runs every turn, unwatched: only one its agent reported is taken.
		if (item?.effort !== undefined)
			modelInput(() => checkItemEffort(models, model, item.effort, caps.models === "harness"));

		// Saved before the session exists, so that its first sandbox finds it. It stays if the session cannot be made.
		if (repo?.provider === "github" && setupCommand !== null)
			await saveSetup(c, profile.uid, setupKeyOf(repo.id), `${repo.owner}/${repo.name}`, setupCommand);

		let title = givenTitle ?? DEFAULT_TITLE;
		if (repo && build) title = `Prepare environment for ${repo.owner}/${repo.name}`;
		if (repo && readiness) title = `Check repository setup · ${repo.owner}/${repo.name}`;
		const now = Date.now();
		const itemRole = item && {
			role: item.role,
			subtaskScreenshots: item.subtaskScreenshots,
			...(item.planCritic && { planCritic: true as const }),
		};
		summary = {
			id: readiness?.attempt ?? item?.sessionId ?? continued?.sessionId ?? `s_${randomBytes(8).toString("hex")}`,
			title,
			place,
			harness,
			capabilities: sessionCapabilities(harness),
			profile: chosen.id,
			...(hostedSize && { hostedSize }),
			...modes,
			...(options && { harnessModels: models }),
			model,
			repoUrl,
			...(repo
				? {
						repository: {
							provider: repo.provider,
							id: repo.id,
							owner: repo.owner,
							name: repo.name,
							branch: repo.branch,
							private: repo.private,
							url: repo.url,
						},
						pullRequest: null,
						publishUnasked: input.publishUnasked === true,
					}
				: {}),
			createdAt: now,
			updatedAt: now,
			status: "idle",
			turns: 0,
			lastOutcome: null,
			sandbox: "none",
			...(item ? { item: { id: item.itemId, ...itemRole, ...(itemSignIn && { signIn: itemSignIn }) } } : {}),
			...(build && { environmentBuild: true as const }),
			...(readiness && { readiness: true as const }),
			...(continued && {
				effort: continued.effort,
				continuedFrom: { id: continued.continuation.from.id, title: continued.continuation.from.title },
			}),
		};
		await createSessionActor(c, profile.uid, summary.id, {
			...(item
				? {
						origin: {
							kind: "item" as const,
							itemId: item.itemId,
							...itemRole,
							...(item.afterPlanning && {
								afterPlanning: { ...item.afterPlanning, model: item.afterPlanning.model ?? models.defaultModel },
							}),
							...(item.owns && { owns: item.owns }),
							...(item.childBranch && { childBranch: item.childBranch }),
							...(size > 1 && { size }),
							...(item.effort && { effort: item.effort }),
							...(offered && {
								payer: "machine" as const,
								payerSource: "deployment" as const,
							}),
							...(itemSignIn && { signIn: itemSignIn }),
						},
					}
				: {}),
			...(!item && size > 1 && { size }),
			...(build && { environmentBuild: build }),
			...(readiness && { readiness }),
			...(hostedSize && { hostedSize }),
			// The clone and the pull request's base follow `repo.branch`: the default branch, or the stacked-on session's.
			...(continued &&
				repo && {
					effort: continued.effort,
					continuation: {
						...continued.continuation,
						from: { ...continued.continuation.from, base: repo.branch },
					},
				}),
			title: summary.title,
			titleIsTyped: !item && (givenTitle !== null || !!readiness || !!build),
			place: summary.place,
			harness,
			...(machine ? { machineName: machine.name } : {}),
			profile: summary.profile,
			// An item's session takes its profile's mode for its agent in the actor (`itemModeOf`): none is passed for it.
			...(!item && { mode: profileModes ? modes.mode : input.mode }),
			...(profileModes && { codexModes: modes.availableModes }),
			...(options && { harnessOptions: options }),
			model,
			repoUrl,
			repo,
			publishUnasked: repo !== null && input.publishUnasked === true,
			demo: caps.demo && profile.demo,
			createdAt: now,
		}).catch(async (error: unknown) => {
			// An item's session has an id derived from its item's: one that exists is the one an earlier try made.
			if (!item || !isDuplicateKey(error)) throw error;
			summary = await sessionActor(c, profile.uid, item.sessionId).internalSummary();
		});
	} catch (error) {
		throw clientError(c.log, error, "The agent could not be created. Try again.");
	}

	// In one step with the session: from here a `createSession` with this key answers with it.
	c.vars.sessions.set(summary.id, summary);
	if (submission) c.vars.created.set(submission.key, { ...submission, id: summary.id });
	await storeSession(c, summary, submission);
	broadcastSessions(c);
	return summary;
}

/**
 * The models a subtask's agent may choose, by the lists `makeSession` holds a session to: the account's
 * for Windlass, each machine harness's catalog (or only its default where its runner reported none).
 * An unread digest stays absent so placement can wait or try another machine.
 */
export async function agentModels(c: CreateCtx & { key: string[] }): Promise<AgentModels> {
	const profile = c.vars.profile;
	const [windlass, machines] = await Promise.all([
		profile ? modelsOf(c, profile.demo).catch(() => null) : null,
		machineModelLists(c, [...c.vars.machines.values()], id => machineHarnesses[id].subtasks),
	]);
	return { windlass, machines };
}

/** An alarm, a trigger and a quick session result can all arrive while a build is being started. */
const environmentWrites = new WeakMap<UserVars, Promise<unknown>>();
function changeEnvironments<T>(c: EnvironmentCtx, work: (host: EnvironmentHost) => Promise<T>): Promise<T> {
	const next = (environmentWrites.get(c.vars) ?? Promise.resolve()).then(() => work(environmentHost(c)));
	environmentWrites.set(
		c.vars,
		next.catch(() => undefined),
	);
	return next;
}

/** An action's context, as prepared environments need it: sessions can be made and the actor woken later. */
interface EnvironmentCtx extends CreateCtx {
	schedule: {
		at(at: number, action: string, ...args: unknown[]): Promise<unknown>;
		list(): Promise<{ action: string; runAt: number }[]>;
	};
}

async function cleanRunDefaults(
	c: CreateCtx,
	input: AccountDefaultsPatch | RepositoryDefaultsPatch,
	profile: UserProfile,
) {
	const layer = await getLayer();
	return cleanDefaults(
		input,
		layer.sandboxes.profiles(),
		await modelsOf(c, profile.demo),
		sizesOf(c, layer).map(size => size.id),
		itemMachines(c.vars.machines),
	);
}

async function applyPlaceChange(
	change: DefaultsChange,
	input: ItemPlaceDefaults,
	machines: Map<string, MachineSummary>,
	read: () => Promise<ItemPlaceDefaults>,
) {
	if (!changesPlace(input)) return;
	const policy = changedPlace(await read(), input);
	const problem = placeProblem(policy, itemMachines(machines));
	if (problem) throw new UserError(problem, { code: "bad_input" });
	change.item_place = policy;
}

async function forgetSession(c: UserCtx, id: string): Promise<void> {
	await c.db.execute("DELETE FROM session_secret_grant WHERE session_id = ?", id);
	await c.db.execute("DELETE FROM requested_secret_receipt WHERE session_id = ?", id);
	await c.db.execute("DELETE FROM sessions WHERE id = ?", id);
	c.vars.sessions.delete(id);
	c.vars.launchUntil.delete(id);
	c.vars.launchClaim.delete(id);
	for (const [key, made] of c.vars.created) if (made.id === id) c.vars.created.delete(key);
	broadcastSessions(c);
}

async function removeSession(c: CreateCtx, uid: string, id: string): Promise<void> {
	if (!c.vars.sessions.delete(id)) return;
	try {
		await sessionActor(c, uid, id).internalDestroy();
	} catch (error) {
		if (!isSessionGone(error))
			c.log.error({ msg: "a build session could not be removed", session: id, error: String(error) });
	}
	await forgetSession(c, id);
}

async function retireDrafters(c: CreateCtx, uid: string, project: string) {
	const [active] = await c.db.execute(
		"SELECT 1 FROM readiness WHERE project=? AND judgment IS NULL AND error IS NULL AND at>? LIMIT 1",
		project,
		Date.now() - SETUP_LEASE_MS,
	);
	if (active) return;
	const waiting = new Set(
		(
			await c.db.execute<{ drafter: string }>(
				"SELECT DISTINCT drafter FROM setup_notes WHERE project=? AND expires>? AND drafter IS NOT NULL",
				project,
				Date.now(),
			)
		).map(r => r.drafter),
	);
	for (const s of c.vars.sessions.values()) {
		if (
			s.readiness &&
			s.repository &&
			setupKeyOf(s.repository.id) === project &&
			s.status === "idle" &&
			!waiting.has(s.id)
		)
			await removeSession(c, uid, s.id);
	}
}

async function assessRepository(
	c: CreateCtx,
	profile: UserProfile,
	id: GithubId,
	session = "s_" + randomBytes(8).toString("hex"),
	selected?: string[],
	answers?: Record<string, "keep" | "drop">,
) {
	const project = setupKeyOf(id);
	if (!(await claimAssessment(c.db, project, session, Date.now()))) return;
	try {
		const scan = await refreshSetupScan(c, id, project);
		if (!scan.commit) throw new UserError("Add a first commit before finishing setup.", { code: "bad_input" });
		const inputs = await setupInputs(
			c.db,
			project,
			scan,
			(await readSetup(c.db, project)).command,
			(await readChecks(c.db, project)).checks,
		);
		const repoDefaults = await readDefaults(c.db, project),
			account = await readAccountDefaults(c.db);
		const run = resolveRun({ account, repository: repoDefaults }, "setup");
		const destination = checkRunPlace(run, itemMachines(c.vars.machines));
		if (destination.wait) throw new UserError(destination.wait, { code: "place_unavailable" });
		let profileId = destination.profile;
		if (destination.place.kind === "hosted") {
			const profiles = (await getLayer()).sandboxes.profiles().filter(p => p.available);
			profileId = run.profile ?? profiles[0]?.id;
		}
		if (!profileId) throw new UserError("The usual place for this repository is unavailable.", { code: "bad_profile" });
		let draft: DraftRequest | undefined;
		if (selected) {
			const { notes, publication } = await setupKnowledge(c.db, profile.uid, project);
			if (
				!Array.isArray(selected) ||
				selected.length > 200 ||
				selected.some(id => !notes.some(n => n.id === id)) ||
				new Set(selected).size !== selected.length
			)
				throw new UserError("A selected note is unavailable.", { code: "bad_input" });
			if (
				answers &&
				Object.entries(answers).some(
					([id, answer]) =>
						!selected.includes(id) ||
						!notes.find(n => n.id === id)?.decision?.question ||
						!["keep", "drop"].includes(answer),
				)
			)
				throw new UserError("Choose an answer for a current question.", { code: "bad_input" });
			draft = { areas: scan.areas, later: scan.later, noteIds: selected, previous: publication, answers };
		}
		await c.db.execute("UPDATE readiness SET inputs=? WHERE session=?", inputs.key, session);
		const prompt = readinessPrompt(inputs.evidence, draft);
		const readiness = {
			attempt: session,
			commit: scan.commit,
			draft,
			model: run.model ?? undefined,
			effort: run.effort ?? undefined,
		};
		const firstAnswer = answers && Object.keys(answers)[0];
		if (firstAnswer) {
			const [pending] = await c.db.execute<{ drafter: string | null }>(
				"SELECT drafter FROM setup_notes WHERE project=? AND id=?",
				project,
				firstAnswer,
			);
			if (!pending?.drafter || !c.vars.sessions.has(pending.drafter))
				throw new UserError("The setup session has ended. Run setup again.", { code: "bad_input" });
			await sessionActor(c, profile.uid, pending.drafter).internalAssessRepository(prompt, readiness);
			return;
		}
		await makeSession(
			c,
			profile,
			{
				repository: { id },
				place: destination.place,
				profile: profileId,
				model: run.model ?? undefined,
				...(run.sources.size !== "deployment" && destination.place.kind === "hosted" && { hostedSize: run.size }),
			},
			null,
			undefined,
			{ readiness },
		);
		await sessionActor(c, profile.uid, session).internalAssessRepository(prompt);
	} catch (error) {
		await finishAssessment(
			c.db,
			session,
			error instanceof UserError ? error.message : "The setup check could not start.",
		);
		await removeSession(c, profile.uid, session);
		throw error;
	}
}

function environmentHost(c: EnvironmentCtx): EnvironmentHost {
	const uid = c.vars.profile?.uid ?? "";
	return {
		db: c.db,
		uid,
		now: () => Date.now(),
		sessions: () => [...c.vars.sessions.values()].filter(s => !s.readiness),
		machines: () => listMachines(c),
		saved: async project => {
			const setup = await setupRow(c.db, project);
			const [{ n }] = await c.db.execute<{ n: number }>(
				"SELECT count(*) AS n FROM repo_secret WHERE project = ?",
				project,
			);
			const [label] = await c.db.execute<{ label: string }>(
				"SELECT label FROM setup_command WHERE project = ?",
				project,
			);
			const { sandboxes } = await getLayer();
			const offered = hostedSizesForPlan(sandboxes.sizes?.() ?? [], accountLimits(c.vars.items.limits).plan);
			const deployment = {
				profile: sandboxes.profiles().find(p => p.available)?.id,
				hostedSize: deploymentSize(offered.map(s => s.id)),
			};
			return {
				command: setup?.command ?? "",
				checks: (await readChecks(c.db, project)).checks,
				secrets: n,
				deployment,
				account: await readAccountDefaults(c.db),
				defaults: await readDefaults(c.db, project),
				label: label?.label ?? project,
			};
		},
		dependenciesChanged: async (repositoryId, since) => {
			const app = requireGithub();
			const { installation, repository } = await resolveRepository(
				app,
				requireConnection(c),
				githubId(repositoryId)!,
				"read",
			);
			return app.withToken(
				installation.id,
				{ repositoryId: repository.id, permissions: { metadata: "read", contents: "read" } },
				async token => {
					const inputs = (revision: string) =>
						app.setupInputs(token, repository.owner, repository.name, revision, false);
					const [previous, current] = await Promise.all([inputs(since), inputs(repository.defaultBranch)]);
					return previous.dependencies !== current.dependencies;
				},
				{ revokeAfter: true },
			);
		},
		snapshots: { hosted: snapshotsFor({ kind: "hosted" }), machines: snapshotsFor({ kind: "machine" }) },
		hostedUserMax: config.hosted?.snapshots?.maxPerUser ?? null,
		createBuild: async request => {
			const profile = c.vars.profile;
			if (!profile) throw new Error("Sign in again so the platform can build environments.");
			const place =
				request.place === HOSTED ? { kind: "hosted" as const } : { kind: "machine" as const, machineId: request.place };
			let summary: SessionSummary;
			try {
				summary = await makeSession(
					c,
					profile,
					{
						place,
						profile: request.profile,
						hostedSize: request.hostedSize,
						repository: { id: githubId(request.repositoryId) ?? request.repositoryId },
					},
					null,
					undefined,
					{ build: { project: request.project, place: request.place, screenshots: request.screenshots } },
				);
			} catch (error) {
				throw new Error(error instanceof UserError ? error.message : "The build's sandbox could not be made.");
			}
			return summary.id;
		},
		runBuild: async session => {
			try {
				await sessionActor(c, uid, session).internalBuildEnvironment();
			} catch (error) {
				const said = error as { group?: string; message?: string } | null;
				if (!isSessionGone(error) && said?.group === "user" && typeof said.message === "string")
					throw new BuildStartRefused(said.message);
				throw error;
			}
		},
		removeSession: id => removeSession(c, uid, id),
		watchPushes: async repositoryId => {
			await c
				.client()
				.githubRepository.getOrCreate([repositoryId], { params: serviceParams() })
				.internalWatchPushes(uid)
				.catch(() => undefined);
		},
		arm: async at => {
			// One alarm is enough: another is set only for a time before the one that is set.
			const alarms = await c.schedule.list();
			if (alarms.some(a => a.action === "internalEnvironmentTick" && a.runAt > Date.now() && a.runAt <= at)) return;
			await c.schedule.at(at, "internalEnvironmentTick");
		},
	};
}

/** `makeSession` for an item's session, as user-items.ts asks for it, with the action's own context. */
function itemSession(c: CreateCtx): MakeSession {
	return Object.assign(
		(profile: UserProfile, input: CreateSessionInput, item: ItemSessionInput) =>
			makeSession(c, profile, input, null, item),
		{
			accountModels: (demo: boolean) => modelsOf(c, demo),
		},
	);
}

type RevocationContext = UserCtx & {
	key: string[];
	client(): unknown;
	conns: Parameters<typeof disconnectRevoked>[0];
	schedule: { after(ms: number, action: string, attempt: number): Promise<string> };
	log: { warn(entry: unknown): void };
};

const RETRY_DISCONNECT = "retryDisconnectRevoked";

// Six durable retries, starting after 30 seconds and ending with a 15-minute delay.
const DISCONNECT_DELAYS = [30_000, 60_000, 120_000, 240_000, 480_000, 900_000];

async function closeRevokedFeeds(c: RevocationContext, generation: number, lastTry: boolean): Promise<void> {
	let userFeedsFailed = false;
	try {
		await disconnectRevoked(c.conns, generation);
	} catch {
		userFeedsFailed = true;
	}
	// Only the session itself knows which sockets it has. Checkpoint each batch so a retry or
	// actor restart visits only outstanding sessions. A newer generation owns its own marks.
	const sessions = await c.db.execute<{ id: string }>(
		"SELECT id FROM sessions WHERE disconnect_pending = ?",
		generation,
	);
	let failed = 0;
	for (let i = 0; i < sessions.length; i += 16) {
		if (generation < c.vars.tokenGen) return;
		const closed = await Promise.all(
			sessions.slice(i, i + 16).map(async ({ id }) => {
				try {
					await sessionActor(c, c.key[0], id).internalDisconnectRevoked(generation);
				} catch (error) {
					if (!isSessionGone(error)) return null;
				}
				return id;
			}),
		);
		const done = closed.filter(id => id !== null);
		failed += closed.length - done.length;
		if (done.length)
			await c.db.execute(
				"UPDATE sessions SET disconnect_pending = 0 WHERE disconnect_pending = ? AND id IN (SELECT value FROM json_each(?))",
				generation,
				JSON.stringify(done),
			);
	}
	if (!userFeedsFailed && failed === 0) {
		await c.db.execute("UPDATE token_generation SET disconnected = ? WHERE id = 1 AND gen = ?", generation, generation);
	} else {
		c.log.warn({
			msg: lastTry ? "Revoked feed disconnect retries exhausted" : "Retrying revoked feed disconnects",
			generation,
			failedSessions: failed,
			userFeedsFailed,
		});
	}
}

function sweep(c: RevocationContext, generation: number, lastTry = false): Promise<void> {
	// The timer is already armed. If it fired during a slow pass, wait for that pass to
	// checkpoint its successes before looking up the remaining sessions.
	const previous = c.vars.disconnectSweep ?? Promise.resolve();
	const run = previous.catch(() => undefined).then(() => closeRevokedFeeds(c, generation, lastTry));
	c.vars.disconnectSweep = run;
	return run.finally(() => {
		if (c.vars.disconnectSweep === run) c.vars.disconnectSweep = undefined;
	});
}

async function revokeTokens(c: RevocationContext, revokeApiTokens = false): Promise<void> {
	// Arm recovery before committing the bump, including when the actor stops between the two writes.
	const job = await c.schedule.after(DISCONNECT_DELAYS[0], RETRY_DISCONNECT, 1);
	const gen = await c.db.transaction(async tx => {
		if (revokeApiTokens) await tx.execute("DELETE FROM api_token");
		const [row] = await tx.execute<{ gen: number }>(
			"UPDATE token_generation SET gen = gen + 1, disconnect_job = ? WHERE id = 1 RETURNING gen",
			job,
		);
		await tx.execute("UPDATE sessions SET disconnect_pending = ?", row.gen);
		return row.gen;
	});
	c.vars.tokenGen = Math.max(c.vars.tokenGen, gen);
	c.vars.reached = true;
	await sweep(c, gen);
}

async function loadUserState(c: { key: string[]; db: RawAccess }): Promise<UserVars> {
	const [{ gen }] = await c.db.execute<{ gen: number }>("SELECT gen FROM token_generation WHERE id = 1");
	const [row] = await c.db.execute<{ uid: string; email: string | null; demo: number }>(
		"SELECT uid, email, demo FROM profile WHERE id = 1",
	);
	const rows = await c.db.execute<{
		summary: string;
		key: string | null;
		sent: string | null;
		launch_until: number | null;
		launch_claim: number | null;
	}>("SELECT summary, key, sent, launch_until, launch_claim FROM sessions");
	const launchUntil = new Map<string, number>();
	const launchClaim = new Map<string, number>();
	const [counter] = await c.db.execute<{ last: number }>("SELECT last FROM launch_counter WHERE id = 1");
	const sessions = new Map<string, SessionSummary>();
	const created = new Map<string, Submission & { id: string }>();
	for (const { summary, key, sent, launch_until, launch_claim } of rows) {
		// A summary stored before it carried its agent's capabilities, or with those of an older build, takes this build's.
		const parsed = { ...(JSON.parse(summary) as SessionSummary) };
		parsed.capabilities = sessionCapabilities(parsed.harness);
		sessions.set(parsed.id, parsed);
		if (launch_until !== null) launchUntil.set(parsed.id, launch_until);
		if (launch_until !== null && launch_claim !== null) launchClaim.set(parsed.id, launch_claim);
		if (key !== null && sent !== null) created.set(key, { key, sent, id: parsed.id });
	}
	// An actor that holds a sign-in is a user's, also before that user's own token was seen here.
	const [held] = await c.db.execute<{ provider: string }>("SELECT provider FROM model_plan WHERE provider = 'openai'");
	const [connected] = await c.db.execute<{ connection: string }>("SELECT connection FROM github WHERE id = 1");
	const github = connected ? (JSON.parse(connected.connection) as StoredConnection) : null;
	const approvals = new ApprovalBook(await readApprovals(c.db), config.serverApprovalTtlMs);
	const items = await loadItems(c.db);
	items.limits.billing = billing(c.key[0]!) ? await readBilling(c.db) : null;
	return {
		tokenGen: gen,
		profile: row ? { uid: row.uid, email: row.email, demo: row.demo === 1 } : null,
		reached: gen > 0 || row !== undefined || held !== undefined,
		sessions,
		launchUntil,
		launchClaim,
		launchGen: counter?.last ?? 0,
		created,
		creating: new Attempts(),
		signIn: null,
		signInDb: null,
		approvals,
		github,
		githubWriting: Promise.resolve(),
		models: new AccountModels({ uid: c.key[0]! }),
		usage: await readUsage(c.db, accountLimits(items.limits).usage, sessions),
		overageReport: Promise.resolve(),
		checkout: new AccountCheckout(),
		keptGeneration: 0,
		listed: null,
		machines: new Map((await listMachines({ db: c.db, key: c.key, vars: { sessions } })).map(m => [m.machineId, m])),
		items,
	};
}

export const user = actor({
	options: { name: "User", icon: "user", actionTimeout: 180_000 },

	db: db({
		onMigrate: async db => {
			await db.execute(
				"CREATE TABLE IF NOT EXISTS token_generation (id INTEGER PRIMARY KEY CHECK(id = 1), gen INTEGER NOT NULL)",
			);
			await db.execute("INSERT OR IGNORE INTO token_generation (id, gen) VALUES (1, 0)");
			await db.execute(`
				CREATE TABLE IF NOT EXISTS profile (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					uid TEXT NOT NULL,
					email TEXT,
					demo INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`);
			await db.execute(`
				CREATE TABLE IF NOT EXISTS sessions (
					id TEXT PRIMARY KEY,
					created_at INTEGER NOT NULL,
					summary TEXT NOT NULL,
					key TEXT,
					sent TEXT,
					launch_until INTEGER,
					launch_claim INTEGER
				)
			`);
			// The in-page ChatGPT sign-in's pending attempt. One-time: remove after the first deploy that runs it.
			await db.execute("DROP TABLE IF EXISTS model_attempt");
			// Only installation metadata is stored here. Each GitHub request uses its own scoped token.
			await db.execute(`
				CREATE TABLE IF NOT EXISTS github (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					connection TEXT NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`);
			for (const table of jira.JIRA_TABLES) await db.execute(table);
			for (const table of SLACK_TABLES) await db.execute(table);
			for (const table of IDENTITY_TABLES) await db.execute(table);
			for (const table of LINEAR_TABLES) await db.execute(table);
			await db.execute("DROP TABLE IF EXISTS github_grant");
			await db.execute(GITHUB_SYNC_TABLE);
			// Consumed tickets stay until expiry to prevent replay.
			await db.execute(`
				CREATE TABLE IF NOT EXISTS github_nonce (
					nonce TEXT PRIMARY KEY,
					kind TEXT NOT NULL,
					verifier TEXT,
					expires_at INTEGER NOT NULL
				)
			`);
			await db.execute(`
				CREATE TABLE IF NOT EXISTS server_approval (
					project TEXT NOT NULL,
					name TEXT NOT NULL,
					fingerprint TEXT NOT NULL,
					label TEXT NOT NULL,
					approved_at INTEGER NOT NULL,
					expires_at INTEGER NOT NULL,
					PRIMARY KEY (project, name, fingerprint)
				)
			`);
			await db.execute(`
				CREATE TABLE IF NOT EXISTS setup_command (
					project TEXT PRIMARY KEY,
					label TEXT NOT NULL,
					command TEXT NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`);
			// Bind ciphertext to the user, repository and secret name.
			await db.execute(`
				CREATE TABLE IF NOT EXISTS repo_secret (
					project TEXT NOT NULL,
					name TEXT NOT NULL,
					label TEXT NOT NULL,
					scope TEXT NOT NULL,
					sealed TEXT NOT NULL,
					updated_at INTEGER NOT NULL,
					PRIMARY KEY (project, name)
				)
			`);
			await db.execute(DEFAULTS_TABLE);
			await migrateDefaults(db);
			await db.execute(CHECKS_TABLE);
			await db.execute(NETWORK_TABLE);
			await db.execute(REQUESTS_TABLE);
			await db.execute(MODELS_TABLE);
			await db.execute(PERSONAL_SERVERS_TABLE);
			await db.execute(ACCOUNT_SECRETS_TABLE);
			for (const table of CREDENTIAL_TABLES) await db.execute(table);
			await db.execute(PAY_WITH_TABLE);
			await db.execute(PAY_ONCE_TABLE);
			await db.execute(
				"CREATE TABLE IF NOT EXISTS requested_secret_receipt (session_id TEXT PRIMARY KEY, request_id TEXT NOT NULL)",
			);
			await db.execute(
				"CREATE TABLE IF NOT EXISTS session_secret_grant (session_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(session_id, name))",
			);
			// Before the column checks below: the API token table is one of them.
			for (const table of ITEM_TABLES) await db.execute(table);
			await db.execute(READINESS_TABLE);
			await db.execute(
				"CREATE TABLE IF NOT EXISTS setup_offer(project TEXT, offer TEXT, earned INTEGER, off INTEGER, PRIMARY KEY(project,offer))",
			);
			for (const [table, column, definition] of [
				["readiness", "diagnosis", "TEXT"],
				["token_generation", "disconnected", "INTEGER NOT NULL DEFAULT 0"],
				["token_generation", "disconnect_job", "TEXT"],
				["sessions", "disconnect_pending", "INTEGER NOT NULL DEFAULT 0"],
				["api_token", "window_count", "INTEGER NOT NULL DEFAULT 0"],
				["sessions", "launch_claim", "INTEGER"],
				["setup_command", "snapshot_connection", "INTEGER"],
				["model_provider", "windlass_models", "TEXT"],
				...MODEL_PLAN_COLUMNS,
			] as const) {
				const columns = await db.execute<{ name: string }>(`PRAGMA table_info(${table})`);
				if (columns.some(found => found.name === column)) continue;
				await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
				if (column === "disconnect_pending") {
					// A pre-upgrade sweep has a timer but no per-session checkpoints yet.
					await db.execute(
						"UPDATE sessions SET disconnect_pending = (SELECT gen FROM token_generation WHERE id = 1) WHERE EXISTS (SELECT 1 FROM token_generation WHERE gen > disconnected)",
					);
				}
			}
			// One-time: remove after the first deploy that runs it.
			await moveSignInToPlan(db);
			// Where a post-setup snapshot of a project was last saved (`internalSnapshotSaved`), for placement's snapshot bonus.
			await db.execute(
				"CREATE TABLE IF NOT EXISTS snapshot_place (project TEXT NOT NULL, place TEXT NOT NULL, saved_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, connected_at INTEGER NOT NULL, PRIMARY KEY (project, place))",
			);
			// The last launch claim's generation (`UserVars.launchClaim`): kept on its own, so that it only ever grows.
			await db.execute(ENVIRONMENT_TABLE);
			await db.execute(
				"CREATE TABLE IF NOT EXISTS setup_scan (project TEXT PRIMARY KEY, at INTEGER NOT NULL, scan TEXT NOT NULL)",
			);
			await db.execute(NOTES_TABLE);
			await db.execute(PUBLICATION_TABLE);
			await db.execute("CREATE INDEX IF NOT EXISTS readiness_project ON readiness(project,at DESC)");
			await db.execute(ENVIRONMENT_SCHEDULE_TABLE);
			await db.execute(
				"CREATE TABLE IF NOT EXISTS launch_counter (id INTEGER PRIMARY KEY CHECK (id = 1), last INTEGER NOT NULL)",
			);
			await db.execute(`
				CREATE TABLE IF NOT EXISTS backup_removal (
					session TEXT PRIMARY KEY,
					tries INTEGER NOT NULL,
					due_at INTEGER NOT NULL,
					schedule_id TEXT NOT NULL,
					machine TEXT
				)
			`);
			// A machine session's copy is on its machine: the removal is recorded with that machine's actor.
			const removalColumns = await db.execute<{ name: string }>("PRAGMA table_info(backup_removal)");
			if (!removalColumns.some(found => found.name === "machine"))
				await db.execute("ALTER TABLE backup_removal ADD COLUMN machine TEXT");
			// A unique hold makes settlement idempotent.
			await db.execute(`
				CREATE TABLE IF NOT EXISTS usage_entry (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					day INTEGER NOT NULL,
					session TEXT NOT NULL,
					hold TEXT NOT NULL UNIQUE,
					kind TEXT NOT NULL,
					seconds INTEGER NOT NULL,
					at INTEGER NOT NULL,
					note TEXT
				)
			`);
			// Preserve the opening instant for period attribution without changing the usage ledger.
			await db.execute(
				"CREATE TABLE IF NOT EXISTS usage_start (hold TEXT PRIMARY KEY, day INTEGER NOT NULL, started_at INTEGER NOT NULL)",
			);
			await db.execute("CREATE INDEX IF NOT EXISTS usage_entry_day ON usage_entry (day)");
			await db.execute(`
				CREATE TABLE IF NOT EXISTS usage_hold (
					session TEXT PRIMARY KEY,
					id TEXT NOT NULL,
					day INTEGER NOT NULL,
					seconds INTEGER NOT NULL,
					started_at INTEGER NOT NULL,
					expires_at INTEGER NOT NULL
				)
			`);
			// Null on holds and entries written before the monthly meter recorded weights.
			for (const table of ["usage_entry", "usage_hold"]) {
				const columns = await db.execute<{ name: string }>(`PRAGMA table_info(${table})`);
				if (!columns.some(column => column.name === "weight"))
					await db.execute(`ALTER TABLE ${table} ADD COLUMN weight REAL`);
			}
			await db.execute("CREATE TABLE IF NOT EXISTS kept_sandbox (session TEXT PRIMARY KEY, since INTEGER NOT NULL)");
			await machineTables(db);
			// Windlass's ChatGPT limits are the ChatGPT plan's now (provider-accounts.ts `accountLocation`). One-time: remove after the first deploy that runs it.
			await moveWindlassLimits(db);
			await billingTables(db);
		},
	}),

	createVars: loadUserState,
	// Actions do not receive the handshake request. Retain its origin for OAuth ticket redemption.
	createConnState: c => ({ origin: c.request?.headers.get("origin") ?? null }),

	events: {
		machineHost: event<MachineHostUpdate>({ canSubscribe: c => maySubscribe(c) }),
		machines: event<MachineSummary[]>({ canSubscribe: c => maySubscribe(c) }),
		sessions: event<SessionSummary[]>({ canSubscribe: c => maySubscribe(c) }),
		usage: event<UsageNumbers>({ canSubscribe: c => maySubscribe(c) }),
		items: event<ItemSummary[]>({ canSubscribe: c => maySubscribe(c) }),
	},

	onBeforeConnect: (c, params: ConnParams | undefined) => {
		assertOrigin(c);
		try {
			const caller = userActorCaller(c, params);
			if (caller.kind === "user") {
				c.vars.reached = true;
				if (c.vars.profile === null) return writeActorProfile(c, caller.profile, false);
			}
		} catch (error) {
			c.vars.refused = true;
			throw error;
		}
	},

	// Destroying an unused getOrCreate actor during the handshake can cut off its auth error frame.
	onSleep: c => {
		if (c.vars.refused && !c.vars.reached && c.vars.sessions.size === 0) c.destroy();
	},
	onDestroy: async c => {
		await dropHostedSnapshots(c.key[0]);
	},
	onWake: async c => {
		queueOverageReport(c);
		if (c.vars.profile)
			void c.keepAwake(
				changeEnvironments(c, wakeEnvironments).catch(error =>
					c.log.warn({ msg: "could not recover environment builds", error: String(error) }),
				),
			);
		// Backfill saved connections on upgrade and repair a grant interrupted after the local write.
		const connection = c.vars.github;
		if (connection && githubConfig().webhook) {
			try {
				// A series whose next try was set and not stored would block every later one: wake starts afresh.
				await c.db.execute("DELETE FROM github_sync");
				await syncGithubWebhooks(c, c.key[0]);
			} catch {
				console.warn(`github.installations.sync_failed uid=${c.key[0]}`);
			}
		}
		queueChanged(c);
		await notifyRemovedMachines(c);
		await notifyProviderWaits(c, c.vars.items.items.values());
		// A try whose next schedule was set and not stored, because the server stopped in between, is set again.
		try {
			const late = await c.db.execute<{ session: string; tries: number; machine: string | null }>(
				"SELECT session, tries, machine FROM backup_removal WHERE due_at < ?",
				Date.now() - BACKUP_REMOVE_LATE_MS,
			);
			for (const { session, tries, machine } of late) await armBackupRemoval(c, session, tries, machine);
		} catch (error) {
			c.log.warn({ msg: "could not set the removal of deleted sessions' copies again", error: String(error) });
		}
	},

	actions: {
		[RETRY_DISCONNECT]: async (c, attempt = 1): Promise<void> => {
			if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
			const [pending] = await c.db.execute<{ gen: number; disconnect_job: string | null }>(
				"SELECT gen, disconnect_job FROM token_generation WHERE gen > disconnected AND (disconnect_job = ? OR disconnect_job IS NULL)",
				c.scheduledFire.id,
			);
			if (!pending) return;
			const delay = DISCONNECT_DELAYS[attempt];
			// Arm recovery before the pass. Superseded jobs and duplicate deliveries do no work.
			const next = delay === undefined ? "exhausted" : await c.schedule.after(delay, RETRY_DISCONNECT, attempt + 1);
			const claimed = await c.db.execute(
				"UPDATE token_generation SET disconnect_job = ? WHERE gen = ? AND gen > disconnected AND disconnect_job IS ? RETURNING gen",
				next,
				pending.gen,
				pending.disconnect_job,
			);
			if (claimed.length) await sweep(c, pending.gen, delay === undefined);
		},
		linkedLogins: signinActions.linkedLogins,
		unlinkLogin: signinActions.unlinkLogin,
		internalLogin: signinActions.internalLogin,
		internalTokenGeneration: (c): number => {
			requireServiceFor(c, "call");
			return c.vars.tokenGen;
		},
		signOutEverywhere: async (c, options?: { revokeApiTokens: boolean }): Promise<void> => {
			requireUser(c);
			await revokeTokens(c, options?.revokeApiTokens === true);
		},
		internalLimitHistory: async (c, operator: string, before?: number) => {
			requireServiceFor(c, limitsSubject(c.key[0]!, operator));
			return c.db.execute<LimitAuditRow>(
				"SELECT id, at, operator, setting, old_value, new_value, overrides FROM limit_changes WHERE id < ? ORDER BY id DESC LIMIT 100",
				before ?? Number.MAX_SAFE_INTEGER,
			);
		},
		internalSetLimit: async (c, change: LimitChange) => {
			const result = await changeUserLimit(c, change);
			if (result.id >= c.vars.items.limits.id) {
				c.vars.items.limits = { ...result, billing: c.vars.items.limits.billing };
				Object.assign(c.vars.usage.limits, accountLimits(c.vars.items.limits).usage);
				c.broadcast("usage", c.vars.usage.numbers(Date.now()));
				queueChanged(c);
			}
			return accountLimits(c.vars.items.limits);
		},
		internalHostedSizes: async (c): Promise<HostedSize[]> => {
			requireService(c);
			return sizesOf(c, await getLayer()).map(size => size.id);
		},

		internalDailyTokenWait: c => {
			requireServiceFor(c, "call");
			return accountTokenWait(c);
		},
		internalRecordTurnTokens: async (c, input: { sessionId: string; receipt: TokenReceipt }) => {
			requireServiceFor(c, "call");
			// The session can already be out of the index while its deletion settles its last receipt.
			const inserted = await recordTurnTokens(c.db, input.sessionId, input.receipt);
			if (!input.receipt.key) {
				const { at } = input.receipt;
				c.vars.usage.noteModelTokens(at, await tokensOn(c.db, at));
				if (inserted && accountTokenWait(c)) queueChanged(c);
			}
			if (inserted) c.broadcast("usage", c.vars.usage.numbers(Date.now()));
		},
		internalRevokeTokens: async (c): Promise<void> => {
			requireServiceFor(c, "revoke:" + c.key[0]);
			await revokeTokens(c);
		},
		machines: machineActions.machines,
		machineCatalog: machineActions.machineCatalog,
		claimMachine: machineActions.claimMachine,
		confirmMachine: machineActions.confirmMachine,
		denyMachine: machineActions.denyMachine,
		removeMachine: machineActions.removeMachine,
		removeMachineClaudeLogin: machineActions.removeMachineClaudeLogin,
		internalProviderGeneration: (c, location: AccountLocation) => {
			requireServiceFor(c, "call");
			return loginGeneration(c.db, location);
		},

		internalObserveUsage: async (c, location: AccountLocation, generation: string, observation: UsageObservation) => {
			requireServiceFor(c, "call");
			if (await recordProviderUsage(c.db, location, generation, observation)) {
				if (c.vars.machines.size && (location.harness === "windlass" || location.place !== "hosted"))
					await machinesChanged(c);
				queueChanged(c);
			}
		},
		/** A connected plan's status and window snapshot (a turn's share of the plan is the snapshots' difference). */
		internalPlanStatus: async (c, provider: PlanProvider): Promise<ModelPlanStatus | null> => {
			requireServiceFor(c, "call");
			return (await planStatuses(c.db)).find(plan => plan.provider === provider) ?? null;
		},
		internalPlacementInventory: async (c, repositories: Record<string, GithubId>, snapshot?: GithubId) => {
			requireService(c);
			return {
				...(await placementInventory(c, () => agentModels(c), repositories, snapshot)),
				hostedCapacity: plannerHostedCapacity(c.vars.items.limits, c.vars.sessions.values()),
			};
		},
		setMachineDetails: (c, input: { machineId: string; whenToUse: string; tags: string[] }) =>
			machineActions.setMachineDetails(c, input),
		setMachineSecrets: machineActions.setMachineSecrets,
		internalMachineCreated: machineActions.internalMachineCreated,
		internalMachineSystem: async (c, id: string): Promise<{ os: string; arch: string } | null> => {
			requireServiceFor(c, "call");
			const [row] = await c.db.execute<{ os: string; arch: string }>("SELECT os, arch FROM machines WHERE id = ?", id);
			return row ?? null;
		},
		internalMachineApproval: machineActions.internalMachineApproval,
		internalMachineChanged: async (c, id: string, facts: MachineUpdate | null): Promise<void> => {
			const before = c.vars.machines.get(id);
			const inventoryChanged = await machineActions.internalMachineChanged(c, id, facts);
			if (facts === null) await notifyRemovedMachines(c, id);
			if (!inventoryChanged) return;
			queueChanged(c);
			const machine = c.vars.machines.get(id);
			if (
				before?.harnesses?.some(
					h => h.loginGeneration !== machine?.harnesses?.find(e => e.id === h.id)?.loginGeneration,
				)
			)
				await notifyProviderWaits(c, c.vars.items.items.values());
			if (machine?.status === "online" && (before?.status !== "online" || (!hasRoom(before) && hasRoom(machine)))) {
				for (const item of c.vars.items.items.values()) {
					if (item.awaitingPlace && item.state === "waiting")
						await itemActor(c, c.key[0], item.id).internalMachineAvailable();
				}
			}
		},
		internalReserveAttachment: itemActions.internalReserveAttachment,
		internalRecordAttachment: itemActions.internalRecordAttachment,
		internalReleaseAttachment: itemActions.internalReleaseAttachment,
		internalSettleAttachments: itemActions.internalSettleAttachments,
		internalDeleteItemAttachments: itemActions.internalDeleteItemAttachments,
		[ATTACHMENT_SWEEP_ACTION]: c => itemActions.internalAttachmentSweep(c),
		itemAttachmentLinks: itemActions.itemAttachmentLinks,
		internalApiItemAttachment: itemActions.internalApiItemAttachment,
		listItems: (c, page?: ItemListPage): ItemSummary[] => itemActions.listItems(c, page),
		itemFeed: itemActions.itemFeed,
		finishedItems: itemActions.finishedItems,
		item: itemActions.item,
		internalSessionForPull: (
			c,
			installation: GithubId,
			repository: GithubId,
			pr: number,
		): { sessionId: string | null } | null => {
			requireServiceFor(c, "call");
			const { github, profile } = c.vars;
			if (!github?.webhookLinked || !github.installations.some(i => i.id === installation)) return null;
			for (const session of c.vars.sessions.values()) {
				if (
					session.repository?.provider === "gitlab" ||
					session.repository?.id !== repository ||
					session.pullRequest?.number !== pr
				)
					continue;
				const personal = !session.item && !session.environmentBuild && profile && mayUse(profile, config.access);
				return { sessionId: personal ? session.id : null };
			}
			// A finished item's PR can still be linked after it leaves the live webhook directory.
			for (const item of c.vars.items.items.values()) {
				if (
					item.repository.provider !== "gitlab" &&
					item.repository.id === repository &&
					item.pullRequest?.number === pr
				)
					return { sessionId: null };
				if (item.repositories?.some(r => r.repositoryId === repository && r.pr?.number === pr))
					return { sessionId: null };
			}
			return null;
		},
		internalGitlabIntake: (c, delivery: import("./issue-intake.js").GitlabTrigger) =>
			itemActions.internalGitlabIntake(c, delivery, itemSession(c)),
		internalGitlabWake: async (
			c,
			delivery: Extract<import("../gitlab/webhook.js").GitlabDelivery, { event: "pipeline" | "merge_request" }>,
		) => {
			requireServiceFor(c, "call");
			const nudges = [...c.vars.items.items.values()].flatMap(item => {
				const repo = item.repository;
				if (
					repo.provider !== "gitlab" ||
					String(repo.id) !== delivery.projectId ||
					!item.pullRequest ||
					["done", "failed", "cancelled"].includes(item.state)
				)
					return [];
				// A merge request's pipeline belongs to that MR only: its head may be a merged-results commit, so match it by MR.
				if (delivery.iid !== undefined && String(item.pullRequest.number) !== String(delivery.iid)) return [];
				const pr = item.pullRequest.number;
				const subject =
					delivery.event === "pipeline"
						? { kind: "ci" as const, head: delivery.head, ...(delivery.iid !== undefined && { pr }) }
						: { kind: "pr" as const, pr };
				return [
					{
						id: item.id,
						nudge: () =>
							c
								.client()
								.workItem.get([c.key[0], item.id], { params: serviceParams() })
								.internalGitlabNudge({ projectId: delivery.projectId, ...subject }),
					},
				];
			});
			// A nudge only brings a poll forward. One item failing must neither stop the others nor redeliver the event to all of them.
			const results = await Promise.allSettled(nudges.map(n => n.nudge()));
			results.forEach((result, i) => {
				if (result.status === "rejected" && !isActorGone(result.reason))
					console.warn(`[wlp] gitlab.nudge_failed item=${nudges[i]!.id}`);
			});
		},
		internalGithubIntake: (c, input: import("../factory/intake.js").IntakeTrigger) =>
			itemActions.internalGithubIntake(c, input, itemSession(c)),

		...jira.jiraSettingsActions,
		internalJiraCallback: (c, nonce: string, origin: string, code: string | null, hash: string) => {
			requireServiceFor(c, "call");
			return jira.stageGrant(c, nonce, origin, code, hash);
		},
		internalJiraSite: c => {
			requireServiceFor(c, "call");
			return jira.selectedSite(c);
		},
		internalJiraRenew: c => {
			if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
			return jira.renewJiraWebhooks(c);
		},
		internalJiraWrite: (c, input: JiraItemWrite) => {
			requireServiceFor(c, "call");
			return jira.writeJiraItem(c, input);
		},
		internalJiraDelivery: (c, delivery: JiraDelivery, digest: string) => {
			requireServiceFor(c, "call");
			return jira.fileJiraDelivery(c, delivery, digest, (filing, uid) =>
				uid === c.key[0]
					? itemActions.internalTrackerIntake(c, filing, itemSession(c))
					: userActor(c, uid).internalTrackerIntake(filing),
			);
		},
		/** A Linear or Jira issue filed by this user from a mapping another user owns: its owner read the issue and resolved the filer. */
		internalTrackerIntake: (
			c,
			filing: import("../factory/intake.js").LinearFiling | import("./issue-intake.js").SiteJiraFiling,
		) => itemActions.internalTrackerIntake(c, filing, itemSession(c)),
		...slackSettingsActions,
		...linkedAccountActions,
		internalSlackIntake: (c, filing: import("../factory/intake.js").SlackFiling) =>
			itemActions.internalSlackIntake(c, filing, itemSession(c)),
		internalSlackAct: itemActions.internalSlackAct,
		internalSlackReply: itemActions.internalSlackReply,

		linear: async (c): Promise<LinearStatus> => {
			requireUser(c);
			return linearStatus(c);
		},
		linearConnect: async (c, input: { origin: string }): Promise<{ url: string }> => {
			requireUser(c);
			return beginLinearConnect(c, input);
		},
		linearComplete: async (c, ticket: string): Promise<LinearStatus> => {
			requireUser(c);
			return completeLinearConnection(c, ticket);
		},
		linearTeams: async (c): Promise<LinearTeamList> => {
			requireUser(c);
			return (await linearTeams(c)).list;
		},
		saveLinearMapping: async (c, input: { teamId: string; repositoryId: GithubId }): Promise<LinearTeamList> => {
			requireUser(c);
			return saveLinearMapping(c, input);
		},
		removeLinearMapping: async (c, teamId: string): Promise<LinearTeamList> => {
			requireUser(c);
			return removeLinearMapping(c, teamId);
		},
		disconnectLinear: async (c): Promise<LinearStatus> => {
			requireUser(c);
			return disconnectLinear(c);
		},
		internalLinearHoldsTeam: async (c, workspaceId: string, teamId: string) => {
			requireServiceFor(c, "call");
			return linearHoldsTeam(c, workspaceId, teamId);
		},
		internalLinearWrite: async (c, input: LinearItemWrite) => {
			requireServiceFor(c, "call");
			return writeLinearItem(c, input);
		},
		internalLinearClaim: async (c, nonce: string) => {
			requireService(c);
			return claimLinearState(c, nonce);
		},
		internalLinearDelivery: (c, delivery: import("../linear/webhook.js").LinearDelivery) => {
			requireServiceFor(c, "call");
			return fileLinearDelivery(c, delivery, (filing, uid) =>
				uid === c.key[0]
					? itemActions.internalTrackerIntake(c, filing, itemSession(c))
					: userActor(c, uid).internalTrackerIntake(filing),
			);
		},
		createItem: (c, input: CreateItemInput): Promise<ItemSummary> => itemActions.createItem(c, input, itemSession(c)),
		actOnItem: itemActions.actOnItem,
		mergeGitlabItem: itemActions.mergeGitlabItem,
		factoryLimits: itemActions.factoryLimits,
		apiTokens: itemActions.apiTokens,
		createApiToken: itemActions.createApiToken,
		revokeApiToken: itemActions.revokeApiToken,
		internalApiCreateItem: (c, input: { token: string; item: CreateItemInput }): Promise<ItemSummary> =>
			itemActions.internalApiCreateItem(c, input, itemSession(c)),
		internalApiItem: itemActions.internalApiItem,
		internalFeatureChild: (c, input: { parent: string; child: string; cancel?: boolean }) =>
			itemActions.internalFeatureChild(c, input, itemSession(c), () => agentModels(c)),
		internalItemChanged: itemActions.internalItemChanged,
		internalItemFacts: (c, ids: string[] | string): ItemFacts =>
			itemActions.internalItemFacts(c, typeof ids === "string" ? [ids] : ids),
		internalRequestTurn: itemActions.internalRequestTurn,
		internalTurnDone: itemActions.internalTurnDone,
		internalWithdrawTurn: itemActions.internalWithdrawTurn,
		[QUEUE_ACTION]: (c): Promise<void> => itemActions.internalTurnQueue(c),
		me: (c): UserProfile => requireUser(c),
		openGitlab: (c): Promise<boolean> => {
			requireUser(c);
			return openUserGitlab(c);
		},
		chatgpt: signinActions.chatgpt,
		forgetChatgpt: signinActions.forgetChatgpt,
		models: signinActions.models,

		listSessions: (c): SessionSummary[] => {
			requireUser(c);
			return sessionList(c.vars);
		},

		createSession: async (c, input: CreateSessionInput): Promise<SessionSummary> => {
			const profile = requireUser(c);
			if (typeof input !== "object" || input === null)
				throw new UserError("Choose a sandbox for the agent.", { code: "bad_input" });
			let attempt: Promise<SessionSummary>;
			try {
				const { idempotencyKey, ...asked } = input;
				const submission = submissionOf(idempotencyKey, asked);
				if (submission === null) return await makeSession(c, profile, input, null);
				// Made before, and still there: the answer is that session as it is now. Nothing was awaited, so this is decided before any other call runs.
				const made = c.vars.created.get(submission.key);
				const session = made && isRepeat(made, submission, KEYED) ? c.vars.sessions.get(made.id) : undefined;
				if (session) return session;
				// Being decided, or new: every attempt that arrives until the session is made or refused ends as this one does.
				attempt = c.vars.creating.run(submission, KEYED, () => makeSession(c, profile, input, submission));
			} catch (error) {
				if (error instanceof SubmissionProblem) throw new UserError(error.message, { code: error.code });
				throw error;
			}
			return await attempt;
		},

		continueSession: async (c, input: ContinueSessionInput): Promise<SessionSummary> => {
			const profile = requireUser(c);
			if (typeof input !== "object" || input === null || typeof input.id !== "string")
				throw new UserError("Choose the agent to continue.", { code: "bad_input" });
			if (input.stack !== undefined && input.stack !== null && typeof input.stack !== "boolean")
				throw new UserError("Say whether to start from the agent's branch.", { code: "bad_input" });
			let attempt: Promise<SessionSummary>;
			try {
				const submission = submissionOf(input.idempotencyKey, { continue: input.id, stack: input.stack === true });
				if (submission === null) return await continueFrom(c, profile, input, null);
				const made = c.vars.created.get(submission.key);
				const session = made && isRepeat(made, submission, KEYED) ? c.vars.sessions.get(made.id) : undefined;
				if (session) return session;
				attempt = c.vars.creating.run(submission, KEYED, () => continueFrom(c, profile, input, submission));
			} catch (error) {
				if (error instanceof SubmissionProblem) throw new UserError(error.message, { code: error.code });
				throw error;
			}
			return await attempt;
		},

		renameSession: async (c, id: string, title: string): Promise<SessionSummary> => {
			const profile = requireUser(c);
			const clean = cleanTitle(title);
			if (!clean) throw new UserError("Give the agent a name.", { code: "bad_title" });
			if (typeof id !== "string" || !c.vars.sessions.has(id))
				throw new UserError("That agent does not exist.", { code: "session_not_found" });

			let summary: SessionSummary;
			try {
				summary = await sessionActor(c, profile.uid, id).internalRename(clean);
			} catch (error) {
				if (isSessionGone(error))
					throw new UserError("That agent does not exist any more.", { code: "session_not_found" });
				throw clientError(c.log, error, "The agent could not be renamed. Try again.");
			}
			await storeReport(c, summary);
			return summary;
		},

		deleteSession: async (c, id: string): Promise<void> => {
			const profile = requireUser(c);
			const existing = typeof id === "string" ? c.vars.sessions.get(id) : undefined;
			if (!existing) throw new UserError("That agent does not exist.", { code: "session_not_found" });
			const owned = itemSessionRefusal(c, existing);
			if (owned) throw owned;

			// Out of the index first, so a report the session sends while it shuts down is ignored.
			c.vars.sessions.delete(id);
			try {
				await sessionActor(c, profile.uid, id).internalDestroy();
			} catch (error) {
				if (!isSessionGone(error)) {
					if (!c.vars.sessions.has(id)) c.vars.sessions.set(id, existing);
					// What the session itself refused (its machine could not record the sandbox's removal) is said in its words.
					const { group, code, message } = (typeof error === "object" && error !== null ? error : {}) as {
						group?: unknown;
						code?: unknown;
						message?: unknown;
					};
					if (group === "user" && typeof code === "string" && typeof message === "string")
						throw new UserError(message, { code });
					throw clientError(c.log, error, "The agent could not be deleted. Try again.");
				}
			}
			await forgetSession(c, id);
			// A session with no repository was its own project: what was approved for it goes with it.
			await changeApprovals(c, book => book.forgetProject(sessionProjectKey(id))).catch(error =>
				c.log.warn({
					msg: "could not forget the deleted session's approvals of MCP servers",
					session: id,
					error: String(error),
				}),
			);
		},
		allowance: usageActions.allowance,
		billing: usageActions.billing,
		billingCheckout: usageActions.billingCheckout,
		billingPortal: usageActions.billingPortal,
		setOverageCap: usageActions.setOverageCap,
		internalRetryOverage: usageActions.internalRetryOverage,
		internalBillingEvent: usageActions.internalBillingEvent,
		usage: usageActions.usage,
		costRates: usageActions.costRates,
		freeSandbox: usageActions.freeSandbox,

		github: (c): GithubStatus => {
			requireUser(c);
			requireGithub();
			return githubStatus(c.vars);
		},

		githubConnect: async (c, input: { origin: string; install?: boolean }): Promise<{ url: string }> => {
			const profile = requireUser(c);
			const app = requireGithub();
			const origin = typeof input?.origin === "string" ? input.origin.replace(/\/+$/, "") : "";
			// The browser is sent back there with the ticket: only to the web app's own address.
			if (!config.origins.includes(origin))
				throw new UserError("GitHub can only be connected from the web app's own address.", {
					code: "origin_not_allowed",
				});
			try {
				const nonce = newNonce();
				// The installation page takes no PKCE challenge: the code it ends with is exchanged without a verifier.
				if (input.install === true) {
					await rememberPending(c, nonce, null);
					return { url: app.installUrl(issueState(profile.uid, nonce, origin)) };
				}
				const { verifier, challenge } = newCodeVerifier();
				await rememberPending(c, nonce, verifier);
				return { url: app.authorizeUrl(issueState(profile.uid, nonce, origin), challenge) };
			} catch (error) {
				throw clientError(c.log, error, "Connecting GitHub could not be started. Try again.");
			}
		},

		githubComplete: async (c, ticket: string): Promise<GithubStatus> => {
			const profile = requireUser(c);
			requireGithub();
			const confirmed = verifyTicket(ticket);
			if (!confirmed)
				throw new UserError("This link to connect GitHub is not valid any more. Connect GitHub again.", {
					code: "github_ticket",
				});
			// The one check that ties the browser that came back from GitHub to the user who began.
			if (confirmed.uid !== profile.uid) {
				throw new UserError(
					"This GitHub connection was started from another Windlass account, so it was not added to yours. Connect GitHub again from here.",
					{ code: "github_ticket" },
				);
			}
			try {
				// The primary key lets one of two calls with the same ticket through.
				await c.db.execute(
					"INSERT INTO github_nonce (nonce, kind, verifier, expires_at) VALUES (?, 'ticket', NULL, ?)",
					`ticket:${confirmed.nonce}`,
					confirmed.exp + TICKET_TTL_MS,
				);
			} catch {
				throw new UserError(
					"This link to connect GitHub was already used. Connect GitHub again if it is not connected.",
					{ code: "github_ticket" },
				);
			}
			const connection: StoredConnection = {
				...(githubConfig().webhook ? { webhookLinked: true } : {}),
				user: { id: confirmed.user.id, login: confirmed.user.login },
				installations: confirmed.installations.slice(0, MAX_GITHUB_ACCOUNTS).map(({ id, account, htmlUrl }) => ({
					id,
					account: { id: account.id, login: account.login, type: account.type },
					htmlUrl,
				})),
				connectedAt: Date.now(),
			};
			await replaceGithubConnection(c, profile.uid, connection, confirmed.readAt);
			c.vars.reached = true;
			console.log(
				`[wlp] github.connected uid=${profile.uid} github=${connection.user.login} installations=${connection.installations.map(installation => installation.id).join(",")}`,
			);
			return githubStatus(c.vars);
		},

		githubDisconnect: async (c): Promise<GithubStatus> => {
			const profile = requireUser(c);
			requireGithub();
			// A connection that was begun and not finished ends here too. The tickets that were taken stay
			// on the list until they would have expired: one of them must not bring the connection back.
			await c.db.execute("DELETE FROM github_nonce WHERE kind = 'state'");
			const wasConnected = c.vars.github !== null;
			await replaceGithubConnection(c, profile.uid, null);
			await dropHostedSnapshots(profile.uid);
			if (wasConnected) console.log(`[wlp] github.disconnected uid=${profile.uid}`);
			return githubStatus(c.vars);
		},

		githubRepositories: async (c, query: string, fresh?: boolean): Promise<GithubRepositoryList> => {
			requireUser(c);
			const app = requireGithub();
			const connection = requireConnection(c);
			if (typeof query !== "string" || query.length > 200)
				throw new UserError("Search for part of a repository's name.", { code: "bad_input" });
			try {
				return await listRepositories(
					app,
					fresh === true ? { ...connection, refreshedAt: Date.now() } : connection,
					query,
				);
			} catch (error) {
				throw githubError(c.log, error, "The repositories could not be listed. Try again.");
			}
		},

		githubBranches: async (c, repositoryId: GithubId): Promise<GithubBranchList> => {
			requireUser(c);
			const app = requireGithub();
			const connection = requireConnection(c);
			if (!isGithubId(repositoryId))
				throw new UserError("Choose one of the listed repositories.", { code: "bad_input" });
			try {
				return await listBranches(app, connection, repositoryId);
			} catch (error) {
				throw githubError(c.log, error, "The repository's branches could not be listed. Try again.");
			}
		},

		githubStarterIssues: async (c, repositoryId: GithubId): Promise<StarterIssue[]> => {
			requireUser(c);
			const app = requireGithub();
			const connection = requireConnection(c);
			if (!isGithubId(repositoryId))
				throw new UserError("Choose one of the listed repositories.", { code: "bad_input" });
			try {
				return await listStarterIssues(app, connection, repositoryId);
			} catch (error) {
				throw githubError(c.log, error, "The repository's issues could not be listed. Try again.");
			}
		},

		repositorySetup: async (c, repositoryId: GithubId): Promise<RepositorySetup> => {
			requireUser(c);
			const project = setupKeyOf(repositoryId);
			try {
				return await readSetup(c.db, project);
			} catch (error) {
				throw clientError(c.log, error, "The repository's setup command could not be read. Try again.");
			}
		},

		saveRepositorySetup: async (c, input: { repositoryId: GithubId; command: string }): Promise<RepositorySetup> => {
			const profile = requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			const command = setupCommandOf(input?.command);
			try {
				const saved = await saveSetup(c, profile.uid, project, await labelFor(c, input.repositoryId, project), command);
				await changeEnvironments(c, host => settingsChanged(host, project)).catch((error: unknown) =>
					c.log.warn({ msg: "environments could not be marked stale", error: String(error) }),
				);
				return saved;
			} catch (error) {
				throw clientError(c.log, error, "The setup command could not be saved. Try again.");
			}
		},

		internalDiscardPlacement: (c, id: string) =>
			itemActions.internalDiscardPlacement(c, id, async session => {
				try {
					await sessionActor(c, c.key[0], session).internalDestroy();
				} catch (error) {
					if (!isSessionGone(error)) throw error;
				}
				await forgetSession(c, session);
			}),
		internalDefaultBuilder: (c, input: { id: string; job: import("./user-items.js").DefaultBuilder }) =>
			itemActions.internalDefaultBuilder(c, input, itemSession(c)),
		internalPlanCritic: async (c, builderId: string, context: RunContext): Promise<void> => {
			requireServiceFor(c, "call");
			const builder = c.vars.sessions.get(builderId),
				profile = c.vars.profile;
			if (
				!profile ||
				!builder?.item ||
				builder.item.role === "reviewer" ||
				!builder.repository ||
				!criticAllowed(builder.place, (await getLayer()).sandboxes.profile(builder.profile))
			)
				throw new UserError(
					"The plan critic requires a hosted Windlass command-sandboxed session. Review this plan yourself.",
					{ code: "bad_profile" },
				);
			const sessionId = criticSessionId(builder.item.id);
			if (c.vars.sessions.has(sessionId)) return;
			const { id, branch } = builder.repository;
			const run = resolveRun(context, "critic");
			const model = run.model ?? (await modelsOf(c, profile.demo)).defaultModel;
			await makeSession(
				c,
				profile,
				{ title: builder.title, place: builder.place, profile: builder.profile, model, repository: { id, branch } },
				null,
				{
					sessionId,
					itemId: builder.item.id,
					role: "reviewer",
					effort: run.effort ?? undefined,
					planCritic: true,
					hostedSize: builder.hostedSize,
				},
			);
		},

		internalRepositoryAutonomy: async (c, key: string | GithubId) => {
			requireService(c);
			const project = setupKeyOf(key);
			const hasOffers = (await c.db.execute("SELECT 1 FROM setup_offer WHERE project=? AND off=0 LIMIT 1", project))
				.length;
			const { autoApprovePlans, autoMergeSingles, waitForCiOnEachPart, mergeKinds } = hasOffers
				? (await repoPolicy(c, project)).defaults
				: await readDefaults(c.db, project);
			return {
				mergeKinds,
				autoApprovePlans: !!autoApprovePlans,
				autoMergeSingles: !!autoMergeSingles,
				waitForCiOnEachPart: !!waitForCiOnEachPart,
			};
		},

		repositoryChecks: async (c, repositoryId: GithubId): Promise<RepositoryChecks> => {
			requireUser(c);
			const project = setupKeyOf(repositoryId);
			try {
				return await readChecks(c.db, project);
			} catch (error) {
				throw clientError(c.log, error, "The repository's checks could not be read. Try again.");
			}
		},

		saveRepositoryChecks: async (
			c,
			input: { repositoryId: GithubId; checks: RepositoryCheck[] },
		): Promise<RepositoryChecks> => {
			const profile = requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			let checks: RepositoryCheck[];
			try {
				checks = cleanChecks(input?.checks);
			} catch (error) {
				if (error instanceof ChecksProblem) throw new UserError(error.message, { code: "bad_checks" });
				throw error;
			}
			try {
				// The list is written whole, in one statement: of two saves that run together, one stays as it was sent.
				const saved = await saveChecks(
					c.db,
					project,
					await labelFor(c, input.repositoryId, project),
					checks,
					Date.now(),
				);
				console.log(`[wlp] checks.saved uid=${profile.uid} project=${project} checks=${checks.length}`);
				await changeEnvironments(c, host => settingsChanged(host, project)).catch((error: unknown) =>
					c.log.warn({ msg: "environments could not be marked stale", error: String(error) }),
				);
				return saved;
			} catch (error) {
				throw clientError(c.log, error, "The checks could not be saved. Try again.");
			}
		},

		repositoryNetwork: async (c, repositoryId: GithubId): Promise<RepositoryNetwork> => {
			requireUser(c);
			const project = setupKeyOf(repositoryId);
			try {
				return await networkView(c, project);
			} catch (error) {
				throw clientError(c.log, error, "The repository's network list could not be read. Try again.");
			}
		},

		saveRepositoryNetwork: async (
			c,
			input: { repositoryId: GithubId; entries: string[] },
		): Promise<RepositoryNetwork> => {
			const profile = requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			if (!mayChangeNetwork(profile.uid, c.key[0]!))
				throw new UserError("Only whoever changes this repository's settings can change its network list.", {
					code: "forbidden",
				});
			const limitHosts = await deploymentHostsForLimit();
			const entries = networkInput(() => cleanEntries(input?.entries, limitHosts, config.hosted?.network.maxHosts));
			try {
				const saved = await saveNetwork(
					c.db,
					project,
					await labelFor(c, input.repositoryId, project),
					entries,
					Date.now(),
				);
				console.log(
					`[wlp] network.saved uid=${profile.uid} project=${project} entries=${entries.length} hosts=${saved.hosts.length}`,
				);
				return await networkView(c, project);
			} catch (error) {
				throw clientError(c.log, error, "The network list could not be saved. Try again.");
			}
		},

		dismissNetworkRequest: async (c, input: { repositoryId: GithubId; host: string }): Promise<RepositoryNetwork> => {
			requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			const host = boundedText(input?.host, 260);
			try {
				await dismissRequest(c.db, project, host);
				return await networkView(c, project);
			} catch (error) {
				throw clientError(c.log, error, "The request could not be dismissed. Try again.");
			}
		},

		scanRepositoryNetwork: async (c, repositoryId: GithubId): Promise<NetworkScan> => {
			requireUser(c);
			const project = setupKeyOf(repositoryId);
			const app = requireGithub();
			const connection = requireConnection(c);
			let resolved: Awaited<ReturnType<typeof resolveRepository>>;
			try {
				resolved = await resolveRepository(app, connection, repositoryId, "read");
			} catch (error) {
				throw githubError(c.log, error, "The repository could not be checked at GitHub. Try again.");
			}
			const { owner, name, defaultBranch } = resolved.repository;
			let read: { commit: string; files: Array<{ path: string; text: string }>; incomplete: boolean };
			try {
				read = await app.withToken(
					resolved.installation.id,
					{ repositoryId, permissions: { metadata: "read", contents: "read" } },
					token => app.scanFiles(token, owner, name, defaultBranch, scanPaths),
					{ revokeAfter: true },
				);
			} catch (error) {
				throw githubError(c.log, error, "The repository's files could not be read at GitHub. Try again.");
			}
			try {
				const hosted = await hostedNetwork();
				const saved = await readNetwork(c.db, project);
				const setup = (await setupRow(c.db, project))?.command ?? "";
				const proposals = scanForHosts(read.files, setup, [
					...saved.hosts,
					...(hosted?.mode === "restricted" ? hosted.hosts : []),
				]);
				return {
					proposals,
					commit: read.commit,
					branch: defaultBranch,
					files: read.files.length,
					incomplete: read.incomplete,
				};
			} catch (error) {
				throw clientError(c.log, error, "The repository's files could not be read. Try again.");
			}
		},

		/**
		 * "Allow for this repository" from a session's timeline (`allowHost` of the session): `by` is who
		 * asked, as the session checked it. Someone who may change the repository's settings adds the host
		 * to its list; anyone else would file a request, but only the session's own user reaches `allowHost`
		 * today, and that is this actor's. Answers with the session's hosts then, as a turn gets them.
		 */
		internalAllowHost: async (
			c,
			input: { sessionId: string; host: string; by: string },
		): Promise<{ allowed: boolean; hosts: string[]; network: RepositoryNetwork }> => {
			requireService(c);
			const session = c.vars.sessions.get(boundedText(input?.sessionId, 200));
			const project = sessionSetupKey(session);
			if (!session || project === null)
				throw new UserError(
					"This agent has no repository of your GitHub connection, so there is no list to allow a host in. The deployment's operator can allow it for every sandbox (WLP_E2B_NETWORK_ALLOW).",
					{ code: "bad_network" },
				);
			const host = cleanEntry(input?.host);
			if (host === null || host.startsWith("@"))
				throw new UserError("That is not an exact host name.", { code: "bad_network" });
			const allowed = mayChangeNetwork(typeof input?.by === "string" ? input.by : null, c.key[0]!);
			try {
				if (allowed) {
					const label = session.repository ? `${session.repository.owner}/${session.repository.name}` : "";
					const saved = await addEntry(
						c.db,
						project,
						label,
						host,
						await deploymentHostsForLimit(),
						Date.now(),
						config.hosted?.network.maxHosts,
					);
					console.log(
						`[wlp] network.allowed uid=${c.key[0]} project=${project} host=${host} session=${input.sessionId}`,
					);
					return { allowed, hosts: saved.hosts, network: await networkView(c, project) };
				}
				await fileRequests(c.db, project, [host], input.sessionId, Date.now());
				return { allowed, hosts: (await readNetwork(c.db, project)).hosts, network: await networkView(c, project) };
			} catch (error) {
				if (error instanceof UserError) throw error;
				if (error instanceof NetworkProblem) throw new UserError(error.message, { code: "bad_network" });
				throw clientError(c.log, error, "The host could not be allowed. Try again.");
			}
		},

		internalNetworkRequests: async (
			c,
			input: { sessionId: string; hosts: string[] },
		): Promise<{ filed: string[]; full: string[] }> => {
			requireService(c);
			const session = c.vars.sessions.get(boundedText(input?.sessionId, 200));
			const project = sessionSetupKey(session);
			if (!session || project === null || !Array.isArray(input?.hosts)) return { filed: [], full: [] };
			return await fileRequests(
				c.db,
				project,
				input.hosts.filter((host): host is string => typeof host === "string").slice(0, 50),
				input.sessionId,
				Date.now(),
			);
		},

		internalHasChecks: async (c, repositoryId: GithubId): Promise<boolean> => {
			requireService(c);
			return (await readChecks(c.db, setupKeyOf(repositoryId))).checks.length > 0;
		},
		internalSnapshotSaved: async (
			c,
			project: string,
			updatedAt: number | null,
			connectedAt: number,
			place?: string,
		) => {
			requireService(c);
			if (c.vars.github?.connectedAt !== connectedAt) return;
			await c.db.execute(
				"UPDATE setup_command SET snapshot_connection = ? WHERE project = ? AND updated_at = ?",
				connectedAt,
				project,
				updatedAt,
			);
			if (typeof place === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(place) && updatedAt !== null)
				await c.db.execute(
					"INSERT INTO snapshot_place (project, place, saved_at, updated_at, connected_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (project, place) DO UPDATE SET saved_at = excluded.saved_at, updated_at = excluded.updated_at, connected_at = excluded.connected_at",
					project,
					place,
					Date.now(),
					updatedAt,
					connectedAt,
				);
		},
		internalSnapshotGenerations: async (c): Promise<string[]> => {
			requireService(c);
			const connection = c.vars.github;
			if (!connection) return [];
			const rows = await c.db.execute<{ project: string; updated_at: number }>(
				"SELECT project, updated_at FROM setup_command",
			);
			return rows.map(row =>
				snapshotGeneration(row.project.slice("github:".length), row.updated_at, connection.connectedAt),
			);
		},

		repositoryEnvironments: async (c, repositoryId: GithubId): Promise<RepositoryEnvironments> => {
			requireUser(c);
			try {
				return await environmentsView(environmentHost(c), setupKeyOf(repositoryId));
			} catch (error) {
				throw clientError(c.log, error, "The repository's environments could not be read. Try again.");
			}
		},
		rebuildEnvironment: async (
			c,
			input: { repositoryId: GithubId; place?: EnvironmentPlace },
		): Promise<RepositoryEnvironments> => {
			requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			if (input.place !== undefined && (typeof input.place !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.place)))
				throw new UserError("Choose one of the places listed.", { code: "bad_input" });
			const host = environmentHost(c);
			try {
				await changeEnvironments(c, host => rebuildEnvironments(host, project, input.place));
			} catch (error) {
				if (error instanceof Error && !(error instanceof UserError))
					throw new UserError(error.message, { code: "environment_refused" });
				throw clientError(c.log, error, "The rebuild could not be asked for. Try again.");
			}
			return environmentsView(host, project);
		},
		saveEnvironmentSchedule: async (
			c,
			input: { repositoryId: GithubId; schedule: EnvironmentSchedule },
		): Promise<RepositoryEnvironments> => {
			requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			if (!ENVIRONMENT_SCHEDULES.includes(input?.schedule))
				throw new UserError("Choose nightly, every 12 hours, every 6 hours or off.", { code: "bad_input" });
			const host = environmentHost(c);
			await changeEnvironments(c, host => saveSchedule(host, project, input.schedule));
			return environmentsView(host, project);
		},
		internalEnvironmentTick: async (c): Promise<void> => {
			if (!c.vars.profile) return;
			await changeEnvironments(c, environmentTick).catch((error: unknown) =>
				c.log.warn({ msg: "environment builds could not be started", error: String(error) }),
			);
		},
		internalEnvironmentResult: async (c, sessionId: string, result: EnvironmentBuildReport): Promise<void> => {
			requireService(c);
			const passed = await changeEnvironments(c, host => buildResult(host, boundedText(sessionId, 200), result));
			if ("waiting" in result) return;
			console.log(
				`[wlp] environment.built uid=${c.key[0]} session=${sessionId} passed=${passed} failure=${"interrupted" in result ? "interrupted" : (result.failure?.kind ?? "none")}`,
			);
		},
		internalEnvironmentNudge: async (
			c,
			sessionId: string,
			kind: "missed" | "cold",
			screenshots: boolean,
		): Promise<void> => {
			requireService(c);
			const session = c.vars.sessions.get(boundedText(sessionId, 200));
			const project = sessionSetupKey(session);
			if (!session || !project || session.environmentBuild || (kind !== "missed" && kind !== "cold")) return;
			await changeEnvironments(c, host =>
				environmentNudge(
					host,
					project,
					session.place.kind === "hosted" ? HOSTED : session.place.machineId,
					kind,
					session.hostedSize,
					screenshots,
				),
			);
		},
		internalEnvironmentPushed: async (c, repositoryId: GithubId): Promise<void> => {
			requireService(c);
			if (!c.vars.profile) return;
			await changeEnvironments(c, host => environmentPushed(host, setupKeyOf(repositoryId)));
		},
		internalSetupCommand: async (c, project: string): Promise<RepositorySetup> => {
			requireService(c);
			return readSetup(c.db, boundedText(project, 600));
		},

		repositorySecrets: async (c, input: { repositoryId: GithubId; profile: string }): Promise<RepositorySecrets> => {
			requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			const profile = await secretProfile(input?.profile);
			try {
				return await listSecrets(c.db, project, profile);
			} catch (error) {
				throw clientError(c.log, error, "The repository's secrets could not be read. Try again.");
			}
		},

		saveRepositorySecret: async (
			c,
			input: { repositoryId: GithubId; profile: string; name: string; value?: string; scope: SecretScope },
		): Promise<RepositorySecrets> => {
			const user = requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			const profile = await secretProfile(input?.profile);
			const name = secretInput(() => cleanSecretName(input?.name));
			const scope = secretInput(() => cleanSecretScope(input?.scope));
			const value =
				input?.value === undefined || input?.value === null
					? undefined
					: secretInput(() => cleanSecretValue(input.value));
			try {
				await saveSecret(c, user.uid, project, await labelFor(c, input.repositoryId, project), name, value, scope);
				return await listSecrets(c.db, project, profile);
			} catch (error) {
				throw clientError(c.log, error, "The secret could not be saved. Try again.");
			}
		},

		deleteRepositorySecret: async (
			c,
			input: { repositoryId: GithubId; profile: string; name: string },
		): Promise<RepositorySecrets> => {
			const user = requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			const profile = await secretProfile(input?.profile);
			const name = boundedText(input?.name, 200);
			try {
				await c.db.execute("DELETE FROM repo_secret WHERE project = ? AND name = ?", project, name);
				console.log(
					`[wlp] secret.deleted uid=${user.uid} project=${project} name=${name.replace(/[^A-Za-z0-9_]/g, "?")}`,
				);
				return await listSecrets(c.db, project, profile);
			} catch (error) {
				throw clientError(c.log, error, "The secret could not be deleted. Try again.");
			}
		},

		internalRequestedSecretConflict: async (c, sessionId: string, name: string): Promise<string | null> => {
			requireServiceFor(c, secretsCaller(c.key[0]!, sessionId));
			const session = c.vars.sessions.get(sessionId);
			if (!session || !validRequestedSecretName(name))
				throw new UserError("That secret request is unavailable.", { code: "bad_secret" });
			return requestedSecretConflict(c.db, sessionSetupKey(session), name);
		},

		internalSaveRequestedSecret: async (c, sessionId: string, input: RequestedSecretSave): Promise<void> => {
			const uid = c.key[0]!;
			requireServiceFor(c, secretsCaller(uid, sessionId));
			const session = c.vars.sessions.get(sessionId);
			if (!session || !validRequestedSecretName(input.name))
				throw new UserError("That secret request is unavailable.", { code: "bad_secret" });
			const project = sessionSetupKey(session) ?? ACCOUNT_SECRET_PROJECT;
			if (project !== input.project)
				throw new UserError("The requested secret’s scope has changed.", { code: "bad_secret" });
			if (session.place.kind === "machine" && !(await machineSecrets(c.db, session.place.machineId)))
				throw new UserError("Enable sending secrets to this machine before continuing.", { code: "secrets_disabled" });
			const { name, sealed } = input;
			try {
				await c.db.transaction(async tx => {
					const [receipt] = await tx.execute(
						"SELECT 1 FROM requested_secret_receipt WHERE session_id = ? AND request_id = ?",
						sessionId,
						input.requestId,
					);
					if (receipt) {
						// An item recovering after a restart replays the exact ciphertext it already saved.
						const same =
							project === ACCOUNT_SECRET_PROJECT
								? await tx.execute(
										"SELECT 1 FROM account_secret WHERE name = ? AND sealed = ? AND scope = 'agent'",
										name,
										sealed,
									)
								: await tx.execute(
										"SELECT 1 FROM repo_secret WHERE project = ? AND name = ? AND sealed = ? AND scope = 'agent'",
										project,
										name,
										sealed,
									);
						if (same.length) return;
						throw new UserError("The saved secret was changed under Secrets.", { code: "bad_secret" });
					}
					const conflict = await requestedSecretConflict(tx, project, name, "person");
					if (conflict) throw new UserError(conflict, { code: "secret_exists" });
					if (project === ACCOUNT_SECRET_PROJECT) await saveAccountSecret(tx, name, "agent", sealed, Date.now());
					else {
						const repo = session.repository!;
						checkSecretLimit(
							await saveRepoSecret(tx, {
								uid,
								project,
								label: `${repo.owner}/${repo.name}`,
								name,
								scope: "agent",
								sealed,
								now: Date.now(),
							}),
						);
					}
					await tx.execute("INSERT OR REPLACE INTO requested_secret_receipt VALUES (?, ?)", sessionId, input.requestId);
					if (session.harness && session.harness !== "windlass")
						await tx.execute("INSERT OR IGNORE INTO session_secret_grant VALUES (?, ?)", sessionId, name);
				});
			} catch (error) {
				if (error instanceof TooManySecrets) throw new UserError(error.message, { code: "too_many_secrets" });
				throw clientError(c.log, error, "The requested secret could not be saved.");
			}
		},

		// Release sealed secrets only to the indexed session and its recorded repositories.
		internalSessionSecrets: async (c, sessionId: string, includeSnapshotSetup = false): Promise<SealedSecrets> => {
			const id = boundedText(sessionId, 200);
			requireServiceFor(c, secretsCaller(c.key[0]!, id));
			// A session this user does not have is handed nothing, of the account's either.
			const session = c.vars.sessions.get(id);
			if (!session) return { project: null, secrets: [], checks: [], account: { secrets: [], servers: [] } };
			const send = session.place.kind === "hosted" || (await machineSecrets(c.db, session.place.machineId)) === true;
			const requestedNames =
				send && session.harness && session.harness !== "windlass"
					? (
							await c.db.execute<{ name: string }>("SELECT name FROM session_secret_grant WHERE session_id = ?", id)
						).map(row => row.name)
					: undefined;
			const redactOnly =
				session.readiness ||
				(!send && (session.item?.role === "reviewer" || (!!session.harness && session.harness !== "windlass")));
			const kept =
				send || redactOnly
					? await c.db.execute<{ name: string; scope: string; sealed: string }>(
							"SELECT name, scope, sealed FROM account_secret ORDER BY name",
						)
					: [];
			await refreshSecretRows(c.db, serverSealer(), c.key[0], ACCOUNT_SECRET_PROJECT, kept);
			const account = {
				secrets: kept.map(row => ({
					name: row.name,
					scope: row.scope === "agent" ? ("agent" as const) : ("setup" as const),
					sealed: row.sealed,
				})),
				servers: (await readServers(c.db)).map(({ name, definition, unasked }) => ({ name, definition, unasked })),
			};
			const project = sessionSetupKey(session);
			if (project === null)
				return { project: null, secrets: [], checks: [], account, requestedNames, ...(redactOnly && { redactOnly }) };
			// The hosts its repository's list allows, for a hosted sandbox. A cross-repo feature's own session reads every
			// repository of the feature, and is given the hosts of each one's list (`unionHosts`).
			const feature = session.item && !session.item.planCritic ? c.vars.items.items.get(session.item.id) : undefined;
			const others = (feature?.repositories ?? []).filter(
				r => String(r.repositoryId) !== String(session.repository?.id),
			);
			const lists =
				!session.readiness && session.place.kind === "hosted"
					? [
							await readNetwork(c.db, project),
							...(await Promise.all(others.map(r => readNetwork(c.db, setupProjectKey(r.repositoryId)!)))),
						]
					: [];
			// The others fill only the room the deployment's own hosts leave: the primary's list comes first.
			const network =
				lists.length > 1
					? unionHosts(
							lists.map(list => list.hosts),
							networkLimit(await deploymentHostsForLimit(), config.hosted?.network.maxHosts),
						)
					: (lists[0]?.hosts ?? []);
			const rows =
				send || redactOnly
					? await c.db.execute<{ name: string; scope: string; sealed: string }>(
							"SELECT name, scope, sealed FROM repo_secret WHERE project = ? ORDER BY name",
							project,
						)
					: [];
			await refreshSecretRows(c.db, serverSealer(), c.key[0], project, rows);
			const { checks } = await readChecks(c.db, project);
			const connectedAt = c.vars.github?.connectedAt;
			const setup =
				includeSnapshotSetup &&
				!session.readiness &&
				snapshotsFor(session.place) &&
				connectedAt !== undefined &&
				!rows.length
					? await setupRow(c.db, project)
					: undefined;
			const snapshotSetup =
				setup && connectedAt !== undefined
					? {
							command: setup.command,
							updatedAt: setup.updated_at,
							connectedAt,
							previouslySaved: setup.snapshot_connection === connectedAt,
						}
					: undefined;
			const screenshots = (await readDefaults(c.db, project)).screenshots && config.factory.screenshots;
			const browserImage =
				itemScreenshots(session.item, session.harness, screenshots) &&
				(session.place.kind === "hosted" || c.vars.machines.get(session.place.machineId)?.screenshots === true);
			const environment = snapshotSetup?.command
				? await sessionEnvironment(
						c,
						project,
						session.place.kind === "hosted" ? HOSTED : session.place.machineId,
						snapshotSetup.command,
						checks,
						session.hostedSize,
						browserImage,
					)
				: undefined;
			return {
				project,
				requestedNames,
				network,
				...(snapshotSetup?.command && { snapshotSetup }),
				...(environment && { environment }),
				...(redactOnly && { redactOnly }),
				screenshots,
				secrets: rows.map(row => ({
					name: row.name,
					scope: row.scope === "agent" ? "agent" : "setup",
					sealed: row.sealed,
				})),
				checks,
				account,
			};
		},

		[READINESS_TICK]: async (c, id: GithubId): Promise<void> => {
			const fire = c.scheduledFire;
			if (fire?.name !== scheduleName(id)) throw new UserError("This action is internal.", { code: "forbidden" });
			if (!c.vars.profile || !(await c.cron.get(fire.name))) return;
			const session = "s_" + digest(["readiness", id, fire.scheduledAt]).slice(0, 16);
			await assessRepository(c, c.vars.profile, id, session);
		},
		setGuideCheck: async (c, id: GithubId, enabled: boolean) => {
			requireUser(c);
			if (typeof enabled !== "boolean") throw new UserError("Choose whether to check guides.", { code: "bad_input" });
			await resolveRepository(requireGithub(), requireConnection(c), id, "write");
			await guideFilesFor(c, id).internalSetGuideCheck({ enabled });
			return repositoryView(c, id, setupKeyOf(id));
		},
		setSetupWeekly: async (c, id: GithubId, enabled: boolean): Promise<void> => {
			requireUser(c);
			setupKeyOf(id);
			if (typeof enabled !== "boolean") throw new UserError("Choose whether to run weekly.", { code: "bad_input" });
			if (enabled) await resolveRepository(requireGithub(), requireConnection(c), id, "read");
			await scheduleSetup(c.cron, id, enabled);
		},
		addSetupNotes: async (c, id: GithubId, files: NoteInput[]) => {
			const user = requireUser(c),
				project = setupKeyOf(id);
			await resolveRepository(requireGithub(), requireConnection(c), id, "write");
			const now = Date.now();
			await c.schedule.at(now + NOTE_LIFETIME, "internalExpireSetupNotes");
			await addNotes(c.db, user.uid, project, files, now);
			return repositoryView(c, id, project);
		},
		deleteSetupNote: async (c, id: GithubId, note: string) => {
			requireUser(c);
			const project = setupKeyOf(id);
			await c.db.execute("DELETE FROM setup_notes WHERE project=? AND id=?", project, note);
			await retireDrafters(c, c.key[0], project);
			return repositoryView(c, id, project);
		},
		internalExpireSetupNotes: async c => {
			if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
			const removed = await c.db.execute<{ project: string }>(
				"DELETE FROM setup_notes WHERE expires<=? RETURNING project",
				Date.now(),
			);
			for (const project of new Set(removed.map(r => r.project))) await retireDrafters(c, c.key[0], project);
		},
		internalSetupNoteFiles: async (c, session: string, ids: string[]) => {
			requireServiceFor(c, secretsCaller(c.key[0], session));
			const s = c.vars.sessions.get(session);
			if (!s?.readiness || !s.repository) throw new UserError("Setup session unavailable.", { code: "forbidden" });
			const selected = (await readNotes(c.db, setupKeyOf(s.repository.id))).filter(r => ids.includes(r.id));
			if (selected.length !== ids.length)
				throw new UserError("A selected note was deleted or expired.", { code: "bad_input" });
			return selected;
		},
		internalSetupPublished: async (
			c,
			session: string,
			publication: SetupPublication,
			decisions: NoteDecision[],
			installation: GithubId,
			source: string,
		) => {
			requireServiceFor(c, "call");
			const s = c.vars.sessions.get(session);
			if (!s?.readiness || !s.repository) throw new UserError("Setup session unavailable.", { code: "forbidden" });
			const id = s.repository.id;
			if (decisions.length)
				await c.cron.set({
					name: "setup-note-cleanup-" + id,
					expression: `${Number(BigInt(id) % 60n)} * * * *`,
					action: "internalCheckSetupPulls",
					args: [id],
					maxHistory: 0,
				});
			await c.db.transaction(tx => savePublication(tx, c.key[0], setupKeyOf(id), publication, decisions, session));
			const head = publication.head;
			await guideFilesFor(c, id).internalSetGuideCheck({ installation });
			// The PR's event can arrive before the installation is registered. Retry the check through the same queue.
			if (head)
				await c
					.client()
					.githubInbox.getOrCreate([String(installation)], { params: serviceParams() })
					.internalReceive({
						event: "pull_request",
						action: "opened",
						guid: "guide-" + id + "-" + head,
						installationId: installation,
						repositoryId: id,
						at: Date.now(),
						data: { pr: publication.pull.number, head, base: source, merged: false },
					});
		},
		// Reconcile missed close deliveries and installations without webhooks.
		internalCheckSetupPulls: async (c, id: GithubId) => {
			const job = "setup-note-cleanup-" + id;
			if (c.scheduledFire?.name !== job) throw new UserError("This action is internal.", { code: "forbidden" });
			const project = setupKeyOf(id);
			const rows = await c.db.execute<{ pr: number }>(
				"SELECT DISTINCT pr FROM setup_notes WHERE project=? AND pr IS NOT NULL AND expires>?",
				project,
				Date.now(),
			);
			if (!rows.length) {
				await c.cron.delete(job);
				return;
			}
			const app = requireGithub();
			const { installation, repository } = await resolveRepository(app, requireConnection(c), id, "read");
			await app.withToken(
				installation.id,
				{ repositoryId: id, permissions: { metadata: "read", pull_requests: "read" } },
				async token => {
					for (const { pr } of rows) {
						const pull = await app.pull(token, repository.owner, repository.name, pr);
						if (pull.state === "closed" || pull.state === "merged") {
							await c.db.transaction(tx => closeSetupPull(tx, project, pr, pull.state === "merged"));
							await retireDrafters(c, c.key[0], project);
						}
					}
				},
			);
		},
		internalSetupPullClosed: async (c, installation: GithubId, id: GithubId, pr: number, merged: boolean) => {
			requireServiceFor(c, "call");
			if (!c.vars.github?.installations.some(i => i.id === installation)) return;
			const project = setupKeyOf(id);
			await c.db.transaction(tx => closeSetupPull(tx, project, pr, merged));
			await retireDrafters(c, c.key[0], project);
		},
		runReadiness: async (
			c,
			id: GithubId,
			notes: string[] = [],
			answers?: Record<string, "keep" | "drop">,
		): Promise<RepositoryView> => {
			const profile = requireUser(c);
			await assessRepository(c, profile, id, undefined, notes, answers);
			return repositoryView(c, id, setupKeyOf(id));
		},
		internalReadinessResult: async (
			c,
			session: string,
			attempt: string,
			report: Judgment | string | null,
			diagnosis?: import("../repo-setup/types.js").SetupDiagnosis | null,
		): Promise<void> => {
			requireServiceFor(c, "call");
			const current = c.vars.sessions.get(session);
			if (!current?.readiness || !current.repository) return;
			const [pending] = await c.db.execute(
				"SELECT 1 FROM readiness WHERE session=? AND judgment IS NULL AND error IS NULL",
				attempt,
			);
			if (!pending) return;
			const keep =
				(await c.db.execute("SELECT 1 FROM setup_notes WHERE drafter=? AND expires>? LIMIT 1", session, Date.now()))
					.length > 0;
			if (keep) await sessionActor(c, c.key[0], session).internalFreeSandbox();
			await finishAssessment(c.db, attempt, report ?? "The turn ended before filing its setup checks.", diagnosis);
			if (!keep) await removeSession(c, c.key[0], session);
			await retireDrafters(c, c.key[0], setupKeyOf(current.repository.id));
		},
		internalReadinessLevel: async (c, key: string | GithubId) => {
			requireServiceFor(c, "call");
			return (await repoPolicy(c, setupKeyOf(key))).readiness.latest?.level ?? null;
		},
		repository: async (c, repositoryId: GithubId): Promise<RepositoryView> => {
			requireUser(c);
			const project = setupKeyOf(repositoryId);
			try {
				return await repositoryView(c, repositoryId, project);
			} catch (error) {
				throw clientError(c.log, error, "What is saved for the repository could not be read. Try again.");
			}
		},

		githubRepository: async (c, repositoryId: GithubId): Promise<GithubRepository> => {
			requireUser(c);
			const project = setupKeyOf(repositoryId);
			const app = requireGithub();
			const connection = requireConnection(c);
			let found: GithubRepository;
			try {
				found = (await resolveRepository(app, connection, repositoryId, "read")).described;
			} catch (error) {
				throw githubError(c.log, error, "The repository could not be checked at GitHub. Try again.");
			}
			const name = `${found.owner}/${found.name}`;
			try {
				for (const table of [
					"setup_command",
					"repository_checks",
					"repo_secret",
					"repository_defaults",
					"repository_network",
				])
					await c.db.execute(`UPDATE ${table} SET label = ? WHERE project = ? AND label != ?`, name, project, name);
			} catch (error) {
				c.log.warn({ msg: "could not note what a repository is called now", project, error: String(error) });
			}
			return found;
		},

		saveRepositoryDefaults: async (
			c,
			input: RepositoryDefaultsPatch & { repositoryId: GithubId },
		): Promise<RepositoryDefaults> => {
			const profile = requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			if (input.offer !== undefined) return (await repoPolicy(c, project, false, null, input)).defaults;
			let change: DefaultsChange;
			try {
				change = await cleanRunDefaults(c, input, profile);
				if (change.screenshots === true && !config.factory.screenshots)
					throw new DefaultsProblem(
						"bad_input",
						"Screenshots are turned off for this whole deployment, so they cannot be turned on for a repository.",
					);
			} catch (error) {
				if (error instanceof DefaultsProblem) throw new UserError(error.message, { code: error.code });
				throw clientError(c.log, error, "The defaults could not be saved. Try again.");
			}
			try {
				const label = await labelFor(c, input.repositoryId, project);
				const saved = await c.db.transaction(async tx => {
					if (change.autoApprovePlans !== undefined)
						await tx.execute("DELETE FROM setup_offer WHERE project=? AND offer='Small plans'", project);
					if (change.autoMergeSingles !== undefined)
						await tx.execute("DELETE FROM setup_offer WHERE project=? AND offer!='Small plans'", project);
					await applyPlaceChange(change, input, c.vars.machines, () => readDefaults(tx, project));
					return saveDefaults(tx, project, label, change, Date.now());
				});
				console.log(repositoryDefaultsLog(profile.uid, project, change));
				if ((await c.db.execute("SELECT 1 FROM setup_offer WHERE project=? AND off=0 LIMIT 1", project)).length)
					return (await repoPolicy(c, project)).defaults;
				return saved;
			} catch (error) {
				throw clientError(c.log, error, "The defaults could not be saved. Try again.");
			}
		},

		forgetRepositoryApproval: async (c, input: { repositoryId: GithubId; name: string }): Promise<RepositoryView> => {
			const profile = requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			const name = boundedText(input?.name, 200);
			try {
				const done = await changeApprovals(c, book => book.forget(project, name));
				if (done.removed.length > 0)
					console.log(`[wlp] server.approval_forgotten uid=${profile.uid} project=${project} server=${logged(name)}`);
				return await repositoryView(c, input.repositoryId, project);
			} catch (error) {
				throw clientError(c.log, error, "The approval could not be forgotten. Try again.");
			}
		},

		forgetRepository: async (c, repositoryId: GithubId): Promise<RepositoryView> => {
			const profile = requireUser(c);
			const project = setupKeyOf(repositoryId);
			try {
				// The secrets first: if anything after them fails, what is left holds no value.
				await c.db.execute("DELETE FROM repo_secret WHERE project = ?", project);
				await c.db.execute("DELETE FROM setup_command WHERE project = ?", project);
				await c.db.execute("DELETE FROM repository_checks WHERE project = ?", project);
				await c.db.execute("DELETE FROM repository_defaults WHERE project = ?", project);
				await c.db.execute("DELETE FROM repository_network WHERE project = ?", project);
				await c.db.execute("DELETE FROM network_request WHERE project = ?", project);
				await scheduleSetup(c.cron, repositoryId, false);
				await c.cron.delete("setup-note-cleanup-" + repositoryId);
				await c.db.execute("DELETE FROM setup_scan WHERE project=?", project);
				await c.db.execute("DELETE FROM setup_offer WHERE project=?", project);
				await c.db.execute("DELETE FROM readiness WHERE project=?", project);
				await c.db.execute("DELETE FROM setup_notes WHERE project=?", project);
				await retireDrafters(c, profile.uid, project);
				await c.db.execute("DELETE FROM setup_publication WHERE project=?", project);
				await changeEnvironments(c, host => forgetEnvironments(host, project));
				const done = await changeApprovals(c, book => book.forgetProject(project));
				await dropHostedSnapshots(profile.uid, String(repositoryId));
				console.log(
					`[wlp] repository.forgotten uid=${profile.uid} project=${project} approvals=${done.removed.length}`,
				);
				return await repositoryView(c, repositoryId, project);
			} catch (error) {
				throw clientError(c.log, error, "What is saved for the repository could not be deleted. Try again.");
			}
		},

		savedRepositories: async (c): Promise<SavedRepository[]> => {
			requireUser(c);
			try {
				const rows = await c.db.execute<{ project: string; label: string }>(
					"SELECT project, MAX(label) AS label FROM (SELECT project, label FROM setup_command UNION ALL SELECT project, label FROM repository_checks UNION ALL SELECT project, label FROM repo_secret UNION ALL SELECT project, label FROM repository_defaults UNION ALL SELECT project, label FROM repository_network) GROUP BY project",
				);
				const now = Date.now();
				const found = new Map<GithubId, string>();
				const note = (project: string, label: string) => {
					const id = repositoryIdOf(project);
					if (id !== null && (found.get(id) ?? "") === "") found.set(id, label);
				};
				for (const row of rows) note(row.project, row.label);
				for (const approval of c.vars.approvals.all())
					if (approval.expiresAt > now) note(approval.project, approval.label);
				return [...found]
					.map(([id, label]) => ({ id, name: repositoryLabel(c.vars, id) || label || null }))
					.sort(
						(a, b) =>
							Number(a.name === null) - Number(b.name === null) ||
							(a.name ?? "").localeCompare(b.name ?? "") ||
							String(a.id).localeCompare(String(b.id), "en", { numeric: true }),
					)
					.slice(0, MAX_SAVED_REPOSITORIES);
			} catch (error) {
				throw clientError(c.log, error, "The repositories something is saved for could not be listed. Try again.");
			}
		},

		account: async (c): Promise<AccountSettings> => {
			requireUser(c);
			try {
				return await accountView(c.db);
			} catch (error) {
				throw clientError(c.log, error, "Your settings could not be read. Try again.");
			}
		},

		saveAccountDefaults: async (c, input: AccountDefaultsPatch): Promise<AccountDefaults> => {
			const profile = requireUser(c);
			let change: DefaultsChange;
			try {
				change = await cleanRunDefaults(c, input, profile);
			} catch (error) {
				if (error instanceof DefaultsProblem) throw new UserError(error.message, { code: error.code });
				throw clientError(c.log, error, "The defaults could not be saved. Try again.");
			}
			try {
				const saved = await c.db.transaction(async tx => {
					await applyPlaceChange(change, input, c.vars.machines, () => readAccountDefaults(tx));
					return saveAccountDefaults(tx, change, Date.now());
				});
				console.log(
					`[wlp] defaults.saved uid=${profile.uid} project=account${change.profile === undefined ? "" : ` profile=${change.profile ?? "none"}`}${change.model === undefined ? "" : ` model=${change.model ?? "none"}`}`,
				);
				return saved;
			} catch (error) {
				throw clientError(c.log, error, "The defaults could not be saved. Try again.");
			}
		},

		savePersonalServer: async (
			c,
			input: { name: string; definition: unknown; unasked?: boolean; existing?: boolean },
		): Promise<AccountSettings> => {
			const profile = requireUser(c);
			// Decided before anything is awaited: what is stored is what Windlass takes, or nothing is.
			const name = serverInput(() => cleanServerName(input?.name));
			const definition = serverInput(() => cleanServerDefinition(input?.definition));
			const unasked = serverInput(() => cleanUnasked(input?.unasked));
			const existing = input?.existing === true;
			try {
				if (existing) await changeServer(c.db, name, definition, unasked, Date.now());
				else await addServer(c.db, name, definition, unasked, Date.now());
			} catch (error) {
				if (error instanceof ServerProblem) throw new UserError(error.message, { code: error.code });
				throw clientError(c.log, error, "The server could not be saved. Try again.");
			}
			console.log(
				`[wlp] server.saved uid=${profile.uid} name=${name} kind=${typeof definition.url === "string" ? "address" : "command"} unasked=${unasked} definition=${existing ? "replaced" : "new"}`,
			);
			try {
				return await accountView(c.db);
			} catch (error) {
				throw clientError(
					c.log,
					error,
					"The server was saved, but your settings could not be read again. Reload the page.",
				);
			}
		},

		deletePersonalServer: async (c, name: string): Promise<AccountSettings> => {
			const profile = requireUser(c);
			const named = boundedText(name, 200);
			try {
				await deleteServer(c.db, named);
				console.log(`[wlp] server.deleted uid=${profile.uid} name=${logged(named)}`);
				return await accountView(c.db);
			} catch (error) {
				throw clientError(c.log, error, "The server could not be deleted. Try again.");
			}
		},

		modelProviders: c => modelProviderActions.modelProviders(c),
		saveModelProvider: async (c, input: { provider: ModelProvider; key: string }) => {
			const saved = await modelProviderActions.saveModelProvider(c, input);
			await credentialsChanged(c);
			return saved;
		},
		checkModelProvider: (c, provider: ModelProvider) => modelProviderActions.checkModelProvider(c, provider),
		removeModelProvider: async (c, provider: ModelProvider) => {
			await modelProviderActions.removeModelProvider(c, provider);
			await credentialsChanged(c);
		},
		internalModelKeys: c => modelProviderActions.internalModelKeys(c),
		internalCredentialGeneration: (c, ref: unknown, onMachine?: boolean) =>
			credentialActions.internalCredentialGeneration(c, ref, onMachine === true),
		internalCredential: (c, ref: unknown, nonce: string, onMachine?: boolean) =>
			credentialActions.internalCredential(c, ref, nonce, chatgptPlan(c), onMachine === true),

		modelPlans: c => credentialActions.modelPlans(c),
		approvePlanConnect: (c, userCode: string, provider: PlanProvider) =>
			credentialActions.approvePlanConnect(c, userCode, provider),
		denyPlanConnect: (c, userCode: string) => credentialActions.denyPlanConnect(c, userCode),
		removeModelPlan: async (c, provider: PlanProvider) => {
			await credentialActions.removeModelPlan(c, provider, chatgptPlan(c));
			await credentialsChanged(c);
		},
		recheckModelPlan: async (c, provider: PlanProvider) => {
			const plan = await credentialActions.recheckModelPlan(c, provider, chatgptPlan(c));
			await credentialsChanged(c);
			return plan;
		},
		internalPlanModels: (c, ref: unknown, ids: unknown) => credentialActions.internalPlanModels(c, ref, ids),
		internalConnectPlan: async (c, provider: PlanProvider, digest: string, sealed: string) => {
			const plan = await credentialActions.internalConnectPlan(c, provider, digest, sealed, chatgptPlan(c));
			await credentialsChanged(c);
			return plan;
		},

		payWith: async (c): Promise<PayWithChoice[]> => {
			requireUser(c);
			return readPayWith(c.db);
		},
		savePayWith: async (c, input: PayWithPatch): Promise<PayWithChoice[]> => {
			const profile = requireUser(c);
			let patch: PayWithPatch;
			try {
				patch = payWithPatchOf(input);
			} catch (error) {
				if (error instanceof PayWithProblem) throw new UserError(error.message, { code: "bad_input" });
				throw error;
			}
			try {
				const saved = await savePayWith(c.db, patch);
				console.log(
					`[wlp] paywith.saved uid=${profile.uid} harness=${patch.harness} pay=${patch.payWith} limited=${patch.whenLimited ?? "default"}`,
				);
				// Items waiting for a plan may run on the key now, or the other way round.
				queueChanged(c);
				return saved;
			} catch (error) {
				throw clientError(c.log, error, "Your choice could not be saved. Try again.");
			}
		},

		useKeyNow: async (c, itemId: string): Promise<void> => {
			requireUser(c);
			const item = typeof itemId === "string" ? c.vars.items.items.get(itemId) : undefined;
			if (!item?.wait?.plan?.keyNow || !(await useKeyOnce(c, item.sessionId)))
				throw new UserError("No saved key can pay for this item's turn now.", { code: "bad_input" });
			console.log(`[wlp] paywith.key_now uid=${c.key[0]} item=${itemId}`);
			queueChanged(c);
		},
		/** Pay with at a turn's start (user-payer.ts); null for a turn the rule does not decide. */
		internalTurnPayer: async (
			c,
			input: { sessionId: string; model: string; keyOnce?: boolean; machine?: boolean },
		): Promise<PayerAnswer | null> => {
			requireServiceFor(c, "call");
			return turnPayer(c, input.sessionId, input.model, input.keyOnce === true, input.machine === true);
		},
		/** What a plan's relay saw the provider say of it (credentials/plan-health.ts), while it is at `generation`. */
		internalObservePlan: async (c, provider: PlanProvider, generation: string, seen: RelaySeen): Promise<void> => {
			requireServiceFor(c, modelKeyCaller(c.key[0]!));
			const seenOf = relaySeenOf(seen);
			if (!isPlanProvider(provider) || typeof generation !== "string" || !seenOf) return;
			const before = (await planStatuses(c.db)).find(plan => plan.provider === provider);
			const after = await observePlan(c.db, provider, generation, planReading(provider, seenOf, Date.now()));
			if (after && (after.health !== before?.health || after.limitedUntil !== before?.limitedUntil)) queueChanged(c);
		},

		accountSecrets: async (c, input: { profile: string }): Promise<AccountSecrets> => {
			requireUser(c);
			const profile = await secretProfile(input?.profile);
			try {
				return await listAccountSecrets(c.db, profile);
			} catch (error) {
				throw clientError(c.log, error, "Your account's secrets could not be read. Try again.");
			}
		},

		saveAccountSecret: async (
			c,
			input: { profile: string; name: string; value?: string; scope: SecretScope },
		): Promise<AccountSecrets> => {
			const user = requireUser(c);
			const profile = await secretProfile(input?.profile);
			const name = secretInput(() => cleanSecretName(input?.name));
			const scope = secretInput(() => cleanSecretScope(input?.scope));
			const value =
				input?.value === undefined || input?.value === null
					? undefined
					: secretInput(() => cleanSecretValue(input.value));
			try {
				await saveAccountSecret(
					c.db,
					name,
					scope,
					value === undefined ? undefined : sealSecret(serverSealer(), user.uid, ACCOUNT_SECRET_PROJECT, name, value),
					Date.now(),
				);
			} catch (error) {
				if (error instanceof TooManySecrets) throw new UserError(error.message, { code: "too_many_secrets" });
				if (error instanceof SecretNotFound) throw new UserError(error.message, { code: "secret_not_found" });
				throw clientError(c.log, error, "The secret could not be saved. Try again.");
			}
			console.log(
				`[wlp] secret.saved uid=${user.uid} project=${ACCOUNT_SECRET_PROJECT} name=${name} scope=${scope} value=${value === undefined ? "kept" : "saved"}`,
			);
			try {
				return await listAccountSecrets(c.db, profile);
			} catch (error) {
				throw clientError(c.log, error, "The secret was saved, but the list could not be read again. Reload the page.");
			}
		},

		deleteAccountSecret: async (c, input: { profile: string; name: string }): Promise<AccountSecrets> => {
			const user = requireUser(c);
			const profile = await secretProfile(input?.profile);
			const name = boundedText(input?.name, 200);
			try {
				await deleteAccountSecret(c.db, name);
				console.log(
					`[wlp] secret.deleted uid=${user.uid} project=${ACCOUNT_SECRET_PROJECT} name=${name.replace(/[^A-Za-z0-9_]/g, "?")}`,
				);
				return await listAccountSecrets(c.db, profile);
			} catch (error) {
				throw clientError(c.log, error, "The secret could not be deleted. Try again.");
			}
		},

		internalGithubClaim: async (c, nonce: string): Promise<{ ok: boolean; verifier: string | null }> => {
			requireService(c);
			if (typeof nonce !== "string" || nonce === "") return { ok: false, verifier: null };
			const [row] = await c.db.execute<{ verifier: string | null; expires_at: number }>(
				"SELECT verifier, expires_at FROM github_nonce WHERE nonce = ? AND kind = 'state'",
				nonce,
			);
			if (!row) return { ok: false, verifier: null };
			await c.db.execute("DELETE FROM github_nonce WHERE nonce = ? AND kind = 'state'", nonce);
			return row.expires_at > Date.now() ? { ok: true, verifier: row.verifier } : { ok: false, verifier: null };
		},

		/** A new state for this user, for the visit to the installation page that follows an authorization with nothing installed. */
		internalGithubState: async (c, origin: string): Promise<{ state: string }> => {
			requireService(c);
			const nonce = newNonce();
			await rememberPending(c, nonce, null);
			return { state: issueState(c.key[0]!, nonce, String(origin)) };
		},

		internalUpdateGithubInstallation: async (c, change: InstallationChange) => {
			requireServiceFor(c, "call");
			await updateGithubInstallation(c, c.key[0], change);
		},

		[GITHUB_SYNC.action]: async (c, attempt: number) => {
			if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
			await retryGithubSync(c, c.key[0]!, c.scheduledFire.id, attempt);
		},

		internalGithubConnection: (c): StoredConnection | null => {
			requireService(c);
			return c.vars.github;
		},

		internalServerApprovals: async (c, project: string): Promise<ServerApproval[]> => {
			requireService(c);
			const now = Date.now();
			// What has run out is dropped when somebody looks: nothing is scheduled for it.
			await changeApprovals(c, book => book.prune(now));
			return c.vars.approvals.of(boundedText(project, 600), now);
		},

		internalServerApprove: async (
			c,
			input: { project: string; label: string; name: string; fingerprint: string },
		): Promise<ServerApproval[]> => {
			requireService(c);
			const project = boundedText(input?.project, 600);
			const name = boundedText(input?.name, 200);
			const fingerprint = boundedText(input?.fingerprint, 200);
			if (project === "" || name === "" || fingerprint === "")
				throw new UserError("That approval names no project, server or definition.", { code: "bad_input" });
			const now = Date.now();
			await changeApprovals(c, book => {
				const pruned = book.prune(now);
				const approved = book.approve({ project, label: boundedText(input.label, 600), name, fingerprint }, now);
				return { added: approved.added, removed: [...pruned.removed, ...approved.removed] };
			});
			console.log(`[wlp] server.approval_remembered uid=${c.key[0]} project=${project} server=${name}`);
			return c.vars.approvals.of(project, now);
		},

		internalServerForget: async (
			c,
			input: { project: string; name: string },
		): Promise<{ forgotten: number; approvals: ServerApproval[] }> => {
			requireService(c);
			const project = boundedText(input?.project, 600);
			const name = boundedText(input?.name, 200);
			const now = Date.now();
			const done = await changeApprovals(c, book => book.forget(project, name));
			const forgotten = done.removed.filter(row => row.expiresAt > now).length;
			if (done.removed.length > 0)
				console.log(`[wlp] server.approval_forgotten uid=${c.key[0]} project=${project} server=${name}`);
			return { forgotten, approvals: c.vars.approvals.of(project, now) };
		},
		internalAdoptSignIn: signinActions.internalAdoptSignIn,
		internalSignInStatus: signinActions.internalSignInStatus,
		internalSignOut: signinActions.internalSignOut,
		internalAccessToken: signinActions.internalAccessToken,
		internalModels: signinActions.internalModels,

		internalRemoveBackup: async (c, sessionId: string): Promise<void> => {
			// RivetKit sets `scheduledFire` on the context of a call its schedule makes; a client cannot.
			if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
			const [row] = await c.db.execute<{ tries: number; schedule_id: string; machine: string | null }>(
				"SELECT tries, schedule_id, machine FROM backup_removal WHERE session = ?",
				sessionId,
			);
			if (!row || row.schedule_id !== c.scheduledFire.id) return;
			const owner = { uid: c.key[0]!, sessionId };
			const tries = row.tries + 1;
			let object = row.machine ? `machine ${row.machine}` : `sessions/${owner.uid}/${sessionId}.tgz`;
			try {
				if (row.machine) {
					// Recorded with the machine's actor, which has its runner remove it when it is next connected.
					await machineActor(() => c.client(), owner.uid, row.machine).removeBackup(sessionId);
				} else {
					const { backups } = await getLayer();
					if (!backups) throw new Error("the server has no bucket configured");
					object = backups.keyOf(owner);
					// An object that is gone already counts as removed: the store answers a delete of it as done.
					await backups.remove(owner);
				}
				await c.db.execute("DELETE FROM backup_removal WHERE session = ?", sessionId);
				console.log(`[wlp] backup.removed session=${sessionId} tries=${tries}`);
			} catch (error) {
				if (tries < BACKUP_REMOVE_TRIES) {
					console.warn(
						`[wlp] backup.remove_retry uid=${owner.uid} session=${sessionId} try=${tries}: ${String(error)}`,
					);
					await armBackupRemoval(c, sessionId, tries, row.machine);
					return;
				}
				await c.db.execute("DELETE FROM backup_removal WHERE session = ?", sessionId);
				console.error(
					`[wlp] backup.remove_failed uid=${owner.uid} session=${sessionId} object=${object}: gave up after ${tries} tries; the copy of this deleted session's agent data may still be ${row.machine ? "on its machine" : "in the bucket"} (${String(error)})`,
				);
			}
		},

		internalSessionChanged: async (c, summary: SessionSummary): Promise<void> => {
			requireService(c);
			if (typeof summary?.id !== "string" || !c.vars.sessions.has(summary.id)) return;
			await storeReport(c, summary);
			if (c.vars.sessions.get(summary.id)?.status === "idle") queueChanged(c);
		},

		internalRemoveBackupLater: async (c, sessionId: string, machineId?: string): Promise<void> => {
			requireService(c);
			if (typeof sessionId !== "string" || sessionId === "")
				throw new UserError("A session id is needed.", { code: "bad_request" });
			if (machineId !== undefined && (typeof machineId !== "string" || !MACHINE_ID.test(machineId)))
				throw new UserError("That machine id is not one.", { code: "bad_request" });
			const [pending] = await c.db.execute<{ session: string }>(
				"SELECT session FROM backup_removal WHERE session = ?",
				sessionId,
			);
			if (pending) return;
			await armBackupRemoval(c, sessionId, 0, machineId ?? null);
			console.log(
				`[wlp] backup.remove_deferred uid=${c.key[0]} session=${sessionId}: tried again in ${BACKUP_REMOVE_FIRST_MS / 1000} s`,
			);
		},

		internalCheckLaunch: async (c, id: string, until: number): Promise<void> => {
			if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
			if (c.vars.launchUntil.get(id) !== until) return;
			const entry = c.vars.sessions.get(id);
			if (!entry) return;
			const fresh = await sessionActor(c, c.key[0], id)
				.internalSummary()
				.catch((error: unknown) => {
					if (isSessionGone(error)) return null;
					throw error;
				});
			if (c.vars.launchUntil.get(id) !== until) return;
			if (fresh) await storeReport(c, fresh, until);
			else if (c.vars.sessions.get(id) === entry) await forgetSession(c, id);
			queueChanged(c);
		},

		internalAcquireRun: async (
			c,
			sessionId: string,
			model?: string,
		): Promise<{
			dailyTokenWait?: string;
			ok: boolean;
			running: number;
			known: boolean;
			until: number | null;
			claim: number | null;
		}> => {
			requireService(c);
			const uid = c.key[0];
			// An item session's turn holds a slot of the turn queue (user-items.ts), counted here instead of by its summary.
			// A session on one of the user's machines is neither counted nor refused (`hostedLimitsApply`).
			const others = () =>
				[...c.vars.sessions.values()].filter(
					session =>
						session.id !== sessionId && !session.item && session.status !== "idle" && hostedLimitsApply(session.place),
				);
			// One ceiling on what the platform pays for: the user's hosted sandboxes at work, their own and their items' (`hostedRunning`).
			const atLimit = () =>
				others().length + factorySlots(c) >= accountLimits(c.vars.items.limits).factory.hostedRunning;
			const asking = c.vars.sessions.get(sessionId);

			// At the limit, ask the sessions that look busy: one whose report never arrived would
			// otherwise block the user for good.
			if ((!asking || hostedLimitsApply(asking.place)) && atLimit()) {
				await Promise.all(
					others().map(async stale => {
						const checkedAt = Date.now();
						let fresh: SessionSummary | null = null;
						try {
							fresh = await sessionActor(c, uid, stale.id).internalSummary();
						} catch (error) {
							if (isSessionGone(error)) {
								if (c.vars.sessions.get(stale.id) === stale) await forgetSession(c, stale.id);
							} else
								c.log.warn({ msg: "could not refresh a session's summary", session: stale.id, error: String(error) });
						}
						if (fresh && c.vars.sessions.get(stale.id) === stale) await storeReport(c, fresh, checkedAt);
					}),
				);
			}

			// The user's index can still be a turn behind. The session asking for the slot
			// cannot start its next turn until we answer, so this is its actual starting count.
			const own =
				asking && hostedLimitsApply(asking.place) ? await sessionActor(c, uid, sessionId).internalSummary() : null;
			const tokenWait = asking && usesPlatformModel(asking.harness, model ?? asking.model) ? accountTokenWait(c) : null;
			// From here to the `set` nothing is awaited: the count and the claim are one step.
			const entry = c.vars.sessions.get(sessionId);
			if (!entry) return { ok: false, running: others().length, known: false, until: null, claim: null };
			const running = others().length;
			if (tokenWait) return { dailyTokenWait: tokenWait, ok: false, running, known: true, until: null, claim: null };
			if (hostedLimitsApply(entry.place) && atLimit())
				return { ok: false, running: running + factorySlots(c), known: true, until: null, claim: null };
			const claimed: SessionSummary = {
				...entry,
				turns: own?.turns ?? entry.turns,
				status: entry.status === "idle" ? "starting" : entry.status,
			};
			// The lease lapses at `until` (`internalCheckLaunch`); the claim is named by its generation (`internalReleaseRun`), one more
			// than any claim before it, taken in this same step: the time names nothing, since two claims can share a millisecond.
			const until = hostedLimitsApply(entry.place)
				? Math.max(Date.now() + LAUNCH_LEASE_MS, (c.vars.launchUntil.get(sessionId) ?? 0) + 1)
				: null;
			const claim = until === null ? null : ++c.vars.launchGen;
			if (until !== null) c.vars.launchUntil.set(sessionId, until);
			if (claim !== null) c.vars.launchClaim.set(sessionId, claim);
			c.vars.sessions.set(sessionId, claimed);

			if (claim !== null)
				await c.db.execute(
					"INSERT INTO launch_counter (id, last) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET last = MAX(last, excluded.last)",
					claim,
				);
			if (until !== null) await c.schedule.at(until, "internalCheckLaunch", sessionId, until);
			await c.db.execute(
				"UPDATE sessions SET summary = ?, launch_until = ?, launch_claim = ? WHERE id = ?",
				JSON.stringify(claimed),
				until,
				claim,
				sessionId,
			);
			broadcastSessions(c);
			if (entry.place.kind === "machine" && keptFull(c, entry)) await makeSandboxRoom(c, entry);
			return { ok: true, running: running + factorySlots(c) + 1, known: true, until, claim };
		},

		// A stale release must never clear a later claim.
		internalReleaseRun: async (
			c,
			input: { sessionId: string; claim: number; summary: SessionSummary },
		): Promise<{ released: boolean }> => {
			requireService(c);
			const sessionId = input?.sessionId;
			if (typeof sessionId !== "string" || typeof input.claim !== "number" || input.summary?.id !== sessionId) {
				throw new UserError("A session, its claim and its summary are needed.", { code: "bad_request" });
			}
			// From the check to the delete nothing is awaited: a claim made meanwhile cannot be the one released.
			if (c.vars.launchClaim.get(sessionId) !== input.claim) return { released: false };
			c.vars.launchUntil.delete(sessionId);
			c.vars.launchClaim.delete(sessionId);
			await storeReport(c, input.summary);
			queueChanged(c);
			console.log(`[wlp] run.released uid=${c.key[0]} session=${sessionId}`);
			return { released: true };
		},
		internalReserve: usageActions.internalReserve,
		internalClaimPlace: usageActions.internalClaimPlace,
		internalSettle: usageActions.internalSettle,
		internalSweepSandboxes: usageActions.internalSweepSandboxes,
		internalRelease: usageActions.internalRelease,
	},
});
