/** Independent server processes so each observes its own boot-time keyring. All keys are fixtures. */
import "./check-secret.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createFakeSignInCommands } from "../server/src/sandbox-fake.js";
import { SignInHolder, type StoredSignIn } from "../server/src/signin/holder.js";
import { createSealer } from "../server/src/signin/seal.js";
import assert from "node:assert/strict";
import { createHmac, hkdfSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const old = "old-secret-for-local-keyring-checks";
const fresh = "new-secret-for-local-keyring-checks";
const overlap = `new:${fresh},old:${old}`;

function server(roots: string, operation: string, input = ""): string {
	const env = {
		...process.env,
		WLP_SECRET: roots.split(",")[0]!.split(":")[1]!,
		WLP_SECRET_KEYS: roots,
		WLP_SIGNIN_KEYS: roots,
		INPUT: input,
	};
	const run = spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"-e",
			`
		import { issueUserToken, issueServiceToken, verifyToken } from "./src/tokens.ts";
		import { serverSealer } from "./src/signin/seal.ts";
		import { issueState, verifyState, issueTicket, verifyTicket } from "./src/github/state.ts";
		const input = process.env.INPUT;
		const profile = {uid:"u_test", email:null, demo:true};
		console.log(${operation});
	`,
		],
		{ cwd: fileURLToPath(new URL("../server/", import.meta.url)), env, encoding: "utf8" },
	);
	assert.equal(run.status, 0, run.stderr);
	return run.stdout.trim();
}

test("old tokens verify during overlap and stop at retirement", () => {
	const token = server(`old:${old}`, "issueUserToken(profile, 0)");
	assert.equal(server(overlap, "verifyToken(input)?.kind", token), "user");
	assert.equal(server(`new:${fresh}`, "verifyToken(input)", token), "null");
	assert.equal(token.split(".")[1], "old");
	assert.equal(server(overlap, "issueUserToken(profile, 0)").split(".")[1], "new");
});

test("each signer uses its designated HKDF key", () => {
	for (const [operation, purpose] of [
		["issueUserToken(profile, 0)", "user-token"],
		["issueServiceToken()", "service-token"],
		['issueState("u","n","https://example.invalid")', "github-state"],
		['issueTicket("u",{user:{id:1,login:"fixture"},installations:[]})', "github-ticket"],
	]) {
		const token = server(overlap, operation!);
		const body = token.slice(0, token.lastIndexOf("."));
		const signature = token.slice(body.length + 1);
		const sign = (label: string) =>
			createHmac("sha256", Buffer.from(hkdfSync("sha256", fresh, "", "windlass-platform v2 " + label, 32)))
				.update(body)
				.digest("base64url");
		assert.equal(signature, sign(purpose!), purpose);
		const wrong = purpose === "user-token" ? "service-token" : "user-token";
		const verify =
			purpose === "github-state" ? "verifyState" : purpose === "github-ticket" ? "verifyTicket" : "verifyToken";
		assert.equal(server(overlap, `${verify}(input)`, body + "." + sign(wrong)), "null");
	}
});

test("a saved sign-in is opened and re-sealed by a status read", () => {
	const blob = server(
		`old:${old}`,
		'serverSealer().seal("user",profile.uid,JSON.stringify({files:{"auth.json":JSON.stringify({account:{sub:"sub"}})}}))',
	);
	const result = server(
		overlap,
		`await (async () => {
		const { SignInHolder } = await import("./src/signin/holder.ts");
		let row = {sealed: input, generation: "g7", shortNoted: false};
		const holder = new SignInHolder({uid:profile.uid, sealer:serverSealer(), commands:{},
			store:{ load: async () => row, save: async next => {row = next} }});
		await holder.status();
		return row.sealed;
	})()`,
		blob,
	);
	assert.equal(result.split(".")[1], "new");
	assert.match(server(`new:${fresh}`, 'serverSealer().open("user",profile.uid,input)', result), /sub/);
});

const material = JSON.stringify({ files: { "auth.json": JSON.stringify({ account: { sub: "test-sub" } }) } });

test("current-key status returns while a token command is still running", async t => {
	const sealer = createSealer(fresh);
	const sealed = sealer.seal("user", "u", material);
	const commands = createFakeSignInCommands();
	let release!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	let started!: () => void;
	const running = new Promise<void>(resolve => {
		started = resolve;
	});
	t.mock.method(commands, "token", async () => {
		started();
		await gate;
		throw new Error("fixture stopped the refresh");
	});
	const holder = new SignInHolder({
		uid: "u",
		sealer,
		commands,
		store: {
			load: async () => ({ sealed, generation: "g7", shortNoted: false }),
			save: async () => assert.fail("a current key needs no save"),
		},
	});
	const refresh = assert.rejects(holder.accessToken(), /fixture stopped/);
	try {
		await running;
		const account = await Promise.race([holder.status(), nextTurn().then(() => null)]);
		assert.equal(account?.sub, "test-sub");
	} finally {
		release();
		await refresh;
	}
});

test("status reports the account and retries rotation after a failed re-seal save", async () => {
	const sealer = createSealer([
		{ id: "new", secret: Buffer.from(fresh) },
		{ id: "old", secret: Buffer.from(old) },
	]);
	const original = createSealer(old).seal("user", "u", material);
	let row: StoredSignIn = { sealed: original, generation: "g7", shortNoted: false };
	let fail = true;
	const log: string[] = [];
	const holder = new SignInHolder({
		uid: "u",
		sealer,
		commands: createFakeSignInCommands(),
		log: line => log.push(line),
		store: {
			load: async () => ({ ...row }),
			save: async next => {
				if (fail) throw new Error("storage unavailable");
				row = { ...next };
			},
		},
	});
	assert.equal((await holder.status())?.sub, "test-sub");
	assert.equal(row.sealed, original);
	assert.equal(log.length, 1);
	fail = false;
	assert.equal((await holder.status())?.sub, "test-sub");
	assert.ok(sealer.isCurrent(row.sealed!));
	assert.equal(row.generation, "g7");
});

test("account and repository reads replace old ciphertext without overwriting concurrent edits", () => {
	const result = server(
		overlap,
		`await (async () => {
		const { sealSecret } = await import("./src/repo-secrets.ts");
		const { refreshSecretRows } = await import("./src/signin/secret-rows.ts");
		const { ACCOUNT_SECRET_PROJECT } = await import("./src/account-secrets.ts");
		const { createSealer } = await import("./src/signin/seal.ts");
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(":memory:");
		const io = {execute: async (sql, ...args) => db.prepare(sql).all(...args)};
		for (const project of [ACCOUNT_SECRET_PROJECT, "github:7"]) {
			const account = project === ACCOUNT_SECRET_PROJECT;
			const table = account ? "account_secret" : "repo_secret";
			db.exec("CREATE TABLE "+table+" (project TEXT, name TEXT, sealed TEXT)");
			const sealed = sealSecret(createSealer("${old}"), "u", project, "TOKEN", "original");
			db.prepare("INSERT INTO "+table+" VALUES (?, ?, ?)").run(project, "TOKEN", sealed);
			const rows = [{name:"TOKEN",sealed}];
			await refreshSecretRows(io, serverSealer(), "u", project, rows);
			const saved = db.prepare("SELECT sealed FROM "+table).get().sealed;
			if (saved !== rows[0].sealed || saved.split(".")[1] !== "new") return "old ciphertext";
			db.prepare("UPDATE "+table+" SET sealed='newer-edit'").run();
			await refreshSecretRows(io, serverSealer(), "u", project, [{name:"TOKEN",sealed}]);
			if (db.prepare("SELECT sealed FROM "+table).get().sealed !== "newer-edit") return "lost edit";
		}
		return "ok";
	})()`,
	);
	assert.equal(result, "ok");
});

test("loading a pending sign-in upgrades its saved blob before the next callback", () => {
	const result = server(
		overlap,
		`await (async () => {
		const { login } = await import("./src/actors/login.ts");
		const { createSealer } = await import("./src/signin/seal.ts");
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(":memory:");
		db.exec("CREATE TABLE attempt (id INTEGER PRIMARY KEY, state TEXT, expires_at INTEGER, sealed TEXT, schedule_id TEXT)");
		const id = "attempt_fixture";
		const blob = createSealer("${old}").seal("attempt", id, JSON.stringify({files:{}}));
		db.prepare("INSERT INTO attempt VALUES (1,'started',10000,?,'job')").run(blob);
		const vars = await login.config.createVars({key:[id], db:{execute:async (sql,...args) => db.prepare(sql).all(...args)}});
		const saved = db.prepare("SELECT sealed FROM attempt").get().sealed;
		if (saved !== vars.attempt.sealed) return "only rotated in memory";
		return saved.split(".")[1];
	})()`,
	);
	assert.equal(result, "new");
});

test("pairing budgets and attach-ticket lookups use independent HKDF keys", () => {
	const actual = server(
		overlap,
		`await (async () => {
		const { keyedDigest } = await import("./src/signatures.ts");
		return ["pairing-budget", "attach-ticket"].map(label => keyedDigest(label, "fixture").toString("hex")).join(",");
	})()`,
	);
	const expected = ["pairing-budget", "attach-ticket"].map(label => {
		const key = Buffer.from(hkdfSync("sha256", fresh, "", "windlass-platform v2 " + label, 32));
		return createHmac("sha256", key).update("fixture").digest("hex");
	});
	assert.equal(actual, expected.join(","));
});

test("a genuine pre-upgrade user token ends at cutover", () => {
	const legacy = { k: "u", uid: "u_test", email: null, demo: true, exp: Date.now() + 60_000 };
	const body = "v1." + Buffer.from(JSON.stringify(legacy)).toString("base64url");
	const token = body + "." + createHmac("sha256", old).update(body).digest("base64url");
	assert.equal(server(overlap, "verifyToken(input)", token), "null");
});
