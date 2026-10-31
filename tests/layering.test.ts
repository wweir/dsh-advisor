import { readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The dependency direction the host half is built on: `policy/` is a sink
 * (pure logic, no host or entry-point imports and no runtime dsh dependency),
 * `host/` may use `policy/` and the port/state core, and `index.ts` is the only
 * place that wires them together. Nothing enforced this before, so a review
 * round could add the wrong edge and only a reader would notice.
 */
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

interface ImportedName {
	readonly specifier: string;
	readonly typeOnly: boolean;
}

/** Every `import … from "x"` / `export … from "x"` / `import "x"` in a module. */
function importsOf(source: string): ImportedName[] {
	const imported: ImportedName[] = [];
	for (const match of source.matchAll(/(?:^|\n)\s*(import|export)\s+([^;]*?)\s*from\s*"([^"]+)"/g)) {
		const clause = match[2] ?? "";
		imported.push({ specifier: match[3] ?? "", typeOnly: clause.trimStart().startsWith("type ") });
	}
	for (const match of source.matchAll(/(?:^|\n)\s*import\s*"([^"]+)"/g)) {
		imported.push({ specifier: match[1] ?? "", typeOnly: false });
	}
	return imported;
}

/** Layer violations in one module, relative to the source root (`policy/x.ts`). */
function violationsOf(relativePath: string, source: string): string[] {
	const violations: string[] = [];
	const inPolicy = relativePath.startsWith("policy/");
	for (const { specifier, typeOnly } of importsOf(source)) {
		if (inPolicy && specifier.startsWith(".")) {
			const resolved = posix.normalize(posix.join(posix.dirname(relativePath), specifier));
			if (!resolved.startsWith("policy/")) {
				violations.push(`${relativePath} imports ${specifier} (policy may only import itself)`);
			}
		}
		if (inPolicy && specifier.startsWith("@deepseek-ai/") && !typeOnly) {
			violations.push(`${relativePath} value-imports ${specifier} (policy takes host types only)`);
		}
		if (relativePath !== "index.ts" && /(^|\/)index\.ts$/.test(specifier)) {
			violations.push(`${relativePath} imports the entry point ${specifier}`);
		}
	}
	return violations;
}

function sourceFiles(directory: string, prefix = ""): { path: string; source: string }[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) return sourceFiles(join(directory, entry.name), relativePath);
		if (!entry.name.endsWith(".ts")) return [];
		return [{ path: relativePath, source: readFileSync(join(directory, entry.name), "utf8") }];
	});
}

describe("layering", () => {
	it("keeps the source tree inside the declared dependency direction", () => {
		const files = sourceFiles(SRC);
		// Without this the scan could pass by finding nothing to scan.
		expect(files.map((file) => file.path)).toEqual(
			expect.arrayContaining(["index.ts", "host/review.ts", "policy/advice.ts"]),
		);
		const violations = files.flatMap(({ path, source }) => violationsOf(path, source));
		expect(violations).toEqual([]);
	});

	it("flags a policy module that reaches into the host layer", () => {
		expect(violationsOf("policy/prompt.ts", 'import { paths } from "../host/paths.ts";')).toEqual([
			'policy/prompt.ts imports ../host/paths.ts (policy may only import itself)',
		]);
	});

	it("flags a policy module that takes a runtime dsh dependency and allows the type import", () => {
		expect(violationsOf("policy/transcript.ts", 'import { SessionEvent } from "@deepseek-ai/dsh-session";')).toEqual([
			'policy/transcript.ts value-imports @deepseek-ai/dsh-session (policy takes host types only)',
		]);
		expect(violationsOf("policy/transcript.ts", 'import type { SessionEvent } from "@deepseek-ai/dsh-session";')).toEqual(
			[],
		);
	});
});
