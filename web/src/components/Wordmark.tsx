import { Drum, Mark } from "./Icons";

/**
 * The wordmark: "windlass" in Geist, the dot of its i drawn as the windlass drum in the accent. Where
 * the name is hidden (a narrow top bar) the tile mark stands in for it. Renders without the browser, so
 * the static landing uses it too.
 */
export function Wordmark({ size = "small" }: { size?: "small" | "large" }) {
	return (
		<span className={`wordmark wordmark-${size}`} role="img" aria-label="Windlass">
			<Mark size={size === "large" ? 40 : 22} className="wordmark-tile" />
			<span className="wordmark-name" aria-hidden="true">
				w
				<span className="wordmark-i">
					ı<Drum spoke={false} className="wordmark-drum" />
				</span>
				ndlass
			</span>
		</span>
	);
}
