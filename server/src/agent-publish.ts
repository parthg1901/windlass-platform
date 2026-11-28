/**
 * The platform's own tools for the agent: `publish` (commit and push the session's work to the
 * session's branch and open or update its pull request, with a title and a description the agent
 * writes), `push` (commit and push the session's branch, and nothing else), `fetch_base` (fetch the
 * branch the session started from, to rebase onto) and `report` (a work item's agent hands over its
 * result). The platform does the work, with the code and the token handling of a publish from the
 * side panel (github/publish.ts, git.ts); the agent has no GitHub credential, before or after.
 *
 * How the agent asks. Windlass lets the client that opens a session declare tools it runs itself
 * (its docs/acp.md, "Tools the client runs"): the declarations go with every `session/new` and
 * `session/resume` (`_meta.windlass.hostTools`), the model finds the tools beside Windlass's own,
 * and a call reaches the platform as the request `_windlass/host_call` on the engine's connection;
 * the platform's answer is the call's result. Nothing of it is in the sandbox: no file, no process,
 * no server. A sandbox whose Windlass does not list `hostTools` among what it takes is from before
 * them: a turn there does not run (`oldSandbox`, agent-session.ts).
 *
 * What Windlass asks about. A declaration names its `effect`, and Windlass decides a call by it as it
 * decides any tool's: `read` is never asked about, attended or not; `write`, `exec` and `network` are
 * asked about in the approval modes the platform runs (`auto`), and refused in a turn nobody attends.
 * Every tool here is declared `read`, each for its own reason (`platformTools`), and the one that
 * needs the person, `publish`, asks them itself, inside the call. Two questions about one publish,
 * Windlass's and the platform's, would be one too many; and only the platform's can be trusted
 * where it matters. Where commands run directly in the sandbox machine they run as Windlass's user
 * and can write on the engine's own connection: a command there can make a call in the agent's
 * name without Windlass having decided anything, so Windlass's question would guard nothing. That
 * is why such a session's agent is never let publish unasked (`publishUnaskedProblem`): there every
 * request is put to the user, whoever made it. docs/github-and-repositories.md, "The agent's own tools", says the same.
 *
 * This file has what is the same everywhere: the tools' declarations, what a request may hold, and
 * the words of the question, of the timeline's lines and of what the agent is told. Windlass takes the
 * tools as host tools. Claude Code, OpenCode and Codex take the sandbox tools, including file_review,
 * over MCP on their ACP connection, where any process in the container may make a
 * call: so a publish that came that way is always put to the person (`publishQuestionWords`, `via`), and
 * a push or a fetch is limited per turn. platform-tools.ts maps a turn's callbacks to the tools for either
 * transport, and says why each may be served from inside the sandbox.
 */

import { REVIEW_TOOL } from "./factory/reviewer-task.js";
import { SUBTASK_HARNESSES, anyOf } from "./sandbox/harnesses.js";
import {
	MAX_PUBLISH_BODY_CHARS,
	MAX_PUBLISH_TITLE_CHARS,
	REVIEW_LIMITS,
	type SecretRequest,
	type ItemAttachment,
	type PublishMessage,
	type PullRequestInfo,
	type QuestionChoice,
	type QuestionPublish,
} from "./contract.js";
import { unavailableSecretName, validRequestedSecretName, type CommandSandbox, type Redactor } from "./repo-secrets.js";
import { isRecord } from "./util.js";

export { PUBLISH_SERVER } from "./personal-server-definition.js";

export const PUBLISH_TOOL = "publish";
/**
 * The tool a work item's agent files its report with: what it did, in
 * a title and a description the platform puts on the pull request, and what it is unsure of. Offered
 * in place of `publish`, which an item's agent is not given: the pull request is the item's step to
 * open. Nothing is decided from a report; it is prose for the person.
 */
export const REPORT_TOOL = "report";
/**
 * The tool by which the agent pushes the session's branch whenever it wants. It is the platform's push,
 * not a credential in the sandbox: the platform names the branch, holds the token for the one push, and
 * may replace only its own last push there, so the agent reaches no other branch and no one else's commit.
 */
export const PUSH_TOOL = "push";
/** The tool that fetches the session's base branch into the workspace, so that the agent can rebase onto it and push again. */
export const FETCH_BASE_TOOL = "fetch_base";
/**
 * The tool by which a work item's builder asks its person a question it cannot go on without. The call
 * is answered at once; the question is the item's, on its page ("Needs you"), and the person's answer
 * is the next turn's message. Offered with `report`, and only to a builder (never the planner, the
 * summary or the reviewer).
 */
export const SECRET_TOOL = "request_secret";
export const ASK_TOOL = "ask_person";

/** The longest commit message a request may carry. */
export const MAX_PUBLISH_COMMIT_CHARS = 4_000;

/** How long publishing itself may take once it is allowed: a commit, a push and GitHub's API, with room. Also a push's or a fetch's whole time. */
const PUBLISHING_SECONDS = 5 * 60;
/** The longest Windlass lets one call of a client's tool take: a waiting call holds the turn, and the session with it. */
const HOST_CALL_LIMIT_SECONDS = 3600;

/**
 * What the model reads about the tool. Windlass's list shows the first sentence, at most 160
 * characters; the rest is there when the model looks the tool up.
 */
const DESCRIPTION = [
	"Publish this session's work to GitHub: commit and push it to the session's own branch and open or update the session's pull request.",
	"You have no GitHub credential and `git push` does not work here: this tool and `push` are the only ways to get the work out, and the platform that runs this session does the work.",
	"It commits whatever is uncommitted in the workspace with your commit message, pushes the session's branch (the platform names it; you cannot choose another, and never the repository's default branch), and opens a pull request into the branch the session started from, with your title and description.",
	"When the session's pull request is open already, it pushes to that one and gives it the title and description of this call.",
	"The user may be asked to allow it first, which can take minutes: wait for the result.",
	"The result says what was published and gives the pull request's address, or says why nothing was published. Tell the user what it says, and do not try another way to publish.",
].join(" ");

export const BUILDER_ASSUMPTIONS =
	'When the task leaves something open, choose the most reasonable option, record it in your report as "Assumed: …", and go on.';
export const ASK_WHEN_BLOCKED =
	"Use ask_person only when blocked on a product decision you cannot settle from the repository, the task or its acceptance criteria.";

const reportDescription = (screenshots: boolean, push: boolean) =>
	[
		"File your report on this turn's work, for the person who reviews it: a title and a description for the pull request, where the reader should look, and what you are unsure of.",
		`Call it once, at the end of your turn, after the work is done; a later call replaces the report. The platform opens the pull request itself once your turn has ended, and pushes ${push ? "whatever you did not push with `push`" : "your work"}.`,
		BUILDER_ASSUMPTIONS,
		screenshots
			? "Screenshots: files you saved with `wlp-shot` under `.wlp-shots/`; they are shown on the item's page to the person, labelled as yours."
			: "Screenshots are unavailable in this sandbox. File your report without them.",
		"Whether the work is ready is decided from the checks and CI, not from the report: say plainly what you did not finish or could not verify.",
	].join(" ");

/** `pushes`: at most so many a turn (over MCP), or as many as the agent wants. */
const pushDescription = (pushes?: number) =>
	[
		"Push this session's branch to GitHub: the platform commits whatever is uncommitted in the workspace with your message and pushes the session's own branch. Nobody is asked.",
		`You have no GitHub credential and \`git push\` does not work here: this is how your commits get to GitHub. ${pushes === undefined ? "Push whenever you want, as often as you want" : `Push whenever you want, at most ${pushes} times a turn`}, for example after each piece of work worth keeping.`,
		"The platform names the branch; you cannot choose another, and never the repository's default branch. It opens no pull request.",
		"To bring in what changed on the branch the session started from: call `fetch_base`, rebase onto what it fetched (or merge it), and push again. A rebased branch replaces what the platform pushed last, and never a commit someone else pushed to the branch.",
	].join(" ");

const fetchBaseDescription = (fetches?: number) =>
	[
		"Fetch the branch this session started from, as it is at GitHub now, into the workspace as `origin/<that branch>`, and the session's own branch as `origin/<your branch>` once it is at GitHub (to merge what someone else pushed there). Nobody is asked.",
		"It changes neither your working tree nor your branch: rebase or merge onto it yourself, then call `push`.",
		...(fetches === undefined ? [] : [`At most ${fetches} times a turn.`]),
	].join(" ");

/** What a question of the agent's may hold. */
export const ASK_LIMITS = { questionChars: 1_000, options: 4, optionChars: 120 } as const;

const ASK_DESCRIPTION = [
	ASK_WHEN_BLOCKED,
	BUILDER_ASSUMPTIONS,
	"Write the question plainly, say what you will do with each answer, and give up to 4 short options when the answer is one of a few.",
	"The call is answered at once. The question waits on the item's page for as long as the person takes, which can be days; your work stays as it is meanwhile. End your turn right after asking.",
	"At most one question per turn.",
].join(" ");

const ASK_SCHEMA = {
	type: "object",
	properties: {
		question: {
			type: "string",
			minLength: 1,
			maxLength: ASK_LIMITS.questionChars,
			description: `The question, in plain text (not Markdown), at most ${ASK_LIMITS.questionChars} characters: what you need decided, and what you will do with each answer.`,
		},
		options: {
			type: "array",
			maxItems: ASK_LIMITS.options,
			items: { type: "string", minLength: 1, maxLength: ASK_LIMITS.optionChars },
			description: `Up to ${ASK_LIMITS.options} short answers the person can pick, each at most ${ASK_LIMITS.optionChars} characters. Left out when the answer is open.`,
		},
	},
	required: ["question"],
	additionalProperties: false,
};

const REPORT_SCHEMA = {
	type: "object",
	properties: {
		title: {
			type: "string",
			description: `The pull request's title, at most ${MAX_PUBLISH_TITLE_CHARS} characters. Match the style of recent commits on the base branch (\`git log --oneline -10\`), such as a \`feat:\` or \`fix:\` prefix.`,
		},
		description: {
			type: "string",
			description: `The pull request's description, in Markdown, at most ${MAX_PUBLISH_BODY_CHARS} characters: what changed and why, and how it was checked.`,
		},
		screenshots: {
			type: "array",
			maxItems: 4,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["file", "caption"],
				properties: {
					file: { type: "string", description: "The .wlp-shots/<name>.png file saved with wlp-shot." },
					caption: { type: "string", minLength: 1, maxLength: 200 },
					shows: { enum: ["after", "before"] },
					page: { type: "string", maxLength: 300 },
				},
			},
		},
		look_at: {
			type: "string",
			description: `Where the reader should look in the change, at most ${REVIEW_LIMITS.lookAtChars} characters.`,
		},
		concerns: {
			type: "string",
			description:
				"What you are unsure of, did not finish, or did differently from what was asked; left out when there is nothing.",
		},
	},
	required: ["title"],
	additionalProperties: false,
};

const INPUT_SCHEMA = {
	type: "object",
	properties: {
		title: {
			type: "string",
			description: `The pull request's title, at most ${MAX_PUBLISH_TITLE_CHARS} characters. Match the style of recent commits on the base branch (\`git log --oneline -10\`), such as a \`feat:\` or \`fix:\` prefix.`,
		},
		description: {
			type: "string",
			description: `The pull request's description, in Markdown, at most ${MAX_PUBLISH_BODY_CHARS} characters: what changed and why, and how it was checked.`,
		},
		commit_message: {
			type: "string",
			description: `The message of the commit the platform makes of what is uncommitted, at most ${MAX_PUBLISH_COMMIT_CHARS} characters. Left out, it is the title.`,
		},
		branch: {
			type: "string",
			description:
				"Leave it out. The work goes to the session's own branch, and a request that names any other branch is refused.",
		},
	},
	required: ["title"],
};

const PUSH_SCHEMA = {
	type: "object",
	properties: {
		message: {
			type: "string",
			description: `The message of the commit the platform makes of what is uncommitted, at most ${MAX_PUBLISH_COMMIT_CHARS} characters. Left out, it is the session's title. Not used when you committed everything yourself.`,
		},
		branch: {
			type: "string",
			description:
				"Leave it out. The push goes to the session's own branch, and a request that names any other branch is refused.",
		},
	},
};

/** A tool as Windlass takes it in `_meta.windlass.hostTools` (its docs/acp.md, "Tools the client runs"). */
export interface HostToolDeclaration {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	effect: "read" | "write" | "exec" | "network";
	untrustedResult: boolean;
	timeoutSeconds?: number;
}

/** Which of the tools a turn is offered: `publish` in a person's session, `report` in a work item's, `push` and `fetch_base` in both. */
export interface PlatformToolOffer {
	plan?: boolean;
	publish: boolean;
	report: boolean;
	push: boolean;
	setup?: boolean;
	setupReview?: boolean;
	planReview?: boolean;
	review?: boolean;
	screenshots?: boolean;
	/** `ask_person`: a work item's builder only. */
	ask?: boolean;
	secret?: boolean;
	/** A cross-repo feature's planning turn: `file_plan` also takes the plan's repositories, merge order and combined run. */
	crossRepo?: boolean;
	/** Served over MCP: how many pushes and fetches a turn may make there (platform-tools.ts, `MCP_LIMITS`), which the tools say. */
	mcp?: { pushes: number; fetches: number };
}

/**
 * The declarations of the tools `offer` names. `questionTimeoutMs` is how long the user has to answer
 * the platform's question about a publish: a call may wait that long and then for the publishing
 * itself, so it declares that time (Windlass gives a call 60 s otherwise).
 *
 * Each is declared `read`, which Windlass never asks about, for what it does on the person's behalf
 * outside the sandbox:
 *
 *   report      hands text to the platform and changes nothing anywhere. Answered at once.
 *   ask_person  hands a question to the platform for the item's person, and changes nothing anywhere.
 *               Answered at once, with the platform's own sentence; the person's answer comes as the
 *               next turn's message, not as the call's result. Declared anything but `read`, Windlass
 *               would refuse it in an item's unattended turn, which is the only place it is offered.
 *   push        changes one branch at GitHub: the session's own, which the platform names, to what is
 *               in the workspace, which any command of the agent's can already change; under a lease
 *               it can replace only the platform's own last push (github/git.ts). A call made by a
 *               command instead of the model gains nothing the command did not have, so it is never
 *               asked about, in any profile, attended or not, over either transport (agent-session.ts,
 *               `agentPush`); over MCP a turn may make at most so many (`mcp`). Declared `write`,
 *               Windlass would ask in `auto` and refuse it in an item's unattended turn.
 *   fetch_base  reads the base branch into `origin/<base>` in the workspace, and changes nothing else.
 *   publish     opens or updates a pull request under the person's name: the person is asked, by the
 *               platform, inside the call (agent-session.ts, `agentPublish`), unless they let the
 *               agent publish unasked where commands cannot make the call. Declared `write`, Windlass
 *               would ask too in `auto` and not at all in `full`, and an approval it kept for the
 *               session would stand beside the panel's own switch, which is the one the person sees.
 *               Never offered in an item's turn.
 *
 * What each answers is the platform's own sentence (with the person's own note, or GitHub's refusal,
 * quoted in it), so no answer is content the platform does not vouch for: `untrustedResult: false`,
 * after which Windlass would ask about every command it cannot sandbox.
 */
export function platformTools(offer: PlatformToolOffer, questionTimeoutMs: number): HostToolDeclaration[] {
	const publishSeconds = Math.min(HOST_CALL_LIMIT_SECONDS, Math.ceil(questionTimeoutMs / 1000) + PUBLISHING_SECONDS);
	const tool = (
		name: string,
		description: string,
		inputSchema: Record<string, unknown>,
		timeoutSeconds?: number,
	): HostToolDeclaration => ({
		name,
		description,
		inputSchema,
		effect: "read",
		untrustedResult: false,
		...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
	});
	if (offer.setupReview)
		return [
			tool(
				"file_repo_setup_review",
				"Review every drafted file once. For each path give verdict ok, fix or drop and up to three short findings.",
				{
					type: "object",
					required: ["files"],
					properties: {
						files: {
							type: "array",
							items: {
								type: "object",
								required: ["path", "verdict", "findings"],
								properties: {
									path: { type: "string" },
									verdict: { enum: ["ok", "fix", "drop"] },
									findings: { type: "array", items: { type: "string" } },
								},
							},
						},
					},
				},
			),
		];
	if (offer.setup) {
		const text = { type: "string" },
			number = { type: "integer" };
		const rows = (properties: Record<string, unknown>, required: string[]) => ({
			type: "array",
			items: { type: "object", properties, required },
		});
		const evidence = {
			type: "object",
			description:
				"A repository file with an optional one-based line (install lockfile or manifest, script definition, or workflow run line), an exact saved setup or check command with command alone, or a verified path check with command, exit and said.",
			properties: { file: text, line: number, command: text, exit: number, said: text },
		};
		return [
			tool(
				"file_repo_setup",
				"Submit the complete proposed guides for review. Use one-based line numbers and repository-relative evidence paths. Correct any refused filing and call again.",
				{
					type: "object",
					required: ["score", "files"],
					properties: {
						score: rows(
							{ id: { type: "string", enum: ["setup", "checks", "guide"] }, pass: { type: "boolean" }, reason: text },
							["id", "pass", "reason"],
						),
						files: rows(
							{
								kind: { type: "string", enum: ["guide", "area", "skill"] },
								path: text,
								content: text,
								lines: rows({ line: number, noteId: text, evidence }, ["line", "evidence"]),
								removed: rows({ line: number, evidence }, ["line", "evidence"]),
							},
							["kind", "path", "content", "lines"],
						),
						notes: rows(
							{
								noteId: text,
								verdict: {
									type: "string",
									enum: ["team", "personal", "private", "secret", "stale", "question", "duplicate"],
								},
								reason: text,
								question: text,
							},
							["noteId", "verdict", "reason"],
						),
					},
				},
			),
		];
	}
	if (offer.planReview)
		return [
			tool("file_plan_review", "File the independent decision and concise findings on the proposed plan.", {
				type: "object",
				required: ["decision", "findings"],
				properties: {
					decision: { enum: ["approve", "revise"] },
					findings: { type: "array", items: { type: "string" } },
				},
			}),
		];
	if (offer.plan)
		return [
			tool(
				"file_plan",
				`Propose a feature plan for the owner. Include spec {goal, requirements[], outOfScope[], acceptance[]}, questions [{id,text,options?,why?,recommended?}] (each question's text one short sentence of at most 140 characters ending in a question mark, each option and optional recommended answer at most 80 characters, recommended must match an option when listed, and why, optional, at most 400 characters of background the owner can open), and two to six subtasks [{key,title,brief,acceptance[],dependsOn[],owns[],budget:{tokens}}]. Give each subtask a short title beginning with a verb and naming a concrete result, for example “Add the CSV writer”. Independent subtasks run in parallel. Split work by file, list accurate paths in owns, and use dependsOn only for real prerequisites. A subtask's budget is one figure: cost-weighted tokens, where cached input counts at a tenth, between the least and most a subtask may have (the prompt's Budget lines give the figures). The feature's budget is its subtasks' together, and its own allowance for planning, summary and review on top; when a subtask uses its budget, it asks the owner for more instead of stopping work. Each subtask inherits the resolved place and agent for its repository. To change the place, propose place {prefer: an owner machine name or hosted, reason: up to 200 characters, allow?: alternative names} and needs {tags?, screenshots?, egress?: open or restricted, profile?, cpus?, memoryGiB?, hostedSize?}. A larger hosted size requires the owner’s approval. Request it explicitly in hostedSize when needed. Use the read-only owner descriptions, tags and sandbox capacity. Omit agent to inherit the resolved choice, or propose agent {harness: ${anyOf(["windlass", ...SUBTASK_HARNESSES.map(h => h.id)])}, model?, effort?}, with a model and effort its place lists in agentModels (windlassModels for Windlass). ${SUBTASK_HARNESSES.map(h => h.name).join(" and ")} run on a signed-in machine or on a hosted key profile with a matching Settings provider. On hosted choose their default model. They work without asking: the owner confirms each one before it runs, so propose one only where the subtask needs it. Overflow defaults to false and waits for the preferred place. Only approved alternatives may be used when overflow is true. To suggest single mode, give singleSuggested and an empty subtask list.` +
					(offer.crossRepo
						? " For a feature over two repositories (the prompt names them), also give repos[], each subtask's repo alias, mergeOrder [{repo, prerequisite[], intermediate, evidence, fallback}], releaseGate request and finalIntegration {runFrom, command, inputs[], profile: actions, timeoutSeconds, requiredCases[], artifactOutputs[]}."
						: ""),
				{
					type: "object",
					required: ["spec", "questions", "subtasks"],
					properties: {
						overflow: { type: "boolean" },
						spec: { type: "object" },
						questions: {
							type: "array",
							items: {
								type: "object",
								required: ["id", "text"],
								properties: {
									id: { type: "string" },
									text: { type: "string" },
									options: { type: "array", items: { type: "string" } },
									why: { type: "string" },
									recommended: { type: "string", minLength: 1, maxLength: 80 },
								},
							},
						},
						// Only a cross-repo planning turn is offered these: a one-repository plan's schema is what it always was.
						...(offer.crossRepo && {
							repos: { type: "array", items: { type: "string" } },
							mergeOrder: { type: "array", items: { type: "object" } },
							releaseGate: { enum: ["request", "wait"] },
							earlyChecks: { type: "array", items: { type: "object" } },
							finalIntegration: { type: "object" },
						}),
						subtasks: {
							type: "array",
							items: {
								type: "object",
								properties: {
									...(offer.crossRepo && { repo: { type: "string" } }),
									place: {
										type: "object",
										required: ["prefer", "reason"],
										properties: {
											prefer: { type: "string" },
											reason: { type: "string", maxLength: 200 },
											allow: { type: "array", items: { type: "string" } },
										},
									},
									needs: {
										type: "object",
										additionalProperties: false,
										properties: {
											tags: { type: "array", items: { type: "string" } },
											screenshots: { type: "boolean" },
											egress: { enum: ["open", "restricted"] },
											profile: { enum: ["docker-hardened", "docker-windlass-sandbox", "e2b-open", "daytona"] },
											hostedSize: { enum: ["small", "standard", "large"] },
											cpus: { type: "number", description: "More than 0." },
											memoryGiB: { type: "number", description: "More than 0." },
										},
									},
									agent: {
										type: "object",
										additionalProperties: false,
										required: ["harness"],
										properties: {
											harness: { enum: ["windlass", ...SUBTASK_HARNESSES.map(h => h.id)] },
											model: { type: "string", maxLength: 200 },
											effort: { type: "string", maxLength: 64 },
										},
									},
								},
							},
						},
						singleSuggested: { type: ["string", "null"] },
					},
				},
			),
		];
	if (offer.review)
		return [
			tool(
				REVIEW_TOOL,
				offer.mcp
					? "File your recommendation and typed review blocks for this commit. You have one call."
					: "File a recommendation and typed review blocks for this commit. To see completed shell command refs in execution order, call with {commands:true}; this lookup does not use a filing.",
				{
					type: "object",
					properties: {
						...(!offer.mcp && { commands: { type: "boolean" } }),
						recommendation: { type: "string", enum: ["approve", "changes_requested", "needs_person"] },
						blocks: { type: "array", items: { type: "object" } },
					},
					additionalProperties: false,
				},
				180,
			),
		];
	const { screenshots, ...textFields } = REPORT_SCHEMA.properties;
	return [
		...(offer.publish ? [tool(PUBLISH_TOOL, DESCRIPTION, INPUT_SCHEMA, publishSeconds)] : []),
		...(offer.report
			? [
					tool(
						REPORT_TOOL,
						reportDescription(offer.screenshots !== false, offer.push),
						offer.screenshots === false ? { ...REPORT_SCHEMA, properties: textFields } : REPORT_SCHEMA,
						180,
					),
				]
			: []),
		...(offer.report && offer.ask ? [tool(ASK_TOOL, ASK_DESCRIPTION, ASK_SCHEMA, 30)] : []),
		...(offer.secret
			? [
					tool(
						SECRET_TOOL,
						"Ask your person to set a missing environment variable. Give its name and a short reason. Never include a value. Stop after the request is recorded.",
						{
							type: "object",
							required: ["name", "why"],
							additionalProperties: false,
							properties: {
								name: { type: "string", minLength: 2, maxLength: 64 },
								why: { type: "string", minLength: 1, maxLength: 240 },
							},
						},
						30,
					),
				]
			: []),
		...(offer.push
			? [
					tool(PUSH_TOOL, pushDescription(offer.mcp?.pushes), PUSH_SCHEMA, PUBLISHING_SECONDS),
					tool(
						FETCH_BASE_TOOL,
						fetchBaseDescription(offer.mcp?.fetches),
						{ type: "object", properties: {} },
						PUBLISHING_SECONDS,
					),
				]
			: []),
	];
}

/** A call's input as the platform reads it: an object, or none. Windlass checked it against the schema, which is the declaration's and asks for little. */
export const callArguments = (input: unknown): Record<string, unknown> => (isRecord(input) ? input : {});

/** A builder report after the host tool has checked and cleaned every field. */
export interface AgentReport {
	screenshots: ItemAttachment[];
	title: string;
	description: string;
	lookAt: string;
	concerns: string;
}

/** What the agent is told when its report was taken. */
export const REPORT_TAKEN =
	"Your report was filed. The platform publishes your work when your turn ends; end your turn now.";

// ---------------------------------------------------------------------------------------------
// What a request may hold
// ---------------------------------------------------------------------------------------------

/** What is taken out of the agent's text besides line breaks and tabs: a terminal, or a page, should not act on it. */
export const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g;
/** Characters that change how text around them reads without being seen: direction overrides and isolates, zero-width marks, the byte-order mark. */
export const INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g;
/**
 * Every format character (Unicode Cf: soft hyphens, tag characters, joiners, direction marks), variation
 * selectors and the fillers that render as nothing. Text made of these reads as nothing to the person but
 * still reaches the agent, so an option could carry hidden words that the person then sends as their own.
 */
export const HIDDEN = /[\p{Cf}\u034f\u115f\u1160\u180e\u3164\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;

// ---------------------------------------------------------------------------------------------
// The agent's question to the person (`ask_person`)
// ---------------------------------------------------------------------------------------------

/** A question of the agent's, cleaned: plain text, never Markdown, shown to the person quoted as the agent's. */
export interface AgentAsk {
	text: string;
	options: string[];
}

/** What the agent is told when its question was recorded. */
export const ASK_TAKEN =
	"Recorded as a question to the person. End your turn now; their answer will come as your next message.";
/** A second question in one turn. */
export const ASK_AGAIN = "You already asked in this turn. End your turn; the answer comes as your next message.";
/** No question offered to this turn. */
export const ASK_NONE_LEFT = `This turn may not ask the person. ${BUILDER_ASSUMPTIONS}`;

/** What a call of `ask_person` comes to: the question to record (null when none is), what the agent is told, and the timeline's line. */
export interface AskTaken {
	asked: AgentAsk | null;
	told: string;
	said: string;
}

/**
 * A call of `ask_person`, checked. Its text is the model's, and may have been steered by whatever the
 * agent read (the repository, an issue): saved secrets are taken out, control and invisible characters
 * go (a direction override could make the question read as something it is not), and what is past the
 * limits is refused with the limit, so that the agent can ask again. `already`: this turn has asked;
 * `left`: the questions the turn was offered (one). Neither of those records anything.
 */
export function askPerson(
	given: Record<string, unknown>,
	state: { already: boolean; left: number },
	redactor: Redactor,
): AskTaken {
	const refuse = (told: string, said: string): AskTaken => ({ asked: null, told, said });
	if (state.already)
		return refuse(ASK_AGAIN, "The agent asked a second question in one turn, and was told to end its turn.");
	if (state.left <= 0)
		return refuse(
			ASK_NONE_LEFT,
			"The agent asked a question in a turn that may not ask, and was told to decide itself.",
		);
	// Invisible characters go before secrets are taken out, so a secret split by one cannot slip past and be rejoined.
	const clean = (value: string) =>
		redactor.text(value.replace(/\r\n?/g, "\n").replace(CONTROL, "").replace(INVISIBLE, "").replace(HIDDEN, ""));
	if (typeof given.question !== "string")
		return refuse(
			`Not recorded. The question has to be text. Call ${ASK_TOOL} again.`,
			"The agent asked a question that is not text, so it was not recorded.",
		);
	const text = clean(given.question)
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (text === "")
		return refuse(
			`Not recorded. The question is empty. Call ${ASK_TOOL} again with your question.`,
			"The agent asked an empty question, so it was not recorded.",
		);
	if (text.length > ASK_LIMITS.questionChars) {
		return refuse(
			`Not recorded. The question is ${text.length} characters long and the limit is ${ASK_LIMITS.questionChars}. Shorten it and call ${ASK_TOOL} again.`,
			`The agent asked a question of ${text.length} characters, and the limit is ${ASK_LIMITS.questionChars}, so it was not recorded.`,
		);
	}
	const listed = given.options;
	if (listed !== undefined && listed !== null && !Array.isArray(listed))
		return refuse(
			`Not recorded. The options have to be a list of short texts. Call ${ASK_TOOL} again.`,
			"The agent asked with options that are not a list, so the question was not recorded.",
		);
	const options: string[] = [];
	for (const option of (listed ?? []) as unknown[]) {
		if (typeof option !== "string")
			return refuse(
				`Not recorded. Each option has to be text. Call ${ASK_TOOL} again.`,
				"The agent asked with an option that is not text, so the question was not recorded.",
			);
		const one = clean(option).replace(/\s+/g, " ").trim();
		if (one === "") continue;
		if (one.length > ASK_LIMITS.optionChars)
			return refuse(
				`Not recorded. An option is ${one.length} characters long and the limit is ${ASK_LIMITS.optionChars}. Shorten it and call ${ASK_TOOL} again.`,
				`The agent asked with an option of ${one.length} characters, and the limit is ${ASK_LIMITS.optionChars}, so the question was not recorded.`,
			);
		if (!options.includes(one)) options.push(one);
	}
	if (options.length > ASK_LIMITS.options)
		return refuse(
			`Not recorded. Give at most ${ASK_LIMITS.options} options. Call ${ASK_TOOL} again.`,
			`The agent asked with ${options.length} options, and the limit is ${ASK_LIMITS.options}, so the question was not recorded.`,
		);
	// The line is the platform's, which the session's timeline labels so and turns addresses into links: the agent's words are not in it. Its call, beside it, has them as the agent's.
	return {
		asked: { text, options },
		told: ASK_TAKEN,
		said: "The agent asked you a question. It waits under Needs you, on the item's page, until you answer.",
	};
}

export function secretRequestNotice(sandbox: boolean, account: boolean): string {
	const source = sandbox
		? "This request came from inside the agent's sandbox; a program there, not only the agent, could have made it."
		: "This request came through the agent's host tool connection.";
	const scope = account
		? "If supplied, this will be saved for your account: every agent of yours will have it."
		: "If supplied, this will be saved for this repository with agent scope.";
	return source + "\n" + scope;
}

export function requestSecret(
	given: Record<string, unknown>,
	already: boolean,
	untrusted: boolean,
	redactor: Redactor,
): { request?: SecretRequest; told: string } {
	if (untrusted) return { told: "A request coming from third-party text was not shown as a secret prompt." };
	if (already) return { told: ASK_AGAIN };
	const { name, why } = given;
	if (!validRequestedSecretName(name) || redactor.text(name) !== name)
		return {
			told: unavailableSecretName(
				typeof name === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(name) && redactor.text(name) === name
					? name
					: "That name",
			),
		};
	if (typeof why !== "string" || Object.keys(given).some(key => key !== "name" && key !== "why"))
		return { told: "Supply only a name and a short reason." };
	const reason = redactor.text(why.replace(CONTROL, "").replace(HIDDEN, "").replace(/\s+/g, " ").trim());
	if (!reason || reason.length > 240) return { told: "Give a reason of 1 to 240 characters." };
	return {
		request: { name, why: reason },
		told: `Asked your person for ${name}; stop here and say what you will do once it is set.`,
	};
}

export type PublishRequest =
	/** What the platform would publish with. */
	| { ok: true; message: PublishMessage & { commit: string } }
	/** Why it is refused before anyone is asked: `said` for the timeline, `told` for the agent. */
	| { ok: false; said: string; told: string };

/**
 * A request's arguments, checked. They are the model's text, and nothing is assumed of them: each
 * has to be text, the repository's saved secrets are taken out (the event they came in was cleaned
 * before, but as JSON, where a value with a line break or a quote in it is not itself), control
 * characters go, and what is longer than the limits is refused, with the limit, so that the agent
 * can ask again. A request that names a branch other than the session's, or a base other than the
 * branch the session started from, is refused: the session's work goes to the session's branch.
 */
export function publishRequest(
	given: Record<string, unknown>,
	where: { branch: string; base: string },
	redactor: Redactor,
): PublishRequest {
	const refuse = (said: string, told: string): PublishRequest => ({ ok: false, said, told });
	const named = (value: unknown) =>
		typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : JSON.stringify(value);
	const shown = (value: string) => JSON.stringify(redactor.text(value.replace(CONTROL, "")).slice(0, 120));

	const branch = named(given.branch) || named(given.head);
	if (branch !== "" && branch !== where.branch) {
		return refuse(
			`The agent asked to publish to ${shown(branch)}, which is not this session's branch (${where.branch}), so nothing was published.`,
			`Not published. This session's work can only go to the session's own branch, ${where.branch}, with a pull request into ${where.base}; a request that names another branch is refused. Call the tool again without a branch.`,
		);
	}
	const base = named(given.base);
	if (base !== "" && base !== where.base) {
		return refuse(
			`The agent asked for a pull request into ${shown(base)}, which is not the branch this session started from (${where.base}), so nothing was published.`,
			`Not published. This session's pull request can only ask to be merged into ${where.base}, the branch the session started from. Call the tool again without a base.`,
		);
	}

	const fields: Array<{ key: string; name: string; limit: number; needed: boolean; oneLine: boolean }> = [
		{ key: "title", name: "title", limit: MAX_PUBLISH_TITLE_CHARS, needed: true, oneLine: true },
		{ key: "description", name: "description", limit: MAX_PUBLISH_BODY_CHARS, needed: false, oneLine: false },
		{ key: "commit_message", name: "commit message", limit: MAX_PUBLISH_COMMIT_CHARS, needed: false, oneLine: false },
	];
	const clean: Record<string, string> = {};
	for (const field of fields) {
		const value = given[field.key];
		if (value !== undefined && value !== null && typeof value !== "string") {
			return refuse(
				`The agent asked to publish with a ${field.name} that is not text, so nothing was published.`,
				`Not published. The ${field.name} has to be text. Call the tool again.`,
			);
		}
		const text = redactor
			.text(typeof value === "string" ? value : "")
			.replace(/\r\n?/g, "\n")
			.replace(CONTROL, "");
		const kept = field.oneLine ? text.replace(/\s+/g, " ").trim() : text.trim();
		if (field.needed && kept === "")
			return refuse(
				`The agent asked to publish without a ${field.name}, so nothing was published.`,
				`Not published. Give the pull request a ${field.name} and call the tool again.`,
			);
		if (kept.length > field.limit) {
			return refuse(
				`The agent asked to publish with a ${field.name} of ${kept.length} characters, and the limit is ${field.limit}, so nothing was published.`,
				`Not published. The ${field.name} is ${kept.length} characters long and the limit is ${field.limit}. Shorten it and call the tool again.`,
			);
		}
		clean[field.key] = kept;
	}
	const title = clean.title ?? "";
	return {
		ok: true,
		message: {
			title,
			body: clean.description ?? "",
			commit: (clean.commit_message ?? "") === "" ? title : (clean.commit_message as string),
		},
	};
}

// ---------------------------------------------------------------------------------------------
// The question
// ---------------------------------------------------------------------------------------------

/** The ids of the question's answers. */
export const PUBLISH_ONCE = "once";
export const PUBLISH_SESSION = "session";
export const PUBLISH_DENY = "deny";

/**
 * Why an agent cannot be let publish unasked in a sandbox whose commands are not held in Windlass's
 * sandbox, or not known to be: a command there could ask in the agent's name, and with nobody asked
 * that would be a publish a command made by itself. Null where Windlass sandboxes every command.
 */
export function publishUnaskedProblem(sandbox: CommandSandbox): string | null {
	if (sandbox === "windlass") return null;
	return sandbox === "none"
		? "In this sandbox the agent's commands run outside Windlass's sandbox and could ask in the agent's name, so you are asked each time the agent wants to publish."
		: "In this sandbox it is not established that Windlass's sandbox holds the agent's commands, which could then ask in the agent's name, so you are asked each time the agent wants to publish.";
}

/**
 * Why an agent that takes the platform's tools over MCP (Claude Code, OpenCode, Codex) cannot be let
 * publish unasked: any process in its container may make the call, so every request is put to the user.
 */
export const publishAsksEveryTime = (agent: string) =>
	`${agent} asks you every time it wants to publish: its publish tool is reached from inside the sandbox, where any process could call it, so it cannot publish without asking.`;

/** Said in the timeline of each push, fetch and publish that came over MCP (`TurnPublishRequest.via`). */
export const MCP_CALL_WORDS =
	"The call came over MCP from inside the sandbox, so any process there may have made it, not only the agent.";
/** A timeline line about a call, with `MCP_CALL_WORDS` when it came over MCP. */
export const callLine = (via: "mcp" | undefined, line: string) => (via === "mcp" ? `${line} ${MCP_CALL_WORDS}` : line);

export interface PublishQuestionInput {
	/** "owner/name". */
	repository: string;
	branch: string;
	base: string;
	message: PublishMessage & { commit: string };
	/** The session's pull request when it is open: the push goes to it. */
	open: PullRequestInfo | null;
	/** What the session's profile promises about the agent's commands: where they are not sandboxed the question says so, and cannot be answered for the whole session. */
	sandbox: CommandSandbox;
	/** "mcp": the request came over MCP (`TurnPublishRequest.via`), so the question says any process may have made it, and cannot be answered for the whole session. */
	via?: "mcp";
}

/** The question about a request of the agent's, as the session's question box shows it. */
export function publishQuestionWords(input: PublishQuestionInput): {
	title: string;
	subject: string;
	details: string[];
	choices: QuestionChoice[];
	publish: QuestionPublish;
} {
	const { open } = input;
	// "For this session" only where no command can make the call: Windlass's sandbox holds them, and the call came by Windlass.
	const forSession = input.sandbox === "windlass" && input.via !== "mcp";
	return {
		title: open
			? `Allow the agent to push to pull request #${open.number}?`
			: "Allow the agent to open a pull request?",
		subject: input.message.title,
		details: [
			open
				? `The platform commits what is uncommitted in the workspace with this message and pushes it to pull request #${open.number}, which is given this title and description.`
				: "The platform commits what is uncommitted in the workspace with this message, pushes it to the session's branch, and opens the pull request under this title and description.",
			"What is in the workspace and not yet at GitHub goes there as it is: Changes, in the session's panel, lists it.",
			"The agent is given no GitHub access: the platform pushes, and tells the agent the pull request's address.",
			...(input.via === "mcp"
				? [
						"This request came over MCP from inside the sandbox: any process there could have made it in the agent's name, so it is asked every time.",
					]
				: input.sandbox === "windlass"
					? []
					: [
							"In this sandbox a command the agent ran could have asked this in the agent's name: its commands are not held in Windlass's sandbox.",
						]),
		],
		choices: [
			{ id: PUBLISH_ONCE, label: "Allow once", approve: true, remembers: null },
			...(forSession
				? [
						{
							id: PUBLISH_SESSION,
							label: "Allow for this session",
							approve: true,
							remembers: "publishing for the agent without asking, for the rest of this session",
						},
					]
				: []),
			{ id: PUBLISH_DENY, label: "Don't allow", approve: false, remembers: null },
		],
		publish: {
			repository: input.repository,
			branch: input.branch,
			base: input.base,
			commit: input.message.commit,
			title: input.message.title,
			description: input.message.body,
			pullRequest: open ? open.number : null,
		},
	};
}

// ---------------------------------------------------------------------------------------------
// The timeline's lines, and what the agent is told
// ---------------------------------------------------------------------------------------------

/** How a request came to be allowed. */
export type PublishAllowed = "unasked" | "once" | "session";

/** The first sentence of the line about a request that was allowed: who allowed it. */
export function publishAllowedWords(allowed: PublishAllowed): string {
	if (allowed === "once") return "The agent asked to publish, and you allowed it once.";
	if (allowed === "session")
		return "The agent asked to publish, and you allowed it for the rest of this session: it is not asked about again, unless Pull request in the session's panel says otherwise.";
	return "The agent asked to publish, which this session allows without asking.";
}

/** What was published, for the agent: the pull request's address first. */
export function publishedForAgent(input: {
	repository: string;
	pull: PullRequestInfo;
	opened: boolean;
	pushed: boolean;
	retitled: boolean;
	files: number | null;
}): string {
	const { pull } = input;
	const did = input.opened
		? `Opened pull request #${pull.number}`
		: input.pushed
			? `Pushed to pull request #${pull.number}${input.retitled ? " and gave it this title and description" : ""}`
			: `Gave pull request #${pull.number} this title and description; there was nothing new to push`;
	const files =
		input.files === null || !input.pushed
			? ""
			: input.files === 0
				? " The commits were your own: nothing was uncommitted."
				: ` The platform's commit holds ${input.files === 1 ? "1 file" : `${input.files} files`}.`;
	return `Published. ${did}: ${pull.url}\nThe work is on the branch ${pull.branch} of ${input.repository}, to be merged into ${pull.base}.${files}\nGive the user the pull request's address.`;
}

/** The user said no. `note` is what they wrote for the agent. */
export function publishDeclined(note: string | undefined): { said: string; told: string } {
	const words = (note ?? "").trim();
	return {
		said:
			words === ""
				? "The agent asked to publish, and you did not allow it. Nothing was published."
				: `The agent asked to publish, and you did not allow it: ${JSON.stringify(words)}. Nothing was published.`,
		told: `Not published. The user did not allow it${words === "" ? "." : `, and wrote: ${words}`}\nThe work is still in the workspace. Do not try another way to publish.`,
	};
}

/** Nobody answered in time. `title` is the question's, `waited` how long it stood ("10 minutes"). */
export function publishUnanswered(title: string, waited: string): { said: string; told: string } {
	return {
		said: `Nobody answered "${title}" within ${waited}, so it was declined. Nothing was published; Pull request, in the session's panel, can let the agent publish without asking.`,
		told: `Not published. Nobody answered the platform's question within ${waited}, so it was declined for the user.\nThe work is still in the workspace. Say in your answer that it is not published yet and that the user can publish it from the session's panel, or allow you to publish without asking there.`,
	};
}

/** The question went with the call or the turn before anyone answered: what the agent would read if it still could. */
export const PUBLISH_WITHDRAWN = "Not published. The request was withdrawn before the user answered.";

/** Publishing was allowed and did not go through. `why` is the sentence a publish from the panel fails with. */
export function publishFailed(allowed: PublishAllowed, why: string): { said: string; told: string } {
	return { said: `${publishAllowedWords(allowed)} It did not go through: ${why}`, told: `Not published. ${why}` };
}

// ---------------------------------------------------------------------------------------------
// The agent's push, and the base it fetches
// ---------------------------------------------------------------------------------------------

/** A push the agent asked for, checked: the commit's message, or why it is refused (`said` for the timeline, `told` for the agent). */
export type PushRequest = { ok: true; commit: string } | { ok: false; said: string; told: string };

/**
 * A push's arguments, checked as a publish's are: a branch other than the session's is refused (the
 * push goes to the session's branch whatever is named; naming another is a mistake to be told of),
 * the message is cleaned of saved secrets and control characters, and one past the limit is
 * refused. Without a message the commit is named for the session (`title`).
 */
export function pushRequest(
	given: Record<string, unknown>,
	where: { branch: string; title: string },
	redactor: Redactor,
): PushRequest {
	const branch =
		typeof given.branch === "string"
			? given.branch.trim()
			: given.branch === undefined || given.branch === null
				? ""
				: JSON.stringify(given.branch);
	if (branch !== "" && branch !== where.branch) {
		return {
			ok: false,
			said: `The agent asked to push to ${JSON.stringify(redactor.text(branch.replace(CONTROL, "")).slice(0, 120))}, which is not this session's branch (${where.branch}), so nothing was pushed.`,
			told: `Not pushed. This session's work can only go to the session's own branch, ${where.branch}; a request that names another branch is refused. Call the tool again without a branch.`,
		};
	}
	const value = given.message;
	if (value !== undefined && value !== null && typeof value !== "string")
		return {
			ok: false,
			said: "The agent asked to push with a commit message that is not text, so nothing was pushed.",
			told: "Not pushed. The message has to be text. Call the tool again.",
		};
	const message = redactor
		.text(typeof value === "string" ? value : "")
		.replace(/\r\n?/g, "\n")
		.replace(CONTROL, "")
		.trim();
	if (message.length > MAX_PUBLISH_COMMIT_CHARS) {
		return {
			ok: false,
			said: `The agent asked to push with a commit message of ${message.length} characters, and the limit is ${MAX_PUBLISH_COMMIT_CHARS}, so nothing was pushed.`,
			told: `Not pushed. The message is ${message.length} characters long and the limit is ${MAX_PUBLISH_COMMIT_CHARS}. Shorten it and call the tool again.`,
		};
	}
	return { ok: true, commit: message === "" ? where.title : message };
}

/** What the agent is told of a push that went out. `pull` is the session's open pull request, which now shows it. */
export function pushedForAgent(input: {
	branch: string;
	head: string | null;
	forced: boolean;
	files: number | null;
	pull: PullRequestInfo | null;
}): string {
	const head = input.head === null ? "" : ` (${input.head.slice(0, 7)})`;
	const files =
		input.files === null
			? ""
			: input.files === 0
				? " Nothing was uncommitted: your own commits went as they were."
				: ` The platform's commit holds ${input.files === 1 ? "1 file" : `${input.files} files`}.`;
	const forced = input.forced ? " It replaced what the platform had pushed to the branch before." : "";
	const pull =
		input.pull === null
			? " No pull request was opened."
			: ` Pull request #${input.pull.number} shows it: ${input.pull.url}`;
	return `Pushed to ${input.branch}${head}.${files}${forced}${pull}`;
}

/** The timeline's line for a push the agent asked for. */
export function agentPushedLine(input: {
	branch: string;
	head: string | null;
	forced: boolean;
	pull: PullRequestInfo | null;
}): string {
	const head = input.head === null ? "" : ` (${input.head.slice(0, 7)})`;
	const forced = input.forced ? ", replacing what the platform had pushed there before" : "";
	const pull =
		input.pull === null
			? ""
			: ` Pull request #${input.pull.number} shows it${input.pull.verified ? `; its description reports: ${input.pull.verified}` : ""}.`;
	return `The agent pushed its work to ${input.branch}${head}${forced}.${pull}`;
}

/** What the agent is told of a push that found nothing GitHub lacks. */
export const nothingToPush = (branch: string) =>
	`Nothing to push: ${branch} at GitHub already has everything in the workspace.`;

/** What the agent is told once the base was fetched. */
export const fetchedForAgent = (base: string, work: string | null) =>
	`Fetched ${base} from GitHub into the workspace as origin/${base}${work === null ? "" : `, and your branch as GitHub has it as origin/${work}`}. Rebase onto origin/${base} (git rebase origin/${base}) or merge it${work === null ? "" : `; merge origin/${work} first if someone else pushed to your branch`}, then call push.`;

// ---------------------------------------------------------------------------------------------
// A sandbox from before the tools
// ---------------------------------------------------------------------------------------------

/**
 * Why a turn does not run in a sandbox whose Windlass takes no host tools. Every sandbox the platform
 * makes has a Windlass that does, so this is not a path that is supported, only one that fails
 * loudly: for a person's turn and a work item's alike (the item is handed it as `turn_ended.refused`).
 */
export function oldSandbox(place: "hosted" | "machine"): string {
	return place === "machine"
		? "This agent's sandbox on your machine was made by a runner from an older version of the platform, whose Windlass cannot give the agent the platform's tools, so nothing was run. Install the current runner on the machine (Machines, in the menu), then start a new agent there."
		: "This agent's sandbox is from an older version of the platform, whose Windlass cannot give the agent the platform's tools, so nothing was run. Start a new agent.";
}
