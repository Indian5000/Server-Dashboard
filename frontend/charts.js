/* charts.js - a small dependency-free line chart (HTML canvas).
 *
 *   const chart = new SysCharts.LineChart(hostDiv, {
 *     series: [{ key: "cpu", label: "Load", color: "var(--accent)" }],
 *     yMin: 0, yMax: 100,            // or yMin: "auto" / yMax: null to fit the data
 *     format: (v) => Math.round(v) + "%",
 *   });
 *   chart.setData(timesInSeconds, { cpu: [12, 14, null, 20] });   // null = gap
 *
 * Hover the chart to see a crosshair and the exact values.
 * Wrapped in an IIFE so it can never clash with names in script.js.
 */
const SysCharts = (() => {
  const cssVar = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const resolveColor = (c) =>
    c && c.startsWith("var(")
      ? cssVar(c.slice(4, -1).trim()) || "#888"
      : c || "#888";

  const pad2 = (n) => String(n).padStart(2, "0");

  /** Round a maximum up to a "nice" number: 1, 2, 2.5, 5, 10 x 10^n. */
  function niceMax(v) {
    if (!Number.isFinite(v) || v <= 0) return 1;
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / exp;
    const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return nice * exp;
  }

  /** Like niceMax, but rounds in 1024-based units so ticks read 25 / 50 / 75 / 100 MB/s. */
  function niceBytesMax(v) {
    if (!Number.isFinite(v) || v <= 0) return 1024;
    const i = Math.min(
      4,
      Math.max(0, Math.floor(Math.log(v) / Math.log(1024))),
    );
    const unit = Math.pow(1024, i);
    return niceMax(v / unit) * unit;
  }

  function fmtBytes(n, decimals = 1) {
    if (n == null || !Number.isFinite(n)) return "—";
    if (n < 1) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(
      units.length - 1,
      Math.floor(Math.log(n) / Math.log(1024)),
    );
    return `${parseFloat((n / Math.pow(1024, i)).toFixed(decimals))} ${units[i]}`;
  }

  const fmtRate = (n) => (n == null ? "—" : `${fmtBytes(n)}/s`);

  /** Clock text in the SERVER's timezone when we know it (script.js sets clockBase). */
  function clockText(tSec, withSeconds) {
    let offsetMin = -new Date().getTimezoneOffset(); // fall back to the browser's zone
    try {
      if (typeof clockBase !== "undefined" && clockBase)
        offsetMin = clockBase.offsetMin;
    } catch (_) {
      /* clockBase not defined yet */
    }
    const d = new Date(tSec * 1000 + offsetMin * 60000);
    const hm = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
    return withSeconds ? `${hm}:${pad2(d.getUTCSeconds())}` : hm;
  }

  class LineChart {
    constructor(host, opts) {
      this.opts = Object.assign(
        {
          yMin: 0,
          yMax: null,
          height: 150,
          format: (v) => String(Math.round(v)),
          fill: true,
        },
        opts,
      );
      this.t = [];
      this.data = {};
      this.hover = null;

      this.host = host;
      host.classList.add("chart");
      host.style.height = this.opts.height + "px";
      this.canvas = document.createElement("canvas");
      this.tip = document.createElement("div");
      this.tip.className = "chart__tip";
      this.tip.hidden = true;
      host.append(this.canvas, this.tip);

      this.canvas.addEventListener("pointermove", (e) => this._onMove(e));
      this.canvas.addEventListener("pointerleave", () => {
        this.hover = null;
        this.tip.hidden = true;
        this.draw();
      });
      if (typeof ResizeObserver === "function")
        new ResizeObserver(() => this.draw()).observe(host);
    }

    setData(times, data) {
      this.t = times || [];
      this.data = data || {};
      this.draw();
    }

    /* ---- geometry, shared by draw() and the hover code ---- */
    _layout() {
      const rect = this.host.getBoundingClientRect();
      const w = Math.max(120, rect.width || this.host.clientWidth || 300);
      const h = this.opts.height;
      const pad = { l: this._padL || 52, r: 12, t: 10, b: 22 };
      const n = this.t.length;
      const span = this.opts.spanSeconds || 0;
      const t1 = n ? this.t[n - 1] : 1;
      const t0 = n ? Math.max(span ? t1 - span : this.t[0], this.t[0]) : 0;

      // value range
      const vals = [];
      for (const s of this.opts.series)
        for (const v of this.data[s.key] || [])
          if (Number.isFinite(v)) vals.push(v);
      let yMin = this.opts.yMin,
        yMax = this.opts.yMax;
      if (yMin === "auto" || yMax === "auto") {
        const lo = vals.length ? Math.min(...vals) : 0;
        const hi = vals.length ? Math.max(...vals) : 1;
        const margin = Math.max((hi - lo) * 0.25, 3);
        yMin = Math.floor(lo - margin);
        yMax = Math.ceil(hi + margin);
      } else {
        if (yMin == null) yMin = 0;
        if (yMax == null) {
          const top = (vals.length ? Math.max(...vals) : 1) * 1.1;
          yMax = this.opts.scale === "bytes" ? niceBytesMax(top) : niceMax(top);
        }
      }
      if (yMax <= yMin) yMax = yMin + 1;
      return {
        w,
        h,
        pad,
        t0,
        t1,
        yMin,
        yMax,
        hasData: vals.length > 0 && n >= 2,
      };
    }

    _x(L, t) {
      return (
        L.pad.l +
        ((t - L.t0) / Math.max(L.t1 - L.t0, 1e-9)) * (L.w - L.pad.l - L.pad.r)
      );
    }
    _y(L, v) {
      return (
        L.pad.t +
        (1 - (v - L.yMin) / (L.yMax - L.yMin)) * (L.h - L.pad.t - L.pad.b)
      );
    }

    draw() {
      const L = this._layout();
      const dpr = window.devicePixelRatio || 1;
      this.canvas.style.width = L.w + "px";
      this.canvas.style.height = L.h + "px";
      this.canvas.width = Math.round(L.w * dpr);
      this.canvas.height = Math.round(L.h * dpr);
      const ctx = this.canvas.getContext && this.canvas.getContext("2d");
      if (!ctx) return; // e.g. a test environment without canvas support
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, L.w, L.h);

      const mono = cssVar("--mono") || "monospace";
      const gridColor = cssVar("--border") || "#1a2230";
      const textColor = cssVar("--muted") || "#5f7686";
      ctx.font = `11px ${mono}`;
      ctx.lineJoin = "round";

      // make room for the widest y label so nothing is clipped
      let widest = 0;
      for (let i = 0; i <= 4; i++) {
        widest = Math.max(
          widest,
          ctx.measureText(
            this.opts.format(L.yMin + ((L.yMax - L.yMin) * i) / 4),
          ).width,
        );
      }
      const needed = Math.max(36, Math.ceil(widest) + 14);
      if (Math.abs(needed - L.pad.l) > 1) {
        this._padL = needed;
        L.pad.l = needed;
      }

      // horizontal grid + y labels
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (let i = 0; i <= 4; i++) {
        const v = L.yMin + ((L.yMax - L.yMin) * i) / 4;
        const y = this._y(L, v);
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(L.pad.l, Math.round(y) + 0.5);
        ctx.lineTo(L.w - L.pad.r, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.fillStyle = textColor;
        ctx.fillText(this.opts.format(v), L.pad.l - 8, y);
      }

      if (!L.hasData) {
        ctx.fillStyle = textColor;
        ctx.textAlign = "center";
        ctx.fillText(
          "Collecting data…",
          (L.pad.l + L.w - L.pad.r) / 2,
          L.h / 2,
        );
        return;
      }

      // x labels
      const range = L.t1 - L.t0;
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = textColor;
      const steps = L.w < 480 ? 2 : 4; // fewer labels on narrow screens, or they overlap
      for (let i = 0; i <= steps; i++) {
        const t = L.t0 + (range * i) / steps;
        ctx.textAlign = i === 0 ? "left" : i === steps ? "right" : "center";
        const x =
          i === 0 ? L.pad.l : i === steps ? L.w - L.pad.r : this._x(L, t);
        ctx.fillText(clockText(t, range < 900), x, L.h - 6);
      }

      // series
      const base = this._y(L, Math.max(L.yMin, Math.min(0, L.yMax)));
      for (const s of this.opts.series) {
        const values = this.data[s.key] || [];
        const color = resolveColor(s.color);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1.6;
        let seg = [];
        const flush = () => {
          if (seg.length >= 1) {
            ctx.beginPath();
            seg.forEach(([x, y], k) =>
              k ? ctx.lineTo(x, y) : ctx.moveTo(x, y),
            );
            if (seg.length === 1) ctx.lineTo(seg[0][0] + 0.01, seg[0][1]);
            ctx.stroke();
            if (this.opts.fill && seg.length > 1) {
              ctx.lineTo(seg[seg.length - 1][0], base);
              ctx.lineTo(seg[0][0], base);
              ctx.closePath();
              ctx.globalAlpha = 0.12;
              ctx.fill();
              ctx.globalAlpha = 1;
            }
          }
          seg = [];
        };
        for (let i = 0; i < this.t.length; i++) {
          const v = values[i];
          if (this.t[i] < L.t0) continue;
          if (!Number.isFinite(v)) {
            flush();
            continue;
          }
          seg.push([
            this._x(L, this.t[i]),
            this._y(L, Math.min(L.yMax, Math.max(L.yMin, v))),
          ]);
        }
        flush();
      }

      // hover crosshair
      if (this.hover != null) {
        const i = this.hover;
        const x = this._x(L, this.t[i]);
        ctx.strokeStyle = cssVar("--border-hi") || "#263040";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, L.pad.t);
        ctx.lineTo(Math.round(x) + 0.5, L.h - L.pad.b);
        ctx.stroke();
        for (const s of this.opts.series) {
          const v = (this.data[s.key] || [])[i];
          if (!Number.isFinite(v)) continue;
          ctx.fillStyle = resolveColor(s.color);
          ctx.beginPath();
          ctx.arc(
            x,
            this._y(L, Math.min(L.yMax, Math.max(L.yMin, v))),
            3.5,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
      }
    }

    _onMove(e) {
      const L = this._layout();
      if (!L.hasData) return;
      const rect = this.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const frac = (px - L.pad.l) / (L.w - L.pad.l - L.pad.r);
      const target = L.t0 + Math.min(1, Math.max(0, frac)) * (L.t1 - L.t0);
      let best = 0,
        bestDist = Infinity;
      for (let i = 0; i < this.t.length; i++) {
        const d = Math.abs(this.t[i] - target);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      this.hover = best;
      this._showTip(L, best);
      this.draw();
    }

    _showTip(L, i) {
      const tip = this.tip;
      tip.replaceChildren();
      const head = document.createElement("div");
      head.className = "chart__tip-time";
      head.textContent = clockText(this.t[i], true);
      tip.appendChild(head);
      for (const s of this.opts.series) {
        const v = (this.data[s.key] || [])[i];
        const row = document.createElement("div");
        const dot = document.createElement("span");
        dot.className = "chart__dot";
        dot.style.background = resolveColor(s.color);
        const text = document.createElement("span");
        text.textContent = `${s.label}: ${Number.isFinite(v) ? (s.format || this.opts.format)(v) : "—"}`;
        row.append(dot, text);
        tip.appendChild(row);
      }
      tip.hidden = false;
      const x = this._x(L, this.t[i]);
      const flip = x > L.w * 0.6;
      tip.style.left = flip ? "" : x + 12 + "px";
      tip.style.right = flip ? L.w - x + 12 + "px" : "";
      tip.style.top = L.pad.t + "px";
    }
  }

  return { LineChart, niceMax, niceBytesMax, fmtBytes, fmtRate, clockText };
})();
