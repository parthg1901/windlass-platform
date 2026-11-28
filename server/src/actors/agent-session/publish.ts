// Publishing the session's work: the panel's publish, pull request state, and the agent's publish, push and fetch requests.
import { randomBytes } from "node:crypto";
import { UserError } from "rivetkit";
import {
	publishQuestionWords,
	PUBLISH_DENY,
	PUBLISH_SESSION,
	callLine,
	publishRequest,
	type PublishAllowed,
	PUBLISH_WITHDRAWN,
	publishUnanswered,
	publishDeclined,
	publishAllowedWords,
	publishedForAgent,
	publishFailed,
	pushRequest,
	nothingToPush,
	agentPushedLine,
	pushedForAgent,
	fetchedForAgent,
} from "../../agent-publish.js";
import { describeError } from "../../auth.js";
import { config } from "../../config.js";
import {
	type WorkspaceFile,
	type PublishMessage,
	type TimelineItem,
	promptTitle,
	MAX_PUBLISH_TITLE_CHARS,
	type PublishState,
	type PullRequestInfo,
	type BlockedNetwork,
	type PublishResult,
	MAX_PUBLISH_BODY_CHARS,
} from "../../contract.js";
import { githubApp } from "../../github/app.js";
import { gitlabApp } from "../../gitlab/connect.js";
import { fetchGitlab, pushGitlab } from "../../gitlab/workspace.js";
import { gitlabOf } from "../gitlab-item.js";
import { hostFor } from "../../codehost/item.js";
import { branchFor, freeBranchAt, wantedBranch } from "../../codehost/branch.js";
import { actuallyPushed } from "../../github/git.js";
import {
	type StoredRepository,
	hasUnpushedWork,
	refreshPull,
	type PublishEvidence,
	fetchBase,
	updateBranchFromBase,
	pushWork,
	publishWork,
	PullProblem,
	type Published,
	describePull,
} from "../../github/publish.js";
import { GithubProblem } from "../../github/repos.js";
import type { SandboxHandle, TurnPublishRequest } from "../../sandbox/api.js";
import { type CommandSandbox, NO_REDACTION } from "../../repo-secrets.js";
import { hostedLimitsApply } from "../../usage.js";
import { type NamedTests, type BaseTestResult, runBaseTests } from "../../factory/base-tests.js";
import { machineHarness } from "../../sandbox/harnesses.js";
import { serial, writeItems, persist, note } from "./timeline.js";
import { str, takeQuestion, duration } from "./questions.js";
import type { Ctx, SessionMeta, ActiveTurn, PublishAnswer, Asked } from "./state.js";
import { layerOf, machineOf } from "./runner.js";
import { repositoryOf, publish } from "./summary.js";
import { takeSandbox, connectOptions, sandboxChanged, githubConnection } from "./common.js";
import { savedWorkspace, dropWorkspace } from "./workspace.js";
import { readSecrets } from "./secrets.js";
import { carriedOver, holdSandbox, noteSandbox, markUsed } from "./meter.js";
import { copyWorkspace } from "./sandbox.js";

/** How long the panel's publish waits for a push under way before it says so: well inside the action's own limit. */
export const PUBLISH_WAIT_MS = 60_000;

/** Resolves true once no push of the platform's is under way (`c.vars.publishing`), false when `ms` ran out first. */
export async function publishingSettled(c: Ctx, ms: number): Promise<boolean> {
	const until = Date.now() + ms;
	while (c.vars.publishing) {
		if (Date.now() >= until) return false;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return true;
}

/** `publishSession`'s refusal for a GitHub problem, with whether trying again later can cure it: GitHub was out of reach, or the push took too long. */
export class PublishRefused extends UserError {
	constructor(
		message: string,
		code: string,
		readonly transient: boolean,
	) {
		super(message, { code });
	}
}

/** How long GitHub's word on the pull request's state is taken before it is asked again. */
const PULL_FRESH_MS = 20_000;

/** Shortens `text` to about `limit` characters, at the end of a paragraph or a sentence where there is one. */
export function brief(text: string, limit: number): string {
	const clean = text.replace(/\r/g, "").trim();
	if (clean.length <= limit) return clean;
	const cut = clean.slice(0, limit);
	const paragraph = cut.lastIndexOf("\n\n");
	const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
	if (paragraph > limit / 3) return cut.slice(0, paragraph).trim();
	if (sentence > limit / 3) return cut.slice(0, sentence + 1).trim();
	return `${cut.slice(0, cut.lastIndexOf(" ") > limit / 2 ? cut.lastIndexOf(" ") : limit).trim()}…`;
}

async function draftMessage(c: Ctx, meta: SessionMeta, files: WorkspaceFile[] | null): Promise<PublishMessage> {
	const rows = await serial(c, async () => {
		await writeItems(c).catch(() => undefined);
		return c.db.execute<{ item: string }>(
			"SELECT item FROM timeline WHERE kind IN ('windlass', 'user') ORDER BY seq DESC LIMIT 400",
		);
	}).catch(() => []);
	let answer = "";
	let prompt = "";
	for (const row of rows) {
		const item = JSON.parse(row.item) as TimelineItem;
		if (answer === "" && item.kind === "windlass" && item.event.type === "text.ended")
			answer = str(item.event.data?.text).trim();
		if (prompt === "" && item.kind === "user" && item.steer !== true) prompt = item.text;
		if (answer !== "" && prompt !== "") break;
	}
	// Until there is a pull request the title is the session's: a push whose pull request GitHub refused is no reason for another.
	const first = !meta.pull;
	const title = (first || prompt === "" ? meta.title : promptTitle(prompt)).trim().slice(0, MAX_PUBLISH_TITLE_CHARS);
	let body = brief(answer, 600);
	if (body === "" && files && files.length > 0) {
		const listed = files.slice(0, 10).map(file => `- ${file.path}`);
		if (files.length > listed.length) listed.push(`- and ${files.length - listed.length} more`);
		body = `Changed files:\n${listed.join("\n")}`;
	}
	return { title: title === "" ? "Changes from Windlass" : title, body };
}

/** Why nothing can be pushed right now, or null. */
export function publishBlocked(c: Ctx, meta: SessionMeta): string | null {
	if (meta.origin?.role === "reviewer") return "The reviewer cannot publish.";
	if (meta.repo?.provider === "gitlab" && !gitlabApp()) return "This deployment no longer has GitLab configured.";
	if (meta.repo?.provider !== "gitlab" && !githubApp())
		return "This deployment has no GitHub App any more, so the platform cannot push.";
	if (c.vars.turn || c.vars.accepting || meta.status !== "idle")
		return "Wait for the turn to end: the platform does not push while the agent is working.";
	if (c.vars.publishing) return "A push is under way.";
	if (!meta.sandboxId) return "The sandbox is created on the first prompt. Until then there is nothing to push.";
	return null;
}

// A clean worktree can still hold unpublished commits.
export async function unpushedWork(
	c: Ctx,
	meta: SessionMeta,
	repo: StoredRepository,
	files: WorkspaceFile[] | null,
): Promise<boolean | null> {
	if (c.vars.turn || !meta.sandboxId) return null;
	if (files && files.length > 0) return true;
	const key = `${meta.turns}:${repo.baseSha ?? ""}:${meta.pushedHead ?? ""}:${meta.sandboxId}`;
	if (c.vars.unpushed?.key === key) return c.vars.unpushed.value;
	// Cache the observation only for the turn and push head it describes.
	if (meta.unpushed?.key === key) return meta.unpushed.value;
	let value: boolean | null = null;
	// Under the sandbox's guard from the read of its state to the end: an idle suspend in between would be undone by the connect, uncounted.
	const release = takeSandbox(c);
	try {
		const { sandboxes } = await layerOf(c, meta);
		if (
			!c.vars.idling &&
			(!hostedLimitsApply(meta.place) || meta.meter) &&
			(await sandboxes.state(meta.sandboxId)) === "running"
		) {
			const sandbox = await sandboxes.connect(meta.sandboxId, connectOptions(meta));
			sandboxChanged(c);
			if (sandbox && !c.vars.turn)
				value = await hasUnpushedWork(sandbox, repo.baseSha ?? null, meta.pushedHead ?? null);
		}
	} catch (error) {
		c.log.warn({ msg: "could not read whether the workspace has commits to push", error: describeError(error) });
	} finally {
		release();
	}
	if (value !== null) {
		c.vars.unpushed = { key, value };
		meta.unpushed = { key, value };
		void persist(c);
	}
	return value;
}

export async function publishStateOf(c: Ctx, meta: SessionMeta): Promise<PublishState> {
	const repo = meta.repo;
	if (!repo)
		return {
			repository: null,
			pullRequest: null,
			branch: "",
			changes: null,
			draft: { title: "", body: "" },
			blocked: null,
			pushed: null,
		};
	const files = c.vars.turn ? null : ((await savedWorkspace(c))?.files ?? null);
	const [changes, draft] = await Promise.all([unpushedWork(c, meta, repo, files), draftMessage(c, meta, files)]);
	return {
		repository: repositoryOf(repo),
		pullRequest: meta.pull ?? null,
		branch: shownBranch(meta),
		changes,
		draft,
		blocked: publishBlocked(c, meta),
		pushed: meta.pushedHead ?? null,
	};
}

/** Asks GitHub what became of the pull request, at most every few seconds; a change goes to every client with the summary. */
export async function checkPull(c: Ctx, meta: SessionMeta): Promise<void> {
	const app = githubApp();
	const { repo, pull } = meta;
	if (!app || !repo || repo.provider === "gitlab" || !pull || Date.now() - c.vars.pullCheckedAt < PULL_FRESH_MS) return;
	c.vars.pullCheckedAt = Date.now();
	const current = await refreshPull(app, await githubConnection(c, meta), repo, pull);
	if (meta.pull !== pull || (current.state === pull.state && current.title === pull.title)) return;
	meta.pull = current;
	meta.updatedAt = Date.now();
	publish(c);
	void persist(c);
}

/** A push's line in the timeline: what went where, in the words of the other platform notes. */
function publishedLine(repo: StoredRepository, pull: PullRequestInfo, opened: boolean, files: number | null): string {
	const what =
		files === null ? "the work" : files === 0 ? "the agent's commits" : files === 1 ? "1 file" : `${files} files`;
	if (opened)
		return `Opened pull request #${pull.number} in ${repo.owner}/${repo.name} from ${pull.branch}${files === null ? "" : `, with ${what}`}.`;
	return `Pushed ${what} to ${pull.branch}; pull request #${pull.number} is updated.`;
}

export async function evidenceOf(c: Ctx, meta: SessionMeta, during: number | null): Promise<PublishEvidence> {
	const held = c.vars.turn?.secrets ?? (await readSecrets(c, meta, null));
	return {
		verified: meta.verified ?? null,
		during,
		checks: held.checks,
		redact: text => held.redactor.text(text),
		machine: machineOf(meta),
	};
}

/** Test a copy of the pinned base in the builder's existing sandbox, under its ordinary usage hold. */
export async function testSessionBase(
	c: Ctx,
	meta: SessionMeta,
	repo: StoredRepository,
	input: { base: string; tests: NamedTests },
): Promise<BaseTestResult> {
	const release = takeSandbox(c);
	try {
		if (c.vars.idling) await c.vars.idling.catch(() => undefined);
		if (!meta.sandboxId || c.vars.turn || c.vars.publishing) return "unknown";
		const { sandboxes } = await layerOf(c, meta);
		if (!meta.meter || carriedOver(c, meta)) await holdSandbox(c, meta, true);
		const sandbox = await sandboxes.connect(meta.sandboxId, connectOptions(meta));
		sandboxChanged(c);
		if (!sandbox) return "unknown";
		noteSandbox(c, meta, "running");
		markUsed(c, meta);
		const cwd =
			meta.cloneDirectory && meta.cloneDirectory !== "." ? sandbox.cwd + "/" + meta.cloneDirectory : sandbox.cwd;
		if (
			(await sandbox.run(`GIT_NO_REPLACE_OBJECTS=1 git cat-file -e ${input.base}^{commit}`, { cwd, timeoutMs: 10_000 }))
				.exitCode !== 0
		) {
			await fetchSessionBase(c, meta, { ...repo }, sandbox);
		}
		const isolated =
			sandboxes.profile(meta.profile).approval !== "full" ||
			!!meta.tainted ||
			!!machineHarness(meta.harness)?.sandboxedOn.includes(meta.profile);
		return await runBaseTests(sandbox, cwd, input.base, input.tests, isolated);
	} finally {
		release();
		markUsed(c, meta);
	}
}

/**
 * The branch the session pushes to, decided the first time a push or a request to publish needs it and kept
 * from then on: a work item's agent's is named as its item names it; any other is named for the title, as
 * its code host does not have it yet. Where the host cannot say which names are free, the title with the end
 * of the session's id, as before.
 */
async function branchOf(c: Ctx, meta: SessionMeta, repo: StoredRepository): Promise<string> {
	if (meta.publishBranch) return meta.publishBranch;
	const fallback = branchFor(meta.title, meta.sessionId);
	const picked =
		meta.origin?.kind === "item"
			? fallback
			: await hostFor(c, { uid: meta.uid, repository: repo })
					.then(host => freeBranchAt(host, meta.title))
					.catch(() => fallback);
	// A second request that asked the host at the same time keeps what the first one decided.
	meta.publishBranch ??= picked;
	void persist(c);
	return meta.publishBranch;
}

/** What the push dialog names before the first push: `branchOf` without asking the host. */
function shownBranch(meta: SessionMeta): string {
	if (meta.publishBranch) return meta.publishBranch;
	return meta.origin?.kind === "item" ? branchFor(meta.title, meta.sessionId) : wantedBranch(meta.title);
}

/** After a push's line in the timeline: what the pull request's description now says was verified, in its few words. */
export const verifiedLine = (pull: PullRequestInfo) => ` Its description reports: ${pull.verified}.`;

export async function openGitlabItemPull(
	c: Ctx,
	meta: SessionMeta,
	input: { head: string; title: string; body: string },
): Promise<PullRequestInfo> {
	const repo = meta.repo;
	const app = gitlabApp();
	if (
		!app ||
		repo?.provider !== "gitlab" ||
		meta.origin?.role !== "builder" ||
		!meta.publishBranch ||
		!meta.pushedHead ||
		meta.pushedHead !== input.head
	)
		throw new UserError("No confirmed GitLab branch for this item.", { code: "publish_blocked" });
	const branch = meta.publishBranch;
	const hub = gitlabOf(await hostFor(c, { uid: meta.uid, repository: repo }));
	if ((await hub.gitlab.baseTip(branch)) !== input.head)
		throw new UserError("The item branch changed before its merge request could be opened.", {
			code: "publish_blocked",
		});
	const evidence = await evidenceOf(c, meta, null);
	const { viewer, token, project } = hub.gitlab;
	const connection = { id: viewer, accessToken: async () => token, project };
	const pull = await hub.host.openFromPushed({
		connection,
		repository: repo,
		branch,
		message: cleanMessage({ message: { title: evidence.redact(input.title), body: evidence.redact(input.body) } }),
		evidence,
	});
	meta.pull = pull;
	publish(c);
	await persist(c);
	return pull;
}

// The caller owns the publishing lock so a second push cannot race this one.
export async function publishSession(
	c: Ctx,
	meta: SessionMeta,
	repo: StoredRepository,
	message: PublishMessage,
	itemPublish = false,
	branchOnly = false,
	blockedNetwork?: BlockedNetwork,
	updateFromBase?: { head: string; at: number; baseTip?: string },
): Promise<PublishResult> {
	const app = githubApp();
	if ((!app && repo.provider !== "gitlab") || !meta.sandboxId)
		throw new UserError(publishBlocked(c, meta) ?? "There is nothing to push yet.", { code: "publish_blocked" });
	// A suspend or removal of the idle sandbox finishes first, as before a prompt.
	if (c.vars.idling) await c.vars.idling.catch(() => undefined);
	const { sandboxes } = await layerOf(c, meta);
	// A push starts a paused sandbox, which uses its user's sandbox time; a stretch carried over a wake is settled as for a read (`workspaceView`).
	if (!meta.meter || carriedOver(c, meta)) await holdSandbox(c, meta, true);
	const sandbox = meta.sandboxId ? await sandboxes.connect(meta.sandboxId, connectOptions(meta)) : undefined;
	sandboxChanged(c);
	if (!sandbox) {
		noteSandbox(c, meta, "none");
		throw new UserError(
			"The sandbox with this agent's files is gone, so there is nothing to push. The next prompt starts a new one from the repository.",
			{ code: "publish_blocked" },
		);
	}
	noteSandbox(c, meta, "running");
	// Pushing uses the sandbox: the idle times count from here, and again from when it is done.
	markUsed(c, meta);
	const branch = await branchOf(c, meta, repo);
	try {
		// An item's step pushes over the platform's own last push where its agent rebased and did not push; the panel's never forces.
		if (repo.provider === "gitlab" || branchOnly || updateFromBase) {
			const evidence = await evidenceOf(c, meta, null);
			const input = {
				app: app!,
				connection: await githubConnection(c, meta),
				repository: repo,
				sandbox,
				sessionId: meta.sessionId,
				branch,
				pushed: meta.pushedHead ?? null,
				lease: itemPublish ? (meta.platformPushed ?? null) : null,
				redact: evidence.redact,
			};
			const pushed =
				repo.provider === "gitlab"
					? await pushGitlab(
							gitlabOf(await hostFor(c, { uid: meta.uid, repository: repo })),
							input,
							message.title,
							updateFromBase,
						)
					: updateFromBase
						? await updateBranchFromBase(input, updateFromBase)
						: await pushWork(input, message.title);
			if (pushed.workspaceChanged || !pushed.head)
				throw new UserError("Git did not confirm the checked item commit.", { code: "publish_failed" });
			recordPushHead(meta, sandbox, pushed.head);
			return { state: await afterPublish(c, meta, sandbox), opened: false };
		}
		const published = await publishWork({
			app: app!,
			connection: await githubConnection(c, meta),
			repository: repo,
			sandbox,
			sessionId: meta.sessionId,
			branch,
			pull: meta.pull ?? null,
			pushed: meta.pushedHead ?? null,
			lease: itemPublish ? (meta.platformPushed ?? null) : null,
			message,
			blockedNetwork,
			shownIsEnough: itemPublish,
			retitle: itemPublish,
			keepTitle: itemPublish,
			evidence: await evidenceOf(c, meta, null),
		});
		if (published.head) published.pushed = recordPushHead(meta, sandbox, published.head);
		meta.pull = published.pull;
		meta.updatedAt = Date.now();
		c.vars.pullCheckedAt = Date.now();
		// Nothing pushed is the item's step after its agent pushed everything itself: the pull request was only described again.
		const line =
			published.pushed || published.opened
				? publishedLine(repo, published.pull, published.opened, published.committedFiles)
				: `${published.pull.branch} at GitHub already had the agent's work; pull request #${published.pull.number} is described again.`;
		note(c, meta.turns, "info", `${line}${verifiedLine(published.pull)}`);
		console.log(
			`[wlp] github.published session=${meta.sessionId} repository=${repo.id} pull=${published.pull.number} opened=${published.opened}`,
		);
		return { state: await afterPublish(c, meta, sandbox), opened: published.opened };
	} catch (error) {
		// The push went through and the pull request did not: what is at GitHub is remembered, so the next try only opens it.
		if (error instanceof PullProblem && error.head) recordPushHead(meta, sandbox, error.head);
		await afterPublish(c, meta, sandbox).catch(() => undefined);
		if (error instanceof GithubProblem) {
			console.warn(`[wlp] github.publish_failed session=${meta.sessionId} repository=${repo.id}: ${error.code}`);
			throw new PublishRefused(
				error.message,
				error.code === "github_gone" || error.code === "github_denied" ? error.code : "publish_failed",
				error.code === "github_unreachable",
			);
		}
		throw error;
	}
}

/** After a push, or one that failed half way: the commit changed what differs from the last commit, so the copy is taken again. */
async function afterPublish(c: Ctx, meta: SessionMeta, sandbox: SandboxHandle): Promise<PublishState> {
	c.vars.unpushed = null;
	if (!c.vars.turn && !((await copyWorkspace(c, meta, sandbox)) ?? null)) await dropWorkspace(c);
	markUsed(c, meta);
	publish(c);
	await persist(c);
	return publishStateOf(c, meta);
}

/** An observed remote head is useful for the next probe. Only a confirmed ref update grants a lease. */
export function recordPushHead(
	meta: Pick<SessionMeta, "pushedHead" | "platformPushed">,
	sandbox: SandboxHandle,
	head: string,
): boolean {
	meta.pushedHead = head;
	if (!actuallyPushed(sandbox, head)) return false;
	meta.platformPushed = head;
	return true;
}

/** The message of a push as the client sent it, checked. */
export function cleanMessage(input: unknown): PublishMessage {
	const message = (typeof input === "object" && input !== null ? (input as { message?: unknown }).message : null) as {
		title?: unknown;
		body?: unknown;
	} | null;
	if (
		typeof message !== "object" ||
		message === null ||
		typeof message.title !== "string" ||
		(message.body !== undefined && message.body !== null && typeof message.body !== "string")
	) {
		throw new UserError("Give the commit a title.", { code: "bad_message" });
	}
	const title = message.title.replace(/\s+/g, " ").trim();
	const body = typeof message.body === "string" ? message.body.replace(/\r/g, "").trim() : "";
	if (title === "") throw new UserError("Give the commit a title.", { code: "bad_message" });
	if (title.length > MAX_PUBLISH_TITLE_CHARS)
		throw new UserError(`The title is ${title.length} characters long; the limit is ${MAX_PUBLISH_TITLE_CHARS}.`, {
			code: "bad_message",
		});
	if (body.length > MAX_PUBLISH_BODY_CHARS)
		throw new UserError(`The description is ${body.length} characters long; the limit is ${MAX_PUBLISH_BODY_CHARS}.`, {
			code: "bad_message",
		});
	return { title, body };
}

/** A push's line for a request of the agent's, which may also have given an open pull request another title and description. */
function agentPublishedLine(repo: StoredRepository, published: Published): string {
	const { pull } = published;
	if (!published.pushed && published.retitled)
		return `Gave pull request #${pull.number} the title and description the agent wrote; there was nothing new to push.`;
	const line = publishedLine(repo, pull, published.opened, published.committedFiles);
	return published.retitled ? `${line.replace(/\.$/, "")}, with the title and description the agent wrote.` : line;
}

// A publish question shares the tool-call question slot and ends with the request or turn.
function askPublish(
	c: Ctx,
	meta: SessionMeta,
	active: ActiveTurn,
	request: TurnPublishRequest,
	words: ReturnType<typeof publishQuestionWords>,
	withdrawn: AbortSignal,
): Promise<PublishAnswer> {
	const gone = () => active.closed || active.stopping || active.controller.signal.aborted || withdrawn.aborted;
	if (gone()) return Promise.resolve({ kind: "withdrawn" });
	const now = Date.now();
	return new Promise<PublishAnswer>(resolve => {
		let done = false;
		let shown = false;
		const settle = (answer: PublishAnswer): void => {
			if (done) return;
			done = true;
			withdrawn.removeEventListener("abort", onWithdrawn);
			active.unsettled.delete(asked);
			const at = active.aside.indexOf(asked);
			if (at >= 0) active.aside.splice(at, 1);
			clearTimeout(asked.timer);
			resolve(answer);
		};
		const asked: Asked = {
			pending: {
				id: `q_${randomBytes(8).toString("hex")}`,
				turn: active.number,
				messageId: request.messageId,
				callId: request.callId,
				title: words.title,
				subject: words.subject,
				details: words.details,
				choices: words.choices,
				subagent: null,
				askedAt: now,
				expiresAt: now + config.questionTimeoutMs,
				publish: words.publish,
			},
			timer: undefined,
			answer: answer =>
				settle(
					answer.choice === PUBLISH_DENY
						? { kind: "declined", note: answer.note }
						: { kind: "allowed", how: answer.choice === PUBLISH_SESSION ? "session" : "once" },
				),
			decline: () => settle({ kind: "withdrawn" }),
			put: () => {
				// Put again after it stood aside, it has the whole time to be answered in once more.
				if (shown) asked.pending = { ...asked.pending, expiresAt: Date.now() + config.questionTimeoutMs };
				shown = true;
				asked.timer = setTimeout(
					() => {
						if (active.question !== asked) return;
						takeQuestion(c, meta, active);
						publish(c);
						void persist(c);
						settle({ kind: "expired" });
					},
					Math.max(0, asked.pending.expiresAt - Date.now()),
				);
				active.question = asked;
				if (meta.status === "running") meta.status = "waiting";
				c.broadcast("question", asked.pending);
				publish(c);
				void persist(c);
			},
		};
		// The call ended, or the turn did: nobody waits for the answer.
		function onWithdrawn(): void {
			if (done) return;
			if (active.question === asked) {
				takeQuestion(c, meta, active);
				publish(c);
				void persist(c);
			}
			settle({ kind: "withdrawn" });
		}
		withdrawn.addEventListener("abort", onWithdrawn, { once: true });
		active.unsettled.add(asked);
		if (active.question) active.aside.push(asked);
		else asked.put?.();
	});
}

// Only publish the session's repository and branch. Approval scope depends on the caller's isolation.
export async function agentPublish(
	c: Ctx,
	meta: SessionMeta,
	active: ActiveTurn,
	sandbox: SandboxHandle,
	profileCommands: CommandSandbox,
	request: TurnPublishRequest,
	withdrawn: AbortSignal,
): Promise<string> {
	const turn = active.number;
	// A call over MCP may be any process's in the container: it is asked about as where commands are not sandboxed, whatever the profile.
	const commands: CommandSandbox = request.via === "mcp" ? "none" : profileCommands;
	const said = (line: string) => callLine(request.via, line);
	const repo = meta.repo;
	const app = githubApp();
	if (repo?.provider === "gitlab") return "Use push for this repository. The work item opens its GitLab merge request.";
	if (!repo || !app)
		return "Not published. This session has no repository of the user's GitHub connection to publish to.";
	const branch = await branchOf(c, meta, repo);
	const checked = publishRequest(
		request.arguments,
		{ branch, base: repo.branch },
		active.secrets?.redactor ?? NO_REDACTION,
	);
	if (!checked.ok) {
		note(c, turn, "warn", said(checked.said));
		return checked.told;
	}
	// One at a time, as from the panel: a second request meanwhile is told to wait for the first.
	if (c.vars.publishing) {
		note(
			c,
			turn,
			"info",
			said(
				"The agent asked to publish while an earlier request of its was still being handled, so this one was refused.",
			),
		);
		return "Not published. An earlier request to publish is still being handled. Wait for its result before you ask again.";
	}
	c.vars.publishing = true;
	try {
		let allowed: PublishAllowed = "unasked";
		if (meta.publishUnasked !== true || commands !== "windlass") {
			const open = meta.pull && (meta.pull.state === "open" || meta.pull.state === "draft") ? meta.pull : null;
			const words = publishQuestionWords({
				repository: `${repo.owner}/${repo.name}`,
				branch,
				base: repo.branch,
				message: checked.message,
				open,
				sandbox: commands,
				...(request.via && { via: request.via }),
			});
			const answer = await askPublish(c, meta, active, request, words, withdrawn);
			if (answer.kind === "withdrawn") return PUBLISH_WITHDRAWN;
			if (answer.kind === "expired") {
				const unanswered = publishUnanswered(words.title, duration(config.questionTimeoutMs));
				note(c, turn, "warn", said(unanswered.said));
				return unanswered.told;
			}
			if (answer.kind === "declined") {
				const declined = publishDeclined(answer.note);
				note(c, turn, "info", said(declined.said));
				return declined.told;
			}
			allowed = answer.how;
			if (answer.how === "session" && commands === "windlass") {
				meta.publishUnasked = true;
				publish(c);
				void persist(c);
			}
		}

		try {
			const published = await publishWork({
				app,
				connection: await githubConnection(c, meta),
				repository: repo,
				sandbox,
				sessionId: meta.sessionId,
				branch,
				pull: meta.pull ?? null,
				pushed: meta.pushedHead ?? null,
				message: checked.message,
				retitle: true,
				evidence: await evidenceOf(c, meta, turn),
			});
			if (published.head) published.pushed = recordPushHead(meta, sandbox, published.head);
			meta.pull = published.pull;
			meta.updatedAt = Date.now();
			c.vars.pullCheckedAt = Date.now();
			// What went out had not been through this turn's checks: the description is written again when the turn has ended.
			active.published = true;
			note(
				c,
				turn,
				"info",
				said(`${publishAllowedWords(allowed)} ${agentPublishedLine(repo, published)} ${published.pull.url}`),
			);
			console.log(
				`[wlp] github.published session=${meta.sessionId} repository=${repo.id} pull=${published.pull.number} opened=${published.opened} by=agent asked=${allowed !== "unasked"}`,
			);
			return publishedForAgent({
				repository: `${repo.owner}/${repo.name}`,
				pull: published.pull,
				opened: published.opened,
				pushed: published.pushed,
				retitled: published.retitled,
				files: published.committedFiles,
			});
		} catch (error) {
			// The push went through and the pull request did not: what is at GitHub is remembered, as after a push from the panel.
			if (error instanceof PullProblem && error.head) recordPushHead(meta, sandbox, error.head);
			if (!(error instanceof GithubProblem))
				c.log.error({
					msg: "could not publish for the agent",
					session: meta.sessionId,
					turn,
					error: describeError(error),
				});
			else
				console.warn(
					`[wlp] github.publish_failed session=${meta.sessionId} repository=${repo.id}: ${error.code} by=agent`,
				);
			const failed = publishFailed(
				allowed,
				error instanceof GithubProblem ? error.message : "The platform could not push the work. Try again.",
			);
			note(c, turn, "warn", said(failed.said));
			return failed.told;
		} finally {
			// The commit changed what differs from the last commit, and what GitHub lacks: both are read again when the turn ends.
			c.vars.unpushed = null;
			publish(c);
			await persist(c);
		}
	} catch (error) {
		c.log.error({
			msg: "could not handle the agent's request to publish",
			session: meta.sessionId,
			turn,
			error: describeError(error),
		});
		return "Not published. The platform could not handle the request. Tell the user; do not try another way to publish.";
	} finally {
		c.vars.publishing = false;
	}
}

// An agent push can race turn closure. Track it until the commit, push and receipt finish.
export async function agentPush(
	c: Ctx,
	meta: SessionMeta,
	active: ActiveTurn,
	sandbox: SandboxHandle,
	request: TurnPublishRequest,
): Promise<string> {
	const turn = active.number;
	const said = (line: string) => callLine(request.via, line);
	const repo = meta.repo;
	const app = githubApp();
	if (!repo || (!app && repo.provider !== "gitlab"))
		return "Not pushed. This session has no repository of the user's GitHub connection to push to.";
	const ended = () => active.closed || c.vars.turn !== active;
	if (ended()) return "Not pushed. The turn this call was made in has ended.";
	const branch = await branchOf(c, meta, repo);
	// Naming the branch may have asked the code host: the turn can have ended meanwhile.
	if (ended()) return "Not pushed. The turn this call was made in has ended.";
	const checked = pushRequest(
		request.arguments,
		{ branch, title: meta.title },
		active.secrets?.redactor ?? NO_REDACTION,
	);
	if (!checked.ok) {
		note(c, turn, "warn", said(checked.said));
		return checked.told;
	}
	if (c.vars.publishing) {
		note(
			c,
			turn,
			"info",
			said(
				"The agent asked to push while an earlier push or request to publish was still being handled, so this one was refused.",
			),
		);
		return "Not pushed. An earlier push or request to publish is still being handled. Wait for its result before you push again.";
	}
	c.vars.publishing = true;
	const release = takeSandbox(c);
	// What the platform itself pushed last is all the push may replace: the agent's rebase of its own branch, nothing anyone else pushed.
	const lease = meta.platformPushed ?? null;
	try {
		const input = {
			repository: repo,
			sandbox,
			sessionId: meta.sessionId,
			branch,
			pushed: meta.pushedHead ?? null,
			lease,
			redact: (text: string) => (active.secrets?.redactor ?? NO_REDACTION).text(text),
		};
		const pushed =
			repo.provider === "gitlab"
				? await pushGitlab(gitlabOf(await hostFor(c, { uid: meta.uid, repository: repo })), input, checked.commit)
				: await pushWork({ ...input, app: app!, connection: await githubConnection(c, meta) }, checked.commit);
		if (pushed.pushed && pushed.head) pushed.pushed = recordPushHead(meta, sandbox, pushed.head);
		if (pushed.workspaceChanged) {
			const line = `GitHub has ${pushed.head} on ${branch}. The workspace Git state could not be synchronized after the push. Use fetch_base and reconcile the branch before pushing again.`;
			active.published = true;
			note(c, turn, "warn", said(line));
			return line;
		}
		if (!pushed.pushed) {
			note(
				c,
				turn,
				"info",
				said(`The agent asked to push; ${branch} at GitHub already had everything in the workspace.`),
			);
			return nothingToPush(branch);
		}
		meta.updatedAt = Date.now();
		// What went out had not been through this turn's checks: an open pull request's section is written again when the turn has ended.
		active.published = true;
		const open = meta.pull && (meta.pull.state === "open" || meta.pull.state === "draft") ? meta.pull : null;
		const described =
			open && app && repo.provider !== "gitlab"
				? await describePull({
						app,
						connection: await githubConnection(c, meta),
						repository: repo,
						sandbox,
						pull: open,
						evidence: await evidenceOf(c, meta, turn),
					})
				: null;
		if (described && meta.pull === open) meta.pull = described;
		c.vars.pullCheckedAt = Date.now();
		const shown = described ?? open;
		note(c, turn, "info", said(agentPushedLine({ branch, head: pushed.head, forced: pushed.forced, pull: shown })));
		console.log(`[wlp] github.pushed session=${meta.sessionId} repository=${repo.id} by=agent forced=${pushed.forced}`);
		return pushedForAgent({
			branch,
			head: pushed.head,
			forced: pushed.forced,
			files: pushed.committedFiles,
			pull: shown,
		});
	} catch (error) {
		if (!(error instanceof GithubProblem))
			c.log.error({ msg: "could not push for the agent", session: meta.sessionId, turn, error: describeError(error) });
		else
			console.warn(`[wlp] github.push_failed session=${meta.sessionId} repository=${repo.id}: ${error.code} by=agent`);
		const why = error instanceof GithubProblem ? error.message : "The platform could not push the work. Try again.";
		note(c, turn, "warn", said(`The agent asked to push, and it did not go through: ${why}`));
		return `Not pushed. ${why}`;
	} finally {
		// The commit changed what differs from the last commit, and what GitHub lacks: both are read again when the turn ends.
		c.vars.unpushed = null;
		c.vars.publishing = false;
		release();
		publish(c);
		await persist(c);
	}
}

// Fetch the session's configured base using a repository-scoped read token.
export async function fetchSessionBase(
	c: Ctx,
	meta: SessionMeta,
	repo: StoredRepository,
	sandbox: SandboxHandle,
	work: string | null = null,
) {
	if (repo.provider === "gitlab")
		return fetchGitlab(gitlabOf(await hostFor(c, { uid: meta.uid, repository: repo })), repo, sandbox, work);
	const app = githubApp();
	if (!app) throw new Error("GitHub is not configured.");
	return fetchBase(app, await githubConnection(c, meta), repo, sandbox, work);
}

export async function agentFetchBase(
	c: Ctx,
	meta: SessionMeta,
	active: ActiveTurn,
	sandbox: SandboxHandle,
	request: TurnPublishRequest,
): Promise<string> {
	const said = (line: string) => callLine(request.via, line);
	const repo = meta.repo;
	const app = githubApp();
	if (!repo || (!app && repo.provider !== "gitlab"))
		return "Not fetched. This session has no repository of the user's GitHub connection.";
	if (active.closed || c.vars.turn !== active) return "Not fetched. The turn this call was made in has ended.";
	const release = takeSandbox(c);
	try {
		// The session's own branch too, where the remote has it: what others pushed there, for the agent to merge.
		const work = meta.publishBranch ?? null;
		const fetchedWork = await fetchSessionBase(c, meta, repo, sandbox, work);
		note(
			c,
			active.number,
			"info",
			said(`Fetched ${repo.branch} from the remote into the workspace as origin/${repo.branch}, as the agent asked.`),
		);
		return fetchedForAgent(repo.branch, fetchedWork ? work : null);
	} catch (error) {
		const why = error instanceof GithubProblem ? error.message : describeError(error);
		note(c, active.number, "warn", said(`${repo.branch} could not be fetched from the remote for the agent: ${why}`));
		return `Not fetched. ${error instanceof GithubProblem ? why : "The platform could not fetch it. Try again."}`;
	} finally {
		release();
	}
}
