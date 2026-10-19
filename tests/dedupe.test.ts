import { describe, expect, it } from "vitest";

import {
	BoundedAdviceDedupe,
	acceptReviewAdvice,
	hammingDistance64,
	noteSignature,
	noteSimilarity,
	type AdviceSeverity,
	type DedupePolicy,
} from "../src/policy/advice.ts";

const NOTE = "The rollback path drops the pending migration state on failure.";
const PARAPHRASE = "The rollback path loses the pending migration state when it fails.";
const DISTINCT =
	"Feature flags are read after the configuration file is closed, so values always come back empty.";

const POLICY: DedupePolicy = {
	similarityRedeliveryThreshold: 0.5,
	reRaiseMinTurns: 4,
};

const SIMILARITY_ONLY: DedupePolicy = {
	similarityRedeliveryThreshold: 0.5,
	reRaiseMinTurns: 0,
};

function advice(note = NOTE, severity: AdviceSeverity = "concern", findingKey = "finding-a") {
	return acceptReviewAdvice(
		{ note, severity, findingKey },
		{ maxAdviceChars: 2_000, now: 1 },
	);
}

describe("SimHash primitives", () => {
	it("computes exact 64-bit distances and similarities", () => {
		expect(hammingDistance64(0n, 0n)).toBe(0);
		expect(hammingDistance64(0n, (1n << 32n) - 1n)).toBe(32);
		expect(hammingDistance64(0n, (1n << 64n) - 1n)).toBe(64);
		expect(noteSimilarity(0n, 0n)).toBe(1);
		expect(noteSimilarity(0n, (1n << 32n) - 1n)).toBe(0.5);
		expect(noteSimilarity(0n, (1n << 64n) - 1n)).toBe(0);
	});

	it("folds prose case and whitespace but not token content", () => {
		expect(noteSignature("  VERIFY rollback punctuation... ")).toBe(
			noteSignature("verify rollback punctuation"),
		);
		expect(noteSignature(NOTE)).not.toBe(noteSignature(DISTINCT));
	});

	it("uses fixture notes that actually straddle the 0.5 similarity threshold", () => {
		expect(noteSimilarity(noteSignature(NOTE), noteSignature(PARAPHRASE))).toBeGreaterThanOrEqual(
			0.5,
		);
		expect(noteSimilarity(noteSignature(NOTE), noteSignature(DISTINCT))).toBeLessThan(0.5);
	});
});

describe("BoundedAdviceDedupe", () => {
	it("delivers an unseen finding, then suppresses the same key and paraphrase", () => {
		const dedupe = new BoundedAdviceDedupe(16);
		const first = advice(NOTE, "concern", "finding-a");
		expect(dedupe.decide(first, 1, POLICY)).toEqual({ outcome: "deliver" });
		expect(dedupe.add(first, 1)).toBe(true);

		expect(dedupe.decide(advice(NOTE, "concern", "finding-a"), 2, POLICY)).toEqual({
			outcome: "suppress",
		});
		expect(dedupe.decide(advice(PARAPHRASE, "concern", "finding-a"), 9, POLICY)).toEqual({
			outcome: "suppress",
		});
		expect(dedupe.decide(advice(NOTE, "concern", "  Finding-A "), 9, POLICY)).toEqual({
			outcome: "suppress",
		});
	});

	it("treats findingKey as the identity, not the note text", () => {
		const dedupe = new BoundedAdviceDedupe(16);
		dedupe.add(advice(NOTE, "concern", "finding-a"), 1);
		// decide() is a pure query: a delivered decision is recorded by add(),
		// only after the host confirms delivery.
		expect(dedupe.decide(advice(NOTE, "concern", "finding-b"), 2, POLICY)).toEqual({
			outcome: "deliver",
		});
	});

	it("delivers a dissimilar note that reuses the same key as a possible duplicate", () => {
		const dedupe = new BoundedAdviceDedupe(16);
		dedupe.add(advice(NOTE, "concern", "finding-c"), 1);
		expect(dedupe.decide(advice(DISTINCT, "concern", "finding-c"), 2, POLICY)).toEqual({
			outcome: "deliver",
			tag: "possible-duplicate",
		});
	});

	it("suppresses at similarity 0.5 and delivers below it", () => {
		const base = { findingKeyHash: "a".repeat(64), severity: "concern" as const, signature: 0n };
		const dedupe = new BoundedAdviceDedupe(16);
		dedupe.add(base, 1);
		// 32 identical bits => exactly 0.5; the comparison is strict (< threshold).
		expect(dedupe.decide({ ...base, signature: (1n << 32n) - 1n }, 2, SIMILARITY_ONLY)).toEqual({
			outcome: "suppress",
		});
		// 33 differing bits => 31/64 < 0.5.
		expect(dedupe.decide({ ...base, signature: (1n << 33n) - 1n }, 2, SIMILARITY_ONLY)).toEqual({
			outcome: "deliver",
			tag: "possible-duplicate",
		});
	});

	it("treats a zero similarity threshold as disabled", () => {
		const base = { findingKeyHash: "a".repeat(64), severity: "concern" as const, signature: 0n };
		const dedupe = new BoundedAdviceDedupe(16);
		dedupe.add(base, 1);
		const opposite = { ...base, signature: (1n << 64n) - 1n };
		// The negative-control arm: the same input is a possible duplicate at a
		// positive threshold, so the zero case is the threshold talking.
		expect(
			dedupe.decide(opposite, 2, { similarityRedeliveryThreshold: 0.5, reRaiseMinTurns: 0 }),
		).toEqual({ outcome: "deliver", tag: "possible-duplicate" });
		expect(
			dedupe.decide(opposite, 2, { similarityRedeliveryThreshold: 0, reRaiseMinTurns: 0 }),
		).toEqual({ outcome: "suppress" });
	});

	it("re-raises only after the turn distance and only for a strictly higher severity", () => {
		const dedupe = new BoundedAdviceDedupe(16);
		const key = "finding-ra";
		dedupe.add(advice(NOTE, "concern", key), 1);

		// Three turns of spacing is not enough.
		expect(dedupe.decide(advice(NOTE, "blocker", key), 4, POLICY)).toEqual({
			outcome: "suppress",
		});
		expect(dedupe.decide(advice(NOTE, "blocker", key), 5, POLICY)).toEqual({
			outcome: "deliver",
			tag: "re-raised",
		});

		dedupe.add(advice(NOTE, "blocker", key), 5);
		for (const severity of ["blocker", "concern", "nit"] as const) {
			expect(dedupe.decide(advice(NOTE, severity, key), 9, POLICY)).toEqual({
				outcome: "suppress",
			});
		}
		// Disabling re-raise leaves only the similarity branch, which suppresses
		// an identical note regardless of severity.
		expect(
			dedupe.decide(advice(NOTE, "blocker", key), 9, {
				similarityRedeliveryThreshold: 0.5,
				reRaiseMinTurns: 0,
			}),
		).toEqual({ outcome: "suppress" });
	});

	it("prefers the re-raised tag when both re-raise and dissimilarity apply", () => {
		const dedupe = new BoundedAdviceDedupe(16);
		dedupe.add(advice(NOTE, "concern", "finding-mix"), 1);
		expect(dedupe.decide(advice(DISTINCT, "blocker", "finding-mix"), 5, POLICY)).toEqual({
			outcome: "deliver",
			tag: "re-raised",
		});
	});

	it("updates the last delivery turn without lowering the stored severity", () => {
		const key = "finding-update";
		const spaced = new BoundedAdviceDedupe(16);
		spaced.add(advice(NOTE, "concern", key), 1);
		expect(spaced.add(advice(NOTE, "concern", key), 5)).toBe(false);
		// The re-add moved lastDeliveryTurn to 5.
		expect(spaced.decide(advice(NOTE, "blocker", key), 8, POLICY)).toEqual({
			outcome: "suppress",
		});
		expect(spaced.decide(advice(NOTE, "blocker", key), 9, POLICY)).toEqual({
			outcome: "deliver",
			tag: "re-raised",
		});

		const maxed = new BoundedAdviceDedupe(16);
		maxed.add(advice(NOTE, "blocker", key), 1);
		maxed.add(advice(NOTE, "concern", key), 2);
		// If the stored severity had been lowered to concern, this blocker at
		// turn 9 would re-raise instead of suppressing.
		expect(maxed.decide(advice(NOTE, "blocker", key), 9, POLICY)).toEqual({
			outcome: "suppress",
		});
	});

	it("evicts the oldest key at capacity", () => {
		const dedupe = new BoundedAdviceDedupe(2);
		expect(dedupe.add(advice(NOTE, "concern", "key-1"), 1)).toBe(true);
		expect(dedupe.add(advice(NOTE, "concern", "key-2"), 1)).toBe(true);
		expect(dedupe.add(advice(NOTE, "concern", "key-3"), 1)).toBe(true);
		expect(dedupe.size).toBe(2);
		// The evicted key is unseen again; the two survivors stay suppressed.
		expect(dedupe.decide(advice(NOTE, "concern", "key-1"), 2, POLICY)).toEqual({ outcome: "deliver" });
		expect(dedupe.decide(advice(NOTE, "concern", "key-2"), 2, POLICY)).toEqual({ outcome: "suppress" });
		expect(dedupe.decide(advice(NOTE, "concern", "key-3"), 2, POLICY)).toEqual({ outcome: "suppress" });
	});

	it("round-trips signatures through hex export and restore", () => {
		const dedupe = new BoundedAdviceDedupe(16);
		const older = advice(NOTE, "blocker", "key-round");
		const newer = advice(NOTE, "concern", "key-round-2");
		dedupe.add(older, 7);
		dedupe.add(newer, 8);

		expect(dedupe.exportNewestEntries(1)).toEqual([
			{
				hash: newer.findingKeyHash,
				severity: "concern",
				signature: newer.signature.toString(16).padStart(16, "0"),
				lastDeliveryTurn: 8,
			},
		]);

		const exported = dedupe.exportNewestEntries(16);
		expect(exported.map((entry) => entry.hash)).toEqual([
			older.findingKeyHash,
			newer.findingKeyHash,
		]);

		const restored = new BoundedAdviceDedupe(16);
		restored.restoreEntries(exported);
		expect(restored.size).toBe(2);
		expect(restored.decide(advice(NOTE, "blocker", "key-round"), 9, POLICY)).toEqual({
			outcome: "suppress",
		});
		expect(restored.decide(advice(NOTE, "concern", "key-round-2"), 9, POLICY)).toEqual({
			outcome: "suppress",
		});
	});

	it("skips malformed persisted entries instead of failing the whole restore", () => {
		const dedupe = new BoundedAdviceDedupe(16);
		const entries: unknown[] = [
			null,
			"not an entry",
			{ hash: "short", severity: "blocker", signature: "0".repeat(16), lastDeliveryTurn: 1 },
			{
				hash: "a".repeat(64),
				severity: "blocker",
				signature: "not-hex",
				lastDeliveryTurn: 1,
			},
			{
				hash: "b".repeat(64),
				severity: "blocker",
				signature: "0".repeat(16),
				lastDeliveryTurn: -1,
			},
			{
				hash: "c".repeat(64),
				severity: "blocker",
				signature: "0".repeat(16),
				lastDeliveryTurn: 1,
			},
			// Turn 0 is legitimate: a note delivered into a running executor that has
			// not opened its first turn yet has no turn number to record.
			{
				hash: "d".repeat(64),
				severity: "blocker",
				signature: "0".repeat(16),
				lastDeliveryTurn: 0,
			},
			// A later duplicate must not overwrite the entry already restored.
			{
				hash: "c".repeat(64),
				severity: "concern",
				signature: "1".repeat(16),
				lastDeliveryTurn: 5,
			},
		];
		dedupe.restoreEntries(entries);
		expect(dedupe.size).toBe(2);
		expect(
			dedupe.exportNewestEntries(16).map((entry) => [entry.hash, entry.lastDeliveryTurn]),
		).toEqual([
			["c".repeat(64), 1],
			["d".repeat(64), 0],
		]);
	});

	it("exports nothing when the bound is zero", () => {
		const dedupe = new BoundedAdviceDedupe(16);
		dedupe.add(advice(NOTE, "concern", "key-zero"), 1);
		expect(dedupe.exportNewestEntries(0)).toEqual([]);
		expect(dedupe.exportNewestEntries(1)).toHaveLength(1);
	});
});
