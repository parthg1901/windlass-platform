/**
 * How the actors call each other. Each call goes through `c.client()` with a short-lived service token
 * as its credential (see tokens.ts); the actions on this page accept nothing else.
 *
 * The same credential is what a server shows the `user` actor when it asks for a user's sign-in or
 * access token (`internalAdoptSignIn`, `internalSignInStatus`, `internalSignOut`, `internalAccessToken`).
 * Those calls are not made from here: the code that runs a turn has no actor's `c`, so
 * signin/directory.ts makes them with a client of its own.
 */

import type { HoldReport } from "../usage.js";
import { UserError } from "rivetkit";
import type { CreateSandboxInput, SavedBackup } from "../sandbox/api.js";
import type {
	EnvironmentBuild,
	GithubId,
	HarnessOptions,
	HarnessId,
	HostedSize,
	ItemAction,
	ItemSummary,
	ItemView,
	ModelList,
	PartScreenshots,
	ModelProvider,
	RepositoryAutonomy,
	RepositoryCheck,
	RepositorySetup,
	SandboxPlace,
	SandboxProfileId,
	SecretScope,
	SessionSummary,
	UsageNumbers,
} from "../contract.js";
import type { Fact } from "../factory/types.js";
import type { SignInMethod } from "../sandbox/harnesses.js";
import type { Delivery, TurnAnswer, TurnRelease, TurnRequest } from "./session-inbox.js";
import type { ItemCreateInput, ItemPublishAnswer } from "./work-item.js";
import type { ItemFacts } from "./user-items.js";
import { serviceParams } from "../auth.js";
import type { StoredRepository } from "../github/publish.js";
import type { StoredConnection } from "../github/repos.js";
import type { ServerApproval } from "../server-approvals.js";
import { issueServiceToken, verifyToken } from "../tokens.js";

/** What `user` passes when it creates an `agentSession`. */
export interface SessionCreateInput {
	readiness?: {
		attempt: string;
		commit: string;
		model?: string;
		effort?: string;
		draft?: import("../repo-setup/types.js").DraftRequest;
	};
	size?: number;
	/** Hosted only, where the layer offers sizes (`Sandboxes.sizes`): the sandbox's size. */
	hostedSize?: HostedSize;
	mode?: string;
	harness?: HarnessId;
	harnessOptions?: HarnessOptions;
	codexModes?: HarnessOptions["modes"];
	/** A service token bound to this actor's key: proof that `user` created it. */
	grant: string;
	title: string;
	titleIsTyped: boolean;
	place: SandboxPlace;
	/** For a place on one of the user's machines: its name when the session was launched. */
	machineName?: string;
	profile: SandboxProfileId;
	model: string;
	repoUrl: string | null;
	/** Set when the session is launched on a repository of the user's GitHub connection; `repoUrl` is then its address. */
	repo?: StoredRepository | null;
	/** With `repo`: whether the agent may have the platform publish without the user being asked each time. */
	publishUnasked?: boolean;
	demo: boolean;
	createdAt: number;
	/**
	 * Set for a work item's session: its prompts come from that item (session-inbox.ts). Absent: a person's.
	 * `signIn`: how the machine's agent signed in when the item was filed, where that counts its tokens (harnesses.ts, `itemTokensOf`).
	 */
	origin?: {
		kind: "item";
		itemId: string;
		role?: "builder" | "reviewer";
		planCritic?: true;
		afterPlanning?: { model: string; effort: string | null };
		subtaskScreenshots?: boolean;
		owns?: string[];
		childBranch?: { name: string; start: string };
		size?: number;
		effort?: string;
		signIn?: SignInMethod;
		payer?: import("../contract.js").CredentialSource;
		payerSource?: "account" | "deployment";
	};
	/** Set for a session that only builds the repository's prepared environment at its place (user-environments.ts). */
	environmentBuild?: EnvironmentBuildOrigin;
	/** A person's session: the effort its turns run at unless a prompt names another. */
	effort?: string | null;
	/** Set for a session made to continue another (`continueSession`). */
	continuation?: Continuation;
}

/** What a continuing session's agent is told of the session it continues, once (workspace.ts, `platformNotes`). */
export interface ContinuedFrom {
	id: string;
	title: string;
	/** The earlier session's pull request, if it had one. */
	pull: number | null;
	/** The branch the new workspace starts from. */
	base: string;
	/** True when `base` is the earlier session's pushed branch. */
	stacked: boolean;
}

/** An account of an earlier session for an agent without its memory (turn-resume.ts, `sessionHandoff`), and the sources of what it quotes. */
export interface Handoff {
	text: string;
	untrusted: string[];
}

/** What a session made by `continueSession` starts with, beside the settings `makeSession` takes. */
export interface Continuation {
	from: ContinuedFrom;
	/** The earlier agent session, copied to this session's name in the backup store: its first sandbox restores it. */
	copy: { windlassSessionId: string; backup: SavedBackup } | null;
	/**
	 * On a machine: the earlier agent session's copy, for this session to copy to its own name on the machine
	 * when its first sandbox is made. The runner takes a copy only over the new session's own connection.
	 */
	machineCopy?: MachineCopy | null;
	handoff: Handoff | null;
	tainted: boolean;
	secretRequestBlocked: boolean;
}

/** The earlier session's copy on a machine, still to be copied to the continuing session's name (`Continuation.machineCopy`). */
export interface MachineCopy {
	from: string;
	windlassSessionId: string;
	backup: SavedBackup;
}

/** What the session being continued tells `user` (`internalForkSource`). */
export interface ForkSource {
	title: string;
	harness?: HarnessId;
	model: string;
	effort: string | null;
	mode: string;
	place: SandboxPlace;
	size?: number;
	hostedSize?: HostedSize;
	profile: SandboxProfileId;
	repo: StoredRepository;
	/** The branch the session pushed to, once it has pushed. */
	pushedBranch: string | null;
	pull: number | null;
	tainted: boolean;
	secretRequestBlocked: boolean;
	/** The agent's session and its saved copy, when the copy is of that session and up to date. */
	copy: { windlassSessionId: string; backup: SavedBackup } | null;
	handoff: Handoff | null;
}

/** What a build session reports: its build, without what the user actor set when it started it. */
export type EnvironmentBuildResult = Omit<
	EnvironmentBuild,
	"trigger" | "retries" | "interrupted" | "startedAt" | "setupHash" | "checksHash" | "profile"
>;

export type EnvironmentBuildReport = EnvironmentBuildResult | { interrupted: true } | { waiting: string };

/** What a build session builds: `screenshots`, the image variant item sessions there use. */
export interface EnvironmentBuildOrigin {
	project: string;
	place: string;
	screenshots: boolean;
}

/** Subtask builders carry the approved choice, including false. Other work items follow the repository permission. */
export function itemScreenshots(
	item: { subtaskScreenshots?: boolean } | undefined,
	harness: SessionSummary["harness"],
	allowed: boolean,
): boolean {
	return allowed && !!item && item.subtaskScreenshots !== false && (harness ?? "windlass") === "windlass";
}

/** The image requested when creating or replacing a session's sandbox. */
export function sessionSandboxInput(
	session: Pick<CreateSandboxInput, "uid" | "sessionId" | "profile"> &
		Pick<SessionCreateInput, "size" | "origin" | "harness" | "environmentBuild" | "hostedSize" | "readiness">,
	screenshots = false,
): CreateSandboxInput {
	const { uid, sessionId, profile, origin } = session;
	const size = session.size ?? origin?.size;
	return {
		uid,
		sessionId,
		profile,
		...(session.environmentBuild && { environmentBuild: true }),
		...(size && { size }),
		...(session.hostedSize && { hostedSize: session.hostedSize }),
		...(session.harness && session.harness !== "windlass" ? { harness: session.harness } : {}),
		privateData: !!session.readiness || origin?.role === "reviewer",
		screenshots: session.environmentBuild
			? screenshots && session.environmentBuild.screenshots
			: itemScreenshots(origin, session.harness, screenshots),
	};
}

/** What a session asks for when its sandbox is about to run or goes on running (usage.ts, `ReserveInput`). */
export interface ReserveRequest {
	/** From the session itself, whose newest size may not have reached its user's index yet. */
	hostedSize?: HostedSize;
	/** The new hold's id, made by the session: the same request sent twice is one hold. */
	id: string;
	sessionId: string;
	/** True when the session has no sandbox and is about to have one made. */
	keep?: boolean;
	/** True when a turn, or a paused sandbox, is about to start. */
	fresh?: boolean;
	/** The hold the session has, and the seconds its sandbox ran of it. */
	settle?: HoldReport;
}

/**
 * The answer: the hold and how many seconds it is for, or which limit refused it ("gone": the user
 * has no such session any more). Either way with the user's numbers as they are then.
 */
export type ReserveAnswer =
	| { ok: true; clampedSize?: HostedSize; hold: { id: string; seconds: number }; numbers: UsageNumbers }
	| { ok: false; reason: "allowance" | "sandboxes" | "gone"; numbers: UsageNumbers };

/** The item supplies the destination from its stored filing, never from task or question text. */
export interface JiraItemWrite {
	siteId: string;
	projectId: string;
	issueId: string;
	itemId: string;
	action: import("../factory/intake.js").JiraCommentAction;
	/** The item's owner, when that is not the project's (the person who filed it); its repository then. */
	filedBy?: { uid: string; repositoryId: import("../contract.js").GithubId };
}

/** Actions of `user` that only actors may call. */
export interface UserInternal {
	internalSetupPublished(
		session: string,
		publication: import("../repo-setup/types.js").SetupPublication,
		decisions: import("../repo-setup/types.js").NoteDecision[],
		installation: GithubId,
		source: string,
	): Promise<void>;
	internalReadinessResult(
		session: string,
		attempt: string,
		report: import("../factory/readiness.js").Judgment | string | null,
		diagnosis?: import("../repo-setup/types.js").SetupDiagnosis | null,
	): Promise<void>;
	/** `key`: the repository's `repoKey` (GitHub's bare id still reads as its key). */
	internalReadinessLevel(key: string | GithubId): Promise<import("../factory/readiness.js").ReadinessLevel | null>;
	/** Service call: true when posted (including a replay), false for a permanent decline. Throw to retry. */
	internalJiraWrite(input: JiraItemWrite): Promise<boolean>;
	internalSlackIntake(
		filing: import("../factory/intake.js").SlackFiling,
	): Promise<import("../factory/intake.js").TrackerFiled>;
	internalTrackerIntake(
		filing: import("../factory/intake.js").LinearFiling | import("./issue-intake.js").SiteJiraFiling,
	): Promise<import("../factory/intake.js").TrackerFiled>;
	internalSlackAct(input: import("./user-items.js").SlackAnswer): Promise<void>;
	internalSlackReply(input: {
		id: string;
		text: string;
		slackUser: string;
	}): Promise<import("./user-items.js").SlackReply>;
	internalLinearHoldsTeam(workspaceId: string, teamId: string): Promise<boolean>;
	internalLinearWrite(input: import("./user-linear.js").LinearItemWrite): Promise<boolean>;
	internalDefaultBuilder(input: {
		id: string;
		job: import("./user-items.js").DefaultBuilder;
	}): ReturnType<typeof import("./user-items.js").itemActions.internalDefaultBuilder>;
	internalDiscardPlacement(itemId: string): Promise<void>;

	internalHostedSizes(): Promise<HostedSize[]>;
	internalDailyTokenWait(): Promise<string | null>;
	internalRecordTurnTokens(input: { sessionId: string; receipt: import("../usage.js").TokenReceipt }): Promise<void>;
	internalTokenGeneration(): Promise<number>;
	internalMachineSystem(id: string): Promise<{ os: string; arch: string } | null>;
	internalFeatureChild(input: { parent: string; child: string; cancel?: boolean }): Promise<ItemView | null>;
	internalProviderGeneration(location: import("./provider-accounts.js").AccountLocation): Promise<string | null>;
	internalObserveUsage(
		location: import("./provider-accounts.js").AccountLocation,
		generation: string,
		observation: import("../provider-usage.js").UsageObservation,
	): Promise<void>;

	/** `key`: the repository's `repoKey` (GitHub's bare id still reads as its key). */
	internalRepositoryAutonomy(key: string | GithubId): Promise<RepositoryAutonomy>;
	internalPlanCritic(builderId: string, context: import("../factory/resolve-run.js").RunContext): Promise<void>;
	internalPlacementInventory(
		repositories: Record<string, GithubId>,
		snapshot?: GithubId,
	): Promise<import("../factory/placement.js").PlacementInventory & { hostedCapacity: number }>;

	internalSessionChanged(summary: SessionSummary): Promise<void>;
	/**
	 * Takes over removing a deleted session's copy, which the session could not do itself: from the
	 * bucket, or, with `machineId`, by recording it with that machine's actor (machine-backups.ts).
	 */
	internalRemoveBackupLater(sessionId: string, machineId?: string): Promise<void>;
	/** Counts the session as running if the user's hosted sessions at work are below their ceiling (`FactoryLimits.runningTurns`); one on a machine of theirs always is. */
	internalAcquireRun(
		sessionId: string,
		model?: string,
	): Promise<{
		dailyTokenWait?: string;
		ok: boolean;
		running: number;
		known: boolean;
		until: number | null;
		claim: number | null;
	}>;
	/** Gives back the running slot of the claim named `claim`, for a prompt the session refused after it was claimed; a newer claim, or one already settled, is left as it is. */
	internalReleaseRun(input: {
		sessionId: string;
		claim: number;
		summary: SessionSummary;
	}): Promise<{ released: boolean }>;
	/** The user's GitHub connection as it is now; null when there is none. */
	internalGithubConnection(): Promise<StoredConnection | null>;
	/** The user's remembered approvals of a project's MCP servers that have not run out, the newest first (server-approvals.ts). */
	internalServerApprovals(project: string): Promise<ServerApproval[]>;
	/** Remembers that the user approved exactly this definition of a server for a project, from now. Answers with the project's approvals. */
	internalServerApprove(input: {
		project: string;
		label: string;
		name: string;
		fingerprint: string;
	}): Promise<ServerApproval[]>;
	/** Forgets the user's approvals of that server for a project. Answers with how many there were, and the project's approvals that are left. */
	internalServerForget(input: {
		project: string;
		name: string;
	}): Promise<{ forgotten: number; approvals: ServerApproval[] }>;
	/** The setup command the user saved for a repository, by its key (setup-command.ts); `command` is "" when there is none. */
	internalHasChecks(repositoryId: GithubId): Promise<boolean>;
	/** A post-setup snapshot of the project was saved at `place` ("hosted" or a machine id): remembered for placement. */
	internalSnapshotSaved(project: string, updatedAt: number | null, connectedAt: number, place?: string): Promise<void>;
	/** A build session's result (user-environments.ts `buildResult`); the session is deleted after it. */
	internalEnvironmentResult(sessionId: string, result: EnvironmentBuildReport): Promise<void>;
	/** A session found its place's ready image missing (`missed`), or started cold where the repository has no environment (`cold`). */
	internalEnvironmentNudge(sessionId: string, kind: "missed" | "cold", screenshots: boolean): Promise<void>;
	/** A push to a repository's default branch (github-inbox.ts). */
	internalEnvironmentPushed(repositoryId: GithubId): Promise<void>;
	internalSetupCommand(project: string): Promise<RepositorySetup>;
	/** "Allow for this repository" from a session: `by` is who asked. Someone who may change the repository's settings allows the host; anyone else would file a request, but today only the session's own user calls it (repository-network.ts). */
	internalAllowHost(input: {
		sessionId: string;
		host: string;
		by: string;
	}): Promise<{ allowed: boolean; hosts: string[]; network: import("../contract.js").RepositoryNetwork }>;
	/** Hosts a session's sandbox could not reach, filed as requests on its repository's network list; `full` are those not filed because its requests are full. */
	internalNetworkRequests(input: { sessionId: string; hosts: string[] }): Promise<{ filed: string[]; full: string[] }>;
	/** Takes a hold of the user's sandbox time for the session, and a place among the kept sandboxes when it needs one: both, or neither. */
	internalReserve(input: ReserveRequest): Promise<ReserveAnswer>;
	/** The session's sandbox stopped: counts the seconds it ran of its hold. `known` is false when that hold is not open any more. */
	internalSettle(input: HoldReport & { sessionId: string }): Promise<{ known: boolean }>;
	/** The session has no sandbox any more: its place among the kept ones is free. */
	internalRelease(sessionId: string): Promise<void>;
	/** The session's place among the kept sandboxes, claimed right before its sandbox is made (`UsageBook.claim`). */
	internalClaimPlace(
		sessionId: string,
		hostedSize?: HostedSize,
	): Promise<{ ok: boolean; clampedSize?: HostedSize; numbers: UsageNumbers } | { ok: false; reason: "gone" }>;
	/** The models the user may choose and the efforts of each (account-models.ts): their plan's, or what stands in for it. */
	internalModels(): Promise<ModelList>;
	/** A work item's summary changed (user-items.ts). */
	internalItemChanged(summary: ItemSummary): Promise<void>;
	/** What an item reads of its user: its session's hosted seconds in the ledger, and the user's open items. */
	internalItemFacts(sessionIds: string[]): Promise<ItemFacts>;
	/** An item session asks for a running slot for the turn of a delivery: granted now, or queued (`SessionInternal.internalGrant` later). */
	internalRequestTurn(request: TurnRequest): Promise<TurnAnswer>;
	/** The turn a slot was given to ended, or could not start: the slot, by its id, is free. */
	internalTurnDone(input: TurnRelease): Promise<void>;
	/** A delivery that waited for a slot is not wanted any more. */
	internalWithdrawTurn(input: { sessionId: string; key: string }): Promise<void>;
}

/** A repository's secrets, and what the user keeps for their account, on their way to a session: each value as the `user` actor stores it, sealed (repo-secrets.ts). */
export interface SealedSecrets {
	snapshotSetup?: { command: string; updatedAt: number; connectedAt: number; previouslySaved: boolean };
	/**
	 * The repository's prepared environment at the session's place (environments.ts): `usable` when its ready image
	 * is current, so the session may start from it. Absent where there is none.
	 */
	environment?: { usable: boolean; commit: string; validatedAt: number; checks: number };
	/** Only the server-side redactor may use these values. The machine owner disabled sending them. */
	redactOnly?: boolean;
	/** Names the person explicitly shared with this ACP session. */
	requestedNames?: string[];
	screenshots?: boolean;
	/** What the secrets are saved for; null when the session has no repository of the GitHub connection. */
	project: string | null;
	/**
	 * The hosts its repository's network list allows (repository-network.ts), presets expanded, for a
	 * hosted session: what its sandbox may reach besides the platform's and the deployment's. They are
	 * no secret either. Absent from a server that does not know of lists.
	 */
	network?: string[];
	secrets: Array<{ name: string; scope: SecretScope; sealed: string }>;
	/** The checks the user saved for that repository (repository-checks.ts); none without one. They are no secret: they come with the secrets because a turn needs both before it starts. */
	checks: RepositoryCheck[];
	/**
	 * What the session's user keeps for their account, whatever the repository: the account's secrets,
	 * each value sealed (account-secrets.ts), and the user's own MCP servers with their definitions as
	 * Windlass takes them and whether their tools run without asking (personal-servers.ts).
	 */
	account?: {
		secrets: Array<{ name: string; scope: SecretScope; sealed: string }>;
		servers: Array<{ name: string; definition: Record<string, unknown>; unasked: boolean }>;
	};
}

/** An authenticated person's value, sealed before it leaves the requesting session. */
export interface RequestedSecretSave {
	requestId: string;
	name: string;
	project: string;
	sealed: string;
}

/** Actions of `user` that only one session may call, with a token made for it (`secretsActor`). */
export interface UserSecretsInternal {
	internalRequestedSecretConflict(sessionId: string, name: string): Promise<string | null>;
	internalSaveRequestedSecret(sessionId: string, input: RequestedSecretSave): Promise<void>;
	internalSetupNoteFiles(session: string, ids: string[]): Promise<import("../repo-setup/notes.js").SealedNote[]>;
	internalSessionSecrets(sessionId: string, snapshotSetup?: boolean): Promise<SealedSecrets>;
}

/** Actions of `agentSession` that only actors may call. */
export interface SessionInternal {
	internalAssessRepository(prompt: string, continuation?: NonNullable<SessionCreateInput["readiness"]>): Promise<void>;
	internalDisconnectRevoked(generation: number): Promise<void>;
	internalSummary(): Promise<SessionSummary>;
	/** What a new session continuing this one starts from. Refused (`UserError`) while a turn runs, and for a session that cannot be continued. */
	internalForkSource(): Promise<ForkSource>;
	internalRename(title: string): Promise<SessionSummary>;
	/** A build session's one turn: clone, setup, every saved check, and a saved image only when all passed. Answers once it is accepted. */
	internalBuildEnvironment(): Promise<void>;
	/** Destroys the sandbox, then the actor. */
	internalDestroy(): Promise<void>;
	/** Removes the session's sandbox for its user, who is making room: the session and its timeline stay. `freed` is false when it had none. */
	internalFreeSandbox(
		throughReviewRun?: number,
		hostedSize?: HostedSize,
		automatic?: { reason: string; cutoff?: number },
	): Promise<{ freed: boolean; sizeUnavailable?: HostedSize }>;
	internalSandboxReclaimed(said: string): Promise<void>;
	/** A work item's message (its `deliver` effect), into the inbox: resolves once it is stored; the same key again adds nothing. */
	internalDeliver(input: Delivery): Promise<void>;
	/** The item's person's note, steered into the builder's running turn: false when no turn can take it now. */
	internalOwnerNote(input: { itemId: string; text: string }): Promise<boolean>;
	/** The user's turn queue gives the delivery of `key` its slot. */
	internalGrant(input: { key: string; slot: string }): Promise<void>;
	/** The session's machine is back, or was removed: a turn paused for it resumes, or ends. */
	internalMachineBack(): Promise<void>;
	/** The turn of `key` is not wanted any more: out of the inbox, or stopped. */
	internalWithdraw(key: string): Promise<void>;
	/** Whether the turn of `turn` still runs (a `turn_running` fact with `check`), how it ended, or null when it has not started. */
	internalCheckTurn(input: { turn: string; check: string }): Promise<Fact | null>;
	/** Pushes the item's work and opens or updates its pull request, with the agent's report or else the item's title and body. */
	internalBaseTests(input: {
		head: string;
		base: string;
		tests: import("../factory/base-tests.js").NamedTests;
	}): Promise<import("../factory/base-tests.js").BaseTestResult | "pending">;
	internalOpenFromPushed(input: {
		title: string;
		body: string;
		head: string;
	}): Promise<import("../contract.js").PullRequestInfo>;
	internalPublish(input: {
		key: string;
		title: string;
		body: string;
		blockedNetwork?: import("../contract.js").BlockedNetwork;
		branchOnly?: boolean;
		updateFromBase?: { head: string; at: number; baseTip?: string };
	}): Promise<ItemPublishAnswer>;
}

export interface NetworkReceipt {
	sessionId: string;
	revision: number;
	network: import("../contract.js").BlockedNetwork;
}

/** Actions of `workItem` that only actors may call. */
export interface ItemInternal {
	internalSecretRequestLimit(key: string, name: string): Promise<string | null>;
	internalSetRequestedSecret(input: RequestedSecretSave): Promise<void>;
	internalBlockedNetwork(input: NetworkReceipt): Promise<void>;
	internalMachineAvailable(): Promise<void>;
	internalProviderChanged(revision: number): Promise<void>;
	/** Immutable commit the feature was created from, including for children made before a restart. */
	internalSetupSeed(source: "child" | "feature", repositoryId?: GithubId): Promise<string | null>;
	internalFeatureTarget(): Promise<{ head: string; value: number; branch: string; available: boolean } | null>;
	internalUpdateForChild(
		child: string,
		request: string,
		target: string,
		automatic?: true,
	): Promise<"pending" | "finished">;
	internalJoinStarted(child: string, key: string): Promise<boolean>;
	internalClaimJoin(child: string, key: string): Promise<"busy" | "claimed" | import("../factory/types.js").JoinResult>;
	internalFinishJoin(child: string, result: import("../factory/types.js").JoinResult): Promise<void>;
	internalChildNotice(
		child: Pick<ItemSummary, "id" | "spent" | "state"> & { budget?: ItemSummary["budget"]; integratedHead?: string },
	): Promise<void>;
	/** `repository`: a cross-repo feature's child's own repository and base; null for a one-repository feature. */
	internalChildRequest(child: string): Promise<{
		settings: import("../factory/resolve-run.js").RunContext;
		paused?: boolean;
		job: import("../factory/types.js").FeatureJob;
		sessionId: string;
		feature: ItemSummary;
		joinOnGate: boolean;
		featureBody: string;
		repository: { id: GithubId; base: string; alias: string } | null;
		context: string;
		previous?: {
			head: string | null;
			report: string;
			place?: SandboxPlace;
		} /** Where the subtask's outside text came from (factory/untrusted.ts). Absent from an older parent. */;
		untrusted?: string[] /** The feature's `FactoryItem.unsandboxed`. */;
		unsandboxed?: string[];
	} | null>;
	/** A cross-repo feature's planning turn of `key`: the other repositories it reads, and where in the workspace. */
	internalPlanningInputs(key: string): Promise<{
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
	} | null>;
	internalFilePlan(input: { key: string; plan: unknown }): Promise<string>;
	internalSummary(): Promise<ItemSummary>;
	internalView(): Promise<ItemView>;
	/** Each report and review that filed screenshots, the newest first: what its feature's page gathers. */
	internalScreenshotSets(): Promise<Omit<PartScreenshots, "itemId" | "key" | "title">[]>;
	internalMergeGitlab(reviewedHead: string): Promise<ItemView>;
	/** `slack`: pressed in Slack by that member, for that question only. */
	internalAct(input: { action: ItemAction; by: string; slack?: { user: string; question: string } }): Promise<ItemView>;
	/** A fact about the item's turn; resolves once it is stored. */
	internalFact(fact: Fact): Promise<void>;
}

/**
 * The actor client as actors see it (`c.client()`). Untyped on purpose: naming the registry's type here would make
 * actors that call each other circular. Use this alias instead of a bare `any` so the escape hatch stays in one place.
 */
// biome-ignore lint/suspicious/noExplicitAny: see above
export type ActorClient = any;

export interface HasClient {
	client(): ActorClient;
}

function creationSubject(kind: string, key: readonly string[]): string {
	return `create:${encodeURIComponent(kind)}:${key.map(encodeURIComponent).join("/")}`;
}

export function createGrant(kind: string, key: readonly string[]): string {
	return issueServiceToken(creationSubject(kind, key));
}

export function grantIsValid(grant: unknown, key: readonly string[], kind: string): boolean {
	const caller = verifyToken(grant);
	if (caller?.kind === "service" && caller.subject === creationSubject(kind, key)) return true;
	console.warn(`[wlp] actor.create_refused kind=${kind} keyParts=${key.length}`);
	return false;
}

export async function createSessionActor(
	c: HasClient,
	uid: string,
	sessionId: string,
	input: Omit<SessionCreateInput, "grant">,
): Promise<void> {
	if (input.origin && input.mode !== undefined)
		throw new UserError("A work item and its reviewer use the profile’s approval mode.", { code: "bad_input" });
	const full: SessionCreateInput = { ...input, grant: createGrant("agentSession", [uid, sessionId]) };
	await c.client().agentSession.create([uid, sessionId], { input: full, params: serviceParams() });
}

/** Whether a create failed because an actor of that key exists: for an id derived from a key, a creation that was tried before. */
export function isDuplicateKey(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { group, code } = error as { group?: unknown; code?: unknown };
	return group === "actor" && code === "duplicate_key";
}

/** Creates a work item; one of that key that exists already is the one a creation tried before made. */
export async function createItemActor(
	c: HasClient,
	uid: string,
	itemId: string,
	input: Omit<ItemCreateInput, "grant">,
): Promise<void> {
	const full: ItemCreateInput = { ...input, grant: createGrant("workItem", [uid, itemId]) };
	try {
		await c.client().workItem.create([uid, itemId], { input: full, params: serviceParams() });
	} catch (error) {
		if (!isDuplicateKey(error)) throw error;
	}
}

export function itemActor(c: HasClient, uid: string, itemId: string): ItemInternal {
	return c.client().workItem.get([uid, itemId], { params: serviceParams() }) as ItemInternal;
}

export function sessionActor(c: HasClient, uid: string, sessionId: string): SessionInternal {
	return c.client().agentSession.get([uid, sessionId], { params: serviceParams() }) as SessionInternal;
}

export function gitlabAccess(
	c: HasClient,
	uid: string,
	projectId: string,
): Promise<{ project: import("../contract.js").SessionRepository; viewer: string; token: string }> {
	return c.client().userGitlab.get([uid], { params: serviceParams() }).internalGitlabAccess(projectId);
}

export function userActor(c: HasClient, uid: string): UserInternal {
	return c.client().user.get([uid], { params: serviceParams() }) as UserInternal;
}

export const modelKeyCaller = (uid: string) => `model-key/${uid}`;

export function modelKeyActor(
	c: HasClient,
	uid: string,
): {
	internalModelKeys(): Promise<import("../sandbox/provider.js").ModelKeyLease[]>;
	internalCredentialSource(
		machineId: string,
		harness: string,
	): Promise<import("../contract.js").CredentialSource | null>;
	internalModelKeyGeneration(provider: ModelProvider): Promise<string | null>;
	internalModelKey(provider: ModelProvider, nonce: string): Promise<string | null>;
} {
	return c.client().user.get([uid], { params: { token: issueServiceToken(modelKeyCaller(uid)) } });
}

/** What the service token of a session that asks for its repository's secrets is made for. */
export function secretsCaller(uid: string, sessionId: string): string {
	return `secrets:${uid}/${sessionId}`;
}

/**
 * The `user` actor as a session reaches it for its repository's secrets: with a token that names this
 * user and this session, which is the only one `internalSessionSecrets` takes.
 */
export function secretsActor(c: HasClient, uid: string, sessionId: string): UserSecretsInternal {
	return c
		.client()
		.user.get([uid], { params: { token: issueServiceToken(secretsCaller(uid, sessionId)) } }) as UserSecretsInternal;
}

export { isActorGone, isSessionGone } from "../actor-errors.js";
