import { randomBytes, timingSafeEqual } from "node:crypto";
import { actor, UserError } from "rivetkit";
import { db } from "rivetkit/db";
import { internalConnection, requireServiceFor, serviceParams } from "../auth.js";
import { config, signedRunnerEndpoint } from "../config.js";
import { keyedDigest } from "../signatures.js";
import type { MachineClaim } from "../contract.js";
import {
	machineKeyFingerprint,
	PAIRING_TTL_MS,
	PRINTS_KEY_RUNNER_VERSION,
	versionAtLeast,
	type PairStatus,
} from "../runner/control.js";
import { grantIsValid, isActorGone } from "./internal.js";

export const pairingGone = () =>
	new UserError("That code was not found. Check the code on the machine or start pairing again.", {
		code: "pairing_not_found",
	});

// The listener supplies ordinary request headers, with no authenticated client address. Limit
// retries of the same canonical public key and partition the deployment budget independently of IP.
// A runner cannot choose its bucket; a full bucket leaves all the other buckets available.
const STARTS_PER_KEY = 3;
const BUCKETS = 64;
const STARTS_PER_BUCKET = 16;

// Only starts and code lookups share this actor. Polls go directly to the random pairing id.
// The index doubles as the sliding-window budget, including starts whose caller disconnected.
export const pairingDirectory = actor({
	db: db({
		onMigrate: async db => {
			await db.execute(
				"CREATE TABLE IF NOT EXISTS starts (code TEXT PRIMARY KEY, pairing TEXT NOT NULL, key_tag TEXT NOT NULL, bucket INTEGER NOT NULL, expires INTEGER NOT NULL)",
			);
		},
	}),
	onCreate: c => {
		if (c.key.length !== 1 || c.key[0] !== "starts") c.destroy();
	},
	onBeforeConnect: internalConnection,
	actions: {
		internalStart: async (c, code: string, pairing: string, publicKey: string): Promise<number | null> => {
			requireServiceFor(c, "call");
			const now = Date.now();
			const expires = now + PAIRING_TTL_MS;
			const tag = keyedDigest("pairing-budget", publicKey);
			const bucket = tag[0]! % BUCKETS;
			await c.db.execute("DELETE FROM starts WHERE expires <= ?", now);
			const rows = await c.db.execute(
				`INSERT INTO starts SELECT ?, ?, ?, ?, ?
				WHERE (SELECT count(*) FROM starts WHERE key_tag = ?) < ? AND (SELECT count(*) FROM starts WHERE bucket = ?) < ?
				RETURNING expires`,
				code,
				pairing,
				tag.toString("hex"),
				bucket,
				expires,
				tag.toString("hex"),
				STARTS_PER_KEY,
				bucket,
				STARTS_PER_BUCKET,
			);
			return rows.length ? expires : null;
		},
		internalLookup: async (c, code: string): Promise<string | null> => {
			requireServiceFor(c, "call");
			const [row] = await c.db.execute<{ pairing: string }>(
				"SELECT pairing FROM starts WHERE code = ? AND expires > ?",
				code,
				Date.now(),
			);
			return row?.pairing ?? null;
		},
	},
});

interface PairInput {
	grant: string;
	details: MachineClaim;
	publicKey: string;
	pollHash: string;
	expires: number;
}
export interface ClaimedMachine {
	details: MachineClaim;
	machineId: string;
	publicKey: string;
	expires: number;
}

export const machinePairing = actor({
	db: db({
		onMigrate: async db => {
			await db.execute(
				"CREATE TABLE IF NOT EXISTS pairing (details TEXT NOT NULL, public_key TEXT NOT NULL, poll_hash TEXT NOT NULL, expires INTEGER NOT NULL, uid TEXT, machine_id TEXT NOT NULL)",
			);
		},
	}),
	onCreate: async (c, input?: PairInput) => {
		if (!input || c.key.length !== 1 || !grantIsValid(input.grant, c.key, "machinePairing")) {
			c.destroy();
			return;
		}
		await c.schedule.at(input.expires, "expire");
		await c.db.execute(
			"INSERT INTO pairing VALUES (?, ?, ?, ?, NULL, ?)",
			JSON.stringify(input.details),
			input.publicKey,
			input.pollHash,
			input.expires,
			"m_" + randomBytes(8).toString("hex"),
		);
	},
	onBeforeConnect: internalConnection,
	actions: {
		internalClaim: async (c, uid: string): Promise<MachineClaim> => {
			requireServiceFor(c, "call");
			const [row] = await c.db.execute<{ details: string; public_key: string }>(
				"UPDATE pairing SET uid = ? WHERE (uid IS NULL OR uid = ?) AND expires > ? RETURNING details, public_key",
				uid,
				uid,
				Date.now(),
			);
			if (!row) throw pairingGone();
			const details: MachineClaim = JSON.parse(row.details);
			const keyFingerprint = machineKeyFingerprint(row.public_key);
			// Worked out from the key, never taken from what the machine says of itself.
			return {
				...details,
				...(keyFingerprint && { keyFingerprint }),
				keyPrinted: versionAtLeast(details.runnerVersion, PRINTS_KEY_RUNNER_VERSION),
			};
		},
		internalClaimed: async (c, uid: string): Promise<ClaimedMachine> => {
			requireServiceFor(c, "call");
			const [r] = await c.db.execute<{ details: string; public_key: string; machine_id: string; expires: number }>(
				"SELECT * FROM pairing WHERE uid = ? AND expires > ?",
				uid,
				Date.now(),
			);
			if (!r) throw pairingGone();
			return { details: JSON.parse(r.details), publicKey: r.public_key, machineId: r.machine_id, expires: r.expires };
		},
		/** Ends a pairing this user looked up: its runner's next poll finds it gone. */
		internalDeny: async (c, uid: string): Promise<void> => {
			requireServiceFor(c, "call");
			const ended = await c.db.execute(
				"UPDATE pairing SET expires = 0 WHERE uid = ? AND expires > ? RETURNING 1",
				uid,
				Date.now(),
			);
			if (!ended.length) throw pairingGone();
			c.destroy();
		},
		internalPoll: async (c, pollHash: string): Promise<PairStatus> => {
			requireServiceFor(c, "call");
			const [r] = await c.db.execute<{ uid: string | null; machine_id: string; expires: number; poll_hash: string }>(
				"SELECT uid, machine_id, expires, poll_hash FROM pairing WHERE expires > ?",
				Date.now(),
			);
			if (
				!r ||
				!/^[a-f0-9]{64}$/.test(pollHash) ||
				!timingSafeEqual(Buffer.from(r.poll_hash, "hex"), Buffer.from(pollHash, "hex"))
			)
				return { state: "gone" };
			if (!r.uid) return { state: "waiting" };
			// The user's confirmed row is the approval. A reservation, or a removed machine, cannot issue one.
			const approval: { login: string | null } | null = await c
				.client()
				.user.get([r.uid], { params: serviceParams() })
				.internalMachineApproval(r.machine_id);
			if (r.expires <= Date.now()) return { state: "gone" };
			return approval
				? {
						state: "approved",
						uid: r.uid,
						machineId: r.machine_id,
						githubLogin: approval.login,
						...(config.machines?.identity && {
							platformRoot: config.machines.identity.root,
							endpoint: signedRunnerEndpoint(config.machines.publicUrl),
						}),
					}
				: { state: "waiting" };
		},
		expire: c => {
			if (!c.scheduledFire) throw pairingGone();
			c.destroy();
		},
	},
});

export function asPairingError(error: unknown): never {
	if (isActorGone(error) || (error as { code?: unknown })?.code === "pairing_not_found") throw pairingGone();
	throw error;
}
