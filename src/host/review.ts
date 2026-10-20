/**
 * One review run: create a restricted child agent, drive it, read its single
 * `advise` result, and tear it down. The loop, tool pipeline, streaming,
 * cancellation and persistence all belong to the host.
 *
 * @module dsh-advisor/host/review
 */

import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { relative } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { foldConsumedWork } from "@deepseek-ai/dsh-agent";
// Loads the `ctx.fs` / `ctx.workingDirectory` service augmentations.
import "@deepseek-ai/dsh-fs";
import "@deepseek-ai/dsh-working-directory";
import type { ContentBlock, TokenUsage } from "@deepseek-ai/dsh-llm";
import { createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { applyChildComposition, childSessionMeta } from "@deepseek-ai/dsh-subagent";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

import { ADVISE_WIRE_SCHEMA, MAX_FINDING_KEY_CHARACTERS, type AcceptedReviewAdvice, parseAdviseWireInput } from "../policy/advice.ts";
import type { AdvisorConfig } from "../policy/config.ts";
import { redactSecrets } from "../policy/redaction.ts";
import { selectReviewReadOnlyTools } from "../policy/read-only-tools.ts";
import { ProtectedPathPolicy } from "../policy/security.ts";
import type { ReviewOutcome, ReviewRequest } from "../port.ts";
import type { ReviewUsage } from "../policy/stats.ts";
import { acceptAdviseCall } from "../state.ts";

const REVIEW_TOOL_NAME = "advise";

/**
 * Reads and searches one review may run, matching the bound its instructions
 * promise ("stop after at most five reads or searches"). The prompt alone was
 * not a limit: measured children ignored it and ran up to 37 reads, and every
 * read that starts a new step costs another model call inside the review's
 * wall-clock budget, so a wandering reviewer burned the whole deadline and
 * reported nothing. Refusing the call past the budget is what makes the
 * instruction bind, and a refusal carries the reason the reviewer has to
 * conclude with the evidence it already has.
 */
const REVIEW_READ_BUDGET = 5;

/** The review's only output channel. Scoped registration: the Executor never sees it. */
function createAdviseTool(onAdvise: (args: unknown) => void): ToolDefinition {
	return {
		name: REVIEW_TOOL_NAME,
		description:
			"Record exactly one concrete review finding. Call at most once; call nothing to stay silent.",
		parameters: ADVISE_WIRE_SCHEMA,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				required: ["recorded"],
				properties: { recorded: { type: "boolean" } },
			},
			render: () => [{ type: "text", text: "Recorded." }],
		},
		execute(args: unknown): Promise<unknown> {
			// The enforced schema subset has no `maxLength`, so the `findingKey` bound
			// cannot live in the wire schema. Rejecting the call here surfaces the
			// reason to the reviewer, which can retry instead of losing its finding to
			// a silent discard.
			if (parseAdviseWireInput(args) === undefined) {
				throw new Error(
					`advise: a note, a severity of nit|concern|blocker, and a non-empty findingKey of at most ${MAX_FINDING_KEY_CHARACTERS} characters are required`,
				);
			}
			onAdvise(args);
			return Promise.resolve({ recorded: true });
		},
	};
}

/**
 * The path a call addresses, if any. Both spellings are read because the
 * harness filesystem tools use `file_path` (`read`) and `path` (`grep`/`glob`).
 */
function readPathArgument(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	for (const key of ["file_path", "path"]) {
		const value = record[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

/** Redacts the text blocks of a tool result, leaving non-text blocks untouched. */
function redactContentBlocks(content: readonly ContentBlock[]): ContentBlock[] {
	return content.map((block) => {
		if (typeof block !== "object" || block === null) return block;
		const text = (block as { text?: unknown }).text;
		if (typeof text !== "string") return block;
		const redacted = redactSecrets(text).text;
		return redacted === text ? block : ({ ...block, text: redacted } as ContentBlock);
	});
}

/**
 * Protected-path decision for one pending tool call on a local-path tool.
 *
 * The path is resolved through the SAME host service the tool itself uses
 * (`ctx.fs.resolve`, anchored at the agent's working directory), and judged in
 * the form the tool would open (`processPath`). Judging a path this plugin
 * resolved on its own would let the guard and the tool disagree, which is a
 * silent authorization bypass. Anything unresolvable is denied.
 *
 * `ctx` is the plugin's own context, never the review child's: an agent scope
 * only resolves the services it provisions (its scoped `tools`), so `fs` and
 * `workingDirectory` throw there even though the child's own tools use them.
 * Both take the child agent explicitly, so the data stays agent-scoped.
 */
async function decideProtectedPath(
	ctx: Context,
	policy: ProtectedPathPolicy,
	exec: { readonly name: string; readonly arguments: unknown; readonly signal: AbortSignal },
	agent: Agent,
): Promise<{ kind: "allow" } | { kind: "deny"; reason: string } | { kind: "cancel" }> {
	const requested = readPathArgument(exec.arguments);
	if (requested === undefined) {
		// A read or search without an explicit path scans the whole working
		// directory and can reach the protected files its pattern matches.
		return {
			kind: "deny",
			reason: `dsh-advisor: ${exec.name} needs an explicit path during review`,
		};
	}
	if (exec.signal.aborted) return { kind: "cancel" };
	try {
		const cwd = await ctx.workingDirectory.ensure(agent, exec.signal);
		const target = await ctx.fs.resolve(requested, { cwd, signal: exec.signal });
		const absolutePath = ctx.fs.processPath(target);
		if (exec.signal.aborted) return { kind: "cancel" };
		if (isSearchTool(exec.name) && relative(cwd, absolutePath) === "") {
			// The no-path form above is denied because a search rooted at the working
			// directory reads every hidden file below it. Naming that same directory as
			// `path` must not be the way around the rule; a subdirectory stays allowed.
			return {
				kind: "deny",
				reason: `dsh-advisor: ${exec.name} must name a path below the working directory during review`,
			};
		}
		const allowed = await policy.allowsResolvedPath(absolutePath);
		if (exec.signal.aborted) return { kind: "cancel" };
		return allowed
			? { kind: "allow" }
			: {
					kind: "deny",
					reason: `dsh-advisor: protected path is unreadable during review: ${absolutePath}`,
				};
	} catch (error) {
		// An abort is the call being cancelled, not a path this plugin refused to
		// judge: reporting it as a denial would look like a policy decision.
		if (exec.signal.aborted) return { kind: "cancel" };
		return {
			kind: "deny",
			reason: `dsh-advisor: cannot resolve ${exec.name} target during review: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}

/**
 * Tools that return file CONTENT rather than one addressed file. The host runs
 * them with `--no-ignore --hidden`, so a search rooted at the working directory
 * matches protected files by content even though the root itself is ordinary.
 * Redaction is the second line of defence behind the path guard.
 */
function isSearchTool(name: string): boolean {
	return /(^|__)(grep|glob)$/.test(name);
}

export interface ReviewDeps {
	readonly ctx: Context;
	readonly config: AdvisorConfig;
	/** Working directory the protected-path policy resolves against. */
	readonly cwd: string;
}

function reviewPrompt(request: ReviewRequest): UserMessage {
	return createUserMessage({
		content: [{ type: "text", text: request.prompt }],
		source: { kind: "user" },
	});
}

/**
 * Sums the provider-reported usage of one review child across its steps.
 *
 * The Executor log never records the review child's cost, so the only place it
 * exists is the child's own assembled assistant messages. Steps that died
 * before reporting usage contribute nothing.
 */
function foldReviewUsage(events: readonly SessionEvent[]): {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
} {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	for (const event of events) {
		// Typed rather than probed by string key: a rename upstream then fails the
		// build instead of silently reporting zero tokens for every review.
		if (event.type !== "assistant/message") continue;
		const usage: TokenUsage | undefined = event.data.usage;
		if (usage === undefined) continue;
		inputTokens += usage.inputTokens;
		outputTokens += usage.outputTokens;
		cacheReadTokens += usage.cacheReadTokens ?? 0;
		// Cache writes are a separate billed input component, and the per-review
		// total would under-report a route that charges them.
		cacheWriteTokens += usage.cacheWriteTokens ?? 0;
	}
	return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

/**
 * Runs one review. The wall-clock bound cancels the child: the creation signal
 * is creation-only and cannot abort a live turn, so the timeout is wired to an
 * explicit `cancel` plus disposal.
 */
export async function runReview(
	deps: ReviewDeps,
	executor: Agent,
	request: ReviewRequest,
): Promise<ReviewOutcome> {
	const { ctx, config } = deps;
	const startedAt = Date.now();
	let advice: AcceptedReviewAdvice | undefined;
	let settled = false;
	let readOnlyTools: ReadonlySet<string> = new Set();
	let notify: (() => void) | undefined;
	const advised = new Promise<void>((resolve) => {
		notify = resolve;
	});

	const policy = new ProtectedPathPolicy({
		cwd: deps.cwd,
		security: config.security,
		realpath,
	});

	const sessionId = SessionId(
		`advisor-${createHash("sha256")
			.update(`${executor.id}:${String(request.cursor)}:${String(Date.now())}`)
			.digest("hex")
			.slice(0, 16)}`,
	);

	// The owner's signal and the wall-clock bound are one deadline: disposing the
	// plugin must abort an in-flight review, or it would outlive its owner.
	const timedOut = AbortSignal.timeout(config.review.timeoutMs);
	const owner = request.signal;
	if (owner?.aborted === true) return { kind: "cancelled", reason: "cancelled before start" };
	let cancelledByOwner = false;
	// The owner's signal lives as long as the observer, so this listener has to come
	// off again: `{ once: true }` only removes it when the observer finally aborts.
	const noteOwnerAbort = (): void => {
		cancelledByOwner = true;
	};
	owner?.addEventListener("abort", noteOwnerAbort, { once: true });
	const deadline = owner === undefined ? timedOut : AbortSignal.any([timedOut, owner]);
	let handle: AgentHandle | undefined;
	// Set in `finally`: the abort handler below must not cancel an agent this call
	// already disposed, and its listener has to come off with the review.
	let finished = false;
	let detachAbort = (): void => {};
	/**
	 * Whether the deadline is what ended the race below. The workspace bound
	 * outranks quiescence only when it actually won: `whenIdle()` resolving and
	 * the deadline firing in the same turn leaves `deadline.aborted` true while a
	 * review that completed normally is the one holding the outcome.
	 */
	let deadlineWon = false;
	try {
		handle = await ctx.agents.create({
		sessionId,
		parentAgent: executor,
		meta: childSessionMeta(executor, 1, false),
		...(config.model === undefined
			? {}
			: {
					agentOptions: {
						provider: config.model.provider,
						model: config.model.model,
						...(config.model.reasoningEffort === undefined
							? {}
							: { reasoningEffort: ReasoningEffortId(config.model.reasoningEffort) }),
					},
				}),
		// Creation-only: covers the creation window alone.
		signal: deadline,
		setup: async (childCtx, childAgent) => {
			// The review child must run the Executor's own agent-plane composition.
			// Without it a child created through `agents.create` inherits no preset
			// tools at all: the filesystem tools live on the preset, not in the
			// global layer, so the review would have nothing to read files with.
			await applyChildComposition(childCtx, executor, {});
			const visible = childCtx.tools.schemas(childAgent).map((schema) => schema.name);
			const readOnly = selectReviewReadOnlyTools(visible);
			if (!readOnly.includes("read")) {
				// Rejecting the setup rolls the creation transaction back, so the
				// review reports a clear reason instead of silently reading nothing.
				throw new Error(
					`no read tool visible to the review child; visible tools: ${visible.join(", ")}`,
				);
			}
			readOnlyTools = new Set(readOnly);
			childCtx.tools.restrict({ allow: readOnly });
			childCtx.tools.register(
				createAdviseTool((args) => {
					// First accepted finding wins. A second call must not erase it, and a
					// second, empty call would otherwise turn a real finding into silence.
					if (advice === undefined) advice = acceptAdviseCall(args, config, Date.now());
					settled = true;
					notify?.();
				}),
			);
			// Scope-filtered: this listener sees only the review child's calls, which
			// is exactly the "independent scope" the protected-path rule needs. The
			// counter is per review, so the budget restarts with each attempt.
			let readCalls = 0;
			childCtx.on("tools/pre-execute", async (exec, next) => {
				// `advise` is this review's own output channel, not a file read: it names
				// no path, so only the permit check below applies to it. Running the path
				// rule on it would deny the one call that carries the finding out.
				if (exec.name === REVIEW_TOOL_NAME) return next();
				// Allow-list, not a restriction: `restrict()` only narrows the inherited
				// surface, so agent-scoped registrations (agent-team's `spawn_teammate`,
				// `send_message`, ...) would otherwise stay callable during a review.
				if (!readOnlyTools.has(exec.name)) {
					return {
						kind: "deny",
						reason: `dsh-advisor: ${exec.name} is not permitted during review`,
					};
				}
				readCalls += 1;
				if (readCalls > REVIEW_READ_BUDGET) {
					// A refusal, not a cancellation: the child sees the reason as a failed
					// tool result and concludes with what it already read instead of
					// spending the rest of the deadline opening more files.
					return {
						kind: "deny",
						reason: `dsh-advisor: review read budget exhausted (${REVIEW_READ_BUDGET} reads/searches); conclude now by calling advise, or end without one`,
					};
				}
				const decision = await decideProtectedPath(deps.ctx, policy, exec, childAgent);
				if (decision.kind === "deny") return { kind: "deny", reason: decision.reason };
				if (decision.kind === "cancel") return { kind: "cancel" };
				return next();
			});
			childCtx.on("tools/post-execute", async (exec, result, next) => {
				const decision = await next();
				if (decision.kind !== "accept" || !isSearchTool(exec.name)) return decision;
				const content = decision.content ?? result.content;
				if (!Array.isArray(content)) return decision;
				return { kind: "accept", content: redactContentBlocks(content) };
			});
		},
	});

		const child = handle.agent;
		child.followup(reviewPrompt(request));
		// The creation signal only covers the creation window, so the wall-clock
		// bound needs its own listener to abort a live turn.
		const aborted = new Promise<void>((resolve) => {
			// A deadline already past (a very short timeout, or an owner that aborted
			// during creation) fires no further event, so the listener alone would
			// never resolve — and the race below would wait on `whenIdle()` only.
			const markDeadline = (): void => {
				deadlineWon = true;
				resolve();
			};
			if (deadline.aborted) {
				markDeadline();
				return;
			}
			const onAbort = (): void => markDeadline();
			deadline.addEventListener("abort", onAbort, { once: true });
			detachAbort = (): void => deadline.removeEventListener("abort", onAbort);
		});
		const cancelling = aborted.then(() => {
			if (!finished) child.cancel({ kind: "parent" });
		});
		// The advise call concludes the review; waiting for quiescence afterwards
		// would only let the child keep reading. Disposal below stops it.
		await Promise.race([child.whenIdle(), advised, cancelling]);
		const usage: ReviewUsage = {
			durationMs: Date.now() - startedAt,
			...foldReviewUsage(child.session.snapshotEvents()),
		};
		if (cancelledByOwner) {
			// Teardown cancels the review it owns; that says nothing about whether
			// the review worked, so it outranks both the deadline and a finding the
			// child managed to record while it was being taken down.
			return { kind: "cancelled", reason: "cancelled by owner", usage };
		}
		if (advice !== undefined) {
			// A recorded finding wins over the wall-clock bound: reporting it as a
			// timeout would drop the finding and count a successful review as a
			// failure, even though the model already produced it.
			return { kind: "finding", advice, usage };
		}
		if (deadlineWon) {
			// Reported after the owner check and after a recorded finding: only the
			// wall clock actually deciding the race is a timeout.
			return { kind: "failed", reason: "review timed out", usage };
		}
		if (!settled) {
			// The reviewer made no advise call. Silence is a valid outcome only when the
			// child's turn actually completed: a turn that died on an error or a block
			// never reviewed anything, and reporting it as silence would count a broken
			// review as a successful one.
			const work = foldConsumedWork(child.session.snapshotEvents());
			const reason = work.end?.data.reason;
			if (reason === undefined) {
				// No turn ever closed over the enqueued prompt. A cancel that takes the
				// input before a turn opens leaves no `turn/end` at all, so
				// `droppedUnrun` is the only account of it; neither case is a review.
				return work.droppedUnrun
					? { kind: "cancelled", reason: "review turn was dropped before it ran", usage }
					: { kind: "failed", reason: "review turn never started", usage };
			}
			if (reason.kind === "completed") return { kind: "silent", usage };
			if (reason.kind === "aborted") {
				return { kind: "cancelled", reason: "review turn was interrupted", usage };
			}
			return { kind: "failed", reason: `review turn ended: ${reason.kind}`, usage };
		}
		// The advise call was made and produced nothing usable (a content-free note);
		// a finding would already have been returned above. That is the reviewed model
		// choosing silence, not a broken review, so it must not advance the failure
		// pause.
		return { kind: "silent", usage };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		// The review child may exist by now (a throw after `agents.create`
		// resolved). Its provider-reported cost is real either way, and the port's
		// contract reserves "no usage" for a review that never reached a model.
		const usage: ReviewUsage | undefined =
			handle === undefined
				? undefined
				: { durationMs: Date.now() - startedAt, ...foldReviewUsage(handle.agent.session.snapshotEvents()) };
		// An abort surfaces as a thrown AbortError, and only the owner aborts early
		// enough to throw here — the deadline is reported above.
		return cancelledByOwner ? { kind: "cancelled", reason, ...(usage ?? {}) } : { kind: "failed", reason, ...(usage ?? {}) };
	} finally {
		finished = true;
		detachAbort();
		owner?.removeEventListener("abort", noteOwnerAbort);
		if (handle !== undefined) {
			// cancel aborts an in-flight turn; dispose then stops and drains the driver.
			handle.agent.cancel({ kind: "parent" });
			try {
				await handle.dispose();
			} catch (error) {
				// Teardown runs after the outcome is already decided, so letting it throw
				// would replace an accepted finding with a failure.
				ctx.logger("dsh-advisor").warn(
					`review child disposal failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
}

