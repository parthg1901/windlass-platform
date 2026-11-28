/**
 * Encryption of what the actors store and pass on about a ChatGPT sign-in. Actor storage is held by
 * whoever hosts the Rivet engine, and what one actor hands another travels through that engine, so
 * neither ever sees a sign-in or a token as it is: only a sealed blob.
 *
 *   wlps1.<key id>.<nonce>.<ciphertext>.<tag>        each part base64url
 *
 * AES-256-GCM with a random 96-bit nonce per blob. The key is derived with HKDF-SHA256 from the
 * configured sealing root (the signing roots are the fallback) under a label
 * that names this use, so it is not the key tokens are signed with and cannot be had from one; each
 * purpose has a key of its own:
 *
 *   user      a user's sign-in, in that user's `user` actor
 *   attempt   a platform login attempt (its OAuth verifier or verified identity), in its `login` actor
 *   transit   an access token on its way from the `user` actor to the server that asked for it
 *   model-key a model provider API key, bound to its user and provider
 *   model-plan a connected subscription plan's token, bound to its user and provider
 *   secret    the value of a repository's secret, in its user's `user` actor (repo-secrets.ts)
 *
 * What a blob is for and whose it is are authenticated with it (GCM's additional data: the purpose
 * and a subject, which is the uid, the attempt id, the uid and the asking server's nonce, or the uid
 * with a secret's repository and name). A blob opens only as what it was sealed as: one user's
 * sign-in put in another user's actor does not open there, nor does an attempt's blob as a
 * sign-in, nor an answer to another request, nor one secret's value as another's.
 *
 * The key id is configured, or derived from a singleton secret under another label. It says which secret a
 * blob was sealed with, so that a server whose secret differs from the others' can say that, instead
 * of reporting every sign-in as damaged. It tells nothing about the key.
 *
 * With a copy of the storage and without the secret, a blob gives away that it exists and how long it
 * is. With the secret it gives away everything: the secret is what must not be in the storage.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { Keyring } from "../keyring.js";
import { signInKeys } from "../config.js";

const PURPOSES = ["user", "attempt", "transit", "secret", "model-key", "model-plan"] as const;
export type SealPurpose = (typeof PURPOSES)[number];

const VERSION = "wlps1";
const LABEL = "windlass-platform sign-in v1";

/**
 * Why a blob did not open: `format` (not a blob of this version), `key` (sealed with another secret
 * than this server's), `tampered` (it was changed, or sealed for another purpose or subject).
 */
export class SealError extends Error {
	constructor(
		readonly reason: "format" | "key" | "tampered",
		message: string,
	) {
		super(message);
		this.name = "SealError";
	}
}

export interface Sealer {
	isCurrent(blob: string): boolean;
	seal(purpose: SealPurpose, subject: string, plaintext: string): string;
	/** Throws `SealError`. */
	open(purpose: SealPurpose, subject: string, blob: string): string;
}

const derive = (secret: Buffer, info: string, length: number) =>
	Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), `${LABEL} ${info}`, length));

/** What is authenticated beside the ciphertext: this format, the purpose, and whose it is. */
const bound = (purpose: SealPurpose, subject: string) =>
	Buffer.from(JSON.stringify([VERSION, purpose, subject]), "utf8");

export function createSealer(source: Buffer | string | Keyring): Sealer {
	const singleton = typeof source === "string" ? Buffer.from(source) : source;
	const legacyId = (secret: Buffer) => derive(secret, "key id", 6).toString("base64url");
	const roots = Buffer.isBuffer(singleton) ? [{ id: legacyId(singleton), secret: singleton }] : singleton;
	const byId = new Map<string, Map<SealPurpose, Buffer>>();
	for (const { id, secret } of roots) {
		if (secret.length < 16) throw new Error("the secret a sign-in key is derived from must be at least 16 bytes long");
		const keys = new Map<SealPurpose, Buffer>();
		for (const purpose of PURPOSES) keys.set(purpose, derive(secret, `key ${purpose}`, 32));
		// A pre-keyring blob names its root by this fingerprint. Keep reading it until that root retires.
		for (const alias of new Set([id, legacyId(secret)])) {
			if (byId.has(alias)) throw new Error("the sealing keyring contains colliding key ids");
			byId.set(alias, keys);
		}
	}
	const current = roots[0]!.id;

	return {
		isCurrent: blob => blob.startsWith(`${VERSION}.${current}.`),
		seal(purpose, subject, plaintext) {
			const nonce = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", byId.get(current)!.get(purpose)!, nonce);
			cipher.setAAD(bound(purpose, subject));
			const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
			return [
				VERSION,
				current,
				nonce.toString("base64url"),
				ciphertext.toString("base64url"),
				cipher.getAuthTag().toString("base64url"),
			].join(".");
		},
		open(purpose, subject, blob) {
			const parts = typeof blob === "string" ? blob.split(".") : [];
			if (parts.length !== 5 || parts[0] !== VERSION) throw new SealError("format", "this is not a sealed sign-in");
			const keys = byId.get(parts[1]!);
			if (!keys)
				throw new SealError(
					"key",
					"it was sealed with another secret; its key id is absent from this server's sealing keyring",
				);
			const [nonce, ciphertext, tag] = parts.slice(2).map(part => Buffer.from(part, "base64url"));
			if (nonce!.length !== 12 || tag!.length !== 16) throw new SealError("format", "this is not a sealed sign-in");
			try {
				const decipher = createDecipheriv("aes-256-gcm", keys.get(purpose)!, nonce!);
				decipher.setAAD(bound(purpose, subject));
				decipher.setAuthTag(tag!);
				return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString("utf8");
			} catch {
				throw new SealError(
					"tampered",
					"it does not open: it was changed, or it was sealed for someone or something else",
				);
			}
		},
	};
}

let own: Sealer | null = null;

/** This server's sealer, from its configuration. */
export function serverSealer(): Sealer {
	own ??= createSealer(signInKeys());
	return own;
}
