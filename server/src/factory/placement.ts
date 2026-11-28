// Names are a proposal. Only the owner's inventory may turn them into durable destinations.
import { MAX_PROVIDER_WAIT, providerWait } from "../provider-usage.js";
import { nextUtcDay, usesPlatformModel } from "../usage.js";
import { HOSTED_SIZE_NAMES, HOSTED_SIZE_SPECS, hostedSizeFor, isolationName, sandboxSlots } from "../contract.js";
import type {
	ChildPlacement,
	EgressMode,
	HostedSize,
	FeaturePlanEdit,
	HarnessId,
	MachineSummary,
	ModelList,
	PlanSubtask,
	SandboxPlace,
	SandboxProfileId,
} from "../contract.js";
import type { plannerMachines } from "../machines/details.js";
import { SIZE_WEIGHT } from "../billing/meter.js";
import { partRun, runAgent, type RunContext } from "./resolve-run.js";
import { PlanError, subtaskHarness } from "./feature-plan.js";
import { retryAt, slotWait } from "./budget.js";
import {
	type HostedCredential,
	usesAccountModels,
	windlassProvider,
	hostedCatalog,
	hostedProvider,
	hostedProviders,
	initialHarnessModels,
	selectedKey,
	harnessName,
	machineHarness,
	subtaskHarnessProblem,
} from "../sandbox/harnesses.js";
import {
	type Availability,
	type MachineFacts,
	availability,
	credentialsOf,
	refusalText,
} from "../sandbox/availability.js";
import { checkItemEffort, chosenModel, ModelProblem } from "../account-models.js";

/** The profiles a machine serves; the rest are a hosted deployment's. */
const MACHINE_PROFILES: readonly SandboxProfileId[] = ["docker-hardened", "docker-windlass-sandbox"];

/**
 * The models each agent offers, as a session would be checked against them (user.ts, `makeSession`):
 * Windlass's are the account's wherever it runs; a machine harness's are its runner's catalog, or only its
 * default where it reported none. An explicit choice waits for an advertised list that could not be read.
 */
export interface AgentModels {
	windlass?: ModelList | null;
	machines?: Record<string, Partial<Record<HarnessId, ModelList>>>;
}

type Machine = ReturnType<typeof plannerMachines>[number];
export interface PlacementInventory {
	defaults?: RunContext;
	screenshotsEnabled?: boolean;
	screenshotStorage?: boolean;
	repositoryScreenshots?: Record<string, boolean>;
	dailyTokenWait?: string | null;
	machines: Machine[];
	hostedProfiles: SandboxProfileId[];
	keyProfiles?: SandboxProfileId[];
	/** What hosted turns can pay with: checked Settings keys and connected plans. */
	hostedCredentials?: readonly HostedCredential[];
	/** The hosted sizes the deployment offers (`Sandboxes.sizes`), smallest first. Absent: one size, which takes no `cpus` or `memoryGiB`. */
	hostedSizes?: HostedSize[];
	hostedRates?: Partial<Record<HostedSize, number | null>>;
	/** What hosted sandboxes may reach (`Sandboxes.egress`); `none` takes no repository work. */
	hostedEgress?: EgressMode;
	defaultProfile?: SandboxProfileId;
	/** Account state from provider routing, when available. */
	limited?: { machineId: string; harness: string; limitedUntil?: number; accountKey?: string }[];
	models?: AgentModels;
	/** The feature's Windlass model, which a Windlass subtask choosing only an effort runs. */
	featureModel?: string;
	/**
	 * The places (`placeKey`: "hosted", machine ids) that hold a fresh post-setup snapshot of the subtask's
	 * repository for this user (user.ts `snapshotPlaces`): a sandbox there may skip setup. A bonus only.
	 */
	snapshotPlaces?: string[];
}

/**
 * What a fresh snapshot adds to a ready place's score: as much as two free slots. It ranks places the
 * person allowed and that can run the subtask now; it never makes a refused or waiting place ready, and
 * never puts an alternative before the preferred place unless that alternative outranks it without it
 * (`choosePlacement`).
 */
export const SNAPSHOT_BONUS = 2;
export interface PlacementRoute {
	waitForMachine?: boolean;
	preferred: SandboxPlace;
	alternatives: SandboxPlace[];
	/** Display names at approval, for a destination later removed from inventory. */
	names?: Record<string, string>;
}
/** A limit at `place`, or Windlass's plan's (its ChatGPT models run on the ChatGPT plan at every place). */
export function limitApplies(limit: NonNullable<PlacementInventory["limited"]>[number], place: string) {
	return limit.machineId === place || (limit.machineId.startsWith("plan/") && limit.harness === "windlass");
}
const GiB = 2 ** 30;
export function placeKey(place: SandboxPlace) {
	return place.kind === "hosted" ? "hosted" : place.machineId;
}

function resolve(name: string, machines: Machine[]): SandboxPlace {
	if (name === "hosted") return { kind: "hosted" };
	const matches = machines.filter(m => m.name === name);
	if (matches.length !== 1)
		throw new PlanError(
			matches.length
				? `More than one machine is named ‘${name}’. Rename one before approval.`
				: `‘${name}’ is not one of your machines.`,
		);
	return { kind: "machine", machineId: matches[0]!.machineId };
}

export function bindRoute(
	task: PlanSubtask,
	parent: SandboxPlace,
	overflow: boolean,
	machines: Machine[],
): PlacementRoute {
	const inherited = task.resolved?.place;
	const first = inherited === "any-machine" ? machines[0]?.machineId : undefined;
	const preferred: SandboxPlace = task.place
		? resolve(task.place.prefer, machines)
		: inherited === "hosted"
			? { kind: "hosted" }
			: typeof inherited === "object"
				? { kind: "machine", machineId: inherited.machine }
				: inherited === "any-machine"
					? { kind: "machine", machineId: first ?? "any-machine" }
					: parent;
	const allowed = task.place?.allow?.map(name => resolve(name, machines)) ?? [];
	const alternatives: SandboxPlace[] =
		!task.place && inherited === "any-machine"
			? machines.slice(1).map(m => ({ kind: "machine" as const, machineId: m.machineId }))
			: overflow
				? allowed.filter(p => placeKey(p) !== placeKey(preferred))
				: [];
	if (!task.place && preferred.kind === "machine" && task.resolved?.fallback === "hosted")
		alternatives.push({ kind: "hosted" });
	const names: Record<string, string> = {};
	for (const place of [preferred, ...alternatives]) {
		if (place.kind !== "machine") continue;
		const machine = machines.find(m => m.machineId === place.machineId);
		if (machine) names[place.machineId] = machine.name;
	}
	return { preferred, alternatives, names };
}

/**
 * A place that cannot take a subtask now either never can (`permanent`: the owner's policy, a removed
 * machine, a missing capability, a size its runner cannot report) or might later (low disk, no available
 * profile). Approval refuses only a subtask whose every allowed place is permanently refused. A busy or
 * offline machine is a wait, never a refusal.
 */
type Candidate =
	| { refused: string; permanent: boolean; larger?: HostedSize }
	| { wait: string; offline?: boolean; dailyCap?: boolean; providerUntil?: number; accountKey?: string }
	| { decision: ChildPlacement; score: number };
export function placementRetryAt(at: number, providerUntil?: number, dailyCap?: boolean) {
	return Math.min(providerUntil ?? retryAt(at, 0), dailyCap ? nextUtcDay(at) : Infinity, at + MAX_PROVIDER_WAIT);
}

export function runnerProblem(warnings: MachineSummary["warnings"] = []) {
	for (const warning of warnings) {
		if (warning.kind === "outdated") return "Update the runner to the supported version.";
		if (warning.kind === "signing-disabled") return "Runner signing is disabled on this deployment.";
		if (warning.kind === "docker") return warning.reason;
	}
	return null;
}

export function machineSlots(machine: Pick<MachineSummary, "slots" | "turns" | "host">) {
	if (machine.slots) return machine.slots;
	// A disconnected runner loses its hello max. Its busy count is still reported.
	return {
		max: machine.turns?.max ?? null,
		busy: machine.turns?.running ?? 0,
		queued: machine.turns?.queued ?? 0,
		unit: { cpus: machine.host?.sandboxCpus ?? 0, memoryBytes: 1.5 * GiB },
	};
}

// An older runner without a concurrency cap offers one known slot.
export const freeMachineSlots = ({ max, busy }: Pick<ReturnType<typeof machineSlots>, "max" | "busy">) =>
	max === null ? 1 : Math.max(0, max - busy);

/**
 * Why the model or effort a subtask chose is not one its agent offers, by `list`; null where it is, or nothing
 * was chosen. Windlass without a model of its own runs the feature's (`featureModel`): an effort alone is held
 * to that model, and is not judged where the feature's model is not known.
 */
export function agentModelRefusal(
	agent: PlanSubtask["agent"],
	list: ModelList | null | undefined,
	featureModel?: string,
) {
	if (!agent || !list || (agent.model === undefined && agent.effort === undefined)) return null;
	const machine = machineHarness(agent.harness) !== null;
	if (agent.model === undefined && !machine && featureModel === undefined) return null;
	try {
		const model = chosenModel(list, agent.model ?? (machine ? undefined : featureModel));
		if (agent.effort !== undefined) checkItemEffort(list, model, agent.effort, machine);
		return null;
	} catch (error) {
		if (error instanceof ModelProblem) {
			return {
				code: error.code,
				message: error.message,
				reason: `${harnessName(agent.harness)}: ${error.message.replace(/[.:]?\s*$/, "")}`,
			};
		}
		throw error;
	}
}

export function agentModelProblem(
	agent: PlanSubtask["agent"],
	list: ModelList | null | undefined,
	featureModel?: string,
): string | null {
	return agentModelRefusal(agent, list, featureModel)?.reason ?? null;
}

/** A reason a place cannot run a subtask: a fragment said after the machine's name, or a whole sentence of its own. */
type Unfit = { text: string; whole?: true };

/**
 * The machine as `availability` judges an agent on it, from its last report. Both machine profiles count as
 * listed: whether one can be used now is judged with the machine's room, and may change. Its runner and its
 * network are judged before this.
 */
const machineFacts = (m: Machine): MachineFacts => ({
	name: m.name,
	os: m.os,
	arch: m.arch,
	allowedProfiles: m.allowedProfiles,
	egress: m.egress,
	warnings: [],
	profiles: MACHINE_PROFILES.map(id => ({ id, available: true })),
	harnesses: m.harnesses,
});

/** Whether the machine can run the subtask's agent as a part, in the profile it needs or the agent's own (availability.ts). */
function agentOnMachine(m: Machine, task: PlanSubtask): Availability {
	const needs = task.needs?.profile;
	return availability({
		agent: subtaskHarness(task),
		role: "part",
		place: { kind: "machine", machine: machineFacts(m) },
		...(needs && MACHINE_PROFILES.some(id => id === needs) && { profile: needs }),
		credentials: { keys: [] },
		model: task.agent?.model,
		repo: false,
	});
}

/**
 * Whether a place can run the subtask's agent, from its last report: the agent's own rules (`agentOnMachine`),
 * the payer the part was approved with, and its model. Every refusal is permanent: the owner changes the
 * machine, then approves or retries.
 */
function agentFit(
	machine: Machine,
	task: PlanSubtask,
	inventory: PlacementInventory,
	verdict: Availability | null,
): Unfit | null {
	const harness = subtaskHarness(task);
	if (verdict && !verdict.ok) return { text: refusalText(verdict), whole: true };
	if (verdict) {
		const chosen = task.resolved;
		if (
			chosen &&
			typeof chosen.place === "object" &&
			chosen.place.machine === machine.machineId &&
			chosen.payer !== "machine"
		)
			return { text: "The payer selected for this part has changed. Restore its original payer before retrying." };
	}
	const list = usesAccountModels(harness)
		? inventory.models?.windlass
		: inventory.models?.machines?.[machine.machineId]?.[harness];
	const model = agentModelProblem(task.agent, list, inventory.featureModel);
	return model ? { text: model } : null;
}

/** What the machine cannot do at all, from its last report. Kept while it is offline. */
function capabilityFit(
	machine: Machine,
	task: PlanSubtask,
	inventory: PlacementInventory,
	verdict: Availability | null,
): Unfit | null {
	const needs = task.needs ?? {};
	const runner = runnerProblem(machine.warnings);
	if (runner) return { text: runner };
	const screenshots = machine.screenshots && subtaskHarness(task) === "windlass";
	const tags = new Set([
		...machine.tags,
		machine.os,
		machine.arch,
		"os:" + machine.os,
		"arch:" + machine.arch,
		"harness:windlass",
		...(screenshots ? ["screenshots"] : []),
		...(machine.harnesses?.map(h => "harness:" + h.id) ?? []),
	]);
	const missing = needs.tags?.find(t => !tags.has(t));
	if (missing) return { text: `missing tag ‘${missing}’` };
	if (needs.screenshots && !screenshots)
		return { text: "start this runner with --screenshots and a pinned screenshot image" };
	if (machine.egress === "none" || (needs.egress && needs.egress !== machine.egress))
		return { text: "the egress policy does not support this repository task" };
	const agent = agentFit(machine, task, inventory, verdict);
	if (agent) return agent;
	if (needs.profile && !MACHINE_PROFILES.some(id => id === needs.profile))
		return { text: "this profile runs only on hosted sandboxes" };
	if (needs.profile && machine.allowedProfiles && !machine.allowedProfiles.some(p => p === needs.profile))
		return { text: `the owner does not allow the ${isolationName(needs.profile)} profile` };
	return null;
}

/** The terms shown for an allowed destination are the terms a child receives there. */
function destinationTerms(place: SandboxPlace, machine: Machine | undefined, harness: HarnessId) {
	const payer = harness === "windlass" ? "windlass" : place.kind === "hosted" ? "key" : "machine";
	return {
		place,
		name: machine?.name ?? placeKey(place),
		payer,
		sendSecrets: place.kind === "hosted" || (machine?.repositorySecrets ?? null),
	} as const;
}

function candidate(
	task: PlanSubtask,
	place: SandboxPlace,
	inventory: PlacementInventory,
	preferred: boolean,
	warm: string[],
	at: number,
	name?: string,
): Candidate {
	const resolved = task.resolved;
	const needs = task.needs ?? {};
	const harness = subtaskHarness(task);
	if (needs.screenshots) {
		const problem =
			inventory.screenshotsEnabled === false
				? "Screenshots are disabled on this deployment."
				: inventory.repositoryScreenshots && !inventory.repositoryScreenshots[task.repo ?? ""]
					? "Enable screenshots for this repository or remove the screenshot requirement."
					: inventory.screenshotStorage === false
						? "Screenshot storage is unavailable on this deployment."
						: harness !== "windlass"
							? `${harnessName(harness)} cannot file screenshots. Choose Windlass.`
							: null;
		if (problem) return { refused: problem, permanent: true };
	}
	const bonus = (preferred ? 3 : 0) + Number(warm.includes(placeKey(place)));
	// Usage limits are an account's: only those of the subtask's own agent there hold it back.
	const m = place.kind === "machine" ? inventory.machines.find(m => m.machineId === place.machineId) : undefined;
	const terms = destinationTerms(place, m, harness);
	const destination = {
		place,
		name: terms.name,
		sendSecrets: terms.sendSecrets === true,
		...(terms.payer !== "windlass" && { harness, payer: terms.payer }),
	};
	const offered = m?.harnesses?.find(h => h.id === harness);
	const keys = offered?.platformKeys ?? [];
	const reviewed = task.review?.places.find(p => placeKey(p.place) === placeKey(place));
	if (reviewed && m && reviewed.sendSecrets !== terms.sendSecrets)
		return {
			refused: `The repository secrets policy for ‘${m.name}’ changed after approval. Review the placement again.`,
			permanent: true,
		};
	const model =
		task.agent?.model ??
		(usesAccountModels(harness)
			? inventory.featureModel
			: inventory.models?.machines?.[placeKey(place)]?.[harness]?.defaultModel);
	const tokenWait = usesPlatformModel(harness, model) ? inventory.dailyTokenWait : null;
	const provider =
		harness === "windlass"
			? windlassProvider(model)
			: place.kind === "hosted"
				? hostedProvider(harness, model, hostedProviders(harness, inventory.hostedCredentials ?? []))
				: selectedKey(harness, model, keys);
	const limited = inventory.limited?.find(a =>
		provider ? a.machineId === "settings/" + provider : limitApplies(a, placeKey(place)) && a.harness === harness,
	);
	const waiting = (limit: NonNullable<typeof limited>, name: string) => {
		const dailyCap = !!tokenWait;
		const wait =
			limit.limitedUntil === undefined
				? `Waiting for the ${harness} usage limit on ‘${name}’ to reset.`
				: providerWait(harness, name, placementRetryAt(at, limit.limitedUntil, dailyCap)).sentence;
		return { wait, providerUntil: limit.limitedUntil, accountKey: limit.accountKey, dailyCap };
	};
	const reason = preferred
		? (task.place?.reason ?? (task.resolved ? "Resolved default for this part" : "Same place as the feature"))
		: `Approved overflow from ‘${task.place?.prefer ?? "the preferred machine"}’`;
	const notForSubtasks = subtaskHarnessProblem(harness);
	if (notForSubtasks) return { refused: notForSubtasks, permanent: true };
	if (place.kind === "hosted") {
		const profiles = harness === "windlass" ? inventory.hostedProfiles : (inventory.keyProfiles ?? []);
		if (machineHarness(harness)) {
			const keyProfiles = inventory.keyProfiles ?? [];
			const verdict = availability({
				agent: harness,
				role: "part",
				place: {
					kind: "hosted",
					profiles: inventory.hostedProfiles.map(id => ({
						id,
						available: true,
						...(keyProfiles.includes(id) && { platformKeys: true as const }),
					})),
				},
				...(needs.profile && { profile: needs.profile }),
				credentials: credentialsOf(inventory.hostedCredentials ?? []),
				model,
				repo: false,
			});
			if (!verdict.ok) return { refused: refusalText(verdict), permanent: true };
		}
		const modelProblem = agentModelProblem(
			task.agent,
			usesAccountModels(harness)
				? inventory.models?.windlass
				: initialHarnessModels(hostedCatalog(harness, inventory.hostedCredentials ?? [])),
			inventory.featureModel,
		);
		if (modelProblem) return { refused: `hosted: ${modelProblem}.`, permanent: true };
		if (!profiles.length || (needs.profile && !profiles.includes(needs.profile)))
			return { refused: "hosted has no available matching profile", permanent: true };
		if (inventory.hostedEgress === "none")
			return { refused: "hosted sandboxes have no network for repositories", permanent: true };
		if (needs.egress && needs.egress !== inventory.hostedEgress) {
			const network = { open: "open internet access", restricted: "restricted network access" };
			const available = inventory.hostedEgress
				? `Hosted sandboxes here have ${network[inventory.hostedEgress]}.`
				: "The hosted network policy is unknown.";
			return { refused: `${available} This part asked for ${network[needs.egress]}.`, permanent: true };
		}
		if (needs.tags?.length)
			return {
				refused: `This part needs the machine tag “${needs.tags[0]}”. Hosted sandboxes do not provide machine tags.`,
				permanent: true,
			};
		// `cpus` and `memoryGiB` choose a hosted size: the least that has them. Absent: the item's own size (standard by default).
		const sized = hostedSizeFor(needs);
		if (resolved && resolved.sources.size !== "deployment" && !inventory.hostedSizes?.includes(resolved.size))
			return {
				refused: `${HOSTED_SIZE_NAMES[resolved.size]} is unavailable. Choose an offered hosted size for this part.`,
				permanent: true,
			};
		if ((needs.cpus || needs.memoryGiB) && !sized)
			return {
				refused: `hosted sandboxes have at most ${HOSTED_SIZE_SPECS.large.cpus} vCPU and ${HOSTED_SIZE_SPECS.large.memoryMiB / 1024} GiB`,
				permanent: true,
			};
		if (sized && resolved && HOSTED_SIZE_SPECS[sized].cpus > HOSTED_SIZE_SPECS[resolved.size].cpus)
			return {
				refused: `This part needs ${HOSTED_SIZE_NAMES[sized]}. Choose that hosted size or reduce the part’s resource request.`,
				permanent: true,
				larger: inventory.hostedSizes?.includes(sized) ? sized : undefined,
			};
		const size = resolved && inventory.hostedSizes?.length ? resolved.size : sized;
		const quote = task.review?.hosted;
		if (quote && (quote.size !== size || quote.usdPerHour !== (inventory.hostedRates?.[quote.size] ?? null)))
			return { refused: "The reviewed hosted size or rate has changed. Review the placement again.", permanent: true };
		if (size && !(inventory.hostedSizes ?? ["small"]).includes(size))
			return {
				refused: `hosted has no ${HOSTED_SIZE_NAMES[size]} sandbox (${HOSTED_SIZE_SPECS[size].cpus} vCPU, ${HOSTED_SIZE_SPECS[size].memoryMiB / 1024} GiB) on this deployment`,
				permanent: true,
			};
		if (limited) return waiting(limited, "hosted");
		if (tokenWait) return { wait: tokenWait, dailyCap: true };
		const profile = needs.profile ?? profiles.find(p => p === inventory.defaultProfile) ?? profiles[0];
		return {
			decision: {
				...destination,
				units: 1,
				reason,
				profile,
				...(size && inventory.hostedSizes && { hostedSize: size }),
			},
			score: bonus,
		};
	}
	if (!m)
		return {
			refused: (name ? "‘" + name + "’" : "The selected machine") + " is no longer one of your machines.",
			permanent: true,
		};
	const never = (message: string): Candidate => ({ refused: `‘${m.name}’: ${message}.`, permanent: true });
	const notNow = (message: string): Candidate => ({ refused: `‘${m.name}’: ${message}.`, permanent: false });
	if (m.orchestrator === "never" || (m.orchestrator === "named" && !task.place))
		return never("owner placement policy is " + m.orchestrator);
	// Another agent than Windlass has rules of its own about where it runs.
	const verdict = machineHarness(harness) ? agentOnMachine(m, task) : null;
	const slots = machineSlots(m);
	const needed = Math.max(
		1,
		needs.cpus && slots.unit.cpus > 0 ? Math.ceil(needs.cpus / slots.unit.cpus) : 1,
		needs.memoryGiB ? Math.ceil((needs.memoryGiB * GiB) / slots.unit.memoryBytes) : 1,
	);
	if (needed > 1 && !m.slots)
		return never("sizing beyond one slot is not supported by this runner (" + needed + " slots required)");
	if (needed > 4 || (slots.max !== null && needed > slots.max))
		return never(`the task needs ${needed} slots and exceeds the machine or four-slot limit`);
	const units = sandboxSlots(needed, slots.max ?? 1);
	// A machine that has never reported is judged when it connects. One that has keeps its last report.
	const reported = m.online || m.egress !== undefined;
	const incapable = reported ? capabilityFit(m, task, inventory, verdict) : null;
	if (incapable) return incapable.whole ? { refused: incapable.text, permanent: true } : never(incapable.text);
	if (limited) return waiting(limited, m.name);
	if (tokenWait) return { wait: tokenWait, dailyCap: true };
	if (!m.online) return { wait: `Waiting for ‘${m.name}’ to come back online.`, offline: true };
	if (
		offered?.optionsDigest &&
		(task.agent?.model || task.agent?.effort) &&
		!inventory.models?.machines?.[m.machineId]?.[harness]
	)
		return { wait: `Waiting for the current ${harnessName(harness)} model list on ‘${m.name}’.` };
	if (needs.cpus && slots.unit.cpus <= 0) return notNow("per-slot CPU capacity is unknown");
	if ((m.freeDiskBytes ?? 0) < 5 * GiB) return notNow("at least 5 GiB of reported free disk is required");
	const allowed = m.availableProfiles.filter(p => !m.allowedProfiles || m.allowedProfiles.some(id => id === p));
	// An agent with rules of its own takes the profile they give it; before its machine has reported, Open.
	const wanted: SandboxProfileId | undefined =
		needs.profile ?? (verdict ? (verdict.ok ? verdict.profile : "docker-hardened") : undefined);
	const profile = wanted
		? allowed.find(p => p === wanted)
		: (allowed.find(p => p === inventory.defaultProfile) ?? allowed[0]);
	if (!profile)
		return wanted
			? never(`the selected profile ${wanted} is unavailable. Choose an available profile`)
			: notNow("no available owner-allowed profile matches");
	const free = freeMachineSlots(slots);
	if (m.sandboxes.running >= (m.sandboxes.maxRunning ?? Infinity))
		return { wait: `‘${m.name}’ is at its running sandbox limit.` };
	if (m.sandboxes.kept >= (m.sandboxes.maxSandboxes ?? Infinity))
		return { wait: `‘${m.name}’ is at its kept sandbox limit.` };
	if (free < units) return { wait: slotWait(m.name, units, free) };
	return {
		decision: { ...destination, reason, units, profile },
		score: bonus + Math.min(free, 3) - slots.queued - m.personalRunning,
	};
}

/**
 * A ready place, else the earliest wait, else every refusal. `permanent` is true only when each allowed
 * place is refused for good: approval refuses then, and nothing the owner waits for would help.
 */
export function choosePlacement(
	task: PlanSubtask,
	route: PlacementRoute,
	inventory: PlacementInventory,
	warm: string[] = [],
	at = Date.now(),
) {
	if (task.resolved?.payer === "unconfirmed")
		return {
			refused:
				"This plan did not record the machine agent’s payer. Revise the placement and approve it with the intended payer.",
			permanent: true,
		} as const;
	if (task.resolved) {
		if (task.resolved.agent === "windlass")
			inventory = { ...inventory, featureModel: inventory.models?.windlass?.defaultModel };
		task = { ...task, agent: runAgent(task.resolved) };
	}
	const candidates = [route.preferred, ...route.alternatives].map((place, i) => {
		let profile = task.resolved?.profile;
		if (task.resolved && (task.resolved.place === "hosted") !== (place.kind === "hosted")) {
			const prefer = place.kind === "hosted" ? "hosted" : place.machineId;
			profile = partRun(inventory.defaults ?? {}, { ...task, place: { prefer, reason: "" } }).profile;
		}
		const needs = { ...task.needs, profile: task.needs?.profile ?? profile ?? undefined };
		return candidate(
			{ ...task, needs },
			place,
			inventory,
			i === 0,
			warm,
			at,
			route.names?.[placeKey(place)] ?? (i === 0 ? task.place?.prefer : undefined),
		);
	});
	const first = candidates[0]!;
	const changesPayer = ({ place, payer }: ChildPlacement) => {
		if (!task.resolved || !payer) return false;
		const reviewed = task.review?.places.find(p => placeKey(p.place) === placeKey(place));
		if (reviewed && reviewed.payer !== payer) return true;
		return payer !== task.resolved.payer;
	};
	if ("decision" in first && !changesPayer(first.decision)) return { decision: first.decision } as const;
	const decided = candidates.flatMap(c =>
		"decision" in c ? [{ ...c, snapshot: !!inventory.snapshotPlaces?.includes(placeKey(c.decision.place)) }] : [],
	);
	decided.sort(
		(a, b) =>
			(route.preferred.kind === "machine"
				? Number(a.decision.place.kind === "hosted") - Number(b.decision.place.kind === "hosted")
				: 0) || b.score + (b.snapshot ? SNAPSHOT_BONUS : 0) - (a.score + (a.snapshot ? SNAPSHOT_BONUS : 0)),
	);
	const ready = decided.find(c => !changesPayer(c.decision)) ?? decided[0];
	const reason =
		"wait" in first ? first.wait : "refused" in first ? first.refused : "The selected payer is unavailable.";
	if (ready?.decision.place.kind === "hosted" && route.preferred.kind === "machine") {
		if (!route.waitForMachine)
			return { wait: reason, askMachine: true, offerHosted: true, hostedProfile: ready.decision.profile };
	} else if (ready) return { decision: ready.decision } as const;
	const waits = candidates.filter(c => "wait" in c);
	const deadline = (wait: (typeof waits)[number]) => placementRetryAt(at, wait.providerUntil, wait.dailyCap);
	const waiting = waits.sort((a, b) => deadline(a) - deadline(b))[0];
	if (waiting)
		return {
			wait: waiting.wait,
			askMachine: waiting.offline && !route.waitForMachine,
			retryAt: deadline(waiting),
			providerUntil: waiting.providerUntil,
			dailyCap: waiting.dailyCap,
			accountKey: waiting.accountKey,
		} as const;
	if (ready) return { wait: reason, retryAt: placementRetryAt(at) };
	const refusals = candidates.flatMap(c => ("refused" in c ? [c] : []));
	const larger = refusals.find(c => c.larger)?.larger;
	return {
		refused: refusals.map(c => c.refused).join(" "),
		larger,
		permanent: refusals.every(c => c.permanent),
	} as const;
}

export function hostedTerms(saved: HostedSize, size: HostedSize, inventory: PlacementInventory) {
	return { saved, size, rate: SIZE_WEIGHT[size], usdPerHour: inventory.hostedRates?.[size] ?? null };
}

// A busy destination can become ready without changing what its owner authorizes.
const offerOf = (task: PlanSubtask) =>
	JSON.stringify([task.resolved, task.review, task.placementProblem, task.requestedLargerSize]);

/** Resolve the version the owner reviews using the inventory that admits the plan. */
export function reviewPart(
	task: PlanSubtask,
	context: RunContext | undefined,
	parent: SandboxPlace,
	overflow: boolean,
	inventory: PlacementInventory,
) {
	const previous = offerOf(task);
	delete task.review;
	delete task.requestedLargerSize;
	delete task.placementProblem;
	delete task.placementWait;
	if (context) task.resolved = partRun(context, task, "part", inventory.machines);
	try {
		const route = bindRoute(task, parent, overflow, inventory.machines);
		const fit = choosePlacement(task, route, { ...inventory, defaults: context });
		if (fit.permanent) task.placementProblem = fit.refused;
		else if (fit.wait || fit.refused) task.placementWait = fit.wait ?? fit.refused;
		if (fit.larger) task.requestedLargerSize = fit.larger;
		const run = task.resolved;
		const places = [route.preferred, ...route.alternatives].map(place =>
			destinationTerms(
				place,
				place.kind === "machine" ? inventory.machines.find(m => m.machineId === place.machineId) : undefined,
				subtaskHarness(task),
			),
		);
		const inherited = partRun(context ?? {}, { repo: task.repo });
		task.review = { places, inherited };
		if (places.some(p => p.place.kind === "hosted") && (inventory.hostedSizes?.length || task.needs?.hostedSize)) {
			const saved = inherited.size;
			const size = fit.larger ?? run?.size ?? task.needs?.hostedSize ?? saved;
			task.review.hosted = hostedTerms(saved, size, inventory);
		}
	} catch (error) {
		if (!(error instanceof PlanError)) throw error;
		task.placementProblem = error.message;
	}
	return previous !== offerOf(task);
}

export function approveRoutes(
	plan: FeaturePlanEdit,
	parent: SandboxPlace,
	inventory: PlacementInventory,
	completed: Set<string>,
) {
	return Object.fromEntries(
		plan.subtasks
			.filter(task => !completed.has(task.key))
			.map(task => {
				const route = bindRoute(task, parent, !!plan.overflow, inventory.machines);
				const fit = choosePlacement(task, route, inventory);
				// A busy or offline machine, or one short of disk, is a wait the feature takes after approval.
				if (fit.refused !== undefined && fit.permanent) throw new PlanError(task.title + ": " + fit.refused);
				return [task.key, route];
			}),
	);
}
