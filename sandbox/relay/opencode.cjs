// This process owns refresh. Setup stops it before replacing or removing a login.
const { createPublicKey, randomUUID } = require("node:crypto");
const { readFile, rename, unlink, writeFile } = require("node:fs/promises");
const { rmSync } = require("node:fs");
const { createRelay, scrubStream, stopOnSignal, SIGNED_OUT, Stopping, NOTES_FILE } = require("./server.cjs");

const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const filename = "/run/wlp-harness/opencode/login.json";
const { providers } = require("./providers.json");

const kinds = {
	"/chat/completions": "chat",
	"/responses": "responses",
	"/messages": "messages",
	"/openai/chat/completions": "deepinfra",
	"/chat": "cohere",
	"/language-model": "gateway",
};

function endpointFor(allowed, url, headers = {}) {
	const at = url.indexOf("/", 1);
	if (!url.startsWith("/") || at < 2) return;
	let id = url.slice(1, at);
	const suffix = url.slice(at);
	if (id === "openai" && allowed.has("chatgpt")) id = "chatgpt";
	if (!allowed.has(id)) return;
	if (id === "chatgpt")
		return (
			suffix === "/responses" && {
				id,
				kind: "responses",
				hostname: "chatgpt.com",
				path: "/backend-api/codex/responses",
			}
		);
	if (id === "free")
		return (
			suffix === "/chat/completions" && {
				id,
				kind: "free",
				hostname: "opencode.ai",
				path: "/inference/openai/v1/chat/completions",
			}
		);
	const p = providers[id];
	const kind = Object.hasOwn(kinds, suffix)
		? kinds[suffix]
		: /^\/models\/[A-Za-z0-9_.-]+:(?:generateContent|streamGenerateContent\?alt=sse)$/.test(suffix)
			? "google"
			: undefined;
	if (!kind || !p?.routes[kind]) return;
	let base = p.routes[kind];
	if (headers["x-wlp-route"]) {
		const variant = p.variants?.[headers["x-wlp-route"]];
		if (!Array.isArray(variant) || variant[0] !== kind) return;
		base = variant[1];
	}
	const dest = new URL(base);
	return { id, kind, hostname: dest.hostname, path: dest.pathname.replace(/\/$/, "") + suffix };
}

function claims(token) {
	try {
		return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
	} catch {
		return {};
	}
}
function accountId(token) {
	const c = claims(token);
	return c.chatgpt_account_id || c["https://api.openai.com/auth"]?.chatgpt_account_id || c.organizations?.[0]?.id;
}

async function save(record) {
	const temp = filename + "." + randomUUID();
	try {
		await writeFile(temp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
		await rename(temp, filename);
	} finally {
		await unlink(temp).catch(() => {});
	}
}
function providerFor(
	provider,
	generation,
	{
		load = async () => JSON.parse(await readFile(filename, "utf8")),
		persist = save,
		exchange = fetch,
		responses = false,
	} = {},
) {
	const allowed = new Set(Array.isArray(provider) ? provider : [provider]);
	for (const id of allowed)
		if (!["chatgpt", "free"].includes(id) && !Object.hasOwn(providers, id)) throw new Error("Unsupported provider.");
	let refresh,
		stopping = false;
	const secrets = new Set();
	function remember(record) {
		for (const value of [record.key, record.refresh, record.access]) if (value) secrets.add(value);
	}
	function select(store, id) {
		if (store.generation !== generation) return;
		const record = store.records ? store.records[id] : store;
		if (record?.provider === id && (id === "free" || (id === "chatgpt" ? record.refresh && record.access : record.key)))
			return record;
	}
	async function credential(provider) {
		const record = select(await load(), provider);
		if (!record) return;
		remember(record);
		if (provider !== "chatgpt" || record.expires > Date.now() + 30000) return record;
		// A stopping relay starts no refresh it might not live to save. The relay answers 503, or 401 after a logout.
		if (stopping && !refresh) throw new Stopping();
		// Re-read inside the single flight: a concurrent request may have already rotated.
		return (refresh ??= (async () => {
			const store = await load();
			const latest = select(store, provider);
			if (!latest) return;
			if (latest.expires > Date.now() + 30000) return latest;
			const res = await exchange("https://auth.openai.com/oauth/token", {
				method: "POST",
				redirect: "error",
				signal: AbortSignal.timeout(20000),
				body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: latest.refresh }),
			});
			if (!res.ok) return;
			const tokens = await res.json();
			if (
				typeof tokens.access_token !== "string" ||
				!tokens.access_token ||
				(tokens.refresh_token !== undefined && (typeof tokens.refresh_token !== "string" || !tokens.refresh_token)) ||
				!Number.isFinite(tokens.expires_in) ||
				tokens.expires_in <= 0
			)
				return;
			const id = accountId(tokens.id_token) || accountId(tokens.access_token);
			// The token endpoint may keep the refresh token unchanged and omit it from the reply.
			const next = {
				...latest,
				access: tokens.access_token,
				refresh: tokens.refresh_token ?? latest.refresh,
				accountId: id || latest.accountId,
				expires: Date.now() + 1000 * tokens.expires_in,
			};
			await persist(store.records ? { ...store, records: { ...store.records, [provider]: next } } : next);
			remember(next);
			return next;
		})().finally(() => {
			refresh = undefined;
		}));
	}
	return {
		/** Starts no further refresh and settles once an in-flight refresh has been saved or abandoned. */
		async drain() {
			stopping = true;
			await refresh?.catch(() => {});
		},
		responseFilter: type => (secrets.size ? scrubStream(secrets, type, responses) : undefined),
		/** The credentials this relay has read, so no forwarded header can carry one. */
		secrets: () => secrets,
		accepts: url => Boolean(endpointFor(allowed, url)),
		// A ChatGPT sign-in's stream comes from chatgpt.com/backend-api, which may send its 200 without a content
		// type: only that route is read as an event stream. API-key providers name their types.
		untyped: (method, url) =>
			method === "POST" && endpointFor(allowed, url)?.id === "chatgpt" ? "text/event-stream" : null,
		bearer(h, url) {
			const kind = url ? endpointFor(allowed, url, h)?.kind : provider;
			// Sessions created by older runners carry the lease in a separate header.
			if (kind === "free" && h["x-wlp-session"] && (!h.authorization || h.authorization === "Bearer public"))
				return "Bearer " + h["x-wlp-session"];
			if (kind === "messages") return "Bearer " + h["x-api-key"];
			if (kind === "google") return "Bearer " + h["x-goog-api-key"];
			return h.authorization;
		},
		async target(url, h) {
			const endpoint = endpointFor(allowed, url, h);
			if (!endpoint) return;
			const provider = endpoint.id;
			const record = await credential(provider);
			if (!record) return;
			const headers = { "content-type": "application/json" };
			const allowedHeaders =
				provider === "free"
					? ["user-agent", "accept", "accept-encoding", "content-length", "x-parent-session-id"]
					: [
							"user-agent",
							"x-title",
							"http-referer",
							"x-source",
							"x-cerebras-3rd-party-integration",
							"x-billing-invoke-origin",
						];
			if (endpoint.hostname === "opencode.ai")
				allowedHeaders.push(
					"x-opencode-client",
					"x-opencode-session",
					"x-opencode-session-id",
					"x-opencode-parent-session-id",
					"x-opencode-project",
					"x-opencode-request",
				);
			for (const name of allowedHeaders) if (h[name]) headers[name] = h[name];
			if (provider === "free") headers.authorization = "Bearer public";
			else if (endpoint.kind === "google") headers["x-goog-api-key"] = record.key;
			else if (endpoint.kind === "messages") {
				headers["x-api-key"] = record.key;
				headers["anthropic-version"] = "2023-06-01";
				if (h["anthropic-beta"]) headers["anthropic-beta"] = h["anthropic-beta"];
			} else {
				headers.authorization = "Bearer " + (provider === "chatgpt" ? record.access : record.key);
				if (endpoint.kind === "gateway") {
					headers["ai-gateway-auth-method"] = "api-key";
					for (const k of [
						"ai-gateway-protocol-version",
						"ai-language-model-specification-version",
						"ai-language-model-id",
						"ai-language-model-streaming",
					])
						if (h[k]) headers[k] = h[k];
				}
				if (provider === "chatgpt") {
					headers.originator = "opencode";
					if (record.accountId) headers["chatgpt-account-id"] = record.accountId;
					const c = claims(record.access);
					const residency = c["https://api.openai.com/auth"]?.chatgpt_compute_residency ?? c.chatgpt_compute_residency;
					if (residency && residency !== "no_constraint") headers["x-openai-internal-codex-residency"] = residency;
				}
			}
			return { hostname: endpoint.hostname, path: endpoint.path, headers };
		},
	};
}
function turnLogin(provider) {
	async function authorize(bearer, nonce, url) {
		const match = /^Bearer (wlp-login\.[a-f0-9]{32})$/.exec(bearer ?? "");
		if (!match || !/^[a-f0-9]{32}$/.test(nonce)) return false;
		const record = await readFile("/run/wlp-keys/" + nonce + ".login", "utf8")
			.then(JSON.parse)
			.catch(() => null);
		const id = url.split("/")[1];
		return record?.placeholder === match[1] && record.allowed.some(p => (p === "chatgpt" ? "openai" : p) === id);
	}
	return {
		...provider,
		authorize,
		async target(url, headers, nonce) {
			if (await authorize(provider.bearer(headers, url), nonce, url)) return provider.target(url, headers);
		},
	};
}
exports.providerFor = providerFor;
if (process.env.WLP_OPENCODE_RELAY_PUBLIC_KEY) {
	const generation = process.env.WLP_OPENCODE_GENERATION;
	const publicKey = createPublicKey({
		key: Buffer.from(process.env.WLP_OPENCODE_RELAY_PUBLIC_KEY, "base64"),
		format: "der",
		type: "spki",
	});
	const socket = "/workspace/relay.sock";
	rmSync(socket, { force: true });
	rmSync(SIGNED_OUT, { force: true });
	const provider = providerFor((process.env.WLP_OPENCODE_PROVIDER || "").split(",").filter(Boolean), generation);
	stopOnSignal(
		createRelay({
			publicKey,
			machine: process.env.WLP_OPENCODE_RELAY_MACHINE,
			provider: turnLogin(provider),
			notesFile: NOTES_FILE,
		}).listen(socket),
		provider,
	);
}
