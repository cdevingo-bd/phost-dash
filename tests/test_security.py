import pytest

from phost_dash.security import Guard

PORT = 8123
GOOD = {"Host": f"127.0.0.1:{PORT}", "Content-Type": "application/json"}


@pytest.fixture
def guard():
    return Guard(PORT, token="secret-token")


def with_cookie(guard, **headers):
    return {**GOOD, "Cookie": f"{guard.cookie}={guard.token}", **headers}


def test_a_request_with_the_cookie_passes(guard):
    assert guard.refusal("POST", with_cookie(guard)) is None and guard.refusal("GET", with_cookie(guard)) is None


def test_the_token_header_is_an_alternative_to_the_cookie(guard):
    assert guard.refusal("GET", {**GOOD, "X-Phost-Token": "secret-token"}) is None
    assert guard.refusal("GET", {**GOOD, "x-phost-token": "wrong"})[0] == 401


@pytest.mark.parametrize("cookie", [None, "", "phost_token_8123=wrong", "other=secret-token", "garbage;;;",
                                    "phost_token_9999=secret-token"])
def test_a_missing_or_wrong_token_is_refused(guard, cookie):
    headers = dict(GOOD) if cookie is None else {**GOOD, "Cookie": cookie}
    status, reason = guard.refusal("GET", headers)
    assert status == 401 and "token" in reason


@pytest.mark.parametrize("host", ["evil.example", "evil.example:8123", "127.0.0.1", "127.0.0.1:9999", "0.0.0.0:8123",
                                  "127.0.0.1:8123.evil.example", "[::1]:8123", None])
def test_a_host_that_is_not_this_server_is_refused_even_with_the_token(guard, host):
    headers = with_cookie(guard)
    headers.pop("Host")
    if host:
        headers["Host"] = host
    assert guard.refusal("GET", headers)[0] == 421


def test_localhost_by_name_is_accepted(guard):
    assert guard.refusal("GET", with_cookie(guard, Host=f"localhost:{PORT}")) is None


def test_the_query_handoff_replaces_the_cookie_but_not_the_host_check(guard):
    assert guard.refusal("GET", GOOD, authenticated_by_query=True) is None
    assert guard.refusal("GET", {**GOOD, "Host": "evil.example"}, authenticated_by_query=True)[0] == 421


@pytest.mark.parametrize("origin", ["http://evil.example", "http://127.0.0.1:9999", "https://127.0.0.1:8123", "null"])
def test_a_cross_origin_change_is_refused(guard, origin):
    assert guard.refusal("POST", with_cookie(guard, Origin=origin))[0] == 403


def test_the_same_origin_may_change_state(guard):
    assert guard.refusal("POST", with_cookie(guard, Origin=f"http://127.0.0.1:{PORT}")) is None
    assert guard.refusal("DELETE", with_cookie(guard, Origin=f"http://localhost:{PORT}")) is None


@pytest.mark.parametrize("site", ["cross-site", "same-site"])
def test_a_browser_saying_the_request_is_cross_site_is_refused(guard, site):
    assert guard.refusal("PUT", with_cookie(guard, **{"Sec-Fetch-Site": site}))[0] == 403


def test_same_origin_and_user_initiated_fetches_pass(guard):
    for site in ("same-origin", "none"):
        assert guard.refusal("POST", with_cookie(guard, **{"Sec-Fetch-Site": site})) is None


@pytest.mark.parametrize("content_type", [None, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data"])
def test_state_changes_need_a_json_content_type(guard, content_type):
    headers = with_cookie(guard)
    headers.pop("Content-Type")
    if content_type:
        headers["Content-Type"] = content_type
    assert guard.refusal("POST", headers)[0] == 415


def test_a_json_content_type_may_carry_a_charset(guard):
    assert guard.refusal("POST", with_cookie(guard, **{"Content-Type": "application/json; charset=utf-8"})) is None


def test_reads_do_not_need_a_content_type_or_origin(guard):
    headers = with_cookie(guard, Origin="http://evil.example")
    headers.pop("Content-Type")
    assert guard.refusal("GET", headers) is None          # reading is protected by the token and the host, not the origin


def test_each_launch_and_port_has_its_own_secret_and_cookie_name():
    a, b = Guard(1000), Guard(1001)
    assert a.token != b.token and len(a.token) >= 40 and a.cookie != b.cookie


def test_the_cookie_cannot_be_read_by_scripts_or_sent_cross_site(guard):
    cookie = guard.set_cookie()
    assert "HttpOnly" in cookie and "SameSite=Strict" in cookie and guard.token in cookie


def test_the_printed_address_carries_the_token(guard):
    assert guard.url() == f"http://127.0.0.1:{PORT}/?token=secret-token"
    assert guard.token_ok("secret-token") and not guard.token_ok("secret-token ") and not guard.token_ok(None) and not guard.token_ok("")
