import { describe, expect, it } from "vitest";

import { acceptReviewAdvice } from "../src/policy/advice.ts";
import { DEFAULT_ADVISOR_CONFIG, type AdvisorConfig } from "../src/policy/config.ts";
import type { AdvisorPort, ExecutorStatus } from "../src/port.ts";
import { ADVISOR_STATE_VERSION } from "../src/port.ts";
import { AdvisorRuntime } from "../src/state.ts";

/**
 * Review rhythm rules that only show up across a reload or a plugin-opened turn:
 * both decide whether a round is reviewable at all.
 */

const SESSION = "session-01K00000000000000000000000";

function config(): AdvisorConfig {
	return {
		...DEFAULT_ADVISOR_CONFIG,
		enabled: true,
		model: { provider: "p", model: "m" },
		review: { ...DEFAULT_ADVISOR_CONFIG.review, everyTurns: 1 },
	};
}

function port(deliveries: string[]): AdvisorPort {
	return {
		readStatus: (): Promise<ExecutorStatus | undefined> =>
			Promise.resolve({ idle: true, turnNumber: 1 }),
		steer: (): boolean => {
			deliveries.push("steer");
			return true;
		},
		followUp: (): boolean => {
			deliveries.push("followUp");
			return true;
		},
		runReview: async () => ({ kind: "silent" }),
		now: () => 0,
	};
}

const ADVICE = acceptReviewAdvice(
	{ note: "The rollback path drops pending state.", severity: "blocker", findingKey: "k" },
	{ maxAdviceChars: 2_000, now: 0 },
);

describe("plugin-opened turns", () => {
	it("are never reviewable, only reviewable Executor rounds are", async () => {
		const deliveries: string[] = [];
		const runtime = new AdvisorRuntime(config(), port(deliveries), SESSION);

		// A finding delivered into an idle Executor opens a turn of its own.
		await runtime.completeReview({ kind: "finding", advice: ADVICE }, 1);
		expect(deliveries).toEqual(["followUp"]);

		runtime.noteTurnStart(2);
		expect(runtime.isPluginTurn(2)).toBe(true);
		expect(runtime.shouldReview({ round: 2, turnNumber: 2, cursor: 2 })).toBe(false);

		// The plugin turn closes (turn/end), which frees the follow-up window.
		expect(runtime.closePluginTurn(2)).toBe(true);

		// A real user turn is reviewable again.
		runtime.noteTurnStart(3);
		expect(runtime.shouldReview({ round: 3, turnNumber: 3, cursor: 3 })).toBe(true);
	});
});

describe("restored rhythm", () => {
	it("keeps the durable round cursor so the first round after a reload is due", () => {
		const runtime = new AdvisorRuntime(config(), port([]), SESSION);
		runtime.restore({
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
		expect(runtime.reviewedRounds).toBe(7);
		// The observer re-seeds its counter from `reviewedRounds`, so the next round
		// is 8, not 1. With everyTurns=1 that must be due immediately.
		expect(runtime.shouldReview({ round: 8, turnNumber: 6, cursor: 41 })).toBe(true);
		expect(runtime.reviewedRounds).toBe(8);
	});

	it("restores the newest turn so pre-reload notes are judged against it", () => {
		const runtime = new AdvisorRuntime(config(), port([]), SESSION);
		runtime.restore({
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
		expect(runtime.currentTurnNumber).toBe(9);
	});
});
