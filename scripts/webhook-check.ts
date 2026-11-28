/** cd server && npx tsx ../scripts/webhook-check.ts. The engine node is the normal server
 * with test-only fixture actions attached before registry setup. No production action exposes SQL,
 * sets a test clock or installs a handler. All HTTP listeners use OS-assigned ports.
 */
import { loginHttp } from "./login-http.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { pollUntil, readProvenance } from "./issue-intake-fixture.js";
import { GithubStandin } from "./github-standin.js";
import { localListeners } from "./check-listeners.js";
import { edge, isAddressed } from "../server/src/github/events.js";

const DAY = 86_400_000;
const RETRY_INSTALLATION = 91919;
const HEAD = "a".repeat(40);
const origin = "http://127.0.0.1:5173";
const base = (port: number) => "http://127.0.0.1:" + port;

async function testNode() {
	const { githubInbox, HANDLERS, githubHooks } = await import("../server/src/actors/github-inbox.js");
	const { requireServiceFor } = await import("../server/src/auth.js");
	const { githubAccount } = await import("../server/src/actors/github-account.js");
	const { githubRepository } = await import("../server/src/actors/github-repository.js");
	// This probe deliberately has no action-level guard, so it observes the connection hook alone.
	for (const definition of [githubAccount, githubRepository, githubInbox, githubHooks])
		Object.assign(definition.config.actions!, { checkConnection: () => true });
	// The account-link refresh can be made to fail. Directory retries run on short delays here.
	const { GITHUB_SYNC } = await import("../server/src/actors/user-github.js");
	GITHUB_SYNC.delays = [300, 300, 300];
	type AccountCtx = Parameters<NonNullable<typeof githubAccount.config.actions>["internalWho"]>[0];
	const accountActions = githubAccount.config.actions as Record<string, (c: AccountCtx, ...args: never[]) => unknown>;
	const realRefresh = accountActions.internalRefresh!;
	let refreshFailures = 0,
		refreshCalls = 0;
	Object.assign(accountActions, {
		internalRefresh: async (c: AccountCtx, ...args: never[]) => {
			refreshCalls++;
			if (refreshFailures > 0) {
				refreshFailures--;
				throw new Error("The check failed this refresh.");
			}
			return realRefresh(c, ...args);
		},
		checkFailRefresh: (c: AccountCtx, times: number) => {
			requireServiceFor(c, "call");
			refreshFailures = times;
			refreshCalls = 0;
		},
		checkRefreshCalls: (c: AccountCtx) => {
			requireServiceFor(c, "call");
			return refreshCalls;
		},
	});
	const { config } = await import("../server/src/config.js");
	const { CI_POLLING } = await import("../server/src/github/ci.js");
	const { workItem } = await import("../server/src/actors/work-item.js");
	const { agentSession } = await import("../server/src/actors/agent-session.js");
	const session = agentSession.config.actions!;
	const publish = session.internalPublish;
	const refs = new Map<string, string>();
	const { FakeHandle } = await import("../server/src/sandbox-fake.js");
	const run = FakeHandle.prototype.run;
	FakeHandle.prototype.run = async function (command, options) {
		const result = await run.call(this, command, options);
		for (const [branch, head] of refs) {
			if (command.includes(`refs/remotes/origin/${branch}^{commit}`) && command.includes("wlp:haswork"))
				return { ...result, stdout: "wlp:haswork " + head };
			if (command.includes(`refs/remotes/origin/${branch}'`) && command.includes("wlp:work "))
				return { ...result, stdout: "wlp:work " + head };
		}
		return result;
	};
	// The fake sandbox pushes a branch without a git SHA. Give each published test PR a stable full head.
	session.internalPublish = async (c, input) => {
		const answer = await publish(c, input);
		if (answer.kind !== "published" || !answer.pr) return answer;
		const head = answer.pr.number.toString(16).padStart(40, "0");
		if (c.vars.meta!.title === "Sandbox expiry") {
			c.vars.meta!.pushedHead = head;
			refs.set(c.vars.meta!.publishBranch!, head);
		}
		return { ...answer, head };
	};
	type ItemCtx = Parameters<NonNullable<typeof workItem.config.actions>["internalView"]>[0];
	Object.assign(workItem.config.actions!, {
		// Start at the feature handoff for the inbox check. factory-e2e reaches it with real children.
		checkFinishedFeature: async (c: ItemCtx) => {
			requireServiceFor(c, "call");
			const stored = c.vars.stored!;
			const item = stored.item;
			assert.equal(item.state, "review");
			item.mode = "orchestrate";
			const single = item.singleBudget!;
			const tasks = ["one", "two"].map(key => ({
				key,
				title: key,
				brief: key,
				owns: [key],
				dependsOn: [],
				acceptance: ["Run pnpm test"],
				budget: single,
			}));
			item.featurePlan = {
				version: 1,
				status: "approved",
				subtasks: tasks,
				spec: { goal: item.task.title, requirements: [], outOfScope: [], acceptance: ["Run pnpm test"] },
				questions: [],
				singleSuggested: null,
				budget: item.budget,
				compare: { singleBudget: single },
			};
			item.approvedPlan = structuredClone(item.featurePlan);
			item.jobs = tasks.map(task => ({
				task,
				id: task.key,
				state: "done",
				spent: { turns: 0, tokens: 0, activeSeconds: 0, hostedSeconds: 0 },
				head: item.head,
				report: "Done.",
			}));
			await c.db.execute("UPDATE item SET data=? WHERE id=1", JSON.stringify(stored));
		},
		// Move only this item's durable deadlines. CI and webhook acceptance keep their real clocks.
		checkAdvance: async (c: ItemCtx, kind: "feedback" | "poll" | "idle", ms: number) => {
			requireServiceFor(c, "call");
			if (kind === "idle") {
				c.vars.stored!.meta.activityAt -= ms;
				await c.db.execute("UPDATE item SET data=? WHERE id=1", JSON.stringify(c.vars.stored));
				return;
			}
			if (kind === "feedback") {
				await c.db.execute("UPDATE feedback SET received=received-?,ready=ready-? WHERE state='pending'", ms, ms);
				await c.db.execute("UPDATE effects SET due_at=due_at-? WHERE id='feedback_ready:pending'", ms);
			} else await c.db.execute("UPDATE effects SET due_at=0 WHERE id LIKE 'poll_%'");
			await c.schedule.at(Date.now(), "internalDue");
		},
		checkWindow: async (c: ItemCtx) => {
			requireServiceFor(c, "call");
			const [r] = await c.db.execute<{ ms: number }>(
				"SELECT max(ready)-min(received) AS ms FROM feedback WHERE state='pending'",
			);
			return r?.ms;
		},
		checkPendingWrites: async (c: ItemCtx) => {
			requireServiceFor(c, "call");
			return (await c.db.execute("SELECT 1 FROM effects WHERE id LIKE 'verified_check:%' LIMIT 1")).length > 0;
		},
		checkProvenance: async (c: ItemCtx) => {
			requireServiceFor(c, "call");
			return readProvenance(c);
		},
		checkIssuePending: async (c: ItemCtx) => {
			requireServiceFor(c, "call");
			return (await c.db.execute("SELECT 1 FROM effects WHERE id='check_issue:pending'")).length > 0;
		},
		checkPoll: async (c: ItemCtx) => {
			requireServiceFor(c, "call");
			return (await c.db.execute("SELECT id, due_at, effect FROM effects WHERE id LIKE 'poll_%'"))[0] ?? null;
		},
	});
	const { user } = await import("../server/src/actors/user.js");
	type UserCtx = Parameters<NonNullable<typeof user.config.actions>["internalGithubIntake"]>[0];
	const { itemActions } = await import("../server/src/actors/user-items.js");
	const { itemActor } = await import("../server/src/actors/internal.js");
	const placeBuilder = itemActions.internalDefaultBuilder;
	// Exercise both trackers with the same session fixture.
	const githubIntake = itemActions.internalGithubIntake;
	itemActions.internalGithubIntake = (c, trigger, makeSession) =>
		"linearFiling" in trigger
			? (itemActions.internalTrackerIntake(c, trigger.linearFiling as never, makeSession) as never)
			: githubIntake(c, trigger, makeSession);
	let cancelDuringPlacement: string | null = null;
	itemActions.internalDefaultBuilder = (c, input, makeSession) =>
		placeBuilder(c, input, async (...args) => {
			const session = await makeSession(...args);
			if (input.id === cancelDuringPlacement) {
				cancelDuringPlacement = null;
				await itemActor(c, c.key[0], input.id).internalAct({ action: { kind: "cancel" }, by: "platform" });
			}
			return session;
		});
	Object.assign(user.config.actions!, {
		checkCancelDuringPlacement: (c: UserCtx, id: string) => {
			requireServiceFor(c, "call");
			cancelDuringPlacement = id;
		},
		checkPlaceMachine: async (
			c: UserCtx,
			id: string,
			state: "online" | "offline" | "full" | "signed-out" | "removed",
		) => {
			requireServiceFor(c, "call");
			const update = user.config.actions!.internalMachineChanged;
			if (state === "removed") return update(c, id, null);
			await c.db.execute(
				"INSERT OR IGNORE INTO machines (id,name,os,arch,facts) VALUES (?,?,'macOS','arm64','{}')",
				id,
				id,
			);
			await update(c, id, {
				status: state === "offline" ? "offline" : "online",
				since: Date.now(),
				runnerVersion: "0.2.0",
				warnings: [],
				turns: { max: 1, running: Number(state === "full"), queued: 0 },
				report: {
					kind: "report",
					docker: { ok: true },
					commandSandbox: { ok: true },
					sandboxes: [],
					freeDiskBytes: null,
					egress: "open",
					harnesses: [
						{ id: "claude", adapter: "claude", image: "test", signIn: state === "signed-out" ? "none" : "token" },
					],
				},
			});
		},
		// Exercise the real migration on a populated legacy table in a disposable actor.
		checkMigrateGrant: async (c: UserCtx) => {
			requireServiceFor(c, "call");
			await c.db.execute("CREATE TABLE github_grant (id INTEGER PRIMARY KEY, sealed TEXT)");
			await c.db.execute("INSERT INTO github_grant VALUES (1, 'legacy-grant')");
			assert.ok("db" in user.config);
			await user.config.db.onMigrate(c.db);
		},
		checkGithubStorage: async (c: UserCtx) => {
			requireServiceFor(c, "call");
			const tables = await c.db.execute<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
			for (const { name } of tables) {
				if (name === "github_grant") return false;
				const rows = await c.db.execute(`SELECT * FROM "${name.replaceAll('"', '""')}"`);
				// This demo actor has no other sealed credentials. Check text and blob columns.
				for (const row of rows)
					for (const value of Object.values(row)) {
						const text = value instanceof Uint8Array ? Buffer.from(value).toString() : String(value);
						if (/gh[ur]_|wlps1\./.test(text)) return false;
					}
			}
			return true;
		},
		checkGithubSync: async (c: UserCtx) => {
			requireServiceFor(c, "call");
			return (await c.db.execute<{ attempt: number }>("SELECT attempt FROM github_sync"))[0] ?? null;
		},
		// A Linear filing that reserved its key and stopped: the key is held (in memory too, as after a wake) and no item is indexed.
		checkReserveLinear: async (c: UserCtx, issueId: string, generation: number, at: number) => {
			requireServiceFor(c, "call");
			const key = `linear:${issueId}:${generation}`;
			const id = `i_${createHash("sha256")
				.update(JSON.stringify(["github", c.key[0], key]))
				.digest("hex")
				.slice(0, 16)}`;
			const { submissionOf } = await import("../server/src/submissions.js");
			const { sent } = submissionOf(key, { linear: issueId, generation })!;
			await c.db.execute(
				"INSERT INTO github_item_keys (key,sent,id,draft,created_at) VALUES (?,?,?,0,?)",
				key,
				sent,
				id,
				at,
			);
			c.vars.items.created.set("intake:" + key, { key, sent, id });
			return id;
		},
		checkInterruptedFiling: async (c: UserCtx, id: string, at: number) => {
			requireServiceFor(c, "call");
			await c.db.execute("DELETE FROM items WHERE id=?", id);
			c.vars.items.items.delete(id);
			await c.db.execute(
				"INSERT INTO github_item_keys (key,sent,id,draft,created_at) VALUES (?,?,?,1,?)",
				"fixture-" + id,
				"",
				id,
				at,
			);
		},
	});
	const actions = githubInbox.config.actions!;
	type Ctx = Parameters<typeof actions.internalReceive>[0];
	const original = HANDLERS.installation!;
	const failures = new Map<string, { attempts: number; at: number }>();
	HANDLERS.installation = (d, c) => {
		if (d.installationId !== RETRY_INSTALLATION) return original(d, c);
		const tried = failures.get(d.guid)?.attempts ?? 0;
		failures.set(d.guid, { attempts: tried + 1, at: Date.now() });
		if (d.action === "suspended" || tried < 3) throw new Error("injected failure");
	};
	Object.assign(actions, {
		checkRow: async (c: Ctx, guid: string) => {
			requireServiceFor(c, "call");
			const [r] = await c.db.execute(
				"SELECT state, said, attempts, next_at, received_at, data, CAST(repository AS TEXT) AS repository FROM deliveries WHERE guid = ?",
				guid,
			);
			return r ? { ...r, attemptedAt: failures.get(guid)?.at } : null;
		},
		checkFixture: async (c: Ctx, kind: string, guid: string) => {
			requireServiceFor(c, "call");
			if (kind === "retry") await c.db.execute("UPDATE deliveries SET next_at = 0 WHERE guid = ?", guid);
			if (kind === "expire")
				await c.db.execute("UPDATE deliveries SET received_at = ? WHERE guid = ?", Date.now() - 8 * DAY, guid);
			if (kind === "capacity") {
				const now = Date.now();
				await c.db.execute(
					`WITH RECURSIVE ns(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM ns WHERE i < 20000)
					INSERT INTO deliveries SELECT 'fixture-' || i, 'status', '', 1, '{}', ? + i,
					CASE WHEN i = 1 THEN 'failed' WHEN i = 2 THEN 'ignored' ELSE 'done' END, 1, 0, '' FROM ns`,
					now - DAY,
				);
			}
			if (kind === "full")
				await c.db.execute(
					`WITH RECURSIVE ns(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM ns WHERE i < 2000)
				INSERT INTO deliveries SELECT 'fixture-' || i, 'status', '', 1, '{}', ?, 'received', 0, ?, '' FROM ns`,
					Date.now(),
					Date.now() + DAY,
				);
		},
	});
	Object.assign(githubHooks.config.actions!, {
		checkDailyLimit: (c: Ctx, limit: number) => {
			requireServiceFor(c, "call");
			config.factory.githubItemsPerDay = limit;
		},
		checkReviewer: (c: Ctx, enabled: boolean) => {
			requireServiceFor(c, "call");
			config.factory.reviewer = enabled;
		},
		checkPlanning: (c: Ctx, enabled: boolean) => {
			requireServiceFor(c, "call");
			process.env.WLP_FACTORY_ORCHESTRATE = enabled ? "1" : "0";
		},
		checkFallback: (c: Ctx, ms: number | null) => {
			requireServiceFor(c, "call");
			if (ms === null) delete process.env.WLP_GITHUB_POLL_FALLBACK;
			else process.env.WLP_GITHUB_POLL_FALLBACK = "1";
			Object.assign(CI_POLLING, { webhookEveryMs: ms ?? 300_000 });
		},
		checkStarted: async (c: Ctx) => {
			requireServiceFor(c, "call");
			const [r] = await c.db.execute<{ at: number }>("SELECT at FROM timer");
			return r?.at ?? null;
		},
	});
	await import("../server/src/index.js");
}

const until = pollUntil(12_000);

async function run() {
	const {
		engine,
		http: [http],
	} = await localListeners();
	const api = base(http);
	let second: string;
	const storage = mkdtempSync(join(tmpdir(), "wlp-webhook-check-"));
	const standin = new GithubStandin({
		callbackUrl: api + "/github/callback",
		slug: "windlass-fk4w",
		strictBranches: false,
	});
	await standin.start();
	const secret = randomBytes(32).toString("hex"),
		previous = randomBytes(32).toString("hex");
	const bodyMarker = "private-issue-" + randomUUID();
	Object.assign(process.env, standin.env(), {
		WLP_SECRET: randomBytes(32).toString("hex"),
		WLP_GITHUB_WEBHOOK_SECRET: secret,
		WLP_GITHUB_WEBHOOK_SECRET_PREVIOUS: previous,
		WLP_SANDBOX: "fake",
		WLP_DEMO: "1",
		WLP_HTTP_PORT: String(http),
		RIVETKIT_STORAGE_PATH: storage,
		RIVET_RUN_ENGINE_PORT: String(engine),
		WLP_WEB_ORIGINS: origin,
		RIVET_LOG_LEVEL: "silent",
	});
	for (const key of ["RIVET_ADMIN_TOKEN", "RIVET_ENDPOINT", "RIVET_ENGINE", "PORT", "WLP_GITHUB_POLL_FALLBACK"])
		delete process.env[key];
	const { updateGithubAccount } = await import("../server/src/actors/github-account.js");
	const { webhookRoute } = await import("../server/src/github/webhook.js");
	const { createClient } = await import("../server/src/client.js");
	const { serviceParams } = await import("../server/src/auth.js");
	const { githubConfig } = await import("../server/src/config.js");
	const client = createClient<import("../server/src/registry.js").Registry>({ endpoint: base(engine) });
	const service = () => ({ params: serviceParams() });
	const inbox = (id: number | string) => client.githubInbox.getOrCreate([String(id)], service());
	type Row = {
		attemptedAt?: number;
		data: string;
		repository: string | null;
		state: string;
		said: string;
		attempts: number;
		next_at: number;
		received_at: number;
	};
	const fixture = (id: number | string) =>
		inbox(id) as unknown as {
			checkRow(guid: string): Promise<Row | null>;
			checkFixture(op: string, guid: string): Promise<void>;
		};
	const shaPayload = {
		installation: { id: 91234 },
		repository: { id: 123 },
		sha: HEAD,
		state: "success",
		description: bodyMarker,
	};
	const web = api + "/github/webhook";
	const send = (payload = shaPayload, guid = randomUUID(), url = web) =>
		standin.deliver(url, "status", payload, { secret, guid });
	const local = async (
		options: {
			event?: string;
			body?: string;
			signBytes?: string;
			secret?: string;
			guid?: string;
			omit?: string;
			target?: string;
			method?: string;
			url?: string;
		} = {},
	) => {
		const body = options.body ?? JSON.stringify(shaPayload);
		const headers = new Headers({
			"x-github-event": options.event ?? "status",
			"x-github-delivery": options.guid ?? randomUUID(),
			"x-github-hook-installation-target-id": options.target ?? standin.appId,
			"x-hub-signature-256":
				"sha256=" +
				createHmac("sha256", options.secret ?? secret)
					.update(options.signBytes ?? body)
					.digest("hex"),
		});
		if (options.omit) headers.delete(options.omit);
		const method = options.method ?? "POST";
		return (await webhookRoute(
			new Request(options.url ?? web, { method, headers, body: method === "POST" ? body : undefined }),
		))!;
	};
	const failed: string[] = [];
	const check = async (name: string, fn: () => Promise<void> | void) => {
		if (process.env.WEBHOOK_ONLY && !name.startsWith(process.env.WEBHOOK_ONLY)) return;
		try {
			await fn();
			console.log("PASS " + name);
		} catch (error) {
			failed.push(name);
			// Assertion messages can include the actual body or headers. Print only the check location.
			const location = error instanceof Error ? /webhook-check\.ts:(\d+:\d+)/.exec(error.stack ?? "")?.[1] : undefined;
			const timeout =
				error instanceof Error && error.message.startsWith("timed out waiting for ") ? " (" + error.message + ")" : "";
			console.error("FAIL " + name + timeout + (location ? " at webhook-check.ts:" + location : ""));
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
	let offline = false;
	// A second route process on another port shares only the engine with the platform node.
	const other = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const b of req) chunks.push(b);
		const response = offline
			? new Response(null, { status: 503 })
			: await webhookRoute(
					new Request(second, {
						method: "POST",
						headers: req.headers as Record<string, string>,
						body: Buffer.concat(chunks),
					}),
				);
		res.writeHead(response?.status ?? 404);
		res.end(await response?.text());
	});
	try {
		await new Promise<void>(resolve => other.listen(0, "127.0.0.1", resolve));
		second = base((other.address() as AddressInfo).port) + "/github/webhook";
		await until(
			"the platform HTTP port",
			async () => {
				if (child.exitCode !== null) throw new Error("test node exited " + child.exitCode);
				return (await fetch(api + "/platform/info").catch(() => null))?.ok;
			},
			90_000,
		);
		const known = (guid: string, id: number | string = shaPayload.installation.id) => inbox(id).internalKnows(guid);
		const connection = (ids: (number | string)[]) => ({
			webhookLinked: true,
			connectedAt: Date.now(),
			user: { id: 7, login: "fixture" },
			installations: ids.map(id => ({
				id,
				account: { id, login: "fixture", type: "Organization" as const },
				htmlUrl: "",
			})),
		});
		const accountContext = { client: () => client };
		await updateGithubAccount(accountContext, "fixture", null, connection([91234, 92222, 92123, 92678]));
		const absent = (e: unknown) =>
			(e as { group?: string; code?: string })?.group === "actor" && (e as { code: string }).code === "not_found";
		const owner = "g2-owner";
		standin.addUser(owner);
		const installation = standin.addInstallation(owner, "User");
		const projectG2 = standin.addRepository({ owner, name: "factory", installation });
		Object.assign(standin.appPermissions, { checks: "read", statuses: "read", actions: "read" });
		// The callback reads the installations when the ticket is made. Completing it can come later.
		const ticketFor = async (user: ReturnType<typeof client.user.getOrCreate>, login: string) => {
			const connect = await user.githubConnect({ origin });
			const back = await fetch(standin.authorize(login, connect.url), { redirect: "manual" });
			return back.headers.get("location")!.split("#github=")[1];
		};
		const authorize = async (user: ReturnType<typeof client.user.getOrCreate>, login: string) =>
			user.githubComplete(await ticketFor(user, login));
		const connectUser = async (login: string) => {
			const auth = await loginHttp(api).demo();
			const user = client.user.getOrCreate([auth.profile.uid], { params: { token: auth.token } });
			await authorize(user, login);
			return { uid: auth.profile.uid, token: auth.token, user };
		};
		const { uid, token: ownerToken, user: g2User } = await connectUser(owner);
		standin.addUser("g2-neighbour");
		const neighbour = standin.addInstallation("g2-neighbour", "User");
		standin.addRepository({ owner: "g2-neighbour", name: "other", installation: neighbour });
		const { user: neighbourUser } = await connectUser("g2-neighbour");
		const directory = () => client.githubRepository.getOrCreate([String(projectG2.id)], service());
		const push = async (title = "A webhook check") => {
			const item = await g2User.createItem({
				repository: { id: projectG2.id },
				mode: "single",
				title,
				body: "Add a short program.",
				start: true,
			});
			const handle = () => client.workItem.get([uid, item.id], service());
			const poll = () =>
				(
					handle() as unknown as { checkPoll(): Promise<{ id: string; due_at: number; effect: string } | null> }
				).checkPoll();
			const published = await until(
				"registered push",
				async () => {
					const view = await g2User.item(item.id);
					if (
						view.head &&
						view.pullRequest &&
						view.verifiedCheck &&
						(await directory().internalFind({ head: view.head, installationId: installation.id })).some(
							r => r.itemId === item.id,
						)
					)
						return { head: view.head, pr: view.pullRequest.number };
				},
				45_000,
			);
			return { ...published, id: item.id, handle, poll, view: () => g2User.item(item.id) };
		};
		const delivered = async (
			event: string,
			fields: object,
			id: number | string = installation.id,
			guid = randomUUID(),
		) => {
			const res = await standin.deliver(
				web,
				event,
				{ installation: { id }, repository: { id: projectG2.id, name: "decoy", owner: { login: "decoy" } }, ...fields },
				{ secret, guid },
			);
			assert.deepEqual(await res.json(), { taken: true });
			return until("handled " + event, async () => {
				const row = await fixture(id).checkRow(guid);
				return row && ["done", "ignored"].includes(row.state) ? row : null;
			});
		};
		const hasRepo = async (user: typeof g2User, id: number, fresh = false) =>
			(await user.githubRepositories("", fresh)).repositories.some(r => r.id === id);
		const accountsOf = async (user: typeof g2User) =>
			((await user.github()).connection?.accounts ?? []).map(a => String(a.installationId));
		const hooks = client.githubHooks.getOrCreate(["app"], service());
		const accountFixture = (id: number) =>
			client.githubAccount.getOrCreate([String(id)], service()) as unknown as {
				internalWho(): Promise<{ uid: string; installations: (number | string)[] } | null>;
				checkFailRefresh(times: number): Promise<void>;
				checkRefreshCalls(): Promise<number>;
			};
		const syncRow = (id: string) =>
			(
				client.user.get([id], service()) as unknown as { checkGithubSync(): Promise<{ attempt: number } | null> }
			).checkGithubSync();
		const uninstalled = async (installation: { id: number; account: object }) => {
			standin.uninstall(installation as Parameters<typeof standin.uninstall>[0]);
			await delivered(
				"installation",
				{ action: "deleted", installation: { id: installation.id, account: installation.account } },
				installation.id,
			);
		};
		await check("connect revokes the user token and keeps no grant in the user actor", async () => {
			const tokens = [...standin.tokens.values()].filter(
				t => t.kind === "user" && t.user === standin.users.get(owner)!.id,
			);
			assert.equal(tokens.length, 1);
			assert.ok(tokens[0].refreshToken && tokens[0].revoked);
			const probe = client.user.get([uid], service()) as unknown as {
				checkGithubStorage(): Promise<boolean>;
				checkMigrateGrant(): Promise<void>;
			};
			assert.equal(await probe.checkGithubStorage(), true);
			await probe.checkMigrateGrant();
			assert.equal(await probe.checkGithubStorage(), true);
		});
		await check("installation access follows the signed sender and removals reach every linked user", async () => {
			const org = standin.addInstallation("hook-org", "Organization");
			const repo = standin.addRepository({
				owner: org.account.login,
				name: "private",
				private: true,
				installation: org,
			});
			const hidden = standin.addRepository({
				owner: org.account.login,
				name: "hidden",
				private: true,
				installation: org,
			});
			repo.access.set(owner, "write");
			const stranger = standin.addUser("unconnected-installer");
			const sender = standin.users.get(owner)!;
			const neighbourSender = standin.users.get("g2-neighbour")!;
			const hasAccount = async (user: typeof g2User) =>
				(await user.github()).connection!.accounts.some(a => a.installationId === org.id);
			const fields = (action: string, by: typeof sender) => ({
				action,
				installation: { id: org.id, account: org.account },
				sender: by,
				...(action === "added" && { repositories_added: [{ id: repo.id }] }),
				...(action === "removed" && { repositories_removed: [{ id: repo.id }] }),
			});
			const event = (name: string, action: string, by: typeof sender) => delivered(name, fields(action, by), org.id);
			try {
				// A login can change. Even a connected user's login paired with another ID attaches nothing.
				await event("installation", "created", { ...stranger, login: owner });
				assert.equal(await hasAccount(g2User), false);
				assert.equal(await hasAccount(neighbourUser), false);
				const bad = await standin.deliver(web, "installation", fields("created", sender), { secret: "wrong-secret" });
				assert.equal(bad.status, 401);
				assert.equal(await hasAccount(g2User), false);
				const guid = randomUUID();
				await delivered("installation", fields("created", sender), org.id, guid);
				// The ordinary picker sees the new repository immediately and still filters unreadable ones.
				assert.ok(await hasAccount(g2User));
				assert.equal(await hasRepo(g2User, hidden.id), false);
				assert.equal(await hasAccount(neighbourUser), false);
				assert.ok(await hasRepo(g2User, repo.id));
				await event("installation", "new_permissions_accepted", neighbourSender);
				assert.ok(await hasAccount(neighbourUser));
				assert.equal(await hasRepo(neighbourUser, repo.id), false);
				org.suspended = true;
				await event("installation", "suspend", stranger);
				for (const user of [g2User, neighbourUser]) assert.equal(await hasAccount(user), false);
				org.suspended = false;
				// Replaying an already handled creation after removal cannot restore access.
				const duplicate = await standin.deliver(web, "installation", fields("created", sender), { secret, guid });
				assert.deepEqual(await duplicate.json(), { taken: "duplicate" });
				assert.equal(await hasAccount(g2User), false);
				await event("installation", "unsuspend", sender);
				assert.ok(await hasRepo(g2User, repo.id));
				await event("installation_repositories", "added", neighbourSender);
				assert.ok(await hasAccount(neighbourUser));
				org.repositories.delete(repo.id);
				await event("installation_repositories", "removed", stranger);
				for (const user of [g2User, neighbourUser]) assert.ok(await hasAccount(user));
				assert.equal(await hasRepo(g2User, repo.id), false);
				org.repositories.add(repo.id);
				await event("installation_repositories", "added", sender);
				await event("installation", "created", neighbourSender);
				assert.ok(await hasRepo(g2User, repo.id));
				assert.ok(await hasAccount(neighbourUser));
				standin.uninstall(org);
				await event("installation", "deleted", stranger);
				for (const user of [g2User, neighbourUser]) assert.equal(await hasAccount(user), false);
				assert.equal(await hasRepo(g2User, repo.id), false);
			} finally {
				standin.uninstall(org);
			}
		});
		await check("a personal installation attaches only to the platform user who owns that GitHub account", async () => {
			const personal = standin.addInstallation("g2-neighbour", "User");
			const ownerId = standin.users.get(owner)!.id;
			try {
				// A connected user sends the event for somebody else's personal account.
				await delivered(
					"installation",
					{
						action: "created",
						installation: { id: personal.id, account: personal.account },
						sender: standin.users.get(owner)!,
					},
					personal.id,
				);
				assert.ok((await accountsOf(neighbourUser)).includes(String(personal.id)));
				assert.equal((await accountsOf(g2User)).includes(String(personal.id)), false);
				// The user actor refuses it as well, even when the sender is its own GitHub user.
				await client.user.get([uid], service()).internalUpdateGithubInstallation({
					kind: "attach",
					installation: { id: personal.id, account: personal.account, htmlUrl: "" },
					senderId: ownerId,
				});
				assert.equal((await accountsOf(g2User)).includes(String(personal.id)), false);
				assert.equal((await hooks.internalInstallationUsers(personal.id)).includes(uid), false);
			} finally {
				await uninstalled(personal);
			}
			assert.equal((await accountsOf(neighbourUser)).includes(String(personal.id)), false);
		});
		await check("a repository removal keeps the installation and drops only the listed repository", async () => {
			const org = standin.addInstallation("partial-org", "Organization");
			const gone = standin.addRepository({ owner: org.account.login, name: "gone", private: true, installation: org });
			const kept = standin.addRepository({ owner: org.account.login, name: "kept", private: true, installation: org });
			for (const repo of [gone, kept]) repo.access.set(owner, "write");
			const sender = standin.users.get(owner)!;
			try {
				await delivered(
					"installation",
					{ action: "created", installation: { id: org.id, account: org.account }, sender },
					org.id,
				);
				assert.ok((await hasRepo(g2User, gone.id)) && (await hasRepo(g2User, kept.id)));
				org.repositories.delete(gone.id);
				// No fresh read is asked for: the event alone discards the cached list on every server.
				await delivered(
					"installation_repositories",
					{
						action: "removed",
						installation: { id: org.id, account: org.account },
						sender,
						repositories_removed: [{ id: gone.id }],
					},
					org.id,
				);
				assert.ok((await accountsOf(g2User)).includes(String(org.id)));
				assert.ok((await hooks.internalInstallationUsers(org.id)).includes(uid));
				assert.equal(await hasRepo(g2User, gone.id), false);
				assert.ok(await hasRepo(g2User, kept.id));
				assert.ok((await accountFixture(sender.id).internalWho())?.installations.map(String).includes(String(org.id)));
			} finally {
				await uninstalled(org);
			}
			assert.equal((await accountsOf(g2User)).includes(String(org.id)), false);
		});
		await check("a failed account-link refresh after a removal is retried with bounded backoff", async () => {
			const person = standin.addUser("retry-user");
			const own = standin.addInstallation(person.login, "User");
			standin.addRepository({ owner: person.login, name: "retried", installation: own });
			const { uid: id, user } = await connectUser(person.login);
			const account = accountFixture(person.id);
			assert.deepEqual((await account.internalWho())?.installations.map(String), [String(own.id)]);
			// Every try fails: one immediate try and three retries, then the series stops.
			await account.checkFailRefresh(100);
			await delivered(
				"installation_repositories",
				{
					action: "removed",
					installation: { id: own.id, account: own.account },
					sender: person,
					repositories_removed: [],
				},
				own.id,
			);
			assert.ok(await syncRow(id));
			await until("the retries to stop", async () => (await syncRow(id)) === null);
			assert.equal(await account.checkRefreshCalls(), 4);
			await sleep(1_000);
			assert.equal(await account.checkRefreshCalls(), 4);
			// Two failures, then a retry succeeds and the account link no longer names the removed installation.
			await account.checkFailRefresh(2);
			await uninstalled(own);
			assert.deepEqual(await accountsOf(user), []);
			assert.deepEqual(await hooks.internalInstallationUsers(own.id), []);
			await until(
				"the account link to drop the installation",
				async () => (await account.internalWho())?.installations.length === 0,
			);
			assert.equal(await account.checkRefreshCalls(), 3);
			assert.equal(await syncRow(id), null);
			await user.githubDisconnect();
		});
		await check("an uninstall delivered while a user connects leaves no access in either order", async () => {
			const person = standin.addUser("race-user");
			const auth = await loginHttp(api).demo();
			const user = client.user.getOrCreate([auth.profile.uid], { params: { token: auth.token } });
			const id = auth.profile.uid;
			const noAccess = async (installation: number) => {
				assert.equal((await accountsOf(user)).includes(String(installation)), false);
				assert.equal((await hooks.internalInstallationUsers(installation)).includes(id), false);
				assert.equal(
					(await accountFixture(person.id).internalWho())?.installations.map(String).includes(String(installation)),
					false,
				);
			};
			// The removal is recorded first. The ticket's list was read before the uninstall and is completed after it.
			const first = standin.addInstallation(person.login, "User");
			const stale = await ticketFor(user, person.login);
			await uninstalled(first);
			await user.githubComplete(stale);
			await noAccess(first.id);
			// The link is made first. The removal then finds the linked user.
			const second = standin.addInstallation(person.login, "User");
			const current = await ticketFor(user, person.login);
			await user.githubComplete(current);
			assert.ok((await accountsOf(user)).includes(String(second.id)));
			await uninstalled(second);
			await noAccess(second.id);
			await user.githubDisconnect();
		});
		await check(
			"installation picker reload reads known installations and reconnect discovers someone else's installation",
			async () => {
				const person = standin.addUser("picker-user");
				const own = standin.addInstallation(person.login, "User");
				const { user } = await connectUser(person.login);
				assert.deepEqual((await user.githubRepositories("")).repositories, []);
				const added = standin.addRepository({ owner: person.login, name: "added", installation: own });
				const org = standin.addInstallation("picker-org", "Organization");
				const repo = standin.addRepository({
					owner: org.account.login,
					name: "private",
					private: true,
					installation: org,
				});
				repo.access.set(person.login, "read");
				try {
					const before = standin.requests.length;
					const list = await user.githubRepositories("", true);
					assert.deepEqual(
						list.repositories.map(r => r.id),
						[added.id],
					);
					const calls = standin.requests.slice(before);
					assert.ok(calls.some(r => r.auth === "installation" && r.path.includes("/installation/repositories")));
					assert.ok(
						calls.every(
							r => r.auth !== "user" && !r.path.includes("/user/installations") && !r.path.includes("/login/oauth"),
						),
					);
					await authorize(user, person.login);
					assert.ok(await hasRepo(user, repo.id));
					repo.access.delete(person.login);
					assert.equal(await hasRepo(user, repo.id, true), false);
				} finally {
					await user.githubDisconnect();
					standin.uninstall(org);
				}
			},
		);
		const countReads = (head: string) =>
			standin.requests.filter(r => r.path.includes("/commits/" + head + "/check-runs")).length;
		const ci = (head: string, state: string) =>
			projectG2.ci.set(head, { runs: [], statuses: [{ context: "required", state }] });
		const waitForWrites = async (id: string) => {
			const probe = client.workItem.get([uid, id], service()) as unknown as { checkPendingWrites(): Promise<boolean> };
			await until("finished check writes", async () => !(await probe.checkPendingWrites()));
		};
		const stop = async (id: string) => {
			await g2User.actOnItem({ id, action: { kind: "cancel" } });
			await waitForWrites(id);
		};
		await check("verified completions never wake a waiting item", async () => {
			const item = await push();
			const before = await item.poll();
			const taken = [];
			for (const event of ["check_run", "check_suite"]) {
				const res = await standin.deliver(
					web,
					event,
					{
						installation: { id: installation.id },
						repository: { id: projectG2.id },
						action: "completed",
						[event]: { head_sha: item.head, app: { id: standin.appId, slug: "old-slug" } },
					},
					{ secret },
				);
				taken.push(await res.json());
			}
			assert.deepEqual(taken, [{ taken: false }, { taken: false }]);
			assert.deepEqual(await item.poll(), before);
			await stop(item.id);
		});
		await check("verified publication, recovery after a lost POST reply, and a foreign push", async () => {
			standin.appPermissions.checks = "write";
			standin.checkFault = "lose_reply";
			const item = await push();
			try {
				const onHead = () => standin.checks.filter(r => r.repository === projectG2.id && r.head_sha === item.head);
				await until(
					"adopted pending check",
					async () => (await item.view()).verifiedCheck?.state === "in_progress",
					30_000,
				);
				assert.equal(onHead().length, 1);
				const pending = onHead()[0];
				assert.equal(pending.name, "windlass/verified");
				assert.equal(pending.status, "in_progress");
				assert.equal(pending.external_id, "pending:" + item.id + ":1");
				assert.ok(standin.requests.some(r => r.method === "PATCH" && r.path.endsWith("/check-runs/" + pending.id)));
				assert.ok(
					standin.minted.some(
						t =>
							t.repositoryIds?.join() === String(projectG2.id) &&
							JSON.stringify(t.permissions) === JSON.stringify({ metadata: "read", checks: "write" }),
					),
				);
				ci(item.head, "success");
				await delivered("status", { sha: item.head, state: "success" });
				await until(
					"successful check",
					async () => (await item.view()).verifiedCheck?.conclusion === "success",
					25_000,
				);
				const v = await item.view();
				assert.equal(onHead().length, 1);
				assert.equal(pending.external_id, v.verdicts.at(-1)?.id);
				assert.equal(pending.details_url, origin + "/items/" + item.id);
				assert.match(pending.output.summary, /Ready for review/);
				assert.ok(!JSON.stringify(pending.output).includes(v.task.title));
				const original = structuredClone(pending);
				const pull = standin.pulls.find(p => p.repository === projectG2.id && p.number === item.pr)!;
				const foreign = "d".repeat(40);
				pull.headSha = foreign;
				await delivered("pull_request", {
					action: "synchronize",
					pull_request: { number: item.pr, merged: false, head: { sha: foreign } },
				});
				await until(
					"foreign head explicitly blocked",
					async () => (await item.view()).verifiedCheck?.conclusion === "action_required",
					25_000,
				);
				assert.ok(standin.checks.some(r => r.head_sha === foreign && r.conclusion === "action_required"));
				assert.deepEqual(onHead(), [original]);
				assert.ok(
					(await directory().internalFind({ head: foreign, installationId: installation.id })).some(
						r => r.itemId === item.id,
					),
				);
				pull.headSha = item.head;
				await delivered("pull_request", {
					action: "synchronize",
					pull_request: { number: item.pr, merged: false, head: { sha: item.head } },
				});
				await until(
					"original commit verified again",
					async () => {
						const view = await item.view();
						return (
							view.verifiedCheck?.sha === item.head &&
							view.verifiedCheck.conclusion === "success" &&
							view.verdicts.at(-1)?.moved === null &&
							pending.completed_at !== original.completed_at
						);
					},
					25_000,
				);
				await g2User.actOnItem({ id: item.id, action: { kind: "send_back", note: "Private owner feedback" } });
				await until("handed check reopened for rework", async () =>
					standin.requests.some(
						r =>
							r.method === "PATCH" &&
							r.path.endsWith("/check-runs/" + pending.id) &&
							(r.body as { output?: { title: string } }).output?.title === "Sent back: being reworked in run 2",
					),
				);
				await stop(item.id);
				await until("cancelled check", async () =>
					standin.checks.some(r => r.head_sha === item.head && r.conclusion === "cancelled"),
				);
			} finally {
				if ((await item.view()).state !== "cancelled") await stop(item.id);
				standin.checkFault = null;
				standin.appPermissions.checks = "read";
			}
		});
		await check("verified read-only installation still hands over and logs once after two pushes", async () => {
			installation.permissions = { ...standin.appPermissions, checks: "read" };
			standin.appPermissions.checks = "write";
			const item = await push();
			try {
				const pull = standin.pulls.find(p => p.repository === projectG2.id && p.number === item.pr)!;
				ci(item.head, "failure");
				await delivered("status", { sha: item.head, state: "failure" });
				await until(
					"second push",
					async () => (await item.view()).events.filter(e => e.said.startsWith("Pushed ")).length === 2,
					35_000,
				);
				ci(item.head, "success");
				await delivered("status", { sha: item.head, state: "success" });
				await until(
					"handoff without Checks write",
					async () =>
						pull.requestedReviewers.includes(owner) &&
						pull.comments.some(c => c.body.startsWith("<!-- windlass-item:" + item.id + " -->")),
					25_000,
				);
				const view = await item.view();
				assert.equal(view.verdict?.result, "pass");
				assert.equal(view.verifiedCheck?.state, "not_posted");
				assert.equal(view.events.filter(e => e.said === view.verifiedCheck?.said).length, 1);
				assert.equal(
					logs.split(`github.verified_check.not_permitted installation=${installation.id} item=${item.id}`).length - 1,
					1,
				);
				assert.ok(!standin.checks.some(r => r.external_id.includes(item.id)));
			} finally {
				await stop(item.id);
				delete installation.permissions;
				standin.appPermissions.checks = "read";
			}
		});
		await check("verified permission refusals on token and create finish the effect", async () => {
			standin.appPermissions.checks = "write";
			try {
				for (const [step, status] of [
					["token", 403],
					["create", 403],
					["create", 422],
				] as const) {
					standin.checkTokenFault = step === "token" ? status : null;
					standin.checkFault = step === "create" ? status : null;
					const item = await push();
					await until("refused pending check", async () => (await item.view()).verifiedCheck?.state === "not_posted");
					await stop(item.id);
					const view = await item.view();
					assert.equal(view.events.filter(e => e.said === view.verifiedCheck?.said).length, 1);
					assert.ok(!standin.checks.some(r => r.external_id.includes(item.id)));
				}
			} finally {
				standin.checkTokenFault = null;
				standin.checkFault = null;
				standin.appPermissions.checks = "read";
			}
		});
		await check("verified Re-run reads finished CI after a pending handover", async () => {
			standin.appPermissions.checks = "write";
			const item = await push();
			try {
				projectG2.ci.set(item.head, {
					runs: [],
					statuses: [],
					workflows: [{ status: "in_progress", updated_at: new Date(Date.now() - 7 * 3_600_000).toISOString() }],
				});
				await delivered("status", { sha: item.head, state: "success" });
				await until("automatic wait on pending CI", async () => (await item.view()).run?.autoSteps === 1, 25_000);
				await delivered("status", { sha: item.head, state: "success" });
				const q = await until("CI timeout question", async () => (await item.view()).question, 25_000);
				await g2User.actOnItem({ id: item.id, action: { kind: "answer", question: q.id, choice: "hand_over" } });
				await until(
					"unfinished handover check",
					async () => (await item.view()).verifiedCheck?.conclusion === "action_required",
				);
				const run = standin.checks.find(r => r.head_sha === item.head)!;
				const external = run.external_id;
				ci(item.head, "success");
				await delivered("check_run", { action: "rerequested", check_run: run });
				await until(
					"Re-run observed finished CI",
					async () => (await item.view()).verifiedCheck?.conclusion === "success",
				);
				assert.equal(run.external_id, external);
				assert.equal(standin.checks.filter(r => r.head_sha === item.head).length, 1);
			} finally {
				await stop(item.id);
				standin.appPermissions.checks = "read";
			}
		});
		for (const outcome of ["passes", "fails twice", "mixed failures", "inherited"] as const)
			await check("G2 flaky re-run " + outcome, async () => {
				const name = outcome === "inherited" ? "unit" : "e2e (macos)";
				standin.appPermissions.actions = "write";
				const item = await push();
				const pull = standin.pulls.find(p => p.repository === projectG2.id && p.number === item.pr)!;
				pull.headSha = item.head;
				const workflow = 1000 + item.pr,
					suite = 2000 + item.pr;
				const job = (id: number, name: string, conclusion: string) => ({
					id,
					name,
					conclusion,
					status: "completed",
					app: { slug: "github-actions" },
					check_suite: { id: suite },
				});
				const old = job(workflow * 10, name, "failure");
				const base = standin.branchHead(projectG2, pull.base)!;
				const beforeBase = projectG2.ci.get(base);
				const postCount = () =>
					standin.requests.filter(r => r.method === "POST" && r.path.endsWith(`/runs/${workflow}/rerun-failed-jobs`))
						.length;
				const clock = item.handle() as unknown as { checkAdvance(kind: "poll", ms: number): Promise<void> };
				try {
					projectG2.ci.set(base, {
						runs: [job(1, name, outcome === "inherited" ? "failure" : "success")],
						statuses: [],
					});
					const runs = [old];
					if (outcome === "mixed failures") runs.push(job(old.id + 1, "lint", "failure"));
					projectG2.ci.set(item.head, {
						runs,
						statuses: [],
						workflows: [{ id: workflow, check_suite_id: suite, status: "completed" }],
					});
					for (const check of runs)
						projectG2.jobs.set(String(check.id), {
							...check,
							head_sha: item.head,
							run_id: workflow,
							runner_id: 1,
							runner_name: "runner",
							steps: [],
						});
					await delivered("check_suite", { action: "completed", check_suite: { head_sha: item.head } });
					await until(
						"re-run recorded",
						async () =>
							(await item.view()).events.some(e => e.said.includes(`Requested one re-run of failed CI job ${name}.`)),
						30_000,
					);
					const first = await item.poll();
					await clock.checkAdvance("poll", 0);
					await until("stale failure polled again", async () => {
						const row = await item.poll();
						return row && row.id !== first?.id;
					});
					assert.equal((await item.view()).run?.rounds.ci, 0);
					runs.push(job(old.id + 2, name, outcome === "fails twice" ? "failure" : "success"));
					if (outcome === "mixed failures") runs.push(job(old.id + 3, "lint", "failure"));
					await clock.checkAdvance("poll", 0);
					if (outcome === "fails twice" || outcome === "mixed failures") {
						await until("CI fix after failed re-run", async () => (await item.view()).run?.rounds.ci === 1);
					} else {
						await until("green CI on the original head", async () => (await item.view()).verdict?.ci === "passed");
						assert.equal((await item.view()).run?.rounds.ci, 0);
						pull.state = "closed";
						pull.merged = true;
						await clock.checkAdvance("poll", 0);
						const record = await until("merged item record", async () => (await item.view()).record);
						assert.ok(record.clean && !record.ciFix && !record.fixed);
					}
					assert.equal(postCount(), 1);
				} finally {
					if (beforeBase) projectG2.ci.set(base, beforeBase);
					else projectG2.ci.delete(base);
					standin.appPermissions.actions = "read";
					if ((await item.view()).state !== "done") await stop(item.id);
				}
			});
		await check("G2 signed CI and PR nudges, coalescing, installation isolation and live readings", async () => {
			const item = await push();
			const first = await item.poll();
			assert.ok(first);
			const initial = await item.view();
			assert.equal(first.due_at - initial.events.find(e => e.said.startsWith("Pushed "))!.at, 60_000);
			const suite = (head: string) => ({ action: "completed", check_suite: { head_sha: head, conclusion: "success" } });
			const foreign = neighbour.id;
			await directory().internalRegister({
				uid,
				itemId: "i_missing",
				head: "f".repeat(40),
				installationId: installation.id,
			});
			const calls = standin.requests.length;
			assert.equal((await delivered("check_suite", suite("f".repeat(40)))).said, "no item");
			assert.deepEqual(await directory().internalFind({ head: "f".repeat(40) }), []);
			assert.equal((await delivered("check_suite", suite(item.head), foreign)).said, "no item");
			assert.deepEqual(await directory().internalFind({ head: item.head, installationId: foreign }), []);
			const target = {
				kind: "ci" as const,
				repositoryId: projectG2.id,
				installationId: installation.id,
				head: item.head,
			};
			assert.equal(await item.handle().internalGithubNudge({ ...target, installationId: foreign }), false);
			assert.equal(await item.handle().internalGithubNudge({ ...target, head: "f".repeat(40) }), false);
			assert.deepEqual(await item.poll(), first);
			assert.equal((await item.view()).revision, initial.revision);
			assert.equal(standin.requests.length, calls);
			console.log(
				"PASS G2 other SHA and linked foreign installation leave the waiting row intact and make zero GitHub calls",
			);

			projectG2.name = "renamed-factory";
			ci(item.head, "pending");
			const handled = await delivered("check_suite", suite(item.head));
			assert.equal(handled.state, "done");
			const early = await item.poll();
			assert.ok(early);
			assert.deepEqual({ ...early, due_at: first.due_at }, first);
			assert.ok(early.due_at >= handled.received_at + 15_000 && early.due_at < first.due_at);
			assert.equal((await item.view()).revision, initial.revision);
			await until(
				"one pending live CI read",
				async () => (await item.view()).wait?.sentence.includes("0 of 1"),
				20_000,
			);
			assert.equal(countReads(item.head), 1);
			assert.ok(standin.requests.some(r => r.path.endsWith("/repositories/" + projectG2.id) && r.status === 200));
			assert.ok(
				standin.requests.some(r => r.path.includes("/renamed-factory/commits/" + item.head) && r.status === 200),
			);
			console.log("PASS G2 signed suite caused one live CI read; claimed success, GitHub pending");

			const beforeBurst = await item.poll();
			assert.ok(beforeBurst);
			const guids = Array.from({ length: 30 }, () => randomUUID());
			const burst = guids.map(guid =>
				standin.deliver(
					web,
					"check_run",
					{
						installation: { id: installation.id },
						repository: { id: projectG2.id },
						action: "completed",
						check_run: { head_sha: item.head, conclusion: "failure" },
					},
					{ secret, guid },
				),
			);
			for (const res of await Promise.all(burst)) assert.deepEqual(await res.json(), { taken: true });
			const receipts = await Promise.all(guids.map(guid => fixture(installation.id).checkRow(guid)));
			const times = receipts.map(row => {
				assert.ok(row);
				return row.received_at;
			});
			const coalesced = await until("burst nudged the pending poll", async () => {
				const row = await item.poll();
				return row?.id === beforeBurst.id && row.due_at < beforeBurst.due_at ? row : null;
			});
			assert.ok(coalesced.due_at >= Math.min(...times) + 15_000 && coalesced.due_at <= Math.max(...times) + 17_000);
			await until("all thirty deliveries handled", async () =>
				(await Promise.all(guids.map(guid => fixture(installation.id).checkRow(guid)))).every(r => r?.state === "done"),
			);
			await until("burst CI read", async () => countReads(item.head) >= 2, 20_000);
			const fallback = await until("next CI poll stored", async () => {
				const row = await item.poll();
				return row && row.id !== coalesced.id ? row : null;
			});
			assert.equal(countReads(item.head), 2);
			assert.equal(fallback.due_at, JSON.parse(fallback.effect).at, "no delivery nudged a second poll");
			assert.equal(logs.split("factory.ci.nudge_found item=" + item.id).length - 1, 1);
			console.log("PASS G2 thirty signed check runs coalesced into one more read");

			ci(item.head, "success");
			assert.equal((await delivered("status", { sha: item.head, state: "failure" })).state, "done");
			const review = await until(
				"live CI passed",
				async () => {
					const v = await item.view();
					return v.state === "review" ? v : null;
				},
				20_000,
			);
			assert.equal(review.verdict?.ci, "passed");
			const closed = { action: "closed", pull_request: { number: item.pr, merged: true, head: { sha: item.head } } };
			const prPoll = await item.poll();
			assert.ok(prPoll);
			await delivered("pull_request", closed);
			await until("live PR still open", async () => (await item.poll())?.id !== prPoll.id, 20_000);
			assert.equal((await item.view()).state, "review");
			const pull = standin.pulls.find(p => p.repository === projectG2.id && p.number === item.pr)!;
			pull.state = "closed";
			pull.merged = true;
			await delivered("pull_request", closed);
			await until("fetched merge", async () => (await item.view()).state === "done", 20_000);
			await until("directory removal", async () => !(await directory().internalFind({ pr: item.pr })).length);
			const rev = (await item.view()).revision;
			assert.equal(await item.handle().internalGithubNudge(target), false);
			assert.equal((await delivered("pull_request", closed)).said, "no item");
			assert.equal((await item.view()).revision, rev);
			console.log("PASS G2 open PR stayed in review; fetched merge ended item and removed its binding");
		});
		await check("G2 webhook fallback reaches review with zero deliveries", async () => {
			const clock = () =>
				client.githubHooks.getOrCreate(["app"], service()) as unknown as {
					checkFallback(ms: number | null): Promise<void>;
				};
			await clock().checkFallback(3500);
			try {
				const sent = standin.deliveries.length;
				projectG2.name = "factory";
				const item = await push();
				const first = await item.poll();
				assert.ok(first);
				const view = await item.view();
				assert.equal(first.due_at - view.events.find(e => e.said.startsWith("Pushed "))!.at, 3500);
				ci(item.head, "success");
				await until("fallback read hands off", async () => (await item.view()).verdict?.ci === "passed", 12_000);
				assert.equal(countReads(item.head), 1);
				assert.equal(standin.deliveries.length, sent);
			} finally {
				await clock().checkFallback(null);
			}
		});
		const { taskOfIssue } = await import("../server/src/factory/intake.js");
		const writer = standin.users.get(owner)!;
		const reader = standin.addUser("g3-reader"),
			peer = standin.addUser("g3-writer"),
			stranger = standin.addUser("g3-stranger");
		projectG2.access.set(reader.login, "read");
		projectG2.access.set(peer.login, "write");
		projectG2.access.set(stranger.login, "write");
		const readerAccount = await connectUser(reader.login),
			peerAccount = await connectUser(peer.login);
		standin.appPermissions.issues = "write";
		const make = (number: number, author = writer) => standin.addIssue(projectG2, number, author);
		type Issue = ReturnType<typeof make>;
		const payload = (issue: Issue, sender = writer) => ({
			issue: {
				number: issue.number,
				title: "Decoy title",
				body: "Decoy body",
				user: sender,
				author_association: "OWNER",
			},
			sender: { ...sender, type: "User" },
		});
		const notify = (issue: Issue, action: string, sender = writer, installationId = installation.id) =>
			delivered("issues", { ...payload(issue, sender), action, label: { name: "windlass" } }, installationId);
		const change = async (issue: Issue, action: string, sender = writer) => {
			standin.issueEvent(issue, action, sender);
			await notify(issue, action, sender);
		};
		const applyLabel = async (issue: Issue, name: string, sender = writer) => {
			const labels = new Set(issue.labels);
			standin.issueEvent(issue, "labeled", sender);
			issue.labels = [...labels.add(name)];
			issue.events.at(-1)!.label = { name };
			await delivered("issues", { ...payload(issue, sender), action: "labeled", label: { name } });
		};
		const mention = (issue: Issue, id: bigint, sender = writer) =>
			delivered("issue_comment", {
				...payload(issue, sender),
				action: "created",
				comment: { id, body: "@windlass-fk4w payload words", author_association: "OWNER", user: sender },
			});
		const items = async (issue: Issue, account = g2User) =>
			(await account.listItems()).filter(i => i.origin?.issue?.number === issue.number);
		const newWriter = async (login: string) => {
			const person = standin.addUser(login);
			projectG2.access.set(login, "write");
			return { person, account: (await connectUser(login)).user };
		};
		const issueReactions = (issue: Issue) => {
			const base = `/api/v3/repos/${owner}/factory/issues`;
			const paths = [
				`${base}/${issue.number}/reactions`,
				...issue.comments.map(c => `${base}/comments/${c.id}/reactions`),
			];
			return standin.requests.filter(r => paths.includes(r.path));
		};
		const bots = (issue: Issue) => issue.comments.filter(c => c.user.login.endsWith("[bot]"));
		type FeedbackClock = {
			checkAdvance(kind: "feedback" | "poll" | "idle", ms: number): Promise<void>;
			checkWindow(): Promise<number>;
		};
		const feedbackItem = async (ownerPush = false, title?: string) => {
			const item = await push(title);
			const clock = () => item.handle() as unknown as FeedbackClock;
			const pull = standin.pulls.find(p => p.repository === projectG2.id && p.number === item.pr)!;
			if (ownerPush)
				pull.headSha = standin.commit(
					projectG2,
					pull.head,
					{ "README.md": "# Updated by owner\n" },
					"Owner update",
					projectG2.defaultBranch,
				);
			ci(item.head, "success");
			await clock().checkAdvance("poll", 0);
			await until(
				"first handoff",
				async () =>
					pull.comments.some(c => c.body.startsWith("<!-- windlass-item:")) && (await item.view()).state === "review",
			);
			return { ...item, clock, pull };
		};
		const reviewFields = (pr: number, review: ReturnType<typeof standin.submitReview>["review"]) => ({
			action: "submitted",
			sender: review.user,
			pull_request: { number: pr },
			review: { ...review, body: "/windlass decoy webhook text" },
		});
		const commentFields = (pr: number, id: number, sender = writer, association = "OWNER") => ({
			action: "created",
			issue: { number: pr, pull_request: {} },
			sender: { ...sender, type: "User" },
			comment: { id, author_association: association, body: "/windlass decoy webhook text" },
		});
		const prComment = (pull: (typeof standin.pulls)[number], id: number, author: typeof writer, body: string) => {
			pull.comments.push({ id, body, user: { ...author, type: "User" }, created_at: new Date().toISOString() });
			return delivered("issue_comment", commentFields(pull.number, id, author));
		};
		const reviewerSettings = () =>
			client.githubHooks.getOrCreate(["app"], service()) as unknown as {
				checkReviewer(enabled: boolean): Promise<void>;
			};
		await check("G4 requested PR review uses the default Windlass model on the selected machine", async () => {
			const machines = client.user.get([uid], service()) as unknown as {
				checkPlaceMachine(id: string, state: string): Promise<void>;
			};
			const place = { kind: "machine" as const, machineId: "m_0000000000000042" };
			await machines.checkPlaceMachine(place.machineId, "online");
			await reviewerSettings().checkReviewer(true);
			try {
				const item = await g2User.createItem({
					repository: { id: projectG2.id },
					mode: "single",
					title: "Machine review",
					body: "Review a change.",
					start: false,
					place,
					harness: "claude",
					profile: "docker-hardened",
				});
				const view = await g2User.item(item.id);
				assert.ok(view.reviewerSessionId);
				const reviewer = (
					await client.agentSession.get([uid, view.reviewerSessionId], { params: { token: ownerToken } }).snapshot()
				).summary;
				assert.deepEqual(reviewer.place, place);
				assert.equal(reviewer.harness ?? "windlass", "windlass");
				assert.equal(reviewer.profile, "docker-hardened");
				assert.equal(reviewer.model, (await g2User.models()).defaultModel);
			} finally {
				await reviewerSettings().checkReviewer(process.env.WLP_FACTORY_REVIEWER === "on");
				await machines.checkPlaceMachine(place.machineId, "removed");
			}
		});
		for (const feature of [false, true])
			await check(
				"G4 requested PR review " + (feature ? "on a feature by a writer" : "on an item by its owner"),
				async () => {
					await reviewerSettings().checkReviewer(true);
					try {
						const item = await feedbackItem(true);
						try {
							if (feature)
								await (item.handle() as unknown as { checkFinishedFeature(): Promise<void> }).checkFinishedFeature();
							const before = await item.view();
							const head = item.pull.headSha!;
							const author = feature ? peer : writer;
							const commentId = 66160 + item.pr * 4;
							const reviewer = client.agentSession.get([uid, before.reviewerSessionId!], {
								params: { token: ownerToken },
							});
							const initialTurns = (await reviewer.snapshot()).summary.turns;
							await prComment(item.pull, commentId, reader, "/windlass review");
							await prComment(item.pull, commentId + 1, author, "/windlass review");
							item.pull.headSha = standin.commit(
								projectG2,
								item.pull.head,
								{ "README.md": "# A later commit\n" },
								"Another update",
								item.pull.head,
							);
							await delivered("issue_comment", commentFields(item.pr, commentId + 1, author));
							const posted = await until(
								"requested review on the updated head",
								async () =>
									standin.reviews.find(r => r.pr === item.pr && r.review.body.startsWith("<!-- windlass-review:")),
								30_000,
							);
							assert.equal(posted.review.state, "commented");
							assert.equal(posted.review.commit_id, head);
							assert.match(posted.review.body, /The README needs a correction/);
							assert.match(posted.review.body, /Correct the heading/);
							assert.deepEqual(
								posted.lines.map(line => [line.path, line.line]),
								[["README.md", 1]],
							);
							item.pull.headSha = head;
							await prComment(item.pull, commentId + 2, author, "/windlass review");
							assert.equal((await reviewer.snapshot()).summary.turns, initialTurns + 1);
							const after = await item.view();
							assert.equal(after.state, before.state);
							assert.deepEqual(after.run, before.run);
							assert.equal(after.head, before.head);
							assert.equal(after.feedback.batches.length, 0);
							assert.equal(after.feedback.notTaken, 1);
							assert.deepEqual(
								after.reviews.filter(r => r.requestedPull).map(r => [r.head, r.recommendation]),
								[[head, "changes_requested"]],
							);
							assert.equal(
								standin.reviews.filter(r => r.pr === item.pr && r.review.body.startsWith("<!-- windlass-review:"))
									.length,
								1,
							);
						} finally {
							await stop(item.id);
						}
					} finally {
						await reviewerSettings().checkReviewer(process.env.WLP_FACTORY_REVIEWER === "on");
					}
				},
			);
		await check(
			"Session PR feedback merges deliveries into one bounded turn and tolerates a failed acknowledgement",
			async () => {
				const created = await g2User.createSession({
					profile: "docker-windlass-sandbox",
					repository: { id: projectG2.id },
				});
				const agent = client.agentSession.get([uid, created.id], { params: { token: ownerToken } });
				try {
					await agent.prompt({ text: "Write a short program." });
					await until("first session turn", async () => (await agent.snapshot()).summary.status === "idle");
					const published = await agent.publish({ message: { title: "A session PR", body: "" } });
					const pr = published.state.pullRequest!.number;
					const pull = standin.pulls.find(p => p.repository === projectG2.id && p.number === pr)!;
					const approval = standin.submitReview(projectG2, pull, peer, "approved", "Looks good.");
					await delivered("pull_request_review", reviewFields(pr, approval.review));
					assert.equal((await agent.snapshot()).summary.turns, 1);
					await agent.prompt({ text: "Fetch the website headers." });
					await until("turn awaiting approval", async () => (await agent.snapshot()).summary.status === "waiting");
					await prComment(pull, 66001, reader, "/windlass do not take this");
					assert.ok(!standin.reactions.has("issues:66001"));
					await prComment(pull, 66002, writer, "/windlass Handle empty input.\u2028Quote this line too.");
					assert.ok(standin.reactions.has("issues:66002"));
					assert.equal((await agent.snapshot()).summary.turns, 2);
					await prComment(pull, 66004, writer, "/windlass " + "x".repeat(8001));
					await prComment(pull, 66005, writer, "/windlass " + "y".repeat(8000));
					const review = standin.submitReview(projectG2, pull, peer, "changes_requested", "Use a clearer name.", [
						"@windlass-fk4w Fix this line.",
					]);
					await delivered("pull_request_review", reviewFields(pr, review.review));
					await delivered("pull_request_review_comment", {
						action: "created",
						sender: review.lines[0].user,
						pull_request: { number: pr },
						comment: review.lines[0],
					});
					await prComment(pull, 66003, peer, "@windlass-fk4w Document the change.");
					await delivered("issue_comment", commentFields(pr, 66003, peer));
					assert.ok(standin.reactions.has("review:" + review.review.id));
					assert.ok(standin.reactions.has("pulls:" + review.lines[0].id));
					assert.ok(standin.reactions.has("issues:66003"));
					const many = standin.submitReview(
						projectG2,
						pull,
						writer,
						"changes_requested",
						"Cover these cases.",
						Array.from({ length: 20 }, (_, i) => "Case " + i),
					);
					many.review.node_id = "";
					const row = await delivered("pull_request_review", reviewFields(pr, many.review));
					assert.equal(row.attempts, 1);
					assert.ok(logs.includes("entry=review:" + many.review.id));
					assert.ok(standin.reactions.has("pulls:" + many.lines[0].id));
					await agent.stop();
					const { timeline } = await until("merged feedback turn", async () => {
						const view = await agent.snapshot();
						return view.summary.status === "idle" && view.summary.turns >= 3 ? view : null;
					});
					const prompts = timeline.filter(e => e.kind === "user");
					assert.equal(prompts.length, 3);
					const batch = prompts[2].text;
					assert.match(batch, /> Handle empty input\.\n> Quote this line too\./);
					assert.match(batch, /> Use a clearer name\./);
					assert.match(batch, /src\/main\.ts, line 1/);
					assert.equal(batch.split("> Document the change.").length, 2);
					assert.equal(batch.match(/^----- @/gm)?.length, 20);
					assert.doesNotMatch(batch, /decoy|do not take this|x{100}|y{100}/);
					assert.ok(timeline.some(e => e.kind === "platform" && e.text.includes("Longer than 8,000 characters")));
					const marks = timeline.flatMap(e =>
						e.kind === "windlass" && e.event.type === "fake.prompt_untrusted" ? [[e.turn, e.event.data?.source]] : [],
					);
					assert.deepEqual(marks, [[3, "GitHub feedback from @" + peer.login]]);
				} finally {
					await g2User.deleteSession(created.id);
				}
			},
		);
		await check("Session PR feedback explains an unlinked PR once", async () => {
			const pull: (typeof standin.pulls)[number] = {
				repository: projectG2.id,
				number: 660,
				title: "Unlinked",
				body: "",
				head: "topic",
				base: "main",
				state: "open",
				draft: false,
				merged: false,
				mergeable: true,
				requestedReviewers: [],
				comments: [],
			};
			standin.pulls.push(pull);
			const replies = () => pull.comments.filter(c => c.user.login === standin.slug + "[bot]");
			const review = standin.submitReview(projectG2, pull, writer, "changes_requested", "Please fix this.", [
				"A line comment.",
			]);
			await delivered("pull_request_review", reviewFields(pull.number, review.review));
			await prComment(pull, 66101, reader, "/windlass reader");
			assert.equal(replies().length, 0);
			review.review.body = "@windlass-fk4w please fix this.";
			await delivered("pull_request_review", reviewFields(pull.number, review.review));
			assert.equal(replies().length, 1);
			await prComment(pull, 66102, writer, "/windlass first");
			await prComment(pull, 66103, peer, "@windlass-fk4w second");
			assert.deepEqual(
				replies().map(c => c.body),
				["This pull request is not linked to a Windlass agent."],
			);

			// A reply could be past the last page the App reads.
			pull.comments = Array.from({ length: 1000 }, (_, i) => ({ id: 70000 + i, body: "Discussion", user: writer }));
			const long = await prComment(pull, 66104, writer, "/windlass long thread");
			assert.equal(long.attempts, 1);
			assert.equal(replies().length, 0);

			// The installation lost its last user after webhook admission but before the inbox handled it.
			const orphan = standin.addInstallation("unlinked-org", "Organization");
			orphan.repositories.add(projectG2.id);
			const guid = randomUUID();
			const delivery = edge(
				"issue_comment",
				{ installation: { id: orphan.id }, repository: { id: projectG2.id }, ...commentFields(pull.number, 66104) },
				{ slug: standin.slug, guid, at: Date.now() },
			)!;
			pull.comments = pull.comments.slice(-1);
			await inbox(orphan.id).internalReceive(delivery);
			await until(
				"unlinked installation skipped",
				async () => (await fixture(orphan.id).checkRow(guid))?.state === "ignored",
			);
			assert.equal(replies().length, 0);
		});
		await check(
			"G4 owner review batches its lines, acknowledges once, reopens the check and requests review again",
			async () => {
				standin.appPermissions.checks = "write";
				const item = await feedbackItem();
				try {
					const check = await until("initial completed check", async () =>
						standin.checks.find(
							c => c.repository === projectG2.id && c.head_sha === item.head && c.status === "completed",
						),
					);
					const r = standin.submitReview(projectG2, item.pull, writer, "changes_requested", "Fix the empty case.", [
						"/windlass line one",
						"/windlass line two",
						"/windlass line three",
					]);
					const requests = standin.requests.filter(q => q.path.endsWith("/requested_reviewers")).length;
					const guid = randomUUID();
					assert.equal(
						(await delivered("pull_request_review", reviewFields(item.pr, r.review), installation.id, guid)).state,
						"done",
					);
					const replay = await standin.deliver(
						web,
						"pull_request_review",
						{
							installation: { id: installation.id },
							repository: { id: projectG2.id },
							...reviewFields(item.pr, r.review),
						},
						{ secret, guid },
					);
					assert.deepEqual(await replay.json(), { taken: "duplicate" });
					for (const line of r.lines)
						await delivered("pull_request_review_comment", {
							action: "created",
							sender: line.user,
							pull_request: { number: item.pr },
							comment: line,
						});
					await delivered("pull_request_review", reviewFields(item.pr, r.review));
					const view = await until("one taken review", async () => {
						const v = await item.view();
						return v.feedback?.batches.some(b => b.state === "taken") ? v : null;
					});
					assert.equal(view.feedback.batches.length, 1);
					assert.equal(view.feedback.batches[0].entries.length, 4);
					assert.ok(!JSON.stringify(view.feedback).includes("decoy"));
					assert.equal(view.run?.n, 2);
					await until("eyes on all three lines", async () =>
						r.lines.every(l => standin.reactions.has("pulls:" + l.id)),
					);
					await until("reopened check", async () =>
						standin.requests.some(
							q =>
								q.method === "PATCH" &&
								q.path.endsWith("/check-runs/" + check.id) &&
								(q.body as { status: string; output?: { title?: string } }).status === "in_progress" &&
								(q.body as { output?: { title?: string } }).output?.title === "Sent back: being reworked in run 2",
						),
					);
					await until("second push", async () => (await item.view()).run?.step.kind === "ci");
					const timeline = (
						await client.agentSession.get([uid, view.sessionId], { params: { token: ownerToken } }).snapshot()
					).timeline;
					const turn = timeline.find(e => e.kind === "user" && e.turn === 2);
					assert.ok(
						turn?.kind === "user" &&
							turn.text.includes("> Fix the empty case.") &&
							turn.text.includes("line three") &&
							!turn.text.includes("decoy"),
					);
					await item.clock().checkAdvance("poll", 0);
					await until("second handoff", async () => {
						const v = await item.view();
						return (
							v.verifiedCheck?.conclusion === "success" &&
							check.external_id === v.verdicts.find(r => r.run === 2)?.id &&
							item.pull.requestedReviewers.includes(owner)
						);
					});
					assert.ok(standin.requests.filter(q => q.path.endsWith("/requested_reviewers")).length > requests);
					assert.ok(item.pull.comments.every(c => !c.body.includes("Fix the empty case.")));
				} finally {
					await stop(item.id);
					standin.appPermissions.checks = "read";
				}
			},
		);
		for (const [name, spacing, count, window] of [
			["quiet window", 30_000, 2, 150_000],
			["ten minute cap", 90_000, 7, 600_000],
		] as const) {
			await check("G4 comments " + name, async () => {
				const item = await feedbackItem();
				try {
					for (let i = 0; i < count; i++) {
						if (i) await item.clock().checkAdvance("feedback", spacing);
						const id = 50000 + item.pr * 10 + i;
						item.pull.comments.push({
							id,
							body: "/windlass Point " + i,
							user: { ...writer, type: "User" },
							author_association: "OWNER",
							created_at: new Date().toISOString(),
						});
						assert.equal((await delivered("issue_comment", commentFields(item.pr, id))).state, "done");
					}
					const length = await item.clock().checkWindow();
					assert.ok(length >= window && length <= window + 5000, "Wrong batch deadline " + length);
					assert.equal((await item.view()).run?.n, 1);
					await item.clock().checkAdvance("feedback", window - (count - 1) * spacing + 5000);
					await until("batched comments", async () =>
						(await item.view()).feedback.batches.some(b => b.state === "taken" && b.entries.length === count),
					);
					assert.equal((await item.view()).run?.n, 2);
					await until("eyes on conversation comments", async () =>
						standin.reactions.has("issues:" + (50000 + item.pr * 10)),
					);
					if (spacing === 90_000) {
						// The 10:30 and 12:00 comments belong to the next quiet window.
						for (const [id, delay] of [
							[51000, 25_000],
							[51001, 90_000],
						]) {
							await item.clock().checkAdvance("feedback", delay);
							item.pull.comments.push({
								id,
								body: "/windlass Later " + id,
								user: { ...writer, type: "User" },
								author_association: "OWNER",
								created_at: new Date().toISOString(),
							});
							await delivered("issue_comment", commentFields(item.pr, id));
						}
						assert.ok((await item.view()).feedback.batches.some(b => b.state === "pending" && b.entries.length === 2));
					}
				} finally {
					await stop(item.id);
				}
			});
		}
		// GitHub's permission decides, never the association a payload or the App's read shows: to an App, a private organisation
		// member reads as NONE or CONTRIBUTOR however much they may do, and an association can say COLLABORATOR of a reader.
		for (const [association, level] of [
			["NONE", "write"],
			["CONTRIBUTOR", "write"],
			["COLLABORATOR", "read"],
			["MEMBER", "none"],
		] as const) {
			await check("G4 permission decides for " + association + " with " + level + " access", async () => {
				const item = await feedbackItem();
				try {
					const person = standin.addUser("g4-" + association.toLowerCase() + "-" + level);
					if (level !== "none") projectG2.access.set(person.login, level);
					const prior = item.pull.comments.length;
					const id = 45671 + item.pr;
					item.pull.comments.push({
						id,
						body: "/windlass Handle the empty input.",
						user: { ...person, type: "User" },
						author_association: association,
						created_at: new Date().toISOString(),
					});
					await delivered("issue_comment", commentFields(item.pr, id, person, association));
					const view = await item.view();
					assert.equal(
						standin.requests.filter(r => r.path.endsWith("/collaborators/" + person.login + "/permission")).length,
						1,
					);
					if (level === "write") {
						assert.equal(view.feedback.notTaken, 0);
						assert.deepEqual(
							view.feedback.batches.flatMap(b => b.entries.map(e => [e.id, e.access, e.body])),
							[["issue_comment:" + id, "write", "Handle the empty input."]],
						);
					} else {
						assert.deepEqual(view.feedback, { batches: [], notTaken: 1 });
						assert.equal(item.pull.comments.length, prior + 1);
					}
				} finally {
					await stop(item.id);
				}
			});
		}
		// The owner of an organisation's repository whose membership is private: GitHub tells the App CONTRIBUTOR or NONE for them.
		await check("G4 owner as a private organisation member: a review and its line comment are taken", async () => {
			const item = await feedbackItem();
			try {
				const r = standin.submitReview(projectG2, item.pull, writer, "changes_requested", "Rename sum to add.", [
					"/windlass and in the doc comment",
				]);
				for (const row of [r.review, ...r.lines]) row.author_association = "CONTRIBUTOR";
				await delivered("pull_request_review", reviewFields(item.pr, r.review));
				await delivered("pull_request_review_comment", {
					action: "created",
					sender: r.lines[0].user,
					pull_request: { number: item.pr },
					comment: r.lines[0],
				});
				const view = await until("private member's review taken", async () => {
					const v = await item.view();
					return v.feedback.batches.some(b => b.state === "taken") ? v : null;
				});
				assert.equal(view.feedback.notTaken, 0);
				assert.deepEqual(
					view.feedback.batches[0].entries.map(e => [e.kind, e.access]),
					[
						["changes_requested", "owner"],
						["review_comment", "owner"],
					],
				);
				assert.equal(view.run?.n, 2);
				await until("eyes on the line", async () => standin.reactions.has("pulls:" + r.lines[0].id));
			} finally {
				await stop(item.id);
			}
		});
		await check("G4 owner as a private organisation member: a /windlass comment is taken", async () => {
			const item = await feedbackItem();
			try {
				// The webhook says MEMBER and the App's own read of the comment says NONE, as on the live repositories.
				const id = 46000 + item.pr;
				item.pull.comments.push({
					id,
					body: "/windlass also export sum from index.js",
					user: { ...writer, type: "User" },
					author_association: "NONE",
					created_at: new Date().toISOString(),
				});
				assert.equal((await delivered("issue_comment", commentFields(item.pr, id, writer, "MEMBER"))).state, "done");
				const pending = await item.view();
				assert.deepEqual(
					pending.feedback.batches.map(b => [b.state, b.entries.map(e => [e.id, e.access])]),
					[["pending", [["issue_comment:" + id, "owner"]]]],
				);
				await item.clock().checkAdvance("feedback", 200_000);
				await until("private member's comment taken", async () => (await item.view()).run?.n === 2);
				await until("eyes on the comment", async () => standin.reactions.has("issues:" + id));
			} finally {
				await stop(item.id);
			}
		});
		await check("G4 approval is logged once and a Bot approval never reaches the inbox", async () => {
			const item = await feedbackItem();
			try {
				const { review } = standin.submitReview(projectG2, item.pull, writer, "approved", "Private approval.");
				const bot = await standin.deliver(
					web,
					"pull_request_review",
					{
						installation: { id: installation.id },
						repository: { id: projectG2.id },
						...reviewFields(item.pr, review),
						sender: { ...writer, type: "Bot" },
					},
					{ secret },
				);
				assert.deepEqual(await bot.json(), { taken: false });
				await delivered("pull_request_review", reviewFields(item.pr, review));
				await delivered("pull_request_review", reviewFields(item.pr, review));
				const view = await item.view();
				assert.equal(view.events.filter(e => e.said === "Approved by @" + owner + " on GitHub.").length, 1);
				assert.equal(view.run?.n, 1);
				assert.equal(view.feedback.batches.length, 0);
			} finally {
				await stop(item.id);
			}
		});
		for (const reason of ["four days old", "wrong installation"]) {
			await check("G4 ignores review " + reason + " and accepts a fresh bound review", async () => {
				const item = await feedbackItem();
				try {
					const r = standin.submitReview(
						projectG2,
						item.pull,
						writer,
						"changes_requested",
						"Skipped request.",
						[],
						reason === "four days old" ? Date.now() - 4 * DAY : Date.now(),
					);
					await delivered(
						"pull_request_review",
						reviewFields(item.pr, r.review),
						reason === "wrong installation" ? neighbour.id : installation.id,
					);
					if (reason === "wrong installation")
						assert.equal(
							await item.handle().internalGithubFeedback({
								installationId: neighbour.id,
								repositoryId: projectG2.id,
								pr: item.pr,
								entries: [],
								denied: "test",
							}),
							false,
						);
					assert.deepEqual((await item.view()).feedback, { batches: [], notTaken: 0 });
					const fresh = standin.submitReview(projectG2, item.pull, writer, "changes_requested", "Fresh request.");
					await delivered("pull_request_review", reviewFields(item.pr, fresh.review));
					await until("fresh bound review", async () =>
						(await item.view()).feedback.batches.some(
							b => b.entries[0].id === "review:" + fresh.review.id && b.state === "taken",
						),
					);
				} finally {
					await stop(item.id);
				}
			});
		}
		await check("G4 owner review starts a planner on the feature PR", async () => {
			const item = await feedbackItem();
			try {
				await (item.handle() as unknown as { checkFinishedFeature(): Promise<void> }).checkFinishedFeature();
				const r = standin.submitReview(
					projectG2,
					item.pull,
					writer,
					"changes_requested",
					"Add coverage to the feature.",
				);
				await delivered("pull_request_review", reviewFields(item.pr, r.review));
				const view = await until("feedback re-planning", async () => {
					const v = await item.view();
					return v.run?.n === 2 ? v : null;
				});
				assert.equal(view.run?.step.kind, "refine");
				assert.equal(view.feedback.batches[0].entries[0].access, "owner");
			} finally {
				await stop(item.id);
			}
		});
		await check("G4 sandbox expiry resumes PR feedback on the published branch", async () => {
			const item = await feedbackItem(false, "Sandbox expiry");
			const sessionId = (await item.view()).sessionId;
			const session = client.agentSession.get([uid, sessionId], { params: { token: ownerToken } });
			try {
				await item.clock().checkAdvance("idle", 3 * DAY - 60_000);
				await item.view();
				assert.notEqual((await session.snapshot()).summary.sandbox, "none");
				await item.clock().checkAdvance("idle", 60_001);
				await item.view();
				await until("three-day sandbox release", async () => (await session.snapshot()).summary.sandbox === "none");
				const { review } = standin.submitReview(
					projectG2,
					item.pull,
					peer,
					"changes_requested",
					"Handle a missing file.",
				);
				await delivered("pull_request_review", reviewFields(item.pr, review));
				await until(
					"fresh PR branch checkout",
					async () =>
						(await session.snapshot()).timeline.some(
							row =>
								row.turn === 2 &&
								row.kind === "platform" &&
								row.text.includes(`Put the workspace on ${item.pull.head} at ${item.head.slice(0, 7)}`),
						),
					45_000,
				);
			} finally {
				await stop(item.id);
			}
			await until(
				"cancelled item frees its builder",
				async () => (await session.snapshot()).summary.sandbox === "none",
			);
		});
		await check("G4 reconcile a missed writer review and request that writer at handoff", async () => {
			const item = await feedbackItem();
			try {
				const r = standin.submitReview(projectG2, item.pull, peer, "changes_requested", "Handle a missing file.");
				await item.clock().checkAdvance("poll", 0);
				const v = await until("missed review taken", async () => {
					const v = await item.view();
					return v.run?.n === 2 ? v : null;
				});
				assert.equal(v.feedback.batches[0].entries[0].id, "review:" + r.review.id);
				assert.equal(v.feedback.batches[0].entries[0].access, "write");
				await until("feedback status in marked comment", async () =>
					item.pull.comments.some(c => c.body.includes("The agent is addressing \\@" + peer.login + "'s feedback\\.")),
				);
				await until("reworked PR awaiting CI", async () => (await item.view()).run?.step.kind === "ci");
				await item.clock().checkAdvance("poll", 0);
				await until("writer requested again", async () => item.pull.requestedReviewers.includes(peer.login));
				assert.equal(item.pull.comments.filter(c => c.body.startsWith("<!-- windlass-item:")).length, 1);
			} finally {
				await stop(item.id);
			}
		});
		await check("G4 reconcile a missed standalone line comment", async () => {
			const item = await feedbackItem();
			try {
				// GitHub files a single line comment as a "commented" review with an empty body: only the line is addressed.
				const r = standin.submitReview(projectG2, item.pull, peer, "commented", "", [
					{ path: "src/main.ts", line: 3, body: "/windlass Close the file on error." },
					{ path: "src/main.ts", line: 9, body: "Not addressed, so not taken." },
				]);
				await item.clock().checkAdvance("poll", 0);
				// A line comment collects with others for the quiet window, as one delivered would.
				await until("missed line comment collected", async () =>
					(await item.view()).feedback.batches.some(b => b.state === "pending"),
				);
				await item.clock().checkAdvance("feedback", 125_000);
				const v = await until("missed line comment taken", async () => {
					const v = await item.view();
					return v.run?.n === 2 ? v : null;
				});
				assert.deepEqual(
					v.feedback.batches.flatMap(b => b.entries.map(e => [e.id, e.kind, e.path, e.line, e.body, e.access])),
					[
						[
							"review_comment:" + r.lines[0].id,
							"review_comment",
							"src/main.ts",
							3,
							"Close the file on error.",
							"write",
						],
					],
				);
				// A later poll finds it handled and starts nothing more.
				await item.clock().checkAdvance("poll", 0);
				assert.equal((await item.view()).run?.n, 2);
			} finally {
				await stop(item.id);
			}
		});
		await check("G3 feature placement defaults bind GitHub filings and ask before changing place", async () => {
			const writer = standin.addUser("default-places");
			projectG2.access.set(writer.login, "write");
			const { user: account, uid, token } = await connectUser(writer.login);
			const machine = client.user.get([uid], service()) as unknown as {
				checkPlaceMachine(id: string, state: string): Promise<void>;
				checkCancelDuringPlacement(id: string): Promise<void>;
			};
			const mac = "m_0000000000000001",
				next = "m_0000000000000002";
			const repo = (change: import("../server/src/contract.js").ItemPlaceDefaults) =>
				account.saveRepositoryDefaults({ repositoryId: projectG2.id, ...change });
			let number = 810;
			const file = async (start = false) => {
				const issue = make(++number, start ? writer : reader);
				await applyLabel(issue, "windlass:quick", writer);
				const [item] = await items(issue, account);
				assert.ok(item);
				return account.item(item.id);
			};
			assert.deepEqual((await file()).place, { kind: "hosted" });
			await machine.checkPlaceMachine(mac, "online");
			await machine.checkPlaceMachine(next, "online");
			const policy = {
				place: { machine: mac },
				harness: "claude" as const,
				machineProfile: "docker-hardened" as const,
			};
			await account.saveAccountDefaults(policy);
			const quick = await file();
			assert.deepEqual(quick.place, { kind: "machine", machineId: mac });
			assert.equal(quick.agent?.harness, "claude");
			await repo({ place: "hosted" });
			assert.deepEqual((await file()).place, { kind: "hosted" });
			await repo({ place: null });
			await machine.checkPlaceMachine(mac, "offline");
			const waiting = await file(true);
			assert.equal(waiting.state, "waiting");
			assert.match(waiting.question!.text, /offline/);
			assert.deepEqual(
				waiting.question!.choices.map(c => c.id),
				["wait", "give_up"],
			);
			await account.actOnItem({ id: waiting.id, action: { kind: "cancel" } });
			await repo({ ...policy, placeFallback: "hosted" });
			const fallback = await file(true);
			assert.equal(fallback.place.kind, "machine");
			assert.deepEqual(
				fallback.question!.choices.map(c => c.id),
				["wait", "use_hosted", "give_up"],
			);
			await account.actOnItem({ id: fallback.id, action: { kind: "cancel" } });
			await machine.checkPlaceMachine(mac, "full");
			await repo({ ...policy, place: "any-machine" });
			assert.deepEqual((await file()).place, { kind: "machine", machineId: next });
			await machine.checkPlaceMachine(next, "offline");
			const queued = await file(true);
			assert.match(queued.question!.text, /free slot/);
			await account.actOnItem({
				id: queued.id,
				action: { kind: "answer", question: queued.question!.id, choice: "wait" },
			});
			assert.equal(queued.reviewNone, null);
			assert.equal(queued.review, null);
			await machine.checkPlaceMachine(next, "online");
			await until(
				"waiting item bound to the newly free machine",
				async () => !(await account.item(queued.id)).awaitingPlace,
			);
			const bound = await account.item(queued.id);
			assert.deepEqual(bound.place, { kind: "machine", machineId: next });
			assert.equal(bound.reviewNone, quick.reviewNone);
			assert.equal(
				bound.reviewNone,
				process.env.WLP_FACTORY_REVIEWER === "on" ? null : "turned off for this deployment",
			);
			assert.equal(!!bound.reviewerSessionId, process.env.WLP_FACTORY_REVIEWER === "on");
			await account.actOnItem({ id: queued.id, action: { kind: "cancel" } });
			await machine.checkPlaceMachine(next, "full");
			const racing = await file(true);
			await account.actOnItem({
				id: racing.id,
				action: { kind: "answer", question: racing.question!.id, choice: "wait" },
			});
			await machine.checkCancelDuringPlacement(racing.id);
			await machine.checkPlaceMachine(next, "online");
			await until("free slot starts placement and cancellation removes its session", async () => {
				if ((await account.item(racing.id)).state !== "cancelled") return false;
				if ((await account.listSessions()).some(s => s.id === racing.sessionId)) return false;
				return client.agentSession
					.get([uid, racing.sessionId], service())
					.resolve()
					.then(() => false, absent);
			});

			await repo({ ...policy, placeFallback: "hosted" });
			await machine.checkPlaceMachine(mac, "signed-out");
			assert.match((await file(true)).question!.text, /not signed in/i);
			await assert.rejects(repo(policy), /sign-in|supports/i);
			const draftFeature = make(++number, reader);
			await applyLabel(draftFeature, "windlass:orchestrate", writer);
			const [draftPlan] = await items(draftFeature, account);
			assert.deepEqual(draftPlan.place, { kind: "machine", machineId: mac });
			const draftPlanner = await client.agentSession.get([uid, draftPlan.sessionId], { params: { token } }).snapshot();
			assert.equal(draftPlanner.summary.harness ?? "windlass", "windlass");
			assert.equal(draftPlanner.summary.profile, "docker-hardened");
			await machine.checkPlaceMachine(mac, "removed");
			assert.match((await file(true)).question!.text, /paired machine|no longer/i);
			await machine.checkPlaceMachine(next, "full");
			await repo({ ...policy, place: "any-machine", placeFallback: "hosted" });
			const feature = make(++number, writer);
			await applyLabel(feature, "windlass:orchestrate", writer);
			const [plan] = await items(feature, account);
			const away = await account.item(plan.id);
			assert.equal(away.place.kind, "machine");
			await account.actOnItem({
				id: plan.id,
				action: { kind: "answer", question: away.question!.id, choice: "use_hosted" },
			});
			await until("owner-approved hosted planner", async () => (await account.item(plan.id)).place.kind === "hosted");
			const planner = client.agentSession.get([uid, plan.sessionId], { params: { token } });
			const prompt = await until("planner received the preferred place for parts", async () =>
				(await planner.snapshot()).timeline.find(e => e.kind === "user" && e.text.includes("place.prefer")),
			);
			assert.ok(prompt.kind === "user");
			const preference = prompt.text.split("Owner preference (data): ")[1].split("\n")[0];
			assert.deepEqual(JSON.parse(preference), {
				selection: "any compatible machine",
				harness: "claude",
				profile: "docker-hardened",
			});
			await account.actOnItem({ id: plan.id, action: { kind: "cancel" } });
		});
		await check("G3 feature filing binds the fetched command and label, and explains bug overrides", async () => {
			const author = await newWriter("g3-feature-owner");
			const named = make(175, reader);
			const comment = standin.issueComment(named, author.person, "@windlass-fk4w orchestrate this feature");
			await mention(named, comment.id, author.person);
			assert.equal((await items(named, author.account))[0]?.mode, "orchestrate");

			const labelled = make(176, reader);
			await applyLabel(labelled, "windlass:orchestrate", author.person);
			assert.equal((await items(labelled, author.account))[0]?.mode, "orchestrate");

			const bug = make(177, reader);
			bug.labels.push("bug");
			const fileBug = standin.issueComment(bug, author.person, "@windlass-fk4w");
			await mention(bug, fileBug.id, author.person);
			assert.equal((await items(bug, author.account))[0]?.mode, "single");
			await until("bug reply", async () => bots(bug).length > 0);
			assert.match(bots(bug)[0]!.body, /bug label.*Quick.*without a plan/i);

			const defaults = make(178, reader);
			await change(defaults, "labeled", author.person);
			assert.equal((await items(defaults, author.account))[0]?.mode, "orchestrate");
			await until("plan-first reply", async () => bots(defaults).some(c => /Plan first.*approve/.test(c.body)));

			const quick = make(179, reader);
			const note = standin.issueComment(quick, author.person, "/windlass quick fix the typo");
			await mention(quick, note.id, author.person);
			assert.equal((await items(quick, author.account))[0]?.mode, "single");
			await until("quick reply", async () => bots(quick).some(c => /Quick.*without a plan/.test(c.body)));

			const quickLabel = make(180, reader);
			await applyLabel(quickLabel, "windlass:quick", author.person);
			assert.equal((await items(quickLabel, author.account))[0]?.mode, "single");
		});
		await check("G3 feature defaults to single on a deployment without planning", async () => {
			const settings = client.githubHooks.getOrCreate(["app"], service()) as unknown as {
				checkPlanning(enabled: boolean): Promise<void>;
			};
			await settings.checkPlanning(false);
			try {
				const author = await newWriter("g3-quick-default");
				const issue = make(181, reader);
				await change(issue, "labeled", author.person);
				assert.equal((await items(issue, author.account))[0]?.mode, "single");
				await until("deployment switch reply", async () =>
					bots(issue).some(c => /disabled.*without a plan/.test(c.body)),
				);
				const draft = await author.account.createItem({
					repository: { id: projectG2.id },
					title: "Export",
					body: "Make an export.",
				});
				assert.equal(draft.mode, "single");
				const explicit = make(182, reader);
				await mention(
					explicit,
					standin.issueComment(explicit, author.person, "/windlass orchestrate").id,
					author.person,
				);
				assert.deepEqual(await items(explicit, author.account), []);
				await until("explicit orchestration refusal", async () =>
					bots(explicit).some(c => /couldn't start this issue because.*disabled/.test(c.body)),
				);
				await assert.rejects(
					author.account.createItem({
						repository: { id: projectG2.id },
						title: "Export",
						body: "Make an export.",
						mode: "orchestrate",
					}),
				);
			} finally {
				await settings.checkPlanning(true);
			}
		});
		await check("G3 snapshot strips hidden text, bounds task, identifies author and fences third-party text", () => {
			const issue = make(40, reader);
			const input = {
				title: "T".repeat(81),
				body:
					"<!-- hidden -->\u200dfirst\u202e\n" +
					Array.from({ length: 25 }, (_, i) => "- [ ] task " + i).join("\n") +
					"\n" +
					"X".repeat(30_000),
				number: issue.number,
				url: standin.url + "/owner/factory/issues/40",
				author: reader,
				sender: writer,
				note: "choose blue",
			};
			const { task, trusted } = taskOfIssue(input);
			assert.equal(trusted, false);
			assert.equal(task.title.length, 80);
			assert.ok(task.body.length <= 20_000);
			assert.doesNotMatch(task.body, /hidden|\u200d|\u202e/);
			assert.match(task.body, /written by @g3-reader/);
			assert.match(task.body, /> first/);
			assert.equal(task.acceptance.length, 20);
			assert.doesNotMatch(task.body, /task 19/);
			assert.match(task.body, /task 24/);
			assert.match(task.body, /\(cut: the issue is longer\)/);
			assert.ok(task.body.endsWith("The person adds: choose blue"));
			assert.equal(taskOfIssue({ ...input, author: writer }).trusted, true);
		});
		await check("G3 before the installation accepts Issues permission a signed label has no effect", async () => {
			delete standin.appPermissions.issues;
			try {
				const issue = make(39);
				await change(issue, "labeled");
				assert.deepEqual(await items(issue), []);
				assert.deepEqual(bots(issue), []);
			} finally {
				standin.appPermissions.issues = "write";
			}
		});
		await check("G3 owner label starts the owner's item and snapshots the fetched issue", async () => {
			const issue = make(41);
			const webItem = await g2User.createItem({
				title: "From the form",
				body: "A separate submission.",
				repository: { id: projectG2.id },
				idempotencyKey: `github:${projectG2.id}#41:1`,
			});
			assert.equal(webItem.source, "web");
			assert.equal(webItem.origin, null);
			await change(issue, "labeled");
			const [item] = await items(issue);
			assert.ok(item);
			assert.notEqual(item.state, "draft");
			assert.equal(item.source, "github");
			assert.equal(item.title, issue.title);
			assert.deepEqual(item.origin, {
				issue: { number: 41, url: standin.url + "/" + owner + "/factory/issues/41", author: owner, trusted: true },
				sender: owner,
			});
			const view = await g2User.item(item.id);
			assert.ok(view.run);
			assert.match(view.task.body, /Add a short program/);
			assert.doesNotMatch(view.task.body, /Decoy/);
		});
		await check("G3 stranger's issue is a labelled draft until its owner starts it", async () => {
			const issue = make(42, reader);
			await change(issue, "labeled");
			const [item] = await items(issue);
			assert.ok(item);
			assert.equal(item.state, "draft");
			const view = await g2User.item(item.id);
			assert.equal(view.run, null);
			assert.equal(view.origin?.issue?.trusted, false);
			assert.match(view.task.body, /written by @g3-reader/);
			assert.equal(view.spent.turns, 0);
			await until("draft comment", async () =>
				bots(issue).some(c => c.body.includes("for @" + owner + ". [View work item]")),
			);
			issue.body = "New words";
			issue.updated_at = new Date().toISOString();
			await notify(issue, "edited");
			await until(
				"edit note",
				async () => (await g2User.item(item.id)).events.some(e => e.said.includes("issue was edited")),
				25_000,
			);
			const edited = await g2User.item(item.id);
			assert.deepEqual(edited.task, view.task);
			assert.ok(edited.events.some(e => e.said.includes("issue was edited")));
			await change(issue, "closed", reader);
			assert.equal((await g2User.item(item.id)).state, "draft");
			await change(issue, "reopened");
			await change(issue, "unlabeled");
			assert.equal((await g2User.item(item.id)).state, "cancelled");
		});
		await check(
			"G3 a stranger's issue, started by its owner, reaches Windlass marked as the issue's; the owner's own does not",
			async () => {
				// The fake Windlass records each prompt's `_meta["windlass/untrusted"]` (`fake.prompt_untrusted`) and taints its session once, as 0.6.0 does.
				const marks = async (sessionId: string) =>
					(
						await client.agentSession.get([uid, sessionId], { params: { token: ownerToken } }).snapshot()
					).timeline.flatMap(e =>
						e.kind === "windlass" && (e.event.type === "fake.prompt_untrusted" || e.event.type === "taint.noticed")
							? [{ type: e.event.type, data: e.event.data }]
							: [],
					);
				const stranger = make(90, reader);
				await change(stranger, "labeled");
				const [draft] = await items(stranger);
				assert.ok(draft);
				assert.equal(draft.state, "draft");
				await g2User.actOnItem({ id: draft.id, action: { kind: "start" } });
				const started = await until(
					"the stranger's issue's first turn",
					async () => {
						const m = await marks(draft.sessionId);
						return m.some(x => x.type === "fake.prompt_untrusted") ? m : null;
					},
					60_000,
				);
				const source = "issue #90 by @g3-reader";
				assert.deepEqual(
					started.find(x => x.type === "fake.prompt_untrusted")?.data,
					{ source },
					JSON.stringify(started),
				);
				assert.deepEqual(
					started.find(x => x.type === "taint.noticed")?.data?.source,
					{ kind: "client-input", tool: source },
					JSON.stringify(started),
				);
				const own = make(91);
				await change(own, "labeled");
				const [mine] = await items(own);
				assert.ok(mine);
				assert.notEqual(mine.state, "draft");
				await until(
					"the owner's issue's first turn",
					async () =>
						(
							await client.agentSession.get([uid, mine.sessionId], { params: { token: ownerToken } }).snapshot()
						).timeline.some(e => e.kind === "user"),
					60_000,
				);
				assert.deepEqual(await marks(mine.sessionId), []);
				await g2User.actOnItem({ id: draft.id, action: { kind: "cancel" } });
				await g2User.actOnItem({ id: mine.id, action: { kind: "cancel" } });
			},
		);
		await check(
			"G3 a stranger's issue on Docker, hardened, does not start until its owner runs it anyway, and then goes unmarked",
			async () => {
				const timeline = async (sessionId: string) =>
					(await client.agentSession.get([uid, sessionId], { params: { token: ownerToken } }).snapshot()).timeline;
				await g2User.saveRepositoryDefaults({ repositoryId: projectG2.id, profile: "docker-hardened" });
				try {
					const stranger = make(92, reader);
					await change(stranger, "labeled");
					const [draft] = await items(stranger);
					assert.ok(draft);
					assert.equal(draft.state, "draft");
					await g2User.actOnItem({ id: draft.id, action: { kind: "start" } });
					const refused = await until(
						"the refusal",
						async () => {
							const v = await g2User.item(draft.id);
							return v.question ? v : null;
						},
						60_000,
					);
					const source = "issue #92 by @g3-reader";
					assert.equal(refused.question?.kind, "turn_refused", JSON.stringify(refused.question));
					const { hardenedRefusal, hardenedUnmarkedNote, runAnywayWords } = await import(
						"../server/src/factory/untrusted.js"
					);
					assert.ok(refused.question.text.includes(hardenedRefusal("windlass", [source])), refused.question.text);
					assert.deepEqual(
						refused.question.choices.map(o => o.id),
						["give_up", "run_anyway"],
					);
					// Refused before the sandbox opened: the timeline has the turn's prompt, and nothing of Windlass.
					const before = await timeline(draft.sessionId);
					assert.ok(
						before.some(e => e.kind === "user") && !before.some(e => e.kind === "windlass"),
						"the refused turn reached Windlass",
					);
					await g2User.actOnItem({
						id: draft.id,
						action: { kind: "answer", question: refused.question.id, choice: "run_anyway" },
					});
					const ran = await until(
						"the turn run anyway",
						async () => {
							const t = await timeline(draft.sessionId);
							return t.some(e => e.kind === "windlass" && e.event.type === "step.started") ? t : null;
						},
						60_000,
					);
					assert.ok(
						!ran.some(
							e =>
								e.kind === "windlass" && (e.event.type === "fake.prompt_untrusted" || e.event.type === "taint.noticed"),
						),
						"the turn run anyway was marked",
					);
					assert.ok(
						ran.some(e => e.kind === "platform" && e.text === hardenedUnmarkedNote([source])),
						"the timeline does not say the text went labelled only",
					);
					const view = await g2User.item(draft.id);
					assert.ok(
						view.events.some(e => e.said === runAnywayWords("windlass", [source])),
						JSON.stringify(view.events.map(e => e.said)),
					);
					await g2User.actOnItem({ id: draft.id, action: { kind: "cancel" } });
				} finally {
					await g2User.saveRepositoryDefaults({ repositoryId: projectG2.id, profile: null });
				}
			},
		);
		await check("G3 read-only command stops after permission, including a payload claiming OWNER", async () => {
			// Fresh principal, so an uncached request shows the entire GitHub cost.
			const other = standin.addUser("g3-comment-reader");
			projectG2.access.set(other.login, "read");
			const isolated = standin.addRepository({ owner, name: "permission-cost", installation });
			isolated.access.set(other.login, "read");
			const account = await connectUser(other.login);
			const issue = standin.addIssue(isolated, 43, writer),
				msg = standin.issueComment(issue, other, "@windlass-fk4w file this");
			const start = standin.requests.length;
			await delivered("issue_comment", {
				...payload(issue, other),
				repository: { id: isolated.id },
				action: "created",
				comment: { id: msg.id, body: "@windlass-fk4w", author_association: "OWNER" },
			});
			const requests = standin.requests
				.slice(start)
				.filter(
					r =>
						r.path.includes("permission-cost") ||
						r.path.includes("/repositories/" + isolated.id) ||
						(r.body as { repository_ids?: number[] })?.repository_ids?.includes(isolated.id),
				);
			assert.deepEqual(
				requests.map(r => r.method + " " + r.path),
				[
					`POST /api/v3/app/installations/${installation.id}/access_tokens`,
					`GET /api/v3/repos/${owner}/permission-cost/collaborators/${other.login}/permission`,
				],
			);
			assert.equal((await account.user.listItems()).length, 0);
			assert.equal(bots(issue).length, 0);
		});
		await check(
			"G3 forged sender, wrong thread, unaddressed fetched text and foreign installation are inert",
			async () => {
				const issue = make(44),
					elsewhere = make(45);
				const actual = standin.issueComment(issue, reader, "@windlass-fk4w");
				await mention(issue, actual.id, writer);
				await mention(issue, standin.issueComment(elsewhere, writer, "@windlass-fk4w file this").id);
				await mention(issue, standin.issueComment(issue, writer, "talk about @windlass-fk4w").id);
				standin.issueEvent(issue, "labeled", reader);
				await notify(issue, "labeled", writer);
				standin.issueEvent(issue, "labeled", writer);
				await notify(issue, "labeled", writer, neighbour.id);
				assert.equal((await items(issue)).length, 0);
				assert.equal(bots(issue).length, 0);
			},
		);
		await check(
			"G3 review age: old triggers stay refused, a fresh label files an old issue and an unlabel cancels it",
			async () => {
				const issue = make(46, reader),
					old = new Date(Date.now() - 7 * DAY).toISOString();
				issue.created_at = old;
				standin.issueEvent(issue, "labeled", writer);
				issue.events.at(-1)!.created_at = old;
				await notify(issue, "labeled");
				const msg = standin.issueComment(issue, writer, "@windlass-fk4w");
				msg.created_at = old;
				await mention(issue, msg.id);
				assert.deepEqual(await items(issue), []);
				assert.equal(bots(issue).length, 0);
				await change(issue, "labeled");
				const [item] = await items(issue);
				assert.equal(item?.state, "draft");
				await change(issue, "unlabeled");
				assert.equal((await g2User.item(item.id)).state, "cancelled");
			},
		);
		await check("G3 review disappearance: 404, 410, transfer redirect and changed repository ID cancel", async () => {
			const { person, account } = await newWriter("g3-disappearance");
			const destination = standin.apiUrl + "/repositories/123456/issues/71";
			const replies = (issue: Issue): Exclude<Issue["readResponse"], "timeout" | undefined>[] => [
				{ status: 404 },
				{ status: 410 },
				{ status: 301, headers: { location: destination } },
				{ status: 200, body: { id: issue.id, repository: { id: 123456 } } },
			];
			for (const [index, action] of ["deleted", "deleted", "transferred", "transferred"].entries()) {
				const issue = make(60 + index, reader);
				await change(issue, "labeled", person);
				const [item] = await items(issue, account);
				assert.equal(item?.state, "draft");
				issue.readResponse = replies(issue)[index];
				await notify(issue, action, person);
				assert.equal((await account.item(item.id)).state, "cancelled", String(issue.readResponse.status));
			}
			assert.ok(!standin.requests.some(r => r.path.endsWith("/repositories/123456/issues/71")));
		});
		await check("G3 review disappearance: inconclusive and transient reads preserve the bound draft", async () => {
			const issue = make(64, reader);
			await change(issue, "labeled");
			const [item] = await items(issue);
			const handle = client.workItem.get([uid, item.id], service());
			const probe = () =>
				handle.internalGithubIssue({
					installationId: installation.id,
					repositoryId: projectG2.id,
					issue: issue.number,
					senderId: writer.id,
					action: "transferred",
				});
			const revision = (await g2User.item(item.id)).revision;
			standin.issueEvent(issue, "transferred", writer);
			await probe();
			assert.equal((await g2User.item(item.id)).state, "draft");
			for (const status of [503, 429, 403]) {
				issue.readResponse = { status };
				await assert.rejects(probe);
			}
			issue.readResponse = "timeout";
			await assert.rejects(probe);
			issue.readResponse = { status: 302, headers: { location: "/login" } };
			await probe();
			issue.readResponse = { status: 200, body: { id: issue.id + 1, repository: { id: 123456 } } };
			await probe();
			installation.repositories.delete(projectG2.id);
			try {
				await probe();
			} finally {
				installation.repositories.add(projectG2.id);
			}
			const view = await g2User.item(item.id);
			assert.equal(view.state, "draft");
			assert.equal(view.revision, revision);
		});
		await check("G3 review churn: twenty edits and closes share one read and each note is recorded once", async () => {
			const repo = standin.addRepository({ owner, name: "churn-cost", installation });
			const author = standin.addUser("g3-churn-author");
			repo.access.set(author.login, "read");
			const issue = standin.addIssue(repo, 65, author);
			standin.issueEvent(issue, "labeled", writer);
			await delivered("issues", {
				...payload(issue),
				repository: { id: repo.id },
				action: "labeled",
				label: { name: "windlass" },
			});
			const [item] = await items(issue);
			assert.equal(item?.state, "draft");
			await until("draft comment before churn", async () => bots(issue).length);
			const handle = client.workItem.get([uid, item.id], service());
			const signal = (action: string, sender = author) =>
				handle.internalGithubIssue({
					installationId: installation.id,
					repositoryId: repo.id,
					issue: issue.number,
					senderId: sender.id,
					action,
				});
			const requests = () =>
				standin.requests.filter(
					r =>
						r.path.includes("/churn-cost/") ||
						r.path.endsWith("/repositories/" + repo.id) ||
						(r.body as { repository_ids?: number[] })?.repository_ids?.includes(repo.id),
				);
			const before = requests().length;
			const churn = async (n: number) => {
				issue.body = "edit " + n;
				issue.updated_at = new Date().toISOString();
				await signal("edited");
				standin.issueEvent(issue, "reopened", author);
				standin.issueEvent(issue, "closed", author);
				await signal("closed");
			};
			for (let n = 0; n < 20; n++) await churn(n);
			const notes = async () =>
				(await g2User.item(item.id)).events.filter(e => /issue was (edited|closed)/.test(e.said));
			await until("both churn notes", async () => (await notes()).length >= 2, 25_000);
			const calls = requests().slice(before);
			assert.equal(calls.filter(r => r.path.endsWith("/issues/65")).length, 1);
			assert.ok(calls.length <= 6, `expected at most six stand-in requests, saw ${calls.length}`);
			const revision = (await g2User.item(item.id)).revision;
			await churn(20);
			await until(
				"second window corroborated",
				async () =>
					requests()
						.slice(before)
						.filter(r => r.path.includes("/issues/65/events?")).length === 2,
				25_000,
			);
			// Wait for the effect to commit any notes before checking lifetime counts.
			await until(
				"second window settled",
				async () => !(await (handle as unknown as { checkIssuePending(): Promise<boolean> }).checkIssuePending()),
			);
			const entries = await notes();
			for (const kind of ["edited", "closed"])
				assert.equal(entries.filter(e => e.said.includes("issue was " + kind)).length, 1);
			const view = await g2User.item(item.id);
			assert.equal(view.state, "draft");
			assert.equal(view.revision, revision);
			repo.access.set(peer.login, "write");
			standin.issueEvent(issue, "reopened", author);
			standin.issueEvent(issue, "closed", peer);
			await signal("closed", peer);
			await signal("closed", author);
			await until(
				"writer's close despite an out-of-order stranger delivery",
				async () => (await g2User.item(item.id)).state === "cancelled",
				25_000,
			);
		});
		await check(
			"G3 the one filing limit: yesterday's interrupted filing and draft are not today's, today's interrupted filing is",
			async () => {
				const { person, account } = await newWriter("g3-interrupted");
				const who = await client.githubAccount.get([String(person.id)], service()).internalWho();
				const fixture = client.user.get([who!.uid], service()) as unknown as {
					checkInterruptedFiling(id: string, at: number): Promise<void>;
				};
				const settings = client.githubHooks.getOrCreate(["app"], service()) as unknown as {
					checkDailyLimit(daily: number): Promise<void>;
				};
				const midnight = Math.floor(Date.now() / DAY) * DAY;
				await fixture.checkInterruptedFiling("i_0000000000000000", midnight - 1);
				await settings.checkDailyLimit(1);
				try {
					const first = make(66, reader);
					await change(first, "labeled", person);
					const [draft] = await items(first, account);
					assert.equal(draft?.state, "draft");
					await fixture.checkInterruptedFiling(draft.id, midnight - 1);
					await fixture.checkInterruptedFiling("i_0000000000000001", midnight);
					const second = make(67, reader);
					await change(second, "labeled", person);
					assert.match(bots(second)[0]?.body ?? "", /from GitHub today/);
				} finally {
					await settings.checkDailyLimit(20);
				}
			},
		);
		await check(
			"G3 two labels and a mention file once; handled IDs survive cancellation and a new generation",
			async () => {
				const issue = make(47, reader);
				standin.issueEvent(issue, "labeled", writer);
				const guid = randomUUID(),
					fields = {
						...payload(issue),
						installation: { id: installation.id },
						repository: { id: projectG2.id },
						action: "labeled",
						label: { name: "windlass" },
					};
				assert.deepEqual(await (await standin.deliver(web, "issues", fields, { secret, guid })).json(), {
					taken: true,
				});
				assert.deepEqual(await (await standin.deliver(web, "issues", fields, { secret, guid })).json(), {
					taken: "duplicate",
				});
				await notify(issue, "labeled");
				await change(issue, "labeled");
				const msg = standin.issueComment(issue, writer, "@windlass-fk4w again");
				await mention(issue, msg.id);
				await until("eyes on the labelled issue", async () => standin.reactions.has("issue:" + issue.number));
				const first = await items(issue);
				assert.equal(first.length, 1);
				await g2User.actOnItem({ id: first[0].id, action: { kind: "cancel" } });
				await mention(issue, msg.id);
				await notify(issue, "labeled");
				assert.equal((await items(issue)).length, 1);
				const next = standin.issueComment(issue, writer, "@windlass-fk4w actual note");
				await mention(issue, next.id);
				await until("eyes on the filing comment", async () => standin.reactions.has("issues:" + next.id));
				await mention(issue, next.id);
				const reactions = issueReactions(issue);
				const base = `/api/v3/repos/${owner}/factory/issues`;
				assert.deepEqual(
					reactions.map(r => [r.method, r.path, r.auth, r.body, r.status]),
					[
						["POST", `${base}/47/reactions`, "installation", { content: "eyes" }, 200],
						["POST", `${base}/comments/${next.id}/reactions`, "installation", { content: "eyes" }, 200],
					],
				);
				const all = await items(issue);
				assert.equal(all.length, 2);
				const second = all.find(i => i.id !== first[0].id)!;
				assert.ok((await g2User.item(second.id)).task.body.endsWith("The person adds: actual note"));
				assert.equal((await directory().internalFind({ issue: 47 }))[0].generation, 2);
			},
		);
		await check("G3 marked issue comment links to the item, edits in place; real PR ends in Closes", async () => {
			const issue = make(48);
			await applyLabel(issue, "windlass:quick");
			const [item] = await items(issue);
			assert.ok(item);
			const pull = await until(
				"issue PR",
				async () => {
					const view = await g2User.item(item.id);
					return standin.pulls.find(p => p.repository === projectG2.id && p.number === view.pullRequest?.number);
				},
				45_000,
			);
			assert.ok(pull.body.trimEnd().endsWith("Closes #48."));
			await until("issue link updated with PR", async () =>
				bots(issue).some(c => c.body.includes(`Pull request #${pull.number}.`)),
			);
			assert.equal(bots(issue).length, 1);
			const first = bots(issue)[0];
			assert.ok(first.body.startsWith(`<!-- windlass-issue:${item.id} -->\n`));
			assert.ok(first.body.includes(origin + "/items/" + item.id));
			await change(issue, "closed");
			await until("filer close", async () => (await g2User.item(item.id)).state === "cancelled");
			await until("updated to cancelled", async () => bots(issue)[0]?.body.includes("cancelled"));
			assert.deepEqual(
				bots(issue).map(c => c.id),
				[first.id],
			);
		});
		await check("G3 unlinked writer, linked reader refusal once, competing owner and removed label", async () => {
			const issue = make(49);
			await change(issue, "labeled", stranger);
			assert.equal(bots(issue).length, 0);
			assert.ok(
				logs.includes(`github.intake.unlinked installation=${installation.id} delivery=${standin.deliveries[0].guid}`),
			);
			await change(issue, "labeled", reader);
			await change(issue, "labeled", reader);
			assert.equal(bots(issue).length, 1);
			assert.match(bots(issue)[0].body, /read access/);
			assert.equal((await readerAccount.user.listItems()).length, 0);
			assert.deepEqual(issueReactions(issue), []);
			const second = make(50, stranger);
			await change(second, "labeled");
			await change(second, "labeled", peer);
			assert.ok(bots(second).some(c => c.body.includes("another Windlass user")));
			assert.equal((await peerAccount.user.listItems()).length, 0);
			const removed = make(51);
			standin.issueEvent(removed, "labeled", writer);
			standin.issueEvent(removed, "unlabeled", peer);
			await notify(removed, "labeled");
			assert.deepEqual(await items(removed), []);
		});
		await check("G3 a linked writer's fetched command starts their own issue on their own budget", async () => {
			const issue = make(55, peer);
			const msg = standin.issueComment(issue, peer, "@windlass-fk4w check the blue button");
			await mention(issue, msg.id, peer);
			const [item] = (await peerAccount.user.listItems()).filter(i => i.origin?.issue?.number === 55);
			assert.ok(item);
			assert.equal(item.origin?.sender, peer.login);
			assert.equal(item.origin?.issue?.trusted, true);
			const view = await peerAccount.user.item(item.id);
			assert.ok(view.run);
			assert.ok(view.task.body.endsWith("The person adds: check the blue button"));
			assert.deepEqual(await items(issue), []);
		});
		await check("G3 another connected installation cannot mint a token for an already bound issue", async () => {
			const issue = make(56, reader);
			await change(issue, "labeled");
			const [item] = await items(issue);
			assert.equal(item?.state, "draft");
			const other = standin.addInstallation("g3-org", "Organization");
			other.repositories.add(projectG2.id);
			const connect = await g2User.githubConnect({ origin });
			const back = await fetch(standin.authorize(owner, connect.url), { redirect: "manual" });
			await g2User.githubComplete(back.headers.get("location")!.split("#github=")[1]);
			assert.ok(
				(await client.githubAccount.get([String(writer.id)], service()).internalWho())?.installations.includes(
					other.id,
				),
			);
			const before = standin.minted.length;
			await notify(issue, "labeled", writer, other.id);
			await notify(issue, "unlabeled", writer, other.id);
			assert.ok(!standin.minted.slice(before).some(t => t.installation === other.id));
			assert.equal((await g2User.item(item.id)).state, "draft");
		});
		await check("G3 owner closure while working withdraws the actual turn", async () => {
			const { person, account } = await newWriter("g3-close");
			const issue = make(52, person);
			issue.body = "Build this carefully (slow).";
			await applyLabel(issue, "windlass:quick", person);
			const [item] = await items(issue, account);
			assert.ok(item);
			await until(
				"running issue turn",
				async () => (await account.listSessions()).some(s => s.id === item.sessionId && s.status === "running"),
				30_000,
			);
			await change(issue, "closed", person);
			await until("filer close while working", async () => (await account.item(item.id)).state === "cancelled");
			await until(
				"issue session interrupted",
				async () => (await account.listSessions()).find(s => s.id === item.sessionId)?.lastOutcome === "interrupted",
			);
		});
		await check("G3 a fetched merge ends the issue item; a fresh label files generation two", async () => {
			const clock = () =>
				client.githubHooks.getOrCreate(["app"], service()) as unknown as {
					checkFallback(ms: number | null): Promise<void>;
				};
			await clock().checkFallback(3500);
			try {
				const { person, account } = await newWriter("g3-merge");
				const issue = make(53, person);
				issue.labels.push("windlass:quick");
				await applyLabel(issue, "windlass", person);
				const [item] = await items(issue, account);
				assert.ok(item);
				const published = await until(
					"published issue item",
					async () => {
						const v = await account.item(item.id);
						return v.pullRequest && v.head ? { head: v.head, pr: v.pullRequest.number } : null;
					},
					45_000,
				);
				ci(published.head, "success");
				await until("issue in review", async () => (await account.item(item.id)).state === "review", 20_000);
				const pull = standin.pulls.find(p => p.repository === projectG2.id && p.number === published.pr)!;
				pull.state = "closed";
				pull.merged = true;
				await delivered("pull_request", {
					action: "closed",
					pull_request: { number: published.pr, merged: true, head: { sha: published.head } },
				});
				await until("issue done", async () => (await account.item(item.id)).state === "done", 20_000);
				await until("done comment", async () => bots(issue).some(c => c.body.includes("work item is done")));
				await notify(issue, "labeled", person);
				assert.equal((await items(issue, account)).length, 1);
				await change(issue, "labeled", person);
				assert.equal((await items(issue, account)).length, 2);
				assert.equal((await directory().internalFind({ issue: 53 }))[0].generation, 2);
			} finally {
				await clock().checkFallback(null);
			}
		});
		await check("G3 a failed item retries only for its own writer with a fresh GitHub subject", async () => {
			const { person, account } = await newWriter("g3-retry");
			await account.saveRepositoryChecks({
				repositoryId: projectG2.id,
				checks: [{ name: "build", command: "npm run fail" }],
			});
			const issue = make(54, person);
			await applyLabel(issue, "windlass:quick", person);
			const [item] = await items(issue, account);
			assert.ok(item);
			const fail = async () => {
				const question = await until(
					"repeated required check failure",
					async () => (await account.item(item.id)).question,
					90_000,
				);
				assert.equal(question.kind, "rounds");
				const v = await account.actOnItem({
					id: item.id,
					action: { kind: "answer", question: question.id, choice: "give_up" },
				});
				assert.equal(v.state, "failed");
			};
			await fail();
			await change(issue, "labeled", peer);
			assert.equal((await account.item(item.id)).state, "failed");
			const msg = standin.issueComment(issue, person, "@windlass-fk4w retry");
			await mention(issue, msg.id, person);
			assert.equal((await account.item(item.id)).run?.n, 2);
			await fail();
			await mention(issue, msg.id, person);
			assert.equal((await account.item(item.id)).state, "failed");
			assert.equal((await items(issue, account)).length, 1);
		});
		await check(
			"G3 twenty drafts use the writer's daily limit; the 21st gets one refusal, and a higher limit takes it",
			async () => {
				const quotaUser = standin.addUser("g3-quota");
				projectG2.access.set(quotaUser.login, "write");
				const account = await connectUser(quotaUser.login);
				for (let n = 100; n < 120; n++) await change(make(n, stranger), "labeled", quotaUser);
				const filed = await account.user.listItems();
				assert.equal(filed.length, 20);
				assert.ok(filed.every(i => i.source === "github" && i.state === "draft"));
				const extra = make(120, stranger);
				await change(extra, "labeled", quotaUser);
				await change(extra, "labeled", quotaUser);
				assert.equal((await account.user.listItems()).length, 20);
				assert.equal(bots(extra).length, 1);
				assert.match(bots(extra)[0].body, /20 work items from GitHub today/);
				const settings = client.githubHooks.getOrCreate(["app"], service()) as unknown as {
					checkDailyLimit(n: number): Promise<void>;
				};
				await settings.checkDailyLimit(21);
				try {
					// Drafts are no cap of their own: the one daily limit holds them.
					const another = make(121, stranger);
					await change(another, "labeled", quotaUser);
					assert.ok(!bots(another).some(c => /couldn't start this issue because/.test(c.body)));
					assert.equal((await account.user.listItems()).length, 21);
				} finally {
					await settings.checkDailyLimit(20);
				}
			},
		);
		// Linear: the same intake, queue, cap and placement, filed from an issue the platform has validated. No GitHub issue, no writeback.
		type LinearFiling = import("../server/src/factory/intake.js").LinearFiling;
		type TrackerFiled = import("../server/src/factory/intake.js").TrackerFiled;
		const linearOwner = async (login: string) => {
			const person = standin.addUser(login);
			projectG2.access.set(login, "write");
			const connected = await connectUser(login);
			const filings = client.user.get([connected.uid], service()) as unknown as {
				internalGithubIntake(input: { linearFiling: LinearFiling }): Promise<TrackerFiled>;
			};
			const ownerId = "lin_owner_" + login.replace(/\W/g, "_");
			let n = 0;
			const filing = (
				more: {
					number?: number;
					creator?: { id: string; name: string } | null;
					labels?: string[];
					via?: "label" | "assignment";
					repository?: number | string;
					closed?: boolean;
					title?: string;
					description?: string;
				} = {},
			): LinearFiling => {
				const number = more.number ?? ++n;
				return {
					issue: {
						id: `lin_issue_${login.replace(/\W/g, "_")}_${number}`,
						identifier: "ENG-" + number,
						url: `https://linear.app/acme/issue/ENG-${number}/a-title`,
						title: more.title ?? `Linear issue ${number}`,
						description: more.description ?? "Add a short program.\n- [ ] It prints hello",
						labels: more.labels ?? ["windlass"],
						creator: more.creator === undefined ? { id: ownerId, name: "Ada Owner" } : more.creator,
						...(more.closed && { closed: true }),
					},
					team: { id: "lin_team_1", workspaceId: "lin_workspace_1" },
					repository: { id: more.repository ?? projectG2.id },
					owner: { linearUserId: ownerId },
					trigger: { via: more.via ?? "label", at: Date.now(), sender: { id: ownerId, name: "Ada Owner" } },
				};
			};
			const file = (f: LinearFiling) => filings.internalGithubIntake({ linearFiling: f });
			const probe = (id: string) =>
				client.workItem.get([connected.uid, id], service()) as unknown as {
					checkProvenance(): Promise<{
						github: unknown;
						linear: Record<string, unknown> | null;
						untrusted: string[] | null;
						bindingRows: number;
						issueEffects: number;
					}>;
				};
			const reserve = (issueId: string, generation: number, at = Date.now()) =>
				(
					client.user.get([connected.uid], service()) as unknown as {
						checkReserveLinear(i: string, g: number, at: number): Promise<string>;
					}
				).checkReserveLinear(issueId, generation, at);
			const linear = async () => (await connected.user.listItems()).filter(i => i.source === "linear");
			return { ...connected, person, filing, file, probe, reserve, linear, ownerId };
		};
		await check(
			"G3 Linear issue files once with its provenance, no GitHub binding, and in Plan first mode",
			async () => {
				const o = await linearOwner("g3-linear-owner");
				const f = o.filing();
				const filed = await o.file(f);
				assert.equal(filed.kind, "filed");
				assert.ok(filed.kind === "filed" && filed.state !== "draft");
				const [item] = await o.linear();
				assert.ok(item);
				assert.equal(item.source, "linear");
				assert.equal(item.repository.id, projectG2.id);
				assert.equal(item.mode, "orchestrate");
				assert.deepEqual(item.origin, {
					linear: { id: f.issue.id, identifier: "ENG-1", url: f.issue.url, author: "Ada Owner", trusted: true },
					sender: "Ada Owner",
				});
				assert.equal(item.origin?.issue, undefined);
				const view = await o.user.item(item.id);
				assert.match(view.task.body, /^From Linear issue ENG-1\. https:\/\/linear\.app\//);
				assert.deepEqual(view.task.acceptance, ["It prints hello"]);
				assert.equal(view.events[0]?.said, "Filed from Linear issue ENG-1, written and filed by Ada Owner.");
				// The provenance is kept, and the binding that polls the issue, comments and writes "Closes #n" is not set.
				const kept = await o.probe(item.id).checkProvenance();
				assert.equal(kept.github, null);
				assert.equal(kept.issueEffects, 0);
				assert.equal(kept.bindingRows, 0);
				assert.deepEqual(
					{ ...kept.linear, defaultPlace: undefined, modeReason: undefined, triggeredAt: undefined },
					{
						origin: item.origin,
						workspaceId: "lin_workspace_1",
						teamId: "lin_team_1",
						generation: 1,
						via: "label",
						senderId: o.ownerId,
						triggeredAt: undefined,
						defaultPlace: undefined,
						modeReason: undefined,
					},
				);
				assert.match(String(kept.linear?.modeReason), /Plan first/);
				// Another qualifying event for the same active issue, and a redelivery, file nothing.
				assert.deepEqual(await o.file({ ...f, trigger: { ...f.trigger, via: "assignment" } }), {
					kind: "exists",
					itemId: item.id,
				});
				assert.deepEqual(await o.file(f), { kind: "exists", itemId: item.id });
				assert.equal((await o.linear()).length, 1);
				assert.equal((await o.user.listItems()).filter(i => i.source === "github").length, 0);
				// The source filter and the feed's counts name Linear.
				assert.deepEqual(
					(await o.user.listItems({ source: "linear" })).map(i => i.id),
					[item.id],
				);
				assert.deepEqual(
					(await o.user.listItems({ source: "github" })).map(i => i.id),
					[],
				);
				const feed = await o.user.itemFeed();
				assert.ok(
					feed.counts.byRepository.some(r => r.source === "linear" && r.open === 1 && r.repository === projectG2.id),
				);
				await o.user.actOnItem({ id: item.id, action: { kind: "cancel" } });
			},
		);
		await check(
			"G3 Linear windlass:quick selects Quick, with the saved placement, and the next qualifying event after the item ended files a new one",
			async () => {
				const o = await linearOwner("g3-linear-quick");
				const machine = client.user.get([o.uid], service()) as unknown as {
					checkPlaceMachine(id: string, state: string): Promise<void>;
				};
				const mac = "m_0000000000000003";
				await machine.checkPlaceMachine(mac, "online");
				assert.deepEqual(
					(
						await o.user.item(
							((await o.file(o.filing({ number: 20, labels: ["Windlass", "windlass:quick"] }))) as { itemId: string })
								.itemId,
						)
					).place,
					{ kind: "hosted" },
				);
				await o.user.saveAccountDefaults({
					place: { machine: mac },
					harness: "claude",
					machineProfile: "docker-hardened",
				});
				const first = o.filing({ number: 21, labels: ["windlass", "windlass:quick"] });
				const filed = await o.file(first);
				assert.equal(filed.kind, "filed");
				const quick = await o.user.item((filed as { itemId: string }).itemId);
				assert.equal(quick.mode, "single");
				assert.deepEqual(quick.place, { kind: "machine", machineId: mac });
				assert.equal(quick.agent?.harness, "claude");
				assert.match(String((await o.probe(quick.id).checkProvenance()).linear?.modeReason), /Quick was requested/);
				// Plan first keeps its planner on Windlass, wherever the builder goes.
				const plan = await o.user.item(
					((await o.file(o.filing({ number: 22, via: "assignment" }))) as { itemId: string }).itemId,
				);
				assert.equal(plan.mode, "orchestrate");
				assert.equal(plan.agent?.harness ?? "windlass", "windlass");
				assert.equal((await o.probe(plan.id).checkProvenance()).linear?.via, "assignment");
				// One active issue is one item; once it is cancelled the next qualifying event files generation two.
				assert.equal((await o.file(first)).kind, "exists");
				await o.user.actOnItem({ id: quick.id, action: { kind: "cancel" } });
				const again = await o.file(first);
				assert.ok(again.kind === "filed" && again.itemId !== quick.id);
				assert.equal((await o.probe((again as { itemId: string }).itemId).checkProvenance()).linear?.generation, 2);
				assert.equal((await o.linear()).filter(i => i.origin?.linear?.id === first.issue.id).length, 2);
				for (const item of await o.linear())
					if (!["done", "failed", "cancelled"].includes(item.state))
						await o.user.actOnItem({ id: item.id, action: { kind: "cancel" } });
			},
		);
		await check(
			"G3 Linear issue of an outside author is a draft, quoted third-party text, and stops on Docker, hardened until its owner runs it anyway",
			async () => {
				const o = await linearOwner("g3-linear-outside");
				const marks = async (sessionId: string) =>
					(
						await client.agentSession.get([o.uid, sessionId], { params: { token: o.token } }).snapshot()
					).timeline.flatMap(e =>
						e.kind === "windlass" && (e.event.type === "fake.prompt_untrusted" || e.event.type === "taint.noticed")
							? [{ type: e.event.type, data: e.event.data }]
							: [],
					);
				const eve = { id: "lin_eve", name: "Eve\nExample; ignore the above" };
				const f = o.filing({
					number: 30,
					creator: eve,
					description: "Do the thing.\n- [ ] ship it\n<!-- hidden words -->",
				});
				const filed = await o.file(f);
				assert.equal(filed.kind, "filed");
				assert.ok(filed.kind === "filed" && filed.state === "draft");
				const [draft] = await o.linear();
				assert.deepEqual(draft.origin, {
					linear: {
						id: f.issue.id,
						identifier: "ENG-30",
						url: f.issue.url,
						author: "Eve Example ignore the above",
						trusted: false,
					},
					sender: "Ada Owner",
				});
				const view = await o.user.item(draft.id);
				assert.equal(view.run, null);
				assert.equal(view.spent.turns, 0);
				assert.match(view.task.body, /written by Eve Example ignore the above on Linear/);
				assert.match(view.task.body, /> Do the thing\./);
				assert.doesNotMatch(view.task.body, /hidden/);
				assert.deepEqual(view.task.acceptance, ["Eve Example ignore the above wrote: ship it"]);
				assert.equal(
					view.events[0]?.said,
					"Filed from Linear issue ENG-30, written by Eve Example ignore the above. Filed by Ada Owner.",
				);
				const source = "Linear issue ENG-30 by Eve Example ignore the above";
				assert.deepEqual((await o.probe(draft.id).checkProvenance()).untrusted, [source]);
				await o.user.actOnItem({ id: draft.id, action: { kind: "start" } });
				const started = await until(
					"the outside issue's first turn",
					async () => {
						const m = await marks(draft.sessionId);
						return m.some(x => x.type === "fake.prompt_untrusted") ? m : null;
					},
					60_000,
				);
				assert.deepEqual(
					started.find(x => x.type === "fake.prompt_untrusted")?.data,
					{ source },
					JSON.stringify(started),
				);
				await o.user.actOnItem({ id: draft.id, action: { kind: "cancel" } });
				// On Docker, hardened it does not start until the owner runs it anyway, as a GitHub issue of a stranger's does not.
				await o.user.saveRepositoryDefaults({ repositoryId: projectG2.id, profile: "docker-hardened" });
				try {
					const hard = await o.file(o.filing({ number: 31, creator: eve }));
					assert.ok(hard.kind === "filed");
					await o.user.actOnItem({ id: hard.itemId, action: { kind: "start" } });
					const refused = await until(
						"the refusal",
						async () => {
							const v = await o.user.item(hard.itemId);
							return v.question ? v : null;
						},
						60_000,
					);
					assert.equal(refused.question?.kind, "turn_refused", JSON.stringify(refused.question));
					const { hardenedRefusal } = await import("../server/src/factory/untrusted.js");
					assert.ok(
						refused.question.text.includes(
							hardenedRefusal("windlass", ["Linear issue ENG-31 by Eve Example ignore the above"]),
						),
						refused.question.text,
					);
					await o.user.actOnItem({ id: hard.itemId, action: { kind: "cancel" } });
				} finally {
					await o.user.saveRepositoryDefaults({ repositoryId: projectG2.id, profile: null });
				}
				// The owner's own issue is not marked.
				const own = await o.file(o.filing({ number: 32 }));
				assert.ok(own.kind === "filed" && own.state !== "draft");
				assert.equal((await o.probe(own.itemId).checkProvenance()).untrusted, null);
				await o.user.actOnItem({ id: own.itemId, action: { kind: "cancel" } });
			},
		);
		await check("G3 Linear and GitHub share one daily cap, drafts and interrupted reservations included", async () => {
			const o = await linearOwner("g3-linear-cap");
			const settings = client.githubHooks.getOrCreate(["app"], service()) as unknown as {
				checkDailyLimit(n: number): Promise<void>;
			};
			const fixture = client.user.get([o.uid], service()) as unknown as {
				checkInterruptedFiling(id: string, at: number): Promise<void>;
			};
			const midnight = Math.floor(Date.now() / DAY) * DAY;
			const eve = { id: "lin_eve", name: "Eve" };
			await settings.checkDailyLimit(3);
			try {
				// Yesterday's interrupted filing is not today's.
				await fixture.checkInterruptedFiling("i_00000000000000a0", midnight - 1);
				const first = await o.file(o.filing({ number: 40, creator: eve }));
				assert.ok(first.kind === "filed" && first.state === "draft");
				// A GitHub draft takes the second place of the same cap.
				const hub = make(300, reader);
				await applyLabel(hub, "windlass", o.person);
				assert.equal((await o.user.listItems()).filter(i => i.source === "github").length, 1);
				// Today's interrupted filing, on neither tracker's index, takes the third.
				await fixture.checkInterruptedFiling("i_00000000000000a1", midnight);
				const refused = await o.file(o.filing({ number: 41 }));
				assert.ok(
					refused.kind === "refused" && /3 work items from Linear today/.test(refused.reason),
					JSON.stringify(refused),
				);
				const hubTwo = make(301, reader);
				await applyLabel(hubTwo, "windlass", o.person);
				assert.equal((await o.user.listItems()).filter(i => i.source === "github").length, 1);
				assert.match(bots(hubTwo)[0]?.body ?? "", /3 work items from GitHub today/);
				assert.equal((await o.linear()).length, 1);
				// A refused issue is not remembered: with room again, the same issue files.
				await settings.checkDailyLimit(4);
				assert.equal((await o.file(o.filing({ number: 41 }))).kind, "filed");
				assert.equal((await o.file(o.filing({ number: 42 }))).kind, "refused");
			} finally {
				await settings.checkDailyLimit(20);
			}
			for (const item of await o.user.listItems())
				if (!["done", "failed", "cancelled"].includes(item.state))
					await o.user.actOnItem({ id: item.id, action: { kind: "cancel" } });
		});
		await check(
			"G3 Linear: an interrupted filing is finished once, whatever the cap says by then, and the web's and API's keys are apart",
			async () => {
				const o = await linearOwner("g3-linear-resume");
				const settings = client.githubHooks.getOrCreate(["app"], service()) as unknown as {
					checkDailyLimit(n: number): Promise<void>;
				};
				const f = o.filing({ number: 50 });
				const reserved = await o.reserve(f.issue.id, 1);
				// The reservation is the filing's own: the cap of one is full with it, and the retry still finishes it.
				await settings.checkDailyLimit(1);
				try {
					const filed = await o.file({ ...f, issue: { ...f.issue, title: "The issue was renamed meanwhile" } });
					assert.deepEqual(filed.kind === "filed" && filed.itemId, reserved);
					assert.equal((await o.file(f)).kind, "exists");
					assert.equal((await o.linear()).length, 1);
					assert.equal((await o.file(o.filing({ number: 51 }))).kind, "refused");
				} finally {
					await settings.checkDailyLimit(20);
				}
				// A web item under the same text of a key is not the Linear filing's, and shares no cap of its own.
				const web = await o.user.createItem({
					title: "From the form",
					body: "A separate submission.",
					repository: { id: projectG2.id },
					idempotencyKey: `linear:${f.issue.id}:1`,
				});
				assert.equal(web.source, "web");
				assert.notEqual(web.id, reserved);
				await o.user.actOnItem({ id: reserved, action: { kind: "cancel" } });
				await o.user.actOnItem({ id: web.id, action: { kind: "cancel" } });
			},
		);
		await check(
			"G3 Linear filing refuses what the owner's connection cannot take, and a closed or malformed issue files nothing",
			async () => {
				const o = await linearOwner("g3-linear-refusals");
				const none = async () => assert.equal((await o.linear()).length, 0);
				assert.equal((await o.file(o.filing({ closed: true }))).kind, "ignored");
				const odd = o.filing();
				(odd.issue as { url: string }).url = "javascript:alert(1)";
				assert.equal((await o.file(odd)).kind, "refused");
				assert.equal((await o.file({ ...o.filing(), repository: { id: "not an id" } })).kind, "refused");
				assert.equal((await o.file(o.filing({ repository: 9_999_999 }))).kind, "refused");
				projectG2.access.set(o.person.login, "read");
				try {
					const read = await o.file(o.filing());
					assert.ok(read.kind === "refused" && /Not taken/.test(read.reason), JSON.stringify(read));
				} finally {
					projectG2.access.set(o.person.login, "write");
				}
				await none();
				assert.equal((await o.file(o.filing())).kind, "filed");
				for (const item of await o.linear()) await o.user.actOnItem({ id: item.id, action: { kind: "cancel" } });
			},
		);
		await check("unlinked status creates no inbox, installation lifecycle events are admitted", async () => {
			const id = 93333,
				guid = randomUUID();
			const res = await send({ ...shaPayload, installation: { id } }, guid);
			assert.equal(res.status, 202);
			assert.deepEqual(await res.json(), { taken: false });
			await assert.rejects(client.githubInbox.get([String(id)]).resolve(), absent);
			for (const event of ["installation", "installation_repositories"]) {
				const lifecycle = await standin.deliver(
					web,
					event,
					{ action: "created", installation: { id, account: { id: 1 } }, repositories_added: [] },
					{ secret },
				);
				assert.deepEqual(await lifecycle.json(), { taken: true });
			}
			assert.equal(await known(guid, id), false);
		});
		await check("changing a user's installation list removes its old memberships", async () => {
			const before = connection([94444, 95555]),
				after = connection([95555]);
			const payload = { ...shaPayload, installation: { id: 94444 } };
			await updateGithubAccount(accountContext, "changing", null, before);
			assert.deepEqual(await (await send(payload)).json(), { taken: true });
			await updateGithubAccount(accountContext, "changing", before, after);
			const guid = randomUUID();
			assert.deepEqual(await (await send(payload, guid)).json(), { taken: false });
			assert.equal(await known(guid, 94444), false);
			await updateGithubAccount(accountContext, "changing", after, null);
		});
		await check("edge table and its excluded neighbours", () => {
			const user = { id: 5, login: "ada", type: "User" };
			const subject = {
				id: 7,
				user,
				author_association: "OWNER",
				body: "@windlass-fk4w fix",
				commit_id: HEAD,
				path: "src/a",
				line: 9,
			};
			const p = {
				...shaPayload,
				action: "created",
				sender: user,
				issue: { number: 3, user, author_association: "OWNER" },
				pull_request: { number: 4, head: { sha: HEAD }, merged: false },
				review: { ...subject, state: "changes_requested" },
				comment: subject,
			};
			const meta = { guid: randomUUID(), at: 42, appId: standin.appId, slug: standin.slug };
			const take = (event: string, changes: object) => edge(event, { ...p, ...changes }, meta);
			for (const action of ["labeled", "unlabeled", "closed", "reopened", "edited", "deleted", "transferred"]) {
				assert.equal(take("issues", { action, label: { name: "windlass" } })?.event, "issues", action);
			}
			assert.equal(take("issues", { action: "labeled", label: { name: "else" } }), null);
			assert.equal(take("issues", { action: "opened" }), null);
			const comment = take("issue_comment", {
				comment: { ...subject, body: "/windlass " + "x".repeat(20_000) },
				issue: { ...p.issue, pull_request: {} },
			});
			assert.ok(
				comment?.event === "issue_comment" &&
					comment.data.isPullRequest &&
					comment.data.body.length === 16_000 &&
					comment.data.body.endsWith("…"),
			);
			for (const changes of [
				{ comment: { ...subject, body: "hello @windlass-fk4w" } },
				{ sender: { ...user, type: "Bot" } },
				{ action: "edited" },
			])
				assert.equal(take("issue_comment", changes), null);
			for (const action of ["closed", "reopened", "synchronize"])
				assert.deepEqual(take("pull_request", { action })?.data, { pr: 4, head: HEAD, merged: false });
			assert.equal(take("pull_request", { action: "opened" }), null);
			// Marked ready on GitHub: it wakes the item's pull request poll and carries no base for the setup guide check.
			const based = { ...p.pull_request, base: { sha: HEAD } };
			assert.deepEqual(take("pull_request", { action: "ready_for_review", pull_request: based })?.data, {
				pr: 4,
				head: HEAD,
				merged: false,
			});
			assert.equal(take("pull_request", { action: "converted_to_draft", pull_request: based }), null);
			assert.ok(take("pull_request_review", { action: "submitted", review: { ...p.review, body: "" } }));
			assert.ok(take("pull_request_review", { action: "submitted", review: { ...p.review, state: "commented" } }));
			assert.ok(
				take("pull_request_review", { action: "submitted", review: { ...subject, state: "approved", body: "ok" } }),
			);
			assert.ok(take("pull_request_review_comment", {}));
			assert.equal(take("pull_request_review_comment", { comment: { ...subject, body: "fix" } }), null);
			for (const event of ["check_suite", "check_run"]) {
				assert.deepEqual(take(event, { action: "completed", [event]: { head_sha: HEAD } })?.data, { head: HEAD });
				assert.equal(take(event, { action: "created", [event]: { head_sha: HEAD } }), null);
			}
			const rerun = { id: "9007199254740993", name: "windlass/verified", head_sha: HEAD, app: { id: standin.appId } };
			assert.deepEqual(take("check_run", { action: "rerequested", check_run: rerun })?.data, {
				head: HEAD,
				runId: rerun.id,
			});
			for (const other of [
				{ ...rerun, name: "other" },
				{ ...rerun, app: { id: 123, slug: standin.slug } },
			])
				assert.equal(take("check_run", { action: "rerequested", check_run: other }), null);
			for (const state of ["success", "failure", "error"])
				assert.deepEqual(take("status", { state })?.data, { head: HEAD });
			assert.equal(take("status", { state: "pending" }), null);
			for (const event of ["installation", "installation_repositories"])
				assert.deepEqual(
					take(event, {
						installation: { id: 1, account: { id: 2 } },
						repositories_added: [{ id: 9 }],
						repositories_removed: [{ id: 8 }],
					})?.data,
					{ senderId: user.id },
				);
			assert.equal(take("installation", {}), null);
			assert.equal(take("installation_repositories", {}), null);
			assert.equal(take("push", {}), null);
			assert.equal(take("status", { installation: {} }), null);
			assert.equal(isAddressed(" \n@WINDLASS-FK4W fix it", standin.slug), "fix it");
			assert.equal(isAddressed("/WINDLASS", standin.slug), "");
			assert.equal(isAddressed("@windlass-fk4w-more hi", standin.slug), null);
		});
		const wideInstallation = 9007199254740993n;
		await updateGithubAccount(accountContext, "wide", null, connection([String(wideInstallation)]));
		await check("signed comments and reviews keep adjacent 64-bit repository, sender and subject ids", async () => {
			for (const event of ["issue_comment", "pull_request_review_comment", "pull_request_review"]) {
				const review = event === "pull_request_review",
					guid = randomUUID();
				const subject = {
					id: 9007199254740995n,
					body: "/windlass fix",
					state: "changes_requested",
					commit_id: HEAD,
					path: "a",
				};
				const payload = {
					action: review ? "submitted" : "created",
					installation: { id: wideInstallation },
					repository: { id: 9007199254740996n },
					sender: { id: 9007199254740997n, login: "ada", type: "User" },
					issue: { number: 4 },
					pull_request: { number: 4 },
					[review ? "review" : "comment"]: subject,
				};
				assert.deepEqual(await (await standin.deliver(web, event, payload, { secret, guid })).json(), { taken: true });
				const row = await fixture(String(wideInstallation)).checkRow(guid);
				assert.equal(row?.repository, "9007199254740996");
				const data = JSON.parse(row.data);
				assert.equal(data.sender.id, "9007199254740997");
				assert.equal(review ? data.reviewId : data.commentId, "9007199254740995");
			}
		});
		await check("signed status without a waiting item is ignored", async () => {
			const guid = randomUUID(),
				r = await send(shaPayload, guid);
			assert.equal(r.status, 202);
			assert.deepEqual(await r.json(), { taken: true });
			assert.equal(await known(guid), true);
			const row = await until("ignored", async () => {
				const r = await fixture(91234).checkRow(guid);
				return r?.state === "ignored" ? r : null;
			});
			assert.equal(row.said, "no item");
			assert.equal(row.attempts, 1);
		});
		await check("installation events finish with one metadata log", async () => {
			for (const event of ["installation", "installation_repositories"]) {
				const guid = randomUUID(),
					id = 91234;
				const payload = {
					installation: { id, account: { id: 1 } },
					action: "created",
					repositories_added: [],
					repositories: [{ id: 13 }],
					description: bodyMarker,
				};
				assert.equal((await standin.deliver(web, event, payload, { secret, guid })).status, 202);
				await until("installation handled", async () => (await fixture(id).checkRow(guid))?.state === "done");
				assert.equal(
					logs.split(`github.installation event=${event}.created installation=${id} delivery=${guid}`).length - 1,
					1,
				);
			}
		});
		await check("bad signature stores nothing", async () => {
			const guid = randomUUID();
			const r = await standin.deliver(web, "status", shaPayload, { secret: randomBytes(32).toString("hex"), guid });
			assert.equal(r.status, 401);
			assert.equal(await known(guid), false);
		});
		await check("missing headers store nothing", async () => {
			for (const omit of ["x-hub-signature-256", "x-github-event", "x-github-delivery"]) {
				const guid = randomUUID();
				assert.equal((await local({ omit, guid })).status, 400);
				assert.equal(await known(guid), false);
			}
		});
		await check("raw bytes before JSON", async () => {
			const body = JSON.stringify(shaPayload, null, 2);
			assert.equal((await local({ body, signBytes: JSON.stringify(shaPayload) })).status, 401);
			assert.equal((await local({ body })).status, 202);
			assert.equal((await local({ body: "{", signBytes: "different" })).status, 401);
		});
		await check("previous secret rotation", async () => {
			try {
				assert.equal((await local({ secret: previous })).status, 202);
				delete process.env.WLP_GITHUB_WEBHOOK_SECRET_PREVIOUS;
				assert.equal((await local({ secret: previous })).status, 401);
			} finally {
				process.env.WLP_GITHUB_WEBHOOK_SECRET_PREVIOUS = previous;
			}
		});
		await check("target App before JSON", async () => {
			assert.equal((await local({ target: "7777", body: "{" })).status, 403);
		});
		await check("off without current secret or App", async () => {
			try {
				delete process.env.WLP_GITHUB_WEBHOOK_SECRET;
				const r = await local({ method: "GET" });
				assert.equal(r.status, 404);
				assert.equal(r.headers.get("cache-control"), "no-store");
				assert.equal((await send(shaPayload, randomUUID(), second)).status, 404);
				process.env.WLP_GITHUB_WEBHOOK_SECRET = secret;
				delete process.env.WLP_GITHUB_APP_ID;
				assert.equal((await local()).status, 404);
			} finally {
				process.env.WLP_GITHUB_WEBHOOK_SECRET = secret;
				process.env.WLP_GITHUB_APP_ID = standin.appId;
			}
		});
		await check("fallback accepts only 1 with a current webhook secret", () => {
			assert.equal(githubConfig().pollFallback, false);
			assert.equal(githubConfig({ ...process.env, WLP_GITHUB_POLL_FALLBACK: "1" }).pollFallback, true);
			assert.throws(() => githubConfig({ WLP_GITHUB_POLL_FALLBACK: "1" }), /requires WLP_GITHUB_WEBHOOK_SECRET/);
			assert.throws(() => githubConfig({ WLP_GITHUB_POLL_FALLBACK: "0" }), /1 or unset/);
		});
		await check("invalid short secrets name only the setting", () => {
			for (const name of ["WLP_GITHUB_WEBHOOK_SECRET", "WLP_GITHUB_WEBHOOK_SECRET_PREVIOUS"]) {
				for (const value of ["", "short"])
					assert.throws(
						() => githubConfig({ [name]: value }),
						(e: Error) => e.message === name + " must be at least 32 characters long",
					);
			}
		});
		await check("POST method required", async () => {
			assert.equal((await local({ method: "GET" })).status, 405);
		});
		await check("two MiB body limit", async () => {
			const guid = randomUUID(),
				large = JSON.stringify(shaPayload).padEnd(2 * 1024 * 1024 + 1);
			assert.equal((await local({ body: large, guid })).status, 413);
			assert.equal(await known(guid), false);
		});
		await check("listener rejects a chunked body over three MiB before webhook header validation", async () => {
			const cap = 3 * 1024 * 1024;
			assert.equal((await fetch(web, { method: "POST", body: new Uint8Array(cap) })).status, 400);
			const body = new ReadableStream({
				start(c) {
					c.enqueue(new Uint8Array(cap));
					c.enqueue(Uint8Array.of(1));
					c.close();
				},
			});
			const request: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
			const res = await fetch(web, request);
			assert.equal(res.status, 413);
			assert.equal(await res.text(), "Payload Too Large");
		});
		await check("invalid JSON", async () => {
			assert.equal((await local({ body: "{" })).status, 400);
		});
		await check("ping acknowledged without storage", async () => {
			const guid = randomUUID();
			const r = await local({ event: "ping", guid });
			assert.equal(r.status, 202);
			assert.deepEqual(await r.json(), { taken: false });
			assert.equal(await known(guid), false);
		});
		await check("duplicate and two installations", async () => {
			const guid = randomUUID();
			const one = await send(shaPayload, guid);
			assert.deepEqual(await one.json(), { taken: true });
			const two = await send(shaPayload, guid);
			assert.deepEqual(await two.json(), { taken: "duplicate" });
			assert.equal(await known(guid, 92222), false);
			assert.deepEqual(await (await send({ ...shaPayload, installation: { id: 92222 } }, guid)).json(), {
				taken: true,
			});
			assert.equal(await known(guid, 92222), true);
			assert.equal(logs.split("github.delivery.stored event=status installation=91234 delivery=" + guid).length - 1, 1);
		});
		await check("two HTTP servers one concurrent GUID", async () => {
			const guid = randomUUID();
			const replies = await Promise.all(
				[web, second].map(async url => (await (await send(shaPayload, guid, url)).json()).taken),
			);
			assert.deepEqual(replies.map(String).sort(), ["duplicate", "true"]);
			assert.equal(await known(guid), true);
		});
		for (const [action, total, terminal] of [
			["created", 4, "done"],
			["suspended", 8, "failed"],
		] as const) {
			await check("retry to " + terminal + " in " + total + " attempts", async () => {
				const guid = randomUUID(),
					id = RETRY_INSTALLATION;
				const res = await standin.deliver(
					web,
					"installation",
					{ action, installation: { id, account: { id: 1 } } },
					{ secret, guid },
				);
				assert.equal(res.status, 202);
				for (let attempt = 1; attempt <= total; attempt++) {
					const row = await until(
						"handler attempt " + attempt,
						async () => {
							const r = await fixture(id).checkRow(guid);
							return r && r.attempts >= attempt ? r : null;
						},
						20_000,
					);
					assert.equal(row.attempts, attempt);
					if (attempt === total) {
						assert.equal(row.state, terminal);
						break;
					}
					assert.equal(row.state, "received");
					assert.ok(row.attemptedAt);
					const delay = row.next_at - row.attemptedAt,
						expected = Math.min(1_800_000, 15_000 * 2 ** (attempt - 1));
					assert.ok(delay >= expected && delay <= expected + 1000, "retry delay");
					if (attempt === 1 && terminal === "done") continue; // Let the real 15 s schedule fire once.
					await fixture(id).checkFixture("retry", guid);
					await inbox(id).internalDue();
				}
			});
		}
		await check("waiting limit maps to HTTP 503", async () => {
			const id = 92123,
				guid = randomUUID();
			await fixture(id).checkFixture("full", "");
			const res = await send({ ...shaPayload, installation: { id } }, guid);
			assert.equal(res.status, 503);
			assert.equal(await known(guid, id), false);
		});
		await check("twenty thousand rows evict oldest finished first", async () => {
			const id = 92678;
			await fixture(id).checkFixture("capacity", "");
			assert.equal((await send({ ...shaPayload, installation: { id } })).status, 202);
			assert.equal(await known("fixture-1", id), true); // failed
			assert.equal(await known("fixture-2", id), false); // oldest ignored
			assert.equal(await known("fixture-3", id), true);
		});
		await check("seven day retention", async () => {
			const guid = randomUUID();
			await send(shaPayload, guid);
			await fixture(91234).checkFixture("expire", guid);
			await until("expired row removed", async () => {
				await inbox(91234).internalDue();
				return (await fixture(91234).checkRow(guid)) === null;
			});
		});
		const ada = standin.addUser("ada");
		const install = standin.addInstallation("ada", "User");
		const project = standin.addRepository({ owner: "ada", name: "project", installation: install });
		const repo = client.githubRepository.getOrCreate([String(project.id)], service());
		await check("the repository directory has no permission action", async () => {
			const removed = repo as unknown as { internalPermission(input: object): Promise<unknown> };
			await assert.rejects(
				removed.internalPermission({
					installationId: install.id,
					owner: "ada",
					name: "project",
					userId: ada.id,
					login: "ada",
					associations: "OWNER",
				}),
			);
		});
		await check("repository registration, lookup and removal", async () => {
			const row = { uid: "one", itemId: "item", issue: 12, generation: 1 };
			await repo.internalRegister(row);
			await repo.internalRegister({ uid: "one", itemId: "item", pr: 13, head: HEAD });
			for (const key of [{ issue: 12 }, { pr: 13 }, { head: HEAD }])
				assert.equal((await repo.internalFind(key))[0]?.itemId, "item");
			await assert.rejects(repo.internalRegister({ ...row, uid: "two", itemId: "another" }));
			await repo.internalForget("item");
			assert.equal((await repo.internalFind({ issue: 12 })).length, 0);
		});
		await check(
			"64-bit installation bindings distinguish adjacent IDs and a new head replaces the old one",
			async () => {
				const a = "9007199254740995",
					b = "9007199254740996",
					row = { itemId: "wide-item", uid: "one", pr: 14, installationId: a };
				await repo.internalRegister({ ...row, head: HEAD });
				await repo.internalRegister({ ...row, head: "b".repeat(40) });
				assert.equal((await repo.internalFind({ pr: 14, installationId: a })).length, 1);
				assert.deepEqual(await repo.internalFind({ pr: 14, installationId: b }), []);
				assert.deepEqual(await repo.internalFind({ head: HEAD }), []);
				await repo.internalForget(row.itemId);
			},
		);
		await check("connect, replace, old disconnect, current disconnect", async () => {
			const connect = async () => {
				const auth = await loginHttp(api).demo();
				const user = client.user.getOrCreate([auth.profile.uid], { params: { token: auth.token } });
				const { url } = await user.githubConnect({ origin });
				const back = await fetch(standin.authorize("ada", url), { redirect: "manual" });
				const ticket = back.headers.get("location")?.split("#github=")[1];
				assert.ok(ticket, "ticket issued");
				await user.githubComplete(ticket);
				return { user, uid: auth.profile.uid };
			};
			const account = client.githubAccount.getOrCreate([String(ada.id)], service());
			const payload = { ...shaPayload, installation: { id: install.id } };
			const taken = async () => (await (await send(payload)).json()).taken;
			const a = await connect();
			assert.equal(await taken(), true);
			assert.deepEqual(await account.internalWho(), { uid: a.uid, installations: [install.id] });
			const b = await connect();
			assert.deepEqual(await account.internalWho(), { uid: b.uid, installations: [install.id] });
			assert.deepEqual(new Set(await account.internalUsers()), new Set([a.uid, b.uid]));
			await a.user.githubRepositories("", true);
			assert.equal((await account.internalWho())?.uid, b.uid);
			// The installation account matches both connections even when someone else sent the event.
			standin.uninstall(install);
			await delivered(
				"installation",
				{ action: "deleted", installation: { id: install.id, account: install.account } },
				install.id,
			);
			const personal = standin.addInstallation("ada", "User");
			await delivered(
				"installation",
				{ action: "created", installation: { id: personal.id, account: personal.account }, sender: { id: 1 } },
				personal.id,
			);
			for (const { user } of [a, b])
				assert.deepEqual(
					(await user.github()).connection?.accounts.map(i => i.installationId),
					[personal.id],
				);
			payload.installation.id = personal.id;
			await a.user.githubDisconnect();
			assert.equal((await account.internalWho())?.uid, b.uid);
			assert.equal(await taken(), true);
			await b.user.githubDisconnect();
			assert.equal(await account.internalWho(), null);
			assert.equal(await taken(), false);
		});
		await check("service-only actors", async () => {
			await assert.rejects(client.githubAccount.getOrCreate(["1"]).internalWho());
			await assert.rejects(client.githubHooks.getOrCreate(["app"]).internalInstallationUsers(installation.id));
			await assert.rejects(
				g2User.internalUpdateGithubInstallation({ kind: "remove", installationId: installation.id }),
			);
			await assert.rejects(client.githubInbox.getOrCreate(["1"]).internalKnows(randomUUID()));
			await assert.rejects(client.githubRepository.getOrCreate(["1"]).internalFind({ pr: 1 }));
			await assert.rejects(client.githubHooks.getOrCreate(["app"]).internalSweep());
		});
		for (const [name, valid, invalid] of [
			["githubInbox", ["1"], ["1", "2"]],
			["githubAccount", ["1"], ["01"]],
			["githubRepository", ["9007199254740993"], ["9223372036854775808"]],
			["githubHooks", ["app"], ["other"]],
		] as const) {
			const actors = client[name];
			const probe = (handle: unknown) => (handle as { checkConnection(): Promise<boolean> }).checkConnection();
			await check(name + " refuses external connections before dispatch", async () => {
				assert.equal(await probe(actors.getOrCreate([...valid], service())), true);
				await assert.rejects(probe(actors.get([...valid])), (e: { code: string }) => e.code === "unauthorized");
			});
			await check(name + " destroys a bad getOrCreate key", async () => {
				const handle = actors.getOrCreate([...invalid], service());
				await handle.resolve();
				await until(
					"bad key to disappear",
					() =>
						actors
							.get([...invalid])
							.resolve()
							.then(
								() => false,
								e => {
									if (!absent(e)) throw e;
									return true;
								},
							),
					2500,
				);
			});
		}
		await check("sweep posts the exact 19-digit delivery id once and skips known GUIDs", async () => {
			// A scheduled sweep may have already redelivered failures from earlier scenarios.
			const firstRequest = standin.requests.length;
			const attempts = () =>
				standin.requests.slice(firstRequest).filter(r => r.method === "POST" && r.path.endsWith("/attempts"));
			standin.deliveries.length = 0;
			const existing = randomUUID(),
				missing = randomUUID(),
				unlinked = 96666;
			assert.equal((await send(shaPayload, existing)).status, 202);
			try {
				offline = true;
				await send({ ...shaPayload, installation: { id: unlinked } }, randomUUID(), second);
				for (const id of [existing, missing]) assert.equal((await send(shaPayload, id, second)).status, 503);
			} finally {
				offline = false;
			}
			const hooks = client.githubHooks.getOrCreate(["app"], service());
			const started = await until(
				"the first delivery to arm the sweep",
				() => (hooks as unknown as { checkStarted(): Promise<number | null> }).checkStarted(),
				35_000,
			);
			assert.ok(started > Date.now() && started <= Date.now() + 600_000, "first delivery armed ten-minute sweep");
			const failedId = standin.deliveries.find(d => d.guid === missing)!.id;
			assert.notEqual(String(Number(failedId)), failedId);
			await hooks.internalSweep();
			assert.deepEqual(
				attempts().map(r => r.path),
				[`/api/v3/app/hook/deliveries/${failedId}/attempts`],
			);
			assert.deepEqual(
				standin.deliveries.filter(d => d.redelivery).map(d => [d.guid, d.status_code]),
				[[missing, 202]],
			);
			assert.equal(await known(missing), true);
			await assert.rejects(client.githubInbox.get([String(unlinked)]).resolve(), absent);
			// The four-day receipt itself must suppress a repeat, even after a missing inbox row.
			await fixture(91234).checkFixture("expire", missing);
			await inbox(91234).internalDue();
			await hooks.internalSweep();
			assert.equal(attempts().length, 1);
			assert.ok(
				standin.requests.some(
					r => r.auth === "jwt" && r.path.includes("status=failure") && r.path.includes("per_page=100"),
				),
			);
		});
		await check("sweep shares 50 attempts across installations and resumes its three-page scan", async () => {
			const hooks = client.githubHooks.getOrCreate(["app"], service());
			await hooks.internalStart();
			standin.deliveries.length = 0;
			try {
				offline = true;
				// Newest first at GitHub: the quiet installation is behind a full page of failures.
				await standin.deliver(second, "push", { installation: { id: wideInstallation } }, { secret });
				for (let i = 0; i < 101; i++)
					await standin.deliver(second, "push", { installation: { id: 91234 } }, { secret });
			} finally {
				offline = false;
			}
			const attempts = () => standin.deliveries.filter(d => d.redelivery).length;
			await hooks.internalSweep();
			assert.equal(attempts(), 50);
			assert.ok(
				standin.deliveries.some(d => d.redelivery && d.installation_id === wideInstallation),
				"quiet installation redelivered on first sweep",
			);
			await hooks.internalSweep();
			assert.equal(attempts(), 100);
			await hooks.internalSweep();
			assert.equal(attempts(), 102);
			const remembered = standin.deliveries.find(d => d.redelivery)!;
			standin.deliveries.length = 0;
			for (let i = 0; i < 301; i++)
				standin.deliveries.push({
					...remembered,
					id: String(3855090938003090001n + BigInt(i)),
					delivered_at: new Date().toISOString(),
					status_code: 503,
				});
			const pages = () => standin.requests.filter(r => r.path.startsWith("/api/v3/app/hook/deliveries?")).length;
			const start = pages();
			await hooks.internalSweep();
			assert.equal(pages() - start, 3);
			await hooks.internalSweep();
			assert.equal(pages() - start, 4);
			assert.ok(standin.requests.at(-1)?.path.includes("cursor=3855090938003090301"), "resumed at the fourth page");
		});
		await check("inbox unreachable or timed out", async () => {
			const transport = globalThis.fetch;
			for (const fail of ["unreachable", "silent"]) {
				try {
					globalThis.fetch = async (_url, init) => {
						if (fail === "unreachable") throw new Error("engine unreachable");
						return new Promise<Response>((_, reject) =>
							init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true }),
						);
					};
					const now = Date.now();
					assert.equal((await local()).status, 503);
					assert.ok(Date.now() - now < 9500, "hard inbox deadline");
				} finally {
					globalThis.fetch = transport;
				}
			}
		});
		await check("logs contain metadata only", () => {
			const dumped = JSON.stringify(githubConfig());
			assert.ok(
				![secret, previous].some(value => dumped.includes(value)),
				"configuration serialized webhook credentials",
			);
			assert.ok(logs.includes("[wlp] github: webhook on /github/webhook"));
			assert.ok(logs.includes("github.delivery.stored event=status"));
			assert.ok(
				![secret, previous, bodyMarker, "sha256="].some(value => logs.includes(value)),
				"private delivery material appeared in node output",
			);
		});
	} finally {
		other.closeAllConnections();
		await new Promise<void>(resolve => other.close(() => resolve()));
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		const guard = setTimeout(() => child.kill("SIGKILL"), 15_000);
		await exited;
		clearTimeout(guard);
		try {
			const { pid } = JSON.parse(readFileSync(join(storage, ".rivetkit/var/engine/runtime.json"), "utf8"));
			if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
		} catch {
			/* Engine exited with its node. */
		}
		await standin.stop();
		rmSync(storage, { recursive: true, force: true });
	}
	if (failed.length) throw new Error(failed.length + " webhook check(s) failed");
}

if (process.argv.includes("--node")) await testNode();
else await run();
