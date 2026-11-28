// Sessions reserve time and kept places in one actor. Update the in-memory book synchronously, then persist and broadcast the change.

import { accountLimits } from "../../user-limits.js";
import { makeSandboxRoom } from "./kept-sandboxes.js";
import { type ItemsCtx, modelsToday, queueChanged } from "../user-items.js";
import {
	USAGE_HISTORY_DAYS,
	sessionTitle,
	isHostedSize,
	type HostedSize,
	type HostedSizeOption,
} from "../../contract.js";
import { UserError } from "rivetkit";
import type { RawAccess } from "rivetkit/db";
import { clientError, requireService, requireServiceFor, requireUser } from "../../auth.js";
import { config } from "../../config.js";
import type { CostRates, KeptSandbox, ModelProvider, SessionSummary, UsageNumbers, UsageView } from "../../contract.js";
import { modelPrices } from "../../model-prices.js";
import { getLayer } from "../../layer.js";
import type { ListedSandbox } from "../../sandbox/api.js";
import {
	tokensOn,
	type HoldReport,
	type UsageLimits,
	USAGE_KEPT_DAYS,
	UsageBook,
	type UsageChange,
	dayOf,
	isEmptyChange,
} from "../../usage.js";
import { BUILD_LOST_MS } from "../../environments.js";
import { customerDirectory } from "../../billing/customer-index.js";
import {
	CheckoutBlocked,
	CheckoutEmailRequired,
	applyBillingEvent,
	billingView,
	readBilling,
	setCapCents,
	reportOverage,
} from "../../billing/account.js";
import { billing } from "../../billing/config.js";
import { sessionWeight } from "../../billing/meter.js";
import { hostedSizesForPlan, planAllowsSize } from "../../billing/plans.js";
import type { BillingEvent } from "../../billing/provider.js";
import type { BillingPeriod, BillingView } from "../../contract.js";
import { type ReserveAnswer, type ReserveRequest, isSessionGone, sessionActor } from "../internal.js";
import { boundedText, type UserCtx } from "./state.js";

const KEPT_FRESH_MS = 30_000;

interface UsageCtx extends UserCtx {
	schedule: {
		list(): Promise<{ action: string; runAt: number }[]>;
		at(at: number, action: string): Promise<unknown>;
	};
	key: string[];
	log: { warn(entry: unknown): void };
	keepAwake?<T>(promise: Promise<T>): Promise<T>;
}

type UsageEntryRow = {
	started_at: number | null;
	day: number;
	session: string;
	hold: string;
	kind: string;
	seconds: number;
	weight: number | null;
	at: number;
	note: string | null;
};

type UsageHoldRow = {
	id: string;
	session: string;
	day: number;
	seconds: number;
	weight: number | null;
	started_at: number;
	expires_at: number;
};

/** A work item's reviewer shares its builder's place among the kept sandboxes (`UsageBook.sharing`): an item counts as one. */
export function itemSharing(sessions: ReadonlyMap<string, SessionSummary>): (session: string) => string | undefined {
	return session => {
		const item = sessions.get(session)?.item;
		if (item?.role !== "reviewer") return undefined;
		for (const other of sessions.values())
			if (other.item?.id === item.id && other.item.role !== "reviewer") return other.id;
		return undefined;
	};
}

export async function readUsage(
	db: RawAccess,
	limits: UsageLimits,
	sessions: ReadonlyMap<string, SessionSummary>,
): Promise<UsageBook> {
	const today = dayOf(Date.now());
	// A hold whose entry was written and whose own row was then not removed, because the server stopped in between, is closed.
	await db.execute("DELETE FROM usage_hold WHERE id IN (SELECT hold FROM usage_entry)");
	await db.execute("DELETE FROM usage_start WHERE day < ?", today - USAGE_KEPT_DAYS);
	await db.execute("DELETE FROM usage_entry WHERE day < ?", today - USAGE_KEPT_DAYS);
	await db.execute("DELETE FROM token_usage WHERE day < ?", today - USAGE_KEPT_DAYS);
	await db.execute("DELETE FROM model_key_usage WHERE day < ?", today - USAGE_KEPT_DAYS);
	// Reload the retained ledger, including both sides of a subscription renewal.
	const since = today - (limits.plan ? USAGE_KEPT_DAYS : USAGE_HISTORY_DAYS);
	const entries = await db.execute<UsageEntryRow>(
		"SELECT e.*, s.started_at FROM usage_entry e LEFT JOIN usage_start s USING (hold) WHERE e.day > ? ORDER BY e.id",
		since,
	);
	const holds = await db.execute<UsageHoldRow>(
		"SELECT id, session, day, seconds, weight, started_at, expires_at FROM usage_hold",
	);
	const kept = await db.execute<{ session: string; since: number }>("SELECT session, since FROM kept_sandbox");
	const book = new UsageBook(limits, {
		entries: entries.map(row => ({
			day: row.day,
			startedAt: row.started_at ?? undefined,
			session: row.session,
			hold: row.hold,
			kind: row.kind === "unreported" || row.kind === "corrected" ? row.kind : "used",
			seconds: row.seconds,
			weight: row.weight,
			at: row.at,
			note: row.note,
		})),
		holds: holds.map(row => ({
			id: row.id,
			session: row.session,
			day: row.day,
			seconds: row.seconds,
			weight: row.weight,
			startedAt: row.started_at,
			expiresAt: row.expires_at,
		})),
		kept,
	});
	book.sharing = itemSharing(sessions);
	book.weightOf = session => sessionWeight(sessions.get(session));
	const at = Date.now();
	book.noteModelTokens(at, await tokensOn(db, at));
	return book;
}

// Only fake sandboxes inject delayed, refused or lost reserve replies.
const reserveFault = ((): {
	fresh: number;
	renewal: number;
	delayMs: number;
	downMs: number;
	downUntil: number | null;
} | null => {
	const spec = process.env.WLP_FAKE_RESERVE_FAULT;
	if (!spec || config.sandbox !== "fake") return null;
	const fault = { fresh: 0, renewal: 0, delayMs: 0, downMs: 0, downUntil: null };
	for (const part of spec.split(",")) {
		const [kind, value] = part.trim().split(":");
		const n = Number(value);
		if (!Number.isSafeInteger(n) || n < 0)
			throw new Error(`WLP_FAKE_RESERVE_FAULT: "${part}" is not lose:<n>, lose-renewal:<n>, delay:<ms> or down:<ms>`);
		if (kind === "lose") fault.fresh = n;
		else if (kind === "lose-renewal") fault.renewal = n;
		else if (kind === "delay") fault.delayMs = n;
		else if (kind === "down") fault.downMs = n;
		else
			throw new Error(`WLP_FAKE_RESERVE_FAULT: "${part}" is not lose:<n>, lose-renewal:<n>, delay:<ms> or down:<ms>`);
	}
	return fault;
})();

/** Decide synchronously and enqueue the entire change in one transaction so a later release stays released on disk. */
async function changeUsage<T extends { change: UsageChange }>(c: UsageCtx, step: (book: UsageBook) => T): Promise<T> {
	// A plan's limits change with the clock (a grace period that ends): the book decides with them as they are now.
	Object.assign(c.vars.usage.limits, accountLimits(c.vars.items.limits).usage);
	const done = step(c.vars.usage);
	const { change } = done;
	if (isEmptyChange(change)) return done;
	if (change.kept.length || change.released.length || change.closed.length) c.vars.keptGeneration++;
	try {
		await c.db.transaction(
			async tx => {
				for (const entry of change.entries) {
					if (entry.startedAt !== undefined)
						await tx.execute(
							"INSERT OR IGNORE INTO usage_start (hold, day, started_at) VALUES (?, ?, ?)",
							entry.hold,
							entry.day,
							entry.startedAt,
						);
					await tx.execute(
						"INSERT OR IGNORE INTO usage_entry (day, session, hold, kind, seconds, weight, at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
						entry.day,
						entry.session,
						entry.hold,
						entry.kind,
						entry.seconds,
						entry.weight!,
						entry.at,
						entry.note,
					);
				}
				for (const id of change.closed) await tx.execute("DELETE FROM usage_hold WHERE id = ?", id);
				for (const hold of change.opened) {
					await tx.execute(
						"INSERT OR REPLACE INTO usage_hold (session, id, day, seconds, weight, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
						hold.session,
						hold.id,
						hold.day,
						hold.seconds,
						hold.weight!,
						hold.startedAt,
						hold.expiresAt,
					);
				}
				for (const session of change.released) await tx.execute("DELETE FROM kept_sandbox WHERE session = ?", session);
				for (const claim of change.kept)
					await tx.execute(
						"INSERT OR REPLACE INTO kept_sandbox (session, since) VALUES (?, ?)",
						claim.session,
						claim.since,
					);
			},
			{ name: "changeUsage" },
		);
	} catch (error) {
		const restored = await readUsage(c.db, c.vars.usage.limits, c.vars.sessions).catch(() => c.vars.usage);
		const now = Date.now();
		restored.noteModelTokens(now, c.vars.usage.modelTokens(now));
		c.vars.usage = restored;
		throw error;
	}
	for (const entry of change.entries) {
		console.log(
			`[wlp] usage.counted uid=${c.key[0]} session=${entry.session} hold=${entry.hold} kind=${entry.kind} seconds=${entry.seconds}${entry.note === null ? "" : `: ${entry.note}`}`,
		);
	}
	c.broadcast("usage", c.vars.usage.numbers(Date.now()));
	if (change.entries.length > 0) queueOverageReport(c);
	return done;
}

/**
 * Tells the payment provider of overage it has not been told of (billing/account.ts), one report at a time, after the
 * request that counted it has been answered. The actor also drains the durable outbox on wake and scheduled retry.
 */
export function queueOverageReport(c: UsageCtx): void {
	const settings = billing(c.key[0]!);
	const state = c.vars.items.limits.billing;
	if (!settings || !state?.customerId) return;
	const now = Date.now();
	const { includedSeconds } = accountLimits(c.vars.items.limits, now).usage;
	c.vars.overageReport = c.vars.overageReport
		.then(async () => {
			try {
				const sent = await reportOverage(c.db, settings.provider, {
					uid: c.key[0]!,
					state,
					now,
					usedSeconds: period => c.vars.usage.usedInPeriod(period),
					includedSeconds,
				});
				for (const report of sent) console.log(`[wlp] billing.usage_reported uid=${c.key[0]} event=${report.eventId}`);
			} catch {
				console.warn(`[wlp] billing.usage_report_failed uid=${c.key[0]}`);
				const scheduled = await c.schedule.list();
				if (!scheduled.some(job => job.action === "internalRetryOverage" && job.runAt > Date.now())) {
					await c.schedule.at(Date.now() + 15 * 60_000, "internalRetryOverage");
				}
			}
		})
		.catch(() => {
			console.warn(`[wlp] billing.retry_schedule_failed uid=${c.key[0]}`);
		});
	void c.keepAwake?.(c.vars.overageReport);
}

function sweepUsage(c: UsageCtx, now: number): Promise<{ change: UsageChange }> {
	return changeUsage(c, book => ({ change: book.sweep(now) }));
}

/** A list read before this release must not put the removed sandbox back in the book. */
function releaseKept(c: UsageCtx, session: string) {
	// A sandbox can be freed before the book has discovered it.
	if (!c.vars.usage.keeps(session)) c.vars.keptGeneration++;
	c.vars.listed = null;
	return changeUsage(c, book => ({ change: book.release(session) }));
}

function keepsWorkspace(session: SessionSummary | undefined): boolean {
	return session !== undefined && !session.environmentBuild;
}

/**
 * Holds the count of kept sandboxes against the provider's own list of the user's sandboxes (usage.ts,
 * `reconcile`): at most once in KEPT_FRESH_MS, unless `force`. Never throws: when the provider cannot
 * be asked, the count stays as it is.
 */
async function reconcileKept(c: UsageCtx, force = false): Promise<void> {
	if (!force && c.vars.listed !== null && Date.now() - c.vars.listed.at < KEPT_FRESH_MS) return;
	const generation = c.vars.keptGeneration;
	try {
		const { sandboxes } = await getLayer();
		const found = await sandboxes.list(c.key[0]!);
		const listed: ListedSandbox[] = [];
		for (const sandbox of found) {
			const session = c.vars.sessions.get(sandbox.sessionId);
			// A session keeps its own workspace, including one that used a snapshot.
			if (keepsWorkspace(session)) {
				listed.push(sandbox);
				continue;
			}
			const buildStartedAt = sandbox.buildStartedAt ?? session?.createdAt;
			if (buildStartedAt !== undefined) {
				if (Date.now() - buildStartedAt < BUILD_LOST_MS) continue;
			} else if (!sandbox.sessionId) continue;
			const why = buildStartedAt === undefined ? "its session no longer exists" : "its environment build expired";
			await sandboxes.destroy(sandbox.id).then(
				() =>
					console.warn(
						`[wlp] sandbox.orphan_removed uid=${c.key[0]} id=${sandbox.id} session=${sandbox.sessionId} state=${sandbox.state}: ${why}`,
					),
				(error: unknown) =>
					c.log.warn({
						msg: "an orphaned sandbox could not be removed",
						id: sandbox.id,
						session: sandbox.sessionId,
						error: String(error),
					}),
			);
		}
		if (generation !== c.vars.keptGeneration) return reconcileKept(c, force);
		const now = Date.now();
		c.vars.listed = { at: now, sandboxes: listed };
		const done = await changeUsage(c, book =>
			book.reconcile(
				now,
				listed.map(sandbox => sandbox.sessionId),
				id => keepsWorkspace(c.vars.sessions.get(id)),
			),
		);
		if (done.added.length > 0 || done.dropped.length > 0) {
			console.warn(
				`[wlp] usage.kept_corrected uid=${c.key[0]}: counted ${done.added.length} sandbox(es) nobody had claimed (${done.added.join(",") || "none"}) and dropped ${done.dropped.length} place(s) with no sandbox behind them (${done.dropped.join(",") || "none"}); ${c.vars.usage.kept().length} kept now`,
			);
		}
	} catch (error) {
		c.log.warn({ msg: "could not hold the count of kept sandboxes against the provider's list", error: String(error) });
	}
}

function billingOn(uid?: string) {
	const settings = billing();
	if (!settings) throw new UserError("This deployment has no plans or billing.", { code: "billing_off" });
	if (uid !== undefined && settings.exemptUsers.has(uid))
		throw new UserError("Billing doesn't apply to this account.", { code: "billing_off" });
	return settings;
}

function billingOrigin(raw: unknown): string {
	const origin = typeof raw === "string" ? raw.replace(/\/+$/, "") : "";
	if (!config.origins.includes(origin))
		throw new UserError("Billing can only be opened from the web app's own address.", { code: "origin_not_allowed" });
	return origin;
}

async function billingAnswer(c: UsageCtx): Promise<BillingView> {
	const state = c.vars.items.limits.billing;
	if (billing()?.exemptUsers.has(c.key[0]!)) return { enabled: false, exempt: true };
	if (!state) return { enabled: false };
	const now = Date.now();
	Object.assign(c.vars.usage.limits, accountLimits(c.vars.items.limits).usage);
	return billingView(c.db, state, c.vars.usage.numbers(now).hosted ?? null, now);
}

function billingChanged(c: UsageCtx & Parameters<typeof queueChanged>[0]): void {
	Object.assign(c.vars.usage.limits, accountLimits(c.vars.items.limits).usage);
	c.broadcast("usage", c.vars.usage.numbers(Date.now()));
	queueChanged(c);
	queueOverageReport(c);
}

async function usageView(c: UsageCtx): Promise<UsageView> {
	const layer = await getLayer();
	await reconcileKept(c);
	const now = Date.now();
	await sweepUsage(c, now);
	const book = c.vars.usage;
	const listed = new Map<string, ListedSandbox>();
	// A session with more than one sandbox at the provider is shown as running when any of them is.
	for (const sandbox of c.vars.listed?.sandboxes ?? [])
		if (sandbox.state === "running" || !listed.has(sandbox.sessionId)) listed.set(sandbox.sessionId, sandbox);
	const kept: KeptSandbox[] = book
		.kept()
		.map(claim => {
			const session = c.vars.sessions.get(claim.session);
			return {
				sessionId: claim.session,
				title: session ? sessionTitle(session) : null,
				...(session?.item && { item: { id: session.item.id, role: session.item.role ?? "builder" } }),
				...(book.shares(claim.session) && { sharesPlace: true as const }),
				state:
					listed.get(claim.session)?.state ??
					(session && session.sandbox !== "none" ? session.sandbox : ("starting" as const)),
				usedAt: session?.updatedAt ?? null,
				busy: session !== undefined && session.status !== "idle",
				repository: session?.repository ? `${session.repository.owner}/${session.repository.name}` : null,
				pushed: Boolean(session?.pullRequest),
				...(session?.hostedSize && { hostedSize: session.hostedSize }),
			};
		})
		.sort((a, b) => (b.usedAt ?? 0) - (a.usedAt ?? 0) || (a.sessionId < b.sessionId ? -1 : 1));
	return {
		...book.numbers(now),
		usedModelTokens: book.modelTokens(now),
		modelsToday: await modelsToday(c.db, now),
		providerTokens: await c.db.execute<{ provider: ModelProvider; tokens: number }>(
			"SELECT provider, SUM(tokens) AS tokens FROM model_key_usage WHERE day=? GROUP BY provider ORDER BY provider",
			dayOf(now),
		),
		factoryLimits: accountLimits(c.vars.items.limits).factory,
		today: book.today(now).map(row => {
			const session = c.vars.sessions.get(row.sessionId);
			return {
				...row,
				title: session ? sessionTitle(session) : null,
				...(session?.hostedSize && { hostedSize: session.hostedSize }),
			};
		}),
		days: book.days(now),
		kept,
		price: layer.sandboxes.price(),
		...(() => {
			const sizes = sizesOf(c, layer);
			return sizes.length > 1 ? { hostedSizes: sizes } : {};
		})(),
		memory: layer.sandboxes.sessionsLiveInSandbox ? (layer.backups ? "copied" : "lost") : "kept",
	};
}

export function sizesOf(c: UserCtx, layer: Awaited<ReturnType<typeof getLayer>>): HostedSizeOption[] {
	return hostedSizesForPlan(layer.sandboxes.sizes?.() ?? [], accountLimits(c.vars.items.limits).plan);
}

/** A replacement sandbox can be smaller than the sandbox the account kept through a downgrade. */
function clampedSandboxSize(c: UserCtx, size: HostedSize | undefined): HostedSize | undefined {
	const plan = accountLimits(c.vars.items.limits).plan;
	if (!plan || !size || planAllowsSize(plan, size)) return undefined;
	return plan.sizes.at(-1);
}

type UsageActionCtx = UsageCtx & ItemsCtx;

export const usageActions = {
	allowance: async (c: UsageActionCtx): Promise<UsageNumbers> => {
		requireUser(c);
		try {
			const now = Date.now();
			await sweepUsage(c, now);
			return c.vars.usage.numbers(now);
		} catch (error) {
			throw clientError(c.log, error, "Your sandbox time could not be read. Try again.");
		}
	},
	billing: async (c: UsageActionCtx): Promise<BillingView> => {
		requireUser(c);
		return billingAnswer(c);
	},
	billingCheckout: async (
		c: UsageActionCtx,
		input: { period: BillingPeriod; origin: string },
	): Promise<{ url: string }> => {
		const profile = requireUser(c);
		const settings = billingOn(c.key[0]!);
		if (input?.period !== "month" && input?.period !== "year")
			throw new UserError("Choose monthly or yearly.", { code: "bad_input" });
		const origin = billingOrigin(input?.origin);
		if (profile.demo) throw new UserError("The demo account cannot subscribe.", { code: "billing_off" });
		try {
			const checkout = await c.vars.checkout.open(
				c.db,
				settings.provider,
				{
					uid: profile.uid,
					email: profile.email,
					period: input.period,
					returnUrl: `${origin}/settings?billing=checkout#plan`,
					claimCustomer: async id => (await customerDirectory(c.client()).claim(id, profile.uid)) === profile.uid,
				},
				Date.now(),
			);
			c.vars.items.limits.billing = await readBilling(c.db);
			return checkout;
		} catch (error) {
			if (error instanceof CheckoutEmailRequired) throw new UserError(error.message, { code: "bad_input" });
			if (error instanceof CheckoutBlocked) throw new UserError(error.message, { code: "already_subscribed" });
			console.warn(`[wlp] billing.checkout_failed uid=${c.key[0]}`);
			throw new UserError("The checkout could not be opened. Try again in a moment.", { code: "billing_unavailable" });
		}
	},
	billingPortal: async (c: UsageActionCtx, input: { origin: string }): Promise<{ url: string }> => {
		requireUser(c);
		const settings = billingOn(c.key[0]!);
		const origin = billingOrigin(input?.origin);
		const { customerId } = await readBilling(c.db);
		if (customerId === null) throw new UserError("There is no subscription to manage yet.", { code: "no_customer" });
		try {
			return await settings.provider.portalLink({ customerId, returnUrl: `${origin}/settings#plan` });
		} catch {
			console.warn(`[wlp] billing.portal_failed uid=${c.key[0]} customer=${customerId}`);
			throw new UserError("The billing portal could not be opened. Try again in a moment.", {
				code: "billing_unavailable",
			});
		}
	},
	setOverageCap: async (c: UsageActionCtx, input: { cents: number }): Promise<BillingView> => {
		requireUser(c);
		billingOn(c.key[0]!);
		try {
			c.vars.items.limits.billing = await setCapCents(c.db, input?.cents);
		} catch (error) {
			if (error instanceof RangeError) throw new UserError(error.message, { code: "bad_input" });
			throw error;
		}
		console.log(`[wlp] billing.cap uid=${c.key[0]}`);
		billingChanged(c);
		return billingAnswer(c);
	},
	internalRetryOverage: async (c: UsageActionCtx): Promise<void> => {
		if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
		queueOverageReport(c);
		await c.vars.overageReport;
	},
	internalBillingEvent: async (c: UsageActionCtx, event: BillingEvent): Promise<string> => {
		requireServiceFor(c, "billing");
		const settings = billingOn();
		const done = await applyBillingEvent(
			c.db,
			event,
			Date.now(),
			settings.graceMs,
			async id => (await customerDirectory(c.client()).claim(id, c.key[0]!)) === c.key[0],
		);
		if (done.outcome === "applied" && !settings.exemptUsers.has(c.key[0]!)) {
			c.vars.items.limits.billing = done.state;
			billingChanged(c);
		}
		return done.outcome;
	},
	usage: async (c: UsageActionCtx): Promise<UsageView> => {
		requireUser(c);
		try {
			return await usageView(c);
		} catch (error) {
			throw clientError(c.log, error, "Your usage could not be read. Try again.");
		}
	},
	costRates: async (c: UsageActionCtx): Promise<CostRates> => {
		requireUser(c);
		const [{ models, source }, layer] = await Promise.all([modelPrices(), getLayer()]);
		// Every size, not just the plan's: an item may have run at one the plan no longer offers.
		const sizes = layer.sandboxes.sizes?.();
		return {
			models,
			source,
			sandbox: sizes ? Object.fromEntries(sizes.map(size => [size.id, size.usdPerHour])) : null,
		};
	},
	freeSandbox: async (c: UsageActionCtx, sessionId: string): Promise<UsageView> => {
		const profile = requireUser(c);
		const id = boundedText(sessionId, 200);
		if (id === "") throw new UserError("Say which agent's sandbox to free.", { code: "bad_input" });
		try {
			let gone = !c.vars.sessions.has(id);
			if (!gone) {
				await sessionActor(c, profile.uid, id)
					.internalFreeSandbox()
					.catch((error: unknown) => {
						if (isSessionGone(error)) {
							gone = true;
							return;
						}
						const { group, code, message } = (typeof error === "object" && error !== null ? error : {}) as {
							group?: unknown;
							code?: unknown;
							message?: unknown;
						};
						if (group === "user" && typeof message === "string")
							throw new UserError(message, { code: typeof code === "string" ? code : "sandbox_busy" });
						throw error;
					});
			}
			// Only sweep provider resources here after the session is gone. Live sessions own their exclusion.
			if (gone) {
				const { sandboxes } = await getLayer();
				for (const left of await sandboxes.list(profile.uid)) {
					if (left.sessionId !== id) continue;
					await sandboxes.destroy(left.id);
					console.log(
						`[wlp] sandbox.freed id=${left.id} uid=${profile.uid} session=${id}: it was left at the provider without its agent`,
					);
				}
				await releaseKept(c, id);
			}
			c.vars.keptGeneration++;
			c.vars.listed = null;
			return await usageView(c);
		} catch (error) {
			throw clientError(c.log, error, "The sandbox could not be freed. Try again.");
		}
	},
	internalReserve: async (c: UsageActionCtx, input: ReserveRequest): Promise<ReserveAnswer> => {
		requireService(c);
		const id = boundedText(input?.id, 64);
		const session = boundedText(input?.sessionId, 200);
		if (id === "" || session === "") throw new UserError("A hold needs an id and a session.", { code: "bad_input" });
		const settle =
			typeof input.settle?.hold === "string" && typeof input.settle.seconds === "number"
				? { hold: input.settle.hold, seconds: input.settle.seconds, observedUntil: input.settle.observedUntil }
				: undefined;
		const renewal = input.fresh !== true && settle !== undefined;
		if (reserveFault) {
			if (input.fresh && reserveFault.delayMs) await new Promise(done => setTimeout(done, reserveFault.delayMs));
			if (renewal && reserveFault.downMs > 0 && reserveFault.downUntil === null)
				reserveFault.downUntil = Date.now() + reserveFault.downMs;
			if (reserveFault.downUntil !== null && Date.now() < reserveFault.downUntil) {
				console.log(
					`[wlp] usage.fault_down uid=${c.key[0]} session=${session} hold=${id}: refused (WLP_FAKE_RESERVE_FAULT)`,
				);
				throw new Error("the user's actor is away (WLP_FAKE_RESERVE_FAULT)");
			}
		}
		if (input.keep === true) await reconcileKept(c, c.vars.usage.atCap(session));

		const now = Date.now();
		// Recheck the session after the provider listing, in case it was deleted meanwhile.
		const summary = c.vars.sessions.get(session);
		if (!summary) return { ok: false, reason: "gone", numbers: c.vars.usage.numbers(now) };
		const keep = input.keep === true && keepsWorkspace(summary);
		const size = isHostedSize(input.hostedSize) ? input.hostedSize : summary.hostedSize;
		const clampedSize = input.keep === true ? clampedSandboxSize(c, size) : undefined;
		const weight = size ? sessionWeight({ hostedSize: clampedSize ?? size }) : undefined;
		const reserve = () =>
			changeUsage(c, book =>
				book.reserve(Date.now(), { id, session, keep, weight, fresh: input.fresh === true, settle }),
			);
		let done = await reserve();
		if (!done.ok && done.reason === "sandboxes" && (await makeSandboxRoom(c, summary)) && c.vars.sessions.has(session))
			done = await reserve();
		const numbers = c.vars.usage.numbers(now);
		const lose = reserveFault === null ? null : input.fresh === true ? "fresh" : renewal ? "renewal" : null;
		if (reserveFault && lose && reserveFault[lose] > 0) {
			reserveFault[lose] -= 1;
			console.log(
				`[wlp] usage.fault_lost uid=${c.key[0]} session=${session} hold=${id} ${lose}: done, and its reply lost (WLP_FAKE_RESERVE_FAULT)`,
			);
			throw new Error("reply lost (WLP_FAKE_RESERVE_FAULT)");
		}
		if (!done.ok) {
			console.log(
				`[wlp] usage.refused uid=${c.key[0]} session=${session} limit=${done.reason} used=${numbers.usedSeconds} held=${numbers.heldSeconds} allowance=${numbers.allowanceSeconds ?? "none"} kept=${numbers.sandboxes.kept} of ${numbers.sandboxes.limit ?? "any"}`,
			);
			return { ok: false, reason: done.reason, numbers };
		}
		return {
			ok: true,
			...(clampedSize && { clampedSize }),
			hold: { id: done.hold.id, seconds: done.hold.seconds },
			numbers,
		};
	},
	internalClaimPlace: async (
		c: UsageActionCtx,
		sessionId: string,
		hostedSize?: HostedSize,
	): Promise<{ ok: boolean; clampedSize?: HostedSize; numbers: UsageNumbers } | { ok: false; reason: "gone" }> => {
		requireService(c);
		const session = boundedText(sessionId, 200);
		if (c.vars.sessions.get(session)?.environmentBuild)
			return { ok: true, clampedSize: clampedSandboxSize(c, hostedSize), numbers: c.vars.usage.numbers(Date.now()) };
		await reconcileKept(c, c.vars.usage.atCap(session));
		const asking = c.vars.sessions.get(session);
		if (asking && c.vars.usage.atCap(session)) await makeSandboxRoom(c, asking);
		// From the check to the claim nothing is awaited: a session being deleted is given nothing new.
		if (!c.vars.sessions.has(session)) return { ok: false, reason: "gone" };
		const now = Date.now();
		const done = await changeUsage(c, book => book.claim(now, session));
		const numbers = c.vars.usage.numbers(now);
		if (!done.ok)
			console.log(
				`[wlp] usage.refused uid=${c.key[0]} session=${session} limit=sandboxes kept=${numbers.sandboxes.kept} of ${numbers.sandboxes.limit ?? "any"}: at the making of its sandbox`,
			);
		const clampedSize = clampedSandboxSize(c, hostedSize);
		return { ok: done.ok, ...(clampedSize && { clampedSize }), numbers };
	},
	internalSettle: async (c: UsageActionCtx, input: HoldReport & { sessionId: string }): Promise<{ known: boolean }> => {
		requireService(c);
		const session = boundedText(input?.sessionId, 200);
		const hold = boundedText(input?.hold, 64);
		const done = await changeUsage(c, book =>
			book.settle(Date.now(), {
				session,
				hold,
				observedUntil: input?.observedUntil,
				seconds: typeof input?.seconds === "number" ? input.seconds : Number.NaN,
			}),
		);
		return { known: done.known };
	},
	internalSweepSandboxes: async (c: UsageActionCtx): Promise<void> => {
		requireService(c);
		await reconcileKept(c, true);
	},
	internalRelease: async (c: UsageActionCtx, sessionId: string): Promise<void> => {
		requireService(c);
		await releaseKept(c, boundedText(sessionId, 200));
	},
};
