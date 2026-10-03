# How `/shake` works

Why the extension is built the way it is, and what each design choice trades
off.

## Why overlays instead of rewrites

In OMP, `/shake` rewrites the transcript file in place: it deletes the
folded content, offloads the originals to a recovery artifact, rebuilds the
session context, and tears down provider sessions that cache message
identity. Fold becomes destructive and expensive, and undo is hard.

Pi sessions are append-only. The equivalent of a rewrite is the
`context_edit` entry, which pi itself uses for overflow recovery:

```ts
{ type: "context_edit", targetId, replacement: { content } | null }
```

The session file is the transcript; it is never touched. What the model
sees on each request is a **projection**: the stored entries after every
overlay is applied. For any entry, the most recent overlay wins. A fold is
therefore not an edit of the file, it is one more overlay stacked on top.

## The placeholders

A folded block becomes a short text replacement such as
`[bash output omitted (~9,045 tokens)]`.

## The two thresholds and why only elide has them

Fold has two thresholds, steered by three profiles:

| Profile | Tail | Block minimum |
|---|---|---|
| default | 4,000 tokens | ~400 tokens |
| conservative | 8,000 tokens | ~800 tokens |
| aggressive | 2,000 tokens | ~200 tokens |

- The **tail** is measured from the newest entry backward. Whatever falls
  inside it is the model's working set, often the exact tool output it is
  reasoning with, so it stays untouched. The tail advances as the
  conversation grows: each new turn pushes the boundary forward and exposes
  the entries above it to the next fold. Already-folded entries are skipped,
  so a fold never re-does work.
- The **block minimum** applies to fenced blocks (the sections between three
  backticks or three tildes inside a message) and top-level XML spans. Only
  blocks large enough to be worth it are folded; medium-sized ones may still
  be load-bearing.

`images` and `thinking` are all-or-nothing, with no tail and no minimum:

- **Thinking has little downstream value.** A reasoning block's main job is
  producing the answer that follows it. Once the answer lands, recent
  reasoning is near disposable as old reasoning: the model mostly
  continues the next turns from conclusions, not chains.
- **Images are priced high and used once.** Each image costs roughly 1,200
  tokens by pi's estimator, and a screenshot is either the thing being worked
  on or dead weight. You run `/shake images` as a purge after the fact.

## The wall: what a fold tracks

Every run appends a **log entry to the session file**: a custom entry of type
`shake` (context-invisible, never sent to the model) listing the targets it
folded. From these logs the extension derives two things:

- **The wall** is the set of entries currently folded. Chronological, last
  operation wins: shake adds, undo removes. It counts entries, never raw
  `context_edit` rows, because the file accumulates superseded overlays and
  pi's own overflow-recovery omissions. Counting rows instead of entries
  produced phantom numbers early on.
- **The skip-set** is which targets a shake must skip as of now, so the fold
  frontier is monotonic: entries restored and re-folded are folded once, and
  a repeat shake with nothing new appends zero edits.

`/shake status` reads the wall; `/shake undo` reads the same logs to decide
what to restore.

## Compaction ordering: compact first, shake second

`/compact` squeezes old messages into one summary and stops showing the
model the originals. The summary is written from what the model currently
sees (the folded view), and it becomes the model's permanent memory of that
period: later compactions build on earlier summaries, so that memory is
carried forward.

That makes the order of operations matter. If you shake first and compact
second, the summarizer reads placeholders like
`[bash output omitted (~9,000 tokens)]` and can only record "outputs were
omitted". The full text is still in the file, but the model only reads the
summary now, so that content is gone from its memory, permanently.

If you compact first and shake second, the summary is written from the full
text and nothing is lost. The raw text that compaction stopped showing is
now dead weight: shaking it afterwards folds it away with no loss to
anything the model can still see.

So the rule: compact while the content is still visible, then shake the
leftovers. When compacting, pick a cheap compaction model, then `/shake
undo`, then `/compact`; in the turns after that, `/shake` again.

After a compaction, entries before the summary's `firstKeptEntryId` are no
longer projected, so all three scopes skip them. Edits there would be inert
and would inflate the counts dry-run and notifications report.

## Caching economics

Every turn, pi sends the whole conversation to the provider, and providers
discount the part of the prompt that is byte-identical to the previous
request: the unchanged prefix is served from cache at a lower price. The
moment any byte in the middle differs, everything from that byte to the end
must be re-encoded at full price, and the cache re-warms from there.

That is where a fold's cost lands. A fold edits an old entry in the middle
of the conversation, so the request right after the fold re-encodes from
that entry to the end: one full-price turn. Then the conversation is stable
again, and every later turn reads cache at the smaller size. One cold
request per fold that applied, and it typically pays for itself within a
few turns.

The same applies to the other mutations: an undo or a compact also changes
the middle of the conversation, so each costs its own single cold request.
A no-op fold changes nothing and costs nothing; `/shake status` only reads;
ordinary turns keep the prefix warm.

Fork and rewind change the conversation too, so the first request after
them is cold regardless of shake. Shaking before that first request means
the cold re-encode happens once, not twice.

## Lifecycle: folds across fork, rewind, import

The session file keeps the whole conversation history, and that history is
a tree: forking or rewinding creates new branches from a chosen point. A
fold is just two things in that history, a placeholder entry and a log
entry saying what was folded, both sitting on the branch where the shake
ran. To pi they are ordinary history, so session operations handle them
exactly like any other entry:

| Operation | What happens to the folds |
|---|---|
| `/fork` at the current state | They are copied with the rest of the file. `/shake undo` and `/shake status` still work in the new file. |
| `/fork` at an earlier message | Everything after that message is left behind, folds included. The new file starts from raw, unshaken context. |
| `/tree` rewind | The conversation moves back to an earlier message, and the folds that came after it are simply not shown anymore: the raw text is back. The fold data stays in the file under the old branch; switch back and the folds return. |
| Export / import | The whole file is copied verbatim, folds included. |

Two things follow from folds being ordinary history. First, no orphaned
overlays: pi copies or drops whole subtrees, so a fold and the entry it
overlays always travel together. Second, a rewound timeline shows raw
content by construction, because the timeline you rewind to never made the
fold decision in the first place. Nothing has to be restored or cleaned
up. The `session-manager` test suite verifies this: it projects the same
session at an earlier leaf and checks that the raw text returns.

## Why undo is all-or-nothing

Undo restores every folded entry at once. Scoped undo (restoring one entry
or a few) was considered and deliberately left out, for three reasons.

First, it would save nothing. Restoring any entry changes bytes in the
middle of the conversation, and the cache re-encodes everything from that
point to the end. Restoring one entry costs the same single cold request
as restoring all of them.

Second, the real use cases are all-or-nothing anyway: before a compaction
you want the full text back so the summary is written from real content,
and after a fold that was too aggressive you want everything back at once.

Third, when a single entry matters, undo is the wrong tool. A fold never
deletes anything: the full original text is still stored in the session
file, and the model can re-read it from there with the `read` tool.

Undo is idempotent: a repeat `/shake undo` is a no-op.

## What the dry-run is for

`/shake dry-run` opens a scope popup (elide / thinking / images) and prints
what that scope would fold, in the same wording as the real run, prefixed
with `[dry-run]`:

```
[dry-run] · Shook 46 tool results (~7,215 tokens). Protects the last 2,000 tokens. Profile: aggressive (settings.json (agent-directory)).
```

It costs nothing (no edits are applied, so there is no cache miss) and it
answers the question before you commit to a re-warm: how much would this
scope actually reclaim, and is the one-time re-encode worth it. That matters
most for `thinking`, which can strip tens of thousands of tokens in one
strike. The explicit form `/shake dry-run thinking` skips the popup.

## The rejected alternative

There was a second way shake could have been built, and it was considered
and rejected. Pi lets an extension register a `context` event that rewrites
the message list handed to the model on each request, restoring the list
afterward. A shake built on that would hide heavy content without ever
touching the session file: no overlays, no undo needed, since nothing was
changed.

It was rejected because the hiding is request-local and ephemeral. The
folded state lives in the extension's own code, not in the session: the
moment the event stops running the content is back, and rewinding the tree
or exporting the session shows the full raw text, because no fold was ever
recorded. There is also nothing to undo, in the file's sense, since the
file never changed.

The chosen approach, `context_edit` overlays, persists instead: the folds
are entries in the session file, they survive rewind and travel with
exports, and `/shake undo` restores real stored content byte for byte. It
also routes through the same mechanism pi itself uses for overflow
recovery, so pi's own machinery already knows how to project it.
