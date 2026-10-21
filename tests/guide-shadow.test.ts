import { Context } from "@deepseek-ai/cordis";
import { createScope, scopeOf } from "@deepseek-ai/dsh-scope";
import { SystemPrompt, renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import { describe, expect, it } from "vitest";

import { shadowPromptSections } from "../src/policy/prompt-shadow.ts";

/**
 * The review child has no memory tools, so a memory plugin's system-prompt
 * section is dead text in front of the review prompt. The advisor shadows it in
 * the child's scope; these tests pin the host behaviour that makes that work,
 * so the shadow cannot silently become a no-op — and cannot turn global, which
 * would strip the guide from every agent in the process.
 */
describe("review child guide shadow", () => {
	it("a scoped section replaces the global one of the same name", async () => {
		const ctx = new Context();
		await ctx.plugin(SystemPrompt, {});
		const systemPrompt = ctx.get("systemPrompt");
		if (systemPrompt === undefined) throw new Error("the system-prompt service is missing");
		// A memory plugin registers its guide globally.
		systemPrompt.section({ name: "memory:guide", order: 130, text: "GUIDE TEXT" });

		const scope = createScope(ctx, { id: "review-child" });
		const scopedPrompt = scope.ctx.get("systemPrompt");
		if (scopedPrompt === undefined) throw new Error("the scoped system-prompt service is missing");
		// The shadow's own order differs from the global section's: the shadow
		// replaces the section by name, not by position.
		scopedPrompt.section({ name: "memory:guide", order: 0, text: "" });

		const scopeKey = scopeOf(scope.ctx);
		if (scopeKey === undefined) throw new Error("the scope carries no key");
		const scoped = await systemPrompt.assemble({ scope: scopeKey });
		const global = await systemPrompt.assemble({});

		// The shadowed section is present but empty; the rendered prompt drops
		// it, which is what the review child actually sees.
		expect(renderPrompt(global)).toContain("GUIDE TEXT");
		expect(renderPrompt(scoped)).not.toContain("GUIDE TEXT");
	});

	it("shadows the named sections in the caller's scope only", async () => {
		const ctx = new Context();
		await ctx.plugin(SystemPrompt, {});
		const systemPrompt = ctx.get("systemPrompt");
		if (systemPrompt === undefined) throw new Error("the system-prompt service is missing");
		systemPrompt.section({ name: "memory:guide", order: 130, text: "GUIDE TEXT" });

		const scope = createScope(ctx, { id: "review-child" });
		expect(shadowPromptSections(scope.ctx, ["memory:guide"])).toEqual(["memory:guide"]);

		const scopeKey = scopeOf(scope.ctx);
		if (scopeKey === undefined) throw new Error("the scope carries no key");
		const scoped = await systemPrompt.assemble({ scope: scopeKey });
		const global = await systemPrompt.assemble({});

		// The review child loses the guide; every other agent keeps it.
		expect(renderPrompt(scoped)).not.toContain("GUIDE TEXT");
		expect(renderPrompt(global)).toContain("GUIDE TEXT");
	});

	it("reports that nothing could be shadowed without a system-prompt service", () => {
		const ctx = { get: (): unknown => undefined };
		expect(shadowPromptSections(ctx, ["memory:guide"])).toBeUndefined();
	});

	it("an empty list shadows nothing", async () => {
		const ctx = new Context();
		await ctx.plugin(SystemPrompt, {});
		const systemPrompt = ctx.get("systemPrompt");
		if (systemPrompt === undefined) throw new Error("the system-prompt service is missing");
		systemPrompt.section({ name: "memory:guide", order: 130, text: "GUIDE TEXT" });

		const scope = createScope(ctx, { id: "review-child" });
		expect(shadowPromptSections(scope.ctx, [])).toEqual([]);

		const scopeKey = scopeOf(scope.ctx);
		if (scopeKey === undefined) throw new Error("the scope carries no key");
		const scoped = await systemPrompt.assemble({ scope: scopeKey });
		// Nothing was shadowed, so the guide is still there.
		expect(renderPrompt(scoped)).toContain("GUIDE TEXT");
	});

	it("writes one empty section per named section", () => {
		const written: { name: string; text: string }[] = [];
		const ctx = {
			get: (): unknown => ({
				section: (section: { name: string; text: string }): void => {
					written.push({ name: section.name, text: section.text });
				},
			}),
		};
		expect(shadowPromptSections(ctx, ["memory:guide", "other:guide"])).toEqual([
			"memory:guide",
			"other:guide",
		]);
		expect(written).toEqual([
			{ name: "memory:guide", text: "" },
			{ name: "other:guide", text: "" },
		]);
	});
});
