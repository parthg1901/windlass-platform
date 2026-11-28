/**
 * The names a session copy is known by: its owner (a user id and a session id) and the path a sandbox
 * packs it at. Apart from backup-scripts.ts, which imports the agents' descriptions (session-files.ts),
 * so that the runner's bundle holds no more than these.
 */

import type { BackupOwner } from "./api.js";
import { NAME } from "./provider.js";

/** The agent session's id becomes part of an object's key, and of the patterns the scripts use: no character a glob or a regex reads. */
export const SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Where a sandbox packs a copy, and where a machine's runner puts one back: under /tmp, a name of the platform's. */
export const PACK_PATH = /^\/tmp\/\.wlp-backup-[a-z0-9]{6,32}\.tgz$/;

/** Whether a copy's owner is one a copy may be named by: a user id and a session id, each of the platform's form. */
export function validOwner(owner: BackupOwner): boolean {
	return (
		typeof owner?.uid === "string" &&
		NAME.test(owner.uid) &&
		typeof owner.sessionId === "string" &&
		SESSION.test(owner.sessionId)
	);
}
