/**
 * An item as a row of a list and as the stages it moves through: its glyph, its track, its stepper and
 * the words beside it, shared by the item lists (screens/Items.tsx, screens/Factory.tsx) and the item page.
 */
import type { ItemSummary, StepKind } from "@contract";
import type { ReactNode } from "react";
import { HARNESS_NAMES } from "../lib/acp";
import { absoluteTime, relativeTime } from "../lib/format";
import { CI_WORD, inSecondReview, questionLine, verdictWord } from "../lib/items";
import { originIssue } from "../lib/origin";
import { ItemSourceTag } from "./ItemSource";
import { requestNumber } from "../lib/host";
import { linkProps } from "../lib/router";
import { LongText } from "./Fold";
import { AskIcon, CrossIcon, ExternalIcon, Mark, MergedIcon, PullRequestIcon, RingIcon, StopIcon } from "./Icons";
import { RECOMMENDATION_WORD } from "./SecondReview";
import { StatusBadge } from "./Status";
import { childrenOf, FactorySubtasks } from "./Subtasks";
import { AgentGlyph } from "./ui/Pill";

export function VerdictWord({ verdict }: { verdict: NonNullable<ItemSummary["verdict"]> }) {
	const { word, tone } = verdictWord(verdict);
	return <span className={`outcome item-verdict tone-${tone}`}>{word}</span>;
}

/**
 * Where an item stands beside its row: the verdict's word once it is handed over, with the second
 * reviewer's recommendation; while the reviewer runs or waits to, a quiet working word in its place.
 * A merged item has nothing left to review: its glyph and track say done, and no word stands there.
 */
export function ItemStanding({
	item,
	reviewer = true,
}: {
	item: Pick<ItemSummary, "review" | "verdict" | "state">;
	reviewer?: boolean;
}) {
	if (item.state === "done") return null;
	if (reviewer && inSecondReview(item)) return <ReviewWord item={item} />;
	return (
		<>
			{item.verdict ? <VerdictWord verdict={item.verdict} /> : null}
			{reviewer ? <ReviewWord item={item} /> : null}
		</>
	);
}

/** The second reviewer's recommendation, in a quiet word beside the verdict: the agent's, never the verdict's. While it runs, or waits to, a quiet working word. */
export function ReviewWord({ item }: { item: Pick<ItemSummary, "review"> }) {
	const review = item.review;
	if (review?.state === "running") return <span className="item-row-review">being reviewed</span>;
	if (review?.state === "waiting") return <span className="item-row-review">waiting for its reviewer</span>;
	if (review?.state !== "filed" || !review.recommendation) return null;
	return <span className="item-row-review">reviewed: {RECOMMENDATION_WORD[review.recommendation]}</span>;
}

/** Where an item is, as a glyph: still unless a turn of it runs, and in the calm hue when it asks its person. */
export function ItemGlyph({ item }: { item: Pick<ItemSummary, "state" | "question"> }) {
	switch (item.state) {
		case "working":
			return <Mark size={18} turning className="status-glyph status-running" />;
		case "waiting":
			return item.question ? (
				<AskIcon size={16} className="status-glyph status-waiting" />
			) : (
				<span className="item-glyph-waiting" aria-hidden="true" />
			);
		case "queued":
			return <span className="item-glyph-waiting" aria-hidden="true" />;
		case "review":
			return <PullRequestIcon size={16} className="tone-accent" />;
		case "done":
			return <MergedIcon size={16} className="tone-good" />;
		case "failed":
			return <CrossIcon size={16} className="tone-bad" />;
		case "cancelled":
			return <StopIcon size={16} className="tone-faint" />;
		case "draft":
			return <RingIcon size={16} className="status-glyph status-idle" />;
	}
}

/** What a wait is for, in a word or two beside the track. */
const WAIT_WORD: Record<NonNullable<ItemSummary["wait"]>["reason"], string> = {
	provider: "provider",
	children: "subtasks",
	capacity: "for a turn",
	machine: "machine",
	ci: "CI",
	person: "for you",
	budget: "budget",
	integration: "testing",
	sandboxes: "sandbox",
};

/**
 * Where an item is on its way to you, as a track of short bars (Helm's steps): built, pushed, CI, the
 * second review (where the deployment runs one), and yours. Read from the summary only: the bar it is
 * at, whether it moves there now, and a word. Null for a draft and for an item that ended without
 * reaching you.
 */
export function itemTrack(
	item: Pick<ItemSummary, "state" | "wait" | "pullRequest" | "review">,
	reviewer = true,
): { stages: string[]; at: number; now: boolean; word: string; tone: "work" | "wait" | "yours" | "done" } | null {
	const handover =
		item.state === "review" && item.review?.recommendation === "changes_requested" ? "changes requested" : "yours";
	const stages = reviewer ? ["built", "pushed", "CI", "review", handover] : ["built", "pushed", "CI", handover];
	const pushed = item.pullRequest !== null;
	switch (item.state) {
		case "queued":
			return { stages, at: 0, now: false, word: "queued", tone: "wait" };
		case "working":
			return { stages, at: 1, now: true, word: pushed ? "fixing" : "building", tone: "work" };
		case "waiting": {
			const reason = item.wait?.reason;
			if (reason === "ci") return { stages, at: 3, now: true, word: "CI", tone: "work" };
			return { stages, at: pushed ? 2 : 0, now: false, word: reason ? WAIT_WORD[reason] : "waiting", tone: "wait" };
		}
		case "review":
			if (reviewer && inSecondReview(item)) return { stages, at: 4, now: true, word: "review", tone: "work" };
			return { stages, at: stages.length, now: false, word: handover, tone: "yours" };
		case "done":
			return { stages, at: stages.length, now: false, word: "done", tone: "done" };
		default:
			return null;
	}
}

/**
 * A feature's part has its own short way: it is built, its checks run, and it is merged into the feature
 * branch. CI, review and the hand-over belong to the feature, so a part's page never shows them as its own.
 */
export function partTrack(
	item: Pick<ItemSummary, "state" | "wait">,
	step: StepKind | null,
): { stages: string[]; at: number; now: boolean; word: string } | null {
	const stages = ["built", "checked", "in the feature"];
	switch (item.state) {
		case "queued":
			return { stages, at: 0, now: false, word: "queued" };
		case "working":
		case "waiting": {
			const checking = step === "run_checks" || step === "gate";
			const word =
				item.state === "waiting" && item.wait ? WAIT_DOING[item.wait.reason] : checking ? "checking" : "building";
			return { stages, at: checking ? 2 : 1, now: item.state === "working", word };
		}
		case "review":
		case "done":
			return { stages, at: stages.length, now: false, word: "in the feature" };
		default:
			return null;
	}
}

export function PartStages({
	item,
	step = null,
}: {
	item: Pick<ItemSummary, "state" | "wait">;
	step?: StepKind | null;
}) {
	const track = partTrack(item, step);
	if (track === null) return null;
	const done = track.at === track.stages.length && !track.now;
	return (
		<ol
			className={`item-stages item-stages-${done ? "done" : track.now ? "work" : "wait"}`}
			aria-label="Where this part is on its way into the feature"
		>
			{track.stages.map((stage, index) => {
				const at = index === track.at - 1;
				const isDone = index < track.at - 1 || (at && done);
				return (
					<li
						key={stage}
						className={`item-stage${isDone ? " item-stage-done" : ""}${at && track.now ? " item-stage-now" : at && !isDone ? " item-stage-at" : ""}`}
						aria-current={at ? "step" : undefined}
					>
						<span className="item-stage-bar" aria-hidden="true" />
						<span className="item-stage-name">{at && !isDone ? track.word : stage}</span>
					</li>
				);
			})}
		</ol>
	);
}

/** The stage (from 1) a step of the blueprint belongs to: building and the checks, the push, CI and its fixes, the second review, the hand-over. */
function stageOfStep(step: StepKind, stages: number, reviewer: boolean): number {
	switch (step) {
		case "subtasks":
		case "refine":
		case "plan_review":
		case "implement":
		case "run_checks":
		case "gate":
			return 1;
		case "publish":
		case "conflict":
		// A feature's summary is pushed before its CI and second review: it is not yours yet.
		case "summary":
			return 2;
		case "ci":
		case "ci_fix":
		case "integration":
			return 3;
		case "review":
		case "review_fix":
			return reviewer ? 4 : 3;
		case "handoff":
		case "merged":
			return stages;
	}
}

/** The track beside a row: one bar a stage, the one it is at lit, and its word. Named for assistive technology in one phrase. */
export function ItemTrack({
	item,
	reviewer = true,
}: {
	item: Pick<ItemSummary, "state" | "wait" | "pullRequest" | "review">;
	reviewer?: boolean;
}) {
	const track = itemTrack(item, reviewer);
	if (track === null) return <span className="item-track item-track-none" aria-hidden="true" />;
	const label =
		track.at === 0
			? `Not built yet: ${track.word}`
			: `${track.stages[Math.min(track.at, track.stages.length) - 1]}, ${Math.min(track.at, track.stages.length)} of ${track.stages.length}: ${track.word}`;
	return (
		<span
			className={`item-track item-track-${track.tone}`}
			role="img"
			aria-label={label}
			title={track.stages.join(" → ")}
		>
			<span className="item-track-bars" aria-hidden="true">
				{track.stages.map((stage, index) => (
					<i
						key={stage}
						className={
							index < track.at - 1 || (index === track.at - 1 && !track.now)
								? "f"
								: index === track.at - 1
									? "now"
									: undefined
						}
					/>
				))}
			</span>
			<span className="item-track-word" aria-hidden="true">
				{track.word}
			</span>
		</span>
	);
}

/**
 * The item page's stepper: the same stages as a row's track, each named, the one it is at lit (and
 * moving, while a turn or CI runs there). An ordered list, so a screen reader reads where it is.
 */
/** What an item does in a step, as the stage it stands at says it. */
const STEP_DOING: Record<StepKind, string> = {
	refine: "planning",
	plan_review: "plan in review",
	subtasks: "parts running",
	implement: "building",
	run_checks: "checking",
	gate: "checking",
	publish: "pushing",
	conflict: "resolving conflicts",
	summary: "writing the summary",
	ci: "CI running",
	ci_fix: "fixing CI",
	integration: "testing",
	review: "in review",
	review_fix: "fixing the review",
	handoff: "handing over",
	merged: "merged",
};

/** What an item waits for, as the stage it stands at says it. */
const WAIT_DOING: Record<NonNullable<ItemSummary["wait"]>["reason"], string> = {
	provider: "waiting for the provider",
	children: "parts running",
	capacity: "waiting for a turn",
	machine: "waiting for a machine",
	ci: "waiting for CI",
	person: "waiting for you",
	budget: "out of budget",
	integration: "testing",
	sandboxes: "waiting for a sandbox",
};

/**
 * The name the stage an item stands at shows: what it does there now. The stages' own names say they are
 * done ("built", "pushed"), which a stage still running or waiting is not.
 */
export function standingWord(item: Pick<ItemSummary, "state" | "wait" | "question">, step: StepKind | null): string {
	if (item.question) return "asks you";
	if (item.state === "review") return "in review";
	const wait = item.state === "waiting" ? item.wait?.reason : undefined;
	if (wait && !(wait === "children" && step !== null)) return WAIT_DOING[wait];
	return step ? STEP_DOING[step] : "building";
}

export function ItemStages({
	item,
	reviewer = true,
	step = null,
}: {
	item: Pick<ItemSummary, "state" | "wait" | "pullRequest" | "review" | "question">;
	reviewer?: boolean;
	step?: StepKind | null;
}) {
	const summary = itemTrack(item, reviewer);
	if (summary === null) return null;
	// The page knows the step the run is at, which the summary does not: a working or waiting item stands at that step's stage.
	// A feature waits for its whole-feature CI while still in its subtasks step: that wait is the CI stage.
	const featureCi = step === "subtasks" && item.wait?.reason === "ci";
	const at =
		step !== null && (item.state === "working" || item.state === "waiting")
			? featureCi
				? 3
				: stageOfStep(step, summary.stages.length, reviewer)
			: null;
	const track = at === null ? summary : { ...summary, at };
	return (
		<ol className={`item-stages item-stages-${track.tone}`} aria-label="Where it is on its way to you">
			{track.stages.map((stage, index) => {
				// The step's own stage is not done while the item works or waits in it (a question while it builds): it is where it stands.
				const standing = at !== null && index === track.at - 1;
				const done = index < track.at - 1 || (index === track.at - 1 && !track.now && !standing);
				const now = index === track.at - 1 && track.now;
				return (
					<li
						key={stage}
						className={`item-stage${done ? " item-stage-done" : ""}${now ? " item-stage-now" : standing ? " item-stage-at" : ""}`}
						aria-current={now || (track.at === index + 1 && !track.now) ? "step" : undefined}
					>
						<span className="item-stage-bar" aria-hidden="true" />
						<span className="item-stage-name">
							{now || standing ? standingWord(item, at === null ? null : step) : stage}
						</span>
					</li>
				);
			})}
		</ol>
	);
}

/** Why the item is where it is, in a line: the server's sentence while it waits, and what ended it. */
function rowWhy(item: ItemSummary): string | null {
	if (item.question) return questionLine(item);
	if (item.state === "waiting" && item.wait) return item.wait.sentence;
	if (item.state === "draft") return "Not started.";
	if (item.state === "queued") return "Started; waiting for its first turn.";
	return null;
}

/** A row's title: a subtask, listed where it asks its person, says its feature first (the list's title is "feature — subtask"). */
function RowTitle({ item }: { item: ItemSummary }) {
	const prefix = item.parent ? `${item.parent.title} — ` : null;
	if (!prefix || !item.title.startsWith(prefix)) return <>{item.title}</>;
	return (
		<>
			<span className="item-row-feature">{item.parent!.title}</span>
			<span className="item-row-feature-sep" aria-hidden="true">
				/
			</span>
			<span className="visually-hidden">, subtask </span>
			{item.title.slice(prefix.length)}
		</>
	);
}

/**
 * One item as a row of a list. `repository`: the row stands under no repository's name, so it says which.
 * An item filed from a GitHub issue links to it, beside its pull request. `ci` says CI's state beside
 * them, and an issue's outside author; `reviewer` false leaves out the second review's word, for a
 * deployment without one.
 * The item's agent session is part of it and is in no list of agents: the row leads to it, once the
 * item has started, as the place to see what the agent did.
 */
/** "filed 3 Nov" this year, "filed Nov 2025" before it: an ended list is in the order items were filed, and says so. */
export function filedDay(at: number, now: number): string {
	return dayWord("filed", at, now);
}

/** "ended 5 Nov" this year, "ended Nov 2025" before it. */
export function dayWord(word: string, at: number, now: number): string {
	const date = new Date(at);
	const thisYear = date.getFullYear() === new Date(now).getFullYear();
	return `${word} ${date.toLocaleDateString("en-GB", thisYear ? { day: "numeric", month: "short" } : { month: "short", year: "numeric" })}`;
}

/** `filed`: the row says when the item was filed, not when it last changed (an ended list, in filing order). */
/** `subtasks`: the feed's open subtasks; a feature's row counts its own and lists the active ones in place of the wait sentence. */
export function ItemRow({
	item,
	now,
	repository = false,
	why,
	ci = false,
	reviewer = true,
	filed = false,
	subtasks,
}: {
	item: ItemSummary;
	now: number;
	repository?: boolean;
	why?: ReactNode;
	ci?: boolean;
	reviewer?: boolean;
	filed?: boolean;
	subtasks?: readonly ItemSummary[];
}) {
	const asks = item.question !== null;
	const line = why ?? rowWhy(item);
	const origin = item.origin && originIssue(item.origin);
	const running =
		!asks && item.mode === "orchestrate" && subtasks !== undefined && childrenOf(item, subtasks).length > 0;
	return (
		<li
			className={`agent-row item-row item-row-is-${item.state}${asks ? " item-row-asks" : ""}${item.state === "working" ? " agent-row-active" : ""}${filed ? " item-row-filed" : ""}`}
		>
			<span className="agent-glyph">
				<ItemGlyph item={item} />
			</span>
			<div className="agent-main">
				<a className="agent-title" {...linkProps({ name: "item", id: item.id })}>
					<RowTitle item={item} />
					{asks ? <span className="visually-hidden"> (waiting for your answer)</span> : null}
				</a>
				{running ? (
					<FactorySubtasks feature={item} children={subtasks!} now={now} />
				) : line ? (
					<LongText lines={2} className="item-row-why">
						{line}
					</LongText>
				) : null}
				<p className="agent-meta">
					{repository ? (
						<span className="agent-repo">
							{item.repository.owner}/{item.repository.name}
						</span>
					) : (
						<span className="agent-repo">into {item.repository.branch}</span>
					)}
					{item.pullRequest ? (
						<span>
							<a className="item-pull" href={item.pullRequest.url} target="_blank" rel="noreferrer">
								{requestNumber(item.repository.provider, item.pullRequest.number)}
								<ExternalIcon size={10} />
							</a>
						</span>
					) : null}
					{item.source !== "web" ? (
						<span>
							<ItemSourceTag source={item.source} origin={item.origin} />
						</span>
					) : null}
					{origin && !origin.trusted ? <span>from an outside author</span> : null}
					{item.agent && item.agent.harness !== "windlass" ? (
						<span>
							<AgentGlyph harness={item.agent.harness} size={11} inline />
							{HARNESS_NAMES[item.agent.harness]}
						</span>
					) : null}
					{ci && item.verdict ? (
						<span className={`tone-${CI_WORD[item.verdict.ci].tone}`}>{CI_WORD[item.verdict.ci].word}</span>
					) : null}
					{item.state === "draft" || item.awaitingPlace ? null : (
						<span>
							<a
								className="item-pull"
								{...linkProps({ name: "session", id: item.sessionId })}
								title="What its agent did, turn by turn"
								aria-label={`The agent of ${item.title}`}
							>
								its agent
							</a>
						</span>
					)}
				</p>
			</div>
			<div className="agent-state">
				{asks ? <StatusBadge status="waiting" /> : null}
				<ItemStanding item={item} reviewer={reviewer} />
			</div>
			<ItemTrack item={item} reviewer={reviewer} />
			{filed ? (
				<span className="agent-time item-row-dates">
					<time
						dateTime={new Date(item.createdAt).toISOString()}
						title={`Filed ${absoluteTime(item.createdAt)}; last changed ${absoluteTime(item.updatedAt)}`}
					>
						{filedDay(item.createdAt, now)}
					</time>
					{item.endedAt !== undefined ? (
						<time dateTime={new Date(item.endedAt).toISOString()} title={`Ended ${absoluteTime(item.endedAt)}`}>
							{dayWord("ended", item.endedAt, now)}
						</time>
					) : null}
				</span>
			) : (
				<time
					className="agent-time"
					dateTime={new Date(item.updatedAt).toISOString()}
					title={absoluteTime(item.updatedAt)}
				>
					{relativeTime(item.updatedAt, now)}
				</time>
			)}
		</li>
	);
}
