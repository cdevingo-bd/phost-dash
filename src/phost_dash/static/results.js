// Results: what has been recorded (the leaderboard) and everything that has run (history). Like is only compared with
// like: the same scene, device, world count and kind of change.

import { get, post, follow } from "./api.js";
import { h, clear, num, when } from "./dom.js";
import { icon } from "./icons.js";
import { pill, segmented, empty, field, button } from "./ui.js";
import { scenes, classInfo } from "./state.js";
import { Scatter } from "./charts.js";

const TRUST = {
  "self-reported": ["Self-reported", "", "Measured on this machine by whoever ran it. Nothing has checked it independently."],
  judged: ["Judged", "good", "Re-measured by a separate judge process."],
};
const KIND = { live: "Watched", run: "Timed", reverify: "Re-checked", check: "Kernel check", render: "Drawn frames" };
const STATUS = { done: ["Done", "good", "check"], failed: ["Failed", "bad", "alert"], cancelled: ["Stopped", "", "stop"], running: ["Running", "busy", "clock"], queued: ["Waiting", "", "clock"] };

export function mountResults(root, go) {
  const panes = { board: h("div", { class: "pane" }), history: h("div", { class: "pane", hidden: true }) };
  const nav = segmented({ label: "Results view", value: "board", onChange: (v) => { for (const [k, el] of Object.entries(panes)) el.hidden = k !== v; if (v === "history") refreshHistory(); },
    options: [{ value: "board", label: "Leaderboard", icon: "trophy" }, { value: "history", label: "History", icon: "history", title: "Everything that has run" }] });
  root.append(h("div", { class: "results" },
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Results"),
      h("p", {}, "Recorded comparisons, ranked against each other, and a log of every run.")), nav), panes.board, panes.history));
  const board = mountBoard(panes.board, go);
  mountHistory(panes.history, go);
  return { activate() { board.activate(); if (!panes.history.hidden) refreshHistory(); } };

  function refreshHistory() { window.dispatchEvent(new Event("phost-history")); }
}

// ---- the leaderboard ----

function mountBoard(root, go) {
  const scene = h("select", { "aria-label": "scene filter", "data-test": "f-scene" });
  const klass = h("select", { "aria-label": "kind of change filter", "data-test": "f-klass" },
    [["", "Any kind of change"], ["exact", "Same answer"], ["approximate", "Close answer"], ["model_changing", "Changes the physics"], ["observer", "Read-only"]]
      .map(([k, t]) => h("option", { value: k }, t)));
  const trust = h("select", { "aria-label": "trust filter" }, [["", "Any trust"], ["self-reported", "Self-reported"], ["judged", "Judged"]].map(([k, t]) => h("option", { value: k }, t)));
  const worlds = h("input", { type: "number", min: 1, placeholder: "any", "aria-label": "world count filter" });
  const label = h("input", { type: "text", placeholder: "any", "aria-label": "label filter", size: 14 });
  const unreliable = h("input", { type: "checkbox" });
  const groups = h("div", { class: "stack groups", "data-test": "groups" });
  const summary = h("span", { class: "hint", "data-test": "ledger-summary" });
  for (const el of [scene, klass, trust, worlds, label, unreliable]) el.addEventListener("change", refresh);

  root.append(
    h("section", { class: "card note-card" }, h("div", { class: "note-icon" }, icon("shield", 20)),
      h("div", {}, h("strong", {}, "How to read this."),
        " Each group below holds entries that can fairly be compared. The ones marked ", pill("Best trade-off", "good", "check"),
        " are not beaten on every measure by anything else in the group. ", pill("Self-reported", ""), " means it was measured on this machine by whoever pressed the button; nothing has checked it independently.")),
    h("section", { class: "card" },
      h("header", { class: "card-head" }, h("h2", {}, "Filter"), summary, h("span", { class: "grow" }),
        button("Refresh", { iconName: "refresh", onclick: refresh })),
      h("div", { class: "row" }, field("Scene", scene), field("Kind of change", klass), field("Trust", trust), field("Worlds", worlds), field("Label", label),
        h("label", { class: "check" }, unreliable, "Include timings flagged unreliable"))),
    groups);

  function fillScenes() {
    const keep = scene.value;
    clear(scene, h("option", { value: "" }, "Any scene"), scenes().map((sc) => h("option", { value: sc.id, selected: sc.id === keep }, sc.id)));
  }

  let seen = "";
  async function refresh() {
    const query = new URLSearchParams();
    for (const [key, el] of [["scene", scene], ["klass", klass], ["trust", trust], ["worlds", worlds], ["label", label]]) if (el.value) query.set(key, el.value);
    if (unreliable.checked) query.set("include_unreliable", "1");
    try {
      const out = await get(`/api/board?${query}`);
      summary.textContent = `${out.ledger.count} record${out.ledger.count === 1 ? "" : "s"} in the ledger${out.ledger.ok ? "" : " · PROBLEMS FOUND"}`;
      const key = `${query}|${JSON.stringify(out)}`;
      if (key === seen) return;                         // nothing new: leave the page (and any re-run result on it) as it is
      seen = key;
      clear(groups, out.groups.length ? out.groups.map(group) : empty({ iconName: "trophy", title: "Nothing recorded yet",
        text: "Run a comparison in Studio, press Time it, then Record to leaderboard.",
        action: button("Go to Studio", { kind: "primary", iconName: "play", onclick: () => go.show("studio") }) }));
    } catch (error) { seen = ""; clear(groups, h("div", { class: "alert bad" }, error.message)); }
  }

  const objectiveName = (name) => ({ speedup: "Speed vs reference", accuracy_ratio: "Accuracy ÷ noise", step_ms: "Step time (ms)" }[name] || name);

  function group(g) {
    const [first, second] = g.objectives;
    const rows = g.rows;
    const scatter = rows.length && second ? new Scatter(h("div", {}), {
      title: "Where each entry sits", xLabel: objectiveName(first.name), yLabel: objectiveName(second.name),
      xSense: first.sense, ySense: second.sense, xFormat: num, yFormat: num }) : null;
    if (scatter) scatter.set(rows.map((r) => ({ x: r.objectives[first.name], y: r.objectives[second.name], front: r.rank === 0, label: r.label || `#${r.seq}`,
      rows: [{ k: "trust", v: r.trust }, { k: objectiveName(first.name), v: num(r.objectives[first.name]) }, { k: objectiveName(second.name), v: num(r.objectives[second.name]) }] })));
    const skipped = Object.entries(g.skipped).filter(([, n]) => n).map(([why, n]) => `${n} ${why}`).join(", ");
    const k = classInfo(g.klass);
    return h("section", { class: "card", "data-test": "group" },
      h("header", { class: "card-head" }, h("h2", {}, g.scene), pill(k.label, k.tone, null, k.help), h("span", { class: "hint" }, `${g.device} · ${g.worlds} world${g.worlds === 1 ? "" : "s"}`),
        h("span", { class: "grow" }), skipped ? h("span", { class: "hint" }, `left out: ${skipped}`) : null),
      rows.length ? h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Rank"), h("th", {}, "Entry"), h("th", {}, "Trust"),
        g.objectives.map((o) => h("th", { class: "num", title: o.sense === "max" ? "higher is better" : "lower is better" }, `${objectiveName(o.name)} ${o.sense === "max" ? "↑" : "↓"}`)),
        h("th", {}, "Recorded"), h("th", {}, ""))),
        h("tbody", {}, rows.map((r) => row(g, r))))) : h("p", { class: "hint" }, "Every entry in this group was left out (see above)."),
      scatter ? scatter.container : null);
  }

  function row(g, r) {
    const result = h("span", { class: "hint" });
    const btn = button("Re-run to check", { title: "Run it again here and compare with what was recorded", onclick: async () => {
      btn.disabled = true; result.className = "hint"; result.textContent = " re-running…";
      try {
        const job = await post("/api/jobs/reverify", { seq: r.seq });
        follow(job.id, async (event) => {
          if (event.event !== "end") return;
          btn.disabled = false;
          const full = await get(`/api/jobs/${job.id}`);
          const v = full.result;
          if (event.status !== "done" || !v) { result.className = "hint bad"; result.textContent = ` ${event.error || full.error || "failed"}`; return; }
          const text = v.agrees === true ? "agrees with the record" : v.agrees === false ? "disagrees" : "cannot say";
          result.className = `hint ${v.agrees === true ? "good" : v.agrees === false ? "bad" : ""}`;
          result.textContent = ` ${text}${v.differences && v.differences.length ? ": " + v.differences.join("; ") : ""}`;
        });
      } catch (error) { btn.disabled = false; result.className = "hint bad"; result.textContent = ` ${error.message}`; }
    } });
    const t = TRUST[r.trust] || [r.trust, "", ""];
    return h("tr", { "data-test": "board-row" },
      h("td", {}, r.rank === 0 ? pill("Best trade-off", "good", "check", "Nothing else in this group beats it on every measure.") : String(r.rank)),
      h("td", { title: `graph ${r.graph_hash}` }, h("span", {}, r.label || `#${r.seq}`), r.notes.length ? h("div", { class: "hint" }, r.notes.join("; ")) : null),
      h("td", {}, pill(t[0], t[1], null, t[2]), r.reliable ? null : pill("Timing unreliable", "warn", "alert")),
      g.objectives.map((o) => h("td", { class: "num" }, num(r.objectives[o.name]))),
      h("td", { class: "hint" }, when(r.time)), h("td", {}, btn, result));
  }

  fillScenes();
  refresh();
  window.addEventListener("phost-ledger", refresh);
  // Entries also arrive from outside this page (a contest, `phost-score submit`), so look again while the page is on screen.
  setInterval(() => { if (document.visibilityState === "visible" && root.offsetParent !== null) refresh(); }, 5000);
  return { activate() { fillScenes(); refresh(); } };
}

// ---- history ----

function mountHistory(root, go) {
  const body = h("div", {});
  const message = h("div", { class: "alert bad", hidden: true });
  root.append(h("section", { class: "card" }, h("header", { class: "card-head" }, h("h2", {}, "Everything that has run"),
    h("span", { class: "hint" }, "One job runs at a time so timings are not disturbed; the rest wait their turn."), h("span", { class: "grow" }),
    button("Refresh", { iconName: "refresh", onclick: refresh })), message, body));

  async function refresh() {
    try {
      const jobs = await get("/api/jobs");
      message.hidden = true;
      clear(body, jobs.length ? h("div", { class: "table-wrap" }, h("table", { "data-test": "jobs" }, h("thead", {}, h("tr", {}, ["When", "What", "Details", "Status", ""].map((t) => h("th", {}, t)))),
        h("tbody", {}, jobs.map((job) => {
          const [text, tone, ic] = STATUS[job.status] || [job.status, "", null];
          return h("tr", { class: "click", onclick: () => open(job), title: job.kind === "live" || job.kind === "run" ? "Open this run" : "" },
            h("td", { class: "hint" }, when(job.created)), h("td", {}, KIND[job.kind] || job.kind), h("td", { class: "hint" }, String(job.request || "")),
            h("td", {}, pill(text, tone, ic, job.error || "")),
            h("td", {}, job.status === "queued" || job.status === "running"
              ? button("Cancel", { onclick: async (e) => { e.stopPropagation(); await post(`/api/jobs/${job.id}/cancel`, {}).catch(() => {}); refresh(); } }) : null));
        })))) : empty({ iconName: "history", title: "Nothing has run yet", text: "Runs from Studio and checks from Build show up here, newest first." }));
    } catch (error) { message.hidden = false; message.textContent = error.message; }
  }
  function open(job) {
    if (job.kind === "live") go.openLive(job.id);
    else if (job.kind === "run") go.showRun(job.id);
  }
  window.addEventListener("phost-history", refresh);
  refresh();
}
