import { randomBytes } from "node:crypto";
import type { PlanProvider } from "../contract.js";
import { keyedDigest } from "../signatures.js";

// Crockford-style: no I, L, O or U, so a code read off a terminal and compared on a page survives.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const USER_CODE_LENGTH = 8; // 40 bits, shown as KQ2M-8XF4; guessing is bounded per user (connect-codes.ts)

/**
 * A connect request (`npx @windlassai/cli connect claude`, connect-route.ts) has two secrets: the user code the
 * terminal shows and the user approves on the web page, and the request secret only the terminal holds, which
 * polls and then hands the token over. Only their digests are kept.
 */
export function newConnectRequest(): { userCode: string; request: string } {
	const chars = [...randomBytes(USER_CODE_LENGTH)].map(n => ALPHABET[n & 31]).join("");
	return {
		userCode: `${chars.slice(0, 4)}-${chars.slice(4)}`,
		request: randomBytes(32).toString("base64url"),
	};
}

export const connectCodeDigest = {
	/** The digest kept for a user code, or null when it is not one. Case, spaces and dashes don't matter. */
	ofUserCode(raw: unknown): string | null {
		if (typeof raw !== "string" || raw.length > 20) return null;
		const body = raw.trim().toUpperCase().replace(/[ -]/g, "");
		if (body.length !== USER_CODE_LENGTH || ![...body].every(ch => ALPHABET.includes(ch))) return null;
		return keyedDigest("connect-code", `user:${body}`).toString("hex");
	},
	/** The digest kept for a request secret, or null when it is not one. */
	ofRequest(raw: unknown): string | null {
		if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
		return keyedDigest("connect-code", `request:${raw}`).toString("hex");
	},
	/** Checks a digest passed between the route and an actor. */
	parse(digest: unknown): string {
		if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid connect code digest");
		return digest;
	},
};

/** What the token is sealed to between the connect route and its user's actor: the user and the request's digest. */
export const connectTransitSubject = (uid: string, provider: PlanProvider, digest: string) =>
	JSON.stringify(["plan-connect", uid, provider, digest]);
