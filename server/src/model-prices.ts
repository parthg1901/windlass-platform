/**
 * Model prices for items' cost (factory/cost.ts), read from a public catalog: no price list is kept in code.
 *
 * The catalog is models.dev's (`config.modelPricesUrl`, WLP_MODEL_PRICES_URL), the one OpenCode builds its model
 * list from. Its providers are keyed by the same ids as the platform's (`MODEL_PROVIDERS`), and its models by the
 * provider's own ids, which are the ids a turn runs with ("claude-sonnet-4-5", "gpt-5.3-codex", OpenRouter's
 * "anthropic/claude-sonnet-4.5"). Each gives US dollars per million input, output and cache-read tokens.
 *
 * Read once a day, at most `MAX_CATALOG_BYTES` within `FETCH_TIMEOUT_MS`. Only the platform's providers are kept.
 * A read that fails keeps the prices held (a stale catalog beats none) and is tried again in an hour.
 */

import { MODEL_PROVIDERS, type CostRates, type ModelPrice } from "./contract.js";
import { errorText, isRecord } from "./util.js";

export const CATALOG_NAME = "models.dev";
/** models.dev's catalog was 7 MB in November 2026. */
export const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 20_000;
export const REFRESH_MS = 24 * 3600_000;
export const RETRY_MS = 3600_000;
/** How long a caller waits for the first read before answering without prices. */
export const FIRST_READ_WAIT_MS = 5_000;
const MAX_ID_LENGTH = 200;

export class PriceCatalogError extends Error {}

const isPrice = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The platform providers' model prices from a models.dev catalog, by "provider/model id". */
export function parseModelPrices(raw: unknown): Record<string, ModelPrice> {
	if (!isRecord(raw)) throw new PriceCatalogError("The price catalog is not a JSON object.");
	const prices: Record<string, ModelPrice> = {};
	let providers = 0;
	for (const provider of MODEL_PROVIDERS) {
		const section = raw[provider];
		if (!isRecord(section) || !isRecord(section.models)) continue;
		providers += 1;
		for (const [id, model] of Object.entries(section.models)) {
			if (id.length > MAX_ID_LENGTH || !isRecord(model) || !isRecord(model.cost)) continue;
			const { input, output, cache_read: cacheRead } = model.cost;
			if (!isPrice(input) || !isPrice(output)) continue;
			prices[`${provider}/${id}`] = { input, output, ...(isPrice(cacheRead) && { cacheRead }) };
		}
	}
	if (providers === 0) throw new PriceCatalogError("The price catalog names none of the platform's providers.");
	return prices;
}

/** A response body as text, refused past `maxBytes` (by its length header, or as it streams). */
export async function boundedText(response: Response, maxBytes: number): Promise<string> {
	const declared = Number(response.headers.get("content-length") ?? NaN);
	if (declared > maxBytes) throw new PriceCatalogError(`The price catalog is larger than ${maxBytes} bytes.`);
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new PriceCatalogError(`The price catalog is larger than ${maxBytes} bytes.`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export interface PriceCacheOptions {
	url: string | null;
	fetch?: typeof fetch;
	now?: () => number;
	timeoutMs?: number;
	maxBytes?: number;
	log?: (line: string) => void;
}

type Held = { models: Record<string, ModelPrice>; fetchedAt: number };

/** The prices held, read again when due. One read at a time. */
export class ModelPriceCache {
	private held: Held | null = null;
	private nextRead = 0;
	private reading: Promise<void> | null = null;

	constructor(private readonly options: PriceCacheOptions) {}

	/** The prices and their source; null ones before the first read succeeds. Waits at most `waitMs` for a first read. */
	async prices(waitMs = FIRST_READ_WAIT_MS): Promise<Pick<CostRates, "models" | "source">> {
		const { url } = this.options;
		if (url === null) return { models: null, source: null };
		const now = this.now();
		if (!this.reading && now >= this.nextRead) this.reading = this.read(url).finally(() => (this.reading = null));
		if (!this.held && this.reading) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([this.reading, new Promise(resolve => (timer = setTimeout(resolve, waitMs)))]);
			clearTimeout(timer);
		}
		const held = this.held;
		return held
			? { models: held.models, source: { name: CATALOG_NAME, url, fetchedAt: held.fetchedAt } }
			: { models: null, source: null };
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	private async read(url: string): Promise<void> {
		const started = this.now();
		try {
			const response = await (this.options.fetch ?? fetch)(url, {
				signal: AbortSignal.timeout(this.options.timeoutMs ?? FETCH_TIMEOUT_MS),
				headers: { accept: "application/json" },
			});
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				throw new PriceCatalogError(`The price catalog answered ${response.status}.`);
			}
			const text = await boundedText(response, this.options.maxBytes ?? MAX_CATALOG_BYTES);
			let raw: unknown;
			try {
				raw = JSON.parse(text);
			} catch {
				throw new PriceCatalogError("The price catalog is not JSON.");
			}
			this.held = { models: parseModelPrices(raw), fetchedAt: this.now() };
			this.nextRead = started + REFRESH_MS;
		} catch (error) {
			this.nextRead = started + RETRY_MS;
			(this.options.log ?? console.warn)(
				`[wlp] model prices could not be read from ${url}${this.held ? "; the prices read before are kept" : ""}: ${errorText(error)}`,
			);
		}
	}
}

let shared: ModelPriceCache | null = null;

/** The server's one cache, from `config.modelPricesUrl`. */
export async function modelPrices(): Promise<Pick<CostRates, "models" | "source">> {
	if (!shared) {
		// Loaded here, not at the top: the parser's checks import this module without the server's configuration.
		const { config } = await import("./config.js");
		shared = new ModelPriceCache({ url: config.modelPricesUrl });
	}
	return shared.prices();
}
