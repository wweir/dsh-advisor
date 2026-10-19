import { describe, expect, it } from "vitest";

import type { AdvisorConfig } from "../src/policy/config.ts";
import { estimateTokens } from "../src/policy/redaction.ts";
import {
	EVIDENCE_CLOSE,
	EVIDENCE_OPEN,
	REVIEW_INSTRUCTIONS,
	TRUNCATION_MARKER,
	UNREVIEWED_MARKER,
	boundProjection,
	composeReviewPrompt,
	markUnreviewedWork,
} from "../src/host/prompt.ts";

const WORK_SEPARATOR = EVIDENCE_OPEN;

function config(maxContextTokens: number, instructions = ""): AdvisorConfig {
	return {
		enabled: false,
		instructions,
		review: {
			everyTurns: 1,
			timeoutMs: 180_000,
			maxContextTokens,
			maxAdviceChars: 2_000,
			maxPending: 32,
		},
		delivery: { activeIdleSeverities: ["concern"] },
		security: { additionalProtectedPaths: [] },
	};
}

/** Deterministic line-oriented transcript: each line names its own evidence. */
function transcript(lineCount: number): string {
	return Array.from(
		{ length: lineCount },
		(_, index) => `[tool result] step ${index}: ${"evidence ".repeat(4)}`,
	).join("\n");
}

function linesOf(text: string): string[] {
	return text.split("\n");
}

describe("boundProjection", () => {
	it("returns the input unchanged when it already fits", () => {
		const text = "[assistant] done\n[tool result] 42 passed";
		expect(boundProjection(text, 1_000)).toBe(text);
	});

	it("leaves a marker and returns text within the token budget", () => {
		const text = transcript(20);
		const bounded = boundProjection(text, 50);

		expect(bounded.startsWith(TRUNCATION_MARKER)).toBe(true);
		expect(bounded.endsWith("evidence ")).toBe(true);
		expect(estimateTokens(bounded)).toBeLessThanOrEqual(50);
		expect(bounded.length).toBeLessThan(text.length);
	});

	it("counts the marker against the budget instead of adding it after the walk", () => {
		// The budget alone would keep a 40-character (10-token) tail; that tail
		// does not fit once the marker's own ~7 tokens are prepended, so the kept
		// suffix has to shrink to the 3 tokens the marker leaves over.
		const text = "x".repeat(44);
		expect(estimateTokens(text)).toBe(11);

		const bounded = boundProjection(text, 10);

		expect(bounded).toBe(`${TRUNCATION_MARKER}${"x".repeat(12)}`);
		expect(estimateTokens(bounded)).toBeLessThanOrEqual(10);
		// What the old order produced: the full 10-token tail plus the marker.
		expect(estimateTokens(`${TRUNCATION_MARKER}${text.slice(-40)}`)).toBeGreaterThan(10);
	});

	it("starts the kept text on a line boundary after a cut", () => {
		const source = transcript(20);
		const sourceLines = new Set(linesOf(source));
		const bounded = boundProjection(source, 50);
		const keptLines = linesOf(bounded).slice(1);

		expect(keptLines.length).toBeGreaterThan(0);
		// Every kept line is a complete source line: the partial first line, whose
		// speaker/tool attribution would otherwise be missing, was dropped.
		for (const line of keptLines) expect(sourceLines.has(line)).toBe(true);
	});

	it("keeps a newline-free suffix instead of returning an empty projection", () => {
		const text = "y".repeat(100);
		const bounded = boundProjection(text, 20);
		const lastCharacters = Array.from(text).slice(-12).join("");

		expect(bounded.startsWith(TRUNCATION_MARKER)).toBe(true);
		expect(bounded.endsWith(lastCharacters)).toBe(true);
		expect(bounded.length).toBeGreaterThan(TRUNCATION_MARKER.length);
	});

	it("bounds CJK text at one token per character", () => {
		const text = "这是一个需要审查的中文工作记录".repeat(20);
		const bounded = boundProjection(text, 30);
		const lastCharacters = Array.from(text).slice(-23).join("");

		expect(bounded.startsWith(TRUNCATION_MARKER)).toBe(true);
		expect(bounded.endsWith(lastCharacters)).toBe(true);
		expect(estimateTokens(bounded)).toBeLessThanOrEqual(30);
	});
});

describe("markUnreviewedWork", () => {
	it("adds no marker before any review has completed", () => {
		expect(markUnreviewedWork(["[user] a", "[assistant] b"], 0)).toBe("[user] a\n\n[assistant] b");
		expect(markUnreviewedWork([], 0)).toBe("");
	});

	it("marks the first line after the work a review already read", () => {
		const lines = ["[user] old", "[assistant] old", "[user] new", "[assistant] new"];
		expect(markUnreviewedWork(lines, 2)).toBe(
			`[user] old\n\n[assistant] old\n\n${UNREVIEWED_MARKER}\n\n[user] new\n\n[assistant] new`,
		);
	});

	it("marks the end when nothing has accrued since the last review", () => {
		// A review can be due on a turn boundary that added no line; claiming the
		// whole evidence is new would make the reviewer re-judge reviewed work.
		expect(markUnreviewedWork(["[user] a"], 1)).toBe(`[user] a\n\n${UNREVIEWED_MARKER}`);
		expect(markUnreviewedWork(["[user] a"], 9)).toBe(`[user] a\n\n${UNREVIEWED_MARKER}`);
	});

	it("keeps the instruction and the marker text from drifting apart", () => {
		expect(REVIEW_INSTRUCTIONS).toContain(UNREVIEWED_MARKER);
	});

	it("leaves only the new work when bounding drops the reviewed prefix", () => {
		const lines = Array.from(
			{ length: 10 },
			(_, index) => `[tool result] line ${index}: ${"x".repeat(24)}`,
		);
		const bounded = boundProjection(markUnreviewedWork(lines, 5), 25);

		expect(bounded.startsWith(TRUNCATION_MARKER)).toBe(true);
		// The cut lands inside the new work, so the marker went with the prefix.
		expect(bounded).not.toContain(UNREVIEWED_MARKER);
		const kept = bounded.slice(TRUNCATION_MARKER.length).split("\n").filter((line) => line !== "");
		expect(kept.length).toBeGreaterThan(0);
		for (const line of kept) expect(lines.indexOf(line)).toBeGreaterThanOrEqual(5);
	});
});

describe("composeReviewPrompt", () => {
	it("leaves an untruncated projection and the no-deployment prompt unchanged", () => {
		const projection = transcript(2);
		const prompt = composeReviewPrompt(config(32_000), projection);

		expect(prompt.projection).toBe(projection);
		// The projection is fenced: text inside it that poses as an instruction is
		// quoted evidence, which is what the fixed instructions say about the fence.
		expect(prompt.text).toBe(
			`${REVIEW_INSTRUCTIONS}${WORK_SEPARATOR}${projection}${EVIDENCE_CLOSE}`,
		);
		expect(prompt.text).not.toContain("User review instructions:");
		expect(prompt.instructionsChars).toBe(REVIEW_INSTRUCTIONS.length + WORK_SEPARATOR.length);
	});

	it("counts the fixed and deployment instructions against the projection budget", () => {
		const projection = transcript(20);
		const short = composeReviewPrompt(config(600), projection);
		const longInstructions = "Follow the repository conventions closely. ".repeat(6);
		const long = composeReviewPrompt(config(600, longInstructions), projection);
		const deployment = `\nUser review instructions:\n${longInstructions}`;
		const overhead = estimateTokens(`${REVIEW_INSTRUCTIONS}${deployment}${WORK_SEPARATOR}`);

		expect(short.projection.startsWith(TRUNCATION_MARKER)).toBe(true);
		expect(long.projection.startsWith(TRUNCATION_MARKER)).toBe(true);
		expect(long.projection.length).toBeLessThan(short.projection.length);
		// The projection budget is what the fixed text and the deployment
		// instructions leave over, so the whole prompt stays inside the limit.
		expect(estimateTokens(long.projection)).toBeLessThanOrEqual(600 - overhead);
	});

	it("reduces the projection to the marker alone when instructions consume the budget", () => {
		const projection = transcript(20);
		const long = composeReviewPrompt(config(40, "z".repeat(400)), projection);

		expect(long.projection).toBe(TRUNCATION_MARKER);
	});

	it("reports instructionsChars as the exact instruction prefix, marker included on a cut", () => {
		const projection = transcript(20);
		const instructions = "Review the deployment path carefully.";
		const deployment = `\nUser review instructions:\n${instructions}`;
		const truncated = composeReviewPrompt(config(80, instructions), projection);
		const intact = composeReviewPrompt(config(32_000, instructions), projection);

		const cutPrefix = `${REVIEW_INSTRUCTIONS}${deployment}${WORK_SEPARATOR}${TRUNCATION_MARKER}`;
		const intactPrefix = `${REVIEW_INSTRUCTIONS}${deployment}${WORK_SEPARATOR}`;

		expect(truncated.projection.startsWith(TRUNCATION_MARKER)).toBe(true);
		expect(truncated.instructionsChars).toBe(cutPrefix.length);
		expect(truncated.text.slice(0, truncated.instructionsChars)).toBe(cutPrefix);

		expect(intact.projection.startsWith(TRUNCATION_MARKER)).toBe(false);
		expect(intact.instructionsChars).toBe(intactPrefix.length);
		expect(intact.text.slice(0, intact.instructionsChars)).toBe(intactPrefix);
	});
});
