/**
 * Event wiring: observes top-level Executor sessions, decides when a review is
 * due, and owns one runtime per session.
 *
 * @module dsh-advisor/host/subscription
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentStatus } from "@deepseek-ai/dsh-agent";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import { SessionId } from "@deepseek-ai/dsh-session";

import type { AdvisorConfig } from "../policy/config.ts";
import { isAdvisorActive } from "../policy/config.ts";
import {
	explainAdviceHold,
	isAdviceFollowUpCapExhausted,
	REVIEW_FOLLOW_UP_SESSION_CAP,
} from "../policy/delivery.ts";
import { toReviewContextMeta } from "../policy/stats.ts";
import type { AdvisorPort, ExecutorStatus, ReviewOutcome } from "../port.ts";
import { describeEvent } from "../policy/transcript.ts";
import { settleReviewOutcome } from "../port.ts";
import { AdvisorRuntime, type ReviewTick } from "../state.ts";
import { createAdvisorMessage } from "./delivery.ts";
import { ConfigOverridesStore } from "./config-store.ts";
import {
	applyConfigPatch,
	canPersistConfigPatch,
	describeConfig,
	toConfigPatch,
	type AdvisorConfigPatch,
} from "../policy/overrides.ts";
import { composeReviewPrompt } from "./prompt.ts";
import { runReview } from "./review.ts";
import { SidecarStore } from "./sidecar.ts";
import { registerAdvisorStatus, type AdvisorStatus } from "./status.ts";

/** Turn-end reasons worth reviewing. A user-cut-short turn is never critiqued. */
const REVIEWABLE_TURN_END = new Set(["completed", "max-tokens", "error"]);

/**
 * Whether one assembled assistant message closes a user-visible round: it made
 * no tool call and carried at least some text. An empty max-tokens message is
 * not a reply; its turn end handles the round instead.
 */
function isFinalAnswer(message: { content?: readonly unknown[] }): boolean {
	const content = Array.isArray(message.content) ? message.content : [];
	let text = false;
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const kind = (block as { type?: unknown }).type;
		if (kind === "tool-call" || kind === "tool-addition" || kind === "tool-removal") return false;
		const value = (block as { text?: unknown }).text;
		if (typeof value === "string" && value.trim().length > 0) text = true;
	}
	return text;
}

/** Recent material kept per session for the next review. */
const TRANSCRIPT_LINE_LIMIT = 400;

interface ObservedSession {
	sessionId: string;
	runtime: AdvisorRuntime;
	/** The host seam this session's runtime was built with, for the review driver. */
	port: AdvisorPort;
	cwd: string;
	transcript: string[];
	cursor: number;
	currentTurn: number;
	/** Compiled prompt of the last review, kept for the page route (never persisted). */
	lastPrompt?: string;
	/** User-visible reply rounds seen for this session. */
	round: number;
	/**
	 * Turn whose reply already counted as a round. Its `turn/end` must not count
	 * again, or every normal turn would be reviewed twice at `everyTurns: 1`.
	 */
	roundCountedTurn?: number | undefined;
	restored: boolean;
	/** The in-flight sidecar load, so concurrent callers share one read. */
	restoreTask?: Promise<void>;
	/** The in-flight sidecar write chain, so snapshots reach disk in order. */
	writeTask?: Promise<void>;
	/** Aborted when this session is disposed, so its review does not outlive it. */
	reviewAbort: AbortController;
	reviewing: boolean;
	/**
	 * Newest turn to have ended while a review was in flight. Only the latest is
	 * kept: turn numbers are monotonic and the review rhythm only asks whether
	 * enough turns have passed since the last reviewed one.
	 */
	pendingReviewTick: ReviewTick | undefined;
}

export interface ObserverDeps {
	readonly ctx: Context;
	config: AdvisorConfig;
	readonly stateRoot: string;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class SessionObserver {
	private readonly states = new Map<string, ObservedSession>();
	private readonly store: SidecarStore;
	private readonly overrides: ConfigOverridesStore;
	private readonly disposers: (() => void)[] = [];
	private readonly logger;
	private disposed = false;
	/** Aborted on dispose so an in-flight review cannot outlive this observer. */
	private readonly reviews = new AbortController();

	constructor(private readonly deps: ObserverDeps) {
		this.store = new SidecarStore(deps.stateRoot);
		this.overrides = new ConfigOverridesStore(deps.stateRoot);
		this.logger = deps.ctx.logger("dsh-advisor");
		this.disposers.push(
			deps.ctx.on("session/event", (session, event) => {
				this.observe(session, event);
			}),
		);
		this.disposers.push(
			deps.ctx.on("agent/status", ({ agent, status }) => {
				// An escape here would abort the whole process on every status event.
				void this.statusChanged(agent, status).catch((error) => {
					this.logger.warn(`status handling failed: ${describeError(error)}`);
				});
			}),
		);
		this.disposers.push(
			deps.ctx.on("session/disposed", (session) => {
				const observed = this.states.get(session.id);
				// A review still running for a disposed session would keep its child
				// agent alive for up to `timeoutMs` and then write a sidecar for a
				// session that no longer exists.
				observed?.reviewAbort.abort();
				observed?.runtime.dispose();
				this.states.delete(session.id);
			}),
		);
		// Injected, not part of the top-level `inject` list: the commands surface is
		// optional, and a host without it must still load the plugin. The fiber is
		// re-run if the service arrives later, and the callback returns the
		// registration disposer so that re-run (and this fiber's disposal) removes
		// the old registration instead of leaving a stale duplicate behind.
		const commands = deps.ctx.inject(["commands"], (commandsCtx) => {
			const registry = commandsCtx.get("commands") as Parameters<typeof registerAdvisorStatus>[0];
			return registerAdvisorStatus(registry, { describe: (agent) => this.describe(agent) });
		});
		this.disposers.push(() => {
			void commands.dispose();
		});
	}

	dispose(): void {
		this.disposed = true;
		this.reviews.abort();
		for (const dispose of this.disposers) dispose();
		this.disposers.length = 0;
		for (const observed of this.states.values()) {
			observed.reviewAbort.abort();
			observed.runtime.dispose();
		}
		this.states.clear();
	}

	private observe(session: Session, event: SessionEvent): void {
		if (!isAdvisorActive(this.deps.config)) return;
		// The review child is itself a session; reviewing it would be self-review.
		if (session.header.origin === "subagent") return;

		const observed = this.stateFor(session);
		observed.cursor = event.seq;
		switch (event.type) {
			case "turn/start":
				observed.currentTurn = event.data.turn;
				observed.runtime.noteTurnStart(event.data.turn);
				return;
			case "user/message": {
				if (event.data.source?.kind === "advisor") {
					// This plugin's own note: it must not count as user input and must not
					// enter the material a later review reads, or the review reviews itself.
					observed.runtime.noteAdvisorInput(observed.currentTurn);
					return;
				}
				// Only a real user instruction cancels idle follow-up and withdraws a
				// plugin-turn claim. Injected context (`agent.inject`: file-change
				// notices, skill content, cron) also arrives as `user/message` and is
				// not the user speaking.
				if (event.data.source?.kind === "user") {
					observed.runtime.noteInstructionInput(observed.currentTurn);
				}
				break;
			}
			case "assistant/message": {
				// The reply is part of the material under review, so it enters the
				// transcript BEFORE the round is dispatched: returning here without the
				// shared append would blind every review to the assistant's own work.
				this.appendTranscript(observed, event);
				// A completed model reply is the proof that a delivered follow-up was
				// actually processed. A cancelled (partial) reply is not: the note may
				// have been cut off before anything acted on it. Persisted immediately,
				// because a restart right after the reply would requeue a note the model
				// already acted on.
				if (event.data.interrupted !== true && observed.runtime.noteModelOutput(event.data.turn)) {
					this.persistSoon(observed);
				}
				// A turn this plugin opened with its follow-up is not Executor work.
				// Counting it would review the acknowledgement, and a finding there
				// could queue another follow-up — a self-sustaining review loop.
				if (observed.runtime.isPluginTurn(event.data.turn)) return;
				// A user-cancelled turn finalizes its delivered text as a message with
				// `interrupted: true`; the turn end is deliberately excluded from
				// review, and the reply must be too.
				if (event.data.interrupted === true) return;
				// A model reply with no tool call ends a round from the reader's point
				// of view — even while the turn stays open because the user kept
				// steering. That is the only boundary in a long steered turn.
				if (!isFinalAnswer(event.data.message)) return;
				observed.roundCountedTurn = event.data.turn;
				void this.reviewRound(observed, event.data.turn);
				return;
			}
			case "turn/end": {
				// A follow-up turn that closes without a model reply never processed its
				// note; the runtime puts it back in the queue and we persist that here,
				// because the note is otherwise lost to the next restart.
				if (observed.runtime.noteTurnEnd(event.data.turn)) this.persistSoon(observed);
				// A turn boundary retires the round marker whatever its reason: the
				// field's invariant is that it only ever names the turn currently open.
				const countedReply = observed.roundCountedTurn === event.data.turn;
				if (countedReply) observed.roundCountedTurn = undefined;
				if (observed.runtime.closePluginTurn(event.data.turn)) {
					// A turn this plugin opened is not Executor work: it is never
					// reviewed, only recorded as no longer in flight. Closing it also
					// frees the follow-up window, so anything waiting behind it is
					// flushed now instead of at the user's next message.
					void this.flushAfterPluginTurn(observed);
					return;
				}
				if (!REVIEWABLE_TURN_END.has(event.data.reason.kind)) return;
				// A turn whose reply already counted is not a second round.
				if (countedReply) return;
				void this.reviewRound(observed, event.data.turn);
				return;
			}
			default:
				break;
		}
		this.appendTranscript(observed, event);
	}

	/**
	 * Records one model-visible event as a bounded transcript line.
	 *
	 * The material reaches a model and the child's own session log; `describeEvent`
	 * redacts secrets observed in tool output before bounding the line.
	 */
	private appendTranscript(observed: ObservedSession, event: SessionEvent): void {
		const line = describeEvent(event);
		if (line === undefined) return;
		observed.transcript.push(line);
		if (observed.transcript.length > TRANSCRIPT_LINE_LIMIT) {
			observed.transcript.splice(0, observed.transcript.length - TRANSCRIPT_LINE_LIMIT);
		}
	}

	/**
	 * The status surface for one session: the same state the review and delivery
	 * paths use, reported instead of acted on. A session the observer has not seen
	 * yet is registered on demand, so an idle session resumed after a plugin
	 * reload still answers with its persisted state.
	 */
	async describe(agent: Agent): Promise<AdvisorStatus | undefined> {
		if (this.disposed) return undefined;
		const observed = this.stateFor(agent.session);
		if (!(await this.ensureRestored(observed))) return undefined;
		const state = observed.runtime.snapshot();
		const outcome = observed.runtime.lastReviewOutcome();
		const awaiting = observed.runtime.awaitingAdvice();
		const head = state.pending[0];
		// The same predicate the delivery loop uses, so the tab's explanation and
		// the actual hand-off cannot disagree. The head entry is the one the next
		// sweep would try first.
		const hold =
			head === undefined
				? undefined
				: explainAdviceHold({
						idle: agent.status === "idle",
						newerInstructionInput: (state.lastInstructionTurn ?? 0) > head.turn,
						severity: head.advice.severity,
						activeIdleSeverities: this.deps.config.delivery.activeIdleSeverities,
						reviewFollowUpPending: observed.runtime.openFollowUp,
						reviewFollowUpCapExhausted: isAdviceFollowUpCapExhausted(state.followUpsUsed),
						followUpAttempted: head.followUpAttempted === true,
					});
		const { model } = this.deps.config;
		return {
			enabled: this.deps.config.enabled,
			...(model === undefined ? {} : { model }),
			paused: observed.runtime.isPaused,
			currentTurn: observed.currentTurn,
			reviewing: observed.reviewing,
			lastReviewedTurn: state.lastReviewedTurn,
			...(outcome === undefined ? {} : { lastOutcome: outcome }),
			followUpsUsed: state.followUpsUsed,
			followUpCap: REVIEW_FOLLOW_UP_SESSION_CAP,
			failureStreak: state.failureStreak,
			...(state.lastFailure === undefined ? {} : { lastFailure: state.lastFailure }),
			pending: {
				count: state.pending.length,
				severities: state.pending.map((entry) => entry.advice.severity),
				...(hold === undefined ? {} : { hold }),
			},
			pendingNotes: state.pending.map((entry) => ({
				severity: entry.advice.severity,
				// The tab is a summary, not a second copy of the conversation.
				note: entry.advice.note.slice(0, 400),
				...(entry.followUpAttempted === true ? { attempted: true } : {}),
			})),
			...(awaiting === undefined
				? {}
				: {
						awaiting: {
							count: 1,
							severities: [awaiting.severity],
							notes: [
								{
									severity: awaiting.severity,
									note: awaiting.note.slice(0, 400),
									turn: awaiting.turn,
								},
							],
						},
					}),
			muted: state.mutes.length,
			delivered: state.dedupe.length,
			...(state.stats === undefined ? {} : { stats: state.stats }),
			...(state.recentReviews === undefined ? {} : { recentReviews: state.recentReviews }),
			...(state.recentNotes === undefined ? {} : { recentNotes: state.recentNotes }),
			...(state.lastReviewContext === undefined ? {} : { lastReviewContext: state.lastReviewContext }),
			config: describeConfig(this.deps.config),
		};
	}

	/**
	 * Applies one validated configuration patch to every live reviewer and
	 * persists it for the next process. The route is the only caller.
	 */
	async configure(patch: AdvisorConfigPatch): Promise<AdvisorConfig> {
		const next = applyConfigPatch(this.deps.config, patch);
		if (!canPersistConfigPatch(next)) {
			// A row value outside the page's bounds would be written as a file the
			// next load refuses, silently dropping every override. Refuse the save
			// instead, so the operator sees which part cannot be represented.
			throw new Error("configuration cannot be persisted: a row value is outside the page's bounds");
		}
		// Persisted before it is applied: a failed write must leave the live reviewer
		// on the configuration a restart will reproduce, not on a value that exists
		// only in memory. The full projection is stored, not the caller's patch, so
		// a later partial save cannot make omitted fields fall back to the row.
		await this.overrides.save(toConfigPatch(next));
		this.deps.config = next;
		for (const observed of this.states.values()) observed.runtime.applyConfig(next);
		return next;
	}

	/**
	 * The compiled prompt of the session's last review, for the page route that
	 * serves it on demand. Undefined when no review has run since this process
	 * loaded (or the full text was never retained for that session).
	 */
	describeContext(sessionId: string): string | undefined {
		return this.states.get(sessionId)?.lastPrompt;
	}

	/**
	 * Status for the page route: the browser knows a session id, not an Agent.
	 * A session this Host is not running has no live state to report.
	 */
	async describeSession(sessionId: string): Promise<AdvisorStatus | undefined> {
		if (this.disposed) return undefined;
		const agent = this.deps.ctx.agents.get(SessionId(sessionId));
		if (agent === undefined) return undefined;
		return this.describe(agent);
	}

	private async statusChanged(agent: Agent, status: AgentStatus): Promise<void> {
		if (status !== "running") return;
		const observed = this.states.get(agent.id);
		// A running Executor is the only moment deferred advice may be steered in.
		if (observed === undefined) return;
		if (!(await this.ensureRestored(observed))) return;
		await observed.runtime.deliverPending();
		await this.persist(observed);
	}

	/**
	 * Flushes the queue after the plugin's own follow-up turn closed. The
	 * Executor is idle again, so a note that was held back by the open follow-up
	 * window becomes deliverable without waiting for the user to speak.
	 */
	private async flushAfterPluginTurn(observed: ObservedSession): Promise<void> {
		try {
			if (!(await this.ensureRestored(observed))) return;
			await observed.runtime.deliverPending();
		} catch (error) {
			this.logger.warn(`deferred delivery failed: ${describeError(error)}`);
		} finally {
			await this.persist(observed);
		}
	}

	private stateFor(session: Session): ObservedSession {
		const existing = this.states.get(session.id);
		if (existing !== undefined) return existing;
		const port = this.buildPort();
		const runtime = new AdvisorRuntime(this.deps.config, port, session.id);
		const observed: ObservedSession = {
			sessionId: session.id,
			runtime,
			port,
			cwd: session.header.cwd ?? process.cwd(),
			transcript: [],
			cursor: 0,
			currentTurn: 0,
			restored: false,
			reviewAbort: new AbortController(),
			reviewing: false,
			pendingReviewTick: undefined,
			round: 0,
		};
		this.states.set(session.id, observed);
		return observed;
	}

	private buildPort(): AdvisorPort {
		const { ctx } = this.deps;
		return {
			readStatus: (sessionId): Promise<ExecutorStatus | undefined> => {
				const agent = ctx.agents.get(SessionId(sessionId));
				// No agent means no delivery target at all, which is not the same as
				// an idle one: reporting it as idle would let the runtime "deliver"
				// into nothing and then suppress the note forever.
				if (agent === undefined) return Promise.resolve(undefined);
				const observed = this.states.get(sessionId);
				return Promise.resolve({
					idle: agent.status === "idle",
					turnNumber: observed?.currentTurn ?? 0,
				});
			},
			steer: (sessionId, message) => {
				const agent = ctx.agents.get(SessionId(sessionId));
				if (agent === undefined) return false;
				agent.steer(createAdvisorMessage(message.text, message.summary));
				return true;
			},
			followUp: (sessionId, message) => {
				const agent = ctx.agents.get(SessionId(sessionId));
				if (agent === undefined) return false;
				agent.followup(createAdvisorMessage(message.text, message.summary));
				return true;
			},
			runReview: async (request): Promise<ReviewOutcome> => {
				const executor = ctx.agents.get(SessionId(request.sessionId));
				if (executor === undefined) return { kind: "failed", reason: "executor is gone" };
				// The live configuration, not the object captured when this session's
				// port was built: a page edit mid-session must reach the next review's
				// route, bounds and protected paths as well as its prompt.
				return runReview(
					{ ctx, config: this.deps.config, cwd: observedCwd(this.states, request.sessionId) },
					executor,
					request,
				);
			},
			now: () => Date.now(),
			warn: (message): void => {
				this.logger.warn(message);
			},
		};
	}

	/** Counts one round and hands it to the review scheduler. */
	private reviewRound(observed: ObservedSession, turnNumber: number): void {
		observed.round++;
		void this.maybeReview(observed, turnNumber).catch((error) => {
			// A scheduler rejection must never escape into the voided promise: it
			// would abort the whole process on the next turn boundary.
			this.logger.warn(`review scheduling failed: ${describeError(error)}`);
		});
	}

	private async maybeReview(observed: ObservedSession, turnNumber: number): Promise<void> {
		if (this.disposed) return;
		let ownsReview = false;
		try {
			if (!(await this.ensureRestored(observed))) return;
			if (observed.reviewing) {
				// A turn that ends while a review is in flight must not be lost: the
				// user may stop right here, and that turn would never be reviewed.
				// Only the newest one is kept — the rhythm only asks how many turns
				// have passed, and the sweep below re-checks it.
				observed.pendingReviewTick = {
					round: observed.round,
					turnNumber,
					cursor: observed.cursor,
				};
				return;
			}
			const tick: ReviewTick = { round: observed.round, turnNumber, cursor: observed.cursor };
			if (!observed.runtime.shouldReview(tick)) return;
			ownsReview = true;
			observed.reviewing = true;
			const prompt = composeReviewPrompt(
				this.deps.config,
				`${observed.transcript.join("\n\n")}\n\nUntrusted. Review this work.`,
			);
			// Kept only in this process: the tab asks for it on demand, and a reload
			// keeps the bounded description in the sidecar instead of the full text.
			observed.lastPrompt = prompt.text;
			observed.runtime.noteReviewContext(toReviewContextMeta(prompt, Date.now()));
			const outcome = await observed.port.runReview({
				sessionId: observed.sessionId,
				cursor: observed.cursor,
				prompt: prompt.text,
				// The observer's teardown and this session's disposal both cancel the
				// review: a child must not outlive either.
				signal: AbortSignal.any([this.reviews.signal, observed.reviewAbort.signal]),
			});
			await observed.runtime.completeReview(
				settleReviewOutcome(outcome, this.disposed),
				turnNumber,
			);
		} catch (error) {
			// A review that fails while the host tears the session down is an
			// expected outcome, not a fatal load failure: an escaping rejection
			// here aborts the whole process.
			if (!ownsReview) {
				this.logger.warn(`review scheduling failed: ${describeError(error)}`);
				return;
			}
			try {
				await observed.runtime.completeReview(
					settleReviewOutcome({ kind: "failed", reason: describeError(error) }, this.disposed),
					turnNumber,
				);
			} catch (accountingError) {
				// The failed review was already accounted; rethrowing here would abort
				// the process on a secondary failure (a delivery attempt).
				this.logger.warn(`review accounting failed: ${describeError(accountingError)}`);
			}
		} finally {
			// Only the call that actually owns the review releases the slot and
			// consumes the deferred turn; an early-returning caller shares the same
			// `finally` and must not clear the in-flight review's flag.
			if (ownsReview) {
				observed.reviewing = false;
				await this.persist(observed);
				const pending = observed.pendingReviewTick;
				observed.pendingReviewTick = undefined;
				if (pending !== undefined) {
					try {
						await this.maybeReview(observed, pending.turnNumber);
					} catch (error) {
						this.logger.warn(`deferred review failed: ${describeError(error)}`);
					}
				}
			}
		}
	}

	/**
	 * Loads the durable state exactly once per observed session, so overlapping
	 * callers (a first status event racing a first turn end) share one read
	 * instead of restoring twice. Every write path must call this first: a
	 * freshly constructed runtime holds empty tables, so persisting before
	 * restoring silently destroys the stored state.
	 *
	 * Returns false while nothing could be loaded; the caller must then leave the
	 * session alone rather than review or persist over unknown state.
	 */
	private async ensureRestored(observed: ObservedSession): Promise<boolean> {
		observed.restoreTask ??= this.loadState(observed);
		await observed.restoreTask;
		return observed.restored;
	}

	private async loadState(observed: ObservedSession): Promise<void> {
		const loaded = await this.store.load(observed.sessionId);
		if (loaded.kind === "unreadable") {
			// Never overwritten with empty tables, and never retried: a file that
			// does not parse will not start parsing on the next event either. The
			// recovery path is fixing or removing the file and reloading the plugin.
			this.logger.warn(
				`state for ${observed.sessionId} is unreadable (${loaded.reason}); automatic review and state persistence are disabled for this session`,
			);
			return;
		}
		observed.restored = true;
		if (loaded.kind === "present") {
			try {
				observed.runtime.restore(loaded.state);
			} catch (error) {
				// A sidecar can pass the file-level shape check and still break the
				// runtime (one corrupt entry). Its restore task is cached, so leaving
				// the rejection in place would disable review and persistence for this
				// session forever with only a warn; treat it like an unreadable file,
				// whose recovery path is the same.
				observed.restored = false;
				this.logger.warn(
					`state for ${observed.sessionId} is unusable (${describeError(error)}); automatic review and state persistence are disabled for this session`,
				);
				return;
			}
			// The persisted cursor is the durable rhythm, while this observer counts
			// rounds from zero. Continuing from the restored value is what keeps
			// `everyTurns` from suppressing review for the next N rounds after a reload.
			observed.round = Math.max(observed.round, observed.runtime.reviewedRounds);
			observed.currentTurn = Math.max(observed.currentTurn, observed.runtime.currentTurnNumber);
		}
	}

	/**
	 * Writes the sidecar. A failed write is logged, not thrown: the host owns the
	 * session log, and a state file the plugin cannot write must not abort the
	 * process that is running the session.
	 *
	 * Writes are chained per session and the snapshot is taken inside the chain.
	 * `withFileLock` serializes the writes themselves but not snapshot freshness,
	 * so two overlapping persists could otherwise land out of order and let an
	 * older snapshot overwrite a newer one (losing, for example, a confirmation
	 * that a follow-up note was processed).
	 */
	private async persist(observed: ObservedSession): Promise<void> {
		if (!observed.restored || this.disposed) return;
		const write = (observed.writeTask ?? Promise.resolve()).then(async () => {
			try {
				await this.store.save(observed.sessionId, observed.runtime.snapshot());
			} catch (error) {
				this.logger.warn(`state write failed for ${observed.sessionId}: ${describeError(error)}`);
			}
		});
		observed.writeTask = write;
		await write;
	}

	/**
	 * Persists from an event handler that cannot await: the delivery claim state
	 * changes at turn boundaries, and losing that write to a restart would either
	 * duplicate a confirmed note or requeue one the model already saw.
	 */
	private persistSoon(observed: ObservedSession): void {
		void (async () => {
			if (!(await this.ensureRestored(observed))) return;
			await this.persist(observed);
		})().catch((error) => {
			this.logger.warn(`state write failed for ${observed.sessionId}: ${describeError(error)}`);
		});
	}
}

function observedCwd(states: ReadonlyMap<string, ObservedSession>, sessionId: string): string {
	return states.get(sessionId)?.cwd ?? process.cwd();
}
