/**
 * Runtime that sequences the policy layer against a host port. It owns the
 * review rhythm, the pending queue, the dedupe/mute lifetime and the failure
 * pause; it performs no I/O of its own, so a fake port fully exercises it.
 *
 * @module dsh-advisor/state
 */

import {
	type AcceptedReviewAdvice,
	type AdviceDedupeTag,
	BoundedAdviceDedupe,
	acceptReviewAdvice,
	adviceNoticeSummary,
	formatAdviceForDelivery,
	isAdviceSeverity,
	isContentFreeAdvice,
	parseAdviseWireInput,
	type DedupePolicy,
} from "./policy/advice.ts";
import { type AdvisorConfig } from "./policy/config.ts";
import {
	BoundedKeyedFifo,
	isAdviceFollowUpCapExhausted,
	selectAdviceDispatch,
} from "./policy/delivery.ts";
import { MuteStore } from "./policy/mutes.ts";
import {
	RECENT_NOTE_LIMIT,
	RECENT_REVIEW_LIMIT,
	type AdvisorStats,
	type NoteRecord,
	type ReviewContextMeta,
	type ReviewRecord,
	emptyAdvisorStats,
	isNoteRecord,
	isReviewContextMeta,
	isReviewRecord,
	pushBounded,
	recordReview,
	restoreAdvisorStats,
	toNoteRecord,
	toReviewRecord,
} from "./policy/stats.ts";
import type {
	AdvisorPort,
	PersistedAdvice,
	PersistedAdvisorState,
	ReviewOutcome,
} from "./port.ts";
import { ADVISOR_STATE_VERSION, fromPersistedAdvice, toPersistedAdvice } from "./port.ts";

/** Below this SimHash similarity a reworded note counts as a new finding. */
const SIMILARITY_REDELIVERY_THRESHOLD = 0.5;

/** Turns that must pass before a strictly higher severity may be re-raised. */
const RE_RAISE_MIN_TURNS = 4;

/**
 * The dedupe policy every decision uses, so the one made when a finding is
 * queued and the one made again before it is handed over cannot diverge.
 */
const DEDUPE_POLICY: DedupePolicy = {
	similarityRedeliveryThreshold: SIMILARITY_REDELIVERY_THRESHOLD,
	reRaiseMinTurns: RE_RAISE_MIN_TURNS,
};

/**
 * A persisted scalar, validated on restore. `snapshot()` writes these back, so
 * a NaN or a negative smuggled into the sidecar would either corrupt the next
 * load's shape check (NaN serializes to `null`) or start a budget below zero.
 */
function restoredCount(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Consecutive failed reviews before automatic review pauses itself. */
export const FAILURE_PAUSE_COUNT = 3;

/** Delivered-finding table bound, in memory and in the sidecar. */
const DEDUPE_CAPACITY = 4_096;
const PERSISTED_DEDUPE_LIMIT = DEDUPE_CAPACITY;

interface PendingAdvice {
	advice: AcceptedReviewAdvice;
	/** Executor turn the note was produced from; used for staleness. */
	turn: number;
	/** Why a previously delivered finding is being raised again, when it is. */
	tag?: AdviceDedupeTag;
	/**
	 * A follow-up turn was already opened for this note and closed without any
	 * model output. Waking the Executor again for it would trade a lost note for
	 * a loop of empty turns, so the retry waits for a running turn instead.
	 */
	followUpAttempted?: boolean;
}

/** A note handed to a follow-up turn, awaiting proof that the model replied. */
interface FollowUpClaim {
	key: string;
	advice: AcceptedReviewAdvice;
	/** Executor turn the note was produced from (for staleness and history). */
	turn: number;
	tag?: AdviceDedupeTag;
}

/**
 * A note handed to the running Executor's `next-step` inbox and not yet seen
 * admitted to a step.
 *
 * Display state, not accounting: the note already counts as delivered at the
 * hand-off, and this row exists so the page can show what is sitting in the
 * inbox before the next step boundary admits it. A reload forgets these rows —
 * the session's durable inbox still delivers the notes themselves — so they are
 * deliberately not part of the sidecar.
 */
export interface InFlightAdvice {
	/** Identity the host accepted the message under; the admission event carries it. */
	readonly messageId: string;
	readonly severity: AcceptedReviewAdvice["severity"];
	/** The delivered note body, so the page can show the content, not just a count. */
	readonly note: string;
	/** Executor turn the finding was produced from. */
	readonly turn: number;
	/** Hand-off time (epoch ms). */
	readonly at: number;
}

/**
 * Why the last completed review produced no note. Silence is the normal result
 * and is indistinguishable from "the plugin is not working" without this, so
 * the status surface reports it. In-memory only: a reload forgets it, and the
 * sidecar's `lastFailure` remains the durable record of real failures.
 */
export interface LastReviewOutcome {
	kind: "silent" | "finding" | "suppressed" | "failed" | "cancelled";
	turn: number;
	severity: AcceptedReviewAdvice["severity"] | undefined;
	reason: string | undefined;
}

/**
 * One review round: a user-visible reply boundary.
 *
 * It is counted on the Executor's final answer (a step with no tool calls), or
 * on a reviewable turn end that produced none. Counting turns alone was wrong:
 * a user who keeps steering while the agent runs never crosses a turn boundary,
 * so the rhythm never fired even though every reply was a completed round.
 */
export interface ReviewTick {
	/** Monotonic round number; the rhythm counts these, not turns. */
	round: number;
	/** Executor turn the round ended in, for display. */
	turnNumber: number;
	/** Upper bound of the Executor log this review would cover. */
	cursor: number;
}

export class AdvisorRuntime {
	private readonly dedupe = new BoundedAdviceDedupe(DEDUPE_CAPACITY);
	private readonly mutes = new MuteStore();
	private readonly pending: BoundedKeyedFifo<PendingAdvice>;
	private cursor = 0;
	private lastReviewedTurn: number | undefined;
	/** Last round a review was claimed for; the rhythm's durable cursor. */
	private lastReviewedRound = 0;
	private lastInstructionTurn = 0;
	/** Newest Executor turn observed; restored so pre-reload notes stay judgeable. */
	private currentTurn = 0;
	private followUpsUsed = 0;
	private failureStreak = 0;
	private paused = false;
	private disposed = false;
	private reviewInFlight = false;
	private followUpPending = false;
	private lastOutcome: LastReviewOutcome | undefined;
	/** A delivery sweep is running; a second caller must not peek the same entry. */
	private delivering = false;
	/** A concurrent caller asked for a sweep while one was running. */
	private deliveryRequested = false;
	/** Turn number of the follow-up turn this plugin opened, while it is open. */
	private pluginTurn: number | undefined;
	/**
	 * A note handed to a follow-up turn whose processing is not confirmed yet.
	 * It is still counted as delivered by nothing until the turn emits a model
	 * reply: recording it earlier is what made a restart swallow advice for good.
	 */
	private claim: FollowUpClaim | undefined;
	/** Turn the claim's follow-up opened, so its close can requeue the note. */
	private claimTurn: number | undefined;
	/**
	 * Notes handed to the running Executor's inbox and not yet admitted, oldest
	 * first, keyed by the identity the host accepted them under.
	 */
	private readonly inFlight = new Map<string, InFlightAdvice>();
	private lastFailure: { reason: string; at: number } | undefined;
	/** Cumulative review accounting; the page tab reads it. */
	private stats: AdvisorStats = emptyAdvisorStats();
	/** Newest-first bounded history, shown by the page tab. */
	private recentReviews: ReviewRecord[] = [];
	private recentNotes: NoteRecord[] = [];
	/** Description of the last compiled review prompt; the page tab shows it. */
	private lastReviewContext: ReviewContextMeta | undefined;

	constructor(
		private config: AdvisorConfig,
		private readonly port: AdvisorPort,
		private readonly sessionId: string,
	) {
		this.pending = new BoundedKeyedFifo<PendingAdvice>(config.review.maxPending);
	}

	/**
	 * Restores the durable sidecar state. Unreadable entries are skipped, not fatal.
	 *
	 * This runtime is new, so loading is also the moment this plugin was
	 * (re)configured: the persisted failure accounting describes the previous
	 * run and is deliberately NOT restored as live state. Restoring it would
	 * re-latch the failure pause, and nothing could clear it afterwards —
	 * clearing the streak happens inside a review, and `shouldReview` refuses to
	 * start one while paused, so the pause would hold until the sidecar is
	 * deleted by hand. A reload re-arms automatic review instead.
	 */
	restore(state: PersistedAdvisorState): void {
		this.cursor = restoredCount(state.cursor);
		// `0` is how the sidecar spells "never reviewed": turn numbers start at 1, so
		// keeping it as a real turn would make `everyTurns > 1` skip the first
		// `everyTurns - 1` turns of the session after every reload.
		this.lastReviewedTurn = state.lastReviewedTurn === 0 ? undefined : restoredCount(state.lastReviewedTurn);
		this.lastReviewedRound = restoredCount(state.lastReviewedRound ?? 0);
		this.currentTurn = restoredCount(state.currentTurn ?? 0);
		this.lastInstructionTurn = restoredCount(state.lastInstructionTurn ?? 0);
		this.followUpsUsed = restoredCount(state.followUpsUsed);
		this.failureStreak = 0;
		this.paused = false;
		this.lastFailure = undefined;
		this.pending.clear();
		for (const entry of state.pending) {
			if (!isPersistedPendingEntry(entry)) continue;
			this.pending.set(entry.key, {
				advice: fromPersistedAdvice(entry.advice),
				turn: entry.turn,
				...(entry.tag === undefined ? {} : { tag: entry.tag as AdviceDedupeTag }),
				...(entry.followUpAttempted === true ? { followUpAttempted: true } : {}),
			});
		}
		// A follow-up handed over by the previous process can only be unconfirmed:
		// confirmation is persisted as soon as the reply is observed, so a claim in
		// the file means the note never got a reply (a restart during the turn).
		// Put it back at the tail and record the attempt, so the restart neither
		// swallows the advice nor opens another follow-up turn for it. A later
		// observation of the same identity wins, so the claim only fills a key the
		// pending list does not already carry.
		const unconfirmed = state.pendingFollowUp;
		if (unconfirmed !== undefined && isPersistedPendingEntry(unconfirmed) && !this.pending.has(unconfirmed.key)) {
			this.pending.set(unconfirmed.key, {
				advice: fromPersistedAdvice(unconfirmed.advice),
				turn: unconfirmed.turn,
				...(unconfirmed.tag === undefined ? {} : { tag: unconfirmed.tag as AdviceDedupeTag }),
				followUpAttempted: true,
			});
		}
		this.claim = undefined;
		this.claimTurn = undefined;
		this.dedupe.restoreEntries(state.dedupe);
		this.mutes.replace(state.mutes);
		// The page tab's accounting is diagnostics, not behaviour: a malformed
		// history degrades to empty instead of rejecting the whole sidecar.
		this.stats = restoreAdvisorStats(state.stats);
		this.recentReviews = (state.recentReviews ?? []).filter(isReviewRecord).slice(0, RECENT_REVIEW_LIMIT);
		this.recentNotes = (state.recentNotes ?? []).filter(isNoteRecord).slice(0, RECENT_NOTE_LIMIT);
		this.lastReviewContext = isReviewContextMeta(state.lastReviewContext) ? state.lastReviewContext : undefined;
	}

	snapshot(): PersistedAdvisorState {
		return {
			version: ADVISOR_STATE_VERSION,
			cursor: this.cursor,
			lastReviewedTurn: this.lastReviewedTurn ?? 0,
			lastReviewedRound: this.lastReviewedRound,
			currentTurn: this.currentTurn,
			lastInstructionTurn: this.lastInstructionTurn,
			followUpsUsed: this.followUpsUsed,
			failureStreak: this.failureStreak,
			...(this.lastFailure === undefined ? {} : { lastFailure: this.lastFailure }),
			dedupe: this.dedupe.exportNewestEntries(PERSISTED_DEDUPE_LIMIT),
			mutes: this.mutes.list().map((entry) => ({ ...entry })),
			pending: this.pending.entriesInOrder().map((entry) => ({
				key: entry.key,
				advice: toPersistedAdvice(entry.value.advice),
				turn: entry.value.turn,
				...(entry.value.tag === undefined ? {} : { tag: entry.value.tag }),
				...(entry.value.followUpAttempted === true ? { followUpAttempted: true } : {}),
			})),
			...(this.claim === undefined
				? {}
				: {
						pendingFollowUp: {
							key: this.claim.key,
							advice: toPersistedAdvice(this.claim.advice),
							turn: this.claim.turn,
							...(this.claim.tag === undefined ? {} : { tag: this.claim.tag }),
							followUpAttempted: true,
						},
					}),
			stats: this.stats,
			recentReviews: this.recentReviews,
			recentNotes: this.recentNotes,
			...(this.lastReviewContext === undefined ? {} : { lastReviewContext: this.lastReviewContext }),
		};
	}

	/** A real user instruction arrived, which cancels idle follow-up for older notes. */
	noteInstructionInput(turnNumber: number): void {
		this.lastInstructionTurn = turnNumber;
		this.followUpPending = false;
		// A real instruction inside the turn this plugin claimed means that turn is
		// the user's work after all, so the claim is withdrawn and the turn stays
		// reviewable.
		if (this.pluginTurn === turnNumber) this.pluginTurn = undefined;
	}

	/**
	 * A note this plugin delivered entered the Executor's turn. Only a note that
	 * opened a turn of its own (`followUp`) makes that turn the plugin's; a steered
	 * note rides inside a turn the user opened, which stays real work.
	 */
	noteAdvisorInput(turnNumber: number): void {
		if (this.followUpPending) this.pluginTurn = turnNumber;
	}

	/**
	 * A step admitted a note this runtime steered into the inbox.
	 *
	 * The admission is the earliest proof that the note reached the model's
	 * context, so the page's in-flight row has said all it can. An id this process
	 * never handed over is ignored: a reload forgets the rows, and a note the
	 * durable inbox delivers after that is not this runtime's to confirm.
	 */
	confirmAdvisorInput(messageId: string): void {
		this.inFlight.delete(messageId);
	}

	/** Notes handed over but not yet admitted, oldest first, for the page. */
	inFlightNotes(): readonly InFlightAdvice[] {
		return [...this.inFlight.values()];
	}

	/**
	 * A turn is opening. A follow-up this plugin opened starts the next turn, so
	 * that turn is the plugin's own and must not be reviewed.
	 *
	 * Marked on the turn boundary rather than only on the note's message: a turn
	 * that dies before history assembly (a prompt or model error) records its
	 * input as an inbox splice and never emits the message event at all, so a
	 * message-source check alone would let the plugin review its own follow-up.
	 */
	noteTurnStart(turnNumber: number): void {
		this.currentTurn = Math.max(this.currentTurn, turnNumber);
		if (this.followUpPending) {
			this.pluginTurn = turnNumber;
			// The follow-up this claim was created for is the turn now opening.
			if (this.claim !== undefined && this.claimTurn === undefined) this.claimTurn = turnNumber;
		}
	}

	/**
	 * A model reply was observed for this session.
	 *
	 * A follow-up note counts as delivered only now: a reply proves the turn ran
	 * with the note, while the hand-off alone did not (a restart or an immediate
	 * interrupt could leave it unread). Returns true when this confirmed a claim,
	 * so the host persists the confirmation before a restart can undo it.
	 *
	 * The reply must belong to the claim's own turn: a claim still unbound to a
	 * turn was never handed to one (the host accepted the follow-up but never
	 * opened it), and letting an unrelated turn's reply confirm it is how a note
	 * got marked delivered without ever reaching the model.
	 */
	noteModelOutput(turnNumber: number): boolean {
		const claim = this.claim;
		if (claim === undefined) return false;
		if (this.claimTurn === undefined || this.claimTurn !== turnNumber) return false;
		this.claim = undefined;
		this.claimTurn = undefined;
		this.dedupe.add(claim.advice, this.currentTurn);
		this.recentNotes = pushBounded(
			this.recentNotes,
			toNoteRecord(claim.turn, this.port.now(), claim.advice.severity, claim.advice.note, claim.tag),
			RECENT_NOTE_LIMIT,
		);
		return true;
	}

	/**
	 * A turn closed. A claim whose turn closes without a model reply never got
	 * processed, so the note goes back into the queue with the attempt recorded:
	 * retrying cannot open another follow-up turn for it (that is how a lost note
	 * would turn into a loop of empty turns), but a later running turn can still
	 * be steered with it. Returns true when a note was requeued.
	 */
	noteTurnEnd(turnNumber: number): boolean {
		if (this.claimTurn !== turnNumber) return false;
		this.claimTurn = undefined;
		const claim = this.claim;
		if (claim === undefined) return false;
		this.claim = undefined;
		this.pending.set(claim.key, {
			advice: claim.advice,
			turn: claim.turn,
			...(claim.tag === undefined ? {} : { tag: claim.tag }),
			followUpAttempted: true,
		});
		return true;
	}

	/**
	 * The follow-up note handed over but not yet confirmed, for the status
	 * surface: it is neither in the queue nor in the delivered history.
	 */
	awaitingAdvice(): { severity: AcceptedReviewAdvice["severity"]; note: string; turn: number } | undefined {
		const claim = this.claim;
		return claim === undefined
			? undefined
			: { severity: claim.advice.severity, note: claim.advice.note, turn: claim.turn };
	}

	/** Whether a follow-up turn this plugin opened is still open. */
	get openFollowUp(): boolean {
		return this.followUpPending;
	}

	/**
	 * Closes the turn an Executor `turn/end` reported. Returns true when that turn
	 * was opened by this plugin's own follow-up: it is not Executor work, so it
	 * must not be reviewed, and it frees the follow-up window it occupied.
	 */
	closePluginTurn(turnNumber: number): boolean {
		if (this.pluginTurn !== turnNumber) return false;
		this.pluginTurn = undefined;
		this.followUpPending = false;
		// Safety net for callers that observe the close without the separate
		// turn-end hook: a note the turn never answered must not be dropped.
		this.noteTurnEnd(turnNumber);
		return true;
	}

	/**
	 * Whether this round should start a review. `everyTurns` counts rounds, so
	 * a conversation that never crosses a turn boundary (the user keeps steering
	 * into the running turn) still gets one review per reply.
	 */
	shouldReview(tick: ReviewTick): boolean {
		if (!this.config.enabled || this.config.model === undefined) return false;
		if (this.paused || this.reviewInFlight || this.disposed) return false;
		// A turn this plugin opened with its own follow-up is not Executor work. The
		// observer skips the round before counting it; this is the second line of
		// defence for any other path that reaches the rhythm.
		if (this.pluginTurn !== undefined && this.pluginTurn === tick.turnNumber) return false;
		// 0 is "never reviewed": the first round is due immediately, like the old
		// turn-based rule treated the first turn. `gap > 0` guards the restored
		// cursor: the observer re-seeds its round counter from it, so a negative gap
		// can only mean a numbering mismatch, never "not enough rounds yet".
		const gap = tick.round - this.lastReviewedRound;
		if (this.lastReviewedRound > 0 && gap > 0 && gap < this.config.review.everyTurns) {
			return false;
		}
		this.lastReviewedRound = tick.round;
		this.lastReviewedTurn = tick.turnNumber;
		this.cursor = tick.cursor;
		this.reviewInFlight = true;
		return true;
	}

	/** Whether the given turn was opened by this plugin's own follow-up note. */
	isPluginTurn(turnNumber: number): boolean {
		return this.pluginTurn === turnNumber;
	}

	/** Newest Executor turn this runtime observed (restored from the sidecar). */
	get currentTurnNumber(): number {
		return this.currentTurn;
	}

	/** Last round a review was claimed for; the observer continues numbering from it. */
	get reviewedRounds(): number {
		return this.lastReviewedRound;
	}

	/**
	 * Records the compiled prompt the next review is about to send. The full text
	 * stays in the observer (it can be large); only this bounded description is
	 * persisted and reported.
	 */
	noteReviewContext(context: ReviewContextMeta): void {
		this.lastReviewContext = context;
	}

	/**
	 * Replaces the effective configuration of a live reviewer. The page edits it
	 * at runtime, and the next review must use the new route/bounds.
	 */
	applyConfig(config: AdvisorConfig): void {
		this.config = config;
	}

	/** Applies one review outcome, then attempts delivery. */
	async completeReview(outcome: ReviewOutcome, turnNumber: number): Promise<void> {
		this.reviewInFlight = false;
		switch (outcome.kind) {
			case "cancelled":
				// Recorded for diagnosis but deliberately not counted: teardown and
				// reload cancel reviews structurally, and counting them would pause
				// automatic review for a reason that says nothing about reviewing.
				this.lastFailure = { reason: outcome.reason, at: this.port.now() };
				this.lastOutcome = {
					kind: "cancelled",
					turn: turnNumber,
					severity: undefined,
					reason: outcome.reason,
				};
				break;
			case "failed":
				this.failureStreak++;
				this.lastFailure = { reason: outcome.reason, at: this.port.now() };
				if (this.failureStreak >= FAILURE_PAUSE_COUNT) this.paused = true;
				this.lastOutcome = {
					kind: "failed",
					turn: turnNumber,
					severity: undefined,
					reason: outcome.reason,
				};
				break;
			case "silent":
				this.failureStreak = 0;
				this.lastFailure = undefined;
				this.lastOutcome = {
					kind: "silent",
					turn: turnNumber,
					severity: undefined,
					reason: undefined,
				};
				break;
			case "finding": {
				this.failureStreak = 0;
				this.lastFailure = undefined;
				const advice = outcome.advice;
				if (this.mutes.isMuted(advice.findingKeyHash)) {
					this.lastOutcome = {
						kind: "suppressed",
						turn: turnNumber,
						severity: advice.severity,
						reason: "muted",
					};
					break;
				}
				const decision = this.dedupe.decide(advice, turnNumber, DEDUPE_POLICY);
				if (decision.outcome === "suppress") {
					this.lastOutcome = {
						kind: "suppressed",
						turn: turnNumber,
						severity: advice.severity,
						reason: "already delivered",
					};
					break;
				}
				this.pending.set(advice.findingKeyHash, {
					advice,
					turn: turnNumber,
					...(decision.tag === undefined ? {} : { tag: decision.tag }),
				});
				this.lastOutcome = {
					kind: "finding",
					turn: turnNumber,
					severity: advice.severity,
					reason: decision.tag,
				};
				break;
			}
		}
		this.recordReviewOutcome(outcome, turnNumber);
		// Attempted after every outcome, not only after a finding: a note queued by an
		// earlier review may have become deliverable meanwhile (the Executor went
		// idle, or the follow-up window closed), and a silent or suppressed review
		// would otherwise leave it parked until the user spoke again.
		try {
			await this.deliverPending();
		} catch (error) {
			// Delivery talks to the host and may fail while the review itself
			// succeeded. Letting that rejection escape would make the scheduler
			// account this same review a second time as a failure; the note stays
			// queued and the next sweep retries it.
			this.port.warn?.(
				`advisor delivery failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Folds one settled review into the page tab's accounting: counts by
	 * outcome, provider-reported tokens, wall time, and the bounded history.
	 *
	 * The outcome kind is the review's own (a finding that dedupe later
	 * suppresses was still a finding); `lastOutcome` separately records what the
	 * delivery decision did with it.
	 */
	private recordReviewOutcome(outcome: ReviewOutcome, turnNumber: number): void {
		const usage = outcome.usage ?? {
			durationMs: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		};
		const record = toReviewRecord({
			turn: turnNumber,
			at: this.port.now(),
			kind: outcome.kind,
			...(outcome.kind === "finding"
				? {
						severity: outcome.advice.severity,
						note: outcome.advice.note,
					}
				: {}),
			...(outcome.kind === "failed" || outcome.kind === "cancelled"
				? { reason: outcome.reason }
				: {}),
			usage,
		});
		this.stats = recordReview(this.stats, record);
		this.recentReviews = pushBounded(this.recentReviews, record, RECENT_REVIEW_LIMIT);
	}

	/**
	 * The single delivery path, shared by a finished review and by the deferred
	 * flush. Executor status is re-read on every iteration: a snapshot taken
	 * earlier may already be stale, and steering an idle driver would open an
	 * unapproved turn.
	 */
	async deliverPending(): Promise<void> {
		if (this.delivering) {
			// `readStatus` awaits, so a review finishing while a sweep is suspended
			// would otherwise peek the same entry and hand it over twice. Let the
			// running sweep take another pass instead of starting a second one.
			this.deliveryRequested = true;
			return;
		}
		this.delivering = true;
		try {
			do {
				this.deliveryRequested = false;
				await this.drainPending();
			} while (this.deliveryRequested);
		} finally {
			this.delivering = false;
		}
	}

	/**
	 * One sweep over the queue. An entry that cannot be handed over right now is
	 * skipped rather than stopping the sweep: a deferred `nit` must not keep a
	 * `blocker` queued behind it forever. Skipped entries stay queued for the next
	 * sweep; the value identity is what is remembered, so an entry replaced under
	 * the same key (a re-found finding with a different severity) is re-judged.
	 */
	private async drainPending(): Promise<void> {
		const skipped = new Set<PendingAdvice>();
		for (const entry of this.pending.entriesInOrder()) {
			const current = entry.value;
			if (skipped.has(current)) continue;
			// Checked here, not only when the note was queued: a mute written while
			// the note waited must still stop it.
			if (this.mutes.isMuted(current.advice.findingKeyHash)) {
				this.pending.deleteIf(entry.key, current);
				continue;
			}
			const status = await this.port.readStatus(this.sessionId);
			// The Executor is gone, so nothing can be delivered to it. Consuming the
			// note here would record it as delivered and suppress it for good.
			if (status === undefined) return;
			// Re-judged with the same policy that queued it, because the dedupe table
			// can have learned this identity since: confirming an earlier hand-off
			// records it, and the note must not be delivered a second time then.
			// Only the suppress verdict is acted on here: a `deliver` verdict would
			// carry a tag this entry did not get when it was queued, and re-tagging a
			// note that was already judged once is not this check's job.
			if (this.dedupe.decide(current.advice, current.turn, DEDUPE_POLICY).outcome === "suppress") {
				this.pending.deleteIf(entry.key, current);
				continue;
			}
			const decision = selectAdviceDispatch({
				forceDeferred: this.disposed,
				idle: status.idle,
				newerInstructionInput: this.lastInstructionTurn > current.turn,
				severity: current.advice.severity,
				activeIdleSeverities: this.config.delivery.activeIdleSeverities,
				reviewFollowUpPending: this.followUpPending,
				reviewFollowUpCapExhausted: isAdviceFollowUpCapExhausted(this.followUpsUsed),
				followUpAttempted: current.followUpAttempted === true,
			});
			if (decision === "deferred") {
				skipped.add(current);
				continue;
			}
			const stale = status.turnNumber > current.turn;
			const message = {
				text: formatAdviceForDelivery(
					current.advice,
					stale ? "deferred" : "active",
					stale,
					current.tag,
				),
				summary: adviceNoticeSummary(current.advice, stale, current.tag),
			};
			if (decision === "followUp") {
				// Marked before the call: the turn this opens is announced as soon as
				// `followup()` runs, and the claim has to already be in place by then.
				this.followUpPending = true;
				this.claim = {
					key: entry.key,
					advice: current.advice,
					turn: current.turn,
					...(current.tag === undefined ? {} : { tag: current.tag }),
				};
				this.claimTurn = undefined;
				if (!this.port.followUp(this.sessionId, message)) {
					this.followUpPending = false;
					this.claim = undefined;
					return;
				}
				// The note leaves the queue but is not recorded as delivered yet: only
				// a model reply proves the follow-up turn processed it (`noteModelOutput`
				// confirms, `noteTurnEnd` requeues). Recording it here is what let a
				// restart swallow a note that never reached the model.
				this.pending.deleteIf(entry.key, current);
				this.followUpsUsed++;
				// One open follow-up turn at a time; the rest wait for the next sweep.
				return;
			}
			const deliveredId = this.port.steer(this.sessionId, message);
			if (deliveredId === undefined) {
				// A refused delivery stays queued and is retried by the next flush. The
				// note must not be recorded as delivered: that would suppress it forever.
				return;
			}
			// Recorded only after delivery: a note still in the queue must not
			// suppress its own next attempt. A steer rides inside a turn the user is
			// already running, so the step boundary that accepts it is the proof.
			this.dedupe.add(current.advice, status.turnNumber);
			this.recentNotes = pushBounded(
				this.recentNotes,
				toNoteRecord(
					current.turn,
					this.port.now(),
					current.advice.severity,
					current.advice.note,
					current.tag,
				),
				RECENT_NOTE_LIMIT,
			);
			// Display state: the note now sits in the inbox until a step admits it.
			// The admission event (same identity) removes this row; the accounting
			// above stays at the hand-off, as it was before this row existed.
			this.inFlight.set(deliveredId, {
				messageId: deliveredId,
				severity: current.advice.severity,
				note: current.advice.note,
				turn: current.turn,
				at: this.port.now(),
			});
			this.pending.deleteIf(entry.key, current);
		}
	}

	/** Stops delivering: a note still queued must not be steered into an unloaded row. */
	dispose(): void {
		this.disposed = true;
		this.inFlight.clear();
	}

	get isPaused(): boolean {
		return this.paused;
	}

	get pendingCount(): number {
		return this.pending.length;
	}

	/** Why the last completed review produced no note; undefined until one settles. */
	lastReviewOutcome(): LastReviewOutcome | undefined {
		return this.lastOutcome;
	}
}

/**
 * Accepts one `advise` tool call from the review subagent. Returns the accepted
 * advice, or undefined when the call is well-formed but says nothing.
 */
export function acceptAdviseCall(
	args: unknown,
	config: AdvisorConfig,
	now: number,
): AcceptedReviewAdvice | undefined {
	const parsed = parseAdviseWireInput(args);
	if (parsed === undefined) return undefined;
	if (isContentFreeAdvice(parsed.note)) return undefined;
	return acceptReviewAdvice(parsed, { maxAdviceChars: config.review.maxAdviceChars, now });
}

function isPersistedPendingEntry(value: unknown): value is {
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
