"""``phost-dash``: start the dashboard on this machine and open it in your browser."""

from __future__ import annotations

import argparse
import sys
import threading
import webbrowser
from pathlib import Path

from phost_score import state_dir

from .app import App, Config
from .server import Dash


def serve(config: Config, *, port: int = 0, token: str | None = None, verbose: bool = False) -> Dash:
    """Build the app and bind the server (nothing is served until ``serve_forever`` or ``serve_in_thread``)."""
    return Dash(App(config), port=port, token=token, verbose=verbose)


def serve_in_thread(dash: Dash) -> threading.Thread:
    thread = threading.Thread(target=dash.serve_forever, name="phost-dash-http", daemon=True)
    thread.start()
    return thread


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="phost-dash", allow_abbrev=False,
                                 description="A local dashboard: edit a graph, run it on this machine's GPU, "
                                             "watch it, and rank the results. Listens on 127.0.0.1 only.")
    ap.add_argument("--port", type=int, default=0, help="port to listen on (default: any free port)")
    ap.add_argument("--state", type=Path, default=None, help=f"where graphs, kernels, jobs and the ledger live (default {state_dir()})")
    ap.add_argument("--plugin", action="append", default=[], help="module exposing register(registry); repeatable")
    ap.add_argument("--scene-module", action="append", default=[], help="module exposing scenes(registry); repeatable")
    ap.add_argument("--scene-dir", action="append", default=[], help="directory of <id>.xml scenes; repeatable")
    ap.add_argument("--timeout", type=float, default=900.0, help="seconds a run may take (default 900)")
    ap.add_argument("--no-browser", action="store_true", help="print the address and do not open a browser")
    ap.add_argument("--verbose", action="store_true", help="log every request")
    args = ap.parse_args(argv)
    config = Config(state=args.state or state_dir(), plugins=tuple(args.plugin), scene_modules=tuple(args.scene_module),
                    scene_dirs=tuple(args.scene_dir), job_timeout=args.timeout)
    try:
        dash = serve(config, port=args.port, verbose=args.verbose)
    except OSError as error:
        print(f"error: cannot listen on 127.0.0.1:{args.port}: {error}", file=sys.stderr)
        return 2
    print(f"phost-dash is running. Open this address (it contains a one-time key; keep it to yourself):\n\n  {dash.url}\n", flush=True)
    print(f"state: {config.state}\nCtrl-C stops it.", flush=True)
    if not args.no_browser:
        webbrowser.open(dash.url)
    try:
        dash.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
    finally:
        dash.shutdown_all()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
