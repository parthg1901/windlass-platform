/** The user and agentSession actors' actions, events and snapshot shapes. */

import type { SlackSettingsActions } from "./slack.js";
import type {
	ChatgptStatus,
	ContinueSessionInput,
	CreateSessionInput,
	HarnessOptions,
	IdempotencyKey,
	LinkedLogin,
	LoginProvider,
	ModelList,
	SandboxProfile,
	SandboxProfileId,
	SessionSummary,
	UserProfile,
} from "../contract.js";
import type {
	AccountDefaults,
	AccountDefaultsPatch,
	AccountSecrets,
	AccountSettings,
	ApiToken,
	ApiTokenScope,
	ModelProvider,
	ModelProviderCheck,
	ModelProviderStatus,
	ModelPlans,
	ModelPlanStatus,
	PayWithChoice,
	PayWithPatch,
	RepositoryDefaultsPatch,
} from "./account.js";
import type { PlanProvider } from "./connect.js";
import type {
	StarterIssue,
	GithubBranchList,
	GithubId,
	GithubRepository,
	GithubRepositoryList,
	GithubStatus,
	LinearStatus,
	JiraStatus,
	JiraProjectList,
	LinearTeamList,
	PublishMessage,
	PublishResult,
	PublishState,
} from "./github.js";
import type {
	CreateItemInput,
	FactoryLimits,
	ItemAction,
	ItemFeed,
	ItemListPage,
	ItemSummary,
	ItemView,
	SecretRequest,
	SetRequestedSecretInput,
} from "./items.js";
import type { MachineClaim, MachineDetails, MachineHostUpdate, MachineSummary } from "./machines.js";
import type { PendingQuestion, SessionServers } from "./questions.js";
import type {
	EnvironmentPlace,
	EnvironmentSchedule,
	HostAllowed,
	NetworkScan,
	RepositoryCheck,
	RepositoryChecks,
	RepositoryDefaults,
	RepositoryEnvironments,
	RepositoryNetwork,
	RepositorySecrets,
	RepositorySetup,
	RepositoryView,
	SavedRepository,
	SecretScope,
} from "./repository.js";
import type { LiveDelta, NetworkBlockedItem, TimelineItem } from "./timeline.js";
import type { BillingPeriod, BillingView, UsageNumbers, UsageView } from "./usage.js";

export interface UserActions extends SlackSettingsActions {
	signOutEverywhere(options?: { revokeApiTokens: boolean }): Promise<void>;
	me(): Promise<UserProfile>;
	linkedLogins(): Promise<LinkedLogin[]>;
	unlinkLogin(provider: LoginProvider): Promise<void>;
	chatgpt(): Promise<ChatgptStatus>;
	forgetChatgpt(): Promise<void>;
	/** On fetch failure return cached or fallback choices and identify their source. */
	models(): Promise<ModelList>;
	/** The user's GitHub connection. Throws a UserError with code `github_off` when the deployment has no GitHub App. */
	github(): Promise<GithubStatus>;
	/**
	 * Begins connecting GitHub and returns the address at GitHub to send the browser to. `origin` is the
	 * web app's own address, where the browser is sent back to: with `#github=<ticket>` when GitHub
	 * confirmed which installations this GitHub user can reach, or `#github-error=<code>` when not.
	 * With `install` the address is the app's installation page, for adding another account to a
	 * connection; without it GitHub is first asked who the user is, and they are sent on to install the
	 * app only when it is installed nowhere they can reach.
	 */
	githubConnect(input: { origin: string; install?: boolean }): Promise<{ url: string }>;
	/** Short-lived, single-use ticket bound to the user who started the connection. */
	githubComplete(ticket: string): Promise<GithubStatus>;
	/** Forgets the connection. Sessions launched on its repositories stay, and can no longer push. */
	githubDisconnect(): Promise<GithubStatus>;
	/** The Linear connection (see `LinearStatus`). Never throws for a deployment without Linear: the answer is `{ state: "off" }`. */
	linear(): Promise<LinearStatus>;
	/** Begins connecting a workspace. The callback returns to Settings with `#linear=<ticket>` or `#linear-error=<code>`. */
	linearConnect(input: { origin: string }): Promise<{ url: string }>;
	/** Records the connection for the user who started it. Refuses an invalid, expired or used ticket with `linear_ticket`. */
	linearComplete(ticket: string): Promise<LinearStatus>;
	/** The workspace's teams with the repository each files to. Throws a UserError with code `linear_not_connected` before a workspace is connected. */
	linearTeams(): Promise<LinearTeamList>;
	/**
	 * Files a team's issues to a repository of the user's GitHub connection (replacing its earlier mapping) and answers with the teams.
	 * Codes: `linear_not_connected`, `linear_team` (no such team in the workspace), `github_not_connected`, `bad_input` (a repository the connection
	 * does not cover, or one the user cannot push to).
	 */
	saveLinearMapping(input: { teamId: string; repositoryId: GithubId }): Promise<LinearTeamList>;
	/** Stops filing a team's issues. Items already filed stay as they are. Answers with the teams. */
	removeLinearMapping(teamId: string): Promise<LinearTeamList>;
	/** Forgets the Linear connection and every mapping; nothing is filed from Linear after it. Items already filed stay. */
	disconnectLinear(): Promise<LinearStatus>;
	/** Jira Cloud 3LO; completion lists authorized sites without exposing the grant. */
	jira(): Promise<JiraStatus>;
	jiraConnect(input: { origin: string }): Promise<{ url: string }>;
	jiraComplete(ticket: string): Promise<JiraStatus>;
	jiraSelectSite(siteId: string): Promise<JiraStatus>;
	jiraProjects(): Promise<JiraProjectList>;
	saveJiraMapping(input: { siteId: string; projectId: string; repositoryId: GithubId }): Promise<JiraProjectList>;
	removeJiraMapping(input: { siteId: string; projectId: string }): Promise<JiraProjectList>;
	disconnectJira(): Promise<JiraStatus>;
	/** Search owner/name, newest push first. Use fresh after changing an installation's repository access. */
	githubRepositories(query: string, fresh?: boolean): Promise<GithubRepositoryList>;
	githubBranches(repositoryId: GithubId): Promise<GithubBranchList>;
	/** Up to three of the repository's oldest open issues labelled "bug", for the first item's starter tasks. */
	githubStarterIssues(repositoryId: GithubId): Promise<StarterIssue[]>;
	/** The setup command the user saved for a repository, by GitHub's id for it. Asks GitHub nothing. */
	repositorySetup(repositoryId: GithubId): Promise<RepositorySetup>;
	/**
	 * Saves the user's setup command for a repository; "" saves none. It runs in sandboxes made from then
	 * on: a sandbox that has its clone already is not set up again. Throws a UserError with code
	 * `bad_setup_command` for one longer than MAX_SETUP_COMMAND_CHARS or with a character a shell cannot take.
	 */
	saveRepositorySetup(input: { repositoryId: GithubId; command: string }): Promise<RepositorySetup>;
	/** The checks the user saved for a repository, by GitHub's id for it. Asks GitHub nothing. */
	repositoryChecks(repositoryId: GithubId): Promise<RepositoryChecks>;
	/**
	 * Saves the user's checks for a repository: the whole list, in place of what was saved; an empty
	 * one saves none. They are handed to Windlass from each session's next turn on that repository.
	 * Throws a UserError with code `bad_checks` for a list that cannot be saved, with what is wrong.
	 */
	saveRepositoryChecks(input: { repositoryId: GithubId; checks: RepositoryCheck[] }): Promise<RepositoryChecks>;
	repositoryEnvironments(repositoryId: GithubId): Promise<RepositoryEnvironments>;
	rebuildEnvironment(input: { repositoryId: GithubId; place?: EnvironmentPlace }): Promise<RepositoryEnvironments>;
	saveEnvironmentSchedule(input: {
		repositoryId: GithubId;
		schedule: EnvironmentSchedule;
	}): Promise<RepositoryEnvironments>;
	/** The repository's network list, with the requests its sessions filed and what the deployment allows anyway. Asks GitHub nothing. */
	repositoryNetwork(repositoryId: GithubId): Promise<RepositoryNetwork>;
	/**
	 * Saves the repository's network list whole: preset ids and exact host names. An empty one saves
	 * none. A request for a host the list now allows is taken off. Throws a UserError with code
	 * `bad_network` for an entry that is no preset and no exact DNS name, or a list that comes to more
	 * than `RepositoryNetwork.limit` hosts.
	 */
	saveRepositoryNetwork(input: { repositoryId: GithubId; entries: string[] }): Promise<RepositoryNetwork>;
	/** Takes a request off the repository's list without allowing it. */
	dismissNetworkRequest(input: { repositoryId: GithubId; host: string }): Promise<RepositoryNetwork>;
	/** Static scan of the default branch and the saved setup command. It executes nothing and persists nothing. */
	scanRepositoryNetwork(repositoryId: GithubId): Promise<NetworkScan>;
	/** Return metadata and profile-dependent reach. Secret values stay on the server. */
	repositorySecrets(input: { repositoryId: GithubId; profile: SandboxProfileId }): Promise<RepositorySecrets>;
	/**
	 * Saves a secret of a repository. With `value`: a new secret, or a new value for the one of that
	 * name. Without: only the scope of the one of that name is changed. It reaches a setup command in
	 * sandboxes made from then on, and Windlass from each session's next turn. Throws a UserError with
	 * code `bad_secret` for a name or value that cannot be saved, `too_many_secrets` at
	 * MAX_SECRETS_PER_REPOSITORY, and `secret_not_found` for a scope change of a name that is not saved.
	 */
	saveRepositorySecret(input: {
		repositoryId: GithubId;
		profile: SandboxProfileId;
		name: string;
		value?: string;
		scope: SecretScope;
	}): Promise<RepositorySecrets>;
	/** Deletes a secret of a repository. A sandbox whose setup command already had it keeps what that command made of it. */
	deleteRepositorySecret(input: {
		repositoryId: GithubId;
		profile: SandboxProfileId;
		name: string;
	}): Promise<RepositorySecrets>;
	/** Local settings survive loss of GitHub access. */
	repository(repositoryId: GithubId): Promise<RepositoryView>;
	setGuideCheck(repositoryId: GithubId, enabled: boolean): Promise<RepositoryView>;
	setSetupWeekly(repositoryId: GithubId, enabled: boolean): Promise<void>;
	addSetupNotes(repositoryId: GithubId, files: import("../repo-setup/types.js").NoteInput[]): Promise<RepositoryView>;
	deleteSetupNote(repositoryId: GithubId, id: string): Promise<RepositoryView>;
	runReadiness(
		repositoryId: GithubId,
		noteIds?: string[],
		answers?: Record<string, "keep" | "drop">,
	): Promise<RepositoryView>;
	/**
	 * The repository as GitHub has it now, when the user's connection covers it and the connected user
	 * may read it: what a new session can be launched on. Throws a UserError that says what is in the
	 * way: `github_off`, `github_not_connected`, `github_gone` or `github_denied` when it cannot be used
	 * for new sessions, `github_unreachable` or `github_failed` when GitHub could not be asked.
	 */
	githubRepository(repositoryId: GithubId): Promise<GithubRepository>;
	/** Omitted fields keep their values. Explicit null clears a default. */
	saveRepositoryDefaults(input: RepositoryDefaultsPatch & { repositoryId: GithubId }): Promise<RepositoryDefaults>;
	/** Forget all remembered definitions by name. Repeated calls succeed. */
	forgetRepositoryApproval(input: { repositoryId: GithubId; name: string }): Promise<RepositoryView>;
	/** Drop the repository's saved configuration, secrets and approvals. Existing sessions survive. */
	forgetRepository(repositoryId: GithubId): Promise<RepositoryView>;
	/** The repositories something is kept for, by name. Asks GitHub nothing. */
	savedRepositories(): Promise<SavedRepository[]>;
	/** The account's settings: the defaults for new sessions and the user's own MCP servers. No secret's value. */
	account(): Promise<AccountSettings>;
	/** Omission preserves a field and null clears it. Repository overrides still take precedence. */
	saveAccountDefaults(input: AccountDefaultsPatch): Promise<AccountDefaults>;
	/**
	 * Saves an MCP server of the user's own. With `existing`, the definition of the one of that name is
	 * replaced, and its setting with it; without, a new one is added. `unasked` is `PersonalServer.unasked`,
	 * off when it is left out. Windlass has it from each session's next turn. Throws a
	 * UserError with code `bad_server` for a name or a definition Windlass would not take (its message
	 * names the key), `server_exists` for a new one whose name is taken, `server_not_found` for a
	 * change of one that is not saved, and `too_many_servers` at `AccountSettings.limits.servers`.
	 */
	savePersonalServer(input: {
		name: string;
		definition: unknown;
		unasked?: boolean;
		existing?: boolean;
	}): Promise<AccountSettings>;
	/** Deletes one of the user's own MCP servers. A turn that is running keeps it until it ends. */
	deletePersonalServer(name: string): Promise<AccountSettings>;
	modelProviders(): Promise<ModelProviderStatus[]>;
	saveModelProvider(input: { provider: ModelProvider; key: string }): Promise<ModelProviderCheck>;
	checkModelProvider(provider: ModelProvider): Promise<ModelProviderCheck>;
	removeModelProvider(provider: ModelProvider): Promise<void>;
	/** The plans connected to this account, and whether it may connect them. Tokens never leave the platform. */
	modelPlans(): Promise<ModelPlans>;
	/**
	 * Approves the connect request whose code the terminal shows (`npx @windlassai/cli connect claude|codex`), for
	 * the plan the connect page names: only then does that terminal hand its plan's token (or ChatGPT sign-in) to
	 * this account. A code for another plan approves nothing. `denyPlanConnect` refuses it.
	 */
	approvePlanConnect(userCode: string, provider: PlanProvider): Promise<void>;
	denyPlanConnect(userCode: string): Promise<void>;
	/** Forgets a plan; the ChatGPT plan is the ChatGPT sign-in, so this is `forgetChatgpt` for it. */
	removeModelPlan(provider: PlanProvider): Promise<void>;
	/** Asks the plan's provider again whose it is and, for the ChatGPT plan, which models it offers. */
	recheckModelPlan(provider: PlanProvider): Promise<ModelPlanStatus | null>;
	/** Each plan agent's Pay-with choice, the defaults where none was saved (server/src/pay-with.ts). */
	payWith(): Promise<PayWithChoice[]>;
	/** Saves one agent's choice; answers with every agent's. Throws with reason `bad_input` for an agent or choice there is none of. */
	savePayWith(input: PayWithPatch): Promise<PayWithChoice[]>;
	/** An item waiting for its plan (`Wait.plan.keyNow`) pays its next turn with the saved key instead, once. Throws `bad_input` when no key can. */
	useKeyNow(itemId: string): Promise<void>;
	/** The names and times of the account's secrets, and what each reaches in a sandbox of `profile` made now. No value. */
	accountSecrets(input: { profile: SandboxProfileId }): Promise<AccountSecrets>;
	/**
	 * Saves a secret of the account, as `saveRepositorySecret` saves a repository's. With `value`: a
	 * new one, or a new value for the one of that name. Without: only the scope of the one of that
	 * name is changed. It holds from each session's next turn. Throws a UserError with code
	 * `bad_secret` for a name or value that cannot be saved, `too_many_secrets` at
	 * `AccountSettings.limits.secrets`, and `secret_not_found` for a scope change of a name that is not saved.
	 */
	saveAccountSecret(input: {
		profile: SandboxProfileId;
		name: string;
		value?: string;
		scope: SecretScope;
	}): Promise<AccountSecrets>;
	deleteAccountSecret(input: { profile: SandboxProfileId; name: string }): Promise<AccountSecrets>;
	listSessions(): Promise<SessionSummary[]>;
	createSession(input: CreateSessionInput): Promise<SessionSummary>;
	/**
	 * A new session that continues a session in a new workspace, on a new branch, with its own pull
	 * request: the same repository, agent, model, effort, mode, placement and isolation. The agent's
	 * memory is copied where the platform keeps a copy of it; otherwise its first prompt gets an account
	 * of the earlier session. The earlier session is not changed. Throws `session_not_found`,
	 * `item_session` for a work item's or other platform session, `no_repository`, `turn_running`, and
	 * `not_pushed` for `stack` on a session that has pushed nothing.
	 */
	continueSession(input: ContinueSessionInput): Promise<SessionSummary>;
	renameSession(id: string, title: string): Promise<SessionSummary>;
	/** On machine_unreachable the session stays listed so deletion can be retried. */
	deleteSession(id: string): Promise<void>;
	/** Today's sandbox time and the count of kept sandboxes, as the user's actor has them. Asks no provider. */
	allowance(): Promise<UsageNumbers>;
	/** Reconcile kept sandboxes against the provider inventory before returning usage. */
	usage(): Promise<UsageView>;
	/** The account's plan, its subscription and this month's hosted minutes; `{ enabled: false }` where the deployment has no billing. */
	billing(): Promise<BillingView>;
	/** The checkout return origin must belong to the web app. */
	billingCheckout(input: { period: BillingPeriod; origin: string }): Promise<{ url: string }>;
	/** The provider's customer portal, to change the card or cancel. Throws `billing_off` or `no_customer`. */
	billingPortal(input: { origin: string }): Promise<{ url: string }>;
	/** Sets the overage spend cap, US cents from 0 to `maxCapCents`: the server stops hosted sandboxes at it. Throws `bad_input` or `billing_off`. */
	setOverageCap(input: { cents: number }): Promise<BillingView>;
	/** Refuse while busy. Freeing discards the workspace but preserves the session and its conversation. */
	freeSandbox(sessionId: string): Promise<UsageView>;
	/** Pairing order. Machine actions refuse with machines_off when disabled. */
	machines(): Promise<MachineSummary[]>;
	machineCatalog(input: {
		machineId: string;
		id: "claude" | "opencode" | "codex";
		digest: string;
	}): Promise<HarnessOptions | null>;
	/**
	 * Looks up the code a runner printed ("XXXX-XXXX": Crockford base32, so case, spaces and dashes do
	 * not matter, O reads as 0 and I and L as 1) and answers with what that machine said of itself. The
	 * first account to look a code up keeps it: for any other the code is not found. Throws a UserError
	 * with code `pairing_not_found` for a code that is unknown, expired (ten minutes after the runner
	 * asked) or another account's, `too_many_claims` after five lookups in ten minutes, and
	 * `too_many_machines` at MAX_MACHINES.
	 */
	claimMachine(input: { code: string }): Promise<MachineClaim>;
	/**
	 * Pairs the machine of a code this user looked up. Its runner is told the GitHub login of the
	 * account it joined (none when GitHub is not connected), prints it, and connects. Asked again for the
	 * same code, it answers with the same machine. Throws as `claimMachine` does. `keyConfirmed`: the
	 * person said the machine's terminal shows the claim's `keyFingerprint` (or, for a runner that does not
	 * print it, that they started it themselves); without it the platform refuses with `key_not_confirmed`.
	 */
	confirmMachine(input: { code: string; keyConfirmed: true }): Promise<MachineSummary>;
	/**
	 * Refuses the machine of a code this user looked up (the connect page's Deny): its pairing ends at once, so
	 * its runner stops waiting and pairs with nobody. Throws as `claimMachine` does for a code this user did not
	 * look up, and refuses nothing once the machine is paired.
	 */
	denyMachine(input: { code: string }): Promise<void>;
	/**
	 * Removes a machine: its key stops working at once, and its agents keep their conversations and can
	 * no longer run. With `removeSandboxes`, its runner also removes the agents' sandboxes on it and
	 * Windlass's data volume there, now when it is online and when it next connects when not. Throws a
	 * UserError with code `machine_not_found` for one that is not the user's. Answers with the list as it is then.
	 */
	removeMachine(input: { machineId: string; removeSandboxes: boolean }): Promise<MachineSummary[]>;
	/** Turns the sending of saved secrets to a machine's agents on or off, from each one's next turn. Throws as `removeMachine` does. */
	setMachineDetails(input: { machineId: string } & MachineDetails): Promise<MachineSummary[]>;
	setMachineSecrets(input: { machineId: string; send: boolean }): Promise<MachineSummary[]>;
	/** Unpaged calls return every item, newest first. A short page is the last one. */
	listItems(page?: ItemListPage): Promise<ItemSummary[]>;
	/** What the live feed carries (`ItemFeed`): every open item, the newest filed ended ones, and the counts. The web app reads this, not the whole list. */
	itemFeed(): Promise<ItemFeed>;
	/** One item's page. Throws a UserError with code `item_not_found` for one that is not the user's. */
	item(id: string): Promise<ItemView>;
	itemAttachmentLinks(itemId: string): Promise<Array<{ id: string; url: string; expiresAt: number }>>;
	/**
	 * Files a work item, with its own agent session on the repository. Checks the repository at GitHub
	 * as `createSession` does, and throws as it does; also `bad_input` for a title, body or criteria that
	 * cannot be taken. A machine must be paired to this user and have an available profile.
	 */
	createItem(input: CreateItemInput): Promise<ItemSummary>;
	mergeGitlabItem(itemId: string, reviewedHead: string): Promise<ItemView>;
	/** Throws a UserError with code `item_not_found`, or `item_conflict` when the item's state does not allow the action (it says why). */
	actOnItem(input: { id: string; action: ItemAction }): Promise<ItemView>;
	/** The factory's limits for this user. */
	factoryLimits(): Promise<FactoryLimits>;
	/** What prices items' usage: model prices from the public catalog (cached server-side) and the hosted sandbox rates. */
	costRates(): Promise<import("./cost.js").CostRates>;
	/** The items that ended in the last 7, 30 or 90 days, with what each used, for the Usage summary. Throws a UserError with code `bad_input` for another period. */
	finishedItems(days: import("./cost.js").SummaryDays): Promise<import("./cost.js").FinishedItems>;
	/** The user's API tokens, the newest first; never a token's value. */
	apiTokens(): Promise<ApiToken[]>;
	/** Makes an API token: `secret` is its value, shown this once. Throws a UserError with code `bad_input` for a name or scopes that cannot be taken, `too_many_tokens` at MAX_API_TOKENS. */
	createApiToken(input: { name: string; scopes: ApiTokenScope[] }): Promise<{ token: ApiToken; secret: string }>;
	/** Revokes one: it stops working at once. Resolves for one that is not there, too. */
	revokeApiToken(id: string): Promise<ApiToken[]>;
}

export interface UserEvents {
	/** The full list, newest first, after any change to it. */
	sessions: SessionSummary[];
	/** Today's numbers, after sandbox time was held or counted, or a sandbox was kept or freed. */
	usage: UsageNumbers;
	/** The user's machines, after one was paired or removed, or its status, warnings or secrets switch changed. */
	machines: MachineSummary[];
	machineHost: MachineHostUpdate;
	/** The user's open work items and the newest ended ones, with the counts (`ItemFeed`), after any of them changed. */
	items: ItemFeed;
}

export interface SessionSnapshot {
	/** The open request in a person’s session. Item requests live on the item question. */
	secretRequest?: SecretRequest & { id: string };
	summary: SessionSummary;
	profile: SandboxProfile;
	/** The harness's conversation id, once the first turn created it. */
	windlassSessionId: string | null;
	/** The whole stored timeline, oldest first. */
	timeline: TimelineItem[];
	/**
	 * The streaming state of the turn in progress, so that a client that connects in the middle of a
	 * turn sees the text written before it connected: the deltas, in order, whose durable event has
	 * not arrived yet. A delta is dropped when the event that supersedes it is stored (`text.ended`,
	 * `reasoning.ended`, `tool.called`, `tool.settled`, the step's end), so a call still running beside
	 * a finished one keeps its progress. Empty when nothing is running.
	 */
	pending: LiveDelta[];
	/** The question the turn in progress waits on, if any. */
	question: PendingQuestion | null;
	/**
	 * For a session on one of the user's machines, what its banner says of the machine: whether it
	 * answered when the session last needed it, and since when. "not_answering": a turn waits on a
	 * machine that stopped answering, and goes on when it is back or ends ten minutes after `since`.
	 * Null until the session needed its machine since its actor last woke; absent for a hosted session.
	 */
	machine?: { state: "answering" | "not_answering" | "offline" | "removed"; since: number } | null;
}

export interface PromptInput {
	/** The agent's own plan mode for this turn, where it has one (`SessionCapabilities.planMode`): it plans and changes nothing. Only for a turn that starts. */
	planMode?: boolean;
	text: string;
	/** Switches to an offered account or harness model from this turn on. */
	model?: string;
	/**
	 * One of the efforts the turn's model accepts, kept by the session for its later turns. Absent keeps the session's
	 * effort (`SessionSummary.effort`), or the model's default where the turn's model does not take it; null or "" is the model's default.
	 */
	effort?: string | null;
	/** "key": this turn pays with the saved key although Pay with would have it wait for the plan (the answer to `plan_ask`). */
	payWith?: "key";
	/**
	 * The key of this submission (`IdempotencyKey`). The same key again, with the same text, is
	 * answered as the first attempt was and adds nothing: no second message in the running turn, no
	 * second turn. What a key is held against is the text; `model` and `effort` are the first attempt's.
	 * A session remembers the keys of its last MAX_REMEMBERED_SUBMISSIONS messages that came with one.
	 */
	idempotencyKey?: IdempotencyKey;
}

export interface WorkspaceFile {
	/** Relative to the workspace root. */
	path: string;
	/** Git's two-letter status, e.g. " M", "??", "A ". */
	status: string;
}

export interface AgentSessionActions {
	/** Select the mode for the next prompt. An unavailable choice or item session returns bad_input. */
	setMode(input: { mode: string }): Promise<SessionSummary>;
	snapshot(): Promise<SessionSnapshot>;
	/** Create the missing secret at agent scope and continue. A name saved since the request returns secret_exists.
	 * A failed item save reopens the question with its error and a new id. */
	setRequestedSecret(input: SetRequestedSecretInput): Promise<void>;
	/**
	 * Starts a turn and returns as soon as it is accepted; the work arrives as events. While a turn is
	 * running it steers that turn instead: the message is stored as a `user` item with `steer: true`,
	 * the model reads it at its next step, and `steered` is true (`model` and `effort` are ignored
	 * then). Throws a UserError when the text is empty, when the user must sign in to ChatGPT first,
	 * or when a running turn cannot take the message (code `steer_unavailable`).
	 * A turn that would start is also held to its user's two limits (`UsageNumbers`), before a sandbox is
	 * created or started: code `allowance_used` when too little of the day's sandbox time is left, and
	 * `too_many_sandboxes` when the session needs a sandbox and its user keeps as many as they may. Each
	 * comes with a sentence that says what was used, what the limit is, and what to do or when it resets.
	 * With `idempotencyKey`, a message that was taken before under that key is not taken again: the
	 * answer is the one its first attempt had, whatever the session does now (`IdempotencyKey`).
	 */
	prompt(input: PromptInput): Promise<{ turn: number; steered: boolean }>;
	/**
	 * Answers the pending question with one of its choices. `note` goes to the model with the result
	 * (why it was declined, what to do instead); a question about a server takes none. Throws a UserError with code `no_question` when that
	 * question is no longer pending (answered elsewhere, expired, or the turn was stopped), `bad_choice`
	 * when the question does not offer that choice, and `note_too_long` past `MAX_NOTE_CHARS`.
	 */
	answer(input: { questionId: string; choice: string; note?: string }): Promise<void>;
	/**
	 * Stops one running tool call and nothing else: the call settles with what it had done and a line
	 * saying the user stopped it, and the turn goes on. Throws a UserError with code `no_turn` when no turn is running;
	 * resolves with `stopped: false` and Windlass's reason when the call could not be asked to stop.
	 */
	stopCall(input: { messageId: string; callId: string }): Promise<{ stopped: boolean; message: string | null }>;
	/** Stops the turn in progress. Resolves when the stop was asked for, not when it took effect. */
	stop(): Promise<void>;
	/** Files that differ from the last commit in the workspace (empty without a sandbox). */
	changes(): Promise<WorkspaceFile[]>;
	/** `git diff` of the workspace against the last commit, capped at 400 kB. */
	diff(): Promise<string>;
	/** What the side panel shows about the session's pull request. Reads GitHub for the pull request's state; never starts a paused sandbox. */
	publishState(): Promise<PublishState>;
	/**
	 * Puts the session's work on its branch at GitHub: commits what is uncommitted with `message`,
	 * pushes, and opens a pull request when none is open (`message` is its title and body then). The
	 * platform does it, not the agent. Throws a UserError with a sentence the user can act on: code
	 * `publish_blocked` (a turn is running, no connected repository, nothing to push), `github_gone`
	 * (the connection, the installation or the repository is no longer there), `github_denied` (no
	 * write access, a protected branch) or `publish_failed`.
	 */
	publish(input: { message: PublishMessage }): Promise<PublishResult>;
	/**
	 * Sets `SessionSummary.publishUnasked`: whether the agent may have the platform publish the session's
	 * work without the user being asked each time. Takes effect at once, also for a request that is
	 * being asked about (turning it on allows that one). Throws a UserError with code `publish_blocked`
	 * for a session that does not work on a repository of the user's GitHub connection, and for turning
	 * it on in a profile whose commands are not held in Windlass's sandbox, with the sentence that says why.
	 */
	setPublishUnasked(input: { unasked: boolean }): Promise<SessionSummary>;
	/** Reads retained session state and remembered approvals without starting a sandbox. */
	servers(): Promise<SessionServers>;
	/**
	 * Approves a server that waits, by the fingerprint `servers()` gave for it, and remembers that for
	 * the session's project. While a question about that definition is open, this answers it and the
	 * server starts at once; otherwise nothing runs to start it in, and it starts with the next turn,
	 * unasked. Throws a UserError with code `server_gone` when the session knows no such server, and
	 * `server_changed` when it does not wait with that fingerprint (any more).
	 */
	approveServer(input: { name: string; fingerprint: string }): Promise<SessionServers>;
	/**
	 * Forgets the user's remembered approvals of that server for the session's project. It holds for
	 * the next session and the next sandbox (`SessionServers.forgetting` says what stays); no server is
	 * stopped. Resolves when nothing was remembered, too.
	 */
	forgetServer(input: { name: string }): Promise<SessionServers>;
	/**
	 * "Allow for this repository": adds the host to the network list of the session's repository and,
	 * while a turn holds the session's sandbox, lets that sandbox reach it at once (`applied`); otherwise
	 * it applies from the next turn. Only the person who can change the repository's settings may. Today
	 * that is the only person who can call it at all (a session's actions are its user's), so the other
	 * branch, which files a request (`NetworkRequest`) and answers `applied: false`, cannot run yet.
	 * Throws a UserError with code `bad_network` for a host that is not an exact DNS name, a session with
	 * no repository of the GitHub connection, a full list, or a sandbox outside restricted hosted egress.
	 * For blocked destinations only offer this action when BlockedHost.allow is "repository".
	 */
	allowHost(input: { host: string }): Promise<HostAllowed>;
}

export interface AgentSessionEvents {
	/** Replace the network.blocked row with this seq if revision is newer. Counts are cumulative for its turn. */
	networkBlocked: NetworkBlockedItem;
	/** A stored timeline entry, in `seq` order. */
	item: TimelineItem;
	/** Streaming output of the turn in progress. */
	delta: LiveDelta;
	/** The session's summary, after any change to it. */
	summary: SessionSummary;
	/** The pending question, when one is asked; null when it was settled (answered, expired, withdrawn). */
	question: PendingQuestion | null;
	/** For a session on one of the user's machines, what its banner says of the machine, each time that changes. */
	machine: NonNullable<SessionSnapshot["machine"]>;
}
