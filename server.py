#!/usr/bin/env python3
"""artifact_roll -- a thin server that streams a directory of artifacts to a browser.

Point it at a directory that agents dump files into.  The tree is two levels
deep: <root>/<agent-type>/<agent-id>/.  A type is a class of agent (architect,
builder, ...); an id is one running instance of it.  Each <type>/<id> pair is a
"roll" of its own, so two architects working at once never mix.  Below that,
each file (or each sub-directory holding an index.html) is an artifact.

Stdlib only.  Run:  python3 server.py --root ./artifacts --port 8787
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import socket
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(HERE, "web")

IGNORED_NAMES = {"__pycache__", "node_modules", ".git", ".DS_Store", "Thumbs.db"}
INDEX_NAMES = ("index.html", "index.htm")

KIND_BY_EXT = {
    ".svg": "svg",
    ".html": "html",
    ".htm": "html",
    ".md": "md",
    ".markdown": "md",
    ".mdx": "md",
    ".json": "json",
    ".jsonl": "json",
    ".csv": "csv",
    ".tsv": "csv",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".gif": "image",
    ".webp": "image",
    ".avif": "image",
    ".bmp": "image",
    ".ico": "image",
    ".txt": "text",
    ".log": "text",
}

LANG_BY_EXT = {
    ".py": "python",
    ".js": "javascript",
    ".mjs": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".jsx": "jsx",
    ".sh": "bash",
    ".bash": "bash",
    ".zsh": "bash",
    ".rb": "ruby",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".sql": "sql",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".toml": "toml",
    ".ini": "ini",
    ".xml": "xml",
    ".css": "css",
    ".diff": "diff",
    ".patch": "diff",
}

EXTRA_TYPES = {
    ".md": "text/markdown; charset=utf-8",
    ".markdown": "text/markdown; charset=utf-8",
    ".svg": "image/svg+xml",
    ".csv": "text/csv; charset=utf-8",
    ".tsv": "text/tab-separated-values; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".mjs": "text/javascript; charset=utf-8",
}

# Injected into served HTML when ?probe=1, so a sandboxed iframe can report its
# height back to the roll.  Never touches the file on disk.
PROBE_SNIPPET = (
    "<script>(function(){var last=0;function measure(){var d=document,b=d.body;"
    # documentElement.scrollHeight is floored at the iframe's own viewport
    # height, so it can never report a shrink.  Measure the body instead --
    # it is content-sized -- and only fall back to the root element.
    "if(b){var cs=getComputedStyle(b),h=Math.max(b.scrollHeight,b.offsetHeight,"
    "Math.ceil(b.getBoundingClientRect().bottom));"
    "h+=(parseFloat(cs.marginBottom)||0);if(h>0)return h;}"
    "return d.documentElement?d.documentElement.scrollHeight:0;}"
    "function ping(){try{var h=measure();if(h&&Math.abs(h-last)>2){last=h;"
    "parent.postMessage({__artifactRoll:'height',height:h},'*');}}catch(e){}}"
    "addEventListener('load',ping);addEventListener('resize',ping);"
    "if(window.ResizeObserver&&document.body){"
    "try{new ResizeObserver(ping).observe(document.body);}catch(e){}}"
    "setInterval(ping,1500);ping();})();</script>"
)
BODY_CLOSE_RE = re.compile(rb"</body\s*>", re.IGNORECASE)


def classify(name: str) -> tuple[str, str | None]:
    """Return (kind, language) for a filename."""
    ext = os.path.splitext(name)[1].lower()
    if ext in KIND_BY_EXT:
        return KIND_BY_EXT[ext], None
    if ext in LANG_BY_EXT:
        return "code", LANG_BY_EXT[ext]
    return "other", None


def rel_posix(path: str) -> str:
    return path.replace(os.sep, "/")


def skip(name: str) -> bool:
    return name.startswith(".") or name in IGNORED_NAMES


# --------------------------------------------------------------------------
# scanning
# --------------------------------------------------------------------------


def file_artifact(root: str, rel: str, roll: dict) -> dict | None:
    full = os.path.join(root, rel)
    try:
        st = os.stat(full)
    except OSError:
        return None
    name = os.path.basename(rel)
    kind, lang = classify(name)
    return {
        "id": rel_posix(rel),
        "agent": roll["agent"],
        "type": roll["type"],
        "instance": roll["instance"],
        "path": rel_posix(rel),
        "entry": rel_posix(rel),
        "name": name,
        "kind": kind,
        "lang": lang,
        "bundle": False,
        "size": st.st_size,
        "mtime": st.st_mtime,
    }


def bundle_artifact(root: str, reldir: str, roll: dict, index_name: str) -> dict:
    newest = 0.0
    total = 0
    count = 0
    base = os.path.join(root, reldir)
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if not skip(d)]
        for fname in filenames:
            if skip(fname):
                continue
            try:
                st = os.stat(os.path.join(dirpath, fname))
            except OSError:
                continue
            newest = max(newest, st.st_mtime)
            total += st.st_size
            count += 1
    return {
        "id": rel_posix(reldir) + "/",
        "agent": roll["agent"],
        "type": roll["type"],
        "instance": roll["instance"],
        "path": rel_posix(reldir),
        "entry": rel_posix(os.path.join(reldir, index_name)),
        "name": os.path.basename(reldir),
        "kind": "html",
        "lang": None,
        "bundle": True,
        "files": count,
        "size": total,
        "mtime": newest,
    }


def walk_roll(root: str, reldir: str, roll: dict, out: list) -> None:
    try:
        entries = sorted(os.scandir(os.path.join(root, reldir)), key=lambda e: e.name)
    except OSError:
        return
    for entry in entries:
        if skip(entry.name):
            continue
        rel = os.path.join(reldir, entry.name)
        try:
            is_dir = entry.is_dir()
        except OSError:
            continue
        if is_dir:
            # A directory below the roll level that carries an index.html is a
            # single HTML artifact, not a container of artifacts.
            index_name = next(
                (n for n in INDEX_NAMES if os.path.isfile(os.path.join(root, rel, n))),
                None,
            )
            if index_name:
                out.append(bundle_artifact(root, rel, roll, index_name))
            else:
                walk_roll(root, rel, roll, out)
        else:
            art = file_artifact(root, rel, roll)
            if art:
                out.append(art)


def subdirs(path: str) -> list[str]:
    try:
        entries = sorted(os.scandir(path), key=lambda e: e.name)
    except OSError:
        return []
    names = []
    for entry in entries:
        if skip(entry.name):
            continue
        try:
            if entry.is_dir():
                names.append(entry.name)
        except OSError:
            continue
    return names


def scan(root: str) -> list[dict]:
    """Collect artifacts from every <root>/<type>/<instance>/ roll.

    Only that shape counts.  Loose files directly under the root or under a
    type directory belong to no instance, so they are deliberately skipped
    rather than guessed into a roll.
    """
    out: list[dict] = []
    for atype in subdirs(root):
        for instance in subdirs(os.path.join(root, atype)):
            roll = {
                "agent": f"{atype}/{instance}",
                "type": atype,
                "instance": instance,
            }
            walk_roll(root, os.path.join(atype, instance), roll, out)
    out.sort(key=lambda a: (a["type"].lower(), a["instance"].lower(), a["mtime"], a["path"]))
    return out


class Scanner(threading.Thread):
    """Polls the artifact root and bumps a version whenever anything changes.

    Besides the flat artifact list it derives one record per roll, carrying the
    wall-clock moment the roll's contents were last seen to differ.  A roll is
    "live" while that moment is inside the live window -- which is what the UI
    puts in its tab strip.  Liveness decays on its own, so a roll going quiet is
    itself a change worth pushing.
    """

    daemon = True

    def __init__(self, root: str, interval: float, live_window: float):
        super().__init__(name="scanner")
        self.root = root
        self.interval = interval
        self.live_window = live_window
        self.cond = threading.Condition()
        self.version = 0
        self.snapshot: list[dict] = []
        self.rolls: list[dict] = []
        self._sig: dict[str, list] = {}          # agent -> content signature
        self._changed: dict[str, float] = {}     # agent -> when it last differed
        self._seeded = False
        self._stop = threading.Event()

    def run(self) -> None:
        while not self._stop.is_set():
            items = scan(self.root)
            rolls = self._roll_state(items, time.time())
            with self.cond:
                if items != self.snapshot or rolls != self.rolls:
                    self.snapshot = items
                    self.rolls = rolls
                    self.version += 1
                    self.cond.notify_all()
            self._stop.wait(self.interval)

    def _roll_state(self, items: list[dict], now: float) -> list[dict]:
        groups: dict[str, list[dict]] = {}
        for art in items:
            groups.setdefault(art["agent"], []).append(art)

        for agent in list(self._sig):
            if agent not in groups:
                self._sig.pop(agent, None)
                self._changed.pop(agent, None)

        out = []
        for agent, arts in groups.items():
            sig = [(a["id"], a["mtime"], a["size"]) for a in arts]
            if self._sig.get(agent) != sig:
                first_sighting = agent not in self._sig
                self._sig[agent] = sig
                # On the very first scan, date each roll from its newest file
                # instead of from now -- otherwise pointing the server at an
                # existing tree would light every agent up as if it had just
                # written.  Anything appearing later really did just change.
                if first_sighting and not self._seeded:
                    self._changed[agent] = min(now, max(a["mtime"] for a in arts))
                else:
                    self._changed[agent] = now
            last = self._changed[agent]
            out.append({
                "agent": agent,
                "type": arts[0]["type"],
                "instance": arts[0]["instance"],
                "count": len(arts),
                "lastChange": last,
                "live": self.live_window <= 0 or (now - last) < self.live_window,
            })
        self._seeded = True
        out.sort(key=lambda r: (r["type"].lower(), r["instance"].lower()))
        return out

    def current(self) -> tuple[int, list[dict], list[dict]]:
        with self.cond:
            return self.version, self.snapshot, self.rolls

    def wait_for_change(self, seen: int, timeout: float):
        with self.cond:
            if self.version != seen:
                return self.version, self.snapshot, self.rolls
            self.cond.wait(timeout)
            if self.version != seen:
                return self.version, self.snapshot, self.rolls
            return self.version, None, None

    def stop(self) -> None:
        self._stop.set()
        with self.cond:
            self.cond.notify_all()


# --------------------------------------------------------------------------
# http
# --------------------------------------------------------------------------


def safe_join(root: str, rel: str) -> str | None:
    """Resolve rel under root, refusing anything that escapes."""
    rel = unquote(rel).lstrip("/")
    if not rel:
        return None
    candidate = os.path.realpath(os.path.join(root, rel))
    root_real = os.path.realpath(root)
    if candidate != root_real and not candidate.startswith(root_real + os.sep):
        return None
    return candidate


def content_type(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in EXTRA_TYPES:
        return EXTRA_TYPES[ext]
    guessed, _ = mimetypes.guess_type(path)
    if guessed:
        if guessed.startswith("text/") and "charset" not in guessed:
            return guessed + "; charset=utf-8"
        return guessed
    return "application/octet-stream"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "artifact_roll"
    sys_version = ""

    # injected by serve()
    scanner: Scanner
    root: str
    token: str | None
    verbose: bool

    def log_message(self, fmt: str, *args) -> None:
        if self.verbose:
            super().log_message(fmt, *args)

    # -- helpers ---------------------------------------------------------
    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8")

    def _text(self, code: int, message: str) -> None:
        self._send(code, message.encode("utf-8"), "text/plain; charset=utf-8")

    def _authorized(self, query: dict) -> bool:
        if not self.token:
            return True
        supplied = (query.get("t") or [None])[0]
        if supplied == self.token:
            return True
        cookie = self.headers.get("Cookie", "")
        return f"ar_token={self.token}" in cookie

    # -- routing ---------------------------------------------------------
    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if not self._authorized(query):
            self._text(HTTPStatus.UNAUTHORIZED, "unauthorized: append ?t=<token>\n")
            return

        cookie_hdr = {}
        if self.token and (query.get("t") or [None])[0] == self.token:
            cookie_hdr["Set-Cookie"] = f"ar_token={self.token}; Path=/; SameSite=Lax"

        if path in ("/", "/index.html"):
            self._serve_web("index.html", cookie_hdr)
        elif path in ("/app.js", "/styles.css"):
            self._serve_web(path.lstrip("/"), cookie_hdr)
        elif path == "/api/artifacts":
            version, items, rolls = self.scanner.current()
            self._json({
                "version": version,
                "root": self.root,
                "liveWindow": self.scanner.live_window,
                "now": time.time(),
                "rolls": rolls,
                "artifacts": items,
            })
        elif path == "/events":
            self._serve_events()
        elif path.startswith("/raw/"):
            self._serve_raw(path[len("/raw/"):], query)
        else:
            self._text(HTTPStatus.NOT_FOUND, "not found\n")

    def _serve_web(self, name: str, extra: dict) -> None:
        full = os.path.join(WEB_DIR, name)
        try:
            with open(full, "rb") as fh:
                body = fh.read()
        except OSError:
            self._text(HTTPStatus.NOT_FOUND, f"missing asset: {name}\n")
            return
        self._send(HTTPStatus.OK, body, content_type(full), extra)

    def _serve_raw(self, rel: str, query: dict) -> None:
        full = safe_join(self.root, rel)
        if not full or not os.path.isfile(full):
            self._text(HTTPStatus.NOT_FOUND, "no such artifact\n")
            return
        try:
            with open(full, "rb") as fh:
                body = fh.read()
        except OSError as exc:
            self._text(HTTPStatus.INTERNAL_SERVER_ERROR, f"read failed: {exc}\n")
            return

        ctype = content_type(full)
        if query.get("probe") and ctype.startswith("text/html"):
            snippet = PROBE_SNIPPET.encode("utf-8")
            matches = list(BODY_CLOSE_RE.finditer(body))
            if matches:
                cut = matches[-1].start()
                body = body[:cut] + snippet + body[cut:]
            else:
                body = body + snippet

        extra = {}
        if query.get("download"):
            extra["Content-Disposition"] = f'attachment; filename="{os.path.basename(full)}"'
        self._send(HTTPStatus.OK, body, ctype, extra)

    def _serve_events(self) -> None:
        self.close_connection = True
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()

        seen = -1
        try:
            while True:
                version, items, rolls = self.scanner.wait_for_change(seen, 15.0)
                if items is None:
                    self.wfile.write(b": keepalive\n\n")
                else:
                    seen = version
                    payload = json.dumps({
                        "version": version,
                        "now": time.time(),
                        "rolls": rolls,
                        "artifacts": items,
                    })
                    self.wfile.write(b"event: snapshot\ndata: " + payload.encode("utf-8") + b"\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError, ValueError):
            pass


def local_ip() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def serve(root: str, host: str, port: int, interval: float, live_window: float,
          token: str | None, verbose: bool) -> None:
    os.makedirs(root, exist_ok=True)
    root = os.path.realpath(root)

    scanner = Scanner(root, interval, live_window)
    scanner.start()

    handler = type("BoundHandler", (Handler,), {
        "scanner": scanner,
        "root": root,
        "token": token,
        "verbose": verbose,
    })

    httpd = ThreadingHTTPServer((host, port), handler)
    httpd.daemon_threads = True

    shown = host if host not in ("0.0.0.0", "::") else local_ip()
    suffix = f"?t={token}" if token else ""
    # flush=True: stdout is block-buffered when redirected, so without this the
    # banner never appears under nohup/systemd -- exactly the remote case.
    print(f"artifact_roll  serving {root}", flush=True)
    print(f"               http://{shown}:{port}/{suffix}", flush=True)
    if host in ("0.0.0.0", "::"):
        print(f"               http://127.0.0.1:{port}/{suffix}  (local)", flush=True)
    window = f"{live_window:g}s" if live_window > 0 else "never (always live)"
    print(f"               polling every {interval:g}s, rolls go quiet after {window}", flush=True)
    print("               ctrl-c to stop", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        scanner.stop()
        httpd.server_close()


def default_root() -> str:
    """Where artifacts live when --root is not given.

    A directory agents write into is data, not source, so it does not belong
    inside the checkout.  The per-user web root is the conventional spot for
    "files a local server hands out" -- ~/Sites on macOS, ~/public_html
    everywhere else (Apache mod_userdir) -- and unlike /var/www it is writable
    without sudo, which matters because serve() creates the root and agents
    write into it.  Whichever already exists wins; otherwise the platform's
    preferred one is created.

    $ARTIFACT_ROLL_ROOT overrides all of it, so an agent and the server can
    agree on a root without passing --root around.
    """
    env = os.environ.get("ARTIFACT_ROLL_ROOT")
    if env:
        return os.path.expanduser(env)
    home = os.path.expanduser("~")
    names = ["Sites", "public_html"] if sys.platform == "darwin" else ["public_html", "Sites"]
    for name in names:
        if os.path.isdir(os.path.join(home, name)):
            return os.path.join(home, name, "artifacts")
    return os.path.join(home, names[0], "artifacts")


def main() -> None:
    ap = argparse.ArgumentParser(description="Live-roll a directory of agent artifacts in the browser.")
    ap.add_argument("--root", default=default_root(),
                    help="directory agents dump artifacts into "
                         f"(default: {default_root()}, created if missing)")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (use 0.0.0.0 to expose remotely)")
    ap.add_argument("--port", type=int, default=8787, help="port (default: 8787)")
    ap.add_argument("--poll", type=float, default=0.5, help="filesystem poll interval in seconds")
    ap.add_argument("--live-window", type=float, default=120.0, metavar="SECS",
                    help="how long after its last write a roll keeps its tab (0 = forever)")
    ap.add_argument("--token", default=None, help="require ?t=TOKEN before serving anything")
    ap.add_argument("-v", "--verbose", action="store_true", help="log every request")
    args = ap.parse_args()
    serve(args.root, args.host, args.port, args.poll, args.live_window, args.token, args.verbose)


if __name__ == "__main__":
    main()
