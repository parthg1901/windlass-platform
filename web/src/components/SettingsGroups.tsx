import { useEffect, useState, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { useHash } from "../lib/router";
import { WarnIcon } from "./Icons";

interface GroupProps {
	id: string;
	title: string;
	lede?: ReactNode;
	children: ReactNode;
}

export function SettingsGroup({ id, title, lede, children }: GroupProps) {
	return (
		<section className="settings-group" id={id} aria-labelledby={`${id}-title`}>
			<h2 id={`${id}-title`}>{title}</h2>
			{lede && <p>{lede}</p>}
			<div className="usage-card settings-card">{children}</div>
		</section>
	);
}

export function SettingsLayout({ label, children }: { label: string; children: (ReactElement<GroupProps> | null)[] }) {
	const groups = children.filter(group => group !== null);
	const ids = groups.map(group => group.props.id).join(" ");
	const [current, setCurrent] = useState(groups[0]?.props.id);
	// A link from elsewhere (the account menu) names a section in the address: it opens there.
	const hash = useHash();
	useEffect(() => {
		// OAuth return fragments belong to the connection panel, not to section navigation.
		if (/^#(?:gitlab|linear)(?:-error)?=/.test(hash)) return;
		const node = hash.length > 1 ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
		if (node?.closest(".settings-frame")) node.scrollIntoView({ block: "start" });
	}, [hash]);
	useEffect(() => {
		if (typeof IntersectionObserver === "undefined") return;
		const order = ids.split(" ");
		const shown = new Set<string>();
		const observer = new IntersectionObserver(
			entries => {
				for (const entry of entries) {
					if (entry.isIntersecting) shown.add(entry.target.id);
					else shown.delete(entry.target.id);
				}
				const first = order.find(id => shown.has(id));
				if (first) setCurrent(first);
			},
			{ rootMargin: "-20% 0px -60% 0px" },
		);
		for (const id of order) {
			const node = document.getElementById(id);
			if (node) observer.observe(node);
		}
		return () => observer.disconnect();
	}, [ids]);

	function go(event: MouseEvent<HTMLAnchorElement>, id: string) {
		const node = document.getElementById(id);
		if (!node || event.metaKey || event.ctrlKey || event.shiftKey) return;
		event.preventDefault();
		const still = matchMedia?.("(prefers-reduced-motion: reduce)").matches;
		node.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
		history.replaceState(history.state, "", `#${id}`);
		setCurrent(id);
	}

	return (
		<div className="settings-frame">
			<div className="settings-layout">
				<nav className="settings-nav" aria-label={label}>
					{groups.map(({ props: { id, title } }) => (
						<a key={id} href={`#${id}`} aria-current={current === id || undefined} onClick={event => go(event, id)}>
							{title}
						</a>
					))}
				</nav>
				<div>{children}</div>
			</div>
		</div>
	);
}

export function SettingsRefreshError({ error, reload }: { error: string; reload(): void }) {
	return (
		<p className="callout callout-warn" role="status">
			<WarnIcon />
			<span>
				{error}{" "}
				<button className="link" onClick={reload}>
					Try again
				</button>
			</span>
		</p>
	);
}

export function SettingsPending({ subject, error, reload }: { subject: string; error: string | null; reload(): void }) {
	return (
		<section className="usage-section">
			{error ? (
				<div className="state state-error" role="alert">
					<WarnIcon size={22} />
					<h3>{subject} could not be loaded</h3>
					<p>{error}</p>
					<button type="button" className="button button-outline" onClick={reload}>
						Try again
					</button>
				</div>
			) : (
				<div className="usage-loading" aria-busy="true" aria-label={`Loading ${subject.toLowerCase()}`}>
					<span className="skeleton skeleton-title" style={{ width: "34%" }} />
					<span className="skeleton skeleton-meta" style={{ width: "100%" }} />
					<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
				</div>
			)}
		</section>
	);
}

export function SettingsSection({
	id,
	title,
	count,
	children,
}: {
	id: string;
	title: string;
	count?: number;
	children: ReactNode;
}) {
	return (
		<section className="usage-section repo-saved" aria-labelledby={id}>
			<h3 className="usage-title" id={id}>
				{title}
				{count ? <span className="usage-count">{count}</span> : null}
			</h3>
			{children}
		</section>
	);
}
