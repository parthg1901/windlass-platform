import type { GithubId, SessionRepository } from "../contract.js";
import { githubConfig } from "../config.js";
import type { FeatureRepoState } from "../factory/types.js";
import { githubApp, type GithubApp } from "../github/app.js";
import { authorOf } from "../github/publish.js";
import { GithubProblem, resolveBoundRepository, resolveRepository, type StoredConnection } from "../github/repos.js";
import { GitlabError, type GitlabApp } from "../gitlab/app.js";
import { gitlabApp } from "../gitlab/connect.js";
import { gitlabAccess, userActor } from "../actors/internal.js";
import { hostCaps, type HostCaps } from "./capabilities.js";
import type { CiTarget } from "./ci.js";
import { resolveCodeHost } from "./index.js";
import { repoRef, type RepoRef } from "./ref.js";
import type { CodeHost, GitAccess, GitCredential, Pull } from "./types.js";

/** The GitHub App and installation behind a bound host, for the flows that still call the App directly. */
export interface GithubBinding {
	app: GithubApp;
	installationId: GithubId;
	repositoryId: GithubId;
	repository: Awaited<ReturnType<typeof resolveBoundRepository>>["repository"];
	author: ReturnType<typeof authorOf>;
	login: string;
	connectedUserId: StoredConnection["user"]["id"];
}

/** The owner's GitLab grant and selected project behind a bound host, for the flows only GitLab has yet. */
export interface GitlabBinding {
	app: GitlabApp;
	project: SessionRepository;
	viewer: string;
	token: string;
	pipeline(head: string, pull?: number): ReturnType<CodeHost<unknown, unknown, unknown>["readCi"]>;
	baseTip(branch: string): ReturnType<GitlabApp["branchHead"]>;
}

/**
 * A repository as the owner's connection reaches it now, in one shape for every code host. Resolve it for each
 * effect and never persist it: it may hold a grant.
 */
export interface BoundHost {
	host: CodeHost<unknown, unknown, unknown>;
	/** What the host offers beyond `CodeHost`. Callers branch on these, not on the provider. */
	caps: HostCaps;
	repo: RepoRef;
	owner: string;
	name: string;
	target(head: string): CiTarget;
	pull(number: number): Promise<Pull>;
	/**
	 * Runs `step` with a token for API calls from this process. GitHub scopes an installation token to metadata and
	 * `permissions`; GitLab's is the owner's grant. Never hand it to a sandbox: Git there takes `gitCredential`.
	 */
	withToken<T>(permissions: Record<string, "read" | "write">, step: (token: string) => Promise<T>): Promise<T>;
	/** A credential for one sandbox Git operation on this repository (`withGitCredential` revokes it afterwards). */
	gitCredential(access: GitAccess): Promise<GitCredential>;
	/** Whether a comment is the platform's own. */
	isOwn(comment: { author: string; person: { id: number | string } | null }): boolean;
	/** Marks a feedback comment, review or issue as seen. */
	acknowledge(key: string): Promise<void>;
	/** The project's web address, for links a GitHub address would get wrong. */
	webUrl?: string;
	/** Changes reach the item through webhooks, so its polls can be sparse. */
	webhooks: boolean;
	/** Set where the host is GitHub. Flows reach for it only until they move behind `CodeHost`. */
	github?: GithubBinding;
	/** Set where the host is GitLab, likewise. */
	gitlab?: GitlabBinding;
}

/** Whose comment it is, by whom the platform acts as there: the App's bot by its login, the connected person by their account id. */
function ownTest(caps: HostCaps, identity: { bot?: string; account?: string }): BoundHost["isOwn"] {
	return caps.actsAs === "app-bot"
		? comment => comment.author.toLowerCase() === `${identity.bot?.toLowerCase()}[bot]`
		: comment => comment.person !== null && String(comment.person.id) === identity.account;
}

export interface HostOptions {
	access?: "read" | "write";
	/** A cross-repo feature's repository, through the installation bound to it at filing (never another one it may have moved to). */
	repo?: FeatureRepoState;
	/** The installation an item was filed through, when it has one. */
	installation?: () => Promise<GithubId | null>;
}

type HasClient = Parameters<typeof userActor>[0];

/**
 * The one resolver for a repository's code host: the owner's connection to it now, in the shape every host shares.
 * `repository` is what was stored; a repository on another instance than the deployment's own is refused, since no
 * connection reaches one yet.
 */
export async function hostFor(
	c: HasClient,
	meta: { uid: string; repository: SessionRepository },
	options: HostOptions = {},
): Promise<BoundHost> {
	const repo = repoRef(meta.repository);
	if (repo.instance !== null) throw new Error("This deployment reaches one instance of each code host.");
	const caps = hostCaps(repo.host);
	return repo.host === "gitlab"
		? gitlabHost(c, meta.uid, meta.repository, repo, caps)
		: githubHost(c, meta, repo, caps, options);
}

async function githubHost(
	c: HasClient,
	meta: { uid: string; repository: SessionRepository },
	ref: RepoRef,
	caps: HostCaps,
	{ access = "read", repo, installation }: HostOptions,
): Promise<BoundHost> {
	// CodeHost for portable operations, the App for exact token scopes and reuse.
	const app = githubApp();
	const host = resolveCodeHost("github");
	if (!app || !host) throw new Error("the deployment has no GitHub App");
	const connection: StoredConnection | null = await userActor(c, meta.uid).internalGithubConnection();
	if (!connection) throw new GithubProblem("github_gone", "The user’s GitHub connection is gone.");
	const repositoryId = repo?.repositoryId ?? meta.repository.id;
	const installationId =
		repo?.installationId ??
		(await installation?.()) ??
		(await resolveRepository(app, connection, repositoryId, "read")).installation.id;
	const resolved = await resolveBoundRepository(app, connection, repositoryId, installationId, access);
	const { owner, name } = resolved.repository;
	const bound = resolved.installation.id;
	return {
		host,
		caps,
		repo: repo ? { ...ref, id: String(repositoryId), path: `${owner}/${name}` } : ref,
		owner,
		name,
		target: head => ({ installationId: bound, repositoryId: resolved.repository.id, owner, name, head }),
		pull: number =>
			app.withToken(
				bound,
				{ repositoryId, permissions: { metadata: "read", pull_requests: "read" } },
				token => host.readPull(token, owner, name, number),
				{ reuse: true },
			),
		withToken: (permissions, step) =>
			app.withToken(bound, { repositoryId, permissions: { metadata: "read", ...permissions } }, step),
		gitCredential: access => host.gitCredential({ installationId: bound, repositoryId }, access),
		isOwn: ownTest(caps, { bot: app.settings.slug }),
		acknowledge: key => app.acknowledgeFeedback(bound, { id: repositoryId, owner, name }, key),
		webhooks: githubConfig().pollFallback,
		github: {
			app,
			installationId: bound,
			repositoryId,
			repository: resolved.repository,
			author: authorOf(connection),
			login: connection.user.login,
			connectedUserId: connection.user.id,
		},
	};
}

async function gitlabHost(
	c: HasClient,
	uid: string,
	repository: SessionRepository,
	ref: RepoRef,
	caps: HostCaps,
): Promise<BoundHost> {
	const app = gitlabApp();
	if (!app) throw new Error("GitLab is unavailable.");
	const { project, viewer, token } = await gitlabAccess(c, uid, ref.id);
	if (
		project.provider !== "gitlab" ||
		String(project.id) !== ref.id ||
		repository.url !== app.cloneUrl(repository.owner, repository.name).slice(0, -4)
	)
		throw new Error("The GitLab project changed.");
	const { owner, name } = project;
	const host = resolveCodeHost("gitlab", { id: viewer, accessToken: async () => token, project });
	if (!host) throw new Error("GitLab is unavailable.");
	const target = (head: string) => ({ installationId: viewer, repositoryId: project.id, owner, name, head });
	const gitlab: GitlabBinding = {
		app,
		project,
		viewer,
		token,
		pipeline: (head, pull) => host.readCi(target(head), { pull }),
		baseTip: branch => app.branchHead(token, project.id, branch),
	};
	return {
		host,
		caps,
		repo: ref,
		owner,
		name,
		target,
		pull: number => host.readPull(token, owner, name, number),
		webUrl: project.url,
		// The grant is the owner's, not a scoped installation token: it stays in this process.
		withToken: (_permissions, step) => step(token),
		gitCredential: access => host.gitCredential({ installationId: viewer, repositoryId: project.id }, access),
		isOwn: ownTest(caps, { account: viewer }),
		acknowledge: key => gitlabEyes(host, gitlab, key),
		webhooks: true,
		gitlab,
	};
}

async function gitlabEyes(host: BoundHost["host"], gitlab: GitlabBinding, key: string) {
	const at = key.indexOf(":"),
		kind = key.slice(0, at),
		id = key.slice(at + 1);
	if (kind !== "issue" && kind !== "issue_comment" && kind !== "review_comment")
		throw new Error("Invalid GitLab reaction target.");
	try {
		await host.react(gitlab.token, gitlab.project, { kind, id }, "eyes");
	} catch (e) {
		if (!(e instanceof GitlabError && [403, 404, 409].includes(e.status))) throw e;
	}
}
