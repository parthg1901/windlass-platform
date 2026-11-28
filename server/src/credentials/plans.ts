/**
 * A user's connected subscription plans, one row each in `model_plan`.
 *
 *   anthropic  the long-lived token `claude setup-token` prints, sealed here (`model-plan`). It never leaves the
 *              platform but for a turn's relay: hosted Claude Code gets a placeholder (credentials/index.ts).
 *   openai     the user's ChatGPT sign-in: Windlass's sign-in files, sealed and refreshed only by the user actor's
 *              `SignInHolder` (signin/holder.ts, actors/user/signin.ts), which owns `sealed` and `short_noted`.
 *              Nothing here opens it; whoever needs it asks the holder for an access token.
 *
 * `generation` changes when a plan is connected, reconnected or removed, never when its token is refreshed: a
 * turn pins it. A lease of an older one on the platform's relay ends at its next request; a turn's relay in a sandbox
 * or on a machine is closed at its next look at the plan, within a minute (`rotatePlanToken`). `models` is what the plan offers,
 * as its provider lists it (ChatGPT) or its agent reported it (Claude Code); none until then.
 */

import { randomUUID } from "node:crypto";
import { UserError } from "rivetkit";
import { config } from "../config.js";
import { isPlanProvider, validPlanToken, type ModelPlanStatus, type PlanProvider } from "../contract.js";
import type { DefaultsDb } from "../repository-defaults.js";
import { serverSealer } from "../signin/seal.js";
import { safeModelId } from "./keys.js";
import { HEALTHY, healthAt, nextHealth, type PlanHealthState, type PlanReading } from "./plan-health.js";

export const MODEL_PLAN_TABLES = [
	`CREATE TABLE IF NOT EXISTS model_plan (
		provider TEXT PRIMARY KEY, sealed TEXT NOT NULL, generation TEXT NOT NULL, account TEXT,
		added_at INTEGER NOT NULL, checked_at INTEGER, check_ok INTEGER NOT NULL DEFAULT 0,
		models TEXT, short_noted INTEGER NOT NULL DEFAULT 0, health TEXT
	)`,
];

/** Columns a table made before them lacks: the user actor adds them. */
export const MODEL_PLAN_COLUMNS = [
	["model_plan", "models", "TEXT"],
	["model_plan", "short_noted", "INTEGER NOT NULL DEFAULT 0"],
	["model_plan", "health", "TEXT"],
] as const;

type PlanRow = {
	provider: PlanProvider;
	account: string | null;
	added_at: number;
	checked_at: number | null;
	check_ok: number;
	models: string | null;
	health: string | null;
};
const STATUS_COLUMNS = "provider, account, added_at, checked_at, check_ok, models, health";

/** The plan's health as stored (`health`, a JSON `PlanHealthState`); a row without one is healthy. */
function storedHealth(raw: string | null): PlanHealthState {
	if (raw === null) return HEALTHY;
	try {
		return { ...HEALTHY, ...(JSON.parse(raw) as Partial<PlanHealthState>) };
	} catch {
		return HEALTHY;
	}
}

const status = (row: PlanRow, now = Date.now()): ModelPlanStatus => {
	const health = storedHealth(row.health);
	const current = healthAt(health, now);
	return {
		provider: row.provider,
		account: row.account,
		addedAt: row.added_at,
		checkedAt: row.checked_at,
		ok: !!row.check_ok,
		...(row.models !== null && { models: JSON.parse(row.models) as string[] }),
		health: current,
		limitedUntil: current === "limited" ? health.limitedUntil : null,
		resetKnown: current === "limited" && health.resetKnown,
		windows: health.windows,
		healthAt: health.healthAt,
	};
};

const subject = (uid: string, provider: PlanProvider) => JSON.stringify([uid, provider]);

/** Whether this user may connect plans and run turns on them (WLP_PLAN_USERS). Windlass's own ChatGPT sign-in is not gated. */
export function plansAllowed(uid: string): boolean {
	return config.plans === "all" || config.plans.has(uid);
}

/**
 * Whether this user's turns may pay with `provider`'s plan: `WLP_PLAN_USERS`, except the ChatGPT sign-in on the user's
 * own machine (`onMachine`), whose requests leave from that machine, as Windlass's there always have.
 */
export function planAllowed(uid: string, provider: PlanProvider, onMachine = false): boolean {
	return plansAllowed(uid) || (onMachine && provider === "openai");
}

export function planProviderOf(raw: unknown): PlanProvider {
	if (!isPlanProvider(raw)) throw new UserError("Unknown plan.", { code: "bad_provider" });
	return raw;
}

/** The most models a plan keeps. */
const MAX_PLAN_MODELS = 32;

/** Where a plan's models come from: the provider's own catalog, or what its agent reports at a session's start. */
const MODELS_FROM: Record<PlanProvider, "provider" | "agent"> = { anthropic: "agent", openai: "provider" };

/**
 * Asks Anthropic whether it takes the token, with the cheapest call a setup token may make: listing models. A
 * setup token has only the `user:inference` scope, so the profile (whose account it is) is closed to it. False
 * when Anthropic refused it; throws when Anthropic could not be asked.
 */
async function claudeAccepts(token: string): Promise<boolean> {
	const origin = (process.env.WLP_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");
	const res = await fetch(origin + "/v1/models?limit=1", {
		headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01" },
		redirect: "error",
		signal: AbortSignal.timeout(8_000),
	});
	await res.body?.cancel();
	if (res.status === 401 || res.status === 403) return false;
	if (!res.ok) throw new Error("Plan check unavailable");
	return true;
}

export class PlanProblem extends Error {
	constructor(
		message: string,
		readonly code: "bad_plan_token" | "bad_sign_in" | "plan_refused" | "plan_check_unavailable" | "plans_off",
	) {
		super(message);
	}
}

/** Checks a plan token with its provider and saves it under a new generation, ending every lease of the old one. */
export async function connectPlan(
	db: DefaultsDb,
	uid: string,
	provider: PlanProvider,
	token: unknown,
): Promise<ModelPlanStatus> {
	if (!plansAllowed(uid)) throw new PlanProblem("Connecting a plan is not available on this account.", "plans_off");
	if (provider !== "anthropic" || !validPlanToken(provider, token))
		throw new PlanProblem("That's not a setup token. It starts with sk-ant-oat01-.", "bad_plan_token");
	let accepted: boolean;
	try {
		accepted = await claudeAccepts(token);
	} catch {
		throw new PlanProblem("Anthropic could not be reached to check the plan. Try again.", "plan_check_unavailable");
	}
	if (!accepted)
		throw new PlanProblem("Anthropic did not accept that token. Run claude setup-token again.", "plan_refused");
	const now = Date.now();
	const [row] = await db.execute<PlanRow>(
		`INSERT INTO model_plan (provider, sealed, generation, account, added_at, checked_at, check_ok, models)
		VALUES (?, ?, ?, ?, ?, ?, 1, NULL)
		ON CONFLICT(provider) DO UPDATE SET sealed=excluded.sealed, generation=excluded.generation, account=excluded.account,
		added_at=excluded.added_at, checked_at=excluded.checked_at, check_ok=1, models=NULL, health=NULL RETURNING ${STATUS_COLUMNS}`,
		provider,
		serverSealer().seal("model-plan", subject(uid, provider), token),
		randomUUID(),
		null,
		now,
		now,
	);
	return status(row!);
}

/** Asks Anthropic again whether it takes the saved Claude plan's token: one it no longer accepts makes the plan unusable. */
export async function claudePlanCheck(db: DefaultsDb, uid: string): Promise<void> {
	// Whatever the last check said: a token Anthropic refused once may be accepted again.
	const saved = await savedPlan(db, uid, "anthropic", false);
	if (!saved) return;
	let accepted: boolean;
	try {
		accepted = await claudeAccepts(saved.secret);
	} catch {
		throw new PlanProblem("Anthropic could not be reached to check the plan. Try again.", "plan_check_unavailable");
	}
	await db.execute(
		"UPDATE model_plan SET check_ok = ? WHERE provider = 'anthropic' AND generation = ?",
		accepted ? 1 : 0,
		saved.generation,
	);
}

export async function planStatuses(db: DefaultsDb): Promise<ModelPlanStatus[]> {
	return (await db.execute<PlanRow>(`SELECT ${STATUS_COLUMNS} FROM model_plan ORDER BY provider`)).map(status);
}

/**
 * Applies what a relay or a turn saw of the plan (plan-health.ts) while it is still at `generation`: a reading of an
 * older connection is not this one's. Answers the plan's status after it, or null when nothing was kept.
 */
export async function observePlan(
	db: DefaultsDb,
	provider: PlanProvider,
	generation: string,
	reading: PlanReading,
): Promise<ModelPlanStatus | null> {
	const [row] = await db.execute<PlanRow>(
		`SELECT ${STATUS_COLUMNS} FROM model_plan WHERE provider = ? AND generation = ?`,
		provider,
		generation,
	);
	if (!row) return null;
	const before = storedHealth(row.health);
	const after = nextHealth(before, reading);
	const health = JSON.stringify(after);
	if (health === row.health) return status(row);
	await db.execute(
		"UPDATE model_plan SET health = ? WHERE provider = ? AND generation = ?",
		health,
		provider,
		generation,
	);
	if (before.health !== after.health)
		console.info(
			`[wlp] plan.health provider=${provider} ${before.health}->${after.health}${after.limitedUntil ? ` until=${new Date(after.limitedUntil).toISOString()}${after.resetKnown ? "" : " (probe)"}` : ""}`,
		);
	return status({ ...row, health });
}

/** The usable plan's status with its generation, for Pay with at a turn's start; null when none is usable or plans are off. */
export async function usablePlan(
	db: DefaultsDb,
	uid: string,
	provider: PlanProvider,
	onMachine = false,
): Promise<(ModelPlanStatus & { generation: string }) | null> {
	if (!planAllowed(uid, provider, onMachine)) return null;
	const [row] = await db.execute<PlanRow & { generation: string }>(
		`SELECT ${STATUS_COLUMNS}, generation FROM model_plan WHERE provider = ? AND check_ok = 1`,
		provider,
	);
	return row ? { ...status(row), generation: row.generation } : null;
}

/** Removes a token plan. A ChatGPT plan is removed by forgetting the sign-in (`SignInHolder.logout`). */
export async function removePlan(db: DefaultsDb, provider: Exclude<PlanProvider, "openai">): Promise<void> {
	await db.execute("DELETE FROM model_plan WHERE provider = ?", provider);
}

/** The usable plan's generation: a turn pins it without opening the token. Null while plans are off for the user. */
export async function planGeneration(
	db: DefaultsDb,
	uid: string,
	provider: PlanProvider,
	onMachine = false,
): Promise<string | null> {
	if (!planAllowed(uid, provider, onMachine)) return null;
	const [row] = await db.execute<{ generation: string }>(
		"SELECT generation FROM model_plan WHERE provider = ? AND check_ok=1",
		provider,
	);
	return row?.generation ?? null;
}

/**
 * A token plan's token and generation, resealed under the current key when it was sealed with an older one. A
 * ChatGPT plan has no token to open here: its access token comes from the user's sign-in holder. `usable`: only one
 * whose last check passed.
 */
export async function savedPlan(db: DefaultsDb, uid: string, provider: PlanProvider, usable = true) {
	if (provider === "openai") throw new Error("A ChatGPT plan's access token comes from the sign-in holder");
	if (!plansAllowed(uid)) return null;
	const [row] = await db.execute<{ sealed: string; generation: string }>(
		"SELECT sealed, generation FROM model_plan WHERE provider = ? AND (check_ok = 1 OR ?)",
		provider,
		usable ? 0 : 1,
	);
	if (!row) return null;
	const sealer = serverSealer();
	const owner = subject(uid, provider);
	const token = sealer.open("model-plan", owner, row.sealed);
	if (!sealer.isCurrent(row.sealed)) {
		await db.execute(
			"UPDATE model_plan SET sealed = ? WHERE provider = ? AND sealed = ?",
			sealer.seal("model-plan", owner, token),
			provider,
			row.sealed,
		);
	}
	return { secret: token, generation: row.generation };
}

/** The ids among `ids` a plan may keep: model-id shaped, none holding a piece of `secret`, at most `MAX_PLAN_MODELS`. */
function planModelIds(ids: readonly unknown[], secret = ""): string[] {
	const kept = new Set<string>();
	for (const id of ids) {
		if (kept.size === MAX_PLAN_MODELS) break;
		if (safeModelId(id, secret)) kept.add(id);
	}
	return [...kept];
}

/**
 * Keeps the models a plan's agent reported at a session's start, for a plan whose provider lists none (Claude Code
 * on a Claude plan). Only while the plan is still at `generation`: a list from a turn of an older connection is not
 * this one's. False when nothing was kept.
 */
export async function recordAgentModels(
	db: DefaultsDb,
	provider: PlanProvider,
	generation: string,
	ids: readonly unknown[],
): Promise<boolean> {
	if (MODELS_FROM[provider] !== "agent") return false;
	const models = planModelIds(ids.filter(id => id !== "default"));
	if (!models.length) return false;
	const kept = await db.execute(
		"UPDATE model_plan SET models = ?, checked_at = ? WHERE provider = ? AND generation = ? AND check_ok = 1 RETURNING provider",
		JSON.stringify(models),
		Date.now(),
		provider,
		generation,
	);
	return kept.length > 0;
}

/**
 * The models of ChatGPT's catalog (`GET /v1/models` with a ChatGPT access token answers `{models: [{slug,
 * visibility, ...}]}`) that it lists for people to pick, in its order. A slug that holds a piece of the token is
 * left out: an answer may echo it.
 */
export function chatgptCatalogModels(body: unknown, token: string): string[] {
	const models = (body as { models?: unknown } | null)?.models;
	if (!Array.isArray(models)) return [];
	const listed = models.filter(
		(m): m is { slug: unknown } =>
			!!m && typeof m === "object" && (m as { visibility?: unknown }).visibility === "list",
	);
	return planModelIds(
		listed.map(m => m.slug),
		token,
	);
}

/** Asks OpenAI which models the ChatGPT plan of `token` offers. Throws when it could not be asked or did not answer. */
export async function chatgptPlanModels(token: string): Promise<string[]> {
	const origin = (process.env.WLP_OPENAI_BASE_URL ?? "https://api.openai.com").replace(/\/+$/, "");
	const res = await fetch(origin + "/v1/models", {
		headers: { authorization: `Bearer ${token}`, accept: "application/json" },
		redirect: "error",
		signal: AbortSignal.timeout(8_000),
	});
	if (!res.ok) {
		await res.body?.cancel();
		throw new Error(`ChatGPT's model catalog answered ${res.status}`);
	}
	return chatgptCatalogModels(await res.json(), token);
}

/** Saves what a check of the ChatGPT plan learned, while the plan is still at `generation`. Null models: the catalog did not answer. */
export async function saveChatgptCheck(
	db: DefaultsDb,
	generation: string,
	found: { account: string | null; models: string[] | null },
): Promise<void> {
	if (found.models === null) {
		await db.execute(
			"UPDATE model_plan SET account = ? WHERE provider = 'openai' AND generation = ?",
			found.account,
			generation,
		);
		return;
	}
	await db.execute(
		"UPDATE model_plan SET account = ?, models = ?, checked_at = ? WHERE provider = 'openai' AND generation = ?",
		found.account,
		JSON.stringify(found.models),
		Date.now(),
		generation,
	);
}

/** The ChatGPT plan's row as the sign-in holder keeps it (`StoredSignIn`); null when there is none. */
export async function loadChatgptSignIn(db: DefaultsDb) {
	const [row] = await db.execute<{ sealed: string; generation: string; short_noted: number }>(
		"SELECT sealed, generation, short_noted FROM model_plan WHERE provider = 'openai'",
	);
	return row ? { sealed: row.sealed, generation: row.generation, shortNoted: row.short_noted === 1 } : null;
}

/**
 * Writes the holder's sign-in as the ChatGPT plan. No sign-in removes the plan. Another generation is a new
 * connection: what was learned about the old one (account, models) goes. The same generation is a refresh or a
 * reseal: only the sealed sign-in and its note change.
 */
export async function writeChatgptSignIn(
	db: DefaultsDb,
	row: { sealed: string | null; generation: string; shortNoted: boolean },
): Promise<void> {
	if (row.sealed === null) {
		await db.execute("DELETE FROM model_plan WHERE provider = 'openai'");
		return;
	}
	const now = Date.now();
	const same = "model_plan.generation = excluded.generation";
	await db.execute(
		`INSERT INTO model_plan (provider, sealed, generation, account, added_at, checked_at, check_ok, models, short_noted)
		VALUES ('openai', ?, ?, NULL, ?, ?, 1, NULL, ?)
		ON CONFLICT(provider) DO UPDATE SET sealed = excluded.sealed, short_noted = excluded.short_noted,
		generation = excluded.generation, check_ok = 1,
		account = CASE WHEN ${same} THEN model_plan.account END,
		models = CASE WHEN ${same} THEN model_plan.models END,
		health = CASE WHEN ${same} THEN model_plan.health END,
		added_at = CASE WHEN ${same} THEN model_plan.added_at ELSE excluded.added_at END,
		checked_at = CASE WHEN ${same} THEN model_plan.checked_at ELSE excluded.checked_at END`,
		row.sealed,
		row.generation,
		now,
		now,
		row.shortNoted ? 1 : 0,
	);
}

/**
 * The ChatGPT sign-in used to have a table of its own (`signin`); it is the ChatGPT plan now. A user actor copies
 * its row here once and drops the table. Its generation is kept, so usage recorded and models listed under it stay
 * the sign-in's. One-time: remove after the first deploy that runs it.
 */
export async function moveSignInToPlan(db: DefaultsDb): Promise<void> {
	const [legacy] = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'signin'");
	if (!legacy) return;
	await db.execute(
		`INSERT OR IGNORE INTO model_plan (provider, sealed, generation, account, added_at, checked_at, check_ok, short_noted)
		SELECT 'openai', sealed, CAST(generation AS TEXT), NULL, updated_at, updated_at, 1, short_noted
		FROM signin WHERE id = 1 AND sealed IS NOT NULL`,
	);
	await db.execute("DROP TABLE signin");
}
