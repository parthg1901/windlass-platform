## Why use your own machine

An agent on one of your machines runs in a Docker container there, made by a small program called the runner. Its sandboxes take none of your daily sandbox time, no place among your kept sandboxes and none of the sandboxes running at once on this platform, work items included. You set its limits yourself. On a paired machine, Claude Code and Codex pay with your connected plan or a key saved in Settings, as **Connections → Pay with** says; OpenCode uses its logins on that machine or your Settings keys.

The runner connects out to the platform. Nothing needs to reach your machine from outside.

After a session ends, your runner can prepare a fresh sandbox for the same repository. This works with a session-private workspace and setup that needs no secrets. It clones the base and runs setup without credentials, or starts from the validated environment. It checks the base again when a new session arrives. The timeline says **Started from a ready sandbox** when it uses one. A spare belongs to your pairing, yields its slot to a turn, and expires after six hours. The runner replaces expired spares only while the repository’s recipe has been used in the past 24 hours. After two consecutive build failures it waits for another session with that recipe. After a restart a supported runner can ask the platform for a fresh recipe. A foreground session claims a matching spare first, even on a one-slot machine. An environment build waits if it would displace the spare. The runner keeps one by default when disk is above `--keep-free`. Set `--spares 0` to turn it off.

If you have no spare computer, you can [run agents on a cheap cloud VM](/docs/cheap-vm).

## What you need

- Linux with Docker, or macOS or Windows with Docker Desktop or OrbStack. On Windows, run the install in a WSL terminal. On a Mac or Windows, sessions run in Docker's Linux VM, with the arm64 or x86-64 images that match it.
- At least 5 GB of free disk for each new sandbox, inside Docker's VM where it has one.
- A clock set from the network. The platform warns you when the machine's clock is more than a minute off.

**Name the machine.** The runner names the machine after the host it sees. Under Docker Desktop that is Docker's VM, so every such machine is called `docker-desktop`. Give it a name of your own with `--name`, for example `--name "my-mac"`, in the setup command.

**Allow Windlass's command sandbox.** A new machine offers only **Hardened Docker on your machine**: the agent's commands run directly in the session's container, with the container's network. Setup allows it unless you choose otherwise at its **Profile** step; with the Docker commands, add `--allow-profile docker-windlass-sandbox` to also offer **Docker + Windlass sandbox on your machine**, which puts a second wall around each command: Windlass (or Codex, with its own sandbox) runs every command in a sandbox without network that cannot read the session's token file. To let that sandbox run, the session's container is started with AppArmor and system paths unconfined, and with user namespaces and mounts allowed; the command sandbox inside is the boundary. It is recommended for Windlass and Codex, which use it. Claude Code and OpenCode run only on the hardened profile. See [Allowed profiles](/docs/runner#allowed-profiles).

An account can connect up to 3 machines by default, or 10 on Pro where plans are offered.

## Where work runs

At the top of the Machines page, **Runs on** chooses your default place: **Hosted** or one of your machines. Work items and the agents you start use it unless a repository overrides it or you choose another for one item. For a machine, choose its **Isolation** and what happens **When it's offline**:

- **Wait for it**: the item waits until the machine is back.
- **Offer Hosted**: the item asks whether to wait or run on Hosted.

Where Hosted can be used, choose its size and isolation here too. The agent and model are in [Settings → Models](/docs/settings#where-each-choice-lives).

## Add a machine

Open the account menu and choose **Machines**, then **Add a machine**.

### Connect it with one command

The dialog shows one command first. Copy it and run it in a terminal on the computer. It needs Docker and Node:

```sh
npx @windlassai/cli connect --machine
```

It checks that Docker is installed and running, and says what to do if it is not. Then it fetches the runner image, pairs the machine and opens a page here to approve it. The page and your terminal show the same pairing code and **machine key**: check that they match, then choose **Approve**. Choose **Deny** if they differ or you did not run the command yourself; nothing is connected and the terminal stops. The dialog on the Machines page notices the new machine by itself.

After you approve, it starts the runner in the background with the defaults: every agent in the runner image offered, the recommended profiles (see [What you need](#what-you-need)), **Restricted** [network access](#network-access) and limits sized for the computer. The machine's agents use the plans and keys connected on **Connections**.

Last, it asks one question in the terminal: "Claude Code on this machine: use your Claude plan from Windlass (recommended), or keep a login on this machine only?" Press Enter for the plan. Choose the second to [keep Claude Code's own login on this machine](#claude-codes-own-login-on-this-machine) now. `--local-claude` chooses it without asking; without a terminal, the plan it is.

To change the settings later, run setup on the machine:

```sh
docker run -it --rm -v /var/run/docker.sock:/var/run/docker.sock \
  -v windlass-runner:/var/lib/windlass-runner <runner image> setup
```

### 1. Start the runner

Without Node, open **No Node?** in the dialog. It shows one line. Copy it and run it in a terminal on the computer:

```sh
curl -fsSL <platform address>/install.sh | sh
```

It checks that Docker is installed and running, and says what to do if it is not. Then it fetches the runner image and starts the runner's setup in your terminal, in a container that goes away when setup ends. It installs nothing else, needs no `sudo` and writes no file outside Docker. To read the script first, open its address in your browser, or choose **Read the script** in the dialog.

Setup asks one thing at a time. Use the arrow keys and Enter; Space ticks an agent. **←** goes back a step (Shift+Tab in a text field), and Escape cancels.

1. **Welcome.** It shows the platform's address. Check that it is yours.
2. **Pair.** It shows the code, the address to enter it at and the **machine key**. Enter the code as in [step 2](#2-enter-the-code) and check the key as in [step 3](#3-connect-it). Setup waits until you choose **Connect**. A code lasts ten minutes; if it runs out, setup offers a new one.
3. **Machine name.** It suggests the name Docker gives the computer. Docker Desktop calls every computer `docker-desktop`, so give it a name you will know it by. See [Name it](#name-it).
4. **Agents.** Tick the agents the machine should offer. Windlass is always offered. Claude Code and Codex need no sign-in on the machine: they pay with your plan or key. For OpenCode, setup offers to [sign it in](#sign-opencode-in) now. If that fails or you skip it, setup says so and carries on: sign it in later.
5. **Profile.** Whether agents may also use **Docker + Windlass sandbox** besides hardened Docker. Setup recommends it and has it chosen, and says what it loosens. See [Allowed profiles](/docs/runner#allowed-profiles).
6. **Network.** **Restricted**, the recommended mode, **Only some public hosts**, or **Open**. See [Network access](#network-access).
7. **Limits.** The turn slots, the disk for setup snapshots and the free disk to keep, with defaults sized for the computer. See [Run options](/docs/runner#run-options).
8. **Summary.** Everything you chose, and the command setup is about to run.
9. **Start.** Setup starts the runner in the background, in the `windlass-runner` container, and waits until it says **Online**. If a `windlass-runner` container is already there, setup asks before it replaces it. The volume stays, so the machine stays paired.

The runner keeps its key and its state in the `windlass-runner` volume. Keep that volume: it is what keeps the machine paired. Setup keeps your answers there too.

#### Run setup again

Run the line again to change something. Setup shows your answers as the defaults, and offers to keep the pairing. You can also run one part of it, in the setup container:

```sh
docker run -it --rm -v /var/run/docker.sock:/var/run/docker.sock \
  -v windlass-runner:/var/lib/windlass-runner <runner image> setup network
```

The parts are `name`, `agents`, `opencode`, `profile`, `network` and `limits`. `setup --quick` asks only what is missing, such as OpenCode not being signed in. Each ends by offering to replace the running runner with the new settings.

#### Other ways

Under **Other ways** the dialog has the Docker commands themselves. Use them where you cannot run the script, in PowerShell for example, or to choose the options yourself.

**Set it up with Docker** is the setup command. With no agent ticked it opens the same setup as the one-line install. Tick **Enable Claude Code**, **Enable Codex** or **Enable OpenCode** for the agents the machine should offer, and setup asks in the terminal line by line instead. With Claude Code and OpenCode ticked, and the sandbox allowed, it reads:

```sh
docker run -it --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v windlass-runner:/var/lib/windlass-runner \
  <runner image> setup --platform <platform address> --harness claude --harness opencode \
  --allow-profile docker-windlass-sandbox
```

It pairs the machine, asking in the terminal as it goes. First it prints the pairing code: enter it as in steps 2 and 3. Then, with OpenCode ticked, it asks to [sign OpenCode in](#sign-opencode-in). Last, it prints `Start the runner on this machine:` and the command that starts the runner in the background, with the same options. Run that command.

A box is shown only for an agent the platform's runner image includes. **Allow Windlass's command sandbox** is ticked unless you untick it: both commands then end with `--allow-profile docker-windlass-sandbox` (see [What you need](#what-you-need)). Unticked, they end with `--allow-profile docker-hardened`, and setup starts with the sandbox turned off at its **Profile** step. Add `--name` and a name of your own to the setup command on a Mac or Windows PC.

**Or start the runner in the background** starts the runner at once, and you read the pairing code from its log:

```sh
docker run -d --name windlass-runner --restart unless-stopped \
  --log-driver json-file --log-opt max-size=16m --log-opt max-file=3 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v windlass-runner:/var/lib/windlass-runner \
  <runner image> --platform <platform address>
```

Setup pairs the machine again unless you keep the pairing. To pair again it stops a running runner first, and starts it again if you cancel. The line-by-line setup refuses while the runner is running with the same volume: "The runner is already using this state. Use login <agent> in the running runner." To sign an agent in on a running machine, use `login`.

> **Tip** Where rootless Docker works, use it: the runner then gets less of your machine. Mount `$XDG_RUNTIME_DIR/docker.sock` in place of `/var/run/docker.sock`.

### 2. Enter the code

When it starts, the runner prints a pairing code like `XXXX-XXXX`, and the address to enter it at. Setup shows it in your terminal. The background runner prints it in its log:

```sh
docker logs windlass-runner
```

Under **No Node?** in the dialog, choose **Enter the code**, type the code and choose **Check code**. Case, spaces and dashes do not matter. A code lasts ten minutes. It belongs to the first account that enters it.

### 3. Connect it

The page shows the **machine key**, a short fingerprint of the machine's key like `K7Q2M-XR4TD`. The runner prints the same one under the code: `Machine key: K7Q2M-XR4TD`. Check that they match, then tick **The runner's terminal shows the same machine key**. If they differ, or someone gave you the code to enter, choose **Back**: the code is of their machine, and connecting it would send your agents' work there. A runner older than 0.3.2 prints no machine key. The page then asks you to tick that you started the runner yourself in the last few minutes instead.

The page also shows what the machine says about itself: its name, OS, architecture and runner version. Nobody has checked these. Connect it only if it is the machine you started the runner on. Then choose **Connect**.

The runner then prints the platform's key fingerprint, and whose account it joined: `Paired with <your GitHub login>`. If that is not you, run `windlass-runner pair` again.

A new runner pairs only with a platform that signs its runner connections. If the platform does not, the runner says "This runner needs signed runner connections enabled on the platform. Ask the operator to enable them, then pair again." Ask whoever runs the platform.

### Name it

The machine is named after its Docker daemon, or its hostname if Docker gives none. To choose the name yourself, add `--name` after the runner image, with `setup`, `run` or `pair`:

```sh
<runner image> --platform <platform address> --name "Build box"
```

A name has 1 to 64 printable characters. The runner saves it and uses it again when it restarts without `--name`.

> **Note** If the code expired, the runner says so. Restart the container, or run `windlass-runner pair`, to get a new code. Setup offers a new code itself; the line-by-line setup asks you to run it again.

## What the machine receives

A machine runs the agents you start on it. It receives what they need, and nothing once it is removed:

- your repository's files;
- the saved secrets each agent is allowed, while **Send saved secrets to this machine** is on;
- a plan's token for each turn a plan pays for: a Claude plan's, or a ChatGPT access token, which lasts about an hour. It goes to a relay on the machine for that turn and never into the agent's container or onto the disk. See [Plans on your machine](#plans-on-your-machine).

The platform does not control this machine. What a session there shows of checks and changes is what the machine reports. See [Sandboxes and security](/docs/security#on-your-machine) for what the platform can and cannot do there.

### Saved secrets

Each machine has the switch **Send saved secrets to this machine**. It is on for a new machine. When it is on, each turn of an agent there gets the saved secrets it is allowed, the repository's and the account's. Turned off, none are sent, and whatever needs one fails on this machine. A change holds from each agent's next turn.

## Run agents on it

When you start an agent, choose the machine under **on**. Each machine offers two Docker profiles:

- **Hardened Docker on your machine "…"**, always.
- **Docker + Windlass sandbox on your machine "…"**, only if you allow it when you start the runner, and only where Windlass's sandbox can start in a container there. See [Allowed profiles](/docs/runner#allowed-profiles).

### Turn limit and queueing

The runner sizes its slots from the machine’s CPU and memory. A personal turn takes one slot by default. A large factory turn can take up to four. Turns wait in arrival order, so a large turn at the head waits for enough free slots before a smaller turn can start. **Stop** takes a turn out of the queue. Set the capacity with `--slots` or `--max-turns`. The platform sets no limit of its own on how many turns run on your machines: the runner's slots are the limit. See [Runner reference](/docs/runner#run-options).

### When the platform restarts

On a deployment that turns it on, a Windlass turn running on your machine can outlive a restart of the platform's server. The runner keeps the agent running and holds its output for up to ten minutes. When a server is back within that time, the same agent carries on, and its output appears in the timeline once, with nothing lost. You see a short gap while the server is away. Past ten minutes, or if the runner itself restarted, the turn is paused and resumes from the agent's saved session (see [When the server restarts or the machine goes away](/docs/sessions#when-the-server-restarts-or-the-machine-goes-away)). Claude Code, Codex and OpenCode turns are paused and resumed in the same way, through their own session resume.

### When the machine goes away

Where turn resumption is enabled, a turn pauses if the machine shuts down or goes to sleep. It waits for the machine for as long as it takes, and resumes by itself when the runner connects again. The time offline does not count toward the turn's limit.

### CPU and memory

By default, the runner fits up to 16 slots of 2 CPUs and 4–8 GiB each after reserving resources for the host. If none fits, one slot shares all cores with the host and uses up to 4 GiB, leaving at least 1 GiB or 25% of memory for the host, whichever is greater. **Details → Capacity** shows the slot count and the CPU and memory per slot. Use `--slot-cpus`, `--slot-memory` and `--sandbox-memory` to set the CPU per slot, memory per slot and total sandbox memory budget. A slot's memory limits what an agent's commands can use at once, as a hosted size does: a large build or test suite can run a 1.5 GiB slot out of memory. When the kernel kills a program because the slot ran out of memory, the turn’s timeline shows the slot limit and an unfinished work item asks you how to continue. The machine’s owner can raise `--slot-memory` or configure fewer slots to share the memory budget.

## Network access

Each machine has one network mode for its agents' commands. You choose it when you start the runner, with `--egress`:

| Mode | What commands can reach |
| --- | --- |
| `restricted` | Public sites, through a web proxy the runner keeps beside each sandbox. Not your local network, the machine itself, Docker's networks or cloud metadata addresses. This is the default for a new pairing. |
| `open` | The internet and your local network, directly. Agents on the machine still cannot reach each other. |
| `none` | No network at all. An agent here cannot have a repository. |

The runner saves the mode for this pairing, and uses it again when it restarts without `--egress`. It prints the mode when it starts, and `status` prints it too, for example "Network egress is restricted."

### Restricted

In `restricted` mode the sandbox has no network of its own. The runner sets `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` in it, and a web proxy on the machine connects for it:

- Programs that use those settings get out, to any port. Programs that ignore them have no network.
- The runner resolves names itself, on the machine, and checks the address before it connects.
- Your private network (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` and `fc00::/7`) is refused, unless you allow a name with `--egress-allow`.
- The machine's own addresses, every Docker network on it, `169.254.0.0/16` and other special ranges are always refused.

A refused request gets `403 Forbidden`. For a plain `http:` request, the answer also says "blocked by runner egress policy".

To let commands reach a host on your private network, name it:

```sh
<runner image> --platform <platform address> --egress restricted --egress-allow git.internal.example,registry.internal.example
```

Give exact DNS names, up to 64, separated by commas. IP addresses are refused. A listed name is still refused if it resolves to the machine itself, a Docker network or a metadata address. `--egress-allow` alone means `restricted`. `--egress restricted` without `--egress-allow` empties the list.

### Only some public hosts

By default `restricted` lets commands reach any public host. To let them reach only the hosts you name, give `--egress-domains`:

```sh
<runner image> --platform <platform address> --egress restricted --egress-domains @npm,@pypi,@github,mirror.example.com
```

Each entry is an exact DNS name, `*.` and a name for any of its subdomains (`*.example.com` takes `cdn.example.com`, not `example.com`), or a preset. The presets are the same as a hosted deployment's `WLP_E2B_NETWORK_ALLOW`, so one list can be used in both places:

| Preset | Hosts |
| --- | --- |
| `@npm` | `registry.npmjs.org`, `registry.yarnpkg.com` |
| `@pypi` | `pypi.org`, `files.pythonhosted.org` |
| `@github` | `github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`, `release-assets.githubusercontent.com` |
| `@crates` | `crates.io`, `index.crates.io`, `static.crates.io` |
| `@go` | `proxy.golang.org`, `sum.golang.org` |

A wildcard reaches every site under its name, whoever runs it. On a shared hosting domain that means any customer's site, an attacker's among them: `*.s3.amazonaws.com` would let a command upload to anyone's bucket. So a wildcard on a public suffix is refused: a name under which different owners' sites live, as the [Public Suffix List](https://publicsuffix.org/) records them (a copy of its version of 21 November 2026 is built into the runner), or a name with one under it. `*.co.uk`, `*.github.io`, `*.amazonaws.com`, `*.workers.dev`, `*.vercel.app`, `*.appspot.com` and `*.blob.core.windows.net` are refused: "--egress-domains: *.github.io is refused. github.io is a public suffix (publicsuffix.org): different owners' sites live under it, so the wildcard would let commands reach anyone's site there. Name the exact hosts instead." `*.githubusercontent.com` is refused too: every GitHub user's files, gists and uploads are served under it, so it would reach anyone's content there, not only GitHub's own. `@github` names its exact hosts instead. A hosting domain that is not on the list is not refused, so check what a wildcard covers before you give it.

Two hosts are always in the list, because the platform's own steps use the same proxy: the platform's git host, for its clone, fetch and push, and `api.openai.com`, for Windlass's model requests. The git host is the one the platform names when the runner connects (its `WLP_GITHUB_URL`, `github.com` unless it uses GitHub Enterprise). A platform older than this runner names none, and the runner uses `github.com`; with such a platform and another git host, add that host to `--egress-domains` yourself. Commands can reach these two hosts too, except `api.openai.com` in Codex and OpenCode sessions, whose proxy refuses the model hosts to commands. The whole list, these two included, holds up to 64 hosts. IP addresses and ports are refused.

The list limits which services commands can reach. It does not stop a command from sending data out through one of them. `github.com` and `api.openai.com` take uploads to any account a command has a token for: a command can push your repository's contents to a repository of its own on GitHub, or send them in a request to OpenAI with its own key. So can any listed host that stores what it is sent, such as a package registry a command can publish to.

With a list, the proxy:

- refuses an unlisted name before any DNS lookup. With exact names only, a command cannot send data out in the names it looks up. A `*.name` entry lets any name under it be looked up, `<data>.example.com` included, so whoever runs `example.com`'s DNS can read what a command puts in those names;
- refuses a name under a wildcard that is not a valid DNS name (an empty label, a label over 63 characters or with characters a name cannot have) before any lookup;
- refuses IP addresses;
- connects HTTPS only to port 443 and plain `http:` only to port 80;
- reads the start of each HTTPS connection and sends it on only if the TLS server name is the host the command asked for. A connection without a server name, with another one, or with Encrypted Client Hello is closed;
- still refuses your private network (unless the name is also in `--egress-allow`), the machine itself, Docker's networks and metadata addresses, even for a listed name;
- lets an `--egress-allow` name that is not in the list reach only your private network. If it answers with a public address, the connection is refused.

A browser must turn Encrypted Client Hello off to reach listed hosts over HTTPS, since the proxy cannot see which site such a connection is for. Chrome and Firefox send it on every connection, even with no key for the site. In Firefox, set `network.dns.echconfig.enabled` to `false` and `security.tls.ech.grease_probability` to `0`. Chrome has no command-line switch for it any more, only the full browser's `EncryptedClientHelloEnabled` policy, and the sandbox's browser has neither (`wlp-headless-shell`, Chrome's headless shell, which `wlp-shot` uses): with a list, it can load pages from `127.0.0.1` but no listed HTTPS host. Without `--egress-domains` the proxy does not read the connection, and browsers work as they do elsewhere.

The list narrows what commands can reach; it does not seal it. A listed host behind a shared CDN can be asked, inside its encrypted connection, for another site on the same CDN.

The runner saves the list with the mode and prints it, expanded, when it starts and in `status`: "Network egress is restricted. Only these public hosts: api.openai.com (always: Windlass's model requests use it; refused to commands in Codex and OpenCode sessions), github.com (always until the platform names its git host: the platform's git uses it), registry.npmjs.org, …". When the runner connects to a platform whose git host is another, it says so: "The platform's git host is git.example.com: the list of public hosts has it in place of github.com." `--egress-domains` alone means `restricted`. `--egress` or `--egress-allow` without `--egress-domains` takes the list away, and the runner says so: "The --egress-domains list was removed: commands can reach any public host again. Give --egress-domains with the other --egress flags to keep a list." The platform learns only how many hosts the list has, not which.

### None

In `none` mode commands have no network. A repository cannot be cloned there, so an agent on a repository is refused: "This machine uses --egress none. Start the session without a repository or restart the runner with --egress restricted." Start it with **No repository**, or change the mode.

### Pairings made before network modes

A machine paired before network modes existed stays `open` until you give `--egress`. Its runner says so when it starts: "Network egress is open for this existing pairing. Start the runner with --egress restricted to opt in."

### Changing the mode

The new mode applies to sandboxes the runner makes from then on. A kept sandbox made under another mode is paused, and using it again is refused: "This kept sandbox has a different network policy. Save its workspace and recreate the sandbox to use the runner’s current --egress setting." Take what you need from it, delete the agent and start a new one.

### What the session shows

When you choose **Hardened Docker on your machine "…"**, the sandbox rows of the **where** menu and the session's **Sandbox** panel say what its commands can reach:

| Mode | The network fact |
| --- | --- |
| `restricted` | "commands can reach public sites and hosts allowed by the owner through the web proxy" |
| `restricted` with `--egress-domains` | "commands can reach only the 9 public hosts the owner allows, through the web proxy", with the list's size |
| `open` | "commands can reach the internet and the local network" |
| `none` | "commands have no network" |

In **Docker + Windlass sandbox on your machine "…"**, commands have no network whatever the mode. A repository's setup command uses the machine's mode in both profiles.

## Say when to use it

You can tell the planner of an orchestrated work item what each machine is for. On the Machines page, choose **Add** beside "No note on when to use it.", or **Edit** once there is one. Fill in:

- **When to use it**: a note of up to 500 characters, for example "Builds and browser tests; it has the GPU".
- **Tags**: up to 12, with a comma or a space between them, for example `gpu, big-build`. A tag has letters, digits, `-` and `_`, starts with a letter or digit, and is up to 24 characters long. `os`, `arch` and `screenshots` come from the runner, so you cannot set them.

Choose **Save**. The planner reads this, with the machine's OS, capacity and what it can run, when it splits a feature into subtasks. Nothing else reads it. See [Orchestrate](/docs/factory#orchestrate-a-feature).

### Let features use it

Under **Details**, **Subtasks of features** says whether a feature's subtasks may run on the machine:

- **Any feature** (the default): features may place subtasks here.
- **When named**: only when a plan names this machine for the subtask.
- **Never**: features never place subtasks here.

A machine on **When named** or **Never** also builds no [prepared environment](/docs/settings#environment) of a repository.

The choice is saved at once. A machine that is not on **Any feature** says so on its card, for example "features: when named". A subtask that only inherits the feature's place counts as not named, so a feature filed on a **When named** machine must name it in each subtask. A plan that needs a **Never** machine cannot be approved: the plan says why under the subtask. See [Placement](/docs/factory#placement).

## Agents on your machine

On a machine of yours you can run three more agents, each with your own account:

- **Claude Code** uses your connected Claude plan or your Anthropic Settings key, as **Connections → Pay with** says, or [its own login kept on this machine](#claude-codes-own-login-on-this-machine).
- **OpenCode** uses the providers signed in on the machine, and your Settings keys for OpenAI, Anthropic, Google and OpenRouter where it has no login of its own.
- **Codex** uses your connected ChatGPT plan or your OpenAI Settings key, as **Connections → Pay with** says.

A plan pays from your machine: at each turn's start the platform hands the plan's token to a relay on the machine for that turn only. The relay keeps it in memory, never on disk, and sends the agent's requests to Anthropic or OpenAI from your machine. See [Plans on your machine](#plans-on-your-machine). Claude Code and Codex need no sign-in on the machine.

The runner must be 0.3.13 or later. An older one cannot connect: the Machines page says "Update your runner to 0.3.13 or later" with the command to do it.

An agent runs only on a machine whose runner was started with its flag: `--harness claude`, `--harness opencode` or `--harness codex`. Repeat `--harness` to offer more than one. The **Enable** boxes of the setup command add these flags, and the command setup prints keeps them. The runner must be a build that includes that agent's image. If it does not, it says "Use --harness claude with a runner built with the pinned Claude Code image.", "Use --harness opencode with a runner built with the pinned OpenCode image." or "Use --harness codex with a runner built with the pinned Codex image."

The runner does not save `--harness`. Give it each time you start the runner, or the agent is no longer offered.

Claude Code and OpenCode run only in the hardened profile, **Hardened Docker on your machine "…"**. Either can run a Quick item or an approved Plan-first subtask on this machine, without asking (see [Choose the agent](/docs/factory#choose-the-agent)).

Codex runs in both profiles, with different modes:

- **Hardened Docker: Container access.** Commands run as `agent` in the session's container, under the machine's egress setting, and Codex asks for nothing. The container is the boundary.
- **Windlass sandbox: Read-only or Workspace access (the default).** Every command runs in Codex's own sandbox, without network. Workspace access can change files in the workspace. Codex is offered here only once the runner has checked that its sandbox works on this machine. A request to go outside the sandbox is refused, even if you would allow it. The timeline then notes "Codex asked to run a command outside its sandbox; refused on this profile." or "Codex asked to edit files outside its sandbox; refused on this profile."

On either profile Codex ignores a repository's own Codex settings (`.codex/`), and a repository's setup command cannot change Codex's settings. Codex builds Quick work items, on either profile: see [Codex items](/docs/factory#codex-items).

None of these agents has a tool to publish: open the pull request from the session panel. None gets your saved secrets.

## What pays on your machine

Claude Code and Codex follow **Connections → Pay with**, as hosted agents do. With a key, the machine receives a temporary relay credential: the saved key stays on the platform, and the provider bills the key owner. Claude Code and Codex work items count API-key tokens toward their budget. Plan turns show token usage separately. The Machines page says what pays for each agent and links to its cell on **Connections**. Where neither a plan nor a key is connected, it says "no plan or key connected": connect one on **Connections**.

### Claude Code's own login on this machine

Instead of your plan from Windlass, Claude Code on one machine can use a Claude login kept on that machine only. It never leaves the machine: Windlass never receives it. On **Connections**, the machine's Claude Code cell offers two ways: **Your Claude plan, from Windlass** (the default) and **This machine's own login — it never leaves this machine**. Choose the second, then run the command it shows in a terminal on that machine, once it is paired:

```sh
npx @windlassai/cli connect claude --this-machine
```

It runs `claude setup-token` there. Sign in to Claude, and the command hands the token straight to the machine's runner, which keeps it in its Claude login volume. Nothing goes to Windlass: the runner reports that it has a login, and the cell turns to **This machine's own login · stays on this machine** by itself. Without a runner on the computer, the command says "Pair this machine first: npx @windlassai/cli connect --machine".

While the login is kept, it pays for Claude Code on that machine, whatever **Pay with** says. Your plan and keys on Windlass still pay for Claude Code on Hosted and on your other machines. If nothing on Windlass pays for Claude Code, the Hosted cell says "Hosted Claude Code needs your plan or a key on Windlass."

**Switch back to your plan** in the cell removes the login from the machine; its runner must be online. Claude Code there then pays through **Pay with** again. On the machine itself, `docker exec windlass-runner windlass-runner logout claude` does the same.

## Sign OpenCode in

OpenCode keeps its own logins on the machine. A key in **Settings → Model providers** serves the providers it is not signed in to. The Machines page shows **signed in**, **sign in needed** or **couldn't check the sign-in**, with the runner's reason when it gives one. The last is the runner's check failing, not a sign-out: turns still run if OpenCode is signed in, and the runner checks again after 10 s, 30 s and 60 s, then every minute. Beside it is the command that signs it in, with a copy button:

```sh
docker exec -it windlass-runner windlass-runner login opencode
```

The machine must be paired first, or the runner says "Pair this machine before signing in to OpenCode." When it is done, it says "OpenCode: signed in.", and the Machines page shows the new state.

[Setup](#1-start-the-runner) offers to sign OpenCode in as it goes: **Sign in now** or **Skip for now**. A failed sign-in is shown, and setup carries on. Sign it in later with `login opencode` or `setup opencode`.

### OpenCode

`login opencode` asks which model provider to use:

```text
  opencode-go — OpenCode Go (Go-specific key)
  opencode — OpenCode Zen
  chatgpt — ChatGPT device login
  openai — OpenAI
  anthropic — Anthropic
  openrouter — OpenRouter
  google — Google
  zai-coding-plan — Z.AI Coding Plan
  free — OpenCode public models
OpenCode provider (id or search, Enter for chatgpt):
```

Type an ID from the list, or a word to search all the providers the runner can route, such as `router` or `zhipu`. Press <kbd>Enter</kbd> alone for `chatgpt`. For GLM models, choose Z.AI (`zai` or `zai-coding-plan`) or Zhipu AI (`zhipuai` or `zhipuai-coding-plan`).

| Provider | What you need |
| --- | --- |
| `opencode-go` | The API key of your OpenCode Go subscription. |
| `opencode` | An OpenCode Zen API key. |
| `chatgpt` | Your ChatGPT account. OpenCode's own device sign-in runs in the terminal. |
| `openrouter`, `anthropic`, `openai`, `google`, `zai-coding-plan` and others | That provider's API key. |
| `free` | Nothing. OpenCode's free public models. |

For a key, the runner asks "Enter the … API key: ", without showing what you type. The ChatGPT sign-in runs in a temporary container that keeps its files in memory, and the runner removes that container when the sign-in ends. It needs a terminal: use `docker exec -it`.

To skip the list, name the provider:

```sh
docker exec -it windlass-runner windlass-runner login opencode --provider opencode-go
```

Run `login opencode` again to add another provider. Each provider keeps its own login, with two exceptions: `chatgpt` and `openai` replace each other, and so do `free` and `opencode`.

Once OpenCode is signed in, the runner reports the models of its providers, and the **agent** menu lists them under **OpenCode**. See [The model](/docs/start-an-agent#the-model).

> **Note** OpenCode's free public models have a small allowance, which OpenCode counts by your machine's public IP address. Everyone behind that address shares it. When it runs out, the turn says "The provider's usage or rate limit was reached." Wait, or sign in with a provider of your own.

### Import your OpenCode keys

If OpenCode already runs on the machine with API keys, setup can take them over. In **Add a machine**, tick **Enable OpenCode**, then **Import existing OpenCode API keys during setup**. The setup command then mounts OpenCode's data folder, read-only:

```sh
--mount "type=bind,src=$HOME/.local/share/opencode,dst=/import/opencode,readonly"
```

If you set your own `XDG_DATA_HOME`, put your OpenCode folder in place of `$HOME/.local/share/opencode`. The folder must exist: the mount fails without it.

When you answer yes to "OpenCode: sign in now?", setup reads OpenCode's `auth.json` once, and asks about each entry:

- an API key it can use: "… (…) API key: import? [Y/n] ";
- a subscription login that renews itself, which it does not copy: "… login can't be shared safely; sign in separately for the runner? [Y/n] ". Yes starts a sign-in of the runner's own: the ChatGPT device sign-in for `openai`, or that provider's API key prompt;
- a provider it has no route for: "Skipping …: no fixed inference route in this runner."

If it took nothing, setup asks for a provider as `login opencode` does. The command setup prints at the end does not mount the folder.

### Sign out

```sh
docker exec windlass-runner windlass-runner logout opencode
```

`logout opencode` signs OpenCode out for this pairing and every earlier one, and removes all of its providers at once.

## Plans on your machine

Connect a plan once with `npx @windlassai/cli connect claude` or `npx @windlassai/cli connect codex`, and every machine of yours can use it. For each turn the plan pays for, the runner starts a relay container on the machine, `wlp-plan-relay-<sandbox>`. The platform hands it the plan's token at the turn's start, and a fresh one before a ChatGPT token expires. The token stays in the relay's memory: it is never written to the machine's disk, a volume or the agent's container. The agent gets the relay's address, `http://127.0.0.1:17893`, and a placeholder that works only for that turn. When the turn ends, the relay and its token are gone.

- **Windlass** pays for its ChatGPT models with your ChatGPT plan.
- **Claude Code and Codex** follow **Connections → Pay with**, as hosted agents do: the plan, your key, or the plan and then your key, and what to do when the plan reaches its limit.

## The Windlass model relay

For a Windlass turn on a Settings key, the runner keeps a model relay on the machine, `wlp-model-relay-<machine id>`. Windlass in the container gets the relay's address, `http://127.0.0.1:17893/v1`, and a placeholder. A helper in the session's network namespace forwards that address to the relay, which forwards the request to the platform; the platform checks the turn's lease and adds the key. The key never reaches the machine. The relay has the same limits as the other relays on the machine: 8 requests at once per turn, with up to 32 more waiting, and 24 at once on the machine. It works in every network mode, `none` included. If it can't be started, the turn fails with "the model relay could not be started".

## Agent logins stay out of the container

The runner keeps OpenCode's machine logins in a private volume. Only OpenCode's relay can read it. Keys saved in Settings stay on the platform, and a plan's token stays in its turn's relay.

Each turn receives the local relay’s address and a placeholder. For a Settings key, the machine relay forwards model requests to the platform, which checks the turn’s lease and adds the saved key. For an OpenCode login, the relay checks the session’s signed placeholder and sends the request directly to the provider. It also renews an OpenCode ChatGPT login when it expires.

When the relay refuses a request, or the provider answers with an error, the agent gets one of these fixed messages. The relay does not pass the provider's own reason on.

| Message | What it means |
| --- | --- |
| "Provider sign-in is missing or the session placeholder is no longer valid." | The machine has no login for this provider, the provider did not accept the login, or the session's placeholder no longer matches. |
| "This request is not allowed by the relay." | It was not a model request the relay takes, or the provider refused it as not allowed. |
| "The provider's usage or rate limit was reached." | The provider answered that a usage or rate limit was reached. |
| "The provider failed or couldn't be reached." | The provider failed, or the relay could not reach it. |
| "The provider rejected the request." | The provider refused it for another reason. |
| "Too many model requests at once from this session (8)." | The session had 8 model requests in flight, and none finished while this one waited 90 seconds. |
| "Too many model requests at once on this machine (24)." | The machine's sessions had 24 requests in flight through this relay, and none finished while this one waited 90 seconds. |
| "Too many model requests waiting from this session (32)." | 32 of the session's requests were already waiting at the relay. |
| "Too many model requests waiting on this machine (128)." | 128 requests were already waiting at this relay. |
| "Too many connections to the model relay from this session (32)." | The session already has 32 connections open to the relay. |

The relay passes on the provider's rate-limit headers, and nothing else from its reply headers: `retry-after`, `anthropic-ratelimit-*`, `x-ratelimit-*` and Codex's `x-codex-*` usage and credit headers. It passes them on a successful reply and on a usage-limit (429) or overload (503, 529) refusal. The agent reads them as it would without a relay, so the platform sees the same "limited until" times. The relay never passes on cookies, request IDs, redirects or account names, and drops any header value over 64 characters, with a character other than letters, digits, spaces and `. , : _ + -`, or containing the login.

## Limits on model requests

Each agent’s relay limits concurrent requests across its sessions. A session can have at most 8 model requests in flight and 32 connections open to the relay. All sessions on the machine together can have at most 24 requests in flight through one agent's relay. Claude Code, Codex and OpenCode each have their own relay and their own 24.

A request over a limit waits at the relay for up to 90 seconds, in the order it came, and goes on to the provider as soon as one of the requests ahead of it finishes. A waiting request costs nothing at the provider, and one that its agent gives up on leaves the line. A session at its own limit does not hold up other sessions waiting for the machine's. If no slot frees in 90 seconds, or 32 of the session's requests (128 on the machine) are already waiting, the agent gets a 503 with `retry-after: 2`, a busy error it retries a limited number of times: Claude Code up to 10 times over about 3 minutes, Codex for about a minute. Then the turn ends with that error. A connection past the session's 32 is answered with the same kind of 503 and closed, and a connection that sends no request within 10 seconds is closed. The refusal is not a 429: Claude Code does not retry a 429 on a subscription login and would take it as your usage limit being reached. Normal work, including a few subagents at once, stays well under the limits. A runaway command that fires hundreds of requests in parallel gets most of them refused instead of spending your subscription.

So commands in a session cannot read your login. They can still use that session's relay and consume your subscription or your providers' quota, within these limits, in every network mode, `none` included.

In `restricted` mode, commands in an OpenCode session also cannot reach any model provider's host, or any bare IP address, through the proxy. `--egress-allow` does not reopen them. Model requests go only through the relay.

In `restricted` mode, commands in a Codex session cannot reach `api.openai.com`, `auth.openai.com` or `chatgpt.com` through the proxy. This blocks OpenAI only by hostname. It is a policy, not a security boundary: a command can still reach OpenAI by another route. Your plan and key are safe regardless, because a Codex session holds only a placeholder for its relay, never the token or key itself.

OpenCode checks which providers are available at the start of each turn. Adding, changing or removing a Settings key takes effect in existing sessions. Logging out on the machine revokes that login’s placeholders.

## Machine details and warnings

Each machine on the page shows its state: **Online**, **Offline since** a time, **Waiting for the runner**, or **Needs an update**. Choose **Details** to see:

- **Sandboxes**: the agents' sandboxes on it;
- **Commands sandboxed by Windlass**: whether Windlass's own sandbox can start there, and why not;
- **Capacity**: the turns running and queued, the CPUs given to sandboxes and the memory free;
- **Free disk**;
- **Sandbox limit**: the limits set on the machine with `--max-running` and `--max-sandboxes`;
- the switch **Send saved secrets to this machine**.

The page also warns you when:

- the runner cannot reach Docker on the machine;
- the machine's clock is too far off. Set the clock from the network, for example with `timedatectl set-ntp true`;
- the machine's key was used from two places. If you did not copy it, remove the machine.

## Update the runner

When the platform needs a newer runner, the machine shows **Needs an update**. Remove the container and run the same command again:

```sh
docker rm -f windlass-runner
```

Then run the command from the Machines page, with the same options as before, `--harness` included. The volume keeps the key, so the machine stays paired. If you set it up with the one-line install, run that line again instead: it fetches the new runner, keeps your answers and the pairing, and replaces the container. If the Machines page says to pair again, run `windlass-runner pair` after the update, so the runner gets the platform's key.

## Remove a machine

Choose **Remove…** on the machine, then **Remove machine**. Its key stops working at once.

- An agent on it keeps its conversation, but cannot run again.
- Its files stay on the machine, unless you also tick **Also remove the agents' sandboxes on it**. The runner then removes them now, or when it is next online.

To add the machine again later, run `windlass-runner pair` on it.

A machine that the platform has not heard from for 90 days is removed by itself. Its sandboxes are left in place.
