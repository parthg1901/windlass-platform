/**
 * An agent's side panel, in six sections a user reads at a glance: the agent (its model, mode and
 * repository; its id and start times under "More"), where it runs (the place, Strict or Open and the
 * size, then three plain outcome lines, with the technical layers under "How it's isolated"), what it
 * used (cost first where its agent says it, every count and the cache per call under "Token details"),
 * the files it changed, the pull request, and the repository's setup (`RepositorySetupSection`).
 *
 * What it draws follows the session's capabilities (`SessionSummary.capabilities`), never the agent's name.
 * An agent that reports token counts per model call (`usage` "tokens", Windlass) gets the token counts and
 * the cache chart. One that reports how full its context is (`usage` "context", the ACP agents) gets that,
 * and what it has cost so far when it says, and the token counts its turns answered with once one did.
 *
 * Amber is kept for what needs the user now, with the way to fix it: an open sandbox is said in plain ink.
 */
import type {
	EgressMode,
	HostedSizeOption,
	PendingQuestion,
	SandboxProfile,
	SessionSummary,
	TurnUsage,
	WorkspaceFile,
} from "@contract";
import { Fragment, useCallback, useEffect, useState } from "react";
import { acpHarnessName, contextWords, costWords, HARNESS_NAMES, sessionModelWords } from "../lib/acp";
import { currentMode } from "../lib/modes";
import { absoluteTime, compact, count, percent, plural, shortId } from "../lib/format";
import { linkProps } from "../lib/router";
import { perHour, sizeName } from "../lib/sizes";
import { startHeadline, startLine, startRows } from "../lib/start-times";
import {
	blockedRequests,
	cachedShare,
	lastTurn,
	openStep,
	sessionUsage,
	turnNetwork,
	turnUsage,
	type ModelCall,
	type SessionView,
} from "../lib/timeline";
import { useApp, useAuth } from "../state/app";
import { useCostRates } from "../state/hooks";
import { sessionPayerRows } from "../lib/cost";
import { Dialog } from "./Dialog";
import { DiffView } from "./DiffView";
import { ContinuedRows } from "./ContinueSession";
import { ChevronIcon, RefreshIcon, WarnIcon } from "./Icons";
import { IsolationOutcomes, isolationOutcomes, Layers, ProfileFacts } from "./Layers";
import { PullRequestSection } from "./PullRequest";
import { RepositorySetupSection } from "./RepositorySetup";
import { SandboxState, StatusBadge } from "./Status";
import { AgentGlyph } from "./ui";

function Facts({ summary, profile, view }: { summary: SessionSummary; profile: SandboxProfile; view: SessionView }) {
	const id = view.windlassSessionId;
	const [showOptions, setShowOptions] = useState(false);
	const harness = acpHarnessName(summary);
	const mode = currentMode(summary, profile);
	const repository = summary.repository ?? null;
	return (
		<section className="panel-section" aria-labelledby="panel-session">
			<h2 className="panel-title" id="panel-session">
				Agent
				<span className="panel-title-aside">{summary.turns === 0 ? "no turns yet" : `turn ${summary.turns}`}</span>
				<StatusBadge status={summary.status} />
			</h2>
			<dl className="kv">
				<dt>agent</dt>
				<dd className="kv-agent">
					<AgentGlyph harness={summary.harness ?? "windlass"} />
					<span className="kv-clip">
						{harness ?? "Windlass"}
						<span className="kv-quiet"> · {sessionModelWords(summary)}</span>
					</span>
				</dd>
				<dt>mode</dt>
				<dd title={mode.description ?? undefined}>{mode.name}</dd>
				{repository ? (
					<>
						<dt>repo</dt>
						<dd className="kv-clip" title={`${repository.owner}/${repository.name}, from ${repository.branch}`}>
							<a className="kv-link" {...linkProps({ name: "repository", id: repository.id })}>
								{repository.owner}/{repository.name}
							</a>
							<span className="kv-quiet"> · {repository.branch}</span>
						</dd>
					</>
				) : summary.repoUrl ? (
					<>
						<dt>repo</dt>
						<dd className="kv-clip" title={summary.repoUrl}>
							{summary.repoUrl.replace(/^https:\/\//, "")}
						</dd>
					</>
				) : null}
				<ContinuedRows summary={summary} />
			</dl>
			<details className="panel-more">
				<summary>
					<ChevronIcon size={12} className="panel-more-chevron" />
					More
				</summary>
				<dl className="kv kv-wide">
					<dt>created</dt>
					<dd>{absoluteTime(summary.createdAt)}</dd>
					<dt>id</dt>
					<dd className="kv-mono" title={id ?? undefined}>
						{id ? (
							<code className="plain-code">{shortId(id)}</code>
						) : (
							<span className="tone-faint">{summary.turns === 0 ? "none until the first turn" : "not reported"}</span>
						)}
					</dd>
				</dl>
				<StartTimesFacts summary={summary} />
				{harness && summary.harnessModels && (
					<details className="panel-more" onToggle={event => setShowOptions(event.currentTarget.open)}>
						<summary>
							<ChevronIcon size={12} className="panel-more-chevron" />
							Models and modes it offers
						</summary>
						{showOptions && (
							<div className="panel-catalog">
								<strong>Models</strong>
								<ul aria-label="Available models">
									{summary.harnessModels.models.map(model => (
										<li key={model.id}>
											{model.name || model.id}
											{model.efforts.length > 0 && <small> · {model.efforts.join(", ")}</small>}
										</li>
									))}
								</ul>
								{summary.availableModes.length > 0 && (
									<>
										<strong>Modes</strong>
										<ul aria-label="Available modes">
											{summary.availableModes.map(one => (
												<li key={one.id} title={one.description ?? undefined}>
													{one.name}
												</li>
											))}
										</ul>
									</>
								)}
							</div>
						)}
					</details>
				)}
			</details>
		</section>
	);
}

/**
 * Under the sandbox's network fact: how many requests its egress policy refused in the current turn,
 * one line that leads to the turn's row in the timeline. Nothing when none were.
 */
export function BlockedNetworkLine({ view }: { view: SessionView }) {
	const turn = lastTurn(view);
	const network = turn ? turnNetwork(turn) : null;
	if (!turn || !network) return null;
	const requests = blockedRequests(network);
	if (requests === 0) return null;
	const target = `network-${network.seq}`;
	return (
		<p className="panel-blocked">
			<span>
				{plural(requests, "blocked network request")} in turn {turn.turn}
			</span>
			<a
				className="link"
				href={`#${target}`}
				onClick={event => {
					const row = document.getElementById(target);
					if (!row) return;
					event.preventDefault();
					row.scrollIntoView({ block: "center", behavior: "smooth" });
				}}
			>
				Show
			</a>
		</p>
	);
}

/** "Small · $0.07/h": a hosted sandbox's size and its price an hour, where the deployment offers sizes. */
function sizeWords(summary: SessionSummary, offered: readonly HostedSizeOption[] | undefined): string | null {
	if (summary.place.kind !== "hosted" || !offered?.length) return null;
	// A session made without a size runs at the smallest (agent-session.ts reserves "small").
	const size = summary.hostedSize ?? "small";
	const price = perHour(offered.find(one => one.id === size)?.usdPerHour);
	return `${sizeName(size)}${price ? ` · ${price}` : ""}`;
}

function WhereItRuns({
	summary,
	profile,
	view,
	machineName,
	egress,
}: {
	summary: SessionSummary;
	profile: SandboxProfile;
	view: SessionView;
	machineName: string | null;
	egress?: EgressMode;
}) {
	const { platform } = useApp();
	const paid = view.turns.findLast(turn => turn.end?.modelKey)?.end?.modelKey;
	const claude =
		summary.harness && summary.harness !== "windlass"
			? {
					hosted: summary.place.kind === "hosted",
					...(paid && { paidBy: paid.plan ? ("plan" as const) : ("key" as const) }),
					codex: summary.harness === "codex",
					opencode: summary.harness === "opencode",
					mode: currentMode(summary, profile),
				}
			: null;
	const size = sizeWords(summary, platform.info?.hostedSizes);
	const place = summary.place.kind === "hosted" ? "Hosted" : (machineName ?? "Your machine");
	return (
		<section className="panel-section" aria-labelledby="panel-sandbox">
			<h2 className="panel-title" id="panel-sandbox">
				Where it runs
				<SandboxState state={summary.sandbox} />
			</h2>
			<p className="panel-where">
				<span className="panel-where-place" title={place}>
					{place}
				</span>
				<span className="panel-where-profile">{profile.name}</span>
				{size ? <span className="panel-where-size">{size}</span> : null}
			</p>
			<IsolationOutcomes
				outcomes={isolationOutcomes(profile, claude, summary.place.kind === "machine" ? egress : undefined)}
			/>
			<BlockedNetworkLine view={view} />
			<details className="panel-more">
				<summary>
					<ChevronIcon size={12} className="panel-more-chevron" />
					How it's isolated
				</summary>
				<ProfileFacts profile={profile} claude={claude} />
				<Layers profile={profile} />
				{summary.environment ? (
					<p className="panel-env" title={absoluteTime(summary.environment.validatedAt)}>
						Started from a prepared environment: setup and{" "}
						{summary.environment.checks === 1 ? "the saved check" : `${summary.environment.checks} saved checks`} passed
						at <code>{summary.environment.commit.slice(0, 10)}</code>.
					</p>
				) : null}
			</details>
		</section>
	);
}

/** How long the last turn took to start, part by part, and the turns before it in one line each. */
function StartTimesFacts({ summary }: { summary: SessionSummary }) {
	const kept = summary.startTimes ?? [];
	const last = kept.at(-1);
	if (!last) return null;
	const earlier = kept.slice(0, -1).reverse();
	return (
		<details className="panel-more">
			<summary>
				<ChevronIcon size={12} className="panel-more-chevron" />
				Last start: {startHeadline(last)}
			</summary>
			<dl className="kv kv-wide" aria-label={`How turn ${last.turn} started`}>
				{startRows(last).map(row => (
					<Fragment key={row.label}>
						<dt title={row.hint}>{row.label}</dt>
						<dd>{row.value}</dd>
					</Fragment>
				))}
			</dl>
			{earlier.length > 0 && (
				<ul className="panel-start-earlier" aria-label="Earlier starts">
					{earlier.map(times => (
						<li key={times.turn}>{startLine(times)}</li>
					))}
				</ul>
			)}
		</details>
	);
}

/** Whether any turn reported its tokens: a turn of an agent that counts per call, or one that answered its prompt with them. */
const reportsTokens = (view: SessionView) => view.calls.length > 0 || view.turns.some(one => one.end?.usage != null);

/** Every token count, this agent's and its last turn's. `perCall`: counted per model call, with how many calls (`usage` "tokens"); else per turn only. */
function TokenTable({ view, perCall }: { view: SessionView; perCall: boolean }) {
	const session = sessionUsage(view);
	const last = lastTurn(view);
	const turn: TurnUsage | null = last ? turnUsage(last) : null;
	const calls = view.calls.length;
	const lastCalls = last ? view.calls.filter(call => call.turn === last.turn).length : 0;
	const unreported = tokensUnreported(view);
	const lastUnreported = last !== null && last.end !== null && last.end.usage === null && lastCalls === 0;
	const cell = (value: number | null) => (value === null ? "–" : count(value));
	const total = (value: number) => (unreported ? "–" : count(value));
	const turnCell = (value: number | null) => (lastUnreported ? "–" : cell(value));
	return (
		<table className="tokens">
			<thead>
				<tr>
					<td />
					<th scope="col">this agent</th>
					<th scope="col">last turn</th>
				</tr>
			</thead>
			<tbody>
				<tr>
					<th scope="row">input</th>
					<td>{total(session.inputTokens)}</td>
					<td>{turnCell(turn?.inputTokens ?? null)}</td>
				</tr>
				<tr className="tokens-sub">
					<th scope="row">cached</th>
					<td>{total(session.cachedInputTokens)}</td>
					<td>{turnCell(turn?.cachedInputTokens ?? null)}</td>
				</tr>
				<tr className="tokens-sub">
					<th scope="row">cache share</th>
					<td>{unreported ? "–" : percent(cachedShare(session))}</td>
					<td>{turn && !lastUnreported ? percent(cachedShare(turn)) : "–"}</td>
				</tr>
				<tr>
					<th scope="row">output</th>
					<td>{total(session.outputTokens)}</td>
					<td>{turnCell(turn?.outputTokens ?? null)}</td>
				</tr>
				<tr className="tokens-sub">
					<th scope="row">reasoning</th>
					<td>{total(session.reasoningTokens)}</td>
					<td>{turnCell(turn?.reasoningTokens ?? null)}</td>
				</tr>
				{perCall ? (
					<tr>
						<th scope="row">calls</th>
						<td>{calls}</td>
						<td>{last ? lastCalls : "–"}</td>
					</tr>
				) : null}
			</tbody>
		</table>
	);
}

/** A scripted model reports no usage at all: the panel says so rather than show zeros. */
const tokensUnreported = (view: SessionView) =>
	view.turns.some(one => one.end !== null) &&
	view.calls.length === 0 &&
	view.turns.every(one => one.end === null || one.end.usage === null);

/**
 * What is not counted yet while a turn runs, in a sentence; null when everything so far is. An agent that counts
 * per model call counts each when it ends (`step.ended`), its subagents' as theirs end; one that counts per turn,
 * when the turn ends. `none`: nothing is counted yet, so the figures say so rather than show a false 0.
 */
export function uncountedWords(view: SessionView, perCall: boolean): { text: string; none: boolean } | null {
	const used = sessionUsage(view);
	const none = used.inputTokens + used.outputTokens === 0;
	if (perCall) {
		const open = openStep(view);
		if (!open) return null;
		return { none, text: none ? `Counted when step ${open.step} ends.` : `Step ${open.step} is counted when it ends.` };
	}
	const last = lastTurn(view);
	if (!last || last.end !== null) return null;
	return { none, text: none ? "Counted when this turn ends." : "This turn is counted when it ends." };
}

/**
 * What the agent has used: its cost first where its agent says it, how full its context is, and its tokens in
 * and out. Every count and the cache per model call are under "Token details".
 */
function Usage({ view, summary }: { view: SessionView; summary: SessionSummary }) {
	const usage = summary.capabilities.usage;
	const harness = HARNESS_NAMES[summary.harness ?? "windlass"];
	const perCall = usage === "tokens";
	const tokens = perCall || reportsTokens(view);
	const unreported = tokensUnreported(view);
	const session = sessionUsage(view);
	const uncounted = tokens ? uncountedWords(view, perCall) : null;
	const context = usage === "context" ? view.context : null;
	const share = context ? Math.min(1, context.used / context.size) : 0;
	const rates = useCostRates();
	// Who paid for its turns, as an item's cost says it: a plan's turns are included in it, a key's are billed.
	const payers = rates ? sessionPayerRows(summary.spent, rates) : [];
	return (
		<section className="panel-section" aria-labelledby="panel-usage" data-usage={usage}>
			<h2 className="panel-title" id="panel-usage">
				Usage
				<span className="panel-title-aside">this agent</span>
			</h2>
			{usage === "context" && !context ? (
				<p className="panel-empty">
					{summary.turns === 0
						? `${harness} says what it used once a turn has run.`
						: `${harness} has not said what it used.`}
				</p>
			) : null}
			<div className="figures">
				{context ? (
					<Figure value={context.cost ? costWords(context.cost).replace(/ so far$/, "") : "–"} label="so far" />
				) : null}
				{context ? (
					<div className="figure">
						<p className="figure-value">{contextWords(context).replace(/ used$/, "")}</p>
						<div
							className="stat-meter"
							role="meter"
							aria-label="Context used"
							aria-valuemin={0}
							aria-valuemax={context.size}
							aria-valuenow={Math.min(context.size, context.used)}
							aria-valuetext={contextWords(context)}
						>
							{share > 0 ? <span style={{ width: `${share * 100}%` }} /> : null}
						</div>
						<p className="figure-label">context</p>
					</div>
				) : null}
				{context?.fiveHourUsedPct != null ? (
					<Figure value={`${Math.round(context.fiveHourUsedPct)}%`} label="5-hour window" />
				) : null}
				{perCall || (tokens && !context) ? (
					<>
						<Figure value={unreported || uncounted?.none ? "–" : compact(session.inputTokens)} label="tokens in" />
						<Figure value={unreported || uncounted?.none ? "–" : compact(session.outputTokens)} label="tokens out" />
					</>
				) : null}
			</div>
			{payers.length > 0 ? (
				<dl className="panel-payers">
					{payers.map(row => (
						<div key={row.label}>
							<dt>{row.label}</dt>
							<dd>{row.value}</dd>
						</div>
					))}
				</dl>
			) : null}
			{unreported ? (
				<p className="panel-empty panel-note">No token counts were reported.</p>
			) : uncounted && (perCall || !context) ? (
				<p className="panel-empty panel-note">{uncounted.text}</p>
			) : null}
			{tokens && !unreported ? (
				<details className="panel-more">
					<summary>
						<ChevronIcon size={12} className="panel-more-chevron" />
						Token details
					</summary>
					<TokenTable view={view} perCall={perCall} />
					{perCall ? <CacheBars calls={view.calls} anyTurns={view.turns.length > 0} /> : null}
				</details>
			) : null}
		</section>
	);
}

function Figure({ value, label }: { value: string; label: string }) {
	return (
		<div className="figure">
			<p className="figure-value">{value}</p>
			<p className="figure-label">{label}</p>
		</div>
	);
}

/** How many of the latest calls the chart draws. */
const MAX_BARS = 40;

function CacheBars({ calls, anyTurns }: { calls: ModelCall[]; anyTurns: boolean }) {
	const shown = calls.slice(-MAX_BARS);
	const offset = calls.length - shown.length;
	const scale = Math.max(1, ...shown.map(call => call.inputTokens));
	return (
		<div className="cache-calls">
			<p className="cache-calls-title">
				Cache per call
				<span className="legend" aria-hidden="true">
					<span className="legend-key">
						<span className="swatch swatch-cached" /> cached
					</span>
					<span className="legend-key">
						<span className="swatch swatch-new" /> new
					</span>
				</span>
			</p>
			{shown.length === 0 ? (
				<p className="panel-empty">
					{anyTurns ? "No model call has reported its token counts." : "One bar per model call will appear here."}
				</p>
			) : (
				<>
					{offset > 0 ? (
						<p className="panel-empty">
							Showing the last {MAX_BARS} of {calls.length} calls.
						</p>
					) : null}
					<ol
						className="bars"
						aria-label="Input tokens per model call: the part read from the prompt cache and the new part"
					>
						{shown.map((call, index) => {
							const fresh = Math.max(0, call.inputTokens - call.cachedInputTokens);
							const share = cachedShare(call);
							const label = `Call ${offset + index + 1}: ${count(call.inputTokens)} input tokens, ${count(call.cachedInputTokens)} from the cache (${percent(share)}), ${count(fresh)} new${call.failed ? "; the call did not complete" : ""}`;
							return (
								<li
									key={`${call.turn}-${call.messageId}-${index}`}
									className={`bar-row${call.failed ? " bar-row-failed" : ""}`}
									title={label}
								>
									<span className="bar-index" aria-hidden="true">
										{offset + index + 1}
									</span>
									<span className="bar-track" aria-hidden="true">
										<span className="bar bar-cached" style={{ width: `${(call.cachedInputTokens / scale) * 100}%` }} />
										<span className="bar bar-new" style={{ width: `${(fresh / scale) * 100}%` }} />
									</span>
									<span className="bar-total" aria-hidden="true">
										{compact(call.inputTokens)}
									</span>
									<span className="bar-share" aria-hidden="true">
										{percent(share)}
									</span>
									<span className="visually-hidden">{label}</span>
								</li>
							);
						})}
					</ol>
				</>
			)}
		</div>
	);
}

const GIT_STATUS: Record<string, string> = {
	M: "modified",
	A: "added",
	D: "deleted",
	R: "renamed",
	C: "copied",
	U: "unmerged",
	"?": "untracked",
	"!": "ignored",
};

function statusOf(status: string): { letter: string; word: string } {
	const letter = status.trim().charAt(0) || "M";
	return { letter, word: GIT_STATUS[letter] ?? "changed" };
}

function Changes({
	sessionId,
	summary,
	turnsEnded,
	reloads,
	onFiles,
}: {
	sessionId: string;
	summary: SessionSummary;
	turnsEnded: number;
	reloads: number;
	onFiles(count: number | null): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [files, setFiles] = useState<WorkspaceFile[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [diff, setDiff] = useState<{ text: string | null; error: string | null } | null>(null);
	const hasSandbox = summary.sandbox !== "none";

	const load = useCallback(() => {
		let current = true;
		setLoading(true);
		client
			.session(auth, sessionId)
			.changes()
			.then(
				list => {
					if (!current) return;
					setFiles(list);
					onFiles(list.length);
					setError(null);
					setLoading(false);
				},
				(failure: unknown) => {
					if (!current) return;
					setError(explain(failure));
					setLoading(false);
				},
			);
		return () => {
			current = false;
		};
	}, [client, auth, sessionId, explain, onFiles]);

	// On open, when the sandbox first exists, whenever a turn ends, and after the platform committed the work.
	useEffect(() => {
		if (!hasSandbox) return;
		return load();
	}, [load, hasSandbox, turnsEnded, reloads]);

	const openDiff = () => {
		setDiff({ text: null, error: null });
		client
			.session(auth, sessionId)
			.diff()
			.then(
				text => setDiff(current => (current ? { text, error: null } : null)),
				(failure: unknown) => setDiff(current => (current ? { text: null, error: explain(failure) } : null)),
			);
	};

	return (
		<section className="panel-section" aria-labelledby="panel-changes">
			<h2 className="panel-title" id="panel-changes">
				Changes
				{files && files.length > 0 ? <span className="panel-title-aside">{plural(files.length, "file")}</span> : null}
				{hasSandbox ? (
					<button
						type="button"
						className="icon-button icon-button-small"
						onClick={load}
						disabled={loading}
						aria-label="Reload the changed files"
						title="Reload"
					>
						<RefreshIcon size={13} className={loading ? "spin" : undefined} />
					</button>
				) : null}
			</h2>
			{!hasSandbox ? (
				<p className="panel-empty">
					The sandbox is created on {summary.item ? "the work item's first prompt" : "the first prompt"}. Files the
					agent changes will be listed here.
				</p>
			) : error ? (
				<p className="panel-empty tone-bad" role="alert">
					<WarnIcon size={13} /> {error}
				</p>
			) : files === null ? (
				<p className="panel-empty" aria-busy="true">
					Reading the workspace…
				</p>
			) : files.length === 0 ? (
				<p className="panel-empty">No file differs from the last commit.</p>
			) : (
				<>
					<ul className="changes" aria-label="Files that differ from the last commit">
						{files.map(file => {
							const { letter, word } = statusOf(file.status);
							return (
								<li key={file.path}>
									<span className={`change-status change-status-${letter === "?" ? "new" : letter}`} title={word}>
										{letter}
										<span className="visually-hidden"> {word}</span>
									</span>
									<span className="change-path" title={file.path}>
										<span className="change-dir">
											{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : ""}
										</span>
										<span className="change-name">{file.path.slice(file.path.lastIndexOf("/") + 1)}</span>
									</span>
								</li>
							);
						})}
					</ul>
					<button type="button" className="button button-outline button-small" onClick={openDiff}>
						View the diff
					</button>
				</>
			)}
			{diff ? (
				<Dialog
					title="Changes"
					lede={`${summary.title} · the workspace against its last commit${files ? ` · ${plural(files.length, "file")}` : ""}`}
					size="full"
					onClose={() => setDiff(null)}
				>
					{diff.error ? (
						<div className="state state-error" role="alert">
							<WarnIcon size={22} />
							<h3>The diff could not be loaded</h3>
							<p>{diff.error}</p>
							<button type="button" className="button button-outline" onClick={openDiff}>
								Try again
							</button>
						</div>
					) : diff.text === null ? (
						<div className="state state-loading" aria-busy="true">
							<span className="spinner" aria-hidden="true" />
							<p>Reading the diff from the sandbox…</p>
						</div>
					) : (
						<DiffView diff={diff.text} />
					)}
				</Dialog>
			) : null}
		</section>
	);
}

export function SidePanel({
	sessionId,
	summary,
	profile,
	view,
	turnsEnded,
	question = null,
	egress,
	hosted,
	domains,
	machineName = null,
}: {
	egress?: EgressMode;
	hosted?: boolean;
	domains?: number;
	machineName?: string | null;
	sessionId: string;
	summary: SessionSummary;
	profile: SandboxProfile;
	view: SessionView;
	turnsEnded: number;
	question?: PendingQuestion | null;
}) {
	// How many files differ from the last commit, once the list was read; and a count that asks for it again.
	const [files, setFiles] = useState<number | null>(null);
	const [reloads, setReloads] = useState(0);
	const published = useCallback(() => setReloads(value => value + 1), []);
	const { usage } = summary.capabilities;
	return (
		<aside className="panel" id="details" aria-label="Agent details">
			<Facts summary={summary} profile={profile} view={view} />
			<WhereItRuns summary={summary} profile={profile} view={view} machineName={machineName} egress={egress} />
			{usage === "tokens" || usage === "context" ? <Usage view={view} summary={summary} /> : null}
			<Changes sessionId={sessionId} summary={summary} turnsEnded={turnsEnded} reloads={reloads} onFiles={setFiles} />
			<PullRequestSection
				sessionId={sessionId}
				summary={summary}
				profile={profile}
				turnsEnded={turnsEnded}
				files={files}
				onPublished={published}
			/>
			<RepositorySetupSection
				sessionId={sessionId}
				summary={summary}
				question={question}
				egress={egress}
				hosted={hosted}
				domains={domains}
			/>
		</aside>
	);
}
