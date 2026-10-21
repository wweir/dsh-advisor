import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@deepseek-ai/dsh-session";

import {
	TRANSCRIPT_LINE_LIMIT,
	TranscriptBuffer,
} from "../src/policy/transcript-buffer.ts";
import { renderTrace } from "../src/policy/transcript.ts";

function event(type: string, data: unknown, seq: number): SessionEvent {
	return { type, data, seq, time: 0 } as unknown as SessionEvent;
}

function message(content: string, extra: Record<string, unknown> = {}): unknown {
	return {
		id: `m${String(Math.random())}`,
		role: "assistant",
		source: { kind: "model" },
		content: [{ type: "text", text: content }],
		...extra,
	};
}

function userMessage(content: string, extra: Record<string, unknown> = {}): unknown {
	return {
		...(message(content) as Record<string, unknown>),
		role: "user",
		source: { kind: "user" },
		...extra,
	};
}

function call(seq: number, callId: string, name: string, args: unknown): SessionEvent {
	return event("tool/call", { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) }, seq);
}

function result(seq: number, callId: string, text: string, isError = false): SessionEvent {
	return event(
		"tool/result",
		{ turn: 1, step: 1, message: message(text, { role: "tool", toolCallId: callId, isError }) },
		seq,
	);
}

describe("TranscriptBuffer", () => {
	it("pairs a result with the call that names its tool", () => {
		const buffer = new TranscriptBuffer();
		buffer.append(call(1, "c1", "read", { file_path: "src/a.ts" }));
		buffer.append(result(2, "c1", "1: one\n2: two\n"));

		// The pointer needs the call's path, which only the pairing table knows.
		expect(buffer.entries[1]?.evidence).toContain("[tool result] read src/a.ts");
		expect(buffer.lastSeq()).toBe(2);
	});

	it("keeps the newest lines up to its limit", () => {
		const buffer = new TranscriptBuffer(3);
		for (let seq = 1; seq <= 5; seq++) buffer.append(event("user/message", userMessage(`line ${String(seq)}`), seq));

		expect(buffer.entries.map((entry) => entry.seq)).toEqual([3, 4, 5]);
	});

	it("rejects a nonsensical limit", () => {
		expect(() => new TranscriptBuffer(0)).toThrow(RangeError);
		expect(() => new TranscriptBuffer(1.5)).toThrow(RangeError);
	});

	it("drops the lines a compaction replaced and records its summary", () => {
		const buffer = new TranscriptBuffer();
		buffer.append(event("user/message", userMessage("first"), 1));
		buffer.append(event("assistant/message", { turn: 1, step: 1, message: message("second"), stream: [] }, 2));

		expect(
			buffer.absorb(
				event(
					"compaction/summary",
					{ compactionId: "cmp_1", shadowedSeqs: [1, 2], summary: [{ type: "text", text: "the summary" }] },
					3,
				),
			),
		).toBe(true);

		expect(buffer.entries.map((entry) => entry.seq)).toEqual([3]);
		expect(buffer.entries[0]?.evidence).toBe("[compaction summary] the summary");
	});

	it("drops shadowed lines in place, so an earlier read sees the compaction", () => {
		// The getter hands out the live array; replacing it would leave a consumer that
		// read the buffer before the compaction composing a stale projection.
		const buffer = new TranscriptBuffer();
		buffer.append(event("user/message", userMessage("first"), 1));
		buffer.append(event("user/message", userMessage("second"), 2));
		const before = buffer.entries;

		buffer.absorb(event("compaction/prune", { shadowedSeqs: [1], shadowedTokenCount: 10 }, 3));

		expect(before.map((entry) => entry.seq)).toEqual([2]);
	});

	it("drops shadowed lines for a prune without adding a line", () => {
		const buffer = new TranscriptBuffer();
		buffer.append(event("user/message", userMessage("first"), 1));
		buffer.append(event("user/message", userMessage("second"), 2));

		expect(buffer.absorb(event("compaction/prune", { shadowedSeqs: [1], shadowedTokenCount: 10 }, 3))).toBe(true);
		expect(buffer.entries.map((entry) => entry.seq)).toEqual([2]);
	});

	it("re-keys a summary line to the checkpoint that is its surface node", () => {
		// The summary event is log-only; the surface node a later compaction can shadow
		// is the checkpoint message that follows. Keeping the summary's own seq would
		// leave the line behind on every later compaction.
		const buffer = new TranscriptBuffer();
		buffer.absorb(
			event("compaction/summary", { compactionId: "cmp_1", shadowedSeqs: [], summary: [{ type: "text", text: "s" }] }, 1),
		);
		const checkpoint = event(
			"user/message",
			userMessage("framed summary", { source: { kind: "compact-checkpoint", compactionId: "cmp_1" } }),
			2,
		);
		expect(buffer.absorb(checkpoint)).toBe(true);
		expect(buffer.entries).toHaveLength(1);
		expect(buffer.entries[0]?.seq).toBe(2);

		// The next compaction shadows surface seq 2 (not the log-only seq 1).
		buffer.absorb(event("compaction/prune", { shadowedSeqs: [2], shadowedTokenCount: 10 }, 3));
		expect(buffer.entries).toHaveLength(0);
	});

	it("records the checkpoint when the summary event had no visible text", () => {
		// A reasoning-only or empty summary leaves no line; dropping the checkpoint too
		// would delete the shadowed work without any record that a compaction ran.
		const buffer = new TranscriptBuffer();
		buffer.append(event("user/message", userMessage("work being compressed"), 1));
		buffer.absorb(event("compaction/summary", { compactionId: "cmp_1", shadowedSeqs: [1], summary: [] }, 2));
		expect(buffer.entries).toHaveLength(0);

		const checkpoint = event(
			"user/message",
			userMessage("framed summary", { source: { kind: "compact-checkpoint", compactionId: "cmp_1" } }),
			3,
		);
		expect(buffer.absorb(checkpoint)).toBe(true);
		expect(buffer.entries).toHaveLength(1);
		expect(buffer.entries[0]?.kind).toBe("compaction");
		expect(buffer.entries[0]?.seq).toBe(3);
	});

	it("keeps seqs ascending when a checkpoint arrives after later lines", () => {
		// The line must move to the tail, not merely change its seq in place: the
		// boundary split walks the array and depends on ascending seqs.
		const buffer = new TranscriptBuffer();
		buffer.absorb(
			event("compaction/summary", { compactionId: "cmp_1", shadowedSeqs: [], summary: [{ type: "text", text: "s" }] }, 1),
		);
		buffer.append(event("user/message", userMessage("after the summary"), 2));
		buffer.absorb(
			event(
				"user/message",
				userMessage("framed summary", { source: { kind: "compact-checkpoint", compactionId: "cmp_1" } }),
				3,
			),
		);

		expect(buffer.entries.map((entry) => entry.seq)).toEqual([2, 3]);
		expect(buffer.boundaryIndex(2)).toBe(1);
		expect(buffer.lastSeq()).toBe(3);
	});

	it("falls back to the checkpoint when the ring evicted its summary line", () => {
		const buffer = new TranscriptBuffer(1);
		buffer.absorb(
			event("compaction/summary", { compactionId: "cmp_1", shadowedSeqs: [], summary: [{ type: "text", text: "s" }] }, 1),
		);
		// The one-line ring drops the summary before its checkpoint arrives.
		buffer.append(event("user/message", userMessage("later work"), 2));
		buffer.absorb(
			event(
				"user/message",
				userMessage("framed summary", { source: { kind: "compact-checkpoint", compactionId: "cmp_1" } }),
				3,
			),
		);

		expect(buffer.entries).toHaveLength(1);
		expect(buffer.entries[0]?.kind).toBe("compaction");
		expect(buffer.entries[0]?.seq).toBe(3);
	});

	it("renders an orphan checkpoint (no summary event seen) on its own", () => {
		const buffer = new TranscriptBuffer();
		buffer.absorb(
			event(
				"user/message",
				userMessage("orphan summary", { source: { kind: "compact-checkpoint", compactionId: "cmp_2" } }),
				3,
			),
		);
		expect(buffer.entries).toHaveLength(1);
		expect(buffer.entries[0]?.kind).toBe("compaction");
	});

	it("passes ordinary events through absorb()", () => {
		const buffer = new TranscriptBuffer();
		expect(buffer.absorb(event("user/message", userMessage("hello"), 1))).toBe(false);
		expect(buffer.entries).toHaveLength(0);
	});

	it("marks the boundary after the last seq a completed review read", () => {
		const buffer = new TranscriptBuffer();
		for (let seq = 1; seq <= 4; seq++) buffer.append(event("user/message", userMessage(`line ${String(seq)}`), seq));

		expect(buffer.boundaryIndex(0)).toBe(0);
		expect(buffer.boundaryIndex(2)).toBe(2);
		expect(buffer.boundaryIndex(4)).toBe(4);
		expect(buffer.boundaryIndex(99)).toBe(4);
	});

	it("keeps the degraded trace rendering for a result in the reviewed zone", () => {
		const buffer = new TranscriptBuffer();
		buffer.append(result(1, "missing", "subagent says: pass"));
		const trace = buffer.entries[0];
		expect(trace === undefined ? "" : renderTrace(trace)).toContain("body omitted (reviewed earlier)");
	});

	it("is sized for the 64K evidence cap", () => {
		// 900 lines ≈ 230 steps at the measured cadence; the comment in the module
		// explains the pairing with the cap, this pins the number.
		expect(TRANSCRIPT_LINE_LIMIT).toBe(900);
	});
});
