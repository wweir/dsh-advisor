import { describe, expect, it } from "vitest";

import { Config, toAdvisorConfig, type AdvisorPluginConfig } from "../src/index.ts";
import { applyConfigPatch, toConfigPatch } from "../src/policy/overrides.ts";

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

	it("survives a page save", () => {
		const row = parseRow({
			enabled: true,
			model: { provider: "p", model: "m" },
			prompt: { shadowedSections: ["memory:guide"] },
		});
		const base = toAdvisorConfig(row);
		// A page save writes the page-owned projection; the row's shadowed
		// sections are not in it, and the next load must not lose them.
		const saved = toConfigPatch(base);
		expect(applyConfigPatch(base, saved).prompt.shadowedSections).toEqual(["memory:guide"]);
	});
});
