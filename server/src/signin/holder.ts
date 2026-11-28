/**
 * One user's ChatGPT sign-in, and the single place that asks for that user's access token. The `user`
 * actor has one of these over its own storage, and since an actor runs in one place at a time, this is
 * what makes "one refresh at a time" hold across every server: whoever needs the user's token, on
 * whichever machine, asks this.
 *
 * The sign-in is stored sealed (seal.ts) and is opened only here, for the moment a Windlass command
 * needs it (commands.ts). What is kept in memory is the last access token and until when it serves.
 *
 * Asking for a token:
 *
 *   - an answer is reused for as long as asking again would give the same token: while it has more than
 *     twenty minutes left (`TOKEN_VALID_FOR_MS`, handoff.ts), or half of what it had when the service
 *     issues shorter ones;
 *   - otherwise Windlass is asked, one request at a time: whoever asks meanwhile waits for that answer;
 *   - when Windlass refreshed the sign-in, the sign-in service has replaced the refresh token, and the
 *     old one is of no use any more. The new sign-in is therefore saved BEFORE the token is handed
 *     out, and a token whose sign-in could not be saved is not handed out at all: the save is tried
 *     again before anything else is done with this user's sign-in.
 *
 * What cannot be closed is the moment between the sign-in service answering the refresh and that save:
 * Windlass writes the new `auth.json` into its private directory, exits, the runner reads it, and this
 * seals and saves it. A server that dies in between (some tens of milliseconds, plus the storage's own
 * round trip) leaves the old, used-up refresh token in the store. The access token saved with it works
 * until it expires; after that the refresh is refused, `current()` says the sign-in is no longer
 * accepted, and the user signs in with ChatGPT again. Nothing else is lost and nobody else is affected.
 * A command that is killed (a timeout) is not such a death: what Windlass had saved is still read back.
 *
 * Replacing and forgetting go through the same queue, so no token of the old sign-in is handed out
 * once either has returned, and a request to Windlass that is running for the old sign-in is stopped
 * rather than waited for.
 */

import { randomUUID } from "node:crypto";
import { type AccessToken, type ChatgptAccount, SandboxUserError } from "../sandbox/api.js";
import { NOT_SIGNED_IN, TOKEN_VALID_FOR_MS, windlassDuration } from "../sandbox/handoff.js";
import type { SignInCommands, TokenAnswer } from "./commands.js";
import { type SignInMaterial, accountOf, cleanMaterial, sameMaterial, signInOnly } from "./material.js";
import { SealError, type Sealer } from "./seal.js";
import { errorText } from "../util.js";

/** What a user's store holds about the sign-in. Nothing in it is readable without the key but the two flags. */
export interface StoredSignIn {
	/** The sign-in, sealed for this user; null when there is none (never signed in, or forgotten). */
	sealed: string | null;
	/** Changes when the sign-in itself does (adopted or forgotten), never at a refresh: a turn pins it (credentials/plans.ts). */
	generation: string;
	/** Whether it was already said that the service issues tokens shorter than the platform asks for. */
	shortNoted: boolean;
}

export interface SignInStore {
	/** Null when nothing was ever saved. */
	load(): Promise<StoredSignIn | null>;
	/** Resolves when the store has it. */
	save(row: StoredSignIn): Promise<void>;
}

export interface SignInHolderOptions {
	uid: string;
	store: SignInStore;
	commands: SignInCommands;
	sealer: Sealer;
	/**
	 * The sandbox provider's part of forgetting a sign-in: it removes the token files of the user's turns
	 * that are still running. Called after the sign-in is gone from the store.
	 */
	revoke?: (uid: string) => Promise<void>;
	/** Where the holder's `[wlp]` lines go. Default the console. None ever contains a token. */
	log?: (line: string) => void;
}

/** The sentence for a stored sign-in this server cannot open. The reason is logged for whoever runs the server. */
export const SIGN_IN_UNREADABLE =
	"Your saved ChatGPT sign-in can no longer be read by this server. Sign in with ChatGPT again, then send the prompt once more.";

const NOTHING: StoredSignIn = { sealed: null, generation: "", shortNoted: false };

/** A token as it is kept for the user's other requests, and until when. */
interface Kept {
	token: AccessToken;
	reuseUntil: number;
}

/** A request to Windlass was stopped because the sign-in was replaced or forgotten while it ran: the request is made again, after that. */
class Superseded extends Error {}

export class SignInHolder {
	private readonly uid: string;
	private readonly log: (line: string) => void;
	/** Everything that reads the sign-in for Windlass or changes it runs through here, one at a time. */
	private queue: Promise<unknown> = Promise.resolve();
	private kept: Kept | null = null;
	private flight: Promise<AccessToken> | null = null;
	/** The request to Windlass that is running now, to be stopped when the sign-in changes. */
	private running: AbortController | null = null;
	/** A refreshed sign-in the store did not take: saved before anything else is done. */
	private unsaved: StoredSignIn | null = null;
	private unreadableSaid = false;

	constructor(private readonly options: SignInHolderOptions) {
		this.uid = options.uid;
		this.log = options.log ?? (line => console.log(line));
	}

	/** Who is signed in and when the saved access token expires; null when nobody is. Never a token. */
	async status(): Promise<ChatgptAccount | null> {
		const row = this.unsaved ?? (await this.options.store.load());
		const sealed = row?.sealed;
		if (!sealed) return null;
		let material: SignInMaterial;
		try {
			material = this.open(sealed);
		} catch (error) {
			if (error instanceof SandboxUserError) return null;
			throw error;
		}
		if (!this.options.sealer.isCurrent(sealed)) {
			await this.exclusive(async () => {
				// A refresh, adoption or logout may have won the queue since this snapshot.
				if (this.unsaved) return;
				try {
					const latest = await this.options.store.load();
					if (latest?.sealed === sealed) await this.options.store.save({ ...latest, sealed: this.seal(material) });
				} catch {
					this.log(
						`[wlp] sign-in.reseal_failed uid=${this.uid}: could not re-seal the saved sign-in; the next read will retry`,
					);
				}
			});
		}
		return accountOf(material);
	}

	/** The user's current access token: `AccessTokens.current` (sandbox/api.ts) says what it promises. */
	async accessToken(): Promise<AccessToken> {
		for (let tries = 0; ; tries += 1) {
			const kept = this.kept;
			if (kept !== null && Date.now() < kept.reuseUntil) return { ...kept.token };
			// One at a time: whoever asks while a request runs waits for that one's answer.
			this.flight ??= this.exclusive(() => this.ask()).finally(() => {
				this.flight = null;
			});
			try {
				return { ...(await this.flight) };
			} catch (error) {
				if (!(error instanceof Superseded)) throw error;
				// The sign-in changed under the request: the next one is answered by what replaced it.
				if (tries >= 2) throw new Error("the sign-in kept changing while its access token was asked for");
			}
		}
	}

	/**
	 * Replaces the user's sign-in with the one in `sealed`, a finished sign-in sealed for this user.
	 * Tokens of the earlier sign-in are not handed out again.
	 */
	async adopt(sealed: string): Promise<void> {
		// Looked at before anything is touched: what is not a finished sign-in sealed for this user changes nothing.
		let material: SignInMaterial;
		try {
			material = parse(this.options.sealer.open("user", this.uid, sealed));
		} catch (error) {
			throw new Error(`the sign-in handed over for user ${this.uid} was refused: ${errorText(error)}`);
		}
		await this.adoptMaterial(material);
	}

	/** Replaces the user's sign-in with `material`, already opened: the connect command's upload (credentials/index.ts). */
	async adoptMaterial(given: SignInMaterial): Promise<void> {
		const material = signInOnly(cleanMaterial(given.files));
		const account = accountOf(material);
		if (account === null) throw new SandboxUserError("This sign-in is not finished yet.");
		this.running?.abort();
		await this.exclusive(async () => {
			await this.options.store.save({ sealed: this.seal(material), generation: randomUUID(), shortNoted: false });
			this.unsaved = null;
			this.kept = null;
		});
	}

	/**
	 * Forgets the user's sign-in: it is gone from the store, no token of it is handed out again, and the
	 * provider removes the token files of turns still running. A no-op for a user without one.
	 */
	async logout(): Promise<void> {
		this.running?.abort();
		await this.exclusive(async () => {
			try {
				this.unsaved = null;
				const row = (await this.options.store.load()) ?? NOTHING;
				if (row.sealed !== null)
					await this.options.store.save({ sealed: null, generation: randomUUID(), shortNoted: false });
			} finally {
				this.kept = null;
			}
			await this.options.revoke?.(this.uid);
		});
	}

	/** Drops the token kept in memory, as a restart of the holder would. For the layer's own checks. */
	forget(): void {
		this.kept = null;
	}

	private exclusive<T>(step: () => Promise<T>): Promise<T> {
		const run = this.queue.then(step, step);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async ask(): Promise<AccessToken> {
		// A refresh that was carried out and not saved comes first: Windlass must never be asked with the sign-in from before it.
		if (this.unsaved !== null) await this.save(this.unsaved);
		const row = { ...((await this.options.store.load()) ?? NOTHING) };
		if (row.sealed === null) throw new SandboxUserError(NOT_SIGNED_IN);
		const material = await this.readMaterial(row, row.sealed);

		const controller = new AbortController();
		this.running = controller;
		let answer: TokenAnswer;
		try {
			answer = await this.options.commands.token(material, { signal: controller.signal });
		} finally {
			this.running = null;
		}
		// The sign-in is being replaced or forgotten: nothing of this answer is kept or handed out.
		if (controller.signal.aborted) throw new Superseded();

		let changed = false;
		const left = signInOnly(answer.material);
		const refreshed = accountOf(left) !== null && !sameMaterial(left, material);
		if (refreshed) {
			row.sealed = this.seal(left);
			changed = true;
		}
		const shortSaid = answer.ok && answer.shorter && !row.shortNoted;
		if (answer.ok && answer.shorter !== row.shortNoted) {
			row.shortNoted = answer.shorter;
			changed = true;
		}
		// Before the token is returned: a refreshed sign-in is in the store, or nobody gets its token.
		if (changed) await this.save(row);
		if (refreshed)
			this.log(`[wlp] sign-in.refreshed uid=${this.uid}: Windlass refreshed the sign-in, and the new one is saved`);
		if (!answer.ok) throw answer.error;
		if (shortSaid) {
			const seconds = Math.round(Math.max(0, answer.token.expiresAt - Date.now()) / 1000);
			this.log(
				`[wlp] token.short uid=${this.uid}: Windlass was asked for an access token that is good for ${windlassDuration(TOKEN_VALID_FOR_MS)} more, which is more than the sign-in service issues: after a refresh the token lasts ${seconds} s. It is used as it is, with that expiry, and so is every such token until half of what it has left is gone`,
			);
		}
		this.keep(answer.token);
		return answer.token;
	}

	private async save(row: StoredSignIn): Promise<void> {
		try {
			await this.options.store.save(row);
			this.unsaved = null;
		} catch (error) {
			this.unsaved = { ...row };
			const reason = errorText(error);
			this.log(
				`[wlp] sign-in.save_failed uid=${this.uid}: the sign-in was refreshed and could not be saved (${reason}); no token of it is handed out until it is, and the save is tried again at the next request`,
			);
			throw new Error(`the refreshed sign-in could not be saved: ${reason}`);
		}
	}

	/**
	 * Keeps a token for the user's other requests. One that has what was asked for is reused for as long
	 * as it does: asking again before then would print the same one. One with less is the longest the
	 * service gives (Windlass refreshed for it): asking again would refresh again and give no more, so
	 * it is reused until half of what it has left is gone.
	 */
	private keep(token: AccessToken): void {
		const left = token.expiresAt - Date.now();
		this.kept = { token, reuseUntil: token.expiresAt - (left > TOKEN_VALID_FOR_MS ? TOKEN_VALID_FOR_MS : left / 2) };
	}

	private seal(material: SignInMaterial): string {
		return this.options.sealer.seal("user", this.uid, JSON.stringify(material));
	}

	/** Called inside the holder's queue, so rewrapping cannot restore a forgotten or refreshed sign-in. */
	private async readMaterial(row: StoredSignIn, sealed: string): Promise<SignInMaterial> {
		const material = this.open(sealed);
		if (!this.options.sealer.isCurrent(sealed)) {
			row.sealed = this.seal(material);
			await this.save(row);
		}
		return material;
	}

	/** The stored sign-in, opened. One that does not open is the user's to replace, and the operator's to hear about. */
	private open(sealed: string): SignInMaterial {
		try {
			return parse(this.options.sealer.open("user", this.uid, sealed));
		} catch (error) {
			if (!(error instanceof SealError)) throw error;
			if (!this.unreadableSaid) {
				this.unreadableSaid = true;
				this.log(
					`[wlp] sign-in.unreadable uid=${this.uid}: the stored sign-in does not open: ${error.message}. The user is told to sign in with ChatGPT again`,
				);
			}
			throw new SandboxUserError(SIGN_IN_UNREADABLE);
		}
	}
}

function parse(text: string): SignInMaterial {
	return cleanMaterial((JSON.parse(text) as { files?: unknown }).files);
}
