# artifact roll

A thin server that turns a directory into a live, scrolling roll of artifacts.

Agents (Claude CLI or anything else) drop files into a directory. Open the page
once and leave it — a tab appears for each agent that is writing, and every new
file slides in at the bottom of that agent's roll. Sketch something back at them
from the same page. No build step, no dependencies, stdlib Python only.

```
python3 server.py --root ~/Sites/artifacts
```

Then open `http://127.0.0.1:8787/`.

**`--root` is required.** There is no default and deliberately so: the root is a
place agents write into, it has to match whatever you told them to write to, and
a guess that silently disagrees costs you a run's worth of output into a
directory nobody is watching. Naming it is cheap; being wrong about it is not.

`~/Sites/artifacts` is the conventional choice on macOS — the per-user web root,
`mod_userdir`'s spot for "files a local server hands out", writable without
sudo, and outside any checkout. It is what the artifact-roll skill tells agents
to use, so it is what the launch agent below passes. Anywhere you can write
works; `--host 0.0.0.0` exposes it:

```
python3 server.py --root /var/www/artifact_roll --host 0.0.0.0 --port 8787
```

## The directory convention

**`<workspace>/<agent-id>/` — two levels, and that's the whole contract.** The
first level says *where the work is*; the second is one agent working there.
Every pair gets its own roll, oldest artifact at the top, newest at the bottom,
so two agents running at once never write into each other's roll.

```
~/Sites/artifacts/                   ← the root
  artifact_roll.communicate_back/    ← a checkout: project.worktree
    reviewer-01/                     ← one agent: a roll
      findings.md
      dashboard/                     ← a dir with an index.html is ONE artifact
        index.html
        style.css
    scout-02/                        ← a second agent on the same checkout
      chart.svg
      metrics.csv
  some-other-project/                ← a different workspace
    builder-01/
      verdict.json
  sketches/                          ← yours, not an agent's
    2026-10-03/
      19-54-29.png
```

`<workspace>` is derived from the checkout, not from what kind of agent is
writing: the main checkout of a repo is `project`, a linked worktree is
`project.worktree`, anything outside a repo is the directory's own name. A role
(`reviewer`, `scout`) is a useful *label* on the agent id and a useless way to
group — you recognise your projects, not an adjective an agent picked for
itself. So everything about one checkout shares a workspace, and a colour.

`<agent-id>` is one run. Lead it with the role and number it, so concurrent
siblings never collide: `reviewer-01`, `scout-02`.

Rolls are ordered by workspace then id, so one checkout's agents stay adjacent.
They share the workspace's colour and differ in shade.

Only files at or below `<workspace>/<agent-id>/` are artifacts. Loose files
directly under the root or under a workspace directory belong to no agent, so
they are skipped rather than guessed into a roll. Dotfiles, `node_modules`, and
`__pycache__` are ignored. Files inside an `index.html` directory are served as
that artifact's assets, not as separate cards.

Point Claude at it by telling each agent where to write:

```
Write every artifact you produce to ~/Sites/artifacts/<workspace>/<your-agent-id>/,
where <workspace> is the project (or project.worktree) you are working in and
<your-agent-id> is your role plus a number. One file per artifact.
```

## What renders

| Kind | Rendered as |
|---|---|
| `.md` `.markdown` `.mdx` | GitHub-flavored markdown, with `$…$` / `$$…$$` math via KaTeX |
| `.svg` | inline image, scaled to the roll |
| `.html` `.htm` | sandboxed iframe, auto-sized to its content, drag-resizable |
| *dir with `index.html`* | same, with relative assets resolving normally |
| `.json` `.jsonl` | pretty-printed and syntax-highlighted |
| `.csv` `.tsv` | table with sticky headers and right-aligned numerics |
| `.png` `.jpg` `.gif` `.webp` `.avif` | inline image |
| `.py` `.js` `.sql` `.yaml` … | monospace source block |
| anything else | name, size, and a download link |

Every card has **⛶ expand** (full-screen), **↗ open raw**, and **▾ collapse**.
Images and SVGs also get **✎ sketch**, which opens them in the pad below.

## Sketching back

The roll runs both ways. Hit **✎ sketch** (or press `s`) and you get a canvas; what
you draw lands in the roll as a PNG the agent can read:

```
artifacts/
  sketches/                             ← you are an agent type too
    2026-10-03/                         ← a day's sketching is one roll
      14-30-22-fix-the-header.note.md   ← your note, if you wrote one
      14-30-22-fix-the-header.png       ← the drawing
    2026-10-04/                         ← tomorrow starts a fresh one
      09-12-05.png
```

It obeys the same two-level contract as everything else — it has to, or the
scanner would not see it — and the instance means what it means for an agent:
one session's work. Today's roll is live while you draw, so it takes a tab and
the page jumps to it; past days sit in the archive under their date. Sending
always counts as a write, so your sketch is on screen, not behind a badge.

Then just say it:

> look at the newest sketch in `artifacts/sketches/` and fix what I circled

The note you type becomes the filename slug *and* a small markdown card above the
sketch, so the intent survives into the roll rather than living only in chat.

**Annotating something the agent made.** Image and SVG cards carry their own ✎ —
it opens the pad with that artifact as the background, and the note records what
you were drawing on (`annotating researcher/r-02/chart.svg`). You can also paste
(`⌘V`) or drag an image in to mark up a screenshot.

| | |
|---|---|
| tools | pen `p`, arrow `a`, box `r`, line `l`, eraser `e` |
| | the eraser lifts only your ink — the background underneath survives |
| colors | six swatches; stroke width on the slider |
| undo | `⌘Z`, one stroke at a time |
| send | `⌘↵` or **send to agent ↑** |
| close | `esc` |

Sketching is on by default. `--no-sketch` turns the endpoint off and hides the
button; `--inbox TYPE` renames the type it writes under (the date is always
the instance).

## Tabs, and the archive

One roll is on screen at a time, and **the tab strip holds exactly the rolls an
agent is writing to right now**. A tab appears the moment a new agent touches
its directory and drops off again once that agent has been quiet for
`--live-window` seconds (120 by default), so the strip stays a picture of what
is actually running rather than of everything that ever ran.

Writes to a roll you are not looking at raise a count on its tab; clicking
through clears it and lands you at the bottom of that roll.

Nothing is lost when a tab disappears. The **archive** pane on the left lists
every roll the tree has ever held, grouped by type, live ones marked and quiet
ones showing how long ago they stopped. Selecting one opens it — its tab comes
back, dimmed, for as long as you are reading it — and expands its artifacts
underneath, so you can jump straight to a single file. The filter box matches
roll names and artifact names at once.

| Key | |
|---|---|
| `←` `→` (or `[` `]`) | previous / next tab |
| `1`…`9` | jump to the nth tab |
| `/` | focus the archive filter |
| `\` | show / hide the archive |
| `esc` | close the expanded artifact |

## Live updates

The server polls the tree (default every 0.5s) and pushes a snapshot over SSE
whenever anything is added, changed, or deleted — and whenever a roll goes
quiet. Edits re-render in place and flash green; deletions fade out.

A roll sticks to the bottom while you are already at the bottom. Scroll up to
read something and it stops chasing — a **`N new ↓`** pill appears instead. The
**follow** switch in the header disables auto-scroll globally.

Liveness is measured from the moment the server *saw* a roll change, not from
file mtimes, so an agent that pauses between artifacts keeps its tab. The one
exception is startup: on the first scan each roll is dated from its newest file,
so pointing the server at an existing tree doesn't light up every agent that
ever ran in it.

## Options

```
--root PATH     directory to watch          (REQUIRED; created if missing)
--host ADDR     bind address                (default: 127.0.0.1; use 0.0.0.0 to expose)
--port N        port                        (default: 8787)
--poll SECS     filesystem poll interval    (default: 0.5)
--live-window S how long after its last write a roll keeps its tab
                                            (default: 120; 0 = never expires)
--token STR     require ?t=STR on first load, then cookie-based
--inbox TYPE    type sketches are written under; the roll is <TYPE>/<date>
                                            (default: sketches)
--no-sketch     refuse sketch uploads; serve read-only
-v              log every request
```

## Running it at login (macOS)

A launch agent keeps it up so the page is always there to open. Installed as
`~/Library/LaunchAgents/com.odedbadt.artifact-roll.plist`:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.odedbadt.artifact-roll.plist
launchctl list | grep artifact-roll      # <pid> 0 com.odedbadt.artifact-roll
tail -f ~/Library/Logs/artifact-roll.log
```

It runs `/usr/bin/python3` — the system interpreter, on purpose, so a rebuilt
conda/micromamba environment can't break startup — with `RunAtLoad` and
`KeepAlive`, bound to `127.0.0.1:8787`, with `--root ~/Sites/artifacts` spelled
out — the plist is the single place the real root is written down, and it has to
agree with what the artifact-roll skill tells agents. Change one, change the
other.

To stop or remove it:

```bash
launchctl bootout gui/$(id -u)/com.odedbadt.artifact-roll
rm ~/Library/LaunchAgents/com.odedbadt.artifact-roll.plist
```

## Running it remotely

`--host 0.0.0.0` serves on all interfaces. There is no authentication beyond the
optional `--token`, and **no encryption** — so on anything but a trusted network,
prefer an SSH tunnel and leave the server bound to localhost:

```
ssh -N -L 8787:127.0.0.1:8787 you@remote-box
```

Then browse `http://127.0.0.1:8787/` locally.

## Notes on safety

- Path traversal out of `--root` is rejected; only files under it are served.
- Artifact HTML runs in an iframe with `sandbox="allow-scripts"` and **no**
  `allow-same-origin`, so a page an agent wrote cannot read the roll around it,
  its cookies, or its storage.
- The height-reporting probe script is injected into the *response* only when
  the roll requests `?probe=1`. Files on disk are never modified.
- `/api/sketch` is the only route that writes. It writes nothing but a PNG (magic
  bytes checked) and its note, into `<root>/<inbox>/<date>/` (a validated plain
  name plus a server-generated date, never anything from the request) under a
  server-generated
  name — no part of the request reaches a path. It requires an `X-Artifact-Roll`
  header, which a cross-origin page cannot set without a preflight the server
  does not answer, and rejects a non-same-origin `Sec-Fetch-Site`. `--token`
  guards it like everything else. Still: this turns an unauthenticated listener
  into one that writes files, so `--host 0.0.0.0` without a token is worse than
  it was — tunnel, or pass `--no-sketch`.

## Try it

```
python3 server.py --root ./examples --port 8791
```

`examples/` contains three rolls across two agent types — two concurrent
researchers and one reviewer — worth of markdown, SVG, CSV, JSON, and an HTML
bundle. They are checked-in files, so they start in the archive with an empty
tab strip; `touch examples/reviewer/v-01/notes.md` gives that roll a tab for two
minutes, and `--live-window 0` keeps every roll permanently tabbed.

Press `s` and scribble: your sketch lands in a roll of its own, which *is*
live, so it takes a tab and the page jumps to it. Note that this writes into
`examples/` — a tracked directory — so clean up `examples/sketches/` after, or
point `--root` somewhere outside the repo.

## Offline behavior

Markdown and math load `marked` and `katex` from a CDN. If those are blocked,
markdown falls back to a built-in mini-renderer and math stays as literal text —
everything else is unaffected.
