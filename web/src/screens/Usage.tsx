import { HostedNotice, MonthFigure } from "../components/Plan";
import { monthName, monthReset } from "../lib/hosted";
import { USAGE_HISTORY_DAYS, type HostedSize, type KeptSandbox, type SessionSummary, type UsageView } from "@contract";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "../components/Dialog";
import { FoldRows } from "../components/Fold";
import { FactoryUsage } from "../components/FactoryUsage";
import { CostSummary } from "../components/CostSummary";
import { CostFigure } from "../components/CostFigure";
import { todayCostWords } from "../lib/cost";
import { MachineUsage } from "../components/MachineUsage";
import { WarnIcon } from "../components/Icons";
import { moveBetweenTabs } from "../components/Tabs";
import { SandboxState } from "../components/Status";
import {
	absoluteTime,
	compact,
	count,
	localTime,
	plural,
	relativeTime,
	sandboxClock,
	sandboxTime as spelledTime,
	usd,
	utcDay,
} from "../lib/format";
import { linkProps } from "../lib/router";
import { perHour, sizeName, sizeSpec } from "../lib/sizes";
import { useApp, useAuth } from "../state/app";
import { useCostRates, useNow } from "../state/hooks";
import { readTwice } from "../lib/retry";

/** A length of sandbox time in a sentence: the number and its unit stay on one line. */
const sandboxTime = (seconds: number) => spelledTime(seconds).replace(/ /g, "\u00a0");

function useUsage(): {
	view: UsageView | null;
	error: string | null;
	items: Map<string, string> | null;
	reload(): void;
	replace(view: UsageView): void;
} {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [view, setView] = useState<UsageView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
	const reading = useRef(false);
	const again = useRef(false);

	const read = useCallback(() => {
		// One reading at a time: a change that comes meanwhile is read after it.
		if (reading.current) {
			again.current = true;
			return;
		}
		reading.current = true;
		readTwice(() => client.user(auth).usage())
			.then(
				value => {
					setView(value);
					setError(null);
				},
				(failure: unknown) => setError(explain(failure)),
			)
			.finally(() => {
				reading.current = false;
				if (again.current) {
					again.current = false;
					read();
				}
			});
	}, [client, auth, explain]);

	useEffect(() => {
		read();
		const timer = setInterval(read, 60_000);
		const close = client.user(auth).watch({ onSessions: setSessions, onUsage: read });
		return () => {
			clearInterval(timer);
			close();
		};
	}, [client, auth, read]);

	// Builder and reviewer sessions are charged to their work item in the daily table.
	const items = sessions === null ? null : new Map<string, string>();
	for (const session of sessions ?? []) {
		if (!session.item) continue;
		items?.set(session.id, session.item.id);
		if (session.item.reviewer) items?.set(session.item.reviewer.id, session.item.id);
	}
	return { view, error, items, reload: read, replace: setView };
}

/** What freeing a sandbox takes with it and what it leaves, for the agent it belongs to. */
function FreeDialog({
	sandbox,
	memory,
	onClose,
	onFreed,
}: {
	sandbox: KeptSandbox;
	memory: UsageView["memory"];
	onClose(): void;
	onFreed(view: UsageView): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const free = async () => {
		setBusy(true);
		setError(null);
		try {
			onFreed(await client.user(auth).freeSandbox(sandbox.sessionId));
			onClose();
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	};

	return (
		<Dialog
			title="Free this sandbox?"
			size="small"
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Keep it
					</button>
					<button type="button" className="button button-danger" onClick={free} disabled={busy}>
						{busy ? "Freeing…" : "Free sandbox"}
					</button>
				</>
			}
		>
			{sandbox.title === null ? (
				<p>
					This sandbox was left behind by an agent that no longer exists. Nothing uses it; freeing it removes it with
					the files in it.
				</p>
			) : (
				<>
					<p>
						The sandbox of <strong>{sandbox.title}</strong> is removed to make room for another. The agent itself stays.
					</p>
					<dl className="usage-ledger">
						<dt>Lost</dt>
						<dd>
							{sandbox.repository === null
								? "Every file in its workspace: what it wrote, installed and built. It has no repository at GitHub, so none of it comes back."
								: "Every file in its workspace that is not on GitHub: changes that were not committed, commits that were not pushed, installed dependencies, anything it built. "}
							{sandbox.repository === null
								? null
								: sandbox.pushed
									? `What was pushed to ${sandbox.repository} is cloned again into its next sandbox.`
									: `Nothing of its work was pushed to ${sandbox.repository}, so its next sandbox starts from the repository as GitHub has it.`}
						</dd>
						{memory === "lost" ? (
							<dd>
								The agent's own memory of the conversation: this deployment keeps it in the sandbox only, so the agent
								starts its next turn without it.
							</dd>
						) : null}
						<dt>Kept</dt>
						<dd>The agent and its conversation, as you see them here.</dd>
						{memory === "lost" ? null : (
							<dd>The agent's own memory of the conversation. It is told that its workspace is a new one.</dd>
						)}
					</dl>
					<p>Its next prompt starts a new sandbox. This cannot be undone.</p>
				</>
			)}
			{error ? (
				<p className="callout callout-bad" role="alert">
					<WarnIcon />
					<span>{error}</span>
				</p>
			) : null}
		</Dialog>
	);
}

/** Today's allowance as a bar: what was counted, what running sandboxes hold, and what is left. */
function Meter({ view }: { view: UsageView }) {
	const allowance = view.allowanceSeconds;
	if (allowance === null) return null;
	const spent = view.usedSeconds + view.heldSeconds;
	const share = (seconds: number) => `${Math.min(100, (seconds / Math.max(allowance, spent)) * 100)}%`;
	return (
		<div
			className="usage-meter"
			role="meter"
			aria-label="Hosted time used or held today"
			aria-valuemin={0}
			aria-valuemax={allowance}
			aria-valuenow={Math.min(allowance, spent)}
			aria-valuetext={`${sandboxTime(spent)} of ${sandboxTime(allowance)}`}
		>
			{view.usedSeconds > 0 ? <span className="usage-meter-used" style={{ width: share(view.usedSeconds) }} /> : null}
			{view.heldSeconds > 0 ? <span className="usage-meter-held" style={{ width: share(view.heldSeconds) }} /> : null}
		</div>
	);
}

export function Usage() {
	const { platform } = useApp();
	const { view, error, items, reload, replace } = useUsage();
	const rates = useCostRates();
	const now = useNow(15_000);
	const [showHeld, setShowHeld] = useState(false);
	const [freeing, setFreeing] = useState<KeptSandbox | null>(null);
	const [tab, setTab] = useState(() => location.hash.slice(1));
	useEffect(() => {
		const follow = () => setTab(location.hash.slice(1));
		addEventListener("hashchange", follow);
		return () => removeEventListener("hashchange", follow);
	}, []);

	function chooseTab(id: string) {
		setTab(id);
		history.replaceState(history.state, "", id === "usage-agents" ? location.pathname + location.search : `#${id}`);
	}

	if (view === null) {
		return (
			<main className="home usage">
				<header className="home-head">
					<div>
						<p className="eyebrow">usage</p>
						<h1 className="display">Usage</h1>
					</div>
				</header>
				{error ? (
					<div className="state state-error" role="alert">
						<WarnIcon size={22} />
						<h2>Your usage could not be loaded</h2>
						<p>{error}</p>
						<button type="button" className="button button-outline" onClick={reload}>
							Try again
						</button>
					</div>
				) : (
					<div className="usage-loading" aria-busy="true" aria-label="Loading your usage">
						<span className="skeleton skeleton-title" style={{ width: "34%" }} />
						<span className="skeleton skeleton-meta" style={{ width: "100%" }} />
						<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
						<span className="skeleton skeleton-meta" style={{ width: "46%" }} />
					</div>
				)}
			</main>
		);
	}

	const allowance = view.allowanceSeconds;
	const left = view.leftSeconds;
	const price = view.price;
	// Single-size deployments use the rate on the usage view for every row.
	const sizes = view.hostedSizes && view.hostedSizes.length > 1 ? view.hostedSizes : null;
	const rate = (size?: HostedSize) => {
		const hourly = size && sizes?.find(one => one.id === size)?.usdPerHour;
		return typeof hourly === "number" ? hourly / 3600 : (price?.usdPerSecond ?? 0);
	};
	const estimatedCost = (rows: UsageView["today"], seconds: number) => {
		if (price === null) return null;
		return sizes
			? rows.reduce((sum, row) => sum + row.seconds * rate(row.hostedSize), 0)
			: seconds * price.usdPerSecond;
	};
	const todayUsd = estimatedCost(view.today, view.usedSeconds);
	const running = view.today.filter(row => row.heldSeconds > 0).length;
	const { kept, limit } = view.sandboxes;
	const historyTotal = view.days.reduce((sum, day) => sum + day.seconds, 0);
	const resets = localTime(view.resetsAt);
	// A viewer whose own time is UTC is told the hour once.
	const abroad = new Date(view.resetsAt).getTimezoneOffset() !== 0;
	const untilReset = sandboxTime(Math.max(60, Math.ceil((view.resetsAt - now) / 60_000) * 60));

	const keptCount = limit === null ? count(kept) : `${count(kept)} of ${count(limit)}`;
	const tabs = [
		{ id: "usage-agents", label: "Today by agent" },
		...(platform.info?.items
			? [
					{ id: "usage-items", label: "Work items" },
					{ id: "usage-summary", label: "Summary" },
				]
			: []),
		{ id: "usage-kept", label: "Kept sandboxes", count: keptCount },
		...(platform.info?.machines ? [{ id: "usage-machines", label: "My machines" }] : []),
		{ id: "usage-history", label: `Last ${USAGE_HISTORY_DAYS} days` },
	];
	const shown = tabs.some(one => one.id === tab) ? tab : "usage-agents";
	// The figures at the top in whole cents; the tables keep their finer amounts.
	const cents = (amount: number) => `$${amount.toFixed(2)}`;
	const leftWords =
		left === null
			? "No daily limit"
			: left < view.startSeconds
				? left === 0
					? "None left"
					: `${sandboxTime(left)} left, too little for a turn`
				: `${sandboxTime(left)} left`;

	let panel: ReactNode;
	if (shown === "usage-agents") {
		const unreported = view.today.reduce((sum, row) => sum + row.unreportedSeconds, 0);
		const agentRows = view.today.filter(row => !items?.has(row.sessionId));
		const itemRows = view.today.filter(row => items?.has(row.sessionId));
		const itemTotal = itemRows.reduce(
			(sum, row) => ({
				seconds: sum.seconds + row.seconds,
				held: sum.held + row.heldSeconds,
				unreported: sum.unreported + row.unreportedSeconds,
			}),
			{ seconds: 0, held: 0, unreported: 0 },
		);
		const itemCost = estimatedCost(itemRows, itemTotal.seconds);
		panel = (
			<>
				{view.today.length === 0 ? (
					<p className="usage-empty">No sandbox has run today.</p>
				) : (
					<table className="usage-table">
						<thead>
							<tr>
								<th scope="col">Agent</th>
								<th scope="col" className="usage-number">
									Used
								</th>
								<th scope="col" className="usage-number" hidden={!showHeld}>
									Held
								</th>
								{price && (
									<th scope="col" className="usage-number">
										Est. cost
									</th>
								)}
							</tr>
						</thead>
						<tbody>
							{agentRows.map(row => (
								<UsageRow
									key={row.sessionId}
									seconds={row.seconds}
									held={row.heldSeconds}
									showHeld={showHeld}
									cost={price ? row.seconds * rate(row.hostedSize) : null}
									estimated={row.unreportedSeconds > 0}
								>
									{row.title === null ? (
										<span className="tone-dim">an agent that was deleted</span>
									) : (
										<a className="usage-agent" {...linkProps({ name: "session", id: row.sessionId })}>
											{row.title}
										</a>
									)}
									{sizes && row.hostedSize ? <span className="usage-size-tag">{sizeName(row.hostedSize)}</span> : null}
								</UsageRow>
							))}
							{itemRows.length > 0 ? (
								<UsageRow
									seconds={itemTotal.seconds}
									held={itemTotal.held}
									showHeld={showHeld}
									cost={itemCost}
									estimated={itemTotal.unreported > 0}
								>
									<a
										className="usage-agent"
										href="#usage-items"
										onClick={event => {
											event.preventDefault();
											chooseTab("usage-items");
										}}
									>
										{plural(new Set(itemRows.map(row => items?.get(row.sessionId))).size, "work item")}
									</a>
								</UsageRow>
							) : null}
						</tbody>
						<tfoot>
							<UsageRow seconds={view.usedSeconds} held={view.heldSeconds} showHeld={showHeld} cost={todayUsd}>
								Today
							</UsageRow>
						</tfoot>
					</table>
				)}
				<div className="usage-panel-notes">
					{unreported > 0 ? <p className="usage-note">* Includes up to {sandboxTime(unreported)} estimated.</p> : null}
					{view.today.length > 0 ? (
						<button
							type="button"
							className="link usage-panel-toggle"
							aria-pressed={showHeld}
							onClick={() => setShowHeld(on => !on)}
						>
							{showHeld ? "Hide held time" : "Show held time"}
						</button>
					) : null}
				</div>
			</>
		);
	} else if (shown === "usage-kept") {
		panel = (
			<>
				<p className="usage-lede">
					{limit === null ? "Your hosted workspaces, running or paused." : "Free one to make room for more agents."}
				</p>
				{view.kept.length === 0 ? (
					<p className="usage-empty">You keep no sandbox.</p>
				) : (
					<FoldRows items={view.kept} shown={8}>
						{(rows, id) => (
							<ul className="usage-kept" id={id}>
								{rows.map(sandbox => {
									const item = items?.get(sandbox.sessionId);
									return (
										<li key={sandbox.sessionId} className="usage-kept-row">
											<div className="usage-kept-main">
												{sandbox.title === null ? (
													<span className="usage-kept-title tone-dim">
														Left behind by an agent that no longer exists
													</span>
												) : (
													<a
														className="usage-kept-title usage-agent"
														{...linkProps(
															item ? { name: "item", id: item } : { name: "session", id: sandbox.sessionId },
														)}
													>
														{sandbox.title}
													</a>
												)}
												<p className="agent-meta">
													{item ? <span>work item</span> : null}
													{sizes && sandbox.hostedSize ? (
														<span>
															{`${sizeName(sandbox.hostedSize)}, ${perHour(sizes.find(one => one.id === sandbox.hostedSize)?.usdPerHour) ?? ""}`.replace(
																/, $/,
																"",
															)}{" "}
															while running
														</span>
													) : null}
													{sandbox.repository ? (
														<span className="agent-repo">{sandbox.repository}</span>
													) : (
														<span>no repository at GitHub</span>
													)}
													{sandbox.repository ? <span>{sandbox.pushed ? "work pushed" : "nothing pushed"}</span> : null}
													{sandbox.usedAt !== null ? (
														<span title={absoluteTime(sandbox.usedAt)}>used {relativeTime(sandbox.usedAt, now)}</span>
													) : null}
												</p>
											</div>
											{sandbox.state === "starting" ? (
												<span className="sandbox-state">being made</span>
											) : (
												<SandboxState state={sandbox.state} />
											)}
											<button
												type="button"
												className="button button-outline button-small"
												onClick={() => setFreeing(sandbox)}
												disabled={sandbox.busy || sandbox.state === "starting"}
												title={sandbox.busy ? "It is working: stop its turn first" : undefined}
											>
												{sandbox.busy ? "Working" : "Free…"}
											</button>
										</li>
									);
								})}
							</ul>
						)}
					</FoldRows>
				)}
			</>
		);
	} else if (shown === "usage-history") {
		const most = Math.max(allowance ?? 0, ...view.days.map(day => day.seconds), 1);
		panel = (
			<>
				<table className="usage-table usage-history">
					<thead>
						<tr>
							<th scope="col">Day</th>
							<th scope="col" aria-hidden="true" />
							<th scope="col" className="usage-number">
								Hosted time
							</th>
							{price && (
								<th scope="col" className="usage-number">
									Est. cost
								</th>
							)}
						</tr>
					</thead>
					<tbody>
						{[...view.days].reverse().map(day => {
							const today = day.day === view.day;
							const atLimit = allowance !== null && day.seconds >= allowance;
							return (
								<tr key={day.day} className={today ? "usage-day-today" : undefined}>
									<th scope="row">
										{utcDay(day.day)}
										{today ? (
											<span className="usage-day-note">today so far</span>
										) : atLimit ? (
											<span className="usage-day-note">at the limit</span>
										) : null}
									</th>
									<td className="usage-bar-cell" aria-hidden="true">
										{day.seconds > 0 ? (
											<span className="usage-bar" style={{ width: `${Math.max(1, (day.seconds / most) * 100)}%` }} />
										) : null}
									</td>
									<td className="usage-number">
										{day.seconds === 0 ? <span className="tone-faint">0:00:00</span> : sandboxClock(day.seconds)}
									</td>
									{price === null ? null : (
										<td className="usage-number">
											{day.seconds === 0 ? (
												<span className="tone-faint">–</span>
											) : (
												usd(day.seconds * price.usdPerSecond)
											)}
										</td>
									)}
								</tr>
							);
						})}
					</tbody>
					<tfoot>
						<tr>
							<th scope="row">{USAGE_HISTORY_DAYS} days</th>
							<td />
							<td className="usage-number">{sandboxClock(historyTotal)}</td>
							{price === null ? null : <td className="usage-number">{usd(historyTotal * price.usdPerSecond)}</td>}
						</tr>
					</tfoot>
				</table>
				<p className="usage-note">
					UTC days{abroad ? `, ending at ${resets} your time` : ""}.
					{sizes && price !== null ? " Earlier days are priced at the small size." : ""}
				</p>
			</>
		);
	} else if (shown === "usage-items") {
		panel = <FactoryUsage value={view.factoryLimits} />;
	} else if (shown === "usage-summary") {
		panel = <CostSummary />;
	} else {
		panel = <MachineUsage />;
	}

	return (
		<main className="home usage">
			<header className="home-head">
				<div>
					<p className="eyebrow">The day ends {resets}</p>
					<h1 className="display">Usage</h1>
				</div>
			</header>

			{error ? (
				<p className="callout callout-warn" role="status">
					<WarnIcon />
					<span>
						{error}{" "}
						<button className="link" onClick={reload}>
							Try again
						</button>
					</span>
				</p>
			) : null}

			{view.hosted ? (
				<HostedNotice numbers={view} pro={platform.info?.billing?.plans.find(plan => plan.id === "pro") ?? null} />
			) : null}

			<section className="usage-card usage-summary" aria-label="At a glance">
				<div className="usage-summary-figures">
					<div className="usage-summary-cell usage-summary-main">
						<h2 className="usage-summary-label">Hosted time today</h2>
						<p className="usage-summary-figure">
							<strong>{sandboxTime(view.usedSeconds)}</strong>
							{allowance === null ? null : <span> of {sandboxTime(allowance)}</span>}
						</p>
						<Meter view={view} />
						<p className="usage-summary-sub">
							{leftWords}
							{allowance === null ? null : <> · resets in {untilReset}</>}
						</p>
					</div>
					<div className="usage-summary-cell">
						<h2 className="usage-summary-label">Models today</h2>
						<p className="usage-summary-figure">
							<strong>{rates ? <CostFigure words={todayCostWords(view.modelsToday, rates)} /> : "…"}</strong>
						</p>
						<p className="usage-summary-sub">Work items' turns, at today's prices</p>
					</div>
					{price && todayUsd !== null ? (
						<div className="usage-summary-cell">
							<h2 className="usage-summary-label">Estimated today</h2>
							<p className="usage-summary-figure" title="Estimate">
								<strong>≈ {cents(todayUsd)}</strong>
							</p>
							<p className="usage-summary-sub">
								{cents(historyTotal * price.usdPerSecond)} in {USAGE_HISTORY_DAYS} days
							</p>
						</div>
					) : null}
				</div>
				{view.hosted ? (
					<div className="usage-summary-month">
						<h2 className="usage-summary-label">
							Hosted time{view.hosted.plan === "pro" ? "" : " this month"} · {monthName(view.hosted)}
						</h2>
						<MonthFigure month={view.hosted} />
						<p className="usage-summary-sub">
							Resets on {monthReset(view.hosted)}.
							{platform.info?.billing ? (
								<>
									{" "}
									<a className="link" {...linkProps({ name: "settings" })}>
										Manage your plan
									</a>
								</>
							) : null}
						</p>
					</div>
				) : null}
				<div className="usage-summary-foot">
					<span>
						Kept sandboxes <strong>{keptCount}</strong>
					</span>
					<span>
						Running now <strong>{count(running)}</strong>
					</span>
					<details className="usage-summary-details">
						<summary>Details</summary>
						<div className="usage-summary-more">
							<dl className="usage-facts">
								<div>
									<dt>
										<span className="usage-swatch usage-swatch-used" aria-hidden="true" />
										Counted
									</dt>
									<dd className="usage-number">{sandboxClock(view.usedSeconds)}</dd>
									<dd className="usage-gloss">what your sandboxes ran today before they stopped</dd>
								</div>
								<div>
									<dt>
										<span className="usage-swatch usage-swatch-held" aria-hidden="true" />
										Held
									</dt>
									<dd className="usage-number">{sandboxClock(view.heldSeconds)}</dd>
									<dd className="usage-gloss">
										{running === 0
											? "no sandbox is running now"
											: `for ${plural(running, "sandbox", "sandboxes")} running now; what one does not use is free again when it stops`}
									</dd>
								</div>
								<div>
									<dt>Model tokens</dt>
									<dd className="usage-number">
										{compact(view.usedModelTokens)}
										{view.factoryLimits.dailyTokens === null ? null : (
											<> of {compact(view.factoryLimits.dailyTokens)}</>
										)}
									</dd>
									<dd className="usage-gloss">
										{view.factoryLimits.dailyTokens === null
											? "on Windlass’s sign-in today; no daily cap"
											: "on Windlass’s sign-in today"}
										{view.providerTokens?.map(row => `; your ${row.provider} key: ${compact(row.tokens)}`).join("")}
									</dd>
								</div>
								{allowance !== null ? (
									<div>
										<dt>Resets</dt>
										<dd className="usage-number">{resets}</dd>
										<dd className="usage-gloss">
											in {untilReset}
											{abroad ? ", at 00:00 UTC" : ""}
										</dd>
									</div>
								) : null}
							</dl>
							{sizes ? (
								<ul className="usage-size-list" aria-label="Estimated prices">
									{sizes.map(size => (
										<li key={size.id}>
											<span className="usage-size-name">{sizeName(size.id)}</span>
											<span className="tone-dim">{sizeSpec(size.id)}</span>
											<span className="usage-number">{perHour(size.usdPerHour) ?? "–"}</span>
										</li>
									))}
								</ul>
							) : null}
						</div>
					</details>
				</div>
			</section>

			<div className="tabs usage-tabs" role="tablist" aria-label="Usage in detail" onKeyDown={moveBetweenTabs}>
				{tabs.map(({ id, label, count }) => (
					<button
						key={id}
						id={id}
						type="button"
						className="tab"
						role="tab"
						aria-selected={id === shown}
						aria-controls={id === shown ? `${id}-panel` : undefined}
						tabIndex={id === shown ? 0 : -1}
						onClick={() => chooseTab(id)}
					>
						{label}
						{count && <span className="tab-count">{count}</span>}
					</button>
				))}
			</div>

			<section className="usage-panel" role="tabpanel" id={`${shown}-panel`} aria-labelledby={shown}>
				{panel}
			</section>

			{freeing ? (
				<FreeDialog sandbox={freeing} memory={view.memory} onClose={() => setFreeing(null)} onFreed={replace} />
			) : null}
		</main>
	);
}

function UsageRow({
	children,
	seconds,
	held,
	showHeld,
	cost,
	estimated,
}: {
	children: ReactNode;
	seconds: number;
	held: number;
	showHeld: boolean;
	cost: number | null;
	estimated?: boolean;
}) {
	return (
		<tr>
			<th scope="row">
				{children}
				{estimated && (
					<span className="usage-mark" title="Includes estimated time">
						{" "}
						*
					</span>
				)}
			</th>
			<td className="usage-number">{sandboxClock(seconds)}</td>
			<td className="usage-number" hidden={!showHeld}>
				{held > 0 ? sandboxClock(held) : <span className="tone-faint">–</span>}
			</td>
			{cost !== null && <td className="usage-number">{usd(cost)}</td>}
		</tr>
	);
}
