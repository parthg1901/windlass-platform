## Do I need a ChatGPT account?

No. Sign in with GitHub or Google. Connect a Claude or ChatGPT plan, or add a model provider key, on **Connections**.

## Can I use Claude Code?

Yes, on one of your own machines. Start its runner with `--harness claude`, and connect your Claude plan or add an Anthropic key on **Connections**. Then choose the machine under **where** and **Claude Code** under **agent**. **Connections → Pay with** decides whether the plan or the key pays. See [Agents on your machine](/docs/machines#agents-on-your-machine).

## Can I use OpenCode, or another model provider?

Yes, on one of your own machines. Start its runner with `--harness opencode`, then run `login opencode` on the machine and choose a provider. See [OpenCode](/docs/machines#opencode).

## Which providers work with OpenCode?

OpenCode Go, OpenCode Zen, ChatGPT, OpenAI, Anthropic, Google, OpenRouter, Z.AI, Zhipu AI and close to 300 more, each with its own API key or account. `login opencode` searches them all. Providers the runner has no fixed route for are not offered, for example Amazon Bedrock, Azure, Google Vertex, GitHub Copilot and models on your own computer, such as LM Studio.

## Can I use OpenCode without a provider account?

Yes. Choose `free` in `login opencode` for OpenCode's free public models. Their allowance is small, and OpenCode counts it by your machine's public IP address, so everyone behind that address shares it. When it runs out, the turn says "The provider's usage or rate limit was reached." Wait, or sign in with a provider of your own.

## Where do I sign Claude Code or OpenCode in?

Claude Code and Codex need no sign-in on a machine: connect a plan or add a key on **Connections**, hosted and on your machines alike. OpenCode on a machine uses its own logins from `windlass-runner login opencode`, and your Settings keys for the rest. The Machines page shows what pays for each agent. See [What pays on your machine](/docs/machines#what-pays-on-your-machine).

## Which keys stay on my machine?

The OpenCode logins you give the runner stay there, in the machine's login volume. The runner never sends them to the platform. No agent's container has them either: a relay on the machine adds them to the agent's model requests. Commands in a session can still use that relay, and so your quota. See [Agent logins stay out of the container](/docs/machines#agent-logins-stay-out-of-the-container).

## Does the agent get my ChatGPT password or sign-in?

No. Your ChatGPT sign-in is never in a sandbox. A Windlass sandbox gets a placeholder that can make model requests through a relay only during that turn. See [Sandboxes and security](/docs/security).

## Does the agent get my GitHub access?

No. The platform does the clone and the push itself, with a token for that one repository that lasts an hour at most and is revoked when the command ends.

## Does Windlass merge pull requests?

You merge by default. If you enable **Auto-merge single items** for a repository, an eligible single item can squash-merge after its checks, CI and second review pass on the same commit. Features are handed to you. See [Automatic approvals and merges](/docs/factory#automatic-approvals-and-merges).

## Can I run agents on a private repository?

Yes. Connect GitHub and give the Windlass App access to the repository at GitHub.

## Can I attach files to a prompt?

No. Put the material in the repository, or paste it into the prompt, up to 20,000 characters.

## What happens when I close the tab?

Nothing stops. The agent keeps working in its sandbox. Open the agent's page again to see where it is. By default an unanswered approval ends a hosted turn after five minutes. On a machine, it is declined after ten. A work item waits for your answer on its page.

## How do I continue an agent that finished?

Send it another prompt. It goes on with the same conversation and, while it still exists, the same sandbox.

## Why did my sandbox get paused?

A sandbox is paused 10 minutes after its last turn, so it uses no sandbox time. The next prompt wakes it up. On this platform, a sandbox not used for 7 days is removed. The conversation stays.

## Is my own machine counted against my sandbox time?

No. Agents on your machines take no sandbox time, no place among your kept sandboxes and none of the sandboxes running at once on this platform, work items included. Your runner sets sandbox capacity. Windlass turns on a machine still count toward any daily model-token limit on your account.

## What does the platform see on my machine?

What its runner reports: whether Docker answers, whether Windlass's sandbox starts there, the free disk, its sandboxes and the limits you set. And what happens inside the containers the runner made for the platform's agents. It cannot run anything on the machine outside those containers. See [On your machine](/docs/security#on-your-machine).

## Can I read a secret's value back?

No. A saved value is never shown again. Keep your own copy.

## Can I run my own platform?

Yes. The platform runs on one Linux host with Docker Compose. The [self-host guide](https://github.com/WindlassAI/windlass-platform/blob/main/deploy/selfhost/README.md) is written for whoever runs it: how to bring the stack up, route it, back it up and update it. In the self-host kit, pair a machine or configure hosted sandboxes for your agents.

## What license is the code under?

The Apache License 2.0, for all of it: the runner, the sandbox images, the server, the web app, the Factory and the deployment kit. You may use, change, self-host and redistribute it, including commercially. It also grants a license to any patents contributors hold on their contributions. See the repository's [LICENSE](https://github.com/WindlassAI/windlass-platform/blob/main/LICENSE).

## Where do I report a problem?

Ask whoever runs the platform. Give them the address of the agent or work item, and the message you saw.
