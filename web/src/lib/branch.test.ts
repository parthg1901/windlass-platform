import { describe, expect, it } from "vitest";
import { branchLabel } from "./branch";

describe("branchLabel", () => {
	it("says a feature's branches by what they are, not by their ids", () => {
		expect(branchLabel("windlass/feature-i_41aa720d15fc0021")).toBe("feature branch");
		expect(branchLabel("windlass/feature-i_41aa720d15fc0021-writer-i_6524be01aa")).toBe("part's branch");
	});

	it("keeps every other branch's own name", () => {
		expect(branchLabel("windlass/add-csv-export")).toBe("windlass/add-csv-export");
		expect(branchLabel("windlass/repo-setup-20261126")).toBe("windlass/repo-setup-20261126");
		expect(branchLabel("main")).toBe("main");
	});
});
