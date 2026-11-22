// "Where the time goes": the step split into its phases, each timed as its own CUDA graph, for the reference and, if you
// ask, for your experiment installed. A change can only pay on a phase that takes time, and this shows which. The numbers come
// from phost-lab's profile, run in a worker on this machine's GPU.

import { get, post, follow } from "./api.js";
import { h, clear } from "./dom.js";
import { icon } from "./icons.js";
import { field, button, bar } from "./ui.js";
import { state, cleanGraph, on } from "./state.js";

const PHASE_NAMES = {
  "kinematics": "Kinematics", "crb / armature": "Inertia (crb, armature)", "collision": "Collision",
  "make_constraint": "Build constraints", "velocity+actuation+accel": "Velocities, actuation, acceleration",
  "solver": "Constraint solver", "integrate": "Integrate",
};
const ms = (value) => (value < 0.001 ? "<0.001" : value.toFixed(value < 0.1 ? 3 : 2));

export function profileCard() {
  const scene = h("select", { "aria-label": "scene to time", "data-test": "profile-scene" });
  const withExperiment = h("input", { type: "checkbox", "data-test": "profile-with" });
  const run = button("Time each phase", { kind: "primary", iconName: "clock", test: "profile-run", onclick: measure });
  const out = h("div", { class: "analysis-out", "data-test": "profile-out" },
    h("p", { class: "hint" }, "Each phase of the step is replayed on its own. This takes about half a minute and uses this machine's GPU."));
  const pick = h("label", { class: "check" }, withExperiment, h("span", {}, "With my experiment installed"));

  const root = h("section", { class: "card analysis", "data-test": "profile" },
    h("header", { class: "card-head" }, h("h2", {}, "Where the time goes"), h("span", { class: "grow" }), pick, field("Scene", scene), run),
    h("p", { class: "hint" }, "The step split into its phases. A swap can only help on a phase that takes time."),
    out);

  const changes = () => Object.keys(cleanGraph().stages).length;

  function sync() {
    const visible = (state.catalog ? state.catalog.scenes : []).filter((s) => !s.hidden);
    const keep = scene.value || state.scene;
    clear(scene, visible.map((s) => h("option", { value: s.id, selected: s.id === keep }, s.id)));
    withExperiment.disabled = changes() === 0;
    if (changes() === 0) withExperiment.checked = false;
    pick.title = changes() === 0 ? "Choose a different implementation on a card below to time it" : "";
  }

  async function measure() {
    run.disabled = true;
    clear(out, h("div", { class: "alert info" }, icon("clock", 16), `Timing each phase on ${scene.value}…`));
    try {
      const body = { scene: scene.value, worlds: [1] };
      if (withExperiment.checked) body.graph = cleanGraph();
      const job = await post("/api/jobs/profile", body);
      follow(job.id, async (event) => {
        if (event.event !== "end") return;
        run.disabled = false;
        const full = await get(`/api/jobs/${job.id}`);
        show(full.result, event.status === "done" ? null : (event.error || full.error));
      });
    } catch (error) { run.disabled = false; clear(out, h("div", { class: "alert bad" }, error.message)); }
  }

  function show(result, failure) {
    if (failure || !result || !result.profile) {
      clear(out, h("div", { class: "alert bad" }, failure || (result && result.error) || "no result"));
      return;
    }
    const p = result.profile, cell = p.cells[0], names = Object.keys(cell.variants);
    const label = (n) => (n === "native" ? "Reference" : "Your experiment");
    const longest = Math.max(...names.flatMap((n) => Object.values(cell.variants[n].phases)));
    const phases = Object.keys(cell.variants.native.phases);
    const rows = [];
    for (const phase of phases) {
      rows.push(h("tr", { "data-phase": phase }, h("td", {}, PHASE_NAMES[phase] || phase),
        names.map((n) => barCell(cell.variants[n].phases[phase], longest))));
      if (phase === "velocity+actuation+accel" && names.some((n) => cell.variants[n].effective_ms !== null)) {
        rows.push(h("tr", { class: "sub", "data-phase": "effective" }, h("td", {}, "of which the flexible-body solve"),
          names.map((n) => cell.variants[n].effective_ms === null ? h("td", {}, "–") : barCell(cell.variants[n].effective_ms, longest))));
      }
    }
    rows.push(h("tr", { class: "total", "data-phase": "full" }, h("td", {}, "Whole step, as one graph"),
      names.map((n) => h("td", { class: "num strong" }, `${ms(cell.variants[n].full_ms)} ms`))));
    clear(out,
      h("p", { class: "lead" }, `${p.scene} · ${p.nv} degrees of freedom · ${p.integrator} integrator, ${(p.timestep * 1000).toFixed(2)} ms step · ${p.device}`),
      h("div", { class: "table-wrap" }, h("table", { class: "opp-table", "data-test": "profile-table" },
        h("thead", {}, h("tr", {}, [h("th", {}, "Phase"), ...names.map((n) => h("th", {}, label(n)))])),
        h("tbody", {}, rows))),
      h("p", { class: "hint" }, "Phases are replayed as separate graphs and each adds a small gap, so they add up to a little more than the whole step. " +
        "The bar is each phase against the longest one. Which phases exist is read from MuJoCo Warp's step, so this is tied to the build it runs on."));
  }

  function barCell(value, longest) {
    return h("td", { class: "share" }, bar(value / longest), h("span", { class: "num" }, `${ms(value)} ms`));
  }

  on("catalog", sync);
  on("graph", sync);
  sync();
  return root;
}
