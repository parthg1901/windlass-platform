Each message below is what Windlass shows, word for word. Where a message names something of yours, such as a repository or a machine, that part is shown as `…`.

## Signing in

**"This platform is by invitation for now, and this account is not on its list. Ask whoever runs it to add you."**\
Ask the operator to invite your platform UID or your verified provider email.

**"This sign-in attempt has expired. Start again."**\
A sign-in attempt lasts 10 minutes. Choose your provider again.

**"Your sign-in is no longer accepted. Sign in again to carry on."**\
Your sign-in on the platform ended, or you were taken off its list. Sign in again.

**"You are not signed in with ChatGPT. Sign in with ChatGPT, then send the prompt again."**\
**"Your ChatGPT sign-in is no longer accepted: it expired or was withdrawn. Sign in with ChatGPT again, then send the prompt once more."**\
The platform could not get a ChatGPT token for the turn. Reconnect your ChatGPT plan on **Connections**, then send the prompt again.

## GitHub

**"GitHub is not connected any more. Connect GitHub again in Settings, then try once more."**\
Open **Settings**, and under **Integrations** choose **Connect GitHub…**.

**windlass/verified never appears**\
Look under **Verdict** on the item. If the installation still has read-only Checks access, its owner must accept **Checks: Read and write**. Open the installed GitHub App's **Configure** page in account or organization settings and approve the pending permissions. Windlass can post the next verification when access is granted.

**"The GitHub App is not installed yet. If you asked an organization for it, an owner has to approve the request first; connect GitHub again once it is installed."**\
An owner of the organization approves the App at GitHub. Then connect GitHub again.

**"That repository is not among the ones your GitHub connection covers. Add it to the GitHub App's installation at GitHub, then choose it again."**\
Choose **Repositories** beside the account in **Settings → Integrations → GitHub**, add the repository at GitHub, then choose it again.

**"… can read … on GitHub but not write to it, so the platform cannot push there for you. Ask an owner of … for write access, then push again."**\
You can work on the repository, but not push to it. Ask for write access.

**"GitHub refused the push: a rule of … protects branches named like …. Let the GitHub App create such branches in the repository's branch rules, then push again."**\
A branch rule covers `windlass/…` branches. Let the App create them in the repository's rules at GitHub.

**"GitHub refused the push because it changes a workflow file under .github/workflows, which the GitHub App is not allowed to do. Take that change out, or make it yourself."**\
The App has no permission to change workflows. Ask the agent to undo that change, then push again.

**"GitHub did not let the GitHub App push to …. Its installation on … needs the permission "Contents: read and write"; if it has it, the repository's own rules keep the app out."**\
Check the App's permissions on that account, and the repository's rules.

**"Nothing was pushed: … would have gone to GitHub with the value of … in it. The platform's own commit was undone, so the change is in the workspace as it was. Take the value out (and out of any commit that has it), then push again."**\
A saved secret's value is in the changes. Ask the agent to take it out, then push again.

## Limits

**"Today's 2 h of sandbox time is used up, so nothing was started. The allowance is whole again at 00:00 UTC, in …"**\
Wait until 00:00 UTC, or run the agent on one of your machines, where this limit does not apply.

**"You keep 5 hosted sandboxes, the most an account may have, and this agent needs one of its own. …"**\
The cap is for the platform's own sandboxes only. Free one on **Usage**, under **Hosted sandboxes you keep**, or delete an agent. Sandboxes on your own machines are not counted: a machine has only the limits its owner set on its runner.

**"This machine has reached its own limit on kept sandboxes, set by --max-sandboxes."**\
The machine's owner capped how many sandboxes it keeps. Free one of its sandboxes on **Machines**, or raise the cap with `--max-sandboxes` (`windlass-runner status` shows it).

**"You already have 3 agents working on this platform, the most it runs for you at once. Agents on your machines don't count. Wait for one to finish, or stop one."**\
Wait, or stop an agent. Work items on this platform count too. An agent on one of your machines is never held back by this.

**"The prompt is … characters long; the limit is 20000."**\
Shorten the prompt. Put long material in a file in the repository and point the agent at it.

**"This turn ran for …, which is the limit, so it was stopped."**\
A turn can run for 45 minutes. Send a prompt to go on from where it stopped.

**"OpenCode sent nothing for 10 minutes with no call of its own running, so the platform ended the turn. …"**\
A Claude Code, OpenCode or Codex agent went quiet: no message, no call of its own running, nobody asked. Most often its provider stopped answering or kept refusing. The turn ends so that it no longer holds a slot on your machine. Send a prompt to try again, or choose another model.

**"Codex's model requests failed (HTTP 502), so it did nothing this turn. …"**\
Every request the agent made to its model failed, so the turn is shown as failed, with the provider's words. Check the provider's status and try again. On a machine, `windlass-runner status` lists the latest answers the credential relay refused.

**"The provider rejected the request."** or **"The provider failed or couldn't be reached."**\
The provider refused the agent's model request, or did not answer it. A work item asks you what to do, with **Try again** and the agents it can hand over to.

**"Nobody answered "…" within 10 minutes, so it was declined."**\
The agent asked a question during its turn and nobody answered. It was told, and went on. Send a prompt to tell it what you want. A work item's questions never time out: they wait until you answer.

**"Nobody answered "…" within 5 minutes, so the turn was ended and its sandbox paused. Send a prompt to go on."**\
In a hosted sandbox an approval waits 5 minutes, so that a sandbox nobody watches does not run on. Send a prompt to go on; the sandbox resumes.

**"Your sandbox time could not be checked just now, so nothing was started. Try again in a moment."**\
Try again in a moment.

## Your machines

**"Your machine "…" is offline. The agent's files are there; send the prompt again when it is back."**\
Start the runner on the machine. Once the Machines page shows it **Online**, send the prompt again.

**""…" has not connected yet. Start its runner, and once the Machines page shows it online, start the agent again."**\
Check the runner's log with `docker logs windlass-runner` on the machine.

**"The runner on "…" is older than this platform takes: update it to … or later, then start the agent again."**\
[Update the runner](/docs/machines#update-the-runner).

**"That code was not found. Check the code on the machine or start pairing again."**\
The code is wrong, expired, or was entered by another account first. Run `windlass-runner pair` on the machine for a new one.

**"Too many code lookups. Try again in ten minutes."**\
You can check 5 codes in 10 minutes.

**"An account can connect up to 3 machines."**\
Remove a machine you no longer use.

**"This machine’s owner has not allowed the Windlass sandbox profile. Start the runner with --allow-profile docker-windlass-sandbox to allow it."**\
See [Allowed profiles](/docs/runner#allowed-profiles), or choose **Hardened Docker on your machine "…"**.

**"This machine has reached its own limit on running sandboxes, set by --max-running."**\
The limit is set on the machine. Start the runner with a higher `--max-running`, or without it.

**"Docker needs at least 5 GB free to create a sandbox."**\
Free disk space on the machine.

**"This machine uses --egress none. Start the session without a repository or restart the runner with --egress restricted."**\
In `none` mode nothing can be cloned. Choose **No repository**, or restart the runner with `--egress restricted` or `--egress open`. See [Network access](/docs/machines#network-access).

**"This kept sandbox has a different network policy. Save its workspace and recreate the sandbox to use the runner’s current --egress setting."**\
The runner's network mode changed after this sandbox was made. Take what you need from it, delete the agent and start a new one.

**"blocked by runner egress policy"**, or `403 Forbidden` in a command's output\
The machine is in `restricted` mode, and the command tried to reach your private network, the machine itself or a blocked address. To allow a private host, start the runner with `--egress-allow` and its DNS name.

**"Docker could not apply the runner’s network policy."**\
The runner could not set up a sandbox's network. Check Docker on the machine, then restart the runner.

**"This runner needs signed runner connections enabled on the platform. Ask the operator to enable them, then pair again."**\
**"This runner requires signed connections. Ask the platform operator to enable them."**\
A new runner pairs and connects only with a platform that signs its runner connections. Ask whoever runs the platform to turn them on, then pair the machine again.

**"Claude Code is not turned on on this machine: start the runner with --harness claude."**\
**"Start the runner with --harness opencode."**\
**"This machine does not offer …."**\
The runner was started without that agent's `--harness`. The runner does not save it, so give it each time. See [Agents on your machine](/docs/machines#agents-on-your-machine).

**"OpenCode on “…” is not signed in. Run windlass-runner login opencode there."**\
**"Run windlass-runner login opencode on this machine."**\
Sign OpenCode in on the machine with `docker exec -it windlass-runner windlass-runner login opencode`. See [Sign OpenCode in](/docs/machines#sign-opencode-in).

**"Nothing can pay for … on “…” yet. Connect a plan or add a key on Connections."**\
Claude Code and Codex on a machine pay with your plan or key. Connect a plan or add a key on **Connections**.

**"Update your runner to 0.3.13 or later."**\
The machine's runner is older than this platform serves, so it cannot connect. Run the update command on the Machines page.

**"Add an Anthropic key in Settings to run Claude Code here."**

Open **Settings → Model providers** and add an Anthropic key. Codex uses OpenAI. OpenCode can use any connected provider. The hosted profile must support the key relay.

**"Codex runs Quick items only."**

Choose **Quick** to run an item with Codex. In **Plan first**, Windlass plans the work. Its subtasks can run with Windlass, Claude Code or OpenCode.

**"… asks you every time it wants to publish …"**\
Claude Code, OpenCode and Codex can't publish without asking: they reach the publish tool from inside the sandbox, where another program could call it in the agent's name. Answer each request, or publish from the session panel.

**"OpenCode does not offer “…” here. Using its current mode “…”."**\
Not an error. The mode you chose is not one OpenCode reported, so it kept its own.

**"OpenCode could not continue the conversation; the files are as they were."**\
**"Claude Code could not continue the conversation; the files are as they were."**\
The agent could not pick up the earlier conversation, so this turn started a new one in the same files. After `logout opencode`, or after the machine was paired again, older OpenCode sessions stop working: start a new agent.

## The model provider

These come from the model's provider, or from the relay on your machine that forwards Claude Code's and OpenCode's model requests. See [Agent logins stay out of the container](/docs/machines#agent-logins-stay-out-of-the-container).

**"The provider refused the request. …"**\
The model's provider refused the turn, and gave the reason that follows. If it adds "You can change the model or reasoning effort with your next prompt.", choose another model or effort and send the prompt again. In a work item, the item asks you instead, with **Try again** and **Give up**.

**"The turn did not run: Windlass could not use one of the tools the platform gives the agent. …"**\
The platform declared one of its own tools to Windlass in a way Windlass does not take, and Windlass said why after "Windlass said:". This is a fault in the platform, not your setup, the model or the provider, and the same turn fails again until the platform is fixed, so a work item offers no **Try again**: **Give up**, or **Hand it over as it is** if it has pushed work. Report the sentence to whoever runs the platform.

**"The provider refused the request. The provider gave no reason."**\
The provider refused without saying why. Try again later, or with another model.

**"The provider's usage or rate limit was reached."**\
The provider says you have used up its allowance for now. Wait and send the prompt again, or choose another model or provider. With OpenCode's free public models this happens soon: their allowance is small, and OpenCode counts it by your machine's public IP address, so everyone behind that address shares it. Sign OpenCode in with a provider of your own to get past it.

**"Provider sign-in is missing or the session placeholder is no longer valid."**\
The machine has no login for this provider, the provider did not accept it, or the session's placeholder no longer matches. Sign the agent in again on the machine. If you ran `logout` or paired the machine again, start a new agent.

**"This request is not allowed by the relay."**\
The relay takes only model requests, and the provider may also refuse a request as not allowed. If it keeps happening, check what the agent's commands send to the relay.

**"The provider failed or couldn't be reached."**\
The provider had an error, or the relay could not reach it. Try again later. Check that the machine can reach the provider.

**"The provider rejected the request."**\
The provider refused it for another reason, and the relay does not pass that reason on. Try another model, or check your account with the provider.

**"Your Claude plan is limited until … UTC. Wait for it, or pay for this turn with your Anthropic key."**\
Your plan reached its limit, and your rule for a limited plan is **Ask me**. Choose **Use my key this time** to send the prompt on your key, or **Wait** to keep it and send it after the reset. Change the rule under **Connections → Who pays**.

**"Your Claude plan is limited until … UTC. Send this again then."**\
Your plan reached its limit and your rule is to wait, or no saved key could pay instead. Your message stays in the composer.

**"Your ChatGPT plan is limited until … UTC. Wait, or use your key for this turn?"** (Windlass)\
Windlass's ChatGPT model is on your limited ChatGPT plan, and your OpenAI key offers the same model. **Use my key this time** runs this one turn on the key's version of the model (for `gpt-5`, `openai/gpt-5`); the next prompt is on the plan again. **Wait** keeps the message so you can send it after the reset. Without an OpenAI key that offers the model, the composer says until when and keeps your message.

**"… was stopped: this turn used what was left of the item's budget."**\
A work item's turn reached its budget while it ran. Its work so far is kept. The item asks for more; **Give it more** goes on from where it stopped.

**A plan's cell says "Stopped working"**\
The provider refused the plan's token twice in a row: it was revoked, expired, or replaced elsewhere. Choose **Reconnect** in that cell and run the command again.

**"ChatGPT did not accept the saved sign-in. Sign in with ChatGPT again, then send the prompt once more."**\
Reconnect your ChatGPT plan on **Connections**, then send the prompt again.

## Work items

**"Windlass couldn't start this issue because Windlass needs write access to this repository for you, and GitHub says you have read access."**\
The App's comment on your issue. Only people with write access can file a work item from GitHub.

**"Windlass couldn't start this issue because you have filed … work items from GitHub today, this deployment's limit. It starts again at 00:00 UTC."**\
GitHub and Linear filings share the daily issue limit. Wait for the next UTC day, or file the item on the Factory page.

**"Waiting for one of your … hosted sandboxes that run at once: … running now. Your machines don't count toward this."**\
Not an error. The item waits for a free place on this platform and starts by itself. Items on your machines never wait for it.

**"Your Claude plan is limited until … UTC. This item starts by itself then."**\
Not an error. The item waits for your plan's reset, as your rule for a limited plan says. Choose **Use my key now** to run its next turn on your key instead (shown only where a saved key can pay), or **Change rule**.

**"Waiting for your Claude plan: … turns already run on it at once, the most it runs together."**\
Not an error. A plan runs a few turns at once; this one starts when one of them finishes.

**"This item has used … of its … tokens (cost-weighted, …)."**\
The item paused at its budget. Its work is kept. Choose **Give it … more tokens** to go on in the same sandbox, **Hand it over as it is**, or **Give up**. See [When the budget is used](/docs/factory#when-the-budget-is-used).

**"The same failure came back after a fix, so the factory stopped instead of trying it again."**\
The item is stuck on one failure. Read its log, then choose **Try it once more**, perhaps with a note to the agent, **Hand it over as it is**, or **Give up**.

**"No checks are saved for this repository. Save checks before approving subtasks, or run the plan with one implementer."**\
Shown before you file a feature. Save [checks](/docs/settings#checks) for the repository, or choose **Quick**.

**"Use a single item or add saved repository checks before approving orchestration."**\
**"This repository’s CI does not report on pushes to the feature branch."**\
A split plan needs saved checks and push CI on the feature branch. With **Wait for CI on each part** enabled, it also needs push CI on child branches. See [What you need first](/docs/factory#what-you-need-first), or choose **Run as a single item**.

**"The plan changed while you read it, here or in another tab: version … is shown now. Check it, then approve again."**\
Someone saved a new version of the plan. Read the version shown, then approve it.

**"Subtask … must be a whole number between … and …."**\
A subtask's budget is below the least a subtask needs, or above what one item may spend.

**"No passing CI reported on the subtask push. Wait for an external check or stop orchestration."**\
**Wait for CI on each part** is enabled and no passing CI was found on this subtask’s branch. Check that your CI runs on pushes to `windlass/` branches. Choose **Keep waiting** or **Give up**.

**"Orchestration stopped because a subtask lacks passing local checks or push CI. Hand over the feature PR or give up."**\
A subtask could not join the feature. The pull request holds the subtasks that did. Hand it over as it is, or give up.

**"… stopped a second time. Inspect the feature before continuing."**\
**"Two subtasks stopped with the same failure. Inspect the feature before continuing."**\
Read the subtasks' pages. Choose **Revise the plan** to have the planner try another way, or **Give up**.

**"No passing CI reported on the complete feature. Wait for a check or hand over the PR."**\
The assembled feature had no CI or only skipped or neutral checks. A queued workflow keeps waiting. Check CI on the pull request at GitHub.

**"Windlass couldn't start this issue because orchestrated work items are disabled on this deployment."**\
The App's comment on your issue. This platform does not offer orchestration. File the issue as a single item.

## Still stuck

Every refusal says what it refused and why. If the message does not tell you what to do, ask whoever runs the platform, and give them the agent's or the work item's address.
