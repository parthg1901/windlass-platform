// @vitest-environment jsdom
/**
 * The user's remembered approvals of projects' MCP servers: the record itself and what a session
 * folds of Windlass's words (server/src/server-approvals.ts), what the mock plays of them, and the
 * side panel's section.
 */
import type {
	AuthResult,
	PendingQuestion,
	SessionServer,
	SessionServers,
	SessionSummary,
	TimelineItem,
} from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnServer } from "../../../server/src/sandbox/api";
import {
	APPROVAL_TTL_MS,
	ApprovalBook,
	MAX_APPROVALS,
	approvalFor,
	knownServers,
	projectOf,
	sameServers,
	serversView,
	sessionProjectKey,
} from "../../../server/src/server-approvals";
import type { SessionFeed } from "../api/client";
import { createMockClient, MOCK_FORGETTING, type MockClient } from "../api/mock";
import { saveAuth } from "../lib/authStore";
import { AppProvider } from "../state/app";
import { ServersSection, serverState } from "./Servers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-16T12:00:00Z");
const PRINT = "81498df752b8ef7d";

// ---------------------------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------------------------

describe("the user's record of approvals", () => {
	const harbor = { project: "github:7101", label: "acme/harbor", name: "harbor", fingerprint: PRINT };

	it("names a project by the GitHub repository's id, by the pasted address, or by the session", () => {
		const github = projectOf({
			sessionId: "s_1",
			repoUrl: "https://github.com/acme/harbor.git",
			repo: { id: 7101, owner: "acme", name: "harbor" },
		});
		expect(github).toEqual({ key: "github:7101", kind: "github", label: "acme/harbor" });
		// A rename changes the words and not the project.
		expect(
			projectOf({
				sessionId: "s_2",
				repoUrl: "https://github.com/acme/quay.git",
				repo: { id: 7101, owner: "acme", name: "quay" },
			}),
		).toEqual({ key: "github:7101", kind: "github", label: "acme/quay" });
		expect(projectOf({ sessionId: "s_1", repoUrl: "https://example.com/acme/harbor.git" })).toEqual({
			key: "address:https://example.com/acme/harbor.git",
			kind: "address",
			label: "example.com/acme/harbor.git",
		});
		// The same repository, pasted: another project, so it is asked about once more.
		expect(projectOf({ sessionId: "s_1", repoUrl: "https://github.com/acme/harbor.git" }).key).not.toBe(github.key);
		expect(projectOf({ sessionId: "s_1", repoUrl: null })).toEqual({
			key: "session:s_1",
			kind: "session",
			label: "this session",
		});
		expect(projectOf({ sessionId: "s_2", repoUrl: null }).key).toBe(sessionProjectKey("s_2"));
	});

	it("answers for exactly the project, the server and the definition that were approved, for 30 days", () => {
		const book = new ApprovalBook();
		expect(book.approve(harbor, NOW).added).toEqual([{ ...harbor, approvedAt: NOW, expiresAt: NOW + APPROVAL_TTL_MS }]);
		expect(APPROVAL_TTL_MS).toBe(30 * DAY);
		expect(book.find("github:7101", "harbor", PRINT, NOW + 29 * DAY)?.approvedAt).toBe(NOW);
		expect(book.find("github:7101", "harbor", PRINT, NOW + 30 * DAY - 1)).not.toBeNull();
		expect(book.find("github:7101", "harbor", PRINT, NOW + 30 * DAY)).toBeNull();
		// A changed definition, another repository that names the server the same way, another server.
		expect(book.find("github:7101", "harbor", "5d0c2a7be1f94c36", NOW)).toBeNull();
		expect(book.find("github:7102", "harbor", PRINT, NOW)).toBeNull();
		expect(book.find("github:7101", "docs", PRINT, NOW)).toBeNull();
		expect(book.find("github:7101", "harbor", "", NOW)).toBeNull();
		// Another user has another book.
		expect(new ApprovalBook().find("github:7101", "harbor", PRINT, NOW)).toBeNull();
	});

	it("counts the 30 days from the user's approval: approving again starts them again, and nothing else does", () => {
		const book = new ApprovalBook();
		book.approve(harbor, NOW);
		const again = book.approve(harbor, NOW + 10 * DAY);
		expect(again.removed).toHaveLength(1);
		expect(book.all()).toEqual([{ ...harbor, approvedAt: NOW + 10 * DAY, expiresAt: NOW + 40 * DAY }]);
		expect(book.approve({ ...harbor, fingerprint: "" }, NOW)).toEqual({ added: [], removed: [] });
	});

	it("forgets a server for a project whatever its definition was, and leaves the rest", () => {
		const book = new ApprovalBook();
		book.approve(harbor, NOW);
		book.approve({ ...harbor, fingerprint: "5d0c2a7be1f94c36" }, NOW + 1);
		book.approve({ ...harbor, name: "docs", fingerprint: "e4d1a80c93f6b275" }, NOW + 2);
		book.approve({ ...harbor, project: "github:7102", label: "acme/lighthouse" }, NOW + 3);
		book.approve({ ...harbor, project: "session:s_9", label: "this session" }, NOW + 4);
		expect(book.forget("github:7101", "harbor").removed.map(row => row.fingerprint)).toEqual([
			PRINT,
			"5d0c2a7be1f94c36",
		]);
		expect(book.of("github:7101", NOW + 5).map(row => row.name)).toEqual(["docs"]);
		expect(book.find("github:7102", "harbor", PRINT, NOW + 5)).not.toBeNull();
		expect(book.forget("github:7101", "harbor").removed).toEqual([]);
		// A session that was its own project is deleted.
		expect(book.forgetProject("session:s_9").removed).toHaveLength(1);
		expect(book.all()).toHaveLength(2);
	});

	it("drops what has run out, lists a project's approvals the newest first, and holds no more than it may", () => {
		const book = new ApprovalBook([{ ...harbor, approvedAt: NOW - 31 * DAY, expiresAt: NOW - DAY }]);
		expect(book.of("github:7101", NOW)).toEqual([]);
		expect(book.prune(NOW).removed).toHaveLength(1);
		book.approve(harbor, NOW);
		book.approve({ ...harbor, fingerprint: "5d0c2a7be1f94c36" }, NOW + 60_000);
		expect(book.of("github:7101", NOW + 120_000).map(row => row.fingerprint)).toEqual(["5d0c2a7be1f94c36", PRINT]);
		const full = new ApprovalBook();
		for (let index = 0; index <= MAX_APPROVALS; index += 1)
			full.approve({ ...harbor, name: `server-${index}` }, NOW + index);
		expect(full.all()).toHaveLength(MAX_APPROVALS);
		expect(full.find("github:7101", "server-0", PRINT, NOW + MAX_APPROVALS)).toBeNull();
		// A time of the deployment's own, for its checks.
		const short = new ApprovalBook([], 4000);
		short.approve(harbor, NOW);
		expect([
			short.find("github:7101", "harbor", PRINT, NOW + 3999) !== null,
			short.find("github:7101", "harbor", PRINT, NOW + 4000) !== null,
		]).toEqual([true, false]);
	});
});

// ---------------------------------------------------------------------------------------------
// What a session keeps of its project's servers
// ---------------------------------------------------------------------------------------------

describe("what a session knows of its project's servers", () => {
	const said = (extra: Partial<TurnServer> = {}): TurnServer => ({
		name: "harbor",
		origin: "project",
		state: "waiting",
		argv: ["python3", "tools/harbor_mcp.py"],
		url: null,
		file: "/workspace/.windlass/config.json",
		tools: null,
		error: null,
		fingerprint: PRINT,
		...extra,
	});

	it("keeps the definition a server waited with once it runs, for as long as its command stays the same", () => {
		const waiting = knownServers([], [said()], NOW);
		expect(waiting).toEqual([
			{
				name: "harbor",
				subject: "python3 tools/harbor_mcp.py",
				remote: false,
				file: "/workspace/.windlass/config.json",
				state: "waiting",
				tools: null,
				reason: null,
				fingerprint: PRINT,
				at: NOW,
			},
		]);
		// Windlass names a fingerprint only while a server waits.
		const running = knownServers(waiting, [said({ state: "running", tools: 2, fingerprint: null })], NOW + 1000);
		expect(running[0]).toMatchObject({ state: "running", tools: 2, fingerprint: PRINT, at: NOW + 1000 });
		// Nothing new: what was known stays as it is, with the time it was heard.
		const same = knownServers(running, [said({ state: "running", tools: 2, fingerprint: null })], NOW + 9000);
		expect(same[0]).toBe(running[0]);
		expect(sameServers(running, same)).toBe(true);
		// Another command runs now: whatever definition that is, it is not the one the session saw approved.
		const other = knownServers(
			running,
			[
				said({
					state: "running",
					tools: 2,
					fingerprint: null,
					argv: ["python3", "tools/harbor_mcp.py", "--berths", "12 or more"],
				}),
			],
			NOW + 9000,
		);
		expect(other[0]).toMatchObject({ subject: "python3 tools/harbor_mcp.py --berths '12 or more'", fingerprint: null });
		// A changed definition waits with its own.
		expect(knownServers(running, [said({ fingerprint: "5d0c2a7be1f94c36" })], NOW)[0]).toMatchObject({
			state: "waiting",
			fingerprint: "5d0c2a7be1f94c36",
		});
	});

	it("says why one could not start, reads an address as an address, and lets go of what the project no longer names", () => {
		const failed = knownServers(
			[],
			[
				said({
					state: "failed",
					fingerprint: null,
					error: "the server process exited with code 1; stderr ends with:\nno such file",
				}),
			],
			NOW,
		);
		expect(failed[0]).toMatchObject({
			state: "failed",
			reason: "the server process exited with code 1; stderr ends with: no such file",
			tools: null,
		});
		const remote = knownServers(
			[],
			[said({ name: "docs", argv: null, url: "https://docs.example.com/mcp", fingerprint: "e4d1a80c93f6b275" })],
			NOW,
		);
		expect(remote[0]).toMatchObject({ name: "docs", subject: "https://docs.example.com/mcp", remote: true });
		expect(knownServers(failed, [], NOW)).toEqual([]);
		expect(sameServers(failed, [])).toBe(false);
		// Nothing is assumed of what the layer hands over.
		expect(
			knownServers(
				[],
				[said(), said(), { ...said(), name: "" }, { ...said(), name: "odd", state: "sideways" as never }],
				NOW,
			).map(server => `${server.name}:${server.state}`),
		).toEqual(["harbor:waiting", "odd:stopped"]);
	});

	it("shows each server with the approval of its own definition, and says when the remembered one is of an earlier definition", () => {
		const project = projectOf({ sessionId: "s_1", repoUrl: null, repo: { id: 7101, owner: "acme", name: "harbor" } });
		const book = new ApprovalBook();
		book.approve({ project: project.key, label: project.label, name: "harbor", fingerprint: PRINT }, NOW);
		const approvals = book.of(project.key, NOW + DAY);
		const asks = () => ({ title: "Start it?", details: ["a", "b"] });
		const running = knownServers(
			knownServers([], [said()], NOW),
			[said({ state: "running", tools: 2, fingerprint: null })],
			NOW,
		);
		const view = serversView(project, running, approvals, "what forgetting leaves", asks);
		expect(view.project).toEqual({ kind: "github", label: "acme/harbor" });
		expect(view.forgetting).toBe("what forgetting leaves");
		expect(view.servers[0]).toMatchObject({
			name: "harbor",
			state: "running",
			approval: { approvedAt: NOW, expiresAt: NOW + APPROVAL_TTL_MS },
		});
		expect(view.servers[0]).not.toHaveProperty("asks");
		expect(view.servers[0]).not.toHaveProperty("earlier");
		// The definition changed: it waits, the approval is of the earlier one, and the panel can put the question.
		const changed = serversView(
			project,
			knownServers(
				running,
				[said({ fingerprint: "5d0c2a7be1f94c36", argv: ["python3", "tools/harbor_mcp.py", "--berths", "12"] })],
				NOW,
			),
			approvals,
			"",
			asks,
		);
		expect(changed.servers[0]).toMatchObject({
			state: "waiting",
			approval: null,
			earlier: { approvedAt: NOW, expiresAt: NOW + APPROVAL_TTL_MS },
			asks: { title: "Start it?", details: ["a", "b"] },
		});
		// A server the session never saw wait (Windlass started it from its own record) gets the newest approval of its name.
		expect(approvalFor({ name: "harbor", fingerprint: null }, approvals)?.fingerprint).toBe(PRINT);
		expect(approvalFor({ name: "harbor", fingerprint: "5d0c2a7be1f94c36" }, approvals)).toBeNull();
		// Nothing remembered: a server that waits is asked about, one that runs is only listed.
		expect(serversView(project, knownServers([], [said()], NOW), [], "", asks).servers[0]).toMatchObject({
			approval: null,
			asks: { title: "Start it?" },
		});
		expect(serversView(project, running, [], "", asks).servers[0]).toEqual({ ...running[0], approval: null });
	});
});

describe("what a session knows of its user's own servers", () => {
	const own = (extra: Partial<TurnServer> = {}): TurnServer => ({
		name: "issues",
		origin: "user",
		state: "running",
		argv: ["npx", "-y", "issues-mcp"],
		url: null,
		file: "/home/agent/.config/windlass/config.json",
		tools: 3,
		error: null,
		fingerprint: null,
		...extra,
	});
	const project = { key: "github:7101", kind: "github" as const, label: "acme/harbor" };
	const asks = () => ({ title: "Start it?", details: [] });

	it("keeps them apart from the project's, without the file the platform wrote them into", () => {
		const harbor: TurnServer = {
			name: "harbor",
			origin: "project",
			state: "waiting",
			argv: ["python3", "tools/harbor_mcp.py"],
			url: null,
			file: "/workspace/.windlass/config.json",
			tools: null,
			error: null,
			fingerprint: PRINT,
		};
		const known = knownServers([], [harbor, own()], NOW);
		expect(known).toEqual([
			{
				name: "harbor",
				subject: "python3 tools/harbor_mcp.py",
				remote: false,
				file: "/workspace/.windlass/config.json",
				state: "waiting",
				tools: null,
				reason: null,
				fingerprint: PRINT,
				at: NOW,
			},
			{
				name: "issues",
				origin: "user",
				subject: "npx -y issues-mcp",
				remote: false,
				file: null,
				state: "running",
				tools: 3,
				reason: null,
				fingerprint: null,
				at: NOW,
			},
		]);
		// One that could not start says why, and one whose state did not change keeps the time it was first heard.
		const failed = knownServers(
			known,
			[
				harbor,
				own({
					state: "failed",
					tools: null,
					error: "the environment variable ISSUES_TOKEN named in its env is not set",
				}),
			],
			NOW + 1000,
		);
		expect(failed[1]).toMatchObject({
			origin: "user",
			state: "failed",
			reason: "the environment variable ISSUES_TOKEN named in its env is not set",
			at: NOW + 1000,
		});
		expect(failed[0]).toBe(known[0]);
		// The same name as the project's, were Windlass to say it of both origins, is two different things to know.
		expect(sameServers(knownServers([], [own()], NOW), knownServers([], [own({ origin: "project" })], NOW))).toBe(
			false,
		);
	});

	it("has no approval and asks nothing: Windlass starts them without a question, whatever is remembered for a server of the name", () => {
		const approvals = [
			{
				project: project.key,
				label: project.label,
				name: "issues",
				fingerprint: PRINT,
				approvedAt: NOW,
				expiresAt: NOW + APPROVAL_TTL_MS,
			},
		];
		const view = serversView(project, knownServers([], [own()], NOW), approvals, "", asks);
		expect(view.servers[0]).toMatchObject({ name: "issues", origin: "user", approval: null });
		expect(view.servers[0]).not.toHaveProperty("asks");
		expect(view.servers[0]).not.toHaveProperty("earlier");
	});
});

// ---------------------------------------------------------------------------------------------
// The mock
// ---------------------------------------------------------------------------------------------

describe("the mock's servers", () => {
	let client: MockClient;
	let auth: AuthResult;

	const after = async <T>(ms: number, promise: Promise<T>): Promise<T> => {
		await vi.advanceTimersByTimeAsync(ms);
		return promise;
	};

	/** What a call that fails is refused with. */
	const failing = (call: Promise<unknown>) =>
		after(
			500,
			call.then(
				() => null,
				(error: unknown) => error,
			),
		);

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW));
		client = createMockClient({ origin: "http://localhost:5173" });
		const started = await after(1000, client.login.start());
		auth = await after(
			1000,
			client.login.finish(`${started.redirectPrefix}?code=abc&state=${new URL(started.url).searchParams.get("state")}`),
		);
	});

	afterEach(() => {
		client.dispose();
		vi.useRealTimers();
	});

	/** A session and a feed on it. */
	async function watch(id: string) {
		const api = client.session(auth, id);
		const record = {
			items: [] as TimelineItem[],
			question: null as PendingQuestion | null,
			questions: 0,
			summary: null as SessionSummary | null,
		};
		const feed: SessionFeed = {
			onSnapshot: snapshot => {
				record.question = snapshot.question;
				record.summary = snapshot.summary;
			},
			onItem: item => {
				record.items.push(item);
			},
			onDelta: () => undefined,
			onSummary: summary => {
				record.summary = summary;
			},
			onQuestion: question => {
				if (question) record.questions += 1;
				record.question = question;
			},
			onConnection: () => undefined,
		};
		api.open(feed);
		await vi.advanceTimersByTimeAsync(500);
		const lines = () =>
			record.items.flatMap(item => (item.kind === "platform" && item.text.includes("MCP server") ? [item.text] : []));
		const ended = (turn: number) => record.items.some(item => item.kind === "turn.ended" && item.turn === turn);
		const until = async (what: () => boolean) => {
			for (let waited = 0; !what(); waited += 50) {
				if (waited > 10 * 60_000) throw new Error("the mock did not get there");
				await vi.advanceTimersByTimeAsync(50);
			}
		};
		return { api, record, lines, ended, until };
	}
	const launch = async (input: { repository?: { id: number }; repoUrl?: string } = {}) =>
		watch((await after(500, client.user(auth).createSession({ profile: "docker-windlass-sandbox", ...input }))).id);
	const named = (servers: SessionServers, name: string) =>
		servers.servers.find(server => server.name === name) as SessionServer;

	it("seeds a session whose project names three servers: one that runs with a remembered approval, one that waits, one that could not start", async () => {
		const { api, record } = await watch("checks");
		expect(record.summary?.servers?.count).toBe(3);
		const servers = await after(500, api.servers());
		expect(servers.project).toEqual({ kind: "github", label: "acme/harbor" });
		expect(servers.forgetting).toBe(MOCK_FORGETTING);
		expect(servers.servers.map(server => `${server.name}:${server.state}`)).toEqual([
			"harbor:running",
			"docs:waiting",
			"tracker:failed",
		]);
		const harbor = named(servers, "harbor");
		expect(harbor).toMatchObject({
			subject: "python3 tools/harbor_mcp.py",
			remote: false,
			tools: 2,
			fingerprint: PRINT,
		});
		expect((harbor.approval?.expiresAt ?? 0) - (harbor.approval?.approvedAt ?? 0)).toBe(30 * DAY);
		expect(Math.round(((harbor.approval?.expiresAt ?? 0) - NOW) / DAY)).toBe(27);
		expect(named(servers, "docs")).toMatchObject({
			remote: true,
			subject: "https://docs.acme.example/mcp",
			approval: null,
			asks: { title: 'Connect to this project\'s MCP server "docs"?' },
		});
		expect(named(servers, "docs").asks?.details).toHaveLength(3);
		expect(named(servers, "tracker")).toMatchObject({
			reason: "the environment variable TRACKER_TOKEN named in its env is not set",
			tools: null,
		});
		expect(named(servers, "tracker").approval).not.toBeNull();
		// The other seeded session on the repository shares the approval; one on another repository has no list at all.
		const other = await watch("harbor-build");
		expect(named(await after(500, other.api.servers()), "harbor").approval).toEqual(harbor.approval);
		const elsewhere = await watch("add-test");
		expect(elsewhere.record.summary?.servers).toBeUndefined();
		expect((await after(500, elsewhere.api.servers())).servers).toEqual([]);
	});

	it("spares a second session on the same repository the question, with the line that says why, and asks another repository", async () => {
		const first = await launch({ repository: { id: 7103 } });
		await after(300, first.api.prompt({ text: "List the berths with the mcp server" }));
		await first.until(() => first.record.question !== null);
		const listed = await after(500, first.api.servers());
		expect(listed.project.kind).toBe("github");
		expect(first.record.question?.details[1]).toBe(
			`Approving starts it now and is remembered for 30 days for exactly this definition: your sessions on ${listed.project.label} then start it without asking, until you forget the approval in a session's panel.`,
		);
		expect(named(listed, "harbor")).toMatchObject({ state: "waiting", approval: null, fingerprint: PRINT });
		await after(400, first.api.answer({ questionId: (first.record.question as PendingQuestion).id, choice: "start" }));
		await first.until(() => first.ended(1));
		expect(named(await after(500, first.api.servers()), "harbor")).toMatchObject({
			state: "running",
			tools: 2,
			approval: { expiresAt: expect.any(Number) },
		});

		await vi.advanceTimersByTimeAsync(2 * DAY);
		const second = await launch({ repository: { id: 7103 } });
		await after(300, second.api.prompt({ text: "List the berths with the mcp server" }));
		await second.until(() => second.ended(1));
		expect(second.record.questions).toBe(0);
		expect(second.lines()).toEqual([
			'Started the MCP server "harbor" because you approved it for this project 2 days ago: 2 tools. The agent has them from this turn on.',
		]);
		expect(second.record.summary?.servers?.count).toBe(1);
		// A later turn in that sandbox says nothing: Windlass's own record starts the server there.
		await after(300, second.api.prompt({ text: "And again with the mcp server" }));
		await second.until(() => second.ended(2));
		expect(second.lines()).toHaveLength(1);

		const elsewhere = await launch({ repository: { id: 7102 } });
		await after(300, elsewhere.api.prompt({ text: "List the berths with the mcp server" }));
		await elsewhere.until(() => elsewhere.record.question !== null);
		const alone = await launch();
		await after(300, alone.api.prompt({ text: "List the berths with the mcp server" }));
		await alone.until(() => alone.record.question !== null);
		expect(alone.record.question?.choices[0]?.remembers).toBe("exactly this definition, for this session, for 30 days");
	});

	it("asks again once an approval is 30 days old", async () => {
		const first = await launch({ repoUrl: "https://example.com/acme/pier.git" });
		await after(300, first.api.prompt({ text: "List the berths with the mcp server" }));
		await first.until(() => first.record.question !== null);
		await after(400, first.api.answer({ questionId: (first.record.question as PendingQuestion).id, choice: "start" }));
		await first.until(() => first.ended(1));
		await vi.advanceTimersByTimeAsync(30 * DAY);
		expect(named(await after(500, first.api.servers()), "harbor").approval).toBeNull();
		const later = await launch({ repoUrl: "https://example.com/acme/pier.git" });
		await after(300, later.api.prompt({ text: "List the berths with the mcp server" }));
		await later.until(() => later.record.question !== null);
		expect(later.lines()).toEqual([]);
	});

	it("approves a server that waits from the panel: one line, and the next turn starts it unasked", async () => {
		const { api, record, lines, ended, until } = await launch({ repoUrl: "https://example.com/acme/quay.git" });
		await after(300, api.prompt({ text: "List the berths with the mcp server" }));
		await until(() => record.question !== null);
		await after(400, api.answer({ questionId: (record.question as PendingQuestion).id, choice: "not_now" }));
		await until(() => ended(1));
		const waiting = named(await after(500, api.servers()), "harbor");
		expect(waiting).toMatchObject({ state: "waiting", approval: null });
		expect(waiting.asks?.details[1]).toBe(
			"Approving starts it with this session's next turn and is remembered for 30 days for exactly this definition: your sessions on example.com/acme/quay.git then start it without asking, until you forget the approval in a session's panel.",
		);
		expect(await failing(api.approveServer("harbor", "0000000000000000"))).toMatchObject({ reason: "server_changed" });
		expect(await failing(api.approveServer("tracker", PRINT))).toMatchObject({ reason: "server_gone" });
		const changedAt = record.summary?.servers?.changedAt ?? 0;
		const approved = await after(500, api.approveServer("harbor", PRINT));
		expect(named(approved, "harbor")).toMatchObject({ state: "waiting", approval: { approvedAt: expect.any(Number) } });
		expect(named(approved, "harbor")).not.toHaveProperty("asks");
		expect(record.summary?.servers?.changedAt).toBeGreaterThan(changedAt);
		expect(lines().at(-1)).toBe(
			'Approved the MCP server "harbor" for this project in the session\'s panel. It starts with the next turn.',
		);
		await after(300, api.prompt({ text: "Now use the mcp server" }));
		await until(() => ended(2));
		expect(record.questions).toBe(1);
		expect(lines().at(-1)).toBe(
			'Started the MCP server "harbor" because you approved it for this project a moment ago: 2 tools. The agent has them from this turn on.',
		);
		expect(named(await after(500, api.servers()), "harbor").state).toBe("running");
	});

	it("answers an open question when the panel approves the server it is about", async () => {
		const { api, record, lines, until } = await launch();
		await after(300, api.prompt({ text: "List the berths with the mcp server" }));
		await until(() => record.question !== null);
		await after(500, api.approveServer("harbor", PRINT));
		expect(record.question).toBeNull();
		expect(lines()).toEqual([
			'Started the MCP server "harbor" for this project: 2 tools. The agent has them from this turn on.',
		]);
	});

	it("forgets an approval for every session of the project, says so once, and asks the next session", async () => {
		const checks = await watch("checks");
		const building = await watch("harbor-build");
		const changedAt = checks.record.summary?.servers?.changedAt ?? 0;
		const forgotten = await after(500, checks.api.forgetServer("harbor"));
		expect(named(forgotten, "harbor")).toMatchObject({ state: "running", approval: null });
		expect(named(forgotten, "tracker").approval).not.toBeNull();
		expect(checks.lines()).toEqual([
			'Forgot your approval of the MCP server "harbor" for this project. The next session or sandbox asks again; where it already started, Windlass\'s own record still starts it.',
		]);
		expect(checks.record.summary?.servers?.changedAt).toBeGreaterThan(changedAt);
		expect(named(await after(500, building.api.servers()), "harbor").approval).toBeNull();
		// Nothing to forget: nothing is said.
		await after(500, checks.api.forgetServer("harbor"));
		expect(checks.lines()).toHaveLength(1);
		const next = await launch({ repository: { id: 7101 } });
		await after(300, next.api.prompt({ text: "List the berths with the mcp server" }));
		await next.until(() => next.record.question !== null);
		expect(next.record.question?.server?.name).toBe("harbor");
	});

	it("fails the next call when asked to, for looking at the panel's errors", async () => {
		const { api } = await watch("checks");
		client.mockNextServers("list");
		expect(await failing(api.servers())).toMatchObject({ code: "network" });
		expect((await after(500, api.servers())).servers).toHaveLength(3);
		client.mockNextServers("forget");
		expect(await failing(api.forgetServer("harbor"))).toMatchObject({
			message: "The approval could not be forgotten. Try again.",
		});
		client.mockNextServers("approve");
		expect(await failing(api.approveServer("docs", "e4d1a80c93f6b275"))).toMatchObject({
			message: "The approval could not be remembered. Try again.",
		});
		expect(named(await after(500, api.servers()), "harbor").approval).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------------------------

describe("the panel's section", () => {
	it("words each state, and says of a server that ran that it starts with each turn while none is in progress", () => {
		const server = (state: SessionServer["state"], extra: Partial<SessionServer> = {}) => ({
			state,
			remote: false,
			tools: null,
			approval: null,
			...extra,
		});
		expect(serverState(server("running", { tools: 2 }), true)).toEqual({
			word: "running",
			fact: "2 tools",
			tone: "on",
		});
		expect(serverState(server("running", { tools: 1 }), false)).toEqual({
			word: "starts with each turn",
			fact: "1 tool",
			tone: "on",
		});
		expect(serverState(server("running", { tools: 0, remote: true }), false)).toEqual({
			word: "connects with each turn",
			fact: "no tools",
			tone: "on",
		});
		expect(serverState(server("starting"), true)).toEqual({ word: "starting", fact: null, tone: "on" });
		expect(serverState(server("waiting"), false)).toEqual({ word: "waits for your approval", fact: null, tone: "ask" });
		expect(serverState(server("waiting", { approval: { approvedAt: 1, expiresAt: 2 } }), false)).toEqual({
			word: "approved",
			fact: "starts with the next turn",
			tone: "on",
		});
		expect(serverState(server("failed"), false)).toEqual({ word: "could not start", fact: null, tone: "bad" });
		expect(serverState(server("failed", { remote: true }), false)).toEqual({
			word: "could not connect",
			fact: null,
			tone: "bad",
		});
		expect(serverState(server("stopped"), false)).toEqual({ word: "stopped", fact: null, tone: "off" });
	});

	describe("rendered", () => {
		let host: HTMLElement;
		let root: Root;
		let client: MockClient;
		let auth: AuthResult;

		const text = (selector: string) =>
			[...host.querySelectorAll(selector)].map(node => node.textContent?.replace(/\s+/g, " ").trim());
		const pass = async (ms: number) => {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(ms);
			});
		};
		const summaryOf = async (id: string) =>
			(
				await (async () => {
					const listed = client.user(auth).listSessions();
					await vi.advanceTimersByTimeAsync(500);
					return listed;
				})()
			).find(summary => summary.id === id) as SessionSummary;
		const render = (summary: SessionSummary, question: PendingQuestion | null = null) =>
			act(() =>
				root.render(
					createElement(AppProvider, {
						client,
						children: createElement(ServersSection, { sessionId: summary.id, summary, question }),
					}),
				),
			);

		beforeEach(async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date(NOW));
			// jsdom has no <dialog> of its own that opens.
			HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
				this.setAttribute("open", "");
			};
			HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
				this.removeAttribute("open");
			};
			client = createMockClient({ origin: "http://localhost:5173" });
			const started = client.login.start();
			await vi.advanceTimersByTimeAsync(1000);
			const finished = client.login.finish(
				`${(await started).redirectPrefix}?code=abc&state=${new URL((await started).url).searchParams.get("state")}`,
			);
			await vi.advanceTimersByTimeAsync(1000);
			auth = await finished;
			saveAuth("mock", auth);
			host = document.createElement("div");
			document.body.append(host);
			root = createRoot(host);
		});

		afterEach(() => {
			act(() => root.unmount());
			host.remove();
			client.dispose();
			saveAuth("mock", null);
			vi.useRealTimers();
		});

		it("is not there for a session whose project names no server", async () => {
			render(await summaryOf("add-test"));
			await pass(500);
			expect(host.innerHTML).toBe("");
		});

		it("lists the project's servers: the command in full, the state, the approval and until when", async () => {
			render(await summaryOf("checks"));
			expect(text(".panel-title")).toEqual(["MCP servers"]);
			expect(host.querySelector("[aria-busy=true]")?.getAttribute("aria-label")).toBe("Loading the servers");
			await pass(500);
			expect(host.querySelector("[aria-busy=true]")).toBeNull();
			expect(text(".server-lede")).toEqual(["Approvals are remembered for acme/harbor."]);
			expect(text(".server-name")).toEqual(["harbor", "docs", "tracker"]);
			// No turn is in progress: a server that ran starts again with the next one.
			expect(text(".server-state")).toEqual([
				"starts with each turn · 2 tools",
				"waits for your approval",
				"could not start",
			]);
			expect(text(".server-subject")).toEqual([
				"started by python3 tools/harbor_mcp.py",
				"reached at https://docs.acme.example/mcp",
				"started by npx -y @acme/tracker-mcp --stdio --project 'Harbor 2.4'",
			]);
			expect(text(".server-reason")).toEqual(["the environment variable TRACKER_TOKEN named in its env is not set"]);
			expect(text(".server-held")).toEqual(["approved until 13 Dec 2026", "approved until 15 Dec 2026"]);
			expect(host.querySelector(".server-held time")?.getAttribute("datetime")).toMatch(/^2026-12-13T11:20:/);
			expect(
				[...host.querySelectorAll("button")].map(button => button.getAttribute("aria-label") ?? button.textContent),
			).toEqual([
				"Read this agent's MCP servers again",
				"Forget the approval of the MCP server harbor",
				"Approve the MCP server docs",
				"Forget the approval of the MCP server tracker",
			]);
			expect(text(".server-note")).toEqual([MOCK_FORGETTING]);
		});

		it("says running while a turn is in progress, and points to the conversation while the question is open there", async () => {
			const summary = { ...(await summaryOf("checks")), status: "waiting" as const };
			const question = {
				server: { name: "docs", file: null, remote: true, unset: [], holdsTurn: true },
			} as unknown as PendingQuestion;
			render(summary, question);
			await pass(500);
			expect(text(".server-state")[0]).toBe("running · 2 tools");
			expect(text(".server:nth-child(2) .server-foot")).toEqual(["asked in the conversation"]);
			expect(host.querySelector('[aria-label="Approve the MCP server docs"]')).toBeNull();
		});

		it("forgets an approval in place: the line stays one line, and the note about what that leaves stays", async () => {
			const summary = await summaryOf("checks");
			render(summary);
			await pass(500);
			const forget = host.querySelector<HTMLButtonElement>(
				'[aria-label="Forget the approval of the MCP server harbor"]',
			);
			act(() => forget?.click());
			expect(forget?.textContent).toBe("Forgetting…");
			expect(forget?.disabled).toBe(true);
			await pass(500);
			expect(text(".server:first-child .server-foot")).toEqual(["no approval remembered"]);
			expect(text(".server-held")).toEqual(["no approval remembered", "approved until 15 Dec 2026"]);
			// The last one goes too: the note is still there for whoever just forgot.
			act(() =>
				host.querySelector<HTMLButtonElement>('[aria-label="Forget the approval of the MCP server tracker"]')?.click(),
			);
			await pass(500);
			expect(host.querySelector(".server-forget")).toBeNull();
			expect(text(".server-note")).toEqual([MOCK_FORGETTING]);
		});

		it("says why forgetting did not go through, under the server it was about, and leaves the approval", async () => {
			render(await summaryOf("checks"));
			await pass(500);
			client.mockNextServers("forget");
			act(() =>
				host.querySelector<HTMLButtonElement>('[aria-label="Forget the approval of the MCP server harbor"]')?.click(),
			);
			await pass(500);
			expect(text(".server:first-child [role=alert]")).toEqual(["The approval could not be forgotten. Try again."]);
			expect(text(".server:first-child .server-held")).toEqual(["approved until 13 Dec 2026"]);
			expect(
				host.querySelector<HTMLButtonElement>('[aria-label="Forget the approval of the MCP server harbor"]')?.disabled,
			).toBe(false);
		});

		it("puts the question's own sentences before it takes an approval, and then says when the server starts", async () => {
			render(await summaryOf("checks"));
			await pass(500);
			act(() => host.querySelector<HTMLButtonElement>('[aria-label="Approve the MCP server docs"]')?.click());
			expect(text(".dialog-title")).toEqual(['Connect to this project\'s MCP server "docs"?']);
			expect(text(".server-ask-subject")).toEqual(["https://docs.acme.example/mcp"]);
			expect(text(".server-ask-where")).toEqual(["defined in /workspace/.windlass/config.json"]);
			expect(text(".server-ask-details p")).toEqual([
				"Nothing is started: Windlass reaches it at that address from this session's container, outside its sandbox around commands, and what the agent sends it leaves the container.",
				"Approving lets Windlass connect to it from this session's next turn and is remembered for 30 days for exactly this definition: your sessions on acme/harbor then connect without asking, until you forget the approval in a session's panel.",
				"It is an approval of this address, not of what answers there.",
			]);
			expect(text(".dialog-foot button")).toEqual(["Not now", "Approve for this project"]);
			// A try that fails is said in the dialog, which stays.
			client.mockNextServers("approve");
			act(() => host.querySelector<HTMLButtonElement>(".dialog-foot .button-primary")?.click());
			expect(text(".dialog-foot .button-primary")).toEqual(["Approving…"]);
			await pass(500);
			expect(text(".dialog [role=alert]")).toEqual(["The approval could not be remembered. Try again."]);
			act(() => host.querySelector<HTMLButtonElement>(".dialog-foot .button-primary")?.click());
			await pass(500);
			expect(host.querySelector(".dialog")).toBeNull();
			expect(text(".server:nth-child(2) .server-state")).toEqual(["approved · connects with the next turn"]);
			expect(text(".server:nth-child(2) .server-held")).toEqual(["approved until 16 Dec 2026"]);
			expect(host.querySelector('[aria-label="Approve the MCP server docs"]')).toBeNull();
		});

		it("says why a changed definition is asked about again, and keeps the row's lines where they were once its earlier approval is forgotten", async () => {
			const summary = await summaryOf("checks");
			const row: SessionServer = {
				name: "harbor",
				subject: "python3 tools/harbor_mcp.py --berths 12",
				remote: false,
				file: "/workspace/.windlass/config.json",
				state: "waiting",
				tools: null,
				reason: null,
				fingerprint: "5d0c2a7be1f94c36",
				at: NOW,
				approval: null,
			};
			const asks = { title: 'Start this project\'s MCP server "harbor"?', details: ["One.", "Two.", "Three."] };
			const listed = (earlier: boolean): SessionServers => ({
				project: { kind: "github", label: "acme/harbor" },
				forgetting: MOCK_FORGETTING,
				servers: [
					{ ...row, asks, ...(earlier ? { earlier: { approvedAt: NOW - 3 * DAY, expiresAt: NOW + 27 * DAY } } : {}) },
				],
			});
			const forgotten: string[] = [];
			const real = client;
			client = {
				...real,
				session: (who, id) => ({
					...real.session(who, id),
					servers: async () => listed(forgotten.length === 0),
					forgetServer: async name => {
						forgotten.push(name);
						return listed(false);
					},
				}),
			};
			render(summary);
			await pass(100);
			expect(text(".server-state")).toEqual(["waits for your approval"]);
			expect(text(".server-reason")).toEqual(["Its definition changed since you approved it."]);
			expect(text(".server-foot")).toEqual(["Approve…", "earlier approval until 13 Dec 2026Forget"]);
			act(() => host.querySelector<HTMLButtonElement>(".server-forget")?.click());
			await pass(100);
			expect(forgotten).toEqual(["harbor"]);
			expect(text(".server-reason")).toEqual(["Its definition changed since you approved it."]);
			expect(text(".server-foot")).toEqual(["Approve…", "no approval remembered"]);
			expect(text(".server-note")).toEqual([MOCK_FORGETTING]);
			client = real;
		});

		it("says when the list could not be read, and reads it again on request", async () => {
			client.mockNextServers("list");
			render(await summaryOf("checks"));
			await pass(500);
			expect(text("[role=alert]")).toEqual([
				"The server did not answer, so the project's MCP servers could not be read. Try again.",
			]);
			expect(host.querySelector(".servers")).toBeNull();
			act(() => host.querySelector<HTMLButtonElement>('[aria-label="Read this agent\'s MCP servers again"]')?.click());
			await pass(500);
			expect(host.querySelector("[role=alert]")).toBeNull();
			expect(text(".server-name")).toHaveLength(3);
		});
	});
});
