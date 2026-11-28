import "./check-secret.js";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { agentSession } from "../server/src/actors/agent-session.js";
import { user } from "../server/src/actors/user.js";
import { workItem } from "../server/src/actors/work-item.js";
import { advance, createItem } from "../server/src/factory/blueprint.js";
import { checkRunPlace } from "../server/src/factory/default-place.js";
import { resolveRun } from "../server/src/factory/resolve-run.js";
import { providerStatuses } from "../server/src/credentials/keys.js";
import { cleanDefaults, readAccountDefaults, readDefaults, saveDefaults } from "../server/src/repository-defaults.js";
import { issueServiceToken } from "../server/src/tokens.js";

assert.ok("db" in user.config);
assert.ok("db" in workItem.config && "createVars" in workItem.config);
assert.ok("createVars" in agentSession.config);
const userSchema = user.config.db;
const { db: itemSchema, createVars: wakeItem } = workItem.config;
const wakeSession = agentSession.config.createVars;

function database(t: TestContext) {
	const sql = new DatabaseSync(":memory:");
	t.after(() => sql.close());
	const execute = async <Row>(query: string, ...args: unknown[]) =>
		sql.prepare(query).all(...(args as SQLInputValue[])) as Row[];
	const db = {
		execute,
		transaction: async <T>(fn: (tx: { execute: typeof execute }) => Promise<T>) => {
			sql.exec("BEGIN");
			try {
				const value = await fn({ execute });
				sql.exec("COMMIT");
				return value;
			} catch (error) {
				sql.exec("ROLLBACK");
				throw error;
			}
		},
	};
	return { sql, db };
}

const machine = { kind: "machine", machineId: "mac" } as const;
const start = { ...machine, profile: "docker-windlass-sandbox" };
const accountSchema =
	"CREATE TABLE account_defaults(id INTEGER PRIMARY KEY CHECK(id=1), profile TEXT, model TEXT, updated_at INTEGER NOT NULL)";
const repoSchema =
	"CREATE TABLE repository_defaults(project TEXT PRIMARY KEY, label TEXT NOT NULL, screenshots INTEGER NOT NULL DEFAULT 0, profile TEXT, model TEXT, updated_at INTEGER NOT NULL)";

test("C1 upgrades defaults across skipped releases, preserving rows and filling missing autonomy fields", async t => {
	const { sql, db } = database(t);
	sql.exec(accountSchema);
	sql.exec(repoSchema);
	sql.exec("ALTER TABLE repository_defaults ADD COLUMN hosted_size TEXT");
	sql.exec("ALTER TABLE repository_defaults ADD COLUMN autoApprovePlans INTEGER NOT NULL DEFAULT 0");
	sql.exec("ALTER TABLE repository_defaults ADD COLUMN autoMergeSingles INTEGER NOT NULL DEFAULT 0");
	sql.exec("INSERT INTO account_defaults VALUES(1,'docker-hardened','filed-model',19)");
	sql.exec("INSERT INTO repository_defaults VALUES('github:1','repo',1,NULL,'repo-model',20,'small',0,1)");
	for (let pass = 0; pass < 2; pass++) {
		await userSchema.onMigrate(db as never);
		const account = await readAccountDefaults(db),
			repo = await readDefaults(db, "github:1");
		assert.deepEqual([account.model, account.profile, account.updatedAt], ["filed-model", "docker-hardened", 19]);
		assert.deepEqual(
			[repo.model, repo.updatedAt, repo.hostedSize, repo.autoMergeSingles, repo.screenshots, repo.waitForCiOnEachPart],
			["repo-model", 20, "small", true, true, undefined],
		);
	}
});

test("C1 rolls the upgrade back if a write fails and succeeds on retry", async t => {
	const { sql, db } = database(t);
	sql.exec(accountSchema);
	sql.exec(repoSchema);
	sql.exec("INSERT INTO account_defaults VALUES(1,NULL,'saved',3)");
	sql.exec(
		"CREATE TRIGGER fail_import BEFORE INSERT ON repository_defaults WHEN NEW.project='account' BEGIN SELECT RAISE(ABORT, 'interrupted'); END",
	);
	await assert.rejects(async () => userSchema.onMigrate(db as never), /interrupted/);
	assert.ok(
		sql
			.prepare("PRAGMA table_info(repository_defaults)")
			.all()
			.some(c => c.name === "model"),
	);
	assert.equal(sql.prepare("SELECT model FROM account_defaults").get()?.model, "saved");
	sql.exec("DROP TRIGGER fail_import");
	await userSchema.onMigrate(db as never);
	assert.equal((await readAccountDefaults(db)).model, "saved");
});

for (const previouslyMigrated of [false, true])
	test(`H9 preserves personal destinations and conflicting choices (settings column ${previouslyMigrated})`, async t => {
		const { sql, db } = database(t);
		for (const [schema, table] of [
			[accountSchema, "account_defaults"],
			[repoSchema, "repository_defaults"],
		]) {
			sql.exec(schema);
			sql.exec(`ALTER TABLE ${table} ADD COLUMN start_place TEXT`);
			sql.exec(`ALTER TABLE ${table} ADD COLUMN item_place TEXT`);
		}
		sql.prepare("INSERT INTO account_defaults(id,updated_at,start_place) VALUES(1,12,?)").run(JSON.stringify(start));
		sql
			.prepare(
				"INSERT INTO repository_defaults(project,label,updated_at,start_place,item_place) VALUES(?, '', 9, ?, ?)",
			)
			.run("github:1", JSON.stringify(start), '{"place":"hosted"}');
		if (previouslyMigrated) {
			sql.exec("ALTER TABLE repository_defaults ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'");
			sql.exec("INSERT INTO repository_defaults(project,label,updated_at) VALUES('account','',12)");
			sql.exec("UPDATE repository_defaults SET settings=item_place WHERE project='github:1'");
		}
		for (let pass = 0; pass < 2; pass++) {
			await userSchema.onMigrate(db as never);
			const account = await readAccountDefaults(db),
				repo = await readDefaults(db, "github:1");
			assert.deepEqual(
				[account.place, account.startPlace, account.machineProfile],
				[{ machine: "mac" }, start, start.profile],
			);
			assert.deepEqual([repo.place, repo.previousStartPlace], ["hosted", start]);
		}
		await saveDefaults(db, "github:1", "", { model: "changed" }, 40);
		assert.deepEqual((await readDefaults(db, "github:1")).previousStartPlace, start);
		const keep = cleanDefaults({ startPlace: { kind: "hosted" } }, [], { models: [] } as never);
		await saveDefaults(db, "github:1", "", keep, 41);
		await userSchema.onMigrate(db as never);
		assert.equal((await readDefaults(db, "github:1")).previousStartPlace, undefined);
	});

test("M10 identifies pre-capability checked keys while keeping their existing model catalogs", async t => {
	const { sql, db } = database(t);
	sql.exec(
		"CREATE TABLE model_provider(provider TEXT PRIMARY KEY,sealed TEXT NOT NULL,generation TEXT NOT NULL,last4 TEXT NOT NULL,added_at INTEGER NOT NULL,checked_at INTEGER,check_ok INTEGER NOT NULL DEFAULT 0,models TEXT)",
	);
	for (const provider of ["openai", "anthropic", "google", "openrouter"])
		sql.prepare("INSERT INTO model_provider VALUES(?, 'fixture', 'g', 'test', 1, 2, 1, ?)").run(provider, '["listed"]');
	await userSchema.onMigrate(db as never);
	const statuses = await providerStatuses(db);
	assert.deepEqual(
		statuses.filter(s => s.needsWindlassCheck).map(s => s.provider),
		["google", "openrouter"],
	);
	assert.ok(statuses.every(s => s.ok && s.models?.[0] === "listed"));
	sql.exec("UPDATE model_provider SET windlass_models='[]' WHERE provider='google'");
	assert.equal((await providerStatuses(db)).find(s => s.provider === "google")?.needsWindlassCheck, undefined);
});

const meta = {
	uid: "owner",
	sessionId: "s_filed",
	createdAt: 1,
	activityAt: 1,
	source: "web",
	repository: { id: 1, name: "repo", owner: "owner", branch: "main" },
	reviewerSessionId: null,
	handoffReview: null,
	verdict: null,
	ledger: { seconds: 0, holds: [] },
};
const task = { title: "Feature", body: "Implement", acceptance: [], base: "main" };
const base = {
	id: "i_filed",
	reviewer: undefined,
	place: machine,
	task,
	budget: { tokens: 10000, hostedSeconds: 600 },
};
const oldPolicy = {
	place: { machine: "mac" },
	placeFallback: "wait",
	harness: "claude",
	machineProfile: "docker-hardened",
};
const auth = { key: ["owner", "i_filed"], conn: { params: { token: issueServiceToken() } } };

async function oldItem(t: TestContext, item: object, metadata: object = meta, session?: object) {
	const { db, sql } = database(t);
	await itemSchema.onMigrate(db as never);
	sql.prepare("INSERT INTO item(id, revision, data) VALUES(1,0,?)").run(JSON.stringify({ item, meta: metadata }));
	let reads = 0;
	const ctx = {
		...auth,
		db,
		client: () => ({
			agentSession: {
				get: () => ({
					internalSummary: async () => {
						reads++;
						assert.ok(session, "a waiting builder has no session");
						return session;
					},
				}),
			},
		}),
	};
	const wake = () => wakeItem(ctx as never, undefined);
	const first = await wake(),
		second = await wake();
	assert.deepEqual(second.stored, JSON.parse(JSON.stringify(first.stored)));
	assert.equal(reads, session ? 1 : 0);
	return { ...ctx, vars: second };
}

test("C2 wakes an old pending builder with its filed policy and asks before choosing an unknown payer", async t => {
	const pendingBuilder = {
		policy: oldPolicy,
		repository: { id: 1 },
		title: task.title,
		mode: "single",
		model: null,
		effort: null,
		machineModel: "opus",
		machineEffort: "high",
		hostedProfile: "e2b",
		hostedSize: "small",
	};
	const item = { ...createItem({ ...base, mode: "single" }), awaitingPlace: "Waiting for the Mac." };
	const c = await oldItem(t, item, { ...meta, defaultPlace: oldPolicy, pendingBuilder });
	const {
		item: loaded,
		meta: { pendingBuilder: job },
	} = c.vars.stored!;
	assert.deepEqual(job!.context, loaded.context);
	const run = resolveRun(job!.context, job!.role);
	assert.deepEqual(
		[job!.role, run.agent, run.model, run.effort, run.profile, run.size, run.place],
		["builder", "claude", "opus", "high", "docker-hardened", "small", oldPolicy.place],
	);
	assert.match(checkRunPlace(run, []).wait!, /payer/);
	const started = advance(loaded, { kind: "start", by: "owner", at: 2 }).item;
	assert.match(started.question!.choices.find(c => c.id === "wait")!.label, /own sign-in/);
	const answer = advance(started, {
		kind: "answer",
		by: "owner",
		question: started.question!.id,
		choice: "wait",
		at: 3,
	});
	assert.equal(answer.item.resolved!.payer, "machine");
	assert.ok(answer.effects.some(e => e.kind === "resolve_default_place"));
});

test("C2 resumes a pre-resolver Plan-first job on its available machine", async t => {
	const pendingBuilder = {
		policy: oldPolicy,
		repository: { id: 1 },
		title: task.title,
		mode: "orchestrate",
		model: "filed-planner",
		effort: "high",
		hostedProfile: null,
	};
	const item = { ...createItem({ ...base, mode: "orchestrate" }), state: "waiting", awaitingPlace: "Offline" };
	const c = await oldItem(t, item, { ...meta, defaultPlace: oldPolicy, pendingBuilder });
	const {
		item: loaded,
		meta: { pendingBuilder: job },
	} = c.vars.stored!;
	const run = resolveRun(job!.context, job!.role);
	const inventory = [
		{
			machineId: "mac",
			name: "Mac",
			status: "online",
			profiles: [{ id: "docker-windlass-sandbox", available: true }],
			warnings: [],
			sandboxes: [],
		},
	];
	const destination = checkRunPlace(run, inventory as never);
	assert.deepEqual(
		[run.agent, run.model, destination.place, destination.profile, destination.wait],
		["windlass", "filed-planner", machine, "docker-windlass-sandbox", undefined],
	);
	const ready = advance(loaded, {
		kind: "default_place_ready",
		at: 3,
		reviewer: { off: "deployment" },
		reviewerSessionId: null,
		place: destination.place,
		agent: { harness: "windlass", model: run.model!, tokens: "counted", reportedTokens: 0, cost: null, fiveHour: null },
	});
	assert.equal(ready.item.awaitingPlace, undefined);
	assert.equal(ready.item.run?.step.kind, "refine");
});

test("C2 recovers the bound planner and the approved route for an already queued part", async t => {
	const part = {
		key: "build",
		title: "Build",
		brief: "Implement",
		acceptance: [],
		dependsOn: [],
		budget: { tokens: 200 },
		place: { prefer: "Old display name", reason: "Approved" },
	};
	const plan = { status: "approved", version: 1, subtasks: [part], questions: [], spec: "Approved" };
	const route = { preferred: { kind: "machine", machineId: "other-id" }, alternatives: [] };
	const item = {
		...createItem({ ...base, mode: "orchestrate", agent: { harness: "windlass", model: "filed", effort: "high" } }),
		featurePlan: plan,
		approvedPlan: plan,
		routes: { build: route },
		state: "waiting",
		run: { n: 1, step: { n: 2, kind: "subtasks", attempt: 1 } },
		jobs: [{ id: "child", state: "draft", task: part, route }],
	};
	const c = await oldItem(
		t,
		item,
		{ ...meta, defaultPlace: oldPolicy },
		{ place: machine, harness: "windlass", model: "bound-model", profile: "docker-windlass-sandbox" },
	);
	const stored = c.vars.stored!.item;
	assert.equal(resolveRun(stored.context!, "planner").model, "bound-model");
	const request = await workItem.config.actions!.internalChildRequest(c as never, "child");
	assert.ok(request);
	const resolved = request.job.task.resolved!;
	assert.deepEqual(
		[resolved.place, resolved.agent, resolved.model, resolved.effort],
		[{ machine: "other-id" }, "windlass", "bound-model", "high"],
	);
	assert.deepEqual(stored.approvedPlan!.subtasks[0]!.resolved, resolved);
	assert.deepEqual(stored.featurePlan!.subtasks[0]!.resolved, resolved);
});

test("M13 renders both retired reviewer reasons from stored top-level items", async t => {
	for (const [off, text] of [
		["machine", /hosted sandboxes/],
		["profile", /commands.*network/],
	] as const) {
		const item = { ...createItem({ ...base, mode: "single" }), reviewer: { off } };
		const c = await oldItem(t, item);
		const view = await workItem.config.actions!.internalView(c as never);
		assert.match(view.reviewNone!, text);
	}
});

test("H2 loads pre-payer origins with the payer they were filed with", async t => {
	const { sql, db } = database(t);
	sql.exec("CREATE TABLE meta(id INTEGER PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE timeline(seq INTEGER)");
	const ctx = { db, client: () => ({ user: { get: () => ({}) } }) };
	async function load(harness: string, fields: object) {
		const origin = { kind: "item", itemId: "i_filed", role: "builder", ...fields };
		sql
			.prepare("INSERT OR REPLACE INTO meta VALUES(1,?)")
			.run(JSON.stringify({ uid: "owner", place: machine, harness, origin }));
		return (await wakeSession(ctx as never, undefined)).meta!;
	}
	for (const signIn of ["subscription", "chatgpt"])
		assert.equal((await load(signIn === "chatgpt" ? "codex" : "claude", { signIn })).origin?.payer, "machine");
	assert.equal((await load("claude", { filedWithKey: true, signIn: "api-key" })).origin?.payer, "key");
	assert.equal((await load("opencode", {})).origin?.payer, undefined);
	assert.equal((await load("codex", { signIn: "api-key" })).origin?.payer, undefined);
});
