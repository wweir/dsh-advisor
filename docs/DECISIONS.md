# Decisions

Key decisions that shaped dsh-advisor. Each entry records the rejected
alternative and the reasoning, which is not recoverable from the code.

## Native Cordis plugin, not dsh-hook-protocol (2026-10-17)

The advisor runs as a native Cordis plugin bundle, not as a hook. The
`dsh-hook-protocol` engine was rejected: `continue:false` does not take
effect, `updatedInput` is not parsed, and its own README says bespoke hook
behavior should be a native Cordis plugin.

## Dedupe records only on delivery success (2026-10-17)

A finding enters the dedupe table only after its delivery succeeds; until
then the pending queue holds its `findingKey`. This removes the upstream
rollback-compensation logic (restore-on-evict): an undelivered advice
occupies the queue slot, a delivered one occupies the dedupe table, so no
path can report the same finding twice.

## Model catalog: keep a model whose metadata will not resolve (2026-10-19)

The tab's provider/model/level dropdowns are fed by `GET /api/advisor/catalog`,
projected from the live llm registry. The host's own `buildModelCatalog` fails
an entire provider when one of its models refuses `resolveModelInfo`; this
projection draws the isolation line one level lower — a failed provider still
drops out, but a failed model stays listed, without level metadata, and the
form then offers its static list. The GUI's stricter rule was rejected because
a dropdown that silently loses a selectable model is a worse failure than one
offering it without levels, and the model is still resolvable at request time.
For the same reason an advertised level set that the plugin cannot express is
sent as an explicit empty list rather than omitted: absent means "no metadata",
empty means "advertised, none offerable", and the form offers only "Default"
for the latter instead of letting an unsupported level be saved.

## Protected paths are intentionally stricter than upstream (2026-10-17)

The built-in protected-path table ([src/policy/security.ts](../src/policy/security.ts))
deliberately goes beyond the upstream advisor: it also blocks workspace-root
private keys (the exact names `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519`/`id_xmss`,
plus their `~`/`.bak`-style copy suffixes — a blanket `id_*` prefix would also
hide ordinary modules such as `id_generator.ts`) and `.envrc`, which upstream
only guards as `.env*` / inside `.ssh`. Name and extension rules are compared
case-insensitively on every platform, because `.ENV` or `ID_RSA` is the same
secret. A reviewer session must not read those. The
`security.additionalProtectedPaths` config can extend the table, never
shrink it.

## Reviewer attention starts at the last completed review (2026-10-20)

The projection now inserts a boundary line where the work since the last
completed review begins, and the prompt tells the reviewer to judge from there
and conclude within three steps (batched reads, at most five). Measured before
this: reviews of the same repository spent 13–30 steps and up to the 180 s
deadline, much of it re-reading turns an earlier review had already covered, or
surveying files the evidence had not named. Rejected alternatives: sending only
the new turns (the reviewer loses the older evidence the new work cites), and
naming the boundary by turn number (the projection has no turn attribution, so
counting from the end would be guesswork). A failed or cancelled review does
not advance the boundary: its material was never concluded on and must still be
marked new to the next reviewer.

The line carries a nonce minted per review, not a fixed phrase. A fixed marker
is a public string that any tool result, file body or model message can quote —
this repository's own transcript contains the literal, because the constant is
in its source — and a quoted copy would let the reviewer start at the wrong
place and treat genuinely new work as older context. The nonce is minted after
the content it separates was written, so the evidence could not have seen it.
The sentence naming the nonce sits after the fixed instruction block: the
provider cache still matches the prefix across reviews, and only the sentence
itself is per-review.

## Mid-turn step cadence beside the reply-round cadence (2026-10-20)

Superseded later the same day by the single-cadence decision below; kept for the
measurements it records.

A review was triggered on reply rounds only: the Executor's final answer, or a
reviewable turn end. That missed the case the plugin exists for. One agentic
turn routinely runs dozens of tool steps and crosses no reply boundary until
its final answer, so a long turn was not reviewed at all while the work was
happening — measured on a live session: 46 completed steps in one turn, zero
reviews (an earlier sidecar of the same shape showed the same). A steered turn
may never produce that final answer. The rhythm therefore gains a second
cadence, `everySteps` (default 10, `0` disables): a completed step inside a
running turn starts a review once that many steps have accrued.

The default is sized from measured runs of this deployment rather than picked
round. Across recent sessions the median step is ~8 s wall time (range
4.5–13 s), while the median review takes ~98 s and the 75th percentile ~162 s
(13 of 73 recorded reviews hit the 180 s deadline). At ten steps the first
mid-turn review lands ~80 s into a long turn, and the finish-time cursor makes
the next one due only after a fresh ten steps, so continuous work is reviewed
roughly every three minutes — fast enough to see drift while it is fresh, slow
enough that a slow reviewer does not chain review after review. Rejected values:
25 (a 46-step turn got a single review, measured: the complaint that started
this change), and single-digit values, which push the cadence into a review
every one to two minutes.

Rejected alternatives: counting steps under `everyTurns` (every 3 steps is a
continuous review, since a step is seconds and a review is minutes — the two
units are not interchangeable), and a fixed multiple of `everyTurns`
(`everyTurns * 8` is a magic number hiding a second knob users will want to
tune independently). Two design points fall out of the timing asymmetry:

- The step cursor moves when a review **finishes**, not when it starts. A
  review that spans more than `everySteps` steps would otherwise see its own
  coverage as a fresh cadence and chain into the next review for as long as the
  turn runs. Rounds keep the old claim-time behavior because rounds are rare and
  a round that closed mid-review deserves the catch-up.
- A step boundary never inherits the round cadence's "the first review is due
  immediately". A fresh session is reviewed at its first reply, not after its
  first tool step; the step trigger needs a full `everySteps` of work behind it.

Both counters (rounds seen, steps seen) are now absolute and persisted, together
with the step cursor. Before this, the observer counted rounds in memory and
re-seeded the counter at the last reviewed round on reload, so every plugin
reload silently forgave the rounds that had accrued since the last review — the
live development loop (edit, rebuild, HMR reconcile) made that look like a
broken trigger. A sidecar written before the counters existed seeds its round
total from `lastReviewedRound`, so an upgraded session does not stall.

## One cadence: steps only (2026-10-20)

Two intervals answered one question — "when is work due for review?" — and they
could disagree: a turn with few steps but many replies was reviewed by rounds, a
turn with dozens of steps but no final answer only by steps. The operator asked
for one, and the step one is the correct single unit: a step is the host's
progress unit (one model call plus the tools it ran), it exists both inside a
long turn and across short turns, and a review is meaningful only for work that
was actually done. `everyTurns` and the whole reply-round trigger are removed:
no final-answer detection, no turn-end trigger, no round counter, no round
cursor, and no deferred round catch-up (a step boundary during a review needs
none, because the step cursor moves to the end of the running review).

Consequences accepted with the simplification:

- The turn's final answer starts nothing. In the old design a session could be
  reviewed at an N-th reply even if it had few steps; now a session that stops
  with fewer than `everySteps` steps after its last review leaves that tail
  unreviewed until further steps accrue. The alternative — checking the counter
  again at turn end — cannot fire: the counter only grows at step boundaries,
  so the turn end would merely re-read a gap the last step already saw. Keeping
  the round trigger for exactly this case was rejected as the redundancy under
  removal.
- The first review is no longer immediate. A fresh session is reviewed after
  `everySteps` steps; a one-step question is not worth a reviewer call.
- A failed or cancelled review still advances the rhythm cursor to the steps
  seen at its end. The obvious alternative — leave the cursor so the next step
  retries the unreviewed material — was rejected: a route that is down fails
  again on the next step, so an immediate retry re-attempts a broken model call
  once per step (and cancellations, which never feed the pause, would retry
  once per step after every reload). The cursor paces ATTEMPTS; what the next
  reviewer reads is the transcript boundary, which failed/cancelled reviews
  leave unadvanced, so the retry still covers the material that was never judged.
  A persistently broken route is stopped by the failure pause (three real
  failures), not by the cadence.
- `everySteps: 0` keeps its v0.3 meaning as an explicit off switch. With one
  cadence it now means no automatic review at all; `enabled: false` remains the
  documented way to turn the plugin off.

Migration is deliberately narrow: a persisted `review.everyTurns` (in
`~/.dsh/advisor/config.json` or posted by a page tab still running v0.3) is
ignored rather than rejected, because rejecting it would drop every page
override on load — verified by a test, and the file is rewritten without the key
on the next save. `everySteps: 0` keeps loading for the same reason. The step
counter and cursor persist as before, so a reload mid-session continues the
cadence.
