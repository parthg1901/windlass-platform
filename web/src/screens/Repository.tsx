/**
 * A repository chosen in the Agents home (screens/Workspace.tsx): the right side of the home, beside
 * the rail, for one repository of the user's GitHub connection. It took the place of the repository's
 * own page, at the same addresses.
 *
 * It is addressed by GitHub's id for the repository, which a rename does not change. Its head says
 * what is on it and leads to its open pull requests and its saved settings; under it, a composer that
 * launches on it, and three tabs, each at its own address: the overview (its agents, and its work items
 * as a table), all of its agents, and all of its work items with the way to file one. The agents and
 * the pull requests come from the summaries the list of agents already has, each pull request with what
 * its description says was verified. A work item's session is not among the agents: it is part of its
 * item, and is opened from the item's row, and a pull request it opened is named after its item. Its
 * settings (`/settings`, in RepositorySettings.tsx): what is kept for it, set once and seldom visited.
 *
 * Two things are asked, apart from each other. What is saved (`repository`) is the user's actor's
 * own and is there at once. Whether the repository can still be launched on (`githubRepository`) is
 * GitHub's to say and can take a moment or fail: the page does not wait for it, and a repository that
 * GitHub no longer shows to this user keeps its page, with what is saved for it and the way to
 * delete that, and with a plain sentence that no new agent can be launched on it.
 */
import type { GithubId, GithubRepository, MachineSummary, RepositoryView, SessionSummary } from "@contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { hasReason } from "../api/client";
import { AgentList } from "../components/Agents";
import { BranchName } from "../components/BranchName";
import {
	ArrowLeftIcon,
	BranchIcon,
	ExternalIcon,
	LockIcon,
	PullRequestIcon,
	RepoIcon,
	RingIcon,
	SlidersIcon,
	WarnIcon,
} from "../components/Icons";
import { ItemTable, itemsByUrgency } from "../components/ItemTable";
import { PullState } from "../components/PullRequest";
import { StartComposer } from "../components/StartComposer";
import { TabPanel, Tabs } from "../components/Tabs";
import { FilterBar, ListHeader } from "../components/WorkspaceFilters";
import type { ConnectionState } from "../api/client";
import { absoluteTime, plural, relativeTime } from "../lib/format";
import { LONE_GROUP_SHOWN, feedCounts, openPulls, ownAgents, repositoryName, sessionsOn } from "../lib/repositories";
import { linkProps, type RepositoryPaneView } from "../lib/router";
import { filterCount, itemStatus, matchesItem, matchesSession, sessionStatus, type Filters } from "../lib/workspace";
import { useApp, useAuth } from "../state/app";
import { useGithub, type Github } from "../state/github";
import { useNow, useSessions } from "../state/hooks";
import { RepositoryItems } from "./Items";
import { type ItemsState } from "../state/items";
import { offered } from "../../../server/src/factory/readiness-track";
import { RepositorySetupChecks } from "../components/RepositorySetupChecks";
import { RepositorySettings } from "./RepositorySettings";
import { readTwice } from "../lib/retry";

/** Whether new agents can be launched on the repository, as GitHub says now. */
export type RepositoryAccess =
	| { state: "checking" }
	/** The connection covers it and the connected user may read it. */
	| { state: "usable"; repository: GithubRepository }
	/** It cannot be launched on, and asking again does not change that: `why` says what is in the way. */
	| { state: "unusable"; reason: "github_off" | "github_not_connected" | "github_gone" | "github_denied"; why: string }
	/** GitHub could not be asked: nothing is known either way. */
	| { state: "unknown"; why: string };

export interface RepositoryPage {
	id: GithubId;
	/** "owner/name": GitHub's own once it answered, otherwise as the agents on it or what was saved for it have it. Null when nothing names it. */
	name: string | null;
	/** Null until it was read. */
	view: RepositoryView | null;
	/** Why what is saved could not be read. */
	error: string | null;
	access: RepositoryAccess;
	/** The user's sessions on it, the most recently used first, their work items' among them (`ownAgents` leaves those out); null until the list arrived. */
	sessions: SessionSummary[] | null;
	connection: ConnectionState;
	/** Reads what is saved again. */
	reload(): void;
	/** Takes the page as an action answered it. */
	replace(view: RepositoryView): void;
	/** Asks GitHub again. */
	recheck(): void;
}

const UNUSABLE = ["github_off", "github_not_connected", "github_gone", "github_denied"] as const;

/** Everything a repository's page shows, live: what is saved, what GitHub says, and the agents on it. */
export function useRepository(id: GithubId): RepositoryPage {
	const { client, explain } = useApp();
	const auth = useAuth();
	const github = useGithub();
	const { sessions, connection } = useSessions();
	const [view, setView] = useState<RepositoryView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [access, setAccess] = useState<RepositoryAccess>({ state: "checking" });
	const [asked, setAsked] = useState(0);
	const reading = useRef(0);

	const reload = useCallback(() => {
		const mine = ++reading.current;
		readTwice(() => client.user(auth).repository(id)).then(
			next => {
				if (mine !== reading.current) return;
				setView(next);
				setError(null);
			},
			(failure: unknown) => mine === reading.current && setError(explain(failure)),
		);
	}, [client, auth, explain, id]);

	const connected = github.enabled ? (github.status === null ? null : (github.status.connection?.connectedAt ?? 0)) : 0;
	useEffect(() => {
		setView(null);
		setError(null);
		reload();
		return () => {
			reading.current += 1;
		};
	}, [reload, connected]);

	// GitHub is asked when the page opens, when the connection changes, and when the user asks again.
	const connectionError = github.status === null ? github.error : null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `asked` is not read here; a change of it is when to ask again
	useEffect(() => {
		if (!github.enabled) {
			setAccess({
				state: "unusable",
				reason: "github_off",
				why: "This deployment has no GitHub App any more, so no agent can be launched on a repository of GitHub's here.",
			});
			return;
		}
		// Until the connection is known there is nothing to ask with; when it could not be read, nothing is known.
		if (connected === null) {
			setAccess(connectionError === null ? { state: "checking" } : { state: "unknown", why: connectionError });
			return;
		}
		if (connected === 0) {
			setAccess({
				state: "unusable",
				reason: "github_not_connected",
				why: "GitHub is not connected, so no agent can be launched on it.",
			});
			return;
		}
		let current = true;
		setAccess({ state: "checking" });
		client
			.user(auth)
			.githubRepository(id)
			.then(
				repository => current && setAccess({ state: "usable", repository }),
				(failure: unknown) => {
					if (!current) return;
					const reason = UNUSABLE.find(code => hasReason(failure, code));
					setAccess(
						reason ? { state: "unusable", reason, why: explain(failure) } : { state: "unknown", why: explain(failure) },
					);
				},
			);
		return () => {
			current = false;
		};
	}, [client, auth, explain, id, github.enabled, connected, connectionError, asked]);

	const mine = sessions === null ? null : sessionsOn(sessions, id);
	const newest = mine?.reduce<SessionSummary | null>(
		(found, session) => (found === null || session.createdAt > found.createdAt ? session : found),
		null,
	)?.repository;
	const name =
		access.state === "usable"
			? repositoryName(access.repository)
			: newest
				? repositoryName(newest)
				: (view?.name ?? null);
	const reloadGithub = github.reload;
	const recheck = useCallback(() => {
		// Without the connection there is nothing to ask GitHub with: that is read again first.
		if (connectionError !== null) reloadGithub();
		setAsked(count => count + 1);
	}, [connectionError, reloadGithub]);
	return { id, name, view, error, access, sessions: mine, connection, reload, replace: setView, recheck };
}

/** What GitHub says of the repository, in the page's head: where it is, and what can be done there. */
function AccessLine({ page, github }: { page: RepositoryPage; github: Github }) {
	const { access } = page;
	const address =
		page.sessions?.find(session => session.repository)?.repository?.url ??
		(page.name ? `${github.url}/${page.name}` : null);
	const repository = access.state === "usable" ? access.repository : null;
	const isPrivate =
		repository?.private ?? page.sessions?.find(session => session.repository)?.repository?.private ?? null;
	return (
		<p className="home-account repo-facts">
			{address ? (
				<a
					className="repo-link"
					href={repository ? `${github.url}/${repository.owner}/${repository.name}` : address}
					target="_blank"
					rel="noreferrer"
				>
					On GitHub
					<ExternalIcon size={11} />
				</a>
			) : null}
			{isPrivate === null ? null : (
				<span className="repo-fact">
					{isPrivate ? <LockIcon size={12} /> : null}
					{isPrivate ? "private" : "public"}
				</span>
			)}
			{access.state === "checking" ? <span className="tone-dim">checking it at GitHub…</span> : null}
			{repository ? <span className="repo-fact">default branch {repository.defaultBranch}</span> : null}
			{repository ? (
				<span className={repository.canPush ? "repo-fact" : "repo-fact tone-warn"}>
					{repository.canPush ? "you can push to it" : "read only for you: no pull request can be opened"}
				</span>
			) : null}
		</p>
	);
}

/** Why no agent can be launched on it, or that GitHub could not be asked: said once, above everything that is saved. */
function AccessNotice({ page, github }: { page: RepositoryPage; github: Github }) {
	const { access } = page;
	if (access.state === "unusable") {
		return (
			<div className="callout callout-warn" role="status">
				<WarnIcon />
				<div>
					<p className="callout-title">This repository cannot be used for new agents.</p>
					<p className="callout-text">
						{access.why} What you saved for it is still here, and you can change it or delete it under Settings.
						{access.reason === "github_not_connected" ? (
							<>
								{" "}
								<button
									type="button"
									className="link"
									onClick={() => github.connect({ where: "account" })}
									disabled={github.busy !== null && github.busy !== "popup"}
								>
									{github.busy === "leaving"
										? "Opening GitHub…"
										: github.busy === "popup"
											? "In the GitHub window…"
											: "Connect GitHub"}
								</button>
							</>
						) : null}
					</p>
				</div>
			</div>
		);
	}
	if (access.state === "unknown") {
		return (
			<p className="callout callout-info" role="status">
				<WarnIcon />
				<span>
					Whether new agents can be launched on it is not known: {access.why}{" "}
					<button type="button" className="link" onClick={page.recheck}>
						Ask GitHub again
					</button>
				</span>
			</p>
		);
	}
	return null;
}

/** The pull requests its agents opened that are still open, as the platform last saw them. */
function Pulls({ page, now }: { page: RepositoryPage; now: number }) {
	const pulls = page.sessions === null ? null : openPulls(page.sessions, page.id);
	return (
		<section className="usage-section" aria-labelledby="repo-pulls">
			<h2 className="usage-title" id="repo-pulls">
				Open pull requests
				{pulls && pulls.length > 0 ? <span className="usage-count">{pulls.length}</span> : null}
			</h2>
			{pulls === null ? null : pulls.length === 0 ? (
				<p className="usage-empty">None of its agents has a pull request that is open.</p>
			) : (
				<>
					<ul className="repo-pulls">
						{pulls.map(({ pull, session }) => (
							<li key={session.id} className="repo-pull">
								<PullState state={pull.state} />
								<div className="repo-pull-main">
									<a className="repo-pull-title" href={pull.url} target="_blank" rel="noreferrer">
										<span className="repo-pull-number">#{pull.number}</span> {pull.title}
										<ExternalIcon size={11} />
									</a>
									<p className="agent-meta">
										<span>
											<BranchName branch={pull.branch} /> into <BranchName branch={pull.base} />
										</span>
										<span>
											by{" "}
											{session.item ? (
												<a className="repo-pull-agent" {...linkProps({ name: "item", id: session.item.id })}>
													work item {session.title}
												</a>
											) : (
												<a className="repo-pull-agent" {...linkProps({ name: "session", id: session.id })}>
													{session.title}
												</a>
											)}
										</span>
										<span title={absoluteTime(pull.pushedAt)}>pushed {relativeTime(pull.pushedAt, now)}</span>
										<span title="What its description said was verified when the platform last wrote it">
											{pull.verified}
										</span>
									</p>
								</div>
							</li>
						))}
					</ul>
					<p className="usage-note">
						As the platform last saw each at GitHub. An agent's panel asks GitHub again, and a pull request merged or
						closed since then leaves this list.
					</p>
				</>
			)}
		</section>
	);
}

/** The agents on the repository the filters leave, under the list's header: all of them, or on the overview its first few. */
function AgentsSection({
	page,
	filters,
	limit,
	overview,
}: {
	page: RepositoryPage;
	filters: Filters;
	limit: number;
	overview: boolean;
}) {
	const now = useNow(15_000);
	const all = page.sessions === null ? null : ownAgents(page.sessions);
	const sessions = all === null ? null : all.filter(session => matchesSession(session, filters));
	const name = page.name ?? `Repository ${page.id}`;
	const launchable = page.access.state !== "unusable";
	const filtering = filterCount(filters) > 0;
	return (
		<section className="usage-section ws-section" aria-labelledby="repo-agents">
			<ListHeader id="repo-agents" title="Agents" count={sessions && sessions.length > 0 ? sessions.length : null} />
			{sessions === null ? (
				page.connection === "failed" ? (
					<p className="usage-empty tone-bad">The list of agents could not be loaded.</p>
				) : (
					<ul className="agents agents-loading repo-agents" aria-busy="true" aria-label="Reading your agents">
						{[0, 1].map(row => (
							<li key={row} className="agent-row agent-row-skeleton">
								<span className="skeleton skeleton-dot" />
								<div className="agent-main">
									<span className="skeleton skeleton-title" style={{ width: `${46 - row * 9}%` }} />
									<span className="skeleton skeleton-meta" style={{ width: `${62 - row * 8}%` }} />
								</div>
							</li>
						))}
					</ul>
				)
			) : sessions.length === 0 ? (
				<p className="usage-empty">
					{filtering && (all?.length ?? 0) > 0
						? "None of its agents matches the filters."
						: `No agent of yours is on this repository.${launchable ? " Launch one with the field above." : ""}`}
				</p>
			) : (
				<div className="repo-agents">
					<AgentList
						sessions={sessions}
						limit={limit}
						foldKey={`repository:${page.id}${overview ? ":overview" : ""}`}
						label={`Your agents on ${name}, the most recently used first`}
						grouped
						now={now}
					/>
				</div>
			)}
		</section>
	);
}

/** The overview's work items: those the filters leave, what asks first, as a table, with the way to all of them. */
function ItemsOverview({ page, items, filters }: { page: RepositoryPage; items: ItemsState; filters: Filters }) {
	const { platform } = useApp();
	const now = useNow(15_000);
	if (!platform.info?.items) return null;
	const mine =
		items.list === null
			? null
			: items.list.filter(item => !item.parent && String(item.repository.id) === String(page.id));
	const shown = mine === null ? null : itemsByUrgency(mine.filter(item => matchesItem(item, filters)));
	const total = feedCounts(items.feed, { repository: page.id }).total;
	const SHOWN = 8;
	return (
		<section className="usage-section ws-section" aria-labelledby="repo-items-overview">
			<ListHeader id="repo-items-overview" title="Work items" count={total > 0 ? total : null} />
			{shown === null ? (
				items.error ? (
					<p className="usage-empty tone-bad">The work items could not be loaded: {items.error}</p>
				) : (
					<div className="usage-loading" aria-busy="true" aria-label="Loading the work items">
						<span className="skeleton skeleton-meta" style={{ width: "100%" }} />
						<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
					</div>
				)
			) : shown.length === 0 ? (
				<p className="usage-empty">
					{filterCount(filters) > 0 && (mine?.length ?? 0) > 0
						? "None of its work items matches the filters."
						: "No work item on this repository yet."}
				</p>
			) : (
				<ItemTable
					items={shown.slice(0, SHOWN)}
					now={now}
					label={`Work items on ${page.name ?? "this repository"}, what asks you first`}
				/>
			)}
			{total > Math.min(SHOWN, shown?.length ?? 0) ? (
				<p className="agents-fold">
					<a className="link" {...linkProps({ name: "repository", id: page.id, view: "items" })}>
						All {plural(total, "work item")}, the ended ones too
					</a>
				</p>
			) : null}
		</section>
	);
}

/** What the filters of the home take, as each list of the repository's side has them. */
interface PaneFilters {
	filters: Filters;
	onFilters(filters: Filters): void;
	machines: readonly MachineSummary[];
}

/** A word for the default branch and the head's facts: how many agents and items, how many at work, how many ask. */
function StatusLine({ page, items }: { page: RepositoryPage; items: ItemsState }) {
	const agents = page.sessions === null ? null : ownAgents(page.sessions);
	const mine = (items.list ?? []).filter(item => !item.parent && String(item.repository.id) === String(page.id));
	const total = Math.max(feedCounts(items.feed, { repository: page.id }).total, mine.length);
	const running =
		(agents ?? []).filter(session => sessionStatus(session) === "running").length +
		mine.filter(item => itemStatus(item) === "running").length;
	const needs =
		(agents ?? []).filter(session => session.status === "waiting").length +
		mine.filter(item => item.question !== null).length;
	const branch = page.access.state === "usable" ? page.access.repository.defaultBranch : null;
	return (
		<p className="ws-status">
			{running > 0 ? (
				<span className="ws-status-running">
					<RingIcon size={12} className="ws-ring" />
					{running} running
				</span>
			) : null}
			{needs > 0 ? (
				<span className="ws-status-needs">
					<span className="ws-lamp" aria-hidden="true" />
					{needs} {needs === 1 ? "needs" : "need"} you
				</span>
			) : null}
			<span>
				{agents === null ? "–" : plural(agents.length, "agent")}
				{items.feed !== null || mine.length > 0 ? ` · ${plural(total, "work item")}` : ""}
			</span>
			{branch ? (
				<span className="ws-status-branch" title="Its default branch">
					<BranchIcon size={12} />
					{branch}
				</span>
			) : null}
		</p>
	);
}

export interface RepositoryPaneProps extends PaneFilters {
	page: RepositoryPage;
	/** The view shown under the head: undefined for the overview. */
	view?: RepositoryPaneView;
	/** Opened at the address that launched a new agent on it: the composer takes the focus. */
	launching?: boolean;
	items: ItemsState;
}

/** The chosen repository: its head, its composer and its views. */
export function RepositoryPane({
	page,
	view,
	launching = false,
	items,
	filters,
	onFilters,
	machines,
}: RepositoryPaneProps) {
	const github = useGithub();
	const { platform } = useApp();
	const { access } = page;
	const name = page.name ?? `Repository ${page.id}`;
	const launchable = access.state !== "unusable";
	const pulls = page.sessions === null ? null : openPulls(page.sessions, page.id);
	const offersItems = Boolean(platform.info?.items);
	const record = page.view?.readiness.latest?.record;
	const tab = view === "agents" || view === "items" ? view : "overview";
	const aside = view === "pulls" || view === "settings" ? view : null;
	const slash = page.name?.indexOf("/") ?? -1;
	const owner = page.name !== null && slash > 0 ? page.name.slice(0, slash) : null;
	const short = page.name !== null && slash > 0 ? page.name.slice(slash + 1) : name;
	const now = useNow(15_000);

	useEffect(() => {
		document.title = `${page.name ?? "Repository"}${view === "settings" ? " · Settings" : view === "pulls" ? " · Pull requests" : ""} · Windlass`;
	}, [page.name, view]);

	return (
		<main className="home usage repo ws-pane">
			<header className="ws-head">
				<div className="ws-head-main">
					{owner ? (
						<p className="ws-owner">
							<RepoIcon size={13} />
							{owner}
						</p>
					) : null}
					<h1 className="ws-title">{short}</h1>
					{page.name === null && page.view !== null ? (
						<p className="home-account">
							Nothing here says what it is called: no agent of yours is on it, and GitHub was not heard on it. {page.id}{" "}
							is GitHub's number for it.
						</p>
					) : null}
					<StatusLine page={page} items={items} />
					{record &&
						(record.note || page.view?.readiness.switchNote || offered(record, page.view!.defaults).length > 0) && (
							<p className="usage-note">
								{record.note} {page.view?.readiness.switchNote}{" "}
								{offered(record, page.view!.defaults).length > 0 && (
									<a
										className="link"
										{...(tab === "overview" && !aside
											? { href: "#repo-setup" }
											: linkProps({ name: "repository", id: page.id }))}
									>
										Review earned settings in Repo setup
									</a>
								)}
							</p>
						)}
					<AccessLine page={page} github={github} />
				</div>
				<div className="ws-head-actions">
					<a
						className={`button button-outline button-small${view === "pulls" ? " ws-head-current" : ""}`}
						aria-current={view === "pulls" ? "page" : undefined}
						{...linkProps({ name: "repository", id: page.id, view: "pulls" })}
					>
						<PullRequestIcon size={13} />
						Pull requests
						{pulls && pulls.length > 0 ? <span className="ws-head-count">{pulls.length}</span> : null}
					</a>
					<a
						className={`button button-outline button-small${view === "settings" ? " ws-head-current" : ""}`}
						aria-current={view === "settings" ? "page" : undefined}
						{...linkProps({ name: "repository", id: page.id, view: "settings" })}
					>
						<SlidersIcon size={13} />
						Saved settings
					</a>
				</div>
			</header>

			<AccessNotice page={page} github={github} />

			{page.connection === "reconnecting" ? (
				<p className="callout callout-warn" role="status">
					<WarnIcon />
					<span>The connection dropped. Reconnecting; the agents below may be behind.</span>
				</p>
			) : null}

			{aside !== null ? (
				<>
					<p className="ws-back">
						<a className="link" {...linkProps({ name: "repository", id: page.id })}>
							<ArrowLeftIcon size={12} />
							Back to the overview
						</a>
					</p>
					{aside === "settings" ? <RepositorySettings page={page} /> : <Pulls page={page} now={now} />}
				</>
			) : (
				<>
					{launchable ? (
						<section className="home-start ws-start" aria-label={`Launch an agent on ${name}`}>
							<StartComposer key={page.id} sessions={page.sessions} repositoryId={page.id} autoFocus={launching} />
						</section>
					) : null}
					<div className="ws-tabs-row">
						<Tabs
							id="repo-views"
							label={name}
							selected={tab}
							tabs={[
								{ key: "overview", label: "Overview", route: { name: "repository", id: page.id } },
								{
									key: "agents",
									label: (
										<TabCount word="Agents" count={page.sessions === null ? null : ownAgents(page.sessions).length} />
									),
									route: { name: "repository", id: page.id, view: "agents" },
								},
								...(offersItems
									? [
											{
												key: "items",
												label: (
													<TabCount word="Work items" count={feedCounts(items.feed, { repository: page.id }).total} />
												),
												route: { name: "repository", id: page.id, view: "items" } as const,
											},
										]
									: []),
							]}
						/>
						<FilterBar filters={filters} onChange={onFilters} machines={machines} />
					</div>
					<TabPanel id="repo-views" selected={tab}>
						{tab === "overview" ? (
							<>
								<RepositorySetupChecks key={page.id} page={page} offersItems={offersItems} />
								<AgentsSection page={page} filters={filters} limit={OVERVIEW_AGENTS} overview />
								<ItemsOverview page={page} items={items} filters={filters} />
							</>
						) : tab === "agents" ? (
							<AgentsSection page={page} filters={filters} limit={LONE_GROUP_SHOWN} overview={false} />
						) : (
							<>
								<RepositoryItems
									repositoryId={page.id}
									name={name}
									base={access.state === "usable" ? access.repository.defaultBranch : null}
									launchable={launchable}
									now={now}
									filter={item => matchesItem(item, filters)}
								/>
							</>
						)}
					</TabPanel>
				</>
			)}
		</main>
	);
}

/** How many agents the overview shows before the rest is folded away. */
const OVERVIEW_AGENTS = 5;

function TabCount({ word, count }: { word: string; count: number | null }) {
	return (
		<>
			{word}
			{count !== null && count > 0 ? <span className="ws-tab-count">{count}</span> : null}
		</>
	);
}
