/** Exercise the configured code host against GitHub's loopback stand-in, without constructing the adapter. */
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { GithubStandin } from "./github-standin.js";

const standin = new GithubStandin({ callbackUrl: "http://platform.invalid/github/callback" });
try {
	await standin.start();
	standin.appPermissions = { ...standin.appPermissions, checks: "read", statuses: "read", actions: "read" };
	const secret = randomBytes(32).toString("hex");
	Object.assign(process.env, standin.env(), { WLP_GITHUB_WEBHOOK_SECRET: secret });
	const { resolveCodeHost } = await import("../server/src/codehost/index.js");
	const host = resolveCodeHost();
	assert.ok(host, "the configured GitHub App resolves to a code host");

	const owner = "acme",
		name = "harbor";
	const installation = standin.addInstallation(owner, "Organization");
	const repo = standin.addRepository({ owner, name, private: true, installation, defaultBranch: "trunk" });
	const branch = "feature/docs";
	const head = standin.commit(repo, branch, { "guide.md": "# Guide\n" }, "Add a guide", repo.defaultBranch);
	const target = { owner, name, repositoryId: repo.id, installationId: installation.id, head };
	repo.ci.set(head, { runs: [], statuses: [{ context: "docs/build", state: "success" }] });
	const ci = await host.readCi(target);
	assert.equal(ci.kind, "read");
	assert.equal(ci.head, head);
	assert.deepEqual(
		ci.runs.map(run => [run.name, run.state]),
		[["docs/build", "passed"]],
	);
	console.log("ok  read normalized CI results for the pull head");

	// Sign a JSON integer outside the safe range: parsing it as a JS number loses the repository identity.
	const bytes = Buffer.from(
		`{ "installation":{"id":${installation.id}}, "repository":{"id":9007199254740993}, "sha":"${head}", "state":"success" }\n`,
	);
	const guid = randomUUID();
	const headers = new Headers({
		"content-type": "application/json",
		"x-github-delivery": guid,
		"x-github-event": "status",
		"x-github-hook-installation-target-id": standin.appId,
		"x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(bytes).digest("hex"),
	});
	const delivery = host.parseWebhook(headers, bytes);
	assert.equal(delivery?.event, "status");
	assert.equal(delivery.guid, guid);
	assert.equal(delivery.repositoryId, "9007199254740993");
	assert.deepEqual(delivery.data, { head });
	assert.throws(() => host.parseWebhook(headers, Buffer.concat([bytes, Buffer.from(" ")])));
	headers.set("x-github-event", "ping");
	assert.equal(host.parseWebhook(headers, bytes), null);
	console.log("ok  authenticated the original bytes and normalized only supported deliveries");

	const input = { title: "Add a guide", body: "Documents the setup.", head: branch, base: repo.defaultBranch };
	const pull = await host.withToken(target, "pull:write", token => host.openPull(token, owner, name, input));
	assert.equal(standin.pulls.length, 1);
	assert.equal(pull.number, standin.pulls[0].number);
	assert.equal(pull.state, "open");
	assert.equal(pull.head, branch);
	assert.equal(pull.base, repo.defaultBranch);
	console.log("ok  opened the pull against the requested branches");
} finally {
	await standin.stop();
}
