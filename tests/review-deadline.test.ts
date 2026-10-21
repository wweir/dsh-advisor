import { describe, expect, it, vi } from "vitest";

// The setup step composes the Executor's real agent plane, which needs the whole
// host; what these tests exercise is only what runReview does with the child it
// gets back, so the composition is stubbed rather than stood up.
vi.mock("@deepseek-ai/dsh-subagent", () => ({
	applyChildComposition: () => Promise.resolve(),
	childSessionMeta: () => ({}),
}));

import type { Context } from "@deepseek-ai/cordis";

import { runReview } from "../src/host/review.ts";
import { DEFAULT_ADVISOR_CONFIG, type AdvisorConfig } from "../src/policy/config.ts";
import type { ReviewRequest } from "../src/port.ts";

const FINDING = { note: "src/a.ts:1 — the guard runs before the write", severity: "concern", findingKey: "guard-before-write" };

function config(timeoutMs: number): AdvisorConfig {
	return {
		...DEFAULT_ADVISOR_CONFIG,
		enabled: true,
		model: { provider: "p", model: "m" },
		review: { ...DEFAULT_ADVISOR_CONFIG.review, timeoutMs },
	};
}

const request: ReviewRequest = { sessionId: "session-1", cursor: 3, prompt: "review this" };

/**
 * A review child that never finishes on its own unless `adviseAfterMs` says it
 * records a finding, so the wall clock and the deadline steer are the only
 * things deciding the outcome.
 */
function harness(adviseAfterMs?: number) {
	const steers: string[] = [];
	let advise: ((args: unknown) => Promise<unknown>) | undefined;
	const idle = new Promise<void>(() => {});
	const child = {
		id: "advisor-test",
		followup: (): void => {
			if (adviseAfterMs === undefined) return;
			setTimeout(() => void advise?.(FINDING), adviseAfterMs);
		},
		steer: (message: { content: readonly { text?: string }[] }): void => {
			steers.push(message.content[0]?.text ?? "");
		},
		cancel: (): void => {},
		whenIdle: (): Promise<void> => idle,
		session: { snapshotEvents: (): unknown[] => [] },
	};
	const childCtx = {
		tools: {
			schemas: (): { name: string }[] => [{ name: "read" }, { name: "grep" }, { name: "glob" }],
			restrict: (): void => {},
			register: (tool: { execute: (args: unknown) => Promise<unknown> }): void => {
				advise = tool.execute;
			},
		},
		on: (): (() => void) => () => {},
	};
	const ctx = {
		logger: () => ({ warn: (): void => {}, info: (): void => {} }),
		agents: {
			create: async (input: { setup: (childContext: unknown, agent: unknown) => Promise<void> }) => {
				await input.setup(childCtx, child);
				return { agent: child, dispose: () => Promise.resolve() };
			},
		},
	} as unknown as Context;
	return { ctx, steers };
}

function run(options: { timeoutMs: number; adviseAfterMs?: number }) {
	const { ctx, steers } = harness(options.adviseAfterMs);
	const review = runReview({ ctx, config: config(options.timeoutMs), cwd: "/tmp" }, { id: "exec-1" } as never, request);
	return { review, steers };
}

describe("review deadline steer", () => {
	it("steers a review that is still gathering at 70 % of the wall clock", async () => {
		const { review, steers } = run({ timeoutMs: 600 });
		const outcome = await review;
		expect(outcome.kind).toBe("failed");
		expect(outcome.kind === "failed" ? outcome.reason : undefined).toBe("review timed out");
		expect(steers).toHaveLength(1);
		expect(steers[0]).toContain("deadline is close");
		// The nudge must keep silence a valid conclusion, or it manufactures findings.
		expect(steers[0]).toContain("silence remains the correct result");
	});

	it("does not steer a review that already recorded its finding", async () => {
		const { review, steers } = run({ timeoutMs: 600, adviseAfterMs: 5 });
		const outcome = await review;
		expect(outcome.kind).toBe("finding");
		// Long enough for the deadline steer to have fired if it were still armed.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(steers).toEqual([]);
	});
});
