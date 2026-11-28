import type {
	AuthResult,
	WindlassDelta,
	PendingQuestion,
	SessionSnapshot,
	SessionSummary,
	TimelineItem,
} from "@contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDelta, applyItem, fromSnapshot, toolBlocks, type PlatformBlock, type SessionView } from "../lib/timeline";
import { PlatformError, type ConnectionState, type SessionFeed } from "./client";
import { LIVE_TYPES } from "./feed";
import { PROFILES, profilesFor } from "../../../server/src/sandbox/profiles";
import { createMockClient, MOCK_E2B_PROFILES, MOCK_PROFILES, type MockClient } from "./mock";
import { opensFromPushed, situation } from "../components/PullRequest";
import { summarizeTool } from "../lib/toolSummary";

/** A feed that records what it is given and folds it, as the session screen does. */
function recorder() {
	const record = {
		snapshots: [] as SessionSnapshot[],
		items: [] as TimelineItem[],
		deltas: [] as WindlassDelta[],
		summaries: [] as SessionSummary[],
		questions: [] as Array<PendingQuestion | null>,
		/** The question as the screen would hold it: from the snapshot, then from the events. */
		question: null as PendingQuestion | null,
		connection: [] as ConnectionState[],
		errors: [] as PlatformError[],
		view: null as SessionView | null,
	};
	const feed: SessionFeed = {
		onSnapshot(snapshot) {
			record.snapshots.push(snapshot);
			record.view = fromSnapshot(snapshot);
			record.question = snapshot.question;
		},
		onItem(item) {
			record.items.push(item);
			if (record.view) record.view = applyItem(record.view, item);
		},
		onDelta(delta) {
			if (!("event" in delta)) throw new Error("The Windlass mock emitted an ACP delta.");
			record.deltas.push(delta);
			if (record.view) record.view = applyDelta(record.view, delta);
		},
		onSummary(summary) {
			record.summaries.push(summary);
		},
		onQuestion(question) {
			record.questions.push(question);
			record.question = question;
		},
		onConnection(state, error) {
			record.connection.push(state);
			if (error) record.errors.push(error);
		},
	};
	return { record, feed };
}

/** Lets `ms` of the mock's time pass, then gives the promise's value. */
async function after<T>(ms: number, promise: Promise<T>): Promise<T> {
	await vi.advanceTimersByTimeAsync(ms);
	return promise;
}

const strip = (view: SessionView | null) =>
	view && {
		...view,
		nextId: 0,
		turns: view.turns.map(turn => ({ ...turn, blocks: turn.blocks.map(block => ({ ...block, id: "", at: null })) })),
	};

let client: MockClient;
let auth: AuthResult;

beforeEach(async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
	client = createMockClient({ origin: "http://localhost:5173" });
	auth = await after(1000, client.login.demo());
});

afterEach(() => {
	client.dispose();
	vi.useRealTimers();
});

async function freshSession(profile: "docker-windlass-sandbox" | "docker-hardened" = "docker-windlass-sandbox") {
	const summary = await after(500, client.user(auth).createSession({ profile }));
	const api = client.session(auth, summary.id);
	const { record, feed } = recorder();
	const close = api.open(feed);
	await vi.advanceTimersByTimeAsync(500);
	return { summary, api, record, close };
}

describe("what the mock serves", () => {
	it("uses the recorded title for an unnamed session and keeps a typed title", async () => {
		const user = client.user(auth);
		for (const title of [undefined, "My notes"]) {
			const session = await after(
				500,
				user.createSession({
					title,
					harness: "claude",
					profile: "docker-hardened",
					place: { kind: "machine", machineId: "m_nas" },
				}),
			);
			await after(5000, client.session(auth, session.id).prompt({ text: "plain" }));
			const list = await after(500, user.listSessions());
			expect(list.find(s => s.id === session.id)?.title).toBe(title ?? "Inspect the files");
		}
	});

	it.each([
		["claude", "docker-hardened", "auto", ["default", "acceptEdits", "plan", "auto", "bypassPermissions"]],
		["windlass", "docker-windlass-sandbox", "auto", ["ask", "auto"]],
		["windlass", "docker-hardened", "full", ["ask", "full"]],
	] as const)("serves and changes %s modes on %s", async (harness, profile, mode, ids) => {
		const place = harness === "claude" ? { kind: "machine" as const, machineId: "m_nas" } : undefined;
		const summary = await after(500, client.user(auth).createSession({ harness, profile, place }));
		expect(summary.mode).toBe(mode);
		expect(summary.availableModes.map(m => m.id)).toEqual(ids);
		expect(summary.availableModes.every(m => m.name && m.description)).toBe(true);
		const api = client.session(auth, summary.id);
		expect((await after(500, api.setMode(ids[0]))).mode).toBe(ids[0]);
		const refused = expect(api.setMode("unavailable")).rejects.toMatchObject({ reason: "bad_input" });
		await after(500, refused);
	});

	it.each([
		["e2b", "auto", "full"],
		["e2b-open", "full", "auto"],
	] as const)("limits %s to its profile choices", async (profile, mode, refusedMode) => {
		client.dispose();
		client = createMockClient({ sandbox: "e2b" });
		const user = client.user(auth);
		const session = await after(500, user.createSession({ profile }));
		expect(session.mode).toBe(mode);
		expect(session.availableModes.map(m => m.id)).toEqual(["ask", mode]);
		await after(
			500,
			expect(user.createSession({ profile, mode: refusedMode })).rejects.toMatchObject({ reason: "bad_input" }),
		);
		expect((await after(500, user.createSession({ profile, mode: "ask" }))).mode).toBe("ask");
	});

	it.each([
		["docker", "docker-windlass-sandbox", "docker-hardened"],
		["e2b", "e2b", "e2b-open"],
	] as const)("lists only the Strict and Open profiles offered on %s", async (sandbox, strict, open) => {
		client.dispose();
		client = createMockClient({ sandbox });
		const info = await after(500, client.info());
		expect(info.demoEnabled).toBe(true);
		expect(info.profiles.map(profile => [profile.id, profile.name])).toEqual([
			[strict, "Strict"],
			[open, "Open"],
		]);
		expect(info.profiles.every(profile => profile.available && profile.unavailableReason === undefined)).toBe(true);
		// The models are each user's own: the deployment names none.
		expect(info).not.toHaveProperty("models");
		expect(info).not.toHaveProperty("efforts");
	});

	it("says of every profile what the server says, word for word", () => {
		expect(MOCK_PROFILES).toEqual(PROFILES);
		expect(MOCK_E2B_PROFILES).toEqual(profilesFor("e2b", { windlassSandbox: true, openProfile: true }));
		// No command reads the sign-in anywhere; the access token only where commands run outside Windlass's sandbox.
		expect(MOCK_PROFILES.filter(profile => profile.commandsCanReadAccessToken).map(profile => profile.id)).toEqual([
			"docker-hardened",
			"e2b-open",
			"daytona",
		]);
		expect(
			MOCK_PROFILES.every(
				profile => !/sign-in volume|does not do yet/.test(`${profile.summary} ${profile.unavailableReason ?? ""}`),
			),
		).toBe(true);
	});

	it("has sessions in different states, newest first, one of them at work", async () => {
		const listed = await after(500, client.user(auth).listSessions());
		expect(listed.map(session => session.createdAt)).toEqual(
			[...listed.map(session => session.createdAt)].sort((a, b) => b - a),
		);
		// The user's own agents: the work items' sessions are among them in the list, as the server's are (mock.items.test.ts).
		const sessions = listed.filter(session => !session.item);
		expect(sessions.length).toBeGreaterThanOrEqual(6);
		expect(sessions[0]).toMatchObject({ id: "harbor-build", turns: 1 });
		expect(sessions.find(session => session.id === "headers")).toMatchObject({ status: "waiting", turns: 1 });
		expect(["starting", "running"]).toContain(sessions[0]?.status);
		expect(new Set(sessions.map(session => session.lastOutcome))).toEqual(
			new Set(["succeeded", "failed", "interrupted", "error", null]),
		);
		expect(new Set(sessions.map(session => session.sandbox))).toEqual(new Set(["none", "running", "paused"]));
	});

	it("pushes the list to whoever watches it", async () => {
		const lists: SessionSummary[][] = [];
		const close = client.user(auth).watch({ onSessions: sessions => lists.push(sessions) });
		await vi.advanceTimersByTimeAsync(300);
		expect(lists).toHaveLength(1);
		const created = await after(500, client.user(auth).createSession({ profile: "docker-hardened", title: "Mine" }));
		expect(lists.at(-1)?.[0]).toMatchObject({ id: created.id, title: "Mine", status: "idle", sandbox: "none" });
		await after(500, client.user(auth).renameSession(created.id, "Renamed"));
		expect(lists.at(-1)?.[0]?.title).toBe("Renamed");
		await after(500, client.user(auth).deleteSession(created.id));
		expect(lists.at(-1)?.some(session => session.id === created.id)).toBe(false);
		close();
	});

	it("refuses a sandbox that is not available, and says why", async () => {
		const attempt = client.user(auth).createSession({ profile: "e2b" });
		const failure = after(
			500,
			attempt.catch((error: unknown) => error),
		);
		expect(await failure).toMatchObject({ code: "user", message: expect.stringContaining("isn't available here") });
	});
});

describe("signing in", () => {
	it("finishes only from an address under the redirect prefix, with a code and the attempt's state", async () => {
		const started = await after(1000, client.login.start());
		expect(new URL(started.redirectPrefix).pathname).toBe("/signin");
		expect(started.expiresAt).toBeGreaterThan(Date.now());
		const state = new URL(started.url).searchParams.get("state");

		const fail = async (pasted: string) =>
			after(
				1000,
				client.login.finish(pasted).catch((error: unknown) => error),
			);
		expect(await fail("https://example.com/?code=1")).toMatchObject({
			code: "user",
			message: expect.stringContaining("not the address"),
		});
		expect(await fail(`${started.redirectPrefix}?state=${state}`)).toMatchObject({
			code: "user",
			message: expect.stringContaining("no sign-in code"),
		});
		expect(await fail(`${started.redirectPrefix}?error=access_denied&state=${state}`)).toMatchObject({
			message: expect.stringContaining("access_denied"),
		});

		const result = await after(1000, client.login.finish(`${started.redirectPrefix}?code=abc&state=${state}`));
		expect(result.profile).toEqual({ uid: "u_ada", email: "ada@example.com", demo: false });
		const user = client.user(result);
		expect(await after(500, user.chatgpt())).toMatchObject({ connected: false });
		// Approving the connect command's code connects the ChatGPT plan a few seconds later.
		await after(500, user.approvePlanConnect("KQ2M-8XF4", "openai"));
		expect(await after(500, user.chatgpt())).toMatchObject({ connected: false });
		await vi.advanceTimersByTimeAsync(3000);
		expect(await after(500, user.chatgpt())).toMatchObject({ connected: true });
		await user.forgetChatgpt();
		expect(await after(500, user.me())).toEqual(result.profile);
	});

	it("rejects an attempt that has expired", async () => {
		const started = await after(1000, client.login.start());
		const state = new URL(started.url).searchParams.get("state");
		vi.setSystemTime(started.expiresAt + 1000);
		const failure = await after(
			1000,
			client.login.finish(`${started.redirectPrefix}?code=abc&state=${state}`).catch((error: unknown) => error),
		);
		expect(failure).toMatchObject({ code: "user", message: expect.stringContaining("expired") });
	});

	it("rejects a token it did not issue", async () => {
		const states: Array<[ConnectionState, string | undefined]> = [];
		client
			.user({ token: "not-a-mock-token", profile: auth.profile })
			.watch({ onSessions: () => undefined, onConnection: (state, error) => states.push([state, error?.code]) });
		const refused = expect(client.user({ token: "x", profile: auth.profile }).listSessions()).rejects.toMatchObject({
			code: "unauthorized",
		});
		await vi.advanceTimersByTimeAsync(500);
		await refused;
		expect(states).toEqual([
			["connecting", undefined],
			["failed", "unauthorized"],
		]);
	});
});

describe("a turn played from a recording", () => {
	it("stores durable events, broadcasts streaming ones, and ends where a snapshot would", async () => {
		const { api, record } = await freshSession();
		expect(record.connection).toEqual(["connecting", "connected"]);
		expect(record.snapshots[0]).toMatchObject({ timeline: [], pending: [], windlassSessionId: null, question: null });

		// The first unrecognised prompt plays "find and fix a failing test".
		const accepted = await after(
			400,
			api.prompt({ text: "The add test is failing. Find out why and fix it.", effort: "low" }),
		);
		expect(accepted).toEqual({ turn: 1, steered: false });
		await vi.advanceTimersByTimeAsync(30_000);

		// Stored and streamed, as contract.ts splits them.
		expect(record.items.map(item => item.seq)).toEqual(record.items.map((_, index) => index + 1));
		const stored = record.items.flatMap(item => (item.kind === "windlass" ? [item.event.type] : []));
		expect(stored.some(type => LIVE_TYPES.has(type))).toBe(false);
		expect(stored).toEqual(
			expect.arrayContaining([
				"session.created",
				"baseline.set",
				"step.started",
				"tool.called",
				"tool.settled",
				"text.ended",
				"cli.summary",
			]),
		);
		expect(new Set(record.deltas.map(delta => delta.event.type))).toEqual(LIVE_TYPES);
		expect(record.deltas.every(delta => delta.turn === 1 && delta.event.seq === undefined)).toBe(true);

		// The platform's own entries around Windlass's.
		expect(record.items[0]).toMatchObject({
			kind: "user",
			text: "The add test is failing. Find out why and fix it.",
			effort: "low",
			turn: 1,
		});
		expect(record.items[1]).toMatchObject({ kind: "platform", text: "Starting a hosted sandbox (Strict)" });
		expect(record.items.at(-1)).toMatchObject({ kind: "turn.ended", outcome: "succeeded", steps: 5, exitCode: 0 });

		// The session's summary went through its states.
		expect(
			record.summaries.map(summary => summary.status).filter((status, index, all) => status !== all[index - 1]),
		).toEqual(["starting", "running", "idle"]);
		expect(record.summaries.at(-1)).toMatchObject({
			turns: 1,
			lastOutcome: "succeeded",
			sandbox: "running",
			title: "The add test is failing. Find out why and fix it.",
		});

		// What was streamed live folds to the same view as a snapshot taken afterwards.
		const late = recorder();
		api.open(late.feed);
		await vi.advanceTimersByTimeAsync(500);
		expect(late.record.snapshots[0]?.pending).toEqual([]);
		expect(late.record.snapshots[0]?.timeline).toEqual(record.items);
		expect(late.record.snapshots[0]?.windlassSessionId).toMatch(/^ses_[0-9a-f]{24}$/);
		expect(strip(late.record.view)).toEqual(strip(record.view));

		// And the workspace has the change.
		expect(await after(500, api.changes())).toEqual([{ path: "src/add.ts", status: " M" }]);
		expect(await after(500, api.diff())).toContain("+  return a + b");
	});

	it("gives a client that joins mid-turn the text streamed so far", async () => {
		const { api, record } = await freshSession();
		await after(400, api.prompt({ text: "Run the full build and tell me if it passes." }));
		// Into the first answer, before its `text.ended`.
		while (!record.deltas.some(delta => delta.event.type === "text.delta")) await vi.advanceTimersByTimeAsync(20);
		await vi.advanceTimersByTimeAsync(30);

		const late = recorder();
		api.open(late.feed);
		await vi.advanceTimersByTimeAsync(170);
		const snapshot = late.record.snapshots[0];
		expect(snapshot?.summary.status).toBe("running");
		expect(snapshot?.pending.length).toBeGreaterThan(0);
		expect(snapshot?.pending.every(delta => "event" in delta && LIVE_TYPES.has(delta.event.type))).toBe(true);
		const joined = late.record.view?.turns[0]?.blocks.find(block => block.kind === "text");
		expect(joined).toMatchObject({ streaming: true });
		expect("Running the build and the test suite.".startsWith(joined?.kind === "text" ? joined.text : "?")).toBe(true);

		await vi.advanceTimersByTimeAsync(30_000);
		expect(strip(late.record.view)).toEqual(strip(record.view));
		expect(record.view?.turns[0]?.end?.outcome).toBe("succeeded");
	});

	it("refuses a message while the sandbox is starting, as steer_unavailable", async () => {
		const { api } = await freshSession();
		await after(200, api.prompt({ text: "Run the full build." }));
		const failure = await after(
			200,
			api.prompt({ text: "And another thing" }).catch((error: unknown) => error),
		);
		expect(failure).toBeInstanceOf(PlatformError);
		expect(failure).toMatchObject({ code: "user", reason: "steer_unavailable" });
		expect(
			await after(
				400,
				api.prompt({ text: "   " }).catch((error: unknown) => error),
			),
		).toMatchObject({ code: "user" });
	});
});

describe("stopping a turn", () => {
	it("winds it down mid-tool as Windlass does", async () => {
		const { api, record } = await freshSession();
		await after(400, api.prompt({ text: "Run the full build and the tests." }));
		while (!record.deltas.some(delta => delta.event.type === "tool.progress")) await vi.advanceTimersByTimeAsync(50);
		expect(toolBlocks(record.view?.turns[0] as never)[0]?.state).toBe("running");

		await after(200, api.stop());
		expect(record.summaries.at(-1)?.status).toBe("stopping");
		await vi.advanceTimersByTimeAsync(5000);

		const types = record.items.flatMap(item => (item.kind === "windlass" ? [item.event.type] : [item.kind]));
		const tail = types.slice(types.indexOf("execution.interrupt_requested"));
		expect(tail).toEqual([
			"execution.interrupt_requested",
			"tool.settled",
			"step.failed",
			"synthetic.appended",
			"execution.interrupted",
			"cli.summary",
			"turn.ended",
		]);
		expect(record.items.at(-1)).toMatchObject({ kind: "turn.ended", outcome: "interrupted", steps: 1 });
		expect(record.summaries.at(-1)).toMatchObject({ status: "idle", lastOutcome: "interrupted" });

		const [call] = toolBlocks(record.view?.turns[0] as never);
		expect(call).toMatchObject({ state: "failed", interrupted: true });
		expect(call?.output).toMatch(/^Stopped by the user after \d+ s\. Output so far:\n\$ tsc/);
		// Nothing more arrives from the recording once it is stopped.
		const count = record.items.length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(record.items).toHaveLength(count);
	});

	it("keeps the visible part of an answer that was being written", async () => {
		const { api, record } = await freshSession();
		await after(400, api.prompt({ text: "Run the full build and the tests." }));
		while (!record.deltas.some(delta => delta.event.type === "text.delta")) await vi.advanceTimersByTimeAsync(20);
		await after(200, api.stop());
		await vi.advanceTimersByTimeAsync(5000);
		const text = record.view?.turns[0]?.blocks.find(block => block.kind === "text");
		expect(text).toMatchObject({ streaming: false });
		expect(text?.kind === "text" && text.text.length).toBeGreaterThan(0);
		expect(record.view?.turns[0]?.end?.outcome).toBe("interrupted");
	});

	it("can stop before Windlass has started", async () => {
		const { api, record } = await freshSession();
		await after(200, api.prompt({ text: "Anything" }));
		await after(100, api.stop());
		await vi.advanceTimersByTimeAsync(2000);
		expect(record.items.at(-1)).toMatchObject({ kind: "turn.ended", outcome: "interrupted", steps: null, usage: null });
		expect(record.items.some(item => item.kind === "windlass")).toBe(false);
	});
});

describe("turns that do not go well", () => {
	it("ends in a provider error the user can read", async () => {
		const { api, record } = await freshSession();
		await after(400, api.prompt({ text: "Use up the usage limit." }));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(record.items.at(-1)).toMatchObject({ kind: "turn.ended", outcome: "failed" });
		expect(record.view?.turns[0]?.blocks.filter(block => block.kind === "error")).toEqual([
			expect.objectContaining({ message: "Usage limit reached; it resets in 3 hours." }),
		]);
	});

	it("ends in a platform error when the sandbox fails", async () => {
		const { api, record } = await freshSession();
		await after(400, api.prompt({ text: "crash the sandbox" }));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(record.items.at(-1)).toMatchObject({
			kind: "turn.ended",
			outcome: "error",
			exitCode: null,
			message: expect.stringContaining("stopped responding"),
		});
		expect(record.items.filter(item => item.kind === "platform").at(-1)).toMatchObject({ level: "error" });
	});

	it("plays a call that is refused", async () => {
		const { api, record } = await freshSession("docker-windlass-sandbox");
		await after(400, api.prompt({ text: "Run it with nobody to approve it." }));
		await vi.advanceTimersByTimeAsync(20_000);
		const [call] = toolBlocks(record.view?.turns[0] as never);
		expect(call).toMatchObject({ state: "refused", refusal: { reason: "unattended" } });
		expect(record.view?.turns[0]?.blocks.some(block => block.kind === "notice")).toBe(true);
		expect(record.items.at(-1)).toMatchObject({ kind: "turn.ended", outcome: "succeeded" });
	});
});

describe("a dropped connection", () => {
	it("reports reconnecting, then hands over a fresh snapshot", async () => {
		const { record } = await freshSession();
		client.simulateDrop(1000);
		expect(record.connection.at(-1)).toBe("reconnecting");
		await vi.advanceTimersByTimeAsync(1100);
		expect(record.connection.at(-1)).toBe("connected");
		expect(record.snapshots).toHaveLength(2);
	});

	it("reports a session that does not exist", async () => {
		const { record, feed } = recorder();
		client.session(auth, "nope").open(feed);
		await vi.advanceTimersByTimeAsync(500);
		expect(record.connection).toEqual(["connecting", "failed"]);
		expect(record.errors[0]?.code).toBe("not_found");
	});
});

// ---------------------------------------------------------------------------------------------
// Interactive turns
// ---------------------------------------------------------------------------------------------

/** Plays a network prompt up to its question. */
async function untilAsked(text = "Fetch the response headers of example.com") {
	const session = await freshSession();
	await after(400, session.api.prompt({ text }));
	while (session.record.question === null) await vi.advanceTimersByTimeAsync(50);
	return session;
}

const toolOf = (view: SessionView | null, turnNumber = 1) =>
	toolBlocks(view?.turns.find(one => one.turn === turnNumber) as never);

describe("a question", () => {
	it("stops the turn at the question and says so", async () => {
		const { record } = await untilAsked();
		const question = record.question as PendingQuestion;
		expect(question).toMatchObject({
			turn: 1,
			callId: "c1",
			title: "Allow network access for this command?",
			subject: "curl -sI --max-time 10 https://example.com | head -n 3",
			subagent: null,
		});
		expect(question.details).toEqual(["With network access the command can send anything it can read to any host."]);
		expect(question.choices.map(choice => [choice.id, choice.approve])).toEqual([
			["once", true],
			["session", true],
			["deny", false],
		]);
		expect(question.expiresAt - question.askedAt).toBe(3 * 60_000);
		expect(record.summaries.at(-1)?.status).toBe("waiting");
		expect(toolOf(record.view)[0]).toMatchObject({ state: "asking", question: { title: question.title } });
		// Nothing more happens while it waits.
		const count = record.items.length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(record.items).toHaveLength(count);
	});

	it("carries on with the approved recording when allowed for the session", async () => {
		const { api, record } = await untilAsked();
		await after(400, api.answer({ questionId: (record.question as PendingQuestion).id, choice: "session" }));
		expect(record.question).toBeNull();
		await vi.advanceTimersByTimeAsync(20_000);
		const [call, slow] = toolOf(record.view);
		expect(call).toMatchObject({
			state: "done",
			answer: {
				choice: "session",
				approve: true,
				by: "user",
				remembers: "network for sandboxed commands, for the rest of this session",
			},
		});
		expect(slow).toMatchObject({ state: "done" });
		expect(
			record.view?.turns[0]?.blocks
				.filter(block => block.kind === "notice")
				.map(block => block.kind === "notice" && block.noticeKind),
		).toEqual(["taint"]);
		expect(record.items.at(-1)).toMatchObject({ kind: "turn.ended", outcome: "succeeded", steps: 3 });
		expect(record.summaries.at(-1)?.status).toBe("idle");
	});

	it("carries on with the declined recording, with the note", async () => {
		const { api, record } = await untilAsked();
		await after(
			400,
			api.answer({
				questionId: (record.question as PendingQuestion).id,
				choice: "deny",
				note: "  use the cached copy  ",
			}),
		);
		await vi.advanceTimersByTimeAsync(20_000);
		const [call] = toolOf(record.view);
		expect(call).toMatchObject({
			state: "refused",
			answer: { choice: "deny", approve: false, note: "use the cached copy", by: "user" },
			output: "Not run: the user declined this call. Their note: use the cached copy",
		});
		expect(record.items.at(-1)).toMatchObject({ kind: "turn.ended", outcome: "succeeded" });
	});

	it("is declined by the platform when nobody answers", async () => {
		const { record } = await untilAsked();
		await vi.advanceTimersByTimeAsync(3 * 60_000 + 20_000);
		expect(record.questions.at(-1)).toBeNull();
		const [call] = toolOf(record.view);
		expect(call).toMatchObject({
			state: "refused",
			answer: {
				choice: "deny",
				by: "platform",
				platformText: "Nobody answered within 3 minutes, so the platform declined the call.",
			},
		});
		// The platform's line is told once, with the call, not as a line of its own.
		expect(
			record.view?.turns[0]?.blocks.some(block => block.kind === "platform" && block.text.startsWith("Nobody")),
		).toBe(false);
		expect(record.items.at(-1)).toMatchObject({ kind: "turn.ended" });
	});

	it("refuses an answer to a question that is gone, with no_question", async () => {
		const { api, record } = await untilAsked();
		const id = (record.question as PendingQuestion).id;
		await after(400, api.answer({ questionId: id, choice: "once" }));
		const failure = await after(
			400,
			api.answer({ questionId: id, choice: "once" }).catch((error: unknown) => error),
		);
		expect(failure).toMatchObject({ code: "user", reason: "no_question" });
	});

	it("can be made to fail as if answered in another tab", async () => {
		const { api, record } = await untilAsked();
		client.mockNextAnswer("elsewhere");
		const failure = await after(
			400,
			api
				.answer({ questionId: (record.question as PendingQuestion).id, choice: "deny" })
				.catch((error: unknown) => error),
		);
		expect(failure).toMatchObject({ reason: "no_question", message: expect.stringContaining("another tab") });
		expect(record.question).toBeNull();
	});

	it("is withdrawn when the turn is stopped", async () => {
		const { api, record } = await untilAsked();
		await after(200, api.stop());
		expect(record.question).toBeNull();
		await vi.advanceTimersByTimeAsync(5000);
		expect(toolOf(record.view)[0]).toMatchObject({ state: "refused", outcome: "not_started" });
		expect(record.items.at(-1)).toMatchObject({ kind: "turn.ended", outcome: "interrupted" });
	});

	it("is in the snapshot of a client that joins while it waits, and gone from one after", async () => {
		const { api, record } = await untilAsked();
		const late = recorder();
		api.open(late.feed);
		await vi.advanceTimersByTimeAsync(300);
		expect(late.record.snapshots[0]?.question).toEqual(record.question);
		expect(toolOf(late.record.view)[0]).toMatchObject({ state: "asking" });
		await after(400, api.answer({ questionId: (record.question as PendingQuestion).id, choice: "once" }));
		client.simulateDrop(500);
		await vi.advanceTimersByTimeAsync(700);
		expect(late.record.snapshots.at(-1)?.question).toBeNull();
	});

	it("says which task asked, for a subagent", async () => {
		const { record } = await untilAsked("Have a subagent fetch the headers");
		expect(record.question?.subagent).toBe("Check what the API's health endpoint returns");
	});

	it("is waiting in the seeded session when the app loads", async () => {
		const { record, feed } = recorder();
		client.session(auth, "headers").open(feed);
		await vi.advanceTimersByTimeAsync(300);
		expect(record.snapshots[0]?.summary.status).toBe("waiting");
		expect(record.question).toMatchObject({ turn: 2, title: "Allow network access for this command?" });
		expect(toolOf(record.view, 2)[0]).toMatchObject({ state: "asking" });
	});
});

describe("steering", () => {
	it("adds the message to the running turn, and delivers it at the next step", async () => {
		const { api, record } = await untilAsked();
		const result = await after(400, api.prompt({ text: "Also, keep it short.", model: "gpt-6-luna" }));
		expect(result).toEqual({ turn: 1, steered: true });
		const steer = record.items.find(item => item.kind === "user" && item.steer === true);
		expect(steer).toMatchObject({ turn: 1, text: "Also, keep it short.", model: "gpt-6.1-sol" });
		const enqueued = record.items.find(
			item =>
				item.kind === "windlass" &&
				item.event.type === "inbox.enqueued" &&
				item.event.data?.delivery === "steer" &&
				item.seq > (steer?.seq ?? 0),
		);
		expect(enqueued).toBeDefined();
		await after(400, api.answer({ questionId: (record.question as PendingQuestion).id, choice: "once" }));
		await vi.advanceTimersByTimeAsync(20_000);
		const types = record.items.flatMap(item => (item.kind === "windlass" ? [item.event.type] : []));
		expect(types.indexOf("inbox.delivered", types.indexOf("approval.answered"))).toBeLessThan(
			types.indexOf("step.started", types.indexOf("approval.answered") + 1) + 1,
		);
		expect(
			record.view?.turns[0]?.blocks
				.filter(block => block.kind === "user")
				.map(block => block.kind === "user" && block.steer),
		).toEqual([false, true]);
	});
});

describe("a submission's key", () => {
	it("takes a prompt once: the same key again is answered as before, while the turn runs and after it ended", async () => {
		const { api, record } = await freshSession();
		const first = await after(400, api.prompt({ text: "Explore the workspace", idempotencyKey: "one" }));
		await vi.advanceTimersByTimeAsync(4000);
		const whileRunning = await after(400, api.prompt({ text: "Explore the workspace", idempotencyKey: "one" }));
		await vi.advanceTimersByTimeAsync(60_000);
		const afterwards = await after(400, api.prompt({ text: "Explore the workspace", idempotencyKey: "one" }));
		expect([whileRunning, afterwards]).toEqual([first, first]);
		expect(first).toEqual({ turn: 1, steered: false });
		expect(record.items.filter(item => item.kind === "user")).toHaveLength(1);
		expect(record.summaries.at(-1)).toMatchObject({ turns: 1, status: "idle" });
		// Without a key, as before: the same words again are a new turn.
		expect(await after(400, api.prompt({ text: "Explore the workspace" }))).toEqual({ turn: 2, steered: false });
	});

	it("refuses a key that comes with another message, and a key that is none", async () => {
		const { api } = await freshSession();
		await after(400, api.prompt({ text: "Explore the workspace", idempotencyKey: "one" }));
		const reused = await after(
			400,
			api.prompt({ text: "Something else", idempotencyKey: "one" }).catch((error: unknown) => error),
		);
		expect(reused).toMatchObject({ reason: "idempotency_key_reused" });
		for (const bad of ["", "k".repeat(256), 7]) {
			const refused = await after(
				400,
				api.prompt({ text: "Explore the workspace", idempotencyKey: bad as string }).catch((error: unknown) => error),
			);
			expect(refused).toMatchObject({ reason: "bad_idempotency_key" });
		}
	});

	it("keeps a turn's effort for the next prompt that names none, and forgets it for one that asks for the default", async () => {
		const { api, record } = await freshSession();
		const userEfforts = () => record.items.flatMap(item => (item.kind === "user" ? [item.effort] : []));
		for (const effort of ["low", undefined, null]) {
			await after(400, api.prompt({ text: "Explore the workspace", effort }));
			await vi.advanceTimersByTimeAsync(30_000);
		}
		expect(userEfforts()).toEqual(["low", "low", null]);
		expect(record.summaries.at(-1)?.effort).toBeNull();
	});

	it("leaves the key of a prompt that was refused unused", async () => {
		const { api } = await freshSession();
		const refused = await after(
			400,
			api.prompt({ text: "hello", effort: "nope", idempotencyKey: "again" }).catch((error: unknown) => error),
		);
		expect(refused).toMatchObject({ reason: "bad_effort" });
		expect(await after(400, api.prompt({ text: "hello", idempotencyKey: "again" }))).toEqual({
			turn: 1,
			steered: false,
		});
	});

	it("makes one agent for one key, and a new one once that agent is deleted", async () => {
		const user = client.user(auth);
		const before = (await after(300, user.listSessions())).length;
		const first = await after(
			500,
			user.createSession({ profile: "docker-windlass-sandbox", title: "Once", idempotencyKey: "launch" }),
		);
		const again = await after(
			500,
			user.createSession({ profile: "docker-windlass-sandbox", title: "Once", idempotencyKey: "launch" }),
		);
		expect(again.id).toBe(first.id);
		expect((await after(300, user.listSessions())).length).toBe(before + 1);
		const other = await after(
			500,
			user
				.createSession({ profile: "docker-hardened", title: "Once", idempotencyKey: "launch" })
				.catch((error: unknown) => error),
		);
		expect(other).toMatchObject({ reason: "idempotency_key_reused" });
		await after(500, user.deleteSession(first.id));
		const anew = await after(
			500,
			user.createSession({ profile: "docker-windlass-sandbox", title: "Once", idempotencyKey: "launch" }),
		);
		expect(anew.id).not.toBe(first.id);
	});
});

describe("stopping one call", () => {
	it("stops the call and lets the turn go on", async () => {
		const { api, record } = await freshSession();
		await after(400, api.prompt({ text: "Run the full build and the tests." }));
		while (!record.deltas.some(delta => delta.event.type === "tool.progress")) await vi.advanceTimersByTimeAsync(50);
		const [running] = toolOf(record.view);
		const result = await after(
			200,
			api.stopCall({ messageId: running?.messageId ?? "", callId: running?.callId ?? "" }),
		);
		expect(result).toEqual({ stopped: true, message: null });
		expect(toolOf(record.view)[0]).toMatchObject({ state: "running", stopRequested: true });
		const again = await after(
			200,
			api.stopCall({ messageId: running?.messageId ?? "", callId: running?.callId ?? "" }),
		);
		expect(again.stopped).toBe(false);
		await vi.advanceTimersByTimeAsync(20_000);
		const [stopped] = toolOf(record.view);
		expect(stopped).toMatchObject({ state: "failed", stoppedByUser: true, interrupted: true, stopRequested: false });
		expect(stopped?.output).toMatch(/\[Stopped by the user after \d+ s\]$/);
		expect(record.items.filter(item => item.kind === "windlass" && item.event.type === "tool.settled")).toHaveLength(1);
		expect(record.items.at(-1)).toMatchObject({ kind: "turn.ended", outcome: "succeeded" });
	});

	it("says why when the call is not running", async () => {
		const { api } = await freshSession();
		expect(
			await after(
				300,
				api.stopCall({ messageId: "a1", callId: "c1" }).catch((error: unknown) => error),
			),
		).toMatchObject({ code: "user", message: "No turn is running." });
	});
});

describe("the agent's own push", () => {
	const ada: AuthResult = {
		token: "mock:user:u_ada:ada@example.com",
		profile: { uid: "u_ada", email: "ada@example.com", demo: false },
	};
	/** The seeded session's timeline as the session screen folds it, and its platform lines. */
	async function opened(mock: MockClient, id: string) {
		const { record, feed } = recorder();
		const close = mock.session(ada, id).open(feed);
		await vi.advanceTimersByTimeAsync(500);
		close();
		const lines = (record.view?.turns ?? []).flatMap(turn =>
			turn.blocks
				.filter((block): block is PlatformBlock => block.kind === "platform")
				.map(block => `${block.level}: ${block.text}`),
		);
		return { view: record.view, lines };
	}

	it("has a session whose agent pushed with no pull request open, and opens one from what is pushed", async () => {
		const mock = createMockClient({ origin: "http://localhost:5173" });
		const session = mock.session(ada, "agent-pushed");
		const state = await after(500, session.publishState());
		expect(state).toMatchObject({
			pullRequest: null,
			changes: false,
			blocked: null,
			branch: "windlass/fix-add-and-push-the-branch-pushed",
		});
		expect(state.pushed).toMatch(/^[0-9a-f]{40}$/);
		const short = (state.pushed ?? "").slice(0, 7);

		// The panel says the branch is pushed, not that there is nothing to push, and its button opens the pull request.
		const nothing = state.changes === false;
		expect(
			situation({ pull: state.pullRequest, branch: state.branch, pushed: state.pushed, nothing, unknown: false }),
		).toBe(`windlass/fix-add-and-push-the-branch-pushed is pushed at ${short}; no pull request is open.`);
		expect(situation({ pull: null, branch: state.branch, pushed: null, nothing: true, unknown: false })).toBe(
			"Nothing to push yet: no file differs from the last commit.",
		);
		expect(opensFromPushed(state.pullRequest, state.pushed, nothing)).toBe(true);
		expect(opensFromPushed(state.pullRequest, null, nothing)).toBe(false);

		// The timeline: the base fetched, then the agent's push, each in the server's words, and the calls read plainly.
		const { view, lines } = await opened(mock, "agent-pushed");
		expect(lines.slice(-2)).toEqual([
			`info: Fetched main from GitHub into the workspace as origin/main, as the agent asked.`,
			`info: The agent pushed its work to windlass/fix-add-and-push-the-branch-pushed (${short}).`,
		]);
		const calls = toolOf(view).filter(block => block.name === "fetch_base" || block.name === "push");
		expect(calls.map(block => summarizeTool(block))).toEqual([
			{ target: "main", facts: ["as origin/main"], exitCode: null },
			{ target: "windlass/fix-add-and-push-the-branch-pushed", facts: [short], exitCode: null },
		]);
		expect(calls[1]?.output).toBe(
			`Pushed to windlass/fix-add-and-push-the-branch-pushed (${short}). The platform's commit holds 1 file. No pull request was opened.`,
		);

		const result = await after(2000, session.publish({ title: "Make add() add", body: "" }));
		expect(result.opened).toBe(true);
		expect(result.state).toMatchObject({
			pushed: state.pushed,
			changes: false,
			pullRequest: { state: "open", branch: state.branch, base: "main", title: "Make add() add" },
		});
		const reopened = await opened(mock, "agent-pushed");
		expect(reopened.lines.at(-1)).toBe(
			`info: Opened pull request #${result.state.pullRequest?.number} in acme/signal-flags from windlass/fix-add-and-push-the-branch-pushed, with the agent's commits. Its description reports: nothing verified.`,
		);
		// Once it is open, nothing new is refused as before.
		expect(
			await after(
				2000,
				session.publish({ title: "Again", body: "" }).catch((error: unknown) => error),
			),
		).toMatchObject({
			message:
				"There is nothing to push: windlass/fix-add-and-push-the-branch-pushed at GitHub already has everything in the workspace.",
		});
		mock.dispose();
	});

	it("says when the workspace changed after the push", async () => {
		const mock = createMockClient({ origin: "http://localhost:5173" });
		const state = await after(500, mock.session(ada, "agent-pushed-more").publishState());
		expect(state).toMatchObject({ pullRequest: null, changes: true });
		expect(state.pushed).toMatch(/^[0-9a-f]{40}$/);
		expect(situation({ pull: null, branch: state.branch, pushed: state.pushed, nothing: false, unknown: false })).toBe(
			`${state.branch} is pushed at ${(state.pushed ?? "").slice(0, 7)}; no pull request is open. The workspace has changes that are not on the branch.`,
		);
		expect(opensFromPushed(null, state.pushed, false)).toBe(false);
		mock.dispose();
	});

	it("has a session whose push to main was refused: nothing pushed, the change still in the workspace", async () => {
		const mock = createMockClient({ origin: "http://localhost:5173" });
		const state = await after(500, mock.session(ada, "push-refused").publishState());
		expect(state).toMatchObject({ pullRequest: null, changes: true, pushed: null });
		const { view, lines } = await opened(mock, "push-refused");
		expect(lines.at(-1)).toBe(
			`warn: The agent asked to push to "main", which is not this session's branch (${state.branch}), so nothing was pushed.`,
		);
		const [push] = toolOf(view).filter(block => block.name === "push");
		expect(push && summarizeTool(push)).toEqual({ target: "main", facts: ["not pushed"], exitCode: null });
		expect(push?.output).toBe(
			`Not pushed. This session's work can only go to the session's own branch, ${state.branch}; a request that names another branch is refused. Call the tool again without a branch.`,
		);
		mock.dispose();
	});

	it("pushes when a prompt asks it to, only on a repository of the GitHub connection", async () => {
		const mock = createMockClient({ origin: "http://localhost:5173" });
		const user = mock.user(ada);
		const onRepo = await after(
			500,
			user.createSession({ profile: "docker-windlass-sandbox", repository: { id: 7106, branch: "main" } }),
		);
		await after(500, mock.session(ada, onRepo.id).prompt({ text: "Fix the add test and push." }));
		await vi.advanceTimersByTimeAsync(60_000);
		expect((await after(500, mock.session(ada, onRepo.id).publishState())).pushed).toMatch(/^[0-9a-f]{40}$/);

		const plain = await after(500, user.createSession({ profile: "docker-windlass-sandbox" }));
		const { record, feed } = recorder();
		mock.session(ada, plain.id).open(feed);
		await after(500, mock.session(ada, plain.id).prompt({ text: "Fix the add test and push." }));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(toolOf(record.view).map(block => block.name)).not.toContain("push");
		expect(record.items.at(-1)).toMatchObject({ kind: "turn.ended", outcome: "succeeded" });
		mock.dispose();
	});
});
