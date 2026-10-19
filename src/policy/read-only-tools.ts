/**
 * The tool surface a review child is allowed to use.
 *
 * A review may read the work under review but never change it, so the allow
 * list is exactly the harness's own read-only filesystem tools. Which of them
 * EXIST is a deployment fact, not a constant: the harness filesystem tools can
 * sit on the agent plane (an agent preset) rather than in the global layer, so
 * the caller must pass the tools the child can actually see.
 *
 * Remote file tools (`mcp__<server>__read|grep|glob`) are deliberately not on
 * this list. They address another namespace — an SSH asset root, a bucket —
 * not the filesystem the Executor worked in, so a review that read through
 * them would judge a different machine than the one the diff belongs to.
 *
 * @module dsh-advisor/policy/read-only-tools
 */

/** The tools a review prefers, most important first. No `ls`, no `find`. */
export const REVIEW_READ_ONLY_TOOL_NAMES = ["read", "grep", "glob"] as const;

/**
 * The subset of {@link REVIEW_READ_ONLY_TOOL_NAMES} present in the visible
 * tool surface, in preference order.
 *
 * @param visible - Names the review child can actually call.
 * @returns The allow list for `tools.restrict`.
 */
export function selectReviewReadOnlyTools(visible: readonly string[]): string[] {
	const present = new Set(visible);
	return REVIEW_READ_ONLY_TOOL_NAMES.filter((name) => present.has(name));
}
