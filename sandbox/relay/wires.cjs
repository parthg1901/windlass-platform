const { createHmac } = require("node:crypto");

const wires = {
	// A ChatGPT plan's access token, the one Windlass's own sign-in refreshes. OpenAI takes it as a bearer at
	// api.openai.com for Responses and for its model catalog, as it does for Windlass's ChatGPT models. Codex sends
	// headers of its own besides; only these are passed on.
	"chatgpt-plan": {
		base: "/v1",
		host: "api.openai.com",
		models: "/v1/models",
		posts: ["/v1/responses"],
		passed: ["content-type", "session-id"],
		dropUnknown: true,
		zstd: true,
	},
	openai: {
		base: "/v1",
		host: "api.openai.com",
		models: "/v1/models",
		posts: ["/v1/responses", "/v1/chat/completions"],
		passed: ["session-id"],
		zstd: true,
		drop: [
			"openai-organization",
			"openai-project",
			"originator",
			"thread-id",
			"x-client-feature-id",
			"x-client-request-id",
			"x-codex-beta-features",
			"x-codex-window-id",
			"x-codex-turn-metadata",
			"x-openai-internal-codex-responses-lite",
		],
	},
	anthropic: {
		base: "",
		host: "api.anthropic.com",
		models: "/v1/models",
		posts: [
			"/v1/messages",
			"/v1/messages?beta=true",
			"/v1/messages/count_tokens",
			"/v1/messages/count_tokens?beta=true",
		],
		auth: "x-api-key",
		fixed: { "anthropic-version": "2023-06-01" },
		betas: [
			"interleaved-thinking-2025-05-14",
			"claude-code-20250219",
			"context-management-2025-06-27",
			"per-turn-control-2026-07-01",
			"mid-conversation-tool-changes-2026-07-01",
			"thinking-token-count-2026-05-13",
			"thinking-display-updates-2026-08-18",
			"advanced-tool-use-2025-11-20",
			"effort-2025-11-24",
			"thinking-binding-controls-2026-08-01",
			"fine-grained-tool-streaming-2025-05-14",
			"structured-outputs-2025-11-13",
			"inline-tools-2026-09-15",
			"advisor-tool-2026-03-01",
		],
		drop: ["anthropic-dangerous-direct-browser-access", "x-app", "x-client-request-id", "x-claude-code-session-id"],
	},
	google: {
		base: "",
		host: "generativelanguage.googleapis.com",
		models: "/v1beta/models",
		posts: [],
		auth: "x-goog-api-key",
		postPattern:
			/^\/v1beta\/models\/[A-Za-z0-9][A-Za-z0-9_.-]{0,159}:(?:generateContent|streamGenerateContent(?:\?alt=sse)?)$/,
		drop: ["x-goog-api-client"],
	},
	openrouter: {
		base: "/api/v1",
		host: "openrouter.ai",
		models: "/api/v1/models",
		posts: ["/api/v1/chat/completions"],
		drop: ["http-referer", "x-title"],
	},
};
// A Claude Pro/Max plan's `claude setup-token` token. Claude Code sends it as a bearer, with the OAuth beta.
wires["claude-plan"] = {
	...wires.anthropic,
	auth: undefined,
	betas: [...wires.anthropic.betas, "oauth-2025-04-20"],
};

const PLAN_WIRES = { anthropic: "claude-plan", openai: "chatgpt-plan" };

/** The wire a saved credential's requests take: a plan has its own, a Settings key its provider's. */
function credentialWire(ref) {
	if (!ref.plan) return ref.provider;
	// A plan's token must never go out the way an API key does.
	const wire = PLAN_WIRES[ref.provider];
	if (!wire) throw new Error(`No relay wire for a ${ref.provider} plan`);
	return wire;
}

const CODEX_CATALOG = /^\/v1\/models\?client_version=\d{1,4}\.\d{1,4}\.\d{1,4}$/;

// Codex adds its client version when listing models. OpenAI gets the canonical models route.
function wirePath(provider, path) {
	return (provider === "openai" || provider === "chatgpt-plan") && CODEX_CATALOG.test(path)
		? wires[provider].models
		: path;
}

// Windlass follows provider-issued catalog cursors before opening its session.
function catalogPage(provider, path) {
	if (provider === "anthropic") return /^\/v1\/models\?after_id=[A-Za-z0-9_.-]{1,200}$/.test(path);
	if (provider === "google")
		return /^\/v1beta\/models\?pageToken=(?:[A-Za-z0-9_.~-]|%2[BbFf]|%3[Dd]){1,2048}$/.test(path);
	return false;
}

// Ignore unknown beta names while preserving the order chosen by the client.
function allowedBetas(value, allowed) {
	return value
		.split(",")
		.map(name => name.trim())
		.filter(name => allowed.includes(name))
		.join(",");
}

function wireMethod(provider, path) {
	const wire = wires[provider];
	if (wirePath(provider, path) === wire.models || catalogPage(provider, path)) return "GET";
	if (wire.posts.includes(path) || wire.postPattern?.test(path)) return "POST";
}

function harnessMethod(harness, provider, path) {
	// Only Claude Code runs on a Claude plan, and only Codex and Windlass on a ChatGPT plan.
	if (provider === "claude-plan" && harness !== "claude") return;
	if (provider === "chatgpt-plan" && harness !== "codex" && harness !== "windlass") return;
	if (harness === "windlass") {
		if (path === wires[provider].models || catalogPage(provider, path)) return "GET";
		if (provider === "google")
			return wires.google.postPattern.test(path) && path.endsWith(":streamGenerateContent?alt=sse") && "POST";
		const generation = {
			openai: "/v1/responses",
			"chatgpt-plan": "/v1/responses",
			anthropic: "/v1/messages",
			openrouter: "/api/v1/chat/completions",
		};
		return path === generation[provider] && "POST";
	}
	if (catalogPage(provider, path)) return;
	if (harness === "codex") {
		if (provider === "openai") return wireMethod("chatgpt-plan", wirePath(provider, path));
		// codex-acp narrows its models by the bare listing's `data[]`, which ChatGPT's catalog (`models[]`) may not have:
		// refused, codex-acp leaves the list as Codex has it. Codex's own catalog request carries its client version.
		if (provider === "chatgpt-plan") return CODEX_CATALOG.test(path) ? "GET" : path === "/v1/responses" && "POST";
		return;
	}
	if (harness === "claude")
		return (provider === "anthropic" || provider === "claude-plan") && wireMethod(provider, path);
	if (harness === "opencode") return wireMethod(provider, path);
}

const forwardHost = value =>
	typeof value === "string" && value.length <= 253 && /^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/.test(value);
const forwardPlaceholder = value => typeof value === "string" && /^wlpm1\.[A-Za-z0-9_.-]{1,1018}$/.test(value);
const validProofKey = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const proofHeader = "x-wlp-machine-proof";
function forwardProof(key, machine, method, path, time) {
	return (
		time +
		"." +
		createHmac("sha256", key)
			.update(JSON.stringify([machine, method, path, time]))
			.digest("base64url")
	);
}
module.exports = {
	wires,
	credentialWire,
	allowedBetas,
	wirePath,
	wireMethod,
	harnessMethod,
	forwardHost,
	forwardPlaceholder,
	validProofKey,
	proofHeader,
	forwardProof,
};
