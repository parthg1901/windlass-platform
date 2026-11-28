/**
 * Where a work item came from, as rows, cards and the item page say it: the source's mark and what names the
 * request there. An issue links to itself ("issue #42", "ENG-123", "REL-42"); a Slack request or a GitLab issue
 * without a link says its source; an item filed through the API says so; one filed here on the web says nothing,
 * that being the usual case.
 */
import type { ItemOrigin, ItemSource } from "@contract";
import { originIssue } from "../lib/origin";
import { ExternalIcon } from "./Icons";
import { PROVIDER_NAMES, ProviderIcon, providerOf } from "./ProviderIcon";

export function ItemSourceTag({
	source,
	origin,
	links = true,
}: {
	source: ItemSource;
	origin: ItemOrigin | null | undefined;
	/** Off where the tag sits inside another link (a board card's title is one; its meta line is not). */
	links?: boolean;
}) {
	if (origin) {
		const issue = originIssue(origin);
		const label = issue.provider === "github" ? `issue ${issue.label}` : issue.label;
		const inner = (
			<>
				<ProviderIcon id={issue.provider} size={11} />
				{label}
			</>
		);
		return links ? (
			<a
				className="item-pull item-source item-source-link"
				href={issue.url}
				target="_blank"
				rel="noreferrer"
				aria-label={`Issue ${issue.label} on ${issue.tracker}`}
				title={`Filed from ${issue.tracker} issue ${issue.label}`}
			>
				{inner}
				<ExternalIcon size={9} />
			</a>
		) : (
			<span className="item-source" title={`Filed from ${issue.tracker} issue ${issue.label}`}>
				{inner}
			</span>
		);
	}
	const provider = providerOf(source);
	if (provider) {
		const name = PROVIDER_NAMES[provider];
		return (
			<span className="item-source" title={`Filed from ${name}`}>
				<ProviderIcon id={provider} size={11} />
				<span className="visually-hidden">from </span>
				{provider === "slack" ? name : `${name} issue`}
			</span>
		);
	}
	if (source === "api") return <span className="item-source">from the API</span>;
	return null;
}
