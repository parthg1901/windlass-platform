import { UserError } from "rivetkit";
import { slackConfig } from "../config.js";
import type { SlackChannel } from "../contract.js";
import type { Block, SlackMessage } from "./blocks.js";

export const SLACK_SCOPES = ["app_mentions:read", "commands", "chat:write", "channels:read", "groups:read"];
export function settings() {
	const app = slackConfig();
	if (!app) throw new UserError("Slack is unavailable on this deployment.", { code: "slack_off" });
	return app;
}

async function call(method: string, fields: Record<string, string>, token?: string) {
	const read = method === "conversations.list" || method === "conversations.info";
	const params = new URLSearchParams(fields);
	const url = new URL(`/api/${method}`, settings().url);
	if (read) url.search = params.toString();
	const response = await fetch(url, {
		method: read ? "GET" : "POST",
		body: read ? undefined : params,
		headers: token ? { authorization: `Bearer ${token}` } : {},
		redirect: "error",
		signal: AbortSignal.timeout(15_000),
	});
	const answer = await response.json().catch(() => {
		throw new Error(`Slack could not complete ${method}.`);
	});
	if (!response.ok || !answer.ok) {
		// Slack may echo submitted data. Only expose our own error messages.
		if (
			[
				"channel_not_found",
				"not_in_channel",
				"is_archived",
				"invalid_auth",
				"token_revoked",
				"account_inactive",
				"message_not_found",
				"cant_update_message",
			].includes(answer.error)
		)
			throw new UserError("The Slack channel or connection is no longer available.", { code: "slack_unavailable" });
		throw new Error(`Slack could not complete ${method}.`);
	}
	return answer;
}

export async function exchangeCode(code: string) {
	const { clientId, redirectUrl } = settings();
	const result = await call("oauth.v2.access", {
		client_id: clientId,
		client_secret: process.env.WLP_SLACK_CLIENT_SECRET!,
		code,
		redirect_uri: redirectUrl,
	});
	if (
		result.token_type !== "bot" ||
		!result.access_token ||
		!result.bot_user_id ||
		!result.team?.name ||
		!result.team.id ||
		!SLACK_SCOPES.every(scope => result.scope?.split(",").includes(scope))
	)
		throw new Error("Slack did not grant the requested bot permissions.");
	return {
		teamId: String(result.team.id),
		name: String(result.team.name),
		bot: String(result.bot_user_id),
		token: String(result.access_token),
		/** The Slack user who installed the app: they authorized it as themselves. */
		installer: typeof result.authed_user?.id === "string" ? result.authed_user.id : null,
	};
}

/**
 * Who signed in with Slack (OpenID Connect, `openid profile`): their user and team. The token only proves that and is revoked
 * at once.
 */
export async function signedInUser(code: string) {
	const { clientId, redirectUrl } = settings();
	const granted = await call("openid.connect.token", {
		client_id: clientId,
		client_secret: process.env.WLP_SLACK_CLIENT_SECRET!,
		code,
		redirect_uri: redirectUrl,
	});
	const token = typeof granted.access_token === "string" ? granted.access_token : "";
	if (!token) throw new Error("Slack did not sign the user in.");
	try {
		const info = await call("openid.connect.userInfo", {}, token);
		const userId = info["https://slack.com/user_id"],
			teamId = info["https://slack.com/team_id"];
		if (typeof userId !== "string" || !/^[UW][A-Z0-9]{1,32}$/.test(userId) || typeof teamId !== "string")
			throw new Error("Slack did not say who signed in.");
		if (!/^T[A-Z0-9]{1,32}$/.test(teamId)) throw new Error("Slack did not say who signed in.");
		return {
			userId,
			name: String(info.name ?? "").slice(0, 200),
			teamId,
			teamName: String(info["https://slack.com/team_name"] ?? "").slice(0, 200),
		};
	} finally {
		await call("auth.revoke", {}, token).catch(() => {});
	}
}

export async function isJoinedChannel(token: string, id: string): Promise<boolean> {
	const { channel } = await call("conversations.info", { channel: id }, token);
	return channel?.id === id && channel.is_member === true && channel.is_archived === false;
}

export async function listChannels(token: string): Promise<SlackChannel[]> {
	const channels: SlackChannel[] = [];
	let cursor = "";
	do {
		const page = await call(
			"conversations.list",
			{ types: "public_channel,private_channel", exclude_archived: "true", limit: "200", cursor },
			token,
		);
		for (const channel of page.channels) {
			if (channel.is_member && !channel.is_archived) channels.push({ id: channel.id, name: channel.name });
		}
		cursor = page.response_metadata?.next_cursor ?? "";
	} while (cursor);
	return channels.sort((a, b) => a.name.localeCompare(b.name));
}

export const revoke = (token: string) => call("auth.revoke", {}, token);
export function postPrivate(token: string, channel: string, user: string, text: string, threadTs?: string | null) {
	return call("chat.postEphemeral", { channel, user, text, ...(threadTs && { thread_ts: threadTs }) }, token);
}
const content = (message: SlackMessage) => ({
	text: message.text,
	...(message.blocks && { blocks: JSON.stringify(message.blocks) }),
});
export async function postMessage(
	token: string,
	channel: string,
	message: SlackMessage,
	threadTs: string | null,
): Promise<string> {
	const result = await call(
		"chat.postMessage",
		{
			channel,
			...content(message),
			unfurl_links: "false",
			unfurl_media: "false",
			...(threadTs && { thread_ts: threadTs }),
		},
		token,
	);
	return result.ts;
}
export async function updateMessage(token: string, channel: string, ts: string, message: SlackMessage): Promise<void> {
	await call("chat.update", { channel, ts, ...content(message), blocks: JSON.stringify(message.blocks ?? []) }, token);
}
/** `trigger` expires three seconds after the press. */
export async function openView(token: string, trigger: string, view: Block): Promise<void> {
	await call("views.open", { trigger_id: trigger, view: JSON.stringify(view) }, token);
}
