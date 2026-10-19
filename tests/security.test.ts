import { describe, expect, it } from "vitest";
import { homedir } from "node:os";

import {
	ProtectedPathPolicy,
	resolveConfiguredPath,
	type Realpath,
} from "../src/policy/security.ts";

/** No symlinks: every configured path canonicalizes to itself. */
const identityRealpath: Realpath = (path) => Promise.resolve(path);

function policy(additionalProtectedPaths: readonly string[] = []): ProtectedPathPolicy {
	return new ProtectedPathPolicy({
		cwd: "/work",
		security: { additionalProtectedPaths },
		realpath: identityRealpath,
	});
}

async function denies(target: ProtectedPathPolicy, path: string): Promise<boolean> {
	return !(await target.allowsResolvedPath(path));
}

describe("resolveConfiguredPath", () => {
	it("anchors relative configured paths at the working directory", () => {
		expect(resolveConfiguredPath("/work", "secrets")).toBe("/work/secrets");
		expect(resolveConfiguredPath("/work", "/etc/keys")).toBe("/etc/keys");
	});

	it("expands a bare and a leading ~ against the home directory", () => {
		// `os.homedir()` is what the implementation uses; `$HOME` can be unset or
		// disagree with the passwd entry, which would make this fail on a correct
		// implementation.
		const home = homedir();
		expect(resolveConfiguredPath("/work", "~")).toBe(home);
		expect(resolveConfiguredPath("/work", "~/secrets")).toBe(`${home}/secrets`);
	});

	it("rejects ~user expansion instead of anchoring it at the working directory", () => {
		// `~other/private` used to be silently anchored at the cwd, protecting a
		// different path than the operator named.
		expect(() => resolveConfiguredPath("/work", "~other/private")).toThrow(
			new TypeError("protected path must not use ~user expansion"),
		);
	});
});

describe("ProtectedPathPolicy built-in table", () => {
	it("blocks .env variants, standard key names, key extensions and credential files", async () => {
		const target = policy();
		expect(await denies(target, "/work/.env")).toBe(true);
		expect(await denies(target, "/work/.env.local")).toBe(true);
		// `.envrc` (direnv) is covered by the exact-name rule, as is `.env.*`.
		expect(await denies(target, "/work/.envrc")).toBe(true);
		expect(await denies(target, "/work/.env.production")).toBe(true);
		// A private key in the working directory, not only under ~/.ssh.
		expect(await denies(target, "/work/id_rsa")).toBe(true);
		expect(await denies(target, "/work/id_ed25519")).toBe(true);
		expect(await denies(target, "/work/server.pem")).toBe(true);
		expect(await denies(target, "/work/cert.key")).toBe(true);
		expect(await denies(target, "/work/credentials.json")).toBe(true);
	});

	it("blocks files holding plaintext credentials", async () => {
		const target = policy();
		expect(await denies(target, "/home/u/.git-credentials")).toBe(true);
		expect(await denies(target, "/home/u/.netrc")).toBe(true);
		expect(await denies(target, "/home/u/_netrc")).toBe(true);
	});

	it("blocks a key or env file copied with a backup suffix", async () => {
		const target = policy();
		expect(await denies(target, "/work/server.pem.bak")).toBe(true);
		expect(await denies(target, "/work/id_rsa.bak")).toBe(true);
		expect(await denies(target, "/work/server.pem.txt")).toBe(true);
		expect(await denies(target, "/work/id_rsa~")).toBe(true);
		// Repeated suffixes strip one at a time down to the guarded name.
		expect(await denies(target, "/work/server.pem.old.orig")).toBe(true);
		expect(await denies(target, "/work/id_rsa.backup")).toBe(true);
		expect(await denies(target, "/work/.env.bak")).toBe(true);
		expect(await denies(target, "/work/.env.save")).toBe(true);
		// A backup of an ordinary file stays readable.
		expect(await target.allowsResolvedPath("/work/src/index.ts.bak")).toBe(true);
	});

	it("does not over-block ordinary files behind the .env rule", async () => {
		// `.environment.md` is documentation, not dotenv configuration; the old
		// `.env*` prefix hid it.
		const target = policy();
		expect(await target.allowsResolvedPath("/work/.environment.md")).toBe(true);
		expect(await target.allowsResolvedPath("/work/environment.md")).toBe(true);
	});

	it("does not hide ordinary source files behind the key-name rule", async () => {
		// A blanket `id_*` prefix also matched these, leaving the reviewer blind to
		// perfectly ordinary modules; the rule is now the exact key names.
		const target = policy();
		expect(await target.allowsResolvedPath("/work/id_generator.ts")).toBe(true);
		expect(await target.allowsResolvedPath("/work/id_map.ts")).toBe(true);
		expect(await target.allowsResolvedPath("/work/identity.ts")).toBe(true);
	});

	it("blocks a protected directory anywhere in the path", async () => {
		const target = policy();
		expect(await denies(target, "/work/.ssh/config")).toBe(true);
		expect(await denies(target, "/home/u/.aws/credentials")).toBe(true);
		expect(await denies(target, "/home/u/.kube/config")).toBe(true);
		expect(await denies(target, "/home/u/.gnupg/pubring.kbx")).toBe(true);
	});

	it("allows ordinary project paths", async () => {
		const target = policy();
		expect(await target.allowsResolvedPath("/work/src/index.ts")).toBe(true);
		expect(await target.allowsResolvedPath("/work/README.md")).toBe(true);
		// A near-miss must not be caught by a directory rule.
		expect(await target.allowsResolvedPath("/work/.ssh-notes.md")).toBe(true);
	});

	it("matches the protected names regardless of case on every platform", async () => {
		// The same secret spelled `.ENV`, `ID_RSA` or `Server.PEM` is the same file
		// on a case-insensitive filesystem and an obvious rename anywhere else.
		const target = policy();
		expect(await denies(target, "/work/.ENV")).toBe(true);
		expect(await denies(target, "/work/.Env.Local")).toBe(true);
		expect(await denies(target, "/work/ID_RSA")).toBe(true);
		expect(await denies(target, "/work/Server.PEM")).toBe(true);
		expect(await denies(target, "/work/Credentials.JSON")).toBe(true);
		expect(await denies(target, "/work/.Netrc")).toBe(true);
		expect(await denies(target, "/work/secrets.KEY")).toBe(true);
		expect(await denies(target, "/work/.SSH/config")).toBe(true);
		// Ordinary case-insensitive lookalikes stay readable.
		expect(await target.allowsResolvedPath("/work/Identity.ts")).toBe(true);
		expect(await target.allowsResolvedPath("/work/Environment.md")).toBe(true);
	});
});

describe("ProtectedPathPolicy additional paths", () => {
	it("appends configured paths without weakening the built-ins", async () => {
		const target = policy(["secrets", "/var/private"]);
		expect(await denies(target, "/work/secrets/token")).toBe(true);
		expect(await denies(target, "/var/private/x")).toBe(true);
		// An appended prefix that merely starts with a protected name still allowed.
		expect(await target.allowsResolvedPath("/work/secrets-public/readme")).toBe(true);
		// The built-in table is untouched by configuration.
		expect(await denies(target, "/work/.env")).toBe(true);
	});

	it("judges the canonical form of a configured path", async () => {
		// `/work/link` is really `/real/target`, so the configured entry must be
		// compared against the canonical target, not only the written path.
		const realpath: Realpath = (path) =>
			path === "/work/link" ? Promise.resolve("/real/target") : Promise.resolve(path);
		const target = new ProtectedPathPolicy({
			cwd: "/work",
			security: { additionalProtectedPaths: ["link"] },
			realpath,
		});
		expect(await target.allowsResolvedPath("/real/target/file")).toBe(false);
	});

	it("walks up to the closest existing ancestor when the configured path does not exist yet", async () => {
		// The common case in production: the protected path is created later, so
		// realpath rejects it and the canonical form is the existing ancestor plus
		// the missing tail. Without that walk the entry would protect nothing.
		const realpath: Realpath = (path) =>
			path === "/work/link" ? Promise.resolve("/real/target") : Promise.reject(new Error("ENOENT"));
		const target = new ProtectedPathPolicy({
			cwd: "/work",
			security: { additionalProtectedPaths: ["link/missing"] },
			realpath,
		});
		expect(await target.allowsResolvedPath("/real/target/missing/file")).toBe(false);
	});

	it("protects the home rules through a symlinked home directory", async () => {
		// `/home/u` is really `/var/home/u`: the candidates are already realpath'd,
		// so comparing them against the written home left those rules inert.
		const realpath: Realpath = (path) =>
			Promise.resolve(path === "/home/u" ? "/var/home/u" : path);
		const target = new ProtectedPathPolicy({
			cwd: "/work",
			security: { additionalProtectedPaths: [] },
			realpath,
			home: "/home/u",
		});
		expect(await denies(target, "/var/home/u/.docker/config.json")).toBe(true);
		expect(await denies(target, "/var/home/u/.config/gcloud/credentials.db")).toBe(true);
	});
});
