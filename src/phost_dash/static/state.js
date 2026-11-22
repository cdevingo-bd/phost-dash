// What the tabs share: what the server offers (stages, implementations, scenes) and the graph being edited.

import { get } from "./api.js";

export const emptyGraph = (name = "my-graph") => ({ version: 1, name, host: "mjwarp", plugins: [], note: "", stages: {} });

export const NATIVE = Object.freeze({ version: 1, name: "native", host: "mjwarp", plugins: [], note: "", stages: {} });

export const state = {
  info: null,
  catalog: null,
  saved: [],
  graph: emptyGraph(),
  scene: "tank:boat",
};

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
