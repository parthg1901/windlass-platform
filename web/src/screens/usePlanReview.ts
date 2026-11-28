import type { FeaturePlan, ItemAction, ItemView, SubtaskAgent, SubtaskBudget } from "@contract";
import { useEffect, useState } from "react";
import { openPlanQuestions } from "../../../server/src/factory/feature-plan.js";
import { budgetProblems, featureTotal, parseTokenInput, sumBudgets, tokenInput } from "../lib/feature";
import { placeChanged, placeDraftOf, withPlace, type PlaceDraft } from "../lib/placement";
import { agentChanged, cleanAgent, withAgent } from "../lib/subtask-agents";
import { useApp } from "../state/app";
import { useCatalogs, useHostedProviders, useModels } from "../state/hooks";
import { useMachines } from "../state/machines";

export interface PlanActing {
	busy: string | null;
	error: string | null;
	failed: { kind: string; reason: string | null } | null;
	act(action: ItemAction): Promise<boolean>;
}

const PLAN_QUESTIONS = new Set(["plan_approval", "replan_approval", "single_suggested"]);

function savedDrafts(plan: FeaturePlan | null) {
	const tasks = plan?.subtasks ?? [];
	return {
		budgets: Object.fromEntries<string>(tasks.map(task => [task.key, tokenInput(task.budget.tokens)])),
		places: Object.fromEntries<PlaceDraft>(tasks.map(task => [task.key, placeDraftOf(task)])),
		agents: Object.fromEntries<SubtaskAgent | null>(tasks.map(task => [task.key, cleanAgent(task.agent) ?? null])),
		overflow: plan?.overflow ?? false,
	};
}

function usePlanDraft(plan: FeaturePlan | null) {
	const [draft, setDraft] = useState(() => savedDrafts(plan));
	const [answers, setAnswers] = useState<Record<string, string>>({});
	const [confirmed, setConfirmed] = useState<string[]>([]);
	const reset = () => {
		if (plan) setDraft(savedDrafts(plan));
		setAnswers({});
	};

	return {
		...draft,
		answers,
		confirmed,
		reset,
		clearConfirmations: () => setConfirmed([]),
		setBudget: (key: string, text: string) => setDraft(now => ({ ...now, budgets: { ...now.budgets, [key]: text } })),
		setPlace: (key: string, place: PlaceDraft) =>
			setDraft(now => ({ ...now, places: { ...now.places, [key]: place } })),
		setAgent: (key: string, agent: SubtaskAgent | null) =>
			setDraft(now => ({ ...now, agents: { ...now.agents, [key]: agent } })),
		setOverflow: (overflow: boolean) => setDraft(now => ({ ...now, overflow })),
		setAnswer: (id: string, text: string) => setAnswers(now => ({ ...now, [id]: text })),
		setConfirmed: (key: string, on: boolean) =>
			setConfirmed(now => (on ? [...new Set([...now, key])] : now.filter(one => one !== key))),
	};
}

export function usePlanReview(view: ItemView | null, acting: PlanActing) {
	const plan = view?.plan ?? null;
	const open =
		view?.mode === "orchestrate" && plan?.status === "proposed" && PLAN_QUESTIONS.has(view.question?.kind ?? "");
	const draft = usePlanDraft(plan);
	const { platform } = useApp();
	const machines = useMachines(
		platform.info?.machines != null && view?.mode === "orchestrate" && plan !== null && plan.status !== "superseded",
	).list;
	const accountModels = useModels().list;
	const hostedKeys = useHostedProviders();
	const keyProfile = platform.info?.profiles.some(p => p.available && p.platformKeys) === true;
	const catalogs = useCatalogs(open || plan?.status === "approved" ? machines : null);

	// Feed updates to the same version keep edits. A new version needs fresh confirmations.
	useEffect(() => {
		draft.reset();
		draft.clearConfirmations();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [view?.id, plan?.version ?? 0]);

	const budgets: Record<string, SubtaskBudget> = {};
	const rows = (plan?.subtasks ?? []).map(task => {
		const input = draft.budgets[task.key];
		const tokens = input === undefined ? task.budget.tokens : parseTokenInput(input);
		const place = draft.places[task.key];
		const moved = !!place && placeChanged(task, place);
		const agentEdited = task.key in draft.agents && agentChanged(task, draft.agents[task.key]);
		const budgeted = { ...task, budget: { tokens } };
		budgets[task.key] = budgeted.budget;
		const placed = moved ? withPlace(budgeted, place) : budgeted;
		const edited = agentEdited ? withAgent(placed, draft.agents[task.key]) : placed;
		return { task, edited, routeEdited: moved || agentEdited, budgetEdited: tokens !== task.budget.tokens };
	});
	const edits =
		!!plan && (draft.overflow !== (plan.overflow ?? false) || rows.some(row => row.routeEdited || row.budgetEdited));
	const answersOnly = !edits && Object.values(draft.answers).some(answer => answer.trim() !== "");
	const unattended = plan && !plan.singleSuggested ? (view?.unattended ?? []) : [];
	const confirmed = unattended.filter(key => draft.confirmed.includes(key));
	const save = () => {
		if (!plan) return Promise.resolve(false);
		const questions = plan.questions.map(question => {
			const answer = draft.answers[question.id]?.trim();
			return answer ? { ...question, answer } : question;
		});
		return acting.act({
			kind: "edit_plan",
			version: plan.version,
			plan: { ...plan, questions, subtasks: rows.map(row => row.edited), overflow: draft.overflow },
		});
	};
	const approve = async (single?: Extract<ItemAction, { kind: "run_single" | "answer" }>) => {
		if (!plan) return false;
		if (single && answersOnly && !(await save())) return false;
		// Saving answers closes the old question. Start the single run on the new version.
		if (single) return acting.act(answersOnly ? { kind: "run_single" } : single);
		return acting.act({
			kind: "approve_plan",
			version: plan.version,
			...(unattended.length > 0 && { agents: confirmed }),
		});
	};

	const problems: Pick<ReturnType<typeof budgetProblems>, "fields" | "any"> = plan
		? budgetProblems(plan.compare.singleBudget, budgets)
		: { fields: {}, any: false };
	return {
		...draft,
		plan,
		open,
		edits,
		answersOnly,
		rows,
		save,
		approve,
		machines,
		catalogs,
		hostedKeys,
		keyProfile,
		accountModels,
		unattended,
		refusal: acting.failed?.kind === "approve_plan" && acting.failed.reason === "bad_input" ? acting.error : null,
		unconfirmed: unattended.length - confirmed.length,
		unansweredLeft: plan ? openPlanQuestions(plan, draft.answers).length : 0,
		pool: plan ? featureTotal(plan, budgets) : null,
		allotted: sumBudgets(Object.values(budgets)),
		problems,
	};
}

export type PlanReview = ReturnType<typeof usePlanReview>;
