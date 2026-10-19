import { describe, expect, it } from "vitest";

import {
	RECENT_REVIEW_LIMIT,
	emptyAdvisorStats,
	isNoteRecord,
	isReviewRecord,
	isReviewContextMeta,
	pushBounded,
	recordReview,
	restoreAdvisorStats,
	toNoteRecord,
	toReviewContextMeta,
	toReviewRecord,
} from "../src/policy/stats.ts";

const usage = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, durationMs = 1_000) => ({
	durationMs,
	inputTokens,
	outputTokens,
	cacheReadTokens,
});

describe("recordReview", () => {
	it("accumulates counts, tokens and wall time per outcome kind", () => {
		let stats = emptyAdvisorStats();
		stats = recordReview(
			stats,
			toReviewRecord({ turn: 1, at: 10, kind: "finding", severity: "concern", note: "x", usage: usage(100, 20, 40, 2_000) }),
		);
		stats = recordReview(stats, toReviewRecord({ turn: 2, at: 20, kind: "silent", usage: usage(50, 5, 10, 1_000) }));
		stats = recordReview(
			stats,
			toReviewRecord({ turn: 3, at: 30, kind: "failed", reason: "429", usage: usage(0, 0, 0, 500) }),
		);

		expect(stats.reviews).toBe(3);
		expect(stats.findings).toBe(1);
		expect(stats.silent).toBe(1);
		expect(stats.failed).toBe(1);
		expect(stats.cancelled).toBe(0);
		expect(stats.inputTokens).toBe(150);
		expect(stats.outputTokens).toBe(25);
		expect(stats.cacheReadTokens).toBe(50);
		expect(stats.reviewMs).toBe(3_500);
		expect(stats.last?.kind).toBe("failed");
	});

	it("keeps a finding note out of a silent record", () => {
		const record = toReviewRecord({ turn: 1, at: 1, kind: "silent", usage: usage(1, 1) });
		expect(record.note).toBeUndefined();
		expect(record.severity).toBeUndefined();
		expect(record.reason).toBeUndefined();
	});
});

describe("toReviewRecord", () => {
	it("truncates the note but keeps the accounting intact", () => {
		const record = toReviewRecord({
			turn: 4,
			at: 5,
			kind: "finding",
			severity: "blocker",
			note: "x".repeat(1_000),
			usage: usage(7, 8),
		});
		expect(record.note).toHaveLength(400);
		expect(record.usage).toEqual({ durationMs: 1_000, inputTokens: 7, outputTokens: 8, cacheReadTokens: 0 });
	});
});

describe("pushBounded", () => {
	it("prepends and drops the oldest entry beyond the limit", () => {
		let list: number[] = [];
		for (let value = 0; value < RECENT_REVIEW_LIMIT + 3; value++) list = pushBounded(list, value, RECENT_REVIEW_LIMIT);
		expect(list).toHaveLength(RECENT_REVIEW_LIMIT);
		expect(list[0]).toBe(RECENT_REVIEW_LIMIT + 2);
		expect(list.at(-1)).toBe(3);
	});
});

describe("restoreAdvisorStats", () => {
	it("returns zeros for a missing or malformed record", () => {
		expect(restoreAdvisorStats(undefined)).toEqual(emptyAdvisorStats());
		expect(restoreAdvisorStats({ reviews: "three", inputTokens: -4 })).toEqual(emptyAdvisorStats());
	});

	it("keeps valid counters and a valid last record", () => {
		const last = toReviewRecord({ turn: 9, at: 99, kind: "finding", severity: "nit", note: "n", usage: usage(3, 4) });
		const restored = restoreAdvisorStats({ reviews: 2, inputTokens: 30, outputTokens: 4, reviewMs: 500, last });
		expect(restored.reviews).toBe(2);
		expect(restored.inputTokens).toBe(30);
		expect(restored.reviewMs).toBe(500);
		expect(restored.last).toEqual(last);
	});
});

describe("history entry validation", () => {
	it("accepts a record built by this module", () => {
		const record = toReviewRecord({ turn: 1, at: 2, kind: "finding", severity: "concern", note: "x", usage: usage(1, 2) });
		expect(isReviewRecord(record)).toBe(true);
		expect(isNoteRecord(toNoteRecord(1, 2, "concern", "note"))).toBe(true);
	});

	it("rejects entries from a foreign or broken shape", () => {
		expect(isReviewRecord({ turn: 1, at: 2, kind: "other" })).toBe(false);
		expect(isNoteRecord({ turn: 1, at: 2, severity: "fatal", note: "n" })).toBe(false);
	});
});

describe("toReviewContextMeta", () => {
	const prompt = (projection: string) => ({
		text: `FIXED\n\nRecent Executor work:\n${projection}`,
		projection,
		instructionsChars: "FIXED\n\nRecent Executor work:\n".length,
		truncated: projection.startsWith("[earlier context omitted]"),
	});

	it("describes an unbounded projection as complete and keeps both previews", () => {
		const meta = toReviewContextMeta(prompt("[user] a\n\n[assistant] b"), 1792330000000, 100);
		expect(meta.truncated).toBe(false);
		expect(meta.projectionChars).toBe("[user] a\n\n[assistant] b".length);
		expect(meta.promptChars).toBeGreaterThan(meta.projectionChars);
		expect(meta.estimatedTokens).toBeGreaterThan(0);
		expect(meta.head).toBe(meta.tail);
	});

	it("marks the bounded projection and previews both ends of the sent text", () => {
		const projection = `[earlier context omitted]\n${"x".repeat(500)}`;
		const meta = toReviewContextMeta(prompt(projection), 1792330000001, 100);
		expect(meta.truncated).toBe(true);
		expect(meta.head.startsWith("[earlier context omitted]")).toBe(true);
		expect(meta.tail).toBe("x".repeat(100));
		expect(meta.head.length).toBe(100);
		expect(meta.tail.length).toBe(100);
		expect(meta.projectionChars).toBe(projection.length);
	});

	it("records the review identity separately from its sizes", () => {
		// A truncated projection fills the same budget every time, so two reviews
		// can match on every length yet carry different text.
		const a = toReviewContextMeta(prompt("[earlier context omitted]\n" + "x".repeat(500)), 1);
		const b = toReviewContextMeta(prompt("[earlier context omitted]\n" + "y".repeat(500)), 2);
		expect(a.promptChars).toBe(b.promptChars);
		expect(a.estimatedTokens).toBe(b.estimatedTokens);
		expect(a.recordedAt).toBe(1);
		expect(b.recordedAt).toBe(2);
	});

	it("accepts its own output as a persisted record", () => {
		expect(isReviewContextMeta(toReviewContextMeta(prompt("material"), 1792330000002))).toBe(true);
		expect(isReviewContextMeta({ truncated: "no" })).toBe(false);
	});
});
