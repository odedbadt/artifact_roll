# CLAUDE.md

Working notes for this repo. The README is the user-facing doc (CLI, directory
convention, keys, what renders) — read it first and don't duplicate it here.

## Shape

Stdlib Python + three static files. **No dependencies, no build step, no tests,
no package manager.** Nothing to install; nothing to compile.

```
server.py        600 lines: scanner thread + HTTP handler
web/index.html   static shell (all DOM ids the client uses live here)
web/app.js       1000 lines: one IIFE, ES5-style, no modules
web/styles.css   dark-first, light via prefers-color-scheme
examples/        checked-in sample tree for `--root ./examples`
```

There is no `artifacts/` here and there should not be — `.gitignore` still
lists it only so an explicit `--root ./artifacts` can't dirty the tree.

Run it: `python3 server.py --root ./examples --port 8791` and open the page.
That is also the only test — there is no suite. Use a port other than 8787 when
testing: a launch agent (`com.odedbadt.artifact-roll`, plist in
`~/Library/LaunchAgents`, log in `~/Library/Logs/artifact-roll.log`) already
holds 8787 against the real root from login onwards.

**The artifact root is not in the repo, and has no default.** `--root` is
required: it has to match what agents were told to write to, and a wrong guess
sends a whole run into a directory nobody is watching. The real root is written
down in two places that must agree — the launchd plist
(`~/Library/LaunchAgents/com.odedbadt.artifact-roll.plist`) and the
`~/.claude/skills/artifact-roll` skill. Change one, change the other. A
directory agents write into is data, not source; don't reintroduce a
repo-relative default.

## Server (`server.py`)

- `scan(root)` walks exactly `<root>/<type>/<instance>/`. Loose files above that
  depth are skipped on purpose, never guessed into a roll.
- A sub-directory holding `index.html`/`index.htm` collapses into **one** bundle
  artifact (`bundle_artifact`); its siblings become that artifact's assets.
- `Scanner` (daemon thread) re-scans every `--poll` seconds and bumps `version`
  when the artifact list *or* the derived roll list differs. Clients block on
  `wait_for_change` via `threading.Condition`.
- **Liveness is server-observed, not mtime-based.** `_roll_state` keeps a content
  signature per roll and stamps `_changed[agent] = now` when it differs. The one
  exception is the first scan (`_seeded`), which dates each roll from its newest
  file so pointing at an existing tree doesn't light everything up. Liveness
  decays, so a roll going quiet is itself a version bump worth pushing.
- Routes: `/`, `/app.js`, `/styles.css`, `/api/artifacts` (full snapshot),
  `/events` (SSE, 15s keepalive), `/raw/<relpath>` (`?probe=1`, `?download=1`).
- `?probe=1` injects `PROBE_SNIPPET` into the *response* only, before the last
  `</body>`. Never write it to disk.
- `safe_join` realpaths and rejects escapes; HTML artifacts get
  `sandbox="allow-scripts"` **without** `allow-same-origin` — keep it that way.

## Client (`web/app.js`)

One function does the work: **`apply(artifacts, rollRecs)`**, called on every
snapshot. It reconciles rather than re-renders — cards are keyed by artifact id
in the `cards` Map, rolls by `"type/instance"` in the `rolls` Map. A card is
rebuilt only when `mtime`/`size` changed; otherwise it is just re-positioned.
Adding a feature usually means touching `apply` plus one of `syncTabs` /
`syncSide` / `paintTab`.

State that matters, all module-level: `cards`, `rolls`, `order`, `selected`,
`primed` (suppresses the enter animation on first snapshot), `skew`
(client−server clock, so `relTime` stays honest across machines).

- Only one roll pane is visible; the rest are `hidden`. Tabs hold live rolls
  plus, dimmed, whatever you are reading (`syncTabs`).
- Scroll-follow: a roll `stick`s to the bottom until you scroll away; then
  arrivals become `pending` (jump pill when visible, tab badge when not).
- Roll colour: hue from a hash of the *type*, lightness from the instance's
  **ordinal within its type** — deliberately not hashed, since hashing let two
  live siblings collide.
- Everything CDN-dependent degrades: `marked` → `miniMarkdown`, KaTeX → literal
  text. Don't add a hard dependency on either.
- iframes self-report height by `postMessage` from the probe script; only frames
  with `data-auto-height` are resized (a manual drag deletes that flag).

## Conventions

- ES5-ish JS: `var`, `function`, no build, no modules, no framework. Match it.
- Python: stdlib only, type hints via `from __future__ import annotations`.
- Comments in both files explain *why* a non-obvious choice was made (the mtime
  seeding, the body-vs-documentElement height measure, the ordinal colouring).
  Preserve that style; drive-by rewrites tend to delete the reasoning.
- User-visible behaviour changes belong in the README too — it is detailed and
  currently accurate.
