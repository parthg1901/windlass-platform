/**
 * A copy of an agent's session data, kept outside the sandbox: `SessionBackups` (api.ts) for every
 * provider whose sandboxes can run a shell command, over any `ObjectStore` (server/src/bucket/).
 *
 * What a copy holds is the agent's to say (session-files.ts, `SessionFiles`): its data directory, the
 * files of one session in it, the names a restore may unpack and the file that proves the session came
 * back. This file knows no agent's paths, only how a copy is made, moved and checked. The scripts and the
 * checks are in backup-scripts.ts, shared with a machine's copies (machine-backups.ts), which its runner
 * keeps in a volume on that machine instead of the bucket, under the same security model.
 *
 * ## How
 *
 * After a turn, and before a turn in a sandbox that replaces a lost one. An agent's process lives for
 * one turn: Windlass's turn code leaves none behind (turn.ts), and before an ACP agent's session is
 * packed, what a lost turn of it left is stopped (agent-session/workspace.ts, `saveBackup`). So between
 * turns nothing has the files open, and a plain `tar` of them is a whole copy: no SQLite tool is needed
 * in the image, and none is there. An agent whose files cannot be copied as they lie (OpenCode's one
 * database holds every session and its sign-ins) names a command that exports its session to a file
 * before packing, and one that imports it after unpacking (`beforePack`, `afterUnpack`). The archive is one object per agent session, `<prefix>sessions/<uid>/<session>.tgz`,
 * replaced every time.
 *
 * The commands run through the sandbox's handle, so beside Windlass and not under it: Windlass's
 * bubblewrap sandbox gives the agent's own commands no network, and these need the bucket. The server
 * signs a link and the sandbox's curl uses it, so the archive never passes through the server:
 *
 *   save      1. `PACK`: tar and gzip to a file under /tmp, its size and SHA-256 printed. Over the
 *                limit: removed, nothing is uploaded, the earlier copy stays as it was. An export
 *                that fails (`beforePack`) answers `export`, and nothing is uploaded either.
 *             2. the server signs a link to PUT exactly that many bytes, good for five minutes.
 *             3. `UPLOAD`: curl sends the file; the archive is removed whatever happens.
 *             4. the server asks the store for the object's size (a HEAD of its own), so that an
 *                upload a sandbox only claimed is not recorded.
 *   restore   1. the server signs a link to GET the object.
 *             2. `RESTORE`: curl fetches it; its size and SHA-256 must be the ones the session
 *                recorded when it was saved, and it may hold nothing but what a copy holds; only
 *                then is it unpacked, and the agent's session must be among what came out (`proof`);
 *                an import after that (`afterUnpack`) that fails answers `import`.
 *
 * The link is the only secret in this, and it reaches the sandbox on the command's standard input, as
 * a curl config (`-K -`): it is on no command line, in no environment and in no file. The scripts
 * print one line the server reads (`packed 1234 ab12...`, `http 200`, `curl 28`); nothing else a
 * sandbox prints is kept, logged or shown, so a link cannot come back in an error. `-q` keeps curl from
 * reading a `.curlrc` the agent may have written. The rest of what a step is told is in its environment
 * (`BACKUP_ENV`): paths, sizes, the session's id and the agent's patterns, never a secret. The session's
 * id is checked against the agent's pattern by the server and again by the script before any pattern
 * that names it is used.
 *
 * A sandbox is the user's agent's to do with as it likes, so nothing here trusts it further than its
 * own session: a link reaches one key, the upload's size is signed and under the limit, and what a
 * restore unpacks goes back into a sandbox of the same session and nowhere else.
 */

import { backupConfig } from "../config.js";
import type { ObjectStore } from "../bucket/store.js";
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
	UPLOAD_SCRIPT,
	backupStep,
	messageOf,
	packScript,
	restoreScript,
	sessionFilesEnv,
	validOwner,
} from "./backup-scripts.js";
import { harnessName } from "./harnesses.js";
import { randomId } from "./provider.js";

export {
	BACKUP_ENV,
	UPLOAD_SCRIPT,
	answerOf,
	findCommand,
	packScript,
	restoreScript,
	sessionFilesEnv,
} from "./backup-scripts.js";

/** How long a signed link lasts: long enough for a slow upload of the largest archive, short enough to be worth little. */
export const LINK_TTL_MS = 5 * 60 * 1000;
/** How long curl may take over one transfer, retries included: inside the link's life. */
const TRANSFER_SECONDS = 180;
const TRANSFER_TIMEOUT_MS = (TRANSFER_SECONDS + 60) * 1000;

/** What curl reads its one setting from: the link, and nothing a link could break out of. */
function curlConfig(url: string): string {
	if (/["\\\s]/.test(url)) throw new Error("a signed link holds a character a curl config cannot carry");
	return `url = "${url}"\n`;
}

export interface SandboxSessionBackupsOptions {
	/** The largest archive that is kept, in bytes. */
	maxBytes: number;
	/** Put before every key, ending in a slash when not empty. */
	prefix?: string;
	now?: () => number;
}

export class SandboxSessionBackups implements SessionBackups {
	readonly maxBytes: number;
	private readonly prefix: string;
	private readonly now: () => number;

	constructor(
		private readonly store: ObjectStore,
		options: SandboxSessionBackupsOptions,
	) {
		this.maxBytes = options.maxBytes;
		this.prefix = options.prefix ?? "";
		this.now = options.now ?? Date.now;
	}

	/** One object per agent session, under its user. */
	keyOf(owner: BackupOwner): string {
		if (!validOwner(owner)) throw new Error("a backup is named by a user id and a session id");
		return `${this.prefix}sessions/${owner.uid}/${owner.sessionId}.tgz`;
	}

	async save(sandbox: SandboxHandle, owner: BackupOwner, session: BackupAgentSession): Promise<BackupSaveResult> {
		const began = this.now();
		try {
			const key = this.keyOf(owner);
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
			const sha256 = made[2];
			// The sandbox's word for the size is only what the link is made for: more than the limit gets none.
			if (!Number.isSafeInteger(size) || size > this.maxBytes)
				return { outcome: "too_large", size, limit: this.maxBytes };

			const link = await this.store.linkToPut(key, { size, ttlMs: LINK_TTL_MS });
			const sent = await backupStep(
				sandbox,
				"upload",
				UPLOAD_SCRIPT,
				{ [BACKUP_ENV.pack]: pack, [BACKUP_ENV.size]: String(size), [BACKUP_ENV.seconds]: String(TRANSFER_SECONDS) },
				curlConfig(link.url),
				TRANSFER_TIMEOUT_MS,
			);
			if (sent !== "http 200") return { outcome: "failed", reason: `the upload answered "${sent}"` };
			// The store's own word that the object is there. When it cannot be asked just now, the upload's answer stands.
			const stored = await this.store.size(key).catch(() => undefined);
			if (stored !== undefined && stored !== size)
				return {
					outcome: "failed",
					reason:
						stored === null
							? "the sandbox reported an upload, but the bucket has no such object"
							: `the sandbox reported an upload of ${size} bytes, but the bucket's object has ${stored}`,
				};
			return { outcome: "saved", backup: { size, sha256, at: this.now() }, ms: this.now() - began };
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
			const described = sessionFilesEnv(session);
			if (!Number.isSafeInteger(saved.size) || saved.size < 0 || !SHA256.test(saved.sha256) || described === null)
				return { outcome: "failed", reason: "the session's record of its copy is not usable" };
			const link = await this.store.linkToGet(this.keyOf(owner), { ttlMs: LINK_TTL_MS });
			const answer = await backupStep(
				sandbox,
				"restore",
				restoreScript(described.files),
				{
					...described.env,
					[BACKUP_ENV.pack]: `/tmp/.wlp-backup-${randomId(6)}.tgz`,
					[BACKUP_ENV.size]: String(saved.size),
					[BACKUP_ENV.sha256]: saved.sha256,
					[BACKUP_ENV.seconds]: String(TRANSFER_SECONDS),
				},
				curlConfig(link.url),
				TRANSFER_TIMEOUT_MS,
			);
			if (answer === "restored") return { outcome: "restored", ms: this.now() - began };
			if (answer === "http 404") return { outcome: "missing" };
			const why: Record<string, string> = {
				contents: "the copy holds a file a copy never holds, so nothing of it was unpacked",
				unpack: "the copy could not be unpacked",
				no_session: `the copy does not hold the ${harnessName(session.harness)} session`,
				import: `${harnessName(session.harness)} could not import the session from the copy`,
			};
			if (/^(size|hash) /.test(answer))
				return {
					outcome: "failed",
					reason:
						"the bucket's object is not the copy this session saved (its size or its hash differs), so nothing of it was unpacked",
				};
			return { outcome: "failed", reason: why[answer] ?? `the download answered "${answer}"` };
		} catch (error) {
			return { outcome: "failed", reason: messageOf(error) };
		}
	}

	async remove(owner: BackupOwner): Promise<void> {
		await this.store.remove(this.keyOf(owner));
	}

	async copy(from: BackupOwner, to: BackupOwner): Promise<boolean> {
		return this.store.copy(this.keyOf(from), this.keyOf(to));
	}
}

/**
 * The backups of a deployment, from the server's settings (config.ts, "The bucket"): null when no
 * bucket is configured. Says once, where the server's other lines go, whether copies are kept, and
 * which settings are missing when only some are there. Settings that cannot be used turn the feature
 * off with a warning, and never keep the server from running agents; a bucket that refuses the
 * server's key is said when the server starts and not at the first save. The S3 store is loaded only
 * when it is used. No line holds a setting's value.
 */
export async function backupsFromConfig(
	print: (line: string) => void = line => console.log(line),
): Promise<SessionBackups | null> {
	const lost = "an agent whose sandbox is lost starts without its memory of the conversation";
	try {
		const found = backupConfig();
		if (found.bucket === null) {
			if (found.missing.length > 0)
				print(
					`[wlp] WARNING: The bucket for the agents' memory is only partly configured (${found.missing.join(", ")} ${found.missing.length === 1 ? "is" : "are"} not set), so no copy is kept: ${lost}.`,
				);
			else
				print(
					`[wlp] backups: off (no bucket is configured: WLP_BUCKET_ENDPOINT, WLP_BUCKET_NAME, WLP_BUCKET_ACCESS_KEY_ID, WLP_BUCKET_SECRET_ACCESS_KEY): ${lost}.`,
				);
			return null;
		}
		const { S3ObjectStore } = await import("../bucket/s3.js");
		const store = new S3ObjectStore(found.bucket);
		print(
			`[wlp] backups: on. The agents' session data is copied to the bucket after every turn of a sandbox that may be lost, up to ${Math.round(found.maxBytes / 1024 / 1024)} MiB a session, and restored into a sandbox that replaces a lost one.`,
		);
		// Asked of an object that does not exist: a bucket that takes the key answers that there is none.
		void store.size(`${found.prefix}sessions/wlp-probe/wlp-probe.tgz`).catch((error: unknown) => {
			print(
				`[wlp] WARNING: The bucket for the agents' memory did not take the server's request (${messageOf(error)}). Until it does, no copy can be saved or restored: check WLP_BUCKET_ENDPOINT, WLP_BUCKET_NAME and the access key.`,
			);
		});
		return new SandboxSessionBackups(store, { maxBytes: found.maxBytes, prefix: found.prefix });
	} catch (error) {
		print(`[wlp] WARNING: The bucket's settings cannot be used (${messageOf(error)}), so no copy is kept: ${lost}.`);
		return null;
	}
}
