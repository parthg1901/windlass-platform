import { PAY_WITH_HINT } from "../../../server/src/sandbox/harnesses.js";
import { HARNESS_NAMES, loginCommand, signInWords, type ReportedHarness } from "../lib/acp";
import { linkProps } from "../lib/router";
import { Command } from "./Command";
import { WarnIcon } from "./Icons";

/**
 * An agent's sign-in on its machine. In a picker (no `machineName`): its state in a few words (`signInWords`), with
 * the command that signs it in where it keeps logins of its own (OpenCode). On a session's page, in line with the
 * composer: nothing while it can run; a notice that it cannot run a turn only where nothing can pay ("none"); and
 * where the runner could not check ("unknown"), a quiet line, since the agent may well run. Claude Code and Codex pay
 * with the account's plans and keys (`paysWith`): their notice points to Connections, never to a login command.
 */
export function HarnessStatus({ harness, machineName }: { harness: ReportedHarness; machineName?: string }) {
	const name = HARNESS_NAMES[harness.id];
	const login = loginCommand(harness);
	const command = login ? <Command text={login} label={`The command that signs ${name} in`} /> : null;
	const connections = (
		<a className="link" {...linkProps({ name: "connections" })}>
			Open Connections
		</a>
	);
	if (!machineName)
		return (
			<div className="machine-harness">
				<span>
					{name}: {signInWords(harness)}
				</span>
				{command}
			</div>
		);
	if (harness.signIn === "token") return null;
	if (harness.signIn === "none")
		return (
			<div className="session-notice">
				<div className="callout callout-warn" role="status">
					<WarnIcon size={14} />
					<div>
						{command ? (
							<>
								<p className="callout-text">
									{name} is not signed in on “{machineName}”, so this agent cannot run a turn. Sign it in there:
								</p>
								{command}
							</>
						) : (
							<p className="callout-text">
								Nothing can pay for {name} on “{machineName}” yet, so this agent cannot run a turn. {PAY_WITH_HINT}{" "}
								{connections}
							</p>
						)}
					</div>
				</div>
			</div>
		);
	if (!command)
		return (
			<div className="session-notice">
				<p className="session-notice-quiet">
					Couldn't check what pays for {name} on “{machineName}”. If a turn fails to start, check Connections.
				</p>
			</div>
		);
	return (
		<div className="session-notice">
			<details className="session-notice-quiet">
				<summary>
					Couldn't check {name}'s sign-in on “{machineName}”. If a turn fails to start, sign in again:
				</summary>
				{command}
			</details>
		</div>
	);
}
