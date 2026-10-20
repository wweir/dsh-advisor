/**
 * The `/advisor status` surface.
 *
 * Everything this plugin knows about a session — whether a review ran, and why
 * it produced no note — otherwise lives only in the sidecar JSON, so "is it
 * working, and why was it silent?" is answerable only by reading that file.
 * This is the on-demand view of the same state, for the session the command was
 * typed in.
 *
 * @module dsh-advisor/host/status
 */

import type { Agent } from "@deepseek-ai/dsh-agent";

import type { AdvisorConfig } from "../policy/config.ts";
import type { AdviceHoldReason } from "../policy/delivery.ts";
import type { AdvisorConfigView } from "../policy/overrides.ts";
import type { AdvisorStats, NoteRecord, ReviewContextMeta, ReviewRecord } from "../policy/stats.ts";
import { FAILURE_PAUSE_COUNT, type LastReviewOutcome } from "../state.ts";

/** One note handed to a follow-up turn, waiting for a model reply to confirm it. */
export interface AwaitingAdviceStatus {
	readonly severity: string;
	readonly note: string;
	/** Executor turn the note was produced from. */
	readonly turn: number;
}

/**
 * One note handed to the running Executor's `next-step` inbox that no step has
 * admitted yet. The page shows it — content included — so the window between
 * hand-off and admission is visible instead of silent.
 */
export interface InFlightAdviceStatus {
	readonly severity: string;
	/** The delivered note body; this is what already sits in the inbox. */
	readonly note: string;
	/** Executor turn the finding was produced from. */
	readonly turn: number;
	/** Hand-off time (epoch ms), so the page can say how long it has waited. */
	readonly at: number;
}

/** One session's advisor state, as reported by the command. */
export interface AdvisorStatus {
	enabled: boolean;
	model?: AdvisorConfig["model"];
	paused: boolean;
	/** Newest turn the Executor opened; 0 before the first turn was observed. */
	currentTurn: number;
	reviewing: boolean;
	/** Turn number of the last claimed review; 0 when nothing was ever reviewed. */
	lastReviewedTurn: number;
	lastOutcome?: LastReviewOutcome;
	followUpsUsed: number;
	/** Session cap for idle follow-up turns, so the page never hardcodes it. */
	followUpCap: number;
	failureStreak: number;
	lastFailure?: { reason: string; at: number };
	/** Notes produced but not yet handed to the Executor. */
	pending: {
		count: number;
		severities: string[];
		/** Why the head note cannot be handed over right now (undefined = due). */
		hold?: AdviceHoldReason;
	};
	/**
	 * The queued notes themselves, for the page tab. The command's text rendering
	 * keeps to counts: a note can be a paragraph, and a slash-command reply is the
	 * wrong place to dump one.
	 */
	pendingNotes?: readonly { severity: string; note: string; attempted?: boolean }[];
	/**
	 * A note handed to a follow-up turn that has not produced a model reply yet.
	 * It is in neither the queue nor the delivered history until confirmed.
	 */
	awaiting?: {
		readonly count: number;
		readonly severities: string[];
		readonly notes: readonly AwaitingAdviceStatus[];
	};
	/**
	 * Notes already handed to the running Executor's inbox but not yet admitted
	 * to a step. In neither the pending queue nor the delivered history until the
	 * host admits them. In-memory display state: a plugin reload forgets these
	 * rows while the durable inbox still delivers the notes.
	 *
	 * Optional only for a page polling an older host (the client bundle can hot
	 * reload ahead of the host process). A current host always emits it, so an
	 * absent field means "this host predates the field", not "nothing is in
	 * flight".
	 */
	inFlight?: {
		readonly count: number;
		readonly notes: readonly InFlightAdviceStatus[];
	};
	muted: number;
	delivered: number;
	/** Cumulative review accounting (tokens, wall time, outcome counts). */
	stats?: AdvisorStats;
	/** Newest-first bounded review history, for the page tab. */
	recentReviews?: readonly ReviewRecord[];
	/** Newest-first delivered-note history, for the page tab. */
	recentNotes?: readonly NoteRecord[];
	/** Description of the last compiled review prompt (the reviewer's view). */
	lastReviewContext?: ReviewContextMeta;
	/** Effective configuration, rendered as the tab's settings form. */
	config?: AdvisorConfigView;
}

function outcomeText(outcome: LastReviewOutcome | undefined): string {
	if (outcome === undefined) return "unknown (nothing reviewed since the plugin loaded)";
	switch (outcome.kind) {
		case "silent":
			return "no finding (silent)";
		case "finding":
			return `finding severity=${outcome.severity ?? "?"}`;
		case "suppressed":
			return `finding dropped before delivery (${outcome.reason ?? "suppressed"})`;
		case "failed":
			return `failed: ${outcome.reason ?? "unknown error"}`;
		case "cancelled":
			return `cancelled: ${outcome.reason ?? "owner disposed"} — not a failure`;
	}
}

/** How the command line names a hold reason; the page localizes its own copy. */
function holdText(hold: AdviceHoldReason): string {
	switch (hold) {
		case "running":
			return "executor is running, waiting for a step boundary";
		case "followUpOpen":
			return "a follow-up turn is still open";
		case "idleFollowUpRetried":
			return "the last follow-up turn did not process the note, waiting for a running turn";
		case "idleFollowUpCap":
			return "the idle follow-up budget is spent";
		case "newerInstruction":
			return "the user spoke after the note, waiting for a later turn";
		case "idleSeverity":
			return "this severity may not wake an idle executor";
	}
}

/** Compact count for the command line: 1234 -> 1.2K. */
function compactCount(value: number): string {
	return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : String(value);
}

/** Compact wall time: 950ms -> 0.9s, 84s -> 1m24s. */
function reviewDuration(ms: number): string {
	if (ms < 1_000) return `${String(Math.round(ms))}ms`;
	const seconds = Math.round(ms / 1_000);
	return seconds < 60 ? `${String(seconds)}s` : `${String(Math.floor(seconds / 60))}m${String(seconds % 60)}s`;
}

/**
 * Renders the status block. Pure text: the dispatching UI prints it as-is, and
 * the caller decides what to do when a session has no state at all.
 */
export function formatAdvisorStatus(status: AdvisorStatus): string {
	const model =
		status.model === undefined
			? "none"
			: `${status.model.provider}/${status.model.model}${
					status.model.reasoningEffort === undefined ? "" : ` (${status.model.reasoningEffort})`
				}`;
	const lines = [
		`advisor: ${status.enabled ? "enabled" : "disabled"} · model=${model}`,
		`session: turn ${status.currentTurn} · ${status.reviewing ? "review in flight" : "idle"}`,
		`review:  last reviewed turn ${
			status.lastReviewedTurn === 0 ? "never" : status.lastReviewedTurn
		} · ${outcomeText(status.lastOutcome)}`,
		`queue:   pending ${status.pending.count}${
			status.pending.severities.length === 0 ? "" : ` (${status.pending.severities.join(", ")})`
		}${status.pending.hold === undefined ? "" : ` — held: ${holdText(status.pending.hold)}`} · awaiting ${
			status.awaiting?.count ?? 0
		} · in flight ${status.inFlight?.count ?? 0} · muted ${status.muted} · delivered ${
			status.delivered
		} · follow-ups ${status.followUpsUsed}/${status.followUpCap}`,
	];
	const stats = status.stats;
	lines.push(
		`cost:    ${
			stats === undefined || stats.reviews === 0
				? "no completed review yet"
				: `reviews ${String(stats.reviews)} · tokens ${compactCount(stats.inputTokens)} in / ${compactCount(
						stats.outputTokens,
					)} out · cache ${compactCount(stats.cacheReadTokens)} read${
						(stats.cacheWriteTokens ?? 0) > 0 ? ` / ${compactCount(stats.cacheWriteTokens ?? 0)} write` : ""
					} · avg ${reviewDuration(stats.reviewMs / stats.reviews)}`
		}`,
	);
	const context = status.lastReviewContext;
	if (context !== undefined) {
		lines.push(
			`context: ${compactCount(context.promptChars)} chars (~${compactCount(context.estimatedTokens)} tok)${
				context.truncated ? " · earlier work omitted" : " · full projection"
			}`,
		);
	}
	if (status.paused) {
		lines.push(
			`health:  PAUSED after ${status.failureStreak} consecutive failures — reload the plugin to re-arm`,
		);
	} else {
		lines.push(`health:  ${status.failureStreak}/${FAILURE_PAUSE_COUNT} consecutive failures`);
	}
	if (status.lastFailure !== undefined) lines.push(`last failure: ${status.lastFailure.reason}`);
	// The one thing the state cannot show by itself: silence is a result, not an
	// error, and the usual reason a session sees no note at all.
	if (status.lastOutcome?.kind === "silent") {
		lines.push("note: silence is the normal outcome — the reviewer found nothing it could point at.");
	}
	return lines.join("\n");
}

/** The slice of `@deepseek-ai/dsh-commands` this plugin uses. */
export interface CommandRegistry {
	register(definition: {
		name: string;
		description: string;
		recordInput?: boolean;
		handler: (invocation: { agent: Agent; rawInput: string }) => Promise<CommandReply>;
	}): () => void;
}

/** The command reply shapes the dispatching UI renders. */
export type CommandReply = { kind: "success"; text?: string } | { kind: "error"; text: string };

export interface AdvisorStatusCommandDeps {
	/** Resolves the state for the session the command was typed in. */
	readonly describe: (agent: Agent) => Promise<AdvisorStatus | undefined>;
}

/**
 * Registers `/advisor status`. The registry arrives through cordis injection, so
 * a host without the commands surface simply never calls this.
 */
export function registerAdvisorStatus(
	commands: CommandRegistry,
	deps: AdvisorStatusCommandDeps,
): () => void {
	return commands.register({
		name: "advisor",
		description: "Report this session's advisor state: /advisor [status]",
		// The reply is derived state, not an instruction: the session log keeps the
		// lifecycle events without duplicating the rendered text.
		recordInput: false,
		handler: async ({ agent, rawInput }): Promise<CommandReply> => {
			const argument = rawInput.trim();
			// Only `status` exists here. Refusing anything else out loud matters: an
			// older release also accepted `on`/`off`/`model`, so silently answering a
			// status block to `/advisor off` would read as the switch having worked.
			if (argument !== "" && argument !== "status") {
				return {
					kind: "error",
					text: `advisor: only \`/advisor status\` is implemented here (got "${argument}").`,
				};
			}
			const status = await deps.describe(agent);
			if (status === undefined) {
				return {
					kind: "success",
					text: "advisor: no state for this session yet (nothing observed since the plugin loaded).",
				};
			}
			return { kind: "success", text: formatAdvisorStatus(status) };
		},
	});
}
