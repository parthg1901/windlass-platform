import type { ItemView, RepositoryAutonomy } from "../contract.js";
import { isTestPath } from "../verified.js";

export const BARS = { singles: 5, features: 3, kind: 5, failures: 3, fixRate: 0.25 } as const;
export const kinds = ["docs-only", "tests-only", "dependency bumps", "other"] as const;
export type TaskKind = (typeof kinds)[number];
export type Offer = "Small plans" | TaskKind;
export type ReadinessLevel = "Not ready" | "Ask first" | "Small plans" | "Full plans" | "Earned merge";

export function taskKind(paths: string[]): TaskKind {
	if (paths.length && paths.every(p => /\.(?:md|mdx|rst)$/i.test(p))) return "docs-only";
	if (paths.length && paths.every(isTestPath)) return "tests-only";
	if (
		paths.length &&
		paths.every(p =>
			/(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.(?:toml|lock)|go\.(?:mod|sum))$/.test(
				p,
			),
		)
	)
		return "dependency bumps";
	return "other";
}

/**
 * Whether the repository's auto-merge kinds cover a change of `kind`. Unset kinds cover every change; an unknown
 * kind (the change's files could not all be listed) is covered by none. Both code hosts and the CI poll ask this.
 */
export function mergeKindAllowed(kinds: readonly TaskKind[] | undefined, kind: TaskKind | null | undefined): boolean {
	return !kinds || (!!kind && kinds.includes(kind));
}

export function finishedItem(v: ItemView, kind?: TaskKind, flaky = false, featureFix = false) {
	const latest = v.verdicts.at(-1);
	const verdict = latest && latest.head === v.head && latest.run === v.run?.n && !latest.moved ? latest : undefined;
	const ciFix = featureFix || !!v.run?.rounds.ci || v.events.some(e => e.step?.kind === "ci_fix");
	const sentBack =
		!!v.run?.rounds.review ||
		v.reviews.some(r => r.recommendation === "changes_requested") ||
		v.events.some(e => e.said.startsWith("Sent back: ")) ||
		v.feedback.batches.some(b => b.entries.some(e => e.kind === "changes_requested"));
	const fixed =
		ciFix ||
		sentBack ||
		!!v.run?.rounds.gate ||
		v.verdicts.some(r => r.result === "fail" || r.gate.required.some(c => c.sentBack > 0));
	const check = v.verifiedCheck?.state === "completed" ? v.verifiedCheck.conclusion : null;
	const merged = !!v.pullRequest && v.state === "done";
	const verified = merged && verdict?.result === "pass" && (!check || check === "success");
	const ci = verdict?.ci.state;
	const failed =
		v.state === "failed"
			? ["gate", "ci"].includes(v.run?.stopReason ?? "") ||
				(v.run?.stopReason === "repeated" && (ciFix || !!v.run.rounds.gate))
			: verdict?.result === "fail" && (ci === "failed" || verdict.gate.required.some(c => c.status === "failed"));
	return {
		at: v.endedAt ?? v.updatedAt,
		pr: v.pullRequest?.number,
		kind,
		feature: v.mode === "orchestrate",
		merged,
		closed: v.events.some(e => e.said === "The pull request was closed without merging."),
		verified,
		failed,
		sentBack,
		ciFix,
		fixed,
		flaky,
		ciPassed: ci === "passed",
		clean:
			verified &&
			ci === "passed" &&
			!fixed &&
			!verdict.flags.length &&
			(!v.review?.recommendation || v.review.recommendation === "approve"),
	};
}

export type ItemRecord = ReturnType<typeof finishedItem>;
export type RevertedPulls = Record<number, number>;

export function trackRecord(items: ItemRecord[], reverts: RevertedPulls = {}) {
	let level: ReadinessLevel = "Ask first",
		note = "",
		singles = 0,
		features = 0,
		fixes = 0,
		featurePrs = 0,
		failures = 0;
	const counts = new Map<TaskKind, number>();
	const earned: Partial<Record<Offer, number>> = {};
	const totals = { verified: 0, firstTry: 0, sentBack: 0, reverts: 0, ciPassed: 0, flaky: 0, merged: 0, closed: 0 };
	const events = items
		.flatMap(item => {
			const reverted = item.merged && item.pr && reverts[item.pr];
			return [
				{ at: item.at, item, revert: false },
				...(reverted ? [{ at: Math.max(item.at, reverted), item, revert: true }] : []),
			];
		})
		.sort((a, b) => a.at - b.at || Number(a.revert) - Number(b.revert) || (a.item.pr ?? 0) - (b.item.pr ?? 0));
	for (const { at, item, revert } of events) {
		if (revert) totals.reverts++;
		else {
			for (const field of ["verified", "sentBack", "ciPassed", "flaky", "merged", "closed"] as const)
				totals[field] += Number(item[field]);
			if (item.verified && !item.fixed) totals.firstTry++;
			if (item.verified) failures = 0;
			else if (item.failed) failures++;
		}
		if (revert || failures === BARS.failures) {
			const before = level;
			if (level === "Earned merge") {
				level = "Full plans";
				if (item.kind) {
					delete earned[item.kind];
					counts.delete(item.kind);
				} else {
					counts.clear();
					for (const k of kinds) delete earned[k];
				}
			} else if (level === "Full plans") level = "Small plans";
			else if (level === "Small plans") level = "Ask first";
			else level = "Not ready";
			if (level !== "Full plans") {
				counts.clear();
				for (const k of kinds) delete earned[k];
				features = fixes = featurePrs = 0;
			}
			if (!["Full plans", "Small plans"].includes(level)) {
				singles = 0;
				delete earned["Small plans"];
			}
			note = `${before} → ${level}. ${revert ? "Pull request #" + item.pr + " was reverted." : BARS.failures + " verifications failed in a row."}`;
			failures = 0;
			continue;
		}
		if (item.feature && (item.ciPassed || item.ciFix || item.failed)) {
			featurePrs++;
			fixes += Number(item.ciFix);
			features += Number(item.verified && item.ciPassed);
		}
		if (item.clean && !item.feature) {
			singles++;
			if (item.kind) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
		}
		if (!item.verified) continue;
		if (level === "Not ready") level = "Ask first";
		if (level === "Ask first" && singles >= BARS.singles) {
			level = "Small plans";
			earned["Small plans"] = at;
		}
		if (level === "Small plans" && features >= BARS.features && fixes / featurePrs <= BARS.fixRate)
			level = "Full plans";
		if (level === "Full plans" || level === "Earned merge")
			for (const [k, count] of counts) {
				if (count >= BARS.kind && earned[k] === undefined) {
					earned[k] = at;
					level = "Earned merge";
				}
			}
	}
	const progress =
		level === "Not ready"
			? "Verify an item to return to Ask first."
			: level === "Ask first"
				? `${singles} of ${BARS.singles} verified small items toward Small plans`
				: level === "Small plans"
					? `${features} of ${BARS.features} verified features toward Full plans${featurePrs ? " · " + Math.round((100 * fixes) / featurePrs) + "% needed CI fixes" : ""}`
					: kinds
							.filter(k => !earned[k])
							.map(k => `${counts.get(k) ?? 0} of ${BARS.kind} ${k} toward Earned merge`)
							.join(" · ");
	return { ...totals, level, earned, progress, note };
}

export type TrackRecord = ReturnType<typeof trackRecord>;
export function offered(record: TrackRecord, defaults: RepositoryAutonomy) {
	return (Object.keys(record.earned) as Offer[]).filter(k =>
		k === "Small plans"
			? !defaults.autoApprovePlans
			: !defaults.autoMergeSingles || (!!defaults.mergeKinds && !defaults.mergeKinds.includes(k)),
	);
}

export type OfferRow = { offer: Offer; earned: number; off: number };
export function applyOffers<T extends RepositoryAutonomy>(
	manual: T,
	record: TrackRecord | undefined,
	rows: OfferRow[],
) {
	const defaults = { ...manual },
		expired: Offer[] = [],
		disabled: string[] = [];
	const mergeKinds: TaskKind[] = [];
	for (const row of rows) {
		if (row.off || row.earned !== record?.earned[row.offer]) {
			if (!row.off) expired.push(row.offer);
			disabled.push(row.offer === "Small plans" ? "auto-approve small plans" : "auto-merge " + row.offer);
		} else if (row.offer === "Small plans") defaults.autoApprovePlans = true;
		else mergeKinds.push(row.offer);
	}
	if (!manual.autoMergeSingles && mergeKinds.length) {
		defaults.autoMergeSingles = true;
		defaults.mergeKinds = mergeKinds;
	}
	return {
		defaults,
		expired,
		switchNote: disabled.length ? "Turned off after the level dropped: " + disabled.join(", ") + "." : undefined,
	};
}
