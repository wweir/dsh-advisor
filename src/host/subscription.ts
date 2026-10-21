/**
 * Event wiring: observes top-level Executor sessions, decides when a review is
 * due, and owns one runtime per session.
 *
 * @module dsh-advisor/host/subscription
 */

import { randomBytes } from "node:crypto";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentStatus } from "@deepseek-ai/dsh-agent";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import { SessionId } from "@deepseek-ai/dsh-session";

import {
	planReviewBudget,
	REVIEW_PREAMBLE_FALLBACK_TOKENS,
	ReviewCapacityError,
	type ReviewBudgetDecision,
	type ReviewModelWindow,
} from "../policy/budget.ts";
import { isAdvisorActive } from "../policy/config.ts";
import {
	explainAdviceHold,
	isAdviceFollowUpCapExhausted,
	REVIEW_FOLLOW_UP_SESSION_CAP,
} from "../policy/delivery.ts";
import { toReviewContextMeta } from "../policy/stats.ts";
import type { AdvisorPort, ExecutorStatus, ReviewOutcome } from "../port.ts";
import { estimateTokens } from "../policy/redaction.ts";
import type { AdvisorConfig } from "../policy/config.ts";
import { blocksText } from "../policy/transcript.ts";
import { TranscriptBuffer } from "../policy/transcript-buffer.ts";
import { settleReviewOutcome } from "../port.ts";
import { AdvisorRuntime } from "../state.ts";
import { createAdvisorMessage } from "./delivery.ts";
import { ConfigOverridesStore } from "./config-store.ts";
import {
	applyConfigPatch,
	canPersistConfigPatch,
	describeConfig,
	toConfigPatch,
	type AdvisorConfigPatch,
} from "../policy/overrides.ts";
import { boundaryLine, composeReviewPrompt } from "../policy/prompt.ts";
import { runReview } from "./review.ts";
import { SidecarStore } from "./sidecar.ts";
import { registerAdvisorStatus, type AdvisorStatus } from "./status.ts";

/** One session this observer tracks: its runtime, its transcript and its review bookkeeping. */
interface ObservedSession {
	sessionId: string;
	runtime: AdvisorRuntime;
	/** The host seam this session's runtime was built with, for the review driver. */
	port: AdvisorPort;
	cwd: string;
	transcript: TranscriptBuffer;
	/**
	 * Seq of the last transcript entry a completed review read. Everything after
	 * it is the work since that review, which the prompt marks and asks the next
	 * reviewer to judge. A seq survives trimming and compaction shadowing, which
	 * an index would not. Only an outcome that concluded advances it: a failed or
	 * cancelled review leaves its material unreviewed. In-memory only: a reload
	 * starts a fresh transcript, so the boundary restarts with the buffer this
	 * process observed (nothing already reviewed is re-sent as a trace claim).
	 */
	reviewedThroughSeq: number;
	/** Preamble the host injected in the last review child, measured from its own log. */
	preambleTokens?: number;
	/**
	 * The Executor's own preamble pieces, read from its log until a review child
	 * has measured the real one. The review child runs the Executor's composition,
	 * so its system prompt and (larger, unrestricted) tool schema set bound the
	 * preamble the first review has to leave room for.
	 */
	executorSystemTokens: number;
	executorToolTokens: number;
	cursor: number;
	currentTurn: number;
	/** Compiled prompt of the last review, kept for the page route (never persisted). */
	lastPrompt?: string;
	restored: boolean;
	/** The in-flight sidecar load, so concurrent callers share one read. */
	restoreTask?: Promise<void>;
	/** The in-flight sidecar write chain, so snapshots reach disk in order. */
	writeTask?: Promise<void>;
	/** Aborted when this session is disposed, so its review does not outlive it. */
	reviewAbort: AbortController;
	reviewing: boolean;
}

export interface ObserverDeps {
	readonly ctx: Context;
	config: AdvisorConfig;
	readonly stateRoot: string;
	/**
	 * Resolves the reviewer route's advertised capacity, for the prompt budget.
	 * Absent on a host without an LLM registry: the configured cap then governs.
	 */
	readonly resolveModelInfo?: (provider: string, model: string) => Promise<ReviewModelWindow | undefined>;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The preamble every review request carries ahead of the prompt: measured from the
 * last review child when one ran, otherwise bounded from the Executor's own system
 * prompt and tool schemas, otherwise the deployment constant.
 */
function effectivePreambleTokens(observed: ObservedSession): number {
	// Never below the deployment constant: a log that has not carried a request
	// header yet knows only part of the preamble, and under-estimating it is what
	// lets the first review overflow into the host's compaction. A measured child
	// raises the estimate only when this host's injections grew past the constant.
	if (observed.preambleTokens !== undefined) {
		return Math.max(REVIEW_PREAMBLE_FALLBACK_TOKENS, observed.preambleTokens);
	}
	return Math.max(REVIEW_PREAMBLE_FALLBACK_TOKENS, observed.executorSystemTokens + observed.executorToolTokens);
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
	/** One capability lookup per route: the window does not change while loaded. */
	private readonly windows = new Map<string, Promise<ReviewModelWindow | undefined>>();

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
			return registerAdvisorStatus(registry, {
				describe: (agent) => this.describe(agent),
				resume: (agent) => this.resume(agent),
			});
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
		// Compaction is logged by events this package does not depend on; the buffer
		// reads them structurally and says whether it consumed the event.
		if (observed.transcript.absorb(event)) return;
		switch (event.type) {
			case "system/message": {
				// Not transcript material, but the preamble estimate the first review
				// needs: the longest non-empty rendering is the one the host sends.
				const text = blocksText(event.data.message.content);
				if (text !== undefined) {
					observed.executorSystemTokens = Math.max(observed.executorSystemTokens, estimateTokens(text));
				}
				return;
			}
			case "request/header": {
				// Headers are logged only when they change, so the largest one seen is
				// the tool surface the Executor's requests carry.
				observed.executorToolTokens = Math.max(
					observed.executorToolTokens,
					estimateTokens(JSON.stringify(event.data.header.tools ?? [])),
				);
				return;
			}
			case "turn/start":
				observed.currentTurn = event.data.turn;
				observed.runtime.noteTurnStart(event.data.turn);
				return;
			case "user/message": {
				if (event.data.source?.kind === "advisor") {
					// This plugin's own note: it must not count as user input and must not
					// enter the material a later review reads, or the review reviews itself.
					// The event is also the proof that a step admitted the note, which is
					// what clears the page's in-flight row.
					observed.runtime.confirmAdvisorInput(event.data.id);
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
				// transcript; a review that is claimed later reads it from there.
				observed.transcript.append(event);
				// A completed model reply is the proof that a delivered follow-up was
				// actually processed. A cancelled (partial) reply is not: the note may
				// have been cut off before anything acted on it. Persisted immediately,
				// because a restart right after the reply would requeue a note the model
				// already acted on.
				if (event.data.interrupted !== true && observed.runtime.noteModelOutput(event.data.turn)) {
					this.persistSoon(observed);
				}
				// A reply starts nothing: a step is the only rhythm boundary, so the
				// reply is material for a later review and nothing else.
				return;
			}
			case "step/end": {
				// A step is one model call plus the tools it ran; it is the rhythm's only
				// boundary, so it covers work inside a running turn (which crosses no
				// reply boundary for dozens of steps) and work spread across short turns
				// alike. A plugin-opened follow-up turn is not Executor work, and its
				// steps must not move the Executor's cadence.
				if (observed.runtime.isPluginTurn(event.data.turn)) return;
				observed.runtime.noteStepCompleted();
				// Written per step: the counter is what a reload resumes the cadence
				// from, and a step accrued since the last write would be forgiven.
				this.persistSoon(observed);
				this.schedule(observed, event.data.turn);
				return;
			}
			case "turn/end": {
				// A follow-up turn that closes without a model reply never processed its
				// note; the runtime puts it back in the queue and we persist that here,
				// because the note is otherwise lost to the next restart.
				if (observed.runtime.noteTurnEnd(event.data.turn)) this.persistSoon(observed);
				if (observed.runtime.closePluginTurn(event.data.turn)) {
					// A turn this plugin opened is not Executor work: it is never
					// reviewed, only recorded as no longer in flight. Closing it also
					// frees the follow-up window, so anything waiting behind it is
					// flushed now instead of at the user's next message.
					void this.flushAfterPluginTurn(observed);
					return;
				}
				// A turn boundary itself starts no review: the cadence counts steps,
				// and the step that closed the turn already had its chance.
				return;
			}
			default:
				break;
		}
		observed.transcript.append(event);
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
		const inFlight = observed.runtime.inFlightNotes();
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
			// The cooldown deadline, so the page can count down to the automatic
			// retry instead of reporting the pause as an indefinite hold.
			...(observed.runtime.pauseDeadline === undefined
				? {}
				: { pausedUntil: observed.runtime.pauseDeadline }),
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
			// Notes already in the running Executor's inbox and not yet admitted: the
			// page shows this window, which neither the queue nor the delivered
			// history covers. Always present, so the shape says "no notes in flight"
			// rather than "this host is too old to know the field".
			inFlight: {
				count: inFlight.length,
				notes: inFlight.map((entry) => ({
					severity: entry.severity,
					note: entry.note,
					turn: entry.turn,
					at: entry.at,
				})),
			},
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
		if (next.enabled && next.model !== undefined) {
			// The window is part of the configuration's validity: a cap that cannot
			// fit its own preamble would overflow into a host compaction on every
			// review, so the save is refused with the numbers that produced it.
			const window = await this.windowFor(next.model.provider, next.model.model);
			// The largest preamble this process has seen, so the check reflects the
			// deployment's own injections rather than only the constant.
			const preambleTokens = Math.max(
				...[...this.states.values()].map((state) => effectivePreambleTokens(state)),
				REVIEW_PREAMBLE_FALLBACK_TOKENS,
			);
			const decision = planReviewBudget({
				configuredCap: next.review.maxContextTokens,
				preambleTokens,
				...(window === undefined ? {} : { window }),
			});
			if (decision.kind === "refused") throw new ReviewCapacityError(decision.reason);
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

	/**
	 * Clears one session's failure pause on the operator's explicit request. The
	 * pause expires on its own after its cooldown, so this is the "retry now"
	 * path: the operator has usually just fixed the route and does not want to
	 * wait out the hold. It changes nothing else about the configuration.
	 *
	 * The state is persisted so the page and a later `/advisor status` agree even
	 * when the runtime is reloaded before the next poll.
	 */
	private async resume(agent: Agent): Promise<boolean> {
		if (this.disposed) return false;
		// Only a session this observer already tracks can hold a pause (the hold is
		// in-memory and dies with the runtime). Registering the session here would
		// answer "nothing to resume", so it must not create one as a side effect.
		const observed = this.states.get(agent.id);
		if (observed === undefined) return false;
		if (!(await this.ensureRestored(observed))) return false;
		observed.runtime.resume();
		await this.persist(observed);
		this.logger.info(`automatic review resumed by request for ${observed.sessionId}`);
		return true;
	}

	/**
	 * Resumes one session's failure pause from the page's route, by session id.
	 * False when this Host is not running that session any more.
	 */
	async resumeSession(sessionId: string): Promise<boolean> {
		if (this.disposed) return false;
		const agent = this.deps.ctx.agents.get(SessionId(sessionId));
		if (agent === undefined) return false;
		return this.resume(agent);
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
			transcript: new TranscriptBuffer(),
			reviewedThroughSeq: 0,
			executorSystemTokens: 0,
			executorToolTokens: 0,
			cursor: 0,
			currentTurn: 0,
			restored: false,
			reviewAbort: new AbortController(),
			reviewing: false,
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
				if (agent === undefined) return undefined;
				const delivered = createAdvisorMessage(message.text, message.summary);
				agent.steer(delivered);
				// The identity is the only handle on a hand-off: the host returns no
				// other receipt, and the admission event carries this same id.
				return delivered.id;
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

	/** Hands one step boundary to the scheduler; a rejection must never abort the host. */
	private schedule(observed: ObservedSession, turnNumber: number): void {
		void this.maybeReview(observed, turnNumber).catch((error) => {
			// A scheduler rejection must never escape into the voided promise: it
			// would abort the whole process on the next boundary.
			this.logger.warn(`review scheduling failed: ${describeError(error)}`);
		});
	}

	private async maybeReview(observed: ObservedSession, turnNumber: number): Promise<void> {
		if (this.disposed) return;
		let ownsReview = false;
		try {
			if (!(await this.ensureRestored(observed))) return;
			// A step that arrives while a review is in flight needs no catch-up: the
			// cursor moves to the steps seen when the review finishes, so the next
			// boundary is measured from there and nothing is lost.
			if (observed.reviewing) return;
			if (!observed.runtime.shouldReview(turnNumber)) return;
			ownsReview = true;
			observed.reviewing = true;
			// The budget is resolved first because it may await the LLM registry. The
			// boundary, the last seq and the slice are then taken in one synchronous
			// block: the Executor keeps appending, trimming and compacting while the
			// observation runs, and an index captured before an await would be applied
			// to a buffer that no longer has it.
			const budget = await this.reviewBudget(observed);
			if (budget.kind === "refused") {
				// A route whose window cannot hold even a minimal review is refused
				// with the numbers, and counted as a failure: attempting it would
				// overflow into a host compaction, and the reviewer would judge a
				// summary of the work instead of the work.
				await this.settleReview(
					observed,
					settleReviewOutcome({ kind: "failed", reason: budget.reason }, this.disposed),
					turnNumber,
				);
				return;
			}
			const boundary = observed.transcript.boundaryIndex(observed.reviewedThroughSeq);
			const lastSeqAtCompose = observed.transcript.lastSeq();
			// Minted here, after the content it separates was already written: a
			// fixed phrase in the evidence could otherwise pose as the boundary.
			const marker = boundary > 0 ? boundaryLine(randomBytes(6).toString("hex")) : undefined;
			const reviews = observed.runtime.snapshot().recentReviews ?? [];
			const prompt = composeReviewPrompt(
				this.deps.config,
				{
					older: observed.transcript.entries.slice(0, boundary),
					recent: observed.transcript.entries.slice(boundary),
					...(marker === undefined ? {} : { marker }),
					...(reviews.length === 0 ? {} : { reviews }),
				},
				budget.budget.evidenceTokens,
			);
			if (prompt.budgetShortfall) {
				// The fixed text and the reserved omission markers leave no room for any
				// evidence, so the composed prompt is a bare marker. Sending it would spend a
				// child call on no evidence; the numbers are what the operator has to change.
				await this.settleReview(
					observed,
					settleReviewOutcome(
						{
							kind: "failed",
							reason:
								`review prompt budget of ${String(prompt.budgetTokens)} tokens leaves no room for evidence after the fixed text ` +
								`(${String(prompt.overheadTokens)} tokens) and the omission markers this prompt reserves. ` +
								"Raise review.maxContextTokens or shorten review.instructions.",
						},
						this.disposed,
					),
					turnNumber,
				);
				return;
			}
			if (prompt.recentTokens === 0 && prompt.olderTokens === 0 && prompt.materialTokens > 0) {
				// The budget carried no zone at all, even though material exists (the
				// composer already dropped the conclusions when they were the blocker).
				// Running this review would spend a child call on material it never
				// sees; report the numbers the operator has to change instead.
				await this.settleReview(
					observed,
					settleReviewOutcome(
						{
							kind: "failed",
							reason:
								`review prompt budget of ${String(prompt.budgetTokens)} tokens carries no evidence: fixed text and earlier conclusions take ` +
								`${String(prompt.overheadTokens)} tokens, and the material itself is ${String(prompt.materialTokens)} tokens. ` +
								"Raise review.maxContextTokens or shorten review.instructions.",
						},
						this.disposed,
					),
					turnNumber,
				);
				return;
			}
			// Kept only in this process: the tab asks for it on demand, and a reload
			// keeps the bounded description in the sidecar instead of the full text.
			observed.lastPrompt = prompt.text;
			observed.runtime.noteReviewContext(
				toReviewContextMeta(prompt, Date.now(), undefined, budget.budget),
			);
			const outcome = await observed.port.runReview({
				sessionId: observed.sessionId,
				cursor: observed.cursor,
				prompt: prompt.text,
				// The observer's teardown and this session's disposal both cancel the
				// review: a child must not outlive either.
				signal: AbortSignal.any([this.reviews.signal, observed.reviewAbort.signal]),
			});
			// The child measured the preamble it was sent; the next review's budget
			// is derived from that measurement rather than from a constant.
			if (outcome.usage?.preambleTokens !== undefined) {
				observed.preambleTokens = outcome.usage.preambleTokens;
			}
			const settled = settleReviewOutcome(outcome, this.disposed);
			if ((settled.kind === "silent" || settled.kind === "finding") && prompt.recentComplete) {
				// The reviewer read (and concluded on) the material it was sent, so
				// the next review marks its own start after it. Failures and owner
				// cancellations are deliberately excluded: those lines were never
				// reviewed, and must still be new to the next reviewer.
				//
				// A truncated new-work zone is excluded too: `boundEntries` keeps the
				// tail, so the oldest entries since the last review were never shown.
				// Advancing over them would demote them to the body-less trace of a
				// review that never read them; staying put keeps them new, and the next
				// cadence re-sends them in full.
				observed.reviewedThroughSeq = Math.max(observed.reviewedThroughSeq, lastSeqAtCompose);
			}
			await this.settleReview(observed, settled, turnNumber);
		} catch (error) {
			// A review that fails while the host tears the session down is an
			// expected outcome, not a fatal load failure: an escaping rejection
			// here aborts the whole process.
			if (!ownsReview) {
				this.logger.warn(`review scheduling failed: ${describeError(error)}`);
				return;
			}
			try {
				await this.settleReview(
					observed,
					settleReviewOutcome({ kind: "failed", reason: describeError(error) }, this.disposed),
					turnNumber,
				);
			} catch (accountingError) {
				// The failed review was already accounted; rethrowing here would abort
				// the process on a secondary failure (a delivery attempt).
				this.logger.warn(`review accounting failed: ${describeError(accountingError)}`);
			}
		} finally {
			// Only the call that actually owns the review releases the slot; an
			// early-returning caller shares the same `finally` and must not clear the
			// in-flight review's flag.
			if (ownsReview) {
				observed.reviewing = false;
				await this.persist(observed);
			}
		}
	}

	/**
	 * Derives this review's prompt budget from the reviewer route and the
	 * preamble the last child was sent.
	 */
	private async reviewBudget(observed: ObservedSession): Promise<ReviewBudgetDecision> {
		const model = this.deps.config.model;
		const window = model === undefined ? undefined : await this.windowFor(model.provider, model.model);
		return planReviewBudget({
			configuredCap: this.deps.config.review.maxContextTokens,
			preambleTokens: effectivePreambleTokens(observed),
			...(window === undefined ? {} : { window }),
		});
	}

	/**
	 * The reviewer route's advertised capacity, looked up once per route. A
	 * lookup failure leaves the configured cap in force instead of disabling
	 * review: an adapter that cannot answer says nothing about the window.
	 */
	private windowFor(provider: string, model: string): Promise<ReviewModelWindow | undefined> {
		const resolver = this.deps.resolveModelInfo;
		if (resolver === undefined) return Promise.resolve(undefined);
		const key = `${provider}:${model}`;
		const cached = this.windows.get(key);
		if (cached !== undefined) return cached;
		const task = (async (): Promise<ReviewModelWindow | undefined> => {
			try {
				const info = await resolver(provider, model);
				if (info === undefined) return undefined;
				const window: ReviewModelWindow = {
					...(info.contextWindow === undefined ? {} : { contextWindow: info.contextWindow }),
					...(info.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: info.defaultMaxTokens }),
				};
				return window.contextWindow === undefined && window.defaultMaxTokens === undefined
					? undefined
					: window;
			} catch (error) {
				// Not cached: an adapter that failed once may answer next time, and a
				// permanently unknown window simply keeps the configured cap in force.
				this.windows.delete(key);
				this.logger.warn(`reviewer window unavailable for ${key}: ${describeError(error)}`);
				return undefined;
			}
		})();
		this.windows.set(key, task);
		return task;
	}

	/**
	 * Accounts one settled review and logs the moment the failure pause trips.
	 *
	 * The log is the only operator-facing signal outside this plugin's own page:
	 * without it a session whose route broke simply stops producing notes, and the
	 * reason lives in a sidecar file. The trip is a transition (unpaused to
	 * paused), so a review that fails while already paused — a probe that lost,
	 * which re-arms the next cooldown — is logged again, once per hold.
	 */
	private async settleReview(
		observed: ObservedSession,
		outcome: ReviewOutcome,
		turnNumber: number,
	): Promise<void> {
		const wasPaused = observed.runtime.isPaused;
		await observed.runtime.completeReview(outcome, turnNumber);
		if (wasPaused || !observed.runtime.isPaused) return;
		const state = observed.runtime.snapshot();
		const deadline = observed.runtime.pauseDeadline;
		const retry = deadline === undefined ? "unknown" : `${String(Math.max(0, Math.round((deadline - Date.now()) / 1000)))}s`;
		this.logger.warn(
			`automatic review paused for ${observed.sessionId} after ${String(state.failureStreak)} consecutive failures (${
				state.lastFailure?.reason ?? "unknown reason"
			}); retrying in ${retry}`,
		);
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
			// The step counter and its cursor are part of the restored runtime, so a
			// reload continues the cadence; only the display turn is observer-owned.
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
		// A review waiting on the budget lookup can resume after its session was
		// disposed; writing then would recreate a sidecar for a session this observer
		// no longer tracks, which is what disposal promises not to do.
		if (this.states.get(observed.sessionId) !== observed) return;
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
