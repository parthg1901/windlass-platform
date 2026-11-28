# @windlassai/cli

Connects what you have on your own computer to Windlass: your Claude Pro or Max plan, your ChatGPT plan, and the
computer itself as a machine your agents run on.

```sh
npx @windlassai/cli connect claude
npx @windlassai/cli connect codex
npx @windlassai/cli connect --machine
npx @windlassai/cli connect claude --this-machine
```

## connect claude

1. The command shows a code like `KQ2M-8XF4` and opens the platform's connect page in your browser.
2. Sign in there if needed, check that the page shows the same code, and choose **Approve**.
3. The command then runs `claude setup-token` (through `npx @anthropic-ai/claude-code` when Claude Code is not
   installed). Sign in to Claude when it asks. The command reads the token off that screen and hands it to
   your account, which checks it with Anthropic and keeps it encrypted.

The CLI never prints, logs or saves the token. If it cannot read the token from the screen, it asks you to paste
it (hidden). To pass a token you already have: `npx @windlassai/cli connect claude --token-stdin < token.txt`.

## connect codex

1. As above: the command shows a code, and you approve it on the connect page.
2. The command then runs Windlass's own ChatGPT sign-in on your computer (`npx windlass-agent@0.7.1 login`,
   or your installed `windlass` when it is 0.7.x and at least that version). It opens your browser; approve
   there. Without a browser, it prints the link and you paste the address the browser ends on back into the
   terminal.
3. The command hands the files that sign-in saved to your account. The platform keeps them encrypted and
   refreshes the sign-in itself from then on.

Windlass signs in with a private data directory, so your own Windlass sign-in on that computer is neither read
nor changed. The directory is removed afterwards, whether the sign-in worked or not, and the CLI never prints or
saves the sign-in.

## connect --machine

Needs Docker. Run it on the computer you want your agents to run on.

1. The command checks that Docker is installed, running and yours to use, and says what to do when it is not.
2. It fetches the platform's runner image and starts the runner's setup in a one-off container, the same
   container as the platform's `install.sh`. The runner makes the machine's key, which stays in Docker's
   `windlass-runner` volume on this computer.
3. The command shows a pairing code and a machine key, and opens the connect page. Check that the page shows
   the same code and key, and choose **Approve**. **Deny** stops it and connects nothing.
4. The runner then starts in the background with the defaults: every agent in the image offered, both Docker
   profiles, restricted network access and limits sized for this computer. No agent signs in here: the
   machine's agents use the plans and keys connected to your account.

5. Last, it asks how Claude Code on this machine pays: your Claude plan from Windlass (recommended, and what
   Enter picks), or a login kept on this machine only (see `connect claude --this-machine` below).
   `--local-claude` picks the second without asking; with no terminal to ask at, it is the plan.

The machine is named after this computer. To change its settings later, run the runner's `setup` (see the
platform's Use your own machine docs). On a machine that is already paired, the command keeps the pairing: it
changes nothing while the runner is running, and otherwise starts it with its saved settings.

## connect claude --this-machine

Keeps a Claude login on this computer only, for the Claude Code of the machine paired here. Pair it first with
`connect --machine`; without a running Windlass runner the command says so and does nothing.

1. The command runs `claude setup-token` here, as `connect claude` does. Sign in to Claude when it asks.
2. It hands the token to the Windlass runner on this computer (`docker exec -i windlass-runner windlass-runner login
   claude --token-stdin`), which keeps it in its Claude login volume. The token goes on that command's standard
   input only. It is never printed, never on a command line and never sent to Windlass.

The runner reports the login itself; Connections then shows "This machine's own login · stays on this machine" for
that machine's Claude Code. **Switch back to your plan** there removes it again. `--token-stdin` works here too.

## Options

- `--platform <url>` or `WINDLASS_PLATFORM`: a self-hosted platform (default `https://usewindlass.com`).
- `--no-browser`: print the connect page's address instead of opening it (for `--machine` too).
- `--token-stdin` (`connect claude` only): read the setup token from standard input instead of running `claude setup-token`.
- `--this-machine` (`connect claude` only): keep the login on this computer's runner instead of connecting the plan to your account.
- `--local-claude` (`connect --machine` only): keep a Claude login on this machine without asking.

Needs Node.js 18 or later. On Linux and macOS, `claude setup-token` runs under `script`, a pseudo-terminal, so
the token can be read from its output; elsewhere you paste it. Claude Code's screens show as usual, but the
token itself is never shown: once it starts, the rest of the output is held and printed with the token removed.
