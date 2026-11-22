// Studio: the one screen most work happens on. Pick a scene and an experiment, run a comparison, and watch the
// reference and the experiment move side by side (or laid over each other), with a timeline of how far they have
// drifted apart, a plain-language verdict, and a separate timed comparison that can be recorded.

import { get, post, follow } from "./api.js";
import { h, clear, num, when, gate } from "./dom.js";
import { icon } from "./icons.js";
import { pill, segmented, tile, empty, field, button, iconButton, bar } from "./ui.js";
import { state, cleanGraph, scenes, NATIVE, availablePresets, presetGraph, classInfo, changeCount, on } from "./state.js";
import { Camera, View } from "./render3d.js";
import { LineChart, BarChart } from "./charts.js";

const LENGTHS = [["Short", 150], ["Normal", 300], ["Long", 600]];
const EVERY = 6;
let controller = null;
export const openJob = (id) => controller && controller.open(id);
export const showRun = (id) => controller && controller.showRun(id);

export function mountStudio(root, go) {
  const camera = new Camera();
  const S = { frames: [], layout: null, job: null, stop: null, index: 0, playing: true, followLive: true, fit: false,
              steps: 300, expected: 50, started: 0, replayGraph: null, expect: null, mode: "side", graphName: "Experiment" };

  // ---- the command bar: what to run ----
  const sceneSel = h("select", { "data-test": "scene", "aria-label": "scene" });
  const sceneNote = h("p", { class: "hint" });
  const expSel = h("select", { "data-test": "experiment", "aria-label": "experiment" });
  const expNote = h("div", { class: "exp-note" });
  const length = segmented({ label: "Run length", value: S.steps, options: LENGTHS.map(([label, steps]) => ({ value: steps, label, title: `${steps} steps` })),
                             onChange: (v) => { S.steps = v; } });
  const runBtn = button("Run comparison", { kind: "primary", iconName: "play", test: "run", onclick: () => start() });
  const stopBtn = button("Stop", { iconName: "stop", test: "stop", onclick: () => cancel(), disabled: true });
  const message = h("div", { class: "alert bad", hidden: true, "data-test": "error" });

  const bar1 = h("div", { class: "commandbar" },
    h("div", { class: "cmd-group" }, field("Scene", sceneSel), sceneNote),
    h("div", { class: "cmd-group" }, field("Experiment", expSel), expNote),
    h("div", { class: "cmd-group narrow" }, field("Length", length)),
    h("div", { class: "cmd-actions" }, runBtn, stopBtn));

  // ---- the viewer ----
  const canvases = { ref: h("canvas", { "aria-label": "reference simulation" }), exp: h("canvas", { "aria-label": "experiment simulation" }) };
  const views = { ref: new View(canvases.ref, camera), exp: new View(canvases.exp, camera) };
  const expName = h("span", {}, "Experiment");
  const expNameBoth = h("span", {}, "Experiment");
  const tags = {
    ref: h("div", { class: "tag" }, h("span", { class: "swatch native" }), "Reference", h("small", {}, "MuJoCo Warp as shipped")),
    exp: h("div", { class: "tag" }, h("span", { class: "swatch custom" }), expName),
    both: h("div", { class: "tag stacked" }, h("span", { class: "swatch custom" }), expNameBoth),
  };
  const welcome = h("div", { class: "viewer-empty", "data-test": "welcome" }, icon("flask", 28),
    h("strong", {}, "Nothing running yet"),
    h("span", {}, "Choose an experiment above and press Run comparison. The first frames appear once the scene has settled."));
  const stage = h("div", { class: "stage", "data-mode": "side" },
    h("div", { class: "vp ref" }, canvases.ref, tags.ref, tags.both),
    h("div", { class: "vp exp" }, canvases.exp, tags.exp));
  stage.append(welcome);
  const timecode = h("div", { class: "hud-time", "data-test": "timecode" }, "");
  stage.append(timecode);

  const phase = h("span", { class: "phase", "data-test": "status" }, pill("Ready", ""));
  const progress = bar(0);
  const mode = segmented({ label: "View", value: "side", onChange: (v) => setMode(v),
    options: [{ value: "side", label: "Side by side", icon: "split" }, { value: "overlay", label: "Overlay", icon: "overlay",
      title: "Draw both worlds in one view: the reference in blue, the experiment in orange" }] });
  const viewerHead = h("div", { class: "viewer-head" }, phase, h("span", { class: "grow" }), mode,
    iconButton("target", { title: "Reset the camera", onclick: () => { camera.reset(); fitCamera(); } }));

  const play = iconButton("pause", { title: "Pause", onclick: () => { S.playing = !S.playing; transportState(); } });
  const slider = h("input", { type: "range", min: 0, max: 0, value: 0, "aria-label": "frame", disabled: true, "data-test": "scrub" });
  const timeLabel = h("span", { class: "time", "data-test": "frame-time" }, "–");
  const speed = h("select", { "aria-label": "playback speed" },
    [["0.5×", 0.5], ["1×", 1], ["2×", 2], ["4×", 4]].map(([label, value]) => h("option", { value, selected: value === 1 }, label)));
  const live = h("input", { type: "checkbox", checked: true, "data-test": "follow" });
  live.addEventListener("change", () => { S.followLive = live.checked; if (S.followLive && S.frames.length) seek(S.frames.length - 1, true); });
  const transport = h("div", { class: "transport" }, play, timeLabel, slider, speed, h("label", { class: "check" }, live, "Follow newest"));
  slider.addEventListener("input", () => { live.checked = S.followLive = false; S.playing = false; seek(Number(slider.value), false); transportState(); });

  const drift = new LineChart(h("div", { class: "timeline" }), {
    title: "How far the experiment has moved from the reference", xLabel: "simulated time (s)", compact: true, height: 170,
    xFormat: (v) => num(v, 3), yFormat: (v) => num(v, 2),
    onPick: (t) => { const i = nearest(t); live.checked = S.followLive = false; S.playing = false; seek(i, false); transportState(); },
  });

  const viewer = h("section", { class: "card viewer" }, viewerHead, progress, stage, transport, drift.container);

  // ---- the verdict and the timing ----
  const verdictBody = h("div", { "data-test": "verdict" });
  const worldsIn = h("input", { type: "text", value: "1, 8", size: 10, "aria-label": "world counts", "data-test": "worlds" });
  const timedSteps = h("input", { type: "number", value: 20, min: 1, max: 2000, "aria-label": "steps per launch", "data-test": "timed-steps" });
  const timeBtn = button("Time it", { iconName: "clock", test: "time", onclick: () => timed() });
  const timedStatus = h("span", { class: "hint", "data-test": "timed-status" });
  const timedOut = h("div", { class: "stack", "data-test": "timed" });
  const verdictCard = h("section", { class: "card" }, h("header", { class: "card-head" }, h("h2", {}, "Does it match?"),
    h("span", { class: "grow" }), h("span", { class: "hint" }, "from the run above")), verdictBody);
  const timingCard = h("section", { class: "card" }, h("header", { class: "card-head" }, h("h2", {}, "How fast, and how accurate?"),
    h("span", { class: "grow" }), h("span", { class: "hint" }, "a separate run with nothing streaming, so timing is clean")),
    h("div", { class: "row" }, field("World counts to time", worldsIn, "more worlds take longer"),
      h("details", { class: "opts" }, h("summary", {}, "Options"), field("Steps per launch", timedSteps)), timeBtn, timedStatus), timedOut);

  // ---- first-run guidance ----
  const coach = h("section", { class: "coach", "data-test": "coach" },
    h("div", { class: "coach-head" }, h("div", {}, h("h2", {}, "How this works"),
      h("p", {}, "You change one part of the physics step, run it next to the untouched reference, and see whether the answer holds and whether it got faster.")),
      iconButton("x", { title: "Hide this", onclick: () => { localStorage.setItem("phost-coach", "off"); coach.hidden = true; } })),
    h("ol", { class: "coach-steps" },
      h("li", {}, h("b", {}, "Pick"), " a scene and an experiment above. An experiment is a set of changes; “Reference only” changes nothing."),
      h("li", {}, h("b", {}, "Run"), " the comparison. Both worlds start from the same state and are drawn as they are computed."),
      h("li", {}, h("b", {}, "Time"), " it for a clean speed and accuracy check, then record it to the leaderboard.")),
    h("div", { class: "row" }, button("Try the damping example", { kind: "primary", iconName: "sparkle", test: "try-example", onclick: () => tryExample() }),
      button("Make my own in Build", { iconName: "layers", onclick: () => go.show("build") })));
  coach.hidden = localStorage.getItem("phost-coach") === "off";

  root.append(h("div", { class: "studio" }, coach, bar1, message, viewer, h("div", { class: "split2" }, verdictCard, timingCard)));
  renderVerdict(null);

  // ---- options ----
  function fillScenes() {
    const keep = sceneSel.value || state.scene;
    clear(sceneSel, scenes().map((sc) => h("option", { value: sc.id, selected: sc.id === keep }, sc.id)));
    const found = scenes().find((sc) => sc.id === sceneSel.value);
    sceneNote.textContent = found ? found.description : "";
    if (found && !timedTouched) worldsIn.value = found.id.startsWith("tank") ? "1" : "1, 8";
  }
  let timedTouched = false;
  worldsIn.addEventListener("input", () => { timedTouched = true; });

  function fillExperiments() {
    const keep = expSel.value;
    const n = changeCount();
    const groups = [
      ["Reference", [["native", "Reference only (no changes)"]]],
      ["Your experiment", [["editor", `${state.graph.name} · ${n} change${n === 1 ? "" : "s"}`]]],
    ];
    const presets = availablePresets();
    if (presets.length) groups.push(["Examples", presets.map((p) => [`preset:${p.id}`, p.title])]);
    if (state.saved.length) groups.push(["Saved", state.saved.map((name) => [`saved:${name}`, name])]);
    if (S.replayGraph) groups.push(["From history", [["replay", S.replayGraph.name || "replayed experiment"]]]);
    clear(expSel, groups.map(([label, options]) => h("optgroup", { label },
      options.map(([value, text]) => h("option", { value }, text)))));
    expSel.value = [...expSel.options].some((o) => o.value === keep) ? keep : (n ? "editor" : "native");
    refreshExpectation();
  }

  async function graphFor(value) {
    if (value === "native") return NATIVE;
    if (value === "replay") return S.replayGraph;
    if (value.startsWith("preset:")) return presetGraph(value.slice(7));
    if (value.startsWith("saved:")) return get(`/api/graphs/${encodeURIComponent(value.slice(6))}`);
    return cleanGraph();
  }

  // what the chosen experiment is expected to do, so the verdict can be read against it
  async function refreshExpectation() {
    const value = expSel.value;
    let graph;
    try { graph = await graphFor(value); } catch (error) { clear(expNote, h("span", { class: "hint bad" }, error.message)); return null; }
    S.graphName = graph.name === "reference" ? "Reference twin" : graph.name;
    expName.textContent = expNameBoth.textContent = S.graphName;
    try {
      const out = await post("/api/validate", { graph });
      if (value !== expSel.value) return null;
      if (!out.ok) { S.expect = null; clear(expNote, h("span", { class: "hint bad" }, out.error)); return null; }
      S.expect = out;
      const classes = [...new Set(Object.values(out.stage_classes))];
      clear(expNote, classes.length ? classes.map((k) => pill(classInfo(k).label, classInfo(k).tone, null, classInfo(k).help))
        : h("span", { class: "hint" }, "Changes nothing: a second copy of the reference."),
        h("button", { class: "link", type: "button", onclick: () => go.show("build") }, "Edit in Build"));
      return graph;
    } catch (error) {
      clear(expNote, h("span", { class: "hint bad" }, error.message));
      return null;
    }
  }

  on("catalog", () => { fillScenes(); fillExperiments(); });
  on("graph", () => { fillExperiments(); });
  sceneSel.addEventListener("change", () => { state.scene = sceneSel.value; fillScenes(); });
  expSel.addEventListener("change", refreshExpectation);
  fillScenes(); fillExperiments();

  function tryExample() {
    expSel.value = "preset:damping";
    if (expSel.value !== "preset:damping") { go.show("build"); return; }
    start();
  }

  // ---- running ----
  const setPhase = (tone, text, iconName = null) => { clear(phase, pill(text, tone, iconName)); };

  function reset() {
    if (S.stop) S.stop();
    Object.assign(S, { frames: [], layout: null, stop: null, index: 0, fit: false, playing: true, followLive: true });
    live.checked = true;
    slider.max = 0; slider.value = 0; slider.disabled = true;
    timeLabel.textContent = "–"; timecode.textContent = "";
    message.hidden = true; message.textContent = "";
    drift.set([]);
    progress.set(0);
    for (const v of Object.values(views)) { v.layout = null; v.setLayers([]); }
    welcome.hidden = false;
    renderVerdict(null);
    transportState();
  }

  async function start() {
    reset();
    runBtn.disabled = true;
    setPhase("busy", "Starting the worker…");
    try {
      const graph = await refreshExpectation();
      if (!graph) throw new Error(expNote.textContent || "that experiment is not valid");
      S.started = performance.now();
      S.expected = Math.min(200, Math.floor(S.steps / EVERY));
      coach.hidden = true;
      const job = await post("/api/jobs/live", { graph, scene: sceneSel.value, steps: S.steps, every: EVERY });
      listen(job.id);
    } catch (error) {
      fail(error.message);
    }
  }

  function fail(text) {
    message.hidden = false; message.textContent = text;
    setPhase("bad", "Could not run", "alert");
    runBtn.disabled = false; stopBtn.disabled = true;
  }

  function listen(id) {
    S.job = id;
    stopBtn.disabled = false;
    runBtn.disabled = true;
    S.stop = follow(id, (event) => onEvent(id, event));
  }

  function onEvent(id, event) {
    if (id !== S.job) return;
    if (event.event === "layout") {
      S.layout = event;
      for (const v of Object.values(views)) v.setLayout(event);
      setPhase("busy", "Scene settled · capturing GPU graphs…");
    } else if (event.event === "live") {
      S.frames.push(event);
      if (!S.fit) { S.fit = true; welcome.hidden = true; fitCamera(); }
      slider.max = S.frames.length - 1; slider.disabled = false;
      if (S.followLive) seek(S.frames.length - 1, true);
      else timeLabel.textContent = timeText(S.index);
      drawDrift();
      progress.set(S.frames.length / S.expected);
      setPhase("busy", `Streaming · frame ${S.frames.length} of ${S.expected}`);
    } else if (event.event === "end") {
      finish(id, event);
    }
  }

  async function finish(id, event) {
    stopBtn.disabled = true; runBtn.disabled = false;
    S.stop = null;
    let job = null;
    try { job = await get(`/api/jobs/${id}`); } catch (error) { message.hidden = false; message.textContent = error.message; }
    if (id !== S.job) return;
    if (event.status === "done") {
      progress.set(1);
      const seconds = Math.round((performance.now() - S.started) / 1000);
      setPhase("good", S.started ? `Finished · ${S.frames.length} frames in ${seconds} s` : `Finished · ${S.frames.length} frames`, "check");
      renderVerdict(job && job.result);
    } else {
      setPhase(event.status === "cancelled" ? "" : "bad", event.status === "cancelled" ? "Stopped" : "Failed", event.status === "cancelled" ? "stop" : "alert");
      if (event.status !== "cancelled") {
        message.hidden = false;
        message.textContent = event.error || (job && job.error) || "the run failed";
      }
    }
  }

  async function cancel() {
    if (!S.job) return;
    try { await post(`/api/jobs/${S.job}/cancel`, {}); } catch (error) { message.hidden = false; message.textContent = error.message; }
  }

  // ---- looking ----
  const nearest = (t) => {
    let best = 0;
    S.frames.forEach((f, i) => { if (Math.abs(f.t - t) < Math.abs(S.frames[best].t - t)) best = i; });
    return best;
  };
  const timeText = (i) => (S.frames[i] ? `t = ${S.frames[i].t.toFixed(3)} s · step ${S.frames[i].step}` : "–");

  function layersFor(frame) {
    if (S.mode === "overlay") return { ref: [{ pose: frame.native, tint: "native", alpha: 0.7 }, { pose: frame.graph, tint: "custom", alpha: 0.7 }], exp: [] };
    return { ref: [{ pose: frame.native }], exp: [{ pose: frame.graph }] };
  }

  function seek(i, moveSlider) {
    S.index = Math.max(0, Math.min(S.frames.length - 1, i));
    const frame = S.frames[S.index];
    if (!frame) return;
    if (moveSlider) slider.value = S.index;
    timeLabel.textContent = timeText(S.index);
    timecode.textContent = `t = ${frame.t.toFixed(3)} s`;
    const layers = layersFor(frame);
    views.ref.setLayers(layers.ref);
    views.exp.setLayers(layers.exp);
    drift.setMark(frame.t);
  }

  function setMode(value) {
    S.mode = value;
    stage.dataset.mode = value;
    if (S.frames.length) seek(S.index, false);
    for (const v of Object.values(views)) v.draw();
  }

  function fitCamera() {
    const frame = S.frames[0];
    if (frame && views.ref.layout) camera.fit(views.ref.centres(frame.native));
  }

  function transportState() {
    clear(play, icon(S.playing ? "pause" : "play", 18));
    play.title = S.playing ? "Pause" : "Play";
    play.setAttribute("aria-label", play.title);
    play.setAttribute("aria-pressed", String(S.playing));
  }

  let clockAt = performance.now(), carry = 0;
  function tick(now) {
    const dt = now - clockAt; clockAt = now;
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
      { id: "graph", name: "Experiment vs reference", short: "experiment", cls: "custom", color: "var(--custom)", area: true, points: points("drift") },
      { id: "noise", name: "Reference vs a copy of itself (noise)", short: "noise", cls: "control", color: "var(--control)", dash: "5 4", points: points("noise") },
    ], S.frames[S.index] ? S.frames[S.index].t : null);
  }
  window.addEventListener("themechange", () => { for (const v of Object.values(views)) { v.sprites.clear(); v.draw(); } drawDrift(); });

  // ---- the verdict, in words ----
  function renderVerdict(result) {
    if (!result) {
      clear(verdictBody, empty({ iconName: "eye", title: "Run a comparison first",
        text: "After a run, this says whether the experiment kept the reference's answer, in plain terms, and how far apart they ended up." }));
      return;
    }
    const limit = (state.info && state.info.limits && state.info.limits.max_accuracy_ratio) || 10;
    const drifted = result.drift, noise = result.noise;
    const ratio = noise > 0 ? drifted / noise : Infinity;
    const classes = S.expect ? Object.values(S.expect.stage_classes) : [];
    const gap = `${num(drifted)}`, floor = `${num(noise)}`;
    let tone, iconName, title, text;
    if (drifted < 1e-9 && noise < 1e-9) {
      tone = "good"; iconName = "check"; title = "Identical to the reference";
      text = "The two worlds finished with no measurable difference.";
    } else if (!classes.length) {
      tone = "good"; iconName = "check"; title = "Same code, same answer (within noise)";
      text = `With no change selected, the experiment is a second copy of the reference. It ended ${gap} away, which is the GPU's own run-to-run noise: two runs never match bit for bit.`;
    } else if (S.expect && S.expect.comparable_to_native) {
      if (ratio <= 2) { tone = "good"; iconName = "check"; title = "Indistinguishable from the reference";
        text = `It ended ${gap} from the reference. The reference differs from a copy of itself by ${floor}, so this gap is within the GPU's own noise.`; }
      else if (ratio <= limit) { tone = "warn"; iconName = "alert"; title = "Close, but a little more than noise";
        text = `It ended ${gap} from the reference, ${num(ratio, 2)}× the noise (${floor}). That is inside the accuracy limit of ${limit}×.`; }
      else { tone = "bad"; iconName = "alert"; title = "It does not match the reference";
        text = `It ended ${gap} from the reference, ${num(ratio, 2)}× the noise (${floor}), past the ${limit}× limit. This kind of change should reproduce the reference's answer, so this points to a bug in the change or a poor fit for this scene.`; }
    } else {
      tone = "serious"; iconName = "info"; title = ratio <= 2 ? "No visible effect on this scene" : "Differs from the reference, as expected";
      text = ratio <= 2
        ? `This change alters the physics, but the run ended only ${gap} away (${num(ratio, 2)}× the noise of ${floor}): on this scene it does little.`
        : `This change alters the physics, so it is not held to the reference's answer. It ended ${gap} away, ${num(ratio, 2)}× the noise of ${floor}.`;
    }
    clear(verdictBody, h("div", { class: `verdict ${tone}` }, h("div", { class: "verdict-icon" }, icon(iconName, 22)),
      h("div", {}, h("h3", {}, title), h("p", {}, text))),
      h("div", { class: "tiles" },
        tile({ label: "Moved from reference", value: gap, title: "RMS difference of the joint and body coordinates at the end of the run" }),
        tile({ label: "Run-to-run noise", value: floor, title: "How far the reference moved from a second copy of itself. The GPU is not bitwise repeatable." }),
        tile({ label: "Moved ÷ noise", value: Number.isFinite(ratio) ? `${num(ratio, 3)}×` : "∞" })),
      h("p", { class: "hint" }, `A live estimate from ${result.steps} steps. Press Time it for the real accuracy check.`));
  }

  // ---- replaying a stored run ----
  async function open(id) {
    let job;
    try { job = await get(`/api/jobs/${id}`); } catch (error) { fail(error.message); return; }
    if (job.kind === "run") return showRunById(id);
    if (job.kind !== "live") return;
    reset();
    runBtn.disabled = true;
    S.steps = job.request.steps;
    state.scene = sceneSel.value = job.request.scene;
    S.replayGraph = job.request.graph;
    fillScenes(); fillExperiments();
    expSel.value = "replay";
    await refreshExpectation();
    S.expected = Math.min(200, Math.floor(job.request.steps / (job.request.every || EVERY)));
    S.followLive = false; live.checked = false; S.playing = true; transportState();
    coach.hidden = true;
    listen(id);
  }

  // ---- the timed comparison ----
  async function timed() {
    const worlds = worldsIn.value.split(/[,\s]+/).map(Number).filter((x) => Number.isInteger(x) && x > 0);
    if (!worlds.length) { timedStatus.textContent = "Enter whole numbers, such as 1, 8."; return; }
    timeBtn.disabled = true; timedStatus.textContent = "Queued…"; clear(timedOut);
    try {
      const graph = await refreshExpectation();
      if (!graph) throw new Error("that experiment is not valid");
      const job = await post("/api/jobs/run", { graph, scene: sceneSel.value, worlds, steps: Number(timedSteps.value), frames: false });
      follow(job.id, async (event) => {
        if (event.event === "start") timedStatus.textContent = `Timing ${worlds.join(", ")} world${worlds.length === 1 && worlds[0] === 1 ? "" : "s"}…`;
        else if (event.event === "cell") timedStatus.textContent = `${event.cell.worlds} done…`;
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

  async function showRunById(id) {
    try {
      const job = await get(`/api/jobs/${id}`);
      renderTimed(job);
      timedStatus.textContent = `Showing the run from ${when(job.created)}.`;
      timingCard.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) { timedStatus.textContent = error.message; }
  }

  function renderTimed(job) {
    const r = job.result;
    if (!r || !r.cells) { clear(timedOut, h("div", { class: "alert bad" }, (r && r.error) || job.error || "no result")); return; }
    const cell = r.cells.reduce((a, b) => (b.worlds > a.worlds ? b : a));
    const accuracyGate = cell.verdict.gates.accuracy;
    const classes = Object.entries(r.stage_classes || {});
    const bars = new BarChart(h("div", {}), { title: "Time per step: lower is better", yLabel: "ms per step", yFormat: (v) => num(v, 3) });
    bars.set(r.cells.map((c) => ({ label: `${c.worlds} world${c.worlds === 1 ? "" : "s"}`, values: { native: c.native_ms, graph: c.step_ms } })),
      [{ id: "native", name: "Reference", cls: "native" }, { id: "graph", name: "Experiment", cls: "custom" }]);
    const problems = r.cells.flatMap((c) => c.verdict.problems.map((p) => `${c.worlds} world${c.worlds === 1 ? "" : "s"}: ${p}`));
    const advisories = [...new Set(r.cells.flatMap((c) => c.advisories || []))];
    const notes = [...new Set(r.cells.flatMap((c) => c.verdict.notes || []))];
    const faster = cell.speedup >= 1.05, slower = cell.speedup <= 0.95;
    const label = h("input", { type: "text", placeholder: "Name this result (optional)", maxlength: 80, size: 28, "aria-label": "label", "data-test": "label" });
    const recorded = h("div", { class: "hint", "data-test": "recorded" });
    const record = button("Record to leaderboard", { iconName: "trophy", test: "record", disabled: Boolean((job.recorded || []).length), onclick: async () => {
      record.disabled = true;
      try {
        const out = await post(`/api/jobs/${job.id}/record`, { label: label.value });
        clear(recorded, out.records.map((x) => h("div", {}, `#${x.seq}: ${x.worlds} world${x.worlds === 1 ? "" : "s"}, ` +
          (x.eligible ? "ranked on the leaderboard" : `not ranked (${x.reasons.join("; ")})`) + (x.reliable ? "" : ", timing flagged unreliable")),
          ), h("button", { class: "link", type: "button", onclick: () => go.show("results") }, "Open leaderboard"));
        window.dispatchEvent(new Event("phost-ledger"));
      } catch (error) { record.disabled = false; clear(recorded, h("span", { class: "bad" }, error.message)); }
    } });
    if ((job.recorded || []).length) recorded.textContent = `Already recorded as #${job.recorded.join(", #")}.`;
    clear(timedOut,
      h("p", { class: "hint" }, `${r.scene} on ${r.meta.device}. `, classes.length ? classes.map(([stage, k]) => `${stage}: ${classInfo(k).label.toLowerCase()}`).join("; ") : "No change selected.",
        r.comparable_to_native ? "" : " It changes the physics, so accuracy against the reference is reported but not judged."),
      h("div", { class: "tiles" },
        tile({ label: "Step time", value: num(cell.step_ms), unit: "ms", note: `reference ${num(cell.native_ms)} ms · ${cell.worlds} world${cell.worlds === 1 ? "" : "s"}` }),
        tile({ label: "Speed vs reference", value: `${num(cell.speedup, 3)}×`, tone: faster ? "good" : slower ? "bad" : "", note: faster ? "faster" : slower ? "slower" : "about the same" }),
        tile({ label: "Accuracy vs noise", value: accuracyGate === null ? "n/a" : Number.isFinite(cell.accuracy_ratio) ? `${num(cell.accuracy_ratio, 3)}×` : "–",
               tone: accuracyGate === null ? "" : accuracyGate ? "good" : "bad",
               note: accuracyGate === null ? "not judged for a physics change" : accuracyGate ? "within the limit" : "over the limit",
               title: "How far the experiment ended from the reference, divided by how far the reference ends from a copy of itself" })),
      h("div", { class: "gates", "data-test": "gates" }, Object.entries(cell.verdict.gates).map(([k, v]) => gate(GATE_NAMES[k] || k, v))),
      r.cells.length > 1 ? h("table", {}, h("thead", {}, h("tr", {}, ["Worlds", "Reference ms", "Experiment ms", "Speed", "Accuracy ÷ noise"].map((t, i) => h("th", { class: i ? "num" : "" }, t)))),
        h("tbody", {}, r.cells.map((c) => h("tr", {}, h("td", {}, c.worlds), h("td", { class: "num" }, num(c.native_ms)), h("td", { class: "num" }, num(c.step_ms)),
          h("td", { class: "num" }, `${num(c.speedup, 3)}×`), h("td", { class: "num" }, c.verdict.gates.accuracy === null ? "n/a" : num(c.accuracy_ratio, 3)))))) : null,
      bars.container,
      problems.length ? h("div", { class: "alert bad" }, problems.join("\n")) : null,
      advisories.length ? h("div", { class: "alert warn" }, icon("alert", 16), advisories.join("; ")) : null,
      notes.length ? h("p", { class: "hint" }, notes.join("; ")) : null,
      h("div", { class: "row center record-row" }, label, record), recorded);
  }
  const GATE_NAMES = { finite: "Stayed finite", accuracy: "Accuracy", stage: "Stage limits" };

  controller = { open, showRun: showRunById };
  return { activate() { for (const v of Object.values(views)) v.draw(); } };
}
