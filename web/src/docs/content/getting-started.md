## Get access

Sign in with GitHub, or with Google where the deployment offers it. If the platform is by invitation, ask the operator to add your verified email or platform user ID. The invitation list is checked at sign-in and whenever you use the platform.

## Sign in

Choose **Continue with GitHub** or **Continue with Google**. Authorize Windlass at the provider and return to the same browser tab. Signing in with GitHub works before installing the App on any repository.

To keep an existing account, open **Settings → Account** while signed in and choose **Link** beside GitHub or Google. Keep the tab open through the provider redirect. You can unlink a provider once another login method is linked.

Your provider identity selects your account. An unlinked identity creates a new account if admitted, including when its verified email matches another user. If you have lost your existing session, ask the operator to link your provider identity to your original UID before signing in.

You can connect a ChatGPT or Claude plan, or API keys, on [Connections](/docs/settings#connections) to run agents with them.

### First-run setup

The first time you sign in, Home walks you through four steps:

1. **GitHub**: install the Windlass GitHub App on the repositories you choose.
2. **Repository**: pick one to start with.
3. **Agents**: for Claude Code and Codex, choose **Use my plan** (chosen for you where the platform offers plans), **API key**, or **Run on my computer**, which pairs a machine of yours. More agents and keys are on Connections.
4. **First item**: pick a starter task (the repository's oldest open issues labelled "bug", or a small safe change such as adding a test) or write your own, and choose **Start item**. It runs as a Quick work item and ends in a pull request.

The setup opens while your account has no agents and no work items and GitHub or an agent is not connected yet. **Set up later** closes it; Home then offers **Resume setup**, which opens it where you left it. This browser remembers the step you reached. It does not open again once you have run anything.

### The demo

Some deployments offer a demo. The sign-in page then shows **Try the demo**. The demo runs a scripted model with real tool calls and needs no account.

### Sign out

Open the account menu and choose **Sign out**. This signs you out in this browser. Only this browser forgets its sign-in: the platform's token itself stays valid for up to 30 days. An account taken off the invitation list is refused at every call, whatever token it holds.

## Connect GitHub

Connect GitHub to launch agents on your own repositories, private ones included, and to get their work back as pull requests. Without it, an agent can still clone a public repository by its address, or start in an empty one.

1. Open **Settings**, and under **Integrations** choose **Connect GitHub…**. You can also connect from the repository row of the **where** menu when you start an agent.
2. GitHub opens in a new window. Authorize the Windlass GitHub App there.
3. If the App is not installed on your account yet, GitHub shows its installation page. Choose the account and the repositories the App may see.

When GitHub is done, its window closes. What you were writing stays where it was, and the repository list fills in. If your browser blocks the window, the whole page goes to GitHub instead and comes back with what you wrote. If you close the window early, nothing is connected.

Settings then says **Connected as** your login and lists the accounts the connection covers, each marked **Personal account** or **Organization**. The account menu shows **GitHub ✓ connected**.

- To choose which repositories the App may see, choose **Repositories** beside an account. It opens that installation's settings at GitHub.
- To add another account or organization, choose **Add an account**.
- To remove the connection from Windlass, choose **Disconnect**. The App stays installed at GitHub. Only the account's owner can uninstall it there.

> **Note** If you ask an organization to install the App, one of its owners has to approve the request at GitHub first. If this is your first installation, finish connecting after approval. If someone else installs the App for your organization, choose **Reconnect GitHub** in the repository picker to add it.

### What the GitHub App may do

Windlass uses your GitHub user token to identify you and list your installations during connect, then revokes it. It keeps neither the user token nor the refresh token.

With webhooks enabled, installing the App while connected adds the installation to your picker. An installation on your own GitHub account also appears there. **Reload** reads the repositories of installations already in your connection. If GitHub reports an uninstall, suspension, or repository removal, Windlass drops that installation from every affected connection. Reconnect to pick up any repositories you can still access.

The platform uses the App’s installation for repository operations. The App asks for these permissions:

| Permission | Access | Why |
| --- | --- | --- |
| Email addresses (account) | Read-only | Optional for deployments that use verified email for admission. |
| Contents | Read and write | Clone the repository, and push the agent's branch. |
| Pull requests | Read and write | Open and update the pull request. |
| Checks | Read and write | Read CI and publish the Factory verdict as `windlass/verified` on the pull request's head commit. |
| Commit statuses | Read-only | Read CI on a work item's pull request. |
| Actions | Read for CI, write for reruns and cross-repo runs | Read CI on the pushed commit, rerun eligible jobs and dispatch the combined test for a cross-repo feature. |
| Issues | Read and write | Read an issue filed as a work item, and comment on it. |
| Metadata | Read-only | GitHub adds it to every App. |

Agents you start yourself need Contents, Pull requests and Metadata to publish. With webhooks, Windlass can also receive and acknowledge feedback on their pull requests.

Contents write is the widest of these. It covers every repository the installation can see, and GitHub has no way to limit an App to some branches. So keep the App's reach small:

- At GitHub, set the installation's **Repository access** to **Only select repositories**, and pick the repositories you want agents on.
- Add a ruleset for each repository's default branch: block force pushes and deletions, and require a pull request before merging. Leave the App off the ruleset's bypass list. The platform pushes only `windlass/…` branches, so it keeps working, and it cannot write the default branch.

Each token the platform makes for a clone or a push covers one repository and lasts an hour at most. It is given only to that one git command, and it is revoked when the command ends. The agent's sandbox is never given your GitHub access.

The App does not ask for the Workflows permission. So GitHub refuses a push that changes a file under `.github/workflows`. Take such a change out, or make it yourself.

## Start your first agent

1. Go to **Agents**, the home page.
2. Type what the agent should do in **What should an agent do?**
3. Under the field, open **where** (it shows **Hosted** and the repository) and choose the repository. Leave the other choices as they are for now.
4. Press <kbd>Enter</kbd>, or choose **Launch**.

The platform creates the agent, makes its sandbox, clones the repository and sends your prompt. The agent's page opens and shows its work as it happens.

Next: [Start an agent](/docs/start-an-agent) explains every choice under the field.
