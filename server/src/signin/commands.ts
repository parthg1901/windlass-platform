/**
 * Windlass's sign-in commands, as steps over sign-in material (material.ts). Each step lends Windlass
 * the material for one command through a runner (runner.ts) and returns what Windlass left of it; none
 * of them stores anything. Whoever calls keeps the material: the `user` actor for a user's sign-in,
 * which the connect route put there (`npx @windlassai/cli connect codex` signs in on the person's computer).
 *
 *   token    `windlass login token --json --valid-for 20m`: prints `{"accessToken":"...","expiresAt":<ms>}`,
 *            the saved token when that is good for twenty minutes more (`TOKEN_VALID_FOR_MS`, handoff.ts)
 *            and otherwise a new one, for which it refreshes the sign-in first. Only the refresh needs
 *            the network, and it replaces the refresh token: `auth.json` comes back changed
 *
 *   models   `windlass --models --json` on an access token of the sign-in, and on no sign-in: prints the
 *            models the account's plan offers, one JSON object on a line each (`id`, `description`,
 *            `efforts`, `isDefault`). The token is handed in as a turn's is (`runWithToken`, runner.ts),
 *            so this command never refreshes anything
 *
 * A refresh cannot give a token that lasts longer than the service issues them (about an hour). Should
 * that be less than is asked for, Windlass prints the token all the same, exits 0 and says so in one
 * line on standard error: `token` reports it (`shorter`), and what follows from it is the holder's.
 *
 * When Windlass gives no token it exits 1 with one line on standard error, and what that means is read
 * from the stable code in the line's brackets, not from its words (`signInFailure`):
 *
 *   windlass: sign-in failed: <message> (<code>)
 *
 *   signed_out                           nobody is signed in: `SandboxUserError`, sign in with ChatGPT
 *   invalid_grant, ... (SIGN_IN_REFUSED) the sign-in service refused the refresh: `SandboxUserError`, the
 *                                        sign-in is no longer accepted. A turn's token file backs off on it
 *   network_error                        the sign-in service could not be reached: `SignInRefreshError`,
 *                                        not the user's doing, the sign-in is untouched
 *   any other                            the refresh did not complete (`refresh_locked`,
 *                                        `bad_token_response`, a code of the service's that is no
 *                                        refusal): `SignInRefreshError` as well
 *
 * Windlass reports an empty sign-in with its own line on stderr.
 *
 * The token is a secret. It is read from the command's standard output and from nowhere else, and that
 * output is never logged or put into an error: messages are made from the exit code and from standard
 * error, where Windlass never prints a token.
 */

import type { ListedModels } from "../account-models.js";
import type { ModelChoice } from "../contract.js";
import { type AccessToken, SandboxUserError } from "../sandbox/api.js";
import {
	NOT_SIGNED_IN,
	SIGNED_OUT,
	SIGN_IN_EXPIRED,
	SIGN_IN_REFUSED,
	SIGN_IN_UNREACHABLE,
	SignInRefreshError,
	loginTokenCommand,
	saysShorterThanAsked,
} from "../sandbox/handoff.js";
import { type SignInMaterial, hasSignIn } from "./material.js";
import type { LoginRun, LoginRunner } from "./runner.js";

/** How long `windlass login token` may take: it waits up to 30 s for its own refresh lock, then asks OpenAI. */
const TOKEN_TIMEOUT_MS = 90_000;
/** How long `windlass --models` may take: one request to the provider, and whoever asked is waiting on a page. */
const MODELS_TIMEOUT_MS = 5_000;

/** What asking for a token gave, with the material as Windlass left it: changed when it refreshed, whether or not a token came of it. */
export type TokenAnswer =
	| {
			ok: true;
			material: SignInMaterial;
			token: AccessToken /** Windlass said the token is good for less than was asked: a refresh gives none that lasts longer. */;
			shorter: boolean;
	  }
	| { ok: false; material: SignInMaterial; error: Error };

export interface SignInCommands {
	/**
	 * An access token of the sign-in in `material` that is good for twenty minutes more. Rejects only
	 * when the command could not be run at all; what Windlass answered is in the result, with the
	 * material to keep from now on.
	 */
	token(material: SignInMaterial, options?: { signal?: AbortSignal }): Promise<TokenAnswer>;
	/**
	 * The models the plan of `token`'s account offers, with the efforts each accepts and the default.
	 * Rejects when Windlass did not list them, with its own reason; no message holds the token.
	 */
	models(token: AccessToken): Promise<ListedModels>;
	/** How many times `token` ran Windlass: for the checks that count refreshes. */
	readonly asked: number;
}

export interface WindlassSignInsOptions {
	/** Where the line about a command that was killed goes. It never contains material or a token. */
	log?: (line: string) => void;
	/** How long `windlass login token` may take. Default 90 s; shortened by checks. */
	tokenTimeoutMs?: number;
	/** How long `windlass --models` may take. Default 5 s; shortened by checks. */
	modelsTimeoutMs?: number;
}

export class WindlassSignIns implements SignInCommands {
	asked = 0;

	constructor(
		private readonly runner: LoginRunner,
		private readonly options: WindlassSignInsOptions = {},
	) {}

	async token(material: SignInMaterial, options: { signal?: AbortSignal } = {}): Promise<TokenAnswer> {
		// Without a sign-in there is nothing to ask Windlass about.
		if (!hasSignIn(material)) return { ok: false, material, error: new SandboxUserError(NOT_SIGNED_IN) };
		this.asked += 1;
		const [, , ...args] = loginTokenCommand();
		const result = await this.runner.run(material, {
			args,
			network: true,
			timeoutMs: this.options.tokenTimeoutMs ?? TOKEN_TIMEOUT_MS,
			signal: options.signal,
		});
		// What Windlass saved is kept whatever it answered: a refresh that the sign-in service has already
		// carried out is in there, also when the command was killed before it could print the token.
		const left = result.materialRead && hasSignIn(result.material) ? result.material : material;
		try {
			return { ok: true, material: left, ...(await this.read(result)) };
		} catch (error) {
			return { ok: false, material: left, error: error instanceof Error ? error : new Error(String(error)) };
		}
	}

	async models(token: AccessToken): Promise<ListedModels> {
		const timeoutMs = this.options.modelsTimeoutMs ?? MODELS_TIMEOUT_MS;
		const result = await this.runner.runWithToken(token, { args: ["--models", "--json"], timeoutMs });
		if (result.timedOut)
			throw new Error(`\`windlass --models\` did not answer in ${timeoutMs / 1000} s and was stopped`);
		// Windlass says why on one line of standard error, where it never prints a token.
		if (result.code !== 0)
			throw new Error(
				`\`windlass --models\` failed (exit code ${result.code}): ${thrownLine(result.stderr) ?? "it gave no reason"}`,
			);
		const listed = parseModels(result.stdout);
		if (listed === null) throw new Error("`windlass --models --json` did not print a list of models");
		return listed;
	}

	private async read(result: LoginRun): Promise<{ token: AccessToken; shorter: boolean }> {
		if (result.aborted) throw new Error("`windlass login token` was stopped: the sign-in changed while it ran");
		if (result.timedOut) {
			this.options.log?.(
				`[wlp] sign-in.command_timeout: \`windlass login token\` did not answer in ${(this.options.tokenTimeoutMs ?? TOKEN_TIMEOUT_MS) / 1000} s and was stopped${result.materialRead ? "; what it had saved by then was kept" : ""}`,
			);
			throw new Error("`windlass login token` did not answer in time");
		}
		if (result.code === 0) {
			const token = parseToken(result.stdout);
			if (token === null) throw new Error("`windlass login token --json` did not print a token and its expiry");
			if (token.expiresAt <= Date.now())
				throw new Error("`windlass login token` printed a token that has already expired");
			return { token, shorter: saysShorterThanAsked(result.stderr) };
		}
		const stderr = result.stderr.trim();
		// What Windlass says about the sign-in, by its code.
		const failed = signInFailure(stderr);
		if (failed !== null) {
			if (failed.code === SIGNED_OUT) throw new SandboxUserError(NOT_SIGNED_IN);
			if (SIGN_IN_REFUSED.has(failed.code)) throw new SandboxUserError(SIGN_IN_EXPIRED);
			// Not the user's doing. That the service could not be reached is said in Windlass's own sentence, which names the host and the reason.
			if (failed.code === SIGN_IN_UNREACHABLE)
				throw new SignInRefreshError(
					`${failed.message.charAt(0).toLowerCase()}${failed.message.slice(1)}`,
					failed.code,
				);
			throw new SignInRefreshError(
				`the sign-in could not be refreshed: ${failed.message} (${failed.code})`,
				failed.code,
			);
		}
		// No code from here on. Windlass reports nobody being signed in without one, as a line of its own
		// ("windlass: not signed in, so there is no token to hand on; run `windlass login`", exit code 1), so that
		// one answer is still told by its words.
		if (result.code === 1 && stderr.split("\n").some(line => /^\S+: not signed in\b/.test(line.trim())))
			throw new SandboxUserError(NOT_SIGNED_IN);
		throw new Error(
			`\`windlass login token\` failed (exit code ${result.code}): ${thrownLine(stderr) ?? "it gave no reason"}`,
		);
	}
}

/**
 * The failure of a sign-in step as Windlass reports it on one line of standard error,
 * `windlass: sign-in failed: <message> (<code>)`: its stable code and its sentence. Null when Windlass
 * said nothing of that form.
 */
function signInFailure(stderr: string): { code: string; message: string } | null {
	for (const line of stderr.split("\n").reverse()) {
		const found = /^\S+: sign-in failed: (.*) \(([A-Za-z][A-Za-z0-9_]*)\)\s*$/.exec(line.trim());
		if (found !== null) return { message: oneLine(found[1]!), code: found[2]! };
	}
	return null;
}

/** The object `windlass login token --json` prints, from its standard output. Null when that is not what it printed. */
function parseToken(stdout: string): AccessToken | null {
	const line = stdout.trim().split("\n").pop() ?? "";
	try {
		const value = JSON.parse(line) as { accessToken?: unknown; expiresAt?: unknown };
		if (
			typeof value?.accessToken !== "string" ||
			value.accessToken === "" ||
			/\s/.test(value.accessToken) ||
			typeof value.expiresAt !== "number" ||
			!Number.isFinite(value.expiresAt)
		)
			return null;
		return { accessToken: value.accessToken, expiresAt: value.expiresAt };
	} catch {
		return null;
	}
}

/** More than any plan offers by far: what is longer is not a list of models. */
const MAX_MODELS = 200;
const MAX_MODEL_ID_CHARS = 200;

/**
 * What `windlass --models --json` prints: one object on a line for each model, `{"id":"...",
 * "description":"..."|null,"efforts":["..."],"isDefault":true|false}`, the default being the model a
 * new session uses when none is named (the first one where Windlass marks none). Null when any line
 * is something else, or there is no model at all: half a list is not served as the plan's.
 */
export function parseModels(stdout: string): ListedModels | null {
	const word = (value: unknown): value is string =>
		typeof value === "string" && value !== "" && value.length <= MAX_MODEL_ID_CHARS && !/[\x00-\x1f\x7f]/.test(value);
	const models: ModelChoice[] = [];
	let defaultModel: string | null = null;
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") continue;
		let row: { id?: unknown; description?: unknown; efforts?: unknown; isDefault?: unknown };
		try {
			row = JSON.parse(line) as typeof row;
		} catch {
			return null;
		}
		if (
			typeof row !== "object" ||
			row === null ||
			!word(row.id) ||
			!Array.isArray(row.efforts) ||
			!row.efforts.every(word) ||
			models.length >= MAX_MODELS ||
			models.some(model => model.id === row.id)
		)
			return null;
		models.push({ id: row.id, name: word(row.description) ? row.description : null, efforts: row.efforts });
		if (row.isDefault === true) defaultModel ??= row.id;
	}
	return models.length === 0 ? null : { models, defaultModel: defaultModel ?? models[0]!.id };
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 300);

/**
 * Extracts the command's error line from stderr, skipping stack frames and source excerpts.
 */
function thrownLine(stderr: string): string | null {
	const lines = stderr
		.split("\n")
		.map(line => line.trim())
		.filter(line => line !== "");
	const thrown = lines.find(line => /^(error|[A-Z]\w*Error|[A-Z]\w*Exception)(\[\w+\])?: \S/.test(line));
	if (thrown !== undefined) return oneLine(thrown.replace(/^error: /, ""));
	const own = lines.find(line => /^windlass: /.test(line));
	return own === undefined ? null : oneLine(own.replace(/^windlass: /, ""));
}
