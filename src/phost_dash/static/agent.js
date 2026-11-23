// Opening what an agent made. A leaderboard row, an arena entry and an arena check each name something that ran (or could):
// these buttons fetch it as a graph, save any source it carries as a kernel of yours (so it runs the way your own kernels do),
// and put it where you can use it: Studio, with the scene, world counts and steps filled in, or Build, with the graph in the
// editor and the source open. Nothing runs until you press Run comparison or Time it.

import { h } from "./dom.js";
import { button } from "./ui.js";

// the kernels a graph names, from the implementation ids the dashboard gives a saved kernel: "<stage>/user-<name>"
export function kernelsIn(graph) {
  return Object.entries((graph && graph.stages) || {}).flatMap(([stage, node]) => {
    const found = node && typeof node.impl === "string" ? node.impl.match(/^.+\/user-(.+)$/) : null;
    return found ? [{ stage, name: found[1] }] : [];
  });
}

// "Test in Studio" and "View in Build" for something with an id of this kind ("entry": a ledger entry id; "check": an arena attempt id)
export function openButtons(go, kind, id) {
  const status = h("span", { class: "hint bad", hidden: true, "data-test": `open-${kind}-status` });
  const run = (target) => async (event) => {
    event.stopPropagation();
    for (const b of buttons) b.disabled = true;
    status.hidden = true;
    try { await go.openAgent(kind, id, target); }
    catch (error) { status.hidden = false; status.textContent = error.message; }
    finally { for (const b of buttons) b.disabled = false; }
  };
  const studio = button("Test in Studio", { iconName: "play", test: `open-${kind}-studio`,
    title: "Open it in Studio with its scene, world counts and steps filled in. Nothing runs until you press Run comparison.", onclick: run("studio") });
  const build = button("View in Build", { iconName: "layers", test: `open-${kind}-build`,
    title: "Open it in Build: the graph in the editor and, if it is code, the source.", onclick: run("build") });
  const buttons = [studio, build];
  return h("span", { class: "open-buttons" }, h("span", { class: "row center" }, studio, build), status);
}
