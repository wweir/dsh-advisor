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

Verification markers for the advisor row (no restart required): both routes
must answer 200 to an authenticated request, `ActiveEnterTimestamp` must be
unchanged, and the served client bundle must contain the new code. Any route
that changes behaviour is itself a version probe: during the 2026-10-19 deploy,
`/api/advisor/status?sessionId=session-1` answered 400 on the old build and 200
on the new one.

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

## Gates

`pnpm run verify` plus `node --check client/index.js` (see the README's
Verification section). A test run says nothing about the full chain: that needs
a long-lived app, because `dsh headless` tears the host down when the turn ends
and a review started at turn end is cancelled there — observe reviews in
`dsh web` or any app that stays up.

One coverage gap is known: the review's wall-clock race (`deadlineWon` — a
review that finishes in the same turn the timeout fires) needs a live child
session to reproduce, so it is verified by reasoning and a live redeploy rather
than by a unit test.
