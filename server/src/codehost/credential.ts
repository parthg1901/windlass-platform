import { GithubProblem } from "../github/problem.js";
import type { GitAccess, GitCredential } from "./types.js";

/** Where a Git credential comes from: a bound host, or a host's adapter with its target applied. */
export interface GitCredentialSource {
	gitCredential(access: GitAccess): Promise<GitCredential>;
}

/**
 * The host would not make a credential limited to the repository and the operation. The message says what is
 * needed; the operation stops rather than reaching for a broader grant. It is a denied `GithubProblem`, so every
 * path that shows a code host's refusal shows this one, and the owner has to act before trying again.
 */
export class GitCredentialRefused extends GithubProblem {
	constructor(message: string) {
		super("github_denied", message);
		this.name = "GitCredentialRefused";
	}
}

/** Runs `step` with a credential for one Git operation and revokes it when the step has ended, however it ended. */
export async function withGitCredential<T>(
	source: GitCredentialSource,
	access: GitAccess,
	step: (credential: GitCredential) => Promise<T>,
): Promise<T> {
	const credential = await source.gitCredential(access);
	try {
		return await step(credential);
	} finally {
		await credential.revoke();
	}
}
