/**
 * The advisor state tree, shared by the session sidecars and the page-editable
 * configuration.
 *
 * It lives under `$DSH_HOME` (default `~/.dsh`) rather than the profile: the
 * plugin writes it at runtime, while the profile is the operator's file, and
 * rewriting YAML behind `make set-dsh` would fight the operator.
 *
 * @module dsh-advisor/host/paths
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Directory below the state root that this plugin owns. */
export const ADVISOR_STATE_DIRECTORY = "advisor";

/**
 * Absolute path of the advisor state tree; the stores own the leaf names.
 *
 * `$DSH_HOME` is resolved rather than used verbatim: a `~` or a relative value
 * would otherwise anchor the state tree at a literal `~` directory or at
 * whatever directory the process happens to run in, and the only symptom would
 * be state that silently never comes back.
 */
export function resolveAdvisorStateRoot(): string {
	const home = process.env.DSH_HOME;
	if (home === undefined || home.length === 0) return join(homedir(), ".dsh");
	if (home === "~") return homedir();
	if (home.startsWith("~/")) return resolve(homedir(), home.slice(2));
	return resolve(home);
}
