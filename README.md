# @wweir/dsh-advisor

English | [简体中文](README.zh.md)

An automatic second opinion for DeepSeek Harness sessions.

On a configurable per-round rhythm, a **restricted sub-agent** re-reads the
Executor's recent work with read-only tools. Concrete defects are recorded
and delivered to the Executor's inbox; when there is nothing to point
at, the reviewer stays silent — silence is the normal outcome, not a failure.

The plugin never runs its own model loop: the review is a real child session,
so the host's turn/step machine, tool pipeline, streaming, cancellation and
persistence apply to it unchanged.

## What it does for you

- **Catches hallucinations.** The reviewer reads the actual files (read-only):
  changes claimed but not made, APIs that do not exist, values never written.
  The note points at the mismatch while the work is fresh; delivery is
  advisory, interrupting only as configured.
- **Keeps sessions on track.** At most one review every N completed rounds
  (default 3), never concurrently — rounds arriving mid-review coalesce into a
  single catch-up. Drift is reported inside the running turn; idle sessions
  can be woken by severe findings (budgeted, severity-gated). Silence is
  reported as a result, not an error.
- **Bounded cost.** The reviewer's context is a compiled projection capped at
  32K tokens by default (≈ **25% of a 128K window**), never a copy of the
  Executor's. A stable instruction prefix lets the provider's context cache
  hit across reviews (cache-read tokens are shown in the tab and billed at
  cache rates). Output is a single advice of at most 2K characters.

## Why

Most advisor plugins hand the transcript to one extra LLM call and inject
whatever comes back. This plugin makes the reviewer a **real child session with
its own read-only tools**, which buys four concrete things:

- **It verifies instead of guessing.** The reviewer opens the files the
  Executor actually touched, so a note points at a defect it looked at — not
  a pattern inferred from a transcript summary, which is all a
  transcript-only reviewer can ever offer.
- **The host's rules apply to the review itself.** Turn/step accounting, the
  tool pipeline, streaming, cancellation, persistence, and a real audit
  trail: the review is a session you can inspect, and its cost is reported
  usage, not an estimate.
- **Isolation is enforced, not promised.** One reviewer claim per process, a
  read-only tool surface, a protected-path guard deliberately stricter than
  the upstream advisor (workspace-root private keys and `.envrc` included),
  and no shared context with the Executor.
- **Delivery is accounted.** A note counts as delivered only when the host
  proves it was processed (a follow-up turn's model reply); an unconfirmed
  note is requeued, never silently dropped. Repetition is suppressed by
  finding identity plus similarity, with hash-based mutes.

## Screenshots

The **Advisor** tab in the web GUI (synthetic session data, collapsible
sections expanded):

![Advisor tab, dark theme](https://raw.githubusercontent.com/wweir/dsh-advisor/main/docs/screenshots/tab-dark.jpg)

Light theme follows the host, and a failure pause is visible in the tab instead
of hidden in a log:

| Light theme | Paused after repeated failures |
| --- | --- |
| ![Advisor tab, light theme](https://raw.githubusercontent.com/wweir/dsh-advisor/main/docs/screenshots/tab-light.jpg) | ![Advisor tab, paused after failures](https://raw.githubusercontent.com/wweir/dsh-advisor/main/docs/screenshots/tab-paused.jpg) |

## Install

The package is a Cordis plugin (`dsh.bundle.patch` → `cordis.patch.yml`), so it
installs like any other profile bundle:

```bash
dsh plugin --profile <profile> add @wweir/dsh-advisor
```

Then give it a model route. It is **disabled until a model is configured**, and
it never falls back to the Executor's model:

```yaml
- id: advisor
  name: '@wweir/dsh-advisor'
  config:
    enabled: true
    model:
      provider: opencode-go
      model: glm-5.3-flash
      reasoningEffort: low
    instructions: ''            # extra review instructions, appended to the prompt
    review:
      everyTurns: 3             # minimum completed rounds between two reviews
      timeoutMs: 180000         # wall-clock bound for one review
      maxContextTokens: 32000   # material sent to the reviewer
      maxAdviceChars: 2000      # one advice body
      maxPending: 32            # queued, not-yet-delivered notes
    delivery:
      activeIdleSeverities: [concern, blocker]   # severities allowed to wake an idle Executor
    security:
      additionalProtectedPaths: []      # extra paths the reviewer may never read
```

A patch entry is **replaced, not merged**, per row id: an overlay that sets
only the extra instructions drops the model route, and the row stops loading —
loudly, with a validation error.

## Behaviour worth knowing

- **Trigger** — one review *round*: the Executor's final answer, or, for a
  turn that closes without one, the end of a top-level turn that completes,
  hits its token limit, or errors. Rounds are the unit because a reader can
  keep steering into a running turn: that turn never ends, and a turn-based
  trigger would never fire even though every reply was a completed round.
  Sub-agent sessions (including the review children) are never reviewed.
  Turns this plugin opened itself are never reviewed either.
- **Delivery** — while the Executor is running the note is handed into the
  next step boundary; while it is idle the note may open an exclusive turn,
  but only for a severity allowed to wake an idle session (by default
  concern and blocker), at most 5 times per session; anything else waits for
  a later flush. A note delivered into a running turn is recorded as
  delivered once the host accepts it. A note that opened an exclusive turn is
  recorded **only after that turn emits a model reply**: the hand-off alone
  does not prove the note was read, so a turn that closes (restart,
  interrupt, empty turn) without a reply puts the note back in the queue,
  marked as already attempted — it will not open a second follow-up turn, but
  the next running turn can still receive it. The confirmation is persisted
  immediately, and an unconfirmed claim found in the sidecar on load is
  requeued the same way. A delivered finding is suppressed by identity, so a
  reworded repeat is not re-delivered.
- **Failure pause** — three consecutive *real* failures (model error, timeout,
  bad tool surface) pause automatic review. Cancellations are counted separately:
  they are recorded but never pause. A pause holds for the life of the loaded
  plugin; **a plugin reload (a profile-row change or a process restart) clears
  the tripwire** and re-arms review. Saving the page's configuration form is not
  a reload and leaves a paused advisor paused.
- **State** — one JSON sidecar per Executor session under
  `$DSH_HOME/advisor/` (default `~/.dsh/advisor/`). It holds the review
  cursor, the dedupe table, the pending queue, the mute list, and the failure
  accounting as diagnostics. A file that does not parse is never overwritten
  and is reported in the host log.
- **Mutes** — add `{ "hash": "<64-hex hash of the finding>", "label": "..." }`
  to the sidecar's `mutes` list. Identity is the full hash; there is no
  prefix matching.
- **Page surface** — the web client shows an **Advisor** tab beside
  Chat/Trajectory/Host. It reads the same state as `/advisor status` over the
  same authenticated channel as the GUI itself (browser session cookie and
  Host/Origin fence apply) and
  refreshes every few seconds, so a paused advisor and the reason for the last
  silence are visible without typing a command. Presentation is one injected
  stylesheet over DSH theme tokens, so light/dark, focus, hover and touch sizing
  follow the host; sections are headings inside labelled regions, and the polled
  state is mirrored in a polite live region for screen readers. Its queue block
  is the delivery surface, ordered by what the reader acts on: the live figures
  first (pending notes with the reason the head note is **held** — executor
  running, severity not allowed to wake an idle session, follow-up budget spent,
  a previous attempt went unprocessed, a newer instruction arrived — and notes
  **awaiting confirmation** after a follow-up hand-off), then one muted line of
  cumulative figures that shows only what the session actually counted (delivered,
  muted, and idle follow-ups the session spent, with the host-reported budget
  beside them; a budget never used is not a figure worth drawing). An empty
  queue says so in a sentence instead of
  drawing a row of zeros. It also
  carries the per-session review accounting that no log records, likewise one
  idea per line: the prompt volume the reviewer read with the share served from
  cache, the output figure, the run count with its average wall time, and only
  the outcomes that actually occurred — plus bounded newest-first histories of
  reviews and delivered notices. It
  also edits the common configuration —
  the on/off switch, the model route, the review cadence and budgets, the
  idle-delivery severities and the extra review instructions — and saving
  applies it to the running reviewer immediately. The config row stays the
  default; page edits are persisted as an override layer, validated with
  stricter page-side maxima than the loader schema (which bounds only the lower
  end); the protected-path settings stay owned by the config row, and a row
  value too large for the page's bounds refuses the save instead of writing an
  override layer the next load would discard.
  Provider, model and reasoning level are **linked
  dropdowns** fed by the host's live model registry (the same source the GUI
  model picker reads): picking a provider points the model at its first entry,
  and the level list is the selected model's advertised levels — "Default"
  stays available, and a configured value the registry does not advertise
  stays representable so the form can round-trip it. A model that advertises
  only levels this plugin cannot offer shows "Default" alone rather than the
  static list; a model whose entry carries no level metadata at all still
  falls back to it.
  The level belongs to the route rather than standing alone: with no provider
  or model picked its control is inert and reads "Default", since a config
  without a model route would drop it. A host whose model registry cannot be
  listed leaves the form with the free-text provider/model inputs it
  had before. Either way the form refuses the saves that would lie: a
  half-filled route, "clear the route" (which the page cannot express, because
  a config without a model route keeps the row's route), and enabling reviews
  with no route at all — the host checks that invariant on the merged
  configuration, so a page save would otherwise report success on a config that
  reviews nothing. The numeric fields are validated against the same bounds locally —
  both ends — so an emptied box or an over-large value is reported on its own
  field instead of coming back as a host path string.
- **Compiled review context** — the reviewer model does not read the
  Executor's own context but a line projection bounded to 32K tokens by
  default. The session block therefore reports two facts about it: how large
  that prompt was, and whether earlier work had to be omitted. The page has no
  prompt viewer — the segment preview the tab used to carry was interaction
  noise for a diagnostic that is rarely read — but `GET
  /api/advisor/context?sessionId=…` still serves the full prompt on demand.
- **Status surface** — `/advisor [status]` reports the invoking session's own
  state: the effective route, the current turn, whether a review is in
  flight, the last reviewed turn and **why it produced no note** (silent,
  suppressed as muted or already delivered, failed, or cancelled), the
  pending queue with its severities and the reason the head note is held, the
  notes awaiting follow-up confirmation, the follow-up budget, and the
  failure accounting. Silence is reported as a result, not as an error,
  because "the reviewer found nothing it could point at" and "the plugin is
  not running" are otherwise indistinguishable. Only the status question
  exists here; the on/off/model/config verbs carried over from older releases
  are refused with an explicit error rather than answered, so an old habit
  cannot read as success.

## Presentation of a delivered note

A review note is delivered as a chat notice attributed to the advisor.
Delivered while the Executor runs, it renders as a collapsed context row
that already carries the one-line summary
(`关注 · 仍适用 · …`). Delivered while the Executor is idle it wakes a turn, so
the chat draws its **turn-trigger card** — and upstream that card has no
advisor branch: it falls back to a generic "Execution requested" title and
shows no summary, leaving the note invisible until clicked.

The local client patch `~/.wweir/bin/dsh-patch-advisor-note` (re-applied by
`~/.wweir/bin/dsh-install`) adds the missing branch to the vendored chat
bundle: the card says 「二审提醒」/ "Advisor review", shows the recorded
severity and summary on the collapsed row, and renders the note text itself
when expanded. It is a vendored file edit, so a DSH upgrade drops it until
`dsh-install` runs again.

## Verification

```bash
pnpm run verify   # typecheck (src + tests), the test suite, and the host build
pnpm run build    # tsc: src/ -> lib/, which is what a linked profile loads
```

The package follows the DSH plugin shape: the host entry is `lib/index.js` (built
from `src/index.ts`), the web half is the hand-written bundle at
`client/index.js`, and `dsh.bundle.patch` points at `cordis.patch.yml`. A linked
profile picks up a client edit on refresh; a host-half edit is picked up by a
hot reconcile as well when the profile patch's content changes (verified
2026-10-19 against the running `dsh web`: touching `profiles/web/cordis.patch.yml`
reloaded the advisor row, new `lib/` included, with no restart) — a restart is
only the fallback if that reconcile does not run.

Tests cover the pure policy layer plus the runtime driven through a fake port
(17 files). The full chain needs a **long-lived** app: `dsh headless` tears
the host down as soon as the turn ends, so a review started at turn end is
cancelled there — use `dsh web` (or any app that stays up) to observe reviews.

## Known limits

- Token figures are the provider-reported usage of the review child's assembled
  steps. The step that is aborted as soon as the advice is recorded may not
  report usage, so a review's cost can be slightly understated.

- The protected-path guard judges the path a read tool addresses. A search tool
  rooted at a subdirectory can still return the body of a protected file inside
  that subdirectory (for example a repo `.env`); the search-root ban covers the
  working directory itself, and result redaction is the second line of defence.
- The page persists its configuration as the full page-owned projection, so a
  restart reproduces what the tab showed. Fields outside that set (queue
  capacity, protected paths) stay owned by the config row and cannot be
  changed from the page.

- Deferred-advice invalidation on log rewrite/compaction is not implemented;
  the review cursor is recorded but not yet used for a decision.
- The reviewer reads files through the Executor's own agent-preset composition,
  so remote-asset file tools are not on its surface: work performed through a
  remote namespace cannot be verified by reading it, and such a review stays
  silent rather than judging a different filesystem. The protected-path guard
  resolves paths through the same host service the filesystem tools use.
- A follow-up the host accepts but never turns into a turn (for example an agent
  that is already closing) leaves its note visible as *awaiting confirmation*
  instead of falsely delivered; it is requeued by the next plugin load. A note
  handed into a running turn has no such proof — the hand-off returns nothing
  to confirm — so an agent that closes before the next step can still swallow
  it.
- Review children are real sessions (the audit trail for what was reviewed), but
  the web session list hides sessions created as subagents, so a review never
  appears there as a stray row.

Key decisions: `docs/DECISIONS.md`.
