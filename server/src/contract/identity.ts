/** Accounts on other surfaces (Slack, Linear, Jira, GitLab) a user has linked, so that what they file there is filed as theirs. */

export type LinkSurface = "slack" | "linear" | "jira" | "gitlab";

export interface LinkedAccount {
	surface: LinkSurface;
	/** The surface's workspace, team or site the link is in: a Slack team id, a Linear workspace id, "atlassian", or the GitLab instance. */
	tenant: string;
	/** The workspace's name, for display. */
	tenantName: string;
	/** The linked user's name there, for display; empty when the surface named none. */
	name: string;
}

export interface LinkedAccounts {
	accounts: LinkedAccount[];
	/**
	 * The surfaces whose Link button is a read-only sign-in at the surface itself. Slack's needs Sign in with Slack set up
	 * for the deployment's app; without it a Slack user links through the private link Windlass sends them.
	 */
	signIn: LinkSurface[];
}

/** What a private link sent on Slack would link, named for the user to confirm before it is linked. */
export interface LinkOffer {
	surface: "slack";
	tenantName: string;
	/** The Slack user's name, or their Slack id when Slack named none. */
	name: string;
}

export interface LinkedAccountsActions {
	linkedAccounts(): Promise<LinkedAccounts>;
	/**
	 * Links the account a ticket proves: the private one-time link Slack sent (`#link=slack.<team>.<code>`), or the ticket a
	 * sign-in at Slack, Linear, Jira or GitLab came back with (`#link-return=<ticket>`). A sign-in's ticket works only for the
	 * Windlass account that began it; a private link works once.
	 */
	linkAccount(ticket: string): Promise<LinkedAccounts & { linked: LinkedAccount }>;
	/** Names the Slack user and workspace a private link would link, without using it. */
	linkOffer(ticket: string): Promise<LinkOffer>;
	/** Begins a read-only sign-in at a surface as oneself: the address to send the browser to. It comes back with `#link-return=`. */
	linkAccountStart(input: { surface: LinkSurface; origin: string }): Promise<{ url: string }>;
	unlinkAccount(input: { surface: LinkSurface; tenant: string }): Promise<LinkedAccounts>;
}
