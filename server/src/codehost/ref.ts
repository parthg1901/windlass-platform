import type { GithubId, HostId, RepoAddress, SessionRepository } from "../contract.js";
import { githubId, isGithubId } from "../github/ids.js";

// Browser-safe: the web app keys its repository filters with these.

/** The key everything saved for a repository is filed under (`repoKey`). */
export type RepoKey = `${HostId}:${string}`;

/** One identity for a repository on any code host. Built from what is stored (`repoRef`); nothing stores it yet. */
export interface RepoRef {
	host: HostId;
	/**
	 * The host's base URL for a repository on another instance than the deployment's own for its host. Null for
	 * the deployment's own (`WLP_GITHUB_URL`, `WLP_GITLAB_BASE_URL`), which every repository is on today.
	 */
	instance: string | null;
	/** The host's id for it, as a decimal string, never a JS number. */
	id: string;
	/** "owner/name", or "group/sub/name". */
	path: string;
	branch: string;
}

/** A repository as rows store it. Rows written before GitLab have no provider: they are GitHub's. */
type Stored = { provider?: HostId; id: GithubId; instance?: string };

const hostOf = (repository: Pick<Stored, "provider">): HostId =>
	repository.provider === "gitlab" ? "gitlab" : "github";

export function repoRef(repository: SessionRepository): RepoRef {
	return {
		host: hostOf(repository),
		instance: repository.instance ?? null,
		id: String(repository.id),
		path: `${repository.owner}/${repository.name}`,
		branch: repository.branch,
	};
}

/** "https://GitLab.example.com/gitlab/" → "gitlab.example.com/gitlab". */
export function instanceKey(instance: string): string {
	const url = new URL(instance);
	return `${url.host}${url.pathname}`.replace(/\/+$/, "").toLowerCase();
}

/**
 * The key everything saved for a repository is filed under: `github:<id>` or `gitlab:<id>` on the deployment's
 * own instance (the form existing rows have), `<host>:<instance>:<id>` on another.
 */
export function repoKey(ref: Pick<RepoRef, "host" | "instance" | "id">): RepoKey {
	return ref.instance === null ? `${ref.host}:${ref.id}` : `${ref.host}:${instanceKey(ref.instance)}:${ref.id}`;
}

/** `repoKey` of a stored repository. */
export const keyOf = (repository: Stored): RepoKey =>
	repoKey({ host: hostOf(repository), instance: repository.instance ?? null, id: String(repository.id) });

const KEY = /^(github|gitlab):([1-9][0-9]{0,18})$/;

/**
 * A key in the form `repoKey` writes, read from a row, a caller or an address. GitHub's bare id, the form used
 * before there was another host, reads as `github:<id>`. Null for anything else, including a key with an
 * instance, which nothing writes yet.
 */
export function readRepoKey(raw: unknown): RepoKey | null {
	if (isGithubId(raw)) return `github:${raw}`;
	const key = typeof raw === "string" ? KEY.exec(raw) : null;
	return key && BigInt(key[2]!) <= 9223372036854775807n ? `${key[1] as HostId}:${key[2]!}` : null;
}

/** What a link, a filter or a count names a repository by (`RepoAddress`), so ids of two hosts never meet. */
export function repoAddress(repository: Stored): RepoAddress {
	return hostOf(repository) === "github" && !repository.instance ? repository.id : keyOf(repository);
}

/** An address as `repoAddress` writes it, from a link or a caller; `github:<id>` reads as the bare id. Null for anything else. */
export function readRepoAddress(raw: unknown): RepoAddress | null {
	const key = githubId(raw) ?? readRepoKey(raw);
	return typeof key === "string" && key.startsWith("github:") ? githubId(key.slice(7)) : key;
}
