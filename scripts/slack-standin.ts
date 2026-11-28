import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

type Block = Record<string, unknown>;
export interface SlackPosted {
	channel: string;
	text: string;
	thread: string | null;
	ts: string;
	blocks: Block[];
}

export class SlackStandin {
	readonly team = { id: "T12345678", name: "Test workspace" };
	readonly member = "U55667788";
	readonly bot = "UBOT";
	readonly channel = { id: "C12345678", name: "engineering" };
	isMember = true;
	archived = false;
	channelInfoCalls = 0;
	channelListCalls = 0;
	readonly messages: SlackPosted[] = [];
	readonly privateReplies: { user: string; text: string; thread: string | null }[] = [];
	readonly updates: { ts: string; text: string; blocks: Block[] }[] = [];
	readonly views: { trigger: string; view: Block }[] = [];
	/** Every form Slack received for a message, to check what was never posted. */
	readonly payloads: string[] = [];
	readonly secret = randomUUID();
	readonly signing = randomUUID();
	private readonly codes = new Map<string, string>();
	private readonly triggers = new Set<string>();
	readonly tokens = new Set<string>();
	private readonly server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		const url = new URL(req.url!, this.url);
		const form = req.method === "GET" ? url.searchParams : new URLSearchParams(Buffer.concat(chunks).toString());
		const json = (value: unknown) => res.setHeader("content-type", "application/json").end(JSON.stringify(value));
		if (req.url === "/api/oauth.v2.access") {
			const code = form.get("code") ?? "",
				scope = this.codes.get(code);
			if (!scope || form.get("client_secret") !== this.secret || form.get("redirect_uri") !== this.callback)
				return json({ ok: false });
			this.codes.delete(code);
			const token = randomUUID();
			this.tokens.add(token);
			return json({ ok: true, team: this.team, bot_user_id: this.bot, access_token: token, token_type: "bot", scope });
		}
		const token = req.headers.authorization?.slice(7) ?? "";
		if (!this.tokens.has(token)) return json({ ok: false, error: "invalid_auth" });
		switch (url.pathname) {
			case "/api/conversations.info": {
				if (req.method !== "GET" || form.get("channel") !== this.channel.id)
					return json({ ok: false, error: "channel_not_found" });
				this.channelInfoCalls++;
				return json({ ok: true, channel: { ...this.channel, is_member: this.isMember, is_archived: this.archived } });
			}
			case "/api/conversations.list": {
				this.channelListCalls++;
				if (
					req.method !== "GET" ||
					form.get("types") !== "public_channel,private_channel" ||
					form.get("exclude_archived") !== "true"
				)
					return json({ ok: false });
				const second = form.get("cursor") === "page2";
				return json({
					ok: true,
					channels: second
						? [{ ...this.channel, is_member: true }]
						: [{ id: "COTHER", name: "not-joined", is_member: false }],
					response_metadata: { next_cursor: second ? "" : "page2" },
				});
			}
			case "/api/chat.postEphemeral":
				this.payloads.push([...form.values()].join("\n"));
				this.privateReplies.push({ user: form.get("user")!, text: form.get("text")!, thread: form.get("thread_ts") });
				return json({ ok: true });
			case "/api/chat.postMessage": {
				this.payloads.push([...form.values()].join("\n"));
				const ts = `1711111111.${String(this.messages.length + 1).padStart(6, "0")}`;
				this.messages.push({
					ts,
					channel: form.get("channel")!,
					text: form.get("text")!,
					thread: form.get("thread_ts"),
					blocks: JSON.parse(form.get("blocks") ?? "[]"),
				});
				return json({ ok: true, ts });
			}
			case "/api/chat.update": {
				this.payloads.push([...form.values()].join("\n"));
				const message = this.messages.find(m => m.ts === form.get("ts") && m.channel === form.get("channel"));
				if (!message) return json({ ok: false, error: "message_not_found" });
				Object.assign(message, { text: form.get("text")!, blocks: JSON.parse(form.get("blocks") ?? "[]") });
				this.updates.push({ ts: message.ts, text: message.text, blocks: message.blocks });
				return json({ ok: true, ts: message.ts });
			}
			case "/api/views.open": {
				const trigger = form.get("trigger_id")!;
				if (!this.triggers.delete(trigger)) return json({ ok: false, error: "expired_trigger_id" });
				this.views.push({ trigger, view: JSON.parse(form.get("view")!) });
				return json({ ok: true });
			}
			case "/api/auth.revoke":
				this.tokens.delete(token);
				return json({ ok: true });
			default:
				res.writeHead(404).end();
		}
	});
	constructor(private readonly callback: string) {}
	async start() {
		await new Promise<void>(ok => this.server.listen(0, "127.0.0.1", ok));
	}
	async stop() {
		this.server.closeAllConnections();
		await new Promise<void>(ok => this.server.close(() => ok()));
	}
	get url() {
		return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
	}
	authorize(consent: string) {
		const url = new URL(consent),
			q = url.searchParams;
		if (url.origin !== this.url || url.pathname !== "/oauth/v2/authorize" || q.get("redirect_uri") !== this.callback)
			throw new Error("Wrong OAuth destination");
		const code = randomUUID();
		this.codes.set(code, q.get("scope")!);
		return this.callback + "?" + new URLSearchParams({ state: q.get("state")!, code });
	}
	/** Each mention starts its own thread unless `thread` names one. */
	mention(
		text = "Update the setup guide",
		user = this.member,
		thread = `1710000000.${String(++this.threads).padStart(6, "0")}`,
	) {
		return {
			type: "event_callback",
			team_id: this.team.id,
			event_id: "Ev" + randomUUID().replaceAll("-", ""),
			authorizations: [{ is_bot: true, user_id: this.bot }],
			event: {
				type: "app_mention",
				channel: this.channel.id,
				user,
				text: `<@${this.bot}> ${text}`,
				ts: "1710000001.123456",
				thread_ts: thread,
			},
		};
	}
	private threads = 0;
	/** The buttons of a posted message, by action id. */
	buttons(message: SlackPosted) {
		return message.blocks.filter(b => b.type === "actions").flatMap(b => b.elements as Block[]);
	}
	/** A press of a posted button, as Slack sends it to the Interactivity Request URL. */
	press(url: string, message: SlackPosted, actionId: string, user = this.member) {
		const action = this.buttons(message).find(b => b.action_id === actionId);
		if (!action) throw new Error(`No ${actionId} button`);
		const trigger = randomUUID();
		this.triggers.add(trigger);
		return this.interact(url, {
			type: "block_actions",
			team: { id: this.team.id },
			user: { id: user },
			trigger_id: trigger,
			container: { type: "message", channel_id: message.channel, message_ts: message.ts, thread_ts: message.thread },
			actions: [{ action_id: action.action_id, value: action.value, action_ts: String(Date.now() / 1000) }],
		});
	}
	submit(url: string, view: Block, note: string, user = this.member) {
		return this.interact(url, {
			type: "view_submission",
			team: { id: this.team.id },
			user: { id: user },
			trigger_id: randomUUID(),
			view: {
				...view,
				id: "V" + randomUUID().slice(0, 8),
				state: { values: { note: { note: { type: "plain_text_input", value: note } } } },
			},
		});
	}
	private interact(url: string, payload: unknown) {
		return this.send(url, new URLSearchParams({ payload: JSON.stringify(payload) }).toString(), { command: true });
	}
	send(url: string, body: string, opts: { retry?: number; stamp?: string; tamper?: boolean; command?: boolean } = {}) {
		const stamp = opts.stamp ?? String(Math.floor(Date.now() / 1000));
		const signature = createHmac("sha256", this.signing).update(`v0:${stamp}:${body}`).digest("hex");
		return fetch(url, {
			method: "POST",
			body: opts.tamper ? body + " " : body,
			headers: {
				"content-type": opts.command ? "application/x-www-form-urlencoded" : "application/json",
				"x-slack-request-timestamp": stamp,
				"x-slack-signature": "v0=" + signature,
				...(opts.retry && { "x-slack-retry-num": String(opts.retry) }),
			},
		});
	}
}
