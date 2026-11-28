# RivetKit actors

Actors own durable state for users, sessions and work items. Follow the actor that owns the write.

## Quick commands

Run one command from the repository root.

- `cd server && npx tsx ../scripts/timeline-write-check.ts` checks session timeline writes.
- `cd server && npx tsx ../scripts/idempotency-check.ts` checks retried requests.
- `cd server && WLP_CHECK_SECTIONS=seal npx tsx ../scripts/signin-check.ts` checks sealing.

## Key files

- `./user.ts` owns account state and the actions that create sessions and items. [Sign-in](./user/signin.ts) and [usage](./user/usage.ts) own their account operations.
- `./agent-session.ts` owns the live turn, its SQLite timeline and client snapshots. Its [session modules](./agent-session/timeline.ts) share the write queue and own timeline, questions, runner binding, summary and workspace recovery.
- `./work-item.ts` commits blueprint outcomes, performs queued effects and schedules retries.
- `./internal.ts` defines actor-to-actor calls and the service credentials they use.

## Module map

[Registry](../registry.ts) lists every actor. Files that define no actor are helpers that run inside another actor.

Actors and their keys:

- `./user.ts` user[uid]: account, session index, turn admission, GitHub, Linear, Jira and Slack connections.
- `./agent-session.ts` agentSession[uid, sessionId]: one sandbox and its turns.
- `./work-item.ts` workItem[uid, itemId]: blueprint facts and the durable effect outbox.
- `./machine.ts` machine[uid, machineId]: a paired runner's control socket, its report and the turn-slot FIFO.
- `./machine-pairing.ts` `pairingDirectory` and `machinePairing`: pairing codes, rate-limited start buckets and the claimed machine.
- `./login.ts` `login`: one short-lived OAuth or demo login attempt.
- `./account-identities.ts` `accountIdentities`: maps a provider identity to a uid and holds the login budget.
- `./github-inbox.ts` githubInbox[installationId] and githubHooks["app"]: admits and queues GitHub deliveries.
- `./github-account.ts` githubAccount[githubUserId]: the GitHub user to uid link, service actions only.
- `./github-repository.ts` githubRepository[repositoryId]: per-repository state, platform service credential only.
- `./linear-workspace.ts` linearWorkspace[workspaceId]: which user a workspace's team files for.
- `./user-gitlab.ts` userGitlab[uid]: the sealed GitLab grant, pending OAuth states and the selected project with its hook secret.
- `./gitlab-inbox.ts` gitlabInbox[uid, projectId]: stores authenticated GitLab deliveries and nudges the items they name.
- `./jira-site.ts` jiraSite[siteId]: project claims, delivery receipts and the one active filing per Jira issue.
- `./slack-workspace.ts` slackWorkspace[teamId]: the bot token, channel mappings and item threads.
- `./surface-accounts.ts` surfaceAccounts[surface, tenant]: which Windlass user each Slack, Linear, Jira or GitLab person linked, and Slack's one-time link codes.

Helpers inside the `user` actor:

- `./user/state.ts` reloads the account indexes from SQLite on wake.
- `./user/signin.ts` holds the shared harness sign-in, persisting a refreshed credential before sealing a token for the caller.
- `./user/usage.ts` reserves sandbox time and kept places in an in-memory book, then persists and broadcasts.
- `./user/kept-sandboxes.ts` decides when idle item sandboxes are released to make room.
- `./user-items.ts` owns the work-item index, the turn queue and API tokens.
- `./user-machines.ts` owns the machine index, machine limits and per-machine credential choices.
- `./user-environments.ts` runs prepared-environment builds through an `EnvironmentHost` handed in by `user`.
- `./user-readiness.ts` schedules repository setup scans (cron `internalReadinessTick`) and caches their inputs.
- `./user-github.ts` replaces the GitHub connection and retries webhook sync on `GITHUB_SYNC` delays.
- `./user-linear.ts` stores the Linear connection and team mappings and decides each verified delivery.
- `./user-jira.ts` stores the Jira grant, site and project mappings, renews webhooks and writes item comments back.
- `./user-slack.ts` holds the Slack settings actions.
- `./user-identity.ts` holds the linked-account settings actions (`linkAccountStart`, `linkAccount`, `linkOffer`, `unlinkAccount`) and the index of where this user is linked. Each surface's read-only sign-in lives with its connection: `beginSlackLink`, `beginLinearLink`, `beginJiraLink`, and `userGitlab`'s `internalLinkStart`.
- `./issue-intake.ts` is what the intakes share: `resolveFiler`, the user's queue, daily cap and filing (`fileTrackerIssue` for Linear and Jira, `fileGitlabIssue`, `fileSlackRequest`). `./github-intake.ts` is GitHub's side.
- `./gitlab-item.ts` resolves a work item's GitLab host, token and pipelines for `work-item` and `agentSession`.
- `./github-item.ts` applies issue edits and closes to filed items.
- `./provider-accounts.ts` tracks model-provider usage and refusals per account location.
- `./continue-session.ts` holds `continueSession`'s settings for the new session and the copy of the agent's session in the backup store.

Helpers inside `agentSession` (`./agent-session/`):

- `./agent-session/state.ts` defines `SessionMeta`, `ActiveTurn`, `HeldSecrets`, `SessionVars` and the `Ctx` every module takes.
- `./agent-session/common.ts` holds `TurnProblem`, `ReviewRefused`, `takeSandbox`, `busy`, `within` and other shared helpers.
- `./agent-session/turn.ts` holds the phases of one turn (`startTurn`, `openTurnSandbox`, `choosePrompt`, `runAcpAgent`/`runWindlassAgent`, `closeTurn`, `settleAfterTurn`); `executeTurn` in `./agent-session.ts` calls them in order. Phases share locals through `TurnScope` and reach back into the main file only through `TurnHooks`.
- `./agent-session/timeline.ts` owns `serial`, `writeMeta` and batched timeline inserts.
- `./agent-session/questions.ts` asks and recalls turn questions and server approvals.
- `./agent-session/publish.ts` handles the panel's publish, pull request state and the agent's push and fetch requests.
- `./agent-session/meter.ts` meters sandbox time, holds, idle suspension and removal.
- `./agent-session/pause.ts` pauses a resumable turn, runs its heartbeat and checks resumption.
- `./agent-session/sandbox.ts` opens the sandbox, reads its workspace and tracks its state.
- `./agent-session/setup.ts` clones the repository, runs setup and builds the environment.
- `./agent-session/secrets.ts` opens sealed secrets for the turn and builds the redactor.
- `./agent-session/runner.ts` links the session to its machine's runner.
- `./agent-session/summary.ts` builds `SessionSummary` and pushes it to `user`, collapsing bursts.
- `./agent-session/workspace.ts` saves, restores and removes workspace backups and one-shot platform notes.
- `./agent-session/continuation.ts` is a session's side of "Continue in a new PR": what it hands over (`forkSource`), what the new one starts with and its one-time note.
- `./session-inbox.ts` owns the session's inbox and outbox tables: deliveries from the item, facts and releases back.
- `./turn-resume.ts` is pure: what a paused turn stores and what the agent is told on resume.
- `./acp-item.ts` bounds ACP timeline items to `ACP_ITEM_LIMIT`.

## Key types

- `ActorClient` in `./internal.ts` is the deliberately untyped `c.client()`; typing it would make the registry circular. Use it, never a bare `any`.
- `SessionInternal`, `ItemInternal`, `UserInternal` and `SessionCreateInput` in `./internal.ts` type the cross-actor calls; reach actors through `sessionActor`, `itemActor`, `userActor`, `secretsActor` and `modelKeyActor`.
- `ItemCreateInput` is in `./work-item.ts`; `Delivery`, `TurnRequest` and `TurnRelease` in `./session-inbox.ts`; `Fact` in `server/src/factory/types.ts`.

## Non-obvious patterns

- Session actions interleave at every await. Assign sequence numbers synchronously and send writes through the session's serial queue.
- Pass repository secrets sealed between actors. Open them for the active turn, redact its outputs and keep plaintext out of metadata and timelines.
- Use the internal helpers for cross-actor calls. Check the service token's purpose in the receiving action before reading or writing state.
- Create `agentSession` and `workItem` only through `createSessionActor` and `createItemActor`. They attach a grant that `grantIsValid` checks on create; an actor created without one destroys itself or ignores the input.
- `createItemActor` treats a duplicate key as the earlier attempt's actor (`isDuplicateKey`), so item ids derived from a key are retry-safe.
- Call `takeSandbox` before the first await of any sandbox operation and release it after. Idle suspension in `./agent-session/meter.ts` skips while `busy`.
- `./work-item.ts` commits the revision, events and keyed effects together before any I/O. On wake it retries pending effects under the same keys.
- Throw `UserError` from `rivetkit` with a stable `code` for messages a client may show. Map domain errors such as `GithubProblem` to it at the action edge, as `./user.ts` does.

- An item filed from another surface belongs to the person who triggered it. Every intake asks `resolveFiler` (`./issue-intake.ts`) for that person's linked uid and files there; an unlinked person files nothing. The mapping owner's actor only reads the issue and writes back to it (`./work-item.ts` routes Linear and Jira writes to the current mapper).
- A link comes from a sign-in at the surface (or from connecting it), returning a `#link-return=` ticket sealed for the uid that began it, which the web app redeems at once. Slack's private one-time link is not bound to a uid, so the web app names it (`linkOffer`) and waits for a confirm before `linkAccount`.

## Pitfalls

- `./agent-session.ts`, `./user.ts` and `./work-item.ts` are each over 2,500 lines. Search for the action name rather than reading top to bottom, and put new session logic in an `./agent-session/` module.
- A module in `./agent-session/` must not import `./agent-session.ts`; share through `./agent-session/state.ts` and `./agent-session/common.ts`.
- Do not cache the GitHub connection in a session. `githubConnection` asks `user` each time so a removed connection stops working at once.

## See also

[Registry](../registry.ts) wires the actors. [Factory](../factory/AGENTS.md) owns the decisions a work item applies.
