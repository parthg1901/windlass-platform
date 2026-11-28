/**
 * Plans and billing, where the deployment has them (`PlatformInfo.billing`): the Plan section of Settings, the
 * comparison of Free and Pro the upgrade page shows, and the notice about the month's hosted minutes near and at the
 * limit. Without billing none of it is shown. Payment happens on the provider's own pages: Upgrade opens its checkout,
 * Manage billing its customer portal.
 */
import type { BillingPeriod, BillingView, HostedMonth, PlanInfo, UsageNumbers } from "@contract";
import { useCallback, useEffect, useId, useState } from "react";
import { sizeName } from "../lib/sizes";
import { count } from "../lib/format";
import { sourceNames } from "../../../server/src/sources/registry.js";
import {
	dollars,
	minutes,
	monthName,
	monthReset,
	monthSentence,
	monthState,
	periodWords,
	withOverage,
} from "../lib/hosted";
import { linkProps } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { CheckIcon, InfoIcon, WarnIcon } from "./Icons";
import { Button, LoadError, Loading, Segmented, SkeletonLines } from "./ui";

type Enabled = Extract<BillingView, { enabled: true }>;

/** The account's billing, read when the screen opens; `view` is null while it loads. */
export function useBilling() {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [view, setView] = useState<BillingView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const reload = useCallback(() => {
		setError(null);
		client
			.user(auth)
			.billing()
			.then(setView, (failure: unknown) => setError(explain(failure)));
	}, [client, auth, explain]);
	useEffect(reload, [reload]);
	return { view, error, reload, replace: setView };
}

/** Opens the provider's checkout or portal in this tab: the address comes from the server, which asks the provider. */
function useGoTo() {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState<"checkout" | "portal" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const go = async (what: "checkout" | "portal", period: BillingPeriod = "month") => {
		setBusy(what);
		setError(null);
		try {
			const user = client.user(auth);
			const { url } =
				what === "checkout"
					? await user.billingCheckout({ period, origin: location.origin })
					: await user.billingPortal({ origin: location.origin });
			location.assign(url);
		} catch (failure) {
			setError(explain(failure));
			setBusy(null);
		}
	};
	return { go, busy, error };
}

function MonthMeter({ month }: { month: HostedMonth }) {
	const used = month.usedSeconds + month.heldSeconds;
	const scale = Math.max(month.limitSeconds, used, 1);
	const share = (seconds: number) => `${Math.min(100, (seconds / scale) * 100)}%`;
	return (
		<div
			className="usage-meter billing-meter"
			role="meter"
			aria-label={`Hosted time used or held ${periodWords(month)}`}
			aria-valuemin={0}
			aria-valuemax={month.limitSeconds}
			aria-valuenow={Math.min(used, month.limitSeconds)}
			aria-valuetext={`${minutes(used)} of ${minutes(month.limitSeconds)} min of hosted time`}
		>
			{month.usedSeconds > 0 ? <span className="usage-meter-used" style={{ width: share(month.usedSeconds) }} /> : null}
			{month.heldSeconds > 0 ? <span className="usage-meter-held" style={{ width: share(month.heldSeconds) }} /> : null}
			{withOverage(month) ? (
				<span className="billing-meter-mark" style={{ left: share(month.includedSeconds) }} aria-hidden="true" />
			) : null}
		</div>
	);
}

/** What is left: of the included minutes first, then of what the spend cap pays for. */
function leftWords(month: HostedMonth): string {
	if (month.leftSeconds < 60) return "none left";
	const used = month.usedSeconds + month.heldSeconds;
	if (withOverage(month) && used < month.includedSeconds)
		return `${minutes(month.includedSeconds - used)} left, then overage`;
	return withOverage(month)
		? `${minutes(month.leftSeconds)} left under your cap`
		: `${minutes(month.leftSeconds)} left`;
}

/** Counted time and the allowance still available to start work. */
export function MonthFigure({ month }: { month: HostedMonth }) {
	const used = month.usedSeconds;
	const over = Math.max(0, used - month.includedSeconds);
	return (
		<>
			<p className="usage-figure">
				<strong>{minutes(used)}</strong>
				<span>
					{" "}
					of {minutes(month.includedSeconds)} min of hosted time used
					{over > 0 ? `, and ${minutes(over)} past them` : ""}
				</span>
				<span className="usage-figure-left">{leftWords(month)}</span>
			</p>
			<MonthMeter month={month} />
		</>
	);
}

function planPrice(plan: PlanInfo, period: BillingPeriod): string {
	if (plan.monthlyCents === 0) return "$0";
	return period === "year" && plan.yearlyCents !== null
		? `${dollars(Math.round(plan.yearlyCents / 12))} a month`
		: `${dollars(plan.monthlyCents)} a month`;
}

/** The Plan section of Settings: the plan, this month's hosted minutes, the spend cap, and Upgrade or Manage billing. */
export function PlanSection() {
	const { view, error, reload, replace } = useBilling();
	const { go, busy, error: goError } = useGoTo();
	// Back from the provider's checkout or portal at /settings#plan: the section is there once it has loaded.
	useEffect(() => {
		if (view !== null && location.hash === "#plan") document.getElementById("plan")?.scrollIntoView({ block: "start" });
	}, [view]);
	if (view && !view.enabled && !view.exempt) return null;
	return (
		<section className="usage-section billing" id="plan" aria-labelledby="settings-plan">
			<h3 className="usage-title" id="settings-plan">
				Plan
				{view?.enabled ? (
					<span className="usage-count">
						{view.plan === "pro"
							? `Pro${view.period === "year" ? " · yearly" : view.period === "month" ? " · monthly" : ""}`
							: "Free"}
					</span>
				) : null}
			</h3>
			{view === null ? (
				error ? (
					<LoadError inline error={error} reload={reload} />
				) : (
					<Loading label="Loading your plan">
						<SkeletonLines title={false} />
					</Loading>
				)
			) : !view.enabled ? (
				<p className="usage-lede">Billing doesn't apply to this account.</p>
			) : (
				<PlanBody view={view} replace={replace} go={go} busy={busy} goError={goError} />
			)}
		</section>
	);
}

function PlanBody({
	view,
	replace,
	go,
	busy,
	goError,
}: {
	view: Enabled;
	replace(view: BillingView): void;
	go: ReturnType<typeof useGoTo>["go"];
	busy: "checkout" | "portal" | null;
	goError: string | null;
}) {
	const plan = view.plans.find(one => one.id === view.plan)!;
	const pro = view.plans.find(one => one.id === "pro") ?? null;
	const month = view.month;
	const date = (at: number) =>
		new Date(at).toLocaleDateString("en-US", { day: "numeric", month: "long", timeZone: "UTC" });
	return (
		<>
			<p className="usage-lede">Your plan includes hosted time. Runs on your machines are free.</p>
			{view.status === "paused" ? (
				<p className="callout callout-warn" role="status">
					Your subscription is paused.{" "}
					{view.plan === "pro" && view.graceUntil ? `Pro’s limits stay until ${date(view.graceUntil)}. ` : ""}Open
					Manage billing to resume it.
				</p>
			) : view.status === "past_due" && view.graceUntil !== null ? (
				<p className="callout callout-warn billing-callout" role="status">
					<WarnIcon />
					<span>
						Your last payment didn't go through. Pro's limits stay until {date(view.graceUntil)}; after that the account
						moves to Free's limits. Nothing is deleted. Update your card under Manage billing.
					</span>
				</p>
			) : null}
			<div className="billing-card">
				{month ? (
					<div className="billing-month">
						<p className="billing-month-name">{monthName(month)}</p>
						<MonthFigure month={month} />
					</div>
				) : null}
				<dl className="billing-facts">
					<div>
						<dt>Plan</dt>
						<dd>
							{plan.name},{" "}
							{plan.id === "pro"
								? view.period === "year" && plan.yearlyCents !== null
									? `${dollars(plan.yearlyCents)} a year`
									: `${dollars(plan.monthlyCents)} a month`
								: "$0"}
							{view.periodEnd !== null ? (
								<span className="billing-gloss">
									{" "}
									· {view.cancelAtPeriodEnd ? `ends ${date(view.periodEnd)}` : `renews ${date(view.periodEnd)}`}
								</span>
							) : null}
						</dd>
					</div>
					<div>
						<dt>Includes</dt>
						<dd>
							{count(plan.hostedMinutes)} min of hosted time a month, {plan.hostedRunning} hosted at once, up to{" "}
							{plan.machines} machines
						</dd>
					</div>
					{month ? (
						<div>
							<dt>Resets</dt>
							<dd>
								{monthReset(month)}, {new Date(month.resetsAt).toISOString().slice(11, 16)} UTC
							</dd>
						</div>
					) : null}
					{view.period === "month" && plan.overageCentsPer1000 !== null ? (
						<>
							<div>
								<dt>Overage</dt>
								<dd>
									{count(view.overageMinutes)} {view.overageMinutes === 1 ? "minute" : "minutes"}{" "}
									{month ? periodWords(month) : "this billing period"},{" "}
									{dollars(Math.ceil((view.overageMinutes * plan.overageCentsPer1000) / 1000))}
									<span className="billing-gloss">
										{" "}
										· ${(plan.overageCentsPer1000 / 100000).toFixed(3)} a minute past the included ones
									</span>
								</dd>
							</div>
							<div>
								<dt>Spend cap</dt>
								<dd>
									<CapForm view={view} plan={plan} onSaved={replace} />
								</dd>
							</div>
						</>
					) : (
						<div>
							<dt>At the limit</dt>
							<dd>
								{view.plan === "pro" && view.period === "year"
									? "Yearly Pro has no overage, so no spend cap applies. Switch to monthly Pro for overage."
									: "Hosted agents stop until the month resets."}{" "}
								Agents on your own machines keep running.
							</dd>
						</div>
					)}
				</dl>
			</div>
			<div className="billing-actions">
				{view.plan === "free" && view.status !== "paused" && view.status !== "past_due" ? (
					<>
						<a className="button button-primary" {...linkProps({ name: "plans" })}>
							Upgrade to Pro
						</a>
						<span className="billing-gloss">
							{pro ? `${dollars(pro.monthlyCents)} a month, ${count(pro.hostedMinutes)} min of hosted time` : null}
						</span>
					</>
				) : (
					<>
						<Button variant="secondary" disabled={busy !== null || !view.portal} onClick={() => void go("portal")}>
							{busy === "portal" ? "Opening…" : "Manage billing"}
						</Button>
						<a className="link" {...linkProps({ name: "plans" })}>
							Compare plans
						</a>
					</>
				)}
			</div>
			{goError ? (
				<p className="callout callout-warn billing-callout" role="alert">
					<WarnIcon />
					<span>{goError}</span>
				</p>
			) : null}
		</>
	);
}

/** The overage spend cap: the server stops hosted agents when overage would pass it. */
function CapForm({ view, plan, onSaved }: { view: Enabled; plan: PlanInfo; onSaved(view: BillingView): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const id = useId();
	const [draft, setDraft] = useState(String(view.capCents / 100));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const dollarsAsked = Number(draft);
	const cents = Math.round(dollarsAsked * 100);
	const valid = draft.trim() !== "" && Number.isFinite(dollarsAsked) && cents >= 0 && cents <= view.maxCapCents;
	const changed = valid && cents !== view.capCents;
	const capMinutes =
		plan.overageCentsPer1000 === null ? 0 : Math.floor((view.capCents * 1000) / plan.overageCentsPer1000);
	const save = async () => {
		setBusy(true);
		setError(null);
		try {
			const next = await client.user(auth).setOverageCap({ cents });
			onSaved(next);
			if (next.enabled) setDraft(String(next.capCents / 100));
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(false);
		}
	};
	return (
		<form
			className="billing-cap"
			onSubmit={event => {
				event.preventDefault();
				if (changed) void save();
			}}
		>
			<label className="visually-hidden" htmlFor={id}>
				Monthly overage spend cap in US dollars
			</label>
			<span className="billing-cap-field">
				<span aria-hidden="true">$</span>
				<input
					id={id}
					className={`input input-mono${valid ? "" : " input-invalid"}`}
					inputMode="decimal"
					value={draft}
					disabled={busy}
					onChange={event => setDraft(event.target.value)}
					aria-describedby={`${id}-note`}
				/>
			</span>
			<Button size="sm" variant="secondary" type="submit" disabled={!changed || busy}>
				{busy ? "Saving…" : "Save"}
			</Button>
			<span className="billing-gloss" id={`${id}-note`}>
				{valid
					? `a month, at most ${dollars(view.maxCapCents)}: ${count(capMinutes)} overage minutes. At the cap hosted agents stop; 0 means no overage.`
					: `Enter an amount from $0 to ${dollars(view.maxCapCents)}.`}
			</span>
			{error ? (
				<span className="billing-cap-error" role="alert">
					{error}
				</span>
			) : null}
		</form>
	);
}

const FEATURES: Array<{ label: string; of(plan: PlanInfo, period: BillingPeriod): string | boolean }> = [
	{ label: "My machines", of: plan => `Unlimited runs, up to ${plan.machines} machines` },
	{ label: "Hosted time", of: plan => `${count(plan.hostedMinutes)} min a month` },
	{ label: "Hosted at once", of: plan => String(plan.hostedRunning) },
	{ label: "Sandbox sizes", of: plan => plan.sizes.map(sizeName).join(", ") },
	{ label: "The Factory", of: () => "All of it: plan first, checks, CI fixes, review" },
	{ label: "Features over two repositories", of: plan => plan.crossRepo },
	{
		label: "Items filed from connected services",
		of: plan => `${count(plan.githubItemsPerDay)} a day in total, from ${sourceNames()} together`,
	},
	{
		label: "Past the included minutes",
		of: (plan, period) =>
			plan.overageCentsPer1000 === null
				? "Hosted agents stop until the month resets"
				: period === "year"
					? "No overage: hosted agents stop at 1,800 minutes a month"
					: `$${(plan.overageCentsPer1000 / 100000).toFixed(3)} a minute, up to a spend cap you set (default $20)`,
	},
];

/** Free and Pro side by side, with monthly or yearly, and Upgrade. */
export function PlanCompare({ view }: { view: Enabled }) {
	const { go, busy, error } = useGoTo();
	const [period, setPeriod] = useState<BillingPeriod>("month");
	const pro = view.plans.find(plan => plan.id === "pro");
	const saving =
		pro && pro.yearlyCents !== null ? Math.round(100 - (pro.yearlyCents / (pro.monthlyCents * 12)) * 100) : 0;
	return (
		<>
			<div className="billing-period">
				<Segmented<BillingPeriod>
					aria-label="Billing period"
					value={period}
					onChange={setPeriod}
					options={[
						{ value: "month" as const, label: "Monthly" },
						{ value: "year" as const, label: "Yearly" },
					]}
				/>
				{saving > 0 ? <span className="billing-gloss">Yearly saves {saving}%</span> : null}
			</div>
			<div className="billing-grid">
				{view.plans.map(plan => {
					const current = plan.id === view.plan;
					return (
						<article
							key={plan.id}
							className={`usage-card billing-offer${current ? " billing-offer-current" : ""}`}
							aria-labelledby={`plan-${plan.id}`}
						>
							<header className="billing-offer-head">
								<h2 className="billing-offer-name" id={`plan-${plan.id}`}>
									{plan.name}
									{current ? <span className="usage-count">your plan</span> : null}
								</h2>
								<p className="billing-offer-price">
									<strong>{planPrice(plan, period)}</strong>
									{plan.id === "pro" && period === "year" && plan.yearlyCents !== null ? (
										<span className="billing-gloss"> · {dollars(plan.yearlyCents)} billed yearly</span>
									) : plan.id === "pro" ? (
										<span className="billing-gloss"> · billed monthly</span>
									) : null}
								</p>
							</header>
							<ul className="billing-offer-list">
								{FEATURES.map(feature => {
									const value = feature.of(plan, period);
									if (value === false)
										return (
											<li key={feature.label} className="billing-offer-no">
												<span className="billing-offer-label">{feature.label}</span>
												<span>Not included</span>
											</li>
										);
									return (
										<li key={feature.label}>
											<span className="billing-offer-label">{feature.label}</span>
											<span>
												{value === true ? (
													<>
														<CheckIcon size={14} /> Included
													</>
												) : (
													value
												)}
											</span>
										</li>
									);
								})}
							</ul>
							<div className="billing-offer-action">
								{plan.id === "pro" ? (
									current || view.status === "paused" || view.status === "past_due" ? (
										<Button
											variant="secondary"
											disabled={busy !== null || !view.portal}
											onClick={() => void go("portal")}
										>
											{busy === "portal" ? "Opening…" : "Manage billing"}
										</Button>
									) : (
										<Button variant="primary" disabled={busy !== null} onClick={() => void go("checkout", period)}>
											{busy === "checkout"
												? "Opening checkout…"
												: `Upgrade to Pro${period === "year" ? ", yearly" : ""}`}
										</Button>
									)
								) : current ? (
									<span className="billing-gloss">You're on Free.</span>
								) : (
									<span className="billing-gloss">
										Cancel Pro under Manage billing to move to Free at the end of the period.
									</span>
								)}
							</div>
						</article>
					);
				})}
			</div>
			{error ? (
				<p className="callout callout-warn billing-callout" role="alert">
					<WarnIcon />
					<span>{error}</span>
				</p>
			) : null}
		</>
	);
}

/**
 * The gentle notice when the month's hosted minutes run low, and the clear one when they are used up: what was used,
 * and the ways on (the user's own machines, Pro, or the spend cap). Nothing where the account has no monthly minutes.
 */
export function HostedNotice({ numbers, pro }: { numbers: UsageNumbers | null; pro: PlanInfo | null }) {
	const { platform } = useApp();
	const state = monthState(numbers);
	// The composer under it leaves the month to this notice (StartComposer's `hostedNotice`), so it says what launching does.
	const sentence = monthSentence(numbers, pro, { launch: true });
	if (!numbers?.hosted || state === "plenty" || sentence === null) return null;
	const month = numbers.hosted;
	return (
		<div
			className={`callout ${state === "used" ? "callout-warn" : "callout-info"} billing-notice`}
			role={state === "used" ? "alert" : "status"}
		>
			{state === "used" ? <WarnIcon /> : <InfoIcon />}
			<div>
				<p className="callout-text">{sentence}</p>
				<p className="billing-notice-links">
					{platform.info?.machines ? (
						<a className="link" {...linkProps({ name: "machines" })}>
							My machines
						</a>
					) : null}
					{month.plan === "free" ? (
						<a className="link" {...linkProps({ name: "plans" })}>
							Compare Free and Pro
						</a>
					) : month.plan === "pro" ? (
						<a className="link" {...linkProps({ name: "settings" })}>
							{month.period === "year" ? "Manage billing in Settings" : "Spend cap in Settings"}
						</a>
					) : null}
				</p>
			</div>
		</div>
	);
}
