import {
	MODEL_PROVIDERS,
	isModelProvider,
	type HarnessId,
	type MachineSummary,
	type ModelChoice,
	type ModelList,
	type ModelProvider,
	type SessionMode,
} from "@contract";
import {
	hostedCatalog,
	keyProviders,
	usesAccountModels,
	windlassProvider,
	type CheckedProvider,
} from "../../../server/src/sandbox/harnesses.js";
import type { ReportedHarness } from "./acp";
import { localTime } from "./format";

/** The ids of the list's models, in its order; none while the list is not known. */
export const modelIds = (list: ModelList | null): string[] => list?.models.map(model => model.id) ?? [];

/** The efforts a model accepts; none for a model that takes no effort, and for one the list does not have. */
export const effortsOf = (list: ModelList | null, model: string): string[] =>
	list?.models.find(candidate => candidate.id === model)?.efforts ?? [];

/** Use an adapter's explicit reset value when it offers one. Other models reset by omitting effort. */
export const effortChoices = (efforts: readonly string[]): string[] => [
	efforts.includes("default") ? "default" : "",
	...efforts.filter(level => level !== "default"),
];

/** Whose list it is, in a sentence, for under a field. */
export function modelsNote(list: ModelList): string {
	switch (list.source) {
		case "harness":
			return "The models offered by the session’s harness.";
		case "account":
			return `The models of your ChatGPT plan${list.fetchedAt === null ? "" : `, as read at ${localTime(list.fetchedAt)}`}.`;
		case "demo":
			return "The demo uses a scripted model for every choice.";
		case "signed-out":
			return "Connect ChatGPT to see your plan’s models.";
		case "unavailable":
			return "Your plan’s models could not be loaded. Some may be missing.";
	}
}

/** What a machine's runner may report of a harness's options beside it: read as optional, so that a runner that reports none, and a summary without the field, read as nothing. */
export interface ReportedOptions {
	models?: ModelChoice[];
	defaultModel?: string;
	modes?: SessionMode[];
	checkedAt?: number;
}

/**
 * Launch options come from the runner on a machine and the owner's checked provider keys when hosted.
 * Without a catalog the agent starts on its own default.
 */
export function harnessOptions(
	machine: MachineSummary | null,
	harness: HarnessId,
	catalog?: ReportedOptions,
	providers?: readonly CheckedProvider[] | null,
): { models: ModelList | null; modes: SessionMode[] | null } {
	if (usesAccountModels(harness)) return { models: null, modes: null };
	const entry = machine?.harnesses?.find(entry => entry.id === harness);
	const reported = machine ? (catalog ?? entry?.options) : hostedCatalog(harness, providers ?? []);
	const modes = reported?.modes && reported.modes.length > 0 ? reported.modes : null;
	const first = reported?.models?.[0];
	if (!reported?.models || first === undefined) return { models: null, modes };
	// The runner reports the adapter's own default; the first listed model stands in only when it names none it lists.
	const defaultModel = reported.models.some(model => model.id === reported.defaultModel)
		? (reported.defaultModel as string)
		: first.id;
	return {
		models: {
			source: "harness",
			models: reported.models,
			defaultModel,
			fetchedAt: entry?.optionsCheckedAt ?? reported.checkedAt ?? null,
		},
		modes,
	};
}

/** What a model is called on screen: the harness's name for it where it gave one, its id otherwise. */
export const modelName = (list: ModelList | null, id: string): string =>
	list?.models.find(model => model.id === id)?.name || id;

/** Whether a model's name says it is the default already, as Claude Code's "Default (recommended)" does: no second "default" is put beside it. */
export const saysDefault = (name: string): boolean => /\bdefault\b/i.test(name);

/** A model in a few words, its list's default marked: "Opus (default)", "Haiku". What a harness starts on when no model is sent is its default. */
export function modelLabel(list: ModelList | null, id: string, name = modelName(list, id)): string {
	return id === list?.defaultModel && !saysDefault(name) ? `${name} (default)` : name;
}

/** Who serves a model: a provider of Settings keys, a ChatGPT plan, OpenCode's own free models, or another OpenCode provider. */
export type ModelSource = ModelProvider | "chatgpt" | "opencode" | "other";

/** The order a picker lists them in. */
export const MODEL_SOURCES: readonly ModelSource[] = ["chatgpt", ...MODEL_PROVIDERS, "opencode", "other"];

export const SOURCE_NAMES: Record<ModelSource, string> = {
	chatgpt: "ChatGPT",
	openai: "OpenAI",
	anthropic: "Anthropic",
	google: "Gemini",
	openrouter: "OpenRouter",
	opencode: "OpenCode Zen",
	other: "Other",
};

/** Who serves a model an agent offers; null for an agent's own unnamed default. */
export function sourceOf(harness: HarnessId, id: string): ModelSource | null {
	if (usesAccountModels(harness)) return windlassProvider(id) ?? "chatgpt";
	// An agent on one provider's key: every model is that provider's.
	const providers = keyProviders(harness);
	if (providers.length === 1) return providers[0]!;
	if (id === "default") return null;
	const [provider] = id.split("/", 1);
	return provider === "opencode" || isModelProvider(provider) ? provider : "other";
}

export function modelsBySource(harness: HarnessId, list: ModelList | null) {
	const groups = new Map<ModelSource | null, ModelChoice[]>();
	for (const model of list?.models ?? []) {
		const source = sourceOf(harness, model.id);
		const group = groups.get(source);
		if (group) group.push(model);
		else groups.set(source, [model]);
	}
	return groups;
}

const UPPER = new Set(["oss", "gpt", "glm"]);

/** A model id in words: "anthropic/claude-haiku-5-5" is "Claude Haiku 5.5", "gpt-6.1-sol" "GPT-6.1 Sol". */
export function modelWords(id: string): string {
	const slug = (id.split("/").at(-1) ?? id).replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "");
	const parts: string[] = [];
	for (const part of slug.split("-")) {
		const last = parts.at(-1);
		if (/^\d+$/.test(part) && last !== undefined && /^\d+(\.\d+)?$/.test(last))
			parts[parts.length - 1] = `${last}.${part}`;
		else parts.push(part);
	}
	const words = parts.map(part =>
		UPPER.has(part) ? part.toUpperCase() : /^o\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1),
	);
	// "GPT-6.1", as OpenAI writes it.
	if (words[0] === "GPT" && words.length > 1) words.splice(0, 2, `GPT-${words[1]}`);
	return words.join(" ");
}

/** What a picker calls a model: the agent's own name for it where that is words, not an id. */
export function cleanModelName(id: string, reported?: string | null): string {
	if (reported && reported !== id) return reported.includes("/") ? (reported.split("/").at(-1) as string) : reported;
	return modelWords(id);
}

export function credentialWords(
	harness: HarnessId,
	source: ModelSource,
	entry: ReportedHarness | null,
	machine: string | null,
): string {
	if (source === "chatgpt") return "ChatGPT plan";
	if (source === "opencode")
		return entry?.machineProviders?.includes("free") ? "free" : machine ? `OpenCode Zen login · ${machine}` : "";
	if (source === "other") return entry && machine ? `login on ${machine}` : "";
	const key = `${SOURCE_NAMES[source]} key`;
	if (harness === "windlass" || !entry || !machine) return key;
	if (entry.platformKeys?.includes(source)) return key;
	// Paid with the account's plan or key (Connections → Pay with), as hosted.
	if (entry.paysWith) {
		if (entry.signIn === "none") return "not connected";
		return harness === "claude" ? "Claude plan" : "ChatGPT plan";
	}
	if (entry.id === "opencode" && !entry.machineProviders && !entry.keyRelay && entry.signIn === "token")
		return `login on ${machine}`;
	if (!entry.machineSignIns?.includes(source))
		return entry.signIn === "unknown" ? `sign-in unchecked · ${machine}` : "sign in needed";
	if (harness === "claude") return `Claude subscription · ${machine}`;
	const chatgpt = source === "openai" && entry.machineProviders?.includes("chatgpt");
	return chatgpt ? `ChatGPT plan · ${machine}` : `${SOURCE_NAMES[source]} login · ${machine}`;
}
