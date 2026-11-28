# GitHub and repositories

How the platform works with GitHub, and what it keeps for a repository and for an account. Registering the
GitHub App is in [operating.md](operating.md#the-github-app). What users see is in the in-app docs
([Settings](../web/src/docs/content/settings.md), [Sessions](../web/src/docs/content/sessions.md),
[Sandboxes and security](../web/src/docs/content/security.md)).

- [GitHub](#github): connecting, tokens, the App's permissions and events, the agent's publish tools,
  replaced sandboxes, failures, testing
- Per repository: [setup command](#a-repositorys-setup-command), [checks](#a-repositorys-checks),
  [prepared environment](#a-repositorys-prepared-environment),
  [what a pull request shows was verified](#what-a-pull-request-shows-was-verified),
  [secrets](#a-repositorys-secrets), [MCP servers](#a-projects-mcp-servers), [the repository's page](#a-repositorys-page)
- Per account: [Account settings](#account-settings)

Two terms used throughout:

- **Saved for a repository** means kept in the user's `user` actor under GitHub's id for the repository (a
  rename keeps it), never read from the repository itself, where an agent can edit files. A session on a
  pasted address, or on no repository, has no setup command, checks or secrets of a repository.
- **Unsandboxed profiles** are `docker-hardened`, `e2b-open`, and E2B before its sandbox check has passed.
  There a command the agent runs is outside Windlass's command sandbox and runs as Windlass's user, so it can
  read Windlass's environment through `/proc`, write Windlass's configuration file in the sandbox, and write
  on the engine's connection to the platform (Windlass's standard output). In the sandboxed profiles
  (`docker-windlass-sandbox`, E2B with its sandbox promised) a command sees no process but its own and can do
  none of this. Where a promise does not hold by construction, the platform does not rely on it.

## GitHub

With a GitHub App of its own, a deployment lets a user connect GitHub, launch an agent on their repositories
(private ones included), and get the work back as a pull request. Without one the web app shows none of this,
and a repository is a public address pasted into the launch form.

- **Connecting.** "Connect GitHub" (account menu or launch form) opens GitHub in a popup to authorize the App,
  followed by GitHub's installation page if the App is installed nowhere the user can reach. GitHub returns the
  browser to `GET /github/callback` on a server's own port with a code. The server exchanges it, asks GitHub
  who this is and which installations they can reach, deletes the token, and sends the browser to the web app,
  which hands the result to the user's `user` actor. The popup posts the fragment to its opener with
  `postMessage` at its own origin and closes; the opener accepts it only from that origin, from a window it
  opened, in that shape (`web/src/state/github.ts`). If the popup is blocked, the page itself goes to GitHub
  and back, keeping the launch form's text: same state, callback and ticket. The connection is a GitHub login
  and the accounts the App is installed on. Disconnecting forgets it; uninstalling the App is the account
  owner's, at GitHub.
- **No user credential is kept**, not even a refresh token. Later GitHub work is done as the installation.
- **Launching.** A connected user searches their repositories in the launch form and picks a branch (default
  preselected). The session records what it was launched on; its sandbox gets a clone.
- **A pull request.** The panel's "Open pull request" commits what is uncommitted (the user edits the message
  first), pushes `windlass/<its title>-<the end of its id>`, and opens the pull request through the API; the
  panel then shows its number and state, and "Push changes" updates the branch. Each gets a timeline line
  ("Opened pull request #12 in acme/harbor from windlass/fix-the-light-3f9a2c, with 3 files."). Commits are in
  the GitHub user's name (`<id>+<login>@users.noreply.github.com`); the pull request is the App's, and its
  description ends with a section rewritten on every push
  ([What a pull request shows was verified](#what-a-pull-request-shows-was-verified)). The agent's own git has
  no credential; it asks the platform ([The agent's own tools](#the-agents-own-tools)).

### Whose installation it is

An `installation_id` in an address proves nothing
([GitHub says so](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)),
so the callback records nothing from the address: it asks GitHub, with the user's authorization token, which
installations that user can reach, and any the address names must be among them.

The browser returning from GitHub carries nothing about who is signed in to the platform. So a connection is
tied to its user by a `state` the user's actor issues and the server signs (`WLP_SECRET`): it names the user,
lasts ten minutes, and works once. Since a state alone would let someone start a connection and another person
finish it, the callback route records nothing itself: it hands the browser a signed ticket in the fragment,
which only the `user` actor of the named user takes, from a caller signed in as that user, once.

Signed `installation.created`, `installation.new_permissions_accepted`, `installation.unsuspend`, and
`installation_repositories.added` deliveries can add an installation after connect. The platform reads its
current account and suspension state from GitHub. An installation on a personal account attaches only to
connections whose stored GitHub user ID is that account's owner, whoever sent the event. An organization
installation attaches to connections whose stored GitHub user ID matches the sender. Repository permission
checks still apply. Repeated deliveries with the same GUID share one inbox entry.

An uninstall or suspension drops the installation from every linked user. `installation_repositories.removed`
keeps the installation and marks the user's connection refreshed, so every server discards its older lists
and permission answers. The next read from GitHub no longer lists the removed repositories, and an
installation token cannot reach them. A session that already cloned one keeps its clone and local commits,
but can no longer fetch or push it. A connection that is not linked in the webhook directory yet relies on
its cached lists expiring instead. **Reload** in the picker reads the repositories and permissions of the
user's known installations with installation tokens. **Reconnect GitHub** discovers other installations the
user can reach, including an organization installation someone else made.

The webhook directory (`githubHooks`) records each uninstall or suspension with the time its delivery was
received. It records a later activation the same way, and the newer record wins. Linking a user to
installations happens in the same actor and refuses one that is recorded as removed. A connection made from
a ticket keeps an installation only when GitHub listed it more than a minute after its last recorded removal.
So when a user connects while an uninstall is being delivered, the result does not depend on the order. If
the removal is recorded first, the link refuses the installation and the user's connection drops it. If the
link is made first, the removal finds the user and drops it. A suspension is checked against GitHub's current
state before it is recorded, so one delivered late, after its unsuspend, changes nothing. The order relies on
the servers' clocks agreeing to within a minute; on one host they do.

A user's connection is saved first and the directories are updated after. If a directory update fails after
the save, for example while recording a removal, the `user` actor retries it on a schedule: after 15 seconds,
then 1, 4, 15 and 60 minutes. After the last try it waits for the actor's next wake. The retry state is stored
in the actor, so a retry pending when the actor stops still runs.

### Who may do what

GitHub lists an installation for anyone who can open one of its repositories, so an organization member or a
single-repository collaborator reaches an installation covering more than they may see. Before it lists,
clones or pushes for a user, the platform asks GitHub (with the installation's token) what that user may do in
the repository, and acts only on read, or write to push. An installation on the user's own account is not
asked about. The launch form lists only repositories the user can read, and marks one they cannot push to.

A list has 20 seconds for all its GitHub calls together. When time runs out it shows what was found and says
GitHub was slow and some repositories may be missing; with nothing found, that GitHub could not be reached.

A server caches only an installation's repositories (one minute) and a user's rights in them (five minutes,
for the launch form's list only: launching and pushing ask GitHub then and there). Everything else is in the
user's actor or the ticket, so any server can serve any step of a connection, clone or push.

### Tokens

Three credentials exist. None is stored, logged, or put in a timeline item, an event or an error:

| Credential | Made | Good for | Where it goes |
|---|---|---|---|
| the App's JWT | signed by the server with the App's private key, per request | nine minutes; asking for an installation token | GitHub |
| an installation token | by GitHub, per step, for one repository and that step's permissions | an hour at most; one that went into a sandbox is revoked when its git command ends. The read-only ones of a work item's polls (the repository, its CI, its pull request) are kept in the server's memory and used again until ten minutes before they expire | below |
| a user access token | by GitHub, for the code a user's authorization ended with | two questions (who is this, which installations), then deleted at GitHub | GitHub |

| Step | Token permissions (one repository, plus metadata: read) | Token is in |
|---|---|---|
| listing repositories, asking what a user may do | metadata: read (the installation's repositories) | the server |
| listing branches | contents: read | the server |
| cloning | contents: read | the sandbox, for one `git clone`; then revoked |
| pushing | contents: write | the sandbox, for one `git push`; then revoked |
| the pull request | pull requests: write, contents: read (GitHub opens no pull request for a token that cannot read both branches) | the server |
| reading a commit's CI, for a work item | checks, statuses, actions: read, kept for the next readings | the server. A job's log redirects to GitHub's short-lived storage, fetched without the token |
| a work item's handoff: review request and verdict comment | pull requests: write | the server |
| a planned feature's handoff: marking its draft pull request ready for review | pull requests: write, contents: write (GitHub refuses the GraphQL `markPullRequestReadyForReview` to a token with pull requests: write alone, "Resource not accessible by integration"; REST has no way to leave draft) | the server |
| posting `windlass/verified` | checks: write | the server |
| an orchestrated feature's preflight: does push CI report on its branches | contents, actions, checks, statuses, pull requests: read | the server |
| reading an issue filed as a work item | issues: read | the server |
| commenting on that issue | issues: write | the server |

**In a sandbox** the token reaches only the one git command the platform runs (`server/src/github/git.ts`):

- It goes on the command's standard input, never in an argument or environment variable on the server (where
  it would show on a `docker exec` command line) or in the sandbox. The script keeps it in an unexported shell
  variable and passes it on a pipe to a credential helper set in git's environment configuration, which
  answers only for GitHub's host, as the HTTP password of `x-access-token`
  ([GitHub's docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)).
- Authenticated git runs as a separate transport user: `docker exec --user 65534:65534` on hosted Docker and
  machine runners (which must support this option), the template's `nobody` on E2B. Each operation gets a fresh
  0700 directory under sticky `/tmp`, a platform-made repository and system binaries; a successful clone or
  fetch is copied into the workspace afterwards.
- The transport clears the environment, disables system and global git configuration, and pins the runner's
  loopback proxy (or none), TLS verification and the system CA bundle. Redirects, SSH, prompts, hooks and
  recursive submodule pushes are off. Workspace config, includes, URL rewrites, push URLs and options, HTTP
  headers, alternate object databases, external helpers and inherited git, SSH, proxy and TLS variables have
  no input.
- The workspace user stages a candidate commit and exports a pack; the transport user indexes and verifies it
  and scans the history of the head the session holds. Right before each push it recomputes a SHA-256 digest of
  the outgoing object ids from the same head and confirmed boundaries, and git gets that head and one explicit
  refspec. Afterwards the workspace user installs the objects, branch and index. This costs time and temporary
  disk in proportion to the repository.

An agent's command can still list process arguments and temporary directory names, and change the workspace
and the staging files it owns (interrupting a publish, or changing the candidate before the scan). The
transport user's git directory, token pipe and scanned objects are protected by Unix permissions, which holds
as long as the agent stays unprivileged and its git executable and trust store stay under platform control.

### The App's permissions and events

The App asks for repository permissions only, and no more than the code uses (registration:
[operating.md](operating.md#the-github-app)). Each token asks for a subset, per step (the table above).

| Permission | Used for | Without it |
|---|---|---|
| Metadata: read | repository lists, a user's rights in a repository | GitHub adds it to every App |
| Contents: read and write | clone, branch list, the reviewer's checkout; the session's push and a feature's `windlass/…` branch; with Pull requests write, marking a feature's draft pull request ready for review | no push, so no pull request and no work items. GitHub has no narrower permission: an App cannot be limited to some branches |
| Pull requests: read and write | open and update the pull request; a work item's review request, ready-for-review and handoff comment; read: the reviews and line comments taken as feedback; write: the 👀 reaction on a taken line comment, and asking a writer to review again | no pull requests |
| Issues: read and write | read: take in an issue filed as a work item; write: the item's link comment and a refusal comment on the issue, and the 👀 reaction on a taken pull request conversation comment | read alone: issues and feedback are still taken in, and nothing is said or reacted at GitHub. None: no issue intake |
| Checks: read and write | read: a work item reads its commit's CI; write: posting `windlass/verified` | read-only: items read CI and hand over without the check ([Enable the Factory check on GitHub](#enable-the-factory-check-on-github)) |
| Commit statuses: read, Actions: read | a work item reads CI, a failed job's log, and whether CI runs on pushes (an orchestrated feature's preflight) | the verdict says CI was not read, and orchestration is refused |
| Actions: write | rerun eligible interrupted jobs and dispatch a cross-repo feature’s combined workflow | CI can still be read with Actions read permission |
| Workflows | not asked for | GitHub refuses a push that changes `.github/workflows` |

Issues, Checks, Commit statuses and Actions are for work items only. No organization or account permission
is asked for.

**Events.** With `WLP_GITHUB_WEBHOOK_SECRET` set, the webhook is active at `/github/webhook`
(`server/src/actors/github-inbox.ts`, `HANDLERS`). Without it, items poll and no issue is taken in.

| Event | What the platform does |
|---|---|
| Issues, Issue comment | intake: a `windlass` label, or a mention in a comment by an owner, member or collaborator; other issue actions (closing, say) go to the item filed from it. On a linked PR, a conversation comment starting with the App's mention or `/windlass` can be feedback |
| Pull request | the item notices a merge or close at once |
| Pull request review | feedback: a submitted review that requests changes (with its line comments), or a comment-only review addressed to the App; an approval adds a line to the item's log |
| Pull request review comment | feedback: a line comment addressed to the App |
| Check run, Check suite, Status | the item notices CI ending at once |
| `installation`, `installation_repositories` | update [installation access](#whose-installation-it-is). GitHub sends them to every App |

Feedback counts only from the item's own person (the GitHub account linked to the item's Windlass account) and
from people GitHub reports as having write access. The association in the payload is checked first: a sender
that is not an owner, member or collaborator costs no call and is only counted. For the rest the platform asks
GitHub for the sender's permission (kept for 10 minutes), then reads the review or comment again by its id with
an installation token, so the payload's text is never used. A subject older than 3 days is not taken. Bots are
dropped at the edge. An item in review also reads its pull request's reviews, their line comments and the conversation comments
when it polls, with the same checks, and takes what no delivery brought ([Turn on feedback from pull requests](#turn-on-feedback-from-pull-requests)). What
the agent is told is in `server/src/factory/feedback.ts`.

**Reach is set by the installation, not the permissions.** Contents write holds for every repository an
installation covers. So install the App with **Only select repositories**, and give each such repository's
default branch a ruleset (block force pushes and deletions, require a pull request) with the App off its
bypass list. The platform pushes only `windlass/…` branches, so it keeps working and cannot write the
default branch.

A PR opened by an interactive session routes addressed feedback to that session. While a turn is
running, the feedback waits. A request on an item PR goes to its item. A stand-alone `/windlass review`
from a writer requests a comment-only review there ([The second review](work-items.md#the-second-review)).

### Turn on feedback from pull requests

Feedback needs no new permission: Issues and Pull requests are already read and write. It needs two more
event subscriptions.

1. Open **Settings → Developer settings → GitHub Apps → *your App* → Edit → Permissions & events**.
2. Under **Subscribe to events**, tick **Pull request review** and **Pull request review comment**. Leave **Issue comment** ticked, with the others already there. Do not tick **Pull request review thread**: it is not read.
3. Click **Save changes**. No permission changed, so the installations have nothing to approve.

Until then, no delivery comes. An item in review still picks up reviews and comments when it polls its pull
request: every 30 minutes with a webhook, 10 without.

### Docker clone mirrors

For connected GitHub repositories, the first successful clone can seed a bare Git mirror.
On later clones Git negotiates with GitHub using the mirror as a local object reference
(`--reference-if-able --dissociate`). GitHub supplies the current refs, including branch
deletions. The transport checks the resulting clone with `git fsck --connectivity-only` and
checks for alternates before copying it to the workspace. The session records the base through
the same independent GitHub confirmation used by a plain clone.

**What is trusted.** A clone takes objects from the mirror by their SHA-1 names, so the mirror
must hold no object whose content differs from its name. Two rules give that:

- Every session mounts its slot read-only. No process in a session container, the agent or
  the Git transport UID (65534), can write, rename or remove anything in a slot.
- Only a save helper outside every session writes a slot, and it rehashes every object first.
  The helper takes the clone's staged refs and objects as a tar stream from `docker cp`.
  It keeps only HEAD, packed-refs, packs with their indexes, and loose objects. It writes them
  under fresh names with its own config, so no alternates, hooks or other settings. It runs
  `git fsck --full` on the result and installs it only if that passes.

So a forged object under a genuine SHA, staged by anything that controls the session's
transport UID, fails the full fsck. It never reaches a later clone, and setup never runs on it.
That leaves two things a session can do to its own slot. It can put in valid but unneeded
objects or refs, up to the 512 MiB cap; a later clone only takes the objects GitHub's
negotiation asks for. It can also keep a mirror small or stale, which only makes later clones
slower. What remains trusted is Git's SHA-1 object naming with collision detection, as for any
fetch, plus the Docker daemon and the `git` and Python of the pinned base sandbox image. That
image runs the allocator and the save helper, never a session's own image, which for a prepared
sandbox is a commit taken after setup ran. The reference clone's
connectivity-only check is enough under these rules: the objects were rehashed when they were
installed, and nothing in a session can change them afterwards. A slot missing objects fails
that check, and the clone falls back to the plain path.

A Docker daemon keeps up to 16 slots of 512 MiB each in `wlp-git-mirrors-v2`. Each slot is
keyed by deployment, machine, platform user and immutable GitHub repository ID. Hosted Docker
keeps the mirrors' deployment identity in its own file in the state directory
(`git-mirror-deployment`), so mirrors work with snapshots disabled and never create the snapshot
identity that turns snapshot sweeps on. A runner uses its paired machine identity and user. A session gets just
its slot, read-only, as a volume subpath. UID 65534 owns that directory with mode 0700. The
volume stays out of prepared images. E2B sessions have no shared Docker volume and clone directly.

A short-lived allocator with networking disabled mounts the store and admits a slot. It waits
up to 3 s for another admission. It evicts the least recently used slot that is unlocked and
that no session container names. Stopped containers count, because Docker resolves the subpath
again on every start. Neither is a slot admitted in the last two minutes evicted, since its
container may not exist yet. When every slot is in use, the session clones without a mirror. A
slot that a container already names is mounted without running the allocator. Should a stopped
container's slot be gone anyway, its start puts back an empty slot and tries again. Below the
free-space floor that snapshots keep (keep-free: 40 GB by default, `WLP_KEEP_FREE_MIN_GB` on the
platform's own Docker, `--keep-free` on a machine), the allocator admits nothing and evicts unused slots.

Refresh happens on demand. After a successful clone whose base GitHub confirmed, the transport
stages its refs and hard links to its objects in its own private directory in the session's
`/tmp`. It skips this when the refs match the slot's mirror. The server, or the runner on a
machine, then starts the save helper without waiting for it: networking disabled, UID 65534,
no capabilities, only its own slot mounted (as a volume subpath), 1 GiB of memory and swap, and
its own 9-minute deadline inside the container. Saves run one per process at a time. A save still
waiting to start gives way to a later clone's stage for the same slot, so a slow save holds up
each slot once. The helper compares the refs again while it holds the slot's save lock, and
leaves a mirror with the same HEAD and packed-refs alone unless the clone marked its stage for
repair (the mirror had failed that clone). The stage is removed afterwards, and any stage
left by an interrupted save is removed at the start of the next clone. A save needs the
free-space floor plus 512 MiB free, because the old and new copies coexist until the swap. It
clears any `incoming` or `incoming.*` left behind, copies to `incoming.<n>` and waits for readers, which share the slot lock. Then it renames
`repo.git` to `old.<n>` and `incoming.<n>` to `repo.git`, and removes `old.*`. A save killed
between the two renames is repaired by the next one. A session's per-turn process sweep cannot
touch a save, since nothing of it runs in the session. A failed or killed save leaves the
previous mirror in place. A single-branch review clone only seeds an empty slot and never
replaces a full mirror.

A busy or missing mirror takes the plain clone path. A reference attempt that receives nothing
from GitHub for 8 seconds is abandoned. So is one whose mirror fails the lock, config,
alternates or connectivity check. Its token is revoked and a plain clone gets a fresh
repository-scoped read token. Any other failure (a timeout, a refused token, a missing
repository or branch) is reported as it is, without a second clone. The deadline does not cover
local work, so a large repository does not fall back for being large. A runner reports
mirror support only to a server whose control welcome names the `git-mirrors` capability. A
server names its capabilities only to a runner whose hello reports 0.3.0 or later, since older
runners refuse a welcome with fields they do not know. A runner or Docker daemon without
support takes the plain clone path.

### Enable the Factory check on GitHub

1. Open **Settings → Developer settings → GitHub Apps → *your App* → Edit → Permissions & events**.
2. Under **Repository permissions**, change **Checks** from **Read-only** to **Read and write** and click **Save changes**. Keep the existing event subscriptions, including **Check run**.
3. GitHub emails each installation owner. Each installation keeps its current permissions until its owner approves the update.
4. For a personal installation, open **Settings → Applications → Installed GitHub Apps → *your App* → Configure** and accept the request at the top. For an organization installation, open **Organization settings → GitHub Apps → *your App* → Configure** and accept there as well. Repeat for every installation.
5. GitHub sends `installation.new_permissions_accepted`. Windlass logs the delivery and posts on the next verification. Before approval, the item logs one permission message per run and still hands over its verdict, comment and review request.
6. Optionally require `windlass/verified` in a repository's branch protection rule or ruleset and select your App as its source. Enable auto-merge separately if desired.

[GitHub's installation permission approval guide](https://docs.github.com/en/apps/using-github-apps/approving-updated-permissions-for-a-github-app)

### The agent's own tools

So that an agent can get its work out without a credential, it asks the platform, which does the work with the
panel's own code and per-step tokens (`server/src/github/publish.ts`). The tools (`server/src/agent-publish.ts`,
`platformTools`) exist only in a session on a repository of the GitHub connection, on a deployment with an App:

| Tool | Does | Asked about |
|---|---|---|
| `publish` | commit, push the session's branch, open its pull request (or push to the open one and set the call's title and description; the title is the commit message when none is given). A person's session only | yes, unless the session lets the agent publish without asking; always in unsandboxed profiles |
| `push` | commit with the agent's message and push the session's branch, as often as it likes; no pull request | never, in any profile |
| `fetch_base` | fetch the base branch as `origin/<base>` and the session's branch as GitHub has it as `origin/<branch>`, with a read-only token, for a rebase or merge | never |
| `report` | a work item's agent files what it did, in place of `publish` ([Work items](work-items.md)) | — |

- **Calls.** They are Windlass *host tools* (its docs/acp.md, "Tools the client runs"), declared at every open
  or resume (`_meta.windlass.hostTools`, `server/src/sandbox/turn.ts`) as `read`, which Windlass never asks
  about; the platform does the asking. A call arrives as `_windlass/host_call` on the engine's connection and
  is answered for that turn's session while it runs, with what was pushed or published and the pull request's
  address, or why not, quoting GitHub's refusal or the user's note. Nothing of the tools is in the sandbox. They
  need a Windlass that takes `hostTools` (0.4.0 does; every sandbox made now has one). An older sandbox's turn
  fails with "This agent's sandbox is from an older version of the platform, whose Windlass cannot give the
  agent the platform's tools, so nothing was run. Start a new agent." (on a person's machine: install the
  current runner first); a work item's person is asked with that sentence.
- **What is refused.** A branch other than the session's (so the default branch is out of reach), a base other
  than the session's, anything a panel push is refused for, a call while another push or publish is handled, a
  call after its turn ended, and request text over its limit (title 120 characters, description and commit
  message 4,000 each), with the limit so the agent can retry. Control characters and saved secrets of the
  repository are taken out of a request before the user sees it or GitHub gets it.
- **Force only over the platform's own push.** A push is plain first. Only one GitHub refuses as not a
  fast-forward (the agent rebased) is retried with `--force-with-lease` on the commit the platform itself last
  pushed there (`pushScript`; the session keeps that apart from what a new sandbox's clone found). A commit
  anyone else pushed is never pushed away: the push is refused with a sentence saying to fetch and merge. Work
  items push the same way; the panel's push never forces.
- **Secret scan.** Every outgoing commit's message and patch is read as text, merges and binary files included.
  Only the session's base commit (kept in platform state and confirmed by GitHub, not the sandbox) and the
  observed head of the work branch can exclude history. A push is refused for a saved secret value (anywhere in
  the patch), a recognized credential shape (in added lines, messages and paths), or over 8 MB of history to
  check; the refusal names the credential kind and a safe path when it can. Encoded values can escape it. A
  missing base requires `fetch_base` first. After a refusal, the platform's own commit's changes stay in the
  workspace.
- **The workspace's `.git` cannot run a program.** Status, diff, probe, commit, scan, fetch and push use a
  private git directory loading only platform configuration (no system or home configuration, which a setup
  can write), with hooks, filesystem monitors, SSH programs, the home's attributes file, credential helpers and
  every transport but HTTP(S) off on the command line (`github/git-flags.ts`). The workspace's first commit, made
  as the sandbox's user before setup, reads no system or home configuration either. `scripts/git-config-check.ts`
  plants a program in every place a hostile `~/.gitconfig` and `.git/config` can name one and runs each script. The
  agent's objects, refs and index are copied in as data, keeping its commits, merges and rebases; files are read
  with directory-relative reads that refuse symlinks (a symlink contributes its target text). A `.gitattributes`
  filter has no driver there. Windlass gives sandboxed commands their own `/tmp`; direct commands share the
  staging user's. Still refused: a redirected git directory, program or transport settings in workspace config,
  gitlinks, nested repositories, incomplete scans and Git LFS repositories; git-ignored `node_modules` is
  skipped. Objects and refs are installed afterwards with file operations, after checking the repository, refs
  and index under git's locks; if another command changed them, the agent keeps its state and gets the remote
  result to reconcile.
- **Time.** A push or fetch may take five minutes; a publish is declared with up to an hour added for the
  user's answer.
- **A push starts CI.** It is the App's push, so GitHub runs the workflows for such a branch, with the agent's
  code and whatever Actions secrets they get, nobody asked. Workflow files cannot be changed (the App has no
  Workflows permission). Frequent pushes mean frequent CI.
- **The user's question** for `publish`, where tool calls' questions go: "Allow the agent to open a pull
  request?" (or "... to push to pull request #12?") with repository, branch and base, commit message, title and
  description; "Allow once", "Allow for this session", "Don't allow", and a note for the agent. No answer within
  `WLP_QUESTION_TIMEOUT_MS` declines; the agent is told, and the turn goes on. In unsandboxed profiles a command
  could have made the call, so every request is asked, says so, and offers no "Allow for this session"; `push`
  and `fetch_base` stay unasked there, since a forged one only pushes the workspace (which the command could
  change anyway) to the session's branch. That row is from reading the connection's design; a forged host call
  has not been tried.
- **"Let the agent publish without asking"** (`SessionSummary.publishUnasked`) is set in the launch form once a
  repository is picked, in the panel under "Pull request", or by "Allow for this session". It is per session,
  not saved with the repository like the setup command and secrets: it is a permission given to an agent, and
  saved per repository it would hold for later sessions nobody decided it for.
- **Timeline lines**, one per call. A publish's starts with who allowed it ("The agent asked to publish, and
  you allowed it once. Opened pull request #12 …"), or says it was not allowed or why it failed. A push's names
  the branch and commit and what the pull request's description reports ("… its description reports: 2 checks
  passed."), or GitHub's refusal. A fetch's names the branch fetched and where it went. An open pull request's verified section is rewritten after the
  push (the turn's checks have not run yet) and when the turn ends. With no pull request open, "Open pull
  request" opens one from what the agent pushed.

### When a sandbox is replaced

The new sandbox is cloned at the session's base branch and the setup command runs there
([A repository's setup command](#a-repositorys-setup-command)); only then, if the session's work was pushed, is
the workspace put on the session's branch as GitHub has it now (with anything pushed since; what was only in the
old sandbox is lost). The setup command never runs on pushed work, because it runs with the network and every
saved secret. Where setup ran, the timeline and the agent's next prompt say the workspace was put on the branch at
that commit after setup ran on the base, so the branch's dependency changes are not installed. If GitHub no longer has the branch (deleted after a merge, say), the workspace stays on the base and
the timeline says so. The agent's next prompt says the workspace is fresh.

A subtask runs setup at the commit where its feature started, also after replacement, then switches to the
integrated feature branch or its own published work.

### When it does not work

| What happened | What the user reads |
|---|---|
| GitHub says the user may read the repository and not write to it | "ada can read acme/quay on GitHub but not write to it, so the platform cannot push there for you. Ask an owner of acme for write access, then push again." Nothing is committed or pushed |
| a rule of the repository refuses the branch | "GitHub refused the push: a rule of acme/quay protects branches named like windlass/.... Let the GitHub App create such branches in the repository's branch rules, then push again." |
| the repository is gone, or no longer in the installation | "acme/quay is no longer on GitHub, or the GitHub App can no longer see it. ..." |
| the App was uninstalled from the account | "The GitHub App is no longer installed on acme. Connect GitHub again and install it there, then try once more." |
| the user disconnected GitHub | "GitHub is not connected any more. Connect GitHub again from the account menu, then try once more." A session launched on a repository stays, with its timeline and its pull request |
| the branch at GitHub has commits the workspace lacks | the push is refused rather than overwrite them, and the sentence says so |
| the push changes a file under `.github/workflows` | refused by GitHub (no Workflows permission); the sentence says so |
| GitHub cannot be reached | "GitHub could not be reached. Try again in a moment." |

A push that went through while its pull request did not (a missing permission, say) is remembered: the next
"Open pull request" only opens it.

### Testing without GitHub

No check calls GitHub. `scripts/github-standin.ts` stands in for its API and token endpoints, its authorization
and installation pages, and a git remote over HTTP in front of real bare repositories, with refusals written from
what is known of GitHub's, not copied from a run.

```sh
cd server && npx tsx ../scripts/github-check.ts           # the GitHub code and real git against the stand-in; also the agent's requests, tool declarations, publishWork and the agent's push
cd server && npx tsx ../scripts/github-check.ts --docker  # the git commands again in a container of the sandbox image
cd server && WLP_CHECK_SECTIONS=mirror pnpm exec tsx ../scripts/github-check.ts --docker --mirror-benchmark  # the mirror sections, and a 177 MiB repository
cd server && pnpm e2e                                     # its last section: the route and the actors, on the fake layer
```

`mcp-check.ts --report` calls the tools through a real Windlass. The fake layer's model calls `push`,
`fetch_base` and `report` when the prompt says "(push)", "(fetch)" or "(report)". The web app's mock plays a
deployment with an App (`?mock=1`; `&github=off` without), and
`__wlpMock.mockNextGithub("list" | "connect" | "denied" | "protected" | "gone")` makes its next call fail as
GitHub can. Not checked: GitHub's exact push refusals (the sentences above are chosen by them), what its
installation page does with a `state` for an account that already has the App, and that the post-installation
callback carries a code as documented.

## A repository's setup command

Sandboxed commands have no network without approval and write only in the workspace, `/tmp` and the session's
home, so installing dependencies in a turn means questions. A user can therefore save one shell command per
repository (`npm ci`, say), which the platform runs once in each new sandbox, after the clone and before the
agent's first turn there.

- **Never from the repository** (no `package.json` script, `setup.sh` or `.windlass/`): it runs with the network
  and outside Windlass's sandbox, so taking it from content would let a repository run code unasked. It runs only
  on the branch the session was launched from.
- **Set** in the launch form once a repository is chosen (saved with the launch), the session panel's "Setup
  command", or the repository's Settings. A change applies to sandboxes made after it (the panel says so). At
  most 2,000 characters; empty is none.
- **Runs** (`server/src/sandbox/setup.ts`) as `bash -c` as the sandbox user `agent` in the clone, with the
  sandbox's network, through the seam all platform commands use (Docker and E2B alike), under `wlp-run` so a
  stop reaches every child. On E2B the sandbox is held while it runs. Standard error is joined to standard
  output inside the sandbox, keeping order. Limit `WLP_SETUP_TIMEOUT_MS` (ten minutes).
- **Once per sandbox.** The clone marks it due; the session marks it done before it starts, so a server stopping
  under it does not cause a rerun. If it cannot be read from the user's actor when due, the turn is refused: the
  agent never works in a sandbox whose setup is still to run. After a replacement it runs at the base branch;
  dependency changes on the session's branch are left to the agent's own commands (without setup-only secrets).
- **Shown** where the clone's line is: the command, live output, how it ended and how long it took. An item at
  start and at end (`kind: "setup"`), `setup.output` deltas between on the model's streaming feed; the ending
  item keeps the last 32,000 characters. Stop stops it, and the turn.
- **On failure** (non-zero exit, timeout, stop, a server stopping under it) the turn goes on. Before the next
  prompt Windlass takes, the agent gets the platform's note, the command, how it ended and the last twenty lines
  of output; the timeline keeps the prompt as written.
- **Credentials.** It gets the repository's secrets ([A repository's secrets](#a-repositorys-secrets)) and no
  platform credential: the clone's token was revoked before it starts, and a turn's ChatGPT token file is written
  only when a turn starts Windlass, after setup, and removed when it ends. On Docker the token file lives on the
  container's private tmpfs (`/dev/shm`), never on the user's shared data volume, so one session's setup cannot
  read another session's token; on E2B it is on the sandbox's own disk. After setup and before each token
  handoff, every leftover process in the sandbox is killed, so nothing setup started can read a later token.
  A setup cut off with the server keeps running in the sandbox until the session's actor wakes again, which
  then kills what it left at once (`stopCutOffSetup`), not at the next prompt; a turn waits for that first.
  Commands in the hardened profile can still read the current turn's token file while it exists.
- **Not a place for a secret**: the command is shown in the timeline and given to the agent on failure. Read a
  saved secret (`$NPM_TOKEN`) instead; output is redacted.
- Files it makes that are not ignored appear under "Changes" and go into a push.

```sh
cd server && npx tsx ../scripts/setup-check.ts    # what it is saved for, the limits, what is kept, what the agent is told
```

The mock has a setup command for acme/harbor (`?mock=1`); one containing "fail" exits 1.

## A repository's checks

Windlass's verification gate runs, before calling a turn done, the checks that apply to what it changed, in the
agent's sandbox, and sends the agent back with what failed, three times at most (`checks` and `verify` in its
configuration; its docs/user-guide.md, "Verification checks"). With none, every turn ends "no checks configured".
So a user saves checks per repository (`npm test`, `cargo clippy`), and the platform hands them to Windlass for
every session on it.

- **A check** is a name, a command, a time limit (1 to 3,600 seconds; Windlass's default 120), glob patterns of
  changed files that trigger it (none: any change), and one platform setting: show the output's end in the pull
  request also on a pass. At most 20 per repository. A name Windlass would refuse, a duplicate name or a pattern
  starting with `!` is refused at save, since Windlass fails a turn whose checks it cannot read
  (`server/src/repository-checks.ts`).
- **Set** on the repository's Settings (`/repositories/<id>/settings#checks`). The list is saved whole by one
  statement that reads nothing first: of two concurrent saves one stays as sent, and neither undoes a setup
  command or secret.
- **Named at every open.** A turn reads them (with the secrets) and names them in `session/new` and
  `session/resume` (`_meta.windlass.requiredChecks`, `server/src/sandbox/turn.ts`; `outputTail: "always"` for
  output on a pass). Windlass holds them in its process only, with origin `session`, so a change applies from each
  session's next turn. The platform does not use `requiredChecks` in Windlass's user configuration file, which is
  in the sandbox and writable by commands in unsandboxed profiles; `checks`, `requiredChecks` and `verify` in that
  file are the platform's alone, and whatever a command left there is removed before every open.
- **How they gate.**
  - They run before the repository's own checks (which run too) and gate the turn whatever the repository's file
    says about `checks` (even empty) or `verify` (`mode` `off` or `report`, `maxRounds`). A repository check
    named like one of the user's is not run.
  - A turn keeps the checks it started with; a repository file the agent changes alters nothing for them, and the
    pull request says the file changed.
  - They run in the repository's root, patterns relative to it, whatever `.windlass/config.json` lies deeper.
  - A check whose command could not be started (say commands are sandboxed and no sandbox can run) is recorded as
    not started, with the reason. If every check that did not pass is one, the turn ends at once as unresolved
    (`not_started`) without sending the agent back, and the platform says nothing was verified and shows the
    reason as the thing to fix. Beside failing checks, the agent is sent back for the failing ones only, and the
    two are counted and worded apart.
  - A check added or changed (command, time limit, patterns) runs at the end of the next turn that changes any
    file, then for its patterns.
  - A subagent's turn runs none; the session's turn runs them over what the subagent changed.
- **Unsandboxed profiles.** Windlass runs checks there as it runs commands, outside its sandbox. A command's
  changes to Windlass's configuration file are removed before the next turn reads it, but a command can still
  reach Windlass's process and the engine's connection ("What it cannot say", below).

```sh
cd server && npx tsx ../scripts/verified-check.ts           # what may be saved, the configuration file, a turn's events, the section
cd server && npx tsx ../scripts/verified-check.ts --docker  # the same rules against the image's Windlass
```

The mock has two checks for acme/harbor (`?mock=1`, `/repositories/7101/settings`), one with patterns its turns
never match; a turn where all checks have patterns ends "no check covers what changed".

## A repository's prepared environment

A prepared sandbox (a post-setup snapshot, [configuration.md](configuration.md#docker-setup-snapshots)) used to be
saved as a side effect of a session's successful setup, and was never checked. A repository whose image could
not run its own checks (a pnpm that is not the one the repository pins, say) still got one, and every session
then started in it. A **prepared environment** is a snapshot that the platform builds on its own, runs through
the setup command and every saved check, and **promotes only when all of them pass**.

**The record.** One per user, repository and place (`hosted` or a machine's id), in the user's actor
(`environment` table, `server/src/environments.ts`). It keeps two parts:

- the **attempt**: the latest build's trigger, start and end, its base commit, image, the setup command's and
  the checks' digests, each check's result with its classification (`factory/check-environment.ts`:
  `package_manager`, `network`, `not_found`, else the code's), and the first failure's output excerpt;
- the **ready** part: the same facts of the last build that passed, with when it was built and validated.

Its state is one of `building` (an attempt is running), `ready` (the ready part matches today's setup command,
checks and image), `failed` (the latest attempt failed after the last ready one) and `stale` (the ready part was
built under another setup command, other checks, or an image the place no longer has). A failed build never
touches the ready part, and the image it made is never saved: the snapshot store keeps one image per user and
repository, so a failed build leaves the last ready image in place.

**Use.** A session or work item starts from a prepared sandbox only when the record for its place is ready
and current (`internalSessionSecrets`, `environment`). Otherwise it starts cold, as before, and the timeline
says so once. A session that starts from one has the line "Started from a validated environment" with the
commit and time. Ordinary sessions no longer save snapshots; only builds do.

**Builds.** A build is a hidden session of the user's (`SessionSummary.environmentBuild`, not listed) with the
repository's saved defaults (profile, screenshots), on the place it builds for. Its one turn opens the sandbox,
clones the default branch, runs the setup command, then runs every saved check once, ignoring `when` patterns.
It saves the snapshot only when all passed, reports to the user's actor and is deleted. It starts no agent, so
it is the same for every agent. It goes through the same gates as any session: the user's running-agent limit,
daily sandbox time and hosted places (`internalAcquireRun`, `holdSandbox`), a machine's slots, and on save the
snapshot store's own caps (E2B's per-user and total snapshot counts; a machine's `--snapshot-disk`,
`--snapshot-user` and `--keep-free`). A refusal is recorded as a note on the record ("waiting: daily sandbox
time is used up") and retried at the next trigger, never as a failed environment. One build per user runs at a
time; the rest wait in order.

**Triggers.**

| Trigger | When |
|---|---|
| Schedule | per repository: nightly (the default once a setup command is saved), every 12 h, every 6 h, or off (the default without a setup command). Nightly starts at a time between 01:00 and 05:00 UTC picked from the user and repository, so builds spread out |
| Push to the default branch | a `push` delivery, or a merged pull request into the default branch. Debounced: 10 minutes after the last push, and at most 60 minutes after the first |
| Rebuild | the button on the repository's Settings, for one place or all |
| A change | saving the setup command or the checks marks every record stale and builds again 2 minutes after the last save. A session whose ready record's image was not found at its place (the image changed or was evicted) marks it stale and builds again |

**Places.** A repository gets an environment where its own sessions and work items ran in the last 14 days, at
most three places, and only where prepared sandboxes are on: hosted when the deployment has `WLP_SNAPSHOTS` or
`WLP_E2B_SNAPSHOTS` on; a machine when its runner is connected on the signed protocol, offers the profile, and
its owner left "Let features use it" on **Any feature** (not **When named** or **Never**). A machine that is away is skipped until it is
back. Rebuild can name any such place. A repository with secrets never uses a prepared sandbox (unchanged), so
it gets no environment.

**A failed validation** is one the sandbox caused: setup failed, a check could not start, or check-environment.ts
classifies the failure ("the sandbox could not run `typecheck`: the image's pnpm is not the one the repository
pins"). Only that keeps the environment from being promoted, and the Settings section shows the failing check, its
classification and the end of its output. A check that ran and failed on the base commit's code (main is red) says
nothing about the sandbox: the environment is promoted anyway, and its record lists those checks
(`codeFailures`, "Ready · main's checks fail: lint").

**Snapshot keys.** The image is the snapshot store's, under its existing key (deployment, place, user, repository,
settings generation, dependency inputs, base image, profile, screenshots variant, network). A build asks for its
sandbox like any session (`sessionSandboxInput`), so a new part of the key, such as a sandbox size, reaches builds
by adding it to that input and to the record's sandbox fields beside `profile`; the record itself is keyed by repository and
place only.

**Follow-up, not promised.** Sessions of Claude Code, OpenCode and Codex start cold: reusing a snapshot is
Windlass-only (`canReuseSnapshot`). The builds themselves run no agent, so extending reuse to the other agents is a
change to that rule, not to builds.

**What a runner needs.** Builds use only what runners already do. A runner that names the `environment-image`
capability also says in a connect which image the sandbox was made from (`image`), which the record then shows
and compares. Older runners leave it empty, and an image change on them is found when a session misses the
ready image.

## A repository's network

Where the deployment's hosted sandboxes run on E2B with `WLP_E2B_NETWORK=restricted`, a repository can allow
hosts of its own: presets (`@node`, `@playwright`, `@gcs`, `@prisma`, `@debian`, `@ubuntu`, and those the deployment may
allow already) and exact names, on top of the model API, GitHub, the bucket and `WLP_E2B_NETWORK_ALLOW`
(`server/src/repository-network.ts`; how it is built is in [operating.md](operating.md), "E2B", "Network").
It is the user's, like the setup command: one row per repository in their `user` actor, by GitHub's id, never
read from the repository. Only that user can change it (`saveRepositoryNetwork`, or `allowHost` from a session,
which also changes the sandbox at once while a turn holds it, and otherwise from the next turn); what a session's sandbox could not reach is filed as a request
(`NetworkRequest`) that waits until it is allowed or dismissed. Every hosted session on the repository gets the
list from its next turn. The own session of a cross-repo feature (its planner, which reads both repositories,
and its summary) gets the union of every repository's list (`unionHosts`: the primary's list whole, then the others' hosts
while they fit in what the deployment's own hosts leave, `networkLimit`); each of its subtasks is on one repository and gets that one's. `scanRepositoryNetwork` reads the repository's manifests, lockfiles, install scripts
and CI files at the default branch and proposes what they name, with where; nothing it finds is saved until the
user allows it. "Delete what is saved" deletes the list and its requests too.

## What a pull request shows was verified

A pull request an agent opens says what the agent claims, so the platform ends its description with a section
built from what Windlass recorded, rewritten on every push (`server/src/verified.ts`,
`server/src/github/publish.ts`):

```markdown
<!-- windlass-platform:verified -->

### What was verified

The 2 checks that applied passed when the agent's turn 1 ended.

- **test** (`node test/add.test.js`), ada's required check: passed in 73 ms after the agent was sent back once.
- **smoke** (`node scripts/smoke.js`), from the repository's `.windlass/config.json`: passed in 41 ms.

Did not run: **docs** (`test -f docs/index.md`). No changed file matches its patterns.

The repository's `.windlass/config.json` says something about checks too. That holds for the repository's own checks: ada's checks are required, and that file can neither replace them nor switch them off.

To look at:

- Test files were deleted or renamed away: `test/sub.test.js`.

<sub>Written by Windlass Platform from what Windlass recorded of the session's checks, and replaced each time the platform pushes. It says what ran; it is not a review.</sub>

<!-- /windlass-platform:verified -->
```

- **Contents.** One sentence on how the gate ended in the last turn. Per check of the last run: name, command,
  owner (the user's GitHub login, or the repository's `.windlass/config.json`), result, duration, and how often
  the agent was sent back with it failing; required checks marked; saved checks whose patterns did not match;
  how the repository configured its own. The output's end (1,500 characters, at most six checks) for a check
  that did not pass or whose user asked. When nothing was verified, one sentence: no checks set ("Nothing was
  verified: no checks are set for this repository."), which file turned verification off, or that the turn was
  stopped first. No badge or tick, and it says it is not a review.
- **No check needed** (the ending's `reason`): "The turn changed no file." is told apart from "no check covers the
  files that differ from the state the checks last passed on, at the end of turn 1", and from a turn that changed
  files and put them back.
- **Files put back after a failure.** Windlass runs nothing more and names the verified state the files are
  again in and the run that passed on it (`since`). The section says no check ran again because
  the covered files are as they were when the checks last passed (naming that turn), adds a sentence on the run
  that did not pass (which check, how, how many send-backs) and that it says nothing about the work now, and lists
  the earlier run under "The checks as they passed when turn 1 ended:". The failed run's results and output are not shown, and nothing is flagged as changed
  after the checks unless an uncovered file differs. With no passing run, the state is the session's start ("a
  state no check has verified") and no run is listed. The run is located by its `seq` in Windlass's log; one the
  platform does not hold (an earlier turn left a check failing since) is not made up, and no turn is named.
- **Not started** (`could_not_start` with no exit code, and `startError`) is not a failure. If every check that
  did not pass is one (`not_started`), the section says nothing was verified, that this says nothing about the
  code so the agent was not sent back, and that the reason given with the check is what to fix; the line reads
  "was not started:" with Windlass's reason.
  Beside failing checks, the sentence counts those, adds that another was not started, and gives it no send-back
  count. Exit code 126 or 127 (command not found) is a check that ran and failed.
- **Sources.** Windlass's events, decided on fields, never sentences: `checks.finished` (each check's name,
  command, status, exit code, duration, retained output, `origin`, `required`, redacted `outputTail`); a message
  with origin `check_report` followed by `step.started` is a send-back (the same message after an ending that
  leaves checks unresolved, for whoever continues, is not); `execution.succeeded` (how the gate ended, why a turn
  ended with a check failing, why no check was needed and on what); `snapshot.taken` (each workspace state).
  Unknown keys are skipped and endings never compared whole. The result (`Verified`) is kept on the turn's ending
  item and in the session actor's state for the next push; a turn with no run keeps the last run's result and its
  turn.
- **What is looked for in the changes** (`workFlags`), once committed, by `git diff` from the merge base in the
  sandbox, with no program of the repository's choosing:

  | It says | When |
  |---|---|
  | Test files were deleted or renamed away | a test's file was deleted, or renamed to a path that is not a test's. A test's file is one named like a test (`*.test.*`, `*.spec.*`, `*_test.go`, `test_*.py`, `*_spec.rb`, `*Test.java`, ...), or code in a directory `test`, `tests`, `__tests__`, `spec` or `e2e` that is not under `fixtures`, `helpers`, `mocks`, `data` and the like. A test renamed to another test's path is not listed |
  | Tests were newly skipped or disabled | a test's file gained more of these than it lost: `it.skip`, `test.skip`, `describe.skip`, `.todo`, `xit(`, `xdescribe(`, `@pytest.mark.skip`, `skipif`, `xfail`, `@unittest.skip`, `pytest.skip(`, `@Disabled`, `@Ignore`, `#[ignore]`, `t.Skip(`. A marker that was there and still is, or one in other code, is not listed. A test commented out or deleted from its file is not seen |
  | What the checks run was changed in this work | the repository's `.windlass/config.json` says something else about `checks` or `verify` than on the base branch; or a script a check's command runs was changed (a file run by itself, handed to a shell, or handed to an interpreter as the program; not a file the command only names, and not a test's file); or the `package.json` script a check runs through `npm`, `pnpm`, `yarn` or `bun run` was changed. The checks are the user's and the ones that ran |
  | A check's command came to ignore an exit status | one of those three (a command in the repository's own list, the script, the file a command names) has more of `\|\| true`, `\|\| :`, `\|\| exit 0`, a closing `; true` or `; exit 0`, or `set +e` than before. A user's own command that always had one is not listed |
  | Files changed after the checks last ran | Windlass recorded another workspace state after the last run than the one it ran on (a turn stopped between a failing run and the next, or a later turn that changed files and ran no check); without snapshots, a call that can change files started after the run. Not where the files are again as the listed run passed them |

  When git could not be asked, the section says nothing was looked for.
- **Only the platform replaces it.** It stands between two comment lines at the end. On each push the platform
  takes the description from GitHub, removes everything between such lines and any stray line, and appends the
  new section: a user's edits at GitHub stay; a section an agent wrote does not. The lines' name is removed from
  commands and output, and output is fenced by more backticks than it holds, so nothing closes it early.
- **Redaction.** Saved secrets of the repository and account by value, and credential shapes by the GitHub
  layer's redactor (`server/src/github/redact.ts`). Windlass redacts credentials before recording output, and the
  platform removes saved values from each incoming event.
- **A push during a turn** comes before that turn's checks. The section then opens by saying so (that turn's
  changes had not been checked yet), then gives earlier turns' results. When the turn ends with nothing GitHub lacks, the section is rewritten without a push (the timeline
  says so); if files changed after the push, it waits for the next push.
- **In the session.** The turn's closing timeline line carries the same facts: each check's result and owner
  ("yours", "yours, required", "the repository's file"), send-backs or why not started, the user's checks that
  did not run and why, whom the repository's settings held for, files changed after the checks, the state the
  files are back on, and what did not pass before being changed back. Windlass's own run in the timeline says
  "not started", not "failed", for such a check. A push's line, and the repository's Work view beside each open
  pull request (`PullRequestInfo.verified`), say it in a few words: "2 checks passed", "1 of 2 checks failing",
  "nothing verified", "1 check passed (the repository's own)", "no check was needed", "no check covers what
  changed", "nothing verified, 1 check not started", "1 of 2 checks failing, 1 not started", plus "1 thing to
  look at" where flags are listed.
- **What it cannot say.** That the checks are good, or that a passing check tested what changed. In unsandboxed
  profiles a command can write on the engine's connection, so an agent set on it could forge the events; in
  sandboxed profiles it cannot.

**What a required check does not promise** (Windlass's docs/safety.md has it all). The command is the user's, but
what it runs is the repository's: `npm test` runs the `package.json` script and tests the agent can edit, which
the flags above watch. It runs only when a turn changes a file its patterns cover. An agent that says it cannot
make it pass, or runs out of send-backs, ends the turn unresolved, never done, and the section says so.

## A repository's secrets

A user saves values that must not be in the repository (a registry token for `npm ci`, an MCP server's API key,
a database address) per repository, each under an environment variable's name; the platform hands them to that
repository's sessions as environment variables, never writes them into the repository or workspace, and never
shows them again.

- **Storage.** One row per repository and name: name, scope, last change, and the value sealed
  (`server/src/signin/seal.ts`: AES-256-GCM under a key derived for this purpose from `WLP_SIGNIN_KEY` or
  `WLP_SECRET`, bound to user, repository and name, so a value moved to another row does not open;
  [Sign-ins](architecture.md#sign-ins) says what this protects against).
- **Write-only.** The value goes from the browser to the actor once; nothing sends it back. The list has names,
  scopes, dates and reach, and its query does not read the value column. A value can be replaced or deleted.
- **Rules.** A name is an environment variable's (letters, digits, underscores, not starting with a digit, at
  most 64 characters), and not one the sandbox, Windlass or platform commands rely on: `WLP_*`, `WINDLASS_*`,
  `PATH`, `HOME`, `LD_*`, `XDG_*` (Windlass's data), `BUN_*` and `NODE_*` (Windlass is a Bun program), `BASH_*`,
  `ENV`, `IFS`, `DOCKER_*`, `E2B_*`, the locale and proxy variables, and a few more (`isReservedName`,
  `server/src/repo-secrets.ts`). A value is 8 characters or more (shorter could not be redacted without ordinary
  words) and at most 16,384 bytes, multi-line allowed. 50 per repository, 2,000 per user.
- **Two scopes.** Every secret goes to the setup command. "Setup and MCP servers" (default) also goes to the MCP
  servers the repository names (read as `${NAME}`), not to the agent's commands. "Also the agent's commands" goes
  to those too; the interface explains that a manipulated agent could send out what its commands can read once
  one has network, and that command output goes to the model. The first scope keeps a value from commands, not
  from the model: a server tool that returns it has shown it.
- **How Windlass enforces a scope.** By its rule (`packages/core/src/sandbox/policy.ts`, `command.ts`,
  `mcp/config.ts`): an MCP server gets the variables its definition names; a sandboxed command gets all but
  credential-looking names (containing `TOKEN`, `KEY`, `SECRET`, `PASSWORD`, ..., starting `AWS_`, `OPENAI_`, ...,
  or `DATABASE_URL`, ...); an unsandboxed command gets all. The opener adjusts it with two name lists (its
  docs/safety.md, "A command's environment"): `withholdEnv` (no command, servers still) and `passEnv`
  (credential-looking, given to sandboxed commands anyway). The platform puts secrets in Windlass's environment
  and sends both lists with every `session/new` and `session/resume` (names only, not stored): every
  setup-and-servers secret goes in `withholdEnv`, and a commands secret with a credential-looking name in
  `passEnv` (`windlassEnvironment`). `looksLikeCredential` mirrors Windlass's filter, and
  `scripts/secrets-check.ts` compares them when Windlass's source is beside this repository. In sandboxed profiles
  this is exact: a command neither gets a withheld variable nor can read Windlass's process.
- **Unsandboxed profiles.** A command could read a withheld value from Windlass's environment, so a secret not
  for commands stays out of it altogether, and MCP servers go without:

  | The secret | Sandboxed profiles | Unsandboxed profiles |
  |---|---|---|
  | setup and MCP servers, any name (`NPM_TOKEN`, `SENTRY_DSN`) | setup command, MCP servers | setup command only |
  | also the agent's commands, any name (`PREVIEW_HOST`, `DEPLOY_KEY`) | setup command, MCP servers, commands | setup command, MCP servers, commands, also the ones Windlass sandboxes again once content from the web or an MCP server is in the conversation |

  Where a secret reaches less than its scope, the list says why for the session's sandbox or the one chosen in
  the launch form (`secretReach`). Not promised there: that an MCP server gets nothing it is not meant to.
- **When a change applies.** Secrets are read when a turn starts, and Windlass starts per turn, so servers and
  commands see a change from the next turn (a running turn keeps its own); the setup command, in sandboxes made
  after it. Deleting takes back nothing setup already made of a value.
- **In the sandbox.** Values reach processes in their environment, never a command line: on Docker the server
  only names it (`docker exec -e NAME`) and the `docker` client takes the value from its own environment, so
  listing processes does not show it; on E2B it is in the request that starts the command. The session's actor
  holds values in memory for one turn, never in stored state. Whoever can read a process's environment can read
  what it got: in unsandboxed profiles every agent command can, for Windlass and its servers.
- **Redaction.** Every saved value of the repository is replaced by `[secret:NAME]` in what leaves the sandbox
  layer: setup output (streamed and in its item), every turn event (tool output, model text, a question, a
  project server's description), the end of standard error, failure sentences, the failed-setup note, and log
  lines quoting them. A value split across two streamed pieces is held back until whole. The session's actor
  repeats it for every timeline item and the workspace diff. Windlass's own `[REDACTED:env]` for its
  credential-named variables comes first. Not caught: transformed values (base64, a part) and values of secrets
  deleted or replaced since.
- **Not protected from** a process that got the value: setup can write it into a workspace file (a `.npmrc`)
  that commands read and a push publishes; a server can send it anywhere; a commands secret a command prints is
  in Windlass's conversation record (sandbox and bucket copy) and goes to the model unless Windlass redacts its
  name.
- **Readers.** Only a session of the same user, for its own repository: `internalSessionSecrets` takes a service
  token for exactly that user and session and looks the repository up in the user actor's own index, not the
  call. It returns sealed values, opened by the server running the turn. Another user on the same repository has
  separate secrets.
- **Managed** in the session panel's "Secrets", the launch form ("Manage…" once a repository is chosen) and the
  repository's Settings: add, replace, change scope, delete. Value fields are password fields, empty when shown,
  multi-line values hidden the same way.

```sh
cd server && npx tsx ../scripts/secrets-check.ts    # names, limits, scopes, sealing, the list, redaction
```

The mock has four secrets for acme/harbor (`?mock=1`), each scope under a credential-looking name and another;
it stores only names and scopes.

## A project's MCP servers

A repository can name MCP servers in `.windlass/config.json`. Windlass does not start them by itself (a
repository must not choose a command to run); it asks, and the platform puts the question to the user where tool
call questions go.

- **When.** Before a turn's prompt, the sandbox layer asks Windlass which servers wait (`_windlass/mcp`). Each is
  a question with the name, command and every argument (or address), the defining file, and "Start it for this
  project" or "Not now". The session is `waiting`; an approved server's tools are there at the first model call.
  One reported mid-turn (`_windlass/mcp_changed`) is asked without holding the turn: approved, it starts at once
  and the model gets its tools next step; unanswered, the question ends with the turn. A tool call's question goes
  first; a server's question then comes back with its full time.
- **The question's first sentence** explains Windlass's "runs outside the sandbox, with your permissions" for the
  profile (`server/src/server-question.ts`): the server is a process in the sandbox machine outside Windlass's
  command sandbox, with network and access to Windlass's data directory, where the turn's token file is.

  | Profile | The question's first sentence |
  |---|---|
  | commands sandboxed by Windlass | "It runs in this session's container, but outside Windlass's sandbox around commands: unlike the agent's commands, it has the network and can read Windlass's own data, including the session's access token, which lasts about an hour and cannot be renewed." |
  | Docker, hardened | "It runs in this session's container, as the agent's commands do here: like them, it has the network and can read Windlass's own data, including ..." |
  | E2B before its check has passed | "It runs in this session's microVM and is never inside Windlass's sandbox around commands, whether or not that sandbox works here: it has the network and can read Windlass's own data, including ..." |

  A demo session has no access token, and its question says that instead.
- **Outcome lines** say the server started with how many tools (the agent has them from this turn), or that it
  was left stopped (the agent is told it waits for the user, and the next message asks again). No answer within
  `WLP_QUESTION_TIMEOUT_MS` is "not now".
- **Variables.** Windlass fills `${NAME}` in `env` and `headers` from its environment and will not start a server
  naming an unset one; saved secrets set them ([A repository's secrets](#a-repositorys-secrets)). The question
  names the secrets approval hands over ("Its definition reads the secret HARBOR_TOKEN saved for this repository:
  approving gives its value to the server.", or that it sends the value to that address); for an unset one, that
  the server will not start yet and which secret to save where (handed over from the next turn); or why a saved
  one is kept from servers in this sandbox. Approving such a server ends in
  Windlass's reason and that sentence. With no repository, it adds that an account secret of that name sets it,
  where the sandbox gives those to servers ([Account settings](#account-settings)).
- **Remembered approvals.** Windlass keeps one in its data directory for the project directory and exact
  definition for 30 days, but on E2B that is the sandbox's disk, so new sessions and replaced sandboxes would ask
  again. The platform therefore keeps its own (`server/src/server-approvals.ts`), reachable from every server:

  | What | Value |
  |---|---|
  | whose | the user's: one table in their `user` actor, plain rows, no credential |
  | the project | the GitHub repository by GitHub's id, when launched through the connection; the pasted address exactly as stored; or the session itself when it has no repository |
  | the server | its name and Windlass's fingerprint of its definition: a changed definition is asked about again |
  | until | 30 days after approval, like Windlass's. Use does not renew it; approving again does |
  | written | when the user says yes and Windlass took it. "Not now" is not remembered |

  A repository launched via the connection and via a pasted address is two projects. A session without a
  repository is its own project: the record spares it the question in a replacement sandbox and goes with the
  session.
- **Using a remembered approval.** For a waiting server with a matching record, the session has Windlass approve
  it (`_windlass/mcp_approve`) before the prompt, with a line saying it started because the user approved
  it for this project, how long ago, and with how many tools; Windlass's own record then covers that sandbox
  silently. If the user's actor does not answer within ten seconds, the question is put.
- **The panel's "MCP servers"** (when the project names servers) shows each with its full command or address, its
  state as last heard (running with N tools, waiting, could not start and why) and any remembered approval's end,
  with "Forget"; the repository's Settings list the same approvals. Forgetting removes the user's record for the
  project, whatever the definition, and the timeline says so. It cannot reach Windlass's own record or stop a
  running server (the protocol has no withdrawal or stop: only `_windlass/mcp`, `_windlass/mcp_approve`,
  `_windlass/mcp_changed`), and the section says so. A server left at "not now" has "Approve…": the dialog shows
  the command and file and what the question says. Windlass takes approvals while a session is open
  (`approveMcpServer` in `packages/core/src/engine/engine.ts`), but the platform runs one Windlass per turn, so
  between turns it records the approval and the server starts unasked next turn, as the timeline says. During a turn whose question
  about that definition is open, it answers it and the server starts at once. An approval of a definition the
  session no longer has is refused; the list must be reread.
- **Docker.** Windlass's data is the user's volume and every project directory is `/workspace`, so Windlass's own
  record starts the server in all of that user's sessions with the same definition, whatever the repository, and
  the platform's record matters only after Windlass's expires. The question and panel say "in all your sessions:
  they share Windlass's data". A `docker-hardened` sandbox has a data volume of its own
  ([machines](machines.md#per-session-data-volumes)), so there, as on E2B, Windlass's record stays in the
  sandbox and the platform's record is what the user's other sessions go by.
- **Tool calls.** Sandboxed profiles ask before every MCP tool call, through the platform's question. In the
  hardened profile the first call runs unasked; its result is untrusted content, so from then on Windlass asks
  before unsandboxable commands and the next MCP call. Only for the user's own servers can the platform answer,
  where the user said so ([Account settings](#account-settings)).

```sh
cd server && npx tsx ../scripts/mcp-check.ts    # a real Windlass in local containers, and fixtures/mcp-repo
cd server && pnpm e2e                           # the session's part, on the fake layer's "(mcp...)" switches
```

`mcp-check.ts` also tests the platform's record against a real Windlass, with one Docker user per sandbox (as
microVMs keep data apart): a second session and a replaced sandbox run the server unasked; a changed definition,
another user, another repository with the same server, a session after forgetting, and an approval past 30 days
are asked. The end-to-end test does the same through the actors, with the panel's actions. The mock asks for a
prompt containing "mcp" (with "variable", a server that cannot start; with "late" and a network word, while a
tool question waits), remembers approvals per project, shows every server state in `/agents/checks` and
`/agents/harbor-build`, and `__wlpMock.mockNextServers("list" | "approve" | "forget" | "slow")` fails the next
call or slows those calls for ten seconds.

## A repository's page

A connected repository is the project; there is no separate object. Its saved things are tables in the user's
`user` actor (setup command, checks, network list, secrets, MCP approvals, defaults), created on first save and gone once
deleted.

- **Agents** (`web/src/screens/Home.tsx`): the rail groups connected repositories by owner and
  includes repositories with saved settings. **Everything** shows **Needs you**, **Working now** and
  **Recent** across repositories. Choosing a repository opens its workspace.
- **Overview** (`/repositories/<id>`, `web/src/screens/Repository.tsx`): the repository's composer,
  sessions and work items. The Agents, Work items and Pull requests views have their own routes.
- **Settings** (`/repositories/<id>/settings`, `web/src/screens/RepositorySettings.tsx`): defaults for new
  sessions; work-item placement, approvals, CI mode and environment builds; whether its work items' agents take screenshots ([Work items](work-items.md)); setup command and
  secrets (the panel's `SetupEditor` and `SecretsBlock`); checks (`ChecksEditor`); remembered MCP approvals with
  when given, until when, and "Forget"; and one control deleting everything saved for it. Fragments open a
  section: `#defaults`, `#screenshots`, `#setup`, `#checks`, `#network`, `#secrets`, `#servers`, `#forget`. "New agent" opens
  the launch form with it chosen (`/repositories/<id>/new`, or `/repositories/<id>/settings/new`).
- **Saved versus usable.** What is saved (`repository`) answers from the actor at once. Whether it can be
  launched on (`githubRepository`) is GitHub's answer. A repository the user lost access to, or whose connection
  is gone, still opens, shows and edits what is saved, and says it cannot be used for new agents ("New agent"
  off); when GitHub cannot be asked, it says nothing is known and offers to retry. GitHub's answer relabels saved
  rows with the current name; a save for a repository nothing names yet asks GitHub for the name once (four
  seconds at most) and saves without it otherwise.
- **Defaults** (`server/src/repository-defaults.ts`): a sandbox profile and a model; not the effort, which the
  launch form sets per agent, nor publishing without asking, which is per session. Checked at save (the sandbox
  against the deployment, the model against the user's models, [Models](architecture.md#models)), then used only
  by the launch form, which starts from them and says so beside the repository. A choice in the form wins for
  that session. A default naming a sandbox no longer offered, or a model not in the user's list, is skipped, and
  page and form say so (for a list standing in for the plan's, "left out for now"). With none saved, the
  account's default holds ([Account settings](#account-settings)), as the page says under the field.
- **Concurrent saves.** A defaults save writes only the columns it names, in one statement without reading
  first, so concurrent sandbox and model saves both stay and neither undoes the setup command or secrets (other
  tables). Forgetting an approval goes through the approvals' own book.
- The page reads no secret value: `repository` counts them, and the list is the panel's.

```sh
cd server && npx tsx ../scripts/repository-check.ts   # the defaults' rules, and interleaving saves, against a SQLite database of its own
```

The mock (`?mock=1`) has defaults for acme/harbor (`/repositories/7101`), a default model no longer offered for
ada/tide-tables (`/repositories/7102`), a secret and no agent for acme/quay, and a repository the connection no
longer covers with a setup command, secret and approval still saved (`/repositories/7190`).

## Account settings

Account settings apply across repositories. On `/settings` (account menu; `web/src/screens/Settings.tsx`) the owner sets
defaults for new sessions, the user's own MCP servers, and the secrets those read. Each is its own table in the
`user` actor with its own actions (`account`, `saveAccountDefaults`, `savePersonalServer`,
`deletePersonalServer`, `accountSecrets`, `saveAccountSecret`, `deleteAccountSecret`). With work items, the page
also has the user's API tokens for filing them by script and, when configured, the Linear workspace
and team mappings ([Linear intake](work-items.md#linear-intake)). **Where work items run** stores the
place, fallback, and the selected machine agent's profile, model and effort. A repository can override it.

The user actor also exposes `modelProviders`, `saveModelProvider`, `checkModelProvider` and
`removeModelProvider` (`server/src/model-providers.ts`). It seals one key per provider and account,
checks the provider's catalog on save or recheck, and returns status with the last four characters
and up to 32 model IDs. The Settings screen uses these actions to add, check, replace and remove keys. No agent consumes a saved key at this revision.

### Defaults

- A sandbox profile and a model (`server/src/repository-defaults.ts`), under a repository's defaults' rules,
  concurrent saves included.
- **Order**, per field: the form's choice, then the repository's default, then the account's, then the
  deployment's first sandbox and the user's default model (`layerChoices`, `web/src/lib/repositories.ts`). An
  agent on no repository or a pasted address starts from the account's.
- **The form says** which defaults it stands on and whose each is, offers to undo a choice made over a default,
  and says of an unusable default that it is ignored, whose it was and where to change it. A repository's
  Settings say what an empty field comes to.

### MCP servers of the user's own

Defined once, available to the user's Windlass sessions (an issue tracker, a docs search), never read from a
repository (a repository's are in `.windlass/config.json`: [A project's MCP servers](#a-projects-mcp-servers)).

- **A server** is a name and a definition as Windlass takes one (its docs/mcp.md): `command` with `args`, `cwd`,
  `env`, or `url` with `headers`, plus `tools`, `timeoutSeconds`, `startupTimeoutSeconds`, `untrusted`,
  `enabled`, `protocol`.
- **Adding** (`web/src/components/PersonalServers.tsx`): one dialog. As JSON, the definition or a README snippet
  (`{ "mcpServers": { "<name>": { ... } } }`, `{ "servers": { ... } }`, `{ "mcp": { "servers": { ... } } }` or
  `{ "<name>": { ... } }`), whose name and definition fill the fields with a note of what was taken; a snippet
  naming several takes none and lists them to pick from. Or a form for an address with optionally one header
  reading an account secret (`Bearer ${DOCS_TOKEN}`), stored as `{ "url": ..., "headers": { ... } }`; anything
  more opens as JSON.
- **Saved as Windlass takes it** (`server/src/personal-servers.ts`). Windlass fails a turn whose configuration
  has an unknown key or wrong type before sending anything, so definitions are checked key by key at save
  (refused with the wrong key, in Windlass's words for an unknown one) and stored rebuilt from known keys; a
  stored row that fails is not handed to a turn. The key list copies Windlass's, which `scripts/account-check.ts`
  checks against Windlass's source when beside this repository.
- **Limits.** 20 per account, enforced by one insert statement so concurrent saves cannot exceed it or undo each
  other; definitions up to 8,192 bytes of JSON; names of letters, digits, `_`, `.`, `-`, up to 64 characters.
- **`windlass_platform` is reserved**, as is any name starting with it: the platform's server is written last,
  and anything under that name it did not write is removed.
- **Delivery** (`server/src/windlass-config.ts`, `server/src/sandbox/turn.ts`). Read with the secrets in one
  answer when a turn starts, written into Windlass's configuration file in the sandbox
  (`~/.config/windlass/config.json`) before the session opens, and removed when the
  turn ends. Other content stays; a same-named definition steps aside for the turn. The platform tracks what it
  wrote in `~/.local/state/windlass-platform-servers.json`. A change applies from each session's next turn,
  existing sandboxes included (each turn first removes leftovers from a turn whose server stopped under it); a
  deleted server stops starting; a running turn keeps its own. The page says so.
- **Starting is never asked about** (Windlass asks only for a project's servers), so what such a server gets is
  stated on the settings page, in the dialog before saving, and first in the question about a project's server
  (`personalServerReach`, `server/src/server-question.ts`), per sandbox the deployment can run: "It runs in a
  session's container, but outside Windlass's sandbox around commands: unlike the agent's commands, it has the
  network and can read Windlass's own data, including the session's access token, which lasts about an hour and
  cannot be renewed."
- **Tool calls without a question.** Sandboxed profiles ask before each MCP tool call, and every profile asks
  once untrusted content (a server's first result) is in the conversation. A per-server setting, off by default,
  lets its tools run without asking (`PersonalServer.unasked`, a column, never a definition key): Windlass still
  asks, and the sandbox layer answers "once" per call as for the publish tool (`permission`,
  `server/src/sandbox/turn.ts`), with a line under the call: "Allowed for you without asking: your settings let
  the tools of your MCP server "tracker" run that way." (item marked `question_allowed`).
  - *What is answered* is decided on Windlass's fields, not the question's text: the engine's `tool.called` for an
    `mcp_call` names server and tool, and the question names that call (`approval.messageId`, `callId`), is the
    session's own (not a subagent's), and needs exactly `{ "kind": "tool", "tool": "<server>/<tool>" }` in
    `approval.needs`.
  - *Whose server*: only one this turn wrote with the setting on and that the engine reports as the user's own
    (`_windlass/mcp`, `origin: "user"`). A same-named server in the repository's file is the project's to
    Windlass, and each call is asked. A Windlass that cannot say whose a server is gets no answers. A deleted
    server, or one with the setting off, stops being answered from the next turn.
  - *Trust*: the setting is not `untrusted: false`. Results stay untrusted (the model is told so, and from the
    first result on anything that can send data out is asked again). Since Windlass drops remembered approvals
    after untrusted content, the platform has it remember nothing and answers every call itself; in
    `docker-hardened` and `e2b-open`, from the second call on. Trusting output is Windlass's own
    `"untrusted": false` in the definition, a separate decision.
  - *The risk* is said in the dialog before saving: nothing stops to ask if something the agent read talks it
    into misusing that server's tools, which run outside the command sandbox with network.
  - A subagent's call is still asked.
- **No credentials in a definition.** It is stored unencrypted, shown on the page, written into a sandbox file
  and shown in the session panel. The dialog says to save credentials as secrets read as `${NAME}`, and flags an
  `env` or `headers` value, or a user name in an address, that looks written out. Logs hold only the name and
  whether it is a command or address.
- **In the session panel**, "MCP servers" lists them under the project's ("Yours, from your settings") with what
  Windlass said last turn (running with N tools, or why it could not start), nothing to approve, once the
  session has had a turn. A same-named server in the project's file is the project's and is asked about, unless
  defined word for word as the user's, which Windlass starts on the user's word.

### Secrets of the account

A repository's secrets ([A repository's secrets](#a-repositorys-secrets)) with another owner and no setup command
(`server/src/account-secrets.ts`).

- **Stored the same way**, bound to user, account and name (it opens neither as another user's, nor as a
  repository's secret of the name, nor under another name); write-only; the same name and value rules; 50 per
  account, enforced in one statement.
- **Scopes**, in the same column and values, with one rule (`secretReach`, `windlassEnvironment`): "MCP servers
  only" (default; the repository's "setup and MCP servers") is in Windlass's environment for `${NAME}` and in
  `withholdEnv`; "Also the agent's commands" also reaches commands, in `passEnv` where needed. A project's server
  reading the name gets it once approved, and its question names the account secret separately from the
  repository's. The scope changes without the value.
- **Unsandboxed profiles**, as for a repository's: a servers-only secret stays out, and a server reading it does
  not start; a commands secret is handed over and its server starts. Settings show each secret's reach for the
  chosen profile; the session panel says which reach servers, under one that could not start.
- **Same name as a repository's secret**: the session gets the repository's, value and scope, as the more
  particular choice. Both lists say so under the secret, and both values are redacted.
- **Redaction** as a repository's: every account value becomes `[secret:NAME]`, also where not handed over.

```sh
cd server && npx tsx ../scripts/account-check.ts   # defaults, names, definitions, the setting, limits under interleaving saves, sealing, scopes and reach, the configuration file
cd server && pnpm e2e                              # one step of its last section: through the actors, on the fake layer
cd server && npx tsx ../scripts/mcp-check.ts       # its section on a user's own server: a real Windlass asks about a tool, and is answered where the setting is on
```

The mock has two servers and two secrets for the account (`?mock=1`; `&account=empty` for none): a server whose
tools run unasked, one whose secret is missing, a commands secret, and one under a name acme/harbor also has.
Seeded sessions with a sandbox list them.
