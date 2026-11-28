# Working in Windlass Platform

Make the smallest change that solves the task. Start with the guide in the area you touch.
Run each command below from the repository root in a fresh shell.

## Quick commands

Follow [Set up](#set-up) once, then run these from the repository root.

- `corepack pnpm -s typecheck` typechecks all workspaces in parallel.
- `corepack pnpm -s typecheck:serial` typechecks one workspace at a time, for small machines.
- `corepack pnpm -s format` formats with Biome; CI fails on unformatted files.
- `corepack pnpm -s lint` runs the Biome lint; `corepack pnpm -s lint:fix` applies its safe fixes.

tsc is incremental: each workspace keeps its build info in node_modules/.cache/tsc inside that workspace.
Biome formats and lints (`biome.json`): tabs, double quotes, semicolons, 120 columns.
Run the formatter before committing; editors with the Biome extension do it on save.

## Key files

- `package.json` defines the typecheck, lint and test scripts.
- `pnpm-workspace.yaml` lists the workspace packages: `server`, `runner`, `web` and `cli`.
- `biome.json` holds the format settings, lint rules and the files they skip.

## Architecture map

[Architecture](docs/architecture.md) has the full picture. In short:

- `server/` is the platform: one RivetKit node plus its own HTTP routes (`server/src/index.ts`).
- `web/` is the React app. It calls actors through the Rivet gateway and imports server types via `@contract`.
- `runner/` is the CLI on a user's machine. It pairs with the server and runs sandbox operations locally.
- `cli/` is `@windlassai/cli`, run with npx: `connect claude` and `connect codex` connect a Claude or ChatGPT plan ([CLI guide](cli/AGENTS.md)).
- `scripts/` holds standalone checks, stand-ins for external services and the CI selector.
- `sandbox/` builds the Docker and E2B images, harness wrappers and the model relay; `fixtures/` feeds the checks.
- `docs/` is operator documentation; `deploy/selfhost` is the self-hosting setup.

A request flows web → `server/src/registry.ts` actors in `server/src/actors/` → decisions in
`server/src/factory/` → work in `server/src/sandbox/` (hosted Docker, E2B or Daytona) or, for a
machine place, over the runner protocol in `server/src/runner/` to `runner/src/`. The browser gets
the gateway address and token from `/platform/connection` (`server/src/platform-info.ts`); actor
traffic does not pass through the server's HTTP port. Scripts use the API-token routes in
`server/src/api-routes.ts`; GitHub, GitLab, Linear, Jira, Slack and billing webhooks arrive as HTTP and are forwarded to actors.

Other `server/src` folders: `server/src/github/`, `server/src/gitlab/`, `server/src/codehost/` (the code-host interface items use),
`server/src/linear/`, `server/src/jira/`, `server/src/slack/`, `server/src/billing/`,
`server/src/signin/` (sealed ChatGPT and subscription sign-ins), `server/src/repo-setup/` (setup guides),
`server/src/contract/` (shared wire types), `server/src/machines/` and `server/src/bucket/` (object storage).
[Server guide](server/AGENTS.md) maps the loose files directly under `server/src`.

## Conventions

- Reuse `server/src/util.ts` (`isRecord`, `errorText`, `sleep`, `shellQuote`) instead of redefining them.
  Note that `server/src/sandbox/provider.ts` has its own `shellQuote` that leaves safe words bare.
- Shared wire types live in `server/src/contract/*.ts`, one module per topic, re-exported by
  `server/src/contract.ts` (its header indexes the modules). Add a type to its topic module rather than to the index file.
- Web imports `server/src/contract.ts`, `server/src/sandbox/harnesses.ts`, several `server/src/factory/`
  modules and other server files (and through them `server/src/util.ts`) at runtime. Keep those browser-safe: no Node built-ins, RivetKit or server config.
- Harness ids come from `HARNESS_IDS`, `MACHINE_HARNESS_IDS` and `isHarnessId` in `server/src/contract.ts`.
  Decide behaviour from the harness record in `server/src/sandbox/harnesses.ts` (`capabilitiesOf`,
  `keyProviders`, `usesAccountModels`), never with a check such as `harness === "claude"`.
- Domain modules throw their own Problem or Error class (for example `SecretProblem` in
  `server/src/repo-secrets.ts`). The actor action maps it to RivetKit's `UserError` with a stable
  `code` (see the catches in `server/src/actors/user.ts`). `clientError` in `server/src/auth.ts`
  turns other failures into a `UserError`, mapping `SandboxUserError` to `sandbox_error`.
- Type the untyped actor client as `ActorClient` from `server/src/actors/internal.ts`, not `any`.

## Set up

Use Node 22.22.2 or a newer 22.x patch.
Use the pnpm version pinned in `package.json`. CI installs from the lockfile.

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
```

## Typecheck first

The workspace commands below are alternatives to the recursive typecheck in Quick commands.

Server typecheck

```sh
cd server && npx tsc --noEmit -p .
```

Web typecheck

```sh
cd web && npx tsc --noEmit -p .
```

Always run **both** before merging server changes. Web follows imports into `server/src`
under stricter settings, including unused locals and parameters. Server can pass while web fails.
Runner changes also need `cd runner && npx tsc --noEmit -p .`; CLI changes `cd cli && npx tsc --noEmit -p .`.

## If you change X, run Y

After typechecking, pick the check for the behaviour you changed. Run one file or case at a time.
The area links lead to copyable commands. For other checks, look up the changed path in
`scripts/ci-groups.json` or ask the selector which groups cover it.

| Area | Pick a check | Narrow it |
| --- | --- | --- |
| [Factory](server/src/factory/AGENTS.md) | `scripts/factory-check.ts` for transitions, `scripts/orchestrator-check.ts` for features, `scripts/factory-e2e.ts` for the actor | The E2E reads `FACTORY_ONLY`, e.g. `FACTORY_ONLY=memory`. |
| [Actors](server/src/actors/AGENTS.md) | `scripts/timeline-write-check.ts` for session writes, `scripts/idempotency-check.ts` for retries, `scripts/signin-check.ts` for credentials | The sign-in and `scripts/connection-check.ts` checks use `WLP_CHECK_SECTIONS`, e.g. `seal` and `issuing` respectively. |
| [Sandbox](server/src/sandbox/AGENTS.md) | `scripts/model-relay-route-check.ts` for leases, `scripts/e2b-provider-test.ts` for the provider, `scripts/sandbox-check.ts` for Docker | On the Docker check use `WLP_CHECK_SECTIONS=profiles`. The Codex image check `scripts/codex-sandbox-escape-check.mjs` takes `WLP_ESCAPE_ONLY` (case-name substring). |
| [GitHub](server/src/github/AGENTS.md) | `scripts/github-check.ts` for the App and publishing, `scripts/webhook-check.ts` for delivery to actors | Use `WLP_CHECK_SECTIONS=connect` for the former and `WEBHOOK_ONLY='G3 feature'` for the latter. |
| [GitLab](server/src/gitlab/AGENTS.md) | `scripts/gitlab-protocol-check.ts` for the API adapter, `scripts/gitlab-check.ts` for connection and filing | The filing check takes section names as arguments, e.g. `connect`. |
| [Linear](server/src/linear/AGENTS.md) | `scripts/linear-protocol-check.ts` for HTTP and OAuth, `scripts/linear-check.ts` for filing | Only the filing check takes `LINEAR_ONLY`, e.g. `LINEAR_ONLY=OAuth`. |
| Jira and Slack | `scripts/jira-check.ts`, `scripts/slack-check.ts`, `server/src/slack/blocks.test.ts` (under `tsx --test`) | Each check runs as one case. |
| [Sign-in](server/src/signin/AGENTS.md) | `scripts/signin-check.ts` for sealing and refresh | `WLP_CHECK_SECTIONS=seal`. |
| [E2B](server/src/sandbox/e2b/AGENTS.md) | `scripts/e2b-provider-test.ts` against the fake client | See the guide for its section names. |
| [Billing](server/src/billing/AGENTS.md) | `scripts/billing-check.ts` against the payment fake | `WLP_CHECK_SECTIONS=exempt` (exact match here). |
| [Repo setup](server/src/repo-setup/AGENTS.md) | `scripts/readiness-check.ts` for guides and readiness | Runs under `tsx --test`; narrow with `--test-name-pattern`. |
| [Runner protocol](server/src/runner/AGENTS.md) | `scripts/runner-protocol-check.ts` for frames and replay | See the guide. |
| [Runner](runner/src/AGENTS.md) | `scripts/runner-protocol-check.ts` for reconnects, `scripts/runner-e2e.ts` for machine inventory, `scripts/runner-check.ts` for Docker | The E2E takes `inventory` or `fairness` and matches case names against the `RUNNER_E2E_ONLY` regex. Docker uses flags such as `--snapshots-only`. |
| [Web](web/src/AGENTS.md) | Run the adjacent Vitest file, or `scripts/item-feed-check.ts` for the item feed | Give Vitest one file and optionally `-t` with a test name. |
| [Scripts](scripts/AGENTS.md) | `scripts/agents-docs-check.ts` for these guides, `scripts/workflow-lint.ts` for workflow permissions and action pins | Pass one workflow file to the linter. For a changed check, use its own selector above. |

For a server-side check, use the server workspace's installed tsx. This selects the token-issuing case.

```sh
cd server && WLP_CHECK_SECTIONS=issuing npx tsx ../scripts/connection-check.ts
```

In most checks `FACTORY_ONLY` and `WLP_CHECK_SECTIONS` match comma-separated case-name prefixes;
`scripts/billing-check.ts` and `scripts/factory-check.ts` compare one exact value.
`LINEAR_ONLY` also takes comma-separated prefixes; `WEBHOOK_ONLY` matches one case-sensitive prefix.
[Scripts](scripts/AGENTS.md) lists every filter and its exact semantics.
Copy the prefix from the script. A typo can leave every matching case unexecuted.

## Leave suites to CI

Never run whole suites locally. Root `pnpm test` takes about 30 minutes.
CI splits it into `pnpm test:factory`, `pnpm test:core`, `pnpm test:usage` and `pnpm test:resume`.
Leave image-backed checks to CI. Heavy checks use changed paths to select jobs. To see which jobs a branch selects, run the selector.

```sh
node scripts/ci-heavy.mjs select --base origin/main
```

[Testing](docs/testing.md) lists the images, services and fixtures each group needs.
If several checkouts run side by side, keep the PID when starting a process and stop that PID with `kill "$pid"`.
Avoid `pkill -f`: it can stop another checkout's server or check.

## Edit and hand off

- Write readable code. Reuse existing code instead of copying it.
- Skip compatibility code for old or stored data. Avoid extra fallbacks.
- Prefer a few clear statements over a dense one-liner.
- Keep comments short and explain why. Skip restatements and long prose blocks.
- Keep `README.md` short. Put behaviour documentation in `web/src/docs/content/*.md`.
- When a guide's paths or commands change, run `node scripts/agents-docs-check.ts`.
- Write each commit message and pull request title as one short Conventional Commit line, such as `fix: keep auto-merge when main moves`.
