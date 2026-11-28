# Codex on a machine

Codex has no login of its own on a machine. Its turns pay as hosted ones do, through Connections → Pay with: the
ChatGPT plan (connected with `npx @windlassai/cli connect codex`) through a plan relay on the machine, or the OpenAI
Settings key through the platform's relay ([machines.md](machines.md#plans-on-this-machine)). With neither, a turn
is refused with "Nothing can pay for Codex on “nas” yet. Connect a plan or add a key on Connections." Neither the machine nor the session ever holds the plan's token or the key:
the session gets a placeholder for its turn's relay. What each mode allows depends on the sandbox profile:

- **Hardened Docker profile: Container access only.** Commands run as `agent` directly in the session's container, under the machine's egress setting, and Codex asks for nothing. The container is the boundary.
- **Windlass sandbox profile: Read-only and Workspace access (the default).** The runner probes the pinned Codex binary first. In both modes every command runs in Codex's own sandbox without network. Read-only cannot change any file. Workspace access can change files in the workspace except `.git`, `.agents`, `.codex` and `.aws`, and in the temporary directories. Codex asks before anything beyond that: a command outside its sandbox (`require_escalated`), an edit outside the writable paths, or more permissions. On this profile every such request is refused, even one the user would allow. The image's `PermissionRequest` hook (`/etc/codex/config.toml`) refuses it inside Codex, so the model learns it was refused and the turn continues. `/etc/codex/requirements.toml` keeps hooks enabled, and a repository's `.codex/` is not loaded (see below). The platform refuses any request that still reaches it and adds a note to the timeline: "Codex asked to run a command outside its sandbox; refused on this profile." for a command, or "Codex asked to edit files outside its sandbox; refused on this profile." for an edit outside the writable paths.
- **Not offered on the Windlass sandbox profile:** Container access and Auto review. That profile's container runs with AppArmor and system paths unconfined, and with user namespaces and mount allowed, so that a command sandbox can run inside it. A command outside such a sandbox would run in that looser container. Auto review would let Codex's reviewer model approve such a command, and `requirements.toml` makes a turn that asks for it fail. The runner starts each Codex container with the profile's mode (`INITIAL_AGENT_MODE`); without it the image opens a session in Read-only. The platform takes a mode only once Codex reports it. If the agent reports a mode the profile does not allow, the platform stops the turn and the agent process and shows an error.

The **Plan mode** control selects the collaboration mode independently (`planMode` on the prompt). It is not the work items’ Plan first.

## Work items

A Codex builder runs Quick items only, never as a Plan-first subtask (`subtasks: false` in `server/src/sandbox/harnesses.ts`; plans and placement refuse it). Its profile picks its mode (`itemModes`):

- **Windlass sandbox profile (the default): Workspace access.** Filing it needs the runner to report `workspace-write`. Every request to leave Codex's sandbox is refused, as above. One that reaches the platform during an item's turn also stops the turn (`session/cancel`), which fails with `sandbox_escape_refused` and the platform's note, never the agent's words. The item asks the person to file the work again on the hardened profile or to give up. A refusal by the image's hook never reaches the platform: Codex reports no tool call for it, so there is nothing to note, and the turn goes on.
- **Hardened Docker profile: Container access.** Codex asks for nothing, and a request that still arrives is allowed once, as for the other agents.

Tokens count by what pays: a turn the ChatGPT plan pays is shown, not counted. The machine's listing gives the method an item is filed with (`method`: "chatgpt" with the plan connected, "api-key" with only the key), which the item keeps (`ItemAgent.signIn`, the session's `origin.signIn`). codex-acp 2.9.0 does return the turn's `usage` in its `session/prompt` answer (seen with the real image and a scripted model; the sum of each Responses request's usage), so an API-key item could be counted against its budget (`itemTokensOf` gives "budget"). It stays off until an API-key turn has been seen through the platform.

The platform's tools (`report`, `ask_person`, `request_secret`, `push`, `fetch_base`, and `publish` in a person's session) reach Codex over MCP as for the other agents. A machine reviewer gets `file_review` over MCP once per turn. Its approval cannot auto-merge the PR. See [The second review](work-items.md#the-second-review). codex-acp takes a `"type": "acp"` server itself, but serves it on a random loopback port, and Codex starts an MCP server only if `requirements.toml` allows its exact URL. So the image runs `wlp-acp-mcp` (`sandbox/harness/shared/`) in front of codex-acp, on `127.0.0.1:17895`, which `requirements.toml` allows as `windlass_platform` and nothing else. It says so in its `initialize` answer (`_meta["windlass-platform/acpMcp"]`). An image without it gets no server, and the timeline says the turn has no `report` or `ask_person`. If another process holds the port first, the session gets no server. `DISABLE_MCP_CONFIG_FILTERING` keeps codex-acp from dropping the server when a repository's `.codex/` names one the same. The endpoint is outside Codex's sandbox, in the launcher's process: a root-owned script, started with fixed arguments, that forwards each request on the platform's ACP connection. Its bearer token stays in memory. Codex calls them without asking in both modes. codex-acp hands Codex the server as a URL and headers only, so Codex would give a call 300 s; `wlp-codex-app-server` sets the server's `tool_timeout_sec` to an hour, since a publish waits for the person. A command in Workspace access cannot connect to the endpoint (no network). In Container access a command can, as with the other agents, if it can read the token from a process's memory.

`scripts/codex-sandbox-escape-check.mjs` checks the tools against a local image, and `scripts/runner-codex-check.ts` the item modes and the step that ends. CI runs both Codex Docker checks in the `codex-docker` group.

## A repository's `.codex/`

codex-acp 2.9.0 marks the session's workspace as a trusted project. Codex 0.171 loads a trusted project's `.codex/`: `config.toml`, `hooks.json` and `rules/*.rules`. MCP servers, hooks and commands allowed by a rule run outside Codex's sandbox. A cloned repository's contents are untrusted, so the image's `wlp-codex-app-server` (between codex-acp and `codex app-server`) removes that trust setting. The workspace has no trust decision, and Codex ignores its `.codex/`. It also refuses codex-acp's writes to Codex's own config, the only way to trust a hook.

This is the same on both sandbox profiles. On the hardened Docker profile the container is the boundary, and a repository's settings could do no more than the agent's commands in Container access. They are still ignored there: the image is the same, the platform chooses the model and the modes itself, and an MCP server or hook from a repository would start without anyone asking for it.

A `.codex/` written during a session stays unloaded as long as nothing trusts the workspace, and only Codex's user config could (see [Codex's own config](#codexs-own-config-codex_home)). On the Windlass sandbox profile Codex cannot write `/workspace/.codex` (the edit asks for approval, which is refused). A repository's setup command and Container access commands can, and Codex reads config afresh for each session and still ignores it.

A repository's `.codex/` cannot:

- start an MCP server (`mcp_servers`). `requirements.toml` also allows only the platform's server, by its URL, so Codex starts no other MCP server from any config, including one a skill names. A `windlass_platform` entry there does not replace the platform's;
- run a hook (`[hooks]` in `config.toml`, or `hooks.json`). `requirements.toml` also lets only managed hooks run, which here means the image's own;
- run a command outside the sandbox with an exec policy rule (`decision = "allow"` in `rules/*.rules`);
- widen the sandbox with `sandbox_mode`, `approval_policy`, `approvals_reviewer`, `sandbox_workspace_write` (`writable_roots`, `network_access`), `default_permissions` or `[permissions]` profiles;
- set the environment of commands (`shell_environment_policy`);
- send model requests elsewhere or run a command after a turn with `model_provider`, `model_providers`, `openai_base_url`, `chatgpt_base_url`, `notify`, `profile`, `profiles`, `otel` or the `experimental_realtime_*` base URLs. Codex 0.171 drops these from every project config anyway;
- set any other key: features, agent roles, `experimental_*` settings, instruction files and the rest.

Codex still reads the repository's `AGENTS.md` and its skills (`.agents/skills`, `.codex/skills`). They are instructions to the model, and whatever they ask for runs in the same sandbox under the same refusals.

## Codex's own config (`CODEX_HOME`)

Besides a project's `.codex/`, Codex 0.171 loads a user layer from `CODEX_HOME` every turn: `config.toml`, `rules/*.rules`, `hooks.json`, `AGENTS.md` and `.env`. A user `config.toml` can trust the workspace (`[projects."/workspace"] trust_level = "trusted"`), which loads its `.codex/` after all. It can also set `notify`, which runs outside the sandbox after each turn, or `otel` exporters, which send the session's events elsewhere. A rule with `decision = "allow"` runs a command outside the sandbox, and `.env` sets the environment of Codex and of every command.

A repository's setup command runs as `agent` outside Codex's sandbox, before the session's turns. Container access commands on the hardened profile run as `agent` too. Neither can write that layer. `CODEX_HOME` is `/opt/wlp-codex/home`, a directory owned by root and outside `/home/agent`, where `agent` could rename a directory away and make its own. Only what Codex writes belongs to `agent`:

- `sqlite/` (`CODEX_SQLITE_HOME`): Codex's state, logs, goals, queue, memories and thread history databases;
- `sessions/` and `archived_sessions/`: the rollout of each thread;
- `skills/`: the skills bundled with Codex, unpacked into `skills/.system` at start;
- `tmp/`, `.tmp/` and `thread-writer-locks/`: temporary files, the helper links Codex puts first on `PATH`, plugin staging and locks;
- `shell_snapshots/`, `log/` and `cache/`: created in advance, unused with this configuration;
- `installation_id` and `.sandbox_migration`: two files Codex opens for writing. The installation ID is the same for every session of the image.

Skills written to `skills/` are instructions to the model, like a repository's. `wlp-codex-app-server` refuses to start Codex if `CODEX_HOME` is writable by its user, or holds any of the user layer's files. It also sets `CODEX_HOME` and `CODEX_SQLITE_HOME` itself.

Codex's shell snapshot would run the agent's login shell outside its sandbox at each session start, and with it `~/.bash_profile` or `~/.profile`. `requirements.toml` turns it off. A repository's setup command can still write the agent's shell startup files, since `/home/agent` belongs to `agent`. Codex runs each command as a login shell inside its sandbox, so they run there, with the command's own limits: no network, and writes only to the workspace and the temporary directories in Workspace access. In Container access they run like any command in the container.

`scripts/codex-sandbox-escape-check.mjs` checks each of these against a local image, including a user config that a setup command tries to leave (written with `docker exec -u agent`).

In `restricted` egress mode the machine's proxy refuses requests from Codex sessions to `api.openai.com`, `auth.openai.com` and `chatgpt.com`. It blocks OpenAI only by hostname. This is a policy, not a security boundary: a command can still reach OpenAI by another route, and it can always make model requests through its session's relay. Credentials are safe regardless, because a session holds only a placeholder for its turn's relay and never the plan's token or the key.
