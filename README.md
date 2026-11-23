# phost-dash

A local browser dashboard for [phost](https://github.com/cdevingo-bd/phost). Build a graph (which implementation sits on which
stage of the simulation step), run it beside native on a scene, time it, and rank the results. The dashboard runs no simulation
itself: [phost-lab](https://github.com/cdevingo-bd/phost-lab)'s workers do, on whichever engine the scene names.

![The browser's five screens talk over HTTP to a loopback-only server: a guard on every request, an App of plain methods, and a job queue that runs one job at a time. Each job runs in a phost-lab worker process on an engine (MuJoCo Warp, a NumPy chain, a JAX chain, or yours). The server reads and writes a state directory holding graphs, kernels and jobs, the ledger, and the agent's journal, which it only reads.](docs/flow.svg)

```
# from clones of phost, phost-coupledchol, phost-lab, phost-author, phost-score and this repo (see the phost README; phost-agent is optional):
pip install -e ../phost -e ../phost-coupledchol -e ../phost-lab -e ../phost-author -e ../phost-score -e .
phost-dash
```

It prints an address and opens it in your browser. The address carries a one-time key; the server turns it into a
cookie and drops it from the address bar. Nothing is served without it.

What a scene needs depends on its engine. A MuJoCo scene needs `mujoco`, `mujoco-warp` and a CUDA GPU. The chain scenes
(`chain32:pluck`, `chain256:ringing`) need only NumPy and run on the CPU; `jaxchain32:pluck` needs `jax`. The page opens on
`tank:boat`, a MuJoCo scene, so on a machine without MuJoCo pick a chain scene in the scene list first. Run, live view,
phase profile and *where a change could pay* were run through the dashboard on the NumPy chain with no MuJoCo or Warp installed.
Pictures of a run (the rendered frames) are drawn for MuJoCo scenes only.

## What is in it

Five screens, in the order you use them:

- **Studio**: pick a scene and an experiment and press *Run comparison*. The same scene is run twice from the same
  settled state, the reference on the left and your experiment on the right (or laid over each other), drawn as it is
  computed. A third copy of the reference is stepped alongside as a yardstick: a GPU is not bitwise repeatable, so
  "how far is the experiment from the reference" only means something next to "how far is the reference from itself" (an engine
  that does repeat exactly, such as the chain, is compared with a small rounding floor instead).
  Below the view, a plain-language verdict says whether the experiment kept the reference's answer. *Time it* is a
  separate run with nothing streaming, so the timing is clean: it gives step time, speed against the reference and
  accuracy per world count, with the checks that passed, and *Record to leaderboard* keeps it. Drag to orbit, scrub or
  play back, and click the drift chart to jump. The experiment list also offers **what beat the reference**, on this scene and
  on every other scene (choosing one from another scene moves Studio to it), recorded by anyone (a contest, a search, a person): an entry that keeps the answer and is faster at every world count it was
  measured at, with a timing that can be trusted. Choose one and run it like your own. An entry whose source only an agent contest
  holds is saved as a kernel of yours (`win-...`, visible in Build) and runs the way a kernel you wrote does. With nothing recorded
  that beats the reference the list says so. *Edit in Build*, under the list, opens the experiment that is selected (a win, an
  example, a saved one), not whatever was in the editor.
- **Build**: three workspaces. *Choose stages* shows each place in the physics step with the reference or an
  alternative for it, its settings, and what kind of change it is (same answer, close answer, changes the physics,
  read-only). Two cards above them measure on a scene, in a worker: *Where a change could pay* (how much of the step each
  part takes, so the most a faster replacement could give, which parts apply and why not, and the shape of the
  flexible-body matrix) and *Where the time goes* (each phase of the step timed on its own, for the reference and, if you ask,
  for your experiment installed). *Type an equation* takes the law of any stage that declares a form for it and shows what it does before any simulation: a curve per output for a force, controller or body wrench, each channel's value on a sample state for a probe, and the residual after every pass for a typed solver step (conjugate gradients, Jacobi or your own lines). *Write a kernel* checks your
  code in a sandbox. Each ends as a choice in Studio. An experiment is plain JSON; saved ones are files.
- **Results**: the leaderboard, grouped so only like is compared with like, with the best trade-offs marked and the trust
  level of every row (a row can be re-run here and compared with what was recorded), and a history of everything that
  ran. Opening a past watched run replays its saved stream. The leaderboard looks again every few seconds while it is on
  screen, so entries recorded from outside the page (a contest in a terminal) appear without a click. Every row has
  **Test in Studio**, which opens that entry in Studio with its scene, the world counts it was timed at and the steps filled in (it
  is not only for wins: an entry that lost can be watched too; nothing runs until you press Run comparison), and **View in Build**,
  which puts its graph in the editor and, if it is an agent's code, its source in the kernel pane (saved as a kernel of yours,
  `entry-...`).
- **Research**: what an agent run by [phost-agent](https://github.com/cdevingo-bd/phost-agent) has done on this machine, read from
  its journal in the state directory: where proposals stopped (a funnel from *proposed* to *a win*), how many were answered from the
  memo without running anything, the device time and tokens spent, the latest attempts and finished searches, who holds each device,
  and whether the journal's hash chain is intact. If a contest has been started with `phost-agent arena`, an **Arena** panel leads
  the page: who is in it and what each has done, every check posted (passed or failed, and why), and every entry. A contest with
  no end recorded shows as running, or as quiet once nothing has been written for ten minutes. Each entry and each check has the same
  two buttons, so a check that was never timed can be opened and tried too. It only reads: start a search with
  `phost-agent run`. Needs `pip install phost-agent`
  (`phost-dash[research]`) and says so when it is missing.
- **Guide**: what the words mean and what the numbers are worth.

The built-in scenes are eleven MuJoCo ones (trampolines of three sizes, an arm, and the tank below), two NumPy chains and one
JAX chain; `--scene-dir` and `--plugin` add your own. The one the page opens on is `tank:boat`: a glass tank that shuttles
side to side, a boat with a cloth sail and three crates on its deck. **The water is 150 frictionless spheres, not a fluid.** MuJoCo has no fluid solver; the boat floats because
spheres hold it up, not because of buoyancy. It is there to be a busy scene that mixes contact, a flexible body and
free bodies, not to be water. (It has nv=622, which is beyond the coupled-block solver's range of 512, so that
solver refuses it and says so. The trampoline scenes are the ones to time it on.)

## Where it runs

The server listens on `127.0.0.1` only and refuses requests whose `Host` is anything else. It never opens a CUDA
context itself: every run happens in a separate worker process, one at a time so timings are not disturbed by another
job. Cancelling or timing out kills the worker's whole process group. State (graphs, kernels, jobs, the ledger) is in
`--state`, default `$XDG_DATA_HOME/phost`.

```
phost-dash --port 8765 --state ./dash-state --no-browser
phost-dash --plugin my_stages --scene-dir ./my-scenes      # your own stages and scenes
```

## What it does and does not protect

- Other web pages cannot drive it: state-changing requests need the cookie, a same-origin request, and a JSON content
  type, and the page is served with a strict content security policy (no inline script, nothing from another origin).
- Your kernel source is compiled and run only in the sandboxed worker. It is never executed in the server process.
- A scene marked `hidden` is never drawn and never streamed, and its description is not listed.
- **The sandbox does not make a verdict trustworthy.** A kernel's check is computed inside the kernel's own process, so
  a determined author could report anything. Every ledger entry from this dashboard is marked `self-reported`: it was
  measured here, by whoever pressed the button, and nothing has checked it independently. The ledger's hash chain
  catches accidents (a truncated or edited file); it does not stop someone who rewrites the whole file.
- Timings are comparable only on a quiet device. The header shows how many other processes are using the GPU, and a run is
  flagged unreliable if the two native timings disagree or the GPU was shared.

## Tests

```
pip install -e '.[test]'
pytest                      # ~290 tests with a fake runner: security, stores, jobs, HTTP, and the page itself
pytest tests/test_real_gpu.py   # the same over real GPU runs (skipped without CUDA)
```

`tests/test_browser.py` loads the page in headless Chrome or Chromium and drives it (skipped where there is none).
