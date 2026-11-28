// Cloning the repository into a new sandbox, running its setup, and building its environment.
import {
	type SnapshotRequest,
	snapshotWriter,
	snapshotGeneration,
	DEFERRED_INPUTS,
	digest,
} from "../../sandbox/snapshot-key.js";
import { randomBytes } from "node:crypto";
import { describeError } from "../../auth.js";
import { config } from "../../config.js";
import { type LiveDelta, SETUP_OUTPUT_CHARS } from "../../contract.js";
import { githubApp } from "../../github/app.js";
import { type StoredRepository, sessionRepository, cloneRepository, putOnWork } from "../../github/publish.js";
import { type StoredConnection, GithubProblem } from "../../github/repos.js";
import { type SandboxHandle, type SandboxLayer, sandboxConnectionLost } from "../../sandbox/api.js";
import { runSetupCommand } from "../../sandbox/setup.js";
import { setupEnvironment } from "../../repo-secrets.js";
import { setupProjectOf, OutputTail, lastLines } from "../../setup-command.js";
import { judgeChecks } from "../../environments.js";
import { outputExcerpt } from "../../factory/check-environment.js";
import { PlatformChecks } from "../../sandbox/platform-checks.js";
import { cloneGitlab } from "../../gitlab/workspace.js";
import { GitCredentialRefused } from "../../codehost/credential.js";
import { hostFor } from "../../codehost/item.js";
import { gitlabOf } from "../gitlab-item.js";
import {
	sessionSandboxInput,
	itemActor,
	userActor,
	type EnvironmentBuildReport,
	type EnvironmentBuildResult,
} from "../internal.js";
import { note, persist, keepDelta, append } from "./timeline.js";
import { str, orNull, RECALL_WAIT_MS } from "./questions.js";
import type { SessionMeta, Ctx, HeldSecrets } from "./state.js";
import { GitAccessRefused, ReviewRefused, githubConnection, TurnProblem } from "./common.js";

/** How long a setup run's output gathers before it is sent on, and how much of it makes it go at once. */
const SETUP_FLUSH_MS = 120;
const SETUP_FLUSH_CHARS = 8_000;

export interface SnapshotPlan {
	writer: boolean;
	key: SnapshotRequest;
	commit: string;
	defaultBranch: string;
	command: string;
	updatedAt: number | null;
}
export async function setupRevision(
	app: NonNullable<ReturnType<typeof githubApp>>,
	connection: StoredConnection,
	repo: StoredRepository,
	revision: string,
) {
	const resolved = await sessionRepository(app, connection, repo, "read");
	const { owner, name, defaultBranch } = resolved.repository;
	const inputs = await app.withToken(
		resolved.installation.id,
		{ repositoryId: repo.id, permissions: { metadata: "read", contents: "read" } },
		token => app.setupInputs(token, owner, name, revision),
		{ revokeAfter: true },
	);
	return { ...inputs, defaultBranch };
}

export function usesScreenshotImage(meta: SessionMeta, sandbox: SandboxHandle, allowed = false): boolean {
	return (
		sessionSandboxInput(meta, allowed).screenshots === true &&
		(meta.place.kind === "hosted" || sandbox.runnerScreenshots === true)
	);
}

/** The work item owns its parent link, including for older sessions without owned-path metadata. */
export async function childSetupSeed(c: Ctx, meta: SessionMeta): Promise<string | undefined> {
	if (!meta.origin || meta.origin.role === "reviewer") return undefined;
	return (await itemActor(c, meta.uid, meta.origin.itemId).internalSetupSeed("child")) ?? undefined;
}

// Scope the clone token to the resolved repository and revoke it after clone.
export async function cloneConnected(
	c: Ctx,
	meta: SessionMeta,
	turn: number,
	sandbox: SandboxHandle,
	signal: AbortSignal,
): Promise<boolean> {
	const repo = meta.repo;
	if (!repo) return true;
	const app = githubApp();
	if (repo.provider !== "gitlab" && !app)
		throw new ReviewRefused(
			`This agent was launched on ${repo.owner}/${repo.name} through your GitHub connection, and this deployment has no GitHub App any more to clone it with.`,
		);
	// Child sessions keep the feature branch as their publishing base. Setup uses its immutable seed,
	// even after siblings have integrated or this child needs to recover its own published branch.
	const childSeed = await childSetupSeed(c, meta);
	const pinnedBase = meta.origin?.role === "reviewer" ? meta.reviewBase : childSeed;
	const work =
		meta.origin?.role === "reviewer"
			? undefined
			: (meta.pushedHead && meta.publishBranch) || (childSeed ? repo.branch : undefined);
	note(c, turn, "info", `Cloning ${repo.owner}/${repo.name} at ${pinnedBase ?? repo.branch}`);
	try {
		const cloned =
			repo.provider === "gitlab"
				? await cloneGitlab(
						gitlabOf(await hostFor(c, { uid: meta.uid, repository: repo })),
						repo,
						sandbox,
						signal,
						work,
						pinnedBase,
					)
				: await cloneRepository(
						app!,
						await githubConnection(c, meta),
						repo,
						sandbox,
						signal,
						work,
						pinnedBase,
						meta.uid,
					);
		if (!cloned || signal.aborted) return false;
		const directory = /^(?!\.\.$)[A-Za-z0-9._-]+$/.test(cloned.directory) ? cloned.directory : ".";
		if (cloned.workAt && work) {
			meta.workDue = {
				branch: cloned.workGone ? repo.branch : work,
				at: cloned.workAt,
				directory,
				setupBase: childSeed,
			};
		}
		if (cloned.workGone) {
			meta.pushedHead = null;
			note(
				c,
				turn,
				"warn",
				`${work} is no longer on the remote, so the workspace starts from ${repo.branch} again. Work that was only on that branch is not in it.`,
			);
		}
		c.vars.unpushed = null;
		// The new clone has not been set up: the repository's setup command is due, where the clone is.
		meta.setupDue = repo.provider === "gitlab" ? null : directory;
		meta.cloneDirectory = directory;
	} catch (error) {
		if (error instanceof GithubProblem) {
			if (meta.origin?.role === "reviewer") throw error;
			throw error instanceof GitCredentialRefused
				? new GitAccessRefused(error.message)
				: new TurnProblem(error.message);
		}
		throw error;
	}
	meta.cloned = true;
	void persist(c);
	return true;
}

// Run setup on the base before switching to the session's published work.
export async function putWorkspaceOnWork(
	c: Ctx,
	meta: SessionMeta,
	turn: number,
	sandbox: SandboxHandle,
): Promise<void> {
	const due = meta.workDue;
	const repo = meta.repo;
	if (!due || !repo) return;
	const child = meta.origin?.childBranch;
	const fresh = !meta.pushedHead && child ? child : null;
	const branch = fresh?.name ?? due.branch;
	let head: string;
	try {
		head = await putOnWork(sandbox, due.directory, branch, fresh?.start);
	} catch (error) {
		throw new TurnProblem(
			`The new sandbox could not be put on ${branch}, so nothing was started (${describeError(error)}). Send the prompt again.`,
		);
	}
	meta.workDue = null;
	if (child) repo.baseSha = child.start;
	if (!fresh && branch !== repo.branch) meta.pushedHead = head;
	c.vars.unpushed = null;
	const base = due.setupBase ?? repo.branch;
	// Every agent is told, in a person's session and in an item's alike (`platformNotes`).
	if (due.setUp) meta.setupOnBase = { branch, base };
	note(
		c,
		turn,
		"info",
		`Put the workspace on ${branch} at ${head.slice(0, 7)}.${due.setUp ? ` The setup command ran on ${base} before that, so what the branch changed in its dependencies is not installed.` : ""}`,
	);
	await persist(c);
}

/** One piece of a setup run's output, to connected clients and to those that connect while it runs. */
function setupOutput(c: Ctx, turn: number, id: string, text: string): void {
	const delta: LiveDelta = {
		turn,
		event: {
			type: "setup.output",
			id,
			text: text.length > SETUP_OUTPUT_CHARS ? text.slice(-SETUP_OUTPUT_CHARS) : text,
		},
	};
	c.broadcast("delta", delta);
	// Kept as one delta per run, the end of the output so far: a client that connects late shows what the others do.
	const last = c.vars.pending.at(-1);
	if (last && "event" in last && last.event.type === "setup.output" && last.event.id === id) {
		const joined = `${str(last.event.text)}${text}`;
		c.vars.pending[c.vars.pending.length - 1] = {
			turn,
			event: {
				type: "setup.output",
				id,
				text: joined.length > SETUP_OUTPUT_CHARS ? joined.slice(-SETUP_OUTPUT_CHARS) : joined,
			},
		};
	} else {
		keepDelta(c.vars, delta);
	}
}

// Run the saved setup on each new clone. Record failures for the next prompt without failing the turn.
export async function runSetup(
	c: Ctx,
	meta: SessionMeta,
	turn: number,
	sandbox: SandboxHandle,
	signal: AbortSignal,
	secrets: HeldSecrets | null,
	plan: SnapshotPlan | null,
	layer: SandboxLayer,
): Promise<void> {
	const project = setupProjectOf(meta);
	const directory = meta.setupDue;
	if (!project || typeof directory !== "string") return;
	const saved = await orNull(userActor(c, meta.uid).internalSetupCommand(project.key), RECALL_WAIT_MS);
	if (signal.aborted) return;
	// It stays due, and nothing of the turn is started: the setup only ever runs before the agent's first turn in the sandbox.
	if (saved === null)
		throw new TurnProblem(
			`The setup command for ${project.label} could not be read, so nothing was started in the new sandbox. Send the prompt again.`,
		);
	meta.setupDue = null;
	const command = typeof saved.command === "string" ? saved.command.trim() : "";
	if (command === "") {
		void persist(c);
		return;
	}

	const handed = (secrets?.opened ?? []).filter(secret => meta.origin?.role !== "reviewer" || secret.scope === "setup");
	if (handed.length > 0)
		note(
			c,
			turn,
			"info",
			`The setup command is handed ${handed.length === 1 ? "the secret" : `the ${handed.length} secrets`} saved for ${project.label}, as environment variables: ${handed.map(secret => secret.name).join(", ")}.`,
		);
	const id = `su_${randomBytes(6).toString("hex")}`;
	const limitMs = config.setupTimeoutMs;
	meta.setupRunning = { id, command, limitMs };
	if (meta.workDue) meta.workDue.setUp = true;
	append(c, {
		turn,
		kind: "setup",
		id,
		command,
		state: "started",
		exitCode: null,
		durationMs: null,
		limitMs,
		output: "",
		truncated: false,
	});
	await persist(c);

	const tail = new OutputTail();
	let waiting = "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	const flush = () => {
		clearTimeout(timer);
		timer = undefined;
		if (waiting === "") return;
		const text = waiting;
		waiting = "";
		setupOutput(c, turn, id, text);
	};
	// Sample the pristine checkout before setup can change HEAD or the dependency files.
	const eligible =
		plan?.writer &&
		directory === "." &&
		meta.repo?.branch === plan.defaultBranch &&
		!meta.workDue &&
		!meta.windlassSessionId &&
		snapshotWriter(meta.origin) &&
		handed.length === 0 &&
		saved.updatedAt === plan.updatedAt &&
		command === plan.command;
	// cloneRepository confirmed this immutable checkout against GitHub before setup started.
	const original = eligible ? meta.repo?.baseSha : null;
	const result = await runSetupCommand(sandbox, {
		command,
		cwd: directory === "." ? sandbox.cwd : `${sandbox.cwd}/${directory}`,
		timeoutMs: limitMs,
		signal,
		secretEnv: setupEnvironment(handed),
		redactor: secrets?.redactor,
		onOutput: text => {
			tail.push(text);
			waiting += text;
			if (waiting.length >= SETUP_FLUSH_CHARS) flush();
			else timer ??= setTimeout(flush, SETUP_FLUSH_MS);
		},
	});
	clearTimeout(timer);
	const output = tail.text;
	// The ending item carries the output: the deltas that built it up are not needed any more.
	c.vars.pending = c.vars.pending.filter(
		delta => !("event" in delta && delta.event.type === "setup.output" && delta.event.id === id),
	);
	meta.setupRunning = null;
	append(c, {
		turn,
		kind: "setup",
		id,
		command,
		state: result.state,
		exitCode: result.exitCode,
		durationMs: result.durationMs,
		limitMs,
		output,
		truncated: tail.truncated,
	});
	if (result.problem !== null)
		note(c, turn, "warn", `The setup command for ${project.label} could not be run. ${result.problem}`);
	meta.setupUnfinished =
		result.state === "succeeded"
			? null
			: {
					command,
					state: result.cleanupPending ? "interrupted" : result.state,
					exitCode: result.exitCode,
					limitMs,
					output: lastLines(result.problem === null ? output : `${output}\n${result.problem}`),
				};
	console.log(
		`[wlp] setup.ran session=${meta.sessionId} sandbox=${sandbox.id} project=${project.key} state=${result.state} exit=${result.exitCode ?? "none"} ms=${result.durationMs}`,
	);
	await persist(c);
	if (result.cleanupPending && !meta.environmentBuild)
		throw new TurnProblem(
			"The platform could not stop leftover setup processes. Send the prompt again to retry cleanup.",
		);
	if (meta.environmentBuild) {
		const report = await buildEnvironment(c, meta, turn, sandbox, signal, secrets, plan, layer, {
			result,
			output,
			original: original ?? null,
			command,
		});
		c.vars.environmentResult ??= report;
	}
}

// Setup and environment failures block promotion. A check that fails on the base code is recorded with the image.
async function buildEnvironment(
	c: Ctx,
	meta: SessionMeta,
	turn: number,
	sandbox: SandboxHandle,
	signal: AbortSignal,
	secrets: HeldSecrets | null,
	plan: SnapshotPlan | null,
	layer: SandboxLayer,
	setup: {
		result: Awaited<ReturnType<typeof runSetupCommand>>;
		output: string;
		original: string | null;
		command: string;
	},
): Promise<EnvironmentBuildReport> {
	const commit = setup.original ?? meta.repo?.baseSha ?? "";
	const base: EnvironmentBuildResult = {
		finishedAt: null,
		commit: /^[a-f0-9]{40}$/.test(commit) ? commit : "",
		image: sandbox.image ?? "",
		...(usesScreenshotImage(meta, sandbox, secrets?.screenshots) && { screenshots: true }),
		checks: [],
		failure: null,
		snapshot: false,
	};
	// Builds own a fresh sandbox. A recorded memory kill is a failure even if its connection also broke.
	const memoryFailure = async (): Promise<EnvironmentBuildResult | null> => {
		const events = await sandbox.memoryEvents?.().catch(() => null);
		const exhausted = events
			? events.oomKills > 0
			: await sandbox.memoryPeak?.(meta.turnStartedAt ?? meta.createdAt).catch(() => null);
		return sandbox.outOfMemory || exhausted
			? { ...base, failure: { kind: "setup", check: null, line: "The build ran out of memory.", excerpt: "" } }
			: null;
	};
	if (setup.result.state !== "succeeded" || setup.result.cleanupPending) {
		const memory = await memoryFailure();
		if (memory) return memory;
		const commandFailed =
			setup.result.state === "timed_out" || (setup.result.exitCode !== null && setup.result.exitCode !== 0);
		if (
			!commandFailed &&
			(signal.aborted ||
				setup.result.state === "stopped" ||
				setup.result.connectionLost ||
				(await layer.sandboxes.state(sandbox.id).catch(() => null)) === "none")
		)
			return { interrupted: true };
		const how =
			setup.result.state === "timed_out"
				? "ran out of time"
				: setup.result.exitCode !== null
					? `exited with ${setup.result.exitCode}`
					: "did not finish";
		return {
			...base,
			finishedAt: Date.now(),
			failure: { kind: "setup", check: null, line: `The setup command ${how}.`, excerpt: outputExcerpt(setup.output) },
		};
	}
	const checks = secrets?.checks ?? [];
	// Files the checks write (build outputs, caches the repository ignores) stay; tracked files they change go back.
	const unavailable = (error: unknown) => {
		if (sandboxConnectionLost(error)) throw error;
		return null;
	};
	const clean =
		(
			await sandbox.run("git status --porcelain", { cwd: sandbox.cwd, timeoutMs: 60_000, signal }).catch(unavailable)
		)?.stdout.trim() === "";
	note(
		c,
		turn,
		"info",
		checks.length
			? `Validating: running ${checks.length === 1 ? "the saved check" : `the ${checks.length} saved checks`}.`
			: "No checks are saved, so the environment is validated by its setup alone.",
	);
	const ran = await new PlatformChecks(sandbox, checks, () => undefined, {
		agent: "the build",
		redactor: secrets?.redactor,
		signal,
	}).runAll();
	const judged = judgeChecks(ran);
	for (const r of judged.checks)
		note(
			c,
			turn,
			r.status === "passed" ? "info" : "warn",
			`${r.name}: ${r.status.replace("_", " ")}${r.environment ? ` (the sandbox could not run it: ${r.environment.replace("_", " ")})` : ""}.`,
		);
	const done = {
		...base,
		checks: judged.checks,
		...(judged.codeFailures.length && { codeFailures: judged.codeFailures }),
	};
	if (ran.some(r => r.status !== "passed") || signal.aborted) {
		const memory = await memoryFailure();
		if (memory) return memory;
		if (
			judged.failure &&
			ran.some(r => r.name === judged.failure?.check && (r.status === "timed_out" || r.exitCode !== null))
		) {
			return { ...done, finishedAt: Date.now(), failure: judged.failure };
		}
		if (
			ran.some(r => r.status === "interrupted") ||
			signal.aborted ||
			(ran.some(r => r.status === "could_not_start" || (r.status === "failed" && r.exitCode === null)) &&
				(await layer.sandboxes.state(sandbox.id).catch(() => null)) === "none")
		)
			return { interrupted: true };
	}
	if (judged.failure) return { ...done, finishedAt: Date.now(), failure: judged.failure };
	if (clean)
		await sandbox
			.run("git reset -q --hard HEAD && git clean -fdq", { cwd: sandbox.cwd, timeoutMs: 120_000, signal })
			.catch(unavailable);
	if (signal.aborted) return { interrupted: true };
	// A quick setup is validated, and keeps no image: starting cold costs little more than starting from one.
	if (setup.result.durationMs < config.snapshotMinSetupMs) return { ...done, finishedAt: Date.now() };
	const saveFailed = (line: string): EnvironmentBuildReport =>
		signal.aborted
			? { interrupted: true }
			: { ...done, finishedAt: Date.now(), failure: { kind: "save", check: null, line, excerpt: "" } };
	if (!plan || !setup.original || !layer.sandboxes.saveSnapshot || (plan.commit && setup.original !== plan.commit))
		return saveFailed("This place cannot keep a prepared sandbox of this repository.");
	const project = setupProjectOf(meta);
	const [current, connection] = await Promise.all([
		project ? orNull(userActor(c, meta.uid).internalSetupCommand(project.key), RECALL_WAIT_MS) : null,
		githubConnection(c, meta).catch(() => null),
	]);
	// The setup was changed, or GitHub reconnected, while it ran: what it made is not the current one's.
	if (
		!project ||
		!current ||
		!connection ||
		current.command !== plan.command ||
		snapshotGeneration(plan.key.repo, current.updatedAt, connection.connectedAt) !== plan.key.generation
	)
		return saveFailed("The setup command or the GitHub connection changed while it ran.");
	let inputs = plan.key.inputs;
	if (inputs === DEFERRED_INPUTS) {
		const app = githubApp(),
			repo = meta.repo;
		const revision = app && repo ? await setupRevision(app, connection, repo, setup.original).catch(() => null) : null;
		if (!revision?.dependencies || revision.commit !== setup.original || revision.defaultBranch !== repo?.branch)
			return saveFailed("The repository has no lockfile the platform can key a prepared sandbox on.");
		inputs = digest([revision.dependencies, setup.command]);
	}
	const began = Date.now();
	note(
		c,
		turn,
		"info",
		judged.codeFailures.length
			? `The sandbox ran every check; ${judged.codeFailures.join(", ")} failed on the base commit's code. Saving the prepared sandbox.`
			: "Every check passed. Saving the prepared sandbox.",
	);
	const saved = await layer.sandboxes
		.saveSnapshot(sandbox.id, { ...plan.key, inputs, commit: setup.original, created: began })
		.catch(unavailable);
	if (!saved && (signal.aborted || (await layer.sandboxes.state(sandbox.id).catch(() => null)) === "none"))
		return { interrupted: true };
	if (!saved)
		return saveFailed(
			"The prepared sandbox could not be saved here: the place's storage limits, or its free disk, left no room.",
		);
	await userActor(c, meta.uid)
		.internalSnapshotSaved(
			project.key,
			plan.updatedAt,
			connection.connectedAt,
			meta.place.kind === "hosted" ? "hosted" : meta.place.machineId,
		)
		.catch(() => undefined);
	note(c, turn, "info", `Saved the prepared sandbox in ${Math.round((Date.now() - began) / 1000)} seconds.`);
	return { ...done, finishedAt: Date.now(), snapshot: true };
}
