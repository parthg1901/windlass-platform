// The Change one fact makes to an item, and the shared steps every flow takes: questions, turns, stops and feedback.
import { SIZE_WEIGHT } from "../billing/meter.js";
import type { OutOfMemory } from "../sandbox/api.js";
import {
	MAX_ITEM_BODY_CHARS,
	isolationName,
	outOfMemoryWords,
	type HarnessId,
	type ReviewRecord,
	type TurnOutcome,
	type Verified,
	type VerifiedCheck,
} from "../contract.js";
import { spellSeconds } from "../usage.js";
import { choice, CHOICES } from "./answered.js";
import { feedbackWords, fixText, replanText } from "./feedback.js";
import type { FeedbackDecision, FeedbackInput } from "./types.js";
import { subtaskMinimum, approvalText, planRecovery } from "./feature-plan.js";
import { crossRepo, plannerText } from "./cross-repo.js";
import { MAX_PROVIDER_WAIT, MINUTE, providerWait, usageRefusal } from "../provider-usage.js";
import { PLATFORM_TOOLS, refusalMessage } from "../provider-refusal.js";
import { budgetStop, itemAgent, noteAgentTurn, spellTokens, spellUsd, turnBudget, type TurnBudget } from "./budget.js";
import { addSandbox, addTurn, noUsage, sandboxSeconds } from "./cost.js";
import { ITEM_HOSTED_SIZE } from "../contract/hosted-sizes.js";
import type { HostedSplit } from "../contract.js";
import { environmentFailure } from "./check-environment.js";
import type {
	ChoiceId,
	CiProgress,
	Fact,
	FeatureJob,
	HandoffReview,
	ItemProviderRefusal,
	ReviewerInput,
	TurnSpend,
	FactoryItem,
	ItemBudget,
	ItemSpend,
	ItemEvent,
	ItemState,
	Outcome,
	Question,
	QuestionKind,
	Run,
	StepKind,
	StopCause,
	Task,
	TurnPlan,
	TurnStepKind,
	Wait,
	Effect,
} from "./types.js";
import { ASK_WHEN_BLOCKED, BUILDER_ASSUMPTIONS, PUBLISH_SERVER, REPORT_TOOL } from "../agent-publish.js";
import type { PersonDecision } from "./reviewer-task.js";
import { sources, thirdParty, untrustedWords } from "./untrusted.js";
import { failureFingerprint, gateFingerprint, verdictCi, verdictOf, verdictWords } from "./verdict.js";

export const RULES = {
	/** Loop guard for one builder turn (including planning and summary). */
	maxSteps: 400,
	parallelChildren: 3,
	reviewMaxSteps: 40,
	featureReviewFixes: 2,
	feedbackRuns: 3,
	reviewFilings: 4,
	reviewRefiles: 1,
	/** Count a feature’s own turns across runs, excluding its subtasks. */
	turnBackstop: 60,
	/** Infrastructure interruptions per step. */
	interruptions: 3,
	providerRetries: 3,
	publishTries: 3,
	/** Double the delay after each transient push failure. */
	publishRetryMs: 30_000,
	/** Check for a lost turn receipt. */
	turnCheckMs: 5 * 60_000,
	personDecisions: 12,
	/** How far over its token budget one fix turn for failed checks may start without asking. */
	checkFixGrace: 0.25,
} as const;

type AutoChoice = ChoiceId | "rerun_ci";
type PolicyStep = { choices: AutoChoice[]; afterMs: number };
const step = (choice: AutoChoice, afterMs = 0, fallback?: AutoChoice): PolicyStep => ({
	choices: fallback ? [choice, fallback] : [choice],
	afterMs,
});
const sixHours = 6 * 60 * MINUTE;

/** One allowance per position per run. Fallbacks share a position. Waiting rows recheck availability until their deadline. */
export const AUTO_POLICY = {
	sandbox_failed: [step("again"), step("fresh_sandbox", 2 * MINUTE)],
	turn_start: [step("again", 30_000), step("again", MINUTE)],
	summary_missing: [step("again"), step("again")],
	no_change: [step("again")],
	check_environment: [step("again")],
	subtask_checks: [step("run_checks"), step("ci_alone")],
	ci_timeout: [step("rerun_ci"), step("update_from_base"), step("wait")],
	feature_ahead: [step("update_feature")],
	integration: [step("again"), step("again")],
	feature_update: [step("update_feature"), step("update_feature")],
	sandboxes: sixHours,
	placement_refused: sixHours,
	machine_away: sixHours,
};
type Policy = Exclude<keyof typeof AUTO_POLICY, "sandboxes" | "placement_refused" | "machine_away">;

/** Select and charge one eligible choice. Missing positions are skipped, never revisited. */
export function automatic(
	c: Change,
	policy: Policy,
	evidence: string,
	offered: readonly AutoChoice[],
	resume?: TurnPlan | null,
) {
	if (backstopTurns(c.item) >= RULES.turnBackstop) return null;
	const history = c.run.autoHistory?.[policy] ?? [];
	const fingerprint = failureFingerprint([policy, evidence], []);
	const steps = AUTO_POLICY[policy];
	// Retry the same evidence only with a different choice.
	const triedHere = new Set(
		history.filter(step => step.fingerprint === fingerprint).flatMap(step => steps[step.position]!.choices),
	);
	for (let position = (history.at(-1)?.position ?? -1) + 1; position < steps.length; position++) {
		const { choices, afterMs } = steps[position]!;
		const choice = choices.find(id => offered.includes(id));
		if (!choice) continue;
		if (triedHere.has(choice)) return null;
		if (resume && turnBudgetStop(c)) return null;
		(c.run.autoHistory ??= {})[policy] = [...history, { position, fingerprint }];
		c.run.autoSteps = (c.run.autoSteps ?? 0) + 1;
		const label = choice === "rerun_ci" ? "Rerun interrupted CI" : CHOICES[choice];
		c.say(
			`Retried automatically (${history.length + 1} of ${steps.length}): ${label}. ${evidence.split("\n")[0]!.slice(0, 400)}`,
		);
		return { choice, afterMs };
	}
	return null;
}

export function decided(item: FactoryItem, decision: PersonDecision): void {
	const text = decision.text.trim();
	if (!text) return;
	item.decisions = [...(item.decisions ?? []), { ...decision, text: text.slice(0, 4_000) }].slice(
		-RULES.personDecisions,
	);
}

/** Steps permitted to ask the owner a question. */
export const ASKING: ReadonlySet<TurnStepKind> = new Set(["implement", "ci_fix", "conflict", "review_fix"]);

export const FINAL: ReadonlySet<ItemState> = new Set(["done", "cancelled"]);
export const CUT_SHORT: ReadonlySet<TurnOutcome> = new Set(["stopped", "failed", "interrupted", "error"]);

/** Stable identity for a step attempt and its effects. */
export function stepKey(itemId: string, run: number, step: number, attempt: number): string {
	return `${itemId}:${run}:${step}:${attempt}`;
}

export function currentKey(item: FactoryItem): string | null {
	return item.run === null ? null : stepKey(item.id, item.run.n, item.run.step.n, item.run.step.attempt);
}

/** Takes the choice on a question. blueprint.ts supplies it: it reaches every flow, so importing it here would make a cycle. */
export type TakeChoice = (
	c: Change,
	question: Question,
	fact: Extract<Fact, { kind: "answer" }>,
	note: string | null,
	auto?: boolean,
) => boolean;

export class Change {
	storeVerdict?: Outcome["storeVerdict"];
	tookReview?: string;
	readonly effects: Effect[] = [];
	readonly events: ItemEvent[] = [];
	readonly feedback: FeedbackDecision[] = [];

	constructor(
		readonly item: FactoryItem,
		readonly at: number,
		readonly by: string,
		readonly takeChoice: TakeChoice,
	) {}

	get run(): Run {
		if (this.item.run === null) throw new Error("the item has no run");
		return this.item.run;
	}

	get key(): string {
		return stepKey(this.item.id, this.run.n, this.run.step.n, this.run.step.attempt);
	}

	say(said: string, stopReason?: ItemEvent["stopReason"], asked?: string): void {
		const run = this.item.run;
		this.events.push({
			at: this.at,
			by: this.by,
			step:
				run === null || run.step.n === 0
					? null
					: { run: run.n, n: run.step.n, kind: run.step.kind, attempt: run.step.attempt },
			said,
			...(stopReason && { stopReason }),
			...(asked !== undefined && { asked }),
		});
	}

	/** Keep external events out of the current step's timeline. */
	sayOfItem(said: string): void {
		this.events.push({ at: this.at, by: this.by, step: null, said });
	}

	state(next: ItemState, wait: Wait | null = null): void {
		const { item } = this;
		if (item.state === "working" && next !== "working" && item.workingSince !== null) {
			// A clock that stepped back gives no time: it never takes any away either.
			item.spent.activeSeconds += Math.max(0, this.at - item.workingSince) / 1000;
			item.workingSince = null;
		}
		if (next === "working" && item.workingSince === null) item.workingSince = this.at;
		item.wait =
			next === "waiting" && wait !== null
				? { ...wait, since: item.state === "waiting" && item.wait?.reason === wait.reason ? item.wait.since : this.at }
				: null;
		const ended = (state: ItemState) => state === "done" || state === "failed" || state === "cancelled";
		if (!ended(next)) delete item.endedAt;
		else if (!ended(item.state) || item.endedAt === undefined) item.endedAt = this.at;
		item.state = next;
	}

	enter(kind: StepKind): void {
		this.run.step = {
			n: this.run.step.n + 1,
			kind,
			attempt: 1,
			startedAt: this.at,
			turn: null,
			checks: 0,
			interruptions: 0,
		};
	}
}

export function hostedChoice(agent?: HarnessId, profile?: FeatureJob["hostedProfile"]) {
	const isolation = profile ? ` (${isolationName(profile)})` : "";
	const payer = agent && agent !== "windlass" ? " with my key" : "";
	return { id: "use_hosted" as const, label: "Run on Hosted" + isolation + payer };
}

/** A run filed before its payer was recorded: the owner confirms the machine's own sign-in. */
export const confirmPayerChoice = { id: "wait" as const, label: "Use the machine’s own sign-in" };

export const IMPLEMENT: TurnPlan = {
	kind: "implement",
	text: "",
	newStep: true,
	charge: null,
	fingerprint: null,
	fetchBase: null,
};

/** The owner must have approved every uncontained source before delivery. */
export const unsandboxedOf = (item: FactoryItem, list: readonly string[] | undefined): { unsandboxed?: true } => {
	const outside = thirdParty(list);
	return outside.length && outside.every(source => item.unsandboxed?.includes(source)) ? { unsandboxed: true } : {};
};

export const marked = (...lists: Array<readonly string[] | undefined | null>): Pick<TurnPlan, "untrusted"> => {
	const list = sources(...lists);
	return list.length ? { untrusted: list } : {};
};

export function taskText(task: Task): string {
	const criteria =
		task.acceptance.length === 0
			? ""
			: `\n\nAcceptance criteria (a person will check these):\n${task.acceptance.map((line, index) => `${index + 1}. ${line}`).join("\n")}`;
	const feature = task.featureBody ? `\n\nOriginal feature task:\n${task.featureBody}` : "";
	return `${task.title}\n\n${task.body}${criteria}${feature}`.trim();
}

export function firstPlan(item: FactoryItem, note: string | null): TurnPlan {
	const plan = singleFirstPlan(item, note);
	if (item.mergeTarget && item.childBase) plan.fetchBase = item.childBase;
	return crossRepo(item) && item.mode === "orchestrate" && plan.kind === "refine"
		? { ...plan, text: plan.text + plannerText(item) }
		: plan;
}

function singleFirstPlan({ task, mode, featurePlan, untrusted }: FactoryItem, note: string | null): TurnPlan {
	const taskWithNote = withNote(taskText(task), note);
	if (mode === "orchestrate")
		return {
			...IMPLEMENT,
			kind: "refine",
			charge: "plan",
			text: `Read the repository. File a proposal with file_plan. Suggest a single item for small or unverifiable work. Include open questions and budget each verifiable subtask.\n\n${taskWithNote}`,
			...marked(untrusted),
		};
	const text = `${taskWithNote}\n\n${BUILDER_ASSUMPTIONS} ${ASK_WHEN_BLOCKED}`;
	if (featurePlan?.status === "approved") {
		const { goal, requirements, acceptance, outOfScope } = featurePlan.spec;
		const spec = [
			["Goal", [goal]],
			["Requirements", requirements],
			["Done when", acceptance],
			["Not in it", outOfScope],
		] as const;
		const sections = featurePlan.questions.filter(q => q.answer).map(q => q.text + "\n" + q.answer);
		sections.push(...spec.map(([label, lines]) => label + ":\n" + lines.map(line => "- " + line).join("\n")));
		const label =
			featurePlan.approvedBy === "critic" ? "Plan approved automatically by the critic" : "Owner-approved plan";
		return {
			...IMPLEMENT,
			text: text + "\n\n" + label + " (quoted data):\n" + sections.join("\n\n").slice(0, MAX_ITEM_BODY_CHARS),
			...marked(untrusted),
		};
	}
	return { ...IMPLEMENT, text, ...marked(untrusted) };
}

export const FRESH_START =
	"Your earlier conversation about this task is gone, and so is any work that was not pushed: this turn starts without them. Work on the task from the start:";

/** Rebuild the original builder task and its trust labels after conversation loss. */
function freshPlan(item: FactoryItem): Pick<TurnPlan, "text" | "untrusted"> | null {
	const first = firstPlan(item, null);
	return first.kind === "refine" ? null : { text: `${FRESH_START}\n\n${first.text}`, ...marked(first.untrusted) };
}

export const personAdds = (note: string) => `The person adds: ${note}`;
export const withNote = (text: string, note: string | null) =>
	note === null ? text : `${text}\n\n${personAdds(note)}`;

export function beginRun(c: Change, plan: TurnPlan): void {
	resetRun(c, plan.kind);
	if (plan.kind === "refine") c.run.planInputsTrusted = !thirdParty(plan.untrusted).length;
	nextTurn(c, plan);
}

/** Begins a run the person started again after a failed one: what it uses is counted as retry spend. */
export function retryRun(c: Change, plan: TurnPlan): void {
	beginRun(c, plan);
	c.run.retry = true;
}

export function resetRun(c: Change, kind: StepKind): void {
	const { item } = c;
	const before = item.run;
	item.startedAt ??= c.at;
	if (before !== null && before.endedAt === null) {
		before.endedAt = c.at;
		before.stopReason = "retried";
	}
	item.run = {
		n: (before?.n ?? 0) + 1,
		autoSteps: 0,
		startedAt: c.at,
		endedAt: null,
		stopReason: null,
		step: { n: 0, kind, attempt: 0, startedAt: c.at, turn: null, checks: 0, interruptions: 0 },
		rounds: { plan: 0, gate: 0, ci: 0, conflict: 0, review: 0 },
		lastFailure: null,
		gate: null,
		ci: null,
		review: null,
	};
	if (item.state === "review" && item.head && !item.parent) {
		pendingCheck(c, before?.ci?.moved ?? item.head, `Sent back: being reworked in run ${c.run.n}`, true);
	}
	item.question = null;
	c.state("queued");
}

export function feedbackState(item: FactoryItem): NonNullable<FactoryItem["feedback"]> {
	return (item.feedback ??= {
		held: null,
		heldText: "",
		heldFingerprint: "",
		heldWriters: [],
		heldOthers: false,
		awaiting: null,
		taken: [],
		runs: {},
		othersRuns: 0,
		lastIds: [],
	});
}

export function authors(batch: FeedbackInput) {
	return (batch.writers ?? [batch.by.replace(/^github:/, "")]).map(login => "@" + login).join(", ");
}

export function decline(c: Change, batch: FeedbackInput, reason: string) {
	c.feedback.push({ state: "declined", ids: batch.ids, reason });
	c.say(reason);
}

export function popHeld(f: NonNullable<FactoryItem["feedback"]>): FeedbackInput | null {
	if (!f.held) return null;
	const batch = {
		ids: f.held,
		text: f.heldText,
		fingerprint: f.heldFingerprint,
		others: f.heldOthers,
		by: "github:" + f.heldWriters[0],
		writers: f.heldWriters,
	};
	f.held = null;
	f.heldText = f.heldFingerprint = "";
	f.heldWriters = [];
	f.heldOthers = false;
	return batch;
}

export function takeHeld(c: Change) {
	const batch = c.item.feedback && popHeld(c.item.feedback);
	if (batch) takeFeedback(c, batch);
}

export function feedbackRefusal(item: FactoryItem, batch: FeedbackInput): string | null {
	const runs = item.feedback?.runs;
	if (runs && Object.hasOwn(runs, batch.fingerprint)) return feedbackWords.repeat(runs[batch.fingerprint]!);
	if (item.machineRemoved) return feedbackWords.machineRemoved;
	if (item.mode === "orchestrate") {
		const keys = [
			...(item.jobs ?? []).filter(j => !repair(j)).map(j => j.task.key),
			...(item.approvedPlan?.subtasks ?? []).map(t => t.key),
		];
		if (new Set(keys).size >= 6) return feedbackWords.full;
	}
	return null;
}

/** `also`: more text for the new run, after the batch (a second review's points that ride along), with where it came from. */
export function takeFeedback(
	c: Change,
	batch: FeedbackInput,
	approved = false,
	also?: { text: string; untrusted: string[] },
) {
	const { item } = c,
		f = feedbackState(item);
	const refusal = feedbackRefusal(item, batch);
	if (refusal) return decline(c, batch, refusal);
	const feature = item.mode === "orchestrate";
	let text = fixText(batch.text);
	if (feature) {
		if (batch.others && !approved) {
			const reason = feedbackWords.feature(authors(batch));
			f.awaiting = batch;
			c.feedback.push({ ids: batch.ids, state: "question", reason });
			return ask(
				c,
				"feedback_feature",
				reason,
				[{ id: "send" as const, label: feedbackWords.plan }, choice("leave")],
				null,
				null,
			);
		}
		replanning(item, "A pull request comment asked for changes");
		item.feedbackReplans = (item.feedbackReplans ?? 0) + 1;
		text = replanText(batch.text, {
			plan: item.approvedPlan,
			completed: item.jobs?.filter(j => j.state === "done").map(j => j.task.key) ?? [],
		});
	} else if (batch.others && !approved && f.othersRuns >= RULES.feedbackRuns) {
		const reason = feedbackWords.more(authors(batch));
		f.awaiting = batch;
		c.feedback.push({ ids: batch.ids, state: "question", reason });
		return ask(c, "feedback_more", reason, [choice("send"), choice("leave")], null, null);
	}
	if (also && !feature) text += "\n\n" + also.text;
	const run = c.run.n + 1;
	if (batch.others) f.othersRuns++;
	// Only the person's own words are their decisions; a batch with anyone else's is not.
	else decided(item, { kind: "feedback", run, text: batch.text });
	f.taken.push(...batch.ids);
	f.runs[batch.fingerprint] = run;
	c.feedback.push({ ids: batch.ids, state: "taken", reason: feedbackWords.taken(run, feature), run });
	c.say(feedbackWords.takenLog(authors(batch), run, feature));
	const previousHead = c.run.ci?.moved ?? item.head;
	const feedbackQuote = { head: previousHead, start: text.indexOf(batch.text), length: batch.text.length };
	// Only the item's person's own words on GitHub are theirs; a batch with anyone else's is not vouched for.
	const untrusted = marked(
		batch.others ? [untrustedWords.feedback(authors(batch))] : [],
		also && !feature ? also.untrusted : [],
	);
	beginRun(c, { ...IMPLEMENT, text, feedbackQuote, ...untrusted, ...(feature && { kind: "refine", charge: "plan" }) });
	const reopened = item.pendingChecks?.find(check => check.sha === previousHead);
	if (reopened) reopened.feedback = true;
}

export function ownSpent(item: FactoryItem, spent: ItemSpend): ItemSpend {
	const own = { ...spent };
	for (const job of item.jobs ?? []) {
		own.tokens -= job.spent.tokens;
		own.turns -= job.spent.turns;
	}
	return own;
}

export const ownTokens = (item: FactoryItem): number =>
	item.ownTokens ?? item.singleBudget?.tokens ?? item.budget.tokens;

/** Keep completed spend and reserve new allowances for the remaining subtasks. */
export function featureTotal(
	item: FactoryItem,
	plan: Pick<import("../contract.js").FeaturePlanEdit, "subtasks"> | undefined = item.approvedPlan,
): ItemBudget {
	const jobs = item.jobs ?? [];
	let tokens = ownTokens(item);
	for (const job of jobs) tokens += (job.budget ?? job.task.budget).tokens;
	const placed = new Set(
		jobs.filter(job => job.state !== "failed" && job.state !== "cancelled").map(job => job.task.key),
	);
	const remaining = plan?.subtasks.filter(task => !placed.has(task.key)) ?? [];
	for (const task of remaining) tokens += task.budget.tokens;
	const hostedSeconds = plan?.subtasks.length
		? (item.replans ? item.spent.hostedSeconds : 0) +
			remaining.length * (item.singleBudget ?? item.budget).hostedSeconds
		: item.budget.hostedSeconds;
	return { tokens, hostedSeconds };
}

export function plannerBudgetText(item: FactoryItem): string {
	const single = (item.singleBudget ?? item.budget).tokens;
	const n = (value: number) => Math.round(value).toLocaleString("en-US");
	return [
		"",
		"",
		"Budget (tokens are cost-weighted: an input token read from the prompt cache counts as a tenth):",
		`- One item's budget: ${n(single)} tokens.`,
		`- Each subtask's budget: at least ${n(subtaskMinimum({ tokens: single }).tokens)}, at most ${n(single)} tokens.`,
		`- On top of the subtasks, the feature's own allowance for planning, the summary and the review: ${n(ownTokens(item))} tokens, of which ${n(Math.max(0, ownSpent(item, item.spent).tokens))} are spent.`,
		"Independent subtasks run in parallel. Split work by file, list accurate owned paths in owns, and use dependsOn only for real prerequisites.",
		"- The feature's budget is its subtasks' budgets together and that allowance. A subtask that uses its budget asks the owner for more.",
	].join("\n");
}

export const backstopTurns = (item: FactoryItem): number =>
	(item.mode === "orchestrate" ? ownSpent(item, item.spent).turns : item.spent.turns) - (item.backstopFrom ?? 0);

/** The failures this run already had a fix turn for (the stuck detector): a run stored before they were kept has its last one. */
export const failuresOf = (run: Run): string[] => run.failures ?? (run.lastFailure === null ? [] : [run.lastFailure]);

/** The budget the item's next turn is held to, and what was spent of it. */
function heldBudget(c: Change): { budget: ItemBudget; spent: ItemSpend } {
	const { item } = c;
	const working = item.workingSince === null ? 0 : Math.max(0, c.at - item.workingSince) / 1000;
	const spent = { ...item.spent, activeSeconds: item.spent.activeSeconds + working };
	// A feature's own turns (planning, summary, review) are held to its own allowance; its subtasks hold to theirs.
	const feature = item.mode === "orchestrate";
	return {
		budget: feature ? { ...item.budget, tokens: ownTokens(item) } : item.budget,
		spent: feature ? ownSpent(item, spent) : spent,
	};
}

export function turnBudgetStop(c: Change) {
	const { budget, spent } = heldBudget(c);
	return budgetStop(budget, spent, c.item.place);
}

export function nextTurn(c: Change, plan: TurnPlan): void {
	const { item, run } = c;
	if (plan.fingerprint !== null && failuresOf(run).includes(plan.fingerprint)) {
		if (plan.fingerprint === NO_GATE)
			return ask(c, "rounds", SUBTASK_CHECK_QUESTION, subtaskChoices(), "repeated", plan);
		return stop(c, "repeated", repeatedWords(plan.kind, item.task), plan);
	}
	if (plan.charge === "interruptions" && run.step.interruptions >= RULES.interruptions)
		return stop(
			c,
			"interruptions",
			`This step was cut off ${RULES.interruptions} times, by deploys or restarts.`,
			plan,
		);
	if (backstopTurns(item) >= RULES.turnBackstop)
		return stop(
			c,
			"turns",
			`This item has taken ${RULES.turnBackstop} turns without finishing. Look at its log before it goes on.`,
			plan,
		);

	const over = turnBudgetStop(c);
	const fix = plan.charge === "gate" || plan.charge === "ci";
	// A turn that ran past its tokens and left only failed checks gets one fix turn within the grace, instead of a question.
	const grace =
		over?.cause === "tokens" &&
		fix &&
		!run.budgetGrace &&
		item.spent.tokens <= item.budget.tokens * (1 + RULES.checkFixGrace);
	if (over !== null && !grace)
		return askBudget(
			c,
			over.cause,
			fix ? "Its checks failed, and it " + over.sentence[0].toLowerCase() + over.sentence.slice(1) : over.sentence,
			plan,
		);
	if (grace) {
		run.budgetGrace = true;
		c.say(
			`Its checks failed after it used its token budget: one fix turn, up to ${Math.round(RULES.checkFixGrace * 100)}% over.`,
		);
	}

	if (plan.fingerprint !== null) {
		run.lastFailure = plan.fingerprint;
		run.failures = [...failuresOf(run), plan.fingerprint];
	}
	if (plan.charge !== null && plan.charge !== "interruptions")
		run.rounds[plan.charge] = (run.rounds[plan.charge] ?? 0) + 1;
	// afterCi already entered review to pin its verdict even when admission stops on budget.
	if (!plan.newStep) run.step.attempt += 1;
	else if (plan.kind !== "review") c.enter(plan.kind);
	run.step.turn = "delivered";
	run.step.checks = 0;
	c.state(item.state === "queued" || item.place.kind === "machine" ? "queued" : "working");
	const summary = plan.kind === "summary" ? summaryTask(item) : null;
	// A newly delivered summary, including a retry saved by an older server, has all its evidence
	// even when its agent starts a new conversation. Keep any instructions the person added.
	if (summary && plan.newStep)
		plan = {
			...plan,
			text: [summary.text, plan.text].filter(Boolean).join("\n\n"),
			...marked(summary.untrusted, plan.untrusted),
		};
	// Where the turn is stopped while it runs, should it use up what is left (#100a): its session watches its spend. A
	// fix turn given the grace past its tokens may use the grace.
	const held = heldBudget(c);
	const budget: TurnBudget | undefined = grace
		? {
				figure: "tokens",
				stopAt: Math.max(0, Math.round(item.budget.tokens * (1 + RULES.checkFixGrace) - item.spent.tokens)),
			}
		: turnBudget(held.budget, held.spent);
	const delivery = {
		kind: "deliver" as const,
		key: c.key,
		text: plan.kind === "refine" ? plan.text + plannerBudgetText(item) : plan.text,
		fetchBase: plan.fetchBase,
		...(plan.feedbackQuote && { feedbackQuote: plan.feedbackQuote }),
		...(budget && { budget }),
	};
	const fresh =
		plan.to !== "review" && !plan.newStep ? (summary ?? (ASKING.has(plan.kind) ? freshPlan(item) : null)) : null;
	if (plan.to === "review") {
		if (!plan.checkout || !run.ci || !run.review) throw new Error("a reviewer turn needs its checkout and verdict");
		if (plan.newStep) c.say(`A second agent reviews ${shortSha(run.review.head)}.`);
		const untrusted = marked(
			item.untrusted,
			[untrustedWords.builder(plan.checkout.pr)],
			item.approvedPlan ? [untrustedWords.reports] : [],
		);
		c.effects.push({
			...delivery,
			to: "review",
			checkout: plan.checkout,
			reviewerInput: reviewerInput(c, run.ci, plan.checkout.pr),
			agent: null,
			maxSteps: RULES.reviewMaxSteps,
			...untrusted,
			...unsandboxedOf(item, untrusted.untrusted),
		});
	} else {
		const asking = ASKING.has(plan.kind) ? { asksLeft: 1 } : {};
		const note = ASKING.has(plan.kind) ? (item.ownerNote ?? null) : null;
		if (note !== null) delete item.ownerNote;
		const untrusted = marked(plan.untrusted);
		if (plan.kind === "refine" && thirdParty(plan.untrusted).length) run.planInputsTrusted = false;
		// The whole task goes with its own sources: the session sends one text or the other, with the sources of that one.
		const freshPrompt = fresh && {
			fresh: {
				text: withNote(plan.includeInFresh ? fresh.text + "\n\n" + plan.text : fresh.text, note),
				untrusted: fresh.untrusted ?? [],
				...unsandboxedOf(item, fresh.untrusted),
			},
		};
		c.effects.push({
			...delivery,
			text: withNote(delivery.text, note),
			agent:
				plan.kind === "run_checks" || plan.kind === "summary" ? plan.kind : plan.kind === "refine" ? "planner" : null,
			maxSteps: RULES.maxSteps,
			...asking,
			...untrusted,
			...unsandboxedOf(item, untrusted.untrusted),
			...freshPrompt,
		});
	}
	// From delivery on, not only once started: nothing else would notice a delivery that waits for a slot nobody will give.
	checkTurn(c);
}

export function checkTurn(c: Change): void {
	const step = c.run.step;
	step.checks += 1;
	c.effects.push(turnCheckEffect(c.key, step, c.at + RULES.turnCheckMs));
}

/** Also used on adoption to restore a check consumed without a receipt on an older server. */
export function turnCheckEffect(turn: string, step: Run["step"], at: number): Extract<Effect, { kind: "check_turn" }> {
	return {
		kind: "check_turn",
		key: `${turn}/check${step.checks}`,
		turn,
		at,
		...(step.kind === "plan_review" ? { to: "critic" } : step.kind === "review" && { to: "review" }),
	};
}

/** Sandbox preparation failures do not count as interrupted agent turns. */
export function sandboxFailed(c: Change, said: string, resume: TurnPlan): void {
	const reason = said.trim().replace(/[.\s]+$/, "");
	const text = `The sandbox could not be prepared for the turn: ${reason}. The agent did not run. A fresh sandbox starts from the repository on GitHub and loses any unpushed work.`;
	ask(
		c,
		"sandbox_failed",
		text,
		[choice("again"), choice("fresh_sandbox"), ...handOverAny(c.item), choice("give_up")],
		null,
		resume,
	);
}

export function outOfMemory(c: Change, memory: OutOfMemory, resume: TurnPlan): void {
	if (c.item.place.kind === "machine") {
		const text = `${outOfMemoryWords(memory, [], "machine")} The agent's turn did not finish. Go on anyway to try again in the same slot.`;
		const handoff = handOverAny(c.item).map(({ id }) => ({ id, label: "Hand over" }));
		ask(
			c,
			"out_of_memory",
			text,
			[{ id: "again", label: "Go on anyway" }, ...handoff, choice("give_up")],
			null,
			resume,
		);
		return;
	}
	const larger = memory.larger;
	const text = `${outOfMemoryWords(memory, larger ? [larger] : [])} The agent's turn did not finish. ${larger ? `Go on in a ${larger} sandbox at ${SIZE_WEIGHT[larger]}× the standard hosted rate. It starts from the repository on GitHub, and what was not pushed from the old sandbox is lost with it. Or try again in the same one.` : "Try again, or give it up."}`;
	ask(
		c,
		"out_of_memory",
		text,
		[...(larger ? [choice("larger_sandbox")] : []), choice("again"), ...handOverAny(c.item), choice("give_up")],
		null,
		resume,
		undefined,
		{ largerSize: larger },
	);
}

export const OUTCOME_WORDS: Partial<Record<TurnOutcome, string>> = {
	stopped: "was stopped",
	failed: "failed",
	interrupted: "was cut off",
	error: "could not run",
};

export function spendTurn(c: Change, spend: TurnSpend, providerRefusal?: ItemProviderRefusal): void {
	if (!providerRefusal || !usageRefusal(providerRefusal.kind)) delete c.run.step.providerRetries;
	c.run.step.turn = null;
	chargeTurn(c.item, spend);
}

export function chargeTurn(item: FactoryItem, spend: TurnSpend): void {
	// An item stored before raw tokens were kept counted them raw: they start from what it counted.
	item.spent.rawTokens = (item.spent.rawTokens ?? item.spent.tokens) + (spend.rawTokens ?? spend.tokens);
	item.spent.tokens += spend.tokens;
	if (spend.agent) noteAgentTurn(item, spend.agent);
	if (spend.meter) {
		addTurn((item.spent.usage ??= noUsage()), spend.meter);
		// A turn after a failed attempt: in a run started again, or fixing a failed CI.
		if (item.run?.retry || item.run?.step.kind === "ci_fix")
			addTurn((item.spent.retryUsage ??= noUsage()), spend.meter);
	}
	// The turn's dollars of work, whoever paid; a turn that could not be priced leaves tokens holding too.
	if (spend.usd === null) item.spent.usdUnknown = true;
	else if (spend.usd !== undefined) item.spent.usd = roundCents((item.spent.usd ?? 0) + spend.usd);
	item.spent.turns += 1;
	if (item.place.kind === "hosted") item.spent.hostedSeconds = Math.max(item.spent.hostedSeconds, spend.hostedSeconds);
	noteHostedTime(item, spend.hosted);
}

const roundCents = (usd: number) => Math.round(usd * 10_000) / 10_000;

/**
 * Puts the item's own hosted seconds not yet in its usage there, at the size its latest turn ran: what its
 * sandbox time costs. A feature's parts keep their own, so theirs are left out of its own.
 */
export function noteHostedTime(item: FactoryItem, hosted?: HostedSplit): void {
	if (item.place.kind !== "hosted") return;
	// What billing made of the item's own hosted time so far: a lifetime total, so the latest replaces it.
	if (hosted) (item.spent.usage ??= noUsage()).hosted = hosted;
	const parts = (item.jobs ?? []).reduce((sum, job) => sum + job.spent.hostedSeconds, 0);
	const fresh = item.spent.hostedSeconds - parts - sandboxSeconds(item.spent.usage);
	if (fresh <= 0) return;
	const usage = (item.spent.usage ??= noUsage());
	addSandbox(usage, usage.size ?? ITEM_HOSTED_SIZE, fresh);
}

export function askProviderRefusal(c: Change, refusal: ItemProviderRefusal, plan: TurnPlan): void {
	const reset = refusal.resetsAt !== undefined && refusal.resetsAt > c.at ? refusal.resetsAt : undefined;
	const retries = c.run.step.providerRetries ?? 0;
	if (
		usageRefusal(refusal.kind) &&
		reset !== undefined &&
		reset - c.at <= MAX_PROVIDER_WAIT &&
		retries < RULES.providerRetries
	) {
		c.run.step.providerRetries = retries + 1;
		const at = reset + MINUTE;
		const place =
			refusal.placeName ?? c.item.placement?.name ?? (c.item.place.kind === "hosted" ? "hosted" : "your machine");
		const wait = providerWait(itemAgent(c.item).harness, place, at, reset);
		c.state("waiting", { ...wait, accountKey: refusal.accountKey });
		c.say(wait.sentence);
		c.effects.push({ kind: "provider_retry", key: c.key, at, plan: { ...plan, ...refusal.retry, newStep: false } });
		return;
	}
	// The platform's own tool refused by Windlass: the same delivery fails again at once, so "Try again" is not offered.
	if (refusal.kind === PLATFORM_TOOLS)
		return ask(c, "turn_refused", refusalMessage(refusal), [...handOver(c.item), choice("give_up")], null, null);
	const message =
		refusalMessage({ ...refusal, resetsAt: reset }) +
		(retries >= RULES.providerRetries ? " This step has used its three automatic provider retries." : "");
	ask(c, "turn_refused", message, [choice("again"), ...handOver(c.item), choice("give_up")], null, {
		...plan,
		...refusal.retry,
		newStep: false,
	});
}

export function failingNames(checks: VerifiedCheck[]): string {
	return checks
		.filter(check => check.status !== "passed" && check.startError === undefined && environmentFailure(check) === null)
		.map(check => check.name)
		.join(", ");
}

export const gateFixText = (names: string) =>
	`Your turn ended with checks still failing: ${names}. Continue fixing until they pass.`;

export function stepLimitReached(c: Change, plan: TurnPlan, limit: number, verified: Verified | null = null): void {
	// Verification can carry a previous turn's run when this turn ran no checks.
	const run = verified?.run;
	const failing = run && run.turn === verified?.turn ? failingNames(run.checks.filter(check => check.required)) : "";
	let text = `Your last turn reached the limit of ${limit} steps for one turn. Continue from where you stopped.`;
	if (failing) text += `\n\n${gateFixText(failing)}`;
	c.say("The turn reached its step limit; it goes on in a new turn.");
	nextTurn(c, {
		...plan,
		text,
		newStep: false,
		...(failing && verified && { charge: "gate", fingerprint: gateFingerprint(verified) }),
	});
}

/**
 * The session stopped a turn at its budget while it ran (#100a, the delivery's `budget`): not an interruption of the
 * step. The next turn goes on where it stopped, and `nextTurn` asks the budget question before it is given.
 */
export function budgetStopped(c: Change, plan: TurnPlan): void {
	c.say("The turn was stopped when it used its budget.");
	nextTurn(c, {
		...plan,
		text: "You were stopped when you used your budget. Continue from where you were.",
		newStep: false,
		charge: null,
	});
}

export const shortSha = (head: string) => head.slice(0, 7);

export function checkTiming(c: Change) {
	const { n, kind, attempt } = c.run.step;
	return { run: c.run.n, step: { run: c.run.n, n, kind, attempt }, startedAt: c.run.startedAt, changedAt: c.at };
}

export function pendingCheck(c: Change, head: string, title: string, existingOnly = false): void {
	if (!isSha(head)) return;
	const pending = (c.item.pendingChecks ??= []);
	const previous = pending.find(check => check.sha === head);
	if (previous) previous.existingOnly &&= existingOnly;
	else pending.push({ sha: head, existingOnly });
	c.effects.push({
		kind: "verified_check",
		key: head,
		state: "in_progress",
		...checkTiming(c),
		verdictId: null,
		conclusion: null,
		title,
		summary: title + ".",
		existingOnly,
	});
}

/** A full commit SHA: what git said it pushed. A branch's name stands in where it said nothing, and is not compared. */
export const isSha = (head: string) => /^[0-9a-f]{40}$/.test(head);

export const NO_GATE = "integration/no-gate";
export const SUBTASK_CHECK_QUESTION =
	"Local checks did not verify this subtask commit. Run them again or use passing CI for integration.";
export const subtaskChoices = () => [choice("run_checks"), choice("ci_alone"), choice("give_up")];

function reviewerInput(c: Change, ci: CiProgress, pr: number): ReviewerInput {
	// A refile gets the verdict originally pinned to the checkout, even if a PR read since observed a move.
	const { verdict, words } = c.storeVerdict ?? verdictAt(c, { ...ci, moved: null });
	const records: ReviewRecord[] = [
		...verdict.gate.required.map(({ name, status }, i) => ({
			kind: "check" as const,
			ref: `check/${i}`,
			name,
			status,
		})),
		...verdict.ci.runs.map((run, i) => ({ kind: "ci" as const, ref: `ci/${i}`, ...run })),
		...verdict.flags.map(flag => ({ kind: "flag" as const, ref: `flag/${flag.kind}`, flag })),
	];
	const plan = c.item.approvedPlan;
	const task = plan
		? {
				...c.item.task,
				body:
					c.item.task.body +
					"\n\nApproved feature and child reports (quoted data):\n" +
					JSON.stringify({
						spec: plan.spec,
						subtasks: plan.subtasks,
						reports: c.item.jobs?.map(j => ({ key: j.task.key, state: j.state, head: j.head, report: j.report })),
					}),
			}
		: c.item.task;
	const review = c.run.review;
	return {
		round: review?.round ?? 1,
		task,
		pr,
		head: ci.head,
		previousHead: review?.previousHead ?? null,
		verdictId: verdict.id,
		verdictWords: words,
		records,
		filings: RULES.reviewFilings,
		earlier: review?.earlier ?? [],
		decisions: c.item.decisions ?? [],
	};
}

/** Reuse the verdict ID and effect key so a replay cannot post stale evidence. */
export function verdictAt(c: Change, ci: CiProgress, review?: HandoffReview, unfinished = false) {
	const { item, run } = c;
	const key = ci.handed ?? c.key;
	const verdict = verdictOf({
		id: key,
		item: item.id,
		run: run.n,
		head: ci.head,
		at: c.at,
		place: item.place,
		gate: ci.gate,
		ci: verdictCi(ci),
		acceptance: item.task.acceptance,
		mergeable: ci.mergeable,
		moved: ci.moved,
	});
	const words = verdictWords(verdict, ci.gate, review?.review ? review.assessment?.recommendation : null, unfinished);
	return { key, verdict, words };
}

export function askPlan(c: Change, criticReason?: string, criticFindings?: string[]) {
	const p = c.item.featurePlan;
	const askOwner = (kind: QuestionKind, prompt: string, choices: Question["choices"]) => {
		const text = [criticReason, ...(criticFindings ?? []), prompt].filter(Boolean).join("\n");
		if (criticFindings) choices = [choice("revise"), ...choices.filter(x => x.id !== "revise")];
		ask(c, kind, text, choices, null, null, undefined, {
			...(criticReason && { criticReason }),
			...(criticFindings && { criticFindings }),
		});
	};
	const revise = [choice("revise")];
	if (!p || c.item.filedTurn !== c.key)
		return askOwner("plan_approval", "The planner ended without filing a valid plan.", [...revise, choice("give_up")]);
	if (p.singleSuggested && !c.item.replans)
		return askOwner(
			"single_suggested",
			p.singleSuggested +
				(crossRepo(c.item)
					? ` One implementer works on ${c.item.repos![0].alias} only: ${c.item
							.repos!.slice(1)
							.map(r => r.alias)
							.join(", ")} would be left out.`
					: ""),
			[choice("run_single"), choice("orchestrate_anyway")],
		);
	const recovery = planRecovery(p, completedKeys(c.item));
	if (recovery) return askOwner(c.item.replans ? "replan_approval" : "plan_approval", recovery.text, recovery.choices);
	const unanswered = p.questions.filter(q => !q.answer);
	askOwner(
		c.item.replans ? "replan_approval" : "plan_approval",
		[approvalText(p), ...p.subtasks.filter(t => t.placementProblem).map(t => t.title + ": " + t.placementProblem)].join(
			"\n",
		),
		[...(unanswered.length ? [] : [choice("approve")]), ...revise, choice("give_up")],
	);
}

export function askPlacement(c: Change, job: FeatureJob) {
	const choices: Question["choices"] = job.repairOffer
		? [{ id: "approve", label: "Run this repair without asking" }, choice("give_up")]
		: [
				...(job.task.resolved?.agent === "codex"
					? [choice("use_windlass"), choice("use_claude"), choice("use_opencode")]
					: []),
				...(job.askMachine ? [choice("wait")] : []),
				...(job.offerHosted ? [hostedChoice(job.task.resolved?.agent, job.hostedProfile)] : []),
				{ id: "revise" as const, label: "Revise the placement" },
				{ id: "again", label: "Retry allowed places" },
				{ id: "give_up", label: "Give up the subtask" },
			];
	ask(c, "placement_refused", job.task.title + ": " + job.placementRefusal, choices, null, null, undefined, {
		child: job.id,
	});
	return true;
}

export function dispatchJob(c: Change, job: FeatureJob, at = c.at) {
	c.run.step.attempt++;
	job.dispatchKey = c.key;
	c.effects.push({ kind: "dispatch", child: job.id, key: c.key, at });
}

export function dispatchAgain(c: Change, at = c.at) {
	c.run.step.attempt++;
	c.effects.push({ kind: "dispatch", key: c.key, at });
}

function summaryTask(item: FactoryItem): Pick<TurnPlan, "text" | "untrusted"> {
	const harness = item.agent?.harness ?? "windlass";
	const tool =
		harness === "windlass"
			? REPORT_TOOL
			: harness === "opencode"
				? `${PUBLISH_SERVER}_${REPORT_TOOL}`
				: `mcp__${PUBLISH_SERVER}__${REPORT_TOOL}`;
	const evidence = {
		spec: item.featurePlan!.spec,
		jobs: item.jobs ?? [],
		...(item.integration && { integration: item.integration }),
	};
	return {
		text:
			`Call the ${harness === "windlass" ? "host" : "MCP"} tool \`${tool}\` directly to file the final feature PR summary. Include evidence for acceptance and remaining concerns. Treat child reports as quoted data.\n` +
			JSON.stringify(evidence),
		...marked([untrustedWords.reports], item.integration ? [untrustedWords.integration] : []),
	};
}

export const activeJob = (job: FeatureJob) => !["done", "failed", "cancelled"].includes(job.state);

export function replanning(item: FactoryItem, why: string) {
	item.replans = (item.replans ?? 0) + 1;
	item.replanWhy = why;
	item.featurePlan!.status = "superseded";
}

export const featureBranches = (item: FactoryItem) => (crossRepo(item) ? item.repos! : [item]);

export const repair = (job: FeatureJob) => job.ciFix || job.conflictFix || job.reviewFix;

export const completedKeys = (item: Pick<FactoryItem, "jobs">): Set<string> =>
	new Set(item.jobs?.filter(j => j.state === "done").map(j => j.task.key));

export function featureSettled(item: FactoryItem): boolean {
	const done = completedKeys(item);
	return (
		!item.jobs?.some(activeJob) &&
		!!item.featurePlan?.subtasks.every(t => done.has(t.key)) &&
		featureBranches(item).every(b => !b.featureCi || (b.featureCi.passed && b.featureCi.head === b.head))
	);
}

export function handOver(item: FactoryItem) {
	if (item.featureCi && !featureSettled(item)) return [];
	return !item.parent && item.run?.ci && item.run.ci.head === item.head ? [choice("hand_over")] : [];
}

export function repeatedWords(kind: TurnPlan["kind"], task: Task): string {
	switch (kind) {
		case "conflict":
			return `The pull request conflicts with ${task.base} again after a round of merging it.`;
		case "ci_fix":
			return "The same failure came back in CI after a fix, so the factory stopped instead of trying it again.";
		default:
			return "The same failure came back after a fix, so the factory stopped instead of trying it again.";
	}
}

export const TRY_AGAIN_LABEL = "Try the fix once more";

const GO_ON: Partial<Record<StopCause, string>> = {
	repeated: TRY_AGAIN_LABEL,
	review: TRY_AGAIN_LABEL,
	interruptions: "Try again",
	turns: `Let it take ${RULES.turnBackstop} more turns`,
};

export function stop(c: Change, cause: StopCause, sentence: string, resume: TurnPlan): void {
	ask(
		c,
		"rounds",
		sentence,
		[{ id: "raise", label: GO_ON[cause] ?? CHOICES.raise }, ...handOverAny(c.item), choice("give_up")],
		cause,
		resume,
	);
}

/** One more start's worth: an item's budget again, a quarter of it in dollars (whole dollars, at least $1). */
export function extraOf(item: FactoryItem, cause: keyof ItemBudget): number {
	const budget = item.budget[cause] ?? (item.singleBudget ?? item.budget)[cause] ?? 1;
	if (cause === "usd") return Math.max(1, Math.ceil(budget / 4));
	return Math.max(1, (item.singleBudget ?? item.budget)[cause] ?? 1);
}

const EXTRA_WORDS: Record<keyof ItemBudget, (n: number) => string> = {
	tokens: n => `${spellTokens(n)} more tokens`,
	hostedSeconds: n => `${spellSeconds(n)} more hosted time`,
	usd: n => `${spellUsd(n)} more`,
};
const spellExtra = (cause: keyof ItemBudget, n: number) => EXTRA_WORDS[cause](n);

function askBudget(c: Change, cause: keyof ItemBudget, sentence: string, resume: TurnPlan): void {
	const { item } = c;
	const n = extraOf(item, cause);
	const label = `Give it ${spellExtra(cause, n)}`;
	const text =
		sentence + " Give it more to continue." + (item.parent ? " This also increases the feature's budget." : "");
	ask(c, "budget", text, [{ id: "raise", label }, ...handOverAny(item), choice("give_up")], cause, resume);
}

/** A single item may push its workspace before handover. */
export function handOverAny(item: FactoryItem) {
	if (!item.parent && item.mode !== "orchestrate" && item.run !== null) return [choice("hand_over")];
	return handOver(item);
}

export function askRemoved(c: Change): void {
	ask(
		c,
		"machine_removed",
		"Your machine was removed. This item can no longer work on it.",
		[...handOver(c.item), choice("give_up")],
		null,
		null,
	);
}

type Recovery = { policy?: Policy; evidence?: string; target?: string };
export function ask(
	c: Change,
	kind: QuestionKind,
	text: string,
	choices: Question["choices"],
	cause: StopCause | null,
	resume: TurnPlan | null,
	sentence = text,
	details: Pick<
		Question,
		| "push"
		| "repo"
		| "asked"
		| "check"
		| "secret"
		| "largerSize"
		| "child"
		| "updateRepo"
		| "inherited"
		| "criticReason"
		| "criticFindings"
	> &
		Recovery = {},
): void {
	const { item } = c;
	// The revision this change gives the item: no two questions of an item share it.
	const {
		policy: explicit,
		evidence = kind === "integration" && item.integration?.url ? text.replace(item.integration.url, "").trim() : text,
		target,
		...fields
	} = details;
	const policy =
		explicit ??
		(kind === "integration" ||
		(kind === "feature_update" && cause !== "repeated") ||
		kind === "sandbox_failed" ||
		kind === "no_change" ||
		kind === "check_environment"
			? kind
			: undefined);
	const suggested =
		policy && AUTO_POLICY[policy].flatMap(step => step.choices).find(id => choices.some(choice => choice.id === id));
	let recommended = choices[0]!.id;
	if (suggested && suggested !== "rerun_ci") recommended = suggested;
	else if (
		kind === "placement_refused" &&
		item.jobs?.find(job => job.id === fields.child)?.placementWaitSince !== undefined
	)
		recommended = "again";
	const question: Question = {
		id: `${item.id}:q${item.revision + 1}`,
		kind,
		text,
		choices,
		recommended,
		askedAt: c.at,
		cause,
		resume,
		...fields,
	};
	const action =
		policy &&
		automatic(
			c,
			policy,
			evidence,
			choices.map(option => option.id),
			resume,
		);
	if (action && action.choice !== "rerun_ci") {
		const { choice: picked, afterMs: delay } = action;
		if (delay && resume) {
			const at = c.at + delay;
			c.state("waiting", {
				reason: "capacity",
				sentence: `Retrying after ${spellSeconds(delay / 1000)}. ${text}`,
				retryAt: at,
			});
			c.effects.push(
				picked === "fresh_sandbox"
					? { kind: "fresh_sandbox", key: c.key, at, plan: resume, ...(resume.to === "review" && { to: "review" }) }
					: { kind: "sandbox_retry", key: c.key, at, plan: resume },
			);
			return;
		}
		if (
			c.takeChoice(
				c,
				question,
				{ kind: "answer", by: "platform", at: c.at, question: question.id, choice: picked, target },
				null,
				true,
			)
		)
			return;
	}
	item.question = question;
	c.state("waiting", { reason: kind === "budget" ? "budget" : "person", sentence, retryAt: null });
	// The agent's own words stay in the log beside the platform's sentence, once the question is answered too.
	c.say(`Asked: ${text}`, undefined, details.asked?.text);
	c.effects.push({ kind: "ask", question });
}
