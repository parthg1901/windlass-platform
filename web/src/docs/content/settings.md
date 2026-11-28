## Account settings

Choose **Settings** in the top bar (in the account menu on a phone). What you save here holds for every agent of yours, whatever the repository. What you save for one repository is under **Saved settings** when you choose it in **Agents**.

### Where each choice lives

Three places choose what runs, each saving as soon as you change it:

- **Machines → Where work runs**: the default place, Hosted or one of your machines. For a machine, its isolation and what happens when it is offline: **Wait for it**, or **Offer Hosted**, where the item asks you before it moves. Nothing moves to another place, payer or sandbox without asking. See [Where work runs](/docs/machines#where-work-runs).
- **Connections**: what pays for each agent, hosted and on each of your machines: your plans and your API keys, or an agent's own login on a machine. See [Connections](#connections).
- **Settings → Models** has two choices. **Builds with** sets the agent, model and effort. **Plans & reviews with** sets the Windlass model and effort for planning, review and summaries. **Same as building** uses the usual Windlass model.
- **A repository's Overrides**: a different place, build agent, planning model or hosted sandbox for that repository only.

An item's own choice comes first, then the repository's, then yours, then the deployment's. The composer, the **New work item** form and each part of a plan show one line of what will run and where it comes from, for example "nas · Codex · Astra — your default", with **Change** for that item only.

### Connections

Choose **Connections** in the top bar (in the account menu on a phone). The grid has a row for each agent (Windlass, Claude Code, Codex, OpenCode) and a column for **Hosted** and for each paired machine. Each cell says what pays for that agent there now: a plan, one of your API keys, the agent's own login on that machine, or **Not connected**. A cell that is not connected has one button that leads to the right connect: the plan's command, the key's entry, or the Machines page. On a machine, Claude Code and Codex pay as on Hosted, by **Who pays** below, unless Claude Code's own login is kept on that machine. A machine's Claude Code cell offers both: **Your Claude plan, from Windlass**, or **This machine's own login — it never leaves this machine**, with the command to run there and **Switch back to your plan** while that login is kept. See [Claude Code's own login on this machine](/docs/machines#claude-codes-own-login-on-this-machine).

Hosted uses a connected plan first, then a key. **Who pays** has, for Claude Code and Codex, two choices that every turn follows from its start, hosted and on your machines:

- **Pay with**: **Plan first, then key** (the default), **Plan only**, or **Key only**.
- **When limited**: what a turn does when the plan hits its limit: **Wait for the reset**, **Use my key**, or **Ask me**. By default work items wait and your own sessions ask. Without a saved key a limited plan always waits.

A plan pays only for your own work, never a teammate's, and only for the real Claude Code or Codex. An item filed from Slack, Linear or Jira by someone whose account there is not linked to yours never runs on your plan: it uses your key, or asks. A plan runs a few turns at once (three by default); more wait for one to finish, like a limit.

A plan's cell shows how the platform last saw it:

- **Limited until 14:00**: the plan reached its 5-hour or weekly limit, and the provider said when it resets. **Limited · trying again at 14:00**: the provider named no time, so the platform tries again then, and waits longer each time it is still limited.
- **Stopped working**: the provider refused the plan's token twice in a row. Choose **Reconnect** and run the command again. Until then, turns use your key where Pay with allows, or say so.

A work item waiting for a limited plan says so on its page, for example "Your Claude plan is limited until 14:00 UTC. This item starts by itself then." It starts by itself at that time. Where a saved key could pay, **Use my key now** runs its next turn on the key instead, once; **Change rule** leads to Who pays.

In your own session, a prompt sent while the plan is limited asks first when your rule is **Ask me** (the default): **Use my key this time** sends it on your key, and **Wait** keeps it in the composer so you can send it after the reset. With **Wait for the reset** the composer says until when and keeps your message.

Windlass has no **Who pays** choice: the model you pick decides. Its ChatGPT models run on your ChatGPT plan, and a model under a provider (such as `openai/gpt-5`) runs on that key. When the ChatGPT plan is limited, hosted Windlass does what the defaults say: a work item waits for the reset, and your own session asks. **Use my key this time** (or **Use my key now** on an item) runs that one turn on your OpenAI key's version of the same model, such as `openai/gpt-5` for `gpt-5`, where your OpenAI key offers it; the next turn is on the plan again. Without such a key, it always waits. Windlass's turns do not count toward the plan's few turns at once. Windlass's limits on the ChatGPT plan show in the plan's cell, as Codex's do.

When a hosted agent in the composer is not connected, it says so and links to its cell.

### Model providers

**Connect**, on the ChatGPT plan row under **Connections → Plans**, shows a command to run in a terminal on your own computer (Node 18 or later):

```sh
npx @windlassai/cli connect codex
```

The command shows a code and opens a Windlass page in your browser. Check that the page shows the same code, then choose **Approve**. The command then runs Windlass's sign-in, which opens ChatGPT's sign-in in your browser. On a computer without a browser it prints a link instead: open it anywhere, approve, and paste the address the browser ends on back into the terminal. The command hands the sign-in to your account; your own Windlass sign-in on that computer is untouched. The platform keeps the sign-in encrypted and refreshes it itself. **Reconnect** replaces it and **Disconnect** removes it. Your platform login and sessions stay with your GitHub or Google identity.

This connection is your **ChatGPT plan**. Windlass's ChatGPT models run on it. Where the platform offers plans, hosted Codex runs on it too, before an OpenAI key, and the row says "Also pays for hosted Codex". Codex's models on the plan come from ChatGPT's own list, read when you connect; **Check again** reads it anew. Until it has been read, Codex offers only **Agent default**. The plan's tokens never enter a sandbox, and turns already running on an old connection stop within a minute of a reconnect or disconnect.

### Connect your Claude plan

Where the platform offers it, the **Claude plan** row under **Connections → Plans** lets hosted Claude Code run on your Claude Pro or Max plan instead of an API key. Choose **Connect**, then run the command it shows in a terminal on your own computer:

```sh
npx @windlassai/cli connect claude
```

The command shows a code and opens a Windlass page in your browser. Check that the page shows the same code, then choose **Approve**; choose **Deny** if you did not just run the command yourself. After you approve, the command runs `claude setup-token` (installing Claude Code through npx if needed). Sign in to Claude there, and the command hands the token it prints to your account. Windlass checks it with Anthropic, keeps it encrypted, and shows the account it belongs to, for example "Connected as a@b.com · Max". The token never enters a sandbox, and the command does not save it. A code expires after three minutes if you do not approve it; once approved, the command has ten minutes to hand the token over. **Reconnect** replaces the token and **Disconnect** removes it; turns already running on the old one stop within a minute.

Claude Code's models on the plan are the ones it offers in its first turn on the plan; until then it offers only **Agent default**.

For a self-hosted platform, add `--platform https://your-platform` to the command.

In **Connections → API keys**, choose **Add key…** for OpenAI, Anthropic, Google (Gemini) or OpenRouter. You can save one key per provider. Windlass stores it encrypted, checks it with the provider and shows its last four characters and the number of models found. Use **Check**, **Replace…** or **Remove…** to manage it later.

These keys authorize model requests on your behalf. The platform stores them encrypted, shows only the last four characters, and uses a per-turn relay to keep the key outside the sandbox. Removing or replacing a key stops new requests through leases for the old key. Hosted sandboxes use these keys where no connected plan pays: Claude Code your Anthropic key, Codex your OpenAI key, and OpenCode the key for the selected provider. On a paired machine, Claude Code and Codex use your plans and keys as on Hosted, and OpenCode uses its own logins there and your keys for the other providers. Windlass uses your API key for the models listed under that provider, and your ChatGPT sign-in for your plan's models.

### MCP servers

Add servers of your own with **Add…**. They give your Windlass sessions their tools, whatever the repository. Windlass starts them without asking first. Windlass asks before a call of an MCP tool. Tick **Run this server's tools without asking** to have the platform answer for you, in every agent of yours. Each call still shows in the timeline.

> **Careful** With this on, nothing stops to ask if something the agent read talks it into misusing a tool of this server. Such a tool runs outside the command sandbox, with network access.

A change holds from each agent's next turn. An account can keep 20 servers. A server's name can be up to 64 characters long.

### Secrets

Account secrets go to MCP servers by default: your own, and a repository's once you approve it. You can also give one to the agent's commands. A repository's setup command never gets an account secret. An account can keep 50. See [Secrets](/docs/security#secrets) for where each one goes.

### GitLab

GitLab appears under **Settings → Integrations** only when the deployment operator has [configured OAuth](https://github.com/WindlassAI/windlass-platform/blob/main/docs/configuration.md#gitlab) for one GitLab instance.

1. Choose **Connect GitLab…** and approve access on GitLab. This connects your GitLab account for project work; it does not change how you sign in to Windlass.
2. Back in Settings, search for a project, choose its namespace and name, then select **Save project**. You need Maintainer access or higher so Windlass can register the project webhook. Settings shows the selected project and its default branch.

Your GitLab sign-in never enters a sandbox. For each clone, fetch or push, Windlass creates a short-lived project access token for that project, with read access to clone or write access to push, and revokes it when the operation ends. Maintainer access is also needed for this. On GitLab.com, project access tokens need a Premium or Ultimate plan. On self-managed GitLab any plan works, unless an administrator or group owner has turned them off. Without them, the item stops and says what is needed, and nothing is cloned or pushed.

Windlass generates a secret for the project hook; you do not need to enter one. Deliveries with a missing or incorrect `X-Gitlab-Token` are refused and file nothing. To try the connection, [file an item from a GitLab issue](/docs/factory#from-a-gitlab-issue).

If GitLab stops accepting the connection (you revoked it, or it expired), Windlass forgets it and Settings asks you to reconnect. Connect again and save the project.

Choose **Disconnect…** and confirm to forget the connection and selected project. Windlass no longer accepts events for that connection. Your GitHub connection is unchanged.

### Linear

Where Linear is available, connect your workspace and map each team to a GitHub repository. **Disconnect…** removes its mappings and stops new filings. Existing items stay. Label an issue `windlass` or assign it to the Windlass app. Use `windlass-quick` or `windlass:quick` for Quick mode. Linear's connection acts as the Windlass app, not as you, so right after connecting Windlass asks you to sign in to Linear as yourself once more to [link your account](#linked-accounts). See [From a Linear issue](/docs/factory#from-a-linear-issue).

### Jira Cloud

Connect Jira, approve access in Atlassian, then choose a site. Under **Jira Cloud**, map a project to a writable GitHub repository. Remove a mapping or choose **Disconnect Jira** to stop filing. Existing items stay. Connecting also [links](#linked-accounts) the Jira account you approved with. See [From a Jira issue](/docs/factory#from-a-jira-issue).

### Slack

Choose **Connect Slack…**, approve the workspace, and invite Windlass to a public or private channel. In Settings, choose **#channel** and a repository you can push to, then **Map channel**. Installing the app [links](#linked-accounts) your own Slack account. Disconnecting removes the bot token, the workspace's linked accounts and mappings. Existing items stay. See [From Slack](/docs/factory#from-slack).

**Post plan and question details** is set per channel. Every member of the channel can read what Windlass posts there. With it on, Windlass posts the plan's goal, parts, checks and budget, and a question's text. With it off, Windlass posts links and choice buttons only. A new mapping turns it on for a public repository and off for a private one.

Slack appears only when the deployment operator has [configured the Slack app](https://github.com/WindlassAI/windlass-platform/blob/main/docs/configuration.md#slack).

### Linked accounts

Work filed from Slack, Linear, Jira or GitLab belongs to the person who asked for it: whoever mentioned Windlass, added the label or made the assignment. It is filed in the Windlass account linked to that person, and runs with that account's connections, limits and repository access. It never runs in the account of whoever connected the workspace on their behalf. Nothing is filed for a person who hasn't linked an account.

Each of those cards under **Integrations** has a **You:** line under its status. It reads **linked as** your name there, or **not linked yet**, with a button to link. A notice at the top of Integrations names each source you connected but aren't linked on, because what you file there won't run.

Linking is a read-only sign-in as yourself at that service. Windlass reads only who you are, then drops the sign-in. Back in Settings, you're linked straight away, and the card names the account, for example "Linked Linear user Ada Lovelace (Acme workspace)".

- **Slack.** Choose **Sign in with Slack…**. Where the operator hasn't set up Sign in with Slack, mention Windlass in a mapped channel instead. Windlass sends you a private, one-time link. Installing the app links the person who installs it.
- **Linear.** Choose **Link Linear…**. Connecting Linear asks for this sign-in right after.
- **Jira.** Choose **Link Jira…** and pick a Jira site you use when Atlassian asks. This doesn't touch the Jira connection. Connecting Jira links the account you connect with.
- **GitLab.** Choose **Link GitLab…**. Connecting GitLab links the account you connect with.

When someone who hasn't linked labels or assigns a Linear or Jira issue, Windlass comments once on that issue asking them to link. On Slack, Windlass sends them the private link.

A private link from Slack may have been forwarded, so opening it doesn't link anything by itself. The Slack card names the Slack user and workspace on its button, for example **Link Slack user ada in Acme to this account**. Choose it only if that's your Slack account.

A sign-in's return works only for the Windlass account that started it, and a private link works once. A newer link of the same account replaces the older one. **Unlink me** in a card's **⋯** menu removes your link there. You're then treated as not linked again.

### API tokens

Where the platform offers work items, you can make up to 20 API tokens for scripts that file and read your work items. To file an item, send `POST /api/items` with the header `Authorization: Bearer <token>`. See [From the API](/docs/factory#from-the-api).

A token works until you revoke it. Choose **Revoke token** to stop it at once. Work items it filed stay.

### Plans and billing

Where the platform has plans, **Plan** at the top of Settings shows your plan, the hosted minutes you've used since your last reset, and **Upgrade to Pro** or **Manage billing**.

A **hosted minute** is one minute of a Medium sandbox on the platform (2 vCPU, 4 GiB). A small one counts half and a large one twice. Agents on your own machines are never counted, on any plan.

| | Free | Pro |
| --- | --- | --- |
| Price | $0 | $15 a month, or $144 a year ($12 a month) |
| Your own machines | Unlimited runs, up to 3 machines | Unlimited runs, up to 10 machines |
| Hosted minutes | 120 a month | 1,800 a month |
| Hosted at once | 1 | 5 |
| Sandbox sizes | Small, Medium | Small, Medium, Large |
| Features over two repositories | No | Yes |
| Items filed from GitHub, Linear, Jira and Slack together | 20 a day | 100 a day |
| Past the included minutes | Hosted agents stop until the month resets | Monthly Pro bills $0.006 a minute up to your spend cap. Yearly Pro stops at 1,800 minutes a month. |

- **Reset dates.** Free resets at 00:00 UTC on the first of the month. Pro starts when your subscription starts. Monthly Pro resets at the end of your billing period. Yearly Pro resets on each monthly anniversary, on the last day of a shorter month. Settings shows your next reset.
- **Near the limit** the Agents page shows how many of your minutes you've used. **At the limit** hosted agents can't start, and a running turn stops when the time it holds is over, with its files kept. Agents on your own machines keep running.
- **Spend cap.** On monthly Pro, minutes past the included 1,800 are billed at $0.006 each, up to the cap. The cap starts at $20 per billing period. Set it lower under **Spend cap**, or to $0 for no overage. At the cap hosted agents stop until the period resets, so you're never billed past it.
- **Yearly Pro** has no overage or spend cap. Switch to monthly Pro for overage.
- **Upgrade** opens the payment provider's checkout. Choose **Monthly** or **Yearly** on the **Plans** page first. Pro's limits apply as soon as the payment goes through.
- **Manage billing** opens the provider's portal, where you change your card or cancel. A cancelled plan stays Pro until the end of the period you paid for.
- **If a payment fails or the subscription is paused**, Pro's limits stay for a grace period (seven days unless the platform says otherwise), and Settings says until when. Then the account moves to Free's limits. Nothing is deleted. Kept sandboxes, machines and items stay, and only what can start next follows Free's limits. Use **Manage billing** to resume a paused subscription.

Without plans, the platform's operator sets your limits, and **Usage** shows them.

### Sign out everywhere

**Sign out everywhere** signs you out on every device, including this one. **Also revoke all API tokens** is checked by default. Clear it to keep your scripts working with their existing tokens. Running agents continue, and paired machines keep working. On the **Machines** page, you can [remove a pairing](/docs/machines#remove-a-machine).

## Repository settings

Choose a repository in the rail of **Agents**, then **Saved settings**. Sections such as **Checks** have a direct address, for example `/repositories/<id>/settings#checks`.

### Overrides

Each row shows what this repository's work runs with and where it comes from: **Place**, **Agent** and, where there is a choice, **Hosted sandbox** (its size and isolation). Choose **Override for this repository** to change one here; **Use your default** removes the override. Without a saved size, work items run on **Medium**. A choice made when you file an item still wins. See [Hosted sizes](/docs/start-an-agent#hosted-sizes).

### Work item approvals

**Auto-approve small plans** and **Auto-merge single items** are separate opt-ins. See [Automatic approvals and merges](/docs/factory#automatic-approvals-and-merges).

**Wait for CI on each part** is off by default. With it off, parts can join the feature after their local checks pass, and the Factory watches CI on the assembled branch. Turn it on before the branch opens to require push CI on each part as well. See [Subtasks](/docs/factory#subtasks).

### Screenshots

**Allow screenshots for work items** lets builders and reviewers attach pictures of the app to their work item reports. It is off by default. For a feature, only subtasks marked in the approved plan get a browser.

### Setup command

A command that runs once when a workspace is created for the repository, before the agent starts: for example, to install dependencies. It runs with network access, outside the agent's command sandbox, for at most 10 minutes. Builder setup can receive repository secrets of either scope. Reviewer setup receives only setup-scoped secrets. On a machine, **Send saved secrets** must also be enabled.

It can be 2,000 characters long. Put a longer one in a script in the repository and run that. A change applies to workspaces created after it: an agent that already has one is not set up again.

### Checks

Commands that verify the agent’s changes. Within a turn Windlass can send the agent back three times. For Claude Code, OpenCode and Codex the platform can send it back twice. Codex on the command-sandboxed profile records matching checks as unable to start. A pull request the platform opens says which checks ran and how each ended. Without checks, a pull request says that nothing was verified.

| Limit | Value |
| --- | --- |
| Checks per repository | 20 |
| Name | 64 characters |
| Command | 2,000 characters |
| Time per check | 1 to 3,600 seconds, 120 by default |
| File patterns | 20, of up to 200 characters each |

The repository can add checks in `.windlass/config.json`. File patterns are comma-separated globs, such as `src/**, test/**`. Pull requests show which checks ran and who set them.

Agents on the repository have new checks from their next turn.

### Environment

A prepared sandbox for the repository: the platform runs the setup command in a fresh sandbox, then every check above, all of them, on the default branch. It keeps the result when setup passes and the sandbox could run every check. New agents and work items on the repository then start from it, with setup already done, and say "Started from a validated environment". Until one passes, and while the one there is stale, they start cold, as without one.

There are environments for up to three places where the repository’s sessions ran in the last 14 days, counting hosted and machine places together. The section shows each place with its state:

| State | What it means |
| --- | --- |
| Ready | It passed, under the setup command and checks saved now. New sessions start from it. When a check ran and failed on the default branch's own code (main is red), it is still ready and says so: "Ready · main's checks fail: lint". |
| Building | A build is running. |
| Failed | The latest build failed because of the sandbox: setup failed, or the sandbox could not run a check (an **environment problem**, such as a pnpm that is not the one the repository pins). The section shows which check, what kind of problem, and the end of its output. A failed build never replaces the last one that passed: if that one still matches the saved settings, sessions keep starting from it. |
| Stale | The setup command or the checks changed since it was built, or the image is no longer at that place. Sessions start cold until it is rebuilt. |

It is rebuilt:

- on a schedule: **Nightly** (the default once a setup command is saved), every 12 hours, every 6 hours, or **Off**;
- 10 minutes after a push to the default branch (or a merged pull request), at most an hour after the first of several;
- 2 minutes after you save the setup command or the checks;
- when you choose **Rebuild** for a place, or **Rebuild all**.

A build takes sandbox time like an agent, counts as one of your running agents while it runs, and is held to the same limits. When a limit is reached it waits, says why, and tries again later. It is built only on machines left on **Any feature** under [Let features use it](/docs/machines#let-features-use-it), never on one set to **When named** or **Never**, and waits while a machine is offline. A repository with saved secrets has no environment. Only Windlass sessions start from one. On this platform an environment is built in one [hosted size](/docs/start-an-agent#hosted-sizes), that of the repository's latest agent or work item here (else its saved size, else **Medium**), and only sandboxes of that size start from it: one of another size starts cold.

### Network

Where the platform limits its hosted sandboxes' network (**Restricted**, see Security), the repository's agents reach the model API, GitHub, the bucket that keeps their memory and the hosts the platform allows. Here you can let them reach more, for every hosted agent on the repository. It changes nothing for agents on your own machines. A [cross-repo feature](/docs/factory#cross-repo-features)'s own agent, which plans over both repositories, reaches what each one's list allows; each of its subtasks gets its own repository's.

**Presets** are named sets of hosts, chosen with a checkbox each. A preset the platform allows for every sandbox already is shown checked and cannot be changed here.

| Preset | For | Hosts |
| --- | --- | --- |
| npm registry `@npm` | npm, pnpm, Yarn and Bun packages | `registry.npmjs.org`, `registry.yarnpkg.com` |
| PyPI `@pypi` | pip, uv and Poetry packages | `pypi.org`, `files.pythonhosted.org` |
| GitHub downloads `@github` | Release assets, raw files and archives | `github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`, `release-assets.githubusercontent.com` |
| crates.io `@crates` | Cargo packages | `crates.io`, `index.crates.io`, `static.crates.io` |
| Go module proxy `@go` | Go modules and their checksums | `proxy.golang.org`, `sum.golang.org` |
| nodejs.org `@node` | Node.js downloads, and the headers node-gyp builds native addons with | `nodejs.org` |
| Playwright browsers `@playwright` | What `playwright install` downloads, except Chromium on x86_64, which comes from Google Cloud Storage (`@gcs`) | `cdn.playwright.dev`, `playwright.download.prss.microsoft.com` |
| Google Cloud Storage `@gcs` | Every public Google Cloud Storage bucket, anyone's. Playwright's Chromium for x86_64 comes from it | `storage.googleapis.com` |
| Prisma engines `@prisma` | The engines Prisma downloads when it is installed | `binaries.prisma.sh` |
| Debian packages `@debian` | Debian's apt sources | `deb.debian.org`, `security.debian.org` |
| Ubuntu packages `@ubuntu` | Ubuntu's apt sources; the sandbox runs Ubuntu | `archive.ubuntu.com`, `security.ubuntu.com`, `ports.ubuntu.com` |

`@gcs` is a preset of its own because `storage.googleapis.com` serves every public Google Cloud Storage bucket, not only Playwright's: allowed, it lets a command send to or fetch from any of them. The page says so wherever you can allow it.

- **Hosts** are exact names, such as `registry.example.com`: no addresses, ports, paths or wildcards. A repository can allow 40 hosts, presets counted by their hosts, and fewer where the platform's own list leaves less room.
- **Asked for by its agents** lists the hosts a command in one of the repository's sandboxes looked up and could not reach. Choose **Allow** or **Dismiss**. The agent and the repository's scripts choose what a command looks up, so allow only a host you expect. The list keeps 30 hosts; once it is full, a new one is not added, and the agent's timeline says so, until you allow or dismiss some.
- **Look for hosts in the repository** reads the manifests, lockfiles, install scripts and CI files of the default branch, and the setup command, and lists the presets and hosts they name that the sandboxes cannot reach yet, each with where it was found, for example "package.json scripts.postinstall". Nothing is allowed until you choose **Allow** for it: a file in a repository can name any host.

The repository list applies to restricted E2B sandboxes. A turn's **Blocked network requests** row in the session timeline, and a work item's **Network** block, offer **Allow for this repository** for a host this list can allow. On a paired machine, the machine owner controls the runner’s public host list with `--egress-domains`, and the row says so for each host the machine refused. Work-item pull requests include a count of blocked requests.

A change applies to each hosted agent from its next turn. **Allow for this repository** in an agent's timeline applies at once to that agent's sandbox while a turn is running in it, and otherwise from its next turn. Only you can change this list: it is saved with your settings for the repository.

### Secrets

Repository secrets go to the setup command, and to the MCP servers the repository names, where their definition reads it as `${NAME}`. Choose **Also the agent's commands** to give one to the agent's commands too.

- A repository can have 50 secrets, and you can have 2,000 over all your repositories.
- A name uses letters, digits and underscores, does not start with a digit, and is up to 64 characters long. Names the sandbox or Windlass relies on are refused, such as `PATH`, `HOME` or names starting with `WLP_`.
- A value is at least 8 characters long, so it can be found and taken out of what the platform shows, and at most 16,384 bytes. It can have several lines.
- A saved value cannot be shown again. Leave the field empty to keep it.

### MCP server approvals

An agent asks before it starts an MCP server that the repository names: **Start this project's MCP server "…"?** When you choose **Start it for this project**, the approval is remembered for 30 days. This section lists them. Choose **Forget** to remove one.

### Delete what is saved

**Delete what is saved…** removes the setup command, the checks, the network list and its requests, the secrets, the defaults and the remembered approvals of the repository at once. Screenshots return to off. The repository's agents are not deleted. This cannot be undone, and a secret's value cannot be read back, so keep a copy of any you still need.

## Usage

The **Usage** page shows your effective limits, hosted sandbox time, what your work items' model turns cost today and kept sandboxes. **Models today** prices the day's turns as an item's cost is priced: what your API keys paid, and, where a plan carried turns, what they are worth at API prices, for example "$1.20 on your keys + ≈ $3.40 included in your plans". Model tokens are under **Details**. The deployment operator sets account limits.

### Daily model tokens

Windlass turns on ChatGPT count input and output once toward the daily model cap, including on paired machines. For Settings-key turns, Usage reports tokens under the selected provider. Hosted time counts for either kind of turn. The allowance resets at 00:00 UTC. If a cap is set and you reach it, running turns finish, new Factory turns wait and new interactive prompts show when you can try again.

### Sandbox time

Sandbox time is the time your agents' sandboxes run: while an agent works, and for a short while after. A paused sandbox uses none. The default is 2 hours of sandbox time a day, for all your sandboxes together. The allowance is whole again at 00:00 UTC.

**Hosted time today** shows time used and time left. Open **Details** for time held and the reset time. A running sandbox holds 5 minutes at a time ahead. A turn needs at least 30 seconds left to start.

When less than a fifth of the day's time is left, the session and the composer warn you. When it is used up, a turn cannot start, and a running turn is stopped at the end of the time it held. Its sandbox is paused with its files as they are, and the conversation is kept.

### Hosted sandboxes you keep

**Usage** shows your limit for keeping hosted sandboxes, running or paused. The default without plans is five (two on Free, ten on Pro). Sandboxes on your own machines are not counted: **On your machines** lists them, with the only limits a machine has, the ones its owner set on its runner (`--max-running`, `--max-sandboxes`, and the snapshot and mirror disk limits). With none set there is no cap; the machine's slots and free disk decide. To free one, choose **Free…** beside it, then **Free sandbox**. The dialog says what is lost and what is kept: the workspace's files that are not on GitHub go with the sandbox, while the agent, its conversation and, where the platform keeps one, the copy of the agent's memory stay. The agent's next prompt starts a new sandbox. This cannot be undone.

A finished, failed or cancelled work item frees its sandboxes, including its subtasks' sandboxes as they end. An item waiting for review or an answer keeps its sandbox for three days after its last activity. Later PR feedback starts a fresh checkout of the published branch. If a new turn reaches the hosted kept limit or a runner’s configured kept limit, Windlass frees the least recently used eligible sandbox there. Working turns are protected, and a personal agent is eligible only after more than three idle days.

A hosted sandbox left behind by an agent that no longer exists takes no place, and the platform removes it within 30 minutes. A work item's second reviewer is listed as **Task title · Code review**, and shares its item's place.

### Estimated cost

Where the platform's sandboxes are billed by the second, as on E2B, the page shows an estimated cost: the counted seconds times the provider's published price for the sandbox size. Where there are hosted sizes, **Hosted time today** lists each size with its price an hour, and **Today by agent** names each agent's size and prices its time at that size. The daily allowance counts seconds the same whatever the size: a larger sandbox costs more, and uses no more of the allowance. Earlier days in the history are priced at the small size. It is labelled as an estimate. The provider's bill can differ by a few seconds, and by more when a server stops under a running sandbox.

### Other sections

- **Today by agent**: the day's time, agent by agent.
- **On your machines**: agents on your machines. They are not counted against your daily sandbox time, running agents or kept sandboxes.
- **Work items**: what the Factory may run for you at once, and what each item may spend.
- **Summary**: what finished work cost over the last 7, 30 or 90 days, by size and by type, with what was spent on retries and on items that did not finish. See [What finished work costs](/docs/factory#what-finished-work-costs).
- **The last 14 days**.

## Limits

These are the deployment defaults without plans or account overrides. Your runner sets its machine’s sandbox capacity. The account’s daily Windlass model-token limit also applies on machines.

| Limit | Default |
| --- | --- |
| Sandbox time on this platform | 2 hours a day, reset at 00:00 UTC |
| Sandboxes running at once on this platform | 3, your agents and work items together |
| Sandboxes kept on this platform | 5 |
| A paused sandbox on this platform | removed after 7 days without use |
| Model tokens | Unlimited |
| Prompt length | 20,000 characters |
| Turn length | 45 minutes |
| Time to answer a question during a turn | 10 minutes; 5 minutes for an approval in a hosted sandbox |
| Note with an answer | 2,000 characters |
| Clone of a repository | 3 minutes |
| Setup command | 10 minutes |
| Pull request title or commit message | 120 characters |
| Pull request description | 4,000 characters |
| Machines per account | 3 |
| MCP servers per account | 20 |
| Account secrets | 50 |
| Secrets per repository | 50 |
| API tokens | 20 |

A question during a turn is one the agent asks while its turn runs, for example to approve a command. The turn holds its sandbox while it waits, so after 10 minutes the question is declined and the agent goes on. In a hosted sandbox an unanswered approval ends the turn after 5 minutes instead, and the sandbox pauses until you send a prompt. A work item never asks this way: its questions end the turn and wait for days if need be.

Work items have their own budgets and one shared limit on items filed from GitHub, Linear, Jira and Slack. See [Factory limits](/docs/factory#limits). On your own machines, your runner sets sandbox limits. Windlass shares the daily model cap shown on Usage. See [Runner reference](/docs/runner#run-options).
