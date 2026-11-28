import { describe, expect, it } from "vitest";
import { hostWords, requestNumber, sentenceCase } from "./host";

describe("a repository's host in words", () => {
	it("names each host and its request from the host records", () => {
		expect(hostWords("github")).toEqual({ name: "GitHub", noun: "pull request", short: "PR", mark: "#" });
		expect(hostWords("gitlab")).toEqual({ name: "GitLab", noun: "merge request", short: "MR", mark: "!" });
		// Rows written before GitLab have no provider.
		expect(hostWords(undefined).name).toBe("GitHub");
	});

	it("writes a request's number with its host's mark", () => {
		expect(requestNumber("github", 12)).toBe("#12");
		expect(requestNumber("gitlab", 14)).toBe("!14");
		expect(sentenceCase(hostWords("gitlab").noun)).toBe("Merge request");
	});
});
