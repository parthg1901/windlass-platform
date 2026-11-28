# Architecture

How Windlass Platform is put together: the actors, what happens in a turn, how ChatGPT sign-ins and access
tokens are kept, the sandbox profiles, the copy of the agent's memory, and how sandbox time is counted. For
the settings named here, see [configuration.md](configuration.md); for running it, [operating.md](operating.md).

The platform is built on [Rivet Actors](https://www.rivet.dev/actors/docs). Each agent session is one actor
that owns the conversation and drives a Windlass process inside a sandbox.

## How it fits together

```
browser ── HTTP ───────▶ any server (:6440)  GET /platform/info         what this deployment offers; no actor
                                             GET /platform/connection   where the actors are reached, and the token for it
browser ── WebSocket ──▶ Rivet endpoint (:6420)
                           │
                           ├─ login             [attemptId]          one sign-in attempt
                           ├─ accountIdentities [platform]           provider identities, account links, login limits
                           ├─ user              [uid]                profile, the index of sessions, the ChatGPT
                           │                                         sign-in (encrypted) and its access tokens,
                           │                                         the models of the ChatGPT plan,
                           │                                         approvals of projects' MCP servers,
                           │                                         setup commands of repositories, their
                           │                                         checks, their secrets (encrypted) and
                           │                                         their defaults, the account's own:
                           │                                         defaults, MCP servers and their secrets
                           │                                         (encrypted), the index of machines, the
                           │                                         index of work items, the turn queue and
                           │                                         the API tokens (digests only)
                           ├─ linearWorkspace   [workspaceId]        Linear team ownership and issue delivery routing
                           ├─ machine           [uid, machineId]     one paired machine: its public key, its
                           │                                         runner's last report, its control socket
                           ├─ machinePairing    [pairingId]          one pairing attempt, for ten minutes
                           ├─ pairingDirectory  ["starts"]           the codes of open pairings, and their budget
                           ├─ workItem          [uid, itemId]        one work item: its run, its step, its
                           │                                         question, its log and its verdicts
                           └─ agentSession      [uid, sessionId]     timeline in SQLite, one sandbox
                                               │
                                               ▼
                                   Docker container  wlp-session-<id>
                                     /workspace                        the agent's files
                                     ~/.local/share/windlass           volume wlp-user-<uid> (docker-hardened:
                                                                       wlp-session-data-<uid>-<id>, the
                                                                       sandbox's own):
                                                                       Windlass's own session logs and memory.
                                                                       No sign-in
                                     windlass acp                      one process per turn
```

### A turn

`agentSession.prompt()` returns at once. The actor starts or creates its sandbox and starts
`windlass acp` in it for this one turn, speaking the Agent Client Protocol over `docker exec`. Every durable
event goes into the actor's SQLite timeline and streaming output is broadcast to connected browsers. The turn is
held with `c.keepAwake`, so the actor does not sleep under it. A follow-up prompt resumes the same Windlass
session.

### Questions, steering, stopping one call

When a tool call needs approval (in the Windlass-sandbox profile: a
command that asks for the network, or to write outside the workspace), Windlass asks, the session's status
becomes `waiting`, and the browser shows the question with its choices: allow once, allow for the session, or
decline with a note for the agent. By default an unanswered question is declined after ten minutes. An unanswered hosted approval ends the turn and pauses its sandbox after five minutes. A
message sent while a turn runs steers it: the model reads it at its next step. One running tool call can be
stopped without ending the turn.

### A message sent twice

A call can reach an actor twice. RivetKit's client sends an action again by
itself when the engine says the answer was lost on its way, an action that is in flight when its actor's
instance goes away runs again in the next one, and a user who was told that the server did not answer
presses Send again. So the web app makes a key for every submission, a random UUID, and sends it with
every attempt of that submission: `idempotencyKey` on `prompt` and on `createSession`, named and shaped
as the Agent Client Protocol's is, a string of 1 to 255 characters (`server/src/submissions.ts`).

| What comes | What the session does |
|---|---|
| no key (left out, or null) | what it always did: every call is a message of its own. |
| a key that is empty, longer than 255 characters or no string | refuses it, `bad_idempotency_key`: it is never read as no key |
| a key it has not taken | takes the prompt as usual, and keeps the key in the same step that puts the message into the timeline |
| a key it has taken, with the same text | answers what the first attempt was answered, `{ turn, steered }`, whatever the session does by now: no second message in the running turn, no second turn, nothing in the timeline. `model` and `effort` are the first attempt's |
| a key whose first attempt is still being decided | nothing of its own: the attempt ends as the first one ends, with its answer or its refusal. A prompt waits on the user's actor and on the sandbox layer before it is taken, and other calls run meanwhile |
| a key it has taken, with another text | refuses it, `idempotency_key_reused`; the key stays the first message's |

A prompt that was refused (one of the user's limits, a ChatGPT sign-in that is needed, a turn that is
starting or stopping) leaves its key unused, and the same key is then a new try. "Refused" and "taken, but
the answer was lost" are told apart by one thing: whether the key is kept, which happens only in the step
that takes the message. A turn that was taken and then failed, as when its sandbox could not be made, has
used its key: its message is in the timeline with the turn's error, and a repeat is answered with that turn.

A session keeps the keys of its last 50 messages that came with one (`MAX_REMEMBERED_SUBMISSIONS`), each
with a digest of its text and its answer, in its own stored state, written when the message is: they hold
across the actor's sleep and a restart, and cost the same in a session of five turns and of five thousand.
The fifty-first is forgotten, and a prompt with it is a new message, as without a key. `createSession`
goes by the same rules in the user's actor: the key is in the session's row of the user's index, so the
same key answers with the session the first attempt made for as long as that session exists, and makes a
new one once it was deleted. A key is never logged and never sent to a client: it is not in the timeline.

In the web app a message that was not taken stays in the composer ("Your message is still here"), and
sending it again unchanged is the same submission, with the same key; a message whose text changed is a new
one. The launch form has one key for the agent and one for its first prompt, and a prompt that is handed
to the session's screen keeps its key until its text changes. No control shows any of this. The key is not
passed to Windlass: the Windlass the platform runs speaks ACP v1, which has no such field, and each turn's
Windlass is reached over a local pipe that does not send anything twice.

### Sleep

With no browser connected and no turn running, the actor sleeps after 30 seconds and stops its
container. The next prompt, or opening the session, starts it again with its files intact.

### A session on a machine of the user's

The session's actor is the same, and so is the turn: Windlass's
protocol is spoken by the server, as above. The sandbox is a container on that machine, which the
machine's runner makes and runs. The session has the runner open a socket to it, through the machine's
actor and with a one-use ticket, and every operation on the sandbox goes over that socket instead of
`docker exec` ([Machines of your own](machines.md)).

### When a server stops

With turn resumption enabled, eligible turns pause and resume after a restart or machine outage. Durable runner conversations can reconnect to a live machine turn. See [configuration.md](configuration.md#sessions-and-sandboxes). For a turn that cannot resume, on SIGTERM (a deploy) RivetKit puts every actor to sleep and exits after 20
seconds, done or not, so a session's sleep fits in 16: a turn that runs is stopped and closed in the
timeline (at most 10 seconds), the timeline and the session are saved, the sandbox is suspended (at most 4),
then the idle check is set and the user's list told (at most 2), and it is saved again. The waits and the
rule they must keep are in `server/src/actors/agent-session.ts` (`SHUTDOWN_GRACE_MS`), and the server does
not start when they add up to more. A suspend that takes longer goes on without the session: on E2B the
sandbox pauses at its own timeout (`WLP_E2B_IDLE_TIMEOUT_MS`, or `WLP_E2B_TURN_LEASE_MS` when a turn was
running), on Docker the container stops as it was asked to, and the next check or prompt sees that.

### Start times

Every turn records how long its start took, part by part, from the turn's start (after any wait for a free
slot on a machine) to the agent's first output (`server/src/start-times.ts`, `StartTimes` in the contract).
The session keeps the last five, the side panel shows the last one under **Sandbox → Last start**, and the
server logs one line per turn with durations, ids and names only:

```
[wlp] session.start_times session=… turn=3 harness=claude place=machine new=true pulled=true image_ms=… sandbox_ms=… runnerCreate_ms=… setup_ms=… prepare_ms=… agent_ms=… session_ms=… firstOutput_ms=… total_ms=…
```

| Part | From → to | When it is there |
| --- | --- | --- |
| `waited` | waiting for a slot on the machine | a wait of a second or more |
| `image`, `pulled` | the runner's image check, and pull | a new sandbox on a runner that names `start-times` |
| `sandbox` | making and starting the container, or connecting to or resuming it, as the server saw it | always |
| `runnerCreate` | the runner's own share of `sandbox` | as `image` |
| `setup` | clone, the repository's setup command, a restored memory or prepared image | a new sandbox, or one of a second or more |
| `prepare` | the platform's work before the agent's process starts: leftovers, the token file | always |
| `relay` | opening the turn's model relay lease: the relay container if it was not running, and the forwarder ([model-relay.md](model-relay.md)) | Windlass turns with the relay; part of `prepare` |
| `agent` | starting the agent's process until it answered ACP `initialize` | always |
| `session` | `session/new` or resume, mode and model choices, until the prompt went | always |
| `firstOutput` | the prompt to the first text, thinking or tool call | when there was output |

Each turn starts the agent's process again, so `agent` is paid on every turn, not only the first. A runner
reports `image`, `pulled` and `runnerCreate` on the first connect after a create, only to a server that named
the `start-times` capability; the runner 0.3.1 does not, and the server takes its answers as before.

Measured on 2026-11-22 on the self-hosted host (2 Arm CPUs, 12 GB, load 6 to 11 from other work), with
throwaway containers of the runner 0.3.0 images, no network and no credentials, medians of 2 to 5 runs:

| | Create and start | Workspace `git init` | Agent start and `initialize` | `session/new` |
| --- | --- | --- | --- | --- |
| Windlass | 0.65 s | 0.14 s | 0.73 s | needs a sign-in |
| Claude Code | 0.63 s | 0.19 s | 1.26 s | 1.76 s |
| OpenCode | 0.42 s | 0.10 s | 3.47 s | 2.26 s |
| Codex | 0.47 s | 0.14 s | 1.72 s | needs a sign-in |

With the image's own layers out of the page cache the agent's start takes 0.3 to 2 s more (Windlass 1.13 s,
Claude Code 1.95 s, Codex 3.64 s; OpenCode no different). The model relay adds 1.1 s once per Docker daemon
for its container, and 1.1 to 1.5 s on every Windlass turn for the forwarder, with 0.4 s to close it at the
turn's end. A cold pull of the Claude Code image (567 MB compressed, 1.43 GB unpacked) took 94 s to
download and 47 s to unpack; a release that keeps the base layers downloads its 185 MB of new layers. These
are the same Docker steps on the hosted server and on a machine; a machine adds the runner's round trips,
and E2B was not measured. First output needs a model and was not measured; the records give it.

**No warm-up after a pull.** Starting and stopping one throwaway container right after a pull was measured
and does not help: it reads the image's `sleep` and little else, so the agent's files stay as cold as they
were (medians 6.2 s against 5.9 s cold for Claude Code, 4.2 s against 4.8 s for Codex), and it costs 0.5 to
1.8 s of the host. A pull leaves the files it unpacked in the page cache anyway, so the first session after
a pull is not the cold one; the cold one is after a reboot or memory pressure, which a warm-up at pull time
does not reach.

**Ready sandboxes on machines.** A runner can keep an already cloned and set-up sandbox for the
next matching session, including on a one-slot machine. It checks the base before claiming the spare.
The agent process still starts for its turn. See [Warm spares](machines.md#warm-spares).

### Idle sandboxes

A sandbox costs money while it runs, whether or not a browser is open. Ten minutes after a
session's last turn ended (`WLP_IDLE_SUSPEND_MS`) the session suspends its sandbox, and after seven days
without use (`WLP_IDLE_DESTROY_MS`) it removes a hosted sandbox with its files. Paired machines keep their stopped session sandboxes until removal or pruning. The timeline stays, and gets one line for
each ("Suspended the sandbox after 10 minutes without use; the next prompt resumes it."). The actor's own
durable schedule (`c.schedule`) does it, so it happens while the actor sleeps and after a restart: the
engine wakes the actor when the time comes. A turn that runs, or waits on the user's answer, is never cut off;
the check is set again when it ends. The next prompt resumes a suspended sandbox, or makes a new one after a
removal. Reading the workspace's changes starts a suspended sandbox too and counts as use. A suspended
session counts as idle: it is not among the user's hosted sandboxes at work (`WLP_FACTORY_HOSTED_RUNNING`,
[Usage and limits](#usage-and-limits)).

### Sign-in

Platform login uses GitHub or Google. The browser posts to `/platform/login/start` and
`/platform/login/finish`. The shared identity directory applies admission budgets before the server
opens a per-attempt actor. The attempt binds its OAuth state and PKCE verifier to a browser secret
and, for an account link, the signed-in UID. The user actor checks the resulting platform token
on connection and again on each action.

From Settings, a signed-in user can also connect a ChatGPT plan. Windlass runs `windlass login start`,
the user pastes the loopback callback, and `finishChatgpt` runs `windlass login finish`. The user
actor stores the model credentials encrypted. See [Sign-ins](#sign-ins).

### No sandbox holds the sign-in

It is in the user's actor and nowhere else, and that actor is the one place
that asks Windlass for an access token: `windlass login token --json --valid-for 20m` prints a token of the
user's that is good for at least twenty minutes more, and refreshes the sign-in first when the saved token
has less left. With the [model relay](model-relay.md), the token goes to the relay and the sandbox receives a turn-scoped placeholder. Without the relay, the turn receives the token in a sandbox file
(`access-token-<sandbox id>.json`, mode 0600, in Docker's private `/dev/shm` tmpfs or the E2B guest's Windlass data directory), and
Windlass is started with `WINDLASS_ACCESS_TOKEN_FILE` naming it. The file is removed when the turn ends. Demo
turns are handed nothing. When the sign-in is gone, has expired or its token is rejected, the turn ends by
asking the user to reconnect their ChatGPT plan in Settings; when the platform could not get or replace the token for
another reason, it ends by saying so and that the sign-in is untouched.

### Keeping the token fresh

A token lasts about an hour and a turn may run 45 minutes. Three durations
(`server/src/sandbox/handoff.ts`) decide when the sign-in is refreshed, and none of them depends on a window
inside Windlass:

| Duration | Value | What follows from it |
|---|---|---|
| Time a token has left when it is handed to a turn or written as a replacement | at least 20 minutes | it is what Windlass is asked for |
| Time left before a turn’s token is replaced (at the relay or in the sandbox file) | 10 minutes | a turn's file is not replaced in its first ten minutes, and a replacement that fails has ten minutes to be tried again |
| Time a fetched token has left when it stops serving the user's other sessions | 20 minutes | a new token is shared for its first forty minutes |

When a file is due, the token in it has less than what is asked for, so asking gives another token whenever
that moment comes. Windlass refreshes only when it is asked and the saved token has less than twenty minutes
left, so one user's sign-in is refreshed every forty minutes at most (1.5 times an hour, however many sessions
run), and not at all while that user runs nothing and opens no page that offers models: listing a user's
models takes a token of theirs too, at most once an hour and only when they ask ([Models](#models)). Each refresh
is a request to OpenAI that rotates the sign-in's refresh token. A replacement that fails is logged (`[wlp] token.replace_failed`) and tried again
every 20 seconds, more slowly when the sign-in itself is refused; by itself it never ends a turn. Should
OpenAI issue tokens that last less than twenty minutes, Windlass says so; the platform uses each such token
until half of what it had left is gone and logs `[wlp] token.short` once per user.

### What went wrong with a token

Windlass names each failure of a sign-in by a stable code: on the error a
turn's prompt is answered with, on the model call that failed (`step.failed`), and in the brackets of the one
line `windlass login token` fails with (`windlass: sign-in failed: <message> (<code>)`). The platform decides
from that code what a failure means, never from the words of the message (`server/src/sandbox/handoff.ts`):

| Windlass's code | Reported by | The turn ends as | Which says |
|---|---|---|---|
| `handed_in_missing`, `handed_in_unreadable`, `handed_in_empty`, `handed_in_malformed` | the turn | `token_unavailable` | Windlass could not read the token it was handed; the sign-in is untouched, send the prompt again. (`auth_required` when the token source says there is no sign-in any more: forgetting a sign-in removes the token files of running turns) |
| `handed_in_expired` | the turn | `auth_required` when the token source says the sign-in is gone or no longer accepted, otherwise `token_unavailable` | reconnect the ChatGPT plan in Settings; or: the token ran out and the platform did not replace it in time (with the reason, when there is one), the sign-in is untouched |
| `handed_in_rejected` | the turn | `auth_required` | ChatGPT rejected the token: reconnect the ChatGPT plan in Settings. (When the token had run out as well by the platform's clock, as for `handed_in_expired`) |
| `network_error` | the turn | what Windlass reported (`execution_failed`) | Windlass's own sentence: a connection problem, not a sign-in problem |
| `network_error` | the token source | `token_unavailable` | the sign-in service could not be reached; the sign-in is untouched, send the prompt again |
| `signed_out` | the token source | `auth_required` | connect a ChatGPT plan in Settings |
| `invalid_grant`, `invalid_client`, `unauthorized_client`, `access_denied`, `invalid_request`, `invalid_scope`, `http_400`, `http_401`, `http_403` | the token source | `auth_required` | the sign-in is no longer accepted: reconnect the ChatGPT plan in Settings. A turn that is running tries its token file again more and more slowly |
| any other code of a refresh (`refresh_locked`, `bad_token_response`, `server_error`, ...) | the token source | `token_unavailable` | the sign-in could not be refreshed, with Windlass's sentence and the code; the sign-in is untouched |
| a `handed_in_...` code the platform does not know | the turn | `token_unavailable` | Windlass could not use the token: send the prompt again, and sign in again if it ends the same way |
| any other code | the turn | what Windlass reported | Windlass's own sentence |

`windlass login token` reports an empty sign-in on its own line without a code.

## Sandbox profiles

A server on Docker offers the two Docker profiles below. A server on E2B offers the E2B profiles instead
([operating.md, "E2B"](operating.md#e2b)), and a user's machine offers its own two Docker profiles
([machines.md](machines.md)). The picker also lists Daytona, Firecracker and agentOS as not built, and says
what each would need (`server/src/sandbox/profiles.ts`).

| Profile | Outer layer | Inner layer | Windlass runs with | Commands |
|---|---|---|---|---|
| Docker + Windlass sandbox | container, non-root, no capabilities | Windlass's bubblewrap sandbox | `--approval auto` | no network, cannot read the turn's access token |
| Docker, hardened | container under Docker's default seccomp and AppArmor | none | `--approval full` | network, can read the turn's access token |

In neither profile can a command read the ChatGPT sign-in: it is not in the container. The access token a command
can read in the hardened profile expires about an hour after issue. During a turn, an unsandboxed command or an approved local MCP server can also read replacements. When such a command
prints the token as it is, the platform takes it out of the turn's events, so it does not reach the timeline.

With the model relay ([model-relay.md](model-relay.md)), on by default for hosted Docker and for machines whose
runner offers it, the container never holds the token in either profile. The token file holds a placeholder
that only the turn's own relay connection accepts, and "can read the turn's access token" means only that
placeholder. The profiles' `commandsCanReadAccessToken` stays as the table says. It also decides how saved
secrets and MCP questions are treated, and a command can still use the model on the user's plan through the relay.

The Windlass profile ships Docker 29.1.3’s default seccomp filter (moby/profiles
`seccomp/v0.1.0`) with one rule for bubblewrap’s namespace and mount setup. The Docker CLI reads
`sandbox/seccomp-bwrap.json` locally and sends its contents to the daemon. Bubblewrap still needs
`apparmor=unconfined` and `systempaths=unconfined` to set up its filesystem. Containers
share the host's kernel either way: for users you do not trust, the outer layer should be a virtual machine.

### A home for sandboxed commands

In Windlass's sandbox the home directory is read-only, and many tools write
there without being told to: `astro build` makes `~/.config/astro`, npm and uv keep caches there. So the
platform opens every session with `"sandboxHome": "session"` (Windlass's docs/safety.md, "The session's home";
`SANDBOX_HOME` in `server/src/sandbox/turn.ts`): a sandboxed command then finds, at `/home/agent`, a home of
the session's own. What the sandbox's home holds is in it, read-only; what a command makes beside that, and
beside what is in `~/.config`, `~/.cache`, `~/.local/share` and `~/.local/state`, is kept for the session's
later commands, in `/tmp/windlass-<uid>/<Windlass session>.home` in the sandbox, and the sandbox's real home
is never written. It is said in every profile, because it applies to the commands Windlass sandboxes and to
no other:

| Profile | What it does there |
|---|---|
| `docker-windlass-sandbox`, E2B with its sandbox promised | every command is sandboxed, and gets the session's home |
| E2B before its check | the same where bubblewrap works in the microVM; where it does not, nothing is sandboxed and nothing changes |
| `e2b-open` | commands run directly in the microVM, with its real home, until content from the web or an MCP server is in the conversation. From then on Windlass sandboxes them, and without this a tool that wrote under the home until then would find it read-only. What is in the home by then stays read-only, a directory as a whole: a tool whose cache directory an earlier command already made there cannot add to it |
| `docker-hardened` | nothing: bubblewrap does not start there, so no command is sandboxed, and Windlass says nothing of it to the model or the user |

The setting is not stored with a session: it is sent with every `session/new` and `session/resume`, to a
Windlass that lists it among what it takes (below). The session's home lives and goes with the sandbox, and
is not in the copy of the agent's memory. A sandbox's files outside the workspace were never part of
"Changes" or of a push, and these are not either. The image still keeps the package managers' caches under
`/tmp/.cache` (`sandbox/Dockerfile`): a repository's setup command runs outside Windlass's sandbox, and a
cache it made in the real home would be a directory that is read-only as a whole for the commands after it.

## Sign-ins

A user's ChatGPT sign-in is what Windlass keeps in its data directory: `auth.json` (the account, the access
token and its expiry, the refresh token, the ID token) and `host-id`. The platform never makes or reads those
tokens itself. It stores the files and lends them to Windlass for one command at a time
(`server/src/signin/`).

The identity directory keys GitHub accounts by API origin and numeric user ID, and Google accounts by issuer and OpenID Connect subject. A new identity creates a fresh UID after admission. A signed-in account can link another provider, and an operator can [recover a signed-out owner](operating.md#recover-a-platform-login). Email is an admission attribute only.

The signed-in user can authorize a ChatGPT plan from Settings. The user actor owns the pending model connection and adopts the finished credentials under its own UID.

| What | Where | Sealed for | Until |
|---|---|---|---|
| the user's sign-in (`auth.json`, `host-id`) | `user` actor, table `signin`, column `sealed` | that uid | it is replaced or forgotten |
| a pending model connection (`auth-pending.json`, `host-id`) | `user` actor, table `model_attempt` | that uid | ten minutes, until superseded, or until completion or disconnect |
| an access token on its way to the server that runs the turn | not stored: an actor's answer, through the engine | that uid and that request | it is read |

Each is AES-256-GCM (`server/src/signin/seal.ts`) under a key derived with HKDF-SHA256 from `WLP_SIGNIN_KEY`,
or from `WLP_SECRET` when that is unset, with a label of its own: it is not the key tokens are signed with.
The key is in the servers' environment and never in actor storage. What a blob is for and whose it is are
authenticated with it, so one user's sign-in put into another user's actor does not open there, and an
attempt's material does not open as a sign-in. Next to the blob the `user` actor stores a counter of how often
the sign-in changed, whether a line about short tokens was already logged, and when the row was last written.

Someone with a copy of the actor storage and without the key learns which users have a sign-in, how long each
blob is, and when it last changed (so, roughly, when its user was active). They learn no token, no refresh
token and no PKCE secret, and, from these rows, no account. (The email is in the same actor's `profile` table,
which the platform also uses to check admission for API tokens.) Someone
who can also write to the storage can put back an older blob of the same user (a sign-in that was forgotten, or one from before a refresh, which the sign-in
service then refuses); they cannot make one user's blob work for another. Forgetting a sign-in empties the
row; what the engine keeps of earlier versions of a row is the engine's, and is ciphertext.

With the key, everything is readable, so the key must not be where the storage is. That holds when the engine
is hosted elsewhere and the servers are your own: the secret is in the servers' environment only. It does not
hold on a Rivet Cloud cluster, where Rivet also runs the servers and keeps their secrets
(`rivet cluster secret set WLP_SECRET`): there the encryption protects a copy of the actor storage, such as a
backup, and not against whoever runs the cluster. The key must be the same on every server and must not
change: with another key a stored sign-in does not open, the server logs `[wlp] sign-in.unreadable`, and the
user is asked to reconnect the ChatGPT plan in Settings.

**Running Windlass's commands.** For each command a runner makes a private directory (mode 0700), writes the
sign-in's files into it (0600), runs `windlass login ...` with `XDG_DATA_HOME` pointing there (Windlass looks
for its data in `$XDG_DATA_HOME/windlass`) and without `WINDLASS_ACCESS_TOKEN_FILE`, reads the files back, and
removes the directory: after success, failure, a timeout, an abort, and when Windlass could not be started.
The files are read back after a failure too, because a command can fail after the refresh token was already
replaced. The one command that is not a sign-in's, `windlass --models` ([Models](#models)), goes the same way with an
access token's file in the directory in place of the sign-in's. There are two runners:

| Runner | Runs | For |
|---|---|---|
| local (`WLP_WINDLASS_BIN`) | a Windlass executable on the server, as a process. The directory is under `/dev/shm` where there is one (memory, never a disk), else the system's temporary directory; `WLP_SIGNIN_TMPDIR` names another place | deployments: no Docker on the server |
| Docker | a throwaway container of the sandbox image. The files go in on its standard input and come back on its standard output; the directory is in the container's memory. No volume, nothing on the host | development on a machine that has the image |

The server uses the local runner when `WLP_WINDLASS_BIN` is set. Without it, a server whose sandboxes are
Docker's uses the Docker runner, and any other server the local one with `windlass` from its `PATH`;
`WLP_SIGNIN_RUNNER=local|docker` says it outright. At startup the server checks the selected executable and requires Windlass 0.4.0 or later.

**One refresh at a time.** A refresh replaces the refresh token, so two servers refreshing one sign-in at once
would break it. Whichever server runs a turn, `AccessTokens.current(uid)` is a call to that user's actor, and
an actor runs in one place at a time: it answers from the token it keeps in memory while that has twenty
minutes left, and otherwise runs one `windlass login token` however many are asking. When Windlass refreshed,
the actor saves the new sign-in and only then answers (`[wlp] sign-in.refreshed uid=...`). If the save fails,
no token is handed out, and the save is tried again before Windlass is asked again. The answer is encrypted
for the request that asked, so the engine that carries it does not see the token.

What cannot be closed: a server that dies after OpenAI answered the refresh and before the actor's save has
returned. Windlass has the new sign-in in its private directory, exits, the runner reads it, the actor encrypts
and writes it: tens of milliseconds, plus the storage's round trip. If the server dies in that time, the store
keeps the old refresh token, which OpenAI has used up. The next refresh is refused, the user's turns end with
"Your ChatGPT sign-in is no longer accepted ... Sign in with ChatGPT again", and signing in again mends it.
Nothing else is lost and no other user is affected. A command that is stopped at its time limit is not this
case: what Windlass had saved is still read back and stored.

**Replacing and forgetting.** A new sign-in replaces the old one in the same queue the token requests wait in,
and a `windlass login token` that is running for the old one is stopped rather than waited for: once `adopt`
or `logout` has returned, no token of the old sign-in is handed out. `user.forgetChatgpt()` forgets the
caller's sign-in; the web app has no button for it yet. Forgetting also has the sandbox provider remove the
token files of the user's running turns. Docker removes each private file in its session container and clears
legacy copies on the data volume. E2B lists the user's running sandboxes by the metadata `wlp_uid` and removes
the file from each guest's Windlass data directory. A connected machine runner removes the files from its
own sessions. A copy already taken remains usable until its expiry.

The variables of the sign-in runners (`WLP_SIGNIN_KEY`, `WLP_WINDLASS_BIN`, `WLP_SIGNIN_RUNNER`,
`WLP_SIGNIN_TMPDIR`) are in [configuration.md](configuration.md#sign-ins).

## Models

The models a user can pick are no fact of the deployment: they are what that user's ChatGPT plan offers.
Windlass can say what an account offers (`windlass --models`; over ACP, `_windlass/models`), and since each
user's sign-in is held by the platform ([Sign-ins](#sign-ins)), the platform asks for each user
(`server/src/account-models.ts`).

- **How Windlass is asked.** `windlass --models --json`, run by the same runner as the sign-in commands and
  outside any sandbox. It prints one JSON object on a line for each model: `id`, `description`, `efforts`
  (the reasoning efforts that model accepts; none for a model that takes no effort) and `isDefault` (the
  model a session starts on when none is named). It runs on no sign-in: the user's actor fetches an access
  token as it does for a turn, and the runner hands it to Windlass as a turn's is, in a file that
  `WINDLASS_ACCESS_TOKEN_FILE` names (mode 0600, in a private directory that holds nothing else and is
  removed when the command has ended, however it ended). So this command refreshes nothing, and the token is
  neither logged nor stored. The lines are read strictly: one that is no model, or no line at all, makes
  the whole answer a failure, and the table Windlass prints for people is never read.
- **Where it is kept.** In the user's `user` actor, one row: the models, the efforts of each, the default,
  when it was read, and the generation of the sign-in it was read with. The actor is the cache, so every
  server answers the same and none keeps a list of its own.
- **When Windlass is asked.** When somebody asks for the list (`user.models`, or a check below) and the row
  is older than an hour, or there is none. Never on a schedule and never for a user who asks nothing: a
  listing is one request to the provider that its user caused. Whoever asks while a listing runs waits for
  that one, so one page that asks from three components causes one request. Nobody waits longer than five
  seconds: past that the answer is made from what is kept, and the listing goes on and is stored for the
  next one who asks. The command itself is stopped after five seconds. A listing that failed is logged
  (`[wlp] models.list_failed uid=...`, with Windlass's own reason and never the token) and not tried again
  for a minute.
- **What is answered without it.** `ModelList.source` says whose list an answer is. `account`: the plan's,
  with the time it was read; an old one is served on while a listing fails, since a stale list is better
  than none. Anything else is the platform's stand-in (`STAND_IN_MODELS`: three names with the efforts
  `windlass --effort` knows), and says why it stands in: `demo`, the demo's scripted model answers under
  any name, and Windlass is never asked for a demo user; `signed-out`, there is no ChatGPT sign-in to list
  with; `unavailable`, the plan's list could not be read and none is kept. The stand-in is the one fixed
  list left, and it is not a list of record: a plan may lack a model named in it, and Windlass then says so
  when the turn starts.
- **The list and its sign-in.** A row is the user's list only while the generation in it is that of their
  sign-in, which counts up whenever a sign-in is adopted or forgotten. So after a sign-out the answer is
  the stand-in at once, and the row is removed; after a new sign-in the plan is listed again. A listing
  that ends after its sign-in was replaced or forgotten is neither stored nor answered. Signing in as
  another account is another user, with an actor of their own.
- **Where it is used.** The launch form, the composer's model and effort pickers, and the defaults on the
  Settings and repository pages all read `user.models`, and each says in one quiet line whose list it is
  ("The models of your ChatGPT plan, as read at 14:02 UTC.", or "A stand-in list: ..." with the reason).
  The efforts offered are the chosen model's. The server holds a choice against the same list: a session
  is created on one of the user's models (`bad_model` otherwise), a default is saved for one, and a prompt
  that names a model or an effort is checked against the list and against the efforts of the model the
  turn runs on (`bad_effort`: "The effort for gpt-6-luna must be one of: low, medium"). A prompt that names
  neither asks nothing. A session keeps the model it has when the list no longer has it; of such a model
  the platform says nothing and Windlass decides.

```sh
cd server && npx tsx ../scripts/models-check.ts   # the list's rules, and the real `windlass --models` against a stand-in for the provider's endpoint
```

The web app's mock (`?mock=1`) has a plan of three models with different efforts, one of which takes none;
`?mock=1&models=unavailable` plays a user whose plan could not be read, and the demo sign-in has the
stand-in.

## The agent's memory outlives its sandbox

A session has two histories. The timeline, which the user reads, is in the session's actor. What the model
remembers of the conversation is the agent's own session: Windlass's in Windlass's data directory, Claude
Code's, Codex's and OpenCode's in theirs. On a hosted sandbox that is on the sandbox's disk and goes with it:
when an idle sandbox is removed after seven days, or when E2B loses one. With a bucket configured, a copy of
that data is kept outside the sandbox and put back into the one that replaces it, so the agent continues the
same session there (`session/resume`). Without a bucket nothing changes: the agent then starts without its
memory, and the timeline says so. On Docker, Windlass's data directory is a volume that outlives every
sandbox, so only the other agents' sessions are copied there. On a machine of the user's, the copy is kept
on that machine and nowhere else ([On a machine, the copy stays on the machine](#on-a-machine-the-copy-stays-on-the-machine)).

- **What is copied.** Windlass keeps one SQLite database per session, in WAL mode
  (`sessions/<id>.db`), and that file is all a `session/resume` needs, with its write-ahead log
  (`.db-wal`) when a Windlass that was killed left one: without it the database opens and has silently lost
  the last turn. Copied with them are the media the messages refer to (`blobs/`) and Windlass's notes
  (`memory/`). Everything else stays in the sandbox, because only what is named is copied: the turn's access
  token file, anything of a sign-in, the wake-ups' database (it holds webhook secrets), locks, caches, and the
  snapshots of the workspace. Claude Code's copy is the session's transcript (`projects/*/<id>.jsonl`),
  its subagents' and its long tool output; Codex's is the thread's rollout
  (`sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`), from which it rebuilds its databases; OpenCode keeps every
  session and its sign-ins in one database, so its session is exported (`opencode export`), checked, copied,
  and imported into the new sandbox. No sign-in, settings file or shell environment of any of them is copied.
  `server/src/sandbox/session-files.ts` has each agent's whole list and the reasons.
- **When.** After every turn in which the agent ran, while the turn is being closed: its process is gone by
  then (for Claude Code, Codex and OpenCode, what a lost turn left running is stopped first), so nothing has
  the files open and a plain `tar` of them is whole. It is one object per session,
  `sessions/<uid>/<session>.tgz`, replaced each time. A restore happens once, before the first turn in a
  sandbox that was made in place of a lost one.
- **The bytes never pass through a server.** The server signs a link, good for five minutes, for one
  object and for one method, and for an upload for exactly the size the archive has. The sandbox's own
  `curl` uses it, in a command the platform runs beside Windlass, not under it (Windlass's bubblewrap sandbox
  gives the agent's commands no network). The link reaches the sandbox on the command's standard input and
  is in no command line, no environment, no file and no log. The server itself sends two small requests a
  turn: one to learn the object's size after an upload, and one to remove it when a session is deleted.
- **The session's record.** The actor keeps the archive's size, its SHA-256, when it was saved and after
  which turn. A restore checks the download against the size and the hash before anything is unpacked, and
  unpacks only an archive that holds nothing but what a copy holds.
- **What the user sees.** Nothing for a save. For a restore one line, "Restored the agent's memory of the
  conversation into the new sandbox." When there is no copy, or it cannot be restored, the line of before:
  "The agent's memory of the conversation went with the old sandbox, so it starts this turn without it."
- **A save that fails is not retried by itself.** `curl` tries a transfer again twice; after that the save
  is given up and logged (`[wlp] backup.save_failed`). The next turn's save copies the whole session again,
  and trying in between would mean starting a sandbox that was suspended so as to cost nothing. The user is
  told only if it comes to matter: if the sandbox is lost before a save works, the restore says "...
  without the last turn: no copy of it could be saved."
- **The size limit.** An archive larger than `WLP_BACKUP_MAX_BYTES` (64 MiB) is not uploaded. The timeline
  says so once ("The agent's memory of the conversation has grown to 70 MB, and the platform keeps a copy of
  at most 64 MB, so it is no longer copied out of the sandbox. ..."), and the last copy that fitted stays.
- **Deleting a session deletes its object**, after its sandbox, which is what uploads. The session tries
  three times; an object that is still there then is handed to the user's `user` actor
  (`[wlp] backup.remove_deferred`), which outlives the session and tries again on its durable schedule, 1,
  2, 4, ... 128 minutes apart: eight more tries over about four hours and a quarter, across restarts. An
  object the store no longer has counts as removed. After the last try the object is named in the log
  (`[wlp] backup.remove_failed uid=... session=... object=...`), for whoever looks after the bucket.
- **Who can read a copy.** It holds the conversation as Windlass has it: the prompts, the model's answers,
  the tool calls and their output. It is not encrypted by the platform. Whoever holds the bucket's access key
  can read every copy, as can the store's operator; a sandbox can reach its own session's object and no
  other, for the minutes a link lasts. The workspace's files are not in it.

The bucket is configured on the servers: see [operating.md, "The bucket for agent memory"](operating.md#the-bucket-for-agent-memory),
which also has its checks and measured timings.

### On a machine, the copy stays on the machine

On a machine, Claude Code, Codex and OpenCode keep their conversation in the container's own disk, so it
goes when the container does: an idle reclaim, a runner restart or upgrade, a reboot, slot pressure. A
hardened Windlass session with a data volume of its own (`wlp-machine-<id>-<raw id>`) loses it when its
sandbox is removed. A runner whose server names the `session-backups` capability keeps a copy of each such
session in a volume of the pairing's own on the machine, `wlp-machine-<machine id>-backups`, and puts it
back into the sandbox that replaces a lost one (`server/src/sandbox/machine-backups.ts`,
`runner/src/session-backups.ts`). The copy never goes to the platform's bucket and never passes through a
server, and no bucket needs to be configured for it.

| Agent and placement on a machine | Copied |
| --- | --- |
| Claude Code, Codex, OpenCode (any profile) | yes: their data is on the sandbox's own disk |
| Windlass, hardened, with a data volume of its own | yes |
| Windlass on the machine's shared volume `wlp-machine-<id>` | no: the data outlives the sandbox, and restoring into a shared volume is unsafe |
| A Windlass reviewer | yes: its data is always its own |

`privateSessionData` (`server/src/sandbox/session-data.ts`) decides, from what the sandbox had when it was
made (`ownData`), as for the restore into a replacement.

- **What a copy holds, and how it is checked** is the bucket's (`server/src/sandbox/backup-scripts.ts`):
  the same pack script in the sandbox, the same restore script with its size and hash check, its list of
  the names a copy may hold, no owners or modes on unpacking, and the agent's proof that the session came
  back.
- **Save.** After the pack script, the server asks the runner (`backupSave`, over the session's own
  socket) to take the archive. The runner reads it out of that session's own sandbox with `docker exec
  cat`, at most the limit, removes it there, measures its size and SHA-256 itself, and keeps it only when
  they are what the sandbox printed. It writes it into the volume with a helper container of the base image
  (no network, no capabilities, read-only root). What the session records is the runner's measurement.
- **Restore.** The runner (`backupRestore`) reads the session's copy, and only when its size and hash are
  the ones the session recorded does it put it at a path of the platform's under the new sandbox's `/tmp`.
  The restore script then checks it again, checks its names and unpacks it. The runner never unpacks a copy.
- **Only the asking session's own.** The runner refuses a copy whose user is not its pairing's or whose
  session is not the one whose socket asks, a sandbox of another session, and a path that is not the
  platform's.
- **Limits.** Each copy is at most `WLP_BACKUP_MAX_BYTES` (64 MiB by default, the bucket's setting, which
  needs no bucket here); the runner never reads more than 512 MiB into memory whatever the server says. The
  volume holds at most 2 GiB in all: a copy that would go past it is refused, logged as
  `[wlp] backup.save_failed ... no room`, and the session's earlier copy stays.
- **Deleting a session** records the removal with the machine's actor, which tells the runner on its
  control socket (`forget-backup`, answered with `backup-forgotten`) at once, or when the runner next
  reports that it keeps copies, however long the machine is away. When the actor cannot be asked, the
  user's actor tries again on its schedule, as for the bucket.
- **Removing the machine** with "remove sandboxes", and `windlass-runner prune`, drop the volume with the
  pairing's other volumes. Removing it without that leaves the copies on the machine, with its sandboxes.
- **An older runner** (no `session-backups`) keeps no copies; nothing is saved or restored and nothing is
  said, as before. A newer runner on an older server reports nothing of it and is asked nothing.
- **Continuing in a new session** (`SessionBackups.copy`) is `backupCopy` over the new session's socket: the
  runner copies the earlier session's archive to the new session's name in the same volume.

## Usage and limits

A hosted sandbox costs money while it runs, so two things are limited for each user, and a page shows where they
stand (`server/src/usage.ts` has the rules, with no actor in it):

| Limit | Setting | Default |
|---|---|---|
| Sandbox time a user's sandboxes may run in one UTC day, all of them together | `WLP_DAILY_SANDBOX_SECONDS` | 7200, two hours |
| Sandboxes a user may keep at the same time, running or paused | `WLP_MAX_KEPT_SANDBOXES` | 5 |

Either takes `unlimited`. The time is counted and shown with or without a limit.

A user may also have at most `WLP_FACTORY_HOSTED_RUNNING` hosted sandboxes at work at once (default 3), their own
agents and their work items' together ([Work items](work-items.md)), and the ceiling holds for their own agents where work
items are off too. A prompt beyond the ceiling is refused before anything starts (`too_many_running`: "You already have
3 agents working on this platform, the most it runs for you at once. Agents on your machines don't count. Wait for one
to finish, or stop one."); a work item's turn waits instead.

Only hosted sandboxes, the layer `WLP_SANDBOX` chooses, are counted. A session says where it runs
(`place` in `createSession`): hosted when left out,
or one of its user's machines ([Machines of your own](machines.md)). The platform's limits do not hold a machine's
sessions (`hostedLimitsApply`): their sandboxes take no sandbox time and no kept place and have no price,
and their turns, work items' included, do not count towards the hosted limit on sandboxes at work. Each runner has its own
machine-sized slot limit (`--slots`, also accepted as `--max-turns`). Its owner can also cap running and kept containers with `--max-running`
and `--max-sandboxes`. The usage page lists a machine's sandboxes apart, under "On your machines": "Not counted
against your daily sandbox time, running agents or kept sandboxes."

- **What is counted.** The time a session's sandbox runs: from the moment the session has it created or
  resumed, for a turn, a clone, a setup command, a push, or to read the workspace's changes, until it is
  suspended, removed, or stops by itself. So a turn counts with the time the sandbox goes on running after
  it: on E2B until its idle timeout pauses it (`WLP_E2B_IDLE_TIMEOUT_MS`, two minutes), on Docker until the
  session suspends it (`WLP_IDLE_SUSPEND_MS`, or the session going to sleep). A paused sandbox counts no
  time. It counts as one of the sandboxes its user keeps.
- **One place decides.** The user's `user` actor, which every server reaches and which does one thing at a
  time. A count kept on a server would be a limit per server.
- **A ledger.** Every second counted is in an entry in that actor's storage: which session, which hold, how
  many seconds, when, and a note where a count is not simply what was reported. A day's total is the sum of
  its entries. Nothing is ever changed in an entry; a correction is another entry. Each is also a line in
  the server's log (`[wlp] usage.counted uid=... session=... hold=... kind=used seconds=182`), to hold
  against the provider's bill.
- **Reserve, then settle.** A session does not ask whether time is left and report afterwards: two that
  asked together would both be told yes. Before its sandbox runs it takes a hold, five minutes of the day's
  allowance (`WLP_USAGE_HOLD_SECONDS`) or what is left of it, which counts as used for everyone else from
  that moment. While the sandbox runs, the session trades the hold for the next one when it is over,
  reporting what the first really ran, in one step. When the sandbox stops, the session reports what ran of
  the last hold, and the rest of it is free again. A hold never reaches past midnight UTC: the one after it
  is the new day's.
- **A hold nobody settles** runs out by itself four minutes after the time it was for, and is counted in
  full (an entry of the kind `unreported`): the server its session was on died, the sandbox ran for some
  part of the hold, and nobody measured which. A session whose server shut down in order stops its sandbox
  and reports; when the report does not get through in the two seconds a shutdown leaves, the session
  keeps it and sends it when it is next awake, and the difference is given back (`corrected`). After a
  restart, a provider observation can also confirm that the VM ran beyond the expired hold. The ledger
  records that overrun once. E2B reports the last pause time, so time spent paused is excluded. A warm
  VM counts through the server restart. When the resumed turn ends, its final segment is settled and
  the running sandbox takes a hold for idle time.
- **At the allowance.** A new turn is refused before a sandbox is created or started, with the code
  `allowance_used` and a sentence that says what was used, what the allowance is and when it is whole
  again: "Today's 2 h of sandbox time is used up, so nothing was started. The allowance is whole again at
  00:00 UTC, in 5 h 12 min." Less than half a minute left is too little to start with, and is said so.
  Reading a session's changes, or pushing from the panel, when that would start a paused sandbox, is
  refused the same way. A turn that is running when the allowance gives no more is stopped at the end of
  the hold it has, never in the middle of one: the timeline gets a line ("Today's 2 h of sandbox time is
  used up, so this turn was stopped at the end of the time it held. The sandbox is suspended with its files
  as they are, ..."), Windlass is asked to stop as by the Stop button, the turn ends as interrupted, and the
  sandbox is suspended, which settles its time. What it ran while stopping is counted, and the entry says
  how far past the hold that was. A sandbox that runs with no turn in it is suspended when its hold cannot
  be renewed, with a line of its own.
- **When the user's actor does not answer.** A new turn is refused (`usage_unavailable`): nothing is
  started on a count nobody could check. A turn that is running goes on and the session asks again every
  fifteen seconds; if that never works, the hold it has is counted in full when it runs out.
- **Kept sandboxes.** A session that needs a sandbox it does not have is given a place with its first
  hold, in the same step, or is refused both (`too_many_sandboxes`: "You keep 5 sandboxes, the most an
  account may have, and this agent needs one of its own. Free one on the Usage page, ..."). The place is
  given back when the sandbox is removed: after `WLP_IDLE_DESTROY_MS` without use, with its agent, or by
  the user. The platform removes none to make room by itself, because a sandbox's workspace files go with
  it. An agent can always be created; what is refused is its first prompt.
- **The count is held against what exists.** A sandbox that was never made, or one removed at the provider,
  would leave a place taken for good. So before a place is given or refused, and when the usage page is
  opened, the actor asks the provider for the user's sandboxes (Docker: by the containers' labels; E2B: by
  the metadata `wlp_uid`) and corrects the count: a place with no sandbox behind it is dropped, unless it
  is younger than five minutes and its sandbox may still be being made, and a sandbox nobody claimed is
  counted, also past the cap, since it exists. A correction is logged (`[wlp] usage.kept_corrected`): it
  means something made or removed a sandbox without the actor being told. This is apart from the
  deployment's own cap on sandboxes running at once (`WLP_E2B_MAX_RUNNING`), which stays as it was.
- **The usage page** (`/usage`, from the line under the account on the home screen) is described for
  users in the [in-app docs](../web/src/docs/content/settings.md#usage). Implementation notes: the day's end
  is shown in the viewer's own time zone; "Free…" also lists a sandbox left behind by an agent that no longer
  exists; and the agent whose sandbox was freed is told with its next prompt that its workspace is new.
- **Before the limit.** The home screen has the day's numbers in one line. A session says so above its
  composer when less than a fifth of the allowance is left, and the launch form when the day is used up or
  no place is left.
- **The factory's limits.** The usage page also lists what the factory may run for the user at once and
  what each work item may spend, "Set by this deployment's owner", and what each item has cost so far
  against its budget ([Work items](work-items.md)). A work item's hosted sandbox is counted here as any other.
- **The estimated cost** is the counted seconds times the provider's published price for the size of the
  deployment's sandboxes (`server/src/sandbox/e2b/pricing.ts`), and is labelled as an estimate with that
  price. On Docker nothing is billed by the second and nothing is estimated.

Where the count and E2B's bill can differ:

| What | The count is |
|---|---|
| The session measures by its server's clock, from before it asks for a sandbox to be created or resumed until after the pause is confirmed | a second or two over per stretch |
| E2B pauses an unused sandbox at its own timeout; the session counts to the moment that timeout was due | over or under by the seconds E2B takes |
| A server dies under a running sandbox: the hold is counted in full, while the sandbox ran for a part of it and then for up to `WLP_E2B_TURN_LEASE_MS` more | over by at most a hold, or under by at most the lease |
| The user's actor cannot be reached while a sandbox runs past its hold | under by the time past the hold |
| A sandbox E2B starts and the platform discards at once (the deployment's cap, a failed set-up) | over: the seconds until the refusal are counted |
| Sandboxes the platform's own checks start, and a template build | not counted: they are no user's |
| The price: one figure per second, for the size E2B last reported | an estimate either way |

On Docker a container that goes on running after its server died is not counted from the moment its hold
runs out until the session wakes, takes a new hold and suspends it. Nothing is billed there.

```sh
cd server && npx tsx ../scripts/usage-check.ts    # the rules on their own: holds, the day, reports, kept sandboxes, the count against the provider
```

The web app's mock plays a deployment with the default allowance and room for twenty sandboxes
(`?mock=1`), with a day's history that has one day at the limit; `&usage=low`, `&usage=used` and
`&usage=full`, or `__wlpMock.mockUsage(...)` in the console, play a day with little left, a day that is
used up and an account with no place left.

