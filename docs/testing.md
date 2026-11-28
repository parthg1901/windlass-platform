# Testing

Both workflows run on pushes to `main`, `wip/**` and `windlass/**`, and on demand.
Pull requests from other branches run both workflows too. A PR from an agent branch skips the
duplicate jobs because the push already ran them.

- **CI** (`.github/workflows/ci.yml`) validates the AGENTS.md guides, checks formatting and lint with Biome (`biome.json`), typechecks, builds the web app and scans for secrets.
  Pushes to `main`, PRs from non-agent branches and manual runs also run the four fake test
  shards in parallel. The `test` check combines their results. A newer branch run cancels a
  superseded run of the same event and ref; CI on `main` keeps its runs.
- **CI heavy** (`.github/workflows/ci-heavy.yml`) selects groups by changed paths on agent
  branch pushes and other PRs, and skips Dependabot. It runs all groups nightly on `main` and on a dispatch with `full` (run one before a deploy); a push to `main` gets the light CI only.
  A newer heavy run cancels a superseded run for the same event and ref. A feature's part branches
  (`windlass/feature-i_…-<part>-i_…`) get the light CI only; the heavy groups run on the feature branch.

`pnpm test` runs the four shards in sequence locally. Each script can also run on its own.

| Script | Suites |
| --- | --- |
| `pnpm test:factory` | Release, snapshots and logs, credentials, relays and setup, runner adapters and egress, factory, orchestrator, G3 webhook and factory orchestration E2E |
| `pnpm test:core` | Server E2E identity, platform and sessions, backups, GitHub, approvals and browser connection |
| `pnpm test:usage` | Fairness, timeline writes, runner fairness, server E2E usage faults and idle sandboxes |
| `pnpm test:resume` | Web staging, item feed, web unit tests and server E2E turn resumption |

## What a change runs

`scripts/ci-groups.json` is the map. Each group lists the paths it covers and the checks it runs, and
each group (or each shard of one) is one job. `scripts/ci-heavy.mjs select` reads the changed files
against the merge base (the pull request's base, or `main` for a branch) and picks the groups:

In the Actions UI each job shows a readable title (for example "Factory 1 of 4" for `factory/1`, "Runner: service and lifecycle" for `runner-docker/runner`); the titles live in `TITLES` in `scripts/ci-heavy.mjs`. Use the group/shard id with `node scripts/ci-heavy.mjs run <group>[/<shard>]`.

- a file that a group lists runs that group;
- a core file (the package files, the lockfile, `server/src/contract.ts`, the CI files) runs every group;
- documentation (`docs/**`, any `*.md`) runs nothing, and neither does a file no group lists;
- a push to `main`, the nightly run and a dispatch with `full` run every group.

While a PR changes a core file, each update runs every heavy group.

The Docker groups load the sandbox images from the Actions cache. The `images` job builds each image
once per run, with `docker buildx` and the GHA cache, so an unchanged Dockerfile builds nothing. The
sandbox image checks use the same Buildx builder to exercise `sandbox/build.sh` with its cached base
and screenshots layers. The runners are `ubuntu-24.04` (x86-64): every image, the Windlass release and the engine have an x86-64
build. Those jobs set `kernel.apparmor_restrict_unprivileged_userns=0` first: Ubuntu 24.04 keeps
unconfined processes out of user namespaces, so bubblewrap cannot start in a container of the Windlass
profile (`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`) until it is off.

To see what a change would run, before you push:

```sh
node scripts/ci-heavy.mjs select --base origin/main             # what a PR into main would run
node scripts/ci-heavy.mjs select --files server/src/usage.ts    # what a change to these files would run
```

## The checks by what they need

| Class | Checks | Where |
| --- | --- | --- |
| (a) Fake sandbox, no Docker | access, account, attachments, backup, machine-backup, connection, harness, models, model-providers, network, repository, review, reviewer-task, runner-control, runner-protocol, runner-signin, secrets, setup, environment, git-config, untrusted, session-title, usage, billing, verified, web-files, github, shot, sizing, start-times, model-relay-route, install-script, runner-wizard, model-plans, cli, plan-relay, pay-with, e2b-provider-test, workflow-lint; idempotency, signin, connection-e2e, http-limits; frame-auth, machine, runner-e2e, runner-socket-probe; factory-e2e (all sections), webhook-check (all sections), linear-protocol, linear-check and e2b-snapshot | CI heavy: `rules`, `actors`, `machines/*`, `factory/*`, `webhook`, `linear` |
| (a) Already in `pnpm test` | e2e.ts (fake), factory-check, orchestrator-check, fairness, machine-fairness (through `runner-e2e.ts fairness`), timeline-write, web-stage, item-feed, keyring, login-handover, revocation, snapshot, container-logs, the relay and setup `.mjs` checks, release-images (which drives release-check.ts), the web vitest suite | CI `test` |
| (b) Docker, base image (`windlass-platform-sandbox:latest`) | sandbox, mcp, model-relay-docker, github `--docker`, verified `--docker`, e2b-provider-test `--docker`, e2b-snapshot `--docker`, sizing `docker`; e2e.ts with `WLP_SANDBOX=docker`, and with `--snapshots-only` | CI heavy: `sandbox-docker/*` (sandbox-check in two shards by `WLP_CHECK_SECTIONS`), `e2e-docker/*` |
| (b) Docker, screenshots image (`:shots`) | shot `--docker`, attachments `--docker`, browser-hello `--docker` | CI heavy: `shots-docker` |
| (b) Docker, base image; builds its own runner and Claude images | runner-check `--service-only` (service, sandbox lifecycle and packaged runner) | CI heavy: `runner-docker/runner` |
| (b) Docker, base image | runner-check `--outages-only` (the five-minute outage and two-minute sleep are wall time) | CI heavy: `runner-docker/outages` |
| (b) Docker, base, screenshots and OpenCode images | opencode-docker; runner-check `--profiles-only`, `--harness-only`, `--sizing-only`, `--snapshots-only`, `--screenshots-only` | CI heavy: `runner-docker/suites` |
| (b) Docker, Claude image built on base (`sandbox/harness/build.sh`) | claude-relay-docker, runner-egress-live, `runner-e2e.ts egress`, machine-backup `--docker=claude` (the runner's real Docker transfer into a volume of the run's own, one container at a time, and `session/resume` in a new container) | CI heavy: `runner-docker/harness` |
| (b) Docker, the Codex image built on base (`sandbox/harness/build.sh codex`) | codex-docker (the relay, sign-in and modes), codex-sandbox-escape (refusals, a repository's and the user's config, and the platform's tools over MCP); both with a scripted model, no sign-in | CI heavy: `codex-docker` |
| (b) Docker, the Claude, Codex and OpenCode images (`sandbox/harness/build.sh`) | backup-check `--agents-docker` (a real ACP turn with no network, the real pack and restore scripts, and `session/resume` in a new container; no bucket, no sign-in); machine-backup `--docker` (all three agents through the runner's real Docker transfer) | your machine |
| (c) Real services, local only | e2b-check, e2b-hardening-check (nobody in the sandbox can become root: [Operating](operating.md#what-e2b-adds-to-the-template-and-why-the-platform-takes-it-away)), model-relay-e2b, e2b-snapshot `--live`, e2b-backup-check, e2b-template (except `--print`), e2b-cleanup (an E2B account); backup-check `--bucket` (a real bucket); connection-check's `cluster` section and runner-socket-probe with `WLP_CHECK_ENGINE` (a real engine and its admin token) | your machine |
| (c) A running self-hosted stack, local only | selfhost-csp, selfhost-ingress (with cloudflared), selfhost-load | the loopback demo stack of `deploy/selfhost` |

Account and secrets checks compare against Windlass's own source when `WLP_WINDLASS_SOURCE` points at a
checkout; on CI that comparison is skipped and the rest runs.

## For agents

1. Follow the root [AGENTS.md](../AGENTS.md) and the guide in the area being changed. `node scripts/agents-docs-check.ts` validates their file references and command targets. Run the typecheck first, then the affected check files or cases
   one at a time. Full suites run in CI.
2. Push a `wip/<name>` branch to run CI's typecheck, web build and secret scan, plus the path-selected
   heavy checks. The heavy plan summary names the groups and files that selected them.
3. Read the branch results with `gh run list -b wip/<name>`. Use `gh run view <id> --log-failed`
   for the failing job's output.
4. **Force a full run** when a change reaches further than its paths say (a new shared helper, say):
   `gh workflow run ci-heavy.yml --ref wip/<name> -f full=true`. Every push to `main` and the nightly
   run are full runs already. On a branch stacked on another, `-f base=<parent branch or commit>` chooses
   by the changes since that parent rather than since `main`.

When you add a check, put it in a group of `scripts/ci-groups.json`, with the paths it covers.
