/** Run from server with npx tsx --test src/codehost/ref.test.ts. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionRepository } from "../contract.js";
import { itemFeed, itemPage, cleanItemPage } from "../item-pages.js";
import { setupProjectKey } from "../setup-command.js";
import { hostCaps } from "./capabilities.js";
import { keyOf, readRepoAddress, readRepoKey, repoAddress, repoKey, repoRef } from "./ref.js";
import type { ItemSummary } from "../contract.js";

const github: SessionRepository = {
	provider: "github",
	id: 7101,
	owner: "acme",
	name: "harbor",
	branch: "main",
	private: true,
	url: "https://github.com/acme/harbor",
};
const gitlab: SessionRepository = {
	...github,
	provider: "gitlab",
	owner: "acme/tools",
	url: "https://gitlab.com/acme/tools/harbor",
};

test("keys keep the forms stored rows already have", () => {
	assert.equal(keyOf(github), "github:7101");
	assert.equal(keyOf(gitlab), "gitlab:7101");
	// A row written before GitLab has no provider.
	assert.equal(keyOf({ id: 7101 }), "github:7101");
	assert.equal(keyOf({ ...github, id: "92233720368547758" }), "github:92233720368547758");
	assert.deepEqual(repoRef(gitlab), {
		host: "gitlab",
		instance: null,
		id: "7101",
		path: "acme/tools/harbor",
		branch: "main",
	});
});

test("a repository on another instance has the instance in its key", () => {
	const ref = { host: "gitlab" as const, instance: "https://GitLab.example.com:8443/gitlab/", id: "12" };
	assert.equal(repoKey(ref), "gitlab:gitlab.example.com:8443/gitlab:12");
	// Nothing writes an instance yet, so no caller or row may name one.
	assert.equal(readRepoKey(repoKey(ref)), null);
	assert.equal(keyOf({ ...gitlab, instance: ref.instance }), "gitlab:gitlab.example.com:8443/gitlab:7101");
	assert.equal(repoAddress({ ...github, instance: "https://ghe.example.com" }), "github:ghe.example.com:7101");
});

test("old keys read as the one form", () => {
	assert.equal(readRepoKey(7101), "github:7101");
	assert.equal(readRepoKey("github:7101"), "github:7101");
	assert.equal(readRepoKey("gitlab:7101"), "gitlab:7101");
	for (const bad of ["7101", "gitlab:0", "gitlab:9223372036854775808", "bitbucket:1", "", null, undefined, 0, 1.5])
		assert.equal(readRepoKey(bad), null, String(bad));
	assert.equal(setupProjectKey(7101), "github:7101");
	assert.equal(setupProjectKey("gitlab:7101"), "gitlab:7101");
	assert.equal(setupProjectKey("7101"), null);
	for (const bad of ["github:x:1", "gitlab:a b/../c:12", `gitlab:${"x".repeat(10_000)}:1`, "github:7101:"])
		assert.equal(setupProjectKey(bad), null, bad.slice(0, 40));
});

test("addresses keep GitHub's bare id and give other hosts their key", () => {
	assert.equal(repoAddress(github), 7101);
	assert.equal(repoAddress(gitlab), "gitlab:7101");
	assert.equal(readRepoAddress("7101"), 7101);
	assert.equal(readRepoAddress("github:7101"), 7101);
	assert.equal(readRepoAddress("gitlab:7101"), "gitlab:7101");
	assert.equal(readRepoAddress("x"), null);
});

test("pages and counts tell a GitLab project from a GitHub repository of the same id", () => {
	const item = (id: string, repository: SessionRepository) =>
		({ id, createdAt: Number(id.slice(1)), state: "done", source: "web", repository }) as ItemSummary;
	const list = [item("i1", github), item("i2", gitlab)];
	const page = (repository: unknown) => itemPage(list, cleanItemPage({ repository })!).map(one => one.id);
	assert.deepEqual(page(7101), ["i1"]);
	assert.deepEqual(page("gitlab:7101"), ["i2"]);
	assert.throws(() => cleanItemPage({ repository: "7101" }));
	assert.deepEqual(
		itemFeed(list).counts.byRepository.map(row => [row.repository, row.done]),
		[
			["gitlab:7101", 1],
			[7101, 1],
		],
	);
});

test("each host has its capability record; a row with no provider is GitHub's", () => {
	assert.equal(hostCaps(undefined), hostCaps("github"));
	assert.equal(hostCaps("github").actsAs, "app-bot");
	assert.equal(hostCaps("gitlab").actsAs, "user");
	assert.equal(hostCaps("gitlab").verdict, "none");
});
