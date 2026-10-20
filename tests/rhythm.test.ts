import { describe, expect, it } from "vitest";

import { acceptReviewAdvice } from "../src/policy/advice.ts";
import { DEFAULT_ADVISOR_CONFIG, type AdvisorConfig } from "../src/policy/config.ts";
import type { AdvisorPort, ExecutorStatus } from "../src/port.ts";
import { ADVISOR_STATE_VERSION } from "../src/port.ts";
import { AdvisorRuntime } from "../src/state.ts";

/**
 * The trigger: a review starts once `everySteps` completed steps have accrued
 * since the previous one finished. A step is one model call plus its tools, so
 * the single counter spans turns; these rules only show up across a reload or a
 * plugin-opened turn, so they are pinned here.
 */

const SESSION = "session-01K00000000000000000000000";

function config(overrides: Partial<AdvisorConfig["review"]> = {}): AdvisorConfig {
	return {
		...DEFAULT_ADVISOR_CONFIG,
		enabled: true,
		model: { provider: "p", model: "m" },
		review: { ...DEFAULT_ADVISOR_CONFIG.review, ...overrides },
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

/** Counts `count` completed steps and asks whether the last one starts a review. */
function step(target: AdvisorRuntime, count: number, turnNumber = 1): boolean {
	let due = false;
	for (let index = 0; index < count; index++) {
		target.noteStepCompleted();
		due = target.shouldReview({ turnNumber, cursor: index });
	}
	return due;
}

const ADVICE = acceptReviewAdvice(
	{ note: "The rollback path drops pending state.", severity: "blocker", findingKey: "k" },
	{ maxAdviceChars: 2_000, now: 0 },
);

describe("plugin-opened turns", () => {
	it("are never reviewable, only reviewable Executor steps are", async () => {
		const deliveries: string[] = [];
		const live = new AdvisorRuntime(config({ everySteps: 1 }), port(deliveries), SESSION);

		// A finding delivered into an idle Executor opens a turn of its own.
		await live.completeReview({ kind: "finding", advice: ADVICE }, 1);
		expect(deliveries).toEqual(["followUp"]);

		live.noteTurnStart(2);
		expect(live.isPluginTurn(2)).toBe(true);
		live.noteStepCompleted();
		expect(live.shouldReview({ turnNumber: 2, cursor: 2 })).toBe(false);

		// The plugin turn closes (turn/end), which frees the follow-up window.
		expect(live.closePluginTurn(2)).toBe(true);

		// A real user turn is reviewable again.
		live.noteTurnStart(3);
		expect(step(live, 1, 3)).toBe(true);
	});
});

describe("step rhythm", () => {
	it("reviews once N steps have accrued, not before", () => {
		const target = runtime({ everySteps: 4 });
		expect(step(target, 3)).toBe(false);
		expect(step(target, 1)).toBe(true);
	});

	it("does not review a fresh session before the first full cadence", () => {
		const target = runtime({ everySteps: 10 });
		expect(step(target, 1)).toBe(false);
	});

	it("counts steps across turn boundaries", () => {
		const target = runtime({ everySteps: 6 });
		// Six short turns, one step each: the counter is a single session total, so
		// the review is due regardless of how many turns the steps are spread over.
		let due = false;
		for (let turn = 1; turn <= 6; turn++) {
			target.noteTurnStart(turn);
			due = step(target, 1, turn);
		}
		expect(due).toBe(true);
	});

	it("starts the cadence over when a review finishes, not when it starts", async () => {
		const target = runtime({ everySteps: 4 });
		expect(step(target, 4)).toBe(true);
		// The review itself spans more steps than the cadence: they were covered by
		// the review that ran while they happened, so they must not be re-reviewed.
		step(target, 6);
		await target.completeReview({ kind: "silent" }, 1);
		expect(step(target, 3)).toBe(false);
		expect(step(target, 1)).toBe(true);
	});

	it("can be disabled with everySteps: 0", () => {
		const target = runtime({ everySteps: 0 });
		expect(step(target, 500)).toBe(false);
	});
});

describe("restored rhythm", () => {
	it("continues the step counter across a reload instead of restarting it", () => {
		const target = runtime({ everySteps: 10 });
		target.restore({
			version: ADVISOR_STATE_VERSION,
			cursor: 41,
			lastReviewedTurn: 5,
			stepsTotal: 18,
			lastReviewedStep: 12,
			followUpsUsed: 0,
			failureStreak: 0,
			dedupe: [],
			mutes: [],
			pending: [],
		});
		// Six steps had accrued since the review at step 12; the reload must not
		// forgive them, so four more steps (step 10 of the gap) are due.
		expect(step(target, 3, 6)).toBe(false);
		expect(step(target, 1, 6)).toBe(true);
	});

	it("starts the cadence at zero in a sidecar written before the counters existed", () => {
		const target = runtime({ everySteps: 10 });
		target.restore({
			version: ADVISOR_STATE_VERSION,
			cursor: 41,
			lastReviewedTurn: 5,
			followUpsUsed: 0,
			failureStreak: 0,
			dedupe: [],
			mutes: [],
			pending: [],
		});
		expect(target.snapshot().stepsTotal).toBe(0);
		expect(step(target, 9)).toBe(false);
		expect(step(target, 1)).toBe(true);
	});

	it("restores the newest turn so pre-reload notes are judged against it", () => {
		const target = runtime();
		target.restore({
			version: ADVISOR_STATE_VERSION,
			cursor: 10,
			lastReviewedTurn: 3,
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
