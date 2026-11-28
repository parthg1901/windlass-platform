import type { RawAccess } from "rivetkit/db";
import {
	isModelProvider,
	isPlanProvider,
	MACHINE_HARNESS_IDS,
	type HarnessId,
	type ModelPlanStatus,
	type ModelProvider,
	type PlanProvider,
	type ProviderAccount,
} from "../contract.js";
import { observationReading } from "../credentials/plan-health.js";
import { observePlan, planStatuses } from "../credentials/plans.js";
import { machineHarness, planProviders } from "../sandbox/harnesses.js";
import { accountState, observeUsage, type StoredUsage, type UsageObservation } from "../provider-usage.js";

export const PROVIDER_TABLE = `CREATE TABLE IF NOT EXISTS provider_usage (
	place TEXT NOT NULL, harness TEXT NOT NULL, generation TEXT NOT NULL, data TEXT NOT NULL,
	PRIMARY KEY(place,harness))`;

type Db = Pick<RawAccess, "execute">;
/**
 * Whose usage limit a turn counts against: a sign-in at a place, a Settings key (`provider`), or with `plan` the
 * user's connected plan of `provider`, which has its own limits apart from the key's (credentials/plan-health.ts).
 */
export interface AccountLocation {
	place: string;
	harness: HarnessId;
	provider?: ModelProvider;
	plan?: true;
}

/**
 * Where a location's limits are kept. Windlass's own account, where no key pays, is its plan's: its ChatGPT sign-in is
 * the ChatGPT plan, so its limits are the plan's wherever it runs (hosted, or on a machine handed the plan's token).
 */
export function accountLocation(location: AccountLocation): AccountLocation {
	if (location.provider || machineHarness(location.harness)) return location;
	const [provider] = planProviders(location.harness);
	return provider ? { ...location, provider, plan: true } : location;
}

function accountPlace(location: AccountLocation) {
	const { provider, place, plan } = accountLocation(location);
	if (provider && plan) return "plan/" + provider;
	return provider ? "settings/" + provider : place;
}

export function accountKey(location: AccountLocation, generation: string) {
	const located = accountLocation(location);
	return [accountPlace(located), ...(located.provider ? [] : [located.harness]), generation].join("/");
}

/** The agents a plan pays for (their harness records' `planProviders`, Windlass's too). */
function planHarnesses(provider: PlanProvider): HarnessId[] {
	return [...MACHINE_HARNESS_IDS, "windlass" as const].filter(id => planProviders(id).includes(provider));
}

/** The agent a plan's limits are told against: the plan agent it pays for. */
function planHarness(provider: PlanProvider): HarnessId {
	return planHarnesses(provider)[0] ?? "windlass";
}

/** A plan's health as an account the turn queue waits on, keyed apart from the key of the same provider. */
function planAccount(plan: ModelPlanStatus & { generation: string }): ProviderAccount {
	const warning = plan.windows.some(w => (w.usedPct ?? 0) >= 90 && (w.resetsAt === null || w.resetsAt > Date.now()));
	return {
		key: accountKey(
			{ place: "hosted", harness: planHarness(plan.provider), provider: plan.provider, plan: true },
			plan.generation,
		),
		provider: plan.provider,
		harness: planHarness(plan.provider),
		state: plan.health === "limited" ? "limited" : warning ? "warning" : "ok",
		limitedUntil: plan.health === "limited" ? plan.limitedUntil : null,
		windows: plan.windows,
	};
}

export async function loginGeneration(db: Db, location: AccountLocation): Promise<string | null> {
	const { place, harness, provider, plan } = accountLocation(location);
	if (provider && plan) {
		const [row] = await db.execute<{ generation: string }>(
			"SELECT generation FROM model_plan WHERE provider=?",
			provider,
		);
		return row?.generation ?? null;
	}
	if (provider) {
		const [row] = await db.execute<{ generation: string }>(
			"SELECT generation FROM model_provider WHERE provider=?",
			provider,
		);
		return row?.generation ?? null;
	}
	if (place === "hosted") return null;
	const [machine] = await db.execute<{ harnesses: string | null }>(
		"SELECT json_extract(facts, '$.report.harnesses') AS harnesses FROM machines WHERE id=? AND expires IS NULL",
		place,
	);
	if (!machine) return null;
	const entries: import("../contract.js").MachineSummary["harnesses"] = JSON.parse(machine.harnesses ?? "[]");
	const entry = entries?.find(h => h.id === harness);
	return entry && entry.signIn !== "none" ? (entry.loginGeneration ?? "legacy") : null;
}

export async function recordProviderUsage(
	db: RawAccess,
	told: AccountLocation,
	generation: string,
	observation: UsageObservation,
) {
	const location = accountLocation(told);
	// A plan keeps its limits on its own row (credentials/plans.ts), where Pay with reads them.
	if (location.plan && location.provider && isPlanProvider(location.provider))
		return (await observePlan(db, location.provider, generation, observationReading(observation))) !== null;
	return db.transaction(
		async tx => {
			if ((await loginGeneration(tx, location)) !== generation) return false;
			const { harness } = location;
			const place = location.provider ? "settings" : accountPlace(location);
			const connection = location.provider ?? harness;
			const [row] = await tx.execute<{ data: string }>(
				"SELECT data FROM provider_usage WHERE place=? AND harness=? AND generation=?",
				place,
				connection,
				generation,
			);
			if (!row && observation.kind === "success") return false;
			const previous: StoredUsage = row
				? JSON.parse(row.data)
				: {
						backoff: 0,
						lastRefusal: -1,
						lastSuccess: -1,
						account: {
							key: accountKey(location, generation),
							provider: location.provider,
							harness,
							state: "ok",
							limitedUntil: null,
							windows: [],
						},
					};
			const updated = observeUsage(previous, observation);
			if (updated === previous) return false;
			await tx.execute(
				"INSERT OR REPLACE INTO provider_usage VALUES (?,?,?,?)",
				place,
				connection,
				generation,
				JSON.stringify(updated),
			);
			return true;
		},
		{ name: "provider.observe" },
	);
}

export async function providerAccounts(db: Db, now: number) {
	const byPlace = new Map<string, ProviderAccount[]>();
	const generations = await db.execute<{ provider: PlanProvider; generation: string }>(
		"SELECT provider, generation FROM model_plan WHERE check_ok = 1",
	);
	for (const plan of await planStatuses(db)) {
		const generation = generations.find(row => row.provider === plan.provider)?.generation;
		if (plan.ok && generation) byPlace.set("plan/" + plan.provider, [planAccount({ ...plan, generation })]);
	}
	const rows = await db.execute<{
		place: string;
		harness: HarnessId | ModelProvider;
		generation: string;
		data: string;
	}>("SELECT * FROM provider_usage");
	for (const row of rows) {
		const stored: StoredUsage = JSON.parse(row.data);
		const { account } = stored;
		const location = {
			place: row.place,
			harness: account.harness,
			provider: isModelProvider(row.harness) ? row.harness : undefined,
		};
		if ((await loginGeneration(db, location)) !== row.generation) continue;
		const place = accountPlace(location);
		account.state = accountState(stored, now);
		if (account.state !== "limited") account.limitedUntil = null;
		const list = byPlace.get(place) ?? [];
		list.push(account);
		byPlace.set(place, list);
	}
	return byPlace;
}

export function accountFor(accounts: Map<string, ProviderAccount[]>, location: AccountLocation) {
	const list = accounts.get(accountPlace(location));
	const account = accountLocation(location).provider ? list?.[0] : list?.find(a => a.harness === location.harness);
	return account && { ...account, harness: location.harness };
}

export function accountsAt(
	accounts: Map<string, ProviderAccount[]>,
	place: string,
	keys: readonly ModelProvider[] = [],
) {
	return [
		// The ChatGPT plan's limits hold Windlass's ChatGPT models on every machine.
		...windlassPlanAccounts(accounts),
		...(accounts.get(place) ?? []),
		...keys.flatMap(p => accounts.get("settings/" + p) ?? []),
	];
}

/** The plan accounts that hold Windlass (its own account is its plan's), as Windlass's. */
function windlassPlanAccounts(accounts: Map<string, ProviderAccount[]>): ProviderAccount[] {
	return planProviders("windlass").flatMap(provider =>
		(accounts.get("plan/" + provider) ?? []).map(account => ({ ...account, harness: "windlass" as const })),
	);
}

/** Every limited account, a plan's once for each agent it pays for (placement.ts `limitApplies`). */
export function limitedAccounts(accounts: Map<string, ProviderAccount[]>) {
	return [...accounts].flatMap(([machineId, list]) =>
		list.flatMap(a => {
			if (a.state !== "limited" || a.limitedUntil === null) return [];
			const harnesses = a.provider && machineId.startsWith("plan/") ? planHarnesses(a.provider as PlanProvider) : [];
			return (harnesses.length ? harnesses : [a.harness]).map(harness => ({
				machineId,
				harness,
				limitedUntil: a.limitedUntil!,
				accountKey: a.key,
			}));
		}),
	);
}

/**
 * Moves what the user actor kept of Windlass's ChatGPT sign-in's limits (`provider_usage` rows of `windlass`, place
 * `*`) onto the ChatGPT plan, where they are kept now: a limit still running at the plan's generation holds the plan
 * until its end, unless the plan is held longer already. The rows are removed. One-time: remove after the first deploy that runs it.
 */
export async function moveWindlassLimits(db: RawAccess, now = Date.now()): Promise<void> {
	const rows = await db.execute<{ generation: string; data: string }>(
		"SELECT generation, data FROM provider_usage WHERE harness='windlass'",
	);
	if (!rows.length) return;
	const [plan] = await db.execute<{ generation: string }>("SELECT generation FROM model_plan WHERE provider='openai'");
	const until = Math.max(
		0,
		...rows
			.filter(row => row.generation === plan?.generation)
			.map(row => (JSON.parse(row.data) as StoredUsage).account.limitedUntil ?? 0),
	);
	const held = (await planStatuses(db)).find(status => status.provider === "openai");
	if (plan && until > now && (held?.health !== "limited" || (held.limitedUntil ?? 0) < until))
		await observePlan(db, "openai", plan.generation, { at: now, status: "limited", windows: [], resetsAt: until });
	await db.execute("DELETE FROM provider_usage WHERE harness='windlass'");
}
