/**
 * The Checks panel of an item's page: is the pull request ready, and if not, what is open. One section near the top,
 * from what the item's view already holds, never the agent's words:
 *
 * - one line first: "Ready to merge", or "N open" and what they are;
 * - CI on the pushed commit (`Verdict.ci`), each check with its state and its link, failed first, folded to one line
 *   when every one passed; the server's sentence where the rows do not say it all (cancelled, not read, none);
 * - the user's checks the agent's turn ran (`Verdict.gate.required`);
 * - the second review's recommendation and its open findings (blocking ones, and its questions), each a row that
 *   unfolds, with the whole review under "Show the full review";
 * - the open feedback from people on the pull request (`ItemView.feedback`), with every batch under a fold;
 * - what the platform saw in the changes (flags), and a conflict with the base.
 *
 * Earlier verdicts fold at its foot. The reviewer's and people's words are shown as their own, in plain text.
 */
import { modelWords } from "../lib/models";
import type { FeedbackEntry, ItemReview, ItemView, ReviewBlock, Verdict, VerdictRun } from "@contract";
import { useId, useState, type ReactNode } from "react";
import { InlineMarkdown } from "../components/Blocks";
import { FOLD_WORDS, FoldToggle, LongText } from "../components/Fold";
import { GithubFeedback, githubUrl, KIND_WORD, OPEN, STATE_WORD as BATCH_WORD } from "../components/GithubFeedback";
import { CheckIcon, ChevronIcon, CrossIcon, ExternalIcon, RingIcon, StopIcon, WarnIcon } from "../components/Icons";
import {
	blobLink,
	CHECK_TONE,
	CHECK_WORD,
	FAILING_CONCLUSIONS,
	locationText,
	ReviewText,
} from "../components/ReviewBlocks";
import type { ScreenshotLinks } from "../components/Screenshots";
import { noneLine, RECOMMENDATION_WORD, SecondReview, shownReview } from "../components/SecondReview";
import { plural } from "../lib/format";
import { linkProps } from "../lib/router";
import { inSecondReview } from "../lib/items";
import { hostWords } from "../lib/host";
import { ReviewWord, VerdictWord } from "../components/ItemRow";

// ---- what it says -------------------------------------------------------------------------------

/** A CI check's state, as the panel sorts and words it. */
export type CiState = "failed" | "running" | "cancelled" | "skipped" | "passed";

export function ciState(conclusion: string): CiState {
	if (conclusion === "success") return "passed";
	if (conclusion === "") return "running";
	if (conclusion === "cancelled" || conclusion === "stale") return "cancelled";
	if (FAILING_CONCLUSIONS.includes(conclusion) || conclusion === "not_run") return "failed";
	return "skipped";
}

const CI_ORDER: Record<CiState, number> = { failed: 0, running: 1, cancelled: 2, skipped: 3, passed: 4 };
const CI_WORD: Record<CiState, string> = {
	failed: "failed",
	running: "running",
	cancelled: "cancelled",
	skipped: "skipped",
	passed: "passed",
};
const CI_TONE_OF: Record<CiState, string> = {
	failed: "tone-bad",
	running: "tone-dim",
	cancelled: "tone-warn",
	skipped: "tone-faint",
	passed: "tone-good",
};

/** A check's word: GitHub's own where it says more than the state ("timed out", "did not start", "stale"). */
function ciWord(run: VerdictRun): string {
	const state = ciState(run.conclusion);
	if (run.conclusion === "not_run") return "did not start";
	if (state === "failed" && run.conclusion !== "failure") return run.conclusion.replace(/_/g, " ");
	if (state === "skipped" && run.conclusion !== "skipped") return run.conclusion.replace(/_/g, " ");
	if (run.conclusion === "stale") return "stale";
	return CI_WORD[state];
}

/** The checks, failed first, then running, cancelled, skipped, passed; each in GitHub's order within its state. */
export function sortedRuns(runs: VerdictRun[]): VerdictRun[] {
	return runs
		.map((run, index) => ({ run, index }))
		.sort((a, b) => CI_ORDER[ciState(a.run.conclusion)] - CI_ORDER[ciState(b.run.conclusion)] || a.index - b.index)
		.map(({ run }) => run);
}

const blocking = (review: ItemReview | null) =>
	review?.state === "filed"
		? review.blocks.filter(
				(block): block is Extract<ReviewBlock, { kind: "finding" }> =>
					block.kind === "finding" && block.severity === "blocking",
			)
		: [];
const questions = (review: ItemReview | null) =>
	review?.state === "filed"
		? review.blocks.filter((block): block is Extract<ReviewBlock, { kind: "question" }> => block.kind === "question")
		: [];

/** The feedback entries of batches still open (waiting, held, asking): what people on the pull request asked that is not taken yet. */
export function openFeedback(
	view: Pick<ItemView, "feedback">,
): Array<{ entry: FeedbackEntry; state: keyof typeof BATCH_WORD; reason: string }> {
	return (view.feedback?.batches ?? [])
		.filter(batch => OPEN.has(batch.state))
		.flatMap(batch => batch.entries.map(entry => ({ entry, state: batch.state, reason: batch.reason })));
}

export interface ChecksSummary {
	/** What is open, each with how many: "1 failed CI check". Empty when nothing is. */
	open: Array<{ count: number; words: string }>;
	/** Handed over, its verdict a pass, and nothing open. */
	ready: boolean;
	/** The second reviewer has the work yet: the verdict's word waits for it. */
	reviewing: boolean;
}

/** What the panel's first line says, from the latest verdict, the review of the run shown, and the open feedback. */
export function checksSummary(view: ItemView): ChecksSummary {
	const verdict = view.verdicts[view.verdicts.length - 1] ?? null;
	const open: ChecksSummary["open"] = [];
	const add = (count: number, one: string, many = `${one}s`) =>
		count > 0 && open.push({ count, words: plural(count, one, many) });
	// A part does not wait for CI and has no pull request: both are its feature's.
	const part = !!view.parent;
	if (verdict) {
		const states = part ? [] : verdict.ci.runs.map(run => ciState(run.conclusion));
		const count = (state: CiState) => states.filter(one => one === state).length;
		add(count("failed"), "failed CI check");
		add(count("running"), "CI check still running", "CI checks still running");
		add(count("cancelled"), "cancelled CI check");
		if (
			!part &&
			verdict.ci.runs.length === 0 &&
			(verdict.ci.state === "timed_out" || verdict.ci.state === "not_run" || verdict.ci.state === "failed")
		)
			open.push({
				count: 1,
				words:
					verdict.ci.state === "not_run"
						? "CI did not start"
						: verdict.ci.state === "failed"
							? "CI failed"
							: "CI unfinished",
			});
		if (!part && (verdict.ci.state === "unread" || verdict.ci.state === "not_permitted"))
			open.push({ count: 1, words: "CI not read" });
		add(
			verdict.gate.required.filter(check => check.status !== "passed").length,
			"check that did not pass",
			"checks that did not pass",
		);
		add(verdict.flags.length, "thing to look at", "things to look at");
		if (!part && verdict.mergeable === false) open.push({ count: 1, words: "a conflict with the base" });
		if (verdict.moved) open.push({ count: 1, words: "a commit nothing verified" });
		if (open.length === 0 && verdict.result === "incomplete")
			open.push({ count: 1, words: "the last turn did not finish" });
		if (open.length === 0 && verdict.result === "unverified")
			open.push({ count: 1, words: "nothing verified this commit" });
	}
	const reviewing = inSecondReview(view);
	const { current } = shownReview(view);
	if (reviewing) open.push({ count: 1, words: "the second review" });
	const blockers = blocking(current).length;
	add(blockers, "blocking finding");
	if (!blockers && view.review?.recommendation === "changes_requested")
		open.push({ count: 1, words: "changes requested in code review" });
	add(questions(current).length, "question from the reviewer", "questions from the reviewer");
	const { name } = hostWords(view.repository.provider);
	add(openFeedback(view).length, `comment on ${name}`, `comments on ${name}`);
	return { open, ready: open.length === 0 && view.state === "review" && verdict?.result === "pass", reviewing };
}

/** "3 open: 1 failed CI check, 2 blocking findings". */
export function openLine(open: ChecksSummary["open"]): string {
	const total = open.reduce((sum, one) => sum + one.count, 0);
	return `${total} open: ${open.map(one => one.words).join(", ")}`;
}

// ---- its rows -----------------------------------------------------------------------------------

function CiGlyph({ state }: { state: CiState }) {
	switch (state) {
		case "passed":
			return <CheckIcon size={13} className="checks-glyph tone-good" />;
		case "failed":
			return <CrossIcon size={13} className="checks-glyph tone-bad" />;
		case "running":
			return <RingIcon size={13} className="checks-glyph tone-dim" />;
		case "cancelled":
			return <StopIcon size={13} className="checks-glyph tone-warn" />;
		case "skipped":
			return <span className="checks-glyph checks-glyph-dash" aria-hidden="true" />;
	}
}

function CiRow({ run }: { run: VerdictRun }) {
	const state = ciState(run.conclusion);
	return (
		<li className="checks-row">
			<CiGlyph state={state} />
			<a className="item-check-name item-link" href={run.url} target="_blank" rel="noreferrer">
				{run.name}
				<ExternalIcon size={10} />
			</a>
			<span className={CI_TONE_OF[state]}>{ciWord(run)}</span>
			{run.app === "github-actions" ? null : (
				<span className="tone-faint">{run.app === "status" ? "a commit status" : run.app}</span>
			)}
		</li>
	);
}

/** CI's head in a few words: "18 checks passed", "1 failed, 2 passed". */
function ciHead(runs: VerdictRun[]): string {
	const counts = new Map<CiState, number>();
	for (const run of runs) counts.set(ciState(run.conclusion), (counts.get(ciState(run.conclusion)) ?? 0) + 1);
	if (counts.size === 1 && counts.has("passed")) return `${plural(runs.length, "check")} passed`;
	return (Object.keys(CI_ORDER) as CiState[])
		.flatMap(state => (counts.get(state) ? [`${counts.get(state)} ${CI_WORD[state]}`] : []))
		.join(", ");
}

/** The server's sentence about CI is shown where its rows do not say it all: cancelled, not read, none, unfinished, moved. */
const SAID_SHOWN: ReadonlySet<Verdict["ci"]["state"]> = new Set([
	"cancelled",
	"none",
	"skipped",
	"not_run",
	"timed_out",
	"not_permitted",
	"unread",
]);

/** Passed checks fold under the others once there are more than this many of them. */
const PASSED_SHOWN = 2;

function Ci({ verdict }: { verdict: Verdict }) {
	const [open, setOpen] = useState(false);
	const id = useId();
	const { ci } = verdict;
	const runs = sortedRuns(ci.runs);
	const passed = runs.filter(run => ciState(run.conclusion) === "passed");
	const others = runs.filter(run => ciState(run.conclusion) !== "passed");
	const folds = passed.length > PASSED_SHOWN || (others.length === 0 && passed.length > 0);
	const said = SAID_SHOWN.has(ci.state) || verdict.moved !== null;
	const tone = ci.state === "failed" ? "tone-bad" : ci.state === "passed" ? undefined : "tone-warn";
	return (
		<div>
			<dt>CI</dt>
			<dd>
				{runs.length > 0 ? (
					<p className="checks-head">
						{others.length === 0 ? <CheckIcon size={13} className="checks-glyph tone-good" /> : null}
						<span className={others.length === 0 ? undefined : tone}>{ciHead(runs)}</span>
						{folds ? (
							<FoldToggle
								open={open}
								controls={id}
								label={others.length === 0 ? FOLD_WORDS.all : FOLD_WORDS.more(passed.length, "passed")}
								onToggle={() => setOpen(value => !value)}
							/>
						) : null}
					</p>
				) : null}
				{/* "not_permitted" quotes GitHub's own words: shown as text, never read as Markdown. */}
				{said ? (
					ci.state === "not_permitted" ? (
						<p className={`checks-said ${tone ?? ""}`}>{verdict.said.ci}</p>
					) : (
						<InlineMarkdown className={`checks-said ${tone ?? ""}`} text={verdict.said.ci} />
					)
				) : null}
				{others.length > 0 ? (
					<ul className="checks-rows">
						{others.map(run => (
							<CiRow key={`${run.app}/${run.name}`} run={run} />
						))}
					</ul>
				) : null}
				{passed.length > 0 ? (
					<ul className="checks-rows" id={id} hidden={folds && !open}>
						{passed.map(run => (
							<CiRow key={`${run.app}/${run.name}`} run={run} />
						))}
					</ul>
				) : null}
			</dd>
		</div>
	);
}

const times = (count: number) => (count === 1 ? "once" : count === 2 ? "twice" : `${count} times`);

/** What the gate said when none of the user's checks is listed. */
export function gateWords(gate: Verdict["gate"]): string {
	switch (gate.state) {
		case null:
			return "No record of the checks for this commit.";
		case "passed":
			return "None of yours ran; the repository's own checks passed.";
		case "unresolved":
			return "None of yours ran; the repository's own checks did not pass.";
		case "not_needed":
			return gate.unneeded?.on === "run"
				? "No check needed to run again: they had passed on this state of the work."
				: "No check verified this state of the work.";
		case "none_set":
			return "None saved for this repository. CI decides.";
		case "off":
			return "The repository's own file turned verification off.";
		case "no_sandbox":
			return "Checks could not run in this sandbox.";
		case "not_in_force":
			return "No checks were in force.";
		case "stopped":
			return "The turn was stopped before its checks finished.";
		case "failed":
			return "The turn failed before its checks finished.";
	}
}

function Gate({ gate }: { gate: Verdict["gate"] }) {
	return (
		<div>
			<dt>Your checks</dt>
			<dd>
				{gate.required.length === 0 ? (
					<p className="checks-head tone-dim">{gateWords(gate)}</p>
				) : (
					<ul className="checks-rows">
						{gate.required.map(check => (
							<li key={check.name} className="checks-row">
								{check.status === "passed" ? (
									<CheckIcon size={13} className="checks-glyph tone-good" />
								) : check.status === "failed" || check.status === "timed_out" ? (
									<CrossIcon size={13} className="checks-glyph tone-bad" />
								) : (
									<WarnIcon size={13} className="checks-glyph tone-warn" />
								)}
								<span className="item-check-name">{check.name}</span>
								<span className={`tone-${CHECK_TONE[check.status]}`}>{CHECK_WORD[check.status]}</span>
								{check.sentBack > 0 ? (
									<span className="tone-faint">after the agent was sent back {times(check.sentBack)}</span>
								) : null}
							</li>
						))}
					</ul>
				)}
			</dd>
		</div>
	);
}

/** One open finding: its title in a row, its text and places when unfolded. */
function Finding({
	view,
	review,
	finding,
}: {
	view: ItemView;
	review: ItemReview;
	finding: Extract<ReviewBlock, { kind: "finding" }>;
}) {
	const [open, setOpen] = useState(false);
	const id = useId();
	const first = finding.at[0];
	return (
		<li className="checks-row checks-finding">
			<button
				type="button"
				className="link machine-toggle checks-finding-toggle"
				aria-expanded={open}
				aria-controls={id}
				onClick={() => setOpen(value => !value)}
			>
				<ChevronIcon size={11} className="machine-chevron" />
				<span className="checks-finding-title">{finding.title}</span>
			</button>
			{first && !open ? <code className="checks-where">{locationText(first)}</code> : null}
			<div id={id} className="checks-finding-body" hidden={!open}>
				<ReviewText text={finding.text} />
				{finding.at.length > 0 ? (
					<p className="review-at">
						{finding.at.map((at, index) => {
							const href = blobLink(view.repository, at.side === "base" ? review.base : review.head, at);
							return href ? (
								<a key={index} className="item-link" href={href} target="_blank" rel="noreferrer">
									<code>{locationText(at)}</code>
									<ExternalIcon size={10} />
								</a>
							) : (
								<code key={index}>{locationText(at)}</code>
							);
						})}
					</p>
				) : null}
			</div>
		</li>
	);
}

function Review({ view, links, when }: { view: ItemView; links: ScreenshotLinks; when(at: number): ReactNode }) {
	const [open, setOpen] = useState(false);
	const id = useId();
	const { state, current, before, line } = shownReview(view);
	if (state === null && view.reviews.length === 0) return null;
	const findings = blocking(current);
	const asks = questions(current);
	const rest =
		current?.state === "filed"
			? current.blocks.filter(block => block.kind === "finding" && block.severity !== "blocking").length
			: 0;
	const session = view.reviewerSessionId;
	const word =
		current?.state === "filed"
			? current.recommendation
				? RECOMMENDATION_WORD[current.recommendation]
				: "no recommendation"
			: null;
	const requested = view.reviews.filter(review => review.requestedPull).length;
	const shown = current?.state === "filed" || before.length > 0 || requested > 0;
	return (
		<div>
			<dt>Review</dt>
			<dd>
				<p className="checks-head">
					{word ? (
						<>
							{current?.recommendation === "approve" ? (
								<CheckIcon size={13} className="checks-glyph tone-good" />
							) : current?.recommendation === "changes_requested" ? (
								<CrossIcon size={13} className="checks-glyph tone-bad" />
							) : (
								<WarnIcon size={13} className="checks-glyph tone-warn" />
							)}
							<span>
								The second reviewer <span className="review-word">{word}</span>
								{findings.length > 0 ? <span className="tone-bad">, {findings.length} blocking</span> : null}
							</span>
							<span className="agent-meta">
								<span>at {current!.head.slice(0, 7)}</span>
								{current!.round > 1 ? <span>round {current!.round}</span> : null}
								<span className="review-model">{modelWords(current!.by.model)}</span>
							</span>
						</>
					) : (
						<span className="tone-dim">{current ? noneLine(view, current, "none") : line}</span>
					)}
					{state === "running" && session && !current ? (
						<a className="repo-link review-session" {...linkProps({ name: "session", id: session })}>
							Open the reviewer's session
						</a>
					) : null}
				</p>
				{findings.length > 0 || asks.length > 0 ? (
					<ul className="checks-rows">
						{findings.map(finding => (
							<Finding key={finding.id} view={view} review={current!} finding={finding} />
						))}
						{asks.map((ask, index) => (
							<li key={index} className="checks-row checks-ask">
								<span className="tone-warn checks-ask-label">Asks you</span>
								<LongText lines={2} as="div" className="checks-ask-text">
									<ReviewText text={ask.text} plain />
								</LongText>
							</li>
						))}
					</ul>
				) : null}
				{shown ? (
					<>
						<p className="checks-more">
							<FoldToggle
								open={open}
								controls={id}
								label={
									requested
										? `Show reviews (${plural(requested, "requested PR review")})`
										: current?.state === "filed"
											? rest > 0
												? `Show the full review (${plural(rest, "more finding")})`
												: "Show the full review"
											: FOLD_WORDS.more(before.length, before.length === 1 ? "earlier review" : "earlier reviews")
								}
								onToggle={() => setOpen(value => !value)}
							/>
						</p>
						<div id={id} hidden={!open} className="checks-fold">
							{open ? <SecondReview view={view} links={links} when={when} bare /> : null}
						</div>
					</>
				) : null}
			</dd>
		</div>
	);
}

function Feedback({ view, when }: { view: ItemView; when(at: number): ReactNode }) {
	const [open, setOpen] = useState(false);
	const id = useId();
	const feedback = view.feedback;
	const batches = (feedback?.batches ?? []).filter(batch => batch.entries.length > 0);
	if (!feedback || (batches.length === 0 && !feedback.notTaken)) return null;
	const entries = openFeedback(view);
	const states = [...new Set(entries.map(one => one.state))];
	const settled = batches.filter(batch => !OPEN.has(batch.state)).length;
	const { name } = hostWords(view.repository.provider);
	return (
		<div>
			<dt>{name}</dt>
			<dd>
				<p className="checks-head">
					{entries.length > 0 ? (
						<>
							<span>{plural(entries.length, "open comment")}</span>
							<span className="tone-dim">{states.map(state => BATCH_WORD[state].toLowerCase()).join(", ")}</span>
						</>
					) : (
						<span className="tone-dim">
							Nothing open{settled > 0 ? `: ${plural(settled, "batch", "batches")} settled` : ""}
							{feedback.notTaken > 0 ? `; ${feedback.notTaken} from people without write access, counted only` : ""}
						</span>
					)}
				</p>
				{entries.length > 0 ? (
					<ul className="checks-rows">
						{entries.map(({ entry }) => {
							const url = githubUrl(entry.url);
							return (
								<li key={entry.id} className="checks-row checks-comment">
									<span className="gh-who">@{entry.author}</span>
									<span className="tone-dim">{KIND_WORD[entry.kind]}</span>
									{entry.path ? (
										<code className="checks-where">
											{entry.path}
											{entry.line ? `:${entry.line}` : ""}
										</code>
									) : null}
									{url ? (
										<a
											className="item-link checks-open"
											href={url}
											target="_blank"
											rel="noreferrer noopener"
											aria-label={`Open @${entry.author}'s ${KIND_WORD[entry.kind].toLowerCase()} on ${name}`}
										>
											On {name}
											<ExternalIcon size={10} />
										</a>
									) : null}
									<LongText lines={2} className="checks-quote">
										{entry.body.trim() || "No text."}
									</LongText>
								</li>
							);
						})}
					</ul>
				) : null}
				<p className="checks-more">
					<FoldToggle
						open={open}
						controls={id}
						label={batches.length === 1 ? "Show the batch" : `Show all ${batches.length} batches`}
						onToggle={() => setOpen(value => !value)}
					/>
				</p>
				<div id={id} hidden={!open} className="checks-fold">
					{open ? <GithubFeedback view={view} when={when} /> : null}
				</div>
			</dd>
		</div>
	);
}

function Flags({ verdict }: { verdict: Verdict }) {
	if (verdict.flags.length === 0) return null;
	return (
		<div>
			<dt>To look at</dt>
			<dd>
				<ul className="checks-rows">
					{verdict.flags.map((flag, index) => (
						<li key={flag.kind} className="checks-row">
							<WarnIcon size={13} className="checks-glyph tone-warn" />
							<span className="tone-warn">
								<InlineMarkdown text={verdict.said.flags[index] ?? flag.kind} />
							</span>
							<code className="item-paths">{flag.where.join(", ")}</code>
						</li>
					))}
				</ul>
			</dd>
		</div>
	);
}

/** An earlier verdict, folded at the panel's foot: what it rested on, in the same rows. */
function EarlierVerdict({ verdict, when }: { verdict: Verdict; when(at: number): ReactNode }) {
	return (
		<article className="item-verdict-block">
			<p className="item-verdict-head">
				<VerdictWord verdict={{ result: verdict.result, flags: verdict.flags, ci: verdict.ci.state }} />
				<span className="agent-meta">
					<span>at {verdict.head.slice(0, 7)}</span>
					<span>{when(verdict.at)}</span>
					<span>run {verdict.run}</span>
				</span>
			</p>
			<dl className="usage-facts item-facts checks-groups">
				<Ci verdict={verdict} />
				<Gate gate={verdict.gate} />
				<Flags verdict={verdict} />
			</dl>
		</article>
	);
}

// ---- the panel ----------------------------------------------------------------------------------

/** Whether the item has anything for the panel: a verdict, a second review, or feedback. */
export function hasChecks(view: ItemView): boolean {
	return (
		view.verdicts.length > 0 ||
		view.review !== null ||
		view.reviews.length > 0 ||
		(view.feedback?.batches.length ?? 0) > 0 ||
		(view.feedback?.notTaken ?? 0) > 0
	);
}

export function ItemChecks({
	view,
	links,
	when,
}: {
	view: ItemView;
	links: ScreenshotLinks;
	when(at: number): ReactNode;
}) {
	const [earlierOpen, setEarlierOpen] = useState(false);
	const earlier = useId();
	if (!hasChecks(view)) return null;
	const verdict = view.verdicts[view.verdicts.length - 1];
	const before = view.verdicts.slice(0, -1).reverse();
	const summary = checksSummary(view);
	const check = view.verifiedCheck;
	const host = hostWords(view.repository.provider);
	const checkLabel = check?.conclusion
		? { success: "Success", action_required: "Action required", failure: "Failure", cancelled: "Cancelled" }[
				check.conclusion
			]
		: "In progress";
	return (
		<section className="usage-section checks-panel" aria-labelledby="item-checks">
			<h2 className="usage-title" id="item-checks">
				Checks
				{verdict ? (
					<span className="agent-meta checks-at">
						<span>at {verdict.head.slice(0, 7)}</span>
						<span>{when(verdict.at)}</span>
					</span>
				) : null}
			</h2>
			<p className={`checks-summary${summary.ready ? " checks-ready" : ""}`}>
				<span className="checks-summary-main">
					{summary.ready ? (
						<CheckIcon size={15} className="checks-summary-mark tone-good" />
					) : summary.open.length > 0 ? (
						<span
							className={`checks-summary-mark checks-dot${verdict?.result === "fail" || summary.open.some(one => one.words.endsWith("blocking finding") || one.words.endsWith("blocking findings")) ? " checks-dot-bad" : ""}`}
							aria-hidden="true"
						/>
					) : null}
					<span>
						{summary.ready
							? "Ready to merge"
							: summary.open.length > 0
								? openLine(summary.open)
								: verdict
									? "Nothing open"
									: view.parent
										? "Checked when it joins the feature. CI and the review run on the whole feature."
										: "No verdict yet: one is made when the work is handed over."}
					</span>
				</span>
				{summary.ready || view.parent ? null : summary.reviewing ? (
					<ReviewWord item={view} />
				) : verdict && view.review?.recommendation !== "changes_requested" ? (
					<VerdictWord verdict={{ result: verdict.result, flags: verdict.flags, ci: verdict.ci.state }} />
				) : null}
			</p>
			<dl className="usage-facts item-facts checks-groups">
				{verdict && view.parent ? (
					<div>
						<dt>CI</dt>
						<dd>
							<p className="checks-head tone-dim">
								Runs on the whole feature, once its parts are in:{" "}
								<a className="link" {...linkProps({ name: "item", id: view.parent.itemId })}>
									{view.parent.title}
								</a>
							</p>
						</dd>
					</div>
				) : verdict ? (
					<Ci verdict={verdict} />
				) : null}
				{verdict ? <Gate gate={verdict.gate} /> : null}
				<Review view={view} links={links} when={when} />
				<Feedback view={view} when={when} />
				{verdict ? <Flags verdict={verdict} /> : null}
				{verdict && !view.parent && verdict.mergeable !== true ? (
					<div>
						<dt>Merging</dt>
						<dd>
							<p className={`checks-head ${verdict.mergeable === false ? "tone-warn" : "tone-dim"}`}>
								{verdict.mergeable === false
									? `${host.name} says the ${host.noun} conflicts with its base.`
									: `${host.name} had not said whether it can be merged.`}
							</p>
						</dd>
					</div>
				) : null}
			</dl>
			<p className="usage-note">
				{view.report === null && view.state === "review" ? " The agent that made the change filed no report." : null}
				{check ? (
					<>
						{" "}
						{check.state === "not_posted"
							? check.said
							: `On ${host.name} as windlass/verified: ${checkLabel} at ${check.sha.slice(0, 7)}.${check.conclusion === "action_required" ? " " + check.said + "." : ""}`}
					</>
				) : null}
			</p>
			{before.length > 0 ? (
				<>
					<p className="agents-fold items-fold">
						<FoldToggle
							open={earlierOpen}
							controls={earlier}
							label={FOLD_WORDS.more(before.length, before.length === 1 ? "earlier verdict" : "earlier verdicts")}
							onToggle={() => setEarlierOpen(value => !value)}
						/>
					</p>
					<div id={earlier} hidden={!earlierOpen}>
						{before.map(one => (
							<EarlierVerdict key={one.id} verdict={one} when={when} />
						))}
					</div>
				</>
			) : null}
		</section>
	);
}
