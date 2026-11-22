// Small DOM helpers. Text always goes in as text, never as markup, so nothing a graph, a label or a job returns can
// become script.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key === "value") el.value = value;
    else if (key === "checked" || key === "disabled" || key === "selected" || key === "hidden") el[key] = Boolean(value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

const SVG = "http://www.w3.org/2000/svg";
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value !== null && value !== undefined && value !== false) el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

export const $ = (selector, root = document) => root.querySelector(selector);

export function debounce(fn, ms) {
  let timer = 0;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// Numbers for people: significant figures, switching to exponent form when the size calls for it.
export function num(value, digits = 3) {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  if (!Number.isFinite(value)) return value > 0 ? "∞" : "-∞";
  if (value === 0) return "0";
  const mag = Math.abs(value);
  if (mag >= 1e5 || mag < 1e-3) return value.toExponential(Math.max(0, digits - 1)).replace("e+", "e");
  return Number(value.toPrecision(digits)).toString();
}

export function clock(seconds) {
  return `${seconds.toFixed(3)} s`;
}

// a time as people read it: from epoch seconds (jobs) or an ISO text (ledger entries)
export function when(value) {
  if (value === null || value === undefined || value === "") return "";
  const d = new Date(typeof value === "number" ? value * 1000 : value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function chip(text, kind = "", title = "") {
  return h("span", { class: `chip ${kind}`, title }, h("span", { class: "dot" }), text);
}

// ok is true (passed), false (failed) or null (the check does not apply to this graph, which is not a failure)
export function gate(name, ok) {
  if (ok === null || ok === undefined) {
    return h("span", { class: "gate na", title: `${name}: does not apply to this graph` }, "–", " ", name, " n/a");
  }
  return h("span", { class: `gate ${ok ? "ok" : "bad"}`, title: ok ? `${name}: passed` : `${name}: failed` },
    ok ? "✓" : "✗", " ", name);
}

// One tooltip for the whole page. Put it where the pointer is, kept inside the window.
const tip = () => document.getElementById("tip");
export function showTip(event, rows) {
  const el = tip();
  clear(el, rows.map((row) => h("div", {}, row.swatch ? h("span", { class: `swatch ${row.swatch}`, style: row.color ? { background: row.color } : {} }) : null,
    row.swatch ? " " : null, h("span", { class: "k" }, row.k ? `${row.k} ` : ""), h("b", {}, row.v ?? ""))));
  el.hidden = false;
  const box = el.getBoundingClientRect();
  const x = Math.min(event.clientX + 14, window.innerWidth - box.width - 8);
  const y = Math.min(event.clientY + 14, window.innerHeight - box.height - 8);
  el.style.left = `${Math.max(4, x)}px`;
  el.style.top = `${Math.max(4, y)}px`;
}
export function hideTip() { tip().hidden = true; }

export function section(title, subtitle, ...children) {
  return h("section", { class: "panel" }, h("header", { class: "panel-head" }, h("h2", {}, title), subtitle ? h("p", {}, subtitle) : null), ...children);
}
