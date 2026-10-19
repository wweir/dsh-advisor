import { describe, expect, it } from "vitest";

import {
	BoundedKeyedFifo,
	explainAdviceHold,
	selectAdviceDispatch,
	type AdviceDispatchState,
} from "../src/policy/delivery.ts";

const RUNNING: AdviceDispatchState = {
	forceDeferred: false,
	idle: false,
	newerInstructionInput: false,
	severity: "blocker",
	activeIdleSeverities: ["blocker"],
	reviewFollowUpPending: false,
	reviewFollowUpCapExhausted: false,
	followUpAttempted: false,
};

describe("selectAdviceDispatch truth table", () => {
	it("steers any severity while the executor is running", () => {
		for (const severity of ["nit", "concern", "blocker"] as const) {
			expect(selectAdviceDispatch({ ...RUNNING, severity })).toBe("steer");
		}
		// Follow-up gates only apply to idle executors; they cannot downgrade a
		// running delivery into a deferred one.
		expect(
			selectAdviceDispatch({
				...RUNNING,
				newerInstructionInput: true,
				reviewFollowUpPending: true,
				reviewFollowUpCapExhausted: true,
				activeIdleSeverities: [],
			}),
		).toBe("steer");
	});

	it("follows up only for an eligible severity with every idle gate clear", () => {
		const idle: AdviceDispatchState = { ...RUNNING, idle: true };
		expect(selectAdviceDispatch(idle)).toBe("followUp");
		expect(
			selectAdviceDispatch({ ...idle, activeIdleSeverities: ["concern", "blocker"] }),
		).toBe("followUp");
		expect(
			selectAdviceDispatch({
				...idle,
				severity: "concern",
				activeIdleSeverities: ["concern", "blocker"],
			}),
		).toBe("followUp");
	});

	it("defers an idle note whenever one gate is closed", () => {
		const idle: AdviceDispatchState = { ...RUNNING, idle: true };
		expect(selectAdviceDispatch({ ...idle, severity: "concern" })).toBe("deferred");
		expect(selectAdviceDispatch({ ...idle, severity: "nit" })).toBe("deferred");
		expect(selectAdviceDispatch({ ...idle, activeIdleSeverities: [] })).toBe("deferred");
		expect(selectAdviceDispatch({ ...idle, newerInstructionInput: true })).toBe("deferred");
		expect(selectAdviceDispatch({ ...idle, reviewFollowUpPending: true })).toBe("deferred");
		expect(selectAdviceDispatch({ ...idle, reviewFollowUpCapExhausted: true })).toBe("deferred");
	});

	it("does not open another follow-up turn for a note whose last attempt went unprocessed", () => {
		const idle: AdviceDispatchState = { ...RUNNING, idle: true };
		// The retry must not wake the Executor again: that is how a lost note would
		// become a loop of empty turns. It waits for a running turn instead.
		expect(selectAdviceDispatch({ ...idle, followUpAttempted: true })).toBe("deferred");
		expect(explainAdviceHold({ ...idle, followUpAttempted: true })).toBe("idleFollowUpRetried");
		expect(selectAdviceDispatch({ ...RUNNING, followUpAttempted: true })).toBe("steer");
	});

	it("never steers an idle executor, for any combination of the other gates", () => {
		// The invariant is absolute: steering an idle driver opens a turn and
		// bypasses activeIdleSeverities, so no idle state may select "steer".
		for (const severity of ["nit", "concern", "blocker"] as const) {
			for (const activeIdleSeverities of [[], ["concern"], ["concern", "blocker"]] as const) {
				for (const newerInstructionInput of [false, true]) {
					for (const reviewFollowUpPending of [false, true]) {
						for (const reviewFollowUpCapExhausted of [false, true]) {
							for (const forceDeferred of [false, true]) {
								const state: AdviceDispatchState = {
									...RUNNING,
									idle: true,
									severity,
									activeIdleSeverities,
									newerInstructionInput,
									reviewFollowUpPending,
									reviewFollowUpCapExhausted,
									forceDeferred,
								};
								expect(selectAdviceDispatch(state)).not.toBe("steer");
							}
						}
					}
				}
			}
		}
	});

	it("lets forced deferral win even while running", () => {
		for (const idle of [false, true]) {
			expect(selectAdviceDispatch({ ...RUNNING, idle, forceDeferred: true })).toBe("deferred");
		}
	});
});

describe("BoundedKeyedFifo", () => {
	it("keeps one entry per key and replaces its value in place", () => {
		const fifo = new BoundedKeyedFifo<string>(4);
		fifo.set("finding-a", "first");
		fifo.set("finding-b", "other");
		fifo.set("finding-a", "second");
		expect(fifo.length).toBe(2);
		// Replacing does not move the entry: the queue order is the order findings
		// were first seen, and only the payload is refreshed.
		expect(fifo.entriesInOrder()).toEqual([
			{ key: "finding-a", value: "second" },
			{ key: "finding-b", value: "other" },
		]);
	});

	it("drops the oldest entry when the item bound is reached", () => {
		const fifo = new BoundedKeyedFifo<string>(2);
		fifo.set("a", "A");
		fifo.set("b", "B");
		fifo.set("c", "C");
		expect(fifo.entriesInOrder().map((entry) => entry.key)).toEqual(["b", "c"]);
		expect(fifo.peek()).toEqual({ key: "b", value: "B" });
		expect(fifo.shift()).toEqual({ key: "b", value: "B" });
		expect(fifo.length).toBe(1);
		fifo.clear();
		expect(fifo.length).toBe(0);
		expect(fifo.peek()).toBeUndefined();
	});

	it("does not drop anything when replacing a key at capacity", () => {
		const fifo = new BoundedKeyedFifo<string>(2);
		fifo.set("a", "A");
		fifo.set("b", "B");
		fifo.set("a", "A2");
		expect(fifo.entriesInOrder().map((entry) => entry.key)).toEqual(["a", "b"]);
	});

	it("removes an entry by key only while it still holds the delivered value", () => {
		const fifo = new BoundedKeyedFifo<string>(4);
		const stale = "stale";
		fifo.set("a", stale);
		fifo.set("b", "B");
		// A delivery may suspend while the queue replaces the value under the same
		// key; the newer observation must survive the removal.
		fifo.set("a", "A2");
		expect(fifo.deleteIf("a", stale)).toBe(false);
		expect(fifo.entriesInOrder().map((entry) => entry.key)).toEqual(["a", "b"]);
		expect(fifo.deleteIf("a", "A2")).toBe(true);
		expect(fifo.deleteIf("a", "A2")).toBe(false);
		expect(fifo.entriesInOrder().map((entry) => entry.key)).toEqual(["b"]);
	});

	it("rejects a non-positive or non-integer item bound", () => {
		expect(() => new BoundedKeyedFifo<string>(0)).toThrow(RangeError);
		expect(() => new BoundedKeyedFifo<string>(1.5)).toThrow(RangeError);
	});
});
