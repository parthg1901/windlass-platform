/**
 * What the platform remembers of a user's approvals of MCP servers that projects name, and what a
 * session knows of its own project's servers.
 *
 * Windlass remembers an approval itself, in its data directory, for the project directory and exactly
 * that definition, for 30 days. Where that directory is on the sandbox's disk (E2B), the record goes no
 * further than the sandbox: another session on the same repository asks again, and so does the same
 * session once its sandbox was replaced. So the platform keeps a record of its own, in the user's
 * `user` actor, which every session of that user reaches from whichever server it runs on:
 *
 *   - for a project: the GitHub repository a session was launched on through the GitHub connection
 *     (GitHub's id for it, which a rename does not change), the address a session was launched on when
 *     one was pasted, exactly as it is stored, and for a session with no repository the session itself;
 *   - for the server's name and Windlass's fingerprint of its definition, so a changed definition is
 *     asked about again, as Windlass asks;
 *   - until 30 days after the user approved, which is how long Windlass keeps its own. Using the
 *     record does not renew it.
 *
 * Only a yes is kept, and only one that Windlass took: "not now" is remembered nowhere.
 *
 * The record says that the user approved a definition (a command and its arguments, or an address),
 * as Windlass's does. It says nothing of the files that command runs: a later commit can change those
 * without changing the definition, and the server then starts unasked wherever the record reaches.
 *
 * Windlass's own record stays where it is: the platform has no way to take one back (Windlass's
 * protocol has an approval and no withdrawal, and nothing that stops a server; its
 * packages/acp/src/extensions.ts lists `mcp`, `mcp_approve` and `mcp_changed`). Forgetting here is
 * therefore for the next session and the next sandbox.
 *
 * This file has no actor in it: the `user` actor keeps an `ApprovalBook` beside its table, the session
 * actor folds what Windlass says into `KnownServer`s, and scripts/mcp-check.ts runs the same book
 * against a real Windlass.
 */

import type { GithubId, SessionServer, SessionServerState, SessionServers } from "./contract.js";
import type { TurnServer } from "./sandbox/api.js";
import { commandLine } from "./server-question.js";

/** How long an approval is remembered: Windlass's own time for it (its `PROJECT_GRANT_TTL_MS`). */
export const APPROVAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How many approvals one user's book holds; the oldest go first. */
export const MAX_APPROVALS = 500;
/** How many servers of one project a session keeps track of. */
export const MAX_KNOWN_SERVERS = 50;

// ---------------------------------------------------------------------------------------------
// The project
// ---------------------------------------------------------------------------------------------

/** What an approval is remembered for: `key` names it in the book, `label` is how a sentence names it. */
export interface ApprovalProject {
	key: string;
	kind: SessionServers["project"]["kind"];
	label: string;
}

/** The project of a session: its repository, or the session itself when it has none. */
export function projectOf(session: {
	sessionId: string;
	repoUrl: string | null;
	repo?: { provider?: "github" | "gitlab"; id: GithubId; owner: string; name: string } | null;
}): ApprovalProject {
	// A repository of the GitHub connection is known by GitHub's id: its owner and name can change.
	if (session.repo && session.repo.provider !== "gitlab")
		return { key: `github:${session.repo.id}`, kind: "github", label: `${session.repo.owner}/${session.repo.name}` };
	// A pasted address is taken as it is stored. Two spellings of one repository are two projects: the second asks once more.
	if (!session.repo && session.repoUrl)
		return {
			key: `address:${session.repoUrl}`,
			kind: "address",
			label: session.repoUrl.replace(/^https:\/\//, "").replace(/\/$/, ""),
		};
	return { key: sessionProjectKey(session.sessionId), kind: "session", label: "this session" };
}

/** The project of a session that has no repository: what is removed when the session is deleted. */
export function sessionProjectKey(sessionId: string): string {
	return `session:${sessionId}`;
}

// ---------------------------------------------------------------------------------------------
// The book
// ---------------------------------------------------------------------------------------------

export interface ServerApproval {
	project: string;
	/** The project in words, as it was when the user approved. */
	label: string;
	name: string;
	fingerprint: string;
	approvedAt: number;
	expiresAt: number;
}

/** What a change to the book did, for whoever keeps a copy of it elsewhere. */
export interface BookChange {
	added: ServerApproval[];
	removed: ServerApproval[];
}

const same = (
	a: Pick<ServerApproval, "project" | "name" | "fingerprint">,
	b: Pick<ServerApproval, "project" | "name" | "fingerprint">,
) => a.project === b.project && a.name === b.name && a.fingerprint === b.fingerprint;

/** One user's remembered approvals. Every method takes the time, so nothing here reads a clock. */
export class ApprovalBook {
	private rows: ServerApproval[];

	constructor(
		rows: readonly ServerApproval[] = [],
		private readonly ttlMs: number = APPROVAL_TTL_MS,
	) {
		this.rows = [...rows];
	}

	all(): ServerApproval[] {
		return [...this.rows];
	}

	/** The approvals of one project that have not run out, the newest first. */
	of(project: string, now: number): ServerApproval[] {
		return this.rows
			.filter(row => row.project === project && row.expiresAt > now)
			.sort((a, b) => b.approvedAt - a.approvedAt);
	}

	/** The approval of exactly this definition, when one is remembered and has not run out. */
	find(project: string, name: string, fingerprint: string, now: number): ServerApproval | null {
		if (fingerprint === "") return null;
		return this.rows.find(row => same(row, { project, name, fingerprint }) && row.expiresAt > now) ?? null;
	}

	/** The user approved: remembered from now, in place of an earlier approval of the same definition. */
	approve(input: { project: string; label: string; name: string; fingerprint: string }, now: number): BookChange {
		if (input.project === "" || input.name === "" || input.fingerprint === "") return { added: [], removed: [] };
		const approval: ServerApproval = { ...input, approvedAt: now, expiresAt: now + this.ttlMs };
		const kept = this.rows.filter(row => row.expiresAt > now && !same(row, approval));
		kept.push(approval);
		// Somebody who approves again and again leaves no more than the book holds.
		kept.sort((a, b) => a.approvedAt - b.approvedAt);
		const rows = kept.slice(-MAX_APPROVALS);
		const removed = this.rows.filter(row => !rows.includes(row));
		this.rows = rows;
		return { added: [approval], removed };
	}

	/** Forgets every approval of that server for that project, whatever its definition was. */
	forget(project: string, name: string): BookChange {
		return this.drop(row => row.project === project && row.name === name);
	}

	/** Forgets everything remembered for a project: a session that was its own project is gone. */
	forgetProject(project: string): BookChange {
		return this.drop(row => row.project === project);
	}

	/** Drops what has run out. */
	prune(now: number): BookChange {
		return this.drop(row => row.expiresAt <= now);
	}

	private drop(test: (row: ServerApproval) => boolean): BookChange {
		const removed = this.rows.filter(test);
		if (removed.length > 0) this.rows = this.rows.filter(row => !removed.includes(row));
		return { added: [], removed };
	}
}

// ---------------------------------------------------------------------------------------------
// What a session knows of its project's servers
// ---------------------------------------------------------------------------------------------

/** A server of the session, of its project or of its user's own, as Windlass last described it to the session. Kept with the session. */
export type KnownServer = Omit<SessionServer, "approval" | "earlier" | "asks">;

const STATES: readonly SessionServerState[] = ["running", "starting", "waiting", "failed", "stopped"];

/**
 * What Windlass says of the session's servers, folded into what the session knew. Windlass names a
 * definition's fingerprint only while it waits for approval, so the fingerprint a server waited with
 * is kept for as long as what it starts stays the same: that is the definition the session saw
 * approved. A server Windlass no longer names is gone from the project's configuration, or from its
 * user's settings.
 */
export function knownServers(known: readonly KnownServer[], said: readonly TurnServer[], at: number): KnownServer[] {
	const next: KnownServer[] = [];
	for (const server of said.slice(0, MAX_KNOWN_SERVERS)) {
		if (typeof server?.name !== "string" || server.name === "" || next.some(one => one.name === server.name)) continue;
		const argv = Array.isArray(server.argv) ? server.argv.map(String) : null;
		const subject = argv === null ? String(server.url ?? "") : commandLine(argv);
		const state: SessionServerState = STATES.includes(server.state) ? server.state : "stopped";
		const before = known.find(one => one.name === server.name);
		const waitsWith = typeof server.fingerprint === "string" && server.fingerprint !== "" ? server.fingerprint : null;
		const fingerprint =
			waitsWith ?? (before && before.subject === subject && state !== "waiting" ? before.fingerprint : null);
		const tools = state === "running" && typeof server.tools === "number" ? server.tools : null;
		const reason =
			state === "failed" && typeof server.error === "string" && server.error.trim() !== ""
				? server.error.trim().replace(/\s*\n\s*/g, " ")
				: null;
		const file = typeof server.file === "string" && server.file !== "" ? server.file : null;
		// One of the user's own never waits and has no definition to approve: Windlass starts it unasked.
		const own = server.origin === "user";
		const one: KnownServer = {
			name: server.name,
			...(own ? { origin: "user" as const } : {}),
			subject,
			remote: argv === null,
			file: own ? null : file,
			state,
			tools,
			reason,
			fingerprint: own ? null : fingerprint,
			at,
		};
		// Nothing changed: the time it was first heard stays, so a reader can tell when it last did.
		next.push(before && sameKnown(before, one) ? before : one);
	}
	return next;
}

function sameKnown(a: KnownServer, b: KnownServer): boolean {
	return (
		a.name === b.name &&
		(a.origin ?? "project") === (b.origin ?? "project") &&
		a.subject === b.subject &&
		a.remote === b.remote &&
		a.file === b.file &&
		a.state === b.state &&
		a.tools === b.tools &&
		a.reason === b.reason &&
		a.fingerprint === b.fingerprint
	);
}

/** Whether two lists say the same of every server. */
export function sameServers(a: readonly KnownServer[], b: readonly KnownServer[]): boolean {
	return a.length === b.length && a.every((one, index) => sameKnown(one, b[index] as KnownServer));
}

/**
 * The approval that belongs to a server of the session: the one of the definition the session saw,
 * and where the session never saw it wait (Windlass started it from a record of its own), the newest
 * one of that name. `approvals` are the project's, the newest first.
 */
export function approvalFor(
	server: Pick<KnownServer, "name" | "fingerprint">,
	approvals: readonly ServerApproval[],
): ServerApproval | null {
	const named = approvals.filter(approval => approval.name === server.name);
	if (server.fingerprint === null) return named[0] ?? null;
	return named.find(approval => approval.fingerprint === server.fingerprint) ?? null;
}

/** The session's servers as its panel shows them. `asks` words the question about one that waits. */
export function serversView(
	project: ApprovalProject,
	known: readonly KnownServer[],
	approvals: readonly ServerApproval[],
	forgetting: string,
	asks: (server: KnownServer) => NonNullable<SessionServer["asks"]>,
): SessionServers {
	return {
		project: { kind: project.kind, label: project.label },
		servers: known.map(server => {
			// A server of the user's own is in the account's settings, not in the project: nothing was approved, and nothing is asked.
			if (server.origin === "user") return { ...server, approval: null };
			const approval = approvalFor(server, approvals);
			// An approval of another definition of the server: it does not start this one, and the user can still forget it.
			const earlier = approval === null ? (approvals.find(other => other.name === server.name) ?? null) : null;
			const times = (one: ServerApproval | null) =>
				one === null ? null : { approvedAt: one.approvedAt, expiresAt: one.expiresAt };
			const waits = server.state === "waiting" && server.fingerprint !== null && approval === null;
			return {
				...server,
				approval: times(approval),
				...(earlier === null ? {} : { earlier: times(earlier) }),
				...(waits ? { asks: asks(server) } : {}),
			};
		}),
		forgetting,
	};
}
