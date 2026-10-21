import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { Config, toAdvisorConfig, type AdvisorPluginConfig } from "../src/index.ts";
import { ConfigOverridesStore } from "../src/host/config-store.ts";
import { SessionObserver } from "../src/host/subscription.ts";
import { applyConfigPatch, toConfigPatch, type AdvisorConfigPatch } from "../src/policy/overrides.ts";

const stateRoot = mkdtempSync(join(tmpdir(), "advisor-row-config-"));
afterAll(() => rmSync(stateRoot, { recursive: true, force: true }));

/**
 * The row is the only surface that can name a shadowed system-prompt section,
 * so the row → plugin path must carry it through: the schema accepts it, the
 * conversion keeps it, and a page save cannot drop it.
 */
/** The host validates a row config through the standard schema interface. */
function parseRow(value: unknown): AdvisorPluginConfig {
	const result = Config["~standard"].validate(value) as { value?: AdvisorPluginConfig };
	if (result.value === undefined) throw new Error("the row config did not validate");
	return result.value;
}

describe("the row's shadowed sections", () => {
	it("survives the row config into the effective configuration", () => {
		const row = parseRow({
			enabled: true,
			model: { provider: "p", model: "m" },
			prompt: { shadowedSections: ["memory:guide"] },
		});
		const effective = toAdvisorConfig(row);
		expect(effective.prompt.shadowedSections).toEqual(["memory:guide"]);
	});

	it("defaults to no shadowed section", () => {
		const row = parseRow({ enabled: true, model: { provider: "p", model: "m" } });
		const effective = toAdvisorConfig(row);
		expect(effective.prompt.shadowedSections).toEqual([]);
	});

	it("survives a real store round-trip", async () => {
		const row = parseRow({
			enabled: true,
			model: { provider: "p", model: "m" },
			prompt: { shadowedSections: ["memory:guide"] },
		});
		const base = toAdvisorConfig(row);
		const store = new ConfigOverridesStore(stateRoot);
		// The page edits its own fields, so the saved patch comes from a
		// different configuration than the row's.
		await store.save(toConfigPatch({ ...base, review: { ...base.review, everySteps: 4 } }));
		const loaded = store.load();
		expect(loaded.kind).toBe("present");
		if (loaded.kind !== "present") return;
		// The store really did write the page's edit...
		expect(loaded.patch.review?.everySteps).toBe(4);
		// ...and the row's shadowed sections are still there after the merge.
		const effective = applyConfigPatch(base, loaded.patch);
		expect(effective.prompt.shadowedSections).toEqual(["memory:guide"]);
	});

	it("survives a page save", async () => {
		const row = parseRow({
			enabled: true,
			model: { provider: "p", model: "m" },
			prompt: { shadowedSections: ["memory:guide"] },
		});
		const base = toAdvisorConfig(row);
		// The page edits its own fields, so the saved patch differs from the row.
		const saved = toConfigPatch({ ...base, review: { ...base.review, everySteps: 4 } });
		expect("prompt" in saved).toBe(false);
		expect(saved.review?.everySteps).toBe(4);
		// The row's shadowed sections are not in the patch, and the merge must
		// not lose them.
		expect(applyConfigPatch(base, saved).prompt.shadowedSections).toEqual(["memory:guide"]);
		// A patch that tries to clear them is ignored: the row owns them.
		const sneaky = { prompt: { shadowedSections: [] } } as unknown as AdvisorConfigPatch;
		expect(applyConfigPatch(base, sneaky).prompt.shadowedSections).toEqual(["memory:guide"]);
	});

	it("keeps the row's shadowed sections through the page-save handler", async () => {
		const row = parseRow({
			enabled: true,
			model: { provider: "p", model: "m" },
			prompt: { shadowedSections: ["memory:guide"] },
		});
		const base = toAdvisorConfig(row);
		const observer = new SessionObserver({
			ctx: {
				logger: () => ({ warn: (): void => {} }),
				on: (): (() => void) => () => {},
				inject: (): void => {},
			} as never,
			config: base,
			stateRoot: stateRoot,
		});
		// The page's own edit goes through the real handler: it persists, and it
		// replaces the live configuration. The edit also tries to clear the
		// row's shadowed sections — the handler must not honour that.
		const next = await observer.configure({
			review: { everySteps: 4 },
			prompt: { shadowedSections: [] },
		} as unknown as AdvisorConfigPatch);
		expect(next.review.everySteps).toBe(4);
		expect(next.prompt.shadowedSections).toEqual(["memory:guide"]);
		// The persisted file holds the page's edit, and a reload over the row
		// still has the row's shadowed sections.
		const loaded = new ConfigOverridesStore(stateRoot).load();
		expect(loaded.kind).toBe("present");
		if (loaded.kind !== "present") return;
		// The persisted patch does not carry the row's sections...
		expect("prompt" in loaded.patch).toBe(false);
		// ...and the merge over the row brings them back.
		expect(applyConfigPatch(base, loaded.patch).prompt.shadowedSections).toEqual(["memory:guide"]);
	});
});
