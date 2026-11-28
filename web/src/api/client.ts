import type { AccountDefaultsPatch, RepositoryDefaultsPatch } from "@contract";
/**
 * `PlatformClient`: the one interface the screens use to reach the backend. Two implementations:
 * `mock.ts` (in memory, no network) and `rivet.ts` (the real actors over `rivetkit/client`).
 *
 * Everything in the contract is reachable through it, shaped the way the screens use it: plain
 * async calls for actions, and `watch` / `open` for the two live feeds. Both feeds hand over a whole
 * state first (`onSessions`, `onSnapshot`) and again after every reconnect, because events that
 * happen while a connection is down are lost.
 */
import type {
	AccountDefaults,
	AccountSecrets,
	AccountSettings,
	ApiToken,
	ApiTokenScope,
	AuthResult,
	ChatgptStatus,
	ContinueSessionInput,
	CostRates,
	FinishedItems,
	SummaryDays,
	CreateItemInput,
	CreateSessionInput,
	FactoryLimits,
	GitlabActions,
	GithubId,
	GithubBranchList,
	GithubRepository,
	GithubRepositoryList,
	GithubStatus,
	SlackSettingsActions,
	LinearStatus,
	LinearTeamList,
	HostAllowed,
	SetRequestedSecretInput,
	ItemAction,
	ItemFeed,
	ItemListPage,
	ItemSummary,
	ItemView,
	LiveDelta,
	LinkedLogin,
	LoginProvider,
	LoginStart,
	MachineClaim,
	MachineSummary,
	ModelList,
	NetworkScan,
	PendingQuestion,
	PlatformInfo,
	PromptInput,
	PublishMessage,
	PublishResult,
	PublishState,
	RepositoryCheck,
	RepositoryChecks,
	RepositoryEnvironments,
	EnvironmentSchedule,
	RepositoryDefaults,
	RepositoryNetwork,
	RepositorySecrets,
	RepositorySetup,
	RepositoryView,
	SandboxProfileId,
	SavedRepository,
	SecretScope,
	SessionServers,
	SessionSnapshot,
	SessionSummary,
	TimelineItem,
	UsageNumbers,
	UsageView,
	BillingPeriod,
	BillingView,
	UserActions,
	UserProfile,
	WorkspaceFile,
} from "@contract";

export type ClientKind = "mock" | "rivet";

export type PlatformErrorCode =
	/** The server said so on purpose (a UserError): `message` is fit to show as it is. */
	| "user"
	/** The token was refused: sign in again. */
	| "unauthorized"
	/** No such session. */
	| "not_found"
	/** The server could not be reached, or the connection could not be opened. */
	| "network"
	/** The platform is restarting (a deploy): the request met an actor while it stopped, or the proxy in front of it. */
	| "restarting"
	/** Anything else: `message` is generic. */
	| "internal";

/**
 * Codes the server gives a UserError that the screens act on (contract.ts): `no_question` from
 * `answer()` (that question is no longer pending), `steer_unavailable` from `prompt()` (a turn that is
 * starting or stopping cannot take a message), and the two limits a user can run into, which the
 * screens answer with the way to the usage page: `allowance_used` (too little of the day's sandbox
 * time is left) and `too_many_sandboxes` (the user keeps as many sandboxes as they may).
 */
export type PlatformErrorReason =
	| "no_question"
	| "turn_running"
	| "steer_unavailable"
	| "allowance_used"
	| "too_many_sandboxes"
	| (string & {});

export class PlatformError extends Error {
	readonly code: PlatformErrorCode;
	/** For code "user": the code the server gave its UserError, when it gave one. */
	readonly reason: PlatformErrorReason | null;
	constructor(
		code: PlatformErrorCode,
		message: string,
		options?: { cause?: unknown; reason?: PlatformErrorReason | null },
	) {
		super(message, options);
		this.name = "PlatformError";
		this.code = code;
		this.reason = options?.reason ?? null;
	}
}

/** Whether something thrown at the interface is a UserError with this code. */
export function hasReason(error: unknown, reason: PlatformErrorReason): boolean {
	return error instanceof PlatformError && error.reason === reason;
}

/** A message fit to show for anything thrown at the interface. */
export function errorMessage(error: unknown): string {
	if (error instanceof PlatformError) return error.message;
	if (error instanceof Error && error.message !== "") return error.message;
	return "Something went wrong.";
}

/** A link to one of an item's screenshots (`UserActions.itemAttachmentLinks`): a secret until `expiresAt`, so never logged or stored. */
export type AttachmentLink = Awaited<ReturnType<UserActions["itemAttachmentLinks"]>>[number];

export type ConnectionState =
	| "connecting"
	| "connected"
	/** The connection dropped and is being opened again; what is shown may be stale. */
	| "reconnecting"
	/** The connection cannot be opened (the feed's `error` says why) and will not be retried. */
	| "failed";

export interface UserFeed {
	/** The full list, newest first: once when the feed opens, then after every change and reconnect. */
	onSessions(sessions: SessionSummary[]): void;
	/** Today's sandbox time and the count of kept sandboxes, whenever either changes. */
	onUsage?(numbers: UsageNumbers): void;
	/** The user's machines, whenever one is paired or removed or its status, warnings or secrets switch changes. */
	onMachineHost?(update: import("@contract").MachineHostUpdate): void;
	onMachines?(machines: MachineSummary[]): void;
	/** The user's open work items and newest ended ones, with the counts (`ItemFeed`), whenever one of them changes. Not sent when the feed opens: `itemFeed` is. */
	onItems?(feed: ItemFeed): void;
	onConnection?(state: ConnectionState, error?: PlatformError): void;
}

export interface SessionFeed {
	/** The whole session: once when the feed opens and again after every reconnect. Rebuild from it. */
	onSnapshot(snapshot: SessionSnapshot): void;
	/** A stored timeline entry, and a newer revision of a `network.blocked` row (the `networkBlocked` event), which keeps its `seq`. */
	onItem(item: TimelineItem): void;
	onDelta(delta: LiveDelta): void;
	onSummary(summary: SessionSummary): void;
	/** The pending question, when one is asked; null when it was settled. The snapshot carries it too. */
	onQuestion(question: PendingQuestion | null): void;
	/** For a session on one of the user's machines, what its banner says of the machine, each time that changes. The snapshot carries it too. */
	onMachine?(machine: NonNullable<SessionSnapshot["machine"]>): void;
	onConnection(state: ConnectionState, error?: PlatformError): void;
}

export interface UserApi
	extends GitlabActions,
		SlackSettingsActions,
		Pick<
			UserActions,
			| "signOutEverywhere"
			| "modelProviders"
			| "saveModelProvider"
			| "checkModelProvider"
			| "removeModelProvider"
			| "modelPlans"
			| "approvePlanConnect"
			| "denyPlanConnect"
			| "removeModelPlan"
			| "recheckModelPlan"
			| "payWith"
			| "savePayWith"
			| "useKeyNow"
			| "githubStarterIssues"
			| "addSetupNotes"
			| "deleteSetupNote"
			| "setGuideCheck"
			| "runReadiness"
			| "jira"
			| "jiraConnect"
			| "jiraComplete"
			| "jiraSelectSite"
			| "jiraProjects"
			| "saveJiraMapping"
			| "removeJiraMapping"
			| "disconnectJira"
		> {
	me(): Promise<UserProfile>;
	linkedLogins(): Promise<LinkedLogin[]>;
	unlinkLogin(provider: LoginProvider): Promise<void>;
	chatgpt(): Promise<ChatgptStatus>;
	forgetChatgpt(): Promise<void>;
	/** The models the user may choose and the efforts of each: their ChatGPT plan's, or the stand-in, and which it is. */
	models(): Promise<ModelList>;
	listSessions(): Promise<SessionSummary[]>;
	/** Makes an agent. With `idempotencyKey`, the same call again answers with the agent the first one made, while that agent exists. */
	createSession(input: CreateSessionInput): Promise<SessionSummary>;
	/** A new agent continuing this one in a new workspace, branch and pull request, with the same settings. With `stack`, from its pushed branch. */
	continueSession(input: ContinueSessionInput): Promise<SessionSummary>;
	renameSession(id: string, title: string): Promise<SessionSummary>;
	deleteSession(id: string): Promise<void>;
	/** The user's GitHub connection. Only asked where the deployment has a GitHub App (`PlatformInfo.github`). */
	github(): Promise<GithubStatus>;
	/** Begins connecting GitHub: the address at GitHub to send the browser to. With `install`, the app's installation page. */
	githubConnect(origin: string, install?: boolean): Promise<{ url: string }>;
	/** Finishes connecting with the ticket the browser came back from GitHub with. */
	githubComplete(ticket: string): Promise<GithubStatus>;
	githubDisconnect(): Promise<GithubStatus>;
	githubRepositories(query: string, fresh?: boolean): Promise<GithubRepositoryList>;
	githubBranches(repositoryId: GithubId): Promise<GithubBranchList>;
	/** The setup command the user saved for a repository of their GitHub connection; `command` is "" when there is none. */
	repositorySetup(repositoryId: GithubId): Promise<RepositorySetup>;
	/** Saves it, or none with "". Throws with reason `bad_setup_command` for one that is too long. */
	saveRepositorySetup(repositoryId: GithubId, command: string): Promise<RepositorySetup>;
	/** The checks the user saved for a repository of their GitHub connection, in the order they run. */
	repositoryChecks(repositoryId: GithubId): Promise<RepositoryChecks>;
	/** Saves the list whole, or none with an empty one. Throws with reason `bad_checks` for a list that cannot be saved. */
	saveRepositoryChecks(repositoryId: GithubId, checks: RepositoryCheck[]): Promise<RepositoryChecks>;
	/** The repository's prepared environments, one per place, and how often they are rebuilt (environments.ts). */
	repositoryEnvironments(repositoryId: GithubId): Promise<RepositoryEnvironments>;
	/** Builds them again now, at one place or at each. Throws with reason `environment_refused` when none can be built. */
	rebuildEnvironment(repositoryId: GithubId, place?: string): Promise<RepositoryEnvironments>;
	saveEnvironmentSchedule(repositoryId: GithubId, schedule: EnvironmentSchedule): Promise<RepositoryEnvironments>;
	/** The repository's network list, the requests its sessions filed, and what the deployment's hosted sandboxes reach anyway. */
	repositoryNetwork(repositoryId: GithubId): Promise<RepositoryNetwork>;
	/** Saves the list whole: preset ids and exact host names. Throws with reason `bad_network` for an entry or a length that cannot be saved. */
	saveRepositoryNetwork(repositoryId: GithubId, entries: string[]): Promise<RepositoryNetwork>;
	/** Takes a request off the list without allowing it. */
	dismissNetworkRequest(repositoryId: GithubId, host: string): Promise<RepositoryNetwork>;
	/** Reads the repository's manifests, lockfiles, install scripts and CI files at GitHub and proposes the hosts they name. Saves nothing. */
	scanRepositoryNetwork(repositoryId: GithubId): Promise<NetworkScan>;
	/**
	 * The secrets saved for a repository, without their values, and what each reaches in a sandbox of
	 * `profile`: the sandbox of the session `sessionId` names, whose Windlass may be an older one, or
	 * without it a sandbox made now. A value is sent to the server when it is saved and never comes back.
	 */
	repositorySecrets(repositoryId: GithubId, profile: SandboxProfileId): Promise<RepositorySecrets>;
	/** Saves a secret: with `value` a new one or a new value, without it only the scope. Throws with reason `bad_secret`, `too_many_secrets` or `secret_not_found`. */
	saveRepositorySecret(
		repositoryId: GithubId,
		profile: SandboxProfileId,
		secret: { name: string; value?: string; scope: SecretScope },
	): Promise<RepositorySecrets>;
	deleteRepositorySecret(repositoryId: GithubId, profile: SandboxProfileId, name: string): Promise<RepositorySecrets>;
	repository(repositoryId: GithubId): Promise<RepositoryView>;
	setSetupWeekly(repositoryId: GithubId, enabled: boolean): Promise<void>;
	/**
	 * The repository as GitHub has it now: what a new agent can be launched on. Throws with reason `github_off`,
	 * `github_not_connected`, `github_gone` or `github_denied` when it cannot be used for new agents, and
	 * `github_unreachable` or `github_failed` when GitHub could not be asked.
	 */
	githubRepository(repositoryId: GithubId): Promise<GithubRepository>;
	/** Saves what new agents on a repository start with: a field left out stays, null saves none. Throws with reason `bad_input` or `bad_model` for what the deployment does not offer. */
	saveRepositoryDefaults(repositoryId: GithubId, change: RepositoryDefaultsPatch): Promise<RepositoryDefaults>;
	/** Forgets the remembered approvals of that MCP server for a repository. */
	forgetRepositoryApproval(repositoryId: GithubId, name: string): Promise<RepositoryView>;
	/** Deletes everything kept for a repository: setup command, checks, secrets, defaults and remembered approvals. The agents on it stay. */
	forgetRepository(repositoryId: GithubId): Promise<RepositoryView>;
	/** The repositories something is kept for. Asks GitHub nothing. */
	savedRepositories(): Promise<SavedRepository[]>;
	/** The account's settings: the defaults for new agents and the user's own MCP servers. No secret's value. */
	account(): Promise<AccountSettings>;
	/** Saves what new agents start with where neither the launch form nor the repository says: a field left out stays, null saves none. Throws as `saveRepositoryDefaults` does. */
	saveAccountDefaults(change: AccountDefaultsPatch): Promise<AccountDefaults>;
	/**
	 * Saves an MCP server of the user's own: a new one, or with `existing` the definition of the one of that name.
	 * Throws with reason `bad_server` (the message names the key), `server_exists`, `server_not_found` or `too_many_servers`.
	 */
	savePersonalServer(server: {
		name: string;
		definition: unknown;
		unasked?: boolean;
		existing?: boolean;
	}): Promise<AccountSettings>;
	deletePersonalServer(name: string): Promise<AccountSettings>;
	/** The account's secrets, without their values, and what each reaches in a sandbox of `profile` made now. */
	accountSecrets(profile: SandboxProfileId): Promise<AccountSecrets>;
	/** Saves a secret of the account: a new one, or a new value for the one of that name. Throws with reason `bad_secret` or `too_many_secrets`. */
	saveAccountSecret(
		profile: SandboxProfileId,
		secret: { name: string; value?: string; scope: SecretScope },
	): Promise<AccountSecrets>;
	deleteAccountSecret(profile: SandboxProfileId, name: string): Promise<AccountSecrets>;
	/** Today's sandbox time against the allowance, and how many sandboxes the user keeps of how many they may. */
	allowance(): Promise<UsageNumbers>;
	/** The usage page: the numbers, today by agent, the kept sandboxes, the last two weeks and what a second is estimated to cost. */
	usage(): Promise<UsageView>;
	/** The account's plan and this month's hosted minutes; `{ enabled: false }` where the deployment has no billing (`PlatformInfo.billing`). */
	billing(): Promise<BillingView>;
	/** A checkout for Pro at the payment provider: the address to send the browser to. Throws with reason `billing_off`, `already_subscribed` or `billing_unavailable`. */
	billingCheckout(input: { period: BillingPeriod; origin: string }): Promise<{ url: string }>;
	/** The payment provider's customer portal, to change the card or cancel. Throws with reason `no_customer` or `billing_unavailable`. */
	billingPortal(input: { origin: string }): Promise<{ url: string }>;
	/** Sets the monthly overage spend cap, in US cents. Throws with reason `bad_input`. */
	setOverageCap(input: { cents: number }): Promise<BillingView>;
	/** Frees one agent's sandbox to make room: its workspace files go, the agent and its conversation stay. Throws with reason `sandbox_busy` while it works. */
	freeSandbox(sessionId: string): Promise<UsageView>;
	/** The user's machines, the first paired first. The machine calls throw with reason `machines_off` where the deployment has none (`PlatformInfo.machines`). */
	machines(): Promise<MachineSummary[]>;
	machineCatalog: UserActions["machineCatalog"];
	/** What the machine whose runner printed `code` says of itself. Throws with reason `pairing_not_found`, `too_many_claims` or `too_many_machines`. */
	claimMachine(input: { code: string }): Promise<MachineClaim>;
	/** Pairs the machine of a code this user looked up. Throws as `claimMachine` does. */
	confirmMachine(input: { code: string; keyConfirmed: true }): Promise<MachineSummary>;
	/** Ends the pairing of a code this user looked up, so its runner stops; nothing once its machine is paired. Throws with reason `pairing_not_found` for a code this user did not look up. */
	denyMachine(input: { code: string }): Promise<void>;
	/** Removes a machine; with `removeSandboxes` its runner also removes the agents' sandboxes on it. Throws with reason `machine_not_found`. */
	removeMachine(input: { machineId: string; removeSandboxes: boolean }): Promise<MachineSummary[]>;
	/** Turns the sending of saved secrets to a machine's agents on or off. Throws as `removeMachine` does. */
	setMachineDetails(input: {
		machineId: string;
		whenToUse: string;
		tags: string[];
		orchestrator?: "yes" | "named" | "never";
	}): Promise<MachineSummary[]>;
	setMachineSecrets(input: { machineId: string; send: boolean }): Promise<MachineSummary[]>;
	/** The user's work items, the newest first. */
	/** With `page`, a page of them (`ItemListPage`); a page shorter than its limit is the last. */
	listItems(page?: ItemListPage): Promise<ItemSummary[]>;
	/** What the live feed carries (`ItemFeed`): read when a screen opens, then as `onItems` sends it. */
	itemFeed(): Promise<ItemFeed>;
	/** One item's page. Throws with reason `item_not_found` for one that is not the user's. */
	item(id: string): Promise<ItemView>;
	/** Links to the item's kept screenshots, each working for ten minutes; a removed one has none. Throws with reason `item_not_found`. Never kept beyond the page's memory. */
	itemAttachmentLinks(itemId: string): Promise<AttachmentLink[]>;
	/** Files a work item, with its own agent on the repository. With `idempotencyKey`, the same call again answers with the item the first one made. Throws as `createSession` does, and with reason `bad_input`. */
	createItem(input: CreateItemInput): Promise<ItemSummary>;
	/** Starts, cancels, retries, sends back or answers an item. Throws with reason `item_conflict` where its state does not allow it, with why. */
	mergeGitlabItem(id: string, reviewedHead: string): Promise<ItemView>;
	actOnItem(id: string, action: ItemAction): Promise<ItemView>;
	/** The factory's limits for this user, which the deployment's owner sets. */
	factoryLimits(): Promise<FactoryLimits>;
	/** What prices items' usage: the model catalog's prices and the hosted sandbox rates (`CostRates`). */
	costRates(): Promise<CostRates>;
	/** The items that ended in the last 7, 30 or 90 days with what each used, for the Usage summary (`FinishedItems`). */
	finishedItems(days: SummaryDays): Promise<FinishedItems>;
	/** The Linear connection (`LinearStatus`): `off` where the deployment has no Linear client. */
	linear(): Promise<LinearStatus>;
	/** Begins connecting a workspace: the address at Linear to send the browser to. The page comes back with `#linear=<ticket>` or `#linear-error=<code>`. */
	linearConnect(input: { origin: string }): Promise<{ url: string }>;
	linearComplete(ticket: string): Promise<LinearStatus>;
	/** The workspace's teams and the repository each files to. Throws with reason `linear_not_connected`. */
	linearTeams(): Promise<LinearTeamList>;
	/** Maps a team to one connected repository. Answers with the teams as they are then. */
	saveLinearMapping(input: { teamId: string; repositoryId: GithubId }): Promise<LinearTeamList>;
	/** Removes a team's mapping: its issues are ignored again. Items already filed stay. */
	removeLinearMapping(teamId: string): Promise<LinearTeamList>;
	/** Forgets the Linear connection and every mapping. Items already filed stay. */
	disconnectLinear(): Promise<LinearStatus>;
	/** The user's API tokens, the newest first, without their values. */
	apiTokens(): Promise<ApiToken[]>;
	/** Makes one: `secret` is its value, which is never sent again. Throws with reason `bad_input` or `too_many_tokens`. */
	createApiToken(input: { name: string; scopes: ApiTokenScope[] }): Promise<{ token: ApiToken; secret: string }>;
	/** Revokes one: it stops working at once. Answers with the list as it is then. */
	revokeApiToken(id: string): Promise<ApiToken[]>;
	/** Opens the live list of sessions. Returns the function that closes it. */
	watch(feed: UserFeed): () => void;
}

export interface SessionApi {
	/** Opens the session's live feed. Returns the function that closes it. */
	open(feed: SessionFeed): () => void;
	/** Asks for a fresh `onSnapshot` on every open feed (after a gap in the item numbering). */
	resync(): void;
	/**
	 * Starts a turn, or steers the running one (`steered: true`). With `idempotencyKey`, the key of this
	 * submission (lib/submission.ts), a message the server took before under that key is not taken again:
	 * the answer is its first attempt's. Throws with reason `idempotency_key_reused` for a key that came with another text.
	 */
	prompt(input: PromptInput): Promise<{ turn: number; steered: boolean }>;
	/** Answers the pending question. Throws with reason `no_question` when it is no longer pending. */
	answer(input: { questionId: string; choice: string; note?: string }): Promise<void>;
	/** Stops one running tool call; `stopped: false` comes with Windlass's reason. */
	stopCall(input: { messageId: string; callId: string }): Promise<{ stopped: boolean; message: string | null }>;
	stop(): Promise<void>;
	changes(): Promise<WorkspaceFile[]>;
	diff(): Promise<string>;
	/** What the side panel shows about the session's pull request. */
	publishState(): Promise<PublishState>;
	/** Commits, pushes, and opens the pull request when none is open. It can take a minute. */
	publish(message: PublishMessage): Promise<PublishResult>;
	/** Sets whether the agent may have the platform publish without the user being asked each time (`SessionSummary.publishUnasked`). */
	setMode(mode: string): Promise<SessionSummary>;
	setPublishUnasked(unasked: boolean): Promise<SessionSummary>;
	/** The MCP servers the session's project names, each as the session last heard of it, with the remembered approval where there is one. */
	servers(): Promise<SessionServers>;
	/** Approves a server that waits, by the fingerprint `servers()` gave. Throws with reason `server_changed` when it no longer waits with that definition. */
	approveServer(name: string, fingerprint: string): Promise<SessionServers>;
	/** Forgets the remembered approvals of that server for the session's project. */
	forgetServer(name: string): Promise<SessionServers>;
	/** "Allow for this repository": adds a blocked host to the network list of the session's repository, and lets its running sandbox reach it at once. */
	allowHost(host: string): Promise<HostAllowed>;
	/**
	 * The value for the agent's open `request_secret` (an item's `secret_needed` question, or `SessionSnapshot.secretRequest`):
	 * saved for the session's repository, or for the account, and the requesting work goes on. The value goes only here.
	 */
	setRequestedSecret(input: SetRequestedSecretInput): Promise<void>;
}

export interface PlatformClient {
	readonly kind: ClientKind;
	/** Where the real backend is; null for the mock. */
	readonly endpoint: string | null;
	info(): Promise<PlatformInfo>;
	readonly login: {
		start(provider?: LoginProvider, auth?: AuthResult): Promise<LoginStart>;
		finish(pastedUrl: string, auth?: AuthResult): Promise<AuthResult>;
		demo(): Promise<AuthResult>;
	};
	user(auth: AuthResult): UserApi;
	session(auth: AuthResult, sessionId: string): SessionApi;
	/** Closes every connection. */
	dispose(): void;
}
