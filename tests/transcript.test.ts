import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@deepseek-ai/dsh-session";

import {
	describeEvent,
	reviewedBoundaryIndex,
	TRANSCRIPT_LINE_CHARS,
} from "../src/policy/transcript.ts";

/**
 * Event data shapes below are copied from real `session.v4.jsonl` entries: only
 * `user/message` carries its message at the top level, while `assistant/message`
 * and `tool/result` nest it under `message`.
 */
function event(type: string, data: unknown): SessionEvent {
	return { type, data } as unknown as SessionEvent;
}

function message(content: string, extra: Record<string, unknown> = {}): unknown {
	return { id: "m1", role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: content }], ...extra };
}

/** A real user message: the role and the source are what make it one. */
function userMessage(content: string): unknown {
	return { ...(message(content) as Record<string, unknown>), role: "user", source: { kind: "user" } };
}

function describeOne(type: string, data: unknown): string | undefined {
	return describeEvent(event(type, data));
}

describe("describeEvent", () => {
	it("renders a user message, whose data is the message itself", () => {
		expect(describeOne("user/message", userMessage("run the tests"))).toBe("[user] run the tests");
	});

	it("unwraps the message nested in an assistant/message", () => {
		expect(describeOne("assistant/message", { turn: 1, step: 2, message: message("Done."), stream: [] })).toBe(
			"[assistant] Done.",
		);
	});

	it("unwraps the message nested in a tool/result and marks failures", () => {
		expect(
			describeOne("tool/result", { turn: 1, step: 2, message: message("42 passed") }),
		).toBe("[tool result] 42 passed");
		expect(
			describeOne("tool/result", {
				turn: 1,
				step: 2,
				message: message("exit code 1", { isError: true }),
			}),
		).toBe("[tool error] exit code 1");
	});

	it("names the command a tool call ran", () => {
		expect(
			describeOne("tool/call", {
				turn: 1,
				step: 2,
				callId: "call_1",
				name: "bash",
				arguments: '{"command":"pnpm test"}',
			}),
		).toBe('[tool call] bash {"command":"pnpm test"}');
	});

	it("has no line for events that carry no work", () => {
		expect(describeOne("step/start", { turn: 1, step: 2 })).toBeUndefined();
		expect(describeOne("assistant/message", { turn: 1, step: 2, message: message(""), stream: [] })).toBeUndefined();
	});

	it("bounds a line to the transcript budget and keeps the rest of the window", () => {
		const line = describeOne("tool/result", { turn: 1, step: 2, message: message("x".repeat(10_000)) }) ?? "";
		expect(line.length).toBeLessThan(TRANSCRIPT_LINE_CHARS + 64);
		expect(line).toContain("chars truncated");
	});

	it("redacts a secret that straddles the line bound instead of cutting it open", () => {
		// The clamp used to run first, so a quoted credential cut mid-value lost the
		// closing quote its redaction pattern needs and leaked its visible prefix.
		const secret = "correct-horse-battery-staple-very-secret";
		const line = describeOne("tool/result", {
			turn: 1,
			step: 2,
			message: message(`password = "${secret}${"x".repeat(5_000)}"`),
		}) ?? "";
		expect(line).toContain("[REDACTED]");
		expect(line).not.toContain(secret);
	});
});

describe("reviewedBoundaryIndex", () => {
	it("marks the compose point when nothing was trimmed", () => {
		// 90 lines were buffered at compose, 10 appended since: the review's
		// material ends at index 90 of the 100-line buffer.
		expect(reviewedBoundaryIndex(100, 10)).toBe(90);
	});

	it("keeps the boundary even when a full buffer trimmed old lines meanwhile", () => {
		// A 400-line buffer at compose, 10 more lines through a cap of 400: every
		// index moved down by the 10 dropped lines, so the boundary is index 390
		// and the 10 lines appended during the review stay after it.
		expect(reviewedBoundaryIndex(400, 10)).toBe(390);
	});

	it("claims everything buffered as new when the review's material was dropped", () => {
		expect(reviewedBoundaryIndex(400, 500)).toBe(0);
	});

	it("treats a nonsensical negative append count as nothing appended", () => {
		expect(reviewedBoundaryIndex(5, -3)).toBe(5);
	});
});
