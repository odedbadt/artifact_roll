# artifact roll

A thin server that turns a directory into a live, scrolling roll of artifacts.

Agents (Claude CLI or anything else) drop files into a directory. Open the page
once and leave it — a tab appears for each agent that is writing, and every new
file slides in at the bottom of that agent's roll. No build step, no
dependencies, stdlib Python only.

```
python3 server.py
```

Then open `http://127.0.0.1:8787/`.

With no `--root`, artifacts live in the **per-user web root** — `~/Sites/artifacts`
on macOS, `~/public_html/artifacts` elsewhere (Apache's `mod_userdir` spot),
created on first run. `$ARTIFACT_ROLL_ROOT` overrides that, so the server and
whatever is writing can agree on a root without passing `--root` around. That is a conventional place for files a local server
hands out, and it keeps a directory agents write into out of the checkout.
Point it anywhere else with `--root`, and use `--host 0.0.0.0` to expose it:

```
python3 server.py --root /var/www/artifact_roll --host 0.0.0.0 --port 8787
```

## The directory convention

**`<agent-type>/<agent-id>/` — two levels, and that's the whole contract.** The
first level is the class of agent (`architect`, `builder`, `reviewer`); the
second is one running instance of it. Every `type/id` pair gets its own roll,
oldest artifact at the top, newest at the bottom — so two architects working at
the same time never write into each other's roll.

```
~/Sites/artifacts/     ← the root
  researcher/          ← agent type
    r-01/              ← one instance: a roll
      findings.md
      dashboard/       ← a directory with an index.html is ONE artifact
        index.html
        style.css
    r-02/              ← a second researcher, running concurrently: its own roll
      chart.svg
      metrics.csv
  reviewer/            ← another type
    v-01/
      verdict.json
```

Rolls are ordered by type and then by id, so a type's instances stay adjacent.
They share the type's colour and differ in shade.

Only files at or below `<type>/<id>/` are artifacts. Loose files directly under
the root or under a type directory belong to no instance, so they are skipped
rather than guessed into a roll. Dotfiles, `node_modules`, and `__pycache__` are
ignored. Files inside an `index.html` directory are served as that artifact's
assets, not as separate cards.

Point Claude at it by telling each agent where to write:

```
Write every artifact you produce to ~/Sites/artifacts/<your-agent-type>/<your-agent-id>/,
one file per artifact. Use .md, .svg, .html, .csv, or .json.
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
--root PATH     directory to watch          (default: $ARTIFACT_ROLL_ROOT, else
                                             ~/Sites/artifacts on macOS,
                                             ~/public_html/artifacts elsewhere;
                                             created if missing)
--host ADDR     bind address                (default: 127.0.0.1; use 0.0.0.0 to expose)
--port N        port                        (default: 8787)
--poll SECS     filesystem poll interval    (default: 0.5)
--live-window S how long after its last write a roll keeps its tab
                                            (default: 120; 0 = never expires)
--token STR     require ?t=STR on first load, then cookie-based
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
`KeepAlive`, bound to `127.0.0.1:8787`. It passes no `--root`, so the server
resolves the same default an agent does; setting `ARTIFACT_ROLL_ROOT` in your
shell profile would move the agents but **not** the launch agent, which does not
read your profile. Pin both or neither.

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

## Try it

```
python3 server.py --root ./examples --port 8791
```

`examples/` contains three rolls across two agent types — two concurrent
researchers and one reviewer — worth of markdown, SVG, CSV, JSON, and an HTML
bundle. They are checked-in files, so they start in the archive with an empty
tab strip; `touch examples/reviewer/v-01/notes.md` gives that roll a tab for two
minutes, and `--live-window 0` keeps every roll permanently tabbed.

## Offline behavior

Markdown and math load `marked` and `katex` from a CDN. If those are blocked,
markdown falls back to a built-in mini-renderer and math stays as literal text —
everything else is unaffected.
