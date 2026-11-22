// "Where a change could pay": measure, on a scene, how much of the step each stage's own version takes, so you can see the
// most any replacement could gain before building one. Nothing here is a prediction: the ceiling is what an infinitely fast
// replacement would give. The numbers come from phost-lab's opportunity report, run in a worker on this machine's GPU.

import { get, post, follow } from "./api.js";
import { h, clear } from "./dom.js";
import { icon } from "./icons.js";
import { pill, field, button, bar } from "./ui.js";
import { state, stageInfo, classInfo, on } from "./state.js";

const ms = (value) => (value < 0.001 ? "<0.001" : value.toFixed(value < 0.1 ? 3 : 2));
const pct = (share) => `${share < 0.995 ? Math.round(share * 100) : 100}%`;
const flops = (value) => value.toExponential(1).replace("e+", "e");

export function analysisCard() {
  const scene = h("select", { "aria-label": "scene to measure", "data-test": "analysis-scene" });
  const run = button("Measure", { kind: "primary", iconName: "chip", test: "analysis-run", onclick: measure });
  const out = h("div", { class: "analysis-out", "data-test": "analysis-out" },
    h("p", { class: "hint" }, "Measuring takes a few seconds and uses this machine's GPU."));

  const root = h("section", { class: "card analysis", "data-test": "analysis" },
    h("header", { class: "card-head" }, h("h2", {}, "Where a change could pay"), h("span", { class: "grow" }),
      field("Scene", scene), run),
    h("p", { class: "hint" }, "How long the reference takes on each part of the step, and so the most a faster replacement could give. " +
      "Pick a scene: some parts only exist on some models."),
    out);

  function fillScenes() {
    const visible = (state.catalog ? state.catalog.scenes : []).filter((s) => !s.hidden);
    const keep = scene.value || state.scene;
    clear(scene, visible.map((s) => h("option", { value: s.id, selected: s.id === keep }, s.id)));
  }

  async function measure() {
    run.disabled = true;
    clear(out, h("div", { class: "alert info" }, icon("clock", 16), `Measuring each stage on ${scene.value}…`));
    try {
      const job = await post("/api/jobs/analysis", { scene: scene.value, worlds: [1] });
      follow(job.id, async (event) => {
        if (event.event !== "end") return;
        run.disabled = false;
        const full = await get(`/api/jobs/${job.id}`);
        show(full.result, event.status === "done" ? null : (event.error || full.error));
      });
    } catch (error) { run.disabled = false; clear(out, h("div", { class: "alert bad" }, error.message)); }
  }

  function show(result, failure) {
    if (failure || !result || !result.opportunities) {
      clear(out, h("div", { class: "alert bad" }, failure || (result && result.error) || "no result"));
      return;
    }
    const cell = result.opportunities.cells[0];
    clear(out,
      h("p", { class: "lead", "data-test": "analysis-head" },
        `${result.opportunities.scene} · ${cell.nv} degrees of freedom · ${cell.integrator} integrator · whole step ${ms(cell.step_ms)} ms`),
      h("div", { class: "table-wrap" }, h("table", { class: "opp-table", "data-test": "analysis-table" },
        h("thead", {}, h("tr", {}, ["Part of the step", "Kind", "Reference time", "Share of the step", "Most it could give", ""].map((t) => h("th", {}, t)))),
        h("tbody", {}, Object.entries(cell.stages).map(([name, e]) => row(name, e))))),
      structure(result.structure),
      h("p", { class: "hint" }, "Each part is replayed on its own as a CUDA graph and compared with the whole step. The most it could give is " +
        "1 ÷ (1 − share): what an infinitely fast replacement would reach. It is a limit, not a forecast."));
  }

  function row(name, e) {
    const info = stageInfo(name), klass = classInfo(e.swap_class);
    let share = h("td", {}), time = h("td", {}, "–"), most = h("td", {}, "–"), note = "";
    if (!e.applies) note = `Not on this scene: ${e.reason}`;
    else if (e.native_ms === null) note = "Reads the whole step after it finishes: nothing to time on its own.";
    else {
      const bound = e.enclosing ? "≤ " : "";
      time = h("td", { class: "num" }, `${bound}${ms(e.native_ms)} ms`);
      share = h("td", { class: "share" }, bar(e.share), h("span", { class: "num" }, `${bound}${pct(e.share)}`));
      if (e.ceiling !== null) most = h("td", { class: "num strong" }, `${e.ceiling.toFixed(2)}×`);
      note = e.enclosing ? `An upper bound: this is ${e.enclosing}.`
        : e.ceiling === null ? "Changes the physics or only observes, so speed is not what it is for." : "";
    }
    return h("tr", { "data-stage": name, class: e.applies ? "" : "off" },
      h("td", {}, h("strong", {}, info.title), h("br"), h("code", {}, name)),
      h("td", {}, pill(klass.label, klass.tone, null, klass.help)), time, share, most, h("td", { class: "note" }, note));
  }

  function structure(report) {
    const items = Object.entries((report && report.stages) || {}).filter(([, c]) => c.structure);
    if (!items.length) return null;
    return h("div", { class: "structure", "data-test": "analysis-structure" }, h("h3", {}, "Shape of the matrix"),
      items.map(([name, c]) => {
        const s = c.structure;
        return h("p", {}, h("strong", {}, stageInfo(name).title), ` is ${s.n} × ${s.n} and ${(100 * s.density).toFixed(1)}% filled; ` +
          `${s.coupled} of ${s.n} rows are coupled to another. Reordered, its band is ${s.bandwidth_rcm} wide (${s.bandwidth} as the host orders it). ` +
          `Factoring only the coupled rows would take ${(100 * s.coupled_flops / s.dense_flops).toFixed(0)}% of the dense work, ` +
          `a banded factorization ${(100 * s.banded_flops / s.dense_flops).toFixed(0)}% (operations, not time).`);
      }));
  }

  on("catalog", fillScenes);
  fillScenes();
  return root;
}
