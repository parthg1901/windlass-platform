## How to run a command

The runner is the program in the `windlass-runner` container. Its service starts with the command from the Machines page. To give it options, add them after the runner image in that command:

```sh
docker run -d --name windlass-runner --restart unless-stopped \
  --log-driver json-file --log-opt max-size=16m --log-opt max-file=3 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v windlass-runner:/var/lib/windlass-runner \
  <runner image> --platform <platform address> --max-turns 3
```

To change the options of a running runner, remove the container and run the command again with the new options. The volume keeps the key, so the machine stays paired:

```sh
docker rm -f windlass-runner
```

To run one of its other commands, use `docker exec` on the running container:

```sh
docker exec windlass-runner windlass-runner status
```

## Commands

The runner takes one command. With none, it runs `run`.

| Command | What it does |
| --- | --- |
| `run` | Runs the runner's service. This is the default. |
| `setup` | Sets the machine up in your terminal, one step at a time: pairs it, signs OpenCode in, asks for its profiles, network and limits, then starts the runner in the background and waits until it is online. See [Setup](#setup) and [Add a machine](/docs/machines#1-start-the-runner). `npx @windlassai/cli connect --machine` runs it for you with its defaults, and pairs the machine from a page you approve in the browser (see [Connect it with one command](/docs/machines#connect-it-with-one-command)). With `--harness`, it asks line by line to sign OpenCode in where it is given, then prints the command that starts the runner instead. |
| `pair` | Makes a new pairing code, for example after the code expired or after the machine was removed. |
| `status` | Says whether the runner is connected, its network mode, the limits in force, and for each pairing OpenCode's sign-in status, its sandboxes and its data volume. |
| `log` | Prints the runner's own record of what it was asked to do, for the last 14 days. |
| `prune` | Removes all containers and data volumes of this runner's pairings. |
| `login opencode` | Signs OpenCode in on this machine, in your terminal. The machine must be paired first. `--provider ID` skips the list of providers. See [Sign OpenCode in](/docs/machines#sign-opencode-in). Claude Code and Codex need no sign-in on the machine: they pay with your plan or key ([What pays on your machine](/docs/machines#what-pays-on-your-machine)). |
| `login claude` | Keeps a Claude Code login on this machine only, in place of your plan from Windlass there. `--token-stdin` reads one setup token from standard input; `npx @windlassai/cli connect claude --this-machine` uses it. See [Claude Code's own login on this machine](/docs/machines#claude-codes-own-login-on-this-machine). `logout claude` removes it. |
| `logout opencode` | Signs OpenCode out, for this pairing and every earlier one. |

### Setup

`setup` runs in a one-off container with the Docker socket and the `windlass-runner` volume, as the one-line install starts it:

```sh
docker run -it --rm --log-driver none -v /var/run/docker.sock:/var/run/docker.sock \
  -v windlass-runner:/var/lib/windlass-runner <runner image> setup --platform <platform address>
```

| Form | What it does |
| --- | --- |
| `setup` | Every step. Your earlier answers are the defaults. |
| `setup --quick` | Only what is missing: a pairing, a name, OpenCode not signed in, a step never answered. |
| `setup name`, `setup agents`, `setup profile`, `setup network`, `setup limits` | That step alone, then the summary and the start. The machine must be paired. |
| `setup opencode` | Signs OpenCode in, and adds it to the agents the machine offers. |
| `setup --no-tui` | The same steps as numbered lines: Enter takes the default, `b` goes back and `q` cancels. Setup uses lines by itself when it has no terminal; then it takes the defaults and signs nothing in. |

Setup keeps its answers in `setup.json` in the volume. The options of [Run options](#run-options) given to `setup` become its defaults, and those it does not ask about, such as `--slot-cpus`, are passed on to the runner it starts. With `--harness`, `setup` is the line-by-line setup from before, and prints the start command instead of running it.

### Codex

Enable Codex during `windlass-runner setup`, or start the runner with `--harness codex`. It needs no sign-in on the machine: it pays with your ChatGPT plan or your OpenAI key, as **Connections → Pay with** says. A plan's token goes to a relay on the machine for each turn, never into the session. Commands in a session can use that relay to make model requests while the turn runs. On the hardened Docker profile, **Container access** runs commands as `agent` in the session’s container under the machine’s egress setting; the container is the boundary. On the Windlass sandbox profile, once the machine passes its Codex probe, Codex offers **Read-only** and **Workspace access** (the default). In both, commands run in Codex’s own sandbox without network. Read-only changes no files, and Workspace access changes files only in the workspace. Codex may ask to run a command outside its sandbox or to edit outside it, and on this profile every such request is refused, even one you would allow. The timeline notes each refusal. Container access and Auto review are not offered there, because that profile’s container is loosened so that a sandbox can run inside it. Choose **Plan mode** to request a plan before changes.

### Status

```sh
docker exec windlass-runner windlass-runner status
```

It prints the runner's version, then its connection, then the network mode and the limits:

```text
Network egress is restricted.
Turn capacity: 2 slots
Running sandbox limit: no limit
Kept sandbox limit: no limit
```

After that it lists each pairing with each agent the runner has and OpenCode's sign-in, marked **(offered)** where the runner offers it, then its sandboxes and its data volume.

### Log

```sh
docker exec windlass-runner windlass-runner log
```

### Prune

`prune` asks you to type `yes` first. It refuses while the runner service runs, so stop the runner, prune in a one-off container with the same volume and Docker socket, then start the runner again:

```sh
docker stop windlass-runner
docker run --rm -it -v /var/run/docker.sock:/var/run/docker.sock \
  -v windlass-runner:/var/lib/windlass-runner <runner image> prune
docker start windlass-runner
```

> **Careful** `prune` removes the agents' files on this machine, and OpenCode's sign-in volume too. It cannot be undone.

## Run options

The sizing defaults below apply when all sizing options are left unset, including `WLP_RUNNER_CPUS`.

These options go after the runner image, with the `run` command or with no command. `setup` takes the same options, and passes them on to the command it prints. `--name` also works with `pair`.

| Option | Default | What it does |
| --- | --- | --- |
| `--platform URL` | The saved platform | The platform to connect to. It must be HTTPS, or HTTP on loopback. |
| `--slots N`, `--max-turns N` | As many 2 CPU, 4 GiB slots as fit after host reserves (1–16) | Total turn capacity in slots (1–64). A personal session uses one slot. Large factory sessions use more. |
| `--spares N` | 1 | Keep up to two ready sandboxes for the most recent eligible recipe, including on a one-slot machine. A matching session claims one first. Set to 0 to disable. |
| `--slot-cpus X` | 2, or all cores if a full slot cannot fit after reserves | CPU limit per slot. Overrides `WLP_RUNNER_CPUS`. |
| `--slot-memory Nm\|Ng` | An even share of usable memory (4–8 GiB) in quarter-GiB steps, or up to 4 GiB if a full slot cannot fit | Memory per slot, at least 1 GiB. The swap limit equals the memory limit. |
| `--sandbox-memory Ng` | Host memory after reserves | Total memory budget used to size the slots. |
| `--max-running N` | No limit | How many sandboxes may run at once. |
| `--max-sandboxes N` | No limit | How many sandboxes may be kept on this machine. |
| `--snapshot-disk SIZE` | 10GB | Disk for all setup snapshots on this machine. |
| `--snapshot-user SIZE` | 2GB | Disk for one user's setup snapshots. |
| `--keep-free SIZE` | 40GB | Free disk kept. Below it, snapshots are evicted oldest-first and no snapshot or Git mirror is saved. |
| `--name TEXT` | Docker daemon name or system hostname | Set the machine’s display name for pairing and reports. |
| `--egress MODE` | `restricted` for a new pairing; `open` for one made before network modes | The network mode of the agents' commands: `restricted`, `open` or `none`. See [Network access](/docs/machines#network-access). Claude Code, OpenCode and Codex keep their model relay in all three. |
| `--egress-allow HOST[,HOST]` | Empty | In `restricted` mode, let commands reach these hosts on your private network. Exact DNS names, up to 64. Given alone, it means `--egress restricted`. The machine's own addresses, Docker's networks and metadata addresses stay blocked. |
| `--egress-domains ENTRY[,ENTRY]` | Any public host | In `restricted` mode, let commands reach only these public hosts: DNS names, `*.name` for subdomains, or the presets `@npm`, `@pypi`, `@github`, `@crates` and `@go`. The platform's git host and `api.openai.com` are always added. Up to 64 hosts. A wildcard on a public suffix (`*.github.io`, `*.amazonaws.com`) is refused. Given alone, it means `--egress restricted`. See [Only some public hosts](/docs/machines#only-some-public-hosts). |
| `--allow-profile ID` | `docker-hardened` | Which Docker profiles agents may use here. Repeat it for both. |
| `--harness claude` | Off | Offers Claude Code on this machine. Needs a runner built with the Claude Code image. |
| `--harness opencode` | Off | Offers OpenCode on this machine. Needs a runner built with the OpenCode image. Repeat `--harness` to offer more than one agent. |
| `--harness codex` | Off | Offers Codex on this machine. Needs a runner built with the Codex image. See [Codex](#codex). |
| `--screenshots` | Off | Lets work-item sandboxes here take screenshots. Needs a runner built with the screenshots image. |

The runner saves `--name`, `--egress`, `--egress-allow`, `--egress-domains` and `--allow-profile` for this pairing, and uses them again when it restarts without them. `--harness` and `--screenshots` are not saved: give them each time you start the runner.

`N` is a positive whole number. A turn that would pass `--max-running` or `--max-sandboxes` ends with, for example, "This machine has reached its own limit on kept sandboxes, set by --max-sandboxes." The Machines page shows these limits under **Sandbox limit**, and says they are set on the machine, not there.

`SIZE` is a number with `MB`, `GB` or `TB`, such as `20GB` or `512MB`. The platform can cap the snapshot options: it can hold `--snapshot-disk` and `--snapshot-user` to at most its own limit, and `--keep-free` to at least its own. A small machine can lower `--keep-free`, down to the platform's floor. The Machines page shows the limits in force under **Snapshot storage**. These options need runner 0.3.2 or later. A [prepared environment](/docs/settings#environment) is kept under the same limits: when a build's image does not fit, the build says so and sessions start cold.

### Allowed profiles

A new pairing allows only `docker-hardened`. A pairing made before this setting existed allows both, until you give `--allow-profile`. To allow Windlass's own command sandbox as well, start the runner with both:

```sh
--allow-profile docker-hardened --allow-profile docker-windlass-sandbox
```

`docker-hardened` is always allowed, even if you leave it out. The runner saves your choice for this pairing, and uses it again when it restarts with no `--allow-profile`. To withdraw the Windlass profile, start it with `--allow-profile docker-hardened` alone. Its existing workspaces stay on disk.

If an agent asks for a profile the machine does not allow, it is refused: "This machine’s owner has not allowed the Windlass sandbox profile. Start the runner with --allow-profile docker-windlass-sandbox to allow it."

See [The two Docker profiles](/docs/security#the-two-docker-profiles) for what each one protects.

## Environment

| Variable | Default | What it does |
| --- | --- | --- |
| `WLP_RUNNER_CPUS` | 2, or all cores if a full slot cannot fit after reserves | The CPU cap of each slot. It must be at least 0.01. |
| `WLP_RUNNER_STATE_DIR` | `/var/lib/windlass-runner` | Where the runner keeps its key and state. |

Pass a variable with `-e`, for example `-e WLP_RUNNER_CPUS=2`, before the image in the `docker run` command.

## Messages the runner prints

| Message | What to do |
| --- | --- |
| "The pairing code expired or was denied, so restart the container or run `windlass-runner pair` to get a new code." | Restart the container, or run `pair`, and enter the new code. Setup says "re-run the setup command to get a new code." instead. |
| "This runner needs signed runner connections enabled on the platform. Ask the operator to enable them, then pair again." | The platform does not sign runner connections yet. Ask whoever runs it to turn them on, then pair again. |
| "The platform does not know this machine's key. Run `windlass-runner pair` to add the machine again." | The machine was removed, or its key was lost. Pair it again. |
| "Another runner with this machine's key is connected. If you copied the key, stop the other runner; if you did not, remove the machine on the Machines page." | Stop the other runner, or remove the machine. |
| "This runner is …; the platform needs … or later. Update it with the command on the Machines page." | [Update the runner](/docs/machines#update-the-runner). |
| "Another runner holds the state lock. Waiting to retry." | Two runners share one volume. Stop one. |
| "Docker needs at least 5 GB free to create a sandbox." | Free disk space on the machine. |
| "Use --egress open, restricted or none." | Give `--egress` one of the three modes. |
| "Use --egress-allow with restricted and up to 64 comma-separated DNS hostnames." | List DNS names, not IP addresses, and leave out `--egress open` or `none`. |
| "Use --egress-domains with restricted and up to 62 comma-separated public DNS names, *.name for any subdomain, or the presets @npm, @pypi, @github, @crates, @go." | Give names, `*.name` entries or presets, no addresses, ports or `https://`, at most 64 hosts with the two always added, and leave out `--egress open` or `none`. |
| "--egress-domains: *.github.io is refused. github.io is a public suffix (publicsuffix.org): …" | A wildcard on a name where different owners' sites live would reach any of them. Name the exact hosts. See [Only some public hosts](/docs/machines#only-some-public-hosts). |
| "Use --egress, --egress-allow and --egress-domains with setup or run." | Give them to `setup` or `run`, or with no command, not to `pair` or another command. |
| "Use --name with setup, run or pair and a printable name of 1 to 64 characters." | Shorten the name, or take out control characters. |
| "Use --allow-profile with setup or run and a profile ID: docker-hardened or docker-windlass-sandbox." | Give one of the two profile IDs. |
| "Use --slots, --slot-cpus, --slot-memory and --sandbox-memory with run or setup." | Give the sizing options to `run` or `setup` only. |
| "Use --snapshot-disk, --snapshot-user and --keep-free with run or setup." | Give the snapshot options to `run` or `setup` only. |
| "Give --snapshot-disk a size such as 20GB or 512MB." | Write the size with `MB`, `GB` or `TB`. The two snapshot sizes must be above 0. |
| "Choose --harness claude, --harness opencode or --harness codex." | Those are the agents a runner can offer. |
| "Use --harness opencode with a runner built with the pinned OpenCode image." | This runner image has no OpenCode. Use the image from the Machines page. Claude Code says the same for `--harness claude`. |
| "The runner is already using this state. Use login <agent> in the running runner." | The line-by-line setup cannot run beside the runner. Use `login` in the running container, remove it first, or run `setup` without `--harness`. |
| "Use setup, setup --quick, or setup with one of: name, agents, opencode, profile, network, limits." | Give one of those steps, or none. |
| "Pair this machine first: run setup." | A single step needs a paired machine. Run `setup` with no step. |
| "The runner is not online after 3 minutes …" or "The runner stopped. Read why with: docker logs windlass-runner" | Setup started the runner, but it did not report **Online**. Read `docker logs windlass-runner`. |
| "Invalid setup.json. Repair or remove that file in the runner state volume." | Remove `setup.json` from the volume; setup then asks every step again. |
| "Mount the Docker socket and runner state for setup." | Copy the setup command from the Machines page: it mounts both. |
| "Pair this machine before signing in to OpenCode." | Pair the machine, then run `login opencode` again. |
| "Attach a terminal to sign in interactively." | Run `login` with `docker exec -it`, so it has a terminal. |
| "Use an interactive terminal for device sign-in." | The ChatGPT sign-in of OpenCode needs `docker exec -it`. |
| "Enter a … API key of up to 4096 characters." | Paste the key only, on one line. |
| "Use --provider with login opencode." | `--provider` works only with `login opencode`. |
| "No matching provider. Enter another search or an exact id." | Search with another word, or type the ID. |
| "Unknown OpenCode provider. Run login opencode to search the provider list." | The `--provider` ID is not one the runner can route. Leave it out and search. |
| "OpenCode device sign-in did not finish." | The ChatGPT sign-in was not completed. Run `login opencode` again. |
| "A later login or logout superseded this OpenCode sign-in." | Another `login` or `logout` ran meanwhile. Run `login opencode` again if you still need it. |
| "Invalid OpenCode login metadata. Log out of OpenCode and sign in again." | Run `logout opencode`, then `login opencode`. |
| "Mount /import/opencode read-only with :ro." | The import folder must be mounted read-only. Copy the setup command from the Machines page again: it mounts the folder with `readonly`. |
| "Invalid OpenCode auth.json in the setup import mount." | OpenCode's `auth.json` could not be read. Leave out the import mount and sign in with `login opencode`. |
| "Network egress is open for this existing pairing. Start the runner with --egress restricted to opt in." | Not an error. This pairing predates network modes. See [Network access](/docs/machines#network-access). |
| "Docker could not apply the runner’s network policy." | The runner could not set up the sandbox's network. The Machines page shows it as a Docker warning. Check Docker on the machine, then restart the runner. |

After the platform refuses it, a runner tries again in 10 minutes.
