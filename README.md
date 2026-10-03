# pi-shake, the `/shake` extension for Pi

> Fold heavy context out of the model's view; undo restores every byte.

`/shake` shortens old tool output, fenced code blocks, top-level XML blocks,
images, and assistant reasoning into brief placeholders in the model's
context. Everything stays in the session file: fold works through pi's
`context_edit` overlays, so nothing is ever deleted and fold is always
reversible.

## Features

- One command family for the three kinds of bulk: `elide` (default), `images`,
  `thinking`
- Undo restores everything that was folded
- Dry-run previews a fold without applying it
- A protected recent tail keeps the working set intact; three profiles tune it

## Quick start

```bash
just install        # copies the extension into ~/.pi/agent/extensions/shake/
```

Run `/reload` in a session (or restart Pi), then:

```
/shake              # fold old tool results and fenced/XML blocks
/shake status       # what is folded, profile, context usage
/shake undo         # restore everything
```

Installation via the pi package manager and from git is planned.

## Usage

| Command | What it does |
|---|---|
| `/shake` | Fold tool results and fenced/XML blocks (also written `/shake elide`) |
| `/shake images` | Remove all images from the session |
| `/shake thinking` | Remove all assistant reasoning blocks |
| `/shake dry-run [elide\|thinking\|images]` | Preview what that scope would do, without doing it |
| `/shake undo` | Restore everything |
| `/shake profile` | Choose a profile: default / conservative / aggressive |
| `/shake status` | Current fold count, profile, context usage, last run |

Fenced blocks are the sections between three backticks or three tildes
(```` ``` ```` / `~~~`); XML blocks are top-level spans such as
`<output>...</output>`.

## Safety

- Does not run while the agent is streaming.
- The most recent ~4,000 tokens stay untouched (2,000 with `aggressive`,
  8,000 with `conservative`).
- Already-folded entries are left alone.
- Entries summarized away by `/compact` are left alone.
- Tool results from `skill` tools are left alone.

## Profiles

The profile steers elide's two thresholds: the protected tail and the minimum
size of a fenced/XML block worth folding. `images` and `thinking` are not
affected.

| Profile | Protected tail | Block minimum |
|---|---|---|
| `default` | 4,000 tokens | ~400 tokens |
| `conservative` | 8,000 tokens | ~800 tokens |
| `aggressive` | 2,000 tokens | ~200 tokens |

Set it with `/shake profile` (writes `shake.profile` to `.pi/settings.json`
if present, otherwise `~/.pi/agent/settings.json`) or by editing that file.
Resolution: project settings > agent-directory settings > `default`.

## Design

The reasoning behind the design (overlays, thresholds, compaction ordering,
caching, and fork/rewind behavior) is in
[How `/shake` works](docs/explanation.md).
