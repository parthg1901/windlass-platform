// Errors and small helpers shared by the agent-session modules.
import type { StoredConnection } from "../../github/repos.js";
import { userActor } from "../internal.js";
import type { InboxRow } from "../session-inbox.js";
import type { SessionMeta, Ctx } from "./state.js";

/** A failure of a turn whose message is fit to show as it is. */
export class TurnProblem extends Error {}

/**
 * An item's turn Pay with holds back for its plan (user-payer.ts): the item waits for `retryAt` (its plan's reset),
 * as after a usage-limit refusal. A person's prompt is answered with `PLAN_LIMITED` instead.
 */
export class PlanWaitError extends Error {
	constructor(
		message: string,
		readonly retryAt: number | null,
		readonly plan?: import("../../contract.js").PlanProvider,
	) {
		super(message);
	}
}

/** A confirmed checkout or policy failure. Transport and provider failures use the interruption budget. */
export class ReviewRefused extends TurnProblem {}

/** The code host would not give the sandbox a scoped Git credential (`GitCredentialRefused`): the owner has to act. */
export class GitAccessRefused extends TurnProblem {}

export function tail(text: string, lines = 6, chars = 800): string {
	const kept = text
		.split("\n")
		.map(line => line.trimEnd())
		.filter(line => line !== "")
		.slice(-lines)
		.join("\n");
	return kept.length > chars ? kept.slice(-chars) : kept;
}

/** What every connect to the session's sandbox is told: the hosts its repository's network list allows, for a hosted one. */
export function connectOptions(meta: SessionMeta): { network?: string[] } {
	return meta.place.kind === "hosted" && meta.networkHosts && meta.networkHosts.length > 0
		? { network: meta.networkHosts }
		: {};
}

// Acquire before awaiting. Idle cleanup cannot run while a reader, publisher or turn owns the sandbox.
export function takeSandbox(c: Ctx): () => void {
	c.vars.sandboxOps += 1;
	let held = true;
	return () => {
		if (!held) return;
		held = false;
		c.vars.sandboxOps -= 1;
	};
}

/** Whether an operation has the session's sandbox now (`takeSandbox`). */
export function busy(c: Ctx): boolean {
	return c.vars.sandboxOps > 0;
}

/** The session's sandbox was created, connected to, suspended or destroyed: a state read asked before then is out of date. */
export function sandboxChanged(c: Ctx): void {
	c.vars.sandboxGen += 1;
}

/** The user's GitHub connection as their actor has it now: asked each time, so a connection that was removed stops working at once. */
export function githubConnection(c: Ctx, meta: SessionMeta): Promise<StoredConnection | null> {
	return meta.repo?.provider === "gitlab" ? Promise.resolve(null) : userActor(c, meta.uid).internalGithubConnection();
}

export function itemPrompt(row: InboxRow): string {
	return row.checkout && !row.text
		? `Review pull request #${row.checkout.pr} at ${row.checkout.head.slice(0, 7)} against the task and its acceptance criteria.`
		: row.text;
}

/** Waits for `promise`, but no longer than `ms`. Never rejects. */
export async function within(promise: Promise<unknown> | null, ms: number): Promise<void> {
	if (!promise) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		promise.catch(() => undefined),
		new Promise<void>(resolve => {
			timer = setTimeout(resolve, ms);
		}),
	]);
	clearTimeout(timer);
}
