/**
 * Message construction and inbox delivery for the Executor.
 *
 * @module dsh-advisor/host/delivery
 */

import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { UserMessage } from "@deepseek-ai/dsh-llm";

declare module "@deepseek-ai/dsh-llm/types" {
	interface MessageSourceMap {
		/**
		 * A message this plugin addressed to the Executor. `notice` is the host
		 * chat form that shows `summary` on the collapsed row; the full note stays
		 * in the expandable body. The kind still lets the advisor recognise its
		 * own input: it cancels idle follow-up for older notes and never triggers
		 * a new review.
		 */
		advisor: { kind: "advisor"; form: "notice"; summary: string };
	}
}

/**
 * Tags the delivered note as advisor input rather than a real user instruction.
 * `summary` is the one line the chat row shows while collapsed.
 */
export function createAdvisorMessage(text: string, summary: string): UserMessage {
	return createUserMessage({
		content: [{ type: "text", text }],
		source: { kind: "advisor", form: "notice", summary: boundContextSummary(summary) },
	});
}
