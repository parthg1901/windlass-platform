## The Agents home

**Agents** is the home page. Your repositories are in a rail on the left, each with a small tile of its initials, grouped under their owner with the owner's GitHub picture. Choose an owner's row to fold its repositories away; your browser remembers it. A repository shows a lime ring while something on it runs and an amber count of what needs you. A quiet one, with neither, is dimmer and shows no count; one with only saved settings shows **saved**. **Active now**, above the owners, repeats the repositories with something running or asking. Hover a repository for **New agent here** and **Saved settings**. The foot of the rail shows today's sandbox time, what is working and the sandboxes you keep, and leads to **Usage**.

**Everything** at the top of the rail is one feed of your agents and work items: **Needs you**, then **Working now**, then **Recent**, each newest first. Each row shows its agent and model, a line on where it stands, its repository and when. **Answer** opens an agent that asks you something, **Open** a work item that does, and a finished one shows its pull request. A repository with nothing going on does not appear here; choose it in the rail. **No repository** lists the agents that were launched without one.

Choose a repository to open it on the right, at `/repositories/<id>`. Its head shows what is running, what needs you, its agents, its work items and its default branch, with **Pull requests** and **Saved settings**. The field under it launches an agent on that repository. **Overview** shows its agents and a table of its work items, what needs you first. **Agents** and **Work items** show all of them; **New work item…** is under **Work items**.

Press <kbd>/</kbd> to search the rail, and the arrow keys to move through it. <kbd>Ctrl</kbd>+<kbd>B</kbd> (<kbd>⌘</kbd>+<kbd>B</kbd> on a Mac) hides the rail and shows it again. On a phone, the rail opens from the repository button at the top, with a strip of repositories under it.

### Filters

**Filter**, on the **Recent** heading of **Everything** and on a repository's lists, narrows the lists and the rail by status (**Running**, **Needs you**, **Done**, **Failed**), by agent, by where it runs (**Hosted** or one of your machines) and by kind (agent sessions or work items). The filters that are on show as chips; choose one to take it off. Your browser remembers the filters, and whether the rail is hidden, for your next visit.

## The session page

Each agent has its own page, at `/agents/<id>`. The bar at the top shows its title and its status. When it runs on one of your machines, it also says which one.

The page has two parts. The timeline of the work takes most of it. The side panel holds the details: the session, its sandbox, its tokens or usage, and its changes.

If the agent asks you something while its tab is in the background, the tab's title starts with **(?) Needs you**.

### Statuses

| Status | Meaning |
| --- | --- |
| **idle** | Nothing is running. Send a prompt to start a turn. |
| **starting** | The sandbox is getting ready. |
| **working** | A turn is running. |
| **needs you** | A question waits for your answer. |
| **stopping** | The turn is being stopped. |
| **paused** | The turn is waiting to resume: the server restarted, or its machine went offline. |

When a turn ends, its outcome is one of **done**, **done, checks unresolved**, **failed**, **stopped**, **interrupted** or **error**.

### When the server restarts or the machine goes away

On a deployment that turns it on, a turn that is running when the platform's server restarts is **paused**, not ended. It keeps its turn number, and it resumes by itself in a few seconds, once a server is back. The timeline says **Resumed after a server restart**, with how long the turn was paused.

A turn on your machine is paused in the same way when the machine shuts down or goes to sleep. It waits for as long as the machine is away. When the machine is back, the turn resumes by itself, and the timeline says **Resumed after the machine came back**. While it waits, the chip beside the offline banner says **turn paused**.

A resumed turn goes on from the agent's own saved session. The step that was running when it paused, such as a command or a model reply, may be done again. If the agent no longer has its conversation, for example because its sandbox is new, it is given the whole task again. That is this turn's message and what you sent since, the session's first prompt, and a short account of the earlier turns rebuilt from the timeline. The account is marked as a reconstruction.

What you send while a turn is paused is **held**: it shows with a **held** chip and goes to the agent when the turn resumes. **Stop** ends a paused turn at once, and it does not resume.

The time a turn is paused does not count toward its time limit. A resumed turn gets what is left of its limit, and at least five minutes. If the server stops three times in a row while a turn resumes, with nothing done in between, the turn is ended as **interrupted**.

A turn is **interrupted** when the server stops while it runs and it cannot be resumed. For a Windlass turn, its tokens are the ones its finished model requests reported before the cut. They count toward the turn, a work item's budget and the selected provider’s usage. For ChatGPT they also count toward your daily cap, and the timeline says how many there were. A request still under way at the cut is not counted. Other agents report their tokens only when a turn ends, so an interrupted turn of theirs counts none, and the timeline says so.

## The timeline

The timeline shows everything the agent does, live: your prompts, its reasoning (**thinking**, then **thought**), its tool calls and its answers. Each tool call shows its state, such as **running**, **done**, **failed** or **refused**.

Tool calls that finished one after another are folded into one line that says what they did, for example **Read 4 files, searched twice and ran 1 command**, with how many failed. Choose the line to see each call, and a call to see its input and output. A call that is running, asks you something, was refused or was answered stays on its own line, as do subagents and pushes.

Above the field, a status line says what is happening, for example **running `bun test` · step 3**, with a timer. If you scroll up, **Jump to latest** takes you back to the end. When you hide the side panel, the timeline stays in the middle of the page.

At the end of each turn, a summary line gives the outcome, the number of steps, the time it took and the files it changed. The tokens it used are folded behind **tokens** at the end of that line: choose it, or hover it, to see them. For Claude Code, OpenCode and Codex the line also gives how full the context is and the cost so far. The session panel shows the tokens too.

You can copy a prompt, an answer (as Markdown) or a code block with the copy button beside it.

### Blocked network requests

When the sandbox's network policy refuses a request, the turn shows one **Blocked network requests** row. It counts the refused requests and lists each destination as `host:port` (a hosted E2B sandbox sees only the name, so it shows the host alone), with how many times it was refused and when last. The first three are shown; **Show N more** opens the rest. The row updates while the turn runs. A session keeps 50 destinations; requests to any beyond those are counted under the list, not named.

Each destination says what can be done about it:

- **Allow for this repository**, on a restricted E2B sandbox of a repository agent. It adds the host to the repository's network list. While a turn is running, this agent's sandbox reaches it at once; otherwise it applies from the next turn, as it does for the repository's other hosted agents. **Network list** under the row opens the list, where the host also waits under **Asked for by its agents**. The agent and the repository's scripts choose what a command looks up, so allow only a host you expect.
- **Blocked by machine *name*'s settings**, on a paired machine. Its owner allows it by adding it to `--egress-domains` when starting the runner; **How to allow** shows the flag.
- **Only the deployment's operator can allow it**, for a hosted agent with no repository.
- A short reason for what is never allowed: a **private address**, **cloud metadata**, or the **provider policy**.

The session panel's **Sandbox** section says how many requests were blocked in the current turn; **Show** scrolls to the row. A work item's page rolls up its builder's and reviewer's blocked requests in its **Network** block, and its pull request description includes a count of them. A private, single-repository pull request can also name the destinations; public and cross-repository ones show counts only.

## Send a prompt

When the agent is **idle**, type in **Tell the agent what to do** and press <kbd>Enter</kbd>, or choose **Send**. <kbd>Shift</kbd>+<kbd>Enter</kbd> makes a new line.

A finished session is not closed. Send another prompt to go on from where it stopped. There is no separate resume step.

The model picker groups each agent's models by provider, with a small tab per provider to show only its models. The header of each group says whose credential pays: a plan, a Settings key, or the agent's own login on the machine. Windlass lists your ChatGPT plan's models and the models found when you checked a provider key in Settings. A Windlass session keeps its provider. Start a new session to change providers. The effort button beside the model sets the reasoning effort, for models that take one.

You can change the model within that provider, effort and mode before each prompt. While a turn runs, only the mode can be changed, and the change applies from the next prompt.

A **Codex** session also has **Plan mode** in the composer, beside the effort and the model. Turned on, the next prompt asks Codex for a plan, and it changes nothing; turned off, it does the work. It is set before a prompt that starts a turn, not while one runs. It is not the work items' **Plan first**.

## Steer a running agent

While the agent works, the field says **Steer it: add to or change what it is doing**. Type a message and press <kbd>Enter</kbd>, or choose **Steer**. The agent reads it after its current step. Your message is marked **steer** in the timeline.

- With **Claude Code**, if the turn cannot take the message yet, it is held. It shows **Sent when this turn ends.** Choose **Take it back** to remove it.
- With **Windlass**, if the turn cannot take the message, the field says so and keeps your text: "Your message is still here."

## Answer the agent's questions

In some modes the agent asks before it acts. The question appears at the tool call in the timeline, and in a dock above the field. The usual question is **May this call run?**

Choose one of the answers it offers. With Windlass, you can also decline with a note: choose **add a note**, then say why, or what to do instead.

A question waits 10 minutes. A countdown shows **declines in** and the time left. If nobody answers in time, the platform declines for you, and the timeline says "Nobody answered … within 10 minutes, so it was declined." The agent is told, and goes on. In one of the platform's own (hosted) sandboxes, which runs and is counted while it waits, an approval waits 5 minutes: then the turn ends, the timeline says "Nobody answered … within 5 minutes, so the turn was ended and its sandbox paused.", and the sandbox pauses at once. Send a prompt to go on.

The agent asks one question at a time.

A `request_secret` entry gives the variable name, the supplied reason, the connection that made the request, and where the value would be saved. In a Claude Code, OpenCode or Codex session, any program inside the sandbox can make the request. The platform cannot tell whether third-party text prompted it. Review the reason before entering a value through the secret action.

The value is saved with agent scope for the connected repository, or for your account when there is no connected repository. Account scope applies across your agents, subject to each sandbox’s secret delivery settings. An existing name in either applicable store must be managed under **Secrets**. In a plain session, starting another turn without supplying the value skips that name for the rest of the session. A plain session can request at most three secrets, one per turn. Keep values out of prompts and notes.

A card above the field asks for the value. It quotes the agent’s reason as its own words and shows the platform’s notice apart from it. **Add it and continue** saves the value, and the next turn receives it in its environment. **Continue without it** tells the agent to go on without it.

## Stop

Choose **Stop**, beside the field, to stop the running turn. It shows **Stopping** while it works. The conversation and the files stay. Send a prompt to go on.

With Windlass, you can also stop a single tool call: choose **Stop this call** on it.

## The side panel

### Session and sandbox

**Session** lists the title, id, state, agent, model, mode, number of turns, repository and when it was created. **Sandbox** names the sandbox and gives three facts: what the agent may run without asking, what its commands can reach on the network, and whether they can read the session's access token. On one of your machines, the network fact follows the machine's [network mode](/docs/machines#network-access). **How it is held** lists the layers that isolate it.

**Last start** says how long the last turn took to reach the agent's first output, and each part of that start: making or resuming the sandbox (on your machine, with the image check, and "pulled" when the runner downloaded an image), the repository's setup, the platform's own preparation, the agent's start, opening its session, and the wait for its first output. The four turns before it get one line each. A turn that ended before any output shows what it measured.

### Tokens and usage

For Windlass, **Tokens** counts input, cached, cache share, output, reasoning and calls, for the whole session and for the last turn. **Cache per call** charts how much of each of the last 40 calls came from the cache.

On hosted, each Claude Code, Codex or OpenCode turn gets a fresh relay placeholder for your Settings key. Removing the selected provider’s key disables Send until you reconnect it or choose an available model with another key. Hosted minutes accrue while the sandbox runs.

For Claude Code, OpenCode and Codex, **Usage** shows how full the context is, for example "38% used", and the cost so far when the agent reports it. Once a turn has answered with its tokens, **Tokens** counts them too, per turn: these agents report no single model calls, so there is no cache chart.

### Changes

**Changes** lists the files that differ from the last commit, each with its git status: modified, added, deleted, renamed or untracked. Choose **View the diff** to read the whole diff. You can copy the whole diff, or one file's.

## Open a pull request

The **Pull request** section appears for an agent on a repository from your GitHub connection.

1. Choose **Open pull request**.
2. Enter a **Title** and, if you like, a **Description**. The title starts as the agent's title. The description starts as the agent's last answer.
3. Choose **Commit, push and open**.

The platform commits the changes, pushes a branch named `windlass/<title>-<id>` and opens the pull request into the branch the agent started from. It is not opened as a draft. Your GitHub access is never given to the agent's sandbox: the platform does the push itself.

After that, the button is **Push changes**. Use it to push new work to the same pull request, with a **Commit message**.

On that pull request, anyone with write access can start a comment with `/windlass` or the GitHub App’s @mention, or submit a **Request changes** review. Windlass reacts with 👀 and sends the feedback to this session. If the agent is working, the feedback waits for its next turn. The prompt quotes each author’s words. Feedback from another writer is marked as untrusted where the agent supports it. On **Docker, hardened**, the session stops before running that text.

If the pull request has no linked session or work item, Windlass replies once to explain.

To push from the panel, wait for the turn to end. The agent can push its own branch during a turn.

### When the agent opens it

The agent can also ask to publish. It then asks **Allow the agent to open a pull request?**, or **Allow the agent to push to pull request #N?** Answer **Allow once**, **Don't allow**, or, in the Windlass sandbox profile, **Allow for this session**.

In the Windlass sandbox profile, the panel offers **Let the agent publish without asking**. In other profiles you are asked each time. Claude Code, OpenCode and Codex always ask you, in every profile, and never offer **Allow for this session**: they reach the publish tool from inside the sandbox, where another program could call it in the agent's name, and the question says so.

> **Note** Before it pushes, the platform looks for the values of your saved secrets in the changes. If it finds one, nothing is pushed, and it names the files.

The agent can also push its work to the session's branch, and fetch the branch it started from, without asking you. It pushes only to the session's own branch, never to the default branch. A commit someone else pushed to that branch is never pushed away: the push is refused, and the agent is told to fetch and merge it first. Claude Code, OpenCode and Codex can push at most 5 times and fetch at most 3 times a turn, and the timeline says of each such push or fetch that another program in the sandbox may have made it.

### What was verified

Every pull request the platform opens ends its description with a section, **What was verified**. The platform writes it from what Windlass recorded of the checks, not from what the agent wrote, and writes it again with every push. Text you add elsewhere in the description stays.

The section says:

- how the checks of the agent's last turn ended, and each check's name, command, whose it is, result and time;
- the end of the output of a check that did not pass;
- which of your checks did not run, and why;
- when nothing was verified, why: for example, no checks are set for the repository;
- under **To look at**, what a reviewer may want to check: test files deleted or renamed away, tests newly skipped, a change to what the checks run, a check's command that now ignores an exit status, or files changed after the checks last ran.

It ends by saying that it is not a review. A push the agent makes during its turn comes before that turn's checks, so the section first says that what the turn changed had not been checked yet. The platform writes it again once the turn has ended.

For a session on one of your machines, the section adds that the checks ran on that machine, and that this is what the machine reported.

### Continue in a new pull request

An agent works on one branch and one pull request. To take the work further in a separate pull request, choose **Continue in a new PR** in the side panel's **Pull request** section once the agent's turn has ended. A new agent starts with the same repository, agent, model, effort, mode, place and sandbox, in a new workspace on a branch of its own. The first agent and its pull request stay as they are.

The dialog asks where the new branch starts:

- **Start from** the repository's default branch, with none of the first agent's unmerged work.
- **Stack on #N**, offered once the first agent's work is on GitHub: the new branch starts from that pull request's branch, and the new pull request is based on it.

The new agent starts with a copy of the first agent's memory of the conversation when one is kept: in the platform's storage on a hosted sandbox, or on the same machine when its runner keeps copies. Otherwise its first prompt includes an account of the first agent's turns, which the platform reconstructs from the timeline. Text from someone else that the first agent saw stays marked as untrusted in the new one. The side panel's **Agent** section links the two agents with **continued from** and **continued in**, and the agent list marks the new one **continued**.

## The repository's setup command

Where the repository has a [setup command](/docs/settings#setup-command), it normally runs once in each new sandbox, after the clone and before the agent's first turn there. The timeline shows the command, what it prints as it runs, how it ended and how long it took. **Stop** stops it, and the turn with it.

**A repository that pins pnpm.** The sandbox has its own pnpm. Where `package.json` pins another version (`"packageManager": "pnpm@…"`), install with `corepack pnpm install` in the setup command: corepack then keeps that version, and the agent's `pnpm` runs it even where its commands have no network, as in Windlass's command sandbox. Without that, `pnpm` runs the sandbox's own version with a warning and never downloads the pinned one.

Hosted Docker and supported machine runners can reuse Git objects from your earlier clones of the same connected repository on that machine. GitHub still supplies the branch head at launch. Each session keeps its own complete clone, including after the machine evicts the mirror.

On deployments with prepared sandboxes enabled, a session starts from the repository's [validated environment](/docs/settings#environment) at its place when there is one that is ready: setup already ran there, and every saved check passed. The timeline then says "Started from a validated environment", with the commit and when it passed, and so does the Sandbox section of the side panel. It also needs matching dependency files, setup command, sandbox image and platform, and no repository secrets. Otherwise the session runs setup itself, as without one. Sessions no longer save prepared sandboxes; only environment builds do.

Hosted E2B deployments can enable the same for E2B sandboxes. The snapshot is kept at E2B for your account on this platform only, never for another user, and expires after 14 days. Changing the setup command, reconnecting GitHub or adding a repository secret stops it being used.

On a match, the platform fetches and checks out the session’s source and skips setup. The timeline and the agent’s first prompt identify the base commit that produced the build outputs. The agent can rebuild them if the source has changed.

If setup fails or runs out of time, the session goes on. The agent is told before its next prompt, with the command, how it ended and the last 20 lines it printed.

You can change the command in the side panel, under **Setup command**. A change applies to sandboxes made after it. A sandbox that already has its clone is not set up again.

## MCP servers of the repository

A repository can name MCP servers in `.windlass/config.json`. Windlass does not start them by itself, because opening a repository must not run a command the repository chose. Before a turn, the agent asks you: **Start this project's MCP server "…"?** The question shows the server's command with every argument, or its address, and the file that defines it. It also says what the server can do: it runs outside Windlass's sandbox around commands, so it has the network and can read the session's access token.

- **Start it for this project** starts it. The agent has its tools from this turn on.
- **Not now** leaves it stopped. Your next message asks again.

A question nobody answers within 10 minutes counts as **Not now**. If a server's definition reads a secret, the question says which saved secret approving hands over, or which secret to save if it is not set.

Your approval is remembered for 30 days, for that repository and exactly that definition. A changed definition is asked about again. A changed script that the definition runs is not.

The side panel's **MCP servers** section lists each server with its command, its state in the last turn and, where an approval is remembered, until when, with **Forget**. A server that waits because you said **Not now** has **Approve…** there; it starts with the next turn.

> **Note** Forgetting holds for new sessions and new sandboxes. A sandbox where the server already started goes on starting it, and a running server is not stopped. On a Docker platform, Windlass's own approval holds in all your sessions with the Windlass sandbox, since they share its data. A hardened Docker sandbox has Windlass data of its own, so there the platform's approval is what your other sessions go by.

A repository's hooks do not run, and its language servers do not start.

## Sandboxes after the work

A hosted sandbox that has stopped answering commands, most often because something in it used all of its memory, is restarted from its disk when the next turn starts. The files in the workspace are kept, and the programs that were running in it are not. The timeline says when that happened.

A sandbox is paused 10 minutes after its last turn. A paused sandbox uses no sandbox time. On this platform it is removed after 7 days without use. The timeline stays either way. If the sandbox is gone, the next prompt starts a new one.

### When a sandbox is replaced

A new sandbox has a fresh workspace. The platform clones the repository at the branch the session started from and runs its setup command. Where the session's work was pushed, it then puts the workspace on the session's branch as GitHub has it. What was only in the old sandbox is lost. The agent is told with its next prompt.

Where the platform keeps a copy of the agent's memory of the conversation, it restores it, and the timeline says "Restored the agent's memory of the conversation into the new sandbox." Otherwise the agent starts without it, and the timeline says so. On Docker, the agent's memory outlives the sandbox, except in a hardened Docker sandbox: its Windlass data is its own, so that other sessions' commands cannot read it, and it goes with the sandbox. A hardened Docker sandbox made before sandboxes had data of their own still uses the shared data, so the platform removes it when the session next uses it, and the session goes on in a new sandbox as after a lost one.

On one of your machines, a sandbox is not removed after a time. It goes when you delete its agent, when you remove the machine with its sandboxes, or when you prune the runner.

**Usage** shows how many hosted sandboxes you can keep (five by default when plans are off); those on your own machines are not counted. To free one, go to **Usage**, find it under **Hosted sandboxes you keep** and choose **Free…**. See [Settings, usage and limits](/docs/settings#usage).

## Rename or delete an agent

On the list of agents, each row has **Rename** and **Delete**. Deleting asks first: **Delete this agent?**

An agent that works for a work item cannot be deleted while the item has it. Cancel the item instead.

The Factory sends the prompts in a work item’s session. To steer the builder, use **Send note** on the item or its running part. The first stands as **The factory's brief** (for the second reviewer, **The platform's brief for this review**), with its first lines and **Show all**.

Deleting an agent on one of your machines records that its sandbox must be removed, and the runner removes it now or when it is next online. If that record cannot be written, the delete is refused: "The agent could not be deleted: its machine's record of the sandbox to remove could not be written. Try again in a moment."
