// The Board tab: what has been recorded, grouped so only like is compared with like (same scene, device, world count
// and kind of swap), with the Pareto front marked. Trust is shown on every row.

import { get, post, follow } from "./api.js";
import { h, clear, chip, num, when } from "./dom.js";
import { state, scenes } from "./state.js";
import { Scatter } from "./charts.js";

const TRUST = {
  "self-reported": "Measured on this machine by whoever ran it. Nothing has checked it independently.",
  judged: "Re-measured by a separate judge process.",
};
const SENSE = { max: "higher is better", min: "lower is better" };

export function mountBoard(root, go) {
  const scene = h("select", { "aria-label": "scene filter" });
  const klass = h("select", { "aria-label": "kind of swap filter" },
    ["", "exact", "approximate", "model_changing", "observer"].map((k) => h("option", { value: k }, k || "any kind of swap")));
  const trust = h("select", { "aria-label": "trust filter" }, ["", "self-reported", "judged"].map((k) => h("option", { value: k }, k || "any trust")));
  const worlds = h("input", { type: "number", min: 1, placeholder: "any", "aria-label": "world count filter" });
  const label = h("input", { type: "text", placeholder: "any", "aria-label": "label filter", size: 14 });
  const unreliable = h("input", { type: "checkbox" });
  const groups = h("div", { class: "stack groups" });
  const summary = h("span", { class: "muted small" });
  for (const el of [scene, klass, trust, worlds, label, unreliable]) el.addEventListener("change", refresh);

  root.append(h("div", { class: "card" },
    h("header", {}, h("h2", {}, "Board"), summary, h("span", { class: "grow" }),
      h("button", { class: "btn small", type: "button", onclick: refresh }, "Refresh")),
    h("div", { class: "row" },
      h("label", { class: "field" }, "Scene", scene), h("label", { class: "field" }, "Swap", klass), h("label", { class: "field" }, "Trust", trust),
      h("label", { class: "field" }, "Worlds", worlds), h("label", { class: "field" }, "Label", label),
      h("label", { class: "inline" }, unreliable, "include timings flagged unreliable"))), groups);

  function fillScenes() {
    const keep = scene.value;
    clear(scene, h("option", { value: "" }, "any scene"), scenes().map((sc) => h("option", { value: sc.id, selected: sc.id === keep }, sc.id)));
  }

  async function refresh() {
    const query = new URLSearchParams();
    for (const [key, el] of [["scene", scene], ["klass", klass], ["trust", trust], ["worlds", worlds], ["label", label]]) if (el.value) query.set(key, el.value);
    if (unreliable.checked) query.set("include_unreliable", "1");
    try {
      const out = await get(`/api/board?${query}`);
      summary.textContent = `${out.ledger.count} record${out.ledger.count === 1 ? "" : "s"} in the ledger${out.ledger.ok ? "" : " · PROBLEMS FOUND"}`;
      clear(groups, out.groups.length ? out.groups.map(group) : h("div", { class: "card" }, h("p", { class: "note" },
        "Nothing here yet. Run a timed comparison on the Live tab and press “Record to ledger”.")));
    } catch (error) { clear(groups, h("div", { class: "card error" }, error.message)); }
  }

  function group(g) {
    const [first, second] = g.objectives;
    const rows = g.rows;
    const scatter = rows.length && second ? new Scatter(h("div", {}), {
      title: "Entries in this group", xLabel: first.name, yLabel: second.name, xSense: first.sense, ySense: second.sense,
      xFormat: num, yFormat: num }) : null;
    if (scatter) scatter.set(rows.map((r) => ({ x: r.objectives[first.name], y: r.objectives[second.name], front: r.rank === 0, label: r.label || `#${r.seq}`,
      rows: [{ k: "trust", v: r.trust }, { k: first.name, v: num(r.objectives[first.name]) }, { k: second.name, v: num(r.objectives[second.name]) }] })));
    const skipped = Object.entries(g.skipped).filter(([, n]) => n).map(([why, n]) => `${n} ${why}`).join(", ");
    return h("div", { class: "card" },
      h("header", {}, h("h2", {}, g.scene), h("span", { class: "muted small" }, `${g.device} · ${g.worlds} world${g.worlds === 1 ? "" : "s"} · ${g.klass.replace("_", " ")}`),
        h("span", { class: "grow" }), skipped ? h("span", { class: "muted small" }, `left out: ${skipped}`) : null),
      rows.length ? h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "rank"), h("th", {}, "label"), h("th", {}, "trust"),
        g.objectives.map((o) => h("th", { class: "num", title: SENSE[o.sense] }, `${o.name} ${o.sense === "max" ? "↑" : "↓"}`)), h("th", {}, "recorded"), h("th", {}, ""))),
        h("tbody", {}, rows.map((r) => row(g, r)))) : h("p", { class: "note" }, "Every entry in this group was left out (see above)."),
      scatter ? scatter.container : null);
  }

  function row(g, r) {
    const result = h("span", { class: "small" });
    const button = h("button", { class: "btn small", type: "button", title: "Run it again here and compare with what was recorded", onclick: async () => {
      button.disabled = true; result.textContent = " re-running…";
      try {
        const job = await post("/api/jobs/reverify", { seq: r.seq });
        follow(job.id, async (event) => {
          if (event.event !== "end") return;
          button.disabled = false;
          const full = await get(`/api/jobs/${job.id}`);
          const v = full.result;
          if (event.status !== "done" || !v) { result.className = "small error"; result.textContent = ` ${event.error || full.error || "failed"}`; return; }
          const text = v.agrees === true ? "agrees with the record" : v.agrees === false ? "disagrees" : "cannot say";
          result.className = `small ${v.agrees === true ? "good" : v.agrees === false ? "error" : "muted"}`;
          result.textContent = ` ${text}${v.differences && v.differences.length ? ": " + v.differences.join("; ") : ""}`;
        });
      } catch (error) { button.disabled = false; result.className = "small error"; result.textContent = ` ${error.message}`; }
    } }, "Reverify");
    return h("tr", {}, h("td", {}, r.rank === 0 ? chip("front", "ok", "On the Pareto front: nothing in this group beats it on every objective.") : String(r.rank)),
      h("td", { title: `graph ${r.graph_hash}` }, r.label || `#${r.seq}`, r.notes.length ? h("div", { class: "muted small" }, r.notes.join("; ")) : null),
      h("td", { title: TRUST[r.trust] || "" }, r.trust, r.reliable ? "" : " · unreliable"),
      g.objectives.map((o) => h("td", { class: "num" }, num(r.objectives[o.name]))),
      h("td", { class: "muted small" }, when(r.time)), h("td", {}, button, result));
  }

  fillScenes();
  refresh();
  return { activate() { fillScenes(); refresh(); } };
}
