/**
 * Redaction for untrusted model-authored and log-bound text.
 *
 * Two surfaces use this: the transcript lines a review reads (tool output can
 * contain a connection string) and the advice notes delivered into the
 * Executor's conversation. Both reach a model and a log, so a credential that
 * survives here is a live secret, not a cosmetic leak.
 *
 * @module dsh-advisor/policy/redaction
 */

export interface RedactionResult {
	text: string;
	redactions: number;
}

export const REDACTION = "[REDACTED]";

/**
 * Credential-shaped assignment names. The keyword has to start a token (start of
 * text, or after `_`/`-`) so `monkey` and `publicKey` do not match, and the name
 * need not be immediately followed by the separator.
 */
const CREDENTIAL_NAME = String.raw`(?:[A-Za-z0-9]+[_-])*(?:keys?|tokens?|secrets?|passwords?|passwd|credentials?)`;

const PATTERNS: RegExp[] = [
	/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY(?: BLOCK)?-----/g,
	// Unterminated key block (e.g. truncated text): redact from the opener to end of input rather
	// than leaving raw key material that the paired pattern above cannot match.
	/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY(?: BLOCK)?-----[\s\S]*/g,
	// `Authorization:` schemes that carry a credential. The scheme is preserved.
	/\b((?:Bearer|Basic|Token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
	/\b(?:sk|pk|api|key|token)-[A-Za-z0-9_-]{12,}\b/g,
	/\b(?:ghp|github_pat|glpat|xox[baprs]|AKIA|ASIA)[A-Za-z0-9_-]{8,}\b/g,
	// Quoted values of credential-shaped names (`api_key`, `secret_key`,
	// `AWS_SECRET_ACCESS_KEY`, `"token"`, `db_password`, `--password="..."`).
	new RegExp(
		String.raw`(?<![A-Za-z0-9_])(["']?${CREDENTIAL_NAME}["']?\s*[:=]\s*)(["'])((?:\\.|(?!\2)[^\\\r\n])*)\2`,
		"gi",
	),
	// A shell/config line that starts with the credential name: its value is the rest of the
	// line, because a passphrase contains spaces. Anchoring to the line boundary keeps a secret
	// mentioned mid-sentence from deleting the rest of that sentence (advice notes are prose).
	new RegExp(
		String.raw`(^[ \t]*(?:[-*][ \t]+)?(?:[$>#][ \t]+)?${CREDENTIAL_NAME}(?:["']?[ \t]*[:=][ \t]*))([^\r\n]+)`,
		"gim",
	),
	// An inline (prose or JSON) unquoted value: one token. The lookbehind allows a
	// preceding `-` so a CLI spelling (`--password=hunter2`, the most common real
	// one) matches, while `monkey` and `publicKey` stay unmatched because the
	// keyword's own `[A-Za-z0-9]+` prefix consumes their tail. `[` is excluded so
	// the marker this module writes is never re-matched, which the label's
	// redaction fixpoint depends on.
	new RegExp(
		String.raw`(?<![A-Za-z0-9_])(["']?${CREDENTIAL_NAME}["']?\s*[:=]\s*)[^\s,;"'}\[\]()]+`,
		"gi",
	),
	// Any URI scheme with an inline password (`postgres://`, `redis://:pw@`, `amqp://`, ...).
	// The password runs to the LAST `@` of the whitespace-delimited token, because it may
	// itself contain `@` (`postgres://u:p@ss@host`); stopping at the first one would leave
	// `ss` visible. The trailing `@` stays outside the match, and the greedy tail never
	// crosses whitespace, so two URIs on one line cannot swallow each other.
	/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:)[^\s@]*(?:@[^\s@]*)*(?=@)/gi,
];

export function redactSecrets(input: string): RedactionResult {
	let text = input;
	let redactions = 0;
	for (const pattern of PATTERNS) {
		text = text.replace(pattern, (match: string, ...groups: unknown[]) => {
			redactions++;
			const prefix = typeof groups[0] === "string" ? groups[0] : undefined;
			if (prefix !== undefined && match.startsWith(prefix)) return `${prefix}${REDACTION}`;
			return REDACTION;
		});
	}
	return { text, redactions };
}

/**
 * Replaces terminal control characters (C0 including ESC and DEL, and C1)
 * with U+FFFD so untrusted model-authored text cannot inject escape
 * sequences into the terminal; tab and newline are kept for multi-line
 * advice text. Use {@link containsTerminalControlCharacters} when single-line
 * text must reject tab and newline too.
 */
export function sanitizeTerminalText(input: string): string {
	let output = "";
	for (const character of input) {
		const codePoint = character.codePointAt(0) ?? 0;
		const allowedWhitespace = codePoint === 0x9 || codePoint === 0xa;
		const control = codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
		output += allowedWhitespace || !control ? character : "\uFFFD";
	}
	return output;
}

/** True when the text contains any terminal control character, including tab, newline, and carriage return. */
export function containsTerminalControlCharacters(input: string): boolean {
	return Array.from(input).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
	});
}

export function estimateTokens(text: string): number {
	// Four characters per token is an English average. Non-ASCII scripts (CJK,
	// Cyrillic, emoji) run close to one token per character, so dividing their
	// length by four undercounts by ~4x and lets a projection overflow the token
	// budget it was bounded against.
	let tokens = 0;
	for (const character of text) {
		tokens += (character.codePointAt(0) ?? 0) < 0x80 ? 0.25 : 1;
	}
	return Math.ceil(tokens);
}
