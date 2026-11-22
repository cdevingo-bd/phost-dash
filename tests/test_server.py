"""The real server on a real loopback socket (with a fake runner in place of the lab)."""

import http.client
import json
import socket

import pytest

from conftest import NATIVE_GRAPH, TOKEN, Client, wait_for

RUN = dict(graph=NATIVE_GRAPH, scene="trampoline8:impact", worlds=[1, 8], steps=10)


def test_it_listens_on_loopback_only(dash):
    assert dash.server_address[0] == "127.0.0.1"


def test_the_printed_address_logs_in_once_then_hides_the_token(dash):
    anonymous = Client(dash, authenticated=False)
    response, _ = anonymous.request("GET", f"/?token={TOKEN}")
    assert response.status == 302 and response.getheader("Location") == "/"
    cookie = response.getheader("Set-Cookie")
    assert TOKEN in cookie and "HttpOnly" in cookie and "SameSite=Strict" in cookie
    assert TOKEN not in response.getheader("Location")
    page, body = anonymous.request("GET", "/", headers={"Cookie": cookie.split(";")[0]})
    assert page.status == 200 and b"<title>" in body


def test_a_wrong_token_in_the_address_gets_nothing(dash):
    response, _ = Client(dash, authenticated=False).request("GET", "/?token=wrong")
    assert response.status == 401 and response.getheader("Set-Cookie") is None


@pytest.mark.parametrize("path", ["/", "/api/info", "/api/catalog", "/api/jobs", "/static/app.js"])
def test_nothing_is_served_without_the_token(dash, path):
    response, body = Client(dash, authenticated=False).request("GET", path)
    assert response.status == 401 and b"token" in body


def test_a_page_pretending_to_be_another_host_is_refused_even_with_the_cookie(client):
    response, _ = client.request("GET", "/api/info", host="evil.example")
    assert response.status == 421


def test_a_cross_origin_post_is_refused_before_it_runs_anything(client, runners):
    response, _ = client.request("POST", "/api/jobs/run", RUN, headers={"Origin": "http://evil.example"})
    assert response.status == 403 and runners.calls == []
    response, _ = client.request("POST", "/api/jobs/run", RUN, headers={"Sec-Fetch-Site": "cross-site"})
    assert response.status == 403 and runners.calls == []


def test_a_form_post_cannot_start_a_run(client, runners):
    response, _ = client.request("POST", "/api/jobs/run", raw=b"scene=x", headers={"Content-Type": "application/x-www-form-urlencoded"})
    assert response.status == 415 and runners.calls == []


def test_bad_bodies_are_400_413_411(client):
    assert client.request("POST", "/api/validate", raw=b"{not json", headers={"Content-Type": "application/json"})[0].status == 400
    assert client.request("POST", "/api/validate", raw=b"[1]", headers={"Content-Type": "application/json"})[0].status == 400
    assert client.request("POST", "/api/validate", raw=b"\xff\xfe", headers={"Content-Type": "application/json"})[0].status == 400
    huge = b'{"x": "' + b"a" * (1 << 20) + b'"}'
    assert client.request("POST", "/api/validate", raw=huge, headers={"Content-Type": "application/json"})[0].status == 413
    conn = http.client.HTTPConnection("127.0.0.1", client.port, timeout=5)
    conn.putrequest("POST", "/api/validate", skip_host=True)
    for k, v in {"Host": f"127.0.0.1:{client.port}", "Cookie": client.cookie, "Content-Type": "application/json"}.items():
        conn.putheader(k, v)
    conn.endheaders()
    assert conn.getresponse().status == 411
    conn.close()


def test_unknown_endpoints_and_wrong_methods(client):
    assert client.get("/api/nope")[0] == 404
    status, body = client.json("DELETE", "/api/info")
    assert status == 405 and "not allowed" in body["error"]
    assert client.post("/api/info")[0] == 405


def test_static_files_come_with_a_strict_content_security_policy(client):
    response, _ = client.request("GET", "/")
    csp = response.getheader("Content-Security-Policy")
    assert "default-src 'none'" in csp and "script-src 'self'" in csp and "frame-ancestors 'none'" in csp
    assert response.getheader("X-Content-Type-Options") == "nosniff" and response.getheader("X-Frame-Options") == "DENY"


@pytest.mark.parametrize("path", ["/static/../app.py", "/static/%2e%2e/app.py", "/static/..%2fapp.py", "/static/nope.js",
                                  "/static/", "/static//etc/passwd", "/../etc/passwd", "/static/index.html/../../app.py"])
def test_static_paths_cannot_leave_the_static_folder(client, path):
    response, body = client.request("GET", path)
    assert response.status == 404 and b"import" not in body and b"root:" not in body


def test_json_answers_are_not_cached(client):
    response, _ = client.request("GET", "/api/info")
    assert response.getheader("Cache-Control") == "no-store" and response.getheader("Content-Type") == "application/json"


def test_info_and_catalog_over_http(client):
    status, info = client.get("/api/info")
    assert status == 200 and info["gpu"]["name"] == "Fake GPU"
    status, catalog = client.get("/api/catalog")
    assert status == 200 and catalog["scenes"] and catalog["registry"]["contracts"]


def test_graphs_over_http(client):
    assert client.json("PUT", "/api/graphs/mine", NATIVE_GRAPH) == (200, dict(name="mine"))
    assert client.get("/api/graphs") == (200, ["mine"])
    assert client.get("/api/graphs/mine") == (200, NATIVE_GRAPH)
    assert client.json("PUT", "/api/graphs/bad", dict(NATIVE_GRAPH, stages={"x": dict(impl="y", params={})}))[0] == 400
    assert client.json("PUT", "/api/graphs/..%2fescape", NATIVE_GRAPH)[0] in (400, 404)
    assert client.json("DELETE", "/api/graphs/mine")[0] == 200 and client.get("/api/graphs/mine")[0] == 404


def test_a_run_from_start_to_record_to_board_over_http(client):
    status, job = client.post("/api/jobs/run", RUN)
    assert status == 200 and job["status"] in ("queued", "running", "done")
    done = wait_for(lambda: (j := client.get(f"/api/jobs/{job['id']}")[1])["status"] == "done" and j, message="the run")
    assert done["result"]["cells"][0]["worlds"] == 1
    assert client.get("/api/jobs")[1][0]["id"] == job["id"]
    status, recorded = client.post(f"/api/jobs/{job['id']}/record", dict(label="over-http"))
    assert status == 200 and [r["seq"] for r in recorded["records"]] == [1, 2]
    assert client.post(f"/api/jobs/{job['id']}/record", {})[0] == 409
    status, board = client.get("/api/board?worlds=8")
    assert status == 200 and board["groups"][0]["rows"][0]["label"] == "over-http" and board["ledger"]["ok"]
    assert client.get("/api/ledger")[1]["count"] == 2


def sse(client, job_id):
    conn = http.client.HTTPConnection("127.0.0.1", client.port, timeout=20)
    conn.request("GET", f"/api/jobs/{job_id}/events", headers={"Host": f"127.0.0.1:{client.port}", "Cookie": client.cookie})
    response = conn.getresponse()
    events = []
    while True:
        line = response.readline()
        if not line:
            break
        if line.startswith(b"data: "):
            events.append(json.loads(line[6:]))
    conn.close()
    return response, events


def test_events_stream_a_runs_progress_and_end(client):
    _, job = client.post("/api/jobs/run", RUN)
    response, events = sse(client, job["id"])
    assert response.status == 200 and response.getheader("Content-Type") == "text/event-stream"
    assert [e["event"] for e in events] == ["start", "cell", "cell", "end"] and events[-1]["status"] == "done"
    _, again = sse(client, job["id"])
    assert [e["event"] for e in again] == ["start", "cell", "cell", "end"]             # a late page sees it all


def test_events_for_an_unknown_job_are_a_404_not_a_broken_stream(client):
    response, _ = client.request("GET", "/api/jobs/" + "0" * 12 + "/events")
    assert response.status == 404
    assert client.request("GET", "/api/jobs/not-an-id/events")[0].status == 404


def test_a_running_job_can_be_cancelled_over_http_and_the_stream_ends(client, runners):
    runners.hold.clear()
    _, job = client.post("/api/jobs/run", RUN)
    wait_for(lambda: runners.running == 1, message="the run to start")
    assert client.post(f"/api/jobs/{job['id']}/cancel")[0] == 200
    _, events = sse(client, job["id"])
    assert events[-1]["event"] == "end" and events[-1]["status"] == "cancelled"


def test_frames_are_served_as_png_only_for_real_files(client, dash):
    _, job = client.post("/api/jobs/run", RUN)
    wait_for(lambda: client.get(f"/api/jobs/{job['id']}")[1]["status"] == "done", message="the run")
    assert client.request("GET", f"/api/jobs/{job['id']}/frames/0.png")[0].status == 404
    folder = dash.app.store.job_dir(job["id"]) / "frames"
    folder.mkdir(parents=True)
    (folder / "0.png").write_bytes(b"\x89PNG-fake")
    response, body = client.request("GET", f"/api/jobs/{job['id']}/frames/0.png")
    assert response.status == 200 and response.getheader("Content-Type") == "image/png" and body == b"\x89PNG-fake"
    assert client.request("GET", f"/api/jobs/{job['id']}/frames/../../x.png")[0].status == 404


def test_a_bug_in_a_handler_is_a_500_and_the_server_keeps_answering(client, dash, monkeypatch, capsys):
    monkeypatch.setattr(dash.app, "info", lambda: 1 / 0)
    status, body = client.get("/api/info")
    assert status == 500 and "ZeroDivisionError" in body["error"] and "Traceback" not in json.dumps(body)
    monkeypatch.undo()
    assert client.get("/api/ledger")[0] == 200


def test_a_client_that_hangs_up_mid_request_does_not_hurt_the_server(client, dash, capfd):
    sock = socket.create_connection(("127.0.0.1", client.port), timeout=5)
    sock.sendall(f"POST /api/validate HTTP/1.1\r\nHost: 127.0.0.1:{client.port}\r\nCookie: {client.cookie}\r\n"
                 "Content-Type: application/json\r\nContent-Length: 500\r\n\r\n{".encode())
    sock.close()
    import time
    time.sleep(0.3)
    assert client.get("/api/ledger")[0] == 200
    assert "Exception" not in capfd.readouterr().err               # no traceback noise from a client that left


def test_a_client_that_hangs_up_during_an_event_stream_is_not_an_error(client, runners, capfd):
    runners.hold.clear()
    _, job = client.post("/api/jobs/run", RUN)
    wait_for(lambda: runners.running == 1, message="the run to start")
    sock = socket.create_connection(("127.0.0.1", client.port), timeout=5)
    sock.sendall(f"GET /api/jobs/{job['id']}/events HTTP/1.1\r\nHost: 127.0.0.1:{client.port}\r\nCookie: {client.cookie}\r\n\r\n".encode())
    assert b"200" in sock.recv(200)
    sock.close()
    runners.hold.set()
    wait_for(lambda: client.get(f"/api/jobs/{job['id']}")[1]["status"] == "done", message="the run to finish")
    import time
    time.sleep(0.3)
    assert "Exception" not in capfd.readouterr().err


def test_the_server_never_uses_the_gpu_itself(client):
    """Listing the catalog loads every plugin in the server process; none of it may open a CUDA context, because a
    context of its own would take GPU memory and could disturb the timings the dashboard exists to show."""
    import subprocess
    import os
    client.get("/api/catalog")
    try:
        pids = subprocess.run(["nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader"], capture_output=True,
                              text=True, timeout=10, check=True).stdout.split()
    except (OSError, subprocess.SubprocessError):
        pytest.skip("no nvidia-smi")
    assert str(os.getpid()) not in pids
