import { describe, expect, it } from "vitest";

import { formatAdvisorStatus, registerAdvisorStatus, type AdvisorStatus, type CommandRegistry } from "../src/host/status.ts";
import {
	ADVISOR_RESUME_PATH,
	ADVISOR_STATUS_PATH,
	registerAdvisorStatusRoute,
	type ConnectionFetchHost,
} from "../src/host/status-route.ts";

/**
 * The status surface exists to answer one question the sidecar alone answers
 * badly: "did a review run, and why was there no note?". These cases pin the
 * distinctions that make it answerable — above all that silence, suppression and
 * failure never render the same way.
 */

function status(overrides: Partial<AdvisorStatus> = {}): AdvisorStatus {
	return {
		enabled: true,
		model: { provider: "opencode-go", model: "glm-5.3-flash", reasoningEffort: "low" },
		paused: false,
		currentTurn: 6,
		reviewing: false,
		lastReviewedTurn: 6,
		followUpsUsed: 0,
		followUpCap: 5,
		failureStreak: 0,
		pending: { count: 0, severities: [] },
		muted: 0,
		delivered: 0,
		...overrides,
	};
}

describe("formatAdvisorStatus", () => {
	it("renders the model route with its reasoning effort", () => {
		expect(formatAdvisorStatus(status())).toContain("model=opencode-go/glm-5.3-flash (low)");
	});

	it("omits a reasoning effort that is not configured", () => {
		const text = formatAdvisorStatus(
			status({ model: { provider: "p", model: "m" } }),
		);
		expect(text).toContain("model=p/m");
		expect(text).not.toContain("model=p/m (");
	});

	it("says a session was never reviewed instead of reporting turn 0", () => {
		expect(formatAdvisorStatus(status({ lastReviewedTurn: 0 }))).toContain("last reviewed turn never");
	});

	it("distinguishes silence from a suppressed finding and from a failure", () => {
		const silent = formatAdvisorStatus(
			status({ lastOutcome: { kind: "silent", turn: 6, severity: undefined, reason: undefined } }),
		);
		const suppressed = formatAdvisorStatus(
			status({
				lastOutcome: { kind: "suppressed", turn: 6, severity: "concern", reason: "muted" },
			}),
		);
		const failed = formatAdvisorStatus(
			status({ lastOutcome: { kind: "failed", turn: 6, severity: undefined, reason: "model exploded" } }),
		);
		expect(silent).toContain("no finding (silent)");
		expect(suppressed).toContain("dropped before delivery (muted)");
		expect(failed).toContain("failed: model exploded");
		// The three must not collapse into one another: that collapse is exactly
		// what made "it is not working" indistinguishable from "it found nothing".
		expect(new Set([silent, suppressed, failed]).size).toBe(3);
	});

	it("explains that silence is a result, not a failure", () => {
		expect(
			formatAdvisorStatus(
				status({ lastOutcome: { kind: "silent", turn: 6, severity: undefined, reason: undefined } }),
			),
		).toContain("silence is the normal outcome");
		expect(
			formatAdvisorStatus(
				status({ lastOutcome: { kind: "failed", turn: 6, severity: undefined, reason: "boom" } }),
			),
		).not.toContain("silence is the normal outcome");
	});

	it("treats a cancellation as neutral, not as a failure", () => {
		const text = formatAdvisorStatus(
			status({
				lastOutcome: { kind: "cancelled", turn: 6, severity: undefined, reason: "owner disposed" },
			}),
		);
		expect(text).toContain("not a failure");
	});

	it("reports a review in flight rather than an idle session", () => {
		expect(formatAdvisorStatus(status({ reviewing: true }))).toContain("review in flight");
		expect(formatAdvisorStatus(status({ reviewing: false }))).toContain("idle");
	});

	it("reports the queued severities, so a parked nit is visible", () => {
		const text = formatAdvisorStatus(status({ pending: { count: 2, severities: ["nit", "concern"] } }));
		expect(text).toContain("pending 2 (nit, concern)");
	});

	it("says why a queued note is held instead of leaving it unexplained", () => {
		const text = formatAdvisorStatus(
			status({ pending: { count: 1, severities: ["concern"], hold: "idleFollowUpCap" } }),
		);
		expect(text).toContain("held: the idle follow-up budget is spent");
	});

	it("counts a note that is waiting for its follow-up turn to be confirmed", () => {
		const text = formatAdvisorStatus(
			status({
				awaiting: {
					count: 1,
					severities: ["concern"],
					notes: [{ severity: "concern", note: "x", turn: 4 }],
				},
			}),
		);
		expect(text).toContain("awaiting 1");
	});

	it("counts a note already in the inbox but not yet admitted to a step", () => {
		const text = formatAdvisorStatus(
			status({
				inFlight: {
					count: 1,
					notes: [{ severity: "concern", note: "x", turn: 2, at: 1 }],
				},
			}),
		);
		expect(text).toContain("in flight 1");
	});

	it("renders the configured follow-up cap rather than a literal", () => {
		expect(formatAdvisorStatus(status({ followUpsUsed: 1, followUpCap: 3 }))).toContain("follow-ups 1/3");
	});

	it("reports the follow-up budget the session has spent", () => {
		expect(formatAdvisorStatus(status({ followUpsUsed: 3 }))).toContain("follow-ups 3/5");
	});

	it("reports review cost as aggregate tokens and average duration", () => {
		const text = formatAdvisorStatus(
			status({
				stats: {
					reviews: 2,
					silent: 1,
					findings: 1,
					failed: 0,
					cancelled: 0,
					inputTokens: 12_400,
					outputTokens: 1_050,
					cacheReadTokens: 8_000,
					reviewMs: 15_000,
				},
			}),
		);
		expect(text).toContain("reviews 2");
		expect(text).toContain("tokens 12.4K in / 1.1K out");
		expect(text).toContain("cache 8.0K");
		expect(text).toContain("avg 8s");
	});

	it("says no review has completed instead of printing zero tokens", () => {
		expect(formatAdvisorStatus(status())).toContain("cost:    no completed review yet");
	});

	it("flags the failure pause with its retry countdown and the way to skip it", () => {
		// The pause is a cooldown now: an operator who does nothing is told how long
		// the wait is, and one who has just fixed the route is told how to skip it.
		const text = formatAdvisorStatus(
			status({ paused: true, failureStreak: 3, pausedUntil: 130_000 }),
			100_000,
		);
		expect(text).toContain("PAUSED after 3 consecutive failures");
		expect(text).toContain("automatic retry in 30s");
		expect(text).toContain("/advisor resume to re-arm now");
	});

	it("does not promise a retry time it does not have", () => {
		const text = formatAdvisorStatus(status({ paused: true, failureStreak: 3 }), 100_000);
		expect(text).toContain("automatic retry is scheduled");
		expect(text).not.toContain("automatic retry in");
	});

	it("reports the durable failure reason alongside the streak", () => {
		const text = formatAdvisorStatus(
			status({ failureStreak: 1, lastFailure: { reason: "timeout", at: 1_000 } }),
		);
		expect(text).toContain("1/3 consecutive failures");
		expect(text).toContain("last failure: timeout");
	});
});

/** A Connection stand-in that captures the status and resume route handlers. */
function captureRoutes(options: { resumed: boolean } = { resumed: true }): {
	call: (sessionId: string) => Promise<Response>;
	resume: (sessionId: string) => Promise<Response>;
} {
	let statusHandler: ((request: Request) => Promise<Response>) | undefined;
	let resumeHandler: ((request: Request) => Promise<Response>) | undefined;
	const connection: ConnectionFetchHost = {
		fetch: {
			register(route) {
				if (route.path === ADVISOR_STATUS_PATH) statusHandler = route.fetch;
				if (route.path === ADVISOR_RESUME_PATH) resumeHandler = route.fetch;
				return async () => {};
			},
		},
	};
	registerAdvisorStatusRoute(connection, {
		describeSession: async () => undefined,
		readContext: () => undefined,
		configure: async () => {
			throw new Error("not used");
		},
		resumeSession: async () => options.resumed,
		logWarn: () => {},
	});
	return {
		call: (sessionId) => {
			if (statusHandler === undefined) throw new Error("no status route registered");
			return statusHandler(
				new Request(`http://host${ADVISOR_STATUS_PATH}?sessionId=${encodeURIComponent(sessionId)}`),
			);
		},
		resume: (sessionId) => {
			if (resumeHandler === undefined) throw new Error("no resume route registered");
			return resumeHandler(
				new Request(`http://host${ADVISOR_RESUME_PATH}?sessionId=${encodeURIComponent(sessionId)}`, {
					method: "POST",
				}),
			);
		},
	};
}

/** A stand-in registry: records what was registered and exposes the handler. */
function fakeRegistry() {
	type Definition = Parameters<CommandRegistry["register"]>[0];
	let definition: Definition | undefined;
	let disposed = 0;
	const registry: CommandRegistry = {
		register(next) {
			definition = next;
			return () => {
				disposed++;
			};
		},
	};
	return {
		registry,
		get definition() {
			if (definition === undefined) throw new Error("nothing registered");
			return definition;
		},
		get disposed() {
			return disposed;
		},
	};
}

describe("registerAdvisorStatus", () => {
	it("registers one `advisor` command that records no input", () => {
		const fake = fakeRegistry();
		registerAdvisorStatus(fake.registry, { describe: async () => status(), resume: async () => true });
		expect(fake.definition.name).toBe("advisor");
		expect(fake.definition.recordInput).toBe(false);
	});

	it("returns the registry's disposer so a reload cannot leave a stale registration", () => {
		const fake = fakeRegistry();
		const dispose = registerAdvisorStatus(fake.registry, { describe: async () => status(), resume: async () => true });
		dispose();
		expect(fake.disposed).toBe(1);
	});

	it("answers the bare command and an explicit `status` alike", async () => {
		const fake = fakeRegistry();
		registerAdvisorStatus(fake.registry, { describe: async () => status(), resume: async () => true });
		for (const line of ["", "status", "  status  "]) {
			const reply = await fake.definition.handler({ agent: undefined as never, rawInput: line });
			expect(reply.kind).toBe("success");
			expect(reply.text).toContain("last reviewed turn 6");
		}
	});

	it("refuses the arguments an older release accepted instead of faking success", async () => {
		const fake = fakeRegistry();
		registerAdvisorStatus(fake.registry, { describe: async () => status(), resume: async () => true });
		// `/advisor off` silently printing a status block would read as the switch
		// having worked, which is the failure mode this guard exists for.
		for (const line of ["off", "on", "model set p m", "config", "pause"]) {
			const reply = await fake.definition.handler({ agent: undefined as never, rawInput: line });
			expect(reply.kind).toBe("error");
			expect(reply.text).toContain("only `/advisor status` and `/advisor resume` are implemented");
		}
	});

	it("accepts a session id the session store itself minted", async () => {
		// `session-1` is a real id (the store counts up); a length floor on the
		// shape check made the page's own session look invalid.
		const captured = captureRoutes();
		const response = await captured.call("session-1");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: null });
	});

	it("rejects an id that is not a session id at all", async () => {
		const captured = captureRoutes();
		for (const call of [captured.call, captured.resume]) {
			expect((await call("../../etc/passwd")).status).toBe(400);
			expect((await call("")).status).toBe(400);
		}
	});

	it("reports a session with no state yet rather than an empty block", async () => {
		const fake = fakeRegistry();
		registerAdvisorStatus(fake.registry, { describe: async () => undefined, resume: async () => false });
		const reply = await fake.definition.handler({ agent: undefined as never, rawInput: "status" });
		expect(reply.kind).toBe("success");
		expect(reply.text).toContain("no state for this session yet");
	});

	it("clears the pause through the resume dependency and reports the re-armed state", async () => {
		const fake = fakeRegistry();
		let resumed = 0;
		registerAdvisorStatus(fake.registry, {
			describe: async () => status(),
			resume: async () => {
				resumed++;
				return true;
			},
		});
		const reply = await fake.definition.handler({ agent: undefined as never, rawInput: "  resume  " });
		expect(resumed).toBe(1);
		expect(reply.kind).toBe("success");
		expect(reply.text).toContain("review re-armed");
		// The re-armed status is the point: the operator sees review running again.
		expect(reply.text).toContain("last reviewed turn 6");
	});

	it("says there is nothing to resume instead of claiming a re-arm", async () => {
		const fake = fakeRegistry();
		registerAdvisorStatus(fake.registry, { describe: async () => undefined, resume: async () => false });
		const reply = await fake.definition.handler({ agent: undefined as never, rawInput: "resume" });
		expect(reply.kind).toBe("success");
		expect(reply.text).toContain("nothing observed since the plugin loaded");
	});

	it("resumes by session id and reports whether anything was re-armed", async () => {
		const captured = captureRoutes({ resumed: true });
		const response = await captured.resume("session-1");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ resumed: true });
	});
});
