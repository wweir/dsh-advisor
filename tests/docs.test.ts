import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The long-lived documents are a fact source a reader follows, so a link that no
 * longer resolves is a defect rather than a typo. Short-term plans and reviews
 * are not listed: they are deleted rather than maintained.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCUMENTS = ["README.md", "README.zh.md", "docs/DECISIONS.md", "docs/OPERATIONS.md"];

describe("documentation", () => {
	it("resolves every relative link", () => {
		const broken: string[] = [];
		for (const document of DOCUMENTS) {
			const text = readFileSync(join(ROOT, document), "utf8");
			for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
				const target = match[1] ?? "";
				if (/^(?:https?:|mailto:|#)/.test(target)) continue;
				const path = resolve(dirname(join(ROOT, document)), target.split("#")[0] ?? "");
				if (!statSync(path, { throwIfNoEntry: false })) broken.push(`${document}: ${target}`);
			}
		}
		expect(broken).toEqual([]);
	});
});
