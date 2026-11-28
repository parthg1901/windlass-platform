# CLI

`@windlassai/cli` (bin `windlassai`) is what a user runs with npx on their own computer. It is bundled to one
file with no runtime dependencies by `./build.mjs` (the package bin). It stays private until the npm org exists.

## Quick commands

Run one command from the repository root.

- `cd cli && npx tsc --noEmit -p .` typechecks the CLI and the one server module it imports.
- `cd cli && node --test test/token.test.ts` checks reading the token off captured terminal output.
- `cd cli && node --test test/connect.test.ts` runs the whole flow against a stand-in platform and `claude`.
- `cd cli && node --test test/connect-machine.test.ts` runs `connect --machine` against a stand-in platform and `docker`.
- `cd cli && node --test test/connect-this-machine.test.ts` runs `connect claude --this-machine` and the end of `connect --machine` against a stand-in `claude` and `docker`.
- `cd cli && node --test test/connect-codex.test.ts` runs `connect codex` against the stand-in platform and a stand-in `windlass` and `npx`.
- `cd cli && node build.mjs` writes the bundle.

## Module map

- `./src/main.ts` parses the command line.
- `./src/machine.ts` runs `connect --machine`: checks Docker, pulls the runner image named in `/platform/info`, runs the runner's `setup --connect` (`setupRunArgs`) and opens the approve page for the pairing code it reports.
- `./src/local-login.ts` runs `connect claude --this-machine`: `claude setup-token` here, then the token on the standard input of `windlass-runner login claude --token-stdin` in the local runner's container; and the Claude question at the end of `connect --machine` (`chooseClaudeHere`).
- `./src/connect.ts` runs `connect <plan>`: start, browser approval, poll, then the plan's token or sign-in, hand-over (`PLAN_SOURCES`).
- `./src/windlass-login.ts` runs `windlass login` for `connect codex` with a private `XDG_DATA_HOME` and reads back the sign-in's files (`SIGN_IN_UPLOAD_FILES`).
- `./src/setup-token.ts` runs `claude setup-token` under `script` and keeps its output in memory.
- `./src/token.ts` reads the token off terminal output and scrubs secrets out of messages.
- `./src/platform.ts` resolves the platform address and posts JSON; `./src/terminal.ts` is the browser and prompts.
- `./test/stand-ins.ts` is the stand-in platform and the CLI run both flow tests share.

## Invariants

- The machine setup's container and Docker messages come from `server/src/contract/machine-setup.ts`, which `server/src/install-script.ts` renders too; keep it import-free. The CLI never holds a machine's key: the runner makes it inside the container.
- The wire (`CONNECT_PATHS`, `ConnectStart`, `validPlanToken`, `validSignInUpload`, the sign-in's file names and size limit, `SIGN_IN_WINDLASS_VERSION`) comes from `server/src/contract/connect.ts`; keep that module import-free.
- Never print, log or write the token or the sign-in's files. Every error goes through `scrub` in `./src/token.ts`.
- `--this-machine` sends nothing to the platform: the token goes only to the local runner, on standard input.
- Tests never reach real Docker or the network: stand-in `docker` and `claude` on PATH, stand-in platforms on 127.0.0.1.
- Windlass never sees this computer's own data directory or a WINDLASS_ variable, and its private directory is removed in every outcome.
- The server side is `server/src/connect-route.ts`; its checks are in `scripts/model-plans-check.ts`.
