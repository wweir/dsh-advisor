/**
 * The `advise` wire contract, its parsing, bounding, deduplication and the
 * delivery rendering. One review produces either silence or a single note.
 *
 * @module dsh-advisor/policy/advice
 */

import { createHash } from "node:crypto";

import type { AdvisorConfig } from "./config.ts";
import { boundedFindingLabel } from "./mutes.ts";
import { redactSecrets, sanitizeTerminalText } from "./redaction.ts";

export type AdviceSeverity = "nit" | "concern" | "blocker";

const ADVICE_SEVERITIES = ["nit", "concern", "blocker"] as const;

const SEVERITY_RANK = { nit: 0, concern: 1, blocker: 2 } satisfies Record<AdviceSeverity, number>;

/**
 * Upper bound on the raw `findingKey`. Enforced by {@link parseAdviseWireInput},
 * not by the wire schema: the tool schema subset the host validates has no
 * `maxLength` keyword, so a longer key reaches the parser instead of being
 * rejected at the boundary.
 */
export const MAX_FINDING_KEY_CHARACTERS = 200;

const TRUNCATION_MARKER = "\n[Advisory note truncated to configured limit]";

/**
 * Wire schema for the `advise` tool. It is deliberately closed and total: the
 * review subagent either produces a well-formed finding or produces nothing,
 * so there is no lenient variant to parse afterwards.
 */
export const ADVISE_WIRE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["note", "severity", "findingKey"],
	properties: {
		note: {
			type: "string",
			description: "Concise rationale for the finding, plus the concrete evidence it rests on.",
		},
		severity: {
			type: "string",
			enum: [...ADVICE_SEVERITIES],
			description: "nit is a polish detail, concern is a real defect, blocker stops the work.",
		},
		findingKey: {
			type: "string",
			description:
				"Canonical identity for exactly one concrete underlying defect. Reuse it for paraphrases or severity changes of that defect; never reuse it for a materially different defect.",
		},
	},
} as const;

export interface AdviseWireInput {
	note: string;
	severity: AdviceSeverity;
	findingKey: string;
}

export interface AcceptedReviewAdvice {
	intent: "review";
	note: string;
	severity: AdviceSeverity;
	/** Bounded, redacted display label. Never interpreted as input. */
	findingKey: string;
	findingKeyHash: string;
	createdAt: number;
	signature: bigint;
}

export function isAdviceSeverity<T>(value: T): value is T & AdviceSeverity {
	return value === "nit" || value === "concern" || value === "blocker";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural check for the tool arguments. The host validates them against
 * {@link ADVISE_WIRE_SCHEMA} first; this narrows the parsed value and rejects
 * anything that slipped through.
 */
export function parseAdviseWireInput(input: unknown): AdviseWireInput | undefined {
	if (!isPlainRecord(input)) return undefined;
	const { note, severity, findingKey } = input;
	if (typeof note !== "string" || note.trim().length === 0) return undefined;
	if (!isAdviceSeverity(severity)) return undefined;
	if (typeof findingKey !== "string" || findingKey.trim().length === 0) return undefined;
	if (Array.from(findingKey).length > MAX_FINDING_KEY_CHARACTERS) return undefined;
	return { note, severity, findingKey };
}

/**
 * Fold prose for dedupe comparison while preserving code spans verbatim, so
 * that a reworded sentence compares equal but a changed identifier does not.
 * Returns undefined when code spans are unbalanced, in which case the caller
 * falls back to whitespace folding only.
 */
function foldProseCaseOutsideCodeSpans(input: string): string | undefined {
	const foldProse = (value: string): string =>
		value.toLocaleLowerCase("en-US").replace(/\s+/g, " ");
	let output = "";
	let cursor = 0;
	while (cursor < input.length) {
		const openingStart = input.indexOf("`", cursor);
		if (openingStart === -1) return `${output}${foldProse(input.slice(cursor))}`;
		output += foldProse(input.slice(cursor, openingStart));
		let openingEnd = openingStart;
		while (input[openingEnd] === "`") openingEnd++;
		const delimiterLength = openingEnd - openingStart;
		let search = openingEnd;
		let closingEnd = -1;
		while (search < input.length) {
			const candidateStart = input.indexOf("`", search);
			if (candidateStart === -1) break;
			let candidateEnd = candidateStart;
			while (input[candidateEnd] === "`") candidateEnd++;
			if (candidateEnd - candidateStart === delimiterLength) {
				closingEnd = candidateEnd;
				break;
			}
			search = candidateEnd;
		}
		if (closingEnd === -1) return undefined;
		output += input.slice(openingStart, closingEnd);
		cursor = closingEnd;
	}
	return output;
}

function normalizeAdviceForDedupe(input: string): string {
	const normalized = input.normalize("NFKC");
	const caseFolded = foldProseCaseOutsideCodeSpans(normalized);
	if (caseFolded === undefined) return normalized.replace(/\s+/g, " ").trim();
	return caseFolded
		.trim()
		.replace(/(?<=\S)[.,;:?!…]+$/gu, "")
		.trim();
}

/** Semantic identity of a finding: the normalized `findingKey`, hashed. */
export function findingKeyHash(input: string): string {
	return createHash("sha256")
		.update(`review-finding:${normalizeAdviceForDedupe(input)}`)
		.digest("hex");
}

/** 64-bit SimHash over normalized-note tokens; identical notes hash identically. */
export function noteSignature(input: string): bigint {
	const tokens = normalizeAdviceForDedupe(input)
		.split(/\s+/u)
		.filter((token) => token.length > 0);
	const weights = new Int32Array(64);
	for (const token of tokens) {
		const value = createHash("sha256").update(`note-token:${token}`).digest().readBigUInt64BE(0);
		for (let bit = 0; bit < 64; bit++) {
			const current = weights[bit] ?? 0;
			weights[bit] = current + ((value & (1n << BigInt(bit))) === 0n ? -1 : 1);
		}
	}
	let signature = 0n;
	for (let bit = 0; bit < 64; bit++) {
		// `noUncheckedIndexedAccess` widens a typed-array read to `number | undefined`
		// even though 0..63 is always in range, so the default keeps the arithmetic
		// honest without a non-null assertion.
		if ((weights[bit] ?? 0) > 0) signature |= 1n << BigInt(bit);
	}
	return signature;
}

export function hammingDistance64(left: bigint, right: bigint): number {
	let difference = left ^ right;
	let distance = 0;
	while (difference !== 0n) {
		difference &= difference - 1n;
		distance++;
	}
	return distance;
}

export function noteSimilarity(left: bigint, right: bigint): number {
	return 1 - hammingDistance64(left, right) / 64;
}

function isStrictlyHigherSeverity(candidate: AdviceSeverity, baseline: AdviceSeverity): boolean {
	return SEVERITY_RANK[candidate] > SEVERITY_RANK[baseline];
}

export type AdviceDedupeTag = "possible-duplicate" | "re-raised";

export type DedupeDecision =
	| { outcome: "suppress" }
	| { outcome: "deliver"; tag?: AdviceDedupeTag };

export interface DedupePolicy {
	/** Below this SimHash similarity a reworded note may deliver again. */
	similarityRedeliveryThreshold: number;
	/** Turns that must pass before a strictly higher severity may deliver again. */
	reRaiseMinTurns: number;
}

interface DedupeEntry {
	severity: AdviceSeverity;
	signature: bigint;
	lastDeliveryTurn: number;
}

export interface PersistedDedupeEntry {
	hash: string;
	severity: AdviceSeverity;
	/** 16 lowercase hex characters encoding the 64-bit SimHash signature. */
	signature: string;
	lastDeliveryTurn: number;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const SIGNATURE_PATTERN = /^[a-f0-9]{16}$/u;

/**
 * Insertion-ordered table of delivered findings. Entries are recorded only
 * after delivery succeeded, so a queue that drops or a review that is
 * superseded never suppresses the finding on its next attempt.
 */
export class BoundedAdviceDedupe {
	private readonly entries = new Map<string, DedupeEntry>();

	constructor(readonly capacity = 4_096) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new RangeError("Advice dedupe capacity must be a positive integer");
		}
	}

	decide(
		advice: Pick<AcceptedReviewAdvice, "findingKeyHash" | "severity" | "signature">,
		turnNumber: number,
		policy: DedupePolicy,
	): DedupeDecision {
		const entry = this.entries.get(advice.findingKeyHash);
		if (entry === undefined) return { outcome: "deliver" };
		if (
			policy.reRaiseMinTurns > 0 &&
			isStrictlyHigherSeverity(advice.severity, entry.severity) &&
			turnNumber - entry.lastDeliveryTurn >= policy.reRaiseMinTurns
		) {
			return { outcome: "deliver", tag: "re-raised" };
		}
		if (
			policy.similarityRedeliveryThreshold > 0 &&
			noteSimilarity(advice.signature, entry.signature) < policy.similarityRedeliveryThreshold
		) {
			return { outcome: "deliver", tag: "possible-duplicate" };
		}
		return { outcome: "suppress" };
	}

	/**
	 * Withdraws a delivery that never reached the model, so the next review can
	 * raise the same finding again.
	 *
	 * A steering message can be discarded before the step that would have carried
	 * it (the owner cancels the turn). Recording it as delivered at hand-off is
	 * what keeps a merely queued note from suppressing itself, but it must not
	 * outlive the queue entry: the finding was never read, so it is still new.
	 *
	 * @param findingKeyHash - identity of the finding whose delivery to withdraw.
	 * @param turnNumber - turn the delivery was recorded against.
	 * @returns whether an entry for exactly that turn was removed.
	 */
	withdraw(findingKeyHash: string, turnNumber: number): boolean {
		const existing = this.entries.get(findingKeyHash);
		// A later delivery of the same key owns the entry now: withdrawing on behalf
		// of the discarded one would erase evidence a newer review already delivered.
		if (existing === undefined || existing.lastDeliveryTurn !== turnNumber) return false;
		this.entries.delete(findingKeyHash);
		return true;
	}

	/** Records a delivered finding. Returns false when the key was already known. */
	add(
		advice: Pick<AcceptedReviewAdvice, "findingKeyHash" | "severity" | "signature">,
		turnNumber: number,
	): boolean {
		const existing = this.entries.get(advice.findingKeyHash);
		if (existing !== undefined) {
			existing.severity = isStrictlyHigherSeverity(advice.severity, existing.severity)
				? advice.severity
				: existing.severity;
			existing.signature = advice.signature;
			existing.lastDeliveryTurn = turnNumber;
			return false;
		}
		this.entries.set(advice.findingKeyHash, {
			severity: advice.severity,
			signature: advice.signature,
			lastDeliveryTurn: turnNumber,
		});
		if (this.entries.size > this.capacity) {
			for (const oldest of this.entries.keys()) {
				this.entries.delete(oldest);
				break;
			}
		}
		return true;
	}

	/**
	 * Bounded export of the delivered findings, oldest-inserted first. A key that
	 * was re-delivered keeps its original position: `add` updates the entry in
	 * place, so insertion order is first-delivery order.
	 */
	exportNewestEntries(maximum: number): PersistedDedupeEntry[] {
		if (!Number.isInteger(maximum) || maximum < 0) {
			throw new RangeError("Advice dedupe export bound must be a non-negative integer");
		}
		const newest: PersistedDedupeEntry[] = [];
		for (const [hash, entry] of [...this.entries].reverse()) {
			if (newest.length === maximum) break;
			newest.push({
				hash,
				severity: entry.severity,
				signature: entry.signature.toString(16).padStart(16, "0"),
				lastDeliveryTurn: entry.lastDeliveryTurn,
			});
		}
		return newest.reverse();
	}

	/** Skips entries that do not round-trip rather than failing the whole load. */
	restoreEntries(entries: readonly unknown[]): void {
		for (const entry of entries) {
			if (!isPersistedDedupeEntry(entry) || this.entries.has(entry.hash)) continue;
			this.entries.set(entry.hash, {
				severity: entry.severity,
				signature: BigInt(`0x${entry.signature}`),
				lastDeliveryTurn: entry.lastDeliveryTurn,
			});
			if (this.entries.size > this.capacity) {
				for (const oldest of this.entries.keys()) {
					this.entries.delete(oldest);
					break;
				}
			}
		}
	}

	get size(): number {
		return this.entries.size;
	}
}

/**
 * Whether one persisted entry round-trips. `lastDeliveryTurn` may legitimately
 * be 0: a note steered into an executor that is running before its first
 * `turn/start` has no turn number to record yet.
 */
function isPersistedDedupeEntry(value: unknown): value is PersistedDedupeEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Partial<PersistedDedupeEntry>;
	return (
		typeof entry.hash === "string" &&
		HASH_PATTERN.test(entry.hash) &&
		isAdviceSeverity(entry.severity) &&
		typeof entry.signature === "string" &&
		SIGNATURE_PATTERN.test(entry.signature) &&
		typeof entry.lastDeliveryTurn === "number" &&
		Number.isSafeInteger(entry.lastDeliveryTurn) &&
		entry.lastDeliveryTurn >= 0
	);
}

/** Notes that say nothing: a review that produces one of these should be silent. */
const CONTENT_FREE = new Set([
	"stop",
	"done",
	"complete",
	"ok",
	"lgtm",
	"looks good",
	"all good",
	"no issue",
	"no issues",
	"no concerns",
	"nothing to add",
	"nothing to report",
	"continue",
	"on track",
	"y",
]);

// The note is normalized to single spaces before this test, so `placeholder 1`,
// `placeholder-1` and `placeholder_1` all arrive in the spaced form.
const PLACEHOLDER_ONLY_NOTE = /^placeholder(?:[\s_-]*\d+)?$/u;

function normalizeContentFreeAdvice(input: string): string {
	return input
		.normalize("NFKC")
		.toLocaleLowerCase("en-US")
		.replace(/[\p{P}\p{S}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function isContentFreeAdvice(note: string): boolean {
	const normalized = normalizeContentFreeAdvice(note);
	return (
		normalized.length === 0 || CONTENT_FREE.has(normalized) || PLACEHOLDER_ONLY_NOTE.test(normalized)
	);
}

/** Bounds a note by code points, leaving the truncation marker inside the budget. */
export function truncateAdviceNote(note: string, maximumCharacters: number): string {
	const marker = Array.from(TRUNCATION_MARKER);
	// A budget too small for the full marker still has to say "cut": an empty or
	// silently shortened note would read as the reviewer's whole finding.
	const fitted = marker.length < maximumCharacters ? marker : ["…"];
	const output: string[] = [];
	for (const character of note) {
		if (output.length + fitted.length >= maximumCharacters) break;
		output.push(character);
	}
	return `${output.join("")}${fitted.join("")}`;
}

function boundAdviceNote(note: string, maximumCharacters: number): string {
	// The note reaches the Executor's message and whatever renders it, so control
	// characters are neutralised before redaction and bounding, exactly as the
	// finding label does with its own untrusted text.
	const safeNote = redactSecrets(sanitizeTerminalText(note)).text;
	if (Array.from(safeNote).length <= maximumCharacters) return safeNote;
	return truncateAdviceNote(safeNote, maximumCharacters);
}

export interface AcceptReviewAdviceInput {
	note: string;
	severity: AdviceSeverity;
	findingKey: string;
}

export interface AcceptReviewAdviceContext {
	maxAdviceChars: number;
	now: number;
}

export function acceptReviewAdvice(
	input: AcceptReviewAdviceInput,
	context: AcceptReviewAdviceContext,
): AcceptedReviewAdvice {
	return {
		intent: "review",
		note: boundAdviceNote(input.note, context.maxAdviceChars),
		severity: input.severity,
		findingKey: boundedFindingLabel(input.findingKey) ?? "",
		findingKeyHash: findingKeyHash(input.findingKey),
		signature: noteSignature(input.note),
		createdAt: context.now,
	};
}

export type AdviceDelivery = "active" | "deferred";

function escapeXmlText(input: string): string {
	return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeXmlAttribute(input: string): string {
	return escapeXmlText(input).replaceAll('"', "&quot;");
}

/**
 * Renders the delivered note. The guidance line tells the executor to weigh the
 * note rather than obey it, and a stale note asks for re-verification first.
 */
export function formatAdviceForDelivery(
	advice: AcceptedReviewAdvice,
	delivery: AdviceDelivery,
	stale: boolean,
	tag?: AdviceDedupeTag,
): string {
	const guidance = stale
		? "Verify this still applies, then weigh it rather than obeying blindly."
		: "Weigh this rather than obeying blindly.";
	const attributes = [
		`intent="review"`,
		`severity="${escapeXmlAttribute(advice.severity)}"`,
		`delivery="${escapeXmlAttribute(delivery)}"`,
		`stale="${escapeXmlAttribute(String(stale))}"`,
		...(tag === undefined ? [] : [`tag="${escapeXmlAttribute(tag)}"`]),
	];
	return `<advisor-note ${attributes.join(" ")}>\n<note>${escapeXmlText(advice.note)}</note>\n<guidance>${escapeXmlText(guidance)}</guidance>\n</advisor-note>`;
}

/** Host `notice` summaries are not localized and are capped at this length. */
const NOTICE_SUMMARY_MAX_CHARS = 120;

const SEVERITY_NOTICE_LABEL = {
	nit: "细节",
	concern: "关注",
	blocker: "阻断",
} as const satisfies Record<AdviceSeverity, string>;

const TAG_NOTICE_LABEL = {
	"possible-duplicate": "可能重复",
	"re-raised": "再次提出",
} as const satisfies Record<AdviceDedupeTag, string>;

/**
 * One-line account for the collapsed chat row. The host shows a `notice`
 * summary verbatim, so severity and staleness have to be in this string.
 * The model-facing note stays in {@link formatAdviceForDelivery}.
 */
export function adviceNoticeSummary(
	advice: AcceptedReviewAdvice,
	stale: boolean,
	tag?: AdviceDedupeTag,
): string {
	const line = advice.note.replaceAll(/[\t\r\n]+/gu, " ").replaceAll(/ {2,}/gu, " ").trim();
	const prefix = [
		SEVERITY_NOTICE_LABEL[advice.severity],
		stale ? "可能已过期" : "仍适用",
		...(tag === undefined ? [] : [TAG_NOTICE_LABEL[tag]]),
	].join(" · ");
	const summary = line.length === 0 ? prefix : `${prefix} · ${line}`;
	// Counted in code points: a UTF-16 slice can cut a surrogate pair and leave a
	// lone half in the host notice.
	const characters = Array.from(summary);
	return characters.length <= NOTICE_SUMMARY_MAX_CHARS
		? summary
		: `${characters.slice(0, NOTICE_SUMMARY_MAX_CHARS - 1).join("")}…`;
}

/**
 * Accepts one `advise` tool call from the review subagent. Returns the accepted
 * advice, or undefined when the call is well-formed but says nothing.
 */
export function acceptAdviseCall(
	args: unknown,
	config: AdvisorConfig,
	now: number,
): AcceptedReviewAdvice | undefined {
	const parsed = parseAdviseWireInput(args);
	if (parsed === undefined) return undefined;
	if (isContentFreeAdvice(parsed.note)) return undefined;
	return acceptReviewAdvice(parsed, { maxAdviceChars: config.review.maxAdviceChars, now });
}
