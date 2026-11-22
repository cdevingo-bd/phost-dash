// The Live tab: the same scene run twice from the same starting state, native on the left and the graph under test on
// the right, streamed as it is computed. Below it, the timed comparison (a separate run, so the watching never
// disturbs the timing) and the button that records it.

import { get, post, follow } from "./api.js";
import { h, clear, num, chip, gate, when } from "./dom.js";
import { state, cleanGraph, scenes, NATIVE, on } from "./state.js";
import { Camera, View } from "./render3d.js";
import { LineChart, BarChart } from "./charts.js";

let controller = null;
export const openJob = (id) => controller && controller.open(id);
export const showRun = (id) => controller && controller.showRun(id);

export function mountLive(root, go) {
  const camera = new Camera();
  const S = { replayGraph: null, frames: [], layout: null, job: null, stop: null, index: 0, playing: true, followLive: true, last: 0, fit: false, timed: null };

  // ---- the controls ----
  const sceneSel = h("select", { id: "live-scene", "aria-label": "scene" });
  const graphSel = h("select", { id: "live-graph", "aria-label": "graph under test" });
  const steps = h("input", { type: "number", id: "live-steps", value: 300, min: 1, max: 5000, step: 50 });
  const every = h("input", { type: "number", id: "live-every", value: 6, min: 1, max: 200 });
  const watch = h("button", { class: "btn primary", type: "button", onclick: () => start() }, "Watch live");
  const stop = h("button", { class: "btn", type: "button", disabled: true, onclick: () => cancel() }, "Stop");
  const status = h("span", { class: "chip" }, h("span", { class: "dot" }), "idle");
  const message = h("div", { class: "error" });
  const sceneNote = h("p", { class: "note" });

  // ---- the two worlds ----
  const canvases = { native: h("canvas", { "aria-label": "native simulation" }), custom: h("canvas", { "aria-label": "graph simulation" }) };
  const views = { native: new View(canvases.native, camera), custom: new View(canvases.custom, camera) };
  const empty = h("div", { class: "empty" }, "Press “Watch live”. The first frames arrive once the scene has settled and the GPU graph is captured.");
  const graphLabel = h("span", {}, "graph");
  const world = (cls, label, canvas, extra) => h("div", { class: "view" }, canvas,
    h("div", { class: "label" }, h("span", { class: `swatch ${cls}` }), label), extra);
  const stage = h("div", { class: "stage" },
    world("native", h("span", {}, "native"), canvases.native, empty),
    world("custom", graphLabel, canvases.custom, null));

  const play = h("button", { class: "btn small", type: "button", onclick: () => { S.playing = !S.playing; transportState(); } }, "Pause");
  const slider = h("input", { type: "range", min: 0, max: 0, value: 0, "aria-label": "frame", disabled: true });
  const timeLabel = h("span", { class: "time" }, "–");
  const speed = h("select", { "aria-label": "playback speed" },
    [["0.5×", 0.5], ["1×", 1], ["2×", 2], ["4×", 4]].map(([label, value]) => h("option", { value, selected: value === 1 }, label)));
  const live = h("input", { type: "checkbox", checked: true });
  live.addEventListener("change", () => { S.followLive = live.checked; if (S.followLive && S.frames.length) seek(S.frames.length - 1, true); });
  const transport = h("div", { class: "transport" }, play, slider, timeLabel, speed,
    h("label", { class: "inline" }, live, "follow the newest frame"),
    h("button", { class: "btn small", type: "button", onclick: () => { camera.reset(); fitCamera(); } }, "Reset view"));
  slider.addEventListener("input", () => { live.checked = S.followLive = false; S.playing = false; seek(Number(slider.value), false); transportState(); });

  const drift = new LineChart(h("div", {}), {
    title: "How far each copy has moved from native", xLabel: "sim time (s)", yLabel: "RMS of position coordinates",
    xFormat: (v) => num(v, 3), yFormat: (v) => num(v, 3),
    onPick: (t) => { const i = nearest(t); live.checked = S.followLive = false; S.playing = false; seek(i, false); transportState(); },
  });
  const verdict = h("p", { class: "note" });

  // ---- the timed comparison ----
  const worldsIn = h("input", { type: "text", value: "1", size: 8, id: "timed-worlds", "aria-label": "world counts" });
  const timedSteps = h("input", { type: "number", value: 20, min: 1, max: 2000, id: "timed-steps" });
  const timeBtn = h("button", { class: "btn", type: "button", onclick: () => timed() }, "Time it");
  const timedStatus = h("span", { class: "muted small" });
  const timedOut = h("div", { class: "stack" });

  root.append(
    h("div", { class: "card" },
      h("header", {}, h("h2", {}, "Watch live"), status, h("span", { class: "grow" }), h("span", { class: "muted small" }, "drag to orbit · wheel to zoom · double-click to reset")),
      h("div", { class: "row" },
        h("label", { class: "field" }, "Scene", sceneSel), h("label", { class: "field" }, "Graph under test", graphSel),
        h("label", { class: "field" }, "Steps", steps), h("label", { class: "field" }, "Steps per frame", every), watch, stop),
      sceneNote, message, h("div", { style: { height: "10px" } }), stage, transport),
    h("div", { class: "card" }, drift.container, verdict),
    h("div", { class: "card" },
      h("header", {}, h("h2", {}, "Timed comparison"), h("span", { class: "grow" }),
        h("span", { class: "muted small" }, "A separate run, with nothing streaming, so timing is not disturbed.")),
      h("div", { class: "row" }, h("label", { class: "field" }, "World counts (comma separated)", worldsIn),
        h("label", { class: "field" }, "Steps per launch", timedSteps), timeBtn, timedStatus),
      timedOut));

  // ---- options ----
  function fillOptions() {
    const keepScene = sceneSel.value || state.scene, keepGraph = graphSel.value;
    clear(sceneSel, scenes().map((sc) => h("option", { value: sc.id, selected: sc.id === keepScene }, sc.id)));
    const nodes = Object.keys(cleanGraph().stages).length;
    clear(graphSel,
      h("option", { value: "editor" }, `editor: ${state.graph.name} (${nodes} node${nodes === 1 ? "" : "s"})`),
      h("option", { value: "native" }, "native twin (no changes)"),
      S.replayGraph ? h("option", { value: "replay" }, `replayed: ${S.replayGraph.name}`) : null,
      state.saved.map((name) => h("option", { value: `saved:${name}` }, `saved: ${name}`)));
    if (keepGraph && [...graphSel.options].some((o) => o.value === keepGraph)) graphSel.value = keepGraph;
    sceneNote.textContent = (scenes().find((sc) => sc.id === sceneSel.value) || {}).description || "";
  }
  on("catalog", fillOptions);
  on("graph", fillOptions);
  sceneSel.addEventListener("change", () => { state.scene = sceneSel.value; fillOptions(); });
  fillOptions();

  async function chosenGraph() {
    const value = graphSel.value;
    if (value === "native") return NATIVE;
    if (value === "replay") return S.replayGraph;
    if (value.startsWith("saved:")) return get(`/api/graphs/${encodeURIComponent(value.slice(6))}`);
    return cleanGraph();
  }

  // ---- watching ----
  const setStatus = (kind, text) => { status.className = `chip ${kind}`; clear(status, h("span", { class: "dot" }), text); };

  function reset() {
    if (S.stop) S.stop();
    Object.assign(S, { frames: [], layout: null, stop: null, index: 0, last: 0, fit: false, playing: true, followLive: true });
    live.checked = true;
    slider.max = 0; slider.value = 0; slider.disabled = true;
    timeLabel.textContent = "–";
    message.textContent = ""; verdict.textContent = "";
    drift.set([]);
    for (const v of Object.values(views)) { v.layout = null; v.pose = null; v.draw(); }
    empty.hidden = false;
    transportState();
  }

  async function start() {
    reset();
    watch.disabled = true;
    try {
      const graph = await chosenGraph();
      const job = await post("/api/jobs/live", { graph, scene: sceneSel.value, steps: Number(steps.value), every: Number(every.value) });
      graphLabel.textContent = graph.name === "native" ? "native twin" : `graph: ${graph.name}`;
      listen(job.id);
    } catch (error) {
      message.textContent = error.message;
      setStatus("bad", "not started");
      watch.disabled = false;
    }
  }

  function listen(id) {
    S.job = id;
    stop.disabled = false;
    setStatus("warn", "waiting for the GPU");
    S.stop = follow(id, (event) => onEvent(id, event));
  }

  function onEvent(id, event) {
    if (id !== S.job) return;
    if (event.event === "layout") {
      S.layout = event;
      for (const v of Object.values(views)) v.setLayout(event);
      setStatus("warn", "streaming");
    } else if (event.event === "live") {
      S.frames.push(event);
      if (!S.fit) { S.fit = true; empty.hidden = true; fitCamera(); }
      slider.max = S.frames.length - 1; slider.disabled = false;
      if (S.followLive) seek(S.frames.length - 1, true);
      else timeLabel.textContent = timeText(S.index);
      drawDrift();
      setStatus("warn", `streaming · ${S.frames.length} frames`);
    } else if (event.event === "end") {
      finish(id, event);
    }
  }

  async function finish(id, event) {
    stop.disabled = true; watch.disabled = false;
    S.stop = null;
    let job = null;
    try { job = await get(`/api/jobs/${id}`); } catch (error) { message.textContent = error.message; }
    if (id !== S.job) return;
    if (event.status === "done") {
      setStatus("ok", `finished · ${S.frames.length} frames`);
      const r = job && job.result;
      if (r) verdict.textContent = `After ${r.steps} steps the graph is ${num(r.drift)} from native; native is ${num(r.noise)} from itself ` +
        `(that gap is the device's own run-to-run noise, so it is the floor for judging the graph). ` +
        (r.advisories && r.advisories.length ? `Notes: ${r.advisories.join("; ")}` : "");
    } else {
      setStatus("bad", event.status === "cancelled" ? "stopped" : "failed");
      message.textContent = event.status === "cancelled" ? "" : (event.error || (job && job.error) || "the run failed");
    }
  }

  async function cancel() {
    if (!S.job) return;
    try { await post(`/api/jobs/${S.job}/cancel`, {}); } catch (error) { message.textContent = error.message; }
  }

  // ---- playback ----
  const nearest = (t) => {
    let best = 0;
    S.frames.forEach((f, i) => { if (Math.abs(f.t - t) < Math.abs(S.frames[best].t - t)) best = i; });
    return best;
  };
  const timeText = (i) => (S.frames[i] ? `t = ${S.frames[i].t.toFixed(3)} s · step ${S.frames[i].step}` : "–");

  function seek(i, moveSlider) {
    S.index = Math.max(0, Math.min(S.frames.length - 1, i));
    const frame = S.frames[S.index];
    if (!frame) return;
    if (moveSlider) slider.value = S.index;
    timeLabel.textContent = timeText(S.index);
    views.native.setPose(frame.native);
    views.custom.setPose(frame.graph);
    drift.setMark(frame.t);
  }

  function fitCamera() {
    const frame = S.frames[0];
    if (frame && views.native.layout) camera.fit(views.native.centres(frame.native));
  }

  function transportState() {
    play.textContent = S.playing ? "Pause" : "Play";
    play.setAttribute("aria-pressed", String(S.playing));
  }

  let clock = performance.now(), carry = 0;
  function tick(now) {
    const dt = now - clock; clock = now;
    if (S.playing && !S.followLive && S.frames.length > 1) {
      carry += (dt / 1000) * 30 * Number(speed.value);
      const whole = Math.floor(carry);
      if (whole) {
        carry -= whole;
        if (S.index + whole >= S.frames.length - 1) { seek(S.frames.length - 1, true); S.playing = false; transportState(); }
        else seek(S.index + whole, true);
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  play.addEventListener("click", () => {
    if (S.playing && !S.followLive && S.index >= S.frames.length - 1 && S.frames.length > 1) seek(0, true);
  });

  function drawDrift() {
    const points = (key) => S.frames.map((f) => [f.t, f[key]]);
    drift.set([
      { id: "graph", name: "graph vs native", short: "graph", cls: "custom", color: "var(--custom)", points: points("drift") },
      { id: "noise", name: "native vs native (noise floor)", short: "noise floor", cls: "control", color: "var(--control)", dash: "5 4", points: points("noise") },
    ], S.frames[S.index] ? S.frames[S.index].t : null);
  }
  window.addEventListener("themechange", () => { for (const v of Object.values(views)) v.draw(); drawDrift(); });

  // ---- replaying a stored job ----
  async function open(id) {
    let job;
    try { job = await get(`/api/jobs/${id}`); } catch (error) { message.textContent = error.message; return; }
    if (job.kind === "run") return showRun(id);
    if (job.kind !== "live") return;
    reset();
    watch.disabled = true;
    steps.value = job.request.steps; every.value = job.request.every;
    sceneSel.value = state.scene = job.request.scene;
    S.replayGraph = job.request.graph;
    fillOptions();                                           // the scene note and the graph choice describe what is replayed
    graphSel.value = "replay";
    graphLabel.textContent = `graph: ${job.request.graph.name || "?"}`;
    S.followLive = false; live.checked = false; S.playing = true; transportState();
    listen(id);
  }

  // ---- the timed comparison ----
  async function timedGraph() { return chosenGraph(); }

  async function timed() {
    const worlds = worldsIn.value.split(",").map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0);
    if (!worlds.length) { timedStatus.textContent = "enter whole numbers, such as 1,8"; return; }
    timeBtn.disabled = true; timedStatus.textContent = "queued…"; clear(timedOut);
    try {
      const graph = await timedGraph();
      const job = await post("/api/jobs/run", { graph, scene: sceneSel.value, worlds, steps: Number(timedSteps.value), frames: false });
      follow(job.id, async (event) => {
        if (event.event === "start") timedStatus.textContent = `running on ${worlds.join(", ")} world(s)…`;
        else if (event.event === "cell") timedStatus.textContent = `${event.cell.worlds} world(s) done…`;
        else if (event.event === "end") {
          timeBtn.disabled = false;
          const full = await get(`/api/jobs/${job.id}`);
          if (event.status === "done") { timedStatus.textContent = ""; renderTimed(full); }
          else timedStatus.textContent = event.error || full.error || event.status;
        }
      });
    } catch (error) {
      timedStatus.textContent = error.message;
      timeBtn.disabled = false;
    }
  }

  function showRunJob(job) {
    renderTimed(job);
    timedStatus.textContent = `shown from ${when(job.created)}`;
  }

  async function showRunById(id) {
    try { showRunJob(await get(`/api/jobs/${id}`)); } catch (error) { timedStatus.textContent = error.message; }
  }

  function renderTimed(job) {
    const r = job.result;
    if (!r || !r.cells) { clear(timedOut, h("p", { class: "error" }, (r && r.error) || job.error || "no result")); return; }
    const classes = Object.entries(r.stage_classes || {});
    const bars = new BarChart(h("div", {}), { title: "Time per step (ms), lower is better", yLabel: "ms per step" });
    bars.set(r.cells.map((c) => ({ label: `${c.worlds} world${c.worlds === 1 ? "" : "s"}`, values: { native: c.native_ms, graph: c.step_ms } })),
      [{ id: "native", name: "native", cls: "native" }, { id: "graph", name: "graph", cls: "custom" }]);
    const problems = r.cells.flatMap((c) => c.verdict.problems.map((p) => `${c.worlds} world(s): ${p}`));
    const advisories = [...new Set(r.cells.flatMap((c) => c.advisories || []))];
    const notes = [...new Set(r.cells.flatMap((c) => c.verdict.notes || []))];
    const label = h("input", { type: "text", placeholder: "label for the ledger (optional)", maxlength: 80, size: 30, "aria-label": "label" });
    const recorded = h("div", { class: "small" });
    const record = h("button", { class: "btn", type: "button", disabled: Boolean((job.recorded || []).length), onclick: async () => {
      record.disabled = true;
      try {
        const out = await post(`/api/jobs/${job.id}/record`, { label: label.value });
        clear(recorded, out.records.map((x) => h("div", {}, `#${x.seq}: ${x.worlds} world(s), ${x.klass}, ` +
          (x.eligible ? "ranked" : `not ranked (${x.reasons.join("; ")})`) + (x.reliable ? "" : ", unreliable timing"))));
        window.dispatchEvent(new Event("phost-ledger"));
      } catch (error) { record.disabled = false; clear(recorded, h("span", { class: "error" }, error.message)); }
    } }, "Record to ledger");
    if ((job.recorded || []).length) recorded.textContent = `Already recorded as #${job.recorded.join(", #")}.`;
    clear(timedOut,
      h("div", { class: "small muted" }, `${r.scene} on ${r.meta.device} · graph “${r.graph.name}” · `,
        classes.map(([stage, k]) => `${stage}: ${k}`).join(", ") || "no stage swapped", r.comparable_to_native ? "" : " · not comparable to native"),
      h("table", {}, h("thead", {}, h("tr", {}, ["worlds", "native ms/step", "graph ms/step", "speedup", "Δ vs native", "native vs native", "accuracy ratio", "gates"]
        .map((t, i) => h("th", { class: i && i < 7 ? "num" : "" }, t)))),
        h("tbody", {}, r.cells.map((c) => h("tr", {},
          h("td", {}, c.worlds), h("td", { class: "num" }, num(c.native_ms)), h("td", { class: "num" }, num(c.step_ms)),
          h("td", { class: "num" }, `${num(c.speedup)}×`), h("td", { class: "num" }, num(c.rms_dqpos)),
          h("td", { class: "num" }, num(c.control_rms_dqpos)), h("td", { class: "num" }, num(c.accuracy_ratio)),
          h("td", {}, h("div", { class: "gates" }, Object.entries(c.verdict.gates).map(([k, v]) => gate(k, v)))))))),
      bars.container,
      problems.length ? h("div", { class: "error" }, problems.join("\n")) : null,
      advisories.length ? h("div", { class: "small" }, chip("note", "warn"), " ", advisories.join("; ")) : null,
      notes.length ? h("div", { class: "small muted" }, notes.join("; ")) : null,
      h("div", { class: "row center" }, label, record), recorded);
  }

  drift.set([]);
  controller = { open, showRun: showRunById };
  return { activate() { for (const v of Object.values(views)) v.draw(); } };
}
