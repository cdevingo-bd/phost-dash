// Small reusable pieces, so every screen is made of the same parts.

import { h, clear } from "./dom.js";
import { icon } from "./icons.js";

export function pill(text, tone = "", iconName = null, title = "") {
  return h("span", { class: `pill ${tone}`, title }, iconName ? icon(iconName, 13) : null, text);
}

export function segmented({ options, value, onChange, label }) {
  const root = h("div", { class: "seg", role: "group", "aria-label": label });
  const buttons = options.map((o) => h("button", { type: "button", "data-value": o.value, title: o.title || "",
    "aria-pressed": String(o.value === value), onclick: () => { set(o.value); onChange(o.value); } },
    o.icon ? icon(o.icon, 15) : null, o.label));
  const set = (v) => buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === String(v))));
  root.append(...buttons);
  root.set = set;
  return root;
}

// A headline number with a label: the unit of the results panels
export function tile({ label, value, unit = "", tone = "", note = "", title = "" }) {
  return h("div", { class: `tile ${tone}`, title },
    h("div", { class: "tile-label" }, label),
    h("div", { class: "tile-value" }, value, unit ? h("span", { class: "tile-unit" }, unit) : null),
    note ? h("div", { class: "tile-note" }, note) : null);
}

export function empty({ iconName = "info", title, text, action = null }) {
  return h("div", { class: "empty-state" }, h("div", { class: "empty-icon" }, icon(iconName, 26)),
    h("h3", {}, title), text ? h("p", {}, text) : null, action);
}

export function field(label, control, hint = "") {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control,
    hint ? h("span", { class: "field-hint" }, hint) : null);
}

export function button(text, { kind = "", iconName = null, onclick, title = "", disabled = false, test = null } = {}) {
  return h("button", { class: `btn ${kind}`, type: "button", onclick, title, disabled, "data-test": test },
    iconName ? icon(iconName, 16) : null, text);
}

export function iconButton(iconName, { title, onclick, kind = "" }) {
  return h("button", { class: `icon-btn ${kind}`, type: "button", title, "aria-label": title, onclick }, icon(iconName, 18));
}

export function bar(fraction) {
  const fill = h("div", { class: "bar-fill" });
  const root = h("div", { class: "bar", role: "progressbar" }, fill);
  root.set = (f) => { fill.style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`; };
  root.set(fraction);
  return root;
}
