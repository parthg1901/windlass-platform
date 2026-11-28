/**
 * Where a page belongs and how it is reached. Every page lives in one section of the app, decided by
 * what it shows, never by its path: a work item and the agents that work on it (`summary.item`) are
 * the Factory's; the user's own agents and their repositories are Agents'; machines are Machines'; what pays
 * for the agents is Connections'; usage, settings and plans are the account's, under the Settings tab.
 *
 * A page further in has a fixed trail that starts with its section ("Factory › tide-tables › Fix the
 * timezone"), and the header's back control returns to where you came from (lib/router.ts `useBack`),
 * falling back to the trail's parent on a direct visit.
 */
import { itemSessionRole, type SessionSummary, type SessionRepository } from "@contract";
import type { RepositoryPaneView, Route } from "./router";
import { repoAddress } from "../../../server/src/codehost/ref.js";

export type Section = "agents" | "factory" | "machines" | "connections" | "account";

/** Each section's name, as its tab says it: the account's tab is Settings. */
export const SECTION_NAME: Record<Section, string> = {
	agents: "Agents",
	factory: "Factory",
	machines: "Machines",
	connections: "Connections",
	account: "Settings",
};

/** Each section's own page, the one its tab opens. */
export const SECTION_ROUTE: Record<Section, Route> = {
	agents: { name: "home" },
	factory: { name: "factory" },
	machines: { name: "machines" },
	connections: { name: "connections" },
	account: { name: "settings" },
};

/** The section a page belongs to. A session's is its item's when it works on one (`itemSession`). */
export function sectionOfPage(route: Route, itemSession = false): Section | null {
	switch (route.name) {
		case "home":
		case "new":
		case "repository":
			return "agents";
		case "factory":
		case "item":
			return "factory";
		case "session":
			return itemSession ? "factory" : "agents";
		case "machines":
			return "machines";
		case "connections":
			return "connections";
		case "usage":
		case "settings":
		case "plans":
			return "account";
		default:
			return null;
	}
}

/** One step of a trail. `route`: where it leads (the last, the page itself, has none); `back`: what the back control says when it leads there. */
export interface Crumb {
	label: string;
	route?: Route;
	back?: string;
}

const VIEW_NAME: Record<RepositoryPaneView, string> = {
	agents: "Agents",
	items: "Work items",
	pulls: "Pull requests",
	settings: "Saved settings",
};

/** What a page is called where nothing more is known of it: the back control's words for it. */
export function routeLabel(route: Route): string {
	switch (route.name) {
		case "home":
			return route.scope === "none" ? "No repository" : "Agents";
		case "repository":
			return route.view ? VIEW_NAME[route.view] : "Repository";
		case "new":
			return "New agent";
		case "factory":
			return "Factory";
		case "item":
			return "Work item";
		case "session":
			return "Agent";
		case "usage":
			return "Usage";
		case "settings":
			return "Settings";
		case "plans":
			return "Plans";
		case "machines":
			return "Machines";
		case "connections":
			return "Connections";
		case "docs":
			return "Docs";
		default:
			return "Back";
	}
}

/** A repository chosen in the Agents home, as the back control names it: "tide-tables · Work items". */
export function repositoryLabel(name: string, view?: RepositoryPaneView): string {
	return view ? `${name} · ${VIEW_NAME[view]}` : name;
}

/** The Factory, filtered to one repository or not. */
export function factoryLabel(repository?: string | null): string {
	return repository ? `Factory · ${repository}` : "Factory";
}

type Repo = Pick<SessionRepository, "id" | "name"> & Partial<Pick<SessionRepository, "provider" | "instance">>;
type ItemLike = { title: string; repository: Repo; parent?: { itemId: string; title: string } | null };

function factoryCrumbs(repository: Repo | null | undefined): Crumb[] {
	return [
		{ label: "Factory", route: { name: "factory" } },
		...(repository
			? [
					{
						label: repository.name,
						route: { name: "factory", repository: repoAddress(repository) } as Route,
						back: factoryLabel(repository.name),
					},
				]
			: []),
	];
}

/** A work item's trail: Factory › its repository (the Factory filtered to it) › its feature, for a subtask › the item. */
export function itemTrail(view: ItemLike | null): Crumb[] {
	return [
		...factoryCrumbs(view?.repository),
		...(view?.parent ? [{ label: view.parent.title, route: { name: "item", id: view.parent.itemId } as Route }] : []),
		{ label: view?.title ?? "Work item" },
	];
}

/**
 * A session's trail. A work item's agent is the Factory's: the item's trail, the item linked, then the
 * role (Builder, Code review or Plan review). The user's own: Agents › its repository › its title.
 */
export function sessionTrail(
	session: { title: string | null; repository?: Repo | null; item?: SessionSummary["item"] },
	itemView: ItemLike | null,
): Crumb[] {
	if (session.item) {
		const item = itemTrail(
			itemView ?? (session.repository ? { title: "Work item", repository: session.repository } : null),
		);
		const own = item.pop()!;
		return [
			...item,
			{ label: itemView?.title ?? session.title ?? own.label, route: { name: "item", id: session.item.id } },
			{ label: itemSessionRole(session.item) },
		];
	}
	const repository = session.repository ?? null;
	return [
		{ label: "Agents", route: { name: "home" } },
		...(repository ? [{ label: repository.name, route: { name: "repository", id: repository.id } as Route }] : []),
		{ label: session.title ?? "Agent" },
	];
}

/** An account page's trail: Settings › Usage. */
export function accountTrail(name: string): Crumb[] {
	return [{ label: "Settings", route: { name: "settings" } }, { label: name }];
}

/** Where the back control leads on a direct visit: the nearest step of the trail before the page that leads somewhere. */
export function trailParent(trail: readonly Crumb[]): { route: Route; label: string } | null {
	for (let at = trail.length - 2; at >= 0; at--) {
		const crumb = trail[at]!;
		if (crumb.route) return { route: crumb.route, label: crumb.back ?? crumb.label };
	}
	return null;
}
