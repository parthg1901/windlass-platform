/**
 * Which agent each subtask of a feature runs, as the plan view and its approval card show and change it
 * (`PlanSubtask.agent`). What a place offers is read from the machines the page has: Windlass anywhere,
 * and on a machine every agent a work item may run that its runner reports signed in ("token"). The
 * models and efforts are the account's for Windlass and the machine's catalog for another agent, the
 * lists the server holds a child's session to; a choice is judged with the server's own check
 * (server/src/factory/placement.ts, `agentModelProblem`, through `choosePlacement`).
 *
 * Claude Code and OpenCode work without asking. The planner reads the item's text, which may come from
 * an issue anyone could file, so its choice of either is never taken without the person confirming
 * each such subtask on the card (`approve_plan`'s `agents`).
 */
import type { HarnessId, MachineSummary, ModelList, PlanSubtask, SubtaskAgent } from "@contract";
import type { AgentModels } from "../../../server/src/factory/placement.js";
import {
	hostedAgentProblem,
	machineHarness,
	usesAccountModels,
	worksWithoutAsking,
} from "../../../server/src/sandbox/harnesses.js";
import { HARNESS_NAMES } from "./acp";
import { machineLabel } from "./machines";
import { cleanModelName, harnessOptions, modelName, type ReportedOptions } from "./models";

export { worksWithoutAsking };

/** The words the card puts beside an agent that never asks before a command or an edit. */
export const UNATTENDED_WORDS = "works without asking";

/** What a subtask's agent does that the person approves, in one sentence. */
export const UNATTENDED_MEANS = "It runs every command and edit in its sandbox without asking you.";

/** One agent a subtask may run at a place, and why it cannot be chosen there, if it cannot. */
export interface AgentChoice {
	id: HarnessId;
	name: string;
	problem: string | null;
}

/**
 * The agents a subtask may run at a place: Windlass everywhere; on a machine also each agent subtasks
 * run (harnesses.ts `subtasks`: not Codex) that it reports, those not signed in listed with why. Null machine: this platform.
 */
export function agentChoices(
	machine: MachineSummary | null,
	keys: readonly import("../../../server/src/sandbox/harnesses.js").HostedCredential[] | null = [],
	keyProfile = false,
): AgentChoice[] {
	const choices: AgentChoice[] = [{ id: "windlass", name: HARNESS_NAMES.windlass, problem: null }];
	if (!machine)
		for (const id of ["claude", "opencode"] as const) {
			choices.push({ id, name: HARNESS_NAMES[id], problem: hostedAgentProblem(id, keys, keyProfile) });
		}
	for (const reported of machine?.harnesses ?? []) {
		if (machineHarness(reported.id)?.subtasks !== true) continue;
		const name = HARNESS_NAMES[reported.id];
		const problem =
			reported.signIn === "token"
				? null
				: reported.signIn === "none"
					? `Not signed in on ${machineLabel(machine!)}.`
					: `${machineLabel(machine!)} could not say whether it is signed in.`;
		choices.push({ id: reported.id, name, problem });
	}
	return choices;
}

/** The machine a subtask prefers, by its name (or the feature's, which it inherits); null for this platform or a name no machine has. */
export function preferredMachine(
	task: PlanSubtask,
	parent: string,
	machines: MachineSummary[] | null,
): MachineSummary | null {
	const bound = task.review?.places[0]?.place;
	if (bound)
		return bound.kind === "hosted" ? null : (machines?.find(machine => machine.machineId === bound.machineId) ?? null);
	const name = task.place?.prefer ?? parent;
	return machines?.find(machine => machineLabel(machine) === name) ?? null;
}

/** A machine's catalogs as the page fetched them, by machine id and agent; a missing one falls back to what its list entry carries. */
export type Catalogs = Record<string, Partial<Record<HarnessId, ReportedOptions>>>;

/** The model list an agent offers at a machine (`harnessOptions`); null where it reported none yet. */
export function machineModels(
	machine: MachineSummary | null,
	harness: HarnessId,
	catalogs: Catalogs,
): ModelList | null {
	if (!machine || usesAccountModels(harness)) return null;
	return harnessOptions(machine, harness, catalogs[machine.machineId]?.[harness]).models;
}

/**
 * The lists the server's check holds a subtask's choice to (placement.ts, `AgentModels`): the account's
 * for Windlass and each machine agent's catalog. One not read yet is left out, and not judged here.
 */
export function agentModelsOf(
	machines: MachineSummary[] | null,
	catalogs: Catalogs,
	windlass: ModelList | null,
): AgentModels {
	const byMachine: NonNullable<AgentModels["machines"]> = {};
	for (const machine of machines ?? [])
		for (const reported of machine.harnesses ?? []) {
			if (reported.optionsDigest && !catalogs[machine.machineId]?.[reported.id]) continue;
			const list = machineModels(machine, reported.id, catalogs);
			if (list) (byMachine[machine.machineId] ??= {})[reported.id] = list;
		}
	return { windlass, machines: byMachine };
}

/** A subtask's agent in short words: its name, model and effort, each as the page names them. */
export function agentParts(
	agent: SubtaskAgent | undefined,
	list: ModelList | null,
): { name: string; model: string; effort: string | null; unattended: boolean } {
	const harness = agent?.harness ?? "windlass";
	const model = agent?.model
		? cleanModelName(agent.model, harness === "windlass" ? null : modelName(list, agent.model))
		: harness === "windlass"
			? "the feature's model"
			: "its default model";
	return {
		name: HARNESS_NAMES[harness],
		model,
		effort: agent?.effort ?? null,
		unattended: worksWithoutAsking(harness),
	};
}

/** The agent a draft names, as the plan saves it. No agent runs the resolved default; Windlass is a choice of its own. */
export function cleanAgent(agent: SubtaskAgent | null | undefined): SubtaskAgent | undefined {
	if (!agent) return undefined;
	return {
		harness: agent.harness,
		...(agent.model && { model: agent.model }),
		...(agent.effort && { effort: agent.effort }),
	};
}

/** A subtask with the person's choice of agent applied. */
export function withAgent(task: PlanSubtask, agent: SubtaskAgent | null | undefined): PlanSubtask {
	const { agent: _agent, resolved, review, placementProblem, placementWait, requestedLargerSize, ...rest } = task;
	const chosen = cleanAgent(agent);
	return chosen ? { ...rest, agent: chosen } : rest;
}

export const agentChanged = (task: PlanSubtask, agent: SubtaskAgent | null | undefined) =>
	JSON.stringify(cleanAgent(task.agent) ?? null) !== JSON.stringify(cleanAgent(agent) ?? null);
