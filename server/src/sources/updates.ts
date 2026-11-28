/**
 * The one stream of what happened to an item that its work sources hear about. Each source renders it in its own
 * form (effects.ts); none computes its own milestones from the item.
 */

import { currentKey } from "../factory/change.js";
import { crossRepo } from "../factory/cross-repo.js";
import type { ChoiceId, QuestionKind } from "../contract.js";
import { CHOICES } from "../factory/answered.js";
import type { FactoryItem } from "../factory/types.js";
import type { SourceId } from "./types.js";

type Ended = "done" | "failed" | "cancelled";
const ENDED: ReadonlySet<FactoryItem["state"]> = new Set<Ended>(["done", "failed", "cancelled"]);
export const isEndedState = (state: FactoryItem["state"] | undefined): state is Ended =>
	state !== undefined && ENDED.has(state);

/** Who answered a question outside the web: the person as the source names them. */
export type ExternalActor = { source: SourceId; person: string };

/**
 * How a question closed: answered by a person (on the web or in a source), or closed by anything else. `choice` is
 * the answer's label and `picked` its id, both left out when the plan was approved.
 */
export type Resolution =
	| "closed"
	| { approved: boolean; choice?: string; picked?: ChoiceId; by: "web" | ExternalActor };
/** The questions that ask to approve the feature plan their turn proposed, as parts or as one implementer. */
const PLAN_KINDS: ReadonlySet<QuestionKind> = new Set<QuestionKind>([
	"plan_approval",
	"replan_approval",
	"single_suggested",
]);

export type ItemUpdate =
	/** The item exists. */
	| { kind: "filed" }
	/** A draft started. */
	| { kind: "started" }
	| { kind: "question_resolved"; question: string; how: Resolution }
	/** A new question; `plan` when it asks to approve the feature plan its turn proposed (`PLAN_KINDS`). */
	| { kind: "question" | "plan"; question: string }
	/** The pull request changed; `first` when the item had none before. */
	| { kind: "pr"; pr: { number: number; url: string } | null; first: boolean }
	| { kind: "handed_over" }
	| { kind: Ended; from: FactoryItem["state"] | null }
	/** An ended item runs again. */
	| { kind: "reopened"; from: Ended };

/** How `question` closed by `fact`, a person's action or anything else. `by`: the person acted in a source. */
export function resolution(
	question: { id: string; choices: ReadonlyArray<{ id: string; label: string }> },
	fact: { kind: string },
	by?: ExternalActor,
): Resolution {
	const f = fact as { kind: string; by?: unknown; choice?: unknown; question?: unknown };
	const approved = f.kind === "approve_plan" || (f.kind === "answer" && f.choice === "approve");
	const picked = f.kind === "answer" && f.question === question.id ? (f.choice as ChoiceId) : undefined;
	// One implementer is also accepted where the question did not list it (`singlePlanAlternative`).
	const choice =
		picked &&
		(question.choices.find(c => c.id === picked)?.label ?? (picked === "run_single" ? CHOICES[picked] : undefined));
	if (!(approved || choice) || typeof f.by !== "string" || !f.by.startsWith("person:")) return "closed";
	return { approved, ...(!approved && { choice, picked }), by: by ?? "web" };
}

/**
 * What changed from `before` to `next`, in order. `before` null: the item was just made. `fact` is what changed it,
 * `handoff` whether the change handed the item over for review, `by` the person who acted in a source.
 */
export function itemUpdates(
	before: FactoryItem | null,
	next: FactoryItem,
	fact?: { kind: string },
	{ handoff = false, by }: { handoff?: boolean; by?: ExternalActor } = {},
): ItemUpdate[] {
	const updates: ItemUpdate[] = [];
	if (!before) updates.push({ kind: "filed" });
	if (before?.state === "draft" && next.state !== "draft" && !isEndedState(next.state))
		updates.push({ kind: "started" });
	const closed = before?.question;
	if (closed && closed.id !== next.question?.id)
		updates.push({
			kind: "question_resolved",
			question: closed.id,
			how: fact ? resolution(closed, fact, by) : "closed",
		});
	if (next.question && next.question.id !== before?.question?.id) {
		const plan =
			next.featurePlan?.status === "proposed" &&
			next.filedTurn === currentKey(next) &&
			PLAN_KINDS.has(next.question.kind as QuestionKind);
		updates.push({ kind: plan ? "plan" : "question", question: next.question.id });
	}
	if (before?.pr?.number !== next.pr?.number) updates.push({ kind: "pr", pr: next.pr, first: !before?.pr });
	if (
		(handoff && !next.run?.ci?.autoMergeKey) ||
		(crossRepo(next) && next.run?.step.kind === "merged" && before?.run?.step.kind !== "merged")
	)
		updates.push({ kind: "handed_over" });
	if (before?.state !== next.state && isEndedState(next.state))
		updates.push({ kind: next.state, from: before?.state ?? null });
	if (before && isEndedState(before.state) && !isEndedState(next.state))
		updates.push({ kind: "reopened", from: before.state });
	return updates;
}
