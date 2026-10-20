import { describe, expect, it } from "vitest";

import {
	type AdviceSeverity,
	acceptReviewAdvice,
} from "../src/policy/advice.ts";
import { DEFAULT_ADVISOR_CONFIG, type ActiveIdleSeverity, type AdvisorConfig } from "../src/policy/config.ts";
import type { AdvisorPort, DeliveredAdvice, ExecutorStatus } from "../src/port.ts";
import { AdvisorRuntime } from "../src/state.ts";

/**
 * Delivery rules that only appear once the runtime is driven through a port that
 * can refuse: a note that cannot be handed over must stay queued, and nothing
 * may be recorded as delivered until it was.
 */

const NOTE = "The rollback path drops pending state on failure.";
const REWORDED = "The rollback path loses pending state, so a resume after a failed migration is unsafe.";

function config(activeIdleSeverities: readonly ActiveIdleSeverity[]): AdvisorConfig {
	return {
		...DEFAULT_ADVISOR_CONFIG,
		enabled: true,
		model: { provider: "test", model: "test" },
		delivery: { activeIdleSeverities },
	};
}

function createHarness(activeIdleSeverities: readonly ActiveIdleSeverity[] = ["blocker"]) {
	const steered: DeliveredAdvice[] = [];
	const followedUp: DeliveredAdvice[] = [];
	const control = {
		status: { idle: false, turnNumber: 1 } as ExecutorStatus | undefined,
		accepts: true,
		/** Runs inside `followUp`, i.e. before it returns to the delivery loop. */
		onFollowUp: undefined as (() => void) | undefined,
		/** When set, `readStatus` waits on it; used to suspend a delivery sweep. */
		statusGate: undefined as Promise<void> | undefined,
	};
	const port: AdvisorPort = {
		readStatus: async () => {
			await control.statusGate;
			return control.status;
		},
		steer: (_sessionId, message) => {
			if (!control.accepts) return undefined;
			steered.push(message);
			return `message-${steered.length}`;
		},
		followUp: (_sessionId, message) => {
			if (!control.accepts) return false;
			followedUp.push(message);
			control.onFollowUp?.();
			return true;
		},
		runReview: () => Promise.resolve({ kind: "silent" }),
		now: () => 1,
	};
	return {
		runtime: new AdvisorRuntime(config(activeIdleSeverities), port, "session-1"),
		port,
		steered,
		followedUp,
		control,
	};
}

function advice(note = NOTE, severity: AdviceSeverity = "concern", findingKey = "finding-a") {
	return acceptReviewAdvice({ note, severity, findingKey }, { maxAdviceChars: 2_000, now: 1 });
}

describe("delivery through the runtime", () => {
	it("leaves a note queued while the executor cannot receive it", async () => {
		const harness = createHarness();
		// No agent at all: not the same as an idle one, because an idle agent can be
		// woken while a missing one cannot receive anything.
		harness.control.status = undefined;
		await harness.runtime.completeReview({ kind: "finding", advice: advice() }, 1);
		expect(harness.steered).toEqual([]);
		expect(harness.runtime.pendingCount).toBe(1);
		// Not recorded as delivered: recording it would suppress it for good.
		expect(harness.runtime.snapshot().dedupe).toEqual([]);

		harness.control.status = { idle: false, turnNumber: 2 };
		await harness.runtime.deliverPending();
		expect(harness.steered).toHaveLength(1);
		expect(harness.runtime.pendingCount).toBe(0);
		expect(harness.runtime.snapshot().dedupe).toHaveLength(1);
	});

	it("keeps a refused delivery queued instead of losing the finding", async () => {
		const harness = createHarness();
		harness.control.accepts = false;
		await harness.runtime.completeReview({ kind: "finding", advice: advice() }, 1);
		expect(harness.steered).toEqual([]);
		expect(harness.runtime.pendingCount).toBe(1);
		expect(harness.runtime.snapshot().dedupe).toEqual([]);

		harness.control.accepts = true;
		await harness.runtime.deliverPending();
		expect(harness.steered).toHaveLength(1);
		expect(harness.runtime.pendingCount).toBe(0);
	});

	it("counts a follow-up only once it is actually opened", async () => {
		const harness = createHarness();
		harness.control.status = { idle: true, turnNumber: 1 };
		harness.control.accepts = false;
		await harness.runtime.completeReview(
			{ kind: "finding", advice: advice(NOTE, "blocker") },
			1,
		);
		expect(harness.followedUp).toEqual([]);
		expect(harness.runtime.snapshot().followUpsUsed).toBe(0);

		harness.control.accepts = true;
		await harness.runtime.deliverPending();
		expect(harness.followedUp).toHaveLength(1);
		expect(harness.runtime.snapshot().followUpsUsed).toBe(1);
	});

	it("drops a note that was muted while it waited", async () => {
		const harness = createHarness();
		harness.control.status = { idle: true, turnNumber: 1 };
		const queued = advice();
		await harness.runtime.completeReview({ kind: "finding", advice: queued }, 1);
		expect(harness.runtime.pendingCount).toBe(1);

		// Mutes arrive through the sidecar, and the snapshot carries the queue.
		harness.runtime.restore({
			...harness.runtime.snapshot(),
			mutes: [{ hash: queued.findingKeyHash, label: "muted finding" }],
		});
		harness.control.status = { idle: false, turnNumber: 2 };
		await harness.runtime.deliverPending();
		expect(harness.steered).toEqual([]);
		expect(harness.runtime.pendingCount).toBe(0);
	});

	it("keeps the newest observation of a still-queued finding", async () => {
		// Nothing wakes an idle executor here, so both observations stay queued.
		const harness = createHarness([]);
		harness.control.status = { idle: true, turnNumber: 1 };
		await harness.runtime.completeReview(
			{ kind: "finding", advice: advice(NOTE, "nit", "same-key") },
			1,
		);
		await harness.runtime.completeReview(
			{ kind: "finding", advice: advice(REWORDED, "blocker", "same-key") },
			2,
		);
		expect(harness.runtime.pendingCount).toBe(1);

		harness.control.status = { idle: false, turnNumber: 3 };
		await harness.runtime.deliverPending();
		expect(harness.steered).toHaveLength(1);
		expect(harness.steered[0]?.text).toContain('severity="blocker"');
		expect(harness.steered[0]?.text).toContain(REWORDED);
		// The collapsed chat row only shows this line, so staleness has to be in it.
		expect(harness.steered[0]?.summary).toContain("阻断");
		expect(harness.steered[0]?.summary).toContain("可能已过期");
		expect(harness.steered[0]?.summary).toContain("loses pending state");
	});
});

describe("queue sweeping", () => {
	it("does not let a deferred low-severity note block a later blocker", async () => {
		const harness = createHarness(["blocker"]);
		harness.control.status = { idle: true, turnNumber: 1 };
		// The `nit` is queued first and is not allowed to wake an idle executor.
		await harness.runtime.completeReview({ kind: "finding", advice: advice(NOTE, "nit", "nit-key") }, 1);
		expect(harness.followedUp).toEqual([]);
		expect(harness.runtime.pendingCount).toBe(1);

		// The blocker behind it must still reach the executor in the same sweep.
		await harness.runtime.completeReview(
			{ kind: "finding", advice: advice(REWORDED, "blocker", "blocker-key") },
			2,
		);
		expect(harness.followedUp).toHaveLength(1);
		expect(harness.followedUp[0]?.text).toContain('severity="blocker"');
		expect(harness.followedUp[0]?.text).toContain(REWORDED);
		expect(harness.followedUp[0]?.summary).toContain("阻断");
		expect(harness.followedUp[0]?.summary).toContain("仍适用");
		// The deferred note is still queued, not dropped.
		expect(harness.runtime.pendingCount).toBe(1);
	});

	it("does not hand the same note over twice when a sweep overlaps another", async () => {
		const harness = createHarness();
		harness.control.status = { idle: false, turnNumber: 2 };
		let release: (() => void) | undefined;
		harness.control.statusGate = new Promise<void>((resolve) => {
			release = resolve;
		});

		// The review's own delivery sweep suspends inside `readStatus`.
		const reviewing = harness.runtime.completeReview({ kind: "finding", advice: advice() }, 1);
		// A status change flushes concurrently; it must join the running sweep
		// rather than peek the same entry and steer it a second time.
		const concurrent = harness.runtime.deliverPending();
		release?.();
		await Promise.all([reviewing, concurrent]);

		expect(harness.steered).toHaveLength(1);
		expect(harness.runtime.pendingCount).toBe(0);
		expect(harness.runtime.snapshot().dedupe).toHaveLength(1);
	});

	it("flushes a queued note even when the review itself stays silent", async () => {
		const harness = createHarness(["concern"]);
		// Nothing to deliver to yet, so the note stays queued.
		harness.control.status = undefined;
		await harness.runtime.completeReview({ kind: "finding", advice: advice(NOTE, "concern") }, 1);
		expect(harness.runtime.pendingCount).toBe(1);

		// The Executor is idle again, and the next review finds nothing. The queued
		// note must still be flushed instead of waiting for the user to speak.
		harness.control.status = { idle: true, turnNumber: 2 };
		await harness.runtime.completeReview({ kind: "silent" }, 2);
		expect(harness.followedUp).toHaveLength(1);
		expect(harness.runtime.pendingCount).toBe(0);
	});
});

describe("plugin turn detection", () => {
	it("claims the turn a follow-up opened, exactly once", async () => {
		const harness = createHarness();
		harness.control.status = { idle: true, turnNumber: 1 };
		await harness.runtime.completeReview(
			{ kind: "finding", advice: advice(NOTE, "blocker") },
			1,
		);
		expect(harness.followedUp).toHaveLength(1);

		// The follow-up opens turn 2, and the note's message lands inside it.
		harness.runtime.noteTurnStart(2);
		harness.runtime.noteAdvisorInput(2);
		expect(harness.runtime.closePluginTurn(2)).toBe(true);
		// Consumed: the next turn is Executor work again.
		expect(harness.runtime.closePluginTurn(2)).toBe(false);
	});

	it("claims the follow-up turn even when its message was never recorded", async () => {
		const harness = createHarness();
		harness.control.status = { idle: true, turnNumber: 1 };
		await harness.runtime.completeReview(
			{ kind: "finding", advice: advice(NOTE, "blocker") },
			1,
		);

		// A turn that dies before history assembly records only an inbox splice, so
		// no advisor message event exists; the turn boundary still identifies it.
		harness.runtime.noteTurnStart(2);
		expect(harness.runtime.closePluginTurn(2)).toBe(true);
	});

	it("does not claim a turn the user opened, even when a note was steered into it", async () => {
		const harness = createHarness();
		harness.control.status = { idle: false, turnNumber: 3 };
		await harness.runtime.completeReview(
			{ kind: "finding", advice: advice(NOTE, "blocker") },
			3,
		);
		expect(harness.steered).toHaveLength(1);

		// A steered note rides inside the user's turn, which stays reviewable.
		harness.runtime.noteTurnStart(3);
		harness.runtime.noteAdvisorInput(3);
		expect(harness.runtime.closePluginTurn(3)).toBe(false);
	});

	it("closes the follow-up window with the turn it opened", async () => {
		const harness = createHarness();
		harness.control.status = { idle: true, turnNumber: 1 };
		await harness.runtime.completeReview(
			{ kind: "finding", advice: advice(NOTE, "blocker") },
			1,
		);
		harness.runtime.noteTurnStart(2);
		expect(harness.runtime.closePluginTurn(2)).toBe(true);

		// A second blocker note may now open a fresh follow-up turn.
		harness.control.status = { idle: true, turnNumber: 2 };
		await harness.runtime.completeReview(
			{ kind: "finding", advice: advice(NOTE, "blocker", "second-key") },
			2,
		);
		expect(harness.followedUp).toHaveLength(2);
	});

	it("marks the follow-up window before the call that opens the turn", async () => {
		const harness = createHarness();
		harness.control.status = { idle: true, turnNumber: 1 };
		// The follow-up turn is announced as soon as `followup()` runs, so the
		// claim has to exist by then; marking it after the call returned would let
		// the plugin's own turn be reviewed.
		harness.control.onFollowUp = () => harness.runtime.noteTurnStart(2);
		await harness.runtime.completeReview(
			{ kind: "finding", advice: advice(NOTE, "blocker") },
			1,
		);
		expect(harness.followedUp).toHaveLength(1);
		expect(harness.runtime.closePluginTurn(2)).toBe(true);
	});

	it("withdraws the claim when a real user instruction lands in that turn", async () => {
		const harness = createHarness();
		harness.control.status = { idle: true, turnNumber: 1 };
		await harness.runtime.completeReview(
			{ kind: "finding", advice: advice(NOTE, "blocker") },
			1,
		);
		harness.runtime.noteTurnStart(2);
		// The user's own instruction arrived inside turn 2: it is real work after
		// all, so the turn stays reviewable.
		harness.runtime.noteInstructionInput(2);
		expect(harness.runtime.closePluginTurn(2)).toBe(false);
	});
});

describe("restoring the review rhythm", () => {
	it("records the claim's turn and continues the step counter across a reload", () => {
		const harness = createHarness();
		const runtime = new AdvisorRuntime(config(["blocker"]), harness.port, "session-1");
		const cadence = DEFAULT_ADVISOR_CONFIG.review.everySteps;
		runtime.restore({
			...harness.runtime.snapshot(),
			lastReviewedTurn: 9,
			stepsTotal: 20,
			// Two steps short of the cadence, so the two counted below complete it.
			lastReviewedStep: 20 - cadence + 2,
		});
		runtime.noteStepCompleted();
		expect(runtime.shouldReview(9)).toBe(false);
		runtime.noteStepCompleted();
		expect(runtime.shouldReview(10)).toBe(true);
		// The claim records the display turn; the step cursor moves on completion.
		expect(runtime.snapshot().lastReviewedTurn).toBe(10);
	});
});

describe("follow-up confirmation", () => {
	it("does not record a follow-up note as delivered before the model replies", async () => {
		const harness = createHarness();
		harness.control.status = { idle: true, turnNumber: 1 };
		await harness.runtime.completeReview(
			{ kind: "finding", advice: advice(NOTE, "blocker") },
			1,
		);
		expect(harness.followedUp).toHaveLength(1);
		// Handed over, so it left the queue — but it is neither delivered nor
		// deduped yet: only a model reply proves the turn processed it.
		expect(harness.runtime.pendingCount).toBe(0);
		expect(harness.runtime.snapshot().dedupe).toEqual([]);
		expect(harness.runtime.snapshot().recentNotes).toEqual([]);
		expect(harness.runtime.awaitingAdvice()?.severity).toBe("blocker");
		expect(harness.runtime.snapshot().pendingFollowUp).toBeDefined();

		harness.runtime.noteTurnStart(2);
		expect(harness.runtime.noteModelOutput(2)).toBe(true);
		expect(harness.runtime.snapshot().dedupe).toHaveLength(1);
		expect(harness.runtime.snapshot().recentNotes).toHaveLength(1);
		expect(harness.runtime.awaitingAdvice()).toBeUndefined();
		expect(harness.runtime.snapshot().pendingFollowUp).toBeUndefined();
	});

	it("does not let an unrelated turn's reply confirm a claim that never reached a turn", async () => {
		const harness = createHarness();
		harness.control.status = { idle: true, turnNumber: 1 };
		await harness.runtime.completeReview(
			{ kind: "finding", advice: advice(NOTE, "blocker") },
			1,
		);
		// The host accepted the follow-up but no turn ever opened for it, so the
		// claim never bound to a turn. A later turn's reply is not proof, and
		// confirming it here is how a note used to disappear for good.
		expect(harness.runtime.noteModelOutput(4)).toBe(false);
		expect(harness.runtime.snapshot().dedupe).toEqual([]);
		expect(harness.runtime.snapshot().recentNotes).toEqual([]);
		expect(harness.runtime.awaitingAdvice()?.turn).toBe(1);
		expect(harness.runtime.snapshot().pendingFollowUp).toBeDefined();

		// Only the claim's own turn confirms it.
		harness.runtime.noteTurnStart(2);
		expect(harness.runtime.noteModelOutput(2)).toBe(true);
		expect(harness.runtime.snapshot().dedupe).toHaveLength(1);
	});

	it("requeues a follow-up note whose turn closed without a model reply", async () => {
		const harness = createHarness();
		harness.control.status = { idle: true, turnNumber: 1 };
		await harness.runtime.completeReview(
			{ kind: "finding", advice: advice(NOTE, "blocker") },
			1,
		);
		harness.runtime.noteTurnStart(2);
		expect(harness.runtime.noteTurnEnd(2)).toBe(true);
		expect(harness.runtime.pendingCount).toBe(1);
		expect(harness.runtime.snapshot().pending[0]?.followUpAttempted).toBe(true);
		// The attempt stays counted: a retry must not wake the Executor again, which
		// is how a swallowed note would become a loop of empty follow-up turns.
		expect(harness.runtime.snapshot().followUpsUsed).toBe(1);
		expect(harness.followedUp).toHaveLength(1);
		expect(harness.runtime.pendingCount).toBe(1);

		// A running Executor can still receive it, at a step boundary.
		harness.control.status = { idle: false, turnNumber: 3 };
		await harness.runtime.deliverPending();
		expect(harness.steered).toHaveLength(1);
		expect(harness.runtime.pendingCount).toBe(0);
		expect(harness.runtime.snapshot().dedupe).toHaveLength(1);
	});

	it("requeues an unconfirmed follow-up when the state is restored after a restart", async () => {
		const harness = createHarness();
		harness.control.status = { idle: true, turnNumber: 1 };
		await harness.runtime.completeReview(
			{ kind: "finding", advice: advice(NOTE, "blocker") },
			1,
		);
		const persisted = harness.runtime.snapshot();
		expect(persisted.pendingFollowUp).toBeDefined();

		const restarted = new AdvisorRuntime(config(["blocker"]), harness.port, "session-1");
		restarted.restore(persisted);
		// The process ended before a reply proved the note was processed, so the
		// restart must not count it as delivered (or as never delivered).
		expect(restarted.pendingCount).toBe(1);
		expect(restarted.snapshot().pending[0]?.followUpAttempted).toBe(true);
		expect(restarted.snapshot().dedupe).toEqual([]);
		expect(restarted.snapshot().recentNotes).toEqual([]);
		expect(restarted.awaitingAdvice()).toBeUndefined();
	});

	it("does not requeue a note that was confirmed before the turn closed", async () => {
		const harness = createHarness();
		harness.control.status = { idle: true, turnNumber: 1 };
		await harness.runtime.completeReview(
			{ kind: "finding", advice: advice(NOTE, "blocker") },
			1,
		);
		harness.runtime.noteTurnStart(2);
		expect(harness.runtime.noteModelOutput(2)).toBe(true);
		expect(harness.runtime.noteTurnEnd(2)).toBe(false);
		expect(harness.runtime.pendingCount).toBe(0);
	});
});

describe("in-flight notes", () => {
	it("reports the delivered note, content included, until a step admits it", async () => {
		const harness = createHarness();
		await harness.runtime.completeReview({ kind: "finding", advice: advice() }, 1);
		expect(harness.runtime.inFlightNotes()).toEqual([
			{ messageId: "message-1", severity: "concern", note: NOTE, turn: 1, at: 1 },
		]);
		// The admission event carries the identity the host accepted, and that is
		// the only proof the note reached the model's context.
		harness.runtime.confirmAdvisorInput("message-1");
		expect(harness.runtime.inFlightNotes()).toEqual([]);
		// An id this process never handed over (a note the durable inbox delivered
		// after a reload) is ignored, not an error.
		harness.runtime.confirmAdvisorInput("message-1");
		expect(harness.runtime.inFlightNotes()).toEqual([]);
	});

	it("keeps one row per hand-off and drops them independently", async () => {
		const harness = createHarness();
		await harness.runtime.completeReview({ kind: "finding", advice: advice(NOTE, "concern", "f-1") }, 1);
		await harness.runtime.completeReview(
			{ kind: "finding", advice: advice("The second note.", "nit", "f-2") },
			2,
		);
		expect(harness.runtime.inFlightNotes().map((row) => row.messageId)).toEqual([
			"message-1",
			"message-2",
		]);
		harness.runtime.confirmAdvisorInput("message-2");
		expect(harness.runtime.inFlightNotes().map((row) => row.messageId)).toEqual(["message-1"]);
	});

	it("reports nothing when the host refuses the hand-off", async () => {
		const harness = createHarness();
		harness.control.accepts = false;
		await harness.runtime.completeReview({ kind: "finding", advice: advice() }, 1);
		expect(harness.runtime.inFlightNotes()).toEqual([]);
		// Still queued, and not recorded as delivered.
		expect(harness.runtime.pendingCount).toBe(1);
		expect(harness.runtime.snapshot().dedupe).toEqual([]);
	});
});
