/* ===================================================================
   Vaak Console — operator surface (WP-8)

   Renders GET /api/console/summary. Vanilla JS, no dependencies, no
   build step (the repo deploys as a static site).

   Two rules this file will not break:
     1. Never render a number the API did not return. No seeded demo
        data, no placeholder counts — an empty pipeline renders an
        empty state that says how to put something in it.
     2. Never imply durability the backend doesn't have. The store is
        an in-process ring buffer today; the banner says so until the
        API reports otherwise.
   =================================================================== */
(function () {
  "use strict";

  var KEY_SS = "vaak_operator_key";
  var THEME_LS = "vaak_console_theme";
  var POLL_MS = 15000;

  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  var icon = function (id, cls) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", cls || "icon");
    svg.setAttribute("aria-hidden", "true");
    var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#" + id);
    svg.appendChild(use);
    return svg;
  };

  /* ---------------- theme ---------------- */
  function applyTheme(t) {
    if (t) document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
    var isDark = t === "dark" ||
      (!t && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var use = $("theme") && $("theme").querySelector("use");
    if (use) use.setAttribute("href", isDark ? "#i-sun" : "#i-moon");
  }
  applyTheme(localStorage.getItem(THEME_LS) || null);

  /* ---------------- key gate ---------------- */
  function getKey() { return sessionStorage.getItem(KEY_SS) || ""; }

  function showGate(message) {
    $("app").hidden = true;
    $("gate").hidden = false;
    var err = $("gate-error");
    if (message) { err.textContent = message; err.hidden = false; }
    else { err.hidden = true; }
    $("gate-key").focus();
  }

  function showApp() {
    $("gate").hidden = true;
    $("app").hidden = false;
  }

  $("gate-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = $("gate-key").value.trim();
    if (!v) return;
    sessionStorage.setItem(KEY_SS, v);
    $("gate-key").value = "";
    showApp();
    load();
  });

  $("signout").addEventListener("click", function () {
    sessionStorage.removeItem(KEY_SS);
    showGate();
  });

  $("theme").addEventListener("click", function () {
    var cur = document.documentElement.getAttribute("data-theme");
    var next = cur === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_LS, next);
    applyTheme(next);
  });

  $("refresh").addEventListener("click", function () { load(); });

  /* ---------------- fetch ---------------- */
  var loading = false;

  function load() {
    var key = getKey();
    if (!key) return showGate();
    if (loading) return;
    loading = true;
    setFreshness("Refreshing…", "muted");

    fetch("/api/console/summary?limit=60", {
      headers: { Authorization: "Bearer " + key }
    })
      .then(function (r) {
        if (r.status === 401) throw new Error("unauthorized");
        if (r.status === 503) throw new Error("not_configured");
        if (!r.ok) throw new Error("http_" + r.status);
        return r.json();
      })
      .then(function (data) {
        // Rendering runs OUTSIDE the network catch below. Sharing it meant a
        // bug in a render function reported itself as "Offline — retrying",
        // so a console that was broken looked exactly like a console that
        // could not reach the API, forever.
        try {
          render(data);
        } catch (e) {
          setFreshness("Display error — " + e.message, "danger");
          throw new Error("__rendered__");
        }
      })
      .catch(function (err) {
        if (err.message === "__rendered__") return;
        if (err.message === "unauthorized") {
          sessionStorage.removeItem(KEY_SS);
          return showGate("That key was rejected. Check INTEGRATIONS_API_KEY on the deployment.");
        }
        if (err.message === "not_configured") {
          return showGate("This deployment has no INTEGRATIONS_API_KEY set, so the console API is disabled.");
        }
        setFreshness("Offline — retrying", "danger");
      })
      .finally(function () { loading = false; });
  }

  function setFreshness(text, kind) {
    var n = $("freshness");
    n.textContent = text;
    n.className = "badge badge--" + (kind || "muted");
  }

  /* ---------------- render ---------------- */
  function render(data) {
    renderProvenance(data.store, data.wiring);
    renderKpis(data.funnel, data.wiring);
    renderFunnel(data.funnel);
    renderBlocks(data.funnel);
    renderCalls(data.calls, data.store);
    renderEvents(data.events);
    renderWiring(data.wiring);

    var t = new Date(data.generatedAt);
    setFreshness("Updated " + t.toLocaleTimeString(), "ok");
  }

  /* provenance banner — the honest one */
  function renderProvenance(store, wiring) {
    var host = $("provenance");
    host.textContent = "";
    if (!store) return;

    var b = el("div", "banner");
    b.appendChild(icon("i-alert"));
    var body = el("div");
    body.appendChild(el("div", "banner__title", "Live view, not history"));

    var msg = store.durable
      ? "Backed by the configured datastore."
      : "Counts below come from an in-process buffer holding " + store.held +
        " of " + store.capacity + " events since this instance started " +
        new Date(store.instanceStartedAt).toLocaleString() +
        ". It resets on cold start and a second instance keeps its own — wire DATABASE_URL for real history.";
    body.appendChild(el("div", "banner__body", msg));

    if (wiring && !wiring.canDial) {
      body.appendChild(el("div", "banner__body",
        "This deployment cannot place a real call yet — see Wiring below."));
    }
    b.appendChild(body);
    host.appendChild(b);
  }

  function kpi(span, label, iconId, value, foot, muted) {
    var c = el("div", "card " + span);
    var lab = el("div", "kpi__label");
    lab.appendChild(icon(iconId));
    lab.appendChild(el("span", null, label));
    c.appendChild(lab);
    c.appendChild(el("div", "kpi__value" + (muted ? " kpi__value--muted" : ""), value));
    if (foot) c.appendChild(el("div", "kpi__foot", foot));
    return c;
  }

  function renderKpis(f, wiring) {
    var host = $("kpis");
    host.textContent = "";
    var c = f.counts;

    host.appendChild(kpi("span-3", "Leads received", "i-inbox", String(c.received),
      Object.keys(f.bySource).length
        ? Object.keys(f.bySource).map(function (k) { return k + " " + f.bySource[k]; }).join(" · ")
        : "no source yet"));

    host.appendChild(kpi("span-3", "Blocked by gate", "i-shield", String(c.blocked),
      c.received ? Math.round((c.blocked / c.received) * 100) + "% of leads" : "—"));

    // A rate with no denominator is null from the API, and renders as "—".
    host.appendChild(kpi("span-3", "Calls queued", "i-phone", String(c.queued),
      f.dialRate == null ? "no leads yet" : f.dialRate + "% of leads reached dial"));

    host.appendChild(
      f.bookRate == null
        ? kpi("span-3", "Site visits booked", "i-check", "—", "no completed calls yet", true)
        : kpi("span-3", "Site visits booked", "i-check", String(c.booked),
            f.bookRate + "% of " + c.completed + " completed" +
            (f.avgScore == null ? "" : " · avg intent " + f.avgScore))
    );
  }

  /* Funnel: bars PLUS an explicit % and count as text on every stage, and the
     whole thing degrades to a readable list — the chart DB requires both. */
  function renderFunnel(f) {
    var host = $("funnel");
    host.textContent = "";
    var c = f.counts;

    if (!c.received) {
      return host.appendChild(emptyState(
        "i-funnel", "No leads yet",
        "Push one through and this fills in:",
        "POST /api/leads/intake"));
    }

    var stages = [
      { name: "Received", n: c.received, cls: "" },
      { name: "Passed compliance", n: Math.max(0, c.received - c.blocked), cls: "funnel__bar--ok" },
      { name: "Queued to dial", n: c.queued, cls: "" },
      { name: "Call completed", n: c.completed, cls: "" },
      { name: "Booked", n: c.booked, cls: "funnel__bar--ok" }
    ];

    var top = c.received || 1;
    var wrap = el("div", "funnel");

    stages.forEach(function (s) {
      var pct = Math.round((s.n / top) * 100);
      var row = el("div", "funnel__row");

      var meta = el("div", "funnel__meta");
      meta.appendChild(el("span", "funnel__name", s.name));
      meta.appendChild(el("span", "funnel__count", String(s.n)));
      meta.appendChild(el("span", "funnel__pct", pct + "%"));
      row.appendChild(meta);

      var track = el("div", "funnel__track");
      var bar = el("div", "funnel__bar " + s.cls);
      bar.style.width = pct + "%";
      track.appendChild(bar);
      // The bar is decoration; the numbers above it are the data.
      track.setAttribute("role", "img");
      track.setAttribute("aria-label", s.name + ": " + s.n + " of " + top + ", " + pct + " percent");
      row.appendChild(track);

      wrap.appendChild(row);
    });

    host.appendChild(wrap);
  }

  function renderBlocks(f) {
    var host = $("blocks");
    host.textContent = "";
    var reasons = Object.keys(f.blockReasons);

    if (!reasons.length) {
      return host.appendChild(emptyState(
        "i-check", "Nothing blocked",
        "Every lead so far cleared the compliance gate."));
    }

    reasons.sort(function (a, b) { return f.blockReasons[b] - f.blockReasons[a]; });

    var list = el("ul", "status");
    reasons.forEach(function (r) {
      var li = el("li", "status__row");
      var kind = /dnd_registered|suppressed|no_consent|consent_expired/.test(r) ? "danger" : "warn";
      var badge = el("span", "badge badge--" + kind);
      badge.appendChild(icon("i-block"));
      badge.appendChild(el("span", null, String(f.blockReasons[r])));
      li.appendChild(badge);
      li.appendChild(el("span", "status__name", humanReason(r)));
      list.appendChild(li);
    });
    host.appendChild(list);
  }

  function humanReason(r) {
    var map = {
      invalid_phone: "Not a dialable number",
      no_consent: "No consent recorded",
      no_consent_basis: "Consent has no basis",
      consent_timestamp_missing: "Consent has no timestamp",
      consent_expired: "Consent older than the window",
      suppressed: "On our do-not-call list",
      suppression_unverified: "DNC list unreachable",
      dnd_registered: "Registered DND",
      dnd_unverified: "DND scrub unreachable",
      outside_calling_window: "Outside 9am–9pm IST"
    };
    return map[r] || r;
  }

  /* ---------------- finished calls ----------------
     A row per call with the score and how it was reached. The transcript is
     NOT in this payload — it is fetched one call at a time on demand, because
     a response carrying fifty conversations is an exfiltration shape and
     because every read of one is logged server-side. */
  function renderCalls(calls, store) {
    var host = $("calls-body");
    host.textContent = "";
    calls = calls || [];
    $("calls-count").textContent = calls.length ? calls.length + " calls" : "";

    if (!calls.length) {
      // "No calls yet" and "no database" mean opposite things, and an operator
      // staring at an empty table deserves to know which one this is.
      return host.appendChild(store && store.durable
        ? emptyState("i-phone", "No finished calls yet",
          "A call reported to /api/calls/outcome appears here with its transcript and score.")
        : emptyState("i-alert", "Calls are not being kept",
          "Transcripts need a durable store. Set FIREBASE_SERVICE_ACCOUNT on the deployment."));
    }

    var wrap = el("div", "table-wrap");
    var table = el("table", "table");
    var thead = el("thead");
    var hr = el("tr");
    ["Time", "Outcome", "Lead", "Number", "Potency", "Length", ""].forEach(function (h) {
      hr.appendChild(el("th", null, h));
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el("tbody");
    calls.forEach(function (c) { appendCallRow(tbody, c); });
    table.appendChild(tbody);
    wrap.appendChild(table);
    host.appendChild(wrap);
  }

  function appendCallRow(tbody, c) {
    var tr = el("tr");

    var time = el("td", "mono");
    time.textContent = c.startedAt || c.at ? new Date(c.startedAt || c.at).toLocaleString() : "—";
    tr.appendChild(time);

    var out = el("td");
    var spec = {
      "booked": ["ok", "i-check"], "callback": ["warn", "i-phone"],
      "opt-out": ["danger", "i-block"], "not-interested": ["muted", "i-inbox"]
    }[c.disposition] || ["muted", "i-inbox"];
    var b = el("span", "badge badge--" + spec[0]);
    b.appendChild(icon(spec[1]));
    b.appendChild(el("span", null, c.disposition || "unknown"));
    out.appendChild(b);
    tr.appendChild(out);

    tr.appendChild(el("td", null, (c.lead && c.lead.name) || "—"));

    var ph = el("td", "mono");
    ph.textContent = (c.lead && c.lead.phoneMasked) || "—";
    tr.appendChild(ph);

    // Score AND coverage. A 70 off four answers and a 70 off one are not the
    // same lead, so the console never shows one without the other.
    var pot = el("td");
    if (c.score == null) {
      pot.textContent = "—";
    } else {
      var pb = el("span", "badge badge--" + bandKind(c.band));
      pb.appendChild(el("span", null, c.score + "/100 " + (c.band || "")));
      pot.appendChild(pb);
      if (c.scoring && c.scoring.of) {
        pot.appendChild(el("div", "muted", c.scoring.answered + " of " + c.scoring.of + " questions answered"));
      }
    }
    tr.appendChild(pot);

    tr.appendChild(el("td", "mono", c.durationSec ? c.durationSec + "s" : "—"));

    var actions = el("td");
    var open = el("button", "btn btn--sm", "Transcript");
    open.type = "button";
    actions.appendChild(open);
    if (c.recordingRef) {
      var play = el("button", "btn btn--sm", "Recording");
      play.type = "button";
      play.addEventListener("click", function () { playRecording(play, c.recordingRef); });
      actions.appendChild(play);
    }
    tr.appendChild(actions);
    tbody.appendChild(tr);

    var detail = el("tr");
    detail.hidden = true;
    var cell = el("td");
    cell.colSpan = 7;
    detail.appendChild(cell);
    tbody.appendChild(detail);

    var loaded = false;
    open.addEventListener("click", function () {
      detail.hidden = !detail.hidden;
      if (detail.hidden || loaded) return;
      loaded = true;
      cell.textContent = "Loading…";
      fetchTranscript(c.callId)
        .then(function (full) { cell.textContent = ""; cell.appendChild(transcriptView(full)); })
        .catch(function (e) { loaded = false; cell.textContent = "Could not load the transcript (" + e.message + ")."; });
    });
  }

  function bandKind(band) {
    return { hot: "ok", warm: "warn", cool: "muted", cold: "muted" }[band] || "muted";
  }

  function fetchTranscript(callId) {
    return fetch("/api/calls/transcript?callId=" + encodeURIComponent(callId), {
      headers: { Authorization: "Bearer " + getKey() }
    }).then(function (r) {
      if (!r.ok) throw new Error("http_" + r.status);
      return r.json();
    }).then(function (d) { return d.call; });
  }

  /** The conversation, plus where the score came from. */
  function transcriptView(call) {
    var box = el("div", "transcript");

    if (call.scoring && call.scoring.explain) {
      box.appendChild(el("p", "muted", call.scoring.explain));
    }
    if (call.summary) box.appendChild(el("p", null, call.summary));
    if (call.nextAction) box.appendChild(el("p", null, "Next: " + call.nextAction));

    (call.transcript || []).forEach(function (t) {
      var line = el("div", "transcript__line transcript__line--" + (t.role === "agent" ? "agent" : "user"));
      line.appendChild(el("strong", null, t.role === "agent" ? "Anaga: " : "Prospect: "));
      // textContent, never innerHTML: this is speech transcribed from a stranger
      // on a phone call, and it renders inside an authenticated operator page.
      line.appendChild(document.createTextNode(t.text));
      box.appendChild(line);
    });

    if (!(call.transcript || []).length) {
      box.appendChild(el("p", "muted", "No transcript was stored for this call."));
    }
    return box;
  }

  /** Mint a short-lived signed URL and play it. The URL is never rendered. */
  function playRecording(btn, ref) {
    btn.disabled = true;
    btn.textContent = "Loading…";
    fetch("/api/calls/recording?ref=" + encodeURIComponent(ref), {
      headers: { Authorization: "Bearer " + getKey() }
    })
      .then(function (r) {
        if (r.status === 503) throw new Error("recording storage is not configured");
        if (!r.ok) throw new Error("http_" + r.status);
        return r.json();
      })
      .then(function (d) {
        var audio = el("audio");
        audio.controls = true;
        audio.src = d.url;
        btn.parentNode.replaceChild(audio, btn);
        audio.play().catch(function () { /* the operator can press play */ });
      })
      .catch(function (e) {
        btn.disabled = false;
        btn.textContent = "Recording";
        setFreshness("Playback failed — " + e.message, "danger");
      });
  }

  function renderEvents(events) {
    var host = $("events");
    host.textContent = "";
    $("activity-count").textContent = events.length ? events.length + " events" : "";

    if (!events.length) {
      return host.appendChild(emptyState(
        "i-inbox", "No activity yet",
        "Lead intake, compliance verdicts and call outcomes appear here as they happen."));
    }

    var wrap = el("div", "table-wrap");
    var table = el("table", "table");

    var thead = el("thead");
    var hr = el("tr");
    ["Time", "Event", "Lead", "Number", "Detail"].forEach(function (h) {
      hr.appendChild(el("th", null, h));
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el("tbody");
    events.forEach(function (e) {
      var tr = el("tr");

      var time = el("td", "mono");
      time.textContent = new Date(e.at).toLocaleTimeString();
      tr.appendChild(time);

      var evt = el("td");
      evt.appendChild(eventBadge(e));
      tr.appendChild(evt);

      tr.appendChild(el("td", null, e.name || "—"));

      var ph = el("td", "mono");
      ph.textContent = e.phone || "—";
      tr.appendChild(ph);

      tr.appendChild(el("td", null, eventDetail(e)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    host.appendChild(wrap);
  }

  function eventBadge(e) {
    var spec = {
      "lead.received":  ["muted",  "i-inbox", "received"],
      "lead.blocked":   ["danger", "i-block", "blocked"],
      "call.queued":    ["warn",   "i-phone", "queued"],
      "call.completed": ["ok",     "i-check", "completed"],
      "lead.optout":    ["danger", "i-block", "opt-out"]
    }[e.type] || ["muted", "i-inbox", e.type];

    if (e.type === "call.queued" && e.queued === false) spec = ["danger", "i-alert", "not queued"];

    var b = el("span", "badge badge--" + spec[0]);
    b.appendChild(icon(spec[1]));
    b.appendChild(el("span", null, spec[2]));
    return b;
  }

  function eventDetail(e) {
    if (e.type === "lead.blocked") return humanReason(e.reason);
    if (e.type === "call.queued") {
      return e.queued ? (e.callId || "queued") : humanReason(e.reason || "not queued");
    }
    if (e.type === "call.completed") {
      var bits = [e.disposition];
      if (Number.isFinite(e.score)) bits.push("intent " + e.score + "/100");
      if (e.durationSec) bits.push(e.durationSec + "s");
      if (e.reviewedBy === "heuristic") bits.push("fallback review");
      return bits.join(" · ");
    }
    return e.campaign || e.source || "—";
  }

  function renderWiring(w) {
    var host = $("wiring-body");
    host.textContent = "";

    var rows = [
      ["Meta Lead Ads", w.meta.appSecret && w.meta.pageAccessToken,
        w.meta.appSecret ? (w.meta.pageAccessToken ? "Graph " + w.meta.graphVersion : "no page token") : "no app secret"],
      ["CRM", w.crm.configured && w.crm.provider !== "none", w.crm.provider],
      ["DND scrub", w.compliance.dndScrub, w.compliance.dndScrub ? "configured" : "unconfigured — dials blocked"],
      ["Suppression list", w.compliance.suppressionList,
        w.compliance.suppressionList ? "durable" : "in-memory only — opt-outs are not durable"],
      ["Dial queue", w.dialQueue.configured,
        w.dialQueue.configured ? (w.dialQueue.signed ? "signed" : "unsigned") : "no consumer — nothing dials"],
      ["Compliance mode", w.compliance.mode === "strict", w.compliance.mode],
      ["Calling window", true, w.compliance.callingWindowIST + " IST"]
    ];

    var list = el("ul", "status");
    rows.forEach(function (r) {
      var li = el("li", "status__row");
      var b = el("span", "badge badge--" + (r[1] ? "ok" : "warn"));
      b.appendChild(icon(r[1] ? "i-check" : "i-alert"));
      b.appendChild(el("span", null, r[1] ? "ready" : "todo"));
      li.appendChild(b);
      li.appendChild(el("span", "status__name", r[0]));
      li.appendChild(el("span", "status__detail", r[2]));
      list.appendChild(li);
    });
    host.appendChild(list);

    var banner = el("div", "banner " + (w.canDial ? "banner--ok" : ""));
    banner.appendChild(icon(w.canDial ? "i-check" : "i-alert"));
    var body = el("div");
    body.appendChild(el("div", "banner__title",
      w.canDial ? "Ready to dial" : w.blockers.length + " item" + (w.blockers.length === 1 ? "" : "s") + " before a real dial"));
    body.appendChild(el("div", "banner__body",
      w.canDial ? "Every gate dependency is configured." : w.blockers.join(" · ")));
    banner.appendChild(body);
    host.appendChild(banner);
  }

  /* Empty states guide the operator to the action that fills them. */
  function emptyState(iconId, title, hint, code) {
    var e = el("div", "empty");
    e.appendChild(icon(iconId));
    e.appendChild(el("div", "empty__title", title));
    var h = el("p", "empty__hint");
    h.appendChild(document.createTextNode(hint + " "));
    if (code) h.appendChild(el("code", null, code));
    e.appendChild(h);
    return e;
  }

  /* ---------------- section nav (current section indicated) ---------------- */
  var links = Array.prototype.slice.call(document.querySelectorAll(".nav__link"));
  var SECTIONS = ["overview", "pipeline", "compliance", "activity", "wiring"];

  if ("IntersectionObserver" in window) {
    // Track which sections are on screen and always highlight the FIRST one in
    // document order. Reacting per-entry lets whichever entry the observer
    // happens to report last win, which highlighted the wrong section.
    var visible = Object.create(null);

    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { visible[en.target.id] = en.isIntersecting; });

      var current = null;
      for (var i = 0; i < SECTIONS.length; i++) {
        if (visible[SECTIONS[i]]) { current = SECTIONS[i]; break; }
      }
      if (!current) return;

      links.forEach(function (a) {
        a.setAttribute("aria-current", a.getAttribute("href") === "#" + current ? "true" : "false");
      });
    }, { rootMargin: "-10% 0px -60% 0px" });

    SECTIONS.forEach(function (id) {
      var n = document.getElementById(id);
      if (n) obs.observe(n);
    });
  }

  /* ---------------- boot ---------------- */
  if (getKey()) { showApp(); load(); } else { showGate(); }

  setInterval(function () {
    if (!$("app").hidden && document.visibilityState === "visible") load();
  }, POLL_MS);
})();
