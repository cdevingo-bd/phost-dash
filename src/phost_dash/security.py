"""Who may talk to the dashboard.

The server listens on 127.0.0.1 only, but that is not enough on its own: any program on the machine can connect to a
loopback port, and any web page you have open can make your browser send requests to it. So every request must pass:

- **Host**: it names this server (``127.0.0.1:<port>`` or ``localhost:<port>``). A page on another origin that has
  re-pointed its DNS name at 127.0.0.1 sends its own name here, and is refused.
- **Token**: a random secret made at launch, handed to the browser once in the URL the server prints, then kept in a
  cookie the page's scripts cannot read. A program that never saw the URL does not have it.
- **For anything that changes state**: an ``Origin`` (when sent) equal to this server, a ``Sec-Fetch-Site`` that is not
  cross-site, and a JSON content type. A form on another site cannot send that.

What this does not defend against: a program running as you can read the token from the browser's profile or the
process list. The dashboard runs the graphs and code you give it on your machine, as you.
"""

from __future__ import annotations

import hmac
import secrets
from http.cookies import SimpleCookie
from typing import Mapping

SAFE_METHODS = ("GET", "HEAD")


def _header(headers: Mapping[str, str], name: str) -> str | None:
    for key in headers:
        if key.lower() == name:
            return headers[key]
    return None


class Guard:
    def __init__(self, port: int, token: str | None = None):
        self.port = port
        self.token = token or secrets.token_urlsafe(32)
        self.hosts = frozenset({f"127.0.0.1:{port}", f"localhost:{port}"})
        self.cookie = f"phost_token_{port}"            # cookies are shared across ports, so the name carries it

    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/?token={self.token}"

    def token_ok(self, candidate: str | None) -> bool:
        return bool(candidate) and hmac.compare_digest(candidate.encode(), self.token.encode())

    def set_cookie(self) -> str:
        return f"{self.cookie}={self.token}; Path=/; HttpOnly; SameSite=Strict"

    def authorized(self, headers: Mapping[str, str]) -> bool:
        if self.token_ok(_header(headers, "x-phost-token")):
            return True
        raw = _header(headers, "cookie")
        if not raw:
            return False
        try:
            jar = SimpleCookie(raw)
        except Exception:
            return False
        morsel = jar.get(self.cookie)
        return morsel is not None and self.token_ok(morsel.value)

    def refusal(self, method: str, headers: Mapping[str, str], *, authenticated_by_query: bool = False
                ) -> tuple[int, str] | None:
        """``(status, reason)`` if the request must be refused, else None."""
        if _header(headers, "host") not in self.hosts:
            return 421, "this server answers only to 127.0.0.1 and localhost on its own port"
        if not (authenticated_by_query or self.authorized(headers)):
            return 401, "missing or wrong token: open the URL phost-dash printed"
        if method in SAFE_METHODS:
            return None
        origin = _header(headers, "origin")
        if origin is not None and origin not in {f"http://{h}" for h in self.hosts}:
            return 403, "cross-origin request refused"
        if _header(headers, "sec-fetch-site") not in (None, "same-origin", "none"):
            return 403, "cross-site request refused"
        content_type = (_header(headers, "content-type") or "").split(";")[0].strip().lower()
        if content_type != "application/json":
            return 415, "send application/json"
        return None
