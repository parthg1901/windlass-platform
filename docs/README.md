# Developer and operator docs

These files are for people who run, self-host or work on Windlass Platform. People who use the product
read the user docs instead: they live in [`web/src/docs/content/`](../web/src/docs/content/) and are served
at `/docs`, for example at <https://usewindlass.com/docs>.

| File | What it covers |
|---|---|
| [architecture.md](architecture.md) | The actors and how a turn runs; a message sent twice; sleep, shutdown and idle sandboxes; ChatGPT sign-ins and access tokens; the users' models; the sandbox profiles; the copy of the agent's memory; how sandbox time is counted |
| [github-and-repositories.md](github-and-repositories.md) | The GitHub connection, its tokens and the agent's publish tools; a repository's setup command, checks, secrets and MCP servers; the "What was verified" section of a pull request; the repository page; account settings |
| [work-items.md](work-items.md) | The Factory: how a work item runs, verdicts, waits and budgets, feature orchestration, the second review, the items API and screenshots |
| [machines.md](machines.md) | Users' own machines: pairing, what the runner does and cannot do, the link and its failures, Claude Code, OpenCode and their credential relays, building the runner |
| [model-relay.md](model-relay.md) | Windlass's model relay: where it runs on each provider, the placeholder, refresh, limits, the rollout and why it fails closed |
| [operating.md](operating.md) | Running a deployment: several servers on one engine, Rivet Cloud, public HTTP rate limits, E2B, registering the GitHub App, the bucket |
| [billing.md](billing.md) | Plans and billing: Free and Pro, hosted minutes, the spend cap, grace and downgrade; turning on Dodo Payments (what to create in its dashboard, the webhook, the env) |
| [configuration.md](configuration.md) | Every environment variable, grouped, with defaults and how bad values are reported |
| [development.md](development.md) | Running from a checkout, the repository layout, every check, and the public pages' build |
| [known-limitations.md](known-limitations.md) | What the platform does not do, or does only in part, and why |

The Docker Compose kit for one Linux host has its own guide: [`deploy/selfhost/README.md`](../deploy/selfhost/README.md).
How to contribute is in [CONTRIBUTING.md](../CONTRIBUTING.md), and how to report a vulnerability in
[SECURITY.md](../SECURITY.md).

## Where a new fact goes

- Something a user sees or does: the user docs page for it, in `web/src/docs/content/`.
- How it works, how to run it, or a setting: the file above that covers it. Add a section rather than a new
  file, and a variable to [configuration.md](configuration.md) as well.
- The top-level README stays short: what the project is, how to try it, and links here.
