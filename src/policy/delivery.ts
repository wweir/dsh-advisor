/**
 * Delivery state machine and the bounded, keyed pending queue.
 *
 * @module dsh-advisor/policy/delivery
 */

import type { AcceptedReviewAdvice } from "./advice.ts";
import type { ActiveIdleSeverity } from "./config.ts";

/** Follow-up turns one session may be woken with before the path closes. */
export const REVIEW_FOLLOW_UP_SESSION_CAP = 5;

/**
 * Whether the session's follow-up budget is spent. One predicate for both the
 * delivery loop and the status surface: the tab explains the hold with the same
 * gate the hand-off uses, so the two cannot drift apart.
 */
export function isAdviceFollowUpCapExhausted(followUpsUsed: number): boolean {
	return followUpsUsed >= REVIEW_FOLLOW_UP_SESSION_CAP;
}

export type AdviceDispatch = "deferred" | "steer" | "followUp";

/**
 * Why a queued note cannot be handed over right now, for the page tab.
 *
 * The codes are machine-readable on purpose: the tab localizes them, and the
 * command line renders the same enum, so "queued" never leaves the reason
 * invisible.
 */
export type AdviceHoldReason =
	/** The Executor is running, so the note waits for the next step boundary. */
	| "running"
	/** A follow-up turn opened by an earlier note is still open. */
	| "followUpOpen"
	/** A follow-up turn this session already opened did not get the note processed. */
	| "idleFollowUpRetried"
	/** The session's follow-up budget is spent. */
	| "idleFollowUpCap"
	/** The user spoke after the note was produced; it waits for a later turn. */
	| "newerInstruction"
	/** The note's severity is not allowed to wake an idle Executor. */
	| "idleSeverity";

export interface AdviceDispatchState {
	/**
	 * No delivery may happen at all: the plugin is unloading, so a note has to
	 * stay queued instead of being steered into a session nobody owns any more.
	 */
	forceDeferred: boolean;
	/** Executor status read at delivery time, never a snapshot taken at enqueue time. */
	idle: boolean;
	/** A real user instruction arrived after this note was produced. */
	newerInstructionInput: boolean;
	severity: AcceptedReviewAdvice["severity"];
	activeIdleSeverities: readonly ActiveIdleSeverity[];
	/** A follow-up turn is already in flight; do not open a second one. */
	reviewFollowUpPending: boolean;
	reviewFollowUpCapExhausted: boolean;
	/**
	 * This note was already handed to a follow-up turn whose note went through
	 * no reply. Waking the Executor again for the same note would trade a lost
	 * note for a loop of empty turns, so a retry waits for a running turn.
	 */
	followUpAttempted: boolean;
}

/**
 * The gates that decide whether a queued note may be handed over now. It is
 * `AdviceDispatchState` without `forceDeferred`: a disposing plugin has no page
 * to explain anything to, so asking for a hold reason during teardown is not a
 * question this function can answer.
 */
export type AdviceHoldState = Omit<AdviceDispatchState, "forceDeferred">;

/**
 * Explains why a note is deferred; undefined when it may be delivered now.
 * `selectAdviceDispatch` is derived from this one predicate, so the page's
 * reason and the delivery decision cannot drift apart.
 */
export function explainAdviceHold(state: AdviceHoldState): AdviceHoldReason | undefined {
	if (!state.idle) return "running";
	if (state.reviewFollowUpPending) return "followUpOpen";
	if (state.reviewFollowUpCapExhausted) return "idleFollowUpCap";
	if (state.followUpAttempted) return "idleFollowUpRetried";
	if (state.newerInstructionInput) return "newerInstruction";
	if (!state.activeIdleSeverities.some((severity) => severity === state.severity)) {
		return "idleSeverity";
	}
	return undefined;
}

/**
 * `steer` is only ever selected while the executor is running: on an idle
 * driver it would open an unapproved turn, bypassing `activeIdleSeverities`.
 */
export function selectAdviceDispatch(state: AdviceDispatchState): AdviceDispatch {
	if (state.forceDeferred) return "deferred";
	if (!state.idle) return "steer";
	return explainAdviceHold(state) === undefined ? "followUp" : "deferred";
}

/**
 * Insertion-ordered queue keyed by finding identity: at most one entry per key,
 * and overflowing the bound drops the oldest entry. The queue is a bounded
 * buffer of recent findings, not a durable work list.
 */
export class BoundedKeyedFifo<T> {
	private readonly entries: { key: string; value: T }[] = [];

	constructor(readonly maxItems: number) {
		if (!Number.isInteger(maxItems) || maxItems < 1) {
			throw new RangeError("FIFO item bound must be a positive integer");
		}
	}

	/**
	 * Queues one value under `key`, replacing the value already queued under it.
	 * Replacing in place, rather than keeping the first value, is what stops a
	 * re-found finding from being stuck at an older, weaker wording: the queue is
	 * keyed by identity, so the newest observation of that identity wins.
	 */
	set(key: string, value: T): void {
		const index = this.entries.findIndex((entry) => entry.key === key);
		if (index >= 0) {
			this.entries[index] = { key, value };
			return;
		}
		if (this.entries.length >= this.maxItems) this.entries.shift();
		this.entries.push({ key, value });
	}

	peek(): { key: string; value: T } | undefined {
		const entry = this.entries[0];
		return entry === undefined ? undefined : { ...entry };
	}

	has(key: string): boolean {
		return this.entries.some((entry) => entry.key === key);
	}

	shift(): { key: string; value: T } | undefined {
		return this.entries.shift();
	}

	/**
	 * Removes the entry under `key` only while it still holds `value`. Delivery
	 * hands over a snapshot entry, and the queue may have been replaced under the
	 * same key while that call was suspended; removing unconditionally would drop
	 * the newer observation instead of the one that was delivered.
	 */
	deleteIf(key: string, value: T): boolean {
		const index = this.entries.findIndex((entry) => entry.key === key);
		if (index < 0 || this.entries[index]?.value !== value) return false;
		this.entries.splice(index, 1);
		return true;
	}

	entriesInOrder(): { key: string; value: T }[] {
		return this.entries.map((entry) => ({ ...entry }));
	}

	clear(): void {
		this.entries.length = 0;
	}

	get length(): number {
		return this.entries.length;
	}
}
