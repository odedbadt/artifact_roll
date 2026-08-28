/* artifact roll -- live client.
 *
 * One pane ("roll") per agent instance -- a <type>/<id> pair, so two agents of
 * the same type running at once never share a pane -- ordered oldest -> newest
 * and reconciled against snapshots pushed over SSE.  New artifacts animate in
 * at the bottom.
 *
 * Only one roll is on screen at a time.  The tab strip holds exactly the rolls
 * an agent is currently writing to (the server decides that; see --live-window),
 * so it empties itself as agents finish.  Everything ever written, live or long
 * finished, stays reachable through the archive pane on the left.
 */
(function () {
  "use strict";

  var els = {
    rolls: document.getElementById("rolls"),
    tabs: document.getElementById("tabs"),
    side: document.getElementById("side"),
    sideList: document.getElementById("side-list"),
    sideEmpty: document.getElementById("side-empty"),
    sideFilter: document.getElementById("side-filter"),
    sideToggle: document.getElementById("side-toggle"),
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

  var cards = new Map();   // artifact id -> {el, art, body, sub}
  var rolls = new Map();   // "type/id" -> roll entry (see buildRoll)
  var order = [];          // agents, in tab / archive order
  var selected = null;     // agent whose pane is on screen
  var primed = false;      // first snapshot renders without the jump-in animation
  var skew = 0;            // clientClock - serverClock, so mtimes read honestly

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
    var secs = Date.now() / 1000 - skew - mtime;
    if (secs < 5) return "now";
    if (secs < 60) return Math.floor(secs) + "s";
    if (secs < 3600) return Math.floor(secs / 60) + "m";
    if (secs < 86400) return Math.floor(secs / 3600) + "h";
    return Math.floor(secs / 86400) + "d";
  }

  var AGENT_HUES = [205, 145, 35, 280, 0, 175, 320, 60];
  var INSTANCE_SHADES = [58, 72, 44, 65, 51];

  function hashOf(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return h;
  }

  // Hue identifies the agent type; instances of one type share it and separate
  // by lightness, so sibling columns read as siblings at a glance.  The shade
  // comes from the instance's position within its type rather than from a hash
  // of its id -- hashing lets two live siblings collide on the same shade.
  function rollColor(type, ordinal) {
    var hue = AGENT_HUES[hashOf(type) % AGENT_HUES.length];
    return "hsl(" + hue + " 70% " + INSTANCE_SHADES[ordinal % INSTANCE_SHADES.length] + "%)";
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

  function buildRoll(art) {
    var pane = el("section", "roll");
    pane.dataset.agent = art.agent;
    pane.hidden = true;

    var head = el("header", "roll-head");
    var dot = el("span", "roll-dot");
    var label = el("span", "roll-label");
    label.appendChild(el("span", "roll-name", art.type));
    label.appendChild(el("span", "roll-instance", "· " + art.instance));
    label.title = art.agent;
    var state = el("span", "roll-state");
    var count = el("span", "roll-count", "0");
    head.append(dot, label, state, count);

    var body = el("div", "roll-body");
    var inner = el("div", "roll-inner");
    body.appendChild(inner);

    var jump = el("button", "jump", "new ↓");
    jump.hidden = true;
    jump.addEventListener("click", function () { toBottom(entry); });

    body.addEventListener("scroll", function () {
      entry.stick = atBottom(body);
      if (entry.stick) { entry.pending = 0; jump.hidden = true; paintTab(entry); }
    });

    pane.append(head, body, jump);

    var entry = {
      agent: art.agent, type: art.type, instance: art.instance,
      el: pane, body: body, inner: inner,
      dotEl: dot, stateEl: state, countEl: count, jumpEl: jump,
      arts: [], count: 0, color: "",
      live: false, lastChange: art.mtime,
      pending: 0,        // artifacts that landed while you were not looking
      stick: true,       // follow the bottom until you scroll away from it
      flash: false,      // the tab should pulse on the next paint
      tabEl: null, tabBadge: null
    };
    return entry;
  }

  function atBottom(node) {
    return node.scrollHeight - node.scrollTop - node.clientHeight < 60;
  }

  function toBottom(roll) {
    roll.body.scrollTop = roll.body.scrollHeight;
    roll.stick = true;
    roll.pending = 0;
    roll.jumpEl.hidden = true;
    paintTab(roll);
  }

  // ------------------------------------------------------------------- tabs

  var tabsNone = el("span", "tabs-none", "no agent is writing — pick a roll from the archive");

  function buildTab(roll) {
    var tab = el("button", "tab");
    tab.type = "button";
    tab.setAttribute("role", "tab");
    tab.dataset.agent = roll.agent;
    tab.appendChild(el("span", "tab-dot"));
    var label = el("span", "tab-label");
    label.appendChild(el("span", "tab-type", roll.type));
    label.appendChild(el("span", "tab-inst", roll.instance));
    tab.appendChild(label);
    var badge = el("span", "tab-badge");
    badge.hidden = true;
    tab.appendChild(badge);
    tab.addEventListener("click", function () { select(roll.agent); });
    roll.tabEl = tab;
    roll.tabBadge = badge;
    return tab;
  }

  function paintTab(roll) {
    var tab = roll.tabEl;
    if (!tab) return;
    var active = roll.agent === selected;
    tab.classList.toggle("active", active);
    tab.classList.toggle("quiet", !roll.live);
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.title = roll.agent + (roll.live ? " — writing" : " — quiet for " + relTime(roll.lastChange));
    tab.firstChild.style.background = roll.color;
    var show = !active && roll.pending > 0;
    roll.tabBadge.hidden = !show;
    if (show) roll.tabBadge.textContent = roll.pending > 99 ? "99+" : String(roll.pending);
    if (roll.flash) {
      roll.flash = false;
      tab.classList.remove("wrote");
      void tab.offsetWidth;                 // restart the pulse
      tab.classList.add("wrote");
    }
  }

  // A tab exists only for a roll something is actively writing to.  The one
  // exception is whatever you are currently reading: it keeps its tab (dimmed)
  // after going quiet, so the page never shows a pane with nothing above it.
  function syncTabs() {
    var want = order.filter(function (agent) {
      var roll = rolls.get(agent);
      return roll && (roll.live || agent === selected);
    });
    var wanted = new Set(want);

    rolls.forEach(function (roll) {
      if (roll.tabEl && !wanted.has(roll.agent)) {
        roll.tabEl.remove();
        roll.tabEl = null;
        roll.tabBadge = null;
      }
    });

    want.forEach(function (agent, i) {
      var roll = rolls.get(agent);
      if (!roll.tabEl) buildTab(roll);
      var at = els.tabs.children[i];
      if (at !== roll.tabEl) els.tabs.insertBefore(roll.tabEl, at || null);
      paintTab(roll);
    });

    if (tabsNone.parentNode !== els.tabs) els.tabs.appendChild(tabsNone);
    tabsNone.textContent = rolls.size
      ? "nothing is being written right now"
      : "waiting for an agent to write something";
    tabsNone.hidden = want.some(function (agent) { return rolls.get(agent).live; });
  }

  function tabOrder() {
    return Array.prototype.map.call(
      els.tabs.querySelectorAll(".tab"),
      function (t) { return t.dataset.agent; }
    );
  }

  function stepTab(delta) {
    var list = tabOrder();
    if (!list.length) return;
    var at = list.indexOf(selected);
    select(list[(at + delta + list.length) % list.length]);
  }

  // ---------------------------------------------------------------- archive

  function syncSide() {
    var q = els.sideFilter.value.trim().toLowerCase();
    var keep = els.sideList.scrollTop;
    var frag = document.createDocumentFragment();
    var group = null, shown = 0;

    order.forEach(function (agent) {
      var roll = rolls.get(agent);
      if (!roll) return;

      var hitRoll = !q || roll.agent.toLowerCase().indexOf(q) >= 0;
      var hitArts = q
        ? roll.arts.filter(function (a) { return a.name.toLowerCase().indexOf(q) >= 0; })
        : [];
      if (!hitRoll && !hitArts.length) return;
      shown++;

      if (!group || group.dataset.type !== roll.type) {
        group = el("div", "side-type");
        group.dataset.type = roll.type;
        var gh = el("div", "side-type-head");
        gh.appendChild(el("span", "side-type-name", roll.type));
        group.appendChild(gh);
        frag.appendChild(group);
      }

      var row = el("button", "side-roll");
      row.type = "button";
      row.classList.toggle("sel", roll.agent === selected);
      row.classList.toggle("on", roll.live);
      var dot = el("span", "side-dot");
      dot.style.background = roll.color;
      row.appendChild(dot);
      row.appendChild(el("span", "side-inst", roll.instance));
      row.appendChild(el("span", "side-n", String(roll.count)));
      var ago = el("span", "side-ago", roll.live ? "live" : relTime(roll.lastChange));
      ago.dataset.change = roll.lastChange;
      row.appendChild(ago);
      row.addEventListener("click", function () { select(roll.agent); });
      group.appendChild(row);

      // Artifact names show for the roll you are reading, and for any roll the
      // filter matched by artifact name -- that is what makes the pane a way
      // to navigate old artifacts rather than just old rolls.
      var list = hitArts.length ? hitArts : (roll.agent === selected ? roll.arts : null);
      if (!list || !list.length) return;
      var box = el("div", "side-arts");
      list.forEach(function (art) {
        var item = el("button", "side-art");
        item.type = "button";
        item.title = art.path;
        item.appendChild(el("span", "side-art-kind", art.bundle ? "site" : art.kind));
        item.appendChild(el("span", "side-art-name", art.name));
        item.addEventListener("click", function () { reveal(art); });
        box.appendChild(item);
      });
      group.appendChild(box);
    });

    els.sideList.replaceChildren(frag);
    els.sideEmpty.hidden = shown > 0;
    els.sideEmpty.textContent = q ? "no match" : "nothing yet";
    els.sideList.scrollTop = keep;
  }

  // -------------------------------------------------------------- selection

  function select(agent) {
    var roll = rolls.get(agent);
    if (!roll) return;
    var changed = selected !== agent;
    if (changed && selected) {
      var prev = rolls.get(selected);
      if (prev) prev.el.hidden = true;
    }
    selected = agent;
    roll.el.hidden = false;
    roll.pending = 0;
    roll.jumpEl.hidden = true;
    if (roll.stick && els.follow.checked) roll.body.scrollTop = roll.body.scrollHeight;
    syncTabs();
    if (changed) syncSide(); else paintTab(roll);
  }

  function reveal(art) {
    select(art.agent);
    var entry = cards.get(art.id);
    if (!entry) return;
    var roll = rolls.get(art.agent);
    if (roll) roll.stick = false;          // you asked for a spot; stop chasing
    entry.el.scrollIntoView({ block: "start", behavior: "smooth" });
    entry.el.classList.remove("targeted");
    void entry.el.offsetWidth;
    entry.el.classList.add("targeted");
  }

  // ------------------------------------------------------------- reconcile

  function apply(artifacts, rollRecs) {
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
      if (roll.tabEl) roll.tabEl.remove();
      roll.el.remove();
      if (selected === agent) selected = null;
    });

    var recs = new Map();
    (rollRecs || []).forEach(function (r) { recs.set(r.agent, r); });

    // type first, then instance, so a type's rolls stay adjacent everywhere
    order = Array.from(byAgent.keys()).sort(function (a, b) {
      var x = byAgent.get(a)[0], y = byAgent.get(b)[0];
      return x.type.localeCompare(y.type) || x.instance.localeCompare(y.instance);
    });

    var seenPerType = new Map();

    order.forEach(function (agent) {
      var desired = byAgent.get(agent);
      var art0 = desired[0];
      var roll = rolls.get(agent);
      if (!roll) {
        roll = buildRoll(art0);
        rolls.set(agent, roll);
        els.rolls.appendChild(roll.el);
      }

      var ordinal = seenPerType.get(art0.type) || 0;
      seenPerType.set(art0.type, ordinal + 1);
      roll.color = rollColor(art0.type, ordinal);
      roll.dotEl.style.background = roll.color;

      var rec = recs.get(agent);
      roll.arts = desired;
      roll.count = desired.length;
      roll.live = rec ? !!rec.live : false;
      roll.lastChange = rec ? rec.lastChange : art0.mtime;

      var arrived = 0;
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
        var at = roll.inner.children[position];
        if (at !== entry.el) roll.inner.insertBefore(entry.el, at || null);
      });

      roll.countEl.textContent = desired.length;
      paintState(roll);

      if (arrived) {
        roll.flash = true;
        var watching = agent === selected;
        if (watching && els.follow.checked && roll.stick) {
          roll.body.scrollTop = roll.body.scrollHeight;
        } else {
          roll.pending += arrived;
          roll.jumpEl.textContent = roll.pending + " new ↓";
          roll.jumpEl.hidden = !watching;    // hidden panes speak through the tab
        }
      }
    });

    // keep the panes in the same order as the tabs
    order.forEach(function (agent, i) {
      var roll = rolls.get(agent);
      var at = els.rolls.children[i];
      if (at !== roll.el) els.rolls.insertBefore(roll.el, at || null);
    });

    // Nothing selected (first load, or the roll you were reading was deleted):
    // fall on the roll that wrote most recently, preferring a live one.
    if (!selected || !rolls.has(selected)) {
      var best = null;
      order.forEach(function (agent) {
        var roll = rolls.get(agent);
        if (!best || (roll.live && !best.live) ||
            (roll.live === best.live && roll.lastChange > best.lastChange)) {
          best = roll;
        }
      });
      selected = best ? best.agent : null;
      if (best) { best.stick = true; best.pending = 0; best.jumpEl.hidden = true; }
    }

    rolls.forEach(function (roll) {
      roll.el.hidden = roll.agent !== selected;
    });
    // A pane that was hidden could not scroll while it grew; land it at the
    // newest artifact now that it is on screen.
    var current = selected && rolls.get(selected);
    if (current && current.stick && els.follow.checked) {
      current.body.scrollTop = current.body.scrollHeight;
    }

    var types = new Set(), liveCount = 0;
    artifacts.forEach(function (a) { types.add(a.type); });
    rolls.forEach(function (roll) { if (roll.live) liveCount++; });

    els.counts.textContent = artifacts.length + (artifacts.length === 1 ? " artifact" : " artifacts")
      + " · " + order.length + (order.length === 1 ? " roll" : " rolls")
      + " · " + types.size + (types.size === 1 ? " type" : " types")
      + " · " + liveCount + " live";
    els.empty.classList.toggle("show", artifacts.length === 0);

    syncTabs();
    syncSide();
    primed = true;
  }

  function paintState(roll) {
    roll.stateEl.className = "roll-state" + (roll.live ? " on" : "");
    roll.stateEl.textContent = roll.live ? "writing" : "quiet · " + relTime(roll.lastChange);
    roll.stateEl.dataset.change = roll.lastChange;
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

  // ------------------------------------------------------------- chrome + keys

  function toggleSide(show) {
    var off = show == null ? !document.body.classList.contains("side-off") : !show;
    document.body.classList.toggle("side-off", off);
    els.sideToggle.classList.toggle("off", off);
    try { localStorage.setItem("ar.side", off ? "0" : "1"); } catch (e) { /* private mode */ }
  }

  els.sideToggle.addEventListener("click", function () { toggleSide(); });
  els.sideFilter.addEventListener("input", syncSide);
  els.sideFilter.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") { els.sideFilter.value = ""; syncSide(); els.sideFilter.blur(); }
  });

  try {
    if (localStorage.getItem("ar.side") === "0") toggleSide(false);
  } catch (e) { /* private mode */ }

  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && !els.overlay.hidden) { closeOverlay(); return; }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    var t = ev.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (!els.overlay.hidden) return;

    if (ev.key === "\\") { toggleSide(); ev.preventDefault(); return; }
    if (ev.key === "/") {
      toggleSide(true);
      els.sideFilter.focus();
      els.sideFilter.select();
      ev.preventDefault();
      return;
    }
    if (ev.key === "ArrowRight" || ev.key === "]") { stepTab(1); ev.preventDefault(); return; }
    if (ev.key === "ArrowLeft" || ev.key === "[") { stepTab(-1); ev.preventDefault(); return; }
    if (/^[1-9]$/.test(ev.key)) {
      var list = tabOrder();
      var pick = list[Number(ev.key) - 1];
      if (pick) { select(pick); ev.preventDefault(); }
    }
  });

  els.follow.addEventListener("change", function () {
    if (!els.follow.checked) return;
    var roll = selected && rolls.get(selected);
    if (roll) toBottom(roll);
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
        var data = JSON.parse(ev.data);
        if (data.now) skew = Date.now() / 1000 - data.now;
        apply(data.artifacts, data.rolls);
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
      if (data.now) skew = Date.now() / 1000 - data.now;
      apply(data.artifacts, data.rolls);
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
    rolls.forEach(function (roll) {
      if (!roll.el.hidden) paintState(roll);
    });
    els.sideList.querySelectorAll(".side-ago[data-change]").forEach(function (node) {
      if (node.textContent !== "live") node.textContent = relTime(Number(node.dataset.change));
    });
  }, 10000);

  // re-render the overlay when its artifact changes underneath it
  setInterval(function () {
    if (!overlayArt) return;
    var live = cards.get(overlayArt.id);
    if (live && live.art.mtime !== overlayArt.mtime) openOverlay(live.art);
  }, 2000);
})();
