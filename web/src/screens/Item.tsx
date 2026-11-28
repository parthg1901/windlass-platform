import { filingSource, originIssue } from "../lib/origin";
import {
	MAX_NOTE_CHARS,
	type ChoiceId,
	type ItemAction,
	type ItemBudget,
	type ItemEvent,
	type ItemQuestion,
	type ItemReport,
	type ItemSummary,
	type ItemView,
	type PartScreenshots,
	type SessionSummary,
	type StepKind,
	type Verdict,
} from "@contract";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { hasReason, PlatformError } from "../api/client";
import { ITEM_MODE_WORDS } from "../lib/feature";
import { MissingPageLinks } from "../components/MissingPageLinks";
import { Inline, PlacementQuestion, PlanQuestion, PlanSection } from "./FeaturePlan";
import { usePlanReview, type PlanActing as Acting } from "./usePlanReview";
import { ItemSpend } from "../components/ItemSpend";
import { agentFacts, agentLine, subscriptionSpend } from "../lib/item-agent";
import { Menu, type MenuItem } from "../components/ui/Menu";
import { Dialog } from "../components/Dialog";
import { InlineMarkdown, Output } from "../components/Blocks";
import { LongText } from "../components/Fold";
import { CheckIcon, ChevronIcon, ExternalIcon, InfoIcon, WarnIcon } from "../components/Icons";
import { BranchName } from "../components/BranchName";
import { ProviderIcon, providerOf } from "../components/ProviderIcon";
import { hostWords, requestNumber, sentenceCase } from "../lib/host";
import { ReviewBlocks } from "../components/ReviewBlocks";
import { Screenshots, useScreenshotLinks, type ScreenshotLinks } from "../components/Screenshots";
import { ItemNetwork } from "../components/ItemNetwork";
import type { AllowHostContext } from "../components/BlockedNetwork";
import { reviewShots } from "../components/SecondReview";
import { SecretAsk, withoutValue } from "../components/SecretAsk";
import { ItemChecks } from "./ItemChecks";
import { absoluteTime, clockTime, compact, ordinal, plural, relativeTime, sandboxTime } from "../lib/format";
import { linkProps } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { useNow, useSessions } from "../state/hooks";
import { ItemGlyph, ItemRow, ItemStages, PartStages } from "../components/ItemRow";
import { STATE_WORD } from "../lib/items";
import { useSessionMachine } from "./Session";
import { machineLabel } from "../lib/machines";
import { AgentGlyph } from "../components/ui/Pill";
import { Failure } from "../components/ui/Failure";
import { childrenBehind, partName, REPAIR_WHY, repairKind } from "../lib/subtasks";
import { partOf, showsSubtasks, SubtasksBlock, SubtaskStrip } from "../components/Subtasks";

const STEP_WORD: Record<StepKind, string> = {
	subtasks: "Subtasks",
	integration: "Testing the repositories together",
	summary: "Feature summary",
	refine: "Planning",
	plan_review: "Reviewing plan",
	implement: "Implementing",
	gate: "Checks",
	publish: "Pushing",
	ci: "Waiting for CI",
	ci_fix: "Fixing CI",
	run_checks: "Running local checks",
	conflict: "Merging the base",
	review: "Second review",
	review_fix: "Fixing the review",
	handoff: "Handed over",
	merged: "Waiting for the merge",
};

const STEP_DOING: Partial<Record<StepKind, string>> = {
	refine: "Its agent plans the work.",
	implement: "Its agent works on the task.",
	ci_fix: "Its agent works on what CI reported.",
	conflict: "Its agent merges the base into its branch.",
	gate: "The platform reads what the checks of the last turn found.",
	publish: "The platform pushes the work and opens or updates the pull request.",
	review: "A second agent reviews the pushed commit in its own sandbox.",
	review_fix: "Its agent works on the second review's blocking findings.",
};

/** Steps that are a turn of the agent, or a push: a second attempt of one is worth saying. Waits on GitHub count every poll as an attempt, which is not. */
const TRIED: ReadonlySet<StepKind> = new Set([
	"refine",
	"implement",
	"ci_fix",
	"conflict",
	"publish",
	"review",
	"review_fix",
]);

function When({ at, now }: { at: number; now: number }) {
	return (
		<time dateTime={new Date(at).toISOString()} title={absoluteTime(at)}>
			{clockTime(at, now)}
		</time>
	);
}

interface ItemPage {
	/** Null until it was read. */
	view: ItemView | null;
	/** Why it could not be read; `missing` when it is not the user's. */
	error: string | null;
	missing: boolean;
	reload(): Promise<void> | void;
	replace(view: ItemView): void;
}

/** One item: read when the page opens, and again when the user's feed says it changed or comes back after a drop. `enabled` false asks nothing, as `useItems`. */
export function useItem(id: string, enabled = true): ItemPage {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [state, setState] = useState<{ view: ItemView | null; error: string | null; missing: boolean }>({
		view: null,
		error: null,
		missing: false,
	});
	const asked = useRef(0);
	const shown = useRef(-1);
	// What the page holds of the feature's subtasks, or of itself as one: the feed's open subtasks are read against it.
	const held = useRef<{ parentId: string | null; children: Pick<ItemSummary, "id" | "revision" | "state">[] }>({
		parentId: null,
		children: [],
	});
	const hold = (view: ItemView) => {
		shown.current = view.revision;
		held.current = view.parent
			? { parentId: view.parent.itemId, children: [view] }
			: { parentId: view.id, children: view.children ?? [] };
	};

	const reload = useCallback((): Promise<void> => {
		const mine = ++asked.current;
		return client
			.user(auth)
			.item(id)
			.then(
				view => {
					if (mine !== asked.current) return;
					hold(view);
					setState({ view, error: null, missing: false });
				},
				(failure: unknown) => {
					if (mine === asked.current)
						setState(now => ({
							view: now.view,
							error: explain(failure),
							missing: hasReason(failure, "item_not_found"),
						}));
				},
			);
	}, [client, auth, explain, id]);

	const replace = useCallback((view: ItemView) => {
		asked.current += 1;
		hold(view);
		setState({ view, error: null, missing: false });
	}, []);

	useEffect(() => {
		if (!enabled) return;
		reload();
		let connected = false;
		const close = client.user(auth).watch({
			onSessions: () => undefined,
			onItems: feed => {
				const summary =
					feed.open.find(item => item.id === id) ??
					feed.ended.find(item => item.id === id) ??
					feed.children?.find(item => item.id === id);
				// A feature's subtasks, or the subtask itself, changed: a subtask is in the feed while it is open, and its page reads it again once it ended.
				const { parentId, children } = held.current;
				const behind =
					parentId !== null &&
					childrenBehind(
						parentId,
						parentId === id ? children : children.filter(child => child.id === id),
						parentId === id ? feed.children : feed.children?.filter(child => child.id === id),
					);
				if ((summary && summary.revision > shown.current) || behind) reload();
			},
			onConnection: connection => {
				if (connection !== "connected") return;
				if (connected) reload();
				connected = true;
			},
		});
		return () => {
			asked.current += 1;
			close();
		};
	}, [client, auth, id, reload, enabled]);

	return { ...state, reload, replace };
}

/** Read a refused approval again: a changed default may require new confirmations on the same version. */
function useActing(
	id: string,
	onDone: (view: ItemView) => void,
	onRefresh?: (kind: string, conflict: boolean) => void,
): Acting {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [failed, setFailed] = useState<Acting["failed"]>(null);
	const act = async (action: ItemAction) => {
		setBusy(action.kind === "answer" ? action.choice : action.kind);
		setError(null);
		setFailed(null);
		try {
			onDone(await client.user(auth).actOnItem(id, action));
			setBusy(null);
			return true;
		} catch (failure) {
			setError(explain(failure));
			setFailed({ kind: action.kind, reason: failure instanceof PlatformError ? (failure.reason ?? null) : null });
			setBusy(null);
			const conflict = hasReason(failure, "item_conflict");
			if (conflict || (action.kind === "approve_plan" && hasReason(failure, "bad_input")))
				onRefresh?.(action.kind, conflict);
			return false;
		}
	};
	return { busy, error, failed, act };
}

function GitlabMerge({ view, onDone }: { view: ItemView; onDone(view: ItemView): void }) {
	const { client, explain } = useApp(),
		auth = useAuth();
	const [head, setHead] = useState<string | null>(null);
	const [busy, setBusy] = useState(false),
		[error, setError] = useState<string | null>(null);
	const merge = async () => {
		setBusy(true);
		try {
			if (head) onDone(await client.user(auth).mergeGitlabItem(view.id, head));
			setHead(null);
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<button
				type="button"
				className="button button-outline button-small"
				onClick={() => {
					setHead(view.head);
					setError(null);
				}}
			>
				Merge…
			</button>
			{head && (
				<Dialog
					title={`Merge !${view.pullRequest?.number}?`}
					size="small"
					dismissable={!busy}
					onClose={() => setHead(null)}
					footer={
						<>
							<button className="button button-quiet" disabled={busy} onClick={() => setHead(null)}>
								Cancel
							</button>
							<button className="button button-primary" disabled={busy} onClick={merge}>
								{busy ? "Merging…" : "Merge request"}
							</button>
						</>
					}
				>
					<p>
						Merge commit <code>{head.slice(0, 8)}</code> into <strong>{view.task.base}</strong>. Windlass checks the
						head, base and pipeline again before merging.
					</p>
					<Failure error={error} />
				</Dialog>
			)}
		</>
	);
}

function CancelDialog({ view, acting, onClose }: { view: ItemView; acting: Acting; onClose(): void }) {
	const busy = acting.busy === "cancel";
	const host = hostWords(view.repository.provider);
	return (
		<Dialog
			title="Cancel this work item?"
			size="small"
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Keep it
					</button>
					<button
						type="button"
						className="button button-danger"
						onClick={() => acting.act({ kind: "cancel" }).then(done => done && onClose())}
						disabled={busy}
					>
						{busy ? "Cancelling…" : "Cancel item"}
					</button>
				</>
			}
		>
			<p>
				Nothing more is done for <strong>{view.title}</strong>
				{view.state === "working" ? ", and the turn that runs is stopped" : ""}.{" "}
				{view.pullRequest
					? `${sentenceCase(host.noun)} ${host.mark}${view.pullRequest.number} stays open on ${host.name} until you close it there.`
					: `No ${host.noun} was opened for it.`}{" "}
				Its agent and the log stay.
			</p>
			<Failure error={acting.error} />
		</Dialog>
	);
}

function SendBackDialog({ view, acting, onClose }: { view: ItemView; acting: Acting; onClose(): void }) {
	const [note, setNote] = useState("");
	const ids = { form: useId(), note: useId() };
	const busy = acting.busy === "send_back";
	const send = (event: FormEvent) => {
		event.preventDefault();
		if (note.trim() === "" || busy) return;
		acting.act({ kind: "send_back", note: note.trim() }).then(done => done && onClose());
	};
	return (
		<Dialog
			title="Send it back"
			lede={
				view.mode === "orchestrate"
					? "A fix part gets your note. After it joins the feature branch, the feature goes through its checks again."
					: "Its agent gets your note and works on the same branch. The pull request is updated, and the work gets a new verdict."
			}
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" form={ids.form} className="button button-primary" disabled={note.trim() === "" || busy}>
						{busy ? "Sending…" : "Send back"}
					</button>
				</>
			}
		>
			<form id={ids.form} className="item-form" onSubmit={send}>
				<div>
					<label className="label" htmlFor={ids.note}>
						What to change
					</label>
					<textarea
						id={ids.note}
						className="input textarea"
						value={note}
						maxLength={MAX_NOTE_CHARS}
						onChange={event => setNote(event.target.value)}
						readOnly={busy}
						data-autofocus
					/>
					{view.pullRequest ? (
						<p className="field-note">
							A review left on pull request #{view.pullRequest.number} is not read: say here what the agent should know.
						</p>
					) : null}
				</div>
				<Failure error={acting.error} />
			</form>
		</Dialog>
	);
}

function NoteBox({ targets, onDone }: { targets: { id: string; label: string }[]; onDone(view: ItemView): void }) {
	const [note, setNote] = useState("");
	const [chosen, setChosen] = useState("");
	const target = targets.find(one => one.id === chosen) ?? targets[0];
	const ids = { note: useId(), to: useId() };
	const acting = useActing(target?.id ?? "", onDone);
	const busy = acting.busy === "note";
	if (!target) return null;
	const send = (event: FormEvent) => {
		event.preventDefault();
		if (note.trim() === "" || busy) return;
		acting.act({ kind: "note", note: note.trim() }).then(done => done && setNote(""));
	};
	return (
		<form className="item-form item-steer" onSubmit={send}>
			{targets.length > 1 ? (
				<div>
					<label className="label" htmlFor={ids.to}>
						Note to
					</label>
					<select
						id={ids.to}
						className="input select"
						value={target.id}
						disabled={busy}
						onChange={event => setChosen(event.target.value)}
					>
						{targets.map(one => (
							<option key={one.id} value={one.id}>
								{one.label}
							</option>
						))}
					</select>
				</div>
			) : null}
			<label className={targets.length > 1 ? "visually-hidden" : "label"} htmlFor={ids.note}>
				{targets.length > 1 ? `Note to ${target.label}` : target.label}
			</label>
			<textarea
				id={ids.note}
				className="input textarea"
				rows={2}
				value={note}
				maxLength={MAX_NOTE_CHARS}
				onChange={event => setNote(event.target.value)}
				readOnly={busy}
			/>
			<div className="item-steer-foot">
				<p className="field-note">Goes into the turn that runs now, or with the next one.</p>
				<button type="submit" className="button button-outline" disabled={note.trim() === "" || busy}>
					{busy ? "Sending…" : "Send note"}
				</button>
			</div>
			<Failure error={acting.error} />
		</form>
	);
}

const TAKES_NOTES = new Set<ItemSummary["state"]>(["queued", "working", "waiting"]);

function Now({ view, now }: { view: ItemView; now: number }) {
	const last = view.events[view.events.length - 1] ?? null;
	const host = hostWords(view.repository.provider);
	const step = view.run?.step ?? null;
	let text: string;
	let when: ReactNode = null;
	switch (view.state) {
		case "draft":
			text = readFirst(view)
				? "A draft: read its task below, then start it."
				: "A draft: nothing runs until you start it.";
			break;
		case "queued":
			text = "Started: it waits for its first turn.";
			break;
		case "working":
			text = (step && STEP_DOING[step.kind]) ?? "It is being worked on.";
			if (step)
				when = (
					<span>
						since <When at={step.startedAt} now={now} />
					</span>
				);
			break;
		case "waiting":
			text = view.wait?.sentence ?? "It waits.";
			if (view.wait) {
				when = (
					<>
						<span>
							since <When at={view.wait.since} now={now} />
						</span>
						{view.wait.retryAt === null || view.wait.retryAt <= now ? null : (
							<span>
								looks again at <When at={view.wait.retryAt} now={now} />
							</span>
						)}
					</>
				);
			}
			break;
		case "review":
			if (view.review?.recommendation === "changes_requested")
				text =
					view.review.state === "none"
						? "Handed to you before re-review finished after changes were requested."
						: "Handed to you with changes requested by the code reviewer.";
			else
				text = `Handed to you. The ${host.noun} waits for your review; the platform never merges it. When it is merged or closed on ${host.name}, the item says so.`;
			break;
		default:
			text = last?.said ?? STATE_WORD[view.state];
			if (last)
				when = (
					<span>
						<When at={last.at} now={now} />
					</span>
				);
	}
	return (
		<div className={`item-now item-now-${view.state}${view.question ? " item-now-asks" : ""}`}>
			<span className="item-now-glyph">
				<ItemGlyph item={view} />
			</span>
			<div>
				<p className="item-now-state">
					{STATE_WORD[view.state]}
					{view.state === "working" && step ? <span className="item-now-step">{STEP_WORD[step.kind]}</span> : null}
				</p>
				<p className="item-now-text">{text}</p>
				{when ? <p className="agent-meta item-now-when">{when}</p> : null}
			</div>
		</div>
	);
}

export function ValidatedEnvironment({
	environment,
	now,
}: {
	environment: SessionSummary["environment"] | undefined;
	now: number;
}) {
	if (!environment) return null;
	return (
		<span
			title={`Setup and ${environment.checks === 1 ? "the saved check" : `${environment.checks} saved checks`} passed at ${environment.commit.slice(0, 12)}, ${absoluteTime(environment.validatedAt)}`}
		>
			from a validated environment ({relativeTime(environment.validatedAt, now)})
		</span>
	);
}

export function RunFacts({
	run,
	events,
	asks,
	now,
	waitingForCi = false,
}: {
	run: NonNullable<ItemView["run"]>;
	events: ItemEvent[];
	asks: boolean;
	now: number;
	waitingForCi?: boolean;
}) {
	const { step, rounds } = run;
	const sentBack = events.filter(event => event.step === null && event.said.startsWith("Sent back")).length;
	return (
		<dl className="usage-facts item-facts">
			<div>
				<dt>Run</dt>
				<dd>
					The {ordinal(run.n)}
					{run.n > 1
						? sentBack > 0
							? `, after it was sent back ${sentBack === 1 ? "once" : plural(sentBack, "time")}`
							: ", after a retry"
						: ""}
					; started <When at={run.startedAt} now={now} />
					{run.endedAt !== null ? (
						<>
							, ended <When at={run.endedAt} now={now} />
						</>
					) : null}
				</dd>
			</div>
			{run.endedAt === null ? (
				<div>
					<dt>{asks ? "Stopped at" : "Step"}</dt>
					<dd>
						{step.kind === "subtasks" && waitingForCi ? "Checking the whole feature in CI" : STEP_WORD[step.kind]}
						{TRIED.has(step.kind) && step.attempt > 1 ? `, ${ordinal(step.attempt)} try` : ""}
						{step.turn === "delivered" ? (
							<span className="tone-dim"> · its turn waits to start</span>
						) : step.turn === "started" ? (
							<span className="tone-dim"> · its turn runs</span>
						) : null}
					</dd>
				</div>
			) : null}
			{(rounds.gate > 0 || rounds.ci > 0 || rounds.conflict > 0 || !!rounds.review) && (
				<div>
					<dt>Fixes</dt>
					<dd>
						<span className="item-rounds">
							<span>after your checks {rounds.gate}</span>
							<span>after CI {rounds.ci}</span>
							<span>merging the base {rounds.conflict}</span>
							{(rounds.review ?? 0) > 0 ? <span>after the second review {rounds.review}</span> : null}
						</span>
					</dd>
				</div>
			)}
		</dl>
	);
}

const BUDGET_FIELDS: Array<{
	key: keyof ItemBudget;
	label: string;
	unit: string;
	toInput(value: number): string;
	fromInput(text: string): number;
	spelled(value: number): string;
}> = [
	{
		key: "tokens",
		label: "Tokens",
		unit: "millions",
		toInput: value => String(Number((value / 1e6).toFixed(2))),
		fromInput: text => Math.round(Number(text) * 1e6),
		spelled: compact,
	},
	{
		key: "hostedSeconds",
		label: "Hosted time",
		unit: "hours",
		toInput: value => String(Number((value / 3600).toFixed(2))),
		fromInput: text => Math.round(Number(text) * 3600),
		spelled: sandboxTime,
	},
];

const budgetFields = (view: Pick<ItemView, "place">) =>
	BUDGET_FIELDS.filter(field => field.key !== "hostedSeconds" || view.place.kind === "hosted");

function RaiseBudget({
	view,
	busy,
	onRaise,
	onBack,
}: {
	view: ItemView;
	busy: boolean;
	onRaise(budget: Partial<ItemBudget>): void;
	onBack(): void;
}) {
	const fields = budgetFields(view);
	const [values, setValues] = useState(
		() =>
			Object.fromEntries(fields.map(field => [field.key, field.toInput(view.budget[field.key])])) as Record<
				keyof ItemBudget,
				string
			>,
	);
	const base = useId();
	const parsed = fields.map(field => ({ field, value: field.fromInput(values[field.key]) }));
	const bad = parsed.some(({ value }) => !Number.isFinite(value) || value <= 0);
	const short = parsed.filter(
		({ field, value }) => view.spent[field.key] >= view.budget[field.key] && value <= view.spent[field.key],
	);
	const changed = Object.fromEntries(
		parsed.filter(({ field, value }) => value !== view.budget[field.key]).map(({ field, value }) => [field.key, value]),
	) as Partial<ItemBudget>;
	return (
		<div className="item-raise">
			<div className="item-raise-fields">
				{fields.map(field => {
					const reached = view.spent[field.key] >= view.budget[field.key];
					return (
						<div key={field.key}>
							<label className="label" htmlFor={`${base}-${field.key}`}>
								{field.label}
								{field.unit ? <span className="label-optional">{field.unit}</span> : null}
							</label>
							<input
								id={`${base}-${field.key}`}
								className={`input input-mono${reached && short.some(one => one.field === field) ? " input-invalid" : ""}`}
								inputMode="decimal"
								value={values[field.key]}
								readOnly={busy}
								onChange={event => setValues(now => ({ ...now, [field.key]: event.target.value }))}
							/>
							<p className={`field-note${reached ? " tone-warn" : ""}`}>
								{field.spelled(view.spent[field.key])} used{reached ? ", the limit" : ""}
							</p>
						</div>
					);
				})}
			</div>
			<p className="field-note">
				For this item only{view.parent ? "; what you give a subtask adds to its feature's budget" : ""}. It goes on in
				the same session and sandbox.{" "}
				{short.length > 0
					? `Raise ${short.map(({ field }) => field.label.toLowerCase()).join(" and ")} above what is used, or it stops again at once.`
					: ""}
			</p>
			<div className="item-choices">
				<button
					type="button"
					className="button button-primary"
					disabled={busy || bad || short.length > 0 || Object.keys(changed).length === 0}
					onClick={() => onRaise(changed)}
				>
					{busy ? "Sending…" : "Give it this and go on"}
				</button>
				<button type="button" className="button button-quiet" onClick={onBack} disabled={busy}>
					Back
				</button>
			</div>
		</div>
	);
}

function Question({
	view,
	question,
	acting,
	now,
}: {
	view: ItemView;
	question: ItemQuestion;
	acting: Acting;
	now: number;
}) {
	// No agent is left to read a note once its machine was removed.
	const noted = !["machine_removed", "feedback_feature", "feedback_more", "push_ci", "ready_refused"].includes(
		question.kind,
	);
	const [note, setNote] = useState("");
	const [raising, setRaising] = useState(false);
	const ids = { title: useId(), note: useId(), asked: useId() };
	const busy = acting.busy !== null;
	// The agent's own question: its words are the reply's subject, and the reply is the note, so the note is needed.
	const asked = question.kind === "agent_ask" ? (question.asked ?? null) : null;
	const replying = question.kind === "agent_ask";
	// The host refused to mark the pull request ready: the person's own way is on the host, so that link leads.
	const onHost = question.kind === "ready_refused" && view.pullRequest ? view.pullRequest : null;
	const host = hostWords(view.repository.provider);
	const answer = (choice: ChoiceId, budget?: Partial<ItemBudget>) =>
		acting.act({
			kind: "answer",
			question: question.id,
			choice,
			...(!noted || note.trim() === "" ? {} : { note: note.trim() }),
			...(budget ? { budget } : {}),
		});
	return (
		<section className="item-question" aria-labelledby={ids.title}>
			<p className="item-question-head" id={ids.title}>
				It asks you
				<span className="item-question-when">
					<When at={question.askedAt} now={now} />
				</span>
			</p>
			<LongText lines={6} className="item-question-text">
				{question.text}
			</LongText>
			{question.push ? (
				<p className="item-question-text">
					<code>{question.push.head.slice(0, 7)}</code> · {question.push.author} · {question.push.message}
				</p>
			) : null}
			{question.check ? <EnvironmentCheck check={question.check} /> : null}
			{question.kind === "sandboxes" ? (
				<p className="item-question-text">
					<a className="link" {...linkProps({ name: "usage" })}>
						Free a sandbox on Usage
					</a>
				</p>
			) : null}
			{asked ? <AgentAsked id={ids.asked} asked={asked} busy={busy} chosen={note} onPick={setNote} /> : null}
			{raising ? (
				<RaiseBudget
					view={view}
					busy={acting.busy === "raise"}
					onRaise={budget => answer("raise", budget)}
					onBack={() => setRaising(false)}
				/>
			) : (
				<>
					{noted ? (
						<div>
							<label className="label" htmlFor={ids.note}>
								{replying ? (
									"Your answer"
								) : (
									<>
										A note to the agent<span className="label-optional">optional</span>
									</>
								)}
							</label>
							<textarea
								id={ids.note}
								className="input textarea item-note"
								value={note}
								maxLength={MAX_NOTE_CHARS}
								onChange={event => setNote(event.target.value)}
								readOnly={busy}
								required={replying}
								aria-describedby={asked ? ids.asked : undefined}
							/>
						</div>
					) : null}
					<div className="item-choices">
						{onHost ? (
							<a className="button button-primary" href={onHost.url} target="_blank" rel="noreferrer">
								<ProviderIcon id={view.repository.provider} size={14} />
								Mark {host.mark}
								{onHost.number} ready on {host.name}
								<ExternalIcon size={12} />
							</a>
						) : null}
						{question.choices
							.filter(choice => !view.parent || question.kind === "branch_push" || choice.id !== "hand_over")
							.flatMap((choice, index) => [
								<button
									key={choice.id}
									type="button"
									className={`button ${onHost ? (choice.id === "dismiss" ? "button-quiet" : "button-outline") : (question.recommended ? choice.id === question.recommended : index === 0) ? "button-primary" : choice.id === "give_up" ? "button-quiet" : "button-outline"}`}
									disabled={busy || (choice.id === "reply" && note.trim() === "")}
									onClick={() => answer(choice.id)}
								>
									{acting.busy === choice.id ? "Sending…" : choice.label}
								</button>,
								// "Give it N more" at another figure: beside it, before the other choices.
								...(choice.id === "raise" && question.kind === "budget"
									? [
											<button
												key="amount"
												type="button"
												className="button button-quiet"
												disabled={busy}
												onClick={() => setRaising(true)}
											>
												Another amount…
											</button>,
										]
									: []),
							])}
					</div>
				</>
			)}
			<Failure error={acting.error} />
		</section>
	);
}

function SecretQuestion({
	view,
	question,
	secret,
	acting,
	now,
	failure,
	reload,
	onSaved,
	onFailed,
}: {
	view: ItemView;
	question: ItemQuestion;
	secret: NonNullable<ItemQuestion["secret"]>;
	acting: Acting;
	now: number;
	failure: string | null;
	reload(): Promise<void> | void;
	onSaved(name: string): void;
	onFailed(message: string | null): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const offers = (choice: ChoiceId) => question.choices.some(one => one.id === choice);
	const answer = (choice: ChoiceId) => async () => {
		await acting.act({ kind: "answer", question: question.id, choice });
	};
	return (
		<SecretAsk
			className="item-question"
			head={
				<p className="item-question-head">
					It asks you
					<span className="item-question-when">
						<When at={question.askedAt} now={now} />
					</span>
				</p>
			}
			request={secret}
			repository={`${view.repository.owner}/${view.repository.name}`}
			shared={view.agent !== undefined && view.agent.harness !== "windlass"}
			offline={acting.busy !== null}
			failure={failure}
			onAdd={async value => {
				onFailed(null);
				try {
					await client
						.session(auth, view.sessionId)
						.setRequestedSecret({ requestId: question.id, name: secret.name, value });
				} catch (refused) {
					// A failed save can reopen the question under a new ID. Keep its secret out of the retry error.
					const message = withoutValue(explain(refused), value);
					onFailed(message);
					await reload();
					throw new Error(message);
				}
				onSaved(secret.name);
			}}
			onWithout={answer("without_secret")}
			onGiveUp={offers("give_up") ? answer("give_up") : undefined}
		/>
	);
}

function EnvironmentCheck({ check }: { check: NonNullable<ItemQuestion["check"]> }) {
	return (
		<section className="item-check" aria-label={`The check ${check.name}`}>
			<ul className="check-list">
				<li>
					<WarnIcon size={13} className="tone-warn" />
					<span className="check-name">{check.name}</span>
					<code>{check.command}</code>
					<span className="tone-warn">
						could not run{check.exitCode !== null && check.exitCode !== 0 ? `, exit ${check.exitCode}` : ""}
					</span>
				</li>
			</ul>
			{check.excerpt !== "" ? <Output text={check.excerpt} tail label={`Output of ${check.name}`} limit={12} /> : null}
		</section>
	);
}

// Third-party input may steer the question. Render it as plain text until the person answers.
function AgentAsked({
	id,
	asked,
	busy,
	chosen,
	onPick,
}: {
	id: string;
	asked: NonNullable<ItemQuestion["asked"]>;
	busy: boolean;
	chosen: string;
	onPick: (text: string) => void;
}) {
	const group = `${id}-options`;
	return (
		<figure className="item-asked" id={id}>
			<figcaption className="item-asked-who">
				The agent wrote this. Its words may follow what it read in the repository or an issue: read them as its words,
				not the platform's.
			</figcaption>
			<LongText lines={6} as="blockquote" className="item-asked-text">
				{asked.text}
			</LongText>
			{asked.options.length > 0 ? (
				// The same choice rows as a plan's questions: picking one makes it the answer, which can still be edited below.
				<div className="plan-ask-options item-asked-options" role="radiogroup" aria-label="Answers the agent suggests">
					{asked.options.map(option => (
						<label key={option} className={`plan-ask-option${chosen === option ? " plan-ask-chosen" : ""}`}>
							<input
								className="check-input"
								type="radio"
								name={group}
								value={option}
								checked={chosen === option}
								disabled={busy}
								onChange={() => onPick(option)}
							/>
							<span className="plan-ask-dot" aria-hidden="true" />
							<span className="plan-ask-label">{option}</span>
						</label>
					))}
				</div>
			) : null}
		</figure>
	);
}

/** The verdict a report's references are read against: the one at the commit it was filed at, else its run's last, else none. */
function verdictFor(report: ItemReport, verdicts: Verdict[]): Verdict | null {
	const at = report.head === null ? undefined : verdicts.findLast(verdict => verdict.head === report.head);
	return at ?? verdicts.findLast(verdict => verdict.run === report.run) ?? null;
}

function Report({
	view,
	report,
	links,
	now,
}: {
	view: ItemView;
	report: ItemReport;
	links: ScreenshotLinks;
	now: number;
}) {
	const latest = view.verdicts[view.verdicts.length - 1];
	const earlierRun = view.run !== null && report.run !== view.run.n;
	const earlierCommit = !earlierRun && report.head !== null && latest !== undefined && latest.head !== report.head;
	const shots = report.screenshots ?? [];
	return (
		<section className="usage-section" aria-labelledby="item-report">
			<h2 className="usage-title" id="item-report">
				From the agent that made the change
			</h2>
			<p className="usage-lede">
				{earlierRun ? `From its report in the ${ordinal(report.run)} run. ` : ""}Its own words, filed with its report:
				the checks above do not rest on them.
			</p>
			<article className="item-verdict-block">
				<p className="item-verdict-head">
					<span className="item-report-title">{report.title}</span>
					<span className="agent-meta">
						<span>
							filed <When at={report.at} now={now} />
						</span>
						{earlierRun ? <span>the {ordinal(report.run)} run</span> : null}
						{report.head !== null ? <span>at {report.head.slice(0, 7)}</span> : <span>before a push</span>}
						{earlierCommit ? <span>an earlier commit than the verdict's</span> : null}
					</span>
				</p>
				<ReviewBlocks
					blocks={report.blocks}
					records={report.records ?? []}
					verdict={verdictFor(report, view.verdicts)}
					author="The agent"
					screenshots={{ shots, links }}
				/>
			</article>
		</section>
	);
}

/** A feature's parts' screenshot sets, grouped by part: the part with the newest set first, and in each part its newest set first. */
export function groupPartScreenshots(sets: readonly PartScreenshots[]): PartScreenshots[][] {
	const groups = new Map<string, PartScreenshots[]>();
	for (const set of [...sets].sort((a, b) => b.at - a.at))
		groups.set(set.itemId, [...(groups.get(set.itemId) ?? []), set]);
	return [...groups.values()];
}

/** One part's screenshots on its feature's page, their links asked on the part's own item. */
function PartShots({ plan, sets, now }: { plan: ItemView["plan"]; sets: PartScreenshots[]; now: number }) {
	const [latest] = sets;
	const links = useScreenshotLinks(
		latest!.itemId,
		sets.flatMap(set => set.screenshots),
	);
	return (
		<article className="item-verdict-block">
			<p className="item-verdict-head">
				<a className="item-report-title" {...linkProps({ name: "item", id: latest!.itemId })}>
					{partName(plan, latest!.key, latest!.title)}
				</a>
				<span className="agent-meta">
					<span>
						latest filed <When at={latest!.at} now={now} />
					</span>
					{sets.length > 1 ? <span>{plural(sets.length, "set")}</span> : null}
				</span>
			</p>
			{sets.map((set, index) => (
				<Screenshots
					key={`${set.by}:${set.at}`}
					by={set.by}
					head={set.head}
					shots={set.screenshots}
					links={links}
					label={
						sets.length === 1 ? (
							"Screenshots"
						) : index === 0 ? (
							"Latest"
						) : (
							<>
								Earlier, filed <When at={set.at} now={now} />
							</>
						)
					}
				/>
			))}
		</article>
	);
}

/** Every part's screenshots on the feature's page, so none has to be looked for on its part's own page. */
function PartScreenshotsSection({ view, now }: { view: ItemView; now: number }) {
	const groups = groupPartScreenshots(view.partScreenshots ?? []);
	if (groups.length === 0) return null;
	return (
		<section className="usage-section" aria-labelledby="item-part-shots">
			<h2 className="usage-title" id="item-part-shots">
				Screenshots from the parts
				<span className="usage-count">
					{plural(
						groups.reduce((sum, sets) => sum + sets.reduce((n, set) => n + set.screenshots.length, 0), 0),
						"screenshot",
					)}
				</span>
			</h2>
			<p className="usage-lede">
				Filed by each part's agents with their reports and reviews. The part that filed last comes first.
			</p>
			<div className="item-part-shots">
				{groups.map(sets => (
					<PartShots key={sets[0]!.itemId} plan={view.plan} sets={sets} now={now} />
				))}
			</div>
		</section>
	);
}

function spendFacts(view: ItemView): { label: string; value: string }[] {
	return [
		{ label: "Turns", value: plural(view.spent.turns, "turn") },
		{ label: "Working time", value: sandboxTime(view.spent.activeSeconds) },
	];
}

function Cost({ view, now }: { view: ItemView; now: number }) {
	const step = view.run?.step;
	const rows = budgetFields(view);
	const hosted = view.place.kind === "hosted";
	const children = view.children ?? [];
	const partAgents = [...new Set(children.flatMap(child => (child.agent ? [agentLine(child.agent)] : [])))];
	// A part on a subscription agent spends no counted token: its turns and time are what it cost.
	const subscribed = children.filter(child => child.agent?.tokens === "subscription");
	const facts = [
		...spendFacts(view),
		...agentFacts(view.agent),
		...(subscribed.length
			? [
					{
						label: `${plural(subscribed.length, "part")} on a subscription`,
						value: `${subscriptionSpend({ turns: subscribed.reduce((n, child) => n + child.spent.turns, 0), activeSeconds: subscribed.reduce((n, child) => n + child.spent.activeSeconds, 0) })}, not counted: your subscription`,
					},
				]
			: []),
	];
	return (
		<section className="usage-section" aria-labelledby="item-cost">
			<h2 className="usage-title" id="item-cost">
				Cost so far
			</h2>
			<p className="usage-note">
				{partAgents.length > 0 ? "Planned by" : "Built by"}{" "}
				<AgentGlyph harness={view.agent?.harness ?? "windlass"} size={11} inline />
				{agentLine(view.agent)}
				{partAgents.length > 0 ? `; parts built by ${partAgents.join(" and ")}` : ""}.
			</p>
			{view.state === "working" && view.spent.turns === 0 && step?.turn === "started" && (
				<p className="usage-note">
					Spend is counted when the running turn ends. This step started {sandboxTime((now - step.startedAt) / 1000)}{" "}
					ago.
				</p>
			)}
			<div className="usage-card item-cost-card">
				<ItemSpend spent={view.spent} budget={view.budget} fields={rows} agent={view.agent} />
				{facts.length > 0 ? (
					<dl className="item-cost-foot">
						{facts.map(fact => (
							<div key={fact.label}>
								<dt>{fact.label}</dt>
								<dd>{fact.value}</dd>
							</div>
						))}
					</dl>
				) : null}
			</div>
			<details className="usage-note">
				<summary>How this is counted</summary>
				<p>
					{compact(view.spent.rawTokens ?? view.spent.tokens)} raw tokens reported. For the budget, cached input tokens
					count at a tenth.
				</p>
				<p>
					Working time excludes waits for a turn, CI or your answer.
					{!hosted && " Waiting for your machine is also excluded. Your machine uses no hosted time."}
				</p>
			</details>
		</section>
	);
}

interface RunPart {
	run: number;
	events: ItemEvent[];
}

/** The log in runs. An entry outside any step (started, sent back) belongs to the run that follows it; one after every step, to the last. */
function partsOf(events: ItemEvent[]): RunPart[] {
	const runs: Array<number | null> = events.map(event => event.step?.run ?? null);
	let next: number | null = null;
	for (let index = runs.length - 1; index >= 0; index--) runs[index] = next = runs[index] ?? next;
	const parts: RunPart[] = [];
	events.forEach((event, index) => {
		const run = runs[index] ?? parts[parts.length - 1]?.run ?? 1;
		const last = parts[parts.length - 1];
		if (last?.run === run) last.events.push(event);
		else parts.push({ run, events: [event] });
	});
	return parts;
}

function LogEntry({ event, now, uid }: { event: ItemEvent; now: number; uid: string }) {
	const person = event.by.startsWith("person:");
	return (
		<li className="item-event">
			<span className="item-event-time">
				<When at={event.at} now={now} />
			</span>
			<span className="item-event-step">{event.step ? STEP_WORD[event.step.kind] : ""}</span>
			<LongText lines={2} className="item-event-said">
				<InlineMarkdown text={event.said} />
				{person ? <span className="tone-faint"> · {event.by === `person:${uid}` ? "you" : "a person"}</span> : null}
			</LongText>
			{/* The agent's own question, kept after it was answered: its words in plain text, as `AgentAsked` shows them. */}
			{event.asked ? (
				<figure className="item-event-asked">
					<figcaption className="item-asked-who">The agent asked:</figcaption>
					<blockquote className="item-asked-text">{event.asked}</blockquote>
				</figure>
			) : null}
		</li>
	);
}

function Log({ view, now }: { view: ItemView; now: number }) {
	const auth = useAuth();
	const parts = partsOf(view.events);
	const [open, setOpen] = useState<Set<number>>(() => new Set());
	const current = parts[parts.length - 1]?.run ?? 0;
	const runs = new Set(parts.map(part => part.run)).size;
	return (
		<section className="usage-section" aria-labelledby="item-log">
			<h2 className="usage-title" id="item-log">
				What happened
				{view.events.length > 0 ? <span className="usage-count">{view.events.length}</span> : null}
			</h2>
			{parts.length === 0 ? (
				<p className="usage-empty">Nothing yet: it has not been started.</p>
			) : (
				parts.map((part, index) => {
					const folded = part.run !== current && !open.has(index);
					const id = `item-run-${index}`;
					return (
						<div key={index} className="item-log-run">
							{runs > 1 ? (
								<p className="items-group-head item-log-head">
									{part.run === current ? (
										`The ${ordinal(part.run)} run`
									) : (
										<button
											type="button"
											className="link machine-toggle"
											aria-expanded={!folded}
											aria-controls={id}
											onClick={() =>
												setOpen(
													now => new Set(now.has(index) ? [...now].filter(one => one !== index) : [...now, index]),
												)
											}
										>
											<ChevronIcon size={11} className="machine-chevron" />
											The {ordinal(part.run)} run
										</button>
									)}
									<span className="items-group-count">{plural(part.events.length, "entry", "entries")}</span>
								</p>
							) : null}
							<ol className="item-log" id={id} hidden={folded}>
								{part.events.map((event, at) => (
									<LogEntry key={at} event={event} now={now} uid={auth.profile.uid} />
								))}
							</ol>
						</div>
					);
				})
			)}
		</section>
	);
}

/** A draft from an issue someone else wrote: its task is that person's text, which its person reads before starting it. */
const readFirst = (item: Pick<ItemView, "state" | "origin">) =>
	item.state === "draft" && item.origin !== null && item.origin !== undefined && !originIssue(item.origin).trusted;

function IssueOrigin({ origin }: { origin: NonNullable<ItemView["origin"]> }) {
	const { url, author, tracker, label, provider } = originIssue(origin);
	return (
		<span className="item-origin">
			from{" "}
			<a className="item-origin-issue" href={url} target="_blank" rel="noreferrer" title={`${tracker} issue ${label}`}>
				<ProviderIcon id={provider} size={12} />
				{label}
			</a>{" "}
			by {author}
		</span>
	);
}

/** An item filed without an issue to link: "from the web", "from the API", or the source's mark and name. */
function FiledFrom({ source }: { source: ItemView["source"] }) {
	const provider = providerOf(source);
	return (
		<span className="item-filed-from">
			from{" "}
			{provider ? (
				<span className="item-origin-issue">
					<ProviderIcon id={provider} size={12} />
					{filingSource[source]}
				</span>
			) : (
				filingSource[source]
			)}
		</span>
	);
}

// Issue text stays plain. Only platform criteria may style inline code.
function TaskText({ task, codeSpans = false }: { task: ItemView["task"]; codeSpans?: boolean }) {
	return (
		<>
			{task.body ? (
				<LongText lines={6} className="item-body-text">
					{task.body}
				</LongText>
			) : (
				<p className="usage-empty">Only the title was given.</p>
			)}
			{task.acceptance.length > 0 ? (
				<>
					<p className="machine-label item-task-label">Acceptance criteria</p>
					<ul className="item-criteria-list">
						{task.acceptance.map(line => (
							<li key={line}>{codeSpans ? <Inline text={line} /> : line}</li>
						))}
					</ul>
				</>
			) : null}
		</>
	);
}

function ReadFirst({ view, acting }: { view: ItemView; acting: Acting }) {
	const origin = view.origin ? originIssue(view.origin) : null;
	const author = origin?.author ?? "";
	return (
		<section className="usage-section" aria-labelledby="item-task">
			<h2 className="usage-title" id="item-task">
				The task
			</h2>
			<div className="item-read">
				<p className="callout callout-info">
					<InfoIcon />
					<span>
						The text below was written by {author} on {origin?.tracker ?? "GitHub"}, not by you. Starting the item gives
						the agent this text, as it is shown here.
					</span>
				</p>
				<div className="item-snapshot">
					<TaskText task={view.task} />
				</div>
				<div className="item-choices">
					<button
						type="button"
						className="button button-primary"
						onClick={() => acting.act({ kind: "start" })}
						disabled={acting.busy !== null}
					>
						{acting.busy === "start" ? "Starting…" : "Start"}
					</button>
				</div>
				<Failure error={acting.error} />
			</div>
		</section>
	);
}

// Cross-repository features have no single repository to authorize.
function useAllowHost(view: ItemView | null): AllowHostContext | null {
	const { client, explain } = useApp();
	const auth = useAuth();
	const sessionId = view?.sessionId ?? "";
	const several = (view?.repositories?.length ?? 1) > 1;
	const repositoryId = view?.repository.id ?? null;
	const allow = useCallback(
		async (host: string) => {
			try {
				return await client.session(auth, sessionId).allowHost(host);
			} catch (failure) {
				throw new Error(explain(failure));
			}
		},
		[client, auth, sessionId, explain],
	);
	return useMemo(
		() => (several || !sessionId || repositoryId === null ? null : { allow, repositoryId }),
		[several, sessionId, repositoryId, allow],
	);
}

export function Item({ page }: { page: ItemPage }) {
	const now = useNow(30_000);
	const { sessions } = useSessions();
	const { view } = page;
	// A plan action refused because the plan moved on: the page reads the item again, and its card says so until the next action.
	const [conflicted, setConflicted] = useState(false);
	const [approvalSettingFailed, setApprovalSettingFailed] = useState(false);
	// The name of the secret just added for the builder's request, said until the item asks something else.
	const [secretSaved, setSecretSaved] = useState<string | null>(null);
	// The last save's error for the builder's request, kept for the question it reopens under a new id; dropped once the item asks something else.
	const [secretFailure, setSecretFailure] = useState<{ name: string; message: string } | null>(null);
	const asking = view?.question?.id ?? null;
	const askingSecret = view?.question?.kind === "secret_needed" ? (view.question.secret?.name ?? null) : null;
	useEffect(() => {
		if (asking !== null) setSecretSaved(null);
	}, [asking]);
	useEffect(() => {
		if (asking !== null && askingSecret === null) setSecretFailure(null);
	}, [asking, askingSecret]);
	const acting = useActing(
		view?.id ?? "",
		next => {
			setConflicted(false);
			setApprovalSettingFailed(false);
			page.replace(next);
		},
		(kind, conflict) => {
			if (conflict && (kind === "edit_plan" || kind === "approve_plan")) setConflicted(true);
			page.reload();
		},
	);
	// Both agents' screenshots, the builder's and the second reviewer's: their links are asked in one question.
	const links = useScreenshotLinks(
		view?.id ?? "",
		view ? [...(view.report?.screenshots ?? []), ...view.reviews.flatMap(reviewShots)] : [],
	);
	const [dialog, setDialog] = useState<"cancel" | "send_back" | null>(null);
	const review = usePlanReview(view, acting);
	// Undefined for a hosted item and while the list is read; null once its machine is known to be removed.
	const machine = useSessionMachine(view?.place);
	const { platform } = useApp();
	const allowContext = useAllowHost(view);
	// A subtask's feature, for its siblings: read as the feature's own page is, and kept current by the feed.
	const feature = useItem(view?.parent?.itemId ?? "", Boolean(view?.parent));

	if (view === null) {
		return (
			<main className="home usage repo item">
				<section className="usage-section">
					{page.error ? (
						<div className="state state-error" role="alert">
							<WarnIcon size={22} />
							<h2>{page.missing ? "This work item is not one of yours" : "The work item could not be loaded"}</h2>
							<p>{page.error}</p>
							{page.missing ? (
								<MissingPageLinks section="factory" />
							) : (
								<button type="button" className="button button-outline" onClick={page.reload}>
									Try again
								</button>
							)}
						</div>
					) : (
						<div className="usage-loading" aria-busy="true" aria-label="Loading the work item">
							<span className="skeleton skeleton-title" style={{ width: "44%" }} />
							<span className="skeleton skeleton-meta" style={{ width: "100%" }} />
							<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
						</div>
					)}
				</section>
			</main>
		);
	}

	const ended = view.state === "done" || view.state === "cancelled";
	const busy = acting.busy !== null;
	const reviewer = platform.info?.items?.reviewer !== false;
	const { repository } = view;
	const reading = readFirst(view);
	// A subtask's place in its feature's plan, once the feature is read: "Part 2 of 5 of <feature>".
	const part = view.parent && feature.view?.plan ? partOf(feature.view.plan, view.parent.key) : null;
	const repair = view.parent ? repairKind(view.parent.key) : null;

	const noteTargets =
		view.mode === "orchestrate"
			? (view.children ?? [])
					.filter(child => TAKES_NOTES.has(child.state))
					.map(child => {
						const name = child.parent ? partName(view.plan, child.parent.key, child.title) : child.title;
						return { id: child.id, label: name === child.title ? `The part: ${child.title}` : name };
					})
			: TAKES_NOTES.has(view.state)
				? [{ id: view.id, label: view.parent ? "Note to this part" : "Note to the agent" }]
				: [];
	const moreActions: MenuItem[] = [];
	if (view.canUpdateFeature && !view.question?.choices.some(choice => choice.id === "update_feature")) {
		moreActions.push({
			id: "update_feature",
			label: `Update the feature from ${view.task.base}`,
			onSelect: () => acting.act({ kind: "update_feature" }),
		});
	}
	const canSendBack = view.state === "review" && machine !== null;
	if (!ended) moreActions.push({ id: "cancel", label: "Cancel…", onSelect: () => setDialog("cancel") });

	return (
		<main className="home usage repo item">
			<header className="item-header">
				<h1 className="display display-small item-title">{view.title}</h1>
				<div className="item-actions" role="group" aria-label="Item actions">
					{view.pullRequest ? (
						<a
							className="button button-outline button-small"
							href={view.pullRequest.url}
							target="_blank"
							rel="noreferrer"
						>
							<ProviderIcon id={repository.provider} size={13} />
							{hostWords(repository.provider).short} {requestNumber(repository.provider, view.pullRequest.number)}{" "}
							<ExternalIcon size={12} />
						</a>
					) : null}
					{!view.awaitingPlace ? (
						<a
							className="button button-outline button-small"
							{...linkProps({ name: "session", id: view.sessionId })}
							title="What its agent did, turn by turn"
						>
							Builder
						</a>
					) : null}
					{view.reviewerSessionId ? (
						<a
							className="button button-outline button-small"
							{...linkProps({ name: "session", id: view.reviewerSessionId })}
						>
							Code review
						</a>
					) : null}
					{repository.provider === "gitlab" &&
					view.state === "review" &&
					view.verdict?.ci === "passed" &&
					view.pullRequest ? (
						<GitlabMerge view={view} onDone={page.replace} />
					) : null}
					{canSendBack ? (
						<button
							type="button"
							className="button button-outline button-small"
							onClick={() => setDialog("send_back")}
							disabled={busy}
							title="Send it back to the agent with what to change"
						>
							Send back
						</button>
					) : null}
					{view.state === "draft" && !reading ? (
						<button
							type="button"
							className="button button-outline button-small"
							onClick={() => acting.act({ kind: "start" })}
							disabled={busy}
						>
							{acting.busy === "start" ? "Starting…" : "Start"}
						</button>
					) : null}
					{view.state === "failed" &&
					(view.canRetry ?? (!view.parent && view.mode !== "orchestrate")) &&
					machine !== null ? (
						<button
							type="button"
							className="button button-outline button-small"
							onClick={() => acting.act({ kind: "retry" })}
							disabled={busy}
						>
							{acting.busy === "retry" ? "Starting…" : "Retry"}
						</button>
					) : null}
					{moreActions.length > 0 ? (
						<Menu
							align="end"
							spec={{
								label: "More item actions",
								groups: [{ id: "actions", items: moreActions }],
								hints: false,
								width: 224,
							}}
							trigger={props => (
								<button
									type="button"
									className="icon-button item-more"
									aria-label="More item actions"
									title="More item actions"
									disabled={busy}
									{...props}
								>
									⋯
								</button>
							)}
						/>
					) : null}
				</div>
				<p className="item-meta">
					<span>
						<a
							{...(repository.provider === "gitlab"
								? { href: repository.url, target: "_blank", rel: "noreferrer" }
								: linkProps({ name: "repository", id: repository.id }))}
						>
							{repository.owner}/{repository.name}
						</a>{" "}
						→ <BranchName branch={view.task.base} />
					</span>
					{view.origin ? <IssueOrigin origin={view.origin} /> : <FiledFrom source={view.source} />}
					<time dateTime={new Date(view.createdAt).toISOString()} title={absoluteTime(view.createdAt)}>
						filed {relativeTime(view.createdAt, now)}
					</time>
					{view.endedAt !== undefined ? (
						<time dateTime={new Date(view.endedAt).toISOString()} title={absoluteTime(view.endedAt)}>
							ended {relativeTime(view.endedAt, now)}
						</time>
					) : null}
					{view.parent ? (
						<span>
							{part ? `Part ${part.n} of ${part.of} of` : repair ? "a repair the factory added to" : "subtask of"}{" "}
							<a {...linkProps({ name: "item", id: view.parent.itemId })}>{view.parent.title}</a>
						</span>
					) : (
						<span title={ITEM_MODE_WORDS[view.mode ?? "single"].description}>
							{view.mode === "orchestrate" ? "Plan first" : view.plan ? "Plan first · one implementer" : "Quick"}
						</span>
					)}
					{view.awaitingPlace ? (
						<span>awaiting machine placement</span>
					) : view.place.kind === "machine" ? (
						<span>
							{machine === null
								? "on a machine that was removed"
								: machine
									? `on your machine “${machineLabel(machine)}”`
									: "on your machine"}
						</span>
					) : view.placement ? (
						<span>runs on {view.placement.name}</span>
					) : null}
					<ValidatedEnvironment environment={sessions?.find(s => s.id === view.sessionId)?.environment} now={now} />
				</p>
				{repair ? <p className="usage-lede item-repair-why">{REPAIR_WHY[repair]}</p> : null}
				{view.parent && feature.view?.plan ? (
					<SubtaskStrip
						plan={feature.view.plan}
						children={feature.view.children ?? []}
						jobs={feature.view.subtasks}
						current={view.parent.key}
					/>
				) : null}
			</header>

			{page.error ? (
				<p className="callout callout-warn" role="status">
					<WarnIcon />
					<span>{page.error} What is shown may be behind.</span>
				</p>
			) : null}
			{dialog === null && !view.question && !reading ? <Failure error={acting.error} /> : null}
			{conflicted && !review.open ? (
				<p className="callout callout-warn" role="status">
					<WarnIcon />
					<span>
						The plan changed while you read it, and is no longer waiting for approval. What is shown now is the latest.
					</span>
				</p>
			) : null}

			<section className="usage-section item-where" aria-label="Where it is">
				{view.parent ? (
					<PartStages item={view} step={view.run?.step.kind ?? null} />
				) : (
					<ItemStages item={view} reviewer={reviewer} step={view.run?.step.kind ?? null} />
				)}
				{secretSaved !== null && !view.question ? (
					<p className="callout secret-ask-saved" role="status">
						<CheckIcon size={14} className="tone-good" />
						<span>
							<code className="secret-ask-name">{secretSaved}</code> saved; the agent continues.
						</span>
					</p>
				) : null}
				{approvalSettingFailed && <Failure error="Plan approved. The automatic approval setting wasn’t saved." />}
				{/* A question is where the item is: its own block says so, with when it was asked. */}
				{view.question && review.open ? (
					<PlanQuestion
						key={view.question.id}
						onSettingError={() => setApprovalSettingFailed(true)}
						view={view}
						review={review}
						acting={acting}
						conflicted={conflicted}
						when={<When at={view.question.askedAt} now={now} />}
					/>
				) : view.question?.kind === "placement_refused" && view.plan ? (
					<PlacementQuestion
						key={view.question.id}
						view={view}
						question={view.question}
						review={review}
						acting={acting}
						when={<When at={view.question.askedAt} now={now} />}
					/>
				) : view.question?.kind === "secret_needed" && view.question.secret ? (
					<>
						<SecretQuestion
							key={view.question.id}
							view={view}
							question={view.question}
							secret={view.question.secret}
							acting={acting}
							now={now}
							failure={secretFailure?.name === view.question.secret.name ? secretFailure.message : null}
							reload={page.reload}
							onSaved={name => {
								setSecretSaved(name);
								setSecretFailure(null);
								void page.reload();
							}}
							onFailed={message =>
								setSecretFailure(message === null ? null : { name: view.question!.secret!.name, message })
							}
						/>
						<Failure error={acting.error} />
					</>
				) : view.question ? (
					<Question key={view.question.id} view={view} question={view.question} acting={acting} now={now} />
				) : showsSubtasks(view) ? (
					<>
						{view.state === "review" && view.review?.recommendation === "changes_requested" && (
							<Now view={view} now={now} />
						)}
						<SubtasksBlock
							plan={view.plan!}
							children={view.children ?? []}
							jobs={view.subtasks}
							wait={view.wait}
							now={now}
						/>
					</>
				) : (
					<Now view={view} now={now} />
				)}
				{view.run ? (
					<RunFacts
						run={view.run}
						events={view.events}
						asks={view.question !== null}
						now={now}
						waitingForCi={view.wait?.reason === "ci"}
					/>
				) : null}
				{!view.question && noteTargets.length > 0 && (
					<NoteBox
						key={view.mode === "orchestrate" ? noteTargets.map(target => target.id).join(" ") : undefined}
						targets={noteTargets}
						onDone={view.mode === "orchestrate" ? () => void page.reload() : page.replace}
					/>
				)}
			</section>

			{view.plan ? (
				<div id={`feature-plan-${view.plan.version}`}>
					<PlanSection view={view} review={review} acting={acting} />
				</div>
			) : view.children?.length ? (
				<section className="usage-section" aria-label="Subtasks">
					<h2 className="usage-title">Subtasks</h2>
					<ul className="agents">
						{view.children.map(child => (
							<ItemRow key={child.id} item={child} now={now} why={child.question?.text} reviewer={false} />
						))}
					</ul>
				</section>
			) : null}
			{reading ? <ReadFirst view={view} acting={acting} /> : null}
			<PartScreenshotsSection view={view} now={now} />

			<ItemChecks view={view} links={links} when={at => <When at={at} now={now} />} />

			<ItemNetwork network={view.blockedNetwork} context={allowContext} now={now} />
			{view.report ? <Report view={view} report={view.report} links={links} now={now} /> : null}
			<Cost view={view} now={now} />

			{reading ? null : (
				<section className="usage-section" aria-labelledby="item-task">
					<h2 className="usage-title" id="item-task">
						The task
					</h2>
					<TaskText task={view.task} codeSpans />
				</section>
			)}

			<Log view={view} now={now} />

			{dialog === "cancel" ? <CancelDialog view={view} acting={acting} onClose={() => setDialog(null)} /> : null}
			{dialog === "send_back" ? <SendBackDialog view={view} acting={acting} onClose={() => setDialog(null)} /> : null}
		</main>
	);
}
