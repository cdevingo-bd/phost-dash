// A small software renderer on a 2D canvas (painter's algorithm). It is for watching a scene move, not a graphics
// engine: spheres, boxes, cylinders, capsules and flex triangles, flat shaded, glass drawn behind and in front.

const PLANE = 0, SPHERE = 2, CAPSULE = 3, ELLIPSOID = 4, CYLINDER = 5, BOX = 6;
const LIGHT = norm([0.35, -0.45, 0.82]);
const BOX_FACES = [  // local axis, sign, the four corner signs of the face (u, v around it)
  [0, 1, [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]], [0, -1, [[-1, -1, -1], [-1, 1, -1], [-1, 1, 1], [-1, -1, 1]]],
  [1, 1, [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]]], [1, -1, [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]],
  [2, 1, [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]], [2, -1, [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1]]],
];
const SIDES = 12;

function norm(v) { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; }
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// One camera, shared by every view, so the two worlds are always seen from the same place.
export class Camera {
  constructor() { this.listeners = new Set(); this.reset(); }
  reset() { this.az = -0.62; this.el = 0.42; this.dist = 1.55; this.target = [0, 0, 0.12]; this.changed(); }
  changed() { for (const fn of this.listeners) fn(); }
  orbit(dx, dy) {
    this.az -= dx * 0.008;
    this.el = Math.max(-0.1, Math.min(1.5, this.el + dy * 0.008));
    this.changed();
  }
  zoom(factor) { this.dist = Math.max(0.4, Math.min(6, this.dist * factor)); this.changed(); }
  basis() {
    const eye = [this.target[0] + this.dist * Math.cos(this.el) * Math.cos(this.az),
                 this.target[1] + this.dist * Math.cos(this.el) * Math.sin(this.az),
                 this.target[2] + this.dist * Math.sin(this.el)];
    const f = norm(sub(this.target, eye));
    const r = norm(cross(f, [0, 0, 1]));
    return { eye, f, r, u: cross(r, f) };
  }
  fit(points) {
    if (!points.length) return;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of points) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    this.target = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    this.dist = Math.max(0.6, 1.75 * Math.max(hi[0] - lo[0], hi[1] - lo[1], (hi[2] - lo[2]) * 1.6));
    this.changed();
  }
}

export class View {
  constructor(canvas, camera) {
    this.canvas = canvas;
    this.camera = camera;
    this.layout = null;
    this.layers = [];                      // [{pose, tint, alpha}]: one for a plain view, two to lay one world over the other
    this.sprites = new Map();
    this.ctx = canvas.getContext("2d");
    camera.listeners.add(() => this.draw());
    new ResizeObserver(() => this.draw()).observe(canvas);
    let drag = null;
    canvas.addEventListener("pointerdown", (e) => { drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      camera.orbit(e.clientX - drag[0], e.clientY - drag[1]);
      drag = [e.clientX, e.clientY];
    });
    const end = () => { drag = null; };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("wheel", (e) => { e.preventDefault(); camera.zoom(Math.exp(e.deltaY * 0.001)); }, { passive: false });
    canvas.addEventListener("dblclick", () => camera.reset());
  }

  setLayout(layout) {
    this.layout = layout;
    this.turnIndex = [];
    let k = 0;
    for (const g of layout.geoms) this.turnIndex.push(g.turns ? k++ : -1);
    this.draw();
  }

  setPose(pose) { this.setLayers(pose ? [{ pose }] : []); }

  setLayers(layers) { this.layers = layers; this.draw(); }

  // geom centres of one pose (planes left out): what to point the camera at
  centres(pose) {
    const out = [];
    this.layout.geoms.forEach((g, i) => { if (g.type !== PLANE) out.push([pose.x[3 * i], pose.x[3 * i + 1], pose.x[3 * i + 2]]); });
    return out;
  }

  colours() {
    const style = getComputedStyle(document.documentElement);
    const read = (name) => style.getPropertyValue(name).trim();
    return { floor: read("--floor"), grid: read("--grid-3d") || read("--grid"), native: read("--native"), custom: read("--custom") };
  }

  draw() {
    const canvas = this.canvas, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const colours = this.colours();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);                              // the page's own gradient is the backdrop
    if (!this.layout || !this.layers.length) return;

    const cam = this.camera.basis();
    const focal = 1.55 * h;
    const project = (p) => {
      const d = sub(p, cam.eye);
      const z = dot(d, cam.f);
      return z > 0.02 ? { x: w / 2 + focal * dot(d, cam.r) / z, y: h / 2 - focal * dot(d, cam.u) / z, z } : null;
    };
    this.drawFloor(ctx, project, colours, w, this.layers[0].pose);

    const items = [];
    for (const layer of this.layers) this.collect(items, layer, cam, project, focal, colours);
    items.sort((a, b) => a.layer - b.layer || b.z - a.z);
    for (const item of items) this.paint(ctx, item);
  }

  // every drawable thing in one world, as flat items to be sorted and painted
  collect(items, layer, cam, project, focal, colours) {
    const { geoms, flexes } = this.layout, pose = layer.pose;
    const tint = layer.tint ? hex(layer.tint === "native" ? colours.native : colours.custom) : null;
    const colour = (rgba) => (tint ? rgba.slice(0, 3).map((v, i) => v * 0.35 + tint[i] * 0.65) : rgba);
    const alpha = layer.alpha ?? 1;
    geoms.forEach((g, i) => {
      if (g.type === PLANE) return;
      const pos = [pose.x[3 * i], pose.x[3 * i + 1], pose.x[3 * i + 2]];
      const k = this.turnIndex[i];
      const R = k >= 0 ? pose.r.slice(9 * k, 9 * k + 9) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
      const rgb = colour(g.rgba), a = g.rgba[3] * alpha;
      if (g.type === SPHERE || g.type === ELLIPSOID) {
        const p = project(pos);
        const radius = g.type === SPHERE ? g.size[0] : (g.size[0] + g.size[1] + g.size[2]) / 3;
        if (p) items.push({ z: p.z, layer: 1, sprite: { x: p.x, y: p.y, r: focal * radius / p.z }, rgb, alpha: a });
      } else if (g.type === BOX) {
        this.boxFaces(items, g, pos, R, project, cam, rgb, a);
      } else if (g.type === CYLINDER || g.type === CAPSULE) {
        this.cylinderFaces(items, g, pos, R, project, cam, focal, rgb, a);
      }
    });
    flexes.forEach((f) => {
      if (f.dim !== 2 || !pose.f) return;
      const vertex = (v) => { const o = 3 * (f.vertadr + v); return [pose.f[o], pose.f[o + 1], pose.f[o + 2]]; };
      const rgb = colour(f.rgba);
      for (const tri of f.tri) {
        const p3 = tri.map(vertex), p2 = p3.map(project);
        if (p2.some((q) => !q)) continue;
        let n = norm(cross(sub(p3[1], p3[0]), sub(p3[2], p3[0])));
        if (dot(n, sub(cam.eye, p3[0])) < 0) n = [-n[0], -n[1], -n[2]];
        items.push({ z: (p2[0].z + p2[1].z + p2[2].z) / 3, layer: 1, poly: p2, rgb, alpha: Math.max(0.85, f.rgba[3]) * alpha,
                     light: 0.45 + 0.55 * Math.max(0, dot(n, LIGHT)), edge: true });
      }
    });
  }

  boxFaces(items, g, pos, R, project, cam, rgb, alpha) {
    const half = g.size, glass = g.rgba[3] < 0.6;
    const world = (s) => {
      const l = [s[0] * half[0], s[1] * half[1], s[2] * half[2]];
      return [pos[0] + R[0] * l[0] + R[1] * l[1] + R[2] * l[2], pos[1] + R[3] * l[0] + R[4] * l[1] + R[5] * l[2],
              pos[2] + R[6] * l[0] + R[7] * l[1] + R[8] * l[2]];
    };
    for (const [axis, sign, corners] of BOX_FACES) {
      const n = norm([R[axis] * sign, R[3 + axis] * sign, R[6 + axis] * sign]);
      const p3 = corners.map(world), p2 = p3.map(project);
      if (p2.some((q) => !q)) continue;
      const centre = [(p3[0][0] + p3[2][0]) / 2, (p3[0][1] + p3[2][1]) / 2, (p3[0][2] + p3[2][2]) / 2];
      const facing = dot(n, sub(cam.eye, centre)) > 0;
      if (!glass && !facing) continue;                       // an opaque box hides its far faces
      items.push({ z: (p2[0].z + p2[2].z) / 2, layer: glass ? (facing ? 2 : 0) : 1, poly: p2, rgb, alpha,
                   light: 0.5 + 0.5 * Math.max(0, dot(n, LIGHT)), edge: true });
    }
  }

  cylinderFaces(items, g, pos, R, project, cam, focal, rgb, alpha) {
    const [radius, half] = g.size, axis = [R[2], R[5], R[8]];
    const ex = [R[0], R[3], R[6]], ey = [R[1], R[4], R[7]];
    const at = (a, side) => {
      const c = Math.cos(a) * radius, s = Math.sin(a) * radius;
      return [0, 1, 2].map((k) => pos[k] + ex[k] * c + ey[k] * s + axis[k] * half * side);
    };
    for (let i = 0; i < SIDES; i++) {
      const a0 = (i / SIDES) * 2 * Math.PI, a1 = ((i + 1) / SIDES) * 2 * Math.PI, am = (a0 + a1) / 2;
      const p3 = [at(a0, -1), at(a1, -1), at(a1, 1), at(a0, 1)], p2 = p3.map(project);
      if (p2.some((q) => !q)) continue;
      const n = norm([0, 1, 2].map((k) => ex[k] * Math.cos(am) + ey[k] * Math.sin(am)));
      items.push({ z: (p2[0].z + p2[2].z) / 2, layer: 1, poly: p2, rgb, alpha, light: 0.5 + 0.5 * Math.abs(dot(n, LIGHT)) });
    }
    for (const side of [-1, 1]) {
      const p3 = Array.from({ length: SIDES }, (_, i) => at((i / SIDES) * 2 * Math.PI, side)), p2 = p3.map(project);
      if (p2.some((q) => !q)) continue;
      const n = side > 0 ? axis : axis.map((v) => -v);
      if (dot(n, sub(cam.eye, pos)) <= 0) continue;
      items.push({ z: p2.reduce((sum, q) => sum + q.z, 0) / SIDES, layer: 1, poly: p2, rgb, alpha, light: 0.5 + 0.5 * Math.max(0, dot(n, LIGHT)) });
    }
    if (g.type === CAPSULE) {
      for (const side of [-1, 1]) {
        const c = [0, 1, 2].map((k) => pos[k] + axis[k] * half * side), p = project(c);
        if (p) items.push({ z: p.z, layer: 1, sprite: { x: p.x, y: p.y, r: focal * radius / p.z }, rgb, alpha });
      }
    }
  }

  // a shaded ball, drawn once per colour and stamped at every size: much cheaper than a gradient per sphere
  ball(rgb) {
    const key = rgb.map((v) => Math.round(v * 255)).join(",");
    let sprite = this.sprites.get(key);
    if (!sprite) {
      sprite = document.createElement("canvas");
      sprite.width = sprite.height = 64;
      const g = sprite.getContext("2d");
      const shade = (k) => `rgb(${rgb.map((v) => Math.round(255 * Math.min(1, v * k))).join(",")})`;
      const gradient = g.createRadialGradient(23, 21, 3, 32, 32, 31);
      gradient.addColorStop(0, shade(1.35));
      gradient.addColorStop(0.55, shade(1));
      gradient.addColorStop(1, shade(0.62));
      g.fillStyle = gradient;
      g.beginPath();
      g.arc(32, 32, 31, 0, 2 * Math.PI);
      g.fill();
      this.sprites.set(key, sprite);
    }
    return sprite;
  }

  paint(ctx, item) {
    ctx.globalAlpha = item.alpha;
    if (item.sprite) {
      const { x, y, r } = item.sprite, rr = Math.max(0.8, r);
      ctx.drawImage(this.ball(item.rgb), x - rr, y - rr, 2 * rr, 2 * rr);
      ctx.globalAlpha = 1;
      return;
    }
    const shade = (rgb, light) => `rgb(${Math.round(255 * Math.min(1, rgb[0] * light))},${Math.round(255 * Math.min(1, rgb[1] * light))},${Math.round(255 * Math.min(1, rgb[2] * light))})`;
    ctx.fillStyle = shade(item.rgb, item.light);
    ctx.beginPath();
    item.poly.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.closePath();
    ctx.fill();
    if (item.edge) {
      ctx.globalAlpha = Math.min(1, item.alpha * 0.7);
      ctx.lineWidth = 1;
      ctx.strokeStyle = shade(item.rgb, 0.55);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  drawFloor(ctx, project, colours, width, pose) {
    const plane = this.layout.geoms.findIndex((g) => g.type === PLANE);
    if (plane < 0) return;
    const z = pose.x[3 * plane + 2], extent = 0.7, step = 0.1;
    const corners = [[-extent, -extent], [extent, -extent], [extent, extent], [-extent, extent]].map(([x, y]) => project([x, y, z]));
    if (corners.every(Boolean)) {
      ctx.fillStyle = colours.floor;
      ctx.beginPath();
      corners.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
      ctx.fill();
    }
    ctx.lineWidth = Math.max(1, width / 900);
    ctx.strokeStyle = colours.grid;
    ctx.beginPath();
    for (let v = -extent; v <= extent + 1e-9; v += step) {
      for (const [a, b] of [[[-extent, v, z], [extent, v, z]], [[v, -extent, z], [v, extent, z]]]) {
        const p = project(a), q = project(b);
        if (p && q) { ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
      }
    }
    ctx.stroke();
  }
}

// "#rrggbb" or "rgb(...)" to [r, g, b] in 0..1
function hex(text) {
  const m = /^#([0-9a-f]{6})$/i.exec(text.trim());
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const n = text.match(/[\d.]+/g) || [128, 128, 128];
  return n.slice(0, 3).map((v) => Number(v) / 255);
}
