"""The HTTP layer: a thin translation between requests and ``App`` methods. Loopback only, and every request passes the
``Guard`` first."""

from __future__ import annotations

import json
import re
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

from .app import ApiError, App
from .jobs import NoSuchJob
from .security import Guard

STATIC = Path(__file__).parent / "static"
MAX_BODY = 1 << 20
CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml"}
CSP = ("default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
       "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")

# (method, path pattern, handler(app, match, query, body) -> JSON-able)
ROUTES = [
    ("GET", r"/api/info", lambda a, m, q, b: a.info()),
    ("GET", r"/api/catalog", lambda a, m, q, b: a.catalog()),
    ("POST", r"/api/validate", lambda a, m, q, b: a.validate(b)),
    ("GET", r"/api/graphs", lambda a, m, q, b: a.list_graphs()),
    ("GET", r"/api/graphs/([^/]+)", lambda a, m, q, b: a.get_graph(m[1])),
    ("PUT", r"/api/graphs/([^/]+)", lambda a, m, q, b: a.put_graph(m[1], b)),
    ("DELETE", r"/api/graphs/([^/]+)", lambda a, m, q, b: a.delete_graph(m[1])),
    ("GET", r"/api/kernels", lambda a, m, q, b: a.list_kernels()),
    ("GET", r"/api/kernels/([^/]+)", lambda a, m, q, b: a.get_kernel(m[1])),
    ("PUT", r"/api/kernels/([^/]+)", lambda a, m, q, b: a.put_kernel(m[1], b)),
    ("DELETE", r"/api/kernels/([^/]+)", lambda a, m, q, b: a.delete_kernel(m[1])),
    ("GET", r"/api/author/template", lambda a, m, q, b: a.kernel_template()),
    ("POST", r"/api/author/equation", lambda a, m, q, b: a.equation(b)),
    ("POST", r"/api/author/kernel/check", lambda a, m, q, b: a.start_check(b)),
    ("POST", r"/api/jobs/run", lambda a, m, q, b: a.start_run(b)),
    ("POST", r"/api/jobs/live", lambda a, m, q, b: a.start_live(b)),
    ("POST", r"/api/jobs/reverify", lambda a, m, q, b: a.start_reverify(b)),
    ("GET", r"/api/jobs", lambda a, m, q, b: a.list_jobs()),
    ("GET", r"/api/jobs/([0-9a-f]{12})", lambda a, m, q, b: a.get_job(m[1])),
    ("POST", r"/api/jobs/([0-9a-f]{12})/cancel", lambda a, m, q, b: a.cancel(m[1])),
    ("POST", r"/api/jobs/([0-9a-f]{12})/render", lambda a, m, q, b: a.start_render(m[1])),
    ("POST", r"/api/jobs/([0-9a-f]{12})/record", lambda a, m, q, b: a.record(m[1], b)),
    ("GET", r"/api/board", lambda a, m, q, b: a.board(q)),
    ("GET", r"/api/ledger", lambda a, m, q, b: a.ledger_status()),
]
ROUTES = [(method, re.compile(pattern + r"\Z"), handler) for method, pattern, handler in ROUTES]
EVENTS = re.compile(r"/api/jobs/([0-9a-f]{12})/events\Z")
FRAME = re.compile(r"/api/jobs/([0-9a-f]{12})/frames/([0-9]{1,4})\.png\Z")


class Handler(BaseHTTPRequestHandler):
    server_version = "phost-dash"
    protocol_version = "HTTP/1.1"
    timeout = 30                      # a client that stops talking cannot hold a thread forever

    def log_message(self, format, *args):                     # noqa: A002 - signature fixed by the base class
        if self.server.verbose:
            sys.stderr.write("%s %s\n" % (self.command, self.path))

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_PUT(self):
        self._handle("PUT")

    def do_DELETE(self):
        self._handle("DELETE")

    # ---- one request ----

    def _handle(self, method: str) -> None:
        try:
            self._route(method)
        except ApiError as error:
            self._reply(lambda: self._json(error.status, dict(error=error.message)))
        except (ConnectionError, TimeoutError):               # the client went away or stalled: nothing to answer
            self.close_connection = True
        except Exception as error:                            # a bug in a handler: say so, keep the server up
            traceback.print_exc()
            self._reply(lambda: self._json(500, dict(error=f"{type(error).__name__}: {error}")))

    def _reply(self, send) -> None:
        """Send an answer; a client that is already gone is not an error."""
        try:
            send()
        except OSError:
            self.close_connection = True

    def _route(self, method: str) -> None:
        guard, app = self.server.guard, self.server.app
        parts = urlsplit(self.path)
        query = dict(parse_qsl(parts.query, keep_blank_values=True))
        handoff = method == "GET" and parts.path == "/" and guard.token_ok(query.get("token"))
        refusal = guard.refusal(method, self.headers, authenticated_by_query=handoff)
        if refusal:
            return self._text(*refusal)
        if handoff:                                           # keep the token out of the address bar and history
            return self._send(302, b"", headers={"Location": "/", "Set-Cookie": guard.set_cookie()})
        if method == "GET" and not parts.path.startswith("/api/"):
            return self._static(parts.path)
        if method == "GET" and (found := EVENTS.match(parts.path)):
            return self._events(app, found[1])
        if method == "GET" and (found := FRAME.match(parts.path)):
            return self._send(200, app.frame_path(found[1], int(found[2])).read_bytes(),
                              "image/png", {"Cache-Control": "no-store"})
        body = self._body() if method in ("POST", "PUT") else None
        matched = False
        for route_method, pattern, handler in ROUTES:
            found = pattern.match(parts.path)
            if found:
                matched = True
                if route_method == method:
                    return self._json(200, handler(app, found, query, body))
        raise ApiError(405 if matched else 404, "method not allowed" if matched else "no such endpoint")

    def _body(self):
        length = self.headers.get("Content-Length")
        if length is None or not length.isdigit():
            raise ApiError(411, "send a Content-Length")
        if int(length) > MAX_BODY:
            raise ApiError(413, f"requests are limited to {MAX_BODY} bytes")
        raw = self.rfile.read(int(length))
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(400, "the body is not valid JSON") from None
        if not isinstance(body, dict):
            raise ApiError(400, "the body must be a JSON object")
        return body

    # ---- responses ----

    def _send(self, status: int, body: bytes, content_type: str | None = None, headers: dict | None = None) -> None:
        self.send_response(status)
        if content_type:
            self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in {"X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
                            "X-Frame-Options": "DENY", "Cross-Origin-Resource-Policy": "same-origin",
                            **(headers or {})}.items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, value) -> None:
        self._send(status, json.dumps(value, allow_nan=False, default=str).encode(), "application/json",
                   {"Cache-Control": "no-store"})

    def _text(self, status: int, message: str) -> None:
        self._send(status, (message + "\n").encode(), "text/plain; charset=utf-8", {"Cache-Control": "no-store"})

    def _static(self, path: str) -> None:
        name = "index.html" if path == "/" else path.removeprefix("/static/") if path.startswith("/static/") else None
        known = {p.name: p for p in STATIC.iterdir() if p.is_file()} if STATIC.is_dir() else {}
        if name not in known:
            raise ApiError(404, "not found")
        extra = {"Cache-Control": "no-cache"}
        if name == "index.html":
            extra["Content-Security-Policy"] = CSP
        self._send(200, known[name].read_bytes(), CONTENT_TYPES.get(known[name].suffix, "application/octet-stream"), extra)

    def _events(self, app: App, job_id: str) -> None:
        """Server-sent events: the job's whole history, then what happens next, then one ``end`` event."""
        try:
            stream = app.jobs.follow(job_id)
        except NoSuchJob as error:                            # before any header is sent, so it can still be a 404
            raise ApiError(404, str(error)) from None
        self.send_response(200)
        for name, value in {"Content-Type": "text/event-stream", "Cache-Control": "no-store",
                            "Connection": "close", "X-Content-Type-Options": "nosniff"}.items():
            self.send_header(name, value)
        self.end_headers()
        self.close_connection = True
        try:
            for event in stream:
                self.wfile.write(b": keep-alive\n\n" if event is None else f"data: {json.dumps(event)}\n\n".encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


class Dash(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, app: App, port: int = 0, token: str | None = None, verbose: bool = False):
        super().__init__(("127.0.0.1", port), Handler)        # loopback only, never all interfaces
        self.app, self.verbose = app, verbose
        self.guard = Guard(self.server_address[1], token)

    def handle_error(self, request, client_address) -> None:
        if isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            return                                            # a tab was closed or a stream dropped: no traceback for that
        super().handle_error(request, client_address)

    @property
    def url(self) -> str:
        return self.guard.url()

    def shutdown_all(self) -> None:
        self.shutdown()
        self.server_close()
        self.app.close()
