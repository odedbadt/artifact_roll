---
name: artifact-roll
description: Write diagrams, charts, reports and other file-shaped deliverables into the artifact roll (~/Sites/artifacts/<workspace>/<agent-id>/) so they render live in the browser viewer instead of being dumped into chat or into the repo being worked on, and read back the sketches a person draws there for you. Use whenever a task produces an SVG diagram, a chart, a data table, a written analysis or findings doc, an HTML mockup, or any output a person will want to look at rather than read in a terminal — and especially when several agents run at once. Also use when asked to look at a sketch, a drawing, or what someone circled or marked up, or when asked to take a turn in / check / reply to a sketch thread. NOT related to claude.ai Artifacts (the published-web-page tool); this writes plain files to a watched directory.
---

# artifact-roll — where visual output goes

There is a local server (`~/work/artifact_roll/server.py`) watching a directory
and streaming it to a browser page. Files you write there appear instantly as
rendered cards — SVGs drawn, markdown formatted, CSVs tabulated, HTML in a
sandboxed frame. A person may well be watching it while you work.

**This is not the claude.ai Artifact tool.** No `Artifact` call, no publishing,
no URL. You are writing ordinary files to an ordinary directory.

## Where

```
<root>/<workspace>/<agent-id>/<file>
```

`<root>` is **`~/Sites/artifacts`**. Not a guess, not an environment variable —
the running server is passed that exact path (see the launch agent below), so
anywhere else is a directory nobody is watching.

Create your own subdirectories if missing (`mkdir -p`). **Two levels are
mandatory.** Files sitting directly in the root, or directly in a workspace
directory, are deliberately ignored by the scanner — they will silently never
appear.

### `<workspace>` — where the work is

Derive it from the checkout you are working in, never from what kind of agent
you are. The person watching recognises their projects; they do not recognise
a role you picked off a list.

```bash
top=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$top" ]; then
  main=$(cd "$(dirname "$(git rev-parse --git-common-dir)")" && pwd)
  project=$(basename "$main"); leaf=$(basename "$top")
  [ "$project" = "$leaf" ] && workspace=$project || workspace=$project.$leaf
else
  workspace=$(basename "$PWD")        # not a repo: the directory you are in
fi
```

A linked worktree becomes `project.worktree` (`artifact_roll.communicate_back`);
the main checkout is just `project` (`artifact_roll`). Every agent working on
the same checkout therefore shares one workspace and one colour in the viewer,
which is the grouping that means something: *these rolls are about this code*.

### `<agent-id>` — which agent

One directory per run, so concurrent siblings never collide. Lead with your
role so the id still says what you were doing — the role is a **label here, not
a grouping**:

```bash
root=$HOME/Sites/artifacts
role=reviewer                   # scout, architect, reviewer, analyst, builder, docs
n=$(find "$root/$workspace" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
id=$(printf '%s-%02d' "$role" "$((n+1))")
mkdir -p "$root/$workspace/$id"
```

That gives `~/Sites/artifacts/artifact_roll.communicate_back/reviewer-01/`.

Say where you are writing, once, early: *"artifacts →
artifact_roll.communicate_back/reviewer-01"*. Then stay in that directory for
the whole run.

## What to write

| You made | Write it as | Why |
|---|---|---|
| a diagram, tree, graph, flow | `.svg` | drawn inline, scales to the roll |
| findings, analysis, a writeup | `.md` | GFM + `$math$` via KaTeX |
| structured results | `.json` / `.jsonl` | pretty-printed, syntax-coloured |
| tabular numbers | `.csv` / `.tsv` | real table, sticky header |
| an interactive demo | `.html` | sandboxed iframe, auto-sized |
| a demo with assets | `subdir/index.html` | the **directory** is one artifact |
| a screenshot or render | `.png` / `.jpg` / `.webp` | inline image |

Anything else (`.py`, `.txt`, `.yaml`, …) still shows — as a source block or a
download link — so a stray file is never lost, just less pretty.

Name files `NNN-short-slug.ext`, zero-padded from `001`:

```
001-overview.md
002-call-hierarchy.svg
003-dead-functions.json
```

The roll orders by write time, so the numbers are for humans — but they keep
the archive pane legible and break ties when you write several at once.

## Reading back: sketches

The roll runs both ways. The person watching can draw on a canvas in the viewer
and send it, which lands as a PNG here:

```
~/Sites/artifacts/sketches/
  2026-10-03/                        ← a day's sketching is one roll
    14-30-22-fix-the-header.note.md  ← what they typed, if anything
    14-30-22-fix-the-header.png      ← the drawing
  2026-10-04/
    09-12-05.png
```

So "look at my sketch", "fix what I circled", "see what I drew" all mean: read
the newest `.png` under `~/Sites/artifacts/sketches/`, and its `.note.md`
sibling if there is one. Today's date is usually the right directory, but glob
across them rather than assuming — they may be picking up yesterday's thread:

```bash
ls -t ~/Sites/artifacts/sketches/*/*.png | head -1
```

The filename carries their note as a slug, so a listing alone often tells you
what they want. The note file names the sketch it belongs to and, when they drew
on top of an existing artifact, which one (`annotating researcher/r-02/chart.svg`)
— that artifact is the subject; the drawing is the instruction.

Read it as an image. Do not go looking for a sketch unless they refer to one.

## Sketch threads — drawing back and forth

A thread is a conversation on one shared canvas. A directory holding a
`canvas.json` is a thread; `NNN-author.png|svg` is one turn. Layers are
transparent and composite in order, so every turn lands on the same coordinates
— which is the point: you can both point at the same thing.

```
<workspace>/<agent-id>/room-history/
  canvas.json           { "w": 1600, "h": 1000, "title": "..." }
  001-architect-01.svg  a turn, plus 001-architect-01.txt for what it says
  002-me.png            their reply, drawn on top
```

**A thread is waiting on you when its highest-numbered layer is authored `me`.**
That is the whole signal — no queue, no notification, no state beyond the
filenames. List them:

```bash
root=$HOME/Sites/artifacts
find "$root" -mindepth 3 -name canvas.json 2>/dev/null | while read -r c; do
  d=$(dirname "$c")
  last=$(ls -1 "$d" | grep -E '^[0-9]{3}-.*\.(png|svg)$' | sort | tail -1)
  case "$last" in *-me.png|*-me.svg) echo "${d#$root/}  ($last)" ;; esac
done
```

When they say *"I drew on it"*, *"check the thread"*, *"your turn"*, or send you
back to a diagram you drew: run that. **One** result — take the turn. **Several**
— ask which; do not guess. **None** — say so rather than inventing one.

### Taking a turn

Read the whole thread first: `canvas.json` for the canvas size, every layer as
an image, every `.txt` for what each turn meant. The files are the entire
conversation — you need no memory of having drawn the earlier turns.

Then write `NNN+1-<your-agent-id>.svg` at exactly the canvas's `w`×`h`, with a
transparent background — no background rect, or you bury every turn beneath you.
Use absolute coordinates: that precision is the thing you are good at and they
are not. Draw into the space they left empty, and do not redraw what is already
there. Add `NNN+1-<your-agent-id>.txt` saying what the turn means in a sentence
or two.

Answer *where they pointed*. If they put an arrow on one box, that box is the
question. If their mark is genuinely ambiguous, say which reading you took.

If you have just written a turn and they are still here, you may poll for their
reply for a minute or two rather than ending the exchange — but do not sit
waiting indefinitely. Dropping the thread costs nothing: it is all on disk, and
either of you can pick it up later.

## How to write

**One file per idea, written the moment it is ready.** The whole value of the
roll is watching a run unfold; batching everything into a final dump at the end
throws that away. If you have eight findings, that is eight files appearing over
eight minutes, not one file at the end.

- Write your own roll only. Never touch another agent's directory.
- Prefer a diagram to a description of a diagram. An SVG call tree beats three
  paragraphs about the call tree.
- Editing a file re-renders that card in place and flashes it green — so
  correcting an earlier artifact is cheap and visible. Do it rather than
  appending a "correction" file.
- Keep each artifact self-contained: a reader clicks one card, not a trail.
- Don't write into the repository you were asked to work on. Analysis output is
  not source; the roll is where it goes.

## A roll is per-run, not per-agent-forever

A tab appears in the viewer when you first write, and drops off ~2 minutes after
you stop. Nothing is deleted — quiet rolls stay in the archive pane on the left.
So a long pause between artifacts is fine; you do not need to keep the tab warm.

## The viewer is already running

A launchd agent (`com.odedbadt.artifact-roll`) keeps the server up at
**http://127.0.0.1:8787/** from login onwards, watching `~/Sites/artifacts`.
You do not need to start it, and you should not start your own copy — port 8787
is taken and a second server on another port just splits the page in two.

The server requires `--root` and has no default, so that path lives in exactly
two places: the plist (`~/Library/LaunchAgents/com.odedbadt.artifact-roll.plist`)
and this file. If one changes, change the other.

Write your files and they are on screen within half a second. If something looks
wrong, `tail ~/Library/Logs/artifact-roll.log` says what the server thinks.
