/* Switchboard UI. Vanilla JS, no framework, no build step. */
(function () {
  "use strict";

  // ---------- token: taken from ?token= once, kept in sessionStorage, removed from the URL ----------
  var params = new URLSearchParams(location.search);
  var TOKEN = params.get("token") || sessionStorage.getItem("sb-token") || "";
  if (params.get("token")) {
    sessionStorage.setItem("sb-token", TOKEN);
    history.replaceState(null, "", location.pathname + location.hash);
  }

  // ---------- icons (1.5px stroke) ----------
  var ICONS = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    memory: '<path d="M5 4h10l4 4v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M14 4v5h5"/><path d="M8 13h8M8 17h5"/>',
    handoff: '<path d="M4 12h12"/><path d="M12 6l6 6-6 6"/><path d="M20 4v16"/>',
    skills: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
    secrets: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.2"/>',
    harness: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M7 9l2 2-2 2M12 13h4"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    minus: '<path d="M6 12h12"/>',
    commit: '<circle cx="12" cy="12" r="3.5"/><path d="M3 12h5.5M15.5 12H21"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16"/><path d="M20 20v-4h-4"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/>',
    alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/>',
    play: '<path d="M7 5l12 7-12 7z"/>',
  };
  function icon(name) { return '<span class="icon"><svg viewBox="0 0 24 24">' + (ICONS[name] || "") + "</svg></span>"; }
  function hydrateIcons(root) {
    (root || document).querySelectorAll("[data-icon]").forEach(function (el) {
      el.innerHTML = '<svg viewBox="0 0 24 24">' + (ICONS[el.getAttribute("data-icon")] || "") + "</svg>";
      el.classList.add("icon");
      el.removeAttribute("data-icon");
    });
  }

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function api(method, path, body) {
    var opt = { method: method, headers: { "x-switchboard-token": TOKEN } };
    if (body !== undefined) { opt.headers["content-type"] = "application/json"; opt.body = JSON.stringify(body); }
    return fetch(path, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ("HTTP " + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  var toastTimer;
  function toast(msg, isErr) {
    var t = $("#toast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isErr ? 6000 : 2600);
  }
  function fail(e) { toast(e.message || String(e), true); }

  /** Safe markdown: escape everything first, then add a small set of tags. */
  function md(src) {
    var lines = esc(src).split("\n");
    var out = [], inCode = false, list = null, para = [];
    function inline(s) {
      return s
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    }
    function flushPara() { if (para.length) { out.push("<p>" + inline(para.join(" ")) + "</p>"); para = []; } }
    function flushList() { if (list) { out.push("</" + list + ">"); list = null; } }
    lines.forEach(function (l) {
      if (/^```/.test(l)) { flushPara(); flushList(); out.push(inCode ? "</code></pre>" : "<pre><code>"); inCode = !inCode; return; }
      if (inCode) { out.push(l + "\n"); return; }
      var m;
      if ((m = /^(#{1,3})\s+(.*)$/.exec(l))) { flushPara(); flushList(); out.push("<h" + m[1].length + ">" + inline(m[2]) + "</h" + m[1].length + ">"); return; }
      if ((m = /^\s*[-*]\s+(.*)$/.exec(l))) { flushPara(); if (list !== "ul") { flushList(); out.push("<ul>"); list = "ul"; } out.push("<li>" + inline(m[1]) + "</li>"); return; }
      if ((m = /^\s*\d+\.\s+(.*)$/.exec(l))) { flushPara(); if (list !== "ol") { flushList(); out.push("<ol>"); list = "ol"; } out.push("<li>" + inline(m[1]) + "</li>"); return; }
      if ((m = /^&gt;\s?(.*)$/.exec(l))) { flushPara(); flushList(); out.push("<blockquote>" + inline(m[1]) + "</blockquote>"); return; }
      if (/^---+$/.test(l.trim())) { flushPara(); flushList(); out.push("<hr>"); return; }
      if (!l.trim()) { flushPara(); flushList(); return; }
      para.push(l);
    });
    flushPara(); flushList();
    if (inCode) out.push("</code></pre>");
    return out.join("");
  }
  function snippet(s) { return esc(s).replace(/\[([^\]]*)\]/g, "<mark>$1</mark>"); }
  function diffHtml(d) {
    return '<pre class="diff">' + String(d).split("\n").map(function (l) {
      var c = /^\+\+\+|^---/.test(l) ? "hunk" : l[0] === "+" ? "add" : l[0] === "-" ? "del" : l[0] === "@" ? "hunk" : "";
      return '<span class="' + c + '">' + esc(l) + "</span>";
    }).join("") + "</pre>";
  }
  function pill(text, kind) { return '<span class="pill ' + (kind || "") + '"><span class="dot"></span>' + esc(text) + "</span>"; }
  function yesNo(v) { return v ? '<span class="check" title="yes">' + icon("check") + "</span>" : '<span class="cross" title="no">' + icon("minus") + "</span>"; }
  function splitList(s) { return String(s || "").split(/[,\n]/).map(function (x) { return x.trim(); }).filter(Boolean); }

  // ---------- modal ----------
  function openModal(title, html, onMount) {
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = html;
    hydrateIcons($("#modal-body"));
    $("#modal").hidden = false;
    if (onMount) onMount($("#modal-body"));
    var first = $("#modal-body input, #modal-body textarea");
    if (first) first.focus();
  }
  function closeModal() { $("#modal").hidden = true; $("#modal-body").innerHTML = ""; }
  $("#modal-close").addEventListener("click", closeModal);
  $("#modal").addEventListener("mousedown", function (e) { if (e.target.id === "modal") closeModal(); });

  // ---------- theme ----------
  function syncThemeLabel() {
    var dark = document.documentElement.getAttribute("data-theme") === "dark";
    $("#theme-label").textContent = dark ? "Light" : "Dark";
    var b = $("#theme-toggle .icon");
    if (b) b.innerHTML = '<svg viewBox="0 0 24 24">' + ICONS[dark ? "sun" : "moon"] + "</svg>";
  }
  $("#theme-toggle").addEventListener("click", function () {
    var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("sb-theme", next); } catch (e) { /* ignore */ }
    syncThemeLabel();
  });

  // ---------- nav ----------
  var SECTIONS = [
    { id: "dashboard", label: "Dashboard", icon: "dashboard" },
    { id: "memory", label: "Memory", icon: "memory" },
    { id: "handoffs", label: "Handoffs", icon: "handoff" },
    { id: "skills", label: "Skills", icon: "skills" },
    { id: "secrets", label: "Secrets", icon: "secrets" },
    { id: "harnesses", label: "Harnesses", icon: "harness" },
  ];
  var counts = {};
  function renderNav() {
    var cur = route().section;
    $("#nav").innerHTML = SECTIONS.map(function (s) {
      var c = counts[s.id];
      return '<a href="#/' + s.id + '" class="' + (cur === s.id ? "active" : "") + '">' + icon(s.icon) + "<span>" + s.label + "</span>" +
        (c != null ? '<span class="count">' + c + "</span>" : "") + "</a>";
    }).join("");
  }
  function route() {
    var h = location.hash.replace(/^#\/?/, "");
    var i = h.indexOf("/");
    var section = i === -1 ? h : h.slice(0, i);
    var arg = i === -1 ? "" : decodeURIComponent(h.slice(i + 1));
    if (!SECTIONS.some(function (s) { return s.id === section; })) section = "dashboard";
    return { section: section, arg: arg };
  }
  function go(section, arg) { location.hash = "#/" + section + (arg ? "/" + encodeURIComponent(arg) : ""); }

  function setPage(title, actionsHtml) {
    $("#page-title").textContent = title;
    $("#topbar-actions").innerHTML = actionsHtml || "";
    hydrateIcons($("#topbar-actions"));
  }

  // ---------- git commit (the only path to a Home commit) ----------
  var gitState = null;
  function commitButton() {
    var n = gitState && gitState.repo ? gitState.changes.length : 0;
    var label = !gitState || !gitState.repo ? "Not a git repo" : n ? "Commit changes (" + n + ")" : "No changes";
    return '<button class="btn" id="commit-btn" ' + (n ? "" : "disabled") + ">" + icon("commit") + "<span>" + label + "</span></button>";
  }
  function refreshGit() {
    return api("GET", "/api/git").then(function (g) {
      gitState = g;
      var b = $("#commit-btn");
      if (b) { b.outerHTML = commitButton(); bindCommit(); }
    }).catch(function () {});
  }
  function bindCommit() {
    var b = $("#commit-btn");
    if (!b) return;
    b.addEventListener("click", function () {
      var list = (gitState.changes || []).map(function (c) {
        return '<li><span class="tag">' + esc(c.status) + '</span><span class="mono small grow">' + esc(c.path) + "</span></li>";
      }).join("");
      openModal("Commit changes to Home",
        '<div class="stack"><div class="card"><ul class="list">' + list + "</ul></div>" +
        '<label class="field">Message<input type="text" id="commit-msg" value="Update Home from Switchboard UI"></label>' +
        '<div class="modal-foot"><button class="btn" id="c-cancel">Cancel</button><button class="btn primary" id="c-go">Commit</button></div></div>',
        function (root) {
          $("#c-cancel", root).onclick = closeModal;
          $("#c-go", root).onclick = function () {
            api("POST", "/api/commit", { message: $("#commit-msg", root).value }).then(function (r) {
              closeModal(); toast("Committed " + r.commit); gitState = r.git; render();
            }).catch(fail);
          };
        });
    });
  }
  function headerWithCommit(title, extra) {
    setPage(title, (extra || "") + commitButton());
    bindCommit();
  }

  // ---------- views ----------
  var view = $("#view");

  function viewDashboard() {
    headerWithCommit("Dashboard", '<button class="btn" id="dash-refresh">' + icon("refresh") + "<span>Refresh</span></button>");
    $("#dash-refresh").onclick = render;
    view.innerHTML = '<div class="faint">Loading</div>';
    return api("GET", "/api/dashboard").then(function (d) {
      gitState = d.git;
      $("#home-path").textContent = d.home;
      $("#home-path").title = d.home;
      counts = { memory: d.counts.notes, handoffs: d.counts.handoffs, skills: d.counts.skills, secrets: d.counts.secrets };
      renderNav();
      headerWithCommit("Dashboard", '<button class="btn" id="dash-refresh">' + icon("refresh") + "<span>Refresh</span></button>");
      $("#dash-refresh").onclick = render;
      var pinKind = d.pin === "pinned" ? "ok" : d.pin === "tampered" ? "err" : "warn";
      var errs = d.doctor.filter(function (f) { return f.severity === "error"; }).length;
      var warns = d.doctor.filter(function (f) { return f.severity === "warning"; }).length;
      var stat = function (label, value, href) { return '<a class="stat" href="' + href + '"><div class="label">' + label + '</div><div class="value">' + value + "</div></a>"; };
      var attention = d.attention.length
        ? d.attention.map(function (a) {
          return '<li class="clickable" data-kind="' + esc(a.kind) + '" data-target="' + esc(a.target || "") + '">' + icon("alert") +
            '<span class="grow">' + esc(a.message) + '</span><span class="tag">' + esc(a.kind) + "</span></li>";
        }).join("")
        : '<li class="empty">Nothing needs attention.</li>';
      var findings = d.doctor.length
        ? d.doctor.map(function (f) {
          return '<div class="finding"><span class="sev ' + f.severity + '">' + f.severity + '</span><div class="grow"><div>' +
            (f.secret ? '<span class="mono">' + esc(f.secret) + "</span>: " : "") + esc(f.message) + '</div><div class="faint small">' + esc(f.hint) + "</div></div></div>";
        }).join("")
        : '<div class="empty">Doctor found no problems.</div>';
      var changes = !d.git.repo
        ? '<div class="empty">Home is not a git repository.</div>'
        : d.git.changes.length
          ? '<ul class="list">' + d.git.changes.slice(0, 30).map(function (c) {
            return '<li><span class="tag">' + esc(c.status) + '</span><span class="mono small">' + esc(c.path) + "</span></li>";
          }).join("") + "</ul>"
          : '<div class="empty">Working tree clean.</div>';
      view.innerHTML =
        '<div class="stack content-narrow">' +
        '<div class="stats">' + stat("Notes", d.counts.notes, "#/memory") + stat("Handoffs", d.counts.handoffs, "#/handoffs") +
        stat("Skills", d.counts.skills, "#/skills") + stat("Secrets", d.counts.secrets, "#/secrets") +
        stat("Harnesses wired", d.counts.harnesses, "#/harnesses") + "</div>" +
        '<div class="card"><div class="card-head"><h3>Needs attention</h3><span class="sub">' + d.attention.length + '</span></div><ul class="list" id="attn">' + attention + "</ul></div>" +
        '<div class="grid-2">' +
        '<div class="card"><div class="card-head"><h3>Doctor</h3><div class="right">' + pill("manifest " + d.pin, pinKind) +
        pill(errs + " errors", errs ? "err" : "ok") + pill(warns + " warnings", warns ? "warn" : "") + "</div></div>" + findings + "</div>" +
        '<div class="card"><div class="card-head"><h3>Home git status</h3><span class="sub">' + (d.git.repo ? d.git.changes.length + " changed" : "") + "</span></div>" + changes + "</div>" +
        "</div></div>";
      $$("#attn li[data-kind]").forEach(function (li) {
        li.onclick = function () {
          var k = li.getAttribute("data-kind"), t = li.getAttribute("data-target");
          if (k === "duplicate") go("memory", t);
          else if (k === "secret" || k === "manifest") go("secrets");
          else if (k === "skill") go("skills", t);
          else if (k === "harness") go("harnesses");
        };
      });
    });
  }

  // memory
  var memState = { q: "", type: "", selected: "", editing: false };
  function noteForm(n) {
    n = n || { title: "", body: "", type: "note", tags: [], source: "" };
    return '<div class="stack">' +
      '<label class="field">Title<input type="text" id="n-title" value="' + esc(n.title) + '"></label>' +
      '<div class="form-grid"><label class="field">Type<select id="n-type">' +
      ["note", "handoff", "decision", "preference", "reference"].concat(["note", "handoff", "decision", "preference", "reference"].indexOf(n.type) === -1 ? [n.type] : [])
        .map(function (t) { return "<option" + (t === n.type ? " selected" : "") + ">" + esc(t) + "</option>"; }).join("") +
      '</select></label><label class="field">Tags <span class="field-hint">comma separated</span><input type="text" id="n-tags" value="' + esc((n.tags || []).join(", ")) + '"></label></div>' +
      '<label class="field">Body <span class="field-hint">markdown; never paste secret values (the server refuses them)</span><textarea class="code" id="n-body" rows="16">' + esc(n.body) + "</textarea></label>" +
      '<div id="n-err"></div></div>';
  }
  function readNoteForm(root) {
    return { title: $("#n-title", root).value, type: $("#n-type", root).value, tags: splitList($("#n-tags", root).value), body: $("#n-body", root).value };
  }
  function viewMemory(arg) {
    if (arg) memState.selected = arg;
    headerWithCommit("Memory", '<button class="btn primary" id="new-note">' + icon("plus") + "<span>New note</span></button>");
    $("#new-note").onclick = function () {
      openModal("New note", noteForm() + '<div class="modal-foot"><button class="btn" id="nn-cancel">Cancel</button><button class="btn primary" id="nn-save">Save note</button></div>', function (root) {
        $("#nn-cancel", root).onclick = closeModal;
        $("#nn-save", root).onclick = function () {
          api("POST", "/api/memory", readNoteForm(root)).then(function (r) {
            closeModal(); toast("Note saved"); memState.selected = r.path; refreshGit(); go("memory", r.path); renderMemoryList(); renderNote();
          }).catch(function (e) { $("#n-err", root).innerHTML = '<div class="errbox">' + esc(e.message) + "</div>"; });
        };
      });
    };
    view.innerHTML =
      '<div class="split"><div class="card sticky"><div class="card-head" style="gap:8px">' +
      '<input type="search" id="mem-q" placeholder="Search memory" value="' + esc(memState.q) + '">' +
      '<select id="mem-type" style="width:120px"><option value="">All types</option>' +
      ["note", "handoff", "decision", "preference", "reference"].map(function (t) { return "<option" + (t === memState.type ? " selected" : "") + ">" + t + "</option>"; }).join("") +
      '</select></div><div class="note-list" id="mem-list"></div></div><div id="mem-detail"></div></div>';
    var t;
    $("#mem-q").addEventListener("input", function (e) { memState.q = e.target.value; clearTimeout(t); t = setTimeout(renderMemoryList, 160); });
    $("#mem-type").addEventListener("change", function (e) { memState.type = e.target.value; renderMemoryList(); });
    return Promise.all([renderMemoryList(), renderNote()]);
  }
  function renderMemoryList() {
    var qs = "?q=" + encodeURIComponent(memState.q) + "&type=" + encodeURIComponent(memState.type);
    return api("GET", "/api/memory" + qs).then(function (r) {
      var el = $("#mem-list");
      if (!el) return;
      if (!r.results.length) { el.innerHTML = '<div class="empty">' + (memState.q ? "No matches." : "No notes yet.") + "</div>"; return; }
      el.innerHTML = r.results.map(function (n) {
        return '<div class="note-item' + (n.path === memState.selected ? " active" : "") + '" data-path="' + esc(n.path) + '">' +
          '<div class="t">' + esc(n.title) + "</div>" +
          '<div class="m"><span>' + esc(n.type) + "</span><span>" + esc(n.date) + "</span>" + (n.source ? "<span>" + esc(n.source) + "</span>" : "") + "</div>" +
          '<div class="x">' + (r.mode === "search" ? snippet(n.snippet) : esc(n.excerpt)) + "</div></div>";
      }).join("");
      $$(".note-item", el).forEach(function (it) {
        it.onclick = function () { memState.selected = it.getAttribute("data-path"); memState.editing = false; history.replaceState(null, "", "#/memory/" + encodeURIComponent(memState.selected)); $$(".note-item", el).forEach(function (x) { x.classList.toggle("active", x === it); }); renderNote(); };
      });
    }).catch(fail);
  }
  function renderNote() {
    var el = $("#mem-detail");
    if (!el) return Promise.resolve();
    if (!memState.selected) { el.innerHTML = '<div class="card"><div class="empty">Select a note, or press &#8984;K to jump to one.</div></div>'; return Promise.resolve(); }
    return api("GET", "/api/memory/note?path=" + encodeURIComponent(memState.selected)).then(function (r) {
      var n = r.note;
      if (memState.editing) {
        el.innerHTML = '<div class="card"><div class="card-head"><h3>Edit note</h3><span class="sub mono">' + esc(n.path) + '</span><div class="right"><button class="btn sm" id="e-cancel">Cancel</button><button class="btn sm primary" id="e-save">Save</button></div></div><div class="card-body">' + noteForm(n) + "</div></div>";
        $("#e-cancel").onclick = function () { memState.editing = false; renderNote(); };
        $("#e-save").onclick = function () {
          api("PUT", "/api/memory/note?path=" + encodeURIComponent(n.path), readNoteForm(el)).then(function () {
            memState.editing = false; toast("Saved"); refreshGit(); renderNote(); renderMemoryList();
          }).catch(function (e) { $("#n-err", el).innerHTML = '<div class="errbox">' + esc(e.message) + "</div>"; });
        };
        return;
      }
      el.innerHTML = '<div class="card"><div class="card-head"><div class="grow"><h3>' + esc(n.title) + '</h3><div class="row small faint" style="margin-top:4px;flex-wrap:wrap">' +
        '<span class="pill">' + esc(n.type) + '</span><span class="mono">' + esc(n.date) + "</span>" + (n.source ? "<span>from " + esc(n.source) + "</span>" : "") +
        (n.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + "</span>"; }).join("") +
        '</div></div><div class="right"><button class="btn sm" id="n-edit">' + icon("edit") + '<span>Edit</span></button><button class="btn sm danger" id="n-del">' + icon("trash") + "<span>Delete</span></button></div></div>" +
        '<div class="card-body md">' + md(n.body) + '</div><div class="card-body faint small mono" style="border-top:1px solid var(--border)">memory/' + esc(n.path) + "</div></div>";
      $("#n-edit").onclick = function () { memState.editing = true; renderNote(); };
      $("#n-del").onclick = function () {
        openModal("Delete note", '<p class="muted">Delete <strong>' + esc(n.title) + '</strong>? The file is removed from Home. Until you commit, git can restore it.</p><div class="modal-foot"><button class="btn" id="d-c">Cancel</button><button class="btn primary" id="d-go">Delete</button></div>', function (root) {
          $("#d-c", root).onclick = closeModal;
          $("#d-go", root).onclick = function () {
            api("DELETE", "/api/memory/note?path=" + encodeURIComponent(n.path)).then(function () {
              closeModal(); toast("Deleted"); memState.selected = ""; refreshGit(); history.replaceState(null, "", "#/memory"); renderNote(); renderMemoryList();
            }).catch(fail);
          };
        });
      };
    }).catch(function (e) { el.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) + "</div></div>"; });
  }

  // handoffs
  var handoffFilter = "open";
  function viewHandoffs() {
    headerWithCommit("Handoffs", '<div class="seg" id="h-seg"><button data-v="open">Open</button><button data-v="resolved">Resolved</button><button data-v="all">All</button></div>');
    $$("#h-seg button").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-v") === handoffFilter);
      b.onclick = function () { handoffFilter = b.getAttribute("data-v"); render(); };
    });
    return api("GET", "/api/handoffs").then(function (list) {
      var shown = list.filter(function (h) { return handoffFilter === "all" || (handoffFilter === "resolved" ? h.resolved : !h.resolved); });
      if (!shown.length) { view.innerHTML = '<div class="card content-narrow"><div class="empty">No ' + (handoffFilter === "all" ? "" : handoffFilter + " ") + "handoffs. Agents write them with memory_write and type handoff.</div></div>"; return; }
      view.innerHTML = '<div class="stack content-narrow">' + shown.map(function (h) {
        return '<div class="card"><div class="card-head"><div class="grow"><h3>' + esc(h.title) + '</h3><div class="row small faint" style="margin-top:4px">' +
          '<span class="mono">' + esc(h.date) + "</span>" + (h.source ? "<span>from " + esc(h.source) + "</span>" : "") +
          h.tags.filter(function (t) { return t !== "resolved" && t !== "handoff"; }).map(function (t) { return '<span class="tag">' + esc(t) + "</span>"; }).join("") +
          '</div></div><div class="right">' + (h.resolved ? pill("resolved", "ok") : pill("open", "warn")) +
          '<button class="btn sm" data-open="' + esc(h.path) + '">Open</button><button class="btn sm" data-res="' + esc(h.path) + '" data-to="' + (!h.resolved) + '">' + (h.resolved ? "Reopen" : "Mark resolved") + "</button></div></div>" +
          '<div class="card-body md">' + md(h.body) + "</div></div>";
      }).join("") + "</div>";
      $$("[data-open]").forEach(function (b) { b.onclick = function () { go("memory", b.getAttribute("data-open")); }; });
      $$("[data-res]").forEach(function (b) {
        b.onclick = function () {
          api("POST", "/api/handoffs/resolve", { path: b.getAttribute("data-res"), resolved: b.getAttribute("data-to") === "true" })
            .then(function () { toast("Updated"); refreshGit(); render(); }).catch(fail);
        };
      });
    });
  }

  // skills
  function viewSkills(arg) {
    headerWithCommit("Skills", '<button class="btn primary" id="new-skill">' + icon("plus") + "<span>New skill</span></button>");
    $("#new-skill").onclick = function () {
      openModal("New skill",
        '<div class="stack"><label class="field">Name <span class="field-hint">lowercase, digits, . _ -</span><input type="text" id="s-name" placeholder="weekly-review"></label>' +
        '<label class="field">Description <span class="field-hint">starts with "Use when"</span><input type="text" id="s-desc" placeholder="Use when ..."></label>' +
        '<div id="s-err"></div><div class="modal-foot"><button class="btn" id="s-c">Cancel</button><button class="btn primary" id="s-go">Create from template</button></div></div>',
        function (root) {
          $("#s-c", root).onclick = closeModal;
          $("#s-go", root).onclick = function () {
            api("POST", "/api/skills", { name: $("#s-name", root).value.trim(), description: $("#s-desc", root).value.trim() }).then(function (r) {
              closeModal(); toast("Skill created"); refreshGit(); go("skills", r.name);
            }).catch(function (e) { $("#s-err", root).innerHTML = '<div class="errbox">' + esc(e.message) + "</div>"; });
          };
        });
    };
    return api("GET", "/api/skills").then(function (list) {
      var sel = arg || (list[0] && list[0].name) || "";
      view.innerHTML = '<div class="split"><div class="card sticky"><div class="card-head"><h3>Library</h3><span class="sub">' + list.length + '</span></div><div class="note-list">' +
        (list.length ? list.map(function (s) {
          return '<div class="note-item' + (s.name === sel ? " active" : "") + '" data-name="' + esc(s.name) + '"><div class="t mono">' + esc(s.name) + '</div><div class="x">' + esc(s.description) + "</div></div>";
        }).join("") : '<div class="empty">No skills yet.</div>') +
        '</div></div><div id="skill-detail"></div></div>';
      $$(".note-item[data-name]").forEach(function (it) { it.onclick = function () { go("skills", it.getAttribute("data-name")); }; });
      var s = list.filter(function (x) { return x.name === sel; })[0];
      if (s) return renderSkill(s);
    });
  }
  function renderSkill(s) {
    var el = $("#skill-detail");
    return api("GET", "/api/skills/" + encodeURIComponent(s.name)).then(function (f) {
      var v = s.visibility || {};
      el.innerHTML = '<div class="stack"><div class="card"><div class="card-head"><div class="grow"><h3 class="mono">' + esc(s.name) + '</h3><div class="faint small" style="margin-top:3px">' + esc(s.description) + "</div></div>" +
        '<div class="right"><button class="btn sm" id="sk-revert">Revert</button><button class="btn sm primary" id="sk-save">Save SKILL.md</button></div></div>' +
        '<div class="card-body"><textarea class="code" id="sk-body" rows="22" spellcheck="false">' + esc(f.content) + '</textarea><div id="sk-err" style="margin-top:8px"></div></div></div>' +
        '<div class="card"><div class="card-head"><h3>Visible in</h3></div><table class="tbl"><thead><tr><th>Harness</th><th>Visible</th><th>How</th></tr></thead><tbody>' +
        "<tr><td>Hermes</td><td>" + yesNo(v.hermes) + '</td><td class="faint small">skills.external_dirs includes Home/skills</td></tr>' +
        "<tr><td>Claude Code</td><td>" + yesNo(v.claude) + '</td><td class="faint small">symlink in ~/.claude/skills (re-run setup claude-code for new skills)</td></tr>' +
        "<tr><td>Codex</td><td>" + yesNo(v.codex) + '</td><td class="faint small">symlink in $CODEX_HOME/skills</td></tr>' +
        '<tr><td>Any MCP harness</td><td>' + yesNo(true) + '</td><td class="faint small">skill_list / skill_get tools</td></tr>' +
        "</tbody></table></div>" +
        (s.files.length > 1 ? '<div class="card"><div class="card-head"><h3>Files</h3></div><ul class="list">' + s.files.map(function (x) { return '<li class="mono small">' + esc(x) + "</li>"; }).join("") + "</ul></div>" : "") +
        "</div>";
      $("#sk-revert").onclick = function () { $("#sk-body").value = f.content; };
      $("#sk-save").onclick = function () {
        api("PUT", "/api/skills/" + encodeURIComponent(s.name), { file: "SKILL.md", content: $("#sk-body").value }).then(function () {
          toast("Saved"); $("#sk-err").innerHTML = ""; refreshGit();
        }).catch(function (e) { $("#sk-err").innerHTML = '<div class="errbox">' + esc(e.message) + "</div>"; });
      };
    }).catch(fail);
  }

  // secrets
  function entryForm(e) {
    e = e || { name: "", purpose: "", env: "", service: "switchboard", account: "", hosts: [], http: null, commands: [], timeout_sec: 30 };
    var cmds = (e.commands || []).map(function (c) { return c.program + (c.args && c.args.length ? "  " + c.args.join("  ") : ""); }).join("\n");
    return '<div class="stack"><div class="form-grid">' +
      '<label class="field">Name <span class="field-hint">UPPER_SNAKE</span><input type="text" id="e-name" value="' + esc(e.name) + '"' + (e.name ? " readonly" : "") + "></label>" +
      '<label class="field">Env var <span class="field-hint">defaults to name</span><input type="text" id="e-env" value="' + esc(e.env || "") + '"></label>' +
      '<label class="field full">Purpose<input type="text" id="e-purpose" value="' + esc(e.purpose) + '"></label>' +
      '<label class="field">Keychain service<input type="text" id="e-service" value="' + esc(e.service || "switchboard") + '"></label>' +
      '<label class="field">Keychain account <span class="field-hint">defaults to name</span><input type="text" id="e-account" value="' + esc(e.account || "") + '"></label>' +
      '<label class="field full">Allowed hosts <span class="field-hint">comma separated, exact hosts</span><input type="text" id="e-hosts" value="' + esc((e.hosts || []).join(", ")) + '"></label>' +
      '<label class="field">HTTP header <span class="field-hint">optional</span><input type="text" id="e-hh" value="' + esc(e.http ? e.http.header : "") + '" placeholder="Authorization"></label>' +
      '<label class="field">HTTP template<input type="text" id="e-ht" value="' + esc(e.http ? e.http.template : "") + '" placeholder="Bearer {value}"></label>' +
      '<label class="field full">Allowed commands <span class="field-hint">one per line: /absolute/program then arg regexes separated by two spaces</span><textarea class="code" id="e-cmds" rows="4" spellcheck="false">' + esc(cmds) + "</textarea></label>" +
      '<label class="field">Timeout (seconds)<input type="number" id="e-timeout" min="1" max="300" value="' + esc(e.timeout_sec || 30) + '"></label>' +
      '</div><div id="e-check"></div></div>';
  }
  function readEntry(root) {
    var cmds = $("#e-cmds", root).value.split("\n").map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) {
      var parts = l.split(/\s{2,}|\t/);
      return { program: parts[0], args: parts.slice(1) };
    });
    var hh = $("#e-hh", root).value.trim(), ht = $("#e-ht", root).value.trim();
    return {
      name: $("#e-name", root).value.trim(), env: $("#e-env", root).value.trim(), purpose: $("#e-purpose", root).value.trim(),
      service: $("#e-service", root).value.trim(), account: $("#e-account", root).value.trim(),
      hosts: splitList($("#e-hosts", root).value), http: hh || ht ? { header: hh, template: ht } : null,
      commands: cmds, timeout_sec: Number($("#e-timeout", root).value) || undefined,
    };
  }
  function showCheck(root, r) {
    var html = r.errors.length
      ? '<div class="errbox"><strong>Doctor rejects this entry.</strong><br>' + r.errors.map(esc).join("<br>") + "</div>"
      : '<div class="okbox">Valid. ' + (r.findings.length ? r.findings.map(function (f) { return esc(f.severity + ": " + f.message); }).join("<br>") : "No doctor findings.") + "</div>";
    $("#e-check", root).innerHTML = html;
  }
  function openEntry(e, mode) {
    openModal(mode === "create" ? "Add secret" : "Edit " + e.name,
      entryForm(e) + '<p class="faint small">Saving validates with the manifest parser and doctor, writes secrets.manifest.yaml, then re-pins it. Values are set separately.</p>' +
      '<div class="modal-foot"><button class="btn" id="e-validate">Validate</button><button class="btn primary" id="e-save">Save and re-pin</button></div>',
      function (root) {
        $("#e-validate", root).onclick = function () {
          api("POST", "/api/secrets/validate", { entry: readEntry(root), mode: mode }).then(function (r) { showCheck(root, r); }).catch(fail);
        };
        $("#e-save", root).onclick = function () {
          api(mode === "create" ? "POST" : "PUT", "/api/secrets/entry", { entry: readEntry(root) }).then(function (r) {
            closeModal(); toast("Saved " + r.name + ", manifest re-pinned"); refreshGit(); render();
          }).catch(function (err) { $("#e-check", root).innerHTML = '<div class="errbox">' + esc(err.message) + "</div>"; });
        };
      });
  }
  function openSetValue(name, present) {
    openModal((present ? "Rotate " : "Set ") + name,
      '<div class="stack"><p class="muted">The value goes straight into the configured store. It is never shown again, never logged, and no screen in Switchboard can reveal it.</p>' +
      '<label class="field">Value<input type="password" id="v-val" autocomplete="off" spellcheck="false"></label><div id="v-err"></div>' +
      '<div class="modal-foot"><button class="btn" id="v-c">Cancel</button><button class="btn primary" id="v-go">' + (present ? "Rotate value" : "Store value") + "</button></div></div>",
      function (root) {
        $("#v-c", root).onclick = closeModal;
        $("#v-go", root).onclick = function () {
          var input = $("#v-val", root);
          var value = input.value;
          input.value = "";
          api("POST", "/api/secrets/value", { name: name, value: value }).then(function () {
            closeModal(); toast("Stored " + name); render();
          }).catch(function (e) { $("#v-err", root).innerHTML = '<div class="errbox">' + esc(e.message) + "</div>"; });
          value = null;
        };
      });
  }
  function viewSecrets() {
    headerWithCommit("Secrets", '<button class="btn primary" id="add-secret">' + icon("plus") + "<span>Add secret</span></button>");
    $("#add-secret").onclick = function () { openEntry(null, "create"); };
    return api("GET", "/api/secrets").then(function (d) {
      var pinKind = d.pin === "pinned" ? "ok" : d.pin === "tampered" ? "err" : "warn";
      var byName = {};
      d.entries.forEach(function (e) { byName[e.name] = e; });
      var rows = d.secrets.length ? d.secrets.map(function (s) {
        var present = s.present === true;
        var progs = (s.commands || []).map(function (c) { return c.program.split("/").pop(); });
        return "<tr><td><div class=\"mono\">" + esc(s.name) + '</div><div class="faint small">' + esc(s.purpose || "No purpose") + "</div></td>" +
          "<td>" + (present ? pill("present", "ok") : pill(typeof s.present === "string" ? "unknown" : "missing", "warn")) + "</td>" +
          '<td class="small">' + (progs.length ? progs.map(function (p) { return '<span class="tag">' + esc(p) + "</span>"; }).join(" ") : '<span class="faint">none</span>') + "</td>" +
          '<td class="small">' + (s.hosts.length ? s.hosts.map(function (h) { return '<span class="tag">' + esc(h) + "</span>"; }).join(" ") : '<span class="faint">none</span>') + "</td>" +
          '<td style="text-align:right;white-space:nowrap"><button class="btn sm" data-val="' + esc(s.name) + '" data-present="' + present + '">' + icon("key") + "<span>" + (present ? "Rotate" : "Set value") + '</span></button> <button class="btn sm" data-edit="' + esc(s.name) + '">Edit</button> <button class="btn sm danger" data-del="' + esc(s.name) + '">Delete</button></td></tr>';
      }).join("") : '<tr><td colspan="5"><div class="empty">No secrets in the manifest.</div></td></tr>';
      var findings = d.findings.length ? d.findings.map(function (f) {
        return '<div class="finding"><span class="sev ' + f.severity + '">' + f.severity + '</span><div class="grow"><div>' + (f.secret ? '<span class="mono">' + esc(f.secret) + "</span>: " : "") + esc(f.message) + '</div><div class="faint small">' + esc(f.hint) + "</div></div></div>";
      }).join("") : '<div class="empty">No doctor findings.</div>';
      view.innerHTML = '<div class="stack">' +
        (d.error ? '<div class="errbox">' + esc(d.error) + "</div>" : "") +
        '<div class="card"><div class="card-head"><h3>Manifest</h3><span class="sub">names and allowlists only, never values</span><div class="right">' + pill("manifest " + d.pin, pinKind) + "</div></div>" +
        '<table class="tbl"><thead><tr><th>Name</th><th>Value</th><th>Programs</th><th>Hosts</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
        '<div class="card"><div class="card-head"><h3>Doctor</h3></div>' + findings + "</div></div>";
      hydrateIcons(view);
      $$("[data-val]").forEach(function (b) { b.onclick = function () { openSetValue(b.getAttribute("data-val"), b.getAttribute("data-present") === "true"); }; });
      $$("[data-edit]").forEach(function (b) { b.onclick = function () { openEntry(byName[b.getAttribute("data-edit")], "update"); }; });
      $$("[data-del]").forEach(function (b) {
        b.onclick = function () {
          var n = b.getAttribute("data-del");
          openModal("Delete " + n, '<p class="muted">Remove <span class="mono">' + esc(n) + '</span> from the manifest, delete its value from the store, and re-pin.</p><div class="modal-foot"><button class="btn" id="x-c">Cancel</button><button class="btn primary" id="x-go">Delete</button></div>', function (root) {
            $("#x-c", root).onclick = closeModal;
            $("#x-go", root).onclick = function () {
              api("DELETE", "/api/secrets/entry?name=" + encodeURIComponent(n)).then(function () { closeModal(); toast("Deleted " + n); refreshGit(); render(); }).catch(fail);
            };
          });
        };
      });
    });
  }

  // harnesses
  function viewHarnesses() {
    headerWithCommit("Harnesses");
    return api("GET", "/api/harnesses").then(function (list) {
      var kind = function (s) { return s === "installed" ? "ok" : s === "error" ? "err" : s === "manual" ? "" : "warn"; };
      view.innerHTML = '<div class="stack content-narrow">' + list.map(function (h) {
        return '<div class="card"><div class="card-head"><h3>' + esc(h.label) + '</h3><span class="sub">' + (h.tested === "tested" ? "tested" : h.tested === "manual" ? "manual steps" : "untested") + '</span><div class="right">' + pill(h.state, kind(h.state)) +
          (h.state !== "manual" ? '<button class="btn sm" data-diff="' + h.id + '">Preview diff</button>' : "") +
          (h.id === "hermes" || h.id === "claude-code" ? '<button class="btn sm" data-test="' + h.id + '">' + icon("play") + "<span>Quick test</span></button>" : "") +
          '</div></div><div class="card-body small"><ul class="list" style="margin:-14px -16px">' + h.notes.map(function (n) { return '<li class="faint mono small">' + esc(n) + "</li>"; }).join("") + '</ul></div><div id="hx-' + h.id + '"></div></div>';
      }).join("") + "</div>";
      hydrateIcons(view);
      $$("[data-diff]").forEach(function (b) {
        b.onclick = function () {
          var id = b.getAttribute("data-diff");
          api("GET", "/api/harnesses/" + id + "/diff").then(function (d) {
            var changes = d.files.length + d.links.length;
            openModal("Setup " + id + " (dry run)",
              (changes ? d.files.map(function (f) { return '<div class="small mono faint" style="margin:8px 0 4px">' + esc(f.path) + (f.isNew ? " (new file)" : "") + "</div>" + diffHtml(f.diff); }).join("") +
                (d.links.length ? '<div class="card" style="margin-top:12px"><ul class="list">' + d.links.map(function (l) { return '<li class="mono small">+ ' + esc(l.link) + " &rarr; " + esc(l.target) + "</li>"; }).join("") + "</ul></div>" : "")
                : '<div class="okbox">Already set up. Nothing would change.</div>') +
              '<p class="faint small">Apply backs up every file it edits next to the original.</p><div class="modal-foot"><button class="btn" id="a-c">Close</button>' + (changes ? '<button class="btn primary" id="a-go">Apply</button>' : "") + "</div>",
              function (root) {
                $("#a-c", root).onclick = closeModal;
                var go2 = $("#a-go", root);
                if (go2) go2.onclick = function () {
                  api("POST", "/api/harnesses/" + id + "/apply").then(function (r) {
                    closeModal(); toast("Applied " + id); render();
                    setTimeout(function () { var el = $("#hx-" + id); if (el) el.innerHTML = '<div class="card-body" style="border-top:1px solid var(--border)"><pre class="log">' + esc(r.log.join("\n")) + "</pre></div>"; }, 200);
                  }).catch(fail);
                };
              });
          }).catch(fail);
        };
      });
      $$("[data-test]").forEach(function (b) {
        b.onclick = function () {
          var id = b.getAttribute("data-test");
          var el = $("#hx-" + id);
          el.innerHTML = '<div class="card-body faint small" style="border-top:1px solid var(--border)">Running</div>';
          api("POST", "/api/harnesses/" + id + "/test").then(function (r) {
            el.innerHTML = '<div class="card-body" style="border-top:1px solid var(--border)"><div class="row small" style="margin-bottom:6px">' + pill(r.ok ? "passed" : "failed", r.ok ? "ok" : "err") + '<span class="mono faint">' + esc(r.command) + '</span></div><pre class="log">' + esc(r.output) + "</pre></div>";
          }).catch(fail);
        };
      });
    });
  }

  function render() {
    renderNav();
    var r = route();
    var fn = { dashboard: viewDashboard, memory: viewMemory, handoffs: viewHandoffs, skills: viewSkills, secrets: viewSecrets, harnesses: viewHarnesses }[r.section];
    view.scrollTop = 0;
    Promise.resolve(fn(r.arg)).catch(function (e) {
      if (e.status === 401) view.innerHTML = '<div class="card content-narrow"><div class="empty">This page needs the token. Open the URL printed by <span class="mono">switchboard ui</span>.</div></div>';
      else view.innerHTML = '<div class="errbox content-narrow">' + esc(e.message) + "</div>";
    });
  }

  // ---------- command palette ----------
  var palItems = [], palSel = 0, palNotes = [], palSkills = [];
  function openPalette() {
    $("#palette").hidden = false;
    var inp = $("#palette-input");
    inp.value = "";
    inp.focus();
    palNotes = []; palSkills = [];
    renderPalette("");
    api("GET", "/api/memory").then(function (r) { palNotes = r.results; renderPalette(inp.value); }).catch(function () {});
    api("GET", "/api/skills").then(function (r) { palSkills = r; renderPalette(inp.value); }).catch(function () {});
  }
  function closePalette() { $("#palette").hidden = true; }
  function renderPalette(q) {
    q = q.toLowerCase().trim();
    var match = function (s) { return !q || s.toLowerCase().indexOf(q) !== -1; };
    palItems = SECTIONS.filter(function (s) { return match(s.label); }).map(function (s) { return { label: s.label, kind: "Section", icon: s.icon, run: function () { go(s.id); } }; })
      .concat(palNotes.filter(function (n) { return match(n.title) || match(n.path); }).slice(0, 12).map(function (n) {
        return { label: n.title, kind: n.type === "handoff" ? "Handoff" : "Note", icon: "memory", run: function () { memState.selected = n.path; go("memory", n.path); } };
      }))
      .concat(palSkills.filter(function (s) { return match(s.name); }).slice(0, 8).map(function (s) {
        return { label: s.name, kind: "Skill", icon: "skills", run: function () { go("skills", s.name); } };
      }))
      .concat(match("toggle dark mode theme") ? [{ label: "Toggle dark mode", kind: "Action", icon: "moon", run: function () { $("#theme-toggle").click(); } }] : []);
    palSel = Math.min(palSel, Math.max(palItems.length - 1, 0));
    $("#palette-list").innerHTML = palItems.length ? palItems.map(function (it, i) {
      return '<li data-i="' + i + '" class="' + (i === palSel ? "sel" : "") + '">' + icon(it.icon) + "<span>" + esc(it.label) + '</span><span class="kind">' + it.kind + "</span></li>";
    }).join("") : '<div class="palette-group">No results</div>';
    $$("#palette-list li").forEach(function (li) {
      li.onmousemove = function () { palSel = +li.getAttribute("data-i"); $$("#palette-list li").forEach(function (x) { x.classList.toggle("sel", x === li); }); };
      li.onclick = function () { choose(+li.getAttribute("data-i")); };
    });
  }
  function choose(i) { var it = palItems[i]; closePalette(); if (it) it.run(); }
  $("#palette-input").addEventListener("input", function (e) { palSel = 0; renderPalette(e.target.value); });
  $("#palette-input").addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") { palSel = Math.min(palSel + 1, palItems.length - 1); renderPalette(e.target.value); e.preventDefault(); }
    else if (e.key === "ArrowUp") { palSel = Math.max(palSel - 1, 0); renderPalette(e.target.value); e.preventDefault(); }
    else if (e.key === "Enter") { choose(palSel); e.preventDefault(); }
  });
  $("#palette").addEventListener("mousedown", function (e) { if (e.target.id === "palette") closePalette(); });
  $("#open-palette").addEventListener("click", openPalette);
  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("#palette").hidden ? openPalette() : closePalette(); }
    else if (e.key === "Escape") { if (!$("#palette").hidden) closePalette(); else if (!$("#modal").hidden) closeModal(); }
  });

  // ---------- boot ----------
  hydrateIcons();
  syncThemeLabel();
  window.addEventListener("hashchange", function () {
    var r = route();
    if (r.section === "memory" && $("#mem-list") && r.arg) { memState.selected = r.arg; memState.editing = false; renderNav(); renderMemoryList(); renderNote(); return; }
    render();
  });
  api("GET", "/api/dashboard").then(function (d) {
    counts = { memory: d.counts.notes, handoffs: d.counts.handoffs, skills: d.counts.skills, secrets: d.counts.secrets };
    gitState = d.git;
    $("#home-path").textContent = d.home;
    renderNav();
  }).catch(function () {});
  render();
})();
