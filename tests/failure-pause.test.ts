import { describe, expect, it } from "vitest";

import { DEFAULT_ADVISOR_CONFIG, type AdvisorConfig } from "../src/policy/config.ts";
import type { AdvisorPort, ReviewOutcome } from "../src/port.ts";
import {
	AdvisorRuntime,
	FAILURE_PAUSE_COUNT,
	FAILURE_PAUSE_MAX_MS,
	FAILURE_PAUSE_MS,
} from "../src/state.ts";

/**
 * The failure pause is a cooldown, not a latch: `shouldReview` has to refuse
 * attempts while it holds, admit exactly the probe attempt that comes due when
 * it expires, and let a failing probe double the next hold. These cases pin that
 * clock, plus the explicit `resume()` an operator uses instead of waiting.
 */

const CONFIG: AdvisorConfig = {
	...DEFAULT_ADVISOR_CONFIG,
	enabled: true,
	model: { provider: "p", model: "m" },
};

const FAILED: ReviewOutcome = { kind: "failed", reason: "review timed out" };

function harness() {
	let now = 1_000;
	const port: AdvisorPort = {
		readStatus: () => Promise.resolve({ idle: true, turnNumber: 1 }),
		steer: () => "message-1",
		followUp: () => true,
		runReview: () => Promise.resolve({ kind: "silent" }),
		now: () => now,
	};
	const runtime = new AdvisorRuntime(CONFIG, port, "session-1");
	return {
		runtime,
		advance(ms: number): void {
			now += ms;
		},
		now: (): number => now,
		/** Trips the pause: `FAILURE_PAUSE_COUNT` consecutive real failures. */
		async fail(reason = FAILED): Promise<void> {
			for (let index = 0; index < FAILURE_PAUSE_COUNT; index++) await runtime.completeReview(reason, 1);
		},
		/** Accrues one full cadence, so the only thing between a boundary and a review is the pause. */
		due(): void {
			for (let index = 0; index < CONFIG.review.everySteps; index++) runtime.noteStepCompleted();
		},
	};
}

describe("failure pause cooldown", () => {
	it("holds review for the cooldown instead of latching it off", async () => {
		const target = harness();
		await target.fail();
		expect(target.runtime.isPaused).toBe(true);
		expect(target.runtime.pauseDeadline).toBe(target.now() + FAILURE_PAUSE_MS);
		// Work keeps accruing while paused; the cadence is due but the hold wins.
		target.due();
		expect(target.runtime.shouldReview(2)).toBe(false);
		target.advance(FAILURE_PAUSE_MS - 1);
		expect(target.runtime.isPaused).toBe(true);
		expect(target.runtime.shouldReview(2)).toBe(false);
		// One millisecond later the boundary is the probe, with no one acting.
		target.advance(1);
		expect(target.runtime.isPaused).toBe(false);
		expect(target.runtime.pauseDeadline).toBeUndefined();
		expect(target.runtime.shouldReview(2)).toBe(true);
	});

	it("doubles the hold when the probe fails too", async () => {
		const target = harness();
		await target.fail();
		target.due();
		target.advance(FAILURE_PAUSE_MS);
		expect(target.runtime.shouldReview(2)).toBe(true);
		await target.runtime.completeReview(FAILED, 2);
		expect(target.runtime.isPaused).toBe(true);
		// The second hold is twice the first: a route that is still down must not be
		// probed at the shortest interval forever.
		expect((target.runtime.pauseDeadline ?? 0) - target.now()).toBe(FAILURE_PAUSE_MS * 2);
	});

	it("caps the repeated holds so a broken route costs one attempt per ceiling", async () => {
		const target = harness();
		await target.fail();
		// Each round: wait out the hold, probe, fail again. The hold must stop growing.
		for (let round = 0; round < 8; round++) {
			target.advance((target.runtime.pauseDeadline ?? 0) - target.now());
			expect(target.runtime.isPaused).toBe(false);
			await target.runtime.completeReview(FAILED, 2);
			expect(target.runtime.isPaused).toBe(true);
		}
		expect((target.runtime.pauseDeadline ?? 0) - target.now()).toBe(FAILURE_PAUSE_MAX_MS);
	});

	it("starts from the shortest hold again after a review is judged", async () => {
		const target = harness();
		await target.fail();
		target.advance(FAILURE_PAUSE_MS);
		await target.runtime.completeReview(FAILED, 2); // doubled to 2 minutes
		expect(target.runtime.isPaused).toBe(true);
		// A silent review is a judged attempt: the route works, so the next break
		// must not inherit the escalated hold.
		await target.runtime.completeReview({ kind: "silent" }, 2);
		expect(target.runtime.isPaused).toBe(false);
		expect(target.runtime.snapshot().failureStreak).toBe(0);
		await target.fail();
		expect((target.runtime.pauseDeadline ?? 0) - target.now()).toBe(FAILURE_PAUSE_MS);
	});

	it("re-arms immediately on an explicit resume, leaving the configuration alone", async () => {
		const target = harness();
		await target.fail();
		target.due();
		expect(target.runtime.isPaused).toBe(true);
		target.runtime.resume();
		expect(target.runtime.isPaused).toBe(false);
		expect(target.runtime.snapshot().failureStreak).toBe(0);
		expect(target.runtime.snapshot().lastFailure).toBeUndefined();
		expect(target.runtime.shouldReview(2)).toBe(true);
	});
});

describe("a session that cannot host a review", () => {
	/**
	 * A preset without `read` denies every review before it reaches a model. That is
	 * a deployment fact no retry can clear, so it must not trip the pause that exists
	 * for a broken route — and the reason must stay visible to the operator.
	 */
	const UNAVAILABLE: ReviewOutcome = {
		kind: "unavailable",
		reason: "review child has no read tool: this session's agent preset does not enable it",
	};

	it("is never counted as a failure, however many times it repeats", async () => {
		const target = harness();
		for (let index = 0; index < FAILURE_PAUSE_COUNT + 2; index++) {
			await target.runtime.completeReview(UNAVAILABLE, 1);
		}
		expect(target.runtime.isPaused).toBe(false);
		expect(target.runtime.snapshot().failureStreak).toBe(0);
		// The reason still reaches the operator: silence would look like a working
		// second opinion that simply had nothing to say.
		expect(target.runtime.snapshot().lastFailure?.reason).toBe(UNAVAILABLE.reason);

		target.due();
		expect(target.runtime.shouldReview(2)).toBe(true);
	});

	it("does not clear a streak a real failure started", async () => {
		const target = harness();
		await target.runtime.completeReview(FAILED, 1);
		await target.runtime.completeReview(UNAVAILABLE, 1);
		// Unavailable is neutral, not a success: the route failure still stands.
		expect(target.runtime.snapshot().failureStreak).toBe(1);
	});
});
