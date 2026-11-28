/**
 * Test Linear filing through the platform's HTTP routes and actors, with stand-ins for Linear, GitHub and the sandbox.
 * The child process adds service-only fixture actions before registering the actors. Setup cases supply state for later mapping and filing checks.
 */
import { loginHttp } from "./login-http.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { pollUntil, readProvenance } from "./issue-intake-fixture.js";
import { GithubStandin } from "./github-standin.js";
import { LinearStandin, type StandinIssue, type StandinPerson, type StandinTeam } from "./linear-standin.js";
import { localListeners } from "./check-listeners.js";
import { sectionMatcher } from "./check-sections.js";

const ORIGIN = "http://127.0.0.1:5173";
const OPERATOR = "linear-check";

/** The node of the platform under test: the normal server, with test actions attached before the registry is set up. */
async function testNode() {
	const { requireServiceFor } = await import("../server/src/auth.js");
	const { user } = await import("../server/src/actors/user.js");
	const { workItem } = await import("../server/src/actors/work-item.js");
	type UserCtx = Parameters<NonNullable<typeof user.config.actions>["internalMachineChanged"]>[0];
	type ItemCtx = Parameters<NonNullable<typeof workItem.config.actions>["internalView"]>[0];
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
	// Lose the first successful comment reply to the item for each event.
	const write = user.config.actions!.internalLinearWrite;
	const lost = new Set<string>();
	user.config.actions!.internalLinearWrite = async (c, input) => {
		const posted = await write(c, input);
		if (posted && "commentId" in input.write && !lost.has(input.write.commentId)) {
			lost.add(input.write.commentId);
			throw new Error("The comment reply was lost");
		}
		return posted;
	};
	Object.assign(user.config.actions!, {
		// The owner's delivery rows: what was decided for each delivery that was taken in.
		checkRows: async (c: UserCtx) => {
			requireServiceFor(c, "call");
			return c.db.execute<{ id: string; decision: string }>(
				"SELECT id, decision FROM linear_delivery ORDER BY received_at, rowid",
			);
		},
		checkPreviousFilingDay: async (c: UserCtx) => {
			requireServiceFor(c, "call");
			const yesterday = Date.now() - 86_400_000;
			for (const item of c.vars.items.items.values()) item.createdAt = yesterday;
			await c.db.execute(
				"UPDATE items SET created_at=?, summary=json_set(summary, '$.createdAt', ?)",
				yesterday,
				yesterday,
			);
			await c.db.execute("UPDATE github_item_keys SET created_at=?", yesterday);
		},
		checkExpireLinearTickets: async (c: UserCtx) => {
			requireServiceFor(c, "call");
			await c.db.execute("UPDATE linear_state SET expires_at = 0 WHERE nonce LIKE 'ticket:%'");
		},
		// A paired machine that is online, for the saved placement to name.
		checkPlaceMachine: async (c: UserCtx, id: string) => {
			requireServiceFor(c, "call");
			await c.db.execute(
				"INSERT OR IGNORE INTO machines (id,name,os,arch,facts) VALUES (?,?,'macOS','arm64','{}')",
				id,
				id,
			);
			await user.config.actions!.internalMachineChanged(c, id, {
				status: "online",
				since: Date.now(),
				runnerVersion: "0.2.0",
				warnings: [],
				turns: { max: 1, running: 0, queued: 0 },
				report: {
					kind: "report",
					docker: { ok: true },
					commandSandbox: { ok: true },
					sandboxes: [],
					freeDiskBytes: null,
					egress: "open",
					harnesses: [{ id: "claude", adapter: "claude", image: "test", signIn: "token" }],
				},
			});
		},
	});
	Object.assign(workItem.config.actions!, {
		checkProvenance: async (c: ItemCtx) => {
			requireServiceFor(c, "call");
			return readProvenance(c);
		},
	});
	await import("../server/src/index.js");
}

const until = pollUntil(20_000);
const inLinearOnly = sectionMatcher("LINEAR_ONLY");

async function run() {
	const {
		engine,
		http: [http],
	} = await localListeners();
	const api = "http://127.0.0.1:" + http;
	const storage = mkdtempSync(join(tmpdir(), "wlp-linear-e2e-"));
	const github = new GithubStandin({
		callbackUrl: api + "/github/callback",
		slug: "windlass-fk4w",
		strictBranches: false,
	});
	await github.start();
	const linear = await LinearStandin.start();
	const githubSecret = randomBytes(32).toString("hex");
	Object.assign(process.env, github.env(), {
		WLP_SECRET: randomBytes(32).toString("hex"),
		WLP_GITHUB_WEBHOOK_SECRET: githubSecret,
		WLP_SANDBOX: "fake",
		WLP_DEMO: "1",
		WLP_HTTP_PORT: String(http),
		RIVETKIT_STORAGE_PATH: storage,
		RIVET_RUN_ENGINE_PORT: String(engine),
		WLP_WEB_ORIGINS: ORIGIN,
		RIVET_LOG_LEVEL: "silent",
		// The platform's Linear app, as the operator would set it, pointed at the stand-in.
		WLP_LINEAR_CLIENT_ID: linear.clientId,
		WLP_LINEAR_CLIENT_SECRET: linear.clientSecret,
		WLP_LINEAR_WEBHOOK_SECRET: linear.signingSecret,
		WLP_LINEAR_API_URL: linear.url,
		WLP_LINEAR_URL: linear.url,
		WLP_LINEAR_REDIRECT_URL: linear.redirectUri,
	});
	for (const key of [
		"RIVET_ADMIN_TOKEN",
		"RIVET_ENDPOINT",
		"RIVET_ENGINE",
		"PORT",
		"WLP_FACTORY_ORCHESTRATE",
		"WLP_FACTORY_GITHUB_ITEMS_PER_DAY",
		"WLP_LINEAR_WEBHOOK_SECRET_PREVIOUS",
	])
		delete process.env[key];
	const { createClient } = await import("../server/src/client.js");
	const { serviceParams } = await import("../server/src/auth.js");
	const { issueServiceToken } = await import("../server/src/tokens.js");
	const { limitsSubject } = await import("../server/src/user-limits.js");
	const client = createClient<import("../server/src/registry.js").Registry>({ endpoint: "http://127.0.0.1:" + engine });
	const service = () => ({ params: serviceParams() });

	const failed: string[] = [];
	const check = async (name: string, fn: () => Promise<void> | void) => {
		if (!inLinearOnly(name)) return;
		try {
			await fn();
			console.log("PASS " + name);
		} catch (error) {
			failed.push(name);
			console.error("FAIL " + name + "\n" + (error instanceof Error ? (error.stack ?? error.message) : String(error)));
		}
	};

	const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--node"], {
		cwd: fileURLToPath(new URL("../server", import.meta.url)),
		env: {
			...process.env,
			WLP_ITEMS: "1",
			WLP_MACHINES: "1",
			WLP_MAX_KEPT_SANDBOXES: "unlimited",
			WLP_FAKE_DELAY_MS: "10",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let logs = "";
	child.stdout.on("data", b => {
		logs += b.toString();
	});
	child.stderr.on("data", b => {
		logs += b.toString();
	});
	const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));

	try {
		await until(
			"the platform HTTP port",
			async () => {
				if (child.exitCode !== null) throw new Error("test node exited " + child.exitCode + "\n" + logs.slice(-2000));
				return (await fetch(api + "/platform/info").catch(() => null))?.ok;
			},
			90_000,
		);

		// ---- the owner, set up through the supported actions ---------------------------------------------
		const login = "linear-owner";
		github.addUser(login);
		const installation = github.addInstallation(login, "User");
		const repo = github.addRepository({ owner: login, name: "factory", installation });
		// Somebody else's repository: the owner cannot write to it.
		github.addUser("linear-neighbour");
		const neighbourInstallation = github.addInstallation("linear-neighbour", "User");
		const foreign = github.addRepository({
			owner: "linear-neighbour",
			name: "other",
			installation: neighbourInstallation,
		});
		Object.assign(github.appPermissions, { checks: "read", statuses: "read", actions: "read", issues: "write" });
		const auth = await loginHttp(api).demo();
		const uid = auth.profile.uid;
		const owner = client.user.getOrCreate([uid], { params: { token: auth.token } });
		const connectGithub = await owner.githubConnect({ origin: ORIGIN });
		const back = await fetch(github.authorize(login, connectGithub.url), { redirect: "manual" });
		await owner.githubComplete(back.headers.get("location")!.split("#github=")[1]);
		const code = (promise: Promise<unknown>) =>
			promise.then(
				() => "ok",
				(error: { code?: string }) => error.code ?? "error",
			);

		const { openLinearTicket } = await import("../server/src/linear/connect.js");
		const callback = (search: URLSearchParams) => fetch(`${api}/linear/callback?${search}`, { redirect: "manual" });
		const ticketFrom = (answer: Response) => {
			assert.equal(answer.status, 302);
			const landing = new URL(answer.headers.get("location")!);
			assert.equal(landing.origin + landing.pathname, `${ORIGIN}/settings`);
			assert.match(landing.hash, /^#linear=.+$/);
			return landing.hash.slice("#linear=".length);
		};
		const begin = async () =>
			new URL(await linear.authorize((await owner.linearConnect({ origin: ORIGIN })).url)).searchParams;
		let ownerToken: string;
		type Team = StandinTeam;
		const eng = linear.addTeam("ENG", "Engineering"),
			ops = linear.addTeam("OPS", "Operations");
		const hook = api + "/linear/webhook";
		const send = async (payload: Record<string, unknown>, options: Parameters<typeof linear.deliver>[2] = {}) => {
			const answer = await linear.deliver(hook, payload, options);
			return {
				...answer,
				json: answer.body.startsWith("{") ? (JSON.parse(answer.body) as Record<string, unknown>) : {},
			};
		};
		const rows = () =>
			(
				client.user.get([uid], service()) as unknown as {
					checkRows(): Promise<Array<{ id: string; decision: string }>>;
				}
			).checkRows();
		/** What the owner's actor decided for a delivery it took in: kept before the route answered. */
		const decided = async (deliveryId: string) => {
			const row = (await rows()).find(r => r.id === deliveryId.toLowerCase());
			assert.ok(row, "no decision was kept for delivery " + deliveryId);
			return JSON.parse(row.decision) as { kind: string; why?: string; itemId?: string };
		};
		/** Taken in, and decided: what a qualifying delivery comes to. */
		const qualifying = async (payload: Record<string, unknown>, options: Parameters<typeof linear.deliver>[2] = {}) => {
			const sent = await send(payload, options);
			assert.equal(sent.status, 202, sent.body);
			assert.deepEqual(sent.json, { taken: true });
			return decided(sent.deliveryId);
		};
		const ignored = async (payload: Record<string, unknown>) => {
			const before = (await rows()).length;
			const sent = await send(payload);
			assert.equal(sent.status, 202, sent.body);
			assert.deepEqual(sent.json, { taken: false });
			assert.equal((await rows()).length, before, "an ignored delivery leaves no row");
		};
		const linearItems = async () => await owner.listItems({ source: "linear" });
		const itemsOf = async (issue: StandinIssue) => (await linearItems()).filter(i => i.origin?.linear?.id === issue.id);
		const probe = (id: string) =>
			client.workItem.get([uid, id], service()) as unknown as {
				checkProvenance(): Promise<{
					github: unknown;
					linear: Record<string, any> | null;
					untrusted: string[] | null;
					bindingRows: number;
					issueEffects: number;
				}>;
			};
		const urlOf = (issue: StandinIssue) => `https://linear.app/${linear.workspace.urlKey}/issue/${issue.identifier}`;
		/** An issue made in Linear and the delivery of its creation. */
		const created = (
			team: Team,
			input: {
				labels?: string[];
				assignee?: StandinPerson | null;
				creator?: StandinPerson;
				actor?: StandinPerson;
				title?: string;
				description?: string;
			} = {},
		) => linear.createIssue({ team, ...input });
		/** Signs in at Linear as `person` and links that Linear user to `who`: the ticket the web app is sent back with. */
		const linkTicket = async (who: typeof owner, person: StandinPerson) => {
			linear.consent = { approve: true, person };
			try {
				const start = new URL((await who.linkAccountStart({ surface: "linear", origin: ORIGIN })).url);
				assert.equal(start.searchParams.get("actor"), null, "a person signs in as themselves");
				assert.equal(start.searchParams.get("scope"), "read");
				const answer = await callback(new URL(await linear.authorize(start.href)).searchParams);
				const landing = new URL(answer.headers.get("location")!);
				assert.match(landing.hash, /^#link-return=linear\..+$/);
				return landing.hash.slice("#link-return=".length);
			} finally {
				linear.consent = { approve: true };
			}
		};
		const linked = [{ surface: "linear", tenant: linear.workspace.id, tenantName: "Acme", name: "Ada Owner" }];
		const prompts = (issue: StandinIssue) =>
			[...linear.comments.values()].filter(c => c.issueId === issue.id && c.body.includes("isn't linked")).length;
		const update = (issue: StandinIssue, patch: Parameters<typeof linear.updateIssue>[1], actor?: StandinPerson) =>
			linear.updateIssue(issue, patch, actor);

		await check(
			"setup: disconnected until the owner connects, and a workspace nobody connected is ignored",
			async () => {
				assert.deepEqual(await owner.linear(), { state: "disconnected" });
				// A workspace nobody connected has nobody to file for: the delivery is turned away and takes nothing in.
				const { payload } = created(eng, { labels: ["windlass"] });
				const answer = await send(payload);
				assert.equal(answer.status, 202);
				assert.deepEqual(answer.json, { taken: false });
				assert.equal(await code(owner.linearTeams()), "linear_not_connected");
			},
		);

		await check(
			"OAuth: the owner connects the workspace from Settings, once per state, to the web app's own address only",
			async () => {
				assert.equal(await code(owner.linearConnect({ origin: "http://evil.example" })), "origin_not_allowed");
				const begun = await owner.linearConnect({ origin: ORIGIN });
				const address = new URL(begun.url);
				assert.equal(address.origin, linear.url);
				assert.equal(address.searchParams.get("client_id"), linear.clientId);
				assert.equal(address.searchParams.get("actor"), "app");
				assert.equal(address.searchParams.get("redirect_uri"), linear.redirectUri);
				assert.ok(!begun.url.includes(linear.clientSecret));
				// A state that was not issued, and one that was altered, finish nothing.
				const consent = new URL(await linear.authorize(begun.url));
				const forged = new URLSearchParams(consent.searchParams);
				forged.set("state", forged.get("state")!.slice(0, -2) + "xx");
				let answer = await callback(forged);
				assert.equal(answer.status, 302);
				assert.equal(answer.headers.get("location"), `${ORIGIN}/settings#linear-error=state`);
				assert.deepEqual(await owner.linear(), { state: "disconnected" });
				// Only the signed-in owner can redeem the returned ticket.
				answer = await callback(consent.searchParams);
				const ticket = ticketFrom(answer);
				const stranger = await loginHttp(api).demo();
				const other = client.user.getOrCreate([stranger.profile.uid], { params: { token: stranger.token } });
				assert.equal(await code(other.linearComplete(ticket)), "linear_ticket");
				assert.deepEqual(await other.linear(), { state: "disconnected" });
				assert.deepEqual(await owner.linear(), { state: "disconnected" });
				const status = await owner.linearComplete(ticket);
				assert.equal(await code(owner.linearComplete(ticket)), "linear_ticket");
				ownerToken = openLinearTicket(uid, ticket).token.accessToken;
				assert.ok(status.state === "connected");
				assert.equal(status.connection.workspace.id, linear.workspace.id);
				assert.equal(status.connection.workspace.urlKey, "acme");
				assert.equal(status.connection.appUser?.id, linear.appUser.id);
				assert.ok(!JSON.stringify(status).includes("lin_oauth_"), "no token in the answer");
				// The same state does not work twice: the replay finds nothing to claim.
				answer = await callback(consent.searchParams);
				assert.match(answer.headers.get("location") ?? "", /#linear-error=(used|state)$/);
				const stillThere = await owner.linear();
				assert.ok(
					stillThere.state === "connected" && stillThere.connection.connectedAt === status.connection.connectedAt,
				);
				// The token is the app's own, asked with the registered redirect address and the PKCE verifier.
				assert.ok(linear.calls.includes("POST /oauth/token"));
			},
		);

		await check("mapping: one team to one repository the owner can write to, read from Linear now", async () => {
			const { teams } = await owner.linearTeams();
			assert.deepEqual(
				teams.map(t => [t.key, t.mapping]),
				[
					["ENG", null],
					["OPS", null],
				],
			);
			assert.equal(await code(owner.saveLinearMapping({ teamId: randomUUID(), repositoryId: repo.id })), "linear_team");
			assert.equal(await code(owner.saveLinearMapping({ teamId: eng.id, repositoryId: foreign.id })), "bad_input");
			assert.equal((await owner.linearTeams()).teams.find(t => t.id === eng.id)!.mapping, null);
			const saved = await owner.saveLinearMapping({ teamId: eng.id, repositoryId: repo.id });
			const mapping = saved.teams.find(t => t.id === eng.id)!.mapping!;
			assert.equal(String(mapping.repository.id), String(repo.id));
			assert.deepEqual([mapping.repository.owner, mapping.repository.name], [login, "factory"]);
			assert.equal(saved.teams.find(t => t.id === ops.id)!.mapping, null);
			assert.equal((await owner.linearTeams()).teams.find(t => t.id === eng.id)!.mapping?.repository.name, "factory");
		});

		await check(
			"identity: the owner links their Linear user by signing in as themselves, with a ticket only they can use",
			async () => {
				const third = await loginHttp(api).demo();
				const someone = client.user.getOrCreate([third.profile.uid], { params: { token: third.token } });
				const ticket = await linkTicket(owner, linear.human);
				assert.equal(await code(someone.linkAccount(ticket)), "link_ticket", "another user's ticket is refused");
				const result = await owner.linkAccount(ticket);
				assert.deepEqual(result.linked, linked[0], "the return names the account it linked");
				assert.deepEqual(result.accounts, linked);
				assert.ok(result.signIn.includes("linear"));
				assert.equal(await code(owner.linkAccount(ticket)), "link_ticket", "a ticket works once");
				assert.deepEqual((await someone.linkedAccounts()).accounts, []);
			},
		);

		await check("bad signatures are refused and unmapped teams are ignored, with nothing taken in", async () => {
			const before = (await rows()).length;
			const { payload } = created(eng, { labels: ["windlass"] });
			const wrong = await send(payload, { secret: "lin_wh_" + randomBytes(24).toString("hex") });
			assert.equal(wrong.status, 401);
			assert.equal(wrong.json.code, "bad_signature");
			const malformed = await send(payload, { signature: "not-a-signature" });
			assert.equal(malformed.status, 400);
			const unsigned = await send(payload, { omit: ["linear-signature"] });
			assert.equal(unsigned.status, 400);
			// Altered after it was signed.
			const altered = await send(payload, { bytes: Buffer.from(JSON.stringify(payload).replace("Issue", "Issue ")) });
			assert.equal(altered.status, 401);
			const stale = await send(payload, { timestamp: Date.now() - 10 * 60_000 });
			assert.equal(stale.status, 401);
			// The team Windlass is not told to file for: signed, and ignored.
			const other = created(ops, { labels: ["windlass"] });
			const answer = await send(other.payload);
			assert.equal(answer.status, 202);
			assert.deepEqual(answer.json, { taken: false });
			assert.equal((await rows()).length, before);
			assert.equal((await linearItems()).length, 0);
			// Nothing here was asked of Linear for an issue: the platform did not even read the unmapped one.
			assert.ok(!linear.calls.includes("POST /graphql issue"));
		});

		let issueA!: StandinIssue, itemA!: string;
		await check(
			"label: a labelled issue files one item with its provenance in Plan first mode, and a redelivery or another qualifying event files nothing more",
			async () => {
				const made = created(eng, {
					labels: ["windlass"],
					title: "Print hello",
					description: "Add a short program.\n- [ ] It prints hello\n<!-- hidden words -->",
				});
				issueA = made.issue;
				const first = await send(made.payload);
				assert.equal(first.status, 202);
				assert.deepEqual(first.json, { taken: true });
				const decision = await decided(first.deliveryId);
				assert.equal(decision.kind, "filed");
				const [item] = await itemsOf(issueA);
				assert.ok(item);
				itemA = item.id;
				assert.equal(decision.itemId, item.id);
				// Stored: the issue's id, identifier and link, and the repository.
				assert.equal(item.source, "linear");
				assert.equal(String(item.repository.id), String(repo.id));
				assert.equal(item.origin?.issue, undefined);
				assert.equal(item.origin?.linear?.id, issueA.id);
				assert.equal(item.origin?.linear?.identifier, issueA.identifier);
				// The stand-in's address is http, so the link is the one Linear's own addresses have.
				assert.equal(item.origin?.linear?.url, urlOf(issueA));
				assert.equal(item.mode, "orchestrate");
				// Written by somebody the connection cannot call the owner: third-party text, so a draft that has not run.
				assert.equal(item.state, "draft");
				assert.equal(item.origin?.linear?.trusted, false);
				assert.equal(item.origin?.linear?.author, "Ada Owner");
				const view = await owner.item(item.id);
				assert.equal(view.run, null);
				assert.equal(view.spent.turns, 0);
				assert.match(view.task.body, /written by Ada Owner on Linear/);
				assert.match(view.task.body, /> Add a short program\./);
				assert.doesNotMatch(view.task.body, /hidden/);
				assert.deepEqual(view.task.acceptance, ["Ada Owner wrote: It prints hello"]);
				assert.match(view.events[0]?.said ?? "", /^Filed from Linear issue ENG-\d+, written by Ada Owner\. Filed by /);
				const kept = await probe(item.id).checkProvenance();
				assert.equal(kept.github, null);
				assert.equal(kept.bindingRows, 0);
				assert.equal(kept.issueEffects, 0);
				assert.deepEqual(
					[kept.linear?.workspaceId, kept.linear?.teamId, kept.linear?.generation, kept.linear?.via],
					[linear.workspace.id, eng.id, 1, "label"],
				);
				assert.deepEqual(kept.linear?.origin, item.origin);
				assert.match(String(kept.linear?.modeReason), /Plan first/);
				assert.deepEqual(kept.untrusted, [`Linear issue ${issueA.identifier} by Ada Owner`]);
				// The same delivery again is a redelivery.
				const again = await send(made.payload, { deliveryId: first.deliveryId });
				assert.equal(again.status, 202);
				assert.deepEqual(again.json, { taken: "duplicate" });
				// A different qualifying event for the same active issue (the app assigned too) is taken in and files nothing.
				const assigned = await qualifying(update(issueA, { assignee: linear.appUser }));
				assert.deepEqual(assigned, { kind: "exists", itemId: item.id });
				// Gaining the other label is a transition as well.
				assert.deepEqual(await qualifying(update(issueA, { addLabels: ["windlass:quick"] })), {
					kind: "exists",
					itemId: item.id,
				});
				assert.equal((await itemsOf(issueA)).length, 1);
				assert.equal((await linearItems()).length, 1);
				assert.equal((await owner.listItems({ source: "github" })).length, 0);
				assert.deepEqual(
					(await owner.itemFeed()).counts.byRepository
						.filter(r => r.source === "linear")
						.map(r => [String(r.repository), r.open]),
					[[String(repo.id), 1]],
				);
			},
		);

		let issueB!: StandinIssue, itemB!: string;
		await check(
			"assignment: assigning the app user files one item, assigning anybody else does not, and an unrelated edit is no trigger",
			async () => {
				const made = created(eng, { title: "Fix the readme" });
				issueB = made.issue;
				// Created with no label and no assignee: nothing to do.
				await ignored(made.payload);
				await ignored(update(issueB, { assignee: linear.human }));
				await ignored(update(issueB, { title: "Fix the README", description: "Now with words." }));
				assert.equal((await itemsOf(issueB)).length, 0);
				const decision = await qualifying(update(issueB, { assignee: linear.appUser }));
				assert.equal(decision.kind, "filed");
				const [item] = await itemsOf(issueB);
				assert.ok(item);
				itemB = item.id;
				assert.equal(decision.itemId, item.id);
				assert.equal(item.origin?.linear?.identifier, issueB.identifier);
				assert.equal(item.origin?.linear?.url, urlOf(issueB));
				assert.equal(String(item.repository.id), String(repo.id));
				assert.equal(item.mode, "orchestrate");
				assert.equal((await probe(item.id).checkProvenance()).linear?.via, "assignment");
				// What the item says is what Linear says now, read when it was filed: the edit's title, not a payload's.
				assert.equal((await owner.item(item.id)).task.title, "Fix the README");
				// The label too, afterwards, and an edit of the assigned issue.
				assert.deepEqual(await qualifying(update(issueB, { addLabels: ["windlass"] })), {
					kind: "exists",
					itemId: item.id,
				});
				await ignored(update(issueB, { title: "Fix the README again" }));
				assert.equal((await itemsOf(issueB)).length, 1);
			},
		);

		await check("removal and unassignment: the filed items are left alone", async () => {
			const snapshot = async () => (await linearItems()).map(i => [i.id, i.state, i.mode, i.title]).sort();
			const before = await snapshot();
			const rowsBefore = (await rows()).length;
			await ignored(update(issueA, { removeLabels: ["windlass", "windlass:quick"] }));
			await ignored(update(issueB, { assignee: null }));
			await ignored(update(issueB, { assignee: linear.human }));
			await ignored(update(issueB, { removeLabels: ["windlass"] }));
			await ignored(linear.removeIssue(issueA));
			await ignored(linear.removeIssue(issueB));
			assert.equal((await rows()).length, rowsBefore);
			assert.deepEqual(await snapshot(), before);
			for (const id of [itemA, itemB]) assert.equal((await owner.item(id)).state, "draft");
			// Nothing was written to Linear, here or anywhere above.
			assert.deepEqual(linear.writes, []);
		});

		await check(
			"identity: a sender files in the Windlass account they linked; an unlinked one is asked once and files nothing",
			async () => {
				const count = (await linearItems()).length;
				const asked = created(eng, { labels: ["windlass"], actor: linear.stranger });
				assert.deepEqual(await qualifying(asked.payload), {
					kind: "ignored",
					why: "The person who asked has not linked a Windlass account.",
				});
				assert.equal(prompts(asked.issue), 1);
				assert.equal(
					(await qualifying(update(asked.issue, { assignee: linear.appUser }, linear.stranger))).kind,
					"ignored",
				);
				assert.equal(prompts(asked.issue), 1, "asked once per issue");
				assert.equal((await linearItems()).length, count);

				// Revoked, the owner is unlinked too; linked again, what they label is theirs, with them as its verified filer.
				assert.deepEqual((await owner.unlinkAccount({ surface: "linear", tenant: linear.workspace.id })).accounts, []);
				const unlinked = created(eng, { labels: ["windlass"] });
				assert.equal((await qualifying(unlinked.payload)).kind, "ignored");
				assert.equal(prompts(unlinked.issue), 1);
				assert.deepEqual((await owner.linkAccount(await linkTicket(owner, linear.human))).accounts, linked);
				const own = created(eng, { labels: ["windlass"] });
				assert.equal((await qualifying(own.payload)).kind, "filed");
				const [item] = await itemsOf(own.issue);
				assert.deepEqual(item?.origin?.filer, { surface: "linear", externalUserId: linear.human.id, verified: true });
				await owner.actOnItem({ id: item!.id, action: { kind: "cancel" } });
			},
		);

		await check("an issue that no longer qualifies by the time the owner's actor reads it files nothing", async () => {
			// The label is added and removed again before the delivery is worked on: Linear's own state decides, not the payload.
			const made = created(eng, { labels: ["windlass"] });
			linear.updateIssue(made.issue, { removeLabels: ["windlass"] });
			const decision = await qualifying(made.payload);
			assert.equal(decision.kind, "ignored");
			assert.equal((await itemsOf(made.issue)).length, 0);
			// An issue that was closed is not filed either.
			const closed = created(eng, { labels: ["windlass"] });
			closed.issue.stateType = "canceled";
			assert.equal((await qualifying(closed.payload)).kind, "ignored");
			assert.equal((await itemsOf(closed.issue)).length, 0);
		});

		await check("Plan first against windlass:quick, and the saved placement on both", async () => {
			const mac = "m_0000000000000003";
			// Before anything is saved: no placement is kept, and Quick is one implementer without a plan.
			const unplaced = created(eng, { labels: ["windlass", "windlass:quick"] });
			assert.equal((await qualifying(unplaced.payload)).kind, "filed");
			const [plain] = await itemsOf(unplaced.issue);
			assert.equal(plain.mode, "single");
			assert.match(String((await probe(plain.id).checkProvenance()).linear?.modeReason), /Quick was requested/);
			assert.equal((await owner.item(plain.id)).resolved?.sources.place, "deployment");
			assert.deepEqual((await owner.item(plain.id)).place, { kind: "hosted" });
			// A paired machine, and the account's saved placement on it.
			await (
				client.user.get([uid], service()) as unknown as { checkPlaceMachine(id: string): Promise<void> }
			).checkPlaceMachine(mac);
			await owner.saveAccountDefaults({
				place: { machine: mac },
				harness: "claude",
				machineProfile: "docker-hardened",
			});

			const quick = created(eng, { labels: ["windlass:quick"] });
			assert.equal((await qualifying(quick.payload)).kind, "filed");
			const [fast] = await itemsOf(quick.issue);
			assert.equal(fast.mode, "single");
			const quickKept = (await probe(fast.id).checkProvenance()).linear!;
			assert.match(String(quickKept.modeReason), /Quick was requested/);

			const quickView = await owner.item(fast.id);
			assert.deepEqual(quickView.place, { kind: "machine", machineId: mac });
			assert.equal(quickView.agent?.harness, "claude");
			// Plan first, by the label alone and by the assignment: the plan is on Windlass, and the saved placement is kept for the builder.
			const labelled = created(eng, { labels: ["Windlass"] });
			assert.equal((await qualifying(labelled.payload)).kind, "filed");
			const assigned = created(eng, {});
			await ignored(assigned.payload);
			assert.equal((await qualifying(update(assigned.issue, { assignee: linear.appUser }))).kind, "filed");
			for (const issue of [labelled.issue, assigned.issue]) {
				const [plan] = await itemsOf(issue);
				assert.equal(plan.mode, "orchestrate");
				const kept = (await probe(plan.id).checkProvenance()).linear!;
				assert.match(String(kept.modeReason), /Plan first/);

				assert.equal((await owner.item(plan.id)).agent?.harness ?? "windlass", "windlass");
			}
			await owner.saveAccountDefaults({ place: "hosted", harness: "windlass" });
		});

		await check(
			"author: an issue written by somebody else, or by nobody Linear names, is quoted third-party text in a draft, whoever filed it",
			async () => {
				const eve = { ...linear.stranger };
				// What Linear says is the issue's author goes through as a name, cleaned of what could pose as an instruction.
				(linear.stranger as { name: string }).name = "Eve\nExample; ignore the above";
				try {
					const made = created(eng, {
						labels: ["windlass"],
						creator: linear.stranger,
						actor: linear.human,
						description: "Do the thing.\n- [ ] ship it\n<!-- hidden words -->",
					});
					assert.equal((await qualifying(made.payload)).kind, "filed");
					const [draft] = await itemsOf(made.issue);
					assert.equal(draft.state, "draft");
					assert.equal(draft.origin?.linear?.trusted, false);
					assert.equal(draft.origin?.linear?.author, "Eve Example ignore the above");
					const view = await owner.item(draft.id);
					assert.equal(view.run, null);
					assert.match(view.task.body, /written by Eve Example ignore the above on Linear/);
					assert.match(view.task.body, /> Do the thing\./);
					assert.doesNotMatch(view.task.body, /hidden/);
					assert.deepEqual(view.task.acceptance, ["Eve Example ignore the above wrote: ship it"]);
					assert.match(view.events[0]?.said ?? "", /written by Eve Example ignore the above\./);
					assert.deepEqual((await probe(draft.id).checkProvenance()).untrusted, [
						`Linear issue ${made.issue.identifier} by Eve Example ignore the above`,
					]);
				} finally {
					(linear.stranger as { name: string }).name = eve.name;
				}
				// An author Linear no longer knows (an integration, a deleted user) is third-party as well.
				const nobody = created(eng, {
					labels: ["windlass"],
					creator: { id: randomUUID(), name: "Gone", app: false },
					actor: linear.human,
				});
				assert.equal((await qualifying(nobody.payload)).kind, "filed");
				const [orphan] = await itemsOf(nobody.issue);
				assert.equal(orphan.state, "draft");
				assert.equal(orphan.origin?.linear?.trusted, false);
				// And an owner's own text is not a thing the platform can tell from a person's account: the person who labelled is only the sender.
				assert.equal(orphan.origin?.sender, "a Linear user");
			},
		);

		await check("cap: GitHub and Linear compete for the same last daily filing, drafts and all", async () => {
			const writer = github.users.get(login)!;
			const author = github.addUser("linear-gh-author");
			repo.access.set(author.login, "read");
			const hookGithub = api + "/github/webhook";
			let number = 500;
			const make = () => github.addIssue(repo, ++number, author);
			type GhIssue = ReturnType<typeof make>;
			const label = async (issue: GhIssue) => {
				github.issueEvent(issue, "labeled", writer);
				issue.labels = ["windlass"];
				issue.events.at(-1)!.label = { name: "windlass" };
				const res = await github.deliver(
					hookGithub,
					"issues",
					{
						installation: { id: installation.id },
						repository: { id: repo.id, name: "decoy", owner: { login: "decoy" } },
						issue: {
							number: issue.number,
							title: "Decoy title",
							body: "Decoy body",
							user: writer,
							author_association: "OWNER",
						},
						sender: { ...writer, type: "User" },
						action: "labeled",
						label: { name: "windlass" },
					},
					{ secret: githubSecret },
				);
				assert.equal(res.status, 202);
				assert.deepEqual(await res.json(), { taken: true });
			};
			const githubItems = async (issue: GhIssue) =>
				(await owner.listItems({ source: "github" })).filter(i => i.origin?.issue?.number === issue.number);
			const bots = (issue: GhIssue) => issue.comments.filter(c => c.user.login.endsWith("[bot]"));
			const total = async () =>
				(await owner.listItems()).filter(i => i.source === "github" || i.source === "linear").length;
			const limit = async (value: number | "default") =>
				client.user
					.get([uid], { params: { token: issueServiceToken(limitsSubject(uid, OPERATOR)) } })
					.internalSetLimit({ operator: OPERATOR, key: "githubItemsPerDay", value });
			const settleGithub = async (issue: GhIssue) =>
				until(
					"GitHub's answer on issue " + issue.number,
					async () => (await githubItems(issue)).length > 0 || bots(issue).length > 0,
				);
			const refusedOnGithub = (issue: GhIssue) => /work items from GitHub today/.test(bots(issue)[0]?.body ?? "");
			try {
				// Round 1: the last place of the day is GitHub's, and then Linear's issue is refused.
				const used = await total();
				await limit(used + 1);
				const hub = make();
				await label(hub);
				await settleGithub(hub);
				assert.equal((await githubItems(hub)).length, 1);
				assert.equal((await githubItems(hub))[0].state, "draft");
				assert.equal(await total(), used + 1);
				const refused = created(eng, { labels: ["windlass"] });
				const refusal = await send(refused.payload);
				assert.equal(refusal.status, 202);
				assert.ok(!(await rows()).some(r => r.id === refusal.deliveryId));
				assert.equal((await itemsOf(refused.issue)).length, 0);
				assert.equal(await total(), used + 1);
				// Round 2: the last place is Linear's, and then GitHub's issue gets its one refusal.
				const second = await total();
				await limit(second + 1);
				const lin = created(eng, { labels: ["windlass"] });
				assert.equal((await qualifying(lin.payload)).kind, "filed");
				const late = make();
				await label(late);
				await settleGithub(late);
				assert.equal((await githubItems(late)).length, 0);
				assert.equal(bots(late).length, 1);
				assert.ok(refusedOnGithub(late), bots(late)[0]?.body);
				assert.equal(await total(), second + 1);

				// Round 3: both at once for the one place left. The intake queue takes them one at a time: one wins, one is refused.
				const third = await total();
				await limit(third + 1);
				const raceHub = make();
				const raceLinear = created(eng, { labels: ["windlass"] });
				const [sentRace] = await Promise.all([send(raceLinear.payload), label(raceHub)]);
				assert.equal(sentRace.status, 202);
				await settleGithub(raceHub).catch(() => undefined);
				await until("exactly one winner", async () => (await total()) === third + 1);
				await sleep(500);
				assert.equal(await total(), third + 1);
				const linearWon = (await itemsOf(raceLinear.issue)).length === 1;
				const githubWon = (await githubItems(raceHub)).length === 1;
				assert.equal(Number(linearWon) + Number(githubWon), 1);
				if (linearWon) {
					assert.equal((await decided(sentRace.deliveryId)).kind, "filed");
					assert.ok(refusedOnGithub(raceHub), bots(raceHub)[0]?.body);
				} else {
					assert.ok(!(await rows()).some(r => r.id === sentRace.deliveryId));
					assert.ok(!refusedOnGithub(raceHub), bots(raceHub)[0]?.body);
				}

				// A new UTC day has room at the same limit. Redeliver the original ID.
				await (
					client.user.get([uid], service()) as unknown as { checkPreviousFilingDay(): Promise<void> }
				).checkPreviousFilingDay();
				const retried = await qualifying(refused.payload, { deliveryId: refusal.deliveryId, timestamp: Date.now() });
				assert.equal(retried.kind, "filed");
				assert.equal((await itemsOf(refused.issue)).length, 1);
				assert.deepEqual((await send(refused.payload, { deliveryId: refusal.deliveryId })).json, {
					taken: "duplicate",
				});
			} finally {
				await limit("default");
			}
		});

		const ensureWritebackMapping = async () => {
			if ((await owner.linear()).state !== "connected")
				await owner.linearComplete(ticketFrom(await callback(await begin())));
			await owner.saveLinearMapping({ teamId: eng.id, repositoryId: repo.id });
		};
		await check(
			"writeback posts the PR, handover and merge once across lost replies and completes only on merge",
			async () => {
				await ensureWritebackMapping();
				const updatesBefore = linear.writes.filter(w => w === "issueUpdate").length;
				const { issue, payload } = created(eng, {
					labels: ["windlass:quick"],
					title: "Print hello",
					description: "Add a short program.",
				});
				const { itemId } = await qualifying(payload);
				const id = itemId!;
				const comments = () => [...linear.comments.values()].filter(c => c.issueId === issue.id).map(c => c.body);
				await owner.actOnItem({ id, action: { kind: "start" } });
				const pr = await until(
					"the Linear item's pull request",
					async () => (await owner.item(id)).pullRequest,
					45_000,
				);
				await until(
					"the PR link and handover on the issue",
					async () =>
						linear.attachments.get(issue.id) === pr.url && comments().some(b => b.includes("was handed over")),
				);
				const review = linear.workflowStates.get(eng.id)!.find(s => s.name === "In Review")!;
				await until("the review state", async () => issue.stateId === review.id);
				const pull = github.pulls.find(p => p.repository === repo.id && p.number === pr.number)!;
				pull.state = "closed";
				pull.merged = true;
				await until("the completed issue", async () => issue.stateType === "completed");
				assert.equal((await owner.item(id)).state, "done");
				await until(
					"all three lost replies retried",
					async () => linear.calls.filter(c => c === "POST /graphql comment").length >= 3,
					40_000,
				);
				assert.deepEqual(
					comments().sort(),
					["opened its pull request", "was handed over", "merged"]
						.map(event => `Windlass item ${id} ${event}. ${pr.url}`)
						.sort(),
				);
				assert.equal(linear.writes.filter(w => w === "issueUpdate").length - updatesBefore, 3);
				const cancelled = created(eng, { labels: ["windlass"] });
				const filed = await qualifying(cancelled.payload);
				await owner.actOnItem({ id: filed.itemId!, action: { kind: "cancel" } });
				await until("cancellation before a PR", async () =>
					[...linear.comments.values()].some(
						c => c.issueId === cancelled.issue.id && c.body === `Windlass item ${filed.itemId} was cancelled.`,
					),
				);
				assert.equal(cancelled.issue.stateType, "unstarted");
			},
		);

		await check("writeback reports a question and giving up leaves the started issue open", async () => {
			await ensureWritebackMapping();
			await owner.saveRepositoryDefaults({ repositoryId: repo.id, profile: "docker-hardened" });
			try {
				const { issue, payload } = created(eng, { labels: ["windlass:quick"] });
				const { itemId } = await qualifying(payload);
				const id = itemId!;
				await owner.actOnItem({ id, action: { kind: "start" } });
				const question = await until("the untrusted turn's question", async () => (await owner.item(id)).question);
				const comment = await until("the owner question link", async () =>
					[...linear.comments.values()].find(c => c.issueId === issue.id),
				);
				assert.equal(comment.body, `[Windlass item](${ORIGIN}/items/${id}) has a question for you.`);
				await owner.actOnItem({ id, action: { kind: "answer", question: question.id, choice: "give_up" } });
				await until("failure on the Linear issue", async () =>
					[...linear.comments.values()].some(c => c.issueId === issue.id && c.body === `Windlass item ${id} failed.`),
				);
				assert.equal(issue.stateType, "started");
			} finally {
				await owner.saveRepositoryDefaults({ repositoryId: repo.id, profile: null });
			}
		});

		await check("writeback posts one owner comment for each plan approval across lost replies", async () => {
			await ensureWritebackMapping();
			const { issue, payload } = created(eng, { labels: ["windlass"] });
			const { itemId } = await qualifying(payload);
			const id = itemId!;
			await owner.actOnItem({ id, action: { kind: "start" } });
			const plan = await until("first plan approval", async () => (await owner.item(id)).question);
			assert.equal(plan.kind, "plan_approval");
			await owner.actOnItem({
				id,
				action: { kind: "answer", question: plan.id, choice: "revise", note: "Clarify the scope." },
			});
			const next = await until("revised plan approval", async () => {
				const q = (await owner.item(id)).question;
				return q && q.id !== plan.id && q;
			});
			assert.ok(["plan_approval", "replan_approval"].includes(next.kind));
			const comments = () => [...linear.comments].filter(([, c]) => c.issueId === issue.id);
			await until(
				"both plan comments retried",
				async () => comments().length >= 2 && comments().every(([key]) => linear.commentReads.includes(key)),
				45_000,
			);
			assert.deepEqual(
				comments().map(([, c]) => c.body),
				Array(2).fill(`[Windlass item](${ORIGIN}/items/${id}) has a plan waiting for your approval.`),
			);
			await owner.actOnItem({ id, action: { kind: "cancel" } });
		});

		await check("writeback during a Linear outage lets the item run and cancel", async () => {
			await ensureWritebackMapping();
			const { issue, payload } = created(eng, { labels: ["windlass:quick"] });
			const { itemId } = await qualifying(payload);
			const id = itemId!;
			linear.graphqlFailure = 503;
			try {
				await owner.actOnItem({ id, action: { kind: "start" } });
				await until("a PR while Linear is down", async () => (await owner.item(id)).pullRequest, 45_000);
				await owner.actOnItem({ id, action: { kind: "cancel" } });
				assert.equal((await owner.item(id)).state, "cancelled");
			} finally {
				linear.graphqlFailure = null;
			}
			await until(
				"the cancellation reaches Linear after recovery",
				async () => [...linear.comments.values()].some(c => c.issueId === issue.id && c.body.includes("was cancelled")),
				45_000,
			);
			assert.equal(issue.stateType, "unstarted");
			assert.ok(!logs.includes("private Linear outage details"));
		});

		await check("writeback backs off across events after Linear rate limits the app user", async () => {
			await ensureWritebackMapping();
			const { issue, payload } = created(eng, { labels: ["windlass:quick"] });
			const { itemId } = await qualifying(payload);
			const actor = client.user.get([uid], service());
			const write = (key: "start" | "review_opened") =>
				actor.internalLinearWrite({
					workspaceId: linear.workspace.id,
					teamId: eng.id,
					issueId: issue.id,
					itemId: itemId!,
					write: { key },
				});
			linear.graphqlFailure = "RATELIMITED";
			try {
				await assert.rejects(write("start"));
			} finally {
				linear.graphqlFailure = null;
			}
			const calls = linear.calls.length;
			await assert.rejects(write("review_opened"));
			assert.equal(linear.calls.length, calls, "additional events must respect the app user's cooldown");
			assert.ok(!logs.includes("private rate limit details"));
		});

		await check("a removed mapping files nothing, and the same issue files again once it is mapped", async () => {
			const before = (await linearItems()).length;
			const mapped = created(eng, { labels: ["windlass"] });
			const unmapped = await owner.removeLinearMapping(eng.id);
			assert.equal(unmapped.teams.find(t => t.id === eng.id)!.mapping, null);
			await ignored(mapped.payload);
			await ignored(update(mapped.issue, { title: "Renamed while unmapped" }));
			assert.equal((await linearItems()).length, before);
			await owner.saveLinearMapping({ teamId: eng.id, repositoryId: repo.id });
			// The issue has had the label all along: the app assigned is the transition that files it now.
			assert.equal((await qualifying(update(mapped.issue, { assignee: linear.appUser }))).kind, "filed");
			assert.equal((await linearItems()).length, before + 1);
		});

		await check(
			"a second owner of the workspace cannot take a mapped team; once it is removed the next to save it gets it, and is charged",
			async () => {
				const login2 = "linear-second";
				github.addUser(login2);
				const second = github.addRepository({
					owner: login2,
					name: "other-factory",
					installation: github.addInstallation(login2, "User"),
				});
				const auth2 = await loginHttp(api).demo();
				const other = client.user.getOrCreate([auth2.profile.uid], { params: { token: auth2.token } });
				const gh = await other.githubConnect({ origin: ORIGIN });
				await other.githubComplete(
					(await fetch(github.authorize(login2, gh.url), { redirect: "manual" })).headers
						.get("location")!
						.split("#github=")[1],
				);
				const consent = new URL(await linear.authorize((await other.linearConnect({ origin: ORIGIN })).url));
				const ticket = ticketFrom(await callback(consent.searchParams));
				await other.linearComplete(ticket);
				// Sam is the second owner's Linear account: what Sam labels is the second owner's.
				await other.linkAccount(await linkTicket(other, linear.stranger));

				// ENG is the first owner's while it is mapped; OPS is free.
				assert.equal(
					await code(other.saveLinearMapping({ teamId: eng.id, repositoryId: second.id })),
					"linear_team_taken",
				);
				assert.equal((await other.linearTeams()).teams.find(t => t.id === eng.id)!.mapping, null);
				const ownItems = (await linearItems()).length;
				assert.equal((await qualifying(created(eng, { labels: ["windlass"] }).payload)).kind, "filed");
				assert.equal((await linearItems()).length, ownItems + 1);
				assert.equal((await other.listItems({ source: "linear" })).length, 0);
				await other.saveLinearMapping({ teamId: ops.id, repositoryId: second.id });
				assert.deepEqual((await send(created(ops, { labels: ["windlass"], actor: linear.stranger }).payload)).json, {
					taken: true,
				});
				assert.equal((await other.listItems({ source: "linear" })).length, 1);
				assert.equal((await linearItems()).length, ownItems + 1, "a team of the second owner charged the first");

				// Given up, ENG goes to whoever saves it next, and a delivery is no longer the first owner's.
				await owner.removeLinearMapping(eng.id);
				await other.saveLinearMapping({ teamId: eng.id, repositoryId: second.id });
				assert.equal(
					await code(owner.saveLinearMapping({ teamId: eng.id, repositoryId: repo.id })),
					"linear_team_taken",
				);
				assert.deepEqual((await send(created(eng, { labels: ["windlass"], actor: linear.stranger }).payload)).json, {
					taken: true,
				});
				assert.equal((await other.listItems({ source: "linear" })).length, 2);
				assert.equal((await linearItems()).length, ownItems + 1, "a team given up charged its former owner");

				// A claim that outlived its mapping routes a delivery to the owner, who finds no mapping and files nothing.
				const stale = linear.addTeam("LEG", "Legacy");
				assert.equal(
					await (
						client.linearWorkspace.getOrCreate([linear.workspace.id], service()) as unknown as {
							internalClaim(i: { teamId: string; uid: string }): Promise<boolean>;
						}
					).internalClaim({ teamId: stale.id, uid }),
					true,
				);
				const reads = linear.calls.filter(call => call === "POST /graphql issue").length;
				await ignored(created(stale, { labels: ["windlass"] }).payload);
				assert.equal((await linearItems()).length, ownItems + 1);
				assert.equal(
					linear.calls.filter(call => call === "POST /graphql issue").length,
					reads,
					"a stale route read an issue for the former owner",
				);
				// The previous claimant has no mapping. The next mapper gets the team.
				await other.saveLinearMapping({ teamId: stale.id, repositoryId: second.id });
				assert.equal(
					await code(owner.saveLinearMapping({ teamId: stale.id, repositoryId: repo.id })),
					"linear_team_taken",
				);
				// A revoked connection also gives way, even with its old mapping still stored.
				linear.revoke(openLinearTicket(auth2.profile.uid, ticket).token.accessToken);
				await owner.saveLinearMapping({ teamId: stale.id, repositoryId: repo.id });
				assert.deepEqual(await other.disconnectLinear(), { state: "disconnected" });
			},
		);

		await check("disconnect revokes the token, clears deliveries and cancels pending states and tickets", async () => {
			const expired = ticketFrom(await callback(await begin()));
			await (
				client.user.get([uid], service()) as unknown as { checkExpireLinearTickets(): Promise<void> }
			).checkExpireLinearTickets();
			assert.equal(await code(owner.linearComplete(expired)), "linear_ticket");

			const pending = await begin();
			const ticket = ticketFrom(await callback(await begin()));
			assert.ok((await rows()).length > 0);
			const revocations = linear.calls.filter(call => call === "POST /oauth/revoke").length;
			assert.deepEqual(await owner.disconnectLinear(), { state: "disconnected" });
			assert.equal(linear.calls.filter(call => call === "POST /oauth/revoke").length, revocations + 1);
			const { linearApp, LinearError } = await import("../server/src/linear/app.js");
			await assert.rejects(linearApp()!.identity(ownerToken), e => e instanceof LinearError && e.unauthorized);
			assert.deepEqual(await rows(), []);
			assert.equal((await callback(pending)).headers.get("location"), `${ORIGIN}/settings#linear-error=used`);
			assert.equal(await code(owner.linearComplete(ticket)), "linear_ticket");
		});

		await check("Quick labels: filing and mode from a single Linear label", async () => {
			await owner.linearComplete(ticketFrom(await callback(await begin())));
			await owner.saveLinearMapping({ teamId: eng.id, repositoryId: repo.id });
			for (const [label, mode] of [
				["Windlass-Quick", "single"],
				["windlass:quick", "single"],
				["windlass", "orchestrate"],
			]) {
				const { issue, payload } = created(eng, { labels: [label] });
				assert.equal((await qualifying(payload)).kind, "filed", label);
				assert.deepEqual(
					(await itemsOf(issue)).map(item => item.mode),
					[mode],
					label,
				);
			}
			const bare = created(eng, { labels: ["quick"] });
			await ignored(bare.payload);
			assert.deepEqual(await itemsOf(bare.issue), []);
		});

		await check("the platform logged no credential", async () => {
			assert.ok(logs.includes("linear.connected"), "the connection was logged");
			assert.ok(logs.includes("linear.delivery.filed"));
			for (const secret of [
				linear.clientSecret,
				linear.signingSecret,
				githubSecret,
				"lin_oauth_",
				"lin_refresh_",
				"code-",
			])
				assert.ok(!logs.includes(secret), "a credential appeared in the platform's output");
		});
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		const guard = setTimeout(() => child.kill("SIGKILL"), 15_000);
		await exited;
		clearTimeout(guard);
		try {
			const { pid } = JSON.parse(readFileSync(join(storage, ".rivetkit/var/engine/runtime.json"), "utf8"));
			if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
		} catch {
			/* The engine went with its node. */
		}
		await linear.close();
		await github.stop();
		rmSync(storage, { recursive: true, force: true });
	}
	if (failed.length) throw new Error(failed.length + " Linear check(s) failed: " + failed.join("; "));
	console.log("linear-check: all passed");
}

if (process.argv.includes("--node")) await testNode();
else
	await run().then(
		() => process.exit(0),
		error => {
			console.error(error);
			process.exit(1);
		},
	);
