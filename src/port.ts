/**
 * The seam between the pure policy layer and the host. `state.ts` only ever
 * talks to the host through this interface, which keeps the policy testable
 * with a fake and keeps every dsh call inside `host/`.
 *
 * @module dsh-advisor/port
 */

import {
	isAdviceSeverity,
	type AcceptedReviewAdvice,
	type AdviceDedupeTag,
	type PersistedDedupeEntry,
} from "./policy/advice.ts";
import type { AdvisorStats, NoteRecord, ReviewContextMeta, ReviewRecord, ReviewUsage } from "./policy/stats.ts";

/** Executor state as read at delivery time, never as a snapshot from enqueue time. */
export interface ExecutorStatus {
	idle: boolean;
	/** The newest Executor turn number, used for re-raise spacing and self-review refusal. */
	turnNumber: number;
}

/**
 * One review outcome. A review either stays silent, finds one thing, or fails.
 * `usage` is what the review child consumed, reported by the provider across
 * its steps; a review that never reached a model (creation failure) has none.
 */
export type ReviewOutcome = (
	| { kind: "silent" }
	| { kind: "finding"; advice: AcceptedReviewAdvice }
	| { kind: "failed"; reason: string }
	/**
	 * The owner cancelled the review (teardown, reload). Neutral: it is not
	 * evidence that reviewing is broken, so it must not feed the failure pause.
	 */
	| { kind: "cancelled"; reason: string }
) & { usage?: ReviewUsage };

export interface ReviewRequest {
	sessionId: string;
	/** Executor log position at request time; folds into the review child's session id. */
	cursor: number;
	/**
	 * The compiled prompt for this review (fixed instructions + bounded
	 * projection, composed in the host). Reading the Executor log and bounding it
	 * stay in the host, so the review driver only drives the child.
	 */
	prompt: string;
	/**
	 * Cancels the review. Aborted when the plugin is disposing, so a review can
	 * never outlive its owner and create an agent on an inactive context.
	 */
	signal?: AbortSignal;
}

/**
 * Version of the durable sidecar layout. It is independent of the configuration
 * file version (`ADVISOR_CONFIG_VERSION`): a configuration change that cannot
 * read old `config.json` files must not make every session's state unreadable.
 */
export const ADVISOR_STATE_VERSION = 1;

/** Durable sidecar state for one Executor session. */
export interface PersistedAdvisorState {
	version: number;
	lastReviewedTurn: number;
	/**
	 * Steps seen so far, and the step count when the last review attempt finished.
	 * The rhythm is a single step cadence whose counters are absolute: restored so
	 * a reload mid-session resumes the cadence instead of restarting it.
	 */
	stepsTotal?: number;
	lastReviewedStep?: number;
	followUpsUsed: number;
	/**
	 * Consecutive failed reviews at the moment the sidecar was last written. A
	 * record of the previous run, not live state: a fresh plugin load clears the
	 * streak, which is what makes the failure pause recoverable at all.
	 */
	failureStreak: number;
	/**
	 * Why the last review produced no note. Records real failures and cancellations
	 * alike; only failures advance `failureStreak`.
	 */
	lastFailure?: { reason: string; at: number };
	dedupe: PersistedDedupeEntry[];
	/** Muted finding identities. Survives review-epoch changes; user data. */
	mutes: PersistedMute[];
	/** Pending notes in delivery order, keyed by the finding identity hash. */
	pending: PersistedPendingAdvice[];
	/**
	 * Newest Executor turn observed when the sidecar was written. Restored so a
	 * note queued before a reload is still judged against the conversation it
	 * belongs to instead of looking fresh at turn 0.
	 */
	currentTurn?: number;
	/** Last turn in which a real user instruction arrived, for staleness. */
	lastInstructionTurn?: number;
	/** Cumulative review accounting for the page tab. */
	stats?: AdvisorStats;
	/** Newest-first bounded review history for the page tab. */
	recentReviews?: ReviewRecord[];
	/** Newest-first bounded delivered-note history for the page tab. */
	recentNotes?: NoteRecord[];
	/** Description of the prompt the last review sent to the reviewer model. */
	lastReviewContext?: ReviewContextMeta;
	/**
	 * A note handed to a follow-up turn that was never confirmed as processed
	 * before the process ended. On restore it goes back to `pending` with the
	 * follow-up attempt recorded, so a restart cannot silently swallow advice.
	 */
	pendingFollowUp?: PersistedPendingAdvice;
}

export interface PersistedPendingAdvice {
	key: string;
	advice: PersistedAdvice;
	turn: number;
	/** Why a previously delivered finding is raised again, when it is. */
	tag?: string;
	/** The note was already handed to a follow-up turn once (see `AdviceHoldReason`). */
	followUpAttempted?: boolean;
}

export interface PersistedMute {
	hash: string;
	label: string;
}

/** `bigint` cannot round-trip through JSON, so signatures persist as hex. */
export interface PersistedAdvice {
	note: string;
	severity: AcceptedReviewAdvice["severity"];
	findingKey: string;
	findingKeyHash: string;
	createdAt: number;
	signature: string;
}

/** Model-facing note plus the one line the collapsed chat row shows. */
export interface DeliveredAdvice {
	text: string;
	summary: string;
}

/** Outcome of reading one session's sidecar. */
export type SidecarLoad =
	| { kind: "missing" }
	| { kind: "present"; state: PersistedAdvisorState }
	| { kind: "unreadable"; reason: string };

export interface AdvisorPort {
	/** Read the Executor's current status. Called immediately before delivery. */
	readStatus(sessionId: string): Promise<ExecutorStatus | undefined>;
	/**
	 * Deliver at the next step boundary; only valid while the Executor is running.
	 *
	 * Returns the identity the host accepted the message under, or undefined when
	 * it refused the delivery. The identity is what lets the runtime confirm that
	 * a later step actually admitted the note: a hand-off alone is not proof.
	 */
	steer(sessionId: string, message: DeliveredAdvice): string | undefined;
	/** Wake an idle Executor with one exclusive turn. */
	followUp(sessionId: string, message: DeliveredAdvice): boolean;
	/** Run one review with a fresh, restricted subagent. */
	runReview(request: ReviewRequest): Promise<ReviewOutcome>;
	now(): number;
	/** Host log, for diagnostics that must not change behaviour. */
	warn?(message: string): void;
}

export function toPersistedAdvice(advice: AcceptedReviewAdvice): PersistedAdvice {
	return {
		note: advice.note,
		severity: advice.severity,
		findingKey: advice.findingKey,
		findingKeyHash: advice.findingKeyHash,
		createdAt: advice.createdAt,
		signature: advice.signature.toString(16).padStart(16, "0"),
	};
}

export function fromPersistedAdvice(persisted: PersistedAdvice): AcceptedReviewAdvice {
	return {
		intent: "review",
		note: persisted.note,
		severity: persisted.severity,
		findingKey: persisted.findingKey,
		findingKeyHash: persisted.findingKeyHash,
		createdAt: persisted.createdAt,
		signature: BigInt(`0x${persisted.signature}`),
	};
}

/**
 * Normalizes a review outcome for accounting.
 *
 * Teardown cancels an in-flight review through the host's own parent-child
 * cancellation, which surfaces as an abort indistinguishable from a real
 * failure. While the owner is disposing, nothing that happens to a review is
 * evidence that reviewing is broken, so such an outcome must not feed the
 * failure pause.
 */
export function settleReviewOutcome(outcome: ReviewOutcome, disposing: boolean): ReviewOutcome {
	if (disposing && outcome.kind === "failed") {
		// The reported usage still belongs to the review that ran: dropping it
		// would make the tab under-report a review whose cost is known.
		return { ...outcome, kind: "cancelled", reason: outcome.reason };
	}
	return outcome;
}

/** Validates one persisted advice body; a sidecar is a plain editable file. */
function isPersistedAdvice(value: unknown): value is PersistedAdvice {
	if (typeof value !== "object" || value === null) return false;
	const advice = value as Partial<PersistedAdvice>;
	return (
		typeof advice.note === "string" &&
		isAdviceSeverity(advice.severity) &&
		typeof advice.findingKey === "string" &&
		typeof advice.findingKeyHash === "string" &&
		/^[a-f0-9]{64}$/u.test(advice.findingKeyHash) &&
		typeof advice.createdAt === "number" &&
		typeof advice.signature === "string" &&
		/^[a-f0-9]{16}$/u.test(advice.signature)
	);
}

/** Validates one queued, not-yet-delivered advice entry. */
export function isPersistedPendingEntry(value: unknown): value is {
	key: string;
	advice: PersistedAdvice;
	turn: number;
	tag?: AdviceDedupeTag;
	followUpAttempted?: boolean;
} {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as { key?: unknown; advice?: unknown; turn?: unknown; tag?: unknown; followUpAttempted?: unknown };
	const tag = entry.tag;
	return (
		typeof entry.key === "string" &&
		typeof entry.turn === "number" &&
		Number.isSafeInteger(entry.turn) &&
		isPersistedAdvice(entry.advice) &&
		(tag === undefined || tag === "possible-duplicate" || tag === "re-raised") &&
		(entry.followUpAttempted === undefined || typeof entry.followUpAttempted === "boolean")
	);
}
