/**
 * The real `PlatformClient`: the user and session actors over `rivetkit/client` (3.1.1), and the
 * platform's information over plain HTTP (`GET PLATFORM_INFO_PATH` on the platform's address, which
 * any of the servers answers; it is not an actor).
 *
 * Where the actors are reached, and with which token, is asked of the same address when the client is
 * made (connection.ts): the RivetKit client is created once that answer is there, and gets its token
 * from a function, so a token that runs out is replaced without a new client and without a reload.
 *
 * Nothing else in the web app imports RivetKit. The backend did not exist when this was written, so
 * everything here that rests on a reading of the docs rather than on a running server is marked
 * ASSUMPTION and listed again at the bottom of the file.
 *
 * How it talks to the actors:
 * - Actors are addressed by name and key through the untyped client (`client.get(name, key)`),
 *   because the server's registry type is not part of the contract. Arguments and results are typed
 *   here from contract.ts.
 * - Login uses the platform HTTP route. `user` and `agentSession` get the
 *   connection parameter `{ token }` on every handle, which RivetKit sends both when a connection
 *   opens and with each stateless action call.
 * - Actions are stateless calls on the handle (HTTP). The two live feeds each hold one connection
 *   (WebSocket) for events; the state a feed starts from (`listSessions`, `snapshot`) is fetched over
 *   that same connection, so it is ordered with the events that follow it.
 * - RivetKit reconnects a dropped connection by itself and subscribes to the events again. Events
 *   broadcast while it was down are lost, so on every "connected" the feed fetches the whole state
 *   again and hands it over (`onSessions`, `onSnapshot`); the screen rebuilds from it.
 */
import {
	DEFAULT_ENDPOINT,
	DEFAULT_PLATFORM_URL,
	PLATFORM_INFO_PATH,
	type PlatformInfo,
	type AgentSessionActions,
	type AgentSessionEvents,
	type AuthResult,
	type LoginStart,
	type MachineSummary,
	type SessionSnapshot,
	type SessionSummary,
	type TimelineItem,
	type UsageNumbers,
	type GitlabActions,
	type UserActions,
	type UserEvents,
} from "@contract";
import { createClient, type ActorConn, type ActorConnStatus, type ActorHandle } from "rivetkit/client";
import {
	PlatformError,
	type ConnectionState,
	type PlatformClient,
	type SessionApi,
	type SessionFeed,
	type UserApi,
	type UserFeed,
} from "./client";
import { CONNECT_PATIENCE_MS, ConnectionSource, getPlatform } from "./connection";
import { isRefusedConnectionToken, isRestart, RESTARTED_MESSAGE, toPlatformError } from "./errors";

export { toPlatformError };

/**
 * The server's registry type is not part of the contract, so the actor definition is `any`: RivetKit
 * then types a handle's actions and a connection's events loosely, and this file types them from
 * contract.ts instead (`call`, and the annotated event callbacks).
 */
type Untyped = any;
type Handle = ActorHandle<Untyped>;
type Conn = ActorConn<Untyped>;

/**
 * The actor names, as the server's registry is expected to register them. ASSUMPTION 1. Each is reached
 * through the engine's gateway, so a tunnel in front of it must let its paths through
 * (deploy/selfhost/tunnel.example.yml).
 */
export const ACTOR = { user: "user", userGitlab: "userGitlab", agentSession: "agentSession" } as const;

/**
 * How long an action may take. RivetKit retries an endpoint that does not answer for as long as it
 * is asked to, so without a limit a call to a server that is down would never settle. A call that
 * ends here may have arrived all the same, and RivetKit sends one again by itself when the engine
 * says its answer was lost: what must not be done twice goes with the key of its submission
 * (`idempotencyKey` on `prompt` and `createSession`; lib/submission.ts), and the server takes it once.
 */
const ACTION_TIMEOUT_MS = 30_000;
/** A push commits, pushes and opens a pull request before it answers: the server gives it two minutes. */
const PUBLISH_TIMEOUT_MS = 125_000;

/** How long a request that met the platform restarting waits before it is sent the one more time. */
const RESTART_RETRY_MS = 2_000;

/**
 * The actions that only read, so may be sent again when the platform restarts under them. A write is
 * sent again only with the key of its submission (`idempotencyKey`), which the server takes once.
 */
const READS = new Set([
	"me",
	"chatgpt",
	"models",
	"listSessions",
	"github",
	"githubRepositories",
	"githubBranches",
	"repositorySetup",
	"repositoryChecks",
	"repositoryEnvironments",
	"repositoryNetwork",
	"repositorySecrets",
	"repository",
	"githubRepository",
	"savedRepositories",
	"account",
	"accountSecrets",
	"modelProviders",
	"allowance",
	"usage",
	"billing",
	"machines",
	"machineCatalog",
	"listItems",
	"itemFeed",
	"item",
	"factoryLimits",
	"apiTokens",
	"gitlab",
	"gitlabProjects",
	"slack",
	"linear",
	"linearTeams",
	"jira",
	"jiraProjects",
	"snapshot",
	"changes",
	"diff",
	"publishState",
	"servers",
]);

/** Whether an action may be sent twice: it reads, or it carries the key of its submission. */
function isSafeToResend(name: string, args: unknown[]): boolean {
	if (READS.has(name)) return true;
	const input = args[0];
	return (
		typeof input === "object" && input !== null && "idempotencyKey" in input && typeof input.idempotencyKey === "string"
	);
}

/** What an action of a contract interface resolves to. */
type ResultOf<A, K extends keyof A> = A[K] extends (...args: never[]) => Promise<infer R> ? R : never;

/** Makes something once, when it is first asked for, and again after a failure. */
function lazy<T>(make: () => Promise<T>): () => Promise<T> {
	let made: Promise<T> | null = null;
	return () => {
		if (!made) {
			const mine = make();
			made = mine;
			mine.catch(() => {
				if (made === mine) made = null;
			});
		}
		return made;
	};
}

/**
 * An address without the namespace and token it may carry (`https://namespace:token@host`), for
 * messages: neither has any business on the screen.
 */
export function displayAddress(address: string): string {
	try {
		const url = new URL(address);
		url.username = "";
		url.password = "";
		return url.toString().replace(/\/+$/, "");
	} catch {
		return address;
	}
}

/** The address the built web app was loaded from: where the platform's server is when it serves the web app itself. */
function servedFrom(): string | undefined {
	return import.meta.env.PROD && typeof location !== "undefined" ? location.origin : undefined;
}

/**
 * Where the platform's HTTP routes are: VITE_WLP_API when it is set. Otherwise a built web app asks the
 * address it was loaded from, since the platform's server can serve the web app itself (WLP_WEB_DIR),
 * and so needs nothing set at build time. In development it is the Rivet endpoint's host on the
 * platform's port, so that a browser on another machine pointed at `http://host:6420` finds them at
 * `http://host:6440`.
 */
export function platformUrl(
	endpoint: string,
	configured: string | undefined = import.meta.env.VITE_WLP_API,
	page: string | undefined = servedFrom(),
): string {
	if (configured) return configured.replace(/\/+$/, "");
	if (page) return page;
	try {
		const url = new URL(endpoint);
		const local = new URL(DEFAULT_PLATFORM_URL);
		if (url.port === "6420") return `${url.protocol}//${url.hostname}:${local.port}`;
	} catch {
		// Falls through to the default.
	}
	return DEFAULT_PLATFORM_URL;
}

/**
 * `built` is the Rivet endpoint the app was built with (`VITE_WLP_ENDPOINT`), used when the server
 * names none, as a development server does; `api` is the platform's address, which is asked for the
 * connection as soon as the client is made, beside the platform's information.
 */
export function createRivetClient(
	built: string = import.meta.env.VITE_WLP_ENDPOINT || DEFAULT_ENDPOINT,
	api: string = platformUrl(built),
	source: ConnectionSource = new ConnectionSource({ api }),
): PlatformClient {
	// What messages name; the endpoint itself may carry a namespace and a token.
	let shown = displayAddress(built);

	const connect = lazy(async () => {
		const connection = await source.connection();
		const endpoint = connection.endpoint ?? built;
		shown = displayAddress(endpoint);
		return createClient({
			endpoint,
			// The server's namespace goes with the server's endpoint; an endpoint the app was built with says its own.
			...(connection.endpoint !== null ? { namespace: connection.namespace, disableMetadataLookup: true } : {}),
			// Asked before every request and every WebSocket open, and again when the engine refuses the answer.
			...(connection.tokens ? { getToken: source.token } : {}),
			// `devtools` defaults to true on localhost and injects a script from the endpoint; the app does not want it.
			devtools: false,
		});
	});
	// A server that is not there is said by `info`, and by whatever asks for the client next.
	connect().catch(() => undefined);

	/**
	 * Calls one action through a stateless handle or a connection, typed from the contract's interface.
	 * An action the engine refuses for its token (`auth.token_expired`: the browser's clock runs behind,
	 * so RivetKit took the token for good) is sent once more: the engine refused it before any actor saw
	 * it, and RivetKit has fetched the next token by the time the refusal is thrown. An action that met
	 * the platform restarting is sent once more after RESTART_RETRY_MS, when sending it twice is safe.
	 */
	async function call<A, K extends keyof A & string>(
		target: Handle | Conn | Promise<Handle>,
		name: K,
		...args: A[K] extends (...args: infer P) => unknown ? P : never
	): Promise<ResultOf<A, K>> {
		const abort = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		// The first call of a page load is `info`: it is how the app learns the server is not there, so it waits less.
		const limit = name === "info" ? CONNECT_PATIENCE_MS : name === "publish" ? PUBLISH_TIMEOUT_MS : ACTION_TIMEOUT_MS;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				// While the connection is still being asked for, what is not answering is the platform's own address.
				reject(source.failure() ?? new PlatformError("network", `The server at ${shown} did not answer.`));
				abort.abort();
			}, limit);
		});
		// `action({ name, args })` is the raw form of `handle.name(...args)`; it exists on both.
		const send = async (): Promise<ResultOf<A, K>> => (await target).action({ name, args, signal: abort.signal });
		const attempt = () =>
			send().catch((error: unknown) => {
				if (!isRefusedConnectionToken(error) || abort.signal.aborted) throw error;
				return send();
			});
		try {
			const result = attempt().catch(async (error: unknown) => {
				if (!isRestart(error) || !isSafeToResend(name, args)) throw error;
				await new Promise(done => setTimeout(done, RESTART_RETRY_MS));
				if (abort.signal.aborted) throw error;
				return attempt();
			});
			return await Promise.race([result, timeout]);
		} catch (error) {
			const failure = toPlatformError(error, shown);
			// The one more time is spent, or was not safe: RivetKit is not trying again either.
			throw failure.code === "restarting"
				? new PlatformError("restarting", RESTARTED_MESSAGE, { cause: error })
				: failure;
		} finally {
			clearTimeout(timer);
		}
	}

	async function loginPost<T>(step: string, body: object, auth?: AuthResult): Promise<T> {
		const response = await fetch(api.replace(/\/$/, "") + "/platform/login/" + step, {
			method: "POST",
			cache: "no-store",
			redirect: "error",
			headers: { "content-type": "application/json", ...(auth && { authorization: "Bearer " + auth.token }) },
			body: JSON.stringify(body),
		});
		const data = await response.json();
		if (!response.ok)
			throw new PlatformError("user", data.message ?? "Sign-in failed. Try again.", { reason: data.code });
		return data;
	}

	// ASSUMPTION 2: `params` on the handle is what `onBeforeConnect` receives, for `.connect()` and for stateless actions alike.
	const userHandle = (auth: AuthResult) =>
		lazy(async () => (await connect()).get<Untyped>(ACTOR.user, [auth.profile.uid], { params: { token: auth.token } }));
	// ASSUMPTION 3: a session's actor is created by `user.createSession`, so the web app only ever looks it up.
	const sessionHandle = async (auth: AuthResult, sessionId: string) =>
		(await connect()).get<Untyped>(ACTOR.agentSession, [auth.profile.uid, sessionId], {
			params: { token: auth.token },
		});

	/**
	 * A connection that keeps a feed alive: `load` runs on every "connected" (the first and each
	 * reconnect); `live` tells the event handlers whether what they receive follows the loaded state.
	 * The connection is opened once the client is there; `listen` subscribes to its events and returns
	 * what unsubscribes.
	 */
	function feedConnection(
		handle: () => Promise<Handle>,
		report: (state: ConnectionState, error?: PlatformError) => void,
		load: (conn: Conn, isCurrent: () => boolean) => Promise<void>,
		listen: (conn: Conn) => Array<() => void>,
		checkMissing?: () => Promise<unknown>,
	): { reload: () => void; close: () => void } {
		let conn: Conn | null = null;
		let closed = false;
		let everConnected = false;
		/** The screen was told the feed failed; RivetKit's further attempts are not reported until one succeeds. */
		let reportedFailure = false;
		let generation = 0;
		let lastError: PlatformError | null = null;
		let offs: Array<() => void> = [];

		let probe: ReturnType<typeof setTimeout> | undefined;
		const close = () => {
			if (closed) return;
			closed = true;
			clearTimeout(patience);
			clearTimeout(probe);
			for (const off of offs) off();
			conn?.dispose().catch(() => undefined);
		};
		const missing = (error: PlatformError) => {
			if (!checkMissing || error.code !== "not_found") return false;
			close();
			report("failed", error);
			return true;
		};
		// Browsers can hide an HTTP 404 during a WebSocket upgrade behind close code 1006.
		// While the socket is stuck opening, HTTP can distinguish deletion from a network outage.
		const checkOpening = () => {
			if (!checkMissing || closed || probe !== undefined) return;
			const timer = setTimeout(async () => {
				if (conn && conn.connStatus !== "connected" && conn.connStatus !== "idle") {
					try {
						await checkMissing();
					} catch (error) {
						if (!closed && probe === timer) missing(toPlatformError(error, shown));
					}
				}
				if (probe !== timer) return;
				probe = undefined;
				if (conn && conn.connStatus !== "connected" && conn.connStatus !== "idle") checkOpening();
			}, CONNECT_PATIENCE_MS);
			probe = timer;
		};

		const reload = () => {
			const open = conn;
			if (closed || !open) return;
			const mine = ++generation;
			const isCurrent = () => !closed && mine === generation;
			load(open, isCurrent).catch((error: unknown) => {
				if (!isCurrent()) return;
				const failure = toPlatformError(error, shown);
				if (missing(failure)) return;
				// A connection that drops during the load is retried by RivetKit; anything else is final.
				if (open.connStatus === "connected") report("failed", failure);
				else lastError = failure;
			});
		};

		const onStatus = (status: ActorConnStatus) => {
			if (closed) return;
			if (status === "connected") {
				clearTimeout(probe);
				probe = undefined;
				everConnected = true;
				reportedFailure = false;
				reload();
			} else if (status === "idle") {
				// RivetKit gave up: the open was refused (a bad token, a destroyed actor). `onError` said why.
				generation++;
				reportedFailure = true;
				report("failed", lastError ?? new PlatformError("network", `The connection to ${shown} could not be opened.`));
			} else {
				generation++;
				checkOpening();
				if (!reportedFailure) report(everConnected ? "reconnecting" : "connecting");
			}
		};

		report("connecting");
		handle().then(
			found => {
				if (closed) return;
				const opened: Conn = found.connect();
				conn = opened;
				offs = [
					...listen(opened),
					opened.onStatusChange(onStatus),
					opened.onError(error => {
						if (closed) return;
						lastError = toPlatformError(error, shown);
						if (missing(lastError)) return;
						// Whatever RivetKit does next (it may keep retrying), these two will not get better by waiting.
						if (lastError.code === "unauthorized" || lastError.code === "not_found") {
							generation++;
							reportedFailure = true;
							report("failed", lastError);
						}
					}),
				];
				// The connection opens by itself; if it is already open, the status callback will not fire for it.
				if (opened.connStatus === "connected") onStatus("connected");
				else checkOpening();
			},
			(error: unknown) => {
				// The server refused to say how to connect: asking again will not change that.
				if (closed) return;
				reportedFailure = true;
				report("failed", toPlatformError(error, shown));
			},
		);
		// RivetKit keeps trying a server that does not answer, and the connection is asked for as long.
		// Say so after a while; if it does connect later, "connected" follows and the screen recovers.
		const patience = setTimeout(() => {
			if (closed || everConnected || reportedFailure) return;
			reportedFailure = true;
			report(
				"failed",
				lastError ?? source.failure() ?? new PlatformError("network", `The server at ${shown} is not answering.`),
			);
		}, CONNECT_PATIENCE_MS);

		return { reload, close };
	}

	function userApi(auth: AuthResult): UserApi {
		const handle = userHandle(auth);
		const act = <K extends keyof UserActions & string>(name: K, ...args: Parameters<UserActions[K]>) =>
			call<UserActions, K>(handle(), name, ...(args as never));
		// ASSUMPTION 3: like a session's, the GitLab actor is created on the server, since the browser's engine
		// token may only look actors up. `openGitlab` creates it when the deployment has GitLab, and says whether it does.
		const gitlabHandle = lazy(async () =>
			(await act("openGitlab"))
				? (await connect()).get<Untyped>(ACTOR.userGitlab, [auth.profile.uid], { params: { token: auth.token } })
				: null,
		);
		const gitlab = async <K extends keyof GitlabActions>(name: K, ...args: Parameters<GitlabActions[K]>) => {
			const found = await gitlabHandle();
			if (!found) throw new PlatformError("user", "GitLab is not configured.", { reason: "gitlab_off" });
			return call<GitlabActions, K>(found, name, ...(args as never));
		};
		return {
			me: () => act("me"),
			signOutEverywhere: (...args) => act("signOutEverywhere", ...args),
			linkedLogins: () => act("linkedLogins"),
			unlinkLogin: provider => act("unlinkLogin", provider),
			chatgpt: () => act("chatgpt"),
			startChatgpt: () => act("startChatgpt"),
			finishChatgpt: callback => act("finishChatgpt", callback),
			forgetChatgpt: () => act("forgetChatgpt"),
			models: () => act("models"),
			listSessions: () => act("listSessions"),
			createSession: input => act("createSession", input),
			continueSession: input => act("continueSession", input),
			renameSession: (id, title) => act("renameSession", id, title),
			deleteSession: id => act("deleteSession", id),
			gitlab: async () => ((await gitlabHandle()) ? gitlab("gitlab") : { state: "off" }),
			gitlabConnect: input => gitlab("gitlabConnect", input),
			gitlabComplete: ticket => gitlab("gitlabComplete", ticket),
			gitlabProjects: query => gitlab("gitlabProjects", query),
			gitlabPickProject: id => gitlab("gitlabPickProject", id),
			gitlabDisconnect: () => gitlab("gitlabDisconnect"),
			github: () => act("github"),
			githubConnect: (origin, install) => act("githubConnect", { origin, install }),
			githubComplete: ticket => act("githubComplete", ticket),
			githubDisconnect: () => act("githubDisconnect"),
			githubRepositories: (query, fresh) => act("githubRepositories", query, fresh),
			githubBranches: repositoryId => act("githubBranches", repositoryId),
			repositorySetup: repositoryId => act("repositorySetup", repositoryId),
			saveRepositorySetup: (repositoryId, command) => act("saveRepositorySetup", { repositoryId, command }),
			repositoryChecks: repositoryId => act("repositoryChecks", repositoryId),
			saveRepositoryChecks: (repositoryId, checks) => act("saveRepositoryChecks", { repositoryId, checks }),
			repositoryEnvironments: repositoryId => act("repositoryEnvironments", repositoryId),
			rebuildEnvironment: (repositoryId, place) =>
				act("rebuildEnvironment", { repositoryId, ...(place !== undefined && { place }) }),
			saveEnvironmentSchedule: (repositoryId, schedule) => act("saveEnvironmentSchedule", { repositoryId, schedule }),
			repositoryNetwork: repositoryId => act("repositoryNetwork", repositoryId),
			saveRepositoryNetwork: (repositoryId, entries) => act("saveRepositoryNetwork", { repositoryId, entries }),
			dismissNetworkRequest: (repositoryId, host) => act("dismissNetworkRequest", { repositoryId, host }),
			scanRepositoryNetwork: repositoryId => act("scanRepositoryNetwork", repositoryId),
			repositorySecrets: (repositoryId, profile) => act("repositorySecrets", { repositoryId, profile }),
			saveRepositorySecret: (repositoryId, profile, secret) =>
				act("saveRepositorySecret", { repositoryId, profile, ...secret }),
			deleteRepositorySecret: (repositoryId, profile, name) =>
				act("deleteRepositorySecret", { repositoryId, profile, name }),
			repository: repositoryId => act("repository", repositoryId),
			setGuideCheck: (id, enabled) => act("setGuideCheck", id, enabled),
			setSetupWeekly: (id, enabled) => act("setSetupWeekly", id, enabled),
			addSetupNotes: (id, files) => act("addSetupNotes", id, files),
			deleteSetupNote: (id, note) => act("deleteSetupNote", id, note),
			runReadiness: (...args) => act("runReadiness", ...args),
			githubRepository: repositoryId => act("githubRepository", repositoryId),
			saveRepositoryDefaults: (repositoryId, change) => act("saveRepositoryDefaults", { repositoryId, ...change }),
			forgetRepositoryApproval: (repositoryId, name) => act("forgetRepositoryApproval", { repositoryId, name }),
			forgetRepository: repositoryId => act("forgetRepository", repositoryId),
			savedRepositories: () => act("savedRepositories"),
			account: () => act("account"),
			saveAccountDefaults: change => act("saveAccountDefaults", change),
			savePersonalServer: server => act("savePersonalServer", server),
			deletePersonalServer: name => act("deletePersonalServer", name),
			modelProviders: () => act("modelProviders"),
			saveModelProvider: input => act("saveModelProvider", input),
			checkModelProvider: provider => act("checkModelProvider", provider),
			removeModelProvider: provider => act("removeModelProvider", provider),
			accountSecrets: profile => act("accountSecrets", { profile }),
			saveAccountSecret: (profile, secret) => act("saveAccountSecret", { profile, ...secret }),
			deleteAccountSecret: (profile, name) => act("deleteAccountSecret", { profile, name }),
			allowance: () => act("allowance"),
			usage: () => act("usage"),
			freeSandbox: sessionId => act("freeSandbox", sessionId),
			billing: () => act("billing"),
			billingCheckout: input => act("billingCheckout", input),
			billingPortal: input => act("billingPortal", input),
			setOverageCap: input => act("setOverageCap", input),
			machines: () => act("machines"),
			machineCatalog: input => act("machineCatalog", input),
			claimMachine: input => act("claimMachine", input),
			confirmMachine: input => act("confirmMachine", input),
			removeMachine: input => act("removeMachine", input),
			setMachineDetails: input => act("setMachineDetails", input),
			setMachineSecrets: input => act("setMachineSecrets", input),
			setCredentialSource: input => act("setCredentialSource", input),
			listItems: (...args) => act("listItems", ...args),
			itemFeed: () => act("itemFeed"),
			item: id => act("item", id),
			itemAttachmentLinks: itemId => act("itemAttachmentLinks", itemId),
			createItem: input => act("createItem", input),
			mergeGitlabItem: (id, head) => act("mergeGitlabItem", id, head),
			actOnItem: (id, action) => act("actOnItem", { id, action }),
			factoryLimits: () => act("factoryLimits"),
			jira: () => act("jira"),
			jiraConnect: input => act("jiraConnect", input),
			jiraComplete: ticket => act("jiraComplete", ticket),
			jiraSelectSite: siteId => act("jiraSelectSite", siteId),
			jiraProjects: () => act("jiraProjects"),
			saveJiraMapping: input => act("saveJiraMapping", input),
			removeJiraMapping: input => act("removeJiraMapping", input),
			disconnectJira: () => act("disconnectJira"),
			slack: () => act("slack"),
			slackChannels: () => act("slackChannels"),
			slackConnect: input => act("slackConnect", input),
			slackComplete: ticket => act("slackComplete", ticket),
			saveSlackMapping: input => act("saveSlackMapping", input),
			removeSlackMapping: channelId => act("removeSlackMapping", channelId),
			setSlackDetails: input => act("setSlackDetails", input),
			disconnectSlack: () => act("disconnectSlack"),
			linkedAccounts: () => act("linkedAccounts"),
			linkAccount: ticket => act("linkAccount", ticket),
			linkOffer: ticket => act("linkOffer", ticket),
			linkAccountStart: input => act("linkAccountStart", input),
			unlinkAccount: input => act("unlinkAccount", input),
			linear: () => act("linear"),
			linearConnect: input => act("linearConnect", input),
			linearComplete: ticket => act("linearComplete", ticket),
			linearTeams: () => act("linearTeams"),
			saveLinearMapping: input => act("saveLinearMapping", input),
			removeLinearMapping: teamId => act("removeLinearMapping", teamId),
			disconnectLinear: () => act("disconnectLinear"),
			apiTokens: () => act("apiTokens"),
			createApiToken: input => act("createApiToken", input),
			revokeApiToken: id => act("revokeApiToken", id),
			watch(feed: UserFeed) {
				let live = false;
				const feedConn = feedConnection(
					handle,
					(state, error) => {
						if (state !== "connected") live = false;
						feed.onConnection?.(state, error);
					},
					async (conn, isCurrent) => {
						live = false;
						const sessions = await call<UserActions, "listSessions">(conn, "listSessions");
						if (!isCurrent()) return;
						feed.onConnection?.("connected");
						feed.onSessions(sessions);
						live = true;
					},
					// ASSUMPTION 4: an event broadcast as `c.broadcast("sessions", list)` arrives as `on("sessions", (list) => ...)`.
					conn => [
						conn.on("sessions" satisfies keyof UserEvents, (sessions: SessionSummary[]) => {
							if (live) feed.onSessions(sessions);
						}),
						conn.on("usage" satisfies keyof UserEvents, (numbers: UsageNumbers) => {
							if (live) feed.onUsage?.(numbers);
						}),
						conn.on("machineHost" satisfies keyof UserEvents, (update: UserEvents["machineHost"]) => {
							if (live) feed.onMachineHost?.(update);
						}),
						conn.on("machines" satisfies keyof UserEvents, (machines: MachineSummary[]) => {
							if (live) feed.onMachines?.(machines);
						}),
						conn.on("items" satisfies keyof UserEvents, (items: UserEvents["items"]) => {
							if (live) feed.onItems?.(items);
						}),
					],
				);
				return () => feedConn.close();
			},
		};
	}

	function sessionApi(auth: AuthResult, sessionId: string): SessionApi {
		const freshHandle = () => sessionHandle(auth, sessionId);
		const handle = lazy(freshHandle);
		const act = <K extends keyof AgentSessionActions & string>(name: K, ...args: Parameters<AgentSessionActions[K]>) =>
			call<AgentSessionActions, K>(handle(), name, ...(args as never));
		const reloads = new Set<() => void>();
		return {
			prompt: input => act("prompt", input),
			answer: input => act("answer", input),
			stopCall: input => act("stopCall", input),
			stop: () => act("stop"),
			changes: () => act("changes"),
			diff: () => act("diff"),
			publishState: () => act("publishState"),
			publish: message => act("publish", { message }),
			setMode: mode => act("setMode", { mode }),
			setPublishUnasked: unasked => act("setPublishUnasked", { unasked }),
			servers: () => act("servers"),
			approveServer: (name, fingerprint) => act("approveServer", { name, fingerprint }),
			forgetServer: name => act("forgetServer", { name }),
			allowHost: host => act("allowHost", { host }),
			setRequestedSecret: input => act("setRequestedSecret", input),
			resync() {
				for (const reload of reloads) reload();
			},
			open(feed: SessionFeed) {
				let live = false;
				// Stored items that arrive while the snapshot is on its way. They are replayed after it; the
				// reducer drops the ones the snapshot already holds, by `seq`. Deltas cannot be told apart
				// that way and are dropped: the durable event that ends each stream carries the whole value.
				let early: TimelineItem[] = [];
				const feedConn = feedConnection(
					handle,
					(state, error) => {
						if (state !== "connected") live = false;
						feed.onConnection(state, error);
					},
					async (conn, isCurrent) => {
						live = false;
						early = [];
						const snapshot: SessionSnapshot = await call<AgentSessionActions, "snapshot">(conn, "snapshot");
						if (!isCurrent()) return;
						feed.onConnection("connected");
						// A server without questions sends no `question`: read it as none.
						feed.onSnapshot({ ...snapshot, question: snapshot.question ?? null });
						for (const item of early) feed.onItem(item);
						early = [];
						live = true;
					},
					conn => [
						conn.on("item" satisfies keyof AgentSessionEvents, (item: AgentSessionEvents["item"]) => {
							if (live) feed.onItem(item);
							else early.push(item);
						}),
						// A newer revision of a turn's `network.blocked` row, with the seq it replaces: the reducer swaps it in place.
						// Kept with the items before the snapshot, which carries a revision at least as new.
						conn.on(
							"networkBlocked" satisfies keyof AgentSessionEvents,
							(item: AgentSessionEvents["networkBlocked"]) => {
								if (live) feed.onItem(item);
								else early.push(item);
							},
						),
						conn.on("delta" satisfies keyof AgentSessionEvents, (delta: AgentSessionEvents["delta"]) => {
							if (live) feed.onDelta(delta);
						}),
						conn.on("summary" satisfies keyof AgentSessionEvents, (summary: AgentSessionEvents["summary"]) => {
							if (live) feed.onSummary(summary);
						}),
						// ASSUMPTION 9. One that arrives before the snapshot is dropped, like a delta: by ASSUMPTION 7
						// the snapshot is newer, and unlike an item a question has no `seq` to tell. The snapshot's
						// `question` is the whole truth after every (re)connect, so one settled during a gap disappears.
						conn.on(
							"question" satisfies keyof AgentSessionEvents,
							(question: AgentSessionEvents["question"] | undefined) => {
								if (live) feed.onQuestion(question ?? null);
							},
						),
						// Dropped before the snapshot, as a question is: the snapshot's `machine` is newer.
						conn.on("machine" satisfies keyof AgentSessionEvents, (machine: AgentSessionEvents["machine"]) => {
							if (live) feed.onMachine?.(machine);
						}),
					],
					// Resolve by key on a fresh handle. An old handle can cache the deleted actor ID.
					async () => (await freshHandle()).resolve(),
				);
				reloads.add(feedConn.reload);
				return () => {
					reloads.delete(feedConn.reload);
					feedConn.close();
				};
			},
		};
	}

	return {
		kind: "rivet",
		// The address the app was built with until the server has named the one to use.
		get endpoint() {
			return shown;
		},
		info: () => getPlatform<PlatformInfo>(api, PLATFORM_INFO_PATH),
		login: {
			async start(provider = "github", auth) {
				const id = crypto.randomUUID();
				const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
					.replaceAll("+", "-")
					.replaceAll("/", "_")
					.replace(/=+$/, "");
				const started = await loginPost<LoginStart>("start", { id, secret, provider }, auth);
				sessionStorage.setItem(
					"wlp.login",
					JSON.stringify({ id, secret, state: new URL(started.url).searchParams.get("state") }),
				);
				return started;
			},
			async finish(callback, auth) {
				const saved = JSON.parse(sessionStorage.getItem("wlp.login") ?? "null");
				if (!saved?.state || new URL(callback).searchParams.get("state") !== saved.state)
					throw new PlatformError("user", "Start the sign-in in this tab.");
				const result = await loginPost<AuthResult>("finish", { id: saved.id, secret: saved.secret, callback }, auth);
				sessionStorage.removeItem("wlp.login");
				return result;
			},
			demo: () => loginPost<AuthResult>("demo", { id: crypto.randomUUID() }),
		},
		user: userApi,
		session: sessionApi,
		dispose() {
			source.close();
			connect().then(
				client => client.dispose().catch(() => undefined),
				() => undefined,
			);
		},
	};
}

/*
 * ASSUMPTIONS to check against the running backend
 *
 * 1. The browser opens user, userGitlab and agentSession actors by [uid], [uid] and [uid, sessionId].
 * 2. Parameters. `{ params: { token } }` given to `get` reaches the actor's
 *    `onBeforeConnect(c, params)` both for `.connect()` and for a stateless `handle.action(...)`.
 * 3. Creation. The login HTTP service creates the user. An
 *    `agentSession` is created by the server in `user.createSession`; the client uses `get`, and an
 *    unknown session fails with group "actor", code "not_found". `userGitlab` is created by the server
 *    in `user.openGitlab`, which the client calls before it looks that actor up. The browser's engine
 *    token cannot create actors (server/src/connection-tokens.ts), so no browser handle uses `getOrCreate`.
 * 4. Events. `c.broadcast("item", item)` (one argument) arrives as `conn.on("item", (item) => ...)`;
 *    `on` returns the function that unsubscribes; the names are "sessions" (user) and "item",
 *    "delta", "summary", "question", "machine" (agentSession). Subscriptions survive a reconnect (RivetKit resends them).
 * 5. Errors. A `UserError` arrives with `group: "user"` and its message intact, through both the
 *    stateless handle and a connection. A refused token is recognised by its `code` only: one of
 *    UNAUTHORIZED_CODES (errors.ts). A UserError with another code and the same meaning would be shown as
 *    an ordinary message instead of signing the user out.
 * 6. Connection status. "connected" is reported on the first open and on every reconnect;
 *    "disconnected" / "connecting" in between; "idle" when RivetKit stops retrying, after `onError`
 *    was called with the reason. An error thrown in `onBeforeConnect` reaches `conn.onError` as a
 *    RivetError whose `code` is the UserError's code (its message may be "Connection closed: ...").
 * 7. Ordering. The response of `snapshot()` called over the connection is delivered before the
 *    events broadcast after the actor computed it. Items that arrive earlier are buffered and
 *    replayed (deduplicated by `seq`), deltas that arrive earlier are dropped.
 * 8. Encoding. The default ("bare") carries the contract's plain JSON values unchanged, including
 *    `null`, nested objects with unknown fields (`WindlassEvent`) and numbers above 2^31 (`at`).
 * 9. Questions. The event is named "question" and carries the `PendingQuestion`, or `null` (an
 *    `undefined` argument is read as `null`), as its one argument; `snapshot()` carries `question` (a
 *    missing field is read as `null`). A "question" event that arrives while the snapshot is on its way
 *    is dropped (see 7). `answer`, `stopCall` and the steering `prompt` are actions with these names and
 *    one object argument each, as contract.ts declares them; `prompt` resolves with `{ turn, steered }`.
 * 10. Error codes. A UserError thrown with a code (`no_question`, `steer_unavailable`) arrives with
 *    `group: "user"` and that `code`; the web app keeps it as `PlatformError.reason` and acts on those
 *    two. Since `toPlatformError` checks UNAUTHORIZED_CODES first, a UserError must not use those codes.
 */
