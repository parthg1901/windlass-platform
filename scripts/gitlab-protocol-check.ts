/** Exercise the GitLab code-host boundary over loopback HTTP, with no live GitLab credentials.
 * Run: cd server && npx tsx ../scripts/gitlab-protocol-check.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciState } from "../server/src/codehost/ci.js";
import { kinds } from "../server/src/factory/readiness-track.js";
import { gitlabConfig } from "../server/src/config.js";
import { GITLAB_WEBHOOK_PATH, MAX_WEBHOOK_BYTES, type GitlabDelivery } from "../server/src/gitlab/webhook.js";

import { GitlabStandin } from "./gitlab-standin.js";
import { GitlabApp, GitlabError, challengeOf, newVerifier } from "../server/src/gitlab/app.js";
import { gitlabCi, gitlabOf, prepareGitlabMerge } from "../server/src/actors/gitlab-item.js";
import { hostFor } from "../server/src/codehost/item.js";
import { freeBranchAt } from "../server/src/codehost/branch.js";
import { gitlabCodeHost } from "../server/src/gitlab/host.js";

type GitlabAccess = import("../server/src/gitlab/workspace.js").GitlabAccess;
type SandboxCommand = import("./gitlab-workspace-fixture.js").SandboxCommand;
/** Every command, environment and standard input the fake sandbox layer saw: the Git credential arrives on stdin. */
const sandboxCommands: SandboxCommand[] = [];
const workspaceHome = await mkdtemp(join(tmpdir(), "gitlab-protocol-"));
{
	const { installGitlabWorkspaceFixture } = await import("./gitlab-workspace-fixture.js");
	installGitlabWorkspaceFixture(workspaceHome, entry => sandboxCommands.push(entry));
}

async function newSandbox() {
	const { createFakeSandboxLayer } = await import("../server/src/sandbox-fake.js");
	const { sandboxes } = createFakeSandboxLayer({ signIns: "memory" });
	const id = await sandboxes.create({ uid: "tester", sessionId: "workspace", profile: "docker-hardened" });
	const sandbox = await sandboxes.connect(id);
	assert.ok(sandbox);
	return sandbox;
}

/** Exercise the same clone, fetch, scanned push and actor-held receipt as a live session. */
async function pushBranch(access: GitlabAccess, branch: string) {
	const { cloneGitlab, fetchGitlab, pushGitlab } = await import("../server/src/gitlab/workspace.js");
	const sandbox = await newSandbox();
	const repo = { ...access.gitlab.project, installationId: access.gitlab.project.id, baseSha: null as string | null };
	assert.deepEqual(await cloneGitlab(access, repo, sandbox, new AbortController().signal), {
		workGone: false,
		workAt: null,
		directory: ".",
	});
	assert.match(repo.baseSha!, /^[0-9a-f]{40}$/);
	const input = { repository: repo, branch, pushed: null, sandbox, sessionId: "workspace" };
	await assert.rejects(
		pushGitlab(
			access,
			{ ...input, redact: text => text.replaceAll("Built by the fixture model", "[redacted]") },
			"Not safe",
		),
		/Nothing was pushed/,
	);
	const result = await pushGitlab(access, input, "Protocol check");
	assert.ok(result.pushed && result.head && !result.workspaceChanged);
	assert.equal(await fetchGitlab(access, repo, sandbox, branch), true);
	return result.head;
}

async function hookReceiver(route: (request: Request) => Promise<Response | null>) {
	const server = createServer(async (req, res) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk as Buffer);
			const headers = new Headers();
			for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
			const response = await route(
				new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: Buffer.concat(chunks) }),
			);
			res.writeHead(response?.status ?? 404).end(await response?.text());
		} catch {
			res.writeHead(500).end();
		}
	});
	await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${GITLAB_WEBHOOK_PATH}`,
		close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
	};
}

const fixture = await GitlabStandin.start({ pageSize: 1 });
try {
	const app = new GitlabApp(
		{
			clientId: fixture.clientId,
			baseUrl: fixture.url,
			redirectUrl: fixture.redirectUrl,
			webhookUrl: fixture.url + GITLAB_WEBHOOK_PATH,
		},
		{ clientSecret: () => fixture.clientSecret },
	);
	const prefixed = gitlabConfig({
		WLP_GITLAB_BASE_URL: fixture.url,
		WLP_GITLAB_CLIENT_ID: "client",
		WLP_GITLAB_CLIENT_SECRET: "secret",
		WLP_PUBLIC_URL: "https://windlass.example/wlp/",
	}).app;
	assert.deepEqual(
		[prefixed?.redirectUrl, prefixed?.webhookUrl],
		["https://windlass.example/wlp/gitlab/callback", "https://windlass.example/wlp" + GITLAB_WEBHOOK_PATH],
	);
	const verifier = newVerifier(),
		state = randomUUID();
	async function authorize() {
		const redirect = await fetch(app.authorizeUrl(state, challengeOf(verifier)), { redirect: "manual" });
		assert.equal(redirect.status, 302);
		const callback = new URL(redirect.headers.get("location")!);
		assert.equal(callback.searchParams.get("state"), state);
		return callback.searchParams.get("code")!;
	}
	const denied = (e: unknown) => e instanceof GitlabError && [400, 401, 403].includes(e.status);
	await assert.rejects(app.exchangeCode(await authorize(), newVerifier()), denied);
	const code = await authorize(),
		grant = await app.exchangeCode(code, verifier);
	assert.ok(grant.refreshToken && grant.expiresAt && grant.expiresAt > Date.now() && grant.scopes.includes("api"));
	await assert.rejects(app.exchangeCode(code, verifier), denied);
	const fresh = await app.refresh(grant.refreshToken);
	assert.ok(fresh.accessToken !== grant.accessToken && fresh.refreshToken && fresh.refreshToken !== grant.refreshToken);
	await assert.rejects(app.refresh(grant.refreshToken), denied);
	await assert.rejects(app.call({ path: "/user", token: grant.accessToken }), denied);
	const token = fresh.accessToken;
	assert.deepEqual(await app.viewer(token), {
		id: fixture.user.id,
		login: fixture.user.username,
		name: fixture.user.name,
	});
	console.log("ok  OAuth PKCE, one-use code and refresh-token rotation");

	const projectId = "9007199254740993";
	const owner = "windlass/subgroup",
		name = "harbor",
		branch = "docs/guide";
	const other = fixture.addProject({ owner: "other", name });
	other.archived = true;
	const hidden = fixture.addProject({ owner, name: "restricted", accessible: false });
	const project = fixture.addProject({ owner, name, defaultBranch: "trunk", id: BigInt(projectId) });
	const connection = { id: 71, accessToken: async () => token };
	const received: GitlabDelivery[] = [];
	const host = gitlabCodeHost(app, connection, {
		projectId,
		secret: fixture.webhookSecret,
		dispatch: async delivery => {
			received.push(delivery);
		},
	});
	const list = await host.listRepositories(connection, "");
	const repo = list.repositories.find(r => r.id === projectId);
	assert.ok(
		repo &&
			repo.owner === owner &&
			repo.name === name &&
			repo.private &&
			repo.canPush &&
			repo.defaultBranch === "trunk",
	);
	assert.ok(list.repositories.some(r => String(r.id) === String(other.id) && !r.canPush));
	assert.ok(!list.repositories.some(r => String(r.id) === String(hidden.id)));
	await assert.rejects(
		app.call({ path: `/projects/${hidden.id}`, token }),
		(e: unknown) => e instanceof GitlabError && e.status === 404,
	);
	const smart = (owner_: string, name_: string, password: string, service = "git-upload-pack") =>
		fetch(`${host.cloneUrl(owner_, name_)}/info/refs?service=${service}`, {
			headers: { authorization: "Basic " + Buffer.from("oauth2:" + password).toString("base64") },
		}).then(r => r.status);
	// Git over HTTPS takes no OAuth grant here: only a project token, so a sandbox can never need the owner's.
	assert.equal(await smart(owner, name, token), 401);
	const target = { owner, name, installationId: connection.id, repositoryId: projectId };
	const tokensBefore = fixture.projectTokens.length;
	await assert.rejects(host.gitCredential({ ...target, repositoryId: String(other.id) }, "write"));
	await assert.rejects(host.gitCredential({ ...target, installationId: "999" }, "read"));
	assert.equal(fixture.projectTokens.length, tokensBefore, "no token for another project or connection");
	Object.assign(process.env, {
		WLP_GITLAB_CLIENT_ID: app.settings.clientId,
		WLP_GITLAB_CLIENT_SECRET: fixture.clientSecret,
		WLP_GITLAB_BASE_URL: fixture.url,
	});
	const selectedProject = {
		provider: "gitlab" as const,
		id: projectId,
		owner,
		name,
		branch: project.defaultBranch,
		private: true,
		url: host.cloneUrl(owner, name).slice(0, -4),
	};
	const access: GitlabAccess = {
		gitCredential: git => host.gitCredential(target, git),
		gitlab: { project: selectedProject, viewer: String(fixture.user.id), token },
	};
	const commandsFrom = sandboxCommands.length,
		authFrom = fixture.gitAuth.length;
	const head = await pushBranch(access, branch);
	assert.equal(fixture.branchHead(project, branch), head);
	const author = execFileSync("git", ["log", "-1", "--format=%an <%ae>", head], {
		cwd: project.path,
		encoding: "utf8",
	}).trim();
	assert.equal(
		author,
		`${fixture.user.username} <${fixture.user.id}-${fixture.user.username}@users.noreply.127.0.0.1>`,
	);
	// One read token for the clone, one write token for the push, one read token for the fetch: each revoked after.
	const made = fixture.projectTokens.slice(tokensBefore);
	assert.deepEqual(
		made.map(t => [String(t.projectId), t.scopes.join(), t.accessLevel, t.name]),
		[
			[projectId, "read_repository", 20, "windlass-git-read"],
			[projectId, "write_repository", 30, "windlass-git-write"],
			[projectId, "read_repository", 20, "windlass-git-read"],
		],
	);
	assert.ok(
		made.every(t => t.revoked),
		"every project token is revoked when its operation has ended",
	);
	const soonest = Date.parse(made[0].expiresAt + "T00:00:00Z") - Date.now();
	assert.ok(soonest > 55 * 60 * 1000 && soonest <= 25 * 60 * 60 * 1000, `expiry backstop ${soonest}ms`);
	// Git first asks without a credential and is challenged; every request that carried one carried a project token.
	const auth = fixture.gitAuth.slice(authFrom).filter(a => a.kind !== "none");
	assert.ok(auth.length && auth.every(a => a.kind === "project" && a.status === 200), JSON.stringify(auth));
	const scopeOf = (a: (typeof auth)[number]) => made.find(t => t.id === a.tokenId)?.scopes.join();
	assert.ok(auth.some(a => a.service === "git-receive-pack"));
	assert.ok(auth.filter(a => a.service === "git-receive-pack").every(a => scopeOf(a) === "write_repository"));
	assert.ok(auth.filter(a => scopeOf(a) === "read_repository").every(a => a.service === "git-upload-pack"));
	assert.equal(auth[0].tokenId, made[0].id, "the clone used the read token");
	const commands = sandboxCommands.slice(commandsFrom);
	const grants = [...fixture.issued, fixture.token, fixture.clientSecret];
	assert.ok(fixture.issued.has(token) && commands.length > 0);
	for (const entry of commands) {
		const seen = JSON.stringify(entry);
		assert.ok(!grants.some(g => seen.includes(g)), "the owner's OAuth grant entered the sandbox");
		for (const t of made)
			assert.ok(
				!entry.command.includes(t.token) && !JSON.stringify(entry.env).includes(t.token),
				"a project token reaches a command only on its standard input",
			);
	}
	assert.ok(made.every(t => commands.some(c => c.stdin.includes(t.token))));
	console.log("ok  paged project discovery, large project ID, project access and authenticated smart HTTP clone/push");
	console.log(
		"ok  clone and fetch take a read-only project token, push a write one; each revoked, the OAuth grant never in the sandbox",
	);

	// A token for one project reaches no other: not over Git, not to revoke there, and not the API at all.
	const neighbour = fixture.addProject({ owner, name: "neighbour" });
	const scoped = await app.createGitToken(token, projectId, "write");
	assert.equal(await smart(owner, name, scoped.token, "git-receive-pack"), 200);
	assert.equal(await smart(owner, neighbour.name, scoped.token), 404);
	assert.equal(await smart(owner, neighbour.name, scoped.token, "git-receive-pack"), 404);
	assert.equal(await smart(owner, hidden.name, scoped.token), 404);
	await assert.rejects(app.call({ path: `/projects/${neighbour.id}`, token: scoped.token }), denied);
	await app.revokeProjectToken(token, String(neighbour.id), scoped.id); // Not that project's token: nothing to revoke there.
	assert.ok(!fixture.projectTokens.find(t => t.token === scoped.token)!.revoked);
	const read = await app.createGitToken(token, projectId, "read");
	assert.equal(await smart(owner, name, read.token, "git-receive-pack"), 403, "a read token cannot push");
	await app.revokeProjectToken(token, projectId, read.id);
	assert.equal(await smart(owner, name, read.token), 401, "a revoked token stops working at once");
	const lapsed = fixture.projectTokens.find(t => t.token === scoped.token)!;
	fixture.expire(lapsed);
	assert.equal(await smart(owner, name, scoped.token), 401, "an expired token stops working");
	console.log("ok  a project token reaches only its own project, only for its access, and not after revoke or expiry");

	// A token an operation never revoked (the server stopped between making and revoking it) is revoked by the next one.
	const left = await app.createGitToken(token, projectId, "read");
	const leftRow = fixture.projectTokens.find(t => t.token === left.token)!;
	const recent = await app.createGitToken(token, projectId, "read");
	leftRow.createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
	const sweeping = await host.gitCredential(target, "read");
	assert.ok(leftRow.revoked, "a stale token of ours is swept");
	assert.ok(!fixture.projectTokens.find(t => t.token === recent.token)!.revoked, "a recent one may still be in use");
	await sweeping.revoke();
	await sweeping.revoke(); // Once only, and never throws.
	assert.ok(fixture.projectTokens.find(t => t.token === sweeping.token)!.revoked);
	await app.revokeProjectToken(token, projectId, recent.id);
	const unrevokable = await host.gitCredential(target, "read");
	fixture.projectTokens.find(t => t.token === unrevokable.token)!.revoked = true;
	await unrevokable.revoke(); // GitLab refuses the DELETE: logged, not thrown; expiry is the backstop.
	console.log("ok  a token left by an unfinished operation is revoked by the next, and revoke never throws");

	// No scoped token, no Git: never the OAuth grant instead, and the reason says what is needed.
	const { cloneGitlab, pushGitlab } = await import("../server/src/gitlab/workspace.js");
	const refusedRepo = { ...selectedProject, installationId: projectId, baseSha: null as string | null };
	const refusedFrom = {
		commands: sandboxCommands.length,
		auth: fixture.gitAuth.length,
		tokens: fixture.projectTokens.length,
	};
	project.level = 30;
	const developer = await newSandbox();
	await assert.rejects(
		cloneGitlab(access, refusedRepo, developer, new AbortController().signal),
		(e: Error) =>
			e.name === "GitCredentialRefused" &&
			e.message.startsWith(
				`Windlass needs Maintainer access on ${owner}/${name} to create a short-lived project token for Git, so the clone or fetch did not run.`,
			),
	);
	project.level = 40;
	project.tokensAllowed = false;
	await assert.rejects(
		cloneGitlab(access, refusedRepo, developer, new AbortController().signal),
		/GitLab refused to create a short-lived project token on windlass\/subgroup\/harbor, so the clone or fetch did not run\. .*Premium or Ultimate/,
	);
	assert.equal(fixture.projectTokens.length, refusedFrom.tokens);
	assert.equal(fixture.gitAuth.length, refusedFrom.auth, "no Git request at all without a scoped token");
	assert.ok(sandboxCommands.slice(refusedFrom.commands).every(c => !c.command.includes("wlp_git clone")));
	// A push refused its token leaves nothing pushed and no handover behind.
	project.tokensAllowed = true;
	const pushing = await newSandbox();
	const pushRepo = { ...refusedRepo };
	await cloneGitlab(access, pushRepo, pushing, new AbortController().signal);
	const pushAuth = fixture.gitAuth.length;
	project.level = 30;
	await assert.rejects(
		pushGitlab(
			access,
			{ repository: pushRepo, branch: "refused/push", pushed: null, sandbox: pushing, sessionId: "workspace" },
			"Refused",
		),
		/Maintainer access on windlass\/subgroup\/harbor .*so the push did not run/,
	);
	project.level = 40;
	assert.equal(fixture.gitAuth.length, pushAuth);
	assert.equal(fixture.branchHead(project, "refused/push"), null);
	console.log("ok  a refused project token stops clone and push with what is needed, never using the OAuth grant");

	const input = { title: "Add guide", body: "A new guide", head: branch, base: project.defaultBranch };
	const mr = await host.openPull(token, owner, name, input);
	assert.equal(mr.state, "open");
	assert.equal(mr.headSha, head);
	assert.equal(mr.baseSha, fixture.branchHead(project, project.defaultBranch));
	assert.equal(mr.number, project.mergeRequests[0].iid);
	assert.equal((await host.readPull(token, owner, name, mr.number)).head, branch);
	const edited = await host.updatePull(token, owner, name, mr.number, { title: "Guide", body: "Updated guide" });
	assert.equal(edited.title, "Guide");
	assert.equal(edited.body, "Updated guide");
	const note = await host.createComment(token, owner, name, mr.number, "Original note");
	assert.ok(note);
	assert.equal(note, `${mr.number}:${project.mergeRequests[0].notes[0].id}`);
	await host.updateComment(token, owner, name, note, "Edited note");
	assert.ok(
		(await host.listComments(token, owner, name, mr.number, true)).some(n => n.id === note && n.body === "Edited note"),
	);
	await host.react(token, { owner, name }, { kind: "issue", id: "1" }, "eyes");
	await host.react(token, { owner, name }, { kind: "issue_comment", id: "1:42" }, "eyes");
	assert.ok([...fixture.reactions].some(path => path.endsWith("/issues/1/award_emoji:eyes")));
	assert.ok([...fixture.reactions].some(path => path.endsWith("/issues/1/notes/42/award_emoji:eyes")));
	console.log("ok  merge request create/read/update, scoped notes and issue reactions");

	const pipe = fixture.addPipeline(project, head, branch, "failed");
	const job = fixture.addJob(
		project,
		pipe,
		"guide/test",
		"failed",
		`${"progress line\n".repeat(20_000)}The guide check failed\n${token}\n`,
	);
	const ciTarget = { ...target, head };
	const restrictedUrl = new URL(app.authorizeUrl(state, challengeOf(verifier)));
	restrictedUrl.searchParams.set("scope", "read_user");
	const restrictedCode = new URL(fixture.authorize(restrictedUrl.href)).searchParams.get("code")!;
	const restricted = await app.exchangeCode(restrictedCode, verifier);
	const restrictedHost = gitlabCodeHost(app, { ...connection, accessToken: async () => restricted.accessToken });
	assert.equal((await restrictedHost.readCi(ciTarget)).kind, "not_permitted");
	await assert.rejects(
		host.createComment(restricted.accessToken, owner, name, mr.number, "Forbidden"),
		(e: unknown) => e instanceof GitlabError && e.status === 403,
	);
	const ci = await host.readCi(ciTarget);
	assert.equal(ci.kind, "read");
	assert.equal(ci.head, head);
	const failed = ci.runs.find(r => r.jobId === String(job.id));
	assert.ok(failed && failed.state === "failed" && failed.name === job.name);
	assert.ok((await (await host.jobLog(token, owner, name, String(job.id))).text()).includes("guide check failed"));
	const log = ci.logs.find(l => l.name === job.name);
	assert.ok(
		log?.text?.includes("guide check failed") && log.untrusted && !log.text.includes(token) && log.truncated,
		"the end of a long trace is kept",
	);
	const stale = await host.rerunJobs({ ...ciTarget, head: mr.baseSha }, [
		{ name: job.name, jobId: String(job.id), retryRunId: String(pipe.id), failed: true },
	]);
	assert.deepEqual(stale.accepted, []);
	const retry = await host.rerunJobs(ciTarget, [
		{ name: job.name, jobId: String(job.id), retryRunId: String(pipe.id), failed: true },
	]);
	assert.ok(retry.accepted.length && fixture.retries.includes(String(job.id)));
	const replacement = project.jobs.find(j => j.pipeline === pipe && !j.retried);
	assert.ok(replacement && replacement.id !== job.id);
	pipe.status = "running";
	assert.equal(ciState(await host.readCi(ciTarget)), "pending");
	pipe.status = replacement.status = "success";
	assert.equal(ciState(await host.readCi(ciTarget)), "passed");
	console.log("ok  CI results for the pushed SHA, job trace and retry to a green pipeline");

	// Projects whose jobs run only for merge request events: merged-results and detached MR pipelines.
	const request = project.mergeRequests.find(m => m.iid === mr.number)!;
	const merged = fixture.addMergeRequestPipeline(project, request, "failed", true);
	assert.notEqual(merged.sha, head);
	const mergedJob = fixture.addJob(project, merged, "guide/merged", "failed", "merged results failed\n");
	const withMr = await host.readCi(ciTarget, { pull: mr.number });
	assert.ok(
		withMr.kind === "read" &&
			withMr.head === head &&
			withMr.runs.some(r => r.jobId === String(mergedJob.id) && r.state === "failed"),
		"the head's merged-results pipeline is read",
	);
	assert.equal(ciState(await host.readCi(ciTarget)), "passed", "without the MR only the commit's own pipelines count");
	assert.deepEqual(
		(
			await host.rerunJobs(ciTarget, [
				{ name: mergedJob.name, jobId: String(mergedJob.id), retryRunId: String(merged.id), failed: true },
			])
		).accepted,
		[String(mergedJob.id)],
	);
	merged.status = project.jobs.find(j => j.pipeline === merged && !j.retried)!.status = "success";
	const detached = fixture.addMergeRequestPipeline(project, request, "running");
	const detachedJob = fixture.addJob(project, detached, "guide/mr", "running");
	assert.equal(
		ciState(await host.readCi(ciTarget, { pull: mr.number })),
		"pending",
		"the MR's own pipeline on the head is read",
	);
	detached.status = detachedJob.status = "success";
	assert.equal(ciState(await host.readCi(ciTarget, { pull: mr.number })), "passed");
	const moved = fixture.commit(project, branch, { "guide.md": "changed" }, "Move the head");
	const later = fixture.addMergeRequestPipeline(project, request, "failed", true);
	fixture.addJob(project, later, "guide/merged", "failed");
	assert.equal(ciState(await host.readCi({ ...ciTarget, head: moved }, { pull: mr.number })), "failed");
	assert.equal(
		ciState(await host.readCi(ciTarget, { pull: mr.number })),
		"passed",
		"a newer merged-results pipeline of another head is not this head's",
	);
	execFileSync("git", ["update-ref", `refs/heads/${branch}`, head], { cwd: project.path });
	console.log("ok  merge request and merged-results pipelines of the head, and their job retries");

	await assert.rejects(host.mergePull(token, owner, name, mr.number, "1".repeat(40), mr.title));
	// Exercise the work item's connection lookup, pinned CI/merge guards, and project-local note IDs.
	Object.assign(process.env, {
		WLP_SECRET: randomUUID(),
		WLP_GITLAB_BASE_URL: fixture.url,
		WLP_GITLAB_CLIENT_ID: fixture.clientId,
		WLP_GITLAB_CLIENT_SECRET: fixture.clientSecret,
		WLP_GITLAB_REDIRECT_URL: fixture.redirectUrl,
	});
	const selected = {
		...repo,
		provider: "gitlab" as const,
		url: app.cloneUrl(owner, name).slice(0, -4),
		branch: project.defaultBranch,
	};
	const ctx = {
		client: () => ({
			userGitlab: {
				get(keys: string[]) {
					assert.deepEqual(keys, ["owner"]);
					return {
						async internalGitlabAccess(id: string) {
							assert.equal(id, projectId);
							return { project: selected, viewer: String(fixture.user.id), token };
						},
					};
				},
			},
		}),
	};
	const hub = gitlabOf(await hostFor(ctx, { uid: "owner", repository: selected }));
	// A standalone session's first push (agent-session/publish.ts `branchOf`): its title in words, numbered once the project has it.
	const title = "Add the harbor guide";
	const named = await freeBranchAt(hub, title);
	assert.equal(named, "windlass/add-the-harbor-guide");
	const namedHead = await pushBranch(hub, named);
	assert.equal(fixture.branchHead(project, named), namedHead);
	assert.equal(await freeBranchAt(hub, title), "windlass/add-the-harbor-guide-2");
	await assert.rejects(hub.host.hasBranch("not-a-token", owner, name, named), GitlabError);
	console.log("ok  a session's branch is its title in words, with -2 once GitLab has that branch");
	await assert.rejects(hub.host.readPull(token, other.owner, other.name, mr.number));
	await hub.acknowledge("issue_comment:1:42");
	const observed = await gitlabCi(hub, head, mr.number, mr.base, true);
	assert.equal(observed.prHead, head);
	assert.equal(observed.baseAhead, 0);
	assert.equal(ciState(observed.reading), "passed");
	const prepare = (expected: string, kinds?: Parameters<typeof prepareGitlabMerge>[6]) =>
		prepareGitlabMerge(hub, mr.number, expected, mr.base, observed.baseTip, "i_protocol", kinds);
	const merge = async (expected: string) => (await prepare(expected))();
	await assert.rejects(merge("1".repeat(40)), /reviewed head and base/);
	await assert.rejects(merge(head), /feedback/); // The earlier unhandled human note.
	await host.updateComment(token, owner, name, note, "<!-- windlass-item:i_protocol -->\nVerdict");
	detached.status = "failed";
	await assert.rejects(merge(head), /CI no longer passes/);
	detached.status = "success";
	const changed = await app.changedPaths(token, projectId, observed.baseTip!, head);
	assert.ok(
		changed?.length && changed.every(path => !path.endsWith("package.json")),
		"the pushed change is not a dependency bump",
	);
	await assert.rejects(prepare(head, ["dependency bumps"]), /kind of change/);
	const ready = await prepare(head, [...kinds]);
	// The head moves between the reads and the merge: the recheck refuses, and nothing is merged.
	const late = fixture.commit(project, branch, { "late.md": "late" }, "Late push");
	await assert.rejects(ready(), /changed before merge/);
	assert.equal((await host.readPull(token, owner, name, mr.number)).state, "open");
	execFileSync("git", ["update-ref", `refs/heads/${branch}`, head, late], { cwd: project.path });
	await (await prepare(head, [...kinds]))();
	assert.equal((await host.readPull(token, owner, name, mr.number)).state, "merged");
	const nextBranch = "docs/follow-up";
	fixture.commit(project, nextBranch, { "follow-up": "x" }, "Follow up", project.defaultBranch);
	const next = await host.openFromPushed({
		connection,
		repository: { id: projectId, branch: project.defaultBranch, closesIssue: 5 },
		branch: nextBranch,
		message: input,
		evidence: { verified: null, during: null, checks: [], redact: s => s },
	});
	assert.match((await host.readPull(token, owner, name, next.number)).body, /Closes #5/);
	await host.closePull(token, owner, name, next.number);
	assert.equal((await host.readPull(token, owner, name, next.number)).state, "closed");
	console.log("ok  merge guarded by head SHA and close without merging");

	const receiver = await hookReceiver(req => host.webhookRoute(req));
	try {
		const hookId = await app.projectHook(token, projectId, receiver.url, fixture.webhookSecret);
		const hook = fixture.hooks.find(h => String(h.id) === hookId);
		assert.ok(
			hook && String(hook.projectId) === projectId && hook.url === receiver.url && hook.token === fixture.webhookSecret,
		);
		const base = { project: { id: project.id }, user: { id: 9007199254740995n } };
		const issue = { iid: 4, title: "Guide request", description: "Untrusted issue description" };
		const attr = { id: 9007199254740997n, noteable_type: "Issue", action: "create", note: "/windlass fix the guide" };
		const payload = { ...base, object_kind: "note", issue, object_attributes: attr };
		const guid = randomUUID();
		assert.equal((await fixture.deliver(receiver.url, "Note Hook", payload, { secret: "wrong" })).status, 401);
		assert.equal(
			(await fixture.deliver(receiver.url, "Note Hook", { ...payload, project: { id: other.id } })).status,
			403,
		);
		assert.equal((await fixture.deliverHook(hookId, "Note Hook", payload, { omitToken: true })).status, 401);
		assert.equal((await fetch(receiver.url, { method: "POST", body: "garbage" })).status, 401);
		assert.equal(
			(
				await fetch(receiver.url, {
					method: "POST",
					headers: { "x-gitlab-token": fixture.webhookSecret, "x-gitlab-event-uuid": guid },
					body: "garbage",
				})
			).status,
			400,
		);
		assert.equal((await fetch(receiver.url, { method: "POST", body: "x".repeat(MAX_WEBHOOK_BYTES + 1) })).status, 413);
		for (const change of [
			{ action: "update" },
			{ system: true },
			{ note: "unrelated discussion" },
			{ note: "/windlass feature build it" },
			{ noteable_type: "MergeRequest" },
		]) {
			assert.ok(
				(
					await fixture.deliver(receiver.url, "Note Hook", {
						...payload,
						merge_request: issue,
						object_attributes: { ...attr, ...change },
					})
				).ok,
			);
		}
		const labelled = [{ title: "windlass" }];
		const issueEdit = {
			...base,
			object_kind: "issue",
			object_attributes: { ...issue, action: "update" },
			labels: labelled,
		};
		for (const changes of [
			{},
			{ labels: { previous: labelled, current: [] } },
			{ labels: { previous: labelled, current: labelled } },
		]) {
			assert.ok((await fixture.deliver(receiver.url, "Issue Hook", { ...issueEdit, changes })).ok);
		}
		assert.equal(received.length, 0);
		assert.ok((await fixture.deliverHook(hookId, "Note Hook", payload, { guid })).ok);
		const note = received.at(-1);
		assert.deepEqual(note, {
			guid,
			projectId,
			event: "note",
			target: "issue",
			iid: issue.iid,
			senderId: "9007199254740995",
			noteId: "9007199254740997",
			body: attr.note,
			title: issue.title,
			description: issue.description,
		});
		assert.ok(
			(
				await fixture.deliver(receiver.url, "Issue Hook", {
					...issueEdit,
					changes: { labels: { previous: [], current: labelled } },
				})
			).ok,
		);
		const gained = received.at(-1);
		assert.ok(
			gained?.event === "issue" &&
				gained.action === "update" &&
				gained.description === issue.description &&
				gained.title === issue.title,
		);
		assert.deepEqual(gained.addedLabels, ["windlass"]);
		assert.ok(
			(
				await fixture.deliver(receiver.url, "Issue Hook", {
					...issueEdit,
					object_attributes: { ...issue, action: "open" },
				})
			).ok,
		);
		assert.ok(
			(
				await fixture.deliver(receiver.url, "Merge Request Hook", {
					...base,
					object_kind: "merge_request",
					object_attributes: { iid: mr.number, action: "merge", last_commit: { id: head } },
				})
			).ok,
		);
		assert.ok(
			(
				await fixture.deliver(receiver.url, "Pipeline Hook", {
					...base,
					object_kind: "pipeline",
					object_attributes: { id: pipe.id, status: "failed", sha: head },
				})
			).ok,
		);
		assert.ok(
			(
				await fixture.deliver(receiver.url, "Pipeline Hook", {
					...base,
					object_kind: "pipeline",
					object_attributes: { id: merged.id, status: "success", sha: merged.sha },
					merge_request: { iid: mr.number },
				})
			).ok,
		);
		assert.deepEqual(
			received.map(d => d.event),
			["note", "issue", "issue", "merge_request", "pipeline", "pipeline"],
		);
		assert.deepEqual(
			received.slice(-2).map(d => (d.event === "pipeline" ? d.iid : null)),
			[undefined, mr.number],
		);
	} finally {
		await receiver.close();
	}
	console.log("ok  real HTTP hook delivery authenticates, filters projects and retains exact database IDs");
	// Providers and reverse proxies can echo credentials in errors, or send non-JSON with a 200.
	// Neither the HTTP diagnostic, JSON.parse's snippet nor the request path may escape.
	const sensitive = [
		token,
		fresh.refreshToken,
		fixture.clientSecret,
		fixture.webhookSecret,
		code,
		verifier,
		"private-repository-content",
	];
	let status = 403;
	const echo = await hookReceiver(async () => new Response(sensitive.join("\n"), { status }));
	try {
		const hostile = new GitlabApp(
			{ ...app.settings, baseUrl: new URL(echo.url).origin },
			{ clientSecret: () => fixture.clientSecret },
		);
		async function sanitizedFailure(step: () => Promise<unknown>) {
			let thrown: unknown;
			try {
				await step();
			} catch (error) {
				thrown = error;
			}
			assert.ok(thrown instanceof Error, "expected a GitLab error");
			assert.ok(
				sensitive.every(s => !thrown.message.includes(s)),
				"a credential or private diagnostic escaped in an error",
			);
		}
		await sanitizedFailure(() => hostile.exchangeCode(code, verifier));
		await sanitizedFailure(() => hostile.refresh(fresh.refreshToken!));
		await sanitizedFailure(() => hostile.projectHook(token, projectId, echo.url, fixture.webhookSecret));
		status = 200;
		await sanitizedFailure(() => hostile.call({ method: "POST", path: `/projects/${token}/notes`, token }));
	} finally {
		await echo.close();
	}
	console.log("ok  upstream errors and malformed JSON never expose credentials or private diagnostics");
	await app.revoke(token);
	await assert.rejects(app.viewer(token), denied);
} finally {
	await fixture.stop();
	await rm(workspaceHome, { recursive: true, force: true });
}
