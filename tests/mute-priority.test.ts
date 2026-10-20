import { describe, expect, it } from "vitest";

import { DEFAULT_ADVISOR_CONFIG, type AdvisorConfig } from "../src/policy/config.ts";
import type {
	AdvisorPort,
	DeliveredAdvice,
	ExecutorStatus,
	PersistedAdvisorState,
} from "../src/port.ts";
import { AdvisorRuntime, acceptAdviseCall } from "../src/state.ts";

/**
 * Item 4 of the policy test plan ("mute outranks similarity") is implemented in
 * `AdvisorRuntime.completeReview` through the runtime-owned `MuteStore`, with
 * mutes restored from the durable sidecar state. These cases drive that path
 * through the fake port, without any I/O.
 */

const NOTE = "The rollback path drops pending state on failure.";
const DISTINCT =
	"Feature flags are read after the configuration file is closed, so values always come back empty.";

const CONFIG: AdvisorConfig = {
	...DEFAULT_ADVISOR_CONFIG,
	enabled: true,
	model: { provider: "test", model: "test" },
	delivery: { activeIdleSeverities: ["blocker"] },
};

function emptyState(): PersistedAdvisorState {
	return {
		version: 1,
		lastReviewedTurn: 0,
		followUpsUsed: 0,
		failureStreak: 0,
		dedupe: [],
		mutes: [],
		pending: [],
	};
}

function createHarness() {
	const state = {
		status: { idle: false, turnNumber: 0 } as ExecutorStatus,
		steered: [] as DeliveredAdvice[],
	};
	const port: AdvisorPort = {
		readStatus: async () => ({ ...state.status }),
		steer: (_sessionId, message) => {
			state.steered.push(message);
			return `message-${state.steered.length}`;
		},
		followUp: () => {
			throw new Error("followUp is not expected in these cases");
		},
		runReview: async () => ({ kind: "silent" }),
		now: () => 0,
	};
	return { state, runtime: new AdvisorRuntime(CONFIG, port, "session-1") };
}

function adviceFor(note: string, severity: "nit" | "concern" | "blocker", findingKey: string) {
	const advice = acceptAdviseCall({ note, severity, findingKey }, CONFIG, 0);
	if (advice === undefined) throw new Error("expected advice to be accepted");
	return advice;
}

describe("mute handling in the delivery path", () => {
	it("does not deliver a muted finding even when dedupe would allow a re-raise", async () => {
		const { state, runtime } = createHarness();
		const first = adviceFor(NOTE, "concern", "finding-muted");
		state.status = { idle: false, turnNumber: 1 };
		await runtime.completeReview({ kind: "finding", advice: first }, 1);
		expect(state.steered).toHaveLength(1);

		runtime.restore({
			...runtime.snapshot(),
			mutes: [{ hash: first.findingKeyHash, label: "muted finding" }],
		});
		const reRaise = adviceFor(DISTINCT, "blocker", "finding-muted");
		state.status = { idle: false, turnNumber: 5 };
		// Dedupe would deliver this as re-raised: same key, strictly higher
		// severity, four turns since the last delivery. Mute must win.
		await runtime.completeReview({ kind: "finding", advice: reRaise }, 5);
		expect(state.steered).toHaveLength(1);
		expect(runtime.pendingCount).toBe(0);
		// A muted finding must not be recorded in the dedupe table either.
		expect(runtime.snapshot().dedupe[0]?.lastDeliveryTurn).toBe(1);

		// Clearing the mute list makes the same re-raise deliverable again.
		runtime.restore({ ...runtime.snapshot(), mutes: [] });
		state.status = { idle: false, turnNumber: 6 };
		await runtime.completeReview({ kind: "finding", advice: reRaise }, 6);
		expect(state.steered).toHaveLength(2);
		expect(state.steered[1]?.text).toContain(DISTINCT);
		expect(state.steered[1]?.summary).toContain("再次提出");
	});

	it("keeps a muted fresh finding out of the pending queue until it is unmuted", async () => {
		const { state, runtime } = createHarness();
		const advice = adviceFor(NOTE, "blocker", "finding-muted-fresh");
		runtime.restore({
			...emptyState(),
			mutes: [{ hash: advice.findingKeyHash, label: "muted finding" }],
		});
		state.status = { idle: false, turnNumber: 2 };
		await runtime.completeReview({ kind: "finding", advice }, 2);
		expect(state.steered).toEqual([]);
		expect(runtime.pendingCount).toBe(0);
		expect(runtime.snapshot().dedupe).toEqual([]);

		runtime.restore(emptyState());
		state.status = { idle: false, turnNumber: 3 };
		await runtime.completeReview({ kind: "finding", advice }, 3);
		expect(state.steered).toHaveLength(1);
	});
});
