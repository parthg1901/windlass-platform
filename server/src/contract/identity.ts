/** Accounts on other surfaces (Slack, Linear, Jira) a user has linked, so that what they file there is filed as theirs. */

/** The surfaces a user links from Settings. GitHub and GitLab are linked by connecting them. */
export type LinkSurface = "slack" | "linear" | "jira";

export interface LinkedAccount {
	surface: LinkSurface;
	/** The surface's workspace, team or site the link is in: a Slack team id, a Linear workspace id, or "atlassian". */
	tenant: string;
	/** The workspace's name, for display. */
	tenantName: string;
	/** The linked user's name there, for display; empty when the surface named none. */
	name: string;
}

export interface LinkedAccountsActions {
	linkedAccounts(): Promise<LinkedAccount[]>;
	/**
	 * Links the account a ticket proves: the private one-time link Slack sent (`#link=slack.<team>.<code>`) or the ticket a
	 * Linear or Jira sign-in came back with. A ticket works once, and only for the Windlass account it was made for.
	 */
	linkAccount(ticket: string): Promise<LinkedAccount[]>;
	/** Begins proving a Linear account: the address at Linear to sign in as yourself. The page comes back with `#link=<ticket>`. */
	linkAccountStart(input: { surface: "linear"; origin: string }): Promise<{ url: string }>;
	unlinkAccount(input: { surface: LinkSurface; tenant: string }): Promise<LinkedAccount[]>;
}
