// A small icon set: one path string per icon on a 24-unit grid, drawn as strokes in the current text colour.

import { s } from "./dom.js";

const FILLED = new Set(["play", "pause", "stop"]);
const PATHS = {
  play: "M7 4.5v15l13-7.5z",
  pause: "M7 5h3.5v14H7z M13.5 5H17v14h-3.5z",
  stop: "M6 6h12v12H6z",
  flask: "M9 3h6 M10 3v6l-5.5 9.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3 M7.5 15h9",
  layers: "M12 3 3 8l9 5 9-5-9-5z M3 12.5l9 5 9-5 M3 17l9 5 9-5",
  trophy: "M8 21h8 M12 17v4 M7 4h10v5a5 5 0 0 1-10 0V4z M7 6H4v1a3 3 0 0 0 3 3 M17 6h3v1a3 3 0 0 1-3 3",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7 M12 17h.01",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  monitor: "M3 5h18v11H3z M8 21h8 M12 16v5",
  chip: "M7 7h10v10H7z M9 3v4 M15 3v4 M9 17v4 M15 17v4 M3 9h4 M3 15h4 M17 9h4 M17 15h4",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2",
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6 6l12 12 M18 6L6 18",
  alert: "M12 3 2 20h20L12 3z M12 10v4 M12 17h.01",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v5 M12 8h.01",
  plus: "M12 5v14 M5 12h14",
  trash: "M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6",
  save: "M5 3h11l3 3v15H5z M8 3v6h8V3 M8 21v-7h8v7",
  code: "M8 8l-5 4 5 4 M16 8l5 4-5 4 M14 5l-4 14",
  fx: "M10 4C8 4 8 6 8 8v8c0 2 0 4-2 4 M5 11h6 M13 12l6 8 M19 12l-6 8",
  cube: "M12 2l9 5v10l-9 5-9-5V7l9-5z M12 12l9-5 M12 12v10 M12 12L3 7",
  right: "M9 6l6 6-6 6",
  down: "M6 9l6 6 6-6",
  refresh: "M20 11a8 8 0 1 0-1.5 5 M20 4v7h-7",
  bolt: "M13 2 4 14h7l-1 8 9-12h-7l1-8z",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z",
  target: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M3 12h4 M17 12h4 M12 3v4 M12 17v4",
  split: "M3 5h18v14H3z M12 5v14",
  overlay: "M3 7h12v12H3z M9 3h12v12",
  history: "M3 12a9 9 0 1 0 3-6.7 M3 4v5h5 M12 7v5l3 2",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z",
  arrow: "M5 12h14 M13 6l6 6-6 6",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  tool: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.4 2.4-2.6-.6-.6-2.6 2.6-2.2z",
};

export function icon(name, size = 18) {
  const filled = FILLED.has(name);
  const svg = s("svg", { viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": "true", class: "icon",
                         fill: filled ? "currentColor" : "none", stroke: filled ? "none" : "currentColor",
                         "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" });
  for (const d of (PATHS[name] || PATHS.info).split(" M").map((p, i) => (i ? "M" + p : p))) svg.append(s("path", { d }));
  return svg;
}
