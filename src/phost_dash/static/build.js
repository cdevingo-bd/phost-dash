// Build: design the experiment. An experiment is the reference simulation with some stages swapped for something else.
// Three small workspaces share the screen: the stages themselves, a typed equation (with a curve), and a kernel you write.
// Nothing here runs a simulation; Studio does that.

import { get, put, post, del, follow } from "./api.js";
import { h, clear, debounce, gate } from "./dom.js";
import { icon } from "./icons.js";
import { pill, segmented, empty, field, button, iconButton } from "./ui.js";
import { state, setGraph, touchGraph, refreshSaved, refreshCatalog, contracts, implsFor, defaultParams, cleanGraph, emptyGraph,
         availablePresets, presetGraph, stageInfo, classInfo, KIND_LABEL, changeCount, on } from "./state.js";
import { LineChart } from "./charts.js";

const CONSTANTS = ["a", "b", "c", "d", "e", "f", "g", "h"];

export function mountBuild(root, go) {
  const panes = {
    stages: h("div", { class: "pane", "data-pane": "stages" }),
    equation: h("div", { class: "pane", "data-pane": "equation", hidden: true }),
    kernel: h("div", { class: "pane", "data-pane": "kernel", hidden: true }),
  };
  const show = (name) => { for (const [k, el] of Object.entries(panes)) el.hidden = k !== name; nav.set(name); };
  const nav = segmented({ label: "What to build", value: "stages", onChange: show, options: [
    { value: "stages", label: "Choose stages", icon: "layers", title: "Pick which parts of the step to swap" },
    { value: "equation", label: "Type an equation", icon: "fx", title: "Write a force law and see its curve" },
    { value: "kernel", label: "Write a kernel", icon: "code", title: "Write GPU code and check it in a sandbox" } ] });
  root.append(h("div", { class: "build" },
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Build an experiment"),
      h("p", {}, "An experiment changes one or more parts of the physics step. Everything you do not change stays as MuJoCo Warp ships it.")), nav),
    panes.stages, panes.equation, panes.kernel));

  mountStages(panes.stages, go, show);
  if (state.info && state.info.author) {
    mountEquation(panes.equation, go);
    mountKernel(panes.kernel, go);
  } else {
    for (const el of [panes.equation, panes.kernel]) {
      el.append(empty({ iconName: "info", title: "This needs the phost-author package",
        text: "Typed equations and kernels come from phost-author. Install it into the same environment, then restart the dashboard." }));
    }
  }
  return { activate() {}, show };
}

// ---- 1. the stages ----

function mountStages(root, go, show) {
  const nameIn = h("input", { type: "text", value: state.graph.name, maxlength: 64, "aria-label": "experiment name", "data-test": "graph-name" });
  const savedSel = h("select", { "aria-label": "saved experiments", "data-test": "saved" });
  const message = h("div", { class: "hint", "data-test": "build-message" });
  const examples = h("div", { class: "examples", "data-test": "examples" });
  const stages = h("div", { class: "stages", "data-test": "stages" });
  const summary = h("div", { class: "summary", "data-test": "summary" });
  const json = h("pre", { class: "json" });

  nameIn.addEventListener("input", () => { state.graph.name = nameIn.value; touchGraph(); validate(); });

  const toolbar = h("div", { class: "toolbar" },
    field("Name", nameIn),
    h("div", { class: "toolbar-group" }, field("Saved experiments", savedSel),
      button("Load", { onclick: load, test: "load" }), button("Delete", { kind: "danger", onclick: remove })),
    h("span", { class: "grow" }),
    button("Save", { iconName: "save", onclick: save, test: "save" }),
    button("Start over", { onclick: () => { setGraph(emptyGraph()); say("Started over: nothing is changed."); } }),
    button("Try it in Studio", { kind: "primary", iconName: "play", test: "to-studio", onclick: () => go.show("studio") }));

  root.append(
    h("section", { class: "card" }, toolbar, message),
    h("section", { class: "card" }, h("header", { class: "card-head" }, h("h2", {}, "Start from an example"),
      h("span", { class: "grow" }), h("span", { class: "hint" }, "or build from nothing below")), examples),
    h("div", { class: "split-main" }, h("div", {}, h("header", { class: "section-head" }, h("h2", {}, "The physics step"),
        h("p", {}, "Each card is one place in the step where the reference can be swapped for something else. Leave a card on “Reference” to keep the original.")),
        stages),
      h("aside", { class: "stack" },
        h("section", { class: "card sticky" }, h("h2", {}, "What this experiment will do"), summary),
        h("details", { class: "card details" }, h("summary", {}, "As JSON"), json))));

  const say = (text, bad = false) => { message.className = `hint ${bad ? "bad" : ""}`; message.textContent = text; };

  function fillLists() {
    clear(savedSel, state.saved.length ? state.saved.map((n) => h("option", { value: n }, n)) : h("option", { value: "" }, "(none yet)"));
    const presets = availablePresets();
    clear(examples, presets.length ? presets.map((p) => h("button", { class: "example", type: "button", "data-test": `example-${p.id}`,
      onclick: () => { setGraph(presetGraph(p.id)); say(`Loaded the “${p.title}” example.`); } },
      h("span", { class: "example-icon" }, icon(p.iconName, 20)), h("span", { class: "example-body" }, h("strong", {}, p.title), h("span", {}, p.blurb))))
      : h("p", { class: "hint" }, "No examples are available for the packages installed here."));
  }

  async function load() {
    if (!savedSel.value) return;
    try { setGraph(await get(`/api/graphs/${encodeURIComponent(savedSel.value)}`)); say(`Loaded “${savedSel.value}”.`); }
    catch (error) { say(error.message, true); }
  }
  async function save() {
    try {
      const graph = cleanGraph();
      await put(`/api/graphs/${encodeURIComponent(graph.name)}`, graph);
      await refreshSaved();
      savedSel.value = graph.name;
      say(`Saved “${graph.name}”. It is now in the experiment list in Studio.`);
    } catch (error) { say(error.message, true); }
  }
  async function remove() {
    if (!savedSel.value) return;
    try { await del(`/api/graphs/${encodeURIComponent(savedSel.value)}`); await refreshSaved(); say("Deleted."); }
    catch (error) { say(error.message, true); }
  }

  function stageCard(contract) {
    const info = stageInfo(contract.name);
    const impls = implsFor(contract.name);
    const node = state.graph.stages[contract.name];
    const chosen = node ? impls.find((i) => i.id === node.impl) : null;
    const active = Boolean(chosen && !chosen.id.endsWith("/native"));
    const klass = classInfo(contract.swap_class);
    const select = h("select", { "aria-label": `${contract.name} implementation`, "data-test": `impl-${contract.name}` },
      impls.map((impl) => h("option", { value: impl.id, selected: node ? node.impl === impl.id : impl.id.endsWith("/native") },
        impl.id.endsWith("/native") ? "Reference (unchanged)" : `${impl.title} · ${KIND_LABEL[impl.kind] || impl.kind}`)));
    select.addEventListener("change", () => {
      const impl = impls.find((i) => i.id === select.value);
      if (impl.id.endsWith("/native")) delete state.graph.stages[contract.name];
      else state.graph.stages[contract.name] = { impl: impl.id, params: defaultParams(impl) };
      touchGraph(); render();
    });
    return h("article", { class: `stage-card ${active ? "on" : ""}`, "data-stage": contract.name, "data-active": String(active) },
      h("header", {}, h("span", { class: "stage-icon" }, icon(info.icon, 18)),
        h("div", { class: "stage-title" }, h("h3", {}, info.title), h("code", {}, contract.name)),
        h("span", { class: "grow" }), active ? pill("Changed", "accent", "check") : pill("Reference", ""),
        pill(klass.label, klass.tone, null, klass.help)),
      h("p", { class: "blurb" }, info.blurb || contract.doc.split(". ")[0] + "."),
      h("details", { class: "ports" }, h("summary", {}, "What this stage reads and writes"),
        h("div", { class: "port-list" }, contract.ports.map((p) =>
          h("span", { class: `port ${p.role}`, title: `${p.doc} (${p.dtype}${p.shape ? " " + JSON.stringify(p.shape) : ""})` }, p.name)))),
      field("Use", select),
      active ? implBody(chosen, node) : null);
  }

  function implBody(impl, node) {
    return h("div", { class: "impl" }, h("p", { class: "hint" }, impl.doc, impl.fit ? ` Fits: ${impl.fit}` : ""),
      impl.params.length ? h("div", { class: "params" }, impl.params.map((p) => paramField(p, node))) : h("p", { class: "hint" }, "No settings."));
  }

  function paramField(p, node) {
    const current = node.params[p.name] ?? p.default;
    const commit = (value) => { node.params[p.name] = value; touchGraph(); };
    let input;
    if (p.choices && p.choices.length) {
      input = h("select", {}, p.choices.map((c) => h("option", { value: c, selected: c === current }, String(c))));
      input.addEventListener("change", () => commit(typeof p.default === "number" ? Number(input.value) : input.value));
    } else if (p.type === "bool") {
      input = h("input", { type: "checkbox", checked: Boolean(current) });
      input.addEventListener("change", () => commit(input.checked));
    } else if (p.type === "int" || p.type === "float") {
      input = h("input", { type: "number", value: current, step: p.type === "int" ? 1 : "any", min: p.min ?? null, max: p.max ?? null });
      input.addEventListener("input", () => { if (input.value !== "" && Number.isFinite(Number(input.value))) commit(Number(input.value)); });
    } else {
      input = h("input", { type: "text", value: current, class: "code" });
      input.addEventListener("input", () => commit(input.value));
    }
    return h("label", { class: `field ${p.type === "str" ? "wide" : ""}`, title: p.doc }, h("span", { class: "field-label" }, p.name), input);
  }

  function render() {
    clear(stages, contracts().map(stageCard));
    json.textContent = JSON.stringify(cleanGraph(), null, 2);
    validate();
  }

  const validate = debounce(async () => {
    try {
      const out = await post("/api/validate", { graph: cleanGraph() });
      if (!out.ok) { clear(summary, h("div", { class: "alert bad" }, out.error)); return; }
      const entries = Object.entries(out.stage_classes);
      const n = entries.length;
      clear(summary,
        h("p", { class: "lead" }, n ? `${n} change${n === 1 ? "" : "s"} to the step.` : "No changes: this is the reference."),
        entries.length ? h("ul", { class: "changes" }, entries.map(([stage, k]) => h("li", {}, h("span", {}, stageInfo(stage).title),
          pill(classInfo(k).label, classInfo(k).tone, null, classInfo(k).help)))) : null,
        h("p", { class: "hint" }, !n ? "Pick a different implementation on any card to begin."
          : out.comparable_to_native ? "Every change promises the reference's answer, so the comparison will be judged for accuracy against the reference."
          : "At least one change alters the physics. It is not expected to match the reference, so it is judged on its own checks."));
    } catch (error) { clear(summary, h("div", { class: "alert bad" }, error.message)); }
  }, 150);

  function refresh() {
    if (document.activeElement !== nameIn) nameIn.value = state.graph.name;
    json.textContent = JSON.stringify(cleanGraph(), null, 2);
    validate();
  }
  on("catalog", () => { fillLists(); render(); });
  on("graph", refresh);
  on("replaced", render);
  fillLists(); render();
}

// ---- 2. the equation ----

function mountEquation(root, go) {
  const stages = [...new Set(state.catalog.registry.impls.filter((i) => i.kind === "expression").map((i) => i.stage))];
  if (!stages.length) { root.append(empty({ iconName: "info", title: "No stage accepts an equation here" })); return; }
  const stageSel = h("select", { "aria-label": "stage", "data-test": "eq-stage" },
    stages.map((st) => h("option", { value: st }, `${stageInfo(st).title} (${st})`)));
  const expr = h("input", { type: "text", class: "code big", value: "-a*v - b*q", "aria-label": "equation", spellcheck: "false", "data-test": "equation" });
  const constants = Object.fromEntries(CONSTANTS.map((c) => [c, h("input", { type: "number", step: "any", value: c === "a" ? 0.4 : c === "b" ? 2 : 0, "aria-label": `constant ${c}` })]));
  const sweepSel = h("select", { "aria-label": "variable to sweep" });
  const lo = h("input", { type: "number", step: "any", value: -1, "aria-label": "from" }), hi = h("input", { type: "number", step: "any", value: 1, "aria-label": "to" });
  const atBox = h("div", { class: "row" });
  const implicit = h("input", { type: "checkbox", checked: true });
  const note = h("div", { class: "hint", "data-test": "eq-note" });
  const added = h("div", { class: "hint", "data-test": "eq-added" });
  const chart = new LineChart(h("div", {}), { title: "What the law gives back", xLabel: "q", yLabel: "value", zeroBased: false, height: 240 });
  let variables = ["q", "v", "time"], at = {};

  const fillSweep = () => {
    const keep = sweepSel.value || variables[0];
    clear(sweepSel, variables.map((v) => h("option", { value: v, selected: v === keep }, v)));
    clear(atBox, variables.filter((v) => v !== sweepSel.value).map((v) => field(`${v} held at`,
      h("input", { type: "number", step: "any", value: at[v] ?? 0, onchange: (e) => { at[v] = Number(e.target.value); preview(); } }))));
  };
  sweepSel.addEventListener("change", () => { fillSweep(); preview(); });

  const preview = debounce(async () => {
    const body = { stage: stageSel.value, expr: expr.value, sweep: sweepSel.value || variables[0], lo: Number(lo.value), hi: Number(hi.value),
                   at, n: 101, constants: Object.fromEntries(CONSTANTS.map((c) => [c, Number(constants[c].value)])) };
    try {
      const out = await post("/api/author/equation", body);
      if (!out.ok) { note.className = "hint bad"; note.textContent = out.error; return; }
      variables = out.variables; fillSweep();
      chart.xLabel = out.sweep; chart.yLabel = "law output";
      chart.set([{ id: "y", name: "law output", short: "law", cls: "custom", color: "var(--custom)", area: true, points: out.x.map((x, i) => [x, out.y[i]]) }]);
      note.className = "hint";
      note.textContent = out.finite ? "" : "Some values are not finite (division by zero, log of a negative, …).";
      if (out.derivative && out.derivative.text) {
        note.textContent += ` Slope with respect to ${out.derivative.of}: ${out.derivative.text}` +
          (implicit.checked ? ", treated as implicit damping." : ".");
      }
    } catch (error) { note.className = "hint bad"; note.textContent = error.message; }
  }, 250);
  for (const el of [expr, lo, hi, stageSel, ...Object.values(constants)]) el.addEventListener("input", preview);

  const use = button("Use in my experiment", { kind: "primary", iconName: "plus", test: "eq-use", onclick: () => {
    const stage = stageSel.value, impl = implsFor(stage).find((i) => i.id === `${stage}/expression`);
    if (!impl) return;
    const params = defaultParams(impl);
    params.expr = expr.value;
    for (const c of CONSTANTS) if (c in params) params[c] = Number(constants[c].value);
    if ("implicit" in params) params.implicit = implicit.checked;
    state.graph.stages[stage] = { impl: impl.id, params };
    setGraph({ ...state.graph, stages: { ...state.graph.stages } });
    clear(added, `Added to “${state.graph.name}”. `, h("button", { class: "link", type: "button", onclick: () => go.show("studio") }, "Watch it in Studio"));
  } });

  root.append(h("div", { class: "split-even" },
    h("section", { class: "card stack" }, h("header", { class: "card-head" }, h("h2", {}, "Write the law")),
      h("p", { class: "hint" }, "Use q (position), v (velocity), time and the constants a to h. Functions: abs, atan, clamp, cos, exp, log, max, min, sin, sqrt, tan, tanh, where."),
      field("Where it applies", stageSel),
      field("Equation", expr),
      h("div", { class: "row" }, CONSTANTS.map((c) => field(c, constants[c]))),
      h("div", { class: "row" }, field("Sweep", sweepSel), field("from", lo), field("to", hi), atBox),
      h("label", { class: "check" }, implicit, "Treat the slope in v as implicit damping (steadier at large damping)"),
      h("div", { class: "row center" }, use), added),
    h("section", { class: "card" }, h("header", { class: "card-head" }, h("h2", {}, "The curve"),
      h("span", { class: "grow" }), h("span", { class: "hint" }, "updates as you type; no simulation yet")), chart.container, note)));
  fillSweep(); preview();
}

// ---- 3. the kernel ----

function mountKernel(root, go) {
  const nameIn = h("input", { type: "text", value: "my-solver", maxlength: 64, "aria-label": "kernel name", "data-test": "kernel-name" });
  const stageSel = h("select", { "aria-label": "stage", "data-test": "kernel-stage" },
    contracts().map((c) => h("option", { value: c.name, selected: c.name === "newton.linear_solve" }, `${stageInfo(c.name).title} (${c.name})`)));
  const source = h("textarea", { class: "code", spellcheck: "false", "aria-label": "kernel source", "data-test": "kernel-source",
    placeholder: "Press “Load the template”, then change it." });
  const out = h("div", { class: "stack", "data-test": "kernel-out" });
  const savedBox = h("div", { class: "stack" });
  const check = button("Check in sandbox", { iconName: "shield", test: "kernel-check", onclick: runCheck });
  const save = button("Save as a building block", { kind: "primary", iconName: "save", test: "kernel-save", onclick: saveKernel });
  source.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && !event.shiftKey) {                    // a Tab in code is an indent, not a move to the next control
      event.preventDefault();
      const { selectionStart: a, selectionEnd: b } = source;
      source.setRangeText("    ", a, b, "end");
    }
  });

  async function loadTemplate() {
    try { const t = await get("/api/author/template"); source.value = t.source; stageSel.value = t.stage; }
    catch (error) { clear(out, h("div", { class: "alert bad" }, error.message)); }
  }

  async function runCheck() {
    check.disabled = true;
    clear(out, h("div", { class: "alert info" }, icon("clock", 16), "Checking in a sandbox. This compiles the kernel and runs it on a small scene…"));
    try {
      const job = await post("/api/author/kernel/check", { source: source.value, stage: stageSel.value });
      follow(job.id, async (event) => {
        if (event.event !== "end") return;
        check.disabled = false;
        const full = await get(`/api/jobs/${job.id}`);
        showReport(full.result, event.status === "done" ? null : (event.error || full.error));
      });
    } catch (error) { check.disabled = false; clear(out, h("div", { class: "alert bad" }, error.message)); }
  }

  function showReport(report, failure) {
    if (failure || !report) { clear(out, h("div", { class: "alert bad" }, failure || "no report")); return; }
    const v = report.verdict;
    clear(out,
      h("div", { class: "row center" }, pill(report.ok ? "Passes the checks" : "Does not pass", report.ok ? "good" : "bad", report.ok ? "check" : "alert"),
        h("span", { class: "hint" }, `sandbox: ${report.sandbox}${report.seconds === undefined ? "" : ` · ${report.seconds} s`}`),
        v && v.gates ? h("div", { class: "gates" }, Object.entries(v.gates).map(([k, x]) => gate(k, x))) : null),
      report.error ? h("div", { class: "alert bad" }, report.error) : null,
      v && v.problems && v.problems.length ? h("div", { class: "alert bad" }, v.problems.join("\n")) : null,
      report.stderr ? h("pre", { class: "json" }, report.stderr) : null,
      report.traceback ? h("pre", { class: "json" }, report.traceback) : null,
      h("p", { class: "hint" }, `Where the verdict is computed: ${report.integrity || "in the kernel's own process"}. ` +
        "Treat it as a check for you, not a certificate for anyone else."));
  }

  async function saveKernel() {
    try {
      const saved = await put(`/api/kernels/${encodeURIComponent(nameIn.value)}`, { source: source.value, stage: stageSel.value, entry: "Runtime" });
      await refreshCatalog();
      const impl = implsFor(stageSel.value).find((i) => i.id === saved.impl);
      clear(out, h("div", { class: "row center" }, pill(`Saved as ${saved.impl}`, "good", "check"),
        impl ? button("Use in my experiment", { onclick: () => {
          state.graph.stages[stageSel.value] = { impl: impl.id, params: defaultParams(impl) };
          setGraph({ ...state.graph, stages: { ...state.graph.stages } });
          go.show("studio");
        } }) : h("span", { class: "hint" }, "It will appear under Choose stages once its contract loads.")));
      listSaved();
    } catch (error) { clear(out, h("div", { class: "alert bad" }, error.message)); }
  }

  async function listSaved() {
    try {
      const kernels = await get("/api/kernels");
      clear(savedBox, kernels.length ? h("table", {}, h("thead", {}, h("tr", {}, ["Saved kernels", "Stage", ""].map((t) => h("th", {}, t)))),
        h("tbody", {}, kernels.map((k) => h("tr", {}, h("td", {}, k.name), h("td", {}, k.stage),
          h("td", { class: "actions" }, button("Open", { onclick: async () => { const full = await get(`/api/kernels/${encodeURIComponent(k.name)}`);
            source.value = full.source; stageSel.value = full.stage; nameIn.value = k.name; } }),
            iconButton("trash", { title: `Delete ${k.name}`, kind: "danger", onclick: async () => { await del(`/api/kernels/${encodeURIComponent(k.name)}`); listSaved(); } })))))) : null);
    } catch (error) { clear(savedBox, h("div", { class: "alert bad" }, error.message)); }
  }

  root.append(h("div", { class: "split-even" },
    h("section", { class: "card stack" }, h("header", { class: "card-head" }, h("h2", {}, "Your kernel")),
      h("p", { class: "hint" }, "Your source is compiled and run only inside a sandboxed worker, never in the dashboard's own process."),
      h("div", { class: "row" }, field("Name", nameIn), field("Stage", stageSel), h("span", { class: "grow" }), button("Load the template", { onclick: loadTemplate, test: "kernel-template" })),
      source, h("div", { class: "row" }, check, save)),
    h("section", { class: "card stack" }, h("header", { class: "card-head" }, h("h2", {}, "Result")), out,
      empty({ iconName: "shield", title: "Nothing checked yet", text: "Check runs your kernel on a small scene against the reference and reports what it found." }), savedBox)));
  const placeholder = out.nextElementSibling;
  new MutationObserver(() => { if (placeholder) placeholder.hidden = out.childNodes.length > 0; }).observe(out, { childList: true });
  listSaved();
}
