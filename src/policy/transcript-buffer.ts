/**
 * The bounded transcript one observed session keeps for its next review.
 *
 * The buffer owns the three things that are easy to get wrong and hard to see from
 * the prompt afterwards: which tool a result answers (the result event names no
 * tool), which lines a compaction replaced, and whether a checkpoint repeats a
 * summary that is already recorded. Keeping those rules out of the observer makes
 * them unit-testable without a host.
 *
 * @module dsh-advisor/policy/transcript-buffer
 */

import type { SessionEvent } from "@deepseek-ai/dsh-session";

import {
	boundaryIndexFor,
	callTarget,
	checkpointCompactionId,
	checkpointEntry,
	compactionUpdate,
	describeEvent,
	isCompactionCheckpoint,
	type CompactionUpdate,
	type ToolCallInfo,
	type TranscriptEntry,
} from "./transcript.ts";

/**
 * Lines kept per session.
 *
 * 900 lines (≈245 steps at the measured 3.68 records/step) matches the 64K evidence
 * cap: a smaller ring leaves the extra budget nothing to carry, a larger one only
 * pays memory for trace an operator will not read. The buffer costs ~0.5 KB per
 * line, so this is ~0.45 MB per observed session.
 */
export const TRANSCRIPT_LINE_LIMIT = 900;

/**
 * Tool calls kept for result pairing. A call whose result never arrives (an
 * interrupted step) would otherwise stay in the table for the whole session.
 */
const CALL_PAIRING_LIMIT = 1_000;

/** Compaction identities remembered so a repeated checkpoint is not recorded twice. */
const COMPACTION_ID_LIMIT = 8;

export class TranscriptBuffer {
	private lines: TranscriptEntry[] = [];
	private readonly calls = new Map<string, ToolCallInfo>();
	/**
	 * Summary lines still in {@link lines}, keyed by compaction id. The summary event
	 * is log-only; the surface node that replaces the shadowed range is the checkpoint
	 * message that follows, so the line's seq is re-keyed to that checkpoint when it
	 * arrives. Otherwise a later compaction's `shadowedSeqs` (which names surface seqs)
	 * could never remove the line.
	 */
	private readonly pendingSummaries = new Map<string, number>();
	/** Compaction ids whose checkpoint already re-keyed or replaced their summary line. */
	private readonly checkpointed: string[] = [];

	constructor(private readonly limit = TRANSCRIPT_LINE_LIMIT) {
		if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Transcript buffer size must be a positive integer");
	}

	/**
	 * The buffered lines, oldest first. The array is live: read this getter after
	 * {@link absorb} rather than holding an earlier result across a compaction.
	 */
	get entries(): readonly TranscriptEntry[] {
		return this.lines;
	}

	/** Seq of the newest buffered line, or 0 when the buffer is empty. */
	lastSeq(): number {
		return this.lines.at(-1)?.seq ?? 0;
	}

	/** Index of the first line a completed review did not read. */
	boundaryIndex(reviewedThroughSeq: number): number {
		return boundaryIndexFor(this.lines, reviewedThroughSeq);
	}

	/**
	 * Applies an event that is not a transcript line itself but changes the buffer:
	 * a compaction (which may remove lines and add a summary) or its checkpoint.
	 *
	 * @returns whether the event was consumed; false means it is an ordinary event
	 *   to pass to {@link append}.
	 */
	absorb(event: SessionEvent): boolean {
		const compaction = compactionUpdate(event);
		if (compaction !== undefined) {
			this.applyCompaction(compaction);
			return true;
		}
		if (isCompactionCheckpoint(event)) {
			this.appendCheckpoint(event);
			return true;
		}
		return false;
	}

	/**
	 * Records one model-visible event as one bounded line. Results are graded by the
	 * call they answer, which is tracked here because the result event names no tool.
	 */
	append(event: SessionEvent): void {
		const entry = describeEvent(event, { call: (callId) => this.calls.get(callId) });
		if (event.type === "tool/call") {
			const target = callTarget(event.data.arguments);
			this.calls.set(event.data.callId, {
				name: event.data.name,
				...(target === undefined ? {} : { target }),
			});
			if (this.calls.size > CALL_PAIRING_LIMIT) {
				const oldest = this.calls.keys().next();
				if (oldest.done !== true) this.calls.delete(oldest.value);
			}
		} else if (event.type === "tool/result") {
			this.calls.delete(event.data.message.toolCallId);
		}
		if (entry !== undefined) this.push(entry);
	}

	private push(entry: TranscriptEntry): void {
		this.lines.push(entry);
		if (this.lines.length > this.limit) {
			this.lines.splice(0, this.lines.length - this.limit);
		}
	}

	/**
	 * Applies one compaction: the surface nodes it replaced no longer describe work
	 * the Executor can still see, so their lines leave with them — and the summary
	 * that replaced them takes their place.
	 */
	private applyCompaction(update: CompactionUpdate): void {
		if (update.shadowed.length > 0) {
			// Mutated in place, not replaced: {@link entries} hands out the live array, and a
			// consumer holding it must see a compaction land rather than keep a stale copy.
			const shadowed = new Set(update.shadowed);
			for (let index = this.lines.length - 1; index >= 0; index--) {
				const line = this.lines[index];
				if (line !== undefined && shadowed.has(line.seq)) this.lines.splice(index, 1);
			}
		}
		// Only a recorded line can later be re-keyed. A summary with no visible text
		// must leave no id behind, or the checkpoint — the only remaining copy of the
		// summary — would be dropped and the shadowed work would vanish without a word.
		if (update.entry !== undefined) {
			this.push(update.entry);
			if (update.compactionId !== undefined) {
				this.pendingSummaries.set(update.compactionId, update.entry.seq);
				if (this.pendingSummaries.size > COMPACTION_ID_LIMIT) {
					const oldest = this.pendingSummaries.keys().next();
					if (oldest.done !== true) this.pendingSummaries.delete(oldest.value);
				}
			}
		}
	}

	/**
	 * Records a compaction checkpoint. The surface replacement repeats the summary
	 * event's text, so its line is re-keyed to this checkpoint's surface seq instead
	 * of being added twice; the fallback covers a summary with no recorded line (no
	 * visible text, or a plugin that loaded mid-compaction).
	 */
	private appendCheckpoint(event: SessionEvent): void {
		const id = checkpointCompactionId(event);
		if (id !== undefined) {
			const summarySeq = this.pendingSummaries.get(id);
			if (summarySeq !== undefined) {
				this.pendingSummaries.delete(id);
				this.rememberCheckpointed(id);
				const index = this.lines.findIndex((line) => line.seq === summarySeq);
				const line = index < 0 ? undefined : this.lines[index];
				if (line === undefined) {
					// The ring evicted the line: the checkpoint is the only copy of the
					// summary left, so it is recorded rather than dropped.
					const fallback = checkpointEntry(event);
					if (fallback !== undefined) this.push(fallback);
					return;
				}
				// Moved to the tail rather than only re-keyed: the checkpoint's seq is
				// larger than every line before it, and the buffer's seqs must stay
				// ascending for {@link boundaryIndexFor} (a line re-keyed in place while
				// entries were appended after it would break the split).
				this.lines.splice(index, 1);
				this.push({ ...line, seq: eventSeq(event) });
				return;
			}
			if (this.checkpointed.includes(id)) return;
		}
		const entry = checkpointEntry(event);
		if (entry !== undefined) this.push(entry);
		if (id !== undefined) this.rememberCheckpointed(id);
	}

	/** Remembers a consumed compaction id, oldest first, for duplicate checkpoints. */
	private rememberCheckpointed(id: string): void {
		this.checkpointed.push(id);
		if (this.checkpointed.length > COMPACTION_ID_LIMIT) this.checkpointed.shift();
	}
}

/** The seq a session event carries; a synthetic event (a test fixture) has none. */
function eventSeq(event: SessionEvent): number {
	return typeof event.seq === "number" ? event.seq : 0;
}
