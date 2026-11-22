// The Author tab: write an equation and see it as a curve before any simulation, or write a kernel and check it in a
// sandbox. Either becomes a node you can put in the graph.

import { get, put, post, del, follow } from "./api.js";
import { h, clear, chip, debounce, gate } from "./dom.js";
import { state, setGraph, defaultParams, implsFor, contracts, refreshCatalog } from "./state.js";
import { LineChart } from "./charts.js";

const CONSTANTS = ["a", "b", "c", "d", "e", "f", "g", "h"];

export function mountAuthor(root, go) {
  if (!(state.info && state.info.author)) {
    root.append(h("div", { class: "card" }, h("h2", {}, "Author"),
      h("p", { class: "note" }, "Writing equations and kernels needs the phost-author package: ",
        h("code", {}, "pip install phost-dash[author]"), ". Restart the dashboard after installing it.")));
    return { activate() {} };
  }
  mountEquation(root);
  mountKernel(root);
  return { activate() {} };
}

function mountEquation(root) {
  const stages = [...new Set(state.catalog.registry.impls.filter((i) => i.kind === "expression").map((i) => i.stage))];
  if (!stages.length) return;
  const stageSel = h("select", { "aria-label": "stage" }, stages.map((st) => h("option", { value: st }, st)));
  const expr = h("input", { type: "text", class: "code", value: "-a*v - b*q", "aria-label": "equation", spellcheck: "false" });
  const constants = Object.fromEntries(CONSTANTS.map((c) => [c, h("input", { type: "number", step: "any", value: c === "a" ? 0.4 : c === "b" ? 2 : 0, "aria-label": `constant ${c}` })]));
  const sweepSel = h("select", { "aria-label": "variable to sweep" });
  const lo = h("input", { type: "number", step: "any", value: -1 }), hi = h("input", { type: "number", step: "any", value: 1 });
  const atBox = h("div", { class: "row" });
  const implicit = h("input", { type: "checkbox", checked: true });
  const note = h("div", { class: "small" });
  const added = h("span", { class: "small muted" });
  const chart = new LineChart(h("div", {}), { title: "The law, sampled", xLabel: "q", yLabel: "value", zeroBased: false, height: 220 });
  let variables = ["q", "v", "time"], at = {};

  const fillSweep = () => {
    const keep = sweepSel.value || variables[0];
    clear(sweepSel, variables.map((v) => h("option", { value: v, selected: v === keep }, v)));
    clear(atBox, variables.filter((v) => v !== sweepSel.value).map((v) => h("label", { class: "field" }, `${v} held at`,
      h("input", { type: "number", step: "any", value: at[v] ?? 0, onchange: (e) => { at[v] = Number(e.target.value); preview(); } }))));
  };
  sweepSel.addEventListener("change", () => { fillSweep(); preview(); });

  const preview = debounce(async () => {
    const body = { stage: stageSel.value, expr: expr.value, sweep: sweepSel.value || variables[0], lo: Number(lo.value), hi: Number(hi.value),
                   at, n: 101, constants: Object.fromEntries(CONSTANTS.map((c) => [c, Number(constants[c].value)])) };
    try {
      const out = await post("/api/author/equation", body);
      if (!out.ok) { note.className = "small error"; note.textContent = out.error; return; }
      variables = out.variables; fillSweep();
      chart.xLabel = out.sweep; chart.yLabel = "law output";
      chart.set([{ id: "y", name: "law output", cls: "", color: "var(--custom)", points: out.x.map((x, i) => [x, out.y[i]]) }]);
      note.className = "small muted";
      note.textContent = out.finite ? "" : "Some values are not finite (division by zero, log of a negative, …).";
      if (out.derivative && out.derivative.text) {
        note.textContent += ` Slope with respect to ${out.derivative.of}: ${out.derivative.text}` +
          (implicit.checked ? " — treated as implicit damping." : ".");
      }
    } catch (error) { note.className = "small error"; note.textContent = error.message; }
  }, 250);

  for (const el of [expr, lo, hi, stageSel, ...Object.values(constants)]) el.addEventListener("input", preview);

  const use = h("button", { class: "btn primary", type: "button", onclick: () => {
    const stage = stageSel.value, impl = implsFor(stage).find((i) => i.id === `${stage}/expression`);
    if (!impl) return;
    const params = defaultParams(impl);
    params.expr = expr.value;
    for (const c of CONSTANTS) if (c in params) params[c] = Number(constants[c].value);
    if ("implicit" in params) params.implicit = implicit.checked;
    state.graph.stages[stage] = { impl: impl.id, params };
    setGraph({ ...state.graph, stages: { ...state.graph.stages } });
    added.textContent = `Added to the graph “${state.graph.name}”. Open Live to watch it against native.`;
  } }, "Use in graph");

  root.append(h("div", { class: "card" },
    h("header", {}, h("h2", {}, "Equation"), h("span", { class: "muted small" },
      "Type the law; the curve updates as you type. Functions: abs, atan, clamp, cos, exp, log, max, min, sin, sqrt, tan, tanh, where.")),
    h("div", { class: "stack" },
      h("div", { class: "row" }, h("label", { class: "field" }, "Stage", stageSel), h("label", { class: "field", style: { flex: "1" } }, "Equation (q, v, time and constants a to h)", expr)),
      h("div", { class: "row" }, CONSTANTS.map((c) => h("label", { class: "field" }, c, constants[c]))),
      h("div", { class: "row" }, h("label", { class: "field" }, "Sweep", sweepSel), h("label", { class: "field" }, "from", lo), h("label", { class: "field" }, "to", hi), atBox),
      chart.container, note,
      h("div", { class: "row center" }, h("label", { class: "inline" }, implicit, "treat the slope in v as implicit damping"), use, added))));
  fillSweep(); preview();
}

function mountKernel(root) {
  const nameIn = h("input", { type: "text", value: "my-solver", maxlength: 64, "aria-label": "kernel name" });
  const stageSel = h("select", { "aria-label": "stage" },
    contracts().map((c) => h("option", { value: c.name, selected: c.name === "newton.linear_solve" }, c.name)));
  const source = h("textarea", { class: "code", spellcheck: "false", "aria-label": "kernel source",
    placeholder: "Load the template, then change it." });
  const out = h("div", { class: "stack" });
  const savedBox = h("div", { class: "stack" });
  const check = h("button", { class: "btn", type: "button", onclick: runCheck }, "Check in sandbox");
  const save = h("button", { class: "btn primary", type: "button", onclick: saveKernel }, "Save as node");
  source.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && !event.shiftKey) {                    // a Tab in code is an indent, not a move to the next control
      event.preventDefault();
      const { selectionStart: a, selectionEnd: b } = source;
      source.setRangeText("    ", a, b, "end");
    }
  });

  async function loadTemplate() {
    try { const t = await get("/api/author/template"); source.value = t.source; stageSel.value = t.stage; }
    catch (error) { clear(out, h("div", { class: "error" }, error.message)); }
  }

  async function runCheck() {
    check.disabled = true;
    clear(out, h("div", { class: "muted" }, "Checking in a sandbox. This compiles the kernel and runs it on a small scene…"));
    try {
      const job = await post("/api/author/kernel/check", { source: source.value, stage: stageSel.value });
      follow(job.id, async (event) => {
        if (event.event !== "end") return;
        check.disabled = false;
        const full = await get(`/api/jobs/${job.id}`);
        showReport(full.result, event.status === "done" ? null : (event.error || full.error));
      });
    } catch (error) { check.disabled = false; clear(out, h("div", { class: "error" }, error.message)); }
  }

  function showReport(report, failure) {
    if (failure || !report) { clear(out, h("div", { class: "error" }, failure || "no report")); return; }
    const v = report.verdict;
    clear(out,
      h("div", { class: "row center" }, chip(report.ok ? "passes the checks" : "does not pass", report.ok ? "ok" : "bad"),
        h("span", { class: "muted small" }, `sandbox: ${report.sandbox} · ${report.seconds} s`),
        v && v.gates ? h("div", { class: "gates" }, Object.entries(v.gates).map(([k, x]) => gate(k, x))) : null),
      report.error ? h("div", { class: "error" }, report.error) : null,
      v && v.problems && v.problems.length ? h("div", { class: "error" }, v.problems.join("\n")) : null,
      report.stderr ? h("pre", { class: "json" }, report.stderr) : null,
      report.traceback ? h("pre", { class: "json" }, report.traceback) : null,
      h("p", { class: "note" }, `Where the verdict is computed: ${report.integrity || "in the kernel's own process"}. ` +
        "So treat it as a check for you, not a certificate for anyone else."));
  }

  async function saveKernel() {
    try {
      const saved = await put(`/api/kernels/${encodeURIComponent(nameIn.value)}`, { source: source.value, stage: stageSel.value, entry: "Runtime" });
      await refreshCatalog();
      const impl = implsFor(stageSel.value).find((i) => i.id === saved.impl);
      clear(out, h("div", { class: "row center" }, chip(`saved as ${saved.impl}`, "ok"),
        impl ? h("button", { class: "btn small", type: "button", onclick: () => {
          state.graph.stages[stageSel.value] = { impl: impl.id, params: defaultParams(impl) };
          setGraph({ ...state.graph, stages: { ...state.graph.stages } });
        } }, "Use in graph") : h("span", { class: "muted small" }, "It will appear in the Graph tab once its contract loads.")));
      listSaved();
    } catch (error) { clear(out, h("div", { class: "error" }, error.message)); }
  }

  async function listSaved() {
    try {
      const kernels = await get("/api/kernels");
      clear(savedBox, kernels.length ? h("table", {}, h("thead", {}, h("tr", {}, ["saved kernels", "stage", ""].map((t) => h("th", {}, t)))),
        h("tbody", {}, kernels.map((k) => h("tr", {}, h("td", {}, k.name), h("td", {}, k.stage),
          h("td", {}, h("button", { class: "btn small", type: "button", onclick: async () => { const full = await get(`/api/kernels/${encodeURIComponent(k.name)}`);
            source.value = full.source; stageSel.value = full.stage; nameIn.value = k.name; } }, "Open"), " ",
            h("button", { class: "btn small danger", type: "button", onclick: async () => { await del(`/api/kernels/${encodeURIComponent(k.name)}`); listSaved(); } }, "Delete")))))) : null);
    } catch (error) { clear(savedBox, h("div", { class: "error" }, error.message)); }
  }

  root.append(h("div", { class: "card" },
    h("header", {}, h("h2", {}, "Kernel"), h("span", { class: "muted small" },
      "Your source is compiled and run only inside a sandboxed worker, never in the dashboard's own process.")),
    h("div", { class: "stack" },
      h("div", { class: "row" }, h("label", { class: "field" }, "Name", nameIn), h("label", { class: "field" }, "Stage", stageSel),
        h("button", { class: "btn", type: "button", onclick: loadTemplate }, "Load template"), check, save),
      source, out, savedBox)));
  listSaved();
}
