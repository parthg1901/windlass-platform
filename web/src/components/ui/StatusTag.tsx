/**
 * A short state in words with a dot before it ("Connected", "Not connected", "Limited until 14:00"): one look for
 * every connection's state (Connections, the first-run setup, plan and key rows). `pill` tints it, for a state that
 * asks for attention beside another one.
 */
import type { ReactNode } from "react";

export type StatusTone = "good" | "warn" | "bad" | "off" | "quiet";

export function StatusTag({
	tone,
	pill = false,
	className,
	children,
}: {
	tone: StatusTone;
	pill?: boolean;
	className?: string;
	children: ReactNode;
}) {
	return (
		<span className={`ui-status ui-status-${tone}${pill ? " ui-status-pill" : ""}${className ? ` ${className}` : ""}`}>
			{tone === "quiet" ? null : <span className="ui-status-dot" aria-hidden="true" />}
			{children}
		</span>
	);
}

/** A line that says what is being waited for, with a slow pulse: a plan arriving from a terminal, a machine pairing. */
export function Waiting({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<p className={`ui-waiting${className ? ` ${className}` : ""}`} role="status">
			<span className="ui-waiting-dot" aria-hidden="true" />
			{children}
		</p>
	);
}
