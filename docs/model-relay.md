# Windlass's model relay

Windlass 0.7.1 routes ChatGPT and Settings-key models through the relay. For ChatGPT, the host starts
`windlass acp` with `WINDLASS_PROVIDER=chatgpt`, `WINDLASS_MODEL_BASE_URL` and a `WINDLASS_ACCESS_TOKEN_FILE`
that holds a placeholder, not a ChatGPT access token. A relay outside loopback also needs
`WINDLASS_MODEL_ALLOWED_ORIGIN` set to its exact origin. Windlass sends the file's bearer on
`GET <base>/models` and `POST <base>/responses`, refuses redirects, and reads the file again before
each request.

One mechanism pays for every plan-paid hosted turn: the turn pins a `CredentialRef` with `plan: true`, at its
generation, and a plan relay sends its requests with the plan's current token. Hosted Windlass on an unqualified
(ChatGPT) model pins `{ provider: "openai", plan: true }`, the ChatGPT plan, exactly as hosted Codex does
(`turnCredential` in `server/src/actors/agent-session.ts`). The plan is the user's ChatGPT sign-in, so its
generation is the sign-in's, and the daily ChatGPT allowance counts these turns (`usesPlatformModel`). `WLP_PLAN_USERS` gates it like every plan: a user it leaves out gets "Your ChatGPT
plan isn't enabled for hosted runs on this account" for a hosted Windlass turn on a ChatGPT model, while Settings-key
models and machines still work. Where the plan's requests go:

- **Hosted Docker**: the platform relay route, through the Docker relay's forwarding hop, as a Settings key; the
  route asks the user's actor for the plan's current access token at every request.
- **E2B and Daytona**: a relay inside the sandbox, run as another user than the agent's
  ([Plan requests from the sandbox](#plan-requests-from-the-sandbox)), handed the token at the turn's start and a
  fresh one before it expires.
- **A paired machine** (every runner the platform serves, 0.3.13 and later): the same relay program on the machine, in
  a container of its own, handed the token at the turn's start and a fresh one before it expires
  ([Plan requests from a machine](#plan-requests-from-a-machine)). There the ChatGPT plan is not behind
  `WLP_PLAN_USERS`: its requests leave from the user's machine.

A session's sandbox never holds the user's ChatGPT access token, hosted or on a machine. The token stays where the
session's processes cannot reach it: the platform server, the transport user's relay process inside a microVM, or the
plan relay's container on a machine. Commands, setup leftovers and approved MCP servers in the sandbox can still make
model requests through the relay while a turn runs. They cannot take a bearer elsewhere.

## Settings keys in Windlass

A qualified picker ID selects the owner’s saved key generation before a turn starts. The platform runs `windlass acp` with `WINDLASS_PROVIDER`, the provider selection that the CLI’s `--provider` passes to ACP. The ACP session receives the provider’s native model ID, including any OpenRouter vendor prefix. Windlass pins the provider when it creates the session.

| Provider | Variable holding the turn placeholder | Relay base suffix | Paths appended for catalog and generation |
| --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `/v1` | `/models`, `/responses` |
| Anthropic | `ANTHROPIC_API_KEY` | empty | `/v1/models`, `/v1/messages` |
| Google | `GEMINI_API_KEY` | empty | `/v1beta/models`, `/v1beta/models/<model>:streamGenerateContent?alt=sse` |
| OpenRouter | `OPENROUTER_API_KEY` | `/api/v1` | `/models`, `/chat/completions` |

E2B adds the suffix to the relay origin and `/model-relay`. Docker and paired machines add it to the loopback forwarder origin. Catalog pagination and automatic titles use the same lease. The platform checks the machine pairing and proof for forwarded requests. Only the platform relay resolves the saved key. Removing or replacing the key invalidates its generation. Stopping the turn revokes its lease. Hosted leases share the configured per-turn request cap across server processes.

Reported requests are receipted against the selected provider and key generation. The daily ChatGPT allowance applies to unprefixed models, also when the ChatGPT plan pays for them hosted. A missing Settings key, an unavailable key relay or a sandbox running Windlass before 0.7.1 refuses a key-backed turn; a ChatGPT plan turn needs Windlass 0.6.0, which reads the relay's address.

## Where the relay runs

| Place | Relay | How the sandbox reaches it | Base URL Windlass gets (ChatGPT) |
| --- | --- | --- | --- |
| Hosted Docker | One relay container per Docker daemon, `wlp-model-relay`, which forwards key and plan leases to the platform route on `WLP_MODEL_RELAY_URL` | A forwarder container in the session container's network namespace (`--network container:<session>`) listens on `127.0.0.1:17893`. It connects to the relay's Unix socket, writes the turn's 32-character nonce, then pipes the bytes. | `http://127.0.0.1:17893/v1` |
| A user's machine (runner) | Settings keys: one relay container per machine, `wlp-model-relay-<machine id>`, made by the runner, which forwards them to the platform route. A plan: a relay container per turn, `wlp-plan-relay-<sandbox>` | As hosted Docker, with the runner's helpers | `http://127.0.0.1:17893/v1` |
| Hosted E2B and Daytona | ChatGPT plan: a relay inside the sandbox (`sandbox/relay/plan.cjs`). Settings keys: the platform route on `WLP_MODEL_RELAY_URL`, a hostname of the relay's own | Loopback for the plan relay; it reaches `api.openai.com` itself. The route over the internet: in `restricted` and `none` E2B allows that hostname, and never the platform's public host | `http://127.0.0.1:<port>/v1` |

### Settings keys

Resolve the turn’s provider from the model and the owner’s current key generations.
A caller opens a key- or plan-backed turn with `openModelKeyRelay(sandbox, sessionId, { provider, generation, plan?, harness }, signal, takeRequest, openSecret)`
in `sandbox/token-file.ts`. Start the client with the returned base URL and placeholder in the provider's
usual credential header or as a Bearer token (Windlass on the ChatGPT plan: in its token file, `windlassPlanEnv` and
`writePlanPlaceholder`). Close the lease when the turn ends. Opening fails if the sandbox has no relay for it.

The platform lease holds the harness, provider and generation saved by the user actor. For each admitted
request the platform relay calls `internalCredential` as `model-key/<uid>` with a fresh nonce,
opens the 60-second transit blob, and checks the generation before sending the request.
Removing or replacing the key blocks the next request on every lease of the old generation.

The paths below are relative to `/model-relay` on the platform and the loopback origin on Docker.
The client base ends in `/v1` for OpenAI and `/api/v1` for OpenRouter. Anthropic and Gemini use
the relay root and append their own API version.

| Lease | GET | POST | Upstream credential |
| --- | --- | --- | --- |
| OpenAI | `/v1/models` | `/v1/responses`, `/v1/chat/completions` | Bearer at `api.openai.com` |
| Anthropic | `/v1/models` | `/v1/messages` | `x-api-key` at `api.anthropic.com`, version `2023-06-01` |
| Claude plan | `/v1/models` | `/v1/messages` | Bearer (the `claude setup-token` token) at `api.anthropic.com`, version `2023-06-01`, Claude Code only |
| ChatGPT plan | Codex: `/v1/models?client_version=…` (its own catalog request). Windlass: `/v1/models` | `/v1/responses` | Bearer (the plan's current access token) at `api.openai.com`, Codex and Windlass only |
| Google | `/v1beta/models` | `/v1beta/models/{model}:generateContent`, `:streamGenerateContent` | `x-goog-api-key` at `generativelanguage.googleapis.com` |
| OpenRouter | `/api/v1/models` | `/api/v1/chat/completions` | Bearer at `openrouter.ai` |

Gemini streaming accepts `?alt=sse`. Anthropic Messages accepts the `interleaved-thinking-2025-05-14`
beta. A Claude plan lease uses its own wire, `claude-plan` (`credentialWire` in `sandbox/relay/wires.cjs`):
Claude Code sends its placeholder from `CLAUDE_CODE_OAUTH_TOKEN` as a bearer, and the route sends the plan's
token as a bearer with the `oauth-2025-04-20` beta allowed. Hosted Docker forwards it with `provider: "claude-plan"`.
A ChatGPT plan lease uses the `chatgpt-plan` wire: `GET /v1/models` and `POST /v1/responses` with a short list of
passed headers, and Codex's compressed bodies allowed. Codex sends its placeholder as a bearer, Windlass from its token file; the route asks the
user's actor for the plan's current access token at every request (`ChatgptPlan.token`,
`server/src/actors/user/signin.ts`), so a token the sign-in holder refreshed is the next request's. Each agent gets
only its own routes (`harnessMethod` in `sandbox/relay/wires.cjs`): Windlass `GET /v1/models` and `POST /v1/responses`;
Codex `POST /v1/responses` and its catalog request with `client_version`. codex-acp's bare `GET /v1/models` is
refused for Codex: it narrows its list by a `data[]` that ChatGPT's catalog (`models[]`) may not have, and a refusal
leaves Codex's list as it is. On E2B and Daytona a plan's requests do not go through the route: they leave from the
sandbox ([Plan requests from the sandbox](#plan-requests-from-the-sandbox)), and on a machine from the machine
([Plan requests from a machine](#plan-requests-from-a-machine)): a runner refuses a forwarded plan lease. Each route selects its upstream and permitted
headers from the lease. Caller-supplied OpenRouter attribution, credentials in query strings, and redirects are refused.

Hosted Docker and paired machines forward key-backed requests to `WLP_MODEL_RELAY_URL`, which must
be configured and reachable from the relay container. The container holds a second placeholder for
the platform lease in its private tmpfs. Its sandbox gets only the local placeholder tied to the forwarder.
A paired machine signs each forwarded request with a per-turn key delivered over its session connection.
The platform verifies the signature for that machine and path. The forwarding lease expires one minute
after the turn timeout. The runner never receives the provider key.

The Docker relay is the program `sandbox/relay/windlass.cjs`, on the shared `createRelay` of
`sandbox/relay/server.cjs`, the same one the Claude Code, Codex and OpenCode relays of machines use. It
runs from the pinned base image as `agent`, read-only, with every capability dropped, rotated Docker logs on machines,
192 MiB (`RELAY_MEMORY`) and 48 processes. The Docker check runs 64 streams at once through it, each with a
1 MiB request body and a 2 MiB answer, and fails if the relay comes near that memory. Its only network is the Docker bridge, which reaches
the platform relay: every lease it holds is forwarded (Settings keys, and hosted Docker's plans too). The forwarder is `wlp-model-forward` in `runner/src/egress-proxy.mjs`, beside
the machine's other forwarders. Only the relay and the forwarders mount the socket volume
(`wlp-model-socket[-<machine id>]`), and the forwarders mount it read-only.

One hosted server per Docker daemon. The relay container, its socket volume and the forwarders
(`wlp-model-fwd-<sandbox>`) are named per daemon, not per deployment, and a starting server removes every
hosted forwarder it does not hold a lease for, with the relay's token files. A second platform server on
the same daemon (a test server beside a live one) would remove the first one's forwarders and share its
relay, cutting its turns' model requests. Give each server its own Docker daemon, or run the second with
`WLP_MODEL_RELAY=off` or on the fake layer. Runner relays are per machine and are not affected.

E2B's microVMs reach the platform only over the internet, so there is no namespace to put a forwarder
in, and the Settings-key relay is a route of the server, which opens the key per request. A plan's requests leave
from the microVM itself instead.

The route has a hostname of its own, `WLP_MODEL_RELAY_URL` (for example
`https://windlass-relay.example.com`), routed to the same server as `WLP_PUBLIC_URL`. When a request's
`Host` is that name, the server answers the relay's model routes and refuses everything else with a 404. No
other host serves the relay's paths. So E2B's allow list opens only the relay to a sandbox, and not the
web app, the API or the runner routes. Without `WLP_MODEL_RELAY_URL`, E2B offers no Settings keys (the server says
so once at startup), and the platform's public host is never allowed in its place. Hosted Docker needs it for plans
too: its relay forwards a ChatGPT or Claude plan lease to the route.

The operator routes the name to the server. With the self-hosted Cloudflare Tunnel, add an ingress rule
for the hostname before the final `http_status:404` rule, pointing at the same loopback port as the web
app's hostname, and route the DNS name to the tunnel ([deploy/selfhost/README.md](../deploy/selfhost/README.md#the-model-relays-hostname)).
Elsewhere, point a DNS name at whatever serves `WLP_PUBLIC_URL`, with a certificate for it, and keep the
`Host` header as the client sent it.

### Plan requests from the sandbox

Through the route, every user's plan requests would reach the provider from the platform server's one address.
E2B and Daytona sandboxes have addresses of their own, so there a plan turn (Claude Code, Codex, or Windlass on
the ChatGPT plan) runs the relay inside the sandbox (`server/src/sandbox/plan-relay.ts`, the program
`sandbox/relay/plan.cjs` on the shared `createRelay` and the plan's wire, `claude-plan` or `chatgpt-plan`). Hosted
Docker sandboxes share the server's address and keep the route.

- **Who runs it.** The transport user (`nobody`, the user Git transport and its GitHub tokens run as), never
  `agent`. The agent has no sudo, so it cannot read that process's memory, standard input or `/proc` files, nor
  signal it. Node is `/usr/local/bin/node` of the image; no template rebuild is needed.
- **What it gets.** At the turn's start the session opens the plan's token through the user actor
  (`internalCredential`, `openSavedCredential` in `server/src/credentials/transit.ts`) and checks the turn's pinned
  generation. The relay's source and then `{token, placeholder, expiresAt, wire, harness}` go to its standard
  input, one JSON line each. Nothing is written to the sandbox's disk and nothing secret is on a command line or in an
  environment. Stdin stays open as the control channel: a later `{token, expiresAt?}` replaces the token (requests
  that start after it carry the new one, running ones keep theirs; a later `expiresAt` moves the relay's end on), and
  the relay asks the platform to count each request against the turn's limit (`{take}`/`{took}`). Stdin closing ends it.
- **A ChatGPT plan's token expires.** The turn hands the relay a fresh one before it does
  ([Refresh and rotation](#refresh-and-rotation)).
- **The plan is looked at every minute** (`PLAN_CHECK_MS`, `rotatePlanToken`), a Claude setup token's too though it
  never expires. A plan reconnected or removed meanwhile, or `WLP_PLAN_USERS` turned off for its user, gives no token:
  the turn closes the relay (`[wlp] plan_token.gone`), so its requests stop.
- **What it accepts.** It listens on `127.0.0.1` on a port the kernel picks. It accepts only
  `Authorization: Bearer <placeholder>`, a fresh `wlp-plan.` placeholder for each turn, and only the turn's agent's
  routes on the plan's wire with that wire's headers (and betas). It sends them to the wire's host
  (`https://api.anthropic.com`, `https://api.openai.com`) with the real bearer and removes every token it was handed
  from every answer. On a Claude plan it answers `HEAD /api/hello` itself. An upstream error,
  a 401 included, keeps its status with the provider's scrubbed error code, type and message. Claude Code gets
  `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` and `CLAUDE_CODE_OAUTH_TOKEN=<placeholder>`; Codex gets `WLP_CODEX_BASE_URL=http://127.0.0.1:<port>/v1`
  and `WLP_SESSION_BEARER=<placeholder>`; Windlass gets `WINDLASS_MODEL_BASE_URL=http://127.0.0.1:<port>/v1`, the
  origin as `WINDLASS_MODEL_ALLOWED_ORIGIN`, and its token file with the placeholder ([The placeholder](#the-placeholder)).
  The base is the wire's (`/v1` for a ChatGPT plan, none for a Claude plan). The placeholder is redacted from the
  turn like a key lease's.
- **Lifetime.** The relay starts with the turn and is stopped (stdin closed, then its process group killed) when
  the turn ends or is aborted, so a paused or snapshotted sandbox keeps no token. If it cannot start or listen,
  the turn fails; the token is never put in the sandbox instead. A relay whose server died mid-turn stops itself
  at the turn's limit plus a minute, by the wall clock.
- **Revocation.** The route checks the plan's generation at every request. This relay is checked at the turn's start
  and then every minute: a reconnected or removed plan, or `WLP_PLAN_USERS` turned off, closes it within a minute.
- **E2B network.** Out of `open`, a Claude Code sandbox (its `wlp_harness` metadata) may also reach
  `api.anthropic.com`, and a Codex or Windlass sandbox (no `wlp_harness`) `api.openai.com`, at create and at every
  connect (`withPlanHosts` in `server/src/sandbox/e2b/network.ts`, `planProviders` in
  `server/src/sandbox/harnesses.ts`), whether or not its owner has a plan. OpenCode's sandboxes may not. The relay's
  host stays allowed: Settings keys still use the route. Daytona runs open only.

Anything that can run as the transport user can read the token while a turn runs, as it can a GitHub token
during a push. On E2B that rests on the agent having no sudo and on envd's API not running commands for
processes inside the sandbox; on Daytona, on the launcher's sudo rule and the toolbox not being reachable by
the agent.

### Plan requests from a machine

Every runner the platform serves (0.3.13 and later, `MIN_RUNNER_VERSION`) runs a plan-paid turn's relay on the
machine, so the plan's requests leave from there.
It is the same program as in a microVM, `sandbox/relay/plan.cjs`, with the same control channel.

- **Where it runs.** A container of its own per turn, `wlp-plan-relay-<sandbox>`, from the pinned base image, as
  uid 1000, read-only, every capability dropped, 160 MiB, 32 processes, no logs, on the Docker bridge, with the
  machine's model socket volume (`openPlan` in `server/src/sandbox/model-relay.ts`). It listens on a socket of its own
  there, `plan-<nonce>.sock`. The turn's forwarder (`wlp-model-forward <nonce> plan-<nonce>.sock`) listens on
  `127.0.0.1:17893` in the session's network namespace, as Windlass's does, and writes the turn's nonce first. It
  works the same for Windlass, Claude Code and Codex sandboxes, in every egress mode: the relay, not the session,
  reaches the provider.
- **What it gets.** The session opens the token at the turn's start (`openSavedCredential`), checks the pinned
  generation and sends it in the `planRelay` operation (`server/src/runner/protocol.ts`), a frame that is never
  journalled (`carriesSecret`). The runner starts the container with `docker run -i --rm` and writes the relay's
  sources and the token to its standard input, which the runner holds. Nothing is written to a file or a volume, and
  nothing secret is on a command line or in an environment. `planRelayToken` replaces the token on the turn's
  rotation schedule (`rotatePlanToken`), as for a microVM, and moves the relay's end to the turn's limit plus a minute
  from then. The plan is looked at every minute, and a plan that is gone closes the relay, as for a microVM.
- **What the agent gets.** Windlass: `WINDLASS_MODEL_BASE_URL=http://127.0.0.1:17893/v1` and its token file with the
  placeholder. Claude Code: `ANTHROPIC_BASE_URL=http://127.0.0.1:17893` and `CLAUDE_CODE_OAUTH_TOKEN=<placeholder>`.
  Codex: `WLP_CODEX_BASE_URL=http://127.0.0.1:17893/v1` and `WLP_SESSION_BEARER=<placeholder>`
  (`planEnv` in `runner/src/machine-harnesses.ts`). No key is used for that turn.
- **Lifetime.** `modelRelayClose`, the sandbox's suspend or removal, or the conversation's end close its standard
  input, and the container is removed with its forwarder. A server's restart is not its end: with durable machine
  turns (`WLP_RUNNER_DURABLE_TURNS`) the runner keeps the relay with the conversation through the grace, the turn's
  checkpoint names its lease (no credential), and the restarted server takes it up (`TurnSandbox.resumePlanRelay`),
  opens the plan's current token and hands it over `planRelayToken` before the turn goes on (which gives the relay
  the taken-up turn's new window), then keeps rotating it. A plan reconnected or removed meanwhile closes the relay
  and fails the turn.
  A conversation the runner gives up on ends the relay with it. A runner that stops takes the relay's input with it, so the
  relay ends. A relay stops itself at the turn's limit plus a minute from its last token. At its first welcome the runner removes every
  plan relay container and forwarder a runner that died left, and stale sockets.
- **Health.** The relay's `{seen}` lines are kept by the runner (the latest 32) and taken by the session every 15 s
  and at the end (`planRelaySeen`), then told to the user's actor as a microVM relay's are.
- **Request counting.** The relay on a machine counts the turn's requests itself against
  `WLP_MODEL_RELAY_TURN_REQUESTS` (the `planRelay` operation's `requestLimit`), as a microVM's relay does without the
  platform counting for it, and answers 429 past it. The count lives with the relay, so a taken-up turn keeps it.

Who pays on a machine: Windlass's unqualified models pin the ChatGPT plan (`machineChatgptPlan` in
`server/src/actors/agent-session.ts`); Claude Code and Codex follow Pay with as hosted turns do (`machinePaysWith`,
`internalTurnPayer` with `machine`), unless Claude Code's own login is kept on the machine
(`windlass-runner login claude`), which then wins. Codex has no login of its own on a machine. A Claude plan stays
behind `WLP_PLAN_USERS` on machines; the ChatGPT plan does not (`planAllowed` in `server/src/credentials/plans.ts`).

### Plan health

Both relays tell the user's actor what the provider said of a plan's answers, so that Pay with and the
Connections page know whether the plan is usable, at its limit, or no longer accepted (`server/src/credentials/plan-health.ts`).

- **What is told.** The upstream status, the rate-limit headers as `limitHeaders` passes them on (numbers and
  status words: `anthropic-ratelimit-*`, `x-codex-*`, `retry-after`), and from an error body only its `error.code`
  (or `error.type`) and, for ChatGPT's `usage_limit_reached`, its reset. Every error is told; a success at most every
  15 seconds per user and plan. Nothing that names an account or a request, and never a token: a code holding one is
  dropped.
- **Who tells.** The route calls `internalObservePlan` for a plan lease (`observePlanAnswer` in
  `server/src/model-relay-route.ts`). The relay in a sandbox writes `{seen: {...}}` on its control channel
  (`provider.observe` in `sandbox/relay/server.cjs`, `plan.cjs`); the session passes it to the same action
  (`onSeen` of the turn's `modelKey`). A turn's own reports count too: Claude Code's rate-limit events, a usage-limit
  refusal and a success, which reach the plan through `internalObserveUsage` with the plan's account location.
- **What it means.** A 200 makes the plan `ok`. A 429 with a rejected unified status, or ChatGPT's usage-limit
  codes, makes it `limited` until the reset the headers or body name; `subscription_sharing_usage_limit_exceeded`
  names none, and none is inferred: the plan is probed again after 15 minutes, doubling up to 5 hours. A 429 that asks
  for a retry in under a minute is a burst the agent retries itself. Two provider 401s in a row make it `invalid`
  (the relay's own `relay_lease_ended` 401 does not count) until it is connected again. The 5-hour and weekly windows
  (% used, reset) are kept as last seen, for Connections. Item budgets never use them: a window is the whole account's.
- **Where it is kept.** On the plan's `model_plan` row (`health`, JSON), only while the plan is at the generation the
  answer was for; a new connection starts healthy. A plan's limit is its own account (`plan/<provider>/<generation>`
  in `server/src/actors/provider-accounts.ts`), apart from the key of the same provider: a limited key does not
  hold plan-paid turns, nor the other way round. Windlass's ChatGPT models count against the ChatGPT plan wherever
  they run (`accountLocation`).
- **What uses it.** Pay with at a turn's start (`server/src/pay-with.ts` `decidePayer`, `server/src/actors/user-payer.ts`):
  a limited plan waits, pays with the key, or asks, by the rule; an invalid one falls back to the key where the rule
  allows, or asks the user to reconnect. Hosted Windlass's ChatGPT models follow the defaults by origin (an item waits,
  a person is asked), and "use my key" runs one turn on the OpenAI key's `openai/<model>` where the key offers it. At most `WLP_PLAN_PARALLEL_TURNS` (3) turns of a plan agent run on one plan at once
  (Windlass's are not counted); past it a turn waits as at a limit. An item filed by an unlinked account from another surface (`ItemFiler.verified`) never
  pays with the owner's plan. A Claude Code refusal names no reset, so an item's wait takes the plan's reset as the
  relay read it.

## The placeholder

Each turn gets a lease of its own when it starts, and the lease ends when the turn ends.

- **Windlass on the ChatGPT plan, hosted or on a machine.** The turn writes its token file (`turnTokenFilePath`: Docker's private
  `/dev/shm`, Windlass's data directory on a microVM) with `writePlanPlaceholder` in `server/src/sandbox/token-file.ts`:
  `{"accessToken": "<placeholder>", "expiresAt": <ms>}`, the form of a handed-in token, mode 0600, the content on
  standard input. The expiry is the turn's longest run plus 15 minutes (`WLP_TURN_TIMEOUT_MS` + 15 min), not the
  token's hour: Windlass checks it before sending, and the relay ends the placeholder with the turn whatever the file
  says. The placeholder is the plan relay's: `wlp-model.<secret>` of the turn's forwarder on hosted Docker, or a
  fresh `wlp-plan.<secret>` that only the turn's own plan relay takes on E2B, Daytona and machines. The file is removed when
  the turn ends, with the turn's other files.
- **Docker and machines.** The forwarder's lease is a random 32-character nonce and a random 32-character secret.
  The placeholder in the sandbox is `wlp-model.<secret>`. The nonce is a forwarder argument,
  outside every mount namespace the session has. The relay accepts a request only when its connection
  came through that turn's forwarder (the nonce) and its bearer is that turn's placeholder. Another
  session's placeholder is refused on this session's connection, and a placeholder taken out of the
  container is of no use without the forwarder. When the turn ends, the relay forgets the lease and the
  forwarder is removed. The forwarder writes that it holds `127.0.0.1:17893` into a tmpfs of its own,
  which the session cannot reach. If a process of the session took that port first, the forwarder exits.
  The turn then fails with "the model relay's forwarder ... a process in the sandbox may be holding that
  port", and nothing is handed to it. The relay holds a second, platform placeholder for the lease and forwards to
  the route; on a machine each forwarded request also carries the machine's proof.
- **The platform route (E2B Settings keys, and every lease hosted Docker or a machine forwards).** The placeholder
  is signed by the server (`signatures.ts`, purpose `model-relay`). It names the user, the session and the turn's
  nonce. Its signature counts for the longest turn (plus a minute for a forwarded one), and the lease itself ends
  with the turn, before the signature does. The lease holds the turn's credential reference, never a secret. The
  route checks the signature and the expiry, then asks the turn's live lease for that reference. This is a lookup in
  the server's process, or in the session's actor (`internalModelRelay`) when another server process took the
  request. It then opens the secret for that one request (`internalCredential`, sealed for the request's nonce for a
  minute) at the pinned generation. A lease that ended (the turn is over) is refused, whatever its signature says. Its
  nonce is then remembered as ended until the signature expires, so a placeholder of a finished turn that keeps being
  sent costs no actor call. An E2B key placeholder works from anywhere on the internet while the turn runs, but only
  for model requests at this relay, under the caps below.

On the ChatGPT plan a `handed_in_rejected` is the provider turning the plan's token down (`auth_required`), and the
relay's own refusal is `token_unavailable` as everywhere (below).

## Refresh and rotation

Only the user's actor ever refreshes the ChatGPT sign-in, and no relay holds a refresh token. The holder answers the
access token it keeps while it has more than 20 minutes left, else refreshes once for everyone asking.

- **Hosted Docker (the route).** A plan lease holds no token: the route asks the user's actor at every request, so a
  refreshed token is the next request's, on the same lease.
- **E2B and Daytona (the relay in the sandbox).** The token opened at the turn's start has at least 20 minutes left;
  when it has 10 left the turn asks for the current one and hands it to the relay on its standard input
  (`rotatePlanToken` in `server/src/sandbox/token-file.ts`). A failed try is tried again every 20 s. Requests that
  start after it carry the new token. The refresh token never leaves the user's actor.
- **Machines.** As E2B and Daytona: the plan relay on the machine is handed the current token over its standard
  input (`planRelayToken`). No machine refreshes a ChatGPT sign-in, and none holds a refresh token.

### When the lease ends

`close` ends the turn's requests still running, on every relay, not only the next ones:

- On Docker and machines, `close` removes the turn's file in the relay first, then the forwarder. The relay looks at
  the leases of its running requests when its token directory changes and once a second, and stops every
  request of a lease whose file is gone or whose token has expired.
- At the route, `close` aborts the lease's requests in the process that holds it. A request that another server
  process carries is looked at every 5 seconds and aborted once the session's actor says the lease is gone.
- A relay in a microVM is stopped: its standard input closed, then its process group killed.

A request that waited for a slot while its turn ended is answered 401 when its turn's lease is looked up
again. It is never sent with the credential it was first looked up with.

### What a stopped process leaves

A lease is held by the process that opened it. When the hosted server starts, and when a runner gets its
first welcome, it removes every forwarder of its scope (labelled `windlass-platform.model-relay=forward`)
and every file in its relay's token store, because none of their leases can still be live. This assumes
one server process per Docker daemon, as hosted Docker has (`WLP_ALLOW_DOCKER_HOSTED`), and one runner
per machine. The relay itself deletes, once a minute, every file whose `expiresAt` has passed or that is
no record. On the hosted server and on a runner, suspending or removing a sandbox ends its lease too: its
file in the relay, its forwarder, and on a runner the conversation's `relays` entry. A relay in a microVM stops
itself at the turn's limit plus a minute, by the wall clock.

## Limits

They are the relay caps of machines (`sandbox/relay/server.cjs` `limits`): 8 requests in flight and 32
waiting per session (turn), and the relay's whole in-flight ceiling, with a FIFO wait of up to 90 seconds
before a 503 with `retry-after`. A session's connections past 32 are refused. The ceiling for the whole
relay is 24 on a machine, which serves one user. A hosted relay serves every user of the deployment, so
it uses `WLP_MODEL_RELAY_REQUESTS` (default 64), and 16 in flight per user (`HOSTED_RELAY_USER_REQUESTS`,
counted by the user each turn's file names). The platform route applies the same per-turn numbers, the same
deployment ceiling and 16 in flight per user. Key-backed turns on every backend, and plan-backed turns on hosted
Docker, go through this route, so the platform's 16 in-flight requests per user is the effective per-user limit
there. A relay in a microVM serves one turn: 8 in flight and 32 waiting. Every key- or plan-backed hosted turn also
counts its requests against `WLP_MODEL_RELAY_TURN_REQUESTS` (300 by default), shared across server processes. The
route also has:

- 300 requests a minute per user, after a burst of 100, counted from the placeholder's signed user before
  any lookup. Past it the answer is a 503 with `retry-after`.
- request bodies counted as they are read, with a 413 past 32 MiB, and 256 MiB of request bodies in
  flight across all requests. Past that, a 503 with `retry-after`. The body is then sent upstream whole,
  with its `content-length`, the way Windlass sends it to `api.openai.com` itself. The server's HTTP
  listener (RivetKit's) already holds the whole body before the route runs, so streaming it on saved no
  memory. The request goes out with `node:https`, not fetch, carrying only Windlass's own headers
  (`content-type`, `accept`, `session-id`, `user-agent`, and its `accept-encoding` of gzip, deflate, br and
  zstd, which the route decodes itself), so it has none of fetch's `sec-fetch-mode` or `accept-language`.
  A 200 to `POST /responses` with no content type, or `text/plain`, is passed on as an event stream,
  because Windlass reads that answer as one whatever its type says. Any other type is a 502.

  The server logs failed status codes, elapsed time and fixed upstream diagnostics. The log limit is
  60 lines a minute. Provider text, request IDs and user-supplied paths stay out of diagnostics.

The route's limits are those of one server process. A deployment of several processes has each limit
once per process, so its real ceilings are that many times higher. The per-user limits bound how many
requests a user has in flight, not what they spend: a user's turns can still use the plan's whole quota
through the relay while they run.

On the `chatgpt-plan` wire a redirect is a 502 and every token the relay has used is removed from the response
stream. An error reply keeps the provider's `error.code`, `error.type` and a scrubbed, shortened message, so Windlass
still tells a usage limit, a rate limit and a context overflow apart.

The relay's own 401s (no live lease for the placeholder) carry `error.code: "relay_lease_ended"`.
Windlass reports any 401 of a handed-in token as `handed_in_rejected`, with the provider's code in its
message. The platform maps a `relay_lease_ended` there to `token_unavailable` ("send the prompt again",
`handoff.ts` `relayRefused`). The user is not told to sign in again for a refusal that is the relay's.

## Rollout, and what happens when the relay is unavailable

| Where | Windlass on ChatGPT | Without it |
| --- | --- | --- |
| Hosted Docker | the ChatGPT plan through the platform route: `WLP_MODEL_RELAY` is not `off`, `WLP_MODEL_RELAY_URL` is set and reachable from the relay container, and the image's Windlass, as `windlass.problem()` reads it, is 0.6.0 or later | the turn is refused; the server says at startup what is missing |
| Hosted E2B and Daytona | the ChatGPT plan through a relay in the sandbox, whatever the route's settings; the template's Windlass must be 0.6.0 or later (asked at each turn) | the turn is refused |
| Machines | the ChatGPT plan through a plan relay on the machine (every runner from 0.3.13 on; an older one is refused with "Update your runner to 0.3.13 or later"). ChatGPT requires Windlass 0.6.0 or later. Settings keys require Windlass 0.7.1, which the runner says with `modelRelay` in its report and its `connect` answer. | the turn is refused |

Everywhere hosted, the plan needs `WLP_PLAN_USERS` to name the user (or `*`). Windlass 0.7.x sessions cannot be opened by 0.6.0. While the route is on for E2B, the
deployment's allow list names the relay's host; a Windlass, Codex or Claude Code sandbox adds its plan's API host
for its own relay, which alone holds a token that host would take.

Each profile says per sandbox which applies. A profile with the relay has `modelRelay: true`, and its
summary is written from both flags. `commandsCanReadAccessToken` keeps its meaning, "can read the token
file". With the relay that file holds only a placeholder, and the summary says: "Commands can read only a
placeholder for this turn. With it they can make model requests on your ChatGPT plan through the relay
while the turn runs (8 at once, 32 waiting). The access token never enters the container" (or microVM).

**Fail closed.** Once a turn is to use the relay, it never falls back to handing the real token to the
sandbox. If the relay cannot be started or reached, or it refuses the token, the turn fails, and nothing is
written into the sandbox. No sandbox is ever handed an access token. A quiet fallback would make what the side panel
say depend on a race, and a failed turn can be tried again.

Turns that are already running keep the mode they started with.

To roll out 0.7.1, rebuild the Docker image with `sandbox/build.sh` and publish the sandbox and runner images through the image release workflow. The runner bundles its local relay. Build each deployed Windlass template with `sandbox/e2b/build.sh` and its matching `WLP_E2B_SIZE` and `WLP_SANDBOX_VARIANT`. Point the servers at the new templates and set `WLP_E2B_WINDLASS_VERSION=0.7.1`.

## Checks

- `scripts/windlass-key-docker-check.ts` runs the released ACP binary against four fake providers on an isolated loopback network. It checks model listing, generation, key refusal and the live sandbox environment and files.

- `scripts/windlass-relay-check.mjs` (in `pnpm test`): the Docker relay program (a machine's, and hosted Docker's
  forwarding hop) with a recording upstream.
  It covers bearer replacement, another session's placeholder on this connection, an ended lease, caps and waiting, the ceiling per user, error codes kept, the relay's
  own `relay_lease_ended`, a lease's end stopping its running requests, expired files deleted, tokens
  removed from responses, and only the two routes.
- `scripts/plan-relay-check.ts` (CI heavy `rules`): the in-sandbox plan relay as a local process with a recording
  upstream: bearer swapped, another placeholder, host or route refused, `HEAD /api/hello` answered locally, the
  token scrubbed from streams and error bodies, a 401 kept, a replaced token used next, the turn's request limit,
  close, abort and expiry, no start without a token on stdin, and Windlass on the ChatGPT plan: its two routes at the
  `/v1` base and a token rotated by `rotatePlanToken`; and a machine's relay on its own socket behind the turn's
  forwarder, which writes its nonce first. `scripts/runner-control-check.ts` covers the minimum runner's refusal, and
  `scripts/pay-with-check.ts` and `scripts/model-plans-check.ts` who pays on a machine. `scripts/e2b-provider-test.ts` ("a plan's relay in the
  sandbox", Windlass's included, with its placeholder file) and `scripts/daytona-provider-test.ts` cover how each
  provider starts and stops it, that a microVM refuses a token file, and the E2B allow list.
- `scripts/model-relay-route-check.ts` (CI heavy `rules`): the platform route with hosted Windlass's ChatGPT plan
  lease (its env, the placeholder swapped for the plan's current token, a refreshed token used next, only its two
  routes) and Settings keys, with signed, expired, forged and ended leases, caps, a queued request whose turn ended,
  bodies sent whole and capped, the rate per user, ended leases remembered, `close` aborting running requests here
  and in another process, the relay's own hostname, the version gates, the E2B network with the relay's host and a
  Windlass sandbox's plan host, an E2B sandbox with no session, a microVM refusing a token file, and the mapping of
  the relay's refusals.
- `scripts/model-plans-check.ts` ("plan health"): Anthropic's and Codex's headers, ChatGPT's 429 codes with their
  backoff, two 401s making a plan invalid, health kept per generation and a plan's account apart from its key's.
  `scripts/pay-with-check.ts`: Pay with applied for each rule, health, origin and key, the parallel-turn cap, the
  unverified filer, and the user actor's count of a plan's turns. `scripts/plan-relay-check.ts` and the route check's
  `--plan-wire` cover what each relay tells.
- `scripts/model-plans-check.ts`: hosted Windlass pins the ChatGPT plan, `WLP_PLAN_USERS` refuses it with its
  sentence, a prefixed `openai/…` model still takes the key, and a turn paused before pins the plan on resume.
- `scripts/model-relay-e2b-check.ts` (by hand: it needs an E2B key and a real access token): one real
  model request of hosted Windlass on the ChatGPT plan from an E2B sandbox, through the relay inside it, to
  `api.openai.com`. It starts the server in its own process on ports and storage of its own, behind a Cloudflare
  quick tunnel (the route Settings keys use), makes one sandbox under `restricted`, and runs one real turn through
  the platform's turn code: "Reply with exactly: relay ok". It checks the answer, that nothing of it went through the
  server's route, that the relay logged no failure, and that the token is nowhere in the sandbox. Nothing in CI makes
  a real model request, so run it after changing the plan relay.
- `scripts/model-relay-docker-check.ts` (CI heavy `sandbox-docker`): the Docker relay with real
  containers and forwarded leases, as hosted Docker and a runner open them. It scans a hardened session container's
  files, `/proc/*/environ` and `/dev/shm`, and a process left over from setup: no credential is in the container. It
  also runs `windlass --models` through the relay, applies the caps, and shows that the forwarder is gone after the turn. It
  also stops a streaming request at the turn's end, fails a turn whose port a session process holds,
  removes what a stopped server left, and runs the 64-stream memory test.

## Hosted ACP agents

Claude Code uses Anthropic. Codex can list OpenAI models and call Responses. On a ChatGPT plan (where
`WLP_PLAN_USERS` allows; the plan pays before an OpenAI key) Codex gets the same environment as on a key:
`wlp-codex-acp` hands codex-acp a custom provider (`providers/set`: base URL `WLP_CODEX_BASE_URL`, the placeholder
`WLP_SESSION_BEARER` as its bearer, `wire_api = "responses"`), and no `auth.json` is written; `wlp-codex-app-server`
refuses to start Codex if one is in `CODEX_HOME`. Its models are the plan's, from ChatGPT's catalog. OpenCode receives only the provider for its selected model. Before OpenCode has reported a catalog, its default uses the first saved provider in this order: OpenAI, Anthropic, Google, OpenRouter. The adapter chooses a model from that provider. Each turn pins one key generation before provisioning. Reported tokens are attributed to that provider. Cancellation revokes the platform lease immediately, including while the Docker forwarder is starting.

On hosted Docker the guest receives a local bearer. A separate forwarder listens on loopback in that container’s network namespace and prefixes its connections to the relay socket with the turn’s nonce. The relay matches both nonce and bearer. A different container’s forwarder supplies a different nonce. Only the relay and the forwarders mount the socket volume. The platform placeholder stays in the relay’s private tmpfs.

On E2B, with a Settings key, the guest receives the platform placeholder directly (on a plan it gets the placeholder of the relay inside its microVM, good only on that loopback port). Anyone who copies a platform placeholder can use it from outside the microVM and spend the owner’s quota until the turn ends. The lease is bound to the owner, session, turn, one provider generation and the harness’s allowed routes. Its signature expires after at most the configured turn timeout. The session’s lease owner enforces a shared per-turn cap of 300 requests by default (`WLP_MODEL_RELAY_TURN_REQUESTS`), including requests received by another platform process. Each accepted request can still consume provider tokens.

Set `WLP_MODEL_RELAY_URL` to the dedicated relay hostname. E2B also requires `WLP_E2B_OPEN_PROFILE=1` and the template’s Windlass version as described above. Agent commands run directly as the guest’s non-root user.

Build one image per agent from the normal base sandbox image. Hosted Docker defaults to the local tags produced by these commands. Set `WLP_CLAUDE_IMAGE`, `WLP_CODEX_IMAGE` or `WLP_OPENCODE_IMAGE` to use a preloaded image by digest.

```sh
sandbox/build.sh
for agent in claude codex opencode; do
  sandbox/harness/build.sh "$agent"
done
```

Approximate local disk sizes reported by `docker image ls` for cached arm64 images are 1.48 GB for the shared base, 2.12 GB each for Claude Code and Codex, and 1.77 GB for OpenCode. The additions are about 640, 640 and 290 MB respectively. Docker shares the base layers. E2B uses amd64 and its snapshot sizes may differ.

For E2B, publish the corresponding amd64 harness image through the normal image release. Point the builder at its immutable registry reference. For example, with `CLAUDE_IMAGE_DIGEST` set to that image's full reference, inspect the small template locally:

```sh
WLP_E2B_HARNESS=claude WLP_E2B_HARNESS_IMAGE="$CLAUDE_IMAGE_DIGEST" sandbox/e2b/build.sh --print
```

To build, set `E2B_API_KEY` and omit `--print`. Repeat for codex and opencode and for each offered `WLP_E2B_SIZE`. Templates use that size's configured base template name with `-claude`, `-codex` or `-opencode` appended. ACP sessions use these templates directly and skip Windlass setup snapshots.
