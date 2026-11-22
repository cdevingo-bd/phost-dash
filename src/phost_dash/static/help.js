// Guide: what this dashboard is for, the few words it uses, and what its numbers mean. Static text; no calls.

import { h } from "./dom.js";
import { icon } from "./icons.js";
import { pill, button } from "./ui.js";
import { CLASS_INFO, STAGE_INFO } from "./state.js";

const WORDS = [
  ["Reference", "MuJoCo Warp as shipped, with no changes. Every comparison is against it."],
  ["Experiment", "The reference with some parts of its step swapped for something else: a faster solver, an extra force, your own kernel."],
  ["Stage", "One place in the physics step where a swap is allowed. Each stage says what goes in, what comes out, and how strictly the answer must match."],
  ["Noise", "The GPU does not give bit-for-bit repeatable results, so the reference differs a little from a second copy of itself. That difference is the yardstick: an experiment that differs by about the same is indistinguishable."],
  ["Moved ÷ noise", "How far the experiment ended from the reference, divided by the noise. Near 1 means within the GPU's own wobble; large means a real difference."],
  ["Speed vs reference", "Reference step time divided by the experiment's step time. Above 1 is faster. Only meaningful on a quiet GPU, which is why timing is its own run."],
  ["Self-reported", "Measured on this machine by whoever pressed the button. Nothing has checked it independently, so it is evidence for you, not a certificate."],
];

export function mountHelp(root, go) {
  root.append(h("div", { class: "guide" },
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "How this works"),
      h("p", {}, "You change one part of a physics simulation, run it next to the untouched original, and see whether the answer holds and whether it got faster."))),
    h("ol", { class: "flow" },
      step("1", "layers", "Build", "Choose which parts of the step to change, or type an equation, or write a kernel.", "build"),
      step("2", "play", "Studio", "Run it next to the reference. Both are drawn as they are computed, with a plain verdict on whether they match.", "studio"),
      step("3", "clock", "Time it", "A separate, quiet run measures step time and accuracy so the numbers can be trusted.", "studio"),
      step("4", "trophy", "Results", "Record the result. Entries are ranked only against ones they can fairly be compared with.", "results")),
    h("div", { class: "split-even" },
      h("section", { class: "card" }, h("h2", {}, "Words used here"), h("dl", { class: "words" }, WORDS.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v))))),
      h("div", { class: "stack" },
        h("section", { class: "card" }, h("h2", {}, "Kinds of change"),
          h("p", { class: "hint" }, "Every stage is one of these, and the kind decides how the result is judged."),
          h("ul", { class: "kinds" }, Object.entries(CLASS_INFO).map(([k, v]) => h("li", {}, pill(v.label, v.tone), h("span", {}, v.help))))),
        h("section", { class: "card" }, h("h2", {}, "Parts of the step you can change"),
          h("ul", { class: "kinds" }, Object.entries(STAGE_INFO).map(([k, v]) => h("li", {}, h("span", { class: "stage-icon" }, icon(v.icon, 16)),
            h("span", {}, h("strong", {}, v.title), " — ", v.blurb))))))),
    h("section", { class: "card" }, h("h2", {}, "About the test scene"),
      h("p", {}, "The default scene, ", h("code", {}, "tank:boat"), ", is a glass tank that shuttles side to side with a boat in it. The boat has a cloth sail and three crates on its deck."),
      h("p", { class: "hint" }, "The water is 150 frictionless spheres, not a fluid: MuJoCo has no fluid solver. The boat floats because spheres hold it up, not because of buoyancy. " +
        "The scene is a busy mix of contact, a flexible body and free bodies; it is not meant to look or behave like water.")),
    h("section", { class: "card" }, h("h2", {}, "Where it runs and what is trusted"),
      h("ul", { class: "plain" },
        h("li", {}, "The dashboard listens on this machine only, and every run happens in a separate worker process on your GPU."),
        h("li", {}, "Your kernel source is compiled and run only inside a sandboxed worker, never in the dashboard's own process."),
        h("li", {}, "The sandbox does not make a verdict trustworthy: a kernel's check is computed inside its own process. The ledger's hash chain catches accidents, not someone who rewrites the whole file."),
        h("li", {}, "Timings are comparable only on a quiet GPU. The header shows how many other processes are using it."))),
    h("div", { class: "row" }, button("Start with an example", { kind: "primary", iconName: "sparkle", onclick: () => go.show("studio") }))));
  return { activate() {} };

  function step(n, iconName, title, text, to) {
    return h("li", {}, h("button", { class: "flow-step", type: "button", onclick: () => go.show(to) },
      h("span", { class: "flow-num" }, n), h("span", { class: "flow-icon" }, icon(iconName, 20)), h("strong", {}, title), h("span", {}, text)));
  }
}
