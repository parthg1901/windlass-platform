/**
 * Continuing a session in a new one (`continueSession` in user.ts): what the earlier session hands over
 * (`forkSource`), what the new one starts with (`continuationMeta`), and the one-time note its agent is
 * given (`continuationNote`). The new session has its own workspace, branch and pull request; what
 * carries over is its settings, its trust and the agent's memory, as a copy of the agent's session where
 * the backup store has one, else as an account of the earlier timeline (turn-resume.ts, `sessionHandoff`).
 */

import { UserError } from "rivetkit";
import type { Continuation, ForkSource } from "../internal.js";
import { sessionHandoff } from "../turn-resume.js";
import { taskTimeline } from "./pause.js";
import type { Ctx, SessionMeta } from "./state.js";

/** The longest earlier title the agent is told. */
const TITLE_LIMIT = 120;

/** What `internalForkSource` answers, or why this session cannot be continued. */
export async function forkSource(c: Ctx, meta: SessionMeta): Promise<ForkSource> {
	if (meta.origin || meta.readiness || meta.environmentBuild)
		throw new UserError("Only your own agents can be continued in a new pull request.", { code: "item_session" });
	if (!meta.repo)
		throw new UserError(
			"This agent has no repository from your GitHub connection, so there is no pull request to continue.",
			{
				code: "no_repository",
			},
		);
	if (c.vars.turn || c.vars.accepting || meta.run || meta.status !== "idle")
		throw new UserError("The agent is working. Continue it in a new pull request once its turn has ended.", {
			code: "turn_running",
		});
	const session = meta.windlassSessionId;
	const saved = meta.backup;
	// A copy that is of another agent session, or is behind the last turn, would bring back the wrong memory.
	const current =
		session && saved && saved.windlassSessionId === session && (meta.memoryTurn ?? saved.turn) <= saved.turn;
	return {
		title: meta.title,
		...(meta.harness && { harness: meta.harness }),
		model: meta.model,
		effort: meta.effort ?? null,
		mode: meta.mode,
		place: meta.place,
		...(meta.size && { size: meta.size }),
		...(meta.hostedSize && { hostedSize: meta.hostedSize }),
		profile: meta.profile,
		repo: meta.repo,
		// An open pull request's branch is on GitHub; else the branch the platform last saw pushed.
		pushedBranch:
			meta.pull && (meta.pull.state === "open" || meta.pull.state === "draft")
				? meta.pull.branch
				: meta.pushedHead && meta.publishBranch
					? meta.publishBranch
					: null,
		pull: meta.pull?.number ?? null,
		tainted: meta.tainted === true,
		secretRequestBlocked: meta.secretRequestBlocked === true,
		copy: current
			? { windlassSessionId: session, backup: { size: saved.size, sha256: saved.sha256, at: saved.at } }
			: null,
		// Kept even with a copy: the copy may fail to come back in the new sandbox.
		handoff: meta.turns > 0 ? sessionHandoff(await taskTimeline(c, meta.turns), meta.turns) : null,
	};
}

/** What a session made by `continueSession` adds to its meta at creation. Nothing of the earlier session's publish, pull or checks. */
export function continuationMeta(continuation: Continuation): Partial<SessionMeta> {
	const { from, copy, handoff, machineCopy } = continuation;
	return {
		continuedFrom: {
			id: String(from.id),
			title: String(from.title),
			pull: typeof from.pull === "number" ? from.pull : null,
			base: String(from.base),
			stacked: from.stacked === true,
		},
		handoff:
			handoff && typeof handoff.text === "string" ? { text: handoff.text, untrusted: [...handoff.untrusted] } : null,
		...(copy && {
			windlassSessionId: copy.windlassSessionId,
			// The copy's turn counts no turn of this session.
			backup: { windlassSessionId: copy.windlassSessionId, ...copy.backup, turn: 0 },
			copiedSession: true,
		}),
		...(!copy &&
			machineCopy &&
			typeof machineCopy.from === "string" &&
			typeof machineCopy.windlassSessionId === "string" && {
				pendingCopy: {
					from: machineCopy.from,
					windlassSessionId: machineCopy.windlassSessionId,
					backup: machineCopy.backup,
				},
			}),
		...(continuation.tainted && { tainted: true }),
		...(continuation.secretRequestBlocked && { secretRequestBlocked: true }),
	};
}

/** The note a continuing session's agent is given with its first prompt; empty once told. */
export function continuationNote(meta: SessionMeta): string {
	const from = meta.continuedFrom;
	if (!from || from.told) return "";
	const title = from.title.length > TITLE_LIMIT ? `${from.title.slice(0, TITLE_LIMIT - 1)}…` : from.title;
	const pull =
		from.pull === null
			? "The earlier session opened no pull request."
			: `The earlier session's pull request is #${from.pull}.`;
	const base = from.stacked
		? `The workspace starts from the earlier session's branch ${from.base}${from.pull === null ? "" : ` (the branch of #${from.pull})`}, and this session's pull request will be based on it.`
		: `The workspace starts from the base branch ${from.base}, and none of the earlier session's unmerged work is in it.`;
	return `[A note from the platform, not from the user: this session continues the earlier session “${title}” in a new workspace, on a new branch, with its own pull request. ${pull} ${base} Look at what the workspace holds before you rely on earlier work.]\n\n`;
}
