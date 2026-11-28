# Credentials

What pays for a user's model requests, kept sealed in the user's actor. A turn pins a `CredentialRef`
(`server/src/contract/account.ts`): a saved Settings key, or with `plan` a connected subscription plan.
A key never reaches a sandbox: the platform model relay opens the secret for one request (docs/model-relay.md).
On E2B and Daytona a plan's token is opened at the turn's start and handed on stdin to a relay inside the sandbox
that runs as another user than the agent's (`openSavedCredential` in `./transit.ts`, `server/src/sandbox/plan-relay.ts`),
and on a paired machine to the same relay in a container on the machine (`openPlan` in `server/src/sandbox/model-relay.ts`);
an expiring one (a ChatGPT plan's) is handed again before it runs out, and a plan gone or turned off closes the relay
within a minute (`rotatePlanToken` in `server/src/sandbox/token-file.ts`).

Plans, one `model_plan` row each:

- `anthropic`, the Claude plan: the token `claude setup-token` prints, sealed here. Claude Code pays with it, hosted and on machines.
- `openai`, the ChatGPT plan: the user's ChatGPT sign-in. Hosted, Windlass's unqualified models and Codex pay with it
  as a pinned plan (`turnCredential` in `server/src/actors/agent-session.ts`) where `WLP_PLAN_USERS` allows; on a
  paired machine it pays ungated (`planAllowed`), through the plan relay on the machine. Its `sealed` and `short_noted` columns belong to
  the user actor's `SignInHolder` (`server/src/signin/holder.ts`), which alone opens it, refreshes it one at a time
  and keeps the refresh token. It is connected with the CLI's `connect codex` (`cli/`): Windlass signs in on the
  user's computer and the command uploads its files (`SignInUpload`), which the holder adopts under a new generation. A relay asks for its current access token (the `token` of a `ChatgptPlan`, `./index.ts`).
  Hosted Windlass follows Pay with's "When limited" on it (`planPays` in `server/src/pay-with.ts`): an item waits, a person
  is asked, and the key runs the OpenAI key's version of the model for one turn. Windlass's limits, wherever it runs, are the
  plan's (`accountLocation` in `server/src/actors/provider-accounts.ts`).

## Quick commands

Run one command from the repository root.

- `cd server && npx tsx --test ../scripts/model-plans-check.ts` checks plan connect, refusal, sealing, generations, `WLP_PLAN_USERS`, the ChatGPT plan (its token per request, connecting it with an uploaded sign-in, the `signin` table's copy, hosted Windlass pinning it), plan models and names, and the connect request lifecycle.
- `cd server && npx tsx --test --test-name-pattern="keep keys sealed" ../scripts/model-providers-check.ts` checks Settings keys.

## Module map

- `./index.ts` holds `CREDENTIAL_TABLES` and `credentialActions`: plan actions for the web and the internal lookups the relay and turns use (`internalCredential`, `internalCredentialGeneration`, `internalPlanModels`). The ChatGPT plan comes in as a `ChatgptPlan` from `server/src/actors/user/signin.ts`.
- `./keys.ts` stores Settings keys (`model_provider`), checks them by listing the provider's models, and serves their status.
- `./plans.ts` stores connected plans (`model_plan`): a Claude plan checked against Anthropic's profile endpoint, the ChatGPT plan's row as the holder writes it (`writeChatgptSignIn`), each plan's models (ChatGPT's catalog, or what Claude Code reported at a plan-paid session's start), and the one-time copy of the old `signin` table (`moveSignInToPlan`).
- `./plan-health.ts` reads what the relays and turns saw of a plan (Anthropic's unified limit headers, Codex's headers, ChatGPT's 429 codes, provider 401s) into its health: `ok`, `limited` until a reset or a backoff probe, or `invalid` after two 401s in a row, with its 5-hour and weekly windows. `observePlan` in `./plans.ts` keeps it on the plan's row at the generation it was for (docs/model-relay.md, "Plan health").
- `./plan-labels.ts` turns a provider's tier name into the plan's label ("a@b.com · Plus"); an unknown one is shown title-cased.
- `./connect-code.ts` makes a connect request's two secrets: the user code the terminal shows and the page approves, and the request secret only the terminal holds. `server/src/actors/connect-codes.ts` keeps their digests and each request's state; `server/src/connect-route.ts` serves the command (`cli/`).
- `./transit.ts` seals a secret for one relay request, bound to user, credential and request nonce, for a minute; `openSavedCredential` opens it at a pinned generation.

Which of a plan and a key pays (Connections → Pay with) is kept outside this folder, in `server/src/pay-with.ts`
(`decidePayer`, the rule with the plan's health, the parallel-turn cap and the filer guardrail) and applied at a turn's
start by `server/src/actors/user-payer.ts`.

## Invariants and pitfalls

- Seal before anything crosses the Rivet engine: a token is sealed under `transit` between the connect route and the actor, and under `model-plan` at rest.
- A new connect replaces the generation, so every lease of the old token on the platform's relay ends at its next request, and a relay in a sandbox or on a machine within a minute. A refresh of the ChatGPT plan never changes it.
- `savedPlan` answers only a plan whose last check passed, except for `claudePlanCheck`, which asks Anthropic again with the stored token whatever it said last, so a plan can recover.
- `WLP_PLAN_USERS` unset turns plans off at once: no Claude plan requests, approving or connect, and `savedPlan`/`planGeneration` answer null. Any signed-in (non-demo) user may still connect the ChatGPT sign-in with the command, for Windlass on their machines; paying for any hosted turn with it (Windlass's ChatGPT models, Codex) is gated, and a user left out gets `CHATGPT_PLAN_OFF` ("Your ChatGPT plan isn't enabled for hosted runs on this account").
- The ChatGPT plan's generation is the sign-in's: Windlass's ChatGPT model list (`server/src/account-models.ts`) is keyed by it, and a plan-paid Windlass turn's tokens count against the daily ChatGPT allowance, not as a key's (`usesPlatformModel`).
- Approving names the plan (`approvePlanConnect(code, provider)`, from the page's `plan`): a code for another plan approves nothing. An upload that is not a finished sign-in (`uploadedSignIn`), or a handover for the other plan, is refused before the request is taken; one the provider could not be asked about (`plan_check_unavailable`) puts it back (`internalUntake`), and the command hands it over again.
- Connect requests wait three minutes for approval (`CONNECT_PENDING_TTL_MS`) and ten once approved; at the bound (`LIVE_REQUESTS`) a new one pushes out the oldest unapproved one.
- A plan's models are never hard-coded: without a report a plan offers only the agent's default.
- A connect request is taken once, and only after its user approved it (`approvePlanConnect`). A wrong code counts against the user who typed it, so a signed-in stranger cannot guess a live code and receive someone else's token.
- A plan's limits are its own account, never the key's of the same provider; its health is reset when it is connected again.
- Answers from the provider can echo the token. Read only the fields you need, and never log a body.
