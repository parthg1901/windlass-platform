/**
 * Where the users' sign-ins are: "the holder of this user", for whoever is not that holder.
 *
 *   `ActorSignInDirectory`    the server's. Every call goes to the user's `user` actor, which has the
 *                             holder (holder.ts) over its own storage. This is the only one that is right
 *                             for more than one server process: the actor is in one place at a time, so
 *                             its queue is the queue for all of them
 *   `MemorySignInDirectory`   holders in this process over a store in this process's memory. For the
 *                             sandbox layer's own checks, which run without a server. It serialises
 *                             within one process only, and what it holds is gone when the process ends:
 *                             it must never serve a deployment
 *
 * What crosses between a server and an actor travels through the Rivet engine, so it is sealed
 * (seal.ts): a sign-in on its way to the user's actor is sealed for that user before it leaves, and an
 * access token comes back sealed for the request that asked for it (the uid and a nonce the asking
 * server made up), so an answer cannot be replayed as the answer to another request or another user.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "rivetkit/client";
import { isActorGone } from "../actors/internal.js";
import { serviceParams } from "../auth.js";
import { ownEngineEndpoint } from "../config.js";
import { type AccessToken, type ChatgptAccount, SandboxUserError } from "../sandbox/api.js";
import { NOT_SIGNED_IN, SignInRefreshError } from "../sandbox/handoff.js";
import type { SignInCommands } from "./commands.js";
import { SignInHolder, type StoredSignIn } from "./holder.js";
import { type SignInMaterial, signInOnly } from "./material.js";
import type { Sealer } from "./seal.js";
import { errorText } from "../util.js";

export interface SignInDirectory {
	/** Replaces the user's sign-in with `sealed`: a finished sign-in, sealed for that user. */
	adopt(uid: string, sealed: string): Promise<void>;
	status(uid: string): Promise<ChatgptAccount | null>;
	logout(uid: string): Promise<void>;
	accessToken(uid: string): Promise<AccessToken>;
}

// ---------------------------------------------------------------------------------------------
// What the `user` actor answers, and how a failure crosses to the server that asked
// ---------------------------------------------------------------------------------------------

/**
 * A failure of the sign-in as plain data. An error thrown inside an actor reaches its caller as a
 * message only, and what a turn does with a failure depends on its kind (handoff.ts,
 * `tokenSourceFailure`): the kind is carried, and the caller makes the same error again.
 */
export type SignInProblem =
	| { kind: "user"; message: string }
	| { kind: "refresh"; message: string; code: string }
	| { kind: "other"; message: string };

export function problemOf(error: unknown): SignInProblem {
	const message = errorText(error);
	if (error instanceof SandboxUserError) return { kind: "user", message };
	if (error instanceof SignInRefreshError) return { kind: "refresh", message, code: error.code };
	return { kind: "other", message };
}

export function errorOf(problem: SignInProblem): Error {
	if (problem.kind === "user") return new SandboxUserError(problem.message);
	if (problem.kind === "refresh") return new SignInRefreshError(problem.message, problem.code);
	return new Error(problem.message);
}

/** The answer to a request for a user's access token: the token sealed for that request, or why there is none. */
export type SealedTokenAnswer = { ok: true; sealed: string } | { ok: false; problem: SignInProblem };
export type SignInAnswer<T> = { ok: true; value: T } | { ok: false; problem: SignInProblem };

/** What a sealed access token is bound to: the user it is for and the request it answers. */
export const tokenSubject = (uid: string, nonce: string) => `${uid}/${nonce}`;

/** The actions of the `user` actor this directory calls (actors/user.ts). They accept a service token only. */
interface UserSignInActions {
	internalAdoptSignIn(sealed: string): Promise<SignInAnswer<null>>;
	internalSignInStatus(): Promise<SignInAnswer<ChatgptAccount | null>>;
	internalSignOut(): Promise<SignInAnswer<null>>;
	internalAccessToken(nonce: string): Promise<SealedTokenAnswer>;
}

/** The part of RivetKit's client this directory uses. The registry's type is not named: its actors import this folder. */
interface ActorClient {
	user: {
		get(key: string[], options: { params: unknown }): unknown;
	};
}

export class ActorSignInDirectory implements SignInDirectory {
	private client: ActorClient | null = null;

	constructor(private readonly sealer: Sealer) {}

	/**
	 * A client of this server's own engine, configured as RivetKit configures the registry: from
	 * RIVET_ENDPOINT (RIVET_ENGINE), RIVET_NAMESPACE and RIVET_TOKEN, and the local engine without them.
	 */
	private actors(): ActorClient {
		this.client ??= createClient({ endpoint: ownEngineEndpoint() }) as unknown as ActorClient;
		return this.client;
	}

	private existing(uid: string): UserSignInActions {
		return this.actors().user.get([uid], { params: serviceParams() }) as UserSignInActions;
	}

	async adopt(uid: string, sealed: string): Promise<void> {
		const answer = await this.existing(uid).internalAdoptSignIn(sealed);
		if (!answer.ok) throw errorOf(answer.problem);
	}

	async status(uid: string): Promise<ChatgptAccount | null> {
		try {
			const answer = await this.existing(uid).internalSignInStatus();
			if (!answer.ok) throw errorOf(answer.problem);
			return answer.value;
		} catch (error) {
			// A user whose actor does not exist has no sign-in, and asking makes no actor.
			if (isActorGone(error)) return null;
			throw error;
		}
	}

	async logout(uid: string): Promise<void> {
		try {
			const answer = await this.existing(uid).internalSignOut();
			if (!answer.ok) throw errorOf(answer.problem);
		} catch (error) {
			if (isActorGone(error)) return;
			throw error;
		}
	}

	async accessToken(uid: string): Promise<AccessToken> {
		const nonce = randomBytes(16).toString("base64url");
		let answer: SealedTokenAnswer;
		try {
			answer = await this.existing(uid).internalAccessToken(nonce);
		} catch (error) {
			if (isActorGone(error)) throw new SandboxUserError(NOT_SIGNED_IN);
			// What the engine or the actor said about a call that did not get through. It never holds a token: none was sent.
			throw new Error(`the user's sign-in could not be asked: ${errorText(error)}`);
		}
		if (!answer.ok) throw errorOf(answer.problem);
		let token: { accessToken?: unknown; expiresAt?: unknown };
		try {
			token = JSON.parse(this.sealer.open("transit", tokenSubject(uid, nonce), answer.sealed)) as typeof token;
		} catch (error) {
			throw new Error(`the answer to the request for the user's access token does not open: ${errorText(error)}`);
		}
		if (typeof token.accessToken !== "string" || typeof token.expiresAt !== "number")
			throw new Error("the answer to the request for the user's access token holds no token");
		return { accessToken: token.accessToken, expiresAt: token.expiresAt };
	}
}

// ---------------------------------------------------------------------------------------------
// In this process only
// ---------------------------------------------------------------------------------------------

/** The rows of every `MemorySignInDirectory` of this process: layers made beside each other see one set of sign-ins, as servers see one storage. */
const sharedRows = new Map<string, StoredSignIn>();

export interface MemorySignInDirectoryOptions {
	commands: SignInCommands;
	sealer: Sealer;
	revoke?: (uid: string) => Promise<void>;
	log?: (line: string) => void;
	/** Rows of its own instead of the process's shared ones. */
	rows?: Map<string, StoredSignIn>;
}

export class MemorySignInDirectory implements SignInDirectory {
	private readonly holders = new Map<string, SignInHolder>();
	private readonly rows: Map<string, StoredSignIn>;

	constructor(private readonly options: MemorySignInDirectoryOptions) {
		this.rows = options.rows ?? sharedRows;
	}

	private holder(uid: string): SignInHolder {
		let holder = this.holders.get(uid);
		if (holder === undefined) {
			const rows = this.rows;
			holder = new SignInHolder({
				uid,
				commands: this.options.commands,
				sealer: this.options.sealer,
				revoke: this.options.revoke,
				log: this.options.log,
				store: {
					load: async () => {
						const row = rows.get(uid);
						return row === undefined ? null : { ...row };
					},
					save: async row => {
						rows.set(uid, { ...row });
					},
				},
			});
			this.holders.set(uid, holder);
		}
		return holder;
	}

	adopt(uid: string, sealed: string): Promise<void> {
		return this.holder(uid).adopt(sealed);
	}

	status(uid: string): Promise<ChatgptAccount | null> {
		return this.holder(uid).status();
	}

	logout(uid: string): Promise<void> {
		return this.holder(uid).logout();
	}

	accessToken(uid: string): Promise<AccessToken> {
		return this.holder(uid).accessToken();
	}

	/** Drops the token this directory keeps for the user, as another server (or the actor after a sleep) would have none. */
	forget(uid: string): void {
		this.holders.get(uid)?.forget();
	}

	/**
	 * Puts a sign-in in the user's store as it is, behind the holder's back. The token kept here is not
	 * dropped: `forget` does that. For checks, with made-up material.
	 */
	put(uid: string, material: SignInMaterial): void {
		this.rows.set(uid, {
			sealed: this.options.sealer.seal("user", uid, JSON.stringify(signInOnly(material))),
			generation: randomUUID(),
			shortNoted: false,
		});
	}

	/** The key this directory's blobs are sealed with, for checks that look into one. */
	get sealer(): Sealer {
		return this.options.sealer;
	}

	/** What the store holds for the user, as stored: sealed. For checks that nothing readable is in it. */
	stored(uid: string): StoredSignIn | null {
		const row = this.rows.get(uid);
		return row === undefined ? null : { ...row };
	}
}
