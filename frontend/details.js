/* detail.js - click a card (CPU, MEM, DISK, health) to open a detailed overview with graphs.
 *
 * Needs auth.js (Auth, mk, openDialog...) and charts.js (SysCharts) loaded first.
 * Live numbers come from the normal dashboard polling (the "sysdata" event, every
 * couple of seconds); graphs and the process lists are fetched every 5 s while the
 * dialog is open and stop as soon as it closes.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const dlg = $("detailDialog");
  const body = $("detailBody");
  const titleEl = $("detailTitle");
  const errEl = $("detailError");

  const RANGE_SECONDS = { "5m": 300, "30m": 1800, "1h": 3600, "24h": 86400 };
  let range = "30m";
  let view = null;      // the open view: { title, needsInfo, el, update(ctx, tilesOnly) }
  let hist = null;      // last /server/history
  let info = null;      // last /server/detail
  let timer = null;
  let busy = false;
  let again = false;

  const bytes = SysCharts.fmtBytes;
  const rate = SysCharts.fmtRate;
  const pct = (v) => (v == null ? "—" : `${Math.round(v)}%`);
  const deg = (v) => (v == null ? "N/A" : `${Math.round(v)}°C`);
  const ctx = () => ({ sys: window.latestData || null, hist, info });

  /* ───────────── building blocks ───────────── */

  /** A grid of label/value tiles. defs: [{ label, get(ctx) -> text, wide? }] */
  function tiles(defs) {
    const cells = defs.map((d) => ({ d, val: mk("span", { class: "dtile__value" }, "—") }));
    const el = mk("div", { class: "dtiles" },
      cells.map(({ d, val }) => mk("div", { class: "dtile" + (d.wide ? " dtile--wide" : "") },
        mk("span", { class: "dtile__label" }, d.label), val)));
    return {
      el,
      update(c) {
        for (const { d, val } of cells) {
          let text;
          try { text = d.get(c); } catch (_) { text = "—"; }
          val.textContent = text == null ? "—" : text;
        }
      },
    };
  }

  /** A titled chart with a legend. pick(hist, key) returns the data column for a series. */
  function chartBlock(title, series, opts, pick = (h, key) => h[key], emptyText = "No data from this sensor.") {
    const legend = mk("div", { class: "dchart__legend" },
      series.map((s) => mk("span", {}, mk("i", { style: `background:${s.color}` }), s.label)));
    const note = mk("div", { class: "dchart__note" }, emptyText);
    note.hidden = true;
    const host = mk("div");
    const chart = new SysCharts.LineChart(host, Object.assign({ series }, opts));
    return {
      el: mk("section", { class: "dchart" }, mk("h3", {}, title), legend, note, host),
      set(h) {
        if (!h) return;
        const data = {};
        let any = false;
        for (const s of series) {
          const col = pick(h, s.key) || [];
          data[s.key] = col;
          if (col.some(Number.isFinite)) any = true;
        }
        host.hidden = !any;
        note.hidden = any;
        if (any) {
          chart.opts.spanSeconds = RANGE_SECONDS[range];
          chart.setData(h.t, data);
        }
      },
    };
  }

  function setBar(bar, value) {
    bar.style.width = `${Math.min(100, Math.max(0, value))}%`;
    bar.classList.remove("bar--ok", "bar--warn", "bar--crit");
    bar.classList.add(value >= 90 ? "bar--crit" : value >= 70 ? "bar--warn" : "bar--ok");
  }

  function coreGrid() {
    const grid = mk("div", { class: "dcores" });
    return {
      el: mk("section", { class: "dchart" }, mk("h3", {}, "Per-core load"), grid),
      update(i) {
        const cores = (i && i.cpu && i.cpu.cores) || [];
        if (grid.children.length !== cores.length) {
          grid.replaceChildren(...cores.map((_, n) => mk("div", { class: "dcore" },
            mk("span", { class: "dcore__label" }, `C${n}`),
            mk("div", { class: "hcard__bar-wrap" }, mk("div", { class: "hcard__bar" })),
            mk("span", { class: "dcore__val" }, "—"))));
        }
        cores.forEach((v, n) => {
          const row = grid.children[n];
          setBar(row.querySelector(".hcard__bar"), v);
          row.querySelector(".dcore__val").textContent = pct(v);
        });
      },
    };
  }

  function processTable(title, listKey) {
    const tbody = mk("tbody");
    return {
      el: mk("section", { class: "dchart" }, mk("h3", {}, title),
        mk("div", { class: "dtable-wrap" },
          mk("table", { class: "dtable" },
            mk("thead", {}, mk("tr", {},
              mk("th", {}, "Process"), mk("th", { class: "num" }, "CPU"),
              mk("th", { class: "num hide-sm" }, "Mem %"), mk("th", { class: "num" }, "RAM"))),
            tbody))),
      update(i) {
        const rows = (i && i.processes && i.processes[listKey]) || [];
        if (!rows.length) {
          tbody.replaceChildren(mk("tr", {}, mk("td", { colSpan: 4, class: "muted" }, "Loading…")));
          return;
        }
        tbody.replaceChildren(...rows.map((p) => mk("tr", {},
          mk("td", {}, p.name, mk("span", { class: "muted" }, ` · ${p.pid}`)),
          mk("td", { class: "num" }, `${p.cpu.toFixed(1)}%`),
          mk("td", { class: "num hide-sm" }, `${p.mem_pct.toFixed(1)}%`),
          mk("td", { class: "num" }, bytes(p.rss)))));
      },
    };
  }

  /* ───────────── the four views ───────────── */

  function buildCpu() {
    const t = tiles([
      { label: "LOAD", get: (c) => pct(c.sys && c.sys.cpu) },
      { label: "TEMP", get: (c) => deg(c.sys && c.sys.cpu_temp) },
      { label: "CORES / THREADS", get: (c) => c.info ? `${c.info.cpu.physical ?? "?"}C / ${c.info.cpu.logical}T` : "…" },
      { label: "CLOCK", get: (c) => { const f = c.info && c.info.cpu.freq_mhz; return f ? `${(f.current / 1000).toFixed(2)} GHz` : "N/A"; } },
      { label: "LOAD AVG 1/5/15", get: (c) => c.info ? (c.info.cpu.load_avg ? c.info.cpu.load_avg.join(" / ") : "N/A") : "…", wide: true },
      { label: "MODEL", get: (c) => c.info ? c.info.cpu.model : "…", wide: true },
    ]);
    const load = chartBlock("CPU load", [{ key: "cpu", label: "Load", color: "var(--accent)" }],
      { yMin: 0, yMax: 100, format: (v) => `${Math.round(v)}%` });
    const temp = chartBlock("CPU temperature", [{ key: "cpu_temp", label: "Temperature", color: "var(--accent2)" }],
      { yMin: "auto", format: (v) => `${Math.round(v)}°C` }, undefined,
      "No CPU temperature sensor is available on this machine.");
    const cores = coreGrid();
    const procs = processTable("Top processes by CPU", "cpu");
    return {
      title: "CPU", needsInfo: true,
      el: mk("div", { class: "dview" }, t.el, load.el, temp.el, cores.el, procs.el),
      update(c, tilesOnly) {
        t.update(c);
        if (tilesOnly) return;
        load.set(c.hist); temp.set(c.hist); cores.update(c.info); procs.update(c.info);
      },
    };
  }

  function buildMem() {
    const t = tiles([
      { label: "RAM USED", get: (c) => pct(c.sys && c.sys.memory) },
      { label: "SWAP USED", get: (c) => pct(c.sys && c.sys.swap) },
      { label: "TOTAL", get: (c) => c.info ? bytes(c.info.memory.total) : "…" },
      { label: "IN USE", get: (c) => c.info ? bytes(c.info.memory.used) : "…" },
      { label: "AVAILABLE", get: (c) => c.info ? bytes(c.info.memory.available) : "…" },
      { label: "CACHED", get: (c) => c.info ? (c.info.memory.cached == null ? "N/A" : bytes(c.info.memory.cached)) : "…" },
      { label: "SWAP", get: (c) => c.info ? `${bytes(c.info.memory.swap_used)} / ${bytes(c.info.memory.swap_total)}` : "…", wide: true },
    ]);
    const usage = chartBlock("Memory usage", [
      { key: "mem", label: "RAM", color: "var(--accent)" },
      { key: "swap", label: "Swap", color: "var(--accent2)" },
    ], { yMin: 0, yMax: 100, format: (v) => `${Math.round(v)}%` });
    const procs = processTable("Top processes by memory", "memory");
    return {
      title: "Memory", needsInfo: true,
      el: mk("div", { class: "dview" }, t.el, usage.el, procs.el),
      update(c, tilesOnly) {
        t.update(c);
        if (tilesOnly) return;
        usage.set(c.hist); procs.update(c.info);
      },
    };
  }

  function buildDisk() {
    const drives = (window.latestData && window.latestData.drives) || [];
    const el = mk("div", { class: "dview" });
    if (!drives.length) el.append(mk("p", { class: "muted" }, "No drives detected."));
    const parts = drives.map((d) => {
      const find = (c) => (c.sys && c.sys.drives || []).find((x) => x.id === d.id);
      const pick = (h, key) => h.drives && h.drives[d.id] && h.drives[d.id][key];
      const t = tiles([
        { label: "USED", get: (c) => { const x = find(c); return x && `${bytes(x.used)} (${Math.round(x.percent)}%)`; } },
        { label: "FREE", get: (c) => { const x = find(c); return x && bytes(x.free); } },
        { label: "TOTAL", get: (c) => { const x = find(c); return x && bytes(x.size); } },
        { label: "TEMP", get: (c) => { const x = find(c); return x && deg(x.temp); } },
        { label: "READ", get: (c) => { const x = find(c); return x && rate(x.read_speed); } },
        { label: "WRITE", get: (c) => { const x = find(c); return x && rate(x.write_speed); } },
        { label: "VOLUMES", get: (c) => { const x = find(c); return x && (x.volumes.join(", ") || "none mounted"); }, wide: true },
      ]);
      const thr = chartBlock("Throughput", [
        { key: "read", label: "Read", color: "var(--blue)", format: rate },
        { key: "write", label: "Write", color: "var(--accent2)", format: rate },
      ], { yMin: 0, yMax: null, scale: "bytes", format: rate }, pick);
      const temp = chartBlock("Temperature", [{ key: "temp", label: "Temperature", color: "var(--accent3)" }],
        { yMin: "auto", format: (v) => `${Math.round(v)}°C` }, pick,
        "This drive does not report a temperature.");
      const use = chartBlock("Space used", [{ key: "percent", label: "Used", color: "var(--accent)" }],
        { yMin: 0, yMax: 100, format: (v) => `${Math.round(v)}%` }, pick);
      el.append(mk("section", { class: "dsection" },
        mk("h2", {}, d.name, mk("span", { class: "muted" }, `  ${d.name !== d.id ? d.id + " · " : ""}${d.kind}`)),
        t.el, thr.el, temp.el, use.el));
      return { t, thr, temp, use };
    });
    return {
      title: "Disks", needsInfo: false, el,
      update(c, tilesOnly) {
        parts.forEach((p) => {
          p.t.update(c);
          if (tilesOnly) return;
          p.thr.set(c.hist); p.temp.set(c.hist); p.use.set(c.hist);
        });
      },
    };
  }

  function buildHealth() {
    const issues = mk("ul", { class: "dissues" });
    const t = tiles([
      { label: "STATUS", get: (c) => c.sys && c.sys.health && c.sys.health.label },
      { label: "SCORE", get: (c) => c.sys && c.sys.health && `${c.sys.health.score} / 100` },
      { label: "UPTIME %", get: (c) => c.sys && c.sys.uptime_percent != null ? `${c.sys.uptime_percent.toFixed(2)}%` : "—" },
      { label: "UPTIME", get: (c) => c.sys && c.sys.uptime },
    ]);
    const score = chartBlock("Health score", [{ key: "score", label: "Score", color: "var(--accent)" }],
      { yMin: 0, yMax: 100, format: (v) => `${Math.round(v)}` });
    const net = chartBlock("Network throughput", [
      { key: "net_down", label: "Download", color: "var(--blue)", format: rate },
      { key: "net_up", label: "Upload", color: "var(--accent2)", format: rate },
    ], { yMin: 0, yMax: null, scale: "bytes", format: rate });
    const issuesBlock = mk("section", { class: "dchart" }, mk("h3", {}, "Current issues"), issues);
    return {
      title: "System health", needsInfo: false,
      el: mk("div", { class: "dview" }, t.el, issuesBlock, score.el, net.el),
      update(c, tilesOnly) {
        t.update(c);
        const list = (c.sys && c.sys.health && c.sys.health.issues) || [];
        issues.replaceChildren(...(list.length
          ? list.map((i) => mk("li", { class: `issue issue--${i.severity}` },
              mk("span", { class: "issue__sev" }, i.severity === "warning" ? "WARN" : i.severity === "critical" ? "CRIT" : "INFO"),
              mk("span", { class: "issue__msg" }, i.message),
              mk("span", { class: "issue__src" }, i.source)))
          : [mk("li", { class: "issue issue--none" }, "No issues detected")]));
        if (tilesOnly) return;
        score.set(c.hist); net.set(c.hist);
      },
    };
  }

  const VIEWS = { cpu: buildCpu, mem: buildMem, disk: buildDisk, health: buildHealth };

  /* ───────────── open / refresh / close ───────────── */

  const setError = (msg) => { errEl.textContent = msg || ""; };

  async function refresh() {
    if (!view) return;
    if (busy) { again = true; return; }
    busy = true;
    const mine = view;
    try {
      const [h, i] = await Promise.all([
        Auth.json(`/server/history?range=${range}`),
        mine.needsInfo ? Auth.json("/server/detail") : Promise.resolve(info),
      ]);
      if (view !== mine) return; // closed or switched while loading
      hist = h;
      info = i;
      setError("");
      mine.update(ctx(), false);
    } catch (err) {
      if (!(err instanceof AuthError) && view === mine) setError(`Could not load details: ${err.message}`);
    } finally {
      busy = false;
      if (again) { again = false; refresh(); }
    }
  }

  function markRange() {
    document.querySelectorAll("#detailRanges [data-range]").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.range === range);
      b.setAttribute("aria-pressed", String(b.dataset.range === range));
    });
  }

  function open(kind) {
    const build = VIEWS[kind];
    if (!build || !window.latestData) return; // nothing to show before the first data arrives
    view = build();
    hist = null;
    info = null;
    titleEl.textContent = view.title;
    body.replaceChildren(view.el);
    setError("");
    markRange();
    openDialog(dlg);
    view.update(ctx(), true);
    refresh();
    clearInterval(timer);
    timer = setInterval(refresh, 5000);
  }

  dlg.addEventListener("close", () => {
    clearInterval(timer);
    timer = null;
    view = null;
    body.replaceChildren();
  });

  $("detailRanges").addEventListener("click", (e) => {
    const b = e.target.closest("[data-range]");
    if (!b || b.dataset.range === range) return;
    range = b.dataset.range;
    markRange();
    refresh();
  });

  // live numbers: refresh just the tiles each time the dashboard receives data
  window.addEventListener("sysdata", () => { if (view) view.update(ctx(), true); });
  window.addEventListener("auth:logout", () => { view = null; });

  // open from a click or the keyboard on any card marked data-detail="cpu|mem|disk|health"
  document.addEventListener("click", (e) => {
    const card = e.target.closest("[data-detail]");
    if (!card || e.target.closest("a, button, input, select, textarea")) return;
    open(card.dataset.detail);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest && e.target.closest("[data-detail]");
    if (card && e.target === card) {
      e.preventDefault();
      open(card.dataset.detail);
    }
  });
})();
