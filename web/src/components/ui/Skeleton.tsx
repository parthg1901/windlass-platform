/**
 * Shapes that stand in for what is loading, shimmering (still under reduced motion). Each is drawn the size of what
 * replaces it, so nothing moves when the content arrives. `Loading` is the one wrapper that tells assistive tech
 * that a part of the page is loading; styles in styles/ui.css and styles/base.css.
 */
import type { CSSProperties, ReactNode } from "react";

export function Skeleton({
	width,
	height = 12,
	radius,
	className,
	style,
}: {
	width?: number | string;
	height?: number | string;
	radius?: number | string;
	className?: string;
	style?: CSSProperties;
}) {
	return (
		<span
			className={`skeleton ui-skeleton${className ? ` ${className}` : ""}`}
			aria-hidden="true"
			style={{ width, height, borderRadius: radius, ...style }}
		/>
	);
}

/** Lines of text that are loading: each a little shorter than the one before. */
export function SkeletonText({ lines = 2, width = 100 }: { lines?: number; width?: number }) {
	return (
		<span className="ui-skeleton-text" aria-hidden="true">
			{Array.from({ length: lines }, (_, line) => (
				<Skeleton key={line} width={`${Math.max(30, width - line * 18)}%`} />
			))}
		</span>
	);
}

/** A part of the page that is loading: its skeleton (a title and two lines unless given), announced once by its label. */
export function Loading({ label, className, children }: { label: string; className?: string; children?: ReactNode }) {
	return (
		<div className={`ui-loading${className ? ` ${className}` : ""}`} role="status" aria-busy="true" aria-label={label}>
			{children ?? <SkeletonLines />}
		</div>
	);
}

/** A block of text that is loading: an optional title, then lines at the given widths (percent). */
export function SkeletonLines({ title = true, lines = [100, 58] }: { title?: boolean; lines?: number[] }) {
	return (
		<>
			{title ? <span className="skeleton skeleton-title" aria-hidden="true" style={{ width: "34%" }} /> : null}
			{lines.map((width, line) => (
				<span key={line} className="skeleton skeleton-meta" aria-hidden="true" style={{ width: `${width}%` }} />
			))}
		</>
	);
}

/**
 * A list that is loading, drawn as the rows it will show. "kept": a heading, then a title, chips and a line of facts
 * per row, and the row's action at its end (machines, saved things). "agent": the agent list's rows, a dot, a title
 * and a line of facts.
 */
export function SkeletonRows({
	label,
	rows = 2,
	chips = 0,
	action = true,
	heading = true,
	variant = "kept",
	className,
}: {
	label: string;
	rows?: number;
	chips?: number;
	action?: boolean;
	heading?: boolean;
	variant?: "kept" | "agent";
	className?: string;
}) {
	if (variant === "agent") {
		return (
			<ul
				className={`agents agents-loading${className ? ` ${className}` : ""}`}
				role="status"
				aria-busy="true"
				aria-label={label}
			>
				{Array.from({ length: rows }, (_, row) => (
					<li key={row} className="agent-row agent-row-skeleton" aria-hidden="true">
						<span className="skeleton skeleton-dot" />
						<div className="agent-main">
							<span className="skeleton skeleton-title" style={{ width: `${46 - row * 7}%` }} />
							<span className="skeleton skeleton-meta" style={{ width: `${62 - row * 5}%` }} />
						</div>
					</li>
				))}
			</ul>
		);
	}
	return (
		<div className={className} role="status" aria-busy="true" aria-label={label}>
			{heading ? <span className="skeleton skeleton-heading" aria-hidden="true" /> : null}
			<ul className="skeleton-list" aria-hidden="true">
				{Array.from({ length: rows }, (_, row) => (
					<li key={row} className="skeleton-row">
						<div>
							<span className="skeleton skeleton-title" style={{ width: `${24 - row * 5}%` }} />
							{Array.from({ length: chips }, (_, chip) => (
								<span key={chip} className="skeleton skeleton-chip" />
							))}
							<span className="skeleton-break" />
							<span className="skeleton skeleton-meta" style={{ width: `${52 - row * 9}%` }} />
						</div>
						{action ? <span className="skeleton skeleton-pill" /> : null}
					</li>
				))}
			</ul>
		</div>
	);
}

/** A form field that is loading: its label, then its control at a field's height. */
export function SkeletonField({ className }: { className?: string }) {
	return (
		<span className={`skeleton-field${className ? ` ${className}` : ""}`} aria-hidden="true">
			<span className="skeleton skeleton-field-label" />
			<span className="skeleton skeleton-field-control" />
		</span>
	);
}

/** A badge (a connection state, a count) that is loading. */
export function SkeletonBadge() {
	return <span className="skeleton skeleton-badge" aria-hidden="true" />;
}

/** A button that is loading, the height of a small or a regular button. */
export function SkeletonButton({ size = "sm" }: { size?: "sm" | "md" }) {
	return (
		<span className={`skeleton skeleton-button${size === "md" ? " skeleton-button-md" : ""}`} aria-hidden="true" />
	);
}
