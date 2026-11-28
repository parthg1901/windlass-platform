import "./check-secret.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import { format } from "node:util";
import {
	accountFor,
	limitedAccounts,
	PROVIDER_TABLE,
	providerAccounts,
	recordProviderUsage,
} from "../server/src/actors/provider-accounts.js";
import { recordTurnTokens, TOKEN_USAGE_TABLE, tokensOn } from "../server/src/usage.js";
import {
	availableCatalog,
	hostedCatalog,
	listedHarness,
	selectedKey,
	withSettingsKeys,
} from "../server/src/sandbox/harnesses.js";
import { modelKeyCaller } from "../server/src/actors/internal.js";
import { MODEL_PROVIDERS, validModelKey, type MachineSummary, type ModelProvider } from "../server/src/contract.js";
import { modelProviderActions as actions } from "../server/src/credentials/keys.js";
import { CREDENTIAL_TABLES, credentialActions as credentials } from "../server/src/credentials/index.js";
import { openCredentialTransit } from "../server/src/credentials/transit.js";
import type { DefaultsDb } from "../server/src/repository-defaults.js";
import { createSealer, serverSealer } from "../server/src/signin/seal.js";
import { issueServiceToken, issueUserToken } from "../server/src/tokens.js";

const hex = () => randomBytes(32).toString("hex");
const makeKeys = () => ({
	openai: "sk-proj-" + hex(),
	anthropic: "sk-ant-api03-" + hex(),
	google: "AIza" + hex().slice(0, 35),
	openrouter: "sk-or-v1-" + hex(),
});

function account(uid: string) {
	const sql = new DatabaseSync(":memory:");
	for (const table of CREDENTIAL_TABLES) sql.exec(table);
	const db: DefaultsDb = {
		async execute<Row>(query: string, ...args: unknown[]) {
			return sql.prepare(query).all(...(args as SQLInputValue[])) as Row[];
		},
	};
	const profile = { uid, email: null, demo: false };
	const context = { db, key: [uid], vars: { tokenGen: 0 }, conn: { params: { token: issueUserToken(profile, 0) } } };
	return {
		sql,
		context,
		internal: { ...context, conn: { params: { token: issueServiceToken(modelKeyCaller(uid)) } } },
	};
}

test("model provider actions keep keys sealed and check with the provider", async t => {
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const keys = makeKeys(),
		bad = makeKeys();
	const secrets = [...Object.values(keys), ...Object.values(bad)];
	function hasSecret(value: unknown) {
		const text = format("%o", value);
		return secrets.some(key => text.includes(key) || text.includes(key.slice(-12)));
	}
	const clean = (value: unknown) => assert.ok(!hasSecret(value), "credential in answer, storage or error");
	let loggedSecret = false;
	for (const method of ["debug", "info", "log", "warn", "error"] as const)
		t.mock.method(console, method, (...args: unknown[]) => {
			loggedSecret ||= hasSecret(args);
		});
	const oldRoot = { id: "old", secret: Buffer.from(hex()) };
	process.env.WLP_SIGNIN_KEYS = `current:${hex()},old:${oldRoot.secret}`;
	const old = createSealer([oldRoot]);
	const a = account("model-check-a"),
		b = account("model-check-b");
	t.after(() => {
		a.sql.close();
		b.sql.close();
	});
	const c = a.context;
	const paths = {
		openai: "/v1/models",
		anthropic: "/v1/models",
		google: "/v1beta/models",
		openrouter: "/api/v1/models",
	};
	let mode: "normal" | "redirect" | "hold" | "timeout" = "normal";
	let requests = 0,
		followed = false;
	const gate = new EventEmitter();
	const server = createServer(async (req, res) => {
		requests++;
		if (req.url === "/redirected") {
			followed = true;
			res.end();
			return;
		}
		const provider = MODEL_PROVIDERS.find(p => req.url?.startsWith("/" + p + "/"));
		assert.ok(provider);
		const path = req.url!.slice(provider.length + 1);
		const metadata = provider === "openrouter" && path === "/api/v1/key";
		assert.ok(req.method === "GET" && (metadata || path === paths[provider]), "wrong method or path");
		const key =
			provider === "google"
				? req.headers["x-goog-api-key"]
				: provider === "anthropic"
					? req.headers["x-api-key"]
					: req.headers.authorization?.replace(/^Bearer /, "");
		if (provider === "openai" || provider === "openrouter") assert.ok(req.headers.authorization?.startsWith("Bearer "));
		if (provider === "openrouter" && !metadata) assert.ok(key === keys.openrouter);
		if (provider === "anthropic") assert.equal(req.headers["anthropic-version"], "2023-06-01");
		if (key !== keys[provider] && (provider !== "openrouter" || metadata)) {
			res.writeHead(401, "Rejected " + key).end(JSON.stringify({ error: key }));
			return;
		}
		if (mode === "redirect") {
			res.writeHead(307, { location: "/redirected" }).end();
			return;
		}
		if (mode === "timeout") return;
		if (mode === "hold") {
			gate.emit("started");
			await once(gate, "release");
		}
		const ids = ["demo-model", String(key), String(key).slice(-12), ...Array.from({ length: 45 }, (_, i) => "m" + i)];
		res.end(
			JSON.stringify(
				metadata
					? { data: { label: key } }
					: provider === "google"
						? {
								models: [
									{ name: "models/gemini-embedding", supportedGenerationMethods: ["embedContent"] },
									{ name: "models/gemini-flash-image", supportedGenerationMethods: ["generateContent"] },
									...ids.map(id => ({ name: "models/" + id, supportedGenerationMethods: ["generateContent"] })),
									{ name: "models/gemini-flash", supportedGenerationMethods: ["generateContent"] },
								],
							}
						: {
								data: ids.map(id => ({
									id,
									description: key,
									supported_parameters: id === "demo-model" ? [] : ["tools"],
								})),
							},
			),
		);
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	for (const provider of MODEL_PROVIDERS)
		process.env[`WLP_${provider.toUpperCase()}_BASE_URL`] =
			`http://127.0.0.1:${(server.address() as AddressInfo).port}/${provider}`;

	const save = (provider: ModelProvider, key: string) => actions.saveModelProvider(c, { provider, key });
	const nonce = hex();
	await assert.rejects(credentials.internalCredentialGeneration(c, { provider: "openai" }), /internal/);
	await assert.rejects(credentials.internalCredential(c, { provider: "openai" }, nonce), /internal/);
	for (const token of [issueServiceToken(), b.internal.conn.params.token]) {
		await assert.rejects(
			credentials.internalCredential({ ...c, conn: { params: { token } } }, { provider: "openai" }, nonce),
			/internal/,
		);
	}
	for (const call of [
		() => actions.modelProviders(a.internal),
		() => actions.checkModelProvider(a.internal, "google"),
		() => actions.removeModelProvider(a.internal, "google"),
		() => actions.saveModelProvider(a.internal, { provider: "google", key: keys.google }),
	])
		await assert.rejects(call, /for users/);
	for (const provider of MODEL_PROVIDERS) {
		const wrong = provider === "openai" ? keys.anthropic : keys.openai;
		await assert.rejects(save(provider, wrong), err => {
			clean(err);
			return err instanceof Error && err.message.includes("format");
		});
		// Anthropic issues more than the apiNN- shape; the check call decides, not the prefix.
		if (provider === "anthropic") assert.ok(validModelKey(provider, "sk-ant-xyz-a-" + "b".repeat(40)));
		// A Claude plan's setup token is not an API key: it is connected as a plan.
		if (provider === "anthropic") assert.ok(!validModelKey(provider, "sk-ant-oat01-" + "b".repeat(40)));
		const saved = await save(provider, keys[provider]);
		clean(saved);
		assert.equal(saved.last4, keys[provider].slice(-4));
		assert.ok(saved.ok && saved.checkedAt! >= saved.addedAt && saved.models?.length === 32);
		assert.equal(saved.models[0], provider === "google" ? "gemini-embedding" : "demo-model");
		if (provider === "google" || provider === "openrouter") {
			const offered = hostedCatalog("windlass", [saved])!.models.map(m => m.id);
			if (provider === "google") assert.deepEqual(offered, ["default", "google/gemini-flash"]);
			else assert.ok(offered.includes("openrouter/m0"));
			assert.ok(!offered.includes(provider + "/demo-model"));
			assert.ok(hostedCatalog("opencode", [saved])!.models.some(m => m.id === provider + "/demo-model"));
		}
		const checked = await actions.checkModelProvider(c, provider);
		clean(checked);
		assert.ok(checked.ok);
		clean(await actions.modelProviders(c));
		clean(await c.db.execute("SELECT * FROM model_provider"));
		const failed = await save(provider, bad[provider]);
		clean(failed);
		assert.ok(!failed.ok && failed.message?.includes("check the key") && !failed.models);
		assert.deepEqual(await actions.modelProviders(c), [checked]);
		await actions.removeModelProvider(c, provider);
		assert.equal(await credentials.internalCredential(a.internal, { provider }, nonce), null);
	}
	assert.deepEqual(await actions.modelProviders(c), []);

	const before = requests;
	for (const call of [() => save("google", keys.google), () => actions.checkModelProvider(c, "openai")]) {
		await assert.rejects(call, err => {
			clean(err);
			return err instanceof Error && err.message.includes("next minute");
		});
	}
	assert.equal(requests, before);
	assert.ok((await actions.saveModelProvider(b.context, { provider: "openai", key: keys.openai })).ok);
	now += 60_000;
	a.internal.conn.params.token = issueServiceToken(modelKeyCaller(c.key[0]));
	await save("openai", keys.openai);

	const owner = JSON.stringify([c.key[0], "openai"]);
	const oldBlob = old.seal("model-key", owner, keys.openai);
	a.sql.prepare("UPDATE model_provider SET sealed = ? WHERE provider = 'openai'").run(oldBlob);
	const sealed = await credentials.internalCredential(a.internal, { provider: "openai" }, nonce);
	assert.ok(sealed);
	clean(sealed);
	now += 59_999;
	const payload = openCredentialTransit(c.key[0], { provider: "openai" }, nonce, sealed);
	const [row] = await c.db.execute<{ sealed: string; generation: string }>(
		"SELECT sealed, generation FROM model_provider WHERE provider = 'openai'",
	);
	assert.equal(await credentials.internalCredentialGeneration(a.internal, { provider: "openai" }), row.generation);
	assert.ok(
		serverSealer().isCurrent(row.sealed) && payload.secret === keys.openai && payload.generation === row.generation,
	);
	assert.ok(serverSealer().open("model-key", owner, row.sealed) === keys.openai);
	for (const subject of [JSON.stringify([b.context.key[0], "openai"]), JSON.stringify([c.key[0], "google"])]) {
		assert.throws(() => serverSealer().open("model-key", subject, row.sealed));
	}
	assert.throws(() => serverSealer().open("secret", owner, row.sealed));
	assert.throws(() => openCredentialTransit(c.key[0], { provider: "openai" }, hex(), sealed));
	assert.throws(() => openCredentialTransit(b.context.key[0], { provider: "openai" }, nonce, sealed));
	assert.throws(() => openCredentialTransit(c.key[0], { provider: "google" }, nonce, sealed));
	now++;
	assert.throws(() => openCredentialTransit(c.key[0], { provider: "openai" }, nonce, sealed), /expired/);

	mode = "hold";
	const started = once(gate, "started");
	const checking = actions.checkModelProvider(c, "openai");
	await started;
	await actions.removeModelProvider(c, "openai");
	mode = "normal";
	await save("openai", keys.openai);
	gate.emit("release");
	await assert.rejects(checking, /changed during the check/);

	mode = "redirect";
	const redirected = await actions.checkModelProvider(c, "openai");
	assert.ok(!redirected.ok && !followed);
	mode = "timeout";
	const timedOut = await actions.checkModelProvider(c, "openai");
	clean(timedOut);
	assert.ok(!timedOut.ok && timedOut.message);
	const fetch = t.mock.method(globalThis, "fetch", () => {
		throw new Error("unexpected provider request");
	});
	for (const url of ["http://example.test", "http://localhost.example.test", "ftp://127.0.0.1"]) {
		process.env.WLP_OPENAI_BASE_URL = url;
		assert.equal((await actions.checkModelProvider(c, "openai")).ok, false);
	}
	assert.equal(fetch.mock.callCount(), 0);
	assert.ok(!loggedSecret, "credential in logs");
});

test("Settings key usage and refusals follow the provider and key generation across machines", async t => {
	const { sql, context } = account("usage");
	t.after(() => sql.close());
	sql.exec(PROVIDER_TABLE);
	sql.exec(TOKEN_USAGE_TABLE);
	sql.exec(
		"INSERT INTO model_provider(provider,generation,sealed,last4,added_at) VALUES ('openai','first','','1234',1)",
	);
	type Db = Parameters<typeof recordProviderUsage>[0];
	const db = { ...context.db, transaction: async <T>(work: (tx: Db) => Promise<T>) => work(db) } as Db;
	const at = Date.now();
	const key = { provider: "openai" as const, generation: "first" };
	const receipt = { key, seq: 1, tokens: 12, at };
	assert.ok(await recordTurnTokens(db, "session", receipt));
	assert.equal(await recordTurnTokens(db, "session", receipt), false);
	const location = { place: "machine-a", harness: "codex" as const, provider: key.provider };
	const other = { place: "machine-b", harness: "opencode" as const, provider: key.provider };
	const refused = { kind: "refusal" as const, at, resetsAt: at + 60_000 };
	assert.ok(await recordProviderUsage(db, location, "first", refused));
	const accounts = await providerAccounts(db, at);
	assert.equal(accountFor(accounts, other)?.state, "limited");
	assert.equal(accountFor(accounts, { ...other, provider: "anthropic" }), undefined);
	assert.equal(accountFor(accounts, { place: location.place, harness: location.harness }), undefined);
	sql.exec("UPDATE model_provider SET generation='second'");
	assert.equal(await recordProviderUsage(db, location, "first", refused), false);
	assert.equal(accountFor(await providerAccounts(db, at), other), undefined);
	await recordTurnTokens(db, "session", { ...receipt, seq: 2, tokens: 9, key: { ...key, generation: "second" } });
	assert.deepEqual(
		sql
			.prepare("SELECT generation, SUM(tokens) FROM model_key_usage GROUP BY generation")
			.all()
			.map(row => Object.values(row)),
		[
			["first", 12],
			["second", 9],
		],
	);
	assert.equal(await tokensOn(db, at), 0);
});

test("a Settings change retries a waiting subtask even while its former account is limited", async () => {
	const { notifyProviderWaits } = await import("../server/src/actors/user-items.js");
	const { sql, context } = account("owner");
	sql.exec(PROVIDER_TABLE);
	const location = { harness: "opencode" as const, place: "desk", provider: "google" as const };
	sql.exec(
		"INSERT INTO model_provider(provider,sealed,generation,last4,added_at) VALUES ('google','sealed','old','1234',1)",
	);
	const key = "settings/google/old";
	const until = Date.now() + 60_000;
	sql.prepare("INSERT INTO provider_usage VALUES (?,?,?,?)").run(
		"settings",
		"google",
		"old",
		JSON.stringify({
			backoff: 0,
			lastRefusal: Date.now(),
			lastSuccess: -1,
			account: { ...location, key, state: "limited", limitedUntil: until, windows: [] },
		}),
	);
	const retries: number[] = [];
	const item = {
		id: "feature",
		revision: 4,
		step: { kind: "subtasks" },
		wait: { reason: "provider", accountKey: key },
	};
	const ctx = {
		...context,
		vars: { sessions: new Map() },
		client: () => ({
			workItem: { get: () => ({ internalProviderChanged: async (revision: number) => retries.push(revision) }) },
		}),
	};
	await notifyProviderWaits(ctx as never, [item] as never, "settings");
	assert.deepEqual(retries, [4]);
	sql.close();
});

test("machine readiness and the OpenCode model menu use the owner's available providers", async () => {
	const { parseRunnerFrame, reportFor } = await import("../server/src/runner/control.js");
	const h = {
		id: "opencode" as const,
		signIn: "token" as const,
		adapter: "fixture",
		image: "fixture",
		keyRelay: true as const,
		machineProviders: ["free"],
	};
	const report = {
		kind: "report" as const,
		commandSandbox: { ok: true as const },
		docker: { ok: true as const },
		freeDiskBytes: null,
		sandboxes: [],
		harnesses: [h],
	};
	assert.deepEqual(parseRunnerFrame(JSON.stringify(reportFor(report, ["harness-key-relay"]))), report);
	const legacy = reportFor(report, ["model-relay"]);
	assert.ok(!("keyRelay" in legacy.harnesses[0]!) && !("machineProviders" in legacy.harnesses[0]!));
	assert.deepEqual(parseRunnerFrame(JSON.stringify(legacy)), legacy);
	const entry = {
		id: "opencode" as const,
		signIn: "none" as const,
		keyRelay: true as const,
		machineProviders: ["chatgpt"],
	};
	const saved = ["google" as const];
	const effective = withSettingsKeys(entry, saved);
	assert.equal(withSettingsKeys({ ...entry, keyRelay: undefined }, saved).signIn, "none");
	assert.equal(
		withSettingsKeys({ ...entry, keyRelay: undefined, signIn: "token", method: undefined }, saved).method,
		undefined,
	);
	assert.equal(effective.signIn, "token");
	assert.equal(withSettingsKeys(entry, saved, "anthropic/claude").signIn, "none");
	assert.equal(selectedKey("opencode", "google/gemini", saved), "google");
	const models = ["anthropic/claude", "google/gemini", "openai/gpt"].map(id => ({ id, name: id, efforts: [] }));
	const catalog = availableCatalog({ models, defaultModel: models[0]!.id, modes: [], checkedAt: 1 }, effective);
	assert.deepEqual(
		catalog?.models.map(m => m.id),
		["default", "google/gemini", "openai/gpt"],
	);
	const unchecked = listedHarness({ ...entry, signIn: "unknown" }, saved);
	assert.deepEqual(
		availableCatalog({ models, defaultModel: "default", modes: [], checkedAt: 1 }, unchecked)?.models.map(m => m.id),
		["default", "google/gemini"],
	);
	assert.equal(catalog?.defaultModel, "default");
	assert.equal(
		withSettingsKeys({ keyRelay: true, id: "claude", signIn: "token", method: undefined }, []).method,
		"subscription",
	);
	assert.equal(
		withSettingsKeys({ keyRelay: true, id: "claude", signIn: "token", method: undefined }, ["anthropic"]).method,
		"api-key",
	);
	assert.equal(withSettingsKeys({ id: "codex", signIn: "none" }, ["google"]).signIn, "none");
	// The Machines page. Claude Code's own login kept on the machine wins there, over the plan and the key.
	const claude = { keyRelay: true as const, id: "claude" as const, signIn: "token" as const };
	assert.deepEqual(listedHarness(claude, ["anthropic"], ["anthropic"]), {
		...claude,
		method: "subscription",
		machineSignIns: ["anthropic"],
	});
	// With no login of its own, Pay with decides: the plan's method first, the key's otherwise, and nothing to pay for.
	const signedOut = { ...claude, signIn: "none" as const };
	assert.deepEqual(listedHarness(signedOut, ["anthropic"], ["anthropic"]), {
		...signedOut,
		signIn: "token",
		method: "subscription",
		platformKeys: ["anthropic"],
		paysWith: true,
	});
	assert.deepEqual(listedHarness(signedOut, ["anthropic"]), {
		...signedOut,
		signIn: "token",
		method: "api-key",
		platformKeys: ["anthropic"],
		paysWith: true,
	});
	assert.deepEqual(listedHarness(signedOut, [], ["openai"]), { ...signedOut, paysWith: true });
	// Codex keeps no login on a machine: the ChatGPT plan pays for it there, with no login present.
	const codex = { keyRelay: true as const, id: "codex" as const, signIn: "none" as const };
	assert.deepEqual(listedHarness(codex, [], ["openai"]), {
		...codex,
		signIn: "token",
		method: "chatgpt",
		paysWith: true,
	});
	assert.equal(listedHarness({ ...codex, signIn: "unknown" }, ["openai"]).method, "api-key");
	// OpenCode pays with its own logins on the machine, and a key for each provider it has none for.
	const opencode = {
		keyRelay: true as const,
		id: "opencode" as const,
		signIn: "token" as const,
		machineProviders: ["chatgpt", "free"],
	};
	assert.deepEqual(listedHarness(opencode, ["openai"], ["openai"]).platformKeys, undefined);
	assert.deepEqual(listedHarness(opencode, ["openai", "google"]).platformKeys, ["google"]);
	assert.deepEqual(listedHarness(opencode, ["openai", "google"]).machineSignIns, ["openai"]);
	assert.equal(listedHarness(opencode, ["google"], ["openai"]).paysWith, undefined, "no plan pays for OpenCode");
	// A runner without a key relay relays no key.
	assert.equal(listedHarness({ ...signedOut, keyRelay: undefined }, ["anthropic"]).platformKeys, undefined);
});

test("what pays on a machine: Pay with, unless Claude Code's own login is kept there", async t => {
	const { listMachines, machineTables } = await import("../server/src/actors/user-machines.js");
	const { config } = await import("../server/src/config.js");
	const before = config.machines;
	config.machines = { runnerImage: null, publicUrl: "http://localhost" };
	t.after(() => {
		config.machines = before;
	});
	const { sql, context } = account("owner");
	t.after(() => sql.close());
	// The per-machine "Paid by" choice of before is dropped with its table.
	sql.exec("CREATE TABLE credential_sources (machine TEXT, harness TEXT, source TEXT)");
	await machineTables(context.db as never);
	assert.equal(sql.prepare("SELECT name FROM sqlite_master WHERE name = 'credential_sources'").get(), undefined);
	const machineWith = (claude: "token" | "none") => {
		const report = {
			docker: { ok: true },
			commandSandbox: { ok: true },
			sandboxes: [],
			freeDiskBytes: 8e9,
			harnesses: [{ id: "claude", signIn: claude, keyRelay: true, adapter: "fixture", image: "fixture" }],
		};
		sql.exec("DELETE FROM machines");
		sql
			.prepare("INSERT INTO machines(id,name,os,arch,facts) VALUES ('desk','Desk','linux','x64',?)")
			.run(JSON.stringify({ report, status: "online" }));
	};
	machineWith("none");
	sql.exec(
		"INSERT INTO model_provider(provider,generation,sealed,last4,added_at,check_ok) VALUES ('anthropic','first','fixture','1234',1,1)",
	);
	const until = Date.now() + 60_000;
	const usage = {
		backoff: 0,
		lastRefusal: Date.now(),
		lastSuccess: -1,
		account: {
			key: "settings/anthropic/first",
			harness: "claude",
			provider: "anthropic",
			state: "limited",
			limitedUntil: until,
			windows: [],
		},
	};
	sql.prepare("INSERT INTO provider_usage VALUES ('settings','anthropic','first',?)").run(JSON.stringify(usage));
	const ctx = { ...context, vars: { ...context.vars, sessions: new Map() } };
	const { plannerMachines } = await import("../server/src/machines/details.js");
	const { choosePlacement } = await import("../server/src/factory/placement.js");
	const place = async (machine: MachineSummary) =>
		choosePlacement(
			{
				key: "part",
				title: "Part",
				brief: "",
				acceptance: [],
				dependsOn: [],
				owns: [],
				budget: { tokens: 100 },
				agent: { harness: "claude" },
			},
			{ preferred: { kind: "machine", machineId: machine.machineId }, alternatives: [] },
			{
				machines: plannerMachines([machine]),
				hostedProfiles: [],
				limited: limitedAccounts(await providerAccounts(context.db as never, Date.now())),
			},
		);
	await t.test(
		"with no login of its own, the account's key pays, and its limits hold the machine's agent",
		async () => {
			const [machine] = await listMachines(ctx as never);
			assert.equal(machine.harnesses?.[0]?.paysWith, true);
			assert.equal(machine.harnesses?.[0]?.method, "api-key");
			assert.equal(machine.providerAccounts?.[0]?.provider, "anthropic");
			assert.equal((await place(machine)).accountKey, usage.account.key);
		},
	);
	await t.test(
		"Claude Code's own login kept on the machine wins: no key is used and its limits don't hold it",
		async () => {
			machineWith("token");
			const [machine] = await listMachines(ctx as never);
			assert.equal(machine.harnesses?.[0]?.paysWith, undefined);
			assert.equal(machine.harnesses?.[0]?.method, "subscription");
			assert.equal(machine.harnesses?.[0]?.platformKeys, undefined);
			assert.deepEqual(machine.providerAccounts, []);
			assert.equal((await place(machine)).decision?.name, "Desk");
		},
	);
	await t.test("with nothing to pay, the agent says so instead of asking for a machine login", async () => {
		machineWith("none");
		sql.exec("DELETE FROM model_provider");
		const [machine] = await listMachines(ctx as never);
		assert.equal(machine.harnesses?.[0]?.signIn, "none");
		assert.equal(machine.harnesses?.[0]?.paysWith, true);
		assert.match(
			JSON.stringify(await place(machine)),
			/nothing can pay for Claude Code there \(connect a plan or add a key on Connections\)/,
		);
	});
});
