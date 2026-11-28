# Work items

How the Factory carries a work item from the task to a pull request, and what a deployment sets for it. What
users see and do is in the in-app docs ([The Factory](../web/src/docs/content/factory.md)); this file is the
implementation and the operator's settings.

A work item is a task on a repository of the user's GitHub connection (two for a cross-repo feature) that the platform carries from the
start to a pull request by itself: a title, a description, and acceptance criteria, which are for the
person to check and which the verdict lists. Each item has an agent session of its own, listed with the
user's other agents, that only the item's steps send prompts to ("This agent works for a work item, whose
steps send its prompts. Answer the item, or send its work back with a note.") and that cannot be deleted
while the item has it; the item is cancelled instead, and the agent and what it did stay readable. An
item is filed from the Factory page, on its repository's Work view ("New work item…"), from a GitHub issue
(where the deployment has a webhook), from a mapped Linear issue or through the API below, and has a page
of its own (`/items/<id>`) with its step, its log, its verdicts and its cost. The home screen lists, under
"Needs you", every item that asks its person something.

## Turning work items on

Work items are off unless the deployment sets `WLP_ITEMS=1`. Off, the web app shows nothing of them (no
work items on a repository's page, no "Needs you" for items, no API tokens on the Settings page, and an
item's page is not found), the `user` actor's item and API token actions (`listItems`, `item`,
`createItem`, `actOnItem`, `apiTokens`, `createApiToken`, `revokeApiToken`) refuse with `items_off`
("Work items are not available on this platform."), `/api/items` answers 404, `not_found`, before any
token is read, and platform info has no `items`. Two things are not switched: `factoryLimits` answers
either way, since `WLP_FACTORY_HOSTED_RUNNING` is also the ceiling on a person's own hosted agents
([Usage and limits](architecture.md#usage-and-limits)); and the `workItem` actors and their tables stay, so an item that exists goes on
with its steps while the switch is off, and turning it off and on again loses nothing. While it is off,
nobody can file, read or act on an item.

## The list, and its pages

The `user` actor keeps every item's summary and sends the whole list to `listItems` without arguments,
for API clients and scripts. `listItems` also takes a page
(`ItemListPage`, `server/src/item-pages.ts`): at most `limit` items (25 by default, 100 at most), newest
filed first, after a cursor that is the last item of the page before (its `createdAt` and id, which never
change, so no item is skipped or repeated when states change), kept to ended items, one repository or
one way of filing where it says so. A page shorter than its limit is the last.

The live feed (`UserEvents.items`, after any change) and `itemFeed` (the web app's first read) carry an
`ItemFeed`, so that what is sent stays small however many items a user has filed: every open item, the
`ITEM_FEED_ENDED` (25) newest filed ended ones, which are exactly the first page of
`listItems({ ended: true })`, and counts: how many ended items there are, and for each repository and way
of filing how many are open, done, failed and cancelled. The feed and the counts hold the items the
whole list does: top-level items, and a feature's child while it asks a question. An old item that ends
is counted at once but is not carried unless it is among the 25 newest filed. The Factory page and a
repository's page say their ended items from the counts and read them from `listItems` a page at a time
when they are unfolded, each row with the day it was filed; Usage lists the items the feed carries and
says how many older ended ones there are. An item's page reloads when the feed carries it with a newer
revision, so an old ended item's page is read again only when it is opened or the feed reconnects.

### Linear intake

The Linear OAuth callback connects a workspace to the account. Its team mappings select one GitHub
repository per team. The signed issue webhook and a fresh read of the issue establish whether it
gained a `windlass`, `windlass-quick`, or `windlass:quick` label or was assigned to the app user. Human-authored issues arrive as drafts.
Issue intake deduplicates deliveries and shares the daily filing limit with GitHub. The platform posts
the PR link and the handover or terminal outcome, and requests the team's completed state only on
merge. A failed write is logged. Disconnect removes mappings and stops future intake; filed items stay.
See [configuration.md](configuration.md#linear).

## Where an item runs

For issue intake and the Factory composer, **Where work items run** takes the repository's setting, then the account's, then Hosted. A machine choice can save its agent, model, effort, profile and whether to wait or fall back to hosted Windlass. Any machine takes the first compatible online machine with room. Plan first uses Windlass to plan and can pass the saved machine agent and its model and effort to parts. A caller can also choose the place explicitly. With `WLP_MACHINES=1`, send `"place": {"kind": "machine", "machineId": "…"}` with the item. Its session
uses the requested `profile` if the machine offers it, otherwise the first available profile in its
last report. The runner must have reported an available profile at least once. When a turn is due
and the machine is offline or does not answer, the item waits without spending its budget and resumes
when the runner answers. Removing the machine stops outstanding work and asks the person to give up
or hand over the commit the run already pushed.

## How an item runs

- **The sequence is fixed** (`server/src/factory/blueprint.ts`). Which step comes next is decided from what
  the platform observed, never from what the agent says. A single item starts with a builder turn. The
  turn's own verification, the user's checks for the repository ([A repository's checks](github-and-repositories.md#a-repositorys-checks)), decides what
  follows. Failing checks or CI send the builder back with the evidence. A repeated failure after a fix
  asks the owner. The platform pushes the item's branch and opens the PR, retrying a network failure
  up to three attempts. A conflicting base can send the builder to merge it. CI waits with the sandbox
  paused. Without webhooks the platform polls every minute (three with more than ten open items);
  with webhooks the fallback intervals are five and ten minutes. A queued workflow can wait indefinitely.
  GitHub reporting a workflow in progress for over six hours, or CI still unreadable 90 minutes after
  the push, can raise a question. With no CI after ten minutes, the reader checks the last three
  default-branch commits for CI before treating the push as having none. In review the PR is polled
  every ten minutes (30 with webhooks). A merge ends the item as done, a close as cancelled.
- **The handoff on GitHub.** When an item is handed over, the platform asks the person for a review of
  the pull request, as the GitHub login of their connection, unless they are asked already, and posts the
  verdict in one comment: the verdict at the pushed commit, its sentence, and the acceptance criteria
  left to the person. The comment is the item's own (its first line is `<!-- windlass-item:<id> -->`), and
  each later handoff of the item edits it instead of adding another: the item keeps the comment's id once
  it has posted or found it, so a pull request with more than 1,000 comments gets no second one. A comment
  deleted on GitHub is posted again. A review request GitHub refuses is
  written in the item's log ("GitHub refused the review request (422).") and the comment is posted all the
  same; a request or a comment that does not get through otherwise is written there too ("Could not post
  the verdict comment (GitHub 502). The platform will try again.") and tried again later. Either way the
  item is in review: nothing on GitHub holds the handoff back. Both go through the app's installation,
  with a token for pull requests: write and metadata: read on that one repository, which the app's
  "Pull requests: read and write" covers.
- **Merging.** The owner merges by default. With the repository's `autoMergeSingles` enabled, an eligible
  single item can squash-merge after a passing verdict, passing CI and trusted approval with no blocking
  findings on the same head. The platform rechecks the head and base before merging. Features, parts,
  third-party input, foreign pushes and pending feedback require handover. If CI fails on a new push to a
  single item already in review, the owner can hand that head back to the builder or dismiss the question.
- **Turns are unattended.** An item's turn has nobody to ask: a tool call that would ask is refused at once,
  and the model is told so. A builder (Windlass, Claude Code, OpenCode or Codex) can instead ask the item's person with `ask_person`, which
  is answered at once, makes the item's question when the turn ends (`agent_ask`, at most 1 a
  turn), and resumes the step with the person's answer ([The platform's tools for every agent](#the-platforms-tools-for-every-agent)). On a machine using `docker-hardened`, Windlass runs shell commands unasked
  inside the runner's container. There is no per-command sandbox. The runner's egress policy controls their network access. With the model relay they see a turn placeholder. A builder turn has a backstop of 400 steps and a reviewer turn has 40. The agent is not given `publish`, since the
  platform opens an item's pull request itself; it is given `report`, to file what it did, in a title and a
  description that the platform puts on the pull request, and what it is unsure of, and `push` and
  `fetch_base` as a person's agent is ([The agent's own tools](github-and-repositories.md#the-agents-own-tools)): it may push the item's branch during its
  turn, and the item's publish step pushes whatever it did not. A turn in which the agent pushed counts as
  one that changed something.
- **When the item needs its owner, it asks.** The same failure again after a fix, a turn that
  changed nothing, a push GitHub refused, unreachable CI, a step whose turn was
  cut off three times (by a deploy or a restart), or the item's budget used up: the item waits for its
  person, for days if need be. A budget question offers more of the exhausted allowance. Where handover is available, “Hand it over as it is” keeps the work. A single item that has yet to push can push its workspace first.
- **The verdict** is what the work at the pushed commit rests on, made from what the session's gate
  recorded, the observations on the changes ([What a pull request shows was verified](github-and-repositories.md#what-a-pull-request-shows-was-verified)) and CI at that
  commit, never from the agent's words (`server/src/factory/verdict.ts`). CI decides; the user's checks
  are optional. `fail`: a check of the gate's run or CI failed; `incomplete`: the turn was stopped, failed
  or was cut off; `pass`: CI passed on the pushed commit, or, CI not having passed, the user's own checks
  passed in the gate's run with nothing changed after them; `unverified`: nothing verified this state of
  the work (no CI, CI in which nothing passed, CI unfinished or unread, and no run of the user's checks
  behind it), or the pull request holds a commit pushed after the agent's. A pass with observations is
  shown as needing a look. A pass on the user's checks while CI was not read begins "Your checks passed;
  CI has not been read." ("…CI had not finished." while it ran), never "Ready for review." A pull request
  someone else pushed to is handed over as it is, not verified, and its verdict is made again when that
  happens after the handover.
- **Limits are waits.** Nothing is refused for lack of room. An item that cannot go on now waits and says
  for what, with its numbers ("Waiting for one of your 3 hosted sandboxes that run at once: 3 running
  now."): a free place among the kept sandboxes, the day's allowance (until 00:00 UTC), one of the user's
  hosted sandboxes running at once, the deployment's cap on running sandboxes, or, on a machine, its
  runner's slots. A request is tried again when a turn is
  given back or one of the person's own agents goes idle, and otherwise after 30 seconds, then twice as long
  each time up to five minutes. Requests are taken oldest first, and an item has at most one turn
  waiting, so the items take turns.
- **One ceiling on hosted sandboxes.** `WLP_FACTORY_HOSTED_RUNNING` counts the person's own hosted
  agents at work and the items' hosted turns together ("Usage and limits"). A machine item's turn never
  counts and never waits for it: the machine's runner bounds it with its own slots, and queues turns past
  them. Kept-sandbox and time caps apply only to hosted items.
- **The cost of an item** is its tokens, cost-weighted (cached input at a tenth, `CACHED_INPUT_WEIGHT` in
  factory/budget.ts), and its hosted sandbox time, against its budget, with the tokens as reported, its turns
  and its working time beside them, on the item's page and the usage page. A machine item has zero hosted
  seconds. A budget used up is a question: "Give it N more" goes on in the same session and sandbox (a
  subtask's extra adds to its feature's budget), "Hand it over as it is" pushes the workspace first when
  nothing is pushed, "Give up". No choice throws work away.
- **One stuck detector.** Rounds of fixing are not capped. A fix turn for a failure the run already had a
  fix turn for (the same fingerprint of failing checks, CI, a base conflict, or the same blocking review
  findings) stops the run and asks. A backstop of 60 turns an item (`RULES.turnBackstop`) ends a loop that
  never repeats; 3 cut-off turns a step, provider-limit retries and push retries stay internal and mechanical.

**CI needs the GitHub App's three read permissions** ([The GitHub App](operating.md#the-github-app)). Without them, or before an
installation has accepted them, an item waits for no CI: it is handed over saying that CI was not read.

### The item's agent

`CreateItemInput.effort` is the reasoning effort of every turn of the builder, Windlass or not: one
the agent reported for the item's model (`checkItemEffort` in `server/src/account-models.ts`; a machine
harness model whose efforts come only once selected takes one reported for any model), else `bad_effort`.
It is kept on the session's `origin.effort` and on `ItemAgent.effort`; a Plan-first feature's children
take their subtask's agent choice, or the feature's (see [Subtask agents](#subtask-agents)). Left out, a builder runs at its agent's default and a planner at `plannerEffort`.

`CreateItemInput.harness` picks the builder: `windlass` (the default), or a machine harness by id
(`machineHarnesses` in `server/src/sandbox/harnesses.ts`) that the item's machine reports signed in (`signIn: "token"`; `makeSession` refuses
"none" and "unknown"). Each item turn checks the machine's report again before its sandbox opens
(`itemSignInRefusal` in `agent-session.ts`): a signed-out agent refuses the turn, and the item asks
with the login hint.
A machine harness runs Quick items and, except Codex (`subtasks`), Plan-first subtasks ([Subtask agents](#subtask-agents)),
never a planner, only on a machine, in a profile it has an item mode for (`itemModes`): Claude Code and
OpenCode in `docker-hardened`; Codex in `docker-windlass-sandbox` by default, or `docker-hardened` when
the filing names it ([docs/codex.md](codex.md#work-items)). It starts every turn in that mode, which never
asks (Claude Code `bypassPermissions`, OpenCode `build`, Codex `workspace-write` or `agent-full-access`), and the ACP
harness refuses the turn if that mode is not offered (`RunTurnInput.unattended`). A permission the
agent still asks for is allowed once, except Codex's on `docker-windlass-sandbox`, which is refused and
ends the step (`turn_ended.escaped`). The second reviewer uses the same agent, model, profile and place in its own session. The turn gets the same item text and platform notes (setup, fresh workspace,
snapshot), and of the platform's tools `report`, `ask_person`, `request_secret`, `push` and `fetch_base`, over MCP
([The platform's tools for every agent](#the-platforms-tools-for-every-agent)): it may push its branch
mid-turn, and the item's publish step pushes what is left, under the platform's lease, as for a Windlass
builder. The platform runs the repository's saved checks and
holds the turn to its step limit ([Checks and steps for Claude Code, OpenCode and Codex](#checks-and-steps-for-claude-code-opencode-and-codex)),
and the verdict reads them as it reads Windlass's gate.
Where the sign-in method decides how tokens count (Codex, `itemTokens: "sign-in"`), the filing keeps
the machine's method (`ItemAgent.signIn`), takes only `itemSignIns` (ChatGPT for now), and refuses a turn
when the machine reports another (`itemSignInChanged`).
`ItemSummary.agent` holds the harness, the model and what the agent reported: tokens counted against
the budget (`itemTokens: "budget"`), shown but not counted for a subscription, or "not reported";
the conversation's cost; Claude Code's 5h window at the first and latest turn, which it reports only
with a usage warning: the CLI's `rate_limit_event` has `utilization` only when it warns (status
`allowed_warning`), so `fiveHour` stays null on most items and the page says "Not reported"
(`server/src/factory/budget.ts`, `agentTurn`, `noteAgentTurn`). A turn of an agent whose tokens count
that reports none stops the item with a `budget` question and no way on but hand over or give up
(`unmeasuredTurn`); it is never taken as 0 tokens. The reported cost is shown, not capped.

An item's Windlass turn runs only in a sandbox whose Windlass takes host tools ("The agent's own
tools"). A single item starts by implementing; an
orchestrated one starts with a planner ([Feature orchestration](#feature-orchestration) above).

```sh
cd server && npx tsx ../scripts/factory-check.ts                          # the sequence, verdicts and budgets as tables of facts, and the reader of CI against the GitHub stand-in
cd server && npx tsx ../scripts/factory-e2e.ts                          # items through the real actors, on fake sandboxes and the GitHub stand-in
```

### Checks and steps for Claude Code, OpenCode and Codex

Windlass runs the user's saved checks itself (its verification gate, as required checks) and stops at
`_meta["windlass/maxSteps"]`. The ACP agents have neither, so the platform does both
(`HarnessCapabilities.checks: "platform"`, `steps: "platform"`), in every turn of theirs, a person's session's
as well as an item's:

- **When.** The ACP harness (`sandbox/acp-harness.ts`) takes a snapshot of the workspace before the prompt
  goes, and again when the prompt is answered with `end_turn`. A snapshot is a git tree written from a
  private copy of the index (the real index is not touched); `git diff` between two gives the changed paths.
  No change: no check, `not_needed`/`turn_unchanged`. Otherwise the checks whose `when` patterns match a
  changed path run (Bun.Glob, as Windlass reads them: `*` within a directory, `**` at any depth), every one
  where git cannot say what changed. None saved: nothing runs, and the turn is `none_set`.
- **How.** `sandbox/platform-checks.ts` runs each with `sandbox.run` (`bash -c`) in the session's
  directory, as the agent's user, for its `timeoutSeconds` (120 when unset), in the saved order, with no
  saved secret: these agents' own commands get none either. Saved values are taken out of the output, also
  split over two pieces of it.
- **Sending back.** A failing check (or one that timed out) sends the agent one more `session/prompt` in the
  same platform turn. The prompt says it is the platform's, and fences each failing check's command and the
  end of its output as data (`fence`/`data` of `factory/reviewer-task.ts`: no line of it can close the fence).
  That is the run's own text, like CI logs: no marker exists for these agents, so it is labelled only. At
  most `PLATFORM_CHECK_ROUNDS` (2) such prompts; a check still failing then ends the turn `unresolved`
  (`max_rounds`). A check that could not start is not sent back; when only such checks did not pass the
  turn ends `unresolved` (`not_started`). Steering is refused while checks run (the message waits for the
  next prompt), and stopping the turn stops the running check.
- **Codex on `docker-windlass-sandbox`** runs no check: a check would run what Codex changed outside its
  sandbox, with the container's network. Each check that applies is recorded as not started, with that
  reason (`unavailable`), as Windlass records a required check where no sandbox can run it.
- **The record.** What happened is handed to the session as the events Windlass records of its gate
  (`snapshot.taken`, `checks.finished` with `evidence`, `synthetic.appended` of origin `check_report`,
  `step.started`, `execution.succeeded` with `verification`; `RunTurnInput.onChecks`), which the turn's
  `VerificationLog` reads, so `meta.verified` and `turn.ended.verified` have the same shape as a Windlass
  turn's, and the item's gate and verdict read them the same way. The timeline gets a note per run. A turn
  whose checks ended `unresolved` ends `unresolved`.
- **Steps.** `sandbox/platform-steps.ts` counts each `tool_call` update with a new call id, over every
  prompt of the turn. The limit is the item's `maxSteps` (`RULES.maxSteps`, 400; the reviewer's 40). When the
  agent starts the call past it, the harness sends `session/cancel`, the turn ends `unresolved` with a
  timeline note, and no check runs. `turn.ended.steps` is the count in every ACP turn.

```sh
cd server && npx tsx ../scripts/harness-check.ts   # checks pass, fail then pass in round 2, fail to the end, nothing to run, Codex's sandbox, the step limit
```

### The platform's tools for every agent

One layer holds the platform's tools for every agent (`server/src/platform-tools.ts`): which a turn is
offered (`turnPlatformTools`, by the callbacks the session gives it), their declarations (`platformTools`
in `agent-publish.ts`), how a call runs (`runPlatformTool`), and where each may be served from
(`TOOL_REACH`). The handlers are the session's (`onReport`, `onAsk`, `onPush`, `onFetchBase`, `onPublish` in
`agent-session.ts`), built once for any agent, with the same cleaning and checks (`askPerson`, `fileReport`,
`pushRequest`, `publishRequest`). Only the transport differs:

- **Windlass** takes every tool as a host tool (`_meta.windlass.hostTools`, `_windlass/host_call` on the
  engine's connection). Windlass 0.6.0 ignores the MCP servers a client passes in `session/new`, and an MCP
  tool's result taints its session, after which an unattended turn's calls that send data out are refused.
  A host tool declared `read` with a trusted result runs in every approval mode, after taint, on every
  profile, so Windlass keeps host tools for all of them.
- **Claude Code, OpenCode and Codex** are given one MCP server, `windlass_platform`, declared `"type": "acp"` in
  `session/new` (MCP over ACP): each MCP request comes back as an `mcp/message` request on the agent's own
  ACP connection, which the platform answers (`PlatformMcpServer`). Claude Code's adapter (0.109.0) takes
  such a server itself and serves it to the CLI on a loopback HTTP endpoint with a per-connection bearer
  token; the image's managed policy allows exactly that endpoint (`allowedMcpServers` by `serverUrl`, the
  server's fixed id in the path), and the tools say to load at once (`anthropic/alwaysLoad`) rather than
  behind tool search. OpenCode (1.19.6) takes MCP servers only by URL, so its image runs it under
  `wlp-acp-mcp` (`sandbox/harness/shared/`), which does the same: it tells the platform the agent takes
  `acp` servers, swaps each for a loopback HTTP endpoint with an HMAC bearer token, and sends each request
  on as `mcp/message`. Codex's image runs the same bridge (`sandbox/harness/shared/`) in front of
  codex-acp, on the fixed port its `requirements.toml` allows ([docs/codex.md](codex.md#work-items)). An
  adapter that takes no `acp` server (an older image) gets none, and the timeline says which tools the
  turn lacks. Each image gives a call of the platform's tools up to an hour (Windlass's limit for a host
  call), since a publish waits for the person: Claude Code's wrapper sets `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`,
  OpenCode's config `experimental.mcp_timeout`, and `wlp-codex-app-server` the server's `tool_timeout_sec`.
  Claude Code's managed policy allows the platform tools by name, so Claude does not ask about them before the
  platform does.

A builder gets `report`, `ask_person`, `push` and `fetch_base`. A person's session on a connected
repository gets `publish`, `push` and `fetch_base`. Both can get `request_secret`: supplying a value
takes a separate owner action. A summary can file a report. A planner files a plan and the critic
files its decision through host tools. A reviewer gets `file_review`, through a host tool on Windlass
or once per turn over MCP on a machine agent. A call is answered only
while the turn's prompt runs; one before it or after it reaches no handler. Over MCP one turn may push
at most 5 times and fetch the base at most 3 times (`MCP_LIMITS`); a call past that reaches no handler,
the agent is told plainly, and the timeline says so. Every push, fetch and publish that came over MCP
says in its timeline line that any process in the sandbox may have made it (`MCP_CALL_WORDS`).

**What any process in the container can do, and why it is bounded.** A Windlass host tool is called by
the model through Windlass. The MCP endpoint is in the container, and any process there may be able to
call it: the repository's setup script, a test, a command the agent was talked into running. Its token
is in the agent's memory only (Claude Code's adapter hands it to the CLI over stdin; `wlp-acp-mcp` in
the session's parameters), and never on disk or on a command line, but a process of the same user could
read it from that memory. OpenCode also runs its own HTTP API on 127.0.0.1:4096 in the container, without
a password, through which any process there can drive the agent, and so reach these tools the same way.
So each tool served this way has to be bounded when such a process calls it:

- `report` files text for the person, which is a claim and never the verdict: whether the work is ready is
  decided from the checks and CI. The worst is a wrong report, which the agent's own later call replaces.
- `ask_person` puts one question per turn to the person, with the same redaction and hidden-character
  stripping. The person's answer goes to the next turn. The budget and turn backstop bound the run.
- `request_secret` asks for a missing variable by name. The person can save the value for the next turn
  or continue without it. The builder cannot request another secret once the run has had three questions.
- `push` commits the workspace and pushes it to the session's own branch, which the platform names. A
  call that names another branch is refused, however it spells it, and nothing else in a call is read but
  the commit message: no ref, force, lease or remote. The token is the platform's, minted for the one
  push and never in the container. The push runs from a private copy of the objects the platform staged
  and scanned for saved secrets, not from the workspace's Git configuration, so its remotes, refspecs and
  hooks are not used, and a workspace that rewrites GitHub's address is refused before any token. Under
  the platform's lease it replaces only the platform's own last push, never a commit anyone else pushed
  (`pushScript` in `server/src/github/git.ts`). So the worst is pushing what any process could already
  have put in the workspace to a branch that holds only this session's work: at most 5 times a turn, each
  of which runs the repository's push CI, as the agent's own pushes do.
- `fetch_base` fetches the base and the session's branch into `origin/*` with a read-only token, and
  changes neither the working tree nor a local branch. The worst is 3 fetches a turn.
- `publish` opens or updates a pull request under the person's name. Over MCP every call is put to the
  person, in any profile, never "for this session" and never unasked: the question says the request
  came from inside the sandbox and may not be the agent's (`agentPublish`, `publishQuestionWords` with
  `via`). The session's "Let the agent publish without asking" is refused for these agents. The worst is a
  question the person declines.

None of them hands anything to the container: no credential and no token, and nothing a process there
could not already do to the workspace. The endpoint lives as long as the adapter process, which is one
turn, so its token is worth nothing afterwards. This is the exposure Windlass already has on "Docker,
hardened", where its commands can write on the engine's connection and so call its host tools
([Known limitations](known-limitations.md)): there too a push is never asked about and a publish always
is. `server/src/github/git.ts` is what makes a forged push harmless, and `scripts/github-check.ts`
("a process of the sandbox that steers the workspace and calls push") checks it with real Git.

Over MCP, any process in the sandbox might have filed the review. Its findings can send work back to
the builder, but its approval cannot authorize a merge.

## Feature orchestration

**Plan first** is the default when orchestration is enabled. The web form, API filings without a mode,
and ordinary GitHub issue filings start with a plan for owner approval. Select **Quick** or send
`"mode": "single"` for one implementer. On GitHub, use the `windlass:quick` label or start the
command with `quick`. An issue labelled `bug` always runs Quick.

The planner reads the repository and proposes two to six subtasks with owned paths, dependencies,
acceptance checks and token budgets. Planning, summary and review share one item's own allowance.
Approval adds each part's budget to the feature's. A part gets between a tenth of one item's tokens
(at least 1,000) and one full item allowance. Switching to one implementer keeps the planning spend.
The approval question shows
the proposed split. A client can answer plan questions or edit the split using `edit_plan` with the
displayed version. `approve_plan` requires that same version and answered questions. On
`item_conflict`, fetch the item again. A single-item suggestion needs an explicit choice.

Approval requires saved checks and evidence of push CI on the feature branch. The platform opens
a draft PR on `windlass/feature-<item-id>` (an ordinary PR marked in progress if this single
repository refuses drafts). It snapshots the repository's `waitForCiOnEachPart` setting when the
branch opens. With the default off, parts join after local checks pass. CI on each new feature head
supersedes the previous result. A failure queues a fix part with the logs and diff; a repeated failure
asks the owner. Handover waits for passing CI on the assembled head. With the setting on,
approval also requires push CI on the planned part branches and each part waits for that evidence.

Up to three parts with integrated dependencies and disjoint owned paths can run at once. A part
without owned paths runs alone. Each has its own branch, placement and reserved budget. The
builder receives its brief, the original feature body (including issue text) and predecessor reports.
Integration is serialized by fast-forward or merge commit. A conflicting part updates from the feature
and goes through its gates again. Updating a single-repository feature from its target between
integrations can queue a separate part to resolve conflicts. After two failed attempts the owner
chooses whether to check the branch again or give up.

A note from the owner steers a running builder when possible, or goes with its next builder turn.
The item records the note and the reviewer receives it as an owner decision. A stopped part can trigger
a revised plan. Unchanged questions keep their approved answers; new questions and scope changes
need answers. Completed parts stay done. Cancelling the feature cancels its children.

A repository can enable `autoApprovePlans` for small plans. The independent critic must approve,
the usual preflight must pass, and parts needing explicit confirmation still go to the owner.
For a two-repository feature each repository must opt in. Each gets its own draft PR and CI policy.
The combined Actions run checks both pinned heads and records the approved merge order. See
[Cross-repo features](../web/src/docs/content/factory.md#cross-repo-features).

The user action `setMachineDetails` accepts `machineId`, `whenToUse` and `tags`. The planner sees
this inventory and the available machine capacity. A subtask needs a feasible, allowed placement at approval.
Runners that report per-slot capacity support multi-slot subtasks. At dispatch, a busy or offline destination can wait.
A removed or disallowed destination asks the owner to revise the placement, retry allowed places or give up the subtask.
Update the server before runners so it accepts the optional slot fields in the hello and inventory report. Older runners can keep serving single-slot work. `WLP_FACTORY_ORCHESTRATE=0` hides the filing control and blocks new orchestrated filings.

### Subtask agents

`PlanSubtask.agent` (`SubtaskAgent` in `server/src/contract.ts`) is `{ harness, model?, effort? }`. The
planner may propose it (`file_plan`'s `agent`; the inventory it is given lists `windlassModels` and each
machine's `agentModels`), and the owner may change it with `edit_plan`. `validatePlan` (`agentOf` in
`server/src/factory/feature-plan.ts`) takes `windlass`, `claude` and `opencode`, refuses Codex
(`itemHarnessProblem`), and drops a Windlass choice with no model or effort, which inherits the feature's.
An older plan's `needs.harness` is read as the agent. A machine harness with `needs.profile` other than
`docker-hardened` is refused.

Placement (`agentFit` in `server/src/factory/placement.ts`) refuses permanently, at approval and at
dispatch: a machine harness on hosted; a machine that does not report it, reports it not signed in
(`signIn` other than `"token"`) or does not allow `docker-hardened`; and a model or effort outside the
lists in `PlacementInventory.models` (`agentModelProblem`, the same `chosenModel` and `checkItemEffort` a
session is held to). `work-item.ts` fills those lists from the user actor's `internalAgentModels`: the
account's models for Windlass, each machine harness's catalog, or only its default where it reported none.
A list it cannot read is left out and the child's creation judges it. A placed machine-harness child has
`ChildPlacement.harness` and the hardened profile. Usage limits apply only where `limited[].harness` is
the subtask's agent, so overflow routes among accounts of that agent.

The child is made (`internalFeatureChild`, `childAgent` in `server/src/actors/user-items.ts`) with its
own harness, model and effort. A machine harness never gets the parent's Windlass model: its choice or
nothing (the agent's default). A Windlass subtask with no model runs the feature's model and effort; one
with a model runs only the effort chosen with it. A refusal of the child's session before it exists
(`bad_input`, `bad_model`, `bad_effort`, `bad_profile`, `harness_signed_out`) deletes the `child_launch`
pin and sends `placement_wait` with `refused`, so the feature asks `placement_refused` with the reason;
any other failure is retried. The child's budget counts by its agent (`itemTokens`, `unmeasuredTurn`), and
only counted tokens reach the feature through `child_update`.

Approval: `approve_plan` (and `answer` with `approve`) carries `agents`, the keys the owner confirmed.
`approveFeature` refuses (`bad_input`, "<title>: confirm that it runs Claude Code, which works without
asking.") unless it names every subtask still to run whose agent works without asking
(`unattendedKeys`, `worksWithoutAsking`). The planner reads untrusted issue text, so its choice of such an
agent is never approved without that confirmation; `approvalText` names each subtask's agent and says so.
The web card lists them under **Agents that work without asking** and keeps **Approve** disabled until
each is ticked. A re-plan's `file_plan` copies each approved subtask's agent, by key, over the
planner's. After approval, `set_subtask_agent` can change an unstarted part's agent, model and effort while the feature dispatches subtasks. Placement is checked again.

```sh
cd server && npx tsx ../scripts/orchestrator-check.ts   # mixed agents through approval and child creation, refusals, routing, re-plans
```

## Untrusted text

`server/src/factory/untrusted.ts`. Every turn that hands the agent text the platform does not vouch for
names its sources: `TurnPlan.untrusted`, then the `deliver` effect's `untrusted`, the inbox row's
`untrusted` column (JSON, default `'[]'`), and `RunTurnInput.untrusted`. `turn.ts` sends them joined and
cut to 200 characters as `session/prompt` `_meta["windlass/untrusted"]: { source }` when the engine lists
`windlass/untrusted` in `agentCapabilities._meta.windlass.promptMeta` (Windlass 0.6.0). Windlass then
records the source on the admission and taints the session before the turn's first step; its subagents
inherit the taint. An engine that does not list it gets the prompt as before, and `onUntrustedUnmarked`
puts one warning on the session's timeline (`untrustedUnmarkedNoted`). The labelled wording in the
prompt stays either way.

| Source | Set by | Words |
|---|---|---|
| An issue whose author is not the sender | `makeItem` (`FactoryItem.untrusted`), carried by `firstPlan` and the refused-turn resume | `issue #42 by @someone` |
| A Linear issue written by another person | `linearSources`, inherited by parts | `Linear issue ENG-123 by …` |
| CI logs | the `ci_fix` plan | `CI logs of abc1234` |
| G4 feedback with any writer other than the item's person (`batch.others`) | `takeFeedback` | `GitHub feedback from @a, @b` |
| The second reviewer's findings | `reviewFixPlan`, and the points riding along with feedback (`personFirst`) | `the second reviewer's findings on abc1234` |
| Every reviewer turn (the builder's report), with the item's own sources | `nextTurn` for `to: "review"` | `the builder's report on pull request #7` |
| Subtask reports: the feature's summary turn, a re-plan after a stopped subtask, the reviewer of a feature | those plans | `reports of the feature's subtasks` |
| A subtask's task: its feature's sources, and the reports of the subtasks before it | `internalChildRequest`, `internalFeatureChild` | `reports of earlier subtasks` |

The issue and feedback rows are someone else's text; the others are the run's own.

Not marked: the platform's own sentences, the item's body from the web app or the API, the person's
notes and answers (an `ask_person` answer resumes with `untrusted` cleared), the person's own feedback,
the planner's placement inventory, and the repository's files (the workspace, trusted by Windlass's
decision; a conflict turn's fetched base too). The agent's own `ask_person` question never goes back to
any agent; it is shown to the person as the agent's words. A provider retry replays the delivery's
sources (`ItemProviderRefusal.retry.untrusted`).

Two kinds (`thirdParty`, by the words' beginnings): someone else's (an issue of theirs, feedback with
another writer, and either as a subtask inherits it) and the run's own (CI logs, findings, the
builder's report, subtask reports).

One rule decides, for every agent, what a turn does with its sources: `untrustedTurn` in
`factory/untrusted.ts`. It takes the agent (`HarnessId`), whether it takes Windlass's marker
(`takesUntrustedMarker`: only Windlass), the profile, the sources and `unsandboxed`, and answers
`none`, `marked`, `labelled` (with the timeline's one note) or `stop` (with the refusal). The session
(`agent-session.ts`, `executeTurn`) asks it once per turn, for Windlass and for the ACP agents alike.

| Profile | Agent | The run's own sources | Someone else's |
|---|---|---|---|
| `docker-hardened` | Windlass | labelled (`hardenedUnmarkedNote`) | `stop`; run anyway: labelled |
| `docker-hardened` | Claude Code, OpenCode, Codex | labelled (`agentUnmarkedNote`) | `stop`; run anyway: labelled |
| any other | Windlass | marked (`unmarkedNote` for an engine before 0.6.0) | marked |
| any other | Claude Code, OpenCode, Codex | labelled (`agentUnmarkedNote`) | labelled |

On `docker-hardened` no agent can contain what such text talks it into. Windlass runs there with
approval `full`, a tainted session puts commands back in bubblewrap, and Docker's default seccomp does
not let it start, so every command would ask and be refused: it is told of no source. The ACP agents
take no marker anywhere and run every command without asking. A `stop` turn is refused before the
sandbox opens, with `hardenedRefusal(agent, sources)`, worded for its agent (`harnessName`), and the
`turn_ended` fact carries `untrustedRefusal`: those sources and the delivered row's text. The item asks
`turn_refused` with **Run it anyway** (`run_anyway`) and give up; the choice adds the sources to
`FactoryItem.unsandboxed`, says so in the agent's words (`runAnywayWords`), and delivers that same text.
A delivery whose sources of someone else's are all in `unsandboxed` carries `unsandboxed: true` (the
inbox's `unsandboxed` column), which the rule lets through, labelled only. A subtask starts with its
feature's (`internalChildRequest`). `e2b-open` runs its tainted commands in bubblewrap, which works in
its template.

An item turn with sources, or in a session Windlass has reported tainted (`meta.tainted`, from
`taint.noticed` and `taint.cleared`), hands the user's servers with `unasked` off. Every item turn
also sets `unaskedUntilTainted`: the layer stops answering for `unasked` servers at the turn's own
`taint.noticed` (`turn.ts`), so a call after the taint goes to the item's question and is refused.

```sh
cd server && npx tsx ../scripts/factory-check.ts      # "untrusted text": each turn's sources, by input; the hardened stop and Run it anyway for each agent
cd server && npx tsx ../scripts/untrusted-check.ts    # the session/prompt frame against a stand-in 0.6.0 and an older engine; the inbox column; the rule for every agent and profile
cd server && FACTORY_ONLY=ci,untrusted,reviewer npx tsx ../scripts/factory-e2e.ts   # CI fix, reviewer and review fix reach the fake Windlass marked; on docker-hardened the CI fix runs unmarked
cd server && WEBHOOK_ONLY="G3 a stranger" npx tsx ../scripts/webhook-check.ts       # someone else's issue, started by its owner; on docker-hardened refused, then run anyway
cd server && npx tsx ../scripts/mcp-check.ts                                         # (Docker) an item turn stops answering for unasked servers at its own taint
```

## The second review

With `WLP_FACTORY_REVIEWER=on`, top-level items get a separate reviewer session using the
builder's place, profile, agent and model. Feature parts are reviewed together on the feature PR.
The reviewer sets up on the pinned base and inspects the exact pushed head. Setup receives the
permitted setup secrets. Review commands follow the reviewer's profile. It reads the task,
evidence, builder's report and owner's decisions; both sessions count toward the item's budget.

A single item's blocking findings go back to its builder, then through checks, CI and review again.
A request for a person becomes a question. A feature's review is advisory. When there is no
reviewer, the item hands over with the reason. Auto-merge requires a Windlass host-tool approval
from a command-sandboxed reviewer. A review filed over MCP cannot authorize it.

On an open item or feature PR, an owner or writer can comment `/windlass review` on its own to
request a review of the current head, once per head and within budget. It posts a comment-only
GitHub review, with inline findings where possible, and leaves the item's step unchanged.

## Limits

The limits are the deployment's, set by its owner and overridable per user; a user cannot raise them, but gives an item more budget when it asks. A
setting that is not a whole number in its range stops the server when it starts.

| Limit | Setting | Default |
|---|---|---|
| A user's hosted sandboxes at work at once, their own agents and their items' together | `WLP_FACTORY_HOSTED_RUNNING` | 3 (at most 100) |
| A new item's budget: dollars where a key pays, points of the plan's 5-hour and weekly windows where a plan pays (each where the plan reports it), cost-weighted tokens where none can be measured, hosted sandbox seconds | `WLP_FACTORY_ITEM_USD`, `WLP_FACTORY_ITEM_PLAN_PCT`, `WLP_FACTORY_ITEM_PLAN_WEEK_PCT`, `WLP_FACTORY_ITEM_TOKENS`, `WLP_FACTORY_ITEM_HOSTED_SECONDS` | $5, 20%, 3%, 2,000,000 tokens, 7200 (2 hours) |
| Items a user files from GitHub and Linear together in a UTC day, drafts among them | `WLP_FACTORY_GITHUB_ITEMS_PER_DAY` | 20 |

An item's hosted sandbox counts against the user's daily allowance and kept sandboxes as any other ("Usage
and limits"), whose defaults are sized for a few agents by hand, not for many items a day.

## The API

A script files and reads items with an API token, sent as `Authorization: Bearer wlp_…`. A user
makes one on their Settings page (`/settings`), under "API tokens", with one or both scopes,
`items:create` and `items:read`; its value is shown once, the platform keeps only its SHA-256 digest
(`server/src/api-tokens.ts`), and it works until it is revoked there. An account keeps at most 20.

```sh
curl -X POST https://<name>.onrivet.dev/api/items \
  -H "Authorization: Bearer $API_TOKEN" -H "Idempotency-Key: $(uuidgen)" -H "content-type: application/json" \
  -d '{"repository":{"id":123456789},"title":"Fix the light","body":"...","acceptance":["The light turns off"],"start":true}'
curl https://<name>.onrivet.dev/api/items/<id> -H "Authorization: Bearer $API_TOKEN"
```

`POST /api/items` takes what the web app's form sends (`CreateItemInput`): `repository.id` is GitHub's id
for a repository of the user's connection, `branch` beside it names the base (the default branch when left
out), and `start: true` starts the item at once; without it the item is a draft until it is started. It
answers 201 with the item's summary. `GET /api/items/<id>` answers 200 with the item's page (`ItemView`).
Clients that previously omitted `mode` to launch one implementer must now send `"mode": "single"`.
Omitting `mode` selects Plan first and waits for owner approval when orchestration is enabled.
With `WLP_FACTORY_ORCHESTRATE=0`, omission selects Quick.
The `Idempotency-Key` header is the creation's key, by the rules of [A message sent twice](architecture.md#a-message-sent-twice): the same key
with the same body answers with the item the first attempt made, and with another body it is refused (409,
`idempotency_key_reused`). Invalid or out-of-scope tokens receive 401, `invalid_token`, within the applicable rate limits.
Rate limits return 429 with `Retry-After`. Every error carries `{ code, message }`.
See [Public HTTP rate limits](operating.md#public-http-rate-limits). Without `WLP_ITEMS=1` both
routes answer 404, `not_found` ("There is no such route."), whatever the token.

## Screenshots on work items

Screenshots are off by default. Enable **Allow screenshots for work items** in the repository’s
settings when the deployment allows screenshots. For feature subtasks, the approved plan must also
set `needs.screenshots` to true. Eligible builder and reviewer sandboxes use `windlass-platform-sandbox:shots`
on Docker or `windlass-platform-sandbox-shots` on E2B. The shots image extends the base with
Chrome headless shell, Playwright core, fonts and `wlp-shot`. Personal agents and items with
screenshots off use `windlass-platform-sandbox:latest` or the `windlass-platform-sandbox` template.

Each turn reads the current setting. Turning it off stops new screenshot filings on the next turn.
Turning it on while an item runs leaves its builder in its original sandbox. A builder created
without a browser keeps working without screenshots. Each new review gets a fresh sandbox
chosen with the current setting. Previously filed pictures stay on the item.

A builder can file up to four PNGs saved by `wlp-shot` in its clone’s `.wlp-shots/` directory. The platform uploads a private copy directly from the sandbox to the configured backup bucket. Each upload link covers one object, its exact length and its PNG content type. The platform checks the stored length and the first 33 bytes. The sandbox receives the link on standard input. Storage credentials stay on the server.

The default limits are 2 MiB per screenshot (`WLP_FACTORY_ATTACHMENT_BYTES`), 40 screenshots per item (`WLP_FACTORY_ATTACHMENTS_PER_ITEM`) and 1 GiB per account (`WLP_FACTORY_ATTACHMENT_ACCOUNT_BYTES`). Images must fit within 3840 × 8640 and 16,600,000 pixels. Captions take one line of up to 200 characters, and the optional page label takes up to 300. Reservations count against both quotas. A daily sweep removes abandoned reservations older than two hours and screenshots of items that ended more than 180 days ago (`WLP_FACTORY_ATTACHMENT_DAYS`). Deleting an item removes its screenshots. Storage failures are retried.

On the item’s page the owner’s signed-in connection calls `itemAttachmentLinks(itemId)`. The returned inline PNG links expire after ten minutes. API clients with `items:read` can GET `/api/items/<id>/attachments/<aid>` for a one-minute redirect. GitHub gets a link to the item page. If a Content-Security-Policy is added, its `img-src` must allow the private bucket’s origin.
