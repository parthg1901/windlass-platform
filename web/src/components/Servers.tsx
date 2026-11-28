/**
 * The MCP servers a session's project names, in its side panel: each as the session last heard of it
 * from Windlass (it runs, it waits for the user's approval, it could not start and why), with the
 * user's remembered approval where there is one, until when it holds, and the way to forget it. A
 * server that waits is approved here too; the dialog says what the question in the conversation says.
 *
 * A server lives with the Windlass process of a turn, so between turns none runs: one that ran in the
 * last turn is said to start with each turn, which is what its approval comes to.
 *
 * The user's own MCP servers, from the account's settings, are listed under the project's and told
 * apart from them: Windlass starts those in every session without asking, so they have a state and
 * no approval, and the way to change one leads to the settings page. Where the session's sandbox
 * hands MCP servers only some of the account's secrets, the list says so under one that could not start.
 *
 * The section is there only for a session that has a server of either kind (`SessionSummary.servers`),
 * and it is the panel's last, so that its arrival moves nothing above it.
 *
 * A repository's own page lists the same record from the other side (`RepositoryApprovals`): every
 * approval the user's actor remembers for the repository, whichever session it was given in, with
 * its age, until when it holds, and the way to forget it. What a server is and whether it runs is a
 * session's to know, so that list has neither.
 */
import type {
	GithubId,
	PendingQuestion,
	RepositoryApproval,
	RepositoryView,
	SessionServer,
	SessionServers,
	SessionSummary,
} from "@contract";
import { useCallback, useEffect, useId, useState } from "react";
import { absoluteTime, day, plural, relativeTime } from "../lib/format";
import { linkProps } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { Dialog } from "./Dialog";
import { LongText } from "./Fold";
import { RefreshIcon, WarnIcon } from "./Icons";
import { LoadError, Loading, SkeletonLines } from "./ui";

type Tone = "on" | "ask" | "bad" | "off";

/** How a server's state reads: a word, what to add to it, and its tone. `busy` is whether a turn of the session is in progress. */
export function serverState(
	server: Pick<SessionServer, "state" | "remote" | "tools" | "approval">,
	busy: boolean,
): { word: string; fact: string | null; tone: Tone } {
	const tools =
		server.tools === null
			? null
			: server.tools === 1
				? "1 tool"
				: server.tools === 0
					? "no tools"
					: `${server.tools} tools`;
	switch (server.state) {
		case "running":
			// Nothing runs between turns: Windlass starts it again with the next one.
			return {
				word: busy
					? server.remote
						? "connected"
						: "running"
					: server.remote
						? "connects with each turn"
						: "starts with each turn",
				fact: tools,
				tone: "on",
			};
		case "starting":
			return { word: server.remote ? "connecting" : "starting", fact: null, tone: "on" };
		case "waiting":
			return server.approval
				? {
						word: "approved",
						fact: server.remote ? "connects with the next turn" : "starts with the next turn",
						tone: "on",
					}
				: { word: "waits for your approval", fact: null, tone: "ask" };
		case "failed":
			return { word: server.remote ? "could not connect" : "could not start", fact: null, tone: "bad" };
		default:
			return { word: server.remote ? "not connected" : "stopped", fact: null, tone: "off" };
	}
}

/** What the section says of the project its approvals are remembered for. */
function remembered(project: SessionServers["project"]): string {
	return project.kind === "session"
		? "Approvals are remembered for this session only: it has no repository."
		: `Approvals are remembered for ${project.label}.`;
}

function Until({ at }: { at: number }) {
	return (
		<time dateTime={new Date(at).toISOString()} title={absoluteTime(at)}>
			{day(at)}
		</time>
	);
}

function ApproveDialog({
	sessionId,
	server,
	onClose,
	onDone,
}: {
	sessionId: string;
	server: SessionServer;
	onClose(): void;
	onDone(state: SessionServers): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const details = useId();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const asks = server.asks;
	if (!asks || server.fingerprint === null) return null;
	const fingerprint = server.fingerprint;

	const approve = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			onDone(await client.session(auth, sessionId).approveServer(server.name, fingerprint));
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	};

	return (
		<Dialog
			title={asks.title}
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Not now
					</button>
					<button
						type="button"
						className="button button-primary"
						onClick={approve}
						disabled={busy}
						aria-describedby={details}
					>
						{busy ? "Approving…" : "Approve for this project"}
					</button>
				</>
			}
		>
			<div className="server-ask">
				<pre
					className="server-ask-subject"
					tabIndex={0}
					aria-label={server.remote ? "The address it is reached at" : "The command that starts it"}
				>
					{server.subject}
				</pre>
				{server.file ? (
					<p className="server-ask-where">
						<span className="server-ask-key">defined in</span> {server.file}
					</p>
				) : null}
				<div className="server-ask-details" id={details}>
					{asks.details.map(detail => (
						<p key={detail}>{detail}</p>
					))}
				</div>
				{error ? (
					<p className="callout callout-bad" role="alert">
						<WarnIcon />
						<span className="callout-text">{error}</span>
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

function Server({
	server,
	busy,
	asked,
	acting,
	forgot,
	failure,
	onApprove,
	onForget,
}: {
	server: SessionServer;
	/** A turn of the session is in progress. */
	busy: boolean;
	/** The question about this server is open in the conversation. */
	asked: boolean;
	/** This server's approval is being forgotten. */
	acting: boolean;
	/** What was forgotten of it here, since the list was last read on request: its lines stay where they were. */
	forgot: "approval" | "earlier" | null;
	failure: string | null;
	onApprove(): void;
	onForget(): void;
}) {
	const { word, fact, tone } = serverState(server, busy);
	const held = server.approval ?? server.earlier ?? null;
	return (
		<li className="server">
			<p className="server-head">
				<span className="server-name">{server.name}</span>
				<span className={`server-state server-state-${tone}`}>
					<span className="server-dot" aria-hidden="true" />
					{word}
					{fact ? <span className="server-fact"> · {fact}</span> : null}
				</span>
			</p>
			{/* A project's command is shown to its last character: it is what an approval is of. The user's own is theirs to read in full in their settings. */}
			{server.origin === "user" ? (
				<LongText lines={3} className="server-subject">
					<span title="Defined in your settings">
						<span className="visually-hidden">{server.remote ? "reached at " : "started by "}</span>
						{server.subject}
					</span>
				</LongText>
			) : (
				<p className="server-subject" title={server.file ? `Defined in ${server.file}` : undefined}>
					<span className="visually-hidden">{server.remote ? "reached at " : "started by "}</span>
					{server.subject}
				</p>
			)}
			{server.reason ? <p className="server-reason">{server.reason}</p> : null}
			{server.earlier || forgot === "earlier" ? (
				<p className="server-reason">Its definition changed since you approved it.</p>
			) : null}
			{server.asks ? (
				<p className="server-foot">
					{asked ? (
						<span className="server-held">asked in the conversation</span>
					) : (
						<button
							type="button"
							className="button button-outline button-small"
							onClick={onApprove}
							aria-label={`Approve the MCP server ${server.name}`}
						>
							Approve…
						</button>
					)}
				</p>
			) : null}
			{server.origin !== "user" && (held || !server.asks || forgot === "earlier") ? (
				<p className="server-foot">
					{held ? (
						<>
							<span className="server-held">
								{server.approval ? "approved until " : "earlier approval until "}
								<Until at={held.expiresAt} />
							</span>
							<button
								type="button"
								className="link server-forget"
								onClick={onForget}
								disabled={acting}
								aria-label={`Forget the approval of the MCP server ${server.name}`}
							>
								{acting ? "Forgetting…" : "Forget"}
							</button>
						</>
					) : (
						<span className="server-held server-held-none">no approval remembered</span>
					)}
				</p>
			) : null}
			{failure ? (
				<p className="panel-empty tone-bad server-failure" role="alert">
					<WarnIcon size={13} /> {failure}
				</p>
			) : null}
		</li>
	);
}

export function ServersSection({
	sessionId,
	summary,
	question,
	onServers,
}: {
	sessionId: string;
	summary: SessionSummary;
	question: PendingQuestion | null;
	onServers?(state: SessionServers | null): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [state, setState] = useState<SessionServers | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** The server whose approval is being forgotten, and why the last try did not go through. */
	const [forgetting, setForgetting] = useState<string | null>(null);
	const [failure, setFailure] = useState<{ name: string; message: string } | null>(null);
	/** The server whose question the dialog shows. */
	const [approving, setApproving] = useState<string | null>(null);
	/** What was forgotten here, by server: its row keeps its lines, and the note about what forgetting leaves stays. */
	const [forgot, setForgot] = useState<Record<string, "approval" | "earlier">>({});
	const present = (summary.servers?.count ?? 0) > 0;
	const changedAt = summary.servers?.changedAt ?? 0;

	const load = useCallback(() => {
		let current = true;
		setLoading(true);
		client
			.session(auth, sessionId)
			.servers()
			.then(
				next => {
					if (!current) return;
					setState(next);
					setError(null);
					setLoading(false);
				},
				(failed: unknown) => {
					if (!current) return;
					setError(explain(failed));
					setLoading(false);
				},
			);
		return () => {
			current = false;
		};
	}, [client, auth, sessionId, explain]);

	// On open, and whenever the session says that what it knows of the servers or of their approvals changed.
	useEffect(() => {
		if (!present) return;
		return load();
	}, [load, present, changedAt]);

	// Whoever stands above the list hears what it read: the panel names a server that could not start outside the fold.
	useEffect(() => onServers?.(present ? state : null), [onServers, present, state]);

	if (!present) return null;

	const forget = async (name: string) => {
		if (forgetting !== null) return;
		setForgetting(name);
		setFailure(null);
		const before = state?.servers.find(server => server.name === name);
		try {
			setState(await client.session(auth, sessionId).forgetServer(name));
			setForgot(known => ({ ...known, [name]: before?.approval ? "approval" : "earlier" }));
		} catch (failed) {
			setFailure({ name, message: explain(failed) });
		} finally {
			setForgetting(null);
		}
	};

	const servers = state?.servers ?? [];
	// The project's, which wait for an approval, and the user's own, which Windlass starts without one.
	const projects = servers.filter(server => server.origin !== "user");
	const own = servers.filter(server => server.origin === "user");
	const inDialog =
		approving === null ? null : (projects.find(server => server.name === approving && server.asks) ?? null);
	const anyHeld = projects.some(server => server.approval || server.earlier);
	const busy = summary.status !== "idle";
	const row = (server: SessionServer) => (
		<Server
			key={server.name}
			server={server}
			busy={busy}
			asked={question?.server?.name === server.name}
			acting={forgetting === server.name}
			forgot={forgot[server.name] ?? null}
			failure={failure?.name === server.name ? failure.message : null}
			onApprove={() => setApproving(server.name)}
			onForget={() => void forget(server.name)}
		/>
	);

	return (
		<section className="panel-section" aria-labelledby="panel-servers">
			<h2 className="panel-title" id="panel-servers">
				MCP servers
				<button
					type="button"
					className="icon-button icon-button-small"
					onClick={load}
					disabled={loading}
					aria-label="Read this agent's MCP servers again"
					title="Reload"
				>
					<RefreshIcon size={13} className={loading ? "spin" : undefined} />
				</button>
			</h2>
			{error ? <LoadError inline error={error} /> : null}
			{state === null ? (
				error ? null : (
					<Loading label="Loading the servers">
						<SkeletonLines title={false} lines={[72, 46]} />
					</Loading>
				)
			) : servers.length === 0 ? (
				<p className="panel-empty">
					Neither the project's configuration nor your settings name an MCP server any more.
				</p>
			) : (
				<>
					{projects.length > 0 ? (
						<>
							<p className="panel-empty server-lede">{remembered(state.project)}</p>
							<ul className="servers" aria-label="The MCP servers this session's project names">
								{projects.map(row)}
							</ul>
							{anyHeld || Object.keys(forgot).length > 0 ? (
								<p className="panel-empty server-note">{state.forgetting}</p>
							) : null}
						</>
					) : null}
					{own.length > 0 ? (
						<>
							<p className={`panel-empty server-lede${projects.length > 0 ? " server-own" : ""}`}>
								Yours, from{" "}
								<a className="kv-link" {...linkProps({ name: "settings" })}>
									your settings
								</a>
								: Windlass starts them in every agent, without asking.
							</p>
							<ul className="servers" aria-label="Your own MCP servers, from your settings">
								{own.map(row)}
							</ul>
							{state.accountSecrets && own.some(server => server.state === "failed") ? (
								<p className="panel-empty server-note">{state.accountSecrets}</p>
							) : null}
						</>
					) : null}
				</>
			)}
			{inDialog ? (
				<ApproveDialog
					sessionId={sessionId}
					server={inDialog}
					onClose={() => setApproving(null)}
					onDone={next => {
						setState(next);
						setApproving(null);
					}}
				/>
			) : null}
		</section>
	);
}

/** How long ago an approval was given, in words: "today", "yesterday", "12 days ago". */
function approvedAgo(at: number, now: number): string {
	const days = Math.floor(Math.max(0, now - at) / 86_400_000);
	return days === 0 ? relativeTime(at, now) : days === 1 ? "yesterday" : `${days} days ago`;
}

/**
 * The approvals of MCP servers the user's actor remembers for one repository, on that repository's
 * page. `onChanged` is handed the page as it is after an approval was forgotten.
 */
export function RepositoryApprovals({
	repositoryId,
	name,
	approvals,
	forgetting,
	now,
	onChanged,
}: {
	repositoryId: GithubId;
	name: string;
	approvals: RepositoryApproval[];
	forgetting: string;
	now: number;
	onChanged(view: RepositoryView): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [acting, setActing] = useState<string | null>(null);
	const [failure, setFailure] = useState<{ name: string; message: string } | null>(null);
	/** True once one was forgotten here: the note about what forgetting leaves stays while the page is open. */
	const [forgot, setForgot] = useState(false);

	const forget = async (server: string) => {
		if (acting !== null) return;
		setActing(server);
		setFailure(null);
		try {
			onChanged(await client.user(auth).forgetRepositoryApproval(repositoryId, server));
			setForgot(true);
		} catch (failed) {
			setFailure({ name: server, message: explain(failed) });
		} finally {
			setActing(null);
		}
	};

	return (
		<>
			{approvals.length === 0 ? (
				<p className="usage-empty">
					No approval of an MCP server is remembered for {name}. An agent asks before it starts a server the repository
					names.
				</p>
			) : (
				<ul className="servers repo-approvals" aria-label={`The approvals of MCP servers remembered for ${name}`}>
					{approvals.map(approval => (
						<li key={approval.name} className="server">
							<p className="server-head">
								<span className="server-name">{approval.name}</span>
								<span className="server-state">
									approved{" "}
									<time
										dateTime={new Date(approval.approvedAt).toISOString()}
										title={absoluteTime(approval.approvedAt)}
									>
										{approvedAgo(approval.approvedAt, now)}
									</time>
								</span>
							</p>
							<p className="server-foot">
								<span className="server-held">
									holds until <Until at={approval.expiresAt} />
									{approval.definitions > 1 ? ` · ${plural(approval.definitions, "definition")} of it approved` : ""}
								</span>
								<button
									type="button"
									className="link server-forget"
									onClick={() => void forget(approval.name)}
									disabled={acting !== null}
									aria-label={`Forget the approval of the MCP server ${approval.name}`}
								>
									{acting === approval.name ? "Forgetting…" : "Forget"}
								</button>
							</p>
							{failure?.name === approval.name ? (
								<p className="panel-empty tone-bad server-failure" role="alert">
									<WarnIcon size={13} /> {failure.message}
								</p>
							) : null}
						</li>
					))}
				</ul>
			)}
			{approvals.length > 0 || forgot ? <p className="usage-note">{forgetting}</p> : null}
		</>
	);
}
