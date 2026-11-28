/** The platform the CLI talks to, and its JSON requests. */

/** The hosted Windlass platform; `--platform <url>` or `WINDLASS_PLATFORM` names another (a self-hosted one). */
export const DEFAULT_PLATFORM = "https://windlass.parthg.dev";

export class CliError extends Error {}

/** The platform's origin: https, or http on a loopback address (development). */
export function platformOrigin(raw: string | undefined): string {
	const text = (raw ?? "").trim() || DEFAULT_PLATFORM;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw new CliError(`The platform address "${text}" is not a URL.`);
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
		throw new CliError("The platform address must start with https:// (or http:// on localhost).");
	return url.origin;
}

export interface Answer {
	status: number;
	body: Record<string, unknown>;
	/** Seconds from a 429's retry-after. */
	retryAfter: number;
}

/** GETs JSON. Throws only when the platform could not be reached. */
export async function get(origin: string, path: string, timeoutMs = 20_000): Promise<Answer> {
	return request(origin + path, { method: "GET", headers: { accept: "application/json" } }, timeoutMs);
}

/** POSTs JSON and reads the JSON answer. Throws only when the platform could not be reached. */
export async function post(origin: string, path: string, body: unknown, timeoutMs = 20_000): Promise<Answer> {
	return request(
		origin + path,
		{
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify(body),
		},
		timeoutMs,
	);
}

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Answer> {
	const origin = new URL(url).origin;
	let response: Response;
	try {
		response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
	} catch (error) {
		throw new CliError(`Could not reach ${origin} (${error instanceof Error ? error.message : "network error"}).`);
	}
	let parsed: unknown = null;
	try {
		parsed = await response.json();
	} catch {
		// The status says enough.
	}
	return {
		status: response.status,
		body: parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {},
		retryAfter: Number(response.headers.get("retry-after")) || 0,
	};
}
