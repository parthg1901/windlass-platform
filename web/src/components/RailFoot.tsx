/**
 * The rail's foot on both pages beside it: the day's (or, with a plan, the month's) hosted time as a
 * meter, what is at work against the ceiling, and the sandboxes kept, leading to the usage page.
 */
import { USAGE_LOW_SHARE, type SessionSummary, type UsageNumbers } from "@contract";
import { minutes, monthReset } from "../lib/hosted";
import { count, localTime, sandboxTime } from "../lib/format";
import { workingCounts } from "../lib/repositories";
import { linkProps } from "../lib/router";
import { allowanceState, useAllowance } from "../state/hooks";
import { RingIcon } from "./Icons";
import { Skeleton } from "./ui/Skeleton";

/** The usage numbers, asked again when a session starts or stops working, and when one is added or deleted. */
export function useHostedUsage(sessions: readonly SessionSummary[] | null): UsageNumbers | null {
	const counts = workingCounts(sessions ?? []);
	return useAllowance(`${counts.ceilinged + counts.onMachines}:${sessions?.length ?? 0}`);
}

export function RailFoot({
	usage,
	sessions,
	ceiling,
}: {
	usage: UsageNumbers | null;
	sessions: readonly SessionSummary[] | null;
	ceiling: number | null;
}) {
	const { ceilinged: working, onMachines } = workingCounts(sessions ?? []);
	const state = usage === null ? "plenty" : allowanceState(usage, USAGE_LOW_SHARE);
	// With a plan, the month's hosted minutes, in weighted seconds (lib/hosted.ts).
	const month = usage?.hosted ?? null;
	const spent = month
		? month.usedSeconds + month.heldSeconds
		: usage === null
			? 0
			: usage.usedSeconds + usage.heldSeconds;
	const allowance = month ? month.limitSeconds : (usage?.allowanceSeconds ?? null);
	const share = allowance === null || allowance === 0 ? null : Math.min(1, spent / allowance);
	const sandboxes = usage?.sandboxes ?? null;
	const full = sandboxes !== null && sandboxes.limit !== null && sandboxes.kept >= sandboxes.limit;
	// Until the numbers arrive, each of them is a shape the width of what it will say: nothing pops in.
	const reading = usage === null;
	return (
		<a
			className={`ws-rail-foot${state !== "plenty" ? " ws-rail-foot-warn" : ""}`}
			{...linkProps({ name: "usage" })}
			title="Usage: sandbox time and sandboxes"
			aria-busy={reading || undefined}
		>
			<span className="ws-foot-time">
				{reading ? (
					<>
						<Skeleton width={104} />
						<Skeleton width={64} />
					</>
				) : (
					<>
						<span>
							{month
								? month.plan === "pro"
									? `Hosted · resets ${monthReset(month)}`
									: "Hosted this month"
								: "Hosted time today"}
						</span>
						<span>
							<strong>{month ? minutes(spent) : sandboxTime(spent)}</strong>
							{allowance === null ? null : month ? ` of ${minutes(allowance)} min` : ` of ${sandboxTime(allowance)}`}
						</span>
					</>
				)}
				{month && state !== "plenty" ? (
					<span className="ws-foot-left">
						{state === "used" ? `Used up until ${monthReset(month)}` : `${minutes(month.leftSeconds)} min left`}
					</span>
				) : null}
				{!month && usage !== null && state !== "plenty" && usage.leftSeconds !== null ? (
					<span className="ws-foot-left">
						{state === "used" ? `Used up until ${localTime(usage.resetsAt)}` : `${sandboxTime(usage.leftSeconds)} left`}
					</span>
				) : null}
			</span>
			{reading ? <Skeleton width="100%" height={6} radius={3} /> : null}
			{share === null ? null : (
				<span
					className="ws-foot-bar"
					role="meter"
					aria-label="Hosted time used today"
					aria-valuemin={0}
					aria-valuemax={allowance ?? 0}
					aria-valuenow={Math.min(spent, allowance ?? spent)}
					aria-valuetext={`${sandboxTime(spent)} of ${sandboxTime(allowance ?? 0)}`}
				>
					<span className="ws-foot-bar-fill" style={{ width: `${Math.max(share, spent > 0 ? 0.04 : 0) * 100}%` }} />
				</span>
			)}
			<span className="ws-foot-facts">
				<span>
					{working > 0 ? <RingIcon size={11} className="ws-ring" /> : null}
					<span>
						<strong>{working}</strong>
						{ceiling === null ? "" : ` of ${ceiling}`} working{onMachines > 0 ? `, ${onMachines} on your machines` : ""}
					</span>
				</span>
				{reading ? <Skeleton width={112} /> : null}
				{sandboxes === null ? null : (
					<span className={full ? "ws-foot-full" : undefined}>
						<span>
							<strong>{count(sandboxes.kept)}</strong>
							{sandboxes.limit === null
								? sandboxes.kept === 1
									? " sandbox kept"
									: " sandboxes kept"
								: ` of ${count(sandboxes.limit)} kept sandboxes`}
						</span>
						{sandboxes.limit !== null && sandboxes.limit <= 10 ? (
							<span className="ws-foot-slots" aria-hidden="true">
								{Array.from({ length: sandboxes.limit }, (_, index) => (
									<i key={index} className={index < sandboxes.kept ? "ws-foot-slot-on" : undefined} />
								))}
							</span>
						) : null}
						{full ? <span className="visually-hidden"> (the most an account may keep)</span> : null}
					</span>
				)}
			</span>
		</a>
	);
}
