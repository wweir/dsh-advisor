import { describe, expect, it } from "vitest";

import {
	MAX_FINDING_LABEL_CHARACTERS,
	MAX_MUTE_ENTRIES,
	MuteStore,
	boundedFindingLabel,
} from "../src/policy/mutes.ts";
import { containsTerminalControlCharacters, redactSecrets } from "../src/policy/redaction.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function hashAt(index: number): string {
	return index.toString(16).padStart(64, "0");
}

describe("boundedFindingLabel", () => {
	it("trims and bounds the display label", () => {
		expect(boundedFindingLabel("  migration rollback defect  ")).toBe(
			"migration rollback defect",
		);
		expect(boundedFindingLabel("   ")).toBeUndefined();
		expect(boundedFindingLabel("")).toBeUndefined();
		const long = `x${"y".repeat(300)}`;
		const label = boundedFindingLabel(long);
		expect(label).toBeDefined();
		expect(Array.from(label ?? "")).toHaveLength(MAX_FINDING_LABEL_CHARACTERS);
	});

	it("redacts secrets and key blocks before the label is persisted", () => {
		expect(boundedFindingLabel("secret API_KEY=sk-live-12345 value")).toBe(
			"secret API_KEY=[REDACTED] value",
		);
		const keyBlock = `-----BEGIN RSA PRIVATE KEY-----\n${"MIIE".repeat(10)}`;
		expect(boundedFindingLabel(keyBlock)).toBe("[REDACTED]");
	});

	it("drops a redaction marker whole when the bound cuts through it", () => {
		// Truncating the raw key first cuts the secret to `sk-live-123`; redacting
		// that re-expands a full `[REDACTED]` marker, which then straddles the
		// 128-code-point bound. The label must drop the whole marker instead of
		// persisting a partial one that the next redaction pass would re-expand.
		const cut = `${"a".repeat(118)} API_KEY=sk-live-12345`;
		const label = boundedFindingLabel(cut);
		expect(label).toBeDefined();
		expect(Array.from(label ?? "").length).toBeLessThan(MAX_FINDING_LABEL_CHARACTERS);
		expect(label?.endsWith("API_KEY=")).toBe(true);
		expect(label).not.toContain("[REDACT");
		expect(label).not.toContain("sk-live");
		// The persisted label must be a redaction fixpoint: a resume of redaction
		// over it may not change it, or the restore validators would reject it.
		expect(redactSecrets(label ?? "").text).toBe(label);
	});

	it("neutralizes terminal control characters in single-line labels", () => {
		const label = boundedFindingLabel("defect\nrollback\x1b[31mred");
		expect(label).toBeDefined();
		expect(label).not.toContain("\n");
		expect(containsTerminalControlCharacters(label ?? "")).toBe(false);
	});
});

describe("MuteStore", () => {
	it("matches exact findingKeyHash values only", () => {
		const store = new MuteStore([{ hash: HASH_A, label: "alpha" }]);
		expect(store.isMuted(HASH_A)).toBe(true);
		// A short prefix is not a mute: only the full hash identifies a finding.
		expect(store.isMuted(HASH_A.slice(0, 8))).toBe(false);
		expect(store.list()).toEqual([{ hash: HASH_A, label: "alpha" }]);
	});

	it("keeps the newest mute entries at the fixed capacity", () => {
		const store = new MuteStore(
			Array.from({ length: MAX_MUTE_ENTRIES + 2 }, (_, index) => ({
				hash: hashAt(index),
				label: `muted-${String(index)}`,
			})),
		);
		const entries = store.list();
		expect(entries).toHaveLength(MAX_MUTE_ENTRIES);
		expect(entries[0]?.label).toBe("muted-2");
		expect(entries.at(-1)?.label).toBe(`muted-${String(MAX_MUTE_ENTRIES + 1)}`);
	});

	it("replaces the whole list, keeping only redaction-stable entries", () => {
		const store = new MuteStore();
		store.replace([
			{ hash: HASH_A, label: "alpha" },
			{ hash: HASH_B, label: "beta" },
			// Rejected on load: a label that carries key material would be
			// re-persisted and displayed.
			{ hash: hashAt(3), label: " API_KEY=sk-live-12345 " },
			{ hash: hashAt(4), label: "line\nbreak" },
			{ hash: hashAt(5), label: "" },
			{ hash: "short", label: "not a hash" },
			{ hash: hashAt(6), label: "extra key", extra: true },
		]);
		expect(store.list()).toEqual([
			{ hash: HASH_A, label: "alpha" },
			{ hash: HASH_B, label: "beta" },
		]);
		expect(store.isMuted(HASH_A)).toBe(true);
		store.replace([]);
		expect(store.isMuted(HASH_A)).toBe(false);
	});
});
