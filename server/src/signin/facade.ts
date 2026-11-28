/**
 * `ChatgptLogins` and `AccessTokens` (sandbox/api.ts) for every sandbox layer: what the actors and the
 * code that runs a turn call. Nothing here knows a sandbox provider, and nothing here stores anything:
 *
 *   status, logout  ask the user's holder
 *   current         asks the user's holder for the access token
 *
 * "The user's holder" is a directory (directory.ts): the `user` actor on a server, holders in memory in
 * the layer's own checks.
 */

import { randomBytes } from "node:crypto";
import { type AccessToken, type AccessTokens, type ChatgptAccount, type ChatgptLogins } from "../sandbox/api.js";
import type { SignInCommands } from "./commands.js";
import { ActorSignInDirectory, MemorySignInDirectory, type SignInDirectory } from "./directory.js";
import type { StoredSignIn } from "./holder.js";
import { assertName } from "./material.js";
import { type Sealer, createSealer, serverSealer } from "./seal.js";

export interface SignInFacadeOptions {
	directory: SignInDirectory;
	/** The provider's part of a new user: the place Windlass's own data of that user's sessions is kept (Docker: a volume). */
	ensureUserData?: (uid: string) => Promise<void>;
	/** How many times `windlass login token` ran in this process, where that is known. */
	asked?: () => number;
}

export class SignInLogins implements ChatgptLogins {
	constructor(private readonly options: SignInFacadeOptions) {}

	async status(uid: string): Promise<ChatgptAccount | null> {
		assertName(uid, "user id");
		return this.options.directory.status(uid);
	}

	async logout(uid: string): Promise<void> {
		assertName(uid, "user id");
		await this.options.directory.logout(uid);
	}

	async ensureUserVolume(uid: string): Promise<void> {
		assertName(uid, "user id");
		await this.options.ensureUserData?.(uid);
	}
}

export class SignInTokens implements AccessTokens {
	constructor(private readonly options: SignInFacadeOptions) {}

	async current(uid: string): Promise<AccessToken> {
		assertName(uid, "user id");
		return this.options.directory.accessToken(uid);
	}

	/**
	 * How many times `windlass login token` was run, where the holders are in this process: the layer's
	 * own checks count refreshes with it. On a server the actors run it, wherever they are, and this
	 * stays 0.
	 */
	get asked(): number {
		return this.options.asked?.() ?? 0;
	}

	/** Drops the token kept for the user. Only where the holders are in this process (the checks); on a server the actor keeps it. */
	forget(uid: string): void {
		if (this.options.directory instanceof MemorySignInDirectory) this.options.directory.forget(uid);
	}
}

export function signInFacade(options: SignInFacadeOptions): { logins: SignInLogins; tokens: SignInTokens } {
	return { logins: new SignInLogins(options), tokens: new SignInTokens(options) };
}

// ---------------------------------------------------------------------------------------------
// The two ways a layer gets them
// ---------------------------------------------------------------------------------------------

/**
 * For a server: the sign-ins are in the users' actors, and Windlass's commands run where this server is
 * configured to run them (signin/index.ts). Right for any number of servers.
 */
export function actorSignIns(options: { ensureUserData?: (uid: string) => Promise<void> } = {}): {
	logins: SignInLogins;
	tokens: SignInTokens;
} {
	return signInFacade({
		directory: new ActorSignInDirectory(serverSealer()),
		ensureUserData: options.ensureUserData,
	});
}

/** The key of the sign-ins kept in this process's memory: made up when the process starts, and gone with it. */
let memoryKey: Sealer | null = null;

export interface MemorySignInsOptions {
	commands: SignInCommands;
	revoke?: (uid: string) => Promise<void>;
	ensureUserData?: (uid: string) => Promise<void>;
	log?: (line: string) => void;
	/** Sign-ins of its own instead of the ones every such layer of this process shares. */
	rows?: Map<string, StoredSignIn>;
}

/**
 * For checks that run without a server: the same holders, over a store in this process's memory. One
 * process only, and nothing outlives it: never for a deployment.
 */
export function memorySignIns(options: MemorySignInsOptions): {
	logins: SignInLogins;
	tokens: SignInTokens;
	directory: MemorySignInDirectory;
	sealer: Sealer;
} {
	memoryKey ??= createSealer(randomBytes(32));
	const sealer = memoryKey;
	const directory = new MemorySignInDirectory({
		commands: options.commands,
		sealer,
		revoke: options.revoke,
		log: options.log,
		rows: options.rows,
	});
	const facade = signInFacade({
		directory,
		ensureUserData: options.ensureUserData,
		asked: () => options.commands.asked,
	});
	return { ...facade, directory, sealer };
}
