/**
 * Persistence for the page-editable configuration patch.
 *
 * It lives beside the session sidecars (`<stateRoot>/advisor/config.json`) rather
 * than in the profile: the profile row is the operator's file, and rewriting YAML
 * at runtime would fight `make set-dsh` and the GUI's Models page. A missing file
 * means "no overrides"; an unreadable one is reported, not silently replaced,
 * because the next save would otherwise destroy what it still held.
 *
 * @module dsh-advisor/host/config-store
 */

import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";

import { parseConfigPatch, type AdvisorConfigPatch } from "../policy/overrides.ts";
import { ADVISOR_CONFIG_VERSION } from "../policy/config.ts";
import { ADVISOR_STATE_DIRECTORY } from "./paths.ts";

const CONFIG_FILE_NAME = "config.json";

interface PersistedOverrides {
	version: number;
	patch: unknown;
}

export type OverridesLoad =
	| { readonly kind: "missing" }
	| { readonly kind: "present"; readonly patch: AdvisorConfigPatch }
	| { readonly kind: "unreadable"; readonly reason: string };

export class ConfigOverridesStore {
	private readonly directory: string;
	private readonly file: string;
	/**
	 * Set when this process found the file unreadable. The store then refuses to
	 * write over it: otherwise the docstring's promise lived only in a comment,
	 * and the first save from the page destroyed what the file still held.
	 */
	private loadFailed = false;

	constructor(stateRoot: string) {
		this.directory = join(stateRoot, ADVISOR_STATE_DIRECTORY);
		this.file = join(this.directory, CONFIG_FILE_NAME);
	}

	/** Synchronous because the plugin applies its configuration during load. */
	load(): OverridesLoad {
		let raw: string;
		try {
			raw = readFileSync(this.file, "utf8");
		} catch (error) {
			const code = (error as { code?: unknown }).code;
			if (code === "ENOENT") return { kind: "missing" };
			return this.unreadable(error instanceof Error ? error.message : String(error));
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return this.unreadable("not JSON");
		}
		if (typeof parsed !== "object" || parsed === null) return this.unreadable("shape");
		const record = parsed as Partial<PersistedOverrides>;
		if (record.version !== ADVISOR_CONFIG_VERSION) return this.unreadable("version");
		const result = parseConfigPatch(record.patch);
		if (result.kind === "invalid") return this.unreadable(result.error);
		return { kind: "present", patch: result.patch };
	}

	private unreadable(reason: string): OverridesLoad {
		this.loadFailed = true;
		return { kind: "unreadable", reason };
	}

	/**
	 * Atomic write under a file lock: a crash must not leave a half-written patch
	 * in place, and two tabs (or a retried request) saving at once must not
	 * interleave their temporary files into one published document.
	 *
	 * Rejects when this process found the existing file unreadable: the caller
	 * reports the refusal instead of silently discarding what was stored there.
	 */
	async save(patch: AdvisorConfigPatch): Promise<void> {
		if (this.loadFailed) {
			throw new Error(
				"refusing to overwrite an unreadable configuration override file; fix or remove it, then reload the plugin",
			);
		}
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const body = `${JSON.stringify({ version: ADVISOR_CONFIG_VERSION, patch }, null, "\t")}\n`;
		await withFileLock(this.file, async () => {
			await writeFileAtomic(this.file, body, { mode: 0o600, dirMode: 0o700 });
		});
	}
}
