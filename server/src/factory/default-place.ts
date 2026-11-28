import {
	machineLabel,
	type HarnessId,
	type ItemMode,
	type ItemPlaceDefaults,
	type MachineSummary,
	type SandboxPlace,
	type SandboxProfileId,
} from "../contract.js";
import {
	harnessName,
	itemModeOf,
	itemProfiles,
	initialHarnessModels,
	machinePayerProblem,
	itemSignInMessage,
	itemSignInMethodProblem,
	knownHarness,
	machineHarness,
} from "../sandbox/harnesses.js";
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

export function profilesForItems(machine: MachineSummary, harness: HarnessId) {
	const available = machine.profiles.filter(
		p => p.available && (!machine.allowedProfiles || machine.allowedProfiles.some(id => id === p.id)),
	);
	if (machine.egress === "none" || machine.warnings.some(w => w.kind === "outdated" || w.kind === "signing-disabled"))
		return [];
	const agent = machineHarness(harness);
	if (!agent) return available;
	const offered = machine.harnesses?.find(h => h.id === harness);
	if (
		!offered ||
		itemSignInMessage(agent, machineLabel(machine), offered.signIn) ||
		itemSignInMethodProblem(agent, machineLabel(machine), offered.method)
	)
		return [];
	return itemProfiles(harness).flatMap(id =>
		available.filter(
			p => p.id === id && (!agent.sandboxedOn.includes(id) || offered.modes?.includes(itemModeOf(harness, id) ?? "")),
		),
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
	if (
		!candidates.some(m =>
			profilesForItems(m, harness ?? "windlass").some(p => machineProfile == null || p.id === machineProfile),
		)
	)
		return `No selected machine currently supports ${harnessName(harness ?? "windlass")}${machineProfile ? " with " + machineProfile : ""} for work items. Check its profiles and agent sign-in.`;
	return null;
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
		const profiles = profilesForItems(machine, harness);
		const profile = run.profile ?? profiles[0]?.id;
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
		} else if (run.profile && !machine.profiles.some(p => p.id === run.profile && p.available))
			reasons.push(
				`“${label}” cannot run ${run.profile}. ${machine.profiles.find(p => p.id === run.profile)?.unavailableReason ?? "Choose another profile or enable it on the runner."}`,
			);
		else if (!profiles.some(p => p.id === profile))
			reasons.push(
				`“${label}” cannot run ${harnessName(harness)} with ${profile ?? "an available profile"}. Check its allowed profiles and payer.`,
			);
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
