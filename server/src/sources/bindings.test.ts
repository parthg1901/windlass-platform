/** Run from server with npx tsx --test src/sources/bindings.test.ts. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitlabBinding, IssueBinding, JiraBinding, LinearBinding, SlackBinding } from "../factory/intake.js";
import { submissionOf } from "../submissions.js";
import {
	bindingTo,
	bindingsOf,
	filingNote,
	issueBindingOf,
	originOf,
	submissionIdentity,
	untrustedOf,
	type StoredBindings,
} from "./bindings.js";
import type { SourceBinding } from "./types.js";

// One `meta` per stored shape, as items keep them today.
const github: IssueBinding = {
	modeReason: "Quick was requested. One implementer runs without a plan.",
	triggerLabel: "windlass",
	reactionTarget: "issue:12",
	origin: {
		issue: { number: 12, url: "https://github.com/o/r/issues/12", author: "mallory", trusted: false },
		sender: "ada",
	},
	installationId: 77,
	issueId: "I_kw12",
	senderId: 501,
	generation: 2,
	triggeredAt: 1_700_000_000_000,
	contentDigest: "sha256:abc",
};
/** An older GitHub item: no mode reason, label or reaction, string ids, written by its sender. */
const githubOld: IssueBinding = {
	origin: { issue: { number: 3, url: "https://github.com/o/r/issues/3", author: "ada", trusted: true }, sender: "ada" },
	installationId: "78",
	issueId: "I_kw3",
	senderId: "502",
	generation: 1,
	triggeredAt: 1_600_000_000_000,
	contentDigest: "sha256:def",
};
const linear: LinearBinding = {
	origin: {
		linear: {
			id: "lin-issue-1",
			identifier: "ENG-12",
			url: "https://linear.app/a/issue/ENG-12",
			author: "Mallory Smith",
			trusted: false,
		},
		sender: "Ada Lovelace",
	},
	workspaceId: "ws-1",
	teamId: "team-1",
	generation: 1,
	via: "label",
	triggeredAt: 1_700_000_000_001,
	senderId: "lin-user-2",
	modeReason: null,
};
const jira: JiraBinding = {
	origin: {
		jira: {
			id: "10001",
			identifier: "PROJ-7",
			url: "https://site.atlassian.net/browse/PROJ-7",
			author: "Ada",
			trusted: false,
		},
		sender: "Ada",
	},
	siteId: "cloud-1",
	projectId: "10000",
	generation: 3,
	via: "assignment",
	triggeredAt: 1_700_000_000_002,
	senderId: "acct-1",
	modeReason: "This is a Jira bug, so it runs in Quick mode without a plan.",
};
const slack: SlackBinding = { teamId: "T1", channelId: "C1", threadTs: "1712345.000100", generation: "gen-4" };
const gitlab: GitlabBinding = {
	project: {
		provider: "gitlab",
		id: "9",
		owner: "g",
		name: "p",
		branch: "main",
		private: true,
		url: "https://gitlab.example/g/p",
	} as GitlabBinding["project"],
	iid: "5",
	generation: 1,
	sources: ["GitLab issue #5"],
};

/** What `summaryOf` sent before the bindings: the first legacy field with an origin. */
const legacyOrigin = (meta: StoredBindings) => meta.github?.origin ?? meta.linear?.origin ?? meta.jira?.origin ?? null;

test("each stored shape reads as one origin binding", () => {
	const expected: Record<string, SourceBinding> = {
		github: {
			ref: {
				source: "github",
				tenant: "77",
				scope: null,
				id: "I_kw12",
				display: "#12",
				url: "https://github.com/o/r/issues/12",
			},
			role: "origin",
			generation: 2,
			mappingGeneration: null,
			origin: { author: "mallory", sender: "ada", trusted: false },
			trigger: { via: null, at: 1_700_000_000_000, senderId: "501" },
			modeReason: "Quick was requested. One implementer runs without a plan.",
			extra: {
				installationId: 77,
				senderId: 501,
				number: 12,
				contentDigest: "sha256:abc",
				triggerLabel: "windlass",
				reactionTarget: "issue:12",
			},
		},
		linear: {
			ref: {
				source: "linear",
				tenant: "ws-1",
				scope: "team-1",
				id: "lin-issue-1",
				display: "ENG-12",
				url: "https://linear.app/a/issue/ENG-12",
			},
			role: "origin",
			generation: 1,
			mappingGeneration: null,
			origin: { author: "Mallory Smith", sender: "Ada Lovelace", trusted: false },
			trigger: { via: "label", at: 1_700_000_000_001, senderId: "lin-user-2" },
			modeReason: null,
		},
		jira: {
			ref: {
				source: "jira",
				tenant: "cloud-1",
				scope: "10000",
				id: "10001",
				display: "PROJ-7",
				url: "https://site.atlassian.net/browse/PROJ-7",
			},
			role: "origin",
			generation: 3,
			mappingGeneration: null,
			origin: { author: "Ada", sender: "Ada", trusted: false },
			trigger: { via: "assignment", at: 1_700_000_000_002, senderId: "acct-1" },
			modeReason: "This is a Jira bug, so it runs in Quick mode without a plan.",
		},
		slack: {
			ref: { source: "slack", tenant: "T1", scope: "C1", id: "1712345.000100", display: "", url: null },
			role: "origin",
			generation: "message",
			mappingGeneration: "gen-4",
			origin: { author: "", sender: "", trusted: false },
			trigger: null,
		},
		gitlab: {
			ref: { source: "gitlab", tenant: "9", scope: null, id: "5", display: "#5", url: null },
			role: "origin",
			generation: 1,
			mappingGeneration: null,
			origin: { author: "", sender: "", trusted: false },
			trigger: null,
			extra: { projectId: "9" },
		},
	};
	assert.deepEqual(bindingsOf({ github }), [expected.github]);
	assert.deepEqual(bindingsOf({ linear }), [expected.linear]);
	assert.deepEqual(bindingsOf({ jira }), [expected.jira]);
	assert.deepEqual(bindingsOf({ slack }), [expected.slack]);
	assert.deepEqual(bindingsOf({ gitlab }), [expected.gitlab]);
	assert.deepEqual(bindingsOf({}), []);
	assert.deepEqual(bindingsOf({ bindings: [expected.jira], github }), [expected.jira]);
	assert.deepEqual(bindingsOf({ slack: { ...slack, threadTs: null } })[0]?.ref.id, "");
});

test("ItemSummary.origin is unchanged for every shape", () => {
	for (const meta of [{ github }, { github: githubOld }, { linear }, { jira }, { slack }, {}] as StoredBindings[])
		assert.deepEqual(originOf(meta), legacyOrigin(meta));
});

test("a GitHub binding reads back as the issue binding it came from", () => {
	assert.deepEqual(issueBindingOf(bindingTo({ github }, "github")!), github);
	assert.deepEqual(issueBindingOf(bindingTo({ github: githubOld }, "github")!), githubOld);
});

test("the first log line is the same", () => {
	const note = (meta: StoredBindings) => filingNote(bindingsOf(meta)[0]!);
	assert.equal(note({ github }), "Filed from GitHub issue #12, written by @mallory. Filed by @ada.");
	assert.equal(note({ github: githubOld }), "Filed from GitHub issue #3, written and filed by @ada.");
	assert.equal(note({ linear }), "Filed from Linear issue ENG-12, written by Mallory Smith. Filed by Ada Lovelace.");
	assert.equal(note({ jira }), "Filed from Jira issue PROJ-7, written and filed by Ada.");
	assert.equal(note({ slack }), "Filed from Slack.");
});

test("the first log line leaves out names the source keeps none of", () => {
	const [binding] = bindingsOf({ gitlab });
	assert.equal(filingNote(binding!), "Filed from GitLab issue #5.");
	assert.equal(
		filingNote({ ...binding!, origin: { ...binding!.origin, sender: "ada" } }),
		"Filed from GitLab issue #5. Filed by @ada.",
	);
	assert.equal(
		filingNote({ ...binding!, origin: { ...binding!.origin, author: "mallory" } }),
		"Filed from GitLab issue #5, written by @mallory.",
	);
});

test("someone else's filing is the same untrusted source", () => {
	const outside = (meta: StoredBindings) => bindingsOf(meta).flatMap(untrustedOf);
	assert.deepEqual(outside({ github }), ["issue #12 by @mallory"]);
	assert.deepEqual(outside({ github: githubOld }), []);
	assert.deepEqual(outside({ linear }), ["Linear issue ENG-12 by Mallory Smith"]);
	assert.deepEqual(
		outside({
			linear: { ...linear, origin: { ...linear.origin, linear: { ...linear.origin.linear, trusted: true } } },
		}),
		[],
	);
	assert.deepEqual(outside({ jira }), ["Jira issue PROJ-7 by Ada"]);
	assert.deepEqual(outside({ slack }), ["a Slack request"]);
});

test("a filing's submission identity hashes as before", () => {
	const asked = { title: "Fix it", body: "", acceptance: [] };
	const sent = (identity: unknown) => submissionOf("k", identity)!.sent;
	const identity = (meta: StoredBindings) => submissionIdentity(bindingsOf(meta)[0]!, asked, "slack-key");
	assert.equal(sent(identity({ slack })), sent({ slack: "slack-key" }));
	assert.equal(sent(identity({ gitlab })), sent({ gitlab: gitlab.project.id, iid: "5", generation: 1 }));
	assert.equal(sent(identity({ linear })), sent({ linear: "lin-issue-1", generation: 1 }));
	assert.equal(sent(identity({ jira })), sent({ jira: "10001", siteId: "cloud-1", generation: 3 }));
	assert.equal(sent(identity({ github })), sent({ asked, github }));
	assert.equal(sent(identity({ github: githubOld })), sent({ asked, github: githubOld }));
});
