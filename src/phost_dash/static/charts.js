// Charts as plain SVG. Thin marks, recessive grid, a legend whenever there are two or more series, a tooltip on hover,
// and a table view of the same numbers. Colours come from CSS roles so light and dark both work.

import { h, s, clear, num, showTip, hideTip } from "./dom.js";

// Charts are drawn at the width they are shown at, so type stays the size it is written and is never scaled up.
function track(chart, container) {
  chart.width = 640;
  container.classList.add("chart");
  new ResizeObserver(() => {
    const width = Math.round(container.clientWidth);
    if (width > 0 && Math.abs(width - chart.width) > 6) { chart.width = width; chart.render(); }
  }).observe(container);
}

export function niceTicks(lo, hi, count = 5) {
  if (!(hi > lo)) hi = lo + 1;
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

function legend(series) {
  if (series.length < 2) return null;
  return h("div", { class: "legend" }, series.map((item) => h("span", {},
    h("span", { class: `swatch ${item.cls || ""}`, style: item.cls ? {} : { background: item.color } }), item.name)));
}

function tableView(headers, rows) {
  return h("details", {}, h("summary", {}, "Table view"),
    h("table", {}, h("thead", {}, h("tr", {}, headers.map((x, i) => h("th", { class: i ? "num" : "" }, x)))),
      h("tbody", {}, rows.map((row) => h("tr", {}, row.map((cell, i) => h("td", { class: i ? "num" : "" }, cell)))))));
}

function sample(array, limit) {
  if (array.length <= limit) return array;
  const out = [];
  for (let i = 0; i < limit; i++) out.push(array[Math.round((i * (array.length - 1)) / (limit - 1))]);
  return out;
}

export class LineChart {
  constructor(container, { title, xLabel = "", yLabel = "", xFormat = num, yFormat = num, height = 240, onPick = null, zeroBased = true }) {
    Object.assign(this, { container, title, xLabel, yLabel, xFormat, yFormat, height, onPick, zeroBased });
    this.series = [];
    this.mark = null;
    track(this, container);
  }

  set(series, mark = this.mark) {
    this.series = series;
    this.mark = mark;
    this.render();
  }

  // the playhead moves every frame, so it moves its own line instead of redrawing the chart
  setMark(x) { this.mark = x; this.placeMark(); }

  placeMark() {
    const { markEl, xScale: sc } = this;
    if (!markEl || !sc) return;
    const visible = this.mark !== null && this.mark >= sc.x0 && this.mark <= sc.x1;
    markEl.setAttribute("visibility", visible ? "visible" : "hidden");
    if (visible) for (const [k, v] of [["x1", sc.X(this.mark)], ["x2", sc.X(this.mark)], ["y1", sc.top], ["y2", sc.bottom]]) markEl.setAttribute(k, v);
  }

  render() {
    const { series, height, width: W } = this;
    this.markEl = null; this.xScale = null;
    const m = { l: 56, r: 84, t: 24, b: 32 };
    const points = series.flatMap((item) => item.points);
    const svg = s("svg", { viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": this.title });
    if (!points.length) {
      svg.append(s("text", { x: W / 2, y: height / 2, "text-anchor": "middle", class: "tick" }, "nothing yet"));
      return clear(this.container, h("div", { class: "small muted" }, this.title), svg);
    }
    let x0 = Math.min(...points.map((p) => p[0])), x1 = Math.max(...points.map((p) => p[0]));
    if (x1 === x0) x1 = x0 + 1;
    let y0 = this.zeroBased ? Math.min(0, ...points.map((p) => p[1])) : Math.min(...points.map((p) => p[1]));
    let y1 = Math.max(...points.map((p) => p[1]));
    if (y1 <= y0) y1 = y0 + 1;
    const yt = niceTicks(y0, y1 * 1.06), xt = niceTicks(x0, x1, 6);
    y1 = Math.max(y1, yt[yt.length - 1]);
    const X = (v) => m.l + ((v - x0) / (x1 - x0)) * (W - m.l - m.r);
    const Y = (v) => height - m.b - ((v - y0) / (y1 - y0)) * (height - m.t - m.b);

    const grid = s("g", { class: "grid" }), axis = s("g", { class: "axis" });
    for (const t of yt) {
      grid.append(s("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }));
      axis.append(s("text", { x: m.l - 6, y: Y(t) + 4, "text-anchor": "end", class: "tick" }, this.yFormat(t)));
    }
    for (const t of xt) axis.append(s("text", { x: X(t), y: height - m.b + 16, "text-anchor": "middle", class: "tick" }, this.xFormat(t)));
    axis.append(s("line", { x1: m.l, x2: W - m.r, y1: Y(y0), y2: Y(y0) }));
    axis.append(s("text", { x: (m.l + W - m.r) / 2, y: height - 2, "text-anchor": "middle", class: "tick" }, this.xLabel));
    axis.append(s("text", { x: 4, y: 12, class: "tick" }, this.yLabel));
    svg.append(grid, axis);

    for (const item of series) {
      if (!item.points.length) continue;
      const d = item.points.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
      svg.append(s("path", { d, fill: "none", stroke: item.color, "stroke-width": 2, "stroke-linejoin": "round",
                             "stroke-dasharray": item.dash || null }));
    }
    if (series.length <= 4) {                                   // direct labels, kept apart vertically
      const ends = series.filter((i) => i.points.length).map((item) => ({ item, y: Y(item.points[item.points.length - 1][1]) }))
        .sort((a, b) => a.y - b.y);
      for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 13);
      for (const { item, y } of ends) {
        svg.append(s("text", { x: W - m.r + 6, y: y + 4, class: "direct" }, item.short || item.name));
      }
    }
    this.xScale = { X, x0, x1, top: m.t, bottom: height - m.b };
    this.markEl = s("line", { class: "cross", "stroke-dasharray": "3 3", visibility: "hidden" });
    svg.append(this.markEl);
    this.placeMark();

    const cross = s("line", { class: "cross", y1: m.t, y2: height - m.b, visibility: "hidden" });
    const dots = series.map((item) => s("circle", { r: 4.5, fill: item.color, stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" }));
    svg.append(cross, ...dots);
    const lead = series.find((i) => i.points.length) || series[0];
    const hit = s("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: height - m.t - m.b, fill: "transparent",
                            style: this.onPick ? "cursor: pointer" : "" });
    const at = (event) => {
      const box = svg.getBoundingClientRect();
      const x = x0 + (((event.clientX - box.left) / box.width) * W - m.l) / (W - m.l - m.r) * (x1 - x0);
      let best = 0;
      lead.points.forEach((p, i) => { if (Math.abs(p[0] - x) < Math.abs(lead.points[best][0] - x)) best = i; });
      return best;
    };
    hit.addEventListener("pointermove", (event) => {
      const i = at(event), px = lead.points[i][0];
      cross.setAttribute("x1", X(px)); cross.setAttribute("x2", X(px)); cross.setAttribute("visibility", "visible");
      const rows = [{ k: this.xLabel, v: this.xFormat(px) }];
      series.forEach((item, k) => {
        const p = item.points.find((q) => q[0] === px) || item.points[Math.min(i, item.points.length - 1)];
        if (!p) return;
        dots[k].setAttribute("cx", X(p[0])); dots[k].setAttribute("cy", Y(p[1])); dots[k].setAttribute("visibility", "visible");
        rows.push({ swatch: item.cls || "", color: item.cls ? null : item.color, k: item.name, v: this.yFormat(p[1]) });
      });
      showTip(event, rows);
    });
    hit.addEventListener("pointerleave", () => {
      cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); hideTip();
    });
    if (this.onPick) hit.addEventListener("click", (event) => this.onPick(lead.points[at(event)][0]));
    svg.append(hit);

    const rows = sample(lead.points, 40).map((p) => [this.xFormat(p[0]),
      ...series.map((item) => { const q = item.points.find((r) => r[0] === p[0]); return q ? this.yFormat(q[1]) : "–"; })]);
    clear(this.container, h("div", { class: "small muted" }, this.title), legend(series), svg,
      tableView([this.xLabel || "x", ...series.map((i) => i.name)], rows));
  }
}

// Bars grouped by category: each category holds one bar per series.
export class BarChart {
  constructor(container, { title, yLabel = "", yFormat = num, height = 220 }) {
    Object.assign(this, { container, title, yLabel, yFormat, height });
    this.categories = []; this.series = [];
    track(this, container);
  }

  set(categories, series) {            // series: [{id, name, cls}], categories: [{label, values: {id: number}}]
    this.categories = categories; this.series = series;
    this.render();
  }

  render() {
    const { height, categories, series, width: W } = this, m = { l: 56, r: 12, t: 24, b: 34 };
    const svg = s("svg", { viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": this.title });
    const values = categories.flatMap((c) => series.map((i) => c.values[i.id]).filter((v) => v !== undefined && v !== null));
    if (!values.length) return clear(this.container, h("div", { class: "small muted" }, this.title), h("div", { class: "small muted" }, "nothing yet"));
    const top = Math.max(...values, 1e-12);
    const ticks = niceTicks(0, top * 1.08), y1 = Math.max(top * 1.02, ticks[ticks.length - 1]);
    const Y = (v) => height - m.b - (v / y1) * (height - m.t - m.b);
    const grid = s("g", { class: "grid" }), axis = s("g", { class: "axis" });
    for (const t of ticks) {
      grid.append(s("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }));
      axis.append(s("text", { x: m.l - 6, y: Y(t) + 4, "text-anchor": "end", class: "tick" }, this.yFormat(t)));
    }
    axis.append(s("line", { x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0) }), s("text", { x: 4, y: 12, class: "tick" }, this.yLabel));
    svg.append(grid, axis);
    const band = (W - m.l - m.r) / categories.length, inner = Math.min(86, band * 0.7), bar = inner / series.length;
    categories.forEach((category, c) => {
      const start = m.l + c * band + (band - inner) / 2;
      axis.append(s("text", { x: start + inner / 2, y: height - m.b + 16, "text-anchor": "middle", class: "tick" }, category.label));
      series.forEach((item, k) => {
        const value = category.values[item.id];
        if (value === undefined || value === null) return;
        const rect = s("rect", { x: start + k * bar + 1, width: Math.max(2, bar - 2), y: Y(value), height: Math.max(1, Y(0) - Y(value)),
                                 rx: 3, fill: `var(--${item.cls})` });
        rect.addEventListener("pointermove", (event) => showTip(event, [{ k: category.label }, { swatch: item.cls, k: item.name, v: this.yFormat(value) }]));
        rect.addEventListener("pointerleave", hideTip);
        svg.append(rect);
      });
    });
    clear(this.container, h("div", { class: "small muted" }, this.title), legend(series), svg,
      tableView(["", ...series.map((i) => i.name)], categories.map((c) => [c.label, ...series.map((i) => c.values[i.id] === undefined ? "–" : this.yFormat(c.values[i.id]))])));
  }
}

// Points with the Pareto front joined by a step line; dominated points are hollow so the front is not colour alone.
export class Scatter {
  constructor(container, { title, xLabel, yLabel, xFormat = num, yFormat = num, xSense = "min", ySense = "min", height = 240 }) {
    Object.assign(this, { container, title, xLabel, yLabel, xFormat, yFormat, xSense, ySense, height });
    this.points = [];
    track(this, container);
  }

  set(points) {                         // [{x, y, front, label, rows}]
    this.points = points;
    this.render();
  }

  render() {
    const { height, points, width: W } = this, m = { l: 56, r: 16, t: 24, b: 36 };
    const svg = s("svg", { viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": this.title });
    if (!points.length) return clear(this.container, h("div", { class: "small muted" }, this.title), h("div", { class: "small muted" }, "nothing to plot"));
    const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
    const pad = (lo, hi) => { const d = (hi - lo) || Math.abs(hi) || 1; return [lo - d * 0.12, hi + d * 0.12]; };
    const [x0, x1] = pad(Math.min(...xs), Math.max(...xs)), [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
    const X = (v) => m.l + ((v - x0) / (x1 - x0)) * (W - m.l - m.r), Y = (v) => height - m.b - ((v - y0) / (y1 - y0)) * (height - m.t - m.b);
    const grid = s("g", { class: "grid" }), axis = s("g", { class: "axis" });
    for (const t of niceTicks(y0, y1)) {
      grid.append(s("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }));
      axis.append(s("text", { x: m.l - 6, y: Y(t) + 4, "text-anchor": "end", class: "tick" }, this.yFormat(t)));
    }
    for (const t of niceTicks(x0, x1, 6)) axis.append(s("text", { x: X(t), y: height - m.b + 16, "text-anchor": "middle", class: "tick" }, this.xFormat(t)));
    axis.append(s("line", { x1: m.l, x2: W - m.r, y1: height - m.b, y2: height - m.b }),
      s("text", { x: (m.l + W - m.r) / 2, y: height - 2, "text-anchor": "middle", class: "tick" }, `${this.xLabel} (${this.xSense === "min" ? "lower" : "higher"} is better)`),
      s("text", { x: 4, y: 12, class: "tick" }, `${this.yLabel} (${this.ySense === "min" ? "lower" : "higher"} is better)`));
    svg.append(grid, axis);
    const front = points.filter((p) => p.front).sort((a, b) => a.x - b.x);
    if (front.length > 1) {
      svg.append(s("path", { d: front.map((p, i) => (i ? `H${X(p.x)}V${Y(p.y)}` : `M${X(p.x)},${Y(p.y)}`)).join(""),
                             fill: "none", stroke: "var(--native)", "stroke-width": 1.5, opacity: 0.5 }));
    }
    for (const p of points) {
      const dot = s("circle", { cx: X(p.x), cy: Y(p.y), r: 5, "stroke-width": 2,
                                fill: p.front ? "var(--native)" : "var(--surface)", stroke: p.front ? "var(--surface)" : "var(--muted)" });
      dot.addEventListener("pointermove", (event) => showTip(event, [{ k: "", v: p.label }, ...p.rows]));
      dot.addEventListener("pointerleave", hideTip);
      svg.append(dot);
    }
    const key = h("div", { class: "legend" },
      h("span", {}, h("span", { class: "swatch", style: { background: "var(--native)" } }), "Pareto front"),
      h("span", {}, h("span", { class: "swatch", style: { border: "2px solid var(--muted)", background: "var(--surface)" } }), "beaten by another entry"));
    clear(this.container, h("div", { class: "small muted" }, this.title), key, svg,
      tableView(["entry", this.xLabel, this.yLabel], points.map((p) => [p.label, this.xFormat(p.x), this.yFormat(p.y)])));
  }
}
