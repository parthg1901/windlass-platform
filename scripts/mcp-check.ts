/**
 * The question about a project's MCP server, against a real Windlass. Run with:
 *
 *   cd server && npx tsx ../scripts/mcp-check.ts
 *   Add --report to check only the platform's own tools (its host tools) in both Docker profiles, and
 *   --image <tag> to run against another sandbox image (one with an unreleased Windlass, say).
 *
 * It makes sandboxes on local Docker, puts the small repository of fixtures/mcp-repo into their
 * workspaces (a `.windlass/config.json` that names the server "harbor", and the server itself, which
 * needs nothing but the image's Python), and runs real turns through the sandbox layer with a scripted
 * model (WINDLASS_ACP_SCRIPT): the engine, its configuration, its approvals and the server's process
 * are Windlass's own, and no model is called. It shows
 *
 *   - that Windlass reports the server as waiting before the prompt goes, with its command and the
 *     file that defines it, and that nothing of the turn has run when the question is put;
 *   - that "not now" leaves it stopped and the model is told so when it tries the server;
 *   - that approving starts it, that the model's first request of that turn has its tools, and that
 *     the model calls one in that turn and in a later message, without being asked again;
 *   - that the server reaches what the platform's question says it reaches: the network and Windlass's
 *     data directory, where a command the agent runs in Windlass's sandbox reaches neither;
 *   - that a changed definition is asked about again;
 *   - that a definition which reads a variable that is not set is named in the question, and reported
 *     with Windlass's own sentence when it is approved all the same;
 *   - where an approval is remembered on Docker (the user's data volume, so the user's other sessions);
 *   - what the layer says of the project's servers as a turn goes (`onServers`), which is what a
 *     session's panel lists;
 *   - and the platform's own memory of an approval (server/src/server-approvals.ts), where each sandbox
 *     keeps Windlass's data to itself as on E2B: a second session on the same repository and a sandbox
 *     that replaces one are not asked and the server runs; a changed definition, another user, another
 *     repository that names the server the same way, the next session after forgetting, and an
 *     approval past its 30 days are asked;
 *   - that a turn stopped under the question ends without having started;
 *   - that a tool of a user's own server is asked about, and runs without a question where its user
 *     said that its tools run without asking: every call, also once the server's own result is in
 *     the conversation and Windlass asks where it did not before, and never for a server of the
 *     same name that the repository names;
 *   - and, with a stand-in for the engine, what the layer does with a server reported while the turn
 *     runs, beside a tool call's question, and with a definition that changes under its question.
 *
 * No sign-in is made or used, nothing is sent anywhere but the one connection the server's `reach`
 * tool tries (1.1.1.1:53, as sandbox-check.ts probes the network), and everything created here is
 * removed at the end. The session-private file in /dev/shm standing in for a turn's access token
 * holds the word "placeholder" and no token.
 */

import { imageId } from "./check-image.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
	FETCH_BASE_TOOL,
	PUBLISH_SERVER,
	PUBLISH_TOOL,
	PUSH_TOOL,
	REPORT_TAKEN,
	REPORT_TOOL,
	pushRequest,
} from "../server/src/agent-publish.js";
import { NO_REDACTION } from "../server/src/repo-secrets.js";
import type { SandboxProfileId, WindlassEvent } from "../server/src/contract.js";
import { unaskedNote } from "../server/src/personal-servers.js";
import type {
	RunTurnInput,
	RunTurnResult,
	ScriptedModel,
	TurnPersonalServer,
	TurnQuestion,
	TurnServer,
	TurnServerOutcome,
	TurnServerQuestion,
	TurnUnaskedCall,
	Windlass,
} from "../server/src/sandbox/api.js";
import { sweepSessionProcesses } from "../server/src/sandbox/provider.js";
import { DATA_DIR, IMAGE, LABEL_ARG, docker, randomId } from "../server/src/sandbox/docker.js";
import { createSandboxLayer } from "../server/src/sandbox/index.js";
import type { DockerSandboxHandle } from "../server/src/sandbox/sandboxes.js";
import { variablesRead } from "../server/src/sandbox/turn.js";
import { DockerWindlass } from "../server/src/sandbox/windlass.js";
import {
	APPROVAL_TTL_MS,
	ApprovalBook,
	type ApprovalProject,
	type ServerApproval,
	knownServers,
	projectOf,
	serversView,
} from "../server/src/server-approvals.js";
import {
	forgettingWords,
	serverApprovedNote,
	serverForgottenNote,
	serverNotNowNote,
	serverPanelWords,
	serverQuestionWords,
	serverRecalledNote,
} from "../server/src/server-question.js";
import { sleep as wait } from "./check-wait.js";
import { Report } from "./check-report.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(root, "fixtures/mcp-repo");
/** `--image <tag>`: the sandbox image to run against; the server's own by default. */
const reference = process.argv.includes("--image")
	? (process.argv[process.argv.indexOf("--image") + 1] ?? IMAGE)
	: IMAGE;
const IMAGE_USED = await imageId(reference);
const layer = createSandboxLayer({ signIns: "memory", tokenNetwork: "none", image: IMAGE_USED });
const run = randomId(3);
const uid = `mcp-${run}`;
const uidOther = `mcp-${run}-b`;
const created = new Set<string>();
/** Every Docker user a sandbox was made for: each has a data volume to remove. */
const users = new Set<string>();
const tally = new Report();
const { expect } = tally;
function info(text: string): void {
	console.log(`      ${text}`);
}
async function section(name: string, body: () => Promise<void>): Promise<void> {
	console.log(`\n== ${name}`);
	try {
		await body();
	} catch (error) {
		expect(`${name}: unexpected error`, false, error instanceof Error ? (error.stack ?? error.message) : String(error));
	}
}

// ---------------------------------------------------------------------------------------------
// Sandboxes, the fixture, and turns
// ---------------------------------------------------------------------------------------------

function fixtureFiles(directory = FIXTURE): Array<{ path: string; content: string }> {
	return readdirSync(directory).flatMap(name => {
		const full = join(directory, name);
		return statSync(full).isDirectory()
			? fixtureFiles(full)
			: [{ path: relative(FIXTURE, full), content: readFileSync(full, "utf8") }];
	});
}

/** A sandbox whose workspace holds the fixture repository by default. */
async function sandbox(
	user: string,
	profile: SandboxProfileId,
	sessionId: string,
	files = fixtureFiles(),
): Promise<DockerSandboxHandle> {
	users.add(user);
	await layer.logins.ensureUserVolume(user);
	const id = await layer.sandboxes.create({ uid: user, sessionId, profile });
	created.add(id);
	const handle = (await layer.sandboxes.connect(id)) as DockerSandboxHandle;
	for (const file of files) await handle.writeTextFile(`/workspace/${file.path}`, file.content);
	return handle;
}

/** Replaces the definition of "harbor" in the workspace's `.windlass/config.json`. */
async function define(handle: DockerSandboxHandle, definition: Record<string, unknown>): Promise<void> {
	await handle.writeTextFile(
		"/workspace/.windlass/config.json",
		`${JSON.stringify({ mcp: { servers: { harbor: definition } } }, null, 2)}\n`,
	);
}

type Item = Record<string, unknown>;
const call = (callId: string, name: string, input: Record<string, unknown>): Item[] => [
	{ type: "tool_call", callId, name, input },
	{ type: "finish", reason: "tool_calls" },
];
const mcp = (callId: string, tool: string, args: Record<string, unknown> = {}) =>
	call(callId, "mcp_call", { server: "harbor", tool, arguments: args });
const say = (text: string): Item[] => [
	{ type: "text", text },
	{ type: "finish", reason: "stop" },
];
/** A scripted model: one list per model call, and spare answers for a call the script did not plan. */
const scripted = (...responses: Item[][]): ScriptedModel => ({
	responses: [...responses, say("Nothing more to do."), say("Nothing more to do.")],
});

interface Asked {
	question: TurnServerQuestion;
	/** How many events of the turn had arrived when the question was put, and whether Windlass had begun to work on the prompt. */
	eventsBefore: number;
	executionBegan: boolean;
}
interface TurnRun {
	result: RunTurnResult;
	events: WindlassEvent[];
	asked: Asked[];
	outcomes: Array<{ question: TurnServerQuestion; outcome: TurnServerOutcome }>;
	toolQuestions: TurnQuestion[];
	/** What the layer said of the project's servers, each time it said it. */
	servers: TurnServer[][];
	/** The calls the layer let run without asking, because their server's tools run that way. */
	unasked: TurnUnaskedCall[];
}
interface TurnOptions {
	windlassSessionId?: string;
	/** The answer to a server's question; without it nobody can be asked about servers. */
	server?: (question: TurnServerQuestion, signal: AbortSignal) => boolean | Promise<boolean>;
	/** The answer to a tool call's question. Default "once". */
	tool?: (question: TurnQuestion) => string | Promise<string>;
	unattended?: boolean;
	onReport?: RunTurnInput["onReport"];
	onPublish?: RunTurnInput["onPublish"];
	onPush?: RunTurnInput["onPush"];
	onFetchBase?: RunTurnInput["onFetchBase"];
	signal?: AbortSignal;
	windlass?: Windlass;
	/** Filled with the outcomes as they arrive, for an answer that has to wait for one. */
	outcomes?: TurnRun["outcomes"];
	/** The user's own servers the turn is handed. */
	own?: TurnPersonalServer[];
	/** An item's turn: nothing is answered unasked once Windlass says the session is tainted. */
	unaskedUntilTainted?: boolean;
}

async function turn(
	handle: DockerSandboxHandle,
	prompt: string,
	script: ScriptedModel,
	options: TurnOptions = {},
): Promise<TurnRun> {
	const events: WindlassEvent[] = [];
	const asked: Asked[] = [];
	const outcomes: TurnRun["outcomes"] = options.outcomes ?? [];
	const toolQuestions: TurnQuestion[] = [];
	const servers: TurnServer[][] = [];
	const unasked: TurnUnaskedCall[] = [];
	const answerServer = options.server;
	const result = await (options.windlass ?? layer.windlass).runTurn(handle, {
		prompt,
		script,
		windlassSessionId: options.windlassSessionId,
		signal: options.signal,
		servers: options.own,
		unaskedUntilTainted: options.unaskedUntilTainted,
		onUnasked: allowed => unasked.push(allowed),
		onEvent: event => events.push(event),
		onReport: options.onReport,
		onPublish: options.onPublish,
		onPush: options.onPush,
		onFetchBase: options.onFetchBase,
		onQuestion: options.unattended
			? undefined
			: async question => {
					toolQuestions.push(question);
					return { choice: options.tool ? await options.tool(question) : "once" };
				},
		onServerQuestion:
			answerServer === undefined
				? undefined
				: async (question, signal) => {
						asked.push({
							question,
							eventsBefore: events.length,
							executionBegan: events.some(event => event.type === "execution.started"),
						});
						return answerServer(question, signal);
					},
		onServerApproved: (question, outcome) => outcomes.push({ question, outcome }),
		onServers: list => servers.push(list),
	});
	return { result, events, asked, outcomes, toolQuestions, servers, unasked };
}

const dataOf = (event: WindlassEvent | undefined) => (event?.data ?? {}) as Record<string, unknown>;
const settled = (found: TurnRun, callId: string) =>
	found.events.find(event => event.type === "tool.settled" && dataOf(event).callId === callId);
const outputOf = (found: TurnRun, callId: string) => String(dataOf(settled(found, callId)).output ?? "");
/** How Windlass itself says an MCP call ended: "result", "refused", ... (`display.mcp.outcome`). */
const mcpOutcome = (found: TurnRun, callId: string) =>
	(dataOf(settled(found, callId)).display as { mcp?: { outcome?: string } } | undefined)?.mcp?.outcome ?? "none";
const outcomeOf = (found: TurnRun) => (found.result.summary as { outcome?: string } | null)?.outcome;
/** The list of tools Windlass appends for the model, when it did so before the turn's first model call. */
const toolsBeforeFirstStep = (found: TurnRun): string | null => {
	const firstStep = found.events.findIndex(event => event.type === "step.started");
	const appended = found.events.findIndex(
		event => event.type === "instruction.appended" && dataOf(event).source === "mcp",
	);
	return appended >= 0 && firstStep >= 0 && appended < firstStep
		? String(dataOf(found.events[appended]).text ?? "")
		: null;
};
/** An approved server's outcome: running, or still starting when the layer's wait ran out on a loaded host. */
const startedOrRunning = (state: string | undefined) => state === "running" || state === "starting";

// ---------------------------------------------------------------------------------------------
// A stand-in for the engine: a server reported while the turn runs
// ---------------------------------------------------------------------------------------------

/**
 * Speaks enough of the protocol for one turn. It says no server waits before the prompt. Once the
 * prompt has come it reports "harbor" as waiting (`_windlass/mcp_changed`) and, a moment later, asks
 * about a tool call (`session/request_permission`). The first approval finds nothing waiting, as when
 * the definition changed after the question was put, and names the definition that waits now; the
 * second starts the server, which says it runs with three tools. The turn ends when the call was
 * answered and the server runs.
 */
const STAND_IN = String.raw`
import { createInterface } from "node:readline";
const session = "ses_standin000000000000";
let seq = 0;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const event = (type, data) => send({ method: "_windlass/event", params: { sessionId: session, event: { type, v: 1, data, seq: ++seq, time: Date.now(), sessionId: session } } });
const argv = (flag) => ["python3", "tools/harbor_mcp.py", flag];
const server = (state, flag, extra = {}) => ({ name: "harbor", state, transport: "stdio", target: argv(flag).join(" "), argv: argv(flag), tools: null, hiddenTools: 0, error: null, retryInMs: null, origin: "project", file: "/workspace/.windlass/config.json", question: null, ...extra });
const waiting = (fingerprint, flag) => server("awaiting_approval", flag, { question: { fingerprint, subject: argv(flag).join(" "), details: [] } });
const changed = (servers) => send({ method: "_windlass/mcp_changed", params: { sessionId: session, available: true, servers } });
let prompt = null;
let approvals = 0;
let answered = false;
let running = false;
const finish = () => {
  if (!answered || !running || prompt === null) return;
  event("step.ended", { messageId: "m1", usage: null });
  event("execution.succeeded", { executionId: "exe_1", verification: { status: "not_configured" } });
  send({ id: prompt, result: { stopReason: "end_turn", _meta: { windlass: { executionId: "exe_1", outcome: "succeeded" } } } });
  prompt = null;
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { _meta: { windlass: { openMeta: ["hostTools"], notifications: ["_windlass/event", "_windlass/mcp_changed"] } } } } });
  else if (message.method === "session/new") send({ id: message.id, result: { sessionId: session } });
  else if (message.method === "_windlass/mcp") send({ id: message.id, result: { sessionId: session, available: true, servers: [] } });
  else if (message.method === "session/prompt") {
    prompt = message.id;
    event("execution.started", { executionId: "exe_1" });
    event("step.started", { messageId: "m1", attempt: 1, model: "stand-in" });
    changed([waiting("aaaaaaaaaaaaaaaa", "--old")]);
    const question = { title: "Allow network access for this command?", subject: "curl -sI https://example.com", details: [], choices: [{ id: "once", label: "Allow once", approve: true, remembers: null }, { id: "deny", label: "Decline", approve: false, remembers: null }] };
    setTimeout(() => send({ id: "ask-1", method: "session/request_permission", params: { sessionId: session, toolCall: { toolCallId: "m1/c1" }, options: [], _meta: { windlass: { approval: { messageId: "m1", callId: "c1", question } } } } }), 300);
  } else if (message.method === "_windlass/mcp_approve") {
    approvals += 1;
    if (approvals === 1) send({ id: message.id, result: { approved: false, servers: [waiting("bbbbbbbbbbbbbbbb", "--new")] } });
    else {
      changed([server("starting", "--new")]);
      // A reply and a newer notification can arrive in the same chunk.
      process.stdout.write([
        { jsonrpc: "2.0", id: message.id, result: { approved: true, servers: [server("starting", "--new")] } },
        { jsonrpc: "2.0", method: "_windlass/mcp_changed", params: { sessionId: session, available: true, servers: [server("running", "--new", { tools: 3 })] } },
      ].map(x => JSON.stringify(x)).join("\n") + "\n");
      running = true;
      finish();
    }
  } else if (message.id === "ask-1" && message.method === undefined) {
    answered = true;
    finish();
  } else if (message.method === "session/close") send({ id: message.id, result: {} });
  else if (message.id !== undefined && message.method !== undefined) send({ id: message.id, error: { code: -32601, message: "method not found: " + message.method } });
}).on("close", () => process.exit(0));
`;

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

/** The tools Windlass froze into the session's first baseline (`baseline.set`), by name. */
const baselineTools = (found: TurnRun): string[] =>
	((dataOf(found.events.find(e => e.type === "baseline.set")).tools as Array<{ name: string }> | undefined) ?? []).map(
		tool => tool.name,
	);
/** A call's trace in the turn's events, for the log: what Windlass did with it. */
const traceOf = (found: TurnRun, callId: string) =>
	found.events
		.filter(e => (dataOf(e).callId === callId || e.callId === callId) && e.type !== "tool.input.delta")
		.map(e => [e.type, dataOf(e).choice ?? dataOf(e).outcome].filter(Boolean).join("="))
		.join(" > ");
const asked = (found: TurnRun, callId: string) =>
	found.events.some(e => e.type.startsWith("approval.") && dataOf(e).callId === callId);

/**
 * The platform's own tools as Windlass's host tools, in a profile where Windlass asks before risky
 * calls (`docker-windlass-sandbox`, approval "auto") and in one where it does not (`docker-hardened`,
 * "full"). The callbacks stand in for the session's (agent-session.ts), which decide and do the work;
 * what is shown here is Windlass's side and the layer's: which tools a turn is offered, that no call
 * is asked about or refused for want of a person, that each callback is called once with what the
 * model wrote, and that its answer is the call's result.
 */
async function checkPlatformTools(profile: SandboxProfileId): Promise<void> {
	const handle = await sandbox(uid, profile, `mcp-tools-${profile}`, []);
	const given = {
		title: "Check the berth",
		description: "Berth four is free.\nThe schedule agrees.",
		concerns: "The tide was not checked.",
	};
	const where = { branch: "windlass/check-the-berth-abc123", title: "Check the berth" };
	const pushes: Record<string, unknown>[] = [];
	const fetches: number[] = [];
	// The session's own check of a push, so that a push naming another branch is refused as it would be.
	const onPush = async ({ arguments: args }: { arguments: Record<string, unknown> }) => {
		pushes.push(args);
		const checked = pushRequest(args, where, NO_REDACTION);
		return checked.ok ? `Pushed to ${where.branch} (0123456). No pull request was opened.` : checked.told;
	};
	const onFetchBase = async () => {
		fetches.push(1);
		return "Fetched main from GitHub into the workspace as origin/main.";
	};

	// An item's turn: nobody attends it.
	const received: Record<string, unknown>[] = [];
	const item = await turn(
		handle,
		"File the report, push, fetch the base, push to main.",
		scripted(
			call(REPORT_TOOL, REPORT_TOOL, given),
			call(PUSH_TOOL, PUSH_TOOL, { message: "The berth" }),
			call(FETCH_BASE_TOOL, FETCH_BASE_TOOL, {}),
			call("push-main", PUSH_TOOL, { branch: "main" }),
			call(PUBLISH_TOOL, PUBLISH_TOOL, { title: "Not offered" }),
			say("Done."),
		),
		{
			unattended: true,
			server: () => false,
			onReport: ({ arguments: args }) => {
				received.push(args);
				return REPORT_TAKEN;
			},
			onPush,
			onFetchBase,
			signal: AbortSignal.timeout(120_000),
		},
	);
	for (const id of [REPORT_TOOL, PUSH_TOOL, FETCH_BASE_TOOL, "push-main", PUBLISH_TOOL])
		info(`item ${id}: ${traceOf(item, id)}; ${outputOf(item, id).split("\n")[0]}`);
	const tools = baselineTools(item);
	expect(
		`${profile}: an item's turn is offered report, push and fetch_base as tools of its own, and not publish; no server of the platform's`,
		[REPORT_TOOL, PUSH_TOOL, FETCH_BASE_TOOL].every(name => tools.includes(name)) &&
			!tools.includes(PUBLISH_TOOL) &&
			!(toolsBeforeFirstStep(item) ?? "").includes(PUBLISH_SERVER),
		tools.join(","),
	);
	expect(
		`${profile}: the item's unattended report is not asked about, reaches the platform once, and is told it was taken`,
		isDeepStrictEqual(received, [given]) &&
			!asked(item, REPORT_TOOL) &&
			dataOf(settled(item, REPORT_TOOL)).outcome === "success" &&
			outputOf(item, REPORT_TOOL) === REPORT_TAKEN,
		outputOf(item, REPORT_TOOL),
	);
	expect(
		`${profile}: the item's push and fetch_base run unasked, each once, and the push's answer is the result`,
		!asked(item, PUSH_TOOL) &&
			!asked(item, FETCH_BASE_TOOL) &&
			isDeepStrictEqual(pushes[0], { message: "The berth" }) &&
			fetches.length === 1 &&
			outputOf(item, PUSH_TOOL).startsWith(`Pushed to ${where.branch}`),
		outputOf(item, PUSH_TOOL),
	);
	expect(
		`${profile}: a push that names main reaches the platform as written and is refused, with nothing pushed`,
		isDeepStrictEqual(pushes[1], { branch: "main" }) &&
			pushes.length === 2 &&
			outputOf(item, "push-main").startsWith("Not pushed. This session's work can only go to the session's own branch"),
		outputOf(item, "push-main"),
	);
	expect(
		`${profile}: publish, which the item is not offered, is refused by Windlass as no tool of its`,
		dataOf(settled(item, PUBLISH_TOOL)).outcome === "error",
		outputOf(item, PUBLISH_TOOL),
	);
	expect(
		`${profile}: the item's turn ended normally`,
		item.result.exitCode === 0 && outcomeOf(item) === "succeeded",
		outcomeOf(item) ?? item.result.stderrTail,
	);

	// A person's turn: attended. The platform's publish asks the person itself, inside the call; Windlass asks nothing.
	const published: Record<string, unknown>[] = [];
	const wait = profile === "docker-windlass-sandbox" ? 65_000 : 2_000;
	const person = await turn(
		handle,
		"Publish, then push.",
		scripted(
			call(PUBLISH_TOOL, PUBLISH_TOOL, { title: "Check the berth" }),
			call("person-push", PUSH_TOOL, {}),
			say("Done."),
		),
		{
			server: () => false,
			tool: () => "deny",
			// The person's yes, after a wait: past Windlass's default 60 s in one profile, which the declaration's time limit covers.
			onPublish: async ({ arguments: args }, signal) => {
				published.push(args);
				await new Promise<void>(resolve => {
					const timer = setTimeout(resolve, wait);
					signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
				});
				return signal.aborted
					? "withdrawn"
					: "Published. Opened pull request #7: https://github.invalid/ada/harbor/pull/7";
			},
			onPush,
			onFetchBase,
			signal: AbortSignal.timeout(180_000),
		},
	);
	for (const id of [PUBLISH_TOOL, "person-push"])
		info(`person ${id}: ${traceOf(person, id)}; ${outputOf(person, id).split("\n")[0]}`);
	expect(
		`${profile}: a person's turn is offered publish, push and fetch_base, and not report`,
		[PUBLISH_TOOL, PUSH_TOOL, FETCH_BASE_TOOL].every(name => baselineTools(person).includes(name)) &&
			!baselineTools(person).includes(REPORT_TOOL),
		baselineTools(person).join(","),
	);
	expect(
		`${profile}: the person's publish is not Windlass's question: the platform's callback is called once, waits ${wait / 1000} s for the person's yes, and its answer is the result`,
		person.toolQuestions.length === 0 &&
			!asked(person, PUBLISH_TOOL) &&
			published.length === 1 &&
			outputOf(person, PUBLISH_TOOL).startsWith("Published. Opened pull request #7"),
		`${person.toolQuestions.map(q => q.title).join(", ")} ${outputOf(person, PUBLISH_TOOL)}`,
	);
	expect(
		`${profile}: the person's push runs without a question`,
		!asked(person, "person-push") && pushes.length === 3 && outputOf(person, "person-push").startsWith("Pushed to"),
		outputOf(person, "person-push"),
	);
	expect(
		`${profile}: the person's turn ended normally`,
		person.result.exitCode === 0 && outcomeOf(person) === "succeeded",
		outcomeOf(person) ?? person.result.stderrTail,
	);
}

/** A call the platform does not answer in time ends as Windlass's documented error, and the callback is told to stop waiting. */
async function checkUnanswered(): Promise<void> {
	const handle = await sandbox(uid, "docker-windlass-sandbox", "mcp-tools-late", []);
	let aborted = false;
	const found = await turn(
		handle,
		"File the report.",
		scripted(call(REPORT_TOOL, REPORT_TOOL, { title: "Late", description: "Never answered." }), say("Done.")),
		{
			unattended: true,
			server: () => false,
			// The report allows three minutes for attachments. This callback deliberately never answers.
			onReport: ((_: unknown, signal: AbortSignal) =>
				new Promise<string>(resolve =>
					signal.addEventListener("abort", () => ((aborted = true), resolve("too late")), { once: true }),
				)) as unknown as RunTurnInput["onReport"],
			signal: AbortSignal.timeout(240_000),
		},
	);
	info(`late report: ${traceOf(found, REPORT_TOOL)}; ${outputOf(found, REPORT_TOOL)}`);
	expect(
		"a call not answered within its time is cancelled with Windlass's sentence, and the platform's callback is aborted",
		dataOf(settled(found, REPORT_TOOL)).outcome === "error" &&
			outputOf(found, REPORT_TOOL).startsWith(
				"The client did not answer the call to report within 180 s, and it was cancelled.",
			) &&
			aborted,
		outputOf(found, REPORT_TOOL),
	);
	expect(
		"the turn goes on and ends normally",
		outcomeOf(found) === "succeeded",
		outcomeOf(found) ?? found.result.stderrTail,
	);
}

/** A turn must refuse before opening a session if initialize omits host tools. */
async function checkMissingHostTools(): Promise<void> {
	const handle = await sandbox(uid, "docker-windlass-sandbox", "mcp-no-host-tools", []);
	const command = [
		"node",
		"-e",
		`process.stdin.once("data", chunk => {
		const { id } = JSON.parse(chunk);
		console.log(JSON.stringify({ jsonrpc: "2.0", id, result: { agentCapabilities: { _meta: { windlass: { notifications: ["_windlass/event"], openMeta: ["requiredChecks"] } } } } }));
	})`,
	];
	const windlass = new DockerWindlass({ engineCommand: command });
	const result = await windlass.runTurn(handle, { prompt: "hello", script: scripted(say("Done.")), onEvent: () => {} });
	expect(
		"initialize without host tools refuses the turn before it opens a session",
		result.failure?.reason === "host_tools_required" && result.windlassSessionId === null,
	);
}

async function checkOtherServers(): Promise<void> {
	await section("what the layer reads of a definition", async () => {
		const file = JSON.stringify({
			mcp: {
				servers: {
					harbor: {
						command: "x",
						env: { A: "${ONE}-${TWO}", B: "${ONE}", C: 7 },
						headers: { Authorization: "Bearer ${THREE}" },
					},
					other: { command: "y", env: { D: "${FOUR}" } },
				},
			},
		});
		expect(
			"the variables a definition reads are its own `${NAME}`s, each once, in order",
			JSON.stringify(variablesRead(file, "harbor")) === JSON.stringify(["ONE", "TWO", "THREE"]),
			JSON.stringify(variablesRead(file, "harbor")),
		);
		expect(
			"a file that is not what Windlass reads gives none",
			[
				variablesRead("not json", "harbor"),
				variablesRead("[]", "harbor"),
				variablesRead(file, "absent"),
				variablesRead('{"mcp":{"servers":{"harbor":"x"}}}', "harbor"),
			].every(names => names.length === 0),
		);
	});

	let sessionId: string | undefined;
	let approvedPrint = "";
	const strict = layer.sandboxes.profile("docker-windlass-sandbox");
	const context = {
		profile: strict,
		demo: true,
		dataInSandbox: layer.sandboxes.sessionsLiveInSandbox,
		project: projectOf({ sessionId: "mcp-strict", repoUrl: null }),
	};

	await section("docker-windlass-sandbox: the question, and both answers", async () => {
		const handle = await sandbox(uid, "docker-windlass-sandbox", "mcp-strict");

		// Nobody can be asked: the layer asks Windlass nothing, and the server stays stopped.
		const unasked = await turn(
			handle,
			"Which berth is free for Ada?",
			scripted(mcp("u1", "berth", { ship: "Ada" }), say("The server waits for you.")),
		);
		sessionId = unasked.result.windlassSessionId ?? undefined;
		expect(
			"without anyone to ask, the server stays stopped and the model is told it waits",
			outcomeOf(unasked) === "succeeded" && unasked.asked.length === 0 && mcpOutcome(unasked, "u1") === "refused",
			outputOf(unasked, "u1"),
		);

		// "Not now".
		const declined = await turn(
			handle,
			"Which berth is free for Ada?",
			scripted(mcp("d1", "berth", { ship: "Ada" }), say("The server waits for you.")),
			{ windlassSessionId: sessionId, server: () => false },
		);
		const first = declined.asked[0];
		expect(
			"Windlass reports the server as waiting, and the question is put once",
			declined.asked.length === 1 && first !== undefined,
			`${declined.asked.length} question(s)`,
		);
		if (first === undefined) return;
		expect(
			"the question has the command, each argument its own, and the file that defines it",
			first.question.name === "harbor" &&
				JSON.stringify(first.question.argv) === JSON.stringify(["python3", "tools/harbor_mcp.py"]) &&
				first.question.url === null &&
				first.question.file === "/workspace/.windlass/config.json" &&
				/^[0-9a-f]{16}$/.test(first.question.fingerprint),
			JSON.stringify(first.question),
		);
		expect(
			"it is put before the prompt goes: Windlass has not begun the turn, and the turn waits for the answer",
			first.question.holdsTurn === true && !first.executionBegan,
			`${first.eventsBefore} event(s) before it, none of an execution`,
		);
		expect("no variable is reported for a definition that reads none", first.question.unset.length === 0);
		const waits = declined.servers[0]?.[0];
		expect(
			"the layer says what the project names before the question is put: the server waits, with the fingerprint of its definition",
			declined.servers.length >= 1 &&
				declined.servers[0]?.length === 1 &&
				waits?.name === "harbor" &&
				waits.state === "waiting" &&
				waits.fingerprint === first.question.fingerprint &&
				JSON.stringify(waits.argv) === JSON.stringify(first.question.argv) &&
				waits.file === first.question.file,
			JSON.stringify(declined.servers[0]),
		);
		const words = serverQuestionWords(first.question, context);
		info(`the question as a demo session on this profile reads it: ${words.title}`);
		info(`  ${words.subject}`);
		for (const detail of words.details) info(`  ${detail}`);
		expect(
			'"not now" leaves it stopped: Windlass refuses the call and tells the model the server waits for the user',
			outcomeOf(declined) === "succeeded" && declined.outcomes.length === 0 && mcpOutcome(declined, "d1") === "refused",
			outputOf(declined, "d1"),
		);
		expect("the model's first request has no tools of the server", toolsBeforeFirstStep(declined) === null);
		info(`the timeline's line: ${serverNotNowNote(first.question)}`);

		// Approved: asked again by the next turn, started, and callable in that turn.
		const approved = await turn(
			handle,
			"Which berth is free for Ada?",
			scripted(mcp("a1", "berth", { ship: "Ada" }), say("Berth 4.")),
			{ windlassSessionId: sessionId, server: () => true },
		);
		const again = approved.asked[0];
		expect(
			"a server left stopped is asked about again by the next turn, as the same definition",
			approved.asked.length === 1 && again?.question.fingerprint === first.question.fingerprint,
			`fingerprint ${again?.question.fingerprint}`,
		);
		const outcome = approved.outcomes[0]?.outcome;
		expect(
			"approving starts it through Windlass: it runs, with its two tools",
			approved.outcomes.length === 1 && outcome?.state === "running" && outcome.tools === 2,
			JSON.stringify(outcome),
		);
		if (again && outcome) info(`the timeline's line: ${serverApprovedNote(again.question, outcome).text}`);
		const told = toolsBeforeFirstStep(approved);
		expect(
			"the model's first request of that turn has the server's tools",
			told !== null && told.includes("harbor (2 tools)") && told.includes("- berth:"),
			told?.split("\n").slice(-4, -1).join(" | ") ?? "no list of tools before the first model call",
		);
		expect(
			"the model calls a tool of the server in that turn",
			outcomeOf(approved) === "succeeded" &&
				mcpOutcome(approved, "a1") === "result" &&
				outputOf(approved, "a1").includes("Berth 4 is free for Ada."),
			outputOf(approved, "a1").split("\n").at(-1),
		);
		expect(
			"in this profile Windlass asks before each call of an MCP tool, through the question the platform already puts",
			approved.toolQuestions.length === 1 && approved.toolQuestions[0]?.title === "Allow the MCP tool harbor/berth?",
			approved.toolQuestions[0]?.title,
		);
		const ran = approved.servers.at(-1)?.[0];
		expect(
			"and the layer says so when the server runs: its state, its tools, and no fingerprint any more",
			approved.servers[0]?.[0]?.state === "waiting" &&
				ran?.state === "running" &&
				ran.tools === 2 &&
				ran.fingerprint === null,
			approved.servers.map(list => list.map(server => server.state).join(",")).join(" > "),
		);
		// What a session keeps of that for its panel: the fingerprint the server waited with stays with it while its command does.
		const kept = approved.servers.reduce(
			(known, list) => knownServers(known, list, Date.now()),
			knownServers([], declined.servers.at(-1) ?? [], Date.now()),
		);
		expect(
			"a session that folds these keeps the definition the server was approved with",
			kept.length === 1 &&
				kept[0]?.state === "running" &&
				kept[0].tools === 2 &&
				kept[0].fingerprint === first.question.fingerprint &&
				kept[0].subject === "python3 tools/harbor_mcp.py",
			JSON.stringify(kept),
		);
		approvedPrint = first.question.fingerprint;

		// A new harness starts approved servers after the same boundary sweep used for token-bearing turns.
		await sweepSessionProcesses(handle);
		await handle.run("umask 077; printf placeholder > /dev/shm/access-token-mcp-check.json");
		const later = await turn(
			handle,
			"And what can the server reach?",
			scripted(
				mcp("l1", "reach"),
				call("l2", "shell", {
					command: `if timeout 4 bash -c 'exec 3<>/dev/tcp/1.1.1.1/53' 2>/dev/null; then echo NET_OK; else echo NET_BLOCKED; fi; ls ${DATA_DIR} >/dev/null 2>&1 && echo DATA_READABLE || echo DATA_HIDDEN; test -r /dev/shm/access-token-mcp-check.json && echo TOKEN_READABLE || echo TOKEN_HIDDEN`,
				}),
				say("Done."),
			),
			{ windlassSessionId: sessionId, server: () => true },
		);
		expect(
			"a later message does not ask again: Windlass remembers the approval",
			later.asked.length === 0 && later.outcomes.length === 0,
		);
		expect(
			"and the layer says the server runs, though nobody was asked",
			later.servers.at(-1)?.[0]?.state === "running" &&
				later.servers.every(list => list.every(server => server.fingerprint === null)),
			later.servers.map(list => list.map(server => server.state).join(",")).join(" > "),
		);
		expect(
			"and the model calls the server's tool in it",
			outcomeOf(later) === "succeeded" && mcpOutcome(later, "l1") === "result",
			outputOf(later, "l1").split("\n").slice(1).join(" | "),
		);
		const reach = outputOf(later, "l1");
		const command = outputOf(later, "l2");
		expect(
			"the server can read both Windlass's data directory and the session-private token fixture",
			reach.includes("data directory: readable") && reach.includes("access token file: present"),
			reach.split("\n").slice(1, 4).join(" | "),
		);
		expect("the approved server can reach the network", reach.includes("network: reachable"));
		expect(
			"a command in the same turn has no network and cannot see the data directory or the token fixture",
			command.includes("NET_BLOCKED") && command.includes("DATA_HIDDEN") && command.includes("TOKEN_HIDDEN"),
			command.trim().split("\n").join(" | "),
		);
		await handle.run(`rm -f /dev/shm/access-token-mcp-check.json`);
	});

	await section("docker-windlass-sandbox: a changed definition, and a variable that is not set", async () => {
		const handle = (await layer.sandboxes.connect([...created][0] ?? "")) as DockerSandboxHandle;

		await define(handle, { command: "python3", args: ["tools/harbor_mcp.py", "--berths", "12 or more"] });
		const changed = await turn(
			handle,
			"Which berth is free for Bea?",
			scripted(mcp("c1", "berth", { ship: "Bea" }), say("Berth 4.")),
			{ windlassSessionId: sessionId, server: () => true },
		);
		const asked = changed.asked[0]?.question;
		expect(
			"a changed definition is asked about again, with the new command",
			changed.asked.length === 1 &&
				asked !== undefined &&
				asked.fingerprint !== approvedPrint &&
				JSON.stringify(asked.argv) === JSON.stringify(["python3", "tools/harbor_mcp.py", "--berths", "12 or more"]),
			asked
				? `${serverQuestionWords(asked, context).subject} (fingerprint ${asked.fingerprint}, before ${approvedPrint})`
				: "no question",
		);
		expect(
			"and starts once approved",
			startedOrRunning(changed.outcomes[0]?.outcome.state) && mcpOutcome(changed, "c1") === "result",
			JSON.stringify(changed.outcomes[0]?.outcome),
		);

		await define(handle, {
			command: "python3",
			args: ["tools/harbor_mcp.py"],
			env: { HARBOR_NOTE: "${HARBOR_TOKEN}" },
		});
		const unset = await turn(
			handle,
			"Which berth is free for Cy?",
			scripted(mcp("e1", "berth", { ship: "Cy" }), say("The server did not start.")),
			{ windlassSessionId: sessionId, server: () => true },
		);
		const needs = unset.asked[0]?.question;
		expect(
			"a definition that reads a variable which is not set says which, before the answer",
			unset.asked.length === 1 && JSON.stringify(needs?.unset) === JSON.stringify(["HARBOR_TOKEN"]),
			needs ? (serverQuestionWords(needs, context).details.at(-1) ?? "") : "no question",
		);
		const failed = unset.outcomes[0]?.outcome;
		expect(
			"approved all the same, it does not start, and Windlass says why",
			failed?.state === "failed" && failed.reason.includes("HARBOR_TOKEN"),
			failed?.state === "failed" ? failed.reason : JSON.stringify(failed),
		);
		if (needs && failed) info(`the timeline's line: ${serverApprovedNote(needs, failed).text}`);
		expect(
			"the model is told the server is not running, and the turn goes on",
			outcomeOf(unset) === "succeeded" && mcpOutcome(unset, "e1") === "refused",
			outputOf(unset, "e1"),
		);

		await define(handle, { command: "python3", args: ["tools/harbor_mcp.py"], env: { HARBOR_NOTE: "${HOME}" } });
		const set = await turn(handle, "And what can the server reach?", scripted(mcp("s1", "reach"), say("Done.")), {
			windlassSessionId: sessionId,
			server: () => true,
		});
		expect(
			"a variable that is set in the sandbox is not reported, and the server starts with its value",
			set.asked.length === 1 &&
				set.asked[0]?.question.unset.length === 0 &&
				set.outcomes[0]?.outcome.state === "running" &&
				outputOf(set, "s1").includes("HARBOR_NOTE: /home/agent"),
			outputOf(set, "s1").split("\n").at(-1),
		);
	});

	await section("where an approval is remembered on Docker", async () => {
		const first = (await layer.sandboxes.connect([...created][0] ?? "")) as DockerSandboxHandle;
		const kept = await first.run(
			`grep -l 'mcp-server:harbor:${approvedPrint}' ${DATA_DIR}/approvals/*.json | wc -l; grep -h '"workspace"' ${DATA_DIR}/approvals/*.json | sort -u`,
		);
		expect(
			"Windlass keeps it in its data directory, for the project directory /workspace and that definition",
			kept.stdout.trim().startsWith("1") && kept.stdout.includes('"/workspace"'),
			kept.stdout.trim().split("\n").join(" | "),
		);
		const mounts = await docker([
			"container",
			"inspect",
			"--format",
			"{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}",
			first.container,
		]);
		expect(
			"which on Docker is the user's volume, not the session's container",
			mounts.stdout.trim() === `wlp-user-${uid}:${DATA_DIR}`,
			mounts.stdout.trim(),
		);

		const second = await sandbox(uid, "docker-windlass-sandbox", "mcp-second");
		const same = await turn(
			second,
			"Which berth is free for Dee?",
			scripted(mcp("o1", "berth", { ship: "Dee" }), say("Berth 4.")),
			{ server: () => false },
		);
		expect(
			"so another session of the same user, with the same definition, is not asked and has the server",
			same.asked.length === 0 && mcpOutcome(same, "o1") === "result",
			outputOf(same, "o1").split("\n").at(-1),
		);

		const stranger = await sandbox(uidOther, "docker-windlass-sandbox", "mcp-other-user");
		const other = await turn(
			stranger,
			"Which berth is free for Eli?",
			scripted(mcp("x1", "berth", { ship: "Eli" }), say("The server waits for you.")),
			{ server: () => false },
		);
		expect("and another user's session is asked", other.asked.length === 1 && mcpOutcome(other, "x1") === "refused");
	});

	await section(
		"the platform's own memory of an approval, where each sandbox keeps Windlass's data to itself (as on E2B)",
		async () => {
			// On Docker Windlass's data is a volume of the sandbox's user, which is what makes its own record reach
			// every session there. A Docker user per sandbox gives each a data directory of its own, as a microVM has,
			// so that what is seen here is the platform's memory and not Windlass's.
			let disks = 0;
			const disk = (sessionId: string) => sandbox(`mcp-${run}-d${(disks += 1)}`, "docker-windlass-sandbox", sessionId);
			/** The platform's users, each with the book their `user` actor keeps (server-approvals.ts). */
			const books = new Map<string, ApprovalBook>();
			const bookOf = (user: string) =>
				books.get(user) ?? (books.set(user, new ApprovalBook()), books.get(user) as ApprovalBook);
			/** The platform's clock, which a check moves. */
			let now = Date.now();
			const DAY = 24 * 60 * 60 * 1000;
			interface Remembered extends TurnRun {
				/** The definitions Windlass reported as waiting, the ones put to the user, and the ones answered from the book. */
				reported: TurnServerQuestion[];
				put: TurnServerQuestion[];
				recalled: ServerApproval[];
				/** The timeline's lines about servers, as the session writes them. */
				lines: string[];
			}
			/**
			 * One turn as the session actor runs it (actors/agent-session.ts, `askServer` and `onServerApproved`):
			 * the user's book is asked before the question is put, an approval of exactly this definition for the
			 * project answers it, and the user's own yes is kept once Windlass took it.
			 */
			const remembering = async (
				user: string,
				project: ApprovalProject,
				handle: DockerSandboxHandle,
				prompt: string,
				script: ScriptedModel,
				answer: boolean,
				windlassSessionId?: string,
			): Promise<Remembered> => {
				const book = bookOf(user);
				const reported: TurnServerQuestion[] = [];
				const put: TurnServerQuestion[] = [];
				const recalled = new Map<string, ServerApproval>();
				const found = await turn(handle, prompt, script, {
					windlassSessionId,
					server: question => {
						reported.push(question);
						const approval = book.find(project.key, question.name, question.fingerprint, now);
						if (approval) {
							recalled.set(`${question.name}:${question.fingerprint}`, approval);
							return true;
						}
						put.push(question);
						return answer;
					},
				});
				const lines: string[] = [];
				for (const { question, outcome } of found.outcomes) {
					const approval = recalled.get(`${question.name}:${question.fingerprint}`);
					if (approval) {
						const days = Math.round((now - approval.approvedAt) / DAY);
						lines.push(
							serverRecalledNote(
								question,
								outcome,
								now - approval.approvedAt < 60_000 ? "a moment ago" : days === 1 ? "1 day ago" : `${days} days ago`,
							).text,
						);
					} else {
						lines.push(serverApprovedNote(question, outcome).text);
						if (outcome.state === "running" || outcome.state === "starting" || outcome.state === "failed")
							book.approve(
								{ project: project.key, label: project.label, name: question.name, fingerprint: question.fingerprint },
								now,
							);
					}
				}
				return { ...found, reported, put, recalled: [...recalled.values()], lines };
			};
			const berth = (callId: string, ship: string) => scripted(mcp(callId, "berth", { ship }), say("Berth 4."));
			/** Windlass's own record in a sandbox: how many files of its approvals name the server. */
			const ownRecords = async (handle: DockerSandboxHandle) =>
				(
					await handle.run(`grep -l 'mcp-server:harbor:' ${DATA_DIR}/approvals/*.json 2>/dev/null | wc -l`)
				).stdout.trim();

			// The projects: a repository of the GitHub connection is known by GitHub's id, a pasted one by its address, and a session without one is its own.
			const harborRepo = projectOf({
				sessionId: "s-1",
				repoUrl: "https://github.com/acme/harbor.git",
				repo: { id: 7101, owner: "acme", name: "harbor" },
			});
			const renamed = projectOf({
				sessionId: "s-9",
				repoUrl: "https://github.com/acme/quay.git",
				repo: { id: 7101, owner: "acme", name: "quay" },
			});
			const lighthouse = projectOf({
				sessionId: "s-5",
				repoUrl: "https://github.com/acme/lighthouse.git",
				repo: { id: 7102, owner: "acme", name: "lighthouse" },
			});
			const pasted = projectOf({ sessionId: "s-6", repoUrl: "https://example.com/acme/harbor.git" });
			const alone = projectOf({ sessionId: "s-7", repoUrl: null });
			expect(
				"a project is the GitHub repository by its id (a rename keeps it), the pasted address, or the session itself",
				harborRepo.key === "github:7101" &&
					renamed.key === harborRepo.key &&
					renamed.label === "acme/quay" &&
					lighthouse.key === "github:7102" &&
					pasted.key === "address:https://example.com/acme/harbor.git" &&
					pasted.label === "example.com/acme/harbor.git" &&
					alone.key === "session:s-7" &&
					projectOf({ sessionId: "s-8", repoUrl: null }).key !== alone.key,
				[harborRepo, renamed, lighthouse, pasted, alone]
					.map(project => `${project.key} ("${project.label}")`)
					.join(", "),
			);

			// The first session of ada on acme/harbor: asked, and her yes is remembered.
			const first = await disk("s-1");
			const asked = await remembering(
				"ada",
				harborRepo,
				first,
				"Which berth is free for Ada?",
				berth("p1", "Ada"),
				true,
			);
			const print = asked.put[0]?.fingerprint ?? "";
			// The layer reports "starting" when the server has not said it runs within its 5 s (a loaded host): the call's result shows it ran.
			expect(
				"the first session on a repository is asked, and the yes starts the server",
				asked.put.length === 1 &&
					asked.recalled.length === 0 &&
					startedOrRunning(asked.outcomes[0]?.outcome.state) &&
					mcpOutcome(asked, "p1") === "result",
				asked.lines.join(" | "),
			);
			const record = bookOf("ada").find(harborRepo.key, "harbor", print, now);
			expect(
				"the platform remembers it for that user, repository and definition, for 30 days",
				record !== null && record.expiresAt - record.approvedAt === APPROVAL_TTL_MS && bookOf("ada").all().length === 1,
				JSON.stringify(record),
			);
			const words = serverQuestionWords(asked.put[0] as TurnServerQuestion, {
				profile: strict,
				demo: false,
				dataInSandbox: true,
				project: harborRepo,
			});
			info("the question as a session whose sandbox keeps Windlass's data to itself reads it:");
			for (const detail of words.details) info(`  ${detail}`);

			// A second session on the same repository, in a sandbox of its own.
			const second = await disk("s-2");
			expect(
				"a new sandbox has no record of Windlass's own",
				(await ownRecords(second)) === "0",
				`${await ownRecords(second)} file(s)`,
			);
			now += 3 * DAY;
			const again = await remembering(
				"ada",
				harborRepo,
				second,
				"Which berth is free for Bea?",
				berth("p2", "Bea"),
				false,
			);
			expect(
				"a second session on the same repository is not asked: Windlass reports the server as waiting, and the platform approves it from the user's record",
				again.reported.length === 1 &&
					again.reported[0]?.fingerprint === print &&
					again.put.length === 0 &&
					again.recalled.length === 1 &&
					again.reported[0]?.holdsTurn === true &&
					!again.asked[0]?.executionBegan,
				`${again.reported.length} reported, ${again.put.length} put to the user`,
			);
			const told = toolsBeforeFirstStep(again);
			expect(
				"and the server runs: the model's first request has its tools, and it calls one",
				again.outcomes[0]?.outcome.state === "running" &&
					told !== null &&
					told.includes("harbor (2 tools)") &&
					mcpOutcome(again, "p2") === "result" &&
					outputOf(again, "p2").includes("Berth 4 is free for Bea."),
				outputOf(again, "p2").split("\n").at(-1),
			);
			expect(
				"the timeline's line says why nobody was asked, and when the user approved",
				again.lines.length === 1 &&
					again.lines[0] ===
						'Started the MCP server "harbor" because you approved it for this project 3 days ago: 2 tools. The agent has them from this turn on.',
				again.lines[0],
			);
			expect(
				"using the record does not renew it",
				bookOf("ada").find(harborRepo.key, "harbor", print, now)?.approvedAt === record?.approvedAt,
			);
			const panel = serversView(
				harborRepo,
				again.servers.reduce((known, list) => knownServers(known, list, now), knownServers([], [], now)),
				bookOf("ada").of(harborRepo.key, now),
				forgettingWords({ dataInSandbox: true }),
				server => serverPanelWords(server, { profile: strict, demo: false, dataInSandbox: true, project: harborRepo }),
			);
			expect(
				"what that session's panel lists: the server, running with its tools, and the approval with the day it runs out",
				panel.servers.length === 1 &&
					panel.servers[0]?.state === "running" &&
					panel.servers[0].tools === 2 &&
					panel.servers[0].approval?.expiresAt === record?.expiresAt &&
					panel.project.label === "acme/harbor",
				JSON.stringify(panel.servers[0]),
			);

			// The first session's sandbox is lost and replaced: a new disk, the same session.
			await layer.sandboxes.destroy(first.id);
			created.delete(first.id);
			const replaced = await disk("s-1");
			const after = await remembering(
				"ada",
				harborRepo,
				replaced,
				"Which berth is free for Cy?",
				berth("p3", "Cy"),
				false,
			);
			expect(
				"a sandbox that replaces a lost one is not asked, in the middle of the conversation the server was approved in",
				after.reported.length === 1 &&
					after.put.length === 0 &&
					startedOrRunning(after.outcomes[0]?.outcome.state) &&
					mcpOutcome(after, "p3") === "result",
				after.lines.join(" | "),
			);

			// A changed definition in the second session.
			await define(second, { command: "python3", args: ["tools/harbor_mcp.py", "--berths", "12"] });
			const changed = await remembering(
				"ada",
				harborRepo,
				second,
				"Which berth is free for Dee?",
				berth("p4", "Dee"),
				false,
				again.result.windlassSessionId ?? undefined,
			);
			expect(
				"a changed definition is asked about: the record is of the definition that was approved",
				changed.put.length === 1 &&
					changed.put[0]?.fingerprint !== print &&
					changed.recalled.length === 0 &&
					mcpOutcome(changed, "p4") === "refused",
				`fingerprint ${changed.put[0]?.fingerprint}, approved ${print}`,
			);

			// Another user on the same repository.
			const theirs = await disk("s-3");
			const other = await remembering(
				"bo",
				harborRepo,
				theirs,
				"Which berth is free for Eli?",
				berth("p5", "Eli"),
				false,
			);
			expect(
				"another user on the same repository is asked",
				other.put.length === 1 &&
					other.put[0]?.fingerprint === print &&
					other.recalled.length === 0 &&
					mcpOutcome(other, "p5") === "refused",
			);

			// Another repository that names the server the same way.
			const elsewhere = await disk("s-5");
			const same = await remembering(
				"ada",
				lighthouse,
				elsewhere,
				"Which berth is free for Fay?",
				berth("p6", "Fay"),
				false,
			);
			expect(
				"another repository that names a server the same way is asked: the same name and the same definition, in another project",
				same.put.length === 1 &&
					same.put[0]?.fingerprint === print &&
					same.recalled.length === 0 &&
					mcpOutcome(same, "p6") === "refused",
				`fingerprint ${same.put[0]?.fingerprint}`,
			);

			// One day short of 30, and past them.
			now = (record?.approvedAt ?? now) + APPROVAL_TTL_MS - 60_000;
			const late = await disk("s-10");
			const lastDay = await remembering(
				"ada",
				harborRepo,
				late,
				"Which berth is free for Gus?",
				berth("p7", "Gus"),
				false,
			);
			expect(
				"a minute before its 30 days are over the approval still answers",
				lastDay.put.length === 0 && lastDay.recalled.length === 1 && mcpOutcome(lastDay, "p7") === "result",
				lastDay.lines[0],
			);
			now += 2 * 60_000;
			const past = await disk("s-11");
			const expired = await remembering(
				"ada",
				harborRepo,
				past,
				"Which berth is free for Hal?",
				berth("p8", "Hal"),
				false,
			);
			expect(
				"an approval past its 30 days is asked about again",
				expired.put.length === 1 &&
					expired.recalled.length === 0 &&
					mcpOutcome(expired, "p8") === "refused" &&
					bookOf("ada").of(harborRepo.key, now).length === 0,
			);

			// Forgetting, with an approval that holds.
			const renewed = await remembering(
				"ada",
				harborRepo,
				past,
				"Which berth is free for Ida?",
				berth("p9", "Ida"),
				true,
				expired.result.windlassSessionId ?? undefined,
			);
			expect(
				"approving again remembers it from then",
				renewed.put.length === 1 &&
					renewed.outcomes[0]?.outcome.state === "running" &&
					bookOf("ada").find(harborRepo.key, "harbor", print, now)?.approvedAt === now,
			);
			const forgotten = bookOf("ada").forget(harborRepo.key, "harbor");
			expect(
				"forgetting removes the user's record of that server for the project",
				forgotten.removed.length === 1 && bookOf("ada").of(harborRepo.key, now).length === 0,
			);
			info(`the timeline's line: ${serverForgottenNote({ name: "harbor" }, { dataInSandbox: true })}`);
			info(`the panel's note: ${forgettingWords({ dataInSandbox: true })}`);
			const next = await disk("s-12");
			const afresh = await remembering(
				"ada",
				harborRepo,
				next,
				"Which berth is free for Jo?",
				berth("p10", "Jo"),
				false,
			);
			expect(
				"after forgetting, the next session is asked",
				afresh.put.length === 1 && afresh.recalled.length === 0 && mcpOutcome(afresh, "p10") === "refused",
			);
			const still = await remembering(
				"ada",
				harborRepo,
				past,
				"Which berth is free for Kit?",
				berth("p11", "Kit"),
				false,
				expired.result.windlassSessionId ?? undefined,
			);
			expect(
				"and a sandbox the server already started in still starts it, from Windlass's own record: forgetting is for the next session or sandbox",
				still.reported.length === 0 && mcpOutcome(still, "p11") === "result" && (await ownRecords(past)) === "1",
				`${still.reported.length} reported as waiting; ${await ownRecords(past)} record of Windlass's own in that sandbox`,
			);
		},
	);

	await section("docker-hardened: the same question where commands are not sandboxed", async () => {
		const handle = await sandbox(uidOther, "docker-hardened", "mcp-hardened");
		const found = await turn(
			handle,
			"What can the server reach?",
			scripted(
				mcp("h1", "reach"),
				call("h2", "shell", {
					command: `if timeout 4 bash -c 'exec 3<>/dev/tcp/1.1.1.1/53' 2>/dev/null; then echo NET_OK; else echo NET_BLOCKED; fi; ls ${DATA_DIR} >/dev/null 2>&1 && echo DATA_READABLE || echo DATA_HIDDEN`,
				}),
				say("Done."),
			),
			{ server: () => true },
		);
		const asked = found.asked[0]?.question;
		// "starting" on a loaded host, then running by the layer's later word (`onServers`).
		const ranLater = found.servers.some(list =>
			list.some(server => server.name === "harbor" && server.state === "running"),
		);
		expect(
			"the question is put before the prompt here too, and approving starts the server",
			found.asked.length === 1 &&
				asked?.holdsTurn === true &&
				(found.outcomes[0]?.outcome.state === "running" ||
					(found.outcomes[0]?.outcome.state === "starting" && ranLater)),
			JSON.stringify(found.outcomes[0]?.outcome),
		);
		if (asked)
			for (const detail of serverQuestionWords(asked, {
				profile: layer.sandboxes.profile("docker-hardened"),
				demo: true,
				dataInSandbox: true,
				project: projectOf({ sessionId: "mcp-hardened", repoUrl: null }),
			}).details)
				info(`  ${detail}`);
		expect(
			"Windlass runs the first MCP call without asking in this profile",
			found.toolQuestions.every(question => question.callId !== "h1") && mcpOutcome(found, "h1") === "result",
		);
		// What the server returned is content Windlass does not control: from there on it asks before a command it cannot sandbox, in this profile too.
		const afterwards = found.toolQuestions.find(question => question.callId === "h2");
		expect(
			"and asks before the command that follows the server's answer, which it does not trust",
			found.toolQuestions.length === 1 && afterwards !== undefined,
			afterwards ? `${afterwards.title} ${afterwards.details.join(" ")}` : `${found.toolQuestions.length} question(s)`,
		);
		const reach = outputOf(found, "h1");
		const command = outputOf(found, "h2");
		expect(
			"the server and the agent's commands reach the same here: the network and the data directory",
			reach.includes("network: reachable") &&
				reach.includes("data directory: readable") &&
				command.includes("NET_OK") &&
				command.includes("DATA_READABLE"),
			`${reach.split("\n").slice(1, 3).join(" | ")}; command: ${command.trim().split("\n").join(" | ")}`,
		);
	});

	await section("a turn stopped under the question", async () => {
		const handle = await sandbox(uidOther, "docker-windlass-sandbox", "mcp-stopped");
		await define(handle, { command: "python3", args: ["tools/harbor_mcp.py", "--stopped"] });
		const controller = new AbortController();
		let withdrawn = false;
		const stopped = await turn(handle, "Which berth is free?", scripted(say("Never said.")), {
			signal: controller.signal,
			server: (_question, signal) =>
				new Promise<boolean>(() => {
					signal.addEventListener("abort", () => (withdrawn = true), { once: true });
					setTimeout(() => controller.abort(), 300);
				}),
		});
		expect(
			"stopping the turn withdraws the question, and the turn ends without Windlass having begun it",
			stopped.asked.length === 1 &&
				withdrawn &&
				stopped.result.aborted &&
				stopped.result.failure === null &&
				!stopped.events.some(event => event.type === "execution.started") &&
				stopped.outcomes.length === 0,
			`aborted ${stopped.result.aborted}, ${stopped.events.length} event(s), none of an execution`,
		);
		const leftovers = await handle.run("wlp-run tags-of windlass | wc -l");
		expect("and no Windlass is left running in the sandbox", leftovers.stdout.trim() === "0", leftovers.stdout.trim());
	});

	await section("a server reported while the turn runs (a stand-in for the engine)", async () => {
		const handle = await sandbox(uidOther, "docker-windlass-sandbox", "mcp-stand-in");
		await handle.writeTextFile("/tmp/mcp-stand-in.mjs", STAND_IN);
		const windlass = new DockerWindlass({
			image: IMAGE_USED,
			engineCommand: ["node", "/tmp/mcp-stand-in.mjs"],
		});
		let toolAsked: () => void = () => {};
		const whenToolAsked = new Promise<void>(resolve => (toolAsked = resolve));
		/** What was open when: "server:<fingerprint>" and "call". */
		const order: string[] = [];
		let bothOpen = false;
		let serverOpen = false;
		const outcomes: TurnRun["outcomes"] = [];
		const found = await turn(handle, "x", scripted(say("unused")), {
			windlass,
			outcomes,
			server: async question => {
				order.push(`server:${question.fingerprint}`);
				serverOpen = true;
				// The first is answered only once the call's question is open as well.
				if (order.length === 1) await whenToolAsked;
				serverOpen = false;
				return true;
			},
			tool: async () => {
				order.push("call");
				bothOpen = serverOpen;
				toolAsked();
				// Answered after the server runs.
				for (let waited = 0; waited < 5000 && outcomes.length < 2; waited += 50) await wait(50);
				return "once";
			},
		});
		expect(
			"the server's question is put while the turn runs and does not hold it",
			found.asked[0]?.question.holdsTurn === false && found.asked[0]?.executionBegan === true,
			JSON.stringify(found.asked[0]?.question),
		);
		expect(
			"a tool call's question arrives while it is open: the layer hands both over, for the session to put in order",
			bothOpen && order[0] === "server:aaaaaaaaaaaaaaaa" && order[1] === "call",
			order.join(", "),
		);
		expect(
			"an approval that finds the definition changed starts nothing, and the new definition is asked about",
			found.outcomes[0]?.outcome.state === "changed" &&
				order[2] === "server:bbbbbbbbbbbbbbbb" &&
				JSON.stringify(found.asked[1]?.question.argv) === JSON.stringify(["python3", "tools/harbor_mcp.py", "--new"]),
			`${JSON.stringify(found.outcomes[0]?.outcome)}; then ${order[2]}`,
		);
		const ran = found.outcomes[1];
		expect(
			"the second approval starts it, and what the server says of itself is reported",
			ran?.outcome.state === "running" && ran.outcome.tools === 3,
			JSON.stringify(ran?.outcome),
		);
		if (ran) info(`the timeline's line: ${serverApprovedNote(ran.question, ran.outcome).text}`);
		expect(
			"the turn ends as the engine said",
			outcomeOf(found) === "succeeded" && found.result.failure === null,
			`${outcomeOf(found)} ${found.result.failure?.message ?? ""}`,
		);
	});

	await section(
		"a user's own server: its tools are asked about, or run without asking where its user said so",
		async () => {
			// The fixture's server under another name, as the user's own: the layer writes it into Windlass's own configuration for each turn.
			const tracker: TurnPersonalServer = {
				name: "tracker",
				definition: { command: "python3", args: ["tools/harbor_mcp.py"] },
			};
			const quiet: TurnPersonalServer = { ...tracker, unasked: true };
			// Two calls: the second names the tool with the server in front, which Windlass takes too, and comes after the first one's result.
			const twoCalls = () =>
				scripted(
					call("o1", "mcp_call", { server: "tracker", tool: "berth", arguments: { ship: "Ada" } }),
					call("o2", "mcp_call", { server: "tracker", tool: "tracker/berth", arguments: { ship: "Bo" } }),
					say("Both have a berth."),
				);
			const ran = (found: TurnRun) => ["o1", "o2"].every(id => mcpOutcome(found, id) === "result");
			const answers = (found: TurnRun) =>
				found.events
					.filter(event => event.type === "approval.answered")
					.map(event => `${String(dataOf(event).callId)}:${String(dataOf(event).choice)}`);
			const allowed = (found: TurnRun) => found.unasked.map(one => `${one.callId}:${one.server}/${one.tool}`);
			const none = "{}\n";

			const handle = await sandbox(uid, "docker-windlass-sandbox", "mcp-own");
			// This repository names no server: "tracker" is the user's alone.
			await handle.writeTextFile("/workspace/.windlass/config.json", none);
			const asked = await turn(handle, "Find berths for Ada and Bo", twoCalls(), { own: [tracker] });
			const own = asked.servers.at(-1)?.find(server => server.name === "tracker");
			expect(
				"the user's own server starts without a question about the server",
				asked.asked.length === 0 && own?.origin === "user" && own.state === "running",
				JSON.stringify(own),
			);
			expect(
				"with the setting off, each call of its tool is put to the user, and runs when allowed",
				asked.toolQuestions.length === 2 &&
					asked.unasked.length === 0 &&
					ran(asked) &&
					outcomeOf(asked) === "succeeded",
				`${asked.toolQuestions.length} question(s); ${answers(asked).join(", ")}; ${outputOf(asked, "o1")}`,
			);

			const unaskedRun = await turn(handle, "Find berths for Ada and Bo again", twoCalls(), {
				own: [quiet],
				windlassSessionId: asked.result.windlassSessionId ?? undefined,
			});
			expect(
				"with it on, nobody is asked and both calls run",
				unaskedRun.toolQuestions.length === 0 && ran(unaskedRun) && outcomeOf(unaskedRun) === "succeeded",
				`${unaskedRun.toolQuestions.length} question(s); ${outputOf(unaskedRun, "o1")} | ${outputOf(unaskedRun, "o2")}`,
			);
			expect(
				"Windlass asked all the same, and the layer answered each call once and said which call, server and tool it was",
				JSON.stringify(answers(unaskedRun)) === JSON.stringify(["o1:once", "o2:once"]) &&
					JSON.stringify(allowed(unaskedRun)) === JSON.stringify(["o1:tracker/berth", "o2:tracker/berth"]),
				`answered ${answers(unaskedRun).join(", ")}; told of ${allowed(unaskedRun).join(", ")}`,
			);
			const told = unaskedRun.events.findIndex(event => event.type === "approval.requested");
			expect(
				"each is told between Windlass's question and its answer, so a timeline can say who allowed the call",
				told >= 0 && unaskedRun.events.findIndex(event => event.type === "approval.answered") > told,
			);
			info(`the timeline's line under such a call: ${unaskedNote("tracker")}`);
			const tainted = unaskedRun.events
				.filter(event => event.type === "tool.settled")
				.map(event => (dataOf(event).display as { mcp?: { untrusted?: boolean } } | undefined)?.mcp?.untrusted);
			expect(
				"the setting does not make the server's output trusted: Windlass still marks its results as content it does not trust",
				tainted.length === 2 && tainted.every(untrusted => untrusted === true),
				JSON.stringify(tainted),
			);

			// An item's turn, in a session not yet tainted: the first call is answered for the user; its result taints the session part way
			// through the turn, and from then on the layer answers for nobody, so the second call is put to the item's question (here, allowed).
			const fresh = await sandbox(uid, "docker-windlass-sandbox", "mcp-own-taint");
			await fresh.writeTextFile("/workspace/.windlass/config.json", none);
			const item = await turn(fresh, "Find berths for Ada and Bo", twoCalls(), {
				own: [quiet],
				unaskedUntilTainted: true,
			});
			const taintAt = item.events.findIndex(event => event.type === "taint.noticed");
			expect(
				"an item's turn: once Windlass says the session is tainted, part way through the turn, the call after it is asked, not answered unasked",
				taintAt >= 0 &&
					JSON.stringify(allowed(item)) === JSON.stringify(["o1:tracker/berth"]) &&
					item.toolQuestions.length === 1 &&
					ran(item),
				`taint at ${taintAt}; answered ${answers(item).join(", ")}; unasked ${allowed(item).join(", ")}; ${item.toolQuestions.length} question(s)`,
			);
			const itemLater = await turn(fresh, "Find berths for Ada and Bo again", twoCalls(), {
				own: [quiet],
				unaskedUntilTainted: true,
				windlassSessionId: item.result.windlassSessionId ?? undefined,
			});
			expect(
				"and a later item turn of that session is told no new taint: the session hands its servers asked (agent-session.ts, meta.tainted), which this layer alone does not know",
				!itemLater.events.some(event => event.type === "taint.noticed") && itemLater.unasked.length === 2,
				`${itemLater.unasked.length} answered unasked`,
			);

			const off = await turn(handle, "Find berths for Ada and Bo once more", twoCalls(), {
				own: [tracker],
				windlassSessionId: asked.result.windlassSessionId ?? undefined,
			});
			expect(
				"switched off again, the next turn asks again: nothing was remembered in Windlass",
				off.toolQuestions.length === 2 && off.unasked.length === 0,
				`${off.toolQuestions.length} question(s)`,
			);
			const gone = await turn(
				handle,
				"Find a berth for Ada",
				scripted(
					call("o1", "mcp_call", { server: "tracker", tool: "berth", arguments: { ship: "Ada" } }),
					say("There is no such server."),
				),
				{ windlassSessionId: asked.result.windlassSessionId ?? undefined },
			);
			expect(
				"a server its user deleted is gone with the next turn: the layer answers for nothing, and nothing runs",
				gone.unasked.length === 0 &&
					mcpOutcome(gone, "o1") !== "result" &&
					!gone.servers.flat().some(server => server.name === "tracker"),
				`${gone.toolQuestions.length} question(s) put to the user; ${mcpOutcome(gone, "o1")}: ${outputOf(gone, "o1").slice(0, 160)}`,
			);

			// A repository that names a server "tracker" itself: that one is the project's, whatever the user's settings say of theirs.
			const project = await sandbox(uidOther, "docker-windlass-sandbox", "mcp-own-project");
			const names = (definition: Record<string, unknown>) =>
				project.writeTextFile(
					"/workspace/.windlass/config.json",
					`${JSON.stringify({ mcp: { servers: { tracker: definition } } }, null, 2)}\n`,
				);
			await names({ command: "python3", args: ["tools/harbor_mcp.py", "--berths", "12"] });
			const theirs = await turn(project, "Find berths for Ada and Bo", twoCalls(), {
				own: [quiet],
				server: () => true,
			});
			const named = theirs.servers.at(-1)?.find(server => server.name === "tracker");
			expect(
				"a server of the same name that the repository names is the project's: it is asked about before it starts",
				theirs.asked.length === 1 && theirs.asked[0]?.question.name === "tracker" && named?.origin === "project",
				`${theirs.asked.length} question(s) about the server; ${JSON.stringify(named)}`,
			);
			expect(
				"and the setting does not cover it: each call of its tool is put to the user",
				theirs.toolQuestions.length === 2 && theirs.unasked.length === 0 && ran(theirs),
				`${theirs.toolQuestions.length} question(s); told of ${allowed(theirs).join(", ") || "none"}`,
			);
			// Named by the repository exactly as the user defines it, Windlass starts it on the user's own word and still says it is the project's: not covered either.
			await names(tracker.definition);
			const same = await turn(project, "Find berths for Ada and Bo again", twoCalls(), {
				own: [quiet],
				server: () => true,
				windlassSessionId: theirs.result.windlassSessionId ?? undefined,
			});
			expect(
				"nor one the repository names with the user's own definition: its calls are put to the user too",
				same.servers.at(-1)?.find(server => server.name === "tracker")?.origin === "project" &&
					same.toolQuestions.length === 2 &&
					same.unasked.length === 0 &&
					ran(same),
				`${same.asked.length} question(s) about the server; ${same.toolQuestions.length} about its calls`,
			);

			// Where commands are not sandboxed Windlass runs the first call unasked and asks from the first result on: the setting answers there too.
			const hardened = await sandbox(uid, "docker-hardened", "mcp-own-hardened");
			await hardened.writeTextFile("/workspace/.windlass/config.json", none);
			const plainRun = await turn(hardened, "Find berths for Ada and Bo", twoCalls(), { own: [tracker] });
			expect(
				"docker-hardened, setting off: the first call runs unasked and the second, after the server's result, is put to the user",
				plainRun.toolQuestions.length === 1 && plainRun.toolQuestions[0]?.callId === "o2" && ran(plainRun),
				`${plainRun.toolQuestions.map(question => question.callId).join(", ")}`,
			);
			const quietRun = await turn(hardened, "Find berths for Ada and Bo again", twoCalls(), {
				own: [quiet],
				windlassSessionId: plainRun.result.windlassSessionId ?? undefined,
			});
			expect(
				"docker-hardened, setting on: nobody is asked, and the layer answered what Windlass asked",
				quietRun.toolQuestions.length === 0 &&
					quietRun.unasked.length >= 1 &&
					quietRun.unasked.length === answers(quietRun).length &&
					ran(quietRun),
				`told of ${allowed(quietRun).join(", ")}; answered ${answers(quietRun).join(", ")}`,
			);
		},
	);
}

async function main(): Promise<void> {
	info(`Windlass in ${IMAGE_USED}: ${(await layer.windlass.version()) ?? "unknown"}; run ${run}`);
	if (!process.argv.includes("--report")) await checkOtherServers();
	for (const profile of ["docker-windlass-sandbox", "docker-hardened"] as const)
		await section(`${profile}: the platform's own tools`, () => checkPlatformTools(profile));
	await section("a call the platform does not answer in time", () => checkUnanswered());
	await section("a sandbox without host tools", checkMissingHostTools);
	await section("cleanup", async () => {
		for (const id of created) await layer.sandboxes.destroy(id);
		for (const user of users) await docker(["volume", "rm", `wlp-user-${user}`], { check: true });
		const containers = await docker(["ps", "-a", "--filter", `label=${LABEL_ARG}`, "--format", "{{.Names}}"]);
		const volumes = await docker(["volume", "ls", "--filter", `label=${LABEL_ARG}`, "--format", "{{.Name}}"]);
		const mine = [...containers.stdout.split("\n"), ...volumes.stdout.split("\n")].filter(
			name => name.includes(run) || [...created].some(id => name === `wlp-session-${id}`),
		);
		expect(
			"nothing this run created is left",
			mine.length === 0,
			mine.join(", ") || "no containers or volumes of this run",
		);
	});

	if (tally.summary(true) > 0) process.exitCode = 1;
}

await main();
