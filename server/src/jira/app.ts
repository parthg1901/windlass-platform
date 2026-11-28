import { jiraClientSecret, jiraConfig } from "../config.js";
import type { JiraSite } from "../contract.js";
import type { JiraCommentAction } from "../factory/intake.js";

export const JIRA_SCOPES = ["read:jira-user", "read:jira-work", "write:jira-work", "manage:jira-webhook"];
export interface JiraToken {
	accessToken: string;
	refreshToken: string | null;
	expiresAt: number | null;
}
export class JiraError extends Error {
	constructor(
		readonly status: number,
		readonly retryAt = 0,
	) {
		super(`Jira request failed (${status}).`);
	}
}
type Person = { accountId: string; displayName: string };
type Node = { type: string; text?: string; attrs?: { text?: string }; content?: Node[] };
function visible(node?: Node, depth = 0): string {
	if (!node || depth > 64) return "";
	if (node.type === "text") return node.text ?? "";
	if (node.type === "hardBreak") return "\n";
	if (node.type === "mention") return node.attrs?.text ?? "";
	const body = node.content?.map(child => visible(child, depth + 1)).join("") ?? "";
	return ["paragraph", "heading", "codeBlock"].includes(node.type) ? body + "\n" : body;
}
const person = (p?: Person) => (p?.accountId ? { id: p.accountId, name: p.displayName } : null);
const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

export class JiraApp {
	constructor(readonly settings: NonNullable<ReturnType<typeof jiraConfig>["app"]>) {}
	authorizeUrl(state: string) {
		const query = new URLSearchParams({
			audience: "api.atlassian.com",
			client_id: this.settings.clientId,
			redirect_uri: this.settings.redirectUrl,
			response_type: "code",
			prompt: "consent",
			scope: [...JIRA_SCOPES, "offline_access"].join(" "),
			state,
		});
		return `${this.settings.authUrl}/authorize?${query}`;
	}
	private async send(url: string, method = "GET", token?: string, body?: unknown) {
		try {
			const res = await fetch(url, {
				method,
				redirect: "manual",
				signal: AbortSignal.timeout(20_000),
				body: JSON.stringify(body),
				headers: {
					accept: "application/json",
					...(token && { authorization: `Bearer ${token}` }),
					...(body !== undefined && { "content-type": "application/json" }),
				},
			});
			if (!res.ok) {
				const after = res.headers.get("retry-after") ?? "";
				throw new JiraError(
					res.status,
					/^\d+$/.test(after) ? Date.now() + Number(after) * 1000 : Date.parse(after) || 0,
				);
			}
			const chunks: Uint8Array[] = [];
			let size = 0;
			for await (const part of res.body ?? []) {
				size += part.length;
				if (size > 1024 * 1024) throw new JiraError(502);
				chunks.push(part);
			}
			return size ? JSON.parse(Buffer.concat(chunks).toString()) : null;
		} catch (error) {
			throw error instanceof JiraError ? error : new JiraError(0);
		}
	}
	private async token(form: Record<string, string>): Promise<JiraToken> {
		const row = await this.send(`${this.settings.authUrl}/oauth/token`, "POST", undefined, {
			...form,
			client_id: this.settings.clientId,
			client_secret: jiraClientSecret(),
		});
		if (!row?.access_token) throw new JiraError(502);
		return {
			accessToken: row.access_token,
			refreshToken: row.refresh_token ?? null,
			expiresAt: positive(row.expires_in) ? Date.now() + row.expires_in * 1000 : null,
		};
	}
	exchangeCode(code: string) {
		return this.token({ grant_type: "authorization_code", code, redirect_uri: this.settings.redirectUrl });
	}
	refresh(refresh_token: string) {
		return this.token({ grant_type: "refresh_token", refresh_token });
	}

	async sites(token: string): Promise<JiraSite[]> {
		const rows: (JiraSite & { scopes: string[] })[] = await this.send(
			`${this.settings.apiUrl}/oauth/token/accessible-resources`,
			"GET",
			token,
		);
		return rows.flatMap(({ id, name, url, scopes }) => {
			const site = URL.parse(url);
			return /^[a-z0-9][a-z0-9-]{0,127}$/.test(id) &&
				site?.protocol === "https:" &&
				!site.username &&
				!site.password &&
				JIRA_SCOPES.every(s => scopes.includes(s))
				? [{ id, name, url: site.origin }]
				: [];
		});
	}
	private rest(token: string, site: string, path: string, method = "GET", body?: unknown) {
		return this.send(`${this.settings.apiUrl}/ex/jira/${site}/rest/api/3/${path}`, method, token, body);
	}
	async identity(token: string, site: string) {
		const user = person(await this.rest(token, site, "myself"));
		if (!user) throw new JiraError(502);
		return user;
	}
	private async pages<T>(token: string, site: string, path: string, field = "values") {
		const result: T[] = [];
		for (let page = 0; page < 100; page++) {
			const start = result.length,
				row = await this.rest(token, site, `${path}?startAt=${start}&maxResults=100`);
			const values: T[] = row[field];
			if (!Array.isArray(values) || (row.startAt !== undefined && row.startAt !== start)) throw new JiraError(502);
			result.push(...values);
			if (
				row.isLast ||
				result.length >= row.total ||
				(row.isLast !== false && !row.nextPage && row.total === undefined && values.length < (row.maxResults ?? 100))
			)
				return result;
			if (!values.length) break;
		}
		throw new JiraError(502);
	}
	async projects(token: string, site: string) {
		return (await this.pages<{ id: string; key: string; name: string }>(token, site, "project/search"))
			.filter(p => /^[1-9]\d{0,31}$/.test(p.id) && p.key)
			.map(({ id, key, name }) => ({ id, key, name }));
	}
	async issue(token: string, site: string, id: string) {
		let row;
		try {
			row = await this.rest(
				token,
				site,
				`issue/${id}?fields=project,summary,description,labels,creator,reporter,assignee,issuetype,status`,
			);
		} catch (error) {
			if (error instanceof JiraError && error.status === 404) return null;
			throw error;
		}
		const f = row.fields,
			reporter = person(f.reporter);
		if (!/^[A-Za-z][A-Za-z0-9_]{0,31}-\d{1,16}$/.test(row.key)) throw new JiraError(502);
		return {
			id: String(row.id),
			identifier: String(row.key),
			projectId: String(f.project.id),
			title: String(f.summary ?? ""),
			description: visible(f.description).trimEnd(),
			labels: (Array.isArray(f.labels) ? f.labels.filter((s: unknown) => typeof s === "string") : []) as string[],
			creator: person(f.creator) ?? reporter,
			reporter,
			assignee: person(f.assignee),
			issueType: String(f.issuetype?.name ?? ""),
			closed: f.status?.statusCategory?.key === "done",
		};
	}
	async progress(token: string, site: string, issue: string, author: string, item: string, action: JiraCommentAction) {
		const path = `issue/${issue}/comment`,
			marker = `[windlass:${item}:${action.key}]`;
		const comments = await this.pages<{ author?: Person; body: Node }>(token, site, path, "comments");
		if (comments.some(c => c.author?.accountId === author && visible(c.body).split("\n").includes(marker))) return;
		const wording = {
			filed: "Filed as a Windlass draft.",
			opened: "Windlass opened a pull request.",
			done: "The Windlass work item is done.",
			failed: "The Windlass work item failed.",
			cancelled: "The Windlass work item was cancelled.",
		};
		const paragraph = (text: string, href?: string) => {
			const url = href === undefined ? null : URL.parse(href);
			if (href !== undefined && (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password))
				throw new Error("Invalid Jira comment link");
			return {
				type: "paragraph",
				content: [{ type: "text", text, ...(url && { marks: [{ type: "link", attrs: { href: url.href } }] }) }],
			};
		};
		const content = [paragraph(wording[action.key]), paragraph(marker), paragraph("Work item", action.itemUrl)];
		if (action.pr) content.push(paragraph("Pull request", action.pr));
		await this.rest(token, site, path, "POST", { body: { type: "doc", version: 1, content } });
	}
	async registerWebhook(token: string, site: string, url: string, jqlFilter: string) {
		const row = await this.rest(token, site, "webhook", "POST", {
			url,
			webhooks: [{ jqlFilter, events: ["jira:issue_created", "jira:issue_updated"] }],
		});
		const id = row.webhookRegistrationResult?.[0]?.createdWebhookId;
		if (!positive(id)) throw new JiraError(502);
		return id;
	}
	async refreshWebhook(token: string, site: string, id: number) {
		const { expirationDate } = await this.rest(token, site, "webhook/refresh", "PUT", { webhookIds: [id] });
		const expires = typeof expirationDate === "number" ? expirationDate : Date.parse(expirationDate);
		if (!positive(expires)) throw new JiraError(502);
		return expires;
	}
	async hasWebhook(token: string, site: string, id: number) {
		return (await this.pages<{ id: number }>(token, site, "webhook")).some(h => h.id === id);
	}
	deleteWebhook(token: string, site: string, id: number) {
		return this.rest(token, site, "webhook", "DELETE", { webhookIds: [id] });
	}
}
export function jiraApp() {
	const { app } = jiraConfig();
	return app && new JiraApp(app);
}
