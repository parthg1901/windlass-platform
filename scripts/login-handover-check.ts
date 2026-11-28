import "./check-secret.js";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import { GithubStandin } from "./github-standin.js";

process.env.WLP_SANDBOX = "fake";
process.env.WLP_SIGNIN_RUNNER = "";
process.env.WLP_DEMO = "1";

const { serviceParams } = await import("../server/src/auth.js");
const { createGrant } = await import("../server/src/actors/internal.js");
const secret = "A".repeat(43);
const { login } = await import("../server/src/actors/login.js");
const { getLayer } = await import("../server/src/layer.js");
const { verifyToken } = await import("../server/src/tokens.js");

assert.ok("createVars" in login.config);
const { createVars } = login.config;

for (const action of ["finish", "demo"] as const) {
	test(action + " can retry a failed generation lookup before handing over the sign-in", async t => {
		const sql = new DatabaseSync(":memory:");
		t.after(() => sql.close());
		sql.exec(
			"CREATE TABLE attempt (id INTEGER PRIMARY KEY, state TEXT, expires_at INTEGER, sealed TEXT, schedule_id TEXT, failures INTEGER DEFAULT 0)",
		);
		const db = { execute: async (query: string, ...args: SQLInputValue[]) => sql.prepare(query).all(...args) };
		let unavailable = true;
		const generation = async () => {
			if (unavailable) throw new Error("generation lookup unavailable");
			return 7;
		};
		const user = { internalTokenGeneration: generation, internalLogin: generation };
		const actor = {
			key: ["attempt_handover"],
			conn: { params: serviceParams() },
			db,
			log: { error() {} },
			client: () => ({
				user: { getOrCreate: () => user },
				accountIdentities: { getOrCreate: () => ({ internalResolve: async () => "u_handover" }) },
			}),
			schedule: { after: async () => "job", cancel: async () => true },
		};
		await login.config.onCreate!(actor as never, { grant: createGrant("login", actor.key) });
		const ctx = { ...actor, vars: await createVars(actor as never, undefined) };
		const { logins } = await getLayer();
		const handover = t.mock.method(logins, "ensureUserVolume", async () => {});
		let callback = "";
		if (action === "finish") {
			const github = new GithubStandin({ callbackUrl: "http://localhost:5173/signin" });
			await github.start();
			t.after(() => github.stop());
			Object.assign(process.env, github.env());
			github.addUser("owner");
			const start = await login.config.actions!.start(ctx as never, "github", "http://localhost:5173", secret, null);
			callback = github.authorize("owner", start.url);
		}
		const finish = () =>
			action === "finish"
				? login.config.actions!.finish(ctx as never, callback, secret, null)
				: login.config.actions!.demo(ctx as never);
		await assert.rejects(finish(), { code: "internal_error" });
		assert.equal(handover.mock.callCount(), 0);
		// Restart the attempt actor from its saved row and retry the same callback.
		ctx.vars = await createVars(actor as never, undefined);
		unavailable = false;
		const caller = verifyToken((await finish()).token);
		assert.equal(caller?.kind === "user" && caller.generation, 7);
		assert.equal(handover.mock.callCount(), 1);
	});
}

test("an existing session cannot rewrite the stored admission email", async () => {
	const { user } = await import("../server/src/actors/user.js");
	const { issueUserToken } = await import("../server/src/tokens.js");
	const profile = { uid: "u_existing", demo: false, email: "current@example.invalid" };
	const prior = { ...profile, email: "prior@example.invalid" };
	const ctx = {
		key: [profile.uid],
		conn: { params: { token: issueUserToken(prior, 0) } },
		vars: { tokenGen: 0, profile },
		db: { execute: async () => assert.fail("session rewrote the admission profile") },
	};
	assert.equal((await user.config.actions!.me(ctx as never)).uid, profile.uid);
	assert.equal(ctx.vars.profile.email, profile.email);
});
