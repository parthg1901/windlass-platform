/** Run from server with npx tsx ../scripts/jira-check.ts. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { localListeners } from "./check-listeners.js";
import { GithubStandin } from "./github-standin.js";
import { pollUntil } from "./issue-intake-fixture.js";
import { JiraStandin } from "./jira-standin.js";
import { loginHttp } from "./login-http.js";

const until = pollUntil(60_000),
	origin = "http://127.0.0.1:5173";
async function run() {
	const {
			engine,
			http: [port],
		} = await localListeners(),
		api = `http://127.0.0.1:${port}`;
	const jira = new JiraStandin(api + "/jira/callback"),
		github = new GithubStandin({ callbackUrl: api + "/github/callback", strictBranches: false });
	await jira.start();
	await github.start();
	const storage = mkdtempSync(join(tmpdir(), "jira-check-"));
	Object.assign(process.env, github.env(), {
		WLP_SECRET: randomBytes(32).toString("hex"),
		WLP_SANDBOX: "fake",
		WLP_DEMO: "1",
		WLP_ITEMS: "1",
		WLP_HTTP_PORT: String(port),
		WLP_WEB_ORIGINS: origin,
		WLP_PUBLIC_URL: api,
		WLP_FAKE_DELAY_MS: "10",
		WLP_MAX_KEPT_SANDBOXES: "unlimited",
		WLP_JIRA_CLIENT_ID: "windlass",
		WLP_JIRA_CLIENT_SECRET: jira.secret,
		WLP_JIRA_AUTH_URL: jira.url,
		WLP_JIRA_API_URL: jira.url,
		WLP_JIRA_REDIRECT_URL: jira.callback,
		RIVETKIT_STORAGE_PATH: storage,
		RIVET_RUN_ENGINE_PORT: String(engine),
		RIVET_LOG_LEVEL: "silent",
	});
	for (const key of ["RIVET_ENDPOINT", "RIVET_ADMIN_TOKEN", "RIVET_ENGINE", "PORT", "WLP_FACTORY_ORCHESTRATE"])
		delete process.env[key];
	const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--node"], {
		cwd: fileURLToPath(new URL("../server", import.meta.url)),
		stdio: "ignore",
	});
	const stopped = new Promise(resolve => child.once("exit", resolve));
	try {
		await until(
			"platform startup",
			async () => {
				assert.equal(child.exitCode, null, "platform exited");
				return (await fetch(api + "/platform/info").catch(() => null))?.ok;
			},
			90_000,
		);
		const { createClient } = await import("../server/src/client.js");
		const { serviceParams } = await import("../server/src/auth.js");
		const client = createClient<import("../server/src/registry.js").Registry>({
			endpoint: `http://127.0.0.1:${engine}`,
		});
		Object.assign(github.appPermissions, { checks: "read", statuses: "read", actions: "read", issues: "write" });
		const login = "jira-check";
		github.addUser(login);
		const repo = github.addRepository({
			owner: login,
			name: "factory",
			installation: github.addInstallation(login, "User"),
		});
		const account = async () => {
			const auth = await loginHttp(api).demo(),
				user = client.user.getOrCreate([auth.profile.uid], { params: { token: auth.token } });
			const gh = await fetch(github.authorize(login, (await user.githubConnect({ origin })).url), {
				redirect: "manual",
			});
			await user.githubComplete(new URL(gh.headers.get("location")!).hash.slice(8));
			return { user, uid: auth.profile.uid };
		};
		const { user: a, uid } = await account(),
			{ user: b } = await account();
		// Connecting Jira links the Jira account it signs in as: Ada is a's, Bob is b's.
		for (const [owner, other, person] of [
			[a, b, jira.ada],
			[b, a, jira.bob],
		] as const) {
			jira.consentAs = person;
			const callback = jira.authorize((await owner.jiraConnect({ origin })).url);
			const back = await fetch(callback, { redirect: "manual" });
			assert.equal(back.status, 302);
			assert.equal((await fetch(callback, { redirect: "manual" })).status, 400);
			const ticket = new URL(back.headers.get("location")!).hash.slice(6);
			assert.equal((await owner.jira()).state, "disconnected");
			await assert.rejects(other.jiraComplete(ticket), { code: "jira_ticket" });
			const status = await owner.jiraComplete(ticket);
			assert.ok(
				status.state === "connected" && status.connection.site === null && status.connection.sites.length === 2,
			);
			await assert.rejects(owner.jiraComplete(ticket), { code: "jira_ticket" });
			await owner.jiraSelectSite("acme");
			assert.deepEqual(await owner.linkedAccounts(), [
				{ surface: "jira", tenant: "atlassian", tenantName: "Atlassian", name: person.displayName },
			]);
		}
		const map = { projectId: "10", siteId: "acme", repositoryId: repo.id };
		await a.saveJiraMapping(map);
		await assert.rejects(b.saveJiraMapping(map), { code: "jira_project_taken" });
		let [hook, url] = [...jira.hooks][0];
		const labelled = jira.issue("acme", "101", ["windlass-quick"]),
			assigned = jira.issue("acme", "102", [], true);
		const event = {
			...jira.event(labelled, hook),
			webhookEvent: "jira:issue_updated",
			changelog: { items: [{ field: "labels", fromString: "", toString: "windlass-quick" }] },
		};
		const id = randomUUID();
		await jira.post(url, event, id, false);
		assert.equal(await jira.post(url, { ...event, matchedWebhookIds: [hook + 50] }), false);
		assert.equal(
			await jira.post(url, { ...event, issue: { ...labelled, self: "https://other.atlassian.net/issue/101" } }),
			false,
		);
		assert.equal(
			await jira.post(url, {
				...event,
				webhookEvent: "jira:issue_updated",
				changelog: { items: [{ field: "summary" }] },
			}),
			false,
		);
		labelled.fields.labels = [];
		assert.equal(await jira.post(url, event), false);
		labelled.fields.labels = ["windlass-quick"];
		assert.equal((await a.listItems()).length, 0);
		event.issue.fields.summary = "Unverified event text";
		assert.deepEqual((await Promise.all([jira.post(url, event, id), jira.post(url, event, id)])).sort(), [
			"duplicate",
			true,
		]);
		const [quick] = await a.listItems();
		assert.equal(quick.title, labelled.fields.summary);
		assert.deepEqual([quick.mode, quick.state, quick.origin?.jira?.trusted], ["single", "draft", false]);
		assert.match((await a.item(quick.id)).task.body, /> Print a greeting/);
		const milestone = (item: string, key: string) =>
			until(key, async () =>
				jira.comments.find(c => c.body.content.some(p => p.content[0]?.text === `[windlass:${item}:${key}]`)),
			);
		await milestone(quick.id, "filed");
		await until("reconcile lost comment reply", async () => jira.readAfterPost);
		await a.actOnItem({ id: quick.id, action: { kind: "start" } });
		const pr = await until("pull request", async () => (await a.item(quick.id)).pullRequest);
		const link = (comment: (typeof jira.comments)[number]) =>
			comment.body.content.flatMap(p => p.content).find(n => n.text === "Pull request")?.marks?.[0]?.attrs.href;
		assert.equal(link(await milestone(quick.id, "opened")), pr.url);
		Object.assign(github.pulls.find(p => p.number === pr.number)!, { state: "closed", merged: true });
		assert.equal(link(await milestone(quick.id, "done")), pr.url);
		assert.equal(jira.comments.filter(c => c.issue === "acme/101").length, 3);

		await a.saveRepositoryDefaults({ repositoryId: repo.id, profile: "docker-hardened" });
		assigned.fields.issuetype.name = "Bug";
		const assignment = {
			...jira.event(assigned, hook),
			webhookEvent: "jira:issue_updated",
			changelog: { items: [{ field: "assignee", from: null, to: assigned.fields.assignee!.accountId }] },
		};
		assert.equal(await jira.post(url, assignment), true);
		const failed = (await a.listItems()).find(i => i.origin?.jira?.id === assigned.id)!;
		assert.equal(failed.state, "draft");
		assert.equal(failed.mode, "single");
		await a.actOnItem({ id: failed.id, action: { kind: "start" } });
		const giveUp = async () => {
			const q = await until("untrusted Jira input", async () => (await a.item(failed.id)).question);
			assert.equal(q.kind, "turn_refused");
			await a.actOnItem({ id: failed.id, action: { kind: "answer", question: q.id, choice: "give_up" } });
		};
		await giveUp();
		await milestone(failed.id, "failed");
		const site = client.jiraSite.get(["acme"], { params: serviceParams() });
		const stale = await site.internalGeneration(uid, assigned.id, Date.now() + 1);
		assert.ok(stale.kind === "file");
		await a.actOnItem({ id: failed.id, action: { kind: "retry" } });
		await assert.rejects(site.internalReserveIssue(uid, assigned.id, "replacement", stale));
		// Interrupt a separate filing after its reservation, before the work-item actor exists.
		const interrupted = jira.issue("acme", "103", ["windlass"]);
		await site.internalReserveIssue(uid, interrupted.id, "i_0000000000000103", { generation: 1, activations: 0 });
		await a.removeJiraMapping(map);
		await b.saveJiraMapping(map);
		assert.equal(await jira.post(url, assignment), false);
		[hook, url] = [...jira.hooks][0];
		// From here Bob, b's own Jira account, assigns and labels: the project's new owner files as themselves.
		assigned.fields.assignee = jira.bob;
		interrupted.fields.creator = jira.bob;
		const current = jira.event(assigned, hook, jira.bob);
		assert.equal(await jira.post(url, current), true);
		assert.deepEqual(await b.listItems(), []);
		await giveUp();
		assert.equal(await jira.post(url, current), true);
		assert.deepEqual(await b.listItems(), []);
		const fresh = jira.event(assigned, hook, jira.bob);
		await Promise.all([jira.post(url, fresh), jira.post(url, fresh)]);
		assert.equal((await b.listItems()).length, 1);
		await assert.rejects(a.actOnItem({ id: failed.id, action: { kind: "retry" } }), { code: "item_conflict" });
		assert.equal(await jira.post(url, jira.event(interrupted, hook, jira.bob)), true);
		assert.equal(await site.internalActivateIssue(interrupted.id, uid, "i_0000000000000103", 1), false);
		assert.equal(
			(await b.listItems()).filter(i => i.origin?.jira?.id === interrupted.id && i.state === "draft").length,
			1,
		);
		const page = { ended: true, source: "jira" as const, limit: 1 };
		const [first] = await a.listItems(page),
			[second] = await a.listItems({ ...page, before: { id: first.id, createdAt: first.createdAt } });
		assert.deepEqual([first.id, second.id], [failed.id, quick.id]);
		await b.jiraSelectSite("harbor");
		await b.saveJiraMapping({ ...map, siteId: "harbor" });
		[hook, url] = [...jira.hooks][0];
		const twin = jira.event(jira.issue("harbor", assigned.id, ["windlass"]), hook, jira.bob);
		assert.equal(await jira.post(url, twin), true);
		assert.equal(
			(await b.listItems()).filter(i => i.origin?.jira?.id === assigned.id && i.state === "draft").length,
			2,
		);

		// The person who labels files in their own account: Ada labels on b's project and the item is a's.
		const prompts = (key: string) =>
			jira.comments.filter(c => c.issue === key && c.body.content[0]?.content[0]?.text.includes("isn't linked")).length;
		const strangers = jira.issue("harbor", "104", ["windlass"]);
		assert.equal(await jira.post(url, jira.event(strangers, hook, jira.sam)), false);
		assert.equal(await jira.post(url, jira.event(strangers, hook, jira.sam)), false);
		assert.equal(prompts("harbor/104"), 1, "an unlinked person is asked to link once per issue");
		assert.equal((await a.listItems()).filter(i => i.origin?.jira?.id === "104").length, 0);
		assert.equal((await b.listItems()).filter(i => i.origin?.jira?.id === "104").length, 0);
		const adas = jira.issue("harbor", "105", ["windlass"]);
		assert.equal(await jira.post(url, jira.event(adas, hook, jira.ada)), true);
		const filed = (await a.listItems()).find(i => i.origin?.jira?.id === "105")!;
		assert.deepEqual(filed.origin?.filer, { surface: "jira", externalUserId: "acct:ada", verified: true });
		assert.equal((await b.listItems()).filter(i => i.origin?.jira?.id === "105").length, 0);
		// Its comments are written by the project's owner, with b's connection.
		assert.equal((await milestone(filed.id, "filed")).author.accountId, jira.bob.accountId);
		// Unlinking makes Ada unlinked again.
		assert.deepEqual(await a.unlinkAccount({ surface: "jira", tenant: "atlassian" }), []);
		const after = jira.issue("harbor", "106", ["windlass"]);
		assert.equal(await jira.post(url, jira.event(after, hook, jira.ada)), false);
		assert.equal(prompts("harbor/106"), 1);
		assert.equal((await a.listItems()).filter(i => i.origin?.jira?.id === "106").length, 0);

		assert.equal((await b.disconnectJira()).state, "disconnected");
		assert.equal(jira.hooks.size, 0);
		assert.equal(await jira.post(url, twin), false);
		console.log(
			"PASS Jira OAuth and account links, signed intake as the person who asked, comments, retry, owner handoff, paging and disconnect",
		);
	} finally {
		child.kill("SIGTERM");
		const guard = setTimeout(() => child.kill("SIGKILL"), 10_000);
		await stopped;
		clearTimeout(guard);
		try {
			const { pid } = JSON.parse(readFileSync(join(storage, ".rivetkit/var/engine/runtime.json"), "utf8"));
			process.kill(pid, "SIGTERM");
		} catch {
			/* already stopped */
		}
		await jira.close();
		await github.stop();
		rmSync(storage, { recursive: true, force: true });
	}
}
if (process.argv.includes("--node")) {
	const { CI_POLLING } = await import("../server/src/github/ci.js");
	Object.assign(CI_POLLING, {
		everyMs: 250,
		crowdedEveryMs: 250,
		prEveryMs: 250,
		webhookEveryMs: 250,
		webhookCrowdedEveryMs: 250,
		webhookPrEveryMs: 250,
		noneAfterMs: 0,
	});
	await import("../server/src/index.js");
} else
	await run().then(
		() => process.exit(0),
		error => {
			// Actor errors and assertion diffs may include one-time credentials.
			console.error("FAIL Jira check", error?.code ?? "", error?.stack?.match(/jira-check\.ts:(\d+:\d+)/)?.[1] ?? "");
			process.exit(1);
		},
	);
