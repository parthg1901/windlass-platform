import { jwtVerify } from "jose";
import { config, jiraClientSecret, jiraConfig } from "../config.js";
import { AddressBudget, clientAddress, rateLimited } from "../http-limits.js";
import { isActorGone } from "../actor-errors.js";
import { serviceParams } from "../auth.js";
import { digest, jiraActors } from "./connect.js";
import { isRecord } from "../util.js";

export const JIRA_WEBHOOK_PATH = "/jira/webhook";
export interface JiraDelivery {
	cloudId: string;
	projectId: string;
	issueId: string;
	self: string | null;
	deliveryId: string;
	matchedWebhookIds: number[];
	label: boolean;
	assignedTo: string | null;
	actorId: string | null;
	sentAt: number;
}
export type JiraDispatch = "taken" | "duplicate" | "ignored";
const obj = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const account = (value: unknown): string | null =>
	typeof value === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(value) ? value : null;
const numericId = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d{0,31}$/.test(v);
const normalized = (label: string) => label.trim().toLowerCase();
export function isTriggerLabel(label: string): boolean {
	return ["windlass", "windlass-quick"].includes(normalized(label));
}

/** Changelog label values are space-separated names, unlike fields.labels (an array). */
function classify(payload: unknown): Pick<JiraDelivery, "label" | "assignedTo"> | null {
	const body = obj(payload),
		fields = obj(obj(body.issue).fields);
	const labels = new Set<string>();
	for (const value of Array.isArray(fields.labels) ? fields.labels : []) {
		if (typeof value === "string" && isTriggerLabel(value)) labels.add(normalized(value));
	}
	const assignee = account(obj(fields.assignee).accountId);
	let label = false,
		assignedTo: string | null = null;
	if (body.webhookEvent === "jira:issue_created") {
		label = labels.size > 0;
		assignedTo = assignee;
	} else if (body.webhookEvent === "jira:issue_updated") {
		const items = obj(body.changelog).items;
		if (!Array.isArray(items)) return null;
		for (const value of items) {
			const item = obj(value),
				field = item.fieldId ?? item.field;
			if (item.fieldtype !== undefined && item.fieldtype !== "jira") continue;
			const after: unknown = item["toString"];
			if (
				field === "labels" &&
				(item.fromString === null || typeof item.fromString === "string") &&
				typeof after === "string"
			) {
				const before = new Set((item.fromString ?? "").toLowerCase().split(/\s+/));
				label ||= after
					.toLowerCase()
					.split(/\s+/)
					.some(l => labels.has(l) && !before.has(l));
			}
			if (
				field === "assignee" &&
				assignee &&
				item.to === assignee &&
				(item.from === null || account(item.from)) &&
				item.from !== assignee
			)
				assignedTo = assignee;
		}
	}
	return label || assignedTo ? { label, assignedTo } : null;
}

const json = (status: number, body: unknown) =>
	Response.json(body, { status, headers: { "cache-control": "no-store" } });
const budget = new AddressBudget(config.httpLimits.webhookRefusals);
export async function jiraWebhookRoute(request: Request): Promise<Response> {
	const refuse = (status: number, code: string) => {
		const retry = budget.refusal(clientAddress(request));
		return retry ? rateLimited(retry, "Too many refused webhook requests.") : json(status, { code });
	};
	const { app } = jiraConfig();
	if (!app) return json(404, { code: "not_found" });
	if (request.method !== "POST") return refuse(405, "method_not_allowed");
	const route = /^\/jira\/webhook\/([a-z0-9][a-z0-9-]{0,127})\.([\w-]{43})$/.exec(new URL(request.url).pathname);
	if (!route) return refuse(404, "not_found");
	const auth = request.headers.get("authorization") ?? "";
	const bearer = auth.length <= 8192 && /^Bearer ([\w.-]+)$/i.exec(auth);
	if (!bearer) return refuse(401, "bad_token");
	try {
		const { payload } = await jwtVerify(bearer[1], new TextEncoder().encode(jiraClientSecret()!), {
			algorithms: ["HS256"],
			requiredClaims: ["exp"],
		});
		if (payload.aud !== undefined && ![payload.aud].flat().includes(app.clientId)) return refuse(401, "bad_token");
		if (payload.iat !== undefined && payload.iat > Date.now() / 1000 + 60) return refuse(401, "bad_token");
	} catch {
		return refuse(401, "bad_token");
	}
	const deliveryId = request.headers.get("x-atlassian-webhook-identifier") ?? "";
	if (!/^[\w.:-]{1,256}$/.test(deliveryId)) return refuse(400, "bad_identifier");
	let body;
	try {
		// The native listener bounds the request before handing it to this route.
		const bytes = await request.arrayBuffer();
		if (bytes.byteLength > 1024 * 1024) return refuse(413, "body_too_large");
		body = obj(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
	} catch {
		return refuse(400, "bad_json");
	}
	const issue = obj(body.issue),
		projectId = obj(obj(issue.fields).project).id,
		issueId = issue.id;
	const transition = classify(body),
		ids = body.matchedWebhookIds,
		sentAt = body.timestamp;
	if (
		!transition ||
		!numericId(projectId) ||
		!numericId(issueId) ||
		!Array.isArray(ids) ||
		typeof sentAt !== "number" ||
		!Number.isSafeInteger(sentAt) ||
		sentAt <= 0
	)
		return json(202, { taken: false });
	const [, cloudId, key] = route;
	const site = jiraActors().jiraSite.get([cloudId], { params: serviceParams() });
	let timer: NodeJS.Timeout | undefined;
	try {
		const delivery = {
			cloudId,
			projectId,
			issueId,
			deliveryId,
			matchedWebhookIds: ids.filter(Number.isSafeInteger),
			sentAt,
			self: issue.self === undefined ? null : typeof issue.self === "string" ? issue.self : "",
			actorId: account(obj(body.user).accountId),
			...transition,
		};
		const result = await Promise.race([
			site.internalDispatch(delivery, digest(key)),
			new Promise<never>((_, reject) => {
				timer = setTimeout(reject, 8000);
			}),
		]);
		return json(202, { taken: result === "duplicate" ? "duplicate" : result === "taken" });
	} catch (error) {
		return isActorGone(error) ? json(202, { taken: false }) : json(503, { code: "unavailable" });
	} finally {
		clearTimeout(timer);
	}
}
