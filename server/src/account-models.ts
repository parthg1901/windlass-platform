/**
 * The models a user may choose, and the reasoning efforts each accepts (docs/architecture.md, "Models").
 *
 * Whose they are. The user's: what their ChatGPT plan offers. Windlass lists them with an access token
 * of the user's sign-in (`windlass --models --json`, signin/commands.ts), and the user's `user` actor
 * is where that is asked and where the answer is kept, in one row, so every server serves the same
 * list and none keeps one of its own.
 *
 * When Windlass is asked. When somebody asks for the list and the one that is kept is older than
 * `MODELS_FRESH_MS`, or there is none: never on a schedule, and never for a user who asks nothing.
 * Whoever asks while a listing runs waits for that one. Nobody waits longer than `MODELS_WAIT_MS`:
 * past that the answer is made from what is kept, and the listing goes on and is stored for the next
 * one who asks. A listing that failed is not tried again for `MODELS_RETRY_MS`.
 *
 * What is answered without the plan's list: the list that was kept, however old, while a listing
 * fails; and where none is kept, the platform's stand-in (`STAND_IN_MODELS`). `ModelList.source` says
 * which it is.
 *
 * Which sign-in a list belongs to. The row holds the generation of the sign-in it was listed with
 * (signin/holder.ts gives a new one each time a user's sign-in is adopted or forgotten), and a row is the
 * user's list only while that is the generation of their sign-in. So a list does not outlive its
 * sign-in: after a sign-out there is none, and after a new sign-in the plan is listed again. A listing
 * that ends after its sign-in was replaced or forgotten is nobody's: it is neither stored nor answered.
 *
 * This file has no actor in it: the `user` actor hands it its database and the two things it asks of
 * the sign-in, and scripts/models-check.ts runs it against a database of its own.
 */

import { windlassProvider } from "./sandbox/harnesses.js";
import type { ModelChoice, ModelList } from "./contract.js";
import { errorText } from "./util.js";

/** What Windlass listed for an account: its models, and the one a session starts on when none is named. */
export interface ListedModels {
	models: ModelChoice[];
	defaultModel: string;
}

// The Responses endpoint validates reasoning.effort against this enum. Windlass's
// account listing can advertise additional levels that the endpoint rejects.
const RESPONSES_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function responsesModels(listed: ListedModels): ListedModels {
	return {
		...listed,
		models: listed.models.map(model => ({
			...model,
			efforts: model.efforts.filter(effort => RESPONSES_EFFORTS.has(effort)),
		})),
	};
}

/** The efforts the stand-in's models are offered with: the ones `windlass --effort` knows (Windlass's user guide, "Models and effort"). */
const STAND_IN_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * The platform's stand-in for a plan's models, Windlass's own default first. It is what is offered
 * where no plan's list is to be had: to the demo, whose scripted model answers under any name; to a
 * user without a ChatGPT sign-in; and while a plan's list could not be read and none is kept. It is
 * not a list of record: a plan may lack a model named here, and Windlass says so when a turn starts.
 */
export const STAND_IN_MODELS: readonly ModelChoice[] = ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"].map(id => ({
	id,
	name: null,
	efforts: STAND_IN_EFFORTS,
}));

export function standInModels(source: Exclude<ModelList["source"], "account" | "harness">): ModelList {
	return {
		source,
		models: STAND_IN_MODELS.map(model => ({ ...model, efforts: [...model.efforts] })),
		defaultModel: STAND_IN_MODELS[0]!.id,
		fetchedAt: null,
	};
}

/** How long a plan's list is served before Windlass is asked again. */
export const MODELS_FRESH_MS = 60 * 60 * 1000;
/** How long whoever asks waits for a listing: a page never hangs on ChatGPT. */
export const MODELS_WAIT_MS = 5_000;
/** How long after a listing that failed the next one is not tried. */
export const MODELS_RETRY_MS = 60_000;

/** One row at most: the list, and the generation of the sign-in it was listed with. */
export const MODELS_TABLE = `
	CREATE TABLE IF NOT EXISTS model_list (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		generation TEXT NOT NULL,
		list TEXT NOT NULL,
		fetched_at INTEGER NOT NULL
	)
`;

/** The part of the actor's database this uses. */
export interface ModelsDb {
	execute<Row extends Record<string, unknown> = Record<string, unknown>>(
		query: string,
		...args: unknown[]
	): Promise<Row[]>;
}

/** What a request for the list brings with it: the action that asks has them, and a listing uses those of the request that started it. */
export interface ModelsSource {
	db: ModelsDb;
	/** The generation of the user's sign-in; null when there is none. */
	generation(): Promise<string | null>;
	/** Has Windlass list the models with the user's access token. Rejects when the token or the list cannot be had; no message of it holds a token. */
	list(): Promise<ListedModels>;
}

export interface AccountModelsOptions {
	uid: string;
	/** Where `[wlp] models.listed` and `models.list_failed` go. Default the console. */
	log?: (line: string) => void;
	/** In place of the three durations above, for the checks. */
	freshMs?: number;
	waitMs?: number;
	retryMs?: number;
}

/** A list as it is kept, with the generation of the sign-in it was listed with. */
interface Kept {
	generation: string;
	list: ModelList;
}

/** One user's models: the `user` actor has one of these over its own storage. */
export class AccountModels {
	private readonly log: (line: string) => void;
	private readonly freshMs: number;
	private readonly waitMs: number;
	private readonly retryMs: number;
	/** The newest list this actor stored or read; the row holds the same. */
	private kept: Kept | null = null;
	/** The listing that runs now. Never rejects: null when it failed, or its sign-in is no longer the user's. */
	private flight: { generation: string; listed: Promise<ModelList | null> } | null = null;
	private failed: { generation: string; at: number } | null = null;

	constructor(private readonly options: AccountModelsOptions) {
		this.log = options.log ?? (line => console.log(line));
		this.freshMs = options.freshMs ?? MODELS_FRESH_MS;
		this.waitMs = options.waitMs ?? MODELS_WAIT_MS;
		this.retryMs = options.retryMs ?? MODELS_RETRY_MS;
	}

	/** The user's models as they can be said now. Never rejects for a list that could not be read. */
	async current(source: ModelsSource): Promise<ModelList> {
		const generation = await source.generation();
		if (generation === null) return standInModels("signed-out");
		if (this.kept?.generation !== generation) {
			const stored = await this.read(source.db, generation);
			// A listing that ended meanwhile has the newer one.
			if (this.kept?.generation !== generation) this.kept = stored === null ? null : { generation, list: stored };
		}
		// From here to the listing nothing is awaited: of all who ask at once, one starts it and the others find it.
		const kept = this.kept?.generation === generation ? this.kept.list : null;
		const now = Date.now();
		if (kept !== null && kept.fetchedAt !== null && now - kept.fetchedAt < this.freshMs) return kept;
		const fallback = kept ?? standInModels("unavailable");
		if (this.failed !== null && this.failed.generation === generation && now - this.failed.at < this.retryMs)
			return fallback;
		if (this.flight === null || this.flight.generation !== generation) {
			const listed = this.fetch(source, generation).finally(() => {
				if (this.flight?.generation === generation) this.flight = null;
			});
			this.flight = { generation, listed };
		}
		const listed = await within(this.flight.listed, this.waitMs);
		if (listed !== null) return listed;
		// Nothing new. What is kept is answered only while its sign-in is still the user's.
		return (await source.generation()) === generation ? fallback : this.current(source);
	}

	/** The sign-in was forgotten: its list goes with it. (A list of an earlier sign-in is not served even where this did not run.) */
	async forget(db: ModelsDb): Promise<void> {
		this.kept = null;
		this.failed = null;
		await db.execute("DELETE FROM model_list");
	}

	private async read(db: ModelsDb, generation: string): Promise<ModelList | null> {
		const [row] = await db.execute<{ list: string; fetched_at: number }>(
			"SELECT list, fetched_at FROM model_list WHERE id = 1 AND generation = ?",
			generation,
		);
		if (!row) return null;
		try {
			const listed = responsesModels(JSON.parse(row.list) as ListedModels);
			return { source: "account", models: listed.models, defaultModel: listed.defaultModel, fetchedAt: row.fetched_at };
		} catch {
			return null;
		}
	}

	/** Lists, stores, and only then answers. Null when the list could not be had or stored. */
	private async fetch(source: ModelsSource, generation: string): Promise<ModelList | null> {
		try {
			const listed = responsesModels(await source.list());
			// The sign-in was replaced or forgotten while Windlass was asked: this is nobody's list.
			if ((await source.generation()) !== generation) return null;
			const list: ModelList = {
				source: "account",
				models: listed.models,
				defaultModel: listed.defaultModel,
				fetchedAt: Date.now(),
			};
			// A row is read back only at its own generation, so one a later sign-in's listing replaces is never served for it.
			await source.db.execute(
				"INSERT INTO model_list (id, generation, list, fetched_at) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET generation = excluded.generation, list = excluded.list, fetched_at = excluded.fetched_at",
				generation,
				JSON.stringify(listed),
				list.fetchedAt,
			);
			this.kept = { generation, list };
			if (this.failed?.generation === generation) this.failed = null;
			this.log(
				`[wlp] models.listed uid=${this.options.uid}: ${list.models.length} models, the default ${list.defaultModel}`,
			);
			return list;
		} catch (error) {
			this.failed = { generation, at: Date.now() };
			this.log(
				`[wlp] models.list_failed uid=${this.options.uid}: ${errorText(error)}; the ${this.kept?.generation === generation ? "list kept from before" : "stand-in"} is served, and Windlass is asked again in ${Math.round(this.retryMs / 1000)} s at the earliest`,
			);
			return null;
		}
	}
}

/** `work`'s answer, or null when it takes longer than `ms`. `work` must not reject. */
function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
	return new Promise(resolve => {
		const timer = setTimeout(() => resolve(null), ms);
		void work.then(value => {
			clearTimeout(timer);
			resolve(value);
		});
	});
}

// ---------------------------------------------------------------------------------------------
// Checking a choice against a list
// ---------------------------------------------------------------------------------------------

/** Thrown for a model or an effort that cannot be used; `message` is fit to show, `code` is the UserError's. */
export class ModelProblem extends Error {
	constructor(
		readonly code: "bad_model" | "bad_effort",
		message: string,
	) {
		super(message);
		this.name = "ModelProblem";
	}
}

/** Why a model that was named cannot be used, in a sentence that says whose list it is not in; null when the list has it. */
export function modelRefusal(list: ModelList, named: unknown): string | null {
	if (typeof named === "string" && list.models.some(model => model.id === named)) return null;
	const provider = typeof named === "string" && windlassProvider(named);
	if (provider && list.source !== "harness")
		return `That model is not in your checked ${provider} models. Add or check the ${provider} key in Settings.`;
	const names = list.models.map(model => model.id).join(", ");
	return list.source === "account"
		? `That model is not among the ones your ChatGPT plan offers. Choose one of: ${names}`
		: `That model is not offered. Choose one of: ${names}`;
}

/** The model a session is made with or a turn switches to: the one that was asked for when the list has it, the list's default when none was. */
export function chosenModel(list: ModelList, asked: unknown): string {
	if (asked === undefined || asked === null || asked === "") return list.defaultModel;
	const refusal = modelRefusal(list, asked);
	if (refusal !== null) throw new ModelProblem("bad_model", refusal);
	return asked as string;
}

/**
 * A work item's effort, held against what its agent reported. A machine harness reports a model's
 * efforts only once it is selected, so for such a model with none listed, any effort the agent reported
 * for one of its models is taken; the turn says so where the model then runs at its default instead.
 */
export function checkItemEffort(list: ModelList, model: string, effort: unknown, harness: boolean): void {
	const listed = list.models.find(candidate => candidate.id === model)?.efforts ?? [];
	if (harness && listed.length === 0 && model !== list.defaultModel) {
		const any = [...new Set(list.models.flatMap(candidate => candidate.efforts))];
		if (typeof effort === "string" && any.includes(effort)) return;
		throw new ModelProblem(
			"bad_effort",
			any.length === 0
				? `${model} takes no reasoning effort. Leave the effort at its default.`
				: `The effort must be one of: ${any.join(", ")}`,
		);
	}
	if (listed.length === 0)
		throw new ModelProblem("bad_effort", `${model} takes no reasoning effort. Leave the effort at its default.`);
	checkEffort(list, model, effort);
}

/** Whether `model` accepts `effort`; a model the list does not have is taken to. */
function takesEffort(list: ModelList, model: string, effort: unknown): boolean {
	const efforts = list.models.find(candidate => candidate.id === model)?.efforts;
	return typeof effort === "string" && (efforts === undefined || efforts.includes(effort));
}

/**
 * The effort a turn runs at. `asked` is its prompt's: absent keeps `kept`, the session's, and null or "" is the
 * model's default. Held against `model` where `list` is given: a named effort the model does not take is refused,
 * a kept one gives way to the default.
 */
export function turnEffort(asked: unknown, kept: string | null, model: string, list: ModelList | null): string | null {
	if (asked === undefined) return kept !== null && list && !takesEffort(list, model, kept) ? null : kept;
	if (asked === null || asked === "") return null;
	if (list) checkEffort(list, model, asked);
	return asked as string;
}

/** Holds an effort against the ones `model` accepts. A model the list does not have is Windlass's to refuse: the list says nothing of it. */
export function checkEffort(list: ModelList, model: string, effort: unknown): void {
	if (takesEffort(list, model, effort)) return;
	const efforts = list.models.find(candidate => candidate.id === model)?.efforts;
	throw new ModelProblem(
		"bad_effort",
		efforts === undefined || efforts.length === 0
			? `${model} takes no reasoning effort. Leave the effort at its default.`
			: `The effort for ${model} must be one of: ${efforts.join(", ")}`,
	);
}
