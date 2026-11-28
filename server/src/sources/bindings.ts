/**
 * An item's bindings to its work sources, read one way for every source. Items store them as `meta.bindings`, or
 * (every item so far) as one field per source, which `legacyBindings` reads as the same list. Nothing here writes.
 */

import type { ItemOrigin } from "../contract.js";
import {
	filedFrom,
	type GitlabBinding,
	type IssueBinding,
	type JiraBinding,
	type LinearBinding,
	type SlackBinding,
} from "../factory/intake.js";
import { untrustedWords } from "../factory/untrusted.js";
import { sourceCaps } from "./registry.js";
import type { BindingOf, SourceBinding, SourceId } from "./types.js";

/** Where an item's (or a filing's) bindings are stored: the list, or a field per source. */
export interface StoredBindings {
	bindings?: SourceBinding[];
	github?: IssueBinding;
	gitlab?: GitlabBinding;
	linear?: LinearBinding;
	jira?: JiraBinding;
	slack?: SlackBinding;
}

export const bindingsOf = (meta: StoredBindings): SourceBinding[] => meta.bindings ?? legacyBindings(meta);

/** A Linear or Jira binding as `legacyBindings` reads it. */
type Tracker = (LinearBinding | JiraBinding) & {
	tenant: string;
	scope: string;
	issue: { id: string; identifier: string; url: string; author: string; trusted: boolean };
};

/** The bindings a field per source stands for, losing nothing a reader needs. */
export function legacyBindings(meta: StoredBindings): SourceBinding[] {
	const list: SourceBinding[] = [];
	const { github, gitlab, linear, jira, slack } = meta;
	if (github) {
		const { issue, sender } = github.origin;
		list.push({
			ref: {
				source: "github",
				tenant: String(github.installationId),
				scope: null,
				id: github.issueId,
				display: `#${issue.number}`,
				url: issue.url,
			},
			role: "origin",
			generation: github.generation,
			mappingGeneration: null,
			origin: { author: issue.author, sender, trusted: issue.trusted },
			trigger: { via: null, at: github.triggeredAt, senderId: String(github.senderId) },
			...("modeReason" in github && { modeReason: github.modeReason }),
			extra: {
				installationId: github.installationId,
				senderId: github.senderId,
				number: issue.number,
				contentDigest: github.contentDigest,
				...(github.triggerLabel !== undefined && { triggerLabel: github.triggerLabel }),
				...(github.reactionTarget !== undefined && { reactionTarget: github.reactionTarget }),
			},
		});
	}
	if (gitlab)
		list.push({
			ref: {
				source: "gitlab",
				tenant: String(gitlab.project.id),
				scope: null,
				id: gitlab.iid,
				display: `#${gitlab.iid}`,
				url: null,
			},
			role: "origin",
			generation: gitlab.generation,
			mappingGeneration: null,
			origin: { author: "", sender: "", trusted: false },
			trigger: null,
			extra: { projectId: gitlab.project.id },
		});
	const tracker = (t: Tracker) => ({
		ref: { tenant: t.tenant, scope: t.scope, id: t.issue.id, display: t.issue.identifier, url: t.issue.url },
		role: "origin" as const,
		generation: t.generation,
		mappingGeneration: null,
		origin: { author: t.issue.author, sender: t.origin.sender, trusted: t.issue.trusted },
		trigger: { via: t.via, at: t.triggeredAt, senderId: t.senderId },
		...("modeReason" in t && { modeReason: t.modeReason }),
	});
	if (linear) {
		const binding = tracker({
			...linear,
			tenant: linear.workspaceId,
			scope: linear.teamId,
			issue: linear.origin.linear,
		});
		list.push({ ...binding, ref: { source: "linear", ...binding.ref } });
	}
	if (jira) {
		const binding = tracker({ ...jira, tenant: jira.siteId, scope: jira.projectId, issue: jira.origin.jira });
		list.push({ ...binding, ref: { source: "jira", ...binding.ref } });
	}
	if (slack)
		list.push({
			ref: {
				source: "slack",
				tenant: slack.teamId,
				scope: slack.channelId,
				id: slack.threadTs ?? "",
				display: "",
				url: null,
			},
			role: "origin",
			generation: "message",
			mappingGeneration: slack.generation,
			origin: { author: "", sender: "", trusted: false },
			trigger: null,
		});
	return list;
}

/** The binding an item was filed from, if any. */
export const originBinding = (meta: StoredBindings) => bindingsOf(meta).find(binding => binding.role === "origin");

/** Whether `binding` is `source`'s, which makes its `extra` that source's. */
export const isFrom = <S extends SourceId>(binding: SourceBinding, source: S): binding is BindingOf<S> =>
	binding.ref.source === source;

/** The binding to `source`, which an effect of that source posts through. */
export const bindingTo = <S extends SourceId>(meta: StoredBindings, source: S) =>
	bindingsOf(meta).find((binding): binding is BindingOf<S> => isFrom(binding, source));

/** A GitHub issue's binding as the issue code takes it. */
export function issueBindingOf(binding: BindingOf<"github">): IssueBinding {
	const { extra } = binding;
	return {
		...(binding.modeReason !== undefined && { modeReason: binding.modeReason }),
		...(extra.triggerLabel !== undefined && { triggerLabel: extra.triggerLabel }),
		...(extra.reactionTarget !== undefined && { reactionTarget: extra.reactionTarget }),
		origin: githubOrigin(binding),
		installationId: extra.installationId,
		issueId: binding.ref.id,
		senderId: extra.senderId,
		generation: binding.generation as number,
		triggeredAt: binding.trigger?.at ?? 0,
		contentDigest: extra.contentDigest,
	};
}

const githubOrigin = (binding: BindingOf<"github">) => ({
	issue: {
		number: binding.extra.number,
		url: binding.ref.url ?? "",
		author: binding.origin.author,
		trusted: binding.origin.trusted,
	},
	sender: binding.origin.sender,
});

const tracker = (binding: SourceBinding) => ({
	id: binding.ref.id,
	identifier: binding.ref.display,
	url: binding.ref.url ?? "",
	author: binding.origin.author,
});

/** What each source keeps of its wire forms until items carry `bindings`: the page's origin and a filing's submission identity. */
const LEGACY: {
	[S in SourceId]: {
		origin(binding: BindingOf<S>): ItemOrigin | null;
		identity(binding: BindingOf<S>, asked: unknown, key: unknown): unknown;
	};
} = {
	github: {
		origin: githubOrigin,
		identity: (binding, asked) => ({ asked, github: issueBindingOf(binding) }),
	},
	gitlab: {
		origin: () => null,
		identity: binding => ({ gitlab: binding.extra.projectId, iid: binding.ref.id, generation: binding.generation }),
	},
	linear: {
		origin: binding => ({
			linear: { ...tracker(binding), trusted: binding.origin.trusted },
			sender: binding.origin.sender,
		}),
		identity: binding => ({ linear: binding.ref.id, generation: binding.generation }),
	},
	jira: {
		origin: binding => ({ jira: { ...tracker(binding), trusted: false }, sender: binding.origin.sender }),
		identity: binding => ({ jira: binding.ref.id, siteId: binding.ref.tenant, generation: binding.generation }),
	},
	slack: {
		origin: () => null,
		identity: (_binding, _asked, key) => ({ slack: key }),
	},
};

/** The issue an item was filed from, as `ItemSummary.origin` has always carried it. */
export function originOf(meta: StoredBindings): ItemOrigin | null {
	const binding = originBinding(meta);
	return binding ? legacyOrigin(binding.ref.source, binding) : null;
}

const legacyOrigin = <S extends SourceId>(source: S, binding: BindingOf<S>) => LEGACY[source].origin(binding);

/** What a repeated filing must match to be the same filing (`submissionOf`): the source's own key, never the issue text. */
export function submissionIdentity(binding: SourceBinding, asked: unknown, key: unknown): unknown {
	return legacyIdentity(binding.ref.source, binding, asked, key);
}

const legacyIdentity = <S extends SourceId>(source: S, binding: BindingOf<S>, asked: unknown, key: unknown) =>
	LEGACY[source].identity(binding, asked, key);

/** The item's first log line about where it came from. A name the source keeps none of (GitLab's) is left out. */
export function filingNote(binding: SourceBinding): string {
	const caps = sourceCaps(binding.ref.source);
	if (caps.noun === "message") return `Filed from ${caps.displayName}.`;
	const what = `${caps.displayName} ${caps.noun} ${binding.ref.display}`;
	const author = binding.origin.author && caps.handle + binding.origin.author,
		sender = binding.origin.sender && caps.handle + binding.origin.sender;
	if (author && sender) return filedFrom(what, author, sender);
	if (author) return `Filed from ${what}, written by ${author}.`;
	return sender ? `Filed from ${what}. Filed by ${sender}.` : `Filed from ${what}.`;
}

/** The binding's filing as an untrusted source of the item's text, when it is someone else's. */
export const untrustedOf = (binding: SourceBinding): string[] =>
	binding.origin.trusted ? [] : [untrustedWords.source(binding.ref.source, binding.ref.display, binding.origin.author)];
