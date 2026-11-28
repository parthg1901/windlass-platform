/**
 * Server configuration, read once from the environment.
 *
 *   WLP_DEMO=1                 offer the demo sign-in (scripted model, no ChatGPT account)
 *   WLP_ALLOWED_EMAILS, WLP_ALLOWED_USERS
 *                              who may sign in: verified provider emails and user ids (`u_...`),
 *                              comma-separated. Unset, both: any authenticated account. Asked at
 *                              the sign-in and at every call, so a removal holds at once (access.ts)
 *   WLP_GOOGLE_CLIENT_ID, WLP_GOOGLE_CLIENT_SECRET
 *                              enable Google platform login when both are configured
 *   WLP_PLAN_USERS             who may connect a subscription plan (a Claude plan) and run hosted turns on it:
 *                              user ids (`u_...`), comma-separated, or `*` for everyone. Unset: nobody, and
 *                              turns stop using connected plans at once (the kill switch)
 *   WLP_PLAN_PARALLEL_TURNS    the most hosted turns one connected plan pays for at once (default 3, 1–20); past
 *                              it an item waits and a prompt is asked about, as at the plan's limit (pay-with.ts)
 *   WLP_ALLOW_DOCKER_HOSTED=1 explicitly allow the Docker sandbox layer with a remote engine
 *   WLP_SANDBOX=docker|e2b|daytona|fake
 *                              the sandbox layer (default docker). docker: containers on this machine, for
 *                              one server. e2b: E2B microVMs, which every server of a deployment reaches
 *                              (the variables below). fake keeps everything in memory
 *   WLP_SECRET_KEYS            ordered signing roots (id:secret,id:secret), overriding WLP_SECRET
 *   WLP_SIGNIN_KEYS            ordered sealing roots, overriding WLP_SIGNIN_KEY
 *   WLP_SECRET                 signs tokens; when unset one is generated and kept in .data/secret.
 *                              Required with a remote engine: every server must sign with the same one
 *   WLP_SIGNIN_KEY             what the key that encrypts ChatGPT sign-ins in actor storage is derived from
 *                              (signin/seal.ts); at least 32 characters, the same on every server. When
 *                              unset the key is derived from WLP_SECRET, under a label of its own
 *   WLP_WEB_ORIGINS            comma-separated web origins allowed to connect
 *                              (default http://localhost:5173,http://127.0.0.1:5173)
 *   RIVETKIT_STORAGE_PATH      where the local Rivet engine keeps actor data, in a `.rivetkit` folder
 *                              inside this directory (default: <repository>/.data)
 *   WLP_FAKE_DELAY_MS          fake layer only: delay between replayed events (default 15)
 *   WLP_LOGIN_TTL_MS           how long a sign-in attempt is accepted (default 600000, ten minutes);
 *                              shortened by tests
 *   WLP_QUESTION_TIMEOUT_MS    how long a question in an interactive turn waits for an answer before
 *                              the platform declines it (default ten minutes; work items never use it)
 *   WLP_HOSTED_QUESTION_TIMEOUT_MS  in a hosted sandbox, how long an approval waits before the platform
 *                              ends the turn so the sandbox can pause (default 5 minutes, at most
 *                              WLP_QUESTION_TIMEOUT_MS)
 *   WLP_TURN_TIMEOUT_MS        how long one turn may run (default 45 minutes)
 *   WLP_TURN_RESUME=1          a turn running when its server stops, or whose machine goes away, is
 *                              paused and resumes by itself (the agent's saved session and a short
 *                              resume prompt) instead of being cut short. Default off
 *   WLP_TURN_RESUME_FLOOR_MS   the least time a resumed turn gets, whatever it ran before (default 5
 *                              minutes; at most WLP_TURN_TIMEOUT_MS). For tests
 *   WLP_TURN_RESUME_DELAY_MS   how long after a graceful pause the turn resumes at the earliest (default
 *                              three seconds). For tests
 *   WLP_TURN_HEARTBEAT_MS      how far ahead a running turn keeps the wake that resumes it after a
 *                              crash (default one minute). For tests
 *   WLP_MACHINE_AWAY_ASK_MS    how long an item's turn waits for its machine before the item asks its
 *                              person once (default six hours). For tests
 *   WLP_SETUP_TIMEOUT_MS       how long a repository's setup command may run in a new sandbox before the
 *                              platform stops it (default 600000, ten minutes; at most the time a turn
 *                              may take, since it runs inside one). The same on every server
 *   WLP_IDLE_SUSPEND_MS        how long after its last turn ended a session's sandbox is suspended
 *                              (default 10 minutes)
 *   WLP_IDLE_DESTROY_MS        how long after its last use a session's sandbox is removed with its
 *                              files (default 7 days); the timeline stays
 *   WLP_DAILY_SANDBOX_SECONDS  how many seconds a user's sandboxes may run in one UTC day, all of them
 *                              together (default 7200, two hours; at least 60). `unlimited` sets no
 *                              limit: the time is counted and shown all the same (usage.ts). The same
 *                              on every server, like the two below
 *   WLP_MAX_KEPT_SANDBOXES     how many sandboxes a user may keep at the same time, running or paused
 *                              (default 5; at least 1). `unlimited` sets no limit
 *   WLP_USAGE_HOLD_SECONDS     how much of the day's allowance a running sandbox reserves at a time,
 *                              and so how often its session reports to the user's actor (default 300,
 *                              five minutes; from 5 to 3600). Shortened by the checks
 *   WLP_ITEMS=1                offer work items, the software factory, to every user of the deployment
 *                              (default off). Off, `/api/items` answers as an unknown route does, the
 *                              user actor's item and API token actions throw `items_off`, and platform
 *                              info has no `items`: each of those entry points reads `config.items`
 *                              once, and nothing else does. The `workItem` actors and the tables are
 *                              there either way, and an item that exists goes on with its steps, so
 *                              turning it off and on again loses nothing; while it is off, nobody can
 *                              file, read or act on an item
 *   WLP_DAILY_TOKENS           model tokens per user per UTC day (default unlimited)
 *   WLP_MODEL_PRICES_URL       the public model catalog items' token costs are priced from (model-prices.ts;
 *                              default https://models.dev/api.json). `off`: none is read, and a turn's tokens
 *                              are priced only where its agent reported its cost; otherwise its cost is unknown
 *   WLP_FACTORY_CROSS_REPO=1   let a Plan-first feature be filed over two repositories (default off):
 *                              its children build in either, each repository gets its own draft PR,
 *                              and the repositories are tested together before the feature is handed
 *                              over (docs/factory, "Cross-repo features"). Off, a filing that names a
 *                              second repository is refused; a feature filed while it was on goes on
 *   WLP_FACTORY_HOSTED_RUNNING a user's hosted sandboxes running at once, factory turns and their own
 *                              hosted agents together (default 3; factory/budget.ts FACTORY_DEFAULTS).
 *                              Sandboxes on the user's machines never count: their runners' slots
 *                              bound them. A factory turn past it waits, with a sentence; a prompt of
 *                              the person's own is refused with one
 *   WLP_FACTORY_GITHUB_ITEMS_PER_DAY
 *                              items a user may file from GitHub issues a UTC day, drafts among them
 *                              (default 20)
 *   WLP_FACTORY_ITEM_TOKENS, WLP_FACTORY_ITEM_HOSTED_SECONDS, WLP_FACTORY_ITEM_USD (dollars, where a key pays),
 *   WLP_FACTORY_ITEM_PLAN_PCT, WLP_FACTORY_ITEM_PLAN_WEEK_PCT (points of the plan's 5-hour and weekly windows,
 *                              where a plan pays; each holds where the plan reports that window)
 *                              a new work item's budget (default $5, 20% of the 5-hour window, 3% of the
 *                              weekly window, 2,000,000 cost-weighted tokens where none can be measured, cached input at a
 *                              tenth, and 2 hours of hosted sandbox); used up, the item asks
 *                              its person for more. The same on every server, like all of these
 *   WLP_HTTP_PORT, PORT        where the platform's HTTP routes listen (`/platform/info`, `/health`);
 *                              WLP_HTTP_PORT first, then PORT, which Rivet Cloud sets on its nodes
 *                              (default 6440)
 *   WLP_HTTP_HOST              the address they bind (default 127.0.0.1 with the local engine, 0.0.0.0
 *                              with a remote one)
 *   WLP_WEB_DIR                the web app's built files (`web/dist`), for the server to serve itself
 *                              on that port (web.ts): one address for the whole platform. Unset: it
 *                              serves none, and the web app is hosted elsewhere. server/Dockerfile sets it
 *
 * What browsers connect with (`GET /platform/connection`, platform-info.ts; docs/operating.md, "Running on several
 * servers"). None of it is needed with the local engine, which asks for no token:
 *
 *   WLP_PUBLIC_ENDPOINT        the Rivet endpoint browsers connect to, without a namespace or a token in
 *                              it: for a Rivet Cloud cluster, https://<name>-api.onrivet.dev. It is
 *                              not RIVET_ENDPOINT, which is the server's own way to the engine and may be
 *                              an address only the server reaches. Unset: the web app uses the endpoint
 *                              it was built with
 *   RIVET_ADMIN_TOKEN          the engine's admin token, for an engine that asks browsers for a token (a
 *                              Rivet Cloud cluster, or an engine of your own with `auth.admin_token`).
 *                              A secret: it is sent to the engine as a bearer and to nothing else, and
 *                              is never logged or put in an error or an answer. The server uses it for
 *                              one thing, to issue the short-lived tokens it hands browsers
 *                              (connection-tokens.ts). Unset: browsers are handed no token
 *   WLP_TOKEN_ENDPOINT         optional private route to the same engine for token issuance.
 *                              Defaults to WLP_PUBLIC_ENDPOINT, the address advertised to browsers
 *   WLP_CONNECTION_TOKEN_TTL_MS
 *                              how long such a token lasts (default 3600000, one hour; at least one
 *                              minute, and at most the 24 hours a Rivet Cloud cluster issues one for).
 *                              A server hands one token to every browser until half of that is gone
 *
 * With WLP_SANDBOX=e2b (read in sandbox/e2b/config.ts; docs/operating.md, "E2B"). Hosted deployment settings and defaults are listed there.
 *
 *   E2B_API_KEY                the E2B account's API key. Required: without it the server does not start
 *   WLP_E2B_TEMPLATE           the template sandboxes are made from (default windlass-platform-sandbox,
 *                              which sandbox/e2b/build.sh builds). A sandbox has its template's size:
 *                              1 vCPU and 1024 MiB unless the template was built otherwise
 *   WLP_E2B_SHOTS_TEMPLATE     the template for opted-in work items (default windlass-platform-sandbox-shots)
 *   WLP_E2B_SIZES              the hosted sizes whose templates are built: small, standard, large (default
 *                              small). Each is a template of its own (e2b/config.ts); work items default to standard
 *   WLP_E2B_TEMPLATE_STANDARD, WLP_E2B_TEMPLATE_LARGE, WLP_E2B_SHOTS_TEMPLATE_STANDARD, WLP_E2B_SHOTS_TEMPLATE_LARGE
 *                              the other sizes' templates (default windlass-platform-sandbox-standard, -large, and -shots)
 *   WLP_E2B_DEPLOYMENT         marks every sandbox of this deployment in its metadata, so they are
 *                              counted, listed and removed together (default "default"). The same on
 *                              every server of a deployment; different for another deployment that
 *                              shares the E2B account
 *   WLP_E2B_MAX_RUNNING        how many of the deployment's sandboxes may run at the same time, counted
 *                              from E2B's own list across servers (default 3). At the cap a user is told to try again later
 *   WLP_E2B_IDLE_TIMEOUT_MS    a sandbox's own timeout while no turn runs in it: E2B pauses it by itself
 *                              this long after it was last connected to (default 120000, two minutes)
 *   WLP_E2B_TURN_LEASE_MS      a sandbox's own timeout while a turn runs, set again every third of it by
 *                              the server that runs the turn (default 180000): a sandbox whose server
 *                              died is paused by E2B within this time
 *   WLP_E2B_MAX_RUNTIME_MS     how long the account lets a sandbox run without a pause (default 3600000). A sandbox with too little of it
 *                              left for a turn is paused and resumed before the turn starts
 *   WLP_E2B_PAUSE=0            for an account that cannot pause: a sandbox is killed where it would be
 *                              paused (its timeout, `suspend`), and the session's files and its Windlass
 *                              session are lost each time (default 1: pause)
 *   WLP_E2B_WINDLASS_SANDBOX=1 promise Windlass's own sandbox in the E2B profile (no network for
 *                              commands, the access token out of their reach) and remove any new
 *                              sandbox in which bubblewrap does not work. Only once scripts/e2b-check.ts
 *                              has shown that it does (default 0: nothing is promised of it)
 *   WLP_E2B_OPEN_PROFILE=1     also offer "E2B, microVM only" (`e2b-open`): Windlass sandboxes no
 *                              command and runs with --approval full, so commands have the microVM's
 *                              network, a writable home directory and the turn's access token, and
 *                              nothing asks first. Users choose it per session; the E2B profile stays
 *                              the default (default 0: listed, not offered)
 *   WLP_E2B_WINDLASS_VERSION   the Windlass version in the template, to show it before the first sandbox
 *                              was made (default: learned from the first sandbox)
 *   WLP_E2B_NETWORK            what the deployment's sandboxes may reach, enforced by E2B outside the
 *                              microVM (sandbox/e2b/network.ts): open (default, as before), restricted
 *                              (the model API, the git host, the bucket and WLP_E2B_NETWORK_ALLOW only) or
 *                              none (the model API and the bucket only; repositories are refused)
 *   WLP_E2B_NETWORK_ALLOW      with restricted: exact host names and presets (@npm, @pypi, @github,
 *                              @crates, @go), comma-separated (default @npm,@pypi,@github)
 *
 * The bucket (read by `backupConfig` below; docs/architecture.md, "The agent's memory outlives its sandbox"). Where
 * Windlass's own session data lives on the sandbox's disk (E2B), a copy of it is kept in a bucket after
 * every turn and put back into the sandbox that replaces a lost one (sandbox/backup.ts). Any store
 * that speaks the S3 protocol will do, and changing the provider is changing these. With none of the
 * first four set the feature is off, and a session whose sandbox is lost starts a new Windlass session,
 * as it did before there was a bucket; with only some of them set it is off too, and the server says
 * which are missing when it starts. They are the same on every server.
 *
 *   WLP_BUCKET_ENDPOINT        the store's S3 endpoint, without the bucket: for Cloudflare R2,
 *                              https://<account id>.r2.cloudflarestorage.com
 *   WLP_BUCKET_NAME            the bucket. Nothing else needs to be in it, and nothing else should
 *   WLP_BUCKET_ACCESS_KEY_ID   the id of an access key that may read, write and delete objects in that
 *                              bucket, and needs no other right
 *   WLP_BUCKET_SECRET_ACCESS_KEY
 *                              that key's secret. It signs requests and links and is used for nothing
 *                              else: never logged, never in an error, a link or an answer
 *   WLP_BUCKET_REGION          the region the signatures name (default auto, which is R2's; on AWS the
 *                              bucket's region)
 *   WLP_BUCKET_STYLE=path|virtual
 *                              where the bucket's name goes in an address: in the path (default; R2,
 *                              MinIO, AWS) or in the host name
 *   WLP_BUCKET_PREFIX          put before every object's key, for a bucket that is shared with
 *                              something else or between deployments (default none; letters, digits,
 *                              `.`, `_`, `-` and `/`)
 *   WLP_BACKUP_MAX_BYTES       the largest copy that is kept, in bytes of the compressed archive
 *                              (default 67108864, 64 MiB). A session whose data outgrows it is no
 *                              longer copied, and its timeline says so once
 *   WLP_FAKE_BACKUP_DIR        fake layer only: a directory that stands in for the bucket. With it the
 *                              fake layer's Windlass sessions live in its sandboxes, as on E2B, and
 *                              are copied to that directory and restored from it (sandbox-fake.ts)
 *
 * GitHub (read by `githubConfig` below; docs/github-and-repositories.md, "GitHub"). A GitHub App of this deployment's own lets a
 * user connect GitHub, launch an agent on a repository the app was installed on, private ones included,
 * and get the work back as a pull request. With none of the first five set the feature is off: the web
 * app shows nothing of it and every session behaves as before. With only some of them set it is off
 * too, and the server says which are missing when it starts. They are the same on every server.
 *
 *   WLP_GITHUB_APP_ID          the app's numeric id ("App ID" on the app's settings page): the issuer of
 *                              the tokens the server signs to ask for installation tokens
 *   WLP_GITHUB_APP_SLUG        the app's name as its address has it, https://github.com/apps/<slug>:
 *                              where a user is sent to install it
 *   WLP_GITHUB_CLIENT_ID       the app's client id ("Iv23..."): names the app when a user authorizes it
 *   WLP_GITHUB_CLIENT_SECRET   a client secret of the app. A secret: sent to GitHub with a user's
 *                              authorization code and with nothing else; never logged, never in an
 *                              error or an answer
 *   WLP_GITHUB_PRIVATE_KEY     a private key of the app, the PEM file GitHub lets you download. A
 *                              secret: it signs the app's own tokens and never leaves the server. As
 *                              it is, with its line breaks, or with `\n` in their place, or the whole
 *                              file in base64 (`base64 -w0 key.pem`), which is the form to give a
 *                              secret store that takes one line. Where a secret may not be that long
 *                              (a Rivet Cloud cluster's ends at 1024 bytes), the base64 cut into
 *                              WLP_GITHUB_PRIVATE_KEY_1, _2, ..., which are put together in order
 *   WLP_GITHUB_API_URL         GitHub's API (default https://api.github.com). For GitHub Enterprise
 *                              Server, https://<host>/api/v3; the checks point it at a stand-in
 *   WLP_GITHUB_URL             GitHub itself, where users authorize and git clones from (default
 *                              https://github.com)
 *
 * GitLab (read by `gitlabConfig` below). Requires the instance URL and both OAuth credentials:
 *   WLP_GITLAB_BASE_URL        GitLab instance, including its path prefix for a self-managed deployment
 *   WLP_GITLAB_CLIENT_ID       OAuth application ID
 *   WLP_GITLAB_CLIENT_SECRET   OAuth application secret; not included in public settings
 *   WLP_GITLAB_REDIRECT_URL    registered callback URL (default <WLP_PUBLIC_URL>/gitlab/callback,
 *                              or the server's localhost URL when WLP_PUBLIC_URL is unset)
 *   Project hooks are registered at <WLP_PUBLIC_URL>/gitlab/webhook, keeping any path prefix.
 *
 * Linear (read by `linearConfig` below). A Linear OAuth app of this deployment's own lets the owner connect
 * a Linear workspace, map a team to a repository, and have an issue that gains a Windlass filing label or
 * is assigned to the app's user filed as a work item.
 * With none of the three first variables set the feature is off; with only some set it is off too, and
 * the server says which are missing when it starts. They are the same on every server.
 *
 *   WLP_LINEAR_CLIENT_ID       the OAuth app's client id: names the app when the owner authorizes it
 *   WLP_LINEAR_CLIENT_SECRET   its client secret. A secret: sent to Linear with an authorization code and
 *                              with nothing else; never logged, never in an error or an answer
 *   WLP_LINEAR_WEBHOOK_SECRET  the app's webhook signing secret (at least 32 characters, `lin_wh_...`).
 *                              A secret: the key every delivery's `Linear-Signature` is checked with
 *   WLP_LINEAR_REDIRECT_URL    the app's callback URL as registered at Linear (default
 *                              <WLP_PUBLIC_URL, or http://localhost:<WLP_HTTP_PORT>>/linear/callback)
 *   WLP_LINEAR_API_URL         Linear's API (default https://api.linear.app); the checks point it at a stand-in
 *   WLP_LINEAR_URL             Linear itself, where the owner authorizes (default https://linear.app)
 *
 * Slack (read by `slackConfig` only on the server). All three credentials are required:
 *   WLP_SLACK_CLIENT_ID, WLP_SLACK_CLIENT_SECRET   workspace bot OAuth v2 client
 *   WLP_SLACK_SIGNING_SECRET   key for the exact event/command request bytes
 *   WLP_SLACK_URL              Slack origin (the checks point it at a local stand-in)
 *
 * Machines of the users' own (Plans/2026-11-19 "bring your own computer"). A user pairs a Linux
 * machine with Docker, and the runner on it dials out to the platform and runs the sandboxes of the
 * sessions launched there. The same on every server.
 *
 *   WLP_MACHINES=1             offer it to every user of the deployment (default off). Off, the routes a
 *                              runner calls answer 404, the user actor's machine actions throw
 *                              `machines_off`, and platform info has no `machines`: each of those entry
 *                              points reads `config.machines` once, and nothing else does. The `machine`
 *                              actors and the tables are there either way, so turning it off and on
 *                              again loses nothing
 *   WLP_RUNNER_DURABLE_TURNS=1 keep each machine session's runner conversation and its running turn's
 *                              protocol state in the session's storage, so a server that restarts within
 *                              the runner's grace (ten minutes) takes the same agent process up again
 *                              (runner/journal.ts, docs/machines.md). Default off. A graceful stop keeps
 *                              the turn running only with a runner that reports `resumable-conversation`
 *   WLP_RUNNER_IMAGE           the runner image the Machines page tells users to install, pinned by
 *                              digest: <name>@sha256:<64 hex>. Unset: none is published yet, and the
 *                              page says so
 *   WLP_MODEL_RELAY            "off": Windlass's turns are handed their access token in the sandbox, as
 *                              before the relay (docs/model-relay.md). Unset or "on": hosted Docker
 *                              (with Windlass 0.6.0 or later in its image) and runners that name
 *                              `modelRelay` send model requests through the relay, and E2B does too
 *                              with WLP_MODEL_RELAY_URL set and WLP_E2B_WINDLASS_VERSION 0.6.0 or later
 *   WLP_MODEL_RELAY_URL        the hostname of its own that E2B sandboxes reach the relay route at:
 *                              https://<DNS name>, no port, no path, routed to this server like
 *                              WLP_PUBLIC_URL. On it the server answers the relay's two paths and
 *                              nothing else. Unset: E2B turns get their access token in the sandbox
 *   WLP_MODEL_RELAY_REQUESTS   the hosted relay's ceiling of model requests in flight for the whole
 *                              deployment (default 64, 1 to 4096)
 *   WLP_PUBLIC_URL             the platform's address as a machine outside reaches its HTTP routes:
 *                              https://<host>, or http:// on a loopback address. Required with
 *                              WLP_MACHINES=1 and a remote engine; with the local one it defaults to
 *                              http://localhost:<WLP_HTTP_PORT>
 *
 * The Rivet engine is RivetKit's to configure, from its own variables: without RIVET_ENDPOINT it starts
 * a local engine on :6420 (development), with it the server joins that engine as one of its nodes
 * (RIVET_ENDPOINT, RIVET_NAMESPACE, RIVET_TOKEN, RIVET_POOL, RIVET_NODE_VERSION; docs/operating.md, "Running on
 * several servers"). `engine` below is what this server makes of them; it never holds the token, and
 * neither does anything else in `config`: the admin token is read where it is used (`engineAdminToken`).
 */

import { type ModelRelayUrl, parseModelRelayUrl } from "./model-relay-url.js";
import { type DaytonaSettings, readDaytonaSettings } from "./sandbox/daytona/config.js";
import { type E2bSettings, readE2bSettings } from "./sandbox/e2b/config.js";
import { SNAPSHOT_MIN_SETUP_MS } from "./sandbox/snapshot-key.js";
import { storeSettings, type StoreCaps, type StoreLimits } from "./sandbox/store-limits.js";

import { readPlatformKey, type PlatformIdentity } from "./runner/frame-auth.js";
import { configuredKeys, type Keyring } from "./keyring.js";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type AccessRules, readAccessRules } from "./access.js";
import { MACHINE_HARNESS_IDS, QUESTION_TIMEOUT_MS } from "./contract.js";
import { APPROVAL_TTL_MS } from "./server-approvals.js";
import { DEFAULT_DAILY_SECONDS, DEFAULT_HOLD_SECONDS, DEFAULT_MAX_KEPT, type UsageLimits } from "./usage.js";
import type { FactoryLimits, MachinesInfo } from "./contract.js";
import { ATTACHMENT_LIMITS } from "./factory/attachments.js";
import { FACTORY_DEFAULTS } from "./factory/budget.js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA_DIR = join(REPO_ROOT, ".data");
export const FIXTURES_DIR = join(REPO_ROOT, "fixtures", "windlass-events");

export type SandboxMode = "docker" | "e2b" | "daytona" | "fake";

export interface EngineConfig {
	/**
	 * True when RivetKit is pointed at an engine it does not start itself (RIVET_ENDPOINT, or RivetKit's
	 * older RIVET_ENGINE): other servers may share it, so they must share the secret too.
	 */
	remote: boolean;
	/** The engine's address without the namespace and token the URL may carry; null for the local one. */
	endpoint: string | null;
	namespace: string;
	pool: string;
}

export interface BrowserConnectionConfig {
	/** Optional private origin used only to issue the scoped gateway token. */
	tokenEndpoint?: string;
	/** WLP_PUBLIC_ENDPOINT without a trailing slash; null when browsers are to use the endpoint they were built with. */
	endpoint: string | null;
	/** True when RIVET_ADMIN_TOKEN is set: browsers are handed tokens this server issues with it. */
	tokens: boolean;
	tokenTtlMs: number;
}

/** WLP_MACHINES and what goes with it; `Config.machines` is null when the feature is off. */
export interface MachinesConfig {
	identity?: PlatformIdentity;
	runnerHarnesses?: MachinesInfo["runnerHarnesses"];
	runnerImage: string | null;
	/** WLP_PUBLIC_URL as an origin, without a trailing slash. */
	publicUrl: string;
	/** WLP_RUNNER_DURABLE_TURNS=1: a machine turn can outlive its server (runner/journal.ts). */
	durableTurns?: boolean;
}

export interface Config {
	demo: boolean;
	/** Null when users may not pair machines of their own (WLP_MACHINES). */
	machines: MachinesConfig | null;
	/** Who may use the platform (access.ts). */
	access: AccessRules;
	sandbox: SandboxMode;
	allowDockerHosted: boolean;
	signingKeys: Keyring;
	/** False when a remote engine is configured without a shared signing key: the server refuses to start (startup.ts). */
	secretConfigured: boolean;
	/** The settings that are set to something that cannot be used, each in words that do not repeat its value: the server refuses to start (startup.ts). */
	unusable: string[];
	engine: EngineConfig;
	browsers: BrowserConnectionConfig;
	httpPort: number;
	httpHost: string;
	httpLimits: ReturnType<typeof readHttpLimits>;
	/** The web app's built files, when the server serves them itself. */
	webDir: string | null;
	idleSuspendMs: number;
	idleDestroyMs: number;
	origins: string[];
	storagePath: string;
	loginTtlMs: number;
	questionTimeoutMs: number;
	/** In a hosted sandbox: how long an approval waits before the turn is ended and the sandbox paused (never longer than `questionTimeoutMs`). */
	hostedQuestionTimeoutMs: number;
	/** How long an approval of a project's MCP server is remembered for its user: Windlass's own 30 days, or less. */
	serverApprovalTtlMs: number;
	/** Windlass's model relay (docs/model-relay.md): WLP_MODEL_RELAY, the hosted relay's ceiling, and WLP_MODEL_RELAY_URL (null when unset). */
	modelRelay: { on: boolean; requests: number; turnRequests: number; url: ModelRelayUrl | null };
	/** Who may connect and use subscription plans (WLP_PLAN_USERS): everyone, these user ids, or nobody. */
	plans: "all" | ReadonlySet<string>;
	/** The most hosted turns one plan pays for at once (WLP_PLAN_PARALLEL_TURNS): ordinary use. */
	planParallelTurns: number;
	/** Where items' model prices are read from (WLP_MODEL_PRICES_URL); null: nowhere. */
	modelPricesUrl: string | null;
	/** A Docker setup must finish successfully and reach this duration to be saved. */
	snapshots: boolean;
	/** Selected remote provider settings, without credentials. */
	hosted: E2bSettings | DaytonaSettings | null;
	snapshotMinSetupMs: number;
	/**
	 * The snapshot and Git mirror stores' limits on the platform's own Docker (WLP_SNAPSHOT_MACHINE_MAX_GB,
	 * WLP_SNAPSHOT_USER_MAX_GB, WLP_KEEP_FREE_MIN_GB, or the defaults), and `caps`: the ones of those that are
	 * set, which a machine's runner (0.3.2 or later) is held to: a ceiling on the sizes, a floor on keep-free.
	 */
	storeLimits: StoreLimits & { caps: StoreCaps };
	/** How long a repository's setup command may run before the platform stops it. */
	setupTimeoutMs: number;
	/** How long one turn may run before the platform stops it (WLP_TURN_TIMEOUT_MS). */
	turnTimeoutMs: number;
	/** WLP_TURN_RESUME=1, with its test overrides: a turn pauses and resumes across a restart or a machine away. */
	turnResume: { enabled: boolean; floorMs: number; delayMs: number; heartbeatMs: number; machineAskMs: number };
	/** A user's daily allowance of sandbox time, the cap on the sandboxes they keep, and the size of a hold (usage.ts). */
	usage: UsageLimits;
	/** The software factory's deployment defaults for user limits (WLP_FACTORY_*). */
	factory: ReturnType<typeof readFactory>;
	/** Whether users may file work items (WLP_ITEMS=1). */
	items: boolean;
}

function readSandboxMode(): SandboxMode {
	const raw = (process.env.WLP_SANDBOX ?? "docker").trim().toLowerCase();
	if (raw === "docker" || raw === "e2b" || raw === "daytona" || raw === "fake") return raw;
	throw new Error(`WLP_SANDBOX must be "docker", "e2b", "daytona" or "fake"; got "${raw}"`);
}

/** Read the way RivetKit reads them (its utils/env-vars.ts and registry config, 3.1.1). */
function readEngine(): EngineConfig {
	const raw = (process.env.RIVET_ENGINE || process.env.RIVET_ENDPOINT || "").trim();
	let endpoint: string | null = null;
	let namespace = process.env.RIVET_NAMESPACE || "default";
	if (raw !== "") {
		try {
			const url = new URL(raw);
			if (url.username) namespace = decodeURIComponent(url.username);
			url.username = "";
			url.password = "";
			endpoint = url.toString().replace(/\/+$/, "");
		} catch {
			// RivetKit refuses it when the registry starts, with its own message.
			endpoint = "(not a valid URL)";
		}
	}
	return { remote: raw !== "", endpoint, namespace, pool: process.env.RIVET_POOL || "default" };
}

const engine = readEngine();

/**
 * Where this server's own clients find the engine (signin/directory.ts, github/connect.ts): the one
 * RIVET_ENDPOINT names, and otherwise the local engine RivetKit starts, on its own port or on the one
 * RivetKit's RIVET_RUN_ENGINE_PORT moves it to, as a second development server on one machine needs.
 */
export function ownEngineEndpoint(): string {
	const named = process.env.RIVET_ENGINE || process.env.RIVET_ENDPOINT;
	if (named) return named;
	const port = Number(process.env.RIVET_RUN_ENGINE_PORT);
	return `http://127.0.0.1:${Number.isInteger(port) && port > 0 && port < 65_536 ? port : 6420}`;
}

/** The same gateway origin must be advertised at pairing and signed runner discovery. */
export function signedRunnerEndpoint(publicUrl: string): string {
	return config.browsers.endpoint ?? (config.engine.remote ? publicUrl : ownEngineEndpoint());
}

/**
 * The engine's admin token, or null. It is not part of `config`, so that nothing that prints or passes
 * on the configuration can carry it; whoever needs it asks here and keeps it to itself.
 */
export function engineAdminToken(): string | null {
	const token = (process.env.RIVET_ADMIN_TOKEN ?? "").trim();
	return token === "" ? null : token;
}

/** What `backupConfig` found: the bucket's settings when all of them are there, and the size limit. */
export interface BackupConfig {
	/** The S3 bucket's settings (bucket/s3.ts takes them as they are); null when the feature is off. `secretAccessKey` is a secret. */
	bucket: {
		endpoint: string;
		region: string;
		bucket: string;
		accessKeyId: string;
		secretAccessKey: string;
		style: "path" | "virtual";
	} | null;
	/** WLP_BUCKET_PREFIX, ending in a slash when it is not empty. */
	prefix: string;
	/** WLP_BACKUP_MAX_BYTES. */
	maxBytes: number;
	/** The required variables that are not set while others are: the names, never a value. Empty when all or none are set. */
	missing: string[];
}

/**
 * The bucket the copies of Windlass's session data go to, read when it is asked for. Like the admin
 * token it is not part of `config`: nothing that prints or passes on the configuration can carry the
 * bucket's secret. Throws for a prefix that could not be part of an object's key.
 */
export function backupConfig(env: NodeJS.ProcessEnv = process.env): BackupConfig {
	const read = (name: string) => (env[name] ?? "").trim();
	const required = [
		"WLP_BUCKET_ENDPOINT",
		"WLP_BUCKET_NAME",
		"WLP_BUCKET_ACCESS_KEY_ID",
		"WLP_BUCKET_SECRET_ACCESS_KEY",
	];
	const missing = required.filter(name => read(name) === "");
	const raw = Number(read("WLP_BACKUP_MAX_BYTES"));
	const maxBytes = Number.isSafeInteger(raw) && raw > 0 ? raw : 64 * 1024 * 1024;
	const prefix = read("WLP_BUCKET_PREFIX").replace(/^\/+|\/+$/g, "");
	if (prefix !== "" && !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(prefix))
		throw new Error('WLP_BUCKET_PREFIX may hold letters, digits, ".", "_", "-" and "/" only');
	const style = read("WLP_BUCKET_STYLE").toLowerCase();
	if (style !== "" && style !== "path" && style !== "virtual")
		throw new Error('WLP_BUCKET_STYLE must be "path" or "virtual"');
	const bucket =
		missing.length > 0
			? null
			: {
					endpoint: read("WLP_BUCKET_ENDPOINT"),
					region: read("WLP_BUCKET_REGION") || "auto",
					bucket: read("WLP_BUCKET_NAME"),
					accessKeyId: read("WLP_BUCKET_ACCESS_KEY_ID"),
					secretAccessKey: read("WLP_BUCKET_SECRET_ACCESS_KEY"),
					style: style === "virtual" ? ("virtual" as const) : ("path" as const),
				};
	return {
		bucket,
		prefix: prefix === "" ? "" : `${prefix}/`,
		maxBytes,
		missing: missing.length === required.length ? [] : missing,
	};
}

/** What `githubConfig` found: the GitHub App's public settings when all of it is configured. */
export interface GithubConfig {
	pollFallback: boolean;
	webhook: { secrets: string[] } | null;
	/** Null when the feature is off. Holds no secret: the client secret and the private key are read where they are used. */
	app: { appId: string; slug: string; clientId: string; apiUrl: string; webUrl: string } | null;
	/** The required variables that are not set while others are: the names, never a value. Empty when all or none are set. */
	missing: string[];
}

const GITHUB_REQUIRED = [
	"WLP_GITHUB_APP_ID",
	"WLP_GITHUB_APP_SLUG",
	"WLP_GITHUB_CLIENT_ID",
	"WLP_GITHUB_CLIENT_SECRET",
	"WLP_GITHUB_PRIVATE_KEY",
];

/**
 * The GitHub App of this deployment, read when it is asked for. Throws for a value that cannot be what
 * it should be (an id that is not a number, an address that is not one); the message names the
 * variable and never repeats a secret.
 */
export function githubConfig(env: NodeJS.ProcessEnv = process.env): GithubConfig {
	const read = (name: string) =>
		name === "WLP_GITHUB_PRIVATE_KEY" ? rawGithubPrivateKey(env) : (env[name] ?? "").trim();
	const missing = GITHUB_REQUIRED.filter(name => read(name) === "");
	const webhookSecret = (name: string) => {
		const secret = env[name] ?? "";
		if (env[name] !== undefined && [...secret].length < 32)
			throw new Error(`${name} must be at least 32 characters long`);
		return secret;
	};
	const current = webhookSecret("WLP_GITHUB_WEBHOOK_SECRET");
	const previous = webhookSecret("WLP_GITHUB_WEBHOOK_SECRET_PREVIOUS");
	const fallback = env.WLP_GITHUB_POLL_FALLBACK;
	if (fallback !== undefined && fallback !== "1") throw new Error("WLP_GITHUB_POLL_FALLBACK must be 1 or unset");
	if (fallback && !current) throw new Error("WLP_GITHUB_POLL_FALLBACK requires WLP_GITHUB_WEBHOOK_SECRET");
	if (missing.length > 0)
		return {
			app: null,
			webhook: null,
			pollFallback: false,
			missing: missing.length === GITHUB_REQUIRED.length ? [] : missing,
		};
	const appId = read("WLP_GITHUB_APP_ID");
	if (!/^[0-9]{1,20}$/.test(appId)) throw new Error("WLP_GITHUB_APP_ID must be the app's numeric id");
	const slug = read("WLP_GITHUB_APP_SLUG");
	if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(slug))
		throw new Error("WLP_GITHUB_APP_SLUG must be the app's name as its address has it: letters, digits and hyphens");
	const clientId = read("WLP_GITHUB_CLIENT_ID");
	if (!/^[A-Za-z0-9._-]{1,100}$/.test(clientId)) throw new Error("WLP_GITHUB_CLIENT_ID is not a client id");
	const address = (name: string, fallback: string) => {
		const raw = read(name) || fallback;
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			throw new Error(`${name} must be a URL`);
		}
		if (
			(url.protocol !== "https:" && url.protocol !== "http:") ||
			url.username !== "" ||
			url.password !== "" ||
			url.search !== "" ||
			url.hash !== ""
		) {
			throw new Error(`${name} must be an http or https URL with no user name, query or fragment in it`);
		}
		return url.toString().replace(/\/+$/, "");
	};
	const webhook = current ? { secrets: previous ? [current, previous] : [current] } : null;
	// Keep configuration dumps and JSON responses free of credentials.
	if (webhook) Object.defineProperty(webhook, "secrets", { enumerable: false });
	return {
		app: {
			appId,
			slug,
			clientId,
			apiUrl: address("WLP_GITHUB_API_URL", "https://api.github.com"),
			webUrl: address("WLP_GITHUB_URL", "https://github.com"),
		},
		webhook,
		pollFallback: fallback === "1",
		missing: [],
	};
}

/** The GitHub App's client secret, or null. Like the admin token it is not part of any configuration object. */
export function githubClientSecret(env: NodeJS.ProcessEnv = process.env): string | null {
	const secret = (env.WLP_GITHUB_CLIENT_SECRET ?? "").trim();
	return secret === "" ? null : secret;
}

/**
 * The private key as it was given: WLP_GITHUB_PRIVATE_KEY, or, where a secret store holds less than a
 * key is long (a Rivet Cloud cluster's secrets end at 1024 bytes, and the file in base64 is over two
 * thousand), its pieces in WLP_GITHUB_PRIVATE_KEY_1, _2, ... put together in that order. "" when unset.
 */
function rawGithubPrivateKey(env: NodeJS.ProcessEnv): string {
	const whole = (env.WLP_GITHUB_PRIVATE_KEY ?? "").trim();
	if (whole !== "") return whole;
	let joined = "";
	for (let part = 1; ; part += 1) {
		const piece = (env[`WLP_GITHUB_PRIVATE_KEY_${part}`] ?? "").trim();
		if (piece === "") return joined;
		joined += piece;
	}
}

/**
 * The GitHub App's private key as PEM text, or null: WLP_GITHUB_PRIVATE_KEY as it is, with `\n` for its
 * line breaks, or in base64. Whether it is a key at all is found out by whoever signs with it
 * (github/app.ts), which says so without repeating it.
 */
export function githubPrivateKey(env: NodeJS.ProcessEnv = process.env): string | null {
	const raw = rawGithubPrivateKey(env);
	if (raw === "") return null;
	if (raw.includes("-----BEGIN")) return `${raw.replace(/\\n/g, "\n").trim()}\n`;
	const decoded = Buffer.from(raw, "base64").toString("utf8");
	return decoded.includes("-----BEGIN") ? `${decoded.trim()}\n` : raw;
}

export interface GitlabConfig {
	app: { clientId: string; baseUrl: string; redirectUrl: string; webhookUrl: string } | null;
	missing: string[];
}

/** One OAuth application and instance per deployment. Plain HTTP is only for loopback stand-ins. */
export function gitlabConfig(env: NodeJS.ProcessEnv = process.env): GitlabConfig {
	const required = ["WLP_GITLAB_BASE_URL", "WLP_GITLAB_CLIENT_ID", "WLP_GITLAB_CLIENT_SECRET"];
	const missing = required.filter(key => !env[key]?.trim());
	if (missing.length) return { app: null, missing: missing.length === required.length ? [] : missing };
	const clientId = env.WLP_GITLAB_CLIENT_ID!.trim();
	if (!/^[A-Za-z0-9._-]{1,128}$/.test(clientId)) throw new Error("WLP_GITLAB_CLIENT_ID is not a client id");
	const address = (key: string, fallback: string, raw = env[key]?.trim() || fallback) => {
		const url = URL.parse(raw);
		if (
			!url ||
			url.username ||
			url.password ||
			/[?#]/.test(url.href) ||
			(url.protocol !== "https:" &&
				!(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
		) {
			throw new Error(`${key} must be an HTTPS or loopback URL with no credentials, query or fragment`);
		}
		return url.href;
	};
	const publicUrl = (env.WLP_PUBLIC_URL?.trim() || `http://localhost:${config.httpPort}`).replace(/\/+$/, "");
	return {
		app: {
			clientId,
			baseUrl: address("WLP_GITLAB_BASE_URL", "").replace(/\/+$/, ""),
			redirectUrl: address("WLP_GITLAB_REDIRECT_URL", `${publicUrl}/gitlab/callback`),
			webhookUrl: address("WLP_PUBLIC_URL", "", `${publicUrl}/gitlab/webhook`),
		},
		missing: [],
	};
}

export function gitlabClientSecret(env: NodeJS.ProcessEnv = process.env): string | null {
	return env.WLP_GITLAB_CLIENT_SECRET?.trim() || null;
}

/** What `linearConfig` found: the Linear app's public settings when all of it is configured. */
export interface LinearConfig {
	/** Null when the feature is off. Holds no secret: the client secret is read where it is used. */
	app: { clientId: string; apiUrl: string; webUrl: string; redirectUrl: string } | null;
	/** The signing secret, never enumerable, so a dump or a JSON answer of this object holds none. Null when the feature is off. */
	webhook: { secrets: string[] } | null;
	/** The required variables that are not set while others are: the names, never a value. Empty when all or none are set. */
	missing: string[];
}

const LINEAR_REQUIRED = ["WLP_LINEAR_CLIENT_ID", "WLP_LINEAR_CLIENT_SECRET", "WLP_LINEAR_WEBHOOK_SECRET"];

/**
 * The Linear app of this deployment, read when it is asked for. Missing configuration leaves the
 * integration off (`app` null). Throws for a value that cannot be what it should be; the message names
 * the variable and never repeats a secret.
 */
export function linearConfig(env: NodeJS.ProcessEnv = process.env): LinearConfig {
	const read = (name: string) => (env[name] ?? "").trim();
	const missing = LINEAR_REQUIRED.filter(name => read(name) === "");
	if (missing.length > 0)
		return { app: null, webhook: null, missing: missing.length === LINEAR_REQUIRED.length ? [] : missing };
	const clientId = read("WLP_LINEAR_CLIENT_ID");
	if (!/^[A-Za-z0-9._-]{1,100}$/.test(clientId)) throw new Error("WLP_LINEAR_CLIENT_ID is not a client id");
	const secret = read("WLP_LINEAR_WEBHOOK_SECRET");
	if ([...secret].length < 32) throw new Error("WLP_LINEAR_WEBHOOK_SECRET must be at least 32 characters long");
	const address = (name: string, fallback: string, path = false) => {
		const raw = read(name) || fallback;
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			throw new Error(`${name} must be a URL`);
		}
		if (
			(url.protocol !== "https:" && url.protocol !== "http:") ||
			url.username !== "" ||
			url.password !== "" ||
			url.search !== "" ||
			url.hash !== ""
		) {
			throw new Error(`${name} must be an http or https URL with no user name, query or fragment in it`);
		}
		return path ? url.toString() : url.toString().replace(/\/+$/, "");
	};
	const publicRaw = read("WLP_PUBLIC_URL");
	const origin = publicRaw === "" ? `http://localhost:${config.httpPort}` : address("WLP_PUBLIC_URL", publicRaw);
	const webhook = { secrets: [secret] };
	Object.defineProperty(webhook, "secrets", { enumerable: false });
	return {
		app: {
			clientId,
			apiUrl: address("WLP_LINEAR_API_URL", "https://api.linear.app"),
			webUrl: address("WLP_LINEAR_URL", "https://linear.app"),
			redirectUrl: address("WLP_LINEAR_REDIRECT_URL", `${origin}/linear/callback`, true),
		},
		webhook,
		missing: [],
	};
}

/** The Linear app's client secret, or null. Like the GitHub one it is not part of any configuration object. */
export function linearClientSecret(env: NodeJS.ProcessEnv = process.env): string | null {
	const secret = (env.WLP_LINEAR_CLIENT_SECRET ?? "").trim();
	return secret === "" ? null : secret;
}

/** Keep the client secret out of enumerable configuration. */
export const jiraClientSecret = () => process.env.WLP_JIRA_CLIENT_SECRET?.trim();
export function jiraConfig(env: NodeJS.ProcessEnv = process.env) {
	const required = ["WLP_JIRA_CLIENT_ID", "WLP_JIRA_CLIENT_SECRET"];
	const missing = required.filter(name => !env[name]?.trim());
	if (missing.length) return { app: null, missing: missing.length === required.length ? [] : missing };
	const clientId = env.WLP_JIRA_CLIENT_ID!.trim();
	if (!/^[A-Za-z0-9._-]{1,100}$/.test(clientId)) throw new Error("WLP_JIRA_CLIENT_ID is not a client id");
	const address = (name: string, fallback: string) => {
		const url = URL.parse(env[name]?.trim() || fallback);
		const local = url && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
		if (
			!url ||
			!(url.protocol === "https:" || (local && url.protocol === "http:")) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			throw new Error(`${name} must be an HTTPS URL (or HTTP on loopback) without credentials, query or fragment`);
		}
		return url.href;
	};
	return {
		app: {
			clientId,
			authUrl: address("WLP_JIRA_AUTH_URL", "https://auth.atlassian.com").replace(/\/+$/, ""),
			apiUrl: address("WLP_JIRA_API_URL", "https://api.atlassian.com").replace(/\/+$/, ""),
			redirectUrl: address(
				"WLP_JIRA_REDIRECT_URL",
				`${env.WLP_PUBLIC_URL?.trim().replace(/\/+$/, "") || `http://localhost:${config.httpPort}`}/jira/callback`,
			),
		},
		missing: [],
	};
}

export function slackConfig() {
	const {
		WLP_SLACK_CLIENT_ID: clientId,
		WLP_SLACK_CLIENT_SECRET: clientSecret,
		WLP_SLACK_SIGNING_SECRET: signingSecret,
	} = process.env;
	if (!clientId || !clientSecret || !signingSecret) return null;
	const url = URL.parse(process.env.WLP_SLACK_URL || "https://slack.com");
	if (
		!url ||
		url.username ||
		url.password ||
		!(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname)))
	)
		throw new Error("WLP_SLACK_URL needs HTTPS or loopback HTTP.");
	const publicUrl = process.env.WLP_PUBLIC_URL || `http://localhost:${config.httpPort}`;
	return { clientId, url: url.origin, redirectUrl: `${publicUrl.replace(/\/+$/, "")}/slack/callback` };
}

/** A day: the longest a Rivet Cloud cluster issues a token for. */
const MAX_CONNECTION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function connectionEndpoint(name: "WLP_PUBLIC_ENDPOINT" | "WLP_TOKEN_ENDPOINT"): string | null {
	const raw = (process.env[name] ?? "").trim();
	if (!raw) return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`${name} must be a URL`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${name} must be an http or https URL`);
	// Never include a configured URL in a validation error: it may contain credentials.
	if (url.username || url.password) throw new Error(`${name} must not carry a namespace or a token`);
	if (name === "WLP_TOKEN_ENDPOINT" && (url.search || url.hash))
		throw new Error(`${name} must not carry a query string or fragment`);
	return url.toString().replace(/\/+$/, "");
}

function readBrowsers(): BrowserConnectionConfig {
	const endpoint = connectionEndpoint("WLP_PUBLIC_ENDPOINT");
	const tokenEndpoint = connectionEndpoint("WLP_TOKEN_ENDPOINT") ?? undefined;
	const tokenTtlMs = Math.min(
		readDuration("WLP_CONNECTION_TOKEN_TTL_MS", 60 * 60 * 1000, 60_000),
		MAX_CONNECTION_TOKEN_TTL_MS,
	);
	return { endpoint, tokenEndpoint, tokens: engineAdminToken() !== null, tokenTtlMs };
}

function readSecret(): Buffer {
	const fromEnv = process.env.WLP_SECRET;
	if (fromEnv !== undefined && fromEnv !== "") {
		if (fromEnv.length < 16) throw new Error("WLP_SECRET must be at least 16 characters long");
		return Buffer.from(fromEnv, "utf8");
	}
	// A secret made up here would differ from the other servers' and would not be kept: the server
	// refuses to start (startup.ts). Until then nothing may be signed with a value anyone could share.
	if (engine.remote) return randomBytes(32);
	const file = join(DATA_DIR, "secret");
	if (existsSync(file)) {
		const stored = readFileSync(file, "utf8").trim();
		if (stored.length >= 32) return Buffer.from(stored, "utf8");
	}
	mkdirSync(DATA_DIR, { recursive: true });
	const generated = randomBytes(32).toString("hex");
	writeFileSync(file, `${generated}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
	return Buffer.from(generated, "utf8");
}

// Preserve the legacy blob id for a singleton seal key. With no dedicated key, the
// complete signing ring is available to decrypt blobs during a signing-key rotation.
export function signInKeys(): Keyring | Buffer {
	const ring = configuredKeys("WLP_SIGNIN_KEYS", 32);
	if (ring) return ring;
	const own = process.env.WLP_SIGNIN_KEY;
	if (own === undefined)
		return process.env.WLP_SECRET_KEYS === undefined ? config.signingKeys[0].secret : config.signingKeys;
	if (own.length < 32) throw new Error("WLP_SIGNIN_KEY must be at least 32 characters long");
	return Buffer.from(own, "utf8");
}

function readOrigins(): string[] {
	const raw = process.env.WLP_WEB_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173";
	return raw
		.split(",")
		.map(origin => origin.trim().replace(/\/+$/, ""))
		.filter(origin => origin !== "");
}

function readStoragePath(): string {
	// The engine is started by RivetKit's native module, which reads this variable itself.
	if (!process.env.RIVETKIT_STORAGE_PATH) {
		mkdirSync(DATA_DIR, { recursive: true });
		process.env.RIVETKIT_STORAGE_PATH = DATA_DIR;
	}
	return process.env.RIVETKIT_STORAGE_PATH;
}

function readHttpPort(): number {
	for (const raw of [process.env.WLP_HTTP_PORT, process.env.PORT]) {
		if (raw === undefined || raw.trim() === "") continue;
		const port = Number(raw);
		if (!Number.isInteger(port) || port < 1 || port > 65_535)
			throw new Error(`The HTTP port must be a number from 1 to 65535; got "${raw}"`);
		return port;
	}
	return 6440;
}

const unusable: string[] = [];

/** A number of milliseconds of at least `min`; `fallback` when the variable is not set. One set to anything else is unusable. */
function readDuration(name: string, fallback: number, min: number): number {
	const text = process.env[name];
	if (text === undefined || text.trim() === "") return fallback;
	const raw = Number(text);
	if (Number.isFinite(raw) && raw >= min) return Math.floor(raw);
	unusable.push(`${name} must be a number of milliseconds of at least ${min}, or not set for its default`);
	return fallback;
}

function readModelRelay(): Config["modelRelay"] {
	const mode = (process.env.WLP_MODEL_RELAY ?? "").trim().toLowerCase();
	if (mode !== "" && mode !== "on" && mode !== "off")
		unusable.push('WLP_MODEL_RELAY must be "on" or "off", or not set for on');
	const text = (process.env.WLP_MODEL_RELAY_REQUESTS ?? "").trim();
	const requests = text === "" ? 64 : Number(text);
	if (!Number.isInteger(requests) || requests < 1 || requests > 4096)
		unusable.push("WLP_MODEL_RELAY_REQUESTS must be a whole number from 1 to 4096, or not set for 64");
	const turnRequests = Number(process.env.WLP_MODEL_RELAY_TURN_REQUESTS?.trim() || 300);
	if (!Number.isSafeInteger(turnRequests) || turnRequests < 1)
		unusable.push("WLP_MODEL_RELAY_TURN_REQUESTS must be a positive whole number");
	const url = parseModelRelayUrl(process.env.WLP_MODEL_RELAY_URL);
	if (url !== null && "problem" in url) unusable.push(url.problem);
	return {
		on: mode !== "off",
		turnRequests,
		requests: Number.isInteger(requests) && requests >= 1 && requests <= 4096 ? requests : 64,
		url: url !== null && "problem" in url ? null : url,
	};
}

function readStoreLimits(): Config["storeLimits"] {
	const { own, caps, problems } = storeSettings(process.env);
	unusable.push(...problems);
	return { ...own, caps };
}

const idleSuspendMs = readDuration("WLP_IDLE_SUSPEND_MS", 10 * 60 * 1000, 1_000);
// Removing comes after suspending, never before it.
const idleDestroyMs = Math.max(idleSuspendMs, readDuration("WLP_IDLE_DESTROY_MS", 7 * 24 * 60 * 60 * 1000, 1_000));

function readLoginTtl(): number {
	return readDuration("WLP_LOGIN_TTL_MS", 10 * 60 * 1000, 1_000);
}

function readQuestionTimeout(): number {
	return readDuration("WLP_QUESTION_TIMEOUT_MS", QUESTION_TIMEOUT_MS, 100);
}

/** A whole number from `min` to `max`, or `unlimited` (null) where the setting can mean no limit; `fallback` when it is not set. Anything else is unusable. */
function readCount(name: string, fallback: number | null, min: number, max: number, unlimited: boolean): number | null {
	const text = (process.env[name] ?? "").trim();
	if (text === "") return fallback;
	if (unlimited && text.toLowerCase() === "unlimited") return null;
	const raw = Number(text);
	if (Number.isInteger(raw) && raw >= min && raw <= max) return raw;
	unusable.push(
		`${name} must be a whole number from ${min} to ${max}${unlimited ? ', or "unlimited"' : ""}, or not set for its default`,
	);
	return fallback;
}

function readHttpLimits() {
	const perMinute = (name: string, fallback: number) => readCount(name, fallback, 1, 1_000_000, false) ?? fallback;
	const ipHeader = (process.env.WLP_CLIENT_IP_HEADER ?? "").trim().toLowerCase();
	if (ipHeader && !/^[a-z0-9-]+$/.test(ipHeader)) unusable.push("WLP_CLIENT_IP_HEADER must name a single HTTP header");
	return {
		ipHeader,
		apiAddress: perMinute("WLP_API_ADDRESS_PER_MINUTE", 240),
		apiToken: perMinute("WLP_API_TOKEN_PER_MINUTE", 60),
		apiFailures: perMinute("WLP_API_FAILURES_PER_MINUTE", 12),
		webhookRefusals: perMinute("WLP_WEBHOOK_REFUSALS_PER_MINUTE", 30),
		loginAddress: perMinute("WLP_LOGIN_ADDRESS_PER_MINUTE", 120),
		loginTotal: perMinute("WLP_LOGIN_TOTAL_PER_MINUTE", 600),
		runnerPoll: perMinute("WLP_RUNNER_POLLS_PER_MINUTE", 240),
		runnerConnection: perMinute("WLP_RUNNER_CONNECTIONS_PER_MINUTE", 120),
		connect: perMinute("WLP_CONNECT_PER_MINUTE", 30),
		connectPoll: perMinute("WLP_CONNECT_POLLS_PER_MINUTE", 240),
	};
}

/** `WLP_FACTORY_SCREENSHOTS=off`: no work item of this deployment gets the screenshots image or files a screenshot, whatever its repository says. */
function readScreenshots(): boolean {
	const raw = process.env.WLP_FACTORY_SCREENSHOTS;
	if (raw === undefined || raw === "" || raw === "on") return true;
	if (raw === "off") return false;
	throw new Error(`WLP_FACTORY_SCREENSHOTS must be "on" or "off"; got "${raw}"`);
}

function readFactory(): FactoryLimits & { reviewer: boolean; screenshots: boolean } {
	const d = FACTORY_DEFAULTS;
	const count = (name: string, fallback: number, max: number) => readCount(name, fallback, 1, max, false) ?? fallback;
	return {
		dailyTokens: readCount("WLP_DAILY_TOKENS", d.dailyTokens, 1, Number.MAX_SAFE_INTEGER, true),
		githubItemsPerDay: count("WLP_FACTORY_GITHUB_ITEMS_PER_DAY", d.githubItemsPerDay, 1_000_000),
		reviewer: process.env.WLP_FACTORY_REVIEWER === "on",
		screenshots: readScreenshots(),
		attachments: {
			bytes: count("WLP_FACTORY_ATTACHMENT_BYTES", ATTACHMENT_LIMITS.bytes, ATTACHMENT_LIMITS.bytes),
			perItem: count("WLP_FACTORY_ATTACHMENTS_PER_ITEM", ATTACHMENT_LIMITS.perItem, 1_000_000),
			accountBytes: count("WLP_FACTORY_ATTACHMENT_ACCOUNT_BYTES", d.attachments.accountBytes, Number.MAX_SAFE_INTEGER),
			days: count("WLP_FACTORY_ATTACHMENT_DAYS", d.attachments.days, 36500),
		},
		hostedRunning: count("WLP_FACTORY_HOSTED_RUNNING", d.hostedRunning, 100),
		item: {
			tokens: count("WLP_FACTORY_ITEM_TOKENS", d.item.tokens, 1_000_000_000),
			hostedSeconds: count("WLP_FACTORY_ITEM_HOSTED_SECONDS", d.item.hostedSeconds, 7 * 86_400),
			usd: count("WLP_FACTORY_ITEM_USD", d.item.usd ?? 5, 100_000),
			planPct: count("WLP_FACTORY_ITEM_PLAN_PCT", d.item.planPct ?? 20, 1000),
			planWeekPct: count("WLP_FACTORY_ITEM_PLAN_WEEK_PCT", d.item.planWeekPct ?? 3, 1000),
		},
	};
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Release metadata for the install dialog. An old image's report never enables options on a new digest.
 * WLP_RUNNER_CAPABILITIES is the stdout of
 * docker run --rm --network none -e WLP_RUNNER_IMAGE "$WLP_RUNNER_IMAGE" capabilities
 * with WLP_RUNNER_IMAGE exported to the pinned release reference.
 */
export function publishedHarnesses(image: string, raw?: string): MachinesInfo["runnerHarnesses"] {
	if (!raw || raw.length > 2048) return undefined;
	try {
		const report = JSON.parse(raw);
		if (report?.image !== image || !Array.isArray(report.harnesses)) return undefined;
		return MACHINE_HARNESS_IDS.filter(id => report.harnesses.includes(id));
	} catch {
		return undefined;
	}
}

function platformIdentity() {
	const mode = process.env.WLP_REQUIRE_SIGNED_RUNNER ?? "0";
	if (mode === "0") return;
	if (mode !== "1") {
		unusable.push("WLP_REQUIRE_SIGNED_RUNNER must be 0 or 1");
		return;
	}
	try {
		return readPlatformKey(process.env.WLP_PLATFORM_KEY);
	} catch {
		unusable.push("WLP_PLATFORM_KEY needs a valid, unexpired certified online key");
	}
}

function readMachines(httpPort: number): MachinesConfig | null {
	if (process.env.WLP_MACHINES !== "1") return null;
	const image = (process.env.WLP_RUNNER_IMAGE ?? "").trim();
	// A runner release pins the sandbox image it runs; the runner image is pinned the same way, so what the page names is one exact build.
	const pinned = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/.test(image);
	if (image !== "" && !pinned)
		unusable.push("WLP_RUNNER_IMAGE must be an image pinned by digest, <name>@sha256:<64 hex>");
	const raw = (process.env.WLP_PUBLIC_URL ?? "").trim();
	let publicUrl = `http://localhost:${httpPort}`;
	if (raw === "") {
		if (engine.remote)
			unusable.push(
				"WLP_PUBLIC_URL must be set with WLP_MACHINES=1 and a remote engine: it is the address runners are given",
			);
	} else {
		let url: URL | null = null;
		try {
			url = new URL(raw);
		} catch {
			// Said below.
		}
		const fit =
			url !== null &&
			(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname))) &&
			url.username === "" &&
			url.password === "" &&
			url.pathname === "/" &&
			url.search === "" &&
			url.hash === "";
		if (fit) publicUrl = url!.origin;
		else
			unusable.push(
				"WLP_PUBLIC_URL must be an https:// origin (or http:// on a loopback address), with no path, query or credentials",
			);
	}
	return {
		identity: platformIdentity(),
		runnerImage: pinned ? image : null,
		runnerHarnesses: pinned ? publishedHarnesses(image, process.env.WLP_RUNNER_CAPABILITIES) : undefined,
		publicUrl,
		durableTurns: process.env.WLP_RUNNER_DURABLE_TURNS === "1",
	};
}

const httpPort = readHttpPort();

const sandbox = readSandboxMode();
function readPlanUsers(raw: string | undefined): Config["plans"] {
	if (raw?.trim() === "*") return "all";
	return new Set(
		(raw ?? "")
			.split(",")
			.map(uid => uid.trim())
			.filter(uid => uid !== ""),
	);
}

function readModelPricesUrl(raw: string | undefined): string | null {
	const value = raw?.trim() || "https://models.dev/api.json";
	if (value === "off") return null;
	const url = URL.parse(value);
	if (!url || (url.protocol !== "https:" && url.protocol !== "http:"))
		throw new Error(`WLP_MODEL_PRICES_URL must be an http(s) address or "off"; got "${value}"`);
	return url.href;
}

export const config: Config = {
	demo: process.env.WLP_DEMO === "1",
	machines: readMachines(httpPort),
	access: readAccessRules(),
	sandbox,
	allowDockerHosted: process.env.WLP_ALLOW_DOCKER_HOSTED === "1",
	signingKeys: configuredKeys("WLP_SECRET_KEYS", 16) ?? [{ id: "default", secret: readSecret() }],
	secretConfigured: !engine.remote || Boolean(process.env.WLP_SECRET_KEYS || process.env.WLP_SECRET),
	unusable,
	engine,
	browsers: readBrowsers(),
	httpPort,
	httpLimits: readHttpLimits(),
	httpHost: process.env.WLP_HTTP_HOST || (engine.remote ? "0.0.0.0" : "127.0.0.1"),
	webDir: (process.env.WLP_WEB_DIR ?? "").trim() || null,
	idleSuspendMs,
	idleDestroyMs,
	origins: readOrigins(),
	storagePath: readStoragePath(),
	loginTtlMs: readLoginTtl(),
	questionTimeoutMs: readQuestionTimeout(),
	hostedQuestionTimeoutMs: Math.min(
		readQuestionTimeout(),
		readDuration("WLP_HOSTED_QUESTION_TIMEOUT_MS", 5 * 60 * 1000, 100),
	),
	// Never longer than Windlass keeps its own record: a shorter time is for the checks.
	serverApprovalTtlMs: Math.min(APPROVAL_TTL_MS, readDuration("WLP_SERVER_APPROVAL_TTL_MS", APPROVAL_TTL_MS, 1_000)),
	modelRelay: readModelRelay(),
	plans: readPlanUsers(process.env.WLP_PLAN_USERS),
	planParallelTurns: readCount("WLP_PLAN_PARALLEL_TURNS", 3, 1, 20, false) ?? 3,
	modelPricesUrl: readModelPricesUrl(process.env.WLP_MODEL_PRICES_URL),
	snapshots: process.env.WLP_SNAPSHOTS === "on",
	hosted: sandbox === "e2b" ? readE2bSettings() : sandbox === "daytona" ? readDaytonaSettings() : null,
	snapshotMinSetupMs: readDuration("WLP_SNAPSHOT_MIN_SETUP_MS", SNAPSHOT_MIN_SETUP_MS, SNAPSHOT_MIN_SETUP_MS),
	storeLimits: readStoreLimits(),
	setupTimeoutMs: readDuration("WLP_SETUP_TIMEOUT_MS", 10 * 60 * 1000, 1_000),
	turnTimeoutMs: readDuration("WLP_TURN_TIMEOUT_MS", 45 * 60 * 1000, 1_000),
	turnResume: {
		enabled: process.env.WLP_TURN_RESUME === "1",
		floorMs: readDuration("WLP_TURN_RESUME_FLOOR_MS", 5 * 60 * 1000, 1_000),
		delayMs: readDuration("WLP_TURN_RESUME_DELAY_MS", 3_000, 0),
		heartbeatMs: readDuration("WLP_TURN_HEARTBEAT_MS", 60 * 1000, 2_000),
		machineAskMs: readDuration("WLP_MACHINE_AWAY_ASK_MS", 6 * 60 * 60 * 1000, 1_000),
	},
	usage: {
		dailySeconds: readCount("WLP_DAILY_SANDBOX_SECONDS", DEFAULT_DAILY_SECONDS, 60, 86_400, true),
		maxKept: readCount("WLP_MAX_KEPT_SANDBOXES", DEFAULT_MAX_KEPT, 1, 1_000, true),
		holdSeconds: readCount("WLP_USAGE_HOLD_SECONDS", DEFAULT_HOLD_SECONDS, 5, 3_600, false) ?? DEFAULT_HOLD_SECONDS,
	},
	factory: readFactory(),
	items: process.env.WLP_ITEMS === "1",
};

/** Whether a Plan-first feature may be filed over two repositories (WLP_FACTORY_CROSS_REPO=1). Read when it is asked, as WLP_FACTORY_ORCHESTRATE is. */
export const crossRepoFactory = (): boolean => process.env.WLP_FACTORY_CROSS_REPO === "1";

/**
 * Whether post-setup snapshots are on for a session's place: a hosted session on E2B follows
 * WLP_E2B_SNAPSHOTS, every other place (hosted Docker, a machine's runner) WLP_SNAPSHOTS.
 */
export function snapshotsFor(
	place: { kind: "hosted" | "machine" },
	settings: Pick<Config, "hosted" | "snapshots"> = config,
): boolean {
	return place.kind === "hosted" && settings.hosted ? !!settings.hosted.snapshots : settings.snapshots;
}
