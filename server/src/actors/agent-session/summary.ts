import { describeError } from "../../auth.js";
import type { SessionSummary } from "../../contract.js";
import type { StoredRepository } from "../../github/publish.js";
import { userActor } from "../internal.js";
import { sessionCapabilities } from "../../sandbox/harnesses.js";
import type { SessionMeta, Ctx } from "./state.js";

export function summaryOf(meta: SessionMeta): SessionSummary {
	return {
		id: meta.sessionId,
		...(meta.harness ? { harness: meta.harness } : {}),
		capabilities: sessionCapabilities(meta.harness),
		...(meta.harnessModels !== undefined ? { harnessModels: meta.harnessModels } : {}),
		title: meta.title,
		place: meta.place,
		profile: meta.profile,
		...(meta.hostedSize && { hostedSize: meta.hostedSize }),
		model: meta.model,
		effort: meta.effort ?? null,
		mode: meta.mode,
		availableModes: meta.availableModes,
		repoUrl: meta.repoUrl,
		...(meta.repo
			? {
					repository: repositoryOf(meta.repo),
					pullRequest: meta.pull ?? null,
					publishUnasked: meta.publishUnasked === true,
				}
			: {}),
		createdAt: meta.createdAt,
		updatedAt: meta.updatedAt,
		...(meta.turnStartedAt != null && { turnStartedAt: meta.turnStartedAt }),
		status: meta.status,
		...(meta.status === "paused" && meta.run?.paused
			? { paused: { reason: meta.run.paused.reason, since: meta.run.paused.at, held: meta.run.held?.length ?? 0 } }
			: {}),
		turns: meta.turns,
		lastOutcome: meta.lastOutcome,
		...(meta.spent?.models.length ? { spent: { models: meta.spent.models, sandbox: [] } } : {}),
		...(meta.startTimes?.length ? { startTimes: meta.startTimes } : {}),
		sandbox: meta.sandbox,
		...(meta.servers && meta.servers.length > 0
			? { servers: { count: meta.servers.length, changedAt: meta.serversChangedAt } }
			: {}),
		...(meta.origin
			? {
					item: {
						id: meta.origin.itemId,
						role: meta.origin.role ?? "builder",
						subtaskScreenshots: meta.origin.subtaskScreenshots,
						...(meta.origin.planCritic && { planCritic: true }),
					},
				}
			: {}),
		...(meta.readiness && { readiness: true as const }),
		...(meta.environmentBuild ? { environmentBuild: true as const } : {}),
		...(meta.environment ? { environment: meta.environment } : {}),
		...(meta.continuedFrom && { continuedFrom: { id: meta.continuedFrom.id, title: meta.continuedFrom.title } }),
	};
}

/** Sends summaries to the `user` actor until the newest one has been sent. */
async function reportLoop(c: Ctx): Promise<void> {
	// Yields first, so that `report` has stored this promise before the loop can possibly end.
	await Promise.resolve();
	try {
		while (c.vars.reportAgain && c.vars.meta) {
			c.vars.reportAgain = false;
			try {
				await userActor(c, c.vars.meta.uid).internalSessionChanged(summaryOf(c.vars.meta));
			} catch (error) {
				c.log.warn({ msg: "could not report the session's summary to its user", error: describeError(error) });
			}
		}
	} finally {
		// In the same step as the loop's last check: a `report` that comes later starts a new loop.
		c.vars.reporting = null;
	}
}

/** Sends the newest summary to the `user` actor; calls that arrive meanwhile collapse into one more. */
export function report(c: Ctx): Promise<void> {
	c.vars.reportAgain = true;
	if (c.vars.reporting) return c.vars.reporting;
	const loop = reportLoop(c);
	c.vars.reporting = loop;
	// Shutdown awaits the report itself because it cannot acquire another keep-awake guard.
	if (!c.vars.stopping) void c.keepAwake(loop);
	return loop;
}

/** Tells connected clients and the `user` actor that the summary changed. */
export function publish(c: Ctx): void {
	const meta = c.vars.meta;
	if (!meta) return;
	c.broadcast("summary", summaryOf(meta));
	void report(c);
}

export function repositoryOf(repo: StoredRepository): NonNullable<SessionSummary["repository"]> {
	return {
		provider: repo.provider,
		id: repo.id,
		owner: repo.owner,
		name: repo.name,
		branch: repo.branch,
		private: repo.private,
		url: repo.url,
	};
}
