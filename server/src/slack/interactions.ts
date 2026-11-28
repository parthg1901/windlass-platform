import { createHash } from "node:crypto";
import { MAX_NOTE_CHARS } from "../contract.js";
import type { ButtonValue } from "./blocks.js";
import { admit, readSigned } from "./webhook.js";

export const SLACK_INTERACTIONS_PATH = "/slack/interactions";
/** A button press, or the submitted "Request changes" modal (`note`). */
export interface SlackInteraction {
	id: string;
	teamId: string;
	userId: string;
	channelId: string;
	trigger: string;
	value: ButtonValue;
	note?: string;
}

const isId = (value: unknown, form: RegExp): value is string => typeof value === "string" && form.test(value);
function buttonValue(raw: unknown): ButtonValue | null {
	try {
		const v = typeof raw === "string" ? JSON.parse(raw) : raw;
		if (
			!isId(v?.i, /^i_[A-Za-z0-9_-]{1,64}$/) ||
			typeof v.q !== "string" ||
			v.q.length > 200 ||
			!isId(v.c, /^[a-z_]{1,32}$/)
		)
			return null;
		if (v.v !== undefined && !Number.isSafeInteger(v.v)) return null;
		return { i: v.i, q: v.q, c: v.c, ...(v.v !== undefined && { v: v.v }) };
	} catch {
		return null;
	}
}

export function parseInteraction(raw: string): SlackInteraction | null {
	const payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "null");
	const teamId = payload?.team?.id,
		userId = payload?.user?.id,
		trigger = payload?.trigger_id;
	if (!isId(teamId, /^T[A-Z0-9]+$/) || !isId(userId, /^[UW][A-Z0-9]+$/) || typeof trigger !== "string" || !trigger)
		return null;
	const id = "action:" + createHash("sha256").update(trigger).digest("hex");
	if (payload.type === "block_actions") {
		const action = payload.actions?.[0],
			channelId = payload.container?.channel_id ?? payload.channel?.id;
		// "Open in Windlass" is a link: Slack still reports the press.
		if (!action || action.action_id === "open" || !isId(channelId, /^[CG][A-Z0-9]+$/)) return null;
		const value = buttonValue(action.value);
		return value && { id, teamId, userId, channelId, trigger, value };
	}
	if (payload.type === "view_submission" && payload.view?.callback_id === "windlass_revise") {
		const meta = JSON.parse(payload.view.private_metadata ?? "null"),
			value = buttonValue(meta);
		const note = payload.view.state?.values?.note?.note?.value;
		if (!value || value.c !== "revise" || !isId(meta.ch, /^[CG][A-Z0-9]+$/) || typeof note !== "string" || !note.trim())
			return null;
		return { id, teamId, userId, channelId: meta.ch, trigger, value, note: note.slice(0, MAX_NOTE_CHARS) };
	}
	return null;
}

export async function slackInteractionRoute(request: Request): Promise<Response> {
	const bytes = await readSigned(request);
	if (bytes instanceof Response) return bytes;
	let interaction;
	try {
		interaction = parseInteraction(bytes.toString("utf8"));
	} catch {
		return new Response(null, { status: 400 });
	}
	if (!interaction) return new Response(null, { status: 200 });
	const admitted = interaction;
	return admit(interaction.teamId, workspace => workspace.internalInteract(admitted));
}
