import {
	machineLabel,
	type HarnessId,
	type ItemMode,
	type ItemPlaceDefaults,
	type MachineSummary,
	type SandboxPlace,
	type SandboxProfileId,
} from "../contract.js";
import { type Availability, availability, availableProfiles } from "../sandbox/availability.js";
import { initialHarnessModels, machinePayerProblem, knownHarness } from "../sandbox/harnesses.js";
import { resolveRun, runAgent, type ResolvedRun } from "./resolve-run.js";
import { agentModelRefusal, machineSlots, runnerProblem, type AgentModels } from "./placement.js";

export function savedPlace(
	repo?: ItemPlaceDefaults | null,
	account?: ItemPlaceDefaults | null,
): ItemPlaceDefaults | undefined {
	if (!repo?.place && !account?.place && !repo?.harness && !account?.harness) return;
	const run = resolveRun({ repository: repo ?? undefined, account: account ?? undefined }, "builder");
	return {
		place: run.place,
		harness: run.agent,
		machineProfile: run.profile,
		placeFallback: run.fallback,
		machineModel: run.model,
		machineEffort: run.effort,
	};
}

export function placeMachines(place: ItemPlaceDefaults["place"], machines: readonly MachineSummary[]) {
	if (place === "any-machine") return machines;
	return typeof place === "object" && place ? machines.filter(m => m.machineId === place.machine) : [];
}

/** Whether a work item can run this agent on the machine, in the profile named or in any (availability.ts). */
function itemAvailability(machine: MachineSummary, harness: HarnessId, profile?: SandboxProfileId | null) {
	return availability({
		agent: harness,
		role: "quick",
		place: { kind: "machine", machine },
		...(profile && { profile }),
		credentials: NO_CREDENTIALS,
	});
}
/** A machine's report says what pays for its agents, and Windlass's payer is the turn's to judge. */
const NO_CREDENTIALS = { keys: [] };

/** A refusal as one line: the rule, then what to do about it. */
const refusalLine = (refused: Extract<Availability, { ok: false }>) =>
	refused.fix ? `${refused.message} ${refused.fix.text}` : refused.message;

/** The profiles of the machine a work item can run this agent in, the agent's own default first. */
export function profilesForItems(machine: MachineSummary, harness: HarnessId) {
	const place = { kind: "machine" as const, machine };
	return availableProfiles({ agent: harness, role: "quick", place, credentials: NO_CREDENTIALS }).flatMap(id =>
		machine.profiles.filter(p => p.id === id),
	);
}

export function placeProblem(policy: ItemPlaceDefaults, machines: readonly MachineSummary[]): string | null {
	const { place, harness, machineProfile, placeFallback, machineModel, machineEffort } = policy;
	if (
		[machineModel, machineEffort].some(
			id => id != null && (typeof id !== "string" || !/^[\w.:/@+\[\]-]{1,200}$/.test(id)),
		)
	)
		return "Choose a model and effort from the list.";
	if ((machineModel || machineEffort) && harness === "windlass") return "Choose a machine agent for this model.";
	if (placeFallback != null && placeFallback !== "wait" && placeFallback !== "hosted")
		return "Choose whether to wait or run hosted.";
	if (machineProfile != null && machineProfile !== "docker-windlass-sandbox" && machineProfile !== "docker-hardened")
		return "Choose a reported machine profile.";
	if (harness != null && !knownHarness(harness)) return "Choose an agent from the list.";
	if (place == null || place === "hosted") return null;
	if (place !== "any-machine" && (typeof place !== "object" || typeof place.machine !== "string"))
		return "Choose where items run.";
	const candidates = placeMachines(place, machines);
	if (!candidates.length)
		return place === "any-machine"
			? "There are no paired machines."
			: "The selected machine is no longer in your account.";
	const verdicts = candidates.map(m => itemAvailability(m, harness ?? "windlass", machineProfile));
	const refused = verdicts.find(v => !v.ok);
	if (verdicts.some(v => v.ok) || !refused || refused.ok) return null;
	return (candidates.length > 1 ? "None of your machines can run this. " : "") + refusalLine(refused);
}

export function defaultPlaceRetryAt(at: number, attempt: number) {
	const minutes = [1, 2, 5][attempt] ?? 10;
	return at + minutes * 60_000;
}

function roomProblem(machine: MachineSummary): string | null {
	if (machine.sandboxes.filter(b => b.state === "running").length >= (machine.maxRunning ?? Infinity))
		return "is at its running sandbox limit.";
	if (machine.sandboxes.length >= (machine.maxSandboxes ?? Infinity)) return "is at its kept sandbox limit.";
	const slots = machineSlots(machine);
	return slots.max === null || slots.busy < slots.max ? null : "has no free slot.";
}

export function hasRoom(machine: MachineSummary) {
	return machine.status === "online" && roomProblem(machine) === null;
}

export interface DefaultDestination {
	place: SandboxPlace;
	harness: HarnessId;
	profile?: SandboxProfileId;
	wait?: string;
	refusal?: { code: "harness_signed_out" | "bad_effort" | "bad_model" | "bad_input"; message: string };
}

export function resolveDefaultPlace(
	defaults: ItemPlaceDefaults,
	machines: readonly MachineSummary[],
	mode: ItemMode,
): DefaultDestination {
	return checkRunPlace(resolveRun({ account: defaults }, mode === "orchestrate" ? "planner" : "builder"), machines);
}

export function checkRunPlace(
	run: ResolvedRun,
	machines: readonly MachineSummary[],
	models?: AgentModels,
): DefaultDestination {
	const harness = run.agent;
	if (run.place === "hosted") return { place: { kind: "hosted" }, harness, profile: run.profile ?? undefined };
	if (run.payer === "unconfirmed")
		return {
			place: { kind: "machine", machineId: typeof run.place === "object" ? run.place.machine : "any-machine" },
			harness,
			wait: "This item did not record its payer. Choose whether to use the machine’s own sign-in.",
		};
	const candidates = placeMachines(run.place, machines);
	const reasons: string[] = [];
	let refusal: DefaultDestination["refusal"];
	for (const machine of candidates) {
		const label = machineLabel(machine);
		const verdict = itemAvailability(machine, harness, run.profile);
		const profile = verdict.ok ? verdict.profile : (run.profile ?? undefined);
		const offered = machine.harnesses?.find(h => h.id === harness);
		const runner = runnerProblem(machine.warnings);
		const source = "machine";
		const payer = offered && machinePayerProblem(offered, run.model ?? undefined, offered.platformKeys ?? [], label);
		// Given lists are judged as given: one not read yet is not judged, rather than held to the summary's "default" only.
		const list =
			harness === "windlass"
				? models?.windlass
				: models || offered?.optionsDigest
					? models?.machines?.[machine.machineId]?.[harness]
					: initialHarnessModels(offered?.options);
		const model = agentModelRefusal(runAgent(run), list);
		if (machine.status !== "online") reasons.push(`“${label}” is offline.`);
		else if (runner) reasons.push(`“${label}”: ${runner}`);
		else if (offered && (typeof run.place === "object" || run.sources.payer === "item") && run.payer !== source)
			reasons.push(`“${label}”: restore the payer selected for this run before retrying.`);
		else if (payer) {
			if (source === "machine" && offered.signIn !== "token") {
				refusal = { code: "harness_signed_out", message: payer };
				reasons.push(payer);
			} else reasons.push(`“${label}”: ${payer}`);
		} else if (offered?.optionsDigest && (run.model || run.effort) && !list) {
			reasons.push(`“${label}”: waiting for its current model list.`);
		} else if (model) {
			const catalogModel = model.code === "bad_model" && list?.source === "harness" && list.fetchedAt != null;
			refusal = { code: catalogModel ? "bad_input" : model.code, message: model.message };
			reasons.push(`“${label}”: ${model.reason}.`);
		} else if (!verdict.ok) reasons.push(refusalLine(verdict));
		else {
			const room = roomProblem(machine);
			const place = { kind: "machine" as const, machineId: machine.machineId };
			if (room) reasons.push(`“${label}” ${room}`);
			else return { place, harness, profile };
		}
	}
	const wait = reasons.join(" ") || "No paired machine matches this choice.";
	const machineId = typeof run.place === "object" ? run.place.machine : candidates[0]?.machineId;
	return {
		place: { kind: "machine", machineId: machineId ?? "any-machine" },
		harness,
		profile: run.profile ?? undefined,
		wait,
		...(typeof run.place === "object" && refusal && { refusal }),
	};
}

export const changesPlace = (change: ItemPlaceDefaults) =>
	[
		change.place,
		change.harness,
		change.machineProfile,
		change.placeFallback,
		change.machineModel,
		change.machineEffort,
	].some(v => v !== undefined);

export function changedPlace(before: ItemPlaceDefaults, change: ItemPlaceDefaults): ItemPlaceDefaults {
	const place = change.place === undefined ? before.place : change.place;
	// Another agent starts on its own default model.
	const agent = change.harness === undefined || change.harness === before.harness ? before : {};
	return {
		place: typeof place === "object" && place ? { machine: place.machine } : (place ?? null),
		harness: change.harness === undefined ? (before.harness ?? null) : change.harness,
		machineProfile: change.machineProfile === undefined ? (before.machineProfile ?? null) : change.machineProfile,
		placeFallback: change.placeFallback === undefined ? (before.placeFallback ?? null) : change.placeFallback,
		machineModel: change.machineModel === undefined ? (agent.machineModel ?? null) : change.machineModel,
		machineEffort: change.machineEffort === undefined ? (agent.machineEffort ?? null) : change.machineEffort,
	};
}
