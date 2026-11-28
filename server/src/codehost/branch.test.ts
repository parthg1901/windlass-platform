/** Run from server with npx tsx --test src/codehost/branch.test.ts. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { branchFor, branchWords, freeBranch, wantedBranch } from "./branch.js";

test("a title becomes whole words of a branch name", () => {
	assert.equal(branchWords("Run the whole test suite and fix the flaky ones"), "run-the-whole-test-suite-and-fix-the");
	assert.equal(branchWords("Café: déjà vu!"), "cafe-deja-vu");
	assert.equal(branchWords("x".repeat(50)), "x".repeat(40));
	assert.equal(wantedBranch("Add CSV export"), "windlass/add-csv-export");
	assert.equal(wantedBranch(" … "), "windlass/agent");
});

test("the first name the host does not have is taken, numbered from -2", async () => {
	const asked: string[] = [];
	const taken = new Set(["windlass/add-csv-export", "windlass/add-csv-export-2"]);
	const name = await freeBranch("Add CSV export", async branch => {
		asked.push(branch);
		return taken.has(branch);
	});
	assert.equal(name, "windlass/add-csv-export-3");
	assert.deepEqual(asked, ["windlass/add-csv-export", "windlass/add-csv-export-2", "windlass/add-csv-export-3"]);
	assert.equal(await freeBranch("Add CSV export", async () => false), "windlass/add-csv-export");
});

test("numbering stops after twenty names, and the host's refusal is not taken for a free name", async () => {
	await assert.rejects(
		freeBranch("Busy", async () => true),
		/windlass\/busy and 19 more/,
	);
	await assert.rejects(
		freeBranch("Busy", async () => {
			throw new Error("refused");
		}),
		/refused/,
	);
});

test("a work item's agent keeps the title with the end of the session's id", () => {
	assert.equal(
		branchFor("Fix the failing add test…", "s_0123456789abcdef"),
		"windlass/fix-the-failing-add-test-abcdef",
	);
	assert.equal(branchFor("  ", "s_ffff000011112222"), "windlass/agent-112222");
});
