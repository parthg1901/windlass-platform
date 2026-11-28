/**
 * The Connections page's grid (screens/Connections.tsx): for each agent and each place it runs (Hosted, each paired
 * machine), what pays for it now and the one action that connects it. Hosted follows the turn resolver as it is
 * (`hostedPayer`: a connected plan first, then a key); a machine follows its runner's report: an agent a plan can pay
 * for with no login of its own there (`paysWith`) pays as hosted, Pay with deciding. Pure: no React, no client.
 */
import {
	type HarnessId,
	type MachineSummary,
	type ModelPlanStatus,
	type ModelPlans,
	type ModelProvider,
	type ModelProviderStatus,
	type PayWithChoice,
	PLAN_NAMES,
	type PlanProvider,
} from "@contract";
import {
	type HostedCredential,
	hostedPayer,
	keyProviders,
	machineHarness,
	WINDLASS_KEY_PROVIDERS,
} from "../../../server/src/sandbox/harnesses.js";
import { payWithFor } from "../../../server/src/pay-with.js";
import type { ReportedHarness } from "./acp";
import { clockTime } from "./format";
import { SOURCE_NAMES } from "./models";

/** What the page reads once and every cell is decided from. */
export interface ConnectionInputs {
	keys: readonly ModelProviderStatus[];
	plans: ModelPlans;
	/** Whether the ChatGPT sign-in is connected: Windlass's own models run on it. */
	chatgpt: boolean;
	/** Whether this account may connect the ChatGPT sign-in (not the demo user). */
	canConnectChatgpt: boolean;
	/** The saved Pay with choices: a hosted cell shows what they make pay, not the default. */
	payWith?: readonly PayWithChoice[];
}

/**
 * How a cell stands: paid by a plan, a key, or the machine's own sign-in; "bad" a saved key whose check failed;
 * "none" nothing connected; "absent" the agent is not on that machine; "unknown" its runner could not check.
 */
export type CellState = "plan" | "key" | "machine" | "bad" | "none" | "absent" | "unknown";

/** Where a cell's one action leads: a plan's connect command, a key's entry, or the Machines page. */
export type CellAction =
	| { kind: "plan"; provider: PlanProvider; reconnect?: true }
	| { kind: "key"; provider: ModelProvider }
	| { kind: "machines" };

export interface ConnectionCell {
	/** The cell's element id, which a link names as the page's fragment (`cellId`). */
	id: string;
	state: CellState;
	label: string;
	detail: string | null;
	action: CellAction | null;
	/** What the relays last saw of the plan that pays here, where it is not simply usable (`planBadge`). */
	badge?: CellBadge;
	/**
	 * A machine's agent that can keep a login of its own there (`ownMachineLogin`): "offered" while the account's plan
	 * or key pays, "kept" while that login does. The cell offers the other way, on the machine `machineId`.
	 */
	ownLogin?: { state: "offered" | "kept"; machineId: string };
}

/** A plan's health in a few words: at its limit (until when), or refused twice and to be connected again. */
export interface CellBadge {
	tone: "warn" | "bad";
	text: string;
}

/** The badge a plan's cell shows: none while it is usable, or once a limit's time has passed. */
export function planBadge(plan: ModelPlanStatus | undefined, now: number): CellBadge | null {
	if (!plan) return null;
	if (plan.health === "invalid") return { tone: "bad", text: "Stopped working" };
	if (plan.health !== "limited" || plan.limitedUntil === null || plan.limitedUntil <= now) return null;
	const at = clockTime(plan.limitedUntil, now);
	return { tone: "warn", text: plan.resetKnown ? `Limited until ${at}` : `Limited · trying again at ${at}` };
}

/** A plan cell's badge and, for a plan that stopped working, its reconnect. */
function withHealth(cell: ConnectionCell, plan: ModelPlanStatus | undefined, now: number): ConnectionCell {
	const badge = planBadge(plan, now);
	if (!badge || !plan) return cell;
	return {
		...cell,
		badge,
		...(plan.health === "invalid" && { action: { kind: "plan", provider: plan.provider, reconnect: true } }),
	};
}

/** A place in the grid: Hosted, or a paired machine by its id. */
export type ConnectionPlace = "hosted" | string;

/** The id of an agent's cell at a place: what a disabled agent in the composer links to (`/connections#claude-hosted`). */
export const cellId = (harness: HarnessId, place: ConnectionPlace) => `${harness}-${place}`;

/** The connected plans hosted turns can pay with, where the account may use plans. */
export function planCredentials(plans: ModelPlans): HostedCredential[] {
	if (!plans.allowed) return [];
	return plans.plans
		.filter(plan => plan.ok)
		.map(plan => ({ provider: plan.provider, plan: true as const, checkedAt: plan.checkedAt, models: plan.models }));
}

/** What hosted turns can pay with, as the server's `hostedCredentials` counts them: checked keys, and plans where allowed. */
export function hostedCredentialsFrom(inputs: ConnectionInputs): HostedCredential[] {
	return [...inputs.keys.filter(key => key.ok), ...planCredentials(inputs.plans)];
}

const planProvidersOf = (harness: HarnessId): readonly PlanProvider[] => machineHarness(harness)?.planProviders ?? [];

/** The connect a hosted agent needs: its plan where the account may connect one, else its first key. */
export function connectAction(harness: HarnessId, inputs: ConnectionInputs): CellAction {
	if (harness === "windlass")
		return inputs.canConnectChatgpt ? { kind: "plan", provider: "openai" } : { kind: "key", provider: "openai" };
	const plan = inputs.plans.allowed ? planProvidersOf(harness)[0] : undefined;
	if (plan) return { kind: "plan", provider: plan };
	return { kind: "key", provider: keyProviders(harness)[0] ?? "openai" };
}

const keyNames = (providers: readonly ModelProvider[]) => providers.map(provider => SOURCE_NAMES[provider]).join(", ");

/** An agent on Hosted: the plan or key `hostedPayer` would pick for its default model, or what to connect. */
export function hostedCell(harness: HarnessId, inputs: ConnectionInputs, now = Date.now()): ConnectionCell {
	const id = cellId(harness, "hosted");
	const ownKeys = (harness === "windlass" ? WINDLASS_KEY_PROVIDERS : keyProviders(harness)).filter(provider =>
		inputs.keys.some(key => key.provider === provider),
	);
	const okKeys = inputs.keys.filter(key => key.ok && ownKeys.includes(key.provider));
	if (harness === "windlass") {
		if (inputs.chatgpt)
			return withHealth(
				{
					id,
					state: "plan",
					label: PLAN_NAMES.openai,
					detail: okKeys.length ? `Keys too: ${keyNames(okKeys.map(key => key.provider))}` : null,
					action: null,
				},
				inputs.plans.plans.find(one => one.provider === "openai"),
				now,
			);
		if (okKeys.length)
			return { id, state: "key", label: "Your keys", detail: keyNames(okKeys.map(key => key.provider)), action: null };
	} else {
		// What the saved Pay with choice lets pay an item's turn: "Key only" never uses the plan, "Plan only" never the key.
		const rule = payWithFor(inputs.payWith ?? [], harness, "item", okKeys.length > 0);
		const usable = hostedCredentialsFrom(inputs).filter(one =>
			rule.payWith === "key" ? !one.plan : rule.payWith === "plan" ? one.plan : true,
		);
		const payer = hostedPayer(harness, undefined, usable);
		if (payer?.plan) {
			const plan = inputs.plans.plans.find(one => one.provider === payer.provider);
			const backup = rule.payWith === "plan-then-key" ? okKeys[0] : undefined;
			return withHealth(
				{
					id,
					state: "plan",
					label: PLAN_NAMES[payer.provider as PlanProvider],
					detail: backup ? `Key …${backup.last4} as backup` : (plan?.account ?? null),
					action: null,
				},
				plan,
				now,
			);
		}
		if (payer) {
			const key = okKeys.find(one => one.provider === payer.provider);
			return {
				id,
				state: "key",
				label: `${SOURCE_NAMES[payer.provider]} key`,
				detail: key ? `…${key.last4}` : null,
				action: null,
			};
		}
	}
	const failed = inputs.keys.find(key => !key.ok && ownKeys.includes(key.provider));
	if (failed)
		return {
			id,
			state: "bad",
			label: "Key check failed",
			detail: `${SOURCE_NAMES[failed.provider]} …${failed.last4}`,
			action: { kind: "key", provider: failed.provider },
		};
	return { id, state: "none", label: "Not connected", detail: null, action: connectAction(harness, inputs) };
}

/** How a machine's agent signs in there, in a few words. */
function machineMethodWords(entry: ReportedHarness): string | null {
	if (entry.machineMethod === "chatgpt") return "ChatGPT";
	if (entry.machineMethod === "api-key") return "its own API key";
	if (entry.machineProviders?.length) return entry.machineProviders.join(", ");
	return entry.id === "claude" ? "Claude account" : null;
}

/** An agent on a machine, from its runner's report: its own sign-in, the owner's key, or what to do there. */
export function machineCell(harness: HarnessId, machine: MachineSummary, hosted: ConnectionCell): ConnectionCell {
	const id = cellId(harness, machine.machineId);
	// Windlass on a machine runs on the same models as hosted: the ChatGPT sign-in or the account's keys.
	// A cell that follows Hosted leaves its connect to the Hosted cell beside it: one action per agent.
	if (harness === "windlass") return { ...hosted, id, detail: "Same as Hosted", action: null };
	const entry = machine.harnesses?.find(one => one.id === harness);
	if (!entry) return { id, state: "absent", label: "Not on this machine", detail: null, action: { kind: "machines" } };
	const ownLogin = machineHarness(harness)?.ownMachineLogin === true;
	// No login of its own there: Pay with decides as hosted (agent-session.ts `machinePaysWith`). A login kept on the
	// machine wins for that machine.
	if (entry.paysWith)
		return {
			...hosted,
			id,
			detail: hosted.state === "none" ? null : "Same as Hosted",
			action: null,
			...(ownLogin && { ownLogin: { state: "offered" as const, machineId: machine.machineId } }),
		};
	if (ownLogin && entry.signIn === "token")
		return {
			id,
			state: "machine",
			label: "This machine's own login",
			detail: "Stays on this machine",
			action: null,
			ownLogin: { state: "kept", machineId: machine.machineId },
		};
	if (entry.signIn === "none")
		return { id, state: "none", label: "Sign in needed", detail: null, action: { kind: "machines" } };
	if (entry.signIn === "unknown")
		return {
			id,
			state: "unknown",
			label: "Couldn't check",
			detail: entry.signInReason ?? null,
			action: { kind: "machines" },
		};
	if (entry.platformKeys?.length && !entry.machineSignIns?.length)
		return { id, state: "key", label: "Your key", detail: keyNames(entry.platformKeys), action: null };
	return { id, state: "machine", label: "Own sign-in", detail: machineMethodWords(entry), action: null };
}

/** What the Hosted cell says when nothing on Windlass pays for the agent but a login is kept on one of the machines. */
export const HOSTED_NEEDS_WINDLASS = (harness: HarnessId) =>
	`Hosted ${machineHarness(harness)?.name ?? harness} needs your plan or a key on Windlass.`;

/**
 * The Hosted cell beside machines: where nothing on Windlass pays for an agent (no plan, no key) while a login of its
 * own is kept on one of the machines, it says plainly that the machine's login does not serve Hosted.
 */
export function withMachineLoginNote(
	cell: ConnectionCell,
	harness: HarnessId,
	machines: readonly MachineSummary[],
): ConnectionCell {
	if (cell.state !== "none" || !machineHarness(harness)?.ownMachineLogin) return cell;
	const kept = machines.some(machine => machineCell(harness, machine, cell).ownLogin?.state === "kept");
	return kept ? { ...cell, detail: HOSTED_NEEDS_WINDLASS(harness) } : cell;
}

/** Whether any agent can run anywhere yet: a plan, a checked key, the ChatGPT sign-in, or a machine's signed-in agent. */
export function anyAgentConnected(inputs: ConnectionInputs, machines: readonly MachineSummary[]): boolean {
	return (
		inputs.chatgpt ||
		hostedCredentialsFrom(inputs).length > 0 ||
		machines.some(machine => machine.harnesses?.some(entry => entry.signIn === "token"))
	);
}
