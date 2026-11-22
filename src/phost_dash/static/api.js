// The dashboard's API. Same origin, so the browser sends the session cookie itself; the token never reaches script.

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function api(method, path, body) {
  const options = { method, headers: {} };
  if (method !== "GET") {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body ?? {});
  }
  let response;
  try {
    response = await fetch(path, options);
  } catch (error) {
    throw new ApiError(0, "cannot reach the dashboard server (is it still running?)");
  }
  let payload = null;
  const text = await response.text();
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    throw new ApiError(response.status, (payload && payload.error) || text.slice(0, 200) || `HTTP ${response.status}`);
  }
  return payload;
}
export const get = (path) => api("GET", path);
export const post = (path, body) => api("POST", path, body);
export const put = (path, body) => api("PUT", path, body);
export const del = (path) => api("DELETE", path, {});

// Follow a job's events: everything so far, then what happens next. The browser reconnects by itself if the stream
// drops, and the server replays from the start, so events already seen (by their number) are skipped.
export function follow(jobId, onEvent) {
  const source = new EventSource(`/api/jobs/${jobId}/events`);
  let last = -1, closed = false;
  const close = () => { closed = true; source.close(); };
  source.onmessage = (message) => {
    let event;
    try { event = JSON.parse(message.data); } catch { return; }
    if (event.event === "end") { onEvent(event); close(); return; }
    if (typeof event.seq === "number") {
      if (event.seq <= last) return;
      last = event.seq;
    }
    onEvent(event);
  };
  source.onerror = () => {
    // a closed source will not retry; a connecting one is the browser's own reconnect
    if (!closed && source.readyState === EventSource.CLOSED) onEvent({ event: "end", status: "failed", error: "the event stream closed" });
  };
  return close;
}
