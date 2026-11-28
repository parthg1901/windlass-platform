# Known limitations

What the platform does not do, or does only in part, and why. Each item names the section that has the
details.

- **The local development engine is open.** The local Rivet engine that `scripts/dev.sh` starts accepts anyone
  who can reach port 6420, and its control-plane token is a fixed default. Do not expose it; for a real
  deployment use the [self-host kit](../deploy/selfhost/README.md) or [operating.md](operating.md).
- **ChatGPT sign-in for a hosted service needs OpenAI's agreement.** The flow used here is the one OpenAI
  documents for open-source, self-hosted apps.
- **The hardened profile does not ask about commands.** Windlass runs there with `--approval full`, since without
  its own sandbox every command would otherwise need an answer. Two exceptions: it asks before starting a
  project's MCP server, and after an MCP server's first result, which it does not trust, it asks about commands
  again ([A project's MCP servers](github-and-repositories.md#a-projects-mcp-servers)).
- **Prompts, agent creation and work-item creation accept idempotency keys.** For the work-item API, send the key in the `Idempotency-Key` header. Several other actions set a value,
  or go by something the call names (a question's id, a ticket, a secret's name), so a repeat does nothing
  a second time; some of them answer a repeat with a refusal where the first attempt had succeeded
  (`answer`: `no_question`; `deleteSession`: `session_not_found`; a new MCP server: `server_exists`). `stop`
  names no turn, so one that arrives late stops the turn that runs then. And three things a key does not
  mend: a server killed between the write of a message and the write of the session's state forgets that
  message's key, as it forgets that the turn was counted; a message Windlass admitted into a turn in the
  moment that turn ended is refused, and sent again it starts a turn; and a sign-in whose answer was lost
  has to be started again.
- **Signing out forgets the token in the browser only.** The token is good for 30 days, but an account taken off
  the invitation list, or a demo user once the demo is off, is refused at every call (`server/src/access.ts`).
- **Each demo sign-in leaves a small volume** until `sandbox/cleanup.sh` runs.
- **A user's limits are per account, and the demo makes accounts.** Every demo sign-in is a user of its
  own, with its own account limits, so where the demo is on, the two limits bound
  what one account uses and not what a visitor does. What bounds that is the deployment's own cap on
  sandboxes running at once (`WLP_E2B_MAX_RUNNING`).
- **Counted sandbox time can differ from the provider’s bill.** The count is the session's own measurement, and differs from
  the provider's bill by seconds in ordinary use and by up to a hold when a server dies ("Usage and
  limits" has the cases). Nothing compares the two by itself: the log has one line per entry, and E2B's
  usage page has the provider's bill. Where plans are enabled, the platform derives hosted minutes from its own ledger ([billing.md](billing.md#hosted-minutes)).
- **What a machine reports is what the platform shows.** A session on a user's own machine runs its checks
  there, and its pull request's section says that this is what that machine reported. The platform does
  not control the machine: whoever runs it can change what runs there and what it reports, and can read
  what its sessions are handed (the repository, the saved secrets it is sent, a turn's access token).
- **A machine that is offline when its user forgets the ChatGPT sign-in is never told.** The runners that
  are connected then remove the token files of running turns; an offline one keeps what it has until each
  token expires, within the hour ([Machines of your own](machines.md) says how its owner removes them sooner).
- **Pairing has one budget for the deployment.** The routes a runner calls see no client address they
  could trust, so the pairings that are started are limited per machine key and in 64 groups a key cannot
  choose. Someone who makes many keys can use up the deployment's starts for ten minutes; the machines that
  are paired already are not affected.
- **A machine's sandboxes are not removed by the platform.** Their disk is the machine's: the runner stops
  an idle sandbox and removes one only when asked, with its agent, with the machine's removal, or by
  `prune`.
- **Runner builds pin their sandbox images.** A new sandbox image means a
  new runner build, and until one is published a machine runs only a runner built there from a local
  sandbox image (`scripts/runner-build.sh`).
- **A day's allowance at the time it was used is not kept.** The history marks a day as at the limit by
  today's allowance, so after the setting changes an earlier day may be marked that was not at its limit
  then, or not marked that was.
- **A server that stops can leave a sandbox running for a few minutes.** A session has 4 of the shutdown's
  20 seconds to suspend its sandbox ([When a server stops](architecture.md#when-a-server-stops)); one that takes longer is paused by E2B at its
  own timeout, at most three minutes later, and billed until then (about $0.003 at the default size). With turn resumption disabled, a
  turn that does not close itself in 10 seconds is ended as interrupted when the session next wakes.
- **A deleted session's copy can outlive it.** When the bucket refuses its removal for about four hours, the
  platform gives up and names the object in the log; removing it is then the bucket's keeper's to do.
- **A browser's connection token cannot be withdrawn.** Whoever asks a server gets one, and it is good until it
  expires, an hour by default, for creating, listing, reading and calling this deployment's actors; what an
  actor then does for its caller is decided by the platform's own sign-in, as before. RivetKit's client puts
  the token in the address of some requests (`rvt-token`, or after the actor's id), where a proxy's log may
  keep it. A server whose token the engine refuses for another reason than its age goes on handing it out
  until half of its life is gone, or until the server is restarted.
- **An access token that was handed out stays valid until it expires.** Forgetting a sign-in removes it and the
  token files of running turns, but a token a command already read in the hardened profile works for the rest of
  its hour.
- **The test suites never call E2B.** They run the E2B provider on a stand-in for E2B's service. Live checks are separate, including `scripts/e2b-check.ts`, `scripts/e2b-backup-check.ts`, the live snapshot check and the E2B model relay check ([testing.md](testing.md#the-checks-by-what-they-need)).
- **A lost sandbox's files stay lost.** What comes back is the agent's memory of the conversation, not the
  workspace: the agent remembers files that are no longer there, and finds that out when it looks. A
  repository the session was launched with is cloned again.
- **A machine's copies of its agents' conversations are as private as the machine.** They are in a Docker
  volume of the runner's (`wlp-machine-<id>-backups`), not encrypted by the platform; whoever can read the
  machine's Docker volumes can read them. A deleted session's copy stays until the runner is next connected
  with a release that keeps copies, and removing a machine without "remove sandboxes" leaves them. The
  volume holds at most 2 GiB, after which new copies are refused, not older ones dropped.
- **A copy of an agent's memory is as private as its bucket.** It is not encrypted by the platform, and a
  server that dies in the moment between an upload and the write of its record leaves a copy the session
  does not recognise: a sandbox lost before the next turn's save then starts without its memory.
- **Daytona, Firecracker and agentOS are listed, not built.** Daytona does not wait on Windlass: a session on
  another machine would be handed a short-lived access token as the other sessions are. It needs a provider in
  the sandbox layer, an image with Windlass in it and an account. Firecracker needs a host with KVM and a guest
  agent; agentOS cannot run the Windlass executable at all.
- **Where commands are not sandboxed, a command can ask to publish in the agent's name.** It runs as
  Windlass's user and can write on the engine's connection to the platform. The platform therefore asks the
  user about every request in those profiles and never publishes unasked there ([The agent's own tools](github-and-repositories.md#the-agents-own-tools); a
  push is never asked about anywhere: a forged one pushes the workspace to the session's own branch, which the
  agent may do itself), so a task that is to publish while its user is away needs a profile whose commands Windlass
  sandboxes. What would close it: an engine that runs as another user than its commands, or one whose
  connection a command cannot write to. Claude Code, OpenCode and Codex have the same exposure on every
  profile: they reach the platform's tools over an MCP endpoint in the container, which any process there
  may call. So their publish is asked about every time and never unasked, their pushes and fetches are
  limited per turn, and the timeline says of each such call that any process may have made it
  ([The platform's tools for every agent](work-items.md#the-platforms-tools-for-every-agent)).
- **A work item's text is its agent's prompt.** Items from the web app and the API are their own user's
  words. An item filed from a GitHub issue that someone else wrote is a draft until its person starts it,
  and its agent is told to take the text as a description of what is wanted, not as instructions.
- **Claude Code, OpenCode and Codex take no marker for outside text.** Windlass is told the source of
  each turn's outside text and taints the session ([Untrusted text](work-items.md#untrusted-text)); these
  agents only get the labelled prompt, and run every command without asking. On Docker, hardened, where commands run directly in the container, someone else's issue or feedback stops their turn as it does
  Windlass's (below); CI logs, findings and reports still go to them labelled only.
- **On Docker, hardened, no agent is told of outside text.** A tainted Windlass there would refuse every
  command, since its sandbox cannot start under Docker's default seccomp, and the other agents have no
  marker. CI logs, findings and reports go labelled only; someone else's issue or feedback stops the turn,
  whatever the agent, until the person chooses **Run it anyway**, and then goes labelled only too, its
  commands not held by any sandbox of the agent's. Windlass on **Docker + Windlass sandbox** is the place
  for such work.
- **An item's verdict is as good as its repository's checks and CI.** The acceptance criteria are listed
  for the person and checked by nobody, and a repository with no checks of its user's and no CI is
  handed over `unverified`.
- **A pull request's section is as old as the last push.** It is written when the platform pushes, and
  once more after a turn in which the agent published. A turn that changes files and is not pushed
  leaves the description saying what was true of what is at GitHub.
- **What a turn wrote into Windlass's configuration can outlast it until the next turn.** The
  user's own MCP servers are written into Windlass's configuration file in the sandbox
  for a turn and removed when the turn ends; a server that dies in between leaves them there. The
  session's next turn takes them out before it writes its own, by the platform's list of what it wrote.
  Nothing reads the file in between: no Windlass runs between turns. The agent's own tools are not written
  anywhere: they are declared with each session's opening; a server called `windlass_platform` left there by
  a command is taken out (`server/src/windlass-config.ts`).
- **A user's own local MCP server starts unasked, outside the command sandbox.** With the model relay it can use the turn's placeholder. Without the relay it can read the access token. Windlass
  asks before it starts a project's server and not before one of its user's own configuration, and
  such a server is a process outside Windlass's sandbox around commands in every profile. The settings
  page says so before one is saved; nothing asks again in a session. On Docker with the Windlass
  sandbox profile, Windlass's data is the user's volume, with the records of the user's other sessions
  in it. A `docker-hardened` sandbox has a data volume of its own.
- **An account's secret reaches no MCP server where commands are not sandboxed.** In `docker-hardened`,
  `e2b-open` and E2B before its check, a server of the user's own that reads a secret does not start
  ([Account settings](github-and-repositories.md#account-settings)), for the reason a repository's secret for MCP servers is not handed over there.
  A value written into the definition itself would reach it, and is then stored and shown as written.
- **A server's definition is checked against a copy of Windlass's rules.** The keys Windlass takes
  for one server are repeated in `server/src/personal-servers.ts`. With a Windlass that takes a key
  the copy lacks, that key cannot be saved; with one that refuses a key the copy has, a saved
  definition would fail its user's turns until it is changed.
- **Personal servers have not run on E2B.** They were run with a real Windlass in local Docker
  containers, in both profiles; the E2B layer writes the same file through the same seam.
- **A subagent cannot ask to publish.** The platform acts on the calls of the session's own agent, as the
  engine reports them for the session. A subagent's calls are reported another way and are not acted on, so
  one that called the tool would wait until the tool's time is up and be told that the platform did not
  answer. This has not been tried.
- **An MCP server's secret cannot be kept from commands that are not sandboxed.** Where commands run
  without Windlass's sandbox (`docker-hardened`, `e2b-open`), and where it is not established that they
  are sandboxed (E2B before its check), a secret for "setup and MCP servers" is not handed to Windlass, so
  the repository's MCP servers go without it ([A repository's secrets](github-and-repositories.md#a-repositorys-secrets)). Windlass would not give a command
  the variable there, but a command of the same user reads it from Windlass's process. What would close
  it: MCP servers started with an environment that is not Windlass's own, or as another user.
- **A server that Windlass starts from its own record says nothing of secrets.** When a variable such a
  server reads is not set, no question is put, so the sentence about what would set it is not said: the
  panel lists the server as one that could not start, with Windlass's reason, which names the variable.
- **A project's hooks and language servers are not asked about.** Windlass holds those back as it holds back
  a project's MCP servers, and reports them the same way (`_windlass/hooks`, `_windlass/lsp`). The platform
  puts only the servers' question, so a project's hooks do not run and its language servers do not start.
- **An approval of a project's server is for its definition, not for its files.** Windlass asks again when
  the command, its arguments or its environment change, and not when the script that command runs does: that
  is Windlass's own rule. With the platform's record it reaches further than one sandbox: after a commit that
  changes the script and not the definition, the server starts without a question in every session of that
  user on that repository, new ones included, until the approval is forgotten or 30 days old. The question
  says so where the user approves. And on Docker Windlass's own record holds in all of a user's sessions
  ([A project's MCP servers](github-and-repositories.md#a-projects-mcp-servers)): another repository that defines a server of the same name the same way starts
  it unasked there.
- **Forgetting an approval does not reach where the server already started.** Windlass keeps its own record
  in each sandbox the server started in, for 30 days from that start, and has no way to take one back or to
  stop a server. So forgetting holds for the next session and the next sandbox; a sandbox that already
  started the server goes on starting it, and for that reason may do so past the day the panel names. On
  Docker that record is shared by sessions using the same Windlass data volume, and forgetting changes nothing until it has run
  out. Removing a session's sandbox is what ends it sooner.
- **An approval given in the panel starts nothing by itself.** No Windlass runs between turns, so the server
  starts with the session's next turn. "Not now" is asked again with every message that starts a turn, and a
  message sent while that question holds the turn is refused as "still starting".
- **The panel lists what the session last heard.** A server's state is what Windlass said in the session's
  last turn, not a reading of the sandbox now, and a definition that changed in the repository since is
  seen when the next turn starts. A server Windlass started from its own record is listed without the
  fingerprint of its definition, so the approval shown for it is the newest one of its name.
