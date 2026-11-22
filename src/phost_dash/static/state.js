// What the screens share: what the server offers (stages, implementations, scenes), the experiment being edited, and
// the plain-language names for things.

import { get } from "./api.js";

export const emptyGraph = (name = "my-experiment") => ({ version: 1, name, host: "mjwarp", plugins: [], note: "", stages: {} });
export const NATIVE = Object.freeze({ version: 1, name: "reference", host: "mjwarp", plugins: [], note: "", stages: {} });

export const state = {
  info: null,
  catalog: null,
  saved: [],
  graph: emptyGraph(),
  scene: "tank:boat",
};

// ---- words ----
// The code says "stage", "native" and "swap class"; the screens say what they mean.
export const STAGE_INFO = {
  "newton.linear_solve": { title: "Newton linear solve", icon: "bolt",
    blurb: "Solves for the Newton step on every iteration. A faster solver should give the same answer." },
  "effective.solve": { title: "Flexible-body solve", icon: "layers",
    blurb: "Under the discrete integrator, solves the stiffness system of flexible bodies each step. A direct solve should give the same answer; it only pays where the built-in iteration is slow." },
  "dof.passive_force": { title: "Passive joint forces", icon: "tool",
    blurb: "Springs, dampers and other forces that act on joints without being commanded." },
  "control.law": { title: "Controller", icon: "target",
    blurb: "Turns joint position and velocity into actuator commands each step." },
  "probe.state": { title: "State probe", icon: "eye",
    blurb: "Reads the simulation each step without changing it." },
};
export const stageInfo = (name) => STAGE_INFO[name] || { title: name, icon: "cube", blurb: "" };

export const CLASS_INFO = {
  exact: { label: "Same answer", tone: "good",
    help: "This kind of change should reproduce the reference's answer exactly; it only changes how fast." },
  approximate: { label: "Close answer", tone: "warn",
    help: "This kind of change should stay close to the reference; the accuracy check measures how close." },
  model_changing: { label: "Changes the physics", tone: "serious",
    help: "This kind of change differs from the reference on purpose, so it is judged on its own terms, not against the reference." },
  observer: { label: "Read-only", tone: "",
    help: "This kind of change only reads the simulation. It must not alter the trajectory." },
};
export const classInfo = (k) => CLASS_INFO[k] || { label: k, tone: "", help: "" };

export const KIND_LABEL = { native: "Reference", builtin: "Built in", expression: "Typed equation", kernel: "Your kernel", plugin: "Plugin" };

// Starting points: each needs the named implementation to exist in this install.
export const PRESETS = [
  { id: "damping", title: "Extra damping", needs: "dof.passive_force/spring-damper", iconName: "tool",
    blurb: "A spring-damper law that adds viscous damping to every joint. Changes the physics, so it should visibly differ.",
    stages: { "dof.passive_force": { impl: "dof.passive_force/spring-damper", params: { k: 0, c: 0.4, q_ref: 0, implicit: true } } } },
  { id: "equation", title: "Drag you type: −a·v", needs: "dof.passive_force/expression", iconName: "fx",
    blurb: "The same idea written as an equation. Edit it in Build and watch the curve change.",
    stages: { "dof.passive_force": { impl: "dof.passive_force/expression", params: { expr: "-a*v", a: 0.4, implicit: true } } } },
  { id: "coupled", title: "Faster solver", needs: "newton.linear_solve/coupled", iconName: "bolt",
    blurb: "The coupled-block Cholesky. Same answer, faster on big flexible scenes (up to 512 coordinates).",
    stages: { "newton.linear_solve": { impl: "newton.linear_solve/coupled", params: {} } } },
];
export const availablePresets = () => {
  const have = new Set((state.catalog ? state.catalog.registry.impls : []).map((i) => i.id));
  return PRESETS.filter((p) => have.has(p.needs));
};
export function presetGraph(id) {
  const preset = PRESETS.find((p) => p.id === id);
  const graph = emptyGraph(preset.title);
  graph.stages = JSON.parse(JSON.stringify(preset.stages));
  return graph;
}

// ---- change notification ----
const listeners = { graph: new Set(), catalog: new Set(), replaced: new Set() };
export const on = (what, fn) => listeners[what].add(fn);
const fire = (what) => { for (const fn of listeners[what]) fn(); };

export function setGraph(graph) {
  state.graph = graph;
  fire("replaced");
  fire("graph");
}

// a change made in place (a parameter edited): same object, listeners told
export function touchGraph() { fire("graph"); }

export async function refreshCatalog() {
  state.catalog = await get("/api/catalog");
  fire("catalog");
}

export async function refreshSaved() {
  state.saved = await get("/api/graphs");
  fire("catalog");
}

export const contracts = () => (state.catalog ? state.catalog.registry.contracts : []);
export const implsFor = (stage) => (state.catalog ? state.catalog.registry.impls.filter((i) => i.stage === stage) : []);
export const scenes = () => (state.catalog ? state.catalog.scenes : []);
export const contractOf = (stage) => contracts().find((c) => c.name === stage);

export function defaultParams(impl) {
  return Object.fromEntries(impl.params.map((p) => [p.name, p.default]));
}

// the graph as the server wants it: nodes for stages that have a non-native implementation only
export function cleanGraph(graph = state.graph) {
  const stages = {};
  for (const [stage, node] of Object.entries(graph.stages)) {
    if (node && node.impl && !node.impl.endsWith("/native")) stages[stage] = { impl: node.impl, params: { ...node.params } };
  }
  return { ...graph, stages };
}

export const changeCount = (graph = state.graph) => Object.keys(cleanGraph(graph).stages).length;
