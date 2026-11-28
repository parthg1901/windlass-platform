import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createClient } from "rivetkit/client";
import { serviceParams } from "../auth.js";
import { isActorGone } from "../actors/internal.js";
import { config, ownEngineEndpoint, slackConfig } from "../config.js";
import { AddressBudget, clientAddress, rateLimited } from "../http-limits.js";
import type { Registry } from "../registry.js";

export const SLACK_EVENTS_PATH = "/slack/events",
	SLACK_COMMANDS_PATH = "/slack/commands";
export interface SlackDelivery {
	deliveryId: string;
	teamId: string;
	channelId: string;
	userId: string;
	threadTs: string | null;
	text: string;
}

function parseEvent(raw: string): SlackDelivery | Response | null {
	const body = JSON.parse(raw);
	if (body?.type === "url_verification" && typeof body.challenge === "string")
		return Response.json({ challenge: body.challenge });
	const e = body?.event;
	if (
		body?.type !== "event_callback" ||
		e?.type !== "app_mention" ||
		e.bot_id ||
		e.subtype ||
		typeof e.text !== "string"
	)
		return null;
	const bot = body.authorizations?.find((a: { is_bot: boolean }) => a.is_bot)?.user_id;
	if (
		e.user === bot ||
		!/^[A-Za-z0-9]{1,128}$/.test(body.event_id ?? "") ||
		!/^\d+\.\d+$/.test(e.thread_ts ?? e.ts ?? "")
	)
		return null;
	const mention = /^<@([A-Z0-9]+)(?:\|[^>]+)?>\s*/.exec(e.text);
	const text = mention && mention[1] === bot ? e.text.slice(mention[0].length) : e.text;
	return {
		deliveryId: body.event_id,
		teamId: body.team_id,
		channelId: e.channel,
		userId: e.user,
		threadTs: e.thread_ts ?? e.ts,
		text,
	};
}

function parseCommand(raw: string): SlackDelivery | null {
	if (!/^[a-z_]+=/.test(raw)) return null;
	const form = new URLSearchParams(raw),
		trigger = form.get("trigger_id");
	if (form.get("command") !== "/windlass" || !trigger) return null;
	return {
		deliveryId: "command:" + createHash("sha256").update(trigger).digest("hex"),
		teamId: form.get("team_id") ?? "",
		channelId: form.get("channel_id") ?? "",
		userId: form.get("user_id") ?? "",
		threadTs: form.get("thread_ts"),
		text: form.get("text") ?? "",
	};
}

let client: ReturnType<typeof createClient<Registry>> | undefined;
const refusals = new AddressBudget(config.httpLimits.webhookRefusals);
/** The request body after Slack's signature check, or the response that refuses it. */
export async function readSigned(request: Request): Promise<Buffer | Response> {
	if (!slackConfig()) return new Response(null, { status: 404 });
	if (request.method !== "POST") return new Response(null, { status: 405 });
	const refuse = () => {
		const wait = refusals.refusal(clientAddress(request));
		return wait ? rateLimited(wait, "Too many refused requests.") : new Response(null, { status: 401 });
	};
	const stamp = request.headers.get("x-slack-request-timestamp") ?? "",
		signature = request.headers.get("x-slack-signature") ?? "";
	if (
		!/^\d{1,12}$/.test(stamp) ||
		Math.abs(Date.now() - Number(stamp) * 1000) > 300_000 ||
		!/^v0=[a-f0-9]{64}$/.test(signature)
	)
		return refuse();
	const chunks: Uint8Array[] = [];
	let length = 0;
	const reader = request.body?.getReader();
	try {
		while (reader) {
			const { value, done } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > 1024 * 1024) {
				void reader.cancel().catch(() => {});
				return new Response(null, { status: 413 });
			}
			chunks.push(value);
		}
	} finally {
		reader?.releaseLock();
	}
	const bytes = Buffer.concat(chunks, length);
	const mac = createHmac("sha256", process.env.WLP_SLACK_SIGNING_SECRET!).update(`v0:${stamp}:`).update(bytes).digest();
	if (!timingSafeEqual(Buffer.from(signature.slice(3), "hex"), mac)) return refuse();
	return bytes;
}

type Workspace = ReturnType<ReturnType<typeof createClient<Registry>>["slackWorkspace"]["get"]>;
/** Only wait for durable admission. Slack can resend the same event if the engine is slow. */
export async function admit(teamId: string, receive: (workspace: Workspace) => Promise<unknown>): Promise<Response> {
	client ??= createClient<Registry>({ endpoint: ownEngineEndpoint() });
	const workspace = client.slackWorkspace.get([teamId], { params: serviceParams() });
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			receive(workspace),
			new Promise<never>((_, reject) => {
				timer = setTimeout(reject, 2400);
			}),
		]);
	} catch (error) {
		if (!isActorGone(error)) return new Response(null, { status: 503 });
	} finally {
		clearTimeout(timer);
	}
	return new Response(null, { status: 200 });
}

export async function slackWebhookRoute(request: Request): Promise<Response> {
	const bytes = await readSigned(request);
	if (bytes instanceof Response) return bytes;
	let delivery;
	try {
		const raw = bytes.toString("utf8");
		delivery = new URL(request.url).pathname === SLACK_EVENTS_PATH ? parseEvent(raw) : parseCommand(raw);
	} catch {
		return new Response(null, { status: 400 });
	}
	if (delivery instanceof Response) return delivery;
	if (
		delivery &&
		/^T[A-Z0-9]+$/.test(delivery.teamId) &&
		/^[CG][A-Z0-9]+$/.test(delivery.channelId) &&
		/^[UW][A-Z0-9]+$/.test(delivery.userId)
	) {
		delivery.text = delivery.text.slice(0, 4000);
		const admitted = delivery;
		return admit(delivery.teamId, workspace => workspace.internalReceive(admitted));
	}
	return new Response(null, { status: 200 });
}
