# ChatGPT sign-in and sealing

This folder keeps a user's ChatGPT sign-in for Windlass and seals what actors store or pass about it.
The sign-in is the user's ChatGPT plan: the holder stores it in the plan's `model_plan` row (`server/src/credentials/plans.ts`),
and hosted Windlass and Codex pay with its access token as a plan where plans are on (`server/src/credentials/AGENTS.md`); a
paired machine pays with it through the plan relay there. No machine or sandbox is ever handed the access token itself.
The platform never reimplements OpenAI's sign-in: it lends the files Windlass saves to `windlass login ...` for one command at a time.
OpenAI's sign-in takes only a loopback callback, so the sign-in itself happens on the user's computer: the CLI's `connect codex`
(`cli/src/windlass-login.ts`) runs `windlass login` there and uploads the files to `server/src/connect-route.ts`, which seals them in transit to the user's actor;
the holder adopts them (`adoptMaterial` in `./holder.ts`) and refreshes them from then on, as OpenAI documents for a remote host.

## Quick commands

Run one command from the repository root.

- `cd server && WLP_CHECK_SECTIONS=seal npx tsx ../scripts/signin-check.ts` checks sealing purposes, subjects and key ids.
- `cd server && WLP_CHECK_SECTIONS=runner,holder npx tsx ../scripts/signin-check.ts` checks the private-directory runner against a stub and the holder's single refresh.

`scripts/signin-check.ts` sections are `seal`, `runner`, `holder`, `windlass`, `actors` and `cleanup`.
`WLP_CHECK_SECTIONS` matches comma-separated prefixes, and `cleanup` (the credential scan of captured output) always runs.
`windlass` and `actors` need a Windlass executable (`WLP_WINDLASS_BIN` or the one `sandbox/fetch-windlass.sh` pins) and skip without it; `actors` also starts its own server.
CI runs this check in the `actors` group of `scripts/ci-groups.json`.

## Module map

- `./material.ts` defines `SignInMaterial`: the text of the sign-in files listed in `MATERIAL_FILES` (shared with the CLI from `server/src/contract/connect.ts`), with size limits and account reading (the plan type among the ID token's claims included).
- `./runner.ts` is the seam to Windlass: `LocalLoginRunner` writes the material into a private `XDG_DATA_HOME`, runs one command and reads the files back.
- `./commands.ts` defines `WindlassSignIns`: the `token` and `models` steps over material, which store nothing.
- `./holder.ts` defines `SignInHolder`: one user's stored sign-in and the only place that asks for their access token. Its generation is new at each adopt or logout, never at a refresh.
- `./directory.ts` finds a user's holder: `ActorSignInDirectory` calls the `user` actor; `MemorySignInDirectory` is for checks only.
- `./facade.ts` implements `ChatgptLogins` and `AccessTokens` from `server/src/sandbox/api.ts` over a directory (`actorSignIns`, `memorySignIns`). Turns take the plan's token through `chatgptPlanToken`; the holder still refreshes it.
- `./index.ts` builds the per-process `SignIns` (`getSignIns`) from `WLP_WINDLASS_BIN`, `WLP_SIGNIN_RUNNER` and `WLP_SIGNIN_TMPDIR`.
- `./seal.ts` defines `Sealer` and `serverSealer`: AES-256-GCM blobs (`wlps1.`) bound to a `SealPurpose` and a subject.
- `./secret-rows.ts` re-seals stored secret rows under the current key before a session gets them.

Callers: [user sign-in](../actors/user/signin.ts) owns the holder, and `server/src/sandbox/logins.ts` is the Docker form of the runner for development. The platform [login actor](../actors/login.ts) seals its OAuth attempts with the `attempt` purpose.

## Key types

- `SealPurpose` (`./seal.ts`) is `user`, `attempt`, `transit`, `secret`, `model-key` or `model-plan`. Other modules seal repository secrets (`server/src/repo-secrets.ts`) and model keys with the same `Sealer`.
- `SignInMaterial` (`./material.ts`), `StoredSignIn` (`./holder.ts`) and `TokenAnswer` (`./commands.ts`) are the shapes passed between steps.
- `TOKEN_VALID_FOR_MS`, `NOT_SIGNED_IN` and `SignInRefreshError` live in `server/src/sandbox/handoff.ts`.

## Invariants and pitfalls

- Seal before anything crosses the Rivet engine. A blob opens only with the purpose and subject it was sealed with, so pass the same uid, attempt id or nonce on both sides.
- One refresh at a time per user holds only because the `user` actor hosts the holder. Never serve a deployment from `MemorySignInDirectory`.
- A refresh replaces the refresh token. The holder saves the new sign-in before handing out the token, and hands out nothing if the save failed.
- The refresh token never leaves the `user` actor: relays get access tokens only (`chatgptPlanToken` in `server/src/actors/user/signin.ts`), per request at the platform route, or at a turn's start and before expiry for a relay in a microVM.
- Never forward `WINDLASS_ACCESS_TOKEN_FILE` to Windlass.
- With `WLP_SANDBOX=fake`, no Windlass runs unless `WLP_SIGNIN_RUNNER` is set (`server/src/sandbox-fake.ts` answers instead).
- Catch `SealError` for a blob sealed by a different key or for another purpose. It means re-sign-in or skip the row, not a crash.

## See also

[Actors](../actors/AGENTS.md) own the stored blobs. [Sandbox](../sandbox/AGENTS.md) hands tokens to turns.
