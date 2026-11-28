import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const scopes = ["read:jira-user", "read:jira-work", "write:jira-work", "manage:jira-webhook"];
const author = { accountId: "acct:ada", displayName: "Ada" };
function issue(id: string, labels: string[], assigned: boolean) {
	return {
		id,
		key: "ENG-" + id,
		fields: {
			project: { id: "10" },
			summary: "Task " + id,
			labels,
			creator: author,
			assignee: assigned ? author : null,
			description: {
				type: "doc",
				content: [{ type: "paragraph", content: [{ type: "text", text: "Print a greeting." }] }],
			},
			issuetype: { name: "Story" },
		},
	};
}
export class JiraStandin {
	readonly secret = randomUUID();
	readonly sites = ["acme", "harbor"].map(id => ({
		id,
		name: id.toUpperCase(),
		url: `https://${id}.atlassian.net`,
		scopes,
	}));
	readonly hooks = new Map<number, string>();
	readonly comments: {
		issue: string;
		body: { content: { content: { text: string; marks?: { attrs: { href: string } }[] }[] }[] };
		author: typeof author;
	}[] = [];
	readonly issues = new Map<string, ReturnType<typeof issue>>();
	readonly codes = new Set<string>();
	private readonly access = randomUUID();
	readAfterPost = false;
	private sequence = 0;
	private readonly server = createServer((req, res) => this.route(req, res).catch(() => res.writeHead(400).end()));
	constructor(readonly callback: string) {}
	async start() {
		await new Promise<void>(resolve => this.server.listen(0, "127.0.0.1", resolve));
	}
	get url() {
		return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
	}
	close() {
		this.server.closeAllConnections();
		return new Promise<void>(resolve => this.server.close(() => resolve()));
	}
	authorize(url: string) {
		const { origin, searchParams } = new URL(url);
		assert.equal(origin, this.url);
		assert.equal(searchParams.get("redirect_uri"), this.callback);
		assert.deepEqual(searchParams.get("scope")?.split(" ").sort(), [...scopes, "offline_access"].sort());
		const code = randomUUID();
		this.codes.add(code);
		return this.callback + "?" + new URLSearchParams({ code, state: searchParams.get("state")! });
	}
	issue(site: string, id: string, labels: string[], assigned = false) {
		const row = issue(id, labels, assigned);
		this.issues.set(site + "/" + id, row);
		return row;
	}
	event(issue: ReturnType<typeof this.issue>, hook: number) {
		return {
			webhookEvent: "jira:issue_created",
			timestamp: Date.now(),
			matchedWebhookIds: [hook],
			issue: structuredClone(issue),
			user: author,
		};
	}
	async post(url: string, body: object, id = randomUUID(), valid = true) {
		const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
		const jwt = part({ alg: "HS256" }) + "." + part({ aud: "windlass", exp: Math.floor(Date.now() / 1000) + 60 });
		const sig = createHmac("sha256", valid ? this.secret : "invalid")
			.update(jwt)
			.digest("base64url");
		const res = await fetch(url, {
			method: "POST",
			body: JSON.stringify(body),
			headers: { authorization: `Bearer ${jwt}.${sig}`, "x-atlassian-webhook-identifier": id },
		});
		assert.equal(res.status, valid ? 202 : 401);
		return (await res.json()).taken;
	}
	private async route(req: IncomingMessage, res: ServerResponse) {
		const { pathname, searchParams } = new URL(req.url!, this.url);
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
		const reply = (data: unknown) => res.end(JSON.stringify(data));
		if (pathname === "/oauth/token") {
			assert.ok(body.client_id === "windlass" && body.client_secret === this.secret && this.codes.delete(body.code));
			return reply({ access_token: this.access, refresh_token: randomUUID(), expires_in: 3600 });
		}
		assert.ok(req.headers.authorization === "Bearer " + this.access);
		if (pathname === "/oauth/token/accessible-resources") return reply(this.sites);
		const [, site, path] = /^\/ex\/jira\/(acme|harbor)\/rest\/api\/3\/(.+)$/.exec(pathname)!;
		if (path === "myself") return reply(author);
		if (path === "project/search")
			return reply({ isLast: true, values: [{ id: "10", key: "ENG", name: "Engineering" }] });
		if (path === "webhook" && req.method === "POST") {
			assert.equal(body.webhooks[0].jqlFilter, "project = 10");
			assert.deepEqual(body.webhooks[0].events, ["jira:issue_created", "jira:issue_updated"]);
			this.hooks.set(++this.sequence, body.url);
			return reply({ webhookRegistrationResult: [{ createdWebhookId: this.sequence }] });
		}
		if (path === "webhook/refresh" && this.hooks.has(body.webhookIds[0]))
			return reply({ expirationDate: Date.now() + 30 * 86_400_000 });
		if (path === "webhook" && req.method === "DELETE") {
			this.hooks.delete(body.webhookIds[0]);
			return res.end();
		}
		const [, id, comment] = /^issue\/(\d+)(\/comment)?$/.exec(path)!;
		const key = site + "/" + id;
		if (!this.issues.has(key)) return res.writeHead(404).end();
		if (!comment) return reply(this.issues.get(key));
		if (req.method === "POST") {
			this.comments.push({ issue: key, body: body.body, author });
			// The first successful write loses its reply. The outbox must reconcile its marker.
			if (this.comments.length === 1) return res.destroy();
			return reply({ id: String(this.comments.length) });
		}
		const all = this.comments.filter(c => c.issue === key),
			startAt = Number(searchParams.get("startAt"));
		if (all.length) this.readAfterPost = true;
		return reply({ startAt, total: all.length, comments: all.slice(startAt, startAt + 1) });
	}
}
