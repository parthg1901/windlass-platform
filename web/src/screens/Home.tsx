/**
 * The Agents home's right side when no one repository is chosen (screens/Workspace.tsx): "Everything",
 * or with `scope` "none" the agents on no repository of the GitHub connection.
 *
 * At the top the start composer (components/StartComposer.tsx): a task and Enter launch an agent.
 * Without agents, the composer is the empty page's one action. Under it one feed (lib/feed.ts,
 * components/Feed.tsx): what needs its person, what is at work, and the rest, each newest first, the
 * user's agents and their work items together. The repository is a quiet label on each row; the rail
 * is where repositories are chosen, so a repository with nothing on it has no place here.
 *
 * The sessions of work items are not listed: each is part of its item, and is opened from the item's
 * row and page. The count of what is at work is the server's, against the ceiling on running turns,
 * and says how much of it is work items'.
 *
 * The filters of the home (lib/workspace.ts) narrow the feed; they are set from the Recent heading.
 */
import { periodWords, minutes, monthReset } from "../lib/hosted";
import { HostedNotice } from "../components/Plan";
import {
	USAGE_LOW_SHARE,
	type ItemSummary,
	type MachineSummary,
	type SavedRepository,
	type SessionSummary,
	type UsageNumbers,
} from "@contract";
import { useEffect, useState } from "react";
import { FeedSection } from "../components/Feed";
import { Mark, WarnIcon } from "../components/Icons";
import { OnboardingGate } from "../components/Onboarding";
import { StartComposer } from "../components/StartComposer";
import { FilterBar } from "../components/WorkspaceFilters";
import { useIdentity } from "../lib/identity";
import { feedOf } from "../lib/feed";
import { count, localTime, plural, sandboxTime } from "../lib/format";
import { ownAgents, workingCounts, workingWords } from "../lib/repositories";
import { linkProps } from "../lib/router";
import { filterCount, type Filters } from "../lib/workspace";
import { useApp, useAuth } from "../state/app";
import { asking } from "../lib/items";
import { allowanceState, useChatgpt, useFactoryLimits, useNow, type SessionsState } from "../state/hooks";
import { LoadError, SkeletonRows } from "../components/ui";

/** The repositories something is saved for: asked when the screen opens and when a session is added or deleted. Empty until they arrive, or where they could not be read. */
export function useSavedRepositories(sessions: readonly SessionSummary[] | null): SavedRepository[] {
	const { client } = useApp();
	const auth = useAuth();
	const [saved, setSaved] = useState<SavedRepository[]>([]);
	const known = sessions?.length ?? -1;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `known` is not read here; a change of it is when to ask again
	useEffect(() => {
		let current = true;
		client
			.user(auth)
			.savedRepositories()
			.then(
				list => current && setSaved(list),
				// The list of agents does not depend on it: without it, the line is left out.
				() => current && setSaved([]),
			);
		return () => {
			current = false;
		};
	}, [client, auth, known]);
	return saved;
}

function AccountLine() {
	const auth = useAuth();
	const { status } = useChatgpt();
	const identity = useIdentity();
	if (auth.profile.demo) {
		return (
			<p className="home-account">
				<span className="chip chip-warn">demo</span>
				Signed in as a demo user. Its agents run a scripted model with real tool calls.
			</p>
		);
	}
	return (
		<p className="home-account">
			<span className="home-account-who">{identity.name}</span>
			{status === null ? (
				<span className="tone-faint">checking ChatGPT…</span>
			) : status.connected ? (
				<span className="home-account-ok">ChatGPT connected</span>
			) : (
				<span className="tone-faint">
					ChatGPT not connected ·{" "}
					<a className="link" {...linkProps({ name: "connections", section: "plan-openai" })}>
						Connect
					</a>
				</span>
			)}
		</p>
	);
}

/**
 * The day's sandbox time as a small meter, and the sandboxes kept, leading to the usage page. It takes
 * the warning hue when the day's time runs low or out, or no more sandboxes may be kept.
 */
export function UsageMeter({ numbers }: { numbers: UsageNumbers | null }) {
	if (numbers === null) return null;
	if (numbers.hosted) return <MonthMeter numbers={numbers} />;
	const { allowanceSeconds, leftSeconds, sandboxes } = numbers;
	const spent = numbers.usedSeconds + numbers.heldSeconds;
	const state = allowanceState(numbers, USAGE_LOW_SHARE);
	const full = sandboxes.limit !== null && sandboxes.kept >= sandboxes.limit;
	const share = allowanceSeconds === null || allowanceSeconds === 0 ? null : Math.min(1, spent / allowanceSeconds);
	const kept =
		sandboxes.limit === null
			? plural(sandboxes.kept, "sandbox kept", "sandboxes kept")
			: `${count(sandboxes.kept)} of ${count(sandboxes.limit)} kept sandboxes`;
	return (
		<a
			className={`home-usage${state !== "plenty" ? " home-usage-warn" : ""}`}
			{...linkProps({ name: "usage" })}
			title="Hosted time and kept sandboxes"
		>
			<span className="home-usage-time">
				Hosted time today <strong>{sandboxTime(spent)}</strong>
				{allowanceSeconds === null ? null : ` of ${sandboxTime(allowanceSeconds)}`}
				{state !== "plenty" && leftSeconds !== null ? (
					<span className="home-usage-left">
						{state === "used" ? `, used up until ${localTime(numbers.resetsAt)}` : `, ${sandboxTime(leftSeconds)} left`}
					</span>
				) : null}
			</span>
			{share === null ? null : (
				<span
					className="home-meter"
					role="meter"
					aria-label="Hosted time used today"
					aria-valuemin={0}
					aria-valuemax={allowanceSeconds ?? 0}
					aria-valuenow={Math.min(spent, allowanceSeconds ?? spent)}
					aria-valuetext={`${sandboxTime(spent)} of ${sandboxTime(allowanceSeconds ?? 0)}`}
				>
					<span className="home-meter-fill" style={{ width: `${Math.max(share, spent > 0 ? 0.04 : 0) * 100}%` }} />
				</span>
			)}
			<span className={full ? "home-usage-full" : undefined}>
				{kept}
				{full ? <span className="visually-hidden"> (the most an account may keep)</span> : null}
			</span>
		</a>
	);
}

/** The month's hosted minutes as the small meter, where a plan sets them (lib/hosted.ts). */
function MonthMeter({ numbers }: { numbers: UsageNumbers }) {
	const month = numbers.hosted!;
	const spent = month.usedSeconds + month.heldSeconds;
	const state = allowanceState(numbers, USAGE_LOW_SHARE);
	const { sandboxes } = numbers;
	const full = sandboxes.limit !== null && sandboxes.kept >= sandboxes.limit;
	const share = month.limitSeconds === 0 ? null : Math.min(1, spent / month.limitSeconds);
	return (
		<a
			className={`home-usage${state !== "plenty" ? " home-usage-warn" : ""}`}
			{...linkProps({ name: "usage" })}
			title="Hosted time and kept sandboxes"
		>
			<span className="home-usage-time">
				Hosted {periodWords(month)} <strong>{minutes(spent)}</strong> of {minutes(month.limitSeconds)} min
				{state !== "plenty" ? (
					<span className="home-usage-left">
						{state === "used" ? `, used up until ${monthReset(month)}` : `, ${minutes(month.leftSeconds)} left`}
					</span>
				) : null}
			</span>
			{share === null ? null : (
				<span
					className="home-meter"
					role="meter"
					aria-label={`Hosted time used ${periodWords(month)}`}
					aria-valuemin={0}
					aria-valuemax={month.limitSeconds}
					aria-valuenow={Math.min(spent, month.limitSeconds)}
					aria-valuetext={`${minutes(spent)} of ${minutes(month.limitSeconds)} min of hosted time`}
				>
					<span className="home-meter-fill" style={{ width: `${Math.max(share, spent > 0 ? 0.04 : 0) * 100}%` }} />
				</span>
			)}
			<span className={full ? "home-usage-full" : undefined}>
				{sandboxes.limit === null
					? plural(sandboxes.kept, "sandbox kept", "sandboxes kept")
					: `${count(sandboxes.kept)} of ${count(sandboxes.limit)} kept sandboxes`}
			</span>
		</a>
	);
}

/** What the page holds at a glance: how many agents, how many at work, and how many wait on their user. */
function Facts({
	agents,
	counts,
	ceiling,
	waiting,
}: {
	agents: number | null;
	counts: ReturnType<typeof workingCounts>;
	ceiling: number | null;
	waiting: number;
}) {
	const sep = <span className="visually-hidden">, </span>;
	const working = counts.ceilinged + counts.onMachines;
	return (
		<p className="home-facts">
			<span>
				<strong>{agents === null ? "–" : count(agents)}</strong> {agents === 1 ? "agent" : "agents"}
			</span>
			{sep}
			<span className={`home-fact${working > 0 ? " home-fact-working" : ""}`}>{workingWords(counts, ceiling)}</span>
			{counts.onMachines > 0 ? (
				<>
					{sep}
					<span className="home-fact home-fact-working">{counts.onMachines}&nbsp;on&nbsp;your&nbsp;machines</span>
				</>
			) : null}
			{waiting > 0 ? (
				<>
					{sep}
					<span className="home-fact home-fact-needs">
						{waiting} {waiting === 1 ? "needs" : "need"} you
					</span>
				</>
			) : null}
		</p>
	);
}

export interface HomeProps {
	/** The user's sessions, live, as the home reads them once for the rail and this side both. */
	state: SessionsState;
	/** The user's work items, read once for the page and the bar (null until they arrive; none where the deployment offers none). */
	items: readonly ItemSummary[] | null;
	usage: UsageNumbers | null;
	/** "none": the agents on no repository of the GitHub connection alone. */
	scope?: "all" | "none";
	filters: Filters;
	onFilters(filters: Filters): void;
	machines: readonly MachineSummary[];
	/** The first-run setup is on the page: the header's counts, ChatGPT line and meter are left out, having nothing in them yet. */
	firstRun?: boolean;
	onFirstRun?(showing: boolean): void;
}

export function Home({
	state,
	items,
	usage,
	scope = "all",
	filters,
	onFilters,
	machines,
	firstRun = false,
	onFirstRun,
}: HomeProps) {
	const { sessions, connection, error } = state;
	const { platform } = useApp();
	const now = useNow(15_000);
	const filtering = filterCount(filters) > 0;
	const agents = sessions === null ? null : ownAgents(sessions);
	// The ceiling is the deployment's, on hosted sandboxes: the user's agents and work items on the platform's sandboxes count against it, never a machine's.
	const ceiling = useFactoryLimits().value?.hostedRunning ?? null;
	const counts = workingCounts(sessions ?? []);
	const waiting = agents?.filter(session => session.status === "waiting").length ?? 0;
	const asked = asking(items ?? []).length;
	const feed = feedOf({ sessions, items, filters, scope });
	const total = feed.needs.length + feed.working.length + feed.recent.length;
	// Without agents or work items the composer stands in the empty page; otherwise at the top, over the feed.
	const empty =
		sessions !== null &&
		connection !== "failed" &&
		(agents?.length ?? 0) === 0 &&
		(scope === "none" || (items ?? []).length === 0) &&
		!filtering;

	return (
		<main className="home home-agents ws-pane">
			{firstRun ? null : (
				<header className="home-head">
					<div className="home-title">
						<h1 className="display">{scope === "none" ? "No repository" : "Agents"}</h1>
						<Facts
							agents={agents === null ? null : agents.length}
							counts={counts}
							ceiling={ceiling}
							waiting={waiting + asked}
						/>
						<AccountLine />
					</div>
					<div className="ws-head-usage">
						<UsageMeter numbers={usage} />
					</div>
				</header>
			)}
			<HostedNotice numbers={usage} pro={platform.info?.billing?.plans.find(plan => plan.id === "pro") ?? null} />

			{empty ? null : (
				<section className="home-start" aria-label="Launch an agent">
					<StartComposer sessions={sessions} hostedNotice />
				</section>
			)}

			{connection === "reconnecting" ? (
				<p className="callout callout-warn" role="status">
					<WarnIcon />
					<span>The connection dropped. Reconnecting; the list may be behind.</span>
				</p>
			) : null}

			{connection === "failed" ? (
				<LoadError
					level={2}
					subject="The list of agents"
					error={error?.message ?? "The server could not be reached."}
					reload={() => location.reload()}
				/>
			) : sessions === null ? (
				<SkeletonRows variant="agent" label="Loading agents" rows={4} />
			) : empty ? (
				<OnboardingGate
					// The setup opens on "Everything" only, never on the agents on no repository.
					sessions={scope === "none" ? 1 : (agents?.length ?? null)}
					items={items === null ? null : items.length}
					machines={machines}
					onShowing={onFirstRun}
				>
					<div className="state state-empty home-empty">
						<Mark size={56} />
						<h2>No agents yet</h2>
						<p>Say what it should do and press Enter. Where it runs and the repository are under the field.</p>
						<StartComposer sessions={sessions} autoFocus hostedNotice />
					</div>
				</OnboardingGate>
			) : (
				<div className="home-feed">
					<FeedSection title="Needs you" tone="needs" entries={feed.needs} now={now} />
					<FeedSection title="Working now" tone="working" entries={feed.working} now={now} />
					<FeedSection
						title="Recent"
						tone="recent"
						entries={feed.recent}
						now={now}
						limit={12}
						tools={<FilterBar filters={filters} onChange={onFilters} machines={machines} />}
						empty={
							filtering
								? total === 0
									? "Nothing here matches the filters."
									: "Nothing else matches the filters."
								: scope === "none"
									? "No agent of yours is on no repository."
									: "Nothing has ended yet."
						}
					/>
				</div>
			)}
		</main>
	);
}
