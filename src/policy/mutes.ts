import {
	containsTerminalControlCharacters,
	REDACTION,
	redactSecrets,
	sanitizeTerminalText,
} from "./redaction.ts";

/**
 * Mute records: the bounded list of findings the user has explicitly silenced.
 *
 * Pure data structure. The host injects the entries it read from the per-session
 * sidecar state and serializes snapshots back out; no file lives here. Mutes are
 * user data and survive review-epoch changes.
 *
 * @module dsh-advisor/policy/mutes
 */

export const MAX_MUTE_ENTRIES = 128;
export const MAX_FINDING_LABEL_CHARACTERS = 128;

export interface RecentFinding {
	/** Full lowercase SHA-256 findingKeyHash. */
	hash: string;
	/** Bounded redacted display label; never used as command input. */
	label: string;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

function boundedText(input: string, maximumCharacters: number): string | undefined {
	const characters = Array.from(input).slice(0, maximumCharacters);
	return characters.length === 0 ? undefined : characters.join("");
}

/**
 * Truncates to the label bound without ever cutting through a `[REDACTED]`
 * marker: when the cut lands inside a marker, the cut moves to the marker
 * start so the whole marker is dropped instead of left partial.
 */
function truncateWithoutCuttingMarker(text: string): string | undefined {
	const characters = Array.from(text);
	if (characters.length <= MAX_FINDING_LABEL_CHARACTERS) return characters.join("");
	let cut = MAX_FINDING_LABEL_CHARACTERS;
	for (let index = Math.max(0, cut - (REDACTION.length - 1)); index < cut; index++) {
		// Compare in code-point space: `cut` and `index` index `characters`, so the
		// marker probe must also be built from `characters` rather than from the
		// UTF-16 offsets that `String.prototype.startsWith` would use.
		if (characters.slice(index, index + REDACTION.length).join("") === REDACTION) {
			cut = index;
			break;
		}
	}
	const result = characters.slice(0, cut).join("");
	return result.length === 0 ? undefined : result;
}

/**
 * Bounds a raw `findingKey` for display: truncate first, redact, and repeat
 * until the result is a redaction fixpoint (redacting it again changes
 * nothing) and at most the fixed 128-character bound. A truncated label can
 * cut through a secret and leave a partial value that redaction restores,
 * and a truncation after redaction can cut through a `[REDACTED]` marker
 * that the next redaction pass re-expands; the fixpoint loop plus
 * marker-safe truncation guarantees the persisted label never changes under
 * redaction, so the strict restore validators never reject it. An empty
 * result means the finding has no usable display label.
 */
export function boundedFindingLabel(input: string): string | undefined {
	// Neutralize terminal control characters before bounding and redaction so a
	// model-authored key can never inject newlines or escape sequences into a
	// rendered message or the persisted mutes; tab, newline, and carriage return
	// become spaces because the label is single-line text.
	const singleLine = sanitizeTerminalText(input).replace(/[\t\n\r]/gu, " ");
	const truncated = boundedText(singleLine.trim(), MAX_FINDING_LABEL_CHARACTERS);
	if (truncated === undefined) return undefined;
	let text = truncated;
	for (let iteration = 0; iteration < 8; iteration++) {
		const redacted = redactSecrets(text).text;
		if (redacted === text) return text;
		const next = truncateWithoutCuttingMarker(redacted);
		if (next === undefined) return undefined;
		text = next;
	}
	// The bounded loop did not converge; discard the label rather than
	// persisting one that redaction would change again.
	return redactSecrets(text).text === text ? text : undefined;
}

interface UnvalidatedRecentFinding {
	hash?: unknown;
	label?: unknown;
}

function isRecentFinding(value: unknown): value is RecentFinding {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const entry = value as UnvalidatedRecentFinding;
	return (
		Object.keys(entry).length === 2 &&
		typeof entry.hash === "string" &&
		HASH_PATTERN.test(entry.hash) &&
		typeof entry.label === "string" &&
		Array.from(entry.label).length > 0 &&
		Array.from(entry.label).length <= MAX_FINDING_LABEL_CHARACTERS &&
		!containsTerminalControlCharacters(entry.label) &&
		redactSecrets(entry.label).text === entry.label
	);
}

/**
 * Validates injected entries and keeps the newest `MAX_MUTE_ENTRIES`.
 *
 * Sidecar state is read back from disk, so mute entries are untrusted input:
 * a label carrying control characters or unredacted key material would be
 * re-persisted and displayed.
 */
function sanitizeEntries(entries: readonly unknown[]): RecentFinding[] {
	const valid = entries.filter((entry) => isRecentFinding(entry)).map((entry) => ({ ...entry }));
	return valid.length > MAX_MUTE_ENTRIES ? valid.slice(valid.length - MAX_MUTE_ENTRIES) : valid;
}

/**
 * Bounded user-scope mute list. Entries are injected by the host and read back
 * as serializable snapshots; persistence is the host's responsibility.
 */
export class MuteStore {
	private entries: RecentFinding[];

	constructor(entries: readonly unknown[] = []) {
		this.entries = sanitizeEntries(entries);
	}

	isMuted(hash: string): boolean {
		return this.entries.some((entry) => entry.hash === hash);
	}

	list(): readonly RecentFinding[] {
		return this.entries.map((entry) => ({ ...entry }));
	}

	replace(entries: readonly unknown[]): void {
		this.entries = sanitizeEntries(entries);
	}
}
