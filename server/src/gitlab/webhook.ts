import { createHash, timingSafeEqual } from "node:crypto";
import { MAX_ITEM_BODY_CHARS, MAX_NOTE_CHARS, MAX_TITLE_CHARS } from "../contract.js";
import { record } from "./app.js";
import { decimalId, gitlabId, parseGitlabJson } from "./ids.js";

export const GITLAB_WEBHOOK_PATH = "/gitlab/webhook";
export const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;

export class GitlabWebhookError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** Untrusted GitLab issue text, bounded for handoff to intake. */
type IssueText = { title: string; description: string };

/** Keep project, user and note database IDs as decimal strings; issue/MR IIDs are project-local. */
export type GitlabDelivery = { guid: string; projectId: string } & (
	| { event: "merge_request"; iid: number | string; action: string; head: string }
	/** `iid`: the merge request of a detached or merged-results pipeline, whose `head` may be a merge commit. */
	| { event: "pipeline"; pipelineId: string; head: string; status: string; iid?: number | string }
	| (IssueText & {
			event: "issue";
			iid: number | string;
			action: "open" | "update";
			senderId: string;
			addedLabels: ["windlass"];
	  })
	| (IssueText & {
			event: "note";
			target: "issue";
			iid: number | string;
			noteId: string;
			senderId: string;
			body: string;
	  })
);

const id = decimalId;
const iid = gitlabId;
const sha = (v: unknown) => (typeof v === "string" && /^[a-f\d]{40}$/i.test(v) && !/^0+$/.test(v) ? v : null);
const word = (v: unknown) => (typeof v === "string" && /^[a-z_]{1,64}$/.test(v) ? v : null);
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

export async function readGitlabWebhookBody(request: Request): Promise<Uint8Array> {
	const tooLarge = () => new GitlabWebhookError(413, "GitLab delivery exceeds the body limit.");
	if (Number(request.headers.get("content-length")) > MAX_WEBHOOK_BYTES) throw tooLarge();
	const reader = request.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (reader) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_WEBHOOK_BYTES) {
				void reader.cancel().catch(() => undefined);
				throw tooLarge();
			}
			if (value.byteLength) chunks.push(value);
		}
	} catch (e) {
		if (e instanceof GitlabWebhookError) throw e;
		throw new GitlabWebhookError(400, "Unreadable GitLab delivery.");
	} finally {
		reader?.releaseLock();
	}
	return Buffer.concat(chunks, size);
}

/** The caller supplies the secret and project together from trusted configuration. */
export interface GitlabWebhookBinding {
	projectId: string | number;
	secret: string;
}

function authenticated(headers: Headers, secret: string): boolean {
	const token = headers.get("x-gitlab-token");
	const digest = (s: string) => createHash("sha256").update(s).digest();
	return !!secret && !!token && timingSafeEqual(digest(secret), digest(token));
}

const hasWindlass = (labels: unknown) =>
	Array.isArray(labels) && labels.some(label => record(label).title === "windlass");
const bounded = (value: unknown, limit: number) => (typeof value === "string" ? value.slice(0, limit) : "");
function issueText(issue: Record<string, unknown>): IssueText {
	return { title: bounded(issue.title, MAX_TITLE_CHARS), description: bounded(issue.description, MAX_ITEM_BODY_CHARS) };
}

/** Authenticate before parsing. Null is an authenticated but unsupported or irrelevant delivery. */
export function parseGitlabWebhook(
	headers: Headers,
	bytes: Uint8Array,
	binding: GitlabWebhookBinding,
): GitlabDelivery | null {
	if (bytes.byteLength > MAX_WEBHOOK_BYTES)
		throw new GitlabWebhookError(413, "GitLab delivery exceeds the body limit.");
	if (!authenticated(headers, binding.secret)) throw new GitlabWebhookError(401, "Invalid GitLab webhook credentials.");
	const guid = headers.get("x-gitlab-event-uuid") ?? headers.get("idempotency-key");
	if (!guid || !uuid.test(guid)) throw new GitlabWebhookError(400, "Invalid GitLab delivery ID.");
	let p: Record<string, unknown>;
	try {
		p = record(parseGitlabJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
	} catch {
		throw new GitlabWebhookError(400, "Invalid GitLab delivery body.");
	}
	const projectId = id(record(p.project).id),
		attr = record(p.object_attributes);
	if (!projectId || projectId !== id(binding.projectId))
		throw new GitlabWebhookError(403, "Delivery is not for this GitLab project.");
	const base = { guid: guid.toLowerCase(), projectId };
	const hook = headers.get("x-gitlab-event"),
		action = word(attr.action),
		number = iid(attr.iid);
	if (hook === "Merge Request Hook" && p.object_kind === "merge_request") {
		const head = sha(record(attr.last_commit).id);
		return number && action && head ? { ...base, event: "merge_request", iid: number, action, head } : null;
	}
	if (hook === "Pipeline Hook" && p.object_kind === "pipeline") {
		const head = sha(attr.sha),
			status = word(attr.status),
			pipelineId = id(attr.id),
			mr = iid(record(p.merge_request).iid);
		return head && status && pipelineId
			? { ...base, event: "pipeline", pipelineId, head, status, ...(mr && { iid: mr }) }
			: null;
	}
	const senderId = id(record(p.user).id);
	if (!senderId) return null;
	if (hook === "Issue Hook" && p.object_kind === "issue" && number && (action === "open" || action === "update")) {
		const change = record(record(p.changes).labels);
		const gained =
			action === "open"
				? hasWindlass(p.labels ?? attr.labels ?? change.current)
				: Array.isArray(change.previous) && !hasWindlass(change.previous) && hasWindlass(change.current);
		return gained
			? { ...base, event: "issue", iid: number, action, senderId, addedLabels: ["windlass"], ...issueText(attr) }
			: null;
	}
	if (
		hook === "Note Hook" &&
		p.object_kind === "note" &&
		attr.noteable_type === "Issue" &&
		attr.system !== true &&
		(attr.action === undefined || attr.action === "create")
	) {
		const issue = record(p.issue),
			n = iid(issue.iid),
			noteId = id(attr.id),
			note = attr.note;
		if (
			!n ||
			!noteId ||
			typeof note !== "string" ||
			!/^\/windlass(?:\s|$)/.test(note) ||
			/^\/windlass\s+feature(?:\s|$)/i.test(note)
		)
			return null;
		return {
			...base,
			event: "note",
			target: "issue",
			iid: n,
			senderId,
			noteId,
			body: bounded(note, MAX_NOTE_CHARS),
			...issueText(issue),
		};
	}
	return null;
}

/** Adapts a project-bound receiver to CodeHost.webhookRoute; dispatch must deduplicate by projectId and guid. */
export function gitlabWebhookRoute(
	binding: GitlabWebhookBinding,
	dispatch: (delivery: GitlabDelivery) => Promise<unknown>,
): (request: Request) => Promise<Response | null> {
	return async request => {
		if (new URL(request.url).pathname !== GITLAB_WEBHOOK_PATH) return null;
		if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
		let delivery: GitlabDelivery | null;
		try {
			delivery = parseGitlabWebhook(request.headers, await readGitlabWebhookBody(request), binding);
		} catch (error) {
			if (error instanceof GitlabWebhookError) return new Response(null, { status: error.status });
			throw error;
		}
		if (delivery) {
			try {
				await dispatch(delivery);
			} catch {
				return new Response(null, { status: 503 });
			}
		}
		return Response.json({ taken: !!delivery }, { status: 202, headers: { "cache-control": "no-store" } });
	};
}
