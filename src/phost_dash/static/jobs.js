// The Jobs tab: everything that has run, newest first. A live job replays its stream; a timed run shows its table.

import { get, post } from "./api.js";
import { h, clear, chip, when } from "./dom.js";

const KIND = { live: "watch", run: "timed run", reverify: "reverify", check: "kernel check", render: "draw frames" };
const STATUS = { done: "ok", failed: "bad", cancelled: "warn", running: "warn", queued: "" };

export function mountJobs(root, go) {
  const body = h("div", {});
  const message = h("div", { class: "error" });
  root.append(h("div", { class: "card" }, h("header", {}, h("h2", {}, "Jobs"), h("span", { class: "muted small" },
    "One runs at a time so timings are not disturbed; the rest wait their turn."), h("span", { class: "grow" }),
    h("button", { class: "btn small", type: "button", onclick: refresh }, "Refresh")), message, body));

  async function refresh() {
    try {
      const jobs = await get("/api/jobs");
      message.textContent = "";
      clear(body, jobs.length ? h("table", {}, h("thead", {}, h("tr", {}, ["when", "what", "request", "status", ""].map((t) => h("th", {}, t)))),
        h("tbody", {}, jobs.map((job) => h("tr", { class: "click", onclick: () => open(job) },
          h("td", { class: "muted small" }, when(job.created)), h("td", {}, KIND[job.kind] || job.kind), h("td", { class: "small" }, String(job.request || "")),
          h("td", {}, chip(job.status, STATUS[job.status] || "", job.error || "")),
          h("td", {}, job.status === "queued" || job.status === "running"
            ? h("button", { class: "btn small", type: "button", onclick: async (e) => { e.stopPropagation(); await post(`/api/jobs/${job.id}/cancel`, {}).catch(() => {}); refresh(); } }, "Cancel") : null))))) :
        h("p", { class: "note" }, "Nothing has run yet."));
    } catch (error) { message.textContent = error.message; }
  }

  function open(job) {
    if (job.kind === "live") go.openLive(job.id);
    else if (job.kind === "run") go.showRun(job.id);
  }

  refresh();
  return { activate: refresh };
}
