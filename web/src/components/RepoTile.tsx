/**
 * A repository's tile: two letters of its name on the agent logos' neutral square, in a hue worked out
 * from the name, so the same repository has the same tile in the rail, the feed and the composer. An
 * owner's avatar: their GitHub picture, with the same monogram where it cannot be loaded.
 */
import { useState, type CSSProperties } from "react";
import { ProviderIcon } from "./ProviderIcon";

/** A hue from 0 to 359, the same for the same name. */
export function nameHue(name: string): number {
	let hash = 0;
	for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
	return hash % 360;
}

/** "wlp-test-c-main" → "WT", "harbor" → "Ha". */
export function monogram(name: string): string {
	const parts = name.split(/[-_.\s]+/).filter(part => part !== "");
	if (parts.length >= 2) return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
	const one = parts[0] ?? name;
	return one.slice(0, 1).toUpperCase() + one.slice(1, 2);
}

export function RepoTile({
	name,
	size = "md",
	host = "github",
}: {
	name: string;
	size?: "md" | "sm" | "xs";
	/** A repository on another host than GitHub wears that host's mark in its corner. */
	host?: "github" | "gitlab";
}) {
	return (
		<span
			className={`repo-tile repo-tile-${size}`}
			style={{ "--tile-hue": nameHue(name) } as CSSProperties}
			aria-hidden="true"
		>
			{monogram(name)}
			{host === "gitlab" ? (
				<span className="repo-tile-host">
					<ProviderIcon id="gitlab" tone="brand" size={9} />
				</span>
			) : null}
		</span>
	);
}

/** The host a repository address names: `gitlab:<id>` is GitLab's, a bare id GitHub's. */
export const hostOfAddress = (id: unknown): "github" | "gitlab" =>
	String(id).startsWith("gitlab:") ? "gitlab" : "github";

/** An owner's GitHub picture, round; their monogram where it does not load. */
export function OwnerAvatar({ owner }: { owner: string }) {
	const [failed, setFailed] = useState(false);
	if (failed || owner === "") return <RepoTile name={owner || "?"} size="sm" />;
	return (
		<img
			className="owner-avatar"
			src={`https://github.com/${encodeURIComponent(owner)}.png?size=40`}
			alt=""
			width={16}
			height={16}
			loading="lazy"
			referrerPolicy="no-referrer"
			onError={() => setFailed(true)}
		/>
	);
}
