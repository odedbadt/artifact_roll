# artifact roll

A thin server that turns a directory into a live, scrolling wall of artifacts.

Agents (Claude CLI or anything else) drop files into a directory. Open the page
once and leave it — every new file slides in at the bottom of its agent's column.
No build step, no dependencies, stdlib Python only.

```
python3 server.py --root ./artifacts --host 0.0.0.0 --port 8787
```

Then open `http://<host>:8787/`.

## The directory convention

**One top-level directory per agent — that's the whole contract.** Each becomes
a column ("roll"), oldest artifact at the top, newest at the bottom.

```
artifacts/
  researcher/          ← a roll
    findings.md
    chart.svg
    metrics.csv
    dashboard/         ← a directory with an index.html is ONE artifact
      index.html
      style.css
  reviewer/            ← another roll
    verdict.json
```

Loose files at the root land in a roll called `main`. Dotfiles, `node_modules`,
and `__pycache__` are ignored. Files inside an `index.html` directory are served
as that artifact's assets, not as separate cards.

Point Claude at it by telling it where to write:

```
Write every artifact you produce to ./artifacts/<your-agent-name>/,
one file per artifact. Use .md, .svg, .html, .csv, or .json.
```

## What renders

| Kind | Rendered as |
|---|---|
| `.md` `.markdown` `.mdx` | GitHub-flavored markdown, with `$…$` / `$$…$$` math via KaTeX |
| `.svg` | inline image, scaled to the column |
| `.html` `.htm` | sandboxed iframe, auto-sized to its content, drag-resizable |
| *dir with `index.html`* | same, with relative assets resolving normally |
| `.json` `.jsonl` | pretty-printed and syntax-highlighted |
| `.csv` `.tsv` | table with sticky headers and right-aligned numerics |
| `.png` `.jpg` `.gif` `.webp` `.avif` | inline image |
| `.py` `.js` `.sql` `.yaml` … | monospace source block |
| anything else | name, size, and a download link |

Every card has **⛶ expand** (full-screen), **↗ open raw**, and **▾ collapse**.

## Live updates

The server polls the tree (default every 0.5s) and pushes a snapshot over SSE
whenever anything is added, changed, or deleted. Edits re-render in place and
flash green; deletions fade out.

Each column sticks to the bottom while you are already at the bottom. Scroll up
to read something and it stops chasing — a **`N new ↓`** pill appears instead.
The **follow** switch in the header disables auto-scroll globally.

## Options

```
--root PATH     directory to watch          (default: ./artifacts)
--host ADDR     bind address                (default: 127.0.0.1; use 0.0.0.0 to expose)
--port N        port                        (default: 8787)
--poll SECS     filesystem poll interval    (default: 0.5)
--token STR     require ?t=STR on first load, then cookie-based
-v              log every request
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

`examples/` contains two agents' worth of markdown, SVG, CSV, JSON, and an
HTML bundle.

## Offline behavior

Markdown and math load `marked` and `katex` from a CDN. If those are blocked,
markdown falls back to a built-in mini-renderer and math stays as literal text —
everything else is unaffected.
