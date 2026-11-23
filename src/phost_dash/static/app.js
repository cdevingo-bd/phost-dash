import { get } from "./api.js";
import { $, h, clear, num } from "./dom.js";
import { icon } from "./icons.js";
import { pill } from "./ui.js";
import { state, refreshCatalog, refreshSaved, setGraph } from "./state.js";
import { mountStudio, openJob, showRun, prefillStudio } from "./studio.js";
import { mountBuild, openInBuild } from "./build.js";
import { kernelsIn } from "./agent.js";
import { mountResults } from "./results.js";
import { mountResearch } from "./research.js";
import { mountHelp } from "./help.js";

const TABS = [["studio", "Studio", "play"], ["build", "Build", "layers"], ["results", "Results", "trophy"], ["research", "Research", "target"], ["guide", "Guide", "help"]];
const mounted = {};
let current = null;

function show(name, params) {
  if (!TABS.some(([id]) => id === name)) name = "studio";
  current = name;
  for (const [id] of TABS) {
    const panel = $(`#tab-${id}`);
    if (panel) panel.hidden = id !== name;
    const button = $(`#tab-button-${id}`);
    button.setAttribute("aria-selected", String(id === name));
    button.tabIndex = id === name ? 0 : -1;
  }
  history.replaceState(null, "", `#${name}`);
  if (mounted[name] && mounted[name].activate) mounted[name].activate(params);
  window.scrollTo({ top: 0 });
}

async function refreshHeader() {
  const row = $("#status-row");
  try {
    const [info, ledger] = await Promise.all([get("/api/info"), get("/api/ledger")]);
    state.info = info;
    const gpu = info.gpu || {};
    const busy = gpu.available && gpu.processes > 0;
    clear(row,
      pill(gpu.available ? `${gpu.name} · ${num(gpu.memory_used_mb / 1024, 1)} / ${num(gpu.memory_total_mb / 1024, 1)} GB` : "No GPU found",
        gpu.available ? (busy ? "warn" : "good") : "bad", "chip",
        gpu.available ? `${gpu.processes} process(es) using the GPU, ${gpu.utilization}% busy. Timings are only comparable when this is quiet.`
          : "Runs need a CUDA GPU on this machine."),
      pill(ledger.ok ? `${ledger.count} recorded` : "Ledger problems", ledger.ok ? "" : "bad", ledger.ok ? "trophy" : "alert",
        ledger.ok ? "The ledger's hash chain is intact. It catches accidents, not a determined edit." : ledger.problems.join("\n")));
  } catch (error) {
    clear(row, pill("Server not reachable", "bad", "alert"));
  }
}

function theme() {
  const order = ["system", "light", "dark"];
  const icons = { system: "monitor", light: "sun", dark: "moon" };
  let value = localStorage.getItem("phost-theme") || "system";
  const apply = () => {
    if (value === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", value);
    const button = $("#theme");
    clear(button, icon(icons[value], 18));
    button.title = `Theme: ${value}. Click to change.`;
    window.dispatchEvent(new Event("themechange"));
  };
  $("#theme").addEventListener("click", () => {
    value = order[(order.indexOf(value) + 1) % order.length];
    localStorage.setItem("phost-theme", value);
    apply();
  });
  apply();
}

async function boot() {
  theme();
  const tabs = $("#tabs");
  for (const [id, label, ic] of TABS) {
    tabs.append(h("button", { id: `tab-button-${id}`, role: "tab", type: "button", "aria-selected": "false", "data-tab": id,
                              onclick: () => show(id) }, icon(ic, 16), h("span", {}, label)));
  }
  tabs.addEventListener("keydown", (event) => {
    const ids = TABS.map(([id]) => id), at = ids.indexOf(current);
    if (event.key === "ArrowRight") { show(ids[(at + 1) % ids.length]); $(`#tab-button-${current}`).focus(); }
    if (event.key === "ArrowLeft") { show(ids[(at + ids.length - 1) % ids.length]); $(`#tab-button-${current}`).focus(); }
  });
  $("#footnote").textContent = "The dashboard listens on this machine only. GPU work runs in separate worker processes. " +
    "Results marked self-reported were measured here, by whoever pressed the button; nothing has checked them independently.";
  try {
    // the screens decide what to offer from these, so they are loaded before any screen is built
    await Promise.all([refreshCatalog(), refreshSaved(), get("/api/info").then((info) => { state.info = info; })]);
  } catch (error) {
    for (const [id] of TABS) clear($(`#tab-${id}`), h("p", { class: "alert bad" }, `Could not load the catalog: ${error.message}`));
    show("studio");
    return;
  }
  const go = {
    show, openLive: (id) => { show("studio"); openJob(id); }, showRun: (id) => { show("studio"); showRun(id); },
    // a graph you were looking at (a win, an example, a replay) becomes what Build edits; the kernels it names are opened there
    async toBuild(graph, origin = null) {
      await refreshCatalog();                       // a kernel saved while it was fetched is an implementation now
      setGraph(JSON.parse(JSON.stringify(graph)));
      show("build");
      openInBuild(kernelsIn(graph), origin);
    },
    // what an agent made, from a leaderboard row, an arena entry or an arena check: the graph, the scene, the world counts
    async openAgent(kind, id, target) {
      const out = await get(`/api/open/${kind}/${encodeURIComponent(id)}`);
      await refreshCatalog();
      setGraph(out.graph);
      if (target === "build") { show("build"); openInBuild(kernelsIn(out.graph), out); }
      else { show("studio"); prefillStudio(out); }
      return out;
    },
    prefillStudio: (out) => { show("studio"); prefillStudio(out); },
  };
  mounted.studio = mountStudio($("#tab-studio"), go);
  mounted.build = mountBuild($("#tab-build"), go);
  mounted.results = mountResults($("#tab-results"), go);
  mounted.research = mountResearch($("#tab-research"), go);
  mounted.guide = mountHelp($("#tab-guide"), go);
  show(location.hash.slice(1) || "studio");
  refreshHeader();
  setInterval(refreshHeader, 5000);
  window.addEventListener("phost-ledger", refreshHeader);
}

boot();
