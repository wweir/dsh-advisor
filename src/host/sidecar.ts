/**
 * Per-session sidecar state. The Executor's session log rejects unknown event
 * types, so advisor state lives in its own file keyed by Executor session id
 * rather than in the log; a log written by a host without this plugin would
 * otherwise be unreadable.
 *
 * @module dsh-advisor/host/sidecar
 */

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";

import { ADVISOR_STATE_VERSION, type PersistedAdvisorState, type SidecarLoad } from "../port.ts";
import { ADVISOR_STATE_DIRECTORY } from "./paths.ts";

export class SidecarStore {
	private readonly directory: string;

	constructor(stateRoot: string) {
		this.directory = join(stateRoot, ADVISOR_STATE_DIRECTORY);
	}

	private pathFor(sessionId: string): string {
		// The session id is a path segment, so anything that could escape the
		// directory is encoded rather than trusted.
		return join(this.directory, `${encodeURIComponent(sessionId)}.json`);
	}

	/**
	 * Distinguishes "no state yet" from "state present but unusable". Treating a
	 * corrupt file as absence lets the next write replace it with empty tables,
	 * destroying whatever the stored state still held.
	 */
	async load(sessionId: string): Promise<SidecarLoad> {
		let raw: string;
		try {
			raw = await readFile(this.pathFor(sessionId), "utf8");
		} catch (error) {
			const code = (error as { code?: unknown }).code;
			if (code === "ENOENT") return { kind: "missing" };
			return { kind: "unreadable", reason: error instanceof Error ? error.message : String(error) };
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!isPersistedAdvisorState(parsed)) return { kind: "unreadable", reason: "shape" };
			return { kind: "present", state: parsed };
		} catch {
			return { kind: "unreadable", reason: "not JSON" };
		}
	}

	async save(sessionId: string, state: PersistedAdvisorState): Promise<void> {
		const path = this.pathFor(sessionId);
		// Created before the writer runs, so it must already carry the private mode:
		// the directory is the boundary that keeps the findings (and the config file
		// beside them) out of other users' reach.
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await withFileLock(path, async () => {
			await writeFileAtomic(path, JSON.stringify(state, null, "\t"), {
				mode: 0o600,
				dirMode: 0o700,
			});
		});
	}
}

function isPersistedAdvisorState(value: unknown): value is PersistedAdvisorState {
	if (typeof value !== "object" || value === null) return false;
	const state = value as Partial<PersistedAdvisorState>;
	return (
		state.version === ADVISOR_STATE_VERSION &&
		typeof state.cursor === "number" &&
		typeof state.lastReviewedTurn === "number" &&
		typeof state.followUpsUsed === "number" &&
		typeof state.failureStreak === "number" &&
		// Every list `restore` iterates has to be present: a missing one would throw
		// inside the runtime, and that rejection escapes the session observer.
		Array.isArray(state.dedupe) &&
		Array.isArray(state.mutes) &&
		Array.isArray(state.pending)
	);
}
