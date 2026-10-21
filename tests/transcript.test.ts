import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@deepseek-ai/dsh-session";

import {
	blocksText,
	boundEntries,
	boundaryIndexFor,
	callTarget,
	checkpointCompactionId,
	checkpointEntry,
	compactionUpdate,
	describeEvent,
	isCompactionCheckpoint,
	linesOf,
	renderEvidence,
	renderTrace,
	TRANSCRIPT_LINE_CHARS,
	type ToolCallInfo,
	type TranscriptContext,
	type TranscriptEntry,
} from "../src/policy/transcript.ts";

/**
 * Event data shapes below are copied from real `session.v4.jsonl` entries: only
 * `user/message` carries its message at the top level, while `assistant/message`
 * and `tool/result` nest it under `message`.
 */
function event(type: string, data: unknown, seq = 1): SessionEvent {
	return { type, data, seq, time: 0 } as unknown as SessionEvent;
}

function message(content: string, extra: Record<string, unknown> = {}): unknown {
	return { id: "m1", role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: content }], ...extra };
}

/** A real user message: the role and the source are what make it one. */
function userMessage(content: string, source: Record<string, unknown> = { kind: "user" }): unknown {
	return { ...(message(content) as Record<string, unknown>), role: "user", source };
}

function describeOne(type: string, data: unknown, context: TranscriptContext = {}): TranscriptEntry | undefined {
	return describeEvent(event(type, data), context);
}

/** The context a result needs: the call that produced it, by call id. */
function paired(info: ToolCallInfo): TranscriptContext {
	return { call: (callId) => (callId === "call_1" ? info : undefined) };
}

function result(text: string, callId = "call_1", isError = false): unknown {
	return { turn: 1, step: 2, message: message(text, { toolCallId: callId, isError, role: "tool" }) };
}

describe("describeEvent", () => {
	it("renders a user message, whose data is the message itself", () => {
		expect(describeOne("user/message", userMessage("run the tests"))?.evidence).toBe("[user] run the tests");
	});

	it("unwraps the message nested in an assistant/message", () => {
		const described = describeOne("assistant/message", { turn: 1, step: 2, message: message("Done."), stream: [] });
		expect(described?.kind).toBe("assistant");
		expect(described?.evidence).toBe("[assistant] Done.");
	});

	it("drops the Executor's reasoning and keeps the visible text beside it", () => {
		// The projection is evidence for a reviewer, not a transcript: reasoning
		// measured 30 % of it while the visible text was under 2 %.
		const assistant = {
			...(message("") as Record<string, unknown>),
			content: [
				{ type: "reasoning", text: "Let me check src/host/review.ts first." },
				{ type: "text", text: "read.ts now refuses reads past the budget." },
			],
		};
		expect(
			describeOne("assistant/message", { turn: 1, step: 2, message: assistant, stream: [] })?.evidence,
		).toBe("[assistant] read.ts now refuses reads past the budget.");
	});

	it("has no line for an assistant message that only reasoned", () => {
		const reasoningOnly = {
			...(message("") as Record<string, unknown>),
			content: [{ type: "reasoning", text: "Thinking about the next step." }],
		};
		expect(describeOne("assistant/message", { turn: 1, step: 2, message: reasoningOnly, stream: [] })).toBeUndefined();
	});

	it("names the command a tool call ran", () => {
		const described = describeOne("tool/call", {
			turn: 1,
			step: 2,
			callId: "call_1",
			name: "bash",
			arguments: '{"command":"pnpm test"}',
		});
		expect(described?.kind).toBe("tool-call");
		expect(described?.evidence).toBe('[tool call] bash {"command":"pnpm test"}');
	});

	it("keeps a shell command's head and drops a heredoc body", () => {
		const arguments_ = JSON.stringify({ command: `cat > f <<'EOF'\n${"line\n".repeat(400)}EOF` });
		const line = describeOne("tool/call", { turn: 1, step: 2, callId: "call_1", name: "bash", arguments: arguments_ });
		expect(line?.evidence.length).toBeLessThan(700);
		expect(line?.evidence).toContain("chars truncated");
	});

	it("keeps more of an edit's arguments, which are the change under review", () => {
		const patch = `{"file_path":"a.ts","old_string":"${"x".repeat(3_000)}"}`;
		const line = describeOne("tool/call", { turn: 1, step: 2, callId: "call_1", name: "edit", arguments: patch });
		expect(line?.evidence.length).toBeGreaterThan(1_500);
		expect(line?.evidence.length).toBeLessThan(2_100);
	});
});

describe("graded tool results", () => {
	it("reduces a file read the reviewer could repeat to a pointer", () => {
		const body = "1: first line\n2: second line\n";
		const described = describeOne("tool/result", result(body), paired({ name: "read", target: "src/host/prompt.ts" }));
		expect(described?.kind).toBe("tool-result");
		expect(described?.evidence).toContain("[tool result] read src/host/prompt.ts");
		expect(described?.evidence).toContain(`${body.length} chars, 2 lines`);
		expect(described?.evidence).toContain("content omitted (re-read to verify)");
		expect(described?.evidence).not.toContain("first line");
		// The body is already gone in the evidence zone, so both zones agree.
		expect(described?.trace).toBeUndefined();
	});

	it("tells the reviewer to re-run a search rather than to re-read it", () => {
		const described = describeOne("tool/result", result("a.ts:1: x\nb.ts:2: y\n"), paired({ name: "grep", target: "src/" }));
		expect(described?.evidence).toContain("[tool result] grep src/");
		expect(described?.evidence).toContain("re-run to verify");
	});

	it("keeps a listing's body: the reviewer has no `ls` to reproduce it", () => {
		const described = describeOne("tool/result", result("a.ts\nb.ts\n"), paired({ name: "ls", target: "src/" }));
		// `ls` is outside the reviewer's allow list, so its body must travel in the
		// evidence zone; only a later review's trace can afford to drop it.
		expect(described?.evidence).toContain("[tool result] a.ts");
		expect(described?.trace).toContain("body omitted (reviewed earlier)");
	});

	it("counts lines without inventing one for the trailing newline", () => {
		expect(linesOf("a\nb\n")).toEqual(["a", "b"]);
		expect(linesOf("a\nb")).toEqual(["a", "b"]);
		expect(linesOf("")).toEqual([]);
		// A trailing newline ends the last line; a blank body has no line of content.
		expect(linesOf("\n")).toEqual([]);
	});

	it("compresses a shell result to its status, failure lines and tail", () => {
		const body = ["starting", "error: one failed", "line 3", "line 4", "done"].join("\n");
		const described = describeOne("tool/result", result(body), paired({ name: "bash" }));
		expect(described?.evidence).toContain("[tool result] bash · ran");
		expect(described?.evidence).toContain("failures:");
		expect(described?.evidence).toContain("error: one failed");
		expect(described?.evidence).toContain("tail:");
		expect(described?.evidence).toContain("done");
		// The reviewed zone keeps the status and drops the output.
		expect(described?.trace).toContain("[tool result] bash · ran");
		expect(described?.trace).toContain("output omitted (reviewed earlier)");
		expect(described?.trace).not.toContain("done");
	});

	it("keeps the tail even when the failure lines are minified", () => {
		// A bundle-shaped error line is thousands of characters; a head-first clamp
		// used to spend the whole summary on it and lose the tail.
		const text = [`error: ${"x".repeat(2_000)}`, "build step 2", "final line"].join("\n");
		const described = describeOne("tool/result", result(text), paired({ name: "bash" }));
		expect(described?.evidence.length).toBeLessThanOrEqual(600);
		expect(described?.evidence).toContain("final line");
	});

	it("gives the tail the room failures leave, newest lines first when short", () => {
		const text = Array.from({ length: 20 }, (_, index) => `line ${String(index)} ${"y".repeat(90)}`).join("\n");
		const described = describeOne("tool/result", result(text), paired({ name: "bash" }));
		expect(described?.evidence.length).toBeLessThanOrEqual(600);
		expect(described?.evidence).toContain("line 19");
		expect(described?.evidence).not.toContain("line 0");
	});

	it("keeps a job's output readable: it is not a shell result and cannot be re-read", () => {
		const described = describeOne("tool/result", result("job 3: step 12 started\nstep 12 done"), paired({ name: "job_output" }));
		expect(described?.evidence).toContain("job 3: step 12 started");
		expect(described?.evidence).not.toContain("· ran");
		// The trace only drops the body, because a completed review already read it.
		expect(described?.trace).toContain("body omitted (reviewed earlier)");
	});

	it("reads the harness's own exit-status marker, and only at the end of the result", () => {
		// `@deepseek-ai/dsh-tool-bash` appends `[exit code: N]` as the final line;
		// `@deepseek-ai/dsh-shell/render` parses exactly that anchor.
		const failed = describeOne("tool/result", result("boom\n[exit code: 1]"), paired({ name: "bash" }));
		expect(failed?.evidence).toContain("exit 1");
		expect(failed?.evidence).not.toContain("[exit code: 1]");

		// The same words inside the output (a test fixture, a child process log) are
		// not a status: reporting them made a successful command look failed.
		const quoted = describeOne(
			"tool/result",
			result('message("exit code 1", { isError: true })'),
			paired({ name: "bash" }),
		);
		expect(quoted?.evidence).toContain("· ran");
		expect(quoted?.evidence).not.toContain("· exit 1");

		const killed = describeOne("tool/result", result("partial\n[killed by signal: SIGTERM]"), paired({ name: "bash" }));
		expect(killed?.evidence).toContain("· killed");

		// An empty body is rendered as the harness's own literal before the marker, so
		// the marker is still the last line and still yields the exit status.
		const silentFailure = describeOne("tool/result", result("(no output)\n[exit code: 2]"), paired({ name: "bash" }));
		expect(silentFailure?.evidence).toContain("· exit 2");
	});

	it("records an empty result instead of dropping the call's answer", () => {
		const read = describeOne("tool/result", result(""), paired({ name: "read", target: "empty.txt" }));
		expect(read?.evidence).toBe("[tool result] read empty.txt · 0 chars, 0 lines · content omitted (re-read to verify)");

		const bash = describeOne("tool/result", result(""), paired({ name: "bash" }));
		expect(bash?.evidence).toContain("· no output · 0 chars");

		const foreign = describeOne("tool/result", result(""), paired({ name: "subagent" }));
		expect(foreign?.evidence).toBe("[tool result] subagent · no output");
	});

	it("renders a failed tool whose body is empty from the event's own error identity", () => {
		const failure = (error: unknown) => ({
			turn: 1,
			step: 2,
			message: message("", { toolCallId: "call_1", isError: true, role: "tool" }),
			error,
		});
		const withReason = describeOne(
			"tool/result",
			failure({ name: "BashError", code: "spawn_failed", reason: "sandbox runner not ready" }),
			paired({ name: "bash" }),
		);
		expect(withReason?.kind).toBe("tool-error");
		expect(withReason?.evidence).toBe("[tool error] sandbox runner not ready");

		// Falls back to the code, then to an explicit placeholder: the failure must not
		// vanish just because every text field it could name is absent.
		expect(describeOne("tool/result", failure({ name: "ReadError", code: "ENOENT" }), paired({ name: "read" }))?.evidence).toBe(
			"[tool error] ENOENT",
		);
		expect(describeOne("tool/result", failure(undefined), paired({ name: "read" }))?.evidence).toBe(
			"[tool error] no detail",
		);
	});

	it("keeps an edit result verbatim in both zones: it is the proof the change landed", () => {
		const described = describeOne("tool/result", result("Edited a.ts (+2 -1)"), paired({ name: "edit" }));
		expect(described?.evidence).toBe("[tool result] Edited a.ts (+2 -1)");
		expect(described?.trace).toBeUndefined();
	});

	it("keeps another tool's result as evidence and drops only its body in the trace", () => {
		const described = describeOne("tool/result", result("subagent says: the tests pass"), paired({ name: "subagent" }));
		expect(described?.evidence).toBe("[tool result] subagent says: the tests pass");
		// The reviewer cannot call `subagent`, so it must see the result now; the
		// trace omits it because a completed review already read it.
		expect(described?.trace).toContain("body omitted (reviewed earlier)");
	});

	it("keeps a tool error whole in both zones", () => {
		const described = describeOne("tool/result", result("ENOENT: no such file", "call_1", true), paired({ name: "read" }));
		expect(described?.kind).toBe("tool-error");
		expect(described?.evidence).toBe("[tool error] ENOENT: no such file");
		expect(described?.trace).toBeUndefined();
	});

	it("names a result whose call it cannot pair instead of dropping the evidence", () => {
		const described = describeOne("tool/result", result("orphan output"));
		expect(described?.evidence).toBe("[tool result] orphan output");
	});

	it("bounds a line to the transcript budget and keeps the rest of the window", () => {
		const described = describeOne(
			"tool/result",
			result("x".repeat(10_000)),
			paired({ name: "subagent" }),
		);
		expect(described?.evidence.length).toBeLessThan(TRANSCRIPT_LINE_CHARS + 64);
		expect(described?.evidence).toContain("chars truncated");
	});

	it("redacts a secret that straddles the line bound instead of cutting it open", () => {
		// The clamp used to run first, so a quoted credential cut mid-value lost the
		// closing quote its redaction pattern needs and leaked its visible prefix.
		const secret = "correct-horse-battery-staple-very-secret";
		const described = describeOne(
			"tool/result",
			result(`password = "${secret}${"x".repeat(5_000)}"`),
			paired({ name: "subagent" }),
		);
		expect(described?.evidence).toContain("[REDACTED]");
		expect(described?.evidence).not.toContain(secret);
	});

	it("reads the path a call addressed from either argument spelling", () => {
		expect(callTarget('{"file_path":"/a/b.ts"}')).toBe("/a/b.ts");
		expect(callTarget('{"path":"src/"}')).toBe("src/");
		expect(callTarget("not json")).toBeUndefined();
		expect(callTarget('{"pattern":"x"}')).toBeUndefined();
	});
});

describe("blocksText", () => {
	it("joins the visible text and drops reasoning", () => {
		expect(
			blocksText([
				{ type: "reasoning", text: "thinking" },
				{ type: "text", text: "first" },
				{ type: "text", text: "second" },
			]),
		).toBe("first\nsecond");
	});

	it("has no text for an empty or text-free block list", () => {
		expect(blocksText([])).toBeUndefined();
		expect(blocksText([{ type: "image", data: "..." }])).toBeUndefined();
		expect(blocksText([{ type: "text", text: "   " }])).toBeUndefined();
	});
});

describe("renderEvidence / renderTrace", () => {
	it("renders the same text in both zones when no body is omitted", () => {
		const entry: TranscriptEntry = { seq: 1, kind: "assistant", evidence: "[assistant] hi" };
		expect(renderEvidence(entry)).toBe("[assistant] hi");
		expect(renderTrace(entry)).toBe("[assistant] hi");
	});

	it("prefers the degraded rendering in the trace zone", () => {
		const entry: TranscriptEntry = { seq: 1, kind: "tool-result", evidence: "[tool result] body", trace: "[omitted]" };
		expect(renderEvidence(entry)).toBe("[tool result] body");
		expect(renderTrace(entry)).toBe("[omitted]");
	});
});

function entryAt(seq: number, kind: TranscriptEntry["kind"], evidence = `line ${seq}`): TranscriptEntry {
	return { seq, kind, evidence };
}

describe("boundaryIndexFor", () => {
	const entries = [entryAt(3, "user"), entryAt(7, "assistant"), entryAt(9, "tool-result"), entryAt(12, "user")];

	it("marks the first entry a completed review did not read", () => {
		expect(boundaryIndexFor(entries, 7)).toBe(2);
	});

	it("claims everything buffered as new when nothing was reviewed", () => {
		expect(boundaryIndexFor(entries, 0)).toBe(0);
	});

	it("claims nothing as new when the review read the whole buffer", () => {
		expect(boundaryIndexFor(entries, 12)).toBe(4);
		expect(boundaryIndexFor(entries, 99)).toBe(4);
	});

	it("keeps the boundary when a compaction shadowed entries before it", () => {
		// Compaction removed seqs 3 and 7; the boundary stays the seq the review
		// read, so the next review still starts after it.
		const remaining = [entryAt(9, "tool-result"), entryAt(12, "user")];
		expect(boundaryIndexFor(remaining, 7)).toBe(0);
	});
});

describe("boundEntries", () => {
	const oneTokenEach = Array.from({ length: 20 }, (_, index) => entryAt(index + 1, "assistant", "abcd"));

	it("keeps everything when the zone fits", () => {
		const bounded = boundEntries(oneTokenEach, 10_000);
		expect(bounded.entries).toHaveLength(20);
		expect(bounded.dropped).toBe(0);
	});

	it("takes the tail within the budget", () => {
		const bounded = boundEntries(oneTokenEach, 10);
		expect(bounded.entries.length).toBeLessThan(20);
		expect(bounded.entries.at(-1)?.seq).toBe(20);
		expect(bounded.dropped).toBe(20 - bounded.entries.length);
	});

	it("does not charge a pairing cleanup to the budget", () => {
		// A zone that fits whole keeps everything: the orphan cleanup is the
		// composer's call, not a budget cut, and must not report truncation.
		const entries = [entryAt(1, "tool-result", "result"), entryAt(2, "assistant", "done")];
		const bounded = boundEntries(entries, 100);
		expect(bounded.entries).toHaveLength(2);
		expect(bounded.dropped).toBe(0);
	});

	it("keeps a leading result even when its call is not in the zone", () => {
		// A result whose call was cut is still evidence of what the tool answered;
		// dropping it would silently remove material the reviewer never saw.
		const entries = [entryAt(1, "tool-result", "orphan"), entryAt(2, "assistant", "done")];
		expect(boundEntries(entries, 100).entries).toHaveLength(2);
	});
});

describe("compaction", () => {
	it("maps a summary event to a summary line and its shadowed seqs", () => {
		const update = compactionUpdate(
			event("compaction/summary", {
				compactionId: "cmp_1",
				shadowedSeqs: [1, 2, 3],
				summary: [{ type: "text", text: "the earlier work" }],
			}),
		);
		expect(update?.shadowed).toEqual([1, 2, 3]);
		expect(update?.compactionId).toBe("cmp_1");
		expect(update?.entry?.kind).toBe("compaction");
		expect(update?.entry?.evidence).toBe("[compaction summary] the earlier work");
	});

	it("maps a prune to shadowed seqs only", () => {
		const update = compactionUpdate(event("compaction/prune", { shadowedSeqs: [4, 5], shadowedTokenCount: 10 }));
		expect(update?.shadowed).toEqual([4, 5]);
		expect(update?.entry).toBeUndefined();
	});

	it("reads nothing from an unrelated event", () => {
		expect(compactionUpdate(event("step/start", { turn: 1, step: 1 }))).toBeUndefined();
	});

	it("recognizes a checkpoint message and renders it as a summary, not a user turn", () => {
		const checkpoint = event(
			"user/message",
			userMessage("This is an automatically generated checkpoint.\n\n<compacted-summary>x</compacted-summary>", {
				kind: "compact-checkpoint",
				compactionId: "cmp_1",
			}),
		);
		expect(isCompactionCheckpoint(checkpoint)).toBe(true);
		expect(checkpointCompactionId(checkpoint)).toBe("cmp_1");
		expect(checkpointEntry(checkpoint)?.kind).toBe("compaction");
		expect(checkpointEntry(checkpoint)?.evidence.startsWith("[compaction summary] ")).toBe(true);
	});

	it("leaves an ordinary user message alone", () => {
		const message = event("user/message", userMessage("hello"));
		expect(isCompactionCheckpoint(message)).toBe(false);
		expect(checkpointEntry(message)).toBeUndefined();
	});
});
