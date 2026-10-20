import { describe, expect, it } from "vitest";

import { acceptReviewAdvice } from "../src/policy/advice.ts";
import { DEFAULT_ADVISOR_CONFIG, type AdvisorConfig } from "../src/policy/config.ts";
import type { AdvisorPort, ExecutorStatus } from "../src/port.ts";
import { ADVISOR_STATE_VERSION } from "../src/port.ts";
import { AdvisorRuntime } from "../src/state.ts";

/**
 * The trigger decides whether a review starts: a reply round (`everyTurns`) or a
 * completed step inside a running turn (`everySteps`). Both counters are
 * absolute and persisted, and the rules only show up across a reload or a
 * plugin-opened turn, so they are pinned here.
 */

const SESSION = "session-01K00000000000000000000000";

function config(overrides: Partial<AdvisorConfig["review"]> = {}): AdvisorConfig {
	return {
		...DEFAULT_ADVISOR_CONFIG,
		enabled: true,
		model: { provider: "p", model: "m" },
		review: {
			...DEFAULT_ADVISOR_CONFIG.review,
			everyTurns: 1,
			// The round cases must not be disturbed by step boundaries they never
			// meant to exercise; the step cases turn it on explicitly.
			everySteps: 0,
			...overrides,
		},
	};
}

function port(deliveries: string[]): AdvisorPort {
	return {
		readStatus: (): Promise<ExecutorStatus | undefined> =>
			Promise.resolve({ idle: true, turnNumber: 1 }),
		steer: (): string | undefined => {
			deliveries.push("steer");
			return `message-${deliveries.length}`;
		},
		followUp: (): boolean => {
			deliveries.push("followUp");
			return true;
		},
		runReview: async () => ({ kind: "silent" }),
		now: () => 0,
	};
}

function runtime(options: Partial<AdvisorConfig["review"]> = {}): AdvisorRuntime {
	return new AdvisorRuntime(config(options), port([]), SESSION);
}

/** Counts one reply round and asks the runtime whether it starts a review. */
function round(target: AdvisorRuntime, turnNumber = 1): boolean {
	target.noteRoundCompleted();
	return target.shouldReview({ kind: "round", turnNumber, cursor: turnNumber });
}

/** Counts `count` completed steps and asks whether the last one starts a review. */
function step(target: AdvisorRuntime, count: number, turnNumber = 1): boolean {
	let due = false;
	for (let index = 0; index < count; index++) {
		target.noteStepCompleted();
		due = target.shouldReview({ kind: "step", turnNumber, cursor: index });
	}
	return due;
}

const ADVICE = acceptReviewAdvice(
	{ note: "The rollback path drops pending state.", severity: "blocker", findingKey: "k" },
	{ maxAdviceChars: 2_000, now: 0 },
);

describe("plugin-opened turns", () => {
	it("are never reviewable, only reviewable Executor rounds are", async () => {
		const deliveries: string[] = [];
		const live = new AdvisorRuntime(config(), port(deliveries), SESSION);

		// A finding delivered into an idle Executor opens a turn of its own.
		await live.completeReview({ kind: "finding", advice: ADVICE }, 1);
		expect(deliveries).toEqual(["followUp"]);

		live.noteTurnStart(2);
		expect(live.isPluginTurn(2)).toBe(true);
		live.noteRoundCompleted();
		expect(live.shouldReview({ kind: "round", turnNumber: 2, cursor: 2 })).toBe(false);
		// Its steps do not move the Executor's mid-turn cadence either.
		live.noteStepCompleted();
		expect(live.shouldReview({ kind: "step", turnNumber: 2, cursor: 2 })).toBe(false);

		// The plugin turn closes (turn/end), which frees the follow-up window.
		expect(live.closePluginTurn(2)).toBe(true);

		// A real user turn is reviewable again.
		live.noteTurnStart(3);
		expect(round(live, 3)).toBe(true);
	});
});

describe("round rhythm", () => {
	it("reviews the first reply immediately, then every N rounds", async () => {
		const target = runtime({ everyTurns: 3 });
		expect(round(target)).toBe(true);
		await target.completeReview({ kind: "silent" }, 1);

		expect(round(target)).toBe(false);
		expect(round(target)).toBe(false);
		expect(round(target)).toBe(true);
	});
});

describe("mid-turn step rhythm", () => {
	it("reviews a running turn every N steps without waiting for a reply", () => {
		const target = runtime({ everyTurns: 100, everySteps: 4 });
		expect(step(target, 3)).toBe(false);
		expect(step(target, 1)).toBe(true);
	});

	it("does not review a fresh session after its first step", () => {
		// A step must not inherit the round rhythm's "first review is due
		// immediately": that would review a turn before it produced any reply.
		const target = runtime({ everyTurns: 100, everySteps: 4 });
		expect(step(target, 1)).toBe(false);
	});

	it("starts the step cadence over when a review finishes, not when it starts", async () => {
		const target = runtime({ everyTurns: 100, everySteps: 4 });
		expect(step(target, 4)).toBe(true);
		// The review itself spans more steps than the cadence: they were covered by
		// the review that ran while they happened, so they must not be re-reviewed.
		step(target, 6);
		await target.completeReview({ kind: "silent" }, 1);
		expect(step(target, 3)).toBe(false);
		expect(step(target, 1)).toBe(true);
	});

	it("can be disabled with everySteps: 0", () => {
		const target = runtime({ everyTurns: 100, everySteps: 0 });
		expect(step(target, 500)).toBe(false);
	});

	it("restarts the round cadence after a mid-turn review", async () => {
		const target = runtime({ everyTurns: 2, everySteps: 3 });
		expect(step(target, 3)).toBe(true);
		await target.completeReview({ kind: "silent" }, 1);
		// The round after a review is one round since it, not a fresh first round.
		expect(round(target)).toBe(false);
		expect(round(target)).toBe(true);
	});
});

describe("restored rhythm", () => {
	it("continues the round cadence across a reload instead of restarting it", () => {
		const target = runtime({ everyTurns: 3 });
		target.restore({
			version: ADVISOR_STATE_VERSION,
			cursor: 41,
			lastReviewedTurn: 5,
			lastReviewedRound: 7,
			rounds: 9,
			followUpsUsed: 0,
			failureStreak: 0,
			dedupe: [],
			mutes: [],
			pending: [],
		});
		// Two rounds had accrued since the review at round 7; the reload must not
		// forgive them, so the next round (10) is already due.
		expect(round(target, 6)).toBe(true);
	});

	it("seeds the round total from the cursor in a sidecar written before counters existed", () => {
		const target = runtime({ everyTurns: 3 });
		target.restore({
			version: ADVISOR_STATE_VERSION,
			cursor: 41,
			lastReviewedTurn: 5,
			lastReviewedRound: 7,
			followUpsUsed: 0,
			failureStreak: 0,
			dedupe: [],
			mutes: [],
			pending: [],
		});
		expect(target.snapshot().rounds).toBe(7);
		expect(round(target, 6)).toBe(false);
		expect(round(target, 7)).toBe(false);
		expect(round(target, 8)).toBe(true);
	});

	it("restores the step counters so the mid-turn cadence continues", () => {
		const target = runtime({ everyTurns: 100, everySteps: 5 });
		target.restore({
			version: ADVISOR_STATE_VERSION,
			cursor: 41,
			lastReviewedTurn: 0,
			stepsTotal: 12,
			lastReviewedStep: 10,
			followUpsUsed: 0,
			failureStreak: 0,
			dedupe: [],
			mutes: [],
			pending: [],
		});
		expect(step(target, 2)).toBe(false);
		expect(step(target, 1)).toBe(true);
	});

	it("restores the newest turn so pre-reload notes are judged against it", () => {
		const target = runtime();
		target.restore({
			version: ADVISOR_STATE_VERSION,
			cursor: 10,
			lastReviewedTurn: 3,
			lastReviewedRound: 3,
			currentTurn: 9,
			lastInstructionTurn: 8,
			followUpsUsed: 0,
			failureStreak: 0,
			dedupe: [],
			mutes: [],
			pending: [],
		});
		expect(target.currentTurnNumber).toBe(9);
	});
});
