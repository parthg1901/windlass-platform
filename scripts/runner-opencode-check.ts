import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { importOpenCode, pickProvider } from "../runner/src/opencode-import.js";
Object.assign(globalThis, { SANDBOX_IMAGE: "fixture", SHOTS_IMAGE_PIN: "" });
const { projection } = await import("../runner/src/claude-relay.js");

test("setup reads the mounted file once and separately authorizes Go, Zen and a runner-owned OAuth login", async () => {
	const dir = await mkdtemp(join(process.cwd(), ".import-check-"));
	const file = join(dir, "auth.json");
	const input = JSON.stringify({
		"opencode-go": { type: "api", key: "fixture-go" },
		opencode: { type: "api", key: "fixture-zen" },
		openai: { type: "oauth", refresh: "foreign-refresh", access: "foreign-access" },
	});
	try {
		await writeFile(file, input);
		const prompts: string[] = [],
			keys: unknown[] = [],
			logins: string[] = [];
		const imported = await importOpenCode(
			file,
			async prompt => {
				prompts.push(prompt);
				if (prompts.length === 1) await writeFile(file, "{}");
				return "";
			},
			async (provider, key) => {
				keys.push([provider, key]);
			},
			async id => {
				logins.push(id ?? "");
			},
		);
		assert.equal(imported, true);
		assert.deepEqual(keys, [
			["opencode-go", "fixture-go"],
			["opencode", "fixture-zen"],
		]);
		assert.deepEqual(logins, ["chatgpt"]);
		assert.match(prompts.join(" "), /can't be shared safely; sign in separately for the runner/i);
		assert.doesNotMatch(prompts.join(" "), /foreign-|fixture-/);
		assert.equal(await readFile(file, "utf8"), "{}");
		await writeFile(file, input);
		assert.equal(
			await importOpenCode(
				file,
				async () => "n",
				async () => assert.fail(),
				async () => assert.fail(),
			),
			false,
		);
		await writeFile(file, JSON.stringify({ unsupported: { type: "api", key: "fixture" } }));
		assert.equal(
			await importOpenCode(
				file,
				async () => assert.fail(),
				async () => assert.fail(),
				async () => assert.fail(),
			),
			false,
		);
		await symlink(file, join(dir, "link"));
		await assert.rejects(
			importOpenCode(
				join(dir, "link"),
				async () => "",
				async () => {},
				async () => {},
			),
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an API-shaped subscription entry that also carries refresh material always requires separate sign-in", async () => {
	const dir = await mkdtemp(join(process.cwd(), ".oauth-import-check-"));
	try {
		const file = join(dir, "auth.json");
		await writeFile(
			file,
			JSON.stringify({ openai: { type: "api", key: "subscription-key", refresh_token: "foreign-token" } }),
		);
		const logins: string[] = [];
		assert.equal(
			await importOpenCode(
				file,
				async () => "y",
				async () => assert.fail("A subscription was imported"),
				async id => {
					logins.push(id!);
				},
			),
			true,
		);
		assert.deepEqual(logins, ["chatgpt"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the short picker offers Go and Zen first, searches by name and accepts an exact provider ID", async () => {
	const prompts: string[] = [];
	const replies = ["coding plan", "zai-coding-plan"];
	assert.equal(
		await pickProvider(async p => {
			prompts.push(p);
			return replies.shift()!;
		}),
		"zai-coding-plan",
	);
	assert.ok(prompts[0]!.indexOf("opencode-go") >= 0 && prompts[0]!.indexOf("OpenCode Zen") >= 0);
	assert.match(prompts[1]!, /zai-coding-plan/);
	assert.equal(await pickProvider(async () => "kimi-code-plan-global"), "kimi-code-plan-global");
});

test("the ACP projection enables every selected provider with separate placeholder records and loopback endpoints", () => {
	const ids = [
		"opencode",
		"opencode-go",
		"zai-coding-plan",
		"google",
		"moonshotai",
		"minimax",
		"deepseek",
		"groq",
		"openrouter",
		"zhipuai-coding-plan",
	];
	const env = projection(ids, "fixture-placeholder");
	const value = (key: keyof typeof env) => JSON.parse(env[key]);
	const config = value("OPENCODE_CONFIG_CONTENT");
	assert.deepEqual(config.enabled_providers, ids);
	for (const id of ids) {
		assert.equal(config.provider[id].options.baseURL, "http://127.0.0.1:17892/" + id);
		assert.deepEqual(value("OPENCODE_AUTH_CONTENT")[id], { type: "api", key: "fixture-placeholder" });
	}
});

test("Settings keys replace only matching machine logins in the ACP projection", () => {
	for (const provider of ["openai", "anthropic", "google", "openrouter"]) {
		const env = projection(["chatgpt", "google", "opencode-go"], "machine-placeholder", { [provider]: "turn-key" });
		assert.ok(!Object.hasOwn(env, "WLP_SESSION_BEARER"));
		assert.ok(!Array.isArray(env), "project an env map");
		const auth = JSON.parse(env.OPENCODE_AUTH_CONTENT),
			config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
		assert.deepEqual(auth[provider], { type: "api", key: "turn-key" });
		assert.equal(config.provider[provider].options.baseURL, "http://127.0.0.1:17894/" + provider);
		assert.equal(auth["opencode-go"].key, "machine-placeholder");
		if (provider !== "openai") assert.equal(auth.openai.access, "machine-placeholder");
		if (provider !== "google") assert.equal(auth.google.key, "machine-placeholder");
	}
});

test("free uses the native anonymous model catalog and authenticates only its loopback transport", () => {
	const env = projection("free", "fixture-placeholder");
	const value = (key: keyof typeof env) => JSON.parse(env[key]);
	assert.deepEqual(value("OPENCODE_AUTH_CONTENT"), {});
	assert.deepEqual(value("OPENCODE_CONFIG_CONTENT"), {
		enabled_providers: ["opencode"],
		provider: {
			opencode: {
				options: { baseURL: "http://127.0.0.1:17892/free", headers: { authorization: "Bearer fixture-placeholder" } },
			},
		},
	});
});

test("authenticated reports carry a full provider catalog while other frames retain the control limit", async () => {
	const { MAX_CONTROL_FRAME_BYTES, parseRunnerFrame, validHarnessOptions } = await import(
		"../server/src/runner/control.js"
	);
	const models = Array.from({ length: 1400 }, (_, i) => ({
		id: "openrouter/model-" + i,
		name: "Model " + i,
		efforts: ["low", "high"],
	}));
	const options = {
		models,
		defaultModel: models[1399]!.id,
		modes: [{ id: "plan", name: "Plan", description: null }],
		checkedAt: Date.now(),
	};
	const frame = JSON.stringify({
		kind: "report",
		docker: { ok: true },
		commandSandbox: { ok: true },
		freeDiskBytes: 0,
		sandboxes: [],
		harnesses: [{ id: "opencode", signIn: "token", adapter: "OpenCode", image: "fixture", options }],
	});
	assert.ok(Buffer.byteLength(frame) > MAX_CONTROL_FRAME_BYTES);
	const report = parseRunnerFrame(frame);
	assert.deepEqual(report?.kind === "report" && report.harnesses?.[0]?.options, options);
	assert.equal(parseRunnerFrame(frame, false), null);
	assert.equal(parseRunnerFrame(" ".repeat(MAX_CONTROL_FRAME_BYTES) + '{"kind":"heartbeat"}'), null);
	assert.equal(validHarnessOptions({ ...options, models: [...models, models[0]] }), false);
	assert.equal(
		validHarnessOptions({
			...options,
			models: models.map(m => ({ ...m, id: m.id.padEnd(512, "x"), name: "y".repeat(512) })),
			defaultModel: options.defaultModel.padEnd(512, "x"),
		}),
		false,
	);
});

test("installer capability reports must describe the exact published runner", async () => {
	const { publishedHarnesses } = await import("../server/src/config.js");
	const image = "registry.invalid/runner@sha256:" + "a".repeat(64);
	const report = JSON.stringify({ image, harnesses: ["claude"] });
	assert.deepEqual(publishedHarnesses(image, report), ["claude"]);
	assert.equal(publishedHarnesses(image.replace("aa", "bb"), report), undefined);
	assert.equal(publishedHarnesses(image), undefined);
});

test("one host sample per minute with a 493-model catalog sends only the host delta to a tab", async () => {
	const { DatabaseSync } = await import("node:sqlite");
	const { reportPublisher, optionsDigest } = await import("../server/src/runner/catalog.js");
	const { parseRunnerFrame, ControlQueue } = await import("../server/src/runner/control.js");
	const { machineTables, saveReport } = await import("../server/src/actors/machine.js");
	const {
		machineTables: accountTables,
		publishMachineUpdate,
		listMachines,
	} = await import("../server/src/actors/user-machines.js");
	type Report = import("../server/src/runner/control.js").Report;
	type RawAccess = Parameters<typeof machineTables>[0];
	const sql = new DatabaseSync(":memory:");
	const db = {
		async execute(query: string, ...params: (string | number | null)[]) {
			return sql.prepare(query).all(...params);
		},
		async transaction<T>(work: (tx: RawAccess) => Promise<T>) {
			sql.exec("BEGIN");
			try {
				const result = await work(db);
				sql.exec("COMMIT");
				return result;
			} catch (error) {
				sql.exec("ROLLBACK");
				throw error;
			}
		},
	} as RawAccess;
	const models = Array.from({ length: 493 }, (_, i) => ({
		id: "openrouter/provider/model-" + i,
		name: "Provider Model " + i,
		efforts: ["low", "medium", "high"],
	}));
	const options = { models, modes: [], defaultModel: models[0]!.id, checkedAt: 123456789 };
	const report: Report = {
		kind: "report",
		docker: { ok: true },
		commandSandbox: { ok: true },
		freeDiskBytes: 8e9,
		sandboxes: [],
		host: { cpus: 2, sandboxCpus: 1, memoryBytes: 12e9, memoryFreeBytes: 5e9, load1: 0.5 },
		harnesses: [{ id: "opencode", adapter: "OpenCode", image: "fixture", signIn: "token", options }],
	};
	const machineId = "m_aaaaaaaaaaaaaaaa";
	const facts = { status: "online" as const, since: 1000, runnerVersion: "0.1.0", warnings: [] };
	const events: [string, unknown][] = [];
	const ctx = {
		db,
		vars: { tokenGen: 0, sessions: new Map(), machines: new Map(), github: null },
		key: ["u_fixture"],
		client: () => ({}),
		broadcast(event: string, payload: unknown) {
			events.push([event, payload]);
		},
	};
	try {
		// Persist the pre-upgrade layout, then wake both actors before a runner reconnects.
		sql.exec("CREATE TABLE machine (id INTEGER PRIMARY KEY, name TEXT, report TEXT, removed_at INTEGER)");
		sql.prepare("INSERT INTO machine VALUES (1, 'Workshop', ?, NULL)").run(JSON.stringify(report));
		sql.exec(
			"CREATE TABLE machines (id TEXT PRIMARY KEY, name TEXT, os TEXT, arch TEXT, facts TEXT, send INTEGER DEFAULT 1, expires INTEGER)",
		);
		sql
			.prepare("INSERT INTO machines(id,name,os,arch,facts) VALUES (?, 'Workshop', 'linux', 'arm64', ?)")
			.run(machineId, JSON.stringify({ ...facts, report }));
		await machineTables(db);
		await accountTables(db);
		for (const table of (await import("../server/src/credentials/index.js")).CREDENTIAL_TABLES) sql.exec(table);
		const digest = optionsDigest(options);
		// The machine actor drops an older runner's stored report in its migration (no nested transaction);
		// the runner reports again when it connects.
		assert.equal(sql.prepare("SELECT report FROM machine").get()?.report, null);
		// The reconnecting runner's first full report stores the catalog again.
		await saveReport(db, report, new Map(), 0);
		assert.deepEqual(
			JSON.parse(String(sql.prepare("SELECT options FROM catalogs WHERE digest = ?").get(digest)?.options)),
			options,
		);
		const [machine] = await listMachines(ctx);
		assert.deepEqual(machine!.host, report.host);
		assert.equal(machine!.harnesses![0]!.optionsDigest, digest);
		assert.equal(machine!.harnesses![0]!.options, undefined);
		assert.doesNotMatch(
			String(sql.prepare("SELECT facts FROM machines").get()?.facts),
			/Provider Model|memoryFreeBytes/,
		);
		// A new socket stages each changed catalog before advertising its digest.
		const frames: import("../server/src/runner/control.js").RunnerFrame[] = [];
		const publish = reportPublisher(frame => frames.push(frame));
		publish(report);
		assert.deepEqual(
			frames.map(f => f.kind),
			["catalog", "report"],
		);
		for (const frame of frames) assert.deepEqual(parseRunnerFrame(JSON.stringify(frame)), frame);
		const compact = frames[1] as Report;
		frames.length = 0;
		const host = { ...report.host!, memoryFreeBytes: 4e9, load1: 0.75 };
		publish({ ...report, host });
		assert.deepEqual(frames, [{ kind: "host", host }]);
		const sample = { ...compact, host };
		assert.equal(sample.harnesses![0]!.options, undefined);
		// Neither report format may rewrite an unchanged catalog or inventory.
		sql.exec(
			"CREATE TRIGGER no_catalog_write BEFORE INSERT ON catalogs BEGIN SELECT RAISE(ABORT, 'rewrote catalog'); END",
		);
		sql.exec(
			"CREATE TRIGGER no_report_write BEFORE UPDATE OF report ON machine BEGIN SELECT RAISE(ABORT, 'rewrote inventory'); END",
		);
		const row = await saveReport(db, sample, new Map(), 0);
		assert.ok(row?.report);
		assert.equal(await saveReport(db, { ...report, host }, new Map(), 0), undefined);
		ctx.vars.machines.set(machineId, machine);
		await publishMachineUpdate(ctx, machineId, { ...facts, report: JSON.parse(row.report), host });
		assert.deepEqual(events, [["machineHost", { machineId, host }]]);
		assert.deepEqual((await listMachines(ctx))[0]?.host, host);
		// Serialize identical application-level event envelopes. The old machines event
		// joined the full reported harness to this same machine summary on each sample.
		const before = Buffer.byteLength(JSON.stringify(["machines", [{ ...machine, host, harnesses: report.harnesses }]]));
		const after = Buffer.byteLength(JSON.stringify(events[0]));
		assert.ok(after < 256 && before > 40_000);
		console.log(
			`493 models, one host update/tab/minute: ${before} bytes before, ${after} bytes after (UTF-8 event JSON).`,
		);
		sql.exec("DROP TRIGGER no_catalog_write; DROP TRIGGER no_report_write");
		frames.length = 0;
		const reprobe = { ...options, checkedAt: options.checkedAt + 60_000 };
		publish({ ...report, harnesses: [{ ...report.harnesses![0]!, options: reprobe }] });
		assert.deepEqual(
			frames.map(frame => frame.kind),
			["report"],
		);
		assert.equal((frames[0] as Report).harnesses![0]!.optionsCheckedAt, reprobe.checkedAt);
		assert.equal((frames[0] as Report).harnesses![0]!.optionsDigest, digest);
		frames.length = 0;
		const next = { ...options, defaultModel: models[1]!.id };
		publish({ ...report, harnesses: [{ ...report.harnesses![0]!, options: next }] });
		const [catalog, updated] = frames;
		assert.ok(catalog?.kind === "catalog" && updated?.kind === "report");
		await assert.rejects(saveReport(db, updated, new Map(), 0), /Missing harness catalog/);
		await saveReport(db, updated, new Map([[catalog.id, catalog]]), 0);
		assert.equal(sql.prepare("SELECT digest FROM catalogs").get()?.digest, optionsDigest(next));
		await saveReport(db, { ...report, harnesses: [] }, new Map(), 0);
		assert.equal(sql.prepare("SELECT digest FROM catalogs").get(), undefined);
		const queue = new ControlQueue();
		assert.ok(queue.reserve(1_600_000) && queue.reserve(1_600_000));
		assert.equal(queue.reserve(1_600_000), false);
		queue.release(1_600_000);
		assert.ok(queue.reserve(1_600_000));
	} finally {
		sql.close();
	}
});

test("the self-host env example advertises its pinned runner and documents the release order", async () => {
	const { parseEnv } = await import("node:util");
	const { publishedHarnesses } = await import("../server/src/config.js");
	const read = (name: string) => readFile(new URL("../deploy/selfhost/" + name, import.meta.url), "utf8");
	const { WLP_RUNNER_IMAGE, WLP_RUNNER_CAPABILITIES } = parseEnv(await read(".env.example"));
	assert.match(WLP_RUNNER_IMAGE!, /@sha256:[a-f0-9]{64}$/);
	assert.deepEqual(publishedHarnesses(WLP_RUNNER_IMAGE!, WLP_RUNNER_CAPABILITIES), ["claude", "opencode"]);
	assert.match(
		await read("runner-release.md"),
		/1\. Deploy the server[\s\S]+2\. Publish the runner image[\s\S]+3\. Update `WLP_RUNNER_IMAGE` and `WLP_RUNNER_CAPABILITIES` together/,
	);
});
