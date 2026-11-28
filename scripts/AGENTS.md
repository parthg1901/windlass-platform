# Checks and CI selection

Most checks are standalone programs. Use the changed source path to find the check that exercises it.

## Quick commands

Run one command from the repository root.

- `node scripts/agents-docs-check.ts` validates file references and command targets in agent guides.
- `node scripts/ci-heavy.mjs select --files server/src/github/events.ts` prints the matching CI groups.
- `node scripts/workflow-lint.ts .github/workflows/ci.yml` checks one workflow's permissions and action pins.
- `cd server && WLP_CHECK_SECTIONS=issuing npx tsx ../scripts/connection-check.ts` runs one section of a sectioned check.

## Key files

- `./ci-groups.json` maps source paths to heavy checks, shard arguments, environments and images. Its `about` field explains `core`, `docs` and shards.
- `./ci-heavy.mjs` selects jobs from that map (`select --base`, `--files`, `--all`) and runs a group or shard's commands in the server workspace (`run`).
- `./agents-docs-check.ts` checks paths from the repository root, explicit `./` and `../` paths from the guide, and commands from their working directory. The rules live in `server/src/repo-setup/guide-check.ts`.
- `./workflow-lint.ts` checks Actions permissions and requires actions pinned by commit.
- `./e2e.ts` is the full actor and HTTP end-to-end run (the `e2e` script in `server/package.json`). `--section=core|usage|resume` splits it for root `pnpm test:core`, `test:usage` and `test:resume`.

## Naming

- `*-check.ts` is a standalone check, run from `server/` with its tsx, as in `cd server && npx tsx ../scripts/setup-check.ts`. Some import `node:test` and need `tsx --test`, such as `./readiness-check.ts`, `./install-script-check.ts` and `./kept-sandbox-check.ts`. Copy the exact invocation from `./ci-groups.json` or root `package.json`.
- `*-check.mjs` files are dependency-free. Relay and wizard checks run under `node --test` from the root, as in root `pnpm test:factory`. The `*-docker-check.mjs` files and `./codex-sandbox-escape-check.mjs` take an image argument and run under `tsx` in the `sandbox-docker` and `codex-docker` groups.
- `*-e2e.ts` starts real servers on fresh state: `./e2e.ts`, `./factory-e2e.ts`, `./runner-e2e.ts` (first argument `inventory`, `fairness`, `claude`, `egress` or none) and `./connection-e2e.ts`.
- `*-provider-test.ts` exercises a sandbox provider against a stand-in: `./e2b-provider-test.ts` and `./daytona-provider-test.ts`.
- `*-standin.*` is a loopback HTTP stand-in for an external service, used by checks: `./github-standin.ts`, `./gitlab-standin.ts`, `./linear-standin.ts`, `./jira-standin.ts`, `./slack-standin.ts`, `./runner-standin.ts` and `./e2b-network-standin.mjs`, which models E2B egress for `e2b-provider-test.ts --docker`.
- `*-fake.*` fakes a dependency inside the check: `./dodo-fake.ts` (payments), `./acp-agent-fake.ts` (ACP agent stream), `./runner-fake.ts` (control-only runner) and `./runner-wizard-fake.mjs` (machine for the setup wizard).
- `*-fixture.ts` holds shared fixture code: `./setup-guide-fixture.ts` (setup guide text), `./issue-intake-fixture.ts` (`pollUntil`, `readProvenance` for webhook and Linear filing) `./feature-git-fixture.ts`, preloaded with `--import` by `./factory-e2e.ts`, and `./gitlab-workspace-fixture.ts`, which runs the fake layer's Git commands against the GitLab stand-in for `./gitlab-check.ts`.
- Tools that are not checks include `./dev.sh` (root `pnpm dev:server`), `./platform-key.ts` (platform signing key), `./e2b-template.ts`, `./e2b-cleanup.ts`, `./runner-build.sh`, `./readme-shots.mjs`, `./public-suffix-update.mjs` and `./locked.sh` (a compatibility shim that runs a check by name with tsx).

## Shared helpers

Reuse these instead of re-implementing them in a new check. A new check reports through `./check-report.ts` and waits through `./check-wait.ts` rather than defining its own `expect`, `sleep` or polling loop.

- `./check-report.ts` holds the PASS/FAIL reporters. `Report` counts and prints `PASS  name  (detail)` and `FAIL` lines (`failure: "dash"` for `FAIL  name  -- detail`) and runs `check(name, body)`; `OkReport` prints `ok`/`FAIL` with a failure's detail on the next line. Each `summary()` prints the closing line and returns the exit code.
- `./check-wait.ts` holds `sleep` (from `server/src/util.ts`) and `waitFor(what, probe, timeoutMs, everyMs)`, which polls until the probe gives a value other than undefined, null or false, and throws a timeout naming `what`.
- `./check-sections.ts` holds `matchesSection(name)` for `WLP_CHECK_SECTIONS`, and `sectionMatcher(variable)` and `sectionPrefixes(variable)` for a check's own variable such as `FACTORY_ONLY`.
- `./check-listeners.ts` holds `localListeners(httpCount)`, which reserves RivetKit engine and HTTP ports outside the kernel's ephemeral range so parallel checks do not collide, and `portFree(port)`.
- `./check-secret.ts` sets a random `WLP_SECRET` when imported. Import it before server config so a multi-node check shares a key without writing a secret file under `.data`.
- `./check-image.ts` holds `imageId()`, which resolves the sandbox image tag once so every container in a check uses the same image.
- `./check-bucket.ts` holds `bucketSettings()`, which reads S3 settings from backup config or the R2 endpoint, bucket and key variables.
- `./login-http.ts` holds `loginHttp(api)`, which drives `/platform/login` start, finish and demo the way the browser does.
- `./chatgpt-connect.ts` holds `connectChatgpt(api, user, signIn)`, which connects a ChatGPT plan through the connect routes the way the CLI's `connect codex` does.

## Case filters

Each check parses its own filter, so the semantics differ. Copy the exact case name from the script. A typo usually runs nothing and still passes.

| Variable | Read by | Match |
| --- | --- | --- |
| `WLP_CHECK_SECTIONS` | `./connection-check.ts`, `./github-check.ts`, `./sandbox-check.ts`, `./signin-check.ts`, `./e2b-provider-test.ts`, `./e2b-snapshot-check.ts` via `./check-sections.ts` | Comma-separated, trimmed name prefixes. The connection `output` and sandbox `cleanup` sections always run. |
| `WLP_CHECK_SECTIONS` | `./billing-check.ts` | Exact value `exempt`. Exits after the exempt-account cases. |
| `FACTORY_ONLY` | `./factory-e2e.ts` via `./check-sections.ts` | Comma-separated, trimmed prefixes. `memory` selects the in-memory cases, which need no server. |
| `FACTORY_ONLY` | `./factory-check.ts` | Exact value `hosted-size`. Exits after the hosted-size cases, which run after the earlier ones. |
| `WEBHOOK_ONLY` | `./webhook-check.ts` | One case-sensitive prefix, not split on commas. |
| `LINEAR_ONLY` | `./linear-check.ts` via `./check-sections.ts` | Comma-separated, trimmed prefixes. Later cases depend on state from earlier ones. |
| `RUNNER_E2E_ONLY` | `./runner-e2e.ts` | A regular expression tested against case names, so `.` and `(` are special. |
| `WLP_ESCAPE_ONLY` | `./codex-sandbox-escape-check.mjs` | A substring anywhere in the case name. |

`./runner-check.ts` uses flags instead, such as `--snapshots-only`, `--sizing-only`, `--profiles-only` and `--main-only`. Checks that import `node:test` take `--test-name-pattern`.

## Non-obvious patterns

- When adding a heavy check, list the check file and the source paths that should select it. Unmatched paths select no heavy job. A `core` path selects every group, and a `docs` path selects none.
- Run TypeScript checks from the server workspace so they use its tsx. Match the invocation in the group's checks.
- The e2e checks start their own servers and stop them by PID. Never `pkill -f`, because another checkout may be running checks.
- For agent guides, use Markdown links or backticks for paths. Start each command example at the repository root and show any directory change. Never write placeholder filenames, because the guide check resolves them.

## See also

[Testing](../docs/testing.md) lists prerequisites. [Light CI](../.github/workflows/ci.yml) runs the documentation check, the Biome format and lint check and typechecks.
