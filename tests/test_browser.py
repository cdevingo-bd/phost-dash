"""The page in a real browser: it loads without errors, every tab builds, and a watched run draws both worlds.

Skipped where there is no Chrome or Chromium, or no ``websocket-client`` to talk to it."""

import pytest

pytest.importorskip("websocket")
from browser_driver import CHROME, Page

pytestmark = pytest.mark.skipif(CHROME is None, reason="no Chrome or Chromium")

# how many pixels of a canvas differ from the surface colour at its top-left corner
PAINTED = """(selector) => {
  const c = document.querySelector(selector), x = c.getContext('2d'), d = x.getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 4; i < d.length; i += 4) if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) n++;
  return n; }"""


@pytest.fixture
def page(dash, tmp_path):
    page = Page(tmp_path / "chrome")
    page.goto(dash.url)
    assert page.wait("document.querySelectorAll('#tabs button').length === 5 && document.querySelectorAll('#live-scene option').length > 0")
    yield page
    page.close()


def test_every_tab_builds_without_a_script_or_network_error(page):
    for tab in ("graph", "author", "board", "jobs", "live"):
        page.eval(f"document.querySelector('#tab-button-{tab}').click()")
        page.pump(0.4)
        assert page.eval(f"!document.querySelector('#tab-{tab}').hidden && document.querySelector('#tab-{tab}').children.length > 0"), tab
    assert page.problems == []


def test_the_address_token_does_not_stay_in_the_address_bar(page):
    assert "token" not in page.eval("location.href")


def test_a_watched_run_draws_both_worlds_and_plots_the_divergence(page):
    page.eval("(() => { const g = document.querySelector('#live-graph'); g.value = 'native'; g.dispatchEvent(new Event('change')); })()")
    page.click_button("live", "Watch live")
    assert page.wait("document.querySelector('#tab-live .chip').textContent.startsWith('finished')", 30)
    assert page.eval("Number(document.querySelector('#tab-live input[type=range]').max) + 1") == 50     # 300 steps, every 6
    assert page.eval(f"({PAINTED})('#tab-live canvas[aria-label=\"native simulation\"]')") > 200
    assert page.eval(f"({PAINTED})('#tab-live canvas[aria-label=\"graph simulation\"]')") > 200
    assert page.eval("document.querySelectorAll('#tab-live .chart svg path').length") >= 2          # graph and noise floor
    assert "from native" in page.eval("document.querySelectorAll('#tab-live .card')[1].querySelector('p.note').textContent")
    assert page.problems == []


def test_scrubbing_moves_the_time_and_stops_following(page):
    page.eval("(() => { const g = document.querySelector('#live-graph'); g.value = 'native'; g.dispatchEvent(new Event('change')); })()")
    page.click_button("live", "Watch live")
    assert page.wait("document.querySelector('#tab-live .chip').textContent.startsWith('finished')", 30)
    page.eval("(() => { const r = document.querySelector('#tab-live input[type=range]'); r.value = 4; r.dispatchEvent(new Event('input')); })()")
    page.pump(0.3)
    assert page.eval("document.querySelector('#tab-live .time').textContent") == "t = 0.060 s · step 30"
    assert page.eval("document.querySelector('#tab-live input[type=checkbox]').checked") is False


def test_a_failed_run_says_why_on_the_page(page, runners):
    runners.live_error = "ApplicabilityError: nv=622 is outside 1..512"
    page.click_button("live", "Watch live")
    assert page.wait("document.querySelector('#tab-live .chip').textContent === 'failed'", 20)
    assert "outside 1..512" in page.eval("document.querySelector('#tab-live .error').textContent")


def test_the_graph_editor_writes_the_graph_it_shows(page):
    page.eval("document.querySelector('#tab-button-graph').click()")
    page.eval("(() => { const s = document.querySelector('#tab-graph select[aria-label=examples]'); s.value = 'damping'; })()")
    page.click_button("graph", "Use example")
    page.pump(0.5)
    text = page.eval("document.querySelector('#tab-graph pre.json').textContent")
    assert '"dof.passive_force/spring-damper"' in text and '"c": 0.4' in text


def test_a_check_that_does_not_apply_is_not_shown_as_a_failure(page, dash):
    import json
    from conftest import CONTROL_GRAPH
    body = json.dumps(json.dumps(CONTROL_GRAPH))                    # a JS string literal holding the graph's JSON
    status = page.eval(f"fetch('/api/graphs/pd', {{method: 'PUT', headers: {{'Content-Type': 'application/json'}}, body: {body}}}).then(r => r.status)")
    assert status == 200
    page.goto(dash.url)
    assert page.wait("document.querySelector('#live-graph') && [...document.querySelector('#live-graph').options].some(o => o.value === 'saved:pd')")
    page.eval("(() => { const g = document.querySelector('#live-graph'); g.value = 'saved:pd'; g.dispatchEvent(new Event('change')); })()")
    page.click_button("live", "Time it")
    assert page.wait("document.querySelector('#tab-live table') !== null", 20)
    gates = page.eval("[...document.querySelectorAll('#tab-live table .gate')].map(g => g.className + '|' + g.textContent)")
    assert gates == ["gate ok|✓ finite", "gate na|– accuracy n/a", "gate ok|✓ stage"]


def test_a_stored_watch_replays_with_its_own_scene_and_graph(page):
    page.eval("(() => { const g = document.querySelector('#live-graph'); g.value = 'native'; g.dispatchEvent(new Event('change')); })()")
    page.click_button("live", "Watch live")
    assert page.wait("document.querySelector('#tab-live .chip').textContent.startsWith('finished')", 30)
    watched = page.eval("document.querySelector('#live-scene').value")
    other = page.eval("[...document.querySelector('#live-scene').options].map(o => o.value).find(v => v !== document.querySelector('#live-scene').value)")
    page.eval(f"(() => {{ const s = document.querySelector('#live-scene'); s.value = {other!r}; s.dispatchEvent(new Event('change')); }})()")
    page.eval("document.querySelector('#tab-button-jobs').click()")
    assert page.wait("document.querySelectorAll('#tab-jobs tbody tr').length === 1")
    page.eval("document.querySelector('#tab-jobs tbody tr').click()")
    # only the replay selects this option, so waiting for it is waiting for the replay (the chip was already "finished")
    assert page.wait("document.querySelector('#live-graph').selectedOptions[0].textContent === 'replayed: native'")
    assert page.wait("document.querySelector('#tab-live .chip').textContent.startsWith('finished')", 20)
    assert page.eval("document.querySelector('#live-scene').value") == watched                  # the scene it was watched on
    assert watched != other
    assert page.eval("Number(document.querySelector('#tab-live input[type=range]').max) + 1") == 50
    assert page.problems == []


def test_the_board_shows_when_an_entry_was_recorded(page, client, dash):
    import re
    from conftest import CONTROL_GRAPH, finished
    status, job = client.post("/api/jobs/run", dict(graph=CONTROL_GRAPH, scene="trampoline8:impact", worlds=[1], steps=5))
    assert status == 200
    finished(dash.app, job["id"])
    status, out = client.post(f"/api/jobs/{job['id']}/record", dict(label="pd law"))
    assert status == 200 and out["records"][0]["eligible"] is True
    page.eval("document.querySelector('#tab-button-board').click()")
    assert page.wait("document.querySelectorAll('#tab-board tbody tr').length === 1")
    assert page.eval("document.querySelector('#tab-board tbody tr').children[1].childNodes[0].textContent") == "pd law"
    recorded = page.eval("document.querySelector('#tab-board tbody tr td.muted').textContent")
    assert re.fullmatch(r"[A-Za-z]{3,}\.? \d{1,2}, .*\d{1,2}:\d{2}.*", recorded), recorded     # a date, not "Invalid Date"
    assert page.problems == []
