/**
 * What will run, in words, from the server's resolver (server/src/factory/resolve-run.ts): the web app
 * never layers settings itself. It hands the resolver the layers it holds (account, repository, the
 * item's own choices) and says the result and where each part of it comes from.
 */
import {
	machineLabel,
	type AccountDefaults,
	type HostedSizeOption,
	type MachineSummary,
	type ModelList,
	type RepositoryDefaults,
} from "@contract";
import {
	deploymentSize,
	resolveRun,
	type ResolvedRun,
	type RunRole,
	type RunSettings,
} from "../../../server/src/factory/resolve-run";
import { HARNESS_NAMES } from "./acp";
import { cleanModelName } from "./models";
import { usesAccountModels } from "../../../server/src/sandbox/harnesses.js";

export type RunSource = ResolvedRun["sources"]["place"];
const ORDER: RunSource[] = ["deployment", "account", "repository", "item"];

export function runOf(
	layers: {
		account?: AccountDefaults | null;
		repository?: RepositoryDefaults | null;
		item?: RunSettings;
		sizes?: readonly HostedSizeOption[];
	},
	role: RunRole = "builder",
): ResolvedRun {
	const sizes = layers.sizes?.map(size => size.id) ?? [];
	return resolveRun(
		{
			deployment: sizes.length ? { hostedSize: deploymentSize(sizes) } : {},
			account: layers.account ?? undefined,
			repository: layers.repository ?? undefined,
			item: layers.item,
		},
		role,
	);
}

/** The strongest source among some of the run's parts: an item's choice over a repository's over yours. */
export function sourceOf(
	run: Pick<ResolvedRun, "sources">,
	keys: readonly (keyof ResolvedRun["sources"])[],
): RunSource {
	return keys
		.map(key => run.sources[key])
		.reduce((a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a), "deployment");
}

export const SOURCE_WORDS: Record<RunSource, string> = {
	deployment: "the default",
	account: "your default",
	repository: "set for this repository",
	item: "chosen for this item",
};

export function placeName(place: ResolvedRun["place"], machines: readonly MachineSummary[] | null): string {
	if (place === "hosted") return "Hosted";
	if (place === "any-machine") return "Any of your machines";
	const machine = machines?.find(m => m.machineId === place.machine);
	return machine ? machineLabel(machine) : machines ? "A removed machine" : "Your machine";
}

/** The model's name; an unset one is the agent's own default. */
export function runModelName(run: Pick<ResolvedRun, "agent" | "model">, list: ModelList | null): string {
	const id = run.model ?? (usesAccountModels(run.agent) ? list?.defaultModel : null);
	if (!id) return "its default model";
	return cleanModelName(id, usesAccountModels(run.agent) ? null : (list?.models.find(m => m.id === id)?.name ?? null));
}

/** "mac · Codex · Astra · high". */
export function runWords(
	run: ResolvedRun,
	machines: readonly MachineSummary[] | null,
	list: ModelList | null,
	parts: { place?: boolean } = {},
): string {
	return [
		parts.place === false ? null : placeName(run.place, machines),
		HARNESS_NAMES[run.agent],
		runModelName(run, list),
		run.effort,
	]
		.filter(Boolean)
		.join(" · ");
}

/** Who pays for a machine agent's turns, in a few words; null for Windlass's own models. */
export function payerWords(run: Pick<ResolvedRun, "agent" | "payer" | "place">): string | null {
	if (run.payer === "unconfirmed") return "payer needs confirmation";
	if (run.agent === "windlass" && run.payer === "windlass") return null;
	return run.payer === "machine" ? "its own sign-in" : "your key";
}
