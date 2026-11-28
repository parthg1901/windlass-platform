import { afterWords } from "../lib/subtasks";
import { perHour } from "../lib/sizes";
import { modelWords } from "../lib/models";
import {
	HOSTED_SIZE_NAMES,
	MAX_NOTE_CHARS,
	type FeaturePlan,
	type HarnessId,
	type ItemBudget,
	type SubtaskBudget,
	type ItemQuestion,
	type ItemSummary,
	type ItemView,
	type MachineSummary,
	type ModelList,
	type PlanSubtask,
	type SubtaskAgent,
	type Waiting,
} from "@contract";
import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { approvalHeld, singleAfterPlanning, subtaskHarness } from "../../../server/src/factory/feature-plan.js";
import { usesAccountModels } from "../../../server/src/sandbox/harnesses.js";
import { ArrowDownIcon, ChevronIcon, InfoIcon, WarnIcon } from "../components/Icons";
import { ItemSpend } from "../components/ItemSpend";
import { FOLD_WORDS, FoldList, FoldToggle, LongText, PathList } from "../components/Fold";
import { showsSubtasks } from "../components/Subtasks";
import { Menu, type MenuItem, type MenuSpec } from "../components/ui/Menu";
import { AgentGlyph, Pill } from "../components/ui/Pill";
import { machineLabel } from "../lib/machines";
import { HARNESS_NAMES } from "../lib/acp";
import { SOURCE_WORDS, placeName, payerWords, runModelName, sourceOf } from "../lib/run";
import { runAgent, type ResolvedRun } from "../../../server/src/factory/resolve-run";
import {
	HOSTED,
	OWNER_REASON,
	needsWords,
	routeWords,
	secretsFor,
	nextSubtask,
	orchestratorOf,
	parentPlaceName,
	placeChanged,
	placeDraftOf,
	placedWords,
	placeWord,
	refusalFor,
	refusedSubtask,
	withPlace,
	type PlaceDraft,
} from "../lib/placement";
import { compact, plural } from "../lib/format";
import { subscriptionSpend } from "../lib/item-agent";
import type { useHostedCredentials } from "../state/hooks";
import { effortsOf, harnessOptions } from "../lib/models";
import { modelMenu as sharedModelMenu } from "../components/ModelPicker";
import { effortGroup } from "../components/TrayControls";
import {
	agentChanged,
	agentChoices,
	agentParts,
	cleanAgent,
	machineModels,
	preferredMachine,
	UNATTENDED_MEANS,
	UNATTENDED_WORDS,
	worksWithoutAsking,
	type Catalogs,
} from "../lib/subtask-agents";
import { subtaskFloor, sumBudgets } from "../lib/feature";
import { figureWords, moneyFields, partBudget, spendWords } from "../lib/budget";
import type { PlanActing, PlanReview } from "./usePlanReview";
import { linkProps } from "../lib/router";
import { ItemGlyph, ItemTrack, itemTrack } from "../components/ItemRow";
import { STATE_WORD } from "../lib/items";
import { Check } from "../components/ui/Check";
import { Tooltip } from "../components/ui/Tooltip";
import { useDefaults } from "../components/StartComposer";
import { useApp, useAuth } from "../state/app";

function approvalProblem(review: PlanReview, unconfirmed: number): string | null {
	if (review.problems.any) return "Fix the figures marked below first.";
	if (review.edits) return "Save your changes, then approve this version.";
	const unanswered = review.unansweredLeft;
	if (unanswered) return `Answer ${unanswered === 1 ? "the question" : `the ${unanswered} questions`} first.`;
	if (unconfirmed)
		return `Confirm ${unconfirmed === 1 ? "the agent that works" : `the ${unconfirmed} agents that work`} without asking first.`;
	return null;
}

export function PlanQuestion({
	view,
	review,
	acting,
	when,
	conflicted,
	onSettingError,
}: {
	view: ItemView;
	review: PlanReview;
	acting: PlanActing;
	when: ReactNode;
	conflicted: boolean;
	onSettingError(): void;
}) {
	const { plan } = review;
	const title = useId();
	const { client } = useApp();
	const auth = useAuth();
	const { defaults } = useDefaults(view.repository.id);
	const offerAutoApprove = defaults !== null && !defaults.autoApprovePlans;
	const [autoApprove, setAutoApprove] = useState(false);
	const approve = async (choice?: Parameters<PlanReview["approve"]>[0]) => {
		const approved = await review.approve(choice);
		if (!approved || !offerAutoApprove || !autoApprove) return;
		try {
			await client.user(auth).saveRepositoryDefaults(view.repository.id, { autoApprovePlans: true });
		} catch {
			onSettingError();
		}
	};
	if (!plan || !view.question) return null;
	const busy = acting.busy !== null;
	const single = view.question.kind === "single_suggested";
	const replan = view.question.kind === "replan_approval";
	const ciBlock = view.question.approvalBlock;
	const question = view.question;
	const offered = (id: string) => question.choices.some(choice => choice.id === id);
	const canApprove = offered(single ? "run_single" : "approve");
	// The rule Slack reads too: open questions and the approval block hold an approval back.
	const held = (id: string) => approvalHeld(plan, question, id, review.answers);
	const refused = review.refusal;
	const unplaceable = single
		? []
		: plan.subtasks.filter(task => !view.completedSubtasks?.includes(task.key) && task.placementProblem);
	const unconfirmed = single ? 0 : review.unconfirmed;
	const blocked = approvalProblem(review, unconfirmed);
	// Only a permanent placement refusal blocks approval.
	const placeBlocked = blocked === null && unplaceable.length > 0 ? unplaceable[0]! : null;
	return (
		<section className="item-question plan-question" aria-labelledby={title}>
			<p className="item-question-head" id={title}>
				It asks you
				<span className="item-question-when">{when}</span>
			</p>
			<LongText className="item-question-text" lines={3}>
				{question.text}
			</LongText>
			{!single && <PlanJump view={view} plan={plan} replan={replan} />}

			{view.question.criticFindings && (
				<div className="callout callout-warn">
					<div>
						Critic recommends revision
						<ul>
							{view.question.criticFindings.map((finding, i) => (
								<li key={i}>{finding}</li>
							))}
						</ul>
					</div>
				</div>
			)}
			{plan.subtasks.length > 0 ? (
				<PlanRoutes
					view={view}
					plan={plan}
					machines={review.machines}
					catalogs={review.catalogs}
					accountModels={review.accountModels}
					refusal={refused}
				/>
			) : null}

			{!single && review.unattended.length > 0 ? (
				<UnattendedConfirm plan={plan} review={review} disabled={busy || review.edits} />
			) : null}

			{plan.questions.length > 0 ? (
				<div className="plan-asks">
					{plan.questions.map(question => (
						<PlanAsk
							key={question.id}
							question={question}
							edit={{
								value: review.answers[question.id] ?? "",
								disabled: busy,
								onChange: text => review.setAnswer(question.id, text),
							}}
						/>
					))}
				</div>
			) : null}

			{conflicted ? (
				<p className="callout callout-warn" role="status">
					<WarnIcon />
					<span>
						The plan changed while you read it, here or in another tab: version {plan.version} is shown now. Check it,
						then approve again.
					</span>
				</p>
			) : null}
			{ciBlock && (
				<p className="callout callout-warn" role="status">
					<WarnIcon />
					<span>{ciBlock}</span>
				</p>
			)}
			{refused && refused !== ciBlock ? (
				<div className="callout callout-bad plan-refused" role="alert">
					<WarnIcon />
					<span>{refused}</span>
				</div>
			) : acting.error && !refused && !conflicted ? (
				<p className="callout callout-bad" role="alert">
					<WarnIcon />
					<span>{acting.error}</span>
				</p>
			) : null}

			<div className="item-choices">
				{review.edits || (!single && review.answersOnly) ? (
					<>
						<button
							type="button"
							className="button button-primary"
							disabled={busy || review.problems.any}
							onClick={() => void review.save()}
						>
							{acting.busy === "edit_plan" ? "Saving…" : `Save as version ${plan.version + 1}`}
						</button>
						<button type="button" className="button button-quiet" disabled={busy} onClick={review.reset}>
							Discard changes
						</button>
					</>
				) : canApprove ? (
					<button
						type="button"
						className="button button-primary"
						disabled={busy || held(single ? "run_single" : "approve") || blocked !== null || placeBlocked !== null}
						onClick={() =>
							void approve(single ? { kind: "answer", question: question.id, choice: "run_single" } : undefined)
						}
						aria-describedby={blocked || placeBlocked ? `${title}-why` : undefined}
					>
						{acting.busy === "edit_plan" || acting.busy === "approve_plan" || acting.busy === "run_single"
							? "Approving…"
							: single
								? "Approve for one implementer"
								: `Approve version ${plan.version}`}
					</button>
				) : null}
				{canApprove && offerAutoApprove && !review.edits && (
					<div className="plan-auto-approve">
						<Check
							checked={autoApprove}
							disabled={busy}
							onChange={setAutoApprove}
							label={`Approve small plans automatically in ${view.repository.owner}/${view.repository.name}`}
						/>
						<Tooltip content="Up to 3 parts and at most 3× a Quick item's budget. Any open question needs a recommended answer the reviewer accepts.">
							<button
								type="button"
								className="icon-button icon-button-small"
								aria-label="Which plans can be approved automatically?"
							>
								<InfoIcon size={15} />
							</button>
						</Tooltip>
					</div>
				)}
				{!review.edits &&
					question.choices
						.filter(choice => choice.id !== "approve" && !(single && choice.id === "run_single"))
						.map(choice => (
							<button
								key={choice.id}
								type="button"
								className={`button ${choice.id === "give_up" ? "button-quiet" : "button-outline"}`}
								disabled={busy || held(choice.id)}
								onClick={() => void acting.act({ kind: "answer", question: question.id, choice: choice.id })}
							>
								{choice.label}
							</button>
						))}
			</div>
			{blocked && !review.edits ? (
				<p className="field-note" id={`${title}-why`}>
					{blocked}
				</p>
			) : placeBlocked && !review.edits ? (
				<p className="field-note plan-blocked-place" id={`${title}-why`}>
					<span className="plan-blocked-dot" aria-hidden="true" />
					<span>
						<strong>{placeBlocked.title}</strong>
						{unplaceable.length > 1 ? ` and ${unplaceable.length - 1} more` : ""} can't be placed:{" "}
						{placeBlocked.placementProblem} Choose another place below and save, or ask for a new plan.
					</span>
				</p>
			) : null}

			{!single && plan.subtasks.some(task => task.needs?.cpus !== undefined || task.needs?.memoryGiB !== undefined) && (
				<details className="field-note">
					<summary>How subtask sizes are chosen</summary>
					Hosted uses the chosen size. A larger resource request needs approval. A machine uses its own slots.
				</details>
			)}
		</section>
	);
}

/** Parts a re-plan adds and drops, against the subtasks already started or finished. */
export function replanChanges(
	view: Pick<ItemView, "children" | "completedSubtasks">,
	plan: Pick<FeaturePlan, "subtasks">,
): { added: string[]; dropped: string[] } {
	const started = new Set([
		...(view.completedSubtasks ?? []),
		...(view.children ?? []).flatMap(child => (child.parent ? [child.parent.key] : [])),
	]);
	const keys = new Set(plan.subtasks.map(task => task.key));
	return {
		added: plan.subtasks.filter(task => !started.has(task.key)).map(task => task.title),
		dropped: (view.children ?? [])
			.filter(
				child => child.parent && !keys.has(child.parent.key) && !["done", "cancelled", "failed"].includes(child.state),
			)
			.map(child => child.title),
	};
}

function changeWords({ added, dropped }: { added: string[]; dropped: string[] }): string | null {
	const list = (titles: string[]) =>
		titles.slice(0, 2).join("; ") + (titles.length > 2 ? ` and ${titles.length - 2} more` : "");
	const words = [
		added.length ? `Adds ${plural(added.length, "part")}: ${list(added)}` : null,
		dropped.length ? `Drops ${plural(dropped.length, "part")}: ${list(dropped)}` : null,
	].filter(Boolean);
	return words.length ? `${words.join(". ")}.` : null;
}

/** The plan sits below the question: a clear way to it, and for a re-plan what changed. */
function PlanJump({ view, plan, replan }: { view: ItemView; plan: FeaturePlan; replan: boolean }) {
	const changed = replan ? changeWords(replanChanges(view, plan)) : null;
	const show = () => {
		const target = document.getElementById(`feature-plan-${plan.version}`);
		if (!target) return;
		target.scrollIntoView({ behavior: "smooth", block: "start" });
		target.classList.remove("plan-flash");
		void target.offsetWidth;
		target.classList.add("plan-flash");
		target.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
	};
	return (
		<div className="plan-jump">
			{changed ? <p className="plan-jump-changed">{changed}</p> : null}
			<button type="button" className="button button-outline plan-jump-button" onClick={show}>
				{replan ? "Read the revised plan" : "Read the plan"}
				<ArrowDownIcon size={12} />
			</button>
		</div>
	);
}

export function questionParts(question: Pick<FeaturePlan["questions"][number], "text" | "why">): {
	ask: string;
	why: string | null;
} {
	if (question.why) return { ask: question.text, why: question.why };
	// Without separate background, keep the question sentence visible.
	if (question.text.length <= ASK_SHORT) return { ask: question.text, why: null };
	const sentences = question.text.match(/[^.?!]+(?:[.?!]+["”’)]?|$)\s*/g)?.filter(one => one.trim() !== "") ?? [
		question.text,
	];
	const asking = [...sentences].reverse().find(one => one.trim().endsWith("?")) ?? sentences[0]!;
	const rest = sentences
		.filter(one => one !== asking)
		.join("")
		.trim();
	return { ask: asking.trim(), why: rest || null };
}

const ASK_SHORT = 160;

function PlanAsk({
	question,
	edit,
}: {
	question: FeaturePlan["questions"][number];
	edit?: { value: string; disabled: boolean; onChange(text: string): void };
}) {
	const id = useId();
	const { ask, why } = questionParts(question);
	const background = why ? (
		<details className="plan-ask-why">
			<summary>
				<ChevronIcon size={11} className="plan-task-more-chevron" />
				Why it asks
			</summary>
			<p>{why}</p>
		</details>
	) : null;
	if (question.answer) {
		return (
			<div className="plan-ask plan-ask-answered">
				<p className="plan-ask-text">{ask}</p>
				<p className="plan-ask-answer">
					<span className="plan-ask-by">
						{question.answeredBy === "critic" ? "The plan reviewer's answer" : "Your answer"}
					</span>{" "}
					{question.answer}
				</p>
				{background}
			</div>
		);
	}
	if (!edit) return null;
	const { value, disabled, onChange } = edit;
	return (
		<div className="plan-ask">
			<p className="plan-ask-text" id={id}>
				{ask}
			</p>
			{background}
			{question.options?.length ? (
				<div className="plan-ask-options" role="radiogroup" aria-labelledby={id}>
					{question.options.map(option => (
						<label key={option} className={`plan-ask-option${value === option ? " plan-ask-chosen" : ""}`}>
							<input
								className="check-input"
								type="radio"
								name={id}
								value={option}
								checked={value === option}
								disabled={disabled}
								onChange={() => onChange(option)}
							/>
							<span className="plan-ask-dot" aria-hidden="true" />
							<span className="plan-ask-label">{option}</span>
						</label>
					))}
				</div>
			) : (
				<input
					className="input"
					aria-labelledby={id}
					value={value}
					readOnly={disabled}
					onChange={event => onChange(event.target.value)}
				/>
			)}
		</div>
	);
}

const SPEC_SHOWN = 3;

export function PlanSection({ view, review, acting }: { view: ItemView; review: PlanReview; acting: PlanActing }) {
	const { plan, pool } = review;
	const heading = useId();
	const [opened, setOpened] = useState(false);
	if (!plan || !pool) return null;
	const singleSpend =
		view.mode === "single" || plan.subtasks.length === 0
			? (() => {
					const budget =
						view.mode === "single" ? view.budget : singleAfterPlanning(plan.compare.singleBudget, view.spent);
					return (
						<>
							<p className="plan-single">Runs as one item after this plan</p>
							<ItemSpend spent={view.spent} budget={budget} fields={moneyFields(budget, view.spent)} />
						</>
					);
				})()
			: null;
	if (plan.status === "superseded") {
		return (
			<section
				className={`usage-section feature-plan plan-set-aside${opened ? " plan-set-aside-open" : ""}`}
				aria-labelledby={heading}
			>
				<h2 className="usage-title plan-set-aside-title" id={heading}>
					<button
						type="button"
						className="plan-set-aside-row"
						aria-expanded={opened}
						onClick={() => setOpened(value => !value)}
					>
						<ChevronIcon
							size={12}
							className={`plan-set-aside-chevron${opened ? " plan-set-aside-chevron-open" : ""}`}
						/>
						<span className="plan-set-aside-name">The plan</span>
						<span className="usage-count">
							v{plan.version} · {plan.status}
						</span>
						<span className="plan-set-aside-goal">{plan.spec.goal.replace(/`/g, "")}</span>
					</button>
				</h2>
				{opened ? (
					<div className="plan-set-aside-body">
						<p className="plan-set-aside-note">
							{view.mode === "single"
								? "Set aside: the work runs as one item, under its own budget."
								: "Set aside: no subtask of it runs any more."}
						</p>
						<PlanBody view={view} review={review} acting={acting} pool={pool} />
					</div>
				) : null}
				{singleSpend}
			</section>
		);
	}
	const folds = showsSubtasks(view) && !review.open;
	const body = `${heading}-body`;
	return (
		<section className="usage-section feature-plan" aria-labelledby={heading}>
			<h2 className="usage-title" id={heading} tabIndex={-1}>
				The plan
				<span className="usage-count">
					v{plan.version} · {plan.status}
				</span>
			</h2>
			{plan.approvedBy === "critic" && (
				<p className="field-note">
					Plan approved automatically by an independent reviewer.{" "}
					<a
						className="link"
						aria-label="Change work item approvals"
						{...linkProps({ name: "repository", id: view.repository.id, section: "autonomy" })}
					>
						Change
					</a>
				</p>
			)}
			{folds && !opened ? (
				<>
					<div className="long-text">
						<p className="long-text-body plan-goal" data-clamped="true" style={{ "--lines": 3 } as CSSProperties}>
							<Inline text={plan.spec.goal} />
						</p>
					</div>
					{/* What was answered stays in sight while the rest of the plan is folded. */}
					{plan.questions
						.filter(question => question.answer)
						.map(question => (
							<PlanAsk key={question.id} question={question} />
						))}
					<p className="plan-folded">
						<FoldToggle open={false} controls={body} label={FOLD_WORDS.all} onToggle={() => setOpened(true)} />
						<span className="tone-dim">
							{[...specParts(plan), plural(plan.subtasks.length, "subtask brief")].join(" · ")}
						</span>
					</p>
				</>
			) : (
				<div id={body}>
					<PlanBody view={view} review={review} acting={acting} pool={pool} />
					{folds ? (
						<p className="plan-folded">
							<FoldToggle open controls={body} label={FOLD_WORDS.all} onToggle={() => setOpened(false)} />
						</p>
					) : null}
				</div>
			)}
			{singleSpend}
		</section>
	);
}

function PlanBody({
	view,
	review,
	acting,
	pool,
}: {
	view: ItemView;
	review: PlanReview;
	acting: PlanActing;
	pool: SubtaskBudget;
}) {
	const plan = review.plan!;
	const editing = review.open;
	const children = new Map(
		(view.children ?? []).filter(child => child.parent).map(child => [child.parent!.key, child]),
	);
	const single = plan.compare.singleBudget;
	const floor = subtaskFloor(single);
	const titles = new Map(plan.subtasks.map(task => [task.key, task.title]));
	const setAside = plan.status === "superseded";
	const machines = review.machines;
	// A re-plan keeps finished subtasks as they ran: only the rest can change.
	const done = new Set(view.completedSubtasks ?? []);
	const placing =
		plan.subtasks.some(task => task.place || task.needs || task.review) ||
		plan.overflow === true ||
		(view.children ?? []).some(child => child.placement);
	const refusal = review.refusal;
	// The subtask the feature waits to place: a machine wait is about the next one to start.
	const waitingKey =
		plan.status === "approved" && view.wait?.reason === "machine"
			? (nextSubtask(plan, view.children ?? [])?.key ?? null)
			: null;
	const parent = parentPlaceName(view.place, machines);
	const overflow = editing ? review.overflow : plan.overflow === true;
	const place = (task: PlanSubtask, routeEdited: boolean): PlaceRow => {
		const saved = !routeEdited && overflow === !!plan.overflow;
		const preferred = task.review?.places[0];
		return {
			machines,
			parent:
				task.place && task.review ? placeName(task.review.inherited.place, machines) : (preferred?.name ?? parent),
			overflow,
			draft: review.places[task.key] ?? placeDraftOf(task),
			problem: saved ? (refusalFor(task, refusal) ?? task.placementProblem ?? null) : null,
			ahead: saved ? (task.placementWait ?? null) : "Save to check this placement.",
			wait: task.key === waitingKey ? view.wait : null,
			secrets: name => (saved && preferred?.name === name ? preferred.sendSecrets : secretsFor(name, machines)),
			onPlace: draft => review.setPlace(task.key, draft),
		};
	};
	const agentRow = (task: PlanSubtask, edited: PlanSubtask): AgentRow => {
		const draft = editing && task.key in review.agents ? (review.agents[task.key] ?? undefined) : task.agent;
		const later = view.editableAgents?.includes(task.key) === true;
		const moved = editing && task.place?.prefer !== edited.place?.prefer;
		const machine = preferredMachine(
			moved ? edited : task,
			task.review ? placeName(task.review.inherited.place, machines) : parent,
			machines,
		);
		// With no agent of its own, a part runs the resolved default: the feature's, the repository's or yours.
		const inherited = task.review?.inherited ?? (!task.agent ? task.resolved : undefined);
		const harness = draft?.harness ?? inherited?.agent ?? "windlass";
		return {
			draft,
			inherited,
			resolved: edited.resolved,
			changed: editing && agentChanged(task, review.agents[task.key]),
			editable: (editing && !done.has(task.key)) || later,
			machine,
			hostedCredentials: review.hostedCredentials,
			keyProfile: review.keyProfile,
			list: usesAccountModels(harness)
				? review.accountModels
				: harnessOptions(
						machine,
						harness,
						machine ? review.catalogs[machine.machineId]?.[harness] : undefined,
						review.hostedCredentials,
					).models,
			onAgent: agent =>
				later ? void acting.act({ kind: "set_subtask_agent", key: task.key, agent }) : review.setAgent(task.key, agent),
		};
	};
	return (
		<>
			<LongText lines={3} className="plan-goal">
				<Inline text={plan.spec.goal} />
			</LongText>

			{plan.status !== "proposed" && plan.questions.map(question => <PlanAsk key={question.id} question={question} />)}

			{specParts(plan).length > 0 ? (
				<details className="plan-spec-fold">
					<summary>
						<ChevronIcon size={11} className="plan-spec-fold-chevron" />
						{specParts(plan).join(" · ")}
					</summary>
					<dl className="plan-spec">
						{plan.spec.requirements.length > 0 ? (
							<SpecList term="Requirements" kind="requirements" lines={plan.spec.requirements} />
						) : null}
						{plan.spec.acceptance.length > 0 ? (
							<SpecList term="Done when" kind="acceptance" lines={plan.spec.acceptance} />
						) : null}
						{plan.spec.outOfScope.length > 0 ? (
							<SpecList term="Not in it" kind="out" lines={plan.spec.outOfScope} />
						) : null}
					</dl>
				</details>
			) : null}

			{view.mode !== "single" && plan.subtasks.length > 0 ? (
				<div className="usage-card plan-card">
					<p className="plan-card-head">
						Subtasks <span className="plan-card-count">{plan.subtasks.length}</span>
					</p>
					{placing || editing ? (
						<FeaturePlacement
							parent={parent}
							editing={editing}
							overflow={overflow}
							disabled={acting.busy !== null}
							onOverflow={review.setOverflow}
						/>
					) : null}
					<ol className="plan-tasks" aria-label="Subtasks">
						{review.rows.map(({ task, edited, routeEdited }, index) => (
							<SubtaskRow
								key={task.key}
								task={task}
								child={children.get(task.key) ?? null}
								place={placing || editing ? place(task, routeEdited) : null}
								agent={agentRow(task, edited)}
								n={index + 1}
								titles={titles}
								setAside={setAside}
								editing={editing && !done.has(task.key)}
								finished={editing && done.has(task.key)}
								draft={review.budgets[task.key]}
								invalid={!!review.problems.fields[task.key]?.tokens}
								floor={floor}
								single={single}
								disabled={acting.busy !== null}
								onChange={text => review.setBudget(task.key, text)}
							/>
						))}
					</ol>

					<PlanTotal view={view} pool={pool} single={single} total={review.allotted.tokens} />
				</div>
			) : null}
		</>
	);
}

function PlanTotal({
	view,
	pool,
	single,
	total,
}: {
	view: ItemView;
	pool: SubtaskBudget;
	single: ItemBudget;
	total: number;
}) {
	const share = Math.min(100, (total / Math.max(1, pool.tokens)) * 100);
	// The parts' tokens in the unit they are held to: an item's dollars, in proportion.
	const expected =
		single.usd === undefined
			? null
			: figureWords("usd", Math.round(((single.usd * total) / Math.max(1, single.tokens)) * 100) / 100);
	const spent = view.children?.length
		? {
				...sumBudgets(view.children.map(child => child.spent)),
				raw: view.children.reduce((sum, child) => sum + (child.spent.rawTokens ?? child.spent.tokens), 0),
			}
		: null;
	return (
		<div className="plan-total" aria-label="Allotted to subtasks">
			<p className="plan-total-head">Allotted to subtasks</p>
			<dl className="plan-total-figures">
				<div>
					<dt>Tokens</dt>
					<dd className="plan-total-number">
						{compact(total)} <span className="tone-faint">of {compact(pool.tokens)}</span>
					</dd>
					<dd>
						<span className="usage-meter plan-meter" aria-hidden="true">
							<span className="usage-meter-used" style={{ width: `${share}%` }} />
						</span>
					</dd>
					{spent && <dd className="tone-dim">Spent by subtasks: {compact(spent.tokens)}</dd>}
				</div>
			</dl>
			{expected ? (
				<p className="usage-note plan-total-note">
					The parts together are expected to use {expected}, every turn at API prices, whoever pays.
				</p>
			) : null}
			<p className="usage-note plan-total-note">
				{compact(pool.tokens)} tokens total, up to {compact(single.tokens)} per subtask.
			</p>
			<details className="usage-note">
				<summary>Details</summary>
				<p>
					{spent && <>{compact(spent.raw)} raw tokens reported by subtasks. </>}The remaining tokens cover planning, the
					summary and review. Cached input counts at a tenth. Giving a subtask more tokens increases the feature’s
					budget.
				</p>
			</details>
		</div>
	);
}

function specParts(plan: FeaturePlan): string[] {
	const { requirements, acceptance, outOfScope } = plan.spec;
	return [
		requirements.length > 0 ? plural(requirements.length, "requirement") : null,
		acceptance.length > 0 ? `${acceptance.length} done when` : null,
		outOfScope.length > 0 ? `${outOfScope.length} not in it` : null,
	].filter((part): part is string => part !== null);
}

function SpecList({
	term,
	kind,
	lines,
}: {
	term: string;
	kind: "requirements" | "acceptance" | "out";
	lines: string[];
}) {
	return (
		<div className={`plan-spec-part plan-spec-${kind}`}>
			<dt>
				{term}
				<span className="plan-spec-count">{lines.length}</span>
			</dt>
			<dd>
				<FoldList items={lines} shown={SPEC_SHOWN} render={line => <Inline text={line} />} />
			</dd>
		</div>
	);
}

export function Inline({ text }: { text: string }) {
	const parts = text.split(/(`[^`]+`)/);
	return (
		<>
			{parts.map((part, index) =>
				part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
					<code key={index} className="plan-code">
						{part.slice(1, -1)}
					</code>
				) : (
					part
				),
			)}
		</>
	);
}

function SubtaskRow({
	task,
	place,
	agent,
	n,
	titles,
	child,
	setAside,
	editing,
	finished,
	draft,
	invalid,
	floor,
	single,
	disabled,
	onChange,
}: {
	task: PlanSubtask;
	place: PlaceRow | null;
	agent: AgentRow;
	n: number;
	titles: Map<string, string>;
	child: ItemSummary | null;
	setAside: boolean;
	editing: boolean;
	finished: boolean;
	draft: string | undefined;
	invalid: boolean;
	floor: SubtaskBudget;
	single: ItemBudget;
	disabled: boolean;
	onChange(text: string): void;
}) {
	const input = `${useId()}-tokens`;
	const reason = placeReason(task, child, place);
	return (
		<li
			data-key={task.key}
			className={`plan-task${child ? ` plan-task-is-${child.state}` : ""}${finished ? " plan-task-finished" : ""}`}
		>
			<span className="plan-task-n" aria-hidden="true">
				{child ? <ItemGlyph item={child} /> : n}
			</span>
			<div className="plan-task-main">
				<div className="plan-task-head">
					{child ? (
						<a className="plan-task-title" {...linkProps({ name: "item", id: child.id })}>
							{task.title}
						</a>
					) : (
						<span className="plan-task-title">{task.title}</span>
					)}
					{task.dependsOn.length > 0 && <span className="plan-task-after">{afterWords(task.dependsOn, titles)}</span>}
					{task.owns.length > 0 ? <span className="plan-task-files">{plural(task.owns.length, "file")}</span> : null}
				</div>

				<p className="plan-task-brief plan-task-brief-short">{task.brief}</p>
				<dl className="plan-task-facts">
					{place ? <SubtaskPlace task={task} child={child} row={place} editing={editing} disabled={disabled} /> : null}
					<SubtaskAgentFact
						title={task.title}
						child={child}
						row={agent}
						editing={agent.editable && !child}
						disabled={disabled}
					/>
				</dl>
				<SubtaskDetails task={task} reason={reason} />
				{editing && draft !== undefined ? (
					<div className="plan-budget" role="group" aria-label={`Budget of ${task.title}`}>
						<div className="plan-budget-field">
							<label className="plan-budget-label" htmlFor={input}>
								Millions of tokens
							</label>
							<span className={`plan-budget-input${invalid ? " plan-budget-invalid" : ""}`}>
								<input
									id={input}
									className="input input-mono"
									inputMode="decimal"
									value={draft}
									readOnly={disabled}
									aria-invalid={invalid || undefined}
									aria-describedby={`${input}-range`}
									onChange={event => onChange(event.target.value)}
								/>
							</span>
							<span className={`plan-budget-range${invalid ? " tone-bad" : ""}`} id={`${input}-range`}>
								{compact(floor.tokens)}–{compact(single.tokens)} tokens
							</span>
						</div>
					</div>
				) : (
					<p className="plan-budget-read" title={`Planned as ${compact(task.budget.tokens)} tokens`}>
						{child?.agent?.tokens === "subscription" && child.spent.usd === undefined ? (
							<span>
								{subscriptionSpend(child.spent)} <span className="tone-faint">included in your subscription</span>
							</span>
						) : (
							<span>
								{spendWords(child?.budget ?? partBudget(single, task.budget.tokens), child?.spent ?? null)}
								{child ? null : <span className="tone-faint"> expected</span>}
							</span>
						)}
					</p>
				)}
			</div>
			<div className="plan-task-state">
				{child ? (
					child.question ? (
						<span className="plan-task-word plan-task-asks">asks you</span>
					) : itemTrack(child, false) ? (
						<ItemTrack item={child} reviewer={false} />
					) : (
						<span className="plan-task-word">{STATE_WORD[child.state].toLowerCase()}</span>
					)
				) : (
					<span className={`plan-task-word${place?.wait ? "" : " tone-faint"}`}>
						{finished
							? "done"
							: editing
								? "planned"
								: setAside
									? "not run"
									: place?.wait
										? "waits for a machine"
										: "not started"}
					</span>
				)}
			</div>
		</li>
	);
}

function SubtaskDetails({ task, reason }: { task: PlanSubtask; reason: string | null }) {
	return (
		<details className="plan-task-more">
			<summary>
				<ChevronIcon size={11} className="plan-task-more-chevron" />
				Details
			</summary>
			<LongText lines={6} className="plan-task-brief">
				{task.brief}
			</LongText>
			<dl className="plan-task-more-facts">
				{reason ? (
					<div>
						<dt>why there</dt>
						<dd className="plan-place-why">{reason}</dd>
					</div>
				) : null}
				{task.owns.length > 0 ? (
					<div>
						<dt>owns</dt>
						<dd>
							<PathList paths={task.owns} />
						</dd>
					</div>
				) : null}
				<div>
					<dt>checked by</dt>
					<dd>
						<FoldList className="plan-checks" items={task.acceptance} render={line => <Inline text={line} />} />
					</dd>
				</div>
			</dl>
		</details>
	);
}

function placeReason(task: PlanSubtask, child: ItemSummary | null, row: PlaceRow | null): string | null {
	if (child?.placement) return child.placement.reason || null;
	if (!row) return null;
	const prefer = row.draft.prefer;
	if (prefer !== (task.place?.prefer ?? null)) return prefer === null ? null : OWNER_REASON;
	return task.place?.reason ?? null;
}

interface PlaceRow {
	machines: MachineSummary[] | null;
	parent: string;
	overflow: boolean;
	draft: PlaceDraft;
	problem: string | null;
	wait: Waiting | null;
	ahead: string | null;
	secrets(name: string): boolean | null;
	onPlace(draft: PlaceDraft): void;
}

function FeaturePlacement({
	parent,
	editing,
	overflow,
	disabled,
	onOverflow,
}: {
	parent: string;
	editing: boolean;
	overflow: boolean;
	disabled: boolean;
	onOverflow(on: boolean): void;
}) {
	const id = useId();
	return (
		<div className="plan-placement" aria-label="Placement">
			<p className="plan-placement-line">
				<span className="plan-placement-term">placement</span>
				<span>
					Feature place: <strong className="plan-place-name">{placeWord(parent)}</strong>.
				</span>
			</p>
			<div className="plan-placement-line">
				<span className="plan-placement-term" id={id}>
					When busy
				</span>
				{editing ? (
					<div className="segmented plan-overflow" role="radiogroup" aria-labelledby={id}>
						{[false, true].map(on => (
							<label key={String(on)} className={`segment${overflow === on ? " segment-chosen" : ""}`}>
								<input
									className="segment-radio"
									type="radio"
									name={id}
									checked={overflow === on}
									disabled={disabled}
									onChange={() => onOverflow(on)}
								/>
								{on ? "Use another free place" : "Wait for the chosen place"}
							</label>
						))}
					</div>
				) : (
					<strong className="plan-overflow-word">
						{overflow ? "Use another free place" : "Wait for the chosen place"}
					</strong>
				)}
			</div>
		</div>
	);
}

function placeMenu(row: PlaceRow, current: string | null): MenuSpec {
	const machineItems: MenuItem[] = (row.machines ?? []).map(machine => {
		const name = machineLabel(machine);
		const policy = orchestratorOf(machine);
		return {
			id: `m:${machine.machineId}`,
			label: name,
			textValue: name,
			description:
				policy === "never"
					? "Its owner keeps it out of features."
					: [
							machine.status,
							...(machine.slots ? [`${machine.slots.busy} of ${machine.slots.max} slots busy`] : []),
							...(policy === "named" ? ["when named"] : []),
							machine.sendSecrets ? "gets secrets" : "no secrets",
						].join(" · "),
			disabled: policy === "never",
			wrap: true,
			checked: current === name,
			onSelect: () => row.onPlace({ prefer: name, allow: row.draft.allow.filter(other => other !== name) }),
		};
	});
	return {
		label: "Runs on",
		width: 320,
		groups: [
			{
				id: "feature",
				items: [
					{
						id: "inherit",
						label: "Use the resolved default",
						checked: current === null,
						onSelect: () => row.onPlace({ prefer: null, allow: [] }),
					},
				],
			},
			...(machineItems.length > 0 ? [{ id: "machines", label: "My machines", items: machineItems }] : []),
			{
				id: "hosted",
				items: [
					{
						id: "hosted",
						label: "Hosted",
						description: "Gets secrets",
						checked: current === HOSTED,
						onSelect: () => row.onPlace({ prefer: HOSTED, allow: row.draft.allow.filter(other => other !== HOSTED) }),
					},
				],
			},
		],
	};
}

function allowMenu(row: PlaceRow): MenuSpec {
	const toggle = (name: string) =>
		row.onPlace({
			...row.draft,
			allow: row.draft.allow.includes(name)
				? row.draft.allow.filter(other => other !== name)
				: [...row.draft.allow, name],
		});
	const names = [
		...(row.machines ?? []).map(machine => ({
			name: machineLabel(machine),
			never: orchestratorOf(machine) === "never",
			secrets: machine.sendSecrets,
		})),
		{ name: HOSTED, never: false, secrets: true },
	].filter(place => place.name !== row.draft.prefer);
	return {
		label: "Alternatives",
		width: 300,
		header: row.overflow ? undefined : <span className="tone-dim">Enable another free place to use alternatives.</span>,
		groups: [
			{
				id: "allow",
				items: names.map(place => ({
					id: place.name,
					label: place.name === HOSTED ? "Hosted" : place.name,
					description: place.never
						? "Its owner keeps it out of features."
						: place.secrets
							? "gets secrets"
							: "no secrets",
					disabled: place.never,
					checked: row.draft.allow.includes(place.name),
					keepOpen: true,
					onSelect: () => toggle(place.name),
				})),
			},
		],
	};
}

function SubtaskPlace({
	task,
	child,
	row,
	editing,
	disabled,
}: {
	task: PlanSubtask;
	child: ItemSummary | null;
	row: PlaceRow;
	editing: boolean;
	disabled: boolean;
}) {
	const needs = needsWords(task.needs);
	const prefer = editing ? row.draft.prefer : (task.place?.prefer ?? null);
	const inheritedPlaces = !task.place && prefer === null ? task.review?.places.slice(1).map(p => p.name) : undefined;
	const allow = (inheritedPlaces ?? (editing ? row.draft.allow : (task.place?.allow ?? []))).filter(
		name => name !== prefer,
	);
	const preferMoved = editing && prefer !== (task.place?.prefer ?? null);
	const allowMoved =
		editing && JSON.stringify(allow) !== JSON.stringify((task.place?.allow ?? []).filter(name => name !== prefer));
	const childWait = child?.wait?.reason === "machine" ? child.wait : null;
	const ended = child && ["done", "failed", "cancelled"].includes(child.state);
	return (
		<>
			{child?.placement ? (
				<div className="plan-place">
					<dt>{ended ? "ran on" : "runs on"}</dt>
					<dd>
						<strong className="plan-place-name">{placedWords(child.placement)}</strong>
						<SecretsTag sent={child.placement.sendSecrets} done={ended === true} />
					</dd>
				</div>
			) : (
				<div className="plan-place">
					<dt>runs on</dt>
					<dd>
						{editing ? (
							<span className="plan-place-picks">
								<Menu
									spec={placeMenu(row, prefer)}
									trigger={props => (
										<Pill
											{...props}
											outlined
											disabled={disabled}
											dot={preferMoved ? "changed" : null}
											dotLabel={preferMoved ? "changed, not saved" : undefined}
											className="plan-place-pick"
											aria-label={`Runs on: ${prefer === null ? `resolved default, ${placeWord(row.parent)}` : placeWord(prefer)}`}
											secondary={prefer === null ? placeWord(row.parent) : undefined}
										>
											{prefer === null ? "Resolved default" : placeWord(prefer)}
										</Pill>
									)}
								/>
								{prefer !== null ? (
									<Menu
										spec={allowMenu(row)}
										trigger={props => (
											<Pill
												{...props}
												disabled={disabled}
												dot={allowMoved ? "changed" : null}
												dotLabel={allowMoved ? "changed, not saved" : undefined}
												className="plan-place-pick plan-place-allow"
												aria-label={`Alternatives: ${allow.length ? allow.map(placeWord).join(", ") : "none"}`}
											>
												{allow.length ? `or ${allow.map(placeWord).join(", ")}` : "No alternatives"}
											</Pill>
										)}
									/>
								) : null}
								<SecretsTag sent={row.secrets(prefer ?? row.parent)} />
								{inheritedPlaces?.length ? <span>or {inheritedPlaces.map(placeWord).join(", ")}</span> : null}
							</span>
						) : (
							<>
								<strong className="plan-place-name">
									{prefer === null ? placeWord(row.parent) : placeWord(prefer)}
								</strong>
								{prefer === null ? <span className="tone-faint"> by default</span> : null}
								<SecretsTag sent={row.secrets(prefer ?? row.parent)} />
								{allow.length > 0 ? (
									<span className={row.overflow ? "plan-place-alt" : "plan-place-alt tone-faint"}>
										{" "}
										or {allow.map(placeWord).join(", ")}
										{inheritedPlaces || row.overflow ? null : " · waits for its chosen place"}
									</span>
								) : null}
							</>
						)}
					</dd>
				</div>
			)}
			{needs.length > 0 ? (
				<div>
					<dt>needs</dt>
					<dd className="plan-paths">
						{needs.map(word => (
							<span key={word} className="plan-path plan-need">
								{word}
							</span>
						))}
					</dd>
				</div>
			) : null}
			{row.wait || childWait ? (
				<div className="plan-place-wait">
					<dt>waits</dt>
					<dd role="status">
						<span className="plan-place-dot" aria-hidden="true" />
						{(row.wait ?? childWait)!.sentence}
					</dd>
				</div>
			) : null}
			{row.ahead && !row.problem && !child ? (
				<div className="plan-place-wait plan-place-ahead">
					<dt>if approved</dt>
					<dd>
						<span className="plan-place-dot" aria-hidden="true" />
						{row.ahead}
					</dd>
				</div>
			) : null}
			{row.problem && !child ? (
				<div className="plan-place-problem">
					<dt>can't place</dt>
					<dd role="alert">{row.problem}</dd>
				</div>
			) : null}
		</>
	);
}

interface AgentRow {
	resolved?: ResolvedRun;
	inherited: ResolvedRun | undefined;
	hostedCredentials: ReturnType<typeof useHostedCredentials>;
	keyProfile: boolean;
	draft: SubtaskAgent | undefined;
	changed: boolean;
	editable: boolean;
	machine: MachineSummary | null;
	list: ModelList | null;
	onAgent(agent: SubtaskAgent | null): void;
}

function UnattendedTag() {
	return (
		<>
			{" "}
			<span className="plan-unattended" title={UNATTENDED_MEANS}>
				{UNATTENDED_WORDS}
			</span>
		</>
	);
}

function agentMenu(row: AgentRow, title: string): MenuSpec {
	const current = row.draft?.harness ?? null;
	const inherited = row.inherited;
	return {
		label: `Agent for ${title}`,
		width: 300,
		groups: [
			{
				id: "default",
				items: [
					{
						id: "default",
						label: "The default",
						description: inherited
							? `${HARNESS_NAMES[inherited.agent]} · ${runModelName(inherited, usesAccountModels(inherited.agent) ? row.list : null)}, ${SOURCE_WORDS[sourceOf(inherited, ["agent", "model"])]}.`
							: "What the feature runs with.",
						wrap: true,
						checked: current === null,
						onSelect: () => row.onAgent(null),
					},
				],
			},
			{
				id: "agents",
				items: agentChoices(row.machine, row.hostedCredentials, row.keyProfile).map(choice => ({
					id: choice.id,
					label: choice.name,
					description:
						choice.problem ??
						(worksWithoutAsking(choice.id)
							? row.machine
								? `Runs on ${machineLabel(row.machine)} without asking.`
								: `Uses your ${choice.id === "claude" ? "Anthropic" : "API"} key.`
							: undefined),
					disabled: choice.problem !== null,
					wrap: true,
					checked: current === choice.id,
					onSelect: () => row.onAgent({ harness: choice.id }),
				})),
			},
		],
	};
}

function modelMenu(row: AgentRow, harness: HarnessId): MenuSpec {
	const entry = row.machine?.harnesses?.find(one => one.id === harness) ?? null;
	return sharedModelMenu({
		harness,
		list: row.list,
		chosen: row.draft?.model ?? "",
		inherit: { label: usesAccountModels(harness) ? "The feature's model" : "Its default model" },
		entry,
		machine: row.machine ? machineLabel(row.machine) : null,
		onChoose: model =>
			model
				? row.onAgent({ harness, model })
				: row.onAgent(
						usesAccountModels(harness)
							? row.draft?.effort
								? { harness, effort: row.draft.effort }
								: null
							: { harness },
					),
	});
}

function effortMenu(row: AgentRow, harness: HarnessId, efforts: string[], model: string): MenuSpec {
	const pick = (effort: string) => {
		const next = {
			harness,
			...(row.draft?.model && { model: row.draft.model }),
			...(effort && effort !== "default" && { effort }),
		};
		row.onAgent(cleanAgent(next) ?? null);
	};
	return {
		label: "Effort",
		width: 220,
		groups: [effortGroup(efforts, row.draft?.effort ?? "", model, pick)],
		hints: false,
	};
}

function SubtaskAgentFact({
	title,
	child,
	row,
	editing,
	disabled,
}: {
	title: string;
	child: ItemSummary | null;
	row: AgentRow;
	editing: boolean;
	disabled: boolean;
}) {
	const { inherited } = row;
	const shown = row.resolved ? runAgent(row.resolved) : (row.draft ?? (inherited && runAgent(inherited)));
	const harness = shown?.harness ?? "windlass";
	const parts = agentParts(shown, row.list);
	const why =
		!row.draft && inherited ? (
			<span className="plan-agent-why"> — {SOURCE_WORDS[sourceOf(inherited, ["agent", "model", "effort"])]}</span>
		) : null;
	if (child?.agent) {
		const ran = cleanAgent({
			harness: child.agent.harness,
			model: child.agent.model,
			...(child.agent.effort && { effort: child.agent.effort }),
		});
		const words = agentParts(ran ?? { harness: child.agent.harness, model: child.agent.model }, null);
		return (
			<div className="plan-agent">
				<dt>agent</dt>
				<dd>
					<AgentGlyph harness={child.agent.harness} size={11} inline />
					<strong className="plan-agent-name">{words.name}</strong>
					<span className="tone-dim">
						{" "}
						· {modelWords(child.agent.model)}
						{child.agent.effort ? ` · ${child.agent.effort} effort` : ""}
					</span>
					{words.unattended ? <UnattendedTag /> : null}
				</dd>
			</div>
		);
	}
	// A model that reports its efforts only once selected: any effort its agent reported (account-models.ts, `checkItemEffort`).
	const list = row.list;
	const model = shown?.model ?? list?.defaultModel ?? "";
	const own = effortsOf(list, model);
	const efforts =
		own.length > 0 || usesAccountModels(harness) ? own : [...new Set((list?.models ?? []).flatMap(one => one.efforts))];
	return (
		<div className="plan-agent">
			<dt>agent</dt>
			<dd>
				{editing ? (
					<span className="plan-place-picks">
						<Menu
							spec={agentMenu(row, title)}
							trigger={props => (
								<Pill
									{...props}
									outlined
									disabled={disabled}
									dot={row.changed ? "changed" : null}
									dotLabel={row.changed ? "changed, not saved" : undefined}
									className="plan-place-pick"
									icon={<AgentGlyph harness={harness} size={11} />}
									aria-label={`Agent: ${parts.name}`}
								>
									{parts.name}
								</Pill>
							)}
						/>
						<Menu
							spec={modelMenu(row, harness)}
							trigger={props => (
								<Pill
									{...props}
									disabled={disabled}
									className="plan-place-pick plan-place-allow"
									aria-label={`Model: ${parts.model}`}
								>
									{parts.model}
								</Pill>
							)}
						/>
						{efforts.length > 0 || row.draft?.effort ? (
							<Menu
								spec={effortMenu(row, harness, efforts, parts.model)}
								trigger={props => (
									<Pill
										{...props}
										disabled={disabled}
										className="plan-place-pick plan-place-allow"
										aria-label={`Effort: ${parts.effort ?? "default"}`}
									>
										{parts.effort ? `${parts.effort} effort` : "Default effort"}
									</Pill>
								)}
							/>
						) : null}
						{why}
						{parts.unattended ? <UnattendedTag /> : null}
					</span>
				) : (
					<>
						<AgentGlyph harness={harness} size={11} inline />
						<strong className="plan-agent-name">{parts.name}</strong>
						<span className="tone-dim">
							{" "}
							· {parts.model}
							{parts.effort ? ` · ${parts.effort} effort` : ""}
						</span>
						{why}
						{parts.unattended ? <UnattendedTag /> : null}
					</>
				)}
			</dd>
		</div>
	);
}

function UnattendedConfirm({ plan, review, disabled }: { plan: FeaturePlan; review: PlanReview; disabled: boolean }) {
	const heading = useId();
	const tasks = plan.subtasks.filter(task => review.unattended.includes(task.key));
	return (
		<div className="plan-unattended-confirm" role="group" aria-labelledby={heading}>
			<p className="plan-routes-head" id={heading}>
				Agents that work without asking
			</p>
			<p className="plan-unattended-note">
				{UNATTENDED_MEANS}{" "}
				{tasks.every(task => task.agent)
					? `The planner proposed ${tasks.length === 1 ? "this one" : "these"} from the item's text, which may come from an issue anyone could file.`
					: "These parts use an agent chosen in the plan or inherited from your settings."}{" "}
				Confirm each one, or choose Windlass for it below and save.
			</p>
			<ul className="plan-unattended-list">
				{tasks.map(task => {
					const name = HARNESS_NAMES[subtaskHarness(task)];
					return (
						<li key={task.key}>
							<Check
								className="plan-unattended-row"
								checked={review.confirmed.includes(task.key)}
								disabled={disabled}
								onChange={on => review.setConfirmed(task.key, on)}
								label={
									<>
										Run <strong>{task.title}</strong> on {name}, which {UNATTENDED_WORDS}
									</>
								}
							/>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

function SecretsTag({ sent, done = false }: { sent: boolean | null; done?: boolean }) {
	const words =
		sent === true ? (done ? "received secrets" : "gets secrets") : sent === false ? "no secrets" : "secrets unknown";
	const means =
		sent === null
			? "This place is missing from your machine list."
			: "Hosted gets the secrets allowed for this item. A machine gets them only when Send saved secrets is on in Machines.";
	// The space keeps the place and its secrets apart when read aloud.
	return (
		<>
			{" "}
			<span
				className={`plan-secrets plan-secrets-${sent === true ? "sent" : sent === false ? "none" : "unknown"}`}
				title={means}
			>
				{words}
			</span>
		</>
	);
}

function PlanRoutes({
	view,
	plan,
	machines,
	catalogs,
	accountModels,
	refusal,
}: {
	view: ItemView;
	plan: FeaturePlan;
	machines: MachineSummary[] | null;
	catalogs: Catalogs;
	accountModels: ModelList | null;
	refusal: string | null;
}) {
	const heading = useId();
	const parent = parentPlaceName(view.place, machines);
	const done = new Set(view.completedSubtasks ?? []);
	return (
		<div className="plan-routes" role="group" aria-labelledby={heading}>
			<p className="plan-routes-head">
				<span id={heading}>Where each subtask runs</span>
			</p>
			<ol className="plan-routes-list">
				{plan.subtasks.map((task, index) => {
					if (done.has(task.key))
						return (
							<li key={task.key} className="plan-route plan-task-finished">
								<span className="plan-route-n" aria-hidden="true">
									{index + 1}
								</span>
								<div className="plan-route-main">
									<p className="plan-route-title">{task.title}</p>
									<p className="plan-route-agent tone-dim">Done</p>
								</div>
							</li>
						);
					const route = task.review;
					const problem = refusalFor(task, refusal) ?? task.placementProblem;
					const wait = !problem && task.placementWait;
					const harness = subtaskHarness(task);
					const agent = agentParts(
						task.resolved ? runAgent(task.resolved) : task.agent,
						usesAccountModels(harness)
							? accountModels
							: machineModels(preferredMachine(task, parent, machines), harness, catalogs),
					);
					return (
						<li key={task.key} className="plan-route">
							<span className="plan-route-n" aria-hidden="true">
								{index + 1}
							</span>
							<div className="plan-route-main">
								<p className="plan-route-title">{task.title}</p>
								<p className="plan-route-agent">
									<AgentGlyph harness={harness} size={11} inline />
									<span className="plan-agent-name">{agent.name}</span>
									<span className="tone-dim">
										{" "}
										· {agent.model}
										{agent.effort ? ` · ${agent.effort} effort` : ""}
									</span>
									{agent.unattended ? <UnattendedTag /> : null}
								</p>
								{problem ? <p className="plan-route-problem">Can't be placed: {problem}</p> : null}
								{wait ? <p className="plan-route-wait">If approved now: {wait}</p> : null}
							</div>
							<ul className="plan-route-places" aria-label={`Places for ${task.title}`}>
								{route?.places.map(({ place, name, sendSecrets, payer }, i) => (
									<li key={place.kind === "hosted" ? "hosted" : place.machineId}>
										{i > 0 && <span className="tone-faint">or </span>}
										<span className="plan-place-name">{placeWord(name)}</span>
										<SecretsTag sent={sendSecrets} />
										{task.resolved && <span> · {payerWords({ ...task.resolved, payer }) ?? "Windlass usage"}</span>}
										{place.kind === "hosted" && route.hosted && (
											<p>
												Saved {HOSTED_SIZE_NAMES[route.hosted.saved]} · Proposed {HOSTED_SIZE_NAMES[route.hosted.size]}{" "}
												· {route.hosted.rate}× standard hosted rate
												{route.hosted.usdPerHour !== null && ` · est. ${perHour(route.hosted.usdPerHour)}`}
											</p>
										)}
									</li>
								))}
							</ul>
						</li>
					);
				})}
			</ol>
		</div>
	);
}

export function PlacementQuestion({
	view,
	question,
	review,
	acting,
	when,
}: {
	view: ItemView;
	question: ItemQuestion;
	review: PlanReview;
	acting: PlanActing;
	when: ReactNode;
}) {
	const ids = { title: useId(), note: useId() };
	const about = refusedSubtask(view.plan ?? null, question.text);
	const task = about?.task ?? null;
	const [revising, setRevising] = useState(false);
	const [draft, setDraft] = useState<PlaceDraft>(() => (task ? placeDraftOf(task) : { prefer: null, allow: [] }));
	const [note, setNote] = useState("");
	const busy = acting.busy !== null;
	const again = question.choices.some(choice => choice.id === "again");
	const machines = review.machines;
	const parent = parentPlaceName(view.place, machines);
	const overflow = view.plan?.overflow === true;
	const route = task ? routeWords(task, parent, overflow) : null;
	const moved = task !== null && placeChanged(task, draft);
	const picked = task && moved ? withPlace(task, draft) : null;
	const row: PlaceRow = {
		machines,
		parent,
		overflow,
		draft,
		problem: null,
		wait: null,
		ahead: null,
		secrets: name => secretsFor(name, machines),
		onPlace: setDraft,
	};
	const revise = () => {
		const words = [
			...(picked
				? [
						`Run “${picked.title}” on ${placeWord(draft.prefer ?? parent)}${draft.allow.length ? `, or ${draft.allow.map(placeWord).join(", ")}` : ""}.`,
					]
				: []),
			...(note.trim() ? [note.trim()] : []),
		]
			.join(" ")
			.slice(0, MAX_NOTE_CHARS);
		return acting.act({ kind: "answer", question: question.id, choice: "revise", ...(words && { note: words }) });
	};
	return (
		<section className="item-question placement-question" aria-labelledby={ids.title}>
			<p className="item-question-head" id={ids.title}>
				It asks you
				<span className="item-question-when">{when}</span>
			</p>
			<p className="item-question-text">{question.text}</p>
			<dl className="placement-question-facts">
				{route ? (
					<div className="plan-place">
						<dt>approved</dt>
						<dd>
							<strong className="plan-place-name">{placeWord(route.prefer)}</strong>
							{route.inherited ? <span className="tone-faint"> by default</span> : null}
							{route.alternatives.length > 0 ? (
								<span className={overflow ? "plan-place-alt" : "plan-place-alt tone-faint"}>
									{" "}
									or {route.alternatives.map(placeWord).join(", ")}
									{route.overflowing ? null : " · waits for its chosen place"}
								</span>
							) : null}
						</dd>
					</div>
				) : null}
			</dl>

			{revising && task ? (
				<div className="placement-revise">
					<dl className="placement-question-facts">
						<SubtaskPlace task={task} child={null} row={row} editing disabled={busy} />
					</dl>
					<div>
						<label className="label" htmlFor={ids.note}>
							A note to the planner<span className="label-optional">optional</span>
						</label>
						<textarea
							id={ids.note}
							className="input textarea item-note"
							value={note}
							maxLength={MAX_NOTE_CHARS - 200}
							onChange={event => setNote(event.target.value)}
							readOnly={busy}
						/>
					</div>
					<div className="item-choices">
						<button
							type="button"
							className="button button-primary"
							disabled={busy}
							onClick={() => void revise()}
							aria-describedby={`${ids.title}-revise`}
						>
							{acting.busy === "revise" ? "Sending…" : "Ask for a revised plan"}
						</button>
						<button type="button" className="button button-quiet" disabled={busy} onClick={() => setRevising(false)}>
							Back
						</button>
					</div>
					<p className="field-note" id={`${ids.title}-revise`}>
						{picked
							? "The planner files the remaining subtasks again with this place; the new plan comes to you for approval."
							: "Pick where it should run, or leave the place to the planner. The new plan comes to you for approval."}
					</p>
				</div>
			) : (
				<>
					<div className="item-choices">
						{question.choices.map((choice, index) => {
							const edit = choice.id === "revise" && task;
							return (
								<button
									key={choice.id}
									type="button"
									className={`button ${index === 0 ? "button-primary" : choice.id === "give_up" ? "button-quiet" : "button-outline"}`}
									disabled={busy}
									onClick={() =>
										edit
											? setRevising(true)
											: void acting.act({ kind: "answer", question: question.id, choice: choice.id })
									}
								>
									{choice.label}
									{edit ? "…" : ""}
								</button>
							);
						})}
					</div>
					{again && (
						<p className="field-note">
							Retry once you have changed what refused it, on{" "}
							<a className="link" {...linkProps({ name: "machines" })}>
								Machines
							</a>
							. Giving up cancels the subtask; the planner then revises what is left for you to approve, or the feature
							stops.
						</p>
					)}
				</>
			)}
			{acting.error ? (
				<p className="callout callout-bad" role="alert">
					<WarnIcon />
					<span>{acting.error}</span>
				</p>
			) : null}
		</section>
	);
}
