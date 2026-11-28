# Server guide

Start with the area guide below before editing its code. Paths are repository-root relative.

## Folder layout

- `server/src/actors/` owns durable users, sessions and work items; see `server/src/actors/AGENTS.md`.
- `server/src/factory/` decides work-item transitions and feature plans; see `server/src/factory/AGENTS.md`.
- `server/src/github/` handles App access, publishing and webhooks; see `server/src/github/AGENTS.md`.
- `server/src/gitlab/` handles GitLab OAuth, project hooks, merge requests and pipelines; see `server/src/gitlab/AGENTS.md`.
- `server/src/codehost/` is the interface work items use to reach their code host (GitHub or GitLab). Resolve a repository's host with `hostFor` (`server/src/codehost/item.ts`), key it with `repoKey` (`server/src/codehost/ref.ts`), and branch on the host's `caps` (`server/src/codehost/capabilities.ts`), never on `provider`.
- `server/src/repo-setup/` validates setup guides and prepares setup changes; see `server/src/repo-setup/AGENTS.md`.
- `server/src/sandbox/` provisions workspaces and runs turns; see `server/src/sandbox/AGENTS.md`. The E2B provider has its own guide, `server/src/sandbox/e2b/AGENTS.md`.
- `server/src/linear/` connects Linear workspaces and files issues as items; see `server/src/linear/AGENTS.md`.
- `server/src/jira/` holds Jira Cloud OAuth, site discovery and signed dynamic webhooks; `server/src/actors/jira-site.ts` keeps the filings.
- `server/src/slack/` verifies Slack requests, connects workspaces, and posts item threads, plans and questions.
- `server/src/runner/` is the server side of the machine runner protocol; see `server/src/runner/AGENTS.md`.
- `server/src/signin/` runs harness sign-ins and seals their credentials; see `server/src/signin/AGENTS.md`.
- `server/src/credentials/` keeps what pays for model requests: Settings keys and connected plans; see `server/src/credentials/AGENTS.md`.
- `server/src/billing/` holds plans, metering and the payment provider; see `server/src/billing/AGENTS.md`.
- `server/src/contract/` holds the topic modules re-exported by `server/src/contract.ts`.
- `server/src/bucket/` is the object store for backups and screenshots (`server/src/bucket/store.ts`, with S3 and stand-in backends).
- `server/src/machines/` validates machine details and profiles and issues runner attach tickets (`server/src/machines/ticket.ts`).
- `server/src/registry.ts` wires actors; `server/src/index.ts` is the server entry point.

## Shared contract

`server/src/contract.ts` holds shared wire types and runtime constants, with modules in `server/src/contract/`.
Keep its runtime imports browser-safe, as required by `server/src/contract.ts`.
`web/tsconfig.json` maps `@contract` to this file and includes it in the web typecheck.
Run both typechecks for server changes: `web/tsconfig.json` also enables unused-local and unused-parameter checks.

## Loose modules in server/src

Reuse `server/src/util.ts` (`isRecord`, `errorText`, `sleep`, `shellQuote`) instead of redefining these helpers. It is browser-safe.

Entry, wiring and HTTP routes (dispatched from `server/src/index.ts`):

- `server/src/index.ts` starts the Rivet node and routes the platform's own HTTP paths beside it.
- `server/src/registry.ts` lists every actor; `server/src/client.ts` re-exports RivetKit's client and the registry type for scripts.
- `server/src/layer.ts` loads the configured sandbox layer (Docker, E2B or fake) on first use.
- `server/src/api-routes.ts` serves `/api/items` for scripts holding an API token.
- `server/src/login-route.ts` serves the `/platform/login/` steps; `server/src/platform-login.ts` runs the Google and GitHub OAuth exchange.
- `server/src/runner-routes.ts` serves machine pairing, pair polling and runner connection requests.
- `server/src/install-script.ts` serves `GET /install.sh` for machine installs.
- `server/src/connect-route.ts` serves `/platform/connect/start`, `/poll` and `/platform/connect`: the connect command (`cli/`) opens a request, waits for the user to approve its code on the web page, then hands a plan's token over once.
- `server/src/platform-info.ts` serves `/platform/info` and `/platform/connection` with cached deployment facts.
- `server/src/model-relay-route.ts` is the credential boundary for E2B and forwarded Docker model requests; `server/src/model-relay-url.ts` parses `WLP_MODEL_RELAY_URL`.
- `server/src/web.ts` serves the built web app when `WLP_WEB_DIR` is set.
- `server/src/http-limits.ts` holds per-address rate budgets and the client address header rule.

Auth, tokens and signing:

- `server/src/auth.ts` decides who calls an actor from the `{ token }` parameter (`requireUser`, `requireService`).
- `server/src/tokens.ts` issues and verifies versioned user and service tokens.
- `server/src/signatures.ts` derives HKDF keys per purpose and signs payloads; `server/src/keyring.ts` reads rotating root keys.
- `server/src/access.ts` applies the `WLP_ALLOWED_EMAILS` / `WLP_ALLOWED_USERS` allow list.
- `server/src/api-tokens.ts` manages users' `wlp_` API tokens.
- `server/src/connection-tokens.ts` gets scoped engine tokens for browsers on Rivet Cloud.
- `server/src/runner-keys.ts` holds pair codes, digests and machine key helpers.
- `server/src/actor-errors.ts` tells whether a call failed because the target actor is gone.
- `server/src/submissions.ts` checks idempotency keys so a repeated call is recognized.

Configuration and startup:

- `server/src/config.ts` reads all server configuration from the environment once; its header lists the variables.
- `server/src/startup.ts` reports refused configuration and sandbox layer warnings at start.

Admin CLIs (run in the server environment):

- `server/src/link-identity.ts` links a provider identity to a user.
- `server/src/revoke-user-tokens.ts` revokes a user's tokens.
- `server/src/set-user-limit.ts` sets or lists a user's limits.

Usage, limits and provider refusals:

- `server/src/usage.ts` keeps hosted sandbox time, kept sandboxes and their limits.
- `server/src/user-limits.ts` resolves per-user limit overrides and their audit log.
- `server/src/provider-usage.ts` tracks provider rate-limit observations; `server/src/provider-refusal.ts` turns refusals into turn outcomes and messages.
- `server/src/start-times.ts` records how long each part of a turn's start took.

Models and model providers:

- `server/src/account-models.ts` lists the models and reasoning efforts a user may choose.
- `server/src/model-prices.ts` reads model prices from the public models.dev catalog once a day (bounded, stale prices kept on failure) for items' dollar cost (`server/src/factory/cost.ts`).

Platform tools, MCP servers and Windlass config:

- `server/src/platform-tools.ts` declares which platform tools a turn gets and how calls are answered.
- `server/src/agent-publish.ts` defines `publish`, `push`, `fetch_base`, `report` and the other agent tools.
- `server/src/personal-servers.ts` stores account MCP servers; `server/src/personal-server-definition.ts` validates their definitions.
- `server/src/server-approvals.ts` remembers approvals of project MCP servers; `server/src/server-question.ts` words the approval question.
- `server/src/windlass-config.ts` writes the user's MCP servers and turn hooks into Windlass's per-turn configuration.

Repositories and secrets:

- `server/src/repo-secrets.ts` validates, seals, scopes and redacts repository secrets; `server/src/account-secrets.ts` builds account secrets on it.
- `server/src/repository-checks.ts` stores the saved verification checks; `server/src/verified.ts` reads what a turn's checks came to and how a pull request reports it.
- `server/src/repository-defaults.ts` stores account and repository run choices (bundled by web too).
- `server/src/pay-with.ts` stores each plan agent's Pay-with choice (`pay_with`) and holds `payWithFor` and `decidePayer`, the rule a hosted turn follows at its start, and `planPays`: Windlass's ChatGPT models follow it too, without a choice (bundled by web too).
- `server/src/repository-network.ts` stores a repository's network allow list and blocked-host requests; `server/src/blocked-network.ts` merges and caps blocked-host reports.
- `server/src/setup-command.ts` validates the setup command and keeps its output tail.
- `server/src/environments.ts` builds and promotes a repository's prepared environments.

Places and work items:

- `server/src/start-place.ts` resolves where a session starts among paired machines and hosted profiles.
- `server/src/snapshot-places.ts` finds saved post-setup snapshots a new session can start from.
- `server/src/item-pages.ts` pages through a user's ended work items.

Test support:

- `server/src/sandbox-fake.ts` is the `WLP_SANDBOX=fake` layer: in-memory sandboxes replaying runs from `fixtures/windlass-events/`.

## Typecheck first

Run each command from the repository root in a fresh shell, following `AGENTS.md`.

```sh
cd server && npx tsc --noEmit -p .
```

```sh
cd web && npx tsc --noEmit -p .
```

The configurations are `server/tsconfig.json` and `web/tsconfig.json`.

## Pick a focused check

`scripts/ci-groups.json` maps changed paths to checks, environments, shard arguments and images.
Use that map rather than assuming one folder selects only one group.

| Area | Check paths | CI groups in `scripts/ci-groups.json` |
| --- | --- | --- |
| Actor retries and credentials | `scripts/idempotency-check.ts`, `scripts/signin-check.ts` | `actors` |
| Factory transitions and feature planning | `scripts/factory-check.ts`, `scripts/orchestrator-check.ts` | `factory` |
| GitHub linking/publishing and event delivery | `scripts/github-check.ts`, `scripts/webhook-check.ts` | `rules`, `webhook`; Docker publishing in `sandbox-docker` |
| Repository setup and readiness | `scripts/readiness-check.ts` | `rules` (check key `repo-setup`) |
| Sandbox relay and Docker behaviour | `scripts/model-relay-route-check.ts`, `scripts/sandbox-check.ts` | `rules`, `sandbox-docker` |
| GitLab and the code-host interface | `scripts/gitlab-protocol-check.ts`, `scripts/gitlab-check.ts`, `scripts/codehost-check.ts` | `rules`, `gitlab` |
| Jira intake | `scripts/jira-check.ts` | `jira` |
| Slack intake | `scripts/slack-check.ts`, `server/src/slack/blocks.test.ts` | `slack` |

For example, run this installation-linking section from the repository root (`server/src/github/AGENTS.md`):

```sh
cd server && WLP_CHECK_SECTIONS=connect npx tsx ../scripts/github-check.ts
```

Use the area guides above for selectors; leave whole suites and image-backed checks to CI (`AGENTS.md`).
`scripts/AGENTS.md` explains selection; `docs/testing.md` lists check prerequisites.
After changing guides, run `node scripts/agents-docs-check.ts` from the repository root.
