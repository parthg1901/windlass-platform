/** The shell: which screen the address asks for, behind the sign-in where it has to be. */
import { sessionTitle } from "@contract";
import { lazy, Suspense, useEffect, useState } from "react";
import { MissingPageLinks } from "./components/MissingPageLinks";
import { Mark } from "./components/Icons";
import { BackLink, PageTrail } from "./components/Nav";
import { TopBar } from "./components/TopBar";
import { repoAddress } from "../../server/src/codehost/ref.js";
import { accountTrail, factoryLabel, itemTrail, sectionOfPage } from "./lib/nav";
import {
	navigate,
	pageFrom,
	rememberAppPage,
	returnAfterSignIn,
	usePageLabel,
	useRoute,
	type Route,
} from "./lib/router";
import { useTheme } from "./lib/theme";
import { Factory } from "./screens/Factory";
import { Item, useItem } from "./screens/Item";
import { asking } from "./lib/items";
import { useItems, type ItemsState } from "./state/items";
import { Machines } from "./screens/Machines";
import { NewAgent } from "./screens/NewAgent";
import { Session, SessionCrumb, useSessionMachine } from "./screens/Session";
import { Connect } from "./screens/Connect";
import { Connections } from "./screens/Connections";
import { Settings } from "./screens/Settings";
import { Plans } from "./screens/Plans";
import { LinkCallback, SignIn } from "./screens/SignIn";
import { Usage } from "./screens/Usage";
import { Workspace, type Selection } from "./screens/Workspace";
import { LANDING_TITLE } from "./site/content";
import { useApp } from "./state/app";
import { useSession } from "./state/hooks";

/** The public docs, in their own chunk: the app reaches them when one of its links leads there without a page load. */
const DocsApp = lazy(() => import("./docs/Docs").then(module => ({ default: module.DocsApp })));

/** Whether the page is in a background tab. */
function useHidden(): boolean {
	const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
	useEffect(() => {
		const onChange = () => setHidden(document.hidden);
		document.addEventListener("visibilitychange", onChange);
		return () => document.removeEventListener("visibilitychange", onChange);
	}, []);
	return hidden;
}

/** What every signed-in page's bar is given: the theme, and the Factory's needs-you count, read once for the whole app. */
type Bar = { theme: ReturnType<typeof useTheme>[0]; onToggleTheme(): void; asking: number };

function SessionRoute({ sessionId, bar }: { sessionId: string; bar: Bar }) {
	const state = useSession(sessionId);
	const { platform } = useApp();
	// A work item's agent: its item, for the trail (its feature, for a subtask) and to say when it waits for an answer.
	const item = useItem(
		state.summary?.item?.id ?? "",
		Boolean(state.summary?.item) && Boolean(platform.info?.items),
	).view;
	// Read once for the bar and the session both: the machine an agent on one of the user's machines runs on.
	const machine = useSessionMachine(state.summary?.place);
	const hidden = useHidden();
	const waiting = state.summary?.status === "waiting";
	const title = state.summary ? sessionTitle(state.summary) : null;
	useEffect(() => {
		// A tab in the background says when its agent is waiting on the user.
		const mark = waiting && hidden ? "(?) Needs you · " : "";
		document.title = title ? `${mark}${title} · Windlass` : "Windlass";
	}, [title, waiting, hidden]);
	usePageLabel(title);
	// Its section is known once its summary is: a work item's agent is the Factory's.
	const section = state.summary ? sectionOfPage({ name: "session", id: sessionId }, Boolean(state.summary.item)) : null;
	return (
		<div className="app app-fixed">
			<TopBar {...bar} current={section}>
				<SessionCrumb
					title={state.summary?.title ?? null}
					status={state.summary?.status ?? null}
					place={state.summary?.place}
					machine={machine}
					item={state.summary?.item}
					harness={state.summary?.harness}
					summary={state.summary ?? null}
					itemView={item}
				/>
			</TopBar>
			<Session key={sessionId} sessionId={sessionId} state={state} machine={machine} item={item} />
		</div>
	);
}

/** A work item's page: the Factory's, with its trail from the Factory and the way back to where you came from. */
function ItemRoute({ itemId, bar }: { itemId: string; bar: Bar }) {
	const { platform } = useApp();
	// Asked once the deployment says it offers work items (without them the page is not found); until then it is loading, or says why it is not.
	const item = useItem(itemId, Boolean(platform.info?.items));
	const page =
		platform.info === null && platform.error ? { ...item, error: platform.error, reload: platform.reload } : item;
	const title = page.view?.title ?? null;
	const asks = Boolean(page.view?.question);
	useEffect(() => {
		document.title = title ? `${asks ? "(?) Needs you · " : ""}${title} · Windlass` : "Work item · Windlass";
	}, [title, asks]);
	usePageLabel(title);
	return (
		<div className="app">
			<TopBar {...bar} current="factory">
				<PageTrail trail={itemTrail(page.view)} />
			</TopBar>
			<Item page={page} />
		</div>
	);
}

/**
 * The Agents home: everything, the agents on no repository, or one repository, chosen in its rail. A
 * repository's every view, its saved settings too, is part of Agents.
 */
function WorkspaceRoute({ selection, items, bar }: { selection: Selection; items: ItemsState; bar: Bar }) {
	useEffect(() => {
		// A repository's side names itself in the title.
		if (selection.kind !== "repository")
			document.title = selection.kind === "none" ? "No repository · Agents · Windlass" : "Agents · Windlass";
	}, [selection.kind]);
	return (
		<div className="app app-workspace">
			<TopBar {...bar} current="agents" />
			<Workspace selection={selection} items={items} />
		</div>
	);
}

/** The Factory page, its repository filter chosen in its rail. */
function FactoryRoute({
	route,
	items,
	bar,
}: {
	route: Extract<Route, { name: "factory" }>;
	items: ItemsState;
	bar: Bar;
}) {
	useEffect(() => {
		document.title = `${bar.asking > 0 ? `(${bar.asking}) ` : ""}Factory · Windlass`;
	}, [bar.asking]);
	const repository =
		route.repository === undefined
			? null
			: (items.list?.find(item => String(repoAddress(item.repository)) === String(route.repository))?.repository.name ??
				null);
	usePageLabel(factoryLabel(repository));
	return (
		<div className="app app-workspace">
			<TopBar {...bar} current="factory" />
			<Factory filters={{ repository: route.repository, from: route.from }} items={items} />
		</div>
	);
}

export function App() {
	const route = useRoute();
	const { auth, platform } = useApp();
	const [theme, toggleTheme] = useTheme();
	// The user's work items, read once for every page: the bar's needs-you count on each, the Agents home and the Factory.
	const offered = Boolean(platform.info?.items);
	const items = useItems(offered && auth !== null);
	const bar: Bar = { theme, onToggleTheme: toggleTheme, asking: offered ? asking(items.list ?? []).length : 0 };

	useEffect(() => {
		if (route.name === "docs") return;
		rememberAppPage();
		window.addEventListener("pagehide", rememberAppPage);
		return () => window.removeEventListener("pagehide", rememberAppPage);
	}, [route]);

	// Home is the landing page for someone who is not signed in, so it is the one list that does not send them to sign in.
	const needsAuth =
		(route.name === "home" && route.scope === "none") ||
		route.name === "factory" ||
		route.name === "new" ||
		route.name === "usage" ||
		route.name === "settings" ||
		route.name === "plans" ||
		route.name === "machines" ||
		route.name === "connections" ||
		route.name === "session" ||
		route.name === "item" ||
		route.name === "repository" ||
		route.name === "connect";
	/** A deployment that does not offer machines has no such page. While its information loads, the page says it is loading. */
	const noMachines = route.name === "machines" && auth !== null && platform.info !== null && !platform.info.machines;
	/** Nor one that does not offer work items an item's page. */
	const noItems =
		(route.name === "item" || route.name === "factory") &&
		auth !== null &&
		platform.info !== null &&
		!platform.info.items;
	/** The repository chosen in the Agents home: its own address, or the address that once launched a new agent on it. */
	const repositoryId =
		route.name === "repository" ? route.id : route.name === "new" ? (route.repository ?? null) : null;
	useEffect(() => {
		if (!needsAuth || auth) return;
		// The connect page is opened by a terminal; after signing in, the visitor comes back to its code.
		if (route.name === "connect") returnAfterSignIn();
		navigate({ name: "signin" }, { replace: true });
	}, [needsAuth, auth, route.name]);

	useEffect(() => {
		if (route.name === "docs") return;
		if (
			(route.name !== "session" &&
				route.name !== "item" &&
				route.name !== "home" &&
				route.name !== "factory" &&
				repositoryId === null) ||
			noItems
		)
			document.title =
				route.name === "signin"
					? "Sign in · Windlass"
					: route.name === "notfound" || noMachines || noItems
						? "Not found · Windlass"
						: route.name === "usage"
							? "Usage · Windlass"
							: route.name === "settings"
								? "Settings · Windlass"
								: route.name === "connect"
									? "Connect · Windlass"
									: route.name === "plans"
										? "Plans · Windlass"
										: route.name === "machines"
											? "Machines · Windlass"
											: route.name === "connections"
												? "Connections · Windlass"
												: route.name === "new"
													? "New agent · Windlass"
													: "Agents · Windlass";
	}, [route.name, repositoryId, noMachines, noItems]);

	useEffect(() => {
		if (route.name === "home" && !auth) document.title = LANDING_TITLE;
	}, [route.name, auth]);

	// Open to everyone, signed in or not.
	if (route.name === "docs") {
		return (
			<Suspense fallback={null}>
				<DocsApp theme={theme} onToggleTheme={toggleTheme} />
			</Suspense>
		);
	}

	if (route.name === "notfound" || noMachines || noItems) {
		return (
			<div className="app">
				<TopBar {...bar} />
				<main className="state state-page">
					<Mark size={56} />
					<p className="eyebrow">404</p>
					<h1 className="display display-small">Nothing at this address</h1>
					<MissingPageLinks section={!auth ? "signin" : platform.info?.items ? "both" : "home"} />
				</main>
			</div>
		);
	}

	if (route.name === "home" && !auth) return <SignIn theme={theme} onToggleTheme={toggleTheme} />;

	if (route.name === "signin" || !auth) {
		// While the redirect above is on its way, the sign-in screen is the right thing to show.
		return auth ? <LinkCallback /> : <SignIn theme={theme} onToggleTheme={toggleTheme} />;
	}

	if (route.name === "connect")
		return <Connect code={route.code} plan={route.plan} kind={route.kind} theme={theme} onToggleTheme={toggleTheme} />;

	if (route.name === "session") return <SessionRoute key={route.id} sessionId={route.id} bar={bar} />;

	if (route.name === "item") return <ItemRoute key={route.id} itemId={route.id} bar={bar} />;

	if (repositoryId !== null)
		return (
			<WorkspaceRoute
				selection={{
					kind: "repository",
					id: repositoryId,
					view: route.name === "repository" ? route.view : undefined,
					launching: route.name === "new",
				}}
				items={items}
				bar={bar}
			/>
		);

	if (route.name === "home")
		return (
			<WorkspaceRoute
				selection={route.scope === "none" ? { kind: "none" } : { kind: "everything" }}
				items={items}
				bar={bar}
			/>
		);

	if (route.name === "usage") {
		return (
			<div className="app">
				<TopBar {...bar} current="account">
					<PageTrail trail={accountTrail("Usage")} />
				</TopBar>
				<Usage />
			</div>
		);
	}

	if (route.name === "machines") {
		return (
			<div className="app">
				<TopBar {...bar} current="machines" />
				<Machines adding={route.add === true} />
			</div>
		);
	}

	if (route.name === "connections") {
		return (
			<div className="app">
				<TopBar {...bar} current="connections" />
				<Connections />
			</div>
		);
	}

	if (route.name === "settings") {
		return (
			<div className="app">
				{/* A place of its own, with the way back to where you were when you came from somewhere. */}
				<TopBar {...bar} current="account">
					{pageFrom() ? (
						<nav className="crumb" aria-label="Where you are">
							<BackLink fallback={null} />
						</nav>
					) : null}
				</TopBar>
				<Settings />
			</div>
		);
	}

	if (route.name === "plans") {
		return (
			<div className="app">
				<TopBar {...bar} current="account">
					<PageTrail trail={accountTrail("Plans")} />
				</TopBar>
				<Plans />
			</div>
		);
	}

	if (route.name === "factory") return <FactoryRoute route={route} items={items} bar={bar} />;

	return (
		<div className="app">
			<TopBar {...bar} current="agents" />
			<NewAgent />
		</div>
	);
}
