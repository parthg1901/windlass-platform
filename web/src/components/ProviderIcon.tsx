/**
 * The marks of the code hosts and work sources Windlass connects to, keyed by the ids the source registry
 * (server/src/sources/types.ts) and the code hosts (`HostId`) use. Each path is the brand's own mark as Simple Icons
 * publishes it (https://simpleicons.org, v13.21.0, CC0-1.0), copied unchanged; each mark stays its owner's trademark
 * and is used only to name that service.
 *
 * Two looks. `tone="mono"` (the default) draws the mark in the current text colour, for rows, menus and meta lines
 * where colour would be noise. `tone="brand"` draws it in the brand's own colour, for the place a service is named
 * on its own (a Settings card): GitHub's mark is black or white only, so it follows the text colour; the others
 * take their colour from tokens.css (`--logo-*`), with a lighter brand shade where the darkest one is too dim on
 * the dark theme. Slack's mark keeps its four colours.
 *
 * Next to its name the mark is decoration and hidden from assistive technology; on its own (`label`), it is an
 * image with that name.
 */
import { Fragment } from "react";
import { bySource } from "../../../server/src/sources/registry.js";
import { SOURCE_IDS, type SourceId } from "../../../server/src/sources/types.js";

/** A work source; the code hosts (`HostId`) are sources too, so one id names GitHub the host and GitHub the issues. */
export type ProviderId = SourceId;

const PATHS: Record<Exclude<ProviderId, "slack">, string> = {
	github:
		"M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
	gitlab:
		"m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z",
	linear:
		"M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
	jira: "M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z",
};

/** Slack's mark, the Simple Icons path split into its four arms (two subpaths each), in Slack's own colours. */
const SLACK: Array<[colour: string, d: string]> = [
	[
		"#E01E5A",
		"M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z",
	],
	[
		"#36C5F0",
		"M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z",
	],
	[
		"#2EB67D",
		"M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z",
	],
	[
		"#ECB22E",
		"M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
	],
];

export const PROVIDER_NAMES: Record<ProviderId, string> = bySource(caps => caps.displayName);

export function ProviderIcon({
	id,
	size = 14,
	tone = "mono",
	label,
	className,
}: {
	id: ProviderId;
	size?: number;
	tone?: "mono" | "brand";
	/** Standing alone, the mark is an image with this name; next to its name, leave it out. */
	label?: string;
	className?: string;
}) {
	const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
	const classes = `provider-icon provider-icon-${id} provider-icon-${tone}${className ? ` ${className}` : ""}`;
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			focusable="false"
			className={classes}
			fill={tone === "brand" && id !== "github" ? `var(--logo-${id})` : "currentColor"}
			{...a11y}
		>
			{id === "slack" ? (
				SLACK.map(([colour, d]) => <path key={colour} d={d} fill={tone === "brand" ? colour : undefined} />)
			) : (
				<path d={PATHS[id]} />
			)}
		</svg>
	);
}

/** The id of a work source or code host the mark exists for; web and API filings have none. */
export function providerOf(source: string): ProviderId | null {
	return source in PROVIDER_NAMES ? (source as ProviderId) : null;
}

/** Every work source by name, each with its mark, as a sentence lists them: "GitHub, GitLab, Linear, Jira or Slack". */
export function SourceNames({ join = "and" }: { join?: "and" | "or" }) {
	return (
		<span className="source-names">
			{SOURCE_IDS.map((id, index) => (
				<Fragment key={id}>
					{index === 0 ? null : index === SOURCE_IDS.length - 1 ? ` ${join} ` : ", "}
					<span className="source-name">
						<ProviderIcon id={id} size={12} />
						{PROVIDER_NAMES[id]}
					</span>
				</Fragment>
			))}
		</span>
	);
}
