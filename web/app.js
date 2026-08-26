/* artifact roll -- live client.
 *
 * Holds one column ("roll") per agent, ordered oldest -> newest, and reconciles
 * it against snapshots pushed over SSE.  New artifacts animate in at the bottom.
 */
(function () {
  "use strict";

  var els = {
    rolls: document.getElementById("rolls"),
    empty: document.getElementById("empty"),
    emptyRoot: document.getElementById("empty-root"),
    root: document.getElementById("root-path"),
    counts: document.getElementById("counts"),
    status: document.getElementById("status"),
    follow: document.getElementById("follow"),
    overlay: document.getElementById("overlay"),
    overlayTitle: document.getElementById("overlay-title"),
    overlayBody: document.getElementById("overlay-body"),
    overlayRaw: document.getElementById("overlay-raw"),
    overlayClose: document.getElementById("overlay-close")
  };

  var cards = new Map();   // id -> {el, art, body}
  var rolls = new Map();   // agent -> {el, body, countEl, jumpEl, pending}
  var primed = false;      // first snapshot renders without the jump-in animation

  // ---------------------------------------------------------------- utils

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function rawUrl(path, extra) {
    var encoded = String(path).split("/").map(encodeURIComponent).join("/");
    return "/raw/" + encoded + (extra ? "?" + extra : "");
  }

  function artUrl(art, extra) {
    var q = "v=" + Math.round(art.mtime * 1000);
    return rawUrl(art.entry, extra ? extra + "&" + q : q);
  }

  function humanSize(bytes) {
    if (bytes == null) return "";
    var units = ["B", "K", "M", "G"], i = 0, n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + units[i];
  }

  function relTime(mtime) {
    var secs = Date.now() / 1000 - mtime;
    if (secs < 5) return "now";
    if (secs < 60) return Math.floor(secs) + "s";
    if (secs < 3600) return Math.floor(secs / 60) + "m";
    if (secs < 86400) return Math.floor(secs / 3600) + "h";
    return Math.floor(secs / 86400) + "d";
  }

  var AGENT_HUES = [205, 145, 35, 280, 0, 175, 320, 60];
  function agentColor(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return "hsl(" + AGENT_HUES[h % AGENT_HUES.length] + " 70% 58%)";
  }

  function fetchText(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    });
  }

  function showError(container, err) {
    container.replaceChildren(el("div", "err", String(err && err.message || err)));
  }

  // ------------------------------------------------------- markdown + math

  // Used when the marked CDN is unavailable. Covers the common cases; anything
  // exotic simply renders as plain text rather than breaking the roll.
  function miniMarkdown(src) {
    var blocks = [], html = [];
    src = src.replace(/\r\n?/g, "\n").replace(/```([\w+-]*)\n([\s\S]*?)```/g, function (_, lang, code) {
      blocks.push('<pre><code class="language-' + escapeHtml(lang) + '">' + escapeHtml(code) + "</code></pre>");
      return "\n\u0000" + (blocks.length - 1) + "\u0000\n";
    });

    function inline(t) {
      return escapeHtml(t)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|\W)\*([^*]+)\*/g, "$1<em>$2</em>")
        .replace(/~~([^~]+)~~/g, "<del>$1</del>");
    }

    var lines = src.split("\n"), i = 0, para = [], list = null;

    function flushPara() {
      if (para.length) { html.push("<p>" + inline(para.join(" ")) + "</p>"); para = []; }
    }
    function flushList() {
      if (list) { html.push("<" + list.tag + ">" + list.items.map(function (t) {
        return "<li>" + inline(t) + "</li>";
      }).join("") + "</" + list.tag + ">"); list = null; }
    }
    function flush() { flushPara(); flushList(); }

    for (; i < lines.length; i++) {
      var line = lines[i], m;
      if (/^\u0000\d+\u0000$/.test(line.trim())) {
        flush(); html.push(blocks[+line.trim().replace(/\u0000/g, "")]); continue;
      }
      if (!line.trim()) { flush(); continue; }
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        flush(); html.push("<h" + m[1].length + ">" + inline(m[2]) + "</h" + m[1].length + ">"); continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); html.push("<hr>"); continue; }
      if ((m = line.match(/^\s*>\s?(.*)$/))) {
        flush(); html.push("<blockquote>" + inline(m[1]) + "</blockquote>"); continue;
      }
      if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
        flushPara();
        if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; }
        list.items.push(m[1]); continue;
      }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        flushPara();
        if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; }
        list.items.push(m[1]); continue;
      }
      flushList();
      para.push(line.trim());
    }
    flush();
    return html.join("\n");
  }

  function markdownToHtml(text) {
    if (window.marked) {
      try {
        return window.marked.parse(text, { gfm: true, breaks: false });
      } catch (e) { /* fall through */ }
    }
    return miniMarkdown(text);
  }

  function typesetMath(node) {
    if (!window.renderMathInElement) return;
    try {
      window.renderMathInElement(node, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "\\(", right: "\\)", display: false },
          { left: "$", right: "$", display: false }
        ],
        ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
        throwOnError: false
      });
    } catch (e) { /* math is a nicety; never break the card over it */ }
  }

  // --------------------------------------------------------------- parsing

  // RFC 4180-ish: quoted fields, doubled quotes, embedded newlines.
  function parseDelimited(text, delim) {
    var rows = [], row = [], field = "", inQuotes = false, i = 0;
    text = text.replace(/\r\n?/g, "\n");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    for (; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"' && field === "") {
        inQuotes = true;
      } else if (c === delim) {
        row.push(field); field = "";
      } else if (c === "\n") {
        row.push(field); rows.push(row); row = []; field = "";
      } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.length > 1 || (r[0] || "").trim() !== ""; });
  }

  function highlightJson(value) {
    var json = JSON.stringify(value, null, 2);
    return escapeHtml(json).replace(
      /("(\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(\.\d+)?([eE][+-]?\d+)?/g,
      function (match, str, _esc, colon) {
        var cls;
        if (str) cls = colon ? "tok-key" : "tok-str";
        else if (match === "true" || match === "false") cls = "tok-bool";
        else if (match === "null") cls = "tok-null";
        else cls = "tok-num";
        return '<span class="' + cls + '">' + match + "</span>";
      }
    );
  }

  // ------------------------------------------------------------- renderers

  var MAX_ROWS_IN_CARD = 400;

  function renderMd(art, host, full) {
    host.replaceChildren(el("div", "placeholder", "loading…"));
    fetchText(artUrl(art)).then(function (text) {
      var box = el("div", "md");
      box.innerHTML = markdownToHtml(text);
      box.querySelectorAll("a[href]").forEach(function (a) {
        if (!/^(https?:)?\/\//.test(a.getAttribute("href"))) return;
        a.target = "_blank"; a.rel = "noopener noreferrer";
      });
      // Resolve relative images against the artifact's own directory.
      var base = art.entry.split("/").slice(0, -1).join("/");
      box.querySelectorAll("img[src]").forEach(function (img) {
        var src = img.getAttribute("src");
        if (/^(https?:|data:|\/)/.test(src)) return;
        img.src = rawUrl(base ? base + "/" + src : src);
      });
      host.replaceChildren(box);
      typesetMath(box);
    }).catch(function (e) { showError(host, e); });
    void full;
  }

  function renderHtml(art, host, full) {
    var frame = el("iframe", "frame");
    frame.setAttribute("sandbox", "allow-scripts allow-popups allow-forms allow-modals");
    frame.setAttribute("loading", "lazy");
    frame.src = artUrl(art, "probe=1");
    if (full) {
      host.replaceChildren(frame);
      return;
    }
    frame.dataset.autoHeight = "1";
    host.replaceChildren(frame);

    var grip = el("div", "resize");
    grip.title = "drag to resize";
    grip.addEventListener("pointerdown", function (down) {
      down.preventDefault();
      var startY = down.clientY, startH = frame.getBoundingClientRect().height;
      delete frame.dataset.autoHeight;         // manual size wins from here on
      grip.setPointerCapture(down.pointerId);
      function move(ev) {
        frame.style.height = Math.max(80, startH + (ev.clientY - startY)) + "px";
      }
      function up() {
        grip.releasePointerCapture(down.pointerId);
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
      }
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    });
    host.appendChild(grip);
  }

  function renderSvg(art, host, full) {
    var img = el("img");
    img.src = artUrl(art);
    img.alt = art.name;
    var wrap = el("div", "svg-wrap");
    wrap.appendChild(img);
    host.replaceChildren(wrap);
    void full;
  }

  function renderImage(art, host, full) {
    var img = el("img");
    img.src = artUrl(art);
    img.alt = art.name;
    img.loading = "lazy";
    var wrap = el("div", "img-wrap");
    wrap.appendChild(img);
    host.replaceChildren(wrap);
    void full;
  }

  function renderJson(art, host, full) {
    host.replaceChildren(el("div", "placeholder", "loading…"));
    fetchText(artUrl(art)).then(function (text) {
      var value, pre = el("pre", "json");
      try {
        if (/\.jsonl$/i.test(art.name)) {
          value = text.split("\n").filter(function (l) { return l.trim(); })
                      .map(function (l) { return JSON.parse(l); });
        } else {
          value = JSON.parse(text);
        }
        pre.innerHTML = highlightJson(value);
      } catch (e) {
        pre.textContent = text;             // malformed or mid-write: show as-is
      }
      host.replaceChildren(pre);
    }).catch(function (e) { showError(host, e); });
    void full;
  }

  function renderCsv(art, host, full) {
    host.replaceChildren(el("div", "placeholder", "loading…"));
    fetchText(artUrl(art)).then(function (text) {
      var delim = /\.tsv$/i.test(art.name) ? "\t" : ",";
      var rows = parseDelimited(text, delim);
      if (!rows.length) {
        host.replaceChildren(el("div", "placeholder", "empty file"));
        return;
      }
      var limit = full ? rows.length : Math.min(rows.length, MAX_ROWS_IN_CARD + 1);
      var table = el("table", "csv");
      var thead = el("thead"), hr = el("tr");
      rows[0].forEach(function (h) { hr.appendChild(el("th", null, h)); });
      thead.appendChild(hr);
      table.appendChild(thead);

      var tbody = el("tbody");
      for (var r = 1; r < limit; r++) {
        var tr = el("tr");
        for (var c = 0; c < rows[0].length; c++) {
          var v = rows[r][c] == null ? "" : rows[r][c];
          var td = el("td", v !== "" && !isNaN(Number(v)) ? "num" : null, v);
          td.title = v;
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);

      var scroller = el("div", "scroller");
      scroller.appendChild(table);
      host.replaceChildren(scroller);

      var shown = limit - 1, total = rows.length - 1;
      var note = shown < total
        ? total + " rows × " + rows[0].length + " cols — showing first " + shown + ", expand for all"
        : total + " rows × " + rows[0].length + " cols";
      host.appendChild(el("div", "csv-note", note));
    }).catch(function (e) { showError(host, e); });
  }

  function renderCode(art, host, full) {
    host.replaceChildren(el("div", "placeholder", "loading…"));
    fetchText(artUrl(art)).then(function (text) {
      var pre = el("pre", "code", text);
      host.replaceChildren(pre);
    }).catch(function (e) { showError(host, e); });
    void full;
  }

  function renderOther(art, host) {
    var box = el("div", "placeholder");
    box.textContent = art.name + " — " + humanSize(art.size) + " · ";
    var a = el("a", "icon-btn", "download ↓");
    a.href = rawUrl(art.entry, "download=1");
    box.appendChild(a);
    host.replaceChildren(box);
  }

  var RENDERERS = {
    md: renderMd,
    html: renderHtml,
    svg: renderSvg,
    image: renderImage,
    json: renderJson,
    csv: renderCsv,
    code: renderCode,
    text: renderCode,
    other: renderOther
  };

  function renderInto(art, host, full) {
    (RENDERERS[art.kind] || renderOther)(art, host, full);
  }

  // iframes report their content height back through the probe script
  window.addEventListener("message", function (ev) {
    var data = ev.data;
    if (!data || data.__artifactRoll !== "height") return;
    document.querySelectorAll("iframe.frame[data-auto-height]").forEach(function (frame) {
      if (frame.contentWindow !== ev.source) return;
      frame.style.height = Math.min(Math.max(data.height + 2, 80), 900) + "px";
    });
  });

  // ------------------------------------------------------------ card + roll

  function buildCard(art) {
    var card = el("article", "card");
    card.dataset.id = art.id;

    var head = el("header", "card-head");
    head.appendChild(el("span", "kind", art.bundle ? "site" : art.kind));

    var title = el("span", "card-title", art.name);
    title.title = art.path;
    head.appendChild(title);

    var sub = el("span", "card-sub", relTime(art.mtime));
    sub.dataset.mtime = art.mtime;
    head.appendChild(sub);

    var actions = el("div", "card-actions");

    var collapse = el("button", "icon-btn", "▾");
    collapse.title = "collapse";
    collapse.addEventListener("click", function () {
      card.classList.toggle("collapsed");
      collapse.textContent = card.classList.contains("collapsed") ? "▸" : "▾";
    });

    var expand = el("button", "icon-btn", "⛶");
    expand.title = "expand";
    expand.addEventListener("click", function () { openOverlay(art); });

    var open = el("a", "icon-btn", "↗");
    open.title = "open raw in a new tab";
    open.href = artUrl(art);
    open.target = "_blank";
    open.rel = "noopener";

    actions.append(collapse, expand, open);
    head.appendChild(actions);

    title.addEventListener("click", function () { openOverlay(art); });

    var body = el("div", "card-body");
    card.append(head, body);
    renderInto(art, body, false);
    return { el: card, body: body, sub: sub, art: art };
  }

  function buildRoll(agent) {
    var col = el("section", "roll");
    col.dataset.agent = agent;

    var head = el("header", "roll-head");
    var dot = el("span", "roll-dot");
    dot.style.background = agentColor(agent);
    head.appendChild(dot);
    head.appendChild(el("span", "roll-name", agent));
    var count = el("span", "roll-count", "0");
    head.appendChild(count);

    var body = el("div", "roll-body");

    var jump = el("button", "jump", "new ↓");
    jump.hidden = true;
    jump.addEventListener("click", function () {
      body.scrollTop = body.scrollHeight;
    });

    body.addEventListener("scroll", function () {
      if (atBottom(body)) { entry.pending = 0; jump.hidden = true; }
    });

    col.append(head, body, jump);
    var entry = { el: col, body: body, countEl: count, jumpEl: jump, pending: 0 };
    return entry;
  }

  function atBottom(node) {
    return node.scrollHeight - node.scrollTop - node.clientHeight < 60;
  }

  // ------------------------------------------------------------- reconcile

  function apply(artifacts) {
    var byId = new Map();
    var byAgent = new Map();
    artifacts.forEach(function (a) {
      byId.set(a.id, a);
      if (!byAgent.has(a.agent)) byAgent.set(a.agent, []);
      byAgent.get(a.agent).push(a);
    });

    // remove vanished artifacts
    cards.forEach(function (entry, id) {
      if (byId.has(id)) return;
      cards.delete(id);
      entry.el.classList.add("leaving");
      setTimeout(function () { entry.el.remove(); }, 220);
    });

    // remove empty rolls
    rolls.forEach(function (roll, agent) {
      if (byAgent.has(agent)) return;
      rolls.delete(agent);
      roll.el.remove();
    });

    var agents = Array.from(byAgent.keys()).sort(function (a, b) {
      return a.localeCompare(b);
    });

    agents.forEach(function (agent, index) {
      var roll = rolls.get(agent);
      if (!roll) {
        roll = buildRoll(agent);
        rolls.set(agent, roll);
      }
      // keep columns in sorted order
      var current = els.rolls.children[index];
      if (current !== roll.el) els.rolls.insertBefore(roll.el, current || null);

      var stick = els.follow.checked && atBottom(roll.body);
      var arrived = 0;

      var desired = byAgent.get(agent);
      desired.forEach(function (art, position) {
        var entry = cards.get(art.id);
        if (!entry) {
          entry = buildCard(art);
          cards.set(art.id, entry);
          if (primed) {
            entry.el.classList.add("enter");
            arrived++;
          }
        } else if (entry.art.mtime !== art.mtime || entry.art.size !== art.size) {
          entry.art = art;
          entry.sub.textContent = relTime(art.mtime);
          entry.sub.dataset.mtime = art.mtime;
          renderInto(art, entry.body, false);
          entry.el.classList.remove("updated");
          void entry.el.offsetWidth;         // restart the flash animation
          entry.el.classList.add("updated");
        }
        var at = roll.body.children[position];
        if (at !== entry.el) roll.body.insertBefore(entry.el, at || null);
      });

      roll.countEl.textContent = desired.length;

      if (arrived) {
        if (stick) {
          roll.body.scrollTop = roll.body.scrollHeight;
        } else {
          roll.pending += arrived;
          roll.jumpEl.textContent = roll.pending + " new ↓";
          roll.jumpEl.hidden = false;
        }
      }
    });

    els.counts.textContent = artifacts.length + (artifacts.length === 1 ? " artifact" : " artifacts")
      + " · " + agents.length + (agents.length === 1 ? " agent" : " agents");
    els.empty.classList.toggle("show", artifacts.length === 0);
    primed = true;
  }

  // --------------------------------------------------------------- overlay

  var overlayArt = null;

  function openOverlay(art) {
    overlayArt = art;
    els.overlayTitle.textContent = art.path;   // already agent-prefixed
    els.overlayRaw.href = artUrl(art);
    els.overlayBody.replaceChildren();
    renderInto(art, els.overlayBody, true);
    els.overlay.hidden = false;
  }

  function closeOverlay() {
    els.overlay.hidden = true;
    els.overlayBody.replaceChildren();
    overlayArt = null;
  }

  els.overlayClose.addEventListener("click", closeOverlay);
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && !els.overlay.hidden) closeOverlay();
  });

  // ---------------------------------------------------------------- stream

  function setStatus(kind, label) {
    els.status.className = "status " + kind;
    els.status.lastElementChild.textContent = label;
  }

  function connect() {
    var source = new EventSource("/events");
    source.addEventListener("open", function () { setStatus("live", "live"); });
    source.addEventListener("snapshot", function (ev) {
      setStatus("live", "live");
      try {
        apply(JSON.parse(ev.data).artifacts);
      } catch (e) {
        console.error("bad snapshot", e);
      }
    });
    source.addEventListener("error", function () {
      setStatus("connecting", "reconnecting");
      // EventSource retries on its own; a server restart just re-syncs.
    });
  }

  fetch("/api/artifacts", { cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      els.root.textContent = data.root;
      els.emptyRoot.textContent = data.root;
      apply(data.artifacts);
      connect();
    })
    .catch(function (e) {
      setStatus("down", "server unreachable");
      console.error(e);
    });

  // keep the relative timestamps honest
  setInterval(function () {
    cards.forEach(function (entry) {
      entry.sub.textContent = relTime(entry.art.mtime);
    });
  }, 10000);

  // re-render the overlay when its artifact changes underneath it
  setInterval(function () {
    if (!overlayArt) return;
    var live = cards.get(overlayArt.id);
    if (live && live.art.mtime !== overlayArt.mtime) openOverlay(live.art);
  }, 2000);
})();
