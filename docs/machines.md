# Machines of your own

How a user's own machine runs sessions: pairing, the runner, the link between them, and what each side can
and cannot do. Users' instructions are in the in-app docs ([Use your own machine](../web/src/docs/content/machines.md),
[Runner reference](../web/src/docs/content/runner.md)); this file is the implementation and the operator's side.

## How it works

With `WLP_MACHINES=1` a user can pair a machine of their own that has Docker, and launch agents on it: Linux with
Docker, or macOS or Windows (in a WSL terminal) with Docker Desktop or OrbStack, where the runner and the sessions run
in Docker's Linux VM with the images of its architecture (a Mac with Apple silicon takes the arm64 images; Windlass and
Claude Code turns have passed on Docker Desktop, runner 0.3.3). The runner's default name is the host name it sees,
which under Docker Desktop is the VM's, `docker-desktop`: setup asks for a name and says so, and the Docker commands
tell users to pass `--name`. A pairing made with `pair` or a bare `run` allows only `docker-hardened`;
`--allow-profile docker-windlass-sandbox` adds the two-wall profile, recommended for Windlass and Codex
([runner reference](../web/src/docs/content/runner.md#allowed-profiles)). Setup and the dialog's commands allow it by
default.
A small program on that machine, the runner, connects out to the platform, and makes and runs the
sessions' containers on the machine's own Docker. Everything else stays with the platform: the session's
actor, the turn's conversation with Windlass, questions, secrets, the GitHub App, the checks' record and the
timeline. Nothing on the machine needs to be reachable from outside. A session's place is chosen at launch
("Where it runs" in the launch form, `place` in `createSession`) and kept for its whole life.

### Pairing

The steps users follow, the runner command, `--name`, the pairing code and updating the runner are in the
in-app docs ([Use your own machine](../web/src/docs/content/machines.md#add-a-machine)). Underneath:

- The runner makes an Ed25519 key pair and keeps the private key in its state volume. It sends the public
  key with its machine's host name, system, architecture and its own version to `POST /runner/pair`, and
  prints the code with the address to enter it at ("Open https://.../machines/add and enter XXXX-XXXX").
- While the user decides, the runner asks `POST /runner/pair/poll`. After **Connect** it prints whose
  account it joined ("Paired with ada. ..."; "an account without a GitHub login" where GitHub is not
  connected) and connects.
- A code belongs to the first account that types it; for any other account it is not found.
- **Deny** on the connect page (`denyMachine`) ends a pairing whose code this account looked up and has not
  confirmed: the runner's next poll finds it gone and it stops ("The pairing code expired or was denied, ...").
- A name given with `--name` is kept in the state volume. A paired runner restarted with a new name updates
  the listing on its next report.
- The Machines page names the image in `WLP_RUNNER_IMAGE` and the address in `WLP_PUBLIC_URL`.

### Connecting from the CLI

The Machines page shows `npx @windlassai/cli connect --machine` first ([cli/src/machine.ts](../cli/src/machine.ts)),
`curl -fsSL <WLP_PUBLIC_URL>/install.sh | sh` under **No Node?**, and the Docker commands under **Other ways**.
The command and install.sh run the same container: its arguments, the state volume and the messages for
Docker's problems are defined once in [machine-setup.ts](../server/src/contract/machine-setup.ts)
(`setupRunArgs`, `DOCKER_HELP`), which install-script.ts renders into the script and the CLI bundles. The CLI
reads the image and the address from `GET /platform/info` (`machines.runnerImage`, `machines.platformUrl`),
checks Docker with `docker info`, pulls the image and runs `docker run --rm --log-driver none -v
/var/run/docker.sock:/var/run/docker.sock -v windlass-runner:/var/lib/windlass-runner <image> setup --platform
<address> --connect --name <host name>` with no terminal.

The pairing is the one above, unchanged: the runner in that container makes its key pair, asks
`POST /runner/pair` and polls. `setup --connect` asks nothing ([setup-events.ts](../runner/src/setup-events.ts)): it
writes one JSON line per event (`SetupEvent`), and the CLI shows them. For the `pairing` event (code and machine
key) the CLI opens `<address>/connect?code=XXXX-XXXX&kind=machine`. That page looks the code up (`claimMachine`,
so the code becomes this account's), shows the code, the machine key, name and system to compare with the
terminal, and **Approve** is `confirmMachine` with `keyConfirmed`, **Deny** is `denyMachine`. The machine's key
never leaves the container and its volume; the CLI sees only what install.sh's terminal shows. After the
pairing the setup takes its defaults: every agent in the image (or the saved ones), both profiles, restricted
network and automatic limits, signs no agent in (the agents pay with the account's plans and keys, see
[Plans on this machine](#plans-on-this-machine)), starts the service and waits until it is online. A machine
already paired with the platform keeps its pairing: with its runner running nothing is changed (its settings
may come from flags this mode would not keep), else the runner is started with the saved settings; `setup`
(Pair again) makes a new pairing. The host name is
passed with `--name` because inside Docker Desktop the runner sees only the VM's name.

### The one-line install and the setup wizard

The Machines page shows `curl -fsSL <WLP_PUBLIC_URL>/install.sh | sh` under **No Node?**. `GET /install.sh` ([install-script.ts](../server/src/install-script.ts)) answers with a short POSIX
sh script, as `text/plain` with `cache-control: no-store`, with the platform's address and the pinned
`WLP_RUNNER_IMAGE` written in. While no image is published the script says so and exits 1; with
`WLP_MACHINES` off the path is a 404. The script:

1. checks that `docker` exists and answers `docker info`, with a message for each case: Docker Desktop or
   OrbStack on a Mac, Docker Engine on Linux, the WSL integration of Docker Desktop on Windows, a stopped
   daemon, and a user outside the `docker` group;
2. pulls the image;
3. runs `docker run -it --rm --log-driver none -v /var/run/docker.sock:/var/run/docker.sock -v
   windlass-runner:/var/lib/windlass-runner <image> setup --platform <address> </dev/tty`. Under `curl | sh`
   standard input is the script, so setup reads the terminal. Without one (`/dev/tty` cannot be opened) it
   prints that command instead.

It runs nothing with sudo and writes no file on the host: everything it leaves is in Docker, the image and
the `windlass-runner` volume.

`windlass-runner setup` without `--harness` is a wizard ([setup-wizard.ts](../runner/src/setup-wizard.ts)): full-screen
prompts ([@clack/prompts](https://github.com/bombshell-dev/clack)) on a terminal, numbered lines with `--no-tui` or
without one. It pairs (or keeps the pairing), asks the machine's name and the agents to offer, signs OpenCode in
through the same code as `login` (Claude Code and Codex pay with the account's plans and keys and are not signed in
here), then the profiles, the network mode and the limits. A failed or skipped sign-in is shown and setup carries on. At the end it starts the service itself through the Docker socket
it was given, using the setup container's image and mounts, rotated logs and the `unless-stopped` restart
policy. It replaces an existing `windlass-runner` container when the user
agrees (the volume stays). It lets go of the state lock first, then waits until the service writes
`Online` to `status.json`. Its answers are kept in `setup.json` in the state volume and are the defaults
the next time; `setup --quick` asks only what is missing and `setup <section>` one part (`name`, `agents`,
`opencode`, `profile`, `network`, `limits`). With `--harness`, setup is the earlier flow:
it signs OpenCode in when it is given and prints the start command.

### Signed runner connections

`WLP_REQUIRE_SIGNED_RUNNER` defaults to `0`. In this mode the server continues to accept protocol 1
and requires no platform identity key. Keep the current runner image advertised until cutover. With
`WLP_REQUIRE_SIGNED_RUNNER=1` both sockets require protocol 2.

In either mode the oldest runner served is 0.3.13 (`MIN_RUNNER_VERSION` in `server/src/runner/protocol.ts`): the
first whose turns pay with a plan through a relay on the machine and that keeps no ChatGPT or Codex sign-in of its
own. An older runner's control socket is refused with "This runner is 0.3.12. Update your runner to 0.3.13 or later
with the command on the Machines page." (`outdatedRunner`); the Machines page says the same, and the launch form
refuses the machine with "Update your runner on “nas” to 0.3.13 or later, then start the agent again." Update and re-pair each runner to obtain a new pairing with the platform root and
gateway origin. Compare the fingerprint printed by the runner with the owner's offline copy.

Pairing establishes initial trust over TLS. A signed runner checks the online certificate against the
stored Ed25519 root, its expiry and the highest serial already seen on either socket. The runner signs
its ephemeral X25519 key, nonce and hello fields. The certified platform key signs the corresponding
welcome, including resume state, idle policy and, for runners 0.3.0 or later, the server's
capabilities. A runner sends a report field such as `gitMirrors` only to a server that names it,
because a server refuses a frame with a key it does not read. On the session socket the one-use random attach ticket
from the authenticated control socket serves as the platform challenge. Each connection derives fresh
directional HMAC keys. A counter starts at zero in each direction. Verification precedes dispatch for
control, catalog, report, host, session data and acknowledgments. A resumed conversation retains its
message sequence and authenticates each retransmission under the new connection keys.

The pinned endpoint is the gateway origin advertised at pairing. To move the gateway, certify the next serial with a
root-signed endpoint statement. Discovery supplies the authorization before the runner sends a gateway
token to the new origin. The verified welcome confirms the change before the runner saves it.
An offline removal response binds the pruning instruction to a fresh signed discovery nonce. A removed machine receives no gateway lease.

The transport can still be observed or interrupted by an edge terminating TLS. The platform identity
protects message authenticity and ordering. The operator keeps the offline root separate from the
platform's token-signing, sealing and backup keys. [Self-hosted cutover and rotation](../deploy/selfhost/README.md#enable-signed-runner-connections)

### Per-session data volumes

Commands in a `docker-hardened` sandbox run directly in the container, so whatever its Windlass data
directory holds is theirs to read and change. A runner of this release therefore gives each new hardened
Windlass sandbox a volume of its own, `wlp-machine-<machine id>-<raw id>`, when its server's welcome names
the `session-volumes` capability. The volume carries the machine and pairing labels plus
`dev.windlass-platform.sandbox=<raw id>`. The runner makes it right before `docker run` and removes it with
the container on destroy, also when the container was already gone. `prune` removes it with every other
volume of the pairing. A warm Windlass spare on either Docker profile gets its own data volume before
setup and keeps it after claim. A cold `docker-windlass-sandbox` session keeps the shared volume: bubblewrap hides the data
directory from its commands, and the user's sessions there keep sharing Windlass's project-wide MCP approvals.
The reviewer and the Claude Code, OpenCode and Codex harnesses mount no Windlass data volume at all, as before.
The hosted Docker provider does the same with `wlp-session-data-<uid>-<id>`, labelled with the user and the
sandbox. Its prefix is not `wlp-user-`, since a user id may contain `-`. It reuses or removes a volume only
when those labels match.

A hardened session's Windlass memory is now in its sandbox, as on E2B: when the sandbox is freed or lost,
the next sandbox starts a new Windlass session, and the timeline says so. The server learns this per
sandbox: the runner's answer to `connect` carries `ownData` for a sandbox that mounts a volume of its own,
and the session records it for that sandbox. A runner upgraded or downgraded under a live session therefore
changes nothing for the sandbox the session already has. The report's `sessionVolumes` only decides the
profile's description. A runner sends `sessionVolumes` and `ownData` only to a server whose welcome names
`session-volumes`, which a server names only to runners of 0.3.0 or later. A runner whose server did not
name it (a server before this release) gives hardened sandboxes the machine volume, as a 0.2.x runner does,
and such a server treats them as sharing it, which they do.

A hardened Windlass container that still mounts the shared volume is removed when the session next
connects to it, on a runner whose server names `session-volumes` and on the hosted provider alike. Such a
container was made before this release, or by this runner for an older server. The session goes on in a
new sandbox, as after a lost one: the timeline says the files of the old one are gone, and the agent starts
without its memory of the conversation. The shared volume itself stays.

A volume whose container is gone is swept: by the runner as it lists its sandboxes, at most every
10 minutes, and by the hosted server at start and every 30 minutes. Only volumes that carry the sandbox
label (and, on a runner, the pairing's labels) and are older than 10 minutes are swept, since a younger
one may be a create that has not reached `docker run` yet. Docker refuses to remove a volume a container
still mounts.

### Copies of the agents' conversations

Claude Code, Codex and OpenCode keep their conversation on the container's own disk, and a hardened
Windlass session with a data volume of its own keeps it there. When the platform's server names the
`session-backups` capability, the runner keeps a copy of each such session in one volume of the pairing's,
`wlp-machine-<machine id>-backups`, with the machine and pairing labels, and checks it like its other
volumes before it uses it. After each turn the session's archive is moved from its sandbox into that
volume, and before the first turn in a sandbox that replaces a lost one it is put back. The copies never
leave the machine. Windlass on the machine's shared volume needs none. Each copy is at most the platform's
`WLP_BACKUP_MAX_BYTES` (64 MiB by default) and the volume at most 2 GiB in all. A deleted session's copy is
removed when the runner is next connected; removing the machine with "remove sandboxes", or `prune`,
removes the volume. The design and its checks are in
[architecture.md](architecture.md#on-a-machine-the-copy-stays-on-the-machine).

### Profiles allowed on this machine

The `--allow-profile` rules are in the [runner reference](../web/src/docs/content/runner.md#allowed-profiles).
When the owner withdraws the Windlass profile, its existing workspaces stay on disk and can be used again
once the owner restores the flag.

### Network access on this machine

What each `--egress` mode allows is in the in-app docs
([Network access](../web/src/docs/content/machines.md#network-access)). How `restricted` is built:

- Each agent has a loopback-only Docker network. A small helper in that network namespace carries proxy
  traffic over a private Unix socket to an upstream helper.
- Only the upstream helper uses Docker host networking, so that it can identify the host's own interface
  addresses. It listens on the socket, runs unprivileged and has no Docker socket.
- The proxy checks every DNS answer and connects to the address it checked. Host interfaces, Linux bridge
  subnets, loopback, link-local, cloud metadata and CGNAT stay blocked even for `--egress-allow` names.
- The platform's own clone, fetch and push commands use the same proxy.
- With `--egress-domains` (`Egress.domains` in `runner/src/egress-policy.ts`, presets from
  `server/src/sandbox/e2b/network.ts` `PRESETS`), the broker gets the expanded list as its third argument.
  `targetAddress` matches the requested name before `selectAddress` resolves it, refuses IP literals and
  every port but 443 for `CONNECT` and 80 for plain HTTP. After `200 Connection Established` the broker
  holds the client's bytes until the first TLS record is complete (5 s, at most 16 KiB), and
  `clientHelloName` must find exactly one `server_name` equal to the tunnel's host and no Encrypted Client
  Hello (`0xfe0d`, the drafts' `0xfe00`–`0xfe0c` and `0xffce`) before anything is written upstream.
  `listedHost` checks each label as the list's own are checked, so a malformed name under a wildcard never
  reaches the resolver; an `--egress-allow` name that is not listed passes with `privateOnly`, and
  `selectAddress` then refuses any public answer. The saved list holds only the owner's entries;
  `EgressNetwork.domains()` adds `api.openai.com` and the platform's git host (`listedHosts`) for the broker
  and the report. The git host is the welcome's `gitHost` (`welcomeCapabilities`, from `WLP_GITHUB_URL`,
  sent to runners at `GIT_HOST_RUNNER_VERSION` or later, whose checks take the key), else `github.com`.
  One of the 64 places is kept for it. A wildcard whose base is a public suffix, or has one under it, is
  refused (`sharedSuffix`, over `runner/src/public-suffixes.ts`, generated from publicsuffix.org by
  `scripts/public-suffix-update.mjs`). Chrome's GREASE Encrypted Client Hello cannot be turned off any more,
  so the sandbox's browser cannot reach listed HTTPS hosts; `scripts/browser-hello-check.ts` holds that.
  The report carries only the list's size (`egressDomains`, behind the `egress-domains` server capability).
- Windlass's inner command sandbox has its own loopback and cannot use the proxy.

In `open` mode sessions use a machine bridge with inter-container communication disabled. In `none` mode a
repository session is refused at launch and again when a turn starts. Claude sessions can still send
Messages and token-count requests through their credential relay in every mode. When a kept sandbox was
created under a different mode, the runner stops it and keeps its files; restoring the previous mode
resumes it.

### Launching on it

The launch form lists the user's machines beside the platform's own sandboxes, each
with its state. A machine whose runner has not reported yet cannot be chosen ("“nas” has not connected
yet. Start its runner, and once the Machines page shows it online, start the agent again."), nor one
whose runner is below the deployment’s minimum. The form names the required release. A machine offers the two Docker profiles,
`docker-windlass-sandbox` and `docker-hardened`, as its runner last reported them: the first only where
the owner allows it and bubblewrap starts in a container there.

### Claude Code sessions

When the machine reports Claude Code, `createSession` accepts
`harness: "claude"` with `docker-hardened`. Its turns pay as hosted ones do, through Connections → Pay with: the
connected Claude plan through a relay on the machine ([Plans on this machine](#plans-on-this-machine)), or a
Settings key. A login kept on the machine (`connect claude --this-machine`, or `windlass-runner login claude`) wins for that machine
([Claude Code's own login on this machine](#claude-codes-own-login-on-this-machine)). The platform clones the
repository and runs its setup command before starting the adapter. The first prompt uses the
adapter's default model. Later prompts can select a model and reasoning effort it offered.

The session streams messages, reasoning, tool calls and permission questions over ACP v1. You
can stop a turn and send a follow-up during a turn when the adapter offers steering. The turn
reports context use and cost when available. The tokens the adapter answers a prompt with
(`session/prompt` `usage`) are recorded on the turn's end for every ACP agent's turns, in
personal sessions as in work items (`agent-session.ts`, `usage`; `promptUsage` in
`sandbox/acp-harness.ts`). Its conversation stays in the machine’s sandbox
across turns and sleeps. Removing the sandbox removes that conversation.

In a person's session with a repository the adapter receives `publish`, `push` and `fetch_base` over
MCP, and a publish is put to the person every time; a work item's builder gets `report`, `ask_person`,
`push` and `fetch_base` ([The platform's tools for every agent](work-items.md#the-platforms-tools-for-every-agent)).
Neither gets saved secrets or user MCP servers. The tools need the harness images of this version (Claude Code's managed policy allows the platform's endpoint,
and OpenCode's image runs `wlp-acp-mcp`). The platform's notes about the workspace (a prepared image, a
new sandbox, a setup that did not finish) go before the next prompt in either. Individual tool-call cancellation is unavailable for Claude Code. A runner
whose server names `session-backups` keeps a copy of the conversation on the machine
([Copies of the agents' conversations](#copies-of-the-agents-conversations)). The repository's saved checks and the step limit are the platform's
for these agents ([Work items](work-items.md#checks-and-steps-for-claude-code-opencode-and-codex)):
`sandbox/platform-checks.ts` runs the checks in the sandbox between the agent's prompts of a turn, and
`sandbox/platform-steps.ts` counts tool calls. A personal session's reported tokens are recorded, not
counted against any limit; a work item counts them only for an agent billed by token (OpenCode). Hosted sessions use Windlass. Machine reviewers use the builder's agent and profile. Claude Code and OpenCode can build Quick items or approved feature parts. Codex can build Quick items, paid with the ChatGPT plan or an OpenAI key as Pay with says. See
[Work items](work-items.md#the-items-agent).

### Warm spares

The runner at this revision is 0.3.8. With negotiated warm-spare and session-volume support,
`--spares` defaults to one (0 disables it, 2 is the maximum). The runner keeps a matching sandbox
ready for an eligible session with its own data volume. It verifies the base on claim. It can use
the idle slot on a one-slot machine and claims a match before freeing capacity. An environment build
waits when it would evict a spare. Spares expire after six hours. A runner that negotiates
`spare-reseed` can request a fresh base recipe after restarting.

### What the platform keeps

The machine's public key, what it said of itself when it was paired, when
its runner was last heard from, and the runner's last report: whether Docker answers, whether bubblewrap
starts in a sandbox there, the free disk space, its sandboxes, and the caps its owner set, where any is
set. The private key never leaves the machine. The runner's request for a connection is signed with it,
its control socket proves it by signing a challenge, and a session's socket carries a ticket the session
made for it, through the machine's control socket, which is good once and for one minute and is signed
with the machine's key too.

### What the runner does

What the server's Docker layer does, on the machine's Docker, and only what its
protocol names: it makes a session's container, runs the platform's commands in it, starts and stops
it, and removes it when asked. It runs the base sandbox image and can optionally run the screenshots image. The base, screenshots and optional Claude Code, OpenCode and Codex image pins come from the runner build. It touches only containers it labelled for its own machine
(`dev.windlass-platform.machine=<machine id>`) and keeps Windlass data in
`wlp-machine-<machine id>`, which is Windlass's data directory for the machine's sessions, as the user's
volume is on Docker. A Windlass session in a new `docker-hardened` sandbox gets a volume of its own
instead, `wlp-machine-<machine id>-<raw id>` (see [Per-session data volumes](#per-session-data-volumes)). Each agent container gets 256 CPU shares. The runner scales CPU, memory and process limits
by its slot count. By default, the runner fits up to 16 slots of 2 CPUs and 4–8 GiB each after reserving resources for the host.
If none fits, it uses one slot with all cores and up to 4 GiB, leaving at least 1 GiB or 25% of memory for the host, whichever is greater.
The runner applies these limits on creation and reconnect. A limit below current memory usage waits until the sandbox restarts. Creation requires 5 GB of free disk. It stops a
sandbox that has not been used for the idle time the platform names (`WLP_IDLE_SUSPEND_MS`), never while
a command runs in it or the session's socket is connected, and it removes one by itself in one case
only: a container it finds after a restart whose workspace was never set up (no `/workspace/.git`: the
runner stopped between starting it and preparing it) is removed when its session next asks for a
sandbox, and a fresh one is made.

### OpenCode and terminal sign-in

Build the runner with `WLP_RUNNER_HARNESSES="claude opencode" scripts/runner-build.sh`. Run the interactive
setup on the machine, using the runner image you built or its published digest:

```sh
docker run -it --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v windlass-runner:/var/lib/windlass-runner \
  <image> setup --platform <url> --harness claude --harness opencode
```

Enter the pairing code on the Machines page and choose **Connect**. Setup asks about each selected agent;
answer **n** to skip OpenCode's sign-in (setup signs in no other agent). For OpenCode, enter a provider ID or search by name. Pick **opencode-go**
for a Go subscription key or **opencode** for a Zen pay-as-you-go key, and paste the key at the hidden
prompt. **chatgpt** starts a separate OpenAI device login, and **free** enables OpenCode's public models.
Public sessions use OpenCode’s anonymous catalog and carry their own ACP client identity. If the
provider returns HTTP 429, the turn reports that its usage or rate limit was reached. The public models'
allowance is small and counted per public IP address, so every session behind that address shares it.
A working interactive terminal session can coexist with a refused anonymous ACP request on the same machine.

To import existing API keys, add
`--mount "type=bind,src=$HOME/.local/share/opencode,dst=/import/opencode,readonly"` before the image name
(use your `XDG_DATA_HOME` path if you set one). A bind mount fails when the folder is missing instead of
creating it as root. The Machines page offers this mount. Setup reads `auth.json` once and asks about each
provider; entries with OAuth or refresh tokens are never imported, and a subscription gets a separate
runner-owned login instead. If nothing was imported, setup goes on to the normal sign-in. The final
command starts the background runner with only the Docker socket and runner state mounted.

Add a provider or renew a key with `docker exec -it windlass-runner windlass-runner login opencode`
(append `--provider opencode-go` to pick Go directly), and clear the machine's OpenCode logins with
`logout opencode`. ChatGPT and the OpenAI API key share the native `openai` slot; public access and a Zen
key share the `opencode` slot; signing into a slot replaces its previous method. Go has its own slot.

OpenCode runs in personal hardened Docker sessions. Its own logins on the machine pay for its turns, and a Settings
key pays for each provider it has no login for there. The machine's relay holds the credentials, refreshes the
ChatGPT tokens of OpenCode's own ChatGPT login and checks each session's signed placeholder; agent commands can use the quota of the
configured providers. Adding a provider or changing a key keeps existing sessions working, because the
relay looks up the current key on each request. A full `logout opencode` or a new pairing invalidates the
placeholders, and affected sessions must be recreated. Open and restricted sessions both send inference
through the loopback relay. In `restricted` mode the OpenCode session's command proxy also refuses every
catalog inference hostname and every bare IP address, and `--egress-allow` does not reopen them.
See [the relay's provider routes](../sandbox/relay/README.md#opencode-1196).

Both relays answer a refusal or a provider error with a fixed message per status and never pass the
provider's own body on: 401 "Provider sign-in is missing or the session placeholder is no longer valid.",
403 "This request is not allowed by the relay.", 429 "The provider's usage or rate limit was reached.",
5xx "The provider failed or couldn't be reached." and any other status "The provider rejected the request."
A successful answer passes only as an event stream or JSON. chatgpt.com answers a ChatGPT sign-in's stream
with no content type or as text/plain, so on that route alone (OpenCode's ChatGPT `/openai/responses`) such an answer passes as an event stream; anywhere else it is refused with 502.

On a machine, `docker logs <relay-container>` shows diagnostics. Docker retains up to two 4 MiB files per relay. Each relay notes, without bodies, credentials or query strings, every
answer it did not pass on as the provider gave it: an upstream error status, a refused or retyped 200, a
provider it could not reach. It prints the note to its stderr and keeps the latest 20 in
`/workspace/relay-notes.json` of its socket volume. `windlass-runner status` prints the latest three of each
relay, for example `POST /codex/v1/responses  upstream 200, content-type text/html  answered 502`.

An agent's turn ends as failed with the provider's words when the provider refused it: Codex's when every model
request failed and it did nothing, OpenCode's on a relay refusal or when it logs that it gave up on a rate limit
(a usage limit). A turn whose agent sends nothing for 10 minutes, with no call of its own running and nobody
asked, is ended by the platform so it frees its slot (`WLP_ACP_IDLE_MINUTES`, [configuration.md](configuration.md)).

The credential relay checks decoded JSON strings in successful responses. For Anthropic Messages
streams it joins text deltas by content-block index and holds a possible credential prefix across
events. Other provider event formats are checked one JSON event at a time. A credential divided
between those events or encoded as model output in another representation can pass this check.
The relay closes the response on malformed JSON or an oversized JSON document or SSE event.

Machines report each agent's models, efforts and modes at startup, after each login or logout, and every
six hours. The composer fetches a catalog by digest only when it changes; host load and memory travel
separately.

### Claude Code's own login on this machine

A machine's owner can keep Claude Code's own login on the machine instead of paying with the plan from Windlass. It is
a visible choice: Connections offers it in the machine's Claude Code cell ("This machine's own login — it never leaves
this machine", `ownMachineLogin` in `server/src/sandbox/harnesses.ts`), and `npx @windlassai/cli connect --machine` asks
at its end (interactive terminal only; `--local-claude` chooses it, and no terminal means the plan). A user's own Claude
login on their own machine is always allowed, also with plans off for the account. When present it wins for that
machine's Claude Code: Pay with is not asked (`machinePaysWith` in `server/src/actors/agent-session.ts`), and the
machine's listing has no `paysWith` for it. Build the runner with `WLP_RUNNER_HARNESSES=claude scripts/runner-build.sh`;
only the hardened Docker profile offers Claude Code.

Three ways make the login, each storing it the same way:

- `npx @windlassai/cli connect claude --this-machine` (`cli/src/local-login.ts`) runs `claude setup-token` on the
  computer, reads the token off its screen without showing it, and hands it to the local runner with `docker exec -i
  windlass-runner windlass-runner login claude --token-stdin`: on standard input only, never on an argument, never over
  the network. It sends nothing to the platform; the runner's report carries the new sign-in state. Without a running
  `windlass-runner` container it says "Pair this machine first: npx @windlassai/cli connect --machine".
- `docker exec -it windlass-runner windlass-runner login claude` runs Anthropic's `claude setup-token` in the attached
  terminal; paste the token at the hidden prompt. A token minted on another computer works there too.
- `windlass-runner login claude --token-stdin` reads one setup token from a pipe (refused from a terminal).

The runner stores the token in `wlp-harness-claude-<machine id>`. The local login helper writes it.
A per-machine relay reads this volume for each request. Each hardened Claude session gets a
signed placeholder bound to its own loopback helper. Commands in the session
can use the login and consume quota while it runs. The setup token stays in the relay.
The relay sends Messages and token-count requests to `https://api.anthropic.com`.
Conversations stay in their individual containers.

In every egress mode Claude uses `http://127.0.0.1:17892`. A trusted helper in the
session’s network namespace forwards this port over a Unix socket to the relay. Each
connection carries the helper’s session identity. The relay checks it against the signed
placeholder before reading the token. The relay uses its own outbound HTTPS route to
Anthropic. The agent keeps its original interfaces and mounts.
[Relay verification and Docker checks](../sandbox/relay/README.md)

`docker exec windlass-runner windlass-runner status` shows whether a login is kept on the machine.
`docker exec windlass-runner windlass-runner logout claude` removes the relay and token for each
pairing, and Claude Code pays through Pay with again. The runner's `prune` also removes the socket and login volumes.

"Switch back to your plan" on Connections does the same without a terminal, for the current pairing: the user action
`removeMachineClaudeLogin` asks the machine actor (`internalForgetClaudeLogin`), which sends the control frame
`forget-claude-login` and waits up to 45 seconds for `claude-login-forgotten` (`ok` false where Docker could not remove
it). The runner removes the token as `logout claude` does, checks the sign-in again and reports. An offline runner is
refused with `machine_not_connected`, a failed removal with `claude_login_kept`. Every runner from the minimum, 0.3.13,
reads the frame, so it is not gated on a capability.

### Plans on this machine

Every runner the platform serves (0.3.13 and later) runs a plan-paid turn's relay on the machine: the plan's token is
handed to that relay for the turn only, kept in its memory, never in a file or a volume, and the plan's requests leave
from the machine ([model-relay.md](model-relay.md#plan-requests-from-a-machine)). No sandbox and no machine is ever
handed a ChatGPT access token. Who pays:

- **Windlass**: its unqualified (ChatGPT) models pay with the ChatGPT plan, the sign-in connected with
  `npx @windlassai/cli connect codex`. On a machine this is not behind `WLP_PLAN_USERS`.
- **Claude Code and Codex**: Connections → Pay with decides, as for hosted turns: the plan, the key, or the plan then
  the key, and what a limited plan does. Codex has no login of its own on a machine. Claude Code's own login kept with
  `connect claude --this-machine` (or `windlass-runner login claude`) wins on that machine. A Claude plan is behind `WLP_PLAN_USERS` on machines as hosted.
  The machine's listing (`listedHarness` in `server/src/sandbox/harnesses.ts`) marks such an agent `paysWith`, and
  its `signIn` is "token" when a connected plan usable there or a saved key can pay; the factory and the launch form
  read that.
- **OpenCode**: its own logins on the machine, and a Settings key for each provider it has no login for.

### Windlass's model relay on this machine

The runner runs Windlass's model relay ([model-relay.md](model-relay.md)) as `wlp-model-relay-<machine id>`, with
the socket volume `wlp-model-socket-<machine id>`. It uses the pinned base image and carries the pairing's labels, so
`prune` removes it. The relay's ceiling for the machine is 24 requests in flight, the same as the other relays. It
carries only Settings-key leases, forwarded to the platform's route: Windlass's ChatGPT turns use the plan relay.

- The runner's report carries `modelRelay`, and each `connect` of a Windlass sandbox (never a harness one) answers
  `modelRelay: true`, when the pinned sandbox image's Windlass is 0.7.1 or later, which the runner reads once the image
  is there (at its first welcome).
- The server's `RunnerHandle` offers `TurnSandbox.modelKeyRelay` only for a sandbox whose connect said so. The turn
  sends `modelRelay` (a forwarded lease, with a forwarder in the sandbox's network namespace) and `modelRelayClose` at
  the end (`server/src/runner/protocol.ts`). A conversation that is lost ends its leases on the runner
  (`Conversation.orphan`). Suspending or removing the sandbox ends its leases: the relay's file of each, its forwarder
  and the conversation's `relays` entry. At its first welcome the runner removes every forwarder and relay file a
  runner that died left, and the relay itself deletes files whose lease has expired.

If the relay cannot be had, a key-paid turn fails. `WLP_MODEL_RELAY=off` on the server turns it off for every machine.

### What the runner cannot do, and what the platform cannot do

The runner cannot start a container of
another image, run anything on the machine outside the containers it made, touch a container or a volume
it did not make, or reach a session that did not hand it a ticket. A plan-paid turn's token (a Claude plan's, or the
ChatGPT plan's access token) is handed to the plan relay on the machine for that turn only. The platform, for its part, cannot reach the
machine except through its runner, and does not control it: whoever runs the machine can change what
runs there and what it reports. The launch form, the profiles and a pull request's section say so.

### Sandbox and turn limits

A machine’s Windlass turns share any account daily model-token cap. Its sandboxes take no
sandbox time and no place among the kept sandboxes, have no price, and its turns are not among the
user's agents working at once: one rule, `hostedLimitsApply` (`server/src/usage.ts`), holds a session
to the daily time, the kept sandboxes and the running agents, and it holds only a hosted one.
The runner sizes its turn capacity from the machine. Set `--slots N` or `--max-turns N` to override it.
The machine actor queues turns in arrival order and waits until the head can take all its slots. The queue survives reconnects.
Stop cancels a queued turn. Older runners omit the turn limit and allow unlimited concurrent turns.
For optional limits on Docker containers, its runner takes `--max-running` and `--max-sandboxes`, with no
default, after the command above, and a turn that would pass one ends with "This machine has reached its
own limit on kept sandboxes, set by --max-sandboxes." (or on running sandboxes, by `--max-running`). The
Machines page shows what is in force under "Sandbox limit", "no limit" or the numbers, and says that a
limit is set on the machine, not there.
A sandbox there is not removed after `WLP_IDLE_DESTROY_MS` either: it goes with its agent, with the
machine's sandboxes, or by `prune`.

### Snapshot storage on this machine

The setup snapshots and Git mirrors a runner keeps are held to three limits, which its owner sets:

| Flag | Default | What it limits |
| --- | --- | --- |
| `--snapshot-disk SIZE` | 10GB | All setup snapshots on this machine. |
| `--snapshot-user SIZE` | 2GB | One user's setup snapshots. |
| `--keep-free SIZE` | 40GB | The free disk kept. Below it, snapshots are evicted oldest-first, and no snapshot or Git mirror is written. |

A size is a number with `MB`, `GB` or `TB` (decimal units, any case): `20GB`, `512MB`, `1.5TB`. The two
sizes must be above 0; `--keep-free 0GB` keeps nothing free. The flags go with `run` or `setup`, like the
sizing flags, and are not saved: give them each time the runner starts. A small machine can lower
keep-free with the flag, down to the deployment's floor.

The deployment can cap them ([configuration.md](configuration.md#snapshot-storage-limits)):
`WLP_SNAPSHOT_MACHINE_MAX_GB` and `WLP_SNAPSHOT_USER_MAX_GB`, where set, are the most the two sizes can
be, and `WLP_KEEP_FREE_MIN_GB`, where set, the least keep-free can be. A machine can choose less space or
more free disk than that, never more space or less free disk. The caps come in the signed welcome, and
the runner applies the result wherever it enforces the stores: saving and sweeping snapshots, the
15-minute retention sweep, and admitting and saving Git mirrors. It reports the limits in force (the
`store-limits` capability), and the Machines page shows them under "Snapshot storage", with a note
where the platform's caps changed what the owner set.

Runner 0.3.1 and older take none of these flags, get no caps (they refuse a welcome key they do not
know) and report nothing: they keep their built-in 10 GB, 2 GB and 15 GB free, and the page says so.

### When the link drops

One control socket per machine to its `machine` actor, and one socket per
session to that session's actor while the session needs its machine, both through the engine's gateway.
A dropped socket does not end a turn: both ends keep what the other has not acknowledged, and the turn
goes on when the runner is back, with every event once. A socket that goes silent without closing, as
when the machine sleeps or loses its network, counts as dropped after 45 seconds (`DEAD_MS`). While a
turn's work waits on a dropped socket, the session asks the runner back and says "Your machine "nas" is
not answering since 14:02. The turn goes on when it is back, or stops at 14:12." The banner follows the
machine while the page is open: the session pushes a `machine` event to it each time what it found
changes (answering, not answering, offline, removed). Ten minutes without the runner (`RUNNER_GRACE_MS`)
end that conversation, and what was outstanding in it fails. A control socket silent for 90 seconds
(`CONTROL_DEAD_MS`) is closed, and the machine is shown offline. An operation that is the same done twice
is asked once more after a lost conversation, `create` included: the runner answers a second `create`
for a session with the sandbox that session already has, so a lost answer never makes a second sandbox.
A message sent into the running turn while the machine is not answering is refused at once ("Your
machine is not answering, so the message was not sent. Send it again when it is back.",
`turn_running`), and so is stopping one tool call ("Stop the turn instead, or try again when the
machine is back."); stopping the whole turn works, since it waits for nothing on the machine.

### When the runner cannot reach the platform

It tries again at once, then after 1 s, 2 s, 4 s and so
on up to 15 s between attempts, each attempt given 5 s, and back to 1 s once connected; so a runner is
online again within seconds of its network being back. A control socket that sends no hello within 10
seconds of opening is closed as gone away (1001), not as refused, and the runner tries again in the same
way: a link that stalls right after a wake costs no turn. What the platform refuses is different: a
removed key (410), a key it does not know (403), a socket closed as a refusal (1008, or a code from 4000
to 4999), or another 4xx when it first asks `POST /runner/connection` (a renewal of its credential that
fails keeps the connection it has, and is tried again with the next session that attaches). Then the
runner ends its sessions' conversations, so every turn running on the machine ends, says why and when
it will try again in `windlass-runner status`, and waits ten minutes (`REFUSED_RETRY_MS`) before it
asks again; a removed key it does not ask again with at all. A removal it cannot carry out (Docker not
answering) it leaves unacknowledged, and the platform asks again when the runner next connects. A second runner started on the same state volume waits for the
first one's lock ("Another runner holds the state lock. Waiting to retry.") and looks again every ten
minutes, instead of exiting into Docker's restart loop; a second runner with a copy of the key on
another volume is refused at once, and the Machines page warns of it.

### When the runner restarts

Its conversations with the sessions are in its process's memory, so a turn
running then ends, not as done; the next turn stops what the old one left running in the sandbox, and
runs.

### When a server restarts

The session goes to sleep as any does ([When a server stops](architecture.md#when-a-server-stops)) and its
conversation with the runner ends with it; the next turn, on whichever server, opens a new one. The
session does not suspend a machine's sandbox on its way to sleep (`[wlp] sandbox.suspend_skipped`): the
runner stops it after the idle time.

With `WLP_RUNNER_DURABLE_TURNS=1` (default off), a Windlass turn can outlive the server instead
(`server/src/runner/journal.ts`). The session keeps its half of the runner conversation in its own
SQLite: the conversation's id, both sides' counts, and the frames the runner has not acknowledged.

- **Written ahead.** A frame goes to the runner only once it is stored, so the runner never holds a
  message the restarted server does not know.
- **Acknowledged after it is stored.** What the server received is counted as received in the same
  transaction as the timeline rows it produced and the turn's checkpoint, and only that count is
  acknowledged. The runner holds everything past it and sends it again: each message is taken once.
- **No secrets.** A frame that carries a secret (`writeSecretFile`, `modelRelay`, `planRelay`, `planRelayToken`, a
  start or run with secret variables) is stored as a cancel of its id, which a runner that never had it ignores. A
  plan-paid turn hands its plan relay on the machine a fresh token through the same lease (`resumePlanRelay`).
- **The turn checkpoint** (`turn_checkpoint`, `TurnCheckpoint` in `sandbox/api.ts`) holds the runner's id
  of the agent process, the ACP ids, the requests of the agent's not answered yet, the part of a line
  not ended, and the turn's own counts. It is plain JSON, written with the timeline.

On wake, a session whose turn was running reads both back (`takeUpTurn`). It takes the process before it
asks for the runner's socket, so none of its output arrives with nobody to take it, and runs the turn
again with the checkpoint: no `stopLeftovers`, no new engine, no new prompt. The runner's hello resumes
the conversation, it sends again what it held, and the turn goes on. While a turn can be taken up, a
wake is kept scheduled a minute ahead (`internalTakeUp`), so a server that crashed is replaced within
the grace without anyone opening the page.

A graceful stop keeps the turn running only with a runner that reports `resumable-conversation`
(`turn.kept` in the log); with any other it stops the turn as before. Anything that does not match
falls back to the turn being cut short: a runner whose grace ran out or that restarted answers the
resume with a new conversation, the process held for the turn ends, and the next turn stops what is
left. Claude Code, Codex and OpenCode turns write no checkpoint, so they end as before.

### When the machine is offline

An agent can be launched on it, and the form says that a prompt sent
before the machine is back fails. A prompt is not queued: it fails with "Your machine "nas" is offline.
The agent's files are there; send the prompt again when it is back.", at once when the machine's actor
knows it is offline, and after 15 seconds when the runner does not answer. The banner above the
composer says since when the machine is offline.

### When the machine is removed

"Remove…" on the Machines page deletes its key: the runner's control
socket is refused at once, and the runner forgets its key, stops its sandboxes and waits to be paired
again ("This machine was removed from its account, so run `windlass-runner pair` to pair it again with a
new key."). With "Also remove the agents' sandboxes on it", it removes them and its data volume instead,
at once when it is connected and when it next connects when not. A turn running on the machine ends
within seconds: the timeline closes it with the sentence of an engine that stopped in the middle of the
turn, not with the removal; from then on the banner says "This agent's machine was removed. Its files
were there. Start a new agent to go on.", a prompt is answered with the same sentence, and the agents
keep their timelines. If the machine's control connection was already down when it was removed, its
runner learns of the removal only when it next connects, within about twenty seconds of its network being back, and
serves the sessions it already has until then. Deleting an agent on a machine records the removal of its sandbox with the
machine's actor, and the runner removes it, at once when it is connected and when it next connects when
not. A delete whose removal could not be recorded is refused (`machine_unreachable`: "The agent could
not be deleted: its machine's record of the sandbox to remove could not be written. Try again in a
moment."), and the agent stays listed until a delete goes through; once the removal is recorded, nothing
the runner answers holds the delete back.

### Not seen for 90 days

A machine whose runner has not been heard from for 90 days is removed with its
key (`MACHINE_EXPIRY_MS`); its agents keep their timelines, and its sandboxes are left where they are.

### Forgetting the ChatGPT sign-in

Nothing is sent to the machines: none of them holds a ChatGPT token. A plan relay running a turn is closed at the
turn's next look at the plan, within a minute (the plan is gone), and the token it was handed goes with it.

### Pull requests, and the machine's name

The session keeps its machine's name from the launch, so it
can name the machine while the machine is offline. A pull request of a session on a machine keeps its
"What was verified" section, with one more line: "These checks ran on ada's own machine, “nas”; this is
what that machine reported." And the question about a project's MCP server says where the server would
run: "It runs in this session's container on your machine "nas", with its network, ..."

### The pairing limits

A user can pair three machines by default or on Free, and ten on Pro: each machine
that is connected keeps an actor awake on the platform, and this is what bounds that cost for one
account. A user can look up five codes in ten minutes. And the platform's routes see no client address
they could trust, so the pairings that are started are limited by the machine key that starts them,
three in ten minutes, and in 64 groups of sixteen that a key cannot choose. That bounds how many pairing
attempts anyone can leave open on the deployment; someone who makes many keys can use up the starts for
ten minutes, and the runners that are paired already are not affected.

### What the runner reports on the machine

`windlass-runner status` (in the container:
`docker exec windlass-runner windlass-runner status`) says whether it is connected, the caps in force and
the sandboxes and data volume of its pairings; `windlass-runner log` is its own record of what it was
asked.

## Turning machines on

| Variable | Effect |
|---|---|
| `WLP_MACHINES` | `1`: every user of the deployment may pair machines. Off (the default): the runner's routes answer 404, the machine actions refuse with `machines_off`, and platform info has no `machines`. The machines and their tables stay, so turning it off and on again loses nothing |
| `WLP_PUBLIC_URL` | the platform's address as a machine outside reaches it: an `https://` origin, or `http://` on a loopback address, with no path. Required with `WLP_MACHINES=1` and a remote engine; with the local one, `http://localhost:<WLP_HTTP_PORT>` |
| `WLP_REQUIRE_SIGNED_RUNNER` | `0` (default) serves protocol 1. `1` requires protocol 2 on both sockets. |
| `WLP_PLATFORM_KEY` | certified online key required when machines and signed connections are enabled. |
| `WLP_RUNNER_IMAGE` | the runner image the Machines page tells users to start, pinned by digest (`<name>@sha256:<64 hex>`). Unset: the page says that it cannot be installed yet. Set to anything else, the server does not start |

## Building the runner

This repository publishes no runner image, so a deployment builds its own:
`scripts/runner-build.sh [<sandbox image pin>]` builds a local runner and prints its image ID.
It pins the sandbox image by ID, using `windlass-platform-sandbox:latest` by default.
With `WLP_RUNNER_PLATFORMS=linux/amd64,linux/arm64` it writes a two-architecture OCI archive
and prints its path. Set `WLP_RUNNER_ARCHIVE` to choose the archive path.
A new sandbox image means a new runner build. Until `WLP_RUNNER_IMAGE` is set, the Machines page says that the
runner is not published and shows no command; a runner built on the machine itself is started with the same
command, naming the local image:

```sh
docker run -d --name windlass-runner --restart unless-stopped \
  --log-driver json-file --log-opt max-size=16m --log-opt max-file=3 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v windlass-runner:/var/lib/windlass-runner \
  <runner-image-id> --platform <WLP_PUBLIC_URL>
```

Pair using the code it prints. To offer screenshots on this machine, build the second runner and start
the same Docker command with `<screenshots-runner-image-id> --screenshots --platform <WLP_PUBLIC_URL>`.
From `server/`, after building both sandbox variants, build the two runners with:

```sh
../scripts/runner-build.sh
../scripts/runner-build.sh --screenshots
```

The second build pins both local image IDs. For a release, pass the base digest as the first
argument after `--screenshots` and the screenshots digest as the second. An unflagged runner
uses the base image even when a repository enables screenshots. Its builder can file a text report.

Give it a sandbox image pinned by id, so that a rebuild of
`windlass-platform-sandbox:latest` does not change what an existing runner runs. `docker-windlass-sandbox` is offered on a machine only where the
owner allows it and the runner’s bubblewrap probe passes. Work items can use either available profile ([work-items.md](work-items.md#where-an-item-runs)).

