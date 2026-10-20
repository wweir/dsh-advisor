/**
 * Advisor configuration types and the constants that are not worth exposing as
 * knobs. Only values a user would plausibly tune live in the config surface;
 * everything else is a module constant here.
 *
 * @module dsh-advisor/policy/config
 */

/** Config shape version, bumped when a stored layout stops being readable. */
export const ADVISOR_CONFIG_VERSION = 1 as const;

/** Reasoning efforts accepted for the advisor model route, least to greatest. */
export const ADVISOR_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type AdvisorEffort = (typeof ADVISOR_EFFORTS)[number];

/** Severities that may wake an idle executor with a follow-up turn. */
export type ActiveIdleSeverity = "concern" | "blocker";

export interface AdvisorModelConfig {
	provider: string;
	model: string;
	reasoningEffort?: AdvisorEffort;
}

export interface AdvisorReviewConfig {
	/**
	 * Minimum number of completed steps between two reviews. One step is one
	 * model call plus the tools it ran, so the cadence covers work inside a
	 * running turn and continues across turn boundaries: it is the only trigger,
	 * and there is no second, reply-based interval to keep in sync with it. The
	 * default is sized from measurements of this deployment (20k step intervals,
	 * 103 reviews in 43 sessions): a step takes ~10 s (p75 ~19 s) and a review
	 * 52 s (p75 113 s), while a quarter of reviews hit the 180 s deadline and the
	 * median multi-step turn in a reviewed session is 21 steps. Eight steps takes ~20 s off the median and
	 * ~70 s off the p90 detection delay for ~15 % more review calls than ten;
	 * below eight the cost curve rises faster than the delay falls. The measured
	 * interval between attempts is ~16 steps, not this number, because a review
	 * in flight skips boundaries and the cursor moves to the step count at its
	 * end. `0` disables automatic review.
	 */
	everySteps: number;
	/** Wall-clock bound for one review. */
	timeoutMs: number;
	/** Upper bound on the context sent to the review subagent. */
	maxContextTokens: number;
	/** Upper bound on one advice body. */
	maxAdviceChars: number;
	/** Upper bound on queued, not-yet-delivered advice. */
	maxPending: number;
}

export interface AdvisorDeliveryConfig {
	activeIdleSeverities: readonly ActiveIdleSeverity[];
}

export interface AdvisorSecurityConfig {
	/** Appended to the built-in protected path table; can never remove entries. */
	additionalProtectedPaths: readonly string[];
}

export interface AdvisorConfig {
	enabled: boolean;
	model?: AdvisorModelConfig;
	instructions: string;
	review: AdvisorReviewConfig;
	delivery: AdvisorDeliveryConfig;
	security: AdvisorSecurityConfig;
}

export const DEFAULT_ADVISOR_CONFIG: AdvisorConfig = Object.freeze({
	enabled: false,
	instructions: "",
	review: Object.freeze({
		everySteps: 8,
		timeoutMs: 180_000,
		maxContextTokens: 32_000,
		maxAdviceChars: 2_000,
		maxPending: 32,
	}),
	delivery: Object.freeze({ activeIdleSeverities: Object.freeze(["concern", "blocker"] as const) }),
	security: Object.freeze({ additionalProtectedPaths: Object.freeze([] as const) }),
}) as AdvisorConfig;

/** Whether the plugin should perform any review at all. */
export function isAdvisorActive(config: AdvisorConfig): boolean {
	return config.enabled && config.model !== undefined;
}
