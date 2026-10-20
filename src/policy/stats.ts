/**
 * Per-session review accounting for the page tab.
 *
 * The status command answers "is it working, and why was it silent"; the tab
 * also has to answer "what did the second opinion cost, and what did it say
 * recently". That needs two things the delivery path deliberately does not
 * keep: token usage per review (the Executor log does not record the review
 * child's cost) and a bounded history of what happened.
 *
 * Everything here is pure: the runtime owns the state, this module owns the
 * shapes and the folding rules, so they can be tested without a host.
 *
 * @module dsh-advisor/policy/stats
 */

import type { AdviceSeverity } from "./advice.ts";
import { estimateTokens } from "./redaction.ts";

/** What one review consumed: wall time and provider-reported tokens. */
export interface ReviewUsage {
	readonly durationMs: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	/** Cache writes are billed input on routes that report them, so they are kept apart. */
	readonly cacheWriteTokens?: number;
}

/** How one review ended, as the tab names it. */
export type ReviewKind = "silent" | "finding" | "failed" | "cancelled";

/** One review in the tab's bounded history. */
export interface ReviewRecord {
	/** Executor turn the review covered. */
	readonly turn: number;
	/** Wall clock when the review settled. */
	readonly at: number;
	readonly kind: ReviewKind;
	readonly severity?: AdviceSeverity;
	/** The note text for a finding, truncated for display. */
	readonly note?: string;
	/** Failure or cancellation reason. */
	readonly reason?: string;
	readonly usage: ReviewUsage;
}

/** One advice note delivered into the Executor's conversation. */
export interface NoteRecord {
	readonly turn: number;
	readonly at: number;
	readonly severity: AdviceSeverity;
	readonly note: string;
	/** Why the same finding was raised again, when it was. */
	readonly tag?: string;
}

/** Cumulative per-session review accounting. */
export interface AdvisorStats {
	readonly reviews: number;
	readonly silent: number;
	readonly findings: number;
	readonly failed: number;
	readonly cancelled: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens?: number;
	/** Total wall time spent inside reviews. */
	readonly reviewMs: number;
	readonly last?: ReviewRecord;
}

/** Bounded history lengths. The tab shows a handful; disk should not grow. */
export const RECENT_REVIEW_LIMIT = 8;
export const RECENT_NOTE_LIMIT = 8;

/** Note text kept per history entry; the tab is a summary, not a second log. */
const RECORDED_NOTE_CHARS = 400;

/** Bounds a note by code points: a UTF-16 slice can cut a surrogate pair in half. */
function recordedNote(note: string): string {
	const characters = Array.from(note);
	return characters.length <= RECORDED_NOTE_CHARS
		? note
		: characters.slice(0, RECORDED_NOTE_CHARS).join("");
}

export function emptyAdvisorStats(): AdvisorStats {
	return {
		reviews: 0,
		silent: 0,
		findings: 0,
		failed: 0,
		cancelled: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reviewMs: 0,
	};
}

/** One review, as the runtime tells it, before the note is truncated for display. */
export interface ReviewInput {
	readonly turn: number;
	readonly at: number;
	readonly kind: ReviewKind;
	readonly severity?: AdviceSeverity;
	readonly note?: string;
	readonly reason?: string;
	readonly usage: ReviewUsage;
}

/** Applies one review to the cumulative accounting. */
export function recordReview(stats: AdvisorStats, review: ReviewRecord): AdvisorStats {
	return {
		reviews: stats.reviews + 1,
		silent: stats.silent + (review.kind === "silent" ? 1 : 0),
		findings: stats.findings + (review.kind === "finding" ? 1 : 0),
		failed: stats.failed + (review.kind === "failed" ? 1 : 0),
		cancelled: stats.cancelled + (review.kind === "cancelled" ? 1 : 0),
		inputTokens: stats.inputTokens + review.usage.inputTokens,
		outputTokens: stats.outputTokens + review.usage.outputTokens,
		cacheReadTokens: stats.cacheReadTokens + review.usage.cacheReadTokens,
		cacheWriteTokens: (stats.cacheWriteTokens ?? 0) + (review.usage.cacheWriteTokens ?? 0),
		reviewMs: stats.reviewMs + review.usage.durationMs,
		last: review,
	};
}

/** Builds the history entry from a review, truncating the note for display. */
export function toReviewRecord(input: ReviewInput): ReviewRecord {
	return {
		turn: input.turn,
		at: input.at,
		kind: input.kind,
		...(input.severity === undefined ? {} : { severity: input.severity }),
		...(input.note === undefined ? {} : { note: recordedNote(input.note) }),
		...(input.reason === undefined ? {} : { reason: input.reason }),
		usage: { ...input.usage },
	};
}

/** Builds one delivered-note entry. */
export function toNoteRecord(
	turn: number,
	at: number,
	severity: AdviceSeverity,
	note: string,
	tag?: string,
): NoteRecord {
	return {
		turn,
		at,
		severity,
		note: recordedNote(note),
		...(tag === undefined ? {} : { tag }),
	};
}

/** Prepends one entry, dropping the oldest beyond `limit`. */
export function pushBounded<T>(list: readonly T[], entry: T, limit: number): T[] {
	const next = [entry, ...list];
	return next.length <= limit ? next : next.slice(0, limit);
}

/**
 * Reads a persisted numeric field, defaulting to zero. The sidecar is a plain
 * file a person can edit, so a malformed history must degrade to "no stats"
 * rather than reject the whole state and lose the pending queue with it.
 */
function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Restores cumulative accounting, or a zeroed record when unusable. */
export function restoreAdvisorStats(value: unknown): AdvisorStats {
	if (typeof value !== "object" || value === null) return emptyAdvisorStats();
	const record = value as Record<string, unknown>;
	return {
		reviews: count(record["reviews"]),
		silent: count(record["silent"]),
		findings: count(record["findings"]),
		failed: count(record["failed"]),
		cancelled: count(record["cancelled"]),
		inputTokens: count(record["inputTokens"]),
		outputTokens: count(record["outputTokens"]),
		cacheReadTokens: count(record["cacheReadTokens"]),
		cacheWriteTokens: count(record["cacheWriteTokens"]),
		reviewMs: count(record["reviewMs"]),
		...(isReviewRecord(record["last"]) ? { last: record["last"] as ReviewRecord } : {}),
	};
}

/** Validates one persisted review history entry. */
export function isReviewRecord(value: unknown): value is ReviewRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	const usage = record["usage"];
	return (
		typeof record["turn"] === "number" &&
		typeof record["at"] === "number" &&
		(record["kind"] === "silent" ||
			record["kind"] === "finding" ||
			record["kind"] === "failed" ||
			record["kind"] === "cancelled") &&
		typeof usage === "object" &&
		usage !== null &&
		typeof (usage as Record<string, unknown>)["durationMs"] === "number" &&
		typeof (usage as Record<string, unknown>)["inputTokens"] === "number" &&
		typeof (usage as Record<string, unknown>)["outputTokens"] === "number"
	);
}

/** Validates one persisted delivered-note entry. */
export function isNoteRecord(value: unknown): value is NoteRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record["turn"] === "number" &&
		typeof record["at"] === "number" &&
		(record["severity"] === "nit" || record["severity"] === "concern" || record["severity"] === "blocker") &&
		typeof record["note"] === "string"
	);
}

/** Characters of each end of the compiled prompt the tab previews. */
export const CONTEXT_PREVIEW_CHARS = 2_000;

/**
 * The compiled review prompt the reviewer model actually received, described
 * for the page tab. This is deliberately NOT the Executor's context: the
 * reviewer gets a bounded, line-oriented projection, and showing its size and
 * truncation is what makes that difference legible.
 */
export interface ReviewContextMeta {
	/**
	 * Identity of the review this prompt belongs to (its recording time).
	 *
	 * Sizes alone are NOT an identity: a truncated projection always fills the
	 * same budget, so two successive reviews can report identical character and
	 * token counts while carrying different text. The page keys its cached full
	 * prompt on this, not on the shapes it displays.
	 */
	readonly recordedAt?: number;
	/** Characters in the full prompt. */
	readonly promptChars: number;
	/** Characters in the projection part alone. */
	readonly projectionChars: number;
	/** Characters occupied by fixed + deployment instructions. */
	readonly instructionsChars: number;
	/** Token estimate for the full prompt (the estimator the bound used). */
	readonly estimatedTokens: number;
	/** Whether earlier work was dropped to fit the context budget. */
	readonly truncated: boolean;
	/** First preview chunk of the projection. */
	readonly head: string;
	/** Last preview chunk of the projection (when the text is longer than head). */
	readonly tail: string;
}

export interface ReviewPromptParts {
	readonly text: string;
	readonly projection: string;
	readonly instructionsChars: number;
	/** Whether the composer dropped earlier work to fit the budget. */
	readonly truncated: boolean;
}

/** Describes one composed prompt for the page tab, keeping only bounded previews. */
export function toReviewContextMeta(
	prompt: ReviewPromptParts,
	recordedAt: number,
	previewChars = CONTEXT_PREVIEW_CHARS,
): ReviewContextMeta {
	return {
		recordedAt,
		promptChars: prompt.text.length,
		projectionChars: prompt.projection.length,
		instructionsChars: prompt.instructionsChars,
		estimatedTokens: estimateTokens(prompt.text),
		truncated: prompt.truncated,
		head: prompt.projection.slice(0, previewChars),
		tail:
			prompt.projection.length > previewChars
				? prompt.projection.slice(-previewChars)
				: prompt.projection,
	};
}

/** Validates one persisted context description. */
export function isReviewContextMeta(value: unknown): value is ReviewContextMeta {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		(record["recordedAt"] === undefined || typeof record["recordedAt"] === "number") &&
		typeof record["promptChars"] === "number" &&
		typeof record["projectionChars"] === "number" &&
		typeof record["instructionsChars"] === "number" &&
		typeof record["estimatedTokens"] === "number" &&
		typeof record["truncated"] === "boolean" &&
		typeof record["head"] === "string" &&
		typeof record["tail"] === "string"
	);
}
