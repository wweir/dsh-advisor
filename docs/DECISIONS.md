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
measurements that forced a second cadence, not for the design it describes (the
round cadence, its counters and its sidecar fields no longer exist).

A review was triggered on reply rounds only: the Executor's final answer, or a
reviewable turn end. That missed the case the plugin exists for. One agentic
turn routinely runs dozens of tool steps and crosses no reply boundary until
its final answer, so a long turn was not reviewed at all while the work was
happening — measured on a live session: 46 completed steps in one turn, zero
reviews (an earlier sidecar of the same shape showed the same). A steered turn
may never produce that final answer.

The default is sized from measured runs of this deployment rather than picked
round, re-measured on 2026-10-21 over 43 sessions (20,576 step intervals, 103
reviews): the median step is 9.6 s of wall time (p75 18.8 s, p90 37 s), a
concluded review takes 52 s (p75 113 s, p90 151 s), and a quarter of all
reviews hit the 180 s deadline. The median multi-step turn in a reviewed session
is 21 steps (across all turns, including the one-answer ones this cadence never
reaches, it is 6), and the ten-step cadence left 72 of the 79 reviewed turns
with exactly one review: the second half of a typical reviewed turn was judged
only once the session continued.

Replaying 242 recorded turns with the measured durations makes the trade
explicit: ten steps costs about 2.3-2.5 reviews per turn and a 3.2 min median
detection delay (p90 8.3 min), eight costs ~15 % more calls for 2.9 min and
7.1 min p90, and six another ~17 % for 2.7 and 6.4 min. Coverage saturates in
between — the work judged before its turn ends moves only from 68.6 % at ten
steps to 72.1 % at four — so the step count is a latency/cost dial, not a
correctness one. Eight is the default: the delay gain per extra call is still
cheap there, while below it the cost curve rises faster than the delay falls.
A review in flight skips boundaries and the cursor moves to the step count at
its end, so the measured interval between attempts is ~16 steps rather than the
configured number, and the quarter of reviews that hit the deadline delays the
next attempt more than the cadence does.

Rejected alternatives: counting steps under the round interval (every 3 steps is
a continuous review, since a step is seconds and a review is minutes — the two
units are not interchangeable), and a fixed multiple of it (`everyTurns * 8` is a
magic number hiding a second knob users will want to tune independently).

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
- `everySteps: 0` was v0.3's off switch for the step cadence only (the round
  cadence still reviewed). With one cadence it switches automatic review off
  entirely; `enabled: false` remains the documented way to turn the plugin off.

The default was re-sized from those measurements after v0.4.1 shipped; it is a
default only, so a configured `everySteps` keeps its value.

Migration is deliberately narrow: a persisted `review.everyTurns` (in
`~/.dsh/advisor/config.json` or posted by a page tab still running v0.3) is
ignored rather than rejected, because rejecting it would drop every page
override on load — verified by a test, and the file is rewritten without the key
on the next save. `everySteps: 0` keeps loading for the same reason. The step
counter and cursor persist as before, so a reload mid-session continues the
cadence.

## Bounding what one review may spend on evidence (2026-10-21)

The wall clock was the only bound on a review child, and nothing told the child
to stop. Measured over 72 h (215 review children, 24 of them hit the 180 s
deadline) the timeout splits into two shapes that have nothing to do with the
finding: half had opened 6-20 reads when the wall hit, the other half were
single generations of 12-24k output tokens that never finished. A successful
review reads two files at p50 and emits 879 output tokens; the children that
timed out were not close to a finding, and a timeout reports nothing while the
material waits for the next cadence.

The instruction to stop was already in the prompt ("at most three steps", "at
most five reads or searches") and was not respected — the same text took the
read count from p50 19 to p50 1 when it landed, but children still ran up to 37
reads. So the bounds are enforced instead of promised:

- the read budget is refused: a sixth read or search in one attempt returns a
  failed tool result whose reason says to conclude with the evidence already
  gathered. Refusing is the enforcement; cancelling would drop the finding the
  child was about to record;
- at 70 % of `timeoutMs` the child is steered to conclude. It lands at the next
  step boundary, so a review that already called `advise` is untouched, and it
  repeats that silence is still the correct conclusion — a nudge that read as
  "produce something" would manufacture findings. 70 % leaves room for one
  concluding model call (a successful review's p50 is 16 s) while normal reviews
  never reach it.

Two things were measured and deliberately not changed: the 180 s deadline (on a
fast route a review's p50 is 10-30 s and the deadline is not what fails), and
`maxTokens` (successful reviews reach 19.7k output tokens at p90, so a cap low
enough to stop a runaway generation would turn long-but-correct reviews into
failures; truncation ends a turn as `max-tokens`, which the outcome mapping
already reports as a failure rather than as silence).

## The failure pause is a cooldown with an explicit resume (2026-10-21)

The pause after three consecutive real failures was a latch: `shouldReview`
refused to start anything while paused, and only a review could clear the streak,
so nothing built into the plugin could end it. Three timeouts from a transient
route fault therefore stopped automatic review for the life of the loaded
process. The two recovery paths that existed were workarounds rather than
recoveries — saving the configuration form (the save re-arms every live session)
and reloading the plugin — and the pause was visible only in the Advisor tab or
in `/advisor status`, so an operator working in the chat had no way to notice
that review had gone silent.

The state is a deadline now. A trip holds review for one minute; when the hold
expires the next cadence boundary is admitted as a single probe attempt. A probe
that fails doubles the next hold, up to thirty minutes, and a reviewed attempt
resets the escalation. That keeps the property the latch was built for — a broken
route is never re-attempted once per step — while a transient outage heals
without anyone acting, and a permanently broken route costs one attempt per half
hour.

Explicit recovery is `/advisor resume`, the page banner's **Resume now** button
(same runtime call through a new `POST /api/advisor/resume`), and the two existing
paths, which stay: a saved configuration and a plugin reload both re-arm. Each
trip writes a host-log line with its retry delay, and the status surface reports
the remaining cooldown in `/advisor status` and the retry time in the page
banner, so the pause reads as a waiting period instead of silence.

Deliberately not done: injecting a notice into the Executor's own conversation
(the model would read it and might act on it — the tab, the command and the log
are the operator's channels), and persisting the hold into the sidecar (a reload
is a reconfiguration, and it re-arms review; a persisted hold would survive as a
state nobody asked for).

## The review projection carries no Executor reasoning (2026-10-21)

The projection rendered every content block that carried text, so it included
the Executor's reasoning blocks. Measured over the twelve largest review prompts
(1,487,113 chars total): assistant records were 30.1 % of the projection (260
records, 1,718 chars mean), and the Executor's visible assistant output is only
1.5–2.5 % of its assistant content — 97–98 % of it is reasoning. In other words
the second opinion spent nearly a third of its evidence budget on the chain of
thought, and under 2 % on what the Executor actually told the user.

Reasoning states intent, not fact, and the reviewer's mandate is to point at
evidence it observed — a file, a command, a diff, a tool result. A defect that
only exists in reasoning (a plan that was never carried out) shows up in the
absent or contradictory tool call, not in the prose. Dropping the blocks
therefore removes no evidence, and the projection is ~30 % smaller.

Rejected: keeping a capped head of each reasoning block. A 400-char head would
save 23 % instead of 30 % and would keep a channel the reviewer can be talked
into treating as evidence — the exact failure the prompt's "point at the
concrete evidence" rule exists to prevent.

The line renders reasoning-free; an assistant message that only reasoned
produces no line at all. Tests cover both (`tests/transcript.test.ts`).

## The review child carries no memory guide (2026-10-22)

The memory provider changed from `dsh-auto-memory` to `meow-memory`, because the
first re-computed a system-prompt section on every request: the bytes in front of
the review prompt changed whenever the memory store did, and the provider's
prefix cache stopped matching. `meow-memory` keeps its dynamic memory in a
message and its static guide in a section — but that guide still reached the
review child, which has no memory tools at all, so it was dead text in the most
expensive place (15,268 chars of system prompt against 11,753 without it).

The review child therefore shadows the guide: a section registered under the same
name in the child's own scope wins for that agent alone, and an empty text leaves
it out of the rendered prompt. The executor's own sessions keep the guide — the
reviewer is the only agent that must not pay for it.

Which sections are shadowed is a row-level setting (`prompt.shadowedSections`),
not a constant in this plugin: the advisor does not know another plugin's
internals, so the deployment names them. The list is row-owned like the
protected paths — a page save cannot drop it. The shadow is registered on the
child's own context inside `setup`, which is the scope it must replace: a
registration on any context that outlives the child (the plugin fiber, or the
scope an `inject` callback runs in) would leak the empty section onto every
later child. The default is empty, so a deployment without a memory guide pays
nothing for the mechanism.

Rejected: dropping the guide everywhere (the executor does use the memory
tools), and editing the installed `meow-memory` copy (a `dsh` install would
discard it). The shadow lives in this plugin, where it is versioned and tested
against the real `@deepseek-ai/dsh-system-prompt` service.

## Two-zone projection, graded evidence and a window-derived budget (2026-10-21)

The projection used to be one tail-bounded blob: every event became a line, the
whole text was cut from the tail to fit `maxContextTokens`, and that cap was a
static 32K regardless of the reviewer model. Three measurements made that shape
wrong. Over 88 review prompts the cap truncated 44 % of them; the largest
contents were low-density (tool results 39.8 %, of which shell output 25.6 %,
file reads 13.0 %); and the reviewer model's window never entered the
calculation, so a 32K/64K reviewer overflowed into the host's compaction and
silently judged a summary. The composition is therefore split:

- **Two zones.** Lines before the boundary are what a completed review already
  read; lines after it are the work since then. The composer bounds the new zone
  first and gives the trace only the remainder, so a large trace can never push
  the boundary line or the new work out — which a single tail cut allowed.
  Zones are keyed by session seq, not by a line index, so trimming the ring or a
  compaction shadowing entries does not move the boundary.
- **Graded evidence.** A tool result is rendered by whether the reviewer could
  re-obtain it: a `read`/`grep`/`glob` result becomes path, size and "content
  omitted (re-read to verify)"; a shell result becomes status plus failure lines
  and an 8-line tail (600 chars); an `edit`/`write` result, a tool error, and
  every tool the reviewer cannot call (MCP, subagent, job, `ls`) keep their text.
  In the trace zone all tool-result bodies are omitted except edits and errors,
  and the instructions say that omission means hidden, not unexecuted — the
  recall risk of a trace is a reviewer reading "no output" as "nothing ran".
- **Earlier conclusions.** Up to six conclusion lines travel as a bounded
  (≤500 token) block of outcome, severity, finding identity and one note line,
  taken from the sidecar; consecutive silent reviews of one turn collapse into
  one line, so a group can stand for more than one review. It is orientation, not evidence: it stops the reviewer
  re-investigating work already judged and re-reporting a finding whose evidence
  is no longer in the prompt.
- **A cap that is derived, not assumed.** The prompt budget is the smaller of
  `maxContextTokens` (default 64K) and `contextWindow − preamble − output
  reserve − 2K margin`, using the preamble the last review child actually
  carried (system prompt plus tool schemas; 11,089 tokens on this deployment).
  A route whose window cannot hold the 4K-token minimum for evidence is refused
  with every number in the failure reason — at page-save time and at review
  time. The protection is best-effort by nature: a route whose adapter reports
  no window (or fails the lookup) keeps the operator's cap, because the plugin
  has no larger number to check against; the page says so when the catalog knows
  the window. The measured preamble is a floor: a measurement below the
  deployment constant (a request snapshot that carried only part of the
  preamble) never shrinks the room the next review leaves for it. The ring grew to 900 lines to match the 64K cap: a smaller ring leaves
  the extra budget nothing to hold, a larger one pays memory for trace nobody
  reads.

Measured by replaying this repository's own 567-step session (2,085 records)
through the old and the new rules at the same review boundaries: the projection
is 46 % smaller than the current reasoning-free rule and 57 % smaller than the
pre-drop rule, matching the composition estimate. At the 64K cap that session's
reviews send p50 ~63K (trace ~59K, new work ~4K), i.e. the cap is filled once a
session has more than ~900 records — that is the intended trade for a bounded
background, and the p90 for the ordinary population stays governed by its
material, not by the cap.

Rejected: a single tail-bounded projection (loses the boundary and the new work
first); a per-tool summary produced by a model (cost and non-determinism for a
bounded transcript); pointer-degrading `ls` (the reviewer has no `ls`, so a
"re-read to verify" pointer would be unverifiable — the plan listed it, the code
deliberately does not); a static cap with no model-window check (the overflow
this decision exists to remove).

The rules that follow from the same "the reviewer must not be told something
false" line are worth stating because they are not obvious from the code:

- A review that could not project its whole new-work zone does **not** advance the
  boundary. `boundEntries` keeps the tail, so the oldest entries since the last
  review were never shown; advancing would demote them into the body-less trace of
  a review that never read them ("body omitted (reviewed earlier)" would be a lie),
  and the next cadence would stop re-sending them. Staying put keeps them new.
- A cut new-work zone says so in the prompt (`[N entries of new work omitted to fit
  this prompt]`, placed after the boundary line), because the boundary sentence
  otherwise turns "the oldest work was dropped" into "no new work accrued". The
  omission is not the trace's: the trace already announces its own omission, and the
  two zones lose material for different reasons.
- A prompt whose fixed text, omission reserves and conclusions leave no room for any
  evidence is a **failure with the numbers**, not a silent review: a child call that
  cannot see the work judges nothing. That covers both a marker-only projection and
  a prompt where the fixed text alone exceeds the budget. The same arithmetic refuses
  a `maxContextTokens` below the 4K evidence floor, with or without a known window.
  The conclusions are dropped before that verdict is taken when paying for them is
  what denied the material (a zone too small for even one entry): orientation must
  never be the reason evidence is missing.
- `job_output` is not a shell result: it carries no exit status and is read
  incrementally (the same call returns different text next time), so the
  status/tail summary would lose evidence it cannot recover. Its body travels like
  any other unrepeatable tool result, and only the trace zone drops it.
- A shell result's status comes only from the harness's own trailing marker
  (`[exit code: N]`, `[killed by signal: X]`) — the anchor Host code parses —
  never from scanning the output for the words: a successful command whose log
  quotes a child's "exit code 1" was reported as failed by the first cut.
- A compaction summary line carries the surface seq of the checkpoint message
  that replaced the shadowed range, not the log-only summary event: later
  `shadowedSeqs` name surface nodes, so a line keyed to the log event survived
  every later compaction as a stale summary. A summary with no visible text
  records no id, so its checkpoint (the only remaining copy) is still rendered.
- A restored review record is validated totally, because it feeds both the page's
  history and the next prompt's conclusions block: a hand-edited `note: 42` would
  otherwise throw inside prompt composition and fail every later review.
- The 900-line ring is a hard memory bound, and the omission line counts only what
  the buffer still holds. When reviews cannot run long enough for unreviewed lines
  to leave the ring, they are gone; the prompt does not claim otherwise — no boundary
  is minted for material the buffer no longer has, so none of the remaining lines is
  presented as already reviewed.

Only the read/search budget is enforced. Measured on 26 review children in the
first 20 minutes after this landed: steps per review {1:7, 2:6, 3:8, 4:3, 5:1,
7:1}, and four of the five children that went past the three-step figure ended in
a finding after reading files to verify it. The cost tail is not the step count
either — the expensive reviews (12–16k output tokens, 100 s) were two-step ones,
i.e. the reviewer model's own reasoning, and the enforced five-read cap already
bounds the tool round-trips (eight refusals in the same window). A hard step wall
would therefore cut findings without cutting the dominant cost, so the prompt
states the enforced bound ("a sixth is refused") and keeps the step count as
guidance. Rejected: refusing tool calls past step three.

Tests: `tests/transcript.test.ts` (grading, shell status markers, empty results,
boundary), `tests/transcript-buffer.test.ts` (pairing, ring, compaction re-keying),
`tests/prompt.test.ts` (zone budgeting, conclusions fallback, degenerate budget),
`tests/budget.test.ts` (window arithmetic and refusal numbers), and
`tests/stats.test.ts` (restored-record and context-meta validation). The live
re-measurement of review cost and duration is the plan's next gate, not a claim
of this change.
