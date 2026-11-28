## What a work item is

A work item is a task on a connected repository that an agent carries through on its own. You write what you want done. An agent works on it in a sandbox, runs your checks, pushes a branch, waits for CI and hands it to you as a pull request on GitHub or a merge request on GitLab. When it needs a decision from you, it waits under **Needs you**. You merge by default. A GitHub repository can [auto-merge eligible single items](#automatic-approvals-and-merges).

GitHub is the default. For a connected GitLab project, file a single item [from a GitLab issue](#from-a-gitlab-issue). They run with Windlass unless you choose another agent on one of your machines: see [Choose the agent](#choose-the-agent). The Factory is offered where the platform turns work items on. Then **Agents · Factory** appears in the bar.

The Factory has the same repository rail as **Agents**, with its search, owners and foot. There, a repository's ring counts its work items in progress and the amber count what needs you; choosing one shows only its work items. A repository with no work item is dimmer; choose it to file one on it.

Every item resolves its place and agent the same way, whether filed from the composer, the API, GitHub, GitLab, Linear, Jira or Slack: the item's own choice, then the repository's override, then your defaults ([Where each choice lives](/docs/settings#where-each-choice-lives)), then the deployment's. The composer shows the result in one line, with where it comes from, and **Change for this item**. If the result can't run (the machine is offline, the payer can't be used), the item waits and asks you instead of running elsewhere. Plan first plans on Windlass; its parts start from the same resolved place and agent unless the planner chose another.

A work item runs in one of two ways:

- **Plan first** is the default. A read-only planner files a feature plan. You approve the scope on the item page, then one implementer follows it or the approved subtasks run. See [Orchestrate a feature](#orchestrate-a-feature).
- **Quick** skips the plan and sends the request directly to one implementer. Choose it for an individual item, including a bug filed from the web.

## Repo setup

Some tools, such as Factory.ai's Agent Readiness, score a repository with a checklist of what it contains. Repo setup checks your setup too, but a repository's level comes from what happened when agents actually worked in it: green CI, verified work and no reverts.

Open a connected repository to see **Setup N of 8**. The count includes the saved setup command and checks. Windlass also reads the default branch for contributor guides, issue and pull request templates, oversized files, workflows that check proposed changes, and protection for secrets. Reading these files uses no agent time.

Choose **Finish setup** to draft a root contributor guide with a Terms section and guides for up to eight large folders. The drafter reads the default branch and the latest matching build. It can also write up to five reusable instructions in `.agents/skills/<name>/SKILL.md`. The platform passes the drafted files and the selected, verified team notes to a separate reviewer. The reviewer can ask for files to be dropped or for one round of changes before the draft goes to the pull request. Running it again updates the open pull request. It runs where the repository's agents usually run; on your machine it uses no hosted minutes.

Paste notes or upload up to 20 Markdown files (256 KB total). Select the notes to include. The agent checks commands and paths against repository evidence. Personal, private, secret and stale notes stay out of the guides. Review the source notes, where they were used and any questions under **Repo setup**. Choose **Apply answers** to continue the setup session for a further drafting turn (up to five minutes), followed by review and an update to the same pull request. The session releases its sandbox while it waits for you. Public pull requests show counts. Private pull requests also list the sources and evidence.

The pull request shows the check result for each skill. **Ran** means the platform ran the skill’s read-only check against the repository. **Static only** means it checked the references and instructions without running the skill’s command. Failed skill checks leave that skill out of the draft. Repositories with a `.claude/` folder also receive a `.claude/skills` link when that name is available.

**Check pull requests for broken guide references** is on by default. After you finish setup, look for **windlass/guides** on a pull request’s Checks tab. It checks the root and folder guides, and the repository’s shared skills against the build setup and file names for the checkout. It reports new broken references as failures and shows the number of earlier findings separately. The check reads repository files and uses no build, workflow or agent time. Turn the switch off to stop sending setup check results to the repository.

For a check using your own Actions workflow instead, copy the repository checker’s [read-only rules](https://github.com/WindlassAI/windlass-platform/blob/main/server/src/repo-setup/guide-check.ts) and [command](https://github.com/WindlassAI/windlass-platform/blob/main/scripts/agents-docs-check.ts) into the same paths in your repository. In the command, omit the check for binaries if you do not install your dependencies. Add the following workflow to your repo. It checks every current reference against the files it receives.

```yaml
name: Check contributor guides
on: [pull_request]
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1
        with:
          node-version: 22.22.2
      - run: node scripts/agents-docs-check.ts
```

Notes are encrypted for your account and repository. You can delete them here. Selected notes are deleted when their pull request merges or closes, and all notes expire after 30 days. **Run setup checks weekly** repeats the setup checks and refreshes CI history.

**CI history (30 days)** shows how often finished checks and commit statuses passed on the default branch, including CI outside GitHub Actions. The scan reads up to 200 commits and 100 workflow runs. A flaky job failed and then passed on the same commit when its workflow ran again. The summary also counts reverts and commits that failed checks after a merge. If GitHub is unavailable, the last successful result and its read time stay visible. Use **File as work item** beside a failed setup check or a flaky job to create a draft.

The level is **Ask first** once Finish setup confirms the saved setup command and checks pass. Until then the level is **Not ready**. CI history is shown for information and does not set the level: each item reads CI on its own change, and a check that also fails on the default branch is not blamed on the agent. At both levels the planner asks for smaller, independently checkable parts.

**Track record** counts finished work in this repository. Five clean single items earn **Small plans**. A clean item merged with a passing verdict and green CI, without fixes, review requests for changes, or flagged changes. Three verified features earn **Full plans** when at most one in four features needed a CI fix. From Small plans onward the planner can choose the size of each part.

At Full plans, five clean single items of one kind earn **Earned merge** for that kind. Markdown and reStructuredText files count as docs, test paths count as tests, and changes limited to supported dependency manifests and lockfiles count as dependency bumps. Mixed changes count as other. Repo setup offers to turn on small-plan approval or automatic merge for a kind you earned. Each switch needs your approval.

A revert of an agent pull request or three failed verifications in a row drops one level. Repo setup records the reason and turns off settings accepted through an offer that was lost. A switch you enabled yourself in Saved settings stays on. Refusals, budget stops, and sandbox problems do not count as failed verifications.

## File a work item

### From the Factory page

1. Open **Factory** in the bar. Everything its composer files is a work item; agents start from **Agents**.
2. Type the task in **What should be done?** The first line suggests a title. Edit **Title** before filing if you prefer another name.
3. Choose the repository and branch in the **where** menu, and the machine there too if you like.
4. Optionally, choose the agent, its model and its effort in the **agent** menu. See [Choose the agent](#choose-the-agent).
5. Optionally, choose **Add done-when criteria** under the task and write them, one per line. The agent is given them, and the verdict lists them for you to check. No machine checks them. Once written, they show as a short list there; choose **Edit** to change them.
6. Where the platform offers orchestration, the **File** button says how the item runs: **File · Plan first** or **File · Quick**. Its menu switches between them: **Plan first**, where a planner splits it into subtasks you approve, then they run; or **Quick**, where one agent goes straight to a pull request. Your browser remembers the last choice.
7. Press <kbd>Enter</kbd>, or choose **File**, to file it and start it.

To file it without starting it, choose **File as a draft** in the **File** menu, or press <kbd>Alt</kbd>+<kbd>Enter</kbd>. Start a draft later from its page. **Options**, the sliders icon, leads to the repository's saved settings, such as screenshots. Where the platform offers [hosted sizes](/docs/start-an-agent#hosted-sizes), it also lists them with their price an hour: a hosted work item runs on **Medium** (2 vCPU, 4 GiB) unless you choose another here or the repository saved one. Its reviewer runs on the same size. An item's hosted time and the daily allowance are in seconds, whatever the size.

### From a repository

Choose the repository in the rail of **Agents**, open **Work items** and choose **New work item…**. Fill in **Title**, **What to do** and, if you like, **Acceptance criteria**. Choose **Plan first** or **Quick** under **How it runs**, where it is offered. For a Quick item on a machine, choose an agent that can run there under **Agent**: Claude Code and Codex need a connected plan or key, OpenCode a login on the machine or a key. Leave **Start now** ticked and choose **File and start**, or choose **File as a draft**.

### From a GitHub issue

Where the platform receives GitHub's events, you can file a work item from an issue:

- add the label `windlass` to the issue; or
- write a comment whose first word is the App's handle, `@` and its name, or `/windlass`. The rest of the comment is added to the task as a note.

For this to work, you must have connected that GitHub account in Windlass, and you must have write access to the repository. Lines like `- [ ] text` in the issue become acceptance criteria.

A plain `windlass` label or App mention selects **Plan first**. The label `windlass:orchestrate` and a note starting with `orchestrate` also select it. To skip planning, apply `windlass:quick` or start the note with `quick`, for example `/windlass quick fix the typo`. An issue labelled `bug` always runs **Quick**. An explicit Quick choice also wins if both modes are requested. The App’s reply names the filing mode.

With `WLP_FACTORY_ORCHESTRATE=0`, ordinary requests run **Quick** and the web forms hide the mode selector. An explicit request for orchestration on that deployment is refused.

- If you wrote the issue yourself, the item starts at once.
- If someone else wrote it, the item is filed as a draft for you to start. Its page says the text was written by them, not by you, and the agent is told to take it as a description of what is wanted, not as instructions. Windlass is also told the text is theirs: see [Text from someone else](#text-from-someone-else).

When a label files an item, the App reacts 👀 on the issue. When a comment files an item, it reacts 👀 on that comment.
The App comments on the issue to say it took the item, and links to it. It also says when the pull request is opened and when the item ends.

On GitHub, removing the label cancels a draft. Closing the issue cancels an item that has not reached review. Editing the issue later does not change the item: it keeps the text it was filed with.

### From a GitLab issue

After [connecting GitLab in Settings](/docs/settings#gitlab), use the connected account to add the `windlass` label to an open issue in the selected project, or write an issue note beginning with `/windlass`. As on GitHub, the item is filed in the Windlass account connected to the GitLab user who labelled or commented, and that account must have the project selected. Labels and commands from GitLab users not connected to Windlass file nothing. Windlass re-reads the issue and any command note, then files a **Quick** item. It acknowledges the filing with a 👀 reaction on the issue for a label, or on the note for a command. Redelivering the event, or labelling the issue again while its item is open, does not file another item. Once that item is done, failed or cancelled, the next label or command files a new one.

Your own issue starts immediately; an issue someone else wrote starts as a draft. In both cases the issue and note are quoted as untrusted input.

The item opens a merge request against the project’s default branch and polls GitLab for pipeline and job results. It counts the newest pipeline that ran its commit: a branch pipeline, the merge request’s own pipeline, or a merged-results pipeline built from it. Pipeline and merge request events also prompt it to check again. Once it hands over a passing result, review the MR and select **Merge…** on the item. Windlass rechecks the reviewed commit, target branch and pipeline before merging.

GitLab supports single items only. Plan-first features, cross-repository work, integration workflows, Linear team mappings and the `windlass/verified` check remain GitHub-only.

### From a Linear issue

Where the platform has a Linear OAuth client and signing secret, you can file a work item from a Linear issue.

**Set it up.** In **Settings**, under **Linear**, choose **Connect Linear** and approve the workspace at Linear. Windlass returns you to Settings. Then choose a team and one repository from your GitHub connection and **Map team**. **Remove** drops a mapping. A team belongs to one owner at a time. Another owner can map it once the previous mapping or workspace connection is gone. Issues of a team with no mapping are ignored. **Disconnect…** removes the workspace connection and its team mappings. Work items already filed stay in Windlass.

**Triggers.**

- An issue gains `windlass`, `windlass-quick`, or `windlass:quick`; or
- an issue is assigned to the Windlass app user.

`windlass-quick` (Linear does not allow a colon in a plain label name) selects **Quick**. The existing `windlass:quick` spelling also selects **Quick**. A plain `windlass` label selects **Plan first** by default. As on GitHub, a `bug` label selects **Quick** on a qualifying issue. An unrelated edit to an issue that already has the label or the assignment does not file anything. Each delivery from Linear is taken once, and one active issue files one item however many events qualify.

**Placement and limits.** The item resolves its place and agent as any item does. GitHub, Linear and Jira issues and Slack requests share one daily limit, including drafts and filings in progress. If the daily limit is full, a later trigger or redelivery can file the issue once there is room.

**Who it's filed for.** The item belongs to the person who added the label or made the assignment. It is filed in the Windlass account they [linked](/docs/settings#linked-accounts), with that account's GitHub connection, which needs write access to the team's repository. The team owner's account is only used to read the issue and post updates on it. If that person hasn't linked a Windlass account, nothing is filed and Windlass comments once on the issue asking them to link.

**Trust.** Linear identifies the Windlass app as the connected user. Issues arrive as drafts with their authors' text quoted. Review and start the item in Windlass. Its page and list link to the Linear issue by its identifier, for example ENG-123.

**Updates on the issue.** When you start the item, Windlass moves the issue to the first state in the team's Started category. If the issue is already started, it keeps its current state. When a plan needs approval or the item asks you a question, Windlass comments once for that question with a link to the item page.

Windlass attaches the pull request and comments when it opens, at handover, and when the item merges, fails or is cancelled. These comments include the PR link when available. At PR open or handover, Windlass moves the issue to **In Review** if the team has a Started state with that exact name and the move is forward. A merge moves the issue to a Completed state. Giving up or cancelling leaves the status for you to decide. Windlass preserves completed and canceled issues' statuses and only updates issues still in their mapped team. The item continues if Linear is unavailable. If you connected Linear before Windlass requested the `write` scope, reconnect to grant it.

Removing a label, unassigning, editing or closing the Linear issue leaves the item as filed. To stop it, cancel it in Windlass. After the item ends, a new qualifying event on the active issue can file another item.

### From a Jira issue

Connect Jira Cloud and map a project to a writable GitHub repository in [Settings](/docs/settings#jira-cloud). If Jira is missing, ask the operator to enable work items and [configure the Jira app](https://github.com/WindlassAI/windlass-platform/blob/main/docs/configuration.md#jira-cloud).

To try it, add `windlass` to an open issue or assign it to the account that connected Jira. Creating an issue with either also files a draft. Use `windlass-quick` for Quick mode. A qualifying Bug or issue labelled `bug` also uses Quick. Windlass quotes the issue text for you to review before starting the draft.

The draft belongs to the person who added the label or made the assignment. It is filed in the Windlass account [linked](/docs/settings#linked-accounts) to their Jira account, with that account's GitHub connection. Connecting Jira links your own Jira account. If that person hasn't linked one, nothing is filed and Windlass comments once on the issue asking them to link. The project owner's connection still posts the comments below.

Jira receives a comment linking to the draft, another when the PR opens, and a final outcome with the PR link when available. The issue keeps its Jira status. Only one item is active per site and issue, even after a project changes owners. A fresh trigger after it ends can file another.

### From Slack

In a [mapped channel](/docs/settings#slack), send `@Windlass Fix the setup guide` or `/windlass quick Fix the setup guide`. Put `quick` first to skip planning. The first time, follow the bot’s private link, confirm it under [Linked accounts](/docs/settings#linked-accounts), then send the request again. The item is filed in your own Windlass account, and your GitHub account needs write access to the mapped repository.

The item uses your saved defaults and shares the daily limit with GitHub, Linear and Jira issues. Windlass posts item links in the mention’s thread when a plan or question needs you, a pull request opens, or work ends. For a slash command, follow the thread under the bot’s acknowledgement.

In the thread, a plan has **Approve**, **Request changes** and **Open in Windlass**. **Request changes** asks what should change and sends your words with the request for a revised plan, as on the web. A question has one button for each choice that needs no more input. Only the Slack member linked to the item’s owner can press them. Others get a private note and nothing changes. Once a question is answered, in Slack or on the web, its message shows the answer and loses its buttons. A button from an older question is refused.

A plan with open questions, or with parts that run an agent that works without asking, is approved in Windlass. Requests for secrets and questions that quote the agent link to Windlass. Windlass never posts the agent’s own words or check output to Slack.

A mention in an item’s thread files nothing. If a question is open, its owner can reply with a choice’s label, such as `@Windlass Give up`. Anything else gets a private link to the item.

### From the API

Make a token under **Settings** › **API tokens** › **New token…**. Give it **File work items**, **Read work items** or both. Copy its value when it is shown: it is not shown again.

- `POST /api/items` files a work item. Send `Authorization: Bearer <token>` and an `Idempotency-Key` header.
- `GET /api/items/<id>` reads where an item is, its verdict and its cost.

**API default change.** Clients that previously omitted `mode` to launch one implementer must now send `"mode": "single"`. Omitting `mode` selects Plan first and waits for owner approval when orchestration is enabled.

The body names the repository, the title, the body and, optionally, the acceptance criteria, sandbox, model, effort, place, whether to start it and `"mode"`: `"orchestrate"` for Plan first (the default when enabled), or `"single"` for Quick. A token cannot approve a plan: you approve it on the item's page. A title can be 80 characters long and a body 20,000. An item can have 20 criteria of up to 2,000 characters each. A token may make 60 requests a minute. The same `Idempotency-Key` with the same body answers with the item the first attempt made; with another body it is refused with `409` and `idempotency_key_reused`. A missing, invalid or out-of-scope token gets `401` and `invalid_token`. A rate limit gets `429` with `Retry-After`. Every error has a JSON `code` and `message`. Where the platform does not offer work items, both routes answer `404`.

## Choose the agent

An item's builder runs **Windlass** by default. For a hosted **Quick** item, you can choose Claude Code, Codex or OpenCode where a connected plan or Settings key can pay for it. Hosted subtasks can use Claude Code or OpenCode. On one of your machines, it can run **Claude Code**, **OpenCode** or **Codex** instead, where the machine's runner offers that agent and something can pay for it there: a connected plan or a key, or OpenCode's own login on the machine. The composer lists only those, and an item is refused where nothing can pay. If nothing can by the time a turn would start, the turn does not run and the item asks you. The agent's default model is used unless you choose another. Windlass items can choose any model of your account.

An item can also have an **effort**: the reasoning effort every turn of it runs at, for Windlass, Claude Code, OpenCode and Codex alike. The composer offers it in the **agent** menu, under the models, and the **New work item** dialog under **Model** and **Effort**, with the efforts the agent reported for that model. Left at **Default**, the agent's own default is used. An effort the agent does not offer is refused.

**Codex** can run Quick items too, on a machine that offers it, paid with your ChatGPT plan or OpenAI key. It is not offered for **Plan first** or as a subtask's agent. See [Codex items](#codex-items).

What changes with Claude Code or OpenCode:

- **Where.** Hosted, or on your machine in **Hardened Docker on your machine "…"**.
- **How it runs.** A Quick item runs Claude Code or OpenCode directly. A **Plan first** feature's planner runs with Windlass, because it files the plan with a Windlass tool, but each of its subtasks can run Claude Code or OpenCode: see [Each subtask's agent](#each-subtasks-agent).
- **Asking.** An item has nobody watching it, so the agent works without asking. Like a Windlass builder, a Claude Code or OpenCode builder can stop and ask you a question (see [When the agent asks you](#when-the-agent-asks-you)), and files its report the same way; otherwise it decides for itself. It can push its branch during its turn, as Windlass can, and the platform pushes what is left when the turn ends. Claude Code runs in **Bypass permissions**. OpenCode runs in **Build**, and the platform allows once each edit or command it asks about, as Windlass runs commands in that container. The turn does not start if the agent does not offer that mode.
- **Checks.** The platform runs your repository's saved checks for these agents, as Windlass runs them for itself. When the agent ends its turn, the checks that cover what the turn changed run in the same container, with the same time limits and none of your saved secrets. If one fails, the platform sends the agent back in the same turn with the failing output, marked as text from the workspace and not as instructions, up to 2 times. A check still failing after that ends the turn with checks failing, and the item's next steps treat it as they treat a Windlass turn's. The timeline notes each run, and the verdict and the check on GitHub read them.
- **Step limit.** A builder turn may make 400 tool calls (40 for a reviewer). When the agent starts one more, the platform records the limit on the timeline and the item can continue in a new turn within its budget.
- **Review.** The second reviewer runs in its own sandbox on the builder’s machine with the same agent, model and profile. Its setup receives the same setup-scope secrets as the builder’s setup. Its commands have the same network access as the builder’s commands.
- **Publishing.** The platform commits what the agent left, pushes and opens the pull request, as it does for Windlass. The agent's own `git push` fails, because the sandbox holds no GitHub credential. The pull request's description is the item's.
- **Cost.** Turns count against the item's dollar budget at API prices, whoever pays (see [When the budget is used](#when-the-budget-is-used)). Where an agent reports no tokens, the page says **Not reported**, never 0. A turn that reports no tokens where tokens hold the budget stops the item: it asks you, and you can give up or hand over a pull request CI has read.

From the API, send `"harness": "claude"` or `"harness": "opencode"` with `"place"` naming the machine and `"mode": "single"`, and optionally `"model"`, for example `"sonnet"`, and `"effort"`, for example `"high"`. The machine's model list is on the **Machines** page. Issue filings use the saved work-item placement and agent. The planner always runs Windlass.

### Codex items

A Codex item runs the way a Claude Code or OpenCode item does above, with these differences:

- **Where.** Hosted Codex uses hardened Docker or the E2B microVM-only profile. On your machine, choose one of two sandboxes. **Docker + Windlass sandbox** is the default: Codex runs every command in its own sandbox without network, and may change files only in the workspace (not `.git`, `.agents`, `.codex` or `.aws`) and the temporary directories. The machine offers it once its runner's check of Codex's sandbox passed. **Docker, hardened** runs only when you choose it: commands run in the container without asking, with the machine's network, as Claude Code's do.
- **Leaving the sandbox.** On **Docker + Windlass sandbox**, Codex asks before a command outside its sandbox or an edit outside the paths it may write, and every such request is refused. Most are refused inside Codex, which is told and goes on. One that reaches the platform ends the step: the timeline notes the request, and the item asks you to file the work again on **Docker, hardened**, or to give up. Work that needs the network in its commands, such as adding a package or running tests against a service, suits **Docker, hardened** better. The repository's setup command runs before the turns, with network, so dependencies it installs are there.
- **Tokens.** **Connections → Pay with** decides what pays for each turn. Turns on your ChatGPT plan and turns your OpenAI key pays both count toward the item's budget at API prices.
- **Checks.** On **Docker, hardened** the platform runs your repository's checks for Codex as for the other agents. On **Docker + Windlass sandbox** it runs none: a check would run what Codex changed outside Codex's sandbox, with the network Codex has no access to there. Each check that applies is recorded as not started, with that reason, and CI decides.
- **Asking and reporting.** Codex gets `report`, `ask_person`, `push` and `fetch_base` like the other agents (see [When the agent asks you](#when-the-agent-asks-you)), and calls them without asking on both profiles.

From the API, send `"harness": "codex"` with `"place"`, `"mode": "single"` and, to choose the hardened container, `"profile": "docker-hardened"`. Left out, the profile is `docker-windlass-sandbox`.

## The pipeline

Each item goes through these steps, in order. Its page shows where it is.

1. **Implementing**: its agent works on the task.
2. **Checks**: the platform reads what the checks of the last turn found. If one fails, the agent is sent back to fix it.
3. **Pushing**: the platform pushes the work and opens or updates the pull request.
4. **Waiting for CI**.
5. **Fixing CI**: its agent works on what CI reported.
6. **Merging the base**: its agent merges the base branch into its own, if they conflict.
7. **Second review**: a second agent reviews the pushed commit in its own sandbox, where the platform offers it.
8. **Fixing what the reviewer asked**: if the second review asks for changes, its agent works on the blocking findings. The steps from **Checks** run again, and the second agent reviews the new commit.
9. **Handed over**: the item is **In review**, and waits under **Ready for you**.
10. **Waiting for the merge**: when you merge the pull request on GitHub, the item is **Done**. If you close it, the item is **Cancelled**.

By default, you merge the pull request. Repository owners can enable automatic merges for eligible single items.

### Your checks

Set checks in the repository’s settings under **Checks**. Windlass can send a turn back up to three times for failing checks. On machine agents the platform runs matching checks after a change and can send failures back twice in a turn. Codex on its command-sandboxed profile records matching checks as unable to start. Without local checks, the verdict relies on CI.

### CI

Windlass waits as long as a workflow is queued. If it cannot reach GitHub to read CI for 90 minutes, it asks you whether to keep waiting. If GitHub reports a workflow in progress for more than six hours, the item asks you what to do. If GitHub reports no workflows, checks or statuses for the push after 10 minutes, Windlass looks at the last three commits on the default branch. It keeps waiting if any show CI. Otherwise, it treats the push as having no CI.

When CI fails, stays cancelled or times out and the base branch has new commits, choose **Update from the base branch and run CI again** to merge the target branch (the feature branch for a subtask) and check the new commit.

### The second review

A second agent, with no part in making the change, checks out the pushed commit in its own sandbox and reads it against the task. It approves, asks for changes, or says it needs you.

It is also given what you said to the work since you filed it, as your decisions: notes you sent to its running builder, notes when you sent it back or answered a question, and your own feedback on the pull request. Where one disagrees with the task, it reviews against your decision. It is told not to ask for a decision to be undone, and not to ask you again what you already answered. The agent that made the change is told the same: it keeps your choice where a finding asks otherwise, and says so in its report. Feedback from other people is not a decision of yours and is not passed on this way. Its findings are marked **Blocking**, **Should fix** or **Note**. The verdict never rests on its words.

What happens next depends on its recommendation:

- **Approves**: the item is handed to you unless it qualifies for [automatic merge](#automatic-approvals-and-merges).
- **Asks for changes**: the agent that made the change gets the blocking findings and works on them, on the same branch. It is told to leave a finding it disagrees with and say why in its report. It is also told that no finding justifies removing or skipping tests or checks, changing CI or deploy configuration, adding network calls, or touching credentials: it leaves such a finding and names it in its report. The new commit goes through your checks and CI, and the second agent reviews it again. It says for each earlier blocking finding whether it is fixed, not fixed, or withdrawn. A finding it says is not fixed stays open for the next round, whether or not it files it again, and it cannot approve while one is open. If the agent changes nothing, because it disagrees with every finding, the second agent reviews the same commit again, with the agent's report. On a single item, rounds of fixes are not capped: the item stops when the second agent asks for the same changes again, or when its budget is used.
- **Needs you**: the item asks you, with the reviewer's questions in its review. **Have the agent change it** sends its agent back with the questions and your note. **Hand it over as it is** hands it to you with the review. Or **Give up**.

The item stops and asks you when the second agent asks again for the same changes after a round of fixes. **Try it once more** runs one more round of fixes: if the second agent asks for the same changes after it, the item stops and asks you again. **Hand it over as it is** keeps the review filed for the commit it hands over: it shows on the item's page, the pull request comment and the check on GitHub.

Sometimes the commit handed over has no review of its own after a review asked for changes: you chose **Hand it over as it is** on a budget or CI question after the agent pushed its fixes, or the next review was refused or filed nothing the platform could read. Then the pull request comment says there was no second review of that commit, every review of the run stays on the item's page, and the check on GitHub says **Second review did not finish after it asked for changes**, with Action required.

If you or another repository writer pushes while the item is working or waiting, the item shows the commit and asks what to do. Choose **Continue from your push** to resume from that commit and check the resulting work, **Take it over** for the usual handover, or **Give up**. A feature branch push asks on the feature, and a part branch push asks on that part. Other or unidentified pushes follow the usual handover rules.

On a feature, blocking findings start a fix part on the feature branch. After it joins, CI and the whole-feature review run again. Repeated findings or two completed review fixes bring the choice to you: try another fix, hand over with changes requested, or give up.

Each filed review round gets one PR comment with its verdict, findings and links to the reviewed lines. Retries edit that round’s comment. When screenshots were filed, the comment lists their counts and links to the item page, where the owner can view them.

Windlass files through its host tool. Other agents can call `file_review` once per turn over MCP. A process in the sandbox can make that call. Findings and requests for changes take the same path for every agent. An MCP approval leaves the merge decision with you. Auto-merge requires a host-filed Windlass approval from a reviewer whose commands ran in the Windlass command sandbox. An issue written by someone else or feedback taken from another writer keeps the merge with you.

The second review is off unless the platform turns it on. The Factory page says when there is none.

### Screenshots

Turn on **Allow screenshots for work items** in the repository's settings, under **Screenshots**, to let builders and reviewers attach pictures of the app to their reports. For a feature, the planner marks subtasks that change what users see. Only those subtasks get a browser when the plan is approved. The setting is off by default. A deployment can turn screenshots off for every repository; the setting then says so and cannot be turned on. A screenshot is a PNG of up to 2 MiB. An item can have 40. They are kept for 180 days after the item ends.

## Automatic approvals and merges

Both settings start off. The repository owner can change them under **Work item approvals**.

**Auto-approve small plans** gives a structurally valid plan one independent, read-only critic turn on the account's standard default model. The plan can suggest a single item or contain up to three parts. Its total token budget, including the feature's own allowance, must fit within three single-item budgets. Plans based on another person’s issue or feedback go to you for approval. For each open question, the planner must recommend an answer and the critic must accept it. Otherwise the plan goes to you. You can read the accepted answers in the plan. Unordered parts with overlapping files or an agent needing explicit confirmation also send the plan to you. For a feature spanning repositories, each repository must enable automatic approval. The feature pays for the critic. A revision recommendation shows you the findings. An unavailable critic or a failed approval check also leaves the decision with you.

**Auto-merge single items** squash-merges a PR using its title when the platform verdict passes, CI passes on the exact head, and the second reviewer approves that head with zero blocking findings. The branch must be current with its base and GitHub must allow the merge. A behind branch goes through the usual base update and verification. Features, their parts, foreign pushes, pending feedback and work based on third-party text still need handover. GitHub's refusal appears on the item timeline.

Windlass checks CI and the base again immediately before requesting the merge. To close the seconds-wide window before GitHub accepts it, configure branch protection on the target branch with required status checks and **Require branches to be up to date before merging**. The rule must apply to the GitHub App.

## The verdict

When an item is handed over, its page gives a verdict, such as **Ready for review**, **Needs a look** or **Failing**. The verdict rests on CI on the pushed commit, your checks where you set them, and what was seen in the changes. It never rests on the agent's words. A verdict merges nothing.

The item's page puts it in one **Checks** panel near the top. Its first line says **Ready to merge**, or how many things are open and what they are. Below it: each CI check on the pushed commit, failed first and folded to one line when all passed; your checks; the second reviewer's recommendation with its blocking findings, each opening to its text, and **Show the full review**; and open comments from people on the pull request, with **Show all batches**. Earlier verdicts fold at its foot.

### Network

Below the Checks panel, a **Network** block appears when the sandboxes of the item's builder or reviewer refused network requests. It gives the count across their turns and the destinations, most actionable first, each with how many times it was refused and when last. A host the repository's network list can allow has **Allow for this repository**; one a paired machine refused says to add it to that machine's `--egress-domains`. A feature over several repositories lists the hosts without the button: allow one in the settings of the repository that needs it. See [Blocked network requests](/docs/sessions#blocked-network-requests).

### The check on GitHub

Look for **windlass/verified** on the pull request. It starts in progress when the item publishes its commit. A feature gets one check on its assembled work after its subtasks finish. **Details** opens the evidence for the item's owner. Anyone who can read the repository can read the check summary. It contains platform observations, including check names, flagged paths, the second review's recommendation, counts and spending. The task, builder's report and reviewer's findings stay out of the check summary.

| Factory outcome | GitHub conclusion |
|---|---|
| Ready for review | Success |
| Needs a look, CI unread or unfinished, CI did not start, or Not verified | Action required |
| The second reviewer requests changes or needs a person on an otherwise ready item | Action required |
| The second review asked for changes, and none was filed for the commit handed over | Action required |
| Failing or Incomplete | Failure |
| You give up or cancel during verification | Cancelled |

During each round of the second review, the check on the reviewed commit stays in progress. When the second review asks for changes, the check says that the next round is being worked on. When a later commit is handed over, the reviewed commit's check is completed as **Cancelled** and names the commit that replaced it.

After someone else pushes, the earlier verdict belongs to the old commit. Windlass marks the new head **Action required** when it sees the move. Sending the item back puts its check in progress during rework. In review, choose **Re-run** on the GitHub check to have Windlass read CI again. For example, CI that has finished since handover can now earn a pass. Windlass accepts one such request per minute per item.

If Windlass reports a permission refusal, ask the installation owner to open the App's **Configure** page on GitHub and accept **Checks: Read and write**. The verdict, review request and marked pull request comment are available independently of the check.

To require the check, add **windlass/verified** to the required status checks for your target branch in the repository's branch protection rule or ruleset. Select the platform's GitHub App as the expected source. **Action required** blocks a merge under this rule. You can separately enable auto-merge for the repository.

## When an item needs you

An item waits under **Needs you** when it asks you something, under **It asks you** on its page. For example, when its turn could not start, when GitHub refused the push, when CI stays unreadable, or when it reached a limit. Choose one of the answers it offers, such as **Try again**, **Keep waiting**, **Give it 2M more tokens**, **Hand it over as it is** or **Give up**. An item's question waits until you answer.

An item also stops and asks you when it is stuck. There is no cap on rounds of fixing; instead it stops when the same failure comes back:

- the checks fail the same way again after a fix;
- CI fails the same way again after a fix;
- the pull request conflicts with its base again after a round of merging it;
- the second reviewer asks again for the same changes;
- a step was cut off 3 times by deploys or restarts;
- the item took 60 turns, a backstop for work that goes round without repeating a failure.

**Try it once more** goes on in the same run. Choose **Hand it over as it is** to take the work as it is, or **Give up**.

Where turn resumption is enabled, a turn paused by a server restart resumes by itself, and the item sees one turn. A turn on your machine pauses when the machine goes offline. The item waits, with no failure and no question, and gives its turn slot to other items meanwhile. When the machine is back, the turn resumes first, ahead of turns that came later. The time offline does not count toward the turn's limit or the item's time. If the machine stays offline for six hours, the item asks you once: **Keep waiting**, or **Give up**. To run the item somewhere else, give up and start it again on another place.

### What the Factory does on its own

Each automatic action appears in the timeline and counts against that run’s allowance. A failure with the same fingerprint goes straight to you. The usual budget and stuck-work limits still apply.

| When | Automatic action before asking |
| --- | --- |
| Sandbox preparation fails | Try again once, then wait two minutes and start a fresh sandbox once. A fresh sandbox starts from GitHub and loses unpushed work. |
| A turn cannot start | Retry after 30 seconds, then after one minute. Policy and sign-in refusals go to you. |
| The final summary is missing | Retry in a fresh conversation, up to twice. |
| The agent changes nothing | Ask it once to finish the task or explain in its report why no change is needed. |
| The sandbox runs out of memory | Try the next allowed hosted size once, or retry the same size once. Resizing also starts from GitHub. |
| Checks cannot run in the environment | Retry the step once. |
| Local checks did not verify a subtask | Run the saved checks once. By default, the part waits for passing local checks. With per-part CI enabled, the factory can accept passing CI on the exact commit and record the missing local evidence in the verdict. |
| A CI job fails | Rerun eligible GitHub Actions jobs once on the same commit. A job that then passes is recorded as flaky. If the remaining checks also fail on the base head, choose to wait for a new passing base and update from it, fix here anyway, or give up. |
| CI is cancelled or times out | Request one eligible infrastructure rerun, update from an ahead base once, then wait once. |
| A blocked part’s feature is behind its target | Update the feature from the target once, between integrations. |
| No sandbox or approved place is free, or a machine is away | Show the reason and wait up to six hours. Work resumes when the place becomes available. |
| An integration or feature update offers a recheck | Check again up to twice, within the integration’s existing retry limit. |

A command the agent runs may take at most what is left of its turn (a turn is limited to 45 minutes). Windlass asks for a command's time limit itself; a longer one is refused with how much is left, and the agent runs it again with less. So a command that hangs, for example in a sandbox out of memory, cannot hold the turn to its end. Claude Code, OpenCode and Codex keep their own limits: Claude Code stops a command after 10 minutes at most by default.

When a step goes on in an agent that no longer has its conversation, for example in a new sandbox or after its memory was lost, the agent is given the whole task again, not "continue from where you were". It is also told that its earlier conversation and any work that was not pushed are gone. The timeline says when that happened.

The choices depend on the item. Only the item that owns the pull request can hand it over. The timeline records why work stopped.

### When the budget is used

An item's budget is in dollars of work, $5 by default, and on this platform 2 hours of hosted sandbox time. Every turn counts at API prices, whoever pays for it:

- **A turn on an API key** (a Settings key, or the machine's own key) counts what it cost, priced as **What an item cost** prices it, when the turn ends.
- **A turn on your Claude or ChatGPT plan** (or a machine's own Claude Code sign-in) counts what the same tokens would have cost on a key. The plan charges nothing more for it: the figure is the work's value, so one budget means the same whatever pays. A plan's "% used" is never the measure, because it covers your whole account, your own use elsewhere included.
- **A turn that cannot be priced** (a model the price catalog does not list, a turn that reported nothing): while any turn of the item is unpriced, tokens hold the item too, 2,000,000 by default, counted cost-weighted (an input token read from the prompt cache counts as a tenth). Tokens are otherwise shown only under **How this is counted**.

**Cost so far** shows the figure, for example "$0.40 of work of $5".

When the budget is used, the item pauses and asks, for example "Used $5.10 of work of its $5 budget. Give it more to continue."

- **Give it $2 more** (a quarter of the dollar budget, at least $1) goes on in the same session and sandbox, with the work as it is. Where tokens hold, **Give it 2M more tokens** gives what the item started with. **Another amount…** sets a figure of your own.
- **Hand it over as it is** pushes what the sandbox holds, when nothing of the run is pushed yet, and hands it over once CI has been read.
- **Give up** ends the item.

A subtask asks the same way, without **Hand it over as it is**. A subtask's dollars are an item's in proportion to the tokens its plan gives it; the plan card shows each part's expected dollars, and the parts' together. What you give a subtask in tokens adds to its feature's budget.

The budget is also watched while a turn runs, on a plan as on a key. When the turn has used what was left, and a little more (5% of the budget), the platform stops it as **Stop** would: the agent's work so far stays in the sandbox and its conversation is kept, the timeline says the turn was stopped at the budget, and the item asks as above. **Give it more** goes on from where the turn stopped. A turn is stopped only on what is known while it runs: Windlass's dollars or tokens after each model request, and the cost Claude Code reports as it works. Where that is not known during the turn, for example an agent's tokens that come only at its end, the budget is checked after the turn instead, so such a turn can still go past it. Your own sessions have no budget and are never stopped. A feature's page shows one cost figure, the same under **Cost so far** and in the **Subtasks** box.

**When every hosted sandbox you may keep is in use.** A hosted item's next turn may need a sandbox of its own, for instance its second reviewer's. When all the places are taken, the item waits and names what holds them: your agents by their titles, an item's builder or reviewer by its item. Free one on **Usage** and the turn starts by itself, choose **Keep waiting**, or **Give up**. An item counts as one place: its reviewer shares the place of its builder's sandbox, and the reviewer's sandbox is removed after each review. Sandboxes on your own machines are not counted.

### What an item cost

Each item shows what it cost, split by who carried it: on its page (the total, each plan and key, hosted time, each part of a feature, and by model who paid), as one figure on its Factory card, and in the **Work items** table on **Usage**, with the total of the items listed there. A feature's cost includes all its parts, and parts that ran again.

- **The figure** is what the item added to your bills: what your API keys paid, and extra hosted time, for example "$1.20 extra". Where it added nothing, it says "Included in your plans".
- **Included in your Claude plan** (or ChatGPT plan, or your machine's plan) gives the turns the plan carried and what they are worth at API prices, for example "3 turns · ≈ $1.20 at API prices". You pay nothing more for them.
- **Paid with your Anthropic key** (or OpenAI key, or your machine's key) gives real dollars. Where Claude Code reports its own cost for a turn, that is used. Otherwise the tokens are priced from the public [models.dev](https://models.dev) catalog, which the platform reads once a day; cached input is priced at the catalog's cached price. A plan's turns are priced the same way.
- **Hosted time**, where the platform has plans, is split as Windlass billing counted it: **Included in your Windlass plan**, in hosted minutes, and **Extra hosted time**, the minutes past your plan's monthly allowance with what they cost up to your spend cap (see [Plans and billing](/docs/settings#plans-and-billing)). Each stretch of sandbox time is split when it is counted, by whether your allowance was used up by then, and stays as it was. Free and yearly Pro have no extra time. Where the platform has no plans, hosted time is shown as an estimate at the deployment's rate for its size, for example "≈ $0.29 hosted for 1 h, estimated". A sandbox on your own machine costs nothing here.

Where a part cannot be priced, for example a model the catalog does not list, or a turn that reported no tokens, it says "cost unknown" next to what is known, and never guesses. Prices are estimates: the catalog's base price is used even where a provider charges more for a very long context, and writing to the prompt cache is priced as input. Token counts stay as details under **By model**.

### What finished work costs

The **Summary** tab on **Usage** looks back over the items that ended in the last 7, 30 or 90 days. Its two tables group the done items, one by size and one by type. Each row gives how many items are in the group, the median and p90 cost (the cost that 9 in 10 of them stayed under), the median and p90 time from an item's first start to its end, and **Extra**, what the group added to your bills: API keys and extra hosted time. Cost is an item's model work at API prices, whoever paid.

- **Size.** Small is one item. Medium is a feature of up to 3 parts, the most an automatically approved plan may have. Large is a feature of 4 parts or more. A part that a revised plan filed again counts once.
- **Type.** The type comes from the files the item's work changed, as git lists them at its latest turn with changes. Docs means only documentation files (`.md`, `.mdx`, `.rst`). Tests means only test files. Dependencies means only package manifests and lockfiles. Features and fixes means any other source code changed. Other is the rest: config, CI, assets, docs together with tests, or no change at all. A feature takes its parts' type where they agree. If any part changed source code, the feature counts as Features and fixes. Otherwise it counts as Other.

Above the tables, **Retries** is what was spent after a failed attempt: turns in a run you started again with **Retry**, turns fixing a failed CI, and a feature's parts that ran again for either reason. It counts model turns; the sandbox time of a retried run stays in the item's total. **Not finished** is everything that items cancelled, given up or failed used. Both say the work at API prices and what of it was extra. **Included in your plans** gives what the turns on a Claude or ChatGPT plan are worth at API prices, and how many there were.

An item with a part that could not be priced is left out of the median and p90. The figures are worked out with today's prices, as each item's cost is.

### When a check can't run

Sometimes a check fails because the sandbox can't run its command, not because of the agent's code. The item retries the step once. If the environment still prevents the check, it asks you, under **It asks you**, with the check's command, the first line that shows why, and the end of what the check printed.

It counts as the environment only when every failing check failed in one of these ways:

- **The package manager refused to run.** For example pnpm's `ERR_PNPM_BAD_PM_VERSION`, when the sandbox's pnpm isn't the version the repository pins, or one of corepack's own errors.
- **A tool couldn't be fetched.** A network refusal (no DNS, connection refused, unreachable) while corepack or a package registry was being reached. In a sandbox without network this is the sandbox, not the code.
- **The command wasn't found.** The check exited with status 127.

Anything else that fails, a type error or a failing test, still goes back to the agent. If one check failed for the code and another for the environment, the agent is sent back for the code one only.

Fix the environment, for example the sandbox image, then choose **Run the step again**. The agent goes on in the same session and sandbox, and is asked to run the check's command and fix the code only if it fails for the code. This uses no round of fixing. If the environment still can't run it, the item asks you again. You can also **Hand it over as it is**, when the run has pushed something, or **Give up**.

When the platform runs the checks itself (Claude Code, OpenCode, Codex), it doesn't send the agent back within the turn for such a check either. Windlass runs its own checks inside the turn, so a Windlass agent may still be sent back there before the item asks you.

### When the agent asks you

A builder can stop and ask you a question when it can't go on without your decision, for example which of two approaches the task means. It is told to ask only about what it can't settle from the repository, the task and its acceptance criteria. Otherwise it decides and says what it decided in its report.

- **Where.** The item waits under **Needs you**, on the Factory page and the Agents home, with the first line of the agent's question. The item's page shows the agent's own question, marked as the agent's and quoted as plain text, with up to 4 answers it suggests.
- **Answering.** Write your answer under **Your answer** and choose **Answer the agent**. A suggested answer only fills the box, so you can change it before you send it. The agent gets your answer as its next message, in the same conversation and the same step, and goes on from where it stopped. Its work stays as it was while it waits. You can also **Hand it over as it is**, when the run has pushed something, or **Give up**. Once answered, **What happened** keeps the agent's question, quoted as its words, and your answer.
- **How often.** At most 1 question per turn. A run has no cap of its own: each question ends a turn and waits for you, and the item's budget and turns bound the run.
- **How long.** The question waits until you answer, for days if need be. If the item's budget has run out by the time you answer, the item asks you for more first, and keeps your answer for the turn it resumes. A subtask does the same.
- **Read it as the agent's.** The agent may have read issue text or repository files written by someone else, and those can steer what it asks. Its question is never written for it by the platform, never answered for you, and never posted to GitHub. Check what it asks before you agree to anything. A question over 1,000 characters is refused, and the agent is told to shorten it. Control, invisible and other hidden characters are taken out before you see it, and a suggested answer can't carry hidden text into your reply.
- **Who can ask.** A builder, whether it runs Windlass, Claude Code, OpenCode or Codex: the turns that implement, fix checks or CI, merge the base, or answer a review. The planner files its questions with its plan, and the second reviewer asks through its review.
- **What another program can do with these tools.** Claude Code, OpenCode and Codex reach the platform's tools through a connection inside the sandbox, which another program running there could also use. The worst it could do is file a wrong report, which is never the verdict (checks and CI decide that), ask you a question or request a secret within the same limits, or push what is in the workspace to the item's own branch, at most 5 times a turn. A push is confined to the item's branch and keeps the Git credential outside the sandbox. A secret you supply is available to programs in the requesting sandbox on the next turn. The timeline says of each push that another program may have made it.

For a missing environment variable, the builder can request a secret by name and explain why it needs it. **Add it and continue** saves the value as an agent-scoped repository secret and resumes the step. Enter the value only through the secret action. **Continue without it** resumes the step without adding a secret. **Give up** ends the run. The platform refuses requests when it knows the turn contains third-party text. It cannot identify every influence on a request. A request over the sandbox connection can come from any program there. The question identifies the connection and save destination. Existing repository and account names are refused at request and save time. After three questions in a run, the builder cannot request another secret. Choosing **Continue without it** rules out that name for the rest of the run.

### What you can do with an item

- **Start** a draft.
- **Retry** a failed top-level item if it has not started dispatching subtasks. A retry starts a new run.
- **Send back…** an item in review with a note. A feature starts a fix part with your note as its brief. For both, the pull request is updated and the work gets a new verdict. If CI fails on a newer push after handover, choose **Hand it back** to start a run with the failing checks, or **Dismiss** to keep it in review. You can also ask for changes on the pull request itself (see below).
- **Send note** to a working item's agent, or on a feature's page to a running part. While its builder's turn runs, the note goes into that turn, as a message you send to a running agent does. Otherwise it goes with the builder's next turn. The note is your own words, shown as yours in **What happened**, and the second review is held to it as it is to a send-back.
- **Cancel…** an item.

### Feedback from GitHub

You can ask for changes on the item's pull request at GitHub instead of on its page.

**Request a review.** On an item or feature PR, you or another person with write access can comment `/windlass review` on its own. The reviewer inspects a read-only checkout of the current head, including commits you pushed. It posts a comment-only GitHub review with its summary and inline findings on lines GitHub can display in the diff, and the full review appears on the item. The item stays on its current step. The reviewer runs once per head, within the item’s budget. Further requests are skipped while a review is pending or after the item ends. Requests from another writer and heads containing changes the platform did not verify use the untrusted-input policy.

**What is read.** A review that requests changes is read whole, with its line comments. A conversation comment, a line comment on its own or a comment-only review is read only when it starts with the App's mention or `/windlass`. An approval adds a line to the item's log and starts nothing.

**Who counts.** Anyone GitHub reports as having write access to the repository: you, through the GitHub account linked to Windlass, and others. Windlass asks GitHub for that permission itself. The role GitHub shows beside a comment (Member, Contributor) does not count, so feedback from a member of an organisation who keeps the membership private is taken. Feedback from anyone else is only counted on the page: its text is not kept, sent to the agent or answered. Windlass reads each review or comment again from GitHub before taking it, and does not take one more than 3 days old.

**Batches.** A review is taken at once. Comments are collected into one batch: it goes after two minutes without a new comment, or ten minutes after the first. A batch holds up to 20 entries and 8,000 characters, oldest first. The rest goes with the next batch. A single entry longer than 8,000 characters is not taken: shorten it or split it. The same feedback twice is taken once.

**What the agent is told.** The words are quoted as written, with who wrote them, their access, and the file, line and commit of a line comment. Your words are your requests. Other writers' words are review the agent weighs, not your instructions. Nobody's words change the agent's rules or the task. Where the agent disagrees, it says why in its report's concerns, and those reach the pull request.

**On a single item**, a batch starts a new run on the same branch, as **Send back…** does. Feedback that arrives while the item works is held. Once CI has finished, it goes before the second review, and that commit is not handed over. Feedback that arrives while the second agent reviews goes first too, when the review asks for changes or has questions: the new run gets the feedback, and the reviewer's points after it. Its questions that only you could answer go to the agent as points too: you are not asked them. The new run's second review starts afresh, without the earlier findings. When the review approves, the commit is handed over first. After three runs started by other writers' feedback, the item asks you before each further batch: **Send it to the agent** or **Leave it**. Your own feedback is never capped. The item's budget still applies.

**On a feature**, feedback that arrives while it works is held in the same way. Your feedback starts a re-plan. Another writer's feedback asks you first: **Plan a fix** or **Leave it**. The planner keeps completed subtasks as they are and adds fix subtasks. You approve the revised plan before anything runs, and its budgets with it. If the feature already has six subtasks, file the fix as a new item.

**Not taken.** Feedback is not taken on a failed, done or cancelled item, on a subtask's own work, or after its machine was removed.

**On GitHub**, a taken comment gets a 👀 reaction. Reviews cannot take reactions. The item's comment on the pull request says which run works on the changes. At the next handoff, Windlass asks each writer whose change request it took to review again. Windlass never replies to people who do not count. If GitHub refuses the 👀 reaction for lack of permission, the factory logs the refusal once and continues.

**On the item's page**, the Checks panel lists the open comments, and **Show all batches** under them lists each batch: who wrote it and when, the file and line, a link to it on GitHub, and what happened to it. A batch is **Taken** into a run, **Held** while a run works, **Waiting** while comments collect, **Needs you** when it asks first, or **Not taken** with the reason. Feedback from people without write access shows as **Counted only**.

## Text from someone else

Some of what an item's agent reads is not yours. Some of it was written by other people:

- the issue, when someone else wrote it;
- feedback on the pull request from anyone but you;
- in a feature, either of these as its subtasks inherit them.

The rest comes from the item's own run:

- CI's logs, when CI fails;
- the second reviewer's findings, and, for the reviewer, the builder's report;
- in a feature, the reports of other subtasks.
- in a cross-repo feature, the combined run's result.

The agent is told in its prompt that all of this is quoted data, not instructions. The item's page and the session's timeline name each source, for example "CI logs of 1a2b3c4" or "issue #42 by @someone".

On most profiles Windlass is told too, with the turn that carries the text and with where it came from. From that turn on, the session counts as tainted. A command that would use the network or run outside Windlass's sandbox asks first, and so does a tool that could send data out. Nobody is there to answer in an item's turn, so such a call is refused, and the timeline says why. Edits in the workspace, commands inside the sandbox, and the platform's own tools (report, push) still work. The session stays tainted until the item ends.

Your MCP servers set to run without asking lose that setting in an item once its session is tainted, also part way through a turn. Their calls are then refused. Windlass taints a session for many reasons, among them the first result of an MCP server that is not marked `untrusted: false`.

Your own words are never marked: an item you wrote, your notes, your answers to the agent's questions, and your feedback on GitHub.

What a turn with such text does depends on the item's profile and its agent:

| Profile | Agent | Text from the run (CI logs, findings, reports) | Text from someone else (issue, feedback) |
|---|---|---|---|
| Docker + Windlass sandbox, E2B + Windlass sandbox | Windlass | Windlass is told. Commands run as before: in its sandbox, without network. | The same. |
| E2B, before the sandbox check | Windlass | Windlass is told. A command Windlass can't sandbox is refused, as before. | The same. |
| E2B, microVM only | Windlass | Windlass is told. Commands move into its sandbox: no network, and nothing written outside the workspace. | The same. |
| Docker, hardened | Windlass | Windlass is not told: it can't sandbox commands there, so it would refuse every one. The text goes labelled only, the timeline says so once, and commands run as on any turn, with the container's network. | The turn does not start. The item asks you, naming the text. **Run it anyway** sends that turn labelled only, as for text from the run: Windlass is not told, so the agent's commands run outside Windlass's sandbox, with the container's network and access to the turn's token file (a placeholder when the model relay is on), and a command the text talked it into is not stopped. Or file the work again on **Docker + Windlass sandbox**, or give up. |
| Docker, hardened | Claude Code, OpenCode, Codex | The agent can't be told. The text goes labelled only, the timeline says so once, and the agent runs every command without asking, with the container's network. | The turn does not start, as for Windlass. The item asks you, naming the text and the agent. **Run it anyway** sends that turn labelled only, and the agent runs its commands without asking, with the container's network and the session's access. Or file the work again with Windlass on **Docker + Windlass sandbox**, or give up. |

After **Run it anyway**, later turns of the item, and its subtasks, that carry no other text from someone else go the same way. Text from someone new asks again. Where the choice is offered, **Hand it over as it is** is there too, once the item has a pull request this run pushed.

Claude Code and OpenCode run work items in hardened Docker or the hosted E2B microVM-only profile. On either profile an item asks before passing along an issue someone else wrote. Read an issue someone else wrote before you choose **Run it anyway** for them. Codex runs work items on Docker + Windlass sandbox by default, where its commands stay in its own sandbox without network, and on Docker, hardened only when you pick it.

A sandbox whose Windlass is older than 0.6.0 also gets labelled text only, and its timeline says so once.

## Orchestrate a feature

Plan first starts with a plan whether the feature needs one implementer or several.

1. **Planning**. A read-only planner examines the task, repository and available machines, then files a FeaturePlan with requirements, done-when checks and work that is out of scope.
2. Review the plan on the item page. If the planner recommends one implementer, choose **Approve for one implementer** to approve that scope. The implementer receives the task and the plan. Planning spend stays visible. The implementer gets one Quick item's budget on top of what planning spent.
3. If the planner proposes a split, review the subtask budgets and approve the plan. The Factory runs the subtasks in dependency order. Each part receives its brief and the original feature task, including its limits.
4. **Feature summary**: once every subtask is done, an agent writes the pull request's summary.
5. CI runs on the whole feature. After the second review, the Factory hands you one pull request. When there is no reviewer, the Factory hands over the feature with the reason on its page. A feature on a machine can have a second review there.

### What you need first

Approving a split into subtasks needs two things on the repository:

- saved [checks](/docs/settings#checks);
- CI that reports on pushes to the feature branch, `windlass/feature-<id>`. If **Wait for CI on each part** is enabled, CI must also report on subtask branches. An enabled GitHub Actions workflow with `on: push` will do, as long as its branch filters do not leave those branches out. CI of another kind counts once it has passed on an earlier `windlass/` branch pushed without a pull request. A workflow that runs only on pull requests is not enough.

If these checks are missing, you can still run the plan with one implementer. The composer flags repositories with no saved checks.

### The plan

The plan says what the feature is for, what it must do, what is left out of it and when it is done. A split plan also lists 2 to 6 subtasks. Each subtask has a title, a brief, the paths it owns, the subtasks it waits for, how it is checked and a budget: one token figure. Subtasks that own overlapping paths take turns, even when neither depends on the other.

On the item's page the plan's goal comes first, then **Requirements**, **Done when** and **Not in it** as short lists. A long list shows its first three lines and **Show N more**. A plan that was set aside, for example after its revisions were used, is marked **superseded** and folded into one line. Choose it to read the plan.

A subtask can request up to four slots on a runner that reports per-slot CPU and memory. Older runners support one slot per subtask. On hosted, the CPUs and memory a subtask names choose the least [hosted size](/docs/start-an-agent#hosted-sizes) that has them, up to 4 vCPU and 8 GiB; a subtask that names none runs on the feature's size, **Medium** by default. A feasible machine that is busy or offline can be approved, and the subtask waits for capacity.

The planner may ask you questions with the plan. It may also say that one item is enough. The item shows the planner’s reason and offers **Approve for one implementer** or **Ask for subtasks**.

The planner reads what you wrote about your machines under [Say when to use it](/docs/machines#say-when-to-use-it).

### Review and approve it

When the plan is ready, the item waits under **Needs you**: "Its plan waits for your approval." Its page shows **It asks you**, "Review the plan: N subtasks, X tokens of the Y the feature may spend", and the plan below it.

- Answer the plan's questions, if it has any. Each is one short question with its choices, or a box for your answer; **Why it asks** opens the planner's background.
- Change a subtask's token budget. You can also change where it runs, see [Placement](#placement), and which agent, model and effort it runs, see [Each subtask's agent](#each-subtasks-agent). **Allotted to subtasks** shows their total against what the feature may spend in all. Once children exist, it also shows their actual spend.
- Choose **Save as version N** to keep changes to budgets, places or agents, or **Discard changes**. Answers alone need no saving.
- Tick each subtask listed under **Agents that work without asking**, if there are any.
- Choose **Approve version N** to start the subtasks. With answers typed and nothing else changed, the button is **Approve**: it saves your answers as the next version and approves that version in one press.
- Choose **Ask for a new plan** to have the planner try again, or **Give up**.

Before you approve, the plan names missing repository checks or push CI and offers **Run as a single item** if you prefer to proceed without adding checks or enabling pushes on `windlass/**`. The tokens spent on planning stay counted.

### Placement

Each subtask is one compact row: its title, **after N** when it waits for another subtask, how many files it owns, two lines of its brief, where it **runs on** and its agent. **Details** opens the whole brief, **why there** (the planner's reason for the place), the files and its checks. The spec under the plan's goal is folded the same way. A subtask's row says, when it **needs** something of a place (CPUs, memory, screenshots, egress or tags), what. A subtask with no place runs where the feature does. The plan's **overflow** line says whether a subtask whose preferred machine is busy may run on one of the alternatives it lists.

The approval card lists, under **Where each subtask runs**, each subtask's place, its agent, its alternatives, whether overflow is allowed and, for every place, whether the repository's secrets are sent there: **secrets sent** or **no secrets**. This platform always gets them; a machine gets them only while its **Send saved secrets** switch is on. The planner may have read an issue anyone could file, so check this before you approve.

While the plan is open you can change a subtask's place from your machines or this platform, its alternatives, and overflow, then save them with the budgets as the next version. A place the platform would refuse, for example a machine whose owner chose **Never** under [Let features use it](/docs/machines#let-features-use-it), or one without screenshots for a subtask that needs them, shows **can't place** and the reason. A refused approval shows the same reason under the subtask. A busy or offline machine is not refused: the subtask waits for it.

When overflow lets a subtask run on more than one place, a place that already holds a prepared sandbox of the repository for you (its [validated environment](/docs/settings#environment)) counts for more. A work item whose builder started from one says "from a validated environment" beside **Open the agent**. That can be this platform or one of your machines. It never takes a subtask from its preferred place when that place could run it anyway, and never sends one where it would be refused or would have to wait.

Once a subtask has its item, its row says where it **ran on** and why, for example "nas · 2 slots" and "Approved overflow from ‘studio’". When the feature waits for a machine, the next subtask's row says which machine and for what, for example "Waiting for 2 free slots on ‘studio’. 0 free now."

### Each subtask's agent

Each subtask says which **agent** it runs, on which model and effort. The planner may propose one for each subtask. Parts inherit the build settings for their repository. Opening the plan and approving it both recheck the current defaults. The planner, critic, reviewer and summary use the Windlass model under **Settings → Models → Plans & reviews with**.

While the plan is open you can change each subtask's agent, model and effort. The menus offer only what the subtask's place offers:

- **This platform** runs Windlass, on any model of your account.
- **A machine of yours** also offers Claude Code and OpenCode where its runner reports them signed in. One that is not signed in is listed but can't be chosen. The models and efforts are the ones the machine reported for that agent.
- **Codex** runs Quick items only. If a part resolves to Codex, approval asks you to **Use Windlass for these parts** or **Choose another agent**.

A subtask with no agent of its own shows the agent it resolves to and where that comes from, for example "— your default". **The default** in its agent menu returns it there; **Windlass** pins it to Windlass.

A subtask on Claude Code or OpenCode runs in the machine's hardened container, on its own model and effort. It never takes the feature's Windlass model: with no model chosen, it runs the agent's default. A choice the place does not offer, for example an agent the machine does not have or a model it does not list, shows **can't place** and the reason, and approval is refused the same way. If the machine changes after approval, for example the agent is signed out, the subtask can't be placed when the feature gets to it, and the feature asks you with the reason.

**Works without asking.** Claude Code and OpenCode work without asking: they run every command and edit in their sandbox without asking you. Wherever such a subtask is shown, it says **works without asking**. The planner reads the item's text, which may come from an issue anyone could file. An inherited agent needs the same confirmation as one the planner chose: the approval card lists each such subtask under **Agents that work without asking**, and **Approve version N** stays unavailable until you tick every one. An approval sent any other way that does not name each one is refused. To run one on Windlass instead, choose **Windlass** for it and save.

**Budgets per agent.** A subtask's budget counts its turns at API prices whatever pays for them, as an item's does (see [When the budget is used](#when-the-budget-is-used)).

**Usage limits.** A subtask waits only for its own agent's usage limits. When Claude Code is at its limit on the preferred machine and overflow is allowed, the subtask can run on an approved alternative whose Claude Code account is not.

**Re-plans.** When the planner revises the plan after a subtask stops, each remaining subtask keeps the agent, model and effort you approved, whatever the planner proposes. Change it on the card if you want another. Answers carry over when the question text stays the same. You answer new or changed questions and confirm any scope change.

### Budgets

A feature's budget is its subtasks' budgets together, and one item's budget of its own for its planning, its summary and its review: 2,000,000 tokens by default. Before a plan, it has its own only. When you approve a plan, the feature may spend what that plan's subtasks are given. A subtask gets at most what one item may, and at least a tenth of it.

When the feature's own turns use its own budget, for example a long planning, it asks you for more, as an item does. When a subtask uses its budget, the subtask asks you, and what you give it adds to the feature's.

### Subtasks

Each subtask is a work item with its own page, which says **subtask of** the feature. It starts from the feature's branch, runs at its approved placement with its own agent, model and effort (the feature's model for a Windlass part without its own selection), and has the subtask's budget. It is given its brief, its paths, the original feature task (including the issue text) and the reports of the subtasks it waits for.

Up to three subtasks can run together when their dependencies are done and their owned paths are disjoint. A subtask with no owned paths runs alone. The planner sees how many parts can run at once on the default machine given its free slots, or how many hosted parts the account can run alongside its personal sessions. Each gets its own branch, place and reserved budget. If a place or budget share is unavailable, it waits while the others work.

By default, each part can join the feature as soon as its local checks pass. Dependent parts can then start. To require passing GitHub CI on each part as well, turn on **Wait for CI on each part** in the repository’s settings before the feature branch opens. The platform integrates one branch at a time by fast-forward or merge commit. A conflict goes back to that subtask to merge the feature branch and pass its checks again. The final summary and review wait for every subtask.

When the target branch moves during a single-repository feature, choose **Update the feature from main** (or the name of your target) on the feature page or a CI question. The platform merges the target into the feature branch between subtask integrations. New parts start from the updated tip. A running part whose CI needs attention can then choose **Update from the base branch and run CI again**. If the target conflicts with the feature, a new part merges the target, resolves the conflicts and goes through the usual checks and integration. If that part fails twice, the feature asks you to check the branch again or give up.

**Following them as they run.** Once the plan is approved, the feature's page shows a **Subtasks** block where it showed where the item is. Its first line counts them, for example "2 running · 1 asks you · 1 of 6 done", with a bar of one segment per subtask. Under it each subtask has one row, in the plan's order: what it is doing now (its step and fix round, for example "implementing · turn 2" or "fixing · your checks failed, fix 1"), where it runs (with "overflow from nas" when it went to an alternative), what it has spent of its token budget, and a **Session** link to its agent. A subtask that asks you shows the start of its question and **Answer**, which opens its page. A subtask not started says what it waits for, for example "After “Add the CSV writer”". The approved plan folds under the block to its goal; **Show all** opens it.

A subtask's page shows the feature in the bar (repository / feature / subtask) and, under its title, **Subtask 4 of 6** with a numbered chip for each subtask and links to the one before and after it. Its session's bar names the feature and the subtask too, and while the subtask waits for you, a line above the conversation says so, with **Answer on its page**. These pages update as the subtasks move on, without reloading.

On the Factory page, a feature in progress counts its subtasks that are running and asking, and lists the active ones, each with its step and where it runs. The lane's count adds how many subtasks run, for example "2 work items · 3 subtasks running". A subtask that asks you is also listed under **Needs you**, with the first line of its question.

If a subtask fails or is cancelled, the planner revises the plan for the work left. Done subtasks stay as they are, and remaining ones keep their approved agent. You review and approve the revised plan again, and its budgets with it. The card says why the feature was planned again, and shows done subtasks greyed, with nothing to change.

After approval, a subtask that has not started yet can still change its agent, model and effort: open **The plan** on the feature's page and choose them on its row. The change applies at once. A subtask that has started keeps the agent it runs. When the same subtask stops a second time, or two subtasks stop with the same failure, the feature asks you instead: **Revise the plan** or **Give up**.

### The pull request

When you approve a split plan, the platform opens a draft pull request from `windlass/feature-<id>` into the base branch. Each subtask's work lands on that branch. When the feature is handed over, the pull request is marked ready for review. If GitHub refuses that step, the platform tries again after 5 minutes, 15 minutes and an hour, and logs GitHub's reason each time. If GitHub still refuses, the rest of the handover goes ahead and the item asks you to mark the pull request ready on GitHub yourself, or to try again. Once the pull request is no longer a draft, the question closes by itself. Merging a feature stays yours.

By default, the factory watches CI on the current feature head as parts join. After the rerun and base check, a failure specific to the feature queues one fix part with the failing checks, their logs and the feature diff. The fix passes the local gate and joins through the same integration queue. Each new head supersedes the previous CI result. Handover waits until all parts have finished and CI passes on the current head. If the same failure comes back after a fix, the feature stops and asks you.

With **Wait for CI on each part** enabled, a failure on the assembled feature asks you to check the PR again, hand it over as it is, or give up.

### When orchestration stops

These stop the feature and ask you:

- with per-part CI enabled, a subtask has no passing checks or no CI on its push: "Orchestration stopped because a subtask lacks passing local checks or push CI. Hand over the feature PR or give up.";
- two subtasks stopped with the same failure, or one subtask stopped a second time;
- with per-part CI enabled, the whole feature has no CI or every check was skipped or neutral: "No passing CI reported on the complete feature. Wait for a check or hand over the PR."

Cancelling a feature cancels its subtasks too.

## Cross-repo features

Where the deployment allows it (`WLP_FACTORY_CROSS_REPO=1`), a Plan-first feature can span two repositories of your GitHub connection, for example the Windlass CLI and this platform. File it from the API with `repositories`: two entries, each with a short alias (`^[a-z][a-z0-9-]{0,15}$`), GitHub's id for the repository and, optionally, its base branch. The first is the item's `repository`, the primary: lists and the origin show it.

```json
{ "repository": { "id": 1001 }, "repositories": [{ "alias": "platform", "id": 1001 }, { "alias": "cli", "id": 2002 }],
  "title": "Show a new model capability", "body": "…", "mode": "orchestrate" }
```

A GitHub issue files a feature in its own repository only. A second repository needs your own filing.

**Planning.** At filing the platform records each repository's installation and the commit of its base. You need write access to each repository, and none may be archived. The planner reads the primary as its workspace and the other repository's base tree, read-only, at `.windlass-inputs/<alias>`. That tree is that one commit alone, fetched with a read token for that repository only, at most 512 MiB a file and 1 GiB in all, and left with no git directory. `.windlass-inputs` is added to the workspace repository's `.git/info/exclude`, so it is never committed. Like the primary's files, that tree counts as your own text, not someone else's: you bound the repository with write access. The combined run's result, which the summary and a repair plan quote, is marked as the run's own text, as CI logs are (see [Text from someone else](#text-from-someone-else)). If the repository already has that path (tracked, committed, a link, or a folder the platform didn't make), or the tree can't be fetched, the planning turn does not start and the feature asks you: it never plans against the primary alone. The copy is removed before any later turn of the feature's own session. If it can't be removed, that turn does not start. The planner's session gets the network list of each repository together (see [Network](/docs/settings#network)).

**The plan** adds, besides the usual fields:

- `repos`, the filing's aliases, and each subtask's `repo`. Each repository needs at least one subtask. Subtasks may wait for subtasks in the other repository. Owned paths are compared within a repository only, so the same path in two repositories is no overlap.
- `mergeOrder`: each repository once, with the repositories that must merge first, what keeps working between the merges, the evidence for it and the fallback. A pull request merges once, so a rollout that would merge one repository again after the other needs a second feature.
- `releaseGate`: `request` for now. The feature ends at a tested pair of pull requests and a release request. Waiting for your release is not offered yet.
- `finalIntegration`: the combined run, `{runFrom, command, inputs, profile: "actions", timeoutSeconds, requiredCases, artifactOutputs}`. `inputs` covers every repository. `earlyChecks` are kept with the plan but not run yet.

Changing any of these after approval counts as a change of scope. The combined run runs on GitHub Actions: its time counts as the feature's working time, not its hosted time.

**Approval** checks each repository through its own installation before any branch is made, and names every problem at once. Each repository needs saved checks and push CI on its feature branch. Repositories with **Wait for CI on each part** enabled also need push CI on their subtask branches. The repository the combined run starts from needs `.github/workflows/windlass-integration.yml`, enabled, on its base (this repository has one). That workflow must run on `workflow_dispatch` only (no `pull_request_target`, push or other trigger), set top-level permissions of at most `contents: read`, give no job more, and reference no secret. Approval names the rule it breaks. The other repository must be public, as GitHub says it at approval, since the run checks it out without a token. If a base moved since the planner read it, approval names the move. Revise the plan, or approve with `bases: {"<alias>": "<new commit>"}` to reconfirm it. Approval takes that commit only if it is where the base is when approval reads it.

**Pull requests.** Each repository gets its own branch, `windlass/feature-<id>`, and a draft pull request. Both can be #1. A repository without draft pull requests stops the feature before any subtask runs; the pull request already opened in the other one is kept, and **Try the remaining repository again** retries only the one that failed. Each pull request carries a section, kept up to date, that links the other by its full address, says which is primary, the merge order and the combined result. Anything you write around it is kept. Neither says `Closes #n`, so the issue is not closed by the first of the two merges.

**Subtasks** share the same three active places across both repositories. Each is made in its subtask's repository, starts from that repository's feature branch, and can push only there. It joins its repository's feature branch under the same rules as any subtask.

**Testing them together.** When every subtask is in, the platform checks the integration workflow again, as it is at the commit it is about to run, by the same rules as at approval, and dispatches it in `runFrom`, on its feature branch, with the head of both feature branches. It follows only its own run: the one with the feature's run name, of that workflow file, on that commit, started by the App. The workflow checks every input out at its commit beside that checkout, checks the commits, and runs the approved command for at most an hour. For the Windlass CLI and this platform the command is `bash scripts/cross-repo-integration.sh`. It builds the CLI from its checkout, stages that executable where the server takes it from, and runs the platform's real-binary checks with it. A case that skips fails the run. The run's time is charged to the feature once.

- A run that fails asks you: **Plan a repair** (a re-plan with the result, as quoted data) or **Give up**.
- A run that was cancelled or timed out can be run once more on the same heads.
- A run that could not start (no workflow, a workflow the rules refuse, or no Actions permission on the App) can be run again once that is fixed.

Both pull requests keep their evidence and stay drafts.

**Hand-over.** After a pass, the summary is written to both pull requests and the feature waits in **review**. Both pull requests stay drafts. Marking them ready needs a review of the set, which is not built yet, so the platform never marks a cross-repo pull request ready. Merge them in the approved order. Each merge is recorded with the commit it made, squash and rebase included, and the time GitHub says it merged. The order is judged by those times, not by when the platform read them. A merge out of order, a pull request merged at a commit other than the one tested together, a pull request closed without merging, or one the platform can't read any more (access removed, repository archived or gone) stops the feature and asks you. Nothing is rolled back. Once both are merged the feature is done. A push to either pull request after the run marks the result stale. The sections on the pull requests are no longer updated once the feature has ended. Feedback on a cross-repo pull request is not taken yet.

The GitHub App needs Actions write on the installation of the repository the run starts from, besides the permissions above.

## The Factory page

The Factory page lists your items by what you must do:

- **Needs you**: items that ask you something, the longest waiting first.
- **Ready for you**: items in review.
- **In progress**: working, queued or waiting.
- **Drafts**.
- **Ended**: done, failed or cancelled, folded away. Unfolded, they show 25 at a time, the newest filed first, each with the day it was filed and the day it ended (an item's page says both too). Items that ended before the platform kept that day show only when they were filed. Choose **Show 25 more** for the next ones.

A repository's **Work items** tab in **Agents** shows that repository's open items the same way, with its ended ones folded under **Show N ended items**. The **Work items** table on **Usage** shows the cost of your open items and your 25 newest ended ones in dollars (see [What an item cost](#what-an-item-cost)), and says how many older ended items the Factory page lists.

Filter it with **repo** and **from**: filed from the web, the API, a GitHub, GitLab, Linear or Jira issue, or Slack. The filters are kept in the address, as `?repository=` and `?from=`.

## Limits

When a Factory turn reaches a limit of this platform, the item waits and shows the reason. Machine turns use the runner's slots and do not count against hosted sandbox limits. GitHub, Linear, Jira and Slack intake share a daily filing limit. The deployment operator can override these limits for your account, and the **Work items** section of the **Usage** page shows them. By default:

| Limit | Default |
| --- | --- |
| Hosted sandboxes running at once, items and your own agents together | 3 |
| Work per item, at API prices | $5 |
| Tokens per item, cost-weighted, while a turn can't be priced | 2,000,000 |
| Hosted sandbox time per item | 2 hours |
| A feature | its subtasks' budgets and one item's for itself |
| Items filed from GitHub, Linear, Jira and Slack together per UTC day, drafts among them | 20 |
| Daily model tokens across items and interactive sessions | Unlimited |

When an item reaches its own budget, it pauses and asks you for more: see [When the budget is used](#when-the-budget-is-used). The operator's item budget applies to newly created items.

When you reach your daily model token cap, admitted turns finish their current Factory step. The next turn waits until 00:00 UTC. This also applies to Windlass on paired machines because it uses the same model sign-in. See [Daily model tokens](/docs/settings#daily-model-tokens).
