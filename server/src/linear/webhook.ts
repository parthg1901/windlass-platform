import { createHmac, timingSafeEqual } from "node:crypto";
import { config, linearConfig, type LinearConfig } from "../config.js";
import { AddressBudget, clientAddress, MINUTE_MS, rateLimited } from "../http-limits.js";
import { sourceCaps } from "../sources/registry.js";
import { isLinearId, record, text } from "./app.js";

export const LINEAR_WEBHOOK_PATH = "/linear/webhook";
/** The most a delivery's body may be. Linear's are a few kilobytes. */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;
/** How far a delivery's signed timestamp may be from now, either way. Linear's own SDK uses a minute. */
export const MAX_TIMESTAMP_SKEW_MS = 60_000;

export function isTriggerLabel(name: string): boolean {
	const label = name.trim().toLowerCase();
	return label === "windlass" || sourceCaps("linear").quickLabels.includes(label);
}

/** What a qualifying delivery comes to once authenticated: lookup ids and the transition, nothing of the issue's content. */
export interface LinearDelivery {
	/** `Linear-Delivery`: the unit of redelivery. */
	deliveryId: string;
	workspaceId: string;
	teamId: string;
	issueId: string;
	/** A trigger label was gained. */
	label: boolean;
	/** The one the issue was assigned to by this delivery. */
	assignedTo: string | null;
	/** Who made the change, as Linear says. A hint, never an authorization. */
	actorId: string | null;
	/** The delivery's signed timestamp, ms since the epoch. */
	sentAt: number;
}

/** What became of a delivery. `ignored` takes nothing in; `duplicate` is a redelivery of one that was taken in. */
export type LinearDispatch = "taken" | "duplicate" | "ignored";

const idOrNull = (value: unknown): string | null => (isLinearId(value) ? value.toLowerCase() : null);

/** Constant-time check of `Linear-Signature` (hex HMAC-SHA256 of the raw bytes) against each secret. */
export function signatureMatches(bytes: Uint8Array, signature: string, secrets: readonly string[]): boolean {
	if (!/^[0-9a-fA-F]{64}$/.test(signature)) return false;
	const given = Buffer.from(signature, "hex");
	let match = false;
	for (const secret of secrets)
		match = timingSafeEqual(given, createHmac("sha256", secret).update(bytes).digest()) || match;
	return match;
}

/** The signature Linear would send: for the stand-in and the checks. */
export function signBody(bytes: Uint8Array | string, secret: string): string {
	return createHmac("sha256", secret).update(bytes).digest("hex");
}

export type Refusal = "stale_timestamp" | "bad_timestamp";

/** Whether the signed `webhookTimestamp` of a parsed delivery is fresh. */
export function timestampProblem(payload: unknown, now: number): Refusal | null {
	const at = record(payload).webhookTimestamp;
	if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) return "bad_timestamp";
	return Math.abs(now - at) > MAX_TIMESTAMP_SKEW_MS ? "stale_timestamp" : null;
}

/** The label names of an issue's `data`, with their ids. */
function labelsOf(data: Record<string, unknown>): Array<{ id: string; name: string }> {
	const labels: Array<{ id: string; name: string }> = [];
	for (const entry of Array.isArray(data.labels) ? data.labels.slice(0, 250) : []) {
		const label = record(entry);
		const id = idOrNull(label.id);
		if (id !== null) labels.push({ id, name: text(label.name) });
	}
	return labels;
}

/** Filing refetches the issue. Only lookup IDs and the transition come from the signed delivery. */
export function readIds(payload: unknown): { workspaceId: string; teamId: string; issueId: string } | null {
	const body = record(payload),
		data = record(body.data);
	if (body.type !== "Issue") return null;
	const workspaceId = idOrNull(body.organizationId);
	const teamId = idOrNull(data.teamId) ?? idOrNull(record(data.team).id);
	const issueId = idOrNull(data.id);
	return workspaceId && teamId && issueId ? { workspaceId, teamId, issueId } : null;
}

/** The transition an authenticated issue event is, or null when it is neither a gained trigger label nor a new assignee. */
export function classify(payload: unknown): { label: boolean; assignedTo: string | null } | null {
	const body = record(payload),
		data = record(body.data);
	const action = body.action;
	if (body.type !== "Issue" || (action !== "create" && action !== "update")) return null;
	const created = action === "create";
	const before = record(body.updatedFrom);
	// An update that does not say what changed is not a transition we can see.
	if (!created && Object.keys(before).length === 0) return null;

	const assignee = idOrNull(data.assigneeId);
	const assignedTo =
		assignee !== null && (created || ("assigneeId" in before && idOrNull(before.assigneeId) !== assignee))
			? assignee
			: null;

	const wasLabelIds = Array.isArray(before.labelIds) ? new Set(before.labelIds.map(idOrNull)) : null;
	const label =
		(created || wasLabelIds !== null) &&
		labelsOf(data).some(l => isTriggerLabel(l.name) && (created || !wasLabelIds!.has(l.id)));

	return label || assignedTo !== null ? { label, assignedTo } : null;
}

const json = (status: number, body: unknown) =>
	Response.json(body, { status, headers: { "cache-control": "no-store" } });
const error = (status: number, code: string, message: string) => json(status, { code, message });

export interface LinearWebhookDeps {
	/**
	 * Finds the owner of the delivery's team and hands it over. Throws when it cannot be taken in now: Linear then redelivers
	 * under the same delivery id, which is the only retry.
	 */
	dispatch(delivery: LinearDelivery): Promise<LinearDispatch>;
	/** Defaults to the environment's, read per request. */
	settings?: () => Pick<LinearConfig, "app" | "webhook">;
	now?: () => number;
	/** How long a dispatch may take before Linear is told to try again. */
	dispatchTimeoutMs?: number;
}

/** The route's handler. Answers null for any other path. */
export function linearWebhookRoute(deps: LinearWebhookDeps): (request: Request) => Promise<Response | null> {
	const refusals = new AddressBudget(config.httpLimits.webhookRefusals);
	let refused = 0,
		badSignatures = 0,
		throttled = 0;

	// One trailing summary even when the burst stops. Only counts are kept.
	function refuse(request: Request, status: number, code: string, message: string): Response {
		const address = clientAddress(request);
		const admission = refusals.refusal(address);
		if (refused++ === 0)
			setTimeout(() => {
				console.warn(
					`linear.webhook.refused count=${refused} bad_signature=${badSignatures} rate_limited=${throttled}`,
				);
				refused = badSignatures = throttled = 0;
			}, MINUTE_MS).unref();
		if (code === "bad_signature") badSignatures++;
		if (admission) {
			throttled++;
			return rateLimited(
				admission,
				address === null
					? "Too many refused webhook requests. Try again later."
					: "This address has sent too many refused webhook requests. Try again later.",
			);
		}
		return error(status, code, message);
	}

	return async request => {
		if (new URL(request.url).pathname !== LINEAR_WEBHOOK_PATH) return null;
		const { app, webhook } = (deps.settings ?? linearConfig)();
		if (!app || !webhook) return error(404, "not_found", "There is no such route.");
		if (request.method !== "POST")
			return refuse(request, 405, "method_not_allowed", `Use POST on ${LINEAR_WEBHOOK_PATH}.`);

		const deliveryId = request.headers.get("linear-delivery") ?? "";
		const signature = request.headers.get("linear-signature") ?? "";
		if (!isLinearId(deliveryId) || !/^[0-9a-fA-F]{64}$/.test(signature))
			return refuse(request, 400, "bad_headers", "Required delivery headers are missing or malformed.");
		const length = request.headers.get("content-length");
		if (length !== null && Number(length) > MAX_WEBHOOK_BYTES)
			return refuse(request, 413, "body_too_large", "The delivery is larger than 1 MiB.");

		let size = 0;
		const chunks: Uint8Array[] = [];
		const reader = request.body?.getReader();
		try {
			while (reader) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > MAX_WEBHOOK_BYTES) {
					void reader.cancel().catch(() => undefined);
					return refuse(request, 413, "body_too_large", "The delivery is larger than 1 MiB.");
				}
				chunks.push(value);
			}
		} catch {
			return refuse(request, 400, "bad_body", "The delivery body could not be read.");
		} finally {
			reader?.releaseLock();
		}
		const bytes = Buffer.concat(chunks, size);
		// The MAC of the original bytes, before any of them is decoded.
		if (!signatureMatches(bytes, signature, webhook.secrets))
			return refuse(request, 401, "bad_signature", "The delivery signature is invalid.");

		let payload: unknown;
		try {
			payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		} catch {
			return refuse(request, 400, "bad_json", "The delivery body must be JSON.");
		}
		const stale = timestampProblem(payload, (deps.now ?? Date.now)());
		if (stale)
			return refuse(
				request,
				401,
				stale,
				stale === "stale_timestamp"
					? "The delivery's timestamp is too far from now."
					: "The delivery has no usable timestamp.",
			);

		// Authenticated and fresh. Only now are ids taken out.
		const ids = readIds(payload),
			transition = classify(payload);
		if (!ids || !transition) return json(202, { taken: false });
		const delivery: LinearDelivery = {
			deliveryId,
			...ids,
			...transition,
			actorId: idOrNull(record(record(payload).actor).id),
			sentAt: record(payload).webhookTimestamp as number,
		};
		const limit = deps.dispatchTimeoutMs ?? 8_000;
		try {
			const outcome = await Promise.race([
				deps.dispatch(delivery),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("dispatch timeout")), limit).unref()),
			]);
			return json(202, { taken: outcome === "ignored" ? false : outcome === "duplicate" ? "duplicate" : true });
		} catch {
			/* Linear redelivers under the same delivery id. */
		}
		return error(503, "unavailable", "The delivery could not be taken in. Try again.");
	};
}
