/**
 * Dropping a system-prompt section from one agent.
 *
 * A section registered in an agent's own scope replaces the global section of
 * the same name for that agent alone, and an empty text leaves it out of the
 * rendered prompt. That is how the review child drops a memory plugin's guide:
 * the reviewer has no memory tools, so the guide is dead text in front of the
 * review prompt — exactly where the provider's prefix cache is won or lost.
 *
 * @module dsh-advisor/policy/prompt-shadow
 */

import type { Context } from "@deepseek-ai/cordis";

/**
 * Shadows the named sections in the given context's scope. The registration
 * lives as long as that scope, so the caller passes the child's own creation
 * context: a scope that outlives the child would strip the section from every
 * later agent instead of from this one review.
 *
 * @param ctx - the context whose scope owns the shadow.
 * @param names - the sections to drop; nothing happens when the list is empty.
 * @returns the names that were shadowed, or `undefined` when the context has no
 *   system-prompt service and nothing could be shadowed.
 */
export function shadowPromptSections(
	ctx: Pick<Context, "get">,
	names: readonly string[],
): readonly string[] | undefined {
	if (names.length === 0) return [];
	const systemPrompt = ctx.get("systemPrompt");
	if (systemPrompt === undefined || typeof systemPrompt.section !== "function") return undefined;
	for (const name of names) {
		// The host replaces a section by name, so the order only decides where an
		// empty section would have sat; it never renders.
		systemPrompt.section({ name, order: 0, text: "" });
	}
	return names;
}
