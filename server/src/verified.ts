/**
 * What a session's work was verified with, and how a pull request says so (docs/github-and-repositories.md, "What a pull
 * request shows was verified").
 *
 * Three things are worked out here, and nothing else is: what a turn's checks came to, from the
 * events Windlass recorded of its verification gate (`VerificationLog`, `Verified`); what in a pull
 * request's changes a reviewer would want to look at (`workFlags`); and the section of the pull
 * request's description that says both (`verifiedSection`, `withVerifiedSection`).
 *
 * Every decision is made on a field of Windlass's own record: an event's type, a check's `status`,
 * the `origin` of a message the harness appended, a snapshot's id. No sentence of Windlass's is read.
 *
 *   checks.finished        the evidence of one run: each check's name, command, status, exit code,
 *                          duration, origin, required status, the end of its output, why it could not be
 *                          started (`startError`), what the run's changes are measured from
 *                          (`since`) and the session's required checks
 *   synthetic.appended     with `origin: "check_report"`: what failed, as the harness tells the agent
 *   step.started           a model call: after such a message, the agent was sent back with it.
 *                          Windlass writes the message with an ending that leaves checks
 *                          unresolved too, for whoever continues the session: nobody is sent back
 *   snapshot.taken         the workspace's state by id: the one the checks ran on, and every later one
 *   tool.started           a call's `effect`, where no snapshot says whether files changed
 *   execution.succeeded    `verification`: how the gate ended; where no check was needed, why (`reason`) and which verified state the work
 *                          is on (`since`)
 *   execution.failed, execution.interrupted
 *   notice                 with `kind: "checks_not_run"`: Windlass could not run checks in the sandbox
 *
 * The platform's required checks have origin `session`. Windlass carries the end of each selected check's output in its evidence.
 *
 * This file has no actor, no sandbox and no GitHub in it: the session's actor feeds it events and
 * stores what it answers, github/publish.ts puts the section into a pull request, and
 * scripts/verified-check.ts runs all of it on recorded events and made-up diffs.
 */

import {
	CHECK_OUTPUT_CHARS,
	type CheckStatus,
	type RepositoryCheck,
	type Verified,
	type VerifiedCheck,
	type VerifiedFlag,
	type WindlassEvent,
} from "./contract.js";
import type { TurnChecks } from "./sandbox/api.js";
import { isRecord } from "./util.js";

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const STATUSES: readonly CheckStatus[] = ["passed", "failed", "timed_out", "could_not_start", "interrupted"];

// ---------------------------------------------------------------------------------------------
// A turn's checks, from Windlass's events
// ---------------------------------------------------------------------------------------------

/** A check of a finished run, as Windlass's evidence has it. */
interface RanCheck {
	name: string;
	command: string;
	status: CheckStatus;
	exitCode: number | null;
	durationMs: number;
	/** True when Windlass carried an earlier pass over instead of running it again (`reusedFromSeq`). */
	carried: boolean;
	/** Who named it, where the evidence says (`origin`): "session" is whoever opened the session, which is the platform, for the user. */
	origin: string;
	/** The evidence says it is a required check. */
	required: boolean;
	/** The end of its output as the evidence carries it (`outputTail.text`), "" where it carries none. */
	tail: string;
	/** It was not started: its command could not be run at all, so it has no exit code and says nothing about the code. A command the shell did not find has one (126, 127), and ran. */
	notStarted: boolean;
	/** Why, as the evidence says it (`startError`), "" where it does not. */
	startError: string;
}

/** Why a turn ended with no check needed, as Windlass records it (`reason` of a `not_needed` ending). */
const UNNEEDED = ["turn_unchanged", "state_unchanged", "not_covered"] as const;
/** How much of Windlass's reason for a check that was not started is kept. */
const START_ERROR_CHARS = 400;

/**
 * What one turn's events say about its checks. `note` takes every event of the turn, in order;
 * `verified` then says what the session's work rests on after it.
 */
export class VerificationLog {
	/** The last completed run and the workspace it checked. */
	private run: { at: number; seq: number; checks: RanCheck[]; snapshot: string | null } | null = null;
	/** By check name: how many times the agent was sent back while it failed. */
	private readonly sentBack = new Map<string, number>();
	/** The checks the harness's latest message named as not passed, until a model call follows it: only then was the agent sent back with them. */
	private reported: string[] = [];
	/** The workspace's state when the checks last ended, until `checks.finished` takes it. */
	private checksEnd: string | null = null;
	private firstSnapshot: string | null = null;
	private lastSnapshot: string | null = null;
	/** A call that can change files started: in the turn at all, and since the last run. */
	private effects = false;
	private effectsSinceRun = false;
	/** A state of the workspace other than the one the last run was on was recorded after it. */
	private movedSinceRun = false;
	private noSandbox = false;
	private ending: {
		kind: "succeeded" | "failed" | "interrupted";
		verification: Record<string, unknown> | null;
	} | null = null;

	note(event: WindlassEvent): void {
		const data = isRecord(event.data) ? event.data : (event as Record<string, unknown>);
		switch (event.type) {
			case "snapshot.taken": {
				const id = text(data.id);
				if (id === "") return;
				this.firstSnapshot ??= id;
				this.lastSnapshot = id;
				if (data.point === "checks_end") this.checksEnd = id;
				else if (this.run !== null && this.run.snapshot !== null && id !== this.run.snapshot) this.movedSinceRun = true;
				return;
			}
			case "tool.started":
				if (text(data.effect) !== "read") {
					this.effects = true;
					this.effectsSinceRun = true;
				}
				return;
			case "checks.finished": {
				if (typeof event.seq !== "number") break;
				const evidence = isRecord(data.evidence) ? data.evidence : {};
				const checks = (Array.isArray(evidence.checks) ? evidence.checks : [])
					.filter(isRecord)
					.flatMap((check): RanCheck[] => {
						const status = STATUSES.find(known => known === check.status);
						if (status === undefined || text(check.name) === "") return [];
						return [
							{
								name: text(check.name),
								command: text(check.command),
								status,
								exitCode: typeof check.exitCode === "number" ? check.exitCode : null,
								durationMs: typeof check.durationMs === "number" ? check.durationMs : 0,
								carried: typeof check.reusedFromSeq === "number",
								origin: text(check.origin),
								required: check.required === true,
								tail: isRecord(check.outputTail) ? text(check.outputTail.text) : "",
								notStarted: status === "could_not_start" && typeof check.exitCode !== "number",
								startError: text(check.startError),
							},
						];
					});
				this.run = {
					at: typeof event.time === "number" ? event.time : Date.now(),
					seq: event.seq,
					checks,
					snapshot: this.checksEnd,
				};
				this.checksEnd = null;
				this.movedSinceRun = false;
				this.effectsSinceRun = false;
				return;
			}
			case "synthetic.appended":
				// The harness's own message with the checks that did not pass. Written before the model is called again, and with an ending that leaves them unresolved.
				if (data.origin === "check_report" && this.run !== null)
					this.reported = this.run.checks
						.filter(check => check.status !== "passed" && check.status !== "interrupted")
						.map(check => check.name);
				return;
			case "step.started":
				// The model is called with that message before it: the agent was sent back.
				for (const name of this.reported) this.sentBack.set(name, (this.sentBack.get(name) ?? 0) + 1);
				this.reported = [];
				return;
			case "notice":
				if (data.kind === "checks_not_run") this.noSandbox = true;
				return;
			case "execution.started":
			case "execution.resumed":
				this.ending = null;
				return;
			case "execution.succeeded":
				this.ending = { kind: "succeeded", verification: isRecord(data.verification) ? data.verification : null };
				return;
			case "execution.failed":
				this.ending = { kind: "failed", verification: null };
				return;
			case "execution.interrupted":
				this.ending = { kind: "interrupted", verification: null };
				return;
		}
	}

	/** Whether the workspace is another than the one the turn's last run of checks was on; with no run, whether the turn changed it. */
	private get changed(): boolean {
		if (this.run === null) return this.firstSnapshot !== null ? this.lastSnapshot !== this.firstSnapshot : this.effects;
		return this.run.snapshot !== null ? this.movedSinceRun : this.effectsSinceRun;
	}

	/**
	 * What the session's work rests on after this turn. `saved` is the user's list as the turn was
	 * handed it, `handed` what the sandbox layer said of the turn's configuration (absent when the
	 * turn ended before it got that far), and `previous` what the session's work rested on before.
	 * A turn in which no run of checks finished keeps the earlier run, and says whether the
	 * workspace changed since.
	 *
	 * A turn that ended with no check needed on a state verified earlier, according to Windlass (`reason` and `since` of the ending), rests on the run that state rests on: a run of
	 * the turn's own was of another state, and only what did not pass in it is kept (`putBack`).
	 */
	verified(
		turn: number,
		saved: readonly RepositoryCheck[],
		handed: TurnChecks | undefined,
		previous: Verified | null,
	): Verified {
		const project = handed?.project ?? null;
		const mine = (check: RanCheck) => check.origin === "session";
		const verification = this.ending?.kind === "succeeded" ? this.ending.verification : null;
		const status = text(verification?.status);
		const reason = text(verification?.reason);

		const why = status === "not_needed" ? UNNEEDED.find(known => known === reason) : undefined;
		let state: Exclude<Verified["state"], "not_needed">;
		if (this.ending?.kind === "failed") state = "failed";
		else if (this.ending?.kind !== "succeeded") state = "stopped";
		// Windlass said that it could not run checks in the sandbox, and the turn ended with checks unresolved for another reason than a check that could not start (`not_started`): nothing was verified.
		else if (status === "unresolved" && this.noSandbox && reason !== "not_started") state = "no_sandbox";
		else if (status === "passed" || status === "unresolved") state = status;
		else if (saved.length === 0 && !(project !== null && (project.checks ?? 0) > 0)) state = "none_set";
		else if (saved.length === 0 && project?.verify === "off") state = "off";
		else if (this.noSandbox) state = "no_sandbox";
		else state = "not_in_force";

		const own: Verified["run"] =
			this.run === null
				? null
				: {
						turn,
						at: this.run.at,
						seq: this.run.seq,
						checks: this.run.checks.map(
							(check): VerifiedCheck => ({
								name: check.name,
								command: check.command,
								whose: mine(check) ? "user" : "repository",
								...(check.required && mine(check) ? { required: true } : {}),
								status: check.status,
								exitCode: check.exitCode,
								durationMs: check.durationMs,
								// Such a Windlass names a check it could not start in the message it sends the agent back with, and asks nothing of the agent for it.
								sentBack: check.notStarted ? 0 : (this.sentBack.get(check.name) ?? 0),
								...(check.carried ? { carried: true } : {}),
								...(check.notStarted ? { startError: check.startError.slice(0, START_ERROR_CHARS) } : {}),
							}),
						),
					};
		let run = own ?? previous?.run ?? null;
		let changedAfter =
			own === null
				? previous !== null && previous.run !== null && (previous.changedAfter || this.changed)
				: this.changed;
		let putBack: VerifiedCheck[] = [];
		let on: NonNullable<Verified["unneeded"]>["on"] = null;
		if (why === "state_unchanged" || why === "not_covered") {
			// The work is on a state verified earlier, or differs from it only in files no check covers. The run that state rests on is the one Windlass names, where the platform holds it: the session's last before this turn.
			const since = isRecord(verification?.since) ? verification.since : {};
			const passed = isRecord(since.run) && typeof since.run.seq === "number" ? since.run.seq : null;
			const held =
				previous !== null && previous.run !== null && passed !== null && previous.run.seq === passed ? previous : null;
			on = held !== null ? "run" : since.run === null ? "start" : null;
			// A run of this turn's own was of another state, and so is an earlier one that state does not rest on.
			if (own !== null || on !== null) {
				run = held === null ? null : held.run;
				// Of the state that run passed on, files no check covers may differ: this ending says so, or an earlier one that moved the verified state on from the run's did.
				changedAfter = held !== null && (why === "not_covered" || (held.changedAfter && since.seq !== passed));
				putBack = (own?.checks ?? []).filter(check => check.status !== "passed");
			}
		}
		// What the evidence carries of a check's output: Windlass kept it for one that did not pass, and for one whose entry asks.
		const tails = new Map(
			(run === own ? (this.run?.checks ?? []) : [])
				.map((check): [string, string] => [check.name, outputTail(check.tail)])
				.filter(([, kept]) => kept !== "")
				.slice(0, OUTPUTS_SHOWN),
		);
		const acknowledgement = isRecord(verification?.acknowledgement) ? text(verification.acknowledgement.reason) : "";
		return withOutputs(
			{
				turn,
				...(why === undefined ? { state } : { state: "not_needed" as const, unneeded: { reason: why, on } }),
				...(state === "unresolved" &&
				(reason === "acknowledged" ||
					reason === "max_rounds" ||
					reason === "report_mode" ||
					reason === "not_started" ||
					reason === "environment")
					? {
							unresolved: {
								reason,
								said: reason === "acknowledged" && acknowledgement !== "" ? acknowledgement.slice(0, 400) : null,
							},
						}
					: {}),
				...(putBack.length === 0 ? {} : { putBack }),
				run,
				unrun: saved
					.filter(
						kept =>
							![...(run?.checks ?? []), ...putBack].some(
								check => check.whose === "user" && check.name === kept.name && check.command === kept.command,
							),
					)
					.map(({ name, command }) => ({ name, command })),
				...(saved.length > 0 && project !== null && (project.checks !== null || project.verify !== null)
					? { overruled: true }
					: {}),
				changedAfter,
			},
			tails,
		);
	}

	/**
	 * For a turn that was cut off with its server, whose events are all that is left of it: nothing
	 * is known of what it was handed, so no run of its own is kept. What the work rested on before
	 * stands, and whether the turn changed the workspace is said of it.
	 */
	cutOff(turn: number, previous: Verified | null): Verified {
		const changed = this.firstSnapshot !== null ? this.lastSnapshot !== this.firstSnapshot : this.effects;
		return {
			turn,
			state: "stopped",
			run: previous?.run ?? null,
			unrun: previous?.unrun ?? [],
			...(previous?.overruled ? { overruled: true } : {}),
			changedAfter: previous !== null && previous.run !== null && (previous.changedAfter || changed),
		};
	}
}

/** The end of what a check printed, as it is kept: whole lines where there are any, at most CHECK_OUTPUT_CHARS. */
export function outputTail(output: string): string {
	// Without what a terminal would have acted on: colour codes, and control characters other than a tab and a line end.
	const plain = output
		.replace(/\r\n?/g, "\n")
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/[^\n\t\x20-\x7e\u00a0-\uffff]/g, "")
		.trimEnd();
	if (plain.length <= CHECK_OUTPUT_CHARS) return plain;
	const cut = plain.slice(-CHECK_OUTPUT_CHARS);
	const line = cut.indexOf("\n");
	return line >= 0 && line < cut.length - 1 ? cut.slice(line + 1) : cut;
}

/** `verified` with the output the platform read for its run's checks, by name. */
export function withOutputs(verified: Verified, outputs: ReadonlyMap<string, string>): Verified {
	if (verified.run === null || outputs.size === 0) return verified;
	return {
		...verified,
		run: {
			...verified.run,
			checks: verified.run.checks.map(check =>
				outputs.get(check.name) ? { ...check, output: outputs.get(check.name) } : check,
			),
		},
	};
}

// ---------------------------------------------------------------------------------------------
// What in the work a reviewer would want to look at
// ---------------------------------------------------------------------------------------------

/** A session's work against the branch it started from, as git in its sandbox describes it (github/git.ts, `workScript`). */
export interface WorkDiff {
	/** `git diff --name-status -M`: a file's status letter and path, and for a rename where it went. */
	files: Array<{ status: string; path: string; to?: string }>;
	/** The same diff, without context lines; cut when it is long. */
	patch: string;
	/** The repository's `.windlass/config.json` and its `package.json`, before and now; null for one that is not there. */
	config: { before: string | null; after: string | null };
	packageJson: { before: string | null; after: string | null };
}

const CODE =
	/\.(?:[cm]?[jt]sx?|py|go|rb|rs|java|kts?|scala|cs|swift|php|exs?|dart|sh|bats|c|cc|cpp|h|hpp|vue|svelte)$/i;
const TEST_NAME =
	/(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.(?:py|go|rb|rs|exs?|dart|c|cc|cpp)|[^/]+_spec\.rb|[^/]+\.(?:test|spec)\.[A-Za-z0-9]+|[^/]+[-_](?:test|spec)\.[cm]?[jt]sx?|[^/]+Tests?\.(?:java|kts?|scala|cs|swift|php))$/;
const TEST_DIRECTORY = /(?:^|\/)(?:tests?|__tests__|specs?|e2e)\//i;
const NOT_A_TEST =
	/(?:^|\/)(?:fixtures?|__fixtures__|__snapshots__|snapshots|testdata|data|mocks?|__mocks__|helpers?|support|utils?)\//i;

/** Whether a path is a test's: by its file's name, or as code in a directory of tests that is not one of fixtures or helpers. */
export function isTestPath(path: string): boolean {
	return TEST_NAME.test(path) || (TEST_DIRECTORY.test(path) && CODE.test(path) && !NOT_A_TEST.test(path));
}

/** Whether a path is source code that is not a test's. */
export const isCodePath = (path: string): boolean => CODE.test(path) && !isTestPath(path);

/** What marks a test as skipped or disabled, in the frameworks that have a marker for it. */
const SKIP_MARKERS = [
	/\b(?:it|test|describe|context|suite|specify)\.(?:skip|todo)\b/g,
	/\b(?:xit|xtest|xdescribe|xcontext|xspecify)\s*\(/g,
	/@(?:pytest\.mark\.(?:skip|skipif|xfail)|unittest\.(?:skip|skipIf|skipUnless|expectedFailure))\b/g,
	/\bpytest\.skip\s*\(/g,
	/@(?:Disabled|Ignore)\b/g,
	/#\[ignore\b/g,
	/\bt\.Skip(?:f|Now)?\s*\(/g,
];
/** A command line that goes on as if what came before had succeeded. */
const EXIT_IGNORED = /\|\|\s*(?:true|:|exit\s+0|\/bin\/true)(?=$|[\s;)&|'"])|;\s*(?:true|exit\s+0)\s*$|\bset\s+\+e\b/gm;

const count = (lines: string, patterns: readonly RegExp[]) =>
	patterns.reduce((sum, pattern) => sum + (lines.match(pattern)?.length ?? 0), 0);

/** The lines a patch adds and takes away, by file. */
function changedLines(patch: string): Map<string, { added: string; removed: string }> {
	const files = new Map<string, { added: string; removed: string }>();
	let current: { added: string; removed: string } | null = null;
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) {
			current = null;
			continue;
		}
		const named = /^(?:---|\+\+\+) (?:[ab]\/)?(.+)$/.exec(line);
		if (named) {
			// A deleted file is named by its old path, any other by its new one.
			if (named[1] !== "/dev/null" && (line.startsWith("+++") || current === null)) {
				current = files.get(named[1] as string) ?? { added: "", removed: "" };
				files.set(named[1] as string, current);
			}
			continue;
		}
		if (current === null) continue;
		if (line.startsWith("+")) current.added += `${line.slice(1)}\n`;
		else if (line.startsWith("-")) current.removed += `${line.slice(1)}\n`;
	}
	return files;
}

function json(source: string | null): Record<string, unknown> | null {
	if (source === null) return null;
	try {
		const parsed: unknown = JSON.parse(source);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** The script of the repository's `package.json` a command runs through a package manager, if it names one. */
function packageScript(command: string): string | null {
	const match = /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+(?:(?:run|run-script)\s+)?([A-Za-z0-9][A-Za-z0-9:._-]*)/.exec(
		command,
	);
	if (!match) return null;
	// `bun test` is Bun's own test runner, not a script.
	if (/\bbun\s+test\b/.test(match[0])) return null;
	return match[1] === "t" ? "test" : (match[1] as string);
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const FLAG_PATHS = 5;

/**
 * What in a session's work a reviewer would want to look at, as observations, each from the diff
 * against the branch the work started from. `checks` are the commands that matter: the user's own,
 * and the ones that ran. The list is short on purpose, and each entry says what it looks for:
 *
 *   tests_removed    a test's file (`isTestPath`) was deleted, or renamed to a path that is not a test's
 *   tests_skipped    a test's file gained more markers that skip or disable a test than it lost
 *                    (`it.skip`, `xit(`, `@pytest.mark.skip`, `@Disabled`, `#[ignore]`, `t.Skip(`, ...)
 *   checks_changed   the repository's `.windlass/config.json` says something else about `checks` or
 *                    `verify` than before; or a script a check's command runs was changed
 *                    (`checkScripts`); or the `package.json` script a check's command runs was
 *   exit_ignored     one of those (a check's command in the repository's file, the script) came to
 *                    ignore an exit status: `|| true`, `|| :`, `|| exit 0`, a closing `; true` or
 *                    `; exit 0`, `set +e`
 *
 * A file a command merely names is not a script it runs: `node --check src/a.js` checks that file,
 * and a test's file run as the check (`node test/a.test.js`) is the work under test, which changes in
 * ordinary work and has the two flags above. Flagging those would put the line on most pull requests.
 */
export function workFlags(
	diff: WorkDiff,
	checks: ReadonlyArray<{ name: string; command: string }>,
	owns?: (path: string) => boolean,
): VerifiedFlag[] {
	const lines = changedLines(diff.patch);
	const flags: VerifiedFlag[] = [];
	const flag = (kind: VerifiedFlag["kind"], where: string[]) => {
		const unique = [...new Set(where)];
		if (unique.length > 0)
			flags.push({
				kind,
				where:
					unique.length > FLAG_PATHS
						? [...unique.slice(0, FLAG_PATHS), `and ${unique.length - FLAG_PATHS} more`]
						: unique,
			});
	};

	flag(
		"tests_removed",
		diff.files
			.filter(
				file =>
					isTestPath(file.path) &&
					(file.status.startsWith("D") || (file.status.startsWith("R") && !isTestPath(file.to ?? ""))),
			)
			.map(file => file.path),
	);
	flag(
		"tests_skipped",
		[...lines]
			.filter(
				([path, changed]) =>
					isTestPath(path) && count(changed.added, SKIP_MARKERS) > count(changed.removed, SKIP_MARKERS),
			)
			.map(([path]) => path),
	);

	const touched = new Set(diff.files.flatMap(file => [file.path, ...(file.to === undefined ? [] : [file.to])]));
	const changed: string[] = [];
	const ignored: string[] = [];
	const ignores = (source: string) => source.match(EXIT_IGNORED)?.length ?? 0;

	// The repository's own check configuration.
	const before = json(diff.config.before);
	const after = json(diff.config.after);
	const CONFIG = ".windlass/config.json";
	if (touched.has(CONFIG)) {
		const unreadable =
			(diff.config.before !== null && before === null) || (diff.config.after !== null && after === null);
		if (
			unreadable
				? diff.config.before !== diff.config.after
				: !sameJson(before?.checks, after?.checks) || !sameJson(before?.verify, after?.verify)
		)
			changed.push(CONFIG);
		const commands = (config: Record<string, unknown> | null) =>
			(Array.isArray(config?.checks) ? config.checks : [])
				.filter(isRecord)
				.map(check => text(check.command))
				.join("\n");
		if (ignores(commands(after)) > ignores(commands(before))) ignored.push(CONFIG);
	}

	// What a check's command runs: a file it names, and a script of package.json.
	const scripts = (source: string | null) => {
		const found = json(source)?.scripts;
		return isRecord(found) ? found : {};
	};
	for (const check of checks) {
		for (const path of checkScripts(check.command)) {
			if (path === CONFIG || !touched.has(path) || isTestPath(path)) continue;
			changed.push(path);
			const own = lines.get(path);
			if (own && ignores(own.added) > ignores(own.removed)) ignored.push(path);
		}
		const script = packageScript(check.command);
		if (script === null || !touched.has("package.json")) continue;
		const was = scripts(diff.packageJson.before)[script];
		const is = scripts(diff.packageJson.after)[script];
		if (sameJson(was, is)) continue;
		changed.push("package.json");
		if (ignores(text(is)) > ignores(text(was))) ignored.push("package.json");
	}
	flag("checks_changed", changed);
	flag("exit_ignored", ignored);
	// Both sides of a rename matter: instructions can move into or out of the work. The root config has its own check above.
	if (owns)
		flag(
			"outside_scope",
			[...touched].filter(path => !owns(path)),
		);
	flag("agent_instructions_changed", [...touched].filter(isAgentInstructionPath));
	return flags;
}

function isAgentInstructionPath(path: string): boolean {
	return (
		path !== ".windlass/config.json" &&
		(/(^|\/)(AGENTS|CLAUDE)\.md$/.test(path) ||
			/(^|\/)\.(windlass|claude|agents|cursor\/rules)\//.test(path) ||
			path === ".github/copilot-instructions.md")
	);
}

/** Group the pinned diff before redaction, so an instruction path still gets a warning if its name is redacted. */
export function groupReviewPaths(paths: string[]) {
	const instructionPaths: string[] = [];
	const otherPaths: string[] = [];
	for (const path of paths) {
		if (isAgentInstructionPath(path)) instructionPaths.push(path);
		else otherPaths.push(path);
	}
	return { paths: otherPaths, instructionPaths, total: paths.length };
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "source", "."]);
const INTERPRETERS = new Set(["node", "bun", "deno", "tsx", "ts-node", "python", "python3", "ruby", "perl", "php"]);

/**
 * The scripts a check's command runs, as paths in the repository: a file run by itself
 * (`scripts/check.sh --fast`), one handed to a shell (`sh ./scripts/check.sh`), and one handed to an
 * interpreter as the program (`python3 tools/check.py`, `deno run tools/check.ts`). An interpreter
 * given an option first is not counted: with `--check`, `--test`, `-e` or `-m` the file after it is
 * something else than the program. Each part of a command joined by `&&`, `||`, `;`, `|` or a new
 * line is looked at by itself, after any `NAME=value` in front of it.
 */
export function checkScripts(command: string): string[] {
	const clean = (token: string | undefined) => (token ?? "").replace(/^['"]|['"]$/g, "").replace(/^\.\//, "");
	const found: string[] = [];
	for (const part of command.split(/&&|\|\||[;|\n()]/)) {
		const words = part
			.trim()
			.split(/\s+/)
			.filter(word => word !== "");
		while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
		const first = clean(words[0]);
		if (first === "") continue;
		if (SHELLS.has(first)) {
			const script = clean(words.slice(1).find(word => !word.startsWith("-")));
			if (script !== "") found.push(script);
		} else if (INTERPRETERS.has(first)) {
			const next = first === "deno" && words[1] === "run" ? words[2] : words[1];
			if (next !== undefined && !next.startsWith("-")) found.push(clean(next));
		} else if (first.includes("/") || /\.[A-Za-z0-9]+$/.test(first)) {
			found.push(first);
		}
	}
	return found;
}

// ---------------------------------------------------------------------------------------------
// In words
// ---------------------------------------------------------------------------------------------

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

function took(ms: number): string {
	if (ms < 1000) return `${ms} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
	return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** How one check ended, in a clause: "passed in 4.2 s after the agent was sent back once". */
export function checkWords(check: VerifiedCheck): string {
	if (check.startError !== undefined) return `was not started${check.startError === "" ? "" : `: ${check.startError}`}`;
	const how =
		check.status === "passed"
			? "passed"
			: check.status === "timed_out"
				? "timed out"
				: check.status === "could_not_start"
					? "could not be started"
					: check.status === "interrupted"
						? "was interrupted"
						: check.exitCode === null
							? "failed"
							: `failed with exit code ${check.exitCode}`;
	if (check.carried) return `${how} earlier in the session and was not run again: no file it covers changed since`;
	return `${how} ${check.status === "passed" ? "in" : "after"} ${took(check.durationMs)}${check.sentBack > 0 ? `${check.status === "passed" ? " after" : ", and"} the agent was sent back ${times(check.sentBack)}` : ""}`;
}

/**
 * How the turn's gate ended, in one sentence.
 */
export function verifiedHeadline(verified: Verified): string {
	const turn = `turn ${verified.turn}`;
	const here = verified.run !== null && verified.run.turn === verified.turn ? verified.run.checks : [];
	// Report a check that could not start separately from one that ran and failed.
	const unstarted = here.filter(check => check.startError !== undefined);
	const failing = here.filter(check => check.status !== "passed" && check.startError === undefined);
	const file = "the repository's `.windlass/config.json`";
	const one = unstarted.length === 1;
	switch (verified.state) {
		case "passed":
			return `${here.length === 1 ? "The check that applied" : `The ${here.length} checks that applied`} passed when the agent's ${turn} ended.`;
		case "unresolved": {
			if (failing.length === 0 && unstarted.length > 0) {
				const fix = `That says nothing about the code, so the agent was not sent back to change anything: what there is to fix is the reason given with ${one ? "the check" : "each"} below.`;
				if (unstarted.length < here.length)
					return `The agent's ${turn} ended with ${one ? "a check" : `${unstarted.length} checks`} that ${one ? "was" : "were"} not started. ${fix}`;
				return `Nothing was verified in the agent's ${turn}: ${one ? "the check that applied was" : `the ${unstarted.length} checks that applied were`} not started. ${fix}`;
			}
			const why =
				verified.unresolved?.reason === "acknowledged"
					? `the agent reported that it could not make ${failing.length === 1 ? "it" : "them"} pass${verified.unresolved.said ? ` ("${verified.unresolved.said}")` : ""}`
					: verified.unresolved?.reason === "report_mode"
						? `${file} sets verification to report only, so the agent was not sent back`
						: verified.unresolved?.reason === "environment"
							? `the sandbox could not run ${failing.length === 1 ? "its command" : "their commands"}, which says nothing about the code, so the agent was not sent back`
							: "the agent had been sent back as often as a turn allows";
			const besides =
				unstarted.length === 0
					? ""
					: ` ${one ? "Another check was" : `${unstarted.length} other checks were`} not started, which says nothing about the code: the agent was not asked to change anything for ${one ? "it" : "them"}, and what there is to fix is the reason given with ${one ? "it" : "each"} below.`;
			return `The agent's ${turn} ended with ${failing.length === 1 ? "a check" : `${failing.length} checks`} still failing: ${why}.${besides}`;
		}
		case "not_needed": {
			const { unneeded, run } = verified;
			const none = verified.putBack
				? `No check was run again when the agent's ${turn} ended`
				: `No check ran in the agent's ${turn}`;
			const passed = unneeded.on === "run" && run !== null ? `, at the end of turn ${run.turn}` : null;
			if (unneeded.reason === "turn_unchanged") return `${none}: the turn changed no file.`;
			if (unneeded.reason === "state_unchanged")
				return `${none}: ${passed !== null ? `the files the checks cover are again as they were when the checks last passed${passed}` : unneeded.on === "start" ? "the files the checks cover are again as they were when the session started, a state no check has verified" : "the turn changed files and left them as they were before"}.`;
			return `${none}: no check covers the files that ${passed !== null ? `differ from the state the checks last passed on${passed}` : unneeded.on === "start" ? "differ from the state the session started from, which no check has verified" : "changed"}.`;
		}
		case "none_set":
			return "Nothing was verified: no checks are set for this repository.";
		case "off":
			return `Nothing was verified in the agent's ${turn}: ${file} turns verification off.`;
		case "no_sandbox":
			return `Nothing was verified in the agent's ${turn}: Windlass could not run checks in this session's sandbox.`;
		case "not_in_force":
			return `Nothing was verified in the agent's ${turn}: Windlass reported no checks in force, though ${plural(verified.unrun.length, "is", "are")} saved for this repository.`;
		case "stopped":
			return `The agent's ${turn} was stopped before its checks had run.`;
		case "failed":
			return `The agent's ${turn} failed before its checks had run.`;
	}
}

/** For a turn in which a run of checks did not pass and the agent then put the files back (`Verified.putBack`): what that run was, and that it does not stand. "" where there was none. */
export function putBackWords(verified: Verified, name: (check: VerifiedCheck) => string): string {
	if (!verified.putBack) return "";
	return `A run of checks earlier in turn ${verified.turn} did not pass (${verified.putBack.map(check => `${name(check)} ${checkWords(check)}`).join("; ")}). The agent then changed the files back, so that run says nothing about the work as it is now.`;
}

/** For a turn whose user's checks were required ones while the repository's file had a say about checks: whom that held for, in a sentence. */
export function overruledWords(owner: string): string {
	return `The repository's \`.windlass/config.json\` says something about checks too. That holds for the repository's own checks: ${owner} checks are required, and that file can neither replace them nor switch them off.`;
}

/** Why the user's checks in `unrun` did not run, in a sentence; "" where the headline already says it. */
export function unrunReason(verified: Verified): string {
	if (verified.state === "passed" || verified.state === "unresolved")
		return `No changed file matches ${verified.unrun.length === 1 ? "its" : "their"} patterns.`;
	return "";
}

/** One observation, as a sentence without its paths. */
export function flagWords(kind: VerifiedFlag["kind"]): string {
	switch (kind) {
		case "tests_removed":
			return "Test files were deleted or renamed away";
		case "tests_skipped":
			return "Tests were newly skipped or disabled";
		case "checks_changed":
			return "What the checks run was changed in this work";
		case "outside_scope":
			return "The subtask changed files outside its approved paths";
		case "agent_instructions_changed":
			return "Instructions for agents were changed in this work";
		case "exit_ignored":
			return "A check's command came to ignore an exit status (`|| true` or the like)";
	}
}

/** What became of the session's checks, in a few words, for a list: "2 checks passed", "nothing verified, 1 thing to look at". */
export function verifiedWords(
	verified: Verified | null,
	flags: readonly VerifiedFlag[],
	during: number | null,
): string {
	const here =
		verified !== null && verified.run !== null && verified.run.turn === verified.turn ? verified.run.checks : [];
	const unstarted = here.filter(check => check.startError !== undefined).length;
	const failing = here.filter(check => check.status !== "passed").length - unstarted;
	const whose = here.length > 0 && here.every(check => check.whose === "repository") ? " (the repository's own)" : "";
	const base =
		during !== null
			? "pushed before the turn's checks ran"
			: verified === null
				? "nothing verified"
				: verified.state === "passed"
					? `${plural(here.length, "check")} passed${whose}`
					: verified.state === "unresolved"
						? failing > 0
							? `${failing} of ${plural(here.length, "check")} failing${whose}${unstarted > 0 ? `, ${unstarted} not started` : ""}`
							: unstarted === here.length
								? `nothing verified, ${plural(unstarted, "check")} not started${whose}`
								: `${unstarted} of ${plural(here.length, "check")} not started${whose}`
						: verified.state === "not_needed"
							? verified.unneeded.reason === "not_covered"
								? "no check covers what changed"
								: "no check was needed"
							: verified.state === "stopped" || verified.state === "failed"
								? "checks did not run"
								: "nothing verified";
	const looks = flags.length + (verified?.changedAfter ? 1 : 0);
	return looks === 0 ? base : `${base}, ${plural(looks, "thing")} to look at`;
}

// ---------------------------------------------------------------------------------------------
// The section of a pull request's description
// ---------------------------------------------------------------------------------------------

/** The lines the section stands between: comments, which GitHub does not show. */
const SECTION_START = "<!-- windlass-platform:verified -->";
const SECTION_END = "<!-- /windlass-platform:verified -->";
const SECTION_NAME = /windlass-platform:verified/g;

/** How much of a command the section shows, and of how many checks it shows the output. */
const COMMAND_CHARS = 200;
const OUTPUTS_SHOWN = 6;

/** Text as it goes into the section: nothing in it can end the section early or start another. */
const inert = (value: string) => value.replace(SECTION_NAME, "windlass-platform verified");
/** A code span around text that may hold backticks. */
function code(value: string): string {
	const whole = inert(value.replace(/\s+/g, " ").trim());
	const plain = whole.length > COMMAND_CHARS ? `${whole.slice(0, COMMAND_CHARS)}…` : whole;
	const fence = "`".repeat(Math.max(1, ...(plain.match(/`+/g) ?? []).map(run => run.length + 1)));
	return plain.includes("`") ? `${fence} ${plain} ${fence}` : `\`${plain}\``;
}

export interface SectionInput {
	/** What the session's work rests on; null when no turn of the session has ended. */
	verified: Verified | null;
	/** What was seen in the work's changes; null when git did not say what they are. */
	flags: readonly VerifiedFlag[] | null;
	/** The turn that was running when this is pushed, whose checks have not run; null between turns. */
	during: number | null;
	/** A session on one of its user's machines: the checks ran there. */
	machine?: { name: string | null };
	/** The session's user as others know them: their GitHub login. */
	login: string;
}

/**
 * The section of a pull request's description that says what the work was verified with: how the
 * gate ended, a run that did not pass before the agent put the files back, each check that ran with
 * whose it is and how it went (or why it was not started), the user's checks that did not run and why, whom the repository's own settings held for where the user's checks are required
 * ones, the observations, and the output that was kept, folded. Plain sentences and no mark
 * of approval: it reports what ran. The caller takes saved secrets out of it (`Redactor`).
 */
export function verifiedSection(input: SectionInput): string {
	const { verified, flags, during } = input;
	const owner = `${input.login}'s`;
	const parts: string[] = [];
	if (input.machine) {
		// The runner supplies the name. Keep it in one paragraph and quote inline Markdown characters.
		const name =
			input.machine.name &&
			inert(input.machine.name)
				.replace(/\s+/g, " ")
				.replace(/([\\`*_{}\[\]()<>!&~|@#:$.])/g, "\\$1");
		parts.push(
			`These checks ran on ${owner} own machine${name ? `, “${name}”` : ""}; this is what that machine reported.`,
		);
	}
	if (during !== null)
		parts.push(
			`This was pushed while the agent's turn ${during} was still running: what that turn changed had not been checked yet.`,
		);
	if (verified === null) {
		if (during === null) parts.push("Nothing was verified: no turn of the agent's has ended in this session.");
	} else {
		const run = verified.run;
		const earlier = run !== null && run.turn !== verified.turn;
		parts.push(during !== null ? `Before it: ${verifiedHeadline(verified)}` : verifiedHeadline(verified));
		if (verified.putBack) parts.push(inert(putBackWords(verified, check => `**${check.name}**`)));
		if (run !== null && run.checks.length > 0) {
			const list = run.checks
				.map(
					check =>
						`- **${inert(check.name)}** (${code(check.command)}), ${check.whose === "user" ? `${owner} ${check.required ? "required check" : "check"}` : "from the repository's `.windlass/config.json`"}: ${inert(checkWords(check))}.`,
				)
				.join("\n");
			parts.push(
				earlier
					? `${verified.putBack ? "The checks as they passed" : "Checks last ran"} when turn ${run.turn} ended:\n\n${list}`
					: list,
			);
		}
		if (verified.unrun.length > 0) {
			const reason = unrunReason(verified);
			parts.push(
				`Did not run: ${verified.unrun.map(check => `**${inert(check.name)}** (${code(check.command)})`).join(", ")}.${reason === "" ? "" : ` ${reason}`}`,
			);
		}
		if (verified.overruled) parts.push(overruledWords(owner));
	}
	const seen = [
		...(verified?.changedAfter
			? ["- Files changed after the checks last ran, so the results above are of an earlier state of the work."]
			: []),
		...(flags ?? []).map(
			flag =>
				`- ${flagWords(flag.kind)}: ${flag.where.map(path => (path.startsWith("and ") ? path : code(path))).join(", ")}.`,
		),
	];
	if (seen.length > 0) parts.push(["To look at:", "", ...seen].join("\n"));
	if (flags === null)
		parts.push("The platform could not read the changes from the session's sandbox, so it looked for nothing in them.");
	for (const check of verified?.run?.checks ?? []) {
		if (!check.output) continue;
		const body = inert(check.output);
		const fence = "`".repeat(Math.max(3, ...(body.match(/`+/g) ?? []).map(run => run.length + 1)));
		parts.push(
			`<details>\n<summary>The end of what ${inert(check.name)} printed</summary>\n\n${fence}text\n${body}\n${fence}\n\n</details>`,
		);
	}
	parts.push(
		"<sub>Written by Windlass Platform from what Windlass recorded of the session's checks, and replaced each time the platform pushes. It says what ran; it is not a review.</sub>",
	);
	return [SECTION_START, "### What was verified", ...parts, SECTION_END].join("\n\n");
}

/**
 * A pull request's description with `section` as its one such section, at the end: whatever stood
 * between the section's lines before is replaced, a stray line of them goes, and every other word
 * of the description is kept as it was. So a description somebody edited at GitHub keeps their
 * text, and one an agent wrote cannot carry a section of its own making.
 */
export function withVerifiedSection(body: string, section: string): string {
	const escaped = (line: string) => line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const rest = body
		.replace(/\r\n?/g, "\n")
		.replace(new RegExp(`${escaped(SECTION_START)}[\\s\\S]*?${escaped(SECTION_END)}`, "g"), "")
		.replace(/<!--\s*\/?\s*windlass-platform:verified\s*-->/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return rest === "" ? section : `${rest}\n\n${section}`;
}
