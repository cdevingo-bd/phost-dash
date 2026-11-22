// The Graph tab: the host and one node per stage. Each node swaps in an implementation and shows its parameters.
// The graph is plain JSON; nothing here runs anything.

import { get, put, del, post } from "./api.js";
import { h, clear, chip, debounce } from "./dom.js";
import { state, setGraph, touchGraph, refreshSaved, contracts, implsFor, defaultParams, cleanGraph, emptyGraph, on } from "./state.js";

const PRESETS = [
  { id: "damping", title: "Extra damping on every joint (typed spring-damper)", needs: "dof.passive_force/spring-damper",
    stages: { "dof.passive_force": { impl: "dof.passive_force/spring-damper", params: { k: 0, c: 0.4, q_ref: 0, implicit: true } } } },
  { id: "equation", title: "Typed equation: viscous drag −a·v", needs: "dof.passive_force/expression",
    stages: { "dof.passive_force": { impl: "dof.passive_force/expression", params: { expr: "-a*v", a: 0.4, implicit: true } } } },
  { id: "coupled", title: "Coupled-block Cholesky (exact; needs nv ≤ 512)", needs: "newton.linear_solve/coupled",
    stages: { "newton.linear_solve": { impl: "newton.linear_solve/coupled", params: {} } } },
];

export function mountGraph(root, go) {
  const nameIn = h("input", { type: "text", value: state.graph.name, maxlength: 64, "aria-label": "graph name", id: "graph-name" });
  const savedSel = h("select", { "aria-label": "saved graphs" });
  const presetSel = h("select", { "aria-label": "examples" });
  const nodes = h("div", { class: "rail" });
  const json = h("pre", { class: "json" });
  const checkBox = h("div", { class: "stack" });
  const message = h("div", { class: "small" });

  nameIn.addEventListener("input", () => { state.graph.name = nameIn.value; touchGraph(); validate(); });

  const buttons = h("div", { class: "row center" },
    h("label", { class: "field" }, "Name", nameIn),
    h("label", { class: "field" }, "Saved graphs", savedSel),
    h("button", { class: "btn small", type: "button", onclick: load }, "Load"),
    h("button", { class: "btn small", type: "button", onclick: save }, "Save"),
    h("button", { class: "btn small danger", type: "button", onclick: remove }, "Delete"),
    h("button", { class: "btn small", type: "button", onclick: () => { setGraph(emptyGraph()); } }, "Clear"));

  root.append(
    h("div", { class: "card" }, h("header", {}, h("h2", {}, "Graph"), h("span", { class: "muted small" },
      "Pick an implementation for any stage. Stages left on native are not part of the graph.")),
      buttons, message,
      h("div", { class: "row center", style: { marginTop: "10px" } },
        h("label", { class: "field" }, "Start from an example", presetSel),
        h("button", { class: "btn small", type: "button", onclick: applyPreset }, "Use example"))),
    h("div", { style: { height: "14px" } }),
    h("div", { class: "editor" }, nodes,
      h("div", { class: "stack" },
        h("div", { class: "card" }, h("h2", {}, "What this graph will do"), checkBox),
        h("div", { class: "card" }, h("h2", {}, "As JSON"), json))));

  function fillLists() {
    clear(savedSel, state.saved.length ? state.saved.map((n) => h("option", { value: n }, n)) : h("option", { value: "" }, "(none yet)"));
    const have = new Set((state.catalog ? state.catalog.registry.impls : []).map((i) => i.id));
    clear(presetSel, PRESETS.filter((p) => have.has(p.needs)).map((p) => h("option", { value: p.id }, p.title)));
  }

  function applyPreset() {
    const preset = PRESETS.find((p) => p.id === presetSel.value);
    if (!preset) return;
    const graph = emptyGraph(preset.id);
    graph.stages = JSON.parse(JSON.stringify(preset.stages));
    setGraph(graph);
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
      say(`Saved “${graph.name}”.`);
    } catch (error) { say(error.message, true); }
  }
  async function remove() {
    if (!savedSel.value) return;
    try { await del(`/api/graphs/${encodeURIComponent(savedSel.value)}`); await refreshSaved(); say("Deleted."); }
    catch (error) { say(error.message, true); }
  }
  const say = (text, bad = false) => { message.className = `small ${bad ? "error" : "muted"}`; message.textContent = text; };

  // ---- the nodes ----
  function hostNode() {
    const gpu = (state.info && state.info.gpu) || {};
    return h("div", { class: "node host" }, h("header", {}, h("span", { class: "name" }, "host: MuJoCo Warp"),
      h("span", { class: "badge" }, "world step"), h("span", { class: "muted small" }, gpu.name || "")),
      h("div", { class: "note" }, "Each stage below is called by the host in its own place in the step. A node you leave on native runs the host's own code."));
  }

  function stageNode(contract) {
    const impls = implsFor(contract.name);
    const node = state.graph.stages[contract.name];
    const chosen = node ? impls.find((i) => i.id === node.impl) : null;
    const active = chosen && !chosen.id.endsWith("/native");
    const select = h("select", { "aria-label": `${contract.name} implementation` },
      impls.map((impl) => h("option", { value: impl.id, selected: node ? node.impl === impl.id : impl.id.endsWith("/native") },
        impl.id.endsWith("/native") ? "native (the host's own)" : `${impl.title} · ${impl.kind}`)));
    select.addEventListener("change", () => {
      const impl = impls.find((i) => i.id === select.value);
      if (impl.id.endsWith("/native")) delete state.graph.stages[contract.name];
      else state.graph.stages[contract.name] = { impl: impl.id, params: defaultParams(impl) };
      touchGraph(); render();
    });
    return h("div", { class: `node ${active ? "on" : ""}` },
      h("header", {}, h("span", { class: "name" }, contract.name), h("span", { class: `badge ${contract.swap_class}`, title: classHelp(contract.swap_class) },
        contract.swap_class.replace("_", " "))),
      h("div", { class: "note" }, contract.doc.split(". ")[0] + "."),
      h("div", { class: "ports", style: { marginTop: "8px" } }, contract.ports.map((p) =>
        h("span", { class: `port ${p.role}`, title: `${p.doc} (${p.dtype}${p.shape ? " " + JSON.stringify(p.shape) : ""})` }, p.name))),
      h("label", { class: "field" }, "Implementation", select),
      active ? implBody(chosen, node) : null);
  }

  function implBody(impl, node) {
    return h("div", {}, h("p", { class: "note", style: { marginTop: "8px" } }, impl.doc, impl.fit ? ` Fit: ${impl.fit}` : ""),
      h("div", { class: "params" }, impl.params.map((p) => paramField(p, node))));
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
    return h("label", { class: `field ${p.type === "str" ? "wide" : ""}`, title: p.doc }, p.name, input);
  }

  const classHelp = (k) => ({
    exact: "Exact: the same answer as native, only faster or slower.",
    approximate: "Approximate: close to native; the accuracy gate checks how close.",
    model_changing: "Model changing: it changes the physics, so it is judged on its own terms, not against native.",
    observer: "Observer: it only reads state.",
  }[k] || k);

  function render() {
    clear(nodes, hostNode(), contracts().map(stageNode));
    json.textContent = JSON.stringify(cleanGraph(), null, 2);
  }

  const validate = debounce(async () => {
    try {
      const out = await post("/api/validate", { graph: cleanGraph() });
      if (!out.ok) { clear(checkBox, h("div", { class: "error" }, out.error)); return; }
      const entries = Object.entries(out.stage_classes);
      clear(checkBox,
        entries.length ? h("div", { class: "row center" }, entries.map(([stage, k]) => chip(`${stage}: ${k.replace("_", " ")}`, k === "model_changing" ? "warn" : "ok")))
          : h("div", { class: "note" }, "No stage is swapped, so this graph is the native step. It is the reference twin."),
        h("div", { class: "note" }, out.comparable_to_native
          ? "Every swapped stage promises native's answer, so the timed comparison can score it against native for accuracy."
          : "A swapped stage changes the model, so it is not scored against native for accuracy; it is judged on its own gates."));
    } catch (error) { clear(checkBox, h("div", { class: "error" }, error.message)); }
  }, 150);

  function refresh() {
    if (document.activeElement !== nameIn) nameIn.value = state.graph.name;
    json.textContent = JSON.stringify(cleanGraph(), null, 2);
    validate();
  }
  on("catalog", () => { fillLists(); render(); });
  on("graph", refresh);
  on("replaced", render);
  fillLists(); render(); validate();
  // a parameter edit changes the JSON and the checks but must not rebuild the form under the user's cursor
  return { activate() { render(); } };
}
