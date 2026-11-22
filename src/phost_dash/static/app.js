import { get } from "./api.js";
import { $, h, clear, num } from "./dom.js";
import { state, refreshCatalog, refreshSaved } from "./state.js";
import { mountLive, openJob as openLive, showRun } from "./live.js";
import { mountGraph } from "./graph.js";
import { mountAuthor } from "./author.js";
import { mountBoard } from "./board.js";
import { mountJobs } from "./jobs.js";

const TABS = [["live", "Live"], ["graph", "Graph"], ["author", "Author"], ["board", "Board"], ["jobs", "Jobs"]];
const mounted = {};
let current = null;

function show(name, params) {
  current = name;
  for (const [id] of TABS) {
    $(`#tab-${id}`).hidden = id !== name;
    const button = $(`#tab-button-${id}`);
    button.setAttribute("aria-selected", String(id === name));
    button.tabIndex = id === name ? 0 : -1;
  }
  history.replaceState(null, "", `#${name}`);
  if (mounted[name] && mounted[name].activate) mounted[name].activate(params);
}

async function refreshHeader() {
  try {
    const [info, ledger] = await Promise.all([get("/api/info"), get("/api/ledger")]);
    state.info = info;
    const gpu = info.gpu || {};
    const text = gpu.available
      ? `${gpu.name} · ${num(gpu.memory_used_mb / 1024, 2)} / ${num(gpu.memory_total_mb / 1024, 2)} GB · ${gpu.utilization}% busy`
      : "no GPU found";
    const chipEl = $("#gpu-chip");
    chipEl.className = `chip ${gpu.available ? "ok" : "bad"}`;
    chipEl.querySelector(".text").textContent = text;
    chipEl.title = gpu.available ? `${gpu.processes} process(es) using the GPU. Timings are only comparable when this is quiet.`
      : "Runs need a CUDA GPU on this machine.";
    const ledgerEl = $("#ledger-chip");
    ledgerEl.className = `chip ${ledger.ok ? "ok" : "bad"}`;
    ledgerEl.querySelector(".text").textContent = ledger.ok ? `ledger ${ledger.count} record${ledger.count === 1 ? "" : "s"} · intact` : "ledger: problems found";
    ledgerEl.title = ledger.ok ? "The hash chain is intact. It catches accidents, not a determined edit." : ledger.problems.join("\n");
  } catch (error) {
    $("#gpu-chip .text").textContent = "server not reachable";
    $("#gpu-chip").className = "chip bad";
  }
}

function theme() {
  const order = ["system", "light", "dark"];
  let value = localStorage.getItem("phost-theme") || "system";
  const apply = () => {
    if (value === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", value);
    $("#theme").textContent = `Theme: ${value}`;
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
  for (const [id, label] of TABS) {
    tabs.append(h("button", { id: `tab-button-${id}`, role: "tab", type: "button", "aria-selected": "false",
                              onclick: () => show(id) }, label));
  }
  tabs.addEventListener("keydown", (event) => {
    const ids = TABS.map(([id]) => id), at = ids.indexOf(current);
    if (event.key === "ArrowRight") { show(ids[(at + 1) % ids.length]); $(`#tab-button-${current}`).focus(); }
    if (event.key === "ArrowLeft") { show(ids[(at + ids.length - 1) % ids.length]); $(`#tab-button-${current}`).focus(); }
  });
  $("#footnote").textContent = "The dashboard listens on this machine only. GPU work runs in separate worker processes. " +
    "Results marked self-reported were measured here, by whoever pressed the button; nothing has checked them independently.";
  try {
    // the tabs decide what to offer from these, so they are loaded before any tab is built
    await Promise.all([refreshCatalog(), refreshSaved(), get("/api/info").then((info) => { state.info = info; })]);
  } catch (error) {
    for (const [id] of TABS) clear($(`#tab-${id}`), h("p", { class: "error" }, `Could not load the catalog: ${error.message}`));
    show("live");
    return;
  }
  const go = { show, openLive: (id) => { show("live"); openLive(id); }, showRun: (id) => { show("live"); showRun(id); } };
  mounted.live = mountLive($("#tab-live"), go);
  mounted.graph = mountGraph($("#tab-graph"), go);
  mounted.author = mountAuthor($("#tab-author"), go);
  mounted.board = mountBoard($("#tab-board"), go);
  mounted.jobs = mountJobs($("#tab-jobs"), go);
  const wanted = location.hash.slice(1);
  show(TABS.some(([id]) => id === wanted) ? wanted : "live");
  refreshHeader();
  setInterval(refreshHeader, 5000);
  window.addEventListener("phost-ledger", refreshHeader);
}

boot();
