// Research: what the agent layer (phost-agent) has done on this machine. Read-only. A search is started with
// `phost-agent run`; this page shows where its proposals stopped, what its memo saved, what it spent, and who has the device.

import { get } from "./api.js";
import { h, clear, num, when } from "./dom.js";
import { pill, tile, empty } from "./ui.js";

const VERDICT = {
  accepted: ["Win", "good", "check", "Passed its checks and beat the host's own version, on a timing that can be trusted."],
  measured: ["Ran, not a win", "", "clock", "Correct and timed, but not faster than the host's own version (or the timing was too noisy to count)."],
  rejected: ["Stopped", "bad", "x", "Stopped before it earned a timed run, or its run failed."],
};
const TIER = { none: "no proposal", static: "form", cheap: "simulator-free check", real: "scene's check", run: "timed run" };
const STAGES = [
  ["proposed", "Proposed", "Every candidate an agent handed in."],
  ["static", "Well formed", "A real stage and implementation with valid parameters, or source that parses and defines the runtime the stage calls."],
  ["cheap", "Passes the cheap check", "The stage's contract check on a simulator-free host. Needs no device."],
  ["real", "Passes on the scene", "The same check on the scene's own host."],
  ["run", "Timed", "Run on the device, alone, against the host's own version."],
  ["accepted", "A win", "Faster than the host's own version at every world count, with a timing that can be trusted."],
];

export function mountResearch(root) {
  const body = h("div", { class: "stack", "data-test": "research" });
  root.append(h("div", { class: "research" },
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Research"),
      h("p", {}, "What an agent has tried on this machine: where each proposal stopped, what the memo saved, what it all cost. " +
        "Start a search with ", h("code", {}, "phost-agent run"), "; this page only reads the record."))), body));
  let seen = "";
  const refresh = async () => {
    try {
      const out = await get("/api/research");
      const key = JSON.stringify(out);
      if (key === seen) return;                         // nothing new: leave the page as it is
      seen = key;
      clear(body, out.installed ? view(out) : missing());
    } catch (error) { seen = ""; clear(body, h("div", { class: "alert bad" }, error.message)); }
  };
  setInterval(() => { if (!root.hidden) refresh(); }, 5000);
  return { activate: refresh };
}

function missing() {
  return empty({ iconName: "target", title: "The agent layer is not installed",
    text: "phost-agent gives an agent a brief and a funnel of cheap checks before any run, remembers every result, and keeps a budget. " +
      "Install it with pip install phost-dash[research]." });
}

function view(o) {
  const searched = o.attempts || o.ceilings || o.task_list.length;
  if (!searched && !o.arena) {
    return [lease(o), empty({ iconName: "target", title: "No searches yet",
      text: "Run phost-agent run --scene <scene> --stage <stage>, or phost-agent arena --scene <scene> --contestant ..., and what it does appears here." })];
  }
  return [
    h("div", { class: "row center" }, o.intact ? pill("Journal intact", "good", "shield", "The journal's hash chain is intact. It catches accidents, not a determined edit.")
      : pill("Journal problems", "bad", "alert", o.problems.join("\n")), h("span", { class: "hint" }, o.journal), h("span", { class: "grow" }), lease(o)),
    o.intact ? null : h("div", { class: "alert bad" }, `The journal does not verify: ${o.problems[0]}. What is shown is what could be read.`),
    o.arena ? arena(o.arena) : null,
    searched ? tiles(o) : null,
    searched ? h("section", { class: "card" }, h("header", { class: "card-head" }, h("h2", {}, "Where proposals stopped"),
      h("span", { class: "hint" }, "Each row is how many candidates got this far. The earlier a bad one stops, the less the device was used.")), funnel(o)) : null,
    searched ? h("section", { class: "card" }, h("header", { class: "card-head" }, h("h2", {}, "Latest attempts"),
      h("span", { class: "hint" }, `${o.recent.length} shown`)), attempts(o.recent)) : null,
    searched ? h("section", { class: "card" }, h("header", { class: "card-head" }, h("h2", {}, "Searches")), tasks(o.task_list)) : null,
  ];
}

// ---- the arena: models competing on a scene's leaderboard ----

function arena(a) {
  const quiet = a.last_activity ? Math.round((Date.now() - Date.parse(a.last_activity)) / 60000) : 0;
  const stalled = a.status === "running" && quiet >= 10;
  const status = a.status === "finished" ? pill("Finished", "good", "check", "Every contestant has used its budget or left.")
    : stalled ? pill(`Quiet for ${quiet} min`, "warn", "alert", "No end was recorded and nothing has been written for a while: the process may have been stopped.")
    : pill("Running", "busy", "clock", "Contestants are taking turns.");
  const b = a.budget || {};
  return h("div", { class: "stack", "data-test": "arena" },
    h("section", { class: "card" },
      h("header", { class: "card-head" }, h("h2", {}, "Arena"), h("span", { class: "hint" }, `${a.scene} · worlds ${(a.worlds || []).join(", ")}`),
        h("span", { class: "grow" }), status),
      h("p", { class: "hint" }, `Each contestant: ${b.turns ?? "?"} turns, ${b.submits ?? "?"} timed runs${b.tokens ? `, ${num(b.tokens, 3)} tokens` : ""}. `
        + `${b.open === false ? "Closed: nobody sees another's work." : "Open: every check and every entry is visible to the others."} `
        + `Started ${when(a.started)}${a.last_activity ? `, last activity ${when(a.last_activity)}` : ""}. `
        + "Entries are ranked with everyone's on the Results tab."
        + (a.earlier_contests ? ` ${a.earlier_contests} earlier contest${a.earlier_contests === 1 ? "" : "s"} in this journal ${a.earlier_contests === 1 ? "is" : "are"} not shown.` : "")),
      contestants(a.contestants)),
    h("section", { class: "card" }, h("header", { class: "card-head" }, h("h2", {}, "Checks posted"),
      h("span", { class: "hint" }, `the latest ${a.checks.length}, newest first: what each contestant tried before spending a timed run`)), checks(a.checks)),
    h("section", { class: "card" }, h("header", { class: "card-head" }, h("h2", {}, "Entries"),
      h("span", { class: "hint" }, `${a.entries.length} shown, newest first`)), entries(a.entries)));
}

function contestants(rows) {
  return h("div", { class: "table-wrap" }, h("table", { "data-test": "contestants" },
    h("thead", {}, h("tr", {}, ["Contestant", "Turns", "Checks passed", "Entries", "Best", "Tokens", "Last move", "State"]
      .map((t, i) => h("th", { class: i >= 1 && i <= 5 ? "num" : "" }, t)))),
    h("tbody", {}, rows.map((c) => h("tr", {},
      h("td", {}, h("div", {}, c.name), h("div", { class: "hint" }, c.model)),
      h("td", { class: "num" }, String(c.turns)),
      h("td", { class: "num" }, `${c.passed} / ${c.checks}`),
      h("td", { class: "num" }, String(c.entries)),
      h("td", { class: "num" }, c.best_speedup === null || c.best_speedup === undefined ? "–" : `${num(c.best_speedup, 3)}×`),
      h("td", { class: "num" }, num(c.tokens, 3)),
      h("td", {}, c.last_action || "–", c.last_time ? h("span", { class: "hint" }, ` · ${when(c.last_time)}`) : null),
      h("td", {}, c.left ? pill(`left: ${c.left}`, "", null, "Why it is no longer playing.") : pill("playing", "busy", "clock")))))));
}

function checks(rows) {
  if (!rows.length) return h("p", { class: "hint" }, "No check has been posted yet.");
  return h("div", { class: "table-wrap" }, h("table", { "data-test": "arena-checks" },
    h("thead", {}, h("tr", {}, ["When", "Contestant", "What", "Result", "Why", "Id"].map((t) => h("th", {}, t)))),
    h("tbody", {}, rows.map((r) => h("tr", {},
      h("td", { class: "hint" }, when(r.time)),
      h("td", {}, `${r.contestant}`, h("span", { class: "hint" }, ` · turn ${r.turn}${r.action === "submit" ? " · tried to enter" : ""}`)),
      h("td", { class: "mono" }, r.what),
      h("td", {}, r.ok ? pill("Passed", "good", "check") : pill("Failed", "bad", "x")),
      h("td", { class: "hint reason" }, r.ok ? "" : r.outcome.replace(/^FAILED at the /, "at the ")),
      h("td", { class: "mono hint" }, r.id))))));
}

function entries(rows) {
  if (!rows.length) return h("p", { class: "hint" }, "Nobody has had a timed run yet.");
  return h("div", { class: "table-wrap" }, h("table", { "data-test": "arena-entries" },
    h("thead", {}, h("tr", {}, ["When", "Contestant", "What", "Speedup", "Kind", "Note"].map((t, i) => h("th", { class: i === 3 ? "num" : "" }, t)))),
    h("tbody", {}, rows.map((e) => h("tr", {},
      h("td", { class: "hint" }, when(e.time)),
      h("td", {}, e.contestant),
      h("td", { class: "mono" }, e.what),
      h("td", { class: "num" }, e.speedup === null || e.speedup === undefined ? "–" : `${num(e.speedup, 3)}×`),
      h("td", {}, e.klass),
      h("td", { class: "hint reason" }, e.note))))));
}

function tiles(o) {
  const { memo, spend, funnel, best } = o;
  const rate = memo.rate;
  return h("div", { class: "tiles" },
    tile({ label: "Proposals", value: String(o.attempts), note: `${o.tasks.finished} search${o.tasks.finished === 1 ? "" : "es"} finished` }),
    tile({ label: "Wins", value: String(funnel.accepted), tone: funnel.accepted ? "good" : "", note: best ? `best ${num(best.speedup, 3)}× on ${best.scene}` : "none yet" }),
    tile({ label: "Answered from memory", value: rate === null ? "–" : `${Math.round(rate * 100)}`, unit: rate === null ? "" : "%",
      note: `${memo.hits} of ${o.attempts} proposals ran nothing`, title: "A candidate seen before costs nothing: a failure is reported again, a pass skips the tiers it already passed." }),
    tile({ label: "Timed runs", value: String(funnel.run), note: `${o.attempts - funnel.run} stopped or answered before a run` }),
    tile({ label: "Device time", value: num(spend.gpu_seconds + spend.cpu_seconds, 3), unit: "s", note: `GPU ${num(spend.gpu_seconds, 3)} s · CPU ${num(spend.cpu_seconds, 3)} s` }),
    spend.tokens ? tile({ label: "Tokens", value: num(spend.tokens, 3), note: "as the proposers reported them" }) : null);
}

function funnel(o) {
  const total = o.funnel.proposed || 1;
  const rows = STAGES.map(([key, label, doc], i) => {
    const count = o.funnel[key];
    const lost = i > 0 ? o.funnel[STAGES[i - 1][0]] - count : 0;
    return h("tr", { title: doc },
      h("th", { scope: "row" }, label),
      h("td", { class: "funnel-cell" }, h("div", { class: "funnel-bar" }, h("div", { class: "funnel-fill", style: { width: `${(100 * count) / total}%` } }))),
      h("td", { class: "num" }, String(count)),
      h("td", { class: "num hint" }, `${Math.round((100 * count) / total)}%`),
      h("td", { class: "hint" }, lost > 0 ? `${lost} stopped here` : ""));
  });
  return h("div", { class: "table-wrap" }, h("table", { class: "funnel", "data-test": "funnel" }, h("tbody", {}, rows)));
}

function lease(o) {
  const parts = Object.entries(o.leases).map(([device, holder]) => holder
    ? pill(`${device}: held`, "busy", "clock", `held by process ${holder.pid}${holder.holder ? `: ${holder.holder}` : ""} since ${holder.since || "?"}`)
    : pill(`${device}: free`, "", "check", "No timed run holds this device."));
  return h("span", { class: "row center", "data-test": "leases" }, parts);
}

function attempts(rows) {
  if (!rows.length) return h("p", { class: "hint" }, "No attempts yet.");
  return h("div", { class: "table-wrap" }, h("table", { "data-test": "attempts" },
    h("thead", {}, h("tr", {}, ["#", "Scene · stage", "Candidate", "Stopped at", "Outcome", "Speedup", "Why", "When"]
      .map((t, i) => h("th", { class: i === 5 ? "num" : "" }, t)))),
    h("tbody", {}, rows.map((r) => {
      const [text, tone, ic, why] = VERDICT[r.verdict] || [r.verdict, "", "info", ""];
      return h("tr", {},
        h("td", { class: "num" }, String(r.attempt)),
        h("td", {}, h("div", {}, r.scene || "?"), h("div", { class: "hint" }, r.stage || "")),
        h("td", { class: "mono" }, r.candidate),
        h("td", {}, TIER[r.reached] || r.reached, r.memo ? h("span", { class: "hint", title: "Answered from the memo: nothing was run." }, " · memo") : null),
        h("td", {}, pill(text, tone, ic, why), r.improved ? h("span", { class: "hint", title: "A new best for its search." }, " ★") : null),
        h("td", { class: "num" }, r.speedup === null || r.speedup === undefined ? "–" : `${num(r.speedup, 3)}×`),
        h("td", { class: "hint reason" }, r.reason),
        h("td", { class: "hint" }, when(r.time)));
    }))));
}

function tasks(rows) {
  if (!rows.length) return h("p", { class: "hint" }, "No search has finished yet.");
  const STATUS = { finished: "The proposer had nothing more to try.", budget: "A budget ran out.", stalled: "Attempts in a row without a new best.", refused: "The ceiling gate: no replacement could gain enough to be worth an attempt." };
  return h("div", { class: "table-wrap" }, h("table", { "data-test": "tasks" },
    h("thead", {}, h("tr", {}, ["Scene · stage", "Proposer", "Ended", "Attempts", "Best", "Device s", "Reason", "When"].map((t, i) => h("th", { class: i === 3 || i === 4 || i === 5 ? "num" : "" }, t)))),
    h("tbody", {}, rows.map((t) => h("tr", {},
      h("td", {}, h("div", {}, t.scene || "?"), h("div", { class: "hint" }, `${t.stage || ""}${t.goal === "behaviour" ? " · behaviour" : ""}`)),
      h("td", {}, t.proposer || ""),
      h("td", {}, pill(t.status, t.status === "refused" ? "warn" : "", null, STATUS[t.status] || "")),
      h("td", { class: "num" }, String(t.attempts)),
      h("td", { class: "num" }, t.best_speedup ? `${num(t.best_speedup, 3)}×` : "–"),
      h("td", { class: "num" }, num(t.gpu_seconds + t.cpu_seconds, 3)),
      h("td", { class: "hint reason" }, t.reason),
      h("td", { class: "hint" }, when(t.time)))))));
}
