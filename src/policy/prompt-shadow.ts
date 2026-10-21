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

/**
 * The system-prompt service as the caller sees it. It is a host service
 * (`@deepseek-ai/dsh-system-prompt`), not one this plugin owns, so only the one
 * method used here is declared.
 */
export interface SystemPromptService {
	section?: (section: { name: string; order: number; text: string }) => unknown;
}

/**
 * Shadows the named sections in the given context's scope.
 *
 * @param ctx - the context whose scope owns the shadow.
 * @param names - the sections to drop; nothing happens when the list is empty.
 * @returns the names that were shadowed, or `undefined` when the context has no
 *   system-prompt service and nothing could be shadowed.
 */
export function shadowPromptSections(
	ctx: { get: (key: string) => unknown },
	names: readonly string[],
): readonly string[] | undefined {
	if (names.length === 0) return [];
	const systemPrompt = ctx.get("systemPrompt") as SystemPromptService | undefined;
	if (systemPrompt === undefined || typeof systemPrompt.section !== "function") return undefined;
	for (const name of names) {
		// The order only decides where an empty section would have sat; a
		// shadowed section has no text and never renders.
		systemPrompt.section({ name, order: 0, text: "" });
	}
	return names;
}
