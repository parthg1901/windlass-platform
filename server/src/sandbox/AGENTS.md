# Hosted sandboxes

Actors ask the sandbox layer to provision a workspace and run a turn on Docker, E2B, Daytona or a user's machine.

## Quick commands

Run one command from the repository root.

- `cd server && npx tsx ../scripts/model-relay-route-check.ts` exercises the hosted relay route.
- `cd server && npx tsx --test ../scripts/plan-relay-check.ts` runs the in-sandbox plan relay against a recording upstream.
- `cd server && npx tsx ../scripts/harness-check.ts` checks the harness capability records and platform tool reach.
- `cd server && npx tsx --test src/sandbox/availability.test.ts` holds `availability` to its committed matrix and to the rules the server applies today. `UPDATE_GOLDEN=1` rewrites the matrix.
- `cd server && npx tsx ../scripts/e2b-provider-test.ts` exercises E2B with an in-memory client; see the [E2B guide](./e2b/AGENTS.md).
- `cd server && npx tsx ../scripts/daytona-provider-test.ts` exercises Daytona without credentials.
- For a single section with CI's base image, use `cd server && WLP_CHECK_SECTIONS=profiles npx tsx ../scripts/sandbox-check.ts`.

## Module map

Interfaces and assembly

- `./api.ts` is the actor-facing contract: `Sandboxes`, `SandboxHandle`, `SandboxLayer`, `Windlass`, `RunTurnInput`/`RunTurnResult`, backups, sign-ins and the errors `SandboxUserError`, `MachineUnreachable`, `DeploymentFull`, `SandboxConnectionLost`.
- `./provider.ts` defines `TurnSandbox` (what turn code may ask of any provider), the guest paths `DATA_DIR`/`WORKSPACE`, run tags, sweep and secret-file scripts and model-relay lease types.
- `./index.ts` builds the layer: `createSandboxLayer` for Docker, `createHostedLayer` for E2B or Daytona (lazy imports). `server/src/layer.ts` chooses by `WLP_SANDBOX`.
- `./hosted.ts` defines `HostedSandboxProvider` and `HostedSandboxes`, the shared `Sandboxes` for E2B and Daytona.
- `./runner-layer.ts` serves a session placed on a user's machine: `RunnerLink` sends each provider operation over the runner channel; `machineLayer` wraps it.

Turns and harnesses

- `./turn.ts` holds `SandboxWindlass`, the provider-independent Windlass turn over ACP: prompts, host tools, approvals, redaction, credential revocation and sweep.
- `./harness.ts` defines the `Harness` interface, `WindlassHarness` and the per-session choice of harness.
- `./harnesses.ts` holds `HarnessCapabilities`, `WINDLASS_CAPABILITIES`, the `AcpProfile` records `CLAUDE`, `OPENCODE`, `CODEX`, plus `keyProviders`, `usesAccountModels`, `capabilitiesOf` and the item and sign-in problem sentences.
- `./availability.ts` answers whether an agent can do a kind of work at a place (`availability`, `availableProfiles`): one rule per refusal, with a code, one sentence and a fix. `./availability.golden.md` is its matrix.
- `./acp-harness.ts` runs a Claude Code, OpenCode or Codex turn over ACP and refuses inputs its record lacks (`unsupported`). Each agent's protocol quirks are in its `QUIRKS` table.
- `./acp.ts` is one end of a JSON-RPC 2.0 ACP connection, independent of Docker and sessions.
- `./acp-options.ts` reads model, effort and mode choices out of ACP config options.
- `./codex-modes.ts` lists Codex session modes per profile and refuses sandbox escapes on `docker-windlass-sandbox`.
- `./platform-checks.ts` runs a repository's saved checks between prompts for harnesses whose `checks` is `"platform"`.
- `./platform-steps.ts` counts tool calls as steps for harnesses whose `steps` is `"platform"`.
- `./hosted-keys.ts` maps a Settings-key or plan placeholder into each harness's environment variables (`windlassPlanEnv` for Windlass on the ChatGPT plan).
- `./demo.ts` holds scripted demo scenarios (`WINDLASS_ACP_SCRIPT`); no model is called.
- `./command.ts` holds `runCommand` with output caps and the `within` timeout helper.

Docker provider

- `./sandboxes.ts` holds `DockerSandboxes` and `DockerSandboxHandle`; one container per session, swept by run tag.
- `./docker.ts` wraps the `docker` CLI; no other sandbox file spawns processes.
- `./docker-flags.ts` holds per-profile `docker run` security flags (the bwrap seccomp file) and the in-container bwrap probe.
- `./profiles.ts` defines `PROFILES`, run flags and what each profile promises, including the E2B profiles and `withModelRelay`.
- `./volumes.ts` manages per-user Docker volumes for Windlass session data.
- `./windlass.ts` locates the image's Windlass and builds a turn's `docker exec`.
- `./tokens.ts` reads the installed Windlass version once per image ID.
- `./logins.ts` runs Windlass sign-in commands in a throwaway container for development.
- `./model-relay.ts` holds `DockerModelRelay`: one relay per daemon scope and a forwarder per turn. Hosted Docker opens only forwarded key and plan leases (`openKey`); the access-token lease (`open`) is a runner's.
- `./snapshots.ts` keeps post-setup Docker image snapshots, addressed by local image ID.
- `./snapshot-key.ts` derives snapshot keys from Git blob IDs and the lookup rules for children and reviewers.
- `./snapshot-deployment.ts` installs a deployment identity atomically in a shared state directory.
- `./git-mirrors.ts` allocates bounded Git mirror slots; sessions mount one read-only.
- `./store-limits.ts` holds the byte budgets shared by snapshots and mirrors; it imports nothing.

Credentials, network and data

- `./token-file.ts` opens Settings-key and plan relays (`openModelKeyRelay`), writes Windlass's plan placeholder file (`writePlanPlaceholder`), and keeps a turn's relay on its plan (`rotatePlanToken`): a ChatGPT plan's token fresh, and the relay closed within a minute once the plan is gone. No sandbox is handed an access token.
- `./relay-leases.ts` holds the platform route's leases (a credential reference each, never a secret), signed placeholders and route limits (`RelayLimiter`).
- `./plan-relay.ts` starts a plan's relay (Claude or ChatGPT) inside an E2B or Daytona sandbox as the transport user, its source and token on stdin (`localPlanRelay` of `TurnSandbox`). Its base URL is the wire's (`/v1` for ChatGPT).
- `./handoff.ts` describes the ChatGPT sign-in hand-off in words and numbers.
- `./hosted-network.ts` holds the hosted allow-list rules (`MAX_HOSTS`, `isHostName`, presets).
- `./hosted-settings.ts` reads the `WLP_HOSTED_` settings, falling back to the older `WLP_E2B_` names (`hostedName`).
- `./backup.ts` copies an agent's session data to an object store for providers that can run a shell command; it knows no agent's paths.
- `./backup-scripts.ts` holds what every copy is made and checked with: the pack and restore scripts, their one answer line, `backupStep` and the name checks. It imports no server configuration; the runner imports it.
- `./machine-backups.ts` keeps a machine session's copies on that machine (`MachineSessionBackups`), through its runner over the session's socket, when the runner reports `session-backups`.
- `./session-files.ts` describes, per agent whose record has `backups`, which files make up one session (`SessionFiles`, `sessionFilesOf`).
- `./session-data.ts` decides whether a session's agent data lives and dies with its sandbox (only Windlass's can be on a Docker volume).
- `./setup.ts` runs a repository's setup command beside Windlass, outside its command sandbox.
- `./attach.ts` moves private screenshot copies and single objects out of a sandbox.
- `./e2b/` is the E2B provider ([guide](./e2b/AGENTS.md)); `./daytona/` is Daytona (`./daytona/provider.ts`, `./daytona/guest.ts`, `./daytona/config.ts`), which reuses `HostedGuest` from `./e2b/sandboxes.ts`.

## Harness records

- Decide by `HarnessCapabilities` flags (`capabilitiesOf(id)`), `keyProviders(id)` and `usesAccountModels(id)`, never by comparing a harness id to a literal. A new agent should be one more `AcpProfile`.
- ACP agents start from `ACP_BASE` and override with `acpCapabilities`; `WINDLASS_CAPABILITIES` is Windlass's record.
- `MCP_PLATFORM_TOOLS` must stay equal to the tools `server/src/platform-tools.ts` lets the sandbox serve; `scripts/harness-check.ts` holds them equal.
- Web imports `./harnesses.ts`, `./codex-modes.ts` and `./profiles.ts` at runtime, so keep them and `./availability.ts` browser-safe: import only contract modules, each other, `./hosted-network.ts` and `../pay-with.ts`, never Node built-ins.

## Non-obvious patterns

- Put common turn behaviour behind `TurnSandbox`. Check the [Docker](./sandboxes.ts), [E2B](./e2b/sandboxes.ts), [Daytona](./daytona/guest.ts) and runner implementations when changing it.
- Stopping a process client does not stop guest processes. Signal and sweep by run tag (`SWEEP_SCRIPT`) before detaching.
- Model relay token files in sessions contain a per-turn placeholder. Refresh the real credential at the relay and revoke access when the turn closes.
- Windlass on a ChatGPT model is a plan turn, hosted or on a machine: it arrives with `modelKey` (`plan: true`). A Windlass turn without `modelKey` must be scripted (the demo).
- A signed E2B placeholder can reach another server process. The process hosting the session actor owns the live lease.
- Throw `SandboxUserError` (or a subclass) for a failure the person should read; `isSandboxUserError` in `server/src/auth.ts` maps it to a `UserError` with code `sandbox_error` (`clientError`).

## Pitfalls

- `shellQuote` in `./provider.ts` leaves safe arguments bare, while the one in `server/src/util.ts` always quotes. Providers whose command API takes a string use the former.
- Session actions await provider calls. Inspect and inventory must reject on ambiguous reads so actors keep their existing claims (`./hosted.ts`).
- `./turn.ts` and `./e2b/sandboxes.ts` are over 1,000 lines; search for the exported symbol rather than reading top to bottom.

## See also

[Runner](../../../runner/src/AGENTS.md) reuses the Docker operations. [Model relay](../../../docs/model-relay.md) describes the credential lifetime.
