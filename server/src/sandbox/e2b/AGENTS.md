# E2B provider

Hosted sessions run in E2B microVMs. This folder implements `HostedSandboxProvider` (`server/src/sandbox/hosted.ts`) for E2B.

## Quick commands

Run one command from the repository root. None of these needs an E2B account.

- `cd server && npx tsx ../scripts/e2b-provider-test.ts` runs the provider on the in-memory client.
- `cd server && WLP_CHECK_SECTIONS=network npx tsx ../scripts/e2b-provider-test.ts` selects the network-mode sections (comma-separated name prefixes).
- `cd server && WLP_CHECK_SECTIONS='the switch' npx tsx ../scripts/e2b-snapshot-check.ts` checks the setup-snapshot switch in memory.

`--docker` on either script runs real containers of the sandbox image; leave that to CI (`sandbox-docker` in `scripts/ci-groups.json`).
`scripts/e2b-check.ts`, `scripts/e2b-backup-check.ts`, `scripts/e2b-hardening-check.ts` and `scripts/model-relay-e2b-check.ts` use a real account and `E2B_API_KEY`.

## Module map

- `./index.ts` builds the layer: `createE2bSandboxLayer` wraps `E2bProvider` in `hostedLayer`.
- `./client.ts` defines `E2bClient`, the only E2B surface the provider uses, plus `E2bBusyError`, `E2bLimitError` and `E2bSnapshotModeError`.
- `./sdk.ts` maps `E2bClient` onto the `e2b` SDK. It and `./template.ts` are the only files that import the SDK.
- `./fake.ts` is `FakeE2b`, an in-memory `E2bClient` modelling the cap, timeouts, pause, resume and kill; `ScriptedMachine` scripts command results.
- `./sandboxes.ts` holds `E2bProvider` and `E2bSandboxHandle`, plus `HostedGuest`, the guest base class Daytona also extends. `META` names the sandbox metadata keys.
- `./config.ts` reads `E2bSettings` (`readE2bSettings`), per-size templates (`templateFor`) and the API key (`readE2bKey`).
- `./guest-hardening.ts` holds `GUEST_HARDENING_SCRIPT`, which removes the root paths E2B's base system adds. The provider (`harden`) and the template build both run it.
- `./network.ts` reads the egress mode and allow-list and holds the guest DNS stub that pins allowed names in `/etc/hosts` and logs blocked lookups.
- `./snapshots.ts` holds `E2bSnapshots`, post-setup snapshots behind `WLP_E2B_SNAPSHOTS=on`.
- `./template.ts` turns `sandbox/Dockerfile` into an E2B template; `sandbox/e2b/build.sh` and `scripts/e2b-template.ts` drive the build.
- `./pricing.ts` estimates cost from vCPU and memory seconds.
- `./cleanup.ts` lists and kills a deployment's sandboxes for `scripts/e2b-cleanup.ts`.

## Non-obvious patterns

- Only touch sandboxes whose `wlp_deployment` metadata names this deployment. Listing, cleanup and inventory all filter by it.
- E2B pauses an idle sandbox when its timeout runs out (the dead-man switch). Hold the sandbox while a turn or long command runs so the provider keeps pushing the timeout out.
- E2B fixes CPU and memory at template build time, so each size has its own template, and harness and screenshot variants add suffixes (`templateFor`).
- A guest that ran out of memory still starts commands but never finishes one, and pause keeps that memory. The provider probes with `true` on connect and restarts from disk when it does not answer (`RESTARTED_NOTICE`).
- E2B enforces the allow-list outside the microVM. With DNS egress closed, the guest resolves allowed names through pinned `/etc/hosts` entries.
- E2B's template build adds systemd, an sshd that lets root in, rpcbind, and `root` and `user` with empty passwords. With them, any agent command can become root or `nobody`. `harden` runs `GUEST_HARDENING_SCRIPT` as root before anything of a session's: on create, on resume, on a restart from disk, on the refresh before a turn, and on a process's first connect to a running sandbox. If the check fails, the sandbox is not used (`hardeningRefusal`).
- Settings read the `WLP_HOSTED_` names first and fall back to the older `WLP_E2B_` names (`hostedName` in `server/src/sandbox/hosted-settings.ts`).

## Pitfalls

- Write provider logic against `E2bClient`, not the SDK, so `FakeE2b` can test it. When adding a client method, implement it in `./sdk.ts` and `./fake.ts` together.
- Every new path that connects to a sandbox and then runs anything of a session's must go through `acquire`, or call `harden` itself. A pause and resume keeps the hardened memory, but a start from disk boots E2B's base system again.
- `FakeE2b`'s `ScriptedMachine` answers the hardening script with `hardened` unless a test's answer says otherwise. Root-command counts in tests must allow for it.
- `HostedGuest` changes reach Daytona too; run `scripts/daytona-provider-test.ts` as well.
- Turn credentials on E2B are relay leases owned by the process hosting the session actor (`server/src/sandbox/relay-leases.ts`).
  A Claude plan is the exception: `localPlanRelay` of `HostedGuest` runs its relay inside the sandbox as `nobody` (`server/src/sandbox/plan-relay.ts`), and a Claude Code sandbox (`wlp_harness` metadata) may reach Anthropic's API out of `open` (`withPlanHosts`).

## See also

[Sandbox layer](../AGENTS.md) defines the shared interfaces. [Operating](../../../../docs/operating.md) lists the E2B settings.
