import { describe, expect, it } from "vitest";

import { DEFAULT_ADVISOR_CONFIG, type AdvisorConfig } from "../src/policy/config.ts";
import {
	applyConfigPatch,
	describeConfig,
	parseConfigPatch,
	toConfigPatch,
	type AdvisorConfigPatch,
} from "../src/policy/overrides.ts";

const base: AdvisorConfig = {
	...DEFAULT_ADVISOR_CONFIG,
	enabled: true,
	model: { provider: "ollama-cloud", model: "deepseek-v4.1-flash:1017" },
	security: { additionalProtectedPaths: ["/etc/secrets"] },
};

describe("parseConfigPatch", () => {
	it("accepts the fields the page edits", () => {
		const result = parseConfigPatch({
			enabled: false,
			model: { provider: "p", model: "m", reasoningEffort: "low" },
			instructions: "look for races",
			review: { everyTurns: 2, maxContextTokens: 8000 },
			delivery: { activeIdleSeverities: ["blocker"] },
		});
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.patch.review).toEqual({ everyTurns: 2, maxContextTokens: 8000 });
		expect(result.patch.model).toEqual({ provider: "p", model: "m", reasoningEffort: "low" });
	});

	it("rejects values the loader schema would reject", () => {
		expect(parseConfigPatch({ review: { everyTurns: 0 } })).toMatchObject({ kind: "invalid" });
		expect(parseConfigPatch({ review: { maxContextTokens: 1.5 } })).toMatchObject({ kind: "invalid" });
		expect(parseConfigPatch({ model: { provider: "", model: "m" } })).toMatchObject({ kind: "invalid" });
		expect(parseConfigPatch({ model: { provider: "p", model: "m", reasoningEffort: "huge" } })).toMatchObject({
			kind: "invalid",
		});
		expect(parseConfigPatch({ delivery: { activeIdleSeverities: ["nit"] } })).toMatchObject({
			kind: "invalid",
		});
	});

	it("rejects unknown fields instead of ignoring them", () => {
		expect(parseConfigPatch({ review: { maxPending: 3 } })).toMatchObject({ kind: "invalid" });
		expect(parseConfigPatch({ security: { additionalProtectedPaths: [] } })).toMatchObject({
			kind: "invalid",
		});
		expect(parseConfigPatch([])).toMatchObject({ kind: "invalid" });
	});
});

describe("applyConfigPatch", () => {
	it("merges the patch over the row configuration", () => {
		const next = applyConfigPatch(base, {
			enabled: false,
			instructions: "x",
			review: { everyTurns: 3 },
			delivery: { activeIdleSeverities: ["concern"] },
		});
		expect(next.enabled).toBe(false);
		expect(next.instructions).toBe("x");
		expect(next.review).toEqual({ ...base.review, everyTurns: 3 });
		expect(next.delivery.activeIdleSeverities).toEqual(["concern"]);
		expect(next.model).toEqual(base.model);
	});

	it("keeps a row-configured reasoning effort when the page saves only provider/model", () => {
		const withEffort: AdvisorConfig = {
			...base,
			model: { provider: "ollama-cloud", model: "deepseek-v4.1-flash:1017", reasoningEffort: "low" },
		};
		const next = applyConfigPatch(withEffort, {
			model: { provider: "ollama-cloud", model: "deepseek-v4.1-flash:1017" },
			review: { everyTurns: 4 },
		});
		expect(next.model?.reasoningEffort).toBe("low");
		const overridden = applyConfigPatch(withEffort, {
			model: { provider: "p", model: "m", reasoningEffort: "high" },
		});
		expect(overridden.model?.reasoningEffort).toBe("high");
	});

	it("never lets the page loosen the protected-path floor", () => {
		expect(applyConfigPatch(base, {}).security).toEqual(base.security);
		// The parser rejects a `security` key, but the floor must hold even for a
		// patch object that never went through it.
		const sneaky = { security: { additionalProtectedPaths: [] } } as unknown as AdvisorConfigPatch;
		expect(applyConfigPatch(base, sneaky).security).toEqual(base.security);
	});

	it("keeps the row model when the patch does not set one", () => {
		const { model: _model, ...withoutModel } = base;
		const next = applyConfigPatch(withoutModel, { review: { everyTurns: 2 } });
		expect(next.model).toBeUndefined();
	});
});

describe("describeConfig", () => {
	it("projects the editable fields only", () => {
		const view = describeConfig(base);
		expect(view).toEqual({
			enabled: true,
			model: base.model,
			instructions: base.instructions,
			review: base.review,
			delivery: { activeIdleSeverities: ["concern", "blocker"] },
		});
		expect("security" in view).toBe(false);
	});
});

describe("strict model and bound validation", () => {
	it("rejects an unknown model field instead of silently ignoring a typo", () => {
		expect(
			parseConfigPatch({ model: { provider: "p", model: "m", reasoningEffrot: "high" } }),
		).toMatchObject({ kind: "invalid" });
	});

	it("rejects whitespace-only route names", () => {
		expect(parseConfigPatch({ model: { provider: "  ", model: "m" } })).toMatchObject({
			kind: "invalid",
		});
	});

	it("bounds what the page can persist and re-render in every poll", () => {
		expect(parseConfigPatch({ instructions: "x".repeat(20_001) })).toMatchObject({ kind: "invalid" });
		expect(parseConfigPatch({ review: { everyTurns: 1_001 } })).toMatchObject({ kind: "invalid" });
		expect(parseConfigPatch({ review: { timeoutMs: 3_600_001 } })).toMatchObject({ kind: "invalid" });
	});

	it("lets the page clear an inherited effort with an explicit null", () => {
		const row: AdvisorConfig = {
			...base,
			model: { provider: "p", model: "m", reasoningEffort: "high" },
		};
		const parsed = parseConfigPatch({
			model: { provider: "p", model: "m", reasoningEffort: null },
		});
		expect(parsed.kind).toBe("ok");
		if (parsed.kind !== "ok") return;
		const next = applyConfigPatch(row, parsed.patch);
		expect(next.model).toEqual({ provider: "p", model: "m" });
	});
});

describe("toConfigPatch", () => {
	it("round-trips a partial save so a restart reproduces what the page showed", () => {
		const row: AdvisorConfig = {
			...base,
			model: { provider: "p", model: "m", reasoningEffort: "high" },
		};
		// A caller that only changed one field: the persisted projection must still
		// carry every page-owned field, or the rest reverts to the row on reload.
		const next = applyConfigPatch(row, { review: { everyTurns: 4 } });
		const persisted = parseConfigPatch(toConfigPatch(next));
		expect(persisted.kind).toBe("ok");
		if (persisted.kind !== "ok") return;
		const reloaded = applyConfigPatch(row, persisted.patch);
		expect(reloaded).toEqual(next);
		expect(reloaded.model).toEqual({ provider: "p", model: "m", reasoningEffort: "high" });
	});
});
