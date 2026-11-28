/**
 * The Agents home: a rail of the user's repositories on the left, and on the right what is chosen in it:
 * everything (screens/Home.tsx), the agents on no repository, or one repository (screens/Repository.tsx).
 * The repository chosen is in the address (`/repositories/<GitHub's id>`), so a reload, a link or the
 * back button lands on it.
 *
 * The rail (components/Rail.tsx, the Factory's too) counts each repository's agents and work items: a
 * lime ring with how many run, an amber count of what asks the user; one with neither is quiet, its
 * name dimmer ("saved" for one that only has saved settings). Hovering a repository shows a new agent
 * there and its saved settings. On a phone the rail is a sheet, opened from a switcher at the top of
 * the page, with a strip of the repositories under it.
 *
 * The lists can be filtered (lib/workspace.ts): by status, agent, where it runs and kind. The filters
 * are the viewer's own, remembered in this browser, and narrow the rail and the lists alike.
 */
import type { GithubId, MachineSummary } from "@contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { RailFrame, RepoRail, useRailFold, useSearchKey, type RailChoice } from "../components/Rail";
import { RailFoot, useHostedUsage } from "../components/RailFoot";
import { ChevronDownIcon, PlusIcon, RepoIcon, RingIcon, SlidersIcon } from "../components/Icons";
import { FilterMenu } from "../components/WorkspaceFilters";
import { Sheet } from "../components/ui/Sheet";
import { PHONE_QUERY, useMediaQuery } from "../components/ui/useMediaQuery";
import { plural } from "../lib/format";
import { repositoryLabel } from "../lib/nav";
import { linkProps, usePageLabel, type RepositoryPaneView, type Route } from "../lib/router";
import {
	filterCount,
	loadFilters,
	railOf,
	saveFilters,
	type Filters,
	type Rail,
	type RailRepository,
} from "../lib/workspace";
import { useApp } from "../state/app";
import { useFactoryLimits, useSessions } from "../state/hooks";
import { Home, useSavedRepositories } from "./Home";
import type { ItemsState } from "../state/items";
import { useMachines } from "../state/machines";
import { RepositoryPane, useRepository } from "./Repository";

/** What the right side shows. */
export type Selection =
	| { kind: "everything" }
	| { kind: "none" }
	| { kind: "repository"; id: GithubId; view?: RepositoryPaneView; launching?: boolean };

/** The filters, as this browser remembers them: read once, written on each change. */
export function useFilters(): [Filters, (next: Filters) => void] {
	const [filters, setFilters] = useState<Filters>(() => loadFilters());
	const change = useCallback((next: Filters) => {
		setFilters(next);
		saveFilters(next);
	}, []);
	return [filters, change];
}

export function Workspace({ selection, items }: { selection: Selection; items: ItemsState }) {
	const { platform } = useApp();
	const state = useSessions();
	const { sessions } = state;
	const [filters, setFilters] = useFilters();
	const phone = useMediaQuery(PHONE_QUERY);
	const [folded, fold] = useRailFold(phone);
	const search = useRef<HTMLInputElement>(null);
	const saved = useSavedRepositories(sessions);
	const machinesOffered = platform.info?.machines != null;
	const machines = useMachines(machinesOffered);
	const machineList = machinesOffered ? (machines.list ?? []) : [];
	const usage = useHostedUsage(sessions);
	const ceiling = useFactoryLimits().value?.hostedRunning ?? null;
	const chosen = selection.kind === "repository" ? selection.id : null;
	const rail = railOf({ sessions, items: items.list, feed: items.feed, saved, filters, keep: chosen });
	// What the back control of a page opened from here calls it: "tide-tables · Work items".
	const chosenName =
		chosen === null
			? null
			: (rail.groups.flatMap(group => group.repositories).find(repository => String(repository.id) === String(chosen))
					?.name ?? null);
	usePageLabel(
		selection.kind === "repository"
			? chosenName
				? repositoryLabel(chosenName, selection.view)
				: null
			: selection.kind === "none"
				? "No repository"
				: "Agents",
	);
	const [sheet, setSheet] = useState(false);
	// While the first-run setup is on Home, the rail has nothing to list and is left out with its meter.
	const [firstRun, setFirstRun] = useState(false);
	const bare = firstRun && selection.kind === "everything";
	const openSheet = useCallback(() => setSheet(true), []);

	useSearchKey(search, { phone, folded, fold, onPhone: openSheet });

	// The sheet closes once something in it was chosen.
	const selectionKey = selection.kind === "repository" ? `r:${selection.id}` : selection.kind;
	// biome-ignore lint/correctness/useExhaustiveDependencies: a change of what is chosen is when it closes
	useEffect(() => setSheet(false), [selectionKey]);

	const meter = <RailFoot usage={usage} sessions={sessions} ceiling={ceiling} />;
	const body = (inSheet: boolean) => (
		<RepoRail
			rail={rail}
			chosen={selection}
			to={railRoute}
			noRepository
			actions={repositoryActions}
			tools={<FilterMenu compact filters={filters} onChange={setFilters} machines={machineList} />}
			empty={filterCount(filters) > 0 ? "No repository has anything the filters leave." : null}
			search={inSheet ? undefined : search}
			onFold={inSheet ? undefined : () => fold(true)}
		/>
	);

	return (
		<>
			<RailFrame
				label="Repositories"
				folded={folded}
				phone={phone}
				onUnfold={() => fold(false)}
				rail={
					bare ? null : (
						<>
							{body(false)}
							{meter}
						</>
					)
				}
			>
				{phone && !bare ? <PhoneSwitcher rail={rail} selection={selection} onOpen={() => setSheet(true)} /> : null}
				{selection.kind === "repository" ? (
					<RepositorySide
						key={selection.id}
						id={selection.id}
						view={selection.view}
						launching={selection.launching ?? false}
						items={items}
						filters={filters}
						onFilters={setFilters}
						machines={machineList}
					/>
				) : (
					<Home
						state={state}
						items={platform.info?.items ? items.list : []}
						usage={usage}
						scope={selection.kind === "none" ? "none" : "all"}
						filters={filters}
						onFilters={setFilters}
						machines={machineList}
						firstRun={bare}
						onFirstRun={setFirstRun}
					/>
				)}
			</RailFrame>
			{phone ? (
				<Sheet open={sheet} onClose={() => setSheet(false)} title="Repositories" footer={meter}>
					{body(true)}
				</Sheet>
			) : null}
		</>
	);
}

const railRoute = (choice: RailChoice): Route =>
	choice.kind === "repository"
		? { name: "repository", id: choice.id }
		: choice.kind === "none"
			? { name: "home", scope: "none" }
			: { name: "home" };

/** A repository row's actions on hover: a new agent there, and its saved settings. */
const repositoryActions = (repository: RailRepository, name: string) => (
	<>
		<a
			className="ws-rail-action"
			{...linkProps({ name: "new", repository: repository.id })}
			aria-label={`New agent on ${name}`}
			title="New agent here"
		>
			<PlusIcon size={13} />
		</a>
		<a
			className="ws-rail-action"
			{...linkProps({ name: "repository", id: repository.id, view: "settings" })}
			aria-label={`Saved settings of ${name}`}
			title="Saved settings"
		>
			<SlidersIcon size={13} />
		</a>
	</>
);

function RepositorySide({
	id,
	...props
}: {
	id: GithubId;
	view?: RepositoryPaneView;
	launching: boolean;
	items: ItemsState;
	filters: Filters;
	onFilters(filters: Filters): void;
	machines: readonly MachineSummary[];
}) {
	const page = useRepository(id);
	return <RepositoryPane page={page} {...props} />;
}

// ---- a phone's switcher ----------------------------------------------------------------------------

function PhoneSwitcher({ rail, selection, onOpen }: { rail: Rail; selection: Selection; onOpen(): void }) {
	const all = rail.groups.flatMap(group => group.repositories);
	const chosen =
		selection.kind === "repository"
			? (all.find(repository => String(repository.id) === String(selection.id)) ?? null)
			: null;
	const needs = chosen ? chosen.needs : selection.kind === "none" ? rail.none.needs : rail.everything.needs;
	return (
		<div className="ws-switch">
			<button type="button" className="ws-switch-button" onClick={onOpen} aria-haspopup="dialog">
				<RepoIcon size={14} />
				<span className="ws-switch-name">
					{chosen ? (
						<>
							{chosen.owner ? <span className="ws-switch-owner">{chosen.owner}/</span> : null}
							<strong>{chosen.name}</strong>
						</>
					) : (
						<strong>{selection.kind === "none" ? "No repository" : "Everything"}</strong>
					)}
				</span>
				{needs > 0 ? (
					<span className="ws-badge-needs" aria-label={`${needs} ${needs === 1 ? "needs" : "need"} you`}>
						{needs}
					</span>
				) : null}
				<span className="ws-switch-count">{plural(rail.repositories, "repo")}</span>
				<ChevronDownIcon size={12} />
			</button>
			<ul className="ws-strip" aria-label="Repositories">
				<li>
					<a
						className="ws-strip-chip"
						aria-current={selection.kind === "everything" ? "page" : undefined}
						{...linkProps({ name: "home" })}
					>
						Everything
					</a>
				</li>
				{all.map(repository => (
					<li key={String(repository.id)}>
						<a
							className="ws-strip-chip"
							aria-current={chosen?.id === repository.id ? "page" : undefined}
							{...linkProps({ name: "repository", id: repository.id })}
						>
							{repository.needs > 0 ? (
								<span className="ws-lamp" aria-label="needs you" />
							) : repository.running > 0 ? (
								<RingIcon size={11} className="ws-ring" />
							) : null}
							{repository.name}
						</a>
					</li>
				))}
			</ul>
		</div>
	);
}
