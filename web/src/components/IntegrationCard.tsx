/**
 * The pieces every integration in Settings is built from, so GitHub, GitLab, Linear, Jira, Slack and whatever comes
 * next read the same way (styles/integrations.css):
 *
 * - `IntegrationCard`: the service's mark, its name and whether it is connected, one line on what it does, one
 *   primary action at the end, the rest in a ⋯ menu, and the body under it. Its head (`CardHead`) also serves the
 *   cards beside the integrations, such as API tokens.
 * - `IntegrationFacts`: who and where it is connected, as short labelled values.
 * - `IntegrationSteps`: what connecting it gets you, in three short steps, while it is not connected.
 * - `MappingList` and `MappingRow`: "this channel, team or project → that repository" rows, each with its options and
 *   its own remove control.
 * - `MappingForm`: the row that adds one.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
import { useHash } from "../lib/router";
import { PencilIcon, RepoIcon, TrashIcon } from "./Icons";
import { ProviderIcon, type ProviderId } from "./ProviderIcon";
import { Menu, Skeleton, SkeletonBadge, SkeletonButton, type MenuItem } from "./ui";

/** "loading": not read yet, its badge and action are shapes. "unknown": it could not be read, so no state is claimed. */
export type IntegrationState = "loading" | "unknown" | "disconnected" | "connected" | "reconnect";

const STATE_WORDS: Record<Exclude<IntegrationState, "loading" | "unknown">, string> = {
	connected: "Connected",
	disconnected: "Not connected",
	reconnect: "Needs reconnecting",
};

export function IntegrationCard({
	id,
	provider,
	name,
	what,
	state,
	action,
	more = [],
	children,
	sectionRef,
	testId,
}: {
	/** The section's anchor; its heading is `${id}-title`. */
	id: string;
	provider: ProviderId;
	name: string;
	/** One line on what it does. */
	what: ReactNode;
	state: IntegrationState;
	/** The one primary action: connect, reconnect, add. */
	action?: ReactNode;
	/** Everything else (disconnect), behind ⋯. */
	more?: MenuItem[];
	children?: ReactNode;
	sectionRef?: Ref<HTMLElement>;
	testId?: string;
}) {
	const titleId = `${id}-title`;
	return (
		<section
			ref={sectionRef}
			className={`usage-section integration integration-is-${state}`}
			id={id}
			aria-labelledby={titleId}
			data-testid={testId}
			aria-busy={state === "loading" || undefined}
		>
			<CardHead
				titleId={titleId}
				mark={<ProviderIcon id={provider} tone="brand" size={20} />}
				name={name}
				badge={
					state === "loading" ? (
						<SkeletonBadge />
					) : state === "unknown" ? null : (
						<span className={`integration-state integration-state-${state}`}>
							<span className="integration-state-dot" aria-hidden="true" />
							<span className="visually-hidden">: </span>
							{STATE_WORDS[state]}
						</span>
					)
				}
				what={what}
				action={action ?? (state === "loading" ? <SkeletonButton /> : undefined)}
				more={more}
			/>
			{children ? <div className="integration-body">{children}</div> : null}
		</section>
	);
}

/**
 * A card in the Integrations group while the deployment says which services it offers: its head, as shapes. The
 * first of them carries the `label` that says the group is loading; the others are hidden from assistive tech.
 */
export function IntegrationSkeleton({ label }: { label?: string }) {
	return (
		<section
			className="usage-section integration"
			{...(label ? { role: "status", "aria-busy": true, "aria-label": label } : { "aria-hidden": true })}
		>
			<div className="integration-head">
				<span className="integration-mark">
					<Skeleton width={20} height={20} radius="var(--radius-s)" />
				</span>
				<div className="integration-heading">
					<p className="integration-name">
						<Skeleton width={72} height={16} />
						<SkeletonBadge />
					</p>
					<p className="integration-what">
						<Skeleton width="58%" />
					</p>
				</div>
				<div className="integration-actions">
					<SkeletonButton />
				</div>
			</div>
		</section>
	);
}

/**
 * A Settings card's head, for an integration and for what sits beside them (API tokens): the mark on its tile, the
 * name with a badge (a connection state, a count), one line on what it is, one action, and the rest behind ⋯.
 */
export function CardHead({
	titleId,
	mark,
	name,
	badge,
	what,
	action,
	more = [],
}: {
	titleId: string;
	mark: ReactNode;
	name: string;
	badge?: ReactNode;
	what: ReactNode;
	action?: ReactNode;
	more?: MenuItem[];
}) {
	return (
		<div className="integration-head">
			<span className="integration-mark">{mark}</span>
			<div className="integration-heading">
				<h3 className="integration-name" id={titleId}>
					{name}
					{badge}
				</h3>
				<p className="integration-what">{what}</p>
			</div>
			{action ? <div className="integration-actions">{action}</div> : null}
			{more.length > 0 ? (
				<div className="integration-more-slot">
					<Menu
						align="end"
						spec={{ label: `More ${name} actions`, groups: [{ id: "more", items: more }], hints: false, width: 220 }}
						trigger={props => (
							<button
								type="button"
								className="icon-button integration-more"
								aria-label={`More ${name} actions`}
								title="More actions"
								{...props}
							>
								<span aria-hidden="true">⋯</span>
							</button>
						)}
					/>
				</div>
			) : null}
		</div>
	);
}

/** Who and where a service is connected: "Workspace Acme", "Signed in as Ada Lovelace". */
export function IntegrationFacts({
	facts,
	testId,
}: {
	facts: Array<[label: string, value: ReactNode] | null | false>;
	testId?: string;
}) {
	const shown = facts.filter((fact): fact is [string, ReactNode] => Boolean(fact));
	if (shown.length === 0) return null;
	return (
		<dl className="integration-facts" data-testid={testId}>
			{shown.map(([label, value]) => (
				<div key={label} className="integration-fact">
					<dt>{label}</dt>
					<dd>{value}</dd>
				</div>
			))}
		</dl>
	);
}

/** What connecting a service gets you, as up to three short steps, shown while it is not connected. */
export function IntegrationSteps({ steps }: { steps: ReactNode[] }) {
	return (
		<ol className="integration-steps">
			{steps.map((step, index) => (
				<li key={index}>
					<span>{step}</span>
				</li>
			))}
		</ol>
	);
}

/** A repository a mapping files into, as rows show it: the host's mark, then owner/name. */
export function MappedRepository({ host = "github", owner, name }: { host?: ProviderId; owner: string; name: string }) {
	return (
		<span className="mapping-repo">
			{host === "github" ? <RepoIcon size={13} /> : <ProviderIcon id={host} size={13} />}
			<span className="mapping-repo-name">
				{owner}/{name}
			</span>
		</span>
	);
}

export function MappingList({ label, children }: { label: string; children: ReactNode }) {
	return (
		<ul className="mapping-list" aria-label={label}>
			{children}
		</ul>
	);
}

/**
 * One mapping: where requests come from (a channel, a team, a project) and the repository they go to, or, for a
 * team or project not mapped yet, a quiet "not mapped" with what that means.
 */
export function MappingRow({
	from,
	fromNote,
	to,
	unmapped,
	onRemove,
	removeLabel,
	onChange,
	changeLabel,
	busy,
	options,
	testId,
}: {
	from: ReactNode;
	/** A short key beside the name: "ENG". */
	fromNote?: ReactNode;
	to: ReactNode | null;
	/** What an unmapped row's "to" says. */
	unmapped?: ReactNode;
	onRemove?(): void;
	removeLabel?: string;
	onChange?(): void;
	changeLabel?: string;
	busy?: boolean;
	/** Per-mapping options, under the row. */
	options?: ReactNode;
	testId?: string;
}) {
	return (
		<li className={`mapping-row${to === null ? " mapping-row-unmapped" : ""}`} data-testid={testId}>
			<div className="mapping-line">
				<span className="mapping-from">
					<span className="mapping-from-name">{from}</span>
					{fromNote ? <span className="mapping-from-note">{fromNote}</span> : null}
				</span>
				<span className="mapping-arrow" aria-hidden="true">
					→
				</span>
				<span className="mapping-to">{to ?? <span className="mapping-none">{unmapped ?? "Not mapped"}</span>}</span>
				<span className="mapping-actions">
					{onChange ? (
						<button
							type="button"
							className="icon-button icon-button-small"
							disabled={busy}
							aria-label={changeLabel}
							title="Change the repository"
							onClick={onChange}
						>
							<PencilIcon size={13} />
						</button>
					) : null}
					{onRemove ? (
						<button
							type="button"
							className="icon-button icon-button-small icon-button-danger"
							disabled={busy}
							aria-label={removeLabel}
							title="Remove"
							onClick={onRemove}
						>
							<TrashIcon size={13} />
						</button>
					) : null}
				</span>
			</div>
			{options ? <div className="mapping-options">{options}</div> : null}
		</li>
	);
}

/** The row that adds a mapping: its fields with an arrow between source and repository, then the button. */
export function MappingForm({
	title,
	from,
	to,
	submit,
	cancel,
	note,
	onSubmit,
}: {
	title: string;
	from?: ReactNode;
	/** Null for a single choice (a site, a project), with no source to map from. */
	to: ReactNode | null;
	submit: ReactNode;
	/** A way back, beside the submit, while changing something already chosen. */
	cancel?: ReactNode;
	note?: ReactNode;
	onSubmit?(event: FormEvent<HTMLFormElement>): void;
}) {
	const body = (
		<>
			<p className="mapping-form-title">{title}</p>
			{from !== undefined && to !== null ? (
				<div className="mapping-form-fields">
					<div className="mapping-form-from">{from}</div>
					<span className="mapping-arrow" aria-hidden="true">
						→
					</span>
					<div className="mapping-form-to">{to}</div>
					<div className="mapping-form-submit">
						{submit}
						{cancel}
					</div>
				</div>
			) : (
				<div className="mapping-form-fields mapping-form-fields-single">
					<div className="mapping-form-to">{from ?? to}</div>
					<div className="mapping-form-submit">
						{submit}
						{cancel}
					</div>
				</div>
			)}
			{note ? <div className="mapping-form-note">{note}</div> : null}
		</>
	);
	return onSubmit ? (
		<form className="mapping-form" onSubmit={onSubmit}>
			{body}
		</form>
	) : (
		<div className="mapping-form" role="group" aria-label={title}>
			{body}
		</div>
	);
}

/**
 * A count that goes up each time a connection's return fragment (`#gitlab=…`, `#link=…`) arrives in a page
 * that is already open. A return from the provider's own site is a new page load, which every panel reads on mount;
 * a return to the same document (a link opened in the tab that already shows Settings, or the mock) only changes
 * the fragment, and a panel that read it once at mount would keep showing what it showed before.
 */
export function useReturnRound(pattern: RegExp): number {
	const hash = useHash();
	// The fragment the page opened with is the panel's first read, not a new return.
	const seen = useRef(hash);
	const [round, setRound] = useState(0);
	useEffect(() => {
		if (!pattern.test(hash) || hash === seen.current) return;
		seen.current = hash;
		setRound(n => n + 1);
	}, [hash, pattern]);
	return round;
}
