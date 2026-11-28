/**
 * Keeps credentials out of what is shown or logged. Text that comes back from GitHub or from git (an
 * error's message, the end of standard error) passes through here before it goes anywhere: the tokens
 * the caller knows it used are taken out by value, in the forms they travel in, and anything else
 * that looks like a GitHub token by its prefix.
 */

/** GitHub's token prefixes: installation (`ghs_`), user (`ghu_`), refresh (`ghr_`), OAuth, personal. */
const TOKEN_SHAPE = /\b(?:gh[pousr]_[A-Za-z0-9_.-]{16,}|github_pat_[A-Za-z0-9_]{20,})/g;
/** Distinctive credentials used by the routed providers. A bare sk- key is shared
 * by several providers, so its diagnostic deliberately does not attribute it. */
const PUSH_TOKEN_SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
	["Anthropic OAuth setup token", /sk-ant-oat01-[A-Za-z0-9_-]{16,512}/],
	["Anthropic API key", /sk-ant-api03-[A-Za-z0-9_-]{16,512}/],
	["Anthropic admin key", /sk-ant-admin01-[A-Za-z0-9_-]{16,512}/],
	["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,600}/],
	["OpenCode API key", /oc_sk_[A-Za-z0-9_-]{16,512}/],
	["OpenAI API key", /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{16,512}/],
	["OpenRouter API key", /sk-or-v1-[A-Za-z0-9]{16,512}/],
	["Alibaba plan API key", /sk-sp-[A-Za-z0-9_-]{16,512}/],
	["MiniMax API key", /sk-(?:api|cp)-[A-Za-z0-9_-]{16,512}/],
	["Kimi API key", /sk-kimi-[A-Za-z0-9_-]{16,512}/],
	["Groq API key", /gsk_[A-Za-z0-9]{32,512}/],
	["Google API key", /AIza[A-Za-z0-9_-]{35}/],
	["Hugging Face access token", /hf_[A-Za-z0-9]{30,512}/],
	["Perplexity API key", /pplx-[A-Za-z0-9_-]{24,512}/],
	["xAI API key", /xai-[A-Za-z0-9]{32,512}/],
	["NVIDIA API key", /nvapi-[A-Za-z0-9_-]{24,512}/],
	["Fireworks API key", /fw_[A-Za-z0-9]{24,512}/],
	["Cerebras API key", /csk-[A-Za-z0-9_-]{24,512}/],
	["Vercel AI Gateway key", /vck_[A-Za-z0-9_-]{24,512}/],
	["provider API key", /\bsk-[A-Za-z0-9]{32,512}/],
	["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9_.-]{16,512}|github_pat_[A-Za-z0-9_]{20,512})/],
];

/** Returning only labels also keeps credentials embedded in Git paths out of refusal messages. */
export function pushTokenKinds(patch: string): string[] {
	return PUSH_TOKEN_SHAPES.filter(([, pattern]) => pattern.test(patch)).map(([kind]) => kind);
}

/** git log emits the full SHA on its own line and a NUL after each raw commit message.
 * Hunk content always has a prefix, even when the added text resembles a patch header. */
export function outgoingCredentials(patch: string, cleanPath = (path: string) => path): string[] {
	const findings = new Set<string>();
	let message = false,
		hunk = false;
	let path: string | undefined;
	for (const line of patch.split("\n")) {
		if (!message && /^[0-9a-f]{40}$/.test(line)) {
			message = true;
			path = undefined;
			hunk = false;
			continue;
		}
		if (message) {
			if (line.includes("\0")) message = false;
		} else if (line.startsWith("diff --git ")) {
			hunk = false;
			const header = line.slice(11);
			path = pushTokenKinds(header).length ? undefined : cleanPath(header.match(/ b\/(.+)$/)?.[1] ?? "");
		} else if (!hunk && line.startsWith("+++ ")) {
			const destination = line.slice(4).trimEnd();
			const name = destination.startsWith('"b/') ? '"' + destination.slice(3) : destination.replace(/^b\//, "");
			path = destination === "/dev/null" || pushTokenKinds(name).length ? undefined : cleanPath(name);
		} else if (line.startsWith("@@ ")) {
			hunk = true;
			continue;
		} else if (
			!(hunk && line.startsWith("+")) &&
			!(!hunk && /^(?:--- |rename (?:from|to) |copy (?:from|to) )/.test(line))
		) {
			continue;
		}
		for (const kind of pushTokenKinds(line)) findings.add(path ? `${kind} in ${path}` : kind);
	}
	return [...findings];
}

/** A credential in an address (`https://user:secret@host`) and in a header. */
const URL_CREDENTIAL = /(\bhttps?:\/\/)[^\s/@:]+:[^\s/@]+@/g;
const HEADER_CREDENTIAL = /\b(authorization:\s*(?:basic|bearer|token)\s+)[A-Za-z0-9._~+/=-]+/gi;

export function redact(text: string, secrets: Array<string | null | undefined> = []): string {
	let out = text;
	for (const secret of secrets) {
		if (typeof secret !== "string" || secret.length < 6) continue;
		const forms = [
			secret,
			Buffer.from(secret, "utf8").toString("base64"),
			Buffer.from(`x-access-token:${secret}`, "utf8").toString("base64"),
			Buffer.from(`oauth2:${secret}`, "utf8").toString("base64"),
			encodeURIComponent(secret),
		];
		for (const form of forms) out = out.split(form).join("[redacted]");
	}
	return out
		.replace(TOKEN_SHAPE, "[redacted]")
		.replace(URL_CREDENTIAL, "$1[redacted]@")
		.replace(HEADER_CREDENTIAL, "$1[redacted]");
}
