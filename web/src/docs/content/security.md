## The rule that holds everywhere

Your ChatGPT sign-in is never in a sandbox. The platform keeps it. For a Windlass turn using your ChatGPT plan, the sandbox gets a file for that turn. The file holds only a placeholder for the turn, and the access token stays in a [relay](#the-model-relay) where the agent cannot read it. A demo turn receives neither.

### The model relay

Where Windlass's model requests go through a relay, the sandbox never holds the access token at all. Every Windlass turn on your ChatGPT plan does, here and on your machines. Windlass gets the relay's address and a placeholder in its token file. The placeholder is good only for this turn's model requests through the relay. The relay checks it on every request and sends the request on to OpenAI with your real token. Commands, approved MCP servers and anything left running from setup can read only the placeholder.

- **Docker, here or on your machine.** The placeholder works only on the session's own `127.0.0.1:17893`. A helper in the session's network namespace takes it to the relay. Taken anywhere else, it is of no use. Here, the platform's relay asks for your plan's current token at every request.
- **E2B and Daytona.** The relay runs inside the microVM, as another user than the agent's: the agent cannot read its memory or what it was handed. Your plan's requests leave from the microVM's own address. The placeholder works only on that relay's loopback port, only while its turn runs, and only for the agent's own model requests. A fresh token is handed to the relay before the old one expires.

Hosted runs on your ChatGPT plan are enabled per account by the operator. Where they are not, a hosted Windlass turn on a ChatGPT model is refused with "Your ChatGPT plan isn't enabled for hosted runs on this account"; models of a Settings key and your machines still work.

When the turn ends, the relay forgets the token, stops the turn's requests still running, and the placeholder stops working. Anything in the sandbox can still make model requests on your plan through the relay while a turn runs, within the limits: 8 requests at once per session, with up to 32 more waiting, and 16 at once per hosted user. On a machine the relay allows 24 at once across sessions. These limits bound how many requests run at once, not how much of your plan they use.

If the relay cannot be started, the turn fails. The platform never falls back to putting the token in the sandbox. If the relay refuses a turn's placeholder (the turn ended, or the relay restarted), the turn fails with "send the prompt again". Your sign-in is untouched.

## Signing out on all devices

In **Settings**, choose **Sign out everywhere** to end all browser sign-ins for your account. Leave **Also revoke all API tokens** checked to disable every API token, including any created by someone with access to your browser sign-in. Clearing it keeps those tokens valid. Running agents and paired machines keep working. On the **Machines** page, review your pairings and [remove any unfamiliar machines](/docs/machines#remove-a-machine).

## Where sandboxes run

- **On this platform.** The platform makes and controls the sandbox. A platform runs its sandboxes on one provider: Docker, or E2B microVMs. The **where** menu lists the ones it offers, with the layers that isolate each.
- **On one of your machines.** The runner makes a Docker container there. The platform does not control the machine. See [On your machine](#on-your-machine).

## What every Docker sandbox gets

Every Docker sandbox, on the platform or on a machine, is a container with:

- a non-root user, `agent`;
- no Linux capabilities, and no way to gain privileges (`no-new-privileges`);
- a memory limit with no extra swap (1536 MiB on hosted Docker, sized by slot on a machine);
- a process limit (512 on hosted Docker, sized by slot on a machine);
- a CPU cap and a small CPU share;
- network access according to the platform or machine policy.

On a machine, the runner uses only the images pinned in its own build. The platform cannot name another image.

## The two Docker profiles

### Docker + Windlass sandbox

`docker-windlass-sandbox`. A container of its own, and every command the agent runs is sandboxed again by Windlass:

- commands have no network;
- they can write only in the workspace and in a home of the session's own;
- Windlass hides the session's access token from the agent's commands.

An approved local MCP server runs outside this command sandbox and can read the turn’s token file. With the model relay, that file holds a placeholder. Repository setup also runs outside it, but setup finishes and its processes are cleared before the turn receives a token.

So that Windlass's bubblewrap sandbox can work inside it, the container runs under a seccomp filter that is Docker's default plus the namespace and mount calls bubblewrap needs, without Docker's AppArmor profile, and with the system paths unmasked. The isolation of each command then comes from Windlass's sandbox. Its Windlass modes are **Ask** and **Auto**.

### Docker, hardened

`docker-hardened`. A container under Docker's default seccomp and AppArmor profiles. Commands run directly in it with the container’s network policy. In a Windlass session they can read the turn’s token file, which holds a placeholder when the model relay is in use. Its Windlass modes are **Ask** and **Full**. Claude Code and OpenCode run only in this profile.

| | Docker + Windlass sandbox | Docker, hardened |
| --- | --- | --- |
| Commands sandboxed again | Yes, by Windlass | No |
| Network for commands | No | Follows the container’s network policy |
| Commands can read the access token | No | Without the model relay, yes. With it, they read only a placeholder |
| Setup can read the token | No, setup ends before handoff | No, setup ends before handoff |
| Approved local MCP servers can read the token during the turn | Without the model relay, yes. With it, only the placeholder | Without the model relay, yes. With it, only the placeholder |
| Your ChatGPT sign-in in the container | Never | Never |
| Windlass modes | Ask, Auto | Ask, Full |
| Claude Code and OpenCode | No | Yes |

> **Note** A repository’s setup command uses the container’s network policy in both profiles.

## E2B sandboxes

On a platform that runs on E2B, each sandbox is a microVM of its own, hosted by E2B, where commands run as a non-root user. Which E2B sandboxes are offered depends on the platform, and each one's description says what it promises:

- **E2B + Windlass sandbox**: every command is sandboxed again by Windlass, so the agent's commands have no network and cannot read the access token.
- **E2B**: nothing is promised inside the microVM. A command may have network and may read the turn’s token file. Windlass asks before any command it cannot sandbox.
- **E2B, microVM only**: no sandbox inside the microVM. Commands run without asking, follow the microVM’s network policy and can read the turn’s token file.

E2B never lets a sandbox reach private or link-local addresses on its side, in any of them. The platform's operator can limit the microVMs' network further, for the whole platform. E2B enforces the limit outside the microVM, so nothing inside it can lift it, and it applies to everything there: the agent's commands, a setup command, MCP servers, and the platform's own clone, push and model calls.

| Network | What the microVM can reach |
| --- | --- |
| Open | Any public host. This is the default. |
| Restricted | Only the model API, GitHub, the bucket that keeps the agent's memory, the hosts the operator lists, such as the npm and PyPI registries, and the hosts the repository's network list allows (repository settings, **Network**). Other names do not resolve, and the timeline names each host a command could not reach. |
| None | Only the model API and that bucket. A session here cannot have a repository: "This deployment's hosted sandboxes have no network for repositories (WLP_E2B_NETWORK=none). Start the session without a repository, or on a machine of yours." |

The sandbox rows of the **where** menu and each E2B sandbox's description say which applies. Every host that is allowed is still a way out: in **Restricted**, a command could push to a repository on GitHub with a credential of its own. Address `169.254.169.254` answers in every mode: it is the microVM's own Firecracker metadata service, not a cloud provider's, and holds nothing of other sandboxes.

## On your machine

A machine offers the same two Docker profiles: **Hardened Docker on your machine** always, and **Docker + Windlass sandbox on your machine** only if you allow it with `--allow-profile docker-windlass-sandbox`.

Its network mode, set with `--egress`, decides what commands in the hardened profile can reach:

- `restricted`, the default for a new pairing: public sites through the runner's web proxy. Your private network, the machine itself, Docker's networks and metadata addresses are refused, except private hosts you name with `--egress-allow`.
- `open`: the internet and your local network, directly. Agents cannot reach each other.
- `none`: no network, and no repository.

See [Network access](/docs/machines#network-access) for the details.

### Agent logins stay on the machine

An agent's login is never inside its container. Claude Code's setup token and OpenCode's provider logins live in login volumes that no session mounts. A relay container on the machine reads them, and forwards each session's model requests to the provider. The session gets only a placeholder, signed for that one session, and the relay's address. Claude Code and OpenCode sessions keep their relay in every network mode. In `restricted` mode, an OpenCode session's commands cannot reach any model provider's host directly. See [Agent logins stay out of the container](/docs/machines#agent-logins-stay-out-of-the-container).

### What the platform can do there

The platform can ask the runner only for what its protocol names. In short, it can:

- create a sandbox, giving only the profile, the agent and whether it takes screenshots;
- connect to a sandbox, read its state, pause it and remove it;
- run commands in a sandbox, and start, signal and stop its processes;
- read and write text files in a sandbox, and write secret files there.

It cannot sign an agent in or out. That is done only in a terminal on the machine.

With those same requests it builds a repository's [prepared environment](/docs/settings#environment) on the machine: a sandbox where it clones the repository, runs the setup command and the saved checks, and keeps the image only when they pass. It does this only for repositories your sessions or work items ran there lately, never on a machine set to **When named** or **Never** under [Let features use it](/docs/machines#let-features-use-it), and within the machine's snapshot limits.

> **Careful** The platform can run any command in the containers the runner made, Claude Code's and OpenCode's included. In those containers, commands can use the session’s model relay and consume your quota. Older runners with the login volume mounted in the session also expose the Claude setup token.

### What the platform cannot do there

The runner cannot start a container of another image. It cannot run anything on the machine outside the containers it made. It cannot touch a container or a volume it did not make. It cannot reach a session that did not hand it a ticket.

The platform cannot reach your machine except through its runner. It does not control the machine: whoever runs the machine can change what runs there and what it reports. That is why a session on a machine says that its checks and changes are what the machine reports.

### How the runner proves who it is

The runner makes an Ed25519 key pair when it pairs. The private key stays on the machine. Every connection is signed with it. The platform signs its side too: the runner keeps the platform's key from pairing, prints its fingerprint, and checks every connection against it. A session's connection also needs a ticket that is good once and for one minute. If the machine's clock is more than a minute off, the platform tells the runner, and the Machines page warns you.

## Secrets

You can save secrets for a repository and for your account. A secret's value goes to the platform once and is never shown again. Values are stored encrypted.

A secret reaches the sandbox as an environment variable, never on a command line. Who gets it depends on what you choose for it:

| Secret | Default | With **Also the agent's commands** |
| --- | --- | --- |
| Repository secret | The setup command, and the MCP servers the repository names that read it as `${NAME}` | The agent's commands too |
| Account secret | MCP servers only: your own, and a repository's once you approve it | The agent's commands too |

- A repository's setup command never gets an account secret.
- Where a repository has a secret of the same name as an account secret, its agents get the repository's.
- In a sandbox that does not sandbox the agent's commands, such as **Docker, hardened**, secrets meant only for MCP servers are not passed at all. A server that needs one does not start there.
- On your machine, secrets go only while **Send saved secrets to this machine** is on.
- Claude Code and OpenCode sessions get no saved secrets.

> **Careful** Whatever the agent's commands can read, a manipulated agent could send out once a command has network access. Give a secret to the agent's commands only when it needs it.

### Values are taken out of what you see

The platform takes every saved value out of what it shows and keeps of an agent's work: the timeline, the output of commands and error messages. It shows `[secret:NAME]` instead. A value that a program changes before printing it, into base64 say, is not recognised.

Before a push, the platform also looks for saved values in the changes. If it finds one, nothing is pushed.

## GitHub access

The agent's sandbox is never given your GitHub access. For a clone or a push, the platform makes a token for that one repository that lasts an hour at most, hands it to that one git command, and revokes it when the command ends. See [What the GitHub App may do](/docs/getting-started#what-the-github-app-may-do).
