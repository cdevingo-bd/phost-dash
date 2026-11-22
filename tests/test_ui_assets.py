"""The page is plain files. These checks hold the properties its security policy and its honesty rely on."""

import re
from pathlib import Path

import pytest

STATIC = Path(__file__).parents[1] / "src" / "phost_dash" / "static"
SCRIPTS = sorted(STATIC.glob("*.js"))
INDEX = (STATIC / "index.html").read_text(encoding="utf-8")


def test_the_page_has_no_inline_script_and_no_inline_handlers():
    # script-src 'self' would block them, so they would silently do nothing
    assert re.findall(r"<script\b(?![^>]*\bsrc=)", INDEX) == []
    assert re.findall(r"\son[a-z]+\s*=", INDEX) == []


def test_nothing_is_fetched_from_another_origin():
    allowed = {"http://www.w3.org/2000/svg"}                      # an XML namespace name, not a request
    for path in [STATIC / "index.html", STATIC / "style.css", *SCRIPTS]:
        urls = set(re.findall(r"https?://[^\s\"')]+", path.read_text(encoding="utf-8")))
        assert urls <= allowed, (path.name, urls - allowed)


@pytest.mark.parametrize("path", SCRIPTS, ids=lambda p: p.name)
def test_scripts_never_turn_text_into_markup_or_code(path):
    text = path.read_text(encoding="utf-8")
    for banned in (r"\.innerHTML", r"\.outerHTML", r"insertAdjacentHTML", r"document\.write", r"\beval\(", r"new Function\(",
                   r"setTimeout\(\s*[\"'`]", r"dangerouslySet"):
        assert not re.search(banned, text), f"{path.name} uses {banned}"


def test_every_file_the_page_names_exists_and_is_served(client):
    named = set(re.findall(r"""(?:href|src)="/static/([^"]+)""", INDEX))
    for script in SCRIPTS:                                          # modules import each other by relative name
        named |= set(re.findall(r"""from "\./([\w.-]+)\"""", script.read_text(encoding="utf-8")))
    assert {"style.css", "app.js"} <= named
    kinds = {".js": "text/javascript", ".css": "text/css"}
    for name in sorted(named):
        assert (STATIC / name).is_file(), f"{name} is named but missing"
        response, body = client.request("GET", f"/static/{name}")
        assert response.status == 200 and body, name
        assert response.getheader("Content-Type").startswith(kinds[Path(name).suffix]), name


def test_the_page_says_what_its_results_are_worth():
    text = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "self-reported" in text and "nothing has checked them independently" in text
