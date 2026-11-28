# Web client

Screens use one platform client for live actors and for the in-memory mock.

## Quick commands

Run one command from the repository root.

- `cd web && npx tsc --noEmit -p .` checks the UI and the server modules it imports.
- `cd web && pnpm test src/api/rivet.test.ts` selects the live adapter's tests.
- `cd web && pnpm test src/docs/docs.test.ts` selects documentation checks. Substitute the adjacent test file for other edits.

## Key files

- `./App.tsx` selects screens from the current route.
- `./api/client.ts` defines the actions and live feeds that screens consume.
- `./api/rivet.ts` adapts actor calls, connections and snapshots to that interface.
- `./api/mock.ts` implements the client used without a backend.
- `./docs/pages.ts` lists the user documentation in reading order.

## Folder map

- `./App.tsx` routes to a screen; `./main.tsx` mounts it.
- `./api/` is the platform client: `./api/client.ts` (the interface), `./api/rivet.ts` (live actors), `./api/mock.ts` with `./api/mock-items.ts`, `./api/mock-environments.ts` and `./api/mock-scenarios.ts` (the in-memory backend), `./api/errors.ts` (error codes and refusal wording).
- `./state/` holds app-wide state and hooks: `./state/app.tsx` (auth and client context), `./state/items.ts` (`useItems`), `./state/machines.ts` (`useMachines`), `./state/hooks.ts` (catalogs and other shared hooks), `./state/sessionStore.ts` (one session's live view).
- `./lib/` is pure logic with no React: formatting (`./lib/format.ts`), item labels (`./lib/items.ts`), the timeline reducer (`./lib/timeline.ts`), harness names and display order (`./lib/acp.ts`), models and modes (`./lib/models.ts`, `./lib/modes.ts`), placement and machines (`./lib/placement.ts`, `./lib/machines.ts`).
- `./components/` holds reusable pieces; `./components/ui/` holds primitives (`Button`, `Menu`, `Popover`, `Sheet`, `Failure`), exported from `./components/ui/index.ts`.
- `./screens/` holds one file per page plus its tests.
- `./docs/` renders the in-app user docs; `./site/` is the public landing site, built by `../site-build.ts`.
- `./styles/` has one CSS file per area, with tokens in `./styles/tokens.css`.

## Layering

- Screens import components, state and lib. Components import state and lib, never screens. lib imports neither.
- A hook or label two screens share goes in `./state/` or `./lib/`, not in the screen that wrote it first.
- Web imports some server modules directly (for example `../../server/src/sandbox/harnesses.ts`, `../../server/src/factory/resolve-run.ts`, `../../server/src/item-pages.ts`) so that both sides share one rule. Those files must stay browser-safe: no `node:` imports. The web typecheck runs them under stricter flags, so server can pass while web fails.
- Choose agent behaviour by the harness records' capabilities (`usesAccountModels`, `capabilitiesOf`), not by comparing a harness id.

## Naming pitfalls

"Plan" means four things: `./components/Plan.tsx` is billing, `./screens/Plans.tsx` the upgrade page, `./screens/FeaturePlan.tsx` the work plan, and the `Plan` block in `./components/Blocks.tsx` the agent's plan.
`Block` is both the timeline type in `./lib/timeline.ts` and a component in `./components/ReviewBlocks.tsx`.

## Non-obvious patterns

- Change the client interface and both adapters together when adding an action. [Contract](../../server/src/contract.ts) supplies the shared shapes.
- Rebuild a feed from a fresh snapshot after reconnect. Events broadcast during the disconnect are lost.
- Add behaviour pages under [docs content](./docs/content/) and register them in the page list so the UI can find them.
- What pays for each agent lives on the Connections page (`./screens/Connections.tsx`): its grid's cells come from `./lib/connections.ts`, which follows the server's `hostedPayer`; the plan rows, API keys, Pay-with choices (`server/src/pay-with.ts`) are there; a machine's cell shows what pays there (Pay with decides on machines too). A machine's Claude Code cell (`ownLogin`) also offers the login kept on that machine only (`connect claude --this-machine`) and "Switch back to your plan" (`removeMachineClaudeLogin`). Settings keeps only model defaults. Link to one cell with `cellId` as the fragment (`/connections#claude-hosted`).
- The first-run setup on Home (`./components/Onboarding.tsx`) opens by the rule in `./lib/onboarding.ts` and keeps its step in `localStorage`. The mock's `fresh` option (the address's fresh=1) is a new account that opens it.
- The connect page (`./screens/Connect.tsx`), opened by the CLI with the code in its query, is the one page that brings a signed-out visitor back after sign-in (`returnAfterSignIn` in `./lib/router.ts`).

## See also

[Web image check](../../scripts/web-stage-check.ts) checks which imported files the Docker build copies. [Actors](../../server/src/actors/AGENTS.md) own the live data.
