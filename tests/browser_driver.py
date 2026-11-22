"""Just enough of the Chrome DevTools protocol to load the dashboard in headless Chrome, click, and read what the page
did. Used only by the browser tests, which are skipped where Chrome or ``websocket-client`` is missing."""

import json
import shutil
import socket
import subprocess
import time
import urllib.request

CHROME = next((p for p in map(shutil.which, ("google-chrome", "chromium", "chromium-browser")) if p), None)


class Page:
    def __init__(self, profile, size=(1300, 900)):
        import websocket
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        self.process = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
                                         f"--window-size={size[0]},{size[1]}", "--no-first-run", "--disable-extensions", "about:blank"],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        target = None
        for _ in range(150):
            try:
                request = urllib.request.Request(f"http://127.0.0.1:{port}/json/new?about:blank", method="PUT")
                target = json.load(urllib.request.urlopen(request))
                break
            except OSError:
                time.sleep(0.2)
        if target is None:
            self.process.kill()
            raise RuntimeError("chrome did not start")
        self.ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=60, suppress_origin=True)
        self.websocket = websocket
        self.counter, self.problems, self.size = 0, [], size
        for method in ("Page.enable", "Runtime.enable", "Log.enable", "Network.enable"):
            self.send(method)
        self.send("Emulation.setDeviceMetricsOverride", width=size[0], height=size[1], deviceScaleFactor=1, mobile=False)

    def send(self, method, **params):
        self.counter += 1
        mine = self.counter
        self.ws.send(json.dumps(dict(id=mine, method=method, params=params)))
        while True:
            message = json.loads(self.ws.recv())
            if message.get("id") == mine:
                if "error" in message:
                    raise RuntimeError(f"{method}: {message['error']}")
                return message.get("result", {})
            self._note(message)

    def _note(self, message):
        method, params = message.get("method"), message.get("params", {})
        if method == "Runtime.exceptionThrown":
            details = params["exceptionDetails"]
            self.problems.append("exception: " + (details.get("exception", {}).get("description") or details.get("text", "")))
        elif method == "Runtime.consoleAPICalled" and params.get("type") in ("error", "warning"):
            self.problems.append(f"console.{params['type']}: " + " ".join(str(a.get("value", a.get("description", ""))) for a in params.get("args", [])))
        elif method == "Log.entryAdded" and params["entry"]["level"] in ("error", "warning"):
            self.problems.append(f"log.{params['entry']['level']}: {params['entry']['text']} {params['entry'].get('url', '')}")
        elif method == "Network.responseReceived" and params["response"]["status"] >= 400:
            self.problems.append(f"http {params['response']['status']}: {params['response']['url']}")

    def pump(self, seconds):
        end = time.time() + seconds
        self.ws.settimeout(0.2)
        while time.time() < end:
            try:
                self._note(json.loads(self.ws.recv()))
            except self.websocket.WebSocketTimeoutException:
                pass
        self.ws.settimeout(60)

    def eval(self, expression):
        result = self.send("Runtime.evaluate", expression=expression, returnByValue=True, awaitPromise=True)
        if "exceptionDetails" in result:
            raise RuntimeError(result["exceptionDetails"].get("exception", {}).get("description", "evaluation failed"))
        return result["result"].get("value")

    def goto(self, url):
        self.send("Page.navigate", url=url)

    def wait(self, expression, timeout=20.0):
        end = time.time() + timeout
        while time.time() < end:
            if self.eval(expression):
                return True
            self.pump(0.2)
        return False

    def click_button(self, tab, text):
        self.eval(f"[...document.querySelectorAll('#tab-{tab} button')].find(b => b.textContent === {text!r}).click()")

    def screenshot(self, path, full=False):
        import base64
        height = self.eval("Math.max(document.documentElement.scrollHeight, 900)") if full else None
        if height:
            self.send("Emulation.setDeviceMetricsOverride", width=self.size[0], height=int(height), deviceScaleFactor=1, mobile=False)
        data = self.send("Page.captureScreenshot", format="png")["data"]
        if height:
            self.send("Emulation.setDeviceMetricsOverride", width=self.size[0], height=self.size[1], deviceScaleFactor=1, mobile=False)
        with open(path, "wb") as out:
            out.write(base64.b64decode(data))

    def set_scheme(self, scheme):
        self.send("Emulation.setEmulatedMedia", features=[dict(name="prefers-color-scheme", value=scheme)])

    def close(self):
        try:
            self.ws.close()
        finally:
            self.process.kill()
            self.process.wait()
