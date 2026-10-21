import { describe, expect, it } from "vitest";

import type { AdvisorConfig } from "../src/policy/config.ts";
import { estimateTokens } from "../src/policy/redaction.ts";
import type { ReviewRecord } from "../src/policy/stats.ts";
import type { TranscriptEntry } from "../src/policy/transcript.ts";
import {
	CONCLUSION_TOKENS,
	EARLIER_WORK_OMITTED,
	EVIDENCE_CLOSE,
	EVIDENCE_OPEN,
	REVIEW_INSTRUCTIONS,
	TRUNCATION_MARKER,
	boundaryLine,
	composeReviewPrompt,
	describePreviousReviews,
	type ReviewEvidence,
} from "../src/policy/prompt.ts";

const WORK_SEPARATOR = EVIDENCE_OPEN;

function config(instructions = ""): AdvisorConfig {
	return {
		enabled: false,
		instructions,
		review: {
			everySteps: 25,
			timeoutMs: 180_000,
			maxContextTokens: 64_000,
			maxAdviceChars: 2_000,
			maxPending: 32,
		},
		delivery: { activeIdleSeverities: ["concern"] },
		prompt: { shadowedSections: [] },
		security: { additionalProtectedPaths: [] },
	};
}

/** Deterministic evidence: each line names its own seq, so a cut is readable. */
function entries(seqs: readonly number[], kind: TranscriptEntry["kind"] = "assistant"): TranscriptEntry[] {
	return seqs.map((seq) => ({ seq, kind, evidence: `[${kind}] evidence ${String(seq)} ${"x".repeat(16)}` }));
}

function evidence(patch: Partial<ReviewEvidence> = {}): ReviewEvidence {
	return { older: [], recent: entries([1, 2]), ...patch };
}

const NONCE = "0123456789ab";
const MARKER = boundaryLine(NONCE);

function review(seq: number, patch: Partial<ReviewRecord> = {}): ReviewRecord {
	return {
		turn: seq,
		at: seq,
		kind: "finding",
		severity: "concern",
		key: `finding-${String(seq)}`,
		note: `a concrete defect ${String(seq)}`,
		usage: { durationMs: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
		...patch,
	};
}

describe("boundaryLine", () => {
	it("embeds a per-review nonce", () => {
		expect(boundaryLine("a1b2c3d4e5f6")).toBe("[review boundary a1b2c3d4e5f6: work since the last review]");
		// Two reviews never share a line: a quoted one keeps being evidence.
		expect(boundaryLine("a1b2c3d4e5f6")).not.toBe(boundaryLine("f6e5d4c3b2a1"));
	});
});

describe("describePreviousReviews", () => {
	it("renders nothing before a review concluded", () => {
		expect(describePreviousReviews([])).toBeUndefined();
		expect(describePreviousReviews([review(1, { kind: "failed", reason: "timeout" })])).toBeUndefined();
	});

	it("keeps the outcome, severity, finding identity and one line of note", () => {
		const block = describePreviousReviews([review(12)]);
		expect(block).toContain("Earlier reviews");
		expect(block).toContain("- turn 12 · concern · finding-12 · a concrete defect 12");
	});

	it("names a silent review as silence, which is a conclusion too", () => {
		const silent: ReviewRecord = {
			turn: 9,
			at: 9,
			kind: "silent",
			usage: { durationMs: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
		};
		expect(describePreviousReviews([silent])).toContain("- turn 9 · silent (no finding)");
	});

	it("collapses repeated silent reviews of one turn into one line", () => {
		const silent = (turn: number): ReviewRecord => ({
			turn,
			at: turn,
			kind: "silent",
			usage: { durationMs: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
		});
		// Newest first, as the sidecar stores the history: three consecutive quiet
		// reviews of turn 23, then a finding of the same turn, then an older silence.
		const block = describePreviousReviews([silent(23), silent(23), silent(23), review(23), silent(22)]);
		expect(block).toContain("- turn 23 ×3 · silent (no finding)");
		expect(block).toContain("- turn 22 · silent (no finding)");
		// A finding is never folded into the silence around it.
		expect(block).toContain("turn 23 · concern · finding-23");
	});

	it("drops the oldest conclusions first when the block outgrows its bound", () => {
		const history = Array.from({ length: 40 }, (_, index) => review(40 - index));
		const block = describePreviousReviews(history);
		expect(block).toBeDefined();
		expect(estimateTokens(block ?? "")).toBeLessThanOrEqual(CONCLUSION_TOKENS);
		expect(block).toContain("turn 40");
	});
});

describe("composeReviewPrompt", () => {
	it("leaves an untruncated projection and the no-deployment prompt unchanged", () => {
		const prompt = composeReviewPrompt(config(), evidence(), 64_000);

		expect(prompt.projection).toBe(
			"[assistant] evidence 1 xxxxxxxxxxxxxxxx\n\n[assistant] evidence 2 xxxxxxxxxxxxxxxx",
		);
		expect(prompt.truncated).toBe(false);
		// The projection is fenced: text inside it that poses as an instruction is
		// quoted evidence, which is what the fixed instructions say about the fence.
		expect(prompt.text).toBe(`${REVIEW_INSTRUCTIONS}${WORK_SEPARATOR}${prompt.projection}${EVIDENCE_CLOSE}`);
		expect(prompt.text).not.toContain("User review instructions:");
		expect(prompt.instructionsChars).toBe(REVIEW_INSTRUCTIONS.length + WORK_SEPARATOR.length);
		expect(prompt.budgetTokens).toBe(64_000);
	});

	it("counts the fixed and deployment instructions against the projection budget", () => {
		const longInstructions = "Follow the repository conventions closely. ".repeat(6);
		const material = entries(Array.from({ length: 120 }, (_, index) => index + 1));
		const short = composeReviewPrompt(config(), evidence({ recent: material }), 1_200);
		const long = composeReviewPrompt(config(longInstructions), evidence({ recent: material }), 1_200);
		const deployment = `\nUser review instructions:\n${longInstructions}`;
		const overhead = estimateTokens(`${REVIEW_INSTRUCTIONS}${deployment}${WORK_SEPARATOR}${EVIDENCE_CLOSE}`);

		expect(short.truncated).toBe(true);
		expect(long.truncated).toBe(true);
		expect(long.projection.length).toBeLessThan(short.projection.length);
		// The projection budget is what the fixed text leaves over, so the whole
		// prompt stays inside the limit it was composed against.
		expect(estimateTokens(long.text)).toBeLessThanOrEqual(1_200);
		expect(estimateTokens(short.text)).toBeLessThanOrEqual(1_200);
		expect(overhead).toBeGreaterThan(0);
	});

	it("reduces the projection to the marker alone when nothing fits, never to the full text", () => {
		// The old fallback bounded to `Math.max(1, budget)` and could return the
		// whole projection while reporting it as truncated.
		const prompt = composeReviewPrompt(config(), evidence(), 40);

		expect(prompt.projection).toBe(TRUNCATION_MARKER);
		expect(prompt.truncated).toBe(true);
		expect(prompt.budgetShortfall).toBe(true);
		expect(prompt.text.endsWith(`${TRUNCATION_MARKER}${EVIDENCE_CLOSE}`)).toBe(true);
	});

	it("protects the work since the last review from a large trace", () => {
		const trace = entries(Array.from({ length: 200 }, (_, index) => index + 1));
		const recent = entries([900, 901, 902]);
		const prompt = composeReviewPrompt(config(), { older: trace, recent }, 2_000);

		// The new work is what the review is about: it survives whole...
		for (const entry of recent) expect(prompt.projection).toContain(entry.evidence);
		// ...and the trace is what lost material: its tail survives, its head does
		// not, and the omission is stated.
		expect(prompt.projection).toContain(EARLIER_WORK_OMITTED);
		expect(prompt.projection).toContain(trace[199]?.evidence ?? "");
		expect(prompt.projection).not.toContain(trace[0]?.evidence ?? "");
		expect(prompt.olderTokens).toBeGreaterThan(0);
		expect(prompt.recentTokens).toBeGreaterThan(0);
		expect(estimateTokens(prompt.text)).toBeLessThanOrEqual(2_000);
	});

	it("keeps the trace's tail when the trace fits and says nothing about omission", () => {
		const trace = entries([1, 2, 3, 4]);
		const prompt = composeReviewPrompt(config(), { older: trace, recent: [] }, 64_000);

		expect(prompt.truncated).toBe(false);
		expect(prompt.olderTokens).toBeGreaterThan(0);
		expect(prompt.projection).not.toContain(EARLIER_WORK_OMITTED);
		expect(prompt.projection).toContain(trace[3]?.evidence ?? "");
	});

	it("marks the boundary and names the exact line it inserted", () => {
		const prompt = composeReviewPrompt(
			config(),
			{ older: entries([1, 2]), recent: entries([3]), marker: MARKER },
			64_000,
		);

		// One mention in the boundary sentence, one as the inserted line.
		expect(prompt.text.match(/review boundary /g)).toHaveLength(2);
		expect(prompt.text).toContain(`"${MARKER}"`);
		// The trace precedes the inserted boundary line, the new work follows it.
		// (The boundary sentence in the instructions mentions the nonce earlier.)
		const boundaryAt = prompt.text.lastIndexOf(MARKER);
		expect(prompt.text.indexOf("[assistant] evidence 1")).toBeLessThan(boundaryAt);
		expect(prompt.text.indexOf("[assistant] evidence 3")).toBeGreaterThan(boundaryAt);
	});

	it("keeps the cacheable prefix byte-identical across reviews", () => {
		// The provider cache hits on the longest identical prefix. The fixed
		// instructions and the deployment block are that prefix: everything after
		// them is per-review (boundary sentence, conclusions, evidence).
		const deployment = "Follow the repository conventions closely.";
		const first = composeReviewPrompt(config(deployment), evidence(), 64_000);
		const second = composeReviewPrompt(
			config(deployment),
			{ older: entries([1, 2]), recent: entries([3]), marker: MARKER, reviews: [review(2)] },
			24_000,
		);
		const prefix = `${REVIEW_INSTRUCTIONS}\nUser review instructions:\n${deployment}`;

		expect(first.text.startsWith(prefix)).toBe(true);
		expect(second.text.startsWith(prefix)).toBe(true);
	});

	it("adds no boundary sentence and no line before a review has completed", () => {
		const prompt = composeReviewPrompt(config(), evidence(), 64_000);
		expect(prompt.text).not.toContain("review boundary");
	});

	it("tells the reviewer that omitted tool output is hidden, not unexecuted", () => {
		// The trace zone drops bodies; without this sentence the reviewer reads an
		// omitted result as a command that never ran.
		expect(REVIEW_INSTRUCTIONS).toContain("omitted means hidden by this projection, never unexecuted");
		expect(REVIEW_INSTRUCTIONS).toContain("You have no shell");
	});

	it("carries the earlier conclusions inside the untrusted fence, before the trace", () => {
		const prompt = composeReviewPrompt(
			config(),
			{ older: entries([1, 2]), recent: entries([3]), marker: MARKER, reviews: [review(2), review(1)] },
			64_000,
		);

		const fenceAt = prompt.text.indexOf(WORK_SEPARATOR);
		const conclusionAt = prompt.text.indexOf("Earlier reviews");
		expect(conclusionAt).toBeGreaterThan(fenceAt);
		expect(conclusionAt).toBeLessThan(prompt.text.indexOf("[assistant] evidence 1"));
		// The newest conclusion is listed last, next to the trace it explains.
		expect(prompt.text.indexOf("turn 1 ·")).toBeLessThan(prompt.text.indexOf("turn 2 ·"));
	});

	it("drops the conclusions whole when the budget cannot hold them", () => {
		const prompt = composeReviewPrompt(
			config(),
			{ older: entries([1]), recent: entries([2]), marker: MARKER, reviews: [review(5)] },
			40,
		);
		expect(prompt.projection).toBe(TRUNCATION_MARKER);
		expect(prompt.text).not.toContain("Earlier reviews");
	});

	it("keeps the whole prompt inside the budget when both zones are cut", () => {
		const trace = entries(Array.from({ length: 60 }, (_, index) => index + 1));
		for (const budget of [650, 700, 900, 1_300]) {
			const prompt = composeReviewPrompt(config(), { older: trace, recent: entries([900, 901]) }, budget);
			expect(estimateTokens(prompt.text)).toBeLessThanOrEqual(budget);
		}
	});

	it("drops the conclusions to make room for evidence instead of returning a bare marker", () => {
		// The conclusions are orientation; when paying for them would leave no zone at
		// all, they go and the evidence stays. A bare marker is the last resort, not the
		// first answer to a tight budget.
		const reviews = [review(1), review(2)];
		const block = describePreviousReviews(reviews) ?? "";
		const fixed = estimateTokens(`${REVIEW_INSTRUCTIONS}${EVIDENCE_OPEN}${EVIDENCE_CLOSE}`);
		const budget = fixed + estimateTokens(`${block}\n\n`) + 5;
		const prompt = composeReviewPrompt(
			config(),
			{ older: [], recent: entries([1, 2, 3]), reviews },
			budget,
		);

		expect(prompt.projection).not.toBe(TRUNCATION_MARKER);
		expect(prompt.projection).not.toContain("Earlier reviews");
		expect(prompt.recentTokens).toBeGreaterThan(0);
		expect(prompt.projection).toContain("[assistant] evidence 3");
	});

	it("drops the conclusions when keeping them would leave no room for any entry", () => {
		// zoneBudget > 0 but smaller than the newest entry: the conclusions alone would
		// turn a runnable review into a refused one, so they go and the zone is retried.
		const reviews = [review(1), review(2)];
		const block = describePreviousReviews(reviews) ?? "";
		const fixed = estimateTokens(`${REVIEW_INSTRUCTIONS}${EVIDENCE_OPEN}${EVIDENCE_CLOSE}`);
		const entry: TranscriptEntry = { seq: 3, kind: "assistant", evidence: "字".repeat(40) };
		const budget = fixed + estimateTokens(`${block}\n\n`) + 44;
		const prompt = composeReviewPrompt(config(), { older: [], recent: [entry], reviews }, budget);

		expect(prompt.projection).not.toContain("Earlier reviews");
		expect(prompt.projection).toContain("字".repeat(40));
		expect(prompt.recentTokens).toBeGreaterThan(0);
		expect(prompt.recentComplete).toBe(true);
		expect(estimateTokens(prompt.text)).toBeLessThanOrEqual(budget);
	});

	it("inserts the boundary line even when it is the only evidence part", () => {
		// The boundary sentence says the harness inserted the line, so the composer must
		// never mint a boundary and then omit it from the prompt.
		const prompt = composeReviewPrompt(config(), { older: [], recent: [], marker: MARKER }, 64_000);

		expect(prompt.projection).toBe(MARKER);
		expect(prompt.text).toContain(`"${MARKER}"`);
	});

	it("still marks the boundary when the whole trace was dropped", () => {
		// The marker is what lets the reviewer tell "nothing new" from "nothing older":
		// a prompt that ends on the omission line must still carry it. One trace entry
		// alone costs more than the zone budget here, so none fits.
		const trace: TranscriptEntry[] = Array.from({ length: 5 }, (_, index) => ({
			seq: index + 1,
			kind: "assistant",
			evidence: "y".repeat(2_000),
		}));
		const prompt = composeReviewPrompt(config(), { older: trace, recent: [], marker: MARKER }, 1_000);

		expect(prompt.olderTokens).toBe(0);
		expect(prompt.projection).toContain(EARLIER_WORK_OMITTED);
		expect(prompt.projection.endsWith(MARKER)).toBe(true);
	});

	it("reports whether the new-work zone was projected whole", () => {
		const whole = composeReviewPrompt(config(), evidence(), 64_000);
		expect(whole.recentComplete).toBe(true);

		const cut = composeReviewPrompt(
			config(),
			{ older: [], recent: entries(Array.from({ length: 200 }, (_, index) => index + 1)) },
			1_200,
		);
		expect(cut.truncated).toBe(true);
		expect(cut.recentComplete).toBe(false);
	});

	it("keeps a result whose call sits outside the zone", () => {
		// A tool result is evidence of what the tool answered even when its call was
		// cut with the trace; the composer must not drop the leading result of a zone.
		const recent: TranscriptEntry[] = [
			{ seq: 5, kind: "tool-result", evidence: "[tool result] read src/a.ts · 10 chars, 1 lines · content omitted (re-read to verify)" },
			{ seq: 6, kind: "assistant", evidence: "[assistant] done" },
		];
		const withTrace = composeReviewPrompt(
			config(),
			{ older: entries([1, 2]), recent, marker: MARKER },
			64_000,
		);
		expect(withTrace.projection).toContain("[tool result] read src/a.ts");

		const withoutTrace = composeReviewPrompt(config(), { older: [], recent }, 64_000);
		expect(withoutTrace.projection).toContain("[tool result] read src/a.ts");
	});

	it("states a cut new-work zone instead of implying no work accrued", () => {
		// The bounded recent zone keeps its tail; the boundary sentence promises that
		// nothing after the boundary means no new work. Without a line saying the oldest
		// entries were dropped, a cut zone reads as "nothing happened".
		const recent = entries(Array.from({ length: 200 }, (_, index) => index + 1));
		const prompt = composeReviewPrompt(config(), { older: entries([1]), recent, marker: MARKER }, 1_300);

		expect(prompt.recentComplete).toBe(false);
		expect(prompt.projection).toContain("entries of new work omitted");
		// The omission line sits after the boundary and before the kept work.
		const omittedAt = prompt.projection.indexOf("entries of new work omitted");
		expect(prompt.projection.lastIndexOf(MARKER)).toBeLessThan(omittedAt);
		expect(prompt.projection.indexOf("[assistant] evidence 200")).toBeGreaterThan(omittedAt);
	});

	it("reports how much material the budget cut", () => {
		const trace = entries(Array.from({ length: 100 }, (_, index) => index + 1));
		const prompt = composeReviewPrompt(config(), { older: trace, recent: entries([900]) }, 800);

		expect(prompt.truncated).toBe(true);
		expect(prompt.materialTokens).toBeGreaterThan(prompt.budgetTokens);
		expect(prompt.recentTokens + prompt.olderTokens).toBeLessThan(prompt.materialTokens);
	});

	it("reports instructionsChars as the exact prefix, marker included on a cut", () => {
		const instructions = "Review the deployment path carefully.";
		const deployment = `\nUser review instructions:\n${instructions}`;
		const trace = entries(Array.from({ length: 200 }, (_, index) => index + 1));
		const truncated = composeReviewPrompt(config(instructions), { older: trace, recent: entries([900]) }, 800);
		const intact = composeReviewPrompt(config(instructions), evidence(), 64_000);
		const base = `${REVIEW_INSTRUCTIONS}${deployment}${WORK_SEPARATOR}`;

		expect(truncated.projection.startsWith(TRUNCATION_MARKER)).toBe(true);
		expect(truncated.instructionsChars).toBe(base.length + TRUNCATION_MARKER.length);
		expect(truncated.text.slice(0, truncated.instructionsChars)).toBe(`${base}${TRUNCATION_MARKER}`);

		expect(intact.truncated).toBe(false);
		expect(intact.instructionsChars).toBe(base.length);
		expect(intact.text.slice(0, intact.instructionsChars)).toBe(base);
	});
});
