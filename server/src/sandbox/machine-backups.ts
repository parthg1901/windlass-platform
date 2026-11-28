/**
 * The copies of an agent's session for a session on one of its user's machines (`SessionBackups`,
 * api.ts). They are kept on that machine, in a volume its runner owns, and never leave it: neither
 * the platform's bucket nor the server holds a byte of them. What a copy holds, how it is packed and
 * how it is checked before it is unpacked are the bucket's (backup.ts, whose header is the spec;
 * backup-scripts.ts): only the transfer differs. The runner's side is runner/src/session-backups.ts.
 *
 *   save      1. `PACK` in the sandbox, the same script: an archive under /tmp, its size and SHA-256
 *                printed (or `empty`, `export`, `too_large`, as in the bucket's).
 *             2. `backupSave` (runner/protocol.ts): the runner reads that file out of the sandbox,
 *                removes it there, and keeps it when it has the size and hash the sandbox printed and
 *                is within the limit. The size and hash recorded are the runner's own measurements.
 *   restore   1. `backupRestore`: the runner checks the copy in its volume against the size and hash
 *                the session recorded, and only then puts it in the new sandbox at a path of /tmp.
 *             2. `RESTORE` in the sandbox, the same script with `from: "file"`: the size and hash
 *                again, the names the agent's description allows, unpacked without owners or modes,
 *                the agent's proof, its import.
 *   remove    recorded with the machine's actor (`internalRemoveBackup`), which tells the runner on
 *             its control socket now or when it is next connected, so a session deleted while its
 *             machine is offline still loses its copy.
 *   copy      `backupCopy`, over the socket of the session the copy is for.
 *
 * Only while the machine's runner offers it (the `session-backups` capability, `available`): an older
 * runner keeps no copies, and nothing is saved, restored or said. No link exists, so no secret reaches
 * the sandbox; a sandbox is trusted no further than its own session: the runner reads and writes only
 * the copy of the session whose socket asks, in that session's own sandbox, and never unpacks one
 * itself.
 */

import type {
	BackupAgentSession,
	BackupOwner,
	BackupRestoreResult,
	BackupSaveResult,
	SandboxHandle,
	SavedBackup,
	SessionBackups,
} from "./api.js";
import {
	BACKUP_ENV,
	PACK_TIMEOUT_MS,
	SHA256,
	backupStep,
	messageOf,
	packScript,
	restoreScript,
	sessionFilesEnv,
	validOwner,
} from "./backup-scripts.js";
import { harnessName } from "./harnesses.js";
import { randomId } from "./provider.js";
import type { Args, Value } from "../runner/protocol.js";

/** How long unpacking and an agent's import may take in the sandbox: nothing is fetched. */
const RESTORE_TIMEOUT_MS = 2 * 60 * 1000;

/** What a machine's copies need of its runner and its actor (runner-layer.ts gives the real ones; a check, a stand-in). */
export interface MachineBackupSeam {
	/** Whether the machine's runner said, in its last report, that it keeps copies. Never throws. */
	available(): Promise<boolean>;
	save(args: Args<"backupSave">): Promise<Value<"backupSave">>;
	restore(args: Args<"backupRestore">): Promise<Value<"backupRestore">>;
	copy(args: Args<"backupCopy">): Promise<Value<"backupCopy">>;
	/** Records the removal with the machine's actor. Throws when it could not be recorded. */
	remove(sessionId: string): Promise<void>;
}

export class MachineSessionBackups implements SessionBackups {
	constructor(
		readonly maxBytes: number,
		private readonly seam: MachineBackupSeam,
		private readonly now: () => number = Date.now,
	) {}

	available(): Promise<boolean> {
		return this.seam.available().catch(() => false);
	}

	/** The copy's name in the runner's volume, for a log. */
	keyOf(owner: BackupOwner): string {
		if (!validOwner(owner)) throw new Error("a backup is named by a user id and a session id");
		return `machine:${owner.uid}/${owner.sessionId}.tgz`;
	}

	async save(sandbox: SandboxHandle, owner: BackupOwner, session: BackupAgentSession): Promise<BackupSaveResult> {
		const began = this.now();
		try {
			this.keyOf(owner);
			const described = sessionFilesEnv(session);
			if (described === null)
				return {
					outcome: "failed",
					reason: "the agent's sessions are not copied, or its session id is not one of its own",
				};
			const pack = `/tmp/.wlp-backup-${randomId(6)}.tgz`;
			const packed = await backupStep(
				sandbox,
				"pack",
				packScript(described.files),
				{ ...described.env, [BACKUP_ENV.pack]: pack, [BACKUP_ENV.max]: String(this.maxBytes) },
				undefined,
				PACK_TIMEOUT_MS,
			);
			if (packed === "empty") return { outcome: "empty" };
			if (packed === "export")
				return {
					outcome: "failed",
					reason: `${harnessName(session.harness)} could not export its session, or the export is not one to copy`,
				};
			const tooLarge = /^too_large (\d+)$/.exec(packed);
			if (tooLarge !== null) return { outcome: "too_large", size: Number(tooLarge[1]), limit: this.maxBytes };
			const made = /^packed (\d+) ([0-9a-f]{64})$/.exec(packed);
			if (made === null) return { outcome: "failed", reason: `packing answered "${packed}"` };
			const size = Number(made[1]);
			// The runner reads no more than the limit; a sandbox that says more is not asked to give it.
			if (!Number.isSafeInteger(size) || size > this.maxBytes)
				return { outcome: "too_large", size, limit: this.maxBytes };
			const kept = await this.seam.save({
				id: sandbox.id,
				owner: { uid: owner.uid, sessionId: owner.sessionId },
				pack,
				size,
				sha256: made[2],
				max: this.maxBytes,
			});
			if (kept.outcome === "too_large") return { outcome: "too_large", size: kept.size, limit: this.maxBytes };
			if (kept.outcome === "changed")
				return {
					outcome: "failed",
					reason: "the archive the runner read is not the one the sandbox packed (its size or its hash differs)",
				};
			if (kept.outcome === "full")
				return { outcome: "failed", reason: "the machine's volume of copies has no room for this one" };
			if (kept.sha256 === undefined || !SHA256.test(kept.sha256) || kept.size > this.maxBytes)
				return { outcome: "failed", reason: "the runner's answer is not usable" };
			return {
				outcome: "saved",
				backup: { size: kept.size, sha256: kept.sha256, at: this.now() },
				ms: this.now() - began,
			};
		} catch (error) {
			return { outcome: "failed", reason: messageOf(error) };
		}
	}

	async restore(
		sandbox: SandboxHandle,
		owner: BackupOwner,
		saved: SavedBackup,
		session: BackupAgentSession,
	): Promise<BackupRestoreResult> {
		const began = this.now();
		try {
			this.keyOf(owner);
			const described = sessionFilesEnv(session);
			if (
				!Number.isSafeInteger(saved.size) ||
				saved.size < 0 ||
				saved.size > this.maxBytes ||
				!SHA256.test(saved.sha256) ||
				described === null
			)
				return { outcome: "failed", reason: "the session's record of its copy is not usable" };
			const pack = `/tmp/.wlp-backup-${randomId(6)}.tgz`;
			const placed = await this.seam.restore({
				id: sandbox.id,
				owner: { uid: owner.uid, sessionId: owner.sessionId },
				pack,
				size: saved.size,
				sha256: saved.sha256,
			});
			if (placed === "missing") return { outcome: "missing" };
			if (placed === "changed")
				return {
					outcome: "failed",
					reason:
						"the machine's copy is not the one this session saved (its size or its hash differs), so nothing of it was unpacked",
				};
			const answer = await backupStep(
				sandbox,
				"restore",
				restoreScript(described.files, "file"),
				{
					...described.env,
					[BACKUP_ENV.pack]: pack,
					[BACKUP_ENV.size]: String(saved.size),
					[BACKUP_ENV.sha256]: saved.sha256,
				},
				undefined,
				RESTORE_TIMEOUT_MS,
			);
			if (answer === "restored") return { outcome: "restored", ms: this.now() - began };
			const why: Record<string, string> = {
				missing: "the copy the runner put in the sandbox was not there",
				contents: "the copy holds a file a copy never holds, so nothing of it was unpacked",
				unpack: "the copy could not be unpacked",
				no_session: `the copy does not hold the ${harnessName(session.harness)} session`,
				import: `${harnessName(session.harness)} could not import the session from the copy`,
			};
			if (/^(size|hash) /.test(answer))
				return {
					outcome: "failed",
					reason: "the copy in the sandbox is not the one this session saved, so nothing of it was unpacked",
				};
			return { outcome: "failed", reason: why[answer] ?? `the restore answered "${answer}"` };
		} catch (error) {
			return { outcome: "failed", reason: messageOf(error) };
		}
	}

	async remove(owner: BackupOwner): Promise<void> {
		this.keyOf(owner);
		await this.seam.remove(owner.sessionId);
	}

	async copy(from: BackupOwner, to: BackupOwner): Promise<boolean> {
		this.keyOf(from);
		this.keyOf(to);
		if (from.uid !== to.uid) throw new Error("a copy is copied only between sessions of one user");
		return this.seam.copy({
			from: { uid: from.uid, sessionId: from.sessionId },
			to: { uid: to.uid, sessionId: to.sessionId },
		});
	}
}
