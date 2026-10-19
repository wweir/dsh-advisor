import type {
	AssistantMessage,
	SessionEvent,
	ToolResultMessage,
	UserMessage,
} from "@deepseek-ai/dsh-session";

import { redactSecrets } from "./redaction.ts";

/**
 * One transcript line is capped. A single large tool result (a file dump, a test
 * log) would otherwise push every other line out of the bounded projection.
 */
export const TRANSCRIPT_LINE_CHARS = 4_000;

/**
 * Renders one session event as one transcript line, or `undefined` for events
 * that carry no model-visible work.
 *
 * The event data shapes are the harness's, not a uniform one: `user/message`
 * carries the message itself, while `assistant/message` and `tool/result` nest
 * it under `message`. Reading a nested message as a flat one drops every line
 * silently, which leaves the reviewer blind to the work it is meant to review.
 */
export function describeEvent(event: SessionEvent): string | undefined {
	switch (event.type) {
		case "user/message":
			return render("[user]", event.data);
		case "assistant/message":
			return render("[assistant]", event.data.message);
		case "tool/call":
			return bound(`[tool call] ${event.data.name} ${event.data.arguments}`);
		case "tool/result":
			return render(
				event.data.message.isError === true ? "[tool error]" : "[tool result]",
				event.data.message,
			);
		default:
			return undefined;
	}
}

function render(
	prefix: string,
	message: UserMessage | AssistantMessage | ToolResultMessage,
): string | undefined {
	const text = messageText(message);
	return text === undefined ? undefined : bound(`${prefix} ${text}`);
}

/** Flattens one message's content blocks to text. */
function messageText(message: UserMessage | AssistantMessage | ToolResultMessage): string | undefined {
	const parts: string[] = [];
	for (const block of message.content) {
		if (typeof block === "object" && block !== null) {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.length === 0 ? undefined : emptyAsUndefined(parts.join("\n"));
}

/** A content block that is empty is no evidence either; it only adds noise. */
function emptyAsUndefined(text: string): string | undefined {
	return text.trim().length === 0 ? undefined : text;
}

/**
 * Redacts, then clamps. The order matters: a secret cut mid-value by the clamp
 * loses the closing quote or `@` its redaction pattern requires, so clamping
 * first would leak the visible prefix of a credential that straddles the bound.
 */
function bound(line: string): string {
	const redacted = redactSecrets(line).text;
	if (redacted.length <= TRANSCRIPT_LINE_CHARS) return redacted;
	const dropped = redacted.length - TRANSCRIPT_LINE_CHARS;
	return `${redacted.slice(0, TRANSCRIPT_LINE_CHARS)}…[${dropped} chars truncated]`;
}
