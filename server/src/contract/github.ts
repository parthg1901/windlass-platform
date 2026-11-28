/** GitHub, GitLab, Linear and Jira connections, repositories, pull requests and publishing. */

/** Account, installation and repository IDs are numbers through MAX_SAFE_INTEGER, then decimal strings. */
export type GithubId = number | string;

/** An account the GitHub App is installed on, which the connected GitHub user can reach. */
export interface GithubAccount {
	/** The installation's id at GitHub. */
	installationId: GithubId;
	/** The account's name: a user's or an organization's login. */
	login: string;
	kind: "user" | "organization";
	/** Where the installation's repositories are chosen, at GitHub. */
	manageUrl: string;
}

export interface GithubConnection {
	/** The GitHub user who connected. */
	login: string;
	accounts: GithubAccount[];
	connectedAt: number;
}

export interface GithubStatus {
	/** Null when GitHub is not connected. */
	connection: GithubConnection | null;
}

/** Public state of the owner’s GitLab connection. Credentials and hook secrets stay server-side. */
export type GitlabStatus =
	| { state: "off" }
	/** `reconnect`: GitLab refused the saved grant (revoked or expired), so it was forgotten. */
	| { state: "disconnected"; reconnect?: true }
	| { state: "connected"; baseUrl: string; project: SessionRepository | null };

export interface GitlabProjectList {
	projects: SessionRepository[];
	more: boolean;
}

/** Settings actions on userGitlab[uid]. */
export interface GitlabActions {
	gitlab(): Promise<GitlabStatus>;
	gitlabConnect(input: { origin: string }): Promise<{ url: string }>;
	gitlabComplete(ticket: string): Promise<GitlabStatus>;
	gitlabProjects(query: string): Promise<GitlabProjectList>;
	gitlabPickProject(projectId: string): Promise<GitlabStatus>;
	gitlabDisconnect(): Promise<GitlabStatus>;
}

/** Mapped teams file work on their repository through a qualifying label or app assignment. */
export type LinearStatus =
	/** The deployment has no Linear OAuth client or signing secret (server env): Settings shows nothing to connect. */
	{ state: "off" } | { state: "disconnected" } | { state: "connected"; connection: LinearConnection };

export interface LinearConnection {
	workspace: { id: string; name: string; urlKey: string };
	/** The Linear user who connected. An issue they created is theirs: it files as a started item, as one of the owner's own GitHub issues does. */
	user: { id: string; name: string };
	/** The Windlass app user an issue is assigned to. Null when Linear did not report one. */
	appUser: { id: string; name: string } | null;
	connectedAt: number;
}

/** A team of the connected workspace and the repository it files to; null: its issues are ignored. */
export interface LinearTeam {
	id: string;
	/** The prefix of its issues' identifiers ("ENG"). */
	key: string;
	name: string;
	mapping: LinearMapping | null;
}

/** One team files to one repository of the owner's GitHub connection. */
export interface LinearMapping {
	teamId: string;
	repository: { id: GithubId; owner: string; name: string };
	savedAt: number;
}

export interface LinearTeamList {
	teams: LinearTeam[];
}

/** Browser-visible Jira connection metadata. Tokens and hook credentials stay with the service. */
export interface JiraSite {
	id: string;
	name: string;
	url: string;
}

export interface JiraConnection {
	user: { id: string; name: string };
	sites: JiraSite[];
	/** Null until the owner chooses an authorized site. */
	site: JiraSite | null;
	connectedAt: number;
}

export type JiraStatus =
	| { state: "off" }
	| { state: "disconnected" }
	| { state: "connected"; connection: JiraConnection };

export interface JiraMapping {
	siteId: string;
	projectId: string;
	repository: { id: GithubId; owner: string; name: string };
	savedAt: number;
}

export interface JiraProject {
	id: string;
	key: string;
	name: string;
	mapping: JiraMapping | null;
}
export interface JiraProjectList {
	projects: JiraProject[];
}

/** A repository the connection covers and the connected GitHub user can open. */
export interface GithubRepository {
	/** GitHub's id for it: what `CreateSessionInput.repository` names. */
	id: GithubId;
	owner: string;
	name: string;
	private: boolean;
	defaultBranch: string;
	/** False when the connected user may read it and not push: an agent can work on it, but no pull request can be opened. */
	canPush: boolean;
	/** When it was last pushed to, ms since the epoch; null when GitHub did not say. */
	pushedAt: number | null;
}

export interface GithubRepositoryList {
	repositories: GithubRepository[];
	/** True when more match than are listed: a longer search finds them. */
	more: boolean;
	/** True when GitHub was too slow for every account to be listed and every repository checked in the time a list has: some may be missing. */
	incomplete: boolean;
}

/** An open issue a first work item could start from: the repository's oldest open issues labelled "bug". */
export interface StarterIssue {
	number: number;
	title: string;
	url: string;
}

export interface GithubBranchList {
	/** Branch names, the default branch first. */
	branches: string[];
	defaultBranch: string;
	/** True when the repository has more branches than are listed. */
	more: boolean;
}

/** The code hosts a repository can be on. Their issues are work sources too (sources/types.ts). */
export const HOST_IDS = ["github", "gitlab"] as const;
export type HostId = (typeof HOST_IDS)[number];

/**
 * What a link, a filter or a count names a repository by (`repoAddress` in codehost/ref.ts): GitHub's id for one on
 * the deployment's own GitHub, as links always have, and its key (`gitlab:<id>`) for any other.
 */
export type RepoAddress = GithubId | `${HostId}:${string}`;

/** What a session was launched on, when it was picked from the user's code host connection. */
export interface SessionRepository {
	provider: HostId;
	/** The provider's id for the repository. */
	id: GithubId;
	owner: string;
	name: string;
	/** The branch the agent started from, and the base of the session's pull request. */
	branch: string;
	private: boolean;
	/** The repository's page: "https://github.com/owner/name". */
	url: string;
	/**
	 * The host's base URL, for a repository on another instance than the deployment's own for its host. Absent for
	 * the deployment's own instance, which every repository is on today (codehost/ref.ts).
	 */
	instance?: string;
}

/** The pull request of a session, as GitHub last described it to the platform. */
export interface PullRequestInfo {
	number: number;
	/** Its page at GitHub. */
	url: string;
	state: "open" | "draft" | "merged" | "closed";
	title: string;
	/** The branch the session's work is on. */
	branch: string;
	/** The branch it asks to be merged into. */
	base: string;
	/** When the platform last pushed to it, ms since the epoch. */
	pushedAt: number;
	/** Short verification summary from the last description the platform wrote. */
	verified: string;
}

/** The message of the commit the platform makes, and of the pull request when it opens one. */
export interface PublishMessage {
	title: string;
	body: string;
	/** Separate commit message for agent requests. Panel publishing uses the title and body. */
	commit?: string;
}

/** What the side panel shows about getting a session's work out. */
export interface PublishState {
	/** Null when the session does not work on a repository of the user's GitHub connection. */
	repository: SessionRepository | null;
	pullRequest: PullRequestInfo | null;
	/** The branch the work goes to: named for the session, and kept once something was pushed. */
	branch: string;
	/** Includes uncommitted files and unpublished commits. Null means checking would require starting the sandbox. */
	changes: boolean | null;
	/** A message to start from: the session's title, and the last answer or the changed files. */
	draft: PublishMessage;
	/** Why nothing can be pushed right now, in a sentence; null when it can. */
	blocked: string | null;
	/** The commit the platform last pushed to `branch`, by the panel or for the agent; null when nothing was pushed. With no pull request open, "Open pull request" opens one from it. */
	pushed: string | null;
}

export interface PublishResult {
	state: PublishState;
	/** True when this call opened the pull request; false when it pushed to one that was open already. */
	opened: boolean;
}
