# phost-dash

A local browser dashboard for [phost](https://github.com/cdevingo-bd/phost). Build a graph (which implementation sits on which
stage of the simulation step), run it beside native on your own GPU, time it, and rank the results. The dashboard runs no GPU
work itself: [phost-lab](https://github.com/cdevingo-bd/phost-lab)'s workers do.

```
# from clones of phost, phost-coupledchol, phost-lab, phost-author, phost-score and this repo (see the phost README):
pip install -e ../phost -e ../phost-coupledchol -e ../phost-lab -e ../phost-author -e ../phost-score -e .
phost-dash
```

It prints an address and opens it in your browser. The address carries a one-time key; the server turns it into a
cookie and drops it from the address bar. Nothing is served without it. The dashboard needs `mujoco`, `mujoco-warp`
and a CUDA GPU to run anything.

## What is in it

Four screens, in the order you use them:

- **Studio**: pick a scene and an experiment and press *Run comparison*. The same scene is run twice from the same
  settled state, the reference on the left and your experiment on the right (or laid over each other), drawn as it is
  computed. A third copy of the reference is stepped alongside as a yardstick: the GPU is not bitwise repeatable, so
  "how far is the experiment from the reference" only means something next to "how far is the reference from itself".
  Below the view, a plain-language verdict says whether the experiment kept the reference's answer. *Time it* is a
  separate run with nothing streaming, so the timing is clean: it gives step time, speed against the reference and
  accuracy per world count, with the checks that passed, and *Record to leaderboard* keeps it. Drag to orbit, scrub or
  play back, and click the drift chart to jump.
- **Build**: three workspaces. *Choose stages* shows each place in the physics step with the reference or an
  alternative for it, its settings, and what kind of change it is (same answer, close answer, changes the physics,
  read-only). A card above them, *Where a change could pay*, measures on a scene how much of the step each part takes and
  so the most a faster replacement could give, says which parts apply to that scene and why not, and shows the shape of
  the flexible-body matrix. *Type an equation* draws the curve of a force law before any simulation. *Write a kernel* checks your
  code in a sandbox. Each ends as a choice in Studio. An experiment is plain JSON; saved ones are files.
- **Results**: the leaderboard, grouped so only like is compared with like, with the best trade-offs marked and the trust
  level of every row (a row can be re-run here and compared with what was recorded), and a history of everything that
  ran. Opening a past watched run replays its saved stream.
- **Guide**: what the words mean and what the numbers are worth.

The built-in scene is `tank:boat`: a glass tank that shuttles side to side, a boat with a cloth sail and three crates on
its deck. **The water is 150 frictionless spheres, not a fluid.** MuJoCo has no fluid solver; the boat floats because
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
- Timings are comparable only on a quiet GPU. The header shows how many other processes are using it, and a run is
  flagged unreliable if the two native timings disagree or the GPU was shared.

## Tests

```
pip install -e '.[test]'
pytest                      # ~230 tests with a fake runner: security, stores, jobs, HTTP, and the page itself
pytest tests/test_real_gpu.py   # the same over real GPU runs (skipped without CUDA)
```

`tests/test_browser.py` loads the page in headless Chrome or Chromium and drives it (skipped where there is none).
