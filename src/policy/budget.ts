/**
 * How large a review prompt may be, derived from the reviewer model rather than
 * assumed.
 *
 * `review.maxContextTokens` used to be a static 32K for every route. A review
 * sends a projection on top of the host's preamble (system prompt plus tool
 * schemas, measured at 11,089 tokens on this deployment) and the reviewer's own
 * output has to fit in the same window, so a 32K or 64K reviewer silently
 * overflowed: the host compacted the review child and the reviewer judged a
 * summary. The budget is therefore the smaller of the operator's cap and what
 * the model's window leaves after preamble, output reserve and margin — and a
 * route that cannot hold even a minimal review is refused with the numbers
 * instead of being attempted.
 *
 * @module dsh-advisor/policy/budget
 */

/**
 * The host preamble a review child inherits (system prompt and tool schemas),
 * measured on `advisor-a8ed3cfecf6f1c2b` on 2026-10-21. Each review replaces it
 * with its own measurement, so this is only the first review's estimate.
 */
export const REVIEW_PREAMBLE_FALLBACK_TOKENS = 11_089;

/** Output room reserved when the route advertises no per-request cap. */
export const REVIEW_OUTPUT_RESERVE_FALLBACK_TOKENS = 8_000;

/**
 * Slack between the configured numbers and the window. The estimator here is
 * this plugin's own (ASCII 0.25, non-ASCII 1), so it is not the provider's
 * tokenizer and the margin absorbs the difference.
 */
export const REVIEW_WINDOW_MARGIN_TOKENS = 2_000;

/**
 * Smallest evidence budget still worth a review: one tool call and a result in
 * the new-work zone. Below it the reviewer can neither see the work nor re-read
 * a file, so the route is refused rather than wasted.
 */
export const REVIEW_MIN_EVIDENCE_TOKENS = 4_000;

/** What the reviewer route advertises. Both fields are optional up the chain. */
export interface ReviewModelWindow {
	/** Maximum combined request and response context, when the adapter knows it. */
	readonly contextWindow?: number;
	/** Adapter-configured per-request output cap, when it has one. */
	readonly defaultMaxTokens?: number;
}

export interface ReviewBudget {
	/** Tokens the whole review prompt (instructions, fence, evidence) may occupy. */
	readonly evidenceTokens: number;
	/** Tokens left to the reviewer's own output. */
	readonly outputReserve: number;
	/** Preamble the host injects before the prompt on every request. */
	readonly preambleTokens: number;
	/** The reviewer model's window, when it was resolved. */
	readonly windowTokens?: number;
}

export type ReviewBudgetDecision =
	| { readonly kind: "ok"; readonly budget: ReviewBudget }
	| { readonly kind: "refused"; readonly reason: string };

export interface ReviewBudgetInput {
	/** `review.maxContextTokens`: the operator's cap on the prompt. */
	readonly configuredCap: number;
	/** Measured preamble, or {@link REVIEW_PREAMBLE_FALLBACK_TOKENS}. */
	readonly preambleTokens: number;
	/** The reviewer route's advertised capacity; absent when unresolved. */
	readonly window?: ReviewModelWindow;
}

/**
 * A configuration the reviewer route cannot hold. Its message names every number
 * that produced the refusal, so the page that saves the configuration can show it
 * as the reason instead of a generic write failure.
 */
export class ReviewCapacityError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "ReviewCapacityError";
	}
}

/** Plain digits with thousands separators: refusal text an operator can compare. */
function count(value: number): string {
	return value.toLocaleString("en-US");
}

/**
 * Plans one review's prompt budget.
 *
 * @param input - the cap, the measured preamble and the route's capacity.
 * @returns the budget, or the refusal with every number that produced it.
 */
export function planReviewBudget(input: ReviewBudgetInput): ReviewBudgetDecision {
	const outputReserve = input.window?.defaultMaxTokens ?? REVIEW_OUTPUT_RESERVE_FALLBACK_TOKENS;
	const contextWindow = input.window?.contextWindow;
	// A route whose capacity is unknown keeps the operator's cap: guessing a window
	// here would either shrink every review or overrun silently.
	const available =
		contextWindow === undefined
			? undefined
			: contextWindow - input.preambleTokens - outputReserve - REVIEW_WINDOW_MARGIN_TOKENS;
	if (contextWindow !== undefined && available !== undefined && available < REVIEW_MIN_EVIDENCE_TOKENS) {
		return {
			kind: "refused",
			reason:
				`reviewer window of ${count(contextWindow)} tokens cannot hold a review: ${count(input.preambleTokens)} preamble ` +
				`+ ${count(outputReserve)} output reserve + ${count(REVIEW_WINDOW_MARGIN_TOKENS)} margin leaves ${count(Math.max(0, available))}, ` +
				`below the ${count(REVIEW_MIN_EVIDENCE_TOKENS)}-token minimum for evidence. Choose a larger reviewer model or route.`,
		};
	}
	const evidenceTokens = Math.min(input.configuredCap, available ?? input.configuredCap);
	if (evidenceTokens < REVIEW_MIN_EVIDENCE_TOKENS) {
		// The operator's own cap is checked too: a cap below the minimum would send a
		// review with no room to point at anything, which is a wasted model call
		// reported as a review. Refusing names the value to raise.
		return {
			kind: "refused",
			reason:
				`review.maxContextTokens of ${count(input.configuredCap)} tokens is below the ${count(REVIEW_MIN_EVIDENCE_TOKENS)}-token ` +
				`minimum for evidence. Raise it, or choose a route whose window leaves at least that much after its ` +
				`${count(input.preambleTokens)}-token preamble and ${count(outputReserve)}-token output reserve.`,
		};
	}
	return {
		kind: "ok",
		budget: {
			evidenceTokens,
			outputReserve,
			preambleTokens: input.preambleTokens,
			...(contextWindow === undefined ? {} : { windowTokens: contextWindow }),
		},
	};
}
