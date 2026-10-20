# Operations

How this plugin is built, deployed, run and diagnosed on a live host. The
contracts it relies on are summarized here; the code is the authority for
behaviour.

## Deploy

The host half is TypeScript compiled to `lib/` (the profile loads
`lib/index.js`); the web half is the hand-written bundle at `client/index.js`.
A profile consumes the package as a bundle:

```bash
pnpm run verify                                    # typecheck + tests + build -> lib/
dsh plugin --profile <profile> add @wweir/dsh-advisor
```

A development checkout is installed as a `link:` dependency, so `lib/` and
`client/index.js` are read straight from the working tree.

### Hot reload of a linked plugin (no restart)

Restarting `dsh web` kills every other session's child processes, so a linked
plugin is redeployed in place:

- **client half** — `@deepseek-ai/dsh-client-hmr` stat-polls each client bundle
  and pushes the rebuilt module to open pages; editing `client/index.js` needs
  no action (a page refresh is enough if the push is missed).
- **host half** — `@deepseek-ai/dsh-hmr` watches the profile's
  `cordis.patch.yml` / `package.json`, but refresh compares file *content*: a
  touch or an identical rewrite is a no-op. Change the content once (for
  example append a newline to `$DSH_HOME/profiles/<profile>/cordis.patch.yml`),
  wait for `reconcileProfile()` to stop the changed row and start it against the
  new files, then restore the file byte-for-byte (back it up first, restore,
  `cmp`/sha256 it). The restore triggers one more harmless reload.

Verification markers for the advisor row: both routes must answer 200 to an
authenticated request, `ActiveEnterTimestamp` must be unchanged, and the served
client bundle must contain the new code. Any route that changes behaviour is
itself a version probe: during the 2026-10-19 deploy,
`/api/advisor/status?sessionId=session-1` answered 400 on the old build and 200
on the new one.

Routing health alone does not prove the row reloaded. A release that changes no
source has byte-identical old and new code, and a reconcile can hand the route
map over without a single failed request (measured: 1137 requests at ~7ms during
a reconcile, none failed). To prove the built entry was re-evaluated, instrument
the gitignored `lib/index.js` to append a marker file on load, reconcile, check
the marker, then restore the tagged build and reconcile again (this is how
v0.1.1's deploy was verified).

Rollback is the same procedure with the previous `lib/` (`pnpm run build` from
the previous commit). A restart remains the fallback when the reconcile does not
run, at the cost of every live session's children.

## State and configuration

- `$DSH_HOME/advisor/` (default `~/.dsh/advisor/`, `DSH_HOME` is resolved so
  `~` and relative values work) holds one JSON sidecar per Executor session plus
  `config.json`, the page-editable override layer.
- The tree is created with mode `0700` and files with `0600`, and an existing
  directory keeps its mode (so `stat` it if permissions matter; `$DSH_HOME` is
  `0700` in practice, which is what keeps a wider child directory unreachable).
  The sidecars carry advice text and mutes, so this boundary is the only
  file-level protection between them and other local users.
- An unreadable sidecar is never overwritten: review and persistence are
  disabled for that one session (reported in the host log) until the file is
  fixed or removed and the plugin reloads.
- An unreadable `config.json` is likewise never overwritten: the store latches
  the failure and refuses page saves, so the operator can repair or delete it
  instead of losing it to the next save.
- Configuration layers, in order: the profile row (operator-owned) → the page
  override (`config.json`, validated with stricter page-side maxima, and a row
  value outside those bounds refuses the save instead of writing a layer the
  next load would discard) → the running reviewer (applied immediately). An
  override that would enable reviewing without a model route is rejected at
  load. Protected paths are row-owned and cannot be changed from the page.
- Upgrading across a configuration change: a `config.json` (or a row) written
  by a release that still carried a retired review key keeps loading — the key
  is ignored, never rejected, so the override layer is not dropped — and the
  next page save rewrites the file from the effective configuration, which no
  longer has it. Values whose meaning changed also keep loading (v0.4's
  `everySteps` is the only cadence: `0` now means no automatic review at all);
  the README's Trigger section is the authority for the current meaning.
- Upgrading the sidecars: v0.3 wrote the step counter and its cursor together,
  so such a sidecar restores both — if the unreviewed gap already reached the
  cadence, the first step boundary after the upgrade is due immediately (the
  work is owed and must not be forgiven). A sidecar from v0.2 or earlier has
  neither field: it restores at zero, so the first review comes after a full
  cadence rather than never.

## Authentication and login boundary

The plugin adds no authentication path of its own: its four HTTP routes
(`/api/advisor/status`, `/api/advisor/context`, `/api/advisor/config`,
`/api/advisor/catalog`) are registered on the host Connection service's exact
Fetch channel, so every request goes through the same gate as `/api`:

1. `/api` prefix handler → `connection.admit(request)` **before** route lookup
   (`dsh-client-connection/lib/index.js`): Host/Origin fence failure → 403;
   missing or invalid credential → 401.
2. The fence: the `Host` header must be loopback, a configured trusted authority
   or the bound address; `Sec-Fetch-Site: cross-site` is rejected; a present
   `Origin` must match the Host authority.
3. Login: `GET /?token=<launch token>` (constant-time compare) returns 303 and
   sets an authority-bound, signed, expiring cookie (30 days by default); the
   same launch token mints API-operator cookies on `/connect`. Exchanging the
   authority part of the Host invalidates the cookie.
4. The shared handler then applies an owner check to exact routes and dispatches.

Verified 2026-10-19 against a live `dsh web` with positive and negative
controls: no cookie → 401; forged cookie → 401; cookie replayed under another
Host authority → 401; foreign Host, `cross-site`, or foreign `Origin` → 403;
same-authority Origin → 200; unauthenticated POST to the config route → 401; a
malformed page patch through a valid session → 400 only after the gate. A
built-in exact route (`/api/file`) answered identically in every arm, which is
the point: the plugin inherits the host's policy instead of re-implementing it.

Other surfaces: `/advisor status` is a command served inside an authenticated
session (no route of its own); the static client bundle is served without a
credential for every plugin alike and contains no secrets; state files are
`0600` under a `0700` tree. Authorization is per Host owner (single-owner
deployment), the same model as the host's own session APIs — the plugin does
not add per-session rules.

The launch token is printed to the process output (journald here) and is the
root of trust for cookies: anyone who can read it or the journal can mint an
owner credential. Treat host log access as equivalent to the web UI's access.

## Troubleshooting

- **Advisor routes return 404 while the row is alive** (sidecars keep being
  written): the row started without registering its routes. Since the claim is
  process-global, check that the running build judges ownership by type (a hot
  reload of a build that used a boolean claim left a `false` tombstone that the
  next build misread as a live owner). Fix, rebuild, and reconcile again.
- **Routes 403/401 unexpectedly**: the Host header or the authority-bound
  cookie does not match the listener (for example probing through `127.0.0.1`
  with a cookie minted for the LAN address). Re-open the URL printed by
  `dsh web`.
- **Review paused after three failures**: a pause holds for the life of the
  loaded plugin; a plugin reload re-arms it, saving the page's configuration
  form does not.
- **No review at all**: check `enabled` and that a model route resolves, then
  `/advisor status` for the last outcome (silence is a result, not an error).

## Release

`package.json` is the version authority and the repo has no release automation,
so a release is explicit steps on `main`:

1. `pnpm run verify` — the gate a consumer's install relies on.
2. Bump `package.json` (for example `pnpm version patch --no-git-tag-version`),
   then commit `chore(release): vX.Y.Z`. Behaviour fixes take a patch bump;
   new configuration or contract surface takes a minor bump.
3. `git tag -a vX.Y.Z -m vX.Y.Z` and push `main` plus the tag.
4. `gh release create vX.Y.Z --title vX.Y.Z --notes …`, deriving the notes from
   the commits since the previous tag (user-visible fixes and contract changes,
   not the file list).
5. Deploy the build to the running host (see Deploy) and check the markers
   there; a release that only exists in git is not verified.

### npm publication (automated, with a one-time bootstrap)

`.github/workflows/publish.yml` publishes the tagged version: a published
GitHub Release (or `gh workflow run publish.yml -f tag=vX.Y.Z`) checks that the
tag matches `package.json`, runs `pnpm run verify`, and runs
`npm publish --provenance --access public`. Authentication is OIDC trusted
publishing — the workflow asks npm to exchange its `id-token` for a
short-lived publish token, so the repository stores no npm credential. A
prerelease version publishes under a dist-tag named after its first identifier
(`0.2.0-alpha.1` → `alpha`) and never overwrites `latest`.

The package bootstrap needed two one-time steps, because npm only grants a
trusted publisher to a package that already exists: the first upload was
authenticated with a short-lived granular access token stored as the
repository secret `NPM_TOKEN`, and the trusted publisher was then added on
npmjs.com → the package → Settings → Trusted publishing (GitHub Actions,
owner `wweir`, repository `dsh-advisor`, workflow `publish.yml`, direct
`npm publish` allowed — publishers created after 2026-09-03 default to
`npm stage publish` only; see <https://docs.npmjs.com/trusted-publishers/>).
That secret has been deleted: the repository stores no npm credential, and
every release authenticates with OIDC alone. A newly added publisher shows
`Pending validation` on npm until the first release published through it
succeeds.

## Gates

`pnpm run verify` is the whole local gate: typecheck (src + tests), the client
bundle's syntax, the test suite and the host build. The workflow installs with
`--frozen-lockfile` on a clean checkout, so dependency build approvals belong in
`pnpm-workspace.yaml` under `allowBuilds` (a mapping); pnpm 12 ignores the older
`onlyBuiltDependencies` list and fails the install on an unapproved script. A
test run says nothing about the full chain: that needs a long-lived app, because
`dsh headless` tears the host down when the turn ends, cancelling a review still
in flight — observe reviews in `dsh web` or any app that stays up.

One coverage gap is known: the review's wall-clock race (`deadlineWon` — a
review that finishes in the same turn the timeout fires) needs a live child
session to reproduce, so it is verified by reasoning and a live redeploy rather
than by a unit test.
