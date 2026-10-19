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

