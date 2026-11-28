import { randomUUID } from "node:crypto";
import { UserError } from "rivetkit";
import { modelKeyCaller } from "../actors/internal.js";
import { requireServiceFor, requireUser } from "../auth.js";
import {
	MODEL_CHECKS_PER_MINUTE,
	isModelProvider,
	validModelKey,
	type ModelProvider,
	type ModelProviderCheck,
	type ModelProviderStatus,
} from "../contract.js";
import { MINUTE_MS } from "../http-limits.js";
import type { DefaultsDb } from "../repository-defaults.js";
import { serverSealer } from "../signin/seal.js";

export const MODEL_PROVIDER_TABLES = [
	`CREATE TABLE IF NOT EXISTS model_key_usage (day INTEGER NOT NULL, session TEXT NOT NULL, seq INTEGER NOT NULL,
		tokens INTEGER NOT NULL, provider TEXT NOT NULL, generation TEXT NOT NULL, PRIMARY KEY(day,session,seq))`,
	`CREATE TABLE IF NOT EXISTS model_provider (
		provider TEXT PRIMARY KEY, sealed TEXT NOT NULL, generation TEXT NOT NULL, last4 TEXT NOT NULL,
		added_at INTEGER NOT NULL, checked_at INTEGER, check_ok INTEGER NOT NULL DEFAULT 0, models TEXT, windlass_models TEXT
	)`,
	"CREATE TABLE IF NOT EXISTS model_check_budget (id INTEGER PRIMARY KEY CHECK (id = 1), minute INTEGER NOT NULL, used INTEGER NOT NULL)",
];

type Context = Parameters<typeof requireUser>[0] & { db: DefaultsDb };
type StatusRow = {
	provider: ModelProvider;
	last4: string;
	added_at: number;
	checked_at: number | null;
	check_ok: number;
	models: string | null;
	windlass_models: string | null;
};
const STATUS_COLUMNS = "provider, last4, added_at, checked_at, check_ok, models, windlass_models";

type ModelEntry = { id?: unknown; name?: string; supported_parameters?: unknown; supportedGenerationMethods?: unknown };
type ModelListBody = { data?: ModelEntry[]; models?: ModelEntry[] };

function offersWindlass(provider: ModelProvider, entry: ModelEntry, id: string) {
	if (provider === "openrouter")
		return Array.isArray(entry.supported_parameters) && entry.supported_parameters.includes("tools");
	return (
		/^models\/gemini-[^/]+$/.test(entry.name ?? "") &&
		!/-(tts|image|live|audio)(-|$)/.test(id) &&
		Array.isArray(entry.supportedGenerationMethods) &&
		entry.supportedGenerationMethods.includes("generateContent")
	);
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const PROVIDERS: Record<
	ModelProvider,
	{
		origin: string;
		path: string;
		headers(key: string): Record<string, string>;
	}
> = {
	openai: { origin: "https://api.openai.com", path: "/v1/models", headers: bearer },
	anthropic: {
		origin: "https://api.anthropic.com",
		path: "/v1/models",
		headers: key => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
	},
	google: {
		origin: "https://generativelanguage.googleapis.com",
		path: "/v1beta/models",
		headers: key => ({ "x-goog-api-key": key }),
	},
	openrouter: { origin: "https://openrouter.ai", path: "/api/v1/models", headers: bearer },
};

function status(row: StatusRow): ModelProviderStatus {
	return {
		provider: row.provider,
		last4: row.last4,
		addedAt: row.added_at,
		checkedAt: row.checked_at,
		ok: !!row.check_ok,
		...(row.check_ok &&
			row.windlass_models === null &&
			(row.provider === "google" || row.provider === "openrouter") && { needsWindlassCheck: true }),
		...(row.models !== null && { models: JSON.parse(row.models) as string[] }),
		...(row.windlass_models !== null && { windlassModels: JSON.parse(row.windlass_models) as string[] }),
	};
}

export function providerOf(raw: unknown): ModelProvider {
	if (!isModelProvider(raw)) throw new UserError("Unknown model provider.", { code: "bad_provider" });
	return raw;
}

export async function takeCheck(db: DefaultsDb): Promise<void> {
	// Saves and rechecks share one per-user budget. The upsert reserves a slot atomically
	// across concurrent calls and returns no row when the current minute is full.
	const admitted = await db.execute(
		`INSERT INTO model_check_budget VALUES (1, ?, 1)
		ON CONFLICT(id) DO UPDATE SET minute = excluded.minute, used = CASE WHEN minute = excluded.minute THEN used + 1 ELSE 1 END
		WHERE minute != excluded.minute OR used < ? RETURNING id`,
		Math.floor(Date.now() / MINUTE_MS),
		MODEL_CHECKS_PER_MINUTE,
	);
	if (!admitted.length)
		throw new UserError("Too many model provider checks. Try again next minute.", { code: "rate_limited" });
}

const subject = (uid: string, provider: ModelProvider) => JSON.stringify([uid, provider]);

export async function savedKey(db: DefaultsDb, uid: string, provider: ModelProvider) {
	const [row] = await db.execute<{ sealed: string; generation: string }>(
		"SELECT sealed, generation FROM model_provider WHERE provider = ?",
		provider,
	);
	if (!row) return null;
	const sealer = serverSealer();
	const owner = subject(uid, provider);
	const key = sealer.open("model-key", owner, row.sealed);
	if (!sealer.isCurrent(row.sealed)) {
		await db.execute(
			"UPDATE model_provider SET sealed = ? WHERE provider = ? AND sealed = ?",
			sealer.seal("model-key", owner, key),
			provider,
			row.sealed,
		);
	}
	return { secret: key, generation: row.generation };
}

// A model ID echoed by a provider must not disclose key material, even in truncated form.
export function safeModelId(id: unknown, key: string): id is string {
	if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(id)) return false;
	for (let i = 0; i + 5 <= id.length; i++) {
		if (key.includes(id.slice(i, i + 5))) return false;
	}
	return true;
}

async function fetchModels(provider: ModelProvider, key: string) {
	const spec = PROVIDERS[provider];
	const base = new URL(process.env[`WLP_${provider.toUpperCase()}_BASE_URL`] ?? spec.origin);
	if (
		base.protocol !== "https:" &&
		!(base.protocol === "http:" && (base.hostname === "127.0.0.1" || base.hostname === "localhost"))
	) {
		throw new Error("Model provider URL requires HTTPS");
	}
	const origin = base.href.replace(/\/+$/, "");
	const init: RequestInit = { headers: spec.headers(key), redirect: "error", signal: AbortSignal.timeout(8_000) };
	// OpenRouter's catalog is public. Verify ownership before using its list.
	if (provider === "openrouter") {
		const auth = await fetch(origin + "/api/v1/key", init);
		await auth.body?.cancel();
		if (!auth.ok) throw new Error("Key check failed");
	}
	const res = await fetch(origin + spec.path, init);
	if (!res.ok || !res.body) {
		await res.body?.cancel();
		throw new Error("Model list unavailable");
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of res.body) {
		size += chunk.byteLength;
		if (size > 8 * 1024 * 1024) throw new Error("Model list too large");
		chunks.push(chunk);
	}
	const body: ModelListBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	const entries = provider === "google" ? body.models : body.data;
	if (!Array.isArray(entries)) throw new Error("Invalid model list");
	const models = new Set<string>();
	const windlass = provider === "google" || provider === "openrouter" ? new Set<string>() : null;
	for (const entry of entries) {
		const id = provider === "google" ? entry?.name?.replace(/^models\//, "") : entry?.id;
		if (!safeModelId(id, key)) continue;
		if (models.size < 32) models.add(id);
		if (windlass && offersWindlass(provider, entry, id)) windlass.add(id);
		if (models.size === 32 && (!windlass || windlass.size === 32)) break;
	}
	return { models: [...models], windlass: windlass && [...windlass] };
}

async function runCheck(
	db: DefaultsDb,
	provider: ModelProvider,
	key: string,
	generation: string,
): Promise<ModelProviderCheck> {
	// Provider bodies, status text and fetch errors can all contain the submitted key.
	const models = await fetchModels(provider, key).catch(() => null);
	const [row] = await db.execute<StatusRow>(
		`UPDATE model_provider SET checked_at = ?, check_ok = ?, models = ?, windlass_models = ?
		WHERE provider = ? AND generation = ? RETURNING ${STATUS_COLUMNS}`,
		Date.now(),
		Number(models !== null),
		models && JSON.stringify(models.models),
		models?.windlass ? JSON.stringify(models.windlass) : null,
		provider,
		generation,
	);
	if (!row) throw new UserError("The saved key changed during the check.", { code: "model_key_changed" });
	return {
		...status(row),
		...(models === null && { message: "Could not check the key with the provider. Verify the key and try again." }),
	};
}

export function savedModelKeys(db: DefaultsDb) {
	return db.execute<{ provider: ModelProvider; generation: string }>(
		"SELECT provider, generation FROM model_provider WHERE check_ok=1 ORDER BY provider",
	);
}

export async function providerStatuses(db: DefaultsDb): Promise<ModelProviderStatus[]> {
	return (await db.execute<StatusRow>(`SELECT ${STATUS_COLUMNS} FROM model_provider ORDER BY provider`)).map(status);
}

export const modelProviderActions = {
	async modelProviders(c: Context): Promise<ModelProviderStatus[]> {
		requireUser(c);
		return providerStatuses(c.db);
	},
	async saveModelProvider(c: Context, input: { provider: ModelProvider; key: string }): Promise<ModelProviderCheck> {
		const { uid } = requireUser(c);
		const provider = providerOf(input?.provider);
		const key = input.key;
		if (!validModelKey(provider, key))
			throw new UserError("The key format does not match the provider.", { code: "bad_model_key" });
		await takeCheck(c.db);
		const generation = randomUUID();
		const [before] = await c.db.execute<{ generation: string }>(
			"SELECT generation FROM model_provider WHERE provider=?",
			provider,
		);
		const at = Date.now();
		const result = await fetchModels(provider, key).catch(() => null);
		const checked = Date.now();
		if (!result)
			return {
				provider,
				last4: key.slice(-4),
				addedAt: at,
				checkedAt: checked,
				ok: false,
				message: "Could not check the key with the provider. Verify the key and try again.",
			};
		const sealed = serverSealer().seal("model-key", subject(uid, provider), key);
		const [row] = await c.db.execute<StatusRow>(
			`INSERT INTO model_provider (provider, generation, sealed, last4, added_at, checked_at, check_ok, models, windlass_models)
			SELECT ?, ?, ?, ?, ?, ?, 1, ?, ? WHERE (SELECT generation FROM model_provider WHERE provider=?) IS ?
			ON CONFLICT(provider) DO UPDATE SET generation=excluded.generation, sealed=excluded.sealed, last4=excluded.last4,
			added_at=excluded.added_at, checked_at=excluded.checked_at, check_ok=1, models=excluded.models, windlass_models=excluded.windlass_models RETURNING ${STATUS_COLUMNS}`,
			provider,
			generation,
			sealed,
			key.slice(-4),
			at,
			checked,
			JSON.stringify(result.models),
			result.windlass && JSON.stringify(result.windlass),
			provider,
			before?.generation ?? null,
		);
		if (!row) throw new UserError("The saved key changed during the check.", { code: "model_key_changed" });
		return status(row);
	},
	async checkModelProvider(c: Context, raw: ModelProvider): Promise<ModelProviderCheck> {
		const { uid } = requireUser(c);
		const provider = providerOf(raw);
		await takeCheck(c.db);
		const saved = await savedKey(c.db, uid, provider);
		if (!saved) throw new UserError("No key is saved for this provider.", { code: "model_key_missing" });
		return runCheck(c.db, provider, saved.secret, saved.generation);
	},
	async removeModelProvider(c: Context, raw: ModelProvider): Promise<void> {
		requireUser(c);
		await c.db.execute("DELETE FROM model_provider WHERE provider = ?", providerOf(raw));
	},
	/** Read available generations so a turn can pin the selected provider without opening a key. */
	async internalModelKeys(c: Context) {
		requireServiceFor(c, modelKeyCaller(c.key[0]!));
		return savedModelKeys(c.db);
	},
};

/** The checked key's generation: a turn pins it without opening the key. */
export async function keyGeneration(db: DefaultsDb, provider: ModelProvider): Promise<string | null> {
	const [row] = await db.execute<{ generation: string }>(
		"SELECT generation FROM model_provider WHERE provider = ? AND check_ok=1",
		provider,
	);
	return row?.generation ?? null;
}
