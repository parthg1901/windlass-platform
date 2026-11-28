/** Run from server with npx tsx --test src/sources/registry.test.ts. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { INTAKE_SOURCES } from "../actors/issue-intake.js";
import { issueMode } from "../factory/intake.js";
import { thirdParty, untrustedWords } from "../factory/untrusted.js";
import { isTriggerLabel } from "../linear/webhook.js";
import { bySource, filterWord, sourceCaps, sourceNames } from "./registry.js";
import { SOURCE_IDS } from "./types.js";

test("the source list is the five work sources, in their order", () => {
	assert.deepEqual(SOURCE_IDS, ["github", "gitlab", "linear", "jira", "slack"]);
	assert.deepEqual([...INTAKE_SOURCES], ["github", "gitlab", "linear", "jira", "slack"]);
});

test("the web's source words come out as before", () => {
	assert.deepEqual(
		bySource(caps => caps.displayName),
		{ github: "GitHub", gitlab: "GitLab", linear: "Linear", jira: "Jira", slack: "Slack" },
	);
	assert.deepEqual(bySource(filterWord), {
		github: "GitHub issue",
		gitlab: "GitLab issue",
		linear: "Linear issue",
		jira: "Jira issue",
		slack: "Slack",
	});
	assert.equal(sourceNames(), "GitHub, GitLab, Linear, Jira and Slack");
});

test("someone else's filing is named as before, and is third-party", () => {
	const words = [
		untrustedWords.source("github", "#12", "octo"),
		untrustedWords.source("gitlab", "#7"),
		untrustedWords.source("linear", "ENG-12", "Mallory Smith"),
		untrustedWords.source("jira", "PROJ_X-7", "Ada"),
		untrustedWords.source("slack"),
		untrustedWords.gitlabNote("99"),
	];
	assert.deepEqual(words, [
		"issue #12 by @octo",
		"GitLab issue #7",
		"Linear issue ENG-12 by Mallory Smith",
		"Jira issue PROJ_X-7 by Ada",
		"a Slack request",
		"GitLab note 99",
	]);
	assert.deepEqual(thirdParty([...words, " a Slack request ", "GitHub feedback from @a", "CI logs of abc1234"]), [
		...words,
		"GitHub feedback from @a",
	]);
	assert.deepEqual(thirdParty(["a Slack request, really", "GitLab issue #7 by x", "Linear issue ENG by x"]), []);
});

test("Quick labels come from each source's record", () => {
	assert.deepEqual(sourceCaps("linear").quickLabels, ["windlass:quick", "windlass-quick"]);
	assert.deepEqual(sourceCaps("github").quickLabels, ["windlass:quick"]);
	assert.equal(issueMode("", ["windlass:quick"]).mode, "single");
	assert.equal(issueMode("", ["windlass-quick"]).mode, "orchestrate");
	assert.ok(isTriggerLabel(" Windlass-Quick "));
	assert.ok(isTriggerLabel("windlass"));
	assert.ok(!isTriggerLabel("windlass:orchestrate"));
});
