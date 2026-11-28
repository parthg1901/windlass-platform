/**
 * A repository's setup command: what it is saved for, what may be saved, how much of its output is
 * kept, and what the agent is told when it did not finish.
 *
 * On a deployment where Windlass sandboxes the agent's commands, a command has no network unless the
 * user approves it and writes only in the workspace, in /tmp and in a home of the session's own, so
 * installing a project's dependencies inside a turn means questions. A setup command is run by the
 * platform instead: once in each new sandbox of a session, after the repository is cloned and before
 * the agent's first turn there, outside that command sandbox and with the sandbox's network. The agent
 * then starts with the dependencies in place, and its own commands stay sandboxed.
 *
 * Whose it is. The user's, saved in their `user` actor, one row per repository, which every session
 * of that user reaches from whichever server it runs on. It is never read from the repository: it runs
 * with the network and outside Windlass's sandbox, so a command taken from a repository's content
 * would let a repository run code unasked, which is what the question about a project's MCP server is
 * there to prevent (server-question.ts). `setupProjectOf` is the one place that says what a command
 * is saved for, and it takes nothing but the repository's identity.
 *
 * Which repositories. Those of the user's GitHub connection, by GitHub's id (a rename keeps it), as
 * the approvals of MCP servers name them (server-approvals.ts). A session on a pasted address or with
 * no repository has no setup.
 *
 * This file has no actor and no sandbox in it: the `user` actor stores the rows, the session actor
 * runs the command (sandbox/setup.ts) and keeps its timeline, and scripts/setup-check.ts runs the same
 * rules on their own.
 */

import { readRepoKey } from "./codehost/ref.js";
import { type GithubId, MAX_SETUP_COMMAND_CHARS, SETUP_OUTPUT_CHARS } from "./contract.js";

/** How many repositories one user may have a setup command for; the ones saved longest ago go first. */
export const MAX_SETUP_COMMANDS = 500;
/** How much of a run's output the agent is told of when it did not succeed. */
const NOTE_LINES = 20;
const NOTE_CHARS = 2_000;

// ---------------------------------------------------------------------------------------------
// What it is saved for
// ---------------------------------------------------------------------------------------------

/** What a setup command is saved for: `key` names it in the user's actor, `label` is how a sentence names it. */
export interface SetupProject {
	key: string;
	label: string;
}

/** The key of a repository (`repoKey`), from the key or from GitHub's id for it. Null for anything else. */
export function setupProjectKey(repositoryId: unknown): string | null {
	return readRepoKey(repositoryId);
}

/**
 * What a session's setup command is saved for: the repository of the user's GitHub connection it was
 * launched on. Null for a session on a pasted address or with no repository: it has no setup. The
 * session's files have no say in it.
 */
export function setupProjectOf(session: {
	repo?: { provider?: "github" | "gitlab"; id: GithubId; owner: string; name: string } | null;
}): SetupProject | null {
	const repo = session.repo;
	if (!repo || repo.provider === "gitlab") return null;
	const key = setupProjectKey(repo.id);
	return key === null ? null : { key, label: `${repo.owner}/${repo.name}` };
}

// ---------------------------------------------------------------------------------------------
// What may be saved
// ---------------------------------------------------------------------------------------------

/** Thrown for a command that cannot be saved; `message` is fit to show. */
export class SetupCommandProblem extends Error {}

/**
 * The command as it is saved: text for `bash -c`, with the line ends of a text field made plain and
 * nothing around it. "" is no command. Throws SetupCommandProblem for anything else than text, for
 * more than MAX_SETUP_COMMAND_CHARS and for a NUL, which no command line can carry.
 */
export function cleanSetupCommand(raw: unknown): string {
	if (typeof raw !== "string") throw new SetupCommandProblem("The setup command must be text.");
	const command = raw.replace(/\r\n?/g, "\n").trim();
	if (command.length > MAX_SETUP_COMMAND_CHARS)
		throw new SetupCommandProblem(
			`The setup command is ${command.length} characters long; the limit is ${MAX_SETUP_COMMAND_CHARS}. Put a longer one in a script in the repository and run that.`,
		);
	if (command.includes("\0")) throw new SetupCommandProblem("The setup command holds a character a shell cannot take.");
	return command;
}

// ---------------------------------------------------------------------------------------------
// What is kept of a run's output
// ---------------------------------------------------------------------------------------------

/** What a program printed, with the line ends a terminal would have drawn made plain: a carriage return starts a line. */
export function plainLines(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/** The end of what a run printed: at most `limit` characters are held however much arrives. */
export class OutputTail {
	private kept = "";
	/** True once something was dropped from the front. */
	truncated = false;

	constructor(private readonly limit: number = SETUP_OUTPUT_CHARS) {}

	push(text: string): void {
		this.kept += text;
		// Cut in larger steps than a chunk, so a chatty command does not copy the whole text with each line.
		if (this.kept.length > this.limit * 2) this.cut();
	}

	get text(): string {
		this.cut();
		return plainLines(this.kept);
	}

	private cut(): void {
		if (this.kept.length <= this.limit) return;
		let from = this.kept.length - this.limit;
		// Not in the middle of a character that takes two code units.
		const code = this.kept.charCodeAt(from);
		if (code >= 0xdc00 && code <= 0xdfff) from += 1;
		this.kept = this.kept.slice(from);
		this.truncated = true;
	}
}

// ---------------------------------------------------------------------------------------------
// What the agent is told
// ---------------------------------------------------------------------------------------------

/** A run that did not succeed, as the session keeps it until the agent was told. */
export interface UnfinishedSetup {
	command: string;
	/** "stopped": the turn was stopped, by its user or at its own limit. "interrupted": the server stopped while it ran. The others are the timeline's own (contract.ts). */
	state: "failed" | "timed_out" | "stopped" | "interrupted";
	exitCode: number | null;
	limitMs: number;
	/** The end of what it printed. */
	output: string;
}

function minutes(ms: number): string {
	if (ms < 60_000) return ms === 1000 ? "1 second" : `${Math.round(ms / 1000)} seconds`;
	const count = Math.round(ms / 60_000);
	return count === 1 ? "1 minute" : `${count} minutes`;
}

/** The last lines of `output` that say something, for a note. */
export function lastLines(output: string, lines = NOTE_LINES, chars = NOTE_CHARS): string {
	const kept = plainLines(output)
		.split("\n")
		.map(line => line.trimEnd())
		.filter(line => line !== "")
		.slice(-lines)
		.join("\n");
	return kept.length > chars ? kept.slice(-chars) : kept;
}

/**
 * Put before the user's prompt, for Windlass alone, on the first turn it takes after a setup command
 * that did not succeed in its sandbox: the agent finds a workspace without what the command was to
 * put there, and unless it is told why, it reads that as the project's own state. Told once. The
 * timeline keeps the prompt as the user wrote it, and has the run itself.
 */
export function setupNote(run: UnfinishedSetup): string {
	const how =
		run.state === "timed_out"
			? `was stopped after ${minutes(run.limitMs)}, the time it is allowed`
			: run.state === "stopped"
				? "was stopped before it finished, with the turn it ran in"
				: run.state === "interrupted"
					? "was cut off before it finished, when the server it ran from stopped"
					: run.exitCode === null
						? "failed: it could not be run to its end"
						: `failed with exit code ${run.exitCode}`;
	const said = lastLines(run.output);
	return [
		`[A note from the platform, not from the user: before this turn the platform ran the setup command the user saved for this repository, once, in the repository's directory, and it ${how}. It is not run again in this sandbox. The command:`,
		run.command,
		said === "" ? "It printed nothing." : `The last lines of what it printed:\n${said}`,
		"What it was to install or build may be missing or incomplete. Check before you rely on it.]",
		"",
		"",
	].join("\n");
}
