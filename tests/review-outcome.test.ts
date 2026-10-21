import { describe, expect, it } from "vitest";

import { DEFAULT_ADVISOR_CONFIG, type AdvisorConfig } from "../src/policy/config.ts";
import type { AdvisorPort, ExecutorStatus, ReviewOutcome } from "../src/port.ts";
import { settleReviewOutcome } from "../src/port.ts";
import { AdvisorRuntime, FAILURE_PAUSE_COUNT } from "../src/state.ts";

const CONFIG: AdvisorConfig = {
	...DEFAULT_ADVISOR_CONFIG,
	enabled: true,
	model: { provider: "p", model: "m" },
};

function createPort(): AdvisorPort {
	return {
		readStatus: (): Promise<ExecutorStatus> => Promise.resolve({ idle: true, turnNumber: 1 }),
		steer: () => "message-1",
		followUp: () => true,
		runReview: () => Promise.resolve({ kind: "silent" }),
		now: () => 1_000,
	};
}

function runtime(): AdvisorRuntime {
	return new AdvisorRuntime(CONFIG, createPort(), "session-1");
}

const cancelled: ReviewOutcome = { kind: "cancelled", reason: "cancelled by owner" };
const failed: ReviewOutcome = { kind: "failed", reason: "model exploded" };

describe("review outcome accounting", () => {
	it("does not treat an owner cancellation as a review failure", async () => {
		const target = runtime();
		for (let index = 0; index < FAILURE_PAUSE_COUNT + 2; index++) {
			await target.completeReview(cancelled, 1);
		}
		// Teardown and reload cancel reviews structurally; counting them would
		// pause automatic review for a reason unrelated to reviewing.
		expect(target.isPaused).toBe(false);
		expect(target.snapshot().failureStreak).toBe(0);
	});

	it("still records why a cancelled review produced nothing", async () => {
		const target = runtime();
		await target.completeReview(cancelled, 1);
		expect(target.snapshot().lastFailure).toEqual({ reason: "cancelled by owner", at: 1_000 });
	});

	it("pauses after consecutive real failures", async () => {
		const target = runtime();
		for (let index = 0; index < FAILURE_PAUSE_COUNT; index++) {
			await target.completeReview(failed, 1);
		}
		expect(target.snapshot().failureStreak).toBe(FAILURE_PAUSE_COUNT);
		expect(target.isPaused).toBe(true);
	});

	it("leaves an accumulated failure streak alone when a review is cancelled", async () => {
		const target = runtime();
		await target.completeReview(failed, 1);
		await target.completeReview(cancelled, 1);
		// Neutral means neutral: a cancellation neither advances nor forgives.
		expect(target.snapshot().failureStreak).toBe(1);
		expect(target.isPaused).toBe(false);
	});

	it("clears the failure state when a review finally succeeds", async () => {
		const target = runtime();
		await target.completeReview(failed, 1);
		await target.completeReview(cancelled, 1);
		await target.completeReview({ kind: "silent" }, 1);
		const state = target.snapshot();
		expect(state.failureStreak).toBe(0);
		expect(state.lastFailure).toBeUndefined();
	});

	it("clears the failure pause on reload", async () => {
		const target = runtime();
		for (let index = 0; index < FAILURE_PAUSE_COUNT; index++) {
			await target.completeReview(failed, 1);
		}
		expect(target.isPaused).toBe(true);
		const persisted = target.snapshot();
		// The streak is persisted as a record of the previous run ...
		expect(persisted.failureStreak).toBe(FAILURE_PAUSE_COUNT);
		expect(persisted.lastFailure?.reason).toBe("model exploded");

		// ... and deliberately not restored as live state. A reload is a
		// reconfiguration that re-arms automatic review; the live pause also expires
		// on its own now (a cooldown with a probe attempt), and `/advisor resume` or
		// saving a configuration clear it sooner (see below and failure-pause.test).
		const reloaded = runtime();
		reloaded.restore(persisted);
		expect(reloaded.isPaused).toBe(false);
		expect(reloaded.snapshot().failureStreak).toBe(0);
		// A reload re-arms the cadence: the next full batch of steps is due.
		for (let index = 0; index < CONFIG.review.everySteps; index++) reloaded.noteStepCompleted();
		expect(reloaded.shouldReview(5)).toBe(true);
	});

	it("re-arms when the operator saves a configuration", async () => {
		const target = runtime();
		for (let index = 0; index < FAILURE_PAUSE_COUNT; index++) {
			await target.completeReview(failed, 1);
		}
		expect(target.isPaused).toBe(true);
		// A saved configuration is the operator's statement that this is what
		// should be running. Without re-arming here the live session would stay
		// silent on the old configuration until the cooldown expired or the operator
		// ran `/advisor resume`.
		target.applyConfig({ ...CONFIG, review: { ...CONFIG.review, maxAdviceChars: 1500 } });
		expect(target.isPaused).toBe(false);
		expect(target.snapshot().failureStreak).toBe(0);
		expect(target.snapshot().lastFailure).toBeUndefined();
		for (let index = 0; index < CONFIG.review.everySteps; index++) target.noteStepCompleted();
		expect(target.shouldReview(5)).toBe(true);
	});
});

describe("settleReviewOutcome", () => {
	it("turns a failure observed while disposing into a neutral cancellation", () => {
		// Host teardown cancels the review through the parent-child link, which is
		// indistinguishable from a real failure by message alone.
		expect(settleReviewOutcome(failed, true)).toEqual({
			kind: "cancelled",
			reason: "model exploded",
		});
	});

	it("keeps a failure as a failure while the owner is alive", () => {
		expect(settleReviewOutcome(failed, false)).toEqual(failed);
	});

	it("never rewrites a success or an existing cancellation", () => {
		expect(settleReviewOutcome({ kind: "silent" }, true)).toEqual({ kind: "silent" });
		expect(settleReviewOutcome(cancelled, true)).toEqual(cancelled);
	});

	it("keeps a teardown cancellation out of the failure pause", async () => {
		const target = runtime();
		for (let index = 0; index < FAILURE_PAUSE_COUNT + 1; index++) {
			await target.completeReview(settleReviewOutcome(failed, true), 1);
		}
		expect(target.isPaused).toBe(false);
		expect(target.snapshot().failureStreak).toBe(0);
	});
});

describe("step cursor as the attempt pacer", () => {
	it("retries a failed review only on the next cadence, not on the next step", async () => {
		const target = runtime();
		for (let index = 0; index < CONFIG.review.everySteps; index++) target.noteStepCompleted();
		expect(target.shouldReview(1)).toBe(true);
		await target.completeReview(failed, 1);
		// A broken route must not be re-attempted per step: the cursor moved to the
		// steps seen at the failure, so one step is not enough.
		target.noteStepCompleted();
		expect(target.shouldReview(1)).toBe(false);
		for (let index = 1; index < CONFIG.review.everySteps; index++) target.noteStepCompleted();
		expect(target.shouldReview(1)).toBe(true);
	});

	it("reaches the failure pause when a broken route keeps failing", async () => {
		const target = runtime();
		for (let index = 0; index < FAILURE_PAUSE_COUNT; index++) {
			for (let step = 0; step < CONFIG.review.everySteps; step++) target.noteStepCompleted();
			expect(target.shouldReview(1)).toBe(true);
			await target.completeReview(failed, 1);
		}
		expect(target.isPaused).toBe(true);
	});

	it("does not count a cancelled review as a failure but still paces the retry", async () => {
		const target = runtime();
		for (let index = 0; index < CONFIG.review.everySteps; index++) target.noteStepCompleted();
		expect(target.shouldReview(1)).toBe(true);
		await target.completeReview(cancelled, 1);
		target.noteStepCompleted();
		expect(target.shouldReview(1)).toBe(false);
		expect(target.snapshot().failureStreak).toBe(0);
	});
});
