# Work-item factory

The blueprint decides the next step for an item or feature from observed facts. Everything here is pure:
no actor, network or clock reads. The [work-item actor](../actors/work-item.ts) stores each decision and performs its effects.

## Quick commands

Run one command from the repository root.

- `cd server && npx tsx ../scripts/factory-check.ts` exercises the step transitions.
- `cd server && npx tsx ../scripts/orchestrator-check.ts` exercises feature planning and subtasks.
- `cd server && FACTORY_ONLY=memory npx tsx ../scripts/factory-e2e.ts` covers the in-memory actor cases.
- `cd server && npx tsx ../scripts/review-check.ts` checks the review report boundary; `cd server && npx tsx ../scripts/reviewer-task-check.ts` checks the reviewer brief.
- `cd server && npx tsx ../scripts/verified-check.ts`, `cd server && npx tsx ../scripts/untrusted-check.ts` and `cd server && npx tsx ../scripts/readiness-check.ts` cover the check run, untrusted sources and readiness.

`scripts/factory-e2e.ts` matches `FACTORY_ONLY` as comma-separated section-name prefixes. `scripts/factory-check.ts` only
knows `FACTORY_ONLY=hosted-size`, which stops after the hosted-size cases.

## Module map

Decision core, in import order (each file imports only those before it):
`change` ← `ci-reading` ← `feature-flow` ← `review-flow` ← `ci-flow` ← `blueprint`.

- `./blueprint.ts` holds `advance(item, fact)`, the private `apply` dispatch over `Fact` kinds, `createItem`, questions and `takeChoice`.
- `./change.ts` holds the `Change` class a fact mutates and the shared steps: `ask`, `nextTurn`, `stop`, feedback and budgets. `ask` reaches `takeChoice` through the `Change` instance, so keep new shared helpers here, low in the order.
- `./ci-reading.ts` holds CI progress, reruns and repair turns shared by items and features.
- `./feature-flow.ts` dispatches a feature's parts, follows the feature branch's CI and approves the plan.
- `./review-flow.ts` runs the second agent's review, its fixes, the handoff verdict and pull request reads.
- `./ci-flow.ts` publishes the branch and decides what an item's CI reading means.

Types and inputs:

- `./types.ts` defines `FactoryItem`, `Fact`, `Effect`, `Outcome`, `Question`, `Run` and gate evidence; it re-exports item types from `server/src/contract.ts`.
- `./answered.ts` maps `ChoiceId` to button labels and words a logged answer.
- `./intake.ts` turns GitHub and Linear issues into item input and bindings, with the refusal sentences.
- `./resolve-run.ts` resolves the agent, model, size and place for each `RunRole` (builder, planner, part, reviewer and so on).
- `./default-place.ts` picks a saved place and checks machines for room and allowed profiles.
- `./placement.ts` turns a planner's named places into destinations from the owner's inventory.

Limits and judgement:

- `./budget.ts` tracks an item's budget and returns a `Wait` when a turn may not start yet. It never refuses. The budget is dollars of work (`usd`): every turn at API prices whoever pays (`turnUsd`, priced at its end), a plan's turns at what the same tokens would cost on a key. A plan's windows are account-wide, so they never measure an item. Tokens hold only while a turn could not be priced (`usdUnknown`, `budgetUnits`). A part's dollars follow its planned tokens (`partShare`). A turn is also stopped at its budget while it runs: `nextTurn` in `./change.ts` puts `turnBudget` (what is left plus `TURN_BUDGET_GRACE`) on the `deliver` effect, the session prices the running spend (`server/src/actors/agent-session/budget-watch.ts`, `crossedStop`) and stops the turn there, and its `budgetStopped` ended fact asks the budget question through `budgetStopped` in `./change.ts`.
- `./cost.ts` records what each turn used (model, payer, tokens, hosted size and seconds) in the item's spend (`usage`) and prices it with `CostRates` (`server/src/model-prices.ts`) by who carried it (its `payers`: plans' turns at their API-price value, keys' at their cost) and its hosted time as billing split it (the usage's `hosted`, from `hostedSplit` in `server/src/usage.ts`: included in the plan or extra), or, with billing off, estimated at the rate card. `extraUsd` is what the item added to the person's bills. An unpriced part is unknown, never guessed.
- `./usage-summary.ts` holds the Usage summary: an item's type from its changed paths (`workType`, stored by the work item when a turn with changes ends), its size from its parts, the ended items of a period (`finishedItems`), and their median and p90 cost and time, priced in the browser (`summarize`). Retry spend is what `chargeTurn` puts in the spend's `retryUsage`: turns of a run begun by `retryRun` and of a `ci_fix` step.
- `./autonomy.ts` holds required CI branches, the small-plan limit, the plan critic and the merge decision.
- `./feature-plan.ts` validates the planner's subtasks and dependencies. It stays free of Node modules because the web mock imports it; child and session ids live in `./feature-ids.ts` (uses `node:crypto`).
- `./cross-repo.ts` adds cross-repo features (`WLP_FACTORY_CROSS_REPO=1`) as pure helpers that the blueprint calls at a few points.
- `./check-environment.ts` recognises a check that failed because the sandbox could not run it, so the gate asks the person instead of the agent.
- `./base-tests.ts` reproduces CI-reported test ids on a copy of the base commit with fixed runner commands.
- `./feedback.ts` cleans, fingerprints and batches GitHub feedback, with quiet and maximum wait times.
- `./verdict.ts` builds the verdict from the gate's record, CI and the reviewer, never the agent's words.
- `./verified-check.ts` writes the windlass/verified check run title, conclusion and summary.

Review and readiness:

- `./review.ts` is the report tool's trust boundary: findings are strings, facts and links come from platform records.
- `./reviewer-task.ts` builds the reviewer's per-turn brief from already-redacted input.
- `./untrusted.ts` names the sources of text the platform hands an agent without vouching for it.
- `./attachments.ts` checks screenshot requests, PNG headers and attachment keys.
- `./readiness.ts`, `./readiness-track.ts` and `./readiness-filing.ts` define the readiness criteria, the track record levels and the setup turn's judgement tool.

## Invariants

- Change decisions in `advance`. Return effects for I/O, then feed the observed result back as a fact. `advance` clones the item and bumps `revision` on every accepted fact.
- Preserve the effect key on retry. The work-item actor commits the decision before performing it and can replay after waking.
- A final item ignores facts except child notices, joins, feature updates and turn receipts; see the guard at the top of `advance`.
- When adding third-party issue text, another author's feedback or CI logs to a prompt, carry its sources through delivery so the harness can apply the trust rules.

## Pitfalls

- The web imports `budget`, `cost`, `usage-summary`, `default-place`, `feature-plan`, `placement`, `readiness`, `readiness-track`, `resolve-run`, `answered`, `types` and `verdict`. Keep their runtime imports browser-safe and run the web typecheck too.
- Do not import a later flow module from an earlier one; the order above avoids cycles.
- Never decide by harness id. Use the capability flags on records in `server/src/sandbox/harnesses.ts`.

## See also

[Factory behaviour](../../../web/src/docs/content/factory.md) describes the user's view.
