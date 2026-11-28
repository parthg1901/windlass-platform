# Operating

How to run Windlass Platform beyond a laptop: several servers on one engine, the public HTTP rate limits,
hosted sandboxes, the GitHub App, and the bucket that keeps a copy of each agent's memory. Every variable is
listed in [configuration.md](configuration.md). Users' own machines are in [machines.md](machines.md).

For a single Linux host, use the Docker Compose kit in [`deploy/selfhost/`](../deploy/selfhost/README.md): it
brings up the engine, the server with the web app, backups and a synthetic load test, behind a Cloudflare
Tunnel or another HTTPS front.


## Running on several servers

Every server is one Rivet node. With `RIVET_ENDPOINT` set it starts no engine of its own: it opens an outbound
connection to the one engine all servers share, and that engine places each actor on one of them, wakes it on
another when its server stops, keeps every actor's SQLite data and runs every actor's schedule. Nothing of a
user or a session is kept on a server. Browsers reach the actors through the engine's gateway, never through a
server, and so do the machines' runners once they are paired. A server's own port serves `GET /platform/info`,
`GET /platform/connection`, `/health`, GitHub's callback (`GET /github/callback`), the three routes a
machine's runner calls (`POST /runner/pair`, `POST /runner/pair/poll`, `POST /runner/connection`) where
machines are on, the configured GitHub and Linear webhooks (`POST /github/webhook`, `POST /linear/webhook`), Linear's OAuth callback (`GET /linear/callback`), and the item API including attachment redirects, and any
server answers each.

What every server needs, the same on all of them:

| Variable | Value |
|---|---|
| `RIVET_ENDPOINT` | `https://<namespace>:<token>@<engine host>`: the engine as the server reaches it, the namespace the actors live in, and the token a node joins with. `RIVET_NAMESPACE` and `RIVET_TOKEN` may carry the last two instead. A Rivet Cloud cluster sets these on its node itself |
| `RIVET_POOL` | the node pool to join (default `default`); the engine refuses a node whose pool does not exist |
| `RIVET_NODE_VERSION` | a number that goes up with every deploy, so that new and woken actors go to the newest servers |
| `NODE_ENV` | `production`: RivetKit then never starts an engine of its own |
| `WLP_SECRET` | one secret, at least 16 characters (`openssl rand -hex 32`), the same on every server: a token one server signs must pass on all. A server with `RIVET_ENDPOINT` and no `WLP_SECRET` stops with `[wlp] WLP_SECRET is not set: ...` and nothing else |
| `WLP_SANDBOX` | `e2b`, or `fake` where agents run only on users' machines (as the self-host kit does). Docker sandboxes exist on the machine that made them, and a session's actor can wake on any server, so the Docker layer only works with one server; with a remote engine the server refuses it unless `WLP_ALLOW_DOCKER_HOSTED=1` |
| `WLP_WEB_ORIGINS` | the web app's address |
| `WLP_PUBLIC_ENDPOINT` | the engine's address for browsers, with no namespace and no token in it. It need not be the address in `RIVET_ENDPOINT`: on a cluster that one is internal to the node |
| `RIVET_ADMIN_TOKEN` | the engine's admin token, a secret, where the engine asks browsers for a token ("What browsers connect with" below). With it set, a server without `WLP_PUBLIC_ENDPOINT` stops with `[wlp] WLP_PUBLIC_ENDPOINT is not set: ...` |
| `WLP_CONNECTION_TOKEN_TTL_MS` | optional: how long a browser's token lasts (default one hour, at most 24) |
| `WLP_WINDLASS_BIN` | a Windlass executable on the server, for the sign-in commands ([Sign-ins](architecture.md#sign-ins)). `server/Dockerfile` puts one at `/usr/local/bin/windlass` and sets this |
| `WLP_SIGNIN_KEY` | optional; when set, the same on every server: what the key that encrypts sign-ins is derived from, in place of `WLP_SECRET` |
| `WLP_DEMO`, `WLP_TURN_TIMEOUT_MS`, `WLP_QUESTION_TIMEOUT_MS`, `WLP_IDLE_SUSPEND_MS`, `WLP_IDLE_DESTROY_MS` | the same values everywhere: a session's limits are applied by whichever server holds its actor |
| `WLP_DAILY_SANDBOX_SECONDS`, `WLP_MAX_KEPT_SANDBOXES`, `WLP_USAGE_HOLD_SECONDS` | the same values everywhere: a user's limits are applied by whichever server holds their `user` actor ([Usage and limits](architecture.md#usage-and-limits)) |
| `WLP_FACTORY_*` | the same values everywhere: the limits of work items and of a user's running turns are applied by whichever server holds the user's actor ([Work items](work-items.md)) |
| `WLP_ITEMS` | the same value everywhere, where users may file work items ([Work items](work-items.md)): a server without it answers the API's routes as unknown ones |
| `WLP_MACHINES`, `WLP_PUBLIC_URL`, `WLP_RUNNER_IMAGE` | the same values everywhere, where users may pair machines of their own ([Machines of your own](machines.md)). `WLP_PUBLIC_URL` is required then: it is the address runners are given |
| `WLP_HTTP_PORT` or `PORT` | the port the load balancer sends `/platform/info` to |
| `WLP_GITHUB_*`, `WLP_LINEAR_*`, `WLP_BUCKET_*`, `E2B_API_KEY`, `WLP_E2B_*` | the same values everywhere, where used: see [configuration.md](configuration.md) |

**What browsers connect with.** An engine that is shared is one that checks who connects. A Rivet Cloud
cluster is such an engine, run for one customer, and it has one credential: an admin token, which may do
everything in every namespace and so stays on the servers. It has none of the fixed tokens of a Rivet Cloud
project (`pk_...`, `sk_...`, `ck_...`); those are another product's. What a browser holds is a scoped token: a
JWT the engine issues when it is asked with the admin token, good for one namespace, for the operations it
names, and for a limited time.

The servers issue it. `GET /platform/connection`, under the same origin check as `/platform/info`, answers
with the engine's address for browsers (`WLP_PUBLIC_ENDPOINT`), the namespace, and a token with its expiry. The
token may list and read existing actors and call them through the gateway (`actor`: `list`, `read`;
`actor_gateway`: `read`, `create`), which is what the web app does, and nothing else: no deleting, no nodes, no
pools. It says only that its holder is a client of this deployment. Who the user is, and what is theirs, is
still decided by the platform's own token in every actor. A server asks the engine once and hands the same
token to every browser until half of its life is gone, so the engine is asked about twice an hour by each
server, and a browser always gets one that is good for half an hour or more. Each server keeps a token of its
own; all of them are good at the one engine.

The web app is therefore built with one address, `VITE_WLP_API`: the address in front of the servers' HTTP
port. It asks there for its connection when it starts, and has no token and no engine address built in. When
its token runs out it asks again: the next request or reconnect is made with the new one, and nothing is
reloaded. A feed that is open stays open, since the engine checks a token when a connection is opened and not
afterwards. While the servers cannot be reached to renew it, a feed shows that it is reconnecting and goes on
when they can.

Shared by all servers: the engine with the actors' data and schedules, `WLP_SECRET`, the admin token, and the
sandbox provider. Kept by each server for itself, and rebuilt when it is asked again: the cached platform
information, the token it hands browsers, and the sandbox layer's own caches. Still on one machine: the Docker
layer. The ChatGPT sign-ins are not: they are in
the users' actors, and every server needs `WLP_WINDLASS_BIN` (and the same `WLP_SIGNIN_KEY`, when it is set) to
run Windlass's sign-in commands ([Sign-ins](architecture.md#sign-ins)).

**On a Rivet Cloud cluster.** A cluster is an engine run by Rivet with nodes run by Rivet: the server is built
into an image and runs on the cluster's own node, which sets the connection and pool variables itself. From the
repository root:

```sh
rivet cluster secret set WLP_SECRET           # prompts for the value
rivet cluster secret set RIVET_ADMIN_TOKEN    # the cluster's admin token
rivet cluster secret set E2B_API_KEY          # and whatever else the E2B layer reads
server/stage-windlass.sh                      # the Windlass builds the image takes its own from
rivet deploy --cluster <cluster> --dockerfile server/Dockerfile --build-context . \
  --secret WLP_SECRET --secret RIVET_ADMIN_TOKEN --secret E2B_API_KEY \
  --env WLP_SANDBOX=e2b --env WLP_WEB_ORIGINS=https://<name>.onrivet.dev \
  --env WLP_PUBLIC_ENDPOINT=https://<name>-api.onrivet.dev
```

To let users pair machines of their own, add `--env WLP_MACHINES=1 --env WLP_PUBLIC_URL=https://<name>.onrivet.dev`,
and `--env WLP_RUNNER_IMAGE=<name>@sha256:<digest>` once a runner image is published. With `WLP_MACHINES=1`
and no `WLP_PUBLIC_URL`, a server on a remote engine does not start.

The CLI builds the image for linux/amd64 (on an arm64 machine too: the image's build runs nothing of the other
architecture) and prints the pool's public address, `https://<name>.onrivet.dev`, which serves the port in
`PORT`. The image holds the web app as well and serves it there (`WLP_WEB_DIR`, `server/src/web.ts`), so that
address is the platform: the web app is built with nothing set and asks the address it was loaded from, and
`WLP_WEB_ORIGINS` names that same address. A web app hosted elsewhere is built with `VITE_WLP_API` set to it. The
cluster's engine answers browsers at `https://<name>-api.onrivet.dev`, which is `WLP_PUBLIC_ENDPOINT`; the
address the node itself is given in `RIVET_ENDPOINT` is an internal one. The server asks the engine for its
first token when it starts, and says so if it is refused (`[wlp] WARNING: Browsers cannot connect: ...`). There
is no Docker on a cluster's node, so `WLP_SANDBOX=e2b` is required there. The cluster rolls its pool from
one build to the next itself; if the server says `node version defaulted` when it starts there, add
`--env RIVET_NODE_VERSION=<n>`, a number that goes up with every deploy. Each actor creation grant binds its actor kind and key. The server logs refused grants as `[wlp] actor.create_refused`.

**On servers of your own.** Each runs the same image, or `cd server && npx tsx src/index.ts`, with the
variables above, behind a load balancer for port 6440. The Rivet docs describe such nodes joining an engine by
`RIVET_ENDPOINT` and a secret token; whether a Rivet Cloud cluster accepts nodes of your own beside its hosted
one, they do not say. An engine of your own that has an admin token (`auth.admin_token`) is told to the servers
as a cluster's is, with `RIVET_ADMIN_TOKEN` and `WLP_PUBLIC_ENDPOINT`; one that lets everybody in needs neither,
and the web app is then built with its address in `VITE_WLP_ENDPOINT`.

## Public HTTP rate limits

RivetKit gives these HTTP routes a web `Request` with ordinary headers and no socket peer address.
With `WLP_CLIENT_IP_HEADER` unset (the default, including on Rivet Cloud), login requests share one address bucket. Other routes skip per-address limits. Client-supplied `Forwarded`, `X-Forwarded-For` and `X-Real-IP` have
no authority. With a trusted ingress, set `WLP_CLIENT_IP_HEADER` to the header it writes,
for example `x-ingress-ip`. Every path to the node must go through an ingress that strips the
caller's value and writes one verified IP. When configured, missing values, lists and malformed
addresses share the unknown-address bucket. Equivalent IPv6 spellings and IPv4-mapped IPv6
addresses identify the same client as their canonical addresses.

| Route and setting | Without a trusted header | With a trusted header |
|---|---|---|
| `POST /platform/login/{start,finish,demo}`, `WLP_LOGIN_ADDRESS_PER_MINUTE` (120) and `WLP_LOGIN_TOTAL_PER_MINUTE` (600) | One shared address bucket and the deployment ceiling | Each address has its own allowance within the same deployment ceiling. All nodes share both counters per UTC minute. A provider attempt accepts at most five unsuccessful finishes. |
| Items API requests, `WLP_API_ADDRESS_PER_MINUTE` (240/min) | No address limit | Each node limits requests per address before body parsing or actor lookup |
| Items API authorization, `WLP_API_TOKEN_PER_MINUTE` (60/UTC minute) | Each authorized token has one allowance across routes, scopes and nodes, stored in the owning user's database | Same per-token limit |
| Items API invalid tokens, `WLP_API_FAILURES_PER_MINUTE` (12/min) | Each node counts refusals only after it identifies a missing, malformed, unknown, revoked or out-of-scope token. Excess refusals receive 429. Valid tokens can still proceed | Each node reserves a slot per address before lookup. Concurrent calls wait for pending results. Successful checks release their slots. Once the address exhausts the failure allowance, all its items API calls receive 429 until reset |
| `POST /github/webhook`, `WLP_WEBHOOK_REFUSALS_PER_MINUTE` (30/min) | Each node counts refused webhook requests, including wrong methods, across all callers | Each node counts those refusals per address. In both modes an accepted delivery bypasses the refusal limit |
| `POST /runner/pair` | The shared pairing directory allows 3 starts per canonical public key and 16 per secret-derived bucket in 10 minutes, across 64 buckets | Same pairing limits |
| `POST /runner/pair/poll`, `WLP_RUNNER_POLLS_PER_MINUTE` (240/min) | No poll limit | Each node limits polls per address before the pairing lookup |
| `POST /runner/connection`, `WLP_RUNNER_CONNECTIONS_PER_MINUTE` (120/min) | Each active machine has its own allowance per UTC minute, stored by the machine actor and charged only after signature verification. Each node also has a separate allowance at the same rate for malformed bodies, unknown machines and bad signatures | Each node limits attempts per address before looking up the machine or checking its signature |

The items limits cover item creation, item reads and attachment downloads. Use the same settings
on every node. Each per-minute setting accepts a whole number from 1 to 1,000,000. Node-local
windows last 60 seconds and reset on restart. With *N* nodes a caller can spend up to *N*
node-local allowances in the same period. When address limits are enabled, clients behind one
NAT share an allowance. Each address table keeps up to 4,096 keys plus one shared overflow
bucket per window.

An exhausted limit returns HTTP 429 with a JSON `message` and an integer `Retry-After` in
seconds. Each node logs one `github.webhook.refused` summary one minute after the first refusal,
including total refusals, bad signatures and how many received 429. Quiet minutes produce no
line. The summary contains only counts. RivetKit enforces its 3 MiB body cap before routing.


## E2B

With `WLP_SANDBOX=e2b` a session's sandbox is a microVM at [E2B](https://e2b.dev) instead of a container on the
server's machine, so any server of a deployment reaches any session's sandbox. A deployment has one provider:
a server on E2B offers the E2B profiles and no Docker profile of its own (a user's machine offers its own
two, [Machines of your own](machines.md)). `scripts/e2b-check.ts` tries it against the real
service; it first passed there on 2026-11-15.

```sh
E2B_API_KEY=e2b_... sandbox/e2b/build.sh                            # builds the template windlass-platform-sandbox at E2B, with the released x86_64 Windlass
cd server && E2B_API_KEY=e2b_... npx tsx ../scripts/e2b-check.ts    # one sandbox, one scripted turn, about two minutes
WLP_SANDBOX=e2b E2B_API_KEY=e2b_... WLP_WINDLASS_BIN=/path/to/windlass npx tsx src/index.ts
```

### Hosted deployment settings

Set these on each server in a deployment. An explicit `WLP_HOSTED_*` value takes precedence over its existing E2B setting. Windlass reports conflicting names at startup. The deployment running cap applies across its servers. E2B also enforces the account's own limits.

| Variable | Default | Meaning |
|---|---|---|
| `WLP_HOSTED_DEPLOYMENT` | `default` | Inventory and cleanup label |
| `WLP_HOSTED_MAX_RUNNING` | 3 | Concurrent running sandboxes in this deployment |
| `WLP_HOSTED_MAX_CONTINUOUS_MS` | 3600000 | Continuous runtime available for a turn (`WLP_E2B_MAX_RUNTIME_MS`) |
| `WLP_HOSTED_IDLE_TIMEOUT_MS` / `WLP_HOSTED_TURN_LEASE_MS` | 120000 / 180000 | Idle and active leases |
| `WLP_HOSTED_IDLE_ACTION` | `pause` | `pause` retains disk and memory. `destroy` discards both, as with `WLP_E2B_PAUSE=0` |
| `WLP_HOSTED_SIZES` | `small` | Enabled sizes, comma-separated, always including small |
| `WLP_HOSTED_MAX_VCPUS` / `WLP_HOSTED_MAX_MEMORY_MIB` | 8 / 8192 | Upper bounds for template builds |
| `WLP_HOSTED_INNER_SANDBOX` / `WLP_HOSTED_OPEN_PROFILE` | 0 / 0 | Existing profile switches (`WLP_E2B_WINDLASS_SANDBOX` / `WLP_E2B_OPEN_PROFILE`) |
| `WLP_HOSTED_WINDLASS_VERSION` | unset | Version in the deployed template |
| `WLP_HOSTED_NETWORK` / `WLP_HOSTED_NETWORK_ALLOW` | `open` / `@npm,@pypi,@github` | Deployment network policy and restricted-mode presets |
| `WLP_HOSTED_NETWORK_MAX_HOSTS` | 64 | Total allowed hosts in a restricted list, including platform hosts |
| `WLP_HOSTED_SNAPSHOTS` | `off` | Enable prepared environments with `on` |
| `WLP_HOSTED_SNAPSHOT_MAX` / `WLP_HOSTED_SNAPSHOT_USER_MAX` | 10 / 3 | Deployment and per-user image counts |
| `WLP_HOSTED_SNAPSHOT_MAX_GIB` | 4 | Maximum used disk to capture (`WLP_E2B_SNAPSHOT_MAX_GB`) |
| `WLP_HOSTED_SNAPSHOT_TTL_MS` | 1209600000 | Retention for hosted image reuse, pruning and placement hints |
| `WLP_HOSTED_RATE_CARD_FILE` | unset | JSON file with running compute rates in USD per second |

The built-in rate card is equivalent to the following file. A zero rate is valid. These estimates do not change usage allowances or settled receipts.

```json
{ "e2b": { "microvm": { "usdPerVcpuSecond": 0.000014, "usdPerGiBSecond": 0.0000045 } } }
```

The default template is `windlass-platform-sandbox`. Build `windlass-platform-sandbox-shots` with
`WLP_SANDBOX_VARIANT=shots sandbox/e2b/build.sh` for repositories that enable screenshots.
`WLP_E2B_TEMPLATE` and `WLP_E2B_SHOTS_TEMPLATE` override their respective names for both build and server.
Use `--print` with either variant to inspect it locally.

**Sizes.** E2B fixes a sandbox's CPUs and memory when its template is built (`Sandbox.create` takes neither), so
each hosted size is a template of its own, built from the same Dockerfile with `WLP_E2B_SIZE`:

| Size | Template (shots variant adds `-shots`) | Size | Build |
|---|---|---|---|
| Small | `windlass-platform-sandbox` | 1 vCPU, 1 GiB | `sandbox/e2b/build.sh` |
| Medium | `windlass-platform-sandbox-standard` | 2 vCPU, 4 GiB | `WLP_E2B_SIZE=standard sandbox/e2b/build.sh` |
| Large | `windlass-platform-sandbox-large` | 4 vCPU, 8 GiB | `WLP_E2B_SIZE=large sandbox/e2b/build.sh` |

Build each with `WLP_SANDBOX_VARIANT=shots` too where screenshots are on. The server offers a size only once
`WLP_E2B_SIZES` lists it (default `small`): set `WLP_E2B_SIZES=small,standard,large` after building them. A
size asked for that is not listed gets the largest listed below it. Work items default to Medium, a person's
agents to the repository's saved size, else small. `WLP_E2B_TEMPLATE_STANDARD`, `WLP_E2B_TEMPLATE_LARGE` and
`WLP_E2B_SHOTS_TEMPLATE_STANDARD`, `_LARGE` override the names. Post-setup snapshots are per template, so per
size.

**The account's plan.** Large (4 vCPU, 8 GiB) is the largest size the platform offers.
The E2B template build checks CPU and memory overrides. If the provider refuses a size, the user
sees the size and the provider's reason, and the server logs `e2b.size_refused`.
`WLP_E2B_MAX_RUNNING` caps one deployment. Other deployments and scripts sharing the account
also count toward the provider's concurrency limit.

`sandbox/e2b/build.sh --print` shows what E2B would be asked to build and needs no key. The template is made
from the Docker image's own `sandbox/Dockerfile`, so a microVM has what a container has: the user `agent`,
`/workspace`, Windlass's data directory, `wlp-run`, git, bubblewrap and Windlass. A server on E2B needs no
Docker: Windlass's sign-in commands run from `WLP_WINDLASS_BIN`, an executable for the server's own machine.
E2B's SDK (`e2b` 2.63.0, loaded only by a server on E2B) needs Node 22.19 or later.

- **What the profile promises.** Whether Windlass's bubblewrap sandbox works inside a deployment's microVMs is
  for the check to show (it worked in the template on 2026-11-15), so by default the profile promises nothing
  of it: commands may have network and may read the session's access token. Windlass runs with
  `--approval auto` and probes bubblewrap itself: where the probe passes it sandboxes commands, where it fails
  it asks before every command. The check prints which (`ANSWER:`).
  If bubblewrap works, `WLP_E2B_WINDLASS_SANDBOX=1` makes the profile promise what the first Docker profile
  promises, and every new sandbox is held to it: one in which the probe fails is removed and not handed out.
- **A second profile: E2B, microVM only** (`e2b-open`), offered only where the servers run with
  `WLP_E2B_OPEN_PROFILE=1`; without it the picker lists it as not available, and a server refuses to launch a
  session with it whatever the browser sends. Windlass runs with `--approval full` and sandboxes no command:
  commands run directly in the microVM, with its network and a writable home directory (package installs,
  tools that write `~/.config`), and nothing asks first. What that gives up: a command can reach any host, and
  can read the turn's token file, which holds a placeholder when the model relay is enabled (the sign-in is
  never in the microVM, in this profile too). One thing stays: once something from the web or an MCP server is
  in the conversation, Windlass's taint rule sandboxes commands again and asks before network or a write
  outside the workspace. A sandboxed command then finds a home of the session's own ([Sandboxes](architecture.md#sandbox-profiles) above): what
  the commands before it left in the home is read-only there, and what it adds is kept apart for the session.
  The user chooses per session; the E2B profile above stays the picker's default. A
  sandbox's profile is in its metadata (`wlp_profile`), so every server runs a session's Windlass the same way;
  sessions launched with `e2b-open` keep it after the flag is turned off, and only new ones are refused.
- **A turn** is the same process as in a container, `wlp-run exec <tag> windlass acp`, started through E2B's
  command API; the access token file is written the same way, the token on the command's standard input.
- **Windlass's data directory is on the microVM's own disk**, not on a volume (E2B's volumes are a private beta
  in which file locks can hang, and Windlass keeps SQLite databases there). A session's Windlass session lives
  and ends with its sandbox, and no session sees another's files, also not the token file of the same user's
  other turn. A pause keeps it. When a sandbox is gone (killed, or lost), the session gets a new one with an
  empty workspace. With a bucket configured, the copy of the agent's session (Windlass's, Claude Code's,
  Codex's or OpenCode's) is put into the new sandbox and
  the agent goes on where it was ([The agent's memory outlives its sandbox](architecture.md#the-agents-memory-outlives-its-sandbox) below); without one it starts a
  new Windlass session, and the timeline says so. On Docker the data directory is a volume of the user's and
  outlives a sandbox.

| What | How | Default |
|---|---|---|
| Size of a sandbox | the template's, one per size (`WLP_E2B_SIZE` for `sandbox/e2b/build.sh`), offered by `WLP_E2B_SIZES` | small: 1 vCPU, 1024 MiB |
| Sandboxes running at once | `WLP_E2B_MAX_RUNNING`, counted from E2B's own list of the deployment's running sandboxes before one is created or resumed, and again after, so it holds across servers. At the cap the user reads: "This deployment runs at most 3 sandboxes at the same time, and all of them are in use. Try again in a few minutes; an agent's sandbox is freed shortly after its turn has ended." A work item's turn is not refused at the cap: it waits, and is tried again after 30 seconds, then twice as long each time up to five minutes ([Work items](work-items.md)) | 3 |
| A sandbox nobody uses | its own timeout at E2B, `WLP_E2B_IDLE_TIMEOUT_MS`: E2B pauses it by itself that long after the last use | 2 minutes |
| A sandbox whose server died | while a turn runs, the server pushes the timeout out to `WLP_E2B_TURN_LEASE_MS` every third of it; a dead server stops doing so, and E2B pauses the sandbox | 3 minutes |
| Suspend and destroy | `suspend` pauses: files and memory are kept, nothing is billed, and E2B keeps a paused sandbox without limit. `destroy` kills. With `WLP_E2B_PAUSE=0`, for an account that cannot pause, both the timeout and `suspend` kill, and the session's files and Windlass session are lost each time | pause |
| The plan's hour | a sandbox with too little left of `WLP_E2B_MAX_RUNTIME_MS` for a turn is paused and resumed before the turn starts, which starts the hour again | 1 hour |
| Finding them again | every sandbox carries `wlp_deployment` (`WLP_E2B_DEPLOYMENT`), `wlp_uid`, `wlp_session` and `wlp_profile` in its metadata; only sandboxes with the deployment's mark are ever touched | `default` |

The platform estimates a running small sandbox at $0.0000185 a second (about $0.067 an hour).
Three running small sandboxes therefore estimate to about $0.20 an hour. Larger sizes cost more.
Each time a sandbox stops running through a server, a line says how long it ran and what that costs:

```
[wlp] e2b.sandbox.paused id=... uid=... session=...: it ran 182 s at 1 vCPU and 1024 MiB, $0.0034 (estimated)
```

Every such number is an estimate: the prices are in one file (`server/src/sandbox/e2b/pricing.ts`), the time is
the server's own measurement, and E2B's usage page has what was billed.

```sh
cd server && E2B_API_KEY=e2b_... npx tsx ../scripts/e2b-cleanup.ts            # lists the deployment's sandboxes; changes nothing
cd server && E2B_API_KEY=e2b_... npx tsx ../scripts/e2b-cleanup.ts --kill     # removes them, paused ones too
cd server && npx tsx ../scripts/e2b-provider-test.ts                         # the provider on an in-memory E2B: no account, nothing sent
cd server && npx tsx ../scripts/e2b-provider-test.ts --docker
                                                                             # and real scripted turns through it, in local containers
```

The provider's logic is written against a small interface of its own (`server/src/sandbox/e2b/client.ts`);
`sdk.ts` maps it to E2B's SDK and `fake.ts` keeps it in memory for the tests. Limits of this provider: a paused
sandbox is kept at E2B, at no charge, until its session is deleted, the session's sandbox is removed for not
being used (`WLP_IDLE_DESTROY_MS`) or by its user on the Usage page ([Usage and limits](architecture.md#usage-and-limits)), or `e2b-cleanup.ts`
removes it; opening a session's changes in the browser resumes its sandbox for the length of the idle timeout;
and a turn whose command stream to E2B breaks ends as a failed turn, though the sandbox goes on until its
timeout.

### What E2B adds to the template, and why the platform takes it away

E2B's template build provisions a base system of its own under `sandbox/Dockerfile`: systemd, an OpenSSH
server on port 22 that lets root in with an empty password, rpcbind on port 111, and the accounts `root` and
`user` with empty passwords. Left alone, any command of the agent's can `ssh root@127.0.0.1` or `su`, and so
become root or any other user, such as `nobody`, which holds the GitHub token during Git transport. The platform
does not need any of it: E2B's own agent (envd, port 49983) runs every command. The script in
`server/src/sandbox/e2b/guest-hardening.ts` locks every account with an empty password (and `root` and `user`
whatever theirs), tells sshd to refuse root and password logins, stops and masks the ssh and rpcbind units, kills
every sshd process together with what it started, and then checks the result.

- It runs as the last step of every template build (`template.ts`). A build fails when the check fails.
- The provider runs it as root on every create, on every connect that resumes a paused sandbox or starts one
  again from its disk, on the pause and resume before a turn near the plan's hour, and on the first connect of a
  server process to a running sandbox. It always runs before anything of the session's. Templates built before
  this change are covered too.
- It fails closed. If port 22 still listens, an sshd still runs, or an account still has an empty password, the
  sandbox is not used. A new sandbox is killed, and a resumed one is paused again. The person reads why, and the
  log has `e2b.sandbox.hardening_failed`.

`scripts/e2b-hardening-check.ts` checks this against the real service, in about two minutes with one sandbox:

```sh
cd server && E2B_API_KEY=e2b_... npx tsx ../scripts/e2b-hardening-check.ts
cd server && E2B_API_KEY=e2b_... WLP_E2B_TEMPLATE=windlass-platform-sandbox-claude npx tsx ../scripts/e2b-hardening-check.ts
```

### The model relay

With the relay, an E2B sandbox never holds the user's access token: Windlass sends its model requests to the
server's relay route with a placeholder ([model-relay.md](model-relay.md)). It needs three settings on every
server of the deployment:

- `WLP_MODEL_RELAY_URL=https://<relay hostname>`, a DNS name of the relay's own, such as
  `https://windlass-relay.example.com`.
- `WLP_E2B_WINDLASS_VERSION=0.7.1` (or the installed later version), after replacing every offered Windlass template.
- `WLP_MODEL_RELAY` unset or `on`.

Route the relay's hostname to the same server port as `WLP_PUBLIC_URL`, over HTTPS on 443, and keep the
`Host` header. With the self-hosted Cloudflare Tunnel, that is one more ingress rule and one DNS route
([deploy/selfhost/README.md](../deploy/selfhost/README.md#the-model-relays-hostname)). The server checks the method, path and lease under `/model-relay/` on that name. Without `WLP_MODEL_RELAY_URL` E2B turns get the token in the sandbox, as
before, and the server logs `e2b.model_relay: off (WLP_MODEL_RELAY_URL is not set)` once at startup.

The relay's limits are per server process: 8 requests in flight and 32 waiting per turn, 16 in flight and 300
a minute per user, and `WLP_MODEL_RELAY_REQUESTS` (64) in all. With several server processes each has its
own. They bound how many requests run at once, not what a user spends: a user's turns can still use their
plan's quota through the relay while they run.

Once a server of this version answers on the relay's hostname, check the network of the real service. One
short sandbox in `restricted`, then one in `none`: `api.openai.com` is not reached, the relay's hostname
answers its route with `relay_lease_ended` and every other path with a 404, and the platform's public host is
not reached:

```sh
cd server && E2B_API_KEY=e2b_... WLP_E2B_CHECK_NETWORK=1 WLP_MODEL_RELAY_URL=https://<relay hostname> \
  WLP_E2B_WINDLASS_VERSION=0.7.1 WLP_PUBLIC_URL=https://<platform hostname> npx tsx ../scripts/e2b-check.ts
```

Before turning the relay on for E2B, and after any change to the route, make one real model request through
it from an E2B sandbox. It runs a server of its own in its own process behind a Cloudflare quick tunnel
(`cloudflared` on the PATH), one sandbox and one short turn, and touches no deployment:

```sh
windlass login token --json > /tmp/relay-token.json && chmod 600 /tmp/relay-token.json   # where a ChatGPT sign-in is saved
cd server && E2B_API_KEY=e2b_... WLP_RELAY_CHECK_TOKEN_FILE=/tmp/relay-token.json npx tsx ../scripts/model-relay-e2b-check.ts
rm /tmp/relay-token.json
```

On the live server, `[wlp] model_relay.failed` and `model_relay.detail` lines say what the relay refused
or could not reach.

### Network

`WLP_E2B_NETWORK` sets what every sandbox of the deployment may reach: the hosted counterpart of a machine's
`--egress` ([Machines of your own](machines.md)). E2B enforces it outside the microVM with its own network
configuration ([internet access](https://docs.e2b.dev/network/internet-access.md)), so nothing inside the
sandbox can lift it. The agent's commands, Windlass's engine and the platform's own steps all run in the same
microVM and share it, so the server adds the hosts its own steps need, from its own configuration
(`server/src/sandbox/e2b/network.ts`):

| Step in the microVM | Host |
|---|---|
| Model requests of the turn's engine | `api.openai.com`; with the model relay the host of `WLP_MODEL_RELAY_URL` instead ([model-relay.md](model-relay.md)), in `none` too. The platform's own public host is never added |
| Clone, fetch and push, as the transport user | the host of `WLP_GITHUB_URL` (`github.com`) |
| Memory backups and screenshots, with a signed link | the bucket's host (`WLP_BUCKET_ENDPOINT`, with the bucket before it in `virtual` style) |

| Mode | What E2B is asked for | Repositories |
|---|---|---|
| `open` (default) | nothing: as before network modes. E2B still blocks private and link-local ranges | allowed |
| `restricted` | every destination denied, the hosts above, `WLP_E2B_NETWORK_ALLOW` and the session's repository's network list allowed by name, no DNS server | allowed |
| `none` | every destination denied, the model API and the bucket allowed by name, no DNS server | refused at launch and when a turn starts; the factory does not place items on hosted |

`WLP_E2B_NETWORK_ALLOW` takes exact host names and presets, comma-separated, and only with `restricted`. Default
`@npm,@pypi,@github`; at most 64 hosts in all, with the platform's own and a repository's list. No addresses,
ports or wildcards. The presets (`NETWORK_PRESETS` in `server/src/contract.ts`), each from the tool's own code
or documentation, with every host a download is redirected to (checked 2026-11-22):

| Preset | Hosts | Where they come from |
|---|---|---|
| `@npm` | `registry.npmjs.org`, `registry.yarnpkg.com` | npm's `registry` default (npm/cli `workspaces/config/lib/definitions/definitions.js`); Yarn's (yarnpkg/berry `packages/plugin-npm/sources/index.ts`) |
| `@pypi` | `pypi.org`, `files.pythonhosted.org` | pip's index (pypa/pip `src/pip/_internal/models/index.py`); files redirect within `files.pythonhosted.org` |
| `@github` | `github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`, `release-assets.githubusercontent.com` | archives, raw files and release assets, with their redirects |
| `@crates` | `crates.io`, `index.crates.io`, `static.crates.io` | `index.crates.io/config.json` (`dl`, `api`); a download on `crates.io` redirects to `static.crates.io` |
| `@go` | `proxy.golang.org`, `sum.golang.org` | Go's `go.env` (`GOPROXY`, `GOSUMDB`); module zips come from the proxy itself, no redirect |
| `@node` | `nodejs.org` | node-gyp's headers (`process.release.headersUrl`, `lib/process-release.js`), its `SHASUMS256.txt`, and Node's `/dist`; no redirect |
| `@playwright` | `cdn.playwright.dev`, `playwright.download.prss.microsoft.com` | Playwright's mirrors (`packages/playwright-core/src/server/registry/index.ts`); `cdn.playwright.dev/dbazure/…` redirects to the Microsoft host. Chrome for Testing builds (`cdn.playwright.dev/builds/cft/…`, Chromium on x86_64) answer 307 to `storage.googleapis.com/chrome-for-testing-public/…`, which is `@gcs`. `playwright install chrome` (`dl.google.com`) and msedge are not in it |
| `@gcs` | `storage.googleapis.com` | Google Cloud Storage, a preset of its own because it serves every public bucket, anyone's. The scan proposes it with `@playwright` |
| `@prisma` | `binaries.prisma.sh` | `@prisma/fetch-engine` (`PRISMA_ENGINES_MIRROR` default), checksums from the same host. Prisma 6 downloads its engines, 7 only the schema engine, 8 nothing |
| `@debian` | `deb.debian.org`, `security.debian.org` | the `debian:bookworm` and `trixie` images' `debian.sources` (both suites on `deb.debian.org`); installed systems use `security.debian.org`. apt uses plain HTTP, which E2B matches by `Host` on port 80 |
| `@ubuntu` | `archive.ubuntu.com`, `security.ubuntu.com`, `ports.ubuntu.com` | `ubuntu:24.04`'s `ubuntu.sources` (amd64; `ports.ubuntu.com` on arm64). Regional mirrors (`<cc>.archive.ubuntu.com`) are not in it | E2B matches names only on ports 443 and 80, so in `restricted` and `none` the
server does not start when `WLP_GITHUB_URL` or the bucket endpoint is not an `https` address on the default
port.

How it is built:

- E2B lets all traffic to its default resolver (`8.8.8.8`) through as soon as one name is allowed, which carries
  any name a command wants to look up. So no DNS server is allowed (`dnsServers: []`), and the server writes the
  allowed names into the sandbox's `/etc/hosts` and empties `/etc/resolv.conf`, as root, before anything else
  runs in it and again at every resume. Every other lookup fails at once. E2B routes an allowed request by its
  name, so the pinned address does not matter.
- A sandbox carries its mode in its metadata (`wlp_network`). On every connect where either the recorded or the
  current mode is not `open`, the server replaces the sandbox's E2B configuration (`updateNetwork`) and writes
  the names again, so a changed setting reaches kept sandboxes at their next turn. Open to open changes nothing.
- The profiles' texts follow the mode (the **sandbox** chip, a setup command's note, what an MCP server can
  reach in Settings), and `PlatformInfo.hostedEgress` carries it to the web app when it is not `open`.

#### A repository's network list

In `restricted`, each repository can allow hosts of its own, on top of the platform's and the deployment's
(`server/src/repository-network.ts`; the people who use it read about it in the in-app docs, *Settings*). It is
kept with the repository's other settings, under GitHub's id, in the `user` actor of the person who saved it
(`repository_network`), and only that person can change it. It holds presets and exact names, at most 40 hosts,
and no more than leaves the whole within 64 (a save is refused otherwise, with the reason). A session reads it
with its secrets when a turn starts (`SealedSecrets.network`), keeps it in its state, and every connect to its
sandbox sets E2B's configuration and the pinned names to the deployment's hosts and the list's together. A
session has one repository, so it gets that repository's hosts. If the deployment's own list grew so that the
whole passes 64, the repository's hosts that do not fit are left out and logged (`e2b.network.dropped`). The
changes of one sandbox's network run one at a time on the server (`E2bProvider.serial`), and the root script
holds `/run/wlp-network.lock` and stages the names file under a `mktemp` name in `/run`, so a connect and an
allow at the same moment cannot leave `/etc/hosts` empty or E2B's list and the names file from different calls.

**Blocked hosts.** Out of `open`, the sandbox's resolver is a lookup stub on `127.0.0.1:53`, written and started by
the same root script that pins the names (`DNS_STUB` in `network.ts`, run with the template's `python3`, so no
template rebuild is needed). It answers every question NXDOMAIN at once, as the empty resolver file did, and
writes each name it is asked for once to `/var/log/wlp-dns.log`. glibc, Go, Python, Node and curl read
`/etc/hosts` first and ask the resolver only for a name that is not pinned, so every line there is a host a
command wanted and E2B would refuse: a signal that rests on no error message. It binds as root, opens the log as
root and then runs as `nobody`, so the agent can neither write the log nor stop it; it is a reporter, not a fence.
After the setup command and at the end of each turn the session reads the log, and the timeline names each new
host once per sandbox (at most 40), with **Allow for this repository**; the host is also filed as a request on the
repository's list (`network_request`, at most 30 per repository and 1,000 per user). The requests waiting are
kept over new ones: past the cap a new host is not filed and the timeline says so, so names looked up by the
hundred cannot push out one the person wants. The settings show requests with Allow and Dismiss. The log is
read whole (the stub stops at 256 KiB), and names the timeline named already are left out before the 50-name
cut, so earlier ones cannot hide a later one. A TCP client of the stub has one second in all, so a slow one
cannot hold it. Allowing from the timeline saves the host to the list, and while a turn holds the sandbox it
changes the sandbox at once (`updateNetwork` and the pinned names, `E2bProvider.applyEgress`); otherwise it
applies from the next turn, since a change between turns would start a paused sandbox or push a running one's
timeout out with no meter counting it. In `none` it is refused, since nothing but the model API is reached
there. Only the person whose settings it is can allow (`mayChangeNetwork`). A call from anyone else would file
a request instead, but a session's actions are its own user's, so today that call cannot happen.

**Proposed hosts.** The repository's settings can read its manifests, lockfiles, install scripts and CI files at
the default branch through the GitHub App (the tree, then at most 60 files by blob, 16 MiB in all), and the saved setup
command, and list the presets and hosts they name that the sandboxes cannot reach yet, each with where it was
found ("package.json scripts.postinstall", at most 200 characters each). A fixed reading (`scanForHosts`): no agent, no command, and nothing
saved. Pages about a project (homepages, repository and funding links, `[project.urls]`), comments, and CI keys
that are no steps are passed over. Each proposal is allowed by its own click, since a repository's text can name
a host chosen to send data to.

What it does not do: a lookup the stub logs may have been made to look plausible (the agent and a repository's
scripts choose what they look up), so the timeline asks for a host only to be allowed if it is expected; and
`@gcs` (`storage.googleapis.com`) reaches every public Google Cloud Storage bucket, which its preset, its
proposal and the timeline's line about it all say. An allowed host is still a way out (a command can push to someone else's repository on
GitHub with a credential of its own); `api.openai.com` is reachable by commands in every mode, since the engine
needs it and runs as the same user; a remote MCP server by `url` is reachable in `restricted` only when its host
is in `WLP_E2B_NETWORK_ALLOW`; and `169.254.169.254` answers in every mode, as the microVM's own Firecracker
metadata service, which holds nothing of the account or other sandboxes (E2B,
[restricting public access](https://docs.e2b.dev/network/restrict-public-access.md)). Our runner's filtering proxy
is not used inside the microVM: without a guest firewall it could be bypassed, and the engine and the commands
are the same user.

`scripts/e2b-provider-test.ts --docker` proves the modes on the platform's real clone, push, model and bucket
steps against a stand-in of E2B's filter, with a repository's host and one allowed while the sandbox runs, and
that the lookup stub names a blocked host; `scripts/network-check.ts` holds the list's rules, its storage, the
reading of a repository's files and the stub; `WLP_E2B_CHECK_NETWORK=1 scripts/e2b-check.ts` proves the modes at
E2B (two short sandboxes, no turn).

## Daytona

Set `WLP_SANDBOX=daytona`, a unique `WLP_HOSTED_DEPLOYMENT`, and a server-side `DAYTONA_API_KEY` with `write:sandboxes` and `delete:sandboxes`. The adapter uses Daytona v0. `DAYTONA_API_URL` defaults to `https://app.daytona.io/api`. Set `DAYTONA_TARGET` to the region ID with Linux VM capacity and the prepared boot image, or use the organization's default. Configure the dedicated HTTPS `WLP_MODEL_RELAY_URL` and the server-side sign-in binary as for E2B. Set `WLP_HOSTED_WINDLASS_VERSION` to the version in the image (0.6.0+ for ChatGPT, 0.7.1+ for Windlass Settings keys). The guest receives a signed placeholder for the turn. [API keys](https://www.daytona.io/docs/en/api-keys/) · [Regions](https://www.daytona.io/docs/en/regions/)

1. Run the **Release images** workflow with `version` blank and `push=true` to publish the Daytona boot image. Select `windlass_version` to match `WLP_HOSTED_WINDLASS_VERSION`. After the first publish, open the `windlass-platform-sandbox-daytona` package settings on GitHub and change its visibility to **Public**. Copy the digest reference from the job summary for `imageName`. Small, Medium, and Large all use this image. The wrapper installs the process helper. It runs each command as `agent` or the isolated Git transport user after the launcher drops privileges.
   To build manually on amd64, run `sandbox/build.sh && docker build --platform linux/amd64 --build-arg WINDLASS_IMAGE=windlass-platform-sandbox:latest -t "$DAYTONA_IMAGE" sandbox/daytona && docker push "$DAYTONA_IMAGE"`.
2. With an image-builder credential (`write:snapshots`), create a snapshot using `POST /snapshots` under the v0 API URL. Supply `name`, `imageName` (the published OCI digest reference), `sandboxClass: "linux-vm"`, `regionId`, and numeric `cpu`, `memory`, `disk`. Wait for **active** in the selected region. For a private registry, configure its pull credentials in Daytona. [Linux VM snapshots](https://www.daytona.io/docs/en/linux-sandboxes/)
3. Use `windlass-platform-sandbox` for Small (1 vCPU / 1 GiB RAM / 3 GiB disk). For Medium and Large append `-standard` (2/4/8) or `-large` (4/8/10). `WLP_DAYTONA_SNAPSHOT` overrides the base name. Enable built sizes via `WLP_HOSTED_SIZES`. For screenshots or a hosted CLI, wrap its corresponding Windlass image and append `-shots`, `-claude`, `-codex`, or `-opencode` to the size's snapshot name.

Tier 1 offers only the Open profile, subject to the organization's egress policy. Keep `WLP_HOSTED_NETWORK=open` and `WLP_HOSTED_SNAPSHOTS=off`. Daytona VM cold capture requires stopping the source. Windlass prepared environments are unavailable. `WLP_HOSTED_IDLE_ACTION=pause` stops the VM and retains its disk. Reconnect starts the same VM with fresh processes. The provider rounds the idle timeout up to whole minutes and refreshes activity during turns. `destroy` discards the workspace. Regional lifespan limits still apply. [Network limits](https://www.daytona.io/docs/en/network-limits/) · [VM lifecycle](https://www.daytona.io/docs/en/linux-sandboxes/)

The running estimate includes CPU, RAM and disk before free storage allowances. Stopped VMs can still incur storage charges. Override `usdPerVcpuSecond`, `usdPerGiBSecond` and `usdPerDiskGiBSecond` under `daytona.linux-vm` in `WLP_HOSTED_RATE_CARD_FILE`. [Daytona pricing](https://www.daytona.io/pricing)


## Recover a platform login

For a signed-out owner, verify ownership independently. Obtain the exact existing Windlass UID from a trusted account record or backup and the provider subject from the owner’s authenticated provider account. For GitHub, verify the numeric user ID on the deployment’s configured GitHub API host. For Google, use the verified ID token’s `sub` for the configured OAuth client. The owner should wait to use provider sign-in until the link is in place.

Run this in the server container, from its default working directory, with its normal engine and signing configuration:

```sh
node --import tsx src/link-identity.ts --uid "$OWNER_UID" --provider github --id "$GITHUB_NUMERIC_ID"
```

For Google use `--provider google --id "$GOOGLE_SUB"`. Repeating the same assignment is safe. The command requires an existing user and refuses conflicting assignments. Keep that UID admitted through `WLP_ALLOWED_USERS` when the deployment restricts access. Ask the owner to sign in and compare the UID in the account menu.

## The GitHub App

What the platform does with GitHub, and why each permission is needed, is in
[github-and-repositories.md](github-and-repositories.md). Register one at GitHub (Settings, Developer settings, GitHub Apps, New GitHub App), for the address the
platform is served at, `https://<name>.onrivet.dev` below:

| Setting | Value |
|---|---|
| GitHub App name | any; its address `https://github.com/apps/<slug>` gives `WLP_GITHUB_APP_SLUG` |
| Homepage URL | `https://<name>.onrivet.dev` |
| Callback URL | `https://<name>.onrivet.dev/github/callback` first for repository connections, then `<web-origin>/signin` for platform login |
| Expire user authorization tokens | selected |
| Request user authorization (OAuth) during installation | selected. GitHub then sends the browser to the callback URL after an installation too, with a code |
| Setup URL | none. GitHub takes none while the setting above is selected |
| Enable Device Flow | not selected |
| Webhook | "Active" selected where work items should hear from GitHub at once (issue intake, CI, pull request state): URL `https://<name>.onrivet.dev/github/webhook`, and a secret of at least 32 characters, which is `WLP_GITHUB_WEBHOOK_SECRET`. Without a webhook, items poll GitHub and nothing is taken in from issues |
| Subscribe to events | Issues, Issue comment, Check run, Check suite, Status, Pull request, Pull request review, Pull request review comment (installation events come by themselves) |
| Repository permissions | Contents: read and write. Pull requests: read and write. Issues: read and write. Checks: read and write. Commit statuses: read-only. Actions: read and write. Metadata: read-only (GitHub adds it). Nothing else |
| Account permissions | Email addresses (read-only) only for admission through `WLP_ALLOWED_EMAILS`; UID-based admission and linking need no email permission |
| Organization permissions | none |
| Where can this GitHub App be installed? | Choose "Only on this account" for a single-owner deployment. Choose "Any account" if other accounts need to install the App. |

Deliveries are checked against the secret (`X-Hub-Signature-256`) and kept in an inbox actor keyed by their
delivery id, so a redelivery is taken once. GitHub does not redeliver failed deliveries by itself; the
platform sweeps the recent ones and asks GitHub to redeliver what it missed, within GitHub's three days
(`server/src/actors/github-inbox.ts`). To rotate the secret, set the new one as
`WLP_GITHUB_WEBHOOK_SECRET` and the old one as `WLP_GITHUB_WEBHOOK_SECRET_PREVIOUS` until GitHub uses the
new one. With a webhook, `WLP_GITHUB_POLL_FALLBACK=1` keeps polling as a fallback at a slower pace: CI every
five minutes (ten while the user has more than ten items open) and an item's pull request every 30 minutes,
in place of every minute (three) and every ten minutes.

When webhooks are active, Windlass acknowledges ordinary deliveries from installations outside every
platform user's GitHub connection with HTTP 202 and `{"taken":false}`. It stores no delivery and skips
that installation during redelivery sweeps. The endpoint still accepts `installation` and
`installation_repositories` events so it can track changes to links.

Then, on the app's page: note the App ID and the Client ID, generate a client secret, and generate a private
key (a `.pem` file is downloaded).

Issues access lets the Factory file work items from GitHub issues and comment on them. Reading CI uses a token with read access to Checks, Commit statuses and Actions. Actions write access is used for eligible infrastructure reruns and to dispatch the combined integration workflow for a two-repository feature. Publishing `windlass/verified` uses a separate token with Checks write access for the item's repository. Each installation owner must approve a new permission before GitHub grants it. With read-only Checks, work items can read CI and hand over as usual. [Enable the Factory check on GitHub](github-and-repositories.md#enable-the-factory-check-on-github).

| Variable | Effect |
|---|---|
| `WLP_GITHUB_APP_ID` | the App ID, a number |
| `WLP_GITHUB_APP_SLUG` | the app's name as its address has it |
| `WLP_GITHUB_CLIENT_ID` | the Client ID (`Iv23...`) |
| `WLP_GITHUB_CLIENT_SECRET` | the client secret. A secret |
| `WLP_GITHUB_PRIVATE_KEY` | the private key. A secret. The file as it is, or with `\n` for its line breaks, or in base64 (`base64 -w0 <file>.pem`), which is the form for a secret store that takes one line |
| `WLP_GITHUB_API_URL`, `WLP_GITHUB_URL` | GitHub's API and GitHub itself (defaults `https://api.github.com`, `https://github.com`); for GitHub Enterprise Server (`https://<host>/api/v3`), and for the checks' stand-in |
| `WLP_GITHUB_WEBHOOK_SECRET`, `WLP_GITHUB_WEBHOOK_SECRET_PREVIOUS` | the webhook's secret, at least 32 characters, and the one before it while it is rotated. A secret |
| `WLP_GITHUB_POLL_FALLBACK` | `1`: poll as a fallback beside the webhook; requires `WLP_GITHUB_WEBHOOK_SECRET` |

All five of the first must be set, the same on every server. With some of them missing the feature is off and
the server says which (`[wlp] WARNING: GitHub is off: ...`). On a Rivet Cloud cluster the two secrets are
cluster secrets and the rest plain variables. A cluster's secret holds at most 1024 bytes and the key in base64
is over two thousand, so it goes in as pieces, `WLP_GITHUB_PRIVATE_KEY_1`, `_2`, ..., which the server puts
together in order:

```sh
rivet cluster secret set WLP_GITHUB_CLIENT_SECRET
base64 -w0 <file>.pem | fold -w 1000 | { n=1; while read -r piece; do
  printf %s "$piece" | rivet cluster secret set "WLP_GITHUB_PRIVATE_KEY_$n" --yes; n=$((n + 1)); done; }
rivet deploy ... --secret WLP_GITHUB_CLIENT_SECRET \
  --secret WLP_GITHUB_PRIVATE_KEY_1 --secret WLP_GITHUB_PRIVATE_KEY_2 --secret WLP_GITHUB_PRIVATE_KEY_3 \
  --env WLP_GITHUB_APP_ID=<id> --env WLP_GITHUB_APP_SLUG=<slug> --env WLP_GITHUB_CLIENT_ID=<client id>
```


## The bucket for agent memory

A machine's sessions need no bucket: their copies stay on the machine, in a volume of the runner's
([architecture.md](architecture.md#on-a-machine-the-copy-stays-on-the-machine)). `WLP_BACKUP_MAX_BYTES`
is their limit too.

Where sandboxes are E2B's, a bucket keeps a copy of each agent's Windlass session so a replaced sandbox can
go on with it ([architecture.md, "The agent's memory outlives its sandbox"](architecture.md#the-agents-memory-outlives-its-sandbox)).
Work items' screenshots are stored in the same bucket ([work-items.md](work-items.md#screenshots-on-work-items)).

The store is anything that speaks the S3 protocol; only presigned PUT and GET, HEAD and DELETE are used, so
changing the provider is changing the settings. For Cloudflare R2: a bucket of its own, and an API token
with "Object Read & Write" on that bucket only.

| Variable | Value |
|---|---|
| `WLP_BUCKET_ENDPOINT` | the store's S3 endpoint without the bucket: for R2, `https://<account id>.r2.cloudflarestorage.com` |
| `WLP_BUCKET_NAME` | the bucket |
| `WLP_BUCKET_ACCESS_KEY_ID`, `WLP_BUCKET_SECRET_ACCESS_KEY` | an access key that may read, write and delete objects in that bucket. The second is a secret |
| `WLP_BUCKET_REGION` | optional: the region the signatures name (default `auto`, which is R2's) |
| `WLP_BUCKET_STYLE` | optional: `path` (default) or `virtual`, where the bucket's name goes in an address |
| `WLP_BUCKET_PREFIX` | optional: put before every key, for a bucket that is shared |
| `WLP_BACKUP_MAX_BYTES` | optional: the largest archive that is kept (default 67108864) |

They are the same on every server. On a Rivet Cloud cluster the endpoint, the bucket's name and the two
halves of the access key are set as secrets (`rivet cluster secret set WLP_BUCKET_ENDPOINT`, and so on, with
a `--secret` for each on `rivet deploy`). With none of them set the feature is off; with only some, it is off
and the server says which are missing when it starts.

```sh
cd server && npx tsx ../scripts/backup-check.ts                     # the seam and the backups: no network, no Docker
cd server && npx tsx ../scripts/backup-check.ts --bucket --docker
                                                                    # a real bucket, and a real Windlass in local containers
cd server && E2B_API_KEY=e2b_... npx tsx ../scripts/e2b-backup-check.ts
                                                                    # two E2B sandboxes, one after the other, for under half a minute
```

The last two read the bucket's settings from the variables above, or from `R2_ENDPOINT`, `R2_BUCKET`,
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`; they write under a prefix of their own and remove it. Measured
from an E2B sandbox to R2, for a session of one turn (24 kB): a save takes 1.3 seconds, a restore one.
