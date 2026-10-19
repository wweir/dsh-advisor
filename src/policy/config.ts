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
	/** Minimum number of completed reply rounds between two reviews. */
	everyTurns: number;
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
		everyTurns: 3,
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
