/**
 * Where you are, in the bar of a page further in: the back control, a labelled way back to where you
 * came from, then the page's fixed trail from its section ("Factory › tide-tables › Fix the timezone").
 * On a phone, where the tabs have no room, the section's name opens them as a menu.
 */
import type { ReactNode } from "react";
import { SECTION_NAME, SECTION_ROUTE, trailParent, type Crumb, type Section } from "../lib/nav";
import { linkProps, navigate, useBack } from "../lib/router";
import { useApp } from "../state/app";
import { ArrowLeftIcon, ChevronDownIcon } from "./Icons";
import { Menu, type MenuSpec } from "./ui";

/** The way back, named for where it leads. */
export function BackLink({ fallback }: { fallback: ReturnType<typeof trailParent> }) {
	const back = useBack(fallback);
	if (!back) return null;
	return (
		<a className="crumb-back nav-back" href={back.href} onClick={back.onClick} title={`Back to ${back.label}`}>
			<ArrowLeftIcon size={14} />
			<span className="nav-back-label">{back.label}</span>
		</a>
	);
}

/**
 * The back control and the trail. The last crumb is the page itself: its heading where `heading` (the
 * page has none of its own), else marked as the current page. `children` follow it (a session's state).
 */
export function PageTrail({
	trail,
	heading = false,
	children,
}: {
	trail: readonly Crumb[];
	heading?: boolean;
	children?: ReactNode;
}) {
	const last = trail[trail.length - 1];
	const Title = heading ? "h1" : "span";
	return (
		<nav className="crumb" aria-label="Where you are">
			<BackLink fallback={trailParent(trail)} />
			<ol className={heading ? "trail trail-heading" : "trail"}>
				{trail.slice(0, -1).map((crumb, at) => (
					<li key={at} className={at === 0 ? "trail-step trail-section" : "trail-step"}>
						{crumb.route ? (
							<a className="trail-link" {...linkProps(crumb.route)} title={crumb.label}>
								{crumb.label}
							</a>
						) : (
							<span className="trail-link">{crumb.label}</span>
						)}
						<span className="trail-sep" aria-hidden="true">
							{heading && crumb.route?.name === "item" && at === trail.length - 2 ? "·" : "›"}
						</span>
					</li>
				))}
				{last ? (
					<li className="trail-step trail-here">
						<Title className="crumb-title" aria-current="page" title={last.label}>
							{last.label}
						</Title>
					</li>
				) : null}
			</ol>
			{children}
		</nav>
	);
}

/** The section you are in, on a phone's page further in: it opens the app's places, the one you are in checked. */
export function SectionMenu({ current, asking = 0 }: { current: Section | null; asking?: number }) {
	const { platform } = useApp();
	const sections: Section[] = [
		"agents",
		...(platform.info?.items ? ["factory" as const] : []),
		...(platform.info?.machines ? ["machines" as const] : []),
		"connections",
		"account",
	];
	const spec: MenuSpec = {
		label: "Go to",
		width: 220,
		hints: false,
		groups: [
			{
				id: "sections",
				items: sections.map(section => ({
					id: section,
					label: SECTION_NAME[section],
					checked: section === current,
					trailing:
						section === "factory" && asking > 0 ? <span className="topbar-tab-count">{asking}</span> : undefined,
					onSelect: () => navigate(SECTION_ROUTE[section]),
				})),
			},
		],
	};
	return (
		<span className="topbar-section">
			<Menu
				spec={spec}
				trigger={props => (
					<button
						type="button"
						className="topbar-section-button"
						{...props}
						aria-label={`${current ? SECTION_NAME[current] : "Places"}: go to another place`}
					>
						<span>{current ? SECTION_NAME[current] : "Places"}</span>
						{asking > 0 ? (
							<span
								className="topbar-tab-count"
								title={`${asking} ${asking === 1 ? "needs" : "need"} you in the Factory`}
							>
								{asking}
							</span>
						) : null}
						<ChevronDownIcon size={12} />
					</button>
				)}
			/>
		</span>
	);
}
