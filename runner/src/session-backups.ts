/**
 * The runner's side of the copies of its sessions' agent sessions (server/src/sandbox/machine-backups.ts,
 * whose header says what a copy is for; the `session-backups` capability). The copies stay on this
 * machine, one archive per session in a volume of the pairing's own, `wlp-machine-<id>-backups`, made
 * with the pairing's labels and checked like its other volumes (`ownedVolume`); `prune` and a removal
 * with "remove sandboxes" drop it with the rest.
 *
 * What is checked here, whatever the server or a sandbox says:
 *
 *   - A copy is the asking session's own: the owner must be this pairing's user and the session whose
 *     socket asks, and the sandbox that session's (the executor's `running`). A copy to a new session
 *     (`copy`) must be to the asking session, from another session of the same user.
 *   - Names are checked again (`validOwner`, `PACK_PATH`) before any is used in a path.
 *   - The runner reads at most the limit (and never more than BACKUP_CEILING) out of a sandbox, measures
 *     the size and SHA-256 itself, and keeps the archive only when they are what the sandbox printed;
 *     what the server records is that measurement. A restore puts a copy in a sandbox only when its
 *     size and hash are the ones the session recorded.
 *   - It never unpacks a copy, nor reads what is in one: the sandbox of the same session does, with the
 *     restore script's checks of the names and without owners or modes (backup-scripts.ts).
 *   - The volume holds at most BACKUP_VOLUME_BYTES in all: a copy that would go past it is refused
 *     (`full`), and the session's earlier copy stays.
 *
 * The bytes pass through the runner's memory, never through a file on the host: out of the sandbox with
 * `docker exec cat`, into the volume with a helper container (no network, no capabilities, read-only
 * root), and back the same way.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { Args, Value } from "../../server/src/runner/protocol.js";
import { PACK_PATH, SESSION, validOwner } from "../../server/src/sandbox/backup-names.js";
import { LABEL_ARG, NO_LOGS, docker, tmpName } from "../../server/src/sandbox/docker.js";
import type { BackupOwner } from "../../server/src/sandbox/api.js";
import { NAME } from "../../server/src/sandbox/provider.js";
import { Refusal, RunnerError } from "./state.js";

/** The largest copy a runner reads into memory, whatever limit a server names. */
export const BACKUP_CEILING = 512 * 1024 * 1024;
/** What the volume of copies may hold in all: 32 copies at the platform's default limit of 64 MiB. */
export const BACKUP_VOLUME_BYTES = 2 * 1024 * 1024 * 1024;
const STEP_MS = 120_000;

/** Where the bytes go: Docker (`dockerBackupIO`), or a check's stand-in. Names are checked before they get here. */
export interface BackupIO {
	/** The file at `pack` in the sandbox `container`; null when it cannot be read, "too_large" past `limit` bytes. */
	readPack(container: string, pack: string, limit: number): Promise<Buffer | "too_large" | null>;
	/** Removes the file at `pack` in the sandbox, if there is one. Never throws. */
	dropPack(container: string, pack: string): Promise<void>;
	/** Writes `data` to `pack` in the sandbox, as its user, readable by it alone. False when it could not. */
	putPack(container: string, pack: string, data: Buffer): Promise<boolean>;
	/** The session's copy; null when there is none, "too_large" past `limit` bytes. */
	read(uid: string, session: string, limit: number): Promise<Buffer | "too_large" | null>;
	/** Replaces the session's copy with `data`, unless the volume would then hold more than `total`. */
	write(uid: string, session: string, data: Buffer, total: number): Promise<"ok" | "full">;
	copy(uid: string, from: string, to: string, total: number): Promise<"ok" | "missing" | "full">;
	remove(uid: string, session: string): Promise<void>;
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export class BackupStore {
	private chain: Promise<unknown> = Promise.resolve();

	constructor(
		readonly uid: string,
		private readonly io: BackupIO,
		readonly totalBytes = BACKUP_VOLUME_BYTES,
	) {}

	/** One change of the volume at a time: a save and a copy to the same name never interleave. */
	private serial<T>(work: () => Promise<T>): Promise<T> {
		const next = this.chain.then(work);
		this.chain = next.catch(() => undefined);
		return next;
	}

	private ownedBy(owner: BackupOwner, session: string): void {
		if (!validOwner(owner) || owner.uid !== this.uid || !NAME.test(owner.sessionId))
			throw new Refusal("This copy is not one of this machine's.");
		if (owner.sessionId !== session) throw new Refusal("This copy belongs to another session.");
	}

	private static pack(path: string): void {
		if (!PACK_PATH.test(path)) throw new Refusal("A copy is moved only through a path of the platform's.");
	}

	/** `backupSave` for the session `session`, from its sandbox `container`. */
	async save(session: string, container: string, a: Args<"backupSave">): Promise<Value<"backupSave">> {
		this.ownedBy(a.owner, session);
		BackupStore.pack(a.pack);
		const limit = Math.min(a.max, BACKUP_CEILING);
		let data: Buffer | "too_large" | null;
		try {
			data = a.size > limit ? "too_large" : await this.io.readPack(container, a.pack, limit);
		} finally {
			await this.io.dropPack(container, a.pack);
		}
		if (data === "too_large") return { outcome: "too_large", size: Math.max(a.size, limit + 1) };
		if (data === null || data.length !== a.size) return { outcome: "changed", size: data?.length ?? 0 };
		const hash = sha256(data);
		if (hash !== a.sha256) return { outcome: "changed", size: data.length };
		const kept = await this.serial(() => this.io.write(this.uid, a.owner.sessionId, data, this.totalBytes));
		if (kept === "full") return { outcome: "full", size: data.length };
		return { outcome: "saved", size: data.length, sha256: hash };
	}

	/** `backupRestore` for the session `session`, into its sandbox `container`. */
	async restore(session: string, container: string, a: Args<"backupRestore">): Promise<Value<"backupRestore">> {
		this.ownedBy(a.owner, session);
		BackupStore.pack(a.pack);
		if (a.size > BACKUP_CEILING) return "changed";
		const data = await this.serial(() => this.io.read(this.uid, a.owner.sessionId, a.size));
		if (data === null) return "missing";
		if (data === "too_large" || data.length !== a.size || sha256(data) !== a.sha256) return "changed";
		if (!(await this.io.putPack(container, a.pack, data)))
			throw new RunnerError("The copy could not be put in the sandbox.");
		return "placed";
	}

	/** `backupCopy`, asked by the session `session`, which the copy is for. */
	async copy(session: string, a: Args<"backupCopy">): Promise<Value<"backupCopy">> {
		this.ownedBy(a.to, session);
		if (!validOwner(a.from) || a.from.uid !== this.uid || !NAME.test(a.from.sessionId))
			throw new Refusal("This copy is not one of this machine's.");
		if (a.from.sessionId === a.to.sessionId) throw new Refusal("A copy is copied to another session.");
		const done = await this.serial(() => this.io.copy(this.uid, a.from.sessionId, a.to.sessionId, this.totalBytes));
		if (done === "full") throw new Refusal("This machine's volume of copies has no room for another.");
		return done === "ok";
	}

	/** `forget-backup` on the control socket: the session was deleted. A copy that is not there is removed already. */
	async remove(sessionId: string): Promise<void> {
		if (typeof sessionId !== "string" || !NAME.test(sessionId) || !SESSION.test(sessionId))
			throw new Refusal("This is not a session of this machine's.");
		await this.serial(() => this.io.remove(this.uid, sessionId));
	}
}

// ---------------------------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------------------------

/** One child to its end: its output up to `limit` bytes (killed past it), with `stdin` written. */
function collect(
	argv: string[],
	options: { stdin?: Buffer; limit?: number; timeoutMs?: number; name?: string } = {},
): Promise<{ code: number | null; stdout: Buffer | "too_large" }> {
	return new Promise(resolve => {
		const child = spawn("docker", argv, { stdio: ["pipe", "pipe", "ignore"] });
		const chunks: Buffer[] = [];
		let size = 0;
		let over = false;
		const limit = options.limit ?? 0;
		const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? STEP_MS);
		child.stdout.on("data", (chunk: Buffer) => {
			if (over) return;
			size += chunk.length;
			if (size > limit) {
				over = true;
				chunks.length = 0;
				child.kill("SIGKILL");
				return;
			}
			chunks.push(chunk);
		});
		// A helper that refuses before reading its input closes it: that is its answer, not an error here.
		child.stdin.on("error", () => undefined);
		child.on("error", () => {
			clearTimeout(timer);
			resolve({ code: null, stdout: Buffer.alloc(0) });
		});
		child.on("close", async code => {
			clearTimeout(timer);
			// Killing the client leaves a helper container running.
			if (code === null && options.name) await docker(["rm", "-f", options.name]).catch(() => undefined);
			resolve({ code, stdout: over ? "too_large" : Buffer.concat(chunks) });
		});
		child.stdin.end(options.stdin ?? Buffer.alloc(0));
	});
}

/**
 * The volume's one helper script: `$1` the step, `$2` the user, then the step's names. Exit 3: no
 * copy; 4: the volume would hold more than its total; 5: what was written is not what was sent.
 */
const VOLUME_SCRIPT = `set -eu
umask 077
op=$1 uid=$2 a=$3 b=$4 total=$5
d=/backups/$uid
used() { du -sb /backups | cut -f1; }
sizeof() { if [ -f "$1" ] && [ ! -L "$1" ]; then stat -c %s -- "$1"; else echo 0; fi; }
plain() { [ -f "$1" ] && [ ! -L "$1" ]; }
case "$op" in
read) f=$d/$a.tgz; plain "$f" || exit 3; exec cat -- "$f" ;;
write)
	mkdir -p -- "$d"; f=$d/$a.tgz; t=$d/.$a.part; rm -f -- "$t"
	if [ $(( $(used) - $(sizeof "$f") + b )) -gt "$total" ]; then exit 4; fi
	cat > "$t"
	if [ "$(stat -c %s -- "$t")" != "$b" ]; then rm -f -- "$t"; exit 5; fi
	mv -f -- "$t" "$f" ;;
copy)
	s=$d/$a.tgz; f=$d/$b.tgz; t=$d/.$b.part
	plain "$s" || exit 3
	rm -f -- "$t"
	if [ $(( $(used) - $(sizeof "$f") + $(stat -c %s -- "$s") )) -gt "$total" ]; then exit 4; fi
	cp -- "$s" "$t"; mv -f -- "$t" "$f" ;;
remove) rm -f -- "$d/$a.tgz" "$d/.$a.part" ;;
*) exit 2 ;;
esac
`;

export interface DockerBackupOptions {
	/** The volume of copies: `wlp-machine-<id>-backups`. */
	volume: string;
	/** The pairing's labels, which every helper carries, so that `prune` finds one a killed runner left. */
	labels: Record<string, string>;
	/** The pinned base sandbox image, never a session's own: it runs the helper. */
	image: string;
	/** The executor's `ownedVolume` of the volume of copies: made when `create`, refused when it is not the pairing's. */
	ownedVolume(create: boolean): Promise<boolean>;
}

export function dockerBackupIO(options: DockerBackupOptions): BackupIO {
	const helper = (args: string[], io: { stdin?: Buffer; limit?: number } = {}) => {
		const name = tmpName();
		return collect(
			[
				"run",
				"--rm",
				"-i",
				"--pull",
				"never",
				"--name",
				name,
				"--label",
				LABEL_ARG,
				...Object.entries(options.labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
				...NO_LOGS,
				"--network",
				"none",
				// Root without a capability: it owns the volume's files, and can do nothing else.
				"--user",
				"0:0",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				"--read-only",
				"--memory",
				"256m",
				"--pids-limit",
				"32",
				"--mount",
				`type=volume,src=${options.volume},dst=/backups,volume-nocopy`,
				"--entrypoint",
				"/bin/sh",
				options.image,
				"-c",
				VOLUME_SCRIPT,
				"sh",
				...args,
			],
			{ ...io, name },
		);
	};
	const failed = (step: string, code: number | null) =>
		new RunnerError(`The volume of copies could not ${step} (helper exit ${code ?? "killed"}).`);
	return {
		async readPack(container, pack, limit) {
			const read = await collect(["exec", "-w", "/", container, "cat", "--", pack], { limit });
			if (read.stdout === "too_large") return "too_large";
			return read.code === 0 ? read.stdout : null;
		},
		async dropPack(container, pack) {
			await docker(["exec", "-w", "/", container, "rm", "-f", "--", pack], { timeoutMs: 30_000 }).catch(
				() => undefined,
			);
		},
		async putPack(container, pack, data) {
			const put = await collect(
				[
					"exec",
					"-i",
					"-w",
					"/",
					container,
					"sh",
					"-c",
					'umask 077 && rm -f -- "$1" && set -C && cat > "$1"',
					"sh",
					pack,
				],
				{ stdin: data },
			);
			return put.code === 0;
		},
		async read(uid, session, limit) {
			if (!(await options.ownedVolume(false))) return null;
			const read = await helper(["read", uid, session, "", "0"], { limit });
			if (read.stdout === "too_large") return "too_large";
			if (read.code === 3) return null;
			if (read.code !== 0) throw failed("be read", read.code);
			return read.stdout;
		},
		async write(uid, session, data, total) {
			await options.ownedVolume(true);
			const wrote = await helper(["write", uid, session, String(data.length), String(total)], { stdin: data });
			if (wrote.code === 4) return "full";
			if (wrote.code !== 0) throw failed("keep the copy", wrote.code);
			return "ok";
		},
		async copy(uid, from, to, total) {
			if (!(await options.ownedVolume(false))) return "missing";
			const copied = await helper(["copy", uid, from, to, String(total)]);
			if (copied.code === 3) return "missing";
			if (copied.code === 4) return "full";
			if (copied.code !== 0) throw failed("copy the copy", copied.code);
			return "ok";
		},
		async remove(uid, session) {
			if (!(await options.ownedVolume(false))) return;
			const removed = await helper(["remove", uid, session, "", "0"]);
			if (removed.code !== 0) throw failed("remove the copy", removed.code);
		},
	};
}
