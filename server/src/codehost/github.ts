import { createHmac, timingSafeEqual } from "node:crypto";
import { githubConfig } from "../config.js";
import { GithubError, type GithubApp, type TokenScope } from "../github/app.js";
import { readCi, rerunJobs } from "../github/ci.js";
import { edge, type Delivery } from "../github/events.js";
import { refHead } from "../github/feature.js";
import { parseGithubJson } from "../github/ids.js";
import { openFromPushed, type StoredRepository } from "../github/publish.js";
import { listRepositories, type StoredConnection } from "../github/repos.js";
import { webhookRoute } from "../github/webhook.js";
import type { Access, CodeHost } from "./types.js";

const permissions = {
	"pull:read": { pull_requests: "read" },
	"pull:write": { contents: "read", pull_requests: "write" },
	merge: { contents: "write", pull_requests: "write" },
	"comment:read": { issues: "read" },
	"comment:write": { issues: "write" },
	"log:read": { actions: "read" },
} satisfies Record<Access, Partial<TokenScope["permissions"]>>;

export function githubCodeHost(app: GithubApp): CodeHost<StoredConnection, StoredRepository, Delivery> {
	return {
		cloneUrl: app.cloneUrl.bind(app),
		pushUrl: app.cloneUrl.bind(app),
		withToken: (target, access, step) =>
			app.withToken(
				target.installationId,
				{
					repositoryId: target.repositoryId,
					permissions: { metadata: "read", ...permissions[access] },
				},
				step,
			),
		gitCredential: (target, access) => app.gitCredential(target.installationId, target.repositoryId, access),

		openPull: app.createPull.bind(app),
		openFromPushed: input => openFromPushed({ ...input, app }),
		readPull: app.pull.bind(app),
		updatePull: app.updatePull.bind(app),
		mergePull: app.squashMerge.bind(app),
		async closePull(token, owner, name, number) {
			await app.call({
				method: "PATCH",
				path: `/repos/${owner}/${name}/pulls/${number}`,
				auth: { bearer: token },
				body: { state: "closed" },
				what: "close the pull request",
			});
		},

		hasBranch: (token, owner, name, branch) =>
			refHead(app, token, owner, name, branch).then(
				() => true,
				(error: unknown) => {
					if (error instanceof GithubError && error.status === 404) return false;
					throw error;
				},
			),

		readCi: (target, options) => readCi(app, target, options),
		jobLog: app.jobLog.bind(app),
		rerunJobs: (target, jobs) => rerunJobs(app, target, jobs),
		listComments: app.issueComments.bind(app),
		createComment: app.createIssueComment.bind(app),
		updateComment: app.updateIssueComment.bind(app),
		react: app.react.bind(app),
		listRepositories: (connection, query) => listRepositories(app, connection, query),

		webhookRoute,
		parseWebhook(headers, bytes) {
			const { webhook } = githubConfig();
			const signature = headers.get("x-hub-signature-256") ?? "";
			const event = headers.get("x-github-event") ?? "";
			const guid = headers.get("x-github-delivery") ?? "";
			if (
				!webhook ||
				bytes.byteLength > 2 * 1024 * 1024 ||
				!/^sha256=[a-fA-F0-9]{64}$/.test(signature) ||
				!/^[a-z_]{1,64}$/.test(event) ||
				!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(guid) ||
				headers.get("x-github-hook-installation-target-id") !== app.settings.appId
			)
				throw new Error("Invalid GitHub delivery.");
			const mac = Buffer.from(signature.slice(7), "hex");
			if (!webhook.secrets.some(secret => timingSafeEqual(mac, createHmac("sha256", secret).update(bytes).digest())))
				throw new Error("Invalid GitHub signature.");
			let payload: unknown;
			try {
				payload = parseGithubJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
			} catch {
				throw new Error("Invalid GitHub delivery body.");
			}
			return edge(event, payload, { slug: app.settings.slug, appId: app.settings.appId, guid, at: Date.now() });
		},
	};
}
