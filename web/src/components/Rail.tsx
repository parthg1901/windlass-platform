/**
 * The rail beside a page's main side, one for the Agents home and the Factory: a search at its top (`/`
 * reaches it from anywhere on the page), "Everything", "No repository" where it means something, "Active
 * now", the repositories grouped by owner (each owner folding away, which this browser remembers), and
 * the hosted time at its foot. Only what a row counts and where it leads are each page's own: the
 * page hands over its `Rail` and its routes. Its frame slides and fades as it folds (Ctrl+B, ⌘B on a
 * Mac, which this browser remembers for both pages); the arrow keys move between its rows.
 */
import type { GithubId } from "@contract";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type RefObject,
} from "react";
import { linkProps, navigate, type Route } from "../lib/router";
import { plural } from "../lib/format";
import {
	activeRepositories,
	loadFoldedOwners,
	loadRailFolded,
	railBadge,
	saveFoldedOwners,
	saveRailFolded,
	searchRail,
	type Rail,
	type RailRepository,
} from "../lib/workspace";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon, RingIcon, SearchIcon } from "./Icons";
import { hostOfAddress, OwnerAvatar, RepoTile } from "./RepoTile";

/** Whether the rail is folded away, and the way to fold it; Ctrl+B (⌘B) folds it and back, where there is one (not on a phone). */
export function useRailFold(phone: boolean): [boolean, (next: boolean) => void] {
	const [folded, setFolded] = useState(() => loadRailFolded());
	const fold = useCallback((next: boolean) => {
		setFolded(next);
		saveRailFolded(next);
	}, []);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || phone) return;
			if (
				(event.key === "b" || event.key === "B") &&
				(event.metaKey || event.ctrlKey) &&
				!event.altKey &&
				!event.shiftKey
			) {
				event.preventDefault();
				fold(!folded);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [phone, folded, fold]);
	return [folded, fold];
}

const isTyping = (target: EventTarget | null) =>
	target instanceof HTMLElement &&
	(target.isContentEditable ||
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.tagName === "SELECT");

/** "/" finds a repository from anywhere but a field: the rail's search, unfolding it first; on a phone, `onPhone`. */
export function useSearchKey(
	search: RefObject<HTMLInputElement | null>,
	{
		phone,
		folded,
		fold,
		onPhone,
	}: { phone: boolean; folded: boolean; fold(next: boolean): void; onPhone?: () => void },
) {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented) return;
			if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
			if (phone && !onPhone) return;
			event.preventDefault();
			if (phone) onPhone?.();
			else if (folded) {
				// Once the rail can take the focus again.
				fold(false);
				requestAnimationFrame(() => search.current?.focus());
			} else search.current?.focus();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [search, phone, folded, fold, onPhone]);
}

/**
 * The rail and the main side; folded, a button brings the rail back. The rail stays drawn while it
 * folds, inert, so its width can slide and its rows fade (workspace.css). A phone has no rail here:
 * its page offers its own way.
 */
export function RailFrame({
	label,
	rail,
	folded,
	phone,
	onUnfold,
	children,
}: {
	label: string;
	rail: ReactNode;
	folded: boolean;
	phone: boolean;
	onUnfold(): void;
	children: ReactNode;
}) {
	return (
		<div className={`ws${folded && !phone ? " ws-folded" : ""}`}>
			{phone ? null : (
				<nav className="ws-rail" aria-label={label} inert={folded}>
					<div className="ws-rail-inner">{rail}</div>
				</nav>
			)}
			<div className="ws-main">
				{folded && !phone ? (
					<button
						type="button"
						className="ws-unfold"
						onClick={onUnfold}
						aria-label={`Show the ${label.toLowerCase()}`}
						title={`Show the ${label.toLowerCase()} (Ctrl+B)`}
					>
						<ChevronRightIcon size={14} />
						<span>{label}</span>
					</button>
				) : null}
				{children}
			</div>
		</div>
	);
}

/** The button at the rail's top that folds it away. */
export function RailFoldButton({ label, onFold }: { label: string; onFold(): void }) {
	return (
		<button
			type="button"
			className="ws-fold"
			onClick={onFold}
			aria-label={`Hide the ${label.toLowerCase()}`}
			title={`Hide the ${label.toLowerCase()} (Ctrl+B)`}
		>
			<ChevronLeftIcon size={14} />
		</button>
	);
}

/** Three dots in a row: everything at once. */
export function EverythingIcon() {
	return (
		<svg width={14} height={14} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
			<circle cx="3" cy="8" r="1.4" />
			<circle cx="8" cy="8" r="1.4" />
			<circle cx="13" cy="8" r="1.4" />
		</svg>
	);
}

/** The rows a key moves between: the rail's links, in the order they stand; above the first, its search, where it has one. */
export function moveFocus(event: ReactKeyboardEvent<HTMLElement>, list: HTMLElement | null) {
	if (!list) return;
	const rows = [...list.querySelectorAll<HTMLElement>("[data-rail-row]")];
	if (rows.length === 0) return;
	const at = rows.indexOf(document.activeElement as HTMLElement);
	const to =
		event.key === "ArrowDown"
			? Math.min(rows.length - 1, at + 1)
			: event.key === "ArrowUp"
				? at <= 0
					? -1
					: at - 1
				: event.key === "Home"
					? 0
					: event.key === "End"
						? rows.length - 1
						: null;
	if (to === null) return;
	event.preventDefault();
	if (to === -1) {
		list.closest(".ws-rail-body")?.querySelector<HTMLInputElement>(".ws-search input")?.focus();
		return;
	}
	rows[to]?.focus();
	rows[to]?.scrollIntoView?.({ block: "nearest" });
}

/** A ring while something runs, the amber count of what asks, otherwise how many. */
/** `runningWord`: what the ring's number counts, said to a screen reader. */
export function Badges({
	running,
	needs,
	count: total,
	saved = false,
	label,
	runningWord = "running",
}: {
	running: boolean | number;
	needs: number;
	count: number | null;
	saved?: boolean;
	label: string;
	runningWord?: string;
}) {
	const words = [
		running ? (typeof running === "number" ? `${running} ${runningWord}` : "something running") : null,
		needs > 0 ? `${needs} ${needs === 1 ? "needs" : "need"} you` : null,
		total !== null ? plural(total, "thing") : null,
		saved ? "saved settings only" : null,
	].filter(part => part !== null);
	return (
		<span className="ws-rail-badges">
			{running ? (
				<span className="ws-badge-running">
					<RingIcon size={12} className="ws-ring" />
					{typeof running === "number" ? <span className="ws-badge-number">{running}</span> : null}
				</span>
			) : null}
			{needs > 0 ? <span className="ws-badge-needs">{needs}</span> : null}
			{total !== null ? <span className="ws-badge-count">{total}</span> : null}
			{saved ? <span className="ws-badge-saved">saved</span> : null}
			<span className="visually-hidden">
				{words.length > 0 ? `, ${words.join(", ")}` : `, ${label} has nothing yet`}
			</span>
		</span>
	);
}

/** One row of a rail: a glyph, a name and its badges, leading to `route`. */
/** `before`: words for a screen reader ahead of the name; `children`, the row's actions beside it. */
export function RailLink({
	route,
	current,
	label,
	icon,
	badges,
	title,
	quiet = false,
	replace = false,
	before,
	children,
}: {
	route: Route;
	replace?: boolean;
	current: boolean;
	label: string;
	icon: ReactNode;
	badges: ReactNode;
	title?: string;
	quiet?: boolean;
	before?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<li className={`ws-rail-item${children ? " ws-rail-item-repo" : ""}${quiet ? " ws-rail-quiet" : ""}`}>
			<a
				className="ws-rail-row"
				data-rail-row=""
				aria-current={current ? "page" : undefined}
				title={title}
				{...linkProps(route, { replace })}
			>
				<span className="ws-rail-icon">{icon}</span>
				{before}
				<span className="ws-rail-name">{label}</span>
				{badges}
			</a>
			{children}
		</li>
	);
}

/** What a rail has chosen: everything, what is on no repository, or one repository. */
export type RailChoice = { kind: "everything" } | { kind: "none" } | { kind: "repository"; id: GithubId };

export interface RepoRailProps {
	rail: Rail;
	chosen: RailChoice;
	/** Where a row leads; `replace`, whether choosing one replaces the history entry (a filter) or adds one (a page). */
	to(choice: RailChoice): Route;
	replace?: boolean;
	/** Whether "No repository" stands under "Everything". */
	noRepository: boolean;
	/** What the ring's number counts, said to a screen reader. */
	runningWord?: string;
	/** A repository row's actions, shown on hover. */
	actions?: (repository: RailRepository, name: string) => ReactNode;
	/** Beside the search: the page's own controls (the Agents home's filters). */
	tools?: ReactNode;
	/** Said where no repository is left without a search (filters on), if anything. */
	empty?: string | null;
	search?: RefObject<HTMLInputElement | null>;
	onFold?: () => void;
}

/** The rail's body: its search, "Everything", "No repository", "Active now" and the owners' repositories. */
export function RepoRail({
	rail,
	chosen,
	to,
	replace = false,
	noRepository,
	runningWord,
	actions,
	tools,
	empty = null,
	search,
	onFold,
}: RepoRailProps) {
	const [query, setQuery] = useState("");
	const [foldedOwners, setFoldedOwners] = useState<ReadonlySet<string>>(() => loadFoldedOwners());
	const list = useRef<HTMLDivElement>(null);
	const groups = searchRail(rail.groups, query);
	const searching = query.trim() !== "";
	const active = searching ? [] : activeRepositories(rail.groups);
	const toggleOwner = (owner: string) => {
		const next = new Set(foldedOwners);
		if (next.has(owner)) next.delete(owner);
		else next.add(owner);
		setFoldedOwners(next);
		saveFoldedOwners(next);
	};
	const current = chosen.kind === "repository" ? String(chosen.id) : null;
	const first = groups[0]?.repositories[0] ?? null;
	const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			if (query !== "") setQuery("");
			else event.currentTarget.blur();
		} else if (event.key === "Enter" && first && searching) {
			event.preventDefault();
			navigate(to({ kind: "repository", id: first.id }), { replace });
		} else if (event.key === "ArrowDown") {
			event.preventDefault();
			list.current?.querySelector<HTMLElement>("[data-rail-row]")?.focus();
		}
	};
	const row = (repository: RailRepository, owned = false) => {
		const badge = railBadge(repository);
		const name = `${repository.owner ? `${repository.owner}/` : ""}${repository.name}`;
		return (
			<RailLink
				key={String(repository.id)}
				route={to({ kind: "repository", id: repository.id })}
				replace={replace}
				current={current === String(repository.id)}
				label={repository.name}
				title={name}
				quiet={!badge.running && badge.needs === 0}
				icon={<RepoTile name={repository.name} host={hostOfAddress(repository.id)} />}
				before={owned && repository.owner ? <span className="visually-hidden">{repository.owner}/</span> : null}
				badges={
					<Badges
						running={repository.running > 0 ? repository.running : false}
						needs={badge.needs}
						count={badge.count}
						saved={badge.saved}
						label={name}
						runningWord={runningWord}
					/>
				}
			>
				{actions ? <span className="ws-rail-actions">{actions(repository, name)}</span> : null}
			</RailLink>
		);
	};
	const totals = (kind: "everything" | "none", label: string, icon: ReactNode) => {
		const sum = rail[kind];
		return (
			<RailLink
				route={to({ kind })}
				replace={replace}
				current={chosen.kind === kind}
				label={label}
				icon={icon}
				badges={
					<Badges
						running={sum.running > 0 ? sum.running : false}
						needs={sum.needs}
						count={null}
						label={label}
						runningWord={runningWord}
					/>
				}
			/>
		);
	};
	return (
		<div className="ws-rail-body">
			<div className="ws-rail-top">
				<label className="ws-search">
					<SearchIcon size={13} />
					<span className="visually-hidden">Find a repository</span>
					<input
						ref={search}
						type="search"
						placeholder="Find a repository"
						value={query}
						onChange={event => setQuery(event.target.value)}
						onKeyDown={onSearchKey}
						autoComplete="off"
						spellCheck={false}
					/>
					{query === "" ? (
						<kbd className="ws-kbd" aria-hidden="true">
							/
						</kbd>
					) : null}
				</label>
				{tools}
				{onFold ? <RailFoldButton label="Repositories" onFold={onFold} /> : null}
			</div>
			<div className="ws-rail-list" ref={list} onKeyDown={event => moveFocus(event, list.current)}>
				{searching ? null : (
					<ul className="ws-rail-rows">
						{totals("everything", "Everything", <EverythingIcon />)}
						{noRepository ? totals("none", "No repository", <PlusIcon size={13} />) : null}
					</ul>
				)}
				{active.length > 0 ? (
					<section className="ws-rail-active" aria-label="Active now">
						<h3 className="ws-rail-label">
							<RingIcon size={11} className="ws-ring" />
							Active now
						</h3>
						<ul className="ws-rail-rows">{active.map(repository => row(repository, true))}</ul>
					</section>
				) : null}
				{groups.map(group => {
					// A search shows every match, folded owner or not; the chosen repository keeps its owner open.
					const shut =
						!searching &&
						group.owner !== "" &&
						foldedOwners.has(group.owner) &&
						!group.repositories.some(repository => current === String(repository.id));
					return (
						<section
							key={group.owner}
							className={`ws-rail-group${shut ? " ws-rail-group-shut" : ""}`}
							aria-label={group.owner || "Repositories"}
						>
							{group.owner ? (
								<h3 className="ws-rail-owner">
									<button
										type="button"
										className="ws-rail-owner-row"
										data-rail-row=""
										aria-expanded={!shut}
										onClick={() => toggleOwner(group.owner)}
										title={shut ? `Show ${group.owner}'s repositories` : `Fold ${group.owner}'s repositories`}
									>
										<ChevronDownIcon size={12} className="ws-rail-chevron" />
										<OwnerAvatar owner={group.owner} />
										<span className="ws-rail-owner-name">{group.owner}</span>
										<span className="ws-rail-owner-count">{group.repositories.length}</span>
									</button>
								</h3>
							) : null}
							{shut ? null : <ul className="ws-rail-rows">{group.repositories.map(repository => row(repository))}</ul>}
						</section>
					);
				})}
				{groups.length === 0 && searching ? (
					<p className="ws-rail-empty">No repository matches “{query.trim()}”.</p>
				) : null}
				{groups.length === 0 && !searching && empty ? <p className="ws-rail-empty">{empty}</p> : null}
			</div>
		</div>
	);
}
