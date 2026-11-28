/**
 * What a part of the page shows when it could not be loaded. The section form takes the place of the content: a
 * heading naming what failed, why, and a way to try again. The inline form sits above content that is still shown
 * (from before), or inside a card: the reason and the way to try again on one line.
 */
import type { ReactNode } from "react";
import { WarnIcon } from "../Icons";

export function LoadError({
	subject,
	error,
	reload,
	inline = false,
	stale = false,
	level = 3,
	children,
}: {
	/** What could not be loaded, as the start of a sentence: "Your settings", "The list of agents". */
	subject?: string;
	error: ReactNode;
	reload?: () => void;
	inline?: boolean;
	/** Inline, above what was read before and is still shown: said politely rather than as an alert. */
	stale?: boolean;
	/** The heading's level: 2 where the error takes the place of a whole page's content, under its h1. */
	level?: 2 | 3;
	/** Replaces the default heading and reason, for a failure with its own words. */
	children?: ReactNode;
}) {
	if (inline) {
		return (
			<p className="callout callout-warn" role={stale ? "status" : "alert"}>
				<WarnIcon />
				<span>
					{children ?? error}
					{reload ? (
						<>
							{" "}
							<button type="button" className="link" onClick={reload}>
								Try again
							</button>
						</>
					) : null}
				</span>
			</p>
		);
	}
	return (
		<div className="state state-error" role="alert">
			<WarnIcon size={22} />
			{children ?? (
				<>
					{subject ? (
						level === 2 ? (
							<h2>{subject} could not be loaded</h2>
						) : (
							<h3>{subject} could not be loaded</h3>
						)
					) : null}
					<p>{error}</p>
				</>
			)}
			{reload ? (
				<button type="button" className="button button-outline" onClick={reload}>
					Try again
				</button>
			) : null}
		</div>
	);
}
