/** cd server && npx tsx ../scripts/gitlab-check.ts intake refuse untrusted */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Registry } from "../server/src/client.js";
import type { AuthResult, GitlabActions } from "../server/src/contract.js";
import { matchesSection } from "./check-sections.js";
import { localListeners } from "./check-listeners.js";
import { GitlabStandin, type StandinProject } from "./gitlab-standin.js";
import type { SandboxCommand } from "./gitlab-workspace-fixture.js";
import { pollUntil, readProvenance } from "./issue-intake-fixture.js";
import { loginHttp } from "./login-http.js";

/** Every sandbox command the platform ran, with environment and standard input, one JSON line each (test storage only). */
const SANDBOX_LOG = "sandbox-commands.jsonl";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Test-only inspection: open the persisted grant with the user/instance binding; return no credentials. */
async function startCheckNode() {
	const { installGitlabWorkspaceFixture } = await import("./gitlab-workspace-fixture.js");
	const storage = process.env.RIVETKIT_STORAGE_PATH!;
	installGitlabWorkspaceFixture(storage, entry =>
		appendFileSync(join(storage, SANDBOX_LOG), JSON.stringify(entry) + "\n", { mode: 0o600 }),
	);
	const { userGitlab } = await import("../server/src/actors/user-gitlab.js");
	const { openSecret, sealSecret } = await import("../server/src/repo-secrets.js");
	const { serverSealer } = await import("../server/src/signin/seal.js");
	const actions = userGitlab.config.actions!;
	Object.assign(actions, {
		checkGrant: async (c: Parameters<typeof actions.gitlab>[0], expire = false) => {
			await actions.gitlab(c); // Same owner check as a settings read.
			const [row] = await c.db.execute<{ sealed: string; issuer: string; viewer: string }>(
				"SELECT sealed, issuer, viewer FROM grant_record",
			);
			assert.ok(row);
			const scope = JSON.stringify(["gitlab", row.issuer, row.viewer]);
			const grant = JSON.parse(openSecret(serverSealer(), c.key[0]!, scope, "oauth-token", row.sealed));
			if (expire) {
				grant.expiresAt = Date.now() - 1;
				const sealed = sealSecret(serverSealer(), c.key[0]!, scope, "oauth-token", JSON.stringify(grant));
				await c.db.execute("UPDATE grant_record SET sealed=? WHERE id=1", sealed);
			}
			return [digest(grant.accessToken), digest(grant.refreshToken)];
		},
	});
	const { gitlabInbox } = await import("../server/src/actors/gitlab-inbox.js");
	const { requireServiceFor } = await import("../server/src/auth.js");
	const inboxActions = gitlabInbox.config.actions!;
	Object.assign(inboxActions, {
		checkSettled: async (c: Parameters<typeof inboxActions.internalReceive>[0], guid: string) => {
			requireServiceFor(c, "call");
			return (await c.db.execute("SELECT 1 FROM inbox WHERE guid=? AND data IS NULL", guid)).length === 1;
		},
	});
	const { workItem } = await import("../server/src/actors/work-item.js");
	const itemActions = workItem.config.actions!;
	Object.assign(itemActions, {
		checkProvenance: async (c: Parameters<typeof itemActions.internalView>[0]) => {
			await itemActions.internalView(c);
			return readProvenance(c);
		},
	});
	await import("../server/src/index.js");
}

/** The builder's clone, fetch and push took project tokens (read, or write to push), each revoked; never the OAuth grant. */
async function sandboxCredentials(fixture: GitlabStandin, p: StandinProject, storage: string) {
	const made = fixture.projectTokens.filter(t => String(t.projectId) === String(p.id));
	assert.ok(
		made.some(t => t.scopes.join() === "read_repository" && t.accessLevel === 20),
		"a read token cloned",
	);
	assert.ok(
		made.some(t => t.scopes.join() === "write_repository" && t.accessLevel === 30),
		"a write token pushed",
	);
	assert.ok(
		made.every(t => t.revoked),
		"every project token was revoked when its operation ended",
	);
	const auth = fixture.gitAuth.filter(a => a.kind !== "none");
	assert.ok(auth.length && auth.every(a => a.kind === "project" && a.status === 200), JSON.stringify(auth));
	const scopeOf = (id: number | null) => made.find(t => t.id === id)?.scopes.join();
	assert.ok(auth.filter(a => a.service === "git-receive-pack").every(a => scopeOf(a.tokenId) === "write_repository"));
	assert.ok(auth.filter(a => scopeOf(a.tokenId) === "read_repository").every(a => a.service === "git-upload-pack"));
	const entries = (await readFile(join(storage, SANDBOX_LOG), "utf8"))
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as SandboxCommand);
	const grants = [...fixture.issued, fixture.token, fixture.clientSecret];
	assert.ok(entries.length && fixture.issued.size);
	for (const entry of entries) {
		const seen = JSON.stringify(entry);
		assert.ok(!grants.some(g => seen.includes(g)), "the owner's OAuth grant entered the sandbox");
		assert.ok(!made.some(t => entry.command.includes(t.token) || JSON.stringify(entry.env).includes(t.token)));
	}
	assert.ok(
		made.every(t => entries.some(e => e.stdin.includes(t.token))),
		"each token reached Git on stdin only",
	);
	console.log(
		`PASS intake: ${made.length} project tokens (${made.map(t => t.scopes.join()).join(", ")}), all revoked; no OAuth grant in ${entries.length} sandbox commands`,
	);
}

/** Without Maintainer the platform cannot make a project token: the item stops and says so, and no Git runs. */
async function refusedToken(
	fixture: GitlabStandin,
	p: StandinProject,
	user: ReturnType<ReturnType<typeof createClient<Registry>>["user"]["get"]>,
	issue: (title: string) => ReturnType<GitlabStandin["addIssue"]>,
) {
	const before = { tokens: fixture.projectTokens.length, auth: fixture.gitAuth.length };
	p.level = 30;
	try {
		const target = issue("Needs a project token");
		const response = await fixture.deliverHook(fixture.hooks[0]!.id, "Issue Hook", fixture.issueEvent(target));
		assert.equal(response.status, 202);
		const row = await pollUntil(20_000)("the item for the refused-token issue", async () =>
			(await user.listItems()).find(i => i.title === target.title),
		);
		// The owner's own label starts the item; an outsider's would wait as a draft.
		if (row.state === "draft") await user.actOnItem({ id: row.id, action: { kind: "start" } });
		const said = `Windlass needs Maintainer access on ${p.owner}/${p.name} to create a short-lived project token for Git`;
		const stopped = await pollUntil(60_000)("the item to stop on the refused project token", async () => {
			const item = await user.item(row.id);
			assert.ok(item.question?.kind !== "rounds", `counted as cut off: ${item.question?.text}`);
			return item.question?.text.includes(said) && item;
		});
		assert.equal(stopped.question?.kind, "turn_refused");
		assert.ok(stopped.question?.text.startsWith(`The agent's turn could not start. ${said}`), stopped.question?.text);
		assert.ok(stopped.state === "waiting" && !stopped.pullRequest);
		assert.equal(fixture.projectTokens.length, before.tokens, "GitLab made no token");
		assert.equal(fixture.gitAuth.length, before.auth, "no Git request ran without a scoped token");
		console.log(
			`PASS intake: without Maintainer the item stops (${stopped.state}) and says what is needed; no Git ran`,
		);
	} finally {
		p.level = 40;
	}
}

/** Exercise public delivery after a real OAuth connect and project selection. The inbox probe only waits for dispatch. */
async function intakeChecks(
	sections: string[],
	fixture: GitlabStandin,
	client: ReturnType<typeof createClient<Registry>>,
	ownerAuth: AuthResult,
	owner: Pick<GitlabActions, "gitlabPickProject" | "gitlabDisconnect">,
	storage: string,
) {
	const p = fixture.addProject({ id: 9007199254740993n, owner: "group/sub", name: "intake" });
	await owner.gitlabPickProject(String(p.id));
	const [hook] = fixture.hooks;
	assert.ok(hook);
	const uid = ownerAuth.profile.uid;
	const user = client.user.get([uid], { params: { token: ownerAuth.token } });
	const outsider = { id: 9007199254740995n, username: "other", name: "Other Author" };
	const issue = (title: string, author = fixture.user) =>
		fixture.addIssue(p, { title, author, description: "Verify the repository task. (report)", labels: ["windlass"] });
	const send = (event: string, body: unknown, options?: Parameters<typeof fixture.deliverHook>[3]) =>
		fixture.deliverHook(hook.id, event, body, options);
	const { serviceParams } = await import("../server/src/auth.js");
	const tenant = createHash("sha256").update(fixture.url).digest("hex").slice(0, 32);
	// A service token is short-lived: each probe takes a new one, however long the section has run.
	const directory = () => client.surfaceAccounts.get(["gitlab", tenant], { params: serviceParams() });
	const inbox = () =>
		client.gitlabInbox.get([uid, String(p.id)], { params: serviceParams() }) as unknown as {
			checkSettled(guid: string): Promise<boolean>;
		};
	const dispatch = async (event: string, payload: unknown, guid = randomUUID()) => {
		const response = await send(event, payload, { guid });
		assert.equal(response.status, 202);
		assert.deepEqual(await response.json(), { taken: true });
		await pollUntil(30_000)("completed dispatch", () => inbox().checkSettled(guid));
	};
	if (sections.includes("refuse")) {
		const target = issue("Must not file"),
			label = fixture.issueEvent(target);
		const wrongSecret = (hook.token[0] === "A" ? "B" : "A") + hook.token.slice(1); // Same owner suffix, wrong token.
		for (const options of [{ omitToken: true }, { secret: wrongSecret }])
			assert.equal((await send("Issue Hook", label, options)).status, 401);
		assert.equal((await send("Issue Hook", { ...label, project: { id: 42 } })).status, 403);
		const note = fixture.addIssueNote(target, "/windlass please", outsider);
		await dispatch("Issue Hook", fixture.issueEvent(target, outsider));
		await dispatch("Note Hook", { ...fixture.noteEvent(target, note), user: fixture.user });
		const ignored = async (event: string, payload: unknown) => {
			const response = await send(event, payload);
			assert.equal(response.status, 202);
			assert.deepEqual(await response.json(), { taken: false });
		};
		await ignored("Issue Hook", { ...label, changes: {} });
		const feature = fixture.noteEvent(target, fixture.addIssueNote(target, "/windlass feature build everything"));
		await ignored("Note Hook", feature);
		await ignored("Note Hook", {
			...feature,
			object_attributes: { ...feature.object_attributes, note: "/windlass", noteable_type: "MergeRequest" },
		});
		target.labels = []; // The label in this delivery has since been removed.
		await dispatch("Issue Hook", label);
		assert.equal((await user.listItems()).length, 0);
		// As on GitHub, the sender's linked account files: connecting GitLab linked the owner's GitLab user, nobody else.
		assert.equal(await directory().internalWho(String(fixture.user.id)), uid);
		assert.equal(await directory().internalWho(String(outsider.id)), null);
		console.log("PASS refuse: wrong credentials, project, sender, stale label and forged note author file nothing");
	}
	if (sections.includes("intake") || sections.includes("untrusted")) {
		const { untrustedTurn } = await import("../server/src/factory/untrusted.js");
		for (const via of ["label", "note"] as const) {
			const target = issue(`Canonical ${via} issue`, via === "label" ? outsider : fixture.user);
			const label = fixture.issueEvent(target),
				note = fixture.addIssueNote(target, "/windlass fix the build");
			const event = via === "label" ? "Issue Hook" : "Note Hook";
			const noteHook = fixture.noteEvent(target, note);
			const body =
				via === "label"
					? { ...label, object_attributes: { ...label.object_attributes, title: "stale title" } }
					: { ...noteHook, object_attributes: { ...noteHook.object_attributes, note: "/windlass outdated request" } };
			const guid = randomUUID();
			await dispatch(event, body, guid);
			const row = await pollUntil(20_000)(`item filed by ${via}`, async () =>
				(await user.listItems()).find(i => i.title === target.title),
			);
			assert.equal(row.source, "gitlab");
			assert.equal(row.repository.provider, "gitlab");
			assert.equal(String(row.repository.id), String(p.id));
			if (via === "label") assert.equal(row.state, "draft");
			else assert.notEqual(row.state, "draft");
			const view = await user.item(row.id);
			assert.ok(view.task.body.includes("> " + target.description));
			if (via === "note") assert.ok(view.task.body.includes("fix the build"));
			const duplicate = await send(event, body, { guid });
			assert.equal(duplicate.status, 202);
			assert.deepEqual(await duplicate.json(), { taken: "duplicate" });
			await dispatch(event, body);
			assert.deepEqual(
				(await user.listItems()).filter(i => i.title === target.title).map(i => i.id),
				[row.id],
			);
			const probe = client.workItem.get([uid, row.id], { params: serviceParams() }) as unknown as {
				checkProvenance(): ReturnType<typeof readProvenance>;
			};
			const kept = await probe.checkProvenance();
			assert.equal(kept.bindingRows, 0);
			assert.deepEqual(kept.untrusted, [
				`GitLab issue #${target.iid}`,
				...(via === "note" ? [`GitLab note ${note.id}`] : []),
			]);
			assert.ok(
				fixture.reactions.has(
					`/projects/${p.id}/issues/${target.iid}${via === "note" ? `/notes/${note.id}` : ""}/award_emoji:eyes`,
				),
			);
			if (sections.includes("untrusted") && via === "note") {
				const session = client.agentSession.get([uid, row.sessionId], { params: { token: ownerAuth.token } });
				const mark = await pollUntil(30_000)("GitLab issue and note markers on Windlass's prompt", async () => {
					const { timeline } = await session.snapshot();
					return timeline.flatMap(e =>
						e.kind === "windlass" && e.event.type === "fake.prompt_untrusted" ? [e.event.data?.source] : [],
					)[0];
				});
				assert.equal(mark, kept.untrusted.join("; "));
			}
			if (sections.includes("intake") && via === "label") {
				await user.actOnItem({ id: row.id, action: { kind: "start" } });
				const until = pollUntil(60_000);
				const mr = await until("the builder's pushed branch and MR", async () => {
					const current = await user.item(row.id);
					assert.ok(
						!current.question && current.state !== "failed",
						`builder stopped: ${current.question?.kind ?? current.state}; ${current.events.at(-1)?.said}`,
					);
					return current.pullRequest && p.mergeRequests.find(m => m.iid === current.pullRequest!.number);
				});
				const head = fixture.branchHead(p, mr.source_branch)!;
				assert.match(head, /^[0-9a-f]{40}$/);
				assert.notEqual(head, fixture.branchHead(p, p.defaultBranch));
				assert.equal(mr.target_branch, p.defaultBranch);
				// The project runs CI only for merge request events, with merged results: the pipeline's commit is not the head.
				const pipeline = fixture.addMergeRequestPipeline(p, mr, "success", true);
				assert.notEqual(pipeline.sha, head);
				fixture.addJob(p, pipeline, "guide/test", "success");
				await dispatch("Pipeline Hook", {
					object_kind: "pipeline",
					project: { id: p.id },
					object_attributes: pipeline,
					merge_request: { iid: mr.iid },
				});
				let progress = "";
				const review = await until("green CI on the work item", async () => {
					const item = await user.item(row.id);
					const next = [item.state, item.run?.step.kind, item.question?.kind, item.verdict?.ci].join("/");
					if (next !== progress) {
						progress = next;
						console.log("GitLab item: " + next);
					}
					return item.state === "review" && item.verdict?.ci === "passed" && item;
				});
				assert.equal(review.pullRequest?.number, mr.iid);
				assert.equal(mr.state, "opened", "intake must not auto-merge untrusted text");
				await assert.rejects(user.mergeGitlabItem(row.id, "f".repeat(40)));
				await user.mergeGitlabItem(row.id, head);
				assert.equal(mr.state, "merged");
				await dispatch("Merge Request Hook", {
					object_kind: "merge_request",
					project: { id: p.id },
					object_attributes: { iid: mr.iid, action: "merge", last_commit: { id: head } },
				});
				await until("merged item", async () => (await user.item(row.id)).state === "done");
				console.log("PASS intake: pushed branch, merge request, green CI and owner-authorized merge");
				await sandboxCredentials(fixture, p, storage);
				await refusedToken(fixture, p, user, issue);
				await dispatch(event, label);
				const relabelled = await until("a new item for the issue after its item was done", async () =>
					(await user.listItems()).find(i => i.title === target.title && i.id !== row.id),
				);
				assert.equal(relabelled.state, "draft");
			}
			if (via === "note") {
				await user.actOnItem({ id: row.id, action: { kind: "cancel" } });
				await pollUntil(30_000)("cancelled item", async () => (await user.item(row.id)).state === "cancelled");
				await dispatch(event, body);
				const again = await pollUntil(20_000)("a new item after the issue's item was cancelled", async () =>
					(await user.listItems()).find(i => i.title === target.title && i.id !== row.id),
				);
				await dispatch(event, body);
				assert.deepEqual(
					(await user.listItems())
						.filter(i => i.title === target.title)
						.map(i => i.id)
						.sort(),
					[row.id, again.id].sort(),
				);
				console.log("PASS intake: an issue whose item ended is filed again, once");
			}
			const turn = { agent: "windlass" as const, untrusted: kept.untrusted, unsandboxed: false };
			assert.equal(untrustedTurn({ ...turn, profile: "docker-windlass-sandbox" }).kind, "marked");
			assert.equal(untrustedTurn({ ...turn, profile: "docker-hardened" }).kind, "stop");
		}
		console.log("PASS intake/untrusted: canonical label and note tasks file once with GitLab sources");
	}
	if (sections.includes("refuse")) {
		const prior = await user.listItems();
		await owner.gitlabDisconnect();
		const stale = fixture.issueEvent(issue("Delivery after disconnect"));
		assert.equal((await fixture.deliver(hook.url, "Issue Hook", stale, { secret: hook.token })).status, 401);
		assert.deepEqual((await user.listItems()).map(i => i.id).sort(), prior.map(i => i.id).sort());
		assert.equal(await directory().internalWho(String(fixture.user.id)), null, "disconnecting GitLab unlinks its user");
	}
}

async function checkGitlab(sections: string[]) {
	const {
		engine,
		http: [port],
	} = await localListeners();
	const api = `http://127.0.0.1:${port}`,
		origin = "http://localhost:5173";
	const fixture = await GitlabStandin.start({ callbackUrl: api + "/gitlab/callback", pageSize: 1 });
	const storage = await mkdtemp(join(tmpdir(), "gitlab-connect-"));
	const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(WLP_|RIVET|PORT$)/.test(key)));
	const secret = (process.env.WLP_SECRET = randomBytes(32).toString("hex"));
	delete process.env.WLP_SECRET_KEYS;
	const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--node"], {
		cwd: fileURLToPath(new URL("../server/", import.meta.url)),
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...clean,
			WLP_SECRET: secret,
			WLP_FAKE_DELAY_MS: "10",
			WLP_ITEMS: "1",
			WLP_DEMO: "1",
			WLP_SANDBOX: "fake",
			WLP_WEB_ORIGINS: origin,
			WLP_HTTP_PORT: String(port),
			WLP_PUBLIC_URL: api,
			RIVET_RUN_ENGINE_PORT: String(engine),
			RIVETKIT_STORAGE_PATH: storage,
			RIVET_LOG_LEVEL: "silent",
			WLP_GITLAB_CLIENT_ID: fixture.clientId,
			WLP_GITLAB_CLIENT_SECRET: fixture.clientSecret,
			WLP_GITLAB_BASE_URL: fixture.url,
			WLP_GITLAB_REDIRECT_URL: fixture.redirectUrl,
		},
	});
	let logs = "";
	child.stdout.on("data", chunk => {
		logs += chunk;
	});
	child.stderr.on("data", chunk => {
		logs += chunk;
	});
	const exited = new Promise(resolve => child.once("close", resolve));
	try {
		await pollUntil(90_000)("the platform HTTP port", async () => {
			assert.ok(child.exitCode === null && child.signalCode === null, "platform exited during startup");
			return (await fetch(api + "/health").catch(() => null))?.ok;
		});
		const client = createClient<Registry>({ endpoint: `http://127.0.0.1:${engine}`, headers: { Origin: origin } });
		const ownerAuth = await loginHttp(api, origin).demo();
		// As the web app does: browsers may not create actors, so the user's actor creates the GitLab one.
		const login = async (auth = ownerAuth) => {
			const params = { params: { token: auth.token } };
			assert.equal(await client.user.get([auth.profile.uid], params).openGitlab(), true);
			return client.userGitlab.get([auth.profile.uid], params);
		};
		// A user whose actor was made before (by this sign-in, as by any earlier one) has no GitLab actor until asked.
		await assert.rejects(
			client.userGitlab.get([ownerAuth.profile.uid], { params: { token: ownerAuth.token } }).gitlab(),
			(error: { group?: string; code?: string }) => error.group === "actor" && error.code === "not_found",
		);
		const owner = await login(),
			neighbour = await login(await loginHttp(api, origin).demo());
		const disconnected = { state: "disconnected" };
		assert.deepEqual(await owner.gitlab(), disconnected);
		assert.equal(
			await client.user.get([ownerAuth.profile.uid], { params: { token: ownerAuth.token } }).openGitlab(),
			true,
		);
		assert.deepEqual(await owner.gitlab(), disconnected);
		if (sections.includes("connect"))
			console.log(
				"PASS connect: the user's actor creates the GitLab actor for an existing user, and asking again is harmless",
			);
		await assert.rejects(owner.gitlabConnect({ origin: "https://other.invalid" }));
		const begin = async () => fixture.authorize((await owner.gitlabConnect({ origin })).url);
		const callback = (url: URL | string) => fetch(url, { redirect: "manual" });
		const consent = await begin();
		if (sections.some(s => s !== "connect")) {
			const response = await callback(consent);
			await owner.gitlabComplete(new URL(response.headers.get("location")!).hash.slice("#gitlab=".length));
			await intakeChecks(sections, fixture, client, ownerAuth, owner, storage);
			return;
		}
		const invalid = new URL(consent);
		invalid.searchParams.set("state", "invalid");
		const refused = async (url: URL | string) => {
			const response = await callback(url);
			assert.ok(
				response.status === 302 &&
					(response.headers.get("location") ?? "").startsWith(origin + "/settings#gitlab-error="),
				"expected callback refusal",
			);
		};
		await refused(invalid);
		const back = await callback(consent);
		assert.equal(back.status, 302);
		assert.equal(back.headers.get("cache-control"), "no-store");
		const landing = new URL(back.headers.get("location")!);
		assert.ok(
			landing.origin === origin &&
				landing.pathname === "/settings" &&
				!landing.search &&
				/^#gitlab=.+$/.test(landing.hash),
			"expected a settings ticket",
		);
		const ticket = landing.hash.slice("#gitlab=".length);
		await refused(consent);
		await assert.rejects(neighbour.gitlabComplete(ticket));
		assert.deepEqual(await owner.gitlab(), disconnected);
		assert.deepEqual(await neighbour.gitlab(), disconnected);
		const status = await owner.gitlabComplete(ticket);
		assert.ok(status.state === "connected" && status.baseUrl === fixture.url && status.project === null);
		await assert.rejects(owner.gitlabComplete(ticket));
		console.log("PASS connect: PKCE callback issues a single-use ticket for the initiating owner");

		fixture.addProject({ owner: "group", name: "other" });
		const project = fixture.addProject({
			id: 9007199254740993n,
			owner: "group/subgroup",
			name: "service",
			defaultBranch: "trunk",
		});
		const hidden = fixture.addProject({ owner: "group", name: "hidden", accessible: false });
		const list = await owner.gitlabProjects("");
		const picked = list.projects.find(p => p.id === String(project.id));
		assert.ok(
			picked &&
				picked.provider === "gitlab" &&
				picked.owner === project.owner &&
				picked.name === project.name &&
				picked.branch === project.defaultBranch &&
				picked.private,
		);
		assert.equal(picked.url, `${fixture.url}/${project.owner}/${project.name}`);
		assert.equal(list.projects.length, 2);
		assert.equal(list.more, false);
		assert.deepEqual((await owner.gitlabProjects("service")).projects, [picked]);
		const saved = await owner.gitlabPickProject(String(project.id));
		assert.deepEqual(saved, { ...status, project: picked });
		await assert.rejects(owner.gitlabPickProject(String(hidden.id)));
		assert.deepEqual(await owner.gitlab(), saved);
		await assert.rejects(neighbour.gitlabProjects(""));
		console.log("PASS connect: discovers paged projects and saves the owner's accessible selection by exact ID");

		const secrets = [fixture.clientSecret, ...[...fixture.sessions.values()].flatMap(s => [s.access, s.refresh])];
		assert.equal(fixture.sessions.size, 1);
		const [session] = fixture.sessions.values();
		const probe = owner as unknown as { checkGrant(expire?: boolean): Promise<string[]> };
		assert.deepEqual(await probe.checkGrant(true), [digest(session.access), digest(session.refresh)]);
		console.log("PASS connect: actor storage holds the OAuth grant sealed for this owner and provider");
		const beforeRefresh = fixture.requests.length;
		const pages = await Promise.all([owner.gitlabProjects(""), owner.gitlabProjects("")]);
		assert.deepEqual(pages, [list, list]);
		assert.deepEqual(
			fixture.requests.slice(beforeRefresh).filter(r => r.method === "POST"),
			[{ method: "POST", status: 200 }],
			"concurrent reads should perform one refresh",
		);
		assert.equal(fixture.sessions.size, 1);
		const [renewed] = fixture.sessions.values();
		assert.ok(
			renewed.access !== session.access && renewed.refresh !== session.refresh,
			"both grant tokens must rotate",
		);
		assert.deepEqual(await probe.checkGrant(), [digest(renewed.access), digest(renewed.refresh)]);
		secrets.push(renewed.access, renewed.refresh);
		console.log("PASS connect: concurrent project lists refresh once and persist the rotated grant sealed");
		assert.equal(fixture.hooks.length, 1, "project pick must register one hook at GitLab");
		const [hook] = fixture.hooks;
		assert.equal(String(hook.projectId), String(project.id));
		assert.ok(
			new URL(hook.url).origin + new URL(hook.url).pathname === api + "/gitlab/webhook" &&
				!hook.url.includes(hook.token),
			"hook must point at the public callback without embedded credentials",
		);
		assert.ok(hook.token.length >= 32 && !secrets.includes(hook.token), "expected a separate project hook secret");
		secrets.push(hook.token);
		assert.deepEqual(await owner.gitlabPickProject(String(project.id)), saved);
		assert.deepEqual(
			fixture.hooks.map(h => h.id),
			[hook.id],
			"repeated pick must keep the original hook without registering another",
		);
		console.log("PASS connect: picking the same project twice keeps its original hook");
		await probe.checkGrant(true);
		fixture.sessions.clear(); // The owner revoked Windlass's access in GitLab.
		await assert.rejects(owner.gitlabProjects(""), /Reconnect GitLab in Settings/);
		assert.deepEqual(await owner.gitlab(), { state: "disconnected", reconnect: true });
		await assert.rejects(owner.gitlabProjects(""), /Connect GitLab first/);
		console.log("PASS connect: a refused refresh forgets the grant and asks the owner to reconnect");
		const pending = await begin();
		assert.deepEqual(await owner.gitlabDisconnect(), disconnected);
		assert.equal(fixture.sessions.size, 0, "disconnect should revoke the provider grant");
		await refused(pending);
		assert.deepEqual(await owner.gitlab(), disconnected);
		await assert.rejects(owner.gitlabProjects(""));
		for (const secret of secrets)
			assert.ok(
				![logs, landing.href, JSON.stringify([status, list, saved])].some(text => text.includes(secret)),
				"credential in log, redirect or public response",
			);
		console.log("PASS connect: disconnect clears selection and cancels unfinished authorization");
	} finally {
		child.kill("SIGTERM");
		const guard = setTimeout(() => child.kill("SIGKILL"), 15_000);
		await exited;
		clearTimeout(guard);
		try {
			const { pid } = JSON.parse(await readFile(join(storage, ".rivetkit/var/engine/runtime.json"), "utf8"));
			if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
		} catch {
			/* Engine exited with its server. */
		}
		await fixture.stop();
		await rm(storage, { recursive: true, force: true });
	}
}

if (process.argv[2] === "--node") await startCheckNode();
else {
	const names = ["connect", "intake", "refuse", "untrusted"];
	const sections = process.argv.length > 2 ? process.argv.slice(2) : names.filter(matchesSection);
	assert.ok(
		sections.length && sections.every(s => names.includes(s)),
		"usage: gitlab-check.ts [connect|intake|refuse|untrusted ...]",
	);
	try {
		if (sections.includes("connect")) await checkGitlab(["connect"]);
		if (sections.some(s => s !== "connect")) await checkGitlab(sections.filter(s => s !== "connect"));
		process.exit(0);
	} catch (error) {
		console.error(error);
		process.exit(1);
	}
}
