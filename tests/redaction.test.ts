import { describe, expect, it } from "vitest";

import {
	containsTerminalControlCharacters,
	estimateTokens,
	redactSecrets,
	sanitizeTerminalText,
} from "../src/policy/redaction.ts";

const KEY_MATERIAL = "MIIEowIBAAKCAQEAxQ4m0Xk2nQ0v".repeat(6);

describe("redactSecrets", () => {
	it("redacts URL credentials without dropping the @ separator or the host", () => {
		expect(redactSecrets("connect https://alice:s3cr3tpw@example.com/path now")).toEqual({
			text: "connect https://alice:[REDACTED]@example.com/path now",
			redactions: 1,
		});
		expect(redactSecrets("http://user:p%40ss@example.com/x").text).toBe(
			"http://user:[REDACTED]@example.com/x",
		);
	});

	it("redacts every credential-bearing URL in one pass", () => {
		const result = redactSecrets("https://a:pw1@x https://b:pw2@y");
		expect(result).toEqual({
			text: "https://a:[REDACTED]@x https://b:[REDACTED]@y",
			redactions: 2,
		});
	});

	it("leaves a URL without credentials untouched", () => {
		expect(redactSecrets("see https://example.com/path")).toEqual({
			text: "see https://example.com/path",
			redactions: 0,
		});
	});

	it("redacts an unterminated private key block through the end of input", () => {
		const result = redactSecrets(`before\n-----BEGIN RSA PRIVATE KEY-----\n${KEY_MATERIAL}`);
		expect(result.text).toBe("before\n[REDACTED]");
		expect(result.redactions).toBe(1);
		expect(result.text).not.toContain("MIIEow");
	});

	it("redacts an unterminated OPENSSH key block even when it is the whole input", () => {
		expect(redactSecrets(`-----BEGIN OPENSSH PRIVATE KEY-----\n${KEY_MATERIAL}`)).toEqual({
			text: "[REDACTED]",
			redactions: 1,
		});
	});

	it("redacts a terminated key block only, keeping surrounding text", () => {
		const result = redactSecrets(
			`before -----BEGIN RSA PRIVATE KEY-----\n${KEY_MATERIAL}\n-----END RSA PRIVATE KEY----- after`,
		);
		expect(result).toEqual({ text: "before [REDACTED] after", redactions: 1 });
	});

	it("redacts bearer tokens and environment assignments", () => {
		expect(redactSecrets("Authorization: Bearer abcdefghijkl")).toEqual({
			text: "Authorization: Bearer [REDACTED]",
			redactions: 1,
		});
		const assignment = redactSecrets("API_KEY=top-secret-value tail");
		expect(assignment.text).toBe("API_KEY=[REDACTED]");
		expect(assignment.text).not.toContain("top-secret-value");
		expect(assignment.redactions).toBeGreaterThanOrEqual(1);
	});

	it("is idempotent on already-redacted text", () => {
		for (const input of [
			"connect https://alice:s3cr3tpw@example.com/path now",
			`-----BEGIN RSA PRIVATE KEY-----\n${KEY_MATERIAL}`,
		]) {
			const once = redactSecrets(input).text;
			expect(redactSecrets(once).text).toBe(once);
		}
	});
});

describe("redactSecrets credential probes", () => {
	const JWT =
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

	it("redacts inline passwords for any URI scheme", () => {
		expect(redactSecrets("postgres://app:sup3rsecr3t@db.internal:5432/app")).toEqual({
			text: "postgres://app:[REDACTED]@db.internal:5432/app",
			redactions: 1,
		});
		expect(redactSecrets("redis://:hunter2pass@cache:6379/0")).toEqual({
			text: "redis://:[REDACTED]@cache:6379/0",
			redactions: 1,
		});
		// A password may itself contain `@`; stopping at the first one left the rest
		// of it on the wire.
		expect(redactSecrets("postgres://app:p@ss@db.internal/app").text).toBe(
			"postgres://app:[REDACTED]@db.internal/app",
		);
		// Two URIs on one line must not swallow each other.
		expect(redactSecrets("redis://:pw1@a postgres://u:pw2@b").text).toBe(
			"redis://:[REDACTED]@a postgres://u:[REDACTED]@b",
		);
	});

	it("keeps the Basic and Token schemes when redacting authorization headers", () => {
		expect(redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA==")).toEqual({
			text: "Authorization: Basic [REDACTED]",
			redactions: 1,
		});
		expect(redactSecrets("Authorization: Token abcdefghijkl")).toEqual({
			text: "Authorization: Token [REDACTED]",
			redactions: 1,
		});
	});

	it("redacts quoted credential values", () => {
		const secretKey = redactSecrets('secret_key = "abc123456789"');
		expect(secretKey.text).toContain("secret_key = [REDACTED");
		expect(secretKey.text).not.toContain("abc123456789");
		expect(secretKey.redactions).toBeGreaterThanOrEqual(1);

		const token = redactSecrets(`"token":"${JWT}"`);
		expect(token.text).toContain('"token":[REDACTED');
		expect(token.text).not.toContain(JWT);
		expect(token.redactions).toBeGreaterThanOrEqual(1);
	});

	it("redacts unquoted credential values to the end of the line", () => {
		expect(redactSecrets("password = correct horse battery staple")).toEqual({
			text: "password = [REDACTED]",
			redactions: 1,
		});
		expect(redactSecrets("password=abc")).toEqual({
			text: "password=[REDACTED]",
			redactions: 1,
		});
		expect(
			redactSecrets("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
		).toEqual({
			text: "aws_secret_access_key = [REDACTED]",
			redactions: 1,
		});
	});

	it("redacts a complete PGP private key block", () => {
		const block = [
			"-----BEGIN PGP PRIVATE KEY BLOCK-----",
			"",
			"lQOYBGexamplekeymaterial",
			"-----END PGP PRIVATE KEY BLOCK-----",
		].join("\n");
		expect(redactSecrets(`before\n${block}\nafter`)).toEqual({
			text: "before\n[REDACTED]\nafter",
			redactions: 1,
		});
	});

	it("redacts a CLI flag spelling of a credential name", () => {
		// `--password=…` is the most common real spelling, and the lookbehind used
		// to reject the `-` in front of the keyword.
		expect(redactSecrets("mysql -u root --password=hunter2 db")).toEqual({
			text: "mysql -u root --password=[REDACTED] db",
			redactions: 1,
		});
		expect(redactSecrets("--api-key=abc123")).toEqual({
			text: "--api-key=[REDACTED]",
			redactions: 1,
		});
	});

	it("does not redact ordinary identifiers or metadata", () => {
		for (const input of [
			"const monkey = 3;",
			'publicKey: "ssh-ed25519 AAAA"',
			"See .environment.md for the runtime environment.",
			"apiVersion: v1",
		]) {
			expect(redactSecrets(input)).toEqual({ text: input, redactions: 0 });
		}
	});
});

describe("estimateTokens", () => {
	it("counts non-ASCII text at roughly one token per character", () => {
		// A Chinese review projection is ~4x what a `length / 4` estimate claims,
		// which is what let it overflow `maxContextTokens` in production.
		const chinese = "这是一个需要审查的中文工作记录";
		expect(estimateTokens(chinese)).toBe(Array.from(chinese).length);
		expect(estimateTokens(chinese)).toBeGreaterThan(Math.ceil(chinese.length / 4));
	});

	it("keeps the four-characters-per-token estimate for ASCII", () => {
		expect(estimateTokens("abcdefgh")).toBe(2);
		expect(estimateTokens("")).toBe(0);
	});

	it("counts astral characters once, not per UTF-16 code unit", () => {
		expect(estimateTokens("🙂🙂")).toBe(2);
	});
});

describe("terminal control sanitization", () => {
	it("replaces C0/C1 control characters but keeps tab and newline", () => {
		expect(sanitizeTerminalText("a\x1b[31mb\x07")).toBe("a\uFFFD[31mb\uFFFD");
		expect(sanitizeTerminalText("a\tb\nc")).toBe("a\tb\nc");
		expect(sanitizeTerminalText("x\x9by")).toBe("x\uFFFDy");
	});

	it("detects control characters, including tab and newline, for single-line fields", () => {
		expect(containsTerminalControlCharacters("a\nb")).toBe(true);
		expect(containsTerminalControlCharacters("a\tb")).toBe(true);
		expect(containsTerminalControlCharacters("a b")).toBe(false);
		expect(containsTerminalControlCharacters("a\u001bb")).toBe(true);
	});
});
