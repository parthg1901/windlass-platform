import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

const purposes = [
	"user-token",
	"service-token",
	"github-state",
	"github-ticket",
	"pairing-budget",
	"attach-ticket",
	"model-relay",
	"connect-code",
] as const;
type Purpose = (typeof purposes)[number];
const keys = new Map(
	config.signingKeys.map(({ id, secret }) => [
		id,
		new Map(
			purposes.map(label => [label, Buffer.from(hkdfSync("sha256", secret, "", "windlass-platform v2 " + label, 32))]),
		),
	]),
);
const current = config.signingKeys[0].id;

export function keyedDigest(purpose: Purpose, text: string, keyId = current): Buffer {
	return createHmac("sha256", keys.get(keyId)!.get(purpose)!).update(text).digest();
}

export function signedPayload(prefix: string, purpose: Purpose, payload: object): string {
	const body = [prefix, current, Buffer.from(JSON.stringify(payload)).toString("base64url")].join(".");
	return body + "." + keyedDigest(purpose, body).toString("base64url");
}

export function readSignedPayload(
	token: unknown,
	prefix: string,
	limit: number,
	purposeOf: (kind: unknown) => Purpose | null,
): Record<string, unknown> | null {
	if (typeof token !== "string" || token.length > limit) return null;
	const [version, kid, data, mac, extra] = token.split(".");
	if (version !== prefix || !kid || !data || !mac || extra !== undefined) return null;
	const ring = keys.get(kid);
	if (!ring) return null;
	try {
		const payload: unknown = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
		if (!payload || typeof payload !== "object" || !("k" in payload)) return null;
		const purpose = purposeOf(payload.k);
		if (!purpose) return null;
		const expected = createHmac("sha256", ring.get(purpose)!)
			.update([version, kid, data].join("."))
			.digest("base64url");
		const given = Buffer.from(mac);
		return expected.length === given.length && timingSafeEqual(Buffer.from(expected), given)
			? (payload as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}
