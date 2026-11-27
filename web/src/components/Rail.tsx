/**
 * The rail beside a page's main side, one for the Agents home and the Factory: a search at its top (`/`
 * reaches it from anywhere on the page), "Everything", "No repository" where it means something, then
 * the repositories by activity (lib/workspace.ts `railSections`): Pinned, Active now, Recent, and the
 * rest by owner with the quiet ones folded into one row (which this browser remembers). A row shows its
 * state, not a tile: the turning drum while something runs, an amber dot when something asks. The
 * hosted time is at its foot. Only what a row counts and where it leads are each page's own: the
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
	loadOpenQuiet,
	loadPinned,
	loadRailFolded,
	railBadge,
	railSections,
	saveOpenQuiet,
	savePinned,
	saveRailFolded,
	searchRail,
	togglePin,
	type Rail,
	type RailRepository,
} from "../lib/workspace";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, Mark, PlusIcon, RingIcon, SearchIcon } from "./Icons";
import { ProviderIcon } from "./ProviderIcon";
import { hostOfAddress } from "./RepoTile";

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
 * its page offers its own way. Without a rail (null), the main side has the whole width.
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
	rail: ReactNode | null;
	folded: boolean;
	phone: boolean;
	onUnfold(): void;
	children: ReactNode;
}) {
	// One shape with or without the rail, so the main side is not mounted again when it goes.
	const bare = rail === null;
	return (
		<div className={`ws${bare ? " ws-bare" : folded && !phone ? " ws-folded" : ""}`}>
			{phone || bare ? null : (
				<nav className="ws-rail" aria-label={label} inert={folded}>
					<div className="ws-rail-inner">{rail}</div>
				</nav>
			)}
			<div className="ws-main">
				{folded && !phone && !bare ? (
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
	const rows = [...list.querySelectorAll<HTMLElement>("[data-rail-row]")].filter(row => !row.closest("[inert]"));
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

/** A pin, for the row action that keeps a repository at the rail's top. */
function PinIcon({ filled }: { filled: boolean }) {
	return (
		<svg
			width={14}
			height={14}
			viewBox="0 0 16 16"
			fill={filled ? "currentColor" : "none"}
			stroke="currentColor"
			strokeWidth={1.5}
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6Z" />
		</svg>
	);
}

/** What a repository row shows in place of a tile: the drum turning while something runs, amber when something asks, a faint dot otherwise. */
function RepoState({ repository }: { repository: Pick<RailRepository, "running" | "needs"> }) {
	if (repository.running > 0) return <Mark size={14} turning className="ws-state-running" />;
	return <span className={`ws-state-dot${repository.needs > 0 ? " ws-state-needs" : ""}`} aria-hidden="true" />;
}

/** The rail's body: its search, "Everything", "No repository", then the repositories by activity. */
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
	const [pinned, setPinned] = useState<string[]>(() => loadPinned());
	const [openQuiet, setOpenQuiet] = useState<ReadonlySet<string>>(() => loadOpenQuiet());
	const list = useRef<HTMLDivElement>(null);
	const groups = searchRail(rail.groups, query);
	const searching = query.trim() !== "";
	const current = chosen.kind === "repository" ? String(chosen.id) : null;
	const sections = railSections(rail.groups, { pinned, now: Date.now(), keep: current });
	const pin = (id: string) => {
		const next = togglePin(pinned, id);
		setPinned(next);
		savePinned(next);
	};
	const toggleQuiet = (owner: string) => {
		const next = new Set(openQuiet);
		if (next.has(owner)) next.delete(owner);
		else next.add(owner);
		setOpenQuiet(next);
		saveOpenQuiet(next);
	};
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
	/** `owned`: the row stands outside its owner's section, so the owner shows before its name. */
	const row = (repository: RailRepository, owned = false) => {
		const badge = railBadge(repository);
		const name = `${repository.owner ? `${repository.owner}/` : ""}${repository.name}`;
		const id = String(repository.id);
		const isPinned = pinned.includes(id);
		return (
			<RailLink
				key={id}
				route={to({ kind: "repository", id: repository.id })}
				replace={replace}
				current={current === id}
				label={repository.name}
				title={name}
				quiet={!badge.running && badge.needs === 0}
				icon={<RepoState repository={repository} />}
				before={
					<>
						{hostOfAddress(repository.id) === "gitlab" ? (
							<ProviderIcon id="gitlab" size={11} className="ws-rail-host" label="GitLab" />
						) : null}
						{owned && repository.owner ? <span className="ws-rail-owner-prefix">{repository.owner}/</span> : null}
					</>
				}
				badges={
					<Badges
						running={false}
						needs={badge.needs}
						count={badge.count}
						saved={badge.saved}
						label={name}
						runningWord={runningWord}
					/>
				}
			>
				<span className="ws-rail-actions">
					<button
						type="button"
						className={`ws-rail-action${isPinned ? " ws-rail-action-on" : ""}`}
						onClick={() => pin(id)}
						aria-pressed={isPinned}
						aria-label={isPinned ? `Unpin ${name}` : `Pin ${name} to the top`}
						title={isPinned ? "Unpin" : "Pin to the top"}
					>
						<PinIcon filled={isPinned} />
					</button>
					{actions ? actions(repository, name) : null}
				</span>
			</RailLink>
		);
	};
	const section = (label: string, repositories: RailRepository[], owned: boolean) =>
		repositories.length === 0 ? null : (
			<section className="ws-rail-group" aria-label={label}>
				<h3 className="ws-rail-label">{label}</h3>
				<ul className="ws-rail-rows">{repositories.map(repository => row(repository, owned))}</ul>
			</section>
		);
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
				{searching ? (
					groups.map(group => (
						<section key={group.owner} className="ws-rail-group" aria-label={group.owner || "Repositories"}>
							{group.owner ? <h3 className="ws-rail-label ws-rail-owner-name">{group.owner}</h3> : null}
							<ul className="ws-rail-rows">{group.repositories.map(repository => row(repository))}</ul>
						</section>
					))
				) : (
					<>
						{section("Pinned", sections.pinned, true)}
						{section("Active now", sections.active, true)}
						{section("Recent", sections.recent, true)}
						{sections.owners.map(group => {
							const open = openQuiet.has(group.owner);
							const label = group.owner || "Repositories";
							return (
								<section key={group.owner} className="ws-rail-group" aria-label={label}>
									<h3 className="ws-rail-label ws-rail-owner-name">{label}</h3>
									<ul className="ws-rail-rows">
										{group.shown.map(repository => row(repository))}
										{open ? group.quiet.map(repository => row(repository)) : null}
										{group.quiet.length > 0 ? (
											<li className="ws-rail-item">
												<button
													type="button"
													className="ws-rail-row ws-rail-more"
													data-rail-row=""
													aria-expanded={open}
													onClick={() => toggleQuiet(group.owner)}
												>
													<span className="ws-rail-icon">
														<ChevronDownIcon size={12} className="ws-rail-chevron" />
													</span>
													<span className="ws-rail-name">
														{open ? "Fold the quiet ones" : `${group.quiet.length} quiet`}
													</span>
												</button>
											</li>
										) : null}
									</ul>
								</section>
							);
						})}
					</>
				)}
				{groups.length === 0 && searching ? (
					<p className="ws-rail-empty">No repository matches “{query.trim()}”.</p>
				) : null}
				{groups.length === 0 && !searching && empty ? <p className="ws-rail-empty">{empty}</p> : null}
			</div>
		</div>
	);
}
