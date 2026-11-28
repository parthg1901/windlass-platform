/**
 * `windlassai` (`npx @windlassai/cli`): connects what a user has on their own computer to Windlass.
 * `connect claude` hands over a Claude plan's setup token; `connect codex` signs in with ChatGPT through Windlass
 * here and hands over that sign-in, which the platform keeps and refreshes. `connect --machine` pairs this computer
 * as a machine through Docker. `connect claude --this-machine` keeps a Claude login on this computer's runner instead.
 */
import { parseArgs } from "node:util";
import { connectPlan, PLAN_SOURCES } from "./connect.ts";
import { chooseClaudeHere, connectClaudeHere } from "./local-login.ts";
import { connectMachine } from "./machine.ts";
import { CliError, platformOrigin } from "./platform.ts";
import { readStdin } from "./terminal.ts";
import { scrub } from "./token.ts";

const USAGE = `Usage: npx @windlassai/cli connect claude|codex|--machine [--platform <url>] [--no-browser] [--token-stdin]

  connect claude    Connect your Claude Pro or Max plan: approve in the browser, then
                    claude setup-token runs here and its token goes to your account.
  connect claude --this-machine
                    Keep a Claude login on this machine only, for its Claude Code: claude
                    setup-token runs here and its token goes to the Windlass runner on this
                    computer. It never leaves this machine. Pair the machine first.
  connect codex     Connect your ChatGPT plan: approve in the browser, then sign in with
                    ChatGPT through Windlass here; the platform keeps and refreshes that sign-in.
  connect --machine Pair this computer as a machine (needs Docker): approve in the browser,
                    then the runner starts here in the background. Its agents use the
                    plans and keys connected to your account. At the end it asks how Claude
                    Code on this machine pays.

  --platform <url>  The Windlass platform (default: WINDLASS_PLATFORM, else the hosted one).
  --no-browser      Print the approval page instead of opening it.
  --token-stdin     connect claude: read a setup token from standard input instead of running claude setup-token.
  --local-claude    connect --machine: keep a Claude login on this machine without asking.`;

async function main(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			platform: { type: "string" },
			"no-browser": { type: "boolean" },
			"token-stdin": { type: "boolean" },
			"this-machine": { type: "boolean" },
			"local-claude": { type: "boolean" },
			machine: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	const [command, target, ...rest] = positionals;
	if (values.help || command === undefined || command === "help") {
		console.log(USAGE);
		return command === undefined && !values.help ? 2 : 0;
	}
	if (command !== "connect" || rest.length) {
		console.error(USAGE);
		return 2;
	}
	if (values["local-claude"] && !values.machine) {
		console.error("--local-claude is for connect --machine. On a paired machine: connect claude --this-machine.");
		return 2;
	}
	if (values["this-machine"]) {
		if (target !== "claude" || values.machine || values.platform !== undefined) {
			console.error("--this-machine is for connect claude: it keeps a Claude login on this machine only.");
			return 2;
		}
		const token = values["token-stdin"] ? await readStdin() : undefined;
		await connectClaudeHere({ token });
		return 0;
	}
	const platform = platformOrigin(values.platform ?? process.env.WINDLASS_PLATFORM);
	if (values.machine) {
		if (target !== undefined || values["token-stdin"]) {
			console.error(USAGE);
			return 2;
		}
		await connectMachine({ platform, browser: !values["no-browser"] });
		await chooseClaudeHere(values["local-claude"] === true);
		return 0;
	}
	const source = target === undefined ? undefined : PLAN_SOURCES[target];
	if (!source) {
		console.error(USAGE);
		return 2;
	}
	if (values["token-stdin"] && source.provider !== "anthropic") {
		console.error("--token-stdin is for connect claude: a ChatGPT plan is a sign-in, made here through Windlass.");
		return 2;
	}
	const token = values["token-stdin"] ? await readStdin() : undefined;
	await connectPlan(source, { platform, token, browser: !values["no-browser"] });
	return 0;
}

main(process.argv.slice(2)).then(
	code => {
		process.exitCode = code;
	},
	error => {
		const known = error instanceof CliError || (error as { code?: unknown })?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION";
		console.error(scrub(known ? (error as Error).message : `Something went wrong: ${String(error)}`));
		process.exitCode = 1;
	},
);
