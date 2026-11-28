/**
 * Checks of continuing a session in a new one ("Continue in a new PR", `continueSession` in
 * server/src/actors/user.ts), without a server: what the earlier session hands over and refuses
 * (agent-session/continuation.ts, `forkSource`), what the new session starts with (`continuationMeta`)
 * and is told once (`platformNotes`), the account of the earlier timeline (turn-resume.ts,
 * `sessionHandoff`), the settings the new session is made with and the copy of the agent's session in
 * a stand-in store (continue-session.ts). Run with:
 *
 *   cd server && npx tsx ../scripts/continue-session-check.ts
 *
 * The actors' side (the action, its refusals, the summary's links, the clone's base) is a case of the
 * GitHub scenarios in scripts/e2e.ts.
 */

import { StandInObjectStore } from "../server/src/bucket/stand-in.js";
import type { TimelineItem } from "../server/src/contract.js";
import { continuedInput, copyAgentSession } from "../server/src/actors/continue-session.js";
import { continuationMeta, continuationNote, forkSource } from "../server/src/actors/agent-session/continuation.js";
import type { Ctx, SessionMeta } from "../server/src/actors/agent-session/state.js";
import { platformNotes } from "../server/src/actors/agent-session/workspace.js";
import type { Continuation, ForkSource } from "../server/src/actors/internal.js";
import { sessionHandoff } from "../server/src/actors/turn-resume.js";
import { SandboxSessionBackups } from "../server/src/sandbox/backup.js";
import type { SandboxLayer } from "../server/src/sandbox/api.js";
import { copyOnMachine } from "../server/src/actors/agent-session/sandbox.js";
import { untrustedWords } from "../server/src/factory/untrusted.js";
import { Report } from "./check-report.js";

const report = new Report();
const { check } = report;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const row = (seq: number, turn: number, item: object) => ({ seq, at: seq, turn, ...item }) as TimelineItem;
const ISSUE = "a GitHub issue (#7) by someone else";
const TIMELINE: TimelineItem[] = [
	row(1, 1, { kind: "user", text: "Make the parser strict.", model: "m", effort: null, untrusted: [ISSUE] }),
	row(2, 1, { kind: "windlass", event: { type: "workspace.changes", data: { files: ["src/parse.ts"] } } }),
	row(3, 1, { kind: "windlass", event: { type: "text.ended", data: { text: "Done: trailing commas are refused." } } }),
	row(4, 1, { kind: "turn.ended", outcome: "succeeded" }),
	row(5, 2, { kind: "user", text: "Now add a test for it.", model: "m", effort: null }),
	row(6, 2, { kind: "turn.ended", outcome: "failed" }),
];

const REPO = {
	provider: "github" as const,
	id: 42,
	owner: "ada",
	name: "harbor",
	branch: "main",
	private: true,
	url: "https://github.com/ada/harbor",
	installationId: 9,
};

function meta(change: Partial<SessionMeta> = {}): SessionMeta {
	return {
		uid: "u_ada",
		sessionId: "s_parent",
		demo: false,
		title: "Fix the harbor light",
		place: { kind: "hosted" },
		profile: "e2b-strict" as never,
		model: "claude-opus",
		effort: "high",
		mode: "auto",
		availableModes: [],
		repoUrl: "https://github.com/ada/harbor.git",
		createdAt: 1,
		updatedAt: 1,
		status: "idle",
		turns: 2,
		lastOutcome: "failed",
		sandboxId: "sb_1",
		sandbox: "running",
		cloned: true,
		harness: "claude",
		windlassSessionId: "ses_abc",
		turnStartedAt: null,
		lastUsedAt: 1,
		serversChangedAt: 1,
		machineName: null,
		hostedSize: "medium" as never,
		repo: REPO,
		publishBranch: "windlass/fix-the-harbor-light",
		pushedHead: "abc123",
		platformPushed: "abc123",
		pull: {
			number: 12,
			url: "https://github.com/ada/harbor/pull/12",
			state: "open",
			branch: "windlass/fix-the-harbor-light",
		} as never,
		verified: { checks: [] } as never,
		backup: { windlassSessionId: "ses_abc", size: 10, sha256: "f".repeat(64), at: 5, turn: 2 },
		memoryTurn: 2,
		tainted: true,
		secretRequestBlocked: true,
		...change,
	};
}

/** Enough of a session actor's context for `forkSource`: the timeline is `TIMELINE`. */
function ctx(change: Partial<Ctx["vars"]> = {}): Ctx {
	return {
		vars: { serial: Promise.resolve(), unwritten: [], turn: null, accepting: false, meta: null, ...change },
		db: {
			execute: async (sql: string, turn: number) =>
				sql.startsWith("SELECT item FROM timeline")
					? TIMELINE.filter(item => item.turn <= turn).map(item => ({ item: JSON.stringify(item) }))
					: [],
		},
	} as unknown as Ctx;
}

async function refusal(call: () => Promise<unknown>): Promise<string> {
	try {
		await call();
	} catch (error) {
		return String((error as { code?: unknown }).code);
	}
	return "none";
}

// ---------------------------------------------------------------------------------------------
// The account of the earlier session
// ---------------------------------------------------------------------------------------------

await check("the handoff quotes the first prompt and accounts for each turn, keeping the untrusted labels", () => {
	const handoff = sessionHandoff(TIMELINE, 2);
	assert(handoff, "no handoff");
	for (const words of [
		"You do not have the earlier session's conversation",
		"> Make the parser strict.",
		"Turn 1: “Make the parser strict.”; it ended succeeded; files changed: src/parse.ts.",
		"Your earlier message (untrusted quoted text): “Done: trailing commas are refused.”",
		"Turn 2: “Now add a test for it.”; it ended failed.",
		"not your own memory",
	])
		assert(handoff.text.includes(words), `the handoff lacks "${words}": ${handoff.text}`);
	assert(
		handoff.untrusted.includes(ISSUE) && handoff.untrusted.includes(untrustedWords.conversation),
		`its sources are ${JSON.stringify(handoff.untrusted)}`,
	);
	assert(sessionHandoff([], 0) === null, "a session with no prompt has a handoff");
	return `${handoff.text.length} characters; sources: ${handoff.untrusted.join("; ")}`;
});

// ---------------------------------------------------------------------------------------------
// What the earlier session hands over, and refuses
// ---------------------------------------------------------------------------------------------

await check(
	"the source carries the settings, effort, trust, branch and pull request, with a copy that matches",
	async () => {
		const source = await forkSource(ctx(), meta());
		assert(
			source.harness === "claude" &&
				source.model === "claude-opus" &&
				source.effort === "high" &&
				source.mode === "auto" &&
				source.place.kind === "hosted" &&
				source.hostedSize === ("medium" as never) &&
				source.profile === ("e2b-strict" as never) &&
				source.repo.id === 42,
			`the settings are ${JSON.stringify(source)}`,
		);
		assert(source.pushedBranch === "windlass/fix-the-harbor-light" && source.pull === 12, "the branch or pull is lost");
		assert(source.tainted && source.secretRequestBlocked, "the trust did not carry over");
		assert(source.copy?.windlassSessionId === "ses_abc" && source.copy.backup.sha256 === "f".repeat(64), "no copy");
		assert(source.handoff?.text.includes("> Make the parser strict."), "no handoff beside the copy");
		return "claude-opus at high, auto, hosted medium, #12 on its branch, tainted, with a copy and a handoff";
	},
);

await check(
	"no copy when it is of another agent session or behind the last turn; no branch before a push",
	async () => {
		const other = await forkSource(
			ctx(),
			meta({ backup: { windlassSessionId: "ses_old", size: 1, sha256: "a".repeat(64), at: 1, turn: 1 } }),
		);
		const behind = await forkSource(ctx(), meta({ memoryTurn: 3 }));
		const none = await forkSource(ctx(), meta({ backup: null }));
		const unpushed = await forkSource(ctx(), meta({ pushedHead: null, pull: null }));
		const merged = await forkSource(ctx(), meta({ pushedHead: null, pull: { ...meta().pull!, state: "merged" } }));
		const open = await forkSource(ctx(), meta({ pushedHead: null, pull: { ...meta().pull!, branch: "windlass/pr" } }));
		assert(
			other.copy === null && behind.copy === null && none.copy === null,
			"a copy that does not match is handed over",
		);
		assert(other.handoff && behind.handoff && none.handoff, "the handoff is missing where there is no copy");
		assert(unpushed.pushedBranch === null && unpushed.pull === null, "an unpushed session names a branch");
		assert(merged.pushedBranch === null && open.pushedBranch === "windlass/pr", "a pull request's branch is not taken");
		return "another session's copy, a stale copy and none all fall back to the handoff";
	},
);

await check(
	"refused: item, readiness and build sessions, sessions without a repository, and running turns",
	async () => {
		const codes = {
			item: await refusal(() => forkSource(ctx(), meta({ origin: { kind: "item", itemId: "i_1" } }))),
			readiness: await refusal(() => forkSource(ctx(), meta({ readiness: { attempt: "a", commit: "c" } }))),
			build: await refusal(() =>
				forkSource(ctx(), meta({ environmentBuild: { project: "p", place: "hosted", screenshots: false } })),
			),
			noRepo: await refusal(() => forkSource(ctx(), meta({ repo: null }))),
			turn: await refusal(() => forkSource(ctx({ turn: {} as never }), meta())),
			accepting: await refusal(() => forkSource(ctx({ accepting: true }), meta())),
			running: await refusal(() => forkSource(ctx(), meta({ status: "running" }))),
			paused: await refusal(() => forkSource(ctx(), meta({ status: "paused", run: {} as never }))),
		};
		const expected = {
			item: "item_session",
			readiness: "item_session",
			build: "item_session",
			noRepo: "no_repository",
			turn: "turn_running",
			accepting: "turn_running",
			running: "turn_running",
			paused: "turn_running",
		};
		assert(JSON.stringify(codes) === JSON.stringify(expected), `the codes are ${JSON.stringify(codes)}`);
		return Object.values(codes).join(", ");
	},
);

// ---------------------------------------------------------------------------------------------
// What the new session starts with, and is told
// ---------------------------------------------------------------------------------------------

const FROM = { id: "s_parent", title: "Fix the harbor light", pull: 12, base: "main", stacked: false };
const HANDOFF = { text: "An account.", untrusted: [ISSUE] };

await check("the new meta takes the copy, the trust and the link, and nothing of the publish or checks", () => {
	const continuation: Continuation = {
		from: FROM,
		copy: { windlassSessionId: "ses_abc", backup: { size: 10, sha256: "f".repeat(64), at: 5 } },
		handoff: HANDOFF,
		tainted: true,
		secretRequestBlocked: true,
	};
	const added = continuationMeta(continuation);
	assert(
		added.windlassSessionId === "ses_abc" &&
			added.backup?.windlassSessionId === "ses_abc" &&
			added.backup.turn === 0 &&
			added.copiedSession === true,
		`the copy is ${JSON.stringify(added)}`,
	);
	assert(added.tainted === true && added.secretRequestBlocked === true, "the trust did not carry over");
	assert(
		added.continuedFrom?.id === "s_parent" && added.handoff?.text === "An account.",
		"the link or handoff is lost",
	);
	const keys = Object.keys(added).sort().join(",");
	assert(
		keys === "backup,continuedFrom,copiedSession,handoff,secretRequestBlocked,tainted,windlassSessionId",
		`it sets ${keys}`,
	);
	const plain = continuationMeta({ ...continuation, copy: null, tainted: false, secretRequestBlocked: false });
	assert(
		plain.windlassSessionId === undefined && plain.backup === undefined && plain.tainted === undefined,
		`without a copy it sets ${JSON.stringify(plain)}`,
	);
	return keys;
});

await check("the first prompt is told once where the session came from and where its branch starts", () => {
	const fresh = meta({
		...continuationMeta({ from: FROM, copy: null, handoff: HANDOFF, tainted: false, secretRequestBlocked: false }),
		freshWorkspace: true,
	});
	const notes = platformNotes(fresh, false);
	for (const words of ["continues the earlier session “Fix the harbor light”", "#12", "the base branch main"])
		assert(notes.text.includes(words), `the note lacks "${words}": ${notes.text}`);
	assert(!notes.text.includes("has been replaced by a new one"), "the replaced-sandbox note is given too");
	notes.told();
	assert(fresh.continuedFrom?.told === true && fresh.handoff === null, "telling did not clear the note and handoff");
	assert(platformNotes(fresh, false).text === "", "the note is given again");
	const stacked = continuationNote(meta({ continuedFrom: { ...FROM, base: "windlass/fix", stacked: true } }));
	assert(stacked.includes("from the earlier session's branch windlass/fix (the branch of #12)"), stacked);
	const unpulled = continuationNote(meta({ continuedFrom: { ...FROM, pull: null } }));
	assert(unpulled.includes("opened no pull request"), unpulled);
	return "the default, stacked and no-pull wordings; once";
});

// ---------------------------------------------------------------------------------------------
// The user's side: the settings, and the copy in the store
// ---------------------------------------------------------------------------------------------

const SOURCE: ForkSource = {
	title: "Fix the harbor light",
	harness: "claude",
	model: "claude-opus",
	effort: "high",
	mode: "auto",
	place: { kind: "hosted" },
	size: 2,
	hostedSize: "medium" as never,
	profile: "e2b-strict" as never,
	repo: REPO,
	pushedBranch: "windlass/fix",
	pull: 12,
	tainted: false,
	secretRequestBlocked: false,
	copy: { windlassSessionId: "ses_abc", backup: { size: 10, sha256: "f".repeat(64), at: 5 } },
	handoff: HANDOFF,
};

await check(
	"the new session is asked for with the same settings, on the default branch or stacked on the pushed one",
	() => {
		const plain = continuedInput(SOURCE, false);
		const stacked = continuedInput(SOURCE, true);
		assert(
			plain.harness === "claude" &&
				plain.model === "claude-opus" &&
				plain.mode === "auto" &&
				plain.size === 2 &&
				plain.hostedSize === ("medium" as never) &&
				plain.profile === ("e2b-strict" as never) &&
				plain.place?.kind === "hosted",
			`it asks for ${JSON.stringify(plain)}`,
		);
		assert(
			JSON.stringify(plain.repository) === JSON.stringify({ id: 42 }),
			`default: ${JSON.stringify(plain.repository)}`,
		);
		assert(stacked.repository?.branch === "windlass/fix", `stacked: ${JSON.stringify(stacked.repository)}`);
		assert(!("publishUnasked" in plain), "letting the agent publish unasked carried over");
		return "repository 42 at its default branch; stacked at windlass/fix";
	},
);

const store = new StandInObjectStore();
const backups = new SandboxSessionBackups(store, { maxBytes: 1024 * 1024 });
const hostedOwn = { backups, sandboxes: { sessionsLiveInSandbox: true } } as unknown as Pick<
	SandboxLayer,
	"backups" | "sandboxes"
>;
const parentKey = backups.keyOf({ uid: "u_ada", sessionId: "s_parent" });
const archive = Buffer.from("an agent session");
{
	const link = await store.linkToPut(parentKey, { size: archive.length, ttlMs: 60_000 } as never);
	assert(store.use(link.url, "PUT", archive).status === 200, "the stand-in took no archive");
}

await check(
	"hosted with its own agent data: the copy is made under the new session's key, and outlives the earlier one",
	async () => {
		const copy = await copyAgentSession(hostedOwn, "u_ada", "s_parent", "s_child", SOURCE);
		assert(copy?.windlassSessionId === "ses_abc", `the copy is ${JSON.stringify(copy)}`);
		const childKey = backups.keyOf({ uid: "u_ada", sessionId: "s_child" });
		assert((await store.size(childKey)) === archive.length, "no object under the new key");
		await backups.remove({ uid: "u_ada", sessionId: "s_parent" });
		assert(
			(await store.size(parentKey)) === null && (await store.size(childKey)) === archive.length,
			"deleting the earlier copy took the new one",
		);
		return `${childKey}, ${archive.length} bytes, kept after the earlier one is removed`;
	},
);

await check("no copy on a machine, without a store, on shared agent data, or without a matching copy", async () => {
	const owner = { uid: "u_ada", sessionId: "s_parent" };
	const link = await store.linkToPut(parentKey, { size: archive.length, ttlMs: 60_000 } as never);
	store.use(link.url, "PUT", archive);
	const tried = {
		machine: await copyAgentSession(hostedOwn, "u_ada", "s_parent", "s_m", {
			...SOURCE,
			place: { kind: "machine", machineId: "m_1" },
		}),
		noStore: await copyAgentSession({ ...hostedOwn, backups: null }, "u_ada", "s_parent", "s_n", SOURCE),
		shared: await copyAgentSession(
			{ backups, sandboxes: { sessionsLiveInSandbox: false, privateSessionData: async () => false } } as never,
			"u_ada",
			"s_parent",
			"s_s",
			{ ...SOURCE, harness: undefined },
		),
		noCopy: await copyAgentSession(hostedOwn, "u_ada", "s_parent", "s_c", { ...SOURCE, copy: null }),
		missing: await copyAgentSession(hostedOwn, "u_ada", "s_gone", "s_g", SOURCE),
		failing: await copyAgentSession(
			{ ...hostedOwn, backups: { ...backups, copy: async () => Promise.reject(new Error("store down")) } } as never,
			"u_ada",
			"s_parent",
			"s_f",
			SOURCE,
		),
	};
	assert(
		Object.values(tried).every(copy => copy === null),
		`copies: ${JSON.stringify(tried)}`,
	);
	for (const id of ["s_m", "s_n", "s_s", "s_c", "s_g"])
		assert((await store.size(backups.keyOf({ ...owner, sessionId: id }))) === null, `an object was made for ${id}`);
	return Object.keys(tried).join(", ");
});

await check(
	"on a machine, the new meta waits to copy the earlier session's copy, and only without a copy already made",
	() => {
		const saved = { size: 10, sha256: "f".repeat(64), at: 5 };
		const machineCopy = { from: "s_parent", windlassSessionId: "ses_abc", backup: saved };
		const base = { from: FROM, handoff: HANDOFF, tainted: false, secretRequestBlocked: false };
		const pending = continuationMeta({ ...base, copy: null, machineCopy });
		assert(
			pending.pendingCopy?.from === "s_parent" && pending.pendingCopy.windlassSessionId === "ses_abc",
			`pending: ${JSON.stringify(pending.pendingCopy)}`,
		);
		assert(pending.windlassSessionId === undefined && pending.backup === undefined, "an id was taken before the copy");
		const both = continuationMeta({ ...base, copy: { windlassSessionId: "ses_abc", backup: saved }, machineCopy });
		assert(both.pendingCopy === undefined, "a second copy was asked for");
		return "pendingCopy";
	},
);

await check(
	"a continued machine session copies on the machine only where the runner keeps copies and the data is its own",
	async () => {
		const saved = { size: 10, sha256: "f".repeat(64), at: 5 };
		const pending = { from: "s_parent", windlassSessionId: "ses_abc", backup: saved };
		const asked: string[] = [];
		const layerOf = (available: boolean, copy: () => Promise<boolean>) =>
			({
				backups: {
					available: async () => available,
					copy: async (from: { sessionId: string }, to: { sessionId: string }) => {
						asked.push(`${from.sessionId}>${to.sessionId}`);
						return copy();
					},
				},
				sandboxes: { sessionsLiveInSandbox: false, privateSessionData: async () => false },
			}) as unknown as SandboxLayer;
		const machine = { place: { kind: "machine", machineId: "m_1" } as SessionMeta["place"], sessionId: "s_child" };
		const claude = meta({ ...machine, harness: "claude" });
		const ok = async () => true;
		const results = {
			claude: await copyOnMachine(claude, pending, layerOf(true, ok), "box1"),
			oldRunner: await copyOnMachine(claude, pending, layerOf(false, ok), "box1"),
			hosted: await copyOnMachine(
				meta({ harness: "claude", sessionId: "s_child" }),
				pending,
				layerOf(true, ok),
				"box1",
			),
			sharedWindlass: await copyOnMachine(
				meta({ ...machine, harness: "windlass", ownDataSandbox: null }),
				pending,
				layerOf(true, ok),
				"box1",
			),
			ownWindlass: await copyOnMachine(
				meta({ ...machine, harness: "windlass", ownDataSandbox: "box1" }),
				pending,
				layerOf(true, ok),
				"box1",
			),
			missing: await copyOnMachine(
				claude,
				pending,
				layerOf(true, async () => false),
				"box1",
			),
			failing: await copyOnMachine(
				claude,
				pending,
				layerOf(true, async () => Promise.reject(new Error("down"))),
				"box1",
			),
		};
		assert(
			results.claude && results.ownWindlass && !results.oldRunner && !results.hosted && !results.sharedWindlass,
			`results: ${JSON.stringify(results)}`,
		);
		assert(!results.missing && !results.failing, `a failed copy counted: ${JSON.stringify(results)}`);
		assert(
			asked.every(a => a === "s_parent>s_child"),
			`asked ${asked.join(", ")}`,
		);
		return Object.entries(results)
			.map(([k, v]) => `${k}=${v}`)
			.join(" ");
	},
);

process.exit(report.summary(true));
