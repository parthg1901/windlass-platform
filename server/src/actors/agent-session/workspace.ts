import { snapshotPrompt } from "../../sandbox/snapshot-key.js";
import { describeError } from "../../auth.js";
import type { WorkspaceFile } from "../../contract.js";
import type { SandboxHandle, SandboxLayer } from "../../sandbox/api.js";
import { setupNote } from "../../setup-command.js";
import { userActor } from "../internal.js";
import { privateSessionData } from "../../sandbox/session-data.js";
import { machineHarness } from "../../sandbox/harnesses.js";
import { isTurnSandbox } from "../../sandbox/provider.js";
import { note } from "./timeline.js";
import type { SessionMeta, Ctx, WorkspaceCopy } from "./state.js";
import { layerOf } from "./runner.js";
import { continuationNote } from "./continuation.js";

function megabytes(bytes: number): string {
	const mb = bytes / (1024 * 1024);
	return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

const FRESH_WORKSPACE =
	"[A note from the platform, not from the user: the sandbox you were working in has been replaced by a new one. Your memory of this conversation was carried over, but the workspace was not: it is a fresh one. A repository that was cloned has been cloned again, with whatever of your work had been pushed to its branch; anything else you created or changed earlier is not in it. Look at what is there before you rely on earlier work.]\n\n";

// Clear a one-shot note only after the agent receives the prompt it was attached to.
export function platformNotes(meta: SessionMeta, reviewer: boolean): { text: string; told(): void } {
	const prepared = meta.snapshotCommit ?? null;
	// A continuing session's note says the workspace is new in its own words.
	const continued = continuationNote(meta);
	const fresh = !reviewer && meta.freshWorkspace === true;
	const unfinished = reviewer ? null : (meta.setupUnfinished ?? null);
	const onBase = reviewer ? null : (meta.setupOnBase ?? null);
	return {
		text:
			(prepared ? snapshotPrompt(prepared) : "") +
			(continued || (fresh ? FRESH_WORKSPACE : "")) +
			(unfinished ? setupNote(unfinished) : "") +
			(onBase ? setupOnBaseNote(onBase) : ""),
		told() {
			if (fresh) meta.freshWorkspace = false;
			if (continued && meta.continuedFrom) {
				meta.continuedFrom.told = true;
				meta.handoff = null;
			}
			if (unfinished && meta.setupUnfinished === unfinished) meta.setupUnfinished = null;
			if (prepared && meta.snapshotCommit === prepared) meta.snapshotCommit = null;
			if (onBase && meta.setupOnBase === onBase) meta.setupOnBase = null;
		},
	};
}

export async function restoreBackup(
	c: Ctx,
	meta: SessionMeta,
	turn: number,
	sandbox: SandboxHandle,
	layer: SandboxLayer,
): Promise<boolean> {
	const backups = layer.backups;
	const saved = meta.backup;
	const session = meta.windlassSessionId;
	// Without a bucket nothing was ever copied, and nothing is said of it; nor on a machine whose runner keeps no copies.
	if (!backups || !session) return false;
	if (backups.available && !(await backups.available())) {
		if (saved?.windlassSessionId === session)
			console.log(
				`[wlp] backup.unavailable session=${meta.sessionId} turn=${turn}: the machine's runner keeps no copies now`,
			);
		return false;
	}
	if (!saved || saved.windlassSessionId !== session) {
		console.log(
			`[wlp] backup.none session=${meta.sessionId} turn=${turn}: ${saved ? "the copy is of an earlier session of the agent" : "no copy of the session was saved"}`,
		);
		return false;
	}
	try {
		const restored = await backups.restore(sandbox, { uid: meta.uid, sessionId: meta.sessionId }, saved, {
			harness: meta.harness,
			sessionId: session,
		});
		if (restored.outcome !== "restored") {
			console.warn(
				`[wlp] backup.restore_failed session=${meta.sessionId} turn=${turn}: ${restored.outcome === "missing" ? "the bucket has no copy of the session" : restored.reason}`,
			);
			return false;
		}
		console.log(
			`[wlp] backup.restored session=${meta.sessionId} turn=${turn} bytes=${saved.size} ms=${restored.ms} saved_after_turn=${saved.turn}`,
		);
	} catch (error) {
		c.log.warn({
			msg: "could not restore the copy of the agent's session",
			session: meta.sessionId,
			error: describeError(error),
		});
		return false;
	}
	// What came back was small enough to copy: it is copied again from this turn on.
	meta.backupStopped = null;
	meta.freshWorkspace = true;
	// A turn whose copy could not be saved, or was too large to keep, is not in what came back.
	const missed = (meta.memoryTurn ?? saved.turn) > saved.turn ? Math.max(1, turn - 1 - saved.turn) : 0;
	if (missed === 0) note(c, turn, "info", "Restored the agent's memory of the conversation into the new sandbox.");
	else
		note(
			c,
			turn,
			"warn",
			`Restored the agent's memory of the conversation into the new sandbox, without the last ${missed === 1 ? "turn: no copy of it" : `${missed} turns: no copy of them`} could be saved.`,
		);
	return true;
}

/**
 * Stops what a lost turn of an ACP agent left running in the sandbox, so that nothing writes to its
 * session while it is packed: the agent's turn does the same only when the next one starts
 * (acp-harness.ts). Windlass's turn leaves none (turn.ts). Only a handle that can start processes can
 * have any. Throws when they could not be stopped, and the session is then not packed.
 */
async function stopAgentLeftovers(meta: SessionMeta, sandbox: SandboxHandle): Promise<void> {
	const profile = machineHarness(meta.harness);
	if (profile && isTurnSandbox(sandbox)) await sandbox.stopLeftovers(profile.leftovers);
}

// Copy after the process exits. Retry a failed backup at the next turn end without waking an idle sandbox.
export async function saveBackup(
	c: Ctx,
	meta: SessionMeta,
	turn: number,
	sandbox: SandboxHandle,
	layer: SandboxLayer,
): Promise<void> {
	const backups = layer.backups;
	const session = meta.windlassSessionId;
	if (!backups || !(await privateSessionData(meta, layer.sandboxes, sandbox.id)) || !session) return;
	// A machine whose runner keeps no copies (an older runner): nothing is saved, and the turn is not counted as missed.
	if (backups.available && !(await backups.available())) return;
	// Until a copy is saved below, the one there is, if any, is behind this turn.
	meta.memoryTurn = turn;
	// A session that is going away needs no copy, and an actor that is stopping has no time for one.
	if (c.vars.stopping || c.vars.destroying) return;
	const stopped = meta.backupStopped;
	// An agent's session only grows: what was too large is not packed again to find that out.
	if (stopped && backups.maxBytes <= stopped.limit) return;
	try {
		try {
			await stopAgentLeftovers(meta, sandbox);
		} catch (error) {
			console.warn(
				`[wlp] backup.save_failed session=${meta.sessionId} turn=${turn}: what an earlier turn left running could not be stopped (${describeError(error)})`,
			);
			return;
		}
		const saved = await backups.save(
			sandbox,
			{ uid: meta.uid, sessionId: meta.sessionId },
			{ harness: meta.harness, sessionId: session },
		);
		if (saved.outcome === "saved") {
			meta.backup = { windlassSessionId: session, ...saved.backup, turn };
			meta.backupStopped = null;
			console.log(
				`[wlp] backup.saved session=${meta.sessionId} turn=${turn} bytes=${saved.backup.size} ms=${saved.ms}`,
			);
		} else if (saved.outcome === "too_large") {
			console.log(
				`[wlp] backup.too_large session=${meta.sessionId} turn=${turn} bytes=${saved.size} limit=${saved.limit}`,
			);
			const earlier = meta.backup?.windlassSessionId === session;
			if (!stopped) {
				note(
					c,
					turn,
					"warn",
					`The agent's memory of the conversation has grown to ${megabytes(saved.size)}, and the platform keeps a copy of at most ${megabytes(saved.limit)}, so it is no longer copied out of the sandbox. If this sandbox is lost, the agent ${earlier ? "will not remember the conversation from here on" : "starts without its memory of the conversation"}.`,
				);
			}
			meta.backupStopped = { size: saved.size, limit: saved.limit };
		} else if (saved.outcome === "failed") {
			console.warn(`[wlp] backup.save_failed session=${meta.sessionId} turn=${turn}: ${saved.reason}`);
		}
	} catch (error) {
		c.log.warn({
			msg: "could not copy the agent's session out of the sandbox",
			session: meta.sessionId,
			error: describeError(error),
		});
	}
}

/** The sessions whose copy was removed already, or handed to the `user` actor, so that a delete asks the bucket once. */
const backupRemoved = new WeakSet<SessionMeta>();

// Deletion must remove backup data even if the actor never recorded a successful save.
export async function removeBackup(c: Ctx, meta: SessionMeta): Promise<void> {
	if (backupRemoved.has(meta)) return;
	try {
		const layer = await layerOf(c, meta);
		if (!layer.backups || (!meta.backup && !(await privateSessionData(meta, layer.sandboxes, meta.sandboxId)))) return;
		for (let attempt = 1; ; attempt += 1) {
			try {
				await layer.backups.remove({ uid: meta.uid, sessionId: meta.sessionId });
				backupRemoved.add(meta);
				meta.backup = null;
				console.log(`[wlp] backup.removed session=${meta.sessionId}`);
				return;
			} catch (error) {
				if (attempt >= 3) {
					console.warn(
						`[wlp] backup.remove_retry uid=${meta.uid} session=${meta.sessionId} try=${attempt}: ${describeError(error)}`,
					);
					break;
				}
				await new Promise(resolve => setTimeout(resolve, 1_000));
			}
		}
		await userActor(c, meta.uid).internalRemoveBackupLater(
			meta.sessionId,
			meta.place.kind === "machine" ? meta.place.machineId : undefined,
		);
		backupRemoved.add(meta);
	} catch (error) {
		console.error(
			`[wlp] backup.remove_failed uid=${meta.uid} session=${meta.sessionId}: the copy of this deleted session's agent data may still be ${meta.place.kind === "machine" ? "on its machine" : "in the bucket"} (${describeError(error)})`,
		);
	}
}

/** What the agent is told, once, after its workspace was put on its branch past a setup run on the base. */
const setupOnBaseNote = (where: { branch: string; base: string }) =>
	`[A note from the platform, not from the user: in this new sandbox the repository's setup command ran on ${where.base}, before the workspace was put on your branch ${where.branch}; it never runs on what a session pushed. What your branch added or changed in its dependencies is not installed: install it with your own commands if you need it.]\n\n`;

export async function savedWorkspace(c: Ctx): Promise<WorkspaceCopy | null> {
	if (c.vars.workspace !== undefined) return c.vars.workspace;
	const [row] = await c.db.execute<{ files: string; diff: string }>("SELECT files, diff FROM workspace WHERE id = 1");
	c.vars.workspace = row ? { files: JSON.parse(row.files) as WorkspaceFile[], diff: row.diff } : null;
	return c.vars.workspace;
}

/** Forgets the copy: the workspace it was taken from is gone, or changed without a new copy. Never throws. */
export async function dropWorkspace(c: Ctx): Promise<void> {
	c.vars.workspace = null;
	await c.db.execute("DELETE FROM workspace").catch((error: unknown) => {
		c.log.warn({ msg: "could not forget the copy of the workspace", error: describeError(error) });
	});
}
