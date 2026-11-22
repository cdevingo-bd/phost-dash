# phost-dash

A dashboard for [phost](../phost) that runs on your own machine and your own GPU. Build a graph (which implementation
sits on which stage of the simulation step), watch it run next to native, time it, and rank the results.

```
pip install phost phost-lab phost-score phost-dash   # plus phost-author for the Author tab
phost-dash
```

It prints an address and opens it in your browser. The address carries a one-time key; the server turns it into a
cookie and drops it from the address bar. Nothing is served without it. The dashboard needs `mujoco`, `mujoco-warp`
and a CUDA GPU to run anything.

## What is in it

- **Live**: the same scene is run twice from the same settled state, native on the left and your graph on the right,
  drawn as it is computed. A third copy, native again, is stepped alongside as a yardstick: the GPU is not bitwise
  repeatable, so "how far is the graph from native" only means something next to "how far is native from itself". Drag
  to orbit, scrub or play back, and click the chart to jump. A separate **timed comparison** (with nothing streaming,
  so the timing is clean) gives step time, speedup and accuracy per world count, with the checks that passed, and
  records the result to the ledger.
- **Graph**: the host and one node per stage, each with its swap class, its ports, an implementation choice and its
  parameters. The graph is JSON; saved graphs are files.
- **Author**: type an equation and see the curve before any simulation, or write a kernel and check it in a sandbox.
  Either becomes a node.
- **Board**: recorded runs, grouped so only like is compared with like, with the Pareto front marked and the trust
  level of every row. A row can be re-run here and compared with what was recorded.
- **Jobs**: everything that ran. Watching a job again replays its saved stream.

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
pytest                      # ~200 tests with a fake runner: security, stores, jobs, HTTP, and the page itself
pytest tests/test_real_gpu.py   # the same over real GPU runs (skipped without CUDA)
```

`tests/test_browser.py` loads the page in headless Chrome or Chromium and drives it (skipped where there is none).
