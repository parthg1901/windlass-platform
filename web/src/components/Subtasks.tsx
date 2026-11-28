/**
 * A feature's subtasks while they run, where a person looks for them:
 *
 * - `SubtasksBlock`, on the feature's page once its plan is approved: how many are integrated, a bar of
 *   one segment a subtask, then three groups (lib/subtasks.ts, `groupSubtasks`): "Running now (2 of 3)",
 *   a compact row each with what it is doing, where it runs, for how long and its session; "Up next",
 *   each with what holds it (a dependency, a running one's files, a full set of slots); and "Done",
 *   folded to its counts. A subtask that asks gets the start of its question and Answer.
 * - `SubtaskStrip`, on a subtask's page: a numbered chip a sibling, and the ones running alongside it.
 * - `FactorySubtasks`, under a feature's row in the Factory: the tally of the subtasks that are open,
 *   and only the active ones (running or asking), each with its step word and place.
 *
 * All of them read the summaries the live feed keeps current (`ItemFeed.children`), and none assumes
 * one subtask at a time.
 */
import type { FeaturePlan, ItemSummary, ItemView } from "@contract";
import { useId, useState, type ReactNode } from "react";
import { FoldToggle, LongText } from "./Fold";
import { absoluteTime, plural } from "../lib/format";
import { linkProps } from "../lib/router";
import {
	activeSubtasks,
	doingNow,
	elapsed,
	groupSubtasks,
	plannedSubtasks,
	REPAIR_WHY,
	subtaskState,
	type PlannedSubtask,
	type SubtaskLine,
	type SubtaskState,
} from "../lib/subtasks";
import { ItemGlyph } from "./ItemRow";

const STATE_LABEL: Record<SubtaskState, string> = {
	running: "running",
	asks: "asks you",
	done: "done",
	stopped: "stopped",
	to_go: "not started",
};

/** One segment a subtask, in plan order, coloured by where it is. */
export function SegmentBar({ states }: { states: SubtaskState[] }) {
	return (
		<span
			className="subtask-segments"
			role="img"
			aria-label={states.map((state, index) => `${index + 1} ${STATE_LABEL[state]}`).join(", ")}
		>
			{states.map((state, index) => (
				<i key={index} className={`subtask-segment subtask-segment-${state}`} />
			))}
		</span>
	);
}

/** The start of what a subtask asks: the agent's own words where it asked in them, else the platform's sentence. */
const askedText = (child: ItemSummary): string => child.question?.asked?.text ?? child.question?.text ?? "";

/** A subtask's number and title, linking to its page once it has one. */
function SubtaskName({ entry, className = "subtask-run-link" }: { entry: PlannedSubtask; className?: string }) {
	return (
		<>
			<span className="subtask-run-n">{entry.repair ? "fix" : entry.n}</span>
			{entry.child ? (
				<a className={className} {...linkProps({ name: "item", id: entry.child.id })}>
					{entry.task.title}
				</a>
			) : (
				<span>{entry.task.title}</span>
			)}
		</>
	);
}

/** A subtask named inline in a sentence: "2 Convert units on import", linking to it where it can. */
function NamedSubtask({ entry }: { entry: PlannedSubtask }) {
	return (
		<span className="subtask-named">
			<SubtaskName entry={entry} className="subtask-named-link" />
		</span>
	);
}

/** Why a subtask not started yet waits: its dependencies, a running one's files, or a full set of slots. */
function WaitsFor({ line }: { line: SubtaskLine }) {
	if (line.phase === "after" && line.after) {
		return (
			<span className="subtask-run-fact">
				{line.after.map((entry, index) => (
					<span key={entry.task.key}>
						{index > 0 ? (index === line.after!.length - 1 ? " and " : ", ") : null}
						<NamedSubtask entry={entry} />
					</span>
				))}
			</span>
		);
	}
	if (line.phase === "files" && line.files) {
		return (
			<span className="subtask-run-fact">
				{line.files.path ? (
					<>
						<code className="plan-code">{line.files.path}</code>, owned by <NamedSubtask entry={line.files.owner} />
					</>
				) : (
					<>
						<NamedSubtask entry={line.files.owner} />, as one of them lists no files of its own
					</>
				)}
			</span>
		);
	}
	return line.fact ? <span className="subtask-run-fact">{line.fact}</span> : null;
}

function SubtaskLineRow({ line, now }: { line: SubtaskLine; now: number }) {
	const { entry, phase } = line;
	const { child } = entry;
	const options = child?.question?.asked?.options.length ?? 0;
	const started =
		line.since !== null && !["after", "files", "slot", "starting", "integrated", "failed", "cancelled"].includes(phase);
	return (
		<li className={`subtask-run subtask-run-${entry.state} subtask-phase-${phase}`}>
			<span className="subtask-run-glyph" aria-hidden="true">
				{child && phase !== "place" ? <ItemGlyph item={child} /> : <span className="item-glyph-waiting" />}
			</span>
			<div className="subtask-run-main">
				<p className="subtask-run-title">
					<SubtaskName entry={entry} />
				</p>
				{entry.repair ? <p className="subtask-run-why">{REPAIR_WHY[entry.repair]}</p> : null}
				<p className="subtask-run-doing">
					<span className="subtask-run-word">{line.word}</span>
					{phase === "checks" && line.fact ? (
						<code className="plan-code subtask-run-fact">{line.fact}</code>
					) : phase === "place" && line.fact ? (
						<span className="subtask-run-fact subtask-run-wait">{line.fact}</span>
					) : (
						<WaitsFor line={line} />
					)}
				</p>
				{child?.question ? (
					<div className="subtask-run-asks">
						<LongText lines={2}>{askedText(child)}</LongText>
						<p className="subtask-run-answer">
							<a className="button button-primary button-small" {...linkProps({ name: "item", id: child.id })}>
								Answer
							</a>
							{options > 0 ? <span className="tone-dim">{plural(options, "suggested answer")}</span> : null}
						</p>
					</div>
				) : null}
			</div>
			{line.place || started || (child && child.state !== "draft") ? (
				<p className="subtask-run-facts">
					{line.place ? <span className="subtask-run-place">{line.place}</span> : null}
					{started ? (
						<span className="subtask-run-time" title={`Started ${absoluteTime(line.since!)}`}>
							{elapsed(now - line.since!)}
						</span>
					) : null}
					{child && child.state !== "draft" ? (
						<a
							className="link subtask-run-session"
							{...linkProps({ name: "session", id: child.sessionId })}
							aria-label={`Session of ${entry.task.title}`}
						>
							Session
						</a>
					) : null}
				</p>
			) : null}
		</li>
	);
}

/** Whether the feature's page shows its subtasks as they run: its plan is approved and the feature has not ended. */
export function showsSubtasks(view: Pick<ItemView, "plan" | "children" | "state" | "mode">): boolean {
	return (
		view.mode === "orchestrate" &&
		view.plan?.status === "approved" &&
		view.plan.subtasks.length > 0 &&
		!["done", "failed", "cancelled"].includes(view.state)
	);
}

/** "1 integrated · 1 failed · 1 repair integrated": the done group's counts, by how each ended, the factory's repairs apart from the plan's parts. */
export function doneWords(done: readonly SubtaskLine[]): string {
	const counts = new Map<string, number>();
	for (const line of done) {
		const word = line.entry.repair ? `repair ${line.word}` : line.word;
		counts.set(word, (counts.get(word) ?? 0) + 1);
	}
	const order = ["integrated", "failed", "cancelled"];
	return [...order, ...order.map(word => `repair ${word}`)]
		.filter(word => counts.has(word))
		.map(word => `${counts.get(word)} ${word}`)
		.join(" · ");
}

/**
 * The feature page's block of its subtasks: "Running now (2 of 3)" first, each with what it is doing,
 * where and for how long; then "Up next", each with what holds it; then "Done", folded to its counts.
 */
export function SubtasksBlock({
	plan,
	children,
	jobs,
	wait,
	now,
	cost,
}: {
	/** The feature's cost so far, as "Cost so far" says it (lib/cost.ts `costWords`): one figure on the page. */
	cost?: string | null;
	plan: FeaturePlan;
	children: readonly ItemSummary[];
	jobs?: ItemView["subtasks"];
	wait?: ItemView["wait"];
	now: number;
}) {
	const subtasks = plannedSubtasks(plan, children);
	const groups = groupSubtasks(plan, children, jobs, wait);
	const [showDone, setShowDone] = useState(false);
	const doneId = useId();
	const planKeys = new Set(plan.subtasks.map(task => task.key));
	const integrated = groups.done.filter(
		line => line.phase === "integrated" && planKeys.has(line.entry.task.key),
	).length;
	return (
		<section className="subtasks-block" aria-label="Subtasks">
			<header className="subtasks-head">
				<h2 className="subtasks-title">Subtasks</h2>
				<span className="subtask-tally">
					<span className="subtask-tally-part">
						<strong>{integrated}</strong> of {subtasks.length} integrated
					</span>
				</span>
				<SegmentBar states={subtasks.map(entry => entry.state)} />
			</header>
			{groups.running.length > 0 ? (
				<SubtaskGroup label="Running now" count={`${groups.running.length} of ${groups.slots}`}>
					{groups.running.map(line => (
						<SubtaskLineRow key={line.entry.task.key} line={line} now={now} />
					))}
				</SubtaskGroup>
			) : null}
			{groups.next.length > 0 ? (
				<SubtaskGroup label="Up next" count={String(groups.next.length)}>
					{groups.next.map(line => (
						<SubtaskLineRow key={line.entry.task.key} line={line} now={now} />
					))}
				</SubtaskGroup>
			) : null}
			{groups.done.length > 0 ? (
				<div className="subtask-group subtask-group-done">
					<p className="subtask-group-head">
						<span className="subtask-group-label">Done</span>
						<span className="subtask-group-count">{doneWords(groups.done)}</span>
						<FoldToggle
							open={showDone}
							controls={doneId}
							label="Show"
							onToggle={() => setShowDone(open => !open)}
							className="subtask-group-toggle"
						/>
					</p>
					<ol className="subtask-runs" id={doneId} hidden={!showDone}>
						{showDone
							? groups.done.map(line => <SubtaskLineRow key={line.entry.task.key} line={line} now={now} />)
							: null}
					</ol>
				</div>
			) : null}
			{cost ? (
				<p className="subtasks-foot">
					<span>
						{cost} <span className="tone-faint">so far, the feature with its parts</span>
					</span>
				</p>
			) : null}
		</section>
	);
}

function SubtaskGroup({ label, count, children }: { label: string; count: string; children: ReactNode }) {
	return (
		<div className="subtask-group">
			<p className="subtask-group-head">
				<span className="subtask-group-label">{label}</span>
				<span className="subtask-group-count">{count}</span>
			</p>
			<ol className="subtask-runs" aria-label={label}>
				{children}
			</ol>
		</div>
	);
}

/** Which of the feature's subtasks this one is: "Part 2 of 5", for the line that links back to the feature. */
export function partOf(plan: Pick<FeaturePlan, "subtasks">, key: string): { n: number; of: number } | null {
	const index = plan.subtasks.findIndex(task => task.key === key);
	return index < 0 ? null : { n: index + 1, of: plan.subtasks.length };
}

/** A subtask's place among its siblings, under its title: a chip a sibling, then the ones running alongside it. */
export function SubtaskStrip({
	plan,
	children,
	jobs,
	current,
}: {
	plan: FeaturePlan;
	children: readonly ItemSummary[];
	jobs?: ItemView["subtasks"];
	current: string;
}) {
	const subtasks = plannedSubtasks(plan, children);
	if (!subtasks.some(entry => entry.task.key === current)) return null;
	const alongside = groupSubtasks(plan, children, jobs).running.filter(line => line.entry.task.key !== current);
	return (
		<nav className="subtask-strip" aria-label="Subtasks of the feature">
			<ol className="subtask-chips">
				{subtasks.map(entry => {
					const label = `${entry.n}. ${entry.task.title}: ${STATE_LABEL[entry.state]}`;
					const className = `subtask-chip subtask-chip-${entry.state}${entry.task.key === current ? " subtask-chip-current" : ""}`;
					return (
						<li key={entry.task.key}>
							{entry.child && entry.task.key !== current ? (
								<a
									className={className}
									{...linkProps({ name: "item", id: entry.child.id })}
									aria-label={label}
									title={label}
								>
									{entry.n}
								</a>
							) : (
								<span
									className={className}
									aria-label={label}
									title={label}
									aria-current={entry.task.key === current ? "page" : undefined}
								>
									{entry.n}
								</span>
							)}
						</li>
					);
				})}
			</ol>
			{alongside.length > 0 ? (
				<span className="subtask-strip-alongside">
					Running alongside:{" "}
					{alongside.map((line, index) => (
						<span key={line.entry.task.key}>
							{index > 0 ? ", " : null}
							<NamedSubtask entry={line.entry} />
						</span>
					))}
				</span>
			) : null}
		</nav>
	);
}

/** The open subtasks of a feature in the feed, newest filed last: what the Factory's row counts. */
export const childrenOf = (
	feature: Pick<ItemSummary, "id">,
	children: readonly ItemSummary[] | undefined,
): ItemSummary[] =>
	(children ?? []).filter(child => child.parent?.itemId === feature.id).sort((a, b) => a.createdAt - b.createdAt);

/**
 * Under a feature's row in the Factory: how many of its subtasks run and ask, and the active ones,
 * each with its step word and place, linking to it. The feed carries open subtasks only, so the row
 * counts those; the feature's page has the whole plan.
 */
export function FactorySubtasks({
	feature,
	children,
	now,
}: {
	feature: ItemSummary;
	children: readonly ItemSummary[];
	now: number;
}) {
	const mine = childrenOf(feature, children);
	if (mine.length === 0) return null;
	// The feed has no plan: each open subtask stands for itself, in the order it was made.
	const entries: PlannedSubtask[] = mine.map((child, index) => ({
		n: index + 1,
		child,
		state: subtaskState(child),
		task: {
			key: child.parent!.key,
			title: child.title,
			brief: "",
			acceptance: [],
			dependsOn: [],
			owns: [],
			budget: child.budget,
		},
	}));
	const active = activeSubtasks(entries);
	const running = entries.filter(entry => entry.state === "running").length;
	const asks = entries.filter(entry => entry.state === "asks").length;
	return (
		<div className="factory-subtasks">
			<p className="factory-subtasks-tally">
				<span className="subtask-tally">
					{running > 0 ? (
						<span className="subtask-tally-part subtask-tally-running">
							<strong>{running}</strong> running
						</span>
					) : null}
					{asks > 0 ? (
						<span className="subtask-tally-part subtask-tally-asks">
							<strong>{asks}</strong> {asks === 1 ? "asks you" : "ask you"}
						</span>
					) : null}
				</span>
				<SegmentBar states={entries.map(entry => entry.state)} />
			</p>
			{active.length > 0 ? (
				<ul className="factory-subtask-list" aria-label={`Active subtasks of ${feature.title}`}>
					{active.map(entry => {
						const doing = doingNow(entry, new Map(), new Set(), now);
						const place = entry.child!.placement?.name ?? null;
						return (
							<li key={entry.child!.id} className={`factory-subtask factory-subtask-${entry.state}`}>
								<span className="factory-subtask-dot" aria-hidden="true" />
								<a className="factory-subtask-title" {...linkProps({ name: "item", id: entry.child!.id })}>
									{entry.task.title}
								</a>
								<span className="factory-subtask-doing">
									{doing.word}
									{place ? ` · ${place}` : ""}
								</span>
							</li>
						);
					})}
				</ul>
			) : null}
		</div>
	);
}
