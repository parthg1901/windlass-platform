/**
 * The mock's work items and API tokens: what the item screens are looked at with, by hand and here. It
 * answers as the server's user actor says it does (contract.ts, `UserActions.listItems` to `revokeApiToken`).
 */
import {
	MAX_API_TOKENS,
	type CheckStatus,
	type ItemSummary,
	type ReviewBlock,
	type ReviewRecord,
	type Verdict,
	type Verified,
	type VerifiedCheck,
} from "@contract";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ITEM_FEED_ENDED, ITEM_PAGE_DEFAULT, ITEM_PAGE_MAX, type ItemCursor, type ItemFeed } from "@contract";
import { type CleanPage, ItemPageProblem, cleanItemPage, itemPage, nextCursor } from "../../../server/src/item-pages";
import type { GateEvidence } from "../../../server/src/factory/types";
import { ciSentence as serverCiSentence, verdictOf, verdictWords } from "../../../server/src/factory/verdict";
import { createMockClient, type MockMachineState } from "./mock";
import {
	REMOVED_MACHINE_ID,
	ciSentence,
	seededVerdicts,
	verdictSaid,
	type MockItemsState,
	type SeedVerdict,
} from "./mock-items";
import { disagrees, partsOf, ReviewBlocks, ReviewText } from "../components/ReviewBlocks";

const auth = {
	token: "mock:user:u_items:ada@example.com",
	profile: { uid: "u_items", email: "ada@example.com", demo: false },
};
const make = (items?: MockItemsState, machine?: MockMachineState) => createMockClient({ pace: 0, items, machine });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

/** What the gate would have recorded for a seeded verdict: the user's checks as listed, and the repository's own beside them. */
function gateOf(seed: SeedVerdict): GateEvidence | null {
	if (seed.gate.state === null) return null;
	const check = (
		name: string,
		whose: VerifiedCheck["whose"],
		status: VerifiedCheck["status"],
		sentBack: number,
	): VerifiedCheck => ({
		name,
		command: `run ${name}`,
		whose,
		status,
		exitCode: status === "passed" ? 0 : 1,
		durationMs: 1000,
		sentBack,
	});
	const checks = [
		...seed.gate.required.map(one => check(one.name, "user", one.status, one.sentBack)),
		...Array.from({ length: seed.repositoryChecks ?? 0 }, (_, index) =>
			check(`own ${index + 1}`, "repository", "passed", 0),
		),
	];
	const ending =
		seed.gate.state === "not_needed"
			? { state: seed.gate.state, unneeded: seed.gate.unneeded! }
			: { state: seed.gate.state };
	const verified: Verified = {
		...ending,
		turn: 1,
		run: checks.length > 0 ? { turn: 1, at: 0, seq: 1, checks } : null,
		unrun: [],
		changedAfter: false,
	};
	return { outcome: seed.gate.state === "stopped" ? "stopped" : "succeeded", verified, flags: seed.flags };
}

describe("the mock's work items", () => {
	it("sends a run's rounds with no caps, and budget questions that never offer to start over", async () => {
		const mock = createMockClient({ pace: 0 });
		const user = mock.user(auth);
		const views = await Promise.all((await user.listItems()).map(item => user.item(item.id)));
		expect(views.some(view => view.run)).toBe(true);
		expect(views.every(view => !view.run || !("caps" in view.run))).toBe(true);
		const budget = views.filter(view => view.question?.kind === "budget");
		expect(budget.length).toBeGreaterThan(0);
		expect(
			budget.every(
				view =>
					view.question!.choices[0]!.label.startsWith("Give it ") &&
					!view.question!.choices.some(choice => choice.id === "retry"),
			),
		).toBe(true);
		mock.dispose();
	});

	it("says in platform info whether the second review is on, and without it gives no item one", async () => {
		const off = createMockClient({ pace: 0, reviewer: false });
		expect((await off.info()).items).toEqual({ reviewer: false, orchestrate: true, screenshots: true });
		const list = await off.user(auth).listItems();
		expect(list.some(item => item.review !== null)).toBe(true);
		expect(list.every(item => item.review === null || item.review.state === "off")).toBe(true);
		off.dispose();
	});

	it("offers work items unless told not to, and without them refuses every item and API token call but the limits", async () => {
		expect((await make().info()).items).toEqual({ reviewer: true, orchestrate: true, screenshots: true });
		const off = make("off");
		expect((await off.info()).items).toBeUndefined();
		const user = off.user(auth);
		const calls = [
			user.listItems(),
			user.item("it_any"),
			user.createItem({ repository: { id: 1 }, title: "A", body: "" }),
			user.actOnItem("it_any", { kind: "cancel" }),
			user.apiTokens(),
			user.createApiToken({ name: "A", scopes: ["items:read"] }),
			user.revokeApiToken("tok_any"),
		];
		for (const call of calls) await expect(call).rejects.toMatchObject({ reason: "items_off" });
		// The ceiling on hosted sandboxes is every agent's, so it is still answered.
		expect((await user.factoryLimits()).hostedRunning).toBeGreaterThan(0);
		off.dispose();
	});

	it("seeds every state, and a wait for every waiting item", async () => {
		const mock = make();
		const list = await mock.user(auth).listItems();
		expect(new Set(list.map(item => item.state))).toEqual(
			new Set(["draft", "queued", "working", "waiting", "review", "done", "failed", "cancelled"]),
		);
		for (const item of list) expect(item.wait !== null).toBe(item.state === "waiting");
		// A question is always a wait for the person, with the question's text.
		for (const item of list.filter(one => one.question))
			expect(item.wait).toMatchObject({
				reason: item.question?.kind === "budget" ? "budget" : "person",
				sentence: item.question?.text,
				retryAt: null,
			});
		expect(new Set(list.flatMap(item => (item.question ? [item.question.kind] : [])))).toEqual(
			new Set([
				"no_change",
				"publish_refused",
				"ci_timeout",
				"rounds",
				"budget",
				"turn_refused",
				"machine_removed",
				"feedback_more",
				"review_question",
				"agent_ask",
				"check_environment",
				"secret_needed",
				"ready_refused",
			]),
		);
		expect(new Set(list.flatMap(item => (item.verdict ? [item.verdict.result] : [])))).toEqual(
			new Set(["pass", "fail", "incomplete", "unverified"]),
		);
		mock.dispose();
	});

	it("answers a builder's request for a secret through its session, as the item's question", async () => {
		const mock = make();
		const user = mock.user(auth);
		const listed = (await user.listItems()).find(item => item.question?.kind === "secret_needed")!;
		const view = await user.item(listed.id);
		const question = view.question!;
		expect(question.secret).toEqual({
			name: "RESEND_API_KEY",
			why: expect.any(String),
			notice: expect.stringContaining("inside the agent's sandbox"),
		});
		expect(question.choices.map(choice => choice.id)).toEqual(["add_secret", "without_secret", "give_up"]);
		const session = mock.session(auth, view.sessionId);
		await expect(
			session.setRequestedSecret({ requestId: "another", name: "RESEND_API_KEY", value: "re_live_5f2c9a81" }),
		).rejects.toMatchObject({ reason: "item_conflict" });
		await session.setRequestedSecret({ requestId: question.id, name: "RESEND_API_KEY", value: "re_live_5f2c9a81" });
		const after = await user.item(listed.id);
		expect(after.question).toBeNull();
		expect(after.state).toBe("working");
		expect(JSON.stringify(after)).not.toContain("re_live_5f2c9a81");
		mock.dispose();
	});

	it("gives each item an agent session of its own, listed with the user's sessions and marked as the item's, as the server does", async () => {
		const mock = make();
		const user = mock.user(auth);
		const items = await user.listItems();
		const sessions = await user.listSessions();
		expect(new Set(items.map(item => item.sessionId)).size).toBe(items.length);
		for (const item of items) {
			const session = sessions.find(one => one.id === item.sessionId);
			const view = await user.item(item.id);
			expect(session?.item).toMatchObject({ id: item.id, role: "builder" });
			if (view.reviewerSessionId) {
				expect(session?.item?.reviewer?.id).toBe(view.reviewerSessionId);
				expect(sessions.some(one => one.id === view.reviewerSessionId)).toBe(false);
				await expect(mock.session(auth, view.reviewerSessionId).prompt({ text: "Hello" })).rejects.toMatchObject({
					reason: "item_session",
				});
			}
			if (item.place.kind === "machine") expect(view.reviewerSessionId).toBeNull();
			expect(session?.title).toBe(item.title);
			expect(session?.repository?.id).toBe(item.repository.id);
			expect(session?.status !== "idle").toBe(view.run?.step.turn === "started" && view.run.step.kind !== "review");
		}
		// The user's own agents are not any item's.
		expect(sessions.filter(session => session.item).length).toBe(items.length);
		expect(sessions.some(session => session.id === "harbor-build" && session.item === undefined)).toBe(true);
		// One filed here is the item's from the start, and is at work once it starts.
		const filed = await user.createItem({
			repository: { id: 7101 },
			mode: "single",
			title: "Log the release's checksum",
			body: "",
			start: true,
		});
		await new Promise(resolve => setTimeout(resolve, 2700));
		expect((await user.listSessions()).find(session => session.id === filed.sessionId)).toMatchObject({
			item: { id: filed.id },
			status: "running",
		});
		mock.dispose();
	});

	it("files Quick with the selected machine agent and Plan first with a Windlass planner", async () => {
		const online = make(undefined, "online");
		const user = online.user(auth);
		const task = { repository: { id: 7101 }, title: "Log the release's checksum", body: "", mode: "single" as const };
		await expect(user.createItem({ ...task, harness: "claude" })).rejects.toMatchObject({
			reason: "harness_signed_out",
		});
		const feature = await user.createItem({
			...task,
			harness: "claude",
			mode: "orchestrate",
			place: { kind: "machine", machineId: "m_nas" },
		});
		expect(feature).toMatchObject({ mode: "orchestrate", agent: { harness: "windlass" } });
		const claude = await user.createItem({
			...task,
			harness: "claude",
			place: { kind: "machine", machineId: "m_nas" },
		});
		expect(claude.agent).toMatchObject({ harness: "claude", tokens: "not_reported", reportedTokens: 0 });
		expect((await user.listSessions()).find(session => session.id === claude.sessionId)).toMatchObject({
			harness: "claude",
			profile: "docker-hardened",
		});
		const windlass = await user.createItem(task);
		expect(windlass.agent).toMatchObject({ harness: "windlass", tokens: "counted" });
		online.dispose();
		const fresh = make(undefined, "fresh");
		const there = { ...task, place: { kind: "machine" as const, machineId: "m_workshop" } };
		await expect(fresh.user(auth).createItem({ ...there, harness: "claude" })).rejects.toMatchObject({
			reason: "harness_signed_out",
		});
		expect((await fresh.user(auth).createItem({ ...there, harness: "opencode" })).agent?.harness).toBe("opencode");
		fresh.dispose();
	});

	it("files an item's effort only where its agent offers it for the item's model", async () => {
		const online = make(undefined, "online");
		const user = online.user(auth);
		const task = { repository: { id: 7101 }, title: "Log the release's checksum", body: "", mode: "single" as const };
		const nas = { kind: "machine" as const, machineId: "m_nas" };
		const windlass = await user.createItem({ ...task, effort: "high" });
		expect(windlass.agent).toMatchObject({ harness: "windlass", effort: "high" });
		expect((await user.createItem(task)).agent?.effort).toBeUndefined();
		await expect(user.createItem({ ...task, effort: "ultra" })).rejects.toMatchObject({ reason: "bad_effort" });
		const claude = await user.createItem({ ...task, harness: "claude", place: nas, model: "opus", effort: "high" });
		expect(claude.agent).toMatchObject({ harness: "claude", model: "opus", effort: "high" });
		await expect(
			user.createItem({ ...task, harness: "claude", place: nas, model: "opus", effort: "ultra" }),
		).rejects.toMatchObject({ reason: "bad_effort" });
		// Claude Code's default model takes no effort here.
		await expect(user.createItem({ ...task, harness: "claude", place: nas, effort: "high" })).rejects.toMatchObject({
			reason: "bad_effort",
		});
		online.dispose();
	});

	it("answers an item's page with its log and verdicts, and refuses one that is not the user's", async () => {
		const mock = make();
		const user = mock.user(auth);
		const twice = (await user.listItems()).find(item => item.title === "Add a health check endpoint") as ItemSummary;
		const view = await user.item(twice.id);
		expect(view.verdicts.map(verdict => verdict.run)).toEqual([1, 2]);
		expect(view.events.some(event => event.step === null && event.said.startsWith("Sent back"))).toBe(true);
		await expect(user.item("it_nothere")).rejects.toMatchObject({ reason: "item_not_found" });
		mock.dispose();
	});

	it("sends a verdict's sentences, as the server does", async () => {
		const mock = make();
		const user = mock.user(auth);
		const views = await Promise.all((await user.listItems()).map(item => user.item(item.id)));
		for (const view of views) {
			// One is stored before verdicts carried their sentences, and has none.
			for (const verdict of view.verdicts)
				if ((verdict as Partial<Verdict>).said) expect(verdict.said.flags).toHaveLength(verdict.flags.length);
		}
		const said = new Set(
			views.flatMap(view =>
				view.verdicts.flatMap(verdict => ((verdict as Partial<Verdict>).said ? [verdict.said.ci] : [])),
			),
		);
		expect(said).toContain("CI passed (3 checks).");
		expect(said).toContain("CI failed: lint.");
		expect(
			[...said].some(line =>
				line.startsWith(
					"CI was not read: GitHub does not let the platform see this repository's checks (“Resource not accessible by integration”).",
				),
			),
		).toBe(true);
		mock.dispose();
	});

	it("words CI in every state as the server does", () => {
		const runs: Verdict["ci"]["runs"] = [
			{ name: "build", app: "github-actions", conclusion: "success", url: "https://github.com/a/b/actions/runs/1" },
			{ name: "lint", app: "github-actions", conclusion: "failure", url: "https://github.com/a/b/actions/runs/2" },
			{ name: "deploy", app: "status", conclusion: "error", url: "https://example.com/deploy" },
		];
		const states: Verdict["ci"][] = [
			{ state: "passed", runs: runs.slice(0, 1), said: null },
			{ state: "passed", runs: [...runs, ...runs], said: null },
			{ state: "failed", runs: [...runs, ...runs], said: null },
			{ state: "not_run", runs: [], said: "The job was not started because recent account payments have failed." },
			{ state: "none", runs: [], said: null },
			{ state: "skipped", runs: runs.slice(0, 1), said: null },
			{ state: "skipped", runs, said: null },
			{ state: "timed_out", runs, said: null },
			{ state: "unread", runs: [], said: null },
			{
				state: "unread",
				runs,
				said: "GitHub listed more checks than the platform reads, and none of those it read failed",
			},
			{ state: "not_permitted", runs: [], said: null },
			{ state: "not_permitted", runs: [], said: "Resource not accessible by integration" },
		];
		for (const ci of states) expect(ciSentence(ci)).toBe(serverCiSentence(ci));
	});

	it("holds every seeded verdict to the server's rule and words: CI decides, and checks are optional", () => {
		const seeded = seededVerdicts();
		for (const seed of seeded) {
			const gate = gateOf(seed);
			const verdict = verdictOf({
				id: "v",
				item: "it",
				run: seed.run,
				head: "0".repeat(40),
				at: 0,
				place: { kind: "hosted" },
				gate,
				ci: seed.ci,
				acceptance: [],
				mergeable: seed.mergeable,
			});
			expect({ result: verdict.result, said: verdictSaid(seed) }).toEqual({
				result: seed.result,
				said: verdictWords(verdict, gate),
			});
		}
		// The cases CI decides, each seeded: no checks and CI passed is ready; checks that passed stand in for CI not read; neither is not verified.
		const words = seeded.map(verdictSaid);
		expect(words).toContain(
			"Ready for review. No checks are set for this repository; CI decides. CI passed (3 checks).",
		);
		expect(words).toContain(
			"Your checks passed; CI has not been read. The 2 checks that applied passed when the agent's turn 1 ended. CI could not be read: GitHub did not answer while the platform waited for it. The pull request's own page shows its CI.",
		);
		expect(words).toContain(
			"Not verified. No checks are set for this repository; CI decides. CI could not be read: GitHub did not answer while the platform waited for it. The pull request's own page shows its CI.",
		);
		expect(words).toContain(
			"Not verified. No checks are set for this repository; CI decides. CI could not be read in full: GitHub listed more checks than the platform reads, and none of those it read failed. The pull request's own page shows its CI.",
		);
		expect(words).toContain(
			"Ready for review. The check that applied passed when the agent's turn 1 ended. CI ran, and nothing in it passed: its 2 checks were skipped, cancelled or neutral.",
		);
		expect(words).toContain(
			"Needs a look. No checks are set for this repository; CI decides. CI passed (3 checks). Test files were deleted or renamed away: test/export-csv.test.ts.",
		);
	});

	it("logs each handed-over verdict in the server's words, and keeps one stored before verdicts had sentences", async () => {
		const mock = make();
		const user = mock.user(auth);
		const views = await Promise.all((await user.listItems()).map(item => user.item(item.id)));
		// The handing over says why there was no second review, where there was none, before the verdict's own line.
		const handoffs = views.flatMap(view =>
			view.events
				.filter(event => event.step?.kind === "handoff" && !event.said.startsWith("No second review: "))
				.map(event => event.said),
		);
		const seeded = seededVerdicts().map(verdictSaid);
		for (const said of handoffs) expect(seeded).toContain(said);
		// The gate's line is the server's: no checks set is pushed for CI, never "published as unverified".
		const lines = views.flatMap(view => view.events.map(event => event.said));
		expect(lines).toContain("No checks are set for this repository: the work is pushed for CI to verify.");
		expect(lines.some(line => line.includes("published as unverified"))).toBe(false);
		mock.dispose();
	});

	it("files an item once per key, starts it, and tells the live feed", async () => {
		const mock = make("none");
		const user = mock.user(auth);
		const seen: ItemFeed[] = [];
		const close = user.watch({ onSessions: () => undefined, onItems: feed => seen.push(feed) });
		await tick();
		const input = {
			mode: "single" as const,
			repository: { id: 7101 },
			title: "Cache the station list",
			body: "Once per run.",
			acceptance: ["Read once."],
			start: true,
			idempotencyKey: "key-1",
		};
		const first = await user.createItem(input);
		const again = await user.createItem(input);
		expect(again.id).toBe(first.id);
		expect(first).toMatchObject({ state: "queued", source: "web", place: { kind: "hosted" } });
		expect(seen.at(-1)?.open.map(item => item.id)).toEqual([first.id]);
		expect(seen.at(-1)?.counts.ended).toBe(0);
		await expect(user.createItem({ ...input, title: "Another" })).rejects.toMatchObject({
			reason: "idempotency_key_reused",
		});
		close();
		mock.dispose();
	});

	it("allows each action only in its state, and says why otherwise", async () => {
		const mock = make();
		const user = mock.user(auth);
		const list = await user.listItems();
		const draft = list.find(item => item.state === "draft") as ItemSummary;
		await expect(user.actOnItem(draft.id, { kind: "retry" })).rejects.toMatchObject({ reason: "item_conflict" });
		expect((await user.actOnItem(draft.id, { kind: "start" })).state).toBe("queued");
		const asking = list.find(item => item.question?.kind === "rounds") as ItemSummary;
		const question = asking.question?.id ?? "";
		expect(
			(await user.actOnItem(asking.id, { kind: "answer", question, choice: "give_up", note: "Not now." })).state,
		).toBe("failed");
		await expect(user.actOnItem(asking.id, { kind: "answer", question, choice: "give_up" })).rejects.toMatchObject({
			reason: "item_conflict",
		});
		const failed = await user.actOnItem(asking.id, { kind: "retry" });
		expect(failed.run?.n).toBe(2);
		mock.dispose();
	});

	it("keeps API tokens up to the limit, and shows a token's value only when it is made", async () => {
		const mock = make("none");
		const user = mock.user(auth);
		expect(await user.apiTokens()).toEqual([]);
		const made = await user.createApiToken({ name: "Script", scopes: ["items:create"] });
		expect(made.secret).toMatch(/^wlp_[0-9a-f]{40}$/);
		expect(JSON.stringify(await user.apiTokens())).not.toContain(made.secret);
		expect(await user.revokeApiToken(made.token.id)).toEqual([]);
		mock.dispose();
		const full = make("full");
		expect(await full.user(auth).apiTokens()).toHaveLength(MAX_API_TOKENS);
		await expect(full.user(auth).createApiToken({ name: "One more", scopes: ["items:read"] })).rejects.toMatchObject({
			reason: "too_many_tokens",
		});
		full.dispose();
	});

	it("seeds items on the user's machines where the deployment offers them, each on a machine that fits it", async () => {
		const mock = make("all", "full");
		const user = mock.user(auth);
		const machines = await user.machines();
		const all = await user.listItems();
		// Every seed is its own item.
		expect(new Set(all.map(item => item.id)).size).toBe(all.length);
		const onMachines = all.filter(item => item.place.kind === "machine");
		const machineOf = ({ place }: ItemSummary) =>
			place.kind === "machine" ? machines.find(one => one.machineId === place.machineId) : undefined;
		const working = onMachines.find(item => item.state === "working") as ItemSummary;
		expect(machineOf(working)?.status).toBe("online");
		// A machine item never spends hosted time.
		for (const item of onMachines) expect(item.spent.hostedSeconds).toBe(0);
		const waiting = onMachines.find(item => item.wait?.reason === "machine") as ItemSummary;
		expect(machineOf(waiting)).toMatchObject({ name: "workshop", status: "offline" });
		expect(waiting.wait?.sentence).toBe('Waiting for your machine "workshop" to come back online.');
		expect(onMachines.find(item => item.question?.kind === "budget")?.question?.text).toBe(
			"Used its 1M-token budget. Give it more to continue.",
		);
		const removed = onMachines.find(item => item.question?.kind === "machine_removed") as ItemSummary;
		expect(removed.place).toEqual({ kind: "machine", machineId: REMOVED_MACHINE_ID });
		expect(machineOf(removed)).toBeUndefined();
		expect(removed.question).toMatchObject({
			text: "Your machine was removed. This item can no longer work on it.",
			choices: [{ id: "hand_over" }, { id: "give_up" }],
		});
		expect(removed.wait).toMatchObject({ reason: "person", retryAt: null });
		mock.dispose();
		// Without machines, every item is hosted; with only an online one, nothing waits for a machine.
		const off = make("all", "off");
		expect((await off.user(auth).listItems()).every(item => item.place.kind === "hosted")).toBe(true);
		off.dispose();
		const online = make("all", "online");
		const kinds = (await online.user(auth).listItems()).filter(item => item.place.kind === "machine");
		expect(kinds.some(item => item.wait?.reason === "machine")).toBe(false);
		expect(kinds.some(item => item.state === "working")).toBe(true);
		online.dispose();
	});

	it("files an item on a machine as the server does: on its first available sandbox, and waiting while the machine is away", async () => {
		const mock = make("none", "full");
		const user = mock.user(auth);
		const input = {
			mode: "single" as const,
			repository: { id: 7101 },
			title: "Cache the station list",
			body: "Once per run.",
			start: true,
		};
		// The sandbox asked for is not the machine's: its first available one is taken.
		const made = await user.createItem({ ...input, place: { kind: "machine", machineId: "m_nas" }, profile: "e2b" });
		expect(made).toMatchObject({ place: { kind: "machine", machineId: "m_nas" }, state: "queued" });
		const session = (await user.listSessions()).find(one => one.id === made.sessionId);
		expect(session).toMatchObject({
			place: { kind: "machine", machineId: "m_nas" },
			profile: "docker-windlass-sandbox",
		});
		await tick();
		expect((await user.item(made.id)).state).toBe("working");
		// Asked for the machine's other sandbox, it is given that one.
		const hardened = await user.createItem({
			...input,
			title: "Hardened",
			place: { kind: "machine", machineId: "m_nas" },
			profile: "docker-hardened",
		});
		expect((await user.listSessions()).find(one => one.id === hardened.sessionId)?.profile).toBe("docker-hardened");
		// An offline machine can be chosen: the item waits for it, in the server's words, and spends nothing.
		const away = await user.createItem({
			...input,
			title: "Away",
			place: { kind: "machine", machineId: "m_workshop" },
		});
		await tick();
		const waiting = await user.item(away.id);
		expect(waiting).toMatchObject({
			state: "waiting",
			wait: { reason: "machine", sentence: 'Waiting for your machine "workshop" to come back online.' },
		});
		expect(waiting.events.at(-1)?.said).toBe('Waiting for your machine "workshop" to come back online.');
		expect(waiting.spent).toEqual({ tokens: 0, rawTokens: 0, turns: 0, activeSeconds: 0, hostedSeconds: 0 });
		// Without a place, it is hosted, as before.
		expect((await user.createItem({ ...input, title: "Hosted" })).place).toEqual({ kind: "hosted" });
		mock.dispose();
	});

	it("refuses a machine an item cannot run on, with the server's reason and sentence", async () => {
		const input = {
			repository: { id: 7101 },
			title: "On a machine",
			body: "",
			place: { kind: "machine" as const, machineId: "m_nas" },
		};
		const cases: Array<[MockMachineState, string, string, string]> = [
			["online", "m_gone", "machine_not_found", "That machine is not in your account."],
			[
				"outdated",
				"m_nas",
				"runner_outdated",
				"Update your runner on “nas” to 0.3.13 or later, then start the agent again.",
			],
			[
				"pairing",
				"m_nas",
				"machine_not_connected",
				'"nas" has not connected yet. Start its runner, and once the Machines page shows it online, start the agent again.',
			],
			["docker", "m_nas", "bad_profile", 'Your machine "nas" offers no available sandbox profile for this item.'],
			["off", "m_nas", "machines_off", "Machines are not available on this platform."],
		];
		for (const [machine, machineId, reason, message] of cases) {
			const mock = make("none", machine);
			const refused = mock.user(auth).createItem({ ...input, place: { kind: "machine", machineId } });
			await expect(refused, machine).rejects.toMatchObject({ reason, message });
			// Nothing was filed.
			expect(await mock.user(auth).listItems()).toEqual([]);
			mock.dispose();
		}
	});

	it("asks the person when an item's machine is removed, and then offers only handing over or giving up", async () => {
		const mock = make("none", "full");
		const user = mock.user(auth);
		const made = await user.createItem({
			repository: { id: 7101 },
			mode: "single",
			title: "On build-box",
			body: "",
			place: { kind: "machine", machineId: "m_build" },
			start: true,
		});
		await tick();
		expect((await user.item(made.id)).state).toBe("working");
		await user.removeMachine({ machineId: "m_build", removeSandboxes: false });
		const asked = await user.item(made.id);
		// Nothing was pushed, so there is nothing to hand over.
		expect(asked).toMatchObject({
			state: "waiting",
			question: {
				kind: "machine_removed",
				text: "Your machine was removed. This item can no longer work on it.",
				choices: [{ id: "give_up" }],
			},
			wait: { reason: "person" },
		});
		expect(asked.events.at(-1)?.said).toBe("Asked: Your machine was removed. This item can no longer work on it.");
		const failed = await user.actOnItem(made.id, {
			kind: "answer",
			question: asked.question?.id ?? "",
			choice: "give_up",
		});
		expect(failed.state).toBe("failed");
		await expect(user.actOnItem(made.id, { kind: "retry" })).rejects.toMatchObject({
			reason: "item_conflict",
			message: "Only an item that failed can be retried.",
		});
		// A draft on a removed machine asks when it is started.
		const draft = await user.createItem({
			repository: { id: 7101 },
			title: "Draft on nas",
			body: "",
			place: { kind: "machine", machineId: "m_nas" },
		});
		await user.removeMachine({ machineId: "m_nas", removeSandboxes: false });
		expect((await user.item(draft.id)).question?.kind).toBe("machine_removed");
		mock.dispose();
	});

	it("fails every read in the failed state", async () => {
		const mock = make("failed");
		await expect(mock.user(auth).listItems()).rejects.toMatchObject({ code: "network" });
		await expect(mock.user(auth).factoryLimits()).rejects.toMatchObject({ code: "network" });
		mock.dispose();
	});
});

describe("the agent's report on an item's page", () => {
	/** The seeded item by its title, with the report's blocks rendered as the page renders them. */
	async function rendered(title: string) {
		const mock = make();
		const user = mock.user(auth);
		const summary = (await user.listItems()).find(item => item.title === title) as ItemSummary;
		const view = await user.item(summary.id);
		mock.dispose();
		const report = view.report;
		if (!report) return { view, html: "" };
		const verdict = view.verdicts.findLast(one => one.head === report.head) ?? null;
		return {
			view,
			html: renderToStaticMarkup(
				createElement(ReviewBlocks, { blocks: report.blocks, records: report.records, verdict, author: "The agent" }),
			),
		};
	}

	it("renders every kind of block as plain text, labelled with its kind, and never as the reviewer's", async () => {
		const { view, html } = await rendered("Drop the legacy export");
		expect(view.report?.by).toBe("builder");
		const kinds: ReviewBlock["kind"][] = ["summary", "text", "finding", "earlier", "risk", "question", "excerpt"];
		for (const kind of kinds) expect(html).toContain(`review-block-${kind}`);
		// A screenshot block is no row of its own: they are gathered under the blocks (Screenshots.test.ts), and without their records nothing is shown.
		const shot = renderToStaticMarkup(
			createElement(ReviewBlocks, {
				blocks: [{ kind: "screenshot", attachment: "a_1" }],
				records: [],
				verdict: null,
				author: "The agent",
			}),
		);
		expect(shot).toMatch(/^<dl id="[^"]+" class="usage-facts item-facts review-blocks"><\/dl>$/);
		for (const out of [html, shot]) {
			expect(out).not.toMatch(/<a[\s>]|<img|<script|<h[1-6]|<strong|<em/);
			expect(out.toLowerCase()).not.toContain("reviewer");
		}
		// A finding's place is `path:line` in the code style; its severity a word.
		expect(html).toContain('<code class="item-paths">src/api/routes.ts:88</code>');
		expect(html).toContain("Should fix");
		// The excerpt numbers its lines from where it starts.
		expect(html).toMatch(/<span class="review-ln"[^>]*>86<\/span>router\.get/);
	});

	it("keeps hostile agent text as typed: no link, image, markup or heading, and a long fence cut at 60 lines", async () => {
		const { view, html } = await rendered("Cache the station list");
		expect(html).toContain("[link](https://e.example)");
		expect(html).toContain("![](https://e.example/a.png)");
		expect(html).toContain("@octocat");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("&lt;img src=&quot;https://e.example/b.png&quot; onerror=&quot;alert(1)&quot;&gt;");
		expect(html).toContain("# Heading");
		expect(html).toContain("**bold**, _emphasis_");
		expect(html).toContain("[another](javascript:alert(1))");
		expect(html).toContain("src/&lt;b&gt;stations&lt;/b&gt;.ts:3");
		expect(html).not.toMatch(/<a[\s>]|<img|<script|<h[1-6]|<strong|<em|<b>/);
		expect(html).not.toMatch(/<[^>]*\shref=/);
		// Each fence shows its first 12 lines, then "Show N more lines": the 40-line one whole behind it, the 70-line one cut at 60 lines and "…".
		const fences = [...html.matchAll(/<pre[^>]*class="output-text"[^>]*>([\s\S]*?)<\/pre>/g)].map(match =>
			(match[1] ?? "").split("\n"),
		);
		expect(fences.map(lines => lines.length)).toEqual([12, 12]);
		expect(html).toContain("Show 28 more lines");
		expect(html).toContain("Show 49 more lines");
		const text = (view.report?.blocks ?? []).map(block => ("text" in block ? block.text : "")).join("\n\n");
		const plain = renderToStaticMarkup(createElement(ReviewText, { text, plain: true }));
		const whole = [...plain.matchAll(/<pre[^>]*><code>([\s\S]*?)<\/code><\/pre>/g)].map(match =>
			(match[1] ?? "").split("\n"),
		);
		expect(whole.map(lines => lines.length)).toEqual([40, 61]);
		expect(whole[1]?.at(-2)).toContain("line 60");
		expect(whole[1]?.at(-1)).toBe("…");
		expect(plain).not.toContain("line 61");
	});

	it("shows the platform's record beside the agent's claim, and marks the claims it does not bear out", async () => {
		const { html } = await rendered("Replace the deprecated glob call");
		const disagreeing = [...html.matchAll(/<li[^>]*data-disagrees[^>]*>([\s\S]*?)<\/li>/g)].map(match =>
			(match[1] ?? "").replace(/<[^>]+>/g, ""),
		);
		expect(disagreeing).toEqual([
			"The agent says it passed; the platform&#x27;s record: CI lint failure.",
			"The agent names ci/7 and says it passed; the platform has no such record.",
		]);
		// The claim the record bears out is shown with it, unmarked.
		expect(html.replace(/<[^>]+>/g, "")).toContain(
			"The platform&#x27;s record: your check lint passed, as the agent says",
		);
	});

	it("reads a claim against a record as the record has it", () => {
		const ci = (conclusion: string): ReviewRecord => ({
			ref: "ci/0",
			kind: "ci",
			name: "test",
			app: "github-actions",
			conclusion,
			url: "https://github.com/a/b/actions/runs/1",
		});
		const check = (status: CheckStatus): ReviewRecord => ({ ref: "check/0", kind: "check", name: "unit", status });
		expect(disagrees("passed", ci("success"))).toBe(false);
		expect(disagrees("passed", ci("failure"))).toBe(true);
		expect(disagrees("passed", ci(""))).toBe(true);
		expect(disagrees("failed", ci("success"))).toBe(true);
		expect(disagrees("ran", ci("not_run"))).toBe(true);
		expect(disagrees("ran", ci("skipped"))).toBe(true);
		expect(disagrees("not_run", ci("failure"))).toBe(true);
		expect(disagrees("ran", check("failed"))).toBe(false);
		expect(disagrees("passed", check("timed_out"))).toBe(true);
		expect(disagrees("not_run", check("could_not_start"))).toBe(false);
		expect(disagrees(undefined, ci("failure"))).toBe(false);
		expect(
			disagrees("passed", {
				ref: "flag/tests_removed",
				kind: "flag",
				flag: { kind: "tests_removed", where: ["a.test.ts"] },
			}),
		).toBe(false);
	});

	it("renders paragraphs, bullets, code spans and fences, and nothing else", () => {
		expect(partsOf("One\nline two\n\n- a `b`\n- c\nAfter\n\n```js\nx()\n```\n# not a heading")).toEqual([
			{ kind: "p", text: "One\nline two" },
			{ kind: "ul", items: ["a `b`", "c"] },
			{ kind: "p", text: "After" },
			{ kind: "pre", lines: ["x()"], cut: 0 },
			{ kind: "p", text: "# not a heading" },
		]);
		const text = "Use `a<b>` here; *not* [this](https://e.example).";
		expect(renderToStaticMarkup(createElement(ReviewText, { text, plain: true }))).toBe(
			'<div class="review-text"><p>Use <code>a&lt;b&gt;</code> here; *not* [this](https://e.example).</p></div>',
		);
		// Unfolded only where asked: a paragraph is otherwise clamped to six lines.
		const folded = renderToStaticMarkup(createElement(ReviewText, { text }));
		expect(folded).toMatch(
			/^<div class="review-text"><div class="long-text"><p id="[^"]+" class="long-text-body" data-clamped="true" style="--lines:6">Use <code>a&lt;b&gt;<\/code> here; \*not\* \[this\]\(https:\/\/e\.example\)\.<\/p><\/div><\/div>$/,
		);
	});

	it("seeds a report of an earlier run, and items in review without one", async () => {
		const { view } = await rendered("Add a health check endpoint");
		expect(view.report?.run).toBe(1);
		expect(view.run?.n).toBe(2);
		const none = await rendered("Make the station parser accept tabs");
		expect(none.view).toMatchObject({ state: "review", report: null });
		const only = await rendered("Log the request id with each error");
		expect(only.view.report?.blocks.map(block => block.kind)).toEqual(["text", "screenshot"]);
	});
});

describe("the screenshots on an item's page", () => {
	async function itemNamed(user: ReturnType<ReturnType<typeof make>["user"]>, title: string) {
		const summary = (await user.listItems()).find(item => item.title === title) as ItemSummary;
		return user.item(summary.id);
	}

	it("seeds a report with each kind: pictures of a page, a tall one, one whose link fails, and some removed", async () => {
		const mock = make();
		const user = mock.user(auth);
		const shown = await itemNamed(user, "Drop the legacy export");
		const shots = shown.report?.screenshots ?? [];
		expect(shots.map(shot => [shot.width, shot.height, shot.shows, shot.state, shot.by])).toEqual([
			[1280, 800, "after", "kept", "builder"],
			[390, 844, "after", "kept", "builder"],
			[1280, 3202, "after", "kept", "builder"],
		]);
		for (const shot of shots) expect(shot.id).toMatch(/^a_[0-9a-f]{16}$/);
		// Each one is named by a screenshot block, after the agent's words, as the server files them.
		expect(shown.report?.blocks.filter(block => block.kind === "screenshot")).toEqual(
			shots.map(shot => ({ kind: "screenshot", attachment: shot.id })),
		);
		const removed = await itemNamed(user, "Document the release checklist");
		expect(removed.report?.screenshots.map(shot => shot.state)).toEqual(["removed", "removed"]);
		mock.dispose();
	});

	it("links the kept ones only, to the fixtures, with a new address on every answer, and refuses an item that is not the user's", async () => {
		const mock = make();
		const user = mock.user(auth);
		const shown = await itemNamed(user, "Drop the legacy export");
		const first = await user.itemAttachmentLinks(shown.id);
		// The builder's, then the second reviewer's: one answer has both.
		expect(first.map(link => link.id)).toEqual(
			[...(shown.report?.screenshots ?? []), ...shown.reviews.flatMap(review => review.screenshots)].map(
				shot => shot.id,
			),
		);
		expect(first.map(link => link.url.replace(/\?.*/, ""))).toEqual([
			"/mock/agents-1280.png",
			"/mock/agents-390.png",
			"/mock/item-full-page.png",
			"/mock/agents-390.png",
			"/mock/item-full-page.png",
		]);
		for (const link of first) expect(link.expiresAt).toBeGreaterThan(Date.now() + 9 * 60_000);
		const again = await user.itemAttachmentLinks(shown.id);
		expect(again.map(link => link.url)).not.toEqual(first.map(link => link.url));
		// The one whose link the store does not answer still gets a link: the page finds out when it loads.
		const failing = await itemNamed(user, "Log the request id with each error");
		const failingLinks = await user.itemAttachmentLinks(failing.id);
		expect(
			failingLinks
				.filter(link => link.id === failing.report?.screenshots[0]?.id)
				.map(link => link.url.replace(/\?.*/, "")),
		).toEqual([`/mock/gone-${failing.report?.screenshots[0]?.id}.png`]);
		const removed = await itemNamed(user, "Document the release checklist");
		expect(await user.itemAttachmentLinks(removed.id)).toEqual([]);
		await expect(user.itemAttachmentLinks("it_any")).rejects.toMatchObject({ reason: "item_not_found" });
		mock.dispose();
		const off = make("off");
		await expect(off.user(auth).itemAttachmentLinks("it_any")).rejects.toMatchObject({ reason: "items_off" });
		off.dispose();
	});
});

it("files an orchestrated feature, edits its budget by version, and lists the children under one feature", async () => {
	const mock = make(),
		user = mock.user(auth);
	try {
		const made = await user.createItem({
			repository: { id: 7101 },
			title: "Find documents",
			body: "Index and search.",
			start: true,
		});
		const page = await user.item(made.id);
		expect(page.mode).toBe("orchestrate");
		const plan = structuredClone(page.plan!);
		expect(plan.status).toBe("proposed");
		plan.subtasks[0]!.budget.tokens -= 1;
		const edit = { kind: "edit_plan" as const, version: plan.version, plan };
		const edited = await user.actOnItem(made.id, edit);
		expect(edited.plan!.version).toBe(plan.version + 1);
		await expect(user.actOnItem(made.id, edit)).rejects.toMatchObject({ reason: "item_conflict" });
		const approved = await user.actOnItem(made.id, { kind: "approve_plan", version: edited.plan!.version });
		expect(approved.children?.[0]?.parent?.itemId).toBe(made.id);
		expect(approved.pullRequest).toBeTruthy();
		const child = await user.item(approved.children![0]!.id);
		expect(child.reviewerSessionId).toBeNull();
		expect(child.review?.state).toBe("off");
		expect(child.pullRequest).toBeNull();
		expect((await user.listItems()).some(i => i.parent)).toBe(false);
		const cancelled = await user.actOnItem(made.id, { kind: "cancel" });
		expect(cancelled.children?.[0]?.state).toBe("cancelled");
	} finally {
		mock.dispose();
	}
});

it("lets a designer exercise the single suggestion and re-plan decisions", async () => {
	const mock = make(),
		user = mock.user(auth);
	try {
		const feature = await user.createItem({
			repository: { id: 7101 },
			title: "Search",
			body: "Make search work.",
			mode: "orchestrate",
			start: true,
		});
		const view = await user.item(feature.id);
		const suggestion = await user.actOnItem(feature.id, {
			kind: "edit_plan",
			version: view.plan!.version,
			plan: { ...view.plan!, subtasks: [], singleSuggested: "One file." },
		});
		expect(suggestion.question?.kind).toBe("single_suggested");
		const split = await user.actOnItem(feature.id, {
			kind: "answer",
			question: suggestion.question!.id,
			choice: "orchestrate_anyway",
		});
		const approved = await user.actOnItem(feature.id, { kind: "approve_plan", version: split.plan!.version });
		await user.actOnItem(feature.id, { kind: "cancel_subtask", key: approved.children![0]!.parent!.key });
		const revision = await user.item(feature.id);
		expect(revision.question?.kind).toBe("replan_approval");
		expect(revision.budget).toEqual(view.budget);
	} finally {
		mock.dispose();
	}
});

describe("a page of work items", () => {
	const item = (id: string, createdAt: number, state: ItemSummary["state"] = "done", repository = 7101): ItemSummary =>
		({ id, createdAt, state, repository: { id: repository }, source: "web" }) as unknown as ItemSummary;
	const page = (raw: unknown) => cleanItemPage(raw) as CleanPage;

	it("is the whole list without one, and refuses what is not a page, in the server's words", async () => {
		expect(cleanItemPage(undefined)).toBeNull();
		expect(cleanItemPage(null)).toBeNull();
		for (const bad of [
			7,
			[],
			{ limit: 0 },
			{ limit: ITEM_PAGE_MAX + 1 },
			{ limit: 2.5 },
			{ before: { createdAt: "1", id: "a" } },
			{ before: { createdAt: 1, id: "" } },
			{ ended: "yes" },
			{ repository: "acme/harbor" },
			{ source: "email" },
		]) {
			expect(() => cleanItemPage(bad), JSON.stringify(bad)).toThrow(ItemPageProblem);
		}
		const mock = make();
		const user = mock.user(auth);
		await expect(user.listItems({ limit: 0 })).rejects.toMatchObject({ reason: "bad_input" });
		expect((await user.listItems()).length).toBeGreaterThan(ITEM_PAGE_DEFAULT);
		mock.dispose();
	});

	it("goes newest filed first, by id between equals, and a cursor never skips or repeats an item that changed", () => {
		const list = [item("a", 10), item("c", 30), item("b", 30), item("d", 20, "working"), item("e", 5, "failed", 7102)];
		const first = itemPage(list, page({ limit: 2 }));
		expect(first.map(one => one.id)).toEqual(["c", "b"]);
		const cursor = nextCursor(first, 2);
		expect(cursor).toEqual({ createdAt: 30, id: "b" });
		// "c" ended meanwhile and "d" was reopened: the next page is what is after "b", whatever changed.
		const second = itemPage(list, page({ limit: 2, before: cursor }));
		expect(second.map(one => one.id)).toEqual(["d", "a"]);
		const third = itemPage(list, page({ limit: 2, before: nextCursor(second, 2) }));
		expect(third.map(one => one.id)).toEqual(["e"]);
		expect(nextCursor(third, 2)).toBeNull();
		// Ended only, open only, one repository, one way of filing.
		expect(itemPage(list, page({ ended: true })).map(one => one.id)).toEqual(["c", "b", "a", "e"]);
		expect(itemPage(list, page({ ended: false })).map(one => one.id)).toEqual(["d"]);
		expect(itemPage(list, page({ ended: true, repository: 7102 })).map(one => one.id)).toEqual(["e"]);
		expect(itemPage(list, page({ source: "api" }))).toEqual([]);
	});

	it("sends the live feed as the server does: every open item, the newest filed ended ones, the counts", async () => {
		const mock = make("many");
		const user = mock.user(auth);
		const all = await user.listItems();
		const isEnded = (one: ItemSummary) => ["done", "failed", "cancelled"].includes(one.state);
		const ended = all.filter(isEnded).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
		expect(ended.length).toBeGreaterThan(ITEM_FEED_ENDED);
		const read = await user.itemFeed();
		expect(read.open.map(one => one.id).sort()).toEqual(
			all
				.filter(one => !isEnded(one))
				.map(one => one.id)
				.sort(),
		);
		expect(read.ended.map(one => one.id)).toEqual(ended.slice(0, ITEM_FEED_ENDED).map(one => one.id));
		// The first page of ended items is what the feed carries.
		expect((await user.listItems({ ended: true })).map(one => one.id)).toEqual(read.ended.map(one => one.id));
		expect(read.counts.ended).toBe(ended.length);
		expect(
			read.counts.byRepository.reduce((sum, row) => sum + row.open + row.done + row.failed + row.cancelled, 0),
		).toBe(all.length);
		// After a change the items event carries a feed, not the whole list.
		const seen: ItemFeed[] = [];
		const close = user.watch({ onSessions: () => undefined, onItems: feed => seen.push(feed) });
		await tick();
		const draft = read.open.find(one => one.state === "draft") as ItemSummary;
		await user.actOnItem(draft.id, { kind: "cancel" });
		const sent = seen.at(-1) as ItemFeed;
		expect(Array.isArray(sent)).toBe(false);
		expect(sent.ended.length).toBe(ITEM_FEED_ENDED);
		expect(sent.counts.ended).toBe(ended.length + 1);
		expect(sent.open.some(one => one.id === draft.id)).toBe(false);
		close();
		mock.dispose();
	});

	it("pages the mock's items as the server does", async () => {
		const mock = make("many");
		const user = mock.user(auth);
		const all = await user.listItems();
		const ended = all
			.filter(one => ["done", "failed", "cancelled"].includes(one.state))
			.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
		const read: string[] = [];
		let before: ItemCursor | null = null;
		for (let guard = 0; guard < 20; guard++) {
			const got = await user.listItems({ ended: true, before, limit: 40 });
			read.push(...got.map(one => one.id));
			before = nextCursor(got, 40);
			if (before === null) break;
		}
		expect(read).toEqual(ended.map(one => one.id));
		mock.dispose();
	});
});
