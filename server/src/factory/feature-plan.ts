/* The ids of a feature's children are in feature-ids.ts: this file is shared with the web mock and stays free of Node modules. */
import type {
	ChoiceId,
	EarlyCheck,
	FeaturePlan,
	FeaturePlanEdit,
	FinalIntegration,
	ItemBudget,
	ItemQuestion,
	MergeStep,
	PlanSubtask,
	SubtaskAgent,
	SubtaskBudget,
} from "../contract.js";
import { SIZE_WEIGHT } from "../billing/meter.js";
import { choice } from "./answered.js";
import { runAgent } from "./resolve-run.js";
import {
	anyOf,
	subtaskHarnessProblem,
	harnessName,
	hostedProfiles,
	knownHarness,
	machineHarness,
	worksWithoutAsking,
} from "../sandbox/harnesses.js";
import { isolationName } from "../contract/isolation.js";
import { MAX_ACCEPTANCE_CRITERIA, MAX_ITEM_BODY_CHARS, MAX_NOTE_CHARS, MAX_TITLE_CHARS } from "../contract.js";

/**
 * A small plan: three ordinary item allowances bound both the number of work packages and the total exposure,
 * including the feature's own planning, summary and review allowance (autonomy.ts). The Usage summary's medium size too.
 */
export const SMALL_PLAN_LIMIT = 3;

/** The figures a budget has (`ItemBudget`). A subtask's plan budget has `tokens` only. */
export const dimensions = ["tokens", "hostedSeconds"] as const;

/** Planning receipts stay on the ledger. One implementer gets one item's budget on top of what planning spent. */
export function singleAfterPlanning(
	single: ItemBudget,
	spent: Pick<ItemBudget, "tokens" | "hostedSeconds" | "usd">,
): ItemBudget {
	return {
		tokens: Math.ceil(spent.tokens) + single.tokens,
		hostedSeconds: Math.ceil(spent.hostedSeconds) + single.hostedSeconds,
		...(single.usd !== undefined && { usd: Math.round(((spent.usd ?? 0) + single.usd) * 100) / 100 }),
	};
}

/** The longest a combined run may take. */
export const INTEGRATION_SECONDS = 3600;

/** A cross-repo plan: one that names its repositories. */
export const crossRepoPlan = (plan: Pick<FeaturePlanEdit, "repos"> | null | undefined): boolean =>
	(plan?.repos?.length ?? 0) > 1;

/** The tokens a plan gives its subtasks, together. */
export const planTokens = (plan: Pick<FeaturePlanEdit, "subtasks">): number =>
	plan.subtasks.reduce((sum, task) => sum + task.budget.tokens, 0);

/** A reserved job already owns its agent, even before its child can report a summary. */
export function editablePartAgents(
	plan: FeaturePlan,
	state: import("../contract.js").ItemState,
	step: string | undefined,
	reserved: readonly string[],
) {
	return plan.status === "approved" && !["done", "failed", "cancelled"].includes(state) && step === "subtasks"
		? plan.subtasks.filter(t => !reserved.includes(t.key)).map(t => t.key)
		: [];
}

export function subtaskHarness(task: Pick<PlanSubtask, "resolved" | "agent">) {
	return task.resolved?.agent ?? task.agent?.harness ?? "windlass";
}

// Remove this approval stopgap when every agent can plan and build Plan-first parts.
export function unsupportedParts(plan: Pick<FeaturePlanEdit, "subtasks">, completed: ReadonlySet<string>) {
	return plan.subtasks.filter(task => !completed.has(task.key) && subtaskHarnessProblem(subtaskHarness(task)));
}

/** These answers change the proposal; approval is offered on the resulting version. */
export function planRecovery(plan: FeaturePlan, completed: ReadonlySet<string>) {
	const unsupported = unsupportedParts(plan, completed);
	if (unsupported.length)
		return {
			text: `${harnessName(subtaskHarness(unsupported[0]!))} cannot build Plan-first parts. Choose another agent for those parts, then review the updated plan.`,
			choices: [
				{ id: "use_windlass" as const, label: "Use Windlass for these parts" },
				choice("use_claude"),
				choice("use_opencode"),
				choice("revise"),
			],
		};
	const larger = plan.subtasks.filter(t => !completed.has(t.key) && t.requestedLargerSize);
	if (larger.length)
		return {
			text: larger
				.map(
					t =>
						`${t.title} needs a ${t.requestedLargerSize} hosted sandbox at ${SIZE_WEIGHT[t.requestedLargerSize!]}× the standard hosted rate.`,
				)
				.join("\n"),
			choices: [
				{ id: "larger_sandbox" as const, label: "Use the requested sizes and review the plan" },
				choice("revise"),
				choice("give_up"),
			],
		};
	return null;
}

function agentWords(agent: SubtaskAgent | undefined): string {
	if (!agent) return "the resolved default agent";
	const choice = [agent.model ?? "its default model", ...(agent.effort ? [agent.effort + " effort"] : [])].join(", ");
	return (
		`${harnessName(agent.harness)} (${choice})` + (worksWithoutAsking(agent.harness) ? ", works without asking" : "")
	);
}

/** The keys of the subtasks still to run whose agent works without asking: approval needs the person's confirmation of each. */
export function unattendedKeys(
	plan: Pick<FeaturePlanEdit, "subtasks">,
	completed: ReadonlySet<string> = new Set(),
): string[] {
	return plan.subtasks.filter(s => !completed.has(s.key) && worksWithoutAsking(subtaskHarness(s))).map(s => s.key);
}

/** The choices that approve a proposed plan: as planned, or as one implementer. */
export const APPROVALS: ReadonlySet<string> = new Set<ChoiceId>(["approve", "run_single"]);

/** The plan's questions still without an answer. `drafts`: answers typed on the item page and not saved yet. */
export function openPlanQuestions(
	plan: Pick<FeaturePlan, "questions">,
	drafts: Readonly<Record<string, string>> = {},
): FeaturePlan["questions"] {
	return plan.questions.filter(q => !q.answer && !drafts[q.id]?.trim());
}

/**
 * Whether `choice` may not approve `plan` from `question` yet: the item page disables it and Slack leaves it out.
 * Every approval waits for the plan's questions. The approval block (the feature's CI) holds the feature's own
 * approval, for which one implementer is offered instead, unless one implementer is what the question approves.
 */
export function approvalHeld(
	plan: Pick<FeaturePlan, "questions">,
	question: Pick<ItemQuestion, "kind" | "approvalBlock">,
	choice: string,
	drafts?: Readonly<Record<string, string>>,
): boolean {
	if (!APPROVALS.has(choice)) return false;
	if (openPlanQuestions(plan, drafts).length) return true;
	return !!question.approvalBlock && (choice === "approve" || question.kind === "single_suggested");
}

export function approvalText(plan: FeaturePlan): string {
	const words = (b: SubtaskBudget) => b.tokens.toLocaleString("en-US") + " tokens";
	const unattended = plan.subtasks.filter(s => worksWithoutAsking(subtaskHarness(s))).map(s => `“${s.title}”`);
	const cross = crossRepoPlan(plan);
	const final = plan.finalIntegration;
	return [
		plan.spec.goal,
		...plan.subtasks.map(
			s =>
				(cross ? `[${s.repo}] ` : "") +
				s.title +
				" — " +
				words(s.budget) +
				(s.place ? ` on ‘${s.place.prefer}’: ${s.place.reason}` : "") +
				" — " +
				agentWords(s.resolved ? runAgent(s.resolved) : s.agent) +
				(s.needs?.hostedSize ? " · hosted size " + s.needs.hostedSize : ""),
		),
		...(unattended.length
			? [
					`${unattended.join(", ")} would run an agent that works without asking: it runs every command and edit in its sandbox without asking you. The planner proposed it from the item's text; approve only after confirming each one.`,
				]
			: []),
		...(cross && final
			? [
					"Merge order — " +
						(plan.mergeOrder ?? [])
							.map(m => m.repo + (m.prerequisite.length ? ` after ${m.prerequisite.join(", ")}` : ""))
							.join(", then ") +
						".",
					`Tested together in ${final.runFrom}: ${final.command} (inputs ${final.inputs.join(", ")}; at most ${final.timeoutSeconds} seconds; required cases: ${final.requiredCases.join("; ")}).`,
					plan.releaseGate === "wait"
						? "Ends when the owner's release is adopted."
						: "Ends at a tested set of pull requests and a release request; adopting a release is a separate feature.",
				]
			: []),
		...(plan.subtasks.some(s => s.needs?.cpus !== undefined || s.needs?.memoryGiB !== undefined)
			? [
					"On hosted, cpus and memoryGiB must fit the chosen size. A larger size requires your approval. On a machine they determine the slots.",
				]
			: []),
		"Subtasks together — " + words({ tokens: planTokens(plan) }) + " (cost-weighted: cached input counts at a tenth)",
		"Feature budget with planning, summary and review — " + words(plan.budget),
		"At most per subtask — " + words(plan.compare.singleBudget),
		...plan.questions.filter(q => !q.answer).map(q => q.text),
	].join("\n");
}

export class PlanError extends Error {}

/** A budget-only reallocation keeps the approved scope. */
export function planScope(plan: FeaturePlanEdit): string {
	const scope: unknown[] = [
		plan.overflow ?? false,
		plan.spec,
		plan.subtasks.map(
			({ budget, review, placementWait, resolved, placementProblem, requestedLargerSize, ...scope }) => scope,
		),
	];
	// A one-repository plan keeps the fingerprint it always had; a cross-repo one adds what was approved of its repositories.
	if (crossRepoPlan(plan))
		scope.push({
			repos: plan.repos,
			releaseGate: plan.releaseGate ?? "request",
			finalIntegration: plan.finalIntegration ?? null,
			mergeOrder: plan.mergeOrder ?? [],
			earlyChecks: plan.earlyChecks ?? [],
		});
	return JSON.stringify(scope);
}

function requirePlan(ok: unknown, message: string): asserts ok {
	if (!ok) throw new PlanError(message);
}

function record(value: unknown): Record<string, unknown> {
	requirePlan(value && typeof value === "object" && !Array.isArray(value), "Expected a plan object.");
	return value as Record<string, unknown>;
}

function text(value: unknown, max = MAX_NOTE_CHARS): string {
	requirePlan(
		typeof value === "string" && value.trim() && value.length <= max,
		`Expected nonempty text of at most ${max} characters.`,
	);
	return value.trim();
}

/** The most a plan question's background (`why`) keeps: it is cut there, never refused, so a long one costs the plan nothing. */
export const PLAN_QUESTION_WHY_CHARS = 400;

/** Text cut to `max` characters, with an ellipsis where it was cut. */
function cut(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

function lines(value: unknown, min = 0, max = MAX_ACCEPTANCE_CRITERIA): string[] {
	requirePlan(Array.isArray(value) && value.length >= min && value.length <= max, `Expected ${min} to ${max} entries.`);
	return value.map(line => text(line));
}

function keyOf(value: unknown): string {
	requirePlan(
		typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value),
		"Use a short stable key starting with a letter.",
	);
	return value;
}

function unique(keys: string[]) {
	requirePlan(new Set(keys).size === keys.length, "Keys must be unique.");
}

// Intersect the two small glob languages. A wildcard may consume an element or advance
// without consuming. Remember each pair of positions to bound the search.
function intersect(
	a: string[],
	b: string[],
	wildcard: string,
	match: (a: string, b: string) => boolean,
	literalRight = false,
) {
	const pending: [number, number][] = [[0, 0]];
	const seen = new Set<string>();
	while (pending.length) {
		const [i, j] = pending.pop()!,
			key = i + "/" + j;
		if (seen.has(key)) continue;
		seen.add(key);
		if (i === a.length && j === b.length) return true;
		const x = a[i],
			y = b[j],
			rightWildcard = !literalRight && y === wildcard;
		if (x === wildcard) pending.push([i + 1, j]);
		if (rightWildcard) pending.push([i, j + 1]);
		if (x !== undefined && y !== undefined && (x === wildcard || rightWildcard || match(x, y)))
			pending.push([x === wildcard ? i : i + 1, rightWildcard ? j : j + 1]);
	}
	return false;
}

function overlaps(a: string, b: string, literalRight = false) {
	return intersect(
		a.split("/"),
		b.split("/"),
		"**",
		(x, y) => intersect([...x], [...y], "*", (m, n) => m === n, literalRight),
		literalRight,
	);
}

/** Plain paths include their descendants. A glob describes its own depth. */
const ownedGlob = (entry: string) => (entry.includes("*") ? entry : entry + "/**");

export function sharedPaths(a: PlanSubtask, b: PlanSubtask): boolean {
	if (!a.owns?.length || !b.owns?.length) return true;
	return a.repo === b.repo && a.owns.some(p => b.owns.some(q => overlaps(ownedGlob(p), ownedGlob(q))));
}

export function ownsPath(owns: string[], path: string): boolean {
	return owns.some(pattern => overlaps(ownedGlob(pattern), path, true));
}

/** The longest model id a subtask may name; an effort is at most 64 characters, as a Quick item's. */
const MAX_AGENT_ID = 200;

/** Check the proposal’s agent and identifiers. Placement checks the agent’s capabilities. */
export function agentOf(value: unknown): SubtaskAgent | undefined {
	if (value == null) return undefined;
	const a = record(value);
	for (const key of Object.keys(a))
		requirePlan(["harness", "model", "effort"].includes(key), "Unknown agent field: " + key);
	const harness = knownHarness(a.harness);
	requirePlan(harness !== null, "Choose a supported agent: windlass, claude or opencode.");
	const id = (v: unknown, what: string, max: number) => {
		requirePlan(
			typeof v === "string" && v.length > 0 && v.length <= max && /^[\w.:/@+\[\]-]+$/.test(v),
			`Name the ${what} by its id.`,
		);
		return v;
	};
	const model =
		a.model === undefined || a.model === null || a.model === "" ? undefined : id(a.model, "model", MAX_AGENT_ID);
	const effort =
		a.effort === undefined || a.effort === null || a.effort === "" ? undefined : id(a.effort, "effort", 64);
	return { harness, ...(model !== undefined && { model }), ...(effort !== undefined && { effort }) };
}

/** A subtask's agent must support its requested sandbox profile at some place. */
export function agentProfileProblem(task: Pick<PlanSubtask, "agent" | "needs">): string | null {
	const agent = task.agent,
		profile = task.needs?.profile;
	// The profiles of its record, on a machine or hosted; Windlass runs in any.
	const acp = agent && machineHarness(agent.harness);
	if (!acp || profile === undefined) return null;
	const profiles = [...acp.profiles, ...hostedProfiles];
	if (profiles.includes(profile)) return null;
	return `${acp.name} runs only in ${anyOf([...new Set(profiles.map(isolationName))])} isolation.`;
}

function placementFields(s: Record<string, unknown>): Pick<PlanSubtask, "place" | "needs" | "agent"> {
	const result: Pick<PlanSubtask, "place" | "needs" | "agent"> = {};
	if (s.place !== undefined) {
		const p = record(s.place);
		const allow = p.allow === undefined ? undefined : lines(p.allow, 0, 12).map(n => text(n, 200));
		if (allow) unique(allow);
		result.place = { prefer: text(p.prefer, 200), reason: text(p.reason, 200), ...(allow && { allow }) };
	}
	if (s.needs !== undefined) {
		const n = record(s.needs);
		for (const key of Object.keys(n))
			requirePlan(
				["tags", "screenshots", "egress", "profile", "harness", "cpus", "memoryGiB", "hostedSize"].includes(key),
				"Unknown placement need: " + key,
			);
		const needs: NonNullable<PlanSubtask["needs"]> = {};
		if (n.tags !== undefined) needs.tags = lines(n.tags, 0, 24).map(tag => text(tag, 100));
		if (n.screenshots !== undefined) {
			requirePlan(typeof n.screenshots === "boolean", "Choose yes or no for screenshots.");
			needs.screenshots = n.screenshots;
		}
		if (n.egress !== undefined) {
			requirePlan(n.egress === "open" || n.egress === "restricted", "Choose open or restricted egress.");
			needs.egress = n.egress;
		}
		if (n.hostedSize !== undefined) {
			requirePlan(
				n.hostedSize === "small" || n.hostedSize === "standard" || n.hostedSize === "large",
				"Choose a listed hosted size.",
			);
			needs.hostedSize = n.hostedSize;
		}
		if (n.profile !== undefined) {
			requirePlan(
				n.profile === "docker-hardened" ||
					n.profile === "docker-windlass-sandbox" ||
					n.profile === "e2b-open" ||
					n.profile === "daytona",
				"Choose a supported sandbox profile.",
			);
			needs.profile = n.profile;
		}
		// Before subtasks named their agent, a need named its harness: read as the agent.
		if (n.harness !== undefined) result.agent = agentOf({ harness: n.harness });
		for (const key of ["cpus", "memoryGiB"] as const)
			if (n[key] !== undefined) {
				const value = n[key];
				requirePlan(
					typeof value === "number" && Number.isFinite(value) && value > 0,
					key + " must be a positive finite number.",
				);
				needs[key] = value;
			}
		result.needs = needs;
	}
	if (s.agent !== undefined && s.agent !== null) {
		const agent = agentOf(s.agent);
		requirePlan(
			!result.agent || result.agent.harness === (agent?.harness ?? "windlass"),
			"Name the subtask's agent once, in agent.",
		);
		if (agent) result.agent = agent;
		else delete result.agent;
	}
	const profile = agentProfileProblem(result);
	requirePlan(profile === null, profile!);
	return result;
}

/** The least a subtask may be given: a tenth of one item's tokens, and at least 1,000. */
export function subtaskMinimum(single: Pick<ItemBudget, "tokens">): SubtaskBudget {
	return { tokens: Math.max(1000, Math.ceil(single.tokens / 10)) };
}

/** A repository alias as a filing gives it. */
export const ALIAS = /^[a-z][a-z0-9-]{0,15}$/;

function aliasIn(value: unknown, filing: readonly string[], what: string): string {
	requirePlan(typeof value === "string" && ALIAS.test(value), `Name ${what} by its short alias.`);
	requirePlan(filing.includes(value), `${value} is not a repository of this feature: use ${filing.join(" or ")}.`);
	return value;
}

/**
 * What a cross-repo plan adds, checked against the filing's repositories (`filing`, the primary first):
 * the repositories, the merge order, the release gate, early checks and the combined run.
 */
function crossRepoFields(
	p: Record<string, unknown>,
	filing: readonly string[],
	subtasks: PlanSubtask[],
): Pick<FeaturePlanEdit, "repos" | "mergeOrder" | "releaseGate" | "earlyChecks" | "finalIntegration"> {
	requirePlan(
		Array.isArray(p.repos) && p.repos.every(r => typeof r === "string"),
		"List the feature's repositories in repos.",
	);
	const named = p.repos as string[];
	requirePlan(
		named.length <= filing.length,
		`A feature may span at most ${filing.length} repositories: those it was filed over.`,
	);
	for (const r of named) aliasIn(r, filing, "each repository");
	unique(named);
	requirePlan(
		named.length === filing.length,
		"Plan for every repository the feature was filed over: " + filing.join(", ") + ".",
	);
	for (const alias of filing)
		requirePlan(
			subtasks.some(s => s.repo === alias),
			`Give ${alias} at least one subtask, or file the feature over one repository.`,
		);
	requirePlan(Array.isArray(p.mergeOrder), "Give the merge order: one entry per repository.");
	const seen = new Set<string>();
	const mergeOrder: MergeStep[] = (p.mergeOrder as unknown[]).map(raw => {
		const m = record(raw),
			repo = aliasIn(m.repo, filing, "each merge step's repository");
		requirePlan(
			!seen.has(repo),
			`${repo} appears twice in the merge order: one pull request merges once, so a rollout that merges it again after another needs a later feature.`,
		);
		requirePlan(Array.isArray(m.prerequisite ?? []), "A merge step's prerequisite is a list of repositories.");
		const prerequisite = ((m.prerequisite ?? []) as unknown[]).map(r => aliasIn(r, filing, "a merge prerequisite"));
		unique(prerequisite);
		for (const before of prerequisite) {
			requirePlan(before !== repo, `${repo} cannot merge after itself.`);
			requirePlan(
				seen.has(before),
				`${repo} needs ${before} to merge first, so ${before} comes earlier in the merge order. Merge prerequisites must not form a cycle.`,
			);
		}
		seen.add(repo);
		return {
			repo,
			prerequisite,
			intermediate: text(m.intermediate),
			evidence: text(m.evidence),
			fallback: text(m.fallback),
		};
	});
	for (const alias of filing) requirePlan(seen.has(alias), `Put ${alias} in the merge order.`);
	const releaseGate = p.releaseGate === undefined || p.releaseGate === null ? "request" : p.releaseGate;
	requirePlan(releaseGate === "request" || releaseGate === "wait", "Choose request or wait for the release gate.");
	requirePlan(
		releaseGate === "request",
		"Waiting for a release is not offered yet: end the feature at a release request.",
	);
	const early = p.earlyChecks ?? [];
	requirePlan(Array.isArray(early) && early.length <= 4, "Use at most 4 early checks.");
	const earlyChecks: EarlyCheck[] = early.map(raw => {
		const e = record(raw),
			repo = aliasIn(e.repo, filing, "an early check's repository"),
			sibling = aliasIn(e.sibling, filing, "an early check's sibling");
		requirePlan(repo !== sibling, "An early check runs one repository against the other.");
		return { repo, sibling, name: text(e.name, 200), command: text(e.command, 2000) };
	});
	const f = record(p.finalIntegration);
	const runFrom = aliasIn(f.runFrom, filing, "the repository the combined run starts from");
	requirePlan(typeof f.command === "string" && f.command.trim() !== "", "Give the combined run a command.");
	requirePlan(Array.isArray(f.inputs), "List the combined run's inputs.");
	const inputs = (f.inputs as unknown[]).map(r => aliasIn(r, filing, "each input of the combined run"));
	unique(inputs);
	for (const alias of filing) requirePlan(inputs.includes(alias), `The combined run must take ${alias} as an input.`);
	const profile = f.profile === undefined ? "actions" : f.profile;
	requirePlan(profile === "actions", "The combined run runs on GitHub Actions (profile actions).");
	const timeoutSeconds = f.timeoutSeconds === undefined ? INTEGRATION_SECONDS : f.timeoutSeconds;
	requirePlan(
		typeof timeoutSeconds === "number" &&
			Number.isSafeInteger(timeoutSeconds) &&
			timeoutSeconds >= 60 &&
			timeoutSeconds <= INTEGRATION_SECONDS,
		`The combined run's timeout is a whole number of seconds from 60 to ${INTEGRATION_SECONDS}.`,
	);
	const finalIntegration: FinalIntegration = {
		runFrom,
		command: text(f.command, 2000),
		inputs: filing.filter(a => inputs.includes(a)),
		profile,
		timeoutSeconds,
		requiredCases: lines(f.requiredCases, 1, 32).map(c => text(c, 200)),
		artifactOutputs: lines(f.artifactOutputs ?? [], 0, 16).map(c => text(c, 200)),
	};
	return { repos: [...filing], mergeOrder, releaseGate, earlyChecks, finalIntegration };
}

/**
 * The plan, checked. `repos`: the aliases of a cross-repo filing's repositories, the primary first; a
 * plan for one is then cross-repo and must say how its repositories merge and are tested together.
 */
export function validatePlan(
	value: unknown,
	single: Pick<ItemBudget, "tokens">,
	repos: readonly string[] = [],
): FeaturePlanEdit {
	const p = record(value),
		spec = record(p.spec);
	const cross = repos.length > 1;
	// A one-repository plan is checked as it always was: what only a cross-repo plan has (repos, mergeOrder, releaseGate,
	// earlyChecks, finalIntegration, a subtask's repo) is not read, as before there were cross-repo features.
	requirePlan(p.overflow === undefined || typeof p.overflow === "boolean", "Choose yes or no for placement overflow.");
	const singleSuggested = p.singleSuggested == null ? null : text(p.singleSuggested);
	requirePlan(Array.isArray(p.questions) && p.questions.length <= 16, "Use at most 16 plan questions.");
	const questions = p.questions.map(raw => {
		const q = record(raw);
		requirePlan(q.why == null || typeof q.why === "string", "A question's why must be text.");
		const why = typeof q.why === "string" ? cut(q.why.trim(), PLAN_QUESTION_WHY_CHARS) : "";
		const options = q.options === undefined ? undefined : lines(q.options, 1, 12);
		const recommended = q.recommended === undefined ? undefined : text(q.recommended, 80);
		requirePlan(
			!recommended || !options || options.includes(recommended),
			"A recommended answer must be one of the question's options.",
		);
		return {
			id: keyOf(q.id),
			text: text(q.text),
			...(options && { options }),
			...(why && { why }),
			...(recommended && { recommended }),
			...((q.answer && { answer: text(q.answer) }) || {}),
		};
	});
	unique(questions.map(q => q.id));
	requirePlan(
		Array.isArray(p.subtasks) &&
			((singleSuggested && p.subtasks.length === 0) || (p.subtasks.length >= 2 && p.subtasks.length <= 6)),
		"Propose two to six subtasks or suggest one single item.",
	);
	const minimum = subtaskMinimum(single);
	const subtasks: PlanSubtask[] = p.subtasks.map(raw => {
		const s = record(raw),
			asked = record(s.budget);
		const key = keyOf(s.key);
		requirePlan(
			!key.startsWith("review-fix-"),
			"Subtask keys starting with review-fix- are reserved for feature review fixes.",
		);
		requirePlan(!key.startsWith("ci-fix-"), "Subtask keys starting with ci-fix- are reserved for feature CI fixes.");
		// One cost-weighted token figure. A plan from before names more figures; only its tokens are read.
		const n = asked.tokens;
		requirePlan(
			typeof n === "number" && Number.isSafeInteger(n) && n >= minimum.tokens && n <= single.tokens,
			`Subtask tokens must be a whole number between ${minimum.tokens} and ${single.tokens}.`,
		);
		const budget: SubtaskBudget = { tokens: n };
		const owns = lines(s.owns ?? [], 0, 32);
		for (const path of owns)
			requirePlan(
				/^[\w.*@/-]+$/.test(path) && path.split("/").every(part => part && ![".", "..", ".git"].includes(part)),
				"Use repository-relative owned path globs.",
			);
		const dependsOn = lines(s.dependsOn, 0, 5).map(keyOf);
		unique(dependsOn);
		const acceptance = lines(s.acceptance, 1);
		requirePlan(
			acceptance.some(line =>
				/screenshot|`[^`]+`|(?:^|\s)(?:run|use|execute|npm|pnpm|yarn|bun|make|go test|cargo|pytest|python|docker|curl|gradle|mvn|dotnet|bash|sh)\s+\S/i.test(
					line,
				),
			),
			"Name a check command or screenshot in each subtask’s acceptance.",
		);
		const repo = cross ? aliasIn(s.repo, repos, "each subtask's repository") : undefined;
		return {
			key,
			title: text(s.title, MAX_TITLE_CHARS),
			brief: text(s.brief, MAX_ITEM_BODY_CHARS),
			acceptance,
			owns,
			dependsOn,
			budget,
			...placementFields(s),
			...(repo && { repo }),
		};
	});
	unique(subtasks.map(s => s.key));
	const done = new Set<string>();
	while (done.size < subtasks.length) {
		const next = subtasks.find(s => !done.has(s.key) && s.dependsOn.every(k => done.has(k)));
		requirePlan(next, "Dependencies must name existing subtasks and form an acyclic graph.");
		done.add(next.key);
	}
	const plan: FeaturePlanEdit = {
		overflow: p.overflow === true,
		questions,
		singleSuggested,
		subtasks,
		spec: {
			goal: text(spec.goal, 2000),
			acceptance: lines(spec.acceptance, 1),
			requirements: lines(spec.requirements),
			outOfScope: lines(spec.outOfScope),
		},
	};
	// A suggestion of one item names no subtasks: the person sees which repository it would be on before converting.
	if (cross && !(singleSuggested && subtasks.length === 0)) Object.assign(plan, crossRepoFields(p, repos, subtasks));
	return plan;
}
