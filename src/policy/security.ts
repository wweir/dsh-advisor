/**
 * Protected-path policy for the review subagent's read-only tools.
 *
 * The policy judges a path the host has ALREADY resolved, never a raw
 * model-supplied string: dsh resolves tool paths through `ctx.fs.resolve`
 * (whose backend may normalize, realpath, or map a remote namespace), so a
 * second, independent resolver here would let the guard judge one target while
 * the tool reads another. That divergence is a silent authorization bypass.
 * The only paths this module expands itself are the configured
 * `additionalProtectedPaths`, which never come from the model.
 *
 * @module dsh-advisor/policy/security
 */

import { homedir } from "node:os";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";

import type { AdvisorSecurityConfig } from "./config.ts";

const BLOCKED_DIRECTORY_NAMES = new Set([
	".ssh",
	".gnupg",
	".aws",
	".azure",
	".kube",
	"private-keys-v1.d",
]);
const BLOCKED_FILE_NAMES = new Set([
	".npmrc",
	".pypirc",
	".credentials",
	"credentials.json",
	"auth.json",
	"docker-config.json",
	"login data",
	"keychain-db",
	// Plaintext tokens and passwords, not references to them: a leaked
	// `.git-credentials`, `.netrc` or `_netrc` is directly usable.
	".git-credentials",
	".netrc",
	"_netrc",
	// Standard private key names, so a key copied into the working directory
	// (rather than left under `~/.ssh`) is still unreadable. Matched exactly:
	// a blanket `id_*` prefix also hides ordinary source files such as
	// `id_generator.ts` from the reviewer.
	"id_rsa",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
	"id_xmss",
]);
const BLOCKED_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".jks"];

const BACKUP_SUFFIXES = [".bak", ".old", ".orig", ".save", ".backup", ".txt", "~"];

/** Strips trailing copy suffixes so `server.pem.bak` still reads as `.pem`. */
function stripBackupSuffixes(fileName: string): string {
	let stripped = fileName;
	for (;;) {
		const suffix = BACKUP_SUFFIXES.find((candidate) => stripped.endsWith(candidate));
		if (suffix === undefined || stripped.length === suffix.length) return stripped;
		stripped = stripped.slice(0, -suffix.length);
	}
}

/** Home-relative protected paths, derived once per policy instead of per check. */
function blockedHomePaths(home: string): string[] {
	return [
		resolve(home, ".config", "gcloud"),
		resolve(home, ".docker", "config.json"),
		resolve(home, ".ssh"),
	];
}

/**
 * Resolve one path through symlinks. Implementations reject when the path does
 * not exist; {@link canonicalize} then walks up to the closest existing
 * ancestor. Used only for configured entries, never for model input.
 */
export type Realpath = (path: string) => Promise<string>;

/** Expands `~` in a configured path and anchors it against the working directory. */
export function resolveConfiguredPath(cwd: string, inputPath: string): string {
	let normalized = inputPath;
	if (normalized === "~") normalized = homedir();
	else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
	// `~user` cannot be expanded from the current user's home, and anchoring it
	// at the working directory would silently protect a different path.
	else if (normalized.startsWith("~")) {
		throw new TypeError("protected path must not use ~user expansion");
	}
	return resolve(cwd, normalized);
}

function comparePath(path: string): string {
	const normalized = normalize(path);
	return process.platform === "win32" || process.platform === "darwin"
		? normalized.toLocaleLowerCase("en-US")
		: normalized;
}

function isWithin(candidate: string, root: string): boolean {
	const comparedCandidate = comparePath(candidate);
	const comparedRoot = comparePath(root);
	const rootPrefix = comparedRoot.endsWith(sep) ? comparedRoot : `${comparedRoot}${sep}`;
	return comparedCandidate === comparedRoot || comparedCandidate.startsWith(rootPrefix);
}

async function canonicalize(path: string, realpath: Realpath): Promise<string> {
	let current = path;
	const suffix: string[] = [];
	for (;;) {
		try {
			const existing = await realpath(current);
			return resolve(existing, ...suffix.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return path;
			suffix.push(basename(current));
			current = parent;
		}
	}
}

function hasBlockedDefault(path: string, homePaths: readonly string[]): boolean {
	const comparable = comparePath(path);
	const parts = comparable.split(sep).filter(Boolean);
	const fileName = parts.at(-1) ?? "";
	// The name rules are case-folded on every platform, not just the ones with a
	// case-insensitive filesystem: the guarded names are ASCII credentials whose
	// uppercase spelling (`.ENV`, `ID_RSA`, `Server.PEM`) is the same secret, and
	// a Linux-only guard let exactly that spelling through.
	// Copy suffixes are stripped before the name and extension rules: a key
	// renamed `server.pem.bak`, `id_rsa.bak` or `id_rsa~` is still that key.
	const name = stripBackupSuffixes(fileName).toLowerCase();
	// `.env`, `.envrc` and `.env.*` hold secrets. Unlike the previous `.env*`
	// prefix this keeps ordinary files such as `.environment.md` readable.
	if (name === ".env" || name === ".envrc" || name.startsWith(".env.")) return true;
	if (BLOCKED_FILE_NAMES.has(name)) return true;
	if (BLOCKED_EXTENSIONS.some((extension) => name.endsWith(extension))) return true;
	if (parts.some((part) => BLOCKED_DIRECTORY_NAMES.has(part.toLowerCase()))) return true;
	return homePaths.some((protectedPath) => isWithin(path, protectedPath));
}

export interface ProtectedPathPolicyOptions {
	readonly cwd: string;
	readonly security: AdvisorSecurityConfig;
	readonly realpath: Realpath;
	/** Home directory the built-in rules are anchored at; defaults to `os.homedir()`. */
	readonly home?: string;
}

export class ProtectedPathPolicy {
	private readonly additional: string[];
	private readonly additionalTargets: Promise<string[]>;
	private readonly homePaths: string[];
	/** Canonical form of the home directory, added once it resolves. */
	private readonly canonicalHome: Promise<string[]>;

	constructor(options: ProtectedPathPolicyOptions) {
		this.additional = options.security.additionalProtectedPaths.map((path) =>
			resolveConfiguredPath(options.cwd, path),
		);
		this.additionalTargets = Promise.all(
			this.additional.map((path) => canonicalize(path, options.realpath)),
		);
		const home = options.home ?? homedir();
		// The candidates this policy judges are already realpath'd, so a home
		// reached through a symlink (`/home` -> `/var/home`) would never compare
		// equal to the written form and those rules would silently protect nothing.
		this.homePaths = [...new Set(blockedHomePaths(home).map((path) => comparePath(path)))];
		this.canonicalHome = canonicalize(home, options.realpath).then(
			(canonical) => blockedHomePaths(canonical).map((path) => comparePath(path)),
			() => [],
		);
	}

	/**
	 * Whether one already-resolved absolute path may be read during review.
	 * Configured entries are checked in both their written and canonical form so
	 * a symlinked configuration still protects its target.
	 */
	async allowsResolvedPath(absolutePath: string): Promise<boolean> {
		const [additionalTargets, canonicalHome] = await Promise.all([
			this.additionalTargets,
			this.canonicalHome,
		]);
		const homePaths = canonicalHome.reduce(
			(paths, path) => (paths.includes(path) ? paths : [...paths, path]),
			this.homePaths,
		);
		return !(
			hasBlockedDefault(absolutePath, homePaths) ||
			this.additional.some(
				(protectedPath, index) =>
					isWithin(absolutePath, protectedPath) ||
					isWithin(absolutePath, additionalTargets[index] ?? protectedPath),
			)
		);
	}
}
