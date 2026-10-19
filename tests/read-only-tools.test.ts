import { describe, expect, it } from "vitest";

import { REVIEW_READ_ONLY_TOOL_NAMES, selectReviewReadOnlyTools } from "../src/policy/read-only-tools.ts";

describe("selectReviewReadOnlyTools", () => {
	it("keeps exactly the visible read-only tools in preference order", () => {
		expect(selectReviewReadOnlyTools(["glob", "bash", "read", "grep", "write"])).toEqual([
			"read",
			"grep",
			"glob",
		]);
	});

	it("drops remote (MCP) file tools: they address another namespace", () => {
		expect(
			selectReviewReadOnlyTools(["mcp__winggate__read", "mcp__winggate__grep", "mcp__winggate__glob"]),
		).toEqual([]);
	});

	it("ignores a name that only contains a read-only name as a suffix", () => {
		expect(selectReviewReadOnlyTools(["thread", "grep2", "globber"])).toEqual([]);
	});

	it("returns an empty list for an empty surface", () => {
		expect(selectReviewReadOnlyTools([])).toEqual([]);
		// Nothing is invented for a caller that offered only one usable name.
		const selected = selectReviewReadOnlyTools(["read"]);
		expect(selected).toEqual(["read"]);
		expect(selected.every((name) => (REVIEW_READ_ONLY_TOOL_NAMES as readonly string[]).includes(name))).toBe(true);
	});
});
