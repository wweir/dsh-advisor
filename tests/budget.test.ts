import { describe, expect, it } from "vitest";

import {
	planReviewBudget,
	REVIEW_MIN_EVIDENCE_TOKENS,
	REVIEW_OUTPUT_RESERVE_FALLBACK_TOKENS,
	REVIEW_PREAMBLE_FALLBACK_TOKENS,
	REVIEW_WINDOW_MARGIN_TOKENS,
} from "../src/policy/budget.ts";

const CAP = 64_000;

describe("planReviewBudget", () => {
	it("keeps the configured cap when the route's window is unknown", () => {
		const decision = planReviewBudget({ configuredCap: CAP, preambleTokens: REVIEW_PREAMBLE_FALLBACK_TOKENS });
		expect(decision).toEqual({
			kind: "ok",
			budget: {
				evidenceTokens: CAP,
				outputReserve: REVIEW_OUTPUT_RESERVE_FALLBACK_TOKENS,
				preambleTokens: REVIEW_PREAMBLE_FALLBACK_TOKENS,
			},
		});
	});

	it("lowers the cap to what the window leaves after preamble and output", () => {
		// 96,000 - 11,089 preamble - 8,000 output - 2,000 margin.
		const decision = planReviewBudget({
			configuredCap: 200_000,
			preambleTokens: REVIEW_PREAMBLE_FALLBACK_TOKENS,
			window: { contextWindow: 96_000, defaultMaxTokens: 8_000 },
		});

		expect(decision.kind).toBe("ok");
		if (decision.kind !== "ok") return;
		expect(decision.budget.evidenceTokens).toBe(74_911);
		expect(decision.budget.windowTokens).toBe(96_000);
	});

	it("does not raise the cap above what the operator configured", () => {
		const decision = planReviewBudget({
			configuredCap: 32_000,
			preambleTokens: REVIEW_PREAMBLE_FALLBACK_TOKENS,
			window: { contextWindow: 1_000_000, defaultMaxTokens: 32_000 },
		});
		expect(decision.kind).toBe("ok");
		if (decision.kind !== "ok") return;
		expect(decision.budget.evidenceTokens).toBe(32_000);
	});

	it("reserves the route's own output cap when it advertises one", () => {
		const decision = planReviewBudget({
			configuredCap: CAP,
			preambleTokens: 4_000,
			window: { contextWindow: 128_000, defaultMaxTokens: 64_000 },
		});
		expect(decision.kind).toBe("ok");
		if (decision.kind !== "ok") return;
		expect(decision.budget.outputReserve).toBe(64_000);
	});

	it("refuses a window that cannot hold even a minimal review, with its numbers", () => {
		const decision = planReviewBudget({
			configuredCap: CAP,
			preambleTokens: REVIEW_PREAMBLE_FALLBACK_TOKENS,
			window: { contextWindow: 24_000, defaultMaxTokens: 8_000 },
		});

		expect(decision.kind).toBe("refused");
		if (decision.kind !== "refused") return;
		// Every number that produced the refusal is in the message: an operator
		// cannot fix a route from "window too small".
		expect(decision.reason).toContain("24,000");
		expect(decision.reason).toContain("11,089");
		expect(decision.reason).toContain("8,000");
		expect(decision.reason).toContain("2,000");
		expect(decision.reason).toContain(REVIEW_MIN_EVIDENCE_TOKENS.toLocaleString("en-US"));
	});

	it("refuses an operator cap below the evidence minimum, with the value to raise", () => {
		// The schema allows maxContextTokens = 1; a prompt with no room to point at
		// anything is a wasted model call reported as a review.
		for (const window of [undefined, { contextWindow: 1_000_000, defaultMaxTokens: 8_000 }]) {
			const decision = planReviewBudget({
				configuredCap: 2_000,
				preambleTokens: REVIEW_PREAMBLE_FALLBACK_TOKENS,
				...(window === undefined ? {} : { window }),
			});
			expect(decision.kind).toBe("refused");
			if (decision.kind !== "refused") continue;
			expect(decision.reason).toContain("2,000");
			expect(decision.reason).toContain(REVIEW_MIN_EVIDENCE_TOKENS.toLocaleString("en-US"));
		}
	});

	it("accepts a window that leaves exactly the minimum", () => {
		const window = REVIEW_PREAMBLE_FALLBACK_TOKENS + 8_000 + REVIEW_WINDOW_MARGIN_TOKENS + REVIEW_MIN_EVIDENCE_TOKENS;
		const decision = planReviewBudget({
			configuredCap: CAP,
			preambleTokens: REVIEW_PREAMBLE_FALLBACK_TOKENS,
			window: { contextWindow: window, defaultMaxTokens: 8_000 },
		});
		expect(decision.kind).toBe("ok");
		if (decision.kind !== "ok") return;
		expect(decision.budget.evidenceTokens).toBe(REVIEW_MIN_EVIDENCE_TOKENS);
	});
});
