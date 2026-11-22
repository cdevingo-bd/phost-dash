"""The page in a real browser: it loads without errors, every screen builds, and a watched run draws both worlds.

Skipped where there is no Chrome or Chromium, or no ``websocket-client`` to talk to it."""

import json
import re

import pytest

pytest.importorskip("websocket")
from browser_driver import CHROME, Page

pytestmark = pytest.mark.skipif(CHROME is None, reason="no Chrome or Chromium")

# how many pixels of a canvas differ from the surface colour at its top-left corner
PAINTED = """(selector) => {
  const c = document.querySelector(selector), x = c.getContext('2d'), d = x.getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 4; i < d.length; i += 4) if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) n++;
  return n; }"""
STATUS = "document.querySelector('[data-test=status]').textContent"


@pytest.fixture
def page(dash, tmp_path):
    page = Page(tmp_path / "chrome")
    page.goto(dash.url)
    assert page.wait("document.querySelectorAll('#tabs button').length === 5 && document.querySelectorAll('[data-test=scene] option').length > 0")
    yield page
    page.close()


def click(page, selector):
    page.eval(f"document.querySelector({selector!r}).click()")


def choose(page, selector, value):
    page.eval(f"(() => {{ const s = document.querySelector({selector!r}); s.value = {value!r}; s.dispatchEvent(new Event('change')); }})()")


def tab(page, name):
    click(page, f"#tab-button-{name}")
    page.pump(0.3)


def watch(page, experiment="native"):
    choose(page, "[data-test=experiment]", experiment)
    page.pump(0.4)
    click(page, "[data-test=run]")
    assert page.wait(f"{STATUS}.startsWith('Finished')", 30), page.eval(STATUS)


def test_every_screen_builds_without_a_script_or_network_error(page):
    for name in ("build", "results", "research", "guide", "studio"):
        tab(page, name)
        assert page.eval(f"!document.querySelector('#tab-{name}').hidden && document.querySelector('#tab-{name}').children.length > 0"), name
    assert page.problems == []


def test_the_address_token_does_not_stay_in_the_address_bar(page):
    assert "token" not in page.eval("location.href")


def test_a_first_visit_explains_itself_and_stays_dismissed(page, dash):
    assert page.eval("!document.querySelector('[data-test=coach]').hidden")
    assert page.eval("!document.querySelector('[data-test=welcome]').hidden")
    page.eval("document.querySelector('[data-test=coach] button[aria-label=\"Hide this\"]').click()")
    assert page.eval("document.querySelector('[data-test=coach]').hidden")
    page.goto(dash.url)
    assert page.wait("document.querySelector('[data-test=coach]') !== null")
    assert page.eval("document.querySelector('[data-test=coach]').hidden")


def test_a_watched_run_draws_both_worlds_and_plots_the_drift(page):
    watch(page)
    assert page.eval("Number(document.querySelector('[data-test=scrub]').max) + 1") == 50          # 300 steps, every 6
    assert page.eval(f"({PAINTED})('canvas[aria-label=\"reference simulation\"]')") > 200
    assert page.eval(f"({PAINTED})('canvas[aria-label=\"experiment simulation\"]')") > 200
    assert page.eval("document.querySelectorAll('.timeline svg path').length") >= 2                  # experiment and noise
    assert page.eval("document.querySelector('[data-test=welcome]').hidden")
    assert "within noise" in page.eval("document.querySelector('[data-test=verdict] h3').textContent")
    assert page.problems == []


def test_a_change_that_alters_the_physics_is_not_called_a_mismatch(page):
    watch(page, "preset:damping")
    title = page.eval("document.querySelector('[data-test=verdict] h3').textContent")
    assert title == "Differs from the reference, as expected", title


def test_the_chosen_experiment_says_what_kind_of_change_it_is(page):
    choose(page, "[data-test=experiment]", "preset:damping")
    assert page.wait("document.querySelector('.exp-note .pill') !== null")
    assert page.eval("document.querySelector('.exp-note .pill').textContent") == "Changes the physics"
    choose(page, "[data-test=experiment]", "native")
    assert page.wait("document.querySelector('.exp-note .pill') === null")
    assert "Changes nothing" in page.eval("document.querySelector('.exp-note').textContent")


def test_the_example_button_runs_the_damping_example(page):
    click(page, "[data-test=try-example]")
    assert page.wait(f"{STATUS}.startsWith('Finished')", 30)
    assert page.eval("document.querySelector('[data-test=experiment]').value") == "preset:damping"


def test_scrubbing_moves_the_time_and_stops_following(page):
    watch(page)
    page.eval("(() => { const r = document.querySelector('[data-test=scrub]'); r.value = 4; r.dispatchEvent(new Event('input')); })()")
    page.pump(0.3)
    assert page.eval("document.querySelector('[data-test=frame-time]').textContent") == "t = 0.060 s · step 30"
    assert page.eval("document.querySelector('[data-test=follow]').checked") is False


def test_overlay_draws_both_worlds_in_one_view(page):
    watch(page)
    click(page, ".viewer .seg button[data-value=overlay]")
    page.pump(0.4)
    assert page.eval("document.querySelector('.vp.exp').offsetParent === null")
    assert page.eval(f"({PAINTED})('canvas[aria-label=\"reference simulation\"]')") > 200
    click(page, ".viewer .seg button[data-value=side]")
    page.pump(0.3)
    assert page.eval("document.querySelector('.vp.exp').offsetParent !== null")


def test_a_failed_run_says_why_on_the_page(page, runners):
    runners.live_error = "ApplicabilityError: nv=622 is outside 1..512"
    click(page, "[data-test=run]")
    assert page.wait(f"{STATUS} === 'Failed'", 20)
    assert "outside 1..512" in page.eval("document.querySelector('[data-test=error]').textContent")


def test_stopping_a_run_says_it_was_stopped(page, runners):
    runners.hold_live = True
    click(page, "[data-test=run]")
    assert page.wait("!document.querySelector('[data-test=stop]').disabled", 20)
    click(page, "[data-test=stop]")
    assert page.wait(f"{STATUS} === 'Stopped'", 20)
    assert page.eval("document.querySelector('[data-test=run]').disabled") is False


def test_choosing_an_example_in_build_writes_the_experiment_it_shows(page):
    tab(page, "build")
    click(page, "[data-test=example-damping]")
    page.pump(0.5)
    text = page.eval("document.querySelector('#tab-build pre.json').textContent")
    assert '"dof.passive_force/spring-damper"' in text and '"c": 0.4' in text
    assert page.eval("document.querySelector('[data-stage=\"dof.passive_force\"]').dataset.active") == "true"
    assert page.eval("document.querySelector('[data-stage=\"newton.linear_solve\"]').dataset.active") == "false"
    assert page.wait("document.querySelector('[data-test=summary]').textContent.includes('1 change')")
    # the same experiment is now on offer in Studio
    tab(page, "studio")
    assert "1 change" in page.eval("document.querySelector('[data-test=experiment] option[value=editor]').textContent")


def open_equation(page):
    """The Build screen's equation tab. Its editor is made once the stage forms arrive, so wait for it."""
    tab(page, "build")
    click(page, "#tab-build .seg button[data-value=equation]")
    if not page.eval("document.querySelector('[data-test=eq-stage]') !== null"):
        pytest.skip("phost-author is not installed here")
    assert page.wait("document.querySelector('[data-test=equation]') !== null || document.querySelector('[data-test=solver-step]') !== null", 10)


def test_an_equation_is_drawn_as_a_curve_before_any_simulation(page):
    open_equation(page)
    assert page.wait("document.querySelectorAll('#tab-build [data-pane=equation] .chart svg path').length >= 2", 10)
    click(page, "[data-test=eq-use]")
    assert page.wait("document.querySelector('[data-test=eq-added]')?.textContent.includes('Added')")
    tab(page, "build")
    click(page, "#tab-build .seg button[data-value=stages]")
    assert "expression" in page.eval("document.querySelector('#tab-build pre.json').textContent")


def choose_stage(page, stage):
    page.eval(f"(() => {{ const s = document.querySelector('[data-test=eq-stage]'); s.value = '{stage}'; "
              "s.dispatchEvent(new Event('change', { bubbles: true })); })()")


def test_a_wrench_is_typed_one_line_per_output_and_added_to_the_experiment(page):
    open_equation(page)
    choose_stage(page, "body.wrench")
    assert page.wait("document.querySelector('textarea[data-test=equation]') !== null", 10)
    assert page.wait("document.querySelectorAll('#tab-build [data-pane=equation] .chart svg path').length >= 2", 10)
    assert page.eval("document.querySelector('[aria-label=\"output to plot\"]').options.length") == 6
    click(page, "[data-test=eq-use]")
    assert page.wait("document.querySelector('[data-test=eq-added]')?.textContent.includes('Added')")
    click(page, "#tab-build .seg button[data-value=stages]")
    assert page.wait("document.querySelector('#tab-build pre.json').textContent.includes('body.wrench/expression')", 10)


def test_a_probe_lists_its_channels_with_their_values_on_a_sample_state(page):
    open_equation(page)
    choose_stage(page, "probe.state")
    assert page.wait("document.querySelectorAll('[data-test=eq-channels] tbody tr').length === 3", 10)
    page.eval("(() => { const t = document.querySelector('textarea[data-test=equation]'); t.value = 'qvel'; "
              "t.dispatchEvent(new Event('input', { bubbles: true })); })()")
    assert page.wait("document.querySelector('[data-test=eq-note]')?.textContent.includes('array along')", 10)


def test_a_solver_step_is_drawn_as_a_residual_curve_and_says_when_it_reaches_the_tolerance(page):
    open_equation(page)
    choose_stage(page, "newton.linear_solve")
    assert page.wait("document.querySelector('[data-test=solver-step]') !== null", 10)
    assert page.wait("document.querySelector('[data-test=eq-note]')?.textContent.includes('Reaches the tolerance')", 15)
    page.eval("(() => { const t = document.querySelector('[data-test=solver-step]'); t.value = 'x = x + 0.01*(rhs - A@x)/diag'; "
              "t.dispatchEvent(new Event('input', { bubbles: true })); })()")
    assert page.wait("document.querySelector('[data-test=eq-note]')?.textContent.includes('Not at the tolerance')", 15)
    click(page, "[data-test=eq-use]")
    assert page.wait("document.querySelector('[data-test=eq-added]')?.textContent.includes('Added')")


def test_a_kernel_is_loaded_checked_in_the_sandbox_and_reported(page):
    tab(page, "build")
    click(page, "#tab-build .seg button[data-value=kernel]")
    if not page.eval("document.querySelector('[data-test=kernel-template]') !== null"):
        pytest.skip("phost-author is not installed here")
    click(page, "[data-test=kernel-template]")
    assert page.wait("document.querySelector('[data-test=kernel-source]').value.length > 100", 10)
    click(page, "[data-test=kernel-check]")
    assert page.wait("document.querySelector('[data-test=kernel-out]').textContent.includes('Passes the checks')", 20)
    assert "not a certificate" in page.eval("document.querySelector('[data-test=kernel-out]').textContent")
    assert page.problems == []


def test_a_check_that_does_not_apply_is_not_shown_as_a_failure(page, dash):
    from conftest import CONTROL_GRAPH
    body = json.dumps(json.dumps(CONTROL_GRAPH))                    # a JS string literal holding the graph's JSON
    status = page.eval(f"fetch('/api/graphs/pd', {{method: 'PUT', headers: {{'Content-Type': 'application/json'}}, body: {body}}}).then(r => r.status)")
    assert status == 200
    page.goto(dash.url)
    assert page.wait("document.querySelector('[data-test=experiment]') && [...document.querySelector('[data-test=experiment]').options].some(o => o.value === 'saved:pd')")
    choose(page, "[data-test=experiment]", "saved:pd")
    page.pump(0.4)
    click(page, "[data-test=time]")
    assert page.wait("document.querySelector('[data-test=gates]') !== null", 20)
    gates = page.eval("[...document.querySelectorAll('[data-test=gates] .gate')].map(g => g.className + '|' + g.textContent)")
    assert gates == ["gate ok|✓ Stayed finite", "gate na|– Accuracy n/a", "gate ok|✓ Stage limits"]
    assert "not judged" in page.eval("document.querySelector('[data-test=timed]').textContent")


def test_the_opportunity_card_says_how_much_each_stage_could_give_and_why_not(page):
    tab(page, "build")
    click(page, "[data-test=analysis-run]")
    assert page.wait("document.querySelector('[data-test=analysis-table] tbody tr') !== null", 20)
    rows = page.eval("[...document.querySelectorAll('[data-test=analysis-table] tbody tr')].map(r => r.dataset.stage + '|' + r.textContent)")
    text = {r.split("|")[0]: r.split("|")[1] for r in rows}
    assert "1.09×" in text["effective.solve"] and "8%" in text["effective.solve"]
    assert "≤" in text["newton.linear_solve"] and "upper bound" in text["newton.linear_solve"]
    assert "×" not in text["newton.linear_solve"]                # an upper bound is not given as a ceiling
    assert "Not on this scene" in text["control.law"] and "discrete integrator" in text["control.law"]
    assert "nothing to time" in text["probe.state"]
    assert "not what it is for" in text["dof.passive_force"]
    assert "330 × 330" in page.eval("document.querySelector('[data-test=analysis-structure]').textContent")
    assert page.problems == []


def test_the_profile_card_times_each_phase_and_adds_the_experiment_column_only_when_asked(page):
    tab(page, "build")
    assert page.eval("document.querySelector('[data-test=profile-with]').disabled") is True       # no experiment yet
    click(page, "[data-test=profile-run]")
    assert page.wait("document.querySelector('[data-test=profile-table] tbody tr') !== null", 20)
    heads = page.eval("[...document.querySelectorAll('[data-test=profile-table] thead th')].map(t => t.textContent)")
    assert heads == ["Phase", "Reference"]
    rows = page.eval("[...document.querySelectorAll('[data-test=profile-table] tbody tr')].map(r => r.dataset.phase + '|' + r.textContent)")
    assert [r.split("|")[0] for r in rows] == ["kinematics", "crb / armature", "collision", "make_constraint",
                                               "velocity+actuation+accel", "effective", "solver", "integrate", "full"]
    assert "Constraint solver" in rows[6] and "1.83 ms" in rows[6] and "of which the flexible-body solve" in rows[5]
    assert "Whole step" in rows[-1] and "1.70 ms" in rows[-1]
    assert page.problems == []


def test_a_stored_watch_replays_with_its_own_scene_and_graph(page):
    watch(page)
    watched = page.eval("document.querySelector('[data-test=scene]').value")
    other = page.eval("[...document.querySelector('[data-test=scene]').options].map(o => o.value).find(v => v !== document.querySelector('[data-test=scene]').value)")
    choose(page, "[data-test=scene]", other)
    tab(page, "results")
    click(page, "#tab-results .seg button[data-value=history]")
    assert page.wait("document.querySelectorAll('[data-test=jobs] tbody tr').length === 1")
    page.eval("document.querySelector('[data-test=jobs] tbody tr').click()")
    # only the replay selects this option, so waiting for it is waiting for the replay (the status was already "Finished")
    assert page.wait("document.querySelector('[data-test=experiment]').value === 'replay'")
    assert page.wait(f"{STATUS}.startsWith('Finished')", 20)
    assert page.eval("document.querySelector('[data-test=scene]').value") == watched                # the scene it was watched on
    assert watched != other
    assert page.eval("Number(document.querySelector('[data-test=scrub]').max) + 1") == 50
    assert page.eval("!document.querySelector('#tab-studio').hidden")
    assert page.problems == []


def test_the_leaderboard_shows_when_an_entry_was_recorded_and_how_far_to_trust_it(page, client, dash):
    from conftest import CONTROL_GRAPH, finished
    status, job = client.post("/api/jobs/run", dict(graph=CONTROL_GRAPH, scene="trampoline8:impact", worlds=[1], steps=5))
    assert status == 200
    finished(dash.app, job["id"])
    status, out = client.post(f"/api/jobs/{job['id']}/record", dict(label="pd law"))
    assert status == 200 and out["records"][0]["eligible"] is True
    tab(page, "results")
    assert page.wait("document.querySelectorAll('[data-test=board-row]').length === 1")
    assert page.eval("document.querySelector('[data-test=board-row]').children[1].childNodes[0].textContent") == "pd law"
    recorded = page.eval("document.querySelector('[data-test=board-row] td.hint').textContent")
    assert re.fullmatch(r"[A-Za-z]{3,}\.? \d{1,2}, .*\d{1,2}:\d{2}.*", recorded), recorded     # a date, not "Invalid Date"
    row = page.eval("document.querySelector('[data-test=board-row]').textContent")
    assert "Best trade-off" in row and "Self-reported" in row
    assert page.problems == []


def test_the_theme_button_cycles_system_light_dark(page):
    seen = []
    for _ in range(3):
        click(page, "#theme")
        seen.append(page.eval("document.documentElement.getAttribute('data-theme')"))
    assert seen == ["light", "dark", None]


def test_no_screen_scrolls_sideways_on_a_phone_sized_window(page):
    page.send("Emulation.setDeviceMetricsOverride", width=400, height=800, deviceScaleFactor=1, mobile=False)
    page.pump(0.4)
    for name in ("studio", "build", "results", "guide"):
        tab(page, name)
        over = page.eval("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        assert over <= 1, (name, over)


def test_the_research_tab_shows_the_funnel_the_attempts_and_says_when_nothing_has_run(page, config):
    pytest.importorskip("phost_agent")
    tab(page, "research")
    assert "No searches yet" in page.eval("document.querySelector('#tab-research').textContent")
    from test_research import seed
    seed(config.state / "agent" / "journal.jsonl")
    tab(page, "research")
    assert page.wait("document.querySelectorAll('#tab-research [data-test=funnel] tr').length === 6", 10)
    rows = page.eval("[...document.querySelectorAll('#tab-research [data-test=funnel] tr')].map(r => r.children[2].textContent).join(',')")
    assert rows == "4,4,3,2,2,1"
    assert page.eval("document.querySelectorAll('#tab-research [data-test=attempts] tbody tr').length") == 4
    assert "Journal intact" in page.eval("document.querySelector('#tab-research').textContent")
    assert page.problems == []


def test_a_contest_is_on_the_research_tab_and_new_entries_reach_the_results_tab_without_a_click(page, dash, config):
    """`phost-agent arena` writes to the same state while the page is open: Research shows who is in it and what they tried, and the
    leaderboard picks up an entry recorded from outside the page by itself."""
    pytest.importorskip("phost_agent")
    from phost_agent import Journal
    from phost_score import SELF_REPORTED, make_entries
    from conftest import NATIVE_GRAPH, finished
    journal = Journal(config.state / "agent" / "journal.jsonl")
    journal.append("arena", phase="start", task=dict(scene="chain32:pluck", worlds=[1, 8]), budget=dict(turns=60, submits=10, open=True),
                   contestants=[dict(name="opus", model="claude-code:opus"), dict(name="sonnet", model="claude-code:sonnet")])
    graph = dict(stages={"effective.solve": dict(source="class Runtime:\n    pass\n", entry="Runtime", impl="effective.solve/agent-1")})
    journal.append("arena", phase="turn", contestant="opus", turn=1, action="check", tokens=900)
    journal.append("arena", phase="attempt", id="a1b2c3d4", contestant="opus", turn=1, scene="chain32:pluck", action="check", ok=False,
                   digest="d", graph=graph, reasons=[dict(stage="effective.solve", tier="cheap", reason="RuntimeError: PROBE one")])
    journal.append("submission", contestant="sonnet", graph=graph, entry_ids=["e1"], note="a dense solve", speedup=0.247, klass="exact")
    tab(page, "research")
    assert page.wait("document.querySelector('[data-test=arena]') !== null", 10)
    count = lambda selector: page.eval(f"document.querySelectorAll({selector!r}).length")
    assert count("[data-test=contestants] tbody tr") == 2 and count("[data-test=arena-checks] tbody tr") == 1 and count("[data-test=arena-entries] tbody tr") == 1
    assert "PROBE one" in page.eval("document.querySelector('[data-test=arena-checks]').textContent")
    assert "0.247" in page.eval("document.querySelector('[data-test=arena-entries]').textContent")
    tab(page, "results")
    assert page.wait("document.querySelector('[data-test=ledger-summary]').textContent.startsWith('0 records')", 10)
    result = json.loads(json.dumps(finished(dash.app, dash.app.start_run(dict(graph=NATIVE_GRAPH, scene="trampoline8:impact",
                                                                                worlds=[1, 8], steps=10))["id"])["result"]))
    for entry in make_entries(result, label="opus", trust=SELF_REPORTED):
        dash.app.ledger.append(entry.to_dict())
    assert page.wait("document.querySelectorAll('[data-test=board-row]').length >= 1", 9), "the board did not refresh by itself"
    assert "opus" in page.eval("document.querySelector('[data-test=groups]').textContent")
    assert page.problems == []


def test_a_recorded_win_is_offered_in_studio_and_runs_like_your_own_experiment(page, dash):
    """What beat the reference (here, recorded from outside the page, on a scene Studio is not showing) is in the experiment list;
    choosing it moves Studio to the scene it won on, and Run comparison runs it the way a preset does. With nothing recorded the
    list says so instead of leaving a gap."""
    from phost_score import SELF_REPORTED, make_entries
    from conftest import NATIVE_GRAPH, finished
    group = lambda start: f"[...document.querySelectorAll('[data-test=experiment] optgroup')].find(g => g.label.startsWith({start!r}))"
    here, other = group("Beat the reference on this"), group("Beat the reference on other")
    assert page.wait(f"({here}) && ({here}).querySelector('option').disabled", 10)
    assert "none yet" in page.eval(f"({here}).querySelector('option').textContent")
    choose(page, "[data-test=scene]", "chain32:pluck")
    result = json.loads(json.dumps(finished(dash.app, dash.app.start_run(dict(graph=NATIVE_GRAPH, scene="trampoline8:impact",
                                                                                worlds=[1, 8], steps=10))["id"])["result"]))
    result["graph"]["stages"] = {"effective.solve": dict(impl="effective.solve/native", params={})}
    result["stage_classes"] = {"effective.solve": "exact"}
    for entry in make_entries(result, label="opus", trust=SELF_REPORTED):          # the fake lab measures 2x at each world count
        dash.app.ledger.append(entry.to_dict())
    assert page.wait(f"({other}) && ({other}).querySelector('option:not([disabled])') !== null", 12), "the win was not offered"
    assert "none yet on this scene" in page.eval(f"({here}).querySelector('option').textContent")
    text = page.eval(f"({other}).querySelector('option').textContent")
    assert "trampoline8:impact" in text and "opus" in text and "2" in text
    value = page.eval(f"({other}).querySelector('option').value")
    assert value.startswith("win:")
    choose(page, "[data-test=experiment]", value)
    assert page.eval("document.querySelector('[data-test=scene]').value") == "trampoline8:impact", "choosing it did not move to its scene"
    assert page.wait("document.querySelector('.exp-note')?.textContent.includes('recorded by opus')", 10)
    assert "Same answer" in page.eval("document.querySelector('.exp-note').textContent")
    assert page.eval("document.querySelector('[data-test=experiment]').value") == value
    assert page.wait(f"({here}) && ({here}).querySelector('option:not([disabled])') !== null", 5)
    click(page, "[data-test=run]")
    assert page.wait(f"{STATUS}.startsWith('Finished')", 30), page.eval(STATUS)
    choose(page, "[data-test=scene]", "chain32:pluck")                              # a win is only offered as one on its own scene
    assert page.wait("document.querySelector('[data-test=experiment]').value === 'native'", 5)
    assert page.problems == []
