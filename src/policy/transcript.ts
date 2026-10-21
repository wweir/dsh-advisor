import type {
	AssistantMessage,
	SessionEvent,
	ToolResultMessage,
	UserMessage,
} from "@deepseek-ai/dsh-session";

import { estimateTokens, redactSecrets } from "./redaction.ts";

/**
 * One transcript line is capped. A single large tool result (a file dump, a test
 * log) would otherwise push every other line out of the bounded projection.
 */
export const TRANSCRIPT_LINE_CHARS = 4_000;

/**
 * A shell command's arguments are kept for what the command IS, not for a heredoc
 * body pasted into it: the body reaches the transcript through the tool result.
 */
const SHELL_ARGUMENT_CHARS = 600;

/** An edit or write argument IS the change under review; more of it is worth keeping. */
const PATCH_ARGUMENT_CHARS = 2_000;

/**
 * A shell result is compressed to what the reviewer cannot reconstruct: it has
 * no shell of its own, so the exit status, the failure lines and the tail are
 * the only record that the command ran and what it said.
 */
const SHELL_RESULT_CHARS = 600;
const SHELL_RESULT_ERROR_LINES = 3;
const SHELL_RESULT_TAIL_LINES = 8;
/** One minified error line can be a whole bundle; it must not crowd out the tail. */
const SHELL_FAILURE_LINE_CHARS = 140;
const SHELL_TAIL_LINE_CHARS = 120;

/** Tool families whose results are graded differently; the names are the harness's own. */
const SHELL_TOOLS = new Set(["bash"]);
/**
 * `job_output` is not here: a job's output is read incrementally (the same call
 * returns different text next time), so the reviewer cannot reproduce a segment
 * and the body has to travel. It is also not a shell result — it carries no exit
 * status, so the status/tail summary would have nothing to summarise.
 */
const PATCH_TOOLS = new Set(["edit", "write"]);
/**
 * Local filesystem reads and searches. These are exactly the tools the reviewer
 * itself may run (`read`/`grep`/`glob`), so it can re-obtain the same fact and the
 * body does not have to travel. A tool outside that set — `ls`, an MCP read, a
 * subagent's report — cannot be replayed and keeps its text.
 */
const FILE_READ_TOOLS = new Set(["read", "grep", "glob"]);

const FAILURE_LINE = /\b(error|failed|failure|exception|panic|not ok|assertion)\b/iu;

export type TranscriptKind =
	| "user"
	| "assistant"
	| "tool-call"
	| "tool-result"
	| "tool-error"
	| "compaction";

/**
 * One model-visible event as the reviewer reads it.
 *
 * Both renderings are produced once, when the event is observed, so composing a
 * prompt never re-derives text from a log that may since have changed: the same
 * event always yields the same two strings.
 */
export interface TranscriptEntry {
	/** Session seq of the event that produced this line (its surface-node identity). */
	readonly seq: number;
	readonly kind: TranscriptKind;
	/** Full evidence rendering, redacted and clamped. The new-work zone carries it. */
	readonly evidence: string;
	/**
	 * Rendering for the already-reviewed zone, where a body the reviewer cannot
	 * replay is omitted. Absent means the two zones carry the same text.
	 */
	readonly trace?: string;
}

/** What a `tool/result`'s paired call was, which the result event itself does not name. */
export interface ToolCallInfo {
	readonly name: string;
	/** The path a local filesystem call addressed, when its arguments name one. */
	readonly target?: string;
}

export interface TranscriptContext {
	/** Resolves the call that a `tool/result` answers, by call id. */
	readonly call?: (callId: string) => ToolCallInfo | undefined;
}

/**
 * Renders one session event as one transcript entry, or `undefined` for events
 * that carry no model-visible work.
 *
 * The event data shapes are the harness's, not a uniform one: `user/message`
 * carries the message itself, while `assistant/message` and `tool/result` nest
 * it under `message`. Reading a nested message as a flat one drops every line
 * silently, which leaves the reviewer blind to the work it is meant to review.
 */
export function describeEvent(
	event: SessionEvent,
	context: TranscriptContext = {},
): TranscriptEntry | undefined {
	switch (event.type) {
		case "user/message": {
			const text = messageText(event.data);
			return text === undefined ? undefined : entry(event, "user", bound(`[user] ${text}`));
		}
		case "assistant/message": {
			const text = messageText(event.data.message);
			return text === undefined ? undefined : entry(event, "assistant", bound(`[assistant] ${text}`));
		}
		case "tool/call": {
			const name = event.data.name;
			const line = `[tool call] ${name} ${boundArguments(name, event.data.arguments)}`;
			return entry(event, "tool-call", bound(line));
		}
		case "tool/result":
			return describeResult(event, context);
		default:
			return undefined;
	}
}

/** The seq an entry carries; a synthetic event (a test fixture) has none. */
function entrySeq(event: SessionEvent): number {
	return typeof event.seq === "number" ? event.seq : 0;
}

function entry(
	event: SessionEvent,
	kind: TranscriptKind,
	evidence: string,
	trace?: string,
): TranscriptEntry {
	return {
		seq: entrySeq(event),
		kind,
		evidence,
		...(trace === undefined || trace === evidence ? {} : { trace }),
	};
}

function describeResult(
	event: SessionEvent<"tool/result">,
	context: TranscriptContext,
): TranscriptEntry | undefined {
	const message = event.data.message;
	const call = context.call?.(message.toolCallId);
	const name = call?.name ?? "unknown";
	// An empty body is still a result: a successful read of an empty file, or a
	// command that printed nothing. Dropping the line would leave the call without
	// an answer, which reads as a result that never arrived.
	const text = messageText(message);
	const body = text === undefined ? "" : redactSecrets(text).text;
	if (message.isError === true) {
		// The model-facing body is empty for some failures; the event's own `error`
		// carries the reason outside it, and that is the only record of the failure.
		const detail = body.length > 0 ? body : (failureDetail(event) ?? "no detail");
		return entry(event, "tool-error", bound(`[tool error] ${detail}`));
	}
	if (FILE_READ_TOOLS.has(name)) {
		const pointer = filePointer(name, call?.target, body);
		return entry(event, "tool-result", pointer);
	}
	if (SHELL_TOOLS.has(name)) {
		const summary = shellSummary(name, body);
		return entry(event, "tool-result", summary.evidence, summary.trace);
	}
	if (PATCH_TOOLS.has(name)) {
		// The result is the proof the change landed, and it is small: both zones keep
		// it, so a later review can still tell a reverted edit from an applied one.
		return entry(event, "tool-result", bound(`[tool result] ${body.length > 0 ? body : "no output"}`));
	}
	const evidence = bound(body.length > 0 ? `[tool result] ${body}` : `[tool result] ${name} · no output`);
	// A completed review already read this body, and the reviewer cannot ask the
	// tool again (an MCP server, a subagent, a job): the trace keeps only the fact
	// that a result arrived, never its text.
	return entry(
		event,
		"tool-result",
		evidence,
		`[tool result] ${name} · ${String(body.length)} chars · body omitted (reviewed earlier)`,
	);
}

/** The failure identity the event carries outside an empty model-facing body. */
function failureDetail(event: SessionEvent<"tool/result">): string | undefined {
	const error = (event.data as { error?: unknown }).error;
	if (typeof error !== "object" || error === null) return undefined;
	const record = error as { reason?: unknown; code?: unknown };
	const reason = typeof record.reason === "string" ? record.reason.trim() : "";
	if (reason.length > 0) return reason;
	const code = typeof record.code === "string" ? record.code.trim() : "";
	return code.length > 0 ? code : undefined;
}

/** A read or search the reviewer could re-run itself: keep the shape, drop the body. */
function filePointer(name: string, target: string | undefined, text: string): string {
	const subject = target === undefined ? name : `${name} ${bound(target)}`;
	const verb = name === "read" ? "re-read" : "re-run";
	return `[tool result] ${subject} · ${String(text.length)} chars, ${String(linesOf(text).length)} lines · content omitted (${verb} to verify)`;
}

/**
 * The lines of a tool result: a trailing newline ends the last line rather than
 * starting an empty one, so a two-line read reports two lines and a tail never
 * begins with a blank line.
 */
export function linesOf(text: string): string[] {
	const body = text.endsWith("\n") ? text.slice(0, -1) : text;
	return body.length === 0 ? [] : body.split("\n");
}

interface ShellSummary {
	readonly evidence: string;
	readonly trace: string;
}

/**
 * Compresses a shell result for the evidence zone. The failure scan is a
 * heuristic on purpose: the reviewer cannot run the command, so a couple of
 * failure-looking lines plus the tail are what let it tell "output I cannot see"
 * from "nothing ran".
 */
function shellSummary(name: string, text: string): ShellSummary {
	const { body, status } = shellRun(text);
	const lines = linesOf(body);
	const failures = lines
		.filter((line) => FAILURE_LINE.test(line))
		.slice(0, SHELL_RESULT_ERROR_LINES)
		.map((line) => `  ${clamp(line.trim(), SHELL_FAILURE_LINE_CHARS)}`);
	const blocks: string[] = [`[tool result] ${name} · ${status} · ${String(text.length)} chars`];
	if (failures.length > 0) blocks.push("failures:", ...failures);
	// The tail shows how the command ended, which is where a failure usually
	// surfaces, so it takes what the failure lines left — fitted line by line and
	// keeping the newest lines, because a head-first clamp would let one minified
	// error line push the whole tail out of the summary.
	const room = SHELL_RESULT_CHARS - blocks.join("\n").length - "\ntail:".length - 1;
	const tail = fitTailLines(lines.slice(-SHELL_RESULT_TAIL_LINES), room);
	if (tail.length > 0) blocks.push("tail:", ...tail);
	return {
		evidence: clamp(blocks.join("\n"), SHELL_RESULT_CHARS),
		trace: `[tool result] ${name} · ${status} · output omitted (reviewed earlier)`,
	};
}

/** Keeps the newest lines that fit the room, in their original order. */
function fitTailLines(lines: readonly string[], room: number): string[] {
	const kept: string[] = [];
	let used = 0;
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = `  ${clamp(lines[index] ?? "", SHELL_TAIL_LINE_CHARS)}`;
		if (used + line.length + 1 > room) break;
		used += line.length + 1;
		kept.unshift(line);
	}
	return kept;
}

/**
 * Splits a shell result into its output body and exit status.
 *
 * The harness's shell tools append their status as a final marker line
 * (`[exit code: N]`, `[killed by signal: X]`), and Host code parses exactly those
 * anchors (`@deepseek-ai/dsh-shell/render`). Scanning the whole text for the
 * words instead would report a successful command as failed whenever its output
 * quotes a child process's "exit code 1" (a test log, a fixture, a compiler
 * message) — the reviewer is told a status the harness never reported.
 */
function shellRun(text: string): { body: string; status: string } {
	const signal = /\n\[killed by signal: ([^\]\n]+)\]$/u.exec(text);
	if (signal?.[1] !== undefined) {
		return { body: text.slice(0, signal.index), status: "killed" };
	}
	const exit = /\n\[exit code: (\d+)\]$/u.exec(text);
	if (exit?.[1] !== undefined) {
		return { body: text.slice(0, exit.index), status: `exit ${exit[1]}` };
	}
	const trimmed = text.trim();
	if (trimmed.length === 0 || trimmed === "(no output)") return { body: "", status: "no output" };
	return { body: text, status: "ran" };
}

/** Clamps one tool call's arguments by the family's evidence value, keeping the name. */
function boundArguments(name: string, args: string): string {
	const redacted = redactSecrets(args).text;
	const limit = SHELL_TOOLS.has(name) ? SHELL_ARGUMENT_CHARS : PATCH_TOOLS.has(name) ? PATCH_ARGUMENT_CHARS : TRANSCRIPT_LINE_CHARS;
	return clamp(redacted, limit);
}

/**
 * The path a call's arguments name. Both spellings are read because the harness
 * filesystem tools use `file_path` (`read`) and `path` (`grep`/`glob`), and the
 * argument string is raw model output, so it may not parse at all.
 */
export function callTarget(args: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(args);
	} catch {
		return undefined;
	}
	return targetOfArguments(parsed);
}

/**
 * The path an already-parsed tool argument object names. Shared with the review's
 * protected-path guard so the guard and the projection can never disagree on which
 * path a call addresses.
 */
export function targetOfArguments(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	for (const key of ["file_path", "path"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return undefined;
}

/**
 * Flattens one message's content blocks to text.
 *
 * Reasoning blocks are dropped: the reviewer judges the work, not the
 * Executor's chain of thought. Measured over the twelve largest review prompts,
 * reasoning was 30 % of the projection while the visible assistant text it
 * accompanies was under 2 %. Intent is not the evidence a review cites — a
 * file, a command, a diff or a tool result is. See `docs/DECISIONS.md`.
 */
function messageText(message: UserMessage | AssistantMessage | ToolResultMessage): string | undefined {
	return blocksText(message.content);
}

/**
 * The visible text of a content-block list, or `undefined` when it carries none.
 *
 * Reasoning blocks are dropped wherever they appear; the compaction summary and
 * system-message readers share this rule so a block type cannot be text in one
 * place and invisible in another.
 */
export function blocksText(blocks: readonly unknown[]): string | undefined {
	const parts: string[] = [];
	for (const block of blocks) {
		if (typeof block !== "object" || block === null) continue;
		if ((block as { type?: unknown }).type === "reasoning") continue;
		const text = (block as { text?: unknown }).text;
		if (typeof text === "string") parts.push(text);
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
	return clamp(redactSecrets(line).text, TRANSCRIPT_LINE_CHARS);
}

function clamp(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}…[${String(text.length - limit)} chars truncated]`;
}

/**
 * Where the material a review covered ends in a transcript buffer that may have
 * dropped its oldest lines since that review started.
 *
 * Keyed by session seq, not by a line index: every trim and every compaction
 * shadow moves an index, while the seq of the last reviewed event stays the
 * boundary it was. A review whose whole covered range is gone resolves to 0 —
 * all buffered lines are newer than it.
 *
 * @param entries - the buffered entries, oldest first.
 * @param reviewedThroughSeq - seq of the last entry a completed review read.
 * @returns index (0..entries.length) of the first entry that review did not read.
 */
export function boundaryIndexFor(entries: readonly TranscriptEntry[], reviewedThroughSeq: number): number {
	let index = 0;
	while (index < entries.length) {
		const current = entries[index];
		if (current === undefined || current.seq > reviewedThroughSeq) break;
		index++;
	}
	return index;
}

/** One zone after budgeting: the entries kept and how many were dropped. */
interface BoundedEntries {
	readonly entries: readonly TranscriptEntry[];
	/** Leading entries dropped to fit the budget (0 means the zone is complete). */
	readonly dropped: number;
}

/**
 * Takes the token-limited tail of one zone.
 *
 * @param entries - the zone's entries, oldest first.
 * @param tokens - tokens this zone may occupy.
 * @param render - the zone's rendering, because a degraded trace can be far
 *   smaller than the evidence it replaces and costing it as evidence would
 *   waste most of the budget it was given.
 * @returns the kept suffix plus how many leading entries were dropped.
 */
export function boundEntries(
	entries: readonly TranscriptEntry[],
	tokens: number,
	render: (entry: TranscriptEntry) => string = renderEvidence,
): BoundedEntries {
	let used = 0;
	let start = entries.length;
	while (start > 0) {
		const current = entries[start - 1];
		if (current === undefined) break;
		// +1 per entry: the separator between two entries (two newlines) and the
		// estimator's per-string rounding, so the join stays inside the budget.
		const cost = estimateTokens(render(current)) + 1;
		if (used + cost > tokens) break;
		used += cost;
		start--;
	}
	return { entries: entries.slice(start), dropped: start };
}

/**
 * The checkpoint message a compaction leaves on the surface, when this event is
 * one. Its summary text is imperative prose addressed to the Executor, so it is
 * rendered as evidence with a label of its own instead of as a `[user]` turn.
 */
export function checkpointEntry(event: SessionEvent): TranscriptEntry | undefined {
	if (event.type !== "user/message") return undefined;
	if (!isCompactionCheckpoint(event)) return undefined;
	const text = messageText(event.data);
	return text === undefined ? undefined : entry(event, "compaction", bound(`[compaction summary] ${text}`));
}

/** Whether this event is the surface replacement a compaction wrote. */
export function isCompactionCheckpoint(event: SessionEvent): boolean {
	if (event.type !== "user/message") return false;
	// Merge-extensible source map: an unknown kind is read structurally rather
	// than through a type this package does not depend on.
	const source = event.data.source as { kind?: unknown };
	return source.kind === "compact-checkpoint";
}

/** The compaction identity a checkpoint message carries, when it names one. */
export function checkpointCompactionId(event: SessionEvent): string | undefined {
	if (!isCompactionCheckpoint(event) || event.type !== "user/message") return undefined;
	const source = event.data.source as { compactionId?: unknown };
	return typeof source.compactionId === "string" ? source.compactionId : undefined;
}

/** What one compaction event contributes to the transcript. */
export interface CompactionUpdate {
	/** Surface seqs the compaction replaced; their lines no longer describe live work. */
	readonly shadowed: readonly number[];
	/** Identity of the compaction, so the checkpoint that repeats its summary is known. */
	readonly compactionId?: string;
	/** The summary line, when the event carries one. */
	readonly entry?: TranscriptEntry;
}

/**
 * Reads a `compaction/summary` or `compaction/prune` event.
 *
 * Those events are declared by `@deepseek-ai/dsh-compaction`, which this plugin
 * does not depend on (a host without compaction must still load the observer),
 * so they are read structurally from the event type and data.
 */
export function compactionUpdate(event: SessionEvent): CompactionUpdate | undefined {
	const type = event.type as string;
	if (type !== "compaction/summary" && type !== "compaction/prune") return undefined;
	const data = event.data as unknown as {
		compactionId?: unknown;
		shadowedSeqs?: unknown;
		summary?: unknown;
	};
	const shadowed = Array.isArray(data.shadowedSeqs)
		? data.shadowedSeqs.filter((seq): seq is number => typeof seq === "number")
		: [];
	const compactionId = typeof data.compactionId === "string" ? data.compactionId : undefined;
	const identity = compactionId === undefined ? {} : { compactionId };
	if (type === "compaction/prune") return { shadowed, ...identity };
	const text = Array.isArray(data.summary) ? blocksText(data.summary) : undefined;
	return text === undefined
		? { shadowed, ...identity }
		: { shadowed, ...identity, entry: entry(event, "compaction", bound(`[compaction summary] ${text}`)) };
}

/** The full text of an entry, as the new-work zone carries it. */
export function renderEvidence(entry: TranscriptEntry): string {
	return entry.evidence;
}

/** The text of an entry in the already-reviewed zone, which may omit a body. */
export function renderTrace(entry: TranscriptEntry): string {
	return entry.trace ?? entry.evidence;
}
